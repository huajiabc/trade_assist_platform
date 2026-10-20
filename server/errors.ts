export interface AnalysisTimeoutDetails {
  stage: 'initial-response' | 'correction-response' | 'result-validation';
  attempts: number; completedModelCalls: number; budgetMs: number; elapsedMs: number;
  firstResponseMs: number | null;
  validationCategory: 'schema' | 'references' | 'trade-plan' | 'price-action' | 'coordinates' | 'other' | null;
}

/** Only these deliberately public messages may cross the HTTP boundary. */
export class PublicError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: AnalysisTimeoutDetails,
  ) {
    super(message);
    this.name = 'PublicError';
  }
}

export const invalidModelOutput = () => new PublicError(
  502,
  'PROVIDER_INVALID_OUTPUT',
  '模型结果未通过结构或坐标校验，已拒绝渲染。请重试或更换模型。',
);
