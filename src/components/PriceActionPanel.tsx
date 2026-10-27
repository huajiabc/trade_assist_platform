import { shortDisplayTime } from '../../shared/displayTime';
import { ArrowUpRight, Check, Clock, Info } from '@phosphor-icons/react';
import type { Analysis } from '../../shared/analysis';
import type { Candle } from '../../shared/market';
import type { PAZone, PALeg, PAPattern, PABreakout } from '../../shared/priceAction';
import { formatPrice } from '../../shared/format';

export type PALayer = 'zones' | 'legs' | 'patterns' | 'breakouts';
export type PAEvidence = PAZone | PALeg | PAPattern | PABreakout;
export const paRegimeNames = { uptrend: '上升趋势', downtrend: '下降趋势', range: '区间震荡', transition: '结构转换' };
export const paLayerNames: Record<PALayer, string> = { zones: '支撑 / 阻力 / 区间', legs: '推进与回撤', patterns: 'K 线形态', breakouts: '突破与回踩' };
const patternNames = { 'pin-bar': 'Pin bar · 拒绝', engulfing: 'Engulfing · 吞没', 'inside-bar': 'Inside bar · 内包' };
const date = (time: number) => shortDisplayTime(time);

export function getPAEvidence(priceAction?: Analysis['priceAction']): { layer: PALayer; item: PAEvidence }[] {
  return priceAction ? (['zones', 'legs', 'patterns', 'breakouts'] as const).flatMap(layer => priceAction[layer].map(item => ({ layer, item }))) : [];
}

function CandlePreview({ pattern, candles }: { pattern: PAPattern; candles: Candle[] }) {
  const matched = candles.filter(candle => candle.timestamp >= pattern.startTime && candle.timestamp <= pattern.endTime);
  if (!matched.length) return null;
  const low = Math.min(...matched.map(c => c.low));
  const high = Math.max(...matched.map(c => c.high));
  const y = (price: number) => 6 + (high - price) / (high - low || 1) * 36;
  return <svg className="pa-candle-preview" viewBox="0 0 74 48" role="img" aria-label="对应行情的 K 线实体与影线">
    {matched.map((candle, index) => {
      const x = 37 + (index - (matched.length - 1) / 2) * 22;
      return <g key={candle.timestamp} className={candle.close >= candle.open ? 'up' : 'down'}><line x1={x} x2={x} y1={y(candle.high)} y2={y(candle.low)}/><rect x={x - 6} y={Math.min(y(candle.open), y(candle.close))} width={12} height={Math.max(1, Math.abs(y(candle.open) - y(candle.close)))}/></g>;
    })}
  </svg>;
}

type Props = {
  priceAction?: Analysis['priceAction'];
  candles: Candle[];
  selectedId: string | null;
  showCandidates: boolean;
  onSelect: (id: string) => void;
};

export function PriceActionPanel({ priceAction, candles, selectedId, showCandidates, onSelect }: Props) {
  const evidence = getPAEvidence(priceAction).filter(({ item }) => showCandidates || item.status === 'confirmed');
  return <section className="pa-evidence" aria-label="PA 价格行为分析依据">
    <div className="pa-panel-intro"><Info size={15}/><p>先看趋势和区间，再看价格如何测试边界。已观察到的形态只描述历史价格行为，开仓条件仍需后续行情确认。</p></div>
    {!evidence.length ? <div className="advanced-empty"><Info size={17}/><p>{priceAction ? '本次未给出可绘制的 PA 依据，或候选已隐藏。旧版分析没有 PA 字段，请重新分析；也可加载 PA 教学示例查看区域、路径和形态。' : '完成分析后，可查看支撑阻力、趋势推进与回撤、K 线形态和突破回踩的价格行为依据。'}</p></div> : (['zones', 'legs', 'patterns', 'breakouts'] as const).map((layer, groupIndex) => {
      const items = evidence.filter(entry => entry.layer === layer);
      return <section key={layer} className={`pa-evidence-group pa-group-${layer}`} aria-label={paLayerNames[layer]}>
        <div className="pa-group-heading"><span>{String(groupIndex + 1).padStart(2, '0')}</span><h3>{paLayerNames[layer]}</h3><small>{items.length} 项</small></div>
        {!items.length ? <p className="pa-group-empty">本次无符合条件的此类形态。</p> : <div className="pa-evidence-grid">{items.map(({ item }) => {
          const zone = layer === 'zones' ? item as PAZone : null;
          const leg = layer === 'legs' ? item as PALeg : null;
          const pattern = layer === 'patterns' ? item as PAPattern : null;
          const breakout = layer === 'breakouts' ? item as PABreakout : null;
          const startTime = breakout ? breakout.breakoutTime : (item as PAZone | PALeg | PAPattern).startTime;
          const endTime = breakout ? breakout.confirmationTime ?? breakout.retestTime ?? breakout.breakoutTime : (item as PAZone | PALeg | PAPattern).endTime;
          return <article key={item.id} className={`pa-evidence-card ${selectedId === item.id ? 'is-selected' : ''}`} data-pa-id={item.id} data-pa-layer={layer}>
            <div className="pa-card-heading"><h4>{item.title}</h4><span className={`confirmation ${item.status}`}>{item.status === 'confirmed' ? <Check size={12}/> : <Clock size={12}/>} {item.status === 'confirmed' ? '已观察' : '候选'}</span></div>
            <div className="pa-card-geometry">
              {zone && <><span className={`pa-geometry-tag ${zone.kind}`}>{zone.kind === 'support' ? '支撑带' : zone.kind === 'resistance' ? '阻力带' : '交易区间'}</span><strong>{formatPrice(zone.lowerPrice)} <i>至</i> {formatPrice(zone.upperPrice)}</strong><small>{zone.touchTimes.length} 次边界测试</small></>}
              {leg && <><span className={`pa-geometry-tag ${leg.direction}`}>{leg.kind === 'impulse' ? '趋势推进' : '回撤整理'}</span><strong>{formatPrice(leg.startPrice)} <i>→</i> {formatPrice(leg.endPrice)}</strong><small>{leg.endPrice >= leg.startPrice ? '+' : ''}{((leg.endPrice / leg.startPrice - 1) * 100).toFixed(2)}%</small></>}
              {pattern && <><CandlePreview pattern={pattern} candles={candles}/><div><span className="pa-pattern-name">{patternNames[pattern.kind]}</span><small>{pattern.direction === 'bullish' ? '偏多价格行为 · 结合背景' : pattern.direction === 'bearish' ? '偏空价格行为 · 结合背景' : '收敛 · 方向待选择'}</small></div></>}
              {breakout && <div className="pa-breakout-steps" aria-label="突破回踩阶段"><span className="observed"><b>1</b>突破</span><i>→</i><span className={breakout.retestTime !== null ? 'observed' : ''}><b>2</b>{breakout.retestTime !== null ? '已回踩' : '待回踩'}</span><i>→</i><span className={breakout.confirmationTime !== null ? 'observed' : ''}><b>3</b>{breakout.confirmationTime !== null ? '守住边界' : '待确认'}</span></div>}
            </div>
            <p className="pa-card-rationale">{item.rationale}</p><p className="pa-card-invalidation"><span>失效条件</span>{item.invalidation}</p>
            <button className="pa-focus-button" onClick={() => onSelect(item.id)} aria-pressed={selectedId === item.id} aria-label={`定位 PA ${item.title}`}><span>{date(startTime)}{endTime !== startTime ? ` 至 ${date(endTime)}` : ''} UTC+8</span><ArrowUpRight size={15}/></button>
          </article>;
        })}</div>}
      </section>;
    })}
  </section>;
}
