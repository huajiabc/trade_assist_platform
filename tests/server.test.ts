import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp as createServerApp, type AppOptions } from '../server/app';
import { readServerConfig, type ServerConfig } from '../server/config';
import { OpenAICompatibleProvider, type AnalysisProvider } from '../server/provider';
import { createMockAnalysis } from '../shared/mock';
import { validateAnalysis } from '../shared/analysis';
import type { Candle } from '../shared/market';
import { SAMPLE_CANDLES } from '../shared/sample';
import { PA_SAMPLE_CANDLES } from '../shared/paSample';
import { buildRuleIndicatorReference } from '../shared/indicatorReference';

function candles(length = 40): Candle[] {
  return Array.from({ length }, (_, index) => {
    const open = 100 + index * 0.04 + Math.sin(index * 0.6) * 4;
    const close = open + Math.sin(index * 0.8) * 0.8;
    return {
      timestamp: 1_760_000_000 + index * 3600,
      open,
      close,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      volume: 120 + index,
    };
  });
}

const baseConfig: ServerConfig = {
  analysisProvider: 'api', codexBin: '', codexModel: '', codexReasoningEffort: '', codexServiceTier: '', codexTimeoutMs: 1000, codexProxyUrl: '',
  apiKey: '',
  baseUrl: 'https://example.invalid/v1',
  model: '',
  responseFormat: 'json_schema',
  timeoutMs: 1000,
  host: '127.0.0.1',
  port: 3001,
};
const configured: ServerConfig = { ...baseConfig, apiKey: 'test-secret-do-not-return', model: 'test-model' };
const body = (data = candles(), mode: 'auto' | 'mock' | 'ai' = 'auto') => ({
  candles: data,
  context: { symbol: 'DEMO', timeframe: '1h', notes: '' },
  mode,
});
const completion = (analysis: unknown, finishReason = 'stop') => new Response(JSON.stringify({
  choices: [{ finish_reason: finishReason, message: { content: JSON.stringify(analysis), refusal: null } }],
}), { headers: { 'content-type': 'application/json' } });

// Unit tests never launch a signed-in Codex process or consume subscription usage.
const unavailableCodex = {
  status: async () => ({ available: false, authenticated: false, message: '测试环境未连接 Codex' }),
  analyzeDetailed: vi.fn(async () => { throw new Error('Codex must be injected explicitly'); }),
};
const createApp = (options: AppOptions = {}) => createServerApp({ codexProvider: unavailableCodex, ...options });

describe('analysis HTTP boundary', () => {
  it('reports only public configuration, without the credential or upstream URL', async () => {
    const result = await request(createApp({ config: configured })).get('/api/health').expect(200);
    expect(result.body).toMatchObject({ configured: true, model: 'test-model', provider: 'openai-compatible', activeProvider: 'api', providers: { codex: false, api: true }, maxAnalysisCandles: 300 });
    expect(result.text).not.toContain(configured.apiKey);
    expect(result.text).not.toContain(configured.baseUrl);
  });

  it('allows an unconfigured auto mode to return an explicitly marked validated mock', async () => {
    const result = await request(createApp({ config: baseConfig })).post('/api/analyze').send(body()).expect(200);
    expect(result.body).toMatchObject({ source: 'mock', model: 'mock-pa-smc-v1', analyzedBars: 40 });
    expect(Number.isNaN(Date.parse(result.body.generatedAt))).toBe(false);
    expect(() => validateAnalysis(result.body.analysis, candles())).not.toThrow();
  });

  it('rejects explicit AI mode without credentials instead of silently simulating', async () => {
    const provider = { analyze: vi.fn() };
    const result = await request(createApp({ config: baseConfig, provider })).post('/api/analyze').send(body(candles(), 'ai')).expect(503);
    expect(result.body.error.code).toBe('AI_NOT_CONFIGURED');
    expect(provider.analyze).not.toHaveBeenCalled();
  });

  it('supports explicit mock mode even when a real provider is configured', async () => {
    const provider = { analyze: vi.fn() };
    const result = await request(createApp({ config: configured, provider })).post('/api/analyze').send(body(candles(), 'mock')).expect(200);
    expect(result.body.source).toBe('mock');
    expect(provider.analyze).not.toHaveBeenCalled();
  });

  it('sends only the latest 300 bars, preserves context, and returns actual window metadata', async () => {
    const all = candles(500);
    const analyze = vi.fn<AnalysisProvider['analyze']>(async (input) => createMockAnalysis(input.candles));
    const result = await request(createApp({ config: configured, provider: { analyze } })).post('/api/analyze').send(body(all)).expect(200);
    expect(analyze).toHaveBeenCalledOnce();
    expect(analyze.mock.calls[0][0].candles).toEqual(all.slice(-300));
    expect(analyze.mock.calls[0][0].context).toEqual(body().context);
    expect(result.body).toMatchObject({ source: 'ai', model: 'test-model', analyzedBars: 300 });
    expect(() => validateAnalysis(result.body.analysis, all.slice(-300))).not.toThrow();
  });

  it.each([
    ['too many', body(candles(2001))],
    ['too few', body(candles(9))],
    ['unknown field', { ...body(), apiKey: 'client-key-is-forbidden' }],
    ['unknown candle field', body(candles().map((candle) => ({ ...candle, injected: 'rejected' })))],
    ['invalid mode', { ...body(), mode: 'trade' }],
    ['oversized context', { ...body(), context: { ...body().context, notes: 'x'.repeat(2001) } }],
  ])('rejects %s input before calling a provider', async (_label, input) => {
    const analyze = vi.fn();
    await request(createApp({ config: configured, provider: { analyze } })).post('/api/analyze').send(input).expect(400);
    expect(analyze).not.toHaveBeenCalled();
  });

  it('rejects invalid or unsorted OHLC without coercion', async () => {
    const data = candles();
    data[4].timestamp = data[3].timestamp;
    const result = await request(createApp({ config: configured })).post('/api/analyze').send(body(data)).expect(400);
    expect(result.body.error.code).toBe('CANDLES_INVALID');
  });

  it('rejects malformed model JSON and never emits an analysis envelope', async () => {
    const result = await request(createApp({ config: configured, provider: { analyze: async () => ({ summary: 'insufficient' }) } }))
      .post('/api/analyze').send(body()).expect(502);
    expect(result.body.error.code).toBe('PROVIDER_INVALID_OUTPUT');
    expect(result.body.analysis).toBeUndefined();
  });

  it('rejects structures referring to nonexistent candle coordinates', async () => {
    const invalid = createMockAnalysis(candles());
    invalid.structures.push({
      id: 'bad-coordinate', type: 'HH', status: 'candidate', direction: 'bullish',
      startTime: 1, endTime: 1, price: 100, priceEnd: null, rationale: 'test', invalidation: 'test',
    });
    const result = await request(createApp({ config: configured, provider: { analyze: async () => invalid } }))
      .post('/api/analyze').send(body()).expect(502);
    expect(result.body.error.code).toBe('PROVIDER_INVALID_OUTPUT');
  });

  it('sanitizes unexpected provider exceptions and never falls back to mock', async () => {
    const provider = { analyze: async () => { throw new Error(`secret upstream error ${configured.apiKey} ${configured.baseUrl}`); } };
    const result = await request(createApp({ config: configured, provider })).post('/api/analyze').send(body()).expect(502);
    expect(result.body.error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(result.text).not.toContain(configured.apiKey);
    expect(result.text).not.toContain(configured.baseUrl);
    expect(result.body.source).toBeUndefined();
  });

  it('rejects cross-origin browser writes and accepts the same-origin proxy', async () => {
    const app = createApp({ config: baseConfig });
    await request(app).post('/api/analyze').set('Host', '127.0.0.1:5173').set('Origin', 'https://evil.example').send(body()).expect(403);
    await request(app).post('/api/analyze').set('Host', '127.0.0.1:5173').set('Origin', 'http://127.0.0.1:5173').send(body()).expect(200);
  });

  it('handles JSON parse failures, media type and request size with safe errors', async () => {
    const app = createApp({ config: baseConfig });
    const malformed = await request(app).post('/api/analyze').set('Content-Type', 'application/json').send('{oops').expect(400);
    expect(malformed.body.error.code).toBe('JSON_INVALID');
    await request(app).post('/api/analyze').type('text').send('bad').expect(415);
    const oversized = await request(app).post('/api/analyze').send({ padding: 'x'.repeat(2_100_000) }).expect(413);
    expect(oversized.body.error.code).toBe('REQUEST_TOO_LARGE');
  });
});

describe('Codex subscription HTTP boundary (injected process, no real usage)', () => {
  const config: ServerConfig = { ...baseConfig, analysisProvider: 'auto' };
  const status = async () => ({ available: true, authenticated: true, message: 'ChatGPT 已登录' });

  it('prefers an authenticated Codex in auto mode and exposes only public status', async () => {
    const codexProvider = { status, analyzeDetailed: vi.fn() };
    const result = await request(createApp({ config, codexProvider })).get('/api/health').expect(200);
    expect(result.body).toMatchObject({ configured: true, activeProvider: 'codex', provider: 'codex', providers: { codex: true, api: false } });
    expect(codexProvider.analyzeDetailed).not.toHaveBeenCalled();
  });

  it('reports requested Codex settings without exposing the private server environment or claiming a model turn', async () => {
    const codexProvider={status,analyzeDetailed:vi.fn()};
    const configured={...config,codexModel:'gpt-6-sol',codexReasoningEffort:'high' as const,codexServiceTier:'fast' as const};
    const result=await request(createApp({config:configured,codexProvider})).get('/api/health').expect(200);
    expect(result.body.codexSettings).toEqual({model:'gpt-6-sol',reasoningEffort:'high',serviceTier:'fast'});
    expect(codexProvider.analyzeDetailed).not.toHaveBeenCalled();
    expect(result.body).not.toHaveProperty('apiKey');
  });

  it('passes a bounded window to Codex and returns validated provenance and usage', async () => {
    const all = candles(500);
    const analyzeDetailed = vi.fn(async (input: Parameters<AnalysisProvider['analyze']>[0]) => ({
      analysis: createMockAnalysis(input.candles), model: 'account-default-model',
      usage: { inputTokens: 5000, cachedInputTokens: 1000, outputTokens: 800 },
    }));
    const result = await request(createApp({ config, codexProvider: { status, analyzeDetailed } }))
      .post('/api/analyze').send({ ...body(all, 'ai'), provider: 'codex' }).expect(200);
    expect(analyzeDetailed.mock.calls[0][0].candles).toEqual(all.slice(-300));
    expect(result.body).toMatchObject({ source: 'ai', provider: 'codex', billing: 'chatgpt-plan', model: 'account-default-model', analyzedBars: 300, usage: { inputTokens: 5000, outputTokens: 800 } });
  });

  it('never switches a failed explicit Codex request to a configured API or mock', async () => {
    const provider = { analyze: vi.fn() };
    const codexProvider = { status, analyzeDetailed: async () => { throw new Error('private CLI message'); } };
    const result = await request(createApp({ config: { ...configured, analysisProvider: 'auto' }, provider, codexProvider }))
      .post('/api/analyze').send({ ...body(candles(), 'ai'), provider: 'codex' }).expect(502);
    expect(provider.analyze).not.toHaveBeenCalled();
    expect(result.text).not.toContain('private CLI message');
    expect(result.body.analysis).toBeUndefined();
  });

  it('cancels a disconnected HTTP client and holds the busy lock until provider cleanup finishes', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
    let aborted = false;
    let calls = 0;
    const analyzeDetailed = vi.fn(async (input: Parameters<AnalysisProvider['analyze']>[0]) => {
      calls++;
      if (calls === 1) {
        input.signal!.addEventListener('abort', () => { aborted = true; }, { once: true });
        markStarted();
        // The runner can need time to confirm child exit after requesting termination.
        await cleanup;
        if (aborted) throw new Error('injected cancelled process');
      }
      return { analysis: createMockAnalysis(input.candles), model: 'test-codex-model' };
    });
    const app = createApp({ config, codexProvider: { status, analyzeDetailed } });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => { server.once('listening', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP listener');
    const controller = new AbortController();
    const payload = { ...body(candles(), 'ai'), provider: 'codex' };
    // This is a local HTTP request against an injected stub; it launches no model.
    const first = fetch(`http://127.0.0.1:${address.port}/api/analyze`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: controller.signal,
    }).then(() => 'completed', () => 'disconnected');
    try {
      await started;
      controller.abort();
      expect(await first).toBe('disconnected');
      await expect.poll(() => aborted).toBe(true);
      const blocked = await request(server).post('/api/analyze').send(payload).expect(409);
      expect(blocked.body.error.code).toBe('CODEX_BUSY');
      expect(analyzeDetailed).toHaveBeenCalledOnce();

      finishCleanup();
      await expect.poll(async () => (await request(server).post('/api/analyze').send(payload)).status).toBe(200);
      expect(analyzeDetailed).toHaveBeenCalledTimes(2);
    } finally {
      controller.abort();
      finishCleanup();
      await first;
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    }
  });

  it('rejects invalid Codex coordinates before returning chart data', async () => {
    const analysis = createMockAnalysis(candles());
    analysis.structures[0].startTime += 1;
    const codexProvider = { status, analyzeDetailed: async () => ({ analysis, model: 'test' }) };
    const result = await request(createApp({ config, codexProvider })).post('/api/analyze')
      .send({ ...body(candles(), 'ai'), provider: 'codex' }).expect(502);
    expect(result.body.error.code).toBe('PROVIDER_INVALID_OUTPUT');
  });
});

describe('advanced visualization HTTP validation', () => {
  it('returns a pending numeric plan with its explicit trigger and decision reason', async () => {
    const analysis = createMockAnalysis(SAMPLE_CANDLES);
    analysis.tradeSetups[0].trigger = '等待后续回踩后复核，当前未触发；这些数值只描述条件情景。';
    const result = await request(createApp({ config: configured, provider: { analyze: async () => analysis } }))
      .post('/api/analyze').send(body(SAMPLE_CANDLES, 'ai')).expect(200);
    expect(result.body.analysis).toMatchObject({ schemaVersion: '1.5', tradePlanning: { status: 'conditional' } });
    expect(result.body.analysis.tradeSetups[0].trigger).toBe(analysis.tradeSetups[0].trigger);
    expect(result.body.analysisAttempts).toBe(1);
  });

  it('keeps watch-only opportunities without inventing chart prices and exposes the model reason', async () => {
    const analysis = createMockAnalysis(SAMPLE_CANDLES);
    analysis.tradeSetups = [];
    analysis.tradePlanning = { status: 'watch-only', reason: '价格仍处于区间中部，当前无法确定有依据的保护止损价。' };
    const result = await request(createApp({ config: configured, provider: { analyze: async () => analysis } }))
      .post('/api/analyze').send(body(SAMPLE_CANDLES, 'ai')).expect(200);
    expect(result.body.analysis.tradeSetups).toEqual([]);
    expect(result.body.analysis.opportunities).toEqual(analysis.opportunities);
    expect(result.body.analysis.tradePlanning).toEqual(analysis.tradePlanning);
  });

  it('rejects contradictory plan decisions instead of silently creating or removing candidate prices', async () => {
    const analysis = createMockAnalysis(SAMPLE_CANDLES);
    analysis.tradePlanning.status = 'no-setup';
    const analyze = vi.fn(async () => analysis);
    const result = await request(createApp({ config: configured, provider: { analyze } }))
      .post('/api/analyze').send(body(SAMPLE_CANDLES, 'ai')).expect(502);
    expect(result.body.error.code).toBe('PROVIDER_INVALID_OUTPUT');
    expect(result.body.analysis).toBeUndefined();
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(analysis.tradeSetups.length).toBeGreaterThan(0);
  });

  it('rejects a model plan with the stop on the profit side before exposing chart data', async () => {
    const invalid = createMockAnalysis(SAMPLE_CANDLES);
    const setup = invalid.tradeSetups[0];
    expect(setup).toBeDefined();
    setup.stopLoss = setup.targets[0].price;
    const result = await request(createApp({ config: configured, provider: { analyze: async () => invalid } }))
      .post('/api/analyze').send(body(SAMPLE_CANDLES, 'ai')).expect(502);
    expect(result.body.error.code).toBe('PROVIDER_INVALID_OUTPUT');
    expect(result.body.analysis).toBeUndefined();
  });

  it('rejects fabricated sweep wick coordinates even when the JSON shape is valid', async () => {
    const invalid = createMockAnalysis(SAMPLE_CANDLES);
    expect(invalid.liquiditySweeps.length).toBeGreaterThan(0);
    invalid.liquiditySweeps[0].extremePrice += 0.1;
    const result = await request(createApp({ config: configured, provider: { analyze: async () => invalid } }))
      .post('/api/analyze').send(body(SAMPLE_CANDLES, 'ai')).expect(502);
    expect(result.body.error.code).toBe('PROVIDER_INVALID_OUTPUT');
    expect(result.body.analysis).toBeUndefined();
  });

  it('migrates old analysis without inventing numeric entries or liquidity observations', async () => {
    const { tradeSetups: _setups, liquiditySweeps: _sweeps, priceAction: _pa, tradePlanning: _planning, research: _research, ...current } = createMockAnalysis(SAMPLE_CANDLES);
    const legacy = { ...current, schemaVersion: '1.0' };
    const result = await request(createApp({ config: configured, provider: { analyze: async () => legacy } }))
      .post('/api/analyze').send(body(SAMPLE_CANDLES, 'ai')).expect(200);
    expect(result.body.analysis).toMatchObject({ schemaVersion: '1.5', tradeSetups: [], liquiditySweeps: [],
      priceAction: { zones: [], legs: [], patterns: [], breakouts: [] } });
    expect(result.body.analysis.structures).toEqual(legacy.structures);
  });
});

describe('price action HTTP contract', () => {
  it('returns validated, drawable PA evidence with the same source provenance', async () => {
    const output = createMockAnalysis(PA_SAMPLE_CANDLES);
    const result = await request(createApp({ config: configured, provider: { analyze: async () => output } }))
      .post('/api/analyze').send(body(PA_SAMPLE_CANDLES, 'ai')).expect(200);
    expect(result.body.analysis.schemaVersion).toBe('1.5');
    expect(result.body.analysis.priceAction).toEqual(output.priceAction);
    expect(output.priceAction.patterns.length).toBeGreaterThan(0);
    expect(result.body.source).toBe('ai');
  });

  it('rejects a fabricated PA time before exposing any successful chart envelope', async () => {
    const output = createMockAnalysis(PA_SAMPLE_CANDLES);
    expect(output.priceAction.patterns.length).toBeGreaterThan(0);
    output.priceAction.patterns[0].endTime += 1;
    const result = await request(createApp({ config: configured, provider: { analyze: async () => output } }))
      .post('/api/analyze').send(body(PA_SAMPLE_CANDLES, 'ai')).expect(502);
    expect(result.body.error.code).toBe('PROVIDER_INVALID_OUTPUT');
    expect(result.body.analysis).toBeUndefined();
  });

  it('migrates a strict 1.1 response to an explicitly empty PA layer', async () => {
    const { priceAction: _pa, tradePlanning: _planning, research: _research, ...current } = createMockAnalysis(SAMPLE_CANDLES);
    const old = { ...current, tradeSetups: current.tradeSetups.map(({ trigger: _trigger, tracking: _tracking, basis: _basis, ...setup }) => setup) };
    const result = await request(createApp({ config: configured, provider: {
      analyze: async () => ({ ...old, schemaVersion: '1.1' }),
    } })).post('/api/analyze').send(body(SAMPLE_CANDLES, 'ai')).expect(200);
    expect(result.body.analysis.schemaVersion).toBe('1.5');
    expect(result.body.analysis.priceAction).toMatchObject({ zones: [], legs: [], patterns: [], breakouts: [] });
    expect(result.body.analysis.structures).toEqual(old.structures);
  });
});

describe('OpenAI-compatible adapter (stubbed transport, no network or real key)', () => {
  it('uses structured outputs, sends the contract and only server-side authentication', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => completion(createMockAnalysis(candles())));
    const result = await new OpenAICompatibleProvider(configured, fetchImpl).analyze({ candles: candles(), context: body().context });
    expect(result).toEqual(createMockAnalysis(candles()));
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://example.invalid/v1/chat/completions');
    expect(options?.headers).toMatchObject({ Authorization: `Bearer ${configured.apiKey}` });
    const sent = JSON.parse(options?.body as string);
    expect(sent.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true, name: 'pa_smc_analysis' } });
    expect(sent.max_completion_tokens).toBe(10000);
    const payload = JSON.parse(sent.messages[1].content);
    expect(payload.candles).toEqual(candles());
    expect(payload.analysisScope).toEqual({ startTime: candles()[0].timestamp, endTime: candles().at(-1)!.timestamp, candleCount: candles().length });
    expect(payload.reviewWindows.map((window: { candleCount: number }) => window.candleCount).reduce((a: number, b: number) => a + b, 0)).toBe(candles().length);
    expect(payload.ruleIndicators).toEqual(buildRuleIndicatorReference(candles()));
  });

  it('supports explicit JSON mode without a hidden format fallback', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => completion(createMockAnalysis(candles())));
    await new OpenAICompatibleProvider({ ...configured, responseFormat: 'json_object' }, fetchImpl)
      .analyze({ candles: candles(), context: body().context });
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string).response_format).toEqual({ type: 'json_object' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    ['malformed HTTP JSON', () => new Response('not-json'), 'PROVIDER_INVALID_OUTPUT'],
    ['malformed completion JSON', () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{oops' } }] })), 'PROVIDER_INVALID_OUTPUT'],
    ['truncation', () => completion({}, 'length'), 'PROVIDER_TRUNCATED'],
    ['refusal', () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { refusal: 'private refusal', content: null } }] })), 'PROVIDER_REFUSED'],
    ['HTTP error', () => new Response('private upstream details', { status: 401 }), 'PROVIDER_HTTP_ERROR'],
    ['oversized output', () => new Response('x'.repeat(1_048_577)), 'PROVIDER_INVALID_OUTPUT'],
  ])('rejects %s without exposing provider content', async (_label, response, code) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response());
    await expect(new OpenAICompatibleProvider(configured, fetchImpl).analyze({ candles: candles(), context: body().context }))
      .rejects.toMatchObject({ status: 502, code });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('times out the transport', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('private transport failure')), { once: true });
    });
    await expect(new OpenAICompatibleProvider({ ...configured, timeoutMs: 5 }, fetchImpl)
      .analyze({ candles: candles(), context: body().context })).rejects.toMatchObject({ status: 504, code: 'PROVIDER_TIMEOUT' });
  });
});

describe('server configuration', () => {
  it('has no real AI enabled by default', () => {
    expect(readServerConfig({})).toMatchObject({ apiKey: '', model: '', baseUrl: 'https://api.openai.com/v1', port: 3001, host: '127.0.0.1' });
  });
  it('reads and preserves explicit model/effort/Fast settings, with blank defaults',()=>{
    expect(readServerConfig({CODEX_MODEL:' gpt-6-sol ',CODEX_REASONING_EFFORT:' high ',CODEX_SERVICE_TIER:' fast '})).toMatchObject({codexModel:'gpt-6-sol',codexReasoningEffort:'high',codexServiceTier:'fast'});
    expect(readServerConfig({})).toMatchObject({codexModel:'',codexReasoningEffort:'',codexServiceTier:''});
  });
  it.each([
    {CODEX_REASONING_EFFORT:'higher'}, {CODEX_REASONING_EFFORT:'high\n--other'},
    {CODEX_SERVICE_TIER:'turbo'}, {CODEX_SERVICE_TIER:'fast\n--other'},
  ])('rejects invalid or injected model settings %#',env=>{expect(()=>readServerConfig(env)).toThrow(/CODEX_/);});

  it('rejects unsupported response format and credential-bearing upstream URLs', () => {
    expect(() => readServerConfig({ AI_RESPONSE_FORMAT: 'automatic' })).toThrow();
    expect(() => readServerConfig({ AI_BASE_URL: 'https://user:secret@example.invalid/v1' })).toThrow();
    expect(() => readServerConfig({ AI_PROVIDER: 'unknown' })).toThrow();
    expect(() => readServerConfig({ CODEX_TIMEOUT_MS: '300001' })).toThrow();
    expect(() => readServerConfig({ CODEX_PROXY_URL: 'https://user:pass@proxy.invalid' })).toThrow();
    expect(() => readServerConfig({ CODEX_MODEL: 'model\n--other-argument' })).toThrow();
  });
});
