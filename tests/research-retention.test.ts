import { describe, expect, it } from 'vitest';
import { AS_OF, frame, researchBundle, strategyFacts } from './research-fixtures';
import { evaluateStrategies } from '../shared/strategyCatalog';
import { makeResearchBundle, RESEARCH_FRAMES } from '../shared/researchData';
import { updateMarketState, saveCandidatePlan, recordActualPosition, linkExchangePlan, type MarketState } from '../shared/marketState';
import { partitionResearchHistory, recoverResearchCapacity, researchMinuteHistory, RESEARCH_RETENTION } from '../shared/researchRetention';

function savedState(): MarketState {
  const state = updateMarketState(null, researchBundle(), 'retention fixture', 1000), facts = strategyFacts();
  state.facts = Object.fromEntries(facts.map(f => [f.id, { current: true, versions: [{ stateVersion: 1, knownAt: AS_OF, reason: 'contract', fact: f }] }]));
  state.scenarios = evaluateStrategies(state.bundle, facts);
  return saveCandidatePlan(state, state.scenarios.find(c => c.stage === 'conditional')!.id);
}
function rollingBundle(minutes: number) {
  const one = frame('1m');
  const triggers = [{ low: 99.8, high: 100.5, close: 100.2 }, { low: 100.1, high: 100.8, close: 100.4 }, { low: 100.4, high: 101.4, close: 101.2 }];
  const rows = Array.from({ length: minutes }, (_, i) => ({ timestamp: AS_OF + i * 60,
    open: i < 3 ? triggers[i].close : 101.5, volume: 1, ...(triggers[i] ?? { low: 101, high: 102, close: 101.5 }) }));
  one.candles = [...one.candles, ...rows].slice(-40); one.lastClosedTime = one.candles.at(-1)!.timestamp; one.observedAt = AS_OF + minutes * 60;
  return makeResearchBundle(one.symbol, [frame('15m'), frame('5m'), one], one.observedAt);
}
function crowded(state = savedState()) {
  const snapshots = { ...state.snapshots };
  for (let minute = 10; minute <= 150; minute += 2) {
    const bundle = rollingBundle(minute); snapshots[bundle.frames['1m'].id] = bundle.frames['1m'];
  }
  const bundle = rollingBundle(150);
  for (const tf of RESEARCH_FRAMES) snapshots[bundle.frames[tf].id] = bundle.frames[tf];
  return { ...state, version: 180, asOf: bundle.asOf, bundle, snapshots,
    history: Array.from({ length: 180 }, (_, i) => ({ ...state.history[0], version: i + 1 })),
    evaluations: Array.from({ length: 120 }, (_, i) => ({ ...state.evaluations[0], stateVersion: i + 1 })),
    events: [...state.events, ...Array.from({ length: 4100 }, (_, i) => ({ ...state.events[0], id: 'old-event-' + i, stateVersion: i + 1, factIds: [] }))],
  };
}

describe('automatic research history retention', () => {
  it('archives old records without changing the active snapshot, versions, plans, fills or exchange links', () => {
    let state = savedState();
    state = recordActualPosition(state, state.plans[0].id, { entry: 100.2, quantity: 2, filledAt: AS_OF }, AS_OF * 1000);
    state = linkExchangePlan(state, 'exchange-long', 'explicit-identity', state.plans[0].id, 2000);
    const input = crowded(state), before = structuredClone(input), { state: kept, archive } = partitionResearchHistory(input, 5000);
    expect(archive).not.toBeNull(); expect(input).toEqual(before);
    expect(kept.version).toBe(input.version); expect(kept.bundle).toBe(input.bundle); expect(kept.asOf).toBe(input.asOf);
    expect(kept.plans).toEqual(input.plans); expect(kept.positions).toEqual(input.positions); expect(kept.exchangePlanLinks).toEqual(input.exchangePlanLinks);
    expect(kept.capacityReached).toBe(false); expect(kept.history.length).toBeLessThan(input.history.length);
    for (const id of Object.values(input.plans[0].versions[0].snapshotIds)) expect(kept.snapshots[id]).toEqual(input.snapshots[id]);
    for (const tf of RESEARCH_FRAMES) expect(kept.snapshots[input.bundle.frames[tf].id]).toEqual(input.bundle.frames[tf]);
    expect({ ...archive!.snapshots, ...kept.snapshots }).toEqual(input.snapshots);
    expect([...archive!.events, ...kept.events].map(e => e.id).sort()).toEqual(input.events.map(e => e.id).sort());
    expect([...archive!.history, ...kept.history].map(h => h.version).sort((a,b) => a-b)).toEqual(input.history.map(h => h.version));
    expect([...archive!.evaluations, ...kept.evaluations]).toEqual(input.evaluations);
    expect(kept.events.some(e => e.planId === state.plans[0].id)).toBe(true);
  });

  it('preserves retired fact revisions with their real knowable times, plus the current fact', () => {
    const input = crowded(), original = input.facts.target;
    input.facts.target = { ...original, versions: Array.from({ length: 30 }, (_, i) => ({ ...original.versions[0], stateVersion: i + 1, knownAt: AS_OF + i })) };
    input.facts.retired = { current: false, versions: [{ ...original.versions[0], fact: { ...original.versions[0].fact, id: 'retired' } }] };
    const { state, archive } = partitionResearchHistory(input);
    expect(state.facts.target.versions).toHaveLength(RESEARCH_RETENTION.factVersionsRecent);
    expect([...archive!.facts.target.versions, ...state.facts.target.versions]).toEqual(input.facts.target.versions);
    expect(state.facts.retired).toBeUndefined(); expect(archive!.facts.retired).toEqual(input.facts.retired);
    expect(state.facts.target.versions.at(-1)!.fact).toEqual(input.facts.target.versions.at(-1)!.fact);
  });

  it('releases the old capacity latch on an unchanged input while retaining genuine data warnings', () => {
    const original = savedState(), input = { ...original, capacityReached: true,
      needsReview: ['5m原始OHLCV被修订或插入，旧解释和计划需重新评估', '达到本地会话容量上限，请导出后开始新会话；没有静默删除历史。'] };
    const recovered = recoverResearchCapacity(input);
    expect(recovered.needsReview).toEqual([input.needsReview[0]]); expect(recovered.version).toBe(original.version);
    expect(updateMarketState(input, input.bundle).capacityReached).toBe(false); expect(input.capacityReached).toBe(true);
    expect(partitionResearchHistory(original).state).toBe(original); expect(partitionResearchHistory(original).archive).toBeNull();
  });

  it('keeps a continuous exact-price lifecycle across archived rolling-window boundaries', () => {
    const input = savedState();
    for (let minute = 20; minute <= 340; minute += 20) {
      const bundle = rollingBundle(minute); input.snapshots[bundle.frames['1m'].id] = bundle.frames['1m'];
    }
    input.bundle = rollingBundle(359); input.asOf = input.bundle.asOf;
    input.snapshots[input.bundle.frames['1m'].id] = input.bundle.frames['1m'];
    input.history = Array.from({ length: 180 }, (_, i) => ({ ...input.history[0], version: i + 1 }));
    const { state, archive } = partitionResearchHistory(input);
    expect(archive).not.toBeNull(); expect(state.trackingCandles!.length).toBeGreaterThan(300);
    const full = updateMarketState(input, rollingBundle(360)), compact = updateMarketState(state, rollingBundle(360));
    expect(compact.plans[0].tracking).toEqual(full.plans[0].tracking);
    expect(compact.plans[0].versions).toEqual(full.plans[0].versions);
    expect(compact.plans[0].tracking!.triggeredAt).not.toBeNull();
    expect(compact.plans[0].tracking!.reason).toContain('300');
  });

  it('does not heal a real input gap with retained tracking rows, or keep tracking data without saved plans', () => {
    const input = crowded(), { state } = partitionResearchHistory(input);
    const missing = input.bundle.frames['1m'].candles[10].timestamp;
    const changed = structuredClone(state); changed.bundle.frames['1m'].candles = changed.bundle.frames['1m'].candles.filter(c => c.timestamp !== missing);
    expect(researchMinuteHistory(changed).some(c => c.timestamp === missing)).toBe(false);
    expect(partitionResearchHistory({ ...input, plans: [] }).state.trackingCandles).toEqual([]);
  });
});
