import type { StrategyCandidate } from './strategyCatalog';
import type { ResearchFact } from './researchData';
import { contentId } from './researchData';
import type { StrategyId } from './strategyTypes';

/** A presentation group only. Each member retains its own executable conditions and prices. */
export interface OpportunityGroup {
 id:string;
 direction:StrategyCandidate['direction'];
 primary:StrategyCandidate;
 members:StrategyCandidate[];
 strategyIds:StrategyId[];
 explanation:string;
 lineageIds:string[];
}
const EVENT_TYPES=new Set(['sweep','BOS','CHoCH','FVG','OB','failed-breakout','displacement']);
const close=(a:number,b:number)=>Math.abs(a-b)<=Math.max(Number.EPSILON*16,Math.max(Math.abs(a),Math.abs(b))*Number.EPSILON*16);
function triggerArea(c:StrategyCandidate):[number,number]|null {
 const plan=c.setup;if(!plan)return null;
 const spec=c.triggerSpec;
 if(spec&&Number.isFinite(spec.entryLow)&&Number.isFinite(spec.entryHigh)&&spec.entryLow<=spec.entryHigh)return [spec.entryLow,spec.entryHigh];
 // Old records have only a point entry. Keep the fallback band much smaller than their actual risk.
 const radius=Math.min(Math.abs(plan.entry-plan.stopLoss)*.03,Math.abs(plan.entry)*.00005);
 return Number.isFinite(radius)?[plan.entry-radius,plan.entry+radius]:null;
}
function lineage(c:StrategyCandidate,facts:Map<string,ResearchFact>):Set<string>{
 const primary=facts.get(c.primaryFactId??c.sourceByFrame['5m'][0]);
 if(!primary||primary.timeframe!=='5m'||primary.knownAt>c.asOf||!EVENT_TYPES.has(primary.type))return new Set();
 // Family buckets, background facts, and shared protection are deliberately insufficient.
 const ids=new Set([primary.id]);
 for(const id of primary.relatedIds??[]){const fact=facts.get(id);if(fact?.timeframe==='5m'&&fact.knownAt<=c.asOf&&EVENT_TYPES.has(fact.type))ids.add(id);}
 return ids;
}
function compatible(a:StrategyCandidate,b:StrategyCandidate,facts:Map<string,ResearchFact>):boolean{
 if(a.direction!==b.direction||a.snapshotId!==b.snapshotId||a.asOf!==b.asOf||!a.setup||!b.setup)return false;
 const al=lineage(a,facts),bl=lineage(b,facts);
 if(![...al].some(id=>bl.has(id)))return false;
 const aa=triggerArea(a),ba=triggerArea(b);
 if(!aa||!ba||Math.max(aa[0],ba[0])>Math.min(aa[1],ba[1]))return false;
 const ab=a.setup.basis,bb=b.setup.basis;
 if(!ab||!bb||!ab.stopStructureId||ab.stopStructureId!==bb.stopStructureId||!ab.targetStructureIds[0]||ab.targetStructureIds[0]!==bb.targetStructureIds[0])return false;
 // Equal anchors with materially different geometry still remain separate opportunities.
 return close(a.setup.stopLoss,b.setup.stopLoss)&&!!a.setup.targets[0]&&!!b.setup.targets[0]&&close(a.setup.targets[0].price,b.setup.targets[0].price);
}
export function groupStrategyOpportunities(candidates:StrategyCandidate[],facts:ResearchFact[]):OpportunityGroup[]{
 const entries=new Map(facts.map(f=>[f.id,f]));const groups:OpportunityGroup[]=[];
 for(const candidate of candidates){
  if(candidate.stage!=='conditional'||!candidate.setup)continue;
  // Complete-link matching avoids a chain of broad trigger zones joining unrelated end members.
  const group=groups.find(g=>g.members.every(member=>compatible(member,candidate,entries)));
  if(group){group.members.push(candidate);if(!group.strategyIds.includes(candidate.strategyId))group.strategyIds.push(candidate.strategyId);}
  else groups.push({id:'',direction:candidate.direction,primary:candidate,members:[candidate],strategyIds:[candidate.strategyId],explanation:'',lineageIds:[]});
 }
 for(const group of groups){
  group.id='opportunity-'+contentId(group.members.map(m=>m.id).sort());
  group.lineageIds=[...new Set(group.members.flatMap(m=>[...lineage(m,entries)]))].filter(id=>group.members.length===1||group.members.filter(m=>lineage(m,entries).has(id)).length>1).sort();
  group.explanation=group.members.length>1?'同向候选引用同一明确行情事件，触发区相交且保护与首目标一致；合并展示，不重复加分。各策略触发仍分别核验。':'独立条件候选；规则符合度用于排序，不表示胜率。';
 }
 return groups;
}
