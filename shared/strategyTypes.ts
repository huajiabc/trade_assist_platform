export const STRATEGY_IDS=['sweep-reclaim','bos-retest','trend-pullback','range-reversal','failed-breakout','displacement-continuation'] as const;
export type StrategyId=typeof STRATEGY_IDS[number];
export const STRATEGY_NAMES:Record<StrategyId,string>={
 'sweep-reclaim':'A · 流动性扫除与结构收复','bos-retest':'B · BOS突破与回踩延续','trend-pullback':'C · 趋势回撤与FVG/OB',
 'range-reversal':'D · 震荡区间边缘反转','failed-breakout':'E · 失败突破与CHoCH反转','displacement-continuation':'F · 强位移与延续交易',
};
export const strategyName=(id:StrategyId|null|undefined)=>id?STRATEGY_NAMES[id]:'旧版 / 未归类计划';
