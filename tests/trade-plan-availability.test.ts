import { describe, expect, it } from 'vitest';
import { createMockAnalysis } from '../shared/mock';
import { SAMPLE_CANDLES } from '../shared/sample';
import { tradePlanAvailability } from '../src/tradePlanAvailability';

describe('numeric trade plan availability', () => {
  it('distinguishes no completed analysis from a model decision', () => {
    expect(tradePlanAvailability()).toMatchObject({ state: 'awaiting', originalCount: 0, drawableCount: 0 });
  });

  it('preserves the model reason when it only supplies textual observations', () => {
    const raw = createMockAnalysis(SAMPLE_CANDLES);
    raw.tradeSetups = [];
    raw.tradePlanning = { status: 'watch-only', reason: '回踩未确认，没有足够依据设定参考止损。' };
    expect(tradePlanAvailability(raw, raw)).toMatchObject({ state: 'watch-only', reason: raw.tradePlanning.reason,
      originalCount: 0, drawableCount: 0, hiddenCount: 0, observationCount: raw.opportunities.length });
  });

  it('reports hidden original plans rather than claiming the model provided none', () => {
    const raw = createMockAnalysis(SAMPLE_CANDLES);
    expect(raw.tradeSetups.length).toBeGreaterThan(0);
    const result = tradePlanAvailability(raw, { ...raw, tradeSetups: [] });
    expect(result).toMatchObject({ state: 'hidden', originalCount: raw.tradeSetups.length, drawableCount: 0, hiddenCount: raw.tradeSetups.length });
    expect(result.reason).toContain('移出当前行情窗口');
    expect(result.reason).toContain('修订');
    expect(raw.tradeSetups.length).toBeGreaterThan(0);
  });

  it('counts partially hidden evidence without changing the model decision', () => {
    const raw = createMockAnalysis(SAMPLE_CANDLES);
    raw.tradeSetups.push({ ...raw.tradeSetups[0], id: 'second-plan' });
    expect(tradePlanAvailability(raw, { ...raw, tradeSetups: raw.tradeSetups.slice(0, 1) }))
      .toMatchObject({ state: 'conditional', originalCount: 2, drawableCount: 1, hiddenCount: 1 });
  });
});
