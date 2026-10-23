import type { StrategyCandidate } from '../../shared/strategyCatalog';
import type { TradeSetup } from '../../shared/analysis';
import { assessEntryFeasibility, type RouteLevel } from '../../shared/planHorizon';
import { formatPrice } from '../../shared/format';
interface Props { candidate: StrategyCandidate; setup?: TradeSetup; lastPrice?: number; triggerPrice?: number; onLevel: (level: RouteLevel) => void }
export function PlanRoute({candidate,setup,lastPrice,triggerPrice,onLevel}:Props){
 const route=candidate.horizon;
 const check=setup&&lastPrice!==undefined?assessEntryFeasibility(setup,lastPrice,candidate.triggerSpec,candidate.planPolicy?.profile==='structural'?1.5:1):null;
 const trigger=setup&&triggerPrice!==undefined?assessEntryFeasibility(setup,triggerPrice,candidate.triggerSpec,candidate.planPolicy?.profile==='structural'?1.5:1):null;
 return <div className="plan-route">
  {route&&<><p className={'plan-route-status '+(route.status==='open'?'':'is-waiting')}>{route.reason}</p>
   {route.objectives.length>0&&<div className="plan-route-objectives">{route.objectives.map((level,i)=><button key={level.structureId} onClick={()=>onLevel(level)}><span>{level.timeframe} {i===0?'主要目标':'延伸观察'} · {level.type}</span><strong>{formatPrice(level.price)}</strong>{setup&&<small>距离 {formatPrice(Math.abs(level.price-setup.entry))} · {(Math.abs(level.price-setup.entry)/setup.entry*100).toFixed(2)}%</small>}</button>)}</div>}
   {route.obstacles.length>0&&<details className="plan-obstacles"><summary>途中检查点 · {route.obstacles.length}{route.blockingIds.length>0?' · 主要阻挡待处理':' · 不等同最终TP'}</summary><ul>{route.obstacles.map(level=><li key={level.structureId}><button onClick={()=>onLevel(level)}>{level.timeframe} {level.type} · {formatPrice(level.price)}</button><span>{route.blockingIds.includes(level.structureId)?'1R内主要阻挡':level.importance==='major'?'主要阻挡，需观察反应':'局部检查点'}</span></li>)}</ul></details>}
  </>}
  {check&&<p className="plan-entry-review"><b>末根收盘 {formatPrice(check.price)}</b> · 复核 {Math.max(0,check.ratio).toFixed(2)}R<br/>{check.reason}</p>}
  {trigger&&<p className="plan-entry-review"><b>触发收盘 {formatPrice(trigger.price)}</b> · 复核 {Math.max(0,trigger.ratio).toFixed(2)}R<br/>{trigger.reason} 条件满足不代表成交。</p>}
 </div>;
}
