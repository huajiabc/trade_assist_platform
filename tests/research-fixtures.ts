import { FRAME_SECONDS, makeResearchBundle, type ResearchFrame, type FrameInput, type ResearchFact } from '../shared/researchData';
import type { Candle } from '../shared/market';
export const AS_OF=Math.floor(1790000000/900)*900;
export function frame(tf:ResearchFrame,count=40):FrameInput {
 const seconds=FRAME_SECONDS[tf];const high=tf==='15m'?112:tf==='5m'?104:101,low=tf==='15m'?90:tf==='5m'?95:99;
 const candles:Candle[]=Array.from({length:count},(_,i)=>({timestamp:AS_OF-(count-i)*seconds,open:100,high,low,close:tf==='1m'?100:101,volume:1}));
 return {timeframe:tf,symbol:'SNDKUSDT',source:'binance',closure:'exchange-confirmed',observedAt:AS_OF,lastClosedTime:candles.at(-1)?.timestamp??null,candles,derivedFrom:null,unavailableReason:null};
}
export const researchBundle=()=>makeResearchBundle('SNDKUSDT',['15m','5m','1m'].map(tf=>frame(tf as ResearchFrame)),AS_OF);
/** Explicit rule-evidence contract fixture for plan/lifecycle unit tests, not a detector accuracy fixture or market record. */
export function strategyFacts():ResearchFact[]{
 const make=(id:string,timeframe:ResearchFrame,type:string,direction:ResearchFact['direction'],low:number,knownAt:number,importance:ResearchFact['importance']='major'):ResearchFact=>({id,rawId:id,timeframe,type,direction,low,high:low,originTime:knownAt-FRAME_SECONDS[timeframe]*3,formedAt:knownAt,confirmedAt:knownAt,knownAt,resolvedAt:null,status:'confirmed',importance,familyId:id+'-event',source:'deterministic',rationale:'受控规则证据合同',invalidation:'反向收盘失效',evidenceTimes:[knownAt-FRAME_SECONDS[timeframe]],reclaimTime:null,reactionTime:null,tests:0});
 return [make('background','15m','BOS','bullish',95,AS_OF-2700),make('major-protect','15m','HL','bullish',90,AS_OF-1800),make('target','15m','HH','bullish',112,AS_OF-1800),
  make('five-break','5m','BOS','bullish',100,AS_OF-900),make('five-protect','5m','HL','bullish',95,AS_OF-600),make('local-trigger','1m','BOS','bullish',100,AS_OF-60,'local')];
}
