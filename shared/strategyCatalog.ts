import { tradeSetupSchema, type TradeSetup } from './analysis';
import { auditStopRisk, tradeRiskContext, STOP_RISK_POLICY } from './tradeRisk';
import { calculateRiskReward } from './tradeGeometry';
import { validateTradeTracking } from './tradeTracking';
import { contentId, RESEARCH_FRAMES, frameRegime, type ResearchBundle, type ResearchFact, type ResearchFrame } from './researchData';

export const STRATEGY_PARAMETERS = Object.freeze({ maximumExtensionAtr:2, maximumWait1mBars:30, maximumLocalConfirmationAgeBars:10, maximumZoneTouchEpisodes:2 });
export const STRATEGY_CATALOG = [
  {id:'sweep-reclaim',name:'A · 流动性扫除与结构收复',environment:'背景不反对；转换或区间须说明不确定性',prerequisites:'5m越过已确认极值并同根收复，随后5m反向CHoCH，再由1m结构确认',trigger:'新的1m回踩与随后收盘确认',invalidation:'保护结构失效、缺口或等待超时',targetRule:'前方最近有效5m/15m极值；首目标空间不足1R则等待'},
  {id:'bos-retest',name:'B · BOS突破与回踩延续',environment:'15m趋势匹配，或在区间背景中保留条件假设',prerequisites:'5m收盘BOS、之后实际回踩且收盘守住突破位，随后1m同向结构',trigger:'新的1m回踩与随后收盘确认',invalidation:'反向收盘失守保护结构、过度延伸或超时',targetRule:'有效结构极值，不能跳过近端阻挡只取远端目标'},
  {id:'trend-pullback',name:'C · 趋势回撤与FVG/OB',environment:'15m明确同向趋势及主要保护结构',prerequisites:'5m有效区域、形成后回踩与方向收盘反应，随后1m结构确认；反复测试需复核',trigger:'等待1m再次回踩及方向收盘',invalidation:'区域回补、5m保护失效、15m背景冲突或超时',targetRule:'最近有依据的5m/15m结构；15m远端目标只是条件目标'},
] as const;
export type StrategyId = typeof STRATEGY_CATALOG[number]['id'];
export interface StrategyCheck {key:string;label:string;passed:boolean;weight:number;awarded:number;reason:string;evidenceIds:string[]}
export interface StrategyCandidate {
 id:string;strategyId:StrategyId;direction:'bullish'|'bearish';scenarioId:string;stage:'watching'|'conditional';score:number;
 snapshotId:string;asOf:number;checks:StrategyCheck[];supportIds:string[];oppositionIds:string[];eventGroups:string[];
 conflicts:string[];uncertainties:string[];sourceByFrame:Record<ResearchFrame,string[]>;setup:TradeSetup|null;
 expiresAt:number;triggerObservedAt:number|null;proposalReason:string;
}
const same=(a:number,b:number)=>Math.abs(a-b)<=Math.max(Number.MIN_VALUE,Math.abs(b)*Number.EPSILON*8);
const usable=(fact:ResearchFact)=>fact.status!=='resolved';
const latest=(facts:ResearchFact[])=>[...facts].sort((a,b)=>b.knownAt-a.knownAt||Number(b.importance==='major')-Number(a.importance==='major'))[0];
export function validateStrategyPlan(setup:TradeSetup,candidate:StrategyCandidate,bundle:ResearchBundle,facts:ResearchFact[]) {
 tradeSetupSchema.parse(setup);
 const entries=new Map(facts.map(f=>[f.id,f])),basis=setup.basis;
 if(!basis||basis.scenarioId!==candidate.scenarioId||setup.id!==candidate.id+'-plan'||setup.anchorTime!==bundle.frames['1m'].lastClosedTime)throw new Error('策略计划与情景或1m快照锚点不一致。');
 if(RESEARCH_FRAMES.some(tf=>!bundle.frames[tf].integrity.usable||!candidate.sourceByFrame[tf].length))throw new Error('完整计划需要三个有效周期的真实依据。');
 if(new Set(setup.structureIds).size!==setup.structureIds.length||setup.structureIds.some(id=>!entries.has(id)))throw new Error('策略计划存在重复或未知结构引用。');
 const ids=[basis.entryStructureId,basis.stopStructureId,...basis.targetStructureIds];
 if(ids.some(id=>!setup.structureIds.includes(id)||!usable(entries.get(id)!)))throw new Error('计划引用的价位锚点缺失或已经失效。');
 const entry=entries.get(basis.entryStructureId)!,stop=entries.get(basis.stopStructureId)!;
 if(entry.timeframe!=='1m'||stop.timeframe!=='5m'||!['HL','LL','LH','HH','FVG','OB'].includes(stop.type))throw new Error('入场须引用1m结构，保护须引用5m价位结构。');
 if(facts.some(f=>setup.structureIds.includes(f.id)&&f.knownAt>bundle.asOf))throw new Error('不能引用快照之后才可知的结构。');
 const sign=setup.direction==='bullish'?1:-1;
 if((setup.entry-setup.stopLoss)*sign<=0||setup.targets.some((t,i)=>(t.price-setup.entry)*sign<=0||i>0&&(t.price-setup.targets[i-1].price)*sign<=0))throw new Error('策略止损或目标方向、顺序错误。');
 const vol=tradeRiskContext(bundle.frames['1m'].candles),pad=vol.atr===null?0:vol.atr*.25;
 if(setup.entry<entry.low-pad||setup.entry>entry.high+pad)throw new Error('入场偏离真实1m结构。');
 for(const frame of ['1m','5m'] as const){const audit=auditStopRisk(setup,bundle.frames[frame].candles,stop);if(audit.errors.length)throw new Error(frame+' '+audit.errors.join(' '));}
 if(calculateRiskReward(setup).ratio<1)throw new Error('真实首目标空间不足1R，不能压紧止损凑单。');
 if(basis.targetStructureIds.length!==setup.targets.length)throw new Error('目标依据数量不匹配。');
 setup.targets.forEach((target,i)=>{const f=entries.get(basis.targetStructureIds[i])!;if(!['5m','15m'].includes(f.timeframe)||!['HH','LH','HL','LL','liquidity-high','liquidity-low'].includes(f.type)||target.price<f.low&&!same(target.price,f.low)||target.price>f.high&&!same(target.price,f.high))throw new Error('目标须引用真实5m/15m结构价位。');});
 const prices=bundle.frames['1m'].candles.flatMap(b=>[b.high,b.low]),span=Math.max(...prices)-Math.min(...prices),padRange=Math.max(span,setup.entry*.005)*3;
 validateTradeTracking(setup,Math.max(Number.MIN_VALUE,Math.min(...prices)-padRange),Math.max(...prices)+padRange);
 if(!setup.tracking||setup.tracking.steps.length<2)throw new Error('策略触发必须有分开的回踩与后续收盘步骤。');
 return setup;
}
export function evaluateStrategies(bundle:ResearchBundle,facts:ResearchFact[]):StrategyCandidate[] {
 const by=(tf:ResearchFrame)=>facts.filter(f=>f.timeframe===tf&&f.knownAt<=bundle.asOf);
 const bg=by('15m'),structure=by('5m'),trigger=by('1m'),regime=frameRegime(bg);
 const bgDirection=regime==='uptrend'?'bullish':regime==='downtrend'?'bearish':null;
 const background=latest(bg.filter(f=>['BOS','CHoCH'].includes(f.type)&&usable(f)));
 const candidates:StrategyCandidate[]=[];
 for(const strategy of STRATEGY_CATALOG)for(const direction of ['bullish','bearish'] as const){
  const primary=latest(structure.filter(f=>f.direction===direction&&usable(f)&&(strategy.id==='sweep-reclaim'?f.type==='sweep':strategy.id==='bos-retest'?f.type==='BOS':['FVG','OB'].includes(f.type))));
  const seed=contentId(primary?.id??'none');
  const candidate:StrategyCandidate={id:strategy.id+'-'+direction+'-'+seed,strategyId:strategy.id,direction,scenarioId:'scenario-'+strategy.id+'-'+direction+'-'+seed,
    snapshotId:bundle.id,asOf:bundle.asOf,stage:'watching',score:0,checks:[],supportIds:[],oppositionIds:[],eventGroups:[],conflicts:[],uncertainties:[],
    sourceByFrame:{'15m':background?[background.id]:[],'5m':primary?[primary.id]:[],'1m':[]},setup:null,expiresAt:bundle.asOf+30*60,triggerObservedAt:null,proposalReason:'等待结构条件'};
  const check=(key:string,label:string,passed:boolean,weight:number,reason:string,refs:ResearchFact[]=[])=>candidate.checks.push({key,label,passed,weight,awarded:0,reason,evidenceIds:refs.map(f=>f.id)});
  check('data','三个周期数据完整',RESEARCH_FRAMES.every(tf=>bundle.frames[tf].integrity.usable),0,RESEARCH_FRAMES.flatMap(tf=>bundle.frames[tf].integrity.reasons.map(r=>tf+' '+r)).join('；')||'三个周期均为有效已收盘快照');
  const aligned=strategy.id==='trend-pullback'?bgDirection===direction:background!==undefined&&(bgDirection===null||bgDirection===direction);
  check('background','15m背景匹配',aligned,2,aligned?regime+'背景未反对本情景':'缺少可解释的15m背景或方向冲突',background?[background]:[]);
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
  const local=latest(trigger.filter(f=>['BOS','CHoCH'].includes(f.type)&&f.direction===direction&&f.status==='confirmed'&&f.knownAt>=(reactionTime??Infinity)));
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
  const stop=latest(structure.filter(f=>protectiveTypes.includes(f.type)&&f.status==='confirmed'&&f.knownAt<=bundle.asOf));
  const majorProtection=latest(bg.filter(f=>protectiveTypes.includes(f.type)&&f.status==='confirmed'&&f.importance==='major'));
  if(majorProtection)candidate.sourceByFrame['15m'].push(majorProtection.id);
  check('protection','5m结构保护'+(strategy.id==='trend-pullback'?'与15m主要保护':''),!!stop&&(strategy.id!=='trend-pullback'||!!majorProtection),1,stop?'保护价格来自实际5m摆点':'缺少有效5m保护结构',stop?[stop]:[]);
  if(stop)candidate.sourceByFrame['5m'].push(stop.id);
  const entry=local?.low;
  const volatility=tradeRiskContext(bundle.frames['5m'].candles).atr;
  const last=bundle.frames['1m'].candles.at(-1)?.close;
  const extended=entry!==undefined&&last!==undefined&&volatility!==null&&Math.abs(last-entry)>volatility*STRATEGY_PARAMETERS.maximumExtensionAtr;
  check('extension','入场尚未过度延伸',entry!==undefined&&!extended,1,extended?'当前价格离1m参考位超过2倍5m ATR，等待新结构':'2倍5m ATR为未经回测的项目延伸过滤参数');
  if(extended)candidate.conflicts.push('当前价格已远离参考触发区');
  const targetFacts=entry===undefined?[]:facts.filter(f=>['5m','15m'].includes(f.timeframe)&&usable(f)&&['HH','LH','HL','LL','liquidity-high','liquidity-low'].includes(f.type)&&(direction==='bullish'?['HH','LH','liquidity-high'].includes(f.type)&&f.low>entry:['HL','LL','liquidity-low'].includes(f.type)&&f.high<entry))
    .sort((a,b)=>Math.abs(a.low-entry)-Math.abs(b.low-entry));
  const targets=targetFacts.filter((f,i,a)=>a.findIndex(x=>same(x.low,f.low))===i).slice(0,3);
  if(local&&stop&&volatility!==null&&volatility>0&&targets.length){
   const stopLoss=direction==='bullish'?stop.low-volatility*STOP_RISK_POLICY.minimumStructureBufferAtr:stop.high+volatility*.25;
   const ids=[...new Set([...candidate.sourceByFrame['15m'],...candidate.sourceByFrame['5m'],...candidate.sourceByFrame['1m'],...targets.map(f=>f.id)])];
   // Existing Schema 1.5 geometry/tracking contract, with distinct multi-frame evidence validation above.
   const setup:TradeSetup={id:candidate.id+'-plan',opportunityId:null,direction,status:'candidate',anchorTime:bundle.frames['1m'].lastClosedTime!,entry:entry!,stopLoss,
    targets:targets.map(f=>({price:f.low,label:f.timeframe+' '+f.type+'结构目标'})),structureIds:ids.slice(0,12),basis:{scenarioId:candidate.scenarioId,entryStructureId:local.id,stopStructureId:stop.id,targetStructureIds:targets.map(f=>f.id)},
    trigger:'新的1m K线先回踩参考价区域，随后更晚一根收盘保持方向；旧确认只作背景，不代表已成交。',
    tracking:{steps:[{label:'新1m回踩',conditions:[{type:'touch-zone',price:entry!,priceEnd:entry!}]},{label:'随后方向收盘',conditions:[{type:direction==='bullish'?'close-above':'close-below',price:entry!,priceEnd:null}]}],cancellation:{basis:'close',price:direction==='bullish'?stop.low:stop.high,label:'5m保护失守'},expiresAfterBars:Math.max(1,Math.min(STRATEGY_PARAMETERS.maximumWait1mBars,Math.floor((candidate.expiresAt-bundle.asOf)/60)))},
    rationale:strategy.name+'；15m背景、5m保护与反应、1m触发分别承担不同职责。目标来自最近真实价位，未跳过近端阻挡。',invalidation:'等待期间5m保护失守、15m背景冲突、数据修订/缺口或30根1m等待结束则取消或复核。'};
   try{validateStrategyPlan(setup,candidate,bundle,facts);candidate.setup=setup;candidate.proposalReason='价位及ATR缓冲校验通过，仍为待触发研究候选';}
   catch(error){candidate.proposalReason=error instanceof Error?error.message:'计划校验失败';}
  }
  check('geometry','保护与真实首目标空间',candidate.setup!==null,1,candidate.proposalReason,targets);
  candidate.supportIds=[...new Set(candidate.checks.filter(c=>c.passed).flatMap(c=>c.evidenceIds))];
  candidate.eventGroups=[...new Set(facts.filter(f=>candidate.supportIds.includes(f.id)).map(f=>f.familyId))];
  const credited=new Set<string>();
  for(const item of [...candidate.checks].sort((a,b)=>b.weight-a.weight)){
   const groups=[...new Set(item.evidenceIds.map(id=>facts.find(f=>f.id===id)?.familyId??id))];
   if(item.passed&&!groups.some(group=>credited.has(group))){item.awarded=item.weight;groups.forEach(group=>credited.add(group));}
  }
  candidate.score=candidate.checks.reduce((n,c)=>n+c.awarded,0);
  if(candidate.checks.every(c=>c.passed)&&candidate.setup)candidate.stage='conditional';else candidate.setup=null;
  candidates.push(candidate);
 }
 return candidates.sort((a,b)=>Number(b.stage==='conditional')-Number(a.stage==='conditional')||b.score-a.score||a.id.localeCompare(b.id));
}
