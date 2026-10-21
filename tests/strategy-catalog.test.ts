import {describe,it,expect} from 'vitest';
import {evaluateStrategies,STRATEGY_CATALOG,validateStrategyPlan} from '../shared/strategyCatalog';
import {AS_OF,researchBundle,strategyFacts} from './research-fixtures';
import {auditStopRisk} from '../shared/tradeRisk';
describe('fixed strategy catalog and structurally grounded plans',()=>{
 it('declares only A/B/C and yields an evidence-backed BOS retest candidate',()=>{
  expect(STRATEGY_CATALOG.map(c=>c.id)).toEqual(['sweep-reclaim','bos-retest','trend-pullback']);
  const b=researchBundle(),facts=strategyFacts(),c=evaluateStrategies(b,facts).find(c=>c.strategyId==='bos-retest'&&c.direction==='bullish')!;
  expect(c.stage).toBe('conditional');expect(c.setup).not.toBeNull();expect(c.sourceByFrame['15m']).not.toEqual([]);expect(c.sourceByFrame['1m']).toContain('local-trigger');
  expect(validateStrategyPlan(c.setup!,c,b,facts)).toEqual(c.setup);expect(c.setup!.stopLoss).toBe(92.75);expect(c.setup!.targets[0].price).toBe(112);
 });
 it('rejects unreclaimed sweeps and requires later 5m then 1m confirmation',()=>{
  const b=researchBundle(),facts=strategyFacts(),sweep={...facts[3],id:'sweep',type:'sweep',knownAt:AS_OF-1500,reclaimTime:null as number|null};
  let c=evaluateStrategies(b,[...facts,sweep]).find(c=>c.strategyId==='sweep-reclaim'&&c.direction==='bullish')!;expect(c.stage).toBe('watching');
  sweep.reclaimTime=AS_OF-1500;const reverse={...facts[3],id:'reverse',type:'CHoCH',knownAt:AS_OF-600};
  c=evaluateStrategies(b,[...facts,sweep,reverse]).find(c=>c.strategyId==='sweep-reclaim'&&c.direction==='bullish')!;expect(c.stage).toBe('conditional');
  c=evaluateStrategies(b,[...facts.filter(f=>f.timeframe!=='1m'),sweep,reverse]).find(c=>c.strategyId==='sweep-reclaim'&&c.direction==='bullish')!;expect(c.stage).toBe('watching');
 });
 it('requires an actual zone reaction and rejects repeatedly tested trend-pullback regions',()=>{
  const b=researchBundle(),facts=strategyFacts(),zone={...facts[3],id:'zone',type:'OB',low:98,high:100,status:'candidate' as const,confirmedAt:null,reactionTime:null as number|null,tests:1};
  const get=()=>evaluateStrategies(b,[...facts,zone]).find(c=>c.strategyId==='trend-pullback'&&c.direction==='bullish')!;
  expect(get().stage).toBe('watching');zone.reactionTime=AS_OF-600;expect(get().stage).toBe('conditional');zone.tests=3;expect(get().stage).toBe('watching');
 });
 it('does not override opposite 15m context with a 1m signal or plan without all three frames',()=>{
  const b=researchBundle(),facts=strategyFacts();facts[0].direction='bearish';
  const c=evaluateStrategies(b,facts).find(c=>c.strategyId==='bos-retest'&&c.direction==='bullish')!;expect(c.setup).toBeNull();expect(c.conflicts.join()).toContain('15m');
  b.frames['15m'].integrity.usable=false;expect(evaluateStrategies(b,strategyFacts()).every(c=>c.stage==='watching')).toBe(true);
 });
 it('does not move a near target or tighten a stop to satisfy RR',()=>{
  const b=researchBundle(),facts=strategyFacts();facts.push({...facts[2],id:'near-target',low:102,high:102});
  const c=evaluateStrategies(b,facts).find(c=>c.strategyId==='bos-retest'&&c.direction==='bullish')!;expect(c.setup).toBeNull();expect(c.proposalReason).toContain('1R');
 });
 it('filters overextension and old local confirmations',()=>{
  const b=researchBundle(),facts=strategyFacts();b.frames['1m'].candles.at(-1)!.close=130;b.frames['1m'].candles.at(-1)!.high=131;
  expect(evaluateStrategies(b,facts).find(c=>c.strategyId==='bos-retest'&&c.direction==='bullish')!.setup).toBeNull();
  facts.at(-1)!.knownAt=AS_OF-1000;expect(evaluateStrategies(researchBundle(),facts).every(c=>c.setup===null)).toBe(true);
 });
 it.each(['1m','5m'] as const)('does not keep an old same-direction setup after a newer opposing %s structure',tf=>{
  const b=researchBundle(),facts=strategyFacts(),reverse={...facts.at(-1)!,id:'new-opposition',timeframe:tf,type:'CHoCH',direction:'bearish' as const,knownAt:AS_OF-10};
  const c=evaluateStrategies(b,[...facts,reverse]).find(c=>c.strategyId==='bos-retest'&&c.direction==='bullish')!;expect(c.stage).toBe('watching');expect(c.oppositionIds).toContain('new-opposition');
 });
 it('caps correlated evidence credit and never scores duplicate structures as extra votes',()=>{
  const b=researchBundle(),facts=strategyFacts(),one=evaluateStrategies(b,facts).find(c=>c.strategyId==='bos-retest'&&c.direction==='bullish')!;
  const copies=[...facts,...facts.map(f=>({...f,id:f.id+'-copy'}))],two=evaluateStrategies(b,copies).find(c=>c.strategyId==='bos-retest'&&c.direction==='bullish')!;expect(two.score).toBe(one.score);
  facts.forEach(f=>f.familyId='one-price-move');const grouped=evaluateStrategies(b,facts).find(c=>c.strategyId==='bos-retest'&&c.direction==='bullish')!;expect(grouped.score).toBeLessThan(one.score);expect(grouped.eventGroups).toEqual(['one-price-move']);
 });
 it.each(['wrong-stop','wrong-target','unknown-id','future','wrong-anchor','tight-buffer'])('rejects invalid %s geometry without mutating it',kind=>{
  const b=researchBundle(),facts=strategyFacts(),c=evaluateStrategies(b,facts).find(c=>c.setup)!,plan=structuredClone(c.setup!);
  if(kind==='wrong-stop')plan.stopLoss=101;if(kind==='wrong-target')plan.targets[0].price=111;if(kind==='unknown-id')plan.structureIds.push('invented');if(kind==='future')facts.find(f=>f.id==='target')!.knownAt=AS_OF+60;if(kind==='wrong-anchor')plan.anchorTime-=60;if(kind==='tight-buffer')plan.stopLoss=94.99;
  const original=structuredClone(plan);expect(()=>validateStrategyPlan(plan,c,b,facts)).toThrow();expect(plan).toEqual(original);
 });
});
