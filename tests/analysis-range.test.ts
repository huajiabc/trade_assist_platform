import { describe, expect, it, vi } from 'vitest';
import type { Candle } from '../shared/market';
import { analysisRangeFromCoordinates, normalizeAnalysisRange, selectAnalysisCandles } from '../src/analysisRange';

const candles: Candle[] = Array.from({ length: 400 }, (_, index) => ({ timestamp: 1_700_000_000 + index * 300, open: 100, high: 103, low: 99, close: 101, volume: 10 }));
const t = (index: number) => candles[index].timestamp;

describe('explicit chart analysis ranges', () => {
  it('normalizes reverse drags to ascending actual candle timestamps', () => {
    expect(normalizeAnalysisRange(candles, { from: t(30), to: t(10) })).toEqual({ from: t(10), to: t(30) });
  });

  it('snaps between candles to nearest real timestamps and clamps external endpoints', () => {
    expect(normalizeAnalysisRange(candles, { from: t(10) + 20, to: t(30) - 20 })).toEqual({ from: t(10), to: t(30) });
    expect(normalizeAnalysisRange(candles, { from: t(0) - 1000, to: t(399) + 1000 })).toEqual({ from: t(0), to: t(399) });
  });

  it('allows a single-bar selection for a visible validation error rather than inventing a minimum range', () => {
    expect(normalizeAnalysisRange(candles, { from: t(7), to: t(7) })).toEqual({ from: t(7), to: t(7) });
    expect(selectAnalysisCandles(candles, { from: t(7), to: t(7) })).toEqual([candles[7]]);
  });

  it('selects both inclusive endpoints exactly without broadening to all loaded candles', () => {
    expect(selectAnalysisCandles(candles, { from: t(11), to: t(29) })).toEqual(candles.slice(11, 30));
    expect(selectAnalysisCandles(candles, { from: t(29), to: t(11) })).toEqual(candles.slice(11, 30));
  });

  it('never silently truncates a manual range larger than the provider limit', () => {
    expect(selectAnalysisCandles(candles, { from: t(0), to: t(399) })).toHaveLength(400);
  });

  it('returns no range when there are no real candles or the endpoints are invalid', () => {
    expect(normalizeAnalysisRange([], { from: 0, to: 1 })).toBeNull();
    expect(normalizeAnalysisRange(candles, { from: NaN, to: t(3) })).toBeNull();
    expect(normalizeAnalysisRange(candles, { from: t(3), to: Infinity })).toBeNull();
    expect(selectAnalysisCandles([], { from: 0, to: 1 })).toEqual([]);
  });

  it('uses the supplied public logical coordinate mapper for forward and reverse drag geometry', () => {
    const coordinateToLogical = vi.fn((x: number) => x / 10);
    expect(analysisRangeFromCoordinates(candles, 103, 299, coordinateToLogical)).toEqual({ from: t(10), to: t(30) });
    expect(analysisRangeFromCoordinates(candles, 299, 103, coordinateToLogical)).toEqual({ from: t(10), to: t(30) });
    expect(coordinateToLogical.mock.calls).toEqual([[103], [299], [299], [103]]);
  });

  it('clamps whitespace beyond the first and last bars without inventing future timestamps', () => {
    expect(analysisRangeFromCoordinates(candles, -30, 5000, x => x / 10)).toEqual({ from: t(0), to: t(399) });
  });

  it('does not infer geometry from unavailable or non-finite chart coordinates', () => {
    expect(analysisRangeFromCoordinates(candles, 0, 100, () => null)).toBeNull();
    expect(analysisRangeFromCoordinates(candles, 0, 100, () => NaN)).toBeNull();
    expect(analysisRangeFromCoordinates([], 0, 100, x => x)).toBeNull();
    expect(analysisRangeFromCoordinates(candles, Infinity, 100, x => x)).toBeNull();
  });

  it('keeps the chart logical origin when selectable closed bars are a subset and excludes the forming tail', () => {
    const selectable = candles.slice(10, -1);
    expect(analysisRangeFromCoordinates(selectable, 0, 3990, x => x / 10, candles)).toEqual({ from: t(10), to: t(398) });
    expect(analysisRangeFromCoordinates(selectable, 120, 300, x => x / 10, candles)).toEqual({ from: t(12), to: t(30) });
  });

  it('maps irregular market gaps through existing logical candles rather than interpolating fabricated timestamps', () => {
    const gapped = [candles[0], candles[2], candles[20], candles[30]];
    expect(analysisRangeFromCoordinates(gapped, 10, 20, x => x / 10)).toEqual({ from: t(2), to: t(20) });
  });
});
