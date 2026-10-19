import { describe, expect, it } from 'vitest';
import { createMockAnalysis } from '../shared/mock';
import { SAMPLE_CANDLES } from '../shared/sample';
import { PA_SAMPLE_CANDLES } from '../shared/paSample';
import type { Candle } from '../shared/market';
import { analysisDatasetKey, createAnalysisSnapshot, inspectAnalysisSnapshot, projectAnalysisForCandles } from '../src/analysisSession';

const identity = 'live:SNDKUSDT:5M:Binance';
const input = SAMPLE_CANDLES.slice(-30);
const expanded = (): Candle[] => Array.from({ length: 400 }, (_, index) => ({ ...SAMPLE_CANDLES[index % SAMPLE_CANDLES.length], timestamp: 1_700_000_000 + index * 300 }));
const unchanged = { stale: false, addedBars: 0, revisedBars: 0, missingBars: 0 };

describe('immutable analysis input snapshots', () => {
  it('keys every dataset identity dimension so a market or CSV change isolates late responses', () => {
    const base = { source: 'live' as const, name: 'SNDKUSDT', timeframe: '5M', file: 'Binance' };
    const original = analysisDatasetKey(base);
    expect(analysisDatasetKey({ ...base })).toBe(original);
    expect(new Set([
      original,
      analysisDatasetKey({ ...base, source: 'csv' }),
      analysisDatasetKey({ ...base, name: 'BTCUSDT' }),
      analysisDatasetKey({ ...base, timeframe: '15M' }),
      analysisDatasetKey({ ...base, file: 'another.csv' }),
    ]).size).toBe(5);
  });

  it('freezes exactly the latest 300 automatic bars without aliasing mutable market objects', () => {
    const candles = expanded();
    const snapshot = createAnalysisSnapshot(candles, identity, 'codex', 1234);
    expect(snapshot).toMatchObject({ identity, source: 'codex', startedAt: 1234, selectionMode: 'auto', asOf: candles.at(-1)!.timestamp });
    expect(snapshot.candles).toEqual(candles.slice(-300));
    expect(snapshot.candles).not.toBe(candles);
    expect(snapshot.candles[0]).not.toBe(candles[100]);
    candles[100].volume += 999;
    expect(snapshot.candles[0].volume).not.toBe(candles[100].volume);
  });

  it('keeps an explicit manual selection exact and refuses to silently truncate an oversized selection', () => {
    const selected = input.slice(3, 24);
    const snapshot = createAnalysisSnapshot(selected, identity, 'api', 1234, 'manual');
    expect(snapshot.selectionMode).toBe('manual');
    expect(snapshot.candles).toEqual(selected);
    expect(snapshot.asOf).toBe(selected.at(-1)!.timestamp);
    expect(() => createAnalysisSnapshot(expanded(), identity, 'api', 1234, 'manual')).toThrow(/300|范围|长度/);
  });

  it('ignores unchanged copies and forming-only updates outside the closed input', () => {
    const snapshot = createAnalysisSnapshot(input, identity, 'codex');
    expect(inspectAnalysisSnapshot(snapshot, input.map(candle => ({ ...candle })))).toEqual(unchanged);
    const older = { ...input[0], timestamp: input[0].timestamp - 3600 };
    expect(inspectAnalysisSnapshot(snapshot, [older, ...input])).toEqual(unchanged);
  });

  it('marks automatic analysis stale when new closed bars arrive and counts only bars after its as-of time', () => {
    const snapshot = createAnalysisSnapshot(input, identity, 'codex');
    const last = input.at(-1)!;
    const current = [...input, { ...last, timestamp: last.timestamp + 3600 }, { ...last, timestamp: last.timestamp + 7200 }];
    expect(inspectAnalysisSnapshot(snapshot, current)).toEqual({ ...unchanged, stale: true, addedBars: 2 });
  });

  it.each(['open', 'high', 'low', 'close', 'volume'] as const)('detects a correction to analyzed %s even when timestamps are unchanged', field => {
    const snapshot = createAnalysisSnapshot(input, identity, 'codex');
    const revised = input.map((candle, index) => index === 5 ? { ...candle, [field]: candle[field] + 1 } : candle);
    expect(inspectAnalysisSnapshot(snapshot, revised)).toEqual({ ...unchanged, stale: true, revisedBars: 1 });
    expect(snapshot.candles[5]).toEqual(input[5]);
  });

  it('reports missing rolling-window bars separately from historical revisions and new bars', () => {
    const snapshot = createAnalysisSnapshot(input, identity, 'codex');
    const last = input.at(-1)!;
    const current = [...input.slice(2).map((candle, index) => index === 3 ? { ...candle, volume: candle.volume + 1 } : candle), { ...last, timestamp: last.timestamp + 3600 }];
    expect(inspectAnalysisSnapshot(snapshot, current)).toEqual({ stale: true, addedBars: 1, revisedBars: 1, missingBars: 2 });
  });

  it('keeps a historical manual analysis current when later bars arrive, while still detecting corrections and missing selected bars', () => {
    const selected = input.slice(0, 15);
    const snapshot = createAnalysisSnapshot(selected, identity, 'codex', 1234, 'manual');
    expect(inspectAnalysisSnapshot(snapshot, input)).toEqual(unchanged);
    const revised = input.map((candle, index) => index === 4 ? { ...candle, volume: candle.volume + 1 } : candle);
    expect(inspectAnalysisSnapshot(snapshot, revised)).toEqual({ ...unchanged, stale: true, revisedBars: 1 });
    expect(inspectAnalysisSnapshot(snapshot, input.slice(1))).toEqual({ ...unchanged, stale: true, missingBars: 1 });
  });
});

describe('drawing a retained analysis against a moving chart window', () => {
  it('preserves every element while all required coordinates are loaded and never mutates the validated result', () => {
    const analysis = createMockAnalysis(PA_SAMPLE_CANDLES);
    const before = structuredClone(analysis);
    expect(projectAnalysisForCandles(analysis, PA_SAMPLE_CANDLES)).toEqual(analysis);
    projectAnalysisForCandles(analysis, PA_SAMPLE_CANDLES.slice(60));
    expect(analysis).toEqual(before);
  });

  it('removes a missing SMC anchor and recursively removes its opportunity and dependent candidate plan', () => {
    const analysis = createMockAnalysis(SAMPLE_CANDLES);
    const structure = analysis.structures[0];
    const retained = analysis.structures.find(item => item.id !== structure.id && item.startTime !== structure.startTime && item.endTime !== structure.startTime)!;
    analysis.opportunities = [{ ...analysis.opportunities[0], id: 'dependent-watch', structureIds: [structure.id] }];
    analysis.tradeSetups = [{ ...analysis.tradeSetups[0], structureIds: [retained.id], opportunityId: 'dependent-watch' }];
    const projection = projectAnalysisForCandles(analysis, SAMPLE_CANDLES.filter(candle => candle.timestamp !== structure.startTime));
    expect(projection.structures.some(item => item.id === structure.id)).toBe(false);
    expect(projection.structures.some(item => item.id === retained.id)).toBe(true);
    expect(projection.opportunities).toEqual([]);
    expect(projection.tradeSetups).toEqual([]);
    expect(analysis.opportunities).toHaveLength(1);
  });

  it('requires every PA zone touch and its breakout zone dependency to remain present', () => {
    const analysis = createMockAnalysis(PA_SAMPLE_CANDLES);
    const breakout = analysis.priceAction.breakouts[0];
    const zone = analysis.priceAction.zones.find(item => item.id === breakout.zoneId)!;
    const missing = zone.touchTimes.find(time => time !== zone.startTime && time !== zone.endTime)!;
    expect(missing).toBeDefined();
    const projection = projectAnalysisForCandles(analysis, PA_SAMPLE_CANDLES.filter(candle => candle.timestamp !== missing));
    expect(projection.priceAction.zones.some(item => item.id === zone.id)).toBe(false);
    expect(projection.priceAction.breakouts.some(item => item.id === breakout.id)).toBe(false);
    expect(analysis.priceAction.zones.some(item => item.id === zone.id)).toBe(true);
  });

  it('filters PA legs, candle patterns, breakout phase coordinates, sweeps and trade anchors independently', () => {
    const analysis = createMockAnalysis(PA_SAMPLE_CANDLES);
    const missing = new Set([
      analysis.priceAction.legs[0].startTime,
      analysis.priceAction.patterns[0].endTime,
      analysis.priceAction.breakouts[0].retestTime!,
      analysis.tradeSetups[0].anchorTime,
      ...analysis.liquiditySweeps.slice(0, 1).map(item => item.levelTime),
    ]);
    const projection = projectAnalysisForCandles(analysis, PA_SAMPLE_CANDLES.filter(candle => !missing.has(candle.timestamp)));
    expect(projection.priceAction.legs.some(item => item.id === analysis.priceAction.legs[0].id)).toBe(false);
    expect(projection.priceAction.patterns.some(item => item.id === analysis.priceAction.patterns[0].id)).toBe(false);
    expect(projection.priceAction.breakouts.some(item => item.id === analysis.priceAction.breakouts[0].id)).toBe(false);
    expect(projection.tradeSetups).toEqual([]);
    expect(projection.liquiditySweeps.every(item => !missing.has(item.levelTime) && !missing.has(item.sweepTime))).toBe(true);
  });

  it('has no drawable geometry on an empty chart, retaining the raw narrative for review', () => {
    const analysis = createMockAnalysis(PA_SAMPLE_CANDLES);
    const projection = projectAnalysisForCandles(analysis, []);
    expect(projection.structures).toEqual([]);
    expect(projection.priceAction).toMatchObject({ zones: [], legs: [], patterns: [], breakouts: [] });
    expect(projection.liquiditySweeps).toEqual([]);
    expect(projection.tradeSetups).toEqual([]);
    expect(projection.opportunities).toEqual([]);
    expect(projection.summary).toBe(analysis.summary);
  });

  it('hides a swing and its dependent opportunity when an exchange revises its source wick', () => {
    const analysis = createMockAnalysis(SAMPLE_CANDLES);
    const swing = analysis.structures.find(item => ['HH', 'HL', 'LH', 'LL'].includes(item.type))!;
    analysis.opportunities = [{ ...analysis.opportunities[0], id: 'revised-pivot-watch', structureIds: [swing.id] }];
    analysis.tradeSetups = [{ ...analysis.tradeSetups[0], structureIds: [swing.id], opportunityId: 'revised-pivot-watch' }];
    const revised = SAMPLE_CANDLES.map(candle => candle.timestamp === swing.startTime ? { ...candle, high: candle.high + 1, low: candle.low - 1 } : candle);
    const projection = projectAnalysisForCandles(analysis, revised, SAMPLE_CANDLES);
    expect(projection.structures.some(item => item.id === swing.id)).toBe(false);
    expect(projection.opportunities).toEqual([]);
    expect(projection.tradeSetups).toEqual([]);
    expect(analysis.structures.some(item => item.id === swing.id)).toBe(true);
  });

  it('hides a PA candle shape, leg and touched zone when their analyzed OHLC geometry was corrected', () => {
    const analysis = createMockAnalysis(PA_SAMPLE_CANDLES);
    const pattern = analysis.priceAction.patterns[0];
    const leg = analysis.priceAction.legs[0];
    const breakout = analysis.priceAction.breakouts[0];
    const zone = analysis.priceAction.zones.find(item => item.id === breakout.zoneId)!;
    const affectedTimes = new Set([pattern.endTime, leg.endTime, zone.touchTimes[0]]);
    const revised = PA_SAMPLE_CANDLES.map(candle => affectedTimes.has(candle.timestamp) ? { ...candle, high: candle.high + 1, low: candle.low - 1 } : candle);
    const projection = projectAnalysisForCandles(analysis, revised, PA_SAMPLE_CANDLES);
    expect(projection.priceAction.patterns.some(item => item.id === pattern.id)).toBe(false);
    expect(projection.priceAction.legs.some(item => item.id === leg.id)).toBe(false);
    expect(projection.priceAction.zones.some(item => item.id === zone.id)).toBe(false);
    expect(projection.priceAction.breakouts.some(item => item.id === breakout.id)).toBe(false);
  });

  it('hides a liquidity sweep when its recorded extremum no longer matches corrected source bars', () => {
    const analysis = createMockAnalysis(SAMPLE_CANDLES);
    const sweep = analysis.liquiditySweeps[0];
    expect(sweep).toBeDefined();
    const revised = SAMPLE_CANDLES.map(candle => candle.timestamp === sweep.sweepTime ? { ...candle, high: candle.high + 1, low: candle.low - 1 } : candle);
    expect(projectAnalysisForCandles(analysis, revised, SAMPLE_CANDLES).liquiditySweeps.some(item => item.id === sweep.id)).toBe(false);
  });

  it('retains code-drawn price geometry after a volume-only revision while freshness still flags the input change', () => {
    const analysis = createMockAnalysis(PA_SAMPLE_CANDLES);
    const revised = PA_SAMPLE_CANDLES.map(candle => ({ ...candle, volume: candle.volume + 1 }));
    expect(projectAnalysisForCandles(analysis, revised, PA_SAMPLE_CANDLES)).toEqual(analysis);
    const snapshot = createAnalysisSnapshot(PA_SAMPLE_CANDLES, identity, 'codex');
    expect(inspectAnalysisSnapshot(snapshot, revised).revisedBars).toBe(PA_SAMPLE_CANDLES.length);
  });
});
