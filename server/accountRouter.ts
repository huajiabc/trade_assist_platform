import { Router } from 'express';
import { z } from 'zod';
import { PublicError } from './errors';
import type { ReadonlyAccountService } from './binanceReadonly';
import type { ServerConfig } from './config';
import { isAIConfigured } from './config';
import type { AnalysisProvider, ModelInput } from './provider';
import type { CodexProvider } from './codex';
import { prepareResearchRequest, researchRequestSchema } from './workbench';
import { buildPositionManagement, localPositionAdvice, validatePositionAdvice } from '../shared/positionManagement';
import { analyzeWithValidation } from './analysisService';
import { marketAccountClocksMatch } from '../shared/account';
export interface AccountRouterDependencies {account:ReadonlyAccountService;config:ServerConfig;provider:AnalysisProvider;codex:CodexProvider;isCodexBusy:()=>boolean;setCodexBusy:(value:boolean)=>void}
const reviewRequest=z.object({positionId:z.string().max(160),accountSnapshotId:z.string().max(120),linkedPlanId:z.string().max(160).nullable(),research:researchRequestSchema}).strict();
export function createAccountRouter(deps:AccountRouterDependencies){
  const router=Router();
  router.use((request,response,next)=>{
    response.set('Cache-Control','no-store');
    response.set('Pragma','no-cache');
    const host=request.get('host')??'',origin=request.get('origin'),remote=request.socket.remoteAddress??'';
    if(!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)||request.get('sec-fetch-site')==='cross-site'||origin&&origin!==`${request.protocol}://${host}`)return next(new PublicError(403,'ACCOUNT_LOCAL_ONLY','只读账户仅允许本机同源访问；未提供远程或多用户账户服务。'));
    next();
  });
  router.get('/status',(_request,response)=>response.json(deps.account.status()));
  router.post('/connect',async(request,response)=>{if(Object.keys(request.body??{}).length)throw new PublicError(400,'ACCOUNT_CONFIG_SERVER_ONLY','凭据只允许在服务端环境配置；本接口不接收Key或Secret。');response.json(await deps.account.connect());});
  router.post('/refresh',async(_request,response)=>response.json(await deps.account.refresh()));
  router.post('/disconnect',(_request,response)=>response.json(deps.account.disconnect()));
  router.post('/review',async(request,response)=>{
    const body=reviewRequest.safeParse(request.body);if(!body.success)throw new PublicError(400,'POSITION_REVIEW_INVALID','持仓审阅请求或多周期输入无效。');
    const {positionId,accountSnapshotId,linkedPlanId}=body.data;
    const snapshot=deps.account.requireSnapshot(accountSnapshotId),position=snapshot.positions.find(p=>p.id===positionId);
    if(!position||position.validity!=='valid')throw new PublicError(409,'POSITION_UNAVAILABLE','该真实持仓已变化或关键字段不足，请重新同步。');
    let prepared;try{prepared=prepareResearchRequest(body.data.research);}catch{throw new PublicError(400,'POSITION_MARKET_INVALID','持仓的多周期行情未通过现有收盘、聚合或快照校验。');}
    const {input,context}=prepared;
    if(context.bundle.symbol!==position.symbol)throw new PublicError(400,'POSITION_SYMBOL_MISMATCH','请先加载该持仓标的的多周期行情。');
    if(!marketAccountClocksMatch(context.bundle.asOf,snapshot.exchangeTime))throw new PublicError(409,'POSITION_MARKET_STALE','行情与账户时间不一致，不能用历史行情冒充当前持仓背景；请先刷新多周期行情。');
    const original=linkedPlanId?(input.previous.plans??[]).find(p=>p.id===linkedPlanId):null;
    if(linkedPlanId&&!original)throw new PublicError(400,'POSITION_PLAN_UNKNOWN','所选原交易计划不存在，不能自动关联。');
    let management;try{management=buildPositionManagement({symbol:context.bundle.symbol,bundle:context.bundle,version:context.previous.version,facts:context.facts,plans:input.previous.plans??[]},snapshot,position,original??null);}catch{throw new PublicError(400,'POSITION_LINK_INVALID','原计划或持仓关联不符合当前标的与方向。');}
    const selected=input.provider;
    if(selected==='codex'&&deps.isCodexBusy())throw new PublicError(409,'CODEX_BUSY','已有分析进行中，请等待或取消。');
    if(selected==='api'&&!isAIConfigured(deps.config))throw new PublicError(503,'AI_NOT_CONFIGURED','服务端API未配置，不会切换计费来源。');
    const focus=context.bundle.frames['1m'];if(focus.candles.length<10)throw new PublicError(400,'POSITION_DATA_INSUFFICIENT','持仓审阅至少需要10根实际1m数据，缺失周期会明确降级。');
    const controller=new AbortController(),close=()=>{if(!response.writableEnded)controller.abort();};response.once('close',close);
    if(selected==='codex')deps.setCodexBusy(true);
    try{
      const reviewContext={...context,previous:{...context.previous,positions:[],plans:original?[original]:[]}};
      const modelInput:ModelInput={candles:focus.candles,context:{symbol:position.symbol,timeframe:'1m',notes:input.notes},workbench:reviewContext,positionReview:management,visuals:input.images,signal:controller.signal};
      const result=selected==='mock'?{analysis:validatePositionAdvice(localPositionAdvice(management),management),model:'local-position-observation',analysisAttempts:0}:
        await analyzeWithValidation(modelInput,async fixed=>selected==='codex'?deps.codex.analyzeDetailed(fixed,fixed.signal):{analysis:await deps.provider.analyze(fixed),model:deps.config.model},{provider:selected,timeoutMs:selected==='codex'?deps.config.codexTimeoutMs:deps.config.timeoutMs,validate:raw=>validatePositionAdvice(raw,management)});
      const latest=deps.account.status(),staleReasons:string[]=[];
      if(!latest.connected||latest.error||latest.snapshot?.id!==snapshot.id||Date.now()>=snapshot.expiresAt)staleReasons.push('账户快照已变化、过期或连接异常；建议只属于原始输入。');
      response.json({schemaVersion:'position-review-response-1.0',accountSnapshotId:snapshot.id,marketSnapshotId:context.bundle.id,stateVersion:context.previous.version,positionId,linkedPlanId,generatedAt:Date.now(),source:selected==='mock'?'mock':'ai',provider:selected,stale:staleReasons.length>0,staleReasons,preparation:prepared.preparation,...result});
    }finally{response.removeListener('close',close);if(selected==='codex')deps.setCodexBusy(false);}
  });
  router.use((_request,_response,next)=>next(new PublicError(405,'ACCOUNT_READ_ONLY','账户接口不支持该操作；只提供状态、同步、断开和人工审阅。')));
  return router;
}
