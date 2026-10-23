import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import { BinanceMarketProvider, CachedMarketProvider, type MarketDataProvider } from '../server/market';
import { closedMarketCandles, LIVE_INTERVAL_SECONDS, liveMarketQuerySchema, validateMarketSnapshot, type LiveMarketQuery, type MarketSnapshot } from '../shared/liveMarket';

const START = Date.UTC(2026, 9, 1) / 1_000;
const query: LiveMarketQuery = { symbol: 'SNDKUSDT', interval: '1h', limit: 20 };
function rows(count = 20, seconds = 3_600): unknown[][] {
  return Array.from({ length: count }, (_, index) => [
    (START + index * seconds) * 1_000, '200.12', '203.45', '198.10', '202.25', '345.678',
    (START + (index + 1) * seconds) * 1_000 - 1, '69738.3755', 35, '120.125', '24294.78125', '0',
  ]);
}
function snapshot(): MarketSnapshot {
  return {
    provider: 'binance', market: 'usdt-perpetual', symbol: 'SNDKUSDT', interval: '1h',
    candles: Array.from({ length: 20 }, (_, index) => ({ timestamp: START + index * 3_600, open: 200.12, high: 203.45, low: 198.1, close: 202.25, volume: 345.678 })),
    lastCandleClosed: false, serverTime: (START + 19 * 3_600 + 900) * 1_000,
    fetchedAt: '2026-10-01T19:15:00.000Z', warnings: [],
  };
}
function transport(data: unknown = rows(), serverTime = snapshot().serverTime): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (url) => new Response(JSON.stringify(String(url).endsWith('/time') ? { serverTime } : data), { headers: { 'Content-Type': 'application/json' } }));
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Binance public market adapter (stubbed transport)', () => {
  it('maps tuple milliseconds and base volume exactly, with an unclosed final bar', async () => {
    const fetchImpl = transport();
    const result = await new BinanceMarketProvider(fetchImpl).getCandles(query);
    expect(result).toMatchObject({ provider: 'binance', market: 'usdt-perpetual', symbol: 'SNDKUSDT', interval: '1h', serverTime: snapshot().serverTime, lastCandleClosed: false });
    expect(result.candles).toEqual(snapshot().candles);
    expect(result.warnings).toEqual([]);
    expect(fetchImpl.mock.calls.map(call => String(call[0])).sort()).toEqual([
      'https://fapi.binance.com/fapi/v1/klines?symbol=SNDKUSDT&interval=1h&limit=20', 'https://fapi.binance.com/fapi/v1/time',
    ]);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.method === 'GET' && init.redirect === 'error' && !('Authorization' in (init.headers ?? {})))).toBe(true);
  });

  it('retries a reset public GET once using the original shared deadline and exact request', async () => {
    const base = transport(); let reset = true;
    const fetchImpl = vi.fn<typeof fetch>(async (url, options) => {
      if (String(url).includes('/klines') && reset) { reset = false; throw new TypeError('connection reset', { cause: { code: 'ECONNRESET' } }); }
      return base(url, options);
    });
    const result = await new BinanceMarketProvider(fetchImpl).getCandles(query);
    expect(result.candles).toEqual(snapshot().candles); expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(new Set(fetchImpl.mock.calls.map(([, options]) => options!.signal)).size).toBe(1);
    const klineCalls = fetchImpl.mock.calls.filter(([url]) => String(url).includes('/klines'));
    expect(klineCalls).toHaveLength(2); expect(klineCalls[1][0]).toBe(klineCalls[0][0]);
  });

  it('bounds repeated reset errors to one retry and never fabricates a snapshot', async () => {
    const base = transport(); const fetchImpl = vi.fn<typeof fetch>(async (url, options) => {
      if (String(url).includes('/klines')) throw new TypeError('connection reset', { cause: { code: 'ECONNRESET' } });
      return base(url, options);
    });
    await expect(new BinanceMarketProvider(fetchImpl).getCandles(query)).rejects.toMatchObject({ code: 'MARKET_UNAVAILABLE' });
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('/klines'))).toHaveLength(2);
  });

  it('does not extend its timeout budget to perform a pending reset retry', async () => {
    const base = transport(); const fetchImpl = vi.fn<typeof fetch>(async (url, options) => {
      if (String(url).includes('/klines')) throw new TypeError('connection reset', { cause: { code: 'ECONNRESET' } });
      return base(url, options);
    });
    await expect(new BinanceMarketProvider(fetchImpl, 15).getCandles(query)).rejects.toMatchObject({ code: 'MARKET_TIMEOUT' });
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('/klines'))).toHaveLength(1);
  });

  it('recognizes inclusive closeTime as closed at the next UTC interval boundary', async () => {
    const serverTime = (START + 20 * 3_600) * 1_000;
    const result = await new BinanceMarketProvider(transport(rows(), serverTime)).getCandles(query);
    expect(result.lastCandleClosed).toBe(true);
    expect(closedMarketCandles(result)).toHaveLength(20);
  });

  it('requests native one-minute candles and closes the last bar at the minute boundary', async () => {
    const minuteQuery: LiveMarketQuery = { ...query, interval: '1m' };
    const boundary = (START + 20 * 60) * 1_000;
    const fetchImpl = transport(rows(20, 60), boundary - 1);
    const forming = await new BinanceMarketProvider(fetchImpl).getCandles(minuteQuery);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/klines?symbol=SNDKUSDT&interval=1m&limit=20'))).toBe(true);
    expect(forming.interval).toBe('1m');
    expect(forming.candles.at(-1)!.timestamp).toBe(START + 19 * 60);
    expect(forming.candles[1].timestamp - forming.candles[0].timestamp).toBe(60);
    expect(forming.lastCandleClosed).toBe(false);
    expect(closedMarketCandles(forming)).toHaveLength(19);
    const finalized = await new BinanceMarketProvider(transport(rows(20, 60), boundary)).getCandles(minuteQuery);
    expect(finalized.lastCandleClosed).toBe(true);
    expect(closedMarketCandles(finalized)).toHaveLength(20);
  });

  it.each([
    ['missing values', (data: unknown[][]) => { data[0][1] = ''; }],
    ['numeric strings containing spaces', (data: unknown[][]) => { data[0][1] = ' 200.12 '; }],
    ['non-finite numeric values', (data: unknown[][]) => { data[0][1] = '9'.repeat(400); }],
    ['OHLC contradictions', (data: unknown[][]) => { data[0][2] = '1'; }],
    ['negative volume', (data: unknown[][]) => { data[0][5] = '-1'; }],
    ['duplicate bars', (data: unknown[][]) => { data[1] = data[0]; }],
    ['reversed bars', (data: unknown[][]) => { data.reverse(); }],
    ['invalid close-time interval', (data: unknown[][]) => { data[0][6] = Number(data[0][6]) - 1; }],
    ['missing tuple fields', (data: unknown[][]) => { data[0].pop(); }],
    ['negative trades', (data: unknown[][]) => { data[0][8] = -1; }],
  ])('rejects %s without repairing or fabricating data', async (_label, change) => {
    const data = rows(); change(data);
    await expect(new BinanceMarketProvider(transport(data)).getCandles(query)).rejects.toMatchObject({ status: 502, code: 'MARKET_INVALID_DATA' });
  });

  it('rejects future bars and malformed exchange clock', async () => {
    await expect(new BinanceMarketProvider(transport(rows(), START * 1_000)).getCandles(query)).rejects.toMatchObject({ code: 'MARKET_INVALID_DATA' });
    await expect(new BinanceMarketProvider(transport(rows(), Number.NaN)).getCandles(query)).rejects.toMatchObject({ code: 'MARKET_INVALID_DATA' });
  });

  it('warns on missing intervals and short history while preserving original timestamps', async () => {
    const data = rows(); data.splice(5, 1);
    const result = await new BinanceMarketProvider(transport(data)).getCandles(query);
    expect(result.candles).toHaveLength(19);
    expect(result.candles[5].timestamp).toBe(START + 6 * 3_600);
    expect(result.warnings).toHaveLength(2);
  });

  it.each([
    [429, {}, 'MARKET_RATE_LIMITED', 429],
    [418, {}, 'MARKET_RATE_LIMITED', 429],
    [400, { code: -1121, msg: 'sensitive upstream body' }, 'MARKET_INVALID_SYMBOL', 400],
    [451, { msg: 'restricted location' }, 'MARKET_UNAVAILABLE', 502],
    [500, { msg: 'sensitive upstream body' }, 'MARKET_UNAVAILABLE', 502],
  ])('returns a safe public error for upstream HTTP %s', async (status, body, code, resultStatus) => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify(body), { status });
    await expect(new BinanceMarketProvider(fetchImpl).getCandles(query)).rejects.toMatchObject({ status: resultStatus, code });
  });

  it('rejects malformed and oversized response JSON', async () => {
    for (const body of ['not JSON', 'x'.repeat(1_048_577)]) {
      const fetchImpl: typeof fetch = async () => new Response(body);
      await expect(new BinanceMarketProvider(fetchImpl).getCandles(query)).rejects.toMatchObject({ code: 'MARKET_INVALID_DATA' });
    }
  });

  it('enforces transport timeout without exposing internal network errors', async () => {
    const fetchImpl: typeof fetch = async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('private proxy credential error')), { once: true });
    });
    await expect(new BinanceMarketProvider(fetchImpl, 5).getCandles(query)).rejects.toMatchObject({ status: 504, code: 'MARKET_TIMEOUT' });
  });
});

describe('market snapshot contract', () => {
  it('excludes only the unclosed final bar from analysis without modifying chart data', () => {
    const input = snapshot();
    expect(closedMarketCandles(input)).toEqual(input.candles.slice(0, -1));
    expect(input.candles).toHaveLength(20);
    expect(() => validateMarketSnapshot(input)).not.toThrow();
    expect(() => validateMarketSnapshot({ ...input, lastCandleClosed: true })).toThrow();
  });
  it('normalizes the symbol and imposes a strict bounded query contract', () => {
    expect(liveMarketQuerySchema.parse({})).toEqual({ symbol: 'SNDKUSDT', interval: '1h', limit: 300 });
    expect(liveMarketQuerySchema.parse({ symbol: ' sndkusdt ', limit: '20' })).toEqual(query);
    expect(liveMarketQuerySchema.safeParse({ limit: 501 }).success).toBe(false);
    expect(liveMarketQuerySchema.parse({ symbol: ' sndkusdt ', interval: '1m', limit: '20' })).toEqual({ ...query, interval: '1m' });
    expect(LIVE_INTERVAL_SECONDS['1m']).toBe(60);
  });
});

describe('market HTTP boundary and short cache', () => {
  it.each([
    '?interval=1s', '?limit=501', '?limit=19', '?limit=invalid', '?symbol=../secret',
    '?symbol=BTCUSD', '?provider=https://evil.example', '?symbol=SNDKUSDT&symbol=BTCUSDT', '?limit=20&limit=30',
  ])('rejects invalid query %s before transport', async (suffix) => {
    const getCandles = vi.fn<MarketDataProvider['getCandles']>();
    const result = await request(createApp({ marketProvider: { getCandles } })).get(`/api/market/candles${suffix}`).expect(400);
    expect(result.body.error.code).toBe('MARKET_QUERY_INVALID');
    expect(getCandles).not.toHaveBeenCalled();
  });

  it('returns validated real-provider data with defaults and caches the result', async () => {
    const getCandles = vi.fn<MarketDataProvider['getCandles']>(async () => snapshot());
    const app = createApp({ marketProvider: { getCandles } });
    const first = await request(app).get('/api/market/candles').expect(200);
    const second = await request(app).get('/api/market/candles').expect(200);
    expect(first.body).toEqual(snapshot());
    expect(first.headers['cache-control']).toBe('no-store');
    expect(second.body).toEqual(first.body);
    expect(getCandles).toHaveBeenCalledOnce();
    expect(getCandles).toHaveBeenCalledWith({ ...query, limit: 300 });
  });

  it('rejects wrong-symbol or wrong-interval adapter output before emitting candles', async () => {
    for (const override of [{ symbol: 'BTCUSDT' }, { interval: '15m' }, { candles: [...snapshot().candles, ...snapshot().candles] }]) {
      const getCandles = async () => ({ ...snapshot(), ...override }) as MarketSnapshot;
      const response = await request(createApp({ marketProvider: { getCandles } })).get('/api/market/candles?limit=20').expect(502);
      expect(response.body.error.code).toBe('MARKET_INVALID_DATA');
      expect(response.body.candles).toBeUndefined();
    }
  });

  it('sanitizes unexpected adapter exceptions and never substitutes mock data', async () => {
    const getCandles = async () => { throw new Error('private upstream URL and credential'); };
    const response = await request(createApp({ marketProvider: { getCandles } })).get('/api/market/candles').expect(502);
    expect(response.body).toEqual({ error: { code: 'MARKET_UNAVAILABLE', message: '行情服务暂时不可用，请稍后重试。' } });
    expect(response.text).not.toContain('credential');
  });

  it('coalesces in-flight requests, expires after 5s, and does not cache failures', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let resolve!: (value: MarketSnapshot) => void;
    const getCandles = vi.fn<MarketDataProvider['getCandles']>().mockImplementationOnce(async () => await new Promise<MarketSnapshot>((done) => { resolve = done; })).mockResolvedValue(snapshot());
    const provider = new CachedMarketProvider({ getCandles });
    const first = provider.getCandles(query);
    const second = provider.getCandles(query);
    await Promise.resolve();
    expect(getCandles).toHaveBeenCalledOnce();
    resolve(snapshot());
    await expect(first).resolves.toEqual(snapshot());
    await expect(second).resolves.toEqual(snapshot());
    await provider.getCandles(query);
    expect(getCandles).toHaveBeenCalledOnce();
    now += 5_001;
    await provider.getCandles(query);
    expect(getCandles).toHaveBeenCalledTimes(2);
    getCandles.mockRejectedValueOnce(new Error('offline'));
    now += 5_001;
    await expect(provider.getCandles(query)).rejects.toThrow('offline');
    await expect(provider.getCandles(query)).resolves.toEqual(snapshot());
    expect(getCandles).toHaveBeenCalledTimes(4);
  });

  it('bounds cache entries and pending requests', async () => {
    const getCandles = vi.fn<MarketDataProvider['getCandles']>(async value => ({ ...snapshot(), symbol: value.symbol }));
    const provider = new CachedMarketProvider({ getCandles }, 5_000, 2);
    await provider.getCandles(query);
    await provider.getCandles({ ...query, symbol: 'BTCUSDT' });
    await provider.getCandles({ ...query, symbol: 'ETHUSDT' });
    await provider.getCandles(query);
    expect(getCandles).toHaveBeenCalledTimes(4);
    const blocked = new CachedMarketProvider({ getCandles: async () => await new Promise<MarketSnapshot>(() => undefined) }, 5_000, 1);
    void blocked.getCandles(query);
    await expect(blocked.getCandles({ ...query, symbol: 'BTCUSDT' })).rejects.toMatchObject({ status: 503, code: 'MARKET_BUSY' });
  });
});
