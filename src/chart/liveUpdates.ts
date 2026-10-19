import type { Candle } from '../../shared/market';

export interface LogicalWindow {
  from: number;
  to: number;
}

const candleMatches = (a: Candle, b: Candle) => a.timestamp === b.timestamp
  && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume;

/** Streaming ticks normally change only the last bar. Never replace all series
 * data in that case: update() keeps the user's viewport and crosshair stable.
 * History corrections and rolling windows still require a full replacement. */
export function candleUpdatePlan(previous: readonly Candle[], next: readonly Candle[]):
  { kind: 'replace' } | { kind: 'none' } | { kind: 'tail'; from: number } {
  if (!previous.length || next.length < previous.length) return { kind: 'replace' };
  for (let i = 0; i < previous.length - 1; i++) {
    if (!candleMatches(previous[i], next[i])) return { kind: 'replace' };
  }
  const last = previous.length - 1;
  if (previous[last].timestamp !== next[last].timestamp) return { kind: 'replace' };
  const tailChanged = !candleMatches(previous[last], next[last]);
  if (!tailChanged && next.length === previous.length) return { kind: 'none' };
  return { kind: 'tail', from: tailChanged ? last : previous.length };
}

/** Readable bodies on initial load, with room to the right of the current bar. */
export function latestCandleWindow(count: number, visibleBars = 110): LogicalWindow | null {
  if (count < 1) return null;
  return { from: Math.max(0, count - visibleBars), to: count - 1 + 6 };
}

/** Keep a polled/rolling candle window anchored to the same bars after setData. */
export function preserveLogicalWindow(
  previous: readonly Candle[],
  next: readonly Candle[],
  range: LogicalWindow | null,
): LogicalWindow | null {
  if (!range || previous.length === 0 || next.length === 0) return null;
  const width = range.to - range.from;
  if (!Number.isFinite(width) || width <= 0) return null;

  // A viewport containing the latest candle follows new bars while keeping its
  // current zoom and right-side whitespace. A historical viewport stays put.
  if (range.to >= previous.length - 1 - 0.5) {
    const advance = next.length - previous.length;
    return { from: range.from + advance, to: range.to + advance };
  }

  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < previous.length && newIndex < next.length) {
    const oldTime = previous[oldIndex].timestamp;
    const newTime = next[newIndex].timestamp;
    if (oldTime === newTime) {
      const offset = newIndex - oldIndex;
      const from = range.from + offset;
      const to = range.to + offset;
      // The user may be viewing bars that have entirely left the rolling
      // window. Show the earliest available bars instead of a blank viewport.
      if (to < 0) return { from: 0, to: width };
      if (from > next.length - 1) return { from: next.length - 1 - width, to: next.length - 1 };
      return { from, to };
    }
    if (oldTime < newTime) oldIndex++;
    else newIndex++;
  }
  return null;
}
