import { test, expect, showChartSettings } from './fixtures';
import { validateAnalysis, type Analysis } from '../../shared/analysis';
import { createMockAnalysis } from '../../shared/mock';
import type { Candle } from '../../shared/market';
import { SAMPLE_CANDLES } from '../../shared/sample';

function onlyTrailingAnnotations(candles: Candle[]): Analysis {
  const original = createMockAnalysis(candles);
  const cutoff = candles[Math.floor(candles.length * 2 / 3)].timestamp;
  return validateAnalysis({ ...original,
    structures: original.structures.filter(item => item.endTime >= cutoff).slice(-3),
    priceAction: { ...original.priceAction,
      zones: original.priceAction.zones.filter(item => item.endTime >= cutoff),
      legs: original.priceAction.legs.filter(item => item.endTime >= cutoff),
      patterns: original.priceAction.patterns.filter(item => item.endTime >= cutoff),
      breakouts: [],
    },
    opportunities: [], tradeSetups: [], liquiditySweeps: [],
    tradePlanning: { status: 'no-setup', reason: '历史分布测试仅保留结构依据，不提供开仓或文字观察计划。' },
  }, candles);
}

test('raw historical annotation distribution explains an empty earlier span and survives layer toggles and reanalysis', async ({ page }) => {
  let requests = 0;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/analyze', route => {
    const candles: Candle[] = route.request().postDataJSON().candles;
    const analysis = ++requests === 1 ? onlyTrailingAnnotations(candles) : createMockAnalysis(candles);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      analysis, source: 'mock', model: 'annotation-distribution-regression-stub', analyzedBars: candles.length,
      generatedAt: new Date().toISOString(),
    }) });
  });
  await page.goto('/?demo=smc');
  await page.getByLabel('上传 OHLCV CSV').setInputFiles({ name: 'annotation-history.csv', mimeType: 'text/csv',
    buffer: Buffer.from(['timestamp,open,high,low,close,volume', ...SAMPLE_CANDLES.map(candle =>
      [candle.timestamp, candle.open, candle.high, candle.low, candle.close, candle.volume].join(','))].join('\n')) });
  await expect(page.locator('.instrument-name')).toContainText('annotation-history');
  const analyze = page.getByRole('button', { name: '分析当前 K 线范围', exact: true });
  await analyze.click();
  await page.getByText('分析覆盖与诊断', { exact: true }).click(); await showChartSettings(page);
  const distribution = page.getByLabel('历史标注分布', { exact: true });
  await expect(distribution).toBeVisible();
  await expect(distribution.locator('.annotation-distribution-count').nth(0)).toHaveText('前段0项');
  await expect(distribution.locator('.annotation-distribution-count').nth(1)).toHaveText('中段0项');
  await expect(distribution.locator('.annotation-distribution-count').nth(2).locator('b')).not.toHaveText('0');
  await expect(distribution).toContainText('前段、中段未返回锚定于该段的标注，不表示没有结构');
  await expect(distribution).toContainText('跨段结构只计一次，不代表逐根分析覆盖率');
  const titles = [
    '2026-10-10 08:00:00 UTC+8 → 2026-10-12 19:00:00 UTC+8 · 60 根 K 线',
    '2026-10-12 20:00:00 UTC+8 → 2026-10-15 07:00:00 UTC+8 · 60 根 K 线',
    '2026-10-15 08:00:00 UTC+8 → 2026-10-17 19:00:00 UTC+8 · 60 根 K 线',
  ];
  for (let index = 0; index < titles.length; index++) {
    await expect(distribution.locator('.annotation-distribution-count').nth(index)).toHaveAttribute('title', titles[index]);
  }

  const initialCounts = await distribution.locator('.annotation-distribution-count').allTextContents();
  await page.getByRole('button', { name: '叠加', exact: true }).click();
  for (const checkbox of await page.getByLabel('PA 图层显示开关', { exact: true }).getByRole('checkbox').all()) await checkbox.uncheck();
  for (const button of await page.getByLabel('结构显示开关', { exact: true }).getByRole('button').all()) await button.click();
  await page.getByRole('checkbox', { name: '显示候选', exact: true }).uncheck();
  expect(await distribution.locator('.annotation-distribution-count').allTextContents()).toEqual(initialCounts);
  expect(requests).toBe(1);

  await analyze.click();
  await expect.poll(() => requests).toBe(2);
  await expect(distribution.locator('.annotation-distribution-notice')).toHaveCount(0);
  for (let index = 0; index < 3; index++) {
    await expect(distribution.locator('.annotation-distribution-count').nth(index).locator('b')).not.toHaveText('0');
    await expect(distribution.locator('.annotation-distribution-count').nth(index)).toHaveAttribute('title', titles[index]);
  }
  // Hidden layers may make the chart blank, but the raw returned distribution remains truthful.
  await expect(page.getByLabel('PA 图层显示开关', { exact: true }).getByRole('checkbox', { checked: true })).toHaveCount(0);
  await expect(page.getByLabel('结构显示开关', { exact: true }).getByRole('button', { pressed: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
