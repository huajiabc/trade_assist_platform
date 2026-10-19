import { describe, expect, it } from 'vitest';
import { buildRuleIndicatorReference, MAX_RULE_INDICATOR_REFERENCES, selectRuleIndicatorReferences } from '../shared/indicatorReference';
import { detectRuleIndicators, RULE_INDICATOR_PARAMETERS, type RuleIndicatorZone } from '../shared/indicators';
import type { Candle } from '../shared/market';

const START = 1_700_000_000;
const candle = (index: number, open: number, high: number, low: number, close: number): Candle => ({
  timestamp: START + index * 300, open, high, low, close, volume: 10,
});
const orderBlockCandles = (): Candle[] => [
  candle(0, 10, 11, 9, 10), candle(1, 11, 13, 10, 12), candle(2, 12, 15, 11, 14),
  candle(3, 14, 14, 11, 12), candle(4, 12, 14, 11, 13), candle(5, 13, 17, 12, 16),
];

function zone(index: number, type: 'FVG' | 'OB', status: RuleIndicatorZone['status'] = 'active'): RuleIndicatorZone {
  const formedAt = START + index * 300;
  return {
    id: `${type.toLowerCase()}-${index.toString().padStart(4, '0')}`,
    type, status, direction: 'bullish', originTime: formedAt - 600, formedAt, endTime: formedAt + 300,
    lowerPrice: 10, upperPrice: 12, midpoint: 11, firstTouchTime: null,
    resolvedTime: status === 'filled' || status === 'invalidated' ? formedAt + 300 : null,
    mitigation: status === 'filled' || status === 'invalidated' ? 1 : 0,
    rationale: '规则候选，仅用于引用选择测试。', invalidation: '边界条件测试。',
    evidenceTimes: [formedAt - 600, formedAt - 300, formedAt],
  };
}

describe('rule-indicator reference snapshot', () => {
  it('recomputes exact numerical values and temporal metadata from the selected closed OHLCV', () => {
    const input = orderBlockCandles();
    const actual = buildRuleIndicatorReference(input);
    const expected = detectRuleIndicators(input);
    expect(actual).toMatchObject({ source: 'deterministic-ohlcv-rules', version: '1.0',
      asOf: input[5].timestamp, candleCount: 6, parameters: RULE_INDICATOR_PARAMETERS,
      totalDetected: expected.zones.length, providedCount: expected.zones.length, omittedCount: 0,
    });
    expect(actual.zones).toEqual(expected.zones);
    expect(actual.zones.find(item => item.type === 'OB')).toMatchObject({
      lowerPrice: 12, upperPrice: 14, midpoint: 13, originTime: input[3].timestamp,
      formedAt: input[5].timestamp, endTime: input[5].timestamp,
      evidenceTimes: [input[2].timestamp, input[3].timestamp, input[4].timestamp, input[5].timestamp],
    });
    expect(actual.limitations).toContain('formedAt');
    expect(actual.limitations).toContain('收盘后才可使用');
  });

  it('does not reuse a later tested or invalidated state when analyzing an earlier prefix', () => {
    const initial = orderBlockCandles();
    const loaded = [...initial, candle(6, 16, 17, 13, 15), candle(7, 15, 16, 10, 11)];
    const latestOb = buildRuleIndicatorReference(loaded).zones.find(item => item.type === 'OB')!;
    expect(latestOb.status).toBe('invalidated');
    expect(latestOb.resolvedTime).toBe(loaded[7].timestamp);
    const selected = buildRuleIndicatorReference(loaded.slice(0, 6));
    expect(selected.asOf).toBe(initial[5].timestamp);
    expect(selected.zones.find(item => item.id === latestOb.id)).toMatchObject({
      status: 'active', firstTouchTime: null, resolvedTime: null, mitigation: 0, endTime: initial[5].timestamp,
    });
    const selectedTimes = new Set(initial.map(item => item.timestamp));
    for (const reference of selected.zones) {
      expect(selectedTimes.has(reference.originTime)).toBe(true);
      expect(selectedTimes.has(reference.formedAt)).toBe(true);
      expect(selectedTimes.has(reference.endTime)).toBe(true);
      expect(reference.evidenceTimes.every(time => selectedTimes.has(time))).toBe(true);
      expect(reference.evidenceTimes.every(time => time <= reference.formedAt)).toBe(true);
    }
  });

  it('does not borrow a pivot or OB origin from before the local analysis window', () => {
    const loaded = [...orderBlockCandles(), candle(6, 16, 17, 15, 16), candle(7, 16, 17, 15, 16)];
    expect(buildRuleIndicatorReference(loaded).zones.some(item => item.type === 'OB')).toBe(true);
    // The break remains inside the selection, but its confirmed pivot does not.
    const selected = loaded.slice(3);
    const local = buildRuleIndicatorReference(selected);
    expect(local.zones.filter(item => item.type === 'OB')).toEqual([]);
    expect(local.asOf).toBe(selected.at(-1)!.timestamp);
    expect(local.candleCount).toBe(selected.length);
    const times = new Set(selected.map(item => item.timestamp));
    expect(local.zones.every(item => item.evidenceTimes.every(time => times.has(time)))).toBe(true);
  });

  it('requires all three local candles for an FVG and recalculates exact microprice bounds', () => {
    const input = [candle(0, 10, 11, 9, 10), candle(1, 10, 14, 10, 13), candle(2, 14, 15, 13, 14)]
      .map(item => ({ ...item, open: item.open * 1e-14, high: item.high * 1e-14,
        low: item.low * 1e-14, close: item.close * 1e-14 }));
    const actual = buildRuleIndicatorReference(input);
    expect(actual.zones).toHaveLength(1);
    expect(actual.zones[0].lowerPrice).toBe(input[0].high);
    expect(actual.zones[0].upperPrice).toBe(input[2].low);
    expect(actual.zones[0].formedAt).toBe(input[2].timestamp);
    expect(buildRuleIndicatorReference(input.slice(1)).zones).toEqual([]);
  });

  it('reports truncation counts while preserving engine metadata and full supplied history', () => {
    const input = Array.from({ length: 150 }, (_, index) => candle(index,
      10 + index * 3, 11 + index * 3, 9 + index * 3, 10.5 + index * 3));
    const detected = detectRuleIndicators(input);
    expect(detected.zones.length).toBeGreaterThan(32);
    const reference = buildRuleIndicatorReference(input);
    expect(reference.totalDetected).toBe(detected.zones.length);
    expect(reference.providedCount).toBe(reference.zones.length);
    expect(reference.omittedCount).toBe(detected.zones.length - reference.zones.length);
    expect(reference.candleCount).toBe(input.length);
    expect(reference.asOf).toBe(input.at(-1)!.timestamp);
    expect(reference.zones).toEqual(selectRuleIndicatorReferences(detected.zones));
    expect(reference.zones.every(item => detected.zones.some(original => JSON.stringify(item) === JSON.stringify(original)))).toBe(true);
  });

  it('returns an explicit empty snapshot instead of inventing indicator evidence', () => {
    expect(buildRuleIndicatorReference([])).toMatchObject({ source: 'deterministic-ohlcv-rules',
      asOf: null, candleCount: 0, totalDetected: 0, providedCount: 0, omittedCount: 0, zones: [],
    });
    expect(selectRuleIndicatorReferences([])).toEqual([]);
  });

  it('does not mutate frozen source candles or expose mutable source metadata', () => {
    const input = orderBlockCandles();
    const saved = structuredClone(input);
    input.forEach(Object.freeze);
    Object.freeze(input);
    const first = buildRuleIndicatorReference(input);
    const second = buildRuleIndicatorReference(input);
    expect(first).toEqual(second);
    expect(input).toEqual(saved);
    first.zones[0].evidenceTimes.push(123);
    first.zones[0].lowerPrice = 1;
    expect(buildRuleIndicatorReference(input)).toEqual(second);
  });
});

describe('bounded deterministic indicator reference selection', () => {
  it('caps 400 candidate references at 32 in total and at 16 for each family', () => {
    const input = Array.from({ length: 200 }, (_, index) => [zone(index, 'FVG'), zone(index, 'OB')]).flat();
    const selected = selectRuleIndicatorReferences(input);
    expect(MAX_RULE_INDICATOR_REFERENCES).toBe(32);
    expect(selected).toHaveLength(MAX_RULE_INDICATOR_REFERENCES);
    expect(selected.filter(item => item.type === 'FVG')).toHaveLength(16);
    expect(selected.filter(item => item.type === 'OB')).toHaveLength(16);
    expect(new Set(selected.map(item => item.id)).size).toBe(selected.length);
  });

  it('retains the latest current zones and distributes historical references across the complete history', () => {
    const input = (['FVG', 'OB'] as const).flatMap(type => [
      ...Array.from({ length: 100 }, (_, index) => zone(index, type, type === 'FVG' ? 'filled' : 'invalidated')),
      ...Array.from({ length: 100 }, (_, index) => zone(index + 100, type, type === 'FVG' ? 'partial' : 'tested')),
    ]);
    const selected = selectRuleIndicatorReferences(input);
    for (const type of ['FVG', 'OB'] as const) {
      const family = selected.filter(item => item.type === type);
      const current = family.filter(item => item.resolvedTime === null);
      const historical = family.filter(item => item.resolvedTime !== null);
      expect(current).toHaveLength(10);
      expect(historical).toHaveLength(6);
      expect(current.map(item => item.id)).toContain(zone(199, type).id);
      expect(current.map(item => item.id)).toContain(zone(100, type).id);
      expect(historical.map(item => item.id)).toContain(zone(0, type).id);
      expect(historical.map(item => item.id)).toContain(zone(99, type).id);
      expect(historical.some(item => item.formedAt > zone(25, type).formedAt && item.formedAt < zone(75, type).formedAt)).toBe(true);
    }
  });

  it('uses spare family capacity when one lifecycle group is small', () => {
    const onlyHistory = Array.from({ length: 100 }, (_, index) => zone(index, 'FVG', 'filled'));
    expect(selectRuleIndicatorReferences(onlyHistory)).toHaveLength(16);
    const onlyActive = Array.from({ length: 100 }, (_, index) => zone(index, 'OB'));
    expect(selectRuleIndicatorReferences(onlyActive)).toHaveLength(16);
    const mixed = [...onlyHistory, zone(100, 'FVG')];
    const selected = selectRuleIndicatorReferences(mixed);
    expect(selected).toHaveLength(16);
    expect(selected.some(item => item.id === zone(100, 'FVG').id)).toBe(true);
  });

  it('deduplicates identical indicator IDs before spending the reference budget', () => {
    const single = zone(0, 'FVG');
    const repeated = Array.from({ length: 40 }, () => structuredClone(single));
    const selected = selectRuleIndicatorReferences([...repeated, zone(1, 'OB')]);
    expect(selected.map(item => item.id)).toEqual([single.id, zone(1, 'OB').id]);
  });

  it('sorts consistently by formation time then ID regardless of input order', () => {
    const input = Array.from({ length: 100 }, (_, index) => [zone(index, 'OB'), zone(index, 'FVG')]).flat();
    const original = structuredClone(input);
    const sorted = selectRuleIndicatorReferences(input);
    expect(selectRuleIndicatorReferences([...input].reverse())).toEqual(sorted);
    expect(sorted).toEqual([...sorted].sort((a, b) => a.formedAt - b.formedAt || a.id.localeCompare(b.id)));
    expect(input).toEqual(original);
  });

  it('does not mutate frozen zone objects, evidence arrays or input array during selection', () => {
    const input = [zone(2, 'OB'), zone(0, 'FVG', 'filled'), zone(1, 'FVG')];
    const saved = structuredClone(input);
    input.forEach(item => { Object.freeze(item.evidenceTimes); Object.freeze(item); });
    Object.freeze(input);
    expect(() => selectRuleIndicatorReferences(input)).not.toThrow();
    expect(input).toEqual(saved);
  });
});
