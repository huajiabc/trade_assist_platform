import type { ChartImage } from '../../shared/analysisInput';
import type { AnalysisDiagnostics } from '../../shared/analysisDiagnostics';
export function AnalysisRunDetails({images,diagnostics}:{images:ChartImage[];diagnostics?:AnalysisDiagnostics}){
 if(!images.length&&!diagnostics)return null;
 return <details className="analysis-run-details"><summary>本次输入与耗时{diagnostics?' · '+(diagnostics.elapsedMs/1000).toFixed(1)+'秒 · '+diagnostics.attempts+'次调用':''}</summary>
 {diagnostics&&<p>{diagnostics.inputMode==='hybrid'?'截图 + 紧凑数据':'完整数据'} · 适配器及模型 {(diagnostics.providerMs/1000).toFixed(1)}秒 · 校验 {diagnostics.validationMs}毫秒 · 文本载荷 {(diagnostics.inputBytes/1024).toFixed(1)}KB · 图片 {diagnostics.imageCount}张（{(diagnostics.imageBytes/1024).toFixed(1)}KB）。字节数不是Token统计；截图生成和HTTP传输不计入服务端计时。</p>}
 {images.map(image=><figure key={image.timeframe}><figcaption>{image.symbol} · {image.timeframe} · {image.candleCount}根 · 本次固定输入，无旧AI标注{image.marketContextVersion&&' · 含时段参考与相对量能'}</figcaption><img src={'data:image/png;base64,'+image.base64} alt={image.timeframe+' 本次分析的干净K线截图'} width="1280" height="600"/></figure>)}
 </details>;
}
