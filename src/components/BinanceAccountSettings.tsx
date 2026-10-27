import { formatDisplayTime } from '../../shared/displayTime';
import { useAccount } from '../accountContext';
const stamp=(value:number|null)=>value===null?'尚无':formatDisplayTime(value/1000,true)+' UTC+8';
export function BinanceAccountSettings({compact=false}:{compact?:boolean}){
 const account=useAccount(),{status,busy}=account;
 const validity={fresh:'数据有效',partial:'部分字段缺失',stale:'旧快照 · 待同步',unavailable:'数据不可用',disconnected:'未连接'}[status.validity];
 return <section className={'binance-account-settings'+(compact?' compact':'')} aria-label="Binance只读账户连接">
  <div className="account-heading"><strong>Binance USDⓈ-M · 只读账户</strong><span className={status.validity==='fresh'?'account-good':'account-muted'}>{status.syncing?'同步中…':validity}</span></div>
  {!compact&&<><p>凭据仅在服务端配置 <code>BINANCE_API_KEY</code> 与 <code>BINANCE_API_SECRET</code>，修改后重启服务。网页不录入、读取或保存明文密钥。</p><p>请在 Binance API 管理关闭交易与提现权限，尽可能启用 IP 白名单。程序的只读白名单不能代替交易所权限设置，也无法证明该 Key 天然只读。</p><p>使用 HMAC 类型 API Key；程序仅支持本机访问，不提供远程账户登录。</p></>}
  <p className="account-sync-meta">凭据：{status.configured?'服务端已配置（不回显）':'服务端未配置'} · 最近成功 {stamp(status.lastSuccessAt)} · 后端每 {status.pollIntervalMs/1000} 秒同步</p>
  <div className="research-actions"><button className="button secondary" disabled={busy||!status.configured} onClick={()=>void account.connect()}>{status.connected?'重新测试连接':'测试并连接'}</button><button className="button secondary" disabled={busy||!status.connected} onClick={()=>void account.refresh()}>刷新账户</button><button className="button text-button" disabled={busy||!status.connected} onClick={()=>void account.disconnect()}>断开账户</button></div>
  {(account.error||status.error)&&<p role="alert" className="research-conflict">{account.error||status.error?.message}</p>}
  {status.nextRetryAt&&<p className="account-sync-meta">限流/失败退避：{stamp(status.nextRetryAt)} 后重试；不会持续轰炸接口。</p>}
 </section>;
}
