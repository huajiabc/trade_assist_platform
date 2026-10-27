import type { Candle } from './market';

export const MARKET_CONTEXT_VERSION = 'market-context-1.0';
export type MarketPhase = 'overnight' | 'premarket' | 'regular' | 'afterhours' | 'closed' | 'mixed' | 'unclassified';
export const PHASE_LABELS: Record<MarketPhase, string> = {
  overnight: '夜盘', premarket: '盘前', regular: '盘中', afterhours: '盘后', closed: '美股休市', mixed: '跨时段', unclassified: '未设置时段',
};
export const PHASE_COLORS: Partial<Record<MarketPhase, string>> = {
  overnight: 'rgba(131,71,180,0.14)', premarket: 'rgba(209,166,47,0.12)',
  afterhours: 'rgba(79,114,173,0.10)', closed: 'rgba(117,128,148,0.06)',
};
export const VOLUME_RULE = { lookback: 20, minimumHistory: 5, lowBelow: 0.7, elevatedAt: 1.5, highAt: 2 } as const;
export interface CandleMarketContext {
  timestamp: number; phase: MarketPhase; relativeVolume: number | null; baselineBars: number;
}
export interface SessionSegment { phase: MarketPhase; fromTime: number; toTime: number; candleCount: number }
// Explicit instrument mapping. Unknown symbols/CSV filenames never inherit US equity hours.
// https://www.binance.com/en-AE/support/announcement/detail/80549fadb3e447d1a859b8cedd0ccd69
export function hasEquitySessionReference(symbol: string): boolean {
  return /^(?:(?:NASDAQ|NYSE):)?(?:SNDK|MU)(?:USDT(?:\.P)?)?$/i.test(symbol.trim());
}
const nyClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const dayKey = (date: Date) => date.toISOString().slice(0, 10);
const shiftDay = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000);
const calendars = new Map<number, { holidays: Set<string>; early: Set<string> }>();
function calendar(year: number) {
  const cached = calendars.get(year); if (cached) return cached;
  const date = (month: number, day: number) => new Date(Date.UTC(year, month - 1, day));
  const nthMonday = (month: number, n: number) => { const first = date(month, 1); return shiftDay(first, (8 - first.getUTCDay()) % 7 + (n - 1) * 7); };
  const observed = (d: Date) => shiftDay(d, d.getUTCDay() === 6 ? -1 : d.getUTCDay() === 0 ? 1 : 0);
  const lastMay = date(5, 31), thanksgiving = shiftDay(date(11, 1), (11 - date(11, 1).getUTCDay()) % 7 + 21);
  // Gregorian Easter -> Good Friday. Reference calendar, not a venue-status feed.
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const easter = date(Math.floor((h + l - 7 * m + 114) / 31), (h + l - 7 * m + 114) % 31 + 1);
  const holidays = new Set([
    dayKey(date(1, 1)), ...(date(1, 1).getUTCDay() === 0 ? [dayKey(date(1, 2))] : []),
    dayKey(nthMonday(1, 3)), dayKey(nthMonday(2, 3)), dayKey(shiftDay(easter, -2)),
    dayKey(shiftDay(lastMay, -(lastMay.getUTCDay() + 6) % 7)),
    ...(year >= 2022 ? [dayKey(observed(date(6, 19)))] : []), dayKey(observed(date(7, 4))),
    dayKey(nthMonday(9, 1)), dayKey(thanksgiving), dayKey(observed(date(12, 25))),
    ...['2012-10-29', '2012-10-30', '2018-12-05', '2025-01-09'].filter(s => s.startsWith(String(year))),
  ]);
  const early = new Set([dayKey(shiftDay(thanksgiving, 1)), dayKey(date(7, 3)), dayKey(date(12, 24))]
    .filter(s => { const d = new Date(s + 'T00:00:00Z'); return !holidays.has(s) && d.getUTCDay() > 0 && d.getUTCDay() < 6; }));
  const result = { holidays, early }; calendars.set(year, result); return result;
}
function tradingDay(date: Date) { return date.getUTCDay() > 0 && date.getUTCDay() < 6 && !calendar(date.getUTCFullYear()).holidays.has(dayKey(date)); }
/** Clock context only: this never asserts that the perpetual or a stock venue is open. */
export function equityPhaseAt(timestamp: number): MarketPhase {
  const parts = Object.fromEntries(nyClock.formatToParts(new Date(timestamp * 1000)).map(p => [p.type, p.value]));
  const date = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`), minute = Number(parts.hour) * 60 + Number(parts.minute);
  if (minute >= 1200) return tradingDay(shiftDay(date, 1)) ? 'overnight' : 'closed';
  if (!tradingDay(date)) return 'closed';
  if (minute < 240) return 'overnight';
  if (minute < 570) return 'premarket';
  const close = calendar(date.getUTCFullYear()).early.has(dayKey(date)) ? 780 : 960;
  return minute < close ? 'regular' : 'afterhours';
}
export function candleIntervalSeconds(candles: readonly Candle[], timeframe: string): number | null {
  const match = /^(\d+)([mhd])$/.exec(timeframe);
  if (match) return Number(match[1]) * ({ m: 60, h: 3600, d: 86400 }[match[2]] ?? 0) || null;
  const differences = candles.slice(1).map((b, i) => b.timestamp - candles[i].timestamp).filter(n => n > 0).sort((a, b) => a - b);
  return differences.length ? differences[Math.floor(differences.length / 2)] : null;
}
/** Causal RVOL: only preceding bars, never the current bar or future history. A gap resets its baseline. */
export function candleMarketContexts(candles: readonly Candle[], symbol: string, timeframe: string): CandleMarketContext[] {
  const seconds = candleIntervalSeconds(candles, timeframe), equity = hasEquitySessionReference(symbol);
  let continuousStart = 0;
  return candles.map((bar, index) => {
    if (index && seconds && bar.timestamp !== candles[index - 1].timestamp + seconds) continuousStart = index;
    const previous = candles.slice(Math.max(continuousStart, index - VOLUME_RULE.lookback), index), baselineBars = previous.length;
    // Divide before summing to keep even extreme, valid volume values finite.
    const mean = baselineBars ? previous.reduce((sum, b) => sum + b.volume / baselineBars, 0) : 0;
    const ratio = baselineBars >= VOLUME_RULE.minimumHistory && mean > 0 ? bar.volume / mean : null;
    let phase: MarketPhase = equity ? equityPhaseAt(bar.timestamp) : 'unclassified';
    if (equity && seconds && (seconds >= 86400 || equityPhaseAt(bar.timestamp + seconds - 1) !== phase)) phase = 'mixed';
    return { timestamp: bar.timestamp, phase, relativeVolume: ratio !== null && Number.isFinite(ratio) ? Number(ratio.toPrecision(6)) : null, baselineBars };
  });
}
export function volumeStrength(ratio: number | null): string {
  return ratio === null ? '基准不足' : ratio === 0 ? '无成交' : ratio < VOLUME_RULE.lowBelow ? '缩量' : ratio >= VOLUME_RULE.highAt ? '显著放量' : ratio >= VOLUME_RULE.elevatedAt ? '放量' : '常态';
}
export function sessionSegments(rows: readonly CandleMarketContext[], seconds: number | null): SessionSegment[] {
  const segments: SessionSegment[] = [];
  for (const row of rows) {
    const last = segments.at(-1);
    if (last && last.phase === row.phase && seconds && last.toTime + seconds === row.timestamp) { last.toTime = row.timestamp; last.candleCount++; }
    else segments.push({ phase: row.phase, fromTime: row.timestamp, toTime: row.timestamp, candleCount: 1 });
  }
  return segments;
}
export function buildMarketContext(candles: readonly Candle[], symbol: string, timeframe: string, asOf?: number) {
  const rows = candleMarketContexts(candles, symbol, timeframe), seconds = candleIntervalSeconds(candles, timeframe), equity = hasEquitySessionReference(symbol);
  const snapshotTime = asOf ?? (candles.length && seconds ? candles.at(-1)!.timestamp + seconds : candles.at(-1)?.timestamp ?? null);
  const phase: MarketPhase = equity && snapshotTime !== null ? equityPhaseAt(snapshotTime) : 'unclassified';
  return {
    version: MARKET_CONTEXT_VERSION, source: 'deterministic-ohlcv-and-calendar' as const,
    session: { profile: equity ? 'us-equity-reference' : 'unclassified', timeZone: equity ? 'America/New_York' : null,
      calendar: equity ? 'US standard holidays and early closes; rule-based reference' : null, asOf: snapshotTime, phase, label: PHASE_LABELS[phase],
      hoursET: equity ? 'overnight 20:00–04:00 (next trading day); premarket 04:00–09:30; regular 09:30–16:00 (early close 13:00); afterhours until 20:00' : null,
      note: equity ? '美股/BOATS时钟参考，不是合约开闭市或原生股票场所状态。SNDKUSDT/MUUSDT可24/7交易；标准休市和提前收盘已处理，临时停牌、特殊公告及场所差异未接入。' : '未指定美股参考，不推断该标的存在盘前、夜盘或实际休市。' },
    volume: { ...VOLUME_RULE, method: 'bar volume / mean of preceding 20 available contiguous bars; minimum 5; excludes current bar; gaps reset baseline',
      note: '同标的同周期滚动量能强弱，不是跨日同分钟RVOL，不跨周期比较；时段切换可自然放量。只有已收盘数据可作为确认，量能不是独立交易信号或订单流证据。',
      latest: rows.length ? { relativeVolume: rows.at(-1)!.relativeVolume, strength: volumeStrength(rows.at(-1)!.relativeVolume), baselineBars: rows.at(-1)!.baselineBars } : null },
    columns: ['timestamp', 'phase', 'relativeVolume', 'baselineBars'] as const,
    rows: rows.map(row => [row.timestamp, row.phase, row.relativeVolume, row.baselineBars] as const),
  };
}
export const MARKET_CONTEXT_INSTRUCTIONS = 'marketContext是根据本次OHLCV确定性计算的时段与相对量能参考，逐行按columns解码。美股参考采用America/New_York自动处理夏令时；它不是Binance合约开闭市。结合当前阶段及结构形成/确认时所在阶段解释流动性和量能背景，不得仅凭夜盘/盘前/放量就认定突破或反转。relativeVolume是相对前20根均量（最少5根，不含本根，遇缺口重置）；null表示不足或零基准。时段切换自然放量不能冒充独立结构证据，也不能把同一次位移、成交量和跨周期结构重复计票；未收盘量能只可预览。价格、坐标与确认仍由原始OHLCV及Schema校验。';
