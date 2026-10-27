import { formatDisplayTime } from '../../shared/displayTime';
import type { PositionChartModel } from '../../shared/positionChart';
import {formatPrice} from '../../shared/format';
export function PositionChartLegend({model,sources,onSources,selected,onSelect}:{model:PositionChartModel;sources:Record<'exchange'|'advice'|'original',boolean>;onSources:(next:typeof sources)=>void;selected:string|null;onSelect:(id:string)=>void}){
 const line=model.lines.find(l=>l.id===selected);
 return <div className="position-chart-legend" aria-label="持仓图表说明">
  <div className="position-chart-toggles">{(['exchange','advice','original'] as const).map(source=><label key={source}><input type="checkbox" checked={sources[source]} onChange={e=>onSources({...sources,[source]:e.target.checked})}/>{source==='exchange'?'交易所已设':source==='advice'?'AI建议 · 未执行':'原计划参考'}</label>)}</div>
  <p>{model.historical?'原审阅快照':model.stale?'账户快照已过时':'账户定时同步'} · {formatDisplayTime(model.asOf/1000,true)} UTC+8。左色带：交易所参考；右色带：建议。均从标记价计算。</p>
  <div className="position-line-chips">{model.lines.filter(l=>l.source==='account'||sources[l.source]).map(l=><button key={l.id} aria-pressed={selected===l.id} onClick={()=>onSelect(l.id)} style={{borderColor:l.color}}>{l.label} {formatPrice(l.price)}</button>)}</div>
  {model.metrics.map(m=><p key={m.source}>{m.source==='exchange'?'已设触发价参考':'建议参考'}：剩余风险 {m.risk===null?'无法核验':formatPrice(m.risk)} / 目标空间 {m.reward===null?'无法核验':formatPrice(m.reward)} / {m.ratio===null?'R待核验':m.ratio.toFixed(2)+'R'}。不含费用，不代表保证成交或全仓覆盖。</p>)}
  {line&&<div className="position-line-detail" aria-label="持仓价位详情"><b>{line.label} · {formatPrice(line.price)}</b><p>{line.reason}</p>{line.structureId&&<p>{line.timeframe} · 结构 {line.structureId}</p>}</div>}
  {model.warnings.map((w,i)=><p className="account-sync-meta" key={i}>{w}</p>)}
 </div>;
}
