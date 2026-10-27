import { formatDisplayTime } from '../../shared/displayTime';
import { useState } from 'react';
import type { Analysis, Structure } from '../../shared/analysis';
import type { Candle } from '../../shared/market';
import type { StructureEvidence } from '../../shared/structureEvidence';
import { selectStructureReferences } from '../../shared/structureEvidence';
import { auditStructure, type PriceEvidence } from '../../shared/analysisResearch';
import { formatPrice } from '../../shared/format';
import { paRegimeNames } from './PriceActionPanel';
const date = (time: number | null | undefined) => time == null ? '尚无可核验时间' : formatDisplayTime(time) + ' UTC+8';
export function EvidenceDetails({ item, price, candles, evidence }: { item?: Structure; price?: PriceEvidence; candles: readonly Candle[]; evidence: StructureEvidence }) {
  if (!item && !price) return null;
  const rule = item && evidence.structures.find(entry => entry.id === item.id);
  const timing = rule?.timing ?? (item ? auditStructure(item, candles, evidence) : price?.timing);
  return <section className="evidence-detail" aria-label="已选结构详情">
    <strong>{rule || price?.source === 'deterministic' ? '规则计算' : '模型判断'} · {item?.type ?? price?.type} · {item?.status === 'candidate' ? '候选' : timing?.confirmedAt ? '规则可核验' : '确认时间未核验'}</strong>
    <dl><div><dt>历史起源</dt><dd>{date(timing?.originTime ?? item?.startTime)}</dd></div><div><dt>结构形成</dt><dd>{date(timing?.formedAt ?? item?.endTime)}</dd></div>
    <div><dt>确认K线（收盘后）</dt><dd>{date(timing?.confirmedAt)}</dd></div><div><dt>失效 / 回补K线</dt><dd>{timing?.resolvedAt ? date(timing.resolvedAt) : '输入范围内未记录'}</dd></div>
    <div><dt>真实价位</dt><dd>{formatPrice(item?.price ?? price!.low)}{(item?.priceEnd ?? price?.high) != null && (item?.priceEnd ?? price?.high) !== (item?.price ?? price?.low) ? ' – ' + formatPrice((item?.priceEnd ?? price!.high)!) : ''}</dd></div>
    {(item || price?.rationale) && <><div><dt>识别依据</dt><dd>{item?.rationale ?? price?.rationale}</dd></div><div><dt>失效条件</dt><dd>{item?.invalidation ?? price?.invalidation}</dd></div></>}</dl>
    <small>时间均为实际K线开盘坐标；确认须等该根收盘，不代表起源时已可知。缺失时间保留未知。</small>
  </section>;
}
export function RuleStructurePanel({ evidence, selectedId, onSelect, onSelectLeg }: { evidence: StructureEvidence; selectedId: string | null; onSelect: (item: Structure) => void; onSelectLeg: (id: string) => void }) {
  const [limit, setLimit] = useState(60);
  const structures = evidence.structures.filter(item => item.type !== 'FVG' && item.type !== 'OB');
  return <section className="rule-structure-catalog" aria-label="全区间规则结构目录"><h3>全区间规则结构 <small>{structures.length} 项 · 独立于模型返回</small></h3>
    <p>严格2/2局部摆点与5/5主要摆点；收盘越过当时已确认摆点记为BOS，反向记为CHoCH。规则定义是研究参考。</p>
    <div className="rule-structure-grid">{[...structures].reverse().slice(0,limit).map(item => <button key={item.id} className="rule-structure-row" aria-pressed={item.id === selectedId} onClick={() => onSelect(item)}><b>{item.type}</b><span>{item.importance === 'major' ? '主要5/5' : '局部2/2'} · {date(item.startTime)}</span><strong>{formatPrice(item.price)}</strong></button>)}</div>
    {structures.length > limit && <button className="button text-button" onClick={() => setLimit(value => value + 60)}>显示更早的60项（原数据完整保留）</button>}
    <details><summary>规则主要趋势腿 · {evidence.legs.filter(item => item.importance === 'major').length} 项</summary><div className="related-structures">{evidence.legs.filter(item => item.importance === 'major').map(item => <button key={item.id} onClick={() => onSelectLeg(item.id)}>{item.direction === 'bullish' ? '↗' : '↘'} {date(item.startTime)} → {date(item.endTime)}</button>)}</div></details>
  </section>;
}
export function ResearchStages({ analysis, onReference }: { analysis: Analysis; onReference: (id: string) => void }) {
  const r = analysis.research;
  if (!r) return <p className="research-incomplete">阶段研究未提供（旧版 / 模拟 / 不完整结果）。结构确认按单项依据复核；数值候选不代表完成了情景与价位依据校验。</p>;
  return <section className="research-stages" aria-label="分层行情研究"><h4>01 市场状态 · {paRegimeNames[r.regime]}</h4><p>{r.background}</p>
    <div className="related-structures">{r.regimeEvidenceIds.map(id => <button key={id} onClick={() => onReference(id)}>结构依据 · {id.replace('rule-', '')}</button>)}</div>
    <h4>02 区域与价格反应</h4>{r.areaReviews.length ? r.areaReviews.map(item => <div key={item.structureId} className="area-review"><button onClick={() => onReference(item.structureId)}>{({ untested: '尚未测试', testing: '触及测试', reclaimed: '相交后收复', failed: '回补 / 失效' })[item.state]} · {date(item.observedAt)}</button><p>{item.rationale}</p></div>) : <p>未提供可核验的区域反应。</p>}
    <h4>03 末端行情</h4><p>{r.currentContext}</p><h4>04 条件情景</h4>{r.scenarios.length ? r.scenarios.map(item => <div className="research-scenario" key={item.id}><strong>{item.direction === 'bullish' ? '偏多' : '偏空'} · 研究情景</strong><p>{item.thesis}</p><dl><div><dt>确认条件</dt><dd>{item.confirmation}</dd></div><div><dt>取消条件</dt><dd>{item.cancellation}</dd></div></dl></div>) : <p>等待更清晰的行情，不预设交易。</p>}
  </section>;
}
export function EvidenceCoverage({ evidence, analysis, projected }: { evidence: StructureEvidence; analysis?: Analysis; projected?: Analysis }) {
  const references = selectStructureReferences(evidence);
  const count = (a?: Analysis) => a ? a.structures.length + a.priceAction.zones.length + a.priceAction.legs.length + a.priceAction.patterns.length + a.priceAction.breakouts.length + a.liquiditySweeps.length : 0;
  return <section className="evidence-coverage" aria-label="分析覆盖诊断"><strong>来源与覆盖</strong><p>本地规则 {evidence.structures.length} 项 · 模型参考预算 {references.length} 项 / 主要腿 {evidence.legs.filter(item => item.importance === 'major').length} 项 · 分析返回 {count(analysis)} 项 · 坐标投影保留 {count(projected)} 项</p>
    <div className="coverage-windows">{evidence.windows.map(window => <span key={window.id}>{window.coreStart + 1}–{window.coreEnd}根 <b>{window.evidenceIds.length}</b>规则项</span>)}</div>
    <small>{evidence.windows.length}个重叠规则窗口 · 合并重复观测{evidence.merge.duplicateObservations}项 · 全段扫描补回边界/上下文结构{evidence.merge.boundaryRecovered}项。模型一次全局审阅；布局只隐藏文字或局部绘图，不删除规则目录。数量不等于识别质量。</small>
    {analysis?.research?.coverage.length ? <details><summary>模型自述的窗口取舍（不是覆盖率证明）</summary>{analysis.research.coverage.map(item => <p key={item.windowId}>{item.windowId}：展开{item.reviewedIds.length} / 未展开{item.omittedIds.length} · {item.reason}</p>)}</details> : null}
  </section>;
}
