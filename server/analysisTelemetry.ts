import { mkdir,stat,rename,appendFile } from 'node:fs/promises';
import path from 'node:path';
import type { AnalysisDiagnostics } from '../shared/analysisDiagnostics';
let queue=Promise.resolve(),pending=0;
/** Bounded local metadata only: never prompt, image data, output text, credentials or private provider errors. */
export function recordAnalysisTelemetry(diagnostics:AnalysisDiagnostics,details:{provider:'codex'|'api';kind:'single'|'multi';outcome:'success'|'error';model:string|null;errorCode:string|null;validationCategory:string|null}){
 if(process.env.NODE_ENV==='test'||pending>=8)return;pending++;
 queue=queue.then(async()=>{const dir=path.resolve('artifacts'),file=path.join(dir,'analysis-telemetry.jsonl');await mkdir(dir,{recursive:true});const size=await stat(file).then(s=>s.size,()=>0);if(size>=1024*1024)await rename(file,path.join(dir,'analysis-telemetry.previous.jsonl'));await appendFile(file,JSON.stringify({at:new Date().toISOString(),...diagnostics,...details})+'\n','utf8');}).catch(()=>{ /* Diagnostics must never fail an analysis. */ }).finally(()=>{pending--;});
}
