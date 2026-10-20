import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { createMockAnalysis } from '../../shared/mock';
import { validateAnalysis, type Analysis } from '../../shared/analysis';
import type { Candle } from '../../shared/market';
import type { MarketSnapshot } from '../../shared/liveMarket';
import { SAMPLE_CANDLES } from '../../shared/sample';

const candles: Candle[] = SAMPLE_CANDLES.map((candle, index) => ({ ...candle, timestamp: 1791244800 + index * 60 }));
const statusName = '开仓计划可视化状态';
const utc = (time: number) => new Date(time * 1000).toISOString().replace('T', ' ').slice(0, 16);

async function install(page: Page, createResult: (input: Candle[]) => Analysis) {
  let requests = 0;
  let snapshot: MarketSnapshot = { provider: 'binance', market: 'usdt-perpetual', symbol: 'SNDKUSDT', interval: '1m',
    candles: structuredClone(candles), lastCandleClosed: true,
    serverTime: (candles.at(-1)!.timestamp + 61) * 1000, fetchedAt: new Date().toISOString(), warnings: [] };
  await page.route('**/api/market/stream?*', route => route.abort());
  await page.route('**/api/market/candles?*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) }));
  await page.route('**/api/analyze', route => {
    requests++;
    const input: Candle[] = route.request().postDataJSON().candles;
    const analysis = validateAnalysis(createResult(input), input);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      analysis, source: 'mock', model: 'trade-plan-browser-fixture', analyzedBars: input.length, generatedAt: new Date().toISOString(),
    }) });
  });
  await page.goto('/?live=SNDKUSDT&interval=1m');
  await expect(page.locator('.price-stat strong')).not.toHaveText('—');
  await page.getByRole('checkbox', { name: '实时更新', exact: true }).uncheck();
  await expect(page.getByLabel(statusName, { exact: true })).toContainText('尚未分析');
  return {
    analyze: page.getByRole('button', { name: '分析当前 K 线范围', exact: true }), requests: () => requests,
    reviseAnchor: () => {
      snapshot = structuredClone(snapshot);
      const last = snapshot.candles.at(-1)!;
      last.close += Math.max(1, last.close * .0001);
      last.high = Math.max(last.high, last.close);
      snapshot.serverTime += 1000;
    },
  };
}

async function riskAreaPixels(page: Page): Promise<{ risk: number; reward: number }> {
  return page.locator('.chart-host canvas').evaluateAll(nodes => {
    // Native fills either retain their transparent RGBA or blend over #131722.
    const colors = { risk: [[52, 28, 39, 255], [242, 54, 69, 38]], reward: [[17, 44, 49, 255], [8, 153, 129, 41]] };
    const counts = { risk: 0, reward: 0 };
    for (const node of nodes) {
      const canvas = node as HTMLCanvasElement;
      if (!canvas.width || !canvas.height) continue;
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        for (const kind of ['risk', 'reward'] as const) {
          if (colors[kind].some(color => color.every((channel, index) => Math.abs(pixels[offset + index] - channel) <= 2))) counts[kind]++;
        }
      }
    }
    return counts;
  });
}

test('a watch-only model decision explains the absent numeric overlay without inventing prices', async ({ page }) => {
  const reason = '回踩收盘尚未确认，无法给出有依据的止损与数值目标，先观察阻力反应。';
  const fixture = await install(page, input => {
    const result = createMockAnalysis(input);
    expect(result.opportunities.length).toBeGreaterThan(0);
    return { ...result, tradeSetups: [], tradePlanning: { status: 'watch-only', reason } };
  });
  await fixture.analyze.click();
  const status = page.getByLabel(statusName, { exact: true });
  await expect(status).toContainText('仅文字观察');
  await expect(status).toContainText(reason);
  await expect(status).toContainText('原始 0 · 可绘制 0 · 隐藏 0');
  await expect(status).toContainText('文字条件不等于含 E / SL / TP 的数值计划');
  await expect(status.getByRole('button', { name: '定位当前计划', exact: true })).toHaveCount(0);
  await status.getByRole('button', { name: '查看计划与观察依据', exact: true }).click();
  await expect(page.getByRole('tab', { name: /潜在观察计划/ })).toContainText('开仓计划0文字观察 1');
  await expect(page.locator('.trade-plans .advanced-empty')).toContainText(reason);
  await expect(page.locator('.trade-plan-card')).toHaveCount(0);
  expect(fixture.requests()).toBe(1);
});

test('a corrected anchor identifies a hidden original plan rather than a missing model recommendation', async ({ page }) => {
  const fixture = await install(page, input => createMockAnalysis(input));
  await fixture.analyze.click();
  const status = page.getByLabel(statusName, { exact: true });
  await expect(status).toContainText('原始 1 · 可绘制 1 · 隐藏 0');
  await expect(status).toContainText('图中计划 1 / 1 · 需人工确认');
  fixture.reviseAnchor();
  await page.locator('.market-refresh').click();
  await expect(status).toContainText('原始 1 · 可绘制 0 · 隐藏 1');
  await expect(status).toContainText('原分析包含数值计划');
  await expect(status).toContainText('原行情被修订');
  await status.getByRole('button', { name: '查看计划与观察依据', exact: true }).click();
  await expect(page.locator('.trade-plans .advanced-empty')).toContainText('原分析有 1 个数值计划，当前可绘制 0 个');
  await expect(page.locator('.trade-plans .advanced-empty')).not.toContainText('模型本次未提供');
  expect(fixture.requests()).toBe(1);
});

test('two numeric plans switch one native risk box and restore a disabled layer', async ({ page }) => {
  const fixture = await install(page, input => {
    const result = createMockAnalysis(input);
    const first = result.tradeSetups[0];
    expect(first).toBeDefined();
    first.trigger = '等待回踩关键位后收盘站回，再复核后续一根 K 线。';
    result.tradeSetups.push({ ...structuredClone(first), id: 'second-numeric-plan', opportunityId: null,
      trigger: '等待另一方向的价格结构确认，当前仍未触发。',
      entry: first.entry * 1.001, stopLoss: first.stopLoss * 1.001,
      targets: first.targets.map(target => ({ ...target, price: target.price * 1.001 })),
    });
    return result;
  });
  await fixture.analyze.click();
  const status = page.getByLabel(statusName, { exact: true });
  await expect(status).toContainText('图中计划 1 / 2 · 需人工确认');
  await expect(status).toContainText('等待回踩关键位后收盘站回');
  for (const name of [/支撑.*阻力/, /推进.*回撤/, /K 线形态/, /突破.*回踩/, /关键价位/]) {
    const toggle = page.getByRole('checkbox', { name });
    if (await toggle.count()) await toggle.uncheck();
  }
  await page.getByRole('checkbox', { name: '主结构', exact: true }).uncheck();
  const rules = page.getByLabel('规则 FVG 与 OB 指标', { exact: true });
  await rules.locator('.type-fvg input').uncheck();
  await rules.locator('.type-ob input').uncheck();
  await status.getByRole('button', { name: '定位当前计划', exact: true }).click();
  await expect.poll(async () => (await riskAreaPixels(page)).risk).toBeGreaterThan(100);
  await expect.poll(async () => (await riskAreaPixels(page)).reward).toBeGreaterThan(100);
  await page.getByLabel('选择图中开仓计划', { exact: true }).selectOption('second-numeric-plan');
  await expect(status).toContainText('图中计划 2 / 2 · 需人工确认');
  await expect(status).toContainText('等待另一方向的价格结构确认');
  const card = page.locator('[data-setup-id="second-numeric-plan"]');
  await expect(card).toHaveClass(/is-selected/);
  await expect(card.locator('.advanced-reasons')).toContainText('等待另一方向的价格结构确认');
  const layer = page.getByRole('checkbox', { name: /开仓候选 \/ 盈亏区间/ });
  await layer.uncheck();
  await expect(status).toContainText('图层已关闭');
  await expect.poll(async () => (await riskAreaPixels(page)).risk).toBe(0);
  await expect.poll(async () => (await riskAreaPixels(page)).reward).toBe(0);
  await status.getByRole('button', { name: '显示并定位计划', exact: true }).click();
  await expect(layer).toBeChecked();
  await expect(status).toContainText('图中计划 2 / 2 · 需人工确认');
  await expect.poll(async () => (await riskAreaPixels(page)).risk).toBeGreaterThan(100);
  await expect.poll(async () => (await riskAreaPixels(page)).reward).toBeGreaterThan(100);
  // A repeated click must restore the same plan after a deliberate pan.
  await page.locator('.chart-host').scrollIntoViewIfNeeded();
  const bounds = await page.locator('.chart-host').boundingBox();
  expect(bounds).not.toBeNull();
  for (let index = 0; index < 2; index++) {
    await page.mouse.move(bounds!.x + bounds!.width * .15, bounds!.y + bounds!.height * .7);
    await page.mouse.down();
    await page.mouse.move(bounds!.x + bounds!.width * .85, bounds!.y + bounds!.height * .7, { steps: 12 });
    await page.mouse.up();
  }
  await expect.poll(async () => (await riskAreaPixels(page)).risk).toBe(0);
  await status.getByRole('button', { name: '定位当前计划', exact: true }).click();
  await expect.poll(async () => (await riskAreaPixels(page)).risk).toBeGreaterThan(100);
  expect(fixture.requests()).toBe(1);
});

test('a manual historical plan remains explicitly anchored to its original snapshot on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await install(page, input => createMockAnalysis(input));
  await page.getByRole('button', { name: '手动范围', exact: true }).click();
  await page.getByLabel('范围开始 UTC', { exact: true }).selectOption(String(candles[20].timestamp));
  await page.getByLabel('范围结束 UTC', { exact: true }).selectOption(String(candles[120].timestamp));
  await fixture.analyze.click();
  const status = page.getByLabel(statusName, { exact: true });
  await expect(status).toContainText(`手动范围快照 · 末根 ${utc(candles[120].timestamp)} UTC`);
  await expect(status).toContainText('计划锚定原快照，行情条件核验不代表成交');
  await status.scrollIntoViewIfNeeded();
  expect(await status.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(fixture.requests()).toBe(1);
});
