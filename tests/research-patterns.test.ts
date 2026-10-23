import {describe,it,expect} from 'vitest';
import {extractResearchPatterns} from '../shared/researchPatterns';
import {normalizeFrame,type ResearchFact,type FrameSnapshot} from '../shared/researchData';
import {AS_OF,frame,strategyFacts} from './research-fixtures';
const snapshot=(count=30)=>normalizeFrame(frame('5m',count),AS_OF);
const bos=(f:FrameSnapshot):ResearchFact=>({...strategyFacts()[3],id:'real-price-bos',type:'BOS',low:104,high:104,originTime:f.candles[16].timestamp,formedAt:f.candles[20].timestamp+300,confirmedAt:f.candles[20].timestamp+300,knownAt:f.candles[20].timestamp+300,evidenceTimes:[f.candles[16].timestamp,f.candles[20].timestamp]});
function displacement(){const f=snapshot();f.candles=f.candles.map(b=>({...b,open:100,close:100,high:101,low:99,volume:100}));f.candles[16].high=104;Object.assign(f.candles[20],{open:100,close:105,high:105.2,low:99.8,volume:250});Object.assign(f.candles[21],{open:104,close:104.8,high:105,low:102,volume:100});for(let i=22;i<f.candles.length;i++)Object.assign(f.candles[i],{open:104.5,close:104.5,high:105,low:104,volume:100});return f;}
const prefix=(f:FrameSnapshot,count:number)=>({...f,candles:f.candles.slice(0,count),lastClosedTime:f.candles[count-1].timestamp,observedAt:f.candles[count-1].timestamp+(f.timeframe==='15m'?900:300)});
describe('causal range, failed-breakout and strong displacement evidence',()=>{
 it('measures displacement against prior ATR/volume and distinguishes a later first reaction',()=>{
  const f=displacement(),b=bos(f);const known=extractResearchPatterns(prefix(f,21),f.candles.slice(0,21),[b]).find(x=>x.type==='displacement')!;expect(known).toBeDefined();expect(known.knownAt).toBe(f.candles[20].timestamp+300);expect(known.reactionTime).toBeNull();
  const full=extractResearchPatterns(f,f.candles,[b]).find(x=>x.type==='displacement')!;expect(full.id).toBe(known.id);expect(full.reactionTime).toBe(f.candles[21].timestamp+300);expect(full.tests).toBe(1);expect(full.volumeRatio).toBe(2.5);expect(full.displacementAtr).toBeGreaterThan(1.5);
 });
 it('rejects weak volume and counts distinct later retests without moving the origin',()=>{
  const f=displacement();f.candles[20].volume=100;expect(extractResearchPatterns(f,f.candles,[bos(f)]).some(x=>x.type==='displacement')).toBe(false);f.candles[20].volume=250;Object.assign(f.candles[25],{open:104,close:104.5,high:105,low:102});const d=extractResearchPatterns(f,f.candles,[bos(f)]).find(x=>x.type==='displacement')!;expect(d.tests).toBe(2);expect(d.originTime).toBe(f.candles[20].timestamp);
 });
 it('does not promote failure to reversal until the actual later CHoCH is knowable',()=>{
  const f=displacement(),b=bos(f);f.candles[21].close=103;Object.assign(f.candles[22],{open:101,close:98,high:102,low:97});const reverse={...b,id:'reverse',type:'CHoCH',direction:'bearish' as const,low:99,high:99,knownAt:f.candles[22].timestamp+300,confirmedAt:f.candles[22].timestamp+300};
  const before=extractResearchPatterns(prefix(f,22),f.candles.slice(0,22),[b,reverse]).find(x=>x.type==='failed-breakout')!;expect(before.confirmedAt).toBeNull();expect(before.status).toBe('candidate');expect(before.failureTime).toBe(f.candles[21].timestamp+300);
  const after=extractResearchPatterns(prefix(f,23),f.candles.slice(0,23),[b,reverse]).find(x=>x.type==='failed-breakout')!;expect(after.confirmedAt).toBe(reverse.knownAt);expect(after.knownAt).toBeGreaterThan(after.failureTime!);expect(after.relatedIds).toContain(reverse.id);
 });
 it('requires repeated confirmed range edges, fixes boundaries at confirmation and resolves only on later close',()=>{
  const f=normalizeFrame(frame('15m',60),AS_OF);f.candles=f.candles.map((b,i)=>{const price=100+6*Math.sin(i*Math.PI*2/7);return {...b,open:price,close:price,high:price+.5,low:price-.5,volume:100};});
  const refs:ResearchFact[]=[];for(let i=2;i<f.candles.length-2;i++){const bar=f.candles[i],near=f.candles.slice(i-2,i+3).filter((_,j)=>j!==2),high=near.every(b=>bar.high>b.high),low=near.every(b=>bar.low<b.low);if(!high&&!low)continue;const known=f.candles[i+2].timestamp+900;refs.push({...strategyFacts()[0],id:'pivot-'+i,timeframe:'15m',type:high?'HH':'LL',low:high?bar.high:bar.low,high:high?bar.high:bar.low,originTime:bar.timestamp,formedAt:bar.timestamp+900,knownAt:known,confirmedAt:known,evidenceTimes:[bar.timestamp,f.candles[i+2].timestamp]});}
  const historical=extractResearchPatterns(f,f.candles,refs).filter(x=>x.type==='trading-range');expect(historical.length).toBeGreaterThan(0);const r=historical[0];expect(r.relatedIds).toHaveLength(4);expect(r.relatedIds!.every(id=>refs.find(f=>f.id===id)!.knownAt<=r.knownAt)).toBe(true);
  const length=f.candles.findIndex(b=>b.timestamp+900===r.knownAt)+1;const atConfirmation=extractResearchPatterns(prefix(f,length),f.candles.slice(0,length),refs).find(x=>x.id===r.id)!;expect(atConfirmation.low).toBe(r.low);expect(atConfirmation.high).toBe(r.high);expect(atConfirmation.resolvedAt).toBeNull();
  const last=f.candles.at(-1)!;last.close=120;last.high=121;const broken=extractResearchPatterns(f,f.candles,refs).find(x=>x.id===r.id)!;expect(broken.resolvedAt).toBe(last.timestamp+900);expect(broken.knownAt).toBe(r.knownAt);expect(broken.low).toBe(r.low);
 });
});
