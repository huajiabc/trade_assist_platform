import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { analysisJsonSchema } from '../shared/analysis';
import { MAX_ANALYSIS_CANDLES, validateCandles } from '../shared/market';
import { invalidModelOutput, PublicError } from './errors';
import { buildAnalysisPayload, SYSTEM_PROMPT, type AnalysisProvider, type ModelInput } from './provider';

export interface CodexStatus {
  available: boolean;
  authenticated: boolean;
  message: string;
  model?: string;
}

export interface CodexAnalysisResult {
  analysis: unknown;
  model: string;
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
}

export interface CodexProvider {
  status(): Promise<CodexStatus>;
  analyzeDetailed(input: ModelInput, signal?: AbortSignal): Promise<CodexAnalysisResult>;
}

export interface CodexConfig {
  /** Optional absolute native executable path; no shell command is accepted. */
  bin?: string;
  model?: string;
  timeoutMs?: number;
  proxyUrl?: string;
}

export interface CodexProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  /** A bounded account/read handshake ends after this JSON-RPC response. */
  stopAfterResponseId?: number;
}

export interface CodexProcessResult { code: number; stdout: string; stderr: string }
export type CodexProcessRunner = (request: CodexProcessRequest) => Promise<CodexProcessResult>;

interface CodexRuntime {
  resolveBinary?: (override?: string) => Promise<string | null>;
  run?: CodexProcessRunner;
  now?: () => number;
}

const MAX_OUTPUT_BYTES = 1_048_576;
const AUTH_PROBE_TIMEOUT_MS = 8_000;
const DEFAULT_MODEL_LABEL = 'Codex CLI 默认模型';

class ProcessFailure extends Error {
  constructor(readonly kind: 'spawn' | 'timeout' | 'aborted' | 'output') {
    super(kind);
  }
}

/** Direct native spawn means cancellation terminates the actual CLI, including on Windows. */
export const runCodexProcess: CodexProcessRunner = (request) => new Promise((resolve, reject) => {
  if (request.signal?.aborted) { reject(new ProcessFailure('aborted')); return; }
  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: request.env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let lineBuffer = '';
  let bytes = 0;
  let settled = false;
  let failure: ProcessFailure['kind'] | undefined;
  let responseReceived = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const decoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    child.stdin.destroy();
    // Keep the provider lock until close confirms native process termination.
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 1_000);
  };
  const cleanup = () => {
    clearTimeout(timer);
    clearTimeout(killTimer);
    request.signal?.removeEventListener('abort', abort);
  };
  const fail = (kind: ProcessFailure['kind']) => {
    if (settled || failure || responseReceived) return;
    failure = kind;
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', abort);
    stop();
  };
  const abort = () => fail('aborted');
  const timer = setTimeout(() => fail('timeout'), request.timeoutMs);
  request.signal?.addEventListener('abort', abort, { once: true });
  if (request.signal?.aborted) abort();
  const collect = (data: Buffer, isStdout: boolean) => {
    if (settled || failure || responseReceived) return;
    bytes += data.byteLength;
    if (bytes > (request.maxOutputBytes ?? MAX_OUTPUT_BYTES)) { fail('output'); return; }
    if (!isStdout) { stderr += stderrDecoder.write(data); return; }
    const text = decoder.write(data);
    stdout += text;
    if (request.stopAfterResponseId === undefined) return;
    lineBuffer += text;
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      let response: unknown;
      try { response = JSON.parse(line); } catch { continue; }
      if (response && typeof response === 'object'
        && (response as { id?: unknown }).id === request.stopAfterResponseId) {
        responseReceived = true;
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', abort);
        stop();
        return;
      }
    }
  };
  child.stdout.on('data', (data: Buffer) => collect(data, true));
  child.stderr.on('data', (data: Buffer) => collect(data, false));
  child.once('error', () => fail('spawn'));
  child.stdin.on('error', () => { /* A process can exit before consuming its prompt. */ });
  child.once('close', (code) => {
    if (settled) return;
    settled = true;
    cleanup();
    stdout += decoder.end();
    stderr += stderrDecoder.end();
    if (failure) reject(new ProcessFailure(failure));
    else resolve({ code: responseReceived ? 0 : code ?? -1, stdout, stderr });
  });
  if (!settled && !failure) {
    if (request.stopAfterResponseId === undefined) child.stdin.end(request.input);
    else child.stdin.write(request.input);
  }
});

function platformPackage(): { name: string; triple: string } | null {
  const architecture = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : null;
  if (!architecture) return null;
  const target = process.platform === 'win32' ? 'pc-windows-msvc'
    : process.platform === 'darwin' ? 'apple-darwin'
      : process.platform === 'linux' ? 'unknown-linux-musl' : null;
  if (!target) return null;
  return { name: `@openai/codex-${process.platform}-${process.arch}`, triple: `${architecture}-${target}` };
}

/** Resolve the official npm platform binary, rather than executing a .cmd through a shell. */
export async function resolveCodexBinary(override?: string): Promise<string | null> {
  if (override) {
    if (!path.isAbsolute(override) || !existsSync(override)
      || (process.platform === 'win32' && !override.toLowerCase().endsWith('.exe'))) return null;
    return override;
  }
  const target = platformPackage();
  if (!target) return null;
  const binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const require = createRequire(import.meta.url);
  const packages: string[] = [];
  try { packages.push(require.resolve('@openai/codex/package.json')); } catch { /* Optional local installation. */ }
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    packages.push(path.join(directory, 'node_modules', '@openai', 'codex', 'package.json'));
  }
  for (const packageFile of packages) {
    if (!existsSync(packageFile)) continue;
    const fromPackage = createRequire(packageFile);
    try {
      const optionalPackage = fromPackage.resolve(`${target.name}/package.json`);
      for (const directory of ['bin', 'codex']) {
        const executable = path.join(path.dirname(optionalPackage), 'vendor', target.triple, directory, binary);
        if (existsSync(executable)) return executable;
      }
    } catch { /* Older official releases bundled vendor directly. */ }
    for (const directory of ['bin', 'codex']) {
      const bundled = path.join(path.dirname(packageFile), 'vendor', target.triple, directory, binary);
      if (existsSync(bundled)) return bundled;
    }
  }
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const executable = path.join(directory, binary);
    if (existsSync(executable)) return executable;
  }
  return null;
}

/** Do not let an inherited API key or endpoint silently change the billing route. */
export function codexSubscriptionEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const output = { ...env };
  for (const key of Object.keys(output)) {
    if (/^(OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN|OPENAI_ACCESS_TOKEN|OPENAI_BASE_URL|OPENAI_API_BASE|AZURE_OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY)$/i.test(key)
      || /^AI_(API_KEY|BASE_URL|MODEL)$/i.test(key)) delete output[key];
  }
  // Prevent an enclosing Codex session from being reused as the analysis thread.
  delete output.CODEX_THREAD_ID;
  return output;
}

function jsonLines(stdout: string): Record<string, unknown>[] {
  const values: Record<string, unknown>[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) values.push(value as Record<string, unknown>);
    } catch { /* A non-JSON line cannot be used as a completion or an auth response. */ }
  }
  return values;
}

function publicProcessError(error: unknown): PublicError {
  if (error instanceof PublicError) return error;
  if (error instanceof ProcessFailure) {
    if (error.kind === 'aborted') return new PublicError(499, 'ANALYSIS_CANCELLED', '本次 Codex 分析已取消。');
    if (error.kind === 'timeout') return new PublicError(504, 'CODEX_TIMEOUT', 'Codex 分析超时，请减少数据量或稍后重试。');
    if (error.kind === 'output') return invalidModelOutput();
  }
  return new PublicError(502, 'CODEX_UNAVAILABLE', '无法启动 Codex。请检查本地 CLI 安装与服务端配置。');
}

function executionError(result: CodexProcessResult): PublicError {
  const text = `${result.stderr}\n${result.stdout}`;
  // A transport failure during OAuth refresh does not mean the account was logged out.
  if (/error sending request|error trying to connect|connection (?:refused|reset|closed)|connect(?:ion)? timeout|timed out|dns error|failed to (?:lookup|connect)|proxy (?:error|connect)|network (?:error|unreachable)|tls (?:error|handshake)|certificate (?:verify|verification)/i.test(text)) {
    return new PublicError(502, 'CODEX_NETWORK_ERROR', '无法连接 Codex 服务，请检查网络或配置服务端 CODEX_PROXY_URL 后重试。');
  }
  if (/usage.?limit|rate.?limit|quota.?exceed|insufficient.?quota|credit balance/i.test(text)) {
    return new PublicError(429, 'CODEX_USAGE_LIMIT', 'Codex 额度暂不可用或已达到使用限制，请稍后重试。');
  }
  if (/not logged in|unauthorized|please log.?in|invalid_grant|invalid (?:access|refresh) token|token (?:expired|revoked)|\b401\b/i.test(text)) {
    return new PublicError(503, 'CODEX_AUTH_REQUIRED', 'Codex 登录已失效，请在终端执行 npx codex login 并使用 ChatGPT 登录。');
  }
  if (/model.*(?:not supported|not found|unavailable)|unsupported.*model/i.test(text)) {
    return new PublicError(502, 'CODEX_MODEL_UNAVAILABLE', '当前 Codex 模型不可用，请检查 CODEX_MODEL 或留空使用 CLI 默认模型。');
  }
  return new PublicError(502, 'CODEX_ANALYSIS_FAILED', 'Codex 未完成分析，请检查登录、网络与模型配置后重试。');
}

export class CodexAnalysisProvider implements AnalysisProvider, CodexProvider {
  private readonly run: CodexProcessRunner;
  private readonly resolveBinary: (override?: string) => Promise<string | null>;
  private readonly now: () => number;
  private cachedStatus?: { expires: number; value: CodexStatus };
  private statusPending?: Promise<CodexStatus>;
  private busy = false;

  private environment(): NodeJS.ProcessEnv {
    const environment = codexSubscriptionEnvironment();
    if (this.config.proxyUrl) {
      let url: URL;
      try { url = new URL(this.config.proxyUrl); } catch { throw new PublicError(503, 'CODEX_PROXY_CONFIG', 'CODEX_PROXY_URL 格式无效。'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new PublicError(503, 'CODEX_PROXY_CONFIG', 'CODEX_PROXY_URL 仅支持不含凭据和查询参数的 HTTP/HTTPS 地址。');
      }
      environment.HTTP_PROXY = url.href;
      environment.HTTPS_PROXY = url.href;
      environment.ALL_PROXY = url.href;
      environment.http_proxy = url.href;
      environment.https_proxy = url.href;
      environment.all_proxy = url.href;
    }
    return environment;
  }

  constructor(private readonly config: CodexConfig = {}, runtime: CodexRuntime = {}) {
    this.run = runtime.run ?? runCodexProcess;
    this.resolveBinary = runtime.resolveBinary ?? resolveCodexBinary;
    this.now = runtime.now ?? Date.now;
  }

  status(): Promise<CodexStatus> {
    if (this.cachedStatus && this.cachedStatus.expires > this.now()) return Promise.resolve(this.cachedStatus.value);
    if (this.statusPending) return this.statusPending;
    this.statusPending = this.probe().then((value) => {
      this.cachedStatus = { expires: this.now() + 15_000, value };
      return value;
    }).finally(() => { this.statusPending = undefined; });
    return this.statusPending;
  }

  private async probe(signal?: AbortSignal, command?: string): Promise<CodexStatus> {
    const model = this.config.model || DEFAULT_MODEL_LABEL;
    const binary = command ?? await this.resolveBinary(this.config.bin);
    if (!binary) return { available: false, authenticated: false, model, message: '未找到 Codex CLI，请运行 npm install 后重试。' };
    const input = [
      { id: 1, method: 'initialize', params: { clientInfo: { name: 'pa_smc_assistant', title: 'PA/SMC Trading Assistant', version: '0.1.0' }, capabilities: { experimentalApi: false } } },
      { method: 'initialized', params: {} },
      { id: 2, method: 'account/read', params: { refreshToken: false } },
    ].map((value) => `${JSON.stringify(value)}\n`).join('');
    try {
      const result = await this.run({
        command: binary, args: ['app-server'], cwd: tmpdir(), env: this.environment(),
        input, timeoutMs: AUTH_PROBE_TIMEOUT_MS, signal, maxOutputBytes: 262_144, stopAfterResponseId: 2,
      });
      const response = jsonLines(result.stdout).find((event) => event.id === 2);
      const account = response?.result && typeof response.result === 'object'
        ? (response.result as { account?: { type?: unknown } | null }).account : null;
      if (result.code === 0 && !response?.error && account?.type === 'chatgpt') {
        return { available: true, authenticated: true, model, message: '已连接本地 ChatGPT 登录，将使用 Codex 订阅额度。' };
      }
      return {
        available: true, authenticated: false, model,
        message: account?.type === 'apiKey'
          ? '当前 Codex 使用 API Key 登录。请执行 npx codex login，选择 ChatGPT 登录后使用订阅额度。'
          : '尚未连接 ChatGPT 登录，请在终端执行 npx codex login。',
      };
    } catch (error) {
      if (signal?.aborted) throw publicProcessError(error);
      return { available: true, authenticated: false, model, message: '无法确认 Codex 登录状态，请检查 CLI 后执行 npx codex login。' };
    }
  }

  async analyze(input: ModelInput): Promise<unknown> {
    return (await this.analyzeDetailed(input, input.signal)).analysis;
  }

  async analyzeDetailed(input: ModelInput, signal = input.signal): Promise<CodexAnalysisResult> {
    if (input.screenshot) throw new PublicError(400, 'VISION_NOT_ENABLED', '当前分析仅使用 OHLCV 数据。');
    if (input.candles.length > MAX_ANALYSIS_CANDLES) {
      throw new PublicError(400, 'CODEX_DATA_LIMIT', `Codex 单次最多分析 ${MAX_ANALYSIS_CANDLES} 根 K 线。`);
    }
    validateCandles(input.candles);
    if (this.busy) throw new PublicError(429, 'CODEX_BUSY', '已有 Codex 分析正在进行，请等待完成后再试。');
    if (signal?.aborted) throw new PublicError(499, 'ANALYSIS_CANCELLED', '本次 Codex 分析已取消。');
    this.busy = true;
    let directory: string | undefined;
    try {
      const binary = await this.resolveBinary(this.config.bin);
      if (!binary) throw new PublicError(503, 'CODEX_NOT_INSTALLED', '未找到 Codex CLI，请运行 npm install 后重试。');
      // Always recheck immediately before a paid operation, independently of the health cache.
      const login = await this.probe(signal, binary);
      this.cachedStatus = { expires: this.now() + 15_000, value: login };
      if (!login.authenticated) throw new PublicError(503, 'CODEX_AUTH_REQUIRED', login.message);
      directory = await mkdtemp(path.join(tmpdir(), 'pa-smc-codex-'));
      const schemaFile = path.join(directory, 'analysis.schema.json');
      const answerFile = path.join(directory, 'analysis.json');
      await writeFile(schemaFile, JSON.stringify(analysisJsonSchema), { encoding: 'utf8', mode: 0o600 });
      const args = [
        'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
        '--sandbox', 'read-only', '--json', '--color', 'never', '--cd', directory,
        '--output-schema', schemaFile, '--output-last-message', answerFile,
      ];
      const settings = {
        model_provider: 'openai', forced_login_method: 'chatgpt', approval_policy: 'never',
        web_search: 'disabled', project_doc_max_bytes: 0, project_doc_fallback_filenames: [],
        developer_instructions: `${SYSTEM_PROMPT}\n仅分析用户消息中提供的数据。直接返回最终 JSON；不要调用工具、读取文件、执行命令、上网或生成图片。`,
        'history.persistence': 'none', 'mcp_servers': {}, 'plugins': {},
        'features.shell_tool': false, 'features.shell_snapshot': false, 'features.apps': false,
        'features.plugins': false, 'features.hooks': false, 'features.multi_agent': false,
        'features.multi_agent_v2': false, 'features.browser_use': false, 'features.computer_use': false,
        'features.in_app_browser': false, 'features.view_image': false, 'tools.view_image': false,
        'features.image_generation': false, 'features.sleep_tool': false, 'features.memories': false,
        'features.code_mode': false, 'features.code_mode_host': false, 'features.skill_search': false,
        'features.skip_host_skill_discovery': true, 'features.workspace_dependencies': false,
        'features.daemon_auto_start': false,
      };
      for (const [key, value] of Object.entries(settings)) args.push('--config', `${key}=${JSON.stringify(value)}`);
      if (this.config.model) args.push('--model', this.config.model);
      args.push('-');
      const prompt = JSON.stringify(buildAnalysisPayload(input));
      const result = await this.run({
        command: binary, args, cwd: directory, env: this.environment(), input: prompt,
        timeoutMs: this.config.timeoutMs ?? 180_000, signal,
      });
      if (result.code !== 0) throw executionError(result);
      const events = jsonLines(result.stdout);
      if (events.some((event) => event.type === 'turn.failed' || event.type === 'error')) throw executionError(result);
      const completed = [...events].reverse().find((event) => event.type === 'turn.completed');
      // An exit code alone does not establish that a model turn completed.
      if (!completed) throw invalidModelOutput();
      const outputInfo = await stat(answerFile);
      if (!outputInfo.isFile() || outputInfo.size === 0 || outputInfo.size > MAX_OUTPUT_BYTES) throw invalidModelOutput();
      let analysis: unknown;
      try { analysis = JSON.parse(await readFile(answerFile, 'utf8')) as unknown; } catch { throw invalidModelOutput(); }
      const modelEvent = events.find((event) => typeof event.model === 'string' && /^[\w./:-]{1,100}$/.test(event.model));
      const model = typeof modelEvent?.model === 'string' ? modelEvent.model : this.config.model || DEFAULT_MODEL_LABEL;
      const rawUsage = completed.usage as Record<string, unknown> | undefined;
      const numbers = rawUsage && [rawUsage.input_tokens, rawUsage.cached_input_tokens ?? 0, rawUsage.output_tokens];
      const usage = numbers?.every((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
        ? { inputTokens: numbers[0] as number, cachedInputTokens: numbers[1] as number, outputTokens: numbers[2] as number } : undefined;
      return { analysis, model, ...(usage ? { usage } : {}) };
    } catch (error) {
      if (error instanceof PublicError) throw error;
      // Local filesystem and process diagnostics may contain private paths or model text.
      throw publicProcessError(error);
    } finally {
      this.busy = false;
      if (directory) {
        const resolved = path.resolve(directory);
        const parent = path.resolve(tmpdir());
        if (path.dirname(resolved) === parent && path.basename(resolved).startsWith('pa-smc-codex-')) {
          await rm(resolved, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    }
  }
}
