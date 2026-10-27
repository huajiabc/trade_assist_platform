import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
export async function showChartSettings(page:Page){const details=page.locator('details.chart-display-options');if(await details.getAttribute('open')===null)await details.locator(':scope > summary').click();}
export async function showSinglePeriod(page:Page){await page.getByRole('tab',{name:'单周期解读',exact:true}).click();}

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
    await page.route('**/api/account/**',route=>route.request().url().endsWith('/status')?route.fulfill({json:{configured:false,connected:false,syncing:false,readOnly:true,credentialStorage:'server-environment',pollIntervalMs:15000,staleAfterMs:45000,lastAttemptAt:null,lastSuccessAt:null,nextRetryAt:null,validity:'disconnected',error:null,snapshot:null}}):route.fulfill({status:409,json:{error:{message:'浏览器测试未模拟账户请求，已阻止真实账户访问与额度消耗。'}}}));
    await page.route('**/api/analyze', async route => {
      if (route.request().postDataJSON()?.mode !== 'mock') {
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { message: '浏览器测试未模拟此模型请求，已阻止真实额度消耗。' } }) });
      } else await route.continue();
    });
    await page.route('**/api/research/analyze', async route => {
      if (route.request().postDataJSON()?.provider !== 'mock') {
        await route.fulfill({status:409,json:{error:{message:'研究浏览器测试已阻止真实模型额度消耗。'}}});
      } else await route.continue();
    });
    await use(page);
  },
});
export { expect };
