// @refresh reset
// Native chart primitives must be recreated when their renderer changes in development.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
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
  type Coordinate,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle } from '../../shared/market';
import type { PlanTrackingResult } from '../../shared/tradeTracking';
import type { Analysis, LiquiditySweep, Structure, StructureType, TradeSetup } from '../../shared/analysis';
import type { PriceAction } from '../../shared/priceAction';
import type { RuleIndicatorZone } from '../../shared/indicators';
import { formatPrice } from '../../shared/format';
import { formatDisplayTime } from '../../shared/displayTime';
import { chartTimeFormatter, chartTickFormatter } from '../chart/chartTime';
import { nearestCandleIndex, structureFocusRange } from '../chart/coordinates';
import { ChartLabelRegistry, labelDensity } from '../chart/labelLayout';
import { StructureOverlay, type ChartStructure } from '../chart/StructureOverlay';
import { createChartPriceScale } from '../chart/priceScale';
import { candleUpdatePlan, latestCandleWindow, preserveLogicalWindow } from '../chart/liveUpdates';
import { TradeOverlay } from '../chart/TradeOverlay';
import { tradeSetupFocusRange } from '../chart/tradeCoordinates';
import { PriceActionOverlay } from '../chart/PriceActionOverlay';
import { ALL_PA_LAYERS, findPAItem, paFocusRange, paItemBounds, type PALayerVisibility } from '../chart/priceActionCoordinates';
import { AnalysisRangeOverlay } from '../chart/AnalysisRangeOverlay';
import { IndicatorOverlay } from '../chart/IndicatorOverlay';
import { KeyLevelOverlay, type ChartPriceLevel } from '../chart/KeyLevelOverlay';
import type { PositionChartModel } from '../../shared/positionChart';
import { indicatorDisplayEndTime, indicatorFocusRange } from '../chart/indicatorCoordinates';
import { analysisRangeFromCoordinates, normalizeAnalysisRange, type AnalysisRange } from '../analysisRange';
import { candleMarketContexts, hasEquitySessionReference, PHASE_LABELS, volumeStrength } from '../../shared/marketContext';
import { MarketSessionOverlay } from '../chart/MarketSessionOverlay';
import { CHART_THEME, withAlpha } from '../chart/chartTheme';

interface TradingChartProps {
  positionView?:PositionChartModel|null;
  selectedPositionLineId?:string|null;
  onSelectPositionLine?:(id:string)=>void;
  candles: Candle[];
  structures: ChartStructure[];
  visibleTypes: StructureType[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  resetToken: number;
  evidenceFocusToken?: number;
  /** Change when switching the instrument, timeframe, or imported CSV. */
  datasetKey?: string;
  symbol?: string;
  timeframe?: string;
  exchange?: string;
  tradeSetups?: TradeSetup[];
  tradeTracking?: Record<string, PlanTrackingResult>;
  liquiditySweeps?: LiquiditySweep[];
  showTradeSetups?: boolean;
  showLiquiditySweeps?: boolean;
  selectedSetupId?: string | null;
  /** An explicit locate action can refocus an already selected plan. */
  setupFocusToken?: number;
  selectedSweepId?: string | null;
  onSelectSetup?: (id: string) => void;
  onSelectSweep?: (id: string) => void;
  priceAction?: PriceAction;
  visiblePALayers?: PALayerVisibility;
  showSMC?: boolean;
  showPA?: boolean;
  selectedPAId?: string | null;
  onSelectPA?: (id: string) => void;
  rangeSelectionEnabled?: boolean;
  selectedRange?: AnalysisRange | null;
  onSelectRange?: (range: AnalysisRange) => void;
  /** Closed candles eligible for analysis; the forming tail cannot be selected. */
  selectableCandles?: Candle[];
  selectionDisabled?: boolean;
  /** Rule-derived context remains independent of any AI analysis result. */
  indicatorZones?: RuleIndicatorZone[];
  selectedIndicatorId?: string | null;
  onSelectIndicator?: (id: string) => void;
  keyLevels?: Analysis['keyLevels'];
  showKeyLevels?: boolean;
  selectedKeyLevelIndex?: number | null;
  onSelectKeyLevel?: (index: number) => void;
}

interface ChartState {
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  volume: ISeriesApi<'Histogram'>;
  overlay: StructureOverlay;
  tradeOverlay: TradeOverlay;
  paOverlay: PriceActionOverlay;
  rangeOverlay: AnalysisRangeOverlay;
  indicatorOverlay: IndicatorOverlay;
  keyLevelOverlay: KeyLevelOverlay;
  sessionOverlay: MarketSessionOverlay;
  volumeSessionOverlay: MarketSessionOverlay;
  priceMultiplier: number;
}

const volumeLabel = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 4 });

export function TradingChart({
  candles, structures, visibleTypes, selectedId, onSelect, resetToken, evidenceFocusToken = 0,
  datasetKey = 'default', symbol = 'OHLCV', timeframe = '', exchange = 'CSV',
  tradeSetups = [], tradeTracking = {}, liquiditySweeps = [], showTradeSetups = true, showLiquiditySweeps = true,
  selectedSetupId = null, setupFocusToken = 0, selectedSweepId = null, onSelectSetup, onSelectSweep,
  priceAction, visiblePALayers = ALL_PA_LAYERS, showSMC = true, showPA = true, selectedPAId = null, onSelectPA,
  rangeSelectionEnabled = false, selectedRange = null, onSelectRange, selectableCandles = candles, selectionDisabled = false,
  indicatorZones = [], selectedIndicatorId = null, onSelectIndicator,
  keyLevels = [], showKeyLevels = true, selectedKeyLevelIndex = null, onSelectKeyLevel,
  positionView=null,
  selectedPositionLineId=null,onSelectPositionLine,
}: TradingChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<ChartState | null>(null);
  const candleRef = useRef(candles);
  const onSelectRef = useRef(onSelect);
  const onSelectSetupRef = useRef(onSelectSetup);
  const onSelectSweepRef = useRef(onSelectSweep);
  const onSelectPARef = useRef(onSelectPA);
  const onSelectIndicatorRef = useRef(onSelectIndicator);
  const onSelectKeyLevelRef = useRef(onSelectKeyLevel);
  const positionRef=useRef(positionView),onPositionLineRef=useRef(onSelectPositionLine);
  positionRef.current=positionView;onPositionLineRef.current=onSelectPositionLine;
  const rangeSelectionEnabledRef = useRef(false);
  const selectionAnchor = useRef<number | null>(null);
  const pointerSelection = useRef<{ pointerId: number; startX: number; anchor: number; secondClick: boolean } | null>(null);
  const [rangePreview, setRangePreview] = useState<AnalysisRange | null>(null);
  const [rangePaneSize, setRangePaneSize] = useState({ width: 0, height: 0 });
  const [awaitingRangeEnd, setAwaitingRangeEnd] = useState(false);
  const loadedData = useRef<{ candles: Candle[]; datasetKey: string } | null>(null);
  const [densityMode, setDensityMode] = useState('structure');
  const [hovered, setHovered] = useState<Candle | null>(null);
  const [magnet, setMagnet] = useState(true);
  const [logScale, setLogScale] = useState(false);
  const [showSessions, setShowSessions] = useState(true);
  const [fullPlanKey, setFullPlanKey] = useState<string | null>(null);
  const marketContexts = useMemo(() => new Map(candleMarketContexts(candles, symbol, timeframe).map(row => [row.timestamp, row])), [candles, symbol, timeframe]);
  const equityReference = hasEquitySessionReference(symbol);
  const renderedStructures = useMemo(() => showSMC ? structures.filter(structure => visibleTypes.includes(structure.type)) : [], [showSMC, structures, visibleTypes]);
  const selectedStructure = structures.find((structure) => structure.id === selectedId);
  const activeSetup = showTradeSetups ? tradeSetups.find((setup) => setup.id === selectedSetupId) ?? tradeSetups[0] : undefined;
  // A new plan or an explicit locate action starts with its candle context.
  // Ordinary live ticks do not reset the user's chosen view or viewport.
  const planViewKey = `${datasetKey}|${activeSetup?.id ?? ''}|${setupFocusToken}`;
  const showFullPlan = Boolean(activeSetup && fullPlanKey === planViewKey);
  const selectedSweep = showLiquiditySweeps ? liquiditySweeps.find((sweep) => sweep.id === selectedSweepId) : undefined;
  const selectedPA = showPA ? findPAItem(priceAction, selectedPAId) : undefined;
  const selectedPABounds = selectedPA && priceAction ? paItemBounds(selectedPA, priceAction, candles) : null;
  const selectedPAPrices = selectedPABounds?.prices.join(',');
  const selectedIndicator = indicatorZones.find(zone => zone.id === selectedIndicatorId);
  const selectedKeyLevel = showKeyLevels && selectedKeyLevelIndex !== null ? keyLevels[selectedKeyLevelIndex] : undefined;
  const activeSetupTargets = activeSetup?.targets.map((target) => target.price).join(',');
  candleRef.current = candles;
  onSelectRef.current = onSelect;
  onSelectSetupRef.current = onSelectSetup;
  onSelectSweepRef.current = onSelectSweep;
  onSelectPARef.current = onSelectPA;
  onSelectIndicatorRef.current = onSelectIndicator;
  onSelectKeyLevelRef.current = onSelectKeyLevel;
  rangeSelectionEnabledRef.current = rangeSelectionEnabled && !selectionDisabled;

  useEffect(() => {
    if (!host.current) return;
    const chart = createChart(host.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: CHART_THEME.background },
        textColor: CHART_THEME.text,
        fontFamily: 'Arial, "Segoe UI", sans-serif',
        fontSize: 12,
        attributionLogo: true,
        panes: { separatorColor: CHART_THEME.divider, separatorHoverColor: '#3a475d', enableResize: true },
      },
      grid: { vertLines: { color: CHART_THEME.grid }, horzLines: { color: CHART_THEME.grid } },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: CHART_THEME.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: CHART_THEME.crosshairLabel },
        horzLine: { color: CHART_THEME.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: CHART_THEME.crosshairLabel },
      },
      rightPriceScale: { borderColor: CHART_THEME.divider, scaleMargins: { top: 0.1, bottom: 0.08 }, minimumWidth: 82 },
      timeScale: { borderColor: CHART_THEME.divider, timeVisible: true, secondsVisible: false, rightOffset: 6, barSpacing: 8, minBarSpacing: 2, tickMarkFormatter: chartTickFormatter },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
      localization: { locale: 'zh-CN', timeFormatter: chartTimeFormatter },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: CHART_THEME.up, downColor: CHART_THEME.down,
      borderVisible: false,
      wickUpColor: CHART_THEME.wickUp, wickDownColor: CHART_THEME.wickDown,
      priceLineStyle: LineStyle.Dotted, priceLineWidth: 1,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'custom', minMove: 0.01, formatter: (value: number) => value.toFixed(1) + '×' }, lastValueVisible: false, priceLineVisible: false }, 1);
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.16, bottom: 0 }, borderVisible: false });
    volume.createPriceLine({ price: 1, color: '#68748780', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
    chart.panes()[0].setStretchFactor(4.3);
    chart.panes()[1].setStretchFactor(1);
    const registry = new ChartLabelRegistry();
    const sessionOverlay = new MarketSessionOverlay();
    series.attachPrimitive(sessionOverlay);
    const volumeSessionOverlay = new MarketSessionOverlay();
    volume.attachPrimitive(volumeSessionOverlay);
    const overlay = new StructureOverlay(registry);
    series.attachPrimitive(overlay);
    const tradeOverlay = new TradeOverlay(registry);
    series.attachPrimitive(tradeOverlay);
    const paOverlay = new PriceActionOverlay(registry);
    series.attachPrimitive(paOverlay);
    const rangeOverlay = new AnalysisRangeOverlay();
    series.attachPrimitive(rangeOverlay);
    const indicatorOverlay = new IndicatorOverlay(registry);
    series.attachPrimitive(indicatorOverlay);
    const keyLevelOverlay = new KeyLevelOverlay();
    series.attachPrimitive(keyLevelOverlay);
    api.current = { chart, series, volume, overlay, tradeOverlay, paOverlay, rangeOverlay, indicatorOverlay, keyLevelOverlay, sessionOverlay, volumeSessionOverlay, priceMultiplier: 1 };
    let sizeFrame = 0;
    const updateRangePaneSize = () => {
      const size = chart.paneSize(0);
      setDensityMode(labelDensity(chart.timeScale().options().barSpacing, size.width).mode);
      setRangePaneSize((current) => current.width === size.width && current.height === size.height ? current : size);
    };
    const queueRangePaneSize = () => {
      cancelAnimationFrame(sizeFrame);
      sizeFrame = requestAnimationFrame(updateRangePaneSize);
    };
    const rangeResizeObserver = new ResizeObserver(queueRangePaneSize);
    rangeResizeObserver.observe(host.current);
    const paneElement = chart.panes()[0].getHTMLElement();
    if (paneElement) rangeResizeObserver.observe(paneElement);
    chart.timeScale().subscribeSizeChange(queueRangePaneSize);
    chart.timeScale().subscribeVisibleLogicalRangeChange(queueRangePaneSize);
    queueRangePaneSize();

    chart.subscribeCrosshairMove((event) => {
      if (typeof event.time !== 'number') { setHovered(null); return; }
      const index = nearestCandleIndex(candleRef.current, event.time);
      setHovered(index >= 0 ? candleRef.current[index] : null);
    });
    chart.subscribeClick((event) => {
      if (rangeSelectionEnabledRef.current) return;
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
      const indicatorHit = event.point ? indicatorOverlay.hitTest(event.point.x, event.point.y) : null;
      if (indicatorHit) { onSelectIndicatorRef.current?.(indicatorHit.externalId.slice('indicator:'.length)); return; }
      const paHit = event.point ? paOverlay.hitTest(event.point.x, event.point.y) : null;
      if (paHit) { onSelectPARef.current?.(paHit.externalId.slice(3)); return; }
      const hit = event.point ? overlay.hitTest(event.point.x, event.point.y) : null;
      if (hit) { onSelectRef.current(hit.externalId); return; }
      const levelHit = event.point ? keyLevelOverlay.hitTest(event.point.x, event.point.y) : null;
      if (levelHit){const index=Number(levelHit.externalId.slice('key-level:'.length));const position=positionRef.current;if(position?.lines[index])onPositionLineRef.current?.(position.lines[index].id);else onSelectKeyLevelRef.current?.(index);}
    });
    return () => {
      rangeResizeObserver.disconnect();
      cancelAnimationFrame(sizeFrame);
      chart.timeScale().unsubscribeSizeChange(queueRangePaneSize);
      series.detachPrimitive(overlay);
      series.detachPrimitive(tradeOverlay);
      series.detachPrimitive(paOverlay);
      series.detachPrimitive(rangeOverlay);
      series.detachPrimitive(indicatorOverlay);
      series.detachPrimitive(keyLevelOverlay);
      series.detachPrimitive(sessionOverlay);
      volume.detachPrimitive(volumeSessionOverlay);
      chart.remove();
      api.current = null;
      loadedData.current = null;
    };
  }, []);

  useEffect(() => {
    api.current?.sessionOverlay.setData(candles, symbol, timeframe, showSessions);
    api.current?.volumeSessionOverlay.setData(candles, symbol, timeframe, showSessions);
  }, [candles, symbol, timeframe, showSessions]);

  useEffect(() => {
    api.current?.rangeOverlay.setData(selectableCandles, rangePreview ?? selectedRange, Boolean(rangePreview));
  }, [selectableCandles, selectedRange, rangePreview]);

  useEffect(() => {
    if (rangeSelectionEnabled && !selectionDisabled) return;
    selectionAnchor.current = null;
    pointerSelection.current = null;
    setAwaitingRangeEnd(false);
    setRangePreview(null);
  }, [rangeSelectionEnabled, selectionDisabled, datasetKey]);

  useEffect(() => {
    selectionAnchor.current = null;
    pointerSelection.current = null;
    setAwaitingRangeEnd(false);
    setRangePreview(null);
  }, [datasetKey]);

  useEffect(() => {
    if (!rangeSelectionEnabled || selectionDisabled) return;
    const cancelPreview = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || (!selectionAnchor.current && !pointerSelection.current)) return;
      event.preventDefault(); event.stopPropagation();
      selectionAnchor.current = null; pointerSelection.current = null;
      setAwaitingRangeEnd(false); setRangePreview(null);
    };
    window.addEventListener('keydown', cancelPreview, true);
    return () => window.removeEventListener('keydown', cancelPreview, true);
  }, [rangeSelectionEnabled, selectionDisabled]);

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
    state.indicatorOverlay.setPriceMultiplier(multiplier);
    state.keyLevelOverlay.setPriceMultiplier(multiplier);
    state.series.applyOptions({ priceFormat: format });
    const candleData = (candle: Candle) => ({
      time: candle.timestamp as UTCTimestamp,
      open: candle.open * multiplier,
      high: candle.high * multiplier,
      low: candle.low * multiplier,
      close: candle.close * multiplier,
    });
    const volumeData = (candle: Candle) => {
      const relative = marketContexts.get(candle.timestamp)?.relativeVolume ?? null;
      const time = candle.timestamp as UTCTimestamp;
      if (relative === null) return { time };
      const opacity = relative >= 1.5 ? .75 : relative < .7 ? .25 : .46;
      return { time, value: relative, color: withAlpha(candle.close >= candle.open ? CHART_THEME.up : CHART_THEME.down, opacity) };
    };
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
  }, [candles, datasetKey, marketContexts]);

  useEffect(() => {
    api.current?.overlay.setData(renderedStructures, selectedId, candles, Boolean(selectedPAId || selectedIndicatorId));
  }, [renderedStructures, selectedId, candles, selectedPAId, selectedIndicatorId]);

  useEffect(() => {
    api.current?.paOverlay.setData(candles, showPA ? priceAction : undefined, visiblePALayers, selectedPAId, Boolean(selectedId || selectedSweepId || selectedSetupId || selectedIndicatorId));
  }, [candles, priceAction, visiblePALayers, showPA, selectedPAId, selectedId, selectedSweepId, selectedSetupId, selectedIndicatorId]);

  useEffect(() => {
    const state = api.current;
    if (!state) return;
    state.tradeOverlay.setIncludePlanInScale(showFullPlan);
    state.series.priceScale().applyOptions({ autoScale: true });
  }, [showFullPlan, activeSetup?.id, datasetKey]);

  useEffect(() => {
    api.current?.tradeOverlay.setData(activeSetup ?? null, showLiquiditySweeps ? liquiditySweeps : [], selectedSweepId, Boolean(selectedPAId || selectedId || selectedIndicatorId), activeSetup ? tradeTracking[activeSetup.id] : undefined);
  }, [activeSetup, tradeTracking, liquiditySweeps, showLiquiditySweeps, selectedSweepId, selectedPAId, selectedId, selectedIndicatorId]);

  useEffect(() => {
    api.current?.indicatorOverlay.setData(indicatorZones, selectedIndicatorId, candles);
  }, [indicatorZones, selectedIndicatorId, candles]);

  useEffect(() => {
    const levels:ChartPriceLevel[]=positionView?positionView.lines.map(line=>({label:line.label,price:line.price,reason:line.reason,appearance:{color:positionView.stale?'#7e899b':line.color,style:positionView.stale?'dotted':line.style,unindexed:true}})):showKeyLevels?keyLevels:[];
    const positionIndex=positionView?.lines.findIndex(line=>line.id===selectedPositionLineId)??-1;
    api.current?.keyLevelOverlay.setData(levels,positionView?(positionIndex>=0?positionIndex:null):selectedKeyLevelIndex);
    api.current?.tradeOverlay.setPositionData(positionView);
  }, [keyLevels, showKeyLevels, selectedKeyLevelIndex,positionView,selectedPositionLineId]);

  useEffect(() => {
    const state = api.current;
    if (!state || !selectedKeyLevel) return;
    // Global levels have no time anchor. Reveal the selected price while
    // leaving the current horizontal zoom and historical position intact.
    state.series.priceScale().applyOptions({ autoScale: true });
  }, [selectedKeyLevelIndex, selectedKeyLevel?.price, showKeyLevels, datasetKey, evidenceFocusToken]);

  useEffect(() => {
    const state = api.current;
    const selected = selectedStructure;
    if (!state || !selected) return;
    // Polling recreates candle/structure arrays. Only an actual selection or
    // changed structure anchor should re-focus a user-panned viewport.
    const displayEnd = selected.type === 'FVG' || selected.type === 'OB'
      ? indicatorDisplayEndTime({ formedAt: selected.startTime, endTime: selected.endTime }, candles) : selected.endTime;
    const range = displayEnd === null ? null : structureFocusRange(candles, { startTime: selected.startTime, endTime: displayEnd });
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
  }, [selectedStructure?.id, selectedStructure?.startTime, selectedStructure?.endTime, selectedStructure?.price, selectedStructure?.priceEnd, datasetKey, evidenceFocusToken]);

  useEffect(() => {
    const state = api.current;
    // A fallback setup stays visible while inspecting PA or a sweep, but must
    // never move the viewport away from that explicit selection.
    if (!state || !activeSetup || selectedId || selectedSweepId || selectedPAId || selectedIndicatorId || selectedKeyLevelIndex !== null) return;
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
    // Explicit locate actions and changed levels refocus; ordinary live ticks do not.
  }, [activeSetup?.id, activeSetup?.anchorTime, activeSetup?.entry, activeSetup?.stopLoss, activeSetupTargets, selectedSetupId, setupFocusToken, selectedId, selectedSweepId, selectedPAId, selectedIndicatorId, datasetKey]);

  useEffect(() => {
    const state = api.current;
    if (!state || !selectedIndicator) return;
    const range = indicatorFocusRange(candles, selectedIndicator);
    if (!range) return;
    state.chart.timeScale().setVisibleLogicalRange(range);
    state.series.priceScale().applyOptions({ autoScale: true });
    const frame = requestAnimationFrame(() => {
      state.chart.setCrosshairPosition(selectedIndicator.midpoint * state.priceMultiplier, selectedIndicator.formedAt as UTCTimestamp, state.series);
      const index = nearestCandleIndex(candles, selectedIndicator.formedAt);
      if (index >= 0) setHovered(candles[index]);
    });
    return () => cancelAnimationFrame(frame);
    // Extended endTime, mitigation and status change on live closes, not selection.
  }, [selectedIndicator?.id, selectedIndicator?.originTime, selectedIndicator?.formedAt, selectedIndicator?.lowerPrice, selectedIndicator?.upperPrice, datasetKey, evidenceFocusToken]);

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
  }, [selectedPA?.id, selectedPABounds?.startTime, selectedPABounds?.endTime, selectedPABounds?.anchorTime, selectedPAPrices, datasetKey, evidenceFocusToken]);

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
  }, [selectedSweep?.id, selectedSweep?.levelTime, selectedSweep?.sweepTime, selectedSweep?.levelPrice, selectedSweep?.extremePrice, datasetKey, evidenceFocusToken]);

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

  const rangePoint = (x: number): AnalysisRange | null => {
    const state = api.current;
    return state ? analysisRangeFromCoordinates(selectableCandles, x, x,
      (coordinate) => state.chart.timeScale().coordinateToLogical(coordinate as Coordinate), candles) : null;
  };
  const selectionX = (event: ReactPointerEvent<HTMLDivElement>) => event.clientX - event.currentTarget.getBoundingClientRect().left;
  const previewTo = (anchor: number, timestamp: number) => {
    const range = normalizeAnalysisRange(selectableCandles, { from: anchor, to: timestamp });
    setRangePreview(range);
    return range;
  };
  const handleRangePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !rangeSelectionEnabledRef.current || pointerSelection.current) return;
    const x = selectionX(event), point = rangePoint(x);
    if (!point) return;
    event.preventDefault(); event.stopPropagation();
    const anchor = selectionAnchor.current ?? point.from;
    pointerSelection.current = { pointerId: event.pointerId, startX: x, anchor, secondClick: selectionAnchor.current !== null };
    previewTo(anchor, point.from);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handleRangePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointer = pointerSelection.current;
    if (pointer && pointer.pointerId !== event.pointerId) return;
    const anchor = pointer?.anchor ?? selectionAnchor.current;
    if (anchor === null || !rangeSelectionEnabledRef.current) return;
    const point = rangePoint(selectionX(event));
    if (point) previewTo(anchor, point.from);
  };
  const handleRangePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointer = pointerSelection.current;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    const x = selectionX(event), point = rangePoint(x);
    pointerSelection.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!point) { setRangePreview(null); return; }
    const range = previewTo(pointer.anchor, point.from);
    if (pointer.secondClick || Math.abs(x - pointer.startX) >= 5) {
      selectionAnchor.current = null;
      setAwaitingRangeEnd(false);
      if (range) onSelectRange?.(range);
    } else {
      selectionAnchor.current = pointer.anchor;
      setAwaitingRangeEnd(true);
    }
  };
  const cancelRangePointer = () => {
    pointerSelection.current = null; selectionAnchor.current = null;
    setAwaitingRangeEnd(false); setRangePreview(null);
  };

  const readout = hovered ?? candles.at(-1);
  const readoutContext = readout ? marketContexts.get(readout.timestamp) : undefined;
  const relativeVolume = readoutContext?.relativeVolume ?? null;
  const provisional = !!readout && !selectableCandles.some(bar => bar.timestamp === readout.timestamp);
  const up = readout ? readout.close >= readout.open : true;
  const change = readout ? (readout.close - readout.open) / readout.open * 100 : 0;
  return <div className="chart-shell" style={{ '--chart-background': CHART_THEME.background, '--chart-up': CHART_THEME.up, '--chart-down': CHART_THEME.down } as CSSProperties}>
    <div className="chart-readout" aria-live="off">
      <div className="chart-instrument-line"><span className="chart-instrument-dot" /><strong>{symbol}</strong><span>· {timeframe ? `${timeframe} · ` : ''}{exchange}</span><span className="chart-candle-label">蜡烛图</span></div>
      <div className="chart-ohlc">
      {readout && <>
        <span>O <b className={up ? 'readout-up' : 'readout-down'}>{formatPrice(readout.open)}</b></span>
        <span>H <b className={up ? 'readout-up' : 'readout-down'}>{formatPrice(readout.high)}</b></span>
        <span>L <b className={up ? 'readout-up' : 'readout-down'}>{formatPrice(readout.low)}</b></span>
        <span>C <b className={up ? 'readout-up' : 'readout-down'}>{formatPrice(readout.close)}</b></span>
        <b className={up ? 'readout-up' : 'readout-down'}>{change >= 0 ? '+' : ''}{change.toFixed(2)}%</b>
        <span className="readout-volume" title={`原始成交量 ${volumeLabel(readout.volume)}；相对前20根均量，至少5根，遇缺口重置。${provisional ? '本根未收盘，量能仅为预览。' : ''}`}>RVOL <b>{relativeVolume === null ? '—' : relativeVolume.toFixed(2) + '×'}</b> · {volumeStrength(relativeVolume)}{provisional && ' · 进行中'}</span>
        {equityReference && readoutContext && <span className="market-phase" data-phase={readoutContext.phase} title="对应K线的美股/BOATS时段参考，America/New_York自动处理夏令时；不是合约开闭市状态。">{PHASE_LABELS[readoutContext.phase]} · NY参考</span>}
        <span className="readout-time">{formatDisplayTime(readout.timestamp)} <small>UTC+8</small></span>
      </>}
      </div>
    </div>
    <div className="chart-host-wrap" style={{ position: 'relative' }}>
      <div className="chart-host" ref={host} role="img" aria-label="交互式 OHLCV K 线图。滚轮缩放、拖动平移，移动指针查看十字光标；点击标注或分析列表定位结构。时间轴使用 UTC+8。" />
      {rangeSelectionEnabled && !selectionDisabled && rangePaneSize.width > 0 && <div
        className="analysis-range-surface" data-testid="analysis-range-surface" role="group"
        aria-label="在 K 线图上拖动，或依次点击起点和终点选择分析范围"
        style={{ position: 'absolute', top: 0, left: 0, width: rangePaneSize.width, height: rangePaneSize.height, touchAction: 'none', cursor: 'crosshair', zIndex: 4, overflow: 'hidden' }}
        onPointerDown={handleRangePointerDown} onPointerMove={handleRangePointerMove} onPointerUp={handleRangePointerUp}
        onPointerCancel={cancelRangePointer} onLostPointerCapture={() => { if (pointerSelection.current) cancelRangePointer(); }}
      >
        <span className="analysis-range-hint" role="status" style={{ position: 'absolute', left: 8, right: 8, top: 8, margin: '0 auto', width: 'fit-content', maxWidth: 'calc(100% - 16px)', padding: '6px 9px', color: '#c6dcff', background: 'rgba(24,39,64,.94)', border: '1px solid #3a5f94', borderRadius: 4, fontSize: 11, lineHeight: 1.6, pointerEvents: 'none', textAlign: 'center' }}>
          {awaitingRangeEnd ? '请选择终点 · Esc 取消本次预选' : '拖动选择范围，或依次点选起点和终点'}
        </span>
      </div>}
    </div>
    <div className="chart-controls" role="toolbar" aria-label="图表显示设置">
      <span className="chart-control-caption" title="量能柱是当前根成交量 ÷ 前20根均量，虚线为1×；不足5根或零基准留空。未收盘根仅预览。">相对量能 <i className={up ? 'readout-up' : 'readout-down'}>{relativeVolume === null ? '—' : relativeVolume.toFixed(2) + '×'}</i></span>
      {activeSetup && <div className="chart-plan-scale" role="group" aria-label="候选计划价格视图">
        <button className="chart-control" type="button" aria-pressed={!showFullPlan} onClick={() => setFullPlanKey(null)} title="按可见K线缩放，保留入场结构细节；图外SL/TP以文字提示">入场结构</button>
        <button className="chart-control" type="button" aria-pressed={showFullPlan} onClick={() => setFullPlanKey(planViewKey)} title="展开价格轴，同时查看入场、SL和所有TP的实际距离">完整计划</button>
      </div>}
      {equityReference && <button className="chart-control" type="button" aria-pressed={showSessions} onClick={() => setShowSessions(value => !value)} title="分钟图（≤15m）显示美股参考时段；隐藏底色不会移除模型输入中的时段信息。">时段底色</button>}
      <button className="chart-control" type="button" aria-pressed={magnet} onClick={() => setMagnet((value) => !value)} title="切换十字光标磁吸到最近 K 线">磁吸</button>
      <button className="chart-control" type="button" aria-pressed={logScale} onClick={() => setLogScale((value) => !value)} title="切换对数价格坐标">对数</button>
      <button className="chart-control" type="button" onClick={() => api.current?.series.priceScale().applyOptions({ autoScale: true })} title="重新适应当前可见 K 线的价格范围">自动缩放</button>
      {selectedRange && <button className="chart-control" type="button" disabled={!candles.some(candle => candle.timestamp === selectedRange.from) || !candles.some(candle => candle.timestamp === selectedRange.to)} onClick={() => {
        const range = structureFocusRange(candles, { startTime: selectedRange.from, endTime: selectedRange.to }, 5);
        if (range && api.current) {
          api.current.chart.timeScale().setVisibleLogicalRange(range);
          api.current.series.priceScale().applyOptions({ autoScale: true });
        }
      }} title="显示完整的手动分析选区">定位选区</button>}
      <span className="chart-density-status" title="仅抑制标签及局部绘图，不删除底层分析数据；点击列表可定位隐藏标签。">{densityMode === 'overview' ? '总览 · 主要结构' : densityMode === 'detail' ? '细节 · 局部证据' : '结构 · 精简标签'}</span><span className="chart-timezone">UTC+8</span>
    </div>
    {(indicatorZones.length > 0 || renderedStructures.length > 0) && <div className="chart-overlay-legend" aria-label="结构绘图图例">
      {renderedStructures.some(item => item.type === 'BOS' || item.type === 'CHoCH') && <span><i className="legend-structure" />BOS / CHoCH</span>}
      {(['FVG', 'OB'] as const).filter(type => indicatorZones.some(zone => zone.type === type) || renderedStructures.some(item => item.type === type)).map(type => <span key={type}>
        <i className="legend-zone" style={{ background: `linear-gradient(90deg, ${withAlpha(CHART_THEME.zone[type].bullish, .42)} 50%, ${withAlpha(CHART_THEME.zone[type].bearish, .42)} 50%)` }} />{type}
      </span>)}
      <span className="legend-candidate"><i />候选结构</span><small>点击结构查看依据</small>
    </div>}
    {equityReference && <div className="session-legend" aria-label="美股参考时段图例" title="按纽约时钟区分阶段，使用标准节假日/提前收盘规则；未接入临时停牌和场所公告。Binance合约仍可24/7交易。"><span>美股参考 · NY</span><span><i data-phase="overnight"/>夜盘</span><span><i data-phase="premarket"/>盘前</span><span><i data-phase="regular"/>盘中</span><span><i data-phase="afterhours"/>盘后</span><span><i data-phase="closed"/>休市</span><small>盘中不铺底色 · 合约全天交易</small></div>}
  </div>;
}
