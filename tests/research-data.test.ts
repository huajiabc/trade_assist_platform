import {describe,it,expect} from 'vitest';
import {csvResearchBundle,extractFrameFacts,makeResearchBundle,normalizeFrame,FRAME_SECONDS,RESEARCH_FRAMES} from '../shared/researchData';
import {AS_OF,frame} from './research-fixtures';
import {prepareResearchRequest} from '../server/workbench';
const raw=(f:ReturnType<typeof frame>)=>({...f});
describe('closed multi-timeframe data and causal rules',()=>{
 it('uses real OHLCV aggregation with volume, UTC boundaries and no partial final group',()=>{
  const bars=frame('1m',300).candles.map((c,i)=>({...c,open:100+i/100,close:100+(i+1)/100,high:101+i/100,low:99+i/100,volume:i+1}));
  const b=csvResearchBundle('SNDKUSDT',bars,'1m');
  expect(b.frames['5m'].candles).toHaveLength(60);expect(b.frames['15m'].candles).toHaveLength(20);
  expect(b.frames['5m'].candles[0]).toEqual({timestamp:bars[0].timestamp,open:bars[0].open,close:bars[4].close,high:bars[4].high,low:bars[0].low,volume:15});
  expect(b.frames['15m'].candles[0].volume).toBe(120);
  expect(b.frames['5m'].derivedFrom).toBe(b.frames['1m'].id);
  const partial=csvResearchBundle('SNDKUSDT',bars.slice(1,-2),'1m');
  expect(partial.frames['5m'].candles).toHaveLength(58);expect(partial.frames['15m'].candles).toHaveLength(18);
 });
 it('drops an incomplete higher group instead of filling a missing minute',()=>{
  const bars=frame('1m',300).candles.filter((_,i)=>i!==32),b=csvResearchBundle('SNDKUSDT',bars,'1m');
  expect(b.frames['5m'].candles).toHaveLength(59);expect(b.frames['15m'].candles).toHaveLength(19);
  expect(b.frames['1m'].integrity.usable).toBe(false);expect(b.frames['5m'].integrity.continuous).toBe(false);
  expect(b.frames['1m'].integrity.missingBars).toBe(1);
 });
 it('never infers lower frames from 5m/15m CSV and names the missing roles',()=>{
  const b=csvResearchBundle('SNDKUSDT',frame('5m').candles,'5m');expect(b.frames['1m'].candles).toEqual([]);expect(b.frames['15m'].integrity.usable).toBe(false);
 });
 it('rejects a forming higher bar declared closed, and excludes a future close from a shared cutoff',()=>{
  const f=frame('15m');f.observedAt=AS_OF-1;expect(()=>normalizeFrame(f,AS_OF)).toThrow(/未收盘/);
  f.observedAt=AS_OF;const cut=normalizeFrame(f,AS_OF-60);expect(cut.candles.at(-1)!.timestamp+900).toBeLessThanOrEqual(AS_OF-60);
  expect(cut.lastClosedTime).toBe(f.candles.at(-2)!.timestamp);
 });
 it('rejects inconsistent source, last-close metadata, duplicate frames and invalid raw values',()=>{
  const f=frame('1m');expect(()=>normalizeFrame({...f,lastClosedTime:1},AS_OF)).toThrow();
  expect(()=>normalizeFrame({...f,closure:'derived-complete'},AS_OF)).toThrow();
  expect(()=>makeResearchBundle('SNDKUSDT',[f,f],AS_OF)).toThrow();
  expect(()=>normalizeFrame({...f,candles:f.candles.map((b,i)=>i===0?{...b,high:1}:b)},AS_OF)).toThrow();
  expect(()=>makeResearchBundle('SNDKUSDT',[{...f,symbol:'BTCUSDT'}],AS_OF)).toThrow();
 });
 it('degrades misaligned data and detects stale snapshots without fabricated structure',()=>{
  const f=frame('1m');const shifted={...f,candles:f.candles.map(c=>({...c,timestamp:c.timestamp-1})),lastClosedTime:f.lastClosedTime!-1};
  const normalized=normalizeFrame(shifted,AS_OF);expect(normalized.integrity.aligned).toBe(false);expect(extractFrameFacts(normalized)).toEqual([]);
  expect(normalizeFrame(f,AS_OF+60).integrity.stale).toBe(true);
 });
 it('recomputes CSV aggregation provenance at the server boundary',()=>{
  const b=csvResearchBundle('SNDKUSDT',frame('1m',300).candles,'1m'),frames=RESEARCH_FRAMES.map(tf=>{const {id:_,integrity:__,...input}=b.frames[tf];return input;});
  const request={bundle:{symbol:b.symbol,asOf:b.asOf,frames},previous:{version:0,interpretation:null,changes:[]},provider:'mock',notes:''};
  expect(prepareResearchRequest(request).context.bundle.id).toBe(b.id);
  const bad=structuredClone(request);bad.bundle.frames[0].candles[0].volume+=1;expect(()=>prepareResearchRequest(bad)).toThrow(/重算/);
 });
 it.each(RESEARCH_FRAMES)('records %s confirmation as a real later close without lookahead',tf=>{
  const input=frame(tf,80);input.candles=input.candles.map((bar,i)=>{const close=100+Math.sin(i*.7)*7+i*.1;return {...bar,open:close-.2,close,high:close+1,low:close-1};});
  const full=extractFrameFacts(normalizeFrame(input,AS_OF));expect(full.length).toBeGreaterThan(0);
  for(let n=15;n<80;n+=13){const rows=input.candles.slice(0,n),asOf=rows.at(-1)!.timestamp+FRAME_SECONDS[tf];const known=extractFrameFacts(normalizeFrame({...input,candles:rows,lastClosedTime:rows.at(-1)!.timestamp,observedAt:asOf},asOf));
   for(const f of known){expect(f.knownAt).toBeLessThanOrEqual(asOf);const later=full.find(x=>x.id===f.id);if(later)expect([later.low,later.high,later.confirmedAt]).toEqual([f.low,f.high,f.confirmedAt]);}
  }
 });
 it('does not infer a cross-gap break from missing candles',()=>{
  const f=frame('1m',60);f.candles=f.candles.filter((_,i)=>i!==30);const normalized=normalizeFrame(f,AS_OF);
  for(const fact of extractFrameFacts(normalized)){const left=fact.evidenceTimes.filter(t=>t<f.candles[30].timestamp),right=fact.evidenceTimes.filter(t=>t>=f.candles[30].timestamp);expect(left.length&&right.length).toBeFalsy();}
 });
});
