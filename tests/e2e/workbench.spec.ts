import {test,expect} from './fixtures';
import type {Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {AS_OF,frame,researchBundle} from '../research-fixtures';
import {makeResearchBundle} from '../../shared/researchData';
import {prepareResearchRequest} from '../../server/workbench';
import {localWorkbenchInterpretation} from '../../shared/workbenchAnalysis';
async function install(page:Page,missing=false,invalid=false){
 let paid=0,researchCalls=0,marketCalls=0;
 await page.route('**/api/market/stream?*',route=>route.abort());
 await page.route('**/api/market/candles?*',route=>{const tf=new URL(route.request().url()).searchParams.get('interval') as '1m'|'5m'|'15m',f=frame(tf);return route.fulfill({json:{provider:'binance',market:'usdt-perpetual',symbol:'SNDKUSDT',interval:tf,candles:f.candles,lastCandleClosed:true,serverTime:AS_OF*1000,fetchedAt:new Date(AS_OF*1000).toISOString(),warnings:[]}});});
 await page.route('**/api/research/market?*',route=>{marketCalls++;return route.fulfill({json:missing?makeResearchBundle('SNDKUSDT',[frame('15m'),frame('1m')],AS_OF):researchBundle()});});
 await page.route('**/api/research/analyze',route=>{researchCalls++;const input=route.request().postDataJSON();if(input.provider!=='mock'){paid++;return route.fulfill({status:409,json:{error:{message:'No paid calls permitted in browser test'}}});}
 const context=prepareResearchRequest(input).context,analysis=localWorkbenchInterpretation(context);if(invalid)analysis.frames[0].evidenceIds=['invented'];return route.fulfill({json:{schemaVersion:'research-response-1.0',snapshotId:context.bundle.id,stateVersion:context.previous.version,source:'mock',provider:'mock',model:'browser-local-fixture',generatedAt:new Date().toISOString(),analysisAttempts:0,analysis}});});
 await page.goto('/?live=SNDKUSDT&interval=1m');const region=page.getByRole('region',{name:'多周期研究工作台'});await region.locator('.research-tools>summary').click();
 await expect(region.getByRole('button',{name:'开启多周期研究',exact:true})).toBeEnabled();
 return {region,counts:()=>({paid,researchCalls,marketCalls})};
}
test('loads three roles without AI calls, shows waiting candidates, locates real chart data and restores/export state',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));const {region,counts}=await install(page);
 await region.getByRole('button',{name:'开启多周期研究',exact:true}).click();await expect(region.locator('.research-frame')).toHaveCount(3);await expect(region.locator('.research-candidate')).toHaveCount(12);expect(counts().researchCalls).toBe(0);
 await expect(region).toContainText('Market State v1');for(const button of await region.getByRole('button',{name:'保存研究候选',exact:true}).all())await expect(button).toBeDisabled();
 await region.locator('.research-context>summary').click();await region.getByRole('button',{name:'查看研究 5m 图表',exact:true}).click();await expect(page.getByLabel('研究定位图表').locator('canvas').first()).toBeVisible();
 await page.getByRole('button',{name:'生成多周期交易计划'}).click();await expect(region).toContainText('本地占位审阅完成');expect(counts().researchCalls).toBe(1);await expect(region).toContainText('Market State v2');
 await expect.poll(async()=>await page.evaluate(async()=>await new Promise<number>(resolve=>{const r=indexedDB.open('pa-smc-research',1);r.onsuccess=()=>{const db=r.result,q=db.transaction('workspaces').objectStore('workspaces').get('research-1.0:live:SNDKUSDT');q.onsuccess=()=>{resolve(q.result?.version??0);db.close();};};}))).toBe(2);
 const download=page.waitForEvent('download');await region.getByRole('button',{name:'导出研究状态',exact:true}).click();const artifact=await download,path=await artifact.path();expect(path).not.toBeNull();const exported=JSON.parse(await readFile(path!,'utf8'));expect(exported.exportVersion).toBe('research-evaluation-1.0');expect(Object.keys(exported.state.snapshots)).toHaveLength(3);expect(exported.state.evaluations[0].candidates).toHaveLength(12);
 await page.screenshot({path:'artifacts/workbench-browser.png'});
 const before=counts().marketCalls;await page.reload();await region.locator('.research-tools>summary').click();await expect(region.getByRole('button',{name:'恢复本地更新',exact:true})).toBeVisible();await expect(region).toContainText('Market State v2');expect(counts().marketCalls).toBe(before);expect(counts().paid).toBe(0);expect(errors).toEqual([]);
});
test('missing context is degraded and invalid AI references leave the previous state untouched',async({page})=>{
 const {region,counts}=await install(page,true,true);await region.getByRole('button',{name:'开启多周期研究',exact:true}).click();await expect(region.locator('.research-frame').nth(1)).toContainText('数据不足 / 降级');await region.locator('.research-context>summary').click();await expect(region).toContainText('尚无AI解释');
 await page.getByRole('button',{name:'生成多周期交易计划'}).click();await expect(region.getByRole('alert')).toContainText('未知');await expect(region).toContainText('Market State v1');await expect(region).toContainText('尚无AI解释');expect(counts().paid).toBe(0);
});
test('CSV mode aggregates actual minute data and performs no live research fetch',async({page})=>{
 const {region,counts}=await install(page);const rows=frame('1m',300).candles,csv=['timestamp,open,high,low,close,volume',...rows.map(b=>[b.timestamp,b.open,b.high,b.low,b.close,b.volume].join(','))].join('\n');
 await page.getByLabel('上传 OHLCV CSV',{exact:true}).setInputFiles({name:'actual-1m.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
 await expect(region.getByRole('button',{name:'开启多周期研究',exact:true})).toBeEnabled();await region.getByRole('button',{name:'开启多周期研究',exact:true}).click();await expect(region.locator('.research-frame').first()).toContainText('aggregated · 20根');await expect(region.locator('.research-frame').nth(1)).toContainText('aggregated · 60根');await expect(region.locator('.research-frame').nth(2)).toContainText('csv · 300根');expect(counts().marketCalls).toBe(0);expect(counts().researchCalls).toBe(0);
});
