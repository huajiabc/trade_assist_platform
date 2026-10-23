import { test, expect } from './fixtures';
import { createMockAnalysis } from '../../shared/mock';
import { PA_SAMPLE_CANDLES } from '../../shared/paSample';
import { SAMPLE_CANDLES } from '../../shared/sample';
import { getPAEvidence } from '../../src/components/PriceActionPanel';

test('PA teaching example exposes real candle geometry, family views and selectable layers without model calls', async ({ page }) => {
  let analysisRequests = 0;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/api/analyze')) analysisRequests++; });
  await page.goto('/?demo=smc');
  await expect(page.getByRole('button', { name: 'PA 主视图', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('tab', { name: /PA 价格行为/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '导入 CSV', exact: true }).click();
  await page.getByRole('button', { name: '加载 PA 教学示例与模拟分析', exact: true }).click();
  await expect(page.locator('.instrument-name')).toContainText('PA / 教学示例');
  await expect(page.locator('.instrument-meta')).toContainText('合成示例数据');
  const sample = createMockAnalysis(PA_SAMPLE_CANDLES);
  const evidence = getPAEvidence(sample.priceAction);
  expect(evidence.length).toBeGreaterThan(0);
  await expect(page.locator('.pa-evidence-card')).toHaveCount(evidence.length);
  await expect(page.locator('.pa-candle-preview').first()).toBeVisible();
  await expect(page.locator('.pa-breakout-steps').first()).toBeVisible();
  await expect(page.locator('.pa-panel-intro')).toContainText('开仓条件仍需后续行情确认');
  const zone = sample.priceAction.zones[0];
  expect(zone).toBeDefined();
  const card = page.locator(`[data-pa-id="${zone.id}"]`);
  await page.getByRole('checkbox', { name: /支撑阻力 \/ 区间/ }).uncheck();
  await page.getByRole('button', { name: 'SMC 主视图', exact: true }).click();
  await expect(page.getByLabel('PA 图层显示开关')).toHaveCount(0);
  await card.getByRole('button', { name: `定位 PA ${zone.title}`, exact: true }).click();
  await expect(page.getByRole('button', { name: 'PA 主视图', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('checkbox', { name: /支撑阻力 \/ 区间/ })).toBeChecked();
  await expect(card).toHaveClass(/is-selected/);
  await expect(card.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  const chart = page.locator('.chart-host');
  const shown = await chart.screenshot();
  await page.getByRole('checkbox', { name: /支撑阻力 \/ 区间/ }).uncheck();
  expect((await chart.screenshot()).equals(shown)).toBe(false);
  await page.getByRole('button', { name: '叠加', exact: true }).click();
  await expect(page.getByLabel('PA 图层显示开关')).toBeVisible();
  await expect(page.getByLabel('结构显示开关')).toBeVisible();
  await expect(page.getByRole('button', { name: '导出 JSON', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重置图表视图', exact: true }).click();
  await expect(page.locator('.pa-evidence-card.is-selected')).toHaveCount(0);
  expect(analysisRequests).toBe(0);
  expect(errors).toEqual([]);
});

test('PA cards re-enable hidden candidates and mobile workbench stays inside viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?demo=pa');
  await expect(page.locator('.pa-evidence-card')).not.toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('checkbox', { name: '显示候选', exact: true }).uncheck();
  await expect(page.locator('.pa-evidence-card .confirmation.candidate')).toHaveCount(0);
  await page.getByRole('checkbox', { name: '显示候选', exact: true }).check();
  const pattern = page.locator('.pa-evidence-card[data-pa-layer="patterns"]').first();
  await page.getByRole('checkbox', { name: /K 线形态/ }).uncheck();
  await pattern.getByRole('button').click();
  await expect(page.getByRole('checkbox', { name: /K 线形态/ })).toBeChecked();
  await expect(pattern).toHaveClass(/is-selected/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '导入 CSV', exact: true }).click();
  await expect(page.getByRole('link', { name: '下载 PA 教学 CSV' })).toBeVisible();
  await expect(page.getByRole('button', { name: '加载示例数据与模拟分析', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/pa-workspace-mobile.png', fullPage: true });
});

test('legacy 1.1 results keep PA empty instead of inventing price action evidence', async ({ page }) => {
  const { priceAction: _pa, tradePlanning: _planning, research: _research, tradeSetups, ...legacyFields } = createMockAnalysis(SAMPLE_CANDLES);
  const legacy = { ...legacyFields, tradeSetups: tradeSetups.map(({ trigger: _trigger, tracking: _tracking, basis: _basis, ...setup }) => setup) };
  await page.route('**/api/analyze', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    analysis: { ...legacy, schemaVersion: '1.1' }, source: 'mock', model: 'legacy-test', analyzedBars: SAMPLE_CANDLES.length, generatedAt: new Date().toISOString(),
  }) }));
  await page.goto('/?demo=smc');
  await page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '分析完成' })).toBeVisible();
  await expect(page.locator('.pa-evidence-card')).toHaveCount(0);
  await expect(page.locator('.analysis-title')).toHaveText('PA 待分析');
  await expect(page.locator('.pa-regime-summary')).toContainText('此旧版分析未包含 PA 证据；请重新分析');
  await expect(page.locator('.pa-evidence .advanced-empty')).toContainText('旧版分析没有 PA 字段，请重新分析');
});

test('observation plans can focus PA evidence and reveal its family', async ({ page }) => {
  const result = createMockAnalysis(SAMPLE_CANDLES);
  const pa = getPAEvidence(result.priceAction)[0];
  expect(pa).toBeDefined();
  const setup = result.tradeSetups[0];
  setup.structureIds = [pa.item.id];
  await page.route('**/api/analyze', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    analysis: result, source: 'mock', model: 'pa-ref-test', analyzedBars: SAMPLE_CANDLES.length, generatedAt: new Date().toISOString(),
  }) }));
  await page.goto('/?demo=smc');
  await page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '分析完成' })).toBeVisible();
  await page.getByRole('button', { name: 'SMC 主视图', exact: true }).click();
  await page.getByRole('tab', { name: /单周期观察/ }).click();
  await page.locator('.trade-plan-card .related-structures').getByRole('button', { name: `PA · ${pa.item.title}` }).click();
  await expect(page.getByRole('tab', { name: /PA 价格行为/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator(`[data-pa-id="${pa.item.id}"]`)).toHaveClass(/is-selected/);
  await expect(page.getByRole('button', { name: 'PA 主视图', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
