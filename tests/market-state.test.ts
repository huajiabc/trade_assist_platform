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
 const original=saved(),before=structuredClone(original),rows=[{low:99.8,high:100.5,close:100},{low:100.1,high:100.7,close:100.4},{low:100.4,high:113,close:111}];
 const next=updateMarketState(original,future(rows));const p=next.plans[0];
 expect(p.tracking!.triggeredAt).toBe(AS_OF+60);expect(p.tracking!.targetTimes[0]).toBe(AS_OF+120);expect(p.status).toBe('targets-touched');expect(next.positions).toEqual([]);
 expect(targetObservations(next,p)[0].status).toBe('reference-touched');expect(p.versions[0].targets[0].status).toBe('active');expect(original).toEqual(before);
 expect(next.events.some(e=>e.kind==='reference-target')).toBe(true);
 });
 it('cancels target space consumed before entry and never later revives a cancelled candidate',()=>{
 const s=saved(),first=updateMarketState(s,future([{low:99.9,high:113,close:100.2}]));expect(first.plans[0].status).toBe('invalidated');
 const second=updateMarketState(first,future([{low:99.9,high:113,close:100.2},{low:100,high:101,close:100.8}]));
 expect(second.plans[0].status).toBe('invalidated');expect(second.plans[0].tracking!.triggeredAt).toBeNull();expect(second.positions).toEqual([]);
 });
 it('keeps same-bar stop/target ordering ambiguous rather than fabricating a profitable trade',()=>{
 const s=saved(),next=updateMarketState(s,future([{low:99.8,high:100.5,close:100},{low:100.1,high:100.7,close:100.4},{low:90,high:113,close:100}]));
 expect(next.plans[0].tracking!.phase).toBe('ambiguous');expect(next.positions).toHaveLength(0);
 });
 it('retracts a derived target observation after OHLC revision and marks the plan for review',()=>{
  const rows=[{low:99.8,high:100.5,close:100},{low:100.1,high:100.7,close:100.4},{low:100.4,high:113,close:111}],before=updateMarketState(saved(),future(rows));
  const revised=structuredClone(rows);revised[2]={low:100.4,high:110,close:109};const next=updateMarketState(before,future(revised));
  expect(next.plans[0].tracking!.targetTimes[0]).toBeNull();expect(next.plans[0].status).toBe('needs-review');expect(next.events.some(e=>e.kind==='reference-event-retracted')).toBe(true);expect(next.events.some(e=>e.kind==='reference-target')).toBe(true);
  expect(next.plans[0].versions[0].setup.targets).toEqual(before.plans[0].versions[0].setup.targets);
 });
 it('does not modify target prices for an ordinary reverse candle or an unconfirmed proposal',()=>{
 const s=saved(),price=s.plans[0].versions[0].setup.targets[0].price,next=updateMarketState(s,future([{low:99.5,high:100.4,close:99.8}]));
 expect(next.plans[0].versions).toHaveLength(1);expect(next.plans[0].versions[0].setup.targets[0].price).toBe(price);expect(planUpdateProposal(next,next.plans[0])).toBeNull();
 expect(()=>acceptPlanUpdate(next,next.plans[0].id)).toThrow(/不能事后移动/);
 });
 it('preserves old TP/SL and binds an accepted structural revision to new evidence and effective time',()=>{
 const s=saved(),facts=strategyFacts(),old=structuredClone(s.plans[0].versions[0]);
 const target={...facts[2],id:'new-target',low:116,high:116,knownAt:AS_OF+300,formedAt:AS_OF+300,confirmedAt:AS_OF+300};
 const f=frame('1m');f.observedAt=AS_OF+300;for(let i=0;i<5;i++)f.candles.push({timestamp:AS_OF+i*60,open:100,close:100,high:101,low:99,volume:1});f.lastClosedTime=f.candles.at(-1)!.timestamp;
 const five=frame('5m');five.observedAt=AS_OF+300;five.candles.push({...five.candles.at(-1)!,timestamp:AS_OF});five.lastClosedTime=AS_OF;
 const b=makeResearchBundle(s.symbol,[frame('15m'),five,f],AS_OF+300),newFacts=[...facts.filter(f=>f.id!=='target'),target];newFacts.find(f=>f.id==='local-trigger')!.knownAt=AS_OF+240;
 const proposalState={...s,asOf:b.asOf,bundle:b,version:s.version+1,snapshots:{...s.snapshots,...Object.fromEntries(RESEARCH_FRAMES.map(tf=>[b.frames[tf].id,b.frames[tf]]))},facts:Object.fromEntries(newFacts.map(f=>[f.id,{current:true,versions:[{stateVersion:3,knownAt:b.asOf,reason:'新增结构',fact:f}]}])),scenarios:evaluateStrategies(b,newFacts)};
 expect(planUpdateProposal(proposalState,proposalState.plans[0])).not.toBeNull();const next=acceptPlanUpdate(proposalState,proposalState.plans[0].id);
 expect(next.plans[0].versions).toHaveLength(2);expect(next.plans[0].versions[0]).toEqual(old);expect(next.plans[0].versions[1].targets[0].structureId).toBe('new-target');expect(next.plans[0].versions[1].effectiveAt).toBe(AS_OF+300);
 });
 it('requires explicit, valid user fill information and keeps it distinct in export/model context',()=>{
 const s=saved();expect(()=>recordActualPosition(s,s.plans[0].id,{entry:100,quantity:0,filledAt:AS_OF})).toThrow();
 const held=recordActualPosition(s,s.plans[0].id,{entry:100.2,quantity:2,filledAt:AS_OF},AS_OF*1000+1000);
 expect(held.positions[0]).toMatchObject({source:'user-confirmed',entry:100.2,quantity:2,status:'open'});expect(s.positions).toEqual([]);
 expect(modelContext(held).previous.positions).toHaveLength(1);expect(modelContext(held).previous.plans).toHaveLength(1);
 const exported=exportResearchState(held);expect(exported.state.snapshots).toEqual(held.snapshots);expect(exported.state.evaluations).not.toEqual([]);expect(exported.state.plans[0].versions).toHaveLength(1);
 });
 it('pauses at capacity rather than silently deleting historical snapshots or events',()=>{
 const s=seeded();s.history=Array.from({length:300},()=>s.history[0]);const next=updateMarketState(s,future([{low:99,high:101,close:100}]));
 expect(next.capacityReached).toBe(true);expect(next.snapshots).toBe(s.snapshots);expect(next.needsReview.join()).toContain('没有静默删除历史');
 });
});
