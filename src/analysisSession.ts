import { extractStructureEvidence } from '../shared/structureEvidence';
import type { Analysis } from '../shared/analysis';
import { MAX_ANALYSIS_CANDLES, type Candle } from '../shared/market';
import { matchesPAPattern } from '../shared/priceAction';

export type AnalysisDataset = { source: 'sample' | 'csv' | 'live'; name: string; timeframe: string; file: string };
export type AnalysisSnapshot = {
  identity: string;
  source: 'codex' | 'api' | 'mock';
  startedAt: number;
  selectionMode: 'auto' | 'manual';
  /** Opening timestamp of the last input candle, in UTC seconds. */
  asOf: number;
  candles: Candle[];
};

export function analysisDatasetKey(dataset: AnalysisDataset): string {
  return JSON.stringify([dataset.source, dataset.name.trim().toUpperCase(), dataset.timeframe.toUpperCase(), dataset.file]);
}

/** Copy the input so realtime replacement and rolling windows cannot change an in-flight request. */
export function createAnalysisSnapshot(candles: Candle[], identity: string, source: AnalysisSnapshot['source'], startedAt = Date.now(), selectionMode: 'auto' | 'manual' = 'auto'): AnalysisSnapshot {
  if (selectionMode === 'manual' && candles.length > MAX_ANALYSIS_CANDLES) throw new Error(`手动范围最多允许 ${MAX_ANALYSIS_CANDLES} 根 K 线，请缩小范围。`);
  const copy = (selectionMode === 'manual' ? candles : candles.slice(-MAX_ANALYSIS_CANDLES)).map(candle => ({ ...candle }));
  return { identity, source, startedAt, selectionMode, asOf: copy.at(-1)?.timestamp ?? 0, candles: copy };
}

export function inspectAnalysisSnapshot(snapshot: AnalysisSnapshot, currentCandles: Candle[]) {
  const current = new Map(currentCandles.map(candle => [candle.timestamp, candle]));
  let missingBars = 0;
  let revisedBars = 0;
  for (const candle of snapshot.candles) {
    const present = current.get(candle.timestamp);
    if (!present) missingBars++;
    else if (['open', 'high', 'low', 'close', 'volume'].some(key => candle[key as keyof Candle] !== present[key as keyof Candle])) revisedBars++;
  }
  const originalTimes = new Set(snapshot.candles.map(candle => candle.timestamp));
  const start = snapshot.candles[0]?.timestamp ?? 0;
  revisedBars += currentCandles.filter(candle => candle.timestamp >= start && candle.timestamp <= snapshot.asOf && !originalTimes.has(candle.timestamp)).length;
  const addedBars = snapshot.selectionMode === 'manual' ? 0 : currentCandles.filter(candle => candle.timestamp > snapshot.asOf).length;
  return { stale: addedBars > 0 || revisedBars > 0 || missingBars > 0, addedBars, revisedBars, missingBars };
}

/** This is a display projection only; the validated original stays available for export.
 * Never snap historical evidence to a nearby candle after its timestamp rolls out. */
export function projectAnalysisForCandles(analysis: Analysis, candles: Candle[], snapshotCandles?: Candle[]): Analysis {
  const times = new Set(candles.map(candle => candle.timestamp));
  const current = new Map(candles.map(candle => [candle.timestamp, candle]));
  const original = snapshotCandles ?? [];
  const unchangedBetween = (from: number, to: number, padding = 0) => {
    if (!snapshotCandles) return true;
    const fromIndex = original.findIndex(candle => candle.timestamp === from);
    const toIndex = original.findIndex(candle => candle.timestamp === to);
    if (fromIndex < 0 || toIndex < 0) return false;
    return original.slice(Math.max(0, fromIndex - padding), toIndex + padding + 1).every(candle => {
      const present = current.get(candle.timestamp);
      return present && candle.open === present.open && candle.high === present.high && candle.low === present.low && candle.close === present.close;
    });
  };
  const spanExists = (item: { startTime: number; endTime: number }) => times.has(item.startTime) && times.has(item.endTime);
  const structures = analysis.structures.filter(item => spanExists(item) && unchangedBetween(item.startTime, item.endTime, ['HH', 'HL', 'LH', 'LL'].includes(item.type) ? 2 : 0));
  const zones = analysis.priceAction.zones.filter(zone => spanExists(zone) && zone.touchTimes.every(time => times.has(time)) && unchangedBetween(zone.startTime, zone.endTime));
  const zoneIds = new Set(zones.map(zone => zone.id));
  const legs = analysis.priceAction.legs.filter(item => spanExists(item) && unchangedBetween(item.startTime, item.endTime, 2));
  const patterns = analysis.priceAction.patterns.filter(item => spanExists(item) && unchangedBetween(item.startTime, item.endTime)
    && matchesPAPattern(item, current.get(item.startTime)!, current.get(item.endTime)!, candles.findIndex(candle => candle.timestamp === item.endTime) === candles.findIndex(candle => candle.timestamp === item.startTime) + 1));
  const breakouts = analysis.priceAction.breakouts.filter(event => zoneIds.has(event.zoneId) && times.has(event.breakoutTime)
    && (event.retestTime === null || times.has(event.retestTime)) && (event.confirmationTime === null || times.has(event.confirmationTime))
    && unchangedBetween(event.breakoutTime, event.confirmationTime ?? event.retestTime ?? event.breakoutTime));
  const evidenceIds = new Set([...structures, ...zones, ...legs, ...patterns, ...breakouts].map(item => item.id));
  const rules = extractStructureEvidence(snapshotCandles ?? candles);
  for (const item of rules.structures) {
    const from = Math.min(item.timing.originTime, ...item.evidenceTimes);
    const to = Math.max(item.timing.formedAt, item.timing.confirmedAt ?? item.timing.formedAt, ...item.evidenceTimes);
    if (times.has(from) && times.has(to) && unchangedBetween(from, to, item.type === 'FVG' ? 0 : item.scale)) evidenceIds.add(item.id);
  }
  for (const leg of rules.legs) if (times.has(leg.startTime) && times.has(leg.timing.confirmedAt!) && unchangedBetween(leg.startTime, leg.timing.confirmedAt!, 5)) evidenceIds.add(leg.id);
  const opportunities = analysis.opportunities.filter(item => item.structureIds.every(id => evidenceIds.has(id)));
  const opportunityIds = new Set(opportunities.map(item => item.id));
  const tradeSetups = analysis.tradeSetups.filter(item => times.has(item.anchorTime) && unchangedBetween(item.anchorTime, item.anchorTime) && item.structureIds.every(id => evidenceIds.has(id))
    && (item.opportunityId === null || opportunityIds.has(item.opportunityId)));
  const liquiditySweeps = analysis.liquiditySweeps.filter(item => times.has(item.levelTime) && times.has(item.sweepTime) && unchangedBetween(item.levelTime, item.sweepTime, 2));
  return { ...analysis, structures, opportunities, tradeSetups, liquiditySweeps,
    priceAction: { ...analysis.priceAction, zones, legs, patterns, breakouts } };
}
