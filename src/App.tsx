import { ResearchWorkbench } from './components/ResearchWorkbench';
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  ArrowDown, ArrowUp, ArrowUpRight, ArrowsOutSimple, ChartLine, ChartLineUp,
  Check, CheckCircle, Clock, Code, Database, DownloadSimple, FileCsv, GearSix,
  Info, Lightning, MagnifyingGlass, Pulse, ShieldCheck, SpinnerGap, UploadSimple,
  WarningCircle, X,
} from '@phosphor-icons/react';
import { STRUCTURE_TYPES, validateAnalysis, type AnalysisEnvelope, type LiquiditySweep, type Structure, type StructureType, type TradeSetup } from '../shared/analysis';
import { MAX_ANALYSIS_CANDLES, MAX_CANDLES, MIN_CANDLES, parseMarketCsv, type Candle } from '../shared/market';
import { SAMPLE_CANDLES } from '../shared/sample';
import { PA_SAMPLE_CANDLES } from '../shared/paSample';
import { createMockAnalysis } from '../shared/mock';
import { formatPrice } from '../shared/format';
import { emptyPriceAction } from '../shared/priceAction';
import { TradingChart } from './components/TradingChart';
import { LiveMarketControls } from './components/LiveMarketControls';
import { LiquiditySweeps, TradePlans } from './components/AdvancedAnalysis';
import { TradePlanStatus } from './components/TradePlanStatus';
import { evaluateTradePlan, type PlanTrackingResult } from '../shared/tradeTracking';
import { getPAEvidence, paRegimeNames, PriceActionPanel, type PALayer } from './components/PriceActionPanel';
import { useMarketFeed } from './hooks/useMarketFeed';
import { closedMarketCandles, LIVE_INTERVALS, LIVE_INTERVAL_SECONDS, type LiveInterval, type LiveMarketQuery, type MarketSnapshot } from '../shared/liveMarket';
import { getHealth, requestAnalysis, type AnalysisSource, type Health } from './services/api';
import { DEFAULT_LIVE_QUERY, resolveStartup } from './startup';
import { analysisDatasetKey, createAnalysisSnapshot, inspectAnalysisSnapshot, projectAnalysisForCandles, type AnalysisSnapshot } from './analysisSession';
import { AnalysisStatus, type AnalysisTask } from './components/AnalysisStatus';
import { AnalysisCoverage } from './components/AnalysisCoverage';
import { selectAnalysisCandles } from './analysisRange';
import { extractStructureEvidence, selectStructureReferences } from '../shared/structureEvidence';
import { priceEvidence, planEvidenceSummary } from '../shared/analysisResearch';
import { chartStructureProjection, chartLegProjection, ALL_CHART_LAYERS } from './chart/layers';
import { EvidenceCoverage, EvidenceDetails, ResearchStages, RuleStructurePanel } from './components/StructureResearch';
import { RuleIndicatorsPanel, visibleRuleIndicatorZones, type RuleIndicatorVisibility } from './components/RuleIndicatorsPanel';

const money = formatPrice;
const compact = (n: number) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
const date = (t: number) => new Date(t * 1000).toISOString().replace('T', ' ').slice(5, 16);
const directionText = { bullish: '偏多', bearish: '偏空', neutral: '中性' };
const sourceNames = { codex: 'Codex 额度', api: 'API Key', mock: '模拟分析' };
const structureNames: Record<StructureType, string> = { HH: '更高高点', HL: '更高低点', LH: '更低高点', LL: '更低低点', BOS: '结构突破', CHoCH: '特征转变', FVG: '公允价值缺口', OB: '订单块' };
const legacyPASummary = emptyPriceAction().summary;
type Dataset = { name: string; file: string; synthetic: boolean; timeframe: string; source: 'sample' | 'csv' | 'live' };
const sameCandles = (left: Candle[], right: Candle[]) => left.length === right.length && left.every((c, i) => c.timestamp === right[i].timestamp && c.open === right[i].open && c.high === right[i].high && c.low === right[i].low && c.close === right[i].close && c.volume === right[i].volume);
const sampleEnvelope = (candles: Candle[]): AnalysisEnvelope => ({
  analysis: validateAnalysis(createMockAnalysis(candles), candles),
  source: 'mock', model: 'local-demo', analyzedBars: candles.length, generatedAt: new Date().toISOString(),
});

function inferTimeframe(candles: Candle[]) {
  const differences = candles.slice(1).map((c, i) => c.timestamp - candles[i].timestamp).sort((a, b) => a - b);
  const seconds = differences[Math.floor(differences.length / 2)];
  return seconds % 86400 === 0 ? `${seconds / 86400}D` : seconds % 3600 === 0 ? `${seconds / 3600}H` : `${seconds / 60}m`;
}

export default function App() {
  const [startup] = useState(() => resolveStartup(window.location.search));
  const initialQuery = startup.mode === 'live' ? startup.query : DEFAULT_LIVE_QUERY;
  const [candles, setCandles] = useState<Candle[]>(() => startup.mode === 'demo' ? startup.demo === 'pa' ? PA_SAMPLE_CANDLES : SAMPLE_CANDLES : []);
  const [dataset, setDataset] = useState<Dataset>(() => startup.mode === 'live'
    ? { name: startup.query.symbol, file: 'Binance USDⓈ-M', synthetic: false, timeframe: startup.query.interval.toUpperCase(), source: 'live' }
    : { name: startup.demo === 'pa' ? 'PA / 教学示例' : 'BTC / USDT', file: startup.demo === 'pa' ? 'pa-example.csv' : 'sample-ohlcv.csv', synthetic: true, timeframe: inferTimeframe(candles), source: 'sample' });
  const [marketSnapshot, setMarketSnapshot] = useState<MarketSnapshot | null>(null);
  const previousMarketRef = useRef<MarketSnapshot | null>(null);
  const [envelope, setEnvelope] = useState<AnalysisEnvelope | null>(() => startup.mode === 'demo' ? sampleEnvelope(candles) : null);
  const activeDatasetKey = useRef(analysisDatasetKey(dataset));
  const [resultSnapshot, setResultSnapshot] = useState<AnalysisSnapshot | null>(() => startup.mode === 'demo' ? createAnalysisSnapshot(candles, analysisDatasetKey(dataset), 'mock') : null);
  const [analysisTask, setAnalysisTask] = useState<AnalysisTask>({ phase: 'idle', snapshot: null, message: '' });
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [selectionMode, setSelectionMode] = useState<'auto' | 'manual'>('auto');
  const [selectedRange, setSelectedRange] = useState<{ from: number; to: number } | null>(null);
  const [isSelectingRange, setIsSelectingRange] = useState(false);
  const [visibleTypes, setVisibleTypes] = useState<StructureType[]>([...STRUCTURE_TYPES]);
  const [showCandidates, setShowCandidates] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSetupId, setSelectedSetupId] = useState<string | null>(null);
  const [evidenceFocusToken, setEvidenceFocusToken] = useState(0);
  const [setupFocusToken, setSetupFocusToken] = useState(0);
  const [selectedSweepId, setSelectedSweepId] = useState<string | null>(null);
  const [selectedPAId, setSelectedPAId] = useState<string | null>(null);
  const [selectedIndicatorId, setSelectedIndicatorId] = useState<string | null>(null);
  const [selectedKeyLevelIndex, setSelectedKeyLevelIndex] = useState<number | null>(null);
  const [showKeyLevels, setShowKeyLevels] = useState(true);
  const [indicatorVisibility, setIndicatorVisibility] = useState<RuleIndicatorVisibility>({ FVG: true, OB: true, history: false });
  const [chartLayers, setChartLayers] = useState(ALL_CHART_LAYERS);
  const [chartView, setChartView] = useState<'pa' | 'smc' | 'combined'>('pa');
  const [visiblePALayers, setVisiblePALayers] = useState({ zones: true, legs: true, patterns: true, breakouts: true });
  const [showTradeSetups, setShowTradeSetups] = useState(true);
  const [showLiquiditySweeps, setShowLiquiditySweeps] = useState(true);
  const [resetToken, setResetToken] = useState(0);
  const [chartExpanded, setChartExpanded] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [connectionError, setConnectionError] = useState(false);
  const [analysisSource, setAnalysisSource] = useState<AnalysisSource>('mock');
  const sourceEdited = useRef(false);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [notes, setNotes] = useState('');
  const [symbolDraft, setSymbolDraft] = useState(dataset.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [warnings, setWarnings] = useState<string[]>(() => startup.mode === 'live' && startup.error ? [startup.error] : []);
  const [tab, setTab] = useState<'pa' | 'structures' | 'opportunities' | 'liquidity'>('pa');
  const [panel, setPanel] = useState<'import' | 'settings'>('import');
  const fileRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const chartPanelRef = useRef<HTMLElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const fileGeneration = useRef(0);
  const analysis = useMemo(() => envelope ? projectAnalysisForCandles(envelope.analysis, candles, resultSnapshot?.candles) : undefined, [envelope, candles, resultSnapshot]);
  const feed = useMarketFeed((snapshot, reason) => {
    const incomingDataset: Dataset = { name: snapshot.symbol, file: 'Binance USDⓈ-M', synthetic: false, timeframe: snapshot.interval.toUpperCase(), source: 'live' };
    const incomingKey = analysisDatasetKey(incomingDataset);
    if (incomingKey !== activeDatasetKey.current) resetAnalysisDataset(incomingKey);
    previousMarketRef.current = snapshot;
    setMarketSnapshot(snapshot);
    setCandles(current => sameCandles(current, snapshot.candles) ? current : snapshot.candles);
    setDataset(incomingDataset);
    setWarnings(snapshot.warnings);
    if (reason === 'connect') {
      const url = new URL(window.location.href); url.searchParams.set('live', snapshot.symbol); url.searchParams.set('interval', snapshot.interval); url.searchParams.delete('demo');
      window.history.replaceState(null, '', url);
    }
  });
  const availableAnalysisCandles = useMemo(() => marketSnapshot && dataset.source === 'live' ? closedMarketCandles(marketSnapshot) : candles, [marketSnapshot, dataset.source, candles]);
  const planTracking = useMemo<Record<string, PlanTrackingResult>>(() => Object.fromEntries(envelope && resultSnapshot
    ? envelope.analysis.tradeSetups.map(setup => [setup.id, evaluateTradePlan(setup, resultSnapshot.candles, availableAnalysisCandles,
      dataset.source === 'live' && marketSnapshot ? LIVE_INTERVAL_SECONDS[marketSnapshot.interval] : undefined)]) : []),
    [envelope, resultSnapshot, availableAnalysisCandles, dataset.source, marketSnapshot?.interval]);
  const ruleEvidence = useMemo(() => extractStructureEvidence(availableAnalysisCandles), [availableAnalysisCandles]);
  const ruleIndicators = ruleEvidence.indicators;
  const snapshotEvidence = useMemo(() => resultSnapshot ? extractStructureEvidence(resultSnapshot.candles) : ruleEvidence, [resultSnapshot, ruleEvidence]);
  const allEvidence = useMemo(() => analysis ? priceEvidence(analysis, resultSnapshot?.candles ?? availableAnalysisCandles, snapshotEvidence) : new Map(), [analysis, resultSnapshot, availableAnalysisCandles, snapshotEvidence]);
  const planEvidence = useMemo(() => Object.fromEntries((analysis?.tradeSetups ?? []).map(setup => [setup.id, planEvidenceSummary(setup, allEvidence, resultSnapshot?.candles ?? availableAnalysisCandles)])), [analysis, allEvidence, resultSnapshot, availableAnalysisCandles]);
  const indicatorZones = visibleRuleIndicatorZones(ruleIndicators, indicatorVisibility);
  useEffect(() => {
    if (selectedIndicatorId && !indicatorZones.some(zone => zone.id === selectedIndicatorId)) setSelectedIndicatorId(null);
  }, [selectedIndicatorId, indicatorZones]);
  const analysisCandles = selectionMode === 'auto' ? availableAnalysisCandles.slice(-MAX_ANALYSIS_CANDLES)
    : selectAnalysisCandles(availableAnalysisCandles, selectedRange);
  const missingRangeBoundary = selectionMode === 'manual' && selectedRange !== null
    && (!availableAnalysisCandles.some(candle => candle.timestamp === selectedRange.from) || !availableAnalysisCandles.some(candle => candle.timestamp === selectedRange.to));
  const rangeError = selectionMode === 'manual' && !selectedRange ? '请先在图表拖选 K 线范围。'
    : selectionMode === 'manual' && selectedRange && selectedRange.from > selectedRange.to ? '范围开始不能晚于结束，请调整起止 K 线。'
    : missingRangeBoundary ? '所选范围已移出当前行情窗口，请重新选择。'
    : analysisCandles.length < MIN_CANDLES ? `至少需要 ${MIN_CANDLES} 根${dataset.source === 'live' ? '已收盘 ' : ''}K 线，当前 ${analysisCandles.length} 根。`
    : analysisCandles.length > MAX_ANALYSIS_CANDLES ? `所选 ${analysisCandles.length} 根，最多允许 ${MAX_ANALYSIS_CANDLES} 根，请缩小范围。` : '';
  const canAnalyze = !rangeError;
  const snapshotStatus = resultSnapshot ? inspectAnalysisSnapshot(resultSnapshot, availableAnalysisCandles) : null;
  const hiddenEvidence = Boolean(envelope && analysis && (analysis.structures.length !== envelope.analysis.structures.length
    || getPAEvidence(analysis.priceAction).length !== getPAEvidence(envelope.analysis.priceAction).length
    || analysis.tradeSetups.length !== envelope.analysis.tradeSetups.length || analysis.liquiditySweeps.length !== envelope.analysis.liquiditySweeps.length));

  useEffect(() => {
    if (startup.mode === 'live') feed.connect(startup.query);
  }, [startup, feed.connect]);

  useEffect(() => {
    const controller = new AbortController();
    getHealth(controller.signal).then(result => {
      setHealth(result); setConnectionError(false);
      if (!sourceEdited.current) setAnalysisSource(result.activeProvider ?? (result.providers?.codex ? 'codex' : result.configured ? 'api' : 'mock'));
    }).catch(() => { if (!controller.signal.aborted) setConnectionError(true); });
    return () => controller.abort();
  }, []);
  useEffect(() => () => { controllerRef.current?.abort(); }, []);
  useEffect(() => {
    if (analysisTask.phase !== 'running' || !analysisTask.snapshot) return;
    const startedAt = analysisTask.snapshot.startedAt;
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [analysisTask]);
  useEffect(() => { setSelectedSetupId(null); setSelectedSweepId(null); setSelectedPAId(null); setSelectedKeyLevelIndex(null); }, [envelope]);
  useEffect(() => {
    if (!chartExpanded) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const exit = (event: KeyboardEvent) => { if (event.key === 'Escape') setChartExpanded(false); };
    window.addEventListener('keydown', exit);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', exit); };
  }, [chartExpanded]);
  function openPanel(nextPanel: 'import' | 'settings') { setPanel(nextPanel); setSymbolDraft(dataset.name); dialogRef.current?.showModal(); }
  function chooseSource(source: AnalysisSource) { sourceEdited.current = true; setAnalysisSource(source); }
  async function refreshHealth() {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    setCheckingHealth(true);
    try { const result = await getHealth(controller.signal); setHealth(result); setConnectionError(false); }
    catch { setConnectionError(true); }
    finally { window.clearTimeout(timeout); setCheckingHealth(false); }
  }
  function cancelAnalysis(report = true) {
    const controller = controllerRef.current;
    controllerRef.current = null;
    controller?.abort('cancelled');
    setBusy(false);
    if (report && controller) {
      setAnalysisTask(current => ({ ...current, phase: 'cancelled', message: '已停止本次请求，不会自动重试。' }));
      setNotice('分析已取消。');
    }
  }
  function resetAnalysisDataset(identity: string) {
    activeDatasetKey.current = identity;
    cancelAnalysis(false); setEnvelope(null); setResultSnapshot(null); setAnalysisTask({ phase: 'idle', snapshot: null, message: '' });
    setSelectedId(null); setSelectedSetupId(null); setSelectedSweepId(null); setSelectedPAId(null); setSelectedIndicatorId(null); setSelectedKeyLevelIndex(null);
    setSelectedRange(null); setIsSelectingRange(false); setError(''); setNotice('');
  }
  function disconnectMarket() {
    feed.stop(); previousMarketRef.current = null; setMarketSnapshot(null);
    const url = new URL(window.location.href); url.searchParams.delete('live'); url.searchParams.delete('interval'); url.searchParams.delete('demo'); window.history.replaceState(null, '', url);
  }
  function connectMarket(query: LiveMarketQuery) {
    fileGeneration.current++;
    const nextDataset: Dataset = { name: query.symbol, file: 'Binance USDⓈ-M', synthetic: false, timeframe: query.interval.toUpperCase(), source: 'live' };
    const nextIdentity = analysisDatasetKey(nextDataset);
    if (activeDatasetKey.current !== nextIdentity) {
      resetAnalysisDataset(nextIdentity); setCandles([]);
      setMarketSnapshot(null); previousMarketRef.current = null;
      setDataset(nextDataset);
      setNotice(''); setWarnings([]); setError('');
    }
    feed.connect(query);
  }
  function loadRealMarket() {
    if (marketSnapshot && dataset.source === 'live') feed.refresh();
    else connectMarket(initialQuery);
  }
  function changeLiveInterval(interval: LiveInterval) {
    if (marketSnapshot) connectMarket({ symbol: marketSnapshot.symbol, interval, limit: 300 });
  }
  function selectStructure(structure: Structure, source: 'chart' | 'list' = 'list') {
    setEvidenceFocusToken(value => value + 1);
    setChartLayers(current => ({ ...current, [['FVG', 'OB'].includes(structure.type) ? 'evidence' : 'primary']: true }));
    setSelectedKeyLevelIndex(null);
    setSelectedIndicatorId(null);
    setSelectedId(structure.id);
    setSelectedSetupId(null); setSelectedSweepId(null); setSelectedPAId(null);
    if (chartView === 'pa') setChartView('smc');
    if (!visibleTypes.includes(structure.type)) setVisibleTypes(v => [...v, structure.type]);
    if (structure.status === 'candidate') setShowCandidates(true);
    setTab('structures');
    if (source === 'list') chartPanelRef.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  function selectSetup(setup: TradeSetup, source: 'chart' | 'list' = 'list') {
    setChartLayers(current => ({ ...current, plans: true }));
    setSetupFocusToken(value => value + 1);
    setSelectedKeyLevelIndex(null);
    setSelectedIndicatorId(null);
    setSelectedSetupId(setup.id); setSelectedId(null); setSelectedSweepId(null); setSelectedPAId(null); setShowTradeSetups(true); setTab('opportunities');
    if (source === 'list') chartPanelRef.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  function selectSweep(sweep: LiquiditySweep, source: 'chart' | 'list' = 'list') {
    setEvidenceFocusToken(value => value + 1);
    setChartLayers(current => ({ ...current, evidence: true }));
    setSelectedKeyLevelIndex(null);
    setSelectedIndicatorId(null);
    setSelectedSweepId(sweep.id); setSelectedId(null); setSelectedSetupId(null); setSelectedPAId(null); setShowLiquiditySweeps(true); setTab('liquidity');
    if (chartView === 'pa') setChartView('smc');
    if (source === 'list') chartPanelRef.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  function selectPA(id: string, source: 'chart' | 'list' = 'list') {
    setSelectedKeyLevelIndex(null);
    setSelectedIndicatorId(null);
    const ruleLeg = ruleEvidence.legs.find(leg => leg.id === id);
    const evidence = getPAEvidence(chartPriceAction).find(entry => entry.item.id === id) ?? (ruleLeg ? { item: ruleLeg, layer: 'legs' as const } : undefined);
    if (!evidence) return;
    setEvidenceFocusToken(value => value + 1);
    setChartLayers(current => ({ ...current, [evidence.layer === 'patterns' ? 'evidence' : 'primary']: true }));
    setSelectedPAId(id); setSelectedId(null); setSelectedSetupId(null); setSelectedSweepId(null);
    if (chartView === 'smc') setChartView('pa');
    setVisiblePALayers(current => ({ ...current, [evidence.layer]: true, ...(evidence.layer === 'breakouts' ? { zones: true } : {}) }));
    if (evidence.item.status === 'candidate') setShowCandidates(true);
    setTab('pa');
    if (source === 'list') chartPanelRef.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  function changeChartView(view: typeof chartView) {
    setChartView(view);
    if (view === 'pa') { setSelectedId(null); setSelectedSweepId(null); }
    if (view === 'smc') setSelectedPAId(null);
  }
  function selectIndicator(id: string) {
    setEvidenceFocusToken(value => value + 1);
    setChartLayers(current => ({ ...current, evidence: true }));
    const zone = ruleIndicators.zones.find(item => item.id === id);
    if (!zone) return;
    setSelectedKeyLevelIndex(null);
    setSelectedIndicatorId(id);
    setSelectedId(null); setSelectedSetupId(null); setSelectedSweepId(null); setSelectedPAId(null);
    setIndicatorVisibility(current => ({ ...current, [zone.type]: true,
      history: current.history || zone.status === 'filled' || zone.status === 'invalidated' }));
  }
  function changeIndicatorVisibility(next: RuleIndicatorVisibility) {
    setIndicatorVisibility(next);
    if (!visibleRuleIndicatorZones(ruleIndicators, next).some(zone => zone.id === selectedIndicatorId)) setSelectedIndicatorId(null);
  }
  function selectKeyLevel(index: number, source: 'chart' | 'list' = 'list') {
    if (!Number.isInteger(index) || !analysis?.keyLevels[index]) return;
    setEvidenceFocusToken(value => value + 1);
    setChartLayers(current => ({ ...current, primary: true }));
    setSelectedKeyLevelIndex(index); setShowKeyLevels(true);
    setSelectedId(null); setSelectedSetupId(null); setSelectedSweepId(null); setSelectedPAId(null); setSelectedIndicatorId(null);
    if (source === 'list') chartPanelRef.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  function resetChart() {
    setSelectedKeyLevelIndex(null);
    setSelectedIndicatorId(null);
    setSelectedId(null); setSelectedSetupId(null); setSelectedSweepId(null); setSelectedPAId(null);
    setResetToken(value => value + 1);
  }
  function saveSettings() {
    const name = symbolDraft.trim();
    if (!name) { setError('请填写标的名称。'); return; }
    if (dataset.source === 'live' && name !== dataset.name) { setError('请在交易所行情栏切换真实合约标的。'); return; }
    if (name !== dataset.name) {
      resetAnalysisDataset(analysisDatasetKey({ ...dataset, name })); setDataset(v => ({ ...v, name }));
      setNotice('标的名称已更新，请重新分析以使用新的上下文。');
    }
    setError(''); dialogRef.current?.close();
  }

  async function importFile(file: File) {
    const generation = ++fileGeneration.current;
    setError('');
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('文件超过 2 MB，请裁剪为最多 2,000 根 K 线后重试。');
      if (!file.name.toLowerCase().endsWith('.csv')) throw new Error('请选择 .csv 格式的 OHLCV 文件。');
      const parsed = parseMarketCsv(await file.text());
      if (generation !== fileGeneration.current) return;
      disconnectMarket();
      const nextDataset: Dataset = { name: file.name.replace(/\.csv$/i, '').slice(0, 32), file: file.name, synthetic: false, timeframe: inferTimeframe(parsed.candles), source: 'csv' };
      resetAnalysisDataset(analysisDatasetKey(nextDataset));
      setCandles(parsed.candles);
      setDataset(nextDataset);
      setEnvelope(null); setSelectedId(null); setWarnings(parsed.warnings); setNotice(`已导入 ${parsed.candles.length} 根 K 线。点击「AI 分析」生成结构解读。`);
      setResetToken(v => v + 1); dialogRef.current?.close();
    } catch (e) { if (generation === fileGeneration.current) setError(e instanceof Error ? e.message : 'CSV 导入失败。'); }
  }
  function fileChange(event: ChangeEvent<HTMLInputElement>) { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ''; }
  function loadSample(pa = false) {
    disconnectMarket();
    const sample = pa ? PA_SAMPLE_CANDLES : SAMPLE_CANDLES;
    const nextDataset: Dataset = { name: pa ? 'PA / 教学示例' : 'BTC / USDT', file: pa ? 'pa-example.csv' : 'sample-ohlcv.csv', synthetic: true, timeframe: inferTimeframe(sample), source: 'sample' };
    fileGeneration.current++; resetAnalysisDataset(analysisDatasetKey(nextDataset)); setCandles(sample);
    setDataset(nextDataset);
    setEnvelope(sampleEnvelope(sample));
    setResultSnapshot(createAnalysisSnapshot(sample, analysisDatasetKey(nextDataset), 'mock'));
    setSelectedId(null); setSelectedPAId(null); setChartView('pa'); setTab('pa'); setWarnings([]); setError('');
    const url = new URL(window.location.href); url.searchParams.set('demo', pa ? 'pa' : 'smc'); window.history.replaceState(null, '', url);
    setNotice(pa ? '已加载 PA 合成教学行情：查看支撑阻力、突破回踩与 K 线形态。此数据不代表真实市场。' : '已恢复合成示例行情与模拟分析，可点击结构查看依据。'); setResetToken(v => v + 1); dialogRef.current?.close();
  }
  async function analyze() {
    if (!canAnalyze) return;
    setSelectedKeyLevelIndex(null);
    sourceEdited.current = true;
    cancelAnalysis(false);
    const controller = new AbortController(); controllerRef.current = controller;
    const snapshot = createAnalysisSnapshot(analysisCandles, activeDatasetKey.current, analysisSource, Date.now(), selectionMode);
    setAnalysisTask({ phase: 'running', snapshot, message: '' }); setElapsedSeconds(0); setIsSelectingRange(false);
    setBusy(true); setError(''); setNotice('');
    const timer = window.setTimeout(() => controller.abort('timeout'), 305_000);
    try {
      const rangeNotes = `本次${snapshot.selectionMode === 'manual' ? '手动选择' : '自动选择最近'} ${snapshot.candles.length} 根 K 线，范围 ${new Date(snapshot.candles[0].timestamp * 1000).toISOString()} 至 ${new Date(snapshot.asOf * 1000).toISOString()}（UTC 开盘时间），分析仅针对这份固定输入。`;
      const liveMarket = dataset.source === 'live' ? marketSnapshot : null;
      const contextNotes = (liveMarket ? `行情来源：Binance USDⓈ-M ${liveMarket.symbol}，周期 ${liveMarket.interval}，每根 K 线 ${LIVE_INTERVAL_SECONDS[liveMarket.interval]} 秒；仅分析已收盘 K 线；未收盘末根已排除。${liveMarket.symbol === 'SNDKUSDT' ? '这是跟踪 Sandisk 的股票永续合约。' : ''}数据获取于 ${liveMarket.fetchedAt}。` : '') + rangeNotes + notes;
      const result = await requestAnalysis(snapshot.candles, { symbol: dataset.name, timeframe: liveMarket?.interval ?? dataset.timeframe, notes: contextNotes }, snapshot.source === 'mock' ? 'mock' : 'ai', controller.signal, snapshot.source === 'mock' ? undefined : snapshot.source);
      if (controller.signal.aborted || controllerRef.current !== controller || activeDatasetKey.current !== snapshot.identity) return;
      setResultSnapshot(snapshot); setAnalysisTask({ phase: 'success', snapshot, message: '' });
      setEnvelope(result); setSelectedId(null); setNotice(`分析完成：${result.source === 'mock' ? '模拟结果' : result.provider === 'codex' ? 'Codex 额度分析' : 'API 模型分析'}，覆盖${snapshot.selectionMode === 'manual' ? '所选' : '最近'} ${result.analyzedBars} 根 K 线。`);
    } catch (e) {
      if (controllerRef.current !== controller || activeDatasetKey.current !== snapshot.identity) return;
      if (controller.signal.reason === 'timeout' || !controller.signal.aborted) {
        const message = controller.signal.reason === 'timeout' ? '分析请求超时，请检查模型服务后重试。' : e instanceof Error ? e.message : '分析失败，请重试。';
        setError(message); setAnalysisTask({ phase: 'error', snapshot, message });
      }
    } finally { window.clearTimeout(timer); if (controllerRef.current === controller) { controllerRef.current = null; setBusy(false); } }
  }
  function downloadAnalysis() {
    if (!envelope) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ dataset, inputSnapshot: resultSnapshot, ...envelope,
      ruleReview: { evidence: snapshotEvidence, providedReferenceIds: selectStructureReferences(snapshotEvidence).map(item => item.id), note: '确定性规则独立于模型；原始分析完整保留，显示过滤不改变导出。' },
      trackingReview: { evaluatedAt: new Date().toISOString(), basis: 'supplied-closed-candles',
        results: planTracking, closedCandles: availableAnalysisCandles,
        note: '快照之后行情条件的回放核验，不代表订单、成交或实际盈亏。' } }, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'structure-analysis.json'; a.click(); URL.revokeObjectURL(url);
  }

  const latest = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const change = latest && previous ? (latest.close / previous.close - 1) * 100 : null;
  const high = candles.length ? Math.max(...candles.map(c => c.high)) : null;
  const low = candles.length ? Math.min(...candles.map(c => c.low)) : null;
  const totalVolume = candles.reduce((sum, c) => sum + c.volume, 0);
  const structures = analysis?.structures ?? [];
  const displayed = structures.filter(s => visibleTypes.includes(s.type) && (showCandidates || s.status === 'confirmed'));
  const selected = [...structures, ...ruleEvidence.structures].find(s => s.id === selectedId);
  const confirmedCount = structures.filter(s => s.status === 'confirmed').length;
  const paEvidence = getPAEvidence(analysis?.priceAction);
  const confirmedPA = paEvidence.filter(({ item }) => item.status === 'confirmed').length;
  const displayedPA = paEvidence.filter(({ item }) => showCandidates || item.status === 'confirmed');
  const priceAction = analysis?.priceAction;
  const ruleMain = ruleEvidence.structures.filter(item => item.type !== 'FVG' && item.type !== 'OB');
  const chartStructures = chartStructureProjection([...ruleMain, ...(chartView !== 'pa' ? structures.filter(item => showCandidates || item.status === 'confirmed') : [])], chartLayers, selectedId);
  const basePA = priceAction ?? emptyPriceAction();
  const ruleLegs = ruleEvidence.legs.filter(item => item.importance === 'major');
  const chartPriceAction = { ...basePA, legs: chartLegProjection([...ruleLegs, ...basePA.legs], selectedPAId) };
  function selectReference(id: string) {
    const structure = [...structures, ...ruleEvidence.structures, ...snapshotEvidence.structures].find(item => item.id === id);
    if (structure && (structure.type === 'FVG' || structure.type === 'OB') && ruleIndicators.zones.some(item => item.id === id)) selectIndicator(id);
    else if (structure) selectStructure(structure);
    else selectPA(id);
  }
  const hasLegacyPAPlaceholder = priceAction?.summary === legacyPASummary && paEvidence.length === 0;
  const displayedPriceAction = !showCandidates ? {
    ...chartPriceAction,
    zones: chartPriceAction.zones.filter(item => item.status === 'confirmed'),
    legs: chartPriceAction.legs.filter(item => item.status === 'confirmed'),
    patterns: chartPriceAction.patterns.filter(item => item.status === 'confirmed'),
    breakouts: chartPriceAction.breakouts.filter(item => item.status === 'confirmed'),
  } : chartPriceAction;
  const paLayers: { layer: PALayer; label: string; count: number }[] = [
    { layer: 'zones', label: '支撑阻力 / 区间', count: priceAction?.zones.length ?? 0 },
    { layer: 'legs', label: '推进 / 回撤', count: priceAction?.legs.length ?? 0 },
    { layer: 'patterns', label: 'K 线形态', count: priceAction?.patterns.length ?? 0 },
    { layer: 'breakouts', label: '突破 / 回踩', count: priceAction?.breakouts.length ?? 0 },
  ];
  const sourceStatus = connectionError ? '后端服务未连接，请检查服务后重试。'
    : analysisSource === 'mock' ? '本地规则模拟 · 不消耗模型额度'
    : !health ? '正在检查模型连接…'
    : analysisSource === 'codex' ? health.codex?.authenticated ? 'ChatGPT 登录已验证 · 使用 Codex 额度' : health.codex?.message || 'Codex 未连接，请在模型设置中查看登录状态。'
    : (health.providers?.api ?? (health.configured && health.provider === 'openai-compatible')) ? '服务端 API Key 已配置 · API 单独计费' : 'API Key 未配置，请在服务端配置。';
  const provenance = envelope?.source === 'mock' ? '规则模拟，非模型判断' : envelope?.provider === 'codex' ? `Codex 额度 · ${envelope.model}` : `API 模型 · ${envelope?.model ?? ''}`;
  const resultSource = !envelope ? `下一次：${sourceNames[analysisSource]}` : envelope.source === 'mock' ? '当前结果：模拟分析' : envelope.provider === 'codex' ? '当前结果：Codex 额度' : '当前结果：API 模型';
  const taskStatusProps = { task: analysisTask, resultSnapshot, stale: snapshotStatus?.stale ?? false, hiddenEvidence, elapsedSeconds, onCancel: () => cancelAnalysis() };
  function updateRangeBoundary(boundary: 'from' | 'to', timestamp: number) {
    if (!Number.isFinite(timestamp) || !availableAnalysisCandles.some(candle => candle.timestamp === timestamp)) return;
    setSelectedRange(current => ({ from: boundary === 'from' ? timestamp : current?.from ?? availableAnalysisCandles[0]?.timestamp ?? timestamp,
      to: boundary === 'to' ? timestamp : current?.to ?? availableAnalysisCandles.at(-1)?.timestamp ?? timestamp }));
    setIsSelectingRange(false);
  }

  return <div className="app-shell">
    <a href="#workspace" className="skip-link">跳转到工作台</a>
    <aside className="nav-rail" aria-label="主导航">
      <div className="brand-mark"><ChartLineUp size={28} weight="bold" /></div>
      <div className="rail-items">
        <button className="rail-button active" aria-label="行情分析工作台" title="行情分析工作台" onClick={() => document.getElementById('workspace')?.scrollIntoView({ behavior: 'smooth' })}><ChartLine size={23}/></button>
        <button className="rail-button" aria-label="导入行情数据" title="行情数据" onClick={() => openPanel('import')}><Database size={22}/></button>
      </div>
      <button className="rail-button rail-bottom" aria-label="模型与设置" title="模型与设置" onClick={() => openPanel('settings')}><GearSix size={22}/></button>
      <span className="rail-avatar" title="本地研究空间">L</span>
    </aside>

    <div className="app-body">
      <header className="topbar">
        <a className="wordmark" href="#workspace">STRUCTURE<span className="wordmark-slash">/</span><span className="wordmark-sub">TRADING ASSISTANT</span></a>
        <div className="topbar-meta"><span className="local-label"><span className="status-dot"/>本地研究空间</span><span className="vertical-separator"/><span className="muted">PA / SMC</span><span className="version-label">MVP</span></div>
      </header>
      <main id="workspace">
        <section className="workspace-heading">
          <div><div className="eyebrow">MARKET INTELLIGENCE</div><h1>看见价格背后的结构<span className="heading-dot">.</span></h1><p>从行情数据到结构解读，让每一个判断有迹可循。</p></div>
          <div className="heading-actions">
            <button className="button secondary" onClick={loadRealMarket} disabled={feed.loading || feed.refreshing}><Database size={17}/>{marketSnapshot && dataset.source === 'live' ? '刷新真实行情' : '加载真实行情'}</button>
            <button className="button secondary" onClick={() => openPanel('import')}><UploadSimple size={17}/>导入 CSV</button>
            <button className="button primary" onClick={() => void analyze()} disabled={busy || !canAnalyze}><Lightning size={17} weight="fill" className={busy ? 'hide' : ''}/>{busy && <SpinnerGap size={17} className="spin"/>}{busy ? '正在分析…' : 'AI 分析'}<span className="button-shortcut">↗</span></button>
          </div>
        </section>

        <div className="analysis-source-bar" aria-label="分析服务连接">
          <label htmlFor="analysis-source">分析来源</label><select id="analysis-source" value={analysisSource} disabled={busy} onChange={event => chooseSource(event.target.value as AnalysisSource)}><option value="codex">Codex 额度</option><option value="api">API Key</option><option value="mock">模拟分析</option></select>
          <span className="analysis-source-status">{sourceStatus}</span><button className="button text-button" onClick={() => openPanel('settings')}><GearSix size={14}/>模型设置</button>
        </div>

        <ResearchWorkbench symbol={dataset.name} source={dataset.source} candles={availableAnalysisCandles} timeframe={dataset.timeframe} marketSnapshot={marketSnapshot} analysisSource={analysisSource} notes={notes}/>

        {(error || notice || warnings.length > 0) && <div className={`feedback ${error ? 'feedback-error' : ''}`} role={error ? 'alert' : 'status'}>
          {error ? <WarningCircle size={18}/> : <CheckCircle size={18}/>}<div>{error || notice}{warnings.map((w, i) => <p key={i}>{w}</p>)}</div><button aria-label="关闭提示" onClick={() => { setError(''); setNotice(''); setWarnings([]); }}><X size={16}/></button>
        </div>}

        <LiveMarketControls initialQuery={initialQuery} snapshot={marketSnapshot} loading={feed.loading} refreshing={feed.refreshing} error={feed.error} autoRefresh={feed.autoRefresh} connected={Boolean(feed.query)} onAutoRefresh={feed.setAutoRefresh} onConnect={connectMarket} onRefresh={feed.refresh} transport={feed.transport} lastEventTime={feed.lastEventTime} streamMessage={feed.streamMessage}/>

        <section className="market-strip" aria-label="行情概览">
          <div className="instrument"><div className="instrument-icon"><ChartLineUp size={24}/></div><div><div className="instrument-name">{dataset.name}<span className="interval">{dataset.timeframe}</span></div><div className="instrument-meta">{dataset.source === 'live' ? 'Binance · USDT 永续' : dataset.synthetic ? '合成示例数据' : 'CSV 本地导入'}<span>·</span>{candles.length} 根 K 线<span>·</span>UTC</div></div></div>
          <div className="market-stat price-stat"><span>{!latest ? '等待交易所行情' : dataset.source === 'live' && !marketSnapshot?.lastCandleClosed ? '最新成交价 · 未收盘' : '最新收盘价'}</span><strong>{latest ? money(latest.close) : '—'}</strong></div>
          <div className={`market-stat ${change === null ? '' : change >= 0 ? 'positive' : 'negative'}`}><span>较前一根</span><strong>{change === null ? '—' : <>{change >= 0 ? <ArrowUp size={14}/> : <ArrowDown size={14}/>} {Math.abs(change).toFixed(2)}%</>}</strong></div>
          <div className="market-stat range-stat"><span>样本最高 / 最低</span><strong>{high === null || low === null ? '—' : <>{money(high)}<i>/</i>{money(low)}</>}</strong></div>
          <div className="market-stat volume-stat"><span>样本成交量</span><strong>{candles.length ? compact(totalVolume) : '—'}</strong></div>
        </section>

        <div className={`workspace-grid ${chartExpanded ? 'chart-expanded' : ''}`}>
          <section ref={chartPanelRef} className="chart-panel panel" aria-label="价格与结构图表">
            <div className="panel-toolbar chart-topbar"><div className="panel-title"><ChartLine size={19}/><h2>行情图表</h2></div><div className="chart-intervals" aria-label="图表周期">{dataset.source === 'live' ? LIVE_INTERVALS.map(interval => <button key={interval} aria-label={`切换到 ${interval} 周期`} aria-pressed={marketSnapshot?.interval === interval} disabled={feed.loading} onClick={() => changeLiveInterval(interval)}>{interval.toUpperCase()}</button>) : <span>{dataset.timeframe}</span>}</div><div className="chart-tools"><span className={`chart-connection ${feed.transport === 'streaming' && dataset.source === 'live' ? 'is-streaming' : ''}`}>{dataset.source === 'live' ? feed.transport === 'streaming' ? '实时' : feed.transport === 'paused' ? '已暂停' : '同步中' : dataset.synthetic ? 'DEMO' : 'CSV'}</span><button className="icon-button" aria-label="重置图表视图" title="显示近期 K 线" onClick={resetChart}><Pulse size={17}/></button><button className="icon-button" aria-label={chartExpanded ? '退出专注图表' : '专注图表'} aria-pressed={chartExpanded} title="切换专注图表" onClick={() => setChartExpanded(v => !v)}><ArrowsOutSimple size={17}/></button></div></div>
            <AnalysisStatus {...taskStatusProps} compact/>
            {envelope && resultSnapshot && <AnalysisCoverage analysis={envelope.analysis} candles={resultSnapshot.candles}/>}
            <div className="analysis-range-toolbar" aria-label="分析 K 线范围">
              <div className="analysis-range-mode" role="group" aria-label="分析范围方式"><button aria-label="自动范围" aria-pressed={selectionMode === 'auto'} disabled={busy} onClick={() => { setSelectionMode('auto'); setIsSelectingRange(false); }}>自动范围</button><button aria-label="手动范围" aria-pressed={selectionMode === 'manual'} disabled={busy} onClick={() => { setSelectionMode('manual'); setIsSelectingRange(false); }}>手动范围</button></div>
              {selectionMode === 'auto' ? <span>自动 · 最近最多 {MAX_ANALYSIS_CANDLES} 根{dataset.source === 'live' ? '已收盘 ' : ''}K 线</span> : <button className={`range-drag-button ${isSelectingRange ? 'is-active' : ''}`} aria-label="在图表拖选范围" aria-pressed={isSelectingRange} disabled={busy || !availableAnalysisCandles.length} onClick={() => setIsSelectingRange(value => !value)}>{isSelectingRange ? '正在框选 · 再点退出' : '在图表拖选范围'}</button>}
              <button className="range-drag-button range-analyze-button" aria-label="分析当前 K 线范围" disabled={busy || !canAnalyze} onClick={() => void analyze()}>{busy ? '正在分析…' : selectionMode === 'manual' ? '分析所选范围' : '分析当前范围'}</button>
              {selectionMode === 'manual' && <div className="analysis-range-inputs"><label>范围开始 UTC<select aria-label="范围开始 UTC" value={selectedRange?.from ?? ''} disabled={busy || !availableAnalysisCandles.length} onChange={event => updateRangeBoundary('from', Number(event.target.value))}><option value="" disabled>选择起始 K 线</option>{availableAnalysisCandles.map(candle => <option key={candle.timestamp} value={candle.timestamp}>{new Date(candle.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 16)}</option>)}</select></label><label>范围结束 UTC<select aria-label="范围结束 UTC" value={selectedRange?.to ?? ''} disabled={busy || !availableAnalysisCandles.length} onChange={event => updateRangeBoundary('to', Number(event.target.value))}><option value="" disabled>选择结束 K 线</option>{availableAnalysisCandles.map(candle => <option key={candle.timestamp} value={candle.timestamp}>{new Date(candle.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 16)}</option>)}</select></label></div>}
              <div className={`analysis-range-summary ${rangeError ? 'has-error' : ''}`}>{rangeError || `将分析 ${analysisCandles.length} 根 K 线 · ${date(analysisCandles[0].timestamp)} 至 ${date(analysisCandles.at(-1)!.timestamp)} UTC`}{selectionMode === 'manual' && <small>起止均为实际 K 线开盘时间 · 允许 {MIN_CANDLES}–{MAX_ANALYSIS_CANDLES} 根{dataset.source === 'live' ? '已收盘 K 线' : ' K 线'}</small>}</div>
            </div>
            <div className="hierarchy-layer-bar" role="group" aria-label="视觉层级显示开关">{([{ key: 'primary', label: '主结构', hint: '摆点、破位、趋势腿与支撑阻力' }, { key: 'evidence', label: '辅助证据', hint: 'FVG / OB、扫除与烛线形态' }, { key: 'plans', label: '交易计划', hint: '条件入场、风险区域与目标' }] as const).map(layer => <label key={layer.key} title={layer.hint}><input type="checkbox" aria-label={layer.label} checked={chartLayers[layer.key]} onChange={event => setChartLayers(current => ({ ...current, [layer.key]: event.target.checked }))}/><b>{layer.label}</b><small>{layer.hint}</small></label>)}</div>
            <div className="chart-view-toolbar"><div className="chart-view-switch" role="group" aria-label="分析视图"><button aria-pressed={chartView === 'pa'} onClick={() => changeChartView('pa')}>PA 主视图</button><button aria-pressed={chartView === 'smc'} onClick={() => changeChartView('smc')}>SMC 主视图</button><button aria-pressed={chartView === 'combined'} onClick={() => changeChartView('combined')}>叠加</button></div><span className="chart-view-description">{chartView === 'pa' ? '价格行为 · 区域、路径与形态' : chartView === 'smc' ? '市场结构 · 破位、缺口与订单块' : 'PA × SMC · 共同依据'}</span></div>
            {chartView !== 'smc' && <div className="pa-layer-bar" aria-label="PA 图层显示开关"><span className="filter-caption">PA</span>{paLayers.map(({ layer, label, count }) => <label key={layer}><input type="checkbox" checked={visiblePALayers[layer]} onChange={event => setVisiblePALayers(current => ({ ...current, [layer]: event.target.checked }))}/><span className={`pa-layer-swatch ${layer}`}/>{label}<small>{count}</small></label>)}</div>}
            {chartView !== 'pa' && <div className="filter-bar" aria-label="结构显示开关"><span className="filter-caption">SMC</span><div className="filter-chips">{STRUCTURE_TYPES.map(type => <button key={type} className={`filter-chip type-${type.toLowerCase()} ${visibleTypes.includes(type) ? 'enabled' : ''}`} aria-pressed={visibleTypes.includes(type)} title={structureNames[type]} onClick={() => setVisibleTypes(v => v.includes(type) ? v.filter(t => t !== type) : [...v, type])}><span className="chip-indicator"/>{type}</button>)}</div></div>}
            <div className="advanced-layer-bar" aria-label="辅助分析图层"><label><input type="checkbox" checked={showTradeSetups} onChange={event => setShowTradeSetups(event.target.checked)}/><span className="advanced-layer-swatch trade-swatch"/>开仓候选 / 盈亏区间<span className="advanced-layer-count">{analysis?.tradeSetups.length ?? 0}</span></label>{chartView !== 'pa' && <label><input type="checkbox" checked={showLiquiditySweeps} onChange={event => setShowLiquiditySweeps(event.target.checked)}/><span className="advanced-layer-swatch sweep-swatch"/>流动性扫除<span className="advanced-layer-count">{analysis?.liquiditySweeps.length ?? 0}</span></label>}<label><input type="checkbox" checked={showKeyLevels} onChange={event => { setShowKeyLevels(event.target.checked); if (!event.target.checked) setSelectedKeyLevelIndex(null); }}/><span className="advanced-layer-swatch key-level-swatch"/>关键价位<span className="advanced-layer-count">{analysis?.keyLevels.length ?? 0}</span></label></div>
            <TradePlanStatus tracking={planTracking} rawAnalysis={envelope?.analysis} analysis={analysis} snapshot={resultSnapshot} selectedId={selectedSetupId} layerVisible={showTradeSetups && chartLayers.plans} onSelect={setup => selectSetup(setup, 'chart')} onOpenDetails={() => setTab('opportunities')}/>
            <RuleIndicatorsPanel snapshot={ruleIndicators} visibility={indicatorVisibility} onVisibilityChange={changeIndicatorVisibility} selectedId={selectedIndicatorId} onSelect={selectIndicator}/>
            {candles.length > 0 ? (
            <TradingChart evidenceFocusToken={evidenceFocusToken} tradeTracking={planTracking} candles={candles} indicatorZones={chartLayers.evidence ? indicatorZones : []} selectedIndicatorId={selectedIndicatorId} onSelectIndicator={selectIndicator}
              keyLevels={analysis?.keyLevels ?? []} showKeyLevels={showKeyLevels && chartLayers.primary} selectedKeyLevelIndex={selectedKeyLevelIndex} onSelectKeyLevel={index => selectKeyLevel(index, 'chart')}
              structures={chartStructures} visibleTypes={visibleTypes} selectedId={selectedId} onSelect={id => { const s = chartStructures.find(item => item.id === id); if (s) selectStructure(s, 'chart'); }} priceAction={displayedPriceAction} visiblePALayers={{ zones: visiblePALayers.zones && chartLayers.primary, legs: visiblePALayers.legs && chartLayers.primary, patterns: visiblePALayers.patterns && chartLayers.evidence, breakouts: visiblePALayers.breakouts && chartLayers.primary }} showPA={chartView !== 'smc'} showSMC={true} selectedPAId={selectedPAId} onSelectPA={id => selectPA(id, 'chart')} tradeSetups={analysis?.tradeSetups ?? []} liquiditySweeps={analysis?.liquiditySweeps ?? []} showTradeSetups={showTradeSetups && chartLayers.plans} showLiquiditySweeps={showLiquiditySweeps && chartView !== 'pa' && chartLayers.evidence} selectedSetupId={selectedSetupId} setupFocusToken={setupFocusToken} selectedSweepId={selectedSweepId} onSelectSetup={id => { const setup = analysis?.tradeSetups.find(item => item.id === id); if (setup) selectSetup(setup, 'chart'); }} onSelectSweep={id => { const sweep = analysis?.liquiditySweeps.find(item => item.id === id); if (sweep) selectSweep(sweep, 'chart'); }} resetToken={resetToken} datasetKey={`${dataset.source}:${dataset.name}:${dataset.timeframe}:${dataset.file}`} symbol={dataset.name} timeframe={dataset.timeframe} exchange={dataset.source === 'live' ? 'BINANCE' : dataset.synthetic ? '合成示例' : 'CSV'} rangeSelectionEnabled={selectionMode === 'manual' && isSelectingRange} selectedRange={selectionMode === 'manual' ? selectedRange : null} onSelectRange={range => { if (!busy) { setSelectedRange(range); setIsSelectingRange(false); } }} selectableCandles={availableAnalysisCandles} selectionDisabled={busy}/>
            ) : <div className="empty-state" role="status" aria-label="真实行情等待状态">{feed.error ? <WarningCircle size={32}/> : <SpinnerGap size={32} className="spin"/>}<h3>{feed.error ? '真实行情暂不可用' : '正在连接真实行情…'}</h3><p>{feed.error ? '请检查网络连接并重试。当前没有可显示的真实行情。' : `正在获取 ${dataset.name} · ${dataset.timeframe} 的交易所 K 线。`}</p><button className="button secondary" onClick={loadRealMarket} disabled={feed.loading}>{feed.loading ? '连接中…' : '重试真实行情'}</button></div>}
            <EvidenceCoverage evidence={snapshotEvidence} analysis={envelope?.analysis} projected={analysis}/>
            <EvidenceDetails item={selected} price={selectedPAId ? allEvidence.get(selectedPAId) ?? (() => { const leg = ruleEvidence.legs.find(item => item.id === selectedPAId); return leg ? { id: leg.id, rationale: leg.rationale, invalidation: leg.invalidation, low: Math.min(leg.startPrice, leg.endPrice), high: Math.max(leg.startPrice, leg.endPrice), direction: leg.direction, type: '规则主要趋势腿', source: 'deterministic' as const, familyId: leg.familyId, timing: leg.timing, anchorEligible: false } : undefined; })() : undefined} candles={resultSnapshot?.candles ?? availableAnalysisCandles} evidence={selected?.id.startsWith('rule-') ? ruleEvidence : snapshotEvidence}/>
            {selectedPAId?.startsWith('rule-leg') && <p className="rule-leg-explainer">{ruleEvidence.legs.find(item => item.id === selectedPAId)?.rationale} {ruleEvidence.legs.find(item => item.id === selectedPAId)?.invalidation}</p>}
            <div className="chart-footer"><span className="chart-status-legend">{chartView === 'smc' ? <><span className="line-sample"/>已确认结构<span className="line-sample dashed"/>候选结构</> : <>区域为价格带 · 回撤为虚线路径 · ◇为候选</>}</span><label className="candidate-switch"><input type="checkbox" checked={showCandidates} onChange={e => setShowCandidates(e.target.checked)}/><span className="switch-track"/>显示候选</label><span className="chart-hint">滚轮缩放 · 拖拽平移</span></div>
          </section>

          <aside className="analysis-panel panel" aria-label="分析结果面板">
            <div className="panel-toolbar"><div className="panel-title"><Lightning size={18}/><h2>结构解读</h2></div><span className={`source-badge ${envelope?.source === 'ai' ? 'source-ai' : ''}`}>{envelope?.source === 'ai' ? envelope.provider === 'codex' ? 'Codex 分析' : 'API 分析' : envelope ? '模拟分析' : '待分析'}</span></div>
            <AnalysisStatus {...taskStatusProps}/>
            {analysis ? <div className="analysis-content">
              <div className="analysis-heading"><span className="eyebrow">MARKET BIAS</span><span className={`bias-badge ${analysis.bias}`}>{analysis.bias === 'bullish' ? <ArrowUpRight size={15}/> : analysis.bias === 'bearish' ? <ArrowDown size={15}/> : <Pulse size={15}/>} {directionText[analysis.bias]}</span></div>
              <h3 className="analysis-title">{hasLegacyPAPlaceholder ? 'PA 待分析' : <>{paRegimeNames[analysis.priceAction.regime]}<span className="pa-regime-label">PA 价格行为</span></>}</h3>
              <p className="pa-regime-summary">{analysis.priceAction.summary}</p>
              <p className="analysis-summary">{analysis.summary}</p>
              <div className="analysis-counts"><div><strong>{paEvidence.length.toString().padStart(2, '0')}</strong><span>PA 依据 · 已观察 {confirmedPA}</span></div><div><strong>{structures.length.toString().padStart(2, '0')}</strong><span>SMC 结构 · 已确认 {confirmedCount}</span></div><div><strong>{envelope?.analyzedBars}</strong><span>分析 K 线</span></div></div>
              <ResearchStages analysis={analysis} onReference={selectReference}/>
              <div className="section-caption"><h3>关键价位</h3><span>KEY LEVELS</span></div>
              <div className="key-levels">{analysis.keyLevels.length === 0 ? <p className="muted">本次未给出关键价位。</p> : analysis.keyLevels.map((level, i) => <button id={`key-level-${i}`} type="button" className={`key-level ${selectedKeyLevelIndex === i ? 'is-selected' : ''}`} key={`${level.label}-${i}`} aria-pressed={selectedKeyLevelIndex === i} aria-label={`定位关键价位 ${i + 1}：${level.label}，${money(level.price)}`} onClick={() => selectKeyLevel(i)}><span className="level-index">{String(i + 1).padStart(2, '0')}</span><div><span>{level.label}</span><small>{level.reason}</small></div><strong>{money(level.price)}</strong></button>)}</div>
              <div className="uncertainty-box"><div><ShieldCheck size={17}/><h3>不确定性与风险</h3></div><ul>{analysis.uncertainties.map((risk, i) => <li key={i}>{risk}</li>)}</ul></div>
              <div className="analysis-provenance"><CheckCircle size={13}/>Schema 校验通过<span>·</span>{provenance}{envelope?.analysisAttempts === 2 && <><span>·</span>已修正 1 次 · 共调用模型 2 次{envelope.usage && '，用量含两次调用'}</>}</div>
              {envelope?.usage && <div className="analysis-usage" aria-label="本次模型用量">本次用量：输入 {envelope.usage.inputTokens.toLocaleString()} · 缓存 {envelope.usage.cachedInputTokens.toLocaleString()} · 输出 {envelope.usage.outputTokens.toLocaleString()} tokens</div>}
            </div> : <div className="empty-state"><MagnifyingGlass size={32}/><h3>{busy ? '正在解读行情快照' : canAnalyze ? '准备好探索结构了吗？' : '等待分析范围就绪'}</h3><p>{busy ? '分析期间可以继续查看实时图表，进度与取消按钮就在上方。' : canAnalyze ? '数据已就绪。点击「AI 分析」，查看结构、观察条件与风险依据。' : rangeError}</p><button className="button primary" onClick={() => void analyze()} disabled={busy || !canAnalyze}>{busy ? <><SpinnerGap size={16} className="spin"/>正在分析…</> : <>开始分析<ArrowUpRight size={16}/></>}</button></div>}
          </aside>

          <section className="evidence-panel panel" aria-label="结构依据与观察计划">
            <div className="evidence-toolbar"><div className="tabs" role="tablist" aria-label="分析详情"><button id="pa-tab" role="tab" aria-controls="evidence-content" aria-selected={tab === 'pa'} className={tab === 'pa' ? 'selected' : ''} onClick={() => setTab('pa')}>PA 价格行为<span>{displayedPA.length}</span></button><button id="structures-tab" role="tab" aria-controls="evidence-content" aria-selected={tab === 'structures'} className={tab === 'structures' ? 'selected' : ''} onClick={() => setTab('structures')}>结构依据<span>{displayed.length}</span></button><button id="opportunities-tab" role="tab" aria-controls="evidence-content" aria-selected={tab === 'opportunities'} className={tab === 'opportunities' ? 'selected' : ''} onClick={() => setTab('opportunities')} aria-label={`潜在观察计划：开仓计划 ${analysis?.tradeSetups.length ?? 0} · 文字观察 ${analysis?.opportunities.length ?? 0}`}>开仓计划<span>{analysis?.tradeSetups.length ?? 0}</span><small className="text-observation-count">文字观察 {analysis?.opportunities.length ?? 0}</small></button><button id="liquidity-tab" role="tab" aria-controls="evidence-content" aria-selected={tab === 'liquidity'} className={tab === 'liquidity' ? 'selected' : ''} onClick={() => setTab('liquidity')}>流动性扫除<span>{analysis?.liquiditySweeps.length ?? 0}</span></button></div><button className="button text-button export-analysis" aria-label="导出 JSON" onClick={downloadAnalysis} disabled={!envelope}><DownloadSimple size={15}/><span>导出 JSON</span></button></div>
            <div id="evidence-content" role="tabpanel" aria-labelledby={`${tab}-tab`}>
              {tab === 'pa' ? <PriceActionPanel priceAction={analysis?.priceAction} candles={candles} selectedId={selectedPAId} showCandidates={showCandidates} onSelect={id => selectPA(id)}/> : tab === 'structures' ? <>
                <RuleStructurePanel evidence={ruleEvidence} selectedId={selectedId} onSelect={selectStructure} onSelectLeg={selectPA}/>
                <div className="evidence-intro"><span><Info size={14}/>点击条目，定位图表中的时间与价格</span><span>{selected ? `已定位 ${selected.type} · ${date(selected.startTime)} UTC` : '实线已确认 / 虚线候选'}</span></div>
                <div className="structure-list">{displayed.length === 0 ? <div className="list-empty">{analysis ? '当前图层下没有结构。可开启其他类型或显示候选结构。' : '完成分析后，结构与识别依据将在这里展示。'}</div> : displayed.map(s => <button id={`structure-${s.id}`} key={s.id} className={`structure-row ${selectedId === s.id ? 'is-selected' : ''}`} onClick={() => selectStructure(s)} aria-label={`定位 ${s.type} ${structureNames[s.type]}`} aria-pressed={selectedId === s.id}>
                  <div className="structure-type"><span className={`type-badge type-${s.type.toLowerCase()}`}>{s.type}</span><span className="structure-long-name">{structureNames[s.type]}</span></div>
                  <div className="structure-evidence"><p>{s.rationale}</p><small><span>失效条件</span>{s.invalidation}</small></div>
                  <div className="structure-price"><strong>{money(s.price)}</strong>{s.priceEnd !== null && <small>– {money(s.priceEnd)}</small>}<time>{date(s.startTime)}</time></div>
                  <span className={`confirmation ${s.status}`}>{s.status === 'confirmed' ? <Check size={12}/> : <Clock size={12}/>} {s.status === 'confirmed' ? '已确认' : '候选'}</span><ArrowUpRight className="row-arrow" size={17}/>
                </button>)}</div>
              </> : tab === 'opportunities' ? <div className="opportunity-list"><TradePlans evidenceSummary={planEvidence} ruleStructures={ruleEvidence.structures} onSelectReference={selectReference} tracking={planTracking} analysis={analysis} rawAnalysis={envelope?.analysis} selectedId={selectedSetupId} onSelect={setup => selectSetup(setup)} onSelectStructure={selectStructure} onSelectPA={id => selectPA(id)}/><p className="opportunity-intro"><Info size={15}/>以下是有条件的观察情景，需要后续行情确认。</p>{analysis?.opportunities.length ? analysis.opportunities.map((op, i) => <article className="opportunity" key={op.id}><div className="opportunity-heading"><h3>观察情景 {String(i + 1).padStart(2, '0')}</h3><span className={`bias-badge ${op.direction}`}>{directionText[op.direction]} · 待确认</span></div><dl><div><dt>触发条件</dt><dd>{op.trigger}</dd></div><div><dt>失效条件</dt><dd>{op.invalidation}</dd></div><div><dt>目标观察</dt><dd>{op.target}</dd></div><div><dt>风险说明</dt><dd>{op.risk}</dd></div></dl><div className="related-structures">{op.structureIds.map(id => { const s = [...structures, ...ruleEvidence.structures].find(item => item.id === id); const pa = paEvidence.find(entry => entry.item.id === id); return s ? <button key={id} onClick={() => selectStructure(s)}>定位 {s.type}<ArrowUpRight size={13}/></button> : pa ? <button key={id} onClick={() => selectPA(id)}>定位 PA · {pa.item.title}<ArrowUpRight size={13}/></button> : null; })}</div></article>) : <div className="list-empty">本次没有观察计划。等待更多数据确认。</div>}</div> : <LiquiditySweeps sweeps={analysis?.liquiditySweeps ?? []} hasAnalysis={Boolean(analysis)} selectedId={selectedSweepId} onSelect={sweep => selectSweep(sweep)}/>}
            </div>
          </section>
        </div>

        <footer className="workspace-footer"><span><ShieldCheck size={14}/>仅用于行情研究。AI 与模拟判断均可能出错，不构成交易指令。</span><span>{candles.length && latest ? `${date(candles[0].timestamp)} 至 ${date(latest.timestamp)} UTC` : '尚未收到交易所行情'}<span className="footer-dot">·</span>{connectionError ? '后端服务未连接' : `${resultSource} · 手动分析`}</span></footer>
      </main>
    </div>

    <input ref={fileRef} type="file" accept=".csv,text/csv" className="visually-hidden" onChange={fileChange} aria-label="上传 OHLCV CSV"/>
    <dialog ref={dialogRef} className="settings-dialog" onClick={e => { if (e.target === e.currentTarget) dialogRef.current?.close(); }}>
      <div className="dialog-heading"><div><span className="eyebrow">WORKSPACE</span><h2>{panel === 'import' ? '导入行情数据' : '模型与分析设置'}</h2></div><button className="icon-button" aria-label="关闭窗口" onClick={() => dialogRef.current?.close()}><X size={20}/></button></div>
      {panel === 'import' ? <>
        <button className="upload-area" onClick={() => fileRef.current?.click()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const file = e.dataTransfer.files[0]; if (file) void importFile(file); }}><div className="upload-icon"><UploadSimple size={28}/></div><strong>拖拽 CSV 到这里，或点击选择文件</strong><span>最多 {MAX_CANDLES.toLocaleString()} 根 K 线 · 文件上限 2 MB</span></button>
        <div className="csv-guide"><div><FileCsv size={18}/><h3>OHLCV 数据格式</h3></div><code>timestamp,open,high,low,close,volume</code><p>时间需严格递增，支持 Unix 秒 / 毫秒或带时区的 ISO 8601。缺失值、重复时间和不合法的价格会被拒绝；不会自动填补行情。</p><a href="/sample-ohlcv.csv" download><DownloadSimple size={16}/>下载合成示例 CSV</a><a href="/pa-example.csv" download><DownloadSimple size={16}/>下载 PA 教学 CSV</a></div>
        <div className="current-dataset"><Database size={19}/><div><strong>{dataset.file}</strong><span>当前数据 · {candles.length} 根 · {dataset.timeframe} · UTC</span></div><span className="source-badge">{dataset.synthetic ? '合成数据' : dataset.source === 'live' ? candles.length ? '交易所行情' : '等待连接' : '已导入'}</span></div>
        <div className="sample-choice"><button className="button secondary full-width" onClick={() => loadSample(true)}><Pulse size={17}/>加载 PA 教学示例与模拟分析</button><button className="button secondary full-width" onClick={() => loadSample()}><ChartLine size={17}/>加载示例数据与模拟分析</button></div>
      </> : <><div className="connection-card"><span className={`status-dot ${health?.codex?.authenticated ? '' : 'status-muted'}`}/><div><strong>{health?.codex?.authenticated ? 'Codex 订阅已连接' : connectionError ? '后端服务未连接' : 'Codex 登录状态'}</strong><span>{health?.codex?.message || '正在检查本机 Codex 与 ChatGPT 登录状态。'}</span></div><button className="button text-button" disabled={checkingHealth} onClick={() => void refreshHealth()}>{checkingHealth ? '检查中…' : '刷新状态'}</button></div><label className="field-label" htmlFor="symbol-name">标的名称</label><input className="text-field" id="symbol-name" readOnly={dataset.source === 'live'} maxLength={60} value={symbolDraft} onChange={e => setSymbolDraft(e.target.value)} /><label className="field-label" htmlFor="analysis-mode">分析模式</label><select id="analysis-mode" value={analysisSource} disabled={busy} onChange={e => chooseSource(e.target.value as AnalysisSource)}><option value="codex">Codex 额度：使用本机 ChatGPT 登录</option><option value="api">API Key：使用服务端配置，API 单独计费</option><option value="mock">模拟分析：本地规则，不消耗模型额度</option></select><label className="field-label" htmlFor="analysis-notes">分析上下文（可选）</label><textarea id="analysis-notes" rows={3} maxLength={1000} value={notes} onChange={e => setNotes(e.target.value)} placeholder="例如：关注最近一段行情的结构变化与失效条件"/><p className="field-help">真实行情的标的与周期在行情栏切换，未收盘末根不参与分析。CSV 周期由时间间隔推断；每次最多发送最近 {MAX_ANALYSIS_CANDLES} 根 K 线与上下文。</p><div className="config-note"><Code size={18}/><div><strong>Codex 登录与 API 配置</strong><p aria-label="Codex 分析调用参数">服务端调用配置：{health?.codexSettings?.model ?? '未读取'} · effort {health?.codexSettings?.reasoningEffort ?? 'CLI 默认'} · {health?.codexSettings?.serviceTier === 'fast' ? 'Fast 快速模式' : 'CLI 默认速度'}。仅对后续 Codex 分析生效。</p><p>Codex 使用本机 CLI 的 ChatGPT 登录。尚未登录时，在项目终端运行 <code>npx codex login</code>，完成后刷新状态。</p><code>AI_API_KEY · AI_BASE_URL · AI_MODEL</code><p>API Key 仅保存在服务端。分析失败会显示错误，不会自动切换计费来源。仅点击分析按钮时调用模型，实时行情更新不会自动消耗额度。</p></div></div><button className="button primary full-width" onClick={saveSettings}><Check size={17}/>完成设置</button></>}
      {error && <div className="dialog-error" role="alert"><WarningCircle size={17}/>{error}</div>}
    </dialog>
    {busy && analysisTask.snapshot && <div className="analysis-progress" role="status"><SpinnerGap className="spin" size={18}/><div><strong>{sourceNames[analysisTask.snapshot.source]} · 正在分析 {analysisTask.snapshot.candles.length} 根 K 线</strong><span>已等待 {elapsedSeconds} 秒 · 使用固定行情快照 · 校验通过后显示</span></div><button onClick={() => cancelAnalysis()}>取消</button></div>}
  </div>;
}
