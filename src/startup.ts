import { liveMarketQuerySchema, type LiveMarketQuery } from '../shared/liveMarket';

export const DEFAULT_LIVE_QUERY: LiveMarketQuery = { symbol: 'SNDKUSDT', interval: '5m', limit: 300 };

export type Startup =
  | { mode: 'live'; query: LiveMarketQuery; error?: string }
  | { mode: 'demo'; demo: 'smc' | 'pa' };

/** Synthetic data is an explicit, bookmarkable opt-in, never a network fallback. */
export function resolveStartup(search: string): Startup {
  const params = new URLSearchParams(search);
  if (!params.has('live')) {
    const demo = params.get('demo');
    if (demo === 'smc' || demo === 'pa') return { mode: 'demo', demo };
  }
  const parsed = liveMarketQuerySchema.safeParse({
    symbol: params.has('live') ? params.get('live') : DEFAULT_LIVE_QUERY.symbol,
    interval: params.get('interval') || DEFAULT_LIVE_QUERY.interval,
    limit: DEFAULT_LIVE_QUERY.limit,
  });
  return parsed.success
    ? { mode: 'live', query: parsed.data }
    : { mode: 'live', query: { ...DEFAULT_LIVE_QUERY }, error: '行情链接中的标的或周期无效，正在连接默认真实行情 SNDKUSDT · 5M。' };
}
