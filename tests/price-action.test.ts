import { describe, expect, it } from 'vitest';
import { createMockAnalysis } from '../shared/mock';
import { validateAnalysis, validateAnalysisEnvelope, type Analysis } from '../shared/analysis';
import { detectPriceAction, emptyPriceAction, matchesPAPattern, validatePriceAction, type PriceAction } from '../shared/priceAction';
import { PA_SAMPLE_CANDLES } from '../shared/paSample';
import type { Candle } from '../shared/market';

const sample = () => createMockAnalysis(PA_SAMPLE_CANDLES);
const pa = () => sample().priceAction;
const valid = (value: PriceAction) => validatePriceAction(value, PA_SAMPLE_CANDLES, new Set());

describe('PA evidence and deterministic detection', () => {
  it('derives support/resistance, historical range, legs, three candle shapes, and a real breakout/retest from OHLCV', () => {
    const analysis = sample();
    expect(analysis.schemaVersion).toBe('1.2');
    expect(new Set(analysis.priceAction.zones.map(zone => zone.kind))).toEqual(new Set(['support', 'resistance', 'trading-range']));
    expect(new Set(analysis.priceAction.patterns.map(pattern => pattern.kind))).toEqual(new Set(['pin-bar', 'engulfing', 'inside-bar']));
    expect(new Set(analysis.priceAction.legs.map(leg => leg.kind))).toEqual(new Set(['impulse', 'pullback']));
    const event = analysis.priceAction.breakouts.find(item => item.zoneId === 'pa-trading-range')!;
    expect(event.status).toBe('confirmed');
    const zone = analysis.priceAction.zones.find(item => item.id === event.zoneId)!;
    const earlierCloses = PA_SAMPLE_CANDLES.filter(candle => candle.timestamp > zone.endTime && candle.timestamp < event.breakoutTime);
    expect(earlierCloses.every(candle => candle.close <= zone.upperPrice)).toBe(true);
    expect(PA_SAMPLE_CANDLES.find(candle => candle.timestamp === event.breakoutTime)!.close).toBeGreaterThan(zone.upperPrice);
    expect(event.retestTime).toBeGreaterThan(event.breakoutTime);
    expect(event.confirmationTime).toBe(event.retestTime);
    expect(analysis.priceAction.breakouts).toHaveLength(1);
    expect(event.zoneId).toBe('pa-trading-range'); // Same range/resistance phases render once.
    expect(event.breakoutTime).toBe(PA_SAMPLE_CANDLES[77].timestamp);
    expect(event.retestTime).toBe(PA_SAMPLE_CANDLES[78].timestamp);
    expect(analysis.priceAction.regime).toBe('uptrend'); // historical range has already broken
    expect(sample()).toEqual(analysis);
    expect(validateAnalysis(analysis, PA_SAMPLE_CANDLES)).toEqual(analysis);
  });

  it('retains a range regime only while current closes are still in the established range', () => {
    const input = PA_SAMPLE_CANDLES.slice(0, 70);
    const result = detectPriceAction(input);
    expect(result.zones.some(zone => zone.kind === 'trading-range')).toBe(true);
    expect(result.regime).toBe('range');
    expect(() => validatePriceAction(result, input, new Set())).not.toThrow();
  });

  it('handles flat and tiny prices without inventing PA observations', () => {
    for (const price of [100, 1e-14]) {
      const flat: Candle[] = Array.from({ length: 10 }, (_, index) => ({ timestamp: 1_700_000_000 + index * 60,
        open: price, close: price, high: price, low: price, volume: 0 }));
      const result = detectPriceAction(flat);
      expect(result.zones).toEqual([]);
      expect(result.legs).toEqual([]);
      expect(result.patterns).toEqual([]);
      expect(result.breakouts).toEqual([]);
      expect(() => validatePriceAction(result, flat, new Set())).not.toThrow();
    }
  });

  it('scales every PA price from supplied candles, including microprices', () => {
    for (const scale of [1e-14, 1000]) {
      const candles = PA_SAMPLE_CANDLES.map(candle => ({ ...candle, open: candle.open * scale, high: candle.high * scale,
        low: candle.low * scale, close: candle.close * scale }));
      const result = detectPriceAction(candles);
      expect(result.legs.length).toBeGreaterThan(0);
      expect(result.zones.length).toBeGreaterThan(0);
      expect(() => validatePriceAction(result, candles, new Set())).not.toThrow();
      expect(result.legs.every(leg => candles.some(candle => candle.high === leg.endPrice || candle.low === leg.endPrice))).toBe(true);
    }
  });

  it('marks a geometrically valid last candle as candidate when closure is unknown', () => {
    const candles = PA_SAMPLE_CANDLES.slice(0, 105);
    const result = detectPriceAction(candles);
    expect(result.patterns.find(pattern => pattern.id === 'pa-pin-bar-104')?.status).toBe('candidate');
  });

  it('allows opportunities and candidate plans to cite PA evidence without inventing SMC', () => {
    const analysis = sample();
    analysis.structures = [];
    analysis.opportunities = [{ id: 'pa-watch', direction: 'bullish', trigger: '等待独立触发', invalidation: '承接失效', target: '仅观察前高', risk: '波段确认滞后',
      structureIds: [analysis.priceAction.legs[0].id, analysis.priceAction.patterns[0].id] }];
    analysis.tradeSetups = [{ ...sample().tradeSetups[0], id: 'pa-plan', direction: 'bullish', entry: 117, stopLoss: 115,
      targets: [{ price: 121, label: '假设2R' }], opportunityId: 'pa-watch', structureIds: [analysis.priceAction.zones[0].id] }];
    expect(validateAnalysis(analysis, PA_SAMPLE_CANDLES).tradeSetups[0].structureIds).toEqual([analysis.priceAction.zones[0].id]);
  });

  it.each([
    ['PA across families', (analysis: Analysis) => { analysis.priceAction.patterns[0].id = analysis.priceAction.zones[0].id; }],
    ['PA/SMC', (analysis: Analysis) => { analysis.priceAction.patterns[0].id = analysis.structures[0].id; }],
    ['PA/opportunity', (analysis: Analysis) => { analysis.opportunities[0].id = analysis.priceAction.zones[0].id; }],
    ['PA/plan', (analysis: Analysis) => { analysis.tradeSetups[0].id = analysis.priceAction.zones[0].id; }],
    ['PA/sweep', (analysis: Analysis) => { analysis.liquiditySweeps = [{ id: analysis.priceAction.zones[0].id, side: 'buy-side', status: 'candidate', levelTime: 0, sweepTime: 1, levelPrice: 1, extremePrice: 2, rationale: 'Test', invalidation: 'Test' }]; }],
  ] as const)('uses one global unique ID namespace: %s', (_label, mutate) => {
    const analysis = sample();
    mutate(analysis);
    expect(() => validateAnalysis(analysis, PA_SAMPLE_CANDLES)).toThrow(/ID.*重复/);
  });

  it.each([
    ['future time', (value: PriceAction) => { value.zones[0].startTime += 1; }, /不存在的时间/],
    ['negative width', (value: PriceAction) => { value.zones[0].upperPrice = value.zones[0].lowerPrice; }, /价格边界/],
    ['out-of-range price', (value: PriceAction) => { value.zones[0].lowerPrice = 1; }, /价格边界/],
    ['reverse span', (value: PriceAction) => { [value.zones[0].startTime, value.zones[0].endTime] = [value.zones[0].endTime, value.zones[0].startTime]; }, /起始时间/],
    ['duplicate touches', (value: PriceAction) => { value.zones[0].touchTimes.push(value.zones[0].touchTimes[0]); }, /唯一、升序/],
    ['touch after formation', (value: PriceAction) => { value.zones[0].touchTimes.push(PA_SAMPLE_CANDLES[119].timestamp); }, /位于形成区间/],
    ['made-up touch', (value: PriceAction) => { value.zones[0].touchTimes = [PA_SAMPLE_CANDLES[24].timestamp, PA_SAMPLE_CANDLES[40].timestamp]; }, /边界证据/],
    ['single confirmed touch', (value: PriceAction) => { value.zones[0].touchTimes = value.zones[0].touchTimes.slice(0, 1); }, /至少两次/],
    ['one-sided range', (value: PriceAction) => { const zone = value.zones.find(item => item.kind === 'trading-range')!; zone.touchTimes = value.zones[0].touchTimes; }, /上下边界各两次/],
  ] as const)('rejects unsupported zones: %s', (_label, mutate, expected) => {
    const value = pa(); mutate(value);
    expect(() => valid(value)).toThrow(expected);
  });

  it('rejects a confirmed range that already closed outside during formation', () => {
    const value = pa();
    const candles = PA_SAMPLE_CANDLES.map((candle, index) => index === 30 ? { ...candle, close: 112, high: 113 } : candle);
    expect(() => validatePriceAction(value, candles, new Set())).toThrow(/形成期间已有收盘越界/);
  });

  it.each([
    ['rounded endpoint', (value: PriceAction) => { value.legs[0].startPrice += 0.1; }, /精确对应/],
    ['same-time leg', (value: PriceAction) => { value.legs[0].endTime = value.legs[0].startTime; }, /不同时间端点/],
    ['direction mismatch', (value: PriceAction) => { value.legs[0].direction = 'bearish'; }, /精确对应/],
    ['unconfirmed right edge', (value: PriceAction) => { const leg = value.legs[0]; leg.endTime = PA_SAMPLE_CANDLES.at(-1)!.timestamp; leg.endPrice = PA_SAMPLE_CANDLES.at(-1)!.high; }, /左右各 2 根/],
  ] as const)('rejects inaccurate leg geometry: %s', (_label, mutate, expected) => {
    const value = pa(); mutate(value);
    expect(() => valid(value)).toThrow(expected);
  });

  it.each([
    ['unknown zone', (value: PriceAction) => { value.breakouts[0].zoneId = 'no-zone'; }, /不存在的区域/],
    ['unconfirmed zone', (value: PriceAction) => { value.zones.find(zone => zone.id === value.breakouts[0].zoneId)!.status = 'candidate'; }, /尚未确认/],
    ['breakout before formation', (value: PriceAction) => { value.breakouts[0].breakoutTime = PA_SAMPLE_CANDLES[50].timestamp; }, /区域形成后的收盘越界/],
    ['later repeated breakout', (value: PriceAction) => { value.breakouts[0].breakoutTime = PA_SAMPLE_CANDLES[79].timestamp; }, /首次同向收盘越界/],
    ['retest on breakout', (value: PriceAction) => { value.breakouts[0].retestTime = value.breakouts[0].breakoutTime; }, /突破之后/],
    ['invented retest', (value: PriceAction) => { value.breakouts[0].retestTime = PA_SAMPLE_CANDLES[79].timestamp; }, /触达实际边界带/],
    ['confirmation before retest', (value: PriceAction) => { value.breakouts[0].confirmationTime = value.breakouts[0].breakoutTime; }, /已回踩且收盘保持/],
    ['confirmed without retest', (value: PriceAction) => { value.breakouts[0].retestTime = null; value.breakouts[0].confirmationTime = null; }, /只能是候选/],
  ] as const)('rejects invented breakout/retest evidence: %s', (_label, mutate, expected) => {
    const value = pa(); mutate(value);
    expect(() => valid(value)).toThrow(expected);
  });

  it('accepts a breakout waiting for retest as candidate and disallows premature confirmed status', () => {
    const value = pa();
    value.breakouts[0].status = 'candidate';
    value.breakouts[0].retestTime = null;
    value.breakouts[0].confirmationTime = null;
    expect(() => valid(value)).not.toThrow();
    value.breakouts[0].status = 'confirmed';
    expect(() => valid(value)).toThrow(/只能是候选/);
  });

  it('rejects a retest close back inside as stand-firm confirmation', () => {
    const value = pa(); value.zones = value.zones.filter(zone => zone.kind === 'trading-range'); value.breakouts = value.breakouts.slice(0, 1);
    const candles = PA_SAMPLE_CANDLES.map(candle => candle.timestamp === value.breakouts[0].retestTime ? { ...candle, close: 109.6 } : candle);
    expect(() => validatePriceAction({ ...value, legs: [], patterns: [] }, candles, new Set())).toThrow(/收盘保持/);
  });

  it('validates PA again on client envelope parsing and rejects unknown PA fields', () => {
    const analysis = sample();
    const envelope = { analysis, source: 'mock', model: 'test', analyzedBars: PA_SAMPLE_CANDLES.length, generatedAt: new Date().toISOString() };
    expect(validateAnalysisEnvelope(envelope, PA_SAMPLE_CANDLES).analysis.priceAction).toEqual(analysis.priceAction);
    expect(() => validateAnalysis({ ...analysis, priceAction: { ...analysis.priceAction, debug: true } }, PA_SAMPLE_CANDLES)).toThrow(/校验失败/);
    analysis.priceAction.patterns[0].endTime += 1;
    expect(() => validateAnalysisEnvelope(envelope, PA_SAMPLE_CANDLES)).toThrow(/不存在的时间/);
  });
});

describe('strict PA candle geometry', () => {
  const candle = (open: number, high: number, low: number, close: number, timestamp = 100): Candle => ({ timestamp, open, high, low, close, volume: 0 });
  it('requires a dominant rejection wick rather than a generic doji or zero-range candle', () => {
    expect(matchesPAPattern({ kind: 'pin-bar', direction: 'bullish' }, candle(8, 10, 0, 9), candle(8, 10, 0, 9), false)).toBe(true);
    expect(matchesPAPattern({ kind: 'pin-bar', direction: 'bearish' }, candle(1, 10, 0, 2), candle(1, 10, 0, 2), false)).toBe(true);
    expect(matchesPAPattern({ kind: 'pin-bar', direction: 'bullish' }, candle(5, 10, 0, 5), candle(5, 10, 0, 5), false)).toBe(false);
    expect(matchesPAPattern({ kind: 'pin-bar', direction: 'bullish' }, candle(5, 5, 5, 5), candle(5, 5, 5, 5), false)).toBe(false);
    expect(matchesPAPattern({ kind: 'pin-bar', direction: 'neutral' }, candle(8, 10, 0, 9), candle(8, 10, 0, 9), false)).toBe(false);
  });
  it('requires opposite-color adjacent engulfing bodies, with strict growth', () => {
    const first = candle(9, 10, 5, 6, 100);
    const second = candle(5, 11, 4, 10, 160);
    expect(matchesPAPattern({ kind: 'engulfing', direction: 'bullish' }, first, second, true)).toBe(true);
    expect(matchesPAPattern({ kind: 'engulfing', direction: 'bullish' }, first, second, false)).toBe(false);
    expect(matchesPAPattern({ kind: 'engulfing', direction: 'bearish' }, first, second, true)).toBe(false);
    expect(matchesPAPattern({ kind: 'engulfing', direction: 'bullish' }, first, candle(6, 11, 4, 9, 160), true)).toBe(false);
  });
  it('requires strict inner highs and lows for inside bars, remaining direction neutral', () => {
    const first = candle(5, 10, 0, 8, 100);
    expect(matchesPAPattern({ kind: 'inside-bar', direction: 'neutral' }, first, candle(5, 9, 1, 7, 160), true)).toBe(true);
    expect(matchesPAPattern({ kind: 'inside-bar', direction: 'bullish' }, first, candle(5, 9, 1, 7, 160), true)).toBe(false);
    expect(matchesPAPattern({ kind: 'inside-bar', direction: 'neutral' }, first, candle(5, 10, 1, 7, 160), true)).toBe(false);
  });
});
