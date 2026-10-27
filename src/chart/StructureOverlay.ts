import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  AutoscaleInfo,
  Logical,
  PrimitiveHoveredItem,
  SeriesAttachedParameter,
  UTCTimestamp,
} from 'lightweight-charts';
import type { RuleStructure } from '../../shared/structureEvidence';
import type { Structure } from '../../shared/analysis';
import type { Candle } from '../../shared/market';
import { distanceToGeometry, mapStructure, type StructureGeometry, type Viewport } from './coordinates';
import { indicatorDisplayEndTime } from './indicatorCoordinates';
import { ChartLabelRegistry, labelDensity, placeLabel, type LabelBox } from './labelLayout';
import { drawZoneLabel } from './zoneLabel';
import { CHART_THEME, withAlpha } from './chartTheme';
import { horizontalStroke, labelSurface } from './drawingStyle';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];
export type ChartStructure = Structure & Partial<Pick<RuleStructure, 'source' | 'importance' | 'timing'>>;
interface DrawItem { structure: ChartStructure; geometry: StructureGeometry }

/** A native chart primitive: LWC invalidates it on every scale/viewport change. */
export class StructureOverlay implements ISeriesPrimitive {
  private attachment: SeriesAttachedParameter | null = null;
  private structures: ChartStructure[] = [];
  private selectedId: string | null = null;
  private priceMultiplier = 1;
  private candles: readonly Candle[] = [];
  private dimmed = false;
  private lastItems: DrawItem[] = [];
  private labels: {id: string; box: LabelBox}[] = [];
  private viewport: Viewport = { width: 0, height: 0 };
  private readonly views: IPrimitivePaneView[] = [
    { zOrder: () => 'bottom', renderer: () => ({ draw: (target) => this.draw(target, true) }) },
    { zOrder: () => 'top', renderer: () => ({ draw: (target) => this.draw(target, false) }) },
  ];

  constructor(private readonly registry = new ChartLabelRegistry()) {}

  attached(parameters: SeriesAttachedParameter): void { this.attachment = parameters; }
  detached(): void { this.attachment = null; this.lastItems = []; this.labels = []; }
  paneViews(): readonly IPrimitivePaneView[] { return this.views; }

  autoscaleInfo(from: Logical, to: Logical): AutoscaleInfo | null {
    if (!this.attachment || !this.selectedId) return null;
    const selected = this.structures.find((item) => item.id === this.selectedId);
    if (!selected) return null;
    const displayEnd = this.displayEndTime(selected);
    if (displayEnd === null) return null;
    const scale = this.attachment.chart.timeScale();
    const start = scale.timeToIndex(selected.startTime as UTCTimestamp);
    const end = scale.timeToIndex(displayEnd as UTCTimestamp);
    if (start === null || end === null || end < from || start > to) return null;
    // Selecting a model-provided level must also reveal its price even when it
    // sits outside the visible candles' automatic price range.
    return { priceRange: { minValue: selected.price * this.priceMultiplier, maxValue: (selected.priceEnd ?? selected.price) * this.priceMultiplier }, margins: { above: 24, below: 24 } };
  }

  setPriceMultiplier(multiplier: number): void {
    this.priceMultiplier = multiplier;
    this.attachment?.requestUpdate();
  }

  setData(structures: ChartStructure[], selectedId: string | null, candles: readonly Candle[] = [], dimmed = false): void {
    this.structures = structures;
    this.selectedId = selectedId;
    this.candles = candles;
    this.dimmed = dimmed;
    this.attachment?.requestUpdate();
  }

  private mappedItems(): DrawItem[] {
    if (!this.attachment) return [];
    const { chart, series } = this.attachment;
    const mapper = {
      timeToX: (timestamp: number) => chart.timeScale().timeToCoordinate(timestamp as UTCTimestamp),
      priceToY: (price: number) => series.priceToCoordinate(price * this.priceMultiplier),
    };
    return this.structures.flatMap((structure) => {
      const displayEnd = this.displayEndTime(structure);
      if (displayEnd === null) return [];
      // Only the rendered span is capped. Keep the model's original lifecycle
      // and evidence intact in DrawItem, analysis panels, exports, and AI input.
      const geometry = mapStructure({ ...structure, endTime: displayEnd }, mapper, this.viewport);
      return geometry ? [{ structure, geometry }] : [];
    }).sort((a, b) => Number(a.structure.id === this.selectedId) - Number(b.structure.id === this.selectedId));
  }

  private displayEndTime(structure: Structure): number | null {
    if (structure.type !== 'FVG' && structure.type !== 'OB') return structure.endTime;
    return indicatorDisplayEndTime({ formedAt: structure.startTime, endTime: structure.endTime }, this.candles);
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    if (x < 0 || y < 0 || x > this.viewport.width || y > this.viewport.height) return null;
    const label = this.labels.find(({ box }) => x >= box.left && x <= box.left + box.width && y >= box.top && y <= box.top + box.height);
    if (label) return { externalId: label.id, zOrder: 'top', cursorStyle: 'pointer', distance: 0 };
    const hits = this.lastItems.map(({ geometry, structure }) => ({
      geometry, structure, distance: distanceToGeometry(geometry, x, y),
    })).filter(({ distance, structure }) => distance <= 9 && (structure.id === this.selectedId || this.density().showLocal || structure.importance !== 'local')).sort((a, b) =>
      Number(b.geometry.kind === 'point') - Number(a.geometry.kind === 'point') || a.distance - b.distance,
    );
    const hit = hits[0];
    return hit ? { externalId: hit.structure.id, zOrder: 'top', cursorStyle: 'pointer', distance: hit.distance } : null;
  }

  private draw(target: Target, background: boolean): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      this.viewport = mediaSize;
      this.lastItems = this.mappedItems();
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, mediaSize.width, mediaSize.height);
      ctx.clip();
      // Lay out text before lines so a break-level line can leave a small gap
      // underneath its centered label without moving the actual price level.
      this.labels = [];
      const occupied = background ? [] : this.registry.begin('structures', 0);
      const inherited = occupied.length;
      const density = this.density();
      const obstacles = !background && this.lastItems.some(item => item.geometry.kind !== 'zone') ? this.candleObstacles() : [];
      const labelItems = [...this.lastItems].sort((a, b) => Number(b.structure.id === this.selectedId) - Number(a.structure.id === this.selectedId)
        || Number(b.structure.importance === 'major') - Number(a.structure.importance === 'major')
        || Number(['BOS', 'CHoCH'].includes(b.structure.type)) - Number(['BOS', 'CHoCH'].includes(a.structure.type))
        || b.geometry.x2 - a.geometry.x2);
      const paintLabels: (() => void)[] = [];
      let count = 0;
      if (!background) for (const { structure, geometry } of labelItems) {
        if (structure.id !== this.selectedId && (count >= density.main || (!density.showLocal && structure.importance === 'local'))) continue;
        const before = occupied.length;
        const paint = this.layoutLabel(ctx, structure, geometry, occupied, obstacles);
        if (paint) paintLabels.push(paint);
        if (occupied.length > before) count++;
      }
      for (const { structure, geometry } of this.lastItems) {
        ctx.save();
        if ((this.selectedId || this.dimmed) && structure.id !== this.selectedId) ctx.globalAlpha = .35;
        else if (structure.importance === 'local') ctx.globalAlpha = .66;
        this.drawItem(ctx, structure, geometry, background);
        ctx.restore();
      }
      if (background) { ctx.restore(); return; }
      for (const paint of paintLabels) paint();
      this.registry.commit('structures', occupied, inherited);
      ctx.restore();
    });
  }

  private density() { return labelDensity(this.attachment?.chart.timeScale().options?.().barSpacing ?? 8, this.viewport.width); }
  private candleObstacles(): LabelBox[] {
    if (!this.attachment) return [];
    const { chart, series } = this.attachment;
    const half = Math.max(1, Math.min(5, (chart.timeScale().options?.().barSpacing ?? 8) * .35));
    return this.candles.flatMap(candle => {
      const x = chart.timeScale().timeToCoordinate(candle.timestamp as UTCTimestamp);
      const top = series.priceToCoordinate(Math.max(candle.open, candle.close) * this.priceMultiplier);
      const bottom = series.priceToCoordinate(Math.min(candle.open, candle.close) * this.priceMultiplier);
      return x === null || top === null || bottom === null || x < 0 || x > this.viewport.width ? [] : [{ left: x - half, top, width: half * 2, height: Math.max(2, bottom - top) }];
    });
  }

  private drawItem(ctx: CanvasRenderingContext2D, structure: ChartStructure, geometry: StructureGeometry, background: boolean): void {
    const selected = structure.id === this.selectedId;
    if (!selected && !this.density().showLocal && structure.importance === 'local') return;
    const candidate = structure.status === 'candidate';
    const color = this.color(structure);
    const { x1, x2, y1, y2 } = geometry;
    ctx.save();
    ctx.lineWidth = selected ? 1.5 : 1;
    ctx.strokeStyle = selected ? CHART_THEME.foreground : color;
    ctx.fillStyle = color;
    ctx.setLineDash(candidate ? [4, 4] : []);
    if (background) {
      if (geometry.kind === 'line' && selected) {
        ctx.fillStyle = withAlpha(color, .06);
        ctx.fillRect(x1, y1 - 2, x2 - x1, 4);
      } else if (geometry.kind === 'zone') {
        ctx.fillStyle = withAlpha(color, selected ? .24 : .14);
        ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
      }
      ctx.restore(); return;
    }
    if (geometry.kind === 'point') {
      // The dot is at the exact price; only its text label is offset for legibility.
      ctx.beginPath();
      ctx.arc(x1, y1, selected ? 3 : 1.6, 0, Math.PI * 2);
      if (candidate) ctx.stroke(); else ctx.fill();
    } else if (geometry.kind === 'line') {
      horizontalStroke(ctx, x1, x2, y1, this.labels.find(label => label.id === structure.id)?.box);
      ctx.setLineDash([]);
      ctx.fillStyle = CHART_THEME.background;
      if (selected) { ctx.beginPath(); ctx.arc(x1, y1, 2.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      const event = this.candles.find((candle) => candle.timestamp === structure.endTime);
      const closeY = event && this.attachment?.series.priceToCoordinate(event.close * this.priceMultiplier);
      const highY = event && this.attachment?.series.priceToCoordinate(event.high * this.priceMultiplier);
      const lowY = event && this.attachment?.series.priceToCoordinate(event.low * this.priceMultiplier);
      if (selected && typeof closeY === 'number' && typeof highY === 'number' && typeof lowY === 'number') {
        ctx.strokeStyle = withAlpha(color, .6); ctx.lineWidth = 1.2;
        ctx.strokeRect(x2 - 4, Math.min(highY, lowY) - 3, 8, Math.max(7, Math.abs(lowY - highY) + 6));
        ctx.beginPath(); ctx.moveTo(x2, y1); ctx.lineTo(x2, closeY); ctx.stroke();
        ctx.strokeStyle = color; ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(x2, closeY, 3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      } else if (selected) {
        ctx.beginPath(); ctx.arc(x2, y1, 2.5, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();
  }

  private color(structure: Structure): string {
    if (structure.type === 'FVG' || structure.type === 'OB') return CHART_THEME.zone[structure.type][structure.direction === 'bearish' ? 'bearish' : 'bullish'];
    return structure.direction === 'bullish' ? CHART_THEME.bullish : structure.direction === 'bearish' ? CHART_THEME.bearish : CHART_THEME.neutral;
  }

  private layoutLabel(ctx: CanvasRenderingContext2D, structure: ChartStructure, geometry: StructureGeometry, occupied: LabelBox[], obstacles: LabelBox[]): (() => void) | null {
    const selected = structure.id === this.selectedId;
    if (geometry.kind === 'zone') {
      const bounds = { left: geometry.x1, top: geometry.y1, right: geometry.x2, bottom: geometry.y2 };
      const box = drawZoneLabel(ctx, structure.type, bounds, this.viewport, occupied, false);
      if (!box) return null;
      this.labels.push({ id: structure.id, box });
      return () => {
        ctx.save(); ctx.fillStyle = selected ? CHART_THEME.foreground : this.color(structure);
        if ((this.selectedId || this.dimmed) && !selected) ctx.globalAlpha = .4;
        drawZoneLabel(ctx, structure.type, bounds, this.viewport);
        ctx.restore();
      };
    }
    const text = structure.type + (structure.status === 'candidate' ? ' ◇' : '');
    const high = structure.type === 'HH' || structure.type === 'LH';
    const { x1, x2, y1 } = geometry;
    const x = geometry.kind === 'point' ? x1 : (x1 + x2) / 2;
    const y = geometry.kind === 'point' ? y1 + (high ? -16 : 16) : y1;
    ctx.save();
    ctx.font = `${selected ? 600 : 500} 11px Arial, "Segoe UI", sans-serif`;
    const width = ctx.measureText(text).width;
    const left = Math.max(4, Math.min(x - width / 2, this.viewport.width - width - 4));
    const labelY = Math.max(9, Math.min(y, this.viewport.height - 9));
    const box = placeLabel({ left: left - 4, top: labelY - 8, width: width + 8, height: 16 }, this.viewport, occupied, selected, obstacles);
    ctx.restore();
    if (!box) return null;
    this.labels.push({id: structure.id, box});
    return () => {
      ctx.save();
      if ((this.selectedId || this.dimmed) && !selected) ctx.globalAlpha = .4;
      else if (structure.importance === 'local') ctx.globalAlpha = .7;
      ctx.font = `${selected ? 600 : 500} 11px Arial, "Segoe UI", sans-serif`;
      if (Math.abs(box.top + 8 - y) > 12) {
        ctx.strokeStyle = withAlpha(this.color(structure), .3); ctx.lineWidth = .75; ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(Math.max(box.left, Math.min(x, box.left + box.width)), box.top + 8); ctx.stroke();
      }
      if (selected) labelSurface(ctx, box, true);
      ctx.fillStyle = selected ? CHART_THEME.foreground : this.color(structure);
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.fillText(text, box.left + 4, box.top + 8);
      ctx.restore();
    };
  }
}
