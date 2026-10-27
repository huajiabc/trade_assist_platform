import { describe, expect, it } from 'vitest';
import { frame, AS_OF } from './research-fixtures';
import { normalizeFrame } from '../shared/researchData';
import type { MarketSnapshot } from '../shared/liveMarket';
import { positionChartFeed, positionFactsFrame } from '../src/chart/positionFeed';

function fixture() {
  const source = frame('1m'), market: MarketSnapshot = { provider: 'binance', market: 'usdt-perpetual', symbol: source.symbol,
    interval: '1m', lastCandleClosed: false, serverTime: (AS_OF + 20) * 1000, fetchedAt: new Date().toISOString(), warnings: [],
    candles: [...source.candles, { timestamp: AS_OF, open: 100, close: 123.45, high: 124, low: 99, volume: 1 }] };
  return { market, view: { frame: normalizeFrame(frame('5m'), AS_OF), position: { historical: false } } };
}
describe('current position chart follows the existing public feed', () => {
  it('plots the live forming bar but computes facts only from closed candles', () => {
    const { view, market } = fixture(), selected = positionChartFeed(view, market), facts = positionFactsFrame(view, market)!;
    expect(selected.candles).toBe(market.candles); expect(selected.timeframe).toBe('1m');
    expect(selected.candles.at(-1)!.close).toBe(123.45); expect(facts.timeframe).toBe('1m');
    expect(facts.candles).toEqual(market.candles.slice(0, -1)); expect(facts.lastClosedTime).toBe(AS_OF - 60);
  });
  it('updates the displayed quote without invalidating unchanged closed-bar facts', () => {
    const { view, market } = fixture(), next = { ...market, serverTime: market.serverTime + 1000,
      candles: market.candles.map((c, i) => i === market.candles.length - 1 ? { ...c, close: 123.6 } : c) };
    expect(positionChartFeed(view, next).factsKey).toBe(positionChartFeed(view, market).factsKey);
    expect(positionChartFeed(view, next).candles.at(-1)!.close).toBe(123.6);
    const revised = { ...next, candles: next.candles.map((c, i) => i === 4 ? { ...c, volume: 2 } : c) };
    expect(positionChartFeed(view, revised).factsKey).not.toBe(positionChartFeed(view, next).factsKey);
  });
  it('keeps an explicitly selected historical review and ordinary research snapshots frozen', () => {
    const { view, market } = fixture();
    for (const frozen of [{ ...view, position: { historical: true } }, { frame: view.frame }]) {
      expect(positionChartFeed(frozen, market).live).toBeNull(); expect(positionChartFeed(frozen, market).candles).toBe(view.frame.candles);
      expect(positionFactsFrame(frozen, market)).toBe(view.frame);
    }
  });
  it('never substitutes another symbol or labels 5m facts as a higher chart period', () => {
    const { view, market } = fixture();
    expect(positionChartFeed(view, { ...market, symbol: 'BTCUSDT' }).live).toBeNull();
    const higher = { ...market, interval: '1h' as const };
    expect(positionChartFeed(view, higher).timeframe).toBe('1h'); expect(positionFactsFrame(view, higher)).toBeNull();
    expect(positionChartFeed(view, null).candles).toBe(view.frame.candles);
  });
});
