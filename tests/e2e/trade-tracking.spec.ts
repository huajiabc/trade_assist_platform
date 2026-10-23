import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { createMockAnalysis } from '../../shared/mock';
import { validateAnalysis } from '../../shared/analysis';
import type { Candle } from '../../shared/market';
import type { MarketSnapshot } from '../../shared/liveMarket';
import { SAMPLE_CANDLES } from '../../shared/sample';
import { readFileSync } from 'node:fs';

const history: Candle[] = SAMPLE_CANDLES.map((candle, index) => ({ ...candle, timestamp: 1791244800 + index * 60 }));
const anchor = history.at(-1)!;
const entry = anchor.close;
const distance = Math.abs(createMockAnalysis(history).tradeSetups[0].entry - createMockAnalysis(history).tradeSetups[0].stopLoss) / 2;
const future = (index: number, values: Partial<Candle> = {}): Candle => ({ timestamp: anchor.timestamp + index * 60,
  open: entry, high: entry + distance, low: entry - distance / 2, close: entry, volume: 1, ...values });
const phaseRegion = (page: Page) => page.getByLabel('开仓计划可视化状态', { exact: true });

async function install(page: Page, options: { expiry?: number; legacy?: boolean } = {}) {
  let requests = 0;
  let snapshot: MarketSnapshot = { provider: 'binance', market: 'usdt-perpetual', symbol: 'SNDKUSDT', interval: '1m',
    candles: history, lastCandleClosed: true, serverTime: (anchor.timestamp + 61) * 1000, fetchedAt: new Date().toISOString(), warnings: [] };
  await page.route('**/api/market/stream?*', route => route.abort());
  await page.route('**/api/market/candles?*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) }));
  await page.route('**/api/analyze', route => {
    requests++;
    const candles: Candle[] = route.request().postDataJSON().candles;
    const analysis = createMockAnalysis(candles);
    const original = analysis.tradeSetups[0];
    analysis.tradeSetups = [{ ...original, direction: 'bullish', opportunityId: null, entry, stopLoss: entry - distance * 2,
      targets: [{ price: entry + distance * 2, label: '前高参考' }, { price: entry + distance * 3, label: '更高目标参考' }],
      trigger: '后续一根已收盘K线收于确认线以上；未满足前由收盘取消条件管理。',
      tracking: { steps: [{ label: '收盘确认', conditions: [{ type: 'close-above', price: entry + distance / 4, priceEnd: null }] }],
        cancellation: { basis: 'close', price: entry - distance, label: '收盘跌至取消线' }, expiresAfterBars: options.expiry ?? 12 } }];
    const validated = validateAnalysis(analysis, candles);
    const { research: _research, ...legacyBase } = validated;
    const output = options.legacy ? { ...legacyBase, schemaVersion: '1.3', tradeSetups: validated.tradeSetups.map(({ tracking: _rule, basis: _basis, ...setup }) => setup) } : validated;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      analysis: output, source: 'mock', model: 'tracking-transport-fixture', analyzedBars: candles.length, generatedAt: new Date().toISOString(),
    }) });
  });
  await page.goto('/?live=SNDKUSDT&interval=1m');
  await expect(page.locator('.price-stat strong')).not.toHaveText('—');
  await page.getByRole('checkbox', { name: '实时更新', exact: true }).uncheck();
  await page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).click();
  await expect(phaseRegion(page)).toContainText(options.legacy ? '需人工确认' : '待触发');
  return {
    requests: () => requests,
    async refresh(bars: Candle[], lastCandleClosed = true) {
      snapshot = { ...snapshot, candles: [...history, ...bars], lastCandleClosed,
        serverTime: (bars.at(-1)!.timestamp + (lastCandleClosed ? 61 : 30)) * 1000, fetchedAt: new Date().toISOString() };
      await page.getByRole('button', { name: '刷新真实行情', exact: true }).first().click();
      await expect(page.getByRole('button', { name: '刷新真实行情', exact: true }).first()).toBeEnabled();
    },
  };
}

test('forming candles cannot confirm a plan; closed confirmation ignores its earlier extremes and later ambiguity is explicit', async ({ page }) => {
  const fixture = await install(page);
  const wide = future(1, { high: entry + distance * 4, low: entry - distance * 3, close: entry + distance / 2 });
  await fixture.refresh([wide], false);
  await expect(phaseRegion(page).locator('[data-tracking-phase]')).toHaveAttribute('data-tracking-phase', 'waiting');
  await expect(phaseRegion(page)).toContainText('已核验 0 根');
  await fixture.refresh([wide]);
  await expect(phaseRegion(page).locator('[data-tracking-phase]')).toHaveAttribute('data-tracking-phase', 'conditions-met');
  await expect(phaseRegion(page)).toContainText('不代表开仓成交');
  const collision = future(2, { high: entry + distance * 4, low: entry - distance * 3 });
  await fixture.refresh([wide, collision]);
  await expect(phaseRegion(page).locator('[data-tracking-phase]')).toHaveAttribute('data-tracking-phase', 'ambiguous');
  await expect(phaseRegion(page)).toContainText('顺序不明');
  await phaseRegion(page).getByText('核验规则与事件 2', { exact: true }).click();
  await expect(phaseRegion(page).locator('.trade-tracking-events')).toContainText('同根同时覆盖参考 SL');
  expect(fixture.requests()).toBe(1);
});

test('later target touches update the plan and native chart without making another model request', async ({ page }) => {
  const fixture = await install(page);
  const confirmation = future(1, { close: entry + distance / 2 });
  const tp1 = future(2, { high: entry + distance * 2.1, low: entry, close: entry + distance });
  const tp2 = future(3, { high: entry + distance * 3.1, low: entry, close: entry + distance * 2 });
  await fixture.refresh([confirmation, tp1, tp2]);
  await expect(phaseRegion(page).locator('[data-tracking-phase]')).toHaveAttribute('data-tracking-phase', 'targets-touched');
  await phaseRegion(page).getByText('核验规则与事件 3', { exact: true }).click();
  await expect(phaseRegion(page).locator('.trade-tracking-events')).toContainText('参考 TP1 已触及');
  await expect(phaseRegion(page).locator('.trade-tracking-events')).toContainText('参考 TP2 已触及');
  await expect(page.locator('.chart-host canvas').first()).toBeVisible();
  await page.locator('.chart-panel').screenshot({ path: 'artifacts/tracking-browser-proof.png' });
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const download = await downloadEvent;
  const payload = JSON.parse(readFileSync((await download.path())!, 'utf8'));
  expect(Object.values(payload.trackingReview.results)[0]).toMatchObject({ phase: 'targets-touched' });
  expect(payload.trackingReview.closedCandles.at(-1).timestamp).toBe(tp2.timestamp);
  expect(payload.analysis.tradeSetups[0].status).toBe('candidate');
  expect(fixture.requests()).toBe(1);
});

test('expiry and data gaps are distinguished from completed conditions', async ({ page }) => {
  const fixture = await install(page, { expiry: 2 });
  await fixture.refresh([future(1), future(2)]);
  await expect(phaseRegion(page).locator('[data-tracking-phase]')).toHaveAttribute('data-tracking-phase', 'expired');
  await fixture.refresh([future(2)]);
  await expect(phaseRegion(page).locator('[data-tracking-phase]')).toHaveAttribute('data-tracking-phase', 'needs-review');
  await expect(phaseRegion(page)).toContainText('缺口');
  expect(fixture.requests()).toBe(1);
});

test('legacy 1.3 plans retain geometry but never acquire inferred machine triggers', async ({ page }) => {
  const fixture = await install(page, { legacy: true });
  await fixture.refresh([future(1, { high: entry + distance * 4, close: entry + distance })]);
  await expect(phaseRegion(page).locator('[data-tracking-phase]')).toHaveAttribute('data-tracking-phase', 'manual');
  await expect(phaseRegion(page)).toContainText('不从文字猜测条件');
  await page.getByText('图表显示设置 · PA / SMC / 指标',{exact:true}).click();
  await expect(page.getByRole('checkbox', { name: /开仓候选 \/ 盈亏区间/ })).toBeChecked();
  expect(fixture.requests()).toBe(1);
});
