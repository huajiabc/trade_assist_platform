import { describe, expect, it } from 'vitest';
import type { Analysis } from '../shared/analysis';
import type { Candle } from '../shared/market';
import { summarizeAnalysisAnnotations } from '../src/analysisCoverage';

const candles: Candle[] = Array.from({ length: 30 }, (_, index) => ({
  timestamp: 1_700_000_000 + index * 300, open: 100, high: 102, low: 98, close: 101, volume: 100,
}));
const time = (index: number) => candles[index].timestamp;
const empty = (): Analysis => ({
  schemaVersion: '1.2', trend: 'neutral', bias: 'neutral', summary: '分析结果',
  structures: [], keyLevels: [], opportunities: [], tradeSetups: [], liquiditySweeps: [], uncertainties: ['存在不确定性'],
  priceAction: { regime: 'range', summary: 'PA 分析', zones: [], legs: [], patterns: [], breakouts: [] },
});
const structure = (first: number, last: number): Analysis['structures'][number] => ({
  id: `structure-${first}-${last}`, type: 'BOS', status: 'candidate', direction: 'bullish', startTime: time(first), endTime: time(last),
  price: 100, priceEnd: null, rationale: '依据', invalidation: '失效',
});
const zone = (first: number, last: number): Analysis['priceAction']['zones'][number] => ({
  id: 'zone', kind: 'support', status: 'candidate', title: '支撑区域', startTime: time(first), endTime: time(last),
  lowerPrice: 98, upperPrice: 100, touchTimes: [time(first)], rationale: '依据', invalidation: '失效',
});
const counts = (analysis: Analysis, input = candles) => summarizeAnalysisAnnotations(analysis, input).segments.map(segment => segment.count);

describe('returned historical annotation distribution', () => {
  it('shows trailing-only annotations without claiming the earlier candles were examined or empty', () => {
    const analysis = empty();
    analysis.structures = [structure(23, 23), structure(26, 28)];
    expect(counts(analysis)).toEqual([0, 0, 2]);
    expect(summarizeAnalysisAnnotations(analysis, candles).total).toBe(2);
  });

  it('counts a cross-segment area exactly once at its end, never in every intersected segment', () => {
    const analysis = empty();
    analysis.priceAction.zones = [zone(0, 29)];
    expect(counts(analysis)).toEqual([0, 0, 1]);
  });

  it('buckets every historical SMC, PA and liquidity category by structure end or event time', () => {
    const analysis = empty();
    analysis.structures = [structure(0, 9)];
    analysis.priceAction.zones = [zone(0, 7)];
    analysis.priceAction.legs = [{ id: 'leg', kind: 'impulse', status: 'confirmed', title: '推动', direction: 'bullish',
      startTime: time(5), endTime: time(13), startPrice: 98, endPrice: 102, rationale: '依据', invalidation: '失效' }];
    analysis.priceAction.patterns = [{ id: 'pattern', kind: 'inside-bar', status: 'confirmed', title: '内包线', direction: 'neutral',
      startTime: time(18), endTime: time(19), rationale: '依据', invalidation: '失效' }];
    analysis.priceAction.breakouts = [{ id: 'breakout', zoneId: 'zone', direction: 'bullish', status: 'candidate', title: '突破回踩',
      breakoutTime: time(15), retestTime: time(22), confirmationTime: time(25), rationale: '依据', invalidation: '失效' }];
    analysis.liquiditySweeps = [{ id: 'sweep', side: 'sell-side', levelTime: time(3), sweepTime: time(27), levelPrice: 99,
      extremePrice: 98, status: 'confirmed', rationale: '依据', invalidation: '失效' }];
    expect(counts(analysis)).toEqual([2, 3, 1]);
    expect(summarizeAnalysisAnnotations(analysis, candles).total).toBe(6);
  });

  it('uses actual candle indices rather than dividing the elapsed clock time', () => {
    const irregular = candles.map((candle, index) => ({ ...candle, timestamp: candle.timestamp + (index >= 5 ? 86_400 * 10 : 0) }));
    const analysis = empty();
    analysis.structures = [{ ...structure(8, 9), startTime: irregular[8].timestamp, endTime: irregular[9].timestamp }];
    expect(counts(analysis, irregular)).toEqual([1, 0, 0]);
    const result = summarizeAnalysisAnnotations(analysis, irregular);
    expect(result.segments.map(segment => [segment.from, segment.to, segment.barCount])).toEqual([
      [irregular[0].timestamp, irregular[9].timestamp, 10], [irregular[10].timestamp, irregular[19].timestamp, 10],
      [irregular[20].timestamp, irregular[29].timestamp, 10],
    ]);
  });

  it('requires real endpoints and correct endpoint order; it never snaps absent times', () => {
    const analysis = empty();
    analysis.structures = [{ ...structure(0, 5), startTime: time(0) + 1 }, { ...structure(12, 15), endTime: time(15) + 1 },
      { ...structure(23, 24), startTime: time(25) }];
    expect(counts(analysis)).toEqual([0, 0, 0]);
  });

  it('excludes a zone with a missing touch and its dependent breakout', () => {
    const analysis = empty();
    analysis.priceAction.zones = [{ ...zone(0, 8), touchTimes: [time(1) + 1] }];
    analysis.priceAction.breakouts = [{ id: 'breakout', zoneId: 'zone', direction: 'bullish', status: 'candidate', title: '突破',
      breakoutTime: time(15), retestTime: null, confirmationTime: null, rationale: '依据', invalidation: '失效' }];
    expect(counts(analysis)).toEqual([0, 0, 0]);
  });

  it('requires optional breakout phase coordinates and the sweep source coordinate to exist', () => {
    const analysis = empty();
    analysis.priceAction.zones = [zone(0, 8)];
    analysis.priceAction.breakouts = [{ id: 'breakout', zoneId: 'zone', direction: 'bullish', status: 'candidate', title: '突破',
      breakoutTime: time(15), retestTime: time(22) + 1, confirmationTime: null, rationale: '依据', invalidation: '失效' }];
    analysis.liquiditySweeps = [{ id: 'sweep', side: 'buy-side', levelTime: time(0) - 300, sweepTime: time(27), levelPrice: 101,
      extremePrice: 102, status: 'candidate', rationale: '依据', invalidation: '失效' }];
    expect(counts(analysis)).toEqual([1, 0, 0]);
  });

  it('counts a valid breakout once when retest and confirmation occur on the same real candle', () => {
    const analysis = empty();
    analysis.priceAction.zones = [zone(0, 8)];
    analysis.priceAction.breakouts = [{ id: 'breakout', zoneId: 'zone', direction: 'bullish', status: 'confirmed', title: '突破回踩',
      breakoutTime: time(15), retestTime: time(22), confirmationTime: time(22), rationale: '依据', invalidation: '失效' }];
    expect(counts(analysis)).toEqual([1, 1, 0]);
    expect(summarizeAnalysisAnnotations(analysis, candles).total).toBe(2);
  });

  it('excludes confirmation without a retest, or a retest at the breakout candle', () => {
    const analysis = empty();
    analysis.priceAction.zones = [zone(0, 8)];
    const event: Analysis['priceAction']['breakouts'][number] = { id: 'breakout', zoneId: 'zone', direction: 'bullish', status: 'candidate', title: '突破回踩',
      breakoutTime: time(15), retestTime: null, confirmationTime: time(22), rationale: '依据', invalidation: '失效' };
    analysis.priceAction.breakouts = [event];
    expect(counts(analysis)).toEqual([1, 0, 0]);
    analysis.priceAction.breakouts = [{ ...event, retestTime: time(15), confirmationTime: null }];
    expect(counts(analysis)).toEqual([1, 0, 0]);
  });

  it('does not count current candidate trade plans, text opportunities or untimed key levels', () => {
    const analysis = empty();
    analysis.keyLevels = [{ label: '关键价位', price: 100, reason: '依据' }];
    analysis.opportunities = [{ id: 'opportunity', direction: 'bullish', trigger: '条件', invalidation: '失效', target: '目标', risk: '风险', structureIds: ['structure'] }];
    analysis.tradeSetups = [{ id: 'trade', opportunityId: 'opportunity', status: 'candidate', direction: 'bullish', anchorTime: time(26),
      entry: 100, stopLoss: 98, targets: [{ label: '目标', price: 104 }], structureIds: ['structure'], rationale: '依据', invalidation: '失效' }];
    expect(counts(analysis)).toEqual([0, 0, 0]);
  });

  it.each([1, 2, 9])('uses one real, nonempty segment for a short %i-bar window', length => {
    const input = candles.slice(0, length);
    const result = summarizeAnalysisAnnotations(empty(), input);
    expect(result.segments).toEqual([{ key: 'all', label: '全段', from: input[0].timestamp, to: input.at(-1)!.timestamp, barCount: length, count: 0 }]);
  });

  it('splits a minimum valid ten-bar window into three nonempty index ranges', () => {
    const result = summarizeAnalysisAnnotations(empty(), candles.slice(0, 10));
    expect(result.segments.map(segment => segment.barCount)).toEqual([3, 3, 4]);
    expect(result.segments.map(segment => segment.key)).toEqual(['front', 'middle', 'back']);
  });

  it('handles absent, unordered, duplicated and invalid timestamps without inventing a distribution', () => {
    expect(summarizeAnalysisAnnotations(empty(), [])).toEqual({ segments: [], total: 0, invalidInput: false });
    for (const input of [[...candles].reverse(), [candles[0], candles[0]], [{ ...candles[0], timestamp: Number.NaN }]]) {
      expect(summarizeAnalysisAnnotations(empty(), input)).toEqual({ segments: [], total: 0, invalidInput: true });
    }
  });

  it('does not mutate the original analysis or input snapshot', () => {
    const analysis = empty();
    analysis.priceAction.zones = [zone(0, 29)];
    const before = structuredClone({ analysis, candles });
    summarizeAnalysisAnnotations(analysis, candles);
    expect({ analysis, candles }).toEqual(before);
  });
});
