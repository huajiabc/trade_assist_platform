import type { IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, SeriesAttachedParameter, UTCTimestamp } from 'lightweight-charts';
import { candleMarketContexts, candleIntervalSeconds, PHASE_COLORS, sessionSegments, type SessionSegment } from '../../shared/marketContext';
import type { Candle } from '../../shared/market';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];
/** A background-only primitive, sharing the real chart's native time mapping. */
export class MarketSessionOverlay implements ISeriesPrimitive {
  private attachment: SeriesAttachedParameter | null = null;
  private segments: SessionSegment[] = [];
  private enabled = true;
  private readonly views: IPrimitivePaneView[] = [
    { zOrder: () => 'bottom', renderer: () => ({ draw: target => this.draw(target) }) },
  ];
  attached(parameters: SeriesAttachedParameter) { this.attachment = parameters; }
  detached() { this.attachment = null; this.segments = []; }
  paneViews() { return this.views; }
  setData(candles: readonly Candle[], symbol: string, timeframe: string, enabled = true) {
    const seconds = candleIntervalSeconds(candles, timeframe);
    // Wider candles can straddle several phases. Avoid painting a whole hour as one session.
    this.segments = seconds && seconds <= 900 ? sessionSegments(candleMarketContexts(candles, symbol, timeframe), seconds) : [];
    this.enabled = enabled; this.attachment?.requestUpdate();
  }
  private draw(target: Target) {
    if (!this.enabled || !this.attachment) return;
    const scale = this.attachment.chart.timeScale(), halfBar = scale.options().barSpacing / 2;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      try {
        ctx.beginPath(); ctx.rect(0, 0, mediaSize.width, mediaSize.height); ctx.clip();
        for (const segment of this.segments) {
          const color = PHASE_COLORS[segment.phase]; if (!color) continue;
          const from = scale.timeToCoordinate(segment.fromTime as UTCTimestamp), to = scale.timeToCoordinate(segment.toTime as UTCTimestamp);
          if (from === null || to === null || to + halfBar <= 0 || from - halfBar >= mediaSize.width) continue;
          const left = Math.max(0, from - halfBar), right = Math.min(mediaSize.width, to + halfBar);
          ctx.fillStyle = color; ctx.fillRect(left, 0, right - left, mediaSize.height);
        }
      } finally { ctx.restore(); }
    });
  }
}
