import type { IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, SeriesAttachedParameter, UTCTimestamp } from 'lightweight-charts';
import type { Candle } from '../../shared/market';
import { selectAnalysisCandles, type AnalysisRange } from '../analysisRange';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];
const BLUE = '#6ba9ff';
const shortDate = (timestamp: number) => new Date(timestamp * 1000).toISOString().slice(5, 16).replace('T', ' ');

/** Selection lives in the chart renderer, so pan, zoom and resize stay aligned. */
export class AnalysisRangeOverlay implements ISeriesPrimitive {
  private attachment: SeriesAttachedParameter | null = null;
  private range: AnalysisRange | null = null;
  private candles: readonly Candle[] = [];
  private preview = false;
  private readonly views: IPrimitivePaneView[] = [
    { zOrder: () => 'bottom', renderer: () => ({ draw: (target) => this.draw(target, true) }) },
    { zOrder: () => 'top', renderer: () => ({ draw: (target) => this.draw(target, false) }) },
  ];
  attached(parameters: SeriesAttachedParameter): void { this.attachment = parameters; }
  detached(): void { this.attachment = null; }
  paneViews(): readonly IPrimitivePaneView[] { return this.views; }
  setData(candles: readonly Candle[], range: AnalysisRange | null, preview = false): void {
    this.candles = candles; this.range = range; this.preview = preview; this.attachment?.requestUpdate();
  }

  private draw(target: Target, background: boolean): void {
    const attachment = this.attachment, range = this.range;
    if (!attachment || !range) return;
    const scale = attachment.chart.timeScale();
    const from = scale.timeToCoordinate(range.from as UTCTimestamp), to = scale.timeToCoordinate(range.to as UTCTimestamp);
    if (from === null || to === null || !Number.isFinite(from) || !Number.isFinite(to)) return;
    // Lightweight Charts only maps integer logical indices. Expand the actual
    // candle centers in pixel space so the first and last candle are included.
    const halfBar = scale.options().barSpacing / 2;
    const x1 = from - halfBar, x2 = to + halfBar;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      if (x2 < 0 || x1 > mediaSize.width) return;
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, mediaSize.width, mediaSize.height); ctx.clip();
      if (background) {
        ctx.fillStyle = this.preview ? 'rgba(80,143,255,.13)' : 'rgba(80,143,255,.065)';
        ctx.fillRect(x1, 0, x2 - x1, mediaSize.height);
      } else {
        ctx.strokeStyle = BLUE; ctx.lineWidth = 1; ctx.setLineDash(this.preview ? [4, 4] : [2, 3]);
        ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, mediaSize.height); ctx.moveTo(x2, 0); ctx.lineTo(x2, mediaSize.height); ctx.stroke(); ctx.setLineDash([]);
        const count = selectAnalysisCandles(this.candles, range).length;
        const text = `${this.preview ? '选择中' : '分析范围'} · ${count} 根`;
        ctx.font = '11px Arial, "Segoe UI", sans-serif';
        const width = Math.min(mediaSize.width - 12, ctx.measureText(text).width + 18);
        const center = (Math.max(0, x1) + Math.min(mediaSize.width, x2)) / 2;
        const left = Math.max(6, Math.min(mediaSize.width - width - 6, center - width / 2));
        const top = Math.max(4, mediaSize.height - 27);
        ctx.fillStyle = '#1c2c46'; ctx.fillRect(left, top, width, 21);
        ctx.strokeStyle = '#3a5f94'; ctx.strokeRect(left + .5, top + .5, width - 1, 20);
        ctx.fillStyle = '#b7d5ff'; ctx.textAlign = 'center'; ctx.fillText(text, left + width / 2, top + 14);
        if (Math.min(mediaSize.width, x2) - Math.max(0, x1) > 225) {
          const date = `${shortDate(range.from)} → ${shortDate(range.to)} UTC`;
          const dateWidth = ctx.measureText(date).width + 12;
          ctx.fillStyle = 'rgba(19,23,34,.92)'; ctx.fillRect(left + width / 2 - dateWidth / 2, top - 19, dateWidth, 16);
          ctx.fillStyle = '#93add0'; ctx.fillText(date, left + width / 2, top - 7);
        }
      }
      ctx.restore();
    });
  }
}
