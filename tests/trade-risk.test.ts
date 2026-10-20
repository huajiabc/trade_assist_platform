import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Candle } from '../shared/market';
import { auditStopRisk, tradeRiskContext } from '../shared/tradeRisk';
import { TradeStopAudit } from '../src/components/TradeStopAudit';
import { buildAnalysisPayload, SYSTEM_PROMPT } from '../server/provider';

function bars(count = 30, scale = 1): Candle[] {
  return Array.from({ length: count }, (_, index) => ({ timestamp: 1790000000 + index * 60,
    open: 100 * scale, high: 101 * scale, low: 99 * scale, close: 100 * scale, volume: 1 }));
}
const plan = { anchorTime: bars().at(-1)!.timestamp, direction: 'bearish' as const, entry: 100, stopLoss: 103, targets: [{ price: 94, label: '支撑' }] };

describe('snapshot stop risk and structural buffers', () => {
  it('seeds RMA from true ranges and includes previous-close gaps', () => {
    const data = bars(15);
    data[14] = { ...data[14], open: 104, low: 103, high: 105, close: 104 };
    expect(tradeRiskContext(data.slice(0,14)).atr).toBe(2);
    // Last true range is 5, not the candle high-low of 2.
    expect(tradeRiskContext(data).atr).toBeCloseTo((13*2+5)/14, 12);
    data[15] = { ...data[14], timestamp:data[14].timestamp+60, low:104, high:106, close:105 };
    expect(tradeRiskContext(data).atr).toBeCloseTo(((13*2+5)/14*13+2)/14, 12);
  });
  it.each([0,1,13])('leaves volatility unknown for %i bars', count => {
    const context = tradeRiskContext(bars(count));
    expect(context.atr).toBeNull();expect(context.minimumRiskDistance).toBeNull();
    expect(auditStopRisk(plan,bars(count)).errors.join(' ')).toContain('不足14根');
  });
  it('does not treat a zero-volatility window as a zero-distance stop permission', () => {
    const data=bars().map(bar=>({...bar,high:100,low:100}));
    expect(tradeRiskContext(data).atr).toBe(0);
    expect(auditStopRisk(plan,data).riskAtr).toBeNull();
    expect(auditStopRisk(plan,data).errors.join(' ')).toContain('ATR为零');
  });
  it('keeps the original interval and does not turn irregular bars into higher-timeframe evidence', () => {
    expect(tradeRiskContext(bars()).intervalSeconds).toBe(60);
    const data=bars();data[29].timestamp+=60;
    expect(tradeRiskContext(data).intervalSeconds).toBeNull();
  });
  it('does not use bars after the plan snapshot, and does not mutate any reference prices', () => {
    const data=bars(), input=Object.freeze({...plan,targets:Object.freeze(plan.targets)});
    const baseline=auditStopRisk(plan,data,{low:101,high:102});
    data.push({...data[29],timestamp:data[29].timestamp+60,high:150});
    const result=auditStopRisk(input as typeof plan,data,{low:101,high:102});
    expect(result).toEqual(baseline);expect(input.stopLoss).toBe(103);expect(result.context.sampleCount).toBe(30);
  });
  it.each(['bullish','bearish'] as const)('rejects a %s stop only 0.01 outside the protection, even with enough entry risk', direction => {
    const long=direction==='bullish';
    const result=auditStopRisk({...plan,direction,entry:long?104:100,stopLoss:long?100.99:103.01,
      targets:[{price:long?110:94,label:'结构目标'}]},bars(),{low:101,high:103});
    expect(result.riskAtr).toBeGreaterThan(1);
    expect(result.structuralBuffer).toBeCloseTo(.01,12);
    expect(result.errors.join(' ')).toContain('0.25 ATR');
  });
  it.each(['bullish','bearish'] as const)('requires a %s stop outside the correct outer edge of a zone', direction=>{
    const long=direction==='bullish';
    const result=auditStopRisk({...plan,direction,entry:long?104:100,stopLoss:102,
      targets:[{price:long?110:94,label:'目标'}]},bars(),{low:101,high:103});
    expect(result.errors.join(' ')).toContain('保护结构之外');
  });
  it('rejects risk inside the minimum noise filter even with enough structural buffer',()=>{
    const result=auditStopRisk({...plan,stopLoss:100.75},bars(),{low:99,high:100});
    expect(result.structuralBuffer).toBe(.75);
    expect(result.errors.join(' ')).toContain('0.5 ATR');
  });
  it('accepts the exact minimums and warns rather than asserting a safe noise distance',()=>{
    const result=auditStopRisk({...plan,stopLoss:101},bars(),{low:99,high:100.5});
    expect(result.errors).toEqual([]);expect(result.warnings.join(' ')).toContain('不足1 ATR');
    expect(result.riskAtr).toBe(.5);expect(result.bufferAtr).toBe(.25);
  });
  it('reviews broad structural stops instead of silently tightening them to a hard maximum',()=>{
    const result=auditStopRisk({...plan,stopLoss:114,targets:[{price:80,label:'真实目标'}]},bars(),{low:110,high:112});
    expect(result.errors).toEqual([]);expect(result.riskAtr).toBe(7);
    expect(result.warnings.join(' ')).toContain('超过6 ATR');
  });
  it('uses price-relative precision for micro-priced instruments',()=>{
    const scale=1e-10,data=bars(30,scale);
    const result=auditStopRisk({...plan,entry:100*scale,stopLoss:103*scale,targets:[{price:94*scale,label:'目标'}]},data,{low:101*scale,high:102*scale});
    expect(result.errors).toEqual([]);expect(result.riskAtr).toBeCloseTo(1.5,12);expect(result.bufferAtr).toBeCloseTo(.5,12);
    expect(auditStopRisk({...plan,entry:100*scale,stopLoss:103.01*scale,targets:[{price:94*scale,label:'目标'}]},data,{low:101*scale,high:103*scale}).errors.join(' ')).toContain('0.25 ATR');
  });
  it('shares exact deterministic metrics and policy with the model without generating a stop',()=>{
    const data=bars(),payload=buildAnalysisPayload({candles:data,context:{symbol:'SNDKUSDT',timeframe:'1m',notes:'已收盘快照'}});
    expect(payload.tradeRiskContext).toEqual(tradeRiskContext(data));
    expect(payload.tradeRiskContext).toMatchObject({atr:2,intervalSeconds:60,minimumRiskDistance:1,minimumStructureBuffer:.5});
    expect(payload).not.toHaveProperty('tradeSetups');expect(SYSTEM_PROMPT).toContain('不能把目标移到无依据价位');
  });
  it('shows actual ATR and structural padding, snapshot time and uncalibrated policy in the plan panel',()=>{
    const audit=auditStopRisk(plan,bars(),{low:101,high:102});
    const html=renderToStaticMarkup(createElement(TradeStopAudit,{audit}));
    expect(html).toContain('止损与波动检查');expect(html).toContain('1分钟');expect(html).toContain('1.5 ×');
    expect(html).toContain('结构外止损缓冲');expect(html).toContain('0.5 ATR');expect(html).toContain('参数未经回测');
    expect(html).toContain('不随实时价格自动移动止损');
    const incomplete=renderToStaticMarkup(createElement(TradeStopAudit,{audit:auditStopRisk(plan,bars(10))}));
    expect(incomplete).toContain('样本不足');expect(incomplete).toContain('无法核验');expect(incomplete).not.toContain('NaN');
  });
});
