import type {
  AutoscaleInfo, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, Logical,
  PrimitiveHoveredItem, SeriesAttachedParameter, UTCTimestamp,
} from 'lightweight-charts';
import type { LiquiditySweep, TradeSetup } from '../../shared/analysis';
import { formatPrice } from '../../shared/format';
import type { Viewport } from './coordinates';
import { reserveLabel, type LabelBox } from './labelLayout';
import {
  distanceToSweepGeometry, distanceToTradeGeometry, mapLiquiditySweep, mapTradeSetup, SETUP_PROJECTION_BARS,
  type SweepGeometry, type TradeGeometry,
} from './tradeCoordinates';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];
type DrawSetup = { setup: TradeSetup; geometry: TradeGeometry };
type DrawSweep = { sweep: LiquiditySweep; geometry: SweepGeometry };

/** Precise chart primitives, with risk areas behind candles and anchors above. */
export class TradeOverlay implements ISeriesPrimitive {
  private attachment: SeriesAttachedParameter | null = null;
  private setup: TradeSetup | null = null;
  private sweeps: LiquiditySweep[] = [];
  private selectedSweepId: string | null = null;
  private dimmed = false;
  private priceMultiplier = 1;
  private viewport: Viewport = { width: 0, height: 0 };
  private drawnSetup: DrawSetup | null = null;
  private drawnSweeps: DrawSweep[] = [];
  private labelHits: { id: string; box: LabelBox }[] = [];
  private readonly views: IPrimitivePaneView[] = [
    { zOrder: () => 'bottom', renderer: () => ({ draw: (target) => this.draw(target, true) }) },
    { zOrder: () => 'top', renderer: () => ({ draw: (target) => this.draw(target, false) }) },
  ];

  attached(parameters: SeriesAttachedParameter): void { this.attachment = parameters; }
  detached(): void { this.attachment = null; this.drawnSetup = null; this.drawnSweeps = []; this.labelHits = []; }
  paneViews(): readonly IPrimitivePaneView[] { return this.views; }

  setPriceMultiplier(multiplier: number): void {
    this.priceMultiplier = multiplier;
    this.attachment?.requestUpdate();
  }

  setData(setup: TradeSetup | null, sweeps: LiquiditySweep[], selectedSweepId: string | null, dimmed = false): void {
    this.setup = setup;
    this.sweeps = sweeps;
    this.selectedSweepId = selectedSweepId;
    this.dimmed = dimmed;
    this.attachment?.requestUpdate();
  }

  autoscaleInfo(from: Logical, to: Logical): AutoscaleInfo | null {
    if (!this.attachment) return null;
    const scale = this.attachment.chart.timeScale();
    const prices: number[] = [];
    if (this.setup) {
      const anchor = scale.timeToIndex(this.setup.anchorTime as UTCTimestamp);
      if (anchor !== null && anchor <= to && anchor + SETUP_PROJECTION_BARS >= from) {
        prices.push(this.setup.entry, this.setup.stopLoss, ...this.setup.targets.map((target) => target.price));
      }
    }
    const selectedSweep = this.sweeps.find((sweep) => sweep.id === this.selectedSweepId);
    if (selectedSweep) {
      const start = scale.timeToIndex(selectedSweep.levelTime as UTCTimestamp);
      const end = scale.timeToIndex(selectedSweep.sweepTime as UTCTimestamp);
      if (start !== null && end !== null && start <= to && end >= from) prices.push(selectedSweep.levelPrice, selectedSweep.extremePrice);
    }
    if (!prices.length) return null;
    return {
      priceRange: { minValue: Math.min(...prices) * this.priceMultiplier, maxValue: Math.max(...prices) * this.priceMultiplier },
      margins: { above: 32, below: 32 },
    };
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    if (x < 0 || y < 0 || x > this.viewport.width || y > this.viewport.height) return null;
    const label = this.labelHits.find(({ box }) => x >= box.left && x <= box.left + box.width && y >= box.top && y <= box.top + box.height);
    if (label) return { externalId: label.id, zOrder: 'top', cursorStyle: 'pointer', distance: 0 };
    const hits = this.drawnSweeps.map(({ sweep, geometry }) => ({
      id: `sweep:${sweep.id}`, distance: distanceToSweepGeometry(geometry, x, y),
    }));
    if (this.drawnSetup) hits.push({ id: `setup:${this.drawnSetup.setup.id}`, distance: distanceToTradeGeometry(this.drawnSetup.geometry, x, y) });
    const hit = hits.filter((item) => item.distance <= 7).sort((a, b) => a.distance - b.distance)[0];
    return hit ? { externalId: hit.id, zOrder: 'top', cursorStyle: 'pointer', distance: hit.distance } : null;
  }

  private updateGeometry(): void {
    if (!this.attachment) return;
    const { chart, series } = this.attachment;
    const mapper = {
      timeToX: (timestamp: number) => chart.timeScale().timeToCoordinate(timestamp as UTCTimestamp),
      timeToLogical: (timestamp: number) => chart.timeScale().timeToIndex(timestamp as UTCTimestamp),
      logicalToX: (logical: number) => chart.timeScale().logicalToCoordinate(logical as Logical),
      priceToY: (price: number) => series.priceToCoordinate(price * this.priceMultiplier),
    };
    const setupGeometry = this.setup ? mapTradeSetup(this.setup, mapper, this.viewport) : null;
    this.drawnSetup = this.setup && setupGeometry ? { setup: this.setup, geometry: setupGeometry } : null;
    this.drawnSweeps = this.sweeps.flatMap((sweep) => {
      const geometry = mapLiquiditySweep(sweep, mapper, this.viewport);
      return geometry ? [{ sweep, geometry }] : [];
    }).sort((a, b) => Number(a.sweep.id === this.selectedSweepId) - Number(b.sweep.id === this.selectedSweepId));
  }

  private draw(target: Target, background: boolean): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      this.viewport = mediaSize;
      this.updateGeometry();
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, mediaSize.width, mediaSize.height); ctx.clip();
      if (background) {
        if (this.drawnSetup) {
          ctx.save(); if (this.dimmed || this.selectedSweepId) ctx.globalAlpha = .3;
          this.drawRiskAreas(ctx, this.drawnSetup.geometry); ctx.restore();
        }
      } else {
        this.labelHits = [];
        const labels: LabelBox[] = [];
        if (this.drawnSetup) {
          ctx.save(); if (this.dimmed || this.selectedSweepId) ctx.globalAlpha = .5;
          this.drawSetup(ctx, this.drawnSetup, labels); ctx.restore();
        }
        for (const item of this.drawnSweeps) this.drawSweep(ctx, item);
        for (const item of [...this.drawnSweeps].reverse()) {
          if (labels.length < 12 || item.sweep.id === this.selectedSweepId) {
            ctx.save(); if (this.dimmed || (this.selectedSweepId && item.sweep.id !== this.selectedSweepId)) ctx.globalAlpha = .45;
            this.drawSweepLabel(ctx, item, labels); ctx.restore();
          }
        }
      }
      ctx.restore();
    });
  }

  private drawRiskAreas(ctx: CanvasRenderingContext2D, geometry: TradeGeometry): void {
    const width = geometry.endX - geometry.anchorX;
    ctx.fillStyle = 'rgba(242,54,69,.15)';
    ctx.fillRect(geometry.anchorX, Math.min(geometry.entryY, geometry.stopY), width, Math.abs(geometry.stopY - geometry.entryY));
    const target = geometry.targets[0];
    ctx.fillStyle = 'rgba(8,153,129,.16)';
    ctx.fillRect(geometry.anchorX, Math.min(geometry.entryY, target.y), width, Math.abs(target.y - geometry.entryY));
  }

  private drawSetup(ctx: CanvasRenderingContext2D, { setup, geometry }: DrawSetup, occupied: LabelBox[]): void {
    const { anchorX: x1, endX: x2, entryY, stopY, targets } = geometry;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    const drawLevel = (y: number, color: string) => {
      ctx.strokeStyle = color;
      ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
    };
    drawLevel(stopY, '#f23645');
    targets.forEach((target) => drawLevel(target.y, '#2bc5a8'));
    drawLevel(entryY, '#d1d4dc');
    ctx.save();
    ctx.strokeStyle = '#758696';
    ctx.globalAlpha *= 0.6;
    ctx.beginPath(); ctx.moveTo(x1, Math.min(stopY, targets[0].y)); ctx.lineTo(x1, Math.max(stopY, targets[0].y));
    ctx.moveTo(x2, Math.min(stopY, targets[0].y)); ctx.lineTo(x2, Math.max(stopY, targets[0].y)); ctx.stroke();
    ctx.restore();
    ctx.setLineDash([]);
    // The hollow candidate diamond is exactly at (anchorTime, entry).
    this.diamond(ctx, x1, entryY, 5, '#d1d4dc', false);
    this.tag(ctx, `入场候选 ${formatPrice(setup.entry)}`, x2 + 7, entryY, '#d1d4dc', `setup:${setup.id}`, occupied, true, { x: x2, y: entryY });
    this.tag(ctx, `SL ${formatPrice(setup.stopLoss)}`, x2 + 7, stopY, '#ff6b77', `setup:${setup.id}`, occupied, true, { x: x2, y: stopY });
    targets.forEach((target, index) => this.tag(ctx, `TP${index + 1} ${formatPrice(target.price)}`, x2 + 7, target.y,
      '#2bc5a8', `setup:${setup.id}`, occupied, true, { x: x2, y: target.y }));
    const ratio = targets[0].rewardRisk;
    const ratioText = `${setup.direction === 'bullish' ? '多' : '空'} · R:R 1:${ratio < .01 ? ratio.toExponential(2) : ratio.toFixed(2)}`;
    this.tag(ctx, ratioText, x1 + 6, (entryY + targets[0].y) / 2, '#2bc5a8', `setup:${setup.id}`, occupied, false);
    ctx.restore();
  }

  private drawSweep(ctx: CanvasRenderingContext2D, { sweep, geometry }: DrawSweep): void {
    const color = sweep.side === 'buy-side' ? '#f5b642' : '#45c4e6';
    const selected = sweep.id === this.selectedSweepId;
    const { levelX, sweepX, levelY, extremeY } = geometry;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 2 : 1.2;
    ctx.globalAlpha = (selected ? 1 : 0.8) * (this.dimmed || (this.selectedSweepId && !selected) ? .4 : 1);
    ctx.setLineDash(sweep.status === 'candidate' ? [3, 4] : [7, 3]);
    ctx.beginPath(); ctx.moveTo(levelX, levelY); ctx.lineTo(sweepX, levelY); ctx.stroke();
    ctx.setLineDash(sweep.status === 'candidate' ? [2, 3] : []);
    ctx.beginPath(); ctx.moveTo(sweepX, levelY); ctx.lineTo(sweepX, extremeY); ctx.stroke();
    ctx.setLineDash([]);
    this.diamond(ctx, sweepX, extremeY, selected ? 5 : 3.5, color, sweep.status === 'confirmed');
    if (sweep.status === 'confirmed') {
      const sign = levelY >= extremeY ? 1 : -1;
      const arrowX = sweepX + 8;
      const arrowEnd = levelY + sign * 5;
      ctx.beginPath(); ctx.moveTo(arrowX, extremeY); ctx.lineTo(arrowX, arrowEnd);
      ctx.moveTo(arrowX - 3, arrowEnd - sign * 4); ctx.lineTo(arrowX, arrowEnd); ctx.lineTo(arrowX + 3, arrowEnd - sign * 4); ctx.stroke();
    }
    ctx.restore();
  }

  private drawSweepLabel(ctx: CanvasRenderingContext2D, { sweep, geometry }: DrawSweep, occupied: LabelBox[]): void {
    const color = sweep.side === 'buy-side' ? '#f5b642' : '#45c4e6';
    const text = `${sweep.side === 'buy-side' ? 'BSL' : 'SSL'} ${sweep.status === 'confirmed' ? '扫除 · 已收回' : '扫除候选'}`;
    this.tag(ctx, text, geometry.sweepX + 9, geometry.extremeY + (sweep.side === 'buy-side' ? -15 : 15), color,
      `sweep:${sweep.id}`, occupied, sweep.id === this.selectedSweepId, { x: geometry.sweepX, y: geometry.extremeY });
  }

  private diamond(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string, filled: boolean): void {
    ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = filled ? color : '#131722';
    ctx.beginPath(); ctx.moveTo(x, y - radius); ctx.lineTo(x + radius, y); ctx.lineTo(x, y + radius); ctx.lineTo(x - radius, y); ctx.closePath();
    ctx.fill(); ctx.stroke(); ctx.restore();
  }

  private tag(ctx: CanvasRenderingContext2D, text: string, preferredX: number, preferredY: number, color: string, id: string, occupied: LabelBox[], essential: boolean, anchor?: { x: number; y: number }): void {
    ctx.save();
    ctx.font = '500 10px Arial, "Segoe UI", sans-serif';
    const width = ctx.measureText(text).width + 10;
    const left = Math.max(4, Math.min(preferredX, this.viewport.width - width - 4));
    const centerY = Math.max(10, Math.min(preferredY, this.viewport.height - 10));
    let box: LabelBox | null = null;
    for (const shift of [0, -18, 18, -36, 36, -54, 54]) {
      const candidate = { left, top: Math.max(2, Math.min(centerY + shift - 8, this.viewport.height - 18)), width, height: 16 };
      if (reserveLabel(candidate, occupied)) { box = candidate; break; }
    }
    if (!box && essential) {
      box = { left, top: centerY - 8, width, height: 16 };
      reserveLabel(box, occupied, true);
    }
    if (box) {
      if (anchor) {
        const closestX = Math.max(box.left, Math.min(anchor.x, box.left + box.width));
        const closestY = Math.max(box.top, Math.min(anchor.y, box.top + box.height));
        ctx.save(); ctx.globalAlpha = 0.55; ctx.strokeStyle = color; ctx.lineWidth = 0.8; ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(anchor.x, anchor.y); ctx.lineTo(closestX, closestY); ctx.stroke(); ctx.restore();
      }
      ctx.fillStyle = 'rgba(19,23,34,.95)'; ctx.fillRect(box.left, box.top, box.width, box.height);
      ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.fillText(text, box.left + 5, box.top + 8);
      this.labelHits.push({ id, box });
    }
    ctx.restore();
  }
}
