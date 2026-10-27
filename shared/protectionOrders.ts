import { z } from 'zod';
import type { AccountSnapshot, ExchangePosition } from './account';

const numeric=z.number().finite().nullable();
export const protectionOrderSchema=z.object({
 id:z.string(),exchangeId:z.string(),venue:z.enum(['standard','algo']),symbol:z.string(),positionSide:z.enum(['BOTH','LONG','SHORT']),side:z.enum(['BUY','SELL']),
 kind:z.enum(['stop-loss','take-profit','trailing-stop','limit','other']),orderType:z.string(),status:z.string(),
 triggerPrice:numeric,limitPrice:numeric,activationPrice:numeric,callbackRate:numeric,quantity:numeric,executedQuantity:numeric,remainingQuantity:numeric,
 reduceOnly:z.boolean().nullable(),closePosition:z.boolean().nullable(),workingType:z.enum(['MARK_PRICE','CONTRACT_PRICE','UNKNOWN']),priceProtect:z.boolean().nullable(),
 createdAt:numeric,updatedAt:numeric,warnings:z.array(z.string()),
}).strict();
export type ProtectionOrder=z.infer<typeof protectionOrderSchema>;
export const protectionSnapshotSchema=z.object({
 syncedAt:z.number(),expiresAt:z.number(),validity:z.enum(['fresh','partial','unavailable']),
 standardAvailable:z.boolean(),algoAvailable:z.boolean(),orders:z.array(protectionOrderSchema).max(2000),warnings:z.array(z.string()),
}).strict();
export type ProtectionSnapshot=z.infer<typeof protectionSnapshotSchema>;
const num=(v:unknown)=>{if(typeof v!=='number'&&(typeof v!=='string'||!/^[-+]?\d+(?:\.\d+)?$/.test(v)))return null;const n=Number(v);return Number.isFinite(n)&&Math.abs(n)<=Number.MAX_SAFE_INTEGER?n:null;};
const positive=(v:unknown)=>{const n=num(v);return n!==null&&n>0?n:null;};
const boolean=(v:unknown)=>v===true||v==='true'?true:v===false||v==='false'?false:null;
const text=(v:unknown,regex:RegExp)=>typeof v==='string'&&regex.test(v)?v:null;

/** Field projection only. Client IDs and arbitrary upstream messages never leave the server. */
export function normalizeProtectionOrders(input:{standard:unknown;algo:unknown;syncedAt:number;staleAfterMs:number}):ProtectionSnapshot{
 const orders:ProtectionOrder[]=[],warnings:string[]=[];
 let standardAvailable=Array.isArray(input.standard),algoAvailable=Array.isArray(input.algo);
 for(const venue of ['standard','algo'] as const){
  const rows=venue==='standard'?input.standard:input.algo;
  if(!Array.isArray(rows)){warnings.push((venue==='standard'?'普通':'条件/Algo')+'订单读取失败，不能据此判定未设置SL/TP。');continue;}
  for(const row of rows){
   const raw=row&&typeof row==='object'?row as Record<string,unknown>:{};
   const symbol=text(raw.symbol,/^[\p{L}\p{N}_]{2,40}$/u),side=raw.side,positionSide=raw.positionSide;
   const rawId=venue==='standard'?raw.orderId:raw.algoId;
   const exchangeId=typeof rawId==='string'&&/^\d{1,30}$/.test(rawId)?rawId:typeof rawId==='number'&&Number.isSafeInteger(rawId)&&rawId>=0?String(rawId):null;
   const orderType=text(venue==='standard'?raw.origType??raw.type:raw.orderType,/^[A-Z_]{2,40}$/),status=text(venue==='standard'?raw.status:raw.algoStatus,/^[A-Z_]{2,30}$/);
   if(!symbol||!exchangeId||!orderType||!status||!['BUY','SELL'].includes(String(side))||!['BOTH','LONG','SHORT'].includes(String(positionSide))){warnings.push('存在无法解析的订单，保护单覆盖不完整。');continue;}
   if(['CANCELED','CANCELLED','FILLED','FINISHED','EXPIRED','REJECTED','TRIGGERED'].includes(status))continue;
   const rowWarnings:string[]=[];
   if(!['NEW','WORKING','PARTIALLY_FILLED'].includes(status))rowWarnings.push('订单状态尚不能视为有效挂单，请在交易所复核。');
   const kind=orderType==='TRAILING_STOP_MARKET'?'trailing-stop':orderType.startsWith('TAKE_PROFIT')?'take-profit':orderType.startsWith('STOP')?'stop-loss':orderType==='LIMIT'?'limit':'other';
   const quantity=num(venue==='standard'?raw.origQty:raw.quantity),executedQuantity=venue==='standard'?num(raw.executedQty):null;
   const remainingQuantity=quantity!==null&&quantity>=0?(executedQuantity===null?quantity:Math.max(0,quantity-executedQuantity)):null;
   const closePosition=boolean(raw.closePosition),reduceOnly=boolean(raw.reduceOnly);
   if(quantity!==null&&quantity<0||executedQuantity!==null&&(executedQuantity<0||quantity!==null&&executedQuantity>quantity))rowWarnings.push('订单数量或已成交数量异常。');
   if(venue==='standard'&&executedQuantity===null&&!closePosition)rowWarnings.push('订单已成交数量缺失，不能确认剩余覆盖。');
   const triggerPrice=kind==='trailing-stop'?null:positive(venue==='standard'?raw.stopPrice:raw.triggerPrice);
   if(['stop-loss','take-profit'].includes(kind)&&triggerPrice===null)rowWarnings.push('条件触发价缺失，不能绘制精确SL/TP。');
   if(!closePosition&&remainingQuantity===null)rowWarnings.push('剩余数量缺失，不能确认覆盖比例。');
   const order:ProtectionOrder={id:venue+':'+exchangeId,exchangeId,venue,symbol,positionSide:positionSide as ProtectionOrder['positionSide'],side:side as ProtectionOrder['side'],kind,orderType,status,
    triggerPrice,limitPrice:positive(raw.price),activationPrice:positive(raw.activatePrice??raw.activationPrice),callbackRate:positive(raw.priceRate??raw.callbackRate),quantity,executedQuantity,remainingQuantity,
    reduceOnly,closePosition,workingType:raw.workingType==='MARK_PRICE'?'MARK_PRICE':raw.workingType==='CONTRACT_PRICE'?'CONTRACT_PRICE':'UNKNOWN',priceProtect:boolean(raw.priceProtect),
    createdAt:positive(raw.time??raw.createTime),updatedAt:positive(raw.updateTime),warnings:rowWarnings};
   orders.push(order);
   // Some conditional responses carry attached legs. Preserve each trigger, never infer it from a limit price.
   for(const [field,leg] of [['slTriggerPrice','stop-loss'],['tpTriggerPrice','take-profit']] as const){const price=positive(raw[field]);if(price!==null&&(leg!==kind||price!==triggerPrice))orders.push({...order,id:order.id+':'+leg,kind:leg,triggerPrice:price,limitPrice:positive(raw[leg==='stop-loss'?'slPrice':'tpPrice'])});}
  }
 }
 const unique=new Map<string,ProtectionOrder>();for(const order of orders){if(unique.has(order.id)){warnings.push('重复订单ID，保护单覆盖需复核。');continue;}unique.set(order.id,order);}
 const projected=[...unique.values()];if(projected.some(o=>o.warnings.length))warnings.push('部分订单字段不足，不能将所有返回项都视为有效保护。');
 return protectionSnapshotSchema.parse({syncedAt:input.syncedAt,expiresAt:input.syncedAt+input.staleAfterMs,standardAvailable,algoAvailable,
  validity:!standardAvailable&&!algoAvailable?'unavailable':warnings.length?'partial':'fresh',orders:projected,warnings:[...new Set(warnings)]});
}
export interface PositionProtection {
 validity:'fresh'|'partial'|'unavailable'|'stale';syncedAt:number|null;expiresAt:number|null;
 stops:ProtectionOrder[];targets:ProtectionOrder[];trailing:ProtectionOrder[];limits:ProtectionOrder[];uncertain:ProtectionOrder[];
 stopCoverageQuantity:number|null;stopCoverage:'full'|'partial'|'none'|'unknown';warnings:string[];
}
/** Only closing intent is associated. Symbol/direction alone is not proof of a protective order. */
export function positionProtection(snapshot:Pick<AccountSnapshot,'orders'>,position:ExchangePosition,now=Date.now()):PositionProtection{
 const data=snapshot.orders;
 const result:PositionProtection={validity:!data?'unavailable':now>=data.expiresAt?'stale':data.validity,syncedAt:data?.syncedAt??null,expiresAt:data?.expiresAt??null,stops:[],targets:[],trailing:[],limits:[],uncertain:[],stopCoverageQuantity:null,stopCoverage:'unknown',warnings:[...(data?.warnings??['尚未读取交易所普通与Algo挂单，无法核对现有SL/TP。'])]};
 const closingSide=position.direction==='bullish'?'SELL':'BUY';
 for(const order of data?.orders??[]){
  if(order.symbol!==position.symbol||order.positionSide!==position.positionSide||order.side!==closingSide)continue;
  const hedgeClose=position.positionSide!=='BOTH';
  if(!(order.reduceOnly===true||order.closePosition===true||hedgeClose)||order.warnings.length||!['NEW','WORKING','PARTIALLY_FILLED'].includes(order.status)||order.closePosition!==true&&order.remainingQuantity===0){result.uncertain.push(order);continue;}
  if(order.kind==='stop-loss')result.stops.push(order);else if(order.kind==='take-profit')result.targets.push(order);else if(order.kind==='trailing-stop')result.trailing.push(order);else if(order.kind==='limit')result.limits.push(order);else result.uncertain.push(order);
 }
 const sign=position.direction==='bullish'?1:-1;
 result.targets.sort((a,b)=>sign*((a.triggerPrice??0)-(b.triggerPrice??0)));
 result.stops.sort((a,b)=>-sign*((a.triggerPrice??0)-(b.triggerPrice??0)));
 if(result.validity==='fresh'){
  // Do not sum several conditional alternatives: they may cancel one another or compete for margin.
  const quantity=Math.max(0,...result.stops.map(o=>o.closePosition?position.quantity:o.remainingQuantity??0));
  result.stopCoverageQuantity=Math.min(position.quantity,quantity);result.stopCoverage=quantity>=position.quantity?'full':quantity>0?'partial':'none';
 }
 if(result.uncertain.length)result.warnings.push('有同向平仓侧订单无法确认保护用途或状态，已单独列出，不计入保护覆盖。');
 if(result.trailing.length)result.warnings.push('移动止损的激活价不是当前止损价；未取得实时追踪价，不绘制固定SL。');
 if(result.validity==='fresh'&&result.stopCoverage==='none')result.warnings.push(result.trailing.length?'仅发现移动止损，固定SL覆盖未确认。':'本次未查到匹配的固定止损订单；未关联或外部保护不在此结论内。');
 if(result.stopCoverage==='partial')result.warnings.push('匹配的单笔固定止损数量小于当前持仓，不能确认全仓覆盖。');
 return result;
}
