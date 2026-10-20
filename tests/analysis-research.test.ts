import { describe, expect, it } from 'vitest';
import { validateAnalysis, type Analysis } from '../shared/analysis';
import { createMockAnalysis } from '../shared/mock';
import { extractStructureEvidence } from '../shared/structureEvidence';
import { priceEvidence, planEvidenceSummary } from '../shared/analysisResearch';
import { projectAnalysisForCandles } from '../src/analysisSession';
import { SAMPLE_CANDLES } from '../shared/sample';
const candles=Array.from({length:30},(_,i)=>({timestamp:1_790_000_000+i*60,open:100,high:105,low:99,close:101,volume:5}));
function research():Analysis {
 const a=createMockAnalysis(candles); a.structures=[];a.opportunities=[];a.liquiditySweeps=[];a.keyLevels=[];
 a.priceAction={regime:'range',summary:'区间参考',zones:[
 {id:'support',title:'支撑',kind:'support',status:'confirmed',startTime:candles[0].timestamp,endTime:candles[10].timestamp,lowerPrice:99,upperPrice:100,touchTimes:[candles[1].timestamp,candles[5].timestamp],rationale:'重复低点',invalidation:'收于99下方'},
 {id:'resistance',title:'阻力',kind:'resistance',status:'confirmed',startTime:candles[0].timestamp,endTime:candles[10].timestamp,lowerPrice:104,upperPrice:105,touchTimes:[candles[2].timestamp,candles[7].timestamp],rationale:'重复高点',invalidation:'收于105上方'}],legs:[],patterns:[],breakouts:[]};
 a.research={regime:'range',regimeEvidenceIds:['support','resistance'],background:'全段反复测试',currentContext:'等待价格回踩',areaReviews:[{structureId:'support',state:'testing',observedAt:candles[20].timestamp,rationale:'该根低点99相交'}],scenarios:[{id:'retest',direction:'bullish',structureIds:['support'],thesis:'等待回踩延续',confirmation:'触及99到100后续收于101上方',cancellation:'先收于99下方'}],coverage:[]};
 a.tradePlanning={status:'conditional',reason:'存在支撑保护和阻力目标，需等待'};
 a.tradeSetups=[{id:'plan',direction:'bullish',status:'candidate',opportunityId:null,anchorTime:candles.at(-1)!.timestamp,entry:100,stopLoss:97,targets:[{price:104,label:'阻力下沿'}],trigger:'触及99至100，然后后续收于101上方',rationale:'支撑与阻力',invalidation:'先跌破保护位取消',structureIds:['support','resistance'],basis:{scenarioId:'retest',entryStructureId:'support',stopStructureId:'support',targetStructureIds:['resistance']},tracking:{steps:[{label:'回踩',conditions:[{type:'touch-zone',price:99,priceEnd:100}]},{label:'后续收盘',conditions:[{type:'close-above',price:101,priceEnd:null}]}],cancellation:{basis:'close',price:99,label:'支撑失效'},expiresAfterBars:8}}];
 return a;
}
describe('staged research and price-grounded conditional plans',()=>{
 it('accepts actual reactions, scenario links, structural stop/target and auditable future conditions',()=>{
 const a=research();expect(validateAnalysis(a,candles)).toEqual(a);
 const summary=planEvidenceSummary(a.tradeSetups[0],priceEvidence(a,candles),candles);
 expect(summary).toMatchObject({citedCount:2,stopRisk:{riskDistance:3,riskAtr:.5,structuralBoundary:99,structuralBuffer:2,errors:[]}});
 expect(summary.warnings).toEqual([expect.stringContaining('不足1 ATR')]);
 });
 it.each(['unknown','wrong-direction','no-common-reference','missing-basis','entry','stop','target','trigger','risk-space','risk-size','regime','area-time','area-failed','area-before-known','area-untested','window','duplicate-coverage'])('rejects inconsistent %s',kind=>{
 const a=research(), p=a.tradeSetups[0], r=a.research!;
 switch(kind){
 case 'unknown':p.basis!.entryStructureId='invented';break;
 case 'wrong-direction':r.scenarios[0].direction='bearish';break;
 case 'no-common-reference':r.scenarios[0].structureIds=[];break;
 case 'missing-basis':p.basis=null;break;
 case 'entry':p.entry=103;p.stopLoss=98;p.targets[0].price=110;break;
 case 'stop':p.stopLoss=99;break;
 case 'target':p.targets[0].price=106;break;
 case 'trigger':p.tracking!.steps=[{label:'错误区域',conditions:[{type:'close-above',price:104,priceEnd:null}]}];break;
 case 'risk-space':p.stopLoss=95;break;
 case 'risk-size':p.stopLoss=60;break;
 case 'regime':r.regime='uptrend';break;
 case 'area-time':r.areaReviews[0].observedAt+=1;break;
 case 'area-failed':r.areaReviews[0].state='failed';break;
 case 'area-before-known':r.areaReviews[0].observedAt=candles[5].timestamp;break;
 case 'area-untested':r.areaReviews[0].state='untested';break;
 case 'window':r.coverage=[{windowId:'missing-window',reviewedIds:[],omittedIds:[],reason:'未审阅'}];break;
 case 'duplicate-coverage':r.coverage=[{windowId:'window-0',reviewedIds:['support'],omittedIds:['support'],reason:'矛盾'}];break;
 }
 expect(()=>validateAnalysis(a,candles)).toThrow(/校验失败/);
 });
 it.each(['bullish','bearish'] as const)('rejects a %s stop just 0.01 outside its cited boundary',direction=>{
 const a=research(),p=a.tradeSetups[0];
 if(direction==='bullish')p.stopLoss=98.99;
 else{a.research!.scenarios[0].direction='bearish';a.research!.scenarios[0].structureIds=['resistance'];p.direction='bearish';p.entry=104;p.stopLoss=105.01;p.targets=[{price:100,label:'支撑'}];p.basis={scenarioId:'retest',entryStructureId:'resistance',stopStructureId:'resistance',targetStructureIds:['support']};p.tracking=null;}
 const before=structuredClone(a);
 expect(()=>validateAnalysis(a,candles)).toThrow(/0.25 ATR/);
 expect(a).toEqual(before);
 });
 it('keeps a legacy ungrounded plan visible but reports tight risk and unknown structural buffer',()=>{
 const a=research();a.research=null;a.tradeSetups[0].basis=null;a.tradeSetups[0].stopLoss=99.99;
 expect(validateAnalysis(a,candles)).toEqual(a);
 const report=planEvidenceSummary(a.tradeSetups[0],priceEvidence(a,candles),candles);
 expect(report.warnings.join(' ')).toContain('0.5 ATR');
 expect(report.stopRisk.structuralBuffer).toBeNull();
 });
 it('rejects insufficient target room after a structurally buffered stop instead of repairing geometry',()=>{
 const a=research();a.tradeSetups[0].stopLoss=95;const before=structuredClone(a);
 expect(()=>validateAnalysis(a,candles)).toThrow(/不足1R/);expect(a).toEqual(before);
 });
 it('accepts a wide structurally anchored stop with real target space, without the old distance cap',()=>{
 const a=research(), data=Array.from({length:80},(_,i)=>i<11?{...candles[i]}:{...candles[0],timestamp:candles[0].timestamp+i*60,open:101,close:101,high:101.1,low:100.9});
 data[2].high=data[7].high=115;
 Object.assign(a.priceAction.zones[1],{lowerPrice:114,upperPrice:115});a.research!.areaReviews=[];
 const p=a.tradeSetups[0];p.anchorTime=data.at(-1)!.timestamp;p.stopLoss=97;p.targets=[{price:114,label:'真实阻力下沿'}];
 expect(validateAnalysis(a,data).tradeSetups[0].stopLoss).toBe(97);
 const report=planEvidenceSummary(p,priceEvidence(a,data),data);
 expect(report.stopRisk.riskAtr).toBeGreaterThan(6);expect(report.stopRisk.errors).toEqual([]);
 expect(report.warnings.join(' ')).toContain('超过6 ATR');
 });
 it('rejects price-range-plausible fabricated FVG under staged research, not only schema/price bounds',()=>{
 const a=research();a.structures=[{id:'false-gap',type:'FVG',direction:'bullish',status:'candidate',startTime:candles[3].timestamp,endTime:candles[8].timestamp,price:100,priceEnd:101,rationale:'伪缺口',invalidation:'回补'}];
 expect(()=>validateAnalysis(a,candles)).toThrow(/确认时间/);
 });
 it('validates a reflected short plan using resistance protection and support target',()=>{
 const a=research(),p=a.tradeSetups[0];a.research!.scenarios[0].direction='bearish';a.research!.scenarios[0].structureIds=['resistance'];
 p.direction='bearish';p.entry=104;p.stopLoss=107;p.targets=[{price:100,label:'支撑上沿'}];p.basis={scenarioId:'retest',entryStructureId:'resistance',stopStructureId:'resistance',targetStructureIds:['support']};
 p.trigger='触及104至105后，后续收于103下方';p.tracking!.steps=[{label:'阻力测试',conditions:[{type:'touch-zone',price:104,priceEnd:105}]},{label:'后续收盘',conditions:[{type:'close-below',price:103,priceEnd:null}]}];p.tracking!.cancellation.price=105;
 expect(validateAnalysis(a,candles).tradeSetups[0].direction).toBe('bearish');
 });
 it('rejects a historically broken support as a current entry/stop anchor',()=>{
 const a=research(),revised=candles.map(c=>({...c}));revised[25]={...revised[25],open:98,low:97,high:99,close:98};
 expect(()=>validateAnalysis(a,revised)).toThrow(/失效/);
 });
 it('migrates strict1.4 with preserved tracking and explicitly unknown stage/price basis',()=>{
 const a=research(),{research:_research,...old}=a;
 const legacy={...old,schemaVersion:'1.4',tradeSetups:old.tradeSetups.map(({basis:_basis,...p})=>p)};
 const upgraded=validateAnalysis(legacy,candles);
 expect(upgraded.schemaVersion).toBe('1.5');expect(upgraded.research).toBeNull();expect(upgraded.tradeSetups[0].basis).toBeNull();expect(upgraded.tradeSetups[0].tracking).toEqual(a.tradeSetups[0].tracking);
 expect(validateAnalysis(upgraded,candles)).toEqual(upgraded);
 expect(()=>validateAnalysis({...legacy,research:null},candles)).toThrow(/校验失败/);
 });
 it('keeps plans citing deterministic IDs in display projection, hides revised/missing evidence and never changes raw',()=>{
 const a=createMockAnalysis(SAMPLE_CANDLES),e=extractStructureEvidence(SAMPLE_CANDLES);
 const ref=e.structures.find(x=>['HL','LL'].includes(x.type))!;
 a.tradeSetups[0].structureIds=[ref.id];a.tradeSetups[0].opportunityId=null;
 const raw=JSON.stringify(a),projected=projectAnalysisForCandles(a,SAMPLE_CANDLES,SAMPLE_CANDLES);
 expect(projected.tradeSetups.map(x=>x.id)).toContain(a.tradeSetups[0].id);
 const changed=SAMPLE_CANDLES.map(c=>({...c}));changed.find(c=>c.timestamp===ref.startTime)!.low-=.01;
 expect(projectAnalysisForCandles(a,changed,SAMPLE_CANDLES).tradeSetups.some(x=>x.id===a.tradeSetups[0].id)).toBe(false);
 expect(JSON.stringify(a)).toBe(raw);
 });
 it('hides a rule-cited plan when its pivot left-side confirmation context rolls out, even if the pivot itself remains',()=>{
 const a=createMockAnalysis(SAMPLE_CANDLES),e=extractStructureEvidence(SAMPLE_CANDLES);
 const ref=e.structures.find(x=>['HL','LL'].includes(x.type) && x.evidenceTimes[0]>SAMPLE_CANDLES[5].timestamp)!;
 a.tradeSetups[0].structureIds=[ref.id];a.tradeSetups[0].opportunityId=null;
 const cut=SAMPLE_CANDLES.findIndex(c=>c.timestamp===ref.evidenceTimes[0]);
 expect(cut).toBeGreaterThan(0);
 expect(projectAnalysisForCandles(a,SAMPLE_CANDLES.slice(cut-ref.scale),SAMPLE_CANDLES).tradeSetups.map(x=>x.id)).toContain(a.tradeSetups[0].id);
 expect(projectAnalysisForCandles(a,SAMPLE_CANDLES.slice(cut),SAMPLE_CANDLES).tradeSetups.map(x=>x.id)).not.toContain(a.tradeSetups[0].id);
 });
 it('does not silently promote an empty result into a trade',()=>{
 const a=research();a.tradeSetups=[];a.tradePlanning={status:'no-setup',reason:'等待确认，缺少目标空间'};a.research!.scenarios=[];
 expect(validateAnalysis(a,candles).tradeSetups).toEqual([]);
 });
});
