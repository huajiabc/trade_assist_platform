import type { TradeSetup } from '../../shared/analysis';
import { PLAN_PHASE_LABELS, type PlanTrackingResult } from '../../shared/tradeTracking';
import { formatPrice } from '../../shared/format';
import { formatDisplayTime } from '../../shared/displayTime';
const utc = formatDisplayTime;
export function TradePlanTracking({ setup, result, compact = false }: { setup: TradeSetup; result?: PlanTrackingResult; compact?: boolean }) {
  if (!result) return null;
  return <div className={'trade-tracking phase-' + result.phase + (compact ? ' is-compact' : '')} aria-label="开仓计划行情条件核验" data-tracking-phase={result.phase}>
    <div className="trade-tracking-summary"><strong>{PLAN_PHASE_LABELS[result.phase]}</strong><span>步骤 {result.completedSteps} / {result.totalSteps} · 已核验 {result.checkedBars} 根已收盘 K 线</span></div>
    <p>{result.reason}</p>
    {result.asOf !== null && <small>核验截至 {utc(result.asOf)} UTC+8（K 线开盘时间）</small>}
    {setup.tracking && <details className="trade-tracking-details"><summary>核验规则与事件 {result.events.length}</summary>
      <p>只回放快照之后的已收盘行情，可能包含分析生成前的历史数据。条件完成当根不计为后续参考 SL/TP 触及；没有成交判断。</p>
      <ol className="trade-tracking-steps">{setup.tracking.steps.map((step, index) => <li key={index} className={index < result.completedSteps ? 'is-complete' : ''}>
        <strong>{index < result.completedSteps ? '已满足' : '待核验'} · {step.label}</strong><span>{step.conditions.map(condition => condition.type === 'touch-zone'
          ? '影线与 ' + formatPrice(condition.price) + '—' + formatPrice(condition.priceEnd!) + ' 相交'
          : '收盘价 ' + (condition.type === 'close-above' ? '> ' : '< ') + formatPrice(condition.price)).join(' 且 ')}</span>
      </li>)}</ol>
      <p>确认前取消：{setup.tracking.cancellation.label}（{setup.tracking.cancellation.basis === 'close' ? '收盘' : '影线'}{setup.direction === 'bullish' ? ' ≤ ' : ' ≥ '}{formatPrice(setup.tracking.cancellation.price)}）；等待期限 {setup.tracking.expiresAfterBars} 根。</p>
      {result.events.length > 0 && <ol className="trade-tracking-events">{result.events.map((event, index) => <li key={index}><time>{utc(event.time)} UTC+8</time><span>{event.label} · {formatPrice(event.price)}</span></li>)}</ol>}
    </details>}
  </div>;
}
