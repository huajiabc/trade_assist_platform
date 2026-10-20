import {describe,it,expect,vi} from 'vitest';
import type {SeriesAttachedParameter,IPrimitivePaneRenderer} from 'lightweight-charts';
import {StructureOverlay,type ChartStructure} from '../src/chart/StructureOverlay';
const items:ChartStructure[]=Array.from({length:16},(_,i)=>({id:'s-'+i,type:i%2?'HH':'HL',status:'confirmed',direction:'bullish',startTime:100+i*60,endTime:100+i*60,price:i%2?100:80,priceEnd:null,rationale:'证据',invalidation:'失效',importance:i%4===0?'major':'local'}));
function harness(spacing:number){
 const ctx={save:vi.fn(),restore:vi.fn(),beginPath:vi.fn(),rect:vi.fn(),clip:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),stroke:vi.fn(),arc:vi.fn(),fill:vi.fn(),setLineDash:vi.fn(),fillRect:vi.fn(),fillText:vi.fn(),measureText:vi.fn((s:string)=>({width:s.length*5}))};
 const overlay=new StructureOverlay();
 overlay.attached({chart:{timeScale:()=>({options:()=>({barSpacing:spacing}),timeToCoordinate:(t:number)=>20+(t-100)/60*45})},series:{priceToCoordinate:(p:number)=>400-p*2},requestUpdate:vi.fn()} as unknown as SeriesAttachedParameter);
 const target={useMediaCoordinateSpace:(draw:(scope:unknown)=>void)=>draw({context:ctx,mediaSize:{width:800,height:400}})} as unknown as Parameters<IPrimitivePaneRenderer['draw']>[0];
 const draw=()=>overlay.paneViews().find(v=>v.zOrder?.()==='top')!.renderer()!.draw(target);
 return {overlay,ctx,draw};
}
describe('native structure label density and exact selection',()=>{
 it('overview hides local detail but preserves raw data and selected anchor/hit geometry',()=>{
 const raw=JSON.stringify(items),overview=harness(2),detail=harness(12);
 overview.overlay.setData(items,null);overview.draw();detail.overlay.setData(items,null);detail.draw();
 expect(overview.ctx.fillText.mock.calls.length).toBe(4);
 const label=overview.ctx.fillText.mock.calls[0];expect(overview.overlay.hitTest(label[1],label[2])?.externalId).toBe('s-12');expect(detail.ctx.fillText.mock.calls.length).toBeGreaterThan(4);
 const local=items[1];expect(overview.overlay.hitTest(65,200)).toBeNull();
 overview.ctx.fillText.mockClear();overview.overlay.setData(items,local.id);overview.draw();
 expect(overview.ctx.fillText).toHaveBeenCalledWith('HH',expect.any(Number),expect.any(Number));
 expect(overview.overlay.hitTest(65,200)?.externalId).toBe(local.id);expect(JSON.stringify(items)).toBe(raw);
 });
});
