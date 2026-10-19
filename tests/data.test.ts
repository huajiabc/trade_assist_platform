import { describe, expect, it } from 'vitest';
import { candlesToCsv, MAX_CANDLES, MIN_CANDLES, parseMarketCsv, validateCandles } from '../shared/market';
import { SAMPLE_CANDLES } from '../shared/sample';

const small = SAMPLE_CANDLES.slice(0, MIN_CANDLES);
const csvWithTimes = (times: (number | string)[]) => ['timestamp,open,high,low,close,volume', ...times.map((time) => `${time},100,110,90,105,0`)].join('\n');

describe('market CSV boundary', () => {
  it('roundtrips all supplied sample OHLCV values with exact UTC coordinates', () => {
    const result = parseMarketCsv(candlesToCsv(SAMPLE_CANDLES));
    expect(result.candles).toEqual(SAMPLE_CANDLES);
    expect(result.warnings).toEqual([]);
  });

  it('normalizes Unix seconds, milliseconds and explicit timezone ISO to the same seconds', () => {
    const seconds = small.map((candle) => candle.timestamp);
    const milliseconds = seconds.map((timestamp) => timestamp * 1_000);
    const iso = seconds.map((timestamp) => new Date(timestamp * 1_000).toISOString().replace('Z', '+00:00'));
    expect(parseMarketCsv(csvWithTimes(seconds)).candles.map((candle) => candle.timestamp)).toEqual(seconds);
    expect(parseMarketCsv(csvWithTimes(milliseconds)).candles.map((candle) => candle.timestamp)).toEqual(seconds);
    expect(parseMarketCsv(csvWithTimes(iso)).candles.map((candle) => candle.timestamp)).toEqual(seconds);
  });

  it.each(['2026-10-10 00:00:00', '2026-10-10T00:00:00', '2026-02-30T00:00:00Z', '2026-10-10T24:00:00Z'])('rejects ambiguous or normalized invalid date %s', (timestamp) => {
    expect(() => parseMarketCsv(csvWithTimes([timestamp, ...small.slice(1).map((candle) => candle.timestamp)]))).toThrow(/timestamp/);
  });

  it('rejects milliseconds not on an exact second instead of silently rounding', () => {
    expect(() => parseMarketCsv(csvWithTimes(small.map((candle) => candle.timestamp * 1_000 + 1)))).toThrow(/整秒/);
  });

  it('rejects missing columns, duplicate columns and malformed rows', () => {
    expect(() => parseMarketCsv(candlesToCsv(small).replace('timestamp,open,high,low,close,volume', 'timestamp,open,high,low,close,extra'))).toThrow(/volume/);
    expect(() => parseMarketCsv(candlesToCsv(small).replace('volume', 'close'))).toThrow(/重复列/);
    expect(() => parseMarketCsv(candlesToCsv(small).replace(/,\d+(?:\.\d+)?\n/, '\n'))).toThrow(/列数/);
  });

  it.each(['', 'NaN', 'Infinity', '1.2oops'])('rejects empty or invalid numeric cells %j', (value) => {
    const lines = candlesToCsv(small).split('\n');
    const fields = lines[2].split(',');
    fields[3] = value;
    lines[2] = fields.join(',');
    expect(() => parseMarketCsv(lines.join('\n'))).toThrow(/缺失值|有效数值/);
  });

  it('rejects an all-missing six-cell row instead of silently dropping a record', () => {
    const lines = candlesToCsv(small).split('\n');
    lines[4] = ',,,,,';
    expect(() => parseMarketCsv(lines.join('\n'))).toThrow(/第 5 行有缺失值/);
    expect(parseMarketCsv(candlesToCsv(small) + '\n\n').candles).toEqual(small);
  });

  it('rejects negative volume, nonpositive prices and invalid high/low relationships', () => {
    expect(() => validateCandles([{ ...small[0], volume: -1 }, ...small.slice(1)])).toThrow(/volume/);
    expect(() => validateCandles([{ ...small[0], close: 0 }, ...small.slice(1)])).toThrow(/close/);
    expect(() => validateCandles([{ ...small[0], high: small[0].close - 1 }, ...small.slice(1)])).toThrow(/OHLC/);
    expect(() => validateCandles([{ ...small[0], low: small[0].high + 1 }, ...small.slice(1)])).toThrow(/OHLC/);
  });

  it('rejects duplicates and descending data without auto-sorting or deduplication', () => {
    expect(() => validateCandles([small[0], small[0], ...small.slice(2)])).toThrow(/重复|递增/);
    expect(() => validateCandles([...small].reverse())).toThrow(/递增/);
  });

  it('warns for irregular intervals and preserves the exact supplied timestamps', () => {
    const candles = small.map((candle, index) => ({ ...candle, timestamp: candle.timestamp + (index > 4 ? 3_600 : 0) }));
    const result = parseMarketCsv(candlesToCsv(candles));
    expect(result.candles).toEqual(candles);
    expect(result.warnings).toEqual([expect.stringContaining('时间间隔不一致')]);
  });

  it('does not coerce JSON string prices at the server boundary', () => {
    expect(() => validateCandles([{ ...small[0], close: '105' }, ...small.slice(1)])).toThrow(/close/);
  });

  it('enforces minimum and maximum bar count before downstream work', () => {
    expect(() => parseMarketCsv(candlesToCsv(small.slice(0, MIN_CANDLES - 1)))).toThrow(/K 线/);
    expect(() => validateCandles(Array.from({ length: MAX_CANDLES + 1 }, (_, index) => ({ ...small[0], timestamp: small[0].timestamp + index })))).toThrow(/K 线/);
  });
});
