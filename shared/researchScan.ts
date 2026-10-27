import type { MarketState } from './marketState';
import { currentFacts } from './marketState';
import { RESEARCH_FRAMES, frameRegime } from './researchData';
export interface ResearchTimings {
 mode:'quick-scan'|'quick-ai'|'deep'|'position-review';snapshotId:string;stateVersion:number;
 marketMs:number;rulesMs:number;screenshotMs:number;modelMs:number;validationMs:number;totalMs:number;reusedSnapshot:boolean;
}
/** Presentation budget only; facts, strategies and lifecycle validation stay complete in MarketState. */
export function quickScanSummary(state:MarketState){
 const facts=currentFacts(state),frames=RESEARCH_FRAMES.map(timeframe=>({timeframe,regime:state.bundle.frames[timeframe].integrity.usable?frameRegime(facts.filter(f=>f.timeframe===timeframe)):'unavailable',usable:state.bundle.frames[timeframe].integrity.usable}));
 const background=frames[0].regime,conflicts:string[]=[];
 if(['uptrend','downtrend'].includes(background))for(const frame of frames.slice(1))if(frame.regime===(background==='uptrend'?'downtrend':'uptrend'))conflicts.push(frame.timeframe+'局部结构与15m背景相反，可能是回撤或转换，不能按多空投票。');
 const weight=(event:MarketState['events'][number])=>/data-/.test(event.kind)?30:event.kind==='plan-invalidated'?25:Math.max(0,...event.factIds.map(id=>{const f=facts.find(f=>f.id===id);return f?(f.timeframe==='15m'?12:f.timeframe==='5m'?8:1)+(f.importance==='major'?5:0):0;}));
 return {snapshotId:state.bundle.id,stateVersion:state.version,asOf:state.asOf,frames,conflicts,
  changes:state.events.filter(e=>e.stateVersion===state.version&&['fact-confirmed','fact-resolved','fact-revised','data-revised','data-gap','plan-invalidated','target-review'].includes(e.kind)).sort((a,b)=>weight(b)-weight(a)||b.knownAt-a.knownAt).slice(0,12),
  candidates:[...state.scenarios].sort((a,b)=>Number(b.stage==='conditional')-Number(a.stage==='conditional')||b.score-a.score).slice(0,6).map(c=>({id:c.id,strategyId:c.strategyId,direction:c.direction,stage:c.stage,score:c.score,nextCondition:c.checks.find(check=>!check.passed)?.reason??c.triggerSpec?.summary??'规则门槛已满足，仍等待条件式触发；不代表成交。'})),
  warnings:state.needsReview,planChanges:state.plans.filter(p=>p.needsReview||['invalidated','expired'].includes(p.status)).map(p=>({id:p.id,status:p.status,reasons:p.reviewReasons})),
 };
}
