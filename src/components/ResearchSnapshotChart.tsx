import {useMemo,useState} from 'react';
import type {TradeSetup,Structure,StructureType,LiquiditySweep} from '../../shared/analysis';
import {extractFrameFacts,type FrameSnapshot} from '../../shared/researchData';
import type {PlanTrackingResult} from '../../shared/tradeTracking';
import {formatPrice} from '../../shared/format';
import {TradingChart} from './TradingChart';
import type {ChartLayers} from '../chart/layers';
const types=['HH','HL','LH','LL','BOS','CHoCH','FVG','OB'] as StructureType[];
export interface ResearchChartFocus {frame:FrameSnapshot;setup:TradeSetup|null;factId:string|null;label:string;sessionId:string;tracking?:PlanTrackingResult}
export function ResearchSnapshotChart({view,layers,onClose}:{view:ResearchChartFocus;layers:ChartLayers;onClose:()=>void}){
 const facts=useMemo(()=>extractFrameFacts(view.frame),[view.frame]);
 const [selection,setSelection]=useState(view.factId);
 const selected=facts.find(f=>f.id===selection),tf=view.frame.timeframe,seconds=tf==='15m'?900:tf==='5m'?300:60;
 const structures:Structure[]=facts.filter(f=>types.includes(f.type as StructureType)).map(f=>({id:f.id,type:f.type as StructureType,direction:f.direction,status:f.confirmedAt===null?'candidate':'confirmed',startTime:['HH','HL','LH','LL'].includes(f.type)?f.originTime:['FVG','OB'].includes(f.type)?f.formedAt-seconds:f.originTime,endTime:['HH','HL','LH','LL'].includes(f.type)?f.originTime:f.formedAt-seconds,price:f.low,priceEnd:['FVG','OB'].includes(f.type)?f.high:null,rationale:f.rationale,invalidation:f.invalidation}));
 const stamp=(time:number|null)=>time===null?'未确认':new Date(time*1000).toISOString().slice(5,16).replace('T',' ')+' UTC';
 let sweep:LiquiditySweep|null=null;
 if(selected?.type==='sweep'){
  const origin=view.frame.candles.find(b=>b.timestamp===selected.originTime),bar=view.frame.candles.find(b=>b.timestamp===selected.formedAt-seconds);
  if(origin&&bar)sweep={id:selected.id,side:selected.direction==='bearish'?'buy-side':'sell-side',levelTime:origin.timestamp,sweepTime:bar.timestamp,levelPrice:selected.direction==='bearish'?origin.high:origin.low,extremePrice:selected.direction==='bearish'?bar.high:bar.low,status:selected.confirmedAt===null?'candidate':'confirmed',rationale:selected.rationale,invalidation:selected.invalidation};
 }
 const level=selected&&!types.includes(selected.type as StructureType)&&selected.type!=='sweep'?{label:selected.type,price:selected.low,reason:selected.rationale}:null;
 const visible=types.filter(type=>['FVG','OB'].includes(type)?layers.evidence:layers.primary);
 return <div className="research-main-chart" aria-label="研究定位图表"><div className="research-focus-banner"><div><strong>{view.label}</strong><span>{tf} 固定快照 · {new Date((view.frame.lastClosedTime??0)*1000).toISOString().slice(5,16).replace('T',' ')} UTC{view.setup?' · 5m保护 / 15m目标':''}</span></div><button className="button secondary" onClick={onClose}>返回实时图表</button></div>
 <TradingChart candles={view.frame.candles} structures={structures} visibleTypes={visible} selectedId={selection} onSelect={setSelection} resetToken={0} evidenceFocusToken={1} datasetKey={view.sessionId+view.frame.id+(view.setup?.id??'')} symbol={view.frame.symbol} timeframe={tf} exchange={view.frame.source} showSMC showPA={false} liquiditySweeps={sweep?[sweep]:[]} selectedSweepId={sweep?.id??null} showLiquiditySweeps={layers.evidence} keyLevels={level?[level]:[]} showKeyLevels={layers.primary} selectedKeyLevelIndex={level?0:null} tradeSetups={view.setup?[view.setup]:[]} selectedSetupId={view.setup?.id??null} setupFocusToken={1} showTradeSetups={layers.plans} tradeTracking={view.setup&&view.tracking?{[view.setup.id]:view.tracking}:{}}/>
 {selected&&<div className="research-focus-detail" aria-label="研究事实详情"><b>规则事实 · {selected.timeframe} {selected.type}</b><p>起源 {stamp(selected.originTime)} · 形成 {stamp(selected.formedAt)} · 确认 {stamp(selected.confirmedAt)} · 失效 {selected.resolvedAt===null?'未观察到':stamp(selected.resolvedAt)}</p><p>{formatPrice(selected.low)}{selected.high!==selected.low?' – '+formatPrice(selected.high):''} · {selected.rationale}</p><p>失效条件：{selected.invalidation}</p></div>}
 {!view.setup||view.frame.candles.some(b=>b.timestamp===view.setup!.anchorTime)?null:<p className="research-warning">计划原锚点不在当前快照内；未将计划吸附到其他K线，请定位原始计划快照。</p>}
 </div>;
}
