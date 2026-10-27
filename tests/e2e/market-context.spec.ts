import { test, expect } from './fixtures';
import { createMockAnalysis } from '../../shared/mock';
import { MARKET_CONTEXT_VERSION, candleMarketContexts } from '../../shared/marketContext';
import { chartImageBytes } from '../../server/chartImages';
import { modelPayload } from '../../server/provider';
import { writeFile } from 'node:fs/promises';

const start = Date.parse('2026-10-21T16:00:00Z') / 1000;
const candles = Array.from({ length: 300 }, (_, i) => {
  const open = 1300 + Math.sin(i / 15) * 20, close = open + Math.cos(i / 3) * 2;
  return { timestamp: start + i * 300, open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume: i === 299 ? 320 : 100 + i % 10 * 5 };
});
test('equity clock shading, RVOL, pan/zoom and actual model screenshot share one snapshot', async ({ page }) => {
  const errors: string[] = [], requests: any[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/health', r => r.fulfill({ json: { configured: true, model: 'test-only', provider: 'codex', maxAnalysisCandles: 300, activeProvider: 'codex', providers: { codex: true, api: false }, codex: { available: true, authenticated: true, message: 'Injected transport only' } } }));
  await page.route('**/api/market/stream?*', r => r.abort());
  await page.route('**/api/market/candles?*', r => r.fulfill({ json: { provider: 'binance', market: 'usdt-perpetual', symbol: 'SNDKUSDT', interval: '5m', candles, lastCandleClosed: true, serverTime: (start + 300 * 300) * 1000, fetchedAt: new Date((start + 300 * 300) * 1000).toISOString(), warnings: [] } }));
  await page.route('**/api/analyze', async r => {
    const body = r.request().postDataJSON(); requests.push(body);
    expect(body.images[0].marketContextVersion).toBe(MARKET_CONTEXT_VERSION);
    const png = chartImageBytes(body.images[0]); await writeFile('artifacts/session-volume-input.png', png);
    const payload = modelPayload({ candles: body.candles, context: body.context, visuals: body.images }) as any;
    expect(payload.marketContext.rows).toHaveLength(body.candles.length);
    expect(payload.marketContext.rows.at(-1)[2]).toBe(candleMarketContexts(body.candles, 'SNDKUSDT', '5m').at(-1)!.relativeVolume);
    return r.fulfill({ json: { analysis: createMockAnalysis(body.candles), source: 'ai', provider: 'codex', billing: 'chatgpt-plan', model: 'injected-test-transport', analyzedBars: body.candles.length, generatedAt: new Date().toISOString(), analysisAttempts: 1 } });
  });
  await page.goto('/?live=SNDKUSDT&interval=5m');
  await expect(page.locator('.market-phase')).toHaveText('盘中 · NY参考');
  await expect(page.locator('.readout-volume')).toContainText('显著放量');
  await expect(page.getByLabel('美股参考时段图例')).toContainText('夜盘');
  const toggle = page.getByRole('button', { name: '时段底色', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true'); await toggle.click(); await expect(toggle).toHaveAttribute('aria-pressed', 'false'); await toggle.click();
  const host = page.locator('.chart-host'), bounds = (await host.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * .5, bounds.y + bounds.height * .4); await page.mouse.wheel(0, -180);
  await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width * .65, bounds.y + bounds.height * .4, { steps: 6 }); await page.mouse.up();
  await page.getByLabel('分析来源', { exact: true }).selectOption('codex');
  await page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).click(); await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByRole('button', { name: '分析当前 K 线范围', exact: true })).toBeEnabled();
  const bands = await page.evaluate(async base64 => {
    const image = new Image(); image.src = 'data:image/png;base64,' + base64; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0); const pixels = ctx.getImageData(0, 75, 1180, 1).data;
    let purple = 0, yellow = 0, plain = 0;
    for (let i = 0; i < pixels.length; i += 4) { const [r, g, b] = pixels.slice(i, i + 3); if (b > r + 14 && b > g + 14 && r > 25 && g < 40) purple++; if (r > 30 && g > 30 && b < 45) yellow++; if (r === 16 && g === 20 && b === 28) plain++; }
    return { purple, yellow, plain };
  }, requests[0].images[0].base64);
  expect(bands.purple).toBeGreaterThan(20); expect(bands.yellow).toBeGreaterThan(20); expect(bands.plain).toBeGreaterThan(20);
  await page.mouse.move(0, 0); await page.locator('.chart-shell').screenshot({ path: 'artifacts/session-volume-workspace.png' });
  await page.setViewportSize({ width: 375, height: 900 }); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});
