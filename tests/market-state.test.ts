import {describe,it,expect} from 'vitest';
import {AS_OF,frame,researchBundle,strategyFacts} from './research-fixtures';
import {makeResearchBundle,RESEARCH_FRAMES,type ResearchFrame} from '../shared/researchData';
import {evaluateStrategies} from '../shared/strategyCatalog';
import {updateMarketState,saveCandidatePlan,acceptPlanUpdate,planUpdateProposal,acceptInterpretation,currentFacts,modelContext,recordActualPosition,exportResearchState,targetObservations,type MarketState} from '../shared/marketState';
import {localWorkbenchInterpretation} from '../shared/workbenchAnalysis';
function seeded():MarketState {
 const state=updateMarketState(null,researchBundle(),'受控合同',1000),facts=strategyFacts();
 state.facts=Object.fromEntries(facts.map(f=>[f.id,{current:true,versions:[{stateVersion:1,knownAt:AS_OF,reason:'受控合同',fact:f}]}]));state.scenarios=evaluateStrategies(state.bundle,facts);return state;
}
function saved(){const state=seeded(),c=state.scenarios.find(c=>c.stage==='conditional')!;return saveCandidatePlan(state,c.id);}
const confirmedTriggerRows=()=>[{low:99.8,high:100.5,close:100.2},{low:100.1,high:100.8,close:100.4},{low:100.4,high:101.4,close:101.2}];
function targetRevisionState(original=saved()):MarketState {
 const facts=strategyFacts(),target={...facts[2],id:'new-target',low:116,high:116,knownAt:AS_OF+300,formedAt:AS_OF+300,confirmedAt:AS_OF+300};
 const f=frame('1m');f.observedAt=AS_OF+300;for(let i=0;i<5;i++)f.candles.push({timestamp:AS_OF+i*60,open:100,close:100,high:101,low:99,volume:1});f.lastClosedTime=f.candles.at(-1)!.timestamp;
 const five=frame('5m');five.observedAt=AS_OF+300;five.candles.push({...five.candles.at(-1)!,timestamp:AS_OF});five.lastClosedTime=AS_OF;
 const bundle=makeResearchBundle(original.symbol,[frame('15m'),five,f],AS_OF+300),newFacts=[...facts.filter(f=>f.id!=='target'),target];newFacts.find(f=>f.id==='local-trigger')!.knownAt=AS_OF+240;
 return {...original,asOf:bundle.asOf,bundle,version:original.version+1,snapshots:{...original.snapshots,...Object.fromEntries(RESEARCH_FRAMES.map(tf=>[bundle.frames[tf].id,bundle.frames[tf]]))},facts:{...Object.fromEntries(Object.entries(original.facts).map(([id,record])=>[id,{...record,current:false}])),...Object.fromEntries(newFacts.map(f=>[f.id,{current:true,versions:[{stateVersion:3,knownAt:bundle.asOf,reason:'新增结构',fact:f}]}]))},scenarios:evaluateStrategies(bundle,newFacts)};
}
function future(rows:{low:number;high:number;close:number}[]){const inputs=RESEARCH_FRAMES.map(tf=>frame(tf));const one=inputs.find(f=>f.timeframe==='1m')!;
 rows.forEach((r,i)=>one.candles.push({timestamp:AS_OF+i*60,open:r.close,volume:1,...r}));one.lastClosedTime=one.candles.at(-1)!.timestamp;inputs.forEach(f=>f.observedAt=AS_OF+rows.length*60);return makeResearchBundle('SNDKUSDT',inputs,AS_OF+rows.length*60);}
describe('versioned market facts, interpretation and plan lifecycle',()=>{
 it('preserves previous values, immutable fact revisions and original snapshot identities',()=>{
 const b=researchBundle(),first=updateMarketState(null,b,'initial',1000),f=b.frames['1m'];
 const revised=structuredClone(b);revised.frames['1m'].candles[10].volume=5;
 const nextBundle=makeResearchBundle(b.symbol,RESEARCH_FRAMES.map(tf=>{const {id:_,integrity:__,...input}=revised.frames[tf];return input;}),AS_OF);
 const before=structuredClone(first),next=updateMarketState(first,nextBundle,'修订',2000);
 expect(first).toEqual(before);expect(next.version).toBe(2);expect(next.snapshots[f.id]).toEqual(f);expect(next.needsReview.join()).toContain('修订');expect(next.events.some(e=>e.kind==='data-revised')).toBe(true);
 expect(updateMarketState(next,nextBundle)).toBe(next);
 });
 it('records a real structure resolution as a new fact version without erasing its earlier confirmation',()=>{
  const input=frame('1m',80);input.candles=input.candles.map((b,i)=>{const price=100+Math.sin(i*.7)*7+i*.4;return {...b,open:price-.2,close:price,high:price+1,low:price-1};});
  const full=makeResearchBundle('SNDKUSDT',[input],AS_OF);let found=false;
  for(let n=20;n<60;n+=5){const rows=input.candles.slice(0,n),asOf=rows.at(-1)!.timestamp+60,prefix=makeResearchBundle('SNDKUSDT',[{...input,candles:rows,lastClosedTime:rows.at(-1)!.timestamp,observedAt:asOf}],asOf),old=updateMarketState(null,prefix),next=updateMarketState(old,full);
   const revised=Object.values(next.facts).find(r=>r.versions.length>1&&r.versions[0].fact.status==='confirmed'&&r.versions.at(-1)!.fact.status==='resolved');
   if(revised){expect(revised.versions[0].fact.resolvedAt).toBeNull();expect(revised.versions.at(-1)!.fact.resolvedAt).toBeGreaterThan(revised.versions[0].fact.knownAt);expect(next.events.some(e=>e.kind==='fact-resolved')).toBe(true);found=true;break;}
  }expect(found).toBe(true);
 });
 it('records data gaps and rejects a stale request rolling current state backwards',()=>{
 const s=updateMarketState(null,researchBundle());const f=frame('1m');f.candles.splice(12,1);
 const b=makeResearchBundle('SNDKUSDT',[frame('15m'),frame('5m'),f],AS_OF),next=updateMarketState(s,b);
 expect(next.needsReview.join()).toContain('缺口');expect(next.events.some(e=>e.kind==='data-gap')).toBe(true);
 expect(()=>updateMarketState(next,makeResearchBundle('SNDKUSDT',[frame('1m')],AS_OF-60))).toThrow(/回滚/);
 });
 it('stores AI interpretations separately and marks an in-flight old result historical',()=>{
 const s=seeded(),context=modelContext(s),interpretation=localWorkbenchInterpretation(context),next=updateMarketState(s,future([{low:99.5,high:101,close:100}]));
 const before=structuredClone(next.facts),reviewed=acceptInterpretation(next,context,interpretation,'fixture','ai');
 expect(reviewed.facts).toEqual(before);expect(reviewed.interpretation[0].snapshotId).toBe(s.bundle.id);expect(reviewed.needsReview.join()).toContain('审阅期间行情已更新');expect(reviewed.plans).toEqual([]);
 });
 it('tracks conditions and later reference targets while never promoting them into actual positions',()=>{
 const original=saved(),before=structuredClone(original),rows=[...confirmedTriggerRows(),{low:101.2,high:113,close:111}];
 const next=updateMarketState(original,future(rows));const p=next.plans[0];
 expect(p.tracking!.triggeredAt).toBe(AS_OF+120);expect(p.tracking!.targetTimes[0]).toBe(AS_OF+180);expect(p.status).toBe('targets-touched');expect(next.positions).toEqual([]);
 expect(targetObservations(next,p)[0].status).toBe('reference-touched');expect(p.versions[0].targets[0].status).toBe('active');expect(original).toEqual(before);
 expect(next.events.some(e=>e.kind==='reference-target')).toBe(true);
 });
 it('cancels target space consumed before entry and never later revives a cancelled candidate',()=>{
 const s=saved(),first=updateMarketState(s,future([{low:99.9,high:113,close:100.2}]));expect(first.plans[0].status).toBe('invalidated');
 const second=updateMarketState(first,future([{low:99.9,high:113,close:100.2},{low:100,high:101,close:100.8}]));
 expect(second.plans[0].status).toBe('invalidated');expect(second.plans[0].tracking!.triggeredAt).toBeNull();expect(second.positions).toEqual([]);
 });
 it('keeps same-bar stop/target ordering ambiguous rather than fabricating a profitable trade',()=>{
 const s=saved(),next=updateMarketState(s,future([...confirmedTriggerRows(),{low:90,high:113,close:100}]));
 expect(next.plans[0].tracking!.phase).toBe('ambiguous');expect(next.positions).toHaveLength(0);
 });
 it('retracts a derived target observation after OHLC revision and marks the plan for review',()=>{
  const rows=[...confirmedTriggerRows(),{low:101.2,high:113,close:111}],before=updateMarketState(saved(),future(rows));
  const revised=structuredClone(rows);revised[3]={low:101.2,high:110,close:109};const next=updateMarketState(before,future(revised));
  expect(next.plans[0].tracking!.targetTimes[0]).toBeNull();expect(next.plans[0].status).toBe('needs-review');expect(next.events.some(e=>e.kind==='reference-event-retracted')).toBe(true);expect(next.events.some(e=>e.kind==='reference-target')).toBe(true);
  expect(next.plans[0].versions[0].setup.targets).toEqual(before.plans[0].versions[0].setup.targets);
 });
 it('does not modify target prices for an ordinary reverse candle or an unconfirmed proposal',()=>{
 const s=saved(),price=s.plans[0].versions[0].setup.targets[0].price,next=updateMarketState(s,future([{low:99.5,high:100.4,close:99.8}]));
 expect(next.plans[0].versions).toHaveLength(1);expect(next.plans[0].versions[0].setup.targets[0].price).toBe(price);expect(planUpdateProposal(next,next.plans[0])).toBeNull();
 expect(()=>acceptPlanUpdate(next,next.plans[0].id)).toThrow(/不能事后移动/);
 });
 it('preserves old TP/SL and binds an accepted structural revision to new evidence and effective time',()=>{
 const s=saved(),old=structuredClone(s.plans[0].versions[0]),proposalState=targetRevisionState(s);
 expect(planUpdateProposal(proposalState,proposalState.plans[0])).not.toBeNull();
 const held=recordActualPosition(proposalState,proposalState.plans[0].id,{entry:100,quantity:1,filledAt:AS_OF},(AS_OF+300)*1000);expect(planUpdateProposal(held,held.plans[0])).toBeNull();expect(()=>acceptPlanUpdate(held,held.plans[0].id)).toThrow(/不能事后移动/);
 const immutableBefore=structuredClone(proposalState);const next=acceptPlanUpdate(proposalState,proposalState.plans[0].id);
 expect(proposalState).toEqual(immutableBefore);expect(next.plans[0].targetReview).toEqual([]);
 expect(next.plans[0].versions).toHaveLength(2);expect(next.plans[0].versions[0]).toEqual(old);expect(next.plans[0].versions[1].targets[0].structureId).toBe('new-target');expect(next.plans[0].versions[1].effectiveAt).toBe(AS_OF+300);
 });
 it('does not reinterpret a newly ranked primary as a revision of a saved plan',()=>{
 const proposal=targetRevisionState(),before=structuredClone(proposal.plans),oldPrimary=currentFacts(proposal).find(f=>f.id==='five-break')!;
 const unrelated={...oldPrimary,id:'another-five-break',rawId:'another-five-break',familyId:oldPrimary.familyId};
 const facts=currentFacts(proposal).filter(f=>f.id!==oldPrimary.id).concat(unrelated);
 proposal.facts={...proposal.facts,'five-break':{...proposal.facts['five-break'],current:false},[unrelated.id]:{current:true,versions:[{stateVersion:proposal.version,knownAt:proposal.asOf,reason:'独立新BOS',fact:unrelated}]}};
 proposal.scenarios=evaluateStrategies(proposal.bundle,facts);
 expect(proposal.scenarios.find(c=>c.strategyId==='bos-retest'&&c.direction==='bullish')?.setup).toBeTruthy();
 expect(planUpdateProposal(proposal,proposal.plans[0])).toBeNull();expect(()=>acceptPlanUpdate(proposal,proposal.plans[0].id)).toThrow(/不能事后移动/);
 expect(proposal.plans).toEqual(before);
 });
 it('matches legacy plan revisions by exact originating 5m evidence without inventing metadata',()=>{
 const proposal=targetRevisionState(),plan=proposal.plans[0];delete plan.versions[0].candidate.primaryFactId;
 const before=structuredClone(plan),candidate=planUpdateProposal(proposal,plan);expect(candidate?.primaryFactId).toBe('five-break');
 expect(plan).toEqual(before);expect(plan.versions[0].candidate.primaryFactId).toBeUndefined();
 const revised=acceptPlanUpdate(proposal,plan.id);expect(revised.plans[0].versions[0]).toEqual(before.versions[0]);expect(revised.plans[0].versions[1].candidate.primaryFactId).toBe('five-break');
 });
 it('does not infer a legacy opportunity from shared protection, background or event groups',()=>{
 const proposal=targetRevisionState(),candidate=proposal.plans[0].versions[0].candidate;delete candidate.primaryFactId;
 candidate.sourceByFrame['5m']=candidate.sourceByFrame['5m'].filter(id=>id!=='five-break');
 candidate.checks=candidate.checks.map(c=>({...c,evidenceIds:c.evidenceIds.filter(id=>id!=='five-break')}));
 expect(planUpdateProposal(proposal,proposal.plans[0])).toBeNull();
 });
 it('clears previous-version target observations only after accepting a same-origin revision',()=>{
 const proposal=targetRevisionState(),plan=proposal.plans[0];plan.targetReview=plan.versions[0].targets.map(t=>({...t,status:'needs-review',reason:'旧版本目标待复核'}));
 const before=structuredClone(plan),next=acceptPlanUpdate(proposal,plan.id);
 expect(next.plans[0].targetReview).toEqual([]);expect(targetObservations(next,next.plans[0])[0].structureId).toBe('new-target');expect(proposal.plans[0]).toEqual(before);expect(next.plans[0].versions[0]).toEqual(before.versions[0]);
 });
 it('keeps the captured catalog and marks same-snapshot asynchronous context changes stale',()=>{
 const original=seeded(),context=modelContext(original),value=localWorkbenchInterpretation(context);
 expect(context.catalogVersion).toBe(original.catalogVersion);
 for(const changed of [{...original,version:original.version+1},{...original,catalogVersion:'catalog-future'},{...original,planPolicy:{...original.planPolicy!,minTargetPct:1.2}}]){
  const before=structuredClone(changed),reviewed=acceptInterpretation(changed,context,value,'fixture','ai');
  expect(reviewed.needsReview.join()).toContain('审阅期间行情已更新');expect(reviewed.interpretation.at(-1)?.staleReason).toContain('原上下文');expect(reviewed.interpretation.at(-1)?.catalogVersion).toBe(context.catalogVersion);expect(reviewed.interpretation.at(-1)?.basedOnVersion).toBe(context.previous.version);expect(changed).toEqual(before);
 }
 const fresh=acceptInterpretation(original,context,value,'fixture','ai');expect(fresh.interpretation.at(-1)?.staleReason).toBeNull();
 const legacyContext={...context};delete legacyContext.catalogVersion;
 const legacy=acceptInterpretation(original,legacyContext,value,'fixture','ai');expect(legacy.interpretation.at(-1)?.catalogVersion).toBeUndefined();expect(legacy.needsReview.join()).toContain('审阅期间行情已更新');
 });
 it('requires explicit, valid user fill information and keeps it distinct in export/model context',()=>{
 const s=saved();expect(()=>recordActualPosition(s,s.plans[0].id,{entry:100,quantity:0,filledAt:AS_OF})).toThrow();
 const held=recordActualPosition(s,s.plans[0].id,{entry:100.2,quantity:2,filledAt:AS_OF},AS_OF*1000+1000);
 expect(held.positions[0]).toMatchObject({source:'user-confirmed',entry:100.2,quantity:2,status:'open'});expect(s.positions).toEqual([]);
 expect(modelContext(held).previous.positions).toHaveLength(1);expect(modelContext(held).previous.plans).toHaveLength(1);
 const exported=exportResearchState(held);expect(exported.state.snapshots).toEqual(held.snapshots);expect(exported.state.evaluations).not.toEqual([]);expect(exported.state.plans[0].versions).toHaveLength(1);
 });
 it('recovers a legacy capacity latch and keeps updating with plans and real warnings intact',()=>{
 const s=saved();s.capacityReached=true;s.needsReview=['5m原始OHLCV被修订或插入，旧解释和计划需重新评估','达到本地会话容量上限，请导出后开始新会话；没有静默删除历史。'];s.history=Array.from({length:300},()=>s.history[0]);
 const before=structuredClone(s),next=updateMarketState(s,future([{low:99,high:101,close:100}]));
 expect(next.capacityReached).toBe(false);expect(next.asOf).toBeGreaterThan(s.asOf);expect(next.version).toBe(s.version+1);
 expect(next.plans[0].versions).toEqual(s.plans[0].versions);expect(next.needsReview.join()).not.toContain('容量上限');expect(s).toEqual(before);
 });
});
