import { formatDisplayTime } from '../../shared/displayTime';
import { CheckCircle, Clock, SpinnerGap, WarningCircle, XCircle } from '@phosphor-icons/react';
import type { AnalysisSnapshot } from '../analysisSession';

export type AnalysisTask = { phase: 'idle' | 'running' | 'success' | 'error' | 'cancelled'; snapshot: AnalysisSnapshot | null; message: string };
const sourceNames = { codex: 'Codex 额度', api: 'API Key', mock: '模拟分析' };
const utc = (timestamp: number) => formatDisplayTime(timestamp);

export function AnalysisStatus({ task, resultSnapshot, stale, hiddenEvidence, elapsedSeconds, compact = false, onCancel }: {
  task: AnalysisTask; resultSnapshot: AnalysisSnapshot | null;
  stale: boolean; hiddenEvidence: boolean; elapsedSeconds: number; compact?: boolean; onCancel: () => void;
}) {
  const running = task.phase === 'running';
  if (task.phase === 'idle' && !resultSnapshot) return null;
  const input = running ? task.snapshot : resultSnapshot ?? task.snapshot;
  const icon = running ? <SpinnerGap className="spin" size={16}/> : task.phase === 'error' ? <WarningCircle size={16}/>
    : task.phase === 'cancelled' ? <XCircle size={16}/> : stale ? <Clock size={16}/> : <CheckCircle size={16}/>;
  const title = running ? `正在分析 · ${sourceNames[task.snapshot!.source]} · ${task.snapshot!.candles.length} 根 K 线`
    : task.phase === 'error' ? '分析失败' : task.phase === 'cancelled' ? '分析已取消'
    : stale ? '行情已更新，当前结果需复核' : '分析结果已就绪';
  return <section className={`analysis-task-status ${compact ? 'is-compact' : ''} phase-${task.phase} ${stale ? 'is-stale' : ''}`}
    aria-label={compact ? '图表分析状态' : '分析任务状态'}>
    <div className="analysis-task-heading">{icon}<strong aria-live="polite" aria-atomic="true">{title}</strong>{running && <span className="analysis-task-elapsed" aria-live="off">已等待 {elapsedSeconds} 秒</span>}</div>
    {running ? <p>使用固定行情快照，实时更新不会中断。{task.snapshot?.source === 'codex' ? 'Codex 可能需要几分钟。' : ''}{task.snapshot?.source !== 'mock' ? '校验失败时最多自动修正 1 次，最多调用模型 2 次。' : ''}</p>
      : task.phase === 'error' || task.phase === 'cancelled' ? <p className="analysis-task-message">{task.message}{resultSnapshot && ' 上次成功结果仍保留。'}</p> : null}
    {input && <p className="analysis-task-cutoff">{running ? '本次输入末根' : resultSnapshot ? '分析末根' : '本次输入末根'}：<time dateTime={new Date(input.asOf * 1000).toISOString()}>{utc(input.asOf)} UTC+8</time>（开盘时间）{!running && resultSnapshot ? ` · ${sourceNames[resultSnapshot.source]}` : ''}</p>}
    {input && <p className="analysis-task-cutoff">固定输入 {input.candles.length} 根 · 起点 <time dateTime={new Date(input.candles[0].timestamp * 1000).toISOString()}>{utc(input.candles[0].timestamp)} UTC+8</time> · {input.selectionMode === 'manual' ? '手动范围' : '自动范围'}</p>}
    {stale && !running && <p className="analysis-task-stale">保留原快照解读；如需最新结论，请手动重新分析。</p>}
    {hiddenEvidence && <p className="analysis-task-stale">部分依据已移出时间窗口或原行情被修订，已隐藏对应标注。完整结果可导出。</p>}
    {running && <button className="button secondary analysis-cancel-button" onClick={onCancel}>取消分析</button>}
  </section>;
}
