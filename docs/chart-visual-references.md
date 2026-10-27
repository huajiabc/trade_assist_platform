# 图表视觉参考与实现边界

本轮沿用已有 Lightweight Charts v5、原生 primitive、坐标映射和标签避让，没有增加绘图依赖或替换指标算法。所有图形仍由实际时间/价格生成。

## 开源参考

- [TradingView 官方 rectangle drawing tool](https://github.com/tradingview/lightweight-charts/blob/c9ec1cec25583a0200f3c85ad9019d19c1d65f97/plugin-examples/src/plugins/rectangle-drawing-tool/rectangle-drawing-tool.ts)：参考背景区域与前景文字分层、使用原生价格/时间坐标的实现。
- [TradingView 官方 trend line](https://github.com/tradingview/lightweight-charts/blob/c9ec1cec25583a0200f3c85ad9019d19c1d65f97/plugin-examples/src/plugins/trend-line/trend-line.ts) 和 [positions helper](https://github.com/tradingview/lightweight-charts/blob/c9ec1cec25583a0200f3c85ad9019d19c1d65f97/packages/lwc-toolkit/src/dimensions/positions.ts)：参考设备像素对齐；`drawingStyle.ts` 在现有 media coordinate renderer 中实现像素中心对齐，并将绘制偏移限制在半个设备像素内，不修改原始数据或命中坐标。
  - 官方仓库采用 [Apache-2.0](https://github.com/tradingview/lightweight-charts/blob/c9ec1cec25583a0200f3c85ad9019d19c1d65f97/LICENSE)。继续保留库的 TradingView attribution。
- [deepentropy/lightweight-charts-drawing](https://github.com/deepentropy/lightweight-charts-drawing/tree/0291d9c7373e3795373c915a3a64f4f663b5a0db)，尤其 [rectangle text layout](https://github.com/deepentropy/lightweight-charts-drawing/blob/0291d9c7373e3795373c915a3a64f4f663b5a0db/src/core/kinds/rectangle-text.ts)：参考矩形内部居中、文字不越界和选中时强调的样式。采用 [MIT](https://github.com/deepentropy/lightweight-charts-drawing/blob/0291d9c7373e3795373c915a3a64f4f663b5a0db/LICENSE)；未复制该库源码或打包其工具管理器。
- [Quantum Algo SMC indicator](https://github.com/quantumalgo-official/smart-money-concepts-indicator)：查看其 SMC 结构线、局部/主结构层次和区域生命周期样式，采用 [MIT](https://github.com/quantumalgo-official/smart-money-concepts-indicator/blob/main/LICENSE)。未移植其识别、打分、目标算法，也未采用其无限延伸或删除历史证据的行为。

## 本项目的视觉约束

- 交互图与干净的 AI 截图共用 `chartTheme.ts`；截图仍不含既有 AI 标注，防止反馈污染。
- BOS / CHoCH 为细线，居中的文字占用一个小间隙；高低点文本避开实体。选中时才显示确认 K 线、连接线和强调底色。
- 趋势腿在默认缩放下保留原始路径；百分比文字在放大或选中后显示，不删除分析结果。
- FVG / OB 保留此前约定：无描边、框内小字、最多延伸五根实际 K 线；形成之前不涂色，回补或失效后低调显示。
- 真实持仓与建议的价格、颜色来源和实/虚线区别不变。
- 没有新增模型调用；默认行情来源仍为真实行情。
