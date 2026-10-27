import { z } from 'zod';
import { contentId } from './researchData';
import { protectionSnapshotSchema, type ProtectionSnapshot } from './protectionOrders';
const number = z.number().finite();
const nullable = number.nullable();
export const exchangePositionSchema = z.object({
  id:z.string(), accountRef:z.string(), source:z.literal('binance-usdm'), symbol:z.string(),
  contractType:z.string().nullable(), quantityUnit:z.string().nullable(), marginAsset:z.string().nullable(),
  positionSide:z.enum(['BOTH','LONG','SHORT']), direction:z.enum(['bullish','bearish']), signedQuantity:number, quantity:number.positive(),
  entryPrice:nullable, markPrice:nullable, unrealizedPnl:nullable, leverage:nullable,
  marginMode:z.enum(['isolated','cross','unknown']), initialMargin:nullable, isolatedMargin:nullable,
  liquidationPrice:nullable, exchangeUpdateTime:nullable,
  validity:z.enum(['valid','incomplete']), warnings:z.array(z.string()),
}).strict();
export type ExchangePosition=z.infer<typeof exchangePositionSchema>;
export const accountSnapshotSchema=z.object({
  version:z.literal('account-1.0'), id:z.string(), accountRef:z.string(), source:z.literal('binance-usdm'),
  syncedAt:number, exchangeTime:number, expiresAt:number, positionMode:z.enum(['one-way','hedge','unknown']),
  positions:z.array(exchangePositionSchema).max(2000), zeroPositionCount:z.number().int().nonnegative(),
  balances:z.array(z.object({asset:z.string(),walletBalance:nullable,availableBalance:nullable,unrealizedPnl:nullable,marginBalance:nullable}).strict()).max(100),
  warnings:z.array(z.string()),
  orders:protectionSnapshotSchema.optional(),
}).strict();
export type AccountSnapshot=z.infer<typeof accountSnapshotSchema>;
export const accountStatusSchema=z.object({
  configured:z.boolean(), connected:z.boolean(), syncing:z.boolean(), readOnly:z.literal(true),
  credentialStorage:z.literal('server-environment'), pollIntervalMs:number, staleAfterMs:number,
  lastAttemptAt:nullable,lastSuccessAt:nullable,nextRetryAt:nullable,
  validity:z.enum(['fresh','partial','stale','unavailable','disconnected']),
  error:z.object({code:z.string(),message:z.string()}).strict().nullable(),snapshot:accountSnapshotSchema.nullable(),
}).strict();
export type AccountStatus=z.infer<typeof accountStatusSchema>;
export const ACCOUNT_POLL_MS=15_000, ACCOUNT_STALE_MS=45_000;
export const emptyAccountStatus=():AccountStatus=>({configured:false,connected:false,syncing:false,readOnly:true,credentialStorage:'server-environment',pollIntervalMs:ACCOUNT_POLL_MS,staleAfterMs:ACCOUNT_STALE_MS,lastAttemptAt:null,lastSuccessAt:null,nextRetryAt:null,validity:'disconnected',error:null,snapshot:null});
export function usableAccount(status:AccountStatus,now=Date.now()){return status.connected&&!status.error&&!!status.snapshot&&now<status.snapshot.expiresAt&&['fresh','partial'].includes(status.validity);}
export const positionIdentity=(p:ExchangePosition)=>contentId([p.accountRef,p.symbol,p.positionSide,p.signedQuantity,p.entryPrice,p.marginMode,p.leverage]);
export const marketAccountClocksMatch=(marketAsOf:number,exchangeTime:number)=>marketAsOf*1000-exchangeTime<=60000&&marketAsOf*1000-exchangeTime>=-120000;

const obj=(raw:unknown):Record<string,unknown>=>raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{};
const list=(raw:unknown):Record<string,unknown>[]=>Array.isArray(raw)?raw.map(obj):[];
const assetName=(raw:unknown)=>typeof raw==='string'&&/^[A-Z0-9_]{1,20}$/.test(raw)?raw:null;
export function exchangeNumber(raw:unknown):number|null {
  if(typeof raw!=='number'&&(typeof raw!=='string'||!/^[-+]?\d+(?:\.\d+)?$/.test(raw)))return null;
  const value=Number(raw);return Number.isFinite(value)&&Math.abs(value)<=Number.MAX_SAFE_INTEGER?value:null;
}
/** Explicit field projection: unrecognized exchange properties (including credentials) cannot escape. */
export function normalizeAccount(input:{account:unknown;risks:unknown;mode:unknown;exchangeInfo:unknown;accountRef:string;snapshotId:string;syncedAt:number;exchangeTime:number;orders?:ProtectionSnapshot}):AccountSnapshot {
  const account=obj(input.account), riskRows=Array.isArray(input.risks)?input.risks:null;
  if(!riskRows||!Array.isArray(account.positions)||!Array.isArray(account.assets))throw new Error('账户或持仓数据缺失，不能将缺失当作零持仓。');
  const symbols=new Map(list(obj(input.exchangeInfo).symbols).map(s=>[s.symbol,s]));
  const warnings:string[]=[], positions:ExchangePosition[]=[], modeValue=obj(input.mode).dualSidePosition;
  const positionMode=modeValue===true?'hedge':modeValue===false?'one-way':'unknown';
  if(positionMode==='unknown')warnings.push('持仓模式接口不可用，保留交易所positionSide，不合并多空。');
  let zeroPositionCount=0;
  for(const row of riskRows){
    // Binance also returns Unicode contract names; retain their exact identifiers.
    const raw=obj(row), symbol=typeof raw.symbol==='string'&&/^[\p{L}\p{N}_]{2,40}$/u.test(raw.symbol)?raw.symbol:null;
    const amount=exchangeNumber(raw.positionAmt),side=raw.positionSide;
    if(!symbol||amount===null||!['BOTH','LONG','SHORT'].includes(String(side))){warnings.push('存在无法解析的持仓行，账户覆盖不完整；没有将其视为零仓位。');continue;}
    if(amount===0){zeroPositionCount++;continue;}
    const direction=side==='LONG'?'bullish':side==='SHORT'?'bearish':amount>0?'bullish':'bearish', rowWarnings:string[]=[];
    if(side==='LONG'&&amount<0||side==='SHORT'&&amount>0)rowWarnings.push('持仓方向与数量符号冲突。');
    if(positionMode==='hedge'&&side==='BOTH'||positionMode==='one-way'&&side!=='BOTH')rowWarnings.push('持仓模式与positionSide不一致，请重新同步。');
    const detail=list(account.positions).find(p=>p.symbol===symbol&&p.positionSide===side),spec=symbols.get(symbol);
    if(!detail||exchangeNumber(detail.positionAmt)!==null&&exchangeNumber(detail.positionAmt)!==amount){rowWarnings.push('账户与持仓接口的数量或记录不一致，请重新同步。');warnings.push('账户与持仓接口不一致，未将部分读取当作完整仓位。');}
    const positive=(value:unknown)=>{const n=exchangeNumber(value);return n!==null&&n>0?n:null;};
    const entryPrice=positive(raw.entryPrice),markPrice=positive(raw.markPrice),unrealizedPnl=exchangeNumber(raw.unRealizedProfit);
    if(!entryPrice||!markPrice||unrealizedPnl===null)rowWarnings.push('缺少实际均价、标记价或交易所未实现盈亏。');
    const unit=assetName(spec?.baseAsset);
    if(!unit)rowWarnings.push('交易规则缺少数量单位，不能按张数或合约乘数推算金额。');
    if(!positive(raw.leverage)||!['cross','isolated'].includes(String(raw.marginType)))rowWarnings.push('杠杆或保证金模式缺失，风险解释受限。');
    if(exchangeNumber(detail?.positionInitialMargin??detail?.initialMargin)===null)rowWarnings.push('初始保证金未提供，不以本地估算冒充交易所数据。');
    positions.push({id:input.accountRef+':'+symbol+':'+side,accountRef:input.accountRef,source:'binance-usdm',symbol,positionSide:side as ExchangePosition['positionSide'],direction,
      signedQuantity:amount,quantity:Math.abs(amount),quantityUnit:unit,contractType:typeof spec?.contractType==='string'&&/^[A-Z_]{2,40}$/.test(spec.contractType)?spec.contractType:null,marginAsset:assetName(spec?.marginAsset),
      entryPrice,markPrice,unrealizedPnl,leverage:positive(raw.leverage),marginMode:raw.marginType==='isolated'?'isolated':raw.marginType==='cross'?'cross':'unknown',
      initialMargin:exchangeNumber(detail?.positionInitialMargin??detail?.initialMargin),isolatedMargin:exchangeNumber(raw.isolatedMargin),liquidationPrice:positive(raw.liquidationPrice),exchangeUpdateTime:positive(raw.updateTime),
      validity:rowWarnings.some(w=>/符号|不一致|均价/.test(w))?'incomplete':'valid',warnings:rowWarnings});
  }
  if(new Set(positions.map(p=>p.id)).size!==positions.length)throw new Error('重复持仓行，拒绝错误合并。');
  // Cross-endpoint consistency: an open position cannot disappear simply because positionRisk returned [].
  for(const row of list(account.positions))if(exchangeNumber(row.positionAmt)!==null&&exchangeNumber(row.positionAmt)!==0&&!positions.some(p=>p.symbol===row.symbol&&p.positionSide===row.positionSide))warnings.push('账户与持仓接口的非零仓位不一致，需重新同步。');
  return accountSnapshotSchema.parse({version:'account-1.0',id:input.snapshotId,accountRef:input.accountRef,source:'binance-usdm',syncedAt:input.syncedAt,exchangeTime:input.exchangeTime,expiresAt:input.syncedAt+ACCOUNT_STALE_MS,positionMode,positions,zeroPositionCount,
    balances:list(account.assets).map(a=>({asset:assetName(a.asset)??'UNKNOWN',walletBalance:exchangeNumber(a.walletBalance),availableBalance:exchangeNumber(a.availableBalance),unrealizedPnl:exchangeNumber(a.unrealizedProfit),marginBalance:exchangeNumber(a.marginBalance)})),warnings,...(input.orders?{orders:input.orders}:{})});
}
