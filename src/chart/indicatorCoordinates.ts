import type { RuleIndicatorZone } from '../../shared/indicators';
import type { Candle } from '../../shared/market';
import type { CoordinateMapper, Viewport } from './coordinates';

export interface IndicatorGeometry {
  id: string;
  originX: number;
  formedX: number;
  endX: number;
  top: number;
  bottom: number;
  midpointY: number;
}

const finite = (value: number | null): value is number => value !== null && Number.isFinite(value);

export const INDICATOR_EXTENSION_BARS = 5;

/** Visual extent only. Keep lifecycle timestamps intact for research and AI. */
export function indicatorDisplayEndTime(
  zone: Pick<RuleIndicatorZone, 'formedAt' | 'endTime'>,
  candles: readonly Candle[],
  extensionBars = INDICATOR_EXTENSION_BARS,
): number | null {
  if (!Number.isInteger(extensionBars) || extensionBars < 0) return null;
  const formed = candles.findIndex(candle => candle.timestamp === zone.formedAt);
  const ended = candles.findIndex(candle => candle.timestamp === zone.endTime);
  if (formed < 0 || ended < formed) return null;
  return candles[Math.min(ended, formed + extensionBars)].timestamp;
}

/** Use exact public time/price mappings, including on logarithmic price scales.
 * The origin-to-formation portion is evidence history, never an available signal. */
export function mapIndicatorZone(zone: RuleIndicatorZone, mapper: CoordinateMapper, viewport: Viewport): IndicatorGeometry | null {
  if (viewport.width <= 0 || viewport.height <= 0
    || ![zone.originTime, zone.formedAt, zone.endTime, zone.lowerPrice, zone.upperPrice, zone.midpoint].every(Number.isFinite)
    || zone.originTime > zone.formedAt || zone.formedAt > zone.endTime
    || zone.lowerPrice <= 0 || zone.lowerPrice >= zone.upperPrice
    || zone.midpoint < zone.lowerPrice || zone.midpoint > zone.upperPrice) return null;
  const originX = mapper.timeToX(zone.originTime), formedX = mapper.timeToX(zone.formedAt), endX = mapper.timeToX(zone.endTime);
  const lowerY = mapper.priceToY(zone.lowerPrice), upperY = mapper.priceToY(zone.upperPrice), midpointY = mapper.priceToY(zone.midpoint);
  if (![originX, formedX, endX, lowerY, upperY, midpointY].every(finite)) return null;
  const geometry = { id: zone.id, originX, formedX, endX, top: Math.min(lowerY!, upperY!), bottom: Math.max(lowerY!, upperY!), midpointY } as IndicatorGeometry;
  if (geometry.endX < 0 || geometry.originX > viewport.width || geometry.bottom < 0 || geometry.top > viewport.height) return null;
  // Do not clamp: that would create a fictitious boundary at the viewport edge.
  return geometry;
}

const segmentDistance = (x: number, y: number, x1: number, y1: number, x2: number, y2: number): number => {
  const length = (x2 - x1) ** 2 + (y2 - y1) ** 2;
  const progress = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / length));
  return Math.hypot(x - x1 - progress * (x2 - x1), y - y1 - progress * (y2 - y1));
};

/** Only boundaries are clickable. Filled interiors keep normal candle interactions. */
export function distanceToIndicatorGeometry(geometry: IndicatorGeometry, x: number, y: number): number {
  const { originX, formedX, endX, top, bottom } = geometry;
  return Math.min(
    segmentDistance(x, y, originX, top, endX, top),
    segmentDistance(x, y, originX, bottom, endX, bottom),
    segmentDistance(x, y, originX, top, originX, bottom),
    segmentDistance(x, y, formedX, top, formedX, bottom),
    segmentDistance(x, y, endX, top, endX, bottom),
  );
}

/** Focus the evidence and the first available candle, not the zone's long extension. */
export function indicatorFocusRange(candles: readonly Candle[], zone: Pick<RuleIndicatorZone, 'originTime' | 'formedAt'>): { from: number; to: number } | null {
  const origin = candles.findIndex(candle => candle.timestamp === zone.originTime);
  const formed = candles.findIndex(candle => candle.timestamp === zone.formedAt);
  if (origin < 0 || formed < origin) return null;
  const span = formed - origin + 1;
  const desired = Math.min(candles.length, Math.max(40, Math.min(60, span + 24)));
  const preferredFrom = span <= desired ? origin - Math.floor((desired - span) / 2) : formed - desired + 1;
  const from = Math.max(0, Math.min(preferredFrom, candles.length - desired));
  return { from, to: Math.min(candles.length - 1, from + desired - 1) };
}
