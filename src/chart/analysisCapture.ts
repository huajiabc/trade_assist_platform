import { createChart, CandlestickSeries, HistogramSeries, ColorType, type UTCTimestamp } from 'lightweight-charts';
import type { Candle } from '../../shared/market';
import { chartImageAnchor, MAX_CHART_IMAGE_BYTES, type ChartImage } from '../../shared/analysisInput';
import { candleMarketContexts, hasEquitySessionReference, MARKET_CONTEXT_VERSION } from '../../shared/marketContext';
import { MarketSessionOverlay } from './MarketSessionOverlay';
import { CHART_THEME, withAlpha } from './chartTheme';
import { formatDisplayTime, DISPLAY_TIME_ZONE } from '../../shared/displayTime';
import { chartTimeFormatter, chartTickFormatter } from './chartTime';
/** One temporary instance of our existing chart library per snapshot; always disposed, with no AI overlays. */
export async function captureAnalysisChart(candles:Candle[],symbol:string,timeframe:string,signal:AbortSignal):Promise<ChartImage>{
 if(signal.aborted)throw new DOMException('已取消','AbortError');
 if(candles.length<10||candles.length>300)throw new Error('图表快照需要10–300根K线。');
 const host=document.createElement('div');host.style.cssText='position:fixed;left:-1400px;top:0;width:1280px;height:552px;pointer-events:none';host.setAttribute('aria-hidden','true');document.body.append(host);
 let chart:ReturnType<typeof createChart>|undefined;
 try{chart=createChart(host,{width:1280,height:552,autoSize:false,layout:{background:{type:ColorType.Solid,color:CHART_THEME.background},textColor:CHART_THEME.text,fontSize:12},grid:{vertLines:{color:CHART_THEME.grid},horzLines:{color:CHART_THEME.grid}},rightPriceScale:{minimumWidth:90,scaleMargins:{top:.08,bottom:.23}},timeScale:{timeVisible:true,secondsVisible:false,rightOffset:2,tickMarkFormatter:chartTickFormatter},localization:{locale:'zh-CN',timeFormatter:chartTimeFormatter},handleScale:false,handleScroll:false});
  const series=chart.addSeries(CandlestickSeries,{upColor:CHART_THEME.up,downColor:CHART_THEME.down,wickUpColor:CHART_THEME.wickUp,wickDownColor:CHART_THEME.wickDown,borderVisible:false,priceLineVisible:false,lastValueVisible:true});series.setData(candles.map(b=>({...b,time:b.timestamp as UTCTimestamp})));
  const sessions=new MarketSessionOverlay();series.attachPrimitive(sessions);sessions.setData(candles,symbol,timeframe);
  const rows=candleMarketContexts(candles,symbol,timeframe);
  const volume=chart.addSeries(HistogramSeries,{priceScaleId:'volume',priceFormat:{type:'custom',minMove:.01,formatter:(value:number)=>value.toFixed(1)+'×'},priceLineVisible:false,lastValueVisible:false});volume.priceScale().applyOptions({scaleMargins:{top:.83,bottom:0},visible:false});volume.setData(candles.map((b,i)=>rows[i].relativeVolume===null?{time:b.timestamp as UTCTimestamp}:{time:b.timestamp as UTCTimestamp,value:rows[i].relativeVolume!,color:withAlpha(b.close>=b.open?CHART_THEME.up:CHART_THEME.down,.46)}));volume.createPriceLine({price:1,color:'#68748780',lineWidth:1,axisLabelVisible:false,title:''});chart.timeScale().fitContent();
  await new Promise<void>((resolve,reject)=>{const abort=()=>{cancelAnimationFrame(id);reject(new DOMException('已取消','AbortError'));};const id=requestAnimationFrame(()=>{signal.removeEventListener('abort',abort);resolve();});signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
  if(signal.aborted)throw new DOMException('已取消','AbortError');
  const output=document.createElement('canvas');output.width=1280;output.height=600;const ctx=output.getContext('2d');if(!ctx)throw new Error('浏览器无法导出图表。');ctx.fillStyle=CHART_THEME.background;ctx.fillRect(0,0,1280,600);ctx.fillStyle=CHART_THEME.foreground;ctx.font='13px sans-serif';ctx.fillText(symbol+' · '+timeframe+' · '+candles.length+' closed candles · '+formatDisplayTime(candles[0].timestamp)+' → '+formatDisplayTime(candles.at(-1)!.timestamp)+' '+DISPLAY_TIME_ZONE,16,18);
  ctx.font='11px sans-serif';ctx.fillStyle='#a1acbe';ctx.fillText('RVOL20 = volume / preceding mean (min 5); 1x guide; gaps reset baseline',16,37);
  if(hasEquitySessionReference(symbol)){let x=505;for(const [color,label] of [['#8347b4','Overnight'],['#d1a62f','Pre'],['#b2b5be','Regular: no fill'],['#4f72ad','Post'],['#758094','Closed']]){ctx.fillStyle=color;ctx.fillRect(x,29,7,7);ctx.fillText(label,x+12,37);x+=label.length*6+33;}ctx.fillStyle='#a1acbe';ctx.fillText('NY reference / perp 24-7',1020,37);}
  ctx.drawImage(chart.takeScreenshot(),0,48,1280,552);
  const base64=output.toDataURL('image/png').split(',')[1];if(base64.length>Math.ceil(MAX_CHART_IMAGE_BYTES/3)*4)throw new Error('截图超过256KB，请使用数据模式。');return {...chartImageAnchor(candles,symbol,timeframe),marketContextVersion:MARKET_CONTEXT_VERSION,width:1280,height:600,base64};
 }finally{chart?.remove();host.remove();}
}
