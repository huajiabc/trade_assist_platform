import { analysisDiagnosticsSchema } from '../../shared/analysisDiagnostics';
import type { AnalysisInputMode, ChartImage } from '../../shared/analysisInput';
import { z } from 'zod';
import { readResponse, type AnalysisSource } from './api';
import { RESEARCH_FRAMES, makeResearchBundle, type FrameInput, type ResearchBundle } from '../../shared/researchData';
import { validateWorkbenchInterpretation, workbenchOutputSchema, type WorkbenchModelContext } from '../../shared/workbenchAnalysis';
const responseSchema=z.object({catalogVersion:z.string().optional(),schemaVersion:z.literal('research-response-1.0'),snapshotId:z.string(),stateVersion:z.number().int(),source:z.enum(['ai','mock']),provider:z.enum(['codex','api','mock']),model:z.string(),generatedAt:z.string(),analysisAttempts:z.number().int().min(0).max(2),diagnostics:analysisDiagnosticsSchema.optional(),analysis:workbenchOutputSchema,usage:z.object({inputTokens:z.number(),cachedInputTokens:z.number(),outputTokens:z.number()}).optional()}).strict();
export function frameInput(frame:ResearchBundle['frames']['1m']):FrameInput {const {id:_id,integrity:_integrity,...input}=frame;return input;}
export async function getResearchMarket(symbol:string,signal:AbortSignal):Promise<ResearchBundle>{
 const raw=await readResponse(await fetch('/api/research/market?'+new URLSearchParams({symbol,limit:'300'}),{signal})) as ResearchBundle;
 if(!raw||raw.symbol!==symbol||raw.version!=='1.0'||!raw.frames)throw new Error('研究行情响应与标的不一致。');
 const bundle=makeResearchBundle(symbol,RESEARCH_FRAMES.map(tf=>frameInput(raw.frames[tf])),raw.asOf);
 if(bundle.id!==raw.id)throw new Error('研究行情数据身份不一致。');return bundle;
}
export async function requestResearch(context:WorkbenchModelContext,source:AnalysisSource,notes:string,signal:AbortSignal,visual?:{inputMode:AnalysisInputMode;images:ChartImage[]}){
 const response=await fetch('/api/research/analyze',{method:'POST',headers:{'Content-Type':'application/json'},signal,body:JSON.stringify({bundle:{symbol:context.bundle.symbol,asOf:context.bundle.asOf,frames:RESEARCH_FRAMES.map(tf=>frameInput(context.bundle.frames[tf]))},previous:context.previous,planPolicy:context.planPolicy,provider:source,notes,...visual})});
 const result=responseSchema.parse(await readResponse(response));
 if(result.snapshotId!==context.bundle.id||result.stateVersion!==context.previous.version||result.provider!==source)throw new Error('研究结果与请求快照、状态版本或来源不一致。');
 if(result.catalogVersion&&context.catalogVersion&&result.catalogVersion!==context.catalogVersion)throw new Error('策略目录已更新，请刷新页面并重新审阅；原结果没有应用到当前候选。');
 return {...result,analysis:validateWorkbenchInterpretation(result.analysis,context)};
}
