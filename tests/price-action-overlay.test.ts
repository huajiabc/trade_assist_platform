import { describe, expect, it, vi } from 'vitest';
import type { IPrimitivePaneRenderer, SeriesAttachedParameter } from 'lightweight-charts';
import type { Candle } from '../shared/market';
import { emptyPriceAction, type PALeg, type PriceAction } from '../shared/priceAction';
import { PriceActionOverlay } from '../src/chart/PriceActionOverlay';
import { ALL_PA_LAYERS } from '../src/chart/priceActionCoordinates';

const candles: Candle[] = [100, 160].map(timestamp => ({ timestamp, open: 95, high: 120, low: 80, close: 110, volume: 100 }));
const leg: PALeg = Object.freeze({ id: 'leg-1', kind: 'impulse', direction: 'bullish', status: 'confirmed', startTime: 100, endTime: 160, startPrice: 80, endPrice: 120, title: '真实价格腿', rationale: '实际区间端点', invalidation: '跌破保护点' });
const analysis: PriceAction = { ...emptyPriceAction(), legs: [leg] };

function harness(spacing = 8) {
  const ctx = {
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
    moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), closePath: vi.fn(), arc: vi.fn(), fill: vi.fn(),
    fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(), setLineDash: vi.fn(),
    measureText: (text: string) => ({ width: text.length * 6 }),
  };
  const overlay = new PriceActionOverlay();
  overlay.attached({ chart: { timeScale: () => ({ options: () => ({ barSpacing: spacing }), timeToCoordinate: (time: number) => time === 100 ? 30 : time === 160 ? 130 : null }) }, series: { priceToCoordinate: (price: number) => 400 - price * 2 }, requestUpdate: vi.fn() } as unknown as SeriesAttachedParameter);
  const target = { useMediaCoordinateSpace: (draw: (scope: unknown) => void) => draw({ context: ctx, mediaSize: { width: 600, height: 400 } }) } as unknown as Parameters<IPrimitivePaneRenderer['draw']>[0];
  const draw = (layer: 'bottom' | 'top') => overlay.paneViews().find(view => view.zOrder?.() === layer)!.renderer()!.draw(target);
  return { ctx, overlay, draw };
}

describe('PA visual hierarchy without removing evidence', () => {
  it('keeps the exact default trend path and hit target, omitting the ribbon, arrow and percent badge', () => {
    const original = JSON.stringify(analysis), h = harness();
    h.overlay.setData(candles, analysis, ALL_PA_LAYERS, null);
    h.draw('bottom'); expect(h.ctx.fill).not.toHaveBeenCalled();
    h.draw('top');
    expect(h.ctx.moveTo).toHaveBeenCalledWith(30, 240);
    expect(h.ctx.lineTo).toHaveBeenCalledWith(130, 160);
    expect(h.ctx.closePath).not.toHaveBeenCalled(); expect(h.ctx.fillText).not.toHaveBeenCalled();
    expect(h.overlay.hitTest(80, 200)?.externalId).toBe('pa:leg-1');
    expect(JSON.stringify(analysis)).toBe(original);
  });

  it('reveals movement text at detailed zoom and shows selected evidence even in overview', () => {
    const detail = harness(12); detail.overlay.setData(candles, analysis, ALL_PA_LAYERS, null); detail.draw('top');
    expect(detail.ctx.fillText).toHaveBeenCalledWith('推进 +50.00%', expect.any(Number), expect.any(Number), expect.any(Number));
    const overview = harness(2); overview.overlay.setData(candles, analysis, ALL_PA_LAYERS, leg.id);
    overview.draw('bottom'); expect(overview.ctx.closePath).toHaveBeenCalledOnce();
    overview.draw('top');
    expect(overview.ctx.fillText).toHaveBeenCalledWith(expect.stringContaining('真实价格腿'), expect.any(Number), expect.any(Number), expect.any(Number));
    expect(overview.overlay.hitTest(80, 200)?.externalId).toBe('pa:leg-1');
  });

  it('layer switches remove rendered hits while retaining the original leg data', () => {
    const h = harness(); h.overlay.setData(candles, analysis, { ...ALL_PA_LAYERS, legs: false }, null); h.draw('top');
    expect(h.overlay.hitTest(80, 200)).toBeNull(); expect(h.ctx.moveTo).not.toHaveBeenCalled();
    expect(analysis.legs).toEqual([leg]);
  });
});
