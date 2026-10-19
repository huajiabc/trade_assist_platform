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
import type { Structure } from '../../shared/analysis';
import type { Candle } from '../../shared/market';
import { distanceToGeometry, mapStructure, type StructureGeometry, type Viewport } from './coordinates';
import { reserveLabel, type LabelBox } from './labelLayout';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];
interface DrawItem { structure: Structure; geometry: StructureGeometry }

/** A native chart primitive: LWC invalidates it on every scale/viewport change. */
export class StructureOverlay implements ISeriesPrimitive {
  private attachment: SeriesAttachedParameter | null = null;
  private structures: Structure[] = [];
  private selectedId: string | null = null;
  private priceMultiplier = 1;
  private candles: readonly Candle[] = [];
  private dimmed = false;
  private lastItems: DrawItem[] = [];
  private viewport: Viewport = { width: 0, height: 0 };
  private readonly views: IPrimitivePaneView[] = [
    { zOrder: () => 'bottom', renderer: () => ({ draw: (target) => this.draw(target, true) }) },
    { zOrder: () => 'top', renderer: () => ({ draw: (target) => this.draw(target, false) }) },
  ];

  attached(parameters: SeriesAttachedParameter): void { this.attachment = parameters; }
  detached(): void { this.attachment = null; this.lastItems = []; }
  paneViews(): readonly IPrimitivePaneView[] { return this.views; }

  autoscaleInfo(from: Logical, to: Logical): AutoscaleInfo | null {
    if (!this.attachment || !this.selectedId) return null;
    const selected = this.structures.find((item) => item.id === this.selectedId);
    if (!selected) return null;
    const scale = this.attachment.chart.timeScale();
    const start = scale.timeToIndex(selected.startTime as UTCTimestamp);
    const end = scale.timeToIndex(selected.endTime as UTCTimestamp);
    if (start === null || end === null || end < from || start > to) return null;
    // Selecting a model-provided level must also reveal its price even when it
    // sits outside the visible candles' automatic price range.
    return { priceRange: { minValue: selected.price * this.priceMultiplier, maxValue: (selected.priceEnd ?? selected.price) * this.priceMultiplier }, margins: { above: 24, below: 24 } };
  }

  setPriceMultiplier(multiplier: number): void {
    this.priceMultiplier = multiplier;
    this.attachment?.requestUpdate();
  }

  setData(structures: Structure[], selectedId: string | null, candles: readonly Candle[] = [], dimmed = false): void {
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
      const geometry = mapStructure(structure, mapper, this.viewport);
      return geometry ? [{ structure, geometry }] : [];
    }).sort((a, b) => Number(a.structure.id === this.selectedId) - Number(b.structure.id === this.selectedId));
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    if (x < 0 || y < 0 || x > this.viewport.width || y > this.viewport.height) return null;
    const hits = this.lastItems.map(({ geometry, structure }) => ({
      geometry, structure, distance: distanceToGeometry(geometry, x, y),
    })).filter(({ distance }) => distance <= 9).sort((a, b) =>
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
      for (const { structure, geometry } of this.lastItems) {
        ctx.save();
        if ((this.selectedId || this.dimmed) && structure.id !== this.selectedId) ctx.globalAlpha = .35;
        this.drawItem(ctx, structure, geometry, background);
        ctx.restore();
      }
      if (background) { ctx.restore(); return; }
      const occupied: LabelBox[] = [];
      const labels = [...this.lastItems].sort((a, b) => Number(b.structure.id === this.selectedId) - Number(a.structure.id === this.selectedId)
        || b.geometry.x2 - a.geometry.x2);
      for (const { structure, geometry } of labels) {
        ctx.save();
        if ((this.selectedId || this.dimmed) && structure.id !== this.selectedId) ctx.globalAlpha = .4;
        this.drawLabel(ctx, structure, geometry, occupied);
        ctx.restore();
      }
      ctx.restore();
    });
  }

  private drawItem(ctx: CanvasRenderingContext2D, structure: Structure, geometry: StructureGeometry, background: boolean): void {
    const selected = structure.id === this.selectedId;
    const candidate = structure.status === 'candidate';
    const color = this.color(structure);
    const { x1, x2, y1, y2 } = geometry;
    ctx.save();
    ctx.lineWidth = selected ? 1.5 : 1;
    ctx.strokeStyle = selected ? '#d1d4dc' : color;
    ctx.fillStyle = color;
    ctx.setLineDash(candidate ? [4, 4] : []);
    if (background) {
      if (geometry.kind === 'line') {
        // Screen-space emphasis around the exact broken level; not a new price zone.
        ctx.fillStyle = this.alpha(color, selected ? .13 : .06);
        ctx.fillRect(x1, y1 - 3, x2 - x1, 6);
      } else if (geometry.kind === 'zone') {
        ctx.fillStyle = this.alpha(color, selected ? .17 : .085);
        ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
      }
      ctx.restore(); return;
    }
    if (geometry.kind === 'point') {
      // The dot is at the exact price; only its text label is offset for legibility.
      const high = structure.type === 'HH' || structure.type === 'LH';
      ctx.beginPath();
      ctx.arc(x1, y1, selected ? 3.5 : 2, 0, Math.PI * 2);
      if (candidate) ctx.stroke(); else ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x1, y1 + (high ? -5 : 5));
      ctx.lineTo(x1, y1 + (high ? -11 : 11));
      ctx.stroke();
    } else if (geometry.kind === 'line') {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y1);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#131722';
      ctx.beginPath(); ctx.arc(x1, y1, selected ? 3 : 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      const event = this.candles.find((candle) => candle.timestamp === structure.endTime);
      const closeY = event && this.attachment?.series.priceToCoordinate(event.close * this.priceMultiplier);
      const highY = event && this.attachment?.series.priceToCoordinate(event.high * this.priceMultiplier);
      const lowY = event && this.attachment?.series.priceToCoordinate(event.low * this.priceMultiplier);
      if (typeof closeY === 'number' && typeof highY === 'number' && typeof lowY === 'number') {
        ctx.strokeStyle = this.alpha(color, .6); ctx.lineWidth = selected ? 1.4 : .8;
        ctx.strokeRect(x2 - 4, Math.min(highY, lowY) - 3, 8, Math.max(7, Math.abs(lowY - highY) + 6));
        ctx.beginPath(); ctx.moveTo(x2, y1); ctx.lineTo(x2, closeY); ctx.stroke();
        ctx.strokeStyle = color; ctx.fillStyle = selected ? color : '#131722';
        ctx.beginPath(); ctx.arc(x2, closeY, selected ? 4 : 3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(x2, y1, 3, 0, Math.PI * 2); ctx.stroke();
      }
    } else {
      ctx.strokeStyle = this.alpha(color, selected ? .95 : .65);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.save(); ctx.setLineDash([2, 5]); ctx.strokeStyle = this.alpha(color, .35);
      ctx.beginPath(); ctx.moveTo(x1, (y1 + y2) / 2); ctx.lineTo(x2, (y1 + y2) / 2); ctx.stroke(); ctx.restore();
      ctx.setLineDash([]); ctx.strokeStyle = color; ctx.lineWidth = selected ? 3 : 2;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1, y2); ctx.stroke();
    }
    ctx.restore();
  }

  private color(structure: Structure): string {
    if (structure.type === 'OB') return '#9575cd';
    return structure.direction === 'bullish' ? '#089981' : structure.direction === 'bearish' ? '#f23645' : '#b2b5be';
  }

  private alpha(hex: string, opacity: number): string { return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${opacity})`; }

  private drawLabel(ctx: CanvasRenderingContext2D, structure: Structure, geometry: StructureGeometry, occupied: LabelBox[]): void {
    const selected = structure.id === this.selectedId;
    if (!selected && occupied.length >= 20) return;
    const name = structure.type === 'BOS' ? 'BOS · 结构延续' : structure.type === 'CHoCH' ? 'CHoCH · 转向观察'
      : structure.type === 'FVG' ? 'FVG · 失衡区' : structure.type === 'OB' ? 'OB · 订单区' : structure.type;
    const text = name + (structure.status === 'candidate' ? ' ◇候选' : '');
    const high = structure.type === 'HH' || structure.type === 'LH';
    const { x1, x2, y1 } = geometry;
    const center = geometry.kind !== 'zone';
    const x = geometry.kind === 'point' ? x1 : geometry.kind === 'line' ? (x1 + x2) / 2 : x2 - 8;
    const y = geometry.kind === 'point' ? y1 + (high ? -20 : 22) : geometry.kind === 'line' ? y1 - 11 : y1 + 12;
    ctx.save();
    ctx.font = `${selected ? 600 : 500} 10px Arial, "Segoe UI", sans-serif`;
    const width = ctx.measureText(text).width;
    const left = Math.max(4, Math.min(center ? x - width / 2 : x - width, this.viewport.width - width - 4));
    const labelY = Math.max(9, Math.min(y, this.viewport.height - 9));
    const box = { left: left - 4, top: labelY - 7, width: width + 8, height: 14 };
    if (!reserveLabel(box, occupied, selected)) { ctx.restore(); return; }
    // Price/time anchors remain untouched. Only overlapping text is suppressed.
    ctx.fillStyle = selected ? '#363a45' : 'rgba(19,23,34,.94)';
    ctx.fillRect(box.left, box.top, box.width, box.height);
    ctx.fillStyle = selected ? '#f0f3fa' : this.color(structure);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(text, left, labelY);
    ctx.restore();
  }
}
