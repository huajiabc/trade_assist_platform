import type { AutoscaleInfo, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, Logical, PrimitiveHoveredItem, SeriesAttachedParameter, UTCTimestamp } from 'lightweight-charts';
import type { RuleIndicatorZone } from '../../shared/indicators';
import type { Candle } from '../../shared/market';
import type { Viewport } from './coordinates';
import { distanceToIndicatorGeometry, indicatorDisplayEndTime, mapIndicatorZone, type IndicatorGeometry } from './indicatorCoordinates';
import { ChartLabelRegistry, type LabelBox } from './labelLayout';
import { drawZoneLabel } from './zoneLabel';
import { CHART_THEME, withAlpha } from './chartTheme';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];
interface DrawItem { zone: RuleIndicatorZone; geometry: IndicatorGeometry }

const colors = CHART_THEME.zone;
const retired = (zone: RuleIndicatorZone) => zone.status === 'filled' || zone.status === 'invalidated';

/** Deterministic FVG/OB evidence, separate from the model's interpretation. */
export class IndicatorOverlay implements ISeriesPrimitive {
  private attachment: SeriesAttachedParameter | null = null;
  private zones: readonly RuleIndicatorZone[] = [];
  private candles: readonly Candle[] = [];
  private selectedId: string | null = null;
  private multiplier = 1;
  private viewport: Viewport = { width: 0, height: 0 };
  private drawn: DrawItem[] = [];
  private labels: { id: string; box: LabelBox }[] = [];
  private readonly views: IPrimitivePaneView[] = [
    { zOrder: () => 'bottom', renderer: () => ({ draw: target => this.draw(target, true) }) },
    { zOrder: () => 'top', renderer: () => ({ draw: target => this.draw(target, false) }) },
  ];

  constructor(private readonly registry = new ChartLabelRegistry()) {}
  private occupied: LabelBox[] = [];
  attached(parameters: SeriesAttachedParameter): void { this.attachment = parameters; }
  detached(): void { this.attachment = null; this.drawn = []; this.labels = []; }
  paneViews(): readonly IPrimitivePaneView[] { return this.views; }
  setPriceMultiplier(multiplier: number): void { this.multiplier = multiplier; this.attachment?.requestUpdate(); }
  setData(zones: readonly RuleIndicatorZone[], selectedId: string | null, candles: readonly Candle[]): void {
    this.zones = zones; this.selectedId = selectedId; this.candles = candles; this.attachment?.requestUpdate();
  }

  autoscaleInfo(from: Logical, to: Logical): AutoscaleInfo | null {
    const zone = this.zones.find(item => item.id === this.selectedId);
    if (!this.attachment || !zone) return null;
    const displayEnd = indicatorDisplayEndTime(zone, this.candles);
    if (displayEnd === null) return null;
    const scale = this.attachment.chart.timeScale();
    const start = scale.timeToIndex(zone.originTime as UTCTimestamp), end = scale.timeToIndex(displayEnd as UTCTimestamp);
    if (start === null || end === null || end < from || start > to) return null;
    return { priceRange: { minValue: zone.lowerPrice * this.multiplier, maxValue: zone.upperPrice * this.multiplier }, margins: { above: 30, below: 24 } };
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    if (x < 0 || y < 0 || x > this.viewport.width || y > this.viewport.height) return null;
    const label = this.labels.find(({ box }) => x >= box.left && x <= box.left + box.width && y >= box.top && y <= box.top + box.height);
    if (label) return { externalId: `indicator:${label.id}`, zOrder: 'top', cursorStyle: 'pointer', distance: 0 };
    const hit = this.drawn.map(entry => ({ id: entry.zone.id, distance: distanceToIndicatorGeometry(entry.geometry, x, y) }))
      .filter(entry => entry.distance <= 4).sort((a, b) => a.distance - b.distance || Number(b.id === this.selectedId) - Number(a.id === this.selectedId))[0];
    return hit ? { externalId: `indicator:${hit.id}`, zOrder: 'top', cursorStyle: 'pointer', distance: hit.distance } : null;
  }

  private updateGeometry(): void {
    const attachment = this.attachment;
    if (!attachment) { this.drawn = []; return; }
    const mapper = {
      timeToX: (time: number) => attachment.chart.timeScale().timeToCoordinate(time as UTCTimestamp),
      priceToY: (price: number) => attachment.series.priceToCoordinate(price * this.multiplier),
    };
    this.drawn = this.zones.flatMap(zone => {
      const displayEnd = indicatorDisplayEndTime(zone, this.candles);
      const geometry = displayEnd === null ? null : mapIndicatorZone({ ...zone, endTime: displayEnd }, mapper, this.viewport);
      return geometry ? [{ zone, geometry }] : [];
    }).sort((a, b) => Number(a.zone.id === this.selectedId) - Number(b.zone.id === this.selectedId));
  }

  private draw(target: Target, background: boolean): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      this.viewport = mediaSize; this.updateGeometry();
      ctx.save();
      try {
        ctx.beginPath(); ctx.rect(0, 0, mediaSize.width, mediaSize.height); ctx.clip();
        for (const entry of this.drawn) this.drawZone(ctx, entry, background);
        if (background) return;
        this.labels = [];
        this.occupied = this.registry.begin('indicators', 3);
        const inherited = this.occupied.length;
        for (const entry of [...this.drawn].sort((a, b) => Number(b.zone.id === this.selectedId) - Number(a.zone.id === this.selectedId))) this.drawLabel(ctx, entry);
        this.registry.commit('indicators', this.occupied, inherited);
      } finally { ctx.restore(); }
    });
  }

  private drawZone(ctx: CanvasRenderingContext2D, { zone, geometry: g }: DrawItem, background: boolean): void {
    const selected = zone.id === this.selectedId;
    const color = retired(zone) && !selected ? CHART_THEME.retired : colors[zone.type][zone.direction];
    const subdued = (retired(zone) && !selected) || Boolean(this.selectedId && !selected);
    ctx.save();
    try {
      ctx.globalAlpha = subdued ? .46 : 1;
      if (background) {
        // Formation is a causal boundary. Origin history is deliberately unfilled.
        ctx.fillStyle = withAlpha(color, retired(zone) && !selected ? .05 : selected ? .24 : .14);
        const bounds = this.paintBounds(g);
        ctx.fillRect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top);
      }
    } finally { ctx.restore(); }
  }

  private paintBounds(g: IndicatorGeometry) {
    // A newly closed formation still occupies its own candle cell, even when
    // there is no later closed candle. This adds no future time or extra bars.
    const halfBar = g.formedX === g.endX ? (this.attachment?.chart.timeScale().options().barSpacing ?? 8) / 2 : 0;
    return { left: g.formedX - halfBar, top: g.top, right: g.endX + halfBar, bottom: g.bottom };
  }

  private drawLabel(ctx: CanvasRenderingContext2D, { zone, geometry: g }: DrawItem): void {
    const selected = zone.id === this.selectedId;
    const color = retired(zone) && !selected ? '#a0a9ba' : colors[zone.type][zone.direction];
    ctx.save();
    try {
      ctx.globalAlpha = retired(zone) && !selected ? .65 : 1;
      ctx.fillStyle = color;
      const box = drawZoneLabel(ctx, zone.type, this.paintBounds(g), this.viewport, this.occupied);
      if (box) this.labels.push({ id: zone.id, box });
    } finally { ctx.restore(); }
  }
}
