import type { Candle } from '../shared/market';
import { nearestCandleIndex } from './chart/coordinates';

/** Inclusive UTC timestamps of actual candles, never future chart positions. */
export interface AnalysisRange { from: number; to: number }

export function normalizeAnalysisRange(candles: readonly Candle[], range: AnalysisRange): AnalysisRange | null {
  if (!candles.length || !Number.isFinite(range.from) || !Number.isFinite(range.to)) return null;
  const first = nearestCandleIndex(candles, Math.min(range.from, range.to));
  const last = nearestCandleIndex(candles, Math.max(range.from, range.to));
  return { from: candles[first].timestamp, to: candles[last].timestamp };
}

/** Selection never truncates silently; the caller validates its 10–300 bar limit. */
export function selectAnalysisCandles(candles: readonly Candle[], range: AnalysisRange | null): Candle[] {
  if (!range) return [];
  const normalized = normalizeAnalysisRange(candles, range);
  return normalized ? candles.filter((candle) => candle.timestamp >= normalized.from && candle.timestamp <= normalized.to) : [];
}

/** Map via Lightweight Charts' public logical scale, including irregular time gaps.
 * coordinateCandles permits selectableCandles to exclude the forming tail or
 * contain a subset without changing the chart's actual logical index origin.
 */
export function analysisRangeFromCoordinates(
  candles: readonly Candle[], fromX: number, toX: number,
  coordinateToLogical: (x: number) => number | null,
  coordinateCandles: readonly Candle[] = candles,
): AnalysisRange | null {
  if (!candles.length || !coordinateCandles.length || !Number.isFinite(fromX) || !Number.isFinite(toX)) return null;
  const from = coordinateToLogical(fromX), to = coordinateToLogical(toX);
  if (from === null || to === null || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  const at = (logical: number) => coordinateCandles[Math.max(0, Math.min(coordinateCandles.length - 1, Math.round(logical)))].timestamp;
  return normalizeAnalysisRange(candles, { from: at(from), to: at(to) });
}
