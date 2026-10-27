import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { AS_OF, frame, researchBundle, strategyFacts } from '../research-fixtures';
import { makeResearchBundle } from '../../shared/researchData';
import { evaluateStrategies } from '../../shared/strategyCatalog';
import { updateMarketState, saveCandidatePlan, recordActualPosition, linkExchangePlan } from '../../shared/marketState';

const key = 'research-1.0:live:SNDKUSDT';
function legacyState() {
  let state = updateMarketState(null, researchBundle(), 'legacy capacity fixture', 1000), facts = strategyFacts();
  state.facts = Object.fromEntries(facts.map(f => [f.id, { current: true, versions: [{ stateVersion: 1, knownAt: AS_OF, reason: 'contract fixture', fact: f }] }]));
  state.scenarios = evaluateStrategies(state.bundle, facts);
  state = saveCandidatePlan(state, state.scenarios.find(c => c.stage === 'conditional')!.id);
  state = recordActualPosition(state, state.plans[0].id, { entry: 100.2, quantity: 2, filledAt: AS_OF }, AS_OF * 1000);
  state = linkExchangePlan(state, 'fixture-exchange-position', 'explicit-only', state.plans[0].id, 2000);
  state.version = 301; state.capacityReached = true;
  state.history = Array.from({ length: 300 }, (_, i) => ({ ...state.history[0], version: i + 1 }));
  state.needsReview = ['达到本地会话容量上限，请导出后开始新会话；没有静默删除历史。'];
  return state;
}
async function install(page: Page, failArchives = false) {
  const state = legacyState(), one = frame('1m');
  one.candles.push({ ...one.candles.at(-1)!, timestamp: AS_OF }); one.lastClosedTime = AS_OF; one.observedAt = AS_OF + 60;
  const bundle = makeResearchBundle('SNDKUSDT', [frame('15m'), frame('5m'), one], AS_OF + 60);
  let modelCalls = 0, marketCalls = 0;
  await page.route('**/api/market/stream?*', r => r.abort());
  await page.route('**/api/market/candles?*', r => r.fulfill({ json: { provider: 'binance', market: 'usdt-perpetual', symbol: 'SNDKUSDT', interval: '1m', candles: one.candles, lastCandleClosed: true, serverTime: bundle.asOf * 1000, fetchedAt: new Date(bundle.asOf * 1000).toISOString(), warnings: [] } }));
  await page.route('**/api/research/market?*', r => { marketCalls++; return r.fulfill({ json: bundle }); });
  await page.route('**/api/research/analyze', r => { modelCalls++; return r.fulfill({ status: 409, json: { error: { message: 'No model calls during retention tests' } } }); });
  if (failArchives) await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (typeof key === 'string' && key.startsWith('archive:')) throw new DOMException('controlled disk failure', 'QuotaExceededError');
      return put.call(this, value, key);
    };
  });
  await page.goto('/?live=SNDKUSDT&interval=1m');
  await page.evaluate(async ({ key, state }) => new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('pa-smc-research', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('workspaces');
    req.onsuccess = () => { const db = req.result, tx = db.transaction('workspaces', 'readwrite'); tx.objectStore('workspaces').put(state, key);
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error); };
  }), { key, state });
  await page.reload();
  return { state, bundle, counts: () => ({ modelCalls, marketCalls }) };
}
async function stored(page: Page) {
  return page.evaluate(async key => new Promise<any>((resolve, reject) => {
    const req = indexedDB.open('pa-smc-research', 1);
    req.onsuccess = () => { const db = req.result, tx = db.transaction('workspaces'), store = tx.objectStore('workspaces');
      let state: any; const archives: any[] = []; const read = store.get(key); read.onsuccess = () => { state = read.result; };
      const prefix = 'archive:' + key + ':', cursor = store.openCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'));
      cursor.onsuccess = () => { const row = cursor.result; if (row) { archives.push(row.value); row.continue(); } };
      tx.oncomplete = () => { db.close(); resolve({ state, archives }); }; tx.onabort = () => reject(tx.error);
    };
  }), key);
}

test('a full legacy workspace auto-recovers, archives atomically and exports old history with plans and links intact', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const fixture = await install(page), region = page.getByRole('region', { name: '多周期研究工作台' });
  await expect.poll(() => fixture.counts().marketCalls).toBeGreaterThan(0);
  await expect.poll(async () => (await stored(page)).state.capacityReached).toBe(false);
  await expect.poll(async () => (await stored(page)).archives.length).toBeGreaterThan(0);
  const saved = await stored(page);
  expect(saved.state.asOf).toBe(fixture.bundle.asOf); expect(saved.state.version).toBeGreaterThan(fixture.state.version);
  expect(saved.state.history.length).toBeLessThan(fixture.state.history.length);
  expect(saved.state.plans[0].versions).toEqual(fixture.state.plans[0].versions);
  expect(saved.state.positions[0].entry).toBe(100.2); expect(saved.state.exchangePlanLinks).toEqual(fixture.state.exchangePlanLinks);
  await expect(region.getByRole('alert')).toHaveCount(0);
  await region.locator('.research-tools>summary').click(); await region.locator('.research-history>summary').click();
  await expect(region.locator('.research-archive-status')).toContainText('已自动归档');
  await expect(region).not.toContainText('达到本地会话容量上限');
  const download = page.waitForEvent('download'); await region.getByRole('button', { name: '导出研究状态', exact: true }).click();
  const artifact = await download, path = await artifact.path(), exported = JSON.parse(await readFile(path!, 'utf8'));
  expect(exported.archiveFormat).toBe('research-archive-1.0'); expect(exported.archives.length).toBeGreaterThan(0);
  const versions = new Set([...exported.state.history, ...exported.archives.flatMap((a: any) => a.history)].map((h: any) => h.version));
  for (const h of fixture.state.history) expect(versions.has(h.version)).toBe(true);
  expect(exported.state.exchangePlanLinks).toEqual(fixture.state.exchangePlanLinks);
  const archiveCount = (await stored(page)).archives.length;
  await page.reload(); await region.locator('.research-tools>summary').click();
  await expect(region.getByRole('button', { name: '恢复本地更新', exact: true })).toBeEnabled();
  expect((await stored(page)).archives.length).toBe(archiveCount);
  await region.getByRole('button', { name: '恢复本地更新', exact: true }).click();
  await page.getByRole('button', { name: '快速扫描', exact: true }).click(); await expect(region).toContainText('快速扫描完成');
  await region.locator('.research-history>summary').click(); await page.locator('.decision-panel').screenshot({ path: 'artifacts/research-auto-archive.png' });
  expect(fixture.counts().modelCalls).toBe(0); expect(errors).toEqual([]);
});

test('failed archive writes keep the full disk record and allow exporting the unsaved current workspace', async ({ page }) => {
  const fixture = await install(page, true), region = page.getByRole('region', { name: '多周期研究工作台' });
  await expect(region.getByRole('alert')).toContainText('归档失败');
  const disk = await stored(page);
  expect(disk.archives).toEqual([]); expect(disk.state.history).toEqual(fixture.state.history);
  expect(disk.state.capacityReached).toBe(true); // The failed transaction changed nothing on disk.
  await region.locator('.research-tools>summary').click();
  const download = page.waitForEvent('download'); await region.getByRole('button', { name: '导出研究状态', exact: true }).click();
  const artifact = await download, path = await artifact.path(), exported = JSON.parse(await readFile(path!, 'utf8'));
  expect(exported.state.asOf).toBe(fixture.bundle.asOf); expect(exported.state.capacityReached).toBe(false);
  for (const original of fixture.state.history) expect(exported.state.history.some((h: any) => h.version === original.version)).toBe(true);
  expect(exported.state.plans[0].versions).toEqual(fixture.state.plans[0].versions);
  expect(exported.state.exchangePlanLinks).toEqual(fixture.state.exchangePlanLinks);
  expect(fixture.counts().modelCalls).toBe(0);
});
