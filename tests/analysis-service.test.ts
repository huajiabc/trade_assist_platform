import request from 'supertest';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { analyzeWithValidation } from '../server/analysisService';
import { createApp } from '../server/app';
import { readServerConfig } from '../server/config';
import { PublicError } from '../server/errors';
import type { ModelInput } from '../server/provider';
import { validateAnalysis } from '../shared/analysis';
import { createMockAnalysis } from '../shared/mock';
import { PA_SAMPLE_CANDLES } from '../shared/paSample';

// Reproduce the live 1m failure without storing live data: a retest wick
// reaches the broken range, but its close is back inside, so it is unconfirmed.
const candles = PA_SAMPLE_CANDLES.map((candle, index) => ({ ...candle,
  timestamp: 1_760_000_040 + index * 60, ...(index === 78 ? { close: 109.6 } : {}) }));
const input: ModelInput = { candles, context: { symbol: 'SNDKUSDT', timeframe: '1m', notes: '已收盘的固定输入' } };
const valid = () => createMockAnalysis(candles);
const invalid = () => {
  const analysis = valid();
  const event = analysis.priceAction.breakouts[0];
  event.status = 'confirmed';
  event.confirmationTime = event.retestTime;
  return analysis;
};
type RunModel = Parameters<typeof analyzeWithValidation>[1];
const options = { provider: 'codex' as const, timeoutMs: 1_000 };
const firstUsage = { inputTokens: 100, cachedInputTokens: 10, outputTokens: 50 };
const secondUsage = { inputTokens: 200, cachedInputTokens: 20, outputTokens: 70 };

afterEach(() => { vi.useRealTimers(); });

describe('bounded validated model correction', () => {
  it('accepts valid output after one call without feedback', async () => {
    const run: Mock<RunModel> = vi.fn<RunModel>(async () => ({ analysis: valid(), model: 'model', usage: firstUsage }));
    const result = await analyzeWithValidation(input, run, options);
    expect(result).toMatchObject({ analysisAttempts: 1, model: 'model', usage: firstUsage });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]).toHaveLength(1);
    expect((run.mock.calls[0] as unknown as [ModelInput])[0]).not.toHaveProperty('validationFeedback');
  });

  it('corrects the false confirmed 1m retest using the same snapshot, signal and provider', async () => {
    const bad = invalid();
    expect(() => validateAnalysis(bad, candles)).toThrow(/站稳确认/);
    const run: Mock<RunModel> = vi.fn<RunModel>(async (_request: ModelInput) => run.mock.calls.length === 1
      ? { analysis: bad, model: 'model', usage: firstUsage }
      : { analysis: valid(), model: 'model', usage: secondUsage });
    const result = await analyzeWithValidation(input, run, options);
    expect(run).toHaveBeenCalledTimes(2);
    const [first, second] = run.mock.calls.map(([call]) => call);
    expect(first.candles).toBe(input.candles);
    expect(second.candles).toBe(input.candles);
    expect(second.context).toBe(input.context);
    expect(second.signal).toBe(first.signal);
    expect(second.validationFeedback?.previousAnalysis).toEqual(bad);
    expect(second.validationFeedback?.error).toMatch(/站稳确认/);
    expect(result).toMatchObject({ analysisAttempts: 2, usage: { inputTokens: 300, cachedInputTokens: 30, outputTokens: 120 } });
    expect(result.analysis.priceAction.breakouts[0]).toMatchObject({ status: 'candidate', confirmationTime: null });
    expect(() => validateAnalysis(result.analysis, candles)).not.toThrow();
    expect(bad.priceAction.breakouts[0].status).toBe('confirmed'); // No silent mutation or deletion.
  });

  it('allows one correction of a returned JSON schema failure', async () => {
    const run: Mock<RunModel> = vi.fn<RunModel>(async (_request: ModelInput) => ({ analysis: run.mock.calls.length === 1 ? {} : valid(), model: 'model' }));
    expect((await analyzeWithValidation(input, run, options)).analysisAttempts).toBe(2);
    expect(run.mock.calls[1][0].validationFeedback).toMatchObject({ previousAnalysis: {} });
  });

  it('rejects repeated invalid output after exactly two calls', async () => {
    const run: Mock<RunModel> = vi.fn<RunModel>(async () => ({ analysis: invalid(), model: 'model' }));
    await expect(analyzeWithValidation(input, run, options)).rejects.toMatchObject({ status: 502, code: 'PROVIDER_INVALID_OUTPUT' });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each(['CODEX_AUTH_REQUIRED', 'CODEX_UNAVAILABLE', 'PROVIDER_HTTP_ERROR', 'PROVIDER_INVALID_OUTPUT', 'PROVIDER_TRUNCATED', 'PROVIDER_REFUSED'])
  ('never retries a transport/provider failure without returned JSON: %s', async code => {
    const error = new PublicError(502, code, 'public error');
    const run: Mock<RunModel> = vi.fn<RunModel>(async () => { throw error; });
    await expect(analyzeWithValidation(input, run, options)).rejects.toBe(error);
    expect(run).toHaveBeenCalledOnce();
  });

  it('does not retry a thrown private error or disclose its contents', async () => {
    const run: Mock<RunModel> = vi.fn<RunModel>(async () => { throw new Error('private provider path or credentials'); });
    const result = await analyzeWithValidation(input, run, options).catch(error => error as PublicError);
    expect(result).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(String(result)).not.toContain('private');
    expect(run).toHaveBeenCalledOnce();
  });

  it('does not add another attempt when the correction provider fails', async () => {
    const run: Mock<RunModel> = vi.fn<RunModel>(async () => {
      if (run.mock.calls.length === 1) return { analysis: invalid(), model: 'model' };
      throw new PublicError(503, 'CODEX_AUTH_REQUIRED', '需要登录');
    });
    await expect(analyzeWithValidation(input, run, options)).rejects.toMatchObject({ code: 'CODEX_AUTH_REQUIRED' });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, { inputTokens: -1, cachedInputTokens: 0, outputTokens: 1 },
    { inputTokens: 1, cachedInputTokens: 2, outputTokens: 1 },
    { inputTokens: Number.MAX_SAFE_INTEGER + 1, cachedInputTokens: 0, outputTokens: 1 }])
  ('omits incomplete or invalid usage instead of fabricating a total: %j', async usage => {
    const run: Mock<RunModel> = vi.fn<RunModel>(async () => run.mock.calls.length === 1
      ? { analysis: invalid(), model: 'model', usage: firstUsage }
      : { analysis: valid(), model: 'model', usage });
    expect(await analyzeWithValidation(input, run, options)).not.toHaveProperty('usage');
  });

  it('omits aggregate counters that would overflow safe integer arithmetic', async () => {
    const usage = { inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: 0, outputTokens: 1 };
    const run: Mock<RunModel> = vi.fn<RunModel>(async () => ({ analysis: run.mock.calls.length === 1 ? invalid() : valid(), model: 'model', usage }));
    expect(await analyzeWithValidation(input, run, options)).not.toHaveProperty('usage');
  });

  it('bounds feedback by UTF-8 size and does not resend oversized model JSON', async () => {
    const run: Mock<RunModel> = vi.fn<RunModel>(async () => ({ analysis: { ...valid(), summary: '中'.repeat(23_000) }, model: 'model' }));
    await expect(analyzeWithValidation(input, run, options)).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
    expect(run).toHaveBeenCalledOnce();
  });

  it('limits validation text copied into the correction request', async () => {
    const run: Mock<RunModel> = vi.fn<RunModel>(async (_request: ModelInput) => ({ analysis: run.mock.calls.length === 1
      ? { ...valid(), trend: 'x'.repeat(2_000) } : valid(), model: 'model' }));
    await analyzeWithValidation(input, run, options);
    expect(run.mock.calls[1][0].validationFeedback!.error.length).toBeLessThanOrEqual(1_000);
  });

  it('honors cancellation before starting a model call', async () => {
    const controller = new AbortController();
    controller.abort();
    const run: Mock<RunModel> = vi.fn<RunModel>(async () => ({ analysis: valid(), model: 'model' }));
    await expect(analyzeWithValidation({ ...input, signal: controller.signal }, run, options))
      .rejects.toMatchObject({ status: 499, code: 'ANALYSIS_CANCELLED' });
    expect(run).not.toHaveBeenCalled();
  });

  it('never starts correction after the HTTP input signal was cancelled', async () => {
    const controller = new AbortController();
    const run: Mock<RunModel> = vi.fn<RunModel>(async () => { controller.abort(); return { analysis: invalid(), model: 'model' }; });
    await expect(analyzeWithValidation({ ...input, signal: controller.signal }, run, options))
      .rejects.toMatchObject({ code: 'ANALYSIS_CANCELLED' });
    expect(run).toHaveBeenCalledOnce();
  });

  it('identifies a first-response timeout without disclosing input or pretending validation failed', async () => {
    vi.useFakeTimers();
    const run: RunModel = async request => await new Promise<never>((_resolve,reject) => request.signal!.addEventListener('abort',()=>reject(new Error('private network detail')), {once:true}));
    const pending=analyzeWithValidation(input,run,{provider:'codex',timeoutMs:100}).catch(error=>error as PublicError);
    await vi.advanceTimersByTimeAsync(100);
    const error=await pending;
    expect(error).toMatchObject({code:'CODEX_TIMEOUT',details:{stage:'initial-response',attempts:1,completedModelCalls:0,firstResponseMs:null,validationCategory:null}});
    if (!(error instanceof PublicError)) throw new Error('Expected a public timeout error');
    expect(error.message).toContain('第1次调用尚未返回完整结果');
    expect(JSON.stringify(error)).not.toContain('private');
  });

  it.each([['codex', 'CODEX_TIMEOUT'], ['api', 'PROVIDER_TIMEOUT']] as const)
  ('shares one overall %s deadline across both calls', async (provider, code) => {
    vi.useFakeTimers();
    const run: Mock<RunModel> = vi.fn<RunModel>(async (request: ModelInput) => {
      if (run.mock.calls.length === 1) {
        await new Promise(resolve => setTimeout(resolve, 60));
        return { analysis: invalid(), model: 'model' };
      }
      return await new Promise<never>((_resolve, reject) => {
        request.signal!.addEventListener('abort', () => reject(new Error('provider aborted')), { once: true });
      });
    });
    let finished = false;
    const result = analyzeWithValidation(input, run, { provider, timeoutMs: 100 })
      .catch(error => error as PublicError).finally(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(60);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(39);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ status: 504, code, details: { stage: 'correction-response', attempts: 2, completedModelCalls: 1, budgetMs: 100, elapsedMs: 100, firstResponseMs: 60, validationCategory: 'price-action' } });
    const timeoutError = await result;
    if (!(timeoutError instanceof PublicError)) throw new Error('Expected a public timeout error');
    expect(timeoutError.message).toContain('第2次修正调用尚未完成');
    expect(run.mock.calls[1][0].signal!.aborted).toBe(true);
  });
});

describe('analysis correction HTTP integration', () => {
  it('returns safe timeout phase details through HTTP with no raw model/network error', async () => {
    const timeoutConfig=readServerConfig({AI_PROVIDER:'codex',CODEX_TIMEOUT_MS:'1000'});
    const analyzeDetailed: RunModel=async request=>await new Promise<never>((_resolve,reject)=>request.signal!.addEventListener('abort',()=>reject(new Error('private network detail')),{once:true}));
    const app=createApp({config:timeoutConfig,codexProvider:{status:async()=>({available:true,authenticated:true,message:'test'}),analyzeDetailed}});
    const response=await request(app).post('/api/analyze').send({...input,mode:'ai',provider:'codex'}).expect(504);
    expect(response.body.error).toMatchObject({code:'CODEX_TIMEOUT',details:{stage:'initial-response',attempts:1,completedModelCalls:0,budgetMs:1000,firstResponseMs:null,validationCategory:null}});
    expect(response.body.error.message).toContain('第1次调用尚未返回完整结果');
    expect(JSON.stringify(response.body)).not.toContain('private');
  });
  const config = readServerConfig({ AI_PROVIDER: 'codex', CODEX_TIMEOUT_MS: '1000' });
  const status = async () => ({ available: true, authenticated: true, message: 'test' });
  const payload = { candles, context: input.context, mode: 'ai', provider: 'codex' };

  it('returns validated corrected analysis and bills both Codex attempts in its metadata', async () => {
    const analyzeDetailed: Mock<RunModel> = vi.fn<RunModel>(async (_request: ModelInput) => analyzeDetailed.mock.calls.length === 1
      ? { analysis: invalid(), model: 'codex-test', usage: firstUsage }
      : { analysis: valid(), model: 'codex-test', usage: secondUsage });
    const response = await request(createApp({ config, codexProvider: { status, analyzeDetailed } }))
      .post('/api/analyze').send(payload).expect(200);
    expect(response.body).toMatchObject({ source: 'ai', provider: 'codex', billing: 'chatgpt-plan', analysisAttempts: 2,
      usage: { inputTokens: 300, cachedInputTokens: 30, outputTokens: 120 } });
    expect(response.body.analysis.priceAction.breakouts[0].status).toBe('candidate');
    expect(analyzeDetailed.mock.calls[1][0].validationFeedback!.error).toMatch(/站稳确认/);
    expect(analyzeDetailed.mock.calls[1][0].candles).toBe(analyzeDetailed.mock.calls[0][0].candles);
  });

  it('holds the Codex busy lock while the second call is running', async () => {
    let markSecond!: () => void;
    const secondStarted = new Promise<void>(resolve => { markSecond = resolve; });
    let finishSecond!: () => void;
    const release = new Promise<void>(resolve => { finishSecond = resolve; });
    const analyzeDetailed: Mock<RunModel> = vi.fn<RunModel>(async () => {
      if (analyzeDetailed.mock.calls.length === 1) return { analysis: invalid(), model: 'test' };
      markSecond();
      await release;
      return { analysis: valid(), model: 'test' };
    });
    const app = createApp({ config, codexProvider: { status, analyzeDetailed } });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => { server.once('listening', resolve); });
    const first = request(server).post('/api/analyze').send(payload).then(response => response);
    try {
      await secondStarted;
      const blocked = await request(server).post('/api/analyze').send(payload).expect(409);
      expect(blocked.body.error.code).toBe('CODEX_BUSY');
      expect(analyzeDetailed).toHaveBeenCalledTimes(2);
      finishSecond();
      expect((await first).status).toBe(200);
    } finally {
      finishSecond();
      await first;
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('preserves the selected API provider and never invents API usage', async () => {
    const apiConfig = readServerConfig({ AI_PROVIDER: 'api', AI_API_KEY: 'test-key', AI_MODEL: 'test-model' });
    const analyze: Mock<(input: ModelInput) => Promise<unknown>> = vi.fn<(input: ModelInput) => Promise<unknown>>(async (_request: ModelInput) => analyze.mock.calls.length === 1 ? invalid() : valid());
    const analyzeDetailed: Mock<RunModel> = vi.fn<RunModel>(async () => { throw new Error('must not use Codex'); });
    const response = await request(createApp({ config: apiConfig, provider: { analyze }, codexProvider: { status, analyzeDetailed } }))
      .post('/api/analyze').send({ ...payload, provider: 'api' }).expect(200);
    expect(response.body).toMatchObject({ source: 'ai', provider: 'openai-compatible', billing: 'api', analysisAttempts: 2 });
    expect(response.body).not.toHaveProperty('usage');
    expect(analyzeDetailed).not.toHaveBeenCalled();
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it('keeps persistent invalid analysis rejected and mock output separate', async () => {
    const analyzeDetailed: Mock<RunModel> = vi.fn<RunModel>(async () => ({ analysis: invalid(), model: 'test' }));
    const app = createApp({ config, codexProvider: { status, analyzeDetailed } });
    const failed = await request(app).post('/api/analyze').send(payload).expect(502);
    expect(failed.body.error.code).toBe('PROVIDER_INVALID_OUTPUT');
    expect(failed.body.analysis).toBeUndefined();
    expect(analyzeDetailed).toHaveBeenCalledTimes(2);
    const mock = await request(app).post('/api/analyze').send({ ...payload, mode: 'mock' }).expect(200);
    expect(mock.body.source).toBe('mock');
    expect(mock.body).not.toHaveProperty('analysisAttempts');
    expect(analyzeDetailed).toHaveBeenCalledTimes(2);
  });
});
