import { formatPrice } from '../../shared/format';
import type { StopRiskAudit } from '../../shared/tradeRisk';
const date = (time: number) => new Date(time * 1000).toISOString().replace('T', ' ').slice(5, 16);
const ratio = (value: number) => value < .01 ? value.toExponential(2) : Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);

/** Snapshot metrics only: this component never moves the reference entry or stop. */
export function TradeStopAudit({ audit }: { audit?: StopRiskAudit }) {
  if (!audit) return <p className="advanced-explainer">止损波动参照未提供，需复核原始行情。</p>;
  const { context, riskAtr, structuralBoundary, structuralBuffer, bufferAtr } = audit;
  const seconds = context.intervalSeconds;
  const interval = seconds === null ? '非等距K线' : seconds < 60 ? seconds + '秒' : seconds < 3600 ? seconds / 60 + '分钟' : seconds < 86400 ? seconds / 3600 + '小时' : seconds / 86400 + '天';
  return <div className="trade-stop-audit" aria-label="止损与波动检查">
    <div className="stop-audit-heading"><strong>止损与波动</strong><span>{interval} · 分析快照</span></div>
    <dl><div><dt>ATR({context.period}) · RMA</dt><dd>{context.atr === null ? '样本不足' : formatPrice(context.atr)}</dd></div>
      <div><dt>风险距离 / ATR</dt><dd>{riskAtr === null ? '无法计算' : ratio(riskAtr) + ' ×'}</dd></div>
      <div><dt>保护结构外沿</dt><dd>{structuralBoundary === null ? '未提供' : formatPrice(structuralBoundary)}</dd></div>
      <div><dt>结构外止损缓冲</dt><dd>{structuralBuffer === null ? '无法核验' : formatPrice(structuralBuffer)}{bufferAtr !== null && <small>{ratio(bufferAtr)} ATR</small>}</dd></div></dl>
    <p>项目过滤门槛：风险 ≥ {context.policy.minimumRiskAtr} ATR，结构外缓冲 ≥ {context.policy.minimumStructureBufferAtr} ATR。仅本周期参照，参数未经回测。</p>
    <p>{context.asOfTime === null ? '无可用快照' : date(context.asOfTime) + ' UTC'} · 不随实时价格自动移动止损。</p>
  </div>;
}
