import type { LabelBox } from './labelLayout';
import { CHART_THEME } from './chartTheme';

/** Pixel-center alignment follows the approach in TradingView's open-source
 * primitive examples (dimensions/positions.ts). Work in media coordinates so
 * LWC retains ownership of DPR, panes, zoom and price projection. Only the
 * painted stroke moves by at most half a device pixel; evidence never moves.
 * References and licenses: docs/chart-visual-references.md. */
export function alignedStroke(position: number, ratio: number, width = 1): number {
  const scale = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const pixels = Math.max(1, Math.round(width * scale));
  return (Math.round(position * scale - pixels / 2) + pixels / 2) / scale;
}

export function horizontalStroke(ctx: CanvasRenderingContext2D, from: number, to: number, priceY: number, gap?: LabelBox): void {
  const ratio = ctx.getTransform?.().d ?? 1;
  const previousWidth = ctx.lineWidth;
  const y = alignedStroke(priceY, ratio, previousWidth);
  ctx.lineWidth = Math.max(1, Math.round(previousWidth * ratio)) / ratio;
  ctx.beginPath();
  if (gap && gap.top <= y && gap.top + gap.height >= y && gap.left < to && gap.left + gap.width > from) {
    const left = Math.max(from, gap.left - 3), right = Math.min(to, gap.left + gap.width + 3);
    if (left > from) { ctx.moveTo(from, y); ctx.lineTo(left, y); }
    if (right < to) { ctx.moveTo(right, y); ctx.lineTo(to, y); }
  } else { ctx.moveTo(from, y); ctx.lineTo(to, y); }
  ctx.stroke();
  ctx.lineWidth = previousWidth;
}

/** Compact, borderless labels; selected evidence gets a stronger background.
 * Rounded geometry is decorative and never replaces an OHLC/time anchor. */
export function labelSurface(ctx: CanvasRenderingContext2D, box: LabelBox, selected = false): void {
  ctx.fillStyle = selected ? CHART_THEME.selectedBackground : CHART_THEME.labelBackground;
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath(); ctx.roundRect(box.left, box.top, box.width, box.height, 3); ctx.fill();
  } else ctx.fillRect(box.left, box.top, box.width, box.height);
}
