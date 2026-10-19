import { describe, expect, it } from 'vitest';
import type { LiveMarketQuery, MarketSnapshot } from '../shared/liveMarket';
import { mergeRealtimeKline, realtimeKlineSchema, type RealtimeKline } from '../shared/realtime';
import { reconcileRestSnapshot } from '../src/hooks/useMarketFeed';

const START = Date.UTC(2026, 9, 1) / 1000;
const query: LiveMarketQuery = { symbol: 'SNDKUSDT', interval: '1h', limit: 20 };
const initial = (): MarketSnapshot => ({
  provider: 'binance', market: 'usdt-perpetual', symbol: query.symbol, interval: query.interval,
  candles: Array.from({ length: 20 }, (_, i) => ({ timestamp: START + i * 3600, open: 100, high: 110, low: 95, close: 105, volume: 100 })),
  lastCandleClosed: false, serverTime: (START + 19 * 3600 + 600) * 1000,
  fetchedAt: '2026-10-01T19:10:00.000Z', warnings: [],
});
const tick = (overrides: Partial<RealtimeKline> = {}): RealtimeKline => ({
  symbol: query.symbol, interval: query.interval, eventTime: initial().serverTime + 1000,
  candle: { ...initial().candles.at(-1)!, close: 108, volume: 150 }, closed: false,
  closeTime: (START + 20 * 3600) * 1000 - 1, ...overrides,
});

describe('validated live candle merge', () => {
  it('updates the current OHLCV bar without mutating history', () => {
    const snapshot = initial();
    const merged = mergeRealtimeKline(snapshot, tick(), query)!;
    expect(merged.candles).toHaveLength(20);
    expect(merged.candles.at(-1)).toEqual(tick().candle);
    expect(merged.serverTime).toBe(tick().eventTime);
    expect(snapshot.candles.at(-1)!.close).toBe(105);
    expect(merged.candles[0]).toBe(snapshot.candles[0]);
  });
  it('ignores duplicate or out-of-order exchange events', () => {
    expect(mergeRealtimeKline(initial(), tick(), query, tick().eventTime)).toBeNull();
    expect(mergeRealtimeKline(initial(), tick(), query, tick().eventTime + 1000)).toBeNull();
    const old = tick({ candle: initial().candles.at(-2)!, eventTime: (START + 18 * 3600 + 600) * 1000, closeTime: (START + 19 * 3600) * 1000 - 1 });
    expect(mergeRealtimeKline(initial(), old, query)).toBeNull();
  });
  it('does not reopen a finalized candle', () => {
    expect(mergeRealtimeKline({ ...initial(), lastCandleClosed: true }, tick(), query)).toBeNull();
  });
  it('appends only after the prior close and keeps the bounded rolling history', () => {
    const snapshot = { ...initial(), lastCandleClosed: true };
    const next = tick({ candle: { ...tick().candle, timestamp: START + 20 * 3600 }, eventTime: (START + 20 * 3600) * 1000 + 100, closeTime: (START + 21 * 3600) * 1000 - 1 });
    const merged = mergeRealtimeKline(snapshot, next, query)!;
    expect(merged.candles).toHaveLength(20);
    expect(merged.candles[0].timestamp).toBe(START + 3600);
    expect(merged.candles.at(-1)).toEqual(next.candle);
    expect(merged.lastCandleClosed).toBe(false);
    expect(() => mergeRealtimeKline(initial(), next, query)).toThrow('收盘数据缺失');
  });
  it('requires REST for gaps and rejects wrong markets or malformed candles', () => {
    const gap = tick({ candle: { ...tick().candle, timestamp: START + 21 * 3600 }, eventTime: (START + 21 * 3600) * 1000 + 100, closeTime: (START + 22 * 3600) * 1000 - 1 });
    expect(() => mergeRealtimeKline(initial(), gap, query)).toThrow('时间缺口');
    expect(() => mergeRealtimeKline(initial(), tick({ symbol: 'BTCUSDT' }), query)).toThrow('标的或周期不一致');
    expect(realtimeKlineSchema.safeParse(tick({ candle: { ...tick().candle, high: 80 } })).success).toBe(false);
    expect(realtimeKlineSchema.safeParse(tick({ closeTime: tick().closeTime + 1 })).success).toBe(false);
    expect(realtimeKlineSchema.safeParse(tick({ closed: true })).success).toBe(false);
  });
});

describe('REST and stream race reconciliation', () => {
  it('keeps a tick newer than a cached REST response', () => {
    const snapshot = initial();
    const event = tick();
    const current = mergeRealtimeKline(snapshot, event, query)!;
    const result = reconcileRestSnapshot(snapshot, current, { event, receivedAt: 100 }, query, 200);
    expect(result.candles.at(-1)!.close).toBe(108);
    expect(result.serverTime).toBe(event.eventTime);
  });
  it('reapplies a tick received in flight even if the REST clock is newer', () => {
    const event = tick();
    const incoming = { ...initial(), serverTime: event.eventTime + 500 };
    const result = reconcileRestSnapshot(incoming, initial(), { event, receivedAt: 300 }, query, 200);
    expect(result.candles.at(-1)!.close).toBe(108);
    expect(result.serverTime).toBe(incoming.serverTime);
  });
  it('accepts a newer authoritative REST correction once it is beyond the last tick', () => {
    const event = tick();
    const incoming = { ...initial(), serverTime: event.eventTime + 500 };
    const result = reconcileRestSnapshot(incoming, initial(), { event, receivedAt: 100 }, query, 200);
    expect(result.candles.at(-1)!.close).toBe(105);
  });
  it('does not roll back a newer accepted snapshot when a pending tick still has a gap', () => {
    const current = mergeRealtimeKline(initial(), tick(), query)!;
    const gap = tick({ candle: { ...tick().candle, timestamp: START + 21 * 3600 }, eventTime: (START + 21 * 3600) * 1000 + 100, closeTime: (START + 22 * 3600) * 1000 - 1 });
    expect(reconcileRestSnapshot(initial(), current, { event: gap, receivedAt: 300 }, query, 200)).toBe(current);
  });
  it('resolves a pending new-bar tick once REST supplies the missing previous close', () => {
    const snapshot = { ...initial(), lastCandleClosed: true, serverTime: (START + 20 * 3600) * 1000 };
    const next = tick({ candle: { ...tick().candle, timestamp: START + 20 * 3600 }, eventTime: snapshot.serverTime + 100, closeTime: (START + 21 * 3600) * 1000 - 1 });
    const result = reconcileRestSnapshot(snapshot, null, { event: next, receivedAt: 300 }, query, 200);
    expect(result.candles.at(-1)).toEqual(next.candle);
    expect(result.lastCandleClosed).toBe(false);
  });
});
