import { describe, expect, it, vi } from 'vitest';
import type { IPrimitivePaneRenderer, Logical, SeriesAttachedParameter } from 'lightweight-charts';
import type { TradeSetup } from '../shared/analysis';
import type { PositionChartModel } from '../shared/positionChart';
import { TradeOverlay } from '../src/chart/TradeOverlay';

const setup: TradeSetup = {
  id: 'far-plan', opportunityId: null, direction: 'bullish', status: 'candidate', anchorTime: 160,
  entry: 100, stopLoss: 90, targets: [{ price: 150, label: '15m 主目标' }, { price: 1300, label: '15m 远端目标' }],
  tracking: null, basis: null, structureIds: [], trigger: '等待回踩确认', rationale: '结构依据', invalidation: '保护失效',
};

function harness(priceToY = (price: number) => 400 - price * 2) {
  const operations: { name: string; args: unknown[] }[] = [];
  const ctx: Record<string, unknown> = { lineWidth: 1, globalAlpha: 1 };
  ctx.measureText = (value: string) => ({ width: value.length * 6 });
  for (const name of ['save', 'restore', 'beginPath', 'rect', 'clip', 'moveTo', 'lineTo', 'stroke', 'fillRect', 'fill', 'arc', 'closePath', 'setLineDash', 'fillText']) {
    ctx[name] = (...args: unknown[]) => operations.push({ name, args });
  }
  const requestUpdate = vi.fn();
  const overlay = new TradeOverlay();
  overlay.attached({ chart: { timeScale: () => ({ timeToIndex: (time: number) => time === 160 ? 1 : null, timeToCoordinate: (time: number) => time === 160 ? 300 : null, logicalToCoordinate: (value: number) => 290 + value * 10 }) }, series: { priceToCoordinate: priceToY }, requestUpdate } as unknown as SeriesAttachedParameter);
  const draw = (layer: 'bottom' | 'top') => overlay.paneViews().find(view => view.zOrder?.() === layer)!.renderer()!.draw({ useMediaCoordinateSpace: (paint: (scope: unknown) => void) => paint({ context: ctx, mediaSize: { width: 600, height: 400 } }) } as unknown as Parameters<IPrimitivePaneRenderer['draw']>[0]);
  return { overlay, operations, draw, requestUpdate };
}

describe('candidate entry context versus full-plan price scale', () => {
  it('keeps distant TP and SL out of default candle autoscale while preserving all original prices', () => {
    const h = harness(), original = structuredClone(setup);
    h.overlay.setData(setup, [], null);
    expect(h.overlay.autoscaleInfo(0 as Logical, 10 as Logical)).toBeNull();
    h.overlay.setIncludePlanInScale(true);
    expect(h.overlay.autoscaleInfo(0 as Logical, 10 as Logical)?.priceRange).toEqual({ minValue: 90, maxValue: 1300 });
    h.overlay.setIncludePlanInScale(false);
    expect(h.overlay.autoscaleInfo(0 as Logical, 10 as Logical)).toBeNull();
    expect(setup).toEqual(original);
  });

  it('uses the candle price multiplier in the explicit full view, and never expands for an offscreen plan', () => {
    const h = harness(); h.overlay.setData(setup, [], null); h.overlay.setPriceMultiplier(1000); h.overlay.setIncludePlanInScale(true);
    expect(h.overlay.autoscaleInfo(0 as Logical, 10 as Logical)?.priceRange).toEqual({ minValue: 90_000, maxValue: 1_300_000 });
    expect(h.overlay.autoscaleInfo(20 as Logical, 30 as Logical)).toBeNull();
  });

  it('marks distant TP as an offscreen text hint while leaving the actual level at its true coordinate', () => {
    const h = harness(); h.overlay.setData(setup, [], null); h.draw('top');
    const texts = h.operations.filter(op => op.name === 'fillText').map(op => String(op.args[0]));
    expect(texts).toContain('TP1 · 15m 150.00');
    expect(texts).toContain('↑ TP2 · 15m 1,300.00 · 图外');
    expect(h.operations.some(op => op.name === 'moveTo' && op.args[0] === 300 && op.args[1] === -2200)).toBe(true);
    // The edge badge is clickable as this candidate, rather than fabricating
    // a TP line at the viewport edge or moving the underlying TP price.
    const badge = h.operations.find(op => op.name === 'fillText' && String(op.args[0]).includes('图外'))!;
    expect(h.overlay.hitTest(Number(badge.args[1]) + 2, Number(badge.args[2]))?.externalId).toBe('setup:far-plan');
  });

  it('clips a far reward fill to the viewport instead of asking canvas to paint an unbounded rectangle', () => {
    const h = harness(); h.overlay.setData({ ...setup, targets: [setup.targets[1]] }, [], null); h.draw('bottom');
    expect(h.operations.filter(op => op.name === 'fillRect').map(op => op.args)).toEqual([[300, 200, 140, 20], [300, 0, 140, 200]]);
  });

  it('shows a below-view SL distinctly and removes the offscreen note when the full view fits it', () => {
    const h = harness(price => 2100 - price * 20); h.overlay.setData(setup, [], null); h.draw('top');
    expect(h.operations.some(op => op.name === 'fillText' && op.args[0] === '↓ SL 90.00 · 图外')).toBe(false);
    // In this scale the 90 stop is still visible at y=300; a 70 structural
    // stop is genuinely below view at y=700 and must never appear as y=390.
    h.operations.length = 0; h.overlay.setData({ ...setup, stopLoss: 70 }, [], null); h.draw('top');
    expect(h.operations.some(op => op.name === 'fillText' && op.args[0] === '↓ SL 70.00 · 图外')).toBe(true);
    const full = harness(price => 390 - price * .25); full.overlay.setData(setup, [], null); full.overlay.setIncludePlanInScale(true); full.draw('top');
    expect(full.operations.filter(op => op.name === 'fillText').some(op => String(op.args[0]).includes('图外'))).toBe(false);
  });

  it('keeps the existing actual-position scale independent of the candidate view switch', () => {
    const h = harness();
    h.overlay.setPositionData({ lines: [{ price: 91 }, { price: 135 }] } as PositionChartModel);
    expect(h.overlay.autoscaleInfo(0 as Logical, 10 as Logical)?.priceRange).toEqual({ minValue: 91, maxValue: 135 });
    h.overlay.setIncludePlanInScale(true);
    expect(h.overlay.autoscaleInfo(0 as Logical, 10 as Logical)?.priceRange).toEqual({ minValue: 91, maxValue: 135 });
  });
});
