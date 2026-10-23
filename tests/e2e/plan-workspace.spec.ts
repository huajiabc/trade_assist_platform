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
 await page.goto('/?live=SNDKUSDT&interval=1m');await expect(page.getByRole('button',{name:'生成多周期交易计划'})).toBeEnabled();
 return {requests,counts:()=>({calls,single}),failMarket:()=>{fail=true;}};
}
test('main plan action refreshes all three frames and performs one global review, never the single-period call',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));const fixture=await install(page);
 await page.getByRole('button',{name:'生成多周期交易计划'}).click();const region=page.getByRole('region',{name:'多周期研究工作台'});
 await expect(region).toContainText('本地占位审阅完成');expect(fixture.counts()).toEqual({calls:1,single:0});expect(fixture.requests[0].bundle.frames.map((f:any)=>f.timeframe)).toEqual(['15m','5m','1m']);
 await expect(page.getByRole('tab',{name:'交易计划',exact:true})).toHaveAttribute('aria-selected','true');await expect(region.locator('.plan-role-strip')).toContainText('5m机会与保护结构');await expect(region.locator('.research-frame').first()).toBeHidden();await expect(page.locator('.chart-host')).toHaveCount(1);
 fixture.failMarket();await page.getByRole('button',{name:'生成多周期交易计划'}).click();await expect(region.getByRole('alert')).toContainText('受控多周期行情失败');expect(fixture.counts()).toEqual({calls:1,single:0});expect(errors).toEqual([]);
});
test('15m objectives and 5m protection stay readable; all evidence locates through the single main chart at desktop and mobile sizes',async({page})=>{
 await install(page);const bundle=researchBundle(),state=updateMarketState(null,bundle,'controlled presentation',1),facts=strategyFacts();facts.push({...facts[2],id:'minor-five',timeframe:'5m',importance:'local',low:102,high:102});
 state.scenarios=evaluateStrategies(bundle,facts);state.facts=Object.fromEntries(facts.map(fact=>[fact.id,{current:true,versions:[{stateVersion:1,knownAt:AS_OF,reason:'controlled contract fixture',fact}]}]));
 await page.evaluate(async state=>new Promise<void>((resolve,reject)=>{const req=indexedDB.open('pa-smc-research',1);req.onupgradeneeded=()=>req.result.createObjectStore('workspaces');req.onsuccess=()=>{const db=req.result,tx=db.transaction('workspaces','readwrite');tx.objectStore('workspaces').put(state,'research-1.0:live:SNDKUSDT');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};}),state);
 await page.reload();const region=page.getByRole('region',{name:'多周期研究工作台'}),card=region.locator('.research-opportunity').first();await expect(card).toBeVisible();await expect(card).toContainText('15m TP1');await expect(card).toContainText('112.00');await expect(card).toContainText('92.75');await expect(card.locator(':scope > .plan-route .plan-obstacles')).toContainText('不等同最终TP');
 await card.getByRole('button',{name:'定位当前候选',exact:true}).click();await expect(page.getByLabel('研究定位图表')).toContainText('5m保护 / 15m目标');await expect(page.locator('.chart-host')).toHaveCount(1);await expect(region.locator('.chart-host')).toHaveCount(0);await page.getByRole('button',{name:'手动范围',exact:true}).click();await expect(page.getByLabel('研究定位图表')).toHaveCount(0);await card.getByRole('button',{name:'定位当前候选',exact:true}).click();await page.getByRole('button',{name:'返回实时图表'}).click();
 await page.setViewportSize({width:1440,height:1000});await expect.poll(()=>page.locator('.live-field label').evaluateAll(labels=>labels.every(label=>label.getBoundingClientRect().height<=32))).toBe(true);await expect.poll(()=>card.locator('.research-opportunity-trigger').evaluate(e=>parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(14);await page.evaluate(()=>{window.scrollTo(0,0);const panel=document.querySelector('.decision-panel');if(panel)panel.scrollTop=0;});await page.screenshot({path:'artifacts/plan-workspace-desktop.png'});
 await page.setViewportSize({width:375,height:900});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect.poll(()=>card.locator('.research-opportunity-trigger').evaluate(e=>parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(16);await page.screenshot({path:'artifacts/plan-workspace-mobile.png',fullPage:true});
});
