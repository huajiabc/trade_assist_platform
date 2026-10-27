import type { PositionChartModel } from '../../shared/positionChart';
export function mapPositionAreas(model:PositionChartModel,priceToY:(price:number)=>number|null,viewport:{width:number;height:number}){
 if(model.stale||viewport.width<=0||viewport.height<=0)return [];
 return model.areas.flatMap(area=>{const y1=priceToY(area.from),y2=priceToY(area.to);if(y1===null||y2===null||!Number.isFinite(y1)||!Number.isFinite(y2))return [];
  const top=Math.max(0,Math.min(y1,y2)),bottom=Math.min(viewport.height,Math.max(y1,y2));if(bottom<=top)return [];
  return [{...area,left:viewport.width*(area.source==='exchange'?.48:.73),width:viewport.width*.22,top,height:bottom-top}];
 });
}
