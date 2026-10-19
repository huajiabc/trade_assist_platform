import { z } from 'zod';
import { validateCandles, type Candle } from './market';

export const LIVE_INTERVALS = ['5m', '15m', '1h', '4h', '1d'] as const;
export type LiveInterval = typeof LIVE_INTERVALS[number];
export const LIVE_INTERVAL_SECONDS: Record<LiveInterval, number> = {
  '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400,
};
export const liveMarketQuerySchema = z.object({
  symbol: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,20}USDT$/).default('SNDKUSDT'),
  interval: z.enum(LIVE_INTERVALS).default('1h'),
  limit: z.coerce.number().int().min(20).max(500).default(300),
}).strict();
export type LiveMarketQuery = z.infer<typeof liveMarketQuerySchema>;

const metadataSchema = z.object({
  provider: z.literal('binance'),
  market: z.literal('usdt-perpetual'),
  symbol: z.string().regex(/^[A-Z0-9]{2,20}USDT$/),
  interval: z.enum(LIVE_INTERVALS),
  lastCandleClosed: z.boolean(),
  serverTime: z.number().int().positive(),
  fetchedAt: z.string().datetime(),
  warnings: z.array(z.string().max(500)).max(10),
  candles: z.array(z.unknown()).min(10).max(500),
}).strict();

export type MarketSnapshot = Omit<z.infer<typeof metadataSchema>, 'candles'> & { candles: Candle[] };

/** Apply the same OHLCV contract to exchange data before charting or analysis. */
export function validateMarketSnapshot(input: unknown): MarketSnapshot {
  const metadata = metadataSchema.parse(input);
  const candles = validateCandles(metadata.candles);
  const seconds = LIVE_INTERVAL_SECONDS[metadata.interval];
  const now = Math.floor(metadata.serverTime / 1000);
  if (candles.some(c => c.timestamp > now)) throw new Error('交易所返回了晚于服务器时间的 K 线。');
  if (candles.some(c => c.timestamp % seconds !== 0)) throw new Error('交易所 K 线与请求周期的 UTC 边界不一致。');
  const last = candles[candles.length - 1];
  if (metadata.lastCandleClosed !== (last.timestamp + seconds <= now)) throw new Error('末根 K 线收盘状态不一致。');
  return { ...metadata, candles };
}

/** Live, unclosed candles may move; they must never enter confirmed-structure analysis. */
export function closedMarketCandles(snapshot: MarketSnapshot): Candle[] {
  return snapshot.lastCandleClosed ? snapshot.candles : snapshot.candles.slice(0, -1);
}
