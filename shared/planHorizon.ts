import type { ResearchBundle, ResearchFact, ResearchFrame } from './researchData';
import type { TradeSetup } from './analysis';
import type { PlanPolicy } from './planPolicy';

export interface RouteLevel {
  structureId: string; timeframe: ResearchFrame; price: number; type: string;
  importance: ResearchFact['importance']; knownAt: number;
}
export interface PlanHorizon {
  version: 'horizon-1.0'; mode: 'structural' | 'micro';
  objectives: RouteLevel[]; obstacles: RouteLevel[]; blockingIds: string[];
  status: 'open' | 'obstructed' | 'missing-objective'; reason: string;
}
const equalPrice = (a: number, b: number) => Math.abs(a - b) <= Math.abs(b) * Number.EPSILON * 8;
/** Select the nearest real objective IN the intended timeframe, not the furthest
 * convenient price. Intermediate structures remain explicit route evidence. */
export function buildPlanHorizon(bundle: ResearchBundle, facts: ResearchFact[], direction: TradeSetup['direction'], entry: number, stopLoss: number, policy: PlanPolicy): PlanHorizon {
  const sign = direction === 'bullish' ? 1 : -1;
  const types = sign > 0 ? ['HH', 'LH', 'liquidity-high'] : ['HL', 'LL', 'liquidity-low'];
  const levels = facts.filter(f => ['5m', '15m'].includes(f.timeframe) && types.includes(f.type)
    && f.status === 'confirmed' && f.confirmedAt !== null && f.confirmedAt <= bundle.asOf && f.knownAt <= bundle.asOf)
    .map(f => ({ structureId: f.id, timeframe: f.timeframe, price: sign > 0 ? f.low : f.high, type: f.type, importance: f.importance, knownAt: f.knownAt }))
    .filter(f => (f.price - entry) * sign > 0)
    .sort((a, b) => (a.price - b.price) * sign || Number(b.timeframe === '15m') - Number(a.timeframe === '15m') || b.knownAt - a.knownAt || a.structureId.localeCompare(b.structureId));
  const unique = (rows: RouteLevel[]) => rows.filter((f, i, all) => all.findIndex(x => equalPrice(x.price, f.price)) === i);
  // Structural mode cannot silently fall back to a tiny 5m or 1m TP when 15m lacks an objective.
  const objectives = unique(policy.profile === 'structural' ? levels.filter(f => f.timeframe === '15m' && f.importance === 'major') : levels).slice(0, 3);
  const first = objectives[0];
  const obstacles = first ? unique(levels.filter(f => (f.price - first.price) * sign < 0)) : unique(levels);
  // Local swings are checkpoints, not mandatory exits. A major obstacle inside
  // 1R blocks a plan, even if a distant objective would make its nominal R look good.
  const blockingIds = obstacles.filter(f => f.importance === 'major' && Math.abs(f.price - entry) < Math.abs(entry - stopLoss)).map(f => f.structureId);
  const status = !first ? 'missing-objective' : blockingIds.length ? 'obstructed' : 'open';
  return { version: 'horizon-1.0', mode: policy.profile, objectives, obstacles, blockingIds, status,
    reason: !first ? policy.profile==='structural'?'没有当时已确认的15m主要目标；结构波段不退回1m附近凑TP。':'没有当时已确认且方向有效的5m/15m结构目标，等待。'
      : blockingIds.length ? '15m目标仍保留为观察路径，但1R内存在主要阻挡，需新的5m结构处理后重新评估。'
      : policy.profile === 'structural' ? 'TP锚定最近的15m主要结构；5m途中阻挡单列，远端目标需逐段验证，不代表必然到达。'
      : '局部短线保留最近实际结构目标，不扩大价格凑收益。' };
}
/** A stop must protect the strategy event itself, not just any nearby pivot. */
export function protectionBoundary(bundle: ResearchBundle, primary: ResearchFact, direction: TradeSetup['direction']): number {
  const sign = direction === 'bullish' ? 1 : -1;
  const times = [primary.formedAt, primary.reclaimTime, primary.reactionTime, primary.failureTime].filter((t): t is number => t !== null && t !== undefined && t <= bundle.asOf);
  // BOS protection includes its actual subsequent held retest, not only the breakout candle.
  if(primary.type==='BOS'){const held=bundle.frames['5m'].candles.find(b=>b.timestamp>=primary.knownAt&&b.timestamp+300<=bundle.asOf&&b.low<=primary.high&&b.high>=primary.low&&(direction==='bullish'?b.close>primary.high:b.close<primary.low));if(held)times.push(held.timestamp+300);}
  const bars = bundle.frames['5m'].candles.filter(b => times.includes(b.timestamp + 300));
  const prices = [sign > 0 ? primary.low : primary.high, ...bars.map(b => sign > 0 ? b.low : b.high)];
  return sign > 0 ? Math.min(...prices) : Math.max(...prices);
}
export interface EntryFeasibility {
  price: number; riskDistance: number; targetDistance: number; ratio: number;
  state: 'within-plan' | 'outside-entry' | 'space-insufficient'; reason: string;
}
/** Comparison only. A close/quote is never inferred to be a fill, nor does it
 * overwrite the original reference E/SL/TP. */
export function assessEntryFeasibility(setup: TradeSetup, price: number, zone: { entryLow: number; entryHigh: number } | undefined, minimumRR: number): EntryFeasibility {
  const sign = setup.direction === 'bullish' ? 1 : -1;
  const riskDistance = (price - setup.stopLoss) * sign, targetDistance = (setup.targets[0].price - price) * sign;
  const ratio = riskDistance > 0 ? targetDistance / riskDistance : 0;
  const within = price >= (zone?.entryLow ?? setup.entry) && price <= (zone?.entryHigh ?? setup.entry);
  const state = riskDistance <= 0 || targetDistance <= 0 || ratio < minimumRR ? 'space-insufficient' : within ? 'within-plan' : 'outside-entry';
  return { price, riskDistance, targetDistance, ratio, state,
    reason: state === 'space-insufficient' ? '按该价格复核后的目标空间或R不足，等待新计划；原参考R不能视为当前可得收益。'
      : state === 'outside-entry' ? '该价格不在原回踩入场区；确认后仍需复核可成交位置，不能按旧入场价宣称可得R。'
      : '价格仍在参考区，仅为位置复核，尚未确认实际成交。' };
}
