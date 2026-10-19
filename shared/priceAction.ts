import { z } from 'zod';
import type { Candle } from './market';

const id = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
const text = z.string().trim().min(1).max(1_200);
const time = z.number().int().min(0).max(4_102_444_800);
const price = z.number().finite().positive().max(1_000_000_000_000);
const status = z.enum(['confirmed', 'candidate']);
const directed = z.enum(['bullish', 'bearish']);
const common = { id, status, title: z.string().trim().min(1).max(80), rationale: text, invalidation: text };

export const paZoneSchema = z.object({
  ...common, kind: z.enum(['support', 'resistance', 'trading-range']),
  startTime: time, endTime: time, lowerPrice: price, upperPrice: price,
  touchTimes: z.array(time).min(1).max(30),
}).strict();
export const paLegSchema = z.object({
  ...common, kind: z.enum(['impulse', 'pullback']), direction: directed,
  startTime: time, endTime: time, startPrice: price, endPrice: price,
}).strict();
export const paPatternSchema = z.object({
  ...common, kind: z.enum(['pin-bar', 'engulfing', 'inside-bar']),
  direction: z.enum(['bullish', 'bearish', 'neutral']), startTime: time, endTime: time,
}).strict();
export const paBreakoutSchema = z.object({
  ...common, zoneId: id, direction: directed, breakoutTime: time,
  retestTime: time.nullable(), confirmationTime: time.nullable(),
}).strict();
export const priceActionSchema = z.object({
  regime: z.enum(['uptrend', 'downtrend', 'range', 'transition']),
  summary: text,
  zones: z.array(paZoneSchema).max(8), legs: z.array(paLegSchema).max(8),
  patterns: z.array(paPatternSchema).max(12), breakouts: z.array(paBreakoutSchema).max(6),
}).strict();

export type PAZone = z.infer<typeof paZoneSchema>;
export type PALeg = z.infer<typeof paLegSchema>;
export type PAPattern = z.infer<typeof paPatternSchema>;
export type PABreakout = z.infer<typeof paBreakoutSchema>;
export type PriceAction = z.infer<typeof priceActionSchema>;
export type PAElement = PAZone | PALeg | PAPattern | PABreakout;

export function emptyPriceAction(): PriceAction {
  return { regime: 'transition', summary: '此旧版分析未包含 PA 证据；请重新分析以识别区域、波段、K 线形态与突破回踩。',
    zones: [], legs: [], patterns: [], breakouts: [] };
}

function equalPrice(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= Math.max(Number.MIN_VALUE, Math.abs(expected) * Number.EPSILON * 8);
}

/** Deliberately conservative, explicit candle-shape rules; these are not entry signals. */
export function matchesPAPattern(pattern: Pick<PAPattern, 'kind' | 'direction'>, first: Candle, last: Candle, adjacent: boolean): boolean {
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low;
  if (!(range > 0)) return false;
  if (pattern.kind === 'pin-bar') {
    if (first.timestamp !== last.timestamp || pattern.direction === 'neutral') return false;
    const lowerWick = Math.min(last.open, last.close) - last.low;
    const upperWick = last.high - Math.max(last.open, last.close);
    const dominant = pattern.direction === 'bullish' ? lowerWick : upperWick;
    const opposite = pattern.direction === 'bullish' ? upperWick : lowerWick;
    return dominant >= range * 0.6 && dominant >= Math.max(body, range * 0.02) * 2
      && opposite <= range * 0.25 && body <= range * 0.35;
  }
  if (!adjacent) return false;
  if (pattern.kind === 'inside-bar') {
    return pattern.direction === 'neutral' && last.high < first.high && last.low > first.low;
  }
  const previousBody = Math.abs(first.close - first.open);
  if (!(previousBody > 0 && body > previousBody)) return false;
  const bullish = pattern.direction === 'bullish' && first.close < first.open && last.close > last.open;
  const bearish = pattern.direction === 'bearish' && first.close > first.open && last.close < last.open;
  return (bullish || bearish) && Math.min(last.open, last.close) <= Math.min(first.open, first.close)
    && Math.max(last.open, last.close) >= Math.max(first.open, first.close);
}

/** A range touch must intersect a boundary band, rather than any candle in the middle. */
export function paZoneTouch(zone: PAZone, candle: Candle): boolean {
  if (zone.kind === 'support') return candle.low >= zone.lowerPrice && candle.low <= zone.upperPrice && candle.close >= zone.lowerPrice;
  if (zone.kind === 'resistance') return candle.high >= zone.lowerPrice && candle.high <= zone.upperPrice && candle.close <= zone.upperPrice;
  const pad = (zone.upperPrice - zone.lowerPrice) * 0.1;
  return candle.high >= zone.lowerPrice && candle.low <= zone.upperPrice
    && (candle.low <= zone.lowerPrice + pad || candle.high >= zone.upperPrice - pad);
}

export function paRetestTouches(zone: PAZone, direction: 'bullish' | 'bearish', candle: Candle): boolean {
  const width = zone.upperPrice - zone.lowerPrice;
  const lower = zone.kind === 'trading-range' && direction === 'bullish' ? zone.upperPrice - width * 0.1 : zone.lowerPrice;
  const upper = zone.kind === 'trading-range' && direction === 'bearish' ? zone.lowerPrice + width * 0.1 : zone.upperPrice;
  return candle.high >= lower && candle.low <= upper;
}

function isPivot(candles: Candle[], index: number, side: 'high' | 'low'): boolean {
  if (index < 2 || index + 2 >= candles.length) return false;
  return [-2, -1, 1, 2].every(offset => side === 'high'
    ? candles[index].high > candles[index + offset].high : candles[index].low < candles[index + offset].low);
}

/** Returns the PA ID set for the common PA/SMC evidence namespace. */
export function validatePriceAction(pa: PriceAction, candles: Candle[], usedIds: Set<string>): Set<string> {
  const fail = (message: string): never => { throw new Error(`分析 JSON 校验失败：PA ${message}`); };
  const indices = new Map(candles.map((candle, index) => [candle.timestamp, index]));
  const minimum = Math.min(...candles.map(candle => candle.low));
  const maximum = Math.max(...candles.map(candle => candle.high));
  const indexOf = (timestamp: number, label: string) => {
    const index = indices.get(timestamp);
    if (index === undefined) return fail(`${label} 引用了行情中不存在的时间。`);
    return index;
  };
  const reserve = (element: { id: string }) => {
    if (usedIds.has(element.id)) fail(`ID ${element.id} 重复。`);
    usedIds.add(element.id);
  };
  const span = (element: { id: string; startTime: number; endTime: number }) => {
    const start = indexOf(element.startTime, element.id);
    const end = indexOf(element.endTime, element.id);
    if (start > end) fail(`${element.id} 的起始时间晚于结束时间。`);
    return [start, end] as const;
  };
  for (const zone of pa.zones) {
    reserve(zone);
    const [start, end] = span(zone);
    if (!(zone.upperPrice > zone.lowerPrice) || zone.lowerPrice < minimum || zone.upperPrice > maximum) fail(`区域 ${zone.id} 的价格边界无效或超出行情范围。`);
    const touches = zone.touchTimes.map(timestamp => indexOf(timestamp, zone.id));
    if (touches.some((index, position) => index < start || index > end || position > 0 && index <= touches[position - 1])) fail(`区域 ${zone.id} 的触及时间须唯一、升序且位于形成区间内。`);
    if (touches.some(index => !paZoneTouch(zone, candles[index]))) fail(`区域 ${zone.id} 的触及缺少实际 K 线边界证据。`);
    if (zone.status === 'confirmed') {
      if (touches.length < 2 || touches.at(-1)! - touches[0] < 2) fail(`区域 ${zone.id} 的确认需要至少两次相隔 2 根的有效触及。`);
      if (zone.kind === 'trading-range') {
        const pad = (zone.upperPrice - zone.lowerPrice) * 0.1;
        const lows = touches.filter(index => candles[index].low <= zone.lowerPrice + pad);
        const highs = touches.filter(index => candles[index].high >= zone.upperPrice - pad);
        if (end - start < 4 || lows.length < 2 || highs.length < 2) fail(`区间 ${zone.id} 的确认需要上下边界各两次触及及至少 4 根跨度。`);
        if (candles.slice(start, end + 1).some(candle => candle.close < zone.lowerPrice || candle.close > zone.upperPrice)) fail(`区间 ${zone.id} 形成期间已有收盘越界。`);
      }
    }
  }
  for (const leg of pa.legs) {
    reserve(leg);
    const [start, end] = span(leg);
    if (start === end) fail(`波段 ${leg.id} 至少需要两个不同时间端点。`);
    const bullish = leg.direction === 'bullish';
    const startPrice = bullish ? candles[start].low : candles[start].high;
    const endPrice = bullish ? candles[end].high : candles[end].low;
    if (!equalPrice(leg.startPrice, startPrice) || !equalPrice(leg.endPrice, endPrice)) fail(`波段 ${leg.id} 端点须精确对应实际 K 线高低价。`);
    if (!(bullish ? leg.endPrice > leg.startPrice : leg.endPrice < leg.startPrice)) fail(`波段 ${leg.id} 的价格方向不一致。`);
    if (leg.status === 'confirmed' && (!isPivot(candles, start, bullish ? 'low' : 'high') || !isPivot(candles, end, bullish ? 'high' : 'low'))) fail(`波段 ${leg.id} 确认需要左右各 2 根的有效摆动端点。`);
  }
  for (const pattern of pa.patterns) {
    reserve(pattern);
    const [start, end] = span(pattern);
    if (!matchesPAPattern(pattern, candles[start], candles[end], end === start + 1)) fail(`K 线形态 ${pattern.id} 不满足 ${pattern.kind} 的实际蜡烛规则。`);
  }
  for (const event of pa.breakouts) {
    reserve(event);
    const zone = pa.zones.find(item => item.id === event.zoneId);
    if (!zone) fail(`突破 ${event.id} 引用了不存在的区域。`);
    const area = zone!;
    if (area.status !== 'confirmed') fail(`突破 ${event.id} 的参考区域尚未确认。`);
    const breakout = indexOf(event.breakoutTime, event.id);
    const end = indexOf(area.endTime, area.id);
    const bullish = event.direction === 'bullish';
    const beyond = (candle: Candle) => bullish ? candle.close > area.upperPrice : candle.close < area.lowerPrice;
    if (breakout <= end || !beyond(candles[breakout])) fail(`突破 ${event.id} 缺少区域形成后的收盘越界。`);
    if (candles.slice(end + 1, breakout).some(beyond)) fail(`突破 ${event.id} 必须记录区域形成后首次同向收盘越界。`);
    if (area.kind === 'support' && bullish || area.kind === 'resistance' && !bullish) fail(`突破 ${event.id} 与参考支撑/阻力的穿越方向不一致。`);
    let retest: number | null = null;
    if (event.retestTime !== null) {
      retest = indexOf(event.retestTime, event.id);
      if (retest <= breakout || !paRetestTouches(area, event.direction, candles[retest])) fail(`突破 ${event.id} 的回踩须在突破之后触达实际边界带。`);
    }
    if (event.confirmationTime !== null) {
      const confirmation = indexOf(event.confirmationTime, event.id);
      if (retest === null || confirmation < retest || !beyond(candles[retest]) || !beyond(candles[confirmation])) fail(`突破 ${event.id} 的站稳确认需要已回踩且收盘保持在突破侧。`);
      if (candles.slice(breakout + 1, confirmation + 1).some(candle => bullish ? candle.close < area.lowerPrice : candle.close > area.upperPrice)) fail(`突破 ${event.id} 在确认前已经收盘穿越整个区域失效。`);
    }
    if (event.status === 'confirmed' && (event.retestTime === null || event.confirmationTime === null)) fail(`突破 ${event.id} 仍缺少回踩和站稳确认，只能是候选。`);
  }
  return usedIds;
}

/** Deterministic demonstration on supplied OHLCV only. No synthetic future coordinates. */
export function detectPriceAction(candles: Candle[]): PriceAction {
  const last = candles.at(-1)!;
  const recent = candles.slice(-30);
  const move = (last.close - recent[0].close) / recent[0].close;
  const ranges = candles.map(candle => candle.high - candle.low).filter(value => value > 0).sort((a, b) => a - b);
  const medianRange = ranges.length ? ranges[Math.floor(ranges.length / 2)] : 0;
  const regime: PriceAction['regime'] = move > 0.008 ? 'uptrend' : move < -0.008 ? 'downtrend' : 'transition';
  const pa: PriceAction = { regime, summary: `模拟 PA 研究：近 ${recent.length} 根净变化 ${(move * 100).toFixed(2)}%；区域依据重复价格触及，波段使用已确认摆动端点，蜡烛形态按严格几何规则识别。形态成立不代表交易结果。`, zones: [], legs: [], patterns: [], breakouts: [] };
  if (!(medianRange > 0)) return pa;
  const pivots: { index: number; side: 'high' | 'low'; price: number }[] = [];
  for (let index = 2; index < candles.length - 2; index++) {
    for (const side of ['high', 'low'] as const) if (isPivot(candles, index, side)) pivots.push({ index, side, price: candles[index][side] });
  }
  const minimum = Math.min(...candles.map(candle => candle.low));
  const maximum = Math.max(...candles.map(candle => candle.high));
  const tolerance = Math.max(medianRange * 0.4, last.close * 0.0005);
  for (const side of ['low', 'high'] as const) {
    const candidates = pivots.filter(pivot => pivot.side === side);
    const groups = candidates.map(pivot => candidates.filter(other => Math.abs(other.price - pivot.price) <= tolerance))
      .filter(group => group.length >= 2 && group.at(-1)!.index - group[0].index >= 2)
      .sort((a, b) => b.length - a.length || b.at(-1)!.index - a.at(-1)!.index);
    const group = groups[0];
    if (!group) continue;
    const lowerPrice = Math.max(minimum, Math.min(...group.map(pivot => pivot.price)) - medianRange * 0.08);
    const upperPrice = Math.min(maximum, Math.max(...group.map(pivot => pivot.price)) + medianRange * 0.08);
    if (!(upperPrice > lowerPrice)) continue;
    const kind = side === 'low' ? 'support' : 'resistance';
    const zone: PAZone = { id: `pa-${kind}-${group[0].index}`, kind, status: 'confirmed', title: side === 'low' ? '重复承接带' : '重复受阻带',
      startTime: candles[group[0].index].timestamp, endTime: candles[group.at(-1)!.index].timestamp, lowerPrice, upperPrice,
      touchTimes: group.map(pivot => candles[pivot.index].timestamp).slice(-30),
      rationale: `模拟规则：${group.length} 个已确认摆动${side === 'low' ? '低点' : '高点'}落入相近价格带；只说明历史重复反应。`,
      invalidation: `后续收盘有效${side === 'low' ? '跌破下沿' : '越过上沿'}时，原${side === 'low' ? '承接' : '受阻'}假设失效；历史区域仍保留。` };
    zone.touchTimes = zone.touchTimes.filter(timestamp => paZoneTouch(zone, candles.find(candle => candle.timestamp === timestamp)!));
    if (zone.touchTimes.length >= 2) pa.zones.push(zone);
  }
  if (pa.zones.length === 2) {
    const support = pa.zones.find(zone => zone.kind === 'support')!;
    const resistance = pa.zones.find(zone => zone.kind === 'resistance')!;
    const startTime = Math.min(support.startTime, resistance.startTime);
    const endTime = Math.max(support.endTime, resistance.endTime);
    const lowerPrice = support.lowerPrice;
    const upperPrice = resistance.upperPrice;
    if (upperPrice > lowerPrice && resistance.lowerPrice > support.upperPrice) {
      const zone: PAZone = { id: 'pa-trading-range', kind: 'trading-range', status: 'confirmed', title: '双边反复测试区间', startTime, endTime, lowerPrice, upperPrice,
        touchTimes: [...new Set([...support.touchTimes, ...resistance.touchTimes])].sort((a, b) => a - b).slice(-30),
        rationale: '模拟规则：上下边界各至少两次触及，形成期间所有收盘仍在区间内；区间中部没有单独方向优势。', invalidation: '收盘突破任一边界后，区间延续假设需要重新评估；须另行观察回踩是否站稳。' };
      try {
        validatePriceAction({ ...pa, zones: [zone], legs: [], patterns: [], breakouts: [] }, candles, new Set());
        pa.zones.push(zone);
        const recentInside = recent.filter(candle => candle.close >= lowerPrice && candle.close <= upperPrice).length / recent.length;
        if (last.close >= lowerPrice && last.close <= upperPrice && recentInside >= 0.8) pa.regime = 'range';
      } catch { /* A paired band is not necessarily a valid trading range. */ }
    }
  }
  // Consecutive opposite pivots form observed legs, with no projection beyond data.
  const alternating: typeof pivots = [];
  for (const pivot of pivots) {
    const previous = alternating.at(-1);
    if (previous?.index === pivot.index) continue;
    if (previous?.side === pivot.side) {
      if (pivot.side === 'high' ? pivot.price > previous.price : pivot.price < previous.price) alternating[alternating.length - 1] = pivot;
    } else alternating.push(pivot);
  }
  for (let position = 1; position < alternating.length; position++) {
    const start = alternating[position - 1];
    const end = alternating[position];
    const direction = start.side === 'low' ? 'bullish' : 'bearish';
    if (!(direction === 'bullish' ? end.price > start.price : end.price < start.price)) continue;
    const kind = direction === (move >= 0 ? 'bullish' : 'bearish') ? 'impulse' : 'pullback';
    pa.legs.push({ id: `pa-leg-${start.index}-${end.index}`, kind, direction, status: 'confirmed', title: `${kind === 'impulse' ? '推动' : '回撤'}波段`,
      startTime: candles[start.index].timestamp, endTime: candles[end.index].timestamp, startPrice: start.price, endPrice: end.price,
      rationale: '模拟规则：用左右各 2 根确认的相邻异向摆动点连接历史波段；推动/回撤相对于近 30 根净变化定义，并非完整趋势理论。',
      invalidation: '后续相反结构会改变波段的趋势含义；摆动确认有 2 根延迟，不能把端点当作即时信号。' });
  }
  pa.legs = pa.legs.slice(-3);
  for (let index = 0; index < candles.length; index++) {
    for (const kind of ['pin-bar', 'engulfing', 'inside-bar'] as const) {
      const start = kind === 'pin-bar' ? index : index - 1;
      if (start < 0) continue;
      const directions = kind === 'inside-bar' ? ['neutral'] as const : ['bullish', 'bearish'] as const;
      for (const direction of directions) {
        if (!matchesPAPattern({ kind, direction }, candles[start], candles[index], index === start + 1)) continue;
        pa.patterns.push({ id: `pa-${kind}-${index}`, kind, direction, status: index === candles.length - 1 ? 'candidate' : 'confirmed',
          title: kind === 'pin-bar' ? `${direction === 'bullish' ? '下影' : '上影'}拒绝` : kind === 'engulfing' ? `${direction === 'bullish' ? '看多' : '看空'}实体吞没` : '内包收缩',
          startTime: candles[start].timestamp, endTime: candles[index].timestamp,
          rationale: kind === 'pin-bar' ? '模拟规则：主影线至少占振幅 60%、至少为实体 2 倍，反侧影线不超过 25%，实体不超过 35%。'
            : kind === 'engulfing' ? '模拟规则：相邻两根实体反色，后一根实体严格更大且完整包住前一实体；不要求影线包裹。'
              : '模拟规则：后一根最高价严格低于母线最高价、最低价严格高于母线最低价。仅表示振幅收缩，方向中性。',
          invalidation: `${index === candles.length - 1 ? '末根收盘状态未知，只标为候选；' : '仅确认输入蜡烛的历史几何形态；'}后续有效越过形态反侧边界会否定方向解释，形态本身不保证延续或反转。` });
      }
    }
  }
  // Keep one recent representative per kind, then the most recent remaining pattern.
  const selected = new Map<string, PAPattern>();
  for (const kind of ['pin-bar', 'engulfing', 'inside-bar'] as const) {
    const pattern = [...pa.patterns].reverse().find(item => item.kind === kind);
    if (pattern) selected.set(pattern.id, pattern);
  }
  for (const pattern of pa.patterns.slice(-4)) if (selected.size < 4) selected.set(pattern.id, pattern);
  pa.patterns = [...selected.values()].sort((a, b) => a.endTime - b.endTime);
  for (const zone of [...pa.zones].reverse()) {
    const end = candles.findIndex(candle => candle.timestamp === zone.endTime);
    const allowed = zone.kind === 'support' ? ['bearish'] as const : zone.kind === 'resistance' ? ['bullish'] as const : ['bullish', 'bearish'] as const;
    for (const direction of allowed) {
      const beyond = (candle: Candle) => direction === 'bullish' ? candle.close > zone.upperPrice : candle.close < zone.lowerPrice;
      const breakoutIndex = candles.findIndex((candle, index) => index > end && beyond(candle));
      if (breakoutIndex < 0) continue;
      const retestIndex = candles.findIndex((candle, index) => index > breakoutIndex && paRetestTouches(zone, direction, candle));
      const held = retestIndex >= 0 && beyond(candles[retestIndex])
        && !candles.slice(breakoutIndex + 1, retestIndex + 1).some(candle => direction === 'bullish' ? candle.close < zone.lowerPrice : candle.close > zone.upperPrice);
      pa.breakouts.push({ id: `pa-retest-${zone.id}-${direction}`, zoneId: zone.id, direction, status: held ? 'confirmed' : 'candidate',
        title: held ? '突破后回踩站稳' : retestIndex >= 0 ? '突破回踩待站稳' : '收盘突破待回踩',
        breakoutTime: candles[breakoutIndex].timestamp, retestTime: retestIndex >= 0 ? candles[retestIndex].timestamp : null,
        confirmationTime: held ? candles[retestIndex].timestamp : null,
        rationale: `模拟规则：区域形成后首次${direction === 'bullish' ? '向上' : '向下'}收盘越界；${held ? '后续回踩边界带且收盘仍保持突破侧。' : retestIndex >= 0 ? '已触及边界，但尚未满足收盘保持突破侧。' : '窗口内尚无后续边界回踩证据。'}`,
        invalidation: '收盘反向穿越完整参考区域，或回踩无法保持突破侧时，延续假设失效；历史事件不等于当前开仓信号。' });
    }
  }
  // A range boundary can also be a standalone resistance/support band. Keep
  // one depiction of the same observed phases, with the range visited first.
  const seenBreakouts = new Set<string>();
  pa.breakouts = pa.breakouts.filter(event => {
    const key = `${event.direction}:${event.breakoutTime}:${event.retestTime}:${event.confirmationTime}`;
    if (seenBreakouts.has(key)) return false;
    seenBreakouts.add(key);
    return true;
  }).slice(0, 2);
  return pa;
}
