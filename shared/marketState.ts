import type { Candle } from './market';
import type { TradeSetup } from './analysis';
import { evaluateTradePlan, type PlanTrackingResult } from './tradeTracking';
import { inspectClosedSnapshot } from './snapshotIntegrity';
import { RESEARCH_FRAMES, contentId, extractFrameFacts, frameRegime, type FrameSnapshot, type ResearchBundle, type ResearchFact, type ResearchFrame } from './researchData';
import { evaluateStrategies, validateStrategyPlan, type StrategyCandidate } from './strategyCatalog';
import type { WorkbenchInterpretation, WorkbenchModelContext } from './workbenchAnalysis';
export interface MarketEvent {id:string;kind:string;knownAt:number;stateVersion:number;reason:string;factIds:string[];planId:string|null;snapshotId:string}
export interface TargetRecord {price:number;source:'structure';structureId:string;timeframe:ResearchFrame;status:'active'|'reference-touched'|'space-consumed'|'needs-review';formedAt:number;updatedAt:number;reason:string}
export interface PlanVersion {version:number;effectiveAt:number;reason:string;eventIds:string[];snapshotIds:Record<ResearchFrame,string>;setup:TradeSetup;targets:TargetRecord[];candidate:StrategyCandidate}
export interface ManagedPlan {id:string;strategyId:StrategyCandidate['strategyId'];scenarioId:string;source:'rule-candidate'|'ai-reviewed';versions:PlanVersion[];tracking:PlanTrackingResult|null;status:string;needsReview:boolean;reviewReasons:string[];targetReview:TargetRecord[]}
export interface ManualPosition {id:string;planId:string;direction:'bullish'|'bearish';entry:number;quantity:number;filledAt:number;recordedAt:number;source:'user-confirmed';status:'open'|'closed';review:string[]}
export interface MarketState {
 schemaVersion:'market-state-1.0';symbol:string;sessionId:string;version:number;updatedAt:number;asOf:number;bundle:ResearchBundle;
 facts:Record<string,{current:boolean;versions:{stateVersion:number;knownAt:number;reason:string;fact:ResearchFact}[]}>;
 interpretation:{basedOnVersion:number;snapshotId:string;source:'ai'|'mock';model:string;updatedAt:number;value:WorkbenchInterpretation}[];
 scenarios:StrategyCandidate[];plans:ManagedPlan[];positions:ManualPosition[];events:MarketEvent[];snapshots:Record<string,FrameSnapshot>;
 history:{version:number;asOf:number;updatedAt:number;reason:string;bundleId:string;frameIds:Record<ResearchFrame,string>}[];
 evaluations:{stateVersion:number;asOf:number;bundleId:string;candidates:StrategyCandidate[]}[];needsReview:string[];capacityReached:boolean;
}
const frameIds=(b:ResearchBundle)=>Object.fromEntries(RESEARCH_FRAMES.map(tf=>[tf,b.frames[tf].id])) as Record<ResearchFrame,string>;
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export function currentFacts(state:MarketState):ResearchFact[]{return Object.values(state.facts).filter(f=>f.current).map(f=>f.versions.at(-1)!.fact);}
export function modelContext(state:MarketState):WorkbenchModelContext {return {bundle:state.bundle,facts:currentFacts(state),candidates:state.scenarios,previous:{version:state.version,interpretation:state.interpretation.at(-1)?.value??null,changes:state.events.slice(-20).map(e=>e.reason),plans:state.plans.slice(-20).map(p=>({id:p.id,status:p.status,version:p.versions.at(-1)!.version,setup:p.versions.at(-1)!.setup,reviewReasons:p.reviewReasons})),positions:state.positions.filter(p=>p.status==='open').slice(-20).map(p=>({id:p.id,planId:p.planId,direction:p.direction,entry:p.entry,quantity:p.quantity,filledAt:p.filledAt,source:p.source,review:p.review}))}};}
function event(state:MarketState,kind:string,reason:string,factIds:string[]=[],planId:string|null=null,knownAt=state.asOf,key=''){
 const id='event-'+contentId([state.sessionId,kind,factIds,planId,knownAt,key]);if(state.events.some(e=>e.id===id))return;
 state.events.push({id,kind,reason,factIds,planId,knownAt,stateVersion:state.version,snapshotId:state.bundle.id});
}
function recordHistory(state:MarketState,reason:string){state.history.push({version:state.version,asOf:state.asOf,updatedAt:state.updatedAt,reason,bundleId:state.bundle.id,frameIds:frameIds(state.bundle)});}
export function updateMarketState(previous:MarketState|null,bundle:ResearchBundle,reason='已收盘行情本地更新',now=Date.now()):MarketState {
 if(previous&&previous.symbol!==bundle.symbol)throw new Error('不能将不同标的继承到同一市场状态。');
 if(previous?.bundle.id===bundle.id)return previous;
 if(previous?.capacityReached)return previous;
 if(previous&&(Object.keys(previous.snapshots).length>=96||previous.events.length>=8000||previous.history.length>=300))return {...previous,capacityReached:true,needsReview:[...new Set([...previous.needsReview,'达到本地会话容量上限，请导出后开始新会话；没有静默删除历史。'])]};
 const next:MarketState=previous?{...previous,version:previous.version+1,updatedAt:now,asOf:bundle.asOf,bundle,facts:{...previous.facts},plans:previous.plans.map(p=>({...p,versions:[...p.versions],reviewReasons:[...p.reviewReasons]})),positions:previous.positions.map(p=>({...p,review:[...p.review]})),events:[...previous.events],snapshots:{...previous.snapshots},history:[...previous.history],evaluations:[...previous.evaluations],needsReview:[]}:
  {schemaVersion:'market-state-1.0',symbol:bundle.symbol,sessionId:'session-'+contentId([bundle.symbol,now]),version:1,updatedAt:now,asOf:bundle.asOf,bundle,facts:{},interpretation:[],scenarios:[],plans:[],positions:[],events:[],snapshots:{},history:[],evaluations:[],needsReview:[],capacityReached:false};
 if(previous&&bundle.asOf<previous.asOf)throw new Error('旧快照不能回滚当前市场状态；请作为独立历史会话载入。');
 for(const tf of RESEARCH_FRAMES){const frame=bundle.frames[tf];next.snapshots[frame.id]=frame;
  if(!frame.integrity.usable)next.needsReview.push(tf+'：'+frame.integrity.reasons.join('；'));
  if(previous){const old=previous.bundle.frames[tf],check=inspectClosedSnapshot(old.candles,frame.candles);
   if(check.revisedBars){const msg=tf+'原始OHLCV被修订或插入，旧解释和计划需重新评估';next.needsReview.push(msg);event(next,'data-revised',msg,[],null,bundle.asOf,tf);}
   const first=frame.candles[0]?.timestamp??Infinity;
   if(old.candles.some(b=>b.timestamp>=first&&b.timestamp<=(frame.lastClosedTime??0)&&!frame.candles.some(c=>c.timestamp===b.timestamp))){next.needsReview.push(tf+'历史内部缺口');event(next,'data-gap',tf+'旧输入内部K线消失，暂停继承解释',[],null,bundle.asOf,tf);}
  }
 }
 const facts=RESEARCH_FRAMES.flatMap(tf=>extractFrameFacts(bundle.frames[tf])),ids=new Set(facts.map(f=>f.id));
 for(const [id,record] of Object.entries(next.facts))if(record.current&&!ids.has(id))next.facts[id]={...record,current:false};
 for(const fact of facts){const record=next.facts[fact.id],last=record?.versions.at(-1)?.fact;
  if(!last||!equal(last,fact)){
   const kind=!last?'fact-added':last.status!==fact.status?fact.status==='resolved'?'fact-resolved':'fact-confirmed':'fact-revised';
   const knownAt=kind==='fact-resolved'?fact.resolvedAt??bundle.asOf:fact.knownAt;
   next.facts[fact.id]={current:true,versions:[...(record?.versions??[]),{stateVersion:next.version,knownAt:bundle.asOf,reason:kind,fact}]};
   if(!last&&fact.confirmedAt!==null)event(next,'fact-confirmed',fact.timeframe+' '+fact.type+'新增可知确认',[fact.id],null,fact.confirmedAt);
   event(next,kind,fact.timeframe+' '+fact.type+' '+(!last?'新增事实':kind==='fact-resolved'?'首次回补/失效':'证据状态更新'),[fact.id],null,Math.min(bundle.asOf,knownAt));
  }else next.facts[fact.id]={...record,current:true};
 }
 next.scenarios=evaluateStrategies(bundle,facts);
 for(const c of next.scenarios){const old=previous?.scenarios.find(p=>p.id===c.id);if(!old||old.stage!==c.stage)event(next,'scenario-'+(bundle.asOf>=c.expiresAt?'expired':c.stage==='conditional'?'eligible':'watching'),c.strategyId+' '+c.direction+' '+(bundle.asOf>=c.expiresAt?'已过期':c.stage==='conditional'?'规则门槛通过，仍为研究候选':'仍有条件未成立'),c.supportIds);}
 for(const c of previous?.scenarios??[])if(!next.scenarios.some(n=>n.id===c.id))event(next,'scenario-superseded','旧情景由新的结构或触发上下文替代，未无限续期',c.supportIds);

 next.evaluations.push({stateVersion:next.version,asOf:bundle.asOf,bundleId:bundle.id,candidates:next.scenarios});
 const meaningful=next.events.filter(e=>e.stateVersion===next.version&&['fact-confirmed','fact-resolved','fact-revised','data-revised','data-gap'].includes(e.kind));
 if(meaningful.length&&next.interpretation.length)next.needsReview.push('结构确认、失效或数据变化值得主动AI复核；未自动调用模型');
 for(const plan of next.plans){const version=plan.versions.at(-1)!,snapshot=next.snapshots[version.snapshotIds['1m']];
  if(!snapshot){plan.needsReview=true;plan.reviewReasons=['缺少原始计划快照'];continue;}
  const merged=new Map(snapshot.candles.map(b=>[b.timestamp,b]));
  for(const f of Object.values(next.snapshots).filter(f=>f.timeframe==='1m').sort((a,b)=>(a.lastClosedTime??0)-(b.lastClosedTime??0)))for(const b of f.candles)if(b.timestamp>=snapshot.candles[0].timestamp)merged.set(b.timestamp,b);
  const currentMinute=bundle.frames['1m'].candles,currentTimes=new Set(currentMinute.map(b=>b.timestamp));
  for(const time of merged.keys())if(time>=(currentMinute[0]?.timestamp??Infinity)&&time<=(currentMinute.at(-1)?.timestamp??0)&&!currentTimes.has(time))merged.delete(time);
  for(const b of currentMinute)merged.set(b.timestamp,b);
  const bars=[...merged.values()].sort((a,b)=>a.timestamp-b.timestamp);
  const oldTracking=plan.tracking;
  const priorCancellation=next.events.filter(e=>e.planId===plan.id&&e.kind==='plan-invalidated').sort((a,b)=>a.knownAt-b.knownAt)[0];
  let trackBars=priorCancellation?bars.filter(b=>b.timestamp+60<=priorCancellation.knownAt):bars;
  plan.tracking=evaluateTradePlan(version.setup,snapshot.candles,trackBars,60);
  const consumedBeforeTrigger=trackBars.filter(b=>b.timestamp>version.setup.anchorTime).find(b=>version.setup.targets.some(t=>version.setup.direction==='bullish'?b.high>=t.price:b.low<=t.price)&&(plan.tracking!.triggeredAt===null||b.timestamp<=plan.tracking!.triggeredAt));
  if(consumedBeforeTrigger){trackBars=trackBars.filter(b=>b.timestamp<=consumedBeforeTrigger.timestamp);plan.tracking=evaluateTradePlan(version.setup,snapshot.candles,trackBars,60);event(next,'plan-invalidated','入场确认完成前目标空间已消耗，停止此候选后续触发',version.setup.basis!.targetStructureIds,plan.id,consumedBeforeTrigger.timestamp+60);}

  if(consumedBeforeTrigger)plan.status='invalidated';
  const dataChanged=next.needsReview.some(r=>/修订|缺口/.test(r));
  plan.status=!dataChanged&&['invalidated','expired','stop-touched','targets-touched','ambiguous'].includes(plan.status)?plan.status:plan.tracking.phase;
  const refs=version.setup.structureIds.map(id=>facts.find(f=>f.id===id));
  plan.reviewReasons=[...new Set([...next.needsReview,...refs.flatMap((f,i)=>!f?'计划依据已超出当前可核验窗口：'+version.setup.structureIds[i]:f.status==='resolved'?'计划结构已失效：'+f.id:[])])];
  const basis=version.setup.basis!,protect=facts.find(f=>f.id===basis.stopStructureId);
  const failedProtection=protect?.status==='resolved';
  const background=frameRegime(facts.filter(f=>f.timeframe==='15m'));
  if((background==='uptrend'&&version.setup.direction==='bearish'||background==='downtrend'&&version.setup.direction==='bullish')&&['waiting','needs-review'].includes(plan.status)){
   plan.status='invalidated';event(next,'plan-invalidated','15m背景已形成相反方向，取消未入场情景',[],plan.id);
  }
  if(failedProtection&&plan.status==='waiting'){plan.status='invalidated';event(next,'plan-invalidated','5m保护结构失效，取消未入场候选',[protect.id],plan.id,protect.resolvedAt??bundle.asOf);}
  if(plan.reviewReasons.length&&['waiting','conditions-met'].includes(plan.status))plan.status='needs-review';
  plan.needsReview=plan.reviewReasons.length>0||plan.status==='needs-review';
  for(const old of oldTracking?.events??[])if(!plan.tracking.events.some(e=>equal(e,old)))event(next,'reference-event-retracted','输入修订或取消边界使先前参考事件不再成立；保留旧记录，不认定成交：'+old.label,[],plan.id,bundle.asOf,version.version+'-'+old.type+'-'+old.time+'-'+(old.targetIndex??''));
  const newEvents=plan.tracking.events.filter(e=>!oldTracking?.events.some(old=>equal(old,e)));
  for(const e of newEvents)event(next,'reference-'+e.type,e.label,[],plan.id,e.time+60,version.version+'-'+e.type+'-'+(e.targetIndex??''));
  const future=bars.filter(b=>b.timestamp>version.setup.anchorTime);
  const targets=version.targets.map((target,i)=>{
   const hit=future.find(b=>version.setup.direction==='bullish'?b.high>=target.price:b.low<=target.price),f=facts.find(f=>f.id===target.structureId);
   const consumed=!!hit&&(plan.tracking!.triggeredAt===null||hit.timestamp<=plan.tracking!.triggeredAt);
   const status:TargetRecord['status']=consumed?'space-consumed':plan.tracking!.targetTimes[i]!==null?'reference-touched':!f||f.status==='resolved'?'needs-review':'active';
   return {...target,status,updatedAt:bundle.asOf,reason:consumed?'条件满足前目标价已被触及，原机会空间已消耗':status==='reference-touched'?'条件满足后的参考目标触及；不表示实际止盈':status==='needs-review'?'目标结构变化或不可核验，保留原价待复核':'原结构目标仍有效'};
  });
  if(targets.some(t=>t.status==='space-consumed')&&['waiting','needs-review'].includes(plan.status)){plan.status='invalidated';event(next,'plan-invalidated','入场条件完成前目标空间已消耗',targets.map(t=>t.structureId),plan.id);}
  // Lifecycle observations are separate from the immutable original target versions.
  if(!equal((plan.targetReview.length?plan.targetReview:version.targets).map(t=>[t.status,t.reason]),targets.map(t=>[t.status,t.reason])))event(next,'target-review',targets.map(t=>t.reason).join('；'),targets.map(t=>t.structureId),plan.id);
  plan.targetReview=targets; // Observations do not overwrite immutable target versions.
  for(const position of next.positions.filter(p=>p.planId===plan.id&&p.status==='open'))position.review=[...new Set([...plan.reviewReasons,...targets.filter(t=>t.status!=='active').map(t=>t.reason),'已记录用户成交；参考价位事件不代表实际减仓、退出或成交。'])];
 }
 recordHistory(next,reason);return next;
}
export function targetObservations(_state:MarketState,plan:ManagedPlan):TargetRecord[]{return plan.targetReview.length?plan.targetReview:plan.versions.at(-1)!.targets;}

export function saveCandidatePlan(state:MarketState,candidateId:string,reason='用户保存规则研究候选',source:ManagedPlan['source']='rule-candidate'):MarketState {
 const candidate=state.scenarios.find(c=>c.id===candidateId);if(!candidate?.setup||candidate.stage!=='conditional')throw new Error('未通过全部规则门槛，不能保存数值计划。');
 validateStrategyPlan(candidate.setup,candidate,state.bundle,currentFacts(state));
 const id=candidate.setup.id+'-'+contentId(state.bundle.id);if(state.plans.some(p=>p.id===id))return state;
 const next={...state,version:state.version+1,updatedAt:Date.now(),plans:[...state.plans],events:[...state.events],history:[...state.history]};
 const targets=candidate.setup.targets.map((t,i)=>{const f=currentFacts(state).find(f=>f.id===candidate.setup!.basis!.targetStructureIds[i])!;return {price:t.price,source:'structure' as const,structureId:f.id,timeframe:f.timeframe,status:'active' as const,formedAt:f.formedAt,updatedAt:state.asOf,reason:'最近真实结构目标；未使用固定百分比或R倍数生成'};});
 next.plans.push({id,strategyId:candidate.strategyId,scenarioId:candidate.scenarioId,source,versions:[{version:1,effectiveAt:state.asOf,reason,eventIds:state.events.filter(e=>e.stateVersion===state.version).map(e=>e.id),snapshotIds:frameIds(state.bundle),setup:candidate.setup,targets,candidate}],tracking:null,status:'waiting',needsReview:false,reviewReasons:[],targetReview:[]});
 event(next,'plan-created',reason,candidate.supportIds,id);recordHistory(next,reason);return next;
}
export function planUpdateProposal(state:MarketState,plan:ManagedPlan):StrategyCandidate|null {
 if(!['waiting','needs-review'].includes(plan.status))return null;
 const old=plan.versions.at(-1)!,c=state.scenarios.find(c=>c.strategyId===plan.strategyId&&c.direction===old.setup.direction&&c.setup&&c.stage==='conditional');
 if(!c?.setup||state.needsReview.some(r=>/修订|缺口/.test(r)))return null;
 const geometry=(s:TradeSetup)=>[s.entry,s.stopLoss,s.targets,s.basis?.stopStructureId,s.basis?.targetStructureIds];
 if(equal(geometry(old.setup),geometry(c.setup)))return null;
 const referenced=[c.setup.basis!.stopStructureId,...c.setup.basis!.targetStructureIds];
 if(!referenced.some(id=>state.facts[id]?.versions.at(-1)!.fact.knownAt>old.effectiveAt))return null;
 return c;
}
export function acceptPlanUpdate(state:MarketState,planId:string):MarketState {
 const plan=state.plans.find(p=>p.id===planId);if(!plan)throw new Error('计划不存在。');const c=planUpdateProposal(state,plan);if(!c?.setup)throw new Error('没有由新结构支持的可接受更新，不能事后移动目标。');
 validateStrategyPlan(c.setup,c,state.bundle,currentFacts(state));
 const temporary=saveCandidatePlan({...state,plans:[]},c.id),fresh=temporary.plans[0].versions[0],reason='用户接受新结构支持的计划更新；旧版本完整保留';
 const next={...state,version:state.version+1,updatedAt:Date.now(),plans:state.plans.map(p=>p.id===planId?{...p,versions:[...p.versions,{...fresh,version:p.versions.length+1,reason}],tracking:null,status:'waiting',needsReview:false,reviewReasons:[]}:p),events:[...state.events],history:[...state.history]};
 event(next,'plan-revision',reason,c.supportIds,planId);recordHistory(next,reason);return next;
}
export function acceptInterpretation(state:MarketState,inputContext:WorkbenchModelContext,value:WorkbenchInterpretation,model:string,source:'ai'|'mock'):MarketState {
 const next={...state,version:state.version+1,updatedAt:Date.now(),interpretation:[...state.interpretation,{basedOnVersion:inputContext.previous.version,snapshotId:inputContext.bundle.id,source,model,updatedAt:Date.now(),value}],events:[...state.events],history:[...state.history],needsReview:[...state.needsReview]};
 if(state.bundle.id!==inputContext.bundle.id)next.needsReview.push('AI审阅期间行情已更新，结果仅属于原快照；未自动采用旧计划');
 event(next,'interpretation-updated',source==='ai'?'AI解释已保存，未改写规则事实':'保存本地未审阅状态',[],null,inputContext.bundle.asOf);recordHistory(next,'保存解释版本');return next;
}
export function recordActualPosition(state:MarketState,planId:string,fill:{entry:number;quantity:number;filledAt:number},now=Date.now()):MarketState {
 const plan=state.plans.find(p=>p.id===planId);if(!plan||![fill.entry,fill.quantity].every(v=>Number.isFinite(v)&&v>0)||!Number.isSafeInteger(fill.filledAt)||fill.filledAt<0||fill.filledAt>Math.floor(now/1000))throw new Error('必须由用户明确提供有效成交价、数量与真实成交时间。');
 const position:ManualPosition={id:'position-'+contentId([planId,fill,now]),planId,direction:plan.versions.at(-1)!.setup.direction,...fill,recordedAt:now,source:'user-confirmed',status:'open',review:['只有用户提交的记录代表持仓；没有交易所账户核验或自动下单。']};
 const next={...state,version:state.version+1,updatedAt:now,positions:[...state.positions,position],events:[...state.events],history:[...state.history]};event(next,'user-position-recorded','用户明确登记实际持仓；候选触发不自动生成持仓',[],planId);recordHistory(next,'用户登记成交');return next;
}
export function exportResearchState(state:MarketState){return {exportVersion:'research-evaluation-1.0',exportedAt:new Date().toISOString(),state,
 semantics:'仅使用已收盘行情；facts确认时间为可知收盘时间。规则评分不是概率。条件满足及参考价位触及不是成交。原始快照、事实版本、策略评估、计划版本与事件完整保存。尚无成本/回撤或策略绩效统计。'};}
