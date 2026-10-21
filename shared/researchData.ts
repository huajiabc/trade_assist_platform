import { z } from 'zod';
import { validateCandleRows, type Candle } from './market';
import { closedMarketCandles, type MarketSnapshot } from './liveMarket';
import { extractStructureEvidence, type EvidenceTiming } from './structureEvidence';

export const RESEARCH_FRAMES = ['15m', '5m', '1m'] as const;
export type ResearchFrame = typeof RESEARCH_FRAMES[number];
export const FRAME_SECONDS: Record<ResearchFrame, number> = { '15m': 900, '5m': 300, '1m': 60 };
export const FRAME_ROLES = { '15m': '市场背景', '5m': '机会结构', '1m': '入场触发' };
const candleSchema = z.object({timestamp:z.number(),open:z.number(),high:z.number(),low:z.number(),close:z.number(),volume:z.number()}).strict();
export const frameInputSchema = z.object({
  timeframe:z.enum(RESEARCH_FRAMES), symbol:z.string().trim().min(1).max(60), source:z.enum(['binance','csv','aggregated']),
  closure:z.enum(['exchange-confirmed','user-declared','derived-complete']), observedAt:z.number().int().nonnegative(),
  lastClosedTime:z.number().int().nonnegative().nullable(), candles:z.array(candleSchema).max(300),
  derivedFrom:z.string().max(80).nullable(), unavailableReason:z.string().max(500).nullable(),
}).strict();
export type FrameInput = z.infer<typeof frameInputSchema>;
export interface FrameSnapshot extends FrameInput {
  id:string; integrity:{usable:boolean; continuous:boolean; aligned:boolean; missingBars:number; stale:boolean; reasons:string[]};
}
export interface ResearchBundle { version:'1.0'; symbol:string; asOf:number; id:string; frames:Record<ResearchFrame,FrameSnapshot> }
/** Deterministic content identity, not a cryptographic authenticity claim. */
export function contentId(value:unknown):string { let hash=2166136261;for(const char of JSON.stringify(value)){hash^=char.charCodeAt(0);hash=Math.imul(hash,16777619);}return (hash>>>0).toString(36); }
export function normalizeFrame(raw:unknown, asOf:number):FrameSnapshot {
  const input=frameInputSchema.parse(raw), seconds=FRAME_SECONDS[input.timeframe];
  const rows=validateCandleRows(input.candles,0,300);
  if(input.lastClosedTime !== (rows.at(-1)?.timestamp??null))throw new Error('周期末根已收盘时间与行情不一致。');
  if(rows.some(bar=>bar.timestamp+seconds>input.observedAt))throw new Error('不能把未收盘行情声明为已确认的周期输入。');
  const candles=rows.filter(bar=>bar.timestamp+seconds<=asOf);
  const aligned=candles.every(bar=>bar.timestamp%seconds===0);
  let missingBars=0;
  for(let i=1;i<candles.length;i++)missingBars+=Math.max(0,Math.ceil((candles[i].timestamp-candles[i-1].timestamp)/seconds)-1);
  const continuous=candles.every((bar,i)=>i===0||bar.timestamp-candles[i-1].timestamp===seconds);
  const stale=!candles.length||asOf-(candles.at(-1)!.timestamp+seconds)>=seconds;
  const reasons:string[]=[];
  if(input.unavailableReason)reasons.push(input.unavailableReason);
  if(candles.length<14)reasons.push('少于14根，结构背景与波动依据不足');
  if(!aligned)reasons.push('UTC周期边界未对齐');if(!continuous)reasons.push('周期行情存在缺口');if(stale)reasons.push('最新已收盘数据落后于共同快照');
  if(input.source==='csv'&&input.closure!=='user-declared'||input.source==='binance'&&input.closure!=='exchange-confirmed'||input.source==='aggregated'&&input.closure!=='derived-complete')throw new Error('行情来源与收盘依据不一致。');
  if(input.source==='aggregated'&&!input.derivedFrom)throw new Error('聚合数据缺少真实来源快照引用。');
  const normalized={...input,candles,lastClosedTime:candles.at(-1)?.timestamp??null};
  return {...normalized,id:input.timeframe+'-'+contentId([input.symbol,input.source,input.closure,candles]),
    integrity:{usable:reasons.length===0,aligned,continuous,missingBars,stale,reasons}};
}
export function makeResearchBundle(symbol:string, inputs:FrameInput[], asOf:number):ResearchBundle {
  if(!Number.isSafeInteger(asOf)||asOf<0||asOf>4_102_445_700||inputs.length>3||new Set(inputs.map(f=>f.timeframe)).size!==inputs.length)throw new Error('多周期共同时间或周期集合无效。');
  const frames={} as Record<ResearchFrame,FrameSnapshot>;
  for(const tf of RESEARCH_FRAMES){const input=inputs.find(f=>f.timeframe===tf);
    if(input&&input.symbol!==symbol)throw new Error('多周期标的必须一致。');
    frames[tf]=normalizeFrame(input??{timeframe:tf,symbol,source:'csv',closure:'user-declared',observedAt:asOf,lastClosedTime:null,candles:[],derivedFrom:null,unavailableReason:'未提供该周期数据'},asOf);
  }
  return {version:'1.0',symbol,asOf,id:'bundle-'+contentId([asOf,...RESEARCH_FRAMES.map(tf=>[frames[tf].id,frames[tf].integrity])]),frames};
}
export function exchangeFrame(snapshot:MarketSnapshot):FrameInput {
  if(!RESEARCH_FRAMES.includes(snapshot.interval as ResearchFrame))throw new Error('研究工作台只接受15m/5m/1m。');
  const candles=closedMarketCandles(snapshot).slice(-300);
  return {timeframe:snapshot.interval as ResearchFrame,symbol:snapshot.symbol,source:'binance',closure:'exchange-confirmed',
    observedAt:Math.floor(snapshot.serverTime/1000),lastClosedTime:candles.at(-1)?.timestamp??null,candles,derivedFrom:null,unavailableReason:null};
}
export function csvResearchBundle(symbol:string, rows:Candle[], timeframe:ResearchFrame):ResearchBundle {
  validateCandleRows(rows,0,2000);rows=rows.slice(-300);const seconds=FRAME_SECONDS[timeframe],asOf=(rows.at(-1)?.timestamp??0)+(rows.length?seconds:0);
  const input:FrameInput={timeframe,symbol,source:'csv',closure:'user-declared',observedAt:asOf,lastClosedTime:rows.at(-1)?.timestamp??null,candles:rows.slice(-300),derivedFrom:null,unavailableReason:null};
  const inputs=[input];
  if(timeframe==='1m')for(const higher of ['5m','15m'] as const){
    const size=FRAME_SECONDS[higher]/60, groups=new Map<number,Candle[]>();
    for(const row of rows){const start=Math.floor(row.timestamp/FRAME_SECONDS[higher])*FRAME_SECONDS[higher];groups.set(start,[...(groups.get(start)??[]),row]);}
    const aggregated=[...groups].flatMap(([start,bars])=>bars.length===size&&bars.every((bar,i)=>bar.timestamp===start+i*60)&&start+FRAME_SECONDS[higher]<=asOf
      ?[{timestamp:start,open:bars[0].open,high:Math.max(...bars.map(b=>b.high)),low:Math.min(...bars.map(b=>b.low)),close:bars.at(-1)!.close,volume:bars.reduce((n,b)=>n+b.volume,0)}]:[]).slice(-300);
    inputs.push({timeframe:higher,symbol,source:'aggregated',closure:'derived-complete',observedAt:asOf,lastClosedTime:aggregated.at(-1)?.timestamp??null,candles:aggregated,derivedFrom:normalizeFrame(input,asOf).id,unavailableReason:aggregated.length?'':'缺少完整且边界对齐的1m分组'});
  }
  return makeResearchBundle(symbol,inputs,asOf);
}
export interface ResearchFact {
  id:string; rawId:string; timeframe:ResearchFrame; type:string; direction:'bullish'|'bearish'|'neutral'; low:number; high:number;
  originTime:number; formedAt:number; confirmedAt:number|null; knownAt:number; resolvedAt:number|null;
  status:'candidate'|'confirmed'|'resolved'; importance:'major'|'local'; familyId:string; source:'deterministic';
  rationale:string; invalidation:string; evidenceTimes:number[]; reclaimTime:number|null; reactionTime:number|null; tests:number;
}
export const factId=(tf:ResearchFrame,id:string)=>'tf-'+tf+'-'+id;
/** Every time here denotes the actual knowable CLOSE, while originTime remains the original candle-open coordinate. */
export function extractFrameFacts(frame:FrameSnapshot):ResearchFact[] {
  if(!frame.integrity.aligned)return [];
  const seconds=FRAME_SECONDS[frame.timeframe],segments:Candle[][]=[];
  for(const bar of frame.candles){const segment=segments.at(-1);if(!segment||bar.timestamp-segment.at(-1)!.timestamp!==seconds)segments.push([bar]);else segment.push(bar);}
  return segments.flatMap(candles=>{
    const evidence=extractStructureEvidence(candles), facts:ResearchFact[]=[];
    const timing=(t:EvidenceTiming)=>({originTime:t.originTime,formedAt:t.formedAt+seconds,confirmedAt:t.confirmedAt===null?null:t.confirmedAt+seconds,resolvedAt:t.resolvedAt===null?null:t.resolvedAt+seconds});
    const append=(rawId:string,type:string,direction:ResearchFact['direction'],low:number,high:number,t:EvidenceTiming,importance:'major'|'local',rationale:string,invalidation:string,evidenceTimes:number[],tests=0,reclaimTime:number|null=null,reactionTime:number|null=null)=>{
      const times=timing(t);facts.push({id:factId(frame.timeframe,rawId),rawId,timeframe:frame.timeframe,type,direction,low,high,...times,
        knownAt:times.confirmedAt??times.formedAt,status:times.resolvedAt!==null?'resolved':times.confirmedAt!==null?'confirmed':'candidate',importance,
        familyId:'event-'+direction+'-'+Math.floor((t.confirmedAt??t.formedAt)/900)*900,source:'deterministic',rationale,invalidation,evidenceTimes,reclaimTime,reactionTime,tests});
    };
    for(const s of evidence.structures){const zone=evidence.indicators.zones.find(z=>z.id===s.id);const touches=zone?candles.filter(b=>b.timestamp>zone.formedAt&&b.high>=zone.lowerPrice&&b.low<=zone.upperPrice):[];
      let episodes=0,inside=false;if(zone)for(const bar of candles.filter(b=>b.timestamp>zone.formedAt)){const hit=bar.high>=zone.lowerPrice&&bar.low<=zone.upperPrice;if(hit&&!inside)episodes++;inside=hit;}
      const reaction=zone?touches.find(b=>zone.direction==='bullish'?b.close>zone.upperPrice:b.close<zone.lowerPrice):undefined;
      append(s.id,s.type,s.direction,s.price,s.priceEnd??s.price,s.timing,s.importance,s.rationale,s.invalidation,s.evidenceTimes,episodes,null,reaction?reaction.timestamp+seconds:null);
    }
    for(const p of evidence.pivots){if(!facts.some(f=>f.rawId===p.id))append(p.id,'liquidity-'+p.side,'neutral',p.price,p.price,{originTime:p.time,formedAt:p.time,confirmedAt:p.confirmedAt,resolvedAt:candles.find(b=>b.timestamp>p.confirmedAt&&(p.side==='high'?b.close>p.price:b.close<p.price))?.timestamp??null},p.scale===5?'major':'local','已完成右侧确认的历史极值；仅为流动性代理参考。','收盘突破后不再作为未扫除参考。',[p.time,p.confirmedAt]);
      const future=candles.filter(b=>b.timestamp>p.confirmedAt);let broken=false;
      for(const b of future){if(broken)break;const crossed=p.side==='high'?b.high>p.price:b.low<p.price;const recovered=p.side==='high'?b.close<p.price:b.close>p.price;
        if(crossed){append('sweep-'+p.id+'-'+b.timestamp,'sweep',p.side==='high'?'bearish':'bullish',Math.min(p.price,b.low),Math.max(p.price,b.high),{originTime:p.time,formedAt:b.timestamp,confirmedAt:recovered?b.timestamp:null,resolvedAt:null},p.scale===5?'major':'local',recovered?'影线越过已知极值，且同根收盘已回到内侧；不代表实际挂单成交。':'价格越过参考位，尚未同根收复，仅为候选。','后续反向结构与真实保护位失效时取消研究情景。',[p.time,p.confirmedAt,b.timestamp],0,recovered?b.timestamp+seconds:null);break;}
        broken=p.side==='high'?b.close>p.price:b.close<p.price;
      }
    }
    return facts;
  }).filter(f=>f.knownAt<=frame.observedAt);
}
export function frameRegime(facts:ResearchFact[]):'uptrend'|'downtrend'|'range'|'transition' {
  const breaks=facts.filter(f=>['BOS','CHoCH'].includes(f.type)&&f.confirmedAt!==null).sort((a,b)=>a.knownAt-b.knownAt);
  const major=breaks.filter(f=>f.importance==='major'),last=(major.length?major:breaks).at(-1);
  return !last?'range':last.status==='resolved'||last.type==='CHoCH'?'transition':last.direction==='bullish'?'uptrend':'downtrend';
}
