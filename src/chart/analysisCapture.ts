import { createChart, CandlestickSeries, HistogramSeries, ColorType, type UTCTimestamp } from 'lightweight-charts';
import type { Candle } from '../../shared/market';
import { chartImageAnchor, MAX_CHART_IMAGE_BYTES, type ChartImage } from '../../shared/analysisInput';
/** One temporary instance of our existing chart library per snapshot; always disposed, with no AI overlays. */
export async function captureAnalysisChart(candles:Candle[],symbol:string,timeframe:string,signal:AbortSignal):Promise<ChartImage>{
 if(signal.aborted)throw new DOMException('已取消','AbortError');
 if(candles.length<10||candles.length>300)throw new Error('图表快照需要10–300根K线。');
 const host=document.createElement('div');host.style.cssText='position:fixed;left:-1400px;top:0;width:1280px;height:568px;pointer-events:none';host.setAttribute('aria-hidden','true');document.body.append(host);
 let chart:ReturnType<typeof createChart>|undefined;
 try{chart=createChart(host,{width:1280,height:568,autoSize:false,layout:{background:{type:ColorType.Solid,color:'#131722'},textColor:'#b2b5be',fontSize:12},grid:{vertLines:{color:'#20242f'},horzLines:{color:'#20242f'}},rightPriceScale:{minimumWidth:90,scaleMargins:{top:.08,bottom:.23}},timeScale:{timeVisible:true,secondsVisible:false,rightOffset:2},handleScale:false,handleScroll:false});
  const series=chart.addSeries(CandlestickSeries,{upColor:'#089981',downColor:'#f23645',wickUpColor:'#089981',wickDownColor:'#f23645',borderVisible:false,priceLineVisible:false,lastValueVisible:true});series.setData(candles.map(b=>({...b,time:b.timestamp as UTCTimestamp})));
  const volume=chart.addSeries(HistogramSeries,{priceScaleId:'volume',priceFormat:{type:'volume'},priceLineVisible:false,lastValueVisible:false});volume.priceScale().applyOptions({scaleMargins:{top:.83,bottom:0}});volume.setData(candles.map(b=>({time:b.timestamp as UTCTimestamp,value:b.volume,color:b.close>=b.open?'#08998170':'#f2364570'})));chart.timeScale().fitContent();
  await new Promise<void>((resolve,reject)=>{const abort=()=>{cancelAnimationFrame(id);reject(new DOMException('已取消','AbortError'));};const id=requestAnimationFrame(()=>{signal.removeEventListener('abort',abort);resolve();});signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
  if(signal.aborted)throw new DOMException('已取消','AbortError');
  const output=document.createElement('canvas');output.width=1280;output.height=600;const ctx=output.getContext('2d');if(!ctx)throw new Error('浏览器无法导出图表。');ctx.fillStyle='#131722';ctx.fillRect(0,0,1280,600);ctx.fillStyle='#d1d4dc';ctx.font='13px sans-serif';ctx.fillText(symbol+' · '+timeframe+' · '+candles.length+' closed candles · '+new Date(candles[0].timestamp*1000).toISOString().slice(0,16)+' → '+new Date(candles.at(-1)!.timestamp*1000).toISOString().slice(0,16)+' UTC',16,21);ctx.drawImage(chart.takeScreenshot(),0,32,1280,568);
  const base64=output.toDataURL('image/png').split(',')[1];if(base64.length>Math.ceil(MAX_CHART_IMAGE_BYTES/3)*4)throw new Error('截图超过256KB，请使用数据模式。');return {...chartImageAnchor(candles,symbol,timeframe),width:1280,height:600,base64};
 }finally{chart?.remove();host.remove();}
}
