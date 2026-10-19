import { describe, expect, it } from 'vitest';
import type { RuleIndicatorZone } from '../shared/indicators';
import type { Candle } from '../shared/market';
import { distanceToIndicatorGeometry, indicatorDisplayEndTime, indicatorFocusRange, mapIndicatorZone } from '../src/chart/indicatorCoordinates';

const zone = (changes: Partial<RuleIndicatorZone> = {}): RuleIndicatorZone => ({
  id: 'fvg-1', type: 'FVG', direction: 'bullish', status: 'active',
  originTime: 1_700_000_000, formedAt: 1_700_000_900, endTime: 1_700_006_000,
  lowerPrice: 102, upperPrice: 106, midpoint: 104,
  firstTouchTime: null, resolvedTime: null, mitigation: 0,
  rationale: 'Three-candle gap', invalidation: 'Full gap fill', evidenceTimes: [1_700_000_000, 1_700_000_900],
  ...changes,
});
const viewport = { width: 800, height: 500 };
const mapper = {
  timeToX: (timestamp: number) => (timestamp - 1_700_000_000) / 30,
  priceToY: (price: number) => 500 - price * 3,
};

describe('rule indicator coordinates', () => {
  it('maps origin, causal formation, real extension and every exact price separately', () => {
    expect(mapIndicatorZone(zone(), mapper, viewport)).toEqual({
      id: 'fvg-1', originX: 0, formedX: 30, endX: 200, top: 182, bottom: 194, midpointY: 188,
    });
  });
  it('uses the actual midpoint price mapping on a logarithmic price scale', () => {
    const logMapper = { ...mapper, priceToY: (price: number) => 600 - Math.log(price) * 100 };
    const result = mapIndicatorZone(zone(), logMapper, viewport)!;
    expect(result.midpointY).toBe(logMapper.priceToY(104));
    expect(result.midpointY).not.toBe((result.top + result.bottom) / 2);
    expect(result.top).toBe(logMapper.priceToY(106));
    expect(result.bottom).toBe(logMapper.priceToY(102));
  });
  it('preserves real offscreen coordinates instead of inventing clipped zone boundaries', () => {
    const shifted = { ...mapper, timeToX: (time: number) => mapper.timeToX(time) - 90 };
    expect(mapIndicatorZone(zone(), shifted, viewport)).toMatchObject({ originX: -90, formedX: -60, endX: 110 });
    expect(mapIndicatorZone(zone(), { ...mapper, timeToX: () => -10 }, viewport)).toBeNull();
    expect(mapIndicatorZone(zone(), { ...mapper, priceToY: () => 600 }, viewport)).toBeNull();
  });
  it('does not substitute another candle when any exact timestamp is unavailable', () => {
    for (const missing of [zone().originTime, zone().formedAt, zone().endTime]) {
      expect(mapIndicatorZone(zone(), { ...mapper, timeToX: time => time === missing ? null : mapper.timeToX(time) }, viewport)).toBeNull();
    }
    expect(mapIndicatorZone(zone(), { ...mapper, priceToY: () => null }, viewport)).toBeNull();
  });
  it('rejects invalid geometry and nonfinite coordinate results before rendering', () => {
    for (const changes of [
      { formedAt: zone().originTime - 1 }, { endTime: zone().formedAt - 1 },
      { lowerPrice: 106 }, { lowerPrice: 0 }, { midpoint: 110 }, { upperPrice: NaN },
    ]) expect(mapIndicatorZone(zone(changes), mapper, viewport)).toBeNull();
    expect(mapIndicatorZone(zone(), { ...mapper, timeToX: () => Infinity }, viewport)).toBeNull();
    expect(mapIndicatorZone(zone(), mapper, { width: 0, height: 500 })).toBeNull();
  });
  it('only selects zone boundaries and formation, leaving filled interiors available to candles', () => {
    const geometry = mapIndicatorZone(zone({ lowerPrice: 90, upperPrice: 120, midpoint: 105 }), mapper, viewport)!;
    expect(distanceToIndicatorGeometry(geometry, 100, geometry.top + 3)).toBe(3);
    expect(distanceToIndicatorGeometry(geometry, geometry.formedX, geometry.midpointY)).toBe(0);
    expect(distanceToIndicatorGeometry(geometry, 120, geometry.midpointY)).toBeGreaterThan(4);
    expect(distanceToIndicatorGeometry(geometry, -10, geometry.top)).toBe(10);
  });
});

describe('indicator selection focus', () => {
  const candles: Candle[] = Array.from({ length: 300 }, (_, index) => ({ timestamp: 1_700_000_000 + index * 300, open: 100, high: 110, low: 90, close: 105, volume: 100 }));
  it('focuses the origin and formation without zooming out to the extended endTime', () => {
    const selected = zone({ originTime: candles[100].timestamp, formedAt: candles[110].timestamp, endTime: candles[299].timestamp });
    const range = indicatorFocusRange(candles, selected)!;
    expect(range.to - range.from + 1).toBe(40);
    expect(range.from).toBeLessThanOrEqual(100);
    expect(range.to).toBeGreaterThanOrEqual(110);
    expect(range.to).toBeLessThan(150);
  });
  it('includes longer evidence spans while limiting display to sixty bars', () => {
    const range = indicatorFocusRange(candles, { originTime: candles[100].timestamp, formedAt: candles[152].timestamp })!;
    expect(range.to - range.from + 1).toBe(60);
    expect(range.from).toBeLessThanOrEqual(100);
    expect(range.to).toBeGreaterThanOrEqual(152);
  });
  it('clamps only the logical viewport at either dataset edge', () => {
    expect(indicatorFocusRange(candles, { originTime: candles[0].timestamp, formedAt: candles[2].timestamp })).toEqual({ from: 0, to: 39 });
    expect(indicatorFocusRange(candles, { originTime: candles[295].timestamp, formedAt: candles[299].timestamp })).toEqual({ from: 260, to: 299 });
    expect(indicatorFocusRange(candles.slice(0, 15), { originTime: candles[0].timestamp, formedAt: candles[2].timestamp })).toEqual({ from: 0, to: 14 });
  });
  it('requires both exact candle anchors and valid causal ordering', () => {
    expect(indicatorFocusRange(candles, { originTime: candles[2].timestamp + 1, formedAt: candles[5].timestamp })).toBeNull();
    expect(indicatorFocusRange(candles, { originTime: candles[2].timestamp, formedAt: candles[5].timestamp + 1 })).toBeNull();
    expect(indicatorFocusRange(candles, { originTime: candles[5].timestamp, formedAt: candles[2].timestamp })).toBeNull();
    expect(indicatorFocusRange([], { originTime: 1, formedAt: 2 })).toBeNull();
  });
});

describe('finite indicator display duration', () => {
  const timestamps = [1_000, 1_001, 1_003, 1_400, 1_401, 2_500, 9_000, 9_001, 10_000, 12_000];
  const candles: Candle[] = timestamps.map(timestamp => ({ timestamp, open: 100, high: 110, low: 90, close: 105, volume: 100 }));

  it.each([
    { type: 'FVG' as const, direction: 'bullish' as const },
    { type: 'OB' as const, direction: 'bearish' as const },
  ])('caps $direction $type at five actual candles after formation', changes => {
    const original = zone({ ...changes, originTime: timestamps[0], formedAt: timestamps[2], endTime: timestamps[9] });
    expect(indicatorDisplayEndTime(original, candles)).toBe(timestamps[7]);
    // A missing trading interval must not be replaced by elapsed-time arithmetic.
    expect(timestamps[7] - original.formedAt).toBeGreaterThan(5 * (timestamps[2] - timestamps[1]));
    expect(original.endTime).toBe(timestamps[9]);
    expect(original.status).toBe('active');
  });

  it('ends resolved zones at the earlier real lifecycle endpoint', () => {
    const resolved = zone({ formedAt: timestamps[2], endTime: timestamps[4], resolvedTime: timestamps[4], status: 'filled', mitigation: 1 });
    const before = structuredClone(resolved);
    expect(indicatorDisplayEndTime(resolved, candles)).toBe(timestamps[4]);
    expect(resolved).toEqual(before);
  });

  it('uses the last existing endpoint without creating future candles for a young zone', () => {
    const recent = zone({ formedAt: timestamps[8], endTime: timestamps[9] });
    expect(indicatorDisplayEndTime(recent, candles)).toBe(timestamps[9]);
    expect(indicatorDisplayEndTime({ formedAt: timestamps[9], endTime: timestamps[9] }, candles)).toBe(timestamps[9]);
  });

  it('accepts a shorter configured extension in real candle indices', () => {
    const active = { formedAt: timestamps[2], endTime: timestamps[9] };
    expect(indicatorDisplayEndTime(active, candles, 2)).toBe(timestamps[4]);
    expect(indicatorDisplayEndTime(active, candles, 0)).toBe(timestamps[2]);
  });

  it('requires both exact endpoints and rejects a reversed lifecycle', () => {
    expect(indicatorDisplayEndTime({ formedAt: timestamps[2] + 1, endTime: timestamps[9] }, candles)).toBeNull();
    expect(indicatorDisplayEndTime({ formedAt: timestamps[2], endTime: timestamps[9] + 1 }, candles)).toBeNull();
    expect(indicatorDisplayEndTime({ formedAt: timestamps[4], endTime: timestamps[2] }, candles)).toBeNull();
    expect(indicatorDisplayEndTime({ formedAt: timestamps[0], endTime: timestamps[0] }, [])).toBeNull();
  });
});
