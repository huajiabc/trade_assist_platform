import { z } from 'zod';
import type { Candle } from './market';
import type { TradeSetup } from './analysis';
import { tradeRiskContext } from './tradeRisk';
import { calculateRiskReward } from './tradeGeometry';
export const planPolicySchema=z.object({profile:z.enum(['structural','micro']),minRiskPct:z.number().finite().min(0).max(10),minTargetPct:z.number().finite().min(0).max(20)}).strict();
export type PlanPolicy=z.infer<typeof planPolicySchema>;
/** Unbacktested research preferences: thresholds filter real structures, never manufacture prices. */
export const STRUCTURAL_PLAN_POLICY:PlanPolicy={profile:'structural',minRiskPct:.35,minTargetPct:.8};
export const MICRO_PLAN_POLICY:PlanPolicy={profile:'micro',minRiskPct:0,minTargetPct:0};
export function resolvePlanPolicy(raw?:unknown):PlanPolicy{return planPolicySchema.parse(raw??STRUCTURAL_PLAN_POLICY);}
export const samePlanPolicy=(a?:PlanPolicy,b?:PlanPolicy)=>{const x=a??MICRO_PLAN_POLICY,y=b??MICRO_PLAN_POLICY;return x.profile===y.profile&&x.minRiskPct===y.minRiskPct&&x.minTargetPct===y.minTargetPct;};
/** Aggregate only complete UTC-aligned, continuous 1m groups; never interpolate missing bars. */
export function planningVolatilityBars(candles:readonly Candle[]){
 const interval=candles.length>1?candles[1].timestamp-candles[0].timestamp:null;
 if(interval!==60)return {candles:[...candles],label:interval===null?'unknown':String(interval)+'s',derived:false};
 const groups=new Map<number,Candle[]>();for(const b of candles){const t=Math.floor(b.timestamp/300)*300;const group=groups.get(t)??[];group.push(b);groups.set(t,group);}
 const rows=[...groups].flatMap(([t,g])=>g.length===5&&g.every((b,i)=>b.timestamp===t+i*60)?[{timestamp:t,open:g[0].open,high:Math.max(...g.map(b=>b.high)),low:Math.min(...g.map(b=>b.low)),close:g.at(-1)!.close,volume:g.reduce((n,b)=>n+b.volume,0)}]:[]);
 return {candles:rows,label:'5m aggregated from complete 1m',derived:true};
}
export function planScaleContext(candles:readonly Candle[],policy:PlanPolicy,entry=candles.at(-1)?.close??0){
 const basis=policy.profile==='structural'?planningVolatilityBars(candles):{candles:[...candles],label:'input timeframe',derived:false};
 const ctx=tradeRiskContext(basis.candles),wide=policy.profile==='structural';
 if(ctx.intervalSeconds===null)ctx.atr=null;
 return {policy,referenceTimeframe:basis.label,sampleCount:basis.candles.length,atr:ctx.atr,minimumRiskDistance:Math.max(entry*policy.minRiskPct/100,(ctx.atr??0)*(wide?.75:.5)),minimumTargetDistance:Math.max(entry*policy.minTargetPct/100,(ctx.atr??0)*(wide?1.25:0)),minimumRR:wide?1.5:1,requiresMajorProtection:wide,rule:'先选真实保护结构与最近未清除阻挡，再检查幅度；不移动价格凑门槛'};
}
export function auditPlanScale(setup:Pick<TradeSetup,'anchorTime'|'entry'|'stopLoss'|'targets'|'direction'>,candles:readonly Candle[],policy:PlanPolicy){
 const context=planScaleContext(candles.filter(b=>b.timestamp<=setup.anchorTime),policy,setup.entry),geometry=calculateRiskReward(setup),targetDistance=Math.abs(setup.targets[0].price-setup.entry),epsilon=Math.abs(setup.entry)*Number.EPSILON*8;
 const errors:string[]=[];
 if(context.atr===null||context.atr<=0)errors.push('幅度筛选缺少14根完整参考周期K线或有效ATR，等待补足数据。');
 if(geometry.risk+epsilon<context.minimumRiskDistance)errors.push('保护幅度不足：至少'+policy.minRiskPct+'%及'+(policy.profile==='structural'?'0.75':'0.5')+'倍参考ATR；应选择有依据的更大结构，不能机械拉远止损。');
 if(targetDistance+epsilon<context.minimumTargetDistance)errors.push('首目标幅度不足：至少'+policy.minTargetPct+'%及'+(policy.profile==='structural'?'1.25':'0')+'倍参考ATR；不能越过近端阻挡去取远端目标。');
 if(geometry.ratio+epsilon<context.minimumRR)errors.push('真实首目标不足'+context.minimumRR+'R（基础1R之上按研究偏好筛选），不能压紧止损凑R。');
 return {context,riskDistance:geometry.risk,targetDistance,riskPct:geometry.risk/setup.entry*100,targetPct:targetDistance/setup.entry*100,ratio:geometry.ratio,errors};
}
