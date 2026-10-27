import {describe,it,expect,vi} from 'vitest';
import request from 'supertest';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {chartImageAnchor,validateImageAnchors,candleRows,CANDLE_COLUMNS} from '../shared/analysisInput';
import {imageFixture} from './visual-fixtures';
import {SAMPLE_CANDLES} from '../shared/sample';
import {researchBundle} from './research-fixtures';
import {modelContext,updateMarketState} from '../shared/marketState';
import {localWorkbenchInterpretation} from '../shared/workbenchAnalysis';
import {chartImageBytes} from '../server/chartImages';
import {CodexAnalysisProvider,type CodexProcessRequest} from '../server/codex';
import {OpenAICompatibleProvider,modelPayload,buildAnalysisPayload,type ModelInput} from '../server/provider';
import {readServerConfig} from '../server/config';
import {createMockAnalysis} from '../shared/mock';
import {createApp} from '../server/app';
import {analyzeWithValidation} from '../server/analysisService';
const candles=SAMPLE_CANDLES.slice(-40),context={symbol:'SNDKUSDT',timeframe:'1m',notes:''};
const image=imageFixture(candles),input:ModelInput={candles,context,visuals:[image]};
const config=readServerConfig({AI_PROVIDER:'api',AI_API_KEY:'fixture-key',AI_MODEL:'fixture',AI_TIMEOUT_MS:'1000'});
const unavailable={status:async()=>({available:false,authenticated:false,message:'fixture'}),analyzeDetailed:vi.fn()};
const completion=(analysis:unknown)=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(analysis)}}]}),{headers:{'content-type':'application/json'}});
describe('snapshot-bound hybrid input (no paid calls)',()=>{
 it('binds every image to exact OHLCV, symbol, timeframe and closed range',()=>{
  expect(()=>validateImageAnchors('hybrid',[image],[{...context,candles}])).not.toThrow();
  for(const broken of [{...image,toTime:image.toTime+60},{...image,symbol:'OTHER'},{...image,fingerprint:'stale'}])expect(()=>validateImageAnchors('hybrid',[broken],[{...context,candles}])).toThrow();
  expect(()=>validateImageAnchors('hybrid',[],[{...context,candles}])).toThrow();expect(()=>validateImageAnchors('hybrid',[image,image],[{...context,candles}])).toThrow();expect(()=>validateImageAnchors('data',[image],[{...context,candles}])).toThrow();
  expect(chartImageAnchor(candles.map((b,i)=>i?b:{...b,volume:b.volume+1}),context.symbol,context.timeframe).fingerprint).not.toBe(image.fingerprint);
 });
 it('rejects non-PNG and false dimensions before transport',()=>{
  expect(chartImageBytes(image).subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(()=>chartImageBytes({...image,base64:Buffer.from('not a valid PNG file, even with a long fake body').toString('base64')})).toThrow();const bad=chartImageBytes(image);bad.writeUInt32BE(50000,16);expect(()=>chartImageBytes({...image,base64:bad.toString('base64')})).toThrow();
 });
 it('keeps all exact OHLCV and evidence IDs while shrinking text without base64 leakage',()=>{
  const compact=modelPayload(input) as any;expect(compact.candleColumns).toEqual(CANDLE_COLUMNS);expect(compact.candles).toEqual(candleRows(candles));expect(compact.marketContext).toEqual(buildAnalysisPayload(input).marketContext);expect(JSON.stringify(compact)).not.toContain(image.base64);
  const ctx=modelContext(updateMarketState(null,researchBundle())),base:ModelInput={candles:ctx.bundle.frames['1m'].candles,context,workbench:ctx},hybrid={...base,visuals:Object.values(ctx.bundle.frames).map(f=>imageFixture(f.candles,f.symbol,f.timeframe))};
  const a=modelPayload(base) as any,b=modelPayload(hybrid) as any;expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThan(Buffer.byteLength(JSON.stringify(a)));expect(b.marketContext).toEqual(a.marketContext);expect(b.facts.map((f:any)=>f.id)).toEqual(a.facts.map((f:any)=>f.id));for(const tf of ['15m','5m','1m'])expect(b.bundle.frames[tf].candles).toEqual(candleRows(ctx.bundle.frames[tf as '1m'].candles));expect(modelPayload({...input,visuals:undefined})).toEqual(buildAnalysisPayload({...input,visuals:undefined}));
 });
 it('sends inline images using the existing API JSON schema without fallback',async()=>{
  const fetcher=vi.fn(async()=>completion(createMockAnalysis(candles)));await new OpenAICompatibleProvider(config,fetcher).analyze(input);const body=JSON.parse((fetcher.mock.calls[0] as any)[1].body);
  expect(body.messages[1].content[0].type).toBe('text');expect(body.messages[1].content[1]).toMatchObject({type:'image_url',image_url:{url:'data:image/png;base64,'+image.base64,detail:'high'}});expect(body.response_format.type).toBe('json_schema');expect(body.messages[0].content).toContain('不能从像素猜数');expect(fetcher).toHaveBeenCalledOnce();
 });
 it.each([false,true])('attaches only isolated PNG files and cleans them after success/error %s',async fail=>{
  let directory='',file='';const run=vi.fn(async(r:CodexProcessRequest)=>{if(r.stopAfterResponseId)return {code:0,stderr:'',stdout:JSON.stringify({id:2,result:{account:{type:'chatgpt'}}})+'\n'};
   directory=r.cwd;file=r.args[r.args.indexOf('--image')+1];expect(await readFile(file)).toEqual(chartImageBytes(image));expect(r.input).not.toContain(image.base64);expect(JSON.parse(r.input).candles).toEqual(candleRows(candles));if(fail)throw new Error('private provider error');await writeFile(r.args[r.args.indexOf('--output-last-message')+1],JSON.stringify(createMockAnalysis(candles)));return {code:0,stderr:'',stdout:JSON.stringify({type:'turn.completed'})+'\n'};});
  const provider=new CodexAnalysisProvider({}, {run,resolveBinary:async()=>'/official/codex'});if(fail)await expect(provider.analyzeDetailed(input)).rejects.toThrow();else await expect(provider.analyzeDetailed(input)).resolves.toHaveProperty('analysis');await expect(stat(file)).rejects.toMatchObject({code:'ENOENT'});await expect(stat(directory)).rejects.toMatchObject({code:'ENOENT'});
 });
 it('validates screenshot anchors before any auth/model process',async()=>{const run=vi.fn();const provider=new CodexAnalysisProvider({}, {run,resolveBinary:async()=>'/official/codex'});await expect(provider.analyzeDetailed({...input,visuals:[{...image,fingerprint:'wrong'}]})).rejects.toThrow();expect(run).not.toHaveBeenCalled();});
 it('rejects stale images at HTTP boundaries and accepts strictly validated single-period results',async()=>{
  const analyze=vi.fn(async(_input:ModelInput)=>createMockAnalysis(candles)),app=createApp({config,provider:{analyze},codexProvider:unavailable});const body={candles,context,mode:'ai',provider:'api',inputMode:'hybrid',images:[image]};
  await request(app).post('/api/analyze').send({...body,images:[{...image,toTime:0}]}).expect(400);expect(analyze).not.toHaveBeenCalled();const r=await request(app).post('/api/analyze').send(body).expect(200);expect(r.body.diagnostics).toMatchObject({inputMode:'hybrid',imageCount:1,attempts:1});expect(analyze.mock.calls[0][0].visuals).toHaveLength(1);
 });
 it('requires each available research period and preserves explicit missing-data degradation',async()=>{
  const ctx=modelContext(updateMarketState(null,researchBundle())),frames=Object.values(ctx.bundle.frames).map(({id,integrity,...f})=>f),images=frames.map(f=>imageFixture(f.candles,f.symbol,f.timeframe));const analyze=vi.fn(async(i:ModelInput)=>localWorkbenchInterpretation(i.workbench!)),app=createApp({config,provider:{analyze},codexProvider:unavailable}),body={bundle:{symbol:ctx.bundle.symbol,asOf:ctx.bundle.asOf,frames},previous:ctx.previous,provider:'api',notes:'',inputMode:'hybrid',images};
  await request(app).post('/api/research/analyze').send({...body,images:images.slice(1)}).expect(400);expect(analyze).not.toHaveBeenCalled();await request(app).post('/api/research/analyze').send(body).expect(200);expect(analyze).toHaveBeenCalledOnce();expect(analyze.mock.calls[0][0].visuals).toHaveLength(3);
 });
 it('reports combined provider time and attempts without exposing payload in diagnostics',async()=>{
  const run=vi.fn(async(i:ModelInput)=>({model:'fixture',analysis:run.mock.calls.length===1?{}:createMockAnalysis(i.candles)}));const result=await analyzeWithValidation(input,run,{provider:'api',timeoutMs:1000});expect(result.diagnostics).toMatchObject({inputMode:'hybrid',attempts:2,imageCount:1});expect(result.diagnostics.elapsedMs).toBeGreaterThanOrEqual(result.diagnostics.providerMs);expect(JSON.stringify(result.diagnostics)).not.toContain('base64');expect(result.analysisAttempts).toBe(2);
 });
});
