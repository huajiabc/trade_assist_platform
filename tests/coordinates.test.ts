import { describe, expect, it } from 'vitest';
import type { Structure } from '../shared/analysis';
import type { Candle } from '../shared/market';
import { distanceToGeometry, mapStructure, nearestCandleIndex, structureFocusRange } from '../src/chart/coordinates';
import { createChartPriceScale } from '../src/chart/priceScale';
import { preserveLogicalWindow } from '../src/chart/liveUpdates';

const structure = (overrides: Partial<Structure> = {}): Structure => ({
  id: 'structure-1', type: 'BOS', status: 'confirmed', direction: 'bullish',
  startTime: 10, endTime: 30, price: 120, priceEnd: null,
  rationale: 'A close above the prior swing high.', invalidation: 'Close below the preceding low.',
  ...overrides,
});
const viewport = { width: 300, height: 200 };
const mapper = { timeToX: (time: number) => time * 5, priceToY: (price: number) => 300 - price * 2 };
const candles: Candle[] = Array.from({ length: 100 }, (_, i) => ({ timestamp: 1_700_000_000 + i * 3600, open: 100, high: 110, low: 90, close: 105, volume: 1000 }));

describe('exact structure mapping', () => {
  it('maps a BOS at its actual timestamps and price', () => {
    expect(mapStructure(structure(), mapper, viewport)).toEqual({ id: 'structure-1', kind: 'line', x1: 50, x2: 150, y1: 60, y2: 60 });
  });
  it('accepts zero screen coordinates and never treats zero as missing', () => {
    expect(mapStructure(structure({ type: 'HH', startTime: 0, price: 150 }), mapper, viewport))?.toMatchObject({ kind: 'point', x1: 0, y1: 0 });
  });
  it('skips missing or non-finite public chart coordinates', () => {
    expect(mapStructure(structure(), { ...mapper, timeToX: () => null }, viewport)).toBeNull();
    expect(mapStructure(structure(), { ...mapper, priceToY: () => Number.NaN }, viewport)).toBeNull();
  });
  it('normalizes inverted price axes and time endpoints for zones', () => {
    expect(mapStructure(structure({ type: 'FVG', startTime: 30, endTime: 10, price: 100, priceEnd: 130 }), mapper, viewport))
      .toEqual({ id: 'structure-1', kind: 'zone', x1: 50, x2: 150, y1: 40, y2: 100 });
  });
  it('requires both explicit price boundaries for a rectangle', () => {
    expect(mapStructure(structure({ type: 'OB', priceEnd: null }), mapper, viewport)).toBeNull();
  });
  it('culls fully offscreen structures while preserving partly clipped coordinates', () => {
    expect(mapStructure(structure({ startTime: -30, endTime: -10 }), mapper, viewport)).toBeNull();
    expect(mapStructure(structure({ type: 'LL', startTime: -1 }), mapper, viewport)).toBeNull();
    expect(mapStructure(structure({ startTime: -10, endTime: 20 }), mapper, viewport))?.toMatchObject({ x1: -50, x2: 100 });
    expect(mapStructure(structure({ type: 'OB', price: 100, priceEnd: 170 }), mapper, viewport))?.toMatchObject({ y1: -40, y2: 100 });
  });
  it('hit-tests rectangles, points and line segments against precise anchors', () => {
    const line = mapStructure(structure(), mapper, viewport)!;
    expect(distanceToGeometry(line, 100, 65)).toBe(5);
    expect(distanceToGeometry(line, 160, 60)).toBe(10);
    const zone = mapStructure(structure({ type: 'OB', price: 100, priceEnd: 130 }), mapper, viewport)!;
    expect(distanceToGeometry(zone, 100, 50)).toBe(0);
    expect(distanceToGeometry(zone, 160, 110)).toBeCloseTo(Math.sqrt(200));
  });
});

describe('selection focus', () => {
  it('finds actual candle indices with gaps instead of dividing timestamp differences', () => {
    const gapped = [candles[0], candles[1], { ...candles[2], timestamp: candles[0].timestamp + 5 * 86400 }];
    expect(nearestCandleIndex(gapped, gapped[2].timestamp - 3600)).toBe(2);
    expect(nearestCandleIndex([], 0)).toBe(-1);
  });
  it('focuses a selected range and clamps to available candle boundaries', () => {
    expect(structureFocusRange(candles, { startTime: candles[0].timestamp, endTime: candles[2].timestamp })).toEqual({ from: 0, to: 39 });
    expect(structureFocusRange(candles, { startTime: candles[98].timestamp, endTime: candles[99].timestamp })).toEqual({ from: 60, to: 99 });
    expect(structureFocusRange(candles.slice(0, 2), { startTime: 0, endTime: Number.MAX_SAFE_INTEGER })).toEqual({ from: 0, to: 1 });
    expect(structureFocusRange([], { startTime: 0, endTime: 1 })).toBeNull();
  });
  it('preserves long structures plus contextual padding', () => {
    expect(structureFocusRange(candles, { startTime: candles[20].timestamp, endTime: candles[70].timestamp })).toEqual({ from: 8, to: 82 });
  });
});

describe('tiny-instrument chart scale', () => {
  it('preserves tiny price axis labels and applies the same mapping to structures', () => {
    const tinyCandles = candles.map((candle) => ({ ...candle, open: 1e-20, high: 1.1e-20, low: 0.9e-20, close: 1.05e-20 }));
    const scale = createChartPriceScale(tinyCandles);
    expect(scale.multiplier).toBe(1e20);
    expect(scale.format.formatter(1.05 as never)).toBe('1.050000e-20');
    expect(Number.isFinite(scale.format.base)).toBe(true);
    const tinyMapper = { timeToX: mapper.timeToX, priceToY: (value: number) => 200 - value * scale.multiplier * 100 };
    const geometry = mapStructure(structure({ type: 'HH', price: 1.1e-20 }), tinyMapper, viewport);
    expect(geometry?.y1).toBeCloseTo(90);
    expect(tinyCandles[0].high).toBe(1.1e-20);
  });
  it('keeps normal instrument values unchanged and avoids overflowing for subnormal inputs', () => {
    expect(createChartPriceScale(candles).multiplier).toBe(1);
    const smallest = createChartPriceScale([{ ...candles[0], open: Number.MIN_VALUE, high: Number.MIN_VALUE, low: Number.MIN_VALUE, close: Number.MIN_VALUE }]);
    expect(Number.isFinite(smallest.multiplier)).toBe(true);
    expect(Number.isFinite(smallest.format.base)).toBe(true);
    expect(smallest.format.formatter((Number.MIN_VALUE * smallest.multiplier) as never)).not.toBe('0.00');
  });
});

describe('live candle viewport updates', () => {
  it('preserves zoom when only the in-progress candle changes', () => {
    const updated = candles.map((candle, index) => index === 99 ? { ...candle, close: 106 } : candle);
    expect(preserveLogicalWindow(candles, updated, { from: 20.5, to: 70.5 })).toEqual({ from: 20.5, to: 70.5 });
  });
  it('anchors historical bars when a rolling window removes older candles', () => {
    const next = [...candles.slice(3), ...[1, 2, 3].map((step) => ({ ...candles[99], timestamp: candles[99].timestamp + step * 3600 }))];
    expect(preserveLogicalWindow(candles, next, { from: 20.25, to: 70.25 })).toEqual({ from: 17.25, to: 67.25 });
    expect(preserveLogicalWindow(candles, next, { from: 60, to: 104 })).toEqual({ from: 60, to: 104 });
  });
  it('follows a newly appended candle only when viewing the latest bars', () => {
    const next = [...candles, { ...candles[99], timestamp: candles[99].timestamp + 3600 }];
    expect(preserveLogicalWindow(candles, next, { from: 60, to: 104 })).toEqual({ from: 61, to: 105 });
    expect(preserveLogicalWindow(candles, next, { from: 10, to: 50 })).toEqual({ from: 10, to: 50 });
  });
  it('uses shared timestamps across gaps and handles fully expired viewports', () => {
    const irregular = [candles[0], candles[5], candles[19], candles[20], candles[40], candles[90]];
    expect(preserveLogicalWindow(irregular, irregular.slice(2), { from: 1, to: 4 })).toEqual({ from: -1, to: 2 });
    expect(preserveLogicalWindow(candles, candles.slice(60), { from: 2, to: 42 })).toEqual({ from: 0, to: 40 });
    expect(preserveLogicalWindow(candles, [], { from: 2, to: 42 })).toBeNull();
    expect(preserveLogicalWindow(candles, candles, null)).toBeNull();
    const disjoint = candles.map((candle) => ({ ...candle, timestamp: candle.timestamp + 1_000_000 }));
    expect(preserveLogicalWindow(candles, disjoint, { from: 2, to: 42 })).toBeNull();
  });
});
