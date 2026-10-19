import type { Analysis } from '../shared/analysis';
import type { Candle } from '../shared/market';

export interface AnalysisAnnotationSegment {
  key: 'front' | 'middle' | 'back' | 'all';
  label: string;
  from: number;
  to: number;
  barCount: number;
  count: number;
}

export interface AnalysisAnnotationDistribution {
  segments: AnalysisAnnotationSegment[];
  total: number;
  invalidInput: boolean;
}

/** Count returned annotations, never infer which candles a model examined. */
export function summarizeAnalysisAnnotations(analysis: Analysis, candles: readonly Candle[]): AnalysisAnnotationDistribution {
  if (!candles.length) return { segments: [], total: 0, invalidInput: false };
  if (candles.some((candle, index) => !Number.isInteger(candle.timestamp) || candle.timestamp < 0
    || candle.timestamp > 4_102_444_800 || (index > 0 && candle.timestamp <= candles[index - 1].timestamp))) {
    return { segments: [], total: 0, invalidInput: true };
  }

  const indexByTime = new Map(candles.map((candle, index) => [candle.timestamp, index]));
  const definitions = candles.length >= 10
    ? [{ key: 'front' as const, label: '前段' }, { key: 'middle' as const, label: '中段' }, { key: 'back' as const, label: '后段' }]
    : [{ key: 'all' as const, label: '全段' }];
  const segments = definitions.map((definition, index) => {
    const first = Math.floor(index * candles.length / definitions.length);
    const last = Math.floor((index + 1) * candles.length / definitions.length) - 1;
    return { ...definition, from: candles[first].timestamp, to: candles[last].timestamp, barCount: last - first + 1, count: 0 };
  });
  const exists = (time: number) => indexByTime.has(time);
  const validSpan = (from: number, to: number) => exists(from) && exists(to) && from <= to;
  let total = 0;
  const add = (anchorTime: number) => {
    const segment = segments.find(item => anchorTime >= item.from && anchorTime <= item.to);
    if (!segment) return;
    segment.count += 1;
    total += 1;
  };

  for (const structure of analysis.structures) {
    if (validSpan(structure.startTime, structure.endTime)) add(structure.endTime);
  }
  const validZones = new Set<string>();
  for (const zone of analysis.priceAction.zones) {
    if (!validSpan(zone.startTime, zone.endTime) || zone.touchTimes.some(time => !exists(time) || time < zone.startTime || time > zone.endTime)) continue;
    validZones.add(zone.id);
    add(zone.endTime);
  }
  for (const item of [...analysis.priceAction.legs, ...analysis.priceAction.patterns]) {
    if (validSpan(item.startTime, item.endTime)) add(item.endTime);
  }
  for (const event of analysis.priceAction.breakouts) {
    if (!validZones.has(event.zoneId) || !exists(event.breakoutTime)) continue;
    if (event.retestTime !== null && (!exists(event.retestTime) || event.retestTime <= event.breakoutTime)) continue;
    if (event.confirmationTime !== null && (!exists(event.confirmationTime) || event.retestTime === null
      || event.confirmationTime < event.retestTime)) continue;
    add(event.breakoutTime);
  }
  for (const sweep of analysis.liquiditySweeps) {
    if (validSpan(sweep.levelTime, sweep.sweepTime)) add(sweep.sweepTime);
  }
  return { segments, total, invalidInput: false };
}
