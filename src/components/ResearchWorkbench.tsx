import { ALL_CHART_LAYERS, chartStructureProjection } from '../chart/layers';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Candle } from '../../shared/market';
import { parseMarketCsv } from '../../shared/market';
import type { MarketSnapshot } from '../../shared/liveMarket';
import { closedMarketCandles } from '../../shared/liveMarket';
import type { Structure, StructureType, LiquiditySweep } from '../../shared/analysis';
import { formatPrice } from '../../shared/format';
import { calculateRiskReward } from '../../shared/tradeGeometry';
import { PLAN_PHASE_LABELS, type PlanPhase } from '../../shared/tradeTracking';
import { FRAME_ROLES, FRAME_SECONDS, RESEARCH_FRAMES, contentId, csvResearchBundle, extractFrameFacts, frameRegime, makeResearchBundle, type FrameInput, type ResearchFrame, type ResearchFact } from '../../shared/researchData';
import { STRATEGY_CATALOG } from '../../shared/strategyCatalog';
import { acceptInterpretation, acceptPlanUpdate, currentFacts, exportResearchState, modelContext, planUpdateProposal, recordActualPosition, saveCandidatePlan, targetObservations, updateMarketState, type MarketState, type ManagedPlan } from '../../shared/marketState';
import { TradingChart } from './TradingChart';
import { clearResearchState, loadResearchState, saveResearchState } from '../researchStorage';
import { frameInput, getResearchMarket, requestResearch } from '../services/workbench';
import type { AnalysisSource } from '../services/api';
const date=(t:number)=>new Date(t*1000).toISOString().replace('T',' ').slice(5,16)+' UTC';
const regimeNames={uptrend:'上升趋势',downtrend:'下降趋势',range:'区间震荡',transition:'转换观察',unavailable:'数据不足'};
const standardTypes=['HH','HL','LH','LL','BOS','CHoCH','FVG','OB'] as StructureType[];
interface Props {symbol:string;source:'live'|'csv'|'sample';candles:Candle[];timeframe:string;marketSnapshot:MarketSnapshot|null;analysisSource:AnalysisSource;notes:string}
export function ResearchWorkbench(props:Props){
 const {symbol,source,analysisSource}=props,key='research-1.0:'+source+':'+symbol;
 const [enabled,setEnabled]=useState(false),[state,setState]=useState<MarketState|null>(null),[loaded,setLoaded]=useState(false);
 const [error,setError]=useState(''),[persistError,setPersistError]=useState(''),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const [layers,setLayers]=useState(ALL_CHART_LAYERS);
 const [selectedFrame,setSelectedFrame]=useState<ResearchFrame>('5m'),[chartVisible,setChartVisible]=useState(false),[selectedFactId,setSelectedFactId]=useState<string|null>(null),[focus,setFocus]=useState(0);
 const [focusedPlan,setFocusedPlan]=useState<{id:string;version:number;historical:boolean}|null>(null),[csvFrame,setCsvFrame]=useState<ResearchFrame>('5m'),[positionPlan,setPositionPlan]=useState<string|null>(null);
 const [fill,setFill]=useState({entry:'',quantity:'',time:''});
 const stateRef=useRef(state),propsRef=useRef(props),keyRef=useRef(key),loadedKey=useRef<string|null>(null),extraFrames=useRef<FrameInput[]>([]);
 const marketController=useRef<AbortController|null>(null),analysisController=useRef<AbortController|null>(null),loadingRef=useRef(false),lastClosed=useRef('');
 stateRef.current=state;propsRef.current=props;keyRef.current=key;
 const commit=useCallback((next:MarketState|null)=>{stateRef.current=next;setState(next);},[]);
 useEffect(()=>{let active=true;loadedKey.current=null;setLoaded(false);setEnabled(false);commit(null);extraFrames.current=[];lastClosed.current='';setError('');setMessage('');
  void loadResearchState(key).then(restored=>{if(!active)return;commit(restored);extraFrames.current=restored?RESEARCH_FRAMES.map(tf=>frameInput(restored.bundle.frames[tf])).filter(f=>f.source==='csv'&&f.timeframe!==propsRef.current.timeframe.toLowerCase()):[];if(restored)setMessage('已恢复本地历史状态；恢复更新前不是当前实时判断。');}).catch(e=>{if(active)setPersistError(String(e.message));}).finally(()=>{if(active){loadedKey.current=key;setLoaded(true);}});
  return()=>{active=false;marketController.current?.abort();analysisController.current?.abort();loadingRef.current=false;};
 },[key,commit]);
 useEffect(()=>{if(!state||loadedKey.current!==key)return;const timer=window.setTimeout(()=>{void saveResearchState(key,state).then(()=>setPersistError('')).catch(e=>setPersistError(e.message));},500);return()=>window.clearTimeout(timer);},[key,state]);
 const refresh=useCallback(async()=>{
  if(loadingRef.current||!loadedKey.current)return;loadingRef.current=true;setLoading(true);setError('');const requestKey=keyRef.current,controller=new AbortController();marketController.current=controller;
  const timer=window.setTimeout(()=>controller.abort(),16000);
  try{const p=propsRef.current;let bundle;
   if(p.source==='sample')throw new Error('请先使用真实行情或导入实际CSV数据；工作台不会自动载入示例。');
   if(p.source==='live')bundle=await getResearchMarket(p.symbol,controller.signal);
   else{const tf=p.timeframe.toLowerCase() as ResearchFrame;if(!RESEARCH_FRAMES.includes(tf))throw new Error('CSV周期必须明确为1m、5m或15m，可用下方入口分别补充实际周期。');
    const base=csvResearchBundle(p.symbol,p.candles,tf),extras=extraFrames.current;
    const one=extras.find(f=>f.timeframe==='1m');const aggregate=one?csvResearchBundle(p.symbol,one.candles,'1m'):base;
    const all=RESEARCH_FRAMES.map(t=>extras.find(f=>f.timeframe===t)??(base.frames[t].source==='csv'&&base.frames[t].candles.length?frameInput(base.frames[t]):frameInput(aggregate.frames[t])));
    const asOf=all.find(f=>f.timeframe==='1m'&&f.candles.length)?.observedAt??Math.max(...all.map(f=>f.observedAt));bundle=makeResearchBundle(p.symbol,all,asOf);
   }
   if(controller.signal.aborted||keyRef.current!==requestKey)return;
   commit(updateMarketState(stateRef.current,bundle,'用户刷新或已收盘行情本地更新'));setMessage('规则已更新；未自动调用模型。');
  }catch(e){if(keyRef.current===requestKey&&!controller.signal.aborted)setError(e instanceof Error?e.message:'研究行情更新失败，保留原状态并标记暂停。');else if(keyRef.current===requestKey)setError('多周期行情更新超时，保留原快照，不能视为当前实时判断。');}
  finally{window.clearTimeout(timer);if(marketController.current===controller){loadingRef.current=false;marketController.current=null;setLoading(false);}}
 },[commit]);
 useEffect(()=>{if(!enabled||!loaded)return;void refresh();if(source!=='live')return;const timer=window.setInterval(()=>void refresh(),30000);return()=>{window.clearInterval(timer);marketController.current?.abort();};},[enabled,loaded,source,key,refresh]);
 useEffect(()=>{const snapshot=props.marketSnapshot;if(!enabled||source!=='live'||!snapshot)return;const bars=closedMarketCandles(snapshot),signature=contentId(bars.slice(-5));if(signature!==lastClosed.current){lastClosed.current=signature;void refresh();}},[enabled,source,props.marketSnapshot,refresh]);
 useEffect(()=>{if(!enabled&&marketController.current)marketController.current.abort();},[enabled]);
 async function review(){const current=stateRef.current;if(!current||analysisController.current)return;const context=modelContext(current),requestKey=keyRef.current,controller=new AbortController();analysisController.current=controller;setBusy(true);setError('');const timer=window.setTimeout(()=>controller.abort(),305000);
  try{const result=await requestResearch(context,propsRef.current.analysisSource,propsRef.current.notes,controller.signal);if(controller.signal.aborted||requestKey!==keyRef.current||!stateRef.current)return;
   commit(acceptInterpretation(stateRef.current,context,result.analysis,result.model,result.source));setMessage((result.source==='ai'?'AI审阅完成':'本地占位审阅完成，未使用模型')+'；原始事实与计划价格未改写。'+(result.usage?' 输入 '+result.usage.inputTokens+' / 输出 '+result.usage.outputTokens+' tokens':'')+(result.analysisAttempts===2?'；已进行一次有界修正':''));
  }catch(e){if(requestKey===keyRef.current)setError(controller.signal.aborted?'已取消或超时，保留之前的研究状态。':e instanceof Error?e.message:'研究审阅失败。');}
  finally{window.clearTimeout(timer);if(analysisController.current===controller){analysisController.current=null;setBusy(false);}}
 }
 function action(run:(s:MarketState)=>MarketState):boolean{if(!stateRef.current)return false;try{commit(run(stateRef.current));setError('');return true;}catch(e){setError(e instanceof Error?e.message:'状态更新失败');return false;}}
 function locate(tf:ResearchFrame,id:string|null=null){const type=stateRef.current&&id?currentFacts(stateRef.current).find(f=>f.id===id)?.type:undefined;setLayers(v=>({...v,[type&&['FVG','OB','sweep'].includes(type)?'evidence':'primary']:true}));setSelectedFrame(tf);setSelectedFactId(id);setFocusedPlan(null);setChartVisible(true);setFocus(v=>v+1);}
 function locatePlan(plan:ManagedPlan,version:number,historical=true){setLayers(v=>({...v,plans:true}));setFocusedPlan({id:plan.id,version,historical});setSelectedFactId(null);setSelectedFrame('1m');setChartVisible(true);setFocus(v=>v+1);}
 function download(){if(!state)return;const url=URL.createObjectURL(new Blob([JSON.stringify(exportResearchState(state),null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='research-'+symbol+'-v'+state.version+'.json';a.click();URL.revokeObjectURL(url);}
 async function importFrame(file:File){try{if(source==='live')throw new Error('实时工作台使用交易所数据。请先切换CSV模式再补充周期。');if(file.size>2*1024*1024)throw new Error('CSV超过2MB。');const rows=parseMarketCsv(await file.text()).candles.slice(-300),observedAt=(rows.at(-1)?.timestamp??0)+FRAME_SECONDS[csvFrame];
   const input:FrameInput={symbol,timeframe:csvFrame,source:'csv',closure:'user-declared',observedAt,candles:rows,lastClosedTime:rows.at(-1)?.timestamp??null,derivedFrom:null,unavailableReason:null};
   extraFrames.current=[...extraFrames.current.filter(f=>f.timeframe!==csvFrame),input];if(enabled)await refresh();else setEnabled(true);
  }catch(e){setError(e instanceof Error?e.message:'CSV周期导入失败。');}}
 async function reset(){if(!window.confirm('开始新研究会话将清除本地当前会话。请先导出，确定继续？'))return;try{setEnabled(false);await clearResearchState(key);commit(null);setMessage('已清理当前会话；再次开启将从真实输入建立新状态。');setFocusedPlan(null);setChartVisible(false);}catch(e){setError(String(e));}}
 const facts=useMemo(()=>state?currentFacts(state):[],[state]);
 const activePlan=state?.plans.find(p=>p.id===focusedPlan?.id),planVersion=activePlan?.versions.find(v=>v.version===focusedPlan?.version);
 const chartFrame=state?(planVersion&&focusedPlan?.historical?state.snapshots[planVersion.snapshotIds['1m']]:state.bundle.frames[selectedFrame]):null;
 const chartFacts=useMemo(()=>chartFrame?extractFrameFacts(chartFrame):[],[chartFrame]);
 const selectedFact=chartFacts.find(f=>f.id===selectedFactId),chartStructures:Structure[]=chartFacts.filter(f=>standardTypes.includes(f.type as StructureType)).map(f=>{
  const point=['HH','HL','LH','LL'].includes(f.type);return {id:f.id,type:f.type as StructureType,direction:f.direction,status:f.confirmedAt===null?'candidate':'confirmed',startTime:point?f.originTime:['FVG','OB'].includes(f.type)?f.formedAt-FRAME_SECONDS[f.timeframe]:f.originTime,endTime:point?f.originTime:f.formedAt-FRAME_SECONDS[f.timeframe],price:f.low,priceEnd:['FVG','OB'].includes(f.type)?f.high:null,rationale:f.rationale,invalidation:f.invalidation};});
 let sweep:LiquiditySweep|null=null;
 if(selectedFact?.type==='sweep'&&chartFrame){const origin=chartFrame.candles.find(b=>b.timestamp===selectedFact.originTime),bar=chartFrame.candles.find(b=>b.timestamp===selectedFact.formedAt-FRAME_SECONDS[selectedFrame]);if(origin&&bar)sweep={id:selectedFact.id,side:selectedFact.direction==='bearish'?'buy-side':'sell-side',levelTime:origin.timestamp,sweepTime:bar.timestamp,levelPrice:selectedFact.direction==='bearish'?origin.high:origin.low,extremePrice:selectedFact.direction==='bearish'?bar.high:bar.low,status:selectedFact.confirmedAt===null?'candidate':'confirmed',rationale:selectedFact.rationale,invalidation:selectedFact.invalidation};}
 const selectedLevel=selectedFact&&!standardTypes.includes(selectedFact.type as StructureType)&&selectedFact.type!=='sweep'?{label:selectedFact.type,price:selectedFact.low,reason:selectedFact.rationale}:null;
 const interpretation=state?.interpretation.at(-1);
 return <section className="research-workbench panel" aria-label="多周期研究工作台">
  <div className="research-heading"><div><span className="eyebrow">CONTINUOUS RESEARCH</span><h2>多周期研究工作台</h2><p>15m 背景 → 5m 机会与保护 → 1m 触发。规则事实、AI解释与条件计划分开保存。</p></div><div className="research-actions">
   <button className="button secondary" disabled={!loaded||source==='sample'} onClick={()=>setEnabled(v=>!v)}>{enabled?'暂停本地更新':state?'恢复本地更新':'开启多周期研究'}</button>
   <button className="button secondary" disabled={!loaded||loading||!enabled} onClick={()=>void refresh()}>{loading?'刷新中…':'更新规则'}</button>
   <button className="button primary" disabled={!state||busy||state.capacityReached} onClick={()=>void review()}>{busy?'正在审阅…':analysisSource==='mock'?'本地占位审阅':'AI重新评估'}</button>
   {busy&&<button className="button secondary" onClick={()=>analysisController.current?.abort()}>取消审阅</button>}
   <button className="button text-button" disabled={!state} onClick={download}>导出研究状态</button>
  </div></div>
  <p className="research-policy">仅主动审阅调用模型，普通行情更新不消耗模型额度。规则评分表示符合度，不是胜率。条件满足与参考SL/TP触及均不代表成交。{source==='csv'&&' CSV末根收盘由使用者声明，聚合只使用完整1m分组。'}</p>
  {(error||persistError)&&<div className="research-warning" role="alert">{error}{persistError&&<p>{persistError}</p>}历史状态保留；数据异常时请重新评估。</div>}
  {message&&<p role="status" className="research-message">{message}</p>}
  {source==='csv'&&<div className="research-csv"><label>补充实际周期 <select aria-label="补充CSV周期" value={csvFrame} onChange={e=>setCsvFrame(e.target.value as ResearchFrame)}>{RESEARCH_FRAMES.map(tf=><option key={tf}>{tf}</option>)}</select></label><label className="button secondary">导入该周期CSV<input aria-label="导入研究周期CSV" type="file" accept=".csv" onChange={e=>{const file=e.target.files?.[0];if(file)void importFrame(file);e.target.value='';}}/></label><span>标的沿用 {symbol}，请提供同一标的的数据。</span></div>}
  {!state?<div className="advanced-empty">{loaded?'开启后获取真实15m / 5m / 1m快照，或使用已提供CSV。没有合格策略时将明确等待。':'正在读取本地研究状态…'}</div>:<>
   <div className="research-state-line"><strong>Market State v{state.version}</strong><span>{symbol} · {date(state.asOf)} · {enabled&&!error?'规则持续更新':'历史快照 / 更新暂停'}</span><span>事实 {facts.length} · 计划 {state.plans.length} · 本地持仓登记 {state.positions.length}</span></div>
   {(state.needsReview.length>0||state.capacityReached)&&<div className="research-warning" aria-label="市场状态复核提示">{state.needsReview.map(r=><p key={r}>{r}</p>)}</div>}
   <div className="research-frame-grid">{RESEARCH_FRAMES.map(tf=>{const frame=state.bundle.frames[tf],local=facts.filter(f=>f.timeframe===tf),view=interpretation?.value.frames.find(f=>f.timeframe===tf);return <article className={'research-frame '+(!frame.integrity.usable?'is-degraded':'')} key={tf}>
    <button onClick={()=>locate(tf)} aria-label={'查看研究 '+tf+' 图表'}><b>{tf}</b><span>{FRAME_ROLES[tf]}</span><strong>{frame.integrity.usable?regimeNames[frameRegime(local)]:'数据不足 / 降级'}</strong></button>
    <small>{frame.source} · {frame.candles.length}根 · 末根 {frame.lastClosedTime===null?'缺失':date(frame.lastClosedTime)}</small>
    <p>规则事实 {local.length}项 · 缺失 {frame.integrity.missingBars}根</p>{frame.integrity.reasons.map(r=><p className="research-conflict" key={r}>{r}</p>)}
    {view&&<p className="research-ai">{interpretation!.source==='ai'?'AI解释':'本地未审阅'}：{regimeNames[view.regime]} · {view.summary}</p>}
    <div className="related-structures">{local.filter(f=>f.importance==='major'||['BOS','CHoCH'].includes(f.type)).slice(-4).map(f=><button key={f.id} onClick={()=>locate(tf,f.id)}>{f.type} · {formatPrice(f.low)}</button>)}</div>
   </article>;})}</div>
   <details className="research-state-summary" open><summary>市场状态变化与AI解释</summary><p>上一次：{state.history.length>1?'v'+state.history[state.history.length-2].version+' · '+date(state.history[state.history.length-2].asOf):'首次建立上下文'}。本次：{state.history.at(-1)?.reason}。</p>
    {interpretation?<><p><b>{interpretation.source==='ai'?'AI判断':'未审阅占位'}</b> · 基于状态 v{interpretation.basedOnVersion} · {interpretation.snapshotId===state.bundle.id?'与当前输入一致':'行情已变化，解释仅属于原快照'}</p><p>{interpretation.value.summary}</p>{interpretation.value.conflicts.map((c,i)=><p className="research-conflict" key={i}>{c.timeframes.join(' / ')}：{c.reason}</p>)}{interpretation.value.uncertainties.map((u,i)=><p key={i}>不确定性：{u}</p>)}</>:<p>尚无AI解释。当前仅为确定性规则状态，不会伪装为模型结论。</p>}
    <ul>{state.events.filter(e=>e.stateVersion===state.version).slice(-8).map(e=><li key={e.id}>{date(e.knownAt)} · {e.reason}</li>)}</ul>
   </details>
   {chartVisible&&chartFrame&&<div className="research-chart" aria-label="研究定位图表"><div className="research-chart-heading"><strong>{selectedFrame} · {planVersion?focusedPlan?.historical?'计划v'+planVersion.version+'原始快照':'当前行情 / 管理计划v'+planVersion.version:'当前规则快照'}</strong><button className="button text-button" onClick={()=>setChartVisible(false)}>收起图表</button></div>
    <div className="research-actions" role="group" aria-label="研究图表图层">{([{key:'primary',label:'主结构'},{key:'evidence',label:'辅助证据'},{key:'plans',label:'交易计划'}] as const).map(layer=><label key={layer.key}><input type="checkbox" checked={layers[layer.key]} onChange={e=>setLayers(v=>({...v,[layer.key]:e.target.checked}))}/>{layer.label}</label>)}</div>
    <TradingChart candles={chartFrame.candles} structures={chartStructureProjection(chartStructures,layers,selectedFactId)} visibleTypes={standardTypes} selectedId={selectedFactId} onSelect={id=>setSelectedFactId(id)} resetToken={0} evidenceFocusToken={focus} datasetKey={state.sessionId+'-'+selectedFrame+'-'+(focusedPlan?focusedPlan.id+'-'+focusedPlan.version+'-'+(focusedPlan.historical?'historical':'live'):'current')} symbol={symbol} timeframe={selectedFrame} exchange={chartFrame.source} showSMC showPA={false}
     tradeTracking={planVersion&&activePlan?.tracking&&!focusedPlan?.historical?{[planVersion.setup.id]:activePlan.tracking}:{}} tradeSetups={planVersion?[planVersion.setup]:[]} selectedSetupId={planVersion?.setup.id??null} setupFocusToken={focus} showTradeSetups={layers.plans} liquiditySweeps={sweep?[sweep]:[]} showLiquiditySweeps={layers.evidence} selectedSweepId={sweep?.id??null} keyLevels={selectedLevel?[selectedLevel]:[]} showKeyLevels={layers.primary} selectedKeyLevelIndex={selectedLevel?0:null}/>
    {selectedFact&&<div className="research-fact-detail"><b>规则事实 · {selectedFact.type} · {selectedFact.status}</b><p>起源 {date(selectedFact.originTime)} · 形成 {date(selectedFact.formedAt)} · 确认可知 {selectedFact.confirmedAt===null?'未确认':date(selectedFact.confirmedAt)} · 失效 {selectedFact.resolvedAt===null?'未观察到':date(selectedFact.resolvedAt)}</p><p>{formatPrice(selectedFact.low)}{selectedFact.high!==selectedFact.low?' – '+formatPrice(selectedFact.high):''} · {selectedFact.rationale}</p><p>失效依据：{selectedFact.invalidation}</p></div>}
    {planVersion&&focusedPlan?.historical&&<p className="research-warning">历史计划v{planVersion.version}仅使用当时快照与价位；后续版本和事件见记录，不是当前实时开仓信号。</p>}
    {planVersion&&!focusedPlan?.historical&&!chartFrame.candles.some(b=>b.timestamp===planVersion.setup.anchorTime)&&<p className="research-warning">原计划锚点已移出当前行情窗口，请使用计划原始快照定位；不会吸附到别的K线。</p>}
   </div>}
   <div className="research-section-title"><h3>策略候选</h3><span>固定规则门槛排序 · 不按相关结构数量投票</span></div>
   <div className="research-candidate-grid">{state.scenarios.map(c=>{const strategy=STRATEGY_CATALOG.find(s=>s.id===c.strategyId)!,review=interpretation?.snapshotId===state.bundle.id?interpretation.value.strategyReviews.find(r=>r.candidateId===c.id):null;return <article className="research-candidate" key={c.id}>
    <div className="research-card-title"><button onClick={()=>locate('5m',c.sourceByFrame['5m'][0]??null)}>{strategy.name}</button><span>{c.direction==='bullish'?'偏多':'偏空'} · {c.stage==='conditional'?'条件候选':'等待'}</span></div>
    <p>规则符合度 {c.score}/10 · 关联事件组 {c.eventGroups.length}，同位移证据不重复计分。</p>
    <ul className="research-checks">{c.checks.map(check=><li key={check.key} className={check.passed?'passed':'pending'}><b>{check.passed?'✓':'○'} {check.label} {check.weight?'('+check.awarded+'/'+check.weight+')':''}</b><span>{check.reason}</span></li>)}</ul>
    {c.conflicts.map(r=><p className="research-conflict" key={r}>{r}</p>)}{c.uncertainties.map(r=><p key={r}>{r}</p>)}
    <p>1m已观察确认：{c.triggerObservedAt===null?'尚无':date(c.triggerObservedAt)}。计划仍需新的回踩与随后收盘。</p>
    {review&&<p className="research-ai">AI取舍：{review.decision==='retain'?'保留条件候选':'等待'} · {review.reason}</p>}
    <details><summary>策略定义、支持与反对依据</summary><p>环境：{strategy.environment}</p><p>前置：{strategy.prerequisites}</p><p>目标：{strategy.targetRule}</p><p>失效：{strategy.invalidation}</p><div className="related-structures">{[...c.supportIds,...c.oppositionIds].map(id=>{const f=facts.find(f=>f.id===id);return f?<button key={id} onClick={()=>locate(f.timeframe,id)}>{c.oppositionIds.includes(id)?'反对':'支持'} · {f.timeframe} {f.type} {formatPrice(f.low)}</button>:null;})}</div></details>
    <div className="related-structures">{RESEARCH_FRAMES.map(tf=><button key={tf} disabled={!c.sourceByFrame[tf].length} onClick={()=>locate(tf,c.sourceByFrame[tf][0])}>{tf}依据 {c.sourceByFrame[tf].length}</button>)}</div>
    <button className="button secondary" disabled={!c.setup||state.capacityReached} onClick={()=>action(s=>saveCandidatePlan(s,c.id,review?.decision==='retain'?'用户保存AI审阅过的规则候选':'用户保存未经过AI审阅的规则候选',review?.decision==='retain'?'ai-reviewed':'rule-candidate'))}>保存研究候选</button>
   </article>;})}</div>
   <div className="research-section-title"><h3>计划与目标管理</h3><span>候选 / 条件满足 / 用户登记持仓分别记录</span></div>
   {!state.plans.length&&<div className="advanced-empty">尚未保存合格的数值候选。所有门槛通过后可保存；AI不会为填满面板强行开单。</div>}
   <div className="research-plans">{state.plans.map(plan=>{const v=plan.versions.at(-1)!,risk=calculateRiskReward(v.setup),proposal=planUpdateProposal(state,plan);return <article className="research-plan" key={plan.id}>
    <div className="research-card-title"><h4>{STRATEGY_CATALOG.find(s=>s.id===plan.strategyId)?.name} · {plan.source==='ai-reviewed'?'已审阅候选':'规则候选'}</h4><b>{PLAN_PHASE_LABELS[plan.status as PlanPhase]??plan.status}</b></div>
    <p className="research-plan-id">{plan.id} · 情景 {plan.scenarioId} · 版本 {v.version}</p>
    <div className="trade-price-grid"><div><span>参考入场</span><strong>{formatPrice(v.setup.entry)}</strong></div><div><span>5m保护止损</span><strong>{formatPrice(v.setup.stopLoss)}</strong></div><div><span>价格风险距离</span><strong>{formatPrice(risk.risk)} · {risk.riskPct.toFixed(2)}%</strong></div></div>
    {targetObservations(state,plan).map((t,i)=><div className="research-target" key={i}><b>TP{i+1} {formatPrice(t.price)} · {calculateRiskReward(v.setup,i).ratio.toFixed(2)}R</b><button onClick={()=>locate(t.timeframe,t.structureId)}>{t.timeframe}结构依据</button><span>{t.status} · {t.reason}</span><small>形成 {date(t.formedAt)} · 最近复核 {date(t.updatedAt)}</small></div>)}
    <p><b>触发：</b>{v.setup.trigger}</p><p><b>取消：</b>{v.setup.invalidation}</p><p>等待期限：{v.setup.tracking?.expiresAfterBars??0} 根1m；剩余 {Math.max(0,(v.setup.tracking?.expiresAfterBars??0)-(plan.tracking?.checkedBars??0))} 根。已核验 {plan.tracking?.checkedBars??0} 根。{plan.tracking?.reason}</p>
    {plan.reviewReasons.map(r=><p className="research-conflict" key={r}>{r}</p>)}
    <div className="research-actions"><button className="button secondary" onClick={()=>locatePlan(plan,v.version,false)}>当前行情定位</button><button className="button secondary" onClick={()=>locatePlan(plan,v.version)}>定位计划快照</button><button className="button secondary" disabled={!proposal} onClick={()=>action(s=>acceptPlanUpdate(s,plan.id))}>接受新结构更新</button><button className="button text-button" onClick={()=>{setPositionPlan(plan.id);setFill({entry:'',quantity:'',time:''});}}>登记实际成交</button></div>
    {proposal&&<p className="research-warning">新结构支持更新提案，需主动接受。当前原价未改写：{proposal.proposalReason}</p>}
    <details><summary>计划历史版本与依据（{plan.versions.length}）</summary>{plan.versions.map(old=><div className="research-version" key={old.version}><button onClick={()=>locatePlan(plan,old.version)}>v{old.version} · {date(old.effectiveAt)}</button><p>E {formatPrice(old.setup.entry)} / SL {formatPrice(old.setup.stopLoss)} / {old.targets.map(t=>formatPrice(t.price)).join('、')}</p><p>{old.reason} · 事件 {old.eventIds.length} 项</p></div>)}</details>
   </article>;})}</div>
   {positionPlan&&<form className="research-position-form" onSubmit={e=>{e.preventDefault();if(action(s=>recordActualPosition(s,positionPlan,{entry:Number(fill.entry),quantity:Number(fill.quantity),filledAt:Math.floor(new Date(fill.time).getTime()/1000)})))setPositionPlan(null);}}><h4>仅用户明确登记后视为实际持仓</h4><label>实际成交价<input required type="number" step="any" min="0" value={fill.entry} onChange={e=>setFill(f=>({...f,entry:e.target.value}))}/></label><label>实际数量<input required type="number" step="any" min="0" value={fill.quantity} onChange={e=>setFill(f=>({...f,quantity:e.target.value}))}/></label><label>真实成交时间（本机时区）<input required type="datetime-local" value={fill.time} onChange={e=>setFill(f=>({...f,time:e.target.value}))}/></label><button className="button primary">确认登记真实成交</button><button type="button" className="button secondary" onClick={()=>setPositionPlan(null)}>取消</button></form>}
   {interpretation?.value.positionReviews.map(review=><article className="research-position" key={review.positionId}><b>AI持仓方案复核 · {review.decision}</b><p>{review.reason}</p><p>仅为人工复核方案，没有修改实际持仓、止损或执行分批止盈。{interpretation.snapshotId!==state.bundle.id&&'解释属于历史快照，需重新评估。'}</p><div className="related-structures">{review.evidenceIds.map(id=>{const f=facts.find(f=>f.id===id);return f?<button key={id} onClick={()=>locate(f.timeframe,id)}>{f.timeframe} {f.type} {formatPrice(f.low)}</button>:null;})}</div></article>)}
   {state.positions.map(p=><article className="research-position" key={p.id}><b>用户登记持仓 · {p.direction==='bullish'?'多':'空'} · {p.status}</b><p>成交 {formatPrice(p.entry)} / 数量 {p.quantity} / {date(p.filledAt)}</p>{p.review.map(r=><p key={r}>{r}</p>)}</article>)}
   <details className="research-history"><summary>状态变化与历史记录 · {state.events.length}事件 / {state.history.length}版本</summary><p>面板展示最近40项，完整输入、事实版本、策略评估、计划及事件全部在导出中保留。</p><ol>{state.events.slice(-40).reverse().map(e=><li key={e.id}><b>v{e.stateVersion} · {date(e.knownAt)}</b><span>{e.kind} · {e.reason}</span></li>)}</ol></details>
   <button className="button text-button research-clear" onClick={()=>void reset()} disabled={busy}>导出后开始新会话 / 清理本地状态</button>
  </>}
 </section>;
}
