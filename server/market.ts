import { z } from 'zod';
import { setTimeout as wait } from 'node:timers/promises';
import { LIVE_INTERVAL_SECONDS, validateMarketSnapshot, type LiveMarketQuery, type MarketSnapshot } from '../shared/liveMarket';
import { MIN_CANDLES, type Candle } from '../shared/market';
import { PublicError } from './errors';
import { marketFetch } from './network';

/** Public, read-only market data; this interface never accepts exchange credentials. */
export interface MarketDataProvider {
  getCandles(query: LiveMarketQuery): Promise<MarketSnapshot>;
}

const API_ORIGIN = 'https://fapi.binance.com';
const MAX_RESPONSE_BYTES = 1_048_576;
const DECIMAL = /^\d+(?:\.\d+)?$/;
const invalidData = () => new PublicError(502, 'MARKET_INVALID_DATA', '交易所行情未通过格式或时间/价格校验，已拒绝加载。');

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw invalidData();
  }
  if (!response.body) throw invalidData();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw invalidData();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw invalidData();
  }
}

async function exchangeJson(response: Response): Promise<unknown> {
  if (response.status === 429 || response.status === 418) {
    await response.body?.cancel();
    throw new PublicError(429, 'MARKET_RATE_LIMITED', '交易所行情接口暂时限流，请稍后再刷新。');
  }
  if (!response.ok) {
    // Read only a bounded body to classify a documented symbol error; never expose upstream text.
    let body: unknown;
    try { body = await boundedJson(response); } catch { /* Preserve the safe HTTP error below. */ }
    if (body && typeof body === 'object' && 'code' in body && body.code === -1121) {
      throw new PublicError(400, 'MARKET_INVALID_SYMBOL', '该 USDT 永续合约不存在或当前不可用，请检查交易对。');
    }
    throw new PublicError(502, 'MARKET_UNAVAILABLE', '无法获取 Binance USDT 永续行情，请检查服务端网络及该服务在当前地区的可用性。');
  }
  return boundedJson(response);
}

function decimal(value: unknown): number {
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw invalidData();
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw invalidData();
  return numeric;
}

/** Confirm both transport and adapter metadata before a response can enter the UI/cache. */
export function validateRequestedSnapshot(input: unknown, query: LiveMarketQuery): MarketSnapshot {
  try {
    const snapshot = validateMarketSnapshot(input);
    if (snapshot.symbol !== query.symbol || snapshot.interval !== query.interval || snapshot.candles.length > query.limit) throw invalidData();
    return snapshot;
  } catch {
    throw invalidData();
  }
}

/** Binance USD-M kline tuples use milliseconds, base-asset volume, and inclusive close time. */
export class BinanceMarketProvider implements MarketDataProvider {
  constructor(private readonly fetchImpl: typeof fetch = marketFetch, private readonly timeoutMs = 10_000) {}

  async getCandles(query: LiveMarketQuery): Promise<MarketSnapshot> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const url = new URL('/fapi/v1/klines', API_ORIGIN);
      url.search = new URLSearchParams({ symbol: query.symbol, interval: query.interval, limit: String(query.limit) }).toString();
      const options: RequestInit = { method: 'GET', signal: abort.signal, redirect: 'error', headers: { Accept: 'application/json' } };
      // Public GETs only: retry one reset tunnel within the original request deadline.
      const get = async (address: string) => {
        try { return await this.fetchImpl(address, options); }
        catch (error) {
          const cause = error as { code?: string; cause?: { code?: string } };
          if (abort.signal.aborted || !['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(cause?.cause?.code ?? cause?.code ?? '')) throw error;
          await wait(200, undefined, { signal: abort.signal });
          return this.fetchImpl(address, options);
        }
      };
      const [rows, time] = await Promise.all([
        get(url.toString()).then(exchangeJson),
        get(API_ORIGIN + '/fapi/v1/time').then(exchangeJson),
      ]);
      const clock = z.object({ serverTime: z.number().int().positive() }).parse(time).serverTime;
      if (!Array.isArray(rows) || rows.length < MIN_CANDLES || rows.length > query.limit) throw invalidData();
      const intervalMs = LIVE_INTERVAL_SECONDS[query.interval] * 1_000;
      const candles: Candle[] = rows.map((row: unknown) => {
        if (!Array.isArray(row) || row.length !== 12) throw invalidData();
        const [openTime, open, high, low, close, volume, closeTime] = row;
        if (!Number.isSafeInteger(openTime) || openTime < 0 || openTime % 1_000 !== 0 ||
            !Number.isSafeInteger(closeTime) || closeTime !== openTime + intervalMs - 1 ||
            !Number.isSafeInteger(row[8]) || row[8] < 0) throw invalidData();
        // These fields are not charted but still must match the documented tuple contract.
        [row[7], row[9], row[10], row[11]].forEach(decimal);
        return { timestamp: openTime / 1_000, open: decimal(open), high: decimal(high), low: decimal(low), close: decimal(close), volume: decimal(volume) };
      });
      const warnings: string[] = [];
      if (candles.length < query.limit) warnings.push(`交易所仅返回 ${candles.length} 根 K 线，少于请求的 ${query.limit} 根；未补齐数据。`);
      if (candles.some((candle, index) => index > 0 && candle.timestamp - candles[index - 1].timestamp !== intervalMs / 1_000)) {
        warnings.push('行情包含时间缺口，已保留交易所原始时间，未补齐或插值。');
      }
      if (clock - candles[candles.length - 1].timestamp * 1_000 > intervalMs * 2) {
        warnings.push('交易所最新 K 线距服务器时间超过两个周期，数据可能延迟或交易暂停，请核对后使用。');
      }
      return validateRequestedSnapshot({
        provider: 'binance', market: 'usdt-perpetual', symbol: query.symbol, interval: query.interval,
        candles, lastCandleClosed: rows[rows.length - 1][6] < clock,
        serverTime: clock, fetchedAt: new Date().toISOString(), warnings,
      }, query);
    } catch (error) {
      if (error instanceof PublicError) throw error;
      if (abort.signal.aborted) throw new PublicError(504, 'MARKET_TIMEOUT', '交易所行情请求超时，请检查服务端网络后重试。');
      if (error instanceof z.ZodError) throw invalidData();
      throw new PublicError(502, 'MARKET_UNAVAILABLE', '无法连接 Binance 行情服务，请检查服务端网络后重试。');
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  }
}

/** A short bounded cache coalesces overlapping chart polls without hiding upstream failures. */
export class CachedMarketProvider implements MarketDataProvider {
  private readonly cache = new Map<string, { expiresAt: number; value: MarketSnapshot }>();
  private readonly inflight = new Map<string, Promise<MarketSnapshot>>();

  constructor(private readonly provider: MarketDataProvider, private readonly ttlMs = 5_000, private readonly maxEntries = 50) {}

  async getCandles(query: LiveMarketQuery): Promise<MarketSnapshot> {
    const key = `${query.symbol}:${query.interval}:${query.limit}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.value;
    }
    this.cache.delete(key);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    if (this.inflight.size >= this.maxEntries) throw new PublicError(503, 'MARKET_BUSY', '行情请求繁忙，请稍后重试。');
    const request = Promise.resolve().then(() => this.provider.getCandles(query)).then((raw) => {
      const value = validateRequestedSnapshot(raw, query);
      this.cache.set(key, { expiresAt: Date.now() + this.ttlMs, value });
      while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
      return value;
    }).finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, request);
    return request;
  }
}
