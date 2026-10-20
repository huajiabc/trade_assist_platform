import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { createMockAnalysis } from '../../shared/mock';
import { SAMPLE_CANDLES } from '../../shared/sample';
import { validateAnalysis, type Analysis } from '../../shared/analysis';
import type { Candle } from '../../shared/market';

// Browser-only fixtures: all market and analysis responses stay local and no
// authenticated API/Codex request can escape the route handlers below.
const candles: Candle[] = SAMPLE_CANDLES.map((candle, index) => ({ ...candle, timestamp: 1791244800 + index * 60 }));
const low = Math.min(...candles.map(candle => candle.low));
const high = Math.max(...candles.map(candle => candle.high));
const priceAt = (fraction: number) => low + (high - low) * fraction;

function result(levels: Analysis['keyLevels']): Analysis {
  const mock = createMockAnalysis(candles);
  return validateAnalysis({ ...mock, structures: [], opportunities: [], tradeSetups: [], liquiditySweeps: [],
    tradePlanning: { status: 'no-setup', reason: '关键价位测试仅展示价格参考，没有可执行的开仓或文字观察计划。' },
    priceAction: { ...mock.priceAction, zones: [], legs: [], patterns: [], breakouts: [] }, keyLevels: levels,
  }, candles);
}

const initial = result([
  { label: '前段阻力参考', price: priceAt(.7), reason: '历史阻力边界，仍需后续价格行为确认。' },
  { label: '中段支撑参考', price: priceAt(.4), reason: '回撤低点附近的观察价位，不是确定信号。' },
  { label: '区间中轴参考', price: priceAt(.55), reason: '当前分析区间内的中轴参考。' },
]);
const replacement = result([{ label: '更新后的唯一价位', price: priceAt(.45), reason: '重新分析后替换旧结果的观察价位。' }]);

async function load(page: Page) {
  let requests = 0;
  let next = initial;
  await page.route('**/api/market/stream?*', route => route.abort());
  await page.route('**/api/market/candles?*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    provider: 'binance', market: 'usdt-perpetual', symbol: 'SNDKUSDT', interval: '1m', candles,
    lastCandleClosed: true, serverTime: (candles.at(-1)!.timestamp + 61) * 1000, fetchedAt: new Date().toISOString(), warnings: [],
  }) }));
  await page.route('**/api/analyze', route => {
    requests++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      analysis: next, source: 'mock', model: 'key-level-browser-fixture', analyzedBars: candles.length, generatedAt: new Date().toISOString(),
    }) });
  });
  await page.goto('/?live=SNDKUSDT&interval=1m');
  await expect(page.locator('.price-stat strong')).not.toHaveText('—');
  await page.getByRole('checkbox', { name: '实时更新', exact: true }).uncheck();
  const analyze = page.getByRole('button', { name: '分析当前 K 线范围', exact: true });
  await analyze.click();
  await expect(page.locator('button.key-level')).toHaveCount(initial.keyLevels.length);
  return { analyze, requests: () => requests, replace: () => { next = replacement; } };
}

async function linePixels(page: Page, selected = false): Promise<number> {
  return page.locator('.chart-host canvas').evaluateAll((nodes, color) => {
    let count = 0;
    for (const node of nodes) {
      const canvas = node as HTMLCanvasElement;
      if (!canvas.width || !canvas.height) continue;
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset + 3] > 100 && color.every((channel, index) => Math.abs(pixels[offset + index] - channel) <= 1)) count++;
      }
    }
    return count;
  }, selected ? [240, 198, 116] : [128, 148, 181]);
}

test('AI key levels draw native horizontal lines, toggle independently and reopen by selecting a level', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const fixture = await load(page);
  const toggle = page.getByRole('checkbox', { name: /关键价位/ });
  await expect(toggle).toBeChecked();
  await expect.poll(() => linePixels(page)).toBeGreaterThan(200);
  for (const view of ['SMC 主视图', 'PA 主视图']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await expect(toggle).toBeChecked();
    await expect.poll(() => linePixels(page)).toBeGreaterThan(200);
  }
  await toggle.uncheck();
  await expect.poll(() => linePixels(page)).toBe(0);
  const first = page.locator('button.key-level').first();
  await first.click();
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toBeChecked();
  await expect.poll(() => linePixels(page, true)).toBeGreaterThan(100);
  await toggle.uncheck();
  await expect(first).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => linePixels(page, true)).toBe(0);
  expect(fixture.requests()).toBe(1);
  expect(errors).toEqual([]);
});

test('reanalysis replaces lines and clears selection without leaving previous levels behind', async ({ page }) => {
  const fixture = await load(page);
  await page.locator('button.key-level').nth(1).click();
  await expect.poll(() => linePixels(page, true)).toBeGreaterThan(100);
  fixture.replace();
  await fixture.analyze.click();
  await expect(page.locator('button.key-level')).toHaveCount(1);
  await expect(page.locator('button.key-level')).toContainText('更新后的唯一价位');
  await expect(page.locator('button.key-level')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => linePixels(page, true)).toBe(0);
  await expect.poll(() => linePixels(page)).toBeGreaterThan(100);
  for (let cycle = 0; cycle < 3; cycle++) {
    const toggle = page.getByRole('checkbox', { name: /关键价位/ });
    await toggle.uncheck();
    await expect.poll(() => linePixels(page)).toBe(0);
    await toggle.check();
    await expect.poll(() => linePixels(page)).toBeGreaterThan(100);
  }
  await page.locator('button.key-level').click();
  await page.getByRole('button', { name: '重置图表视图', exact: true }).click();
  await expect(page.locator('button.key-level')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => linePixels(page, true)).toBe(0);
  expect(fixture.requests()).toBe(2);
});

test('mobile key level controls remain accessible, focusable and inside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await load(page);
  const level = page.getByRole('button', { name: /定位关键价位 1.*前段阻力参考/ });
  await level.click();
  await expect(level).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => linePixels(page, true)).toBeGreaterThan(40);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.key-levels').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.getByRole('checkbox', { name: /关键价位/ }).uncheck();
  await expect(level).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => linePixels(page, true)).toBe(0);
  expect(fixture.requests()).toBe(1);
});
