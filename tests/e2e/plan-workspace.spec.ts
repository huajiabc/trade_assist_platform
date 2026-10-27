import {test,expect} from './fixtures';
import type {Page} from '@playwright/test';
import {researchBundle,frame,AS_OF,strategyFacts} from '../research-fixtures';
import {prepareResearchRequest} from '../../server/workbench';
import {localWorkbenchInterpretation} from '../../shared/workbenchAnalysis';
import {updateMarketState} from '../../shared/marketState';
import {evaluateStrategies} from '../../shared/strategyCatalog';
async function install(page:Page){
 let calls=0,single=0,fail=false;const requests:any[]=[];
 await page.route('**/api/market/stream?*',r=>r.abort());
 await page.route('**/api/market/candles?*',r=>{const tf=new URL(r.request().url()).searchParams.get('interval') as '1m';return r.fulfill({json:{provider:'binance',market:'usdt-perpetual',symbol:'SNDKUSDT',interval:tf,candles:frame(tf).candles,lastCandleClosed:true,serverTime:AS_OF*1000,fetchedAt:new Date(AS_OF*1000).toISOString(),warnings:[]}});});
 await page.route('**/api/research/market?*',r=>fail?r.fulfill({status:502,json:{error:{message:'受控多周期行情失败'}}}):r.fulfill({json:researchBundle()}));
 await page.route('**/api/analyze',r=>{single++;return r.fulfill({status:409,json:{error:{message:'主计划不应调用单周期接口'}}});});
 await page.route('**/api/research/analyze',r=>{calls++;const body=r.request().postDataJSON();requests.push(body);expect(body.provider).toBe('mock');const c=prepareResearchRequest(body).context;return r.fulfill({json:{catalogVersion:c.catalogVersion,schemaVersion:'research-response-1.0',snapshotId:c.bundle.id,stateVersion:c.previous.version,source:'mock',provider:'mock',model:'controlled',generatedAt:new Date().toISOString(),analysisAttempts:0,analysis:localWorkbenchInterpretation(c)}});});
 await page.goto('/?live=SNDKUSDT&interval=1m');await expect(page.getByRole('button',{name:'深度分析'})).toBeEnabled();
 return {requests,counts:()=>({calls,single}),failMarket:()=>{fail=true;}};
}

async function persistState(page: Page, state: ReturnType<typeof updateMarketState>) {
 await page.evaluate(async state => new Promise<void>((resolve, reject) => {
  const req = indexedDB.open('pa-smc-research', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('workspaces');
  req.onsuccess = () => {
   const db = req.result, tx = db.transaction('workspaces', 'readwrite');
   tx.objectStore('workspaces').put(state, 'research-1.0:live:SNDKUSDT');
   tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
  };
 }), state);
}

test('opening opportunities and owned positions have distinct actions and adjacent results', async ({ page }) => {
 await page.setViewportSize({ width: 1440, height: 1000 });
 const fixture = await install(page), actions = page.getByRole('region', { name: '寻找开仓机会' });
 await expect(page.getByRole('tab', { name: '开仓机会', exact: true })).toHaveAttribute('aria-selected', 'true');
 await expect(actions).toContainText('本地规则筛选 · 不调用 AI');
 await expect(actions).toContainText('当前为模拟审阅 · 不调用模型');
 await expect(page.getByRole('button', { name: '快速扫描', exact: true })).toHaveCount(1);
 await expect(page.getByRole('button', { name: '深度分析', exact: true })).toHaveCount(1);
 await expect(page.locator('.heading-actions').getByRole('button', { name: '深度分析' })).toHaveCount(0);
 await actions.getByRole('button', { name: '快速扫描', exact: true }).click();
 await expect(page.locator('.research-opportunity-empty')).toContainText('暂无合格开仓机会');
 expect(fixture.counts()).toEqual({ calls: 0, single: 0 });
 await page.getByRole('tab', { name: '我的持仓', exact: true }).click();
 await expect(page.locator('.position-purpose')).toContainText('选择实际仓位');
 await expect(actions).toHaveCount(0);
 await expect(page.getByRole('region', { name: '真实持仓管理' })).toBeVisible();
 await page.getByRole('tab', { name: '开仓机会', exact: true }).click();
 await actions.getByRole('button', { name: '深度分析', exact: true }).click();
 await expect(page.getByLabel('本次审阅结论')).toBeVisible();
 await expect(page.getByRole('tab', { name: '开仓机会', exact: true })).toHaveAttribute('aria-selected', 'true');
 await expect(page.getByLabel('研究定位图表')).toHaveCount(0);
 expect(fixture.counts()).toEqual({ calls: 1, single: 0 });
 await page.getByLabel('分析来源', { exact: true }).selectOption('codex');
 const panel = await page.locator('.decision-panel').boundingBox();
 expect(panel).not.toBeNull();
 await page.screenshot({ path: 'artifacts/opening-actions.png', clip: { x: panel!.x, y: panel!.y, width: panel!.width, height: 300 } });
 await page.setViewportSize({ width: 375, height: 900 });
 await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
 await expect(actions.getByRole('button', { name: '快速扫描', exact: true })).toBeVisible();
 await expect(actions.getByRole('button', { name: '深度分析', exact: true })).toBeVisible();
});

/** Count native candle wicks rather than inferring success from a button or
 * screenshot difference. The controlled 1m history has a true 99–101 range. */
async function candleHeight(page: Page): Promise<number> {
 return page.locator('.chart-host canvas').evaluateAll(nodes => {
  let extent = 0;
  for (const node of nodes) {
   const canvas = node as HTMLCanvasElement;
   if (canvas.width < 150 || canvas.height < 200) continue;
   const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
   let min = canvas.height, max = -1;
   for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    const offset = (y * canvas.width + x) * 4;
    if (Math.abs(pixels[offset] - 51) < 3 && Math.abs(pixels[offset + 1] - 150) < 3 && Math.abs(pixels[offset + 2] - 139) < 3 && pixels[offset + 3] > 200) {
     min = Math.min(min, y); max = Math.max(max, y);
    }
   }
   if (max >= 0) extent = Math.max(extent, max - min + 1);
  }
  return extent;
 });
}
test('main plan action refreshes all three frames and performs one global review, never the single-period call',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));const fixture=await install(page);
 await page.getByRole('button',{name:'深度分析'}).click();const region=page.getByRole('region',{name:'多周期研究工作台'});
 await expect(region).toContainText('本地占位审阅完成');expect(fixture.counts()).toEqual({calls:1,single:0});expect(fixture.requests[0].bundle.frames.map((f:any)=>f.timeframe)).toEqual(['15m','5m','1m']);
 await expect(page.getByRole('tab',{name:'开仓机会',exact:true})).toHaveAttribute('aria-selected','true');await expect(region.locator('.plan-role-strip')).toContainText('5m机会与保护结构');await expect(region.locator('.research-frame').first()).toBeHidden();await expect(page.locator('.chart-host')).toHaveCount(1);
 fixture.failMarket();await page.getByRole('button',{name:'快速扫描',exact:true}).click();await page.getByRole('button',{name:'深度分析'}).click();await expect(region.getByRole('alert')).toContainText('受控多周期行情失败');expect(fixture.counts()).toEqual({calls:1,single:0});expect(errors).toEqual([]);
});
test('15m objectives and 5m protection stay readable; all evidence locates through the single main chart at desktop and mobile sizes',async({page})=>{
 await install(page);const bundle=researchBundle(),state=updateMarketState(null,bundle,'controlled presentation',1),facts=strategyFacts();facts.push({...facts[2],id:'minor-five',timeframe:'5m',importance:'local',low:102,high:102});
 state.scenarios=evaluateStrategies(bundle,facts);state.facts=Object.fromEntries(facts.map(fact=>[fact.id,{current:true,versions:[{stateVersion:1,knownAt:AS_OF,reason:'controlled contract fixture',fact}]}]));
 await page.evaluate(async state=>new Promise<void>((resolve,reject)=>{const req=indexedDB.open('pa-smc-research',1);req.onupgradeneeded=()=>req.result.createObjectStore('workspaces');req.onsuccess=()=>{const db=req.result,tx=db.transaction('workspaces','readwrite');tx.objectStore('workspaces').put(state,'research-1.0:live:SNDKUSDT');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};}),state);
 await page.reload();const region=page.getByRole('region',{name:'多周期研究工作台'}),card=region.locator('.research-opportunity').first();await expect(card).toBeVisible();await expect(card).toContainText('15m TP1');await expect(card).toContainText('112.00');await expect(card).toContainText('92.75');await expect(card.locator('.research-opportunity-details .plan-obstacles')).toContainText('不等同最终TP');
 await expect(card.locator('.research-opportunity-prices strong')).toHaveText(['99.50 – 100.50','92.75','112.00']);
 await expect(card.locator('.plan-route-objectives').first()).toBeHidden();
 await expect(card.locator('.research-opportunity-meta')).toBeVisible();
 await expect(region.getByLabel('计划数据状态')).toContainText('历史快照');
 await card.locator('.research-opportunity-details>summary').press('Enter');
 await expect(card.locator('.research-opportunity-member').first()).toBeVisible();
 await expect(card.locator('.plan-obstacles')).toBeVisible();
 await card.locator('.research-opportunity-details>summary').press('Enter');
 await expect(card.locator('.research-opportunity-member').first()).toBeHidden();

 await card.getByRole('button',{name:'定位当前候选',exact:true}).click();await expect(page.getByLabel('研究定位图表')).toContainText('5m保护 / 15m目标');await expect(page.locator('.chart-host')).toHaveCount(1);await expect(region.locator('.chart-host')).toHaveCount(0);await page.getByRole('button',{name:'手动范围',exact:true}).click();await expect(page.getByLabel('研究定位图表')).toHaveCount(0);await card.getByRole('button',{name:'定位当前候选',exact:true}).click();await page.getByRole('button',{name:'返回实时图表'}).click();
 await page.setViewportSize({width:1440,height:1000});await expect.poll(()=>page.locator('.live-field label').evaluateAll(labels=>labels.every(label=>label.getBoundingClientRect().height<=32))).toBe(true);await expect.poll(()=>card.locator('.research-opportunity-trigger').evaluate(e=>parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(14);await page.evaluate(()=>{window.scrollTo(0,0);const panel=document.querySelector('.decision-panel');if(panel)panel.scrollTop=0;});await page.screenshot({path:'artifacts/plan-workspace-desktop.png'});await page.locator('.decision-panel').screenshot({path:'artifacts/plan-workspace-panel.png'});
 await page.setViewportSize({width:375,height:900});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect.poll(()=>card.locator('.research-opportunity-trigger').evaluate(e=>parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(16);await page.screenshot({path:'artifacts/plan-workspace-mobile.png',fullPage:true});
});

test('locating a candidate keeps 1m candles readable; full-plan scale is explicit and repeated locate restores the entry context', async ({ page }) => {
 await page.setViewportSize({ width: 1440, height: 1000 });
 const fixture = await install(page), bundle = researchBundle();
 const state = updateMarketState(null, bundle, 'far target viewport regression', 1), facts = strategyFacts();
 state.scenarios = evaluateStrategies(bundle, facts);
 state.facts = Object.fromEntries(facts.map(fact => [fact.id, { current: true, versions: [{ stateVersion: 1, knownAt: AS_OF, reason: 'controlled contract fixture', fact }] }]));
 await persistState(page, state); await page.reload();
 const region = page.getByRole('region', { name: '多周期研究工作台' });
 const card = region.locator('.research-opportunity').first();
 await expect(card).toContainText('112.00'); await expect(card).toContainText('92.75');
 const originalPrices = await card.locator('.research-opportunity-prices').innerText();
 await card.getByRole('button', { name: '定位当前候选', exact: true }).click();
 const controls = page.getByRole('group', { name: '候选计划价格视图' });
 await expect(controls.getByRole('button', { name: '入场结构', exact: true })).toHaveAttribute('aria-pressed', 'true');
 await expect.poll(() => candleHeight(page)).toBeGreaterThan(220);
 const readableHeight = await candleHeight(page);
 await page.locator('.research-main-chart .chart-shell').screenshot({ path: 'artifacts/candidate-entry-scale.png' });
 await controls.getByRole('button', { name: '完整计划', exact: true }).click();
 await expect.poll(() => candleHeight(page)).toBeLessThan(readableHeight * .4);
 await expect.poll(() => candleHeight(page)).toBeGreaterThan(10);
 await page.locator('.research-main-chart .chart-shell').screenshot({ path: 'artifacts/candidate-full-scale.png' });
 expect(await card.locator('.research-opportunity-prices').innerText()).toBe(originalPrices);
 await controls.getByRole('button', { name: '入场结构', exact: true }).click();
 await expect.poll(() => candleHeight(page)).toBeGreaterThan(readableHeight * .9);
 await controls.getByRole('button', { name: '完整计划', exact: true }).click();
 await card.getByRole('button', { name: '定位当前候选', exact: true }).click();
 await expect(controls.getByRole('button', { name: '入场结构', exact: true })).toHaveAttribute('aria-pressed', 'true');
 await expect.poll(() => candleHeight(page)).toBeGreaterThan(readableHeight * .9);
 await page.setViewportSize({ width: 375, height: 900 });
 await expect(controls.getByRole('button', { name: '完整计划', exact: true })).toBeVisible();
 await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 expect(fixture.counts()).toEqual({ calls: 0, single: 0 });
});


test('waiting workspace keeps diagnostics quiet and reveals complete research controls on demand without model calls',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});
 const fixture=await install(page);
 await page.getByRole('button',{name:'快速扫描',exact:true}).click();
 const region=page.getByRole('region',{name:'多周期研究工作台'});
 await expect(region).toContainText('快速扫描完成');
 await expect(region.locator('.research-opportunity-empty')).toBeVisible();
 await expect(region.locator('.research-opportunity')).toHaveCount(0);
 await expect(region.locator('.research-candidate')).toHaveCount(12);
 await expect(region.locator('.research-candidate').first()).toBeHidden();
 await expect(region.locator('.research-tools')).not.toHaveAttribute('open');
 await expect(region.locator('.research-phase-timings')).toBeHidden();
 await expect(region.getByRole('button',{name:'轻量AI审阅（主动调用）'})).toBeHidden();
 await expect(region.locator('.research-clear')).toBeHidden();
 await expect(region.getByLabel('计划数据状态')).toBeVisible();
 await expect(region.locator('.plan-role-strip')).toBeHidden();
 await region.locator('.research-tools>summary').press('Enter');
 await expect(region.getByRole('button',{name:'轻量AI审阅（主动调用）'})).toBeVisible();
 await expect(region.getByRole('button',{name:'导出研究状态',exact:true})).toBeEnabled();
 await region.locator('.research-phase-timings>summary').click();
 await expect(region.locator('.research-phase-timings')).toContainText('模型调用0.00秒');
 await region.locator('.research-tools>summary').press('Enter');
 await region.locator('.research-context>summary').press('Enter');
 await expect(region.getByRole('button',{name:'查看研究 15m 图表'})).toBeVisible();
 await region.locator('.research-context>summary').press('Enter');
 await page.evaluate(()=>{window.scrollTo(0,0);document.querySelector('.decision-panel')!.scrollTop=0;});
 await page.screenshot({path:'artifacts/plan-workspace-waiting.png'});
 await page.setViewportSize({width:375,height:900});
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 expect(fixture.counts()).toEqual({calls:0,single:0});
});
