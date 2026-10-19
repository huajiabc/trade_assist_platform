import type { TradeSetup } from './analysis';

export interface RiskReward {
  /** Absolute price distances, never position size or account P&L. */
  risk: number;
  reward: number;
  ratio: number;
  /** Percentage of the reference entry: 2 means 2%, not 0.02. */
  riskPct: number;
  rewardPct: number;
}

/** Direction-aware geometry shared by chart labels and the analysis panel. */
export function calculateRiskReward(setup: Pick<TradeSetup, 'direction' | 'entry' | 'stopLoss' | 'targets'>, targetIndex = 0): RiskReward {
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= setup.targets.length) {
    throw new Error('盈亏比计算失败：目标索引无效。');
  }
  const target = setup.targets[targetIndex].price;
  if (![setup.entry, setup.stopLoss, target].every(value => Number.isFinite(value) && value > 0)
    || !['bullish', 'bearish'].includes(setup.direction)) {
    throw new Error('盈亏比计算失败：价格或方向无效。');
  }
  const sign = setup.direction === 'bullish' ? 1 : -1;
  const risk = (setup.entry - setup.stopLoss) * sign;
  const reward = (target - setup.entry) * sign;
  const tolerance = Math.max(Number.MIN_VALUE, setup.entry * Number.EPSILON * 8);
  if (risk <= tolerance || reward <= tolerance) throw new Error('盈亏比计算失败：止损或目标方向与距离无效。');
  const result = { risk, reward, ratio: reward / risk, riskPct: risk / setup.entry * 100, rewardPct: reward / setup.entry * 100 };
  if (!Object.values(result).every(Number.isFinite)) throw new Error('盈亏比计算失败：数值超出可计算范围。');
  return result;
}
