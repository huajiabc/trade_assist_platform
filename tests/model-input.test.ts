import { describe, expect, it } from 'vitest';
import { buildAnalysisPayload, type ModelInput } from '../server/provider';
import type { Candle } from '../shared/market';

function candles(length: number): Candle[] {
  let timestamp = 1_760_000_000;
  return Array.from({ length }, (_, index) => {
    // Review boundaries must follow real bars, including unequal time gaps.
    timestamp += (index % 7 === 0 ? 7_200 : (index % 3 + 1) * 300);
    return { timestamp, open: 95, close: 96, high: 100.123456789 + index / 100,
      low: 90.987654321 - index / 100, volume: index + 0.125 };
  });
}

function input(data: Candle[]): ModelInput {
  return { candles: data, context: { symbol: 'SNDKUSDT', timeframe: '5m', notes: '手动选择的历史已收盘行情。' } };
}

describe('complete-window model input', () => {
  it('retains every candle and the original context for a 168-bar selection', () => {
    const request = input(candles(168));
    const payload = buildAnalysisPayload(request);
    expect(payload.candles).toEqual(request.candles);
    expect(payload.context).toEqual(request.context);
    expect(payload.analysisScope).toEqual({
      startTime: request.candles[0].timestamp,
      endTime: request.candles[167].timestamp,
      candleCount: 168,
    });
    expect(payload.timestampUnit).toBe('UTC Unix seconds');
  });

  it('partitions irregular timestamps into three contiguous groups of 56 actual bars', () => {
    const data = candles(168);
    const { reviewWindows } = buildAnalysisPayload(input(data));
    expect(reviewWindows.map(window => window.label)).toEqual(['前段', '中段', '后段']);
    expect(reviewWindows.map(window => [window.startTime, window.endTime, window.candleCount])).toEqual([
      [data[0].timestamp, data[55].timestamp, 56],
      [data[56].timestamp, data[111].timestamp, 56],
      [data[112].timestamp, data[167].timestamp, 56],
    ]);
    expect(reviewWindows.reduce((total, window) => total + window.candleCount, 0)).toBe(data.length);
    const reviewedTimes = reviewWindows.flatMap(window => data
      .filter(candle => candle.timestamp >= window.startTime && candle.timestamp <= window.endTime)
      .map(candle => candle.timestamp));
    expect(reviewedTimes).toEqual(data.map(candle => candle.timestamp));
    expect(new Set(reviewedTimes).size).toBe(data.length);
  });

  it.each([
    [4, [1, 1, 2]],
    [5, [1, 2, 2]],
    [10, [3, 3, 4]],
    [11, [3, 4, 4]],
  ])('uses floor-based bar boundaries for %i candles', (count, sizes) => {
    const data = candles(count);
    const { reviewWindows } = buildAnalysisPayload(input(data));
    expect(reviewWindows.map(window => window.candleCount)).toEqual(sizes);
    let next = 0;
    for (const window of reviewWindows) {
      expect(window.startTime).toBe(data[next].timestamp);
      expect(window.endTime).toBe(data[next + window.candleCount - 1].timestamp);
      next += window.candleCount;
    }
    expect(next).toBe(count);
  });

  it('reports exact observed extrema and selects the first bar when prices tie', () => {
    const data = candles(168);
    for (const offset of [0, 56, 112]) {
      data[offset + 8].high = data[offset + 19].high = 150.123456789;
      data[offset + 12].low = data[offset + 25].low = 70.987654321;
    }
    const { reviewWindows } = buildAnalysisPayload(input(data));
    reviewWindows.forEach((window, index) => {
      const offset = index * 56;
      expect(window.high).toEqual({ time: data[offset + 8].timestamp, price: data[offset + 8].high });
      expect(window.low).toEqual({ time: data[offset + 12].timestamp, price: data[offset + 12].low });
      expect(data.some(candle => candle.timestamp === window.high.time && candle.high === window.high.price)).toBe(true);
      expect(data.some(candle => candle.timestamp === window.low.time && candle.low === window.low.price)).toBe(true);
    });
  });

  it.each([0, 1, 2])('does not manufacture empty review windows for %i bars', count => {
    const data = candles(count);
    const { analysisScope, reviewWindows } = buildAnalysisPayload(input(data));
    expect(analysisScope).toEqual({ startTime: data[0]?.timestamp ?? null,
      endTime: data.at(-1)?.timestamp ?? null, candleCount: count });
    expect(reviewWindows).toHaveLength(count);
    expect(reviewWindows.map(window => window.candleCount)).toEqual(Array.from({ length: count }, () => 1));
    reviewWindows.forEach((window, index) => {
      expect(window.startTime).toBe(data[index].timestamp);
      expect(window.endTime).toBe(data[index].timestamp);
      expect(window.high).toEqual({ time: data[index].timestamp, price: data[index].high });
      expect(window.low).toEqual({ time: data[index].timestamp, price: data[index].low });
    });
  });

  it('adds orientation context without fabricating model results or forwarding execution inputs', () => {
    const request: ModelInput = { ...input(candles(168)), signal: new AbortController().signal,
      screenshot: { mimeType: 'image/png', base64: 'unused-test-image' } };
    const serialized = JSON.parse(JSON.stringify(buildAnalysisPayload(request)));
    expect(Object.keys(serialized).sort()).toEqual([
      'task', 'timestampUnit', 'candleCloseStatus', 'analysisScope', 'reviewWindows', 'ruleIndicators', 'context', 'candles',
    ].sort());
    expect(serialized).not.toHaveProperty('structures');
    expect(serialized).not.toHaveProperty('priceAction');
    expect(serialized).not.toHaveProperty('tradeSetups');
    expect(serialized).not.toHaveProperty('signal');
    expect(serialized).not.toHaveProperty('screenshot');
    expect(serialized.candles).toEqual(request.candles);
  });

  it('does not mutate frozen candles, context or request', () => {
    const request = input(candles(168));
    const original = structuredClone(request);
    request.candles.forEach(candle => Object.freeze(candle));
    Object.freeze(request.candles);
    Object.freeze(request.context);
    Object.freeze(request);
    expect(() => buildAnalysisPayload(request)).not.toThrow();
    expect(request).toEqual(original);
  });
});
