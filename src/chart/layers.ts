import type { Structure } from '../../shared/analysis';
import type { ChartStructure } from './StructureOverlay';
export interface ChartLayers { primary: boolean; evidence: boolean; plans: boolean }
export const ALL_CHART_LAYERS: ChartLayers = { primary: true, evidence: true, plans: true };
export const structureLayer = (item: Structure): keyof ChartLayers => ['FVG', 'OB'].includes(item.type) ? 'evidence' : 'primary';
/** Co-located rule scales/AI claims share drawing space, never storage or IDs.
 * A selected record always owns its anchor so list navigation remains exact. */
export function chartStructureProjection(items: ChartStructure[], layers: ChartLayers, selectedId: string | null): ChartStructure[] {
  const result = new Map<string, ChartStructure>();
  for (const item of [...items].sort((a,b) => Number(a.id === selectedId) - Number(b.id === selectedId)
    || Number(a.importance === 'major') - Number(b.importance === 'major'))) {
    if (!layers[structureLayer(item)]) continue;
    result.set([item.type, item.startTime, item.endTime, item.price, item.priceEnd].join(':'), item);
  }
  return [...result.values()];
}

export function chartLegProjection<T extends { id: string; startTime: number; endTime: number; startPrice: number; endPrice: number }>(items: T[], selectedId: string | null): T[] {
  const records = new Map<string,T>();
  for (const item of [...items].sort((a,b)=>Number(a.id === selectedId)-Number(b.id === selectedId))) records.set([item.startTime,item.endTime,item.startPrice,item.endPrice].join(':'),item);
  return [...records.values()];
}
