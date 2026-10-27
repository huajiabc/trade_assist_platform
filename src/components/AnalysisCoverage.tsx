import { formatDisplayTime } from '../../shared/displayTime';
import type { Analysis } from '../../shared/analysis';
import type { Candle } from '../../shared/market';
import { summarizeAnalysisAnnotations } from '../analysisCoverage';

const utc = (timestamp: number) => `${formatDisplayTime(timestamp, true)} UTC+8`;
const countingRule = '按结构结束或事件发生时间计数；跨段结构只计一次，不代表逐根分析覆盖率。统计原始返回结果，不随图层开关变化。';

export function AnalysisCoverage({ analysis, candles }: { analysis: Analysis; candles: readonly Candle[] }) {
  const distribution = summarizeAnalysisAnnotations(analysis, candles);
  const emptyLabels = distribution.segments.filter(segment => segment.count === 0).map(segment => segment.label).join('、');
  return <section className="analysis-annotation-distribution" aria-label="历史标注分布">
    <div className="annotation-distribution-row">
      <strong>历史标注分布</strong>
      {distribution.segments.map(segment => <span key={segment.key}
        className={`annotation-distribution-count ${segment.count === 0 ? 'is-empty' : ''}`}
        title={`${utc(segment.from)} → ${utc(segment.to)} · ${segment.barCount} 根 K 线`}
        aria-label={`${segment.label} ${segment.count} 项，${utc(segment.from)} 至 ${utc(segment.to)}，${segment.barCount} 根 K 线`}>
        {segment.label}<b>{segment.count}</b>项
      </span>)}
    </div>
    {distribution.invalidInput ? <p className="annotation-distribution-notice">原分析行情时间无效，无法统计历史标注分布。</p>
      : !distribution.segments.length ? <p className="annotation-distribution-notice">缺少原分析行情，无法统计历史标注分布。</p>
      : distribution.total === 0 ? <p className="annotation-distribution-notice">本次结果未返回可绘制的历史标注，不表示没有结构；可缩小范围复核或重新分析。</p>
      : emptyLabels ? <p className="annotation-distribution-notice">{emptyLabels}未返回锚定于该段的标注，不表示没有结构；可缩小范围复核或重新分析。</p> : null}
    {distribution.segments.length > 0 && <small title={countingRule}>{countingRule}</small>}
  </section>;
}
