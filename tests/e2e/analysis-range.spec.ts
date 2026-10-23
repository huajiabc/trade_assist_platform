import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { createMockAnalysis } from '../../shared/mock';
import type { Candle } from '../../shared/market';
import type { MarketSnapshot } from '../../shared/liveMarket';

function fixture(length = 80): MarketSnapshot {
  const candles = Array.from({ length }, (_, index) => {
    const open = 1200 + Math.sin(index * .65) * 10;
    const close = open + Math.sin(index) * 2;
    return { timestamp: 1791244800 + index * 300, open, high: Math.max(open, close) + 2, low: Math.min(open, close) - 2, close, volume: 100 + index };
  });
  return { provider: 'binance', market: 'usdt-perpetual', symbol: 'SNDKUSDT', interval: '5m', candles, lastCandleClosed: false, serverTime: (candles.at(-1)!.timestamp + 100) * 1000, fetchedAt: new Date().toISOString(), warnings: [] };
}

async function setup(page: Page, snapshot: MarketSnapshot, requests: Candle[][]) {
  await page.route('**/api/market/stream?*', route => route.abort());
  await page.route('**/api/market/candles?*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) }));
  await page.route('**/api/analyze', route => {
    const candles: Candle[] = route.request().postDataJSON().candles;
    requests.push(candles);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      analysis: createMockAnalysis(candles), source: 'mock', model: 'range-regression-stub', analyzedBars: candles.length, generatedAt: new Date().toISOString(),
    }) });
  });
  await page.goto('/?live=SNDKUSDT&interval=5m');
  await expect(page.locator('.price-stat strong')).not.toHaveText('—');
  await expect(page.getByLabel('分析来源', { exact: true })).toHaveValue('mock');
}

async function importHistory(page: Page, snapshot: MarketSnapshot) {
  const header = 'timestamp,open,high,low,close,volume';
  const rows = snapshot.candles.map(candle => [candle.timestamp, candle.open, candle.high, candle.low, candle.close, candle.volume].join(','));
  await page.getByLabel('上传 OHLCV CSV').setInputFiles({ name: 'range-history.csv', mimeType: 'text/csv', buffer: Buffer.from([header, ...rows].join('\n')) });
  await expect(page.locator('.instrument-name')).toContainText('range-history');
}

test('automatic CSV range sends exactly the latest 300 bars and manual input sends only its inclusive selected candles', async ({ page }) => {
  const requests: Candle[][] = [];
  const snapshot = fixture(400);
  await setup(page, fixture(), requests);
  await importHistory(page, snapshot);
  const toolbar = page.getByLabel('分析 K 线范围', { exact: true });
  await expect(page.getByRole('button', { name: '自动范围', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(toolbar).toContainText('将分析 300 根 K 线');
  await page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first().click();
  await expect(page.locator('.analysis-provenance')).toContainText('规则模拟');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toEqual(snapshot.candles.slice(100));

  await page.getByRole('button', { name: '手动范围', exact: true }).click();
  await expect(page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first()).toBeDisabled();
  await expect(toolbar).toContainText('请先在图表拖选 K 线范围');
  const from = page.getByLabel('范围开始 UTC', { exact: true });
  const to = page.getByLabel('范围结束 UTC', { exact: true });
  await expect(from.locator('option')).toHaveCount(401); // 400 CSV bars plus the placeholder.
  await from.selectOption(String(snapshot.candles[112].timestamp));
  await to.selectOption(String(snapshot.candles[140].timestamp));
  await expect(toolbar).toContainText('将分析 29 根 K 线');
  await page.getByRole('button', { name: '专注图表', exact: true }).click();
  await toolbar.getByRole('button', { name: '分析当前 K 线范围', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  await expect(page.getByLabel('分析任务状态')).toHaveClass(/phase-success/);
  expect(requests[1]).toEqual(snapshot.candles.slice(112, 141));
  await expect(page.getByLabel('分析任务状态')).not.toContainText('行情已更新，当前结果需复核');
  await page.getByRole('button', { name: '退出专注图表', exact: true }).click();
  await page.getByRole('button', { name: '自动范围', exact: true }).click();
  await expect(toolbar).toContainText('将分析 300 根 K 线');
  expect(requests).toHaveLength(2);
});

test('manual selections below 10, above 300 or reversed cannot spend model quota or silently change their endpoints', async ({ page }) => {
  const requests: Candle[][] = [];
  const snapshot = fixture(400);
  await setup(page, fixture(), requests);
  await importHistory(page, snapshot);
  await page.getByRole('button', { name: '手动范围', exact: true }).click();
  const toolbar = page.getByLabel('分析 K 线范围', { exact: true });
  const from = page.getByLabel('范围开始 UTC', { exact: true });
  const to = page.getByLabel('范围结束 UTC', { exact: true });
  await from.selectOption(String(snapshot.candles[0].timestamp));
  await to.selectOption(String(snapshot.candles[8].timestamp));
  await expect(toolbar).toContainText('当前 9 根');
  await expect(page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first()).toBeDisabled();
  await to.selectOption(String(snapshot.candles[398].timestamp));
  await expect(toolbar).toContainText('所选 399 根，最多允许 300 根');
  await expect(to).toHaveValue(String(snapshot.candles[398].timestamp));
  await expect(page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first()).toBeDisabled();
  await from.selectOption(String(snapshot.candles[200].timestamp));
  await to.selectOption(String(snapshot.candles[100].timestamp));
  await expect(toolbar).toContainText('范围开始不能晚于结束');
  await expect(page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first()).toBeDisabled();
  expect(requests).toEqual([]);
  await to.selectOption(String(snapshot.candles[220].timestamp));
  await expect(toolbar).toContainText('将分析 21 根 K 线');
  await page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first().click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toEqual(snapshot.candles.slice(200, 221));
});

test('chart drag and two-click selection map to real closed-bar endpoints without triggering analysis', async ({ page }) => {
  const requests: Candle[][] = [];
  const snapshot = fixture();
  await setup(page, snapshot, requests);
  await page.getByRole('button', { name: '手动范围', exact: true }).click();
  await page.getByRole('button', { name: '在图表拖选范围', exact: true }).click();
  const surface = page.getByTestId('analysis-range-surface');
  await expect(surface).toBeVisible();
  await surface.scrollIntoViewIfNeeded();
  const bounds = (await surface.boundingBox())!;
  const y = bounds.y + bounds.height * .4;
  await page.mouse.move(bounds.x + bounds.width * .28, y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .65, y + 5, { steps: 12 });
  await page.mouse.up();
  await expect(surface).toBeHidden();
  const from = page.getByLabel('范围开始 UTC', { exact: true });
  const to = page.getByLabel('范围结束 UTC', { exact: true });
  const selectedFrom = Number(await from.inputValue());
  const selectedTo = Number(await to.inputValue());
  await expect(from.locator('option')).toHaveCount(80); // 79 closed bars, never the forming tail.
  await expect(to.locator(`option[value="${snapshot.candles.at(-1)!.timestamp}"]`)).toHaveCount(0);
  expect(snapshot.candles.slice(0, -1).some(candle => candle.timestamp === selectedFrom)).toBe(true);
  expect(snapshot.candles.slice(0, -1).some(candle => candle.timestamp === selectedTo)).toBe(true);
  expect(selectedFrom).toBeLessThan(selectedTo);
  const selected = snapshot.candles.filter(candle => candle.timestamp >= selectedFrom && candle.timestamp <= selectedTo);
  expect(selected.length).toBeGreaterThanOrEqual(10);
  expect(requests).toEqual([]);
  await page.getByRole('button', { name: '定位选区', exact: true }).click();
  // Before analysis, the only blue vertical lines are the range boundaries.
  // Check two separated tall columns; a label stuck at x=0 must not pass.
  await expect.poll(async () => page.locator('.chart-host canvas').evaluateAll(canvases => canvases.some(node => {
    const canvas = node as HTMLCanvasElement;
    if (!canvas.width || canvas.height < 100) return false;
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    const columns: number[] = [];
    for (let x = 0; x < canvas.width; x++) {
      let pixels = 0;
      for (let y = 0; y < canvas.height - 50; y++) {
        const index = (y * canvas.width + x) * 4;
        if (data[index + 3] > 100 && data[index] > 45 && data[index] < 155 && data[index + 1] > 95 && data[index + 2] > 170 && data[index + 2] > data[index + 1] + 35) pixels++;
      }
      if (pixels > canvas.height * .15) columns.push(x);
    }
    return columns.length >= 2 && columns.at(-1)! - columns[0] > canvas.width * .3;
  }))).toBe(true);
  await page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first().click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toEqual(selected);
  await expect(page.getByLabel('分析任务状态')).toHaveClass(/phase-success/);

  await page.getByRole('button', { name: '在图表拖选范围', exact: true }).click();
  await expect(surface).toBeVisible();
  await surface.scrollIntoViewIfNeeded();
  const secondBounds = (await surface.boundingBox())!;
  await page.mouse.click(secondBounds.x + secondBounds.width * .7, secondBounds.y + secondBounds.height * .45);
  await expect(surface).toBeVisible();
  await expect(page.locator('.chart-panel')).toContainText('请选择终点');
  await page.mouse.click(secondBounds.x + secondBounds.width * .35, secondBounds.y + secondBounds.height * .45);
  await expect(surface).toBeHidden();
  expect(Number(await from.inputValue())).toBeLessThan(Number(await to.inputValue()));
  expect(requests).toHaveLength(1);
});
