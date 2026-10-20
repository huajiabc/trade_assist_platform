import { validateAnalysis, type Analysis, type LiquiditySweep, type Structure, type StructureType, type TradeSetup } from './analysis';
import { MIN_CANDLES, type Candle } from './market';
import { formatPrice } from './format';
import { detectPriceAction } from './priceAction';

type Pivot = { index: number; side: 'high' | 'low'; price: number; type: StructureType };

/** Deterministic educational demonstration. This is intentionally not an AI prediction. */
export function createMockAnalysis(candles: Candle[]): Analysis {
  if (candles.length < MIN_CANDLES) throw new Error(`模拟分析至少需要 ${MIN_CANDLES} 根 K 线。`);
  const pivots: Pivot[] = [];
  let previousHigh: number | undefined;
  let previousLow: number | undefined;
  for (let index = 2; index < candles.length - 2; index++) {
    const candle = candles[index];
    const neighbors = [candles[index - 2], candles[index - 1], candles[index + 1], candles[index + 2]];
    if (neighbors.every((other) => candle.high > other.high)) {
      if (previousHigh !== undefined && candle.high !== previousHigh) pivots.push({ index, side: 'high', price: candle.high, type: candle.high > previousHigh ? 'HH' : 'LH' });
      previousHigh = candle.high;
    }
    if (neighbors.every((other) => candle.low < other.low)) {
      if (previousLow !== undefined && candle.low !== previousLow) pivots.push({ index, side: 'low', price: candle.low, type: candle.low > previousLow ? 'HL' : 'LL' });
      previousLow = candle.low;
    }
  }
  const structures: Structure[] = pivots.slice(-30).map((pivot) => ({
    id: `swing-${pivot.index}-${pivot.side}`,
    type: pivot.type,
    status: 'confirmed',
    direction: pivot.type === 'HH' || pivot.type === 'HL' ? 'bullish' : 'bearish',
    startTime: candles[pivot.index].timestamp,
    endTime: candles[pivot.index].timestamp,
    price: pivot.price,
    priceEnd: null,
    rationale: `模拟规则：该${pivot.side === 'high' ? '高' : '低'}点高/低于左右各 2 根 K 线，并与前一个同类摆动点比较得到 ${pivot.type}。右侧第 2 根收盘后才可确认，不可回溯当作实时信号。`,
    invalidation: '这是已发生的局部摆动记录；后续突破会改变结构含义，不能据此推断持续涨跌。',
  }));

  const breaks: Structure[] = [];
  for (const pivot of pivots) {
    const bullish = pivot.side === 'high';
    const breakIndex = candles.findIndex((candle, index) => index > pivot.index + 2 && (bullish ? candle.close > pivot.price : candle.close < pivot.price));
    if (breakIndex < 0) continue;
    const direction = bullish ? 'bullish' : 'bearish';
    breaks.push({
      id: `break-${pivot.index}-${pivot.side}`,
      type: 'BOS',
      status: 'confirmed',
      direction,
      startTime: candles[pivot.index].timestamp,
      endTime: candles[breakIndex].timestamp,
      price: pivot.price,
      priceEnd: null,
      rationale: `模拟规则：收盘价${bullish ? '上穿' : '下穿'}已确认摆动${bullish ? '高' : '低'}点 ${formatPrice(pivot.price, false)}。`,
      invalidation: `价格重新收回突破位 ${formatPrice(pivot.price, false)} 的另一侧时，突破延续假设失效。`,
    });
  }
  // Classify changes in chronological confirmation order, never pivot discovery order.
  breaks.sort((a, b) => a.endTime - b.endTime || b.startTime - a.startTime);
  const seenBreaks = new Set<string>();
  const uniqueBreaks = breaks.filter((event) => {
    const key = `${event.endTime}-${event.direction}`;
    if (seenBreaks.has(key)) return false;
    seenBreaks.add(key);
    return true;
  });
  breaks.splice(0, breaks.length, ...uniqueBreaks);
  let regime: 'bullish' | 'bearish' | 'neutral' | undefined;
  for (const event of breaks) {
    event.type = regime && regime !== event.direction ? 'CHoCH' : 'BOS';
    regime = event.direction;
    event.rationale += event.type === 'CHoCH' ? '与前一次突破方向相反，标为局部 CHoCH。' : '作为局部突破示例，不代表更高周期趋势已确认。';
  }
  structures.push(...breaks.slice(-12));

  const gaps: Structure[] = [];
  for (let index = 2; index < candles.length; index++) {
    const earlier = candles[index - 2];
    const current = candles[index];
    const bullish = current.low > earlier.high;
    const bearish = current.high < earlier.low;
    if (!bullish && !bearish) continue;
    const lower = bullish ? earlier.high : current.high;
    const upper = bullish ? current.low : earlier.low;
    const fillIndex = candles.findIndex((candle, next) => next > index && (bullish ? candle.low <= lower : candle.high >= upper));
    gaps.push({
      id: `fvg-${index}`,
      type: 'FVG',
      status: 'confirmed',
      direction: bullish ? 'bullish' : 'bearish',
      startTime: earlier.timestamp,
      endTime: candles[fillIndex < 0 ? candles.length - 1 : fillIndex].timestamp,
      price: lower,
      priceEnd: upper,
      rationale: `模拟规则：三根 K 线的第一根与第三根影线之间存在 ${formatPrice(lower, false)}–${formatPrice(upper, false)} 缺口。${fillIndex < 0 ? '窗口内尚未完全回补。' : '窗口内已经完全回补，区域结束于回补时刻。'}这里只确认价格缺口形态。`,
      invalidation: '缺口回补后不再视为未填补区域；形态存在不保证价格会回访或反转。',
    });
  }
  // Retain both directions when available and a small recent set, avoiding unreadable overlays.
  const gapSelection = [...gaps.slice(-5)];
  for (const direction of ['bullish', 'bearish'] as const) {
    const matching = [...gaps].reverse().find((gap) => gap.direction === direction);
    if (matching && !gapSelection.some((gap) => gap.id === matching.id)) gapSelection.push(matching);
  }
  structures.push(...gapSelection);

  const activeObIds = new Set<string>();
  for (const event of breaks.slice(-4)) {
    const breakIndex = candles.findIndex((candle) => candle.timestamp === event.endTime);
    let origin = -1;
    for (let index = breakIndex - 1; index >= Math.max(0, breakIndex - 8); index--) {
      const candle = candles[index];
      if (event.direction === 'bullish' ? candle.close < candle.open : candle.close > candle.open) { origin = index; break; }
    }
    if (origin < 0 || structures.some((structure) => structure.id === `ob-${origin}`)) continue;
    const candle = candles[origin];
    if (candle.open === candle.close) continue;
    const lower = Math.min(candle.open, candle.close);
    const upper = Math.max(candle.open, candle.close);
    const invalidIndex = candles.findIndex((next, index) => index >= breakIndex && (event.direction === 'bullish' ? next.close < lower : next.close > upper));
    if (invalidIndex < 0) activeObIds.add(`ob-${origin}`);
    structures.push({
      id: `ob-${origin}`,
      type: 'OB',
      status: 'candidate',
      direction: event.direction,
      startTime: candle.timestamp,
      endTime: candles[invalidIndex < 0 ? candles.length - 1 : invalidIndex].timestamp,
      price: lower,
      priceEnd: upper,
      rationale: `模拟候选规则：突破前最近 8 根内最后一根反向 K 线的实体区域。尚未进行位移强度、流动性或回测确认，不能认定为机构订单。${invalidIndex < 0 ? '' : '窗口内收盘价已穿越失效边界，该历史候选已失效，仅保留至失效时刻，不用于观察计划。'}`,
      invalidation: `收盘价穿越该实体区域的${event.direction === 'bullish' ? '下' : '上'}边界时，候选支撑/阻力假设失效。`,
    });
  }
  const last = candles[candles.length - 1];
  const highPivot = [...pivots].reverse().find((pivot) => pivot.side === 'high');
  const lowPivot = [...pivots].reverse().find((pivot) => pivot.side === 'low');
  const candidateHigh = highPivot && candles.slice(-3, -1).every((candle) => last.high > candle.high);
  const candidateLow = lowPivot && candles.slice(-3, -1).every((candle) => last.low < candle.low);
  const candidateHighType = candidateHigh && last.high !== highPivot.price ? last.high > highPivot.price ? 'HH' : 'LH' : null;
  const candidateLowType = candidateLow && last.low !== lowPivot.price ? last.low < lowPivot.price ? 'LL' : 'HL' : null;
  const candidateType: StructureType | null = candidateHighType ?? candidateLowType;
  if (candidateType) structures.push({
    id: 'pending-latest-swing', type: candidateType, status: 'candidate',
    direction: candidateType === 'LL' || candidateType === 'LH' ? 'bearish' : 'bullish',
    startTime: last.timestamp, endTime: last.timestamp,
    price: candidateType === 'HH' || candidateType === 'LH' ? last.high : last.low, priceEnd: null,
    rationale: '末根 K 线右侧没有后续数据，无法确认摆动。此标注仅演示候选状态，后续 K 线可能完全否定该假设。',
    invalidation: '后续价格继续向同侧延伸，或不能形成左右各 2 根的局部极值时，此候选不成立。',
  });
  const first = candles[Math.max(0, candles.length - 30)];
  const relativeMove = (last.close - first.close) / first.close;
  const trend = relativeMove > 0.008 ? 'bullish' : relativeMove < -0.008 ? 'bearish' : 'neutral';
  const high = Math.max(...candles.map((candle) => candle.high));
  const low = Math.min(...candles.map((candle) => candle.low));
  const candidateZone = [...structures].reverse().find((structure) => structure.type === 'OB' && activeObIds.has(structure.id));
  const liquiditySweeps: LiquiditySweep[] = [];
  for (const pivot of pivots) {
    const buySide = pivot.side === 'high';
    // A pivot only becomes known after its two right-hand candles. Inspect the
    // first later wick crossing; a previous close breakout retires the level.
    const sweepIndex = candles.findIndex((candle, index) => index > pivot.index + 2
      && (buySide ? candle.high > pivot.price : candle.low < pivot.price));
    if (sweepIndex < 0) continue;
    const candle = candles[sweepIndex];
    const reclaimed = buySide ? candle.close < pivot.price : candle.close > pivot.price;
    if (!reclaimed && sweepIndex !== candles.length - 1) continue;
    liquiditySweeps.push({
      id: `sweep-${pivot.index}-${pivot.side}`,
      side: buySide ? 'buy-side' : 'sell-side',
      levelTime: candles[pivot.index].timestamp,
      sweepTime: candle.timestamp,
      levelPrice: pivot.price,
      extremePrice: buySide ? candle.high : candle.low,
      status: reclaimed ? 'confirmed' : 'candidate',
      rationale: `模拟规则：价格影线${buySide ? '上穿已确认摆动高点' : '下穿已确认摆动低点'} ${formatPrice(pivot.price, false)}，${reclaimed ? '该根收盘已回到参考价内侧，满足本规则的扫除形态。' : '该根收盘尚未回到参考价内侧，仅标记穿越候选。'}这是 OHLC 价格行为代理，无法证明实际止损单或订单簿流动性。`,
      invalidation: `后续收盘持续位于参考价${buySide ? '上方' : '下方'}时，扫除后的反转假设失效；历史影线记录本身仍然存在。`,
    });
  }
  liquiditySweeps.sort((a, b) => a.sweepTime - b.sweepTime);
  const tradeSetups: TradeSetup[] = [];
  const basis = candidateZone ?? [...breaks].reverse().find(event => structures.some(structure => structure.id === event.id));
  const recent = candles.slice(-14);
  const averageRange = recent.reduce((sum, candle) => sum + candle.high - candle.low, 0) / recent.length;
  if (basis && averageRange > last.close * Number.EPSILON * 16 && high > low) {
    const direction = basis.direction === 'bearish' ? 'bearish' : 'bullish';
    const sign = direction === 'bullish' ? 1 : -1;
    // Reference levels are recomputed at the latest input candle, never a
    // resurrected historical fill. Distance is volatility-based and bounded.
    const risk = Math.min(averageRange * 1.2, last.close * 0.4, (high - low) * 0.7);
    const stopLoss = last.close - sign * risk;
    const targets = [2, 3].map(ratio => ({ price: last.close + sign * risk * ratio, label: `参考目标 ${ratio}R` }));
    if (targets.every(target => target.price > 0) && stopLoss > 0 && risk > last.close * Number.EPSILON * 8) {
      tradeSetups.push({
        id: 'watch-latest-reference', opportunityId: null,
        direction, status: 'candidate', anchorTime: last.timestamp,
        entry: last.close, stopLoss, targets, structureIds: [basis.id],
        tracking: null, basis: null,
        trigger: '模拟几何演示，尚未提供经验证的开仓触发条件；需独立复核行情与基础结构，不作为可执行信号。',
        rationale: `模拟观察计划：用最后一根输入 K 线收盘 ${formatPrice(last.close, false)} 作为假设开仓参考，止损距离取最近 ${recent.length} 根平均高低振幅的 1.2 倍；需要独立触发确认。2R/3R 仅用于盈亏比几何演示，并非已发生开仓或对未来价格的预测。`,
        invalidation: `参考止损 ${formatPrice(stopLoss, false)} 被有效穿越，或基础结构失效时，取消此假设；新行情到达后必须重新评估。盈亏比未计入手续费、点差与滑点。`,
      });
    }
  }
  const analysis: Analysis = {
    schemaVersion: '1.5', research: null,
    trend,
    bias: 'neutral',
    summary: `模拟分析 · 基于 ${candles.length} 根已提供的 K 线，以局部极值、收盘突破与三根 K 线缺口规则生成可交互示例。近 30 根价格变化约 ${(relativeMove * 100).toFixed(2)}%；结构记录和候选区域不能替代独立验证。`,
    structures,
    keyLevels: [
      { label: '窗口高点', price: high, reason: '当前输入行情内最高的 high；超出窗口的历史价位未知。' },
      { label: '窗口低点', price: low, reason: '当前输入行情内最低的 low；超出窗口的历史价位未知。' },
      { label: '最新收盘', price: last.close, reason: '输入数据最后一根 K 线的 close，无法确认这根数据是否已在交易所最终收盘。' },
    ],
    opportunities: candidateZone ? [{
      id: 'watch-zone-retest',
      direction: candidateZone.direction === 'bearish' ? 'bearish' : 'bullish',
      trigger: `仅作观察：价格回访 ${formatPrice(candidateZone.price, false)}–${formatPrice(candidateZone.priceEnd!, false)} 区域后，须等待独立的收盘确认与更高周期证据。`,
      invalidation: candidateZone.invalidation,
      target: '未给出可执行目标价；可观察窗口内前高/前低，须自行评估盈亏比。',
      risk: '候选 OB 规则简化，可能频繁失效；未计入点差、手续费、滑点、新闻和仓位风险。',
      structureIds: [candidateZone.id],
    }] : [],
    tradeSetups,
    tradePlanning: {
      status: tradeSetups.length ? 'conditional' : candidateZone ? 'watch-only' : 'no-setup',
      reason: tradeSetups.length
        ? '模拟规则提供条件性的盈亏区间几何演示，未调用 AI，也未确认开仓触发或成交。'
        : candidateZone ? '模拟规则只提供区域观察，缺少可量化数值计划的有效距离，不生成入场、止损和目标价。'
          : '模拟规则未找到可引用的当前计划依据，不生成数值开仓候选。',
    },
    liquiditySweeps: liquiditySweeps.slice(-6),
    priceAction: detectPriceAction(candles),
    uncertainties: [
      '这是确定性模拟规则输出，未调用大模型，也未使用成交明细、订单簿或更高周期数据。',
      '历史摆动点使用左右各 2 根 K 线确认，存在确认延迟；不能将标注时间当成当时已知的信号时间。',
      'PA/SMC 定义具有主观性，BOS、CHoCH、FVG 与候选 OB 仅展示形态或假设，不保证未来表现。',
    ],
  };
  return validateAnalysis(analysis, candles);
}
