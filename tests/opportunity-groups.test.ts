import { describe,expect,it } from 'vitest';
import { groupStrategyOpportunities } from '../shared/opportunityGroups';
import type { StrategyCandidate } from '../shared/strategyCatalog';
import type { StrategyId } from '../shared/strategyTypes';
import { strategyFacts,AS_OF } from './research-fixtures';

const tracking={steps:[{label:'回踩',conditions:[{type:'touch-zone' as const,price:99,priceEnd:101}]},{label:'方向收盘',conditions:[{type:'close-above' as const,price:101,priceEnd:null}]}],cancellation:{basis:'close' as const,price:95,label:'保护失守'},expiresAfterBars:30};
function candidate(id:string,strategyId:StrategyId='sweep-reclaim'):StrategyCandidate{
 return {id,strategyId,direction:'bullish',scenarioId:'scenario-'+id,stage:'conditional',score:8,snapshotId:'snapshot',asOf:AS_OF,checks:[],supportIds:['five-break','five-protect','target','local-trigger'],oppositionIds:[],eventGroups:['one-family'],conflicts:[],uncertainties:[],sourceByFrame:{'15m':['background'],'5m':['five-break','five-protect'],'1m':['local-trigger']},expiresAt:AS_OF+1800,triggerObservedAt:AS_OF-60,proposalReason:'受控展示合同',primaryFactId:'five-break',setup:{id:id+'-plan',opportunityId:null,strategyId,status:'candidate',direction:'bullish',anchorTime:AS_OF-60,entry:100,stopLoss:94,targets:[{price:112,label:'结构目标'}],structureIds:['five-break','five-protect','target','local-trigger'],trigger:id+' 独立触发',tracking:structuredClone(tracking),basis:{scenarioId:'scenario-'+id,entryStructureId:'local-trigger',stopStructureId:'five-protect',targetStructureIds:['target']},rationale:'受控展示数据，不是检测结果',invalidation:'保护失效'}};
}
function band(c:StrategyCandidate,low:number,high:number){c.triggerSpec={strategyId:c.strategyId,entryLow:low,entryHigh:high,confirmationPrice:high,evidenceIds:['local-trigger'],knownAt:AS_OF-60,summary:c.id+' 独立区域与确认',tracking:structuredClone(tracking)};return c;}

describe('conservative cross-strategy opportunity presentation',()=>{
 it('groups shared explicit events without rewriting members, geometry, triggers or rank scores',()=>{
  const a=candidate('a'),d=candidate('d','range-reversal');d.score=7;const before=structuredClone([a,d]),groups=groupStrategyOpportunities([a,d],strategyFacts());
  expect(groups).toHaveLength(1);expect(groups[0].primary).toBe(a);expect(groups[0].members).toEqual([a,d]);expect(groups[0].strategyIds).toEqual(['sweep-reclaim','range-reversal']);expect(groups[0].lineageIds).toEqual(['five-break']);expect([a,d]).toEqual(before);expect(groups[0].members.map(c=>c.setup!.trigger)).toEqual(['a 独立触发','d 独立触发']);
 });
 it('gives grouping a deterministic membership ID while preserving the incoming best candidate rank',()=>{
  const a=candidate('a'),b=candidate('b','bos-retest');const first=groupStrategyOpportunities([a,b],strategyFacts())[0],reordered=groupStrategyOpportunities([b,a],strategyFacts())[0];expect(first.id).toBe(reordered.id);expect(reordered.primary).toBe(b);
 });
 it('accepts explicit related event lineage with overlapping areas and independent confirmations',()=>{
  const facts=strategyFacts(),a=band(candidate('a'),99,101),b=band(candidate('b','displacement-continuation'),100.5,101.5);b.primaryFactId='displacement';b.sourceByFrame['5m'][0]='displacement';facts.push({...facts[3],id:'displacement',type:'displacement',relatedIds:['five-break']});b.triggerSpec!.confirmationPrice=103;b.setup!.entry=101;expect(groupStrategyOpportunities([a,b],facts)).toHaveLength(1);expect(b.triggerSpec!.confirmationPrice).toBe(103);
 });
 it('does not equate the same background, protection, family bucket or coincident coordinates with explicit event lineage',()=>{
  const facts=strategyFacts(),a=candidate('a'),b=candidate('b','trend-pullback');facts.push({...facts[3],id:'unrelated-zone',type:'OB',familyId:facts[3].familyId});b.primaryFactId='unrelated-zone';b.sourceByFrame['5m'][0]='unrelated-zone';expect(groupStrategyOpportunities([a,b],facts)).toHaveLength(2);
 });
 it('keeps disjoint exact trigger areas separate even with the same event',()=>{const a=band(candidate('a'),99,100),b=band(candidate('b','range-reversal'),100.01,101);expect(groupStrategyOpportunities([a,b],strategyFacts())).toHaveLength(2);});
 it('uses a conservative risk-bounded point tolerance for old plans',()=>{const a=candidate('a'),b=candidate('b','range-reversal');delete a.primaryFactId;delete b.primaryFactId;b.setup!.entry=100.2;expect(groupStrategyOpportunities([a,b],strategyFacts())).toHaveLength(2);b.setup!.entry=100.004;expect(groupStrategyOpportunities([a,b],strategyFacts())).toHaveLength(1);});
 it.each(['protection','target-anchor','target-price','stop-price','snapshot','opposite'] as const)('keeps incompatible %s members separate',change=>{const a=candidate('a'),b=candidate('b','range-reversal');if(change==='protection')b.setup!.basis!.stopStructureId='different-stop';if(change==='target-anchor')b.setup!.basis!.targetStructureIds[0]='different-target';if(change==='target-price')b.setup!.targets[0].price=115;if(change==='stop-price')b.setup!.stopLoss=93;if(change==='snapshot')b.snapshotId='other';if(change==='opposite')b.direction='bearish';expect(groupStrategyOpportunities([a,b],strategyFacts())).toHaveLength(2);});
 it('does not form a transitive chain whose first and last trigger areas do not intersect',()=>{const a=band(candidate('a'),99,100),b=band(candidate('b','range-reversal'),99.5,100.5),c=band(candidate('c','failed-breakout'),100.25,101);const groups=groupStrategyOpportunities([a,b,c],strategyFacts());expect(groups.map(g=>g.members.map(m=>m.id))).toEqual([['a','b'],['c']]);});
 it('leaves waiting and incomplete candidates in the underlying data without advertising opportunities',()=>{const a=candidate('a'),b=candidate('b');a.stage='watching';b.setup=null;expect(groupStrategyOpportunities([a,b],strategyFacts())).toEqual([]);expect(a.stage).toBe('watching');expect(b.setup).toBeNull();});
 it('does not use later-known facts as evidence for an earlier opportunity group',()=>{const facts=strategyFacts();facts.find(f=>f.id==='five-break')!.knownAt=AS_OF+60;expect(groupStrategyOpportunities([candidate('a'),candidate('b')],facts)).toHaveLength(2);});
 it('keeps candidates separate if referenced event facts are unavailable',()=>{expect(groupStrategyOpportunities([candidate('a'),candidate('b')],[])).toHaveLength(2);});
});
