import { describe, expect, it } from 'vitest';
import type { Candle } from '../shared/market';
import { candleUpdatePlan, latestCandleWindow } from '../src/chart/liveUpdates';
import { reserveLabel } from '../src/chart/labelLayout';

const candles: Candle[] = Array.from({ length: 4 }, (_, index) => ({
  timestamp: 1_700_000_000 + index * 60, open: 100, high: 105, low: 98, close: 101, volume: 50,
}));

describe('streaming chart series updates', () => {
  it('updates only the in-progress bar and includes appended bars', () => {
    const tick = candles.map((candle, index) => index === 3 ? { ...candle, close: 102, volume: 80 } : { ...candle });
    expect(candleUpdatePlan(candles, tick)).toEqual({ kind: 'tail', from: 3 });
    const appended = [...tick, { ...tick[3], timestamp: tick[3].timestamp + 60 }];
    expect(candleUpdatePlan(candles, appended)).toEqual({ kind: 'tail', from: 3 });
    expect(candleUpdatePlan(tick, appended)).toEqual({ kind: 'tail', from: 4 });
  });
  it('does not call setData or update for unchanged stream snapshots', () => {
    expect(candleUpdatePlan(candles, candles.map((candle) => ({ ...candle })))).toEqual({ kind: 'none' });
  });
  it('replaces series for history corrections, rolling windows and new datasets', () => {
    expect(candleUpdatePlan(candles, candles.map((candle, index) => index === 1 ? { ...candle, high: 106 } : candle))).toEqual({ kind: 'replace' });
    expect(candleUpdatePlan(candles, [...candles.slice(1), { ...candles[3], timestamp: candles[3].timestamp + 60 }])).toEqual({ kind: 'replace' });
    expect(candleUpdatePlan(candles, candles.slice(0, 2))).toEqual({ kind: 'replace' });
    expect(candleUpdatePlan([], candles)).toEqual({ kind: 'replace' });
    expect(candleUpdatePlan([candles[0]], [candles[1]])).toEqual({ kind: 'replace' });
  });
  it('shows readable recent candles with right whitespace on load and reset', () => {
    expect(latestCandleWindow(300)).toEqual({ from: 190, to: 305 });
    expect(latestCandleWindow(40)).toEqual({ from: 0, to: 45 });
    expect(latestCandleWindow(0)).toBeNull();
  });
});

describe('annotation label collisions', () => {
  it('suppresses overlapping text without mutating original boxes', () => {
    const occupied = [{ left: 10, top: 20, width: 30, height: 14 }];
    const overlapping = { left: 30, top: 22, width: 25, height: 14 };
    expect(reserveLabel(overlapping, occupied)).toBe(false);
    expect(occupied).toHaveLength(1);
    expect(overlapping).toEqual({ left: 30, top: 22, width: 25, height: 14 });
    expect(reserveLabel({ left: 46, top: 20, width: 20, height: 14 }, occupied)).toBe(true);
  });
  it('always retains the selected structure label', () => {
    const occupied = [{ left: 10, top: 20, width: 30, height: 14 }];
    expect(reserveLabel({ left: 10, top: 20, width: 30, height: 14 }, occupied, true)).toBe(true);
    expect(occupied).toHaveLength(2);
  });
});
