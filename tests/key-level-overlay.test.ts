import { describe, expect, it, vi } from 'vitest';
import { LineStyle, type PriceLineOptions, type SeriesAttachedParameter } from 'lightweight-charts';
import type { Analysis } from '../shared/analysis';
import { KeyLevelOverlay } from '../src/chart/KeyLevelOverlay';

type Level = Analysis['keyLevels'][number];
const level = (price = 1394.25, label = '近端空头缺口上沿'): Level => ({ label, price, reason: '未被突破的前期结构边界，仍需后续收盘确认。' });

/** Exercises Lightweight Charts public price-line and coordinate APIs. */
function harness(overlay = new KeyLevelOverlay()) {
  const active = new Map<object, Partial<PriceLineOptions>>();
  const createPriceLine = vi.fn((options: Partial<PriceLineOptions>) => {
    const line = { applyOptions: vi.fn((next: Partial<PriceLineOptions>) => active.set(line, { ...active.get(line), ...next })) };
    active.set(line, { ...options });
    return line;
  });
  const removePriceLine = vi.fn((line: object) => { active.delete(line); });
  const priceToCoordinate = vi.fn((price: number): number | null => 400 - price / 10);
  const pane = { getHeight: () => 400, paneIndex: () => 0 };
  const series = { createPriceLine, removePriceLine, priceToCoordinate, pane: () => pane, priceScale: () => ({ width: () => 70 }) };
  const requestUpdate = vi.fn();
  overlay.attached({ chart: { paneSize: () => ({ width: 600, height: 400 }), timeScale: () => ({ width: () => 600 }), panes: () => [pane] }, series, requestUpdate } as unknown as SeriesAttachedParameter);
  return { overlay, series, active, createPriceLine, removePriceLine, priceToCoordinate, requestUpdate };
}

describe('native AI key level overlay', () => {
  it('reuses native lines for existing versus suggested position prices with explicit styles',()=>{const h=harness();h.overlay.setData([{...level(95,'已设SL'),appearance:{color:'#f87983',style:'solid',unindexed:true}},{...level(96.5,'建议SL · 未设置'),appearance:{color:'#ffb56b',style:'dashed',unindexed:true}}],1);const lines=[...h.active.values()];expect(lines[0]).toMatchObject({price:95,title:'已设SL',lineStyle:LineStyle.Solid,color:'#f87983'});expect(lines[1]).toMatchObject({price:96.5,title:'建议SL · 未设置',lineStyle:LineStyle.Dashed,axisLabelTextColor:'#e2e9f4'});});
  it('creates exact native price lines without altering the validated prices or relying on canvas drawings', () => {
    const h = harness();
    const levels = [level(1408.35, '全段高点'), level()];
    const original = structuredClone(levels);
    h.overlay.setData(levels, null);
    expect([...h.active.values()].map(options => options.price)).toEqual([1408.35, 1394.25]);
    for (const options of h.active.values()) {
      expect(options).toMatchObject({ color: '#8094b5', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true });
      expect(options.title).toBeTruthy();
    }
    expect([...h.active.values()][0].title).toContain('全段高点');
    expect(levels).toEqual(original);
    expect(h.requestUpdate).toHaveBeenCalled();
  });

  it('retains data set before attachment and removes native lines when detached', () => {
    const overlay = new KeyLevelOverlay();
    overlay.setData([level(), level(1364.44, '中段主低点')], 1);
    const h = harness(overlay);
    expect(h.active.size).toBe(2);
    overlay.detached();
    expect(h.active.size).toBe(0);
    expect(h.removePriceLine).toHaveBeenCalledTimes(2);
    expect(overlay.hitTest(100, 260.575)).toBeNull();
    expect(overlay.autoscaleInfo()).toBeNull();
  });

  it('cleans old levels when a replacement analysis arrives and removes everything when hidden', () => {
    const h = harness();
    h.overlay.setData([level(), level(1364.44, '中段主低点')], null);
    h.overlay.setData([level(1400.4, '反弹较低高点')], null);
    expect([...h.active.values()].map(options => options.price)).toEqual([1400.4]);
    for (let update = 0; update < 3; update++) h.overlay.setData([level(1400.4, '反弹较低高点')], null);
    expect(h.active.size).toBe(1);
    h.overlay.setData([], null);
    expect(h.active.size).toBe(0);
    expect(h.overlay.hitTest(300, 259.96)).toBeNull();
  });

  it('highlights only the selected native line and autoscale includes only that level', () => {
    const h = harness();
    const levels = [level(1408.35, '全段高点'), level(1364.44, '中段主低点')];
    h.overlay.setData(levels, 1);
    const options = [...h.active.values()];
    expect(options[0]).toMatchObject({ color: '#8094b5', lineWidth: 1 });
    expect(options[1]).toMatchObject({ color: '#f0c674', lineWidth: 2, axisLabelVisible: true });
    expect(h.overlay.autoscaleInfo()?.priceRange).toEqual({ minValue: 1364.44, maxValue: 1364.44 });
    h.overlay.setData(levels, null);
    expect(h.overlay.autoscaleInfo()).toBeNull();
    expect([...h.active.values()].every(options => options.lineWidth === 1)).toBe(true);
    h.overlay.setData(levels, 99);
    expect(h.overlay.autoscaleInfo()).toBeNull();
  });

  it('uses the same multiplier for exact micro prices, rendering, picking and selected autoscale', () => {
    const h = harness();
    const price = 0.0000000000000000000139425;
    const multiplier = 1e22;
    h.overlay.setPriceMultiplier(multiplier);
    h.overlay.setData([level(price, '微小价格')], 0);
    const renderedPrice = price * multiplier;
    expect([...h.active.values()][0].price).toBe(renderedPrice);
    expect(h.overlay.hitTest(200, 400 - renderedPrice / 10)?.externalId).toBe('key-level:0');
    expect(h.priceToCoordinate).toHaveBeenCalledWith(renderedPrice);
    expect(h.overlay.autoscaleInfo()?.priceRange).toEqual({ minValue: renderedPrice, maxValue: renderedPrice });
    h.overlay.setPriceMultiplier(1e23);
    expect([...h.active.values()][0].price).toBe(price * 1e23);
    expect(h.overlay.autoscaleInfo()?.priceRange).toEqual({ minValue: price * 1e23, maxValue: price * 1e23 });
  });

  it('picks the nearest line within four CSS pixels using current native price coordinates', () => {
    const h = harness();
    h.overlay.setData([level(100, '第一价位'), level(125, '第二价位')], null);
    expect(h.overlay.hitTest(300, 387.5)?.externalId).toBe('key-level:1');
    expect(h.overlay.hitTest(300, 389.5)?.externalId).toBe('key-level:0');
    expect(h.overlay.hitTest(300, 394)?.externalId).toBe('key-level:0');
    expect(h.overlay.hitTest(300, 394.1)).toBeNull();
    h.priceToCoordinate.mockImplementation(price => 300 - price / 10);
    expect(h.overlay.hitTest(300, 390)).toBeNull();
    expect(h.overlay.hitTest(300, 290)?.externalId).toBe('key-level:0');
  });

  it.each([[-1, 390], [601, 390], [100, -1], [100, 401]])('does not steal clicks outside the candle pane (%s, %s)', (x, y) => {
    const h = harness();
    h.overlay.setData([level(100)], null);
    h.priceToCoordinate.mockReturnValue(y);
    expect(h.overlay.hitTest(x, y)).toBeNull();
  });

  it('ignores unmappable prices rather than inventing screen positions', () => {
    const h = harness();
    h.overlay.setData([level()], null);
    h.priceToCoordinate.mockReturnValue(null);
    expect(h.overlay.hitTest(200, 260.575)).toBeNull();
    h.priceToCoordinate.mockReturnValue(Number.NaN);
    expect(h.overlay.hitTest(200, 260.575)).toBeNull();
  });
});
