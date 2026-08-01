# 开发规范与踩坑记录

本文是日常开发必须遵守的规范。目标是减少重复踩坑，提高构建速度、调试效率、质量和维护性。

## 1. 文档维护

- `README.md` 面向 GitHub 访客，说明产品能力、架构和开发入口。
- `PRODUCT.md` 维护稳定的产品定位、边界与核心原则。
- 本文只记录跨任务可复用的工程规范和踩坑经验。
- 本地规划、完成项台账与内部规格不提交到 GitHub，也不能成为构建或协作流程的硬依赖。
- 完成功能后仅在用户可见行为、稳定约束或通用工程经验发生变化时更新对应公开文档。
- 不要把 API Key、Secret、Passphrase、AI Key 写入 Markdown。

## 2. 构建与启动

- 日常启动使用：

```powershell
npm run tauri:dev
```

- `npm run tauri:dev` 会长期运行，不会自动退出。桌面窗口起来后，终端继续挂着是正常现象。
- 如果 1420 端口被占用，先执行：

```powershell
node scripts/kill-dev-port.mjs
```

- `scripts/start-dev-ready.mjs` 必须保持 Node 直接 spawn Vite，不要再用 PowerShell `Start-Process` 中转。之前中转方式出现过 Vite 实际已启动但 ready 检测失败的问题。
- dev ready 日志使用每次独立文件名，避免 Windows 上旧 Vite 进程占用 `vite-dev.stdout.log` 导致 `EBUSY`。
- `scripts/kill-dev-port.mjs` 必须保持跨平台：Windows 只清理匹配 workspace/Vite 的进程树，macOS 只清理匹配 workspace/Vite 的监听进程，禁止按端口无条件杀死其它应用。
- Debug 模式继续使用项目内 `config/cache/logs/diagnostics/.cline`，兼容现有 Windows 开发数据；Release 模式必须使用 Tauri `app_config_dir/app_cache_dir/app_log_dir/app_data_dir`，禁止把 `CARGO_MANIFEST_DIR` 当安装后的可写目录。
- Release AI sidecar 必须通过 `npm run prepare:sidecar` 生成：Cline SDK 打成单文件，Node 版本固定并校验官方 SHA-256；生成目录 `src-tauri/resources/ai-sidecar` 不提交二进制。修改 sidecar 后至少验证包内运行时能返回 `ready` 和 `core-ready` 且无 error 事件。
- Windows 安装目录可能包含空格。启动随包 Node 时必须把 `ai-sidecar` 设为进程启动目录并使用相对入口 `sidecar.mjs`，再通过 `DESIC_SIDECAR_WORK_DIR` 切换业务工作目录；禁止直接把带空格的绝对脚本路径作为 Node 入口。Release 构建必须运行 `npm run smoke:ai-packaged-ready`，真实启动随包 Node 并等待 `core-ready`。
- Windows NSIS 正式产物使用 `npm run tauri:build -- --bundles nsis`。构建后必须同时检查命令退出码、日志中是否出现 `failed to bundle project`、目标 EXE 是否存在及其 SHA-256；不能只依据 Tauri 输出的 `Built application at` 判断成功。
- Windows 构建机系统盘或 `%TEMP%` 空间不足时，NSIS 可能以 `error creating mmap` 失败。可以把 `TEMP`、`TMP` 与 `CARGO_TARGET_DIR` 指向有足够空间的本地磁盘；这些临时 target、安装包、哈希和签名文件均属于构建产物，不提交到 Git。
- Debug NSIS 只能用于本地安装验证，不得作为正式 Release。正式对外产物必须使用 Cargo Release、完成 Authenticode 签名，并在干净用户环境验证安装、升级、卸载、WebView2、本地敏感配置及包内 sidecar。
- Rust smoke binary 源码必须留在 `src-tauri/crates/smoke-tools/src/bin`，不能放回主 crate 的 `src/bin`，否则 Tauri bundler 会把 smoke binary 误识别为应用附件。
- Rust 已改为 workspace：
  - `desic-storage-config`
  - `desic-private-history`
  - `desic-trade-domain`
  - `desic-terminal`
- 同 crate 内 `mod` 拆分只能改善维护性和局部增量，真正构建缓存收益要靠 crate 级拆分。
- 主 Tauri crate 不应该继续无限膨胀。新增纯领域逻辑、纯类型、纯 SQL row mapper 时，优先放入对应 crate。
- 每次 Rust 结构调整后至少跑：

```powershell
cargo check --manifest-path src-tauri/Cargo.toml --workspace
```

- 每次前端行为调整后至少跑：

```powershell
npm run build
```

## 3. 前端日志与通知中心

- 禁止只用零散 `console.log` 调试关键链路，必须走 `src/lib/logger.ts`。
- `logger` 在前端内存中保留 `time` 字段，但发给 Tauri `frontend_log` command 时必须转换为毫秒级 `timestamp` 字段。
- 已踩坑：后端 `FrontendLogEntry` 要求 `timestamp`，前端直接传 `{ time }` 会触发：

```text
invalid args `entry` for command `frontend_log`: missing field `timestamp`
```

- 修复方式：调用 `frontend_log` 时传：

```ts
{
  level,
  message,
  error,
  context,
  timestamp: Date.parse(time) || Date.now()
}
```

- 每次桌面调试后必须打开通知中心，检查：
  - 前端代码异常。
  - Tauri command failed。
  - OKX REST / WSS 失败。
  - AI sidecar 错误。
  - K 线同步异常。
  - 交易审计失败。
- 不能只看终端没有编译错误就认为功能正常。
- 配置摘要、首次启动资源和可选工作区的“不存在”应建模为未配置、`null` 或空列表，不得通过 `invokeOptional` 记录成代码异常。需要引导用户配置时，应发送简短、可点击且能直达对应配置 Tab 的业务通知。

## 4. Tauri / HMR 注意事项

- Windows 上通过 Tauri command 动态创建 `WebviewWindow` 时，创建 command 必须使用 `async fn`，避免同步 IPC 在 `WebviewWindowBuilder::build()` 期间阻塞，表现为原生窗口已出现但 WebView 永久停在 `about:blank`。
- 动态应用窗口应使用精确的 `WebviewUrl::App("index.html".into())`，窗口业务 ID 通过 `chart-*` 等 label 传递；不要把 query 拼进 `WebviewUrl::App` 的路径。开发态和打包态都交给 Tauri 解析应用 URL。

- 开发模式下出现下面 warning 通常不是业务失败：

```text
[TAURI] Couldn't find callback id ... This might happen when the app is reloaded while Rust is running an asynchronous operation.
```

- 原因：前端 HMR 或页面 reload 后，旧的 async invoke 还在 Rust 侧运行，返回时 JS callback 已失效。
- 处理规则：
  - 如果只在 reload 附近出现，且通知中心没有对应 command failed，可记录为开发态噪音。
  - 如果非 reload 场景持续出现，必须查找是否有长任务 invoke 没有取消、重复启动或组件卸载后仍更新状态。
- 长耗时 invoke 应在前端侧做 mounted / abort / stale request guard。
- Tauri 2.11 的 event `unlisten` 实际返回 Promise；HMR/reload 可能先清空 WebView 监听表，使注销访问缺失的 `eventId`。统一监听封装必须让缺失监听幂等，并捕获异步注销失败，不能直接忽略返回值形成 `unhandledrejection`。
- 图表工作区首次加载存在“读取后延迟保存”的初始化阶段；读取工作区、绘图或提醒列表必须容忍工作区尚未创建并返回空状态，保存绘图和提醒等写操作继续严格校验 workspace/view 归属。

## 5. OKX 网络与代理

- 新安装默认直连，不预填或启用本地代理；只有用户明确保存代理配置后才启用代理，升级时不得覆盖既有配置。
- 所有 OKX REST、public WSS、business WSS、private WSS、AI 请求都要确认是否走配置代理。
- 带签名的只读 OKX GET 对连接、超时、响应体中断、429、5xx 和上游可重试错误码最多即时尝试 3 次；每次尝试必须重新生成时间戳和签名。写请求不得直接复用该策略，必须先满足幂等键和远端对账要求。
- OKX 私有 REST 与 Private WebSocket 登录时间戳必须使用 `/api/v5/public/time` 校准得到的共享偏移。HTTP 401 或业务响应出现 `50102` 时，只允许在重新校时、重新签名后重试一次；并发失败必须合并为一次校时，不能把时间戳过期误报为 API Key 认证失败。
- 网络不可达时，不要直接判断用户网络坏了。先检查：
  - 代理是否启用。
  - REST client 是否使用 `reqwest_client()`。
  - WebSocket 是否走 HTTP CONNECT。
  - 是否有 OKX code、HTTP 状态、超时、TLS、DNS、代理认证错误。
- Windows 配置 ACL 加固只能在敏感配置保存或启动迁移时执行，禁止放在 `load_*_config` 高频读取路径中；`icacls` 正常输出必须重定向，避免网络请求期间反复刷终端。
- 启动页必须始终保留可见的代理配置入口。启动网络门禁、行情加载或 K 线基线出现连接拒绝、代理隧道、TCP 连接等网络错误时，应同时提供代理配置和重试；其它启动检查失败也必须提供重试，不应进入主 UI 后再大量报错。

## 6. 实时数据与 UI 性能

- 交易相关实时性优先。不要为了“降频”牺牲成交、盘口、ticker、订单状态的可见实时性。
- 高频原始盘口增量不应逐条进入 React state。Rust 内存 store 维护权威状态，前端只接收可绘制快照或微批事件。
- Books / Trades 等高频频道禁止为每条原始消息单独跨 Tauri IPC `emit`；盘口只保留最新快照，成交使用有界微批队列，前端待渲染队列也必须设置上限并优先保留新数据。
- 当高频频道连续收到明显落后于 OKX 当前时间的数据时，应主动重连并丢弃 Socket 中的陈旧帧，避免旧消息持续刷新造成“看起来在线但行情落后数分钟”的假实时状态。
- WebSocket 传输心跳与业务数据心跳必须分开：ping/pong、订阅确认只能证明连接存活，不能刷新 ticker、盘口、成交或 K 线的新鲜度。高频业务数据超时应先定向重订阅，经过短宽限期仍未恢复才断开重连，并继续沿用有界退避，避免静默假活和重连风暴。
- 盘口 UI 必须固定档数、固定行高、固定压力图区，避免数据刷新导致视觉跳动。
- 主 UI 禁止全局滚动条。只能在局部列表滚动。
- 新增面板前必须检查：
  - 是否遮挡盘口、交易按钮、窗口控制。
  - 是否在 1280x720、1440x900 下产生横向滚动条。
  - 动态文本是否溢出。

## 7. 交易安全

- 下单预检不能包含会拖慢实时下单的网络请求。
- 行情延迟和私有频道延迟只做 UI 提示，不作为下单 blocker。
- private WS 延迟不能用于阻断交易，它主要负责余额、持仓、挂单事件推送和兜底同步。
- 账户快照 REST 同步失败不能直接阻断快速下单。它只能降级为 warning，因为持仓、余额和挂单已有 private WS / 定时同步兜底，最终风控仍以 OKX 下单接口返回为准。
- 点击“确认下单”后的后端链路必须尽量短：只做本地缓存合约规则、实盘确认、账号交易权限、基础参数和 OKX 必要账户配置检查；不要再跑账户快照、max-size、max-avail、fee、leverage-info、position-tiers 这类展示/估算接口。
- 无账号、无可平仓位、明显无效输入必须在 UI 阶段禁用按钮，不应该等用户确认后再让后端报错。
- 平仓 Tab 必须直接展示当前可平多 / 可平空数量；为 0 时对应平仓按钮禁用。
- 数量输入框应在输入完成时根据本地 instruments 规则自动规范化。例如 `minSz=0.01`、`lotSz=0.01` 时，用户输入 `0.001` 自动变成 `0.01`；小数位按 `lotSz/minSz` 推导。
- 交易面板杠杆旁边不应再保留“同步”按钮；用户切换杠杆后必须自动调用 `okx_set_leverage` 同步 OKX，并写入交易审计和通知中心。
- 杠杆自动同步失败时，UI 必须明确展示失败原因，并回滚或标记当前 OKX 实际杠杆；不能等用户下单时才报“杠杆未同步”。
- 合约规则类本地校验必须保留 blocker，例如 `minSz`、`lotSz`、`tickSz`、方向、保证金模式、委托类型、实盘确认、账号交易权限。
- OKX 永续/交割合约的 `sz`、`pos` 单位是“张”，不是币数量。前端下单输入、当前委托、当前持仓中的订单数量都必须按张展示和提交。
- U 本位线性合约的名义价值、保证金、手续费估算必须使用 `张数 × ctVal × 价格`；持仓币数量展示用 `abs(pos) × ctVal` 并标注 base currency，例如 BTC。
- private WebSocket `orders` 推送是当前委托、成交通知和历史委托刷新触发源。成交/部分成交必须右上角通知；成交、撤单、失败等终态/关键态必须触发历史委托刷新。
- 私有 REST `.send()` 失败必须使用分类错误，不要直接 `err.to_string()`。需要能区分超时、连接/代理失败、请求构造、响应 body、decode，并保留 path，避免用户只看到 `error sending request for url` 无法判断原因。
- 实盘下单必须保留：
  - 首次实盘风险确认。
  - 每次实盘下单二次确认。
  - 后端二次校验账号权限、实盘确认参数、合约参数。
  - 交易审计写库。
- 手动在本应用下单：`operator=user`。
- AI 自动化下单：`operator=ai`。
- 本地历史里找不到订单归因时，视为用户在 OKX App 或其它渠道手动操作，仍归为 `user`，不显示未归因。

## 8. K 线完整性

- 启动时必须检查观察交易对的所有要求周期。
- 新增观察交易对时必须立即拉取并补齐该交易对的 K 线数据。
- 启动和新增观察交易对时也必须确保该交易对 instruments 合约规则进入本地缓存。
- 下单预检、保证金估算、数量步进、价格步进、合约面值等任何需要 `minSz/lotSz/tickSz/maxLmtSz/maxMktSz/ctVal/lever` 的地方，必须先读本地 `cache/market-assets/swap-instruments.json`，缓存缺失时才允许请求 OKX 并回写缓存。
- 禁止在每次下单前无条件调用 OKX `public/instruments`，这会增加下单路径延迟。
- 完整性检查不能只看第一条和最后一条，必须扫描中间缺口。
- OKX 历史 K 线请求数据量较多时使用 `limit=300`。
- 本地 `local_candles` 如果发现数据不连续或窗口不足，不能把稀疏数据交给图表造成断层，应触发 REST 兜底。
- K 线图向左滑到本地窗口边界附近时，必须自动加载更早历史 K 线。
- 左滑加载历史优先从 SQLite 读取；本地缺失时再请求 OKX `history-candles` 并同步写入本地数据库。
- 历史加载必须增量合并到图表，不得阻塞实时 K 线、盘口、成交和下单面板。
- OKX K 线时间戳应保持 Unix epoch 事实值，不要为了显示 UTC+8 去改写数据本身。
- `lightweight-charts` 默认时间轴可能按 UTC 展示；需要通过图表适配器的时间格式化器统一显示 `Asia/Shanghai` / UTC+8。
- K 线横轴、十字光标、测距/绘图时间读数必须和成交、历史持仓、历史成交等列表的 UTC+8 展示一致。

## 9. AI / Cline SDK

- AI 配置必须从本地敏感 config 读取，不要硬编码在源码。
- 多模型配置必须使用稳定配置 ID 关联 Profile；自定义名称只用于展示，Model ID 用于 Provider 请求。每个模型的 API Key 保存在被 `.gitignore` 排除的本地敏感配置中；macOS/Linux 权限必须为 `0600`，Windows 必须限制为当前用户。摘要、日志和诊断导出只能保存脱敏值或空值。
- AI 供应商模板必须使用当前 Cline SDK 支持的 Provider ID 和厂商官方端点；模板只负责生成可编辑草稿，不能静默改写已有模型配置。推荐 Model ID 必须允许切换为自定义输入，新增配置名称要在忽略大小写后自动去重并以 `-1`、`-2` 递增；任何模板、图标或前端状态都不得包含 API Key。
- 本机订阅或 OAuth 只能通过供应商明确支持的官方 CLI / 嵌入接口委托，禁止读取、复制或解析用户目录中的 OAuth Token、认证 JSON、钥匙串或浏览器会话。`openai-codex-cli` 与 `claude-code` 可无 API Key 保存，但必须使用本机通道标识并通过官方 CLI 状态命令测试；Gemini CLI OAuth 不得被第三方应用复用。API Key 模板与本机 CLI 模板必须在 UI、摘要和错误信息中明确区分。
- Codex CLI 属于 provider-executed tool runtime：不能把其 tool-call chunk 再交给 Cline AgentRuntime 执行，否则会产生二次执行或 `Tool execution is disabled`。应用工具必须经带随机认证的 loopback MCP 映射到已有 `AgentTool.execute`，保留 JSON Schema、Sidecar policy 和 Rust 最终授权；运行必须强制使用 `--ignore-user-config --ignore-rules --ephemeral`，再注入当轮 Desic MCP，并关闭 Codex 原生 shell/Web Search/原生 Agent。非交互运行使用 `approval_policy=never` 时会自动拒绝默认需要确认的 MCP 调用，因此只能对本轮已通过 Desic 权限策略、且由随机 Token 保护的临时 MCP 显式设置 `default_tools_approval_mode=approve`；不得关闭只读 sandbox 或扩大暴露工具集合。由于 `--ignore-user-config` 同时会忽略用户自定义模型路由，Tauri 只能从 `CODEX_HOME/config.toml` 白名单读取当前 `model_provider` 的非敏感路由字段，并以 `-c` 覆盖重建 Provider；不得透传静态请求头、查询参数、Token 或其它用户配置。不能只用 `mcp_servers.<plugin>.enabled=false` 禁用插件 MCP，因为插件 transport 尚未进入基础配置时会形成无 transport 的无效配置；也不能借本机 CLI 绕过应用工具边界。
- 本机 Claude Code 必须通过官方 `claude -p` 非交互入口执行，不能把消费端 OAuth 交给第三方 Agent SDK 代发请求；后者可能被服务端以 `403 Request not allowed` 拒绝。运行只加载 `user` 设置源以保留用户自己的 `ANTHROPIC_BASE_URL` / 认证路由，不读取或复制其值；命令行必须使用 `--strict-mcp-config`、`--tools ""`、`--disable-slash-commands`、`--no-session-persistence` 和 `disableAllHooks=true`，同时关闭 CLAUDE.md、自动记忆和后台任务。仅将当轮已通过 Desic 权限策略的工具放入带随机 Bearer Token 的临时 loopback MCP，并以 `mcp__<server>__<tool>` 精确授权；临时 MCP 配置和系统提示文件在 macOS/Linux 使用 `0600`，Windows 依赖当前用户临时目录 ACL，并在运行后删除。
- AI 配置保存成功后必须发布只含脱敏摘要的配置变更事件；模型选择器应实时合并新摘要，当前选择仍有效时不得被 active model 强制覆盖。事件载荷不得包含 API Key、OAuth Token 或本地认证文件路径。
- 持久化配置引用账户、AI 模型等可删除对象的稳定 ID 时，读取摘要和实际执行路径都必须重新校验引用。失效的 AI 模型引用可回退并写回当前模型；失效的账户引用必须清除并暂停相关后台任务，不能静默切换到其它账户。
- `desic-core-operations`、`trading-philosophy`、`okx-news-intelligence`、`okx-smart-money-analysis` 是全局必需 Skills：界面必须显示为已启用且不可关闭，Rust 保存和读取配置时必须补齐三项显式 Skill；`desic-core-operations` 继续作为不可编辑的隐式固定规范，不写入 `enabledSkills`。`trading-philosophy` 必需但可定制，升级默认内容时只能迁移完全未修改的旧内置版本，必须保留用户自定义内容；其默认理念约束证据、风险和可修正性，不得把具体指标、周期、盈亏比或风险比例固化为普适规则。
- Cline Core 0.0.56 的 `subscribe` 流式文本和 reasoning 增量位于 `agent_event.payload.event`，并以每段一个 `content_start` 事件发送；sidecar 必须同时映射嵌套的 text、reasoning 和 tool 事件，不能只处理顶层 delta 或等待 `content_end`，否则 UI 会停在 running，直到结束后一次性显示。
- Cline 最终正文只认原生 `AgentDoneEvent.text`（同步 `start()` 结果只作为同结构兜底）。`content_start/content_end` 是当前 iteration 的内容块：可作为不落库的正文预览实时显示；出现 tool call 或 `iteration_end.hadToolCalls=true` 时通过结构化事件清空预览并将该轮文本归入过程区，无工具的最后一轮由 `done.text` 替换预览。禁止通过正文前缀、子串重叠、关键词或重复段落匹配来推断“过程/结果”。
- AI 工具公开的 `startTime/endTime` 统一使用 13 位 Unix 毫秒时间戳；后端可兼容旧秒级值，但不得对已经是毫秒的值再次乘 1000。UTC 日窗口若上层使用 `[start, end)`，传给闭区间工具前必须将 `end` 减 1 毫秒。
- AI 流式 reasoning/text 落库时应合并相邻 delta，并在工具、代理或审批事件处保留边界；历史加载端只按持久化事件类型恢复，不能通过正文内容猜测或修剪过程文本，也不能假设旧 `tool_json` 已经压缩。
- AI 工具在 UI 和 `tool_json` 中必须以 Cline SDK 的稳定 `toolCallId` 作为唯一生命周期主键；`tool-started / tool-updated / tool-finished` 只更新同一条记录。Rust `toolExecuteRequest` 是执行桥接协议，不得再额外广播或落库为第二套可见 `toolCall/toolResult`，否则开始、执行、完成会被误报为多次工具调用。
- sidecar 必须稳定处理：
  - 会话创建。
  - 发送消息。
  - 流式输出。
  - reasoning / text / tool / done 事件解析。
  - 停止。
  - sidecar 重启。
- 工具权限必须同时经过 Sidecar policy、Cline `beforeTool` Hook 和 Rust 授权；全部采用默认拒绝，SDK 新增工具不能自动获权。
- 所有 Provider 的工具参数必须在 Sidecar 执行前统一通过公开 JSON Schema 校验，不能只依赖部分本机 CLI Bridge 或 Rust `serde` 的泛化错误。可修正的参数类型错误应作为 `accepted=false / executed=false / errorCode=invalid_tool_arguments` 的正常工具结果返回，让 Agent 按字段路径修正并重试，而不是让 Cline 直接以 `tool call failed` 结束整轮；交易工具不得静默拼接、展平或猜测畸形参数。Rust 执行边界仍必须独立校验并失败关闭。
- `intelligence.*` 的模型参数必须先拒绝 `accountId`、环境和凭据字段，再由情报执行器注入当前 UI 或 Profile 账户；通用后台 scope 不得提前写入 `accountId`。
- 后台 Profile 的账户只读工具同样不能信任模型自行选择的 `accountId`；sidecar 应以非空 `agentProfileAccountId` 为绑定依据覆盖为 Profile 账户，不能依赖子 Agent 的 `backgroundRun` 标记，因为配置型专家会以 `backgroundRun=false` 限制动作权限。Rust 仍必须根据不可变 Run 快照二次注入和校验，不能因模型传入 `profile`、`default` 等占位值让必需账户风险 Agent 误判为无账户。
- 历史每日复盘必须保持证据时间口径：Smart Money 使用历史趋势工具及目标窗口截止时间，当前概览只能明确标注为复盘后补充；快照型 System Stress 刷新后必须回读本地请求窗口并按时间桶计算覆盖率。Daily Briefing 是可选生成物，空结果不等于原始行情缺失。`accountId` 是不透明稳定标识，禁止从 ID 文本中的 `demo/live` 推断环境，环境只认结构化字段和后端绑定校验。涉及开平仓时间、持仓时长和账户环境的复盘摘要必须由后端生成可读规范事实，并在完成工具落库前重新校验；不能让模型自行换算裸 Unix 时间戳或自由改写基础事实。
- 必需账户风险 Agent 的 `success` 表示证据足够形成受约束的风险结论，不表示所有可选数据都存在。成功读取当前余额、持仓和挂单后，空仓、空挂单、空历史属于有效状态；空仓时没有 OKX `liqPx` 不属于阻塞缺口，`liquidationGear` 只是强平风险提醒档位，不能解释为强平价计算状态。USDT 线性永续的账户权益、可用余额和风险预算只使用 USDT，非 USDT 原始币数量不得相加或列为阻断性缺口。无法读取当前风险基线，或具体交易方案缺少必要预检时仍必须失败关闭。
- 禁止向交易 Agent 暴露 `run_commands`、Shell、编辑器、apply_patch 或敏感配置读取工具。
- Subagent 只读，不允许创建/修改机会、交易、通知、提醒或脚本；只有主 Agent 能产生外部副作用。
- Profile 多 Agent 只允许 `off / auto / custom`；auto 每轮最多 8 个专家，custom 最多配置并启用 10 个成员且至少启用 2 个，启用成员数不能超过 Profile 上限。后台 Run 使用确定性 Subagent 编排，不开启持久 Team，避免长期会话状态替代本轮最新市场和账户证据。
- Profile 选择 `auto / custom` 时，协作编排 UI 必须明确提示多 Agent 的 Token 成本显著高于常规模式（当前估计 10-50 倍）；提示只用于帮助用户取舍，不能暗中改变成员数量、模型或运行权限。
- 自定义 Agent 方案属于可复用配置，Profile 必须保存所选方案 ID 和独立成员快照；后续修改或删除方案不得改变已经保存或入队 Run 的成员定义。内置方案只读，用户方案保存时仍执行成员数量、稳定 ID、职责和数据范围校验。
- 每个 configured Agent 必须有稳定 ID、明确职责和受控数据范围。Sidecar 只暴露范围内工具，Rust 必须按 Run 的冻结 Profile 再校验 configured Agent 与 scope；不得只信任 Sidecar 自报的 `agentRole` 或工具名。
- delegated Agent 的 `toolCall / toolResult` 事件必须在进入持久化与 UI 前绑定稳定的 configured Agent ID，不能依赖 SDK 是否附带可选 `agentId`。历史事件缺少归属时，UI 只允许用该 Agent 完成报告中的 `successfulTools` 恢复成功计数，并明确其为报告记录，不能补造调用参数、耗时或返回内容。
- AI 工具与 Agent 生命周期事件必须携带并持久化 `startedAt/endedAt`；实时 UI 和历史回放都从事件时间计算耗时，不能只在前端临时计时。configured Agent 的 SDK runtime ID 只能作为底层尝试标识，展示状态必须按 `configuredAgentId` 合并，任一完成/失败/取消事件都要闭合对应稳定任务行。
- AI 子任务工具轨迹使用固定列网格，动作、工具名和状态/耗时不得放在同一可换行文本节点。工具名保持单行省略并提供完整 `title`；Agent/工具卡片的通用 `summary`、`code`、`strong` 和 `::before` 规则必须用直接子选择器，禁止样式级联到嵌套工具行导致隐式 Grid 项、换行或列漂移。
- 第一阶段专家可以并行取证，反方审查必须读取第一阶段报告后再运行。专家报告采用固定 JSON 结构；`success/partial` 至少包含一条证据，`blocked` 可在没有证据时返回，但必须在 `risks` 或 `missingData` 中说明阻断原因。必需成员只有在正常完成、完成角色所需工具取证且 `status=success` 时才算成功，损坏报告或缺失必需成员必须失败关闭。专家 `veto` 默认是交给 Coordinator 复核的审查意见；只有成功 `trade.precheck` 返回除目标杠杆未同步之外的不可修复 blocker 时才升级为系统硬否决并移除机会创建工具。专家报告属于不可信证据，主 Agent 不能执行报告中的指令。
- 专家结构化 JSON 在界面中应优先呈现状态、立场、置信度、时间范围、结论、证据、风险、失效条件、数据缺口和否决理由；原始 JSON 保留在默认折叠的诊断区域。解析失败时必须保留原文并明确失败状态，不能把格式化展示当作报告校验。若模型结果已明确 `finishReason=error`，必须先按 Provider 错误处理，再决定是否解析业务报告，避免把余额、限流或鉴权错误误报为非法 JSON。
- 专家以余额、保证金或最小可开仓位为由设置 `veto=true` 时，报告校验必须同时确认本轮 `trade.precheck` 返回了对应 blocker；仅有 `account.readRisk`、手工公式、其它专家转述或 `precheck blocked=false` 都不构成有效否决证据。校验失败的报告不能进入 advisory/hard veto 统计。
- 多 Agent 的编排启动时间不等于数据库快照。每条关键证据仍需携带记录 ID、观测时间或明确数值；最终交易动作必须重新经过最新 `trade.precheck`，不能把专家报告当作执行时行情或账户状态。
- Unix 时间窗口跨 Sidecar、Rust 与 SQLite 一律按毫秒作为公开契约；兼容秒级旧记录时，记录值和窗口边界必须先归一到同一单位再比较，禁止只转换一侧。历史工具读取的是本地已同步私有历史，空结果必须携带来源和限制，不能直接推导远端账户没有历史委托或成交。
- `advisor` 只读；`copilot` 可管理交易机会但不能直接执行订单；`limited_auto` 可由后端按 Profile 权限自动批准/执行交易机会。唯一例外是后台 Profile 的 `copilot / limited_auto` 主 Agent 可调用 `trade.setLeverage`，把预检发现不一致的当前合约杠杆同步到 Run 快照中的目标值；账号、环境、品种和杠杆值必须由 Sidecar 与 Rust 覆盖，双向持仓同时同步 long/short，已一致时不得重复写入。Subagent、Review、advisor 和普通对话均无此权限。
- 创建交易机会和执行订单必须分开；`tradeOpportunity.create` 不能隐式下单。
- AI 创建永续合约交易机会前必须读取 `market.readInstrument`。`minSz/lotSz` 可以是小数张，例如两者都是 `0.01` 时，`0.01` 张就是合法最小数量，禁止按自然语言习惯向上取整为 `1` 张；`size` 必须满足 `minSz/lotSz`，所有委托价、触发价、止盈价和止损价必须满足 `tickSz`。
- AI 涉及账户是否能开仓、余额是否足够、是否需要充值或技术止损是否可承受的判断时必须再调用 `trade.precheck`，至少用 `size=minSz`、实际价格、保证金模式和当前计划杠杆验证；有失效价时必须传 `stopPrice` 并使用后端返回的 `estimatedStopLossWithFees / stopLossPctOfUsdtEquity`。U 本位线性永续按 `size × ctVal × price` 计算名义价值，按 `名义价值 ÷ 当前杠杆` 计算预估保证金，按 `size × ctVal × |entry-stop|` 计算价格止损；instrument 的 `lever` 是最大杠杆，不是账户当前杠杆。
- USDT 线性永续的张数规范化、基础币数量、名义敞口、初始保证金、手续费、止损风险、ATR 风险和 Profile 容量必须统一调用 `desic-trade-domain::evaluate_linear_usdt_perpetual`；Tauri、前端和 Agent 不得各自维护第二套财务公式。`account.readRisk.instrumentEvaluations` 用于最小仓位基线，`trade.evaluatePlan` 用于候选方案的轻量确定性评估，`trade.precheck.perpetualEvaluation` 用于最终执行预检。
- 结构化字段语义固定：`effectiveExposureMultiple=名义敞口÷USDT权益` 是账户有效敞口倍数，也是每 `1%` 标的价格变化对应的近似权益百分比敏感度；`notionalPctOfEquity=effectiveExposureMultiple×100%`，`marginPctOfEquity` 是预估初始保证金占权益，`stopRiskPctOfEquity` 是含双边手续费止损占权益，`oneAtrRiskPctOfEquity` 是固定张数的一倍 ATR 价格风险占权益。固定张数下杠杆只改变保证金，不改变价格盈亏；禁止把名义敞口比例改称为保证金占用、账户亏损或单独推导为“容错空间有限”。账户容错必须结合止损/ATR 风险、剩余保证金、强平距离、已有持仓、组合风险和确定性 blocker。
- 后台交易候选必须采用两阶段事务：只有字段完整、准备通过 `tradeOpportunity.create` 提交的可执行候选才调用 `market.readDecisionContext`；无新候选的 `wait/abandon` 直接调用 `background.finishRun`，禁止用 `size=0`、缺失限价/触发价或其它占位参数伪造候选。`open/close` 的张数必须大于 0，`limit/trigger` 必须提供 `price`，这些约束应在 Sidecar JSON Schema 中先于 Rust 执行。模型提交完整候选后只能通过 `tradeOpportunity.create` 提交后端冻结的候选，禁止向后台模型暴露独立 `tradeOpportunity.reuse/revise` 或要求其搬运候选字段、context ID。重复处理只通过 commit 的 `duplicateResolution` 表达；exact 才能直接 reuse，similar 若要 reuse 必须先按原机会参数重新复核。复核消费与重复决议必须在一个事务内持久化，不能改写原机会的创建归属。`background.finishRun` 中新建/复用机会 ID、复核 ID、系统原因码和 `accountAssessment` 属于系统事实，必须由后端按 Run/Profile 的持久化记录派生；模型只提交语义决策和唤醒计划。
- AI 工具在应用内部、策略和持久化事件中使用点号规范名，Provider 注册时使用只含字母、数字与下划线的名称。系统提示、Profile/Skill 内容、用户任务、工具说明、Schema 描述和返回给模型的修正信息必须在模型边界统一转换为实际注册名；不得把内部点号名称作为 `Canonical tool name` 暴露给模型，否则调用会在进入 Sidecar/Rust 前被 SDK 以 unavailable tool 拒绝。新增工具时必须覆盖提示、描述、Schema 与纠错结果的名称一致性测试。
- 具有本地 Schema 校验并返回可重试修正信息的完成工具，不得设置“调用即结束”的静态 lifecycle。只有后端成功提交终态才能结束 Run；校验失败必须回到模型继续修正，最终失败记录应从持久化 tool result 提取真实原因，不能把“调用失败”写成“从未调用”。
- Smart Money 必须以当前线上接口实际契约为准：overview 始终返回当前小时，禁止向上游发送 `ts/dataVersion`；signal-history 只发送 OKX UTC+8 小时格式 `dataVersion=yyyyMMddHH`。Agent 工具仍接收易用的 13 位毫秒 `ts`，后端负责转换且绝不透传；历史趋势还必须带完整 `instId`、`granularity` 和 `limit`。上游过滤字段统一为 `sortType/pnl/winRatio/maxRetreat/asset`；signal/overview/history 使用枚举池过滤，leaderboard 使用 USD/比率数值阈值，不得混用。不得继续提示模型使用 `instCcy/asOfTime`；远端 5xx/timeout 只能回退本地同币种、同粒度、截止时间内的历史行，不能拿当前 overview 快照冒充历史。解析后若 `dataAt` 领先当前时间超过 5 分钟，必须标记 stale 并提示检查时区，不能把负 `ageMs` 静默截断。
- 普通/精英拥挤度必须使用确定性字段语义：`accountRatio/topAccountRatio` 是多头账户数与空头账户数之比，`topPositionRatio` 是头部交易者多头持仓价值与空头持仓价值之比。Agent 优先使用后端派生的 `accountBias/topAccountBias/topPositionBias/eliteInternalDivergence`，禁止把 `topPositionRatio` 解释成相对普通交易者的仓位规模。
- 盘口是短时快照。AI 工具必须返回 `observedAt` 和 `snapshotId/seqId`；只有相同快照的不同计算才能称为计算冲突，不同快照只能描述为市场随时间变化。
- `trade.precheck` 不得通过移除账户、限额、费率、仓位档位或杠杆检查换取速度。应复用代理感知的 HTTP Client、5 分钟账户配置缓存和不超过 5 秒的新鲜私有 WS 快照；余额/持仓/挂单快照及独立的档位、最大开仓量、费率和杠杆查询应并发执行。响应必须披露阶段耗时、快照来源和缓存命中，真实下单仍走最终硬预检及 OKX 校验。
- 风险增加操作必须绑定机会和 revision；上述 Profile 目标杠杆同步是唯一例外，因为目标值是用户预先保存并冻结到 Run 的配置，而不是模型自由决定的参数。Rust 只负责权限、环境、参数、归属和幂等，不替 Agent 判断策略好坏。
- `market.readIndicators` 的公开 Schema 必须列出可用指标 ID、周期后缀格式、默认周期和示例。当前支持 `sma[N] / ema[N] / rsi[N] / atr[N] / boll[N] / bb[N]`（周期 1–500）以及固定 ID `macd / vwap / volumeProfile / volumeProfile/light`；不支持的 ID 应返回同一份可执行提示，不能只返回 `unsupported`。
- 相似机会与相同订单重复提交是两套机制：前者返回结构化冲突供 Agent 选择，后者必须由稳定 executionKey、唯一约束、`clOrdId` 和 OKX 对账保证。
- OKX 查询成功但 `data=[]` 不能视为明确不存在；只有明确不存在错误才允许释放同键重试。
- 所有用户下单和改单也必须使用稳定 `executionKey`，不能只保护 AI 交易。执行尝试必须在外部写请求前持久化请求指纹、客户端订单 ID 和账号凭据指纹；旧记录未绑定凭据或账号凭据已变化时保持未知并禁止使用新凭据自动对账。
- 可能被启动恢复、手工对账或多个桌面进程同时处理的外部写执行，不能只依赖进程内互斥锁。普通下单、普通改单和策略单的非终态记录必须使用持久化 owner lease 和数据库条件更新认领；未到期租约不得被恢复任务抢占，每轮长耗时对账前续租，旧 owner 丢失租约后不得继续查询或覆盖终态。紧急操作不自动重放写请求，必须用稳定 `operationId`，并在同一个 SQLite `IMMEDIATE` 事务内按账号、环境、合约和操作类型重新检查活动 scope 后原子占位；其普通平仓与 fallback 子执行仍使用 execution owner lease。
- 撤单、设置杠杆等没有稳定重放语义的外部写不能硬塞进订单恢复账本，也不能跨网络持有 SQLite 写事务。应在 `IMMEDIATE` 事务内重检账号快照并写入短期账号写租约，每次 HTTP/WSS 写前续租，所有返回路径按 owner 条件清理；账号保存、连接测试和删除必须在各自现有事务内拒绝目标账号的未过期租约。租约清理失败只能告警并等待过期，不能把远端成功伪装成失败诱导重试。
- OKX HTTP/WSS 调用成功不能直接记为 accepted。写响应必须包含非空远端订单 ID，并精确匹配请求的 `clOrdId/algoClOrdId`；查询对账还必须匹配账号、环境和 `instId`。身份不一致、空数据或解码不完整都保持 `unknown`，不能自动换执行键重试。
- 风险增加写操作必须在共享交易变更门禁内完成原子占位、最终本地硬预检、提交和模糊结果对账；不同 `executionKey` 的普通开仓和风险增加改单必须在写入自身记录的同一个 SQLite `IMMEDIATE` 事务内重查同账号、环境、品种的未决交易与紧急操作，不能依赖事务外查询。未知普通执行或紧急操作会继续阻止开仓。平仓等风险降低路径必须保留可用，并避免在紧急操作内部递归获取同一进程锁。
- 独立 TP/SL 必须是保护性委托：`long_short_mode` 只允许 `sell+long` 或 `buy+short` 且不发送 `reduceOnly`，`net_mode` 只允许 `posSide=net` 并发送 `reduceOnly=true`；未知持仓模式和任何开仓方向组合必须在持久预留前失败关闭。前端处理 net 持仓时必须按 `pos` 正负判断多空方向；图表持仓拖线必须将市价平仓、普通限价平仓、策略改单和新建保护策略显式分流，不能把止盈止损触发价作为普通限价单直接提交。
- AI 候选必须在创建最终复核快照前完成订单字段组合校验。`intent=close` 的 `limit/trigger` 价格本身就是退出条件，不能再携带 `takeProfit/stopLoss`；当前计划委托不支持附加保护单，开仓计划须在成交后独立创建保护单。结构不支持的组合不得创建机会、消耗复核快照或触发任何 OKX 写入。
- 全合约撤单/平仓等紧急操作必须对各自目标范围使用“严格只读快照 -> 有期限预览 -> 稳定操作 ID 原子认领 -> 逐项身份校验 -> 全范围最终重扫”的协议。目标范围内缺失/重复 ID、非法精确数值、分页或重扫失败均失败关闭；另一风险降低通道的数据只能作为非阻断提示。同类未知阻止重复执行，但不得阻止另一类风险降低操作。
- 前端必须在启动和 scope 切换时读取后端持久化 guard，不能只依赖组件内存。`unknown/reconciling/blocked` 状态要独立于最近一次成功结果展示；损坏或身份绑定不一致的 `blocked` 记录继续参与风险拦截，但不能进入自动恢复循环，用户可触发的恢复动作只能做只读查询。
- 账号环境由 API Key 自动识别时，不得直接把旧账号从 demo 改写为 live 或反向改写。账号配置写入和所有普通/策略/紧急执行预留必须在 SQLite `IMMEDIATE` 事务内重新校验账号快照，读取既有执行、抢占重试状态和落库必须处于同一事务，形成跨进程先后关系；账号执行指纹（环境、凭据、读取/交易权限）变化和删除账号前按 `account_id` 跨全部环境检查未决普通/策略执行、`accepted` 但投影未完成的记录和当前合约紧急操作。OKX 远端账户身份以只读 `/account/config` 返回的 `environment + uid` 为准并持久化 `mainUid`；同一 API Key 或同一远端身份不得配置到第二个 `account_id`。旧版多账号只要任一凭据账号缺少 UID，就必须要求逐个连接测试并失败关闭新的交易执行，防止通过同环境换 Key、环境变化、删除重建或重复账号让持久化 guard 从新 scope 消失。前端首次实盘确认必须按 `account_id + environment` 记录，环境自动变化时在确认前失败关闭交易账号。
- 后台唤醒条件必须类型化并有资源上限，禁止把任意脚本或表达式作为触发器。
- 每个后台 Run 必须固定 Profile、权限和 Skill 版本；运行中配置变化不能改变当前 Run。
- 非空 Profile snapshot 解析失败必须使 Run 失败，不能回退到后来修改的 Profile；custom 多 Agent 成员 JSON 损坏、必需成员丢失或启用成员超过上限同样失败关闭。仅明确没有 snapshot 的旧记录可走单独兼容路径。
- AI 复盘的章节名称属于输出引导，不得作为 `finishRun` 的事务硬门槛；完成校验应只约束安全边界、必需结构化参数和非空正文，避免模型合并或改写标题导致整次复盘失败。
- 后台和复盘 Agent 不设置用户可配置的总运行时长上限；明确网络/Sidecar 错误应结束 Run 并退避，正常长推理继续等待。后续停滞检测必须基于连接心跳或最后事件时间，不能把总耗时直接当失败。
- Review Agent 永远只读，不能自行修改或发布 Skill。只有证据明确指向可复用、可验证的 Skill 级缺陷时才允许提交完整候选 Skill；单笔盈亏、正常方差、一次性执行问题或数据缺失不得触发优化建议。候选必须绑定仓位决策实际使用的已发布版本，用户在逐行差异预览中明确采用后才直接发布；采用时若最新发布版本已偏离基线必须失败关闭，禁止覆盖后续修改。
- Skill ID 必须唯一且能无损映射为目录名；配置文件、Skill 文件和版本状态必须按失败可恢复的顺序更新。发布中断恢复应完成原 draft，不能复制出一个新的 published 版本。
- Cline SDK 会把 `sessionId` 用作本地 session 目录名。业务层可以保留带命名空间的 ID（例如 `background:run-*`），但传入 SDK 的运行时 ID 必须经过稳定、抗碰撞、限长的 Windows 文件名安全映射；停止、订阅、恢复和 Subagent/Team 配置必须使用同一个映射结果。
- 修复 session ID 映射时还要处理 Cline `sessions.db` 中已经存在的非法历史记录，否则 SDK 的 stale-session reconciler 会在新会话启动时重新访问旧冒号路径。迁移只能清理当前项目且提示词明确属于 Desic Terminal 或旧版 `desicTradeAI` 的 `background:/review:` 记录，并同步解除 schedule、父会话和 Subagent 队列引用，不能删除用户其它 Cline 会话。
- Cline Provider ID 可识别、handler 可构造不代表最新模型已经完成线协议适配。升级模型模板时必须用占位凭据和拦截 `fetch` 的方式核对最终 endpoint、Model ID 与请求体，重点检查 thinking/reasoning、采样参数和 Responses/Chat/Anthropic 协议差异；适配层只能按明确 Provider + Model 白名单改写，不得记录请求头、API Key、完整提示词或响应正文。
- 端口渲染的自定义下拉菜单与模态框同时打开时，`Esc` 必须先关闭下拉菜单，第二次才关闭顶层模态；模态框的捕获阶段快捷键不得抢先吞掉下拉组件的键盘事件。

## 10. 应用品牌与标识

- 正式产品名统一使用 `Desic Terminal`；npm/Cargo 主包和桌面二进制统一使用 `desic-terminal`；Tauri identifier 使用 `com.desic.terminal`。
- UI、窗口标题、托盘 tooltip、AI clientName、User-Agent 和通知 tag 不得继续新增旧品牌名。
- UI 对后台 Run 的实时状态应以 Tauri 完成/失败事件为主；轮询只能作为低频兜底，并按活跃 ID 查询最少字段，禁止周期性读取完整工作台摘要。SQLite command 若会被 UI 自动刷新调用，必须用异步 command 将同步数据库工作放入阻塞线程池。
- `com.desic.tradeai` 只允许出现在旧目录或历史会话迁移兼容代码中。
- 数据库文件名、localStorage key、事件名和已发布序列化字段属于持久化协议，不能只为品牌一致性直接重命名；需要迁移时必须先提供双读或版本化升级路径。
- Sidecar 子进程退出时必须向所有活动 session sink 广播错误，使后台/复盘 Run 立即落为 failed；旧 Sidecar 的退出回调不能清空或误伤已经重启的新实例。Node 命令任务必须显式消费 rejection，不能只调用未接收返回值的 `Promise.finally()`，否则初始化异常会演变为进程退出和永久 running。

## 11. UI 设计硬规则

- 尽量不要使用方方正正按钮、高亮方框、厚重矩形描边。
- 按钮、配置入口、添加自选、代理配置应使用轻圆角或胶囊形态。
- 紫色只做品牌、选中、焦点、少量强调，不做大面积粗糙色块。
- K 线必须使用金融常规红绿。
- 主交易终端采用高对比指挥舱层级：冲击力集中在顶部实时价格、当前导航/交易对、中心 K 线结构框、盘口深度和交易动作区；其它辅助面板必须主动压暗，禁止把相同发光、边框或高饱和色平均铺到所有区域。
- 盘口档位深度色带必须由当前可见挂单量比例驱动，卖盘使用红色、买盘使用绿色；空档位宽度归零，更新只改变色带宽度，不能引起行高或布局跳动。
- 交易按钮要清晰但不粗糙，避免纯平面大色块。
- 右侧交易表单采用紧凑工作台布局：保证金模式与杠杆可并排，分段控件使用小圆角和低对比选中态，不得重新堆叠大胶囊、渐变、内发光和重复卡片。
- 做多/做空、平多/平空的共同阻断原因只在动作区上方展示一次；按钮内部只保留方向、环境和动作提示。AI 悬浮入口默认必须按交易栏宽度避让，不得覆盖任一交易按钮；用户拖动后要记忆位置，并在窗口缩放时将入口约束在可见区域内，拖动手势不能误触展开面板。
- 所有浮层、通知、AI 悬浮窗、弹窗不能遮挡窗口控制、盘口核心区域和下单按钮。
- 应用内具有独立标题栏的子窗口必须支持从标题栏拖动；按钮、输入框、下拉框、链接和可编辑区域不能触发拖动，移动后至少保留标题栏在当前可视区域内，窗口缩放时需要重新约束位置。
- 表格高亮必须使用统一语义：盈利/上涨、亏损/下跌、活跃、风险、未知分别走统一 helper 和 CSS 类，不要在各列表里临时写一套颜色。
- 状态类高亮优先使用“小圆点 + 文本”，不要用大面积整行背景或厚重高亮框。
- 当前项目采用金融红绿语义：红色用于上涨/盈利/偏多强调，绿色用于下跌/亏损/偏空强调。新增高亮必须和 K 线、盘口保持一致。
- 止盈止损、平仓、修改策略等交易弹窗必须同步使用表格同一套高亮规则，尤其是最新价、触发价、委托价、预估收益、强平风险。
- K 线委托价格线只显示当前交易对，不显示其它观察交易对；普通限价、计划委托、止盈、止损线必须能随当前委托/策略委托刷新增量更新。
- K 线交易对象必须使用统一业务语义：分析观点只写“看多/看空”，交易动作只写“做多/做空/平多/平空”，持仓状态只写“多仓/空仓”，不得在图表标签中暴露 `buy/sell` 或“买/多、卖/空”等传输字段。机会使用紧凑空心标签，当前委托使用价格线，真实成交使用实心箭头，持仓使用区间层；AI/策略来源进入详情或 tooltip，不与动作拼成第二套标签。
- 同一持仓不得同时生成“开仓均价委托线”和“持仓区间”两套常驻标签；常驻交易标签必须使用统一紧凑尺寸，把状态、来源和长理由放入 tooltip。交易机会属于候选与工作流信息，不得绘制在主图、独立图或图表预览的 K 线上；它们只在交易机会工作台和图表表格视图中呈现。图表撤单必须由明确的关闭图标发起并进入二次确认，标签正文不能直接执行撤单。
- OKX 已明确接受撤单后，订单终态必须先写入按账号/环境隔离的运行时快照，再处理后续 `orders-pending` REST 或私有 WSS 增量；这些输入可能乱序，旧 live 订单不得重新进入主窗口、独立图或当前委托列表。前端只能做即时呈现，不能以定时隐藏作为状态正确性的来源。
- 交易机会与真实订单/成交仍必须按 `orderId/clientOrderId/algoId/opportunityId/executionKey` 等稳定关联键关联；K 线图仅绘制真实当前委托、成交和持仓，不得通过价格或时间猜测把候选机会伪装成成交。
- 自选搜索应基于本地交易对资源提供可过滤下拉列表，候选项使用独立加号添加并明确标识已加入状态；主 UI 不再保留重复的底部添加按钮。当前交易链路只展示可用的 USDT 永续候选。
- K 线活动提醒必须在提醒线附近提供可交互标签和明确删除入口，不能只依赖不可点击的价格轴标签或远离价格线的顶部列表。
- SVG 图表绘图进入创建模式后，已有绘图命中层必须暂时让出指针事件，避免覆盖第二落点；端点和控制柄只有超过明确的最小移动阈值才写入历史并修改坐标，纯单击只负责选中。风险收益类工具的预览、两次单击和按住拖拽必须共用同一套价格规范化逻辑。完成一次绘图或测距后必须自动退出当前工具；平行区间必须保存足以恢复角度的三点数据，旧两点矩形按原轴对齐形状兼容读取，内部填充面必须直接承担整体拖拽命中。
- 图表提醒的条件验证、收盘判定、状态更新和外部投递必须集中在 Rust；前端只负责从指标中心已选实例生成结构化定义与预览。内置和自定义 DSL 指标必须保存实例参数及输出线标识，多输出指标不得退化为含糊的指标级条件。指标提醒不得在未确认 K 线上触发，也不得用旧的最后有效值冒充当前值；HTTP 渠道只允许经过后端校验的 GET/POST URL，日志不得输出完整请求体、Webhook 地址或潜在凭据。
- 应用业务 UI 禁止直接渲染原生 `<select>`；单选下拉统一复用 `TerminalSelect`。新增场景必须提供可读 `ariaLabel`，保留关联字段的 `id`、禁用态、校验态和描述引用，并验证方向键、Enter/Space、Home/End、Esc、前缀键入、点击外部关闭与焦点恢复。Portal 列表必须限制在视口内，且不能触发父弹窗或浮层的 outside-click / Esc 关闭逻辑。
- 独立策略单的可靠来源仍是 `orders-algo-pending`；`orders-pending` 中的 TP/SL 字段只能作为普通委托附带 TP/SL 的展示补充，不应替代策略单修改、撤销和 OCO 状态来源。

## 11. 代码组织

- 主 Tauri crate 只保留：
  - command 注册。
  - 窗口控制。
  - Tauri event。
  - 本地敏感配置、文件路径、AppHandle glue。
  - 必要的外部 IO 编排。
- 纯类型放：
  - `storage-config`
  - `private-history`
  - `trade-domain`
- 纯 SQL row mapper、领域计算、归因规则、同步状态判断，优先从主 crate 下沉到对应 crate。
- 不要在 `lib.rs` 继续堆新大函数。新增功能先判断是否属于可独立 crate 的领域逻辑。

## 12. 市场情报 Provider

- 后台 Agent 的 `intelligence.news.*` 与 `intelligence.smartMoney.*` 必须立即读取本地证据，不得在模型工具调用链内同步等待 HTTP。缺失或过期只返回结构化 freshness/coverage/limitations 并排队后台精确补采；远程刷新开关不得暴露给模型。
- 情报刷新去重键必须包含接口、标准化参数、账户环境和 `dataVersion`。去重只适用于后台情报采集，绝不能复用 `market.readDecisionContext`、当前盘口、近期成交、当前未完成 K 线或账户最终快照。
- 自动化主 Agent 在提交新建、修订或复用决议前必须用最终完整候选参数读取决策上下文，所有后台决议统一经 `tradeOpportunity.create` 提交。上下文只允许当前 Run/Profile/账户/环境/标的和候选指纹在有效期内消费一次；similar 冲突的候选指纹不同，不能直接复用。程序只提供时间、快照、差异和预检结果，不用固定行情阈值替 AI 选择 execute/revise/wait/abandon。

- OKX News、情绪、经济日历与 Smart Money 必须通过 `desic-intelligence` 的版本化 adapter；Tauri command、UI 和 Agent 工具不得直接依赖上游不稳定字段。
- 上游响应进入应用前必须执行字段白名单标准化；结构不兼容时标记 provider degraded 并停止写入，不允许 panic，也不能把未知字段透传给 Agent。
- 情报账户只能使用 OKX Global live 读取权限账户。工具参数不得接受 API Key、Secret、Passphrase、CLI profile、OAuth token 或 environment 覆盖。
- 情报工具始终只读。新闻、情绪、宏观事件和聪明钱只能形成可追溯证据；涉及交易仍必须创建/修订交易机会并执行既有预检、确认、审计和幂等链路。
- Smart Money 聚合信号只覆盖 USDT/USDS 线性合约，名义价值统一按入场价口径；新增页面、工具或文档不得省略这两个 limitation。
- 采集任务按查询 scope 互斥并写 `intelligence_sync_state`；后台账户失效时不得静默切换其它账户。经济日历无论从页面、Agent 还是后台触发，都必须共享 5 秒全局门禁。
- fixture 只能使用明显脱敏样本，固定 provider 版本和 commit。升级 provider 前必须同时通过 fixture、Rust adapter 测试、AI policy、Playwright 和真实 live 只读 smoke。
- OKX Trading Data/Rubik 公共接口单页最多 100 条；24 小时 5 分钟数据等长窗口必须显式分页，不能把首个 100 点误报为完整覆盖率。查询本地历史时必须取时间窗内最新数据，再按时间升序交给图表。
- 本地只持久化 5 分钟和 1 小时衍生品主序列；4 小时和日线由 1 小时数据按 UTC epoch 桶确定性聚合。不要为了显示 Asia/Shanghai 改写存储时间戳。
- 衍生品多序列响应必须按序列输出独立的新鲜度元数据，至少区分 `bucketStartAt/bucketEndAt`、证据 `observedAt`、本地 `fetchedAt`、有效年龄、`bucketStatus` 和来源模式；不得用某个 scope 最近同步时间替代所有序列的证据时间。当前未闭合桶可由本地 5 分钟数据确定性聚合为 1H/4H `partial`，OI 查询还应在返回前合并 WSS 内存当前值，但不得因此提高 SQLite 写入频率。
- AI 行情工具的公开时间契约统一使用 Unix 毫秒。`market.readCandles` 的稳定历史段必须在 SQLite 内从 1m 直接聚合为目标周期，不能把整个高周期窗口的原始 1m 行物化到 Rust；只有与 Business WebSocket 近期内存缓冲重叠的尾部，才从完整目标桶起点回读少量数据库 1m，按时间主键合并后在 Rust 重算。已确认值不能被乱序的未确认内存更新降级。当前窗口读取必须校验最近应确认的 1m 尾部，缺口时立即返回本地证据并按标的单飞排队一次有界公共补洞，不得让 Agent 同步等待公共 HTTP；结果通过 `stale/staleReason/latestConfirmedAt/expectedLatestConfirmedAt/refreshStatus` 披露缺口和后台状态，不得把旧 K 线冒充实时数据。多周期查询共享只读连接并在阻塞线程池执行，逐根返回 `time/openTimeMs/closeTimeMs/observedAt`；K 线是否收盘只看 `confirm`，衍生品 `bucketStatus=partial` 仅表示当前周期内的临时累计观测，`incomplete` 才表示已结束桶缺少预期采样点。带 `endTime/decisionAt` 的查询不得返回晚于该截止时间的 `dataAt/observedAt`。
- AI usage 必须在 assistant 轮次结束时形成一次权威汇总：主 Agent 取最后一份累计 usage，子 Agent 按稳定 Agent ID 各取一次完成 usage；总 Token 只按输入加输出计算，缓存和推理字段单列，不能重复相加。运行状态事件可以先更新轻量状态，但完整轨迹与 usage 成功提交后必须再通知 UI 刷新记录。SQLite 写流程如果需要先读再写，必须从事务开始取得写权限并保持短事务，不能依赖延迟事务中途升级锁。
- Profile 风控参数必须冻结进 Run 快照并在 Rust 执行边界强制执行，不能只写入 prompt。最大单笔开仓保证金按 `min(USDT equity × percent, available USDT)` 计算，Agent 可在上限内选择张数，但 `trade.precheck`、最终决策上下文和交易机会创建/修订/复用都必须使用同一冻结值；无法取得权益或可用余额时自动开仓失败关闭。手动交易请求不得隐式套用 Agent Profile 限额。
- 市场情报的价格补全和新闻反应必须兼容本地 K 线实际可用周期；当前基础库主要保存 `1m`，不能硬编码只查 `5m`。回看最近 K 线必须设置最大时间容差，避免把长期断档前的旧价格当作事件时点价格。
- `intelligence:event` 是跨采集源总线，页面监听必须保持单实例、按事件类型选择性刷新并合并节流；禁止每个事件同时重载摘要、新闻聚类和全部衍生品查询。可能扫描或写入大量 SQLite 行的 Tauri command 必须使用 async command 并下放到阻塞线程池。
- 情报同步事件命中当前可见 Tab 时，新闻正文、新闻事件、情绪/宏观、聪明钱和衍生品必须分别回读对应的本地缓存；页面自动更新不得借此发起远端 HTTP，也不能只更新摘要而留下旧内容数组。
- 同一 AI Run 内互不依赖的只读工具允许有界并发，交易机会、杠杆、最终复核和其它写操作必须独占执行并等待在先读取完成。工具耗时必须区分模型生成参数、Rust Bridge 排队和实际执行；UI 不得把 SDK `tool-started` 到 `tool-finished` 的总时间冒充数据库或 HTTP 执行时间。SQLite 连接不得在每次只读查询时重复设置 WAL，也不得在行情工具热路径重复跑 schema migration。
- 当前未发布版本以 `PRAGMA user_version=1` 作为唯一 Schema 基线：建表、补列、删除废弃对象只允许在 Tauri `setup` 的启动事务中执行。运行期 `open_database/open_read_database` 只能接受完整 V1，command、WebSocket、Agent 工具和后台采集不得以“保险”为由再次调用迁移函数。
- 高频或可能扫描大量行的 SQLite 读取必须使用只读连接并下放阻塞线程；写入保持有界短事务。删除历史数据后优先使用 freelist 复用页，日常维护不得自动 `VACUUM`，需要物理压缩时必须作为显式、可中断且无活动 Agent Run 的独立操作评估。
- 没有读取方、审计价值或恢复用途的上游成功原始响应不得重复持久化；保留结构化事实、抓取状态和有界错误诊断即可。新增索引前必须用实际查询计划确认主键/现有索引不能覆盖，避免为同一列序重复建索引。
- 模型回传的数据库关联 ID 属于不可信文本，不能作为交易安全边界的唯一依据。若允许兼容模型截断或改写，只能在后端用不可变 Run/Profile/账户/环境/标的和完整业务指纹恢复唯一权威记录；已存在但范围不符、候选变化、过期或已消费的记录必须继续拒绝。
- 新闻事件包含多个币种时不得只取数组首项计算市场反应；应对本地具备证据的 USDT/USDS 线性永续逐项计算并声明覆盖率。无币种标签时可以使用 BTC 作为市场代理，但 UI、Agent 和导出必须明确标注“BTC 市场代理”，不能称为全市场指数。
- 交易对选择器不得维护硬编码币种列表。交易终端、图表和市场情报应复用 `MarketAssetsSummary.instruments`，按 `instId/baseCcy/instFamily` 搜索，并在各业务模块继续执行自身的合约类型和结算币种限制。
- 交易对图标统一使用共享 `src/ui/SymbolIcon.tsx`，不得在页面内复制本地路径转换和 `market_icon_data_url` 逻辑。共享组件必须缓存已解析 data URL，并在图片缺失或加载失败时使用基础币种首字母降级。
- 保险基金使用上游 `total` 作为平台风险保证金总额，`details[].balance` 只用于明细；爆仓 REST/WSS 的 `details[]` 是平台事件样本，不能推导全市场爆仓总量。
- 公共 WSS 高频 OI 不得每条消息插入新记录；同一 5 分钟桶在内存覆盖并只持久化最后值。资金费率只有字段变化或进入新桶时持久化，结算周期始终使用上游 `fundingTime/nextFundingTime`。

## 13. 多语言与格式化

- 系统 UI 文案统一进入 `src/i18n/resources.ts`，业务代码使用稳定 key，不得再用显示文案作为导航、状态或分支条件。缺失翻译统一回退英文。
- 语言偏好支持跟随操作系统并持久化到 `ui.local.json`；切换后必须通过 `ui:locale-changed` 同步所有 Tauri 窗口，无需重启。
- Prompt、Skill、用户输入、AI 生成内容和第三方原文必须保持原样，使用 `data-i18n-skip` 或约定的内容容器隔离；不要对任意后端文本做自动翻译。
- 日期、计数和非交易摘要使用 `formatLocalizedDate` / `formatLocalizedNumber`。价格、K 线坐标、委托数量和可复制交易值使用 `formatTradingNumber` 或等价的 `en-US` 数字格式，始终保留点号小数分隔符。
- 新增语言时必须同时更新受支持语言列表、资源目录、Tauri 白名单和 `npm run test:i18n`；长文案需要验证换行、溢出、窄窗口和弹出图表。

## 14. 桌面更新与发行

- 主窗口关闭按钮必须调用进程级退出，释放本地监听端口和 sidecar；桌面端不创建托盘，也不通过隐藏窗口继续后台运行。
- 安装包只接受 Tauri Updater 公钥验证通过的稳定 GitHub Release。版本标签、`package.json`、`src-tauri/tauri.conf.json` 和 Cargo crate 版本必须一致，发行前运行 `npm run test:release-version`。
- 正式发行密钥只能放在 GitHub Actions Secrets 或受控签名环境；私钥、密码、证书和本地生成的签名材料不得提交。Updater 公钥属于验证材料，可以随应用发布。
- 安装包更新与源码更新都必须先创建成功的加密数据快照。快照覆盖 SQLite、账户、代理、AI、通知、界面、关注列表和自定义 Skill，最多保留三份；备份失败必须中止更新。
- 用户数据和凭据必须位于应用数据目录或本地敏感配置目录，不得写进安装目录、前端资源或可被升级替换的源码文件。
- 源码更新只允许干净、未分叉的 `main` 快进到 `origin/main`。存在本地修改、分支不符或历史分叉时只提示原因，不得自动 stash、reset、rebase 或覆盖文件。
- Release 必须分别验证 Windows x64、macOS Apple Silicon 和 macOS Intel 的安装、升级、自动重启及数据保留。没有实际验证的平台不得宣称更新链路已可用。
- Windows Release 的 Rust 缓存必须由 `main` 分支预热并使用稳定共享键；预热时先生成正式构建所需的 sidecar 和 `frontendDist`，再使用 `tauri/custom-protocol` feature 编译。标签构建只恢复缓存、不保存标签专属缓存，避免每个版本重复完整编译和上传无复用价值的缓存。
