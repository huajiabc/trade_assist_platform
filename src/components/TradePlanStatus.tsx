import { formatDisplayTime } from '../../shared/displayTime';
import { ArrowUpRight, Crosshair, Target } from '@phosphor-icons/react';
import type { Analysis, TradeSetup } from '../../shared/analysis';
import type { AnalysisSnapshot } from '../analysisSession';
import { tradePlanAvailability } from '../tradePlanAvailability';
import { PLAN_PHASE_LABELS, type PlanTrackingResult } from '../../shared/tradeTracking';
import { TradePlanTracking } from './TradePlanTracking';

const utc = (time: number) => formatDisplayTime(time);

export function TradePlanStatus({ rawAnalysis, analysis, snapshot, selectedId, layerVisible, onSelect, onOpenDetails, tracking = {} }: {
  tracking?: Record<string, PlanTrackingResult>;
  rawAnalysis?: Analysis;
  analysis?: Analysis;
  snapshot: AnalysisSnapshot | null;
  selectedId: string | null;
  layerVisible: boolean;
  onSelect: (setup: TradeSetup) => void;
  onOpenDetails: () => void;
}) {
  const availability = tradePlanAvailability(rawAnalysis, analysis);
  const setups = analysis?.tradeSetups ?? [];
  const currentIndex = Math.max(0, setups.findIndex(setup => setup.id === selectedId));
  const current = setups[currentIndex];
  const phase = (setup: TradeSetup) => PLAN_PHASE_LABELS[tracking[setup.id]?.phase ?? (setup.tracking ? 'waiting' : 'manual')];
  const title = availability.state === 'awaiting' ? '开仓计划 · 尚未分析'
    : availability.state === 'hidden' ? '开仓计划 · 已隐藏'
    : current ? layerVisible ? `图中计划 ${currentIndex + 1} / ${setups.length} · ${phase(current)}` : '开仓计划 · 图层已关闭'
    : availability.state === 'watch-only' ? '开仓计划 · 仅文字观察' : '开仓计划 · 暂无数值计划';
  return <section className={`trade-plan-status state-${availability.state}`} aria-label="开仓计划可视化状态">
    <div className="trade-plan-status-heading"><Target size={15}/><strong>{title}</strong>{rawAnalysis && <span className="trade-plan-counts">原始 {availability.originalCount} · 可绘制 {availability.drawableCount} · 隐藏 {availability.hiddenCount}</span>}</div>
    <p className="trade-plan-decision">{availability.reason}</p>
    {rawAnalysis && !availability.originalCount && <p className="trade-plan-observations">文字观察 {availability.observationCount} 项；文字条件不等于含 E / SL / TP 的数值计划，不会据此补造开仓价。</p>}
    {availability.hiddenCount > 0 && current && <p className="trade-plan-observations">另有 {availability.hiddenCount} 个原始计划因锚点或依据变更而隐藏。</p>}
    {current && <p className="trade-plan-trigger"><span>触发条件</span>{current.trigger}</p>}
    {current && <TradePlanTracking setup={current} result={tracking[current.id]} compact/>}
    {snapshot && <p className="trade-plan-snapshot">{snapshot.selectionMode === 'manual' ? '手动范围快照' : '分析快照'} · 末根 <time dateTime={new Date(snapshot.asOf * 1000).toISOString()}>{utc(snapshot.asOf)} UTC+8</time>（开盘时间）。计划锚定原快照，行情条件核验不代表成交。</p>}
    {rawAnalysis && <div className="trade-plan-status-actions">{current && <>
      {setups.length > 1 && <label>图中计划<select aria-label="选择图中开仓计划" value={current.id} onChange={event => { const setup = setups.find(item => item.id === event.target.value); if (setup) onSelect(setup); }}>{setups.map((setup, index) => <option value={setup.id} key={setup.id}>{index + 1} · {setup.direction === 'bullish' ? '偏多' : '偏空'} · {phase(setup)}</option>)}</select></label>}
      <button type="button" onClick={() => onSelect(current)}><Crosshair size={14}/>{layerVisible ? '定位当前计划' : '显示并定位计划'}</button>
    </>}<button type="button" onClick={onOpenDetails}>查看计划与观察依据<ArrowUpRight size={13}/></button></div>}
  </section>;
}
