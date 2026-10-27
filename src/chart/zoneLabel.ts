import type { Viewport } from './coordinates';
import { reserveLabel, type LabelBox } from './labelLayout';

export interface ZoneLabelBounds { left: number; top: number; right: number; bottom: number }

/** Small text stays at the real zone center and never becomes an outside badge. */
export function drawZoneLabel(ctx: CanvasRenderingContext2D, text: string, bounds: ZoneLabelBounds, viewport: Viewport, occupied?: LabelBox[], paint = true): LabelBox | null {
  const { left, top, right, bottom } = bounds;
  if (![left, top, right, bottom, viewport.width, viewport.height].every(Number.isFinite)
    || right <= left || bottom - top < 9 || viewport.width <= 0 || viewport.height <= 0) return null;
  const x = (left + right) / 2, y = (top + bottom) / 2;
  if (x < 0 || x > viewport.width || y < 0 || y > viewport.height) return null;
  ctx.save();
  try {
    ctx.font = '500 9px Arial, "Segoe UI", sans-serif';
    const width = ctx.measureText(text).width;
    if (right - left < width + 4) return null;
    const clipLeft = Math.max(0, left), clipTop = Math.max(0, top);
    const clipRight = Math.min(viewport.width, right), clipBottom = Math.min(viewport.height, bottom);
    const proposed = { left: x - width / 2 - 2, top: y - 4.5, width: width + 4, height: 9 };
    if (occupied && !reserveLabel(proposed, occupied)) return null;
    if (paint) {
      ctx.beginPath(); ctx.rect(clipLeft, clipTop, clipRight - clipLeft, clipBottom - clipTop); ctx.clip();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y);
    }
    const hitLeft = Math.max(clipLeft, x - width / 2 - 2), hitTop = Math.max(clipTop, y - 4.5);
    return { left: hitLeft, top: hitTop, width: Math.min(clipRight, x + width / 2 + 2) - hitLeft,
      height: Math.min(clipBottom, y + 4.5) - hitTop };
  } finally { ctx.restore(); }
}
