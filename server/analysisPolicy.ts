import { validateAnalysis } from '../shared/analysis';
import { auditPlanScale } from '../shared/planPolicy';
import type { ModelInput } from './provider';
export function validateFreshAnalysis(raw:unknown,input:ModelInput){
 const result=validateAnalysis(raw,input.candles);if(!input.planPolicy)return result;
 for(const plan of result.tradeSetups){if(!plan.strategyId)throw new Error('新数值计划必须明确A–F策略归类；证据不足时返回等待，不提供未归类推荐。');const audit=auditPlanScale(plan,input.candles,input.planPolicy);if(audit.errors.length)throw new Error(audit.errors.join(' '));}
 return result;
}
