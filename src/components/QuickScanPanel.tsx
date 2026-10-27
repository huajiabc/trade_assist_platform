import { formatDisplayTime } from '../../shared/displayTime';
import type { MarketState } from '../../shared/marketState';
import { quickScanSummary } from '../../shared/researchScan';
import { strategyName } from '../../shared/strategyTypes';
export function QuickScanPanel({state,onCandidate,onFact,open=false}:{state:MarketState;onCandidate:(id:string)=>void;onFact:(id:string)=>void;open?:boolean}){
 const scan=quickScanSummary(state);
 return <details className="quick-scan-summary" open={open}><summary>快速扫描 · 本地规则 · v{scan.stateVersion}</summary>
  <p>15m背景 → 5m机会与保护 → 1m触发；规则更新不调用AI。</p>
  {scan.conflicts.map((c,i)=><p className="research-conflict" key={i}>{c}</p>)}
  {!scan.changes.length?<p>本次没有新增的重要结构变化。</p>:<ul>{scan.changes.slice(0,5).map(e=><li key={e.id}><button className="button text-button" disabled={!e.factIds.length} onClick={()=>onFact(e.factIds[0])}>{e.reason}</button></li>)}</ul>}
  <div className="quick-candidates">{scan.candidates.slice(0,3).map(c=><button key={c.id} onClick={()=>onCandidate(c.id)}><b>{strategyName(c.strategyId)} · {c.stage==='conditional'?'条件候选':'等待'}</b><span>{c.nextCondition}</span></button>)}</div>
  {scan.planChanges.length>0&&<p className="research-conflict">{scan.planChanges.length} 个已有计划需要复核、已失效或过期；完整原因在版本管理中。</p>}
  <small>快照 {scan.snapshotId} · {formatDisplayTime(scan.asOf)+' UTC+8'} · 符合度不是胜率</small>
 </details>;
}
