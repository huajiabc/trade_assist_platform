import { Lightning, Pulse } from '@phosphor-icons/react';

interface Props {
  disabled: boolean;
  ready: boolean;
  simulated: boolean;
  onScan: () => void;
  onAnalyze: () => void;
}

/** Actions live beside their results so users do not have to find another panel. */
export function OpportunityActions({ disabled, ready, simulated, onScan, onAnalyze }: Props) {
  return <section className="opportunity-actions" aria-label="寻找开仓机会" aria-busy={disabled}>
    <div className="decision-purpose"><h2>寻找开仓机会</h2><span>15m 背景 · 5m 保护 · 1m 触发</span></div>
    <p>两种分析的结果都在下方：查看候选的入场区、止损、止盈和等待条件。</p>
    <div className="opportunity-action-buttons">
      <button className="button secondary" aria-label="快速扫描" disabled={disabled || !ready} onClick={onScan}>
        <Pulse size={18}/><span><b>快速扫描</b><small>本地规则筛选 · 不调用 AI</small></span>
      </button>
      <button className="button primary" aria-label="深度分析" disabled={disabled || !ready} onClick={onAnalyze}>
        <Lightning size={18}/><span><b>深度分析</b><small>{simulated ? '当前为模拟审阅 · 不调用模型' : 'AI 审阅候选 · 主动调用模型'}</small></span>
      </button>
    </div>
    {!ready && <p role="status">正在读取本地研究记录…</p>}
    {ready && disabled && <p role="status">正在更新行情或分析，请稍候。进度与结果显示在下方。</p>}
  </section>;
}
