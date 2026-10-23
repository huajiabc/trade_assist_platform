import type { Candle } from './market';
import { FRAME_SECONDS, type ResearchBundle, type ResearchFact } from './researchData';
import type { StrategyId } from './strategyTypes';
import type { TradeTrackingRule } from './tradeTracking';
import { tradeRiskContext } from './tradeRisk';

export interface StrategyTriggerSpec {
  strategyId: StrategyId;
  entryLow: number;
  entryHigh: number;
  confirmationPrice: number;
  evidenceIds: string[];
  knownAt: number;
  summary: string;
  tracking: TradeTrackingRule;
}

interface TriggerInput {
  strategyId: StrategyId;
  direction: 'bullish' | 'bearish';
  primary: ResearchFact;
  local: ResearchFact;
  range?: ResearchFact;
  reaction?: ResearchFact;
  bundle: ResearchBundle;
  facts: ResearchFact[];
  stop: ResearchFact;
  expiresAfterBars: number;
}

type Condition = TradeTrackingRule['steps'][number]['conditions'][number];
type Step = TradeTrackingRule['steps'][number];
const LOCAL_ZONE_ATR = .25;
const MAX_LOCAL_ANCHOR_ATR = 2;
const positive = (price: number) => Number.isFinite(price) && price > 0;

/** Builds future CLOSED-bar conditions from evidence already known at this snapshot.
 * Price bands describe a retest area, not new detected structures or executable orders.
 * This helper is used only for newly generated plans; saved tracking rules stay intact. */
export function buildStrategyTrigger(input: TriggerInput): { spec: StrategyTriggerSpec | null; reason: string } {
  const { strategyId, direction, primary, local, range, reaction, bundle, facts, stop, expiresAfterBars } = input;
  const reject = (reason: string) => ({ spec: null, reason });
  const sign = direction === 'bullish' ? 1 : -1;
  const known = (fact: ResearchFact) => positive(fact.low) && positive(fact.high) && fact.low <= fact.high
    && fact.status !== 'resolved' && fact.knownAt <= bundle.asOf && fact.formedAt <= bundle.asOf
    && fact.originTime <= bundle.asOf && (fact.confirmedAt === null || fact.confirmedAt <= bundle.asOf)
    && (fact.resolvedAt === null || fact.resolvedAt > bundle.asOf)
    && fact.evidenceTimes.every(time => time <= bundle.asOf);
  if (![primary, local, stop].every(known)) return reject('触发依据已失效、包含未来时间或价格无效，等待重新识别。');
  if (primary.timeframe !== '5m' || primary.direction !== direction || local.timeframe !== '1m'
    || local.direction !== direction || !['BOS', 'CHoCH'].includes(local.type)
    || local.status !== 'confirmed' || local.confirmedAt === null || local.confirmedAt > local.knownAt
    || stop.timeframe !== '5m' || stop.status !== 'confirmed') return reject('缺少有效5m机会、保护或已确认1m同向结构。');
  if (!Number.isInteger(expiresAfterBars) || expiresAfterBars < 1 || expiresAfterBars > 300) return reject('等待期限必须为1至300根新的1m已收盘K线。');
  if (!bundle.frames['1m'].integrity.usable || !bundle.frames['5m'].integrity.usable) return reject('1m或5m行情不完整，不能建立可计算触发。');

  const closed = (timeframe: '1m' | '5m') => bundle.frames[timeframe].candles
    .filter(bar => bar.timestamp + FRAME_SECONDS[timeframe] <= bundle.asOf);
  const one = closed('1m'), five = closed('5m');
  const volatility = tradeRiskContext(one);
  if (volatility.atr === null || volatility.atr <= 0 || volatility.intervalSeconds !== 60) return reject('缺少连续1m ATR上下文，无法限定局部触发区域。');
  const atr = volatility.atr;
  const entry = local.low;
  const sourceBar = one.find(bar => bar.timestamp + 60 === local.confirmedAt);
  if (!sourceBar) return reject('1m确认K线不在实际已收盘快照内，无法确定触发坐标。');
  const localExtreme = direction === 'bullish' ? sourceBar.high : sourceBar.low;
  if ((localExtreme - entry) * sign <= 0) return reject('局部确认K线没有可用的方向极值，等待新的结构确认。');
  const protection = direction === 'bullish' ? stop.low : stop.high;
  if ((entry - protection) * sign <= 0) return reject('保护结构不在参考入场的不利方向。');

  const evidence: ResearchFact[] = [primary, local, stop];
  let knownAt = Math.max(primary.knownAt, local.knownAt, stop.knownAt);
  const include = (fact: ResearchFact) => { evidence.push(fact); knownAt = Math.max(knownAt, fact.knownAt); };
  const closeBar = (time: number | null | undefined): Candle | undefined => time === null || time === undefined || time > bundle.asOf
    ? undefined : five.find(bar => bar.timestamp + 300 === time);
  const forward = (price: number): Condition => ({ type: direction === 'bullish' ? 'close-above' : 'close-below', price, priceEnd: null });
  const closeAbove = (price: number): Condition => ({ type: 'close-above', price, priceEnd: null });
  const closeBelow = (price: number): Condition => ({ type: 'close-below', price, priceEnd: null });
  const step = (label: string, conditions: Condition[]): Step => ({ label, conditions: conditions.filter((condition, index, all) =>
    all.findIndex(other => other.type === condition.type && other.price === condition.price && other.priceEnd === condition.priceEnd) === index) });
  const directionSide = (close: number, boundary: number) => (close - boundary) * sign > 0;
  const latestLocalZone = facts.filter(fact => known(fact) && fact.timeframe === '1m' && ['FVG', 'OB'].includes(fact.type)
    && fact.direction === direction && fact.knownAt <= local.knownAt && fact.low <= entry && fact.high >= entry && fact.high - fact.low <= atr)
    .sort((a, b) => b.knownAt - a.knownAt || a.id.localeCompare(b.id))[0];
  const zoneSource = latestLocalZone ?? { low: sourceBar.low, high: sourceBar.high };
  // A gap can leave the broken structure outside its confirming candle: retain its
  // actual point coordinate, rather than drawing a fictitious interpolated zone.
  let entryLow = zoneSource.low <= entry && zoneSource.high >= entry ? Math.max(zoneSource.low, entry - atr * LOCAL_ZONE_ATR) : entry;
  let entryHigh = zoneSource.low <= entry && zoneSource.high >= entry ? Math.min(zoneSource.high, entry + atr * LOCAL_ZONE_ATR) : entry;
  if (latestLocalZone) include(latestLocalZone);
  const touch = (): Condition => ({ type: 'touch-zone', price: entryLow, priceEnd: entryHigh });
  let confirmationPrice = localExtreme;
  let cancellationPrice = protection;
  let cancellationLabel = '触发前1m收盘失守所引用5m保护结构，取消候选';
  let steps: Step[];
  let summary: string;

  if (strategyId === 'sweep-reclaim') {
    if (primary.type !== 'sweep' || primary.reclaimTime === null || primary.reclaimTime > bundle.asOf) return reject('扫除尚未完成收盘收复，不能生成反转触发。');
    const reference = facts.filter(fact => known(fact) && fact.timeframe === '5m'
      && (direction === 'bullish' ? ['HL', 'LL', 'liquidity-low'].includes(fact.type) : ['HH', 'LH', 'liquidity-high'].includes(fact.type))
      && fact.knownAt < primary.formedAt && (primary.relatedIds?.includes(fact.id) || fact.originTime === primary.originTime)
      && fact.low >= primary.low && fact.high <= primary.high)
      .sort((a, b) => b.knownAt - a.knownAt || a.id.localeCompare(b.id))[0];
    const referencePrice = reference ? direction === 'bullish' ? reference.low : reference.high : primary.low === primary.high ? primary.low : null;
    const reclaimed = closeBar(primary.reclaimTime);
    if (referencePrice === null || !reclaimed || !directionSide(reclaimed.close, referencePrice)) return reject('缺少实际扫除参考位或已收复K线，不能猜测收复价格。');
    if (!reaction || !known(reaction) || reaction.timeframe !== '5m' || reaction.type !== 'CHoCH'
      || reaction.direction !== direction || reaction.confirmedAt === null || reaction.knownAt <= primary.reclaimTime
      || local.knownAt < reaction.knownAt) return reject('需要收复之后的5m反向CHoCH及其后的1m确认。');
    if (reference) include(reference);
    include(reaction); knownAt = Math.max(knownAt, primary.reclaimTime);
    confirmationPrice = direction === 'bullish' ? Math.max(localExtreme, referencePrice) : Math.min(localExtreme, referencePrice);
    steps = [step('新1m回踩局部区域并收盘守住扫除收复位', [touch(), forward(referencePrice)]),
      step('更晚1m收盘越过局部确认极值，验证收复延续', [forward(confirmationPrice)])];
    summary = '先在局部回踩中守住实际扫除收复位，再由更晚1m收盘越过反向结构确认K线极值；旧收复不视为成交。';
  } else if (strategyId === 'bos-retest') {
    if (primary.type !== 'BOS' || primary.confirmedAt === null || primary.confirmedAt > local.knownAt) return reject('5m突破尚未确认，或1m确认早于5m突破。');
    const brokenPrice = direction === 'bullish' ? primary.high : primary.low;
    const held = five.find(bar => bar.timestamp >= primary.knownAt && bar.timestamp + 300 <= local.knownAt
      && bar.low <= primary.high && bar.high >= primary.low && directionSide(bar.close, brokenPrice));
    if (!held) return reject('5m突破之后尚无实际回踩守位，等待机会结构。');
    if (Math.abs(entry - brokenPrice) > atr * .75) return reject('1m参考位已远离5m突破位，不能把远端回踩包装为局部入场。');
    // The broken price and the 1m structure are actual anchors; their close
    // proximity permits one bounded retest area containing both coordinates.
    entryLow = Math.min(entryLow, brokenPrice); entryHigh = Math.max(entryHigh, brokenPrice);
    knownAt = Math.max(knownAt, held.timestamp + 300);
    confirmationPrice = direction === 'bullish' ? Math.max(localExtreme, brokenPrice) : Math.min(localExtreme, brokenPrice);
    steps = [step('新的1m回踩5m突破位附近', [touch()]),
      step('更晚1m收盘重新守住突破位及局部结构', [forward(brokenPrice), forward(entry)]),
      step('再一根1m收盘突破已知局部极值，确认延续', [forward(confirmationPrice)])];
    summary = '突破后的真实5m回踩只作前提；未来1m依次回踩突破位附近、收盘守位、再突破已知局部极值，避免直接追突破K线。';
  } else if (strategyId === 'trend-pullback') {
    const reacted = closeBar(primary.reactionTime);
    const boundary = direction === 'bullish' ? primary.high : primary.low;
    if (!['FVG', 'OB'].includes(primary.type) || primary.low === primary.high || primary.reactionTime === null
      || primary.reactionTime <= primary.formedAt || primary.reactionTime > local.knownAt || primary.tests > 2
      || !reacted || reacted.high < primary.low || reacted.low > primary.high || !directionSide(reacted.close, boundary)) return reject('需要真实FVG/OB区域与形成后的收盘反应，不能仅凭触区生成入场。');
    knownAt = Math.max(knownAt, primary.reactionTime);
    confirmationPrice = direction === 'bullish' ? Math.max(localExtreme, boundary) : Math.min(localExtreme, boundary);
    steps = [step('新的1m仅回踩局部入场区域，不要求重返远端5m区域', [touch()]),
      step('更晚1m收盘保持在已反应FVG/OB及局部结构方向侧', [forward(boundary), forward(entry)]),
      step('随后1m收盘越过局部确认极值，验证趋势恢复', [forward(confirmationPrice)])];
    summary = '5m FVG/OB的真实回撤反应已发生；未来只复核局部回踩、守住已反应区域方向侧及随后延续，不强求再次返回远端5m区域。';
  } else if (strategyId === 'range-reversal') {
    if (!range || !known(range) || range.timeframe !== '15m' || range.type !== 'trading-range'
      || range.status !== 'confirmed' || range.confirmedAt === null || range.high <= range.low
      || range.knownAt >= primary.formedAt || !bundle.frames['15m'].integrity.usable) return reject('需要先于本次事件形成的有效15m区间。');
    const recoveryTime = primary.type === 'sweep' ? primary.reclaimTime : primary.type === 'failed-breakout' ? primary.failureTime : null;
    const recovered = closeBar(recoveryTime);
    const width = range.high - range.low;
    const quarter = direction === 'bullish' ? range.low + width * .25 : range.high - width * .25;
    const nearEdge = direction === 'bullish' ? primary.low <= range.low + width * .15 && entry < quarter && entry > range.low
      : primary.high >= range.high - width * .15 && entry > quarter && entry < range.high;
    if (!nearEdge || !recovered || recovered.close <= range.low || recovered.close >= range.high) return reject('未收回区间边缘，或局部入场已到区间中部，等待。');
    if (!reaction || !known(reaction) || reaction.timeframe !== '5m' || reaction.type !== 'CHoCH'
      || reaction.direction !== direction || reaction.confirmedAt === null || reaction.knownAt < recoveryTime!
      || local.knownAt < reaction.knownAt) return reject('区间收复后仍需5m反向结构和其后的1m确认。');
    if ((confirmationPrice - quarter) * sign >= 0) return reject('确认局部延续将进入区间中部，放弃边缘反转候选。');
    include(range); include(reaction); knownAt = Math.max(knownAt, recoveryTime!);
    steps = [step('新的1m回踩区间边缘局部区域且收盘保持区间内侧', [touch(), closeAbove(range.low), closeBelow(range.high)]),
      step('更晚1m收盘越过局部极值且仍在区间外侧四分之一', [forward(confirmationPrice), direction === 'bullish' ? closeBelow(quarter) : closeAbove(quarter)])];
    summary = '只研究已收复的区间边缘；新的局部回踩须收在区间内部，后续反向延续确认仍须留在外侧四分之一，进入中部则等待。';
  } else if (strategyId === 'failed-breakout') {
    const failed = closeBar(primary.failureTime);
    const failureBoundary = direction === 'bullish' ? primary.high : primary.low;
    if (primary.type !== 'failed-breakout' || primary.failureTime === undefined || primary.confirmedAt === null
      || primary.failureTime > primary.confirmedAt || primary.confirmedAt > local.knownAt
      || primary.breakoutTime !== undefined && primary.breakoutTime >= primary.failureTime
      || !failed || !directionSide(failed.close, failureBoundary)) return reject('缺少先突破、再失败收回及反向CHoCH的时间顺序与实际收盘。');
    const failureProtection = direction === 'bullish' ? failed.low : failed.high;
    const tighterActualProtection = direction === 'bullish' ? Math.max(protection, failureProtection) : Math.min(protection, failureProtection);
    if ((entry - tighterActualProtection) * sign > 0) cancellationPrice = tighterActualProtection;
    cancellationLabel = '触发前1m收盘失守失败收回K线外侧或5m保护，取消反转候选';
    knownAt = Math.max(knownAt, primary.failureTime, primary.confirmedAt);
    confirmationPrice = direction === 'bullish' ? Math.max(localExtreme, failureBoundary) : Math.min(localExtreme, failureBoundary);
    steps = [step('新的1m反向结构回踩并收盘守住失败突破收回侧', [touch(), forward(failureBoundary)]),
      step('更晚1m收盘越过反向确认极值，验证原突破失败', [forward(confirmationPrice)])];
    summary = '在已经确认的失败突破之后，局部回踩须收在失败收回侧，再由更晚收盘确认反向延续；失守失败K线外侧或5m保护即取消。';
  } else {
    if (primary.type !== 'displacement' || primary.reactionTime === null || primary.reactionTime > local.knownAt
      || primary.tests !== 1 || (primary.volumeRatio ?? 0) < 1.2 || (primary.displacementAtr ?? 0) < 1.5) return reject('强位移须有量能/ATR依据和唯一首次回撤反应，不能研究重复回踩或直接追价。');
    const displacement = five.find(bar => bar.timestamp === primary.originTime);
    const reacted = closeBar(primary.reactionTime);
    let zoneLow = primary.zoneLow, zoneHigh = primary.zoneHigh;
    if ((zoneLow === undefined || zoneHigh === undefined) && displacement) {
      const bodyLow = Math.min(displacement.open, displacement.close), body = Math.abs(displacement.close - displacement.open);
      zoneLow = bodyLow + body * .25; zoneHigh = bodyLow + body * .75;
    }
    const boundary = direction === 'bullish' ? zoneHigh : zoneLow;
    if (zoneLow === undefined || zoneHigh === undefined || !positive(zoneLow) || !positive(zoneHigh) || zoneHigh <= zoneLow
      || boundary === undefined || !reacted || primary.reactionTime <= primary.formedAt
      || reacted.high < zoneLow || reacted.low > zoneHigh || !directionSide(reacted.close, boundary)) return reject('无法从真实位移实体及首次回撤K线核验反应区域。');
    knownAt = Math.max(knownAt, primary.reactionTime);
    confirmationPrice = direction === 'bullish' ? Math.max(localExtreme, boundary) : Math.min(localExtreme, boundary);
    steps = [step('首次5m回撤反应之后，新的1m仅回踩局部结构', [touch()]),
      step('更晚1m收盘守住位移回撤区域方向侧', [forward(boundary), forward(entry)]),
      step('随后1m收盘越过局部极值，验证位移延续', [forward(confirmationPrice)])];
    summary = '仅限已确认的首次位移回撤：未来局部回踩、收盘保持位移反应区方向侧，再突破局部极值；不把强位移本身作为追价触发。';
  }

  if (![entryLow, entryHigh, confirmationPrice, cancellationPrice].every(positive) || entryLow > entry || entryHigh < entry
    || (confirmationPrice - entry) * sign <= 0 || Math.abs(confirmationPrice - entry) > atr * MAX_LOCAL_ANCHOR_ATR
    || entryHigh - entryLow > atr || (entry - cancellationPrice) * sign <= 0) return reject('触发价格离局部结构过远或方向无效，不能扩大入场区域追价。');
  return { spec: { strategyId, entryLow, entryHigh, confirmationPrice,
    evidenceIds: [...new Set(evidence.map(fact => fact.id))], knownAt, summary,
    tracking: { steps, cancellation: { basis: 'close', price: cancellationPrice, label: cancellationLabel }, expiresAfterBars } },
    reason: '策略专属触发已锚定当前已知结构；后续只核验已收盘条件，不代表开仓成交。' };
}
