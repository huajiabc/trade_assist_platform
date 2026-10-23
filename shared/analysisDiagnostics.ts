import { z } from 'zod';
const ms=z.number().int().nonnegative();
export const analysisDiagnosticsSchema=z.object({requestId:z.string(),inputMode:z.enum(['data','hybrid']),elapsedMs:ms,providerMs:ms,validationMs:ms,attempts:z.number().int().min(0).max(2),inputBytes:ms,imageCount:z.number().int().min(0).max(3),imageBytes:ms}).strict();
export type AnalysisDiagnostics=z.infer<typeof analysisDiagnosticsSchema>;
