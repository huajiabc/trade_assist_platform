import { describe, expect, it } from 'vitest';
import { buildStrategyTrigger } from '../shared/strategyTriggers';
import { STRATEGY_IDS, type StrategyId } from '../shared/strategyTypes';
import { tradeTrackingSchema } from '../shared/tradeTracking';
import { AS_OF, researchBundle, strategyFacts } from './research-fixtures';
import type { ResearchFact } from '../shared/researchData';

type Input = Parameters<typeof buildStrategyTrigger>[0];

/** Explicit evidence contracts exercise trigger generation; these are not
 * detector-accuracy fixtures, performance estimates, historical fills or orders. */
function inputFor(strategyId: StrategyId): Input {
  const bundle = researchBundle(), facts = strategyFacts();
  const base = facts[3];
  const reaction: ResearchFact = { ...base, id: 'five-reverse', rawId: 'five-reverse', type: 'CHoCH',
    formedAt: AS_OF - 600, knownAt: AS_OF - 600, confirmedAt: AS_OF - 600 };
  const range: ResearchFact = { ...base, id: 'range', rawId: 'range', timeframe: '15m', type: 'trading-range', direction: 'neutral',
    low: 96, high: 118, originTime: AS_OF - 3600, formedAt: AS_OF - 1800, knownAt: AS_OF - 1800, confirmedAt: AS_OF - 1800 };
  let primary: ResearchFact = base;
  if (strategyId === 'sweep-reclaim') primary = { ...base, id: 'sweep', type: 'sweep', reclaimTime: AS_OF - 900 };
  if (strategyId === 'trend-pullback') primary = { ...base, id: 'zone', type: 'OB', low: 98, high: 100,
    confirmedAt: null, status: 'candidate', reactionTime: AS_OF - 600, tests: 1 };
  if (strategyId === 'range-reversal') primary = { ...base, id: 'range-sweep', type: 'sweep', low: 95, high: 101, reclaimTime: AS_OF - 900 };
  if (strategyId === 'failed-breakout') primary = { ...base, id: 'failure', type: 'failed-breakout',
    breakoutTime: AS_OF - 1200, failureTime: AS_OF - 900, formedAt: AS_OF - 900, confirmedAt: AS_OF - 600,
    knownAt: AS_OF - 600, reactionTime: AS_OF - 600 };
  if (strategyId === 'displacement-continuation') primary = { ...base, id: 'displacement', type: 'displacement', low: 95, high: 104,
    originTime: AS_OF - 1200, reactionTime: AS_OF - 600, tests: 1, volumeRatio: 1.5, displacementAtr: 2, zoneLow: 100.25, zoneHigh: 100.75 };
  facts.push(primary, reaction, range);
  return { strategyId, direction: 'bullish', primary, local: facts[5], reaction, range,
    bundle, facts, stop: facts[4], expiresAfterBars: 20 };
}

const specFor = (id: StrategyId) => buildStrategyTrigger(inputFor(id)).spec!;

describe('strategy-specific closed-bar trigger contracts', () => {
  it.each(STRATEGY_IDS)('%s uses only bounded real anchors and valid tracking DSL', strategyId => {
    const input = inputFor(strategyId), original = structuredClone(input);
    const result = buildStrategyTrigger(input);
    expect(result.spec, result.reason).not.toBeNull();
    const spec = result.spec!;
    expect(spec.strategyId).toBe(strategyId);
    expect(spec.entryLow).toBeLessThanOrEqual(input.local.low);
    expect(spec.entryHigh).toBeGreaterThanOrEqual(input.local.low);
    expect(spec.entryHigh - spec.entryLow).toBeLessThanOrEqual(2);
    expect(spec.evidenceIds).toEqual(expect.arrayContaining([input.primary.id, input.local.id, input.stop.id]));
    expect(spec.evidenceIds).toHaveLength(new Set(spec.evidenceIds).size);
    expect(spec.knownAt).toBeLessThanOrEqual(input.bundle.asOf);
    expect(spec.tracking.expiresAfterBars).toBe(20);
    expect(tradeTrackingSchema.safeParse(spec.tracking).success).toBe(true);
    expect(spec.tracking.steps.length).toBeGreaterThanOrEqual(2);
    expect(spec.tracking.steps.every(step => step.conditions.length <= 3)).toBe(true);
    expect(input).toEqual(original);
  });

  it('B requires a new retest, a later holding close, and separate renewed continuation', () => {
    const spec = specFor('bos-retest');
    expect(spec.entryLow).toBe(99.5); expect(spec.entryHigh).toBe(100.5);
    expect(spec.confirmationPrice).toBe(101);
    expect(spec.tracking.steps.map(step => step.conditions)).toEqual([
      [{ type: 'touch-zone', price: 99.5, priceEnd: 100.5 }],
      [{ type: 'close-above', price: 100, priceEnd: null }],
      [{ type: 'close-above', price: 101, priceEnd: null }],
    ]);
    expect(spec.tracking.cancellation).toMatchObject({ basis: 'close', price: 95 });
  });

  it('supports confirmed local BOS and CHoCH without requiring a single label', () => {
    const input = inputFor('bos-retest');
    input.local.type = 'CHoCH';
    expect(buildStrategyTrigger(input).spec).not.toBeNull();
  });

  it('mirrors price directions for bearish BOS continuation', () => {
    const input = inputFor('bos-retest');
    input.direction = 'bearish';
    for (const frame of Object.values(input.bundle.frames)) for (const bar of frame.candles) {
      const high = bar.high; bar.high = 200 - bar.low; bar.low = 200 - high;
      bar.open = 200 - bar.open; bar.close = 200 - bar.close;
    }
    for (const fact of new Set([...input.facts, input.primary, input.local, input.stop])) {
      const high = fact.high; fact.high = 200 - fact.low; fact.low = 200 - high;
      if (fact.direction !== 'neutral') fact.direction = fact.direction === 'bullish' ? 'bearish' : 'bullish';
    }
    const result = buildStrategyTrigger(input);
    expect(result.spec, result.reason).not.toBeNull();
    expect(result.spec!.confirmationPrice).toBe(99);
    expect(result.spec!.tracking.steps[1].conditions).toEqual([{ type: 'close-below', price: 100, priceEnd: null }]);
    expect(result.spec!.tracking.cancellation.price).toBe(105);
  });

  it('A protects an actual reclaim reference and refuses to guess a nonpoint sweep anchor', () => {
    const input = inputFor('sweep-reclaim');
    input.primary.low = 95; input.primary.high = 101;
    expect(buildStrategyTrigger(input).spec).toBeNull();
    const reference: ResearchFact = { ...input.stop, id: 'known-liquidity', type: 'liquidity-low', direction: 'neutral',
      low: 98, high: 98, originTime: input.primary.originTime, formedAt: AS_OF - 1200,
      confirmedAt: AS_OF - 1200, knownAt: AS_OF - 1200 };
    input.facts.push(reference);
    const result = buildStrategyTrigger(input);
    expect(result.spec, result.reason).not.toBeNull();
    expect(result.spec!.evidenceIds).toContain(reference.id);
    expect(result.spec!.tracking.steps[0].conditions).toContainEqual({ type: 'close-above', price: 98, priceEnd: null });
    input.reaction!.knownAt = input.primary.reclaimTime!;
    expect(buildStrategyTrigger(input).reason).toContain('之后');
  });

  it('A does not convert an unreclaimed crossing into a reversal trigger', () => {
    const input = inputFor('sweep-reclaim'); input.primary.reclaimTime = null;
    expect(buildStrategyTrigger(input).spec).toBeNull();
    expect(buildStrategyTrigger(input).reason).toContain('尚未完成');
  });

  it('C uses the actual 5m zone as prior evidence while retesting only a local 1m area', () => {
    const input = inputFor('trend-pullback');
    input.primary.low = 95; input.primary.high = 99;
    const result = buildStrategyTrigger(input);
    expect(result.spec, result.reason).not.toBeNull();
    const spec = result.spec!;
    expect(spec.entryLow).toBe(99.5); expect(spec.entryHigh).toBe(100.5);
    expect(spec.tracking.steps[1].conditions).toContainEqual({ type: 'close-above', price: 99, priceEnd: null });
    expect(spec.tracking.steps.flatMap(step => step.conditions).filter(condition => condition.type === 'touch-zone'))
      .toEqual([{ type: 'touch-zone', price: 99.5, priceEnd: 100.5 }]);
    expect(spec.evidenceIds).toContain(input.primary.id);
  });

  it('C prefers a known small local FVG/OB and rejects unverified 5m zone reactions', () => {
    const input = inputFor('trend-pullback');
    const localZone: ResearchFact = { ...input.local, id: 'local-fvg', type: 'FVG', low: 99.8, high: 100.1, knownAt: AS_OF - 120,
      formedAt: AS_OF - 120, confirmedAt: null, status: 'candidate' };
    input.facts.push(localZone);
    expect(buildStrategyTrigger(input).spec).toMatchObject({ entryLow: 99.8, entryHigh: 100.1 });
    expect(buildStrategyTrigger(input).spec!.evidenceIds).toContain(localZone.id);
    input.primary.low = 90; input.primary.high = 92;
    expect(buildStrategyTrigger(input).spec).toBeNull();
    input.primary.low = 98; input.primary.high = 100; input.primary.reactionTime = AS_OF + 300;
    expect(buildStrategyTrigger(input).spec).toBeNull();
  });

  it('D requires interior closes while confirmation still stays near the range edge', () => {
    const spec = specFor('range-reversal');
    expect(spec.evidenceIds).toContain('range');
    expect(spec.tracking.steps[0].conditions).toEqual([
      { type: 'touch-zone', price: 99.5, priceEnd: 100.5 },
      { type: 'close-above', price: 96, priceEnd: null },
      { type: 'close-below', price: 118, priceEnd: null },
    ]);
    expect(spec.tracking.steps[1].conditions).toEqual([
      { type: 'close-above', price: 101, priceEnd: null },
      { type: 'close-below', price: 101.5, priceEnd: null },
    ]);
    const input = inputFor('range-reversal'); input.local.low = 108; input.local.high = 108;
    const confirmation = input.bundle.frames['1m'].candles.find(bar => bar.timestamp + 60 === input.local.confirmedAt)!;
    confirmation.low = 107; confirmation.high = 109;
    expect(buildStrategyTrigger(input).spec).toBeNull();
    expect(buildStrategyTrigger(input).reason).toContain('中部');
  });

  it('E retains the failed-breakout side and cancels at a real failure-candle protection', () => {
    const input = inputFor('failed-breakout'); input.stop.low = 90; input.stop.high = 90;
    const spec = buildStrategyTrigger(input).spec!;
    expect(spec.tracking.steps[0].conditions).toContainEqual({ type: 'close-above', price: 100, priceEnd: null });
    expect(spec.tracking.cancellation.price).toBe(95);
    expect(spec.tracking.cancellation.label).toContain('失败');
    input.primary.failureTime = AS_OF - 300;
    expect(buildStrategyTrigger(input).spec).toBeNull();
    input.primary.failureTime = AS_OF - 900; input.primary.breakoutTime = AS_OF - 900;
    expect(buildStrategyTrigger(input).spec).toBeNull();
  });

  it('F preserves a separate real displacement-zone hold before local continuation', () => {
    const spec = specFor('displacement-continuation');
    expect(spec.tracking.steps).toHaveLength(3);
    expect(spec.tracking.steps[1].conditions).toContainEqual({ type: 'close-above', price: 100.75, priceEnd: null });
    expect(spec.tracking.steps[2].conditions).toEqual([{ type: 'close-above', price: 101, priceEnd: null }]);
    const input = inputFor('displacement-continuation'); input.primary.tests = 2;
    expect(buildStrategyTrigger(input).spec).toBeNull();
    input.primary.tests = 1; input.primary.volumeRatio = 1;
    expect(buildStrategyTrigger(input).spec).toBeNull();
  });

  it('F can derive its existing 25–75% body zone only from an actual supplied displacement candle', () => {
    const input = inputFor('displacement-continuation'); delete input.primary.zoneLow; delete input.primary.zoneHigh;
    expect(buildStrategyTrigger(input).spec!.tracking.steps[1].conditions).toContainEqual({ type: 'close-above', price: 100.75, priceEnd: null });
    input.primary.originTime = AS_OF - 20000;
    expect(buildStrategyTrigger(input).spec).toBeNull();
    expect(buildStrategyTrigger(input).reason).toContain('真实位移');
  });

  it('does not let distant 5m levels expand a local retest into a remote entry area', () => {
    const input = inputFor('bos-retest'); input.primary.low = 95; input.primary.high = 95;
    expect(buildStrategyTrigger(input).spec).toBeNull();
    expect(buildStrategyTrigger(input).reason).toContain('远离');
  });

  it('ignores forming candles and future unused zones instead of leaking their extremes', () => {
    const input = inputFor('bos-retest'), before = buildStrategyTrigger(input).spec;
    input.bundle.frames['1m'].candles.push({ timestamp: AS_OF, open: 100, high: 1000, low: 1, close: 900, volume: 1 });
    input.facts.push({ ...input.local, id: 'future-zone', type: 'OB', knownAt: AS_OF + 60, low: 99.99, high: 100.01 });
    expect(buildStrategyTrigger(input).spec).toEqual(before);
    input.local.knownAt = AS_OF + 60;
    expect(buildStrategyTrigger(input).spec).toBeNull();
  });

  it('requires actual confirmation coordinates, continuous volatility and bounded waiting time', () => {
    const missing = inputFor('bos-retest'); missing.local.confirmedAt = AS_OF - 61;
    expect(buildStrategyTrigger(missing).spec).toBeNull();
    const gap = inputFor('bos-retest'); gap.bundle.frames['1m'].candles.splice(10, 1);
    expect(buildStrategyTrigger(gap).spec).toBeNull();
    for (const expiresAfterBars of [0, 301, 1.5]) expect(buildStrategyTrigger({ ...inputFor('bos-retest'), expiresAfterBars }).spec).toBeNull();
  });
});
