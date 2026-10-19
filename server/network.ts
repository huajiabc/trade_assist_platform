import { ProxyAgent } from 'undici';
import { PublicError } from './errors';

let configuredProxy = '';
let proxyAgent: ProxyAgent | null = null;

/** Only market transport uses this explicit server-side proxy; browser/API keys are unaffected. */
export const marketFetch: typeof fetch = async (input, init) => {
  const proxyUrl = process.env.MARKET_PROXY_URL?.trim() || '';
  if (!proxyUrl) return fetch(input, init);
  if (proxyUrl !== configuredProxy || !proxyAgent) {
    let parsed: URL;
    try {
      parsed = new URL(proxyUrl);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid proxy');
    } catch {
      throw new PublicError(503, 'MARKET_PROXY_INVALID', '行情代理配置无效，请检查服务端 MARKET_PROXY_URL（仅支持 HTTP/HTTPS）。');
    }
    const oldAgent = proxyAgent;
    proxyAgent = new ProxyAgent(parsed.toString());
    configuredProxy = proxyUrl;
    if (oldAgent) void oldAgent.close().catch(() => {});
  }
  return fetch(input, { ...init, dispatcher: proxyAgent } as RequestInit);
};
