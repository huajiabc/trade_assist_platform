import { z } from 'zod';
import type { TradeSetup } from './analysis';
import type { Candle } from './market';

const price = z.number().finite().positive().max(1_000_000_000_000);
const text = z.string().trim().min(1).max(240);
export const tradeTrackingSchema = z.object({
  steps: z.array(z.object({
    label: text,
    conditions: z.array(z.object({
      type: z.enum(['touch-zone', 'close-above', 'close-below']),
      price,
      priceEnd: price.nullable(),
    }).strict()).min(1).max(3),
  }).strict()).min(1).max(4),
  cancellation: z.object({ basis: z.enum(['wick', 'close']), price, label: text }).strict(),
  expiresAfterBars: z.number().int().min(1).max(300),
}).strict().nullable();

export type TradeTrackingRule = NonNullable<z.infer<typeof tradeTrackingSchema>>;
export type PlanPhase = 'manual' | 'waiting' | 'conditions-met' | 'invalidated' | 'expired' | 'stop-touched' | 'targets-touched' | 'ambiguous' | 'needs-review';
export const PLAN_PHASE_LABELS: Record<PlanPhase, string> = {
  manual: '需人工确认', waiting: '待触发', 'conditions-met': '条件已满足', invalidated: '候选已失效',
  expired: '候选已过期', 'stop-touched': '参考 SL 已触及', 'targets-touched': '参考目标已全部触及',
  ambiguous: '同根顺序不明', 'needs-review': '数据需复核',
};
export type TrackingEvent = { type: 'step' | 'conditions-met' | 'invalidation' | 'expiry' | 'target' | 'stop' | 'ambiguous'; time: number; price: number; label: string; targetIndex?: number };
export type PlanTrackingResult = { phase: PlanPhase; reason: string; completedSteps: number; totalSteps: number; checkedBars: number;
  asOf: number | null; triggeredAt: number | null; targetTimes: (number | null)[]; events: TrackingEvent[] };

export function validateTradeTracking(setup: TradeSetup, lowerBound: number, upperBound: number): void {
  if (!setup.tracking) return;
  const rule = setup.tracking;
  for (const step of rule.steps) for (const condition of step.conditions) {
    if (condition.type === 'touch-zone' ? condition.priceEnd === null || condition.priceEnd < condition.price : condition.priceEnd !== null) {
      throw new Error('分析 JSON 校验失败：跟踪条件的区域边界或非区域 priceEnd 无效。');
    }
    if ([condition.price, condition.priceEnd].some(value => value !== null && (value < lowerBound || value > upperBound))) {
      throw new Error('分析 JSON 校验失败：跟踪条件价位超出行情窗口的合理延伸范围。');
    }
  }
  const cancellation = rule.cancellation.price;
  if (cancellation < lowerBound || cancellation > upperBound || (setup.direction === 'bullish' ? cancellation >= setup.entry : cancellation <= setup.entry)) {
    throw new Error('分析 JSON 校验失败：跟踪取消价位须位于参考入场的不利方向及合理价格范围内。');
  }
}

export function inferTrackingInterval(candles: readonly Candle[]): number | null {
  const interval = candles.length > 1 ? candles[1].timestamp - candles[0].timestamp : 0;
  return interval > 0 && candles.every((candle, index) => index === 0 || candle.timestamp - candles[index - 1].timestamp === interval) ? interval : null;
}

/** Replay only supplied CLOSED bars. No text parsing, intrabar path or fills.
 * The caller excludes the forming exchange candle. Results are recomputed so
 * revised later OHLC never leave stale incremental events behind. */
export function evaluateTradePlan(setup: TradeSetup, snapshot: readonly Candle[], closedCandles: readonly Candle[], intervalSeconds = inferTrackingInterval(snapshot)): PlanTrackingResult {
  const result: PlanTrackingResult = { phase: setup.tracking ? 'waiting' : 'manual', reason: '', completedSteps: 0,
    totalSteps: setup.tracking?.steps.length ?? 0, checkedBars: 0, asOf: null, triggeredAt: null,
    targetTimes: setup.targets.map(() => null), events: [] };
  const finish = (phase: PlanPhase, reason: string) => { result.phase = phase; result.reason = reason; return result; };
  if (!setup.tracking) return finish('manual', '该计划没有完整可计算的跟踪规则，保留原触发说明供人工核验；不从文字猜测条件。');
  if (!intervalSeconds || !Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return finish('needs-review', '无法确定等距 K 线周期，不能排除缺失行情，请人工复核。');
  if (snapshot.at(-1)?.timestamp !== setup.anchorTime) return finish('needs-review', '跟踪计划与输入快照锚点不一致。');
  const current = new Map(closedCandles.map(candle => [candle.timestamp, candle]));
  if (snapshot.some(original => {
    const candle = current.get(original.timestamp);
    return candle && (original.open !== candle.open || original.high !== candle.high || original.low !== candle.low || original.close !== candle.close);
  })) return finish('needs-review', '原分析所依赖的已收盘 OHLC 已被修订，请重新分析。');
  const rule = setup.tracking;
  const sign = setup.direction === 'bullish' ? 1 : -1;
  const future = closedCandles.filter(candle => candle.timestamp > setup.anchorTime);
  let previousTime = setup.anchorTime;
  let triggerBarIndex = 0;
  for (const candle of future) {
    if (candle.timestamp - previousTime !== intervalSeconds) return finish('needs-review', '后续已收盘行情存在缺口、重复或乱序；保留缺口前的核验记录，暂停后续判断。');
    previousTime = candle.timestamp;
    result.asOf = candle.timestamp;
    result.checkedBars++;
    const add = (event: Omit<TrackingEvent, 'time'>) => result.events.push({ ...event, time: candle.timestamp });
    if (result.triggeredAt === null) {
      const cancelled = rule.cancellation.basis === 'close' ? (candle.close - rule.cancellation.price) * sign <= 0
        : (sign > 0 ? candle.low <= rule.cancellation.price : candle.high >= rule.cancellation.price);
      if (cancelled) {
        add({ type: 'invalidation', price: rule.cancellation.price, label: rule.cancellation.label });
        return finish('invalidated', '触发完成前已达到取消条件，停止追踪此候选。');
      }
      const step = rule.steps[result.completedSteps];
      const matched = step.conditions.every(condition => condition.type === 'touch-zone'
        ? candle.high >= condition.price && candle.low <= condition.priceEnd!
        : condition.type === 'close-above' ? candle.close > condition.price : candle.close < condition.price);
      if (matched) {
        result.completedSteps++;
        const done = result.completedSteps === result.totalSteps;
        add({ type: done ? 'conditions-met' : 'step', price: candle.close, label: step.label });
        if (done) { result.triggeredAt = candle.timestamp; triggerBarIndex = result.checkedBars; result.phase = 'conditions-met'; }
      }
      if (result.triggeredAt === null && result.checkedBars >= rule.expiresAfterBars) {
        add({ type: 'expiry', price: candle.close, label: '等待窗口结束，条件未完整满足' });
        return finish('expired', '已用完规则允许的等待 K 线数量，候选过期。');
      }
      // A condition is known at this close. Never count earlier high/low in
      // this same candle as a subsequent stop/target event or a simulated fill.
      continue;
    }
    const stopTouched = sign > 0 ? candle.low <= setup.stopLoss : candle.high >= setup.stopLoss;
    const newTargets = setup.targets.flatMap((target, index) => result.targetTimes[index] === null
      && (sign > 0 ? candle.high >= target.price : candle.low <= target.price) ? [index] : []);
    if (stopTouched && newTargets.length) {
      add({ type: 'ambiguous', price: candle.close, label: '同根同时覆盖参考 SL 与新目标，OHLC 无法确定先后顺序' });
      return finish('ambiguous', '同一根 K 线同时触及参考止损和新目标；未认定先后、盈亏或成交，需人工复核。');
    }
    if (stopTouched) {
      add({ type: 'stop', price: setup.stopLoss, label: '条件满足后的参考 SL 触及' });
      return finish('stop-touched', '条件满足后的行情已触及参考 SL；这只是价位事件，不代表实际止损成交。');
    }
    for (const index of newTargets) {
      result.targetTimes[index] = candle.timestamp;
      add({ type: 'target', price: setup.targets[index].price, label: '参考 TP' + (index + 1) + ' 已触及', targetIndex: index });
    }
    if (result.targetTimes.every(time => time !== null)) return finish('targets-touched', '条件满足后参考目标已全部触及；不推断订单成交或实际收益。');
    if (result.checkedBars - triggerBarIndex >= 300) return finish('needs-review', '已达到额外 300 根 K 线的观察上限，请重新评估计划。');
  }
  return finish(result.triggeredAt === null ? 'waiting' : 'conditions-met', result.triggeredAt === null
    ? '仅按快照之后的已收盘 K 线依序核验；每一步至少使用一根新的 K 线。'
    : '结构化条件已满足，后续仅观察参考 SL/TP 的价位触及，不代表开仓成交。');
}
