import { describe, expect, it } from 'vitest';
import { extractStructureEvidence, mergeRuleStructures, selectStructureReferences, analysisBudgets } from '../shared/structureEvidence';
import { buildAnalysisPayload } from '../server/provider';
import type { Candle } from '../shared/market';
const bars = (length: number): Candle[] => Array.from({length},(_,i) => {
  const close = 100 + Math.sin(i * Math.PI / 9) * 5 + (i < 150 ? i * .06 : 18 - i * .06);
  const open = 100 + Math.sin((i - 1) * Math.PI / 9) * 5 + (i < 150 ? (i-1) * .06 : 18 - (i-1) * .06);
  return {timestamp: 1_790_000_000 + i * 60,open,close,high:Math.max(open,close)+.45+i*.00001,low:Math.min(open,close)-.4-i*.00001,volume:5};
});
describe('full-history deterministic structure evidence',()=>{
  it.each([60,168,299])('keeps rule structures throughout a %i bar interval without tail sampling',length=>{
    const candles=bars(length), e=extractStructureEvidence(candles);
    expect(e.candleCount).toBe(length);
    const ids=new Set(e.structures.map(item=>item.id)); expect(ids.size).toBe(e.structures.length);
    for(let part=0;part<3;part++) expect(e.structures.some(item=>item.timing.formedAt>=candles[Math.floor(part*length/3)].timestamp && item.timing.formedAt<=candles[Math.floor((part+1)*length/3)-1].timestamp)).toBe(true);
    for(const item of e.structures){
      expect(candles.some(c=>c.timestamp===item.startTime)).toBe(true);
      expect(candles.some(c=>c.timestamp===item.endTime)).toBe(true);
      if(item.timing.confirmedAt!==null) expect(item.timing.confirmedAt).toBeGreaterThanOrEqual(item.timing.formedAt);
    }
    expect(e.indicators).toEqual(extractStructureEvidence(candles).indicators);
  });
  it('never backdates a swing or close break to its historical origin',()=>{
    const candles=bars(168), full=extractStructureEvidence(candles);
    for(const item of full.structures.filter(item=>['HH','HL','LH','LL','BOS','CHoCH'].includes(item.type))){
      const index=candles.findIndex(c=>c.timestamp===item.timing.confirmedAt);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(extractStructureEvidence(candles.slice(0,index)).structures.some(x=>x.id===item.id)).toBe(false);
      const atConfirmation=extractStructureEvidence(candles.slice(0,index+1)).structures.find(x=>x.id===item.id);
      expect(atConfirmation?.type).toBe(item.type);
      expect(atConfirmation?.timing.confirmedAt).toBe(item.timing.confirmedAt);
      if(['HH','HL','LH','LL'].includes(item.type)) expect(item.timing.confirmedAt).toBe(candles[candles.findIndex(c=>c.timestamp===item.startTime)+item.scale].timestamp);
    }
  });
  it('retains records at overlapping core boundaries once and keeps global context authoritative',()=>{
    const candles=bars(299), e=extractStructureEvidence(candles);
    expect(e.windows).toHaveLength(4); expect(e.windows[1]).toMatchObject({coreStart:80,start:56,end:184});
    expect(e.merge.duplicateObservations).toBeGreaterThan(0);
    const near=e.structures.filter(item=>Math.abs(candles.findIndex(c=>c.timestamp===item.timing.formedAt)-80)<12);
    expect(near.length).toBeGreaterThan(0);
    const merged=mergeRuleStructures(near,[near,near.map(item=>({...item,rationale:'conflicting local context'}))]);
    expect(merged.structures).toEqual([...near].sort((a,b)=>a.timing.formedAt-b.timing.formedAt||a.id.localeCompare(b.id)));
    expect(merged.duplicates).toBe(near.length*2);
    expect(e.windows.flatMap(w=>w.evidenceIds).sort()).toEqual(e.structures.map(x=>x.id).sort());
  });
  it('allocates model references across historical windows and carries real coordinates and bounded type budgets',()=>{
    const candles=bars(299), e=extractStructureEvidence(candles), refs=selectStructureReferences(e,12);
    expect(refs).toHaveLength(12);
    for(const window of e.windows) expect(refs.some(x=>window.evidenceIds.includes(x.id))).toBe(true);
    const payload=buildAnalysisPayload({candles,context:{symbol:'TEST',timeframe:'1m',notes:''}});
    expect(payload.structureReview.totalDetected).toBe(e.structures.length);
    expect(payload.structureReview.providedCount+payload.structureReview.omittedCount).toBe(e.structures.length);
    expect(payload.candles).toEqual(candles);
    expect(payload.outputBudgets).toEqual(analysisBudgets(299));
    expect(analysisBudgets(299).structures).toBeGreaterThan(analysisBudgets(60).structures);
    expect(analysisBudgets(299).tradeSetups).toBe(2);
  });
  it('returns an honest empty catalog for flat or empty input, not invented pivots',()=>{
    expect(extractStructureEvidence([]).structures).toEqual([]);
    expect(extractStructureEvidence(bars(100).map(c=>({...c,open:100,high:100,low:100,close:100}))).structures).toEqual([]);
  });
});
