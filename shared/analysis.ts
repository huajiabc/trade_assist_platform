import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Candle } from './market';
import { calculateRiskReward } from './tradeGeometry';
import { tradeTrackingSchema, validateTradeTracking } from './tradeTracking';
import { emptyPriceAction, priceActionSchema, validatePriceAction } from './priceAction';
import { extractStructureEvidence } from './structureEvidence';
import { researchSchema, tradeBasisSchema, validateResearch } from './analysisResearch';

export const STRUCTURE_TYPES = ['HH', 'HL', 'LH', 'LL', 'BOS', 'CHoCH', 'FVG', 'OB'] as const;
export type StructureType = typeof STRUCTURE_TYPES[number];
const directionSchema = z.enum(['bullish', 'bearish', 'neutral']);
const priceSchema = z.number().finite().positive().max(1_000_000_000_000);
const timeSchema = z.number().int().min(0).max(4_102_444_800);
const idSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/, 'ID 只能包含字母、数字、下划线和短横线');
const textSchema = z.string().trim().min(1).max(1_200);

const structureSchema = z.object({
  id: idSchema,
  type: z.enum(STRUCTURE_TYPES),
  status: z.enum(['confirmed', 'candidate']),
  direction: directionSchema,
  startTime: timeSchema,
  endTime: timeSchema,
  price: priceSchema,
  priceEnd: priceSchema.nullable(),
  rationale: textSchema,
  invalidation: textSchema,
}).strict();

export const tradeSetupSchema = z.object({
  id: idSchema,
  opportunityId: idSchema.nullable(),
  direction: z.enum(['bullish', 'bearish']),
  status: z.literal('candidate'),
  anchorTime: timeSchema,
  entry: priceSchema,
  stopLoss: priceSchema,
  targets: z.array(z.object({ price: priceSchema, label: z.string().trim().min(1).max(80) }).strict()).min(1).max(3),
  structureIds: z.array(idSchema).min(1).max(12),
  trigger: textSchema,
  tracking: tradeTrackingSchema,
  basis: tradeBasisSchema,
  rationale: textSchema,
  invalidation: textSchema,
}).strict();

const liquiditySweepSchema = z.object({
  id: idSchema,
  side: z.enum(['buy-side', 'sell-side']),
  levelTime: timeSchema,
  sweepTime: timeSchema,
  levelPrice: priceSchema,
  extremePrice: priceSchema,
  status: z.enum(['confirmed', 'candidate']),
  rationale: textSchema,
  invalidation: textSchema,
}).strict();

/** The exact provider-facing contract. Cross-field/data checks run in validateAnalysis. */
export const analysisSchema = z.object({
  schemaVersion: z.literal('1.5'),
  trend: directionSchema,
  bias: directionSchema,
  summary: z.string().trim().min(1).max(2_000),
  research: researchSchema,
  structures: z.array(structureSchema).max(80),
  keyLevels: z.array(z.object({ label: z.string().trim().min(1).max(80), price: priceSchema, reason: textSchema }).strict()).max(20),
  opportunities: z.array(z.object({
    id: idSchema,
    direction: z.enum(['bullish', 'bearish']),
    trigger: textSchema,
    invalidation: textSchema,
    target: textSchema,
    risk: textSchema,
    structureIds: z.array(idSchema).min(1).max(12),
  }).strict()).max(10),
  tradeSetups: z.array(tradeSetupSchema).max(6),
  tradePlanning: z.object({
    status: z.enum(['conditional', 'watch-only', 'no-setup']),
    reason: textSchema,
  }).strict(),
  liquiditySweeps: z.array(liquiditySweepSchema).max(20),
  priceAction: priceActionSchema,
  uncertainties: z.array(textSchema).min(1).max(12),
}).strict();

export type Analysis = z.infer<typeof analysisSchema>;
export type Structure = z.infer<typeof structureSchema>;
export type TradeSetup = z.infer<typeof tradeSetupSchema>;
export type LiquiditySweep = z.infer<typeof liquiditySweepSchema>;
export const analysisEnvelopeSchema = z.object({
  analysis: analysisSchema,
  source: z.enum(['mock', 'ai']),
  model: z.string().min(1).max(200),
  analyzedBars: z.number().int().min(10).max(300),
  generatedAt: z.string().datetime({ offset: true }),
  provider: z.enum(['codex', 'openai-compatible', 'mock']).optional(),
  billing: z.enum(['chatgpt-plan', 'api', 'none']).optional(),
  analysisAttempts: z.union([z.literal(1), z.literal(2)]).optional(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }).strict().optional(),
}).strict();
export type AnalysisEnvelope = z.infer<typeof analysisEnvelopeSchema>;

const generatedSchema = zodToJsonSchema(analysisSchema, { target: 'jsonSchema7', $refStrategy: 'none' });
// OpenAI-compatible structured-output providers expect the schema body here.
const { $schema: _schemaDialect, ...providerSchema } = generatedSchema;
export const analysisJsonSchema = providerSchema;

// Parse complete legacy shapes first: mixed old/new fields must not be silently
// stripped or repaired, and new provider output never receives default fields.
const legacy14SetupSchema = tradeSetupSchema.omit({ basis: true });
const legacy14Schema = analysisSchema.omit({ research: true }).extend({ schemaVersion: z.literal('1.4'), tradeSetups: z.array(legacy14SetupSchema).max(6), priceAction: priceActionSchema.extend({ legs: z.array(priceActionSchema.shape.legs.element).max(8) }) }).strict();
const legacy13SetupSchema = legacy14SetupSchema.omit({ tracking: true });
const legacy13Schema = legacy14Schema.extend({ schemaVersion: z.literal('1.3'), tradeSetups: z.array(legacy13SetupSchema).max(6) }).strict();
const legacyTradeSetupSchema = legacy13SetupSchema.omit({ trigger: true });
const legacy12Schema = legacy13Schema.omit({ tradePlanning: true }).extend({
  schemaVersion: z.literal('1.2'),
  tradeSetups: z.array(legacyTradeSetupSchema).max(6),
}).strict();
const legacy11Schema = legacy12Schema.omit({ priceAction: true }).extend({ schemaVersion: z.literal('1.1') }).strict();
const legacy10Schema = legacy11Schema.omit({ tradeSetups: true, liquiditySweeps: true }).extend({ schemaVersion: z.literal('1.0') }).strict();

/** Upgrade only complete old contracts. Never infer numeric plans from prose. */
function migrateLegacyAnalysis(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const legacy = input as Record<string, unknown>;
  const schema = legacy.schemaVersion === '1.0' ? legacy10Schema
    : legacy.schemaVersion === '1.1' ? legacy11Schema
    : legacy.schemaVersion === '1.2' ? legacy12Schema : legacy.schemaVersion === '1.3' ? legacy13Schema : legacy.schemaVersion === '1.4' ? legacy14Schema : null;
  if (!schema) return input;
  const parsed = schema.safeParse(input);
  if (!parsed.success) return input;
  const previous = parsed.data;
  const previousSetups = 'tradeSetups' in previous ? previous.tradeSetups : [];
  const tradeSetups = previousSetups.map(setup => ({ ...setup,
    trigger: 'trigger' in setup ? setup.trigger : previous.opportunities.find(opportunity => opportunity.id === setup.opportunityId)?.trigger
      ?? '旧版未单列触发条件，需复核原依据。',
    tracking: 'tracking' in setup ? setup.tracking : null,
    basis: null,
  }));
  return { ...previous, schemaVersion: '1.5', research: null, tradeSetups,
    liquiditySweeps: 'liquiditySweeps' in previous ? previous.liquiditySweeps : [],
    priceAction: 'priceAction' in previous ? previous.priceAction : emptyPriceAction(),
    tradePlanning: 'tradePlanning' in previous ? previous.tradePlanning : { status: tradeSetups.length ? 'conditional' : previous.opportunities.length ? 'watch-only' : 'no-setup',
      reason: '旧版未单列计划决策原因；请重新分析或复核原依据，迁移不会从文字推算入场、止损或目标价。' },
  };
}

function samePrice(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= Math.max(Number.MIN_VALUE, Math.abs(expected) * Number.EPSILON * 8);
}

function uniqueReferences(ids: string[], available: Set<string>, label: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`分析 JSON 校验失败：${label} 重复引用结构。`);
  if (ids.some(id => !available.has(id))) throw new Error(`分析 JSON 校验失败：${label} 引用了不存在的结构。`);
}

export function validateAnalysis(input: unknown, candles: Candle[]): Analysis {
  const result = analysisSchema.safeParse(migrateLegacyAnalysis(input));
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`分析 JSON 校验失败（${issue.path.join('.') || 'root'}）：${issue.message}`);
  }
  const analysis = result.data;
  const expectedPlanning = analysis.tradeSetups.length ? 'conditional' : analysis.opportunities.length ? 'watch-only' : 'no-setup';
  if (analysis.tradePlanning.status !== expectedPlanning) {
    throw new Error('分析 JSON 校验失败：计划决策状态与数值候选、观察情景数量不一致。');
  }
  if (!candles.length) throw new Error('分析 JSON 校验失败：缺少输入行情。');
  const times = new Set(candles.map((candle) => candle.timestamp));
  const candleByTime = new Map(candles.map((candle) => [candle.timestamp, candle]));
  const minPrice = Math.min(...candles.map((candle) => candle.low));
  const maxPrice = Math.max(...candles.map((candle) => candle.high));
  const ruleEvidence = extractStructureEvidence(candles);
  const structureIds = new Set<string>([...ruleEvidence.structures, ...ruleEvidence.legs].map(item => item.id));
  for (const structure of analysis.structures) {
    if (structureIds.has(structure.id)) throw new Error(`分析 JSON 校验失败：结构 ID ${structure.id} 重复。`);
    structureIds.add(structure.id);
    if (!times.has(structure.startTime) || !times.has(structure.endTime)) {
      throw new Error(`分析 JSON 校验失败：结构 ${structure.id} 引用了行情中不存在的时间。`);
    }
    if (structure.price < minPrice || structure.price > maxPrice || (structure.priceEnd !== null && (structure.priceEnd < minPrice || structure.priceEnd > maxPrice))) {
      throw new Error(`分析 JSON 校验失败：结构 ${structure.id} 的价格超出输入行情的高低范围。`);
    }
    if (structure.startTime > structure.endTime) throw new Error(`分析 JSON 校验失败：结构 ${structure.id} 的起始时间晚于结束时间。`);
    if (['HH', 'HL', 'LH', 'LL'].includes(structure.type) && structure.startTime !== structure.endTime) {
      throw new Error(`分析 JSON 校验失败：摆动点 ${structure.id} 的起止时间须相同。`);
    }
    if (['HH', 'HL', 'LH', 'LL'].includes(structure.type)) {
      const candle = candleByTime.get(structure.startTime)!;
      const expected = structure.type === 'HH' || structure.type === 'LH' ? candle.high : candle.low;
      // Allow only floating-point representation noise at the actual price scale.
      // An absolute epsilon would accept whole candle ranges for micro-priced assets.
      const tolerance = Math.max(Number.MIN_VALUE, Math.abs(expected) * Number.EPSILON * 8);
      if (Math.abs(structure.price - expected) > tolerance) {
        throw new Error(`分析 JSON 校验失败：摆动点 ${structure.id} 的价格须等于对应 K 线的${structure.type === 'HH' || structure.type === 'LH' ? '最高' : '最低'}价。`);
      }
    }
    const zone = structure.type === 'FVG' || structure.type === 'OB';
    if (zone && (structure.priceEnd === null || structure.priceEnd <= structure.price)) {
      throw new Error(`分析 JSON 校验失败：区域 ${structure.id} 的上边界须大于下边界。`);
    }
    if (!zone && structure.priceEnd !== null) {
      throw new Error(`分析 JSON 校验失败：非区域结构 ${structure.id} 的 priceEnd 须为 null。`);
    }
  }
  // PA and SMC are peers in the evidence namespace, so a PA-only trade thesis
  // need not invent an SMC structure merely to attach its supporting evidence.
  for (const item of [...analysis.priceAction.zones, ...analysis.priceAction.legs, ...analysis.priceAction.patterns, ...analysis.priceAction.breakouts]) {
    if (structureIds.has(item.id)) throw new Error(`分析 JSON 校验失败：PA ID ${item.id} 重复。`);
    structureIds.add(item.id);
  }
  const opportunityIds = new Set<string>();
  for (const opportunity of analysis.opportunities) {
    if (opportunityIds.has(opportunity.id) || structureIds.has(opportunity.id)) throw new Error(`分析 JSON 校验失败：机会 ID ${opportunity.id} 重复。`);
    opportunityIds.add(opportunity.id);
    if (new Set(opportunity.structureIds).size !== opportunity.structureIds.length) {
      throw new Error(`分析 JSON 校验失败：机会 ${opportunity.id} 重复引用结构。`);
    }
    if (opportunity.structureIds.some((id) => !structureIds.has(id))) {
      throw new Error(`分析 JSON 校验失败：机会 ${opportunity.id} 引用了不存在的结构。`);
    }
  }
  const usedIds = new Set([...structureIds, ...opportunityIds]);
  const plausibleRange = Math.max(maxPrice - minPrice, maxPrice * 0.005);
  const lowerBound = Math.max(Number.MIN_VALUE, minPrice - 3 * plausibleRange);
  const upperBound = maxPrice + 3 * plausibleRange;
  for (const setup of analysis.tradeSetups) {
    if (usedIds.has(setup.id)) throw new Error(`分析 JSON 校验失败：观察计划 ID ${setup.id} 重复。`);
    usedIds.add(setup.id);
    if (!times.has(setup.anchorTime)) throw new Error(`分析 JSON 校验失败：观察计划 ${setup.id} 引用了不存在的时间。`);
    if (setup.anchorTime !== candles[candles.length - 1].timestamp) {
      throw new Error(`分析 JSON 校验失败：观察计划 ${setup.id} 必须锚定输入行情最后一根 K 线，不能将历史计划作为当前候选。`);
    }
    if (setup.opportunityId !== null && !opportunityIds.has(setup.opportunityId)) {
      throw new Error(`分析 JSON 校验失败：观察计划 ${setup.id} 引用了不存在的机会。`);
    }
    const linkedOpportunity = analysis.opportunities.find(opportunity => opportunity.id === setup.opportunityId);
    if (linkedOpportunity && linkedOpportunity.direction !== setup.direction) {
      throw new Error(`分析 JSON 校验失败：观察计划 ${setup.id} 与引用机会的方向不一致。`);
    }
    uniqueReferences(setup.structureIds, structureIds, `观察计划 ${setup.id}`);
    const prices = [setup.entry, setup.stopLoss, ...setup.targets.map(target => target.price)];
    if (prices.some(price => price < lowerBound || price > upperBound)) {
      throw new Error(`分析 JSON 校验失败：观察计划 ${setup.id} 的价格超出行情窗口的合理延伸范围。`);
    }
    validateTradeTracking(setup, lowerBound, upperBound);
    const sign = setup.direction === 'bullish' ? 1 : -1;
    const tolerance = Math.max(Number.MIN_VALUE, setup.entry * Number.EPSILON * 8);
    if ((setup.entry - setup.stopLoss) * sign <= tolerance) {
      throw new Error(`分析 JSON 校验失败：观察计划 ${setup.id} 的止损方向或距离无效。`);
    }
    let previousTarget = setup.entry;
    for (const target of setup.targets) {
      if ((target.price - previousTarget) * sign <= tolerance) {
        throw new Error(`分析 JSON 校验失败：观察计划 ${setup.id} 的目标须沿盈利方向严格递进。`);
      }
      previousTarget = target.price;
    }
    try {
      setup.targets.forEach((_target, index) => calculateRiskReward(setup, index));
    } catch {
      throw new Error(`分析 JSON 校验失败：观察计划 ${setup.id} 的盈亏比超出可计算范围。`);
    }
  }
  const candleIndex = new Map(candles.map((candle, index) => [candle.timestamp, index]));
  for (const sweep of analysis.liquiditySweeps) {
    if (usedIds.has(sweep.id)) throw new Error(`分析 JSON 校验失败：扫除记录 ID ${sweep.id} 重复。`);
    usedIds.add(sweep.id);
    const levelIndex = candleIndex.get(sweep.levelTime);
    const sweepIndex = candleIndex.get(sweep.sweepTime);
    if (levelIndex === undefined || sweepIndex === undefined) throw new Error(`分析 JSON 校验失败：扫除记录 ${sweep.id} 引用了不存在的时间。`);
    if (levelIndex < 2 || sweepIndex <= levelIndex + 2) {
      throw new Error(`分析 JSON 校验失败：扫除记录 ${sweep.id} 的参考摆动须在扫除前完成右侧 2 根确认。`);
    }
    const level = candles[levelIndex];
    const current = candles[sweepIndex];
    const buySide = sweep.side === 'buy-side';
    const levelValue = buySide ? level.high : level.low;
    const extreme = buySide ? current.high : current.low;
    if (!samePrice(sweep.levelPrice, levelValue) || !samePrice(sweep.extremePrice, extreme)) {
      throw new Error(`分析 JSON 校验失败：扫除记录 ${sweep.id} 的参考价或极值须精确对应 K 线高低价。`);
    }
    const neighbors = [candles[levelIndex - 2], candles[levelIndex - 1], candles[levelIndex + 1], candles[levelIndex + 2]];
    if (!neighbors.every(candle => buySide ? level.high > candle.high : level.low < candle.low)) {
      throw new Error(`分析 JSON 校验失败：扫除记录 ${sweep.id} 的参考价不是已确认局部摆动点。`);
    }
    if (!(buySide ? current.high > level.high : current.low < level.low)) {
      throw new Error(`分析 JSON 校验失败：扫除记录 ${sweep.id} 缺少影线穿越参考价。`);
    }
    const reclaimed = buySide ? current.close < level.high : current.close > level.low;
    if (sweep.status === 'confirmed' && !reclaimed) {
      throw new Error(`分析 JSON 校验失败：扫除记录 ${sweep.id} 尚未收盘收回参考价，仅可作为候选。`);
    }
    if (candles.slice(levelIndex + 3, sweepIndex).some(candle => buySide ? candle.close > level.high : candle.close < level.low)) {
      throw new Error(`分析 JSON 校验失败：扫除记录 ${sweep.id} 的参考摆动在扫除前已经收盘突破。`);
    }
  }
  validatePriceAction(analysis.priceAction, candles, new Set(analysis.structures.map(structure => structure.id)));
  validateResearch(analysis, candles, ruleEvidence, analysis.research !== null);
  return analysis;
}

export function validateAnalysisEnvelope(input: unknown, candles: Candle[]): AnalysisEnvelope {
  const normalized = input && typeof input === 'object' && !Array.isArray(input)
    ? { ...input, analysis: migrateLegacyAnalysis((input as { analysis?: unknown }).analysis) }
    : input;
  const result = analysisEnvelopeSchema.safeParse(normalized);
  if (!result.success) throw new Error(`分析响应校验失败：${result.error.issues[0].message}`);
  const { source, provider, billing, usage, analysisAttempts } = result.data;
  if ((source === 'mock' && (provider && provider !== 'mock' || billing && billing !== 'none' || usage || analysisAttempts !== undefined))
    || (source === 'ai' && (provider === 'mock' || billing === 'none'))
    || (provider === 'codex' && billing && billing !== 'chatgpt-plan')
    || (provider === 'openai-compatible' && billing && billing !== 'api')
    || (usage && usage.cachedInputTokens > usage.inputTokens)) {
    throw new Error('分析响应校验失败：模型来源、计费来源或用量元数据不一致。');
  }
  if (result.data.analyzedBars !== candles.length) throw new Error('分析响应校验失败：分析 K 线数量不一致。');
  return { ...result.data, analysis: validateAnalysis(result.data.analysis, candles) };
}
