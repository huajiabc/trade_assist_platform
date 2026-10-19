import { test, expect } from './fixtures';
import { LIVE_INTERVAL_SECONDS, type LiveInterval, type MarketSnapshot } from '../../shared/liveMarket';

function fixture(interval: LiveInterval = '1h'): MarketSnapshot {
  const start = 1791255600; // UTC hour boundary
  const candles = Array.from({ length: 40 }, (_, index) => {
    const open = 1200 + Math.sin(index * .65) * 10;
    const close = open + Math.sin(index) * 2;
    return { timestamp: start + index * LIVE_INTERVAL_SECONDS[interval], open, high: Math.max(open, close) + 2, low: Math.min(open, close) - 2, close, volume: 100 + index };
  });
  return { provider: 'binance', market: 'usdt-perpetual', symbol: 'SNDKUSDT', interval, candles, lastCandleClosed: false, serverTime: (candles.at(-1)!.timestamp + LIVE_INTERVAL_SECONDS[interval] / 3) * 1000, fetchedAt: new Date().toISOString(), warnings: [] };
}

test('root automatically connects SNDKUSDT 5m and keeps pending data empty until the exchange responds', async ({ page }) => {
  const queries: URLSearchParams[] = [];
  let analysisRequests = 0;
  let release!: () => void;
  const responseGate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/market/stream?*', route => route.abort());
  await page.route('**/api/market/candles?*', async route => {
    queries.push(new URL(route.request().url()).searchParams);
    await responseGate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture('5m')) });
  });
  page.on('request', request => { if (request.url().endsWith('/api/analyze')) analysisRequests++; });
  await page.goto('/');
  await expect.poll(() => queries.length).toBeGreaterThan(0);
  expect(queries[0].get('symbol')).toBe('SNDKUSDT');
  expect(queries[0].get('interval')).toBe('5m');
  await expect(page.locator('.instrument-name')).toContainText('SNDKUSDT');
  await expect(page.locator('.price-stat strong')).toHaveText('—');
  await expect(page.getByRole('heading', { name: '正在连接真实行情…' })).toBeVisible();
  await expect(page.getByRole('button', { name: /AI 分析/ }).first()).toBeDisabled();
  await expect(page.locator('.structure-row, .pa-evidence-card')).toHaveCount(0);
  await expect(page.locator('.instrument-meta')).not.toContainText('合成');
  await expect(page.locator('.source-badge').first()).not.toContainText('模拟分析');
  expect(analysisRequests).toBe(0);
  release();
  await expect(page.locator('.price-stat strong')).toHaveText(/1,?2/);
  await expect(page.locator('.live-market-status')).toContainText('末根未收盘');
  await expect(page.getByLabel('K 线周期', { exact: true })).toHaveValue('5m');
  await expect(page.getByRole('button', { name: /AI 分析/ }).first()).toBeEnabled();
  await expect(page.locator('.structure-row, .pa-evidence-card')).toHaveCount(0);
  expect(analysisRequests).toBe(0);
});

test('failed initial exchange load never replaces data with a sample and can be retried', async ({ page }) => {
  let fail = true;
  let analysisRequests = 0;
  await page.route('**/api/market/stream?*', route => route.abort());
  await page.route('**/api/market/candles?*', route => route.fulfill({
    status: fail ? 502 : 200, contentType: 'application/json',
    body: JSON.stringify(fail ? { error: { message: '行情网络暂时不可用' } } : fixture('5m')),
  }));
  page.on('request', request => { if (request.url().endsWith('/api/analyze')) analysisRequests++; });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('行情网络暂时不可用');
  await expect(page.getByRole('heading', { name: '真实行情暂不可用' })).toBeVisible();
  await expect(page.locator('.instrument-name')).toContainText('SNDKUSDT');
  await expect(page.locator('.price-stat strong')).toHaveText('—');
  await expect(page.getByRole('button', { name: /AI 分析/ }).first()).toBeDisabled();
  await expect(page.locator('.structure-row, .pa-evidence-card')).toHaveCount(0);
  await expect(page.locator('.instrument-meta')).not.toContainText('合成');
  await expect(page.locator('.source-badge').first()).not.toContainText('模拟分析');
  expect(analysisRequests).toBe(0);
  fail = false;
  await page.getByRole('button', { name: '加载行情', exact: true }).click();
  await expect(page.locator('.live-market-status')).toContainText('SNDKUSDT');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.price-stat strong')).not.toHaveText('—');
  await expect(page.getByRole('button', { name: /AI 分析/ }).first()).toBeEnabled();
  expect(analysisRequests).toBe(0);
});

test('loads exchange data, excludes unclosed candle from analysis, and preserves data on outage', async ({ page }) => {
  await page.route('**/api/market/stream?*', route => route.abort());
  let fail = false;
  await page.route('**/api/market/candles?*', route => route.fulfill({ status: fail ? 502 : 200, contentType: 'application/json', body: JSON.stringify(fail ? { error: { message: '行情网络暂时不可用' } } : fixture()) }));
  await page.goto('/?live=SNDKUSDT&interval=1h');
  await expect(page.locator('.instrument-name')).toContainText('SNDKUSDT');
  await expect(page.locator('.live-market-status')).toContainText('末根未收盘');
  await expect(page.locator('.empty-state')).toBeVisible();
  const analysisRequest = page.waitForRequest('**/api/analyze');
  await page.getByRole('button', { name: /AI 分析/ }).first().click();
  const sent = (await analysisRequest).postDataJSON();
  expect(sent.candles).toHaveLength(39);
  expect(sent.candles.at(-1).timestamp).toBe(fixture().candles.at(-2)!.timestamp);
  expect(sent.context.notes).toContain('Sandisk');
  await expect(page.getByRole('status').filter({ hasText: '分析完成' })).toBeVisible();
  const before = await page.locator('.price-stat strong').textContent();
  fail = true;
  await page.locator('.market-refresh').click();
  await expect(page.getByRole('alert')).toContainText('行情网络暂时不可用');
  await expect(page.locator('.live-market-status')).toContainText('保留上次真实数据');
  await expect(page.locator('.instrument-name')).toContainText('SNDKUSDT');
  await expect(page.locator('.price-stat strong')).toHaveText(before!);
});

test('closed-history corrections retain a reviewable stale analysis; forming-only updates keep it current', async ({ page }) => {
  await page.route('**/api/market/stream?*', route => route.abort());
  let snapshot = fixture();
  await page.route('**/api/market/candles?*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) }));
  await page.goto('/?live=SNDKUSDT&interval=1h');
  await expect(page.locator('.instrument-name')).toContainText('SNDKUSDT');
  await page.getByRole('button', { name: /AI 分析/ }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '分析完成' })).toBeVisible();
  await page.getByRole('tab', { name: /结构依据/ }).click();
  const beforeCount = await page.locator('.structure-row').count();
  snapshot = structuredClone(snapshot);
  snapshot.candles.at(-1)!.volume += 10;
  await page.locator('.market-refresh').click();
  await expect(page.locator('.market-refresh')).toBeEnabled();
  await expect(page.locator('.structure-row')).toHaveCount(beforeCount);
  await expect(page.getByLabel('分析任务状态')).not.toContainText('行情已更新，当前结果需复核');
  snapshot = structuredClone(snapshot);
  snapshot.candles.at(-2)!.volume += 10;
  await page.locator('.market-refresh').click();
  await expect(page.locator('.market-refresh')).toBeEnabled();
  await expect(page.locator('.structure-row')).toHaveCount(beforeCount);
  await expect(page.getByLabel('分析任务状态')).toContainText('行情已更新，当前结果需复核');
  await expect(page.locator('.analysis-provenance')).toContainText('规则模拟');
});

test('loads actual SNDKUSDT public market when explicitly enabled', async ({ page }) => {
  test.skip(process.env.LIVE_MARKET_SMOKE !== '1', 'External connectivity check is opt-in; normal tests use fixtures.');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?live=SNDKUSDT&interval=1h');
  await expect(page.locator('.instrument-name')).toContainText('SNDKUSDT', { timeout: 20_000 });
  await expect(page.locator('.instrument-meta')).toContainText('Binance');
  await expect(page.locator('.live-market-status')).toContainText('股票永续');
  await expect(page.locator('.chart-host canvas').first()).toBeVisible();
  await page.getByRole('button', { name: /AI 分析/ }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '分析完成' })).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/sndkusdt-real-market.png', fullPage: true });
  expect(errors).toEqual([]);
});
