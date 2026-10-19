import { test as base, expect } from '@playwright/test';

// Browser tests must never spend a developer's locally authenticated Codex/API quota.
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route('**/api/health', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        configured: false, model: 'mock-pa-smc-v1', provider: 'mock', maxAnalysisCandles: 300,
        activeProvider: 'mock', providers: { codex: false, api: false },
        codex: { available: false, authenticated: false, message: '测试环境使用模拟分析。' },
      }),
    }));
    await page.route('**/api/analyze', async route => {
      if (route.request().postDataJSON()?.mode !== 'mock') {
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { message: '浏览器测试未模拟此模型请求，已阻止真实额度消耗。' } }) });
      } else await route.continue();
    });
    await use(page);
  },
});
export { expect };
