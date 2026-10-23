import request from 'supertest';
import {vi} from 'vitest';
import {createApp} from '../server/app';
import {readServerConfig} from '../server/config';
import type {ModelInput} from '../server/provider';
import {describe,it,expect} from 'vitest';
import {evaluateStrategies,validateStrategyPlan} from '../shared/strategyCatalog';
import {STRUCTURAL_PLAN_POLICY,MICRO_PLAN_POLICY,auditPlanScale,planningVolatilityBars} from '../shared/planPolicy';
import {updateMarketState,modelContext,saveCandidatePlan} from '../shared/marketState';
import {validateFreshAnalysis} from '../server/analysisPolicy';
import {createMockAnalysis} from '../shared/mock';
import {SAMPLE_CANDLES} from '../shared/sample';
import {AS_OF,researchBundle,strategyFacts} from './research-fixtures';
import type {ResearchFact} from '../shared/researchData';
const added=(type:string,overrides:Partial<ResearchFact>={}):ResearchFact=>({...strategyFacts()[3],id:type,type,formedAt:AS_OF-900,knownAt:AS_OF-900,confirmedAt:AS_OF-900,...overrides});
const find=(id:string,facts:ResearchFact[],b=researchBundle())=>evaluateStrategies(b,facts).find(c=>c.strategyId===id&&c.direction==='bullish')!;
describe('A–F strategy types and wider structural preferences',()=>{
 it('qualifies D only at a confirmed range edge after reclaim and reversal',()=>{
  const range=added('trading-range',{timeframe:'15m',direction:'neutral',low:96,high:118,knownAt:AS_OF-1800,confirmedAt:AS_OF-1800}),sweep=added('sweep',{low:95,high:101,reclaimTime:AS_OF-900}),reverse=added('CHoCH',{id:'reverse',knownAt:AS_OF-600,confirmedAt:AS_OF-600});const facts=[...strategyFacts(),range,sweep,reverse];
  expect(find('range-reversal',facts).stage).toBe('conditional');expect(find('range-reversal',facts).setup?.strategyId).toBe('range-reversal');
  expect(find('range-reversal',[...strategyFacts(),range,{...sweep,low:105,high:107},reverse]).setup).toBeNull();
  expect(find('range-reversal',[...strategyFacts(),range,{...sweep,reclaimTime:null},reverse]).setup).toBeNull();
  expect(find('range-reversal',[...strategyFacts(),sweep,reverse]).setup).toBeNull();
 });
 it('requires E failure plus a separately known reverse CHoCH',()=>{
  const f=added('failed-breakout',{failureTime:AS_OF-900,confirmedAt:AS_OF-600,knownAt:AS_OF-600});expect(find('failed-breakout',[...strategyFacts(),f]).stage).toBe('conditional');
  expect(find('failed-breakout',[...strategyFacts(),{...f,confirmedAt:null,status:'candidate'}]).setup).toBeNull();
  expect(find('failed-breakout',[...strategyFacts(),{...f,failureTime:undefined}]).setup).toBeNull();
 });
 it('requires F trend agreement and only the first displacement reaction',()=>{
  const f=added('displacement',{reactionTime:AS_OF-600,tests:1,volumeRatio:1.5,displacementAtr:2});expect(find('displacement-continuation',[...strategyFacts(),f]).stage).toBe('conditional');
  expect(find('displacement-continuation',[...strategyFacts(),{...f,tests:2}]).setup).toBeNull();expect(find('displacement-continuation',[...strategyFacts(),{...f,reactionTime:null}]).setup).toBeNull();
  const facts=strategyFacts();facts[0].direction='bearish';expect(find('displacement-continuation',[...facts,f]).setup).toBeNull();
 });
 it('prefers a major protection over a newer small pivot and records the strategy',()=>{
  const local=added('HL',{id:'small-local-protect',importance:'local',low:97.5,high:97.5,knownAt:AS_OF-30});const c=find('bos-retest',[...strategyFacts(),local]);expect(c.setup?.basis?.stopStructureId).toBe('five-protect');expect(c.setup?.strategyId).toBe('bos-retest');
  const short=evaluateStrategies(researchBundle(),[...strategyFacts(),local],MICRO_PLAN_POLICY).find(c=>c.strategyId==='bos-retest'&&c.direction==='bullish')!;expect(short.setup?.basis?.stopStructureId).toBe(local.id);
 });
 it('rejects a narrow nearer obstacle instead of skipping it to keep a distant target',()=>{const c=find('bos-retest',[...strategyFacts(),added('HH',{id:'nearby',low:101,high:101})]);expect(c.setup).toBeNull();expect(c.proposalReason).toMatch(/目标幅度|1R/);});
 it('filters three-point SNDK-like geometry and accepts a wider geometry without moving either',()=>{
  const rows=Array.from({length:100},(_,i)=>({timestamp:AS_OF-6000+i*60,open:1330,high:1331,low:1329,close:1330,volume:10}));const narrow={anchorTime:rows.at(-1)!.timestamp,entry:1330,stopLoss:1327,targets:[{price:1333,label:'contract'}],direction:'bullish' as const},saved=structuredClone(narrow);
  const a=auditPlanScale(narrow,rows,STRUCTURAL_PLAN_POLICY);expect(a.errors.join()).toContain('保护幅度不足');expect(a.errors.join()).toContain('首目标幅度不足');expect(narrow).toEqual(saved);
  expect(auditPlanScale({...narrow,stopLoss:1320,targets:[{price:1350,label:'contract'}]},rows,STRUCTURAL_PLAN_POLICY).errors).toEqual([]);
  expect(auditPlanScale(narrow,rows,MICRO_PLAN_POLICY).errors).toEqual([]);
 });
 it('aggregates actual 1m into complete 5m only and rejects insufficient context',()=>{
  const rows=Array.from({length:76},(_,i)=>({timestamp:AS_OF-4500+i*60,open:100,high:101,low:99,close:100,volume:1}));const result=planningVolatilityBars(rows);expect(result.candles).toHaveLength(15);expect(result.candles[0]).toMatchObject({open:100,high:101,low:99,close:100,volume:5});
  expect(planningVolatilityBars(rows.filter((_,i)=>i!==10)).candles).toHaveLength(14);
  expect(auditPlanScale({anchorTime:rows[30].timestamp,entry:100,stopLoss:90,targets:[{price:120,label:'contract'}],direction:'bullish'},rows.slice(0,31),STRUCTURAL_PLAN_POLICY).errors.join()).toContain('14根');
 });
 it('rejects strategy mismatch and fresh unclassified model plans while retaining legacy parsing',()=>{
  const b=researchBundle(),facts=strategyFacts(),c=find('bos-retest',facts,b);expect(()=>validateStrategyPlan({...c.setup!,strategyId:'failed-breakout'},c,b,facts)).toThrow('归类');
  const candles=SAMPLE_CANDLES.slice(-80),analysis=createMockAnalysis(candles);expect(analysis.tradeSetups.length).toBeGreaterThan(0);expect(()=>validateFreshAnalysis(analysis,{candles,context:{symbol:'test',timeframe:'1h',notes:''},planPolicy:STRUCTURAL_PLAN_POLICY})).toThrow('归类');expect(()=>validateFreshAnalysis(analysis,{candles,context:{symbol:'test',timeframe:'1h',notes:''}})).not.toThrow();
 });
 it('enforces explicit scope at HTTP/model boundaries and permits a repaired wait result',async()=>{
  const candles=SAMPLE_CANDLES.slice(-80),base=createMockAnalysis(candles),analyze=vi.fn(async(input:ModelInput)=>{
   expect(input.planPolicy).toEqual(STRUCTURAL_PLAN_POLICY);
   if(!input.validationFeedback)return base;
   expect(input.validationFeedback.error).toContain('归类');return {...base,opportunities:[],tradeSetups:[],tradePlanning:{status:'no-setup',reason:'缺少合格结构及幅度，等待'}};
  });
  const app=createApp({config:readServerConfig({AI_PROVIDER:'api',AI_API_KEY:'fixture',AI_MODEL:'fixture',AI_TIMEOUT_MS:'1000'}),provider:{analyze},codexProvider:{status:async()=>({available:false,authenticated:false,message:'test'}),analyzeDetailed:vi.fn()}});
  const response=await request(app).post('/api/analyze').send({candles,context:{symbol:'TEST',timeframe:'1h',notes:''},mode:'ai',provider:'api',planPolicy:STRUCTURAL_PLAN_POLICY}).expect(200);expect(response.body.analysis.tradeSetups).toEqual([]);expect(response.body.planPolicy).toEqual(STRUCTURAL_PLAN_POLICY);expect(analyze).toHaveBeenCalledTimes(2);
  await request(app).post('/api/analyze').send({candles,context:{symbol:'TEST',timeframe:'1h',notes:''},mode:'ai',provider:'api',planPolicy:{...STRUCTURAL_PLAN_POLICY,minTargetPct:-1}}).expect(400);expect(analyze).toHaveBeenCalledTimes(2);
 });
 it('versions policy changes, keeps original plans and marks previous AI interpretation for review',()=>{
  let state=updateMarketState(null,researchBundle());state.facts=Object.fromEntries(strategyFacts().map(f=>[f.id,{current:true,versions:[{stateVersion:1,knownAt:f.knownAt,reason:'contract',fact:f}]}]));state.scenarios=evaluateStrategies(state.bundle,strategyFacts());state=saveCandidatePlan(state,state.scenarios.find(c=>c.setup)!.id);const original=structuredClone(state.plans);
  const next=updateMarketState(state,state.bundle,'scope changed',Date.now(),{...STRUCTURAL_PLAN_POLICY,minTargetPct:15});expect(next.version).toBeGreaterThan(state.version);expect(next.events.some(e=>e.kind==='plan-policy-changed')).toBe(true);expect(next.plans.map(p=>p.versions)).toEqual(original.map(p=>p.versions));expect(modelContext(next).planPolicy?.minTargetPct).toBe(15);
 });
});
