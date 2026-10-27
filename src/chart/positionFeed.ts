import { closedMarketCandles, type MarketSnapshot } from '../../shared/liveMarket';
import { contentId, exchangeFrame, normalizeFrame, RESEARCH_FRAMES, type FrameSnapshot } from '../../shared/researchData';

interface PositionFeedFocus { frame: FrameSnapshot; position?: { historical: boolean } }
/** Only the current position follows public quotes. Historical reviews and
 * structure/plan snapshots must retain their original coordinates and bars. */
export function positionChartFeed(view: PositionFeedFocus, market: MarketSnapshot | null) {
  const live = view.position && !view.position.historical && market?.symbol === view.frame.symbol ? market : null;
  return { live, candles: live?.candles ?? view.frame.candles,
    timeframe: live?.interval ?? view.frame.timeframe,
    factsKey: live ? live.symbol + ':' + live.interval + ':' + contentId(closedMarketCandles(live)) : view.frame.id };
}

export function positionFactsFrame(view: PositionFeedFocus, market: MarketSnapshot | null): FrameSnapshot | null {
  const live = positionChartFeed(view, market).live;
  if (!live) return view.frame;
  // Existing research facts cover these three periods. Higher chart periods
  // still display live prices and position levels, without relabeling 5m facts.
  if (!RESEARCH_FRAMES.includes(live.interval as typeof RESEARCH_FRAMES[number])) return null;
  return normalizeFrame(exchangeFrame(live), Math.floor(live.serverTime / 1000));
}
