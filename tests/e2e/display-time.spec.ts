import { test, expect } from './fixtures';
import { createMockAnalysis } from '../../shared/mock';
import type { Candle } from '../../shared/market';

test('UTC+8 readout and manual ranges keep the exact original OHLCV timestamps', async ({ page }) => {
  const start = Date.parse('2026-10-26T16:00:00Z') / 1000;
  const candles: Candle[] = Array.from({ length: 80 }, (_, i) => ({ timestamp: start + i * 60,
    open: 100 + Math.sin(i / 5), high: 102 + Math.sin(i / 5), low: 98 + Math.sin(i / 5), close: 101 + Math.sin(i / 5), volume: 100 + i }));
  let submitted: Candle[] = [];
  await page.route('**/api/market/stream?*', route => route.abort());
  await page.route('**/api/market/candles?*', route => route.fulfill({ json: { provider: 'binance', market: 'usdt-perpetual', symbol: 'SNDKUSDT', interval: '1m', candles,
    lastCandleClosed: true, serverTime: (start + 80 * 60) * 1000, fetchedAt: new Date((start + 80 * 60) * 1000).toISOString(), warnings: [] } }));
  await page.route('**/api/analyze', route => {
    submitted = route.request().postDataJSON().candles;
    return route.fulfill({ json: { source: 'mock', model: 'timezone-test-only', analyzedBars: submitted.length,
      generatedAt: new Date().toISOString(), analysis: createMockAnalysis(submitted) } });
  });
  await page.goto('/?live=SNDKUSDT&interval=1m');
  await expect(page.locator('.readout-time')).toHaveText('2026-10-27 01:19 UTC+8');
  await expect(page.locator('.chart-timezone')).toHaveText('UTC+8');
  await expect(page.locator('.chart-host')).toHaveAttribute('aria-label', /时间轴使用 UTC\+8/);
  await page.getByRole('button', { name: '手动范围', exact: true }).click();
  const from = page.getByLabel('范围开始 UTC+8', { exact: true }), to = page.getByLabel('范围结束 UTC+8', { exact: true });
  await expect(from.locator(`option[value="${start}"]`)).toHaveText('2026-10-27 00:00');
  await from.selectOption(String(start)); await to.selectOption(String(start + 19 * 60));
  await expect(page.locator('.analysis-range-summary')).toContainText('10-27 00:00 至 10-27 00:19 UTC+8');
  await page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).click();
  await expect.poll(() => submitted.length).toBe(20);
  expect(submitted).toEqual(candles.slice(0, 20));
  await expect(page.getByRole('img', { name: /交互式 OHLCV/ })).toBeVisible();
});
