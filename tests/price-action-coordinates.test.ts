import { describe, expect, it } from 'vitest';
import type { Candle } from '../shared/market';
import type { PAZone, PALeg, PAPattern, PABreakout, PriceAction } from '../shared/priceAction';
import { createChartPriceScale } from '../src/chart/priceScale';
import { distanceToPAGeometry, findPAItem, mapPABreakout, mapPALeg, mapPAPattern, mapPAZone, paFocusRange, paItemBounds } from '../src/chart/priceActionCoordinates';

const candles: Candle[] = [10, 20, 40, 80, 90, 100].map((timestamp, index) => ({ timestamp, open: 100 + index, high: 110 + index, low: 95 + index, close: 104 + index, volume: 1000 }));
const common = { status: 'confirmed' as const, title: 'PA evidence', rationale: 'Evidence on actual candles.', invalidation: 'The evidence ceases to hold.' };
const zone: PAZone = { ...common, id: 'zone', kind: 'support', startTime: 10, endTime: 40, lowerPrice: 95, upperPrice: 105, touchTimes: [10, 40] };
const leg: PALeg = { ...common, id: 'leg', kind: 'impulse', direction: 'bullish', startTime: 20, endTime: 80, startPrice: 96, endPrice: 113 };
const pattern: PAPattern = { ...common, id: 'pattern', kind: 'inside-bar', direction: 'neutral', startTime: 20, endTime: 40 };
const breakout: PABreakout = { ...common, id: 'breakout', zoneId: 'zone', direction: 'bullish', breakoutTime: 80, retestTime: 90, confirmationTime: 90 };
const pa: PriceAction = { regime: 'uptrend', summary: 'Actual PA geometry.', zones: [zone], legs: [leg], patterns: [pattern], breakouts: [breakout] };
const mapper = { timeToX: (timestamp: number) => timestamp * 3, priceToY: (price: number) => 200 - price };
const viewport = { width: 400, height: 200 };

describe('PA evidence coordinate mapping', () => {
  it('maps zone boundaries and wick touches using exact timestamps, including gaps', () => {
    expect(mapPAZone(zone, candles, mapper, viewport)).toEqual({ kind: 'zone', id: 'zone', x1: 30, x2: 120, top: 95, bottom: 105,
      touches: [{ x: 30, y: 105, time: 10, price: 95 }, { x: 120, y: 103, time: 40, price: 97 }] });
  });
  it('maps both leg endpoint prices through the public chart price scale', () => {
    expect(mapPALeg(leg, candles, mapper, viewport)).toEqual({ kind: 'leg', id: 'leg', start: { x: 60, y: 104, time: 20, price: 96 }, end: { x: 240, y: 87, time: 80, price: 113 } });
  });
  it('derives pattern bounds and candle bodies from OHLC, rather than model prices', () => {
    const result = mapPAPattern(pattern, candles, mapper, viewport)!;
    expect(result).toMatchObject({ kind: 'pattern', x1: 60, x2: 120, top: 88, bottom: 104 });
    expect(result.candles).toEqual([
      { time: 20, x: 60, highY: 89, lowY: 104, openY: 99, closeY: 95 },
      { time: 40, x: 120, highY: 88, lowY: 103, openY: 98, closeY: 94 },
    ]);
  });
  it('maps breakout close, retest wick and confirmation close at actual bars', () => {
    const result = mapPABreakout(breakout, zone, candles, mapper, viewport)!;
    expect(result.points).toEqual([
      { stage: 1, time: 80, price: 107, x: 240, y: 93 },
      { stage: 2, time: 90, price: 99, x: 270, y: 101 },
      { stage: 3, time: 90, price: 108, x: 270, y: 92 },
    ]);
  });
  it('maps bearish retests at their high and supports an incomplete candidate', () => {
    const result = mapPABreakout({ ...breakout, direction: 'bearish', status: 'candidate', confirmationTime: null }, zone, candles, mapper, viewport)!;
    expect(result.points[1]).toMatchObject({ stage: 2, price: 114, y: 86 });
    expect(result.points).toHaveLength(2);
    expect(mapPABreakout({ ...breakout, status: 'candidate', retestTime: null, confirmationTime: null }, zone, candles, mapper, viewport)?.points).toHaveLength(1);
  });
  it('rejects missing candle anchors instead of snapping them to nearby bars', () => {
    expect(mapPAZone({ ...zone, startTime: 11 }, candles, mapper, viewport)).toBeNull();
    expect(mapPAZone({ ...zone, touchTimes: [21] }, candles, mapper, viewport)).toBeNull();
    expect(mapPALeg({ ...leg, endTime: 81 }, candles, mapper, viewport)).toBeNull();
    expect(mapPAPattern({ ...pattern, endTime: 41 }, candles, mapper, viewport)).toBeNull();
    expect(mapPABreakout({ ...breakout, breakoutTime: 81 }, zone, candles, mapper, viewport)).toBeNull();
  });
  it('rejects reversed chronology and breakout phases without prior zones/retests', () => {
    expect(mapPAZone({ ...zone, startTime: 80, endTime: 40 }, candles, mapper, viewport)).toBeNull();
    expect(mapPALeg({ ...leg, startTime: 80, endTime: 20 }, candles, mapper, viewport)).toBeNull();
    expect(mapPAPattern({ ...pattern, startTime: 40, endTime: 20 }, candles, mapper, viewport)).toBeNull();
    expect(mapPABreakout(breakout, undefined, candles, mapper, viewport)).toBeNull();
    expect(mapPABreakout(breakout, { ...zone, endTime: 80 }, candles, mapper, viewport)).toBeNull();
    expect(mapPABreakout({ ...breakout, retestTime: 80 }, zone, candles, mapper, viewport)).toBeNull();
    expect(mapPABreakout({ ...breakout, retestTime: null }, zone, candles, mapper, viewport)).toBeNull();
  });
  it('preserves real offscreen anchors when a region is partially visible', () => {
    const shifted = { ...mapper, timeToX: (time: number) => time * 3 - 60 };
    expect(mapPAZone(zone, candles, shifted, viewport)).toMatchObject({ x1: -30, x2: 60 });
    expect(mapPAZone(zone, candles, { ...mapper, timeToX: (time) => time * 3 - 1000 }, viewport)).toBeNull();
    expect(mapPALeg(leg, candles, mapper, { width: 0, height: 200 })).toBeNull();
  });
  it('rejects non-finite and unavailable coordinates, but accepts coordinate zero', () => {
    expect(mapPALeg(leg, candles, { ...mapper, priceToY: () => Number.NaN }, viewport)).toBeNull();
    expect(mapPAZone(zone, candles, { ...mapper, timeToX: () => null }, viewport)).toBeNull();
    expect(mapPAPattern(pattern, candles, { ...mapper, priceToY: () => Number.POSITIVE_INFINITY }, viewport)).toBeNull();
    expect(mapPABreakout(breakout, zone, candles, { ...mapper, timeToX: () => null }, viewport)).toBeNull();
    expect(mapPALeg(leg, candles, { timeToX: (time) => time - 20, priceToY: (price) => price - 96 }, viewport)?.start).toMatchObject({ x: 0, y: 0 });
  });
  it('leaves logarithmic transformations to the chart rather than interpolating price distances', () => {
    const log = { ...mapper, priceToY: (price: number) => 200 - Math.log10(price) * 50 };
    const result = mapPAZone(zone, candles, log, viewport)!;
    expect(result.top).toBeCloseTo(200 - Math.log10(105) * 50);
    expect(result.bottom).toBeCloseTo(200 - Math.log10(95) * 50);
  });
  it('uses the same micro-price multiplier as OHLC without changing source data', () => {
    const tiny = candles.map((candle) => ({ ...candle, open: candle.open * 1e-22, high: candle.high * 1e-22, low: candle.low * 1e-22, close: candle.close * 1e-22 }));
    const scale = createChartPriceScale(tiny);
    const tinyZone = { ...zone, lowerPrice: zone.lowerPrice * 1e-22, upperPrice: zone.upperPrice * 1e-22 };
    const originalPrice = tinyZone.upperPrice;
    const result = mapPAZone(tinyZone, tiny, { ...mapper, priceToY: (price) => 200 - price * scale.multiplier * 100 }, viewport)!;
    expect(result.top).toBeCloseTo(95);
    expect(result.bottom).toBeCloseTo(105);
    expect(tinyZone.upperPrice).toBe(originalPrice);
  });
  it('hit-tests band edges and touch anchors while leaving the filled interior transparent to clicks', () => {
    const result = mapPAZone({ ...zone, lowerPrice: 80, upperPrice: 120 }, candles, mapper, viewport)!;
    expect(distanceToPAGeometry(result, 75, 80)).toBe(0);
    expect(distanceToPAGeometry(result, 75, 100)).toBeGreaterThan(7);
    expect(distanceToPAGeometry(result, 30, 105)).toBe(0);
    const wave = mapPALeg(leg, candles, mapper, viewport)!;
    expect(distanceToPAGeometry(wave, wave.start.x, wave.start.y)).toBe(0);
    const phases = mapPABreakout(breakout, zone, candles, mapper, viewport)!;
    expect(distanceToPAGeometry(phases, phases.points[1].x, phases.points[1].y)).toBe(0);
  });
});

describe('PA selection and focus', () => {
  it('resolves each PA family in one evidence ID namespace', () => {
    for (const item of [zone, leg, pattern, breakout]) expect(findPAItem(pa, item.id)).toBe(item);
    expect(findPAItem(undefined, 'zone')).toBeUndefined();
    expect(findPAItem(pa, null)).toBeUndefined();
  });
  it('focuses the complete zone and breakout/retest sequence using actual candle indices', () => {
    expect(paItemBounds(breakout, pa, candles)).toMatchObject({ startTime: 10, endTime: 90, anchorTime: 90, anchorPrice: 108 });
    expect(paFocusRange(candles, breakout, pa)).toEqual({ from: 0, to: 5 });
    expect(paItemBounds(pattern, pa, candles)).toMatchObject({ prices: [111, 96, 112, 97], anchorPrice: 106 });
  });
  it('rejects focus for an expired or missing reference rather than jumping to an unrelated candle', () => {
    expect(paFocusRange(candles.slice(1), zone, pa)).toBeNull();
    expect(paFocusRange(candles, { ...pattern, endTime: 41 }, pa)).toBeNull();
    expect(paItemBounds({ ...breakout, zoneId: 'missing' }, pa, candles)).toBeNull();
  });
});
