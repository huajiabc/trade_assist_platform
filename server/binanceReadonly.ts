import { createHmac, randomUUID } from 'node:crypto';
import { marketFetch } from './network';
import { PublicError } from './errors';
import { normalizeAccount, ACCOUNT_POLL_MS, ACCOUNT_STALE_MS, type AccountSnapshot, type AccountStatus } from '../shared/account';
import { normalizeProtectionOrders } from '../shared/protectionOrders';

export const BINANCE_READ_ONLY_ENDPOINTS=Object.freeze(['/fapi/v1/time','/fapi/v1/exchangeInfo','/fapi/v3/account','/fapi/v2/positionRisk','/fapi/v1/positionSide/dual','/fapi/v1/openOrders','/fapi/v1/openAlgoOrders'] as const);
type Endpoint=typeof BINANCE_READ_ONLY_ENDPOINTS[number];
export interface BinanceCredentials {apiKey:string;secret:string}
const signed=(path:Endpoint)=>!['/fapi/v1/time','/fapi/v1/exchangeInfo'].includes(path);
export const signBinanceQuery=(query:string,secret:string)=>createHmac('sha256',secret).update(query).digest('hex');
const fail=(code:string,message:string,status=502)=>new PublicError(status,code,message);
async function safeJson(response:Response):Promise<unknown>{
  if(!response.body)throw fail('ACCOUNT_INVALID_DATA','账户响应缺失。');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>2_000_000){await reader.cancel();throw fail('ACCOUNT_INVALID_DATA','账户响应超出安全大小。');}chunks.push(part.value);}}
  finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail('ACCOUNT_INVALID_DATA','账户响应不是有效JSON。');}
}
/** No arbitrary origin, headers, query parameters, methods, or execution endpoints. */
export class BinanceReadonlyClient {
  private offset=0;private exchangeTime=0;private timeSyncedAt=0;private timeRequest:Promise<void>|null=null;private cooldownUntil=0;
  private metadata:unknown=null;private metadataAt=0;
  constructor(private readonly credentials:BinanceCredentials,private readonly transport:typeof fetch=marketFetch,private readonly now=Date.now,private readonly timeoutMs=8000){}
  get nextRetryAt(){return this.cooldownUntil>this.now()?this.cooldownUntil:null;}
  async request(method:string,path:string,signal?:AbortSignal):Promise<unknown>{
    if(method!=='GET'||!BINANCE_READ_ONLY_ENDPOINTS.includes(path as Endpoint))throw fail('ACCOUNT_READ_ONLY','账户适配器只允许白名单GET读取，已拒绝该请求。',403);
    return this.get(path as Endpoint,signal,true);
  }
  private async syncTime(signal?:AbortSignal){
    if(this.timeRequest)return this.timeRequest;
    this.timeRequest=(async()=>{const before=this.now(),body=await this.get('/fapi/v1/time',signal,false) as {serverTime?:unknown},after=this.now();
      if(typeof body.serverTime!=='number'||!Number.isSafeInteger(body.serverTime))throw fail('ACCOUNT_TIME_INVALID','交易所时间响应无效。');
      this.offset=body.serverTime-Math.floor((before+after)/2);this.exchangeTime=body.serverTime;this.timeSyncedAt=after;
    })();try{await this.timeRequest;}finally{this.timeRequest=null;}
  }
  private async get(path:Endpoint,signal:AbortSignal|undefined,repairTime:boolean):Promise<unknown>{
    if(!BINANCE_READ_ONLY_ENDPOINTS.includes(path))throw fail('ACCOUNT_READ_ONLY','非白名单账户请求已拒绝。',403);
    if(this.now()<this.cooldownUntil)throw fail('ACCOUNT_RATE_LIMITED','账户接口处于限流退避期，请等待下次重试。',429);
    if(signed(path)&&(!this.timeSyncedAt||this.now()-this.timeSyncedAt>300000))await this.syncTime(signal);
    const controller=new AbortController(),cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)controller.abort();
    const timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    try{
      const url=new URL(path,'https://fapi.binance.com');
      const headers:Record<string,string>={Accept:'application/json'};
      if(signed(path)){const query=new URLSearchParams({timestamp:String(Math.floor(this.now()+this.offset)),recvWindow:'5000'}).toString();url.search=query+'&signature='+signBinanceQuery(query,this.credentials.secret);headers['X-MBX-APIKEY']=this.credentials.apiKey;}
      const response=await this.transport(url,{method:'GET',headers,signal:controller.signal,redirect:'error'});
      if(response.status===429||response.status===418){
        const header=response.headers.get('retry-after'),seconds=Number(header);const date=header?Date.parse(header):NaN;
        this.cooldownUntil=this.now()+(Number.isFinite(seconds)&&seconds>0?seconds*1000:Number.isFinite(date)?Math.max(1000,date-this.now()):60000);
        await response.body?.cancel();throw fail('ACCOUNT_RATE_LIMITED','Binance账户接口限流，已暂停请求并遵守Retry-After。',429);
      }
      const body=await safeJson(response),code=body&&typeof body==='object'&&'code' in body?Number(body.code):null;
      if(!response.ok){
        if(code===-1021&&repairTime){this.timeSyncedAt=0;await this.syncTime(signal);return await this.get(path,signal,false);}
        if(code===-1021)throw fail('ACCOUNT_CLOCK_SKEW','账户签名时间偏差仍过大，请检查系统时钟。',400);
        if(code===-1022)throw fail('ACCOUNT_SIGNATURE_INVALID','账户签名无效，请检查服务端Secret与密钥类型（需HMAC）。',401);
        if(response.status===401||response.status===403||code===-2014||code===-2015)throw fail('ACCOUNT_PERMISSION','账户读取被拒绝，请核对API Key、读取权限、IP白名单及地区可用性。',403);
        throw fail('ACCOUNT_UPSTREAM','Binance账户服务返回异常，请稍后重试。');
      }
      const used=Number(response.headers.get('x-mbx-used-weight-1m'));if(used>=1800)this.cooldownUntil=Math.max(this.cooldownUntil,this.now()+30000);
      return body;
    }catch(error){if(error instanceof PublicError)throw error;if(controller.signal.aborted)throw fail('ACCOUNT_TIMEOUT','账户请求超时或已取消，旧持仓不代表当前仓位。',504);throw fail('ACCOUNT_NETWORK','无法连接Binance账户服务，请检查服务端网络及代理。');}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
  }
  async snapshot(accountRef:string,signal?:AbortSignal):Promise<AccountSnapshot>{
    await this.syncTime(signal);
    if(!this.metadata||this.now()-this.metadataAt>3600000){try{this.metadata=await this.request('GET','/fapi/v1/exchangeInfo',signal);this.metadataAt=this.now();}catch{this.metadata=null;}}
    const [account,risks,mode,standard,algo]=await Promise.allSettled([this.request('GET','/fapi/v3/account',signal),this.request('GET','/fapi/v2/positionRisk',signal),this.request('GET','/fapi/v1/positionSide/dual',signal),this.request('GET','/fapi/v1/openOrders',signal),this.request('GET','/fapi/v1/openAlgoOrders',signal)]);
    if(account.status==='rejected')throw account.reason;if(risks.status==='rejected')throw risks.reason;
    try{const syncedAt=this.now(),orders=normalizeProtectionOrders({standard:standard.status==='fulfilled'?standard.value:null,algo:algo.status==='fulfilled'?algo.value:null,syncedAt,staleAfterMs:ACCOUNT_STALE_MS});return normalizeAccount({account:account.value,risks:risks.value,mode:mode.status==='fulfilled'?mode.value:null,exchangeInfo:this.metadata,accountRef,snapshotId:'account-'+randomUUID(),syncedAt,exchangeTime:this.exchangeTime,orders});}catch{throw fail('ACCOUNT_INVALID_DATA','账户/持仓数据未通过规范化或交叉核验，已保留旧快照并标记异常。');}
  }
}
export interface ReadonlyAccountService {
  status():AccountStatus;connect():Promise<AccountStatus>;refresh():Promise<AccountStatus>;disconnect():AccountStatus;requireSnapshot(id:string):AccountSnapshot;
}
/** One server-side poller, one in-flight refresh; credentials are never part of status or snapshot. */
export class BinanceAccountService implements ReadonlyAccountService {
  private readonly accountRef='binance-'+randomUUID();private snapshot:AccountSnapshot|null=null;
  private connected=false;private attempt:number|null=null;private success:number|null=null;private error:AccountStatus['error']=null;
  private pending:Promise<AccountStatus>|null=null;private timer:ReturnType<typeof setInterval>|null=null;private abort:AbortController|null=null;private generation=0;private failures=0;private retryAt:number|null=null;
  private positionInstances=new Map<string,string>();
  private successGeneration=-1;
  constructor(private readonly client:BinanceReadonlyClient|null,private readonly now=Date.now){}
  status():AccountStatus{return {configured:!!this.client,connected:this.connected,syncing:!!this.pending,readOnly:true,credentialStorage:'server-environment',pollIntervalMs:ACCOUNT_POLL_MS,staleAfterMs:ACCOUNT_STALE_MS,lastAttemptAt:this.attempt,lastSuccessAt:this.success,nextRetryAt:Math.max(this.retryAt??0,this.client?.nextRetryAt??0)>this.now()?Math.max(this.retryAt??0,this.client?.nextRetryAt??0):null,
    validity:!this.connected?'disconnected':!this.snapshot?'unavailable':this.error||this.successGeneration!==this.generation||this.now()>=this.snapshot.expiresAt?'stale':this.snapshot.warnings.length||this.snapshot.orders&&this.snapshot.orders.validity!=='fresh'||this.snapshot.positions.some(p=>p.validity!=='valid'||p.warnings.length)?'partial':'fresh',error:this.error,snapshot:this.snapshot};}
  async connect(){if(!this.client)throw fail('ACCOUNT_NOT_CONFIGURED','请在服务端配置BINANCE_API_KEY和BINANCE_API_SECRET后重启服务。',503);this.connected=true;
    if(!this.timer){this.timer=setInterval(()=>{void this.refresh().catch(()=>{});},ACCOUNT_POLL_MS);this.timer.unref();}
    return this.refresh();}
  async refresh():Promise<AccountStatus>{
    if(!this.client||!this.connected)throw fail('ACCOUNT_DISCONNECTED','账户未连接，请先测试并连接。',409);
    if(this.pending)return this.pending;
    if(this.attempt!==null&&this.now()-this.attempt<3000||this.status().nextRetryAt)return this.status();
    const generation=this.generation,controller=new AbortController();this.abort=controller;this.attempt=this.now();const timeout=setTimeout(()=>controller.abort(),12000);
    const run=(async()=>{try{const snapshot=await this.client!.snapshot(this.accountRef,controller.signal);if(generation===this.generation&&this.connected){
        const instances=snapshot.warnings.some(w=>/持仓行|不一致/.test(w))?new Map(this.positionInstances):new Map<string,string>();
        for(const p of snapshot.positions){const key=p.symbol+':'+p.positionSide,instance=this.positionInstances.get(key)??randomUUID();instances.set(key,instance);p.id+=':'+instance;}
        this.positionInstances=instances;this.snapshot=snapshot;this.success=this.now();this.successGeneration=generation;this.error=null;this.failures=0;this.retryAt=null;}}
      catch(error){if(generation===this.generation&&this.connected){const safe=error instanceof PublicError?error:fail('ACCOUNT_UNAVAILABLE','账户同步失败。');this.error={code:safe.code,message:safe.message};this.failures++;this.retryAt=this.now()+Math.min(300000,ACCOUNT_POLL_MS*2**Math.min(this.failures-1,4));}}
      finally{clearTimeout(timeout);if(generation===this.generation){this.pending=null;this.abort=null;}}
      return this.status();})();this.pending=run;return run;
  }
  disconnect(){this.generation++;this.connected=false;this.attempt=null;this.positionInstances.clear();this.abort?.abort();this.abort=null;this.pending=null;if(this.timer)clearInterval(this.timer);this.timer=null;this.error=null;this.retryAt=null;return this.status();}
  requireSnapshot(id:string){const status=this.status();if(!status.connected||!['fresh','partial'].includes(status.validity)||status.error||!this.snapshot||this.now()>=this.snapshot.expiresAt||id!==this.snapshot.id)throw fail('ACCOUNT_SNAPSHOT_STALE','账户快照已变化、过期或连接异常，请刷新账户后重新审阅。',409);if(this.snapshot.warnings.some(w=>/持仓行|不一致/.test(w)))throw fail('ACCOUNT_INCOMPLETE','账户仓位覆盖不完整，暂停持仓审阅。',409);return this.snapshot;}
}
export function accountServiceFromEnvironment(env:NodeJS.ProcessEnv=process.env):BinanceAccountService {
  const apiKey=env.BINANCE_API_KEY?.trim(),secret=env.BINANCE_API_SECRET?.trim();
  return new BinanceAccountService(apiKey&&secret?new BinanceReadonlyClient({apiKey,secret}):null);
}
