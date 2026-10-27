import type { PositionManagementContext, PositionAdvice } from './positionManagement';
import type { ProtectionOrder } from './protectionOrders';
export interface PositionPriceLine {id:string;price:number;label:string;reason:string;color:string;style:'solid'|'dashed'|'dotted';source:'account'|'exchange'|'original'|'advice';structureId?:string;timeframe?:'15m'|'5m'|'1m'}
export interface PositionPriceArea {from:number;to:number;kind:'risk'|'reward';source:'exchange'|'advice'}
export interface PositionChartModel {positionId:string;accountSnapshotId:string;marketSnapshotId:string;asOf:number;stale:boolean;historical:boolean;lines:PositionPriceLine[];areas:PositionPriceArea[];warnings:string[];metrics:{source:'exchange'|'advice';risk:number|null;reward:number|null;ratio:number|null}[]}
/** Global price references, never manufactured fill-time anchors or candidate TradeSetups. */
export function buildPositionChart(context:PositionManagementContext,options:{advice?:PositionAdvice;adviceCurrent?:boolean;accountCurrent:boolean;historical?:boolean;showOriginal?:boolean;showOrders?:boolean;showAdvice?:boolean}):PositionChartModel{
 const p=context.position,mark=p.markPrice,sign=p.direction==='bullish'?1:-1,protection=context.exchangeProtection;
 const model:PositionChartModel={positionId:p.id,accountSnapshotId:context.account.snapshotId,marketSnapshotId:context.market.snapshotId,asOf:context.account.syncedAt,stale:!options.accountCurrent,historical:!!options.historical,lines:[],areas:[],warnings:[],metrics:[]};
 const clockWarning=context.observations.find(o=>o.kind==='data-clock-mismatch');if(clockWarning){model.stale=true;model.warnings.push(clockWarning.reason);}
 const add=(id:string,price:number|null,label:string,source:PositionPriceLine['source'],reason:string,color:string,style:PositionPriceLine['style']='solid',extra:Partial<PositionPriceLine>={})=>{if(price!==null&&Number.isFinite(price)&&price>0)model.lines.push({id,price,label,source,reason,color,style,...extra});};
 add('entry',p.entryPrice,'实际均价','account','交易所当前持仓加权均价；不是候选入场或成交时间。','#d8e1f0');
 add('mark',mark,'标记价','account','来自账户快照；K线收盘/最新价与标记价可能不同。','#6dbfff','dotted');
 const metric=(source:'exchange'|'advice',stop:number|null,target:number|null)=>{
  const risk=mark!==null&&stop!==null&&(mark-stop)*sign>0?Math.abs(mark-stop):null,reward=mark!==null&&target!==null&&(target-mark)*sign>0?Math.abs(target-mark):null;
  model.metrics.push({source,risk,reward,ratio:risk&&reward?reward/risk:null});
  if(!model.stale&&mark!==null){if(risk&&stop!==null)model.areas.push({source,kind:'risk',from:mark,to:stop});if(reward&&target!==null&&risk)model.areas.push({source,kind:'reward',from:mark,to:target});}
 };
 if(options.showOrders!==false){
  const current=options.accountCurrent&&protection.validity==='fresh';
  const describe=(order:ProtectionOrder)=>`${order.orderType} · ${order.workingType} · ${order.closePosition?'全部平仓':`剩余数量 ${order.remainingQuantity??'未知'}`}；条件触发不等于成交，限价单还可能无法成交。`;
  for(const [i,o] of protection.stops.slice(0,3).entries())add('order:'+o.id,o.triggerPrice,`${current?'已设':'旧/待核'}SL${i+1} · ${o.workingType==='MARK_PRICE'?'标记':'合约/未知'}`,'exchange',describe(o),'#f87983',current?'solid':'dotted');
  for(const [i,o] of protection.targets.slice(0,3).entries())add('order:'+o.id,o.triggerPrice,`${current?'已设':'旧/待核'}TP${i+1}`,'exchange',describe(o),'#42c6aa',current?'solid':'dotted');
  for(const o of protection.limits.slice(0,2))add('order:'+o.id,o.limitPrice,'限价减仓','exchange',describe(o),'#67b9c9','dashed');
  for(const o of protection.trailing.slice(0,2))add('order:'+o.id,o.activationPrice,'移动止损激活 · 非SL','exchange',describe(o),'#b8a0ed','dotted');
  if(protection.stops.length>3||protection.targets.length>3||protection.limits.length>2||protection.trailing.length>2)model.warnings.push('图表按类型限制线条密度，完整已读订单仍保留在订单面板中。');
  if(current)metric('exchange',protection.stops[0]?.triggerPrice??null,protection.targets[0]?.triggerPrice??null);
  else model.warnings.push('交易所订单过期或读取不完整，仅展示已读到的参考线，不绘制当前风险收益区域。');
 }
 if(options.showOriginal&&context.originalPlan){const plan=context.originalPlan.setup;add('original:sl',plan.stopLoss,'原计划SL','original','用户明确关联的原计划固定版本；不代表交易所已挂单。','#94a0b6','dotted');for(const [i,t]of plan.targets.entries())add('original:tp:'+i,t.price,'原计划TP'+(i+1),'original','原始研究计划目标，未覆盖实际委托。','#94a0b6','dotted');}
 if(options.advice&&options.showAdvice!==false){
  if(!options.adviceCurrent&&!options.historical)model.warnings.push('AI建议属于旧快照，已从当前图隐藏；请查看原审阅快照。');
  else{const advice=options.advice;
   if(advice.protection)add('advice:sl',advice.protection.price,'建议SL · 未设置','advice','经结构校验的人工复核参考；没有修改真实订单。','#ffb56b','dashed',advice.protection);
   for(const [i,t]of advice.targets.entries())add('advice:tp:'+i,t.price,'建议TP'+(i+1)+' · 未设置','advice','结构参考目标；没有下单或替换交易所止盈。','#b3a0ff','dashed',t);
   metric('advice',advice.protection?.price??context.existingProtectionReference?.price??(context.originalProtectionUsable?context.originalPlan!.setup.stopLoss:null),advice.targets[0]?.price??null);
  }
 }
 if(!options.accountCurrent)model.warnings.push('账户已变化、过期或断开；图中仅是原账户快照，区域已暂停。');
 model.warnings.push('色带表示标记价到参考价的剩余价格空间，按当前视口展示，不表示实际成交时间、成交保证或全仓覆盖。');
 return model;
}
