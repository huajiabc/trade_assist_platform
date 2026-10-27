import { describe, expect, it } from 'vitest';
import type { Candle } from '../shared/market';
import { buildMarketContext, candleMarketContexts, equityPhaseAt, hasEquitySessionReference, sessionSegments, volumeStrength } from '../shared/marketContext';
import { buildAnalysisPayload, modelPayload, modelSystemPrompt, type ModelInput } from '../server/provider';
import { researchBundle } from './research-fixtures';
import { modelContext, updateMarketState } from '../shared/marketState';

const time = (iso: string) => Date.parse(iso) / 1000;
const rows = (count = 30, start = '2026-10-22T13:20:00Z'): Candle[] => Array.from({ length: count }, (_, i) => ({ timestamp: time(start) + i * 60, open: 100, high: 102, low: 99, close: 101, volume: 10 }));

describe('New York equity clock reference, not perpetual venue hours', () => {
  it.each([
    ['2026-10-22T07:59:00Z', 'overnight'], ['2026-10-22T08:00:00Z', 'premarket'],
    ['2026-10-22T13:29:00Z', 'premarket'], ['2026-10-22T13:30:00Z', 'regular'],
    ['2026-10-22T19:59:00Z', 'regular'], ['2026-10-22T20:00:00Z', 'afterhours'],
    ['2026-10-23T00:00:00Z', 'overnight'], ['2026-10-24T00:00:00Z', 'closed'],
    ['2026-10-25T23:59:00Z', 'closed'], ['2026-10-26T00:00:00Z', 'overnight'],
  ])('classifies the exact phase boundary %s -> %s', (iso, phase) => expect(equityPhaseAt(time(iso))).toBe(phase));
  it('uses IANA daylight saving instead of a fixed UTC offset', () => {
    expect(equityPhaseAt(time('2026-01-22T14:29:00Z'))).toBe('premarket');
    expect(equityPhaseAt(time('2026-01-22T14:30:00Z'))).toBe('regular');
    expect(equityPhaseAt(time('2026-07-22T13:30:00Z'))).toBe('regular');
    expect(equityPhaseAt(time('2026-11-02T14:30:00Z'))).toBe('regular');
  });
  it.each(['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25'])('excludes standard 2026 holidays %s', date => {
    expect(equityPhaseAt(time(date + 'T15:00:00Z'))).toBe('closed');
  });
  it('checks the next trading day for the overnight session and honors early closes', () => {
    expect(equityPhaseAt(time('2026-01-19T01:00:00Z'))).toBe('closed'); // Sunday before MLK day
    expect(equityPhaseAt(time('2026-01-20T01:00:00Z'))).toBe('overnight');
    for (const date of ['2026-11-27', '2026-12-24']) {
      expect(equityPhaseAt(time(date + 'T17:59:00Z'))).toBe('regular');
      expect(equityPhaseAt(time(date + 'T18:00:00Z'))).toBe('afterhours');
    }
    expect(equityPhaseAt(time('2021-12-31T15:00:00Z'))).toBe('regular'); // Saturday New Year does not close Friday
  });
  it('uses an explicit symbol map and never assigns equity hours to arbitrary CSV or crypto symbols', () => {
    for (const symbol of ['SNDKUSDT', 'MUUSDT', 'NASDAQ:SNDK', 'SNDKUSDT.P']) expect(hasEquitySessionReference(symbol)).toBe(true);
    for (const symbol of ['BTCUSDT', 'prices.csv', 'NOTSNDKUSDT']) {
      expect(hasEquitySessionReference(symbol)).toBe(false);
      expect(candleMarketContexts(rows(), symbol, '1m').every(row => row.phase === 'unclassified')).toBe(true);
    }
  });
  it('marks wide bars across phases as mixed and keeps original timestamps intact', () => {
    const candles = rows(2, '2026-10-22T13:00:00Z');
    expect(candleMarketContexts(candles, 'SNDKUSDT', '1h')[0].phase).toBe('mixed');
    expect(candleMarketContexts(candles, 'SNDKUSDT', '1d')[0].phase).toBe('mixed');
    expect(candleMarketContexts(candles, 'SNDKUSDT', '1m').map(row => row.timestamp)).toEqual(candles.map(bar => bar.timestamp));
  });
});

describe('causal relative volume', () => {
  it('excludes the measured bar, limits history to 20 and never reads future bars', () => {
    const candles = rows(); candles[20].volume = 20;
    const metrics = candleMarketContexts(candles, 'SNDKUSDT', '1m');
    expect(metrics[4].relativeVolume).toBeNull(); expect(metrics[5].relativeVolume).toBe(1);
    expect(metrics[20]).toMatchObject({ relativeVolume: 2, baselineBars: 20 });
    expect(metrics[21].relativeVolume).toBeCloseTo(10 / 10.5, 5);
    expect(candleMarketContexts(candles.slice(0, 21), 'SNDKUSDT', '1m')).toEqual(metrics.slice(0, 21));
    const future = candles.map((bar, i) => i > 20 ? { ...bar, volume: 1e8 } : bar);
    expect(candleMarketContexts(future, 'SNDKUSDT', '1m').slice(0, 21)).toEqual(metrics.slice(0, 21));
  });
  it('resets a missing-candle baseline, leaves zero baselines unknown and distinguishes zero current volume', () => {
    const gap = rows().map((b, i) => i >= 20 ? { ...b, timestamp: b.timestamp + 60 } : b);
    expect(candleMarketContexts(gap, 'SNDKUSDT', '1m')[20]).toMatchObject({ relativeVolume: null, baselineBars: 0 });
    expect(candleMarketContexts(gap, 'SNDKUSDT', '1m')[25].relativeVolume).toBe(1);
    const zero = rows().map(b => ({ ...b, volume: 0 })); zero[29].volume = 1;
    expect(candleMarketContexts(zero, 'SNDKUSDT', '1m')[29].relativeVolume).toBeNull();
    const active = rows(); active[29].volume = 0;
    expect(candleMarketContexts(active, 'SNDKUSDT', '1m')[29].relativeVolume).toBe(0);
    expect(volumeStrength(0)).toBe('无成交'); expect(volumeStrength(.5)).toBe('缩量'); expect(volumeStrength(1.5)).toBe('放量'); expect(volumeStrength(2)).toBe('显著放量');
  });
  it('preserves tiny positive ratios, refuses nonfinite ratios and does not alter raw OHLCV', () => {
    const candles = rows(); candles[29].volume = 1e-12; const original = structuredClone(candles);
    const ratio = candleMarketContexts(candles, 'MUUSDT', '1m')[29].relativeVolume;
    expect(ratio).toBeGreaterThan(0); expect(volumeStrength(ratio)).toBe('缩量'); expect(candles).toEqual(original);
    const tiny = rows().map(b => ({ ...b, volume: Number.MIN_VALUE })); tiny[29].volume = 1e15;
    expect(candleMarketContexts(tiny, 'MUUSDT', '1m')[29].relativeVolume).toBeNull();
  });
  it('groups contiguous equal phases without bridging a gap or deleting bars', () => {
    const metrics = candleMarketContexts(rows(), 'SNDKUSDT', '1m'), segments = sessionSegments(metrics, 60);
    expect(segments.map(s => [s.phase, s.candleCount])).toEqual([['premarket', 10], ['regular', 20]]);
    expect(segments.reduce((sum, s) => sum + s.candleCount, 0)).toBe(metrics.length);
    const separated = metrics.map((b, i) => i >= 20 ? { ...b, timestamp: b.timestamp + 60 } : b);
    expect(sessionSegments(separated, 60)).toHaveLength(3);
  });
});

describe('model inputs use the same deterministic context in both adapters and input modes', () => {
  const input: ModelInput = { candles: rows(), context: { symbol: 'SNDKUSDT', timeframe: '1m', notes: '' } };
  it('adds phase and relative volume rows to single-period payload without removing exact OHLCV', () => {
    const payload = buildAnalysisPayload(input), expected = buildMarketContext(input.candles, 'SNDKUSDT', '1m');
    expect(payload.marketContext).toEqual(expected); expect(payload.candles).toEqual(input.candles);
    expect(payload.marketContext.rows).toHaveLength(input.candles.length);
    expect(payload.marketContext.session).toMatchObject({ phase: 'regular', timeZone: 'America/New_York' });
    expect(modelPayload(input)).toEqual(payload); expect(modelSystemPrompt(input)).toContain('不是Binance合约开闭市');
  });
  it('computes all three frames separately, using one common asOf and unchanged output Schema', () => {
    const context = modelContext(updateMarketState(null, researchBundle()));
    const payload = modelPayload({ ...input, workbench: context }) as any;
    for (const tf of ['15m', '5m', '1m'] as const) {
      expect(payload.marketContext[tf]).toEqual(buildMarketContext(context.bundle.frames[tf].candles, context.bundle.symbol, tf, context.bundle.asOf));
      expect(payload.marketContext[tf].rows).toHaveLength(context.bundle.frames[tf].candles.length);
      expect(payload.marketContext[tf].session.asOf).toBe(context.bundle.asOf);
    }
    expect(buildMarketContext([], 'SNDKUSDT', '1m').volume.latest).toBeNull();
    expect(buildMarketContext([], 'SNDKUSDT', '1m').session.asOf).toBeNull();
  });
});
