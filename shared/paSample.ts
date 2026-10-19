import type { Candle } from './market';

/** An intentionally constructed, reproducible OHLCV lesson; never exchange data. */
export function generatePASampleCandles(): Candle[] {
  const start = Date.UTC(2026, 9, 14) / 1000;
  const round = (value: number) => Math.round(value * 100) / 100;
  // Repeated visits to the same boundaries, then a breakout and a retest.
  const anchors = [104, 108, 101, 109, 101, 109, 101, 109, 104, 108, 113, 110, 115, 112, 118, 116];
  let previous = 104;
  const candles: Candle[] = Array.from({ length: 120 }, (_, index) => {
    const segment = Math.floor(index / 8);
    const fraction = (index % 8) / 8;
    const close = round(anchors[segment] + (anchors[segment + 1] - anchors[segment]) * fraction);
    const open = previous;
    previous = close;
    return { timestamp: start + index * 3600, open, high: round(Math.max(open, close) + 0.45),
      low: round(Math.min(open, close) - 0.45), close, volume: round(600 + index % 9 * 65 + Math.abs(close - open) * 230) };
  });
  // Strict local extrema prevent an equal-height plateau from masquerading as a pivot.
  for (const index of [16, 32, 48]) candles[index].low = 100.4;
  for (const index of [24, 40, 56]) candles[index].high = 109.6;
  const replace = (index: number, values: Omit<Candle, 'timestamp' | 'volume'>) => {
    candles[index] = { ...candles[index], ...values };
  };
  // A three-stage breakout through the previously tested ceiling.
  replace(75, { open: 109.1, high: 109.55, low: 108.8, close: 109.4 });
  replace(76, { open: 109.4, high: 109.6, low: 109, close: 109.3 });
  replace(77, { open: 109.1, high: 111.1, low: 108.9, close: 110.8 });
  replace(78, { open: 110.8, high: 111.2, low: 109.45, close: 110.4 });
  replace(79, { open: 110.4, high: 112.7, low: 110.2, close: 112.4 });
  // Candle shapes have exact OHLC evidence and are intentionally near the visible tail.
  replace(103, { open: 115, high: 115.4, low: 112.8, close: 113.3 });
  replace(104, { open: 113.3, high: 114.7, low: 110, close: 114.3 }); // bullish pin
  replace(108, { open: 114.8, high: 115, low: 112.7, close: 113.1 });
  replace(109, { open: 112.9, high: 115.3, low: 112.6, close: 115 }); // bullish engulfing
  replace(113, { open: 115.2, high: 117.2, low: 113.6, close: 116.2 });
  replace(114, { open: 116.1, high: 116.8, low: 114.5, close: 115.4 }); // inside bar
  return candles;
}

export const PA_SAMPLE_CANDLES = generatePASampleCandles();
