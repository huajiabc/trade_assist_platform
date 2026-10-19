# PA / SMC AI Trading Assistant MVP

本地运行的行情研究工作台：导入 CSV，用交互式 K 线图查看 PA/SMC 结构，并以经过校验的 JSON 连接 AI 分析。初始仓库为空，使用 React 19 + TypeScript + Vite、TradingView Lightweight Charts 5、Express 5。所有 K 线、区域与标注均由结构化数据通过代码绘制，没有生成式图片环节。

## 启动

需要 Node.js **22.12 或更高版本**（建议 Node.js 22 LTS）。在项目目录执行：

```powershell
npm install
npm run dev
```

浏览器打开 <http://127.0.0.1:5173>，默认自动连接 **SNDKUSDT 5 分钟真实行情**。Vite 将 `/api` 同源代理到 `127.0.0.1:3001`。连接等待或失败时显示空态与重试入口，绝不自动填入示例 K 线或模拟分析。公共行情不需要密钥；导入 CSV 仍可独立使用。

合成样例仅在「导入 CSV」面板手动选择，或明确打开 `/?demo=smc`、`/?demo=pa` 时载入，用于离线开发验收；日常入口不使用样例。`?live=标的&interval=周期` 优先于 `demo` 参数。只有手动点击「AI 分析」才调用模型，打开真实行情不会自动消耗 Codex/API 额度。

生产构建和本地运行：

```powershell
npm run build
npm start
```

此时打开 <http://127.0.0.1:3001>。`npm start` 由服务端托管 `dist/`，运行时使用 TypeScript 的 `tsx`，因此安装时需保留 devDependencies。请先构建，不使用 Vite preview 充当 API 服务。默认仅监听本机。

检查：

```powershell
npm test
npm run build
```

浏览器验收测试（首次先安装测试浏览器）：

```powershell
npx playwright install chromium
npm run test:e2e
```

如需使用已安装的 Google Chrome，可在 PowerShell 设置 `$env:PLAYWRIGHT_CHANNEL='chrome'` 后执行测试。浏览器测试覆盖导入、模拟分析、图层筛选、结构定位、无效响应拦截与手机布局。

## 使用 Codex 订阅额度分析

项目通过官方 `codex exec` 在本机服务端调用 Codex，复用 CLI 的 ChatGPT 登录。**ChatGPT 登录使用订阅额度；API Key 使用独立 API 账单**，两者不能混为一谈。依据：[OpenAI 身份验证文档](https://developers.openai.com/codex/auth/)、[非交互式调用与 JSON Schema](https://developers.openai.com/codex/noninteractive/)。项目固定安装官方 `@openai/codex` 运行时，不需要从浏览器传入凭据或读取、复制登录令牌。

在项目目录完成一次官方登录，然后启动：

```powershell
npx codex login
npm run dev
```

选择 ChatGPT 登录，网页「分析来源」选择 **Codex 额度**，载入 SNDKUSDT 实时行情后点击「AI 分析」。如果本机已经登录，直接使用即可。在「模型与设置」可以刷新登录状态。公开行情不需要交易所 Key；真实分析仍会消耗当前登录账号的 Codex 用量。

可选服务端设置：

```dotenv
AI_PROVIDER=auto
CODEX_BIN=
CODEX_MODEL=
CODEX_TIMEOUT_MS=180000
CODEX_PROXY_URL=
```

`CODEX_BIN` 留空自动使用项目安装的官方运行时，也可指定官方原生可执行文件的绝对路径（Windows 为 `codex.exe`，不接受 `.cmd`、`.ps1` 或命令字符串）。`CODEX_MODEL` 留空使用 CLI 内建默认模型；填写时必须是账号实际可用的模型 ID。每次分析启动临时的非交互会话，忽略用户 CLI 配置以隔离 MCP、工具和额外指令，不修改全局配置。最大等待 300 秒，默认 180 秒。

如果 Codex 网络需要代理，可设置 `CODEX_PROXY_URL=http://127.0.0.1:7890`（请改为自己的代理端口）。它仅设置 Codex 子进程的网络环境，不影响浏览器或独立 API 适配器，也不会自动复用行情代理。不要在代理 URL 中放入用户名或密码。

服务端在调用前确认 ChatGPT 登录，强制订阅登录方式并移除子进程中的 API Key 环境变量；Codex 错误不会切换到 API 或模拟结果。请求包含最近最多 **300 根已收盘 K 线**（CSV 按用户提供的完成数据处理）、上下文和 Schema。输出还需要通过 Zod、时间引用和价格坐标校验。图表按 JSON 精确绘制结构，界面展示来源、候选/确认状态、依据、失效条件和不确定性。返回的 token 用量为单次调用用量，**不是订阅余额或金额**。

只有手动点击分析才调用模型；WebSocket 更新价格不会触发付费分析。可以取消分析；关闭请求或切换数据时会中止对应子进程。单个服务实例同一时间只接受一次 Codex 分析，避免重复消耗。此桥接只面向个人本机使用，保留默认 `HOST=127.0.0.1`。

## 独立 API 模式配置

复制 `.env.example` 为 `.env`，在服务端文件中填写 API Key 与明确的模型 ID，然后重启开发服务：

```dotenv
AI_API_KEY=your_server_side_key
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4.1-mini
AI_RESPONSE_FORMAT=json_schema
AI_TIMEOUT_MS=45000
HOST=127.0.0.1
PORT=3001
```

`AI_MODEL` 是配置示例，需使用供应商账户实际有权限且支持所选格式的模型；没有隐式默认模型。`AI_BASE_URL` 为兼容 Chat Completions 的 API 基础路径，程序追加 `/chat/completions`。API Key 只从服务端环境变量读取，绝不使用 `VITE_` 前缀或发送给浏览器。`.env` 已被 Git 忽略。

默认发送 `response_format: {type: "json_schema", json_schema: {strict: true, ...}}`。供应商仅支持 JSON mode 时，可以显式改为 `AI_RESPONSE_FORMAT=json_object`；程序仍将完整 Schema 交给模型并在本地执行相同校验。程序不会在失败后自动切换响应格式。API 格式参考 [OpenAI Structured Outputs 官方文档](https://developers.openai.com/api/docs/guides/structured-outputs)。若供应商不支持 `max_completion_tokens` 或该接口，需要在 `server/provider.ts` 中实现独立适配器。

界面明确选择来源后，真实来源对应 `mode=ai`，模拟对应 `mode=mock`。HTTP 兼容模式：

- `auto`：按 `AI_PROVIDER` 选择；配置为 `auto` 时优先已登录的 Codex，再选择已配置的 API，否则模拟。网页始终发送用户选择的明确来源。
- `mock`：始终运行本地确定性模拟算法，适合验证图表与交互。
- `ai`：必须有所选来源的真实配置，否则明确报错。`provider=codex` 或 `provider=api` 可以明确指定，失败时不会切换来源。

真实调用遇到网络、超时、额度、拒绝、截断、无效 JSON 或坐标校验失败时显示错误，**不会伪装成成功或回退为模拟结果**。默认上游超时 45 秒。只向配置的供应商发送最近最多 **300 根 K 线**和用户填写的上下文；其余导入数据仅用于本地图表。没有配置真实密钥时，测试通过替身传输验证 API 协议，不能代表供应商连通性验证。

## 真实行情：SNDKUSDT

在界面「交易所行情」栏填写 `SNDKUSDT` 并点击「加载行情」，即可通过服务端读取 **Binance USD-M 的 SNDKUSDT 股票挂钩 USDT 永续合约**。这是交易所衍生品行情，价格与成交量口径均来自该合约，并非纳斯达克 SNDK 股票的直接报价，也不是现货币对。其他可用的 USDT 合约也可输入交易对后读取。此功能只使用公开行情接口，**无需交易所 API Key**，没有账户、余额或下单能力。

支持 `5m`、`15m`、`1h`、`4h`、`1d` 周期，默认最近 300 根，单次限 20–500 根。初次通过 REST 加载历史，再通过交易所 WebSocket 接收当前 K 线更新（交易所有更新时约 250 毫秒推送），经本地 SSE 推给浏览器。实时连接期间每 60 秒通过 REST 校正，断线期间每 30 秒同步历史并自动尝试重连；也可手动刷新或暂停。图表显示交易所尚未收盘的末根 K 线，但分析时排除该末根；结构结果对应其分析时的行情快照；已收盘行情变化后清除旧分析并提示重新分析，仅未收盘末根更新时保留已有分析。页面会显示来源、更新时间和连接状态。获取失败时保留已有画面并标为过期，不会自动替换成合成数据。

`GET /api/market/candles?symbol=SNDKUSDT&interval=1h&limit=300` 是本地只读接口。服务端调用固定的 Binance `/fapi/v1/klines` 和 `/fapi/v1/time`，使用交易所时钟判断末根收盘状态；校验 UTC 周期、严格递增时间、OHLC、成交量、数值和响应大小后才发送给前端。上游单次超时 10 秒，并设 5 秒有界内存缓存与相同请求合并。时间缺口和不足的历史不会补齐。接口格式见 [Binance USD-M 官方行情文档](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data)。

`GET /api/market/stream?symbol=SNDKUSDT&interval=1h` 为同源 `text/event-stream` 接口，事件为 `status`（连接状态）和 `kline`（通过校验的结构化 K 线）。上游使用当前 Binance `wss://fstream.binance.com/market/ws/sndkusdt@kline_1h`，详见 [Binance Kline WebSocket 官方文档](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/market#klinecandlestick-streams)。只有收到首条有效行情才显示已连接；15 秒无有效更新即标为过期并重连。畸形、错误标的/周期、错误时间边界、超过服务器时钟 60 秒及矛盾 OHLCV 均被拒绝；旧事件和重复事件不延长新鲜度。连接关闭后使用 1–15 秒有上限退避；网页断开即释放上游与定时器。每个服务实例最多 8 个实时页面，单帧上限 64 KB、慢客户端缓冲上限 256 KB。SSE 的 15 秒注释心跳只维持传输，不能证明价格仍在更新。订阅不包含逐笔成交、盘口或交易账户数据。

如果本机 Node.js 直连交易所不可用，可以在服务端 `.env` 配置 `MARKET_PROXY_URL=http://127.0.0.1:7890`，指向自己已有的 HTTP/HTTPS 代理，再重启服务。代理配置不会发到浏览器。交易所连接受到网络、服务可用性和上游限流影响，遇到错误时页面给出具体提示，不回退模拟行情。


可直接打开 <http://127.0.0.1:5173/?live=SNDKUSDT&interval=1h> 自动连接。浏览器外部连通性测试需显式设置 `LIVE_MARKET_SMOKE=1`；常规测试使用固定行情响应，不依赖交易所网络。可通过 `npx tsx --import dotenv/config node_modules/vitest/vitest.mjs run tests/realtime.test.ts` 在设置该变量后执行真实 WebSocket 验收（需在 25 秒内收到两条有效更新）；此命令读取服务端 `.env` 中的行情代理。无交易更新或上游不可达时会明确失败，不回退模拟数据。

## CSV 格式

必需列为 `timestamp,open,high,low,close,volume`，允许调换列序。可从界面下载完整示例 CSV。示例是用于演示的**合成数据**，不代表实时行情。

```csv
timestamp,open,high,low,close,volume
2026-10-10T00:00:00Z,100,103,99,102,1200
2026-10-10T01:00:00Z,102,104,101,103,1300
```

以上仅展示格式，完整文件至少需 10 行行情。支持带时区的 ISO 8601，以及 Unix 秒或毫秒；内部统一转换为 **UTC Unix 整秒**。无时区日期、非法日期、缺失值、非数值、重复/逆序时间、负成交量和矛盾 OHLC 会被拒绝，不会自动排序或补齐。时间间隔不一致时保留原始时间并提示。一次导入限 **10–2000 根**，服务端另有 **2 MB** 请求体限制。

## 使用

图表采用 TradingView 风格的深色背景、红绿蜡烛、独立成交量窗格。默认 PA 主视图，可切换 SMC 主视图或叠加查看。默认展示最近 110 根（窄屏约 65 根），滚轮缩放和拖拽平移；实时尾根使用图表增量更新，保持视窗。图表顶部支持快捷切换行情周期、重置近期视图和专注图表，专注状态按 Esc 退出。底部支持磁吸十字光标、对数价格和自动缩放；结构标签自动避让，锚点时间和价格保持原始坐标。

1. 打开页面自动加载 SNDKUSDT 5m，或切换交易对/周期、上传 CSV。在左侧「模型与设置」中填写可选分析上下文；CSV 周期由时间间隔推断，不进行重采样。
2. 选择 Codex 额度、API Key 或模拟，点击 AI 分析。当前来源和调用用量会在结果处明确展示。
3. 图表支持缩放、平移与十字光标。PA 采用触点色带、箱体、推进回撤带、形态烛线框及突破阶段路径；SMC 保留摆点、破位事件与 FVG/OB 区域。
4. 使用结构类型开关显示/隐藏标注；点击分析结构可定位相应 K 线并高亮。候选与确认结构使用不同样式，面板展示依据、失效条件、不确定性与机会风险。

“已确认”仅表示在当前数据内符合所用结构规则，不保证未来走势。摆动点确认需要右侧 K 线，存在确认延迟。模拟算法采用简化规则，只用于演示数据链路与标注交互，不是完整交易策略；AI 结果也必须由使用者复核。

## PA 分析与可视化

PA 与 SMC 是可独立显示的证据层。PA 面板先描述上行、下行、区间或转换状态，再展示下列对象；点击任意条目会开启相应图层并定位到证据 K 线。

| PA 对象 | 图表表达 | 数据校验 |
| --- | --- | --- |
| 支撑、阻力、震荡区间 | 有边界的填充色带或箱体、真实触点 | 时间、价格与触及记录在输入窗口内；确认支撑阻力需重复触及，区间需上下两侧重复触及 |
| 推进、回撤 | 方向带、箭头与端点 | 起止 K 线存在、时间有序、端点匹配实际高低价、方向与价格一致 |
| Pin bar、吞没、内包 | 对应单根或双根 K 线高亮框 | 根据原始 OHLC 验证主影比例、相邻反色实体包含或严格内包 |
| 突破与回踩 | 突破、回踩、确认的阶段编号与路径 | 引用先前形成的价区；收盘越界、后续触及边界、确认收盘站稳均需实际证据 |

导入面板中的「PA 教学示例」或明确的 `/?demo=pa` 载入 `shared/paSample.ts` 生成的 120 根合成行情，包含重复区间边界、突破回踩及明确的蜡烛形态。可下载 `public/pa-example.csv` 再导入体验；它不是历史或实时价格，不在默认工作台自动载入。原 BTC 合成示例仍可在导入面板或 `/?demo=smc` 使用。所有模拟分析都从当前输入行情计算几何，不向无形态的行情强加标签。

本项目采用明确且保守的 MVP 规则，并不声称 PA 存在统一的形态阈值。Pin bar 主要影线至少占全幅 60%、至少为实体两倍，反向影线不超过 25%、实体不超过 35%；吞没要求相邻反色实体严格包含；内包要求当前高低均严格位于母线之内。区间/支撑阻力使用重复触及证据，不等于已经证明未来有效。概念参考 [Fidelity 的支撑阻力说明](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/support-and-resistance?print=true-0)。原生标注使用 [Lightweight Charts series primitives](https://tradingview.github.io/lightweight-charts/docs/plugins/series-primitives)，随图表缩放、平移及价格坐标转换重新绘制。

Schema **1.2** 增加必需的 `priceAction` 对象，其中包含 `regime`、`summary`、`zones`、`legs`、`patterns`、`breakouts`。没有证据的数组应为空，模型不必补齐类型。严格旧版 1.0/1.1 结果迁移为空 PA 层，不从旧文字推断图形。机会与数值计划可引用 PA 或 SMC 的 ID；同样执行时间、价格和引用校验。真实 Codex/API 与模拟使用同一 Schema。

已确认的形态表示输入数据支持该形态；推进/回撤及市场状态仍是分析判断。任何未来开仓情景始终为候选。当前尚未实现完整 Brooks PA 体系、楔形/双顶双底等全部形态、通道拟合、多周期共振、逐根回放或策略回测。

## 开仓候选、盈亏区域与流动性扫除

在图表「开仓候选 / 盈亏区间」和「流动性扫除」开关中独立控制新图层。在「潜在观察计划」选择数值计划，可定位参考入场标记及红色风险区、绿色收益区；多个目标分别显示 TP1–TP3 和对应 R 倍数。同一时刻只绘制一份选中的数值计划，保持 K 线清晰。在「流动性扫除」点击记录，可定位参考摆动与扫除影线，查看识别依据和失效条件。

- **开仓候选**：参考入场价、计划止损与目标均为有条件的研究假设，状态始终为 `candidate`，不表示成交或订单。时间锚点必须等于本次输入最后一根 K 线；真实行情使用最后一根已收盘数据。图形向右的宽度只是展示空间，不是预测的开仓时间，也不生成未来 K 线。
- **盈亏比**：`R = 目标收益价格距离 / 止损风险价格距离`，例如 `2R` 表示风险∶收益为 `1∶2`。多头使用 `(目标−入场)/(入场−止损)`，空头使用 `(入场−目标)/(止损−入场)`，与 [TradingView 多空头绘图工具的公式](https://www.tradingview.com/support/solutions/43000475660-how-to-use-long-and-short-position-drawing-tools/)一致。多目标分别计算；对数价格轴下仍按真实价格计算，不使用屏幕高度计算。未计入手续费、点差、滑点、资金费用；没有持仓数量，因此不显示账户实际盈亏或胜率。
- **流动性扫除**：这是基于 OHLC 的价格行为代理。买方参考已确认摆动高点，要求后续 high 严格越过该价；卖方参考已确认摆动低点，要求后续 low 严格越过该价。只有该根收盘返回参考价内侧才标为已确认形态，否则为候选。参考摆动需要左右各 2 根确认，且参考点确认后到本次扫除前不能已有收盘突破。标记精确使用原始 high/low 与时间；它不证明存在或成交了实际止损单，也不等同于订单簿流动性数据。

Schema 1.1 起包含必需的 `tradeSetups` 与 `liquiditySweeps` 数组，1.2 继续保留。没有足够证据时允许为空。旧版 1.0 结果可读取并迁移为空数组，界面会提示重新分析以获取新字段，不从文字中推测入场和止损价格。多空价格顺序、非零风险距离、有限盈亏比、目标递进顺序、引用 ID、真实扫除坐标与收盘证据都会在服务端与前端校验；无效输出拒绝渲染。

内置合成示例不需要模型额度，包含候选计划与可核验的扫除案例。选择 Codex 或 API 后，仍只有点击「AI 分析」才调用模型。升级图层本身不触发自动分析。

## 分层与扩展

- `shared/market.ts`：OHLCV 类型、CSV 解析、数值/时间/缺失值校验和长度限制。
- `shared/liveMarket.ts`：行情请求/响应合同、周期与末根收盘状态校验、分析窗口选择。
- `shared/realtime.ts`：实时事件合同、重复/逆序事件过滤、历史窗口合并与缺口检测。
- `shared/analysis.ts`：Zod 结构合同、由同一合同生成的 JSON Schema、引用与坐标校验。
- `shared/priceAction.ts`：PA 对象合同、实际 OHLC 形态与区域/事件校验、确定性 PA 分析。
- `shared/paSample.ts`：可重复的 PA 教学行情，与原有合成样例分开维护。
- `shared/tradeGeometry.ts`：多空方向一致的真实价格风险、收益、R 倍数与百分比计算。
- `shared/mock.ts`：可重复的离线结构演示。
- `server/provider.ts`：独立的 `AnalysisProvider` 适配接口和 OpenAI-compatible 实现。保留 `ScreenshotInput` 类型边界；当前 HTTP 路由仅接受行情与上下文，不接收或上传截图。
- `server/codex.ts`：官方本机 Codex 运行时适配、ChatGPT 登录探测、Schema 输出、用量记录、超时与取消；不会导出或读取登录令牌。
- `server/market.ts`：独立 `MarketDataProvider` 与 Binance 公共行情适配器、超时、大小限制及短缓存；`server/network.ts` 隔离可选服务端代理。
- `server/realtime.ts`：独立 `RealtimeMarketProvider`、Binance WebSocket 适配器和同源 SSE 桥接、有效行情超时、重连与资源释放。
- `server/app.ts`：严格请求校验、窗口裁剪、分析及响应校验、安全错误与前端静态文件托管。
- `src/`：界面和代码绘制的交互式图表，不包含 API Key。
- `src/chart/TradeOverlay.ts` 与 `tradeCoordinates.ts`：开仓参考、风险收益区域、扫除影线的原生图表绘制与坐标映射。
- `src/chart/PriceActionOverlay.ts` 与 `priceActionCoordinates.ts`：PA 色带、方向带、烛线框、阶段路径和坐标映射。
- `tests/`：行情校验、分析 JSON/坐标映射、服务端模式与窗口、替身模型服务错误等测试。

分析 Schema 覆盖 `schemaVersion`、`trend`、`bias`、`summary`、`priceAction`、`structures`、`keyLevels`、`opportunities`、`tradeSetups`、`liquiditySweeps`、`uncertainties`。结构带类型、候选/确认状态、方向、起止 UTC 时间、价位边界、识别依据与失效条件；机会和数值计划通过 ID 引用结构。任何 Schema 或坐标校验未通过的模型输出都不会发送为成功结果或渲染为标注。

## MVP 边界

已实现 CSV 导入、示例数据、Binance USDT 永续公共行情、WebSocket 实时 K 线订阅与断线同步、交互图表、结构覆盖/筛选/定位、离线模拟、服务端真实模型适配与校验。尚未实现逐笔成交/盘口订阅、截图视觉分析、数据库持久化、多用户认证、回测与交易绩效评估。当前面向个人本地使用，公开部署前需要独立增加认证、用户级限流和运维配置。没有 ImageGen、交易账户接入、自动下单或收益承诺。
