export type ResponseFormat = 'json_schema' | 'json_object';

export interface ServerConfig {
  analysisProvider: 'auto' | 'codex' | 'api' | 'mock';
  codexBin: string;
  codexModel: string;
  codexTimeoutMs: number;
  codexProxyUrl: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  responseFormat: ResponseFormat;
  timeoutMs: number;
  port: number;
  host: string;
}

function integerSetting(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new Error('服务端数字配置无效，请检查 PORT 或 AI_TIMEOUT_MS。');
  }
  return Number(value);
}

/** Never expose this object to a client: it contains the server-only credential. */
export function readServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const analysisProvider = env.AI_PROVIDER?.trim() || 'auto';
  if (!['auto', 'codex', 'api', 'mock'].includes(analysisProvider)) throw new Error('AI_PROVIDER 配置无效。');
  const codexModel = env.CODEX_MODEL?.trim() || '';
  const codexBin = env.CODEX_BIN?.trim() || '';
  const codexProxyUrl = env.CODEX_PROXY_URL?.trim() || '';
  if (codexProxyUrl) {
    try {
      const proxy = new URL(codexProxyUrl);
      if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password || proxy.search || proxy.hash) throw new Error();
    } catch { throw new Error('CODEX_PROXY_URL 必须是无凭据的 HTTP(S) 代理地址。'); }
  }
  if (codexModel.length > 120 || /[\r\n]/.test(codexModel) || /[\r\n\0]/.test(codexBin)) throw new Error('Codex 配置无效。');
  const responseFormat = env.AI_RESPONSE_FORMAT?.trim() || 'json_schema';
  if (responseFormat !== 'json_schema' && responseFormat !== 'json_object') {
    throw new Error('AI_RESPONSE_FORMAT 只能为 json_schema 或 json_object。');
  }
  let url: URL;
  try {
    url = new URL(env.AI_BASE_URL?.trim() || 'https://api.openai.com/v1');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Invalid URL');
    }
  } catch {
    throw new Error('AI_BASE_URL 必须是无用户名、密码、查询参数的 HTTP(S) API 基础地址。');
  }
  const model = env.AI_MODEL?.trim() || '';
  if (model.length > 120 || /[\r\n]/.test(model)) throw new Error('AI_MODEL 配置无效。');
  return {
    analysisProvider: analysisProvider as ServerConfig['analysisProvider'],
    codexBin,
    codexProxyUrl,
    codexModel,
    codexTimeoutMs: integerSetting(env.CODEX_TIMEOUT_MS, 180_000, 1_000, 300_000),
    apiKey: env.AI_API_KEY?.trim() || '',
    baseUrl: url.toString().replace(/\/+$/, ''),
    model,
    responseFormat,
    timeoutMs: integerSetting(env.AI_TIMEOUT_MS, 45_000, 1_000, 120_000),
    port: integerSetting(env.PORT, 3001, 1, 65_535),
    host: env.HOST?.trim() || '127.0.0.1',
  };
}

export const isAIConfigured = (config: ServerConfig): boolean => Boolean(config.apiKey && config.model);
