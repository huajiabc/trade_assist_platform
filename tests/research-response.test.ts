import {afterEach,describe,expect,it,vi} from 'vitest';
import {requestResearch} from '../src/services/workbench';
import {modelContext,updateMarketState} from '../shared/marketState';
import {localWorkbenchInterpretation,type WorkbenchModelContext} from '../shared/workbenchAnalysis';
import {researchBundle} from './research-fixtures';
const context=()=>modelContext(updateMarketState(null,researchBundle()));
function response(c:WorkbenchModelContext,catalogVersion:string|undefined=c.catalogVersion){return {schemaVersion:'research-response-1.0',catalogVersion,snapshotId:c.bundle.id,stateVersion:c.previous.version,source:'mock',provider:'mock',model:'controlled-local-fixture',generatedAt:'2026-10-22T00:00:00.000Z',analysisAttempts:0,analysis:localWorkbenchInterpretation(c)};}
function controlledFetch(body:unknown){const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}}));vi.stubGlobal('fetch',fetcher);return fetcher;}
afterEach(()=>vi.unstubAllGlobals());
describe('research response provenance in the client (injected fetch only)',()=>{
 it('accepts the captured catalog and forwards the exact data and prior-state context',async()=>{
  const c=context(),before=structuredClone(c),fetcher=controlledFetch(response(c));
  const result=await requestResearch(c,'mock','受控请求',new AbortController().signal);
  expect(result.catalogVersion).toBe(c.catalogVersion);expect(result.snapshotId).toBe(c.bundle.id);expect(fetcher).toHaveBeenCalledOnce();
  const sent=JSON.parse(fetcher.mock.calls[0][1]!.body as string);expect(sent.bundle.frames).toHaveLength(3);expect(sent.previous).toEqual(c.previous);expect(sent.planPolicy).toEqual(c.planPolicy);expect(c).toEqual(before);
 });
 it('rejects a changed strategy catalog before applying an otherwise valid interpretation',async()=>{
  const c=context(),before=structuredClone(c),fetcher=controlledFetch(response(c,'catalog-different'));
  await expect(requestResearch(c,'mock','',new AbortController().signal)).rejects.toThrow(/策略目录已更新/);
  expect(fetcher).toHaveBeenCalledOnce();expect(c).toEqual(before);
 });
 it('continues to read a legacy response without catalog metadata',async()=>{
  const c=context(),body=response(c);body.catalogVersion=undefined;controlledFetch(body);
  const result=await requestResearch(c,'mock','',new AbortController().signal);expect(result.catalogVersion).toBeUndefined();expect(result.analysis).toEqual(body.analysis);
 });
 it('still rejects mismatched snapshot and state provenance when the catalog matches',async()=>{
  const c=context(),body=response(c);controlledFetch({...body,stateVersion:c.previous.version+1});
  await expect(requestResearch(c,'mock','',new AbortController().signal)).rejects.toThrow(/状态版本或来源不一致/);
 });
});
