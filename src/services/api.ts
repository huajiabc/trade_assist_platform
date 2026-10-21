import { z } from 'zod';
import { validateAnalysisEnvelope, type AnalysisEnvelope } from '../../shared/analysis';
import { MAX_ANALYSIS_CANDLES, type Candle } from '../../shared/market';

export type AnalysisMode = 'auto' | 'mock' | 'ai';
export type AnalysisSource = 'codex' | 'api' | 'mock';
export type AnalysisContext = { symbol: string; timeframe: string; notes: string };
const healthSchema = z.object({
  configured: z.boolean(), model: z.string(), provider: z.enum(['codex', 'openai-compatible', 'mock']),
  maxAnalysisCandles: z.number().int().positive(),
  codex: z.object({ available: z.boolean(), authenticated: z.boolean(), message: z.string() }).optional(),
  codexSettings: z.object({ model: z.string(), reasoningEffort: z.string().nullable(), serviceTier: z.enum(['fast']).nullable() }).optional(),
  providers: z.object({ codex: z.boolean(), api: z.boolean() }).optional(),
  activeProvider: z.enum(['codex', 'api', 'mock']).optional(),
});
export type Health = z.infer<typeof healthSchema>;

export async function readResponse(response: Response): Promise<unknown> {
  let data: unknown;
  try { data = await response.json(); } catch { throw new Error('服务返回了非 JSON 响应，请检查后端是否已启动。'); }
  if (!response.ok) {
    const error = z.object({ error: z.union([z.string(), z.object({ message: z.string() })]).optional(), message: z.string().optional() }).safeParse(data);
    const message = error.success ? (typeof error.data.error === 'string' ? error.data.error : error.data.error?.message || error.data.message) : null;
    throw new Error(message || `请求失败（${response.status}），请稍后重试。`);
  }
  return data;
}

export async function getHealth(signal: AbortSignal): Promise<Health> {
  return healthSchema.parse(await readResponse(await fetch('/api/health', { signal })));
}

export async function requestAnalysis(candles: Candle[], context: AnalysisContext, mode: AnalysisMode, signal: AbortSignal, provider?: 'codex' | 'api'): Promise<AnalysisEnvelope> {
  const data = await readResponse(await fetch('/api/analyze', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candles, context, mode, ...(provider ? { provider } : {}) }), signal,
  }));
  const window = candles.slice(-MAX_ANALYSIS_CANDLES);
  return validateAnalysisEnvelope(data, window);
}
