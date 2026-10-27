import { formatDisplayTime } from '../../shared/displayTime';
import { useMemo, useState } from 'react';
import { useAccount } from '../accountContext';
import { positionIdentity, usableAccount, type ExchangePosition } from '../../shared/account';
import type { MarketState } from '../../shared/marketState';
import type { ResearchBundle, ResearchFact } from '../../shared/researchData';
import { buildPositionManagement, exchangeLinkedPlan, positionReviewIsStale, type PositionManagementContext, type PositionReviewResponse } from '../../shared/positionManagement';
import { formatPrice } from '../../shared/format';
import { BinanceAccountSettings } from './BinanceAccountSettings';
import {positionProtection} from '../../shared/protectionOrders';
import {ProtectionOrdersPanel} from './ProtectionOrdersPanel';
export interface PositionReviewRecord {result:PositionReviewResponse;context:PositionManagementContext;bundle:ResearchBundle}
export interface PositionReviewTask {positionId:string;phase:'account'|'market'|'capture'|'model'|'validation'|'complete'|'error';error?:string}
const phaseNames={account:'同步账户',market:'准备多周期行情',capture:'生成分析截图',model:'模型正在审阅',validation:'校验建议',complete:'持仓审阅完成',error:'持仓审阅失败'};
interface Props {symbol:string;ready:boolean;state:MarketState|null;busy:boolean;preparing:boolean;task:PositionReviewTask|null;elapsed:number;records:Record<string,PositionReviewRecord>;onCancel:()=>void;onPrepare:()=>void;onReview:(positionId:string,planId:string|null)=>void;onLink:(position:ExchangePosition,planId:string|null)=>void;onSymbol:(symbol:string)=>void;onLocate:(fact:ResearchFact,record?:PositionReviewRecord)=>void;onPlot:(positionId:string,historical:boolean)=>void}
const stamp=(ms:number)=>formatDisplayTime(ms/1000,true)+' UTC+8';
const value=(n:number|null,unit='')=>n===null?'缺失 / 不适用':formatPrice(n)+(unit?' '+unit:'');
export function PositionManagementPanel(props:Props){
 const account=useAccount(),{status}=account,snapshot=status.snapshot;
 const [selectedId,setSelectedId]=useState<string|null>(null);
 const selected=snapshot?.positions.find(p=>p.id===selectedId)??snapshot?.positions[0];
 const linked=selected?props.state?.exchangePlanLinks?.find(l=>l.positionId===selected.id&&l.identity===positionIdentity(selected)&&typeof l.planVersion==='number'):null;
 const oldLink=selected?props.state?.exchangePlanLinks?.find(l=>l.positionId===selected.id):null;
 const contextResult=useMemo<{value:PositionManagementContext|null;error:string}>(()=>{
  if(!props.state||!snapshot||!selected||selected.symbol!==props.state.symbol)return {value:null,error:'同标的多周期行情尚未准备完成；审阅时会先获取最新有效数据。'};
  try{return {value:buildPositionManagement(props.state,snapshot,selected,exchangeLinkedPlan(props.state,linked)),error:''};}catch(e){return {value:null,error:'持仓研究上下文未能建立：'+(e instanceof Error?e.message:'请重新加载多周期行情。')};}
 },[props.state,snapshot,selected,linked]);
 const context=contextResult.value;
 const record=selected?props.records[selected.id]:null;
 const stale=!!record&&(!props.state||!usableAccount(status)||positionReviewIsStale(record.result,props.state,snapshot));
 const current=usableAccount(status),plans=props.state?.plans.filter(p=>p.versions.at(-1)!.setup.direction===selected?.direction)??[];
 const task=props.task?.positionId===selected?.id?props.task:null;
 const running=!!task&&!['complete','error'].includes(task.phase);
 const blocked=!props.ready?'正在读取本地研究记录，请稍候。':props.busy?(running?phaseNames[task!.phase]+' · '+props.elapsed+'秒':'已有分析正在进行，请等待完成或取消后再审阅此持仓。'):!current?'账户数据未同步、已过期或连接异常，请先刷新账户。':selected?.validity!=='valid'?'持仓关键字段不完整，请重新同步账户并检查上方提示。':'';
 return <section className="position-management" aria-label="真实持仓管理">
  <BinanceAccountSettings compact/>
  <p className="account-sync-meta">交易所同步仓位与本地手动登记分别保存。候选触发不会生成交易所持仓；相同标的与方向也不会自动关联计划。</p>
  {!snapshot?<div className="advanced-empty">尚无账户快照，请在设置中配置服务端凭据后测试连接。</div>:<>
   {!current&&<p role="alert" className="research-conflict">账户未连接、过期或同步异常；下列仅是旧快照，不代表当前持仓，已暂停新的持仓审阅。</p>}
   {snapshot.warnings.map((w,i)=><p className="research-conflict" key={i}>{w}</p>)}
   <div className="position-list" role="group" aria-label="交易所真实持仓列表">{snapshot.positions.map(p=><button key={p.id} aria-pressed={p.id===selected?.id} onClick={()=>{setSelectedId(p.id);props.onPlot(p.id,false);}}><b>{p.symbol} · {p.direction==='bullish'?'多':'空'}</b><span>{p.positionSide} · {p.quantity} {p.quantityUnit??'单位未知'} · {p.marginMode==='isolated'?'逐仓':p.marginMode==='cross'?'全仓':'保证金模式未知'}</span><span>交易所未实现 {value(p.unrealizedPnl,p.marginAsset??'')}</span></button>)}</div>
   {!snapshot.positions.length&&<p>{current&&!snapshot.warnings.length?'交易所本次读取为零持仓。':'此快照未列出非零持仓；数据异常时不能据此确认当前无仓位。'}</p>}
   {snapshot.orders&&<details className="account-order-query"><summary>全账户挂单查询 · {snapshot.orders.orders.length} 项</summary><p>普通订单：{snapshot.orders.standardAvailable?'已读取':'读取失败'} · Algo条件单：{snapshot.orders.algoAvailable?'已读取':'读取失败'}。未匹配实际持仓的订单不会冒充其SL/TP。</p>{snapshot.orders.orders.slice(0,30).map(o=><p key={o.id}>{o.symbol} · {o.positionSide} / {o.side} · {o.orderType} · {o.kind==='trailing-stop'?'激活（非SL） '+value(o.activationPrice):'触发/限价 '+value(o.triggerPrice??o.limitPrice)} · {o.status}</p>)}{snapshot.orders.orders.length>30&&<p>全账户面板展示前30项；持仓详情按归属单独核对。</p>}{snapshot.orders.warnings.map((w,i)=><p key={i}>{w}</p>)}</details>}
   {selected&&<article className="position-detail"><h3>{selected.symbol} · {selected.positionSide} · 真实持仓</h3>
    <p className="position-cost-summary">实际均价 {value(selected.entryPrice)} · 标记价 {value(selected.markPrice)}</p>
    {selected.symbol===props.symbol&&<>
     <div className="position-review-control">
      <button className="button primary" aria-describedby="position-review-status" aria-controls={"position-advice-"+selected.id} disabled={!!blocked} onClick={()=>props.onReview(selected.id,linked?.planId??null)}>{running?phaseNames[task!.phase]+'…':'深度审阅此持仓'}</button>
      {running&&<button className="button secondary" onClick={props.onCancel}>取消持仓审阅</button>}
      <p id="position-review-status" className="account-sync-meta" role={task?.phase==='error'?'alert':'status'}>{task?.phase==='error'?task.error:blocked||task?.phase==='complete'&&'审阅完成；图表继续显示实时行情，原始分析快照可单独查看。'||'主动调用所选模型；后台规则刷新不会阻止审阅。'}</p>
     </div>
    </>}
    {record&&<div className="position-advice" id={"position-advice-"+selected.id} aria-label="持仓管理建议"><h4>{record.result.source==='ai'?'AI持仓复核':'本地占位观察'} · {stale?'原快照结果 · 已过时':'绑定当前快照'}</h4><p>{record.result.analysis.summary}</p><p>建议：{({ 'observe-original-plan':'继续观察原计划','review-protection':'重新评估保护','review-targets':'重新评估TP/分批止盈','hypothesis-at-risk':'原假设可能失效，人工复核','insufficient-data':'证据不足' })[record.result.analysis.decision]}</p>
     {stale&&<p className="research-conflict">账户、行情、状态版本或关联已变化；此结果不能视为当前管理建议。</p>}
     {record.result.analysis.changes.map((c,i)=><p key={i}>变化：{c}</p>)}
     {record.result.analysis.protection&&<p>人工复核SL参考：{formatPrice(record.result.analysis.protection.price)} · {record.result.analysis.protection.timeframe}</p>}
     {record.result.analysis.targets.map((t,i)=><p key={i}>人工复核TP{i+1}：{formatPrice(t.price)} · {t.timeframe}</p>)}
     <div className="related-structures">{record.result.analysis.evidence.map(e=>{const f=record.context.facts.find(f=>f.id===e.structureId);return f?<button key={e.structureId} onClick={()=>props.onLocate(f,record)}>{e.timeframe} {f.type} · 结构依据</button>:null;})}</div>
     <details><summary>确认、重新评估条件与不确定性</summary>{record.result.analysis.confirmationConditions.map((c,i)=><p key={'c'+i}>关注：{c}</p>)}{record.result.analysis.reevaluateWhen.map((c,i)=><p key={'r'+i}>重新评估：{c}</p>)}{[...record.result.analysis.conflicts,...record.result.analysis.uncertainties,...record.result.staleReasons].map((c,i)=><p key={'u'+i}>{c}</p>)}</details>
     <p className="account-sync-meta">账户 {record.result.accountSnapshotId} · 行情 {record.result.marketSnapshotId} · 状态 v{record.result.stateVersion} · 生成 {stamp(record.result.generatedAt)}。建议未执行任何交易操作。</p>
    </div>}
    <details className="position-account-details"><summary>账户数据与保证金详情</summary>
    <dl className="position-risk-grid"><div><dt>实际开仓均价</dt><dd>{value(selected.entryPrice)}</dd></div><div><dt>交易所标记价</dt><dd>{value(selected.markPrice)}</dd></div><div><dt>实际数量 / 单位</dt><dd>{selected.quantity} {selected.quantityUnit??'未知'}</dd></div><div><dt>杠杆 / 保证金模式</dt><dd>{value(selected.leverage,'×')} · {selected.marginMode}</dd></div><div><dt>交易所未实现盈亏</dt><dd>{value(selected.unrealizedPnl,selected.marginAsset??'')}</dd></div><div><dt>初始保证金（交易所）</dt><dd>{value(selected.initialMargin,selected.marginAsset??'')}</dd></div><div><dt>交易所强平参考价</dt><dd>{value(selected.liquidationPrice)}</dd></div><div><dt>可用余额（交易所）</dt><dd>{value(snapshot.balances.find(b=>b.asset===selected.marginAsset)?.availableBalance??null,selected.marginAsset??'')}</dd></div></dl>
    <p className="account-sync-meta">来源 Binance USDⓈ-M · {selected.contractType??'合约类型未知'} · 账户同步 {stamp(snapshot.syncedAt)} · 交易所时间 {stamp(snapshot.exchangeTime)} · 持仓更新 {selected.exchangeUpdateTime?stamp(selected.exchangeUpdateTime):'未提供'}</p>
    </details>
    {selected.warnings.map((w,i)=><p className="research-conflict" key={i}>{w}</p>)}
    <ProtectionOrdersPanel value={current?(context?.exchangeProtection??positionProtection(snapshot,selected)):{...(context?.exchangeProtection??positionProtection(snapshot,selected)),validity:'stale',stopCoverage:'unknown'}}/>
    {selected.symbol!==props.symbol?<div className="advanced-empty"><p>请加载该标的的15m / 5m / 1m行情后再审阅。当前没有冒用其他标的背景。</p><button className="button secondary" disabled={props.busy||!selected.symbol.endsWith('USDT')} onClick={()=>props.onSymbol(selected.symbol)}>切换该持仓行情</button>{!selected.symbol.endsWith('USDT')&&<p>现有公共行情系统仅支持USDT合约，此持仓暂仅展示账户数据。</p>}</div>:<>
     <label className="position-plan-link">关联原交易计划（明确选择）<select aria-label="关联原交易计划" value={linked?.planId??''} disabled={props.busy} onChange={e=>props.onLink(selected,e.target.value||null)}><option value="">未关联 · 不推断原始入场理由</option>{plans.map(p=><option key={p.id} value={p.id}>{p.id.slice(0,25)} · v{p.versions.at(-1)!.version}</option>)}</select></label>
     {oldLink&&!linked&&<p className="research-conflict">持仓数量、均价或保证金信息变化，原关联需由你重新确认。</p>}
     {context&&<>
      <div className="research-actions"><button className="button secondary" onClick={()=>props.onPlot(selected.id,false)}>图表查看当前持仓</button>{record&&<button className="button secondary" onClick={()=>props.onPlot(selected.id,true)}>查看原审阅快照</button>}</div>
      <div className="position-observations"><h4>本地风险观察 · 不调用AI</h4>{context.observations.length?context.observations.map((o,i)=><p className={o.kind==='missing-original-plan'?'':'research-conflict'} key={i}>{o.reason}</p>):<p>当前未发现所定义的主要结构冲突，仍需持续核对保护与真实订单。</p>}</div>
      <p>已设固定SL结构核验：{context.existingProtectionReference?`${formatPrice(context.existingProtectionReference.price)} 通过5m结构、ATR与数量检查，可作为TP审阅的保护参考；不保证执行。`:'尚无通过5m结构与风险检查的全量固定SL参考；不会仅凭挂单存在认可其合理性。'}</p>
      <dl className="position-risk-grid"><div><dt>相对实际成本的方向价格距离</dt><dd>{value(context.metrics.signedPriceDistance)}</dd></div><div><dt>方向价格变化（未计成本）</dt><dd>{value(context.metrics.priceChangePct,'%')}</dd></div><div><dt>强平价格距离（不是概率）</dt><dd>{value(context.metrics.liquidationDistancePct,'%')}</dd></div><div><dt>本地价格盈亏估算（不含成本）</dt><dd>{value(context.metrics.estimatedPricePnl,'USDT')}</dd></div><div><dt>原目标 / 实际入场参考R</dt><dd>{value(context.metrics.actualEntryR,'R')}</dd></div><div><dt>原目标 / 当前剩余参考R</dt><dd>{value(context.metrics.remainingR,'R')}</dd></div></dl>
      <details className="position-comparison"><summary>原计划与当前持仓对比</summary>{context.originalPlan?<><p>原计划 v{context.originalPlan.version} · 参考入场 {formatPrice(context.originalPlan.setup.entry)} / 实际均价 {value(selected.entryPrice)}</p><p>原参考SL {formatPrice(context.originalPlan.setup.stopLoss)} · 原TP {context.originalPlan.setup.targets.map(t=>formatPrice(t.price)).join(' / ')}</p><p>当前5m保护可核验：{context.originalProtectionUsable?'通过既有ATR风险检查':'待复核'}；关联不证明实际按此计划成交。</p>{context.originalPlan.reviewReasons.map((r,i)=><p key={i}>{r}</p>)}</>:<p>未关联原计划，不编造原始交易假设。</p>}<p>当前行情快照 {context.market.snapshotId} · v{context.market.stateVersion} · {stamp(context.market.asOf*1000)}</p>{context.limitations.map((l,i)=><p key={i}>{l}</p>)}</details>
     </>}
     {!context&&<p className="account-sync-meta">{contextResult.error}{props.preparing&&' 正在后台加载，可点击审阅等待准备完成。'}</p>}
     {contextResult.error&&props.state&&<button className="button secondary" disabled={props.busy} onClick={props.onPrepare}>刷新多周期行情</button>}

    </>}

   </article>}
  </>}
  <details><summary>本地手动登记持仓 · {props.state?.positions.length??0}</summary>{props.state?.positions.map(p=><p key={p.id}>用户手动登记 · {p.direction==='bullish'?'多':'空'} · 实际均价 {formatPrice(p.entry)} · 数量 {p.quantity} · {p.status}。未由交易所核验。</p>)}</details>
 </section>;
}
export function PositionAttention({state}:{state:MarketState}){
 const {status}=useAccount(),snapshot=status.snapshot;if(!snapshot?.positions.length)return null;
 const relevant=snapshot.positions.filter(p=>p.symbol===state.symbol);
 const observations=relevant.flatMap(position=>{const link=state.exchangePlanLinks?.find(l=>l.positionId===position.id&&l.identity===positionIdentity(position));try{return buildPositionManagement(state,snapshot,position,exchangeLinkedPlan(state,link)).observations.filter(o=>o.kind!=='missing-original-plan').map(o=>({position,observation:o}));}catch{return [];}});
 return <details className="position-attention" open={observations.length>0}><summary>持仓相关变化 · {relevant.length} 笔当前标的持仓</summary>{!usableAccount(status)&&<p className="research-conflict">账户快照过期或异常，下列观察不代表当前仓位。</p>}{observations.length?observations.slice(0,8).map(({position,observation},i)=><p className="research-conflict" key={i}>{position.symbol} {position.positionSide}：{observation.reason}</p>):<p>暂无符合本地规则的主要持仓结构变化；可到持仓管理主动审阅。</p>}</details>;
}
