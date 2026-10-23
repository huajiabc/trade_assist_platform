import type { Candle } from './market';
import { tradeRiskContext } from './tradeRisk';
import { contentId, type ResearchFact, type FrameSnapshot } from './researchData';
export const PATTERN_RULES=Object.freeze({rangeLookback:48,rangeToleranceAtr:.35,rangeMaximumWidthAtr:8,failureBars:6,displacementAtr:1.5,minimumBodyShare:.65,minimumVolumeRatio:1.2});
export function extractResearchPatterns(frame:FrameSnapshot,bars:Candle[],base:ResearchFact[]):ResearchFact[]{
 base=base.filter(f=>f.knownAt<=(bars.at(-1)?.timestamp??0)+(frame.timeframe==='15m'?900:300));
 const result:ResearchFact[]=[],seconds=frame.timeframe==='15m'?900:300;
 const add=(kind:string,direction:ResearchFact['direction'],low:number,high:number,originTime:number,formedAt:number,confirmedAt:number|null,resolvedAt:number|null,refs:ResearchFact[],rationale:string,extra:Partial<ResearchFact>={})=>{
  const rawId=kind+'-'+contentId([originTime,formedAt,low,high,refs.map(f=>f.id)]);result.push({id:'tf-'+frame.timeframe+'-'+rawId,rawId,timeframe:frame.timeframe,type:kind,direction,low,high,originTime,formedAt,confirmedAt,knownAt:confirmedAt??formedAt,resolvedAt,status:resolvedAt!==null?'resolved':confirmedAt!==null?'confirmed':'candidate',importance:'major',familyId:refs[0]?.familyId??'event-'+direction+'-'+Math.floor(formedAt/900)*900,source:'deterministic',rationale,invalidation:'形成后反向收盘或原结构保护失守时取消研究假设。',evidenceTimes:[...new Set([originTime,formedAt-seconds,...refs.flatMap(f=>f.evidenceTimes)])],reclaimTime:null,reactionTime:null,tests:0,relatedIds:refs.map(f=>f.id),...extra});
 };
 if(frame.timeframe==='15m'){
  const seen=new Set<string>();
  for(let i=15;i<bars.length;i++){
   const window=bars.slice(Math.max(0,i-PATTERN_RULES.rangeLookback+1),i+1),known=bars[i].timestamp+900,atr=tradeRiskContext(window).atr;if(!atr)continue;
   const eligible=base.filter(f=>f.confirmedAt!==null&&f.knownAt<=known&&f.originTime>=window[0].timestamp);
   const highs=eligible.filter(f=>['HH','LH'].includes(f.type)),lows=eligible.filter(f=>['HL','LL'].includes(f.type));if(highs.length<2||lows.length<2)continue;
   const upper=Math.max(...highs.map(f=>f.high)),lower=Math.min(...lows.map(f=>f.low)),width=upper-lower;
   const highRefs=highs.filter(f=>upper-f.high<=atr*PATTERN_RULES.rangeToleranceAtr).slice(-2),lowRefs=lows.filter(f=>f.low-lower<=atr*PATTERN_RULES.rangeToleranceAtr).slice(-2);
   if(highRefs.length!==2||lowRefs.length!==2||Math.abs(highRefs[1].originTime-highRefs[0].originTime)<1800||Math.abs(lowRefs[1].originTime-lowRefs[0].originTime)<1800||width<atr*1.5||width>atr*PATTERN_RULES.rangeMaximumWidthAtr)continue;
   const refs=[...highRefs,...lowRefs],start=Math.min(...refs.map(f=>f.originTime)),inside=window.filter(b=>b.timestamp>=start);if(inside.length<5||inside.some(b=>b.close>upper||b.close<lower)||Math.abs(inside.at(-1)!.close-inside[0].close)>width*.6)continue;
   const key=contentId(refs.map(f=>f.id));if(seen.has(key))continue;seen.add(key);const broken=bars.slice(i+1).find(b=>b.close>upper||b.close<lower);
   add('trading-range','neutral',lower,upper,start,known,known,broken?broken.timestamp+900:null,refs,'15m至少两次已确认上沿及下沿摆点、收盘保持区间；边界在确认时固定，未用后续极值改写。');
  }
 }
 if(frame.timeframe==='5m')for(const bos of base.filter(f=>f.type==='BOS'&&f.confirmedAt!==null)){
  const direction=bos.direction==='bullish'?'bearish':'bullish',future=bars.filter(b=>b.timestamp>=bos.knownAt).slice(0,PATTERN_RULES.failureBars),failed=future.find(b=>direction==='bearish'?b.close<bos.low:b.close>bos.high);
  if(failed){const failureTime=failed.timestamp+300,reverse=base.filter(f=>f.type==='CHoCH'&&f.direction===direction&&f.confirmedAt!==null&&f.knownAt>=failureTime&&f.knownAt<=failureTime+PATTERN_RULES.failureBars*300).sort((a,b)=>a.knownAt-b.knownAt)[0];const known=reverse?.knownAt??failureTime;const invalid=bars.find(b=>b.timestamp>=known&&(direction==='bearish'?b.close>bos.high:b.close<bos.low));
   add('failed-breakout',direction,bos.low,bos.high,bos.originTime,failureTime,reverse?.knownAt??null,invalid?invalid.timestamp+300:null,[bos,...reverse?[reverse]:[]],'已收盘BOS后6根5m内收回原价位；只有随后反向CHoCH才确认失败突破反转。',{breakoutTime:bos.knownAt,failureTime,reactionTime:reverse?.knownAt??null});
  }
  const index=bars.findIndex(b=>b.timestamp+300===bos.knownAt);if(index<14)continue;const bar=bars[index],atr=tradeRiskContext(bars.slice(0,index)).atr,body=Math.abs(bar.close-bar.open),range=bar.high-bar.low,volume=bars.slice(Math.max(0,index-20),index).reduce((n,b)=>n+b.volume,0)/Math.min(index,20);
  if(!atr||range<=0||body<atr*PATTERN_RULES.displacementAtr||body/range<PATTERN_RULES.minimumBodyShare||volume<=0||bar.volume<volume*PATTERN_RULES.minimumVolumeRatio||(bos.direction==='bullish'?bar.close<=bar.open||bar.high-bar.close>range*.2:bar.close>=bar.open||bar.close-bar.low>range*.2))continue;
  const lower=Math.min(bar.open,bar.close),upper=Math.max(bar.open,bar.close),zoneLow=lower+body*.25,zoneHigh=upper-body*.25;
  let episodes=0,inside=false,reactionTime:number|null=null;for(const b of bars.slice(index+1)){const hit=b.low<=zoneHigh&&b.high>=zoneLow;if(hit&&!inside)episodes++;inside=hit;if(episodes===1&&hit&&(bos.direction==='bullish'?b.close>zoneHigh&&b.close>bos.high:b.close<zoneLow&&b.close<bos.low)&&reactionTime===null)reactionTime=b.timestamp+300;}
  const invalid=bars.slice(index+1).find(b=>bos.direction==='bullish'?b.close<bar.low:b.close>bar.high);
  add('displacement',bos.direction,bar.low,bar.high,bar.timestamp,bos.knownAt,bos.knownAt,invalid?invalid.timestamp+300:null,[bos],'位移实体至少1.5倍先前ATR、实体占振幅65%、量能至少先前均量1.2倍，且同根收盘BOS；仅研究首次25%–75%实体回撤反应。',{reactionTime,tests:episodes,volumeRatio:bar.volume/volume,displacementAtr:body/atr,zoneLow,zoneHigh});
 }
 return result;
}
