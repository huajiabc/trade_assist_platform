import type { Candle } from '../../shared/market';
import type { PAZone, PALeg, PAPattern, PABreakout, PriceAction } from '../../shared/priceAction';
import type { CoordinateMapper, Viewport } from './coordinates';
import { structureFocusRange } from './coordinates';

export interface PALayerVisibility { zones: boolean; legs: boolean; patterns: boolean; breakouts: boolean }
export const ALL_PA_LAYERS: PALayerVisibility = { zones: true, legs: true, patterns: true, breakouts: true };
export type PAItem = PAZone | PALeg | PAPattern | PABreakout;
export interface PAPoint { x: number; y: number; time: number; price: number }
export interface PAZoneGeometry { kind: 'zone'; id: string; x1: number; x2: number; top: number; bottom: number; touches: PAPoint[] }
export interface PALegGeometry { kind: 'leg'; id: string; start: PAPoint; end: PAPoint }
export interface PACandleGeometry { time: number; x: number; highY: number; lowY: number; openY: number; closeY: number }
export interface PAPatternGeometry { kind: 'pattern'; id: string; x1: number; x2: number; top: number; bottom: number; candles: PACandleGeometry[] }
export interface PABreakoutGeometry { kind: 'breakout'; id: string; points: (PAPoint & { stage: 1 | 2 | 3 })[] }
export type PAGeometry = PAZoneGeometry | PALegGeometry | PAPatternGeometry | PABreakoutGeometry;

const coordinate = (value: number | null): value is number => value !== null && Number.isFinite(value);
const validViewport = (viewport: Viewport) => viewport.width > 0 && viewport.height > 0;
const intersects = (xs: number[], ys: number[], viewport: Viewport) => validViewport(viewport)
  && Math.max(...xs) >= 0 && Math.min(...xs) <= viewport.width && Math.max(...ys) >= 0 && Math.min(...ys) <= viewport.height;

function point(time: number, price: number, mapper: CoordinateMapper): PAPoint | null {
  const x = mapper.timeToX(time);
  const y = mapper.priceToY(price);
  return coordinate(x) && coordinate(y) ? { x, y, time, price } : null;
}

/** Public chart scales own all transforms, including log prices and irregular times. */
export function mapPAZone(zone: PAZone, candles: readonly Candle[], mapper: CoordinateMapper, viewport: Viewport): PAZoneGeometry | null {
  if (!validViewport(viewport) || zone.startTime > zone.endTime || zone.lowerPrice >= zone.upperPrice) return null;
  const byTime = new Map(candles.map((candle) => [candle.timestamp, candle]));
  if (!byTime.has(zone.startTime) || !byTime.has(zone.endTime)) return null;
  const x1 = mapper.timeToX(zone.startTime), x2 = mapper.timeToX(zone.endTime);
  const y1 = mapper.priceToY(zone.lowerPrice), y2 = mapper.priceToY(zone.upperPrice);
  if (![x1, x2, y1, y2].every(coordinate)) return null;
  if (!intersects([x1!, x2!], [y1!, y2!], viewport)) return null;
  const touches: PAPoint[] = [];
  for (const time of zone.touchTimes) {
    const candle = byTime.get(time);
    if (!candle || time < zone.startTime || time > zone.endTime || candle.high < zone.lowerPrice || candle.low > zone.upperPrice) return null;
    // Touch circles mark the wick/band intersection, never a shifted candle.
    const price = zone.kind === 'resistance' ? Math.min(candle.high, zone.upperPrice)
      : zone.kind === 'support' ? Math.max(candle.low, zone.lowerPrice)
        : Math.abs(candle.high - zone.upperPrice) <= Math.abs(candle.low - zone.lowerPrice)
          ? Math.min(candle.high, zone.upperPrice) : Math.max(candle.low, zone.lowerPrice);
    const mapped = point(time, price, mapper);
    if (!mapped) return null;
    touches.push(mapped);
  }
  return { kind: 'zone', id: zone.id, x1: x1!, x2: x2!, top: Math.min(y1!, y2!), bottom: Math.max(y1!, y2!), touches };
}

export function mapPALeg(leg: PALeg, candles: readonly Candle[], mapper: CoordinateMapper, viewport: Viewport): PALegGeometry | null {
  if (!validViewport(viewport) || leg.startTime >= leg.endTime || !candles.some((candle) => candle.timestamp === leg.startTime)
    || !candles.some((candle) => candle.timestamp === leg.endTime)) return null;
  const start = point(leg.startTime, leg.startPrice, mapper), end = point(leg.endTime, leg.endPrice, mapper);
  if (!start || !end || !intersects([start.x, end.x], [start.y, end.y], viewport)) return null;
  return { kind: 'leg', id: leg.id, start, end };
}

export function mapPAPattern(pattern: PAPattern, candles: readonly Candle[], mapper: CoordinateMapper, viewport: Viewport): PAPatternGeometry | null {
  if (!validViewport(viewport) || pattern.startTime > pattern.endTime) return null;
  const first = candles.findIndex((candle) => candle.timestamp === pattern.startTime);
  const last = candles.findIndex((candle) => candle.timestamp === pattern.endTime);
  if (first < 0 || last < first) return null;
  const mapped: PACandleGeometry[] = [];
  for (const candle of candles.slice(first, last + 1)) {
    const x = mapper.timeToX(candle.timestamp), highY = mapper.priceToY(candle.high), lowY = mapper.priceToY(candle.low);
    const openY = mapper.priceToY(candle.open), closeY = mapper.priceToY(candle.close);
    if (![x, highY, lowY, openY, closeY].every(coordinate)) return null;
    mapped.push({ time: candle.timestamp, x: x!, highY: highY!, lowY: lowY!, openY: openY!, closeY: closeY! });
  }
  const xs = mapped.map((candle) => candle.x), ys = mapped.flatMap((candle) => [candle.highY, candle.lowY]);
  if (!intersects(xs, ys, viewport)) return null;
  return { kind: 'pattern', id: pattern.id, x1: Math.min(...xs), x2: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys), candles: mapped };
}

export function mapPABreakout(breakout: PABreakout, zone: PAZone | undefined, candles: readonly Candle[], mapper: CoordinateMapper, viewport: Viewport): PABreakoutGeometry | null {
  if (!zone || !validViewport(viewport) || zone.id !== breakout.zoneId || zone.endTime >= breakout.breakoutTime
    || (breakout.retestTime !== null && breakout.retestTime <= breakout.breakoutTime)
    || (breakout.confirmationTime !== null && (breakout.retestTime === null || breakout.confirmationTime < breakout.retestTime))) return null;
  const byTime = new Map(candles.map((candle) => [candle.timestamp, candle]));
  const phases = [{ stage: 1 as const, time: breakout.breakoutTime },
    ...(breakout.retestTime === null ? [] : [{ stage: 2 as const, time: breakout.retestTime }]),
    ...(breakout.confirmationTime === null ? [] : [{ stage: 3 as const, time: breakout.confirmationTime }])];
  const points: PABreakoutGeometry['points'] = [];
  for (const phase of phases) {
    const candle = byTime.get(phase.time);
    if (!candle) return null;
    const price = phase.stage === 2 ? breakout.direction === 'bullish' ? candle.low : candle.high : candle.close;
    const mapped = point(phase.time, price, mapper);
    if (!mapped) return null;
    points.push({ ...mapped, stage: phase.stage });
  }
  return intersects(points.map(({ x }) => x), points.map(({ y }) => y), viewport) ? { kind: 'breakout', id: breakout.id, points } : null;
}

const segmentDistance = (x: number, y: number, x1: number, y1: number, x2: number, y2: number) => {
  const length = (x2 - x1) ** 2 + (y2 - y1) ** 2;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / length));
  return Math.hypot(x - x1 - t * (x2 - x1), y - y1 - t * (y2 - y1));
};

/** Band interiors do not capture candle clicks. Only their edges/touch anchors do. */
export function distanceToPAGeometry(geometry: PAGeometry, x: number, y: number): number {
  if (geometry.kind === 'leg') return segmentDistance(x, y, geometry.start.x, geometry.start.y, geometry.end.x, geometry.end.y);
  if (geometry.kind === 'breakout') return Math.min(...geometry.points.map((p) => Math.hypot(x - p.x, y - p.y)),
    ...geometry.points.slice(1).map((p, i) => segmentDistance(x, y, geometry.points[i].x, geometry.points[i].y, p.x, p.y)));
  const distances = [segmentDistance(x, y, geometry.x1, geometry.top, geometry.x2, geometry.top),
    segmentDistance(x, y, geometry.x1, geometry.bottom, geometry.x2, geometry.bottom),
    segmentDistance(x, y, geometry.x1, geometry.top, geometry.x1, geometry.bottom),
    segmentDistance(x, y, geometry.x2, geometry.top, geometry.x2, geometry.bottom)];
  if (geometry.kind === 'zone') distances.push(...geometry.touches.map((p) => Math.hypot(x - p.x, y - p.y)));
  else distances.push(...geometry.candles.map((p) => segmentDistance(x, y, p.x, p.highY, p.x, p.lowY)));
  return Math.min(...distances);
}

export function findPAItem(priceAction: PriceAction | undefined, id: string | null): PAItem | undefined {
  return priceAction && id ? [...priceAction.zones, ...priceAction.legs, ...priceAction.patterns, ...priceAction.breakouts].find((item) => item.id === id) : undefined;
}

export function paItemBounds(item: PAItem, priceAction: PriceAction, candles: readonly Candle[]): { startTime: number; endTime: number; prices: number[]; anchorTime: number; anchorPrice: number } | null {
  if ('breakoutTime' in item) {
    const zone = priceAction.zones.find((entry) => entry.id === item.zoneId);
    const lastTime = item.confirmationTime ?? item.retestTime ?? item.breakoutTime;
    const anchor = candles.find((candle) => candle.timestamp === lastTime);
    if (!zone || !anchor) return null;
    return { startTime: Math.min(zone.startTime, item.breakoutTime), endTime: lastTime,
      prices: [zone.lowerPrice, zone.upperPrice, anchor.high, anchor.low], anchorTime: lastTime, anchorPrice: anchor.close };
  }
  if ('lowerPrice' in item) return { startTime: item.startTime, endTime: item.endTime, prices: [item.lowerPrice, item.upperPrice], anchorTime: item.endTime, anchorPrice: item.upperPrice };
  if ('startPrice' in item) return { startTime: item.startTime, endTime: item.endTime, prices: [item.startPrice, item.endPrice], anchorTime: item.endTime, anchorPrice: item.endPrice };
  const bars = candles.filter((candle) => candle.timestamp >= item.startTime && candle.timestamp <= item.endTime);
  const anchor = bars.at(-1);
  if (!anchor || bars[0]?.timestamp !== item.startTime || anchor.timestamp !== item.endTime) return null;
  return { startTime: item.startTime, endTime: item.endTime, prices: bars.flatMap((candle) => [candle.high, candle.low]), anchorTime: item.endTime, anchorPrice: anchor.close };
}

export function paFocusRange(candles: readonly Candle[], item: PAItem, priceAction: PriceAction) {
  const bounds = paItemBounds(item, priceAction, candles);
  if (!bounds || !candles.some((candle) => candle.timestamp === bounds.startTime) || !candles.some((candle) => candle.timestamp === bounds.endTime)) return null;
  return structureFocusRange(candles, bounds, 9);
}
