import { STRATEGY_NAMES, type StrategyId } from './strategyTypes';
import { buildStrategyTrigger, type StrategyTriggerSpec } from './strategyTriggers';
import { auditPlanScale, planScaleContext, resolvePlanPolicy, MICRO_PLAN_POLICY, type PlanPolicy } from './planPolicy';
export const STRATEGY_CATALOG_VERSION='catalog-3.0';
import { buildPlanHorizon, protectionBoundary, type PlanHorizon } from './planHorizon';
import { tradeSetupSchema, type TradeSetup } from './analysis';
import { auditStopRisk, tradeRiskContext, STOP_RISK_POLICY } from './tradeRisk';
import { calculateRiskReward } from './tradeGeometry';
import { validateTradeTracking } from './tradeTracking';
import { contentId, RESEARCH_FRAMES, frameRegime, type ResearchBundle, type ResearchFact, type ResearchFrame } from './researchData';

export const STRATEGY_PARAMETERS = Object.freeze({ maximumExtensionAtr:2, maximumWait1mBars:30, maximumLocalConfirmationAgeBars:10, maximumZoneTouchEpisodes:2, maximumPrimaryCandidates:6, maximumTriggerCandidates:3 });
export const STRATEGY_CATALOG = [
  {id:'sweep-reclaim',name:STRATEGY_NAMES['sweep-reclaim'],environment:'背景不反对；转换或区间须说明不确定性',prerequisites:'5m越过已确认极值并同根收复，随后5m反向CHoCH，再由1m结构确认',trigger:'新的1m局部回踩须收盘守住实际扫除收复位，后续收盘越过反向确认K线极值',invalidation:'保护结构失效、缺口或等待超时',targetRule:'前方15m主要目标与5m途中阻挡；通过当前幅度与R门槛，空间不足等待'},
  {id:'bos-retest',name:STRATEGY_NAMES['bos-retest'],environment:'15m趋势匹配，或在区间背景中保留条件假设',prerequisites:'5m收盘BOS、之后实际回踩且收盘守住突破位，随后1m同向结构',trigger:'新的1m回踩突破位附近，后续收盘守住突破位及局部结构，再以更晚收盘越过确认极值',invalidation:'反向收盘失守保护结构、过度延伸或超时',targetRule:'15m主要结构作为TP，5m阻挡单列；1R内主要阻挡未处理时等待'},
  {id:'trend-pullback',name:STRATEGY_NAMES['trend-pullback'],environment:'15m明确同向趋势及主要保护结构',prerequisites:'5m有效区域、形成后回踩与方向收盘反应，随后1m结构确认；反复测试需复核',trigger:'新的1m局部回踩，后续收盘保持已反应FVG/OB方向侧，再收盘越过局部极值',invalidation:'区域回补、5m保护失效、15m背景冲突或超时',targetRule:'最近已确认15m主要结构；途中5m区域需逐段观察反应'},
  {id:'range-reversal',name:STRATEGY_NAMES['range-reversal'],environment:'15m已确认区间，价格位于边缘，避免在区间中部逆势',prerequisites:'区间先于5m扫除/失败突破形成；收盘收复边界且后续反向结构确认',trigger:'1m回踩须收在区间内部，后续越过局部极值时仍位于区间外侧四分之一',invalidation:'15m有效离开区间、5m保护失守或超时',targetRule:'已确认15m区间另一侧主要结构作条件目标，途中阻挡单列，不保证到达'},
  {id:'failed-breakout',name:STRATEGY_NAMES['failed-breakout'],environment:'原BOS后未能延续，15m转换/区间或不反对反转方向',prerequisites:'5m收盘突破后6根内收回原价位，随后反向CHoCH；不把普通回撤当失败',trigger:'1m反向回踩收盘守住失败收回侧，后续收盘越过反向确认极值；保护含真实失败K线外侧',invalidation:'价格重新收盘越过失败突破外侧、保护失守或超时',targetRule:'15m主要结构作目标，保留5m途中阻挡与其失效条件'},
  {id:'displacement-continuation',name:STRATEGY_NAMES['displacement-continuation'],environment:'15m趋势同向，避免强位移末端追价',prerequisites:'5m强实体/ATR与量能扩张、同根收盘BOS、首次25%–75%实体回撤反应',trigger:'首次5m回撤反应后，1m局部回踩、后续守住位移反应区，再以更晚收盘确认延续',invalidation:'位移起点失守、反复回测、过度延伸或超时',targetRule:'15m主要目标与5m检查点；量能与BOS同属位移证据，不重复计分'},
] as const;
export type { StrategyId } from './strategyTypes';
export interface StrategyCheck {key:string;label:string;passed:boolean;weight:number;awarded:number;reason:string;evidenceIds:string[]}
export interface CandidateAlternative {
 primaryFactId:string; localFactId:string|null; stage:'watching'|'conditional'; score:number;
 reason:string; entry:number|null; stopLoss:number|null; target:number|null;
}
export interface CandidateSelection {
 considered:number; eligible:number; selectedPrimaryId:string|null; reason:string; alternatives:CandidateAlternative[];
}
export interface StrategyCandidate {
 horizon?:PlanHorizon; primaryFactId?:string; triggerSpec?:StrategyTriggerSpec; selection?:CandidateSelection;
 planPolicy?:PlanPolicy;id:string;strategyId:StrategyId;direction:'bullish'|'bearish';scenarioId:string;stage:'watching'|'conditional';score:number;
 snapshotId:string;asOf:number;checks:StrategyCheck[];supportIds:string[];oppositionIds:string[];eventGroups:string[];
 conflicts:string[];uncertainties:string[];sourceByFrame:Record<ResearchFrame,string[]>;setup:TradeSetup|null;
 expiresAt:number;triggerObservedAt:number|null;proposalReason:string;
}
const same=(a:number,b:number)=>Math.abs(a-b)<=Math.max(Number.MIN_VALUE,Math.abs(b)*Number.EPSILON*8);
const usable=(fact:ResearchFact)=>fact.status!=='resolved';
const latest=(facts:ResearchFact[])=>[...facts].sort((a,b)=>b.knownAt-a.knownAt||Number(b.importance==='major')-Number(a.importance==='major')||a.id.localeCompare(b.id))[0];
export function validateStrategyPlan(setup:TradeSetup,candidate:StrategyCandidate,bundle:ResearchBundle,facts:ResearchFact[]) {
 tradeSetupSchema.parse(setup);
 if(setup.strategyId!==undefined&&setup.strategyId!==null&&setup.strategyId!==candidate.strategyId)throw new Error('计划策略归类与候选不一致。');
 const entries=new Map(facts.map(f=>[f.id,f])),basis=setup.basis;
 if(!basis||basis.scenarioId!==candidate.scenarioId||setup.id!==candidate.id+'-plan'||setup.anchorTime!==bundle.frames['1m'].lastClosedTime)throw new Error('策略计划与情景或1m快照锚点不一致。');
 if(RESEARCH_FRAMES.some(tf=>!bundle.frames[tf].integrity.usable||!candidate.sourceByFrame[tf].length))throw new Error('完整计划需要三个有效周期的真实依据。');
 if(new Set(setup.structureIds).size!==setup.structureIds.length||setup.structureIds.some(id=>!entries.has(id)))throw new Error('策略计划存在重复或未知结构引用。');
 const ids=[basis.entryStructureId,basis.stopStructureId,...basis.targetStructureIds];
 if(ids.some(id=>!setup.structureIds.includes(id)||!usable(entries.get(id)!)))throw new Error('计划引用的价位锚点缺失或已经失效。');
 const entry=entries.get(basis.entryStructureId)!,stop=entries.get(basis.stopStructureId)!;
 if(entry.timeframe!=='1m'||stop.timeframe!=='5m'||!['HL','LL','LH','HH','FVG','OB'].includes(stop.type))throw new Error('入场须引用1m结构，保护须引用5m价位结构。');
 if(facts.some(f=>setup.structureIds.includes(f.id)&&f.knownAt>bundle.asOf))throw new Error('不能引用快照之后才可知的结构。');
 const scale=auditPlanScale(setup,bundle.frames['5m'].candles,candidate.planPolicy??MICRO_PLAN_POLICY);if(scale.errors.length)throw new Error(scale.errors.join(' '));
 if(candidate.planPolicy?.profile==='structural'&&stop.importance!=='major')throw new Error('结构波段模式需要5m主要保护结构，不能用局部小摆点代替。');
 const sign=setup.direction==='bullish'?1:-1;
 if((setup.entry-setup.stopLoss)*sign<=0||setup.targets.some((t,i)=>(t.price-setup.entry)*sign<=0||i>0&&(t.price-setup.targets[i-1].price)*sign<=0))throw new Error('策略止损或目标方向、顺序错误。');
 const vol=tradeRiskContext(bundle.frames['1m'].candles),pad=vol.atr===null?0:vol.atr*.25;
 if(setup.entry<entry.low-pad||setup.entry>entry.high+pad)throw new Error('入场偏离真实1m结构。');
 for(const frame of ['1m','5m'] as const){const audit=auditStopRisk(setup,bundle.frames[frame].candles,stop);if(audit.errors.length)throw new Error(frame+' '+audit.errors.join(' '));}
 if(calculateRiskReward(setup).ratio<1)throw new Error('真实首目标空间不足1R，不能压紧止损凑单。');
 if(basis.targetStructureIds.length!==setup.targets.length)throw new Error('目标依据数量不匹配。');
 setup.targets.forEach((target,i)=>{const f=entries.get(basis.targetStructureIds[i])!;if(!['5m','15m'].includes(f.timeframe)||!['HH','LH','HL','LL','liquidity-high','liquidity-low'].includes(f.type)||target.price<f.low&&!same(target.price,f.low)||target.price>f.high&&!same(target.price,f.high))throw new Error('目标须引用真实5m/15m结构价位。');});
 if(candidate.horizon){
  const expected=buildPlanHorizon(bundle,facts,setup.direction,setup.entry,setup.stopLoss,candidate.planPolicy??MICRO_PLAN_POLICY);
  if(JSON.stringify(expected)!==JSON.stringify(candidate.horizon)||expected.status!=='open'||JSON.stringify(expected.objectives.map(t=>t.structureId))!==JSON.stringify(basis.targetStructureIds))throw new Error('目标周期、途中阻挡或15m目标路径与快照不一致。');
  const primary=candidate.primaryFactId?entries.get(candidate.primaryFactId):undefined;
  if(primary){const boundary=protectionBoundary(bundle,primary,setup.direction);if(setup.direction==='bullish'?stop.low>boundary:stop.high<boundary)throw new Error('5m止损结构未保护策略事件的真实外侧。');}
 }
 const prices=[...bundle.frames['1m'].candles.flatMap(b=>[b.high,b.low]),...(candidate.triggerSpec?setup.structureIds.flatMap(id=>{const f=entries.get(id)!;return [f.low,f.high];}):[])],span=Math.max(...prices)-Math.min(...prices),padRange=Math.max(span,setup.entry*.005)*3;
 validateTradeTracking(setup,Math.max(Number.MIN_VALUE,Math.min(...prices)-padRange),Math.max(...prices)+padRange);
 if(!setup.tracking||setup.tracking.steps.length<2)throw new Error('策略触发必须有分开的回踩与后续收盘步骤。');
 if(candidate.triggerSpec){
  const primary=candidate.primaryFactId?entries.get(candidate.primaryFactId):undefined;
  if(!primary||candidate.triggerSpec.strategyId!==candidate.strategyId)throw new Error('策略触发缺少一致的起源结构。');
  const triggerFacts=candidate.triggerSpec.evidenceIds.map(id=>entries.get(id));
  if(triggerFacts.some(f=>!f||f.knownAt>bundle.asOf||!setup.structureIds.includes(f.id)))throw new Error('策略触发引用未知或尚不可知的条件依据。');
  const expectedExpiry=Math.max(1,Math.min(STRATEGY_PARAMETERS.maximumWait1mBars,Math.floor((candidate.expiresAt-bundle.asOf)/60)));
  const range=latest(triggerFacts.filter((f):f is ResearchFact=>!!f&&f.type==='trading-range'));
  const reaction=latest(triggerFacts.filter((f):f is ResearchFact=>!!f&&f.timeframe==='5m'&&f.type==='CHoCH'&&f.id!==primary.id));
  const expected=buildStrategyTrigger({strategyId:candidate.strategyId,direction:setup.direction,primary,local:entry,range,reaction,bundle,facts,stop,expiresAfterBars:expectedExpiry});
  if(!expected.spec||JSON.stringify(expected.spec)!==JSON.stringify(candidate.triggerSpec)||JSON.stringify(setup.tracking)!==JSON.stringify(expected.spec.tracking)||setup.trigger!==expected.spec.summary)
    throw new Error('策略专属触发条件与真实结构或当前快照不一致，不能替换为通用或任意价位条件。');
 }

 return setup;
}
export function evaluateStrategies(bundle:ResearchBundle,facts:ResearchFact[],requestedPolicy?:PlanPolicy):StrategyCandidate[] {
 const policy=resolvePlanPolicy(requestedPolicy);
 const by=(tf:ResearchFrame)=>facts.filter(f=>f.timeframe===tf&&f.knownAt<=bundle.asOf);
 const bg=by('15m'),structure=by('5m'),trigger=by('1m'),regime=frameRegime(bg);
 const bgDirection=regime==='uptrend'?'bullish':regime==='downtrend'?'bearish':null;
 const background=latest(bg.filter(f=>['BOS','CHoCH'].includes(f.type)&&usable(f)));
 const candidates:StrategyCandidate[]=[];
 for(const strategy of STRATEGY_CATALOG)for(const direction of ['bullish','bearish'] as const){
  const primaryPool=structure.filter(f=>f.direction===direction&&usable(f)&&(strategy.id==='sweep-reclaim'?f.type==='sweep':strategy.id==='bos-retest'?f.type==='BOS':strategy.id==='trend-pullback'?['FVG','OB'].includes(f.type):strategy.id==='range-reversal'?['sweep','failed-breakout'].includes(f.type):strategy.id==='failed-breakout'?f.type==='failed-breakout':f.type==='displacement'))
    .sort((a,b)=>b.knownAt-a.knownAt||Number(b.importance==='major')-Number(a.importance==='major')||a.id.localeCompare(b.id));
  const primaries=primaryPool.filter((f,i,a)=>a.findIndex(x=>x.id===f.id)===i).slice(0,STRATEGY_PARAMETERS.maximumPrimaryCandidates);
  const localPool=trigger.filter(f=>['BOS','CHoCH'].includes(f.type)&&f.direction===direction&&f.status==='confirmed'&&bundle.asOf-f.knownAt<=STRATEGY_PARAMETERS.maximumLocalConfirmationAgeBars*60)
    .sort((a,b)=>b.knownAt-a.knownAt||a.id.localeCompare(b.id)).filter((f,i,a)=>a.findIndex(x=>x.id===f.id)===i).slice(0,STRATEGY_PARAMETERS.maximumTriggerCandidates);
  const evaluatePrimary=(primary:ResearchFact|undefined,preferredLocal?:ResearchFact):StrategyCandidate=>{
  const seed=contentId([STRATEGY_CATALOG_VERSION,primary?.id??'none',policy]);
  const range=latest(bg.filter(f=>f.type==='trading-range'&&f.status==='confirmed'&&f.confirmedAt!==null&&f.knownAt<(primary?.formedAt??0)));
  const candidateBackground=strategy.id==='range-reversal'?range:background;
  const candidate:StrategyCandidate={primaryFactId:primary?.id,planPolicy:policy,id:strategy.id+'-'+direction+'-'+seed,strategyId:strategy.id,direction,scenarioId:'scenario-'+strategy.id+'-'+direction+'-'+seed,
    snapshotId:bundle.id,asOf:bundle.asOf,stage:'watching',score:0,checks:[],supportIds:[],oppositionIds:[],eventGroups:[],conflicts:[],uncertainties:[],
    sourceByFrame:{'15m':candidateBackground?[candidateBackground.id]:[],'5m':primary?[primary.id]:[],'1m':[]},setup:null,expiresAt:bundle.asOf+30*60,triggerObservedAt:null,proposalReason:'等待结构条件'};
  const check=(key:string,label:string,passed:boolean,weight:number,reason:string,refs:ResearchFact[]=[])=>candidate.checks.push({key,label,passed,weight,awarded:0,reason,evidenceIds:refs.map(f=>f.id)});
  check('data','三个周期数据完整',RESEARCH_FRAMES.every(tf=>bundle.frames[tf].integrity.usable),0,RESEARCH_FRAMES.flatMap(tf=>bundle.frames[tf].integrity.reasons.map(r=>tf+' '+r)).join('；')||'三个周期均为有效已收盘快照');
  const aligned=strategy.id==='range-reversal'?!!range&&bgDirection===null:['trend-pullback','displacement-continuation'].includes(strategy.id)?bgDirection===direction:background!==undefined&&(bgDirection===null||bgDirection===direction);
  check('background','15m背景匹配',aligned,2,aligned?regime+'背景未反对本情景':'缺少可解释的15m背景或方向冲突',candidateBackground?[candidateBackground]:[]);
  if(bgDirection&&bgDirection!==direction){candidate.conflicts.push('15m趋势与局部候选方向相反');if(background)candidate.oppositionIds.push(background.id);}
  if(!bgDirection)candidate.uncertainties.push('15m为区间或转换，方向延续需要额外确认');
  let reactionTime:number|null=null;let reaction:ResearchFact|undefined;
  if(primary){
   if(strategy.id==='sweep-reclaim'){
    reaction=latest(structure.filter(f=>f.type==='CHoCH'&&f.direction===direction&&f.status==='confirmed'&&f.knownAt>(primary.reclaimTime??Infinity)));
    reactionTime=reaction?.knownAt??null;
    check('structure','5m扫除、收复及反向结构',primary.reclaimTime!==null&&reaction!==undefined,3,primary.reclaimTime===null?'越界尚未收复，不能称为反转':'收复后仍须5m反向CHoCH',reaction?[primary,reaction]:[primary]);
   }else if(strategy.id==='bos-retest'){
    const bars=bundle.frames['5m'].candles.filter(b=>b.timestamp>=primary.knownAt&&b.timestamp+300<=bundle.asOf);
    const hit=bars.find(b=>b.low<=primary.low&&b.high>=primary.high&&(direction==='bullish'?b.close>primary.high:b.close<primary.low));
    reactionTime=hit?hit.timestamp+300:null;
    check('structure','5m收盘BOS与后续回踩守位',primary.confirmedAt!==null&&hit!==undefined,3,hit?'回踩根已相交并收在突破外侧':'尚未出现突破后的有效回踩收盘',[primary]);
   }else if(strategy.id==='range-reversal'){
    const edge=range&&(direction==='bullish'?primary.low<=range.low+(range.high-range.low)*.15:primary.high>=range.high-(range.high-range.low)*.15),closed=bundle.frames['5m'].candles.find(b=>b.timestamp+300===(primary.reclaimTime??primary.failureTime));
    reaction=latest(structure.filter(f=>f.type==='CHoCH'&&f.direction===direction&&f.confirmedAt!==null&&f.knownAt>=(primary.reclaimTime??primary.failureTime??Infinity)));
    reactionTime=reaction?.knownAt??null;
    const recovered=!!closed&&!!range&&closed.close>range.low&&closed.close<range.high;
    check('structure','区间边缘扫除/失败突破后收复与反向确认',!!edge&&recovered&&!!reaction,3,!edge?'没有已确认区间边缘证据':!recovered?'越界尚未收回区间':'收回后等待反向CHoCH',range?[range,primary,...(reaction?[reaction]:[])]:[primary]);
   }else if(strategy.id==='failed-breakout'){
    reactionTime=primary.confirmedAt;
    check('structure','BOS失败收回及反向CHoCH',primary.failureTime!==undefined&&primary.confirmedAt!==null,3,primary.confirmedAt?'失败突破与反向CHoCH均已可知':'只收回价位，尚缺反向CHoCH',[primary]);
   }else if(strategy.id==='displacement-continuation'){
    reactionTime=primary.reactionTime;
    check('structure','强位移、量能与首次回撤反应',primary.confirmedAt!==null&&primary.reactionTime!==null&&primary.tests===1,3,primary.tests>1?'已经多次回撤，不能冒充首次机会':primary.reactionTime?'首轮回撤已出现方向收盘反应':'需位移之后的首轮真实回撤反应',[primary]);
   }else{
    reactionTime=primary.reactionTime;
    check('structure','5m有效区域及回撤反应',primary.reactionTime!==null&&primary.tests<=STRATEGY_PARAMETERS.maximumZoneTouchEpisodes,3,primary.tests>STRATEGY_PARAMETERS.maximumZoneTouchEpisodes?'区域被反复测试，需要人工复核':primary.reactionTime?'形成后发生相交与方向收盘反应':'仅存在或触及区域，缺少方向反应',[primary]);
   }
  }else check('structure','5m机会结构',false,3,'尚无符合策略定义的5m结构');
  const currentFive=latest(structure.filter(f=>['BOS','CHoCH'].includes(f.type)&&f.status==='confirmed'));
  const opposingFive=!!currentFive&&currentFive.direction!==direction&&currentFive.knownAt>(primary?.knownAt??0);
  check('current-five','最新5m结构未反对机会',!opposingFive,0,opposingFive?'存在更晚的反向5m结构，旧区域或BOS不足以继续成立':'未观察到更晚的反向5m结构',currentFive?[currentFive]:[]);
  if(opposingFive){candidate.conflicts.push('较新的5m反向结构尚未收复');candidate.oppositionIds.push(currentFive!.id);}
  if(reaction)candidate.sourceByFrame['5m'].push(reaction.id);
  if(primary?.relatedIds)candidate.sourceByFrame['5m'].push(...primary.relatedIds.filter(id=>facts.some(f=>f.id===id)));
  const local=preferredLocal&&preferredLocal.knownAt>=(reactionTime??Infinity)?preferredLocal:undefined;
  candidate.id += '-'+contentId(local?.id??'pending');candidate.scenarioId='scenario-'+candidate.id;
  candidate.expiresAt=(local?.knownAt??primary?.knownAt??bundle.asOf)+STRATEGY_PARAMETERS.maximumWait1mBars*60;
  check('validity','情景仍在等待期限内',bundle.asOf<candidate.expiresAt,0,'由实际结构确认时间起最多30根1m；新行情不会无限续期');
  const currentOne=latest(trigger.filter(f=>['BOS','CHoCH'].includes(f.type)&&f.status==='confirmed'));
  const opposingOne=!!currentOne&&currentOne.direction!==direction&&currentOne.knownAt>(local?.knownAt??0);
  check('current-one','1m确认仍是当前结构',!opposingOne,0,opposingOne?'旧同向触发后已有新的反向确认，等待重新收复':'局部确认之后未观察到新的反向结构',currentOne?[currentOne]:[]);
  if(opposingOne){candidate.conflicts.push('1m触发依据之后出现更晚的反向结构');candidate.oppositionIds.push(currentOne!.id);}
  candidate.triggerObservedAt=local?.knownAt??null;if(local)candidate.sourceByFrame['1m'].push(local.id);
  check('trigger','1m后续结构确认',!!local&&bundle.asOf-local.knownAt<=STRATEGY_PARAMETERS.maximumLocalConfirmationAgeBars*60,2,local?'局部结构已确认；这不是成交，数值计划仍等待新的回踩及随后收盘':'需要5m反应之后的1m结构确认',local?[local]:[]);
  const protectiveTypes=direction==='bullish'?['HL','LL']:['LH','HH'];
  const entry=local?.low;
  if(strategy.id==='range-reversal'){const located=!!range&&entry!==undefined&&(direction==='bullish'?entry<=range.low+(range.high-range.low)*.25:entry>=range.high-(range.high-range.low)*.25);check('range-location','入场仍在区间外侧四分之一',located,0,located?'参考触发仍在区间边缘':'当前触发已到区间中部，不做机械摸顶摸底',range?[range]:[]);}
  const protective=structure.filter(f=>protectiveTypes.includes(f.type)&&f.status==='confirmed'&&usable(f)&&f.knownAt<=bundle.asOf&&(policy.profile!=='structural'||f.importance==='major')&&entry!==undefined&&(direction==='bullish'?f.low<entry:f.high>entry)&&!bundle.frames['5m'].candles.some(b=>b.timestamp>=f.knownAt&&(direction==='bullish'?b.close<f.low:b.close>f.high))).sort((a,b)=>b.knownAt-a.knownAt);
  const eventBoundary=primary?protectionBoundary(bundle,primary,direction):entry;
  const stop=protective.filter(f=>eventBoundary!==undefined&&(direction==='bullish'?f.low<=eventBoundary:f.high>=eventBoundary)).sort((a,b)=>Math.abs(a.low-(entry??0))-Math.abs(b.low-(entry??0))||b.knownAt-a.knownAt).find(f=>{const atr=tradeRiskContext(bundle.frames['5m'].candles).atr;if(atr===null||entry===undefined)return false;const loss=direction==='bullish'?f.low-atr*.25:f.high+atr*.25;const scale=planScaleContext(bundle.frames['5m'].candles,policy,entry);return Math.abs(entry-loss)>=scale.minimumRiskDistance;});
  const majorProtection=latest(bg.filter(f=>protectiveTypes.includes(f.type)&&f.status==='confirmed'&&f.importance==='major'));
  if(majorProtection)candidate.sourceByFrame['15m'].push(majorProtection.id);
  check('protection','5m结构保护'+(strategy.id==='trend-pullback'?'与15m主要保护':''),!!stop&&(strategy.id!=='trend-pullback'||!!majorProtection),1,stop?'保护价格来自实际5m摆点':'缺少有效5m保护结构',stop?[stop]:[]);
  if(stop)candidate.sourceByFrame['5m'].push(stop.id);
  const volatility=tradeRiskContext(bundle.frames['5m'].candles).atr;
  const last=bundle.frames['1m'].candles.at(-1)?.close;
  const extended=entry!==undefined&&last!==undefined&&volatility!==null&&Math.abs(last-entry)>volatility*STRATEGY_PARAMETERS.maximumExtensionAtr;
  check('extension','入场尚未过度延伸',entry!==undefined&&!extended,1,extended?'当前价格离1m参考位超过2倍5m ATR，等待新结构':'2倍5m ATR为未经回测的项目延伸过滤参数');
  if(extended)candidate.conflicts.push('当前价格已远离参考触发区');
  const stopPrice=stop&&volatility!==null?(direction==='bullish'?stop.low-volatility*STOP_RISK_POLICY.minimumStructureBufferAtr:stop.high+volatility*STOP_RISK_POLICY.minimumStructureBufferAtr):null;
  if(entry!==undefined&&stopPrice!==null)candidate.horizon=buildPlanHorizon(bundle,facts,direction,entry,stopPrice,policy);
  const targets=(candidate.horizon?.objectives??[]).map(level=>facts.find(f=>f.id===level.structureId)!).filter(Boolean);
  if(candidate.horizon?.status!=='open'&&candidate.horizon)candidate.proposalReason=candidate.horizon.reason;
  if(local&&stop&&volatility!==null&&volatility>0&&targets.length){
   const stopLoss=direction==='bullish'?stop.low-volatility*STOP_RISK_POLICY.minimumStructureBufferAtr:stop.high+volatility*.25;
   const triggerResult=primary?buildStrategyTrigger({strategyId:strategy.id,direction,primary,local,range,reaction,bundle,facts,stop,
    expiresAfterBars:Math.max(1,Math.min(STRATEGY_PARAMETERS.maximumWait1mBars,Math.floor((candidate.expiresAt-bundle.asOf)/60)))}):{spec:null,reason:'缺少策略起源结构'};
   if(triggerResult.spec){
    candidate.triggerSpec=triggerResult.spec;
    for(const id of triggerResult.spec.evidenceIds){const fact=facts.find(f=>f.id===id);if(fact&&!candidate.sourceByFrame[fact.timeframe].includes(id))candidate.sourceByFrame[fact.timeframe].push(id);}
   }
   const ids=[...new Set([...candidate.sourceByFrame['15m'],...candidate.sourceByFrame['5m'],...candidate.sourceByFrame['1m'],...targets.map(f=>f.id)])];
   // Existing Schema 1.5 geometry/tracking contract; the builder supplies strategy-specific future conditions.
   const setup:TradeSetup={strategyId:strategy.id,id:candidate.id+'-plan',opportunityId:null,direction,status:'candidate',anchorTime:bundle.frames['1m'].lastClosedTime!,entry:entry!,stopLoss,
    targets:targets.map(f=>({price:direction==='bullish'?f.low:f.high,label:f.timeframe+' '+f.type+(f.importance==='major'?'主要结构目标':'结构目标')})),structureIds:ids.slice(0,12),basis:{scenarioId:candidate.scenarioId,entryStructureId:local.id,stopStructureId:stop.id,targetStructureIds:targets.map(f=>f.id)},
    trigger:triggerResult.spec?.summary??triggerResult.reason,
    tracking:triggerResult.spec?.tracking??null,
    rationale:strategy.name+'；'+(policy.profile==='structural'?'结构波段幅度偏好':'局部短线幅度偏好')+'；15m背景、5m保护与反应、1m触发分别承担不同职责。'+(policy.profile==='structural'?'TP采用15m主要目标；5m途中阻挡独立保留，不与最终目标混同。':'局部短线以最近实际结构为目标，不冒充15m波段。')+'目标可达性需逐段验证。',invalidation:'等待期间5m保护失守、15m背景冲突、数据修订/缺口或30根1m等待结束则取消或复核。'};
   try{if(candidate.horizon?.status!=='open')throw new Error(candidate.horizon?.reason??'目标路径不完整');if(!triggerResult.spec)throw new Error(triggerResult.reason);validateStrategyPlan(setup,candidate,bundle,facts);candidate.setup=setup;candidate.proposalReason='策略专属触发、价位及ATR缓冲校验通过，仍为待触发研究候选';}
   catch(error){candidate.proposalReason=error instanceof Error?error.message:'计划校验失败';}
  }
  check('geometry','保护与真实首目标空间',candidate.setup!==null,1,candidate.proposalReason,targets);
  candidate.supportIds=[...new Set(candidate.checks.filter(c=>c.passed).flatMap(c=>c.evidenceIds))];
  candidate.eventGroups=[...new Set(facts.filter(f=>candidate.supportIds.includes(f.id)).map(f=>f.familyId))].sort();
  const credited=new Set<string>();
  for(const item of [...candidate.checks].sort((a,b)=>b.weight-a.weight)){
   const groups=[...new Set(item.evidenceIds.map(id=>facts.find(f=>f.id===id)?.familyId??id))];
   if(item.passed&&!groups.some(group=>credited.has(group))){item.awarded=item.weight;groups.forEach(group=>credited.add(group));}
  }
  candidate.score=candidate.checks.reduce((n,c)=>n+c.awarded,0);
  if(candidate.checks.every(c=>c.passed)&&candidate.setup)candidate.stage='conditional';else candidate.setup=null;
  return candidate;
  };
  const attempted=(primaries.length?primaries:[undefined]).flatMap(primary=>
    primary&&localPool.length?localPool.map(local=>evaluatePrimary(primary,local)):[evaluatePrimary(primary)]);
  const reviewed=attempted.filter((c,i,a)=>a.findIndex(other=>other.id===c.id)===i);
  // Compare real objectives at the requested horizon; nearer obstacles are retained in the route.
  const span=(c:StrategyCandidate)=>c.setup?Math.abs(c.setup.targets[0].price-c.setup.entry)/c.setup.entry:0;
  const distance=(c:StrategyCandidate)=>c.setup?Math.abs((bundle.frames['1m'].candles.at(-1)?.close??c.setup.entry)-c.setup.entry):Infinity;
  reviewed.sort((a,b)=>Number(b.stage==='conditional')-Number(a.stage==='conditional')||b.score-a.score||span(b)-span(a)||distance(a)-distance(b)||(b.triggerObservedAt??0)-(a.triggerObservedAt??0)||a.id.localeCompare(b.id));
  const selected=reviewed[0],eligible=reviewed.filter(c=>c.stage==='conditional').length;
  selected.selection={considered:reviewed.length,eligible,selectedPrimaryId:selected.primaryFactId??null,
    reason:'每方向最多检查6个5m机会结构与3个1m确认；本次比较'+reviewed.length+'组真实结构组合，'+eligible+'组通过全部门槛；按条件通过、独立证据符合度、真实首目标空间、入场距离和确认时间依次选择。空间不足不改价。',
    alternatives:reviewed.slice(1).map(c=>({primaryFactId:c.primaryFactId??'',localFactId:c.sourceByFrame['1m'][0]??null,stage:c.stage,score:c.score,
      reason:c.stage==='conditional'?'同样合格，按公开排序保留为备选':c.checks.find(check=>!check.passed)?.reason??c.proposalReason,
      entry:c.setup?.entry??null,stopLoss:c.setup?.stopLoss??null,target:c.setup?.targets[0]?.price??null}))};
  candidates.push(selected);
 }
 return candidates.sort((a,b)=>Number(b.stage==='conditional')-Number(a.stage==='conditional')||b.score-a.score||a.id.localeCompare(b.id));
}
