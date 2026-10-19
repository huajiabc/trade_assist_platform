import type { LiquiditySweep, TradeSetup } from '../../shared/analysis';
import type { Candle } from '../../shared/market';
import { calculateRiskReward } from '../../shared/tradeGeometry';
import type { CoordinateMapper, Viewport } from './coordinates';

export const SETUP_PROJECTION_BARS = 14;

export interface TradeCoordinateMapper extends CoordinateMapper {
  timeToLogical: (timestamp: number) => number | null;
  logicalToX: (logical: number) => number | null;
}

export interface TradeGeometry {
  id: string;
  anchorX: number;
  endX: number;
  entryY: number;
  stopY: number;
  targets: { price: number; label: string; y: number; rewardRisk: number }[];
}

export interface SweepGeometry {
  id: string;
  levelX: number;
  sweepX: number;
  levelY: number;
  extremeY: number;
}

const coordinate = (value: number | null): value is number => value !== null && Number.isFinite(value);

/** Price distances, independent of logarithmic or linear screen coordinates. */
export function setupRewardRisk(setup: Pick<TradeSetup, 'direction' | 'entry' | 'stopLoss'>, targetPrice: number): number | null {
  try {
    return calculateRiskReward({ ...setup, targets: [{ price: targetPrice, label: 'target' }] }).ratio;
  } catch { return null; }
}

/**
 * The entry is anchored to a supplied candle. Box width projects logical bars,
 * never fabricated future timestamps. Only the display endpoint may be clipped.
 */
export function mapTradeSetup(setup: TradeSetup, mapper: TradeCoordinateMapper, viewport: Viewport): TradeGeometry | null {
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  const anchorX = mapper.timeToX(setup.anchorTime);
  const logical = mapper.timeToLogical(setup.anchorTime);
  const entryY = mapper.priceToY(setup.entry);
  const stopY = mapper.priceToY(setup.stopLoss);
  if (!coordinate(anchorX) || !coordinate(logical) || !coordinate(entryY) || !coordinate(stopY)) return null;
  const projectedX = mapper.logicalToX(logical + SETUP_PROJECTION_BARS);
  if (!coordinate(projectedX) || projectedX <= anchorX || anchorX >= viewport.width) return null;
  const endX = Math.min(projectedX, viewport.width - 4);
  if (endX <= 0 || endX <= anchorX) return null;
  const targets = setup.targets.slice(0, 3).map((target) => ({
    ...target, y: mapper.priceToY(target.price), rewardRisk: setupRewardRisk(setup, target.price),
  }));
  if (!targets.length || targets.some((target) => !coordinate(target.y) || target.rewardRisk === null)) return null;
  const mappedTargets = targets as TradeGeometry['targets'];
  const prices = [entryY, stopY, ...mappedTargets.map((target) => target.y)];
  if (Math.max(...prices) < 0 || Math.min(...prices) > viewport.height) return null;
  return { id: setup.id, anchorX, endX, entryY, stopY, targets: mappedTargets };
}

export function mapLiquiditySweep(sweep: LiquiditySweep, mapper: CoordinateMapper, viewport: Viewport): SweepGeometry | null {
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  const levelX = mapper.timeToX(sweep.levelTime);
  const sweepX = mapper.timeToX(sweep.sweepTime);
  const levelY = mapper.priceToY(sweep.levelPrice);
  const extremeY = mapper.priceToY(sweep.extremePrice);
  if (![levelX, sweepX, levelY, extremeY].every(coordinate)) return null;
  const geometry = { id: sweep.id, levelX, sweepX, levelY, extremeY } as SweepGeometry;
  if (Math.max(geometry.levelX, geometry.sweepX) < 0 || Math.min(geometry.levelX, geometry.sweepX) > viewport.width
    || Math.max(geometry.levelY, geometry.extremeY) < 0 || Math.min(geometry.levelY, geometry.extremeY) > viewport.height) return null;
  return geometry;
}

const segmentDistance = (x: number, y: number, x1: number, y1: number, x2: number, y2: number) => {
  const length = (x2 - x1) ** 2 + (y2 - y1) ** 2;
  const progress = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / length));
  return Math.hypot(x - x1 - progress * (x2 - x1), y - y1 - progress * (y2 - y1));
};

/** Filled boxes do not capture clicks that belong to candles or PA structures. */
export function distanceToTradeGeometry(geometry: TradeGeometry, x: number, y: number): number {
  return Math.min(...[geometry.entryY, geometry.stopY, ...geometry.targets.map((target) => target.y)]
    .map((level) => segmentDistance(x, y, geometry.anchorX, level, geometry.endX, level)));
}

export function distanceToSweepGeometry(geometry: SweepGeometry, x: number, y: number): number {
  return Math.min(segmentDistance(x, y, geometry.levelX, geometry.levelY, geometry.sweepX, geometry.levelY),
    segmentDistance(x, y, geometry.sweepX, geometry.levelY, geometry.sweepX, geometry.extremeY));
}

export function tradeSetupFocusRange(candles: readonly Candle[], setup: Pick<TradeSetup, 'anchorTime'>): { from: number; to: number } | null {
  const anchor = candles.findIndex((candle) => candle.timestamp === setup.anchorTime);
  if (anchor < 0) return null;
  // Extra empty space is a display projection, not a forecast candle or time.
  return { from: Math.max(-1, anchor - 43), to: anchor + SETUP_PROJECTION_BARS + 16 };
}
