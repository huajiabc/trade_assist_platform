import { test,expect } from './fixtures';
import { frame,researchBundle,strategyFacts,AS_OF } from '../research-fixtures';
import { updateMarketState } from '../../shared/marketState';
import type { StrategyCandidate } from '../../shared/strategyCatalog';
import { STRATEGY_CATALOG_VERSION } from '../../shared/strategyCatalog';
import { STRUCTURAL_PLAN_POLICY } from '../../shared/planPolicy';

/** Controlled legacy-state presentation fixture, not a detector or strategy-profitability fixture. */
function restoredState(){
 const bundle=researchBundle(),state=updateMarketState(null,bundle,'受控旧记录展示',1,STRUCTURAL_PLAN_POLICY),facts=strategyFacts();
 facts.push({...facts[3],id:'five-displacement',type:'displacement',relatedIds:['five-break']});
 state.facts=Object.fromEntries(facts.map(fact=>[fact.id,{current:true,versions:[{stateVersion:state.version,knownAt:AS_OF,reason:'controlled-legacy-fixture',fact}]}]));
 const make=(id:string,strategyId:'bos-retest'|'displacement-continuation',primary:string):StrategyCandidate=>({id,strategyId,primaryFactId:primary,planPolicy:STRUCTURAL_PLAN_POLICY,direction:'bullish',scenarioId:'scenario-'+id,stage:'conditional',score:8,snapshotId:bundle.id,asOf:AS_OF,checks:[],supportIds:[primary,'five-protect','target','local-trigger'],oppositionIds:[],eventGroups:['same-event'],conflicts:[],uncertainties:[],sourceByFrame:{'15m':['background'],'5m':[primary,'five-protect'],'1m':['local-trigger']},expiresAt:AS_OF+1800,triggerObservedAt:AS_OF-60,proposalReason:'受控独立计划',setup:{id:id+'-plan',opportunityId:null,strategyId,direction:'bullish',status:'candidate',anchorTime:AS_OF-60,entry:100,stopLoss:92.75,targets:[{price:112,label:'实际结构目标'}],structureIds:[primary,'five-protect','target','local-trigger'],trigger:id+' 独立触发说明',tracking:{steps:[{label:'新回踩',conditions:[{type:'touch-zone',price:99.5,priceEnd:100.5}]},{label:'后续方向收盘',conditions:[{type:'close-above',price:100,priceEnd:null}]}],cancellation:{basis:'close',price:95,label:'保护失效'},expiresAfterBars:30},basis:{scenarioId:'scenario-'+id,entryStructureId:'local-trigger',stopStructureId:'five-protect',targetStructureIds:['target']},rationale:'受控旧记录，测试展示与保存独立性',invalidation:'真实保护收盘失效'}});
 state.catalogVersion=STRATEGY_CATALOG_VERSION;state.scenarios=[make('candidate-b','bos-retest','five-break'),make('candidate-f','displacement-continuation','five-displacement')];return state;
}

test('one concise opportunity retains independent strategy selection, chart location and saved plan',async({page})=>{
 const errors:string[]=[];let paidCalls=0;page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/market/stream?*',r=>r.abort());
 await page.route('**/api/market/candles?*',r=>r.fulfill({json:{provider:'binance',market:'usdt-perpetual',symbol:'SNDKUSDT',interval:'1m',candles:frame('1m').candles,lastCandleClosed:true,serverTime:AS_OF*1000,fetchedAt:new Date(AS_OF*1000).toISOString(),warnings:[]}}));
 await page.route('**/api/research/analyze',r=>{paidCalls++;return r.fulfill({status:409,json:{error:{message:'No model calls in grouping presentation test'}}});});
 await page.goto('/?live=SNDKUSDT&interval=1m');
 await page.evaluate(async state=>new Promise<void>((resolve,reject)=>{const request=indexedDB.open('pa-smc-research',1);request.onupgradeneeded=()=>request.result.createObjectStore('workspaces');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('workspaces','readwrite');tx.objectStore('workspaces').put(state,'research-1.0:live:SNDKUSDT');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};}),restoredState());
 await page.reload();const region=page.getByRole('region',{name:'多周期研究工作台'});await expect(region.getByRole('button',{name:'恢复本地更新',exact:true})).toBeVisible();
 const group=region.locator('.research-opportunity');await expect(group).toHaveCount(1);await expect(group).toContainText('B · BOS突破与回踩延续');await expect(group).toContainText('F · 强位移与延续交易');await expect(region.locator('.research-candidate')).toHaveCount(2);await expect(region.locator('.research-candidate').first()).toBeHidden();
 await group.getByRole('combobox').selectOption('candidate-f');await expect(group.locator('.research-opportunity-trigger')).toContainText('candidate-f 独立触发说明');await group.getByRole('button',{name:'定位当前候选',exact:true}).click();await expect(region.getByLabel('研究定位图表')).toContainText('F · 强位移与延续交易');await expect(region.getByLabel('研究定位图表').locator('canvas').first()).toBeVisible();
 await group.getByRole('button',{name:'保存该策略候选',exact:true}).click();await expect(region.locator('.research-plan')).toHaveCount(1);await expect(region.locator('.research-plan')).toContainText('F · 强位移与延续交易');await expect(region.locator('.research-plan')).toContainText('candidate-f 独立触发说明');
 await expect.poll(async()=>page.evaluate(async()=>new Promise<string|null>(resolve=>{const request=indexedDB.open('pa-smc-research',1);request.onsuccess=()=>{const db=request.result,r=db.transaction('workspaces').objectStore('workspaces').get('research-1.0:live:SNDKUSDT');r.onsuccess=()=>{resolve(r.result?.plans[0]?.strategyId??null);db.close();};};}))).toBe('displacement-continuation');expect(paidCalls).toBe(0);expect(errors).toEqual([]);
});
