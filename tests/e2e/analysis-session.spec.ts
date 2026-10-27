import { test, expect } from './fixtures';
import type { Page, Route } from '@playwright/test';
import { createMockAnalysis } from '../../shared/mock';
import { LIVE_INTERVAL_SECONDS, type LiveInterval, type MarketSnapshot } from '../../shared/liveMarket';
import type { Candle } from '../../shared/market';

const readyHealth = {
  configured: true, model: 'session-test-model', provider: 'codex', maxAnalysisCandles: 300,
  activeProvider: 'codex', providers: { codex: true, api: false },
  codex: { available: true, authenticated: true, message: '测试已验证的 Codex 来源。' },
};

function fixture(interval: LiveInterval = '5m', candleCount = 40): MarketSnapshot {
  const candles = Array.from({ length: candleCount }, (_, index) => {
    const open = 1200 + Math.sin(index * .65) * 10;
    const close = open + Math.sin(index) * 2;
    return { timestamp: 1791244800 + index * LIVE_INTERVAL_SECONDS[interval], open, high: Math.max(open, close) + 2, low: Math.min(open, close) - 2, close, volume: 100 + index };
  });
  return { provider: 'binance', market: 'usdt-perpetual', symbol: 'SNDKUSDT', interval, candles, lastCandleClosed: false, serverTime: (candles.at(-1)!.timestamp + LIVE_INTERVAL_SECONDS[interval] / 3) * 1000, fetchedAt: new Date().toISOString(), warnings: [] };
}

function nextBar(snapshot: MarketSnapshot): MarketSnapshot {
  const last = snapshot.candles.at(-1)!;
  const candle = { ...last, timestamp: last.timestamp + LIVE_INTERVAL_SECONDS[snapshot.interval], volume: last.volume + 10 };
  return { ...snapshot, candles: [...snapshot.candles, candle], serverTime: (candle.timestamp + LIVE_INTERVAL_SECONDS[snapshot.interval] / 3) * 1000, fetchedAt: new Date().toISOString() };
}

function deferred() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

async function fulfillAnalysis(route: Route, model = 'session-test-model', analysisAttempts?: 1 | 2) {
  const candles: Candle[] = route.request().postDataJSON().candles;
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    analysis: createMockAnalysis(candles), source: 'ai', model, provider: 'codex', billing: 'chatgpt-plan',
    analyzedBars: candles.length, generatedAt: new Date().toISOString(), ...(analysisAttempts ? { analysisAttempts } : {}),
  }) });
}

async function setupMarket(page: Page, getSnapshot: () => MarketSnapshot, interval: LiveInterval = '5m') {
  await page.route('**/api/health', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(readyHealth) }));
  await page.route('**/api/market/stream?*', route => route.abort());
  await page.route('**/api/market/candles?*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(getSnapshot()) }));
  await page.goto(`/?live=SNDKUSDT&interval=${interval}`);
  await expect(page.getByLabel('分析来源', { exact: true })).toHaveValue('codex');
  await expect(page.locator('.price-stat strong')).not.toHaveText('—');
}

test('a new closed bar cannot cancel a pending analysis or erase its frozen-snapshot result', async ({ page }) => {
  let snapshot = fixture();
  const response = deferred();
  const handled = deferred();
  const requests: { candles: Candle[]; provider: string }[] = [];
  await page.route('**/api/analyze', async route => {
    requests.push(route.request().postDataJSON());
    await response.promise;
    try { await fulfillAnalysis(route); } catch { /* Browser cancellation is asserted below. */ }
    finally { handled.release(); }
  });
  await setupMarket(page, () => snapshot);
  await page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first().click();
  await expect.poll(() => requests.length).toBe(1);
  const analyzedLast = requests[0].candles.at(-1)!;
  expect(requests[0].candles).toHaveLength(39);
  snapshot = nextBar(snapshot);
  await page.locator('.market-refresh').click();
  await expect(page.locator('.market-refresh')).toBeEnabled();
  // This failed before the fix: refresh silently aborted the in-flight model call.
  await expect(page.getByLabel('分析来源', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '自动范围', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '手动范围', exact: true })).toBeDisabled();
  await expect(page.getByLabel('分析任务状态')).toContainText('正在分析');
  await expect(page.getByLabel('分析任务状态')).toContainText('39 根');
  response.release();
  await handled.promise;
  await expect(page.locator('.analysis-provenance')).toContainText('session-test-model');
  await expect(page.getByLabel('分析任务状态')).toHaveClass(/phase-success/);
  await expect(page.getByLabel('分析任务状态')).toContainText('行情已更新，当前结果需复核');
  await expect(page.getByLabel('分析任务状态')).toContainText(new Date((analyzedLast.timestamp + 28800) * 1000).toISOString().slice(0, 16).replace('T', ' '));
  await expect(page.locator('.analysis-counts')).toContainText('39');
  await page.getByRole('tab', { name: /结构依据/ }).click();
  const evidenceCount = await page.locator('.structure-row').count();
  expect(evidenceCount).toBeGreaterThan(0);
  snapshot = nextBar(snapshot);
  await page.locator('.market-refresh').click();
  await expect(page.locator('.market-refresh')).toBeEnabled();
  await expect(page.locator('.analysis-provenance')).toContainText('session-test-model');
  await expect(page.locator('.structure-row')).toHaveCount(evidenceCount);
  await expect(page.getByLabel('分析任务状态')).toContainText('行情已更新，当前结果需复核');
  expect(requests).toHaveLength(1);
  expect(requests[0].candles.at(-1)!.timestamp).toBe(analyzedLast.timestamp);
});

test('1m analysis sends an unambiguous minute interval and survives rolling candles during the request', async ({ page }) => {
  let snapshot = fixture('1m', 300);
  const response = deferred();
  const handled = deferred();
  const requests: { candles: Candle[]; context: { symbol: string; timeframe: string; notes: string } }[] = [];
  await page.route('**/api/analyze', async route => {
    requests.push(route.request().postDataJSON());
    await response.promise;
    try { await fulfillAnalysis(route, 'one-minute-fixed-snapshot', 2); } catch { /* Cancellation is checked below. */ }
    finally { handled.release(); }
  });
  await setupMarket(page, () => snapshot, '1m');
  await expect(page.locator('.instrument-name .interval')).toHaveText('1M');
  const expectedInput = structuredClone(snapshot.candles.slice(0, -1));
  await page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first().click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].context).toMatchObject({ symbol: 'SNDKUSDT', timeframe: '1m' });
  expect(requests[0].context.notes).toContain('每根 K 线 60 秒');
  expect(requests[0].candles).toEqual(expectedInput);

  // Simulate three minute closes while the model is running, including the
  // production 300-candle rolling limit and changing the excluded forming bar.
  for (let index = 0; index < 3; index++) {
    snapshot = nextBar(snapshot);
    snapshot.candles = snapshot.candles.slice(-300);
  }
  snapshot.candles.at(-1)!.high += 20;
  snapshot.candles.at(-1)!.volume += 50;
  await page.locator('.market-refresh').click();
  await expect(page.locator('.market-refresh')).toBeEnabled();
  await expect(page.getByLabel('分析任务状态')).toContainText('正在分析');
  await expect(page.getByLabel('分析任务状态')).toContainText('299 根');
  await expect(page.getByLabel('分析任务状态')).toContainText('最多调用模型 2 次');
  await expect(page.getByLabel('分析来源', { exact: true })).toBeDisabled();
  expect(snapshot.candles[0].timestamp).toBeGreaterThan(expectedInput[0].timestamp);

  response.release();
  await handled.promise;
  await expect(page.locator('.analysis-provenance')).toContainText('one-minute-fixed-snapshot');
  await expect(page.locator('.analysis-provenance')).toContainText('已修正 1 次 · 共调用模型 2 次');
  await expect(page.locator('.analysis-provenance')).not.toContainText('用量含两次调用');
  await expect(page.getByLabel('分析任务状态')).toHaveClass(/phase-success/);
  await expect(page.getByLabel('分析任务状态')).toContainText('行情已更新，当前结果需复核');
  await expect(page.getByLabel('分析任务状态')).toContainText('固定输入 299 根');
  await expect(page.getByLabel('分析任务状态')).toContainText(new Date((expectedInput.at(-1)!.timestamp + 28800) * 1000).toISOString().slice(0, 16).replace('T', ' '));
  await page.getByRole('tab', { name: /结构依据/ }).click();
  await expect.poll(() => page.locator('.structure-row').count()).toBeGreaterThan(0);
  expect(requests).toHaveLength(1);
  expect(requests[0].candles).toEqual(expectedInput);
  expect(requests[0].candles.some(candle => candle.timestamp > expectedInput.at(-1)!.timestamp)).toBe(false);
});

test('model errors remain visible through ordinary ticks and closed-history corrections', async ({ page }) => {
  let snapshot = fixture();
  let requests = 0;
  await page.route('**/api/analyze', route => {
    requests++;
    return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: { message: '测试模型连接失败，请检查代理后重试。' } }) });
  });
  await setupMarket(page, () => snapshot);
  await page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first().click();
  await expect(page.getByLabel('分析任务状态')).toContainText('测试模型连接失败');
  snapshot = structuredClone(snapshot);
  snapshot.candles.at(-1)!.volume += 10;
  snapshot.serverTime += 1000;
  await page.locator('.market-refresh').click();
  await expect(page.locator('.market-refresh')).toBeEnabled();
  await expect(page.getByLabel('分析任务状态')).toContainText('测试模型连接失败');
  snapshot.candles.at(-2)!.volume += 10;
  snapshot.serverTime += 1000;
  await page.locator('.market-refresh').click();
  await expect(page.locator('.market-refresh')).toBeEnabled();
  await expect(page.getByLabel('分析任务状态')).toContainText('测试模型连接失败');
  await expect(page.getByLabel('分析任务状态')).toContainText('测试模型连接失败');
  expect(requests).toBe(1);
});

test('explicit interval switching aborts immediately and a late old response cannot replace a new result', async ({ page }) => {
  let snapshot = fixture();
  const oldResponse = deferred();
  const oldHandled = deferred();
  const replacementMarket = deferred();
  let count = 0;
  await page.route('**/api/analyze', async route => {
    count++;
    if (count > 1) { await fulfillAnalysis(route, 'replacement-market-result'); return; }
    await oldResponse.promise;
    try { await fulfillAnalysis(route, 'obsolete-market-result'); } catch { /* Expected request abort. */ }
    finally { oldHandled.release(); }
  });
  await setupMarket(page, () => snapshot);
  await page.route('**/api/market/candles?*', async route => {
    await replacementMarket.promise;
    snapshot = fixture('15m');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) });
  });
  await page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first().click();
  await expect.poll(() => count).toBe(1);
  const aborted = page.waitForEvent('requestfailed', request => request.url().endsWith('/api/analyze'));
  await page.getByRole('button', { name: '切换到 15m 周期', exact: true }).click();
  await aborted;
  // This must unlock before the replacement market request has returned.
  await expect(page.getByLabel('分析来源', { exact: true })).toBeEnabled();
  replacementMarket.release();
  await expect(page.getByLabel('K 线周期', { exact: true })).toHaveValue('15m');
  await expect(page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first()).toBeEnabled();
  await page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first().click();
  await expect(page.locator('.analysis-provenance')).toContainText('replacement-market-result');
  oldResponse.release();
  await oldHandled.promise;
  await expect(page.locator('.analysis-provenance')).toContainText('replacement-market-result');
  await expect(page.locator('.analysis-provenance')).not.toContainText('obsolete-market-result');
  expect(count).toBe(2);
});

test('analysis feedback and cancellation stay visible in a mobile focused chart', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const response = deferred();
  const handled = deferred();
  let requests = 0;
  await page.route('**/api/analyze', async route => {
    requests++;
    await response.promise;
    try { await fulfillAnalysis(route, 'cancelled-mobile-result'); } catch { /* Expected request abort. */ }
    finally { handled.release(); }
  });
  await setupMarket(page, () => fixture());
  await page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first().click();
  await expect.poll(() => requests).toBe(1);
  await page.getByRole('button', { name: '专注图表', exact: true }).click();
  const chartStatus = page.getByLabel('图表分析状态');
  await chartStatus.scrollIntoViewIfNeeded();
  await expect(chartStatus).toContainText('正在分析');
  await expect(chartStatus).toContainText(/已等待 \d+ 秒/);
  await expect(chartStatus.getByRole('button', { name: '取消分析', exact: true })).toBeVisible();
  await expect(chartStatus).toBeVisible();
  const bounds = await chartStatus.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  await chartStatus.getByRole('button', { name: '取消分析', exact: true }).click();
  await expect(chartStatus).toContainText('分析已取消');
  await expect(page.getByLabel('分析来源', { exact: true })).toBeEnabled();
  response.release();
  await handled.promise;
  await expect(page.locator('.analysis-provenance')).toHaveCount(0);
  await expect(chartStatus).toContainText('分析已取消');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
