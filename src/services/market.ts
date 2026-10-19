import { validateMarketSnapshot, type LiveMarketQuery, type MarketSnapshot } from '../../shared/liveMarket';
import { readResponse } from './api';

export async function getMarketCandles(query: LiveMarketQuery, signal: AbortSignal): Promise<MarketSnapshot> {
  const params = new URLSearchParams({ symbol: query.symbol, interval: query.interval, limit: String(query.limit) });
  const response = await fetch(`/api/market/candles?${params}`, { signal });
  const snapshot = validateMarketSnapshot(await readResponse(response));
  if (snapshot.symbol !== query.symbol || snapshot.interval !== query.interval || snapshot.candles.length > query.limit) {
    throw new Error('返回行情与请求标的或周期不一致，已拒绝显示。');
  }
  return snapshot;
}
