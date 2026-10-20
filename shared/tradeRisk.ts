import type { Candle } from './market';
import type { TradeSetup } from './analysis';
import { calculateRiskReward } from './tradeGeometry';

/** Product filtering policy, NOT backtested strategy parameters or execution guarantees.
 * Keep model context, validation and the UI on the same deterministic policy. */
export const STOP_RISK_POLICY = Object.freeze({
  atrPeriod: 14, minimumRiskAtr: .5, minimumStructureBufferAtr: .25,
  reviewRiskBelowAtr: 1, reviewRiskAboveAtr: 6,
});

/** Wilder/RMA ATR: SMA seed of 14 true ranges, then alpha=1/14.
 * Uses only supplied bars up to asOfTime; never assumes a higher timeframe. */
export function tradeRiskContext(candles: readonly Candle[], asOfTime = candles.at(-1)?.timestamp ?? null) {
  const bars = asOfTime === null ? [] : candles.filter(candle => candle.timestamp <= asOfTime);
  const period = STOP_RISK_POLICY.atrPeriod;
  let atr: number | null = null;
  let seed = 0;
  bars.forEach((bar, index) => {
    const previousClose = index ? bars[index - 1].close : bar.close;
    const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
    if (index < period) seed += tr;
    if (index === period - 1) atr = seed / period;
    if (index >= period) atr = atr! + (tr - atr!) / period;
  });
  const firstInterval = bars.length > 1 ? bars[1].timestamp - bars[0].timestamp : null;
  const intervalSeconds = firstInterval !== null && firstInterval > 0 && bars.every((bar, index) => index === 0 || bar.timestamp - bars[index - 1].timestamp === firstInterval)
    ? firstInterval : null;
  return { method: 'Wilder-RMA' as const, period, sampleCount: bars.length, asOfTime: bars.at(-1)?.timestamp ?? null,
    intervalSeconds, atr, minimumRiskDistance: atr === null ? null : atr * STOP_RISK_POLICY.minimumRiskAtr,
    minimumStructureBuffer: atr === null ? null : atr * STOP_RISK_POLICY.minimumStructureBufferAtr,
    policy: STOP_RISK_POLICY };
}

export function auditStopRisk(setup: Pick<TradeSetup, 'anchorTime' | 'direction' | 'entry' | 'stopLoss' | 'targets'>,
  candles: readonly Candle[], protection?: { low: number; high: number }) {
  const context = tradeRiskContext(candles, setup.anchorTime);
  const riskDistance = calculateRiskReward(setup).risk;
  const structuralBoundary = protection ? setup.direction === 'bullish' ? protection.low : protection.high : null;
  const structuralBuffer = structuralBoundary === null ? null
    : setup.direction === 'bullish' ? structuralBoundary - setup.stopLoss : setup.stopLoss - structuralBoundary;
  const usable = context.atr !== null && context.atr > 0;
  const riskAtr = usable ? riskDistance / context.atr! : null;
  const bufferAtr = usable && structuralBuffer !== null ? structuralBuffer / context.atr! : null;
  const errors: string[] = [], warnings: string[] = [];
  const tolerance = Math.max(Number.MIN_VALUE, Math.abs(setup.entry) * Number.EPSILON * 8);
  if (!usable) errors.push(context.atr === null ? '不足14根已知K线，无法核验ATR止损缓冲；保留观察或等待更多数据。' : '当前ATR为零，缺少可用波动依据；不生成完整数值计划。');
  if (usable && riskDistance + tolerance < context.minimumRiskDistance!) errors.push('止损距离小于0.5 ATR(14)，落入本项目的过窄风险过滤范围；请复核真实失效结构，目标空间不足则等待，不能移动目标或压紧止损凑盈亏比。');
  if (structuralBuffer !== null && structuralBuffer <= tolerance) errors.push('止损必须位于所引用保护结构之外。');
  else if (usable && structuralBuffer !== null && structuralBuffer + tolerance < context.minimumStructureBuffer!) errors.push('止损虽越过保护结构，但结构外缓冲不足0.25 ATR(14)；请依据失效结构重新规划，空间不足则返回观察。');
  if (riskAtr !== null && riskAtr < STOP_RISK_POLICY.reviewRiskBelowAtr) warnings.push('止损距离不足1 ATR(14)，低于本周期近期平均真实波幅；短线噪声敏感，需复核触发与保护依据。');
  if (riskAtr !== null && riskAtr > STOP_RISK_POLICY.reviewRiskAboveAtr) warnings.push('止损距离超过6 ATR(14)，需复核计划周期与目标空间；不会为了通过距离上限而压紧止损。');
  return { context, riskDistance, riskAtr, structuralBoundary, structuralBuffer, bufferAtr, errors, warnings };
}
export type StopRiskAudit = ReturnType<typeof auditStopRisk>;
