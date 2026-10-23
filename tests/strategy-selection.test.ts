import {describe,it,expect} from 'vitest';
import {evaluateStrategies,STRATEGY_PARAMETERS,validateStrategyPlan} from '../shared/strategyCatalog';
import {STRATEGY_CATALOG_VERSION} from '../shared/strategyCatalog';
import {workbenchPayload} from '../shared/workbenchAnalysis';
import {AS_OF,researchBundle,strategyFacts} from './research-fixtures';
import type {ResearchFact} from '../shared/researchData';
const bullishB=(b=researchBundle(),facts=strategyFacts())=>evaluateStrategies(b,facts).find(c=>c.strategyId==='bos-retest'&&c.direction==='bullish')!;
describe('bounded comparison of real strategy alternatives',()=>{
 it('retains an earlier eligible primary when the latest break still lacks a later local confirmation',()=>{
  const facts=strategyFacts(),newBreak={...facts[3],id:'latest-unready-break',knownAt:AS_OF-300,confirmedAt:AS_OF-300,formedAt:AS_OF-300,originTime:AS_OF-900,low:100.9,high:100.9};
  const b=researchBundle(),all=evaluateStrategies(b,[...facts,newBreak]),candidate=all.find(c=>c.strategyId==='bos-retest'&&c.direction==='bullish')!;
  expect(all).toHaveLength(12);expect(candidate.stage).toBe('conditional');expect(candidate.primaryFactId).toBe('five-break');
  expect(candidate.selection?.considered).toBeGreaterThan(1);expect(candidate.selection?.eligible).toBeGreaterThan(0);
  expect(candidate.selection?.alternatives.some(a=>a.primaryFactId===newBreak.id&&a.stage==='watching')).toBe(true);
 });
 it('compares recent local structures and never moves a near target to rescue the newest entry',()=>{
  const b=researchBundle(),facts=strategyFacts(),last=b.frames['1m'].candles.at(-1)!;Object.assign(last,{open:100,high:112,low:99,close:111});
  const newer={...facts[5],id:'latest-high-entry',low:111,high:111,knownAt:AS_OF,confirmedAt:AS_OF,formedAt:AS_OF,originTime:last.timestamp};
  const candidate=bullishB(b,[...facts,newer]);expect(candidate.stage).toBe('conditional');expect(candidate.setup!.entry).toBe(100);expect(candidate.setup!.targets[0].price).toBe(112);
  expect(candidate.selection?.alternatives.some(a=>a.localFactId===newer.id&&a.stage==='watching')).toBe(true);
 });
 it('uses explicit finite search budgets while preserving all underlying facts',()=>{
  const b=researchBundle(),facts=strategyFacts();for(let i=0;i<20;i++)facts.push({...facts[3],id:'break-'+i,knownAt:AS_OF-900-i*300,confirmedAt:AS_OF-900-i*300});
  for(let i=1;i<10;i++)facts.push({...facts[5],id:'local-'+i,knownAt:AS_OF-60-i*60,confirmedAt:AS_OF-60-i*60});
  const before=structuredClone(facts),candidate=bullishB(b,facts);expect(candidate.selection!.considered).toBeLessThanOrEqual(STRATEGY_PARAMETERS.maximumPrimaryCandidates*STRATEGY_PARAMETERS.maximumTriggerCandidates);
  expect(candidate.selection!.alternatives.length).toBe(candidate.selection!.considered-1);expect(facts).toEqual(before);
 });
 it('has stable selection and IDs independent of fact-array ordering',()=>{
  const b=researchBundle(),facts=strategyFacts();expect(bullishB(b,[...facts].reverse())).toEqual(bullishB(b,facts));
 });
 it('binds new executable conditions to actual strategy evidence rather than trusting edited tracking JSON',()=>{
  const b=researchBundle(),facts=strategyFacts(),candidate=bullishB(b,facts);expect(candidate.triggerSpec).toBeDefined();
  const plan=structuredClone(candidate.setup!);plan.tracking!.steps[0].conditions[0].price+=.01;
  expect(()=>validateStrategyPlan(plan,candidate,b,facts)).toThrow(/触发|条件/);
 });
 it('passes selected alternatives, group semantics and catalog version to one global model context',()=>{
  const b=researchBundle(),facts=strategyFacts(),candidates=evaluateStrategies(b,facts),payload=workbenchPayload({catalogVersion:STRATEGY_CATALOG_VERSION,bundle:b,facts,candidates,previous:{version:1,interpretation:null,changes:[]}});
  expect(payload.catalogVersion).toBe(STRATEGY_CATALOG_VERSION);expect(payload.opportunityGroups.length).toBeGreaterThan(0);expect(payload.candidates.find(c=>c.setup)?.selection).toBeDefined();expect(payload.costPolicy).toContain('一次全局');
 });
});
