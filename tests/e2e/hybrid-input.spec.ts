import {test,expect} from './fixtures';
import type {Page} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {frame,researchBundle,AS_OF} from '../research-fixtures';
import {prepareResearchRequest} from '../../server/workbench';
import {localWorkbenchInterpretation} from '../../shared/workbenchAnalysis';
import {createMockAnalysis} from '../../shared/mock';
import {chartImageBytes} from '../../server/chartImages';
import {chartImageAnchor} from '../../shared/analysisInput';
async function install(page:Page){
 await page.route('**/api/health',route=>route.fulfill({json:{configured:true,model:'fixture',provider:'codex',maxAnalysisCandles:300,activeProvider:'codex',providers:{codex:true,api:false},codex:{available:true,authenticated:true,message:'Injected transport only'}}}));
 await page.route('**/api/market/stream?*',route=>route.abort());
 await page.route('**/api/market/candles?*',route=>{const tf=new URL(route.request().url()).searchParams.get('interval') as '1m',f=frame(tf);return route.fulfill({json:{provider:'binance',market:'usdt-perpetual',symbol:'SNDKUSDT',interval:tf,candles:f.candles,lastCandleClosed:true,serverTime:AS_OF*1000,fetchedAt:new Date(AS_OF*1000).toISOString(),warnings:[]}});});
 await page.route('**/api/research/market?*',route=>route.fulfill({json:researchBundle()}));
 await page.goto('/?live=SNDKUSDT&interval=1m');await expect(page.locator('.price-stat strong')).not.toHaveText('—');await page.getByLabel('分析来源',{exact:true}).selectOption('codex');
}
const diagnostics=(count:number)=>({requestId:'browser-fixture',inputMode:count?'hybrid':'data',elapsedMs:250,providerMs:200,validationMs:1,attempts:1,inputBytes:1000,imageCount:count,imageBytes:1000});
test('single-period clean chart capture, data comparison mode and collapsed controls use no paid calls',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));const requests:any[]=[];
 await page.route('**/api/analyze',async route=>{const body=route.request().postDataJSON();requests.push(body);for(const image of body.images??[]){expect(image).toMatchObject(chartImageAnchor(body.candles,body.context.symbol,body.context.timeframe));chartImageBytes(image);await writeFile('artifacts/hybrid-clean-chart.png',chartImageBytes(image));}
 return route.fulfill({json:{analysis:createMockAnalysis(body.candles),source:'ai',provider:'codex',billing:'chatgpt-plan',model:'injected-browser-transport',analyzedBars:body.candles.length,generatedAt:new Date().toISOString(),analysisAttempts:1,diagnostics:diagnostics(body.images?.length??0)}});});
 await install(page);await expect(page.getByLabel('分析输入模式')).toHaveValue('hybrid');await expect(page.getByRole('group',{name:'分析视图'})).not.toBeVisible();
 await page.getByRole('button',{name:'分析当前 K 线范围',exact:true}).click();await expect.poll(()=>requests.length).toBe(1);expect(requests[0].images).toHaveLength(1);expect(requests[0].inputMode).toBe('hybrid');
 await page.locator('.analysis-run-details summary').click();await expect(page.getByAltText('1m 本次分析的干净K线截图')).toBeVisible();await expect(page.locator('.analysis-run-details')).toContainText('0.3秒');
 await page.getByLabel('分析输入模式').selectOption('data');await page.getByRole('button',{name:'分析当前 K 线范围',exact:true}).click();await expect.poll(()=>requests.length).toBe(2);expect(requests[1].images).toEqual([]);expect(requests[1].inputMode).toBe('data');
 await expect(page.getByAltText('1m 本次分析的干净K线截图')).toHaveCount(0);await page.getByText('图表显示设置 · PA / SMC / 指标',{exact:true}).click();await expect(page.getByRole('group',{name:'分析视图'})).toBeVisible();await page.getByRole('button',{name:'SMC 主视图',exact:true}).click();expect(errors).toEqual([]);
});
test('multi-period captures three distinct anchored charts sequentially and retains compact evidence controls',async({page})=>{
 let calls=0;await page.route('**/api/research/analyze',route=>{calls++;const body=route.request().postDataJSON(),context=prepareResearchRequest(body).context;expect(body.inputMode).toBe('hybrid');expect(body.images.map((i:any)=>i.timeframe)).toEqual(['15m','5m','1m']);for(const image of body.images)chartImageBytes(image);
 return route.fulfill({json:{schemaVersion:'research-response-1.0',snapshotId:context.bundle.id,stateVersion:context.previous.version,source:'ai',provider:'codex',model:'injected-browser-transport',generatedAt:new Date().toISOString(),analysisAttempts:1,diagnostics:diagnostics(3),analysis:localWorkbenchInterpretation(context)}});});
 await install(page);const region=page.getByRole('region',{name:'多周期研究工作台'});await region.getByRole('button',{name:'开启多周期研究',exact:true}).click();await expect(region.locator('.research-frame')).toHaveCount(3);await expect(region.locator('.research-checks').first()).not.toBeVisible();await region.getByRole('button',{name:'AI重新评估',exact:true}).click();await expect(region.getByRole('button',{name:'AI重新评估',exact:true})).toBeEnabled();expect(calls).toBe(1);
 await region.locator('.analysis-run-details summary').click();await expect(region.locator('.analysis-run-details img')).toHaveCount(3);await region.locator('.research-strategy-list>summary').click();await region.locator('.research-candidate-details summary').first().click();await expect(region.locator('.research-checks').first()).toBeVisible();await region.locator('.research-candidate-details summary').first().click();await region.locator('.analysis-run-details summary').click();await page.screenshot({path:'artifacts/hybrid-workbench.png'});
});
