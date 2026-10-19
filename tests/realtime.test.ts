import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BinanceRealtimeProvider, createBinanceSocket, createMarketStreamHandler, parseBinanceKline,
  type MarketSocketFactory, type MarketStreamObserver, type RealtimeMarketProvider,
} from '../server/realtime';
import { createApp } from '../server/app';
import { liveMarketQuerySchema, type LiveMarketQuery } from '../shared/liveMarket';
import type { RealtimeKline } from '../shared/realtime';

const START = Date.UTC(2026, 9, 19, 17);
const NOW = START + 15_000;
const query: LiveMarketQuery = { symbol: 'SNDKUSDT', interval: '1h', limit: 300 };
function payload(eventTime = NOW) {
  return {
    e: 'kline', E: eventTime, s: 'SNDKUSDT',
    k: { t: START, T: START + 3_600_000 - 1, s: 'SNDKUSDT', i: '1h', o: '200.12', h: '203.45', l: '198.10', c: '202.25', v: '345.678', x: false },
  };
}
class FakeSocket extends EventEmitter {
  terminate = vi.fn(() => { this.emit('close'); });
  push(value: unknown, binary = false) { this.emit('message', Buffer.from(JSON.stringify(value)), binary); }
}
function transport() {
  const sockets: FakeSocket[] = [];
  const factory = vi.fn<MarketSocketFactory>(() => {
    const socket = new FakeSocket(); sockets.push(socket); return socket;
  });
  return { sockets, factory };
}
function observer() { return { onStatus: vi.fn<MarketStreamObserver['onStatus']>(), onKline: vi.fn<MarketStreamObserver['onKline']>() }; }

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('Binance websocket event coordinates and schema', () => {
  it('maps exchange millisecond boundaries, exact prices and base volume to the shared contract', () => {
    expect(parseBinanceKline(payload(), query, NOW)).toEqual({
      symbol: 'SNDKUSDT', interval: '1h', eventTime: NOW, closed: false, closeTime: START + 3_600_000 - 1,
      candle: { timestamp: START / 1_000, open: 200.12, high: 203.45, low: 198.1, close: 202.25, volume: 345.678 },
    });
  });
  it('accepts a finalized bar only at or after the next interval boundary', () => {
    const data = payload(START + 3_600_000); data.k.x = true;
    expect(parseBinanceKline(data, query, data.E).closed).toBe(true);
  });
  it.each([
    ['wrong event type', (data: ReturnType<typeof payload>) => { data.e = 'trade'; }],
    ['wrong symbol', (data: ReturnType<typeof payload>) => { data.s = 'BTCUSDT'; }],
    ['wrong embedded symbol', (data: ReturnType<typeof payload>) => { data.k.s = 'BTCUSDT'; }],
    ['wrong interval', (data: ReturnType<typeof payload>) => { data.k.i = '5m'; }],
    ['misaligned open', (data: ReturnType<typeof payload>) => { data.k.t += 1_000; }],
    ['incorrect close boundary', (data: ReturnType<typeof payload>) => { data.k.T -= 1; }],
    ['event before candle', (data: ReturnType<typeof payload>) => { data.E = START - 1; }],
    ['stale event', (data: ReturnType<typeof payload>) => { data.E = NOW - 60_001; }],
    ['future clock', (data: ReturnType<typeof payload>) => { data.E = NOW + 60_001; }],
    ['early finalization', (data: ReturnType<typeof payload>) => { data.k.x = true; }],
    ['contradictory OHLC', (data: ReturnType<typeof payload>) => { data.k.h = '100'; }],
    ['zero price', (data: ReturnType<typeof payload>) => { data.k.o = '0'; }],
    ['exponential price string', (data: ReturnType<typeof payload>) => { data.k.o = '2e2'; }],
    ['negative volume', (data: ReturnType<typeof payload>) => { data.k.v = '-1'; }],
    ['unsafe volume', (data: ReturnType<typeof payload>) => { data.k.v = '9999999999999999'; }],
    ['missing price', (data: ReturnType<typeof payload>) => { delete (data.k as Partial<typeof data.k>).o; }],
  ])('rejects %s without yielding renderable data', (_description, mutate) => {
    const data = payload(); mutate(data);
    expect(() => parseBinanceKline(data, query, NOW)).toThrow();
  });
  it('rejects nonnumeric price and closure types without coercion', () => {
    expect(() => parseBinanceKline({ ...payload(), k: { ...payload().k, c: 202.25 } }, query, NOW)).toThrow();
    expect(() => parseBinanceKline({ ...payload(), k: { ...payload().k, x: 'false' } }, query, NOW)).toThrow();
  });
});

describe('realtime subscription lifecycle (deterministic sockets)', () => {
  it('subscribes to the current fixed market endpoint and waits for a validated first price before connected', () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const { factory, sockets } = transport(); const observe = observer();
    const stop = new BinanceRealtimeProvider(factory).subscribe(query, observe);
    expect(factory).toHaveBeenCalledWith('wss://fstream.binance.com/market/ws/sndkusdt@kline_1h', {
      handshakeTimeout: 10_000, maxPayload: 65_536, followRedirects: false, perMessageDeflate: false,
    });
    sockets[0].emit('open');
    expect(observe.onStatus.mock.calls.map(([status]) => status.state)).toEqual(['connecting']);
    sockets[0].push(payload());
    expect(observe.onStatus).toHaveBeenLastCalledWith({ state: 'connected', message: 'Binance 实时 K 线已连接。' });
    expect(observe.onKline).toHaveBeenCalledWith(parseBinanceKline(payload(), query, NOW));
    stop(); stop();
    expect(sockets[0].terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects malformed, binary and oversized frames, closes the socket and safely reconnects', () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const { factory, sockets } = transport(); const observe = observer();
    const stop = new BinanceRealtimeProvider(factory).subscribe(query, observe);
    sockets[0].emit('message', Buffer.from('not JSON'), false);
    expect(observe.onKline).not.toHaveBeenCalled();
    expect(observe.onStatus.mock.calls.some(([status]) => status.state === 'error' && status.message.includes('校验'))).toBe(true);
    expect(sockets[0].terminate).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1_000);
    sockets[1].push(payload(Date.now()), true);
    vi.advanceTimersByTime(2_000);
    sockets[2].emit('message', Buffer.alloc(65_537), false);
    expect(observe.onKline).not.toHaveBeenCalled();
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('treats silent handshakes and stale/replayed prices as disconnected, despite transport remaining open', () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const { factory, sockets } = transport(); const observe = observer();
    const stop = new BinanceRealtimeProvider(factory).subscribe(query, observe);
    sockets[0].push(payload());
    vi.advanceTimersByTime(10_000);
    sockets[0].push(payload()); // A replay cannot keep prices fresh.
    vi.advanceTimersByTime(5_000);
    expect(sockets[0].terminate).toHaveBeenCalledOnce();
    expect(observe.onStatus.mock.calls.some(([status]) => status.message.includes('过期'))).toBe(true);
    vi.advanceTimersByTime(1_000);
    sockets[1].emit('open');
    vi.advanceTimersByTime(15_000);
    expect(sockets[1].terminate).toHaveBeenCalledOnce();
    expect(observe.onStatus.mock.calls.filter(([status]) => status.state === 'connected')).toHaveLength(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds exponential retries at 15 seconds and resets backoff after valid updates', () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const { factory, sockets } = transport(); const observe = observer();
    const stop = new BinanceRealtimeProvider(factory).subscribe(query, observe);
    for (const [index, delay] of [1_000, 2_000, 4_000, 8_000, 15_000, 15_000].entries()) {
      sockets[index].emit('error', new Error('private proxy details'));
      vi.advanceTimersByTime(delay - 1);
      expect(factory).toHaveBeenCalledTimes(index + 1);
      vi.advanceTimersByTime(1);
      expect(factory).toHaveBeenCalledTimes(index + 2);
    }
    sockets[6].push(payload(Date.now()));
    sockets[6].emit('close');
    vi.advanceTimersByTime(1_000);
    expect(factory).toHaveBeenCalledTimes(8);
    expect(JSON.stringify(observe.onStatus.mock.calls)).not.toContain('private');
    stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels pending reconnects immediately and ignores detached socket messages', () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const { factory, sockets } = transport(); const observe = observer();
    const stop = new BinanceRealtimeProvider(factory).subscribe(query, observe);
    sockets[0].emit('error', new Error('private error'));
    stop();
    sockets[0].push(payload());
    vi.advanceTimersByTime(60_000);
    expect(factory).toHaveBeenCalledOnce(); expect(observe.onKline).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('safely reports synchronous connection setup failures without leaking configured transport details', () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const factory: MarketSocketFactory = () => { throw new Error('secret proxy URL'); };
    const observe = observer(); const stop = new BinanceRealtimeProvider(factory).subscribe(query, observe);
    expect(JSON.stringify(observe.onStatus.mock.calls)).not.toContain('secret');
    expect(observe.onStatus.mock.calls.map(([status]) => status.state)).toEqual(['connecting', 'error', 'reconnecting']);
    stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects invalid or credential-bearing proxy configuration before attempting network access', () => {
    for (const proxy of ['socks5://127.0.0.1:7890', 'http://user:secret@127.0.0.1:7890', 'http://127.0.0.1:7890/?secret=1', 'not-a-url']) {
      vi.stubEnv('MARKET_PROXY_URL', proxy);
      expect(() => createBinanceSocket('wss://fstream.binance.com/market/ws/sndkusdt@kline_1h', {})).toThrow('行情代理配置无效');
    }
  });
});

class FakeResponse extends EventEmitter {
  writableLength = 0;
  writableEnded = false;
  destroyed = false;
  chunks: string[] = [];
  headers: Record<string, string> = {};
  statusCode = 0;
  status(code: number) { this.statusCode = code; return this; }
  set(headers: Record<string, string>) { this.headers = headers; return this; }
  flushHeaders = vi.fn();
  write(data: string) { this.chunks.push(data); return true; }
  end() { this.writableEnded = true; this.emit('close'); return this; }
}
function attach(handler: ReturnType<typeof createMarketStreamHandler>, response = new FakeResponse(), rawQuery: unknown = query) {
  handler({ query: rawQuery } as Request, response as unknown as Response, () => {});
  return response;
}

describe('local SSE HTTP boundary', () => {
  it('writes typed data events, heartbeat comments, and releases the upstream on client close', () => {
    vi.useFakeTimers();
    let callbacks!: MarketStreamObserver;
    const stop = vi.fn();
    const provider: RealtimeMarketProvider = { subscribe: vi.fn((selected, observer) => {
      expect(selected).toEqual(query); callbacks = observer; return stop;
    }) };
    const response = attach(createMarketStreamHandler(provider));
    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({ 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no', 'Cache-Control': 'no-cache, no-transform' });
    callbacks.onStatus({ state: 'connecting', message: '连接中' });
    callbacks.onKline(parseBinanceKline(payload(), query, NOW));
    vi.advanceTimersByTime(15_000);
    expect(response.chunks.join('')).toContain('event: kline\ndata: {"symbol":"SNDKUSDT"');
    expect(response.chunks.join('')).toContain('event: status\ndata: {"state":"connecting"');
    expect(response.chunks.at(-1)).toBe(': heartbeat\n\n');
    response.emit('close'); response.emit('close');
    expect(stop).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('caps open local clients and makes capacity available again after disposal', () => {
    vi.useFakeTimers();
    const stops: ReturnType<typeof vi.fn>[] = [];
    const handler = createMarketStreamHandler({ subscribe: () => { const stop = vi.fn(); stops.push(stop); return stop; } }, 2);
    const first = attach(handler); const second = attach(handler);
    expect(() => attach(handler)).toThrow('实时连接数量已达上限');
    first.emit('close');
    const third = attach(handler);
    expect(stops[0]).toHaveBeenCalledOnce();
    second.emit('close'); third.emit('close');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('closes slow consumers instead of buffering unbounded stream data', () => {
    vi.useFakeTimers();
    let callbacks!: MarketStreamObserver; const stop = vi.fn();
    const response = attach(createMarketStreamHandler({ subscribe: (_query, observer) => { callbacks = observer; return stop; } }));
    response.writableLength = 262_145;
    callbacks.onKline(parseBinanceKline(payload(), query, NOW));
    expect(response.writableEnded).toBe(true); expect(stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('returns safe stream status if an injected provider fails before subscription setup', () => {
    vi.useFakeTimers();
    const response = attach(createMarketStreamHandler({ subscribe: () => { throw new Error('private socket credentials'); } }));
    expect(response.chunks.join('')).toContain('"state":"error"');
    expect(response.chunks.join('')).not.toContain('private');
    expect(response.writableEnded).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it('validates and normalizes the same query contract before opening a socket', async () => {
    const subscribe = vi.fn(() => vi.fn()); const app = createApp({ realtime: { subscribe } });
    const result = await request(app).get('/api/market/stream?symbol=evil.example%2Fpath&interval=1h').expect(400);
    expect(result.body.error.code).toBe('MARKET_QUERY_INVALID');
    await request(app).get('/api/market/stream?symbol=SNDKUSDT&interval=1s').expect(400);
    await request(app).get('/api/market/stream?symbol=SNDKUSDT&url=wss://evil.example').expect(400);
    expect(subscribe).not.toHaveBeenCalled();
    expect(liveMarketQuerySchema.parse({ symbol: 'sndkusdt' })).toEqual(query);
  });
});

it.runIf(process.env.LIVE_MARKET_SMOKE === '1')('receives two validated real SNDKUSDT websocket updates (opt-in network smoke)', async () => {
  let stop = () => {};
  const events: RealtimeKline[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('No two real kline events within 25 seconds.')), 25_000);
      stop = new BinanceRealtimeProvider().subscribe(query, {
        onStatus: () => {},
        onKline: event => {
          events.push(event);
          if (events.length === 2) { clearTimeout(deadline); resolve(); }
        },
      });
    });
    expect(events).toHaveLength(2);
    expect(events[1].eventTime).toBeGreaterThan(events[0].eventTime);
    expect(events.every(event => event.symbol === 'SNDKUSDT' && Number.isFinite(event.candle.close))).toBe(true);
  } finally { stop(); }
}, 30_000);
