import { test, expect, showChartSettings, showSinglePeriod } from './fixtures';
import { createMockAnalysis } from '../../shared/mock';
import { SAMPLE_CANDLES } from '../../shared/sample';
import { formatPrice } from '../../shared/format';
import { calculateRiskReward } from '../../shared/tradeGeometry';

const sample = createMockAnalysis(SAMPLE_CANDLES);

test('numeric candidates show exact prices and risk distances, focus chart, and toggle the overlay', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?demo=smc');
  await showSinglePeriod(page); await showChartSettings(page);
  await page.getByRole('tab', { name: /单周期观察/ }).click();
  const setup = sample.tradeSetups[0];
  expect(setup).toBeDefined();
  const card = page.locator(`[data-setup-id="${setup.id}"]`);
  await expect(card).toContainText('需人工确认');
  await expect(card.locator('.trade-price-grid strong').nth(0)).toHaveText(formatPrice(setup.entry));
  await expect(card.locator('.trade-price-grid strong').nth(1)).toHaveText(formatPrice(setup.stopLoss));
  await expect(card.locator('.risk-reward-target')).toHaveCount(setup.targets.length);
  for (let index = 0; index < setup.targets.length; index++) {
    const target = card.locator('.risk-reward-target').nth(index);
    const ratio = Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(calculateRiskReward(setup, index).ratio);
    await expect(target.locator('.risk-reward-ratio')).toHaveText(`1 : ${ratio}`);
    await expect(target.locator('.target-heading strong')).toHaveText(formatPrice(setup.targets[index].price));
  }
  await expect(page.locator('.trade-plans')).toContainText('不是账户实际盈亏');
  await expect(card.locator('.advanced-reasons')).not.toContainText('价格回访');
  await card.getByRole('button', { name: '定位开仓候选 1', exact: true }).click();
  await expect(card).toHaveClass(/is-selected/);
  await expect(card.getByRole('button', { name: '定位开仓候选 1', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const chart = page.locator('.chart-host');
  const shown = await chart.screenshot();
  await page.getByRole('checkbox', { name: /开仓候选 \/ 盈亏区间/ }).uncheck();
  await expect(page.getByRole('checkbox', { name: /开仓候选 \/ 盈亏区间/ })).not.toBeChecked();
  expect((await chart.screenshot()).equals(shown)).toBe(false);
  await card.getByRole('button', { name: '定位开仓候选 1', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /开仓候选 \/ 盈亏区间/ })).toBeChecked();
  await page.getByRole('tab', { name: /结构依据/ }).click();
  await page.locator('.structure-row').first().click();
  await page.getByRole('tab', { name: /单周期观察/ }).click();
  await expect(page.locator('.trade-plan-card.is-selected')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('liquidity cards explain OHLC inference, focus the sweep, and re-enable their layer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?demo=smc');
  await showSinglePeriod(page); await showChartSettings(page);
  await page.getByRole('button', { name: 'SMC 主视图', exact: true }).click();
  await page.getByRole('checkbox', { name: /流动性扫除/ }).uncheck();
  await page.getByRole('tab', { name: /流动性扫除/ }).click();
  expect(sample.liquiditySweeps.length).toBeGreaterThan(0);
  await expect(page.locator('.sweep-card')).toHaveCount(sample.liquiditySweeps.length);
  await expect(page.locator('.sweep-explainer')).toContainText('无法据此确认实际挂单');
  const sweep = sample.liquiditySweeps[0];
  const card = page.locator(`[data-sweep-id="${sweep.id}"]`);
  await expect(card.locator('.sweep-price-grid strong').first()).toHaveText(formatPrice(sweep.levelPrice));
  await expect(card.locator('.sweep-price-grid strong').last()).toHaveText(formatPrice(sweep.extremePrice));
  await card.getByRole('button', { name: /定位.*流动性扫除/ }).click();
  await expect(card).toHaveClass(/is-selected/);
  await expect(page.getByRole('checkbox', { name: /流动性扫除/ })).toBeChecked();
  await expect(page.locator('.chart-ohlc .readout-time')).toContainText(new Date((sweep.sweepTime + 28800) * 1000).toISOString().slice(0, 16).replace('T', ' '));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('tab', { name: /单周期观察/ }).click();
  await expect(page.locator('.trade-plan-card').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('strict legacy analysis remains usable and shows empty new layers without invented levels', async ({ page }) => {
  const { tradeSetups: _setups, tradePlanning: _planning, research: _research, liquiditySweeps: _sweeps, priceAction: _pa, ...legacy } = sample;
  await page.route('**/api/analyze', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({
      analysis: { ...legacy, schemaVersion: '1.0' }, source: 'mock', model: 'legacy-test',
      analyzedBars: SAMPLE_CANDLES.length, generatedAt: new Date().toISOString(),
    }),
  }));
  await page.goto('/?demo=smc');
  await showSinglePeriod(page); await showChartSettings(page);
  await page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '分析完成' })).toBeVisible();
  await expect(page.locator('.analysis-title')).toHaveText('PA 待分析');
  await page.getByRole('tab', { name: /单周期观察/ }).click();
  await expect(page.locator('.trade-plan-card')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /单周期观察/ })).toContainText(String(legacy.opportunities.length));
  await expect(page.locator('.advanced-empty:visible')).toContainText('旧版未单列计划决策原因');
  await page.getByRole('tab', { name: /流动性扫除/ }).click();
  await expect(page.locator('.sweep-card')).toHaveCount(0);
  await expect(page.locator('.advanced-empty:visible')).toContainText('旧版结果');
});

test('a small positive reward ratio never renders as zero', async ({ page }) => {
  const result = structuredClone(sample);
  const setup = result.tradeSetups[0];
  const risk = Math.abs(setup.entry - setup.stopLoss);
  setup.targets = [{ label: 'tiny reward', price: setup.entry + (setup.direction === 'bullish' ? 1 : -1) * risk * .0001 }];
  await page.route('**/api/analyze', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({
      analysis: result, source: 'mock', model: 'ratio-test', analyzedBars: SAMPLE_CANDLES.length, generatedAt: new Date().toISOString(),
    }),
  }));
  await page.goto('/?demo=smc');
  await showSinglePeriod(page); await showChartSettings(page);
  await page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '分析完成' })).toBeVisible();
  await page.getByRole('tab', { name: /单周期观察/ }).click();
  await expect(page.locator('.risk-reward-ratio')).toHaveText('1 : 1.00e-4');
});

test('selecting a PA structure after a second plan keeps the structure focus', async ({ page }) => {
  const result = structuredClone(sample);
  const first = result.tradeSetups[0];
  result.tradeSetups.push({ ...structuredClone(first), id: 'second-candidate', opportunityId: null,
    entry: first.entry * 1.001, stopLoss: first.stopLoss * 1.001,
    targets: first.targets.map(target => ({ ...target, price: target.price * 1.001 })),
  });
  await page.route('**/api/analyze', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({
      analysis: result, source: 'mock', model: 'focus-test', analyzedBars: SAMPLE_CANDLES.length, generatedAt: new Date().toISOString(),
    }),
  }));
  await page.goto('/?demo=smc');
  await showSinglePeriod(page); await showChartSettings(page);
  await page.getByRole('button', { name: '分析当前 K 线范围', exact: true }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '分析完成' })).toBeVisible();
  await page.getByRole('tab', { name: /单周期观察/ }).click();
  await page.getByRole('button', { name: '定位开仓候选 2', exact: true }).click();
  await page.getByRole('tab', { name: /结构依据/ }).click();
  await page.locator('.structure-row').first().click();
  await expect(page.locator('.structure-row').first()).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.chart-ohlc .readout-time')).toContainText(
    new Date((sample.structures[0].startTime + 28800) * 1000).toISOString().slice(0, 16).replace('T', ' '),
  );
});
