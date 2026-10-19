import { MAX_CANDLES, type Candle } from './market';

export type RuleIndicatorType = 'FVG' | 'OB';
export type RuleIndicatorDirection = 'bullish' | 'bearish';
export type RuleIndicatorStatus = 'active' | 'partial' | 'filled' | 'tested' | 'invalidated';

/** Deterministic observations, separate from model conclusions or trade signals. */
export interface RuleIndicatorZone {
  id: string;
  type: RuleIndicatorType;
  direction: RuleIndicatorDirection;
  status: RuleIndicatorStatus;
  originTime: number;
  /** The first closed candle at which this observation was knowable. */
  formedAt: number;
  endTime: number;
  lowerPrice: number;
  upperPrice: number;
  midpoint: number;
  firstTouchTime: number | null;
  resolvedTime: number | null;
  /** Maximum subsequent wick penetration, from the near edge to the far edge. */
  mitigation: number;
  rationale: string;
  invalidation: string;
  evidenceTimes: number[];
}

export const RULE_INDICATOR_PARAMETERS = {
  pivotLeft: 2,
  pivotRight: 2,
  obLookback: 12,
  minFvgPct: 0,
  fvgDefinition: 'three-candle-wick-gap-with-middle-close',
  obDefinition: 'last-opposing-body-after-confirmed-swing-close-break',
} as const;

export interface RuleIndicatorSnapshot {
  version: '1.0';
  asOf: number | null;
  candleCount: number;
  parameters: typeof RULE_INDICATOR_PARAMETERS;
  zones: RuleIndicatorZone[];
}

interface Swing {
  index: number;
  confirmedIndex: number;
  price: number;
  broken: boolean;
}

function validateInput(candles: readonly Candle[]): void {
  if (!Array.isArray(candles) || candles.length > MAX_CANDLES) {
    throw new Error(`规则指标最多接收 ${MAX_CANDLES} 根已收盘 K 线。`);
  }
  let previousTime = -1;
  for (const [index, candle] of candles.entries()) {
    if (!candle || typeof candle !== 'object'
      || !['timestamp', 'open', 'high', 'low', 'close', 'volume'].every(
        key => typeof candle[key as keyof Candle] === 'number' && Number.isFinite(candle[key as keyof Candle]),
      )) {
      throw new Error(`规则指标第 ${index + 1} 根 K 线存在缺失或非有限数值。`);
    }
    if (!Number.isInteger(candle.timestamp) || candle.timestamp < 0 || candle.timestamp > 4_102_444_800
      || candle.timestamp <= previousTime) {
      throw new Error('规则指标的时间须为严格递增的有效 UTC Unix 整秒。');
    }
    if (Math.min(candle.open, candle.high, candle.low, candle.close) <= 0
      || candle.high < Math.max(candle.open, candle.close, candle.low)
      || candle.low > Math.min(candle.open, candle.close, candle.high)
      || candle.volume < 0 || candle.volume > Number.MAX_SAFE_INTEGER) {
      throw new Error(`规则指标第 ${index + 1} 根 K 线的 OHLCV 无效。`);
    }
    previousTime = candle.timestamp;
  }
}

function createZone(
  type: RuleIndicatorType,
  direction: RuleIndicatorDirection,
  origin: Candle,
  formed: Candle,
  lowerPrice: number,
  upperPrice: number,
  evidenceTimes: number[],
): RuleIndicatorZone {
  const bullish = direction === 'bullish';
  return {
    id: `rule-${type.toLowerCase()}-${direction}-${origin.timestamp}${type === 'FVG' ? `-${formed.timestamp}` : ''}`,
    type,
    direction,
    status: 'active',
    originTime: origin.timestamp,
    formedAt: formed.timestamp,
    endTime: formed.timestamp,
    lowerPrice,
    upperPrice,
    midpoint: lowerPrice + (upperPrice - lowerPrice) / 2,
    firstTouchTime: null,
    resolvedTime: null,
    mitigation: 0,
    rationale: type === 'FVG'
      ? (bullish
        ? '三根已收盘 K 线中，第三根最低价高于第一根最高价，且中间根收盘高于第一根最高价；影线间形成多头 FVG。'
        : '三根已收盘 K 线中，第三根最高价低于第一根最低价，且中间根收盘低于第一根最低价；影线间形成空头 FVG。')
      : (bullish
        ? '收盘价向上突破已确认的 2/2 摆动高点；取突破前 12 根内最近一根阴线的实体作为多头 OB 规则候选，不证明机构订单。'
        : '收盘价向下突破已确认的 2/2 摆动低点；取突破前 12 根内最近一根阳线的实体作为空头 OB 规则候选，不证明机构订单。'),
    invalidation: type === 'FVG'
      ? (bullish ? '形成后的最低价触达下边界时，按影线规则记为完全回补。' : '形成后的最高价触达上边界时，按影线规则记为完全回补。')
      : (bullish ? '形成后收盘价严格低于实体下边界时失效；仅影线穿越不判失效。' : '形成后收盘价严格高于实体上边界时失效；仅影线穿越不判失效。'),
    evidenceTimes: [...new Set(evidenceTimes)].sort((a, b) => a - b),
  };
}

function updateZone(zone: RuleIndicatorZone, candle: Candle): void {
  if (zone.resolvedTime !== null || candle.timestamp <= zone.formedAt) return;
  zone.endTime = candle.timestamp;
  const bullish = zone.direction === 'bullish';
  const nearReached = bullish ? candle.low <= zone.upperPrice : candle.high >= zone.lowerPrice;
  const overlaps = candle.low <= zone.upperPrice && candle.high >= zone.lowerPrice;
  const penetration = bullish ? zone.upperPrice - candle.low : candle.high - zone.lowerPrice;
  const fraction = Math.max(0, Math.min(1, penetration / (zone.upperPrice - zone.lowerPrice)));

  if (zone.type === 'FVG') {
    if (!nearReached) return;
    zone.firstTouchTime ??= candle.timestamp;
    zone.mitigation = Math.max(zone.mitigation, fraction);
    const filled = bullish ? candle.low <= zone.lowerPrice : candle.high >= zone.upperPrice;
    zone.status = filled ? 'filled' : 'partial';
    if (filled) zone.resolvedTime = candle.timestamp;
    return;
  }

  if (overlaps) {
    zone.firstTouchTime ??= candle.timestamp;
    zone.mitigation = Math.max(zone.mitigation, fraction);
    zone.status = 'tested';
  }
  // A full wick excursion may test the OB; only a closed body beyond the far
  // boundary invalidates it. This check takes priority over a simultaneous test.
  if (bullish ? candle.close < zone.lowerPrice : candle.close > zone.upperPrice) {
    zone.status = 'invalidated';
    zone.mitigation = 1;
    zone.resolvedTime = candle.timestamp;
  }
}

/**
 * Detect every FVG/OB within the supplied history, without tail sampling.
 * The caller MUST exclude an exchange's still-forming candle: OHLCV alone does
 * not encode closure. Recomputing a longer prefix never backdates formation.
 */
export function detectRuleIndicators(closedCandles: readonly Candle[]): RuleIndicatorSnapshot {
  validateInput(closedCandles);
  const zones: RuleIndicatorZone[] = [];
  const orderBlockOrigins = new Set<string>();
  let swingHigh: Swing | null = null;
  let swingLow: Swing | null = null;

  const addOrderBlock = (swing: Swing, index: number, direction: RuleIndicatorDirection) => {
    swing.broken = true;
    const bullish = direction === 'bullish';
    for (let originIndex = index - 1; originIndex >= Math.max(0, index - RULE_INDICATOR_PARAMETERS.obLookback); originIndex--) {
      const origin = closedCandles[originIndex];
      const opposing = bullish ? origin.close < origin.open : origin.close > origin.open;
      if (!opposing) continue;
      const originKey = `${direction}-${origin.timestamp}`;
      if (orderBlockOrigins.has(originKey)) return;
      orderBlockOrigins.add(originKey);
      const formed = closedCandles[index];
      zones.push(createZone('OB', direction, origin, formed,
        Math.min(origin.open, origin.close), Math.max(origin.open, origin.close),
        [origin.timestamp, closedCandles[swing.index].timestamp, closedCandles[swing.confirmedIndex].timestamp, formed.timestamp]));
      return;
    }
  };

  for (let index = 0; index < closedCandles.length; index++) {
    const candle = closedCandles[index];
    // Update older observations before creating new ones: formation candles
    // cannot retroactively mitigate the zone they have just established.
    for (const zone of zones) updateZone(zone, candle);

    if (index >= 2) {
      const first = closedCandles[index - 2];
      const middle = closedCandles[index - 1];
      if (candle.low > first.high && middle.close > first.high) {
        zones.push(createZone('FVG', 'bullish', first, candle, first.high, candle.low,
          [first.timestamp, middle.timestamp, candle.timestamp]));
      } else if (candle.high < first.low && middle.close < first.low) {
        zones.push(createZone('FVG', 'bearish', first, candle, candle.high, first.low,
          [first.timestamp, middle.timestamp, candle.timestamp]));
      }
    }

    if (swingHigh && !swingHigh.broken && index > swingHigh.confirmedIndex && candle.close > swingHigh.price) {
      addOrderBlock(swingHigh, index, 'bullish');
    }
    if (swingLow && !swingLow.broken && index > swingLow.confirmedIndex && candle.close < swingLow.price) {
      addOrderBlock(swingLow, index, 'bearish');
    }

    const pivotIndex = index - RULE_INDICATOR_PARAMETERS.pivotRight;
    if (pivotIndex < RULE_INDICATOR_PARAMETERS.pivotLeft) continue;
    const pivot = closedCandles[pivotIndex];
    const neighbours = closedCandles.slice(pivotIndex - RULE_INDICATOR_PARAMETERS.pivotLeft, index + 1)
      .filter((_, offset) => offset !== RULE_INDICATOR_PARAMETERS.pivotLeft);
    if (neighbours.every(neighbour => pivot.high > neighbour.high)) {
      swingHigh = { index: pivotIndex, confirmedIndex: index, price: pivot.high, broken: false };
    }
    if (neighbours.every(neighbour => pivot.low < neighbour.low)) {
      swingLow = { index: pivotIndex, confirmedIndex: index, price: pivot.low, broken: false };
    }
  }

  return {
    version: '1.0',
    asOf: closedCandles.at(-1)?.timestamp ?? null,
    candleCount: closedCandles.length,
    parameters: { ...RULE_INDICATOR_PARAMETERS },
    zones,
  };
}
