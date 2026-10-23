import { test, expect } from './fixtures';
import { createMockAnalysis } from '../../shared/mock';
import { SAMPLE_CANDLES } from '../../shared/sample';

const readyHealth = {
  configured: true, model: 'codex-test-model', provider: 'codex', maxAnalysisCandles: 300,
  activeProvider: 'codex', providers: { codex: true, api: true },
  codex: { available: true, authenticated: true, message: '已通过 ChatGPT 登录，可使用 Codex 额度。' },
};

test('Codex source requires a manual request and renders validated structures with usage', async ({ page }) => {
  const requests: unknown[] = [];
  await page.route('**/api/health', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(readyHealth) }));
  await page.route('**/api/analyze', route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      analysis: createMockAnalysis(SAMPLE_CANDLES), source: 'ai', model: 'codex-test-model', provider: 'codex', billing: 'chatgpt-plan',
      analyzedBars: SAMPLE_CANDLES.length, generatedAt: new Date().toISOString(), analysisAttempts: 2, usage: { inputTokens: 12000, cachedInputTokens: 1000, outputTokens: 2400 },
    }) });
  });
  await page.goto('/?demo=smc');
  await expect(page.getByLabel('分析来源', { exact: true })).toHaveValue('codex');
  await expect(page.locator('.analysis-source-status')).toContainText('ChatGPT 登录已验证');
  expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '分析完成' })).toContainText('Codex 额度分析');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ mode: 'ai', provider: 'codex' });
  await expect(page.locator('.source-badge').first()).toHaveText('Codex 分析');
  await expect(page.locator('.analysis-provenance')).toContainText('Codex 额度 · codex-test-model');
  await expect(page.locator('.analysis-provenance')).toContainText('已修正 1 次 · 共调用模型 2 次，用量含两次调用');
  await expect(page.getByLabel('本次模型用量')).toContainText('12,000');
  await page.getByRole('tab', { name: /结构依据/ }).click();
  const firstStructure = page.locator('.structure-row').first();
  await firstStructure.click();
  await expect(firstStructure).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.evidence-intro')).toContainText('已定位');
});

test('Codex errors are visible and never trigger an API billing fallback', async ({ page }) => {
  const providers: string[] = [];
  await page.route('**/api/health', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(readyHealth) }));
  await page.route('**/api/analyze', route => {
    providers.push(route.request().postDataJSON().provider);
    return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Codex 暂时不可用，请稍后重试。' } }) });
  });
  await page.goto('/?demo=smc');
  await expect(page.getByLabel('分析来源', { exact: true })).toHaveValue('codex');
  await page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first().click();
  await expect(page.getByRole('alert')).toContainText('Codex 暂时不可用');
  expect(providers).toEqual(['codex']);
  await expect(page.getByLabel('分析来源', { exact: true })).toHaveValue('codex');
  await expect(page.locator('.source-badge').first()).toHaveText('模拟分析');
});

test('cancelling a Codex request unlocks controls and does not render a late result', async ({ page }) => {
  let releaseResponse!: () => void;
  let responseHandled!: () => void;
  const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
  const handled = new Promise<void>(resolve => { responseHandled = resolve; });
  await page.route('**/api/health', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(readyHealth) }));
  await page.route('**/api/analyze', async route => {
    await responseGate;
    try {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        analysis: createMockAnalysis(SAMPLE_CANDLES), source: 'ai', model: 'late-codex-result', provider: 'codex', billing: 'chatgpt-plan',
        analyzedBars: SAMPLE_CANDLES.length, generatedAt: new Date().toISOString(),
      }) });
    } catch { /* An aborted browser request no longer has a response channel. */ }
    finally { responseHandled(); }
  });
  await page.goto('/?demo=smc');
  await expect(page.getByLabel('分析来源', { exact: true })).toHaveValue('codex');
  await page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first().click();
  await expect(page.getByLabel('图表分析状态')).toContainText('正在分析');
  await expect(page.getByLabel('分析来源', { exact: true })).toBeDisabled();
  await page.getByLabel('图表分析状态').getByRole('button', { name: '取消分析', exact: true }).click();
  await expect(page.getByLabel('图表分析状态')).toContainText('分析已取消');
  await expect(page.getByLabel('分析来源', { exact: true })).toBeEnabled();
  releaseResponse();
  await handled;
  await expect(page.locator('.source-badge').first()).toHaveText('模拟分析');
  await expect(page.locator('.analysis-provenance')).not.toContainText('late-codex-result');
});
