import { accountStatusSchema } from '../../shared/account';
import { positionReviewResponseSchema } from '../../shared/positionManagement';
import type { WorkbenchModelContext } from '../../shared/workbenchAnalysis';
import type { AnalysisInputMode, ChartImage } from '../../shared/analysisInput';
import { RESEARCH_FRAMES } from '../../shared/researchData';
import { frameInput } from './workbench';
import { readResponse, type AnalysisSource } from './api';
export async function accountRequest(action:'status'|'connect'|'refresh'|'disconnect',signal:AbortSignal){
 return accountStatusSchema.parse(await readResponse(await fetch('/api/account/'+action,{method:action==='status'?'GET':'POST',...(action==='status'?{}:{headers:{'Content-Type':'application/json'},body:'{}'}),signal})));
}
export async function requestPositionReview(context:WorkbenchModelContext,positionId:string,accountSnapshotId:string,linkedPlanId:string|null,source:AnalysisSource,notes:string,visual:{inputMode:AnalysisInputMode;images:ChartImage[]},signal:AbortSignal){
 const result=positionReviewResponseSchema.parse(await readResponse(await fetch('/api/account/review',{method:'POST',headers:{'Content-Type':'application/json'},signal,body:JSON.stringify({positionId,accountSnapshotId,linkedPlanId,research:{bundle:{symbol:context.bundle.symbol,asOf:context.bundle.asOf,frames:RESEARCH_FRAMES.map(tf=>frameInput(context.bundle.frames[tf]))},previous:context.previous,planPolicy:context.planPolicy,provider:source,notes,reviewDepth:'deep',...visual}})})));
 if(result.positionId!==positionId||result.accountSnapshotId!==accountSnapshotId||result.marketSnapshotId!==context.bundle.id||result.stateVersion!==context.previous.version||result.linkedPlanId!==linkedPlanId||result.provider!==source)throw new Error('持仓审阅响应与请求快照、状态版本、计划或来源不一致。');return result;
}
