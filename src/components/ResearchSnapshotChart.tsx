import { shortDisplayTime } from '../../shared/displayTime';
import {useMemo,useState} from 'react';
import type {TradeSetup,Structure,StructureType,LiquiditySweep} from '../../shared/analysis';
import {extractFrameFacts,type FrameSnapshot} from '../../shared/researchData';
import type {PlanTrackingResult} from '../../shared/tradeTracking';
import {formatPrice} from '../../shared/format';
import {TradingChart} from './TradingChart';
import type {ChartLayers} from '../chart/layers';
import type {PositionChartModel} from '../../shared/positionChart';
import {PositionChartLegend} from './PositionChartLegend';
import type {MarketSnapshot} from '../../shared/liveMarket';
import {LIVE_INTERVAL_SECONDS} from '../../shared/liveMarket';
import {positionChartFeed,positionFactsFrame} from '../chart/positionFeed';
const types=['HH','HL','LH','LL','BOS','CHoCH','FVG','OB'] as StructureType[];
export interface ResearchChartFocus {frame:FrameSnapshot;setup:TradeSetup|null;factId:string|null;label:string;sessionId:string;focusToken?:number;tracking?:PlanTrackingResult;position?:PositionChartModel;passiveUpdate?:boolean}
export function ResearchSnapshotChart({view,layers,onClose,marketSnapshot=null,marketError='',marketPaused=false}:{view:ResearchChartFocus;layers:ChartLayers;onClose:()=>void;marketSnapshot?:MarketSnapshot|null;marketError?:string;marketPaused?:boolean}){
 const feed=positionChartFeed(view,marketSnapshot);
 const factFrame=useMemo(()=>positionFactsFrame(view,marketSnapshot),[view.frame,feed.factsKey]);
 const facts=useMemo(()=>factFrame?extractFrameFacts(factFrame):[],[factFrame]);
 const [selection,setSelection]=useState(view.factId);
 const [positionLine,setPositionLine]=useState<string|null>(null),[positionSources,setPositionSources]=useState({exchange:true,advice:true,original:false});
 const positionView=useMemo(()=>view.position?{...view.position,lines:view.position.lines.filter(l=>l.source==='account'||positionSources[l.source]),areas:view.position.areas.filter(a=>positionSources[a.source])}:null,[view.position,positionSources]);
 const selected=facts.find(f=>f.id===selection),tf=feed.timeframe,seconds=LIVE_INTERVAL_SECONDS[tf];
 const structures:Structure[]=facts.filter(f=>types.includes(f.type as StructureType)).map(f=>({id:f.id,type:f.type as StructureType,direction:f.direction,status:f.confirmedAt===null?'candidate':'confirmed',startTime:['HH','HL','LH','LL'].includes(f.type)?f.originTime:['FVG','OB'].includes(f.type)?f.formedAt-seconds:f.originTime,endTime:['HH','HL','LH','LL'].includes(f.type)?f.originTime:f.formedAt-seconds,price:f.low,priceEnd:['FVG','OB'].includes(f.type)?f.high:null,rationale:f.rationale,invalidation:f.invalidation}));
 const stamp=(time:number|null)=>time===null?'未确认':shortDisplayTime(time)+' UTC+8';
 let sweep:LiquiditySweep|null=null;
 if(selected?.type==='sweep'){
  const origin=feed.candles.find(b=>b.timestamp===selected.originTime),bar=feed.candles.find(b=>b.timestamp===selected.formedAt-seconds);
  if(origin&&bar)sweep={id:selected.id,side:selected.direction==='bearish'?'buy-side':'sell-side',levelTime:origin.timestamp,sweepTime:bar.timestamp,levelPrice:selected.direction==='bearish'?origin.high:origin.low,extremePrice:selected.direction==='bearish'?bar.high:bar.low,status:selected.confirmedAt===null?'candidate':'confirmed',rationale:selected.rationale,invalidation:selected.invalidation};
 }
 const level=selected&&!types.includes(selected.type as StructureType)&&selected.type!=='sweep'?{label:selected.type,price:selected.low,reason:selected.rationale}:null;
 const visible=types.filter(type=>['FVG','OB'].includes(type)?layers.evidence:layers.primary);
 return <div className="research-main-chart" aria-label="研究定位图表" data-market-mode={feed.live?marketError?'interrupted':marketPaused?'paused':'live':'snapshot'}><div className="research-focus-banner"><div><strong>{view.label}</strong><span>{tf} {feed.live?(marketError?'行情更新异常':marketPaused?'行情更新已暂停':'实时行情'):'固定快照'} · {shortDisplayTime(feed.live?Math.floor(feed.live.serverTime/1000):view.frame.lastClosedTime??0,true)} UTC+8{view.setup?' · 5m保护 / 15m目标':''}{feed.live?' · 结构仅按已收盘K线确认':''}</span>{feed.live&&marketError&&<p className="research-conflict">{marketError} · 保留最后可用行情，未冒充当前价格。</p>}</div><button className="button secondary" onClick={onClose}>{feed.live?'收起持仓标注':'返回实时图表'}</button></div>
 <TradingChart candles={feed.candles} structures={structures} visibleTypes={visible} selectedId={selection} onSelect={setSelection} resetToken={0} evidenceFocusToken={view.focusToken??1} datasetKey={view.sessionId+(view.position?tf:view.frame.id)+(view.setup?.id??'')} symbol={view.frame.symbol} timeframe={tf} exchange={feed.live?.provider??view.frame.source} showSMC showPA={false} liquiditySweeps={sweep?[sweep]:[]} selectedSweepId={sweep?.id??null} showLiquiditySweeps={layers.evidence} keyLevels={level?[level]:[]} showKeyLevels={layers.primary} selectedKeyLevelIndex={level?0:null} tradeSetups={view.setup?[view.setup]:[]} selectedSetupId={view.setup?.id??null} setupFocusToken={view.focusToken??1} showTradeSetups={layers.plans} tradeTracking={view.setup&&view.tracking?{[view.setup.id]:view.tracking}:{}} positionView={layers.plans?positionView:null} selectedPositionLineId={positionLine} onSelectPositionLine={setPositionLine}/>
 {view.position&&<PositionChartLegend model={view.position} sources={positionSources} onSources={setPositionSources} selected={positionLine} onSelect={setPositionLine}/>}
 {selected&&<div className="research-focus-detail" aria-label="研究事实详情"><b>规则事实 · {selected.timeframe} {selected.type}</b><p>起源 {stamp(selected.originTime)} · 形成 {stamp(selected.formedAt)} · 确认 {stamp(selected.confirmedAt)} · 失效 {selected.resolvedAt===null?'未观察到':stamp(selected.resolvedAt)}</p><p>{formatPrice(selected.low)}{selected.high!==selected.low?' – '+formatPrice(selected.high):''} · {selected.rationale}</p><p>失效条件：{selected.invalidation}</p></div>}
 {!view.setup||view.frame.candles.some(b=>b.timestamp===view.setup!.anchorTime)?null:<p className="research-warning">计划原锚点不在当前快照内；未将计划吸附到其他K线，请定位原始计划快照。</p>}
 </div>;
}
