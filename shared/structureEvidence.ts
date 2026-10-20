import type { Candle } from './market';
import type { Structure } from './analysis';
import type { PALeg } from './priceAction';
import { detectRuleIndicators, type RuleIndicatorSnapshot } from './indicators';

export interface EvidenceTiming { originTime: number; formedAt: number; confirmedAt: number | null; resolvedAt: number | null }
export interface RuleStructure extends Structure {
  source: 'deterministic'; importance: 'major' | 'local'; scale: number; familyId: string;
  timing: EvidenceTiming; evidenceTimes: number[];
}
export interface RuleLeg extends PALeg { source: 'deterministic'; importance: 'major' | 'local'; timing: EvidenceTiming; familyId: string }
export interface RulePivot { id: string; side: 'high' | 'low'; index: number; price: number; time: number; confirmedAt: number; scale: number; classification: 'HH' | 'HL' | 'LH' | 'LL' | null }
export interface ReviewWindow { id: string; coreStart: number; coreEnd: number; start: number; end: number; startTime: number; endTime: number; evidenceIds: string[] }
export interface StructureEvidence {
  source: 'deterministic-ohlcv'; version: '1.0'; candleCount: number; asOf: number | null;
  structures: RuleStructure[]; pivots: RulePivot[]; legs: RuleLeg[]; indicators: RuleIndicatorSnapshot;
  windows: ReviewWindow[]; merge: { localObservations: number; duplicateObservations: number; boundaryRecovered: number };
}
const same = (a: number, b: number) => Math.abs(a - b) <= Math.max(Number.MIN_VALUE, Math.abs(b) * Number.EPSILON * 8);

function scan(candles: readonly Candle[], radius: number): { structures: RuleStructure[]; pivots: RulePivot[]; legs: RuleLeg[] } {
  const structures: RuleStructure[] = [], pivots: RulePivot[] = [], legs: RuleLeg[] = [];
  let high: (RulePivot & { confirmedIndex: number; broken: boolean }) | null = null;
  let low: (RulePivot & { confirmedIndex: number; broken: boolean }) | null = null;
  let priorHigh: RulePivot | null = null, priorLow: RulePivot | null = null;
  let trend: 'bullish' | 'bearish' | null = null;
  const importance = radius === 5 ? 'major' : 'local';
  const breakLevel = (pivot: NonNullable<typeof high>, index: number, direction: 'bullish' | 'bearish') => {
    pivot.broken = true;
    const type = trend && trend !== direction ? 'CHoCH' : 'BOS';
    const end = candles[index];
    const resolved = candles.find((candle, offset) => offset > index && (direction === 'bullish' ? candle.close < pivot.price : candle.close > pivot.price));
    structures.push({ id: 'rule-break-' + radius + '-' + direction + '-' + pivot.time + '-' + end.timestamp,
      type, status: 'confirmed', direction, startTime: pivot.time, endTime: end.timestamp, price: pivot.price, priceEnd: null,
      source: 'deterministic', importance, scale: radius, familyId: 'move-' + direction + '-' + end.timestamp,
      timing: { originTime: pivot.time, formedAt: end.timestamp, confirmedAt: end.timestamp, resolvedAt: resolved?.timestamp ?? null },
      evidenceTimes: [pivot.time, pivot.confirmedAt, end.timestamp],
      rationale: '规则 ' + radius + '/' + radius + ' 摆点已在 ' + pivot.confirmedAt + ' 获得右侧确认；之后首次收盘越过 ' + pivot.price + '。' + (type === 'CHoCH' ? '与此前同尺度突破方向相反，记为转换观察。' : '记为该尺度结构突破，不保证后续延续。'),
      invalidation: '后续收盘回到突破价反向一侧时，突破延续假设需复核；历史突破事实保留。' });
    trend = direction;
  };
  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index];
    if (high && !high.broken && index > high.confirmedIndex && candle.close > high.price) breakLevel(high, index, 'bullish');
    if (low && !low.broken && index > low.confirmedIndex && candle.close < low.price) breakLevel(low, index, 'bearish');
    const at = index - radius;
    if (at < radius) continue;
    for (const side of ['high', 'low'] as const) {
      const pivotCandle = candles[at];
      if (!candles.slice(at - radius, index + 1).every((other, offset) => offset === radius || (side === 'high' ? pivotCandle.high > other.high : pivotCandle.low < other.low))) continue;
      const prior = side === 'high' ? priorHigh : priorLow;
      const price = pivotCandle[side];
      const classification = !prior || same(price, prior.price) ? null : side === 'high' ? price > prior.price ? 'HH' : 'LH' : price > prior.price ? 'HL' : 'LL';
      const pivot: RulePivot = { id: 'rule-swing-' + radius + '-' + side + '-' + pivotCandle.timestamp, side, index: at, price,
        time: pivotCandle.timestamp, confirmedAt: candle.timestamp, scale: radius, classification };
      pivots.push(pivot);
      if (side === 'high') { priorHigh = pivot; high = { ...pivot, confirmedIndex: index, broken: false }; }
      else { priorLow = pivot; low = { ...pivot, confirmedIndex: index, broken: false }; }
      if (classification) structures.push({ id: pivot.id, type: classification, status: 'confirmed',
        direction: classification === 'HH' || classification === 'HL' ? 'bullish' : 'bearish', startTime: pivot.time, endTime: pivot.time,
        price, priceEnd: null, source: 'deterministic', importance, scale: radius, familyId: 'pivot-' + side + '-' + pivot.time,
        timing: { originTime: pivot.time, formedAt: pivot.time, confirmedAt: pivot.confirmedAt, resolvedAt: candles.find((bar, offset) => offset > index && (side === 'high' ? bar.close > price : bar.close < price))?.timestamp ?? null },
        evidenceTimes: [prior!.time, pivot.time, pivot.confirmedAt],
        rationale: '严格左右各 ' + radius + ' 根的局部极值，与上一个同尺度同侧摆点比较得到 ' + classification + '；确认时间晚于起源时间。',
        invalidation: '这是历史摆点关系，新的更高/更低摆点改变后续结构判断，不抹除该历史记录。' });
    }
  }
  const alternating: RulePivot[] = [];
  for (const pivot of pivots.sort((a, b) => a.index - b.index || a.side.localeCompare(b.side))) {
    const previous = alternating.at(-1);
    if (!previous) { alternating.push(pivot); continue; }
    if (pivot.side === previous.side) {
      if (pivot.side === 'high' ? pivot.price > previous.price : pivot.price < previous.price) alternating[alternating.length - 1] = pivot;
    } else if (pivot.index > previous.index) alternating.push(pivot);
  }
  for (let index = 1; index < alternating.length; index++) {
    const first = alternating[index - 1], end = alternating[index];
    const direction = first.side === 'low' ? 'bullish' : 'bearish';
    if (direction === 'bullish' ? end.price <= first.price : end.price >= first.price) continue;
    const knownAt = Math.max(first.confirmedAt, end.confirmedAt);
    const contextBreak = structures.filter(item => (item.type === 'BOS' || item.type === 'CHoCH') && item.timing.confirmedAt! <= knownAt).at(-1);
    legs.push({ id: 'rule-leg-' + radius + '-' + first.time + '-' + end.time, source: 'deterministic', importance,
      familyId: 'leg-' + first.time + '-' + end.time, kind: !contextBreak || contextBreak.direction === direction ? 'impulse' : 'pullback', direction,
      title: importance === 'major' ? '规则主要波段' : '规则局部波段', status: 'confirmed', startTime: first.time, endTime: end.time,
      startPrice: first.price, endPrice: end.price, timing: { originTime: first.time, formedAt: end.time, confirmedAt: knownAt, resolvedAt: null },
      rationale: '连接已确认的同尺度相邻异侧摆点；推进/回撤仅相对于当时已知的最近结构突破方向。',
      invalidation: '后续新结构改变趋势解释；端点仅表示历史价格路径，不是可提前得知的开仓信号。' });
  }
  return { structures, pivots, legs };
}

/** Stable IDs are based on evidence coordinates, not a local window's offsets.
 * Full-history records own classification/context; overlapping local scans may
 * supplement a missing record but cannot overwrite a global interpretation. */
export function mergeRuleStructures(global: readonly RuleStructure[], windows: readonly RuleStructure[][]) {
  const merged = new Map(global.map(item => [item.id, item]));
  let duplicates = 0;
  for (const window of windows) for (const item of window) {
    if (merged.has(item.id)) duplicates++; else merged.set(item.id, item);
  }
  return { structures: [...merged.values()].sort((a, b) => a.timing.formedAt - b.timing.formedAt || a.id.localeCompare(b.id)), duplicates };
}

export function extractStructureEvidence(candles: readonly Candle[]): StructureEvidence {
  const indicators = detectRuleIndicators(candles); // Reuse validation and existing FVG/OB definitions.
  const scans = [scan(candles, 2), scan(candles, 5)];
  const global = scans.flatMap(result => result.structures);
  for (const zone of indicators.zones) global.push({ id: zone.id, type: zone.type, direction: zone.direction, status: 'candidate',
    startTime: zone.formedAt, endTime: zone.endTime, price: zone.lowerPrice, priceEnd: zone.upperPrice, rationale: zone.rationale, invalidation: zone.invalidation,
    source: 'deterministic', scale: 2, importance: 'local', familyId: 'move-' + zone.direction + '-' + (global.find(item => ['BOS', 'CHoCH'].includes(item.type) && item.direction === zone.direction && zone.evidenceTimes.includes(item.endTime))?.endTime ?? zone.formedAt),
    timing: { originTime: zone.originTime, formedAt: zone.formedAt, confirmedAt: zone.type === 'FVG' ? zone.formedAt : null, resolvedAt: zone.resolvedTime }, evidenceTimes: zone.evidenceTimes });
  const windows: ReviewWindow[] = [], locals: RuleStructure[][] = [];
  for (let coreStart = 0; coreStart < candles.length; coreStart += 80) {
    const coreEnd = Math.min(candles.length, coreStart + 80), start = Math.max(0, coreStart - 24), end = Math.min(candles.length, coreEnd + 24);
    const local = [scan(candles.slice(start, end), 2), scan(candles.slice(start, end), 5)].flatMap(result => result.structures);
    locals.push(local);
    windows.push({ id: 'window-' + windows.length, coreStart, coreEnd, start, end, startTime: candles[start].timestamp, endTime: candles[end - 1].timestamp,
      evidenceIds: global.filter(item => item.timing.formedAt >= candles[coreStart].timestamp && item.timing.formedAt <= candles[coreEnd - 1].timestamp).map(item => item.id) });
  }
  const merged = mergeRuleStructures(global, locals);
  // Classifications from a local subwindow must never introduce an alternative
  // to a globally unclassified first/equal pivot or a conflicting BOS/CHoCH.
  const globalIds = new Set(global.map(item => item.id));
  const structures = merged.structures.filter(item => globalIds.has(item.id));
  const localIds = new Set(locals.flat().map(item => item.id));
  return { source: 'deterministic-ohlcv', version: '1.0', candleCount: candles.length, asOf: candles.at(-1)?.timestamp ?? null,
    structures, pivots: scans.flatMap(result => result.pivots), legs: scans.flatMap(result => result.legs), indicators, windows,
    merge: { localObservations: locals.reduce((n, list) => n + list.length, 0), duplicateObservations: merged.duplicates,
      boundaryRecovered: global.filter(item => item.type !== 'FVG' && item.type !== 'OB' && !localIds.has(item.id)).length } };
}

export function analysisBudgets(length: number) {
  return { structures: Math.min(40, 12 + Math.floor(length / 12)), zones: length > 160 ? 8 : 6,
    legs: length > 160 ? 16 : 8, patterns: length > 160 ? 12 : 6, breakouts: length > 160 ? 6 : 4,
    keyLevels: length > 160 ? 10 : 6, scenarios: 2, tradeSetups: 2, liquiditySweeps: 6 };
}

/** Importance first, then round-robin through historical windows; no tail-only
 * sampling. Omitted INPUT references remain in the full local evidence store. */
export function selectStructureReferences(evidence: StructureEvidence, limit = Math.min(72, 24 + Math.floor(evidence.candleCount / 6))) {
  const ordered = [...evidence.structures].sort((a, b) => Number(b.importance === 'major') - Number(a.importance === 'major')
    || Number(b.type === 'CHoCH') - Number(a.type === 'CHoCH') || Number(b.type === 'BOS') - Number(a.type === 'BOS') || a.timing.formedAt - b.timing.formedAt);
  const groups = evidence.windows.map(window => ordered.filter(item => window.evidenceIds.includes(item.id)));
  const result: RuleStructure[] = []; const seen = new Set<string>();
  while (result.length < limit && groups.some(group => group.length)) for (const group of groups) {
    const item = group.shift(); if (item && !seen.has(item.id) && result.length < limit) { result.push(item); seen.add(item.id); }
  }
  return result.sort((a, b) => a.timing.formedAt - b.timing.formedAt || a.id.localeCompare(b.id));
}
