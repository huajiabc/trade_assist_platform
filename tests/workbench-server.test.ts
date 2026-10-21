import {describe,it,expect,vi} from 'vitest';
import request from 'supertest';
import {createApp} from '../server/app';
import {readServerConfig} from '../server/config';
import {AS_OF,frame,researchBundle} from './research-fixtures';
import {RESEARCH_FRAMES,type ResearchFrame} from '../shared/researchData';
import {modelContext,updateMarketState} from '../shared/marketState';
import {localWorkbenchInterpretation} from '../shared/workbenchAnalysis';
import {OpenAICompatibleProvider,type ModelInput} from '../server/provider';
import type {MarketDataProvider} from '../server/market';
import {analyzeWithValidation} from '../server/analysisService';
const config=readServerConfig({AI_PROVIDER:'api',AI_API_KEY:'fixture-key',AI_MODEL:'fixture-model',AI_TIMEOUT_MS:'1000'});
const codex={status:async()=>({available:false,authenticated:false,message:'mock'}),analyzeDetailed:vi.fn()};
const payload=()=>{const state=updateMarketState(null,researchBundle()),context=modelContext(state);return {bundle:{symbol:state.symbol,asOf:state.asOf,frames:RESEARCH_FRAMES.map(tf=>{const {id:_,integrity:__,...input}=state.bundle.frames[tf];return input;})},previous:context.previous,provider:'api',notes:'测试'};};
const market=(missing?:ResearchFrame):MarketDataProvider=>({getCandles:vi.fn<MarketDataProvider['getCandles']>(async query=>{if(query.interval===missing)throw new Error('upstream private error');const f=frame(query.interval as ResearchFrame);return {provider:'binance',market:'usdt-perpetual',symbol:query.symbol,interval:query.interval,candles:f.candles,lastCandleClosed:true,serverTime:AS_OF*1000,fetchedAt:new Date(AS_OF*1000).toISOString(),warnings:[]};})});
describe('multi-timeframe HTTP and adapter boundaries (no paid model calls)',()=>{
 it('loads all three real intervals through the shared cache and degrades only failed frames',async()=>{
  const m=market('5m'),app=createApp({config,codexProvider:codex,marketProvider:m});
  const a=await request(app).get('/api/research/market?symbol=SNDKUSDT&limit=300').expect(200);
  expect(a.body.frames['15m'].candles).toHaveLength(40);expect(a.body.frames['5m'].candles).toEqual([]);expect(a.body.frames['5m'].integrity.usable).toBe(false);expect(a.text).not.toContain('upstream private');
  await request(app).get('/api/research/market?symbol=SNDKUSDT&limit=300').expect(200);
  const calls=vi.mocked(m.getCandles).mock.calls;expect(calls.filter(([q])=>q.interval==='15m')).toHaveLength(1);expect(calls.filter(([q])=>q.interval==='1m')).toHaveLength(1);
 });
 it('rejects malformed contracts before any AI invocation',async()=>{
  const analyze=vi.fn(),app=createApp({config,provider:{analyze},codexProvider:codex});
  const p=payload();p.bundle.frames[0].lastClosedTime=5;
  await request(app).post('/api/research/analyze').send(p).expect(400);expect(analyze).not.toHaveBeenCalled();
  await request(app).post('/api/research/analyze').send({...payload(),bundle:{...payload().bundle,frames:[...payload().bundle.frames,...payload().bundle.frames]}}).expect(400);
 });
 it('returns a strictly validated interpretation with prior state and all frames in one call',async()=>{
  const analyze=vi.fn(async(input:ModelInput)=>localWorkbenchInterpretation(input.workbench!));const app=createApp({config,provider:{analyze},codexProvider:codex});
  const result=await request(app).post('/api/research/analyze').send(payload()).expect(200);
  expect(result.body).toMatchObject({schemaVersion:'research-response-1.0',source:'ai',provider:'api',analysisAttempts:1});expect(result.body.analysis.frames).toHaveLength(3);expect(analyze).toHaveBeenCalledOnce();expect(analyze.mock.calls[0][0].workbench!.bundle.frames['15m'].candles).toHaveLength(40);expect(analyze.mock.calls[0][0].workbench!.previous.version).toBe(1);
 });
 it('does not call a model for a local review and accepts a missing background with explicit downgrade',async()=>{
  const analyze=vi.fn(),p=payload();p.provider='mock';p.bundle.frames=p.bundle.frames.filter(f=>f.timeframe==='1m');
  const result=await request(createApp({config,provider:{analyze},codexProvider:codex})).post('/api/research/analyze').send(p).expect(200);
  expect(result.body.analysis.frames.find((f:{timeframe:string})=>f.timeframe==='15m').regime).toBe('unavailable');expect(result.body.analysisAttempts).toBe(0);expect(analyze).not.toHaveBeenCalled();
 });
 it('retries one invalid interpretation against the same snapshot and rejects a second invalid one',async()=>{
  const analyze=vi.fn(async(input:ModelInput)=>({...localWorkbenchInterpretation(input.workbench!),madeUpFacts:[1]}));
  const result=await request(createApp({config,provider:{analyze},codexProvider:codex})).post('/api/research/analyze').send(payload()).expect(502);
  expect(result.body.error.code).toBe('PROVIDER_INVALID_OUTPUT');expect(analyze).toHaveBeenCalledTimes(2);expect(analyze.mock.calls[1][0].workbench).toEqual(analyze.mock.calls[0][0].workbench);expect(analyze.mock.calls[1][0].validationFeedback).toBeDefined();
 });
 it('never falls back from the selected Codex to API or local results',async()=>{
  const analyze=vi.fn(),p=payload();p.provider='codex';const stub={status:codex.status,analyzeDetailed:vi.fn(async()=>{throw new Error('private runtime failure');})};
  const r=await request(createApp({config,provider:{analyze},codexProvider:stub})).post('/api/research/analyze').send(p).expect(502);
  expect(analyze).not.toHaveBeenCalled();expect(r.text).not.toContain('private runtime failure');
 });
 it('shares the Codex busy lock with the existing single-timeframe endpoint',async()=>{
  let release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>started=r),held=new Promise<void>(r=>release=r);
  const stub={status:codex.status,analyzeDetailed:vi.fn(async(input:ModelInput)=>{started();await held;return {analysis:localWorkbenchInterpretation(input.workbench!),model:'fixture'};})};
  const app=createApp({config,codexProvider:stub}),p=payload();p.provider='codex';const first=request(app).post('/api/research/analyze').send(p).then(r=>r);await ready;
  const other=await request(app).post('/api/analyze').send({candles:frame('1m').candles,context:{symbol:'SNDKUSDT',timeframe:'1m',notes:''},mode:'ai',provider:'codex'}).expect(409);
  expect(other.body.error.code).toBe('CODEX_BUSY');release();expect((await first).status).toBe(200);expect(stub.analyzeDetailed).toHaveBeenCalledOnce();
 });
 it('selects the workbench JSON schema and instructions for an API request',async()=>{
  const context=modelContext(updateMarketState(null,researchBundle()));
  const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(localWorkbenchInterpretation(context))}}]})));
  await new OpenAICompatibleProvider(config,fetcher).analyze({candles:context.bundle.frames['1m'].candles,context:{symbol:'SNDKUSDT',timeframe:'1m',notes:''},workbench:context});
  const sent=JSON.parse(fetcher.mock.calls[0][1]!.body as string);expect(sent.response_format.json_schema.schema.properties).toHaveProperty('strategyReviews');expect(sent.messages[0].content).toContain('15m负责背景');expect(JSON.parse(sent.messages[1].content).bundle.frames['5m'].candles).toHaveLength(40);
 });
 it('shares a single deadline with a custom validation contract and handles model timeouts without partial success',async()=>{
  const context=modelContext(updateMarketState(null,researchBundle()));
  const run=vi.fn(async(input:ModelInput)=>await new Promise<never>((_,reject)=>input.signal!.addEventListener('abort',()=>reject(new Error('stalled')))));
  await expect(analyzeWithValidation({candles:context.bundle.frames['1m'].candles,context:{symbol:'SNDKUSDT',timeframe:'1m',notes:''},workbench:context},run,{provider:'api',timeoutMs:20,validate:raw=>raw})).rejects.toMatchObject({code:'PROVIDER_TIMEOUT'});expect(run).toHaveBeenCalledOnce();
 });
});
