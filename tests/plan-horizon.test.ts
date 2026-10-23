import {updateMarketState,saveCandidatePlan} from '../shared/marketState';
import {describe,it,expect} from 'vitest';
import {buildPlanHorizon,assessEntryFeasibility,protectionBoundary} from '../shared/planHorizon';
import {STRUCTURAL_PLAN_POLICY,MICRO_PLAN_POLICY} from '../shared/planPolicy';
import {evaluateStrategies,validateStrategyPlan} from '../shared/strategyCatalog';
import {researchBundle,strategyFacts,AS_OF} from './research-fixtures';
const selected=(facts= strategyFacts())=>evaluateStrategies(researchBundle(),facts).find(c=>c.strategyId==='bos-retest'&&c.direction==='bullish')!;
describe('trade horizon roles and real objective routes',()=>{
 it('keeps a 15m objective when 1m highs and local 5m obstacles are close',()=>{
  const facts=strategyFacts();facts.push({...facts[2],id:'minor-five',timeframe:'5m',importance:'local',low:102,high:102}, {...facts[2],id:'minute-target',timeframe:'1m',low:101,high:101});
  const c=selected(facts);expect(c.stage).toBe('conditional');expect(c.setup!.targets).toEqual([{price:112,label:'15m HH主要结构目标'}]);expect(c.horizon!.obstacles.map(f=>f.structureId)).toEqual(['minor-five']);expect(c.setup!.basis!.targetStructureIds).toEqual(['target']);
  expect(c.setup!.stopLoss).toBe(92.75);expect(validateStrategyPlan(c.setup!,c,researchBundle(),facts)).toEqual(c.setup);
 });
 it('retains the distant path but blocks a major barrier within 1R',()=>{
  const facts=strategyFacts();facts.push({...facts[2],id:'major-five',timeframe:'5m',low:102,high:102});
  const c=selected(facts);expect(c.setup).toBeNull();expect(c.horizon).toMatchObject({status:'obstructed',blockingIds:['major-five']});expect(c.horizon!.objectives[0].price).toBe(112);expect(c.proposalReason).toContain('主要阻挡');
 });
 it('does not choose a further 15m objective to rescue an inadequate nearest major objective',()=>{
  const facts=strategyFacts();facts.push({...facts[2],id:'near-fifteen',low:102,high:102},{...facts[2],id:'far-fifteen',low:130,high:130});
  const c=selected(facts);expect(c.setup).toBeNull();expect(c.horizon!.objectives.map(f=>f.price)).toEqual([102,112,130]);expect(facts[2].low).toBe(112);
 });
 it('does not silently substitute tiny 5m targets for missing 15m objectives',()=>{
  const facts=strategyFacts().filter(f=>f.id!=='target');facts.push({...strategyFacts()[2],id:'five-target',timeframe:'5m',low:110,high:110});
  const c=selected(facts);expect(c.setup).toBeNull();expect(c.horizon!.status).toBe('missing-objective');expect(c.horizon!.obstacles[0].structureId).toBe('five-target');
  const micro=evaluateStrategies(researchBundle(),facts,MICRO_PLAN_POLICY).find(c=>c.strategyId==='bos-retest'&&c.direction==='bullish')!;expect(micro.setup?.targets[0].price).toBe(110);expect(micro.setup?.rationale).toContain('局部短线以最近实际结构为目标');
 });
 it('uses only confirmed, then-known targets and deduplicates actual price coordinates',()=>{
  const b=researchBundle(),facts=strategyFacts();facts.push({...facts[2],id:'future',low:103,high:103,confirmedAt:AS_OF+60}, {...facts[2],id:'candidate',low:104,high:104,status:'candidate',confirmedAt:null},{...facts[2],id:'duplicate'});
  const route=buildPlanHorizon(b,facts,'bullish',100,92.75,STRUCTURAL_PLAN_POLICY);expect(route.objectives).toHaveLength(1);expect(route.objectives[0].price).toBe(112);expect(route.obstacles).toEqual([]);
 });
 it('preserves all intermediate checkpoints rather than capping them to chart density',()=>{
  const facts=strategyFacts();facts.push(...Array.from({length:30},(_,i)=>({...facts[2],id:'local-'+i,timeframe:'5m' as const,importance:'local' as const,low:101+i/10,high:101+i/10})));
  const c=selected(facts);expect(c.setup!.targets[0].price).toBe(112);expect(c.horizon!.obstacles).toHaveLength(30);
 });
 it('rejects tampering with target provenance or deleting a route obstacle',()=>{
  const facts=strategyFacts();facts.push({...facts[2],id:'minor-five',timeframe:'5m',importance:'local',low:102,high:102});
  const c=selected(facts),bad=structuredClone(c);bad.horizon!.obstacles=[];expect(()=>validateStrategyPlan(bad.setup!,bad,researchBundle(),facts)).toThrow('目标周期');
  const badTarget=structuredClone(c);badTarget.setup!.targets[0].price=102;badTarget.setup!.basis!.targetStructureIds=['minor-five'];badTarget.setup!.structureIds.push('minor-five');expect(()=>validateStrategyPlan(badTarget.setup!,badTarget,researchBundle(),facts)).toThrow();
 });
 it('protects the actual 5m event instead of a newer pivot inside the event',()=>{
  const b=researchBundle(),facts=strategyFacts();expect(protectionBoundary(b,facts[3],'bullish')).toBe(95);
  facts.push({...facts[4],id:'new-tight-pivot',low:97,high:97,knownAt:AS_OF-300});const c=selected(facts);expect(c.setup!.basis!.stopStructureId).toBe('five-protect');expect(c.setup!.stopLoss).toBe(92.75);
 });
 it('protects the real retest wick when it extends beyond the original BOS candle',()=>{const b=researchBundle(),facts=strategyFacts();const retest=b.frames['5m'].candles.find(bar=>bar.timestamp>=facts[3].knownAt)!;retest.low=93;expect(protectionBoundary(b,facts[3],'bullish')).toBe(93);const c=evaluateStrategies(b,facts).find(c=>c.strategyId==='bos-retest'&&c.direction==='bullish')!;expect(c.setup).toBeNull();expect(c.checks.find(check=>check.key==='protection')!.passed).toBe(false);});
 it('maps bearish targets in descending order using true upper boundaries',()=>{
  const b=researchBundle(),base=strategyFacts()[2],facts=[{...base,id:'near-short',type:'LL',low:88,high:89},{...base,id:'far-short',type:'liquidity-low',low:80,high:81},{...base,id:'short-check',timeframe:'5m' as const,importance:'local' as const,type:'LL',low:97,high:98}];
  const route=buildPlanHorizon(b,facts,'bearish',100,107,STRUCTURAL_PLAN_POLICY);expect(route.objectives.map(f=>f.price)).toEqual([89,81]);expect(route.obstacles[0].price).toBe(98);expect(route.status).toBe('open');
 });
});
describe('reference entry versus currently available geometry',()=>{
 it('saves a new-catalog candidate independently of the same-snapshot legacy plan without overwriting it',()=>{const state=updateMarketState(null,researchBundle()),facts=strategyFacts();state.facts=Object.fromEntries(facts.map(fact=>[fact.id,{current:true,versions:[{stateVersion:1,knownAt:AS_OF,reason:'controlled legacy contract',fact}]}]));state.scenarios=evaluateStrategies(state.bundle,facts);const c=state.scenarios.find(c=>c.stage==='conditional')!,saved=saveCandidatePlan(state,c.id),legacy=structuredClone(saved.plans[0]);const legacySetupId='bos-retest-bullish-1xb5s6t-12k4721-plan';legacy.id=saved.plans[0].id.replace(c.setup!.id,legacySetupId);legacy.versions[0].setup.id=legacySetupId;const before=structuredClone(legacy),result=saveCandidatePlan({...state,plans:[legacy]},c.id);expect(result.plans).toHaveLength(2);expect(result.plans[0]).toEqual(before);expect(result.plans[1].versions[0].setup.id).not.toBe(legacySetupId);});
 it('requires an explicit fresh assessment before saving a candidate from an old catalog',()=>{const state=updateMarketState(null,researchBundle());state.catalogVersion='catalog-2.1';const before=structuredClone(state);expect(()=>saveCandidatePlan(state,'old')).toThrow('目录已升级');expect(state).toEqual(before);});
 it('does not advertise the old reference R when confirmation moved the price',()=>{
  const c=selected(),before=structuredClone(c.setup!);const check=assessEntryFeasibility(c.setup!,106,c.triggerSpec,1.5);expect(check.state).toBe('space-insufficient');expect(check.ratio).toBeLessThan(.5);expect(c.setup).toEqual(before);
 });
 it('distinguishes being outside the entry area from insufficient room',()=>{
  const c=selected();expect(assessEntryFeasibility(c.setup!,99,c.triggerSpec,1.5).state).toBe('outside-entry');expect(assessEntryFeasibility(c.setup!,100,c.triggerSpec,1.5).state).toBe('within-plan');expect(assessEntryFeasibility(c.setup!,113,c.triggerSpec,1.5).state).toBe('space-insufficient');
 });
});
