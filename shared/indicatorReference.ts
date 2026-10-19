import type { Candle } from './market';
import { detectRuleIndicators, type RuleIndicatorZone } from './indicators';

export const MAX_RULE_INDICATOR_REFERENCES = 32;
const resolved = (zone: RuleIndicatorZone) => zone.status === 'filled' || zone.status === 'invalidated';

function spread(zones: RuleIndicatorZone[], limit: number): RuleIndicatorZone[] {
  if (zones.length <= limit) return zones;
  if (limit === 0) return [];
  if (limit === 1) return [zones.at(-1)!];
  return Array.from({ length: limit }, (_, index) => zones[Math.round(index * (zones.length - 1) / (limit - 1))]);
}

/** Keep both families and a distributed historical context within a fixed input
 * budget. The complete selected OHLCV is still sent alongside these references. */
export function selectRuleIndicatorReferences(zones: readonly RuleIndicatorZone[]): RuleIndicatorZone[] {
  const seen = new Set<string>();
  const unique = zones.filter(zone => {
    if (seen.has(zone.id)) return false;
    seen.add(zone.id); return true;
  });
  const result: RuleIndicatorZone[] = [];
  for (const type of ['FVG', 'OB'] as const) {
    const ordered = unique.filter(zone => zone.type === type).sort((a, b) => a.formedAt - b.formedAt || a.id.localeCompare(b.id));
    const active = ordered.filter(zone => !resolved(zone));
    const historical = ordered.filter(resolved);
    const activeLimit = Math.min(active.length, Math.max(10, 16 - historical.length));
    result.push(...spread(active, activeLimit), ...spread(historical, 16 - activeLimit));
  }
  return result.sort((a, b) => a.formedAt - b.formedAt || a.id.localeCompare(b.id));
}

/** Recompute from the exact request snapshot. Never trust client-supplied zones
 * or reuse indicators formed outside the selected analysis window. */
export function buildRuleIndicatorReference(candles: readonly Candle[]) {
  const snapshot = detectRuleIndicators(candles);
  const references = selectRuleIndicatorReferences(snapshot.zones);
  return {
    source: 'deterministic-ohlcv-rules' as const,
    version: snapshot.version,
    asOf: snapshot.asOf,
    candleCount: snapshot.candleCount,
    parameters: snapshot.parameters,
    totalDetected: snapshot.zones.length,
    providedCount: references.length,
    omittedCount: snapshot.zones.length - references.length,
    selection: '每类最多16项，优先保留未回补或未失效区域，同时按形成时间分布保留历史；完整OHLCV未裁减。',
    limitations: '仅为所选已收盘OHLCV的规则参考，不是机构订单、交易指令或AI已认可的结论。所有时间为对应K线的UTC开盘时间；formedAt对应K线收盘后才可使用该区域，不能回溯到originTime使用。回补/失效状态只截至本次快照。',
    zones: references,
  };
}
