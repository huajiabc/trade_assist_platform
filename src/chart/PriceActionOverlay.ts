import type { AutoscaleInfo, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, Logical, PrimitiveHoveredItem, SeriesAttachedParameter, UTCTimestamp } from 'lightweight-charts';
import type { Candle } from '../../shared/market';
import type { PAZone, PALeg, PAPattern, PABreakout, PriceAction } from '../../shared/priceAction';
import { formatPrice } from '../../shared/format';
import type { Viewport } from './coordinates';
import { ChartLabelRegistry, labelDensity, placeLabel, type LabelBox } from './labelLayout';
import { ALL_PA_LAYERS, distanceToPAGeometry, findPAItem, mapPABreakout, mapPALeg, mapPAPattern, mapPAZone, paItemBounds,
  type PAGeometry, type PAItem, type PALayerVisibility, type PAPoint } from './priceActionCoordinates';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];
interface DrawItem { item: PAItem; geometry: PAGeometry }
const TEAL = '#36c7b4', CORAL = '#ff8a8a', BLUE = '#6ba9ff', GOLD = '#e6b66c';
const shortTitle = (value: string, max = 16) => [...value].length > max ? [...value].slice(0, max).join('') + '…' : value;

/** PA evidence is rendered as native chart geometry, never generated imagery. */
export class PriceActionOverlay implements ISeriesPrimitive {
  private attachment: SeriesAttachedParameter | null = null;
  private candles: readonly Candle[] = [];
  private analysis: PriceAction | undefined;
  private layers = ALL_PA_LAYERS;
  private selectedId: string | null = null;
  private dimmed = false;
  private multiplier = 1;
  private viewport: Viewport = { width: 0, height: 0 };
  private drawn: DrawItem[] = [];
  private labels: { id: string; box: LabelBox }[] = [];
  private badgeHits: { id: string; x: number; y: number }[] = [];
  private readonly views: IPrimitivePaneView[] = [
    { zOrder: () => 'bottom', renderer: () => ({ draw: (target) => this.draw(target, true) }) },
    { zOrder: () => 'top', renderer: () => ({ draw: (target) => this.draw(target, false) }) },
  ];

  constructor(private readonly registry = new ChartLabelRegistry()) {}
  attached(parameters: SeriesAttachedParameter): void { this.attachment = parameters; }
  detached(): void { this.attachment = null; this.drawn = []; this.labels = []; this.badgeHits = []; }
  paneViews(): readonly IPrimitivePaneView[] { return this.views; }
  setPriceMultiplier(multiplier: number): void { this.multiplier = multiplier; this.attachment?.requestUpdate(); }
  setData(candles: readonly Candle[], analysis: PriceAction | undefined, layers: PALayerVisibility, selectedId: string | null, dimmed = false): void {
    this.candles = candles; this.analysis = analysis; this.layers = layers; this.selectedId = selectedId; this.dimmed = dimmed;
    this.attachment?.requestUpdate();
  }

  autoscaleInfo(from: Logical, to: Logical): AutoscaleInfo | null {
    const item = findPAItem(this.analysis, this.selectedId);
    if (!this.attachment || !this.analysis || !item) return null;
    const bounds = paItemBounds(item, this.analysis, this.candles);
    if (!bounds) return null;
    const scale = this.attachment.chart.timeScale();
    const start = scale.timeToIndex(bounds.startTime as UTCTimestamp), end = scale.timeToIndex(bounds.endTime as UTCTimestamp);
    if (start === null || end === null || end < from || start > to) return null;
    return { priceRange: { minValue: Math.min(...bounds.prices) * this.multiplier, maxValue: Math.max(...bounds.prices) * this.multiplier }, margins: { above: 36, below: 36 } };
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    if (x < 0 || y < 0 || x > this.viewport.width || y > this.viewport.height) return null;
    const label = this.labels.find(({ box }) => x >= box.left && x <= box.left + box.width && y >= box.top && y <= box.top + box.height);
    if (label) return { externalId: `pa:${label.id}`, zOrder: 'top', cursorStyle: 'pointer', distance: 0 };
    const badge = this.badgeHits.find((entry) => Math.hypot(x - entry.x, y - entry.y) <= 8);
    if (badge) return { externalId: `pa:${badge.id}`, zOrder: 'top', cursorStyle: 'pointer', distance: 0 };
    const hit = this.drawn.filter(({ item }) => this.selectedId === item.id || labelDensity(this.attachment?.chart.timeScale().options().barSpacing ?? 8, this.viewport.width).showLocal || !('kind' in item && ['pin-bar', 'engulfing', 'inside-bar'].includes(item.kind))).map(({ item, geometry }) => ({ item, distance: geometry.kind === 'pattern'
      ? Math.min(distanceToPAGeometry(geometry, x, y), distanceToPAGeometry({ ...geometry, x1: geometry.x1 - this.barWidth() / 2 - 4, x2: geometry.x2 + this.barWidth() / 2 + 4, top: geometry.top - 5, bottom: geometry.bottom + 5 }, x, y))
      : distanceToPAGeometry(geometry, x, y) }))
      .filter(({ distance }) => distance <= 7)
      .sort((a, b) => Number(b.item.id === this.selectedId) - Number(a.item.id === this.selectedId) || a.distance - b.distance)[0];
    return hit ? { externalId: `pa:${hit.item.id}`, zOrder: 'top', cursorStyle: 'pointer', distance: hit.distance } : null;
  }

  private updateGeometry(): void {
    if (!this.attachment || !this.analysis) { this.drawn = []; return; }
    const { chart, series } = this.attachment;
    const mapper = { timeToX: (timestamp: number) => chart.timeScale().timeToCoordinate(timestamp as UTCTimestamp), priceToY: (price: number) => series.priceToCoordinate(price * this.multiplier) };
    const items: DrawItem[] = [];
    if (this.layers.zones) for (const item of this.analysis.zones) {
      const geometry = mapPAZone(item, this.candles, mapper, this.viewport); if (geometry) items.push({ item, geometry });
    }
    if (this.layers.legs) for (const item of this.analysis.legs) {
      const geometry = mapPALeg(item, this.candles, mapper, this.viewport); if (geometry) items.push({ item, geometry });
    }
    if (this.layers.patterns) for (const item of this.analysis.patterns) {
      const geometry = mapPAPattern(item, this.candles, mapper, this.viewport); if (geometry) items.push({ item, geometry });
    }
    if (this.layers.breakouts) for (const item of this.analysis.breakouts) {
      const geometry = mapPABreakout(item, this.analysis.zones.find((zone) => zone.id === item.zoneId), this.candles, mapper, this.viewport); if (geometry) items.push({ item, geometry });
    }
    this.drawn = items.sort((a, b) => Number(a.item.id === this.selectedId) - Number(b.item.id === this.selectedId));
  }

  private draw(target: Target, background: boolean): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      this.viewport = mediaSize; this.updateGeometry();
      if (!background) this.badgeHits = [];
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, mediaSize.width, mediaSize.height); ctx.clip();
      for (const entry of this.drawn) {
        const selected = entry.item.id === this.selectedId;
        ctx.save(); ctx.globalAlpha = (this.selectedId || this.dimmed) && !selected ? .3 : 1;
        const density = labelDensity(this.attachment?.chart.timeScale().options().barSpacing ?? 8, mediaSize.width);
        if (selected || density.showLocal || !('breakoutTime' in entry.item) && !('kind' in entry.item && ['pin-bar', 'engulfing', 'inside-bar'].includes(entry.item.kind))) this.drawItem(ctx, entry, background, selected); ctx.restore();
      }
      if (!background) {
        this.labels = [];
        const occupied = this.registry.begin('pa', 2);
        const inherited = occupied.length;
        const density = labelDensity(this.attachment?.chart.timeScale().options().barSpacing ?? 8, mediaSize.width);
        const ordered = [...this.drawn].sort((a, b) => Number(b.item.id === this.selectedId) - Number(a.item.id === this.selectedId)
          || this.endTime(b.item) - this.endTime(a.item));
        for (const entry of ordered) {
          if (entry.item.id !== this.selectedId && (occupied.length - inherited >= density.auxiliary + density.main / 2 || (!density.showLocal && !('lowerPrice' in entry.item) && !('startPrice' in entry.item)))) continue;
          ctx.save(); ctx.globalAlpha = (this.selectedId || this.dimmed) && entry.item.id !== this.selectedId ? .45 : 1;
          this.drawLabel(ctx, entry, occupied); ctx.restore();
        }
        this.registry.commit('pa', occupied, inherited);
      }
      ctx.restore();
    });
  }

  private endTime(item: PAItem): number { return 'breakoutTime' in item ? item.confirmationTime ?? item.retestTime ?? item.breakoutTime : item.endTime; }
  private color(item: PAItem): string {
    if ('lowerPrice' in item) return item.kind === 'support' ? TEAL : item.kind === 'resistance' ? GOLD : BLUE;
    return item.direction === 'bullish' ? TEAL : item.direction === 'bearish' ? CORAL : BLUE;
  }
  private barWidth(): number { return Math.max(3, Math.min(14, (this.attachment?.chart.timeScale().options().barSpacing ?? 8) * .7)); }

  private drawItem(ctx: CanvasRenderingContext2D, { item, geometry }: DrawItem, background: boolean, selected: boolean): void {
    const color = this.color(item);
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = selected ? 1.7 : 1;
    ctx.setLineDash(item.status === 'candidate' ? [4, 4] : []);
    if (geometry.kind === 'zone') {
      const zone = item as PAZone;
      const { x1, x2, top, bottom } = geometry;
      if (background) {
        const gradient = ctx.createLinearGradient(0, top, 0, Math.max(top + 1, bottom));
        gradient.addColorStop(0, this.alpha(color, selected ? .19 : .1));
        gradient.addColorStop(.5, this.alpha(color, selected ? .07 : .025));
        gradient.addColorStop(1, this.alpha(color, selected ? .19 : .1));
        ctx.fillStyle = gradient; ctx.fillRect(x1, top, x2 - x1, bottom - top);
      } else {
        ctx.strokeRect(x1, top, x2 - x1, bottom - top);
        if (zone.kind === 'trading-range') {
          ctx.save(); ctx.globalAlpha *= .35; ctx.setLineDash([2, 5]);
          ctx.beginPath(); ctx.moveTo(x1, (top + bottom) / 2); ctx.lineTo(x2, (top + bottom) / 2); ctx.stroke(); ctx.restore();
          // Small boundary brackets distinguish a range from a single level.
          for (const x of [x1, x2]) {
            ctx.beginPath(); ctx.moveTo(x + (x === x1 ? 8 : -8), top); ctx.lineTo(x, top); ctx.lineTo(x, Math.min(top + 8, bottom));
            ctx.moveTo(x, Math.max(top, bottom - 8)); ctx.lineTo(x, bottom); ctx.lineTo(x + (x === x1 ? 8 : -8), bottom); ctx.stroke();
          }
        }
        ctx.setLineDash([]);
        for (const p of geometry.touches) {
          ctx.fillStyle = '#131722'; ctx.beginPath(); ctx.arc(p.x, p.y, selected ? 4 : 3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p.x, p.y, 1, 0, Math.PI * 2); ctx.fill();
        }
      }
    } else if (geometry.kind === 'leg') {
      const leg = item as PALeg;
      const { start, end } = geometry;
      const angle = Math.atan2(end.y - start.y, end.x - start.x), width = selected ? 7 : 5;
      if (background) {
        const nx = Math.sin(angle) * width, ny = -Math.cos(angle) * width;
        ctx.fillStyle = this.alpha(color, leg.kind === 'impulse' ? .15 : .075);
        ctx.beginPath(); ctx.moveTo(start.x + nx, start.y + ny); ctx.lineTo(end.x + nx, end.y + ny);
        ctx.lineTo(end.x - nx, end.y - ny); ctx.lineTo(start.x - nx, start.y - ny); ctx.closePath(); ctx.fill();
      } else {
        if (leg.kind === 'pullback' || item.status === 'candidate') ctx.setLineDash([5, 4]);
        ctx.lineWidth = selected ? 2 : 1.3; ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y); ctx.stroke();
        ctx.setLineDash([]); this.arrow(ctx, start, end, selected ? 9 : 7);
        for (const p of [start, end]) { ctx.fillStyle = item.status === 'confirmed' ? color : '#131722'; ctx.beginPath(); ctx.arc(p.x, p.y, selected ? 3.5 : 2.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      }
    } else if (geometry.kind === 'pattern') {
      const width = this.barWidth(), left = geometry.x1 - width / 2 - 4, right = geometry.x2 + width / 2 + 4;
      if (background) {
        ctx.fillStyle = this.alpha(color, selected ? .2 : .1);
        ctx.fillRect(left, geometry.top - 5, right - left, Math.max(8, geometry.bottom - geometry.top + 10));
      } else {
        ctx.strokeStyle = this.alpha(color, selected ? .9 : .65);
        ctx.strokeRect(left, geometry.top - 5, right - left, Math.max(8, geometry.bottom - geometry.top + 10));
        for (const candle of geometry.candles) {
          // Outline each real body; original candle fill and wick remain visible.
          ctx.setLineDash([]); ctx.strokeStyle = this.alpha(color, selected ? 1 : .75);
          ctx.strokeRect(candle.x - width / 2 - 1, Math.min(candle.openY, candle.closeY) - 1, width + 2, Math.max(2, Math.abs(candle.openY - candle.closeY) + 2));
        }
      }
    } else if (!background) {
      const breakout = item as PABreakout;
      const { points } = geometry;
      ctx.lineWidth = selected ? 2 : 1.4;
      ctx.beginPath(); points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)); ctx.stroke();
      ctx.setLineDash([]);
      if (points.length > 1) this.arrow(ctx, points[points.length - 2], points[points.length - 1], 7);
      for (const p of points) {
        // Number badges are offset; the small center point stays on the real OHLC.
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p.x, p.y, selected ? 3.5 : 2.5, 0, Math.PI * 2); ctx.fill();
        const offset = breakout.direction === 'bullish' ? -18 : 18;
        const badgeY = p.y + offset + (p.stage === 3 && points.some((q) => q.stage === 2 && q.time === p.time) ? offset : 0);
        ctx.strokeStyle = this.alpha(color, .55); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, badgeY); ctx.stroke();
        ctx.fillStyle = '#1e2636'; ctx.strokeStyle = color; ctx.beginPath(); ctx.arc(p.x, badgeY, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = color; ctx.font = '600 9px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(p.stage), p.x, badgeY + .5);
        this.badgeHits.push({ id: item.id, x: p.x, y: badgeY });
      }
    }
  }

  private drawLabel(ctx: CanvasRenderingContext2D, { item, geometry }: DrawItem, occupied: LabelBox[]): void {
    const selected = item.id === this.selectedId, color = this.color(item);
    let text: string, x: number, y: number, anchor: { x: number; y: number };
    if (geometry.kind === 'zone') {
      const zone = item as PAZone;
      const name = zone.kind === 'support' ? '支撑带' : zone.kind === 'resistance' ? '阻力带' : '震荡箱体';
      const amplitude = (zone.upperPrice - zone.lowerPrice) / zone.lowerPrice * 100;
      text = `${name} · ${zone.kind === 'trading-range' ? `${amplitude.toFixed(2)}%` : `${zone.touchTimes.length}次触及`}`;
      if (selected) text += ` · ${formatPrice(zone.lowerPrice)}–${formatPrice(zone.upperPrice)}`;
      x = Math.max(geometry.x1 + 7, 7); y = geometry.top - 12;
      anchor = { x: Math.max(0, geometry.x1), y: geometry.top };
    } else if (geometry.kind === 'leg') {
      const leg = item as PALeg;
      const change = (leg.endPrice - leg.startPrice) / leg.startPrice * 100;
      text = `${leg.kind === 'impulse' ? '推进' : '回撤'} ${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
      x = (geometry.start.x + geometry.end.x) / 2 + 6; y = (geometry.start.y + geometry.end.y) / 2 - 13;
      anchor = { x: (geometry.start.x + geometry.end.x) / 2, y: (geometry.start.y + geometry.end.y) / 2 };
    } else if (geometry.kind === 'pattern') {
      const pattern = item as PAPattern;
      text = pattern.kind === 'pin-bar' ? 'Pin bar · 拒绝' : pattern.kind === 'engulfing' ? '吞没形态' : '内包形态';
      x = geometry.x2 + 9; y = geometry.top - 15;
      anchor = { x: geometry.x2, y: geometry.top };
    } else {
      const breakout = item as PABreakout;
      const last = geometry.points.at(-1)!;
      text = breakout.confirmationTime !== null ? '突破 → 回踩 → 守住' : breakout.retestTime !== null ? '突破 → 回踩待确认' : '突破 · 等待回踩';
      x = last.x + 10; y = last.y + (breakout.direction === 'bullish' ? -40 : 40);
      anchor = last;
    }
    text += item.status === 'candidate' ? ' ◇候选' : '';
    if (selected) text = shortTitle(item.title, 14) + ' · ' + text;
    this.tag(ctx, text, x, y, color, item.id, occupied, selected, anchor);
  }

  private tag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, id: string, occupied: LabelBox[], essential: boolean, anchor: { x: number; y: number }): void {
    ctx.save(); ctx.font = `${essential ? 600 : 500} 10px Arial, "Segoe UI", sans-serif`;
    const width = Math.min(this.viewport.width - 8, ctx.measureText(text).width + 14);
    const left = Math.max(4, Math.min(x, this.viewport.width - width - 4));
    const top = Math.max(3, Math.min(y - 9, this.viewport.height - 23));
    const box = placeLabel({ left, top, width, height: 20 }, this.viewport, occupied, essential);
    if (box) {
      const closestX = Math.max(box.left, Math.min(anchor.x, box.left + box.width));
      const closestY = Math.max(box.top, Math.min(anchor.y, box.top + box.height));
      ctx.strokeStyle = this.alpha(color, .5); ctx.lineWidth = .8; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(anchor.x, anchor.y); ctx.lineTo(closestX, closestY); ctx.stroke();
      ctx.fillStyle = essential ? '#263043' : 'rgba(19,23,34,.96)'; ctx.fillRect(box.left, box.top, box.width, box.height);
      ctx.strokeStyle = this.alpha(color, essential ? .9 : .4); ctx.strokeRect(box.left, box.top, box.width, box.height);
      ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(text, box.left + 7, box.top + 10, box.width - 14);
      this.labels.push({ id, box });
    }
    ctx.restore();
  }

  private arrow(ctx: CanvasRenderingContext2D, start: Pick<PAPoint, 'x' | 'y'>, end: Pick<PAPoint, 'x' | 'y'>, size: number): void {
    if (start.x === end.x && start.y === end.y) return;
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    ctx.beginPath(); ctx.moveTo(end.x - Math.cos(angle - .45) * size, end.y - Math.sin(angle - .45) * size);
    ctx.lineTo(end.x, end.y); ctx.lineTo(end.x - Math.cos(angle + .45) * size, end.y - Math.sin(angle + .45) * size); ctx.stroke();
  }
  private alpha(hex: string, opacity: number): string { return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${opacity})`; }
}
