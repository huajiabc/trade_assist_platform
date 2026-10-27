import type { ResearchTimings as Timing } from '../../shared/researchScan';
export function ResearchTimings({value}:{value:Timing|null}){
 if(!value)return null;
 return <details className="research-phase-timings"><summary>分阶段耗时 · {(value.totalMs/1000).toFixed(1)}秒{value.reusedSnapshot?' · 复用行情快照':''}</summary><dl>{([['行情请求',value.marketMs],['规则计算',value.rulesMs],['截图生成',value.screenshotMs],['模型调用',value.modelMs],['结果校验',value.validationMs],['总耗时',value.totalMs]] as const).map(([label,ms])=><div key={label}><dt>{label}</dt><dd>{(ms/1000).toFixed(2)}秒</dd></div>)}</dl><p>快照 {value.snapshotId} · 状态 v{value.stateVersion}。总耗时包含账户同步、HTTP传输等额外开销；模型耗时来自服务端统计，未调用时为0。</p></details>;
}
