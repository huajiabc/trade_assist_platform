import { test,expect } from './fixtures';
import type { Page } from '@playwright/test';
import { accountSnapshot } from '../account-fixtures';
import { emptyAccountStatus } from '../../shared/account';
import { FRAME_SECONDS,RESEARCH_FRAMES,makeResearchBundle } from '../../shared/researchData';
import { prepareResearchRequest } from '../../server/workbench';
import { localWorkbenchInterpretation } from '../../shared/workbenchAnalysis';
import { buildPositionManagement,localPositionAdvice } from '../../shared/positionManagement';

function recentBundle(){const asOf=Math.floor(Date.now()/60000)*60;return makeResearchBundle('SNDKUSDT',RESEARCH_FRAMES.map(tf=>{const seconds=FRAME_SECONDS[tf],end=Math.floor(asOf/seconds)*seconds,candles=Array.from({length:80},(_,i)=>{const open=100+Math.sin(i/6)*2,close=open+Math.cos(i/3)*.4;return {timestamp:end-(80-i)*seconds,open,high:Math.max(open,close)+.5,low:Math.min(open,close)-.5,close,volume:100+i%9*10};});return {timeframe:tf,symbol:'SNDKUSDT',source:'binance' as const,closure:'exchange-confirmed' as const,observedAt:asOf,candles,lastClosedTime:candles.at(-1)!.timestamp,derivedFrom:null,unavailableReason:null};}),asOf);}
async function installMarket(page:Page){
 const bundle=recentBundle(),counts={market:0,analysis:0};
 await page.route('**/api/health',r=>r.fulfill({json:{configured:true,model:'injected-only',provider:'codex',maxAnalysisCandles:300,activeProvider:'codex',providers:{codex:true,api:false},codex:{available:true,authenticated:true,message:'No real model calls'}}}));
 await page.route('**/api/market/stream?*',r=>r.abort());
 await page.route('**/api/market/candles?*',r=>{const tf=new URL(r.request().url()).searchParams.get('interval') as '1m';return r.fulfill({json:{provider:'binance',market:'usdt-perpetual',symbol:bundle.symbol,interval:tf,candles:bundle.frames[tf].candles,lastCandleClosed:true,serverTime:bundle.asOf*1000,fetchedAt:new Date(bundle.asOf*1000).toISOString(),warnings:[]}});});
 await page.route('**/api/research/market?*',r=>{counts.market++;return r.fulfill({json:bundle});});
 return {bundle,counts};
}
test('quick scan spends no model calls; optional light AI and deep review keep the same complete snapshot',async({page})=>{
 const errors:string[]=[],requests:any[]=[];page.on('pageerror',e=>errors.push(e.message));const fixture=await installMarket(page);
 await page.route('**/api/research/analyze',r=>{fixture.counts.analysis++;const body=r.request().postDataJSON();requests.push(body);const c=prepareResearchRequest(body).context;return r.fulfill({json:{catalogVersion:c.catalogVersion,schemaVersion:'research-response-1.0',snapshotId:c.bundle.id,stateVersion:c.previous.version,source:'ai',provider:'codex',model:'injected-only',generatedAt:new Date().toISOString(),analysisAttempts:1,analysis:localWorkbenchInterpretation(c)}});});
 await page.goto('/?live=SNDKUSDT&interval=1m');await page.getByLabel('分析来源',{exact:true}).selectOption('codex');
 await page.getByRole('button',{name:'快速扫描',exact:true}).click();const region=page.getByRole('region',{name:'多周期研究工作台'});await expect(region).toContainText('快速扫描完成');expect(fixture.counts.analysis).toBe(0);
 await region.locator('.research-tools>summary').click();await region.locator('.research-phase-timings>summary').click();await expect(region.locator('.research-phase-timings')).toContainText('模型调用0.00秒');
 await region.getByRole('button',{name:'轻量AI审阅（主动调用）'}).click();await expect.poll(()=>requests.length).toBe(1);await expect(page.getByRole('button',{name:'深度分析',exact:true})).toBeEnabled();
 expect(requests[0].reviewDepth).toBe('quick');expect(requests[0].images).toEqual([]);expect(requests[0].bundle.frames.map((f:any)=>f.candles.length)).toEqual([80,80,80]);
 const marketBefore=fixture.counts.market;await page.getByRole('button',{name:'深度分析',exact:true}).click();await expect.poll(()=>requests.length).toBe(2);await expect(page.getByRole('button',{name:'深度分析',exact:true})).toBeEnabled();
 expect(requests[1].reviewDepth).toBe('deep');expect(requests[1].images).toHaveLength(3);expect(requests[1].bundle).toEqual(requests[0].bundle);expect(fixture.counts.market).toBe(marketBefore);await expect(region.locator('.research-phase-timings')).toContainText('复用行情快照');expect(errors).toEqual([]);
});
test('server-environment connection controls never transmit or retrieve credentials',async({page})=>{
 await installMarket(page);let connected=false;const snapshot=accountSnapshot(),operations:string[]=[];
 await page.route('**/api/account/**',r=>{const action=new URL(r.request().url()).pathname.split('/').at(-1)!;if(action!=='status'){operations.push(action);expect(r.request().postDataJSON()).toEqual({});}if(action==='connect')connected=true;if(action==='disconnect')connected=false;return r.fulfill({json:{...emptyAccountStatus(),configured:true,connected,snapshot:operations.length?snapshot:null,validity:connected?'fresh':'disconnected',lastSuccessAt:operations.length?snapshot.syncedAt:null}});});
 await page.goto('/?live=SNDKUSDT&interval=1m');await page.getByRole('button',{name:'模型设置',exact:true}).click();const settings=page.getByRole('region',{name:'Binance只读账户连接'});await expect(settings).toContainText('BINANCE_API_SECRET');await expect(settings).toContainText('关闭交易与提现');await expect(settings.getByRole('button',{name:'测试并连接'})).toBeEnabled();await settings.getByRole('button',{name:'测试并连接'}).click();await expect(settings).toContainText('数据有效');await settings.getByRole('button',{name:'断开账户'}).click();await expect(settings).toContainText('未连接');expect(operations).toEqual(['connect','disconnect']);
 expect(await page.evaluate(()=>JSON.stringify({...localStorage}))).not.toContain('fixture-binance-secret');expect(await page.locator('input[type=password]').count()).toBe(0);
});
test('real positions stay separate from manual records; concurrent account updates make advice historical',async({page})=>{
 const fixture=await installMarket(page),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));let snapshot=accountSnapshot();let calls=0,release=()=>{};
 await page.route('**/api/account/**',async r=>{
  const action=new URL(r.request().url()).pathname.split('/').at(-1);
  if(action==='review'){
   calls++;const body=r.request().postDataJSON(),originalSnapshot=snapshot,c=prepareResearchRequest(body.research).context;
   expect(body.linkedPlanId).toBeNull();expect(body.research.images).toHaveLength(3);
   const management=buildPositionManagement({symbol:c.bundle.symbol,bundle:c.bundle,version:c.previous.version,facts:c.facts,plans:[]},originalSnapshot,originalSnapshot.positions[0],null);
   await new Promise<void>(resolve=>{release=resolve;});
   return r.fulfill({json:{schemaVersion:'position-review-response-1.0',positionId:body.positionId,accountSnapshotId:body.accountSnapshotId,marketSnapshotId:c.bundle.id,stateVersion:c.previous.version,linkedPlanId:null,generatedAt:Date.now(),source:'ai',provider:'codex',model:'injected-only',analysisAttempts:1,stale:false,staleReasons:[],analysis:localPositionAdvice(management)}});
  }
  return r.fulfill({json:{...emptyAccountStatus(),configured:true,connected:true,validity:'fresh',snapshot,lastSuccessAt:snapshot.syncedAt}});
 });
 await page.goto('/?live=SNDKUSDT&interval=1m');await page.getByLabel('分析来源',{exact:true}).selectOption('codex');await page.getByRole('tab',{name:'我的持仓',exact:true}).click();const panel=page.getByRole('region',{name:'真实持仓管理'});
 await expect(panel.getByRole('button',{name:'深度审阅此持仓'})).toBeEnabled();await expect(panel).toContainText('实际开仓均价');await expect(panel).toContainText('98.00');await expect(panel.getByLabel('关联原交易计划')).toHaveValue('');await expect(panel).toContainText('未关联原交易计划');
 await panel.getByRole('button',{name:'深度审阅此持仓'}).click();await expect.poll(()=>calls).toBe(1);
 snapshot={...snapshot,id:'updated-during-model-review',syncedAt:Date.now(),expiresAt:Date.now()+45000};await panel.getByRole('button',{name:'刷新账户',exact:true}).click();release();
 await expect(panel.getByLabel('持仓管理建议')).toContainText('原快照结果 · 已过时');await expect(panel.getByLabel('持仓管理建议')).toContainText('不能视为当前管理建议');await expect(page.locator('.chart-host')).toHaveCount(1);expect(fixture.counts.analysis).toBe(0);
 await page.locator('.position-detail').screenshot({path:'artifacts/real-position-management.png'});await page.setViewportSize({width:375,height:900});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);expect(errors).toEqual([]);
});
