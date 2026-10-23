import { test, expect } from './fixtures';

test('sample, overlays, selection, filters and server mock analysis', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?demo=smc');
  await expect(page.getByRole('heading', { name: /行情与交易计划/ })).toBeVisible();
  await expect(page.locator('.chart-host canvas').first()).toBeVisible();
  await expect(page.locator('.source-badge').first()).toHaveText('模拟分析');
  await page.getByRole('tab', { name: /结构依据/ }).click();
  await expect(page.locator('.structure-row')).not.toHaveCount(0);
  const first = page.locator('.structure-row').first();
  await first.click();
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.evidence-intro')).toContainText('已定位');
  const filter = page.getByRole('button', { name: 'HH', exact: true });
  await filter.click();
  await expect(filter).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.structure-row .type-hh')).toHaveCount(0);
  await filter.click();
  await page.getByRole('checkbox', { name: '显示候选' }).uncheck();
  await expect(page.locator('.structure-row .confirmation.candidate')).toHaveCount(0);
  await page.getByRole('checkbox', { name: '显示候选' }).check();
  await page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '分析完成' })).toBeVisible();
  await expect(page.locator('.analysis-provenance')).toContainText('规则模拟');
  await page.getByRole('tab', { name: /单周期观察/ }).click();
  await expect(page.locator('.opportunity-intro')).toBeVisible();
  await page.getByRole('tab', { name: /结构依据/ }).click();
  await page.getByRole('button', { name: '重置图表视图' }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/workspace-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('CSV import validates errors, accepts sample and reanalyzes', async ({ page }) => {
  await page.goto('/?demo=smc');
  await page.getByLabel('上传 OHLCV CSV').setInputFiles({
    name: 'invalid.csv', mimeType: 'text/csv', buffer: Buffer.from('timestamp,open,high,low,close,volume\n2026-01-01T00:00:00Z,1,2,,1,10'),
  });
  await expect(page.getByRole('alert')).toContainText(/至少|缺失|空值|10|无效/);
  await expect(page.locator('.instrument-name')).toContainText('BTC / USDT');
  await page.getByLabel('上传 OHLCV CSV').setInputFiles('public/sample-ohlcv.csv');
  await expect(page.locator('.instrument-name')).toContainText('sample-ohlcv');
  await expect(page.locator('.empty-state')).toBeVisible();
  await page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '分析完成' })).toBeVisible();
  await page.getByRole('tab', { name: /结构依据/ }).click();
  await expect(page.locator('.structure-row')).not.toHaveCount(0);
});

test('rejects malformed AI envelope and keeps previous validated result', async ({ page }) => {
  await page.goto('/?demo=smc');
  await page.getByRole('tab', { name: /结构依据/ }).click();
  await page.route('**/api/analyze', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ analysis: { unexpected: 'invalid' }, source: 'ai', model: 'test', analyzedBars: 180, generatedAt: new Date().toISOString() }),
  }));
  const count = await page.locator('.structure-row').count();
  await page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first().click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('.source-badge').first()).toHaveText('模拟分析');
  await expect(page.locator('.structure-row')).toHaveCount(count);
});

test('mobile viewport fits and import/settings dialogs work', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?demo=smc');
  await expect(page.locator('.chart-host canvas').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '导入 CSV', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('link', { name: '下载合成示例 CSV' })).toBeVisible();
  await page.getByRole('button', { name: '关闭窗口' }).click();
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByLabel('分析模式').selectOption('mock');
  await page.getByLabel('分析上下文（可选）').fill('关注近期结构');
  await page.getByRole('button', { name: '完成设置' }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/workspace-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('tiny instrument prices stay nonzero and mapped chart renders without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const rows = Array.from({ length: 40 }, (_, i) => {
    const open = (100 + Math.sin(i * .8) * 4) * 1e-22;
    const close = open + Math.sin(i) * 1e-22;
    return [1760000000 + i * 3600, open, Math.max(open, close) + 2e-22, Math.min(open, close) - 2e-22, close, 100].join(',');
  });
  await page.goto('/?demo=smc');
  await page.getByLabel('上传 OHLCV CSV').setInputFiles({ name: 'micro.csv', mimeType: 'text/csv', buffer: Buffer.from(['timestamp,open,high,low,close,volume', ...rows].join('\n')) });
  await expect(page.locator('.price-stat strong')).toContainText('e-');
  await page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '分析完成' })).toBeVisible();
  await expect(page.locator('.chart-host canvas').first()).toBeVisible();
  await expect(page.locator('.chart-readout')).toContainText('e-');
  await page.getByRole('tab', { name: /结构依据/ }).click();
  const row = page.locator('.structure-row').first();
  await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});
