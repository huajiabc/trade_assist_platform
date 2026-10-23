import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveMarketQuery, MarketSnapshot } from '../../shared/liveMarket';
import { mergeRealtimeKline, realtimeKlineSchema, streamStatusSchema, type FeedTransport, type RealtimeKline } from '../../shared/realtime';
import { getMarketCandles, MarketRequestError } from '../services/market';

export interface ReceivedKline { event: RealtimeKline; receivedAt: number }
const sameMarket = (snapshot: MarketSnapshot, query: LiveMarketQuery) => snapshot.symbol === query.symbol && snapshot.interval === query.interval;

/** Reapply a tick arriving during REST and never roll a newer snapshot back to
 * an older cached clock. Missing candles must come from REST, never invention. */
export function reconcileRestSnapshot(rest: MarketSnapshot, current: MarketSnapshot | null, latest: ReceivedKline | null, query: LiveMarketQuery, requestStarted: number): MarketSnapshot {
  let result = rest;
  if (latest && (latest.event.eventTime > rest.serverTime || latest.receivedAt >= requestStarted)) {
    try {
      const merged = mergeRealtimeKline(rest, latest.event, query);
      if (merged) result = { ...merged, serverTime: Math.max(rest.serverTime, merged.serverTime) };
    } catch { /* A pending gap still needs authoritative REST history. */ }
  }
  if (current && sameMarket(current, query) && current.serverTime > result.serverTime) return current;
  return result;
}

export function useMarketFeed(onSnapshot: (snapshot: MarketSnapshot, reason: 'connect' | 'refresh' | 'stream') => void) {
  const [query, setQuery] = useState<LiveMarketQuery | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [retryInitial, setRetryInitial] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [transport, setTransport] = useState<FeedTransport>('idle');
  const [lastEventTime, setLastEventTime] = useState(0);
  const [lastReceivedAt, setLastReceivedAt] = useState(0);
  const [streamMessage, setStreamMessage] = useState('');
  const callbackRef = useRef(onSnapshot);
  callbackRef.current = onSnapshot;
  const activeQuery = useRef<LiveMarketQuery | null>(null);
  const snapshotRef = useRef<MarketSnapshot | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const sessionVersion = useRef(0);
  const requestVersion = useRef(0);
  const latestTick = useRef<ReceivedKline | null>(null);
  const acceptedEventTime = useRef(0);
  const heartbeatAt = useRef(0);
  const restAttemptAt = useRef(0);
  const gapAttemptAt = useRef(0);
  const transportRef = useRef<FeedTransport>('idle');
  const autoRefreshRef = useRef(autoRefresh);
  autoRefreshRef.current = autoRefresh;

  const updateTransport = useCallback((value: FeedTransport, message: string) => {
    transportRef.current = value;
    setTransport(value);
    setStreamMessage(message);
  }, []);

  const request = useCallback(async (nextQuery: LiveMarketQuery, reason: 'connect' | 'refresh') => {
    if (reason === 'refresh' && controllerRef.current) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const version = ++requestVersion.current;
    const session = sessionVersion.current;
    const started = Date.now();
    restAttemptAt.current = started;
    setError('');
    setRetryInitial(false);
    if (reason === 'connect') { setLoading(true); updateTransport('connecting', '正在加载初始 K 线…'); } else setRefreshing(true);
    const timeout = window.setTimeout(() => controller.abort('timeout'), 15_000);
    try {
      const incoming = await getMarketCandles(nextQuery, controller.signal);
      if (controller.signal.aborted || version !== requestVersion.current || session !== sessionVersion.current) return;
      const snapshot = reconcileRestSnapshot(incoming, snapshotRef.current, latestTick.current, nextQuery, started);
      snapshotRef.current = snapshot;
      setQuery(current => current ?? nextQuery);
      callbackRef.current(snapshot, reason);
    } catch (e) {
      if (version !== requestVersion.current || session !== sessionVersion.current) return;
      if (controller.signal.reason === 'timeout') setError('行情请求超时，请检查服务端网络或 MARKET_PROXY_URL 后重试。');
      else if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '行情加载失败，请重试。');
      if (!snapshotRef.current && (!controller.signal.aborted || controller.signal.reason === 'timeout')) {
        const retryable = controller.signal.reason === 'timeout' || (e instanceof MarketRequestError ? e.retryable : e instanceof TypeError);
        setRetryInitial(retryable);
        updateTransport(retryable ? 'fallback' : 'idle', retryable ? '初始行情连接失败，启用实时更新时每30秒自动重试；也可点击加载行情。' : '');
      }
    } finally {
      window.clearTimeout(timeout);
      if (version === requestVersion.current && session === sessionVersion.current) { controllerRef.current = null; setLoading(false); setRefreshing(false); }
    }
  }, [updateTransport]);

  const connect = useCallback((nextQuery: LiveMarketQuery) => {
    sessionVersion.current++;
    sourceRef.current?.close(); sourceRef.current = null;
    controllerRef.current?.abort(); controllerRef.current = null;
    activeQuery.current = nextQuery; snapshotRef.current = null; latestTick.current = null;
    acceptedEventTime.current = 0; heartbeatAt.current = 0; gapAttemptAt.current = 0;
    setLastEventTime(0); setLastReceivedAt(0); setQuery(null);
    updateTransport('connecting', '正在加载初始 K 线…');
    void request(nextQuery, 'connect');
  }, [request, updateTransport]);
  const refresh = useCallback(() => {
    if (activeQuery.current) void request(activeQuery.current, 'refresh');
  }, [request]);
  const stop = useCallback(() => {
    sessionVersion.current++; requestVersion.current++;
    controllerRef.current?.abort(); controllerRef.current = null;
    sourceRef.current?.close(); sourceRef.current = null;
    activeQuery.current = null; snapshotRef.current = null; latestTick.current = null;
    acceptedEventTime.current = 0; heartbeatAt.current = 0;
    setQuery(null); setLoading(false); setRefreshing(false); setError(''); setRetryInitial(false);
    setLastEventTime(0); setLastReceivedAt(0);
    updateTransport('idle', '');
  }, [updateTransport]);

  // The streaming monitor starts only after a valid snapshot. Initial failures
  // need a separate bounded retry, without opening a stream or fabricating data.
  useEffect(() => {
    if (!retryInitial || query || loading || !autoRefresh || !activeQuery.current) return;
    const pending = activeQuery.current, session = sessionVersion.current;
    const timer = window.setInterval(() => {
      if (session !== sessionVersion.current || !autoRefreshRef.current || snapshotRef.current || controllerRef.current || document.visibilityState !== 'visible') return;
      void request(pending, 'connect');
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [retryInitial, query, loading, autoRefresh, request]);

  useEffect(() => {
    if (!query) return;
    if (!autoRefresh) { updateTransport('paused', '实时更新已暂停；可以手动刷新。'); return; }
    const session = sessionVersion.current;
    const params = new URLSearchParams({ symbol: query.symbol, interval: query.interval, limit: String(query.limit) });
    const source = new EventSource('/api/market/stream?' + params);
    sourceRef.current = source;
    heartbeatAt.current = Date.now();
    updateTransport('connecting', '正在连接交易所实时推送…');
    const active = () => session === sessionVersion.current && sourceRef.current === source && autoRefreshRef.current;
    const fallback = (message: string) => { if (active()) updateTransport('fallback', message); };
    source.addEventListener('status', (message) => {
      if (!active()) return;
      try {
        const status = streamStatusSchema.parse(JSON.parse((message as MessageEvent<string>).data));
        if (status.state === 'reconnecting' || status.state === 'error') fallback(status.message);
        else if (transportRef.current !== 'streaming') setStreamMessage(status.state === 'connected' ? '已连接上游，等待有效行情更新…' : status.message);
      } catch { fallback('实时连接状态无效，暂以定时刷新保持行情。'); }
    });
    source.addEventListener('kline', (message) => {
      if (!active() || !snapshotRef.current) return;
      try {
        const event = realtimeKlineSchema.parse(JSON.parse((message as MessageEvent<string>).data));
        if (event.symbol !== query.symbol || event.interval !== query.interval) return;
        if (event.eventTime <= acceptedEventTime.current || event.eventTime <= snapshotRef.current.serverTime) return;
        const receivedAt = Date.now();
        if (!latestTick.current || event.eventTime > latestTick.current.event.eventTime) latestTick.current = { event, receivedAt };
        const snapshot = mergeRealtimeKline(snapshotRef.current, event, query, acceptedEventTime.current);
        if (!snapshot) return;
        snapshotRef.current = snapshot;
        acceptedEventTime.current = event.eventTime; heartbeatAt.current = receivedAt;
        setLastEventTime(event.eventTime); setLastReceivedAt(receivedAt); setError('');
        updateTransport('streaming', '交易所实时 K 线推送正常');
        callbackRef.current(snapshot, 'stream');
      } catch {
        fallback('实时行情尚未同步或校验失败，正在重新获取完整 K 线。');
        // Several ticks may report the same gap before REST catches up. Keep
        // that burst from creating one reconciliation request per 250 ms tick.
        if (Date.now() - gapAttemptAt.current >= 2_000) {
          gapAttemptAt.current = Date.now();
          void request(query, 'refresh');
        }
      }
    });
    source.onerror = () => fallback('实时推送连接中断，自动重连中；暂以每 30 秒刷新保持行情。');
    // An SSE open alone is not evidence of a working exchange feed.
    const monitor = window.setInterval(() => {
      if (!active() || document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - heartbeatAt.current >= 15_000 && transportRef.current !== 'fallback') fallback('超过 15 秒未收到有效实时更新；暂以每 30 秒刷新保持行情。');
      const cadence = transportRef.current === 'streaming' ? 60_000 : 30_000;
      if (now - restAttemptAt.current >= cadence) void request(query, 'refresh');
    }, 1_000);
    const reconcileVisible = () => { if (active() && document.visibilityState === 'visible') void request(query, 'refresh'); };
    document.addEventListener('visibilitychange', reconcileVisible);
    return () => {
      source.close();
      if (sourceRef.current === source) sourceRef.current = null;
      window.clearInterval(monitor);
      document.removeEventListener('visibilitychange', reconcileVisible);
    };
  }, [query, autoRefresh, request, updateTransport]);
  useEffect(() => () => {
    sessionVersion.current++; requestVersion.current++;
    controllerRef.current?.abort(); sourceRef.current?.close();
  }, []);
  return { query, loading, refreshing, error, autoRefresh, setAutoRefresh, connect, refresh, stop, transport, lastEventTime, lastReceivedAt, streamMessage };
}
