import type { Candle } from './market';
/** Shared with the existing single-snapshot session; missing history is not a made-up revision. */
export function inspectClosedSnapshot(original:readonly Candle[], currentCandles:readonly Candle[], includeNewBars=true) {
 const current=new Map(currentCandles.map(c=>[c.timestamp,c]));let missingBars=0,revisedBars=0;
 for(const candle of original){const present=current.get(candle.timestamp);if(!present)missingBars++;else if(['open','high','low','close','volume'].some(key=>candle[key as keyof Candle]!==present[key as keyof Candle]))revisedBars++;}
 const originalTimes=new Set(original.map(c=>c.timestamp)),start=original[0]?.timestamp??0,asOf=original.at(-1)?.timestamp??0;
 revisedBars+=currentCandles.filter(c=>c.timestamp>=start&&c.timestamp<=asOf&&!originalTimes.has(c.timestamp)).length;
 const addedBars=includeNewBars?currentCandles.filter(c=>c.timestamp>asOf).length:0;
 return {stale:addedBars>0||revisedBars>0||missingBars>0,addedBars,revisedBars,missingBars};
}
