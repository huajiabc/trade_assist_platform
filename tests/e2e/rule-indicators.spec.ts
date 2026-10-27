import { test, expect, showChartSettings } from './fixtures';
import type { Page } from '@playwright/test';
import { detectRuleIndicators } from '../../shared/indicators';
import type { Candle } from '../../shared/market';
import type { MarketSnapshot } from '../../shared/liveMarket';

const START = 1791244800;
const bar = (index: number, open: number, high: number, low: number, close: number): Candle => ({
  timestamp: START + index * 300, open, high, low, close, volume: 100 + index,
});

/** Explicit wick gap and 2/2 close-break examples, wrapped in the live API shape. */
function indicatorHistory(): Candle[] {
  const values = [
    [100, 110, 90, 100], [110, 130, 100, 120], [120, 150, 110, 140],
    [140, 140, 110, 120], [120, 140, 110, 130], [130, 170, 120, 160], // OB body 120..140.
    [160, 170, 130, 150], [150, 160, 100, 110], // Test, then invalidate that OB.
    [110, 120, 90, 100], [100, 110, 90, 100], [100, 110, 90, 100],
    [100, 140, 100, 130], [140, 150, 130, 140], // FVG 110..130.
    [140, 150, 120, 140], [140, 150, 110, 140], // Partial, then full fill.
    [140, 150, 130, 140], [140, 150, 130, 140], [140, 180, 140, 170],
    [180, 190, 170, 180], [180, 190, 175, 180], [180, 190, 175, 180],
    [180, 190, 175, 180], [200, 210, 190, 200], [210, 230, 200, 220],
    [220, 250, 210, 240], [240, 240, 210, 220], [220, 240, 210, 230],
    [230, 270, 220, 260], // A current OB body 220..240, known at this close.
    [260, 270, 250, 260], // Unclosed live tail, never included in detection.
  ];
  return values.map(([open, high, low, close], index) => bar(index, open, high, low, close));
}

function market(candles: Candle[], lastCandleClosed = false, symbol = 'SNDKUSDT'): MarketSnapshot {
  return { provider: 'binance', market: 'usdt-perpetual', symbol, interval: '5m', candles,
    lastCandleClosed, serverTime: (candles.at(-1)!.timestamp + (lastCandleClosed ? 301 : 100)) * 1000,
    fetchedAt: new Date().toISOString(), warnings: [] };
}

async function installMarket(page: Page, snapshot: () => MarketSnapshot) {
  let analysisRequests = 0;
  await page.route('**/api/market/stream?*', route => route.abort());
  await page.route('**/api/market/candles?*', route => {
    const symbol = new URL(route.request().url()).searchParams.get('symbol')!;
    const data = symbol === 'SNDKUSDT' ? snapshot()
      : market(Array.from({ length: 29 }, (_, index) => bar(index, 100, 101, 99, 100)), false, symbol);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  // Even accidental clicks are intercepted: this suite cannot consume model quota.
  await page.route('**/api/analyze', route => {
    analysisRequests++;
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { message: '规则指标测试禁止模型调用' } }) });
  });
  await page.goto('/?live=SNDKUSDT&interval=5m');
  // Isolate the FVG/OB color assertions from the independently tested session tint.
  const sessions = page.getByRole('button', { name: '时段底色', exact: true });
  if (await sessions.getAttribute('aria-pressed') === 'true') await sessions.click();
  await showChartSettings(page);
  await page.locator('details.chart-indicator-details > summary').click();
  await expect(page.locator('.price-stat strong')).not.toHaveText('—');
  await page.getByRole('checkbox', { name: '实时更新', exact: true }).uncheck();
  return () => analysisRequests;
}

async function coloredCanvasPixels(page: Page, type: 'FVG' | 'OB'): Promise<number> {
  return page.locator('.chart-host canvas').evaluateAll((canvases, indicatorType) => {
    const colors = indicatorType === 'FVG' ? [[135, 151, 210], [173, 145, 201]] : [[101, 180, 166], [206, 151, 133]];
    // Borderless zones are translucent fills, while the small center text can
    // be suppressed when a candle cell is too narrow. Inspect both paint forms.
    const fillColors = colors.flatMap(color => [.14, .24].map(opacity => color.map((channel, index) => Math.round(channel * opacity + [16, 20, 28][index] * (1 - opacity)))));
    let count = 0;
    for (const node of canvases) {
      const canvas = node as HTMLCanvasElement;
      if (!canvas.width || !canvas.height) continue;
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset + 3] > 100 && (colors.some(color => color.every((channel, index) => Math.abs(pixels[offset + index] - channel) <= 9))
          || fillColors.some(color => color.every((channel, index) => Math.abs(pixels[offset + index] - channel) <= 2)))) count++;
      }
    }
    return count;
  }, type);
}

const utc = (timestamp: number) => new Date((timestamp + 28800) * 1000).toISOString().replace('T', ' ').slice(0, 16);

test('closed OHLC immediately draws independent FVG and OB layers before AI, with mode and history toggles', async ({ page }) => {
  const snapshot = market(indicatorHistory());
  const requestCount = await installMarket(page, () => snapshot);
  const expected = detectRuleIndicators(snapshot.candles.slice(0, -1));
  const panel = page.getByLabel('规则 FVG 与 OB 指标', { exact: true });
  const legend = page.getByLabel('结构绘图图例', { exact: true });
  await expect(legend.getByText('FVG', { exact: true })).toBeVisible();
  await expect(legend.getByText('OB', { exact: true })).toBeVisible();
  for (const type of ['FVG', 'OB'] as const) {
    const current = expected.zones.filter(zone => zone.type === type && zone.status !== 'filled' && zone.status !== 'invalidated');
    expect(current.length).toBeGreaterThan(0);
    await expect(panel.locator(`.type-${type.toLowerCase()} small`)).toHaveText(String(current.length));
    await expect.poll(() => coloredCanvasPixels(page, type)).toBeGreaterThan(20);
  }
  await expect(page.locator('.analysis-provenance')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'PA 主视图', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'SMC 主视图', exact: true }).click();
  await expect(panel).toBeVisible();
  await expect.poll(() => coloredCanvasPixels(page, 'FVG')).toBeGreaterThan(20);
  await expect.poll(() => coloredCanvasPixels(page, 'OB')).toBeGreaterThan(20);

  await panel.locator('.type-fvg input').uncheck();
  await expect.poll(() => coloredCanvasPixels(page, 'FVG')).toBe(0);
  await expect(legend.getByText('FVG', { exact: true })).toHaveCount(0);
  await expect.poll(() => coloredCanvasPixels(page, 'OB')).toBeGreaterThan(20);
  await panel.locator('.type-fvg input').check();
  await panel.locator('.type-ob input').uncheck();
  await expect.poll(() => coloredCanvasPixels(page, 'OB')).toBe(0);
  await expect(legend.getByText('OB', { exact: true })).toHaveCount(0);
  await expect.poll(() => coloredCanvasPixels(page, 'FVG')).toBeGreaterThan(20);
  await panel.locator('.type-ob input').check();
  await panel.getByRole('checkbox', { name: '显示历史回补 / 失效', exact: true }).check();
  for (const type of ['FVG', 'OB'] as const) {
    await expect(panel.locator(`.type-${type.toLowerCase()} small`)).toHaveText(String(expected.zones.filter(zone => zone.type === type).length));
  }
  await panel.locator('summary').click();
  await expect(panel).toContainText('FVG 为三烛影线缺口');
  await expect(panel).toContainText('OB 为收盘突破已确认摆点前的最后反向实体候选');
  await expect(panel).toContainText('显示开关仅影响图表，不影响 AI 参考');
  expect(requestCount()).toBe(0);
});

test('historical and current rule evidence focuses its exact formation candle and resets selection on symbol changes', async ({ page }) => {
  const snapshot = market(indicatorHistory());
  const requestCount = await installMarket(page, () => snapshot);
  const panel = page.getByLabel('规则 FVG 与 OB 指标', { exact: true });
  await panel.locator('summary').click();
  const expected = detectRuleIndicators(snapshot.candles.slice(0, -1));
  const historical = expected.zones.find(zone => zone.type === 'FVG' && zone.originTime === snapshot.candles[10].timestamp)!;
  const current = expected.zones.find(zone => zone.type === 'OB' && zone.originTime === snapshot.candles[25].timestamp)!;
  expect(historical).toMatchObject({ status: 'filled', lowerPrice: 110, upperPrice: 130, formedAt: snapshot.candles[12].timestamp });
  expect(current).toMatchObject({ status: 'active', lowerPrice: 220, upperPrice: 240, formedAt: snapshot.candles[27].timestamp });
  for (const zone of [historical, current]) {
    const row = panel.locator(`[data-rule-indicator-id="${zone.id}"]`);
    await row.locator('.rule-indicator-focus').click();
    await expect(row).toHaveClass(/is-selected/);
    await expect(row.locator('.rule-indicator-price')).toContainText(`${zone.lowerPrice} 至 ${zone.upperPrice}`);
    await expect(row).toContainText(`形成 ${utc(zone.formedAt)} UTC+8`);
    await expect(row).toContainText(`起源 ${utc(zone.originTime)} UTC+8`);
    await expect(row.locator('.rule-indicator-evidence')).toContainText(zone.rationale);
    await expect(row.locator('.rule-indicator-evidence')).toContainText(zone.invalidation);
    await expect(page.locator('.readout-time')).toHaveText(`${utc(zone.formedAt)} UTC+8`);
    await expect.poll(() => coloredCanvasPixels(page, zone.type)).toBeGreaterThan(20);
  }
  await expect(panel.getByRole('checkbox', { name: '显示历史回补 / 失效', exact: true })).toBeChecked();
  await page.getByLabel('合约标的', { exact: true }).fill('ETHUSDT');
  await page.getByRole('button', { name: '加载行情', exact: true }).click();
  await expect(page.locator('.instrument-name')).toContainText('ETHUSDT');
  await expect(panel.locator('.rule-indicator-row')).toHaveCount(0);
  await expect(panel).toContainText('当前已加载行情未识别出符合规则');
  await page.getByLabel('合约标的', { exact: true }).fill('SNDKUSDT');
  await page.getByRole('button', { name: '加载行情', exact: true }).click();
  await expect(page.locator('.instrument-name')).toContainText('SNDKUSDT');
  // Changing the instrument clears the selected indicator and collapses its panel.
  const details = page.locator('details.chart-indicator-details');
  if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
  await expect(panel.locator('.rule-indicator-row').first()).toBeVisible();
  await expect(panel.locator('.rule-indicator-row.is-selected')).toHaveCount(0);
  expect(requestCount()).toBe(0);
});

test('forming-only gap stays absent until close and mobile rule controls do not overflow horizontally', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const candles = Array.from({ length: 20 }, (_, index) => bar(index, 100, 101, 99, 100));
  candles[18] = bar(18, 100, 110, 99, 109);
  candles[19] = bar(19, 111, 114, 111, 113);
  let snapshot = market(candles);
  expect(detectRuleIndicators(candles.slice(0, -1)).zones).toEqual([]);
  expect(detectRuleIndicators(candles).zones).toMatchObject([{ type: 'FVG', lowerPrice: 101, upperPrice: 111 }]);
  const requestCount = await installMarket(page, () => snapshot);
  const panel = page.getByLabel('规则 FVG 与 OB 指标', { exact: true });
  await expect(panel.locator('.type-fvg small')).toHaveText('0');
  await expect(panel.locator('.type-ob small')).toHaveText('0');
  await panel.locator('summary').click();
  await expect(panel).toContainText('当前已加载行情未识别出符合规则');
  snapshot = market(candles, true);
  await page.locator('.market-refresh').click();
  await expect(panel.locator('.type-fvg small')).toHaveText('1');
  await expect(panel.locator('.rule-indicator-row')).toHaveCount(1);
  await panel.locator('.rule-indicator-focus').click();
  await expect(panel.locator('.rule-indicator-evidence')).toBeVisible();
  await expect(page.locator('.readout-time')).toHaveText(`${utc(candles[19].timestamp)} UTC+8`);
  await expect.poll(() => coloredCanvasPixels(page, 'FVG')).toBeGreaterThan(20);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(requestCount()).toBe(0);
});
