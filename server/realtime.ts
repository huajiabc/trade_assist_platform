import type { RequestHandler } from 'express';
import type { EventEmitter } from 'node:events';
import WebSocket, { type ClientOptions, type RawData } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { z } from 'zod';
import { LIVE_INTERVAL_SECONDS, liveMarketQuerySchema, type LiveMarketQuery } from '../shared/liveMarket';
import { realtimeKlineSchema, type RealtimeKline, type StreamStatus } from '../shared/realtime';
import { PublicError } from './errors';

export interface MarketStreamObserver {
  onStatus(status: StreamStatus): void;
  onKline(kline: RealtimeKline): void;
}

/** A read-only subscription; disposing it must release timers and the upstream socket. */
export interface RealtimeMarketProvider {
  subscribe(query: LiveMarketQuery, observer: MarketStreamObserver): () => void;
}

export interface MarketSocket extends Pick<EventEmitter, 'on' | 'removeListener'> {
  terminate(): void;
}
export type MarketSocketFactory = (url: string, options: ClientOptions) => MarketSocket;

const MAX_FRAME_BYTES = 65_536;
const MAX_BUFFER_BYTES = 262_144;
const CLOCK_TOLERANCE_MS = 60_000;
const safeTime = z.number().int().nonnegative().max(4_102_444_800_000);
const decimalString = z.string().max(80).regex(/^\d+(?:\.\d+)?$/);
const upstreamSchema = z.object({
  e: z.literal('kline'), E: safeTime, s: z.string(),
  k: z.object({
    t: safeTime, T: safeTime, s: z.string(), i: z.string(),
    o: decimalString, h: decimalString, l: decimalString,
    c: decimalString, v: decimalString, x: z.boolean(),
  }),
});

/** Parse exchange JSON before forwarding. Times are milliseconds upstream, UTC seconds in candles. */
export function parseBinanceKline(input: unknown, query: LiveMarketQuery, now = Date.now()): RealtimeKline {
  const data = upstreamSchema.parse(input);
  const { k } = data;
  const intervalMs = LIVE_INTERVAL_SECONDS[query.interval] * 1_000;
  if (data.s !== query.symbol || k.s !== query.symbol || k.i !== query.interval ||
      k.t % intervalMs !== 0 || k.T !== k.t + intervalMs - 1 ||
      data.E < k.t || Math.abs(now - data.E) > CLOCK_TOLERANCE_MS ||
      (k.x ? data.E <= k.T || data.E > k.T + CLOCK_TOLERANCE_MS : data.E > k.T + 1_000)) {
    throw new Error('Invalid market event coordinates or clock.');
  }
  const candle = {
    timestamp: k.t / 1_000, open: Number(k.o), high: Number(k.h),
    low: Number(k.l), close: Number(k.c), volume: Number(k.v),
  };
  if ([candle.open, candle.high, candle.low, candle.close].some(price => !Number.isFinite(price) || price <= 0 || price > 1_000_000_000_000) ||
      !Number.isFinite(candle.volume) || candle.volume < 0 || candle.volume > Number.MAX_SAFE_INTEGER ||
      candle.high < Math.max(candle.open, candle.close, candle.low) ||
      candle.low > Math.min(candle.open, candle.close, candle.high)) {
    throw new Error('Invalid market event OHLCV.');
  }
  return realtimeKlineSchema.parse({ symbol: query.symbol, interval: query.interval, eventTime: data.E, candle, closed: k.x, closeTime: k.T });
}

/** Explicit market-only proxy. Its URL never reaches the browser or AI provider. */
export const createBinanceSocket: MarketSocketFactory = (url, options) => {
  const configured = process.env.MARKET_PROXY_URL?.trim();
  if (!configured) return new WebSocket(url, options);
  let proxy: URL;
  try {
    proxy = new URL(configured);
    if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password || proxy.search || proxy.hash) throw new Error('Invalid proxy');
  } catch {
    throw new PublicError(503, 'MARKET_PROXY_INVALID', '行情代理配置无效，请检查服务端 MARKET_PROXY_URL（仅支持 HTTP/HTTPS）。');
  }
  const agent = new HttpsProxyAgent(proxy);
  const socket = new WebSocket(url, { ...options, agent });
  socket.once('close', () => { agent.destroy(); });
  return socket;
};

interface RealtimeTiming {
  staleMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  now: () => number;
}

/** Binance's current market stream endpoint; ws answers protocol ping frames automatically. */
export class BinanceRealtimeProvider implements RealtimeMarketProvider {
  private readonly timing: RealtimeTiming;

  constructor(private readonly socketFactory: MarketSocketFactory = createBinanceSocket, timing: Partial<RealtimeTiming> = {}) {
    this.timing = { staleMs: 15_000, retryBaseMs: 1_000, retryMaxMs: 15_000, now: Date.now, ...timing };
  }

  subscribe(query: LiveMarketQuery, observer: MarketStreamObserver): () => void {
    // Keep the upstream host and path under server control even for direct adapter users.
    const checked = liveMarketQuerySchema.parse(query);
    const url = `wss://fstream.binance.com/market/ws/${checked.symbol.toLowerCase()}@kline_${checked.interval}`;
    let disposed = false;
    let socket: MarketSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let lastEventTime = -1;
    let detachSocketListeners = () => {};

    const destroySocket = () => {
      clearTimeout(staleTimer);
      staleTimer = undefined;
      const old = socket;
      socket = null;
      if (old) {
        detachSocketListeners();
        detachSocketListeners = () => {};
        // Terminating a CONNECTING ws can asynchronously emit an error.
        old.on('error', () => {});
        old.terminate();
      }
    };

    const reconnect = (message: string) => {
      if (disposed || retryTimer) return;
      destroySocket();
      observer.onStatus({ state: 'error', message });
      const delay = Math.min(this.timing.retryMaxMs, this.timing.retryBaseMs * 2 ** Math.min(attempts++, 10));
      observer.onStatus({ state: 'reconnecting', message: `实时连接中断，${Math.ceil(delay / 1_000)} 秒后重试；暂用历史行情同步。` });
      retryTimer = setTimeout(() => { retryTimer = undefined; connect(); }, delay);
      retryTimer.unref?.();
    };

    const armWatchdog = () => {
      clearTimeout(staleTimer);
      staleTimer = setTimeout(() => reconnect('超过 15 秒未收到有效行情，实时连接已标为过期。'), this.timing.staleMs);
      staleTimer.unref?.();
    };

    const connect = () => {
      if (disposed) return;
      observer.onStatus({ state: attempts ? 'reconnecting' : 'connecting', message: '正在连接 Binance 实时 K 线流…' });
      let current: MarketSocket;
      let connected = false;
      try {
        current = this.socketFactory(url, { handshakeTimeout: 10_000, maxPayload: MAX_FRAME_BYTES, followRedirects: false, perMessageDeflate: false });
        socket = current;
      } catch (error) {
        reconnect(error instanceof PublicError ? error.message : '无法连接实时行情服务，请检查服务端网络。');
        return;
      }
      armWatchdog();
      // A successful handshake is not evidence that this symbol is delivering prices.
      const onMessage = (raw: RawData, binary: boolean) => {
        if (disposed || socket !== current) return;
        try {
          const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
          if (binary || bytes.length > MAX_FRAME_BYTES) throw new Error('Unsupported market frame.');
          const event = parseBinanceKline(JSON.parse(bytes.toString('utf8')) as unknown, checked, this.timing.now());
          // A replay or out-of-order event cannot refresh the connection's freshness.
          if (event.eventTime <= lastEventTime) return;
          lastEventTime = event.eventTime;
          armWatchdog();
          if (!connected) {
            connected = true;
            attempts = 0;
            observer.onStatus({ state: 'connected', message: 'Binance 实时 K 线已连接。' });
          }
          observer.onKline(event);
        } catch {
          reconnect('实时行情未通过数据校验，已拒绝该更新并重新连接。');
        }
      };
      const onError = () => { if (socket === current) reconnect('实时行情连接失败，请检查服务端网络。'); };
      const onClose = () => { if (socket === current) reconnect('交易所关闭了实时行情连接。'); };
      current.on('message', onMessage);
      current.on('error', onError);
      current.on('close', onClose);
      detachSocketListeners = () => {
        current.removeListener('message', onMessage);
        current.removeListener('error', onError);
        current.removeListener('close', onClose);
      };
    };

    connect();
    return () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(retryTimer);
      retryTimer = undefined;
      destroySocket();
    };
  }
}

/** Same-origin SSE bridge; one bounded upstream subscription per attached local tab. */
export function createMarketStreamHandler(provider: RealtimeMarketProvider, maxClients = 8): RequestHandler {
  let clients = 0;
  return (request, response) => {
    const parsed = liveMarketQuerySchema.safeParse(request.query);
    if (!parsed.success) throw new PublicError(400, 'MARKET_QUERY_INVALID', '实时行情参数无效：需为 USDT 交易对，周期支持 1m、5m、15m、1h、4h、1d。');
    if (clients >= maxClients) throw new PublicError(503, 'MARKET_STREAM_BUSY', '实时连接数量已达上限，请关闭多余行情页面后重试。');
    clients += 1;
    response.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      clients -= 1;
      clearInterval(heartbeat);
      unsubscribe?.();
      if (!response.writableEnded) response.end();
    };
    response.on('close', dispose);
    response.on('error', dispose);
    const write = (data: string) => {
      if (disposed) return;
      if (response.destroyed || response.writableLength > MAX_BUFFER_BYTES) { dispose(); return; }
      try { response.write(data); } catch { dispose(); }
    };
    const send = (event: 'status' | 'kline', value: StreamStatus | RealtimeKline) => write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
    write('retry: 3000\n\n');
    try {
      unsubscribe = provider.subscribe(parsed.data, {
        onStatus: status => send('status', status),
        onKline: candle => send('kline', candle),
      });
      if (disposed) { unsubscribe(); return; }
    } catch {
      send('status', { state: 'error', message: '无法启动实时行情连接，请稍后重试。' });
      dispose();
      return;
    }
    // Transport heartbeat keeps intermediaries open; it never means prices are fresh.
    heartbeat = setInterval(() => write(': heartbeat\n\n'), 15_000);
    heartbeat.unref?.();
  };
}
