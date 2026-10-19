import { describe, expect, it, vi } from 'vitest';
import type { IPrimitivePaneRenderer, Logical, SeriesAttachedParameter } from 'lightweight-charts';
import type { RuleIndicatorZone } from '../shared/indicators';
import type { Candle } from '../shared/market';
import { IndicatorOverlay } from '../src/chart/IndicatorOverlay';

const zone = (changes: Partial<RuleIndicatorZone> = {}): RuleIndicatorZone => ({
  id: 'fvg-1', type: 'FVG', direction: 'bullish', status: 'active',
  originTime: 1_000, formedAt: 1_300, endTime: 1_900,
  lowerPrice: 80, upperPrice: 120, midpoint: 100,
  firstTouchTime: null, resolvedTime: null, mitigation: 0,
  rationale: 'Closed candle gap', invalidation: 'Full fill', evidenceTimes: [1_000, 1_300], ...changes,
});

type RecordedOperation = { name: string; args: unknown[]; fillStyle: unknown; strokeStyle: unknown; opacity: unknown; dash: number[]; font: unknown; textAlign: unknown; textBaseline: unknown };

/** Native primitive public lifecycle/renderer harness. No browser or model calls. */
function harness(priceToY: (price: number) => number = price => 400 - price * 2, times = [1_000, 1_300, 1_900, 2_200]) {
  const operations: RecordedOperation[] = [];
  const ctx: Record<string, unknown> = { fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 1 };
  let dash: number[] = [];
  const stack: { values: Record<string, unknown>; dash: number[] }[] = [];
  const stateKeys = ['fillStyle', 'strokeStyle', 'globalAlpha', 'lineWidth', 'font', 'textAlign', 'textBaseline'];
  ctx.save = () => { stack.push({ values: Object.fromEntries(stateKeys.map(key => [key, ctx[key]])), dash: [...dash] }); };
  ctx.restore = () => { const state = stack.pop(); if (state) { Object.assign(ctx, state.values); dash = state.dash; } };
  ctx.setLineDash = (value: number[]) => { dash = [...value]; };
  ctx.measureText = (value: string) => ({ width: value.length * 5 });
  for (const name of ['beginPath', 'rect', 'clip', 'fillRect', 'strokeRect', 'moveTo', 'lineTo', 'stroke', 'arc', 'fill', 'fillText']) {
    ctx[name] = (...args: unknown[]) => { operations.push({ name, args, fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle, opacity: ctx.globalAlpha, dash: [...dash], font: ctx.font, textAlign: ctx.textAlign, textBaseline: ctx.textBaseline }); };
  }
  // Includes a still-forming tail at 2,200, while indicator endpoints are 1,900.
  const candles: Candle[] = times.map(timestamp => ({ timestamp, open: 100, high: 120, low: 80, close: 110, volume: 100 }));
  const scale = {
    options: () => ({ barSpacing: 8 }),
    timeToCoordinate: vi.fn((time: number) => times.includes(time) ? 50 + (time - 1_000) / 3 : null),
    timeToIndex: vi.fn((time: number) => { const index = times.indexOf(time); return index < 0 ? null : index; }),
    logicalToCoordinate: vi.fn(() => { throw new Error('Fractional logical coordinates must not be used'); }),
  };
  const series = { priceToCoordinate: vi.fn(priceToY) };
  const requestUpdate = vi.fn();
  const overlay = new IndicatorOverlay();
  overlay.attached({ chart: { timeScale: () => scale }, series, requestUpdate } as unknown as SeriesAttachedParameter);
  const target = {
    useMediaCoordinateSpace: (draw: (scope: { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } }) => void) => draw({ context: ctx as unknown as CanvasRenderingContext2D, mediaSize: { width: 600, height: 500 } }),
  } as unknown as Parameters<IPrimitivePaneRenderer['draw']>[0];
  const draw = (layer: 'bottom' | 'top') => {
    const view = overlay.paneViews().find(view => view.zOrder?.() === layer);
    const renderer = view?.renderer();
    renderer?.draw(target);
    return operations;
  };
  return { overlay, operations, scale, series, requestUpdate, draw, candles };
}

describe('native rule indicator overlay', () => {
  it('renders from rule zones without an AI result and fills only after causal formation', () => {
    const h = harness();
    h.overlay.setData([zone()], null, h.candles);
    h.draw('bottom');
    expect(h.operations.filter(op => op.name === 'fillRect').map(op => op.args)).toEqual([[150, 160, 200, 80]]);
    h.draw('top');
    expect(h.operations.filter(op => ['stroke', 'strokeRect', 'arc', 'moveTo', 'lineTo'].includes(op.name))).toEqual([]);
    expect(h.operations.filter(op => op.name === 'fillText')).toEqual([
      expect.objectContaining({ args: ['FVG', 250, 200], font: expect.stringContaining('9px Arial'), textAlign: 'center', textBaseline: 'middle' }),
    ]);
    // The earlier source candle is evidence only, never a second shaded area or bracket.
    expect(h.operations.filter(op => op.name === 'fillRect').map(op => op.args)).toEqual([[150, 160, 200, 80]]);
    expect(h.scale.timeToCoordinate).toHaveBeenCalledWith(1_900);
    expect(h.scale.timeToCoordinate).not.toHaveBeenCalledWith(2_200);
    expect(h.scale.logicalToCoordinate).not.toHaveBeenCalled();
  });

  it('paints a new formation inside its own candle cell without adding a future candle, border or outside label', () => {
    const h = harness();
    h.overlay.setData([zone({ endTime: 1_300 })], null, h.candles);
    h.draw('bottom'); h.draw('top');
    expect(h.operations.filter(op => op.name === 'fillRect').map(op => op.args)).toEqual([[146, 160, 8, 80]]);
    expect(h.operations.filter(op => ['fillText', 'stroke', 'strokeRect', 'arc', 'moveTo', 'lineTo'].includes(op.name))).toEqual([]);
    expect(h.overlay.hitTest(150, 200)?.externalId).toBe('indicator:fvg-1');
    expect(h.scale.timeToCoordinate).not.toHaveBeenCalledWith(2_200);
    expect(h.scale.logicalToCoordinate).not.toHaveBeenCalled();
  });

  it('hit-tests labels and exact boundaries without taking clicks from filled interiors', () => {
    const h = harness(); h.overlay.setData([zone()], null, h.candles); h.draw('top');
    expect(h.overlay.hitTest(210, 200)).toBeNull();
    expect(h.overlay.hitTest(250, 200)?.externalId).toBe('indicator:fvg-1');
    expect(h.overlay.hitTest(250, 163)?.externalId).toBe('indicator:fvg-1');
    expect(h.overlay.hitTest(150, 200)?.externalId).toBe('indicator:fvg-1');
    expect(h.overlay.hitTest(160, 145)).toBeNull();
    expect(h.overlay.hitTest(-1, 160)).toBeNull();
  });

  it('uses the same price multiplier for geometry and selected autoscale, keeping selected labels minimal', () => {
    const h = harness(price => 400 - price / 500);
    h.overlay.setPriceMultiplier(1_000); h.overlay.setData([zone()], 'fvg-1', h.candles); h.draw('bottom'); h.draw('top');
    expect(h.series.priceToCoordinate.mock.calls.map(call => call[0])).toContain(80_000);
    expect(h.series.priceToCoordinate.mock.calls.map(call => call[0])).toContain(120_000);
    expect(h.operations.some(op => op.name === 'fillRect' && JSON.stringify(op.args) === '[150,160,200,80]')).toBe(true);
    expect(h.operations.filter(op => op.name === 'fillText').map(op => op.args)).toEqual([['FVG', 250, 200]]);
    expect(h.operations.filter(op => ['stroke', 'strokeRect', 'arc', 'moveTo', 'lineTo'].includes(op.name))).toEqual([]);
    expect(h.overlay.autoscaleInfo(0 as Logical, 2 as Logical)?.priceRange).toEqual({ minValue: 80_000, maxValue: 120_000 });
    h.overlay.setData([zone()], null, h.candles);
    expect(h.overlay.autoscaleInfo(0 as Logical, 2 as Logical)).toBeNull();
  });

  it('keeps retired history and OB candidate labels small and borderless without changing their exact geometry', () => {
    const h = harness();
    h.overlay.setData([zone({ status: 'filled', mitigation: 1 })], null, h.candles); h.draw('bottom'); h.draw('top');
    expect(h.operations.some(op => op.name === 'fillRect' && op.fillStyle === 'rgba(135,146,165,0.05)')).toBe(true);
    expect(h.operations.filter(op => ['stroke', 'strokeRect', 'arc', 'moveTo', 'lineTo'].includes(op.name))).toEqual([]);
    expect(h.operations.filter(op => op.name === 'fillText').map(op => op.args)).toEqual([['FVG', 250, 200]]);
    h.operations.length = 0;
    h.overlay.setData([zone({ id: 'ob-1', type: 'OB', direction: 'bearish', status: 'invalidated' })], null, h.candles); h.draw('top');
    expect(h.operations.filter(op => op.name === 'fillText').map(op => op.args)).toEqual([['OB', 250, 200]]);
    expect(h.operations.filter(op => ['fillRect', 'stroke', 'strokeRect', 'arc', 'moveTo', 'lineTo'].includes(op.name))).toEqual([]);
  });

  it('reprojects through the public scales after a viewport move and cleans up all hits on detach', () => {
    const h = harness(); h.overlay.setData([zone()], null, h.candles); h.draw('top');
    expect(h.overlay.hitTest(150, 200)).not.toBeNull();
    h.scale.timeToCoordinate.mockImplementation(time => [1_000, 1_300, 1_900, 2_200].includes(time) ? 250 + (time - 1_000) / 3 : null);
    h.draw('top');
    expect(h.overlay.hitTest(150, 200)).toBeNull();
    expect(h.overlay.hitTest(350, 200)?.externalId).toBe('indicator:fvg-1');
    h.overlay.detached(); h.draw('top');
    expect(h.overlay.hitTest(350, 200)).toBeNull();
    expect(h.overlay.autoscaleInfo(0 as Logical, 2 as Logical)).toBeNull();
  });

  it.each([
    { type: 'FVG' as const, direction: 'bullish' as const },
    { type: 'OB' as const, direction: 'bearish' as const },
  ])('limits $type fill, centered label, hits and selected autoscale to five later candles', changes => {
    const times = Array.from({ length: 19 }, (_, index) => 1_000 + index * 150);
    const h = harness(undefined, times);
    const active = zone({ ...changes, endTime: 3_700 });
    const original = structuredClone(active);
    h.overlay.setData([active], active.id, h.candles);
    h.draw('bottom'); h.draw('top');
    // Formation index 2, bounded display end index 7 => x=400, not the lifecycle x=950.
    expect(h.operations.some(op => op.name === 'fillRect' && JSON.stringify(op.args) === '[150,160,250,80]')).toBe(true);
    expect(h.operations.filter(op => op.name === 'fillText').map(op => op.args)).toEqual([[changes.type, 275, 200]]);
    expect(h.operations.filter(op => ['stroke', 'strokeRect', 'arc', 'moveTo', 'lineTo'].includes(op.name))).toEqual([]);
    expect(h.scale.timeToCoordinate).toHaveBeenCalledWith(2_050);
    expect(h.scale.timeToCoordinate).not.toHaveBeenCalledWith(3_700);
    expect(h.overlay.hitTest(400, 200)?.externalId).toBe('indicator:fvg-1');
    expect(h.overlay.hitTest(500, 160)).toBeNull();
    expect(h.overlay.autoscaleInfo(5 as Logical, 7 as Logical)?.priceRange).toEqual({ minValue: 80, maxValue: 120 });
    expect(h.overlay.autoscaleInfo(8 as Logical, 18 as Logical)).toBeNull();
    expect(active).toEqual(original);
  });

  it('does not leave a label or clickable zone when only the old unbounded extension is visible', () => {
    const times = Array.from({ length: 19 }, (_, index) => 1_000 + index * 150);
    const h = harness(undefined, times);
    h.overlay.setData([zone({ endTime: 3_700 })], 'fvg-1', h.candles); h.draw('top');
    expect(h.operations.some(op => op.name === 'fillText')).toBe(true);
    h.operations.length = 0;
    h.scale.timeToCoordinate.mockImplementation(time => times.includes(time) ? (time - 1_000) / 3 - 450 : null);
    h.draw('top');
    expect(h.operations.some(op => op.name === 'fillText')).toBe(false);
    expect(h.operations.some(op => op.name === 'strokeRect')).toBe(false);
    expect(h.overlay.hitTest(50, 160)).toBeNull();
    expect(h.overlay.autoscaleInfo(10 as Logical, 18 as Logical)).toBeNull();
  });
});
