import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  PriceScaleMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle } from '../../shared/market';
import type { LiquiditySweep, Structure, StructureType, TradeSetup } from '../../shared/analysis';
import type { PriceAction } from '../../shared/priceAction';
import { formatPrice } from '../../shared/format';
import { nearestCandleIndex, structureFocusRange } from '../chart/coordinates';
import { StructureOverlay } from '../chart/StructureOverlay';
import { createChartPriceScale } from '../chart/priceScale';
import { candleUpdatePlan, latestCandleWindow, preserveLogicalWindow } from '../chart/liveUpdates';
import { TradeOverlay } from '../chart/TradeOverlay';
import { tradeSetupFocusRange } from '../chart/tradeCoordinates';
import { PriceActionOverlay } from '../chart/PriceActionOverlay';
import { ALL_PA_LAYERS, findPAItem, paFocusRange, paItemBounds, type PALayerVisibility } from '../chart/priceActionCoordinates';

interface TradingChartProps {
  candles: Candle[];
  structures: Structure[];
  visibleTypes: StructureType[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  resetToken: number;
  /** Change when switching the instrument, timeframe, or imported CSV. */
  datasetKey?: string;
  symbol?: string;
  timeframe?: string;
  exchange?: string;
  tradeSetups?: TradeSetup[];
  liquiditySweeps?: LiquiditySweep[];
  showTradeSetups?: boolean;
  showLiquiditySweeps?: boolean;
  selectedSetupId?: string | null;
  selectedSweepId?: string | null;
  onSelectSetup?: (id: string) => void;
  onSelectSweep?: (id: string) => void;
  priceAction?: PriceAction;
  visiblePALayers?: PALayerVisibility;
  showSMC?: boolean;
  showPA?: boolean;
  selectedPAId?: string | null;
  onSelectPA?: (id: string) => void;
}

interface ChartState {
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  volume: ISeriesApi<'Histogram'>;
  overlay: StructureOverlay;
  tradeOverlay: TradeOverlay;
  paOverlay: PriceActionOverlay;
  priceMultiplier: number;
}

const volumeLabel = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 4 });

export function TradingChart({
  candles, structures, visibleTypes, selectedId, onSelect, resetToken,
  datasetKey = 'default', symbol = 'OHLCV', timeframe = '', exchange = 'CSV',
  tradeSetups = [], liquiditySweeps = [], showTradeSetups = true, showLiquiditySweeps = true,
  selectedSetupId = null, selectedSweepId = null, onSelectSetup, onSelectSweep,
  priceAction, visiblePALayers = ALL_PA_LAYERS, showSMC = true, showPA = true, selectedPAId = null, onSelectPA,
}: TradingChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<ChartState | null>(null);
  const candleRef = useRef(candles);
  const onSelectRef = useRef(onSelect);
  const onSelectSetupRef = useRef(onSelectSetup);
  const onSelectSweepRef = useRef(onSelectSweep);
  const onSelectPARef = useRef(onSelectPA);
  const loadedData = useRef<{ candles: Candle[]; datasetKey: string } | null>(null);
  const [hovered, setHovered] = useState<Candle | null>(null);
  const [magnet, setMagnet] = useState(true);
  const [logScale, setLogScale] = useState(false);
  const selectedStructure = structures.find((structure) => structure.id === selectedId);
  const activeSetup = showTradeSetups ? tradeSetups.find((setup) => setup.id === selectedSetupId) ?? tradeSetups[0] : undefined;
  const selectedSweep = showLiquiditySweeps ? liquiditySweeps.find((sweep) => sweep.id === selectedSweepId) : undefined;
  const selectedPA = showPA ? findPAItem(priceAction, selectedPAId) : undefined;
  const selectedPABounds = selectedPA && priceAction ? paItemBounds(selectedPA, priceAction, candles) : null;
  const selectedPAPrices = selectedPABounds?.prices.join(',');
  const activeSetupTargets = activeSetup?.targets.map((target) => target.price).join(',');
  candleRef.current = candles;
  onSelectRef.current = onSelect;
  onSelectSetupRef.current = onSelectSetup;
  onSelectSweepRef.current = onSelectSweep;
  onSelectPARef.current = onSelectPA;

  useEffect(() => {
    if (!host.current) return;
    const chart = createChart(host.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#131722' },
        textColor: '#b2b5be',
        fontFamily: 'Arial, "Segoe UI", sans-serif',
        fontSize: 12,
        attributionLogo: true,
        panes: { separatorColor: '#2a2e39', separatorHoverColor: '#434651', enableResize: true },
      },
      grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: '#758696', style: LineStyle.Dashed, labelBackgroundColor: '#363a45' },
        horzLine: { color: '#758696', style: LineStyle.Dashed, labelBackgroundColor: '#363a45' },
      },
      rightPriceScale: { borderColor: '#2a2e39', scaleMargins: { top: 0.1, bottom: 0.08 }, minimumWidth: 82 },
      timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: false, rightOffset: 6, barSpacing: 8, minBarSpacing: 2 },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
      localization: { locale: 'en-US' },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#089981', downColor: '#f23645',
      borderUpColor: '#089981', borderDownColor: '#f23645',
      wickUpColor: '#089981', wickDownColor: '#f23645',
      priceLineStyle: LineStyle.Dashed,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false }, 1);
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.16, bottom: 0 }, borderVisible: false });
    chart.panes()[0].setStretchFactor(4.3);
    chart.panes()[1].setStretchFactor(1);
    const overlay = new StructureOverlay();
    series.attachPrimitive(overlay);
    const tradeOverlay = new TradeOverlay();
    series.attachPrimitive(tradeOverlay);
    const paOverlay = new PriceActionOverlay();
    series.attachPrimitive(paOverlay);
    api.current = { chart, series, volume, overlay, tradeOverlay, paOverlay, priceMultiplier: 1 };

    chart.subscribeCrosshairMove((event) => {
      if (typeof event.time !== 'number') { setHovered(null); return; }
      const index = nearestCandleIndex(candleRef.current, event.time);
      setHovered(index >= 0 ? candleRef.current[index] : null);
    });
    chart.subscribeClick((event) => {
      if (event.paneIndex !== 0) return;
      const tradeHit = event.point ? tradeOverlay.hitTest(event.point.x, event.point.y) : null;
      if (tradeHit?.externalId.startsWith('setup:')) {
        onSelectSetupRef.current?.(tradeHit.externalId.slice(6));
        return;
      }
      if (tradeHit?.externalId.startsWith('sweep:')) {
        onSelectSweepRef.current?.(tradeHit.externalId.slice(6));
        return;
      }
      const paHit = event.point ? paOverlay.hitTest(event.point.x, event.point.y) : null;
      if (paHit) { onSelectPARef.current?.(paHit.externalId.slice(3)); return; }
      const hit = event.point ? overlay.hitTest(event.point.x, event.point.y) : null;
      if (hit) onSelectRef.current(hit.externalId);
    });
    return () => {
      series.detachPrimitive(overlay);
      series.detachPrimitive(tradeOverlay);
      series.detachPrimitive(paOverlay);
      chart.remove();
      api.current = null;
      loadedData.current = null;
    };
  }, []);

  useEffect(() => {
    const state = api.current;
    if (!state) return;
    const previous = loadedData.current;
    const sameDataset = previous?.datasetKey === datasetKey;
    const range = sameDataset
      ? preserveLogicalWindow(previous.candles, candles, state.chart.timeScale().getVisibleLogicalRange())
      : null;
    const { multiplier, format } = createChartPriceScale(candles);
    const priceScale = state.series.priceScale();
    const previousPriceRange = sameDataset && !priceScale.options().autoScale ? priceScale.getVisibleRange() : null;
    const scaleRatio = multiplier / state.priceMultiplier;
    state.priceMultiplier = multiplier;
    state.overlay.setPriceMultiplier(multiplier);
    state.tradeOverlay.setPriceMultiplier(multiplier);
    state.paOverlay.setPriceMultiplier(multiplier);
    state.series.applyOptions({ priceFormat: format });
    const candleData = (candle: Candle) => ({
      time: candle.timestamp as UTCTimestamp,
      open: candle.open * multiplier,
      high: candle.high * multiplier,
      low: candle.low * multiplier,
      close: candle.close * multiplier,
    });
    const volumeData = (candle: Candle) => ({ time: candle.timestamp as UTCTimestamp, value: candle.volume, color: candle.close >= candle.open ? 'rgba(8,153,129,.44)' : 'rgba(242,54,69,.44)' });
    const plan = sameDataset && scaleRatio === 1
      ? candleUpdatePlan(previous.candles, candles) : { kind: 'replace' as const };
    if (plan.kind === 'replace') {
      state.series.setData(candles.map(candleData));
      state.volume.setData(candles.map(volumeData));
    } else if (plan.kind === 'tail') {
      for (const candle of candles.slice(plan.from)) {
        state.series.update(candleData(candle));
        state.volume.update(volumeData(candle));
      }
    }
    const nextRange = range ?? latestCandleWindow(candles.length, (host.current?.clientWidth ?? 800) < 600 ? 65 : 110);
    const currentRange = state.chart.timeScale().getVisibleLogicalRange();
    if (nextRange && (!currentRange || nextRange.from !== currentRange.from || nextRange.to !== currentRange.to)) {
      state.chart.timeScale().setVisibleLogicalRange(nextRange);
    }
    if (!sameDataset) priceScale.applyOptions({ autoScale: true });
    else if (previousPriceRange && scaleRatio !== 1) {
      priceScale.setVisibleRange({ from: previousPriceRange.from * scaleRatio, to: previousPriceRange.to * scaleRatio });
    }
    loadedData.current = { candles, datasetKey };
    if (!sameDataset) {
      setHovered(null);
    } else {
      setHovered((current) => current ? candles.find((candle) => candle.timestamp === current.timestamp) ?? null : null);
    }
  }, [candles, datasetKey]);

  useEffect(() => {
    api.current?.overlay.setData(showSMC ? structures.filter((structure) => visibleTypes.includes(structure.type)) : [], selectedId, candles, Boolean(selectedPAId));
  }, [structures, visibleTypes, selectedId, showSMC, candles, selectedPAId]);

  useEffect(() => {
    api.current?.paOverlay.setData(candles, showPA ? priceAction : undefined, visiblePALayers, selectedPAId, Boolean(selectedId || selectedSweepId || selectedSetupId));
  }, [candles, priceAction, visiblePALayers, showPA, selectedPAId, selectedId, selectedSweepId, selectedSetupId]);

  useEffect(() => {
    api.current?.tradeOverlay.setData(activeSetup ?? null, showLiquiditySweeps ? liquiditySweeps : [], selectedSweepId, Boolean(selectedPAId || selectedId));
  }, [activeSetup, liquiditySweeps, showLiquiditySweeps, selectedSweepId, selectedPAId, selectedId]);

  useEffect(() => {
    const state = api.current;
    const selected = selectedStructure;
    if (!state || !selected) return;
    // Polling recreates candle/structure arrays. Only an actual selection or
    // changed structure anchor should re-focus a user-panned viewport.
    const range = structureFocusRange(candles, selected);
    if (!range) return;
    state.chart.timeScale().setVisibleLogicalRange(range);
    state.series.priceScale().applyOptions({ autoScale: true });
    // Wait one paint for the new logical range to update its price/time scales.
    const frame = requestAnimationFrame(() => {
      state.chart.setCrosshairPosition(selected.price * state.priceMultiplier, selected.startTime as UTCTimestamp, state.series);
      const index = nearestCandleIndex(candles, selected.startTime);
      if (index >= 0) setHovered(candles[index]);
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedStructure?.id, selectedStructure?.startTime, selectedStructure?.endTime, selectedStructure?.price, selectedStructure?.priceEnd, datasetKey]);

  useEffect(() => {
    const state = api.current;
    // A fallback setup stays visible while inspecting PA or a sweep, but must
    // never move the viewport away from that explicit selection.
    if (!state || !activeSetup || selectedId || selectedSweepId || selectedPAId) return;
    const range = tradeSetupFocusRange(candles, activeSetup);
    if (!range) return;
    state.chart.timeScale().setVisibleLogicalRange(range);
    state.series.priceScale().applyOptions({ autoScale: true });
    const frame = requestAnimationFrame(() => {
      state.chart.setCrosshairPosition(activeSetup.entry * state.priceMultiplier, activeSetup.anchorTime as UTCTimestamp, state.series);
      const index = nearestCandleIndex(candles, activeSetup.anchorTime);
      if (index >= 0) setHovered(candles[index]);
    });
    return () => cancelAnimationFrame(frame);
    // Only changed anchors/levels refocus, never ordinary forming-candle ticks.
  }, [activeSetup?.id, activeSetup?.anchorTime, activeSetup?.entry, activeSetup?.stopLoss, activeSetupTargets, selectedSetupId, selectedId, selectedSweepId, selectedPAId, datasetKey]);

  useEffect(() => {
    const state = api.current;
    if (!state || !selectedPA || !priceAction || !selectedPABounds) return;
    const range = paFocusRange(candles, selectedPA, priceAction);
    if (!range) return;
    state.chart.timeScale().setVisibleLogicalRange(range);
    state.series.priceScale().applyOptions({ autoScale: true });
    const frame = requestAnimationFrame(() => {
      state.chart.setCrosshairPosition(selectedPABounds.anchorPrice * state.priceMultiplier, selectedPABounds.anchorTime as UTCTimestamp, state.series);
      const index = nearestCandleIndex(candles, selectedPABounds.anchorTime);
      if (index >= 0) setHovered(candles[index]);
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedPA?.id, selectedPABounds?.startTime, selectedPABounds?.endTime, selectedPABounds?.anchorTime, selectedPAPrices, datasetKey]);

  useEffect(() => {
    const state = api.current;
    if (!state || !selectedSweep) return;
    const range = structureFocusRange(candles, { startTime: selectedSweep.levelTime, endTime: selectedSweep.sweepTime });
    if (!range) return;
    state.chart.timeScale().setVisibleLogicalRange(range);
    state.series.priceScale().applyOptions({ autoScale: true });
    const frame = requestAnimationFrame(() => {
      state.chart.setCrosshairPosition(selectedSweep.extremePrice * state.priceMultiplier, selectedSweep.sweepTime as UTCTimestamp, state.series);
      const index = nearestCandleIndex(candles, selectedSweep.sweepTime);
      if (index >= 0) setHovered(candles[index]);
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedSweep?.id, selectedSweep?.levelTime, selectedSweep?.sweepTime, selectedSweep?.levelPrice, selectedSweep?.extremePrice, datasetKey]);

  useEffect(() => {
    const state = api.current;
    const latestCandles = candleRef.current;
    const nearLatestSetup = activeSetup && nearestCandleIndex(latestCandles, activeSetup.anchorTime) >= latestCandles.length - 20;
    const range = nearLatestSetup
      ? tradeSetupFocusRange(latestCandles, activeSetup)
      : latestCandleWindow(latestCandles.length, (host.current?.clientWidth ?? 800) < 600 ? 65 : 110);
    if (state && range) {
      state.chart.timeScale().setVisibleLogicalRange(range);
      state.series.priceScale().applyOptions({ autoScale: true });
    }
  }, [resetToken]);

  useEffect(() => {
    api.current?.chart.applyOptions({ crosshair: { mode: magnet ? CrosshairMode.Magnet : CrosshairMode.Normal } });
  }, [magnet]);

  useEffect(() => {
    api.current?.series.priceScale().applyOptions({ mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal, autoScale: true });
  }, [logScale]);

  const readout = hovered ?? candles.at(-1);
  const up = readout ? readout.close >= readout.open : true;
  const change = readout ? (readout.close - readout.open) / readout.open * 100 : 0;
  return <div className="chart-shell">
    <div className="chart-readout" aria-live="off">
      <div className="chart-instrument-line"><span className="chart-instrument-dot" /><strong>{symbol}</strong><span>· {timeframe ? `${timeframe} · ` : ''}{exchange}</span><span className="chart-candle-label">蜡烛图</span></div>
      <div className="chart-ohlc">
      {readout && <>
        <span>O <b className={up ? 'readout-up' : 'readout-down'}>{formatPrice(readout.open)}</b></span>
        <span>H <b className={up ? 'readout-up' : 'readout-down'}>{formatPrice(readout.high)}</b></span>
        <span>L <b className={up ? 'readout-up' : 'readout-down'}>{formatPrice(readout.low)}</b></span>
        <span>C <b className={up ? 'readout-up' : 'readout-down'}>{formatPrice(readout.close)}</b></span>
        <b className={up ? 'readout-up' : 'readout-down'}>{change >= 0 ? '+' : ''}{change.toFixed(2)}%</b>
        <span className="readout-volume">V <b>{volumeLabel(readout.volume)}</b></span>
        <span className="readout-time">{new Date(readout.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ')} <small>UTC</small></span>
      </>}
      </div>
    </div>
    <div className="chart-host" ref={host} role="img" aria-label="交互式 OHLCV K 线图。滚轮缩放、拖动平移，移动指针查看十字光标；点击标注或分析列表定位结构。时间轴使用 UTC。" />
    <div className="chart-controls" role="toolbar" aria-label="图表显示设置">
      <span className="chart-control-caption">成交量 <i className={up ? 'readout-up' : 'readout-down'}>{readout ? volumeLabel(readout.volume) : '—'}</i></span>
      <button className="chart-control" type="button" aria-pressed={magnet} onClick={() => setMagnet((value) => !value)} title="切换十字光标磁吸到最近 K 线">磁吸</button>
      <button className="chart-control" type="button" aria-pressed={logScale} onClick={() => setLogScale((value) => !value)} title="切换对数价格坐标">对数</button>
      <button className="chart-control" type="button" onClick={() => api.current?.series.priceScale().applyOptions({ autoScale: true })} title="重新适应当前可见 K 线的价格范围">自动缩放</button>
      <span className="chart-timezone">UTC</span>
    </div>
  </div>;
}
