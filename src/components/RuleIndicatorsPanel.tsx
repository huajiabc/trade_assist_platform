import { useEffect, useRef, useState } from 'react';
import type { RuleIndicatorSnapshot, RuleIndicatorZone } from '../../shared/indicators';
import { INDICATOR_EXTENSION_BARS } from '../chart/indicatorCoordinates';

export type RuleIndicatorVisibility = { FVG: boolean; OB: boolean; history: boolean };

/** Layer visibility never changes the indicator evidence sent to AI analysis. */
export function visibleRuleIndicatorZones(snapshot: RuleIndicatorSnapshot, visibility: RuleIndicatorVisibility): RuleIndicatorZone[] {
  return snapshot.zones.filter(zone => visibility[zone.type]
    && (visibility.history || (zone.status !== 'filled' && zone.status !== 'invalidated')));
}

type Props = {
  snapshot: RuleIndicatorSnapshot;
  visibility: RuleIndicatorVisibility;
  onVisibilityChange: (next: RuleIndicatorVisibility) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
};

const statusNames: Record<RuleIndicatorZone['status'], string> = {
  active: '未触及', partial: '部分回补', filled: '已回补', tested: '已测试', invalidated: '已失效',
};
const time = (timestamp: number) => new Date(timestamp * 1000).toISOString().replace('T', ' ').slice(0, 16);
const price = (value: number) => value > 0 && value < 0.0001 ? value.toString()
  : new Intl.NumberFormat('en-US', { maximumFractionDigits: 20 }).format(value);
const isHistorical = (zone: RuleIndicatorZone) => zone.status === 'filled' || zone.status === 'invalidated';

export function RuleIndicatorsPanel({ snapshot, visibility, onVisibilityChange, selectedId, onSelect }: Props) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const selected = snapshot.zones.find(zone => zone.id === selectedId);
  useEffect(() => {
    if (selectedId) setDetailsOpen(true);
  }, [selectedId]);
  useEffect(() => {
    const list = listRef.current;
    const row = list && [...list.children].find(child => (child as HTMLElement).dataset.ruleIndicatorId === selectedId);
    if (list && row && detailsOpen) {
      const rowBounds = row.getBoundingClientRect();
      const listBounds = list.getBoundingClientRect();
      if (rowBounds.top < listBounds.top || rowBounds.bottom > listBounds.bottom) list.scrollTop += rowBounds.top - listBounds.top;
    }
  }, [selectedId, detailsOpen]);

  const sorted = [...snapshot.zones].sort((a, b) => b.formedAt - a.formedAt || a.id.localeCompare(b.id));
  const displayed = showAll ? sorted : sorted.slice(0, 12);
  if (selected && !displayed.some(zone => zone.id === selected.id)) displayed.unshift(selected);
  const counts = (type: RuleIndicatorZone['type']) => snapshot.zones.filter(zone => zone.type === type
    && (visibility.history || !isHistorical(zone))).length;
  const currentCount = snapshot.zones.filter(zone => !isHistorical(zone)).length;
  const historicalCount = snapshot.zones.length - currentCount;

  return <section className="rule-indicators-panel" aria-label="规则 FVG 与 OB 指标">
    <div className="rule-indicators-toolbar">
      <strong>规则指标 <span>· OHLC 计算</span></strong>
      <span className="rule-indicator-display-limit">最多延伸 {INDICATOR_EXTENSION_BARS} 根 K 线</span>
      {(['FVG', 'OB'] as const).map(type => <label className={`rule-indicator-toggle type-${type.toLowerCase()}`} key={type}>
        <input type="checkbox" checked={visibility[type]} onChange={event => onVisibilityChange({ ...visibility, [type]: event.target.checked })}/>
        <span className="rule-indicator-swatch" aria-hidden="true"/>
        <span>{type === 'OB' ? 'OB 候选' : type}</span><small>{counts(type)}</small>
      </label>)}
      <label className="rule-indicator-history-toggle"><input type="checkbox" checked={visibility.history}
        onChange={event => onVisibilityChange({ ...visibility, history: event.target.checked })}/>显示历史回补 / 失效</label>
      {!snapshot.candleCount && <span className="rule-indicator-toolbar-empty">等待已收盘行情</span>}
    </div>
    <details className="rule-indicators-details" open={detailsOpen} onToggle={event => setDetailsOpen(event.currentTarget.open)}>
      <summary>原理与识别依据 <span>{currentCount} 项当前区域 · {historicalCount} 项历史区域</span></summary>
      <div className="rule-indicators-explanation">
        <p>无需 AI 调用；FVG 为三烛影线缺口，OB 为收盘突破已确认摆点前的最后反向实体候选，均在 K 线收盘后计算。</p>
        <p>规则 OB 候选不代表 AI 已认可，也不能证明机构订单。FVG 不保证回补；已回补或失效的区域仅用于历史复核，不作为当前入场依据。</p>
        <small>图表基于已加载的已收盘行情，AI 会按所选快照重算参考。显示开关仅影响图表，不影响 AI 参考。</small>
        <small>色带从形成根起最多延伸 {INDICATOR_EXTENSION_BARS} 根已存在的 K 线，提前回补或失效则提早结束；后续状态仍继续跟踪，不会因色带结束而认定失效。</small>
        <small>所有时间均为对应 K 线的 UTC 开盘时间；“形成”须等该根收盘后才可知，不能回溯到起源时刻使用。</small>
      </div>
      {!snapshot.zones.length ? <p className="rule-indicators-empty">{snapshot.candleCount
        ? '当前已加载行情未识别出符合规则的 FVG 或 OB 候选。可加载更多历史行情后复核。'
        : '加载真实行情或导入 CSV 后，将自动计算已收盘 K 线中的规则指标。'}</p>
        : <>
          <div className="rule-indicator-list" aria-label="规则指标识别列表" ref={listRef}>
            {displayed.map(zone => <article className={`rule-indicator-row direction-${zone.direction} ${isHistorical(zone) ? 'is-historical' : ''} ${selectedId === zone.id ? 'is-selected' : ''}`}
              key={zone.id} data-rule-indicator-id={zone.id}>
              <button type="button" className="rule-indicator-focus" onClick={() => onSelect(zone.id)} aria-pressed={selectedId === zone.id}
                aria-label={`定位规则 ${zone.type}${zone.type === 'OB' ? ' 候选' : ''} ${time(zone.formedAt)} UTC`}>
                <span className="rule-indicator-title"><b>{zone.type === 'OB' ? '规则 OB 候选' : '规则 FVG'}</b>
                  <span>{zone.direction === 'bullish' ? '多向' : '空向'}</span><span className={`rule-indicator-status status-${zone.status}`}>{statusNames[zone.status]}</span></span>
                <strong className="rule-indicator-price" title={`${zone.lowerPrice} – ${zone.upperPrice}`}>{price(zone.lowerPrice)} <i>至</i> {price(zone.upperPrice)} <span aria-hidden="true">↗</span></strong>
                <span className="rule-indicator-time">形成 {time(zone.formedAt)} UTC · 起源 {time(zone.originTime)} UTC</span>
              </button>
              {selectedId === zone.id && <div className="rule-indicator-evidence">
                <p><span>识别依据</span>{zone.rationale}</p>
                <p><span>失效条件</span>{zone.invalidation}</p>
                <small>中点 {price(zone.midpoint)}{zone.type === 'FVG' ? ` · 回补 ${(zone.mitigation * 100).toFixed(1)}%` : ''}
                  {zone.firstTouchTime !== null ? ` · 首次触及 ${time(zone.firstTouchTime)} UTC` : ' · 尚未触及'}
                  {zone.resolvedTime !== null ? ` · ${zone.status === 'filled' ? '回补' : '失效'} ${time(zone.resolvedTime)} UTC` : ''}</small>
              </div>}
            </article>)}
          </div>
          {sorted.length > 12 && <button className="rule-indicator-more" type="button" onClick={() => setShowAll(!showAll)}>
            {showAll ? '收起为最新 12 项' : `查看全部 ${sorted.length} 项`}
          </button>}
        </>}
    </details>
  </section>;
}
