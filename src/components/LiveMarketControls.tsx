import { useEffect, useState } from 'react';
import { ArrowsClockwise, Broadcast, SpinnerGap, WarningCircle } from '@phosphor-icons/react';
import { LIVE_INTERVALS, liveMarketQuerySchema, type LiveMarketQuery, type MarketSnapshot } from '../../shared/liveMarket';
import type { FeedTransport } from '../../shared/realtime';

interface Props {
  initialQuery?: LiveMarketQuery;
  snapshot: MarketSnapshot | null;
  loading: boolean;
  refreshing: boolean;
  error: string;
  autoRefresh: boolean;
  connected: boolean;
  transport: FeedTransport;
  lastEventTime: number;
  streamMessage: string;
  onAutoRefresh: (enabled: boolean) => void;
  onConnect: (query: LiveMarketQuery) => void;
  onRefresh: () => void;
}

export function LiveMarketControls(props: Props) {
  const [symbol, setSymbol] = useState(props.initialQuery?.symbol ?? 'SNDKUSDT');
  const [interval, setInterval] = useState<string>(props.initialQuery?.interval ?? '5m');
  const [formError, setFormError] = useState('');
  useEffect(() => {
    if (props.snapshot) { setSymbol(props.snapshot.symbol); setInterval(props.snapshot.interval); }
  }, [props.snapshot?.symbol, props.snapshot?.interval]);
  const error = formError || props.error;
  function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = liveMarketQuerySchema.safeParse({ symbol, interval, limit: 300 });
    if (!parsed.success) { setFormError('请输入有效的 USDT 合约标的，例如 SNDKUSDT。'); return; }
    setFormError(''); props.onConnect(parsed.data);
  }
  return <section className="live-market-panel" aria-label="真实行情连接" id="live-market">
    <form className="live-market-form" onSubmit={submit}>
      <div className="live-market-heading"><Broadcast size={19}/><div><h2>交易所行情</h2><span>Binance USDⓈ-M · 公共只读接口</span></div></div>
      <div className="live-field"><label htmlFor="market-symbol">合约标的</label><input id="market-symbol" value={symbol} maxLength={24} onChange={e => setSymbol(e.target.value.toUpperCase())} spellCheck={false} autoComplete="off"/></div>
      <div className="live-field interval-field"><label htmlFor="market-interval">K 线周期</label><select id="market-interval" value={interval} onChange={e => setInterval(e.target.value)}>{LIVE_INTERVALS.map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></div>
      <button className="button secondary" type="submit" disabled={props.loading}>{props.loading ? <SpinnerGap className="spin" size={16}/> : <Broadcast size={16}/>}加载行情</button>
      {props.snapshot && <button className="icon-button market-refresh" type="button" aria-label="刷新真实行情" title="刷新真实行情" disabled={props.loading || props.refreshing} onClick={props.onRefresh}><ArrowsClockwise size={18} className={props.refreshing ? 'spin' : ''}/></button>}
      <label className="live-auto"><input type="checkbox" checked={props.autoRefresh} onChange={e => props.onAutoRefresh(e.target.checked)}/>实时更新</label>
    </form>
    {props.snapshot && <div title={props.streamMessage||undefined} className={`live-market-status ${error || props.transport === 'fallback' ? 'market-stale' : ''}`}><span className="status-dot"/><span>{error ? '更新失败 · 保留上次真实数据' : !props.autoRefresh ? '实时更新已暂停' : props.transport === 'streaming' ? 'WebSocket 实时连接' : props.transport === 'fallback' ? '推送重连中 · 轮询回退' : props.refreshing ? '正在同步行情' : '实时流连接中'}<span> · </span>{props.snapshot.symbol}<span> · </span>{props.snapshot.symbol === 'SNDKUSDT' ? 'Sandisk 股票永续' : 'USDT 永续'}<span> · </span>末根{props.snapshot.lastCandleClosed ? '已收盘' : '未收盘（分析时排除）'}</span><time>{props.transport === 'streaming' && props.lastEventTime ? `行情时间 ${new Date(props.lastEventTime).toISOString().slice(11, 19)}` : `获取于 ${new Date(props.snapshot.fetchedAt).toISOString().slice(11, 19)}`} UTC</time></div>}
    {props.snapshot && props.transport === 'fallback' && !error && <p className="stream-fallback-note">{props.streamMessage || '实时推送暂时中断，已启用 30 秒轮询，连接恢复后自动切回推送。'}</p>}
    {!props.snapshot && props.autoRefresh && props.transport === 'fallback' && props.streamMessage && <p className="stream-fallback-note">{props.streamMessage}</p>}
    {error && <div className="live-market-error" role="alert"><WarningCircle size={16}/>{error}</div>}
  </section>;
}
