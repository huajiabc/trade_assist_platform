import { describe, expect, it, vi } from 'vitest';
import type { LiquiditySweep, TradeSetup } from '../shared/analysis';
import type { Candle } from '../shared/market';
import {
  distanceToSweepGeometry, distanceToTradeGeometry, mapLiquiditySweep, mapTradeSetup,
  SETUP_PROJECTION_BARS, setupRewardRisk, tradeSetupFocusRange,
} from '../src/chart/tradeCoordinates';

const setup = (overrides: Partial<TradeSetup> = {}): TradeSetup => ({
  id: 'setup-1', opportunityId: null, direction: 'bullish', status: 'candidate', anchorTime: 20,
  entry: 100, stopLoss: 90, targets: [{ price: 120, label: '前高' }, { price: 130, label: '延伸目标' }],
  structureIds: [], rationale: '等待回测后确认。', invalidation: '跌破保护位置。', ...overrides,
});
const sweep = (overrides: Partial<LiquiditySweep> = {}): LiquiditySweep => ({
  id: 'sweep-1', side: 'buy-side', levelTime: 10, sweepTime: 30, levelPrice: 120, extremePrice: 130,
  status: 'confirmed', rationale: '越过旧高后收回。', invalidation: '重新站稳旧高。', ...overrides,
});
const viewport = { width: 1_000, height: 500 };
const mapper = {
  timeToX: (time: number) => time * 5,
  timeToLogical: (time: number) => time / 10,
  logicalToX: (logical: number) => logical * 50,
  priceToY: (price: number) => 500 - price * 2,
};

describe('price-based risk/reward', () => {
  it('computes long and short ratios from prices rather than pixel heights', () => {
    expect(setupRewardRisk(setup(), 120)).toBe(2);
    expect(setupRewardRisk(setup({ direction: 'bearish', stopLoss: 110 }), 70)).toBe(3);
  });
  it('retains tiny-instrument precision and rejects inverted or zero risk', () => {
    expect(setupRewardRisk(setup({ entry: 1e-20, stopLoss: 0.9e-20 }), 1.2e-20)).toBeCloseTo(2);
    expect(setupRewardRisk(setup({ stopLoss: 100 }), 120)).toBeNull();
    expect(setupRewardRisk(setup({ stopLoss: 110 }), 120)).toBeNull();
    expect(setupRewardRisk(setup(), 80)).toBeNull();
  });
});

describe('candidate entry and risk/reward coordinates', () => {
  it('maps exact entry, stop and multiple targets with logical-bar projection', () => {
    const geometry = mapTradeSetup(setup(), mapper, viewport);
    expect(geometry).toEqual({
      id: 'setup-1', anchorX: 100, endX: 800, entryY: 300, stopY: 320,
      targets: [
        { price: 120, label: '前高', y: 260, rewardRisk: 2 },
        { price: 130, label: '延伸目标', y: 240, rewardRisk: 3 },
      ],
    });
  });
  it('maps short plans and calculates ratios independently on a logarithmic axis', () => {
    const short = setup({ direction: 'bearish', stopLoss: 110, targets: [{ price: 80, label: '前低' }] });
    const geometry = mapTradeSetup(short, { ...mapper, priceToY: (price) => 500 - Math.log10(price) * 100 }, viewport)!;
    expect(geometry.stopY).toBeLessThan(geometry.entryY);
    expect(geometry.targets[0].y).toBeGreaterThan(geometry.entryY);
    expect(geometry.targets[0].rewardRisk).toBe(2);
  });
  it('uses actual time for the anchor and never asks for a fabricated future timestamp', () => {
    const timeToX = vi.fn(mapper.timeToX);
    const logicalToX = vi.fn(mapper.logicalToX);
    mapTradeSetup(setup(), { ...mapper, timeToX, logicalToX }, viewport);
    expect(timeToX.mock.calls).toEqual([[20]]);
    expect(logicalToX.mock.calls).toEqual([[2 + SETUP_PROJECTION_BARS]]);
  });
  it('clips only the display projection, preserving partially offscreen actual anchors', () => {
    expect(mapTradeSetup(setup(), mapper, { width: 300, height: 500 })?.endX).toBe(296);
    expect(mapTradeSetup(setup({ anchorTime: -10 }), mapper, viewport)?.anchorX).toBe(-50);
    expect(mapTradeSetup(setup({ anchorTime: -200 }), mapper, viewport)).toBeNull();
    expect(mapTradeSetup(setup({ anchorTime: 300 }), mapper, viewport)).toBeNull();
  });
  it('supports zero coordinates and tiny prices with the same price multiplier as candles', () => {
    const tiny = setup({ anchorTime: 0, entry: 1e-20, stopLoss: 0.9e-20, targets: [{ price: 1.2e-20, label: '目标' }] });
    const geometry = mapTradeSetup(tiny, { ...mapper, priceToY: (price) => 500 - price * 1e20 * 100 }, viewport)!;
    expect(geometry.anchorX).toBe(0);
    expect(geometry.entryY).toBeCloseTo(400);
    expect(geometry.stopY).toBeCloseTo(410);
    expect(geometry.targets[0].y).toBeCloseTo(380);
    expect(geometry.targets[0].rewardRisk).toBeCloseTo(2);
  });
  it('rejects unavailable coordinates or plans without usable target levels', () => {
    expect(mapTradeSetup(setup(), { ...mapper, timeToLogical: () => null }, viewport)).toBeNull();
    expect(mapTradeSetup(setup(), { ...mapper, priceToY: () => NaN }, viewport)).toBeNull();
    expect(mapTradeSetup(setup({ targets: [] }), mapper, viewport)).toBeNull();
    expect(mapTradeSetup(setup({ targets: [{ price: 80, label: '错向目标' }] }), mapper, viewport)).toBeNull();
  });
  it('hit-tests level lines without capturing the entire filled risk area', () => {
    const geometry = mapTradeSetup(setup(), mapper, viewport)!;
    expect(distanceToTradeGeometry(geometry, 300, 300)).toBe(0);
    expect(distanceToTradeGeometry(geometry, 300, 310)).toBe(10);
    expect(distanceToTradeGeometry(geometry, 810, 320)).toBe(10);
  });
});

describe('liquidity sweep coordinates', () => {
  it('preserves both actual candle anchors and the exact sweep wick extreme', () => {
    expect(mapLiquiditySweep(sweep(), mapper, viewport)).toEqual({
      id: 'sweep-1', levelX: 50, sweepX: 150, levelY: 260, extremeY: 240,
    });
    expect(mapLiquiditySweep(sweep({ side: 'sell-side', levelPrice: 90, extremePrice: 80 }), mapper, viewport))
      .toMatchObject({ levelY: 320, extremeY: 340 });
  });
  it('keeps original offscreen swing points without inventing a border at the viewport edge', () => {
    expect(mapLiquiditySweep(sweep({ levelTime: -10 }), mapper, viewport)?.levelX).toBe(-50);
    expect(mapLiquiditySweep(sweep({ levelTime: -30, sweepTime: -10 }), mapper, viewport)).toBeNull();
    expect(mapLiquiditySweep(sweep(), { ...mapper, timeToX: () => null }, viewport)).toBeNull();
  });
  it('makes the swept level and wick selectable', () => {
    const geometry = mapLiquiditySweep(sweep(), mapper, viewport)!;
    expect(distanceToSweepGeometry(geometry, 100, 264)).toBe(4);
    expect(distanceToSweepGeometry(geometry, 150, 245)).toBe(0);
    expect(distanceToSweepGeometry(geometry, 160, 240)).toBe(10);
  });
});

describe('candidate selection viewport', () => {
  const candles: Candle[] = Array.from({ length: 100 }, (_, index) => ({
    timestamp: 1_700_000_000 + index * 3_600, open: 100, high: 110, low: 90, close: 105, volume: 100,
  }));
  it('focuses exact anchors and makes room for projection without inventing candles', () => {
    expect(tradeSetupFocusRange(candles, { anchorTime: candles[99].timestamp })).toEqual({ from: 56, to: 129 });
    expect(tradeSetupFocusRange(candles, { anchorTime: candles[0].timestamp })).toEqual({ from: -1, to: 30 });
    expect(candles).toHaveLength(100);
  });
  it('does not snap a missing or gapped time to another candle', () => {
    expect(tradeSetupFocusRange(candles, { anchorTime: candles[4].timestamp + 1 })).toBeNull();
    expect(tradeSetupFocusRange([], { anchorTime: 1 })).toBeNull();
  });
});
