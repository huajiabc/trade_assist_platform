import { validateMarketSnapshot, type LiveMarketQuery, type MarketSnapshot } from '../../shared/liveMarket';
import { readResponse } from './api';

export class MarketRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'MarketRequestError'; }
  get retryable() { return [408, 429, 500, 502, 503, 504].includes(this.status); }
}

export async function getMarketCandles(query: LiveMarketQuery, signal: AbortSignal): Promise<MarketSnapshot> {
  const params = new URLSearchParams({ symbol: query.symbol, interval: query.interval, limit: String(query.limit) });
  const response = await fetch(`/api/market/candles?${params}`, { signal });
  let data: unknown;
  try { data = await readResponse(response); }
  catch (error) {
    if (!response.ok) throw new MarketRequestError(response.status, error instanceof Error ? error.message : '行情请求失败。');
    throw error;
  }
  const snapshot = validateMarketSnapshot(data);
  if (snapshot.symbol !== query.symbol || snapshot.interval !== query.interval || snapshot.candles.length > query.limit) {
    throw new Error('返回行情与请求标的或周期不一致，已拒绝显示。');
  }
  return snapshot;
}
