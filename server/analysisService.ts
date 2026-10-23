import { validateFreshAnalysis } from './analysisPolicy';
import { validateAnalysis, type Analysis, type AnalysisEnvelope } from '../shared/analysis';
import { invalidModelOutput, PublicError, type AnalysisTimeoutDetails } from './errors';
import { modelPayload, type ModelInput } from './provider';
import { randomUUID } from 'node:crypto';
import type { AnalysisDiagnostics } from '../shared/analysisDiagnostics';
import { recordAnalysisTelemetry } from './analysisTelemetry';

type Usage = NonNullable<AnalysisEnvelope['usage']>;
interface ModelResult { analysis: unknown; model: string; usage?: Usage }
interface AnalysisServiceOptions<T> { validate?: (raw:unknown)=>T; provider: 'codex' | 'api'; timeoutMs: number }
export interface ValidatedAnalysisResult<T=Analysis> {
  analysis: T;
  model: string;
  analysisAttempts: 1 | 2;
  diagnostics: AnalysisDiagnostics;
  usage?: Usage;
}

const MAX_REPAIR_BYTES = 65_536;

function validationCategory(error: unknown): AnalysisTimeoutDetails['validationCategory'] {
  const message = error instanceof Error ? error.message : '';
  if (/Required|Expected|Invalid enum|Unrecognized|schemaVersion|Required/i.test(message)) return 'schema';
  if (/引用|ID|重复/.test(message)) return 'references';
  if (/观察计划|交易计划|止损|目标|入场|风险|触发/.test(message)) return 'trade-plan';
  if (/PA|形态|区域|波段/.test(message)) return 'price-action';
  if (/时间|K 线|摆动|确认|价格|坐标|收盘/.test(message)) return 'coordinates';
  return 'other';
}
const categoryNames = { schema: 'JSON格式', references: '结构引用', 'trade-plan': '交易计划', 'price-action': 'PA证据', coordinates: '结构或坐标', other: '结果' };

function validUsage(usage: Usage | undefined): usage is Usage {
  return Boolean(usage && [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens]
    .every(value => Number.isSafeInteger(value) && value >= 0) && usage.cachedInputTokens <= usage.inputTokens);
}

/** Never report a partial counter as the total cost of a corrected analysis. */
function totalUsage(calls: Array<Usage | undefined>): Usage | undefined {
  if (!calls.every(validUsage)) return undefined;
  const total = calls.reduce<Usage>((sum, usage) => ({
    inputTokens: sum.inputTokens + usage!.inputTokens,
    cachedInputTokens: sum.cachedInputTokens + usage!.cachedInputTokens,
    outputTokens: sum.outputTokens + usage!.outputTokens,
  }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
  return validUsage(total) ? total : undefined;
}

function repairFeedback(previousAnalysis: unknown, error: unknown): NonNullable<ModelInput['validationFeedback']> {
  // Both adapters already bound their output. Also bound what can be copied
  // into another paid request, and reject values that are not transport JSON.
  let serialized: string | undefined;
  try { serialized = JSON.stringify(previousAnalysis); } catch { throw invalidModelOutput(); }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_REPAIR_BYTES) throw invalidModelOutput();
  return {
    previousAnalysis: JSON.parse(serialized) as unknown,
    error: (error instanceof Error ? error.message : '分析 JSON 未通过校验。').slice(0, 1_000),
  };
}

/** One initial call and, only for a returned JSON validation failure, one
 * correction using the same provider and fixed snapshot. The deadline covers
 * both calls; adapters must finish abort cleanup before the route unlocks. */
export async function analyzeWithValidation<T=Analysis>(
  input: ModelInput,
  run: (input: ModelInput) => Promise<ModelResult>,
  options: AnalysisServiceOptions<T>,
): Promise<ValidatedAnalysisResult<T>> {
  const controller = new AbortController();
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  let providerMs=0,validationMs=0,outcome:'success'|'error'='error',model:string|null=null,errorCode:string|null=null;
  const requestId=randomUUID(),inputBytes=Buffer.byteLength(JSON.stringify(modelPayload(input)));
  const diagnostics=():AnalysisDiagnostics=>({requestId,inputMode:input.visuals?.length?'hybrid':'data',elapsedMs:Math.max(0,Date.now()-startedAt),providerMs,validationMs,attempts,inputBytes,imageCount:input.visuals?.length??0,imageBytes:(input.visuals??[]).reduce((n,image)=>n+Buffer.byteLength(image.base64,'base64'),0)});
  let stage: AnalysisTimeoutDetails['stage'] = 'initial-response';
  let attempts = 0, completedModelCalls = 0;
  let firstResponseMs: number | null = null;
  let category: AnalysisTimeoutDetails['validationCategory'] = null;
  let timedOut = false;
  const cancel = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener('abort', cancel, { once: true });
  if (input.signal?.aborted) cancel();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs);
  const ensureActive = () => {
    if (!controller.signal.aborted && Date.now() >= deadline) {
      timedOut = true;
      controller.abort();
    }
    if (controller.signal.aborted) throw new Error('Analysis request aborted');
  };
  const usage: Array<Usage | undefined> = [];
  let feedback: ModelInput['validationFeedback'];
  try {
    for (const attempt of [1, 2] as const) {
      ensureActive();
      attempts = attempt;
      stage = attempt === 1 ? 'initial-response' : 'correction-response';
      // Transport/auth/network/parse errors are outside the validation catch:
      // retrying those could spend quota without a usable correction target.
      const callStart=Date.now();
      let result:ModelResult;
      try { result=await run({ ...input, signal: controller.signal, ...(feedback ? { validationFeedback: feedback } : {}) }); }
      finally { providerMs+=Math.max(0,Date.now()-callStart); }
      model=result.model;
      completedModelCalls++;
      if (firstResponseMs === null) firstResponseMs = Date.now() - startedAt;
      stage = 'result-validation';
      ensureActive();
      usage.push(result.usage);
      let analysis: T;
      const validationStart=Date.now();
      try {
        analysis = options.validate ? options.validate(result.analysis) : validateFreshAnalysis(result.analysis, input) as T;
      } catch (error) {
        category = validationCategory(error);
        if (attempt === 2) throw invalidModelOutput();
        feedback = repairFeedback(result.analysis, error);
        continue;
      } finally { validationMs+=Math.max(0,Date.now()-validationStart); }
      const total = totalUsage(usage);
      outcome='success';
      return { analysis, model: result.model, analysisAttempts: attempt, diagnostics:diagnostics(), ...(total ? { usage: total } : {}) };
    }
    throw invalidModelOutput();
  } catch (error) {
    errorCode=error instanceof PublicError?error.code:'PROVIDER_UNAVAILABLE';
    if (controller.signal.aborted) {
      if (!timedOut) {errorCode='ANALYSIS_CANCELLED';throw new PublicError(499, 'ANALYSIS_CANCELLED', '本次分析已取消。');}
      errorCode=options.provider==='codex'?'CODEX_TIMEOUT':'PROVIDER_TIMEOUT';
      const details: AnalysisTimeoutDetails = { stage, attempts, completedModelCalls, budgetMs: options.timeoutMs,
        elapsedMs: Math.max(0, Date.now() - startedAt), firstResponseMs, validationCategory: category };
      const reason = stage === 'correction-response'
        ? '首次结果未通过' + categoryNames[category ?? 'other'] + '校验，第2次修正调用尚未完成'
        : stage === 'initial-response' ? '第1次调用尚未返回完整结果' : '完整结果返回时总预算已用尽';
      throw new PublicError(504, options.provider === 'codex' ? 'CODEX_TIMEOUT' : 'PROVIDER_TIMEOUT',
        (options.provider === 'codex' ? 'Codex' : '模型') + '分析超时：' + reason + '。总预算' + Math.ceil(options.timeoutMs / 1000) + '秒，已发起' + attempts + '次调用；两次调用共用预算。', details);
    }
    if (error instanceof PublicError) throw error;
    throw new PublicError(502, 'PROVIDER_UNAVAILABLE', '模型服务处理失败，请检查服务端配置后重试。');
  } finally {
    recordAnalysisTelemetry(diagnostics(),{provider:options.provider,kind:input.workbench?'multi':'single',outcome,model,errorCode,validationCategory:category});
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', cancel);
  }
}
