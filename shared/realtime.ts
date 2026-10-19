import { z } from 'zod';
import { LIVE_INTERVALS, LIVE_INTERVAL_SECONDS, type LiveMarketQuery, type MarketSnapshot } from './liveMarket';
import type { Candle } from './market';

const candleSchema = z.object({
  timestamp: z.number().int().nonnegative(),
  open: z.number().finite().positive().max(1e12), high: z.number().finite().positive().max(1e12),
  low: z.number().finite().positive().max(1e12), close: z.number().finite().positive().max(1e12),
  volume: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict().refine(c => c.high >= Math.max(c.open, c.close, c.low) && c.low <= Math.min(c.open, c.close, c.high), 'OHLC 数据不一致');

export const realtimeKlineSchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9]{2,20}USDT$/), interval: z.enum(LIVE_INTERVALS),
  eventTime: z.number().int().positive(), candle: candleSchema,
  closed: z.boolean(), closeTime: z.number().int().positive(),
}).strict().superRefine((event, ctx) => {
  const interval = LIVE_INTERVAL_SECONDS[event.interval];
  if (event.candle.timestamp % interval !== 0 || event.closeTime !== (event.candle.timestamp + interval) * 1000 - 1) ctx.addIssue({ code: 'custom', message: '实时 K 线周期边界不一致' });
  if (event.eventTime < event.candle.timestamp * 1000 || (event.closed && event.eventTime <= event.closeTime) || (!event.closed && event.eventTime > event.closeTime + 1000)) ctx.addIssue({ code: 'custom', message: '实时 K 线收盘状态或事件时间不一致' });
});
export type RealtimeKline = z.infer<typeof realtimeKlineSchema>;
export const streamStatusSchema = z.object({ state: z.enum(['connecting', 'connected', 'reconnecting', 'error']), message: z.string().max(300) }).strict();
export type StreamStatus = z.infer<typeof streamStatusSchema>;
export type FeedTransport = 'idle' | 'connecting' | 'streaming' | 'fallback' | 'paused';

/** Ignore old ticks; require REST reconciliation for a missing interval instead of inventing candles. */
export function mergeRealtimeKline(snapshot: MarketSnapshot, raw: unknown, query: LiveMarketQuery, previousEventTime = 0): MarketSnapshot | null {
  const event = realtimeKlineSchema.parse(raw);
  if (event.symbol !== query.symbol || event.interval !== query.interval || snapshot.symbol !== event.symbol || snapshot.interval !== event.interval) throw new Error('实时行情标的或周期不一致');
  if (event.eventTime <= previousEventTime) return null;
  const last = snapshot.candles[snapshot.candles.length - 1];
  if (event.candle.timestamp < last.timestamp) return null;
  if (event.candle.timestamp > last.timestamp + LIVE_INTERVAL_SECONDS[event.interval]) throw new Error('实时行情存在时间缺口，正在重新同步');
  if (event.candle.timestamp === last.timestamp && snapshot.lastCandleClosed && !event.closed) return null;
  const candles: Candle[] = event.candle.timestamp === last.timestamp
    ? [...snapshot.candles.slice(0, -1), event.candle]
    : [...snapshot.candles, event.candle].slice(-query.limit);
  // A new candle can only append after the previous candle has been finalized.
  if (event.candle.timestamp > last.timestamp && !snapshot.lastCandleClosed) throw new Error('前一根收盘数据缺失，正在重新同步');
  return { ...snapshot, candles, lastCandleClosed: event.closed, serverTime: event.eventTime, fetchedAt: new Date().toISOString() };
}
