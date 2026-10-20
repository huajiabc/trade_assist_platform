import {describe,it,expect} from 'vitest';
import {ChartLabelRegistry,labelDensity,placeLabel,type LabelBox} from '../src/chart/labelLayout';
import {chartStructureProjection,chartLegProjection,ALL_CHART_LAYERS} from '../src/chart/layers';
import type {ChartStructure} from '../src/chart/StructureOverlay';
describe('adaptive native-overlay labels',()=>{
 it('preserves selected ownership for co-located rule and AI legs',()=>{
  const rule={id:'rule-leg',startTime:10,endTime:20,startPrice:100,endPrice:120},ai={...rule,id:'ai-leg'};
  expect(chartLegProjection([rule,ai],null)).toEqual([ai]);expect(chartLegProjection([rule,ai],rule.id)).toEqual([rule]);
 });
 it('allocates by zoom and pane width, preserving primary labels at overview',()=>{
 const overview=labelDensity(2,800),detail=labelDensity(12,800);
 expect(overview).toMatchObject({mode:'overview',auxiliary:0,showLocal:false});
 expect(overview.main).toBeGreaterThan(0);expect(detail.main).toBeGreaterThan(overview.main);expect(labelDensity(12,400).main).toBeLessThan(detail.main);
 });
 it('tries other lanes, stays in bounds, avoids candle bodies and suppresses secondary text when full',()=>{
 const occupied:LabelBox[]=[],view={width:300,height:200}, preferred={left:280,top:-5,width:60,height:14};
 const first=placeLabel(preferred,view,occupied)!; const second=placeLabel(preferred,view,occupied)!;
 expect(first.left+first.width).toBeLessThanOrEqual(298);expect(first.top).toBeGreaterThanOrEqual(2);expect(second).not.toEqual(first);
 const obstacle={left:0,top:0,width:300,height:200};expect(placeLabel(preferred,view,[],false,[obstacle])).toBeNull();
 const selected=placeLabel(preferred,view,[],true,[obstacle])!;expect(selected).not.toBeNull();expect(selected.top).toBeGreaterThanOrEqual(2);
 });
 it('shares high-priority occupancy across renderers and clears last-frame reservations',()=>{
 const r=new ChartLabelRegistry(),main=r.begin('structures',0),box={left:10,top:10,width:50,height:14};main.push(box);r.commit('structures',main,0);
 const pa=r.begin('pa',2);expect(pa).toEqual([box]);const inherited=pa.length;pa.push({...box,top:40});r.commit('pa',pa,inherited);
 expect(r.begin('indicators',3)).toHaveLength(2);expect(r.begin('structures',0)).toEqual([]);expect(r.begin('pa',2)).toEqual([]);
 });
 it('toggles layers and co-located label ownership without mutating or deleting stored evidence',()=>{
 const point:ChartStructure={id:'local',type:'HH',status:'confirmed',direction:'bullish',startTime:10,endTime:10,price:100,priceEnd:null,rationale:'test',invalidation:'test',importance:'local'};
 const source=[point,{...point,id:'major',importance:'major' as const},{...point,id:'zone',type:'FVG' as const,endTime:20,priceEnd:102}];const raw=JSON.stringify(source);
 expect(chartStructureProjection(source,ALL_CHART_LAYERS,null).map(x=>x.id)).toEqual(['major','zone']);
 expect(chartStructureProjection(source,ALL_CHART_LAYERS,'local').map(x=>x.id)).toContain('local');
 expect(chartStructureProjection(source,{primary:false,evidence:true,plans:false},null).map(x=>x.id)).toEqual(['zone']);
 expect(chartStructureProjection(source,{primary:true,evidence:false,plans:true},null).map(x=>x.id)).toEqual(['major']);expect(JSON.stringify(source)).toBe(raw);
 });
});
