import express, { type ErrorRequestHandler } from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { validateAnalysis, validateAnalysisEnvelope, type AnalysisEnvelope } from '../shared/analysis';
import { MAX_ANALYSIS_CANDLES, MAX_CANDLES, MIN_CANDLES, validateCandles } from '../shared/market';
import { createMockAnalysis } from '../shared/mock';
import { isAIConfigured, readServerConfig, type ServerConfig } from './config';
import { invalidModelOutput, PublicError } from './errors';
import { OpenAICompatibleProvider, type AnalysisProvider } from './provider';
import { liveMarketQuerySchema } from '../shared/liveMarket';
import { BinanceMarketProvider, CachedMarketProvider, type MarketDataProvider } from './market';
import { BinanceRealtimeProvider, createMarketStreamHandler, type RealtimeMarketProvider } from './realtime';
import { CodexAnalysisProvider, type CodexProvider } from './codex';
import { analyzeWithValidation } from './analysisService';

const requestSchema = z.object({
  candles: z.array(z.object({
    timestamp: z.number().finite(),
    open: z.number().finite(),
    high: z.number().finite(),
    low: z.number().finite(),
    close: z.number().finite(),
    volume: z.number().finite(),
  }).strict()).min(MIN_CANDLES).max(MAX_CANDLES),
  context: z.object({
    symbol: z.string().trim().min(1).max(60),
    timeframe: z.string().trim().min(1).max(30),
    notes: z.string().trim().max(2_000),
  }).strict(),
  mode: z.enum(['auto', 'mock', 'ai']),
  provider: z.enum(['codex', 'api']).optional(),
}).strict();

export interface AppOptions {
  config?: ServerConfig;
  provider?: AnalysisProvider;
  codexProvider?: CodexProvider;
  marketProvider?: MarketDataProvider;
  realtime?: RealtimeMarketProvider;
  /** Inject a build directory in tests or deployments; default is repo/dist. */
  distPath?: string;
}

export function createApp(options: AppOptions = {}) {
  const config = options.config ?? readServerConfig();
  const provider = options.provider ?? new OpenAICompatibleProvider(config);
  const codex = options.codexProvider ?? new CodexAnalysisProvider({ bin: config.codexBin, model: config.codexModel, timeoutMs: config.codexTimeoutMs, proxyUrl: config.codexProxyUrl });
  let codexBusy = false;
  const marketProvider = new CachedMarketProvider(options.marketProvider ?? new BinanceMarketProvider());
  const app = express();
  app.disable('x-powered-by');

  app.use('/api', (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.get('/api/health', async (_request, response) => {
    const codexStatus = await codex.status();
    const apiAvailable = isAIConfigured(config);
    const codexAvailable = codexStatus.available && codexStatus.authenticated;
    const activeProvider = config.analysisProvider === 'auto'
      ? (codexAvailable ? 'codex' : apiAvailable ? 'api' : 'mock')
      : config.analysisProvider;
    const configured = activeProvider === 'codex' ? codexAvailable : activeProvider === 'api' ? apiAvailable : false;
    response.json({
      configured,
      model: activeProvider === 'codex' ? config.codexModel || 'Codex CLI 默认模型' : activeProvider === 'api' ? config.model || '未配置 API 模型' : 'mock-pa-smc-v1',
      provider: activeProvider === 'codex' ? 'codex' : activeProvider === 'api' ? 'openai-compatible' : 'mock',
      activeProvider,
      codex: codexStatus,
      providers: { codex: codexAvailable, api: apiAvailable },
      maxAnalysisCandles: MAX_ANALYSIS_CANDLES,
    });
  });

  app.get('/api/market/candles', async (request, response) => {
    const parsed = liveMarketQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new PublicError(400, 'MARKET_QUERY_INVALID', '行情参数无效：需为 USDT 交易对，周期支持 1m、5m、15m、1h、4h、1d，根数为 20–500。');
    }
    try {
      response.json(await marketProvider.getCandles(parsed.data));
    } catch (error) {
      if (error instanceof PublicError) throw error;
      throw new PublicError(502, 'MARKET_UNAVAILABLE', '行情服务暂时不可用，请稍后重试。');
    }
  });

  app.get('/api/market/stream', createMarketStreamHandler(options.realtime ?? new BinanceRealtimeProvider()));

  app.use('/api', (request, _response, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
    const origin = request.get('origin');
    // Vite's same-origin proxy preserves Host; production uses the same server.
    if (origin && origin !== `${request.protocol}://${request.get('host')}`) {
      return next(new PublicError(403, 'ORIGIN_REJECTED', '只允许从当前 WebApp 发起分析请求。'));
    }
    if (request.get('sec-fetch-site') === 'cross-site') {
      return next(new PublicError(403, 'ORIGIN_REJECTED', '只允许从当前 WebApp 发起分析请求。'));
    }
    if (!request.is('application/json')) {
      return next(new PublicError(415, 'JSON_REQUIRED', '分析请求必须使用 application/json。'));
    }
    next();
  });
  app.use('/api', express.json({ limit: '2mb', strict: true }));

  app.post('/api/analyze', async (request, response) => {
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new PublicError(400, 'REQUEST_INVALID', `分析请求格式无效：需提供 ${MIN_CANDLES}–${MAX_CANDLES} 根 K 线、有效上下文和分析模式。`);
    }
    let candles;
    try {
      candles = validateCandles(parsed.data.candles);
    } catch {
      throw new PublicError(400, 'CANDLES_INVALID', '行情数据无效：请检查数值、OHLC 关系、缺失值及严格递增的 UTC 时间。');
    }
    const window = candles.slice(-MAX_ANALYSIS_CANDLES);
    let selected = parsed.data.provider ?? config.analysisProvider;
    if (parsed.data.mode === 'mock') selected = 'mock';
    if (selected === 'auto') {
      const status = await codex.status();
      selected = status.available && status.authenticated ? 'codex' : isAIConfigured(config) ? 'api' : 'mock';
    }
    // A named provider never falls through to another billing source or a mock.
    if (selected === 'api' && !isAIConfigured(config) && parsed.data.mode === 'auto' && !parsed.data.provider) selected = 'mock';
    const real = selected !== 'mock';
    if ((selected === 'api' && !isAIConfigured(config)) || (!real && parsed.data.mode === 'ai')) {
      throw new PublicError(503, 'AI_NOT_CONFIGURED', '所选 AI 来源未配置。Codex 需要本机 ChatGPT 登录；API 模式需要服务端 AI_API_KEY 与 AI_MODEL。');
    }
    if (selected === 'codex' && codexBusy) throw new PublicError(409, 'CODEX_BUSY', '已有 Codex 分析正在进行，请等待完成或取消后重试。');
    let analysis;
    let model = real ? config.model : 'mock-pa-smc-v1';
    let usage: AnalysisEnvelope['usage'];
    let analysisAttempts: AnalysisEnvelope['analysisAttempts'];
    const controller = new AbortController();
    const onClose = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', onClose);
    if (selected === 'codex') codexBusy = true;
    try {
      const input = { candles: window, context: parsed.data.context, signal: controller.signal };
      if (real) {
        const result = await analyzeWithValidation(input, async fixedInput => selected === 'codex'
          ? codex.analyzeDetailed(fixedInput, fixedInput.signal)
          : { analysis: await provider.analyze(fixedInput), model: config.model }, {
          provider: selected === 'codex' ? 'codex' : 'api',
          timeoutMs: selected === 'codex' ? config.codexTimeoutMs : config.timeoutMs,
        });
        analysis = result.analysis;
        model = result.model;
        usage = result.usage;
        analysisAttempts = result.analysisAttempts;
      } else {
        try { analysis = validateAnalysis(createMockAnalysis(window), window); }
        catch { throw invalidModelOutput(); }
      }
    } catch (error) {
      if (error instanceof PublicError) throw error;
      throw new PublicError(502, 'PROVIDER_UNAVAILABLE', '模型服务处理失败，请检查服务端配置后重试。');
    } finally {
      response.removeListener('close', onClose);
      if (selected === 'codex') codexBusy = false;
    }
    const result: AnalysisEnvelope = {
      analysis,
      source: real ? 'ai' : 'mock',
      model,
      provider: selected === 'codex' ? 'codex' : selected === 'api' ? 'openai-compatible' : 'mock',
      billing: selected === 'codex' ? 'chatgpt-plan' : selected === 'api' ? 'api' : 'none',
      ...(usage ? { usage } : {}),
      ...(analysisAttempts ? { analysisAttempts } : {}),
      analyzedBars: window.length,
      generatedAt: new Date().toISOString(),
    };
    try {
      response.json(validateAnalysisEnvelope(result, window));
    } catch {
      throw invalidModelOutput();
    }
  });

  app.use('/api', (_request, _response, next) => {
    next(new PublicError(404, 'API_NOT_FOUND', 'API 路径不存在。'));
  });

  const distPath = options.distPath ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
  if (existsSync(path.join(distPath, 'index.html'))) {
    app.use(express.static(distPath, { index: false, dotfiles: 'deny' }));
    app.get('/{*path}', (_request, response) => { response.sendFile(path.join(distPath, 'index.html')); });
  } else {
    app.get('/', (_request, response) => {
      response.status(503).type('text').send('前端尚未构建。开发请运行 npm run dev；生产请先运行 npm run build，再运行 npm start。');
    });
  }

  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof PublicError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
      return;
    }
    const type = typeof error === 'object' && error !== null && 'type' in error ? error.type : null;
    if (type === 'entity.too.large') {
      response.status(413).json({ error: { code: 'REQUEST_TOO_LARGE', message: '请求超过 2 MB 限制。' } });
      return;
    }
    if (type === 'entity.parse.failed') {
      response.status(400).json({ error: { code: 'JSON_INVALID', message: '请求不是有效的 JSON。' } });
      return;
    }
    response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '服务端处理失败，请稍后重试。' } });
  };
  app.use(errorHandler);
  return app;
}
