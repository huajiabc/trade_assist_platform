import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { BinanceReadonlyClient, BinanceAccountService, BINANCE_READ_ONLY_ENDPOINTS, signBinanceQuery, accountServiceFromEnvironment } from '../server/binanceReadonly';
import { accountData, accountRow, accountCredentials, exchangeInfo } from './account-fixtures';
import { createApp } from '../server/app';
import { readServerConfig } from '../server/config';
const services:BinanceAccountService[]=[];
afterEach(()=>{services.forEach(s=>s.disconnect());services.length=0;vi.useRealTimers();});
function harness(){
 let now=Date.now(),risks:Record<string,unknown>[]=[accountRow()],fail:string|null=null;
 const calls:{url:URL;method:string;headers:Record<string,string>}[]=[];
 const transport=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(String(input));calls.push({url,method:init?.method??'GET',headers:init?.headers as Record<string,string>});
  if(fail&&url.pathname.includes('account'))throw new Error('PRIVATE '+accountCredentials.secret+' '+url.toString());
  const body=url.pathname==='/fapi/v1/time'?{serverTime:now+5000}:url.pathname==='/fapi/v1/exchangeInfo'?exchangeInfo:url.pathname==='/fapi/v3/account'?accountData(risks):url.pathname==='/fapi/v2/positionRisk'?risks:url.pathname.endsWith('openOrders')||url.pathname.endsWith('openAlgoOrders')?[]:{dualSidePosition:false};
  return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
 });
 const client=new BinanceReadonlyClient(accountCredentials,transport as typeof fetch,()=>now),service=new BinanceAccountService(client,()=>now);services.push(service);
 return {client,service,transport,calls,advance:(ms:number)=>{now+=ms;},fail:()=>{fail='network';},positions:(next:Record<string,unknown>[])=>{risks=next;}};
}
describe('strictly read-only Binance transport',()=>{
 it('matches a known HMAC-SHA256 vector',()=>expect(signBinanceQuery('The quick brown fox jumps over the lazy dog','key')).toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8'));
 it.each(['POST','PUT','PATCH','DELETE','HEAD'])('rejects every %s before HTTP or signing',async method=>{const h=harness();await expect(h.client.request(method,'/fapi/v3/account')).rejects.toMatchObject({code:'ACCOUNT_READ_ONLY'});expect(h.calls).toHaveLength(0);});
 it.each(['/fapi/v1/order','/fapi/v1/leverage','/fapi/v1/marginType','/fapi/v1/positionMargin','/fapi/v1/allOpenOrders','/sapi/v1/asset/transfer','/fapi/v3/account?timestamp=1','https://evil.test/fapi/v3/account'])('rejects non-whitelisted path %s',async path=>{const h=harness();await expect(h.client.request('GET',path)).rejects.toMatchObject({status:403});expect(h.calls).toHaveLength(0);});
 it('synchronizes time, signs only USER_DATA GETs and sends the key in headers only',async()=>{
  const h=harness();await h.client.request('GET','/fapi/v3/account');expect(h.calls).toHaveLength(2);
  const call=h.calls[1],query=call.url.searchParams;expect(Number(query.get('timestamp'))).toBeGreaterThan(Date.now()+4000);expect(query.get('recvWindow')).toBe('5000');
  const signed=query.get('signature');query.delete('signature');expect(signed).toBe(createHmac('sha256',accountCredentials.secret).update(query.toString()).digest('hex'));
  expect(call.headers['X-MBX-APIKEY']).toBe(accountCredentials.apiKey);expect(call.method).toBe('GET');expect(call.url.origin).toBe('https://fapi.binance.com');expect(call.url.toString()).not.toContain(accountCredentials.apiKey);expect(call.url.toString()).not.toContain(accountCredentials.secret);
  expect(h.calls[0].headers).not.toHaveProperty('X-MBX-APIKEY');
 });
 it('repairs a clock error exactly once and classifies a repeated skew safely',async()=>{
  let timeCalls=0,signedCalls=0;const transport=vi.fn(async(input:RequestInfo|URL)=>{const url=new URL(String(input));if(url.pathname.endsWith('/time')){timeCalls++;return Response.json({serverTime:Date.now()});}signedCalls++;return Response.json({code:-1021,msg:'PRIVATE '+accountCredentials.secret},{status:400});});
  const client=new BinanceReadonlyClient(accountCredentials,transport as typeof fetch);await expect(client.request('GET','/fapi/v3/account')).rejects.toMatchObject({code:'ACCOUNT_CLOCK_SKEW'});expect(timeCalls).toBe(2);expect(signedCalls).toBe(2);
 });
 it.each([[401,-2015,'ACCOUNT_PERMISSION'],[403,-2014,'ACCOUNT_PERMISSION'],[400,-1022,'ACCOUNT_SIGNATURE_INVALID'],[500,-1000,'ACCOUNT_UPSTREAM']])('classifies status %s without upstream/private text',async(status,code,expected)=>{
  const transport=vi.fn(async()=>Response.json({code,msg:accountCredentials.secret},{status:status as number}));const client=new BinanceReadonlyClient(accountCredentials,transport as typeof fetch);
  await expect(client.request('GET','/fapi/v1/time')).rejects.toMatchObject({code:expected});try{await client.request('GET','/fapi/v1/time');}catch(e){expect(String(e)).not.toContain(accountCredentials.secret);}
 });
 it('honors Retry-After and blocks repeated refreshes before retry time',async()=>{
  let now=Date.now();const transport=vi.fn(async()=>new Response(null,{status:429,headers:{'Retry-After':'90'}})),client=new BinanceReadonlyClient(accountCredentials,transport as typeof fetch,()=>now);
  await expect(client.request('GET','/fapi/v1/time')).rejects.toMatchObject({code:'ACCOUNT_RATE_LIMITED'});await expect(client.request('GET','/fapi/v1/time')).rejects.toThrow();expect(transport).toHaveBeenCalledOnce();now+=90001;await expect(client.request('GET','/fapi/v1/time')).rejects.toThrow();expect(transport).toHaveBeenCalledTimes(2);
 });
 it('classifies timeout and caps response data without leaking a signed URL',async()=>{
  const transport=vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>new Promise<Response>((_,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error(accountCredentials.secret))))),client=new BinanceReadonlyClient(accountCredentials,transport as typeof fetch,Date.now,10);
  await expect(client.request('GET','/fapi/v1/time')).rejects.toMatchObject({code:'ACCOUNT_TIMEOUT'});
  const oversized=new BinanceReadonlyClient(accountCredentials,vi.fn(async()=>new Response('x'.repeat(2_000_001))) as typeof fetch);await expect(oversized.request('GET','/fapi/v1/time')).rejects.toMatchObject({code:'ACCOUNT_INVALID_DATA'});
 });
});
describe('one backend poller and account HTTP boundary',()=>{
 it('reads ordinary and algo orders in the same bounded snapshot and rejects writes to both paths',async()=>{const h=harness();const status=await h.service.connect();expect(status.snapshot!.orders).toMatchObject({validity:'fresh',standardAvailable:true,algoAvailable:true,orders:[]});for(const path of ['/fapi/v1/openOrders','/fapi/v1/openAlgoOrders']){expect(h.calls.some(c=>c.url.pathname===path&&c.method==='GET')).toBe(true);await expect(h.client.request('POST',path)).rejects.toMatchObject({code:'ACCOUNT_READ_ONLY'});}});
 it('preserves valid positions when one order query fails and never treats unread protection as absent',async()=>{const h=harness(),original=h.transport.getMockImplementation()!;h.transport.mockImplementation(async(input,init)=>new URL(String(input)).pathname==='/fapi/v1/openAlgoOrders'?Response.json({code:-2015,msg:accountCredentials.secret},{status:401}):original(input,init));const status=await h.service.connect();expect(status.validity).toBe('partial');expect(status.snapshot!.positions).toHaveLength(1);expect(status.snapshot!.orders).toMatchObject({validity:'partial',standardAvailable:true,algoAvailable:false});expect(JSON.stringify(status)).not.toContain(accountCredentials.secret);});
 it('does not contact an account until explicitly connected; environment credentials never enter status',()=>{
  const h=harness();expect(h.calls).toHaveLength(0);expect(h.service.status().connected).toBe(false);expect(JSON.stringify(h.service.status())).not.toContain(accountCredentials.secret);
  expect(accountServiceFromEnvironment({}).status().configured).toBe(false);
 });
 it('deduplicates concurrent refreshes and preserves stale data on failure rather than zeroing positions',async()=>{
  const h=harness();const [a,b]=await Promise.all([h.service.connect(),h.service.connect()]);expect(a.snapshot?.id).toBe(b.snapshot?.id);expect(h.calls).toHaveLength(7);expect(a.snapshot!.positions).toHaveLength(1);
  await h.service.refresh();expect(h.calls).toHaveLength(7);h.advance(16000);h.fail();const failed=await h.service.refresh();expect(failed.validity).toBe('stale');expect(failed.snapshot!.id).toBe(a.snapshot!.id);expect(failed.snapshot!.positions).toHaveLength(1);expect(failed.error?.code).toBe('ACCOUNT_NETWORK');expect(JSON.stringify(failed)).not.toContain(accountCredentials.secret);expect(()=>h.service.requireSnapshot(a.snapshot!.id)).toThrow();
 });
 it('marks expired snapshots and disconnected old data, keeps open-instance IDs distinct after a known flat interval',async()=>{
  const h=harness();const first=(await h.service.connect()).snapshot!;h.advance(46000);expect(h.service.status().validity).toBe('stale');expect(()=>h.service.requireSnapshot(first.id)).toThrow();
  h.positions([accountRow({positionAmt:'0'})]);await h.service.refresh();expect(h.service.status().snapshot!.positions).toHaveLength(0);
  h.advance(16000);h.positions([accountRow()]);const reopened=(await h.service.refresh()).snapshot!;expect(reopened.positions[0].id).not.toBe(first.positions[0].id);
  const disconnected=h.service.disconnect();expect(disconnected.validity).toBe('disconnected');expect(disconnected.snapshot).not.toBeNull();expect(()=>h.service.requireSnapshot(reopened.id)).toThrow();
 });
 it('polls at a bounded interval and stops after disconnect',async()=>{
  vi.useFakeTimers();const h=harness();await h.service.connect();const initial=h.calls.length;h.advance(15000);await vi.advanceTimersByTimeAsync(15000);expect(h.calls.length).toBeGreaterThan(initial);h.service.disconnect();const stopped=h.calls.length;h.advance(60000);await vi.advanceTimersByTimeAsync(60000);expect(h.calls).toHaveLength(stopped);
 });
 it('does not promote a previous connection snapshot to current when reconnecting fails',async()=>{const h=harness(),first=(await h.service.connect()).snapshot!;h.service.disconnect();h.fail();const result=await h.service.connect();expect(result.snapshot!.id).toBe(first.id);expect(result.validity).toBe('stale');expect(()=>h.service.requireSnapshot(first.id)).toThrow();});
 it('accepts only local same-origin account controls, rejects credential uploads and all execution paths',async()=>{
  const h=harness(),codex={status:async()=>({available:false,authenticated:false,message:'test'}),analyzeDetailed:vi.fn()},app=createApp({accountService:h.service,config:readServerConfig({AI_PROVIDER:'mock'}),codexProvider:codex});
  await request(app).get('/api/account/status').set('Host','evil.test').expect(403);await request(app).get('/api/account/status').set('Origin','https://evil.test').expect(403);
  await request(app).post('/api/account/connect').send({apiKey:accountCredentials.apiKey,secret:accountCredentials.secret}).expect(400);expect(h.calls).toHaveLength(0);
  await request(app).post('/api/account/order').send({symbol:'SNDKUSDT'}).expect(405);await request(app).get('/api/account/proxy?endpoint=/fapi/v1/order').expect(405);expect(h.calls).toHaveLength(0);
  const response=await request(app).post('/api/account/connect').send({}).expect(200);expect(response.headers['cache-control']).toBe('no-store');expect(response.body.snapshot.positions).toHaveLength(1);expect(response.text).not.toContain(accountCredentials.apiKey);expect(response.text).not.toContain(accountCredentials.secret);expect(response.text).not.toContain('signature=');
  await request(app).post('/api/account/disconnect').send({}).expect(200);expect(codex.analyzeDetailed).not.toHaveBeenCalled();expect(h.calls.every(c=>c.method==='GET'&&BINANCE_READ_ONLY_ENDPOINTS.includes(c.url.pathname as any))).toBe(true);
 });
});
