import {describe,it,expect} from 'vitest';
import {localWorkbenchInterpretation,validateWorkbenchInterpretation,workbenchPayload,workbenchJsonSchema,workbenchReferences} from '../shared/workbenchAnalysis';
import {currentFacts,modelContext,updateMarketState} from '../shared/marketState';
import {evaluateStrategies} from '../shared/strategyCatalog';
import {researchBundle,strategyFacts} from './research-fixtures';
function context(){const state=updateMarketState(null,researchBundle()),facts=strategyFacts();state.facts=Object.fromEntries(facts.map(f=>[f.id,{current:true,versions:[{stateVersion:1,knownAt:state.asOf,reason:'测试',fact:f}]}]));state.scenarios=evaluateStrategies(state.bundle,facts);return modelContext(state);}
describe('bounded state-aware AI interpretation contract',()=>{
 it('keeps per-frame OHLCV, roles, prior state, catalog and evidence distinct',()=>{
 const c=context(),payload=workbenchPayload(c);expect(payload.bundle).toEqual(c.bundle);expect(payload.previous).toEqual(c.previous);expect(payload.catalog).toHaveLength(6);
 expect(payload).not.toHaveProperty('tradeSetups');expect(payload.facts.every(f=>f.source==='deterministic')).toBe(true);expect(workbenchJsonSchema).toHaveProperty('properties.strategyReviews');
 });
 it('keeps selected plan references beyond the ordinary 48-per-frame context budget',()=>{
 const c=context(),template=c.candidates.find(candidate=>candidate.setup&&candidate.stage==='conditional')!,base=c.facts.find(f=>f.id==='five-protect')!;
 const ordinary=Array.from({length:80},(_,i)=>({...base,id:'ordinary-five-'+i,rawId:'ordinary-five-'+i}));c.facts.push(...ordinary);
 expect(workbenchReferences(c).filter(f=>f.timeframe==='5m')).toHaveLength(48);
 // Stress the aggregate selected-plan reference budget while keeping each setup bounded.
 const mandatory=Array.from({length:60},(_,i)=>({...base,id:'selected-five-'+i,rawId:'selected-five-'+i}));c.facts.push(...mandatory);
 c.candidates=c.candidates.map((candidate,i)=>({...template,id:candidate.id,strategyId:candidate.strategyId,direction:candidate.direction,setup:{...template.setup!,id:candidate.id+'-plan',structureIds:[...template.setup!.structureIds,...mandatory.slice(i*5,i*5+5).map(f=>f.id)]}}));
 const before=structuredClone(c),references=workbenchReferences(c),required=new Set(c.candidates.flatMap(candidate=>candidate.setup!.structureIds)),fiveRequired=c.facts.filter(f=>f.timeframe==='5m'&&required.has(f.id));
 expect(fiveRequired.length).toBeGreaterThan(48);expect(references.filter(f=>f.timeframe==='5m')).toHaveLength(fiveRequired.length);
 expect(fiveRequired.every(f=>references.some(reference=>reference.id===f.id))).toBe(true);expect(references.some(f=>f.id.startsWith('ordinary-five-'))).toBe(false);
 expect(c).toEqual(before);expect(references.find(f=>f.id==='selected-five-59')).toEqual(mandatory[59]);
 });
 it('caps only model-facing alternative details and preserves the full local candidate selection',()=>{
 const c=context(),candidate=c.candidates.find(candidate=>candidate.setup)!,alternatives=Array.from({length:7},(_,i)=>({primaryFactId:'comparison-'+i,localFactId:null,stage:'watching' as const,score:i,reason:'受控候选比较',entry:null,stopLoss:null,target:null}));
 candidate.selection={considered:7,eligible:0,selectedPrimaryId:candidate.primaryFactId??null,reason:'本地保留全部比较记录',alternatives};
 const before=structuredClone(c),payload=workbenchPayload(c),sent=payload.candidates.find(row=>row.id===candidate.id)!;
 expect(sent.selection?.alternatives).toEqual(alternatives.slice(0,3));expect(sent.selection).toHaveProperty('omittedAlternatives',4);expect(payload.catalogVersion).toBe(c.catalogVersion);
 expect(candidate.selection.alternatives).toHaveLength(7);expect(candidate.selection).not.toHaveProperty('omittedAlternatives');expect(c).toEqual(before);
 });
 it('accepts an evidence-backed retain and rejects unknown IDs, duplicate reviews and cross-frame substitution',()=>{
 const c=context(),a=localWorkbenchInterpretation(c),candidate=c.candidates.find(c=>c.stage==='conditional')!;
 a.strategyReviews.find(r=>r.candidateId===candidate.id)!.decision='retain';a.frames[0]={timeframe:'15m',regime:'uptrend',summary:'有结构背景',evidenceIds:['background']};expect(validateWorkbenchInterpretation(a,c)).toEqual(a);
 const wrong=structuredClone(a);wrong.frames[0].evidenceIds=['local-trigger'];expect(()=>validateWorkbenchInterpretation(wrong,c)).toThrow(/冒充/);
 wrong.frames[0].evidenceIds=['invented'];expect(()=>validateWorkbenchInterpretation(wrong,c)).toThrow(/未知/);
 const duplicate=structuredClone(a);duplicate.strategyReviews.push(duplicate.strategyReviews[0]);expect(()=>validateWorkbenchInterpretation(duplicate,c)).toThrow();
 });
 it('does not allow AI to invent a strategy, price or facts, or retain a failed candidate',()=>{
 const c=context(),a=localWorkbenchInterpretation(c);a.strategyReviews[0].candidateId='imaginary-strategy';expect(()=>validateWorkbenchInterpretation(a,c)).toThrow(/创造/);
 const failed=localWorkbenchInterpretation(c);failed.strategyReviews.find(r=>c.candidates.find(c=>c.id===r.candidateId)!.stage==='watching')!.decision='retain';expect(()=>validateWorkbenchInterpretation(failed,c)).toThrow(/门槛/);
 expect(()=>validateWorkbenchInterpretation({...localWorkbenchInterpretation(c),facts:[{price:2}]},c)).toThrow();
 });
 it('requires a real user position and structural references for target or protection management',()=>{
  const c=context(),a=localWorkbenchInterpretation(c);a.positionReviews=[{positionId:'position-1',decision:'partial-take-profit-review',reason:'目标结构需要人工复核',evidenceIds:['target'],targetStructureIds:['target'],stopStructureId:null}];
  expect(()=>validateWorkbenchInterpretation(a,c)).toThrow(/明确登记/);
  c.previous.positions=[{id:'position-1',planId:'plan',direction:'bullish',entry:100,quantity:1,filledAt:c.bundle.asOf,source:'user-confirmed',review:[]}];
  expect(validateWorkbenchInterpretation(a,c).positionReviews).toHaveLength(1);
  a.positionReviews[0].targetStructureIds=['five-protect'];a.positionReviews[0].evidenceIds=['five-protect'];expect(()=>validateWorkbenchInterpretation(a,c)).toThrow(/方向一致/);
  a.positionReviews[0]={positionId:'position-1',decision:'protective-stop-review',reason:'复核保护',evidenceIds:['five-protect'],targetStructureIds:[],stopStructureId:'five-protect'};expect(validateWorkbenchInterpretation(a,c)).toEqual(a);
  a.positionReviews[0].stopStructureId='background';a.positionReviews[0].evidenceIds=['background'];expect(()=>validateWorkbenchInterpretation(a,c)).toThrow(/5m/);
 });
 it('requires explicit degraded interpretation for missing frames and preserves an empty result',()=>{
 const c=context();c.bundle.frames['15m'].integrity.usable=false;const a=localWorkbenchInterpretation(c);expect(a.frames[0].regime).toBe('unavailable');expect(validateWorkbenchInterpretation(a,c)).toEqual(a);
 a.frames[0].regime='range';expect(()=>validateWorkbenchInterpretation(a,c)).toThrow(/降级/);
 });
});
