import type { Analysis } from '../shared/analysis';

/** Keep the model's decision separate from the evidence-safe chart projection. */
export function tradePlanAvailability(raw?: Analysis, projected?: Analysis) {
  const originalCount = raw?.tradeSetups.length ?? 0;
  const drawableCount = projected?.tradeSetups.length ?? 0;
  const hiddenCount = Math.max(0, originalCount - drawableCount);
  const observationCount = raw?.opportunities.length ?? 0;
  const state = !raw ? 'awaiting' : originalCount && !drawableCount ? 'hidden' : raw.tradePlanning.status;
  const reason = !raw ? '完成分析后，有明确入场、止损与目标价的条件计划会绘制到图表。'
    : state === 'hidden' ? '原分析包含数值计划，但锚点或引用依据已移出当前行情窗口，或原行情被修订。对应计划已隐藏，完整结果仍可导出；请基于当前范围重新分析。'
    : raw.tradePlanning.reason;
  return { state, reason, originalCount, drawableCount, hiddenCount, observationCount };
}
