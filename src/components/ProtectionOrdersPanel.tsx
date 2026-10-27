import { formatDisplayTime } from '../../shared/displayTime';
import type {PositionProtection,ProtectionOrder} from '../../shared/protectionOrders';
import {formatPrice} from '../../shared/format';
const price=(n:number|null)=>n===null?'未提供':formatPrice(n);
export function ProtectionOrdersPanel({value}:{value:PositionProtection}){
 const groups:[string,ProtectionOrder[]][]=[['固定止损',value.stops],['止盈',value.targets],['移动止损',value.trailing],['限价减仓',value.limits],['用途或状态待核',value.uncertain]];
 return <section className="position-exchange-orders" aria-label="交易所现有止损止盈"><h4>交易所现有订单 · 只读</h4>
  <p>{value.validity==='fresh'?'本次查询完整':value.validity==='partial'?'部分订单读取失败':value.validity==='stale'?'订单快照已过期':'订单尚不可用'} · 固定止损覆盖：{({full:'至少一笔匹配单覆盖当前数量',partial:'仅部分数量',none:'未查到匹配固定SL',unknown:'无法确认'})[value.stopCoverage]}</p>
  {value.syncedAt&&<small>订单读取 {formatDisplayTime(value.syncedAt/1000,true)} UTC+8</small>}
  {groups.map(([label,orders])=><details key={label} open={orders.length>0}><summary>{label} · {orders.length}</summary>{orders.slice(0,30).map(o=><article className="position-existing-order" key={o.id}><b>{o.kind==='trailing-stop'?'激活价（不是当前SL）':o.triggerPrice!==null?'触发价':'委托限价'} {price(o.kind==='trailing-stop'?o.activationPrice:o.triggerPrice??o.limitPrice)}</b><p>{o.orderType} · {o.side} / {o.positionSide} · {o.status}</p><p>{o.closePosition?'Close Position · 全部平仓':`剩余数量 ${o.remainingQuantity??'未知'}`} · Reduce Only {o.reduceOnly===null?'未知':o.reduceOnly?'是':'否'} · {o.workingType==='MARK_PRICE'?'标记价触发':o.workingType==='CONTRACT_PRICE'?'合约最新价触发':'触发价类型未知'}</p>{o.limitPrice!==null&&o.triggerPrice!==null&&<p>触发后的委托限价 {price(o.limitPrice)}，触发不保证成交。</p>}{o.callbackRate!==null&&<p>回调比例 {o.callbackRate}% · 未取得实时追踪止损价</p>}<small>{o.venue==='algo'?'Algo 条件单':'普通订单'} · ID {o.exchangeId} · {o.priceProtect?'启用价格保护；可能延迟触发':'请在交易所核对执行条件'}</small></article>)}{orders.length>30&&<p>面板仅展示前30项，当前匹配共{orders.length}项。</p>}</details>)}
  {value.warnings.map((w,i)=><p className="research-conflict" key={i}>{w}</p>)}
  <small>归属按真实持仓侧、平仓方向与减仓标志核验；挂单不等于保证保护或已经执行。不同触发价格类型不能直接用标记价判断是否触发。</small>
 </section>;
}
