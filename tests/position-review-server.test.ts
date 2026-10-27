import { describe,it,expect,vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app';
import { readServerConfig } from '../server/config';
import type { ReadonlyAccountService } from '../server/binanceReadonly';
import type { ModelInput } from '../server/provider';
import { modelPayload } from '../server/provider';
import { accountSnapshot,accountCredentials } from './account-fixtures';
import { emptyAccountStatus } from '../shared/account';
import { makeResearchBundle,FRAME_SECONDS,RESEARCH_FRAMES } from '../shared/researchData';
import { modelContext,updateMarketState } from '../shared/marketState';
import { localPositionAdvice } from '../shared/positionManagement';
import { frameInput } from '../src/services/workbench';
function fixture(){
 let snapshot=accountSnapshot(),status={...emptyAccountStatus(),configured:true,connected:true,validity:'fresh' as const,snapshot,lastSuccessAt:Date.now()};
 const service:ReadonlyAccountService={status:()=>status,connect:async()=>status,refresh:async()=>status,disconnect:()=>{status={...status,connected:false};return status;},requireSnapshot:id=>{if(id!==status.snapshot!.id||!status.connected)throw new Error('stale');return status.snapshot!;}};
 const asOf=Math.floor(Date.now()/60000)*60,bundle=makeResearchBundle('SNDKUSDT',RESEARCH_FRAMES.map(tf=>{const seconds=FRAME_SECONDS[tf],end=Math.floor(asOf/seconds)*seconds;const candles=Array.from({length:40},(_,i)=>({timestamp:end-(40-i)*seconds,open:100,high:102,low:98,close:101,volume:100}));return {symbol:'SNDKUSDT',timeframe:tf,source:'binance' as const,closure:'exchange-confirmed' as const,observedAt:asOf,candles,lastClosedTime:candles.at(-1)!.timestamp,derivedFrom:null,unavailableReason:null};}),asOf);
 const state=updateMarketState(null,bundle),context=modelContext(state),provider={analyze:vi.fn(async(input:ModelInput)=>localPositionAdvice(input.positionReview!))},codex={status:async()=>({available:false,authenticated:false,message:'test'}),analyzeDetailed:vi.fn()};
 const app=createApp({accountService:service,provider,codexProvider:codex,config:readServerConfig({AI_PROVIDER:'api',AI_API_KEY:'independent-api-test-key',AI_MODEL:'test-model',AI_TIMEOUT_MS:'1000'})});
 const body={positionId:snapshot.positions[0].id,accountSnapshotId:snapshot.id,linkedPlanId:null,research:{bundle:{symbol:bundle.symbol,asOf:bundle.asOf,frames:RESEARCH_FRAMES.map(tf=>frameInput(bundle.frames[tf]))},previous:context.previous,provider:'api',notes:'',inputMode:'data',images:[]}};
 return {app,body,provider,codex,service,context,changeAccount:()=>{snapshot={...snapshot,id:'new-account-snapshot'};status={...status,snapshot};}};
}
describe('real-position review service with injected HTTP/model transports only',()=>{
 it('uses the selected server snapshot, bounded common model validator and no inferred original plan',async()=>{
  const f=fixture(),response=await request(f.app).post('/api/account/review').send(f.body).expect(200);
  expect(f.provider.analyze).toHaveBeenCalledOnce();const input=f.provider.analyze.mock.calls[0][0];expect(input.positionReview!.originalPlan).toBeNull();expect(input.positionReview!.position.entryPrice).toBe(98);expect(input.workbench!.bundle.id).toBe(f.context.bundle.id);
  expect(response.body).toMatchObject({accountSnapshotId:f.body.accountSnapshotId,marketSnapshotId:f.context.bundle.id,stateVersion:f.context.previous.version,stale:false,analysisAttempts:1});
  const serialized=JSON.stringify(modelPayload(input));for(const secret of [accountCredentials.apiKey,accountCredentials.secret]){expect(serialized).not.toContain(secret);expect(response.text).not.toContain(secret);}expect(serialized).not.toContain('independent-api-test-key');expect(f.codex.analyzeDetailed).not.toHaveBeenCalled();
 });
 it('repairs invalid advice once against exactly the same account and market anchors',async()=>{
  const f=fixture();f.provider.analyze.mockImplementation(async input=>f.provider.analyze.mock.calls.length===1?{} as any:localPositionAdvice(input.positionReview!));const response=await request(f.app).post('/api/account/review').send(f.body).expect(200);expect(response.body.analysisAttempts).toBe(2);expect(f.provider.analyze.mock.calls[1][0].positionReview!.account.snapshotId).toBe(f.body.accountSnapshotId);expect(f.provider.analyze.mock.calls[1][0].validationFeedback).toBeDefined();
 });
 it('does not send other manually recorded holdings to a selected exchange-position review',async()=>{const f=fixture(),body=f.body as any;body.research.previous.positions=[{id:'unrelated-manual-holding',planId:'other',direction:'bullish',entry:100,quantity:1000,filledAt:Date.now()/1000|0,source:'user-confirmed',review:[]}];await request(f.app).post('/api/account/review').send(body).expect(200);const input=f.provider.analyze.mock.calls[0][0];expect(input.workbench!.previous.positions).toEqual([]);expect(JSON.stringify(modelPayload(input))).not.toContain('unrelated-manual-holding');});
 it('marks results historical if account data changes while the model is running',async()=>{
  const f=fixture();f.provider.analyze.mockImplementation(async input=>{f.changeAccount();return localPositionAdvice(input.positionReview!);});const response=await request(f.app).post('/api/account/review').send(f.body).expect(200);expect(response.body.stale).toBe(true);expect(response.body.accountSnapshotId).toBe(f.body.accountSnapshotId);expect(response.body.staleReasons.length).toBeGreaterThan(0);
 });
 it('rejects unprovided plans, mismatched symbols and historical market clocks before model usage',async()=>{
  const f=fixture();await request(f.app).post('/api/account/review').send({...f.body,linkedPlanId:'inferred-from-symbol'}).expect(400);
  const old=structuredClone(f.body);old.research.bundle.asOf-=86400;old.research.bundle.frames=old.research.bundle.frames.map(frame=>({...frame,observedAt:frame.observedAt-86400,lastClosedTime:frame.lastClosedTime!-86400,candles:frame.candles.map(c=>({...c,timestamp:c.timestamp-86400}))}));
  const result=await request(f.app).post('/api/account/review').send(old).expect(409);expect(result.body.error.code).toBe('POSITION_MARKET_STALE');expect(f.provider.analyze).not.toHaveBeenCalled();
  const wrong=structuredClone(f.body);wrong.research.bundle.symbol='BTCUSDT';wrong.research.bundle.frames=wrong.research.bundle.frames.map(frame=>({...frame,symbol:'BTCUSDT'}));await request(f.app).post('/api/account/review').send(wrong).expect(400);expect(f.provider.analyze).not.toHaveBeenCalled();
 });
 it('blocks made-up prices after two invalid model replies and returns a safe timeout',async()=>{
  const f=fixture();f.provider.analyze.mockImplementation(async input=>({...localPositionAdvice(input.positionReview!),protection:{structureId:'fake',timeframe:'5m',price:99.99}}) as any);await request(f.app).post('/api/account/review').send(f.body).expect(502);expect(f.provider.analyze).toHaveBeenCalledTimes(2);
  f.provider.analyze.mockReset();f.provider.analyze.mockImplementation(async input=>new Promise((_,reject)=>input.signal?.addEventListener('abort',()=>reject(new Error(accountCredentials.secret)))));const response=await request(f.app).post('/api/account/review').send(f.body).expect(504);expect(response.text).not.toContain(accountCredentials.secret);expect(f.provider.analyze).toHaveBeenCalledOnce();
 });
});
