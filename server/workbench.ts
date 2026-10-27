import { planPolicySchema, resolvePlanPolicy } from '../shared/planPolicy';
import { visualRequestFields, validateImageAnchors } from '../shared/analysisInput';
import { chartImageBytes } from './chartImages';
import { tradeSetupSchema } from '../shared/analysis';
import { Router } from 'express';
import { z } from 'zod';
import { RESEARCH_FRAMES, exchangeFrame, frameInputSchema, makeResearchBundle, csvResearchBundle, extractFrameFacts, type ResearchFrame, type FrameInput } from '../shared/researchData';
import { evaluateStrategies, STRATEGY_CATALOG_VERSION } from '../shared/strategyCatalog';
import { workbenchOutputSchema, validateWorkbenchInterpretation, localWorkbenchInterpretation } from '../shared/workbenchAnalysis';
import type { MarketDataProvider } from './market';
import type { AnalysisProvider, ModelInput } from './provider';
import type { CodexProvider } from './codex';
import { isAIConfigured, type ServerConfig } from './config';
import { PublicError } from './errors';
import { analyzeWithValidation } from './analysisService';
const previousSchema=z.object({version:z.number().int().nonnegative(),interpretation:workbenchOutputSchema.nullable(),changes:z.array(z.string().max(500)).max(20),plans:z.array(z.object({id:z.string().max(100),status:z.string().max(80),version:z.number().int().positive(),setup:tradeSetupSchema,reviewReasons:z.array(z.string().max(500)).max(30)}).strict()).max(20).optional(),positions:z.array(z.object({id:z.string().max(100),planId:z.string().max(100),direction:z.enum(['bullish','bearish']),entry:z.number().positive().finite(),quantity:z.number().positive().finite(),filledAt:z.number().int().nonnegative(),source:z.literal('user-confirmed'),review:z.array(z.string().max(500)).max(30)}).strict()).max(20).optional()}).strict();
const computations=new Map<string,{facts:ReturnType<typeof extractFrameFacts>;candidates:ReturnType<typeof evaluateStrategies>}>();
export function clearResearchComputationCache(){computations.clear();}
export const researchRequestSchema=z.object({
 reviewDepth:z.enum(['quick','deep']).optional(),
 ...visualRequestFields,
 planPolicy:planPolicySchema.optional(),
 bundle:z.object({symbol:z.string().trim().min(1).max(60),asOf:z.number().int().nonnegative(),frames:z.array(frameInputSchema).min(1).max(3)}).strict(),
 previous:previousSchema,provider:z.enum(['codex','api','mock']),notes:z.string().max(2000),
}).strict();
export function prepareResearchRequest(raw:unknown){
 const preparedAt=performance.now();
 const input=researchRequestSchema.parse(raw),bundle=makeResearchBundle(input.bundle.symbol,input.bundle.frames,input.bundle.asOf);
 const derived=input.bundle.frames.filter(f=>f.source==='aggregated');
 if(derived.length){const base=input.bundle.frames.find(f=>f.timeframe==='1m'&&f.source==='csv');if(!base)throw new Error('聚合数据必须附带实际1m CSV输入。');
  const expected=csvResearchBundle(bundle.symbol,base.candles,'1m');
  for(const f of derived){const correct=expected.frames[f.timeframe];if(f.derivedFrom!==correct.derivedFrom||JSON.stringify(f.candles)!==JSON.stringify(correct.candles))throw new Error('聚合OHLCV或来源未通过确定性重算。');}
 }
 validateImageAnchors(input.inputMode??'data',input.images??[],RESEARCH_FRAMES.map(tf=>bundle.frames[tf]));
 for(const image of input.images??[])chartImageBytes(image);
 const planPolicy=resolvePlanPolicy(input.planPolicy),cacheKey=JSON.stringify({catalog:STRATEGY_CATALOG_VERSION,bundle,planPolicy}),cached=computations.get(cacheKey);
 let computed=cached;
 if(!computed){const facts=RESEARCH_FRAMES.flatMap(tf=>extractFrameFacts(bundle.frames[tf]));computed={facts,candidates:evaluateStrategies(bundle,facts,planPolicy)};computations.set(cacheKey,structuredClone(computed));if(computations.size>8)computations.delete(computations.keys().next().value!);}
 else {computations.delete(cacheKey);computations.set(cacheKey,computed);computed=structuredClone(computed);}
 return {input,preparation:{rulesMs:Math.max(0,performance.now()-preparedAt),reusedRules:!!cached},context:{reviewDepth:input.reviewDepth,catalogVersion:STRATEGY_CATALOG_VERSION,planPolicy,bundle,facts:computed.facts,candidates:computed.candidates,previous:input.previous}};
}
export function createResearchRouter(deps:{market:MarketDataProvider;config:ServerConfig;provider:AnalysisProvider;codex:CodexProvider;isCodexBusy:()=>boolean;setCodexBusy:(busy:boolean)=>void}){
 const router=Router();
 router.get('/market',async(request,response)=>{
  const parsed=z.object({symbol:z.string().regex(/^[A-Z0-9]{2,20}USDT$/),limit:z.coerce.number().int().min(20).max(300).default(300)}).strict().safeParse(request.query);
  if(!parsed.success)throw new PublicError(400,'RESEARCH_QUERY_INVALID','研究行情需要有效USDT标的，最多每周期300根。');
  const results=await Promise.allSettled(RESEARCH_FRAMES.map(interval=>deps.market.getCandles({...parsed.data,interval})));
  const available=results.flatMap(r=>r.status==='fulfilled'?[exchangeFrame(r.value)]:[]);
  if(!available.length)throw new PublicError(502,'RESEARCH_MARKET_UNAVAILABLE','三个周期均获取失败；没有复用过期数据或模拟数据。');
  const clock=(available.find(f=>f.timeframe==='1m')??available[0]).observedAt,asOf=Math.floor(clock/60)*60;
  const inputs:FrameInput[]=RESEARCH_FRAMES.map((tf,i)=>available.find(f=>f.timeframe===tf)??{timeframe:tf,symbol:parsed.data.symbol,source:'binance',closure:'exchange-confirmed',observedAt:asOf,lastClosedTime:null,candles:[],derivedFrom:null,unavailableReason:results[i].status==='rejected'?'该周期行情获取失败，已降级':'该周期缺失'});
  response.json(makeResearchBundle(parsed.data.symbol,inputs,asOf));
 });
 router.post('/analyze',async(request,response)=>{
  let prepared;try{prepared=prepareResearchRequest(request.body);}catch{throw new PublicError(400,'RESEARCH_REQUEST_INVALID','多周期输入、收盘锚点或聚合来源未通过校验。');}
  const {input,context}=prepared,selected=input.provider;
  if(selected==='codex'&&deps.isCodexBusy())throw new PublicError(409,'CODEX_BUSY','已有分析进行中，请等待或取消。');
  if(selected==='api'&&!isAIConfigured(deps.config))throw new PublicError(503,'AI_NOT_CONFIGURED','独立API未配置；不会切换计费来源。');
  const focus=[...RESEARCH_FRAMES].reverse().map(tf=>context.bundle.frames[tf]).find(f=>f.candles.length>=10);
  if(!focus)throw new PublicError(400,'RESEARCH_DATA_INSUFFICIENT','至少需要一个周期有10根真实已收盘数据；其余周期可明确降级。');
  const controller=new AbortController(),close=()=>{if(!response.writableEnded)controller.abort();};response.once('close',close);
  if(selected==='codex')deps.setCodexBusy(true);
  try{
   const modelInput:ModelInput={candles:focus.candles,context:{symbol:context.bundle.symbol,timeframe:focus.timeframe,notes:input.notes},workbench:context,visuals:input.images,signal:controller.signal};
   const result=selected==='mock'?{analysis:validateWorkbenchInterpretation(localWorkbenchInterpretation(context),context),model:'local-rules-unreviewed',analysisAttempts:0}:
    await analyzeWithValidation(modelInput,async fixed=>selected==='codex'?deps.codex.analyzeDetailed(fixed,fixed.signal):{analysis:await deps.provider.analyze(fixed),model:deps.config.model},
      {provider:selected,timeoutMs:selected==='codex'?deps.config.codexTimeoutMs:deps.config.timeoutMs,validate:raw=>validateWorkbenchInterpretation(raw,context)});
   response.json({schemaVersion:'research-response-1.0',catalogVersion:context.catalogVersion,snapshotId:context.bundle.id,stateVersion:context.previous.version,source:selected==='mock'?'mock':'ai',provider:selected,generatedAt:new Date().toISOString(),preparation:prepared.preparation,...result});
  }finally{response.removeListener('close',close);if(selected==='codex')deps.setCodexBusy(false);}
 });
 return router;
}
