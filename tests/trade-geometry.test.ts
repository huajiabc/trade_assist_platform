import { describe, expect, it } from 'vitest';
import type { TradeSetup } from '../shared/analysis';
import { calculateRiskReward } from '../shared/tradeGeometry';

const setup = (direction: 'bullish' | 'bearish' = 'bullish'): TradeSetup => ({
  id: 'reference', opportunityId: null, direction, status: 'candidate', anchorTime: 1_700_000_000,
  entry: 100, stopLoss: direction === 'bullish' ? 98 : 102,
  targets: [{ price: direction === 'bullish' ? 104 : 96, label: '2R' }, { price: direction === 'bullish' ? 106 : 94, label: '3R' }],
  tracking: null, basis: null, structureIds: ['basis'], trigger: '等待独立确认。', rationale: 'Reference only', invalidation: 'Cancel if invalidated',
});

describe('direction-aware risk/reward geometry', () => {
  it.each(['bullish', 'bearish'] as const)('maps %s levels to positive price risk and reward', direction => {
    expect(calculateRiskReward(setup(direction))).toEqual({ risk: 2, reward: 4, ratio: 2, riskPct: 2, rewardPct: 4 });
    expect(calculateRiskReward(setup(direction), 1).ratio).toBe(3);
  });

  it('keeps ratios consistent for tiny-priced markets without rounding coordinates', () => {
    const trade = setup();
    trade.entry *= 1e-14;
    trade.stopLoss *= 1e-14;
    trade.targets = trade.targets.map(target => ({ ...target, price: target.price * 1e-14 }));
    const values = calculateRiskReward(trade);
    expect(values.ratio).toBeCloseTo(2, 10);
    expect(values.riskPct).toBeCloseTo(2, 10);
    expect(values.risk).toBeGreaterThan(0);
  });

  it.each([-1, 2, 0.5, NaN])('rejects a nonexistent target %s', index => {
    expect(() => calculateRiskReward(setup(), index)).toThrow(/索引/);
  });

  it.each([
    { stopLoss: 100 }, { stopLoss: 101 }, { entry: 0 }, { entry: NaN },
    { stopLoss: Infinity }, { targets: [{ price: 99, label: 'wrong side' }] },
  ])('rejects unusable price geometry %j', change => {
    expect(() => calculateRiskReward({ ...setup(), ...change })).toThrow(/计算失败/);
  });

  it('rejects nonzero distances too close to floating-point noise', () => {
    expect(() => calculateRiskReward({ ...setup(), stopLoss: 100 - Number.EPSILON * 100 })).toThrow(/距离无效/);
  });

  it('rejects finite positive prices whose ratio overflows', () => {
    expect(() => calculateRiskReward({ ...setup(), entry: 1e-320, stopLoss: 5e-321, targets: [{ price: 100, label: 'overflow' }] })).toThrow(/超出可计算范围/);
  });
});
