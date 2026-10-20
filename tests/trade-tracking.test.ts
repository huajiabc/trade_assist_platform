import { describe, expect, it } from 'vitest';
import type { TradeSetup } from '../shared/analysis';
import type { Candle } from '../shared/market';
import { evaluateTradePlan, inferTrackingInterval, type TradeTrackingRule } from '../shared/tradeTracking';

const start = 1_790_000_000;
const bar = (index: number, overrides: Partial<Candle> = {}): Candle => ({ timestamp: start + index * 60,
  open: 100, high: 102, low: 98, close: 100, volume: 5, ...overrides });
const snapshot = Array.from({ length: 10 }, (_, index) => bar(index));
function setup(overrides: Partial<TradeSetup> = {}): TradeSetup {
  return { id: 'tracked', opportunityId: null, direction: 'bullish', status: 'candidate', basis: null, anchorTime: bar(9).timestamp,
    entry: 100, stopLoss: 95, targets: [{ price: 110, label: 'TP1' }, { price: 115, label: 'TP2' }], structureIds: ['basis'],
    trigger: '先触及99至101，再由更晚的K线收于102上方。', rationale: '结构参考', invalidation: '确认前收于97以下取消。',
    tracking: { steps: [
      { label: '触及回踩区域', conditions: [{ type: 'touch-zone', price: 99, priceEnd: 101 }] },
      { label: '后续收盘突破', conditions: [{ type: 'close-above', price: 102, priceEnd: null }] },
    ], cancellation: { basis: 'close', price: 97, label: '收盘达到取消边界' }, expiresAfterBars: 4 }, ...overrides };
}
const run = (future: Candle[], plan = setup()) => evaluateTradePlan(plan, snapshot, [...snapshot, ...future]);
const confirmed = () => [bar(10), bar(11, { close: 103, high: 104 })];
const oneStep = (extra: Partial<TradeTrackingRule> = {}) => ({ ...setup().tracking!,
  steps: [setup().tracking!.steps[1]], ...extra });

describe('auditable closed-bar plan tracking', () => {
  it('never evaluates the analysis snapshot itself or expires from wall-clock time', () => {
    expect(run([], setup({ tracking: oneStep() }))).toMatchObject({ phase: 'waiting', checkedBars: 0, events: [] });
  });
  it('keeps incomplete/legacy text-only plans manual', () => {
    expect(run(confirmed(), setup({ tracking: null }))).toMatchObject({ phase: 'manual', checkedBars: 0, triggeredAt: null });
  });
  it('requires a later candle for each sequential step, even if one candle satisfies both', () => {
    const first = run([bar(10, { close: 103, high: 104 })]);
    expect(first).toMatchObject({ phase: 'waiting', completedSteps: 1 });
    expect(run(confirmed())).toMatchObject({ phase: 'conditions-met', triggeredAt: bar(11).timestamp, completedSteps: 2 });
  });
  it('uses inclusive zone intersection but strict closing comparisons', () => {
    expect(run([bar(10, { low: 101, high: 103, open: 102, close: 102 }), bar(11, { close: 102 })])).toMatchObject({ phase: 'waiting', completedSteps: 1 });
  });
  it('requires all conditions of one step on the same closed bar', () => {
    const plan = setup({ tracking: oneStep({ steps: [{ label: '回踩并收复', conditions: [
      { type: 'touch-zone', price: 99, priceEnd: 101 }, { type: 'close-above', price: 102, priceEnd: null },
    ] }] }) });
    expect(run([bar(10), bar(11, { low: 103, high: 105, open: 104, close: 104 })], plan).phase).toBe('waiting');
    expect(run([bar(10, { close: 103, high: 104 })], plan).phase).toBe('conditions-met');
  });
  it('cancels before completing a simultaneous triggering candle', () => {
    const plan = setup({ tracking: oneStep({ cancellation: { basis: 'wick', price: 97, label: '先触取消线' } }) });
    expect(run([bar(10, { low: 96, high: 104, close: 103 })], plan)).toMatchObject({ phase: 'invalidated', completedSteps: 0, triggeredAt: null });
  });
  it('expires after the permitted number of actual closed bars', () => {
    const result = run([bar(10), bar(11), bar(12), bar(13)]);
    expect(result).toMatchObject({ phase: 'expired', checkedBars: 4, completedSteps: 1 });
    expect(result.events.at(-1)).toMatchObject({ type: 'expiry', time: bar(13).timestamp });
  });
  it('still allows confirmation on the final permitted waiting candle', () => {
    expect(run([bar(10), bar(11, { close: 103, high: 104 })], setup({ tracking: { ...setup().tracking!, expiresAfterBars: 2 } })).phase).toBe('conditions-met');
  });
  it('ignores SL/TP extremes on the confirmation candle because the condition becomes known at its close', () => {
    const result = run([bar(10, { close: 103, high: 116, low: 94 })], setup({ tracking: oneStep() }));
    expect(result.phase).toBe('conditions-met');
    expect(result.targetTimes).toEqual([null, null]);
    expect(result.events.map(event => event.type)).toEqual(['conditions-met']);
  });
  it('observes later targets once with their actual times and precise level prices', () => {
    const result = run([...confirmed(), bar(12, { high: 111, low: 100, close: 109 }), bar(13, { high: 116, low: 103, close: 114 })]);
    expect(result).toMatchObject({ phase: 'targets-touched', targetTimes: [bar(12).timestamp, bar(13).timestamp] });
    expect(result.events.filter(event => event.type === 'target').map(event => event.price)).toEqual([110, 115]);
  });
  it('reports a later stop touch without claiming a fill or realized loss', () => {
    const result = run([...confirmed(), bar(12, { low: 95 })]);
    expect(result.phase).toBe('stop-touched');
    expect(result.reason).toContain('不代表实际止损成交');
    expect(result.events.at(-1)).toMatchObject({ time: bar(12).timestamp, price: 95 });
  });
  it('marks simultaneous stop and new target coverage ambiguous without assigning target achievement', () => {
    const result = run([...confirmed(), bar(12, { low: 94, high: 116 })]);
    expect(result).toMatchObject({ phase: 'ambiguous', targetTimes: [null, null] });
    expect(result.events.at(-1)?.type).toBe('ambiguous');
  });
  it('preserves earlier unambiguous target events when a later candle is ambiguous', () => {
    const result = run([...confirmed(), bar(12, { low: 99, high: 111 }), bar(13, { low: 94, high: 116 })]);
    expect(result).toMatchObject({ phase: 'ambiguous', targetTimes: [bar(12).timestamp, null] });
  });
  it('mirrors cancellation, closing confirmation and target direction for shorts', () => {
    const plan = setup({ direction: 'bearish', stopLoss: 105, targets: [{ price: 90, label: '下方目标' }],
      tracking: { ...oneStep(), steps: [{ label: '下破确认', conditions: [{ type: 'close-below', price: 98, priceEnd: null }] }],
        cancellation: { basis: 'wick', price: 104, label: '反向穿越' } } });
    expect(run([bar(10, { close: 97, low: 96 }), bar(11, { low: 90, high: 100 })], plan).phase).toBe('targets-touched');
    expect(run([bar(10, { high: 104 })], plan).phase).toBe('invalidated');
  });
  it('pauses at missing first or later bars rather than skipping unseen history', () => {
    expect(run([bar(11)]).phase).toBe('needs-review');
    const partial = run([bar(10), bar(12, { close: 103, high: 104 })]);
    expect(partial).toMatchObject({ phase: 'needs-review', completedSteps: 1, checkedBars: 1 });
    expect(partial.events).toHaveLength(1);
  });
  it.each(['duplicate', 'out-of-order'])('rejects %s observations', kind => {
    expect(run(kind === 'duplicate' ? [bar(10), bar(10)] : [bar(10), bar(9), bar(11), bar(10)]).phase).toBe('needs-review');
  });
  it('requires a consistent original period and original anchor', () => {
    expect(inferTrackingInterval([bar(0), bar(2), bar(3)])).toBeNull();
    expect(evaluateTradePlan(setup(), [bar(0), bar(2), bar(3)], confirmed()).phase).toBe('needs-review');
    expect(run([], setup({ anchorTime: bar(8).timestamp })).phase).toBe('needs-review');
  });
  it('requires reanalysis when an overlapping original OHLC is corrected', () => {
    const corrected = snapshot.map((candle, index) => index === 3 ? { ...candle, close: 101 } : candle);
    expect(evaluateTradePlan(setup(), snapshot, [...corrected, ...confirmed()]).phase).toBe('needs-review');
  });
  it('does not invalidate price-only rules from volume-only revisions', () => {
    expect(evaluateTradePlan(setup(), snapshot, [...snapshot.map(candle => ({ ...candle, volume: 10 })), ...confirmed()]).phase).toBe('conditions-met');
  });
  it('recomputes corrected post-snapshot evidence without retaining stale target touches', () => {
    expect(run([...confirmed(), bar(12, { high: 111 })]).targetTimes[0]).not.toBeNull();
    expect(run([...confirmed(), bar(12, { high: 109 })]).targetTimes).toEqual([null, null]);
  });
  it('does not mutate the plan or supplied market data', () => {
    const plan = setup(); const data = [...snapshot, ...confirmed()]; const before = structuredClone({ plan, data });
    evaluateTradePlan(plan, snapshot, data);
    expect({ plan, data }).toEqual(before);
    expect(plan.status).toBe('candidate');
  });
});


describe('bounded replay observation window', () => {
  it('stops after 300 observation bars after confirmation, independently of the waiting expiry', () => {
    const plan = setup({ tracking: oneStep({ expiresAfterBars: 250 }) });
    const future = [bar(10, { close: 103, high: 104 }), ...Array.from({ length: 310 }, (_, index) => bar(index + 11))];
    expect(run(future, plan)).toMatchObject({ phase: 'needs-review', checkedBars: 301, triggeredAt: bar(10).timestamp });
  });
  it('does not reinterpret a known terminal event from unrelated later missing bars', () => {
    expect(run([...confirmed(), bar(12, { low: 94 }), bar(16)])).toMatchObject({ phase: 'stop-touched', checkedBars: 3 });
  });
});
