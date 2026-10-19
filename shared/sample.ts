import type { Candle } from './market';

/** Reproducible synthetic market, never presented as exchange or historical data. */
export function generateSampleCandles(): Candle[] {
  const anchors = [62000, 63800, 62600, 65100, 63700, 66400, 64600, 67600, 65000, 63600, 64700, 61600, 63400, 60700, 62500, 60100, 62600, 61300, 64100];
  const start = Date.UTC(2026, 9, 10, 0, 0, 0) / 1_000;
  let state = 42071;
  const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
  const round = (value: number) => Math.round(value * 100) / 100;
  let previous = anchors[0] - 50;
  return Array.from({ length: 180 }, (_, index) => {
    const segment = Math.floor(index / 10);
    const fraction = (index % 10) / 10;
    const base = anchors[segment] + (anchors[segment + 1] - anchors[segment]) * fraction;
    const close = round(base + (random() - 0.5) * 120);
    // Occasional deterministic opening gaps make three-candle FVGs easy to inspect.
    const gap = index % 37 === 12 ? (close > previous ? 160 : -160) : 0;
    const open = round(previous + gap + (random() - 0.5) * 36);
    const high = round(Math.max(open, close) + 35 + random() * 75);
    const low = round(Math.min(open, close) - 35 - random() * 75);
    previous = close;
    return { timestamp: start + index * 3_600, open, high, low, close, volume: round(80 + random() * 210 + Math.abs(close - open) * 0.21) };
  });
}

export const SAMPLE_CANDLES = generateSampleCandles();
