import type { Candle } from '../../shared/market';
import type { Structure } from '../../shared/analysis';

export interface Viewport {
  width: number;
  height: number;
}

export interface CoordinateMapper {
  timeToX: (timestamp: number) => number | null;
  priceToY: (price: number) => number | null;
}

export interface StructureGeometry {
  id: string;
  kind: 'point' | 'line' | 'zone';
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

const isCoordinate = (value: number | null): value is number =>
  value !== null && Number.isFinite(value);

/** Map through the chart's public scales. Never substitute array indices for time. */
export function mapStructure(
  structure: Structure,
  mapper: CoordinateMapper,
  viewport: Viewport,
): StructureGeometry | null {
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  const startX = mapper.timeToX(structure.startTime);
  const startY = mapper.priceToY(structure.price);
  if (!isCoordinate(startX) || !isCoordinate(startY)) return null;

  const isPoint = ['HH', 'HL', 'LH', 'LL'].includes(structure.type);
  if (isPoint) {
    if (startX < 0 || startX > viewport.width || startY < 0 || startY > viewport.height) return null;
    return { id: structure.id, kind: 'point', x1: startX, x2: startX, y1: startY, y2: startY };
  }

  const endX = mapper.timeToX(structure.endTime);
  if (!isCoordinate(endX)) return null;
  const isZone = structure.type === 'FVG' || structure.type === 'OB';
  const endY = isZone && structure.priceEnd !== null ? mapper.priceToY(structure.priceEnd) : startY;
  if (!isCoordinate(endY) || (isZone && structure.priceEnd === null)) return null;

  const x1 = Math.min(startX, endX);
  const x2 = Math.max(startX, endX);
  const y1 = Math.min(startY, endY);
  const y2 = Math.max(startY, endY);
  if (x2 < 0 || x1 > viewport.width || y2 < 0 || y1 > viewport.height) return null;
  // Keep real offscreen coordinates: the canvas clips them. Clamping them here
  // would invent a new border at the viewport edge during panning.
  return { id: structure.id, kind: isZone ? 'zone' : 'line', x1, x2, y1, y2 };
}

export function distanceToGeometry(geometry: StructureGeometry, x: number, y: number): number {
  if (geometry.kind === 'point') return Math.hypot(x - geometry.x1, y - geometry.y1);
  const dx = Math.max(geometry.x1 - x, 0, x - geometry.x2);
  const dy = Math.max(geometry.y1 - y, 0, y - geometry.y2);
  return Math.hypot(dx, dy);
}

/** Binary search also supports irregular candle intervals and weekend gaps. */
export function nearestCandleIndex(candles: readonly Candle[], timestamp: number): number {
  if (candles.length === 0) return -1;
  let low = 0;
  let high = candles.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  if (low > 0 && timestamp - candles[low - 1].timestamp <= candles[low].timestamp - timestamp) return low - 1;
  return low;
}

export function structureFocusRange(
  candles: readonly Candle[],
  structure: Pick<Structure, 'startTime' | 'endTime'>,
  padding = 12,
): { from: number; to: number } | null {
  if (candles.length === 0) return null;
  const first = nearestCandleIndex(candles, structure.startTime);
  const last = nearestCandleIndex(candles, structure.endTime);
  const start = Math.min(first, last);
  const end = Math.max(first, last);
  const desired = Math.min(candles.length, Math.max(40, end - start + 1 + padding * 2));
  const from = Math.max(0, Math.min(start - padding, candles.length - desired));
  return { from, to: Math.min(candles.length - 1, Math.max(end + padding, from + desired - 1)) };
}
