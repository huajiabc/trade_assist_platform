import { ArrowUpRight, Clock, Info, Target } from '@phosphor-icons/react';
import type { Analysis, LiquiditySweep, Structure, TradeSetup } from '../../shared/analysis';
import { formatPrice } from '../../shared/format';
import { calculateRiskReward } from '../../shared/tradeGeometry';
import { getPAEvidence } from './PriceActionPanel';

const date = (time: number) => new Date(time * 1000).toISOString().replace('T', ' ').slice(5, 16);
const ratio = (value: number) => value < .01 ? value.toExponential(2) : Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
const percent = (value: number) => value < .01 ? value.toExponential(2) : value.toFixed(2);

type TradePlansProps = {
  analysis?: Analysis;
  selectedId: string | null;
  onSelect: (setup: TradeSetup) => void;
  onSelectStructure: (structure: Structure) => void;
  onSelectPA?: (id: string) => void;
};

export function TradePlans({ analysis, selectedId, onSelect, onSelectStructure, onSelectPA }: TradePlansProps) {
  const setups = analysis?.tradeSetups ?? [];
  return <section className="trade-plans" aria-label="数值开仓候选与盈亏比">
    <div className="advanced-section-title"><Target size={16}/><h3>开仓候选与盈亏区间</h3><span>仅为条件情景</span></div>
    <p className="advanced-explainer">E 为参考入场，SL 为计划止损，TP 为目标价。风险∶收益按价格距离计算，未计手续费、滑点或资金费率；未指定持仓数量，不是账户实际盈亏，也不代表成交或胜率。</p>
    {setups.length ? <div className="trade-plan-grid">{setups.map((setup, index) => {
      const opportunity = analysis?.opportunities.find(item => item.id === setup.opportunityId);
      const first = calculateRiskReward(setup);
      return <article className={`trade-plan-card ${selectedId === setup.id ? 'is-selected' : ''}`} key={setup.id} data-setup-id={setup.id}>
        <div className="trade-plan-heading"><div><span className="advanced-number">{String(index + 1).padStart(2, '0')}</span><h4>{setup.direction === 'bullish' ? '偏多' : '偏空'}开仓候选</h4></div><span className="confirmation candidate"><Clock size={12}/>待确认</span></div>
        <button className="trade-focus-button" onClick={() => onSelect(setup)} aria-pressed={selectedId === setup.id} aria-label={`定位开仓候选 ${index + 1}`}><span>定位 {date(setup.anchorTime)} UTC</span><ArrowUpRight size={15}/></button>
        <div className="trade-price-grid"><div><span>参考入场 E</span><strong>{formatPrice(setup.entry)}</strong></div><div><span>计划止损 SL</span><strong className="trade-loss">{formatPrice(setup.stopLoss)}</strong></div><div><span>止损距离</span><strong>{percent(first.riskPct)}%</strong></div></div>
        <div className="risk-reward-targets">{setup.targets.map((target, targetIndex) => {
          const reward = calculateRiskReward(setup, targetIndex);
          const riskWidth = reward.risk / (reward.risk + reward.reward) * 100;
          return <div className="risk-reward-target" key={targetIndex}>
            <div className="target-heading"><span><b>TP{targetIndex + 1}</b> {target.label}</span><strong>{formatPrice(target.price)}</strong><span className="risk-reward-ratio" aria-label={`风险比收益 1 比 ${ratio(reward.ratio)}`}>1 : {ratio(reward.ratio)}</span></div>
            <div className="risk-reward-track" role="img" aria-label={`TP${targetIndex + 1} 风险收益比 1 比 ${ratio(reward.ratio)}，风险距离 ${percent(reward.riskPct)}%，目标距离 ${percent(reward.rewardPct)}%`}><span className="risk-segment" style={{ width: `${riskWidth}%` }}/><span className="reward-segment" style={{ width: `${100 - riskWidth}%` }}/></div>
            <div className="risk-reward-caption"><span>风险 1R</span><span>目标 {ratio(reward.ratio)}R · 距入场 {percent(reward.rewardPct)}%</span></div>
          </div>;
        })}</div>
        <dl className="advanced-reasons">{opportunity && <div><dt>触发条件</dt><dd>{opportunity.trigger}</dd></div>}<div><dt>识别依据</dt><dd>{setup.rationale}</dd></div><div><dt>失效条件</dt><dd>{setup.invalidation}</dd></div></dl>
        <div className="related-structures">{setup.structureIds.map(id => {
          const structure = analysis?.structures.find(item => item.id === id);
          const pa = getPAEvidence(analysis?.priceAction).find(entry => entry.item.id === id);
          return structure ? <button key={id} onClick={() => onSelectStructure(structure)}>依据 {structure.type}<ArrowUpRight size={13}/></button> : pa && onSelectPA ? <button key={id} onClick={() => onSelectPA(id)}>PA · {pa.item.title}<ArrowUpRight size={13}/></button> : null;
        })}</div>
      </article>;
    })}</div> : <div className="advanced-empty"><Info size={17}/><p>{analysis ? '本次没有可绘制的数值开仓候选。若是旧分析无数值计划，需重新分析；模型也可以在依据不足时不提供候选。' : '完成分析后，具有明确入场、止损和目标价的候选会显示在这里。'}</p></div>}
  </section>;
}

type SweepsProps = {
  sweeps: LiquiditySweep[];
  hasAnalysis: boolean;
  selectedId: string | null;
  onSelect: (sweep: LiquiditySweep) => void;
};

export function LiquiditySweeps({ sweeps, hasAnalysis, selectedId, onSelect }: SweepsProps) {
  return <section className="liquidity-sweeps" aria-label="流动性扫除依据">
    <p className="advanced-explainer sweep-explainer"><Info size={15}/><span>基于 OHLC 推断历史高低点附近的扫除形态。越界并收回是已确认形态，未收回仍为候选；无法据此确认实际挂单、止损成交或机构意图。</span></p>
    {sweeps.length ? <div className="sweep-list">{sweeps.map(sweep => <article className={`sweep-card ${selectedId === sweep.id ? 'is-selected' : ''}`} key={sweep.id} data-sweep-id={sweep.id}>
      <div className="sweep-card-heading"><div><span className={`sweep-side ${sweep.side}`}>{sweep.side === 'buy-side' ? 'BSL' : 'SSL'}</span><h3>{sweep.side === 'buy-side' ? '买方流动性 · 前高上方' : '卖方流动性 · 前低下方'}</h3></div><span className={`confirmation ${sweep.status}`}>{sweep.status === 'confirmed' ? '影线越界后收回' : '候选 · 待确认'}</span></div>
      <button className="trade-focus-button" onClick={() => onSelect(sweep)} aria-pressed={selectedId === sweep.id} aria-label={`定位${sweep.side === 'buy-side' ? '买方' : '卖方'}流动性扫除 ${date(sweep.sweepTime)}`}><span>{date(sweep.levelTime)} → {date(sweep.sweepTime)} UTC</span><ArrowUpRight size={15}/></button>
      <div className="sweep-price-grid"><div><span>参考价位</span><strong>{formatPrice(sweep.levelPrice)}</strong></div><div><span>越界极值</span><strong>{formatPrice(sweep.extremePrice)}</strong></div></div>
      <dl className="advanced-reasons"><div><dt>识别依据</dt><dd>{sweep.rationale}</dd></div><div><dt>失效条件</dt><dd>{sweep.invalidation}</dd></div></dl>
    </article>)}</div> : <div className="advanced-empty"><Info size={17}/><p>{hasAnalysis ? '本次未识别到符合条件的流动性扫除。若为旧版结果，请重新分析以启用此项。' : '完成分析后，可查看扫除的参考价位、越界 K 线及收回依据。'}</p></div>}
  </section>;
}
