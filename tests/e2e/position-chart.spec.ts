import {test,expect} from './fixtures';
import type {Page} from '@playwright/test';
import {accountSnapshot} from '../account-fixtures';
import {emptyAccountStatus} from '../../shared/account';
import {normalizeProtectionOrders} from '../../shared/protectionOrders';
import {makeResearchBundle,RESEARCH_FRAMES,FRAME_SECONDS} from '../../shared/researchData';
import {prepareResearchRequest} from '../../server/workbench';
import {buildPositionManagement,localPositionAdvice,validatePositionAdvice} from '../../shared/positionManagement';
async function install(page:Page){
 const asOf=Math.floor(Date.now()/60000)*60,bundle=makeResearchBundle('SNDKUSDT',RESEARCH_FRAMES.map(tf=>{const seconds=FRAME_SECONDS[tf],end=Math.floor(asOf/seconds)*seconds,candles=Array.from({length:80},(_,i)=>{const open=100+Math.sin(i/6)*2,close=open+Math.cos(i/3)*.4;return {timestamp:end-(80-i)*seconds,open,high:Math.max(open,close)+.5,low:Math.min(open,close)-.5,close,volume:100};});return {symbol:'SNDKUSDT',timeframe:tf,source:'binance' as const,closure:'exchange-confirmed' as const,observedAt:asOf,candles,lastClosedTime:candles.at(-1)!.timestamp,derivedFrom:null,unavailableReason:null};}),asOf);
 let snapshot=accountSnapshot(),stale=false,reviews=0,failReview=false,marketGate:Promise<void>|null=null,releaseMarket=()=>{};let publicMarket={provider:'binance',market:'usdt-perpetual',symbol:bundle.symbol,interval:'1m',candles:bundle.frames['1m'].candles,lastCandleClosed:true,serverTime:bundle.asOf*1000,fetchedAt:new Date().toISOString(),warnings:[] as string[]};snapshot.positions[0].markPrice=99;
 snapshot.orders=normalizeProtectionOrders({standard:[{orderId:1,symbol:'SNDKUSDT',positionSide:'BOTH',side:'SELL',origType:'STOP_MARKET',status:'NEW',origQty:'2',executedQty:'0',stopPrice:'95',reduceOnly:true,closePosition:false,workingType:'MARK_PRICE'}],algo:[{algoId:2,symbol:'SNDKUSDT',positionSide:'BOTH',side:'SELL',orderType:'TAKE_PROFIT_MARKET',algoStatus:'NEW',quantity:'2',triggerPrice:'112',reduceOnly:true,workingType:'CONTRACT_PRICE'}],syncedAt:Date.now(),staleAfterMs:45000});
 await page.route('**/api/health',r=>r.fulfill({json:{configured:true,model:'injected-only',activeProvider:'codex',providers:{codex:true,api:false},codex:{available:true,authenticated:true,message:'Mock only'}}}));
 await page.route('**/api/market/stream?*',r=>r.abort());
 await page.route('**/api/market/candles?*',r=>r.fulfill({json:publicMarket}));
 await page.route('**/api/research/market?*',async r=>{if(marketGate)await marketGate;return r.fulfill({json:bundle});});
 await page.route('**/api/account/**',r=>{
  if(r.request().url().endsWith('/review')){reviews++;if(failReview)return r.fulfill({status:502,json:{error:{message:'受控持仓审阅失败，请重试。',code:'PROVIDER_INVALID_OUTPUT'}}});const body=r.request().postDataJSON(),c=prepareResearchRequest(body.research).context,management=buildPositionManagement({symbol:c.bundle.symbol,bundle:c.bundle,version:c.previous.version,facts:c.facts,plans:[]},snapshot,snapshot.positions[0],null);
   const stop=management.levels.find(l=>l.kind==='protection'),target=management.levels.find(l=>l.kind==='target'&&stop&&(l.price-99)/(99-stop.price)>=1);
   expect(stop,'fixture must have a verified 5m protection').toBeTruthy();expect(target,'fixture must have a verified structural target with sufficient space').toBeTruthy();
   const analysis=validatePositionAdvice({...localPositionAdvice(management),decision:'review-protection',summary:'基于5m保护与15m目标的持仓复核，不执行订单。',evidence:[{structureId:stop!.structureId,timeframe:stop!.timeframe},{structureId:target!.structureId,timeframe:target!.timeframe}],protection:{structureId:stop!.structureId,timeframe:stop!.timeframe,price:stop!.price},targets:[{structureId:target!.structureId,timeframe:target!.timeframe,price:target!.price}]},management);
   return r.fulfill({json:{schemaVersion:'position-review-response-1.0',positionId:body.positionId,accountSnapshotId:snapshot.id,marketSnapshotId:c.bundle.id,stateVersion:c.previous.version,linkedPlanId:null,generatedAt:Date.now(),source:'ai',provider:'codex',model:'injected-only',analysisAttempts:1,stale:false,staleReasons:[],analysis}});
  }
  return r.fulfill({json:{...emptyAccountStatus(),configured:true,connected:true,validity:stale?'stale':'fresh',error:stale?{code:'ACCOUNT_NETWORK',message:'模拟同步失败，保留旧持仓。'}:null,snapshot,lastSuccessAt:snapshot.syncedAt}});
 });
 await page.goto('/?live=SNDKUSDT&interval=1m');await page.getByLabel('分析来源',{exact:true}).selectOption('codex');await page.getByRole('tab',{name:'我的持仓',exact:true}).click();
 const panel=page.getByRole('region',{name:'真实持仓管理'});await expect(panel.getByRole('button',{name:'图表查看当前持仓'})).toBeVisible();
 return {panel,reviews:()=>reviews,failReview:(value:boolean)=>{failReview=value;},holdMarket:()=>{marketGate=new Promise<void>(resolve=>{releaseMarket=resolve;});},releaseMarket:()=>{releaseMarket();marketGate=null;},tick:(close:number)=>{publicMarket={...publicMarket,lastCandleClosed:false,serverTime:(bundle.asOf+20)*1000,candles:[...bundle.frames['1m'].candles,{timestamp:bundle.asOf,open:100,high:Math.max(100,close)+1,low:Math.min(99,close),close,volume:100}]};},change:()=>{snapshot={...snapshot,id:'account-updated',positions:snapshot.positions.map(p=>({...p,markPrice:100}))};},fail:()=>{stale=true;}};
}
async function pixels(page:Page,color:number[]){return page.locator('.chart-host canvas').evaluateAll((nodes,c)=>{let count=0;for(const node of nodes){const canvas=node as HTMLCanvasElement;if(!canvas.width||!canvas.height)continue;const data=canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height).data;for(let i=0;i<data.length;i+=4)if(data[i+3]>180&&c.every((value,index)=>Math.abs(data[i+index]-value)<4))count++;}return count;},color);}
test('actual position, existing SL/TP and grounded advice share one chart with independent sources and exact prices',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));const f=await install(page),legend=page.getByLabel('持仓图表说明');
 await expect(legend).toContainText('实际均价 98.00');await expect(legend).toContainText('已设SL1');await expect(legend).toContainText('95.00');await expect(legend).toContainText('已设TP1');await expect(legend).toContainText('112.00');await expect(legend).toContainText('3.25R');await expect(page.locator('.chart-host')).toHaveCount(1);
 await expect(f.panel.getByLabel('交易所现有止损止盈')).toContainText('标记价触发');await expect(f.panel.getByLabel('交易所现有止损止盈')).toContainText('合约最新价触发');expect(f.reviews()).toBe(0);await expect.poll(()=>pixels(page,[248,121,131])).toBeGreaterThan(15);
 await f.panel.getByRole('button',{name:'深度审阅此持仓'}).click();await expect(legend).toContainText('建议SL · 未设置');await expect(legend).toContainText('建议TP1 · 未设置');await expect(page.getByLabel('研究定位图表')).toHaveAttribute('data-market-mode','live');await expect(page.locator('.research-focus-banner')).toContainText('实时行情');await expect.poll(()=>pixels(page,[255,181,107])).toBeGreaterThan(15);
 await expect(f.panel.locator('.position-account-details')).not.toHaveAttribute('open');
 expect(await f.panel.locator('.position-detail').evaluate(e=>e.querySelector('.position-review-control')!.compareDocumentPosition(e.querySelector('.position-advice')!)&Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
 expect(await f.panel.locator('.position-detail').evaluate(e=>e.querySelector('.position-advice')!.compareDocumentPosition(e.querySelector('.position-account-details')!)&Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
 await legend.getByRole('checkbox',{name:'交易所已设',exact:true}).uncheck();await expect(legend.getByRole('button',{name:/已设SL/})).toHaveCount(0);await expect(legend.getByRole('button',{name:/建议SL/})).toBeVisible();await expect.poll(()=>pixels(page,[248,121,131])).toBe(0);
 await legend.getByRole('checkbox',{name:'交易所已设',exact:true}).check();await legend.getByRole('button',{name:/已设SL/}).click();await expect(legend.getByLabel('持仓价位详情')).toContainText('STOP_MARKET');await expect(legend.getByLabel('持仓价位详情')).toContainText('剩余数量 2');
 await f.panel.getByRole('button',{name:'图表查看当前持仓'}).click();f.change();await f.panel.getByRole('button',{name:'刷新账户',exact:true}).click();await expect(legend).toContainText('标记价 100.00');await expect(legend.getByRole('button',{name:/建议SL/})).toHaveCount(0);await expect(legend).toContainText('旧快照');
 await f.panel.getByRole('button',{name:'查看原审阅快照'}).click();await expect(legend).toContainText('标记价 99.00');await expect(legend.getByRole('button',{name:/建议SL/})).toBeVisible();expect(f.reviews()).toBe(1);expect(errors).toEqual([]);
 await page.locator('.research-main-chart').screenshot({path:'artifacts/position-orders-chart.png'});await page.setViewportSize({width:375,height:900});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
});
test('failed account sync dims the anchored chart and returning to live stays closed on subsequent polls',async({page})=>{const f=await install(page),legend=page.getByLabel('持仓图表说明');await expect(legend).toBeVisible();f.fail();await f.panel.getByRole('button',{name:'刷新账户',exact:true}).click();await expect(legend).toContainText('账户快照已过时');await expect(f.panel.getByRole('button',{name:'深度审阅此持仓'})).toBeDisabled();await expect(f.panel.locator('#position-review-status')).toContainText('账户数据未同步、已过期或连接异常');await page.getByRole('button',{name:'收起持仓标注',exact:true}).click();await expect(legend).toHaveCount(0);await f.panel.getByRole('button',{name:'刷新账户',exact:true}).click();await expect(legend).toHaveCount(0);expect(f.reviews()).toBe(0);});


test('current position follows forming quotes while a user-selected original review stays frozen',async({page})=>{
 const f=await install(page),chart=page.getByLabel('研究定位图表'),legend=page.getByLabel('持仓图表说明');
 await expect(chart).toHaveAttribute('data-market-mode','live');await expect(page.locator('.research-focus-banner')).toContainText('1m 实时行情');
 await expect(page.getByLabel('图表周期',{exact:true})).toHaveText('1M · 当前持仓');
 f.tick(123.45);await page.getByRole('button',{name:'刷新真实行情',exact:true}).first().click();
 await expect(chart.locator('.chart-readout')).toContainText('123.45');await expect(legend).toContainText('实际均价 98.00');
 expect(f.reviews()).toBe(0);
 await f.panel.getByRole('button',{name:'深度审阅此持仓',exact:true}).click();
 await expect(f.panel.getByLabel('持仓管理建议')).toBeVisible();await expect(chart).toHaveAttribute('data-market-mode','live');
 await f.panel.getByRole('button',{name:'查看原审阅快照',exact:true}).click();
 await expect(chart).toHaveAttribute('data-market-mode','snapshot');const old=await chart.locator('.chart-readout').innerText();
 await expect(page.getByLabel('图表周期',{exact:true})).toHaveText('5M · 快照');
 f.tick(124.5);await page.getByRole('button',{name:'刷新真实行情',exact:true}).first().click();
 await expect.poll(()=>chart.locator('.chart-readout').innerText()).toBe(old);await expect(legend).toContainText('原审阅快照');
 await f.panel.getByRole('button',{name:'图表查看当前持仓',exact:true}).click();await expect(chart).toHaveAttribute('data-market-mode','live');
 await expect(chart.locator('.chart-readout')).toContainText('124.50');expect(f.reviews()).toBe(1);
 await chart.locator('.chart-shell').screenshot({path:'artifacts/position-live-market.png'});
});

test('background rule refresh leaves position review usable and shows its preparation progress',async({page})=>{
 const f=await install(page),workspace=page.getByRole('region',{name:'多周期研究工作台'});
 await expect(f.panel.getByRole('button',{name:'深度审阅此持仓',exact:true})).toBeEnabled();
 await workspace.locator('.research-tools>summary').click();f.holdMarket();
 await workspace.getByRole('button',{name:'更新规则',exact:true}).click();await expect(workspace.getByRole('button',{name:'刷新中…',exact:true})).toBeDisabled();
 await expect(f.panel.getByRole('button',{name:'深度审阅此持仓',exact:true})).toBeEnabled();
 await f.panel.getByRole('button',{name:'深度审阅此持仓',exact:true}).click();
 await expect(f.panel.locator('#position-review-status')).toContainText('准备多周期行情');
 await expect(f.panel.getByRole('button',{name:'取消持仓审阅',exact:true})).toBeVisible();expect(f.reviews()).toBe(0);
 await f.panel.locator('.position-review-control').screenshot({path:'artifacts/position-review-progress.png'});
 f.releaseMarket();await expect(f.panel.getByLabel('持仓管理建议')).toBeVisible();expect(f.reviews()).toBe(1);
 await expect(page.getByLabel('研究定位图表')).toHaveAttribute('data-market-mode','live');
});

test('position review errors appear beside the action and a retry can succeed',async({page})=>{
 const f=await install(page);f.failReview(true);
 await f.panel.getByRole('button',{name:'深度审阅此持仓',exact:true}).click();
 await expect(f.panel.getByRole('alert')).toContainText('受控持仓审阅失败');
 await expect(f.panel.getByRole('button',{name:'深度审阅此持仓',exact:true})).toBeEnabled();
 await expect(f.panel.getByLabel('持仓管理建议')).toHaveCount(0);
 f.failReview(false);await f.panel.getByRole('button',{name:'深度审阅此持仓',exact:true}).click();
 await expect(f.panel.getByLabel('持仓管理建议')).toBeVisible();await expect(f.panel.locator('#position-review-status')).toContainText('审阅完成');
 expect(f.reviews()).toBe(2);
});


test('a user can cancel a pending position review without rendering a late suggestion',async({page})=>{
 const f=await install(page);let requested=false,release=()=>{};
 const pending=new Promise<void>(resolve=>{release=resolve;});
 await page.route('**/api/account/review',async r=>{requested=true;await pending;await r.abort().catch(()=>undefined);});
 await f.panel.getByRole('button',{name:'深度审阅此持仓',exact:true}).click();
 await expect.poll(()=>requested).toBe(true);await expect(f.panel.locator('#position-review-status')).toContainText('模型正在审阅');
 await f.panel.getByRole('button',{name:'取消持仓审阅',exact:true}).click();
 await expect(f.panel.getByRole('alert')).toContainText('取消');
 await expect(f.panel.getByRole('button',{name:'深度审阅此持仓',exact:true})).toBeEnabled();
 release();await expect(f.panel.getByLabel('持仓管理建议')).toHaveCount(0);
 await expect(page.getByLabel('研究定位图表')).toHaveAttribute('data-market-mode','live');
});


test('cancelling a review waiting for shared market data unlocks immediately without aborting that refresh',async({page})=>{
 const f=await install(page),workspace=page.getByRole('region',{name:'多周期研究工作台'});
 await workspace.locator('.research-tools>summary').click();f.holdMarket();await workspace.getByRole('button',{name:'更新规则',exact:true}).click();
 await f.panel.getByRole('button',{name:'深度审阅此持仓',exact:true}).click();
 await expect(f.panel.locator('#position-review-status')).toContainText('准备多周期行情');
 await f.panel.getByRole('button',{name:'取消持仓审阅',exact:true}).click();
 await expect(f.panel.getByRole('button',{name:'深度审阅此持仓',exact:true})).toBeEnabled({timeout:1500});
 await expect(f.panel.getByRole('alert')).toContainText('取消');
 await expect(workspace.getByRole('button',{name:'刷新中…',exact:true})).toBeDisabled();
 f.releaseMarket();await expect(workspace.getByRole('button',{name:'更新规则',exact:true})).toBeEnabled();
 expect(f.reviews()).toBe(0);await expect(f.panel.getByLabel('持仓管理建议')).toHaveCount(0);
});
