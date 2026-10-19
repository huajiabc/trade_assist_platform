import { readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CodexAnalysisProvider, codexSubscriptionEnvironment, resolveCodexBinary, runCodexProcess,
  type CodexProcessRequest, type CodexProcessRunner,
} from '../server/codex';
import type { ModelInput } from '../server/provider';
import { SAMPLE_CANDLES } from '../shared/sample';
import { createMockAnalysis } from '../shared/mock';

const input: ModelInput = {
  candles: SAMPLE_CANDLES.slice(-40),
  context: { symbol: 'SNDKUSDT', timeframe: '5m', notes: '仅分析已收盘行情。' },
};
const analysis = createMockAnalysis(input.candles);
const authReply = (type: unknown = 'chatgpt') => ({
  code: 0, stderr: '',
  stdout: `${JSON.stringify({ id: 2, result: { account: type === null ? null : { type, email: 'private@example.invalid', planType: 'pro' } } })}\n`,
});
const answerPath = (request: CodexProcessRequest) => request.args[request.args.indexOf('--output-last-message') + 1];
const complete = (usage = { input_tokens: 1_000, cached_input_tokens: 250, output_tokens: 300 }) => ({
  code: 0, stderr: '', stdout: `${JSON.stringify({ type: 'turn.completed', usage })}\n`,
});

function runtime(options: {
  authType?: unknown;
  runAnalysis?: CodexProcessRunner;
  binary?: string | null;
  now?: () => number;
} = {}) {
  const run = vi.fn<CodexProcessRunner>(async (request) => {
    if (request.stopAfterResponseId === 2) return authReply(options.authType);
    if (options.runAnalysis) return options.runAnalysis(request);
    await writeFile(answerPath(request), JSON.stringify(analysis));
    return complete();
  });
  const provider = new CodexAnalysisProvider({ timeoutMs: 1_000 }, {
    run, resolveBinary: async () => options.binary === undefined ? '/official/codex' : options.binary, now: options.now,
  });
  return { provider, run };
}

describe('Codex subscription adapter', () => {
  it('probes the official account protocol and exposes no identity or credentials', async () => {
    const { provider, run } = runtime();
    const status = await provider.status();
    expect(status).toMatchObject({ available: true, authenticated: true });
    expect(JSON.stringify(status)).not.toContain('private@example.invalid');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].args).toEqual(['app-server']);
    const messages = run.mock.calls[0][0].input.trim().split('\n').map((line) => JSON.parse(line));
    expect(messages.map((message) => message.method)).toEqual(['initialize', 'initialized', 'account/read']);
    expect(messages[2].params).toEqual({ refreshToken: false });
  });

  it.each(['apiKey', null, 'unknown-auth-mode'])('rejects %s authentication without starting an AI turn', async (authType) => {
    const { provider, run } = runtime({ authType });
    expect(await provider.status()).toMatchObject({ available: true, authenticated: false });
    await expect(provider.analyzeDetailed(input)).rejects.toMatchObject({ code: 'CODEX_AUTH_REQUIRED' });
    expect(run.mock.calls.every(([request]) => request.stopAfterResponseId === 2)).toBe(true);
  });

  it('reports a missing CLI without any process execution', async () => {
    const { provider, run } = runtime({ binary: null });
    expect(await provider.status()).toMatchObject({ available: false, authenticated: false });
    await expect(provider.analyzeDetailed(input)).rejects.toMatchObject({ code: 'CODEX_NOT_INSTALLED' });
    expect(run).not.toHaveBeenCalled();
  });

  it('caches health for 15 seconds but checks current ChatGPT auth before every analysis', async () => {
    let time = 0;
    const { provider, run } = runtime({ now: () => time });
    await Promise.all([provider.status(), provider.status()]);
    await provider.status();
    expect(run).toHaveBeenCalledTimes(1);
    time = 15_001;
    await provider.status();
    expect(run).toHaveBeenCalledTimes(2);
    await provider.analyzeDetailed(input);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('uses stdin, an isolated directory, strict schema and subscription-only tool-free settings', async () => {
    let directory = '';
    const { provider, run } = runtime({ runAnalysis: async (request) => {
      directory = request.cwd;
      expect(request.args).toEqual(expect.arrayContaining([
        '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
        '--sandbox', 'read-only', '--json', '--output-schema', '--output-last-message', '-',
        'forced_login_method="chatgpt"', 'model_provider="openai"', 'approval_policy="never"',
        'features.shell_tool=false', 'features.apps=false', 'features.plugins=false',
        'features.hooks=false', 'features.image_generation=false', 'project_doc_max_bytes=0',
        'features.skip_host_skill_discovery=true', 'web_search="disabled"',
      ]));
      expect(request.args).not.toContain('SNDKUSDT');
      expect(JSON.parse(request.input)).toMatchObject({ context: input.context, candles: input.candles });
      expect(request.cwd).not.toBe(process.cwd());
      const schemaFile = request.args[request.args.indexOf('--output-schema') + 1];
      expect(JSON.parse(await readFile(schemaFile, 'utf8'))).toHaveProperty('properties.structures');
      await writeFile(answerPath(request), JSON.stringify(analysis));
      return complete();
    } });
    const result = await provider.analyzeDetailed(input);
    expect(result).toEqual({ analysis, model: 'Codex CLI 默认模型', usage: { inputTokens: 1_000, cachedInputTokens: 250, outputTokens: 300 } });
    expect(run).toHaveBeenCalledTimes(2);
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('strips API billing and endpoint overrides while retaining Codex auth location and network environment', () => {
    const environment = codexSubscriptionEnvironment({
      OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', AI_API_KEY: 'secret', CODEX_ACCESS_TOKEN: 'secret',
      OPENAI_BASE_URL: 'https://untrusted.invalid', OPENAI_API_BASE: 'https://untrusted.invalid',
      CODEX_HOME: '/user/codex', HTTPS_PROXY: 'http://127.0.0.1:7890', PATH: '/runtime', CODEX_THREAD_ID: 'parent-thread',
    });
    expect(environment).toEqual({ CODEX_HOME: '/user/codex', HTTPS_PROXY: 'http://127.0.0.1:7890', PATH: '/runtime' });
  });

  it('uses an explicit proxy consistently for the account probe and model process', async () => {
    const run = vi.fn<CodexProcessRunner>(async (request) => {
      for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) {
        expect(request.env[key]).toBe('http://127.0.0.1:7890/');
      }
      if (request.stopAfterResponseId === 2) return authReply();
      await writeFile(answerPath(request), JSON.stringify(analysis));
      return complete();
    });
    const provider = new CodexAnalysisProvider({ proxyUrl: 'http://127.0.0.1:7890' }, { run, resolveBinary: async () => '/official/codex' });
    await provider.analyzeDetailed(input);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('records only actual event/model configuration and never invents a model name', async () => {
    const { provider } = runtime({ runAnalysis: async (request) => {
      await writeFile(answerPath(request), JSON.stringify(analysis));
      return { ...complete(), stdout: `${JSON.stringify({ type: 'thread.started', model: 'official-test-model' })}\n${complete().stdout}` };
    } });
    expect((await provider.analyzeDetailed(input)).model).toBe('official-test-model');
  });

  it.each([
    ['not JSON', 'PROVIDER_INVALID_OUTPUT'],
    ['', 'PROVIDER_INVALID_OUTPUT'],
    ['a'.repeat(1_048_577), 'PROVIDER_INVALID_OUTPUT'],
  ])('rejects malformed or oversized output (%#)', async (output, code) => {
    const { provider } = runtime({ runAnalysis: async (request) => {
      await writeFile(answerPath(request), output);
      return complete();
    } });
    await expect(provider.analyzeDetailed(input)).rejects.toMatchObject({ code });
  });

  it('requires a completed model turn rather than trusting a process exit code', async () => {
    const { provider } = runtime({ runAnalysis: async (request) => {
      await writeFile(answerPath(request), JSON.stringify(analysis));
      return { code: 0, stdout: '{"type":"turn.started"}\n', stderr: '' };
    } });
    await expect(provider.analyzeDetailed(input)).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
  });

  it.each([
    ['rate_limit exceeded secret-path', 'CODEX_USAGE_LIMIT'],
    ['401 unauthorized secret-path', 'CODEX_AUTH_REQUIRED'],
    ['model test is not supported secret-path', 'CODEX_MODEL_UNAVAILABLE'],
    ['unexpected upstream response secret-path', 'CODEX_ANALYSIS_FAILED'],
    ['authentication refresh failed: error sending request for url secret-path', 'CODEX_NETWORK_ERROR'],
  ])('classifies failure without exposing CLI diagnostics (%#)', async (stderr, code) => {
    const { provider } = runtime({ runAnalysis: async () => ({ code: 1, stdout: '', stderr }) });
    const error = await provider.analyzeDetailed(input).catch((value: unknown) => value);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain('secret-path');
  });

  it('disallows overlapping analyses until the first process runner confirms termination', async () => {
    let finish!: () => void;
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => { started = resolve; });
    const hasFinished = new Promise<void>((resolve) => { finish = resolve; });
    const { provider } = runtime({ runAnalysis: async (request) => {
      started();
      await hasFinished;
      await writeFile(answerPath(request), JSON.stringify(analysis));
      return complete();
    } });
    const first = provider.analyzeDetailed(input);
    await hasStarted;
    await expect(provider.analyzeDetailed(input)).rejects.toMatchObject({ code: 'CODEX_BUSY' });
    finish();
    await first;
    await expect(provider.analyzeDetailed(input)).resolves.toHaveProperty('analysis');
  });

  it('never starts an AI process for a cancelled request, screenshot or oversized dataset', async () => {
    const { provider, run } = runtime();
    await expect(provider.analyzeDetailed(input, AbortSignal.abort())).rejects.toMatchObject({ code: 'ANALYSIS_CANCELLED' });
    await expect(provider.analyzeDetailed({ ...input, screenshot: { mimeType: 'image/png', base64: 'unused' } })).rejects.toMatchObject({ code: 'VISION_NOT_ENABLED' });
    await expect(provider.analyzeDetailed({ ...input, candles: Array.from({ length: 301 }, () => input.candles[0]) })).rejects.toMatchObject({ code: 'CODEX_DATA_LIMIT' });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('bounded native process runner (no model calls)', () => {
  const request = (script: string, overrides: Partial<CodexProcessRequest> = {}): CodexProcessRequest => ({
    command: process.execPath, args: ['-e', script], cwd: tmpdir(), env: process.env,
    input: '', timeoutMs: 3_000, ...overrides,
  });

  it('waits for native process closure and reads UTF-8 JSON lines', async () => {
    const result = await runCodexProcess(request('process.stdout.write(JSON.stringify({value:"行情"})+"\\n");'));
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({ value: '行情' });
  });

  it('resolves the pinned local CLI native layout before any global installation', async () => {
    const binary = await resolveCodexBinary();
    expect(binary).not.toBeNull();
    expect(path.resolve(binary!).startsWith(path.resolve('node_modules') + path.sep)).toBe(true);
    expect(binary).toMatch(/[\\/]vendor[\\/][^\\/]+[\\/]bin[\\/]codex(?:\.exe)?$/);
    const result = await runCodexProcess({ ...request(''), command: binary!, args: ['--version'] });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('codex-cli 0.163.0');
  });

  it('terminates and closes a stalled process on timeout', async () => {
    await expect(runCodexProcess(request('setInterval(()=>{},1000)', { timeoutMs: 50 }))).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('terminates and closes a process on cancellation', async () => {
    const abort = new AbortController();
    const result = runCodexProcess(request('setInterval(()=>{},1000)', { signal: abort.signal }));
    setTimeout(() => abort.abort(), 50);
    await expect(result).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('bounds combined stdout/stderr output', async () => {
    await expect(runCodexProcess(request('process.stderr.write("x".repeat(4000));setInterval(()=>{},1000)', { maxOutputBytes: 1_024 }))).rejects.toMatchObject({ kind: 'output' });
  });

  it('ends an account probe only after a complete matching response and process exit', async () => {
    const result = await runCodexProcess(request('process.stdout.write(JSON.stringify({id:2,result:{account:{type:"chatgpt"}}})+"\\n");setInterval(()=>{},1000)', { stopAfterResponseId: 2 }));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveProperty('id', 2);
  });
});
