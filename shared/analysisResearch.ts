import { z } from 'zod';
import type { Analysis, Structure, TradeSetup } from './analysis';
import type { Candle } from './market';
import { extractStructureEvidence, type EvidenceTiming, type StructureEvidence } from './structureEvidence';
import { calculateRiskReward } from './tradeGeometry';
import { auditStopRisk } from './tradeRisk';
const id = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
const text = z.string().trim().min(1).max(1200);
const ids = z.array(id).max(24);
export const researchSchema = z.object({
  regime: z.enum(['uptrend', 'downtrend', 'range', 'transition']), regimeEvidenceIds: ids,
  background: text, currentContext: text,
  areaReviews: z.array(z.object({ structureId: id, state: z.enum(['untested', 'testing', 'reclaimed', 'failed']),
    observedAt: z.number().int().nonnegative(), rationale: text }).strict()).max(8),
  scenarios: z.array(z.object({ id, direction: z.enum(['bullish', 'bearish']), structureIds: ids,
    thesis: text, confirmation: text, cancellation: text }).strict()).max(2),
  coverage: z.array(z.object({ windowId: id, reviewedIds: ids, omittedIds: ids, reason: text }).strict()).max(6),
}).strict().nullable();
export const tradeBasisSchema = z.object({ scenarioId: id, entryStructureId: id, stopStructureId: id,
  targetStructureIds: z.array(id).min(1).max(3) }).strict().nullable();
export interface PriceEvidence { id: string; low: number; high: number; direction: string; type: string;
  rationale?: string; invalidation?: string; source: 'ai' | 'deterministic'; familyId: string; timing: EvidenceTiming; anchorEligible: boolean }
const equal = (a: number, b: number) => Math.abs(a - b) <= Math.max(Number.MIN_VALUE, Math.abs(b) * Number.EPSILON * 8);

export function auditStructure(structure: Structure, candles: readonly Candle[], evidence = extractStructureEvidence(candles)): EvidenceTiming | null {
  const exact = evidence.structures.filter(item => item.type === structure.type && equal(item.price, structure.price)
    && (item.priceEnd === null ? structure.priceEnd === null : structure.priceEnd !== null && equal(item.priceEnd, structure.priceEnd))
    && (item.type === 'FVG' || item.type === 'OB'
      ? (item.timing.originTime === structure.startTime || item.timing.formedAt === structure.startTime) && structure.endTime >= item.timing.formedAt
      : item.startTime === structure.startTime && item.endTime === structure.endTime));
  if (exact.length) return exact.sort((a, b) => (a.timing.confirmedAt ?? Infinity) - (b.timing.confirmedAt ?? Infinity))[0].timing;
  if (structure.status === 'candidate' && !['FVG', 'OB'].includes(structure.type)) return {
    originTime: structure.startTime, formedAt: structure.endTime, confirmedAt: null, resolvedAt: null };
  return null;
}

export function priceEvidence(analysis: Analysis, candles: readonly Candle[], evidence = extractStructureEvidence(candles)): Map<string, PriceEvidence> {
  const entries = new Map<string, PriceEvidence>();
  for (const item of evidence.structures) entries.set(item.id, { id: item.id, rationale: item.rationale, invalidation: item.invalidation, low: item.price, high: item.priceEnd ?? item.price,
    type: item.type, source: 'deterministic', direction: item.direction, timing: item.timing, familyId: item.familyId, anchorEligible: true });
  for (const item of evidence.legs) entries.set(item.id, { id: item.id, rationale: item.rationale, invalidation: item.invalidation, low: Math.min(item.startPrice, item.endPrice), high: Math.max(item.startPrice, item.endPrice),
    type: 'leg', source: 'deterministic', direction: item.direction, timing: item.timing, familyId: item.familyId, anchorEligible: false });
  for (const item of analysis.structures) {
    const timing = auditStructure(item, candles, evidence);
    const canonical = evidence.structures.find(rule => rule.type === item.type && equal(rule.price, item.price) && rule.timing.formedAt === timing?.formedAt);
    entries.set(item.id, { id: item.id, rationale: item.rationale, invalidation: item.invalidation, low: item.price, high: item.priceEnd ?? item.price, type: item.type, source: 'ai', direction: item.direction,
      timing: timing ?? { originTime: item.startTime, formedAt: item.endTime, confirmedAt: null, resolvedAt: null },
      familyId: canonical?.familyId ?? (['HH', 'HL', 'LH', 'LL'].includes(item.type) ? 'pivot-' + (item.type === 'HH' || item.type === 'LH' ? 'high' : 'low') + '-' + item.startTime
        : 'move-' + item.direction + '-' + (timing?.formedAt ?? item.endTime)), anchorEligible: timing !== null && (['HH', 'HL', 'LH', 'LL', 'FVG', 'OB'].includes(item.type) || timing.confirmedAt !== null) });
  }
  for (const item of [...analysis.priceAction.zones, ...analysis.priceAction.legs, ...analysis.priceAction.patterns, ...analysis.priceAction.breakouts]) {
    const breakout = 'breakoutTime' in item;
    const start = breakout ? item.breakoutTime : item.startTime;
    const end = breakout ? item.confirmationTime ?? item.retestTime ?? item.breakoutTime : item.endTime;
    const endIndex = candles.findIndex(candle => candle.timestamp === end);
    const leg = 'startPrice' in item;
    const confirmation = item.status === 'confirmed' ? candles[Math.min(candles.length - 1, endIndex + (leg ? 2 : 0))]?.timestamp ?? null : null;
    const covered = candles.filter(candle => candle.timestamp >= start && candle.timestamp <= end);
    const zone = 'lowerPrice' in item;
    const referencedZone = breakout ? analysis.priceAction.zones.find(zone => zone.id === item.zoneId) : undefined;
    const low = zone ? item.lowerPrice : leg ? Math.min(item.startPrice, item.endPrice) : referencedZone?.lowerPrice ?? Math.min(...covered.map(candle => candle.low));
    const high = zone ? item.upperPrice : leg ? Math.max(item.startPrice, item.endPrice) : referencedZone?.upperPrice ?? Math.max(...covered.map(candle => candle.high));
    const resolvedAt = zone || breakout ? candles.find(candle => candle.timestamp > end && (zone ? item.kind === 'support' ? candle.close < low : item.kind === 'resistance' ? candle.close > high : candle.close < low || candle.close > high : item.direction === 'bullish' ? candle.close < low : candle.close > high))?.timestamp ?? null : null;
    entries.set(item.id, { id: item.id, rationale: item.rationale, invalidation: item.invalidation, low, high, type: zone ? item.kind : leg ? 'leg' : breakout ? 'breakout' : 'pattern', source: 'ai',
      direction: 'direction' in item ? item.direction : item.kind === 'support' ? 'bullish' : item.kind === 'resistance' ? 'bearish' : 'neutral',
      familyId: leg ? 'leg-' + start + '-' + end : 'move-' + ('direction' in item ? item.direction : item.kind) + '-' + end,
      timing: { originTime: start, formedAt: breakout ? item.breakoutTime : end, confirmedAt: confirmation, resolvedAt }, anchorEligible: zone || breakout });
  }
  return entries;
}

export function validateResearch(analysis: Analysis, candles: readonly Candle[], evidence: StructureEvidence, strictConfirmation: boolean): void {
  const fail = (message: string): never => { throw new Error('分析 JSON 校验失败：' + message); };
  if (strictConfirmation) for (const item of analysis.structures) {
    if (item.type === 'OB' && item.status === 'confirmed') fail('OB规则仅提供候选区域，缺少独立反应确认合同，不可声明确定确认。');
    if ((item.status === 'confirmed' || item.type === 'FVG' || item.type === 'OB') && !auditStructure(item, candles, evidence)) {
      fail('结构 ' + item.id + ' 无法由声明的摆点、收盘突破或区域规则核验确认时间；应删除或保留有依据的候选。');
    }
  }
  const entries = priceEvidence(analysis, candles, evidence);
  const reference = (list: string[], label: string) => {
    if (new Set(list).size !== list.length || list.some(id => !entries.has(id))) fail(label + ' 引用了不存在或重复的结构。');
  };
  const research = analysis.research;
  if (research) {
    if (research.regime !== analysis.priceAction.regime) fail('市场状态与 PA 状态不一致。');
    reference(research.regimeEvidenceIds, '市场状态');
    if (['uptrend', 'downtrend'].includes(research.regime) && !research.regimeEvidenceIds.length) fail('趋势状态必须给出结构依据。');
    if (research.regime === 'uptrend' && !research.regimeEvidenceIds.some(id => entries.get(id)?.direction === 'bullish') || research.regime === 'downtrend' && !research.regimeEvidenceIds.some(id => entries.get(id)?.direction === 'bearish')) fail('方向趋势缺少同方向的结构依据。');
    const scenarioIds = new Set<string>();
    for (const scenario of research.scenarios) {
      if (scenarioIds.has(scenario.id)) fail('当前情景 ID 重复。'); scenarioIds.add(scenario.id);
      reference(scenario.structureIds, '当前情景');
      if (!scenario.structureIds.length) fail('当前情景缺少结构依据。');
    }
    for (const review of research.areaReviews) {
      const item = entries.get(review.structureId);
      const candle = candles.find(candle => candle.timestamp === review.observedAt);
      if (!item || !candle || review.observedAt < item.timing.formedAt) fail('区域审阅时间或引用无效。');
      if (!item!.anchorEligible || item!.timing.confirmedAt !== null && review.observedAt < item!.timing.confirmedAt) fail('区域审阅必须引用当时已知的价位结构。');
      if (review.state === 'untested' && candles.some(bar => bar.timestamp > item!.timing.formedAt && bar.timestamp <= review.observedAt && bar.high >= item!.low && bar.low <= item!.high)) fail('已测试区域不能声明从未测试。');
      if (item!.timing.resolvedAt !== null && item!.timing.resolvedAt! <= review.observedAt && review.state !== 'failed') fail('已回补或失效区域不能冒充当前有效反应。');
      if (review.state === 'failed' && !(item!.timing.resolvedAt !== null && item!.timing.resolvedAt <= review.observedAt) && !(item!.direction === 'bullish' ? candle!.close < item!.low : item!.direction === 'bearish' ? candle!.close > item!.high : candle!.close < item!.low || candle!.close > item!.high)) fail('失效声明缺少回补或反向收盘依据。');
      if (review.state === 'testing' && !(candle!.high >= item!.low && candle!.low <= item!.high)) fail('区域测试缺少真实价格相交。');
      if (review.state === 'reclaimed' && !(candle!.high >= item!.low && candle!.low <= item!.high
        && (item!.direction === 'bullish' ? candle!.close > item!.high : item!.direction === 'bearish' ? candle!.close < item!.low : false))) fail('区域收复缺少相交与方向收盘依据。');
    }
    for (const coverage of research.coverage) {
      const window = evidence.windows.find(window => window.id === coverage.windowId);
      if (!window) fail('分段审阅引用了不存在的窗口。');
      reference(coverage.reviewedIds, '分段审阅'); reference(coverage.omittedIds, '省略说明');
      if (coverage.reviewedIds.some(id => coverage.omittedIds.includes(id))) fail('同一证据不能同时声明已展开和省略。');
      if ([...coverage.reviewedIds, ...coverage.omittedIds].some(id => { const item = entries.get(id)!; return item.timing.formedAt < window!.startTime || item.timing.formedAt > window!.endTime; })) fail('分段说明引用了窗口以外形成的证据。');
    }
  }
  const recent = candles.slice(-20); const averageRange = recent.reduce((sum, candle) => sum + candle.high - candle.low, 0) / recent.length;
  for (const setup of analysis.tradeSetups) {
    if (research && !setup.basis) fail('阶段研究计划必须逐项引用入场、止损和目标结构；依据不足请等待。');
    if (!setup.basis) continue; // Legacy/incomplete geometry is explicitly labelled, never promoted to a fully grounded plan.
    const basis = setup.basis;
    const scenario = research?.scenarios.find(item => item.id === basis.scenarioId);
    if (!scenario || scenario.direction !== setup.direction) fail('交易计划缺少同方向的当前情景依据。');
    const anchors = [basis.entryStructureId, basis.stopStructureId, ...basis.targetStructureIds];
    if (anchors.some(id => !setup.structureIds.includes(id))) fail('计划价位依据必须包含在本计划结构引用中。');
    if (!scenario!.structureIds.some(id => setup.structureIds.includes(id))) fail('交易计划与情景没有共同结构依据。');
    if (basis.targetStructureIds.length !== setup.targets.length) fail('目标依据必须与各目标逐一对应。');
    for (const id of anchors) if (!entries.get(id)?.anchorEligible) fail('趋势腿或烛线形态不能单独充当精确入场、止损或目标价位。');
    const entry = entries.get(basis.entryStructureId)!; const stop = entries.get(basis.stopStructureId)!;
    const lastTime = candles.at(-1)!.timestamp;
    if ([entry, stop].some(item => item.timing.resolvedAt !== null && item.timing.resolvedAt <= lastTime)) fail('已回补或失效区域不能作为当前入场/保护依据。');
    if (calculateRiskReward(setup).ratio < 1) fail('第一目标空间不足1R，请等待更合理的结构计划；不得通过压紧止损凑盈亏比。');
    const stopRisk = auditStopRisk(setup, candles, stop);
    if (stopRisk.errors.length) fail(stopRisk.errors.join(' '));
    const pad = Math.max(averageRange * .25, setup.entry * Number.EPSILON * 8);
    if (setup.entry < entry.low - pad || setup.entry > entry.high + pad) fail('参考入场偏离所引用区域超过近期平均振幅的四分之一。');
    if (setup.direction === 'bullish' ? setup.stopLoss >= stop.low : setup.stopLoss <= stop.high) fail('止损必须位于所引用保护结构之外。');
    setup.targets.forEach((target, index) => {
      const level = entries.get(basis.targetStructureIds[index])!;
      const tolerance = Math.max(Number.MIN_VALUE, Math.abs(target.price) * Number.EPSILON * 8);
      if (target.price < level.low - tolerance || target.price > level.high + tolerance) fail('目标价必须落在其引用结构的真实价位或区域内。');
    });
    if (setup.tracking && !setup.tracking.steps.some(step => step.conditions.some(condition => {
      const upper = condition.priceEnd ?? condition.price;
      return upper >= entry.low - pad && condition.price <= entry.high + pad;
    }))) fail('触发规则缺少与所引用入场区域对应的可核验价位条件。');
  }
}

export function planEvidenceSummary(setup: TradeSetup, entries: Map<string, PriceEvidence>, candles: readonly Candle[]) {
  const groups = new Set(setup.structureIds.map(id => entries.get(id)?.familyId ?? id));
  const stopRisk = auditStopRisk(setup, candles, setup.basis ? entries.get(setup.basis.stopStructureId) : undefined);
  const warnings: string[] = [];
  if (!setup.basis) warnings.push('未提供逐项价位依据，作为不完整研究候选保留，无法核验结构外止损缓冲。');
  if (calculateRiskReward(setup).ratio < 1) warnings.push('第一目标价格空间小于参考风险距离（不足1R）。');
  warnings.push(...stopRisk.errors, ...stopRisk.warnings);
  return { citedCount: setup.structureIds.length, eventGroupCount: groups.size, warnings, stopRisk };
}
