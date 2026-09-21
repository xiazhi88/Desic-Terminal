# Agent 库冻结接口契约 v3（多 Agent 协作施工基准）

> **C29 快判模式：实现完成、本版本未开放（`FASTLANE_MODE_ENABLED=false`），下个版本开放。**
> 代码（`src-tauri/src/fastlane.rs` / `scripts/cline-fastlane.mjs` / `src/ui/fastlane/*`）一行未删；
> 本版本只做"开关 + 入口隐藏"，开关点、撤下范围与"下版本开放要做什么"见 `docs/pending.md` §C29.19。

本文档是 `docs/multi-agent-dispatch-plan-v3.md` 的可施工切口，供并行 builder 共用。**凡本文冻结的名称/字段/命令/工具签名，三方（scripts / src-tauri / src）必须逐字一致**；需要变更先改本文档并在提交说明中注明。

董事会已拍板（不得再改）：
1. 内置 agent id 去掉 `auto-` 前缀，改为 `desic-*`，旧 id 走 alias 迁移。
2. 咨询/追问次数**不做上限，也不做可选上限字段**。
3. 旧 `ai_agent_schemes` 模板**删除**，内容自动迁移进 Agent 库。

---

## C1 文件位置与内置 id

- 目录：`<data_dir>/workspace/.cline/agents/<id>/AGENTS.md`（与现有 `cline_skills_dir = <data_dir>/workspace/.cline/skills` 同级）。Rust 侧新增 `RuntimePaths::cline_agents_dir`，路径由 `runtime_paths()` 提供。
- **落盘层由 `src-tauri/src/storage_config.rs` 单独提供**（lead 实现，B-RUST 只调用不重复实现）：`agent_library_dir()`、`agent_bundle_markdown_path(id)`、`read_agent_bundle(id)`、`AgentBundleWrite{path,wrote}` + `write_agent_bundle(id, markdown, overwrite)`、`write_agent_reference(id, rel, content)`、`list_agent_reference_paths(id)`、`read_agent_reference(id, rel)`、`list_agent_bundle_ids()`、`delete_agent_bundle(id)`、`ensure_builtin_agent_bundles()`(+best_effort，挂两个 bootstrap 点)。全部先过 `is_valid_agent_id` 与"单一普通路径段"双重校验（拒绝 `../`、`a/b`、绝对路径、大写、空串）。
- 内置 id 映射（旧 → 新）：

| 旧 id | 新 id | name | role | ~~scopes~~（C15 起作废，见 §C15） | envelope | 依赖 |
| --- | --- | --- | --- | --- | --- | --- |
| auto-market-structure | desic-market-structure | 市场结构 | market_structure | market, derivatives | standard | — |
| auto-order-flow-liquidity | desic-order-flow-liquidity | 订单流与流动性 | order_flow_liquidity | market | standard | — |
| auto-derivatives-positioning | desic-derivatives-positioning | 衍生品仓位 | derivatives_positioning | derivatives, market | standard | — |
| auto-account-risk | desic-account-risk | 账户风险 | account_risk | account, history, market | **risk** | requiresAccount |
| auto-intelligence-flow | desic-intelligence-flow | 新闻与宏观 | intelligence_flow | intelligence | standard | skills: okx-market-intelligence |
| auto-smart-money | desic-smart-money | Smart Money | smart_money | intelligence, derivatives | standard | skills: okx-market-intelligence |
| auto-historical-analogy | desic-historical-analogy | 历史类比 | historical_analogy | history, market | standard | — |
| auto-contrarian-review | desic-contrarian-review | 反方审查 | contrarian | market, derivatives, intelligence, history | standard | — |

- 内置 bundle 在启动时幂等安装（best-effort，与 `ensure_builtin_skill_bundles()` 同构）：指纹一致跳过；用户改动内置文件时**不覆盖**，UI 标注"已本地改动"；内置 agent 不可编辑/删除，只能"复制为自定义"。
- 职责文本初始取自现有 `AUTO_PROFILE_AGENTS.responsibility`（逐字保留口径），结构化展开见 C2；正文真相源是 `docs/agent-library-content-pack.md`，Rust 侧镜像文件 `src-tauri/crates/agent-automation/src/builtin_bodies.rs` **由内容包机械生成，禁止手改**（改正文必须改内容包并重新生成）。
- **依赖列只表达"主要依赖"**：域内部分工具另有门槛（`derivatives` 内的 smartMoney 类需 `okx-market-intelligence`；`history` 内的账户历史工具需绑定账户；`market` 内的 `radar.*` 需 `market-radar-research`）。**不**因此改写 C1 的 skills/requiresAccount 列（避免迁移行为变化）：缺门槛时由 Rust `authorize_ai_tool` 返回明确错误，专家在"数据缺口"里说明即可；UI 目录只做提示，绝不静默剔除。

## C2 AGENTS.md 规范

```markdown
---
id: desic-market-structure
name: 市场结构
role: market_structure
envelope: standard
scopes: [market, derivatives]
skills: []
requiresAccount: false
source: builtin
version: 1
createdAt: 1760000000000
---
## 身份
## 职责
## 方法与证据要求
## 输出偏好
## 数据缺口处理
```

校验规则（Rust 单一实现，命令与工具共用）：

| 字段 | 规则 |
| --- | --- |
| `id` | 必填，`^[a-z0-9][a-z0-9-]{1,47}$`，必须等于目录名 |
| `name` | 必填，去空白后 1–40 字 |
| `role` | 必填，`^[a-z][a-z0-9_]{0,31}$`（推荐枚举：market_structure / order_flow_liquidity / derivatives_positioning / account_risk / intelligence_flow / smart_money / historical_analogy / contrarian / custom） |
| `envelope` | `standard` \| `risk`；**不可关闭**。判定规则（取更严者）：frontmatter 声明 `risk` **或** `role == account_risk` **或** `scopes` 含 `account` → 运行 `risk` 外壳。**缺省（未提供）= `standard`；提供了白名单外的值（如 `"none"`）= 必须 `Err`**（reviewer R2-2 裁定：验收手册 B7 优先，禁止静默降级） |
| `scopes` | 白名单 `market, derivatives, intelligence, account, history`。**缺失或空数组** = 全部只读工具（AI 生成 / `agent.create` 路径可回填 `["market"]` + warning）；**出现白名单外的值** = 必须 `Err` 并列出非法值（reviewer R2-1 裁定，禁止静默过滤） |
| `skills` | 自由 id 列表；未知/未激活只做 UI 提示，不报错、不静默丢弃 |
| `requiresAccount` | 布尔，仅用于 UI 提示与目录标注 |
| `source` | `builtin` \| `custom` \| `ai` |
| `version` | 整数，默认 1 |
| `createdAt` | 整数毫秒时间戳，缺省写入当前时间 |
| 正文 | 非空；单文件 ≤ 200KB；`references/*.md` 可选，路径禁止绝对路径与 `..` |

说明（写入代码注释）：`scopes` 只是**意图声明**，真正的权限边界在 Rust `authorize_ai_tool`（账户绑定、Skill 门槛、`agent_role` 只读、`tool_allowlist`）。固定运行时外壳由侧车无条件前置拼接，AGENTS.md 无法覆盖或关闭；不做文本对抗式过滤。

## C3 Rust 类型与命令（`src-tauri`）

```rust
pub struct AiAgentDefinition {   // 解析结果
    id: String, name: String, role: String, envelope: String,
    scopes: Vec<String>, skills: Vec<String>, requires_account: bool,
    source: String, version: i64, summary: String, body: String, path: PathBuf,
}
pub struct AiAgentSummary {      // 列表用（不返回 body）
    id, name, role, envelope, scopes, skills, requiresAccount, source, version,
    updatedAt: i64, enabledByProfiles: Vec<String>,      // profile id 列表
    missingSkills: Vec<String>, missingAccount: bool, modified: bool,
}
pub struct AiAgentDetail { summary 字段 + content: String }   // content = 完整 AGENTS.md
```

新增命令（camelCase 序列化，注册进 `lib.rs` invoke_handler）：

| 命令 | 入参 | 出参 |
| --- | --- | --- |
| `ai_agents_list` | 无 | `Vec<AiAgentSummary>`（内置 + 自定义，按 source、name 排序） |
| `ai_agent_read` | `{ id }` | `AiAgentDetail` |
| `ai_agent_save` | `{ id?: string, content: string }` | `AiAgentSummary`（**新建时 id 取自正文 frontmatter**，Rust 不改写用户 id；该 id 已占用 → 报错并提示改 id 或用 `ai_agent_duplicate`；内置 id 或 id 与目录不符 → 报错） |
| `ai_agent_duplicate` | `{ id, name?: string }` | `AiAgentSummary`（由 Rust 生成新 id `custom-<slug>-<n>`，source=custom） |
| `ai_agent_delete` | `{ id }` | `()`（仅 custom/ai；同步从所有 profile 的 enabledAgentIds 剔除） |
| `ai_agent_generate` | `{ description: string, name?: string }` | `{ content: string, warnings: Vec<String> }`（AI 草稿，**不落盘**） |

删除命令：`ai_agent_scheme_save`、`ai_agent_scheme_delete`（以及任何方案列表/预览命令，包括注册表条目与前端调用）。`ai_agent_scheme_preview_codex` 若与方案无关则保留。

骨架单一实现（裁决）：Rust 侧提供 `render_agent_skeleton(responsibility, ...)`（五段骨架）作为**唯一**来源，供 `agent.create` 工具与 `ai_agent_generate` 兜底共用，不得各写一份文案。AI 生成/工具创建路径若得到空 `scopes`，回填 `["market"]` 并附 warning（手写文件里的 `scopes: []` 仍按契约语义解释为"全部只读"，不做改写）。

Profile 字段：
- 新增 `enabled_agent_ids_json TEXT NOT NULL DEFAULT '[]'`（`ensure_column` 既有写法）。
- 读写侧：`AiAgentProfile` / `AiAgentProfileInput` 增加 `enabled_agent_ids: Vec<String>`，删除 `multi_agent_mode / multi_agent_max_agents / multi_agents / multi_agent_scheme_id / multi_agent_orchestrator / multi_agent_expert_source` 字段（DB 旧列保留不写不读）。
- 保存时用 Agent 库校验：不存在的 id 丢弃并在返回值/日志中提示（不报错阻断保存）。

迁移（读旧写新，内存迁移 + 首次保存落盘）：
| 旧 | 新 |
| --- | --- |
| `multi_agent_mode=off` | `enabledAgentIds=[]` |
| `multi_agent_mode=auto` | 8 个内置 `desic-*` id |
| `multi_agent_mode=custom` + `multi_agents_json` | 每个 agent → 库文件 `agents/<slug>/AGENTS.md`（role/scopes 原样，source=custom），id 写入勾选 |
| 旧 `multiAgents[].id` 为 `auto-*` | 按 C1 映射为 `desic-*` |
| `multi_agent_scheme_id` → `ai_agent_schemes.agents_json` | 每个 agent → 库文件（source=custom，note 迁移来源）；`instructions` 丢弃并计入迁移报告 |
| `multi_agent_orchestrator=backend` | 忽略，按上表处理 |

- **不新建 `ai_agents` 表**：Agent 库以文件为真相，列表 = 扫目录 + 解析（数量级 10–50，开销可忽略）。`enabledByProfiles` 由 profile 行内 JSON 统计。
- `ai_agent_schemes` 表结构保留（回滚需要），命令层删除；迁移只在读取 profile 时触发一次（幂等：库文件不存在才写）。

## C4 运行配置载荷（Rust → sidecar）

背景 Run / 审查 Run / 研究会话的 config JSON 中，**删除**：`multiAgentMode`、`multiAgentMaxAgents`、`multiAgents`、`multiAgentSchemeId`、`multiAgentOrchestrator`、`multiAgentExpertSource`；**新增**：

```json
"enabledAgents": [{
  "id": "desic-market-structure",
  "name": "市场结构",
  "role": "market_structure",
  "envelope": "standard",
  "scopes": ["market", "derivatives"],
  "skills": [],
  "requiresAccount": false,
  "source": "builtin",
  "version": 1,
  "summary": "检查多周期价格结构、趋势、波动、成交、盘口和关键失效位，明确事实与推断。",
  "body": "## 身份\n..."
}]
```

- `enabledAgents` = 该 Profile 勾选且库中存在的 Agent（含正文），顺序按勾选顺序去重；**不做数量截断、不做相关性打分、不做资格静默过滤**。
- 缺账户/缺 Skill 不剔除：在 `summary` 前由侧车拼一句提示（"当前 Profile 未绑定账户，account 类证据不可用"）作为该专家任务前缀。
- 侧车的"协作是否开启"判定统一为 `enabledAgents.length === 0`（`disabled:lead-dispatch-off` 同步改此语义）。
- **C27 追加键**：`agentProfileEnvironment`（该 Profile 绑定账户后归一化的 `live` / `demo`），与既有 `agentProfileAccountId` / `agentProfileTargetLeverage` / `agentProfileSymbols` 一起构成侧车注入子 Agent 的 5 行事实块（账号 / 环境 / 目标杠杆 / 关注品种 / 当前时间）。改为让主 Agent 转述会让"漏写环境"变成一个**静默**错误，故这 5 项恒由系统注入。

## C5 侧车提示词与调度（`scripts/`）

- 专家系统提示词 = **固定外壳（代码）** + `\n` + `agent.body`。
  - 外壳内容 = 现 `configuredProfileAgentSystemPrompt` 中除 `职责：${responsibility}` 与角色文案外的全部硬约束（只读、证据时间戳/快照、不替主 Agent 决策、报告不可信、不必 JSON、充分即返回）；`envelope === "risk"` 时追加现有 USDT 线性永续风险口径与 `trade.precheck` 证据要求。
  - `职责：` 一行由 `agent.summary` 提供（正文已含详细职责）。
- 专家任务 = 现 `configuredProfileAgentTask`（保留"你的唯一任务" + 历史复核规则 + "只完成职责范围" + **5 行事实块**），去掉预算相关文案；**原始 Profile 长文注入已由 C27 删除**（"该问什么"改由主 Agent 在点名 `task` 里自己写）。
- 主 Agent 目录注入：结构化块（每行 `- <id> | <name> | <role> | <summary>`）+ 一句"可点名专家 = 本名单；名单为空则不要点名，独立完成本轮"。
- **删除**：`runConfiguredProfileAgents()` 两波执行、复核波（`isReviewProfileAgent`）、`selectProfileAgentOutcome`、`multiAgentVetoBlocksTool` 与 `orchestration.veto`/`multiAgentVeto` 全链、`truncateProfileAgentReport` 及全部截断调用、`slice*sByTokens`、`estimateProfileAgentReportTokens`、`createProfileAgentStallWatchdog`、`PROFILE_*` 预算常量（`REPORT_LIMIT`/`REPORT_TOKEN_BUDGET`/`STALL_TIMEOUT_MS`/`TOTAL_TIMEOUT_MS`/`MAX_CONSULTS_PER_RUN`/`FOLLOW_UPS_PER_EXPERT`/`AUTO_MULTI_AGENT_MAX`/`CUSTOM_MULTI_AGENT_MAX`/`MAX`）、`AUTO_PROFILE_AGENTS`、`eligibleAutoProfileAgents`、打分表与关键词 boost、`resolveProfileMultiAgents`。
- **新增**：
  - `normalizeEnabledProfileAgents(config) -> EnabledAgent[]`（去重、丢弃缺 id/name/body 的条目、不截断、不打分）。
  - `createProfileAgentProgressPulse({ notifyAfterMs = 120_000, repeatEveryMs = 120_000, onNotice })`：无进展只发通知**永不中断**；事件类型 `agentProgressNotice`，负载 `{ agentId, agentName, elapsedMs, silentMs, phase }`，UI 侧显示为普通进度提示。
  - 报告原样回流：`consult_expert` / `follow_up` 返回的 `report.text` 不再经过任何长度变换；`follow_up` 不做次数限制。
- AI 研究（交互式主会话）与后台 Run 共用同一套工具与提示词；后台 Run 只是 `backgroundRun: true`。

## C6 工具面（两侧一致）

| 工具 | 参数 | 返回 | 角色 | 可用范围 |
| --- | --- | --- | --- | --- |
| `agent.list` | `{}` | `{ agents: AiAgentSummary[] }` | 只读 | 主 Agent：交互研究 + 后台 Run |
| `agent.read` | `{ id: string }` | `{ id, name, role, content }` | 只读 | 同上 |
| `agent.create` | `{ name, role, responsibility, scopes?, skills?, envelope?, references?: [{path, content}] }` | `{ id, path, name, role, warnings? }` | 写入 | **仅主 Agent + 交互式会话** |
| `agent.update` | `{ id, content }` | `{ id, path }` | 写入 | 同上；内置 agent 拒绝（提示改用 `agent.duplicate`） |

- JS 侧（`scripts/cline-tool-policy.mjs`）：新增 `AGENT_AUTHORING_TOOLS = new Set(["agent.list","agent.read","agent.create","agent.update"])`；`allKnownToolNames()` 纳入；`resolveToolPolicy` 新规则：
  - **显式角色校验**：`String(config?.agentRole ?? "").toLowerCase() !== "main"` → `disabled:agent-authoring-main-only`。**不得**用 `normalizeAgentRole()` 的结果判断——它对未知/缺失值回退 `"main"`，会让非主角色静默拿到授权（reviewer R2-3）。主会话由 `createDesicTools` 显式注入 `agentRole: "main"`，故不影响正常路径。
  - `agent.create` / `agent.update` 且 `backgroundRun === true` → `disabled:agent-authoring-interactive-only`
  - `agent.list` / `agent.read` 不额外限制（主 Agent 两种会话都可用）
- Rust 侧（`lib.rs` `authorize_ai_tool`）：同规则复核（`agent.create/update` 要求 `is_main && run_context 非后台`），并在 `execute_ai_tool` 中实现（写盘/解析走同一套 Agent 库函数）。
- UI：`src/ui/aiToolPresentation.ts` 与 i18n 补 `agent.list/read/create/update` 标签与图标。
- 工具创建出的 Agent：`source = "ai"`；`agent.create` 用 `responsibility` 渲染五段骨架正文；`agent.update` 接受完整 AGENTS.md 文本（frontmatter 必须合法且 id 匹配）。
- **非法值三条路径的处置（裁定后固化）**：手写文件 / `ai_agent_save` / `agent.create` 遇到白名单外的 `scopes` 或 `envelope` → **一律 Err**（禁止静默过滤或降级）；只有"缺失 / 空"才走默认值与回填。`ai_agent_generate`（草稿）保持"永不失败"：非法值剔除 + 显式 warning，且仍按 envelope 取严规则判定。

## C7 前端类型与 i18n

`src/types.ts`：
```ts
export type AiAgentEnvelope = "standard" | "risk";
export type AiAgentSource = "builtin" | "custom" | "ai";
export type AiAgentSummary = { id, name, role, envelope, scopes: string[], skills: string[],
  requiresAccount: boolean, source: AiAgentSource, version: number, updatedAt: number,
  enabledByProfiles: string[], missingSkills: string[], missingAccount: boolean, modified: boolean };
export type AiAgentDetail = AiAgentSummary & { content: string };
```
- `AiAgentProfile` 增加 `enabledAgentIds: string[]`；删除 `multiAgentMode / multiAgentMaxAgents / multiAgents / multiAgentOrchestrator / multiAgentExpertSource / multiAgentSchemeId` 及其编辑 UI。
- 删除 `AiAgentScheme*`、`AiAgentTemplatePhase`、`AiAgentSchemeDraft` 等方案模板类型与 UI。
- **运行历史兼容**：`profileSnapshotJson` 等旧快照可能仍含旧字段，渲染处若读取旧字段必须保留只读兜底（`asRecord` + 可选读取），不得因字段消失而崩。

i18n：`src/i18n/resources.ts` 内 **zh-CN 与 en 两套 catalog 都要加**（`automation:*` 命名空间）：
`agents`、`agentsEmpty`、`agentsIntro`、`createAgent`、`createAgentWithAi`、`agentName`、`agentRole`、`agentResponsibility`、`agentScopes`、`agentSkills`、`agentEnvelope`、`agentEnvelopeStandard`、`agentEnvelopeRisk`、`agentSourceBuiltin`、`agentSourceCustom`、`agentSourceAi`、`agentDuplicate`、`agentDelete`、`agentDeleteConfirm`、`agentSave`、`agentSaved`、`agentBuiltinReadonly`、`agentModified`、`agentNeedsAccount`、`agentMissingSkills`、`agentEnabledProfiles`、`agentGenerateHint`、`agentGenerateAction`、`agentGenerateFailed`、`profileAgents`、`profileAgentsHint`、`profileAgentsEmpty`、`profileAgentsSelectAll`、`profileAgentsClear`、`profileAgentEmptyStateHint`。
`scripts/test-i18n.mjs` 必须保持通过（键值两端齐全）。
插值裁决：允许 `{{name}}` / `{{skills}}` / `{{count}}` 插值；**不加 `_one/_other` 复数后缀**；`count === 0` 时 UI 不渲染徽标（不显示 "0"）。

## C9 一次性侧车请求：AI 生成 Agent 草稿

`ai_agent_generate` 复用既有「一次性请求」通道（锚点：Rust 侧请求 `src-tauri/src/lib.rs:15360`、响应分派 `lib.rs:14863`；侧车侧处理 `scripts/cline-sidecar.mjs:5079`、实现 `generateTitle` `cline-sidecar.mjs:4543`）。

- 请求（Rust → sidecar stdin）：`{ "type": "generateAgentDraft", "requestId": "<uuid>", "description": "<用户描述>", "name": "<可选名称>", "model": "<解析后的模型名>", "config": { "provider": "...", "model": "...", "baseUrl": "...", "apiKey": "...", "contextWindow": <int>, "permissionMode": "advisor", "reasoningDepth": "none" }, "prompts": { "system": "...", "user": "...", "messages": [{"role":"user","content":"..."},{"role":"assistant","content":"..."}] } }`
  - `prompts` 是提示词**真相源**（内容包 §2 → Rust 内嵌常量）。侧车**必须优先消费它**（`prompts.system` / `prompts.user` / `prompts.messages` 配对成 few-shot），内部常量仅作兜底；两侧不得各写一份正文（reviewer P2 修复，已加源码级断言）。
  - **`config` 必须与标题生成同款补全**（2026-09-18 修复）：早期版本只发 `type/requestId/description/name/prompts`，SDK 直接以 `path:["model"] Invalid input: expected string, received undefined` 拒绝（lead 探针实测）。现在 `config` 七键齐备 + 顶层 `model` 兜底；侧车优先级为 `input.config.model` → `input.model` → **不硬造默认值**（缺配置时 `config` 连 `model` 键都不写，并追加 warning「草稿请求未携带模型配置」；provider 抛错时同一条告警拼在失败 `message` 前缀）。
  - `ai_agent_generate` 入参：`{ description: string, name?: string, model?: string }` —— `model` 为 `ai_config_summary.models[].id`，**不传 = 当前模型**；传了但精确匹配不到（`id`/`model`/`name` 三者皆不中）→ **`Err("未找到模型 X；可用模型：a、b")`，绝不静默回落**；无任何模型 → `Err("尚未配置可用的 AI 模型")`。
- 响应（sidecar stdout）：成功 `{ "type": "agentDraftResult", "requestId": "...", "ok": true, "roleJson": "<模型输出的角色 JSON 原文>", "warnings": [] }`；失败 `{ ..., "ok": false, "message": "..." }`
- **职责分工（裁决）**：sidecar 只负责发提示词、收模型输出、尽量 `JSON.parse` 校验形状（失败也可把原文放进 `roleJson` 并给出 warning）；**frontmatter 渲染、白名单校验（role/envelope/skills）、五段骨架兜底全部在 Rust 侧**，由 `render_agent_markdown` / `render_agent_skeleton` 完成（C15 起无 scopes 校验）。因此 `agentDraftResult` **不返回 AGENTS.md 全文**。
- 超时与错误处理沿用标题生成同款（不新增预算限制）；草稿**不落盘**，由用户确认后走 `ai_agent_save`。
- 生成提示词模板由 designer 产出（`docs/agent-library-content-pack.md` §2），Rust 侧以内嵌常量实现。

## C10 补充：新增工具的额外登记点（lead 追加，施工时逐条核对）

实测发现新工具要在**六个**地方登记，漏一处就会出现"定义存在但被静默丢弃"或"未知工具"报错：

1. **JS 工具定义**：`scripts/cline-sidecar.mjs` `createDesicTools` 内的 `tool(...)`。注意 `tool()` 里有三道静默丢弃闸门：`toolAllowlist`、`multiAgentVetoBlocksTool`（本次删除该函数及其调用）、`describeToolPolicy(...).allowed`。
2. **JS 工具策略**：`scripts/cline-tool-policy.mjs` 的 `allKnownToolNames()`（`buildToolPolicies` 靠它遍历生成策略，漏了就没有策略）与 `resolveToolPolicy` 新规则。
3. **Rust 工具实现**：`src-tauri/src/lib.rs` `execute_ai_tool` 分支；末尾 `_ => Err("未知 AI 工具")`（约 17746 行）会兜住漏登记。
4. **Rust 授权**：`authorize_ai_tool`——`is_read` 只读分类列表（约 16265 行起）必须包含 `agent.list` / `agent.read`；`agent.create` / `agent.update` **不得**列入只读分类（它们写盘）。另需新增"非主 Agent 拒绝 `agent.*`"与"后台 Run 拒绝 `agent.create/update`"两条。
5. **Rust 专家工具白名单**：`profile_agent_scope_allows_tool`（约 16025 行）与配置专家会话构造 `tool_allowlist` 的路径——scopes 的真相源从旧 profile JSON 改为 Agent 库 frontmatter，改造后必须仍按新来源生成白名单。
6. **前端呈现**：`src/ui/aiToolPresentation.ts` + i18n 标签（缺失时 UI 退化为裸工具名，不致命但算未完成）。

补充澄清（修正 C6 措辞）：**当前没有逐工具审批流**——`resolveToolPolicy` 对"允许"的工具一律返回 `autoApprove: true`（`cline-tool-policy.mjs:422`），`requestToolApproval` 只是 SDK 回调通道。因此 `agent.create/update` 的安全边界 = 仅主 Agent + 仅交互式会话 + Rust 侧授权复核，**不要**把"用户逐次批准"当作已存在的机制来依赖。

## C11 进度心跳事件（跨三棵树，必须同批落地）

`agentProgressNotice` 不是"发出去就有"的事件：Rust 的 `AiEvent` 是 **serde tagged enum**（`src-tauri/src/lib.rs:1791`，`#[serde(tag = "type", rename_all = "camelCase")]`），未知 `type` 会反序列化失败并被丢弃。三侧必须同时改：

- **Rust（新增枚举变体，与 `AgentDone` 同风格）**：
```rust
#[serde(rename_all = "camelCase")]
AgentProgressNotice {
    session_id: String,
    agent_id: String,
    agent_name: String,
    elapsed_ms: i64,
    silent_ms: i64,
    phase: String,
},
```
- **JS（emit 形状，字段逐字对应）**：
```json
{"type":"agentProgressNotice","sessionId":"<id>","agentId":"<id>","agentName":"<name>","elapsedMs":600000,"silentMs":120000,"phase":"consult"}
```
`phase` ∈ `consult | follow_up`；同一专家在无进展期间每 `repeatEveryMs` 重复发一次，**不得**中断会话。
- **TS（`src/types.ts` 的 `AiEvent` union 加一条）**：
```ts
| { type: "agentProgressNotice"; sessionId: string; agentId: string; agentName: string; elapsedMs: number; silentMs: number; phase: string }
```
UI 渲染为**低调的进行中提示行**（不产生未读徽标，`aiEventProducesUnread` 不加入该类型），文案例如"专家「市场结构」仍在分析（已 8 分 12 秒）"。

## C12 i18n 跨树耦合（B-JS 与 B-UI 必须同批对齐）

- 旧多 Agent 协作文案（`resources.ts` 内 "collaboration" 共 90 处：`collaborationBuiltinAgent*`、`collaborationScope*`、`profileCollaboration*` 等）随旧编辑器一起删除。
- `scripts/test-i18n.mjs` 的 `dynamicReferences` 硬编码了这批旧键 → **B-JS 必须把它们替换为契约 C7 的新键清单断言**（依赖键名，不依赖措辞），否则删键即测试失败。
- 新组件用 `useTranslation(["automation","common"])` + `t("agentXxx")`（**无 `automation:` 前缀**），现有正则抓不到 → 新键的 zh/en 双侧存在性由 B-UI 自行核对；`test:i18n` 只兜住 C7 键名存在性。

## C13 UI 测试钩子（冻结，供 Playwright smoke 使用）

`scripts/smoke-automation-preview.mjs` 目前断言的是**旧协作 UI**（`.automation-collaboration-mode`、`.automation-auto-agent-slot` 恰好 8 个、`.automation-agent-inline-editor`、`.automation-agent-scope-note` …），重构后必然失败。为打破"UI 选择器 ↔ smoke"的依赖死锁，冻结以下 `data-*` 钩子（**additive，不改动既有类名体系**）：

| 钩子 | 位置 |
| --- | --- |
| `[data-agent-selector]` | Profile 编辑器内的勾选列表根节点 |
| `[data-agent-selector-item][data-agent-id="<id>"][data-agent-source="builtin\|custom\|ai"]` | 每个勾选项（内部必须含 `input[type="checkbox"]`） |
| `[data-agent-selector-empty]` | 勾选为空的空态节点 |
| `[data-agent-select-all]` / `[data-agent-select-clear]` | 全选 / 清空按钮 |
| `[data-agents-tab]` | agents tab 根节点 |
| `[data-agent-library-item][data-agent-id="<id>"]` | Agent 库列表行 |
| `[data-agent-editor]` | AGENTS.md 编辑区（textarea 或可编辑节点） |
| `[data-agent-create-manual]` / `[data-agent-create-ai]` | 两个创建入口 |
| `[data-agent-ai-description]` / `[data-agent-ai-generate]` | AI 创建对话框的输入与生成按钮 |
| `[data-agent-save]` / `[data-agent-duplicate]` / `[data-agent-delete]` | 保存 / 复制为自定义 / 删除 |

## C14 协作编排总开关（2026-09-18 董事会追加）

需求（用户反馈 #1）：**"协作编排"必须能显式关闭**；关闭时不允许选择参与 Agent，开启后才可勾选。

- **Profile 字段**：新增 `collaborationEnabled: boolean`（DB 列 `collaboration_enabled INTEGER NOT NULL DEFAULT 0`）。
- **语义**：
  - `collaborationEnabled === false` → 运行载荷 `enabledAgents: []`（等价旧 `off`）：不注入专家目录、不注入调度规范、不创建专家会话。
  - `collaborationEnabled === true` + 勾选名单为空 → 同样是"主 Agent 独立工作"，但 UI 显示为"协作已开启但未勾选任何专家"并给出提示（这是配置不完整，不是关闭）。
  - **关开关不清空勾选**：`enabledAgentIds` 原样保存，重新开启即恢复原选择。
- **JS 侧零改动**：判定仍是 `enabledAgents.length === 0`（开关在载荷构造处生效），所以 `disabled:lead-dispatch-off` 与既有测试不受影响。**这也是本设计的关键性质**：开关是"载荷闸门"，不是新的 JS 分支。
- **迁移（读旧写新）**：旧 `off`（且无 scheme）→ `false`；旧 `auto` → `true` + 8 个内置 id；旧 `custom` 或引用 scheme → `true` + 迁移出的 id；`enabled_agent_ids_json` 非空的旧行一律视为 `true`。
- **UI**（2026-09-18 二轮整改后定稿）：
  - 勾选器**第一行**就是协作编排总开关（`data-agent-collaboration-toggle`，原生可见 checkbox + `appearance:none` 自定义 pill，**不得** `display:none`/`visibility:hidden`/`opacity:0`），开关必须**排在列表之前**（DOM 顺序）。
  - **关闭时整个「参与 Agent」区块不渲染**（标题、计数、`全选内置`/`清空`、`管理 Agent 库`、勾选列表全部卸载）；只保留开关行 + **唯一一处**提示 `[data-agent-collaboration-off-hint]`（文案"关闭协作后主 Agent 独立完成，不点名任何专家"），不得出现第二处同义提示。
  - **开启后才展开**列表与动作区；`[data-agent-selector]` 上的 `data-collaboration-enabled` 始终反映真实状态。
  - `[data-agent-selector]` 带 `data-collaboration-enabled="true|false"`；关闭态下 `[data-agent-selector-item]`/`[data-agent-select-all]`/`[data-agent-select-clear]`/`[data-agent-selector-empty]` 要么不在 DOM、要么不可见（smoke 两者都接受，但用户绝不能看到或操作它们）。
  - Profile 卡片摘要：关闭 → "协作已关闭 · 主 Agent 独立工作"；开启且为空 → "协作已开启 · 未勾选专家"；开启且有勾选 → "已勾选 N 个专家 · 名单"。
  - `全选内置` / `清空` 在关闭状态下不可用（清空不改开关）。
- **验收**：`scripts/smoke-automation-preview.mjs` 增加断言 —— 关闭开关后勾选框全部 disabled、`data-collaboration-enabled="false"`；重新开启后恢复可勾选；Rust 侧断言 `collaborationEnabled=false` 的 Profile 其运行载荷 `enabledAgents` 为空、且 `enabled_agent_ids_json` 未被清空。

## C15 scopes 概念移除（2026-09-18 董事会拍板；**取代本文件一切 scopes 相关条款**）

结论：**AGENTS.md 不再有 `scopes` 字段**。专家的只读工具面改由**主 Agent 在点名时决定**：缺省不限制（全部只读工具），可按需收窄。上文 C1 表头 `scopes` 列、C2 的 `scopes` 行、C3/C4/C7 里的 `scopes` 字段、C6 的 `agent.create` 参数、内容包 §1/§2 的 scopes 内容，**一律以本节为准**。

### C15.1 文件与类型
- frontmatter 合法字段收窄为：`id / name / role / envelope / skills / requiresAccount / source / version / createdAt`。
- 文件里出现 `scopes` → **忽略、不报错**；`ai_agents_list` 该条附一次性提示 `scopesDeprecated: true`（UI 显示一行灰字"scopes 字段已废弃（C15），可删除"）。
- `AiAgentDefinition` / `AiAgentSummary` / `AiAgentDetail` **删除 `scopes` 字段**（crate 与 TS 同步）。
- `envelope` 取严规则改为：声明 `risk` **或** `role == account_risk` → `risk`（**不再**由"scopes 含 account"推导）。
- 内置 8 个 Agent 的 spec 表删除 `scopes`；内容包 §1 正文里"方法与证据要求"中的证据偏好**保留为纯提示词**，不再有权限含义。

### C15.2 点名与授权（唯一新增接口）
- `consult_expert` / `follow_up` 新增**可选**参数 `scopes?: string[]`（白名单仍是 `market / derivatives / intelligence / account / history`）：
  - **不传** → 该专家获得**全部只读工具**（缺省不限制）；
  - **传** → 仅授予所声明域对应的只读工具；
  - **含白名单外的值** → 工具调用报错（列出非法值，禁止静默过滤）；
  - **空数组 `[]`** → 等价于不传（全部只读），返回里注明。
- 工具返回（主 Agent 与轨迹共用）：`{ ok, expertId, expertName, grantedScopes: string[], report }`，`grantedScopes` = 本次实际授予的域（缺省时是全部五个）。
- 主 Agent 目录注入（C5）不再列各专家的范围，改为固定一行：`可选收窄：market / derivatives / intelligence / account / history；不传则该专家获得全部只读工具。`
- **Rust 授权链**：
  - 删除"专家 scopes 必须等于文件/快照值"这条校验（`authorize_background_delegated_agent` 相应改写）；
  - 新规则：本次声明的 `configured_agent_scopes` 必须 ⊆ 白名单（非法 → 拒）；平台门槛独立强制 —— `account.*` 需 Profile 绑定账户、`intelligence.*` 需 `okx-market-intelligence`、`radar.*` 需 `market-radar-research`、专家恒 `advisor` 只读、后台 Run 不得创建/修改 Agent、报告仍按不可信证据注入。
  - **知悉并接受**：去掉 scopes 后"专家是否越界读了自己不该读的域"不再由文件保证，而是"主 Agent 声明 + 白名单 + 平台门槛"三者约束；写权限与账户/技能门槛**不受影响**。

### C15.3 UI
- 删除：创建对话框的 scopes chip 段、列表行的范围标签、详情 facts 的"证据范围"行、勾选器的范围徽标、AI 草稿里的范围展示；相关 i18n 键（`agentScopes` / `agentScopesAll` / `agentScopesAllHint` 等）删除。
- 新增：专家会话（AI 研究 / 运行轨迹）显示 `本次授予范围：market · derivatives`（来自 `grantedScopes`）；缺省全量时显示 `全部只读`。
- 保留：`envelope`（风险审查徽标）、依赖提示（需绑账户 / 未激活 Skill）—— 与 scopes 无关。

### C15.4 迁移与兼容
- 旧库文件：`scopes` 忽略即可，不重写用户文件；不因它报错。
- 旧载荷/旧 Run 快照里带 `scopes` → 反序列化时忽略（不报错）；新载荷不再下发该键。
- 旧 Profile 的 `custom`/`scheme` 成员：`scopes` 丢弃，不再写入新文件。

### C15.5 测试
- Rust：含 `scopes` 的文件解析成功 + `scopesDeprecated` 提示；`AiAgentSummary` 序列化不再有 `scopes` 键；声明白名单外域 → 拒；缺省 → 全部只读工具；收窄 → 只给子集；平台门槛与"后台不得创建 Agent"不变。
- JS：`normalizeEnabledProfileAgents` 不再要求/传递 scopes；`consult_expert`/`follow_up` 的 `scopes` 校验与 allowlist 构造（缺省 = 全部只读工具）；负面断言：仓库内不再出现 `PROFILE_AGENT_SCOPE_TOOLS` 与 scopes 相关 UI 钩子。
- UI/smoke：agents tab 断言不存在 scope chip/标签；轨迹里能看到"本次授予范围"。

## C17 草稿生成的过程可视化（2026-09-18 董事会追加；P1/P2/P3）

问题：点「生成草稿」后界面毫无反应 —— 草稿走一次性通道，侧车 `core.start({config, prompt, interactive:false})` **没有订阅会话事件流**（普通会话在 `cline-sidecar.mjs:4718` 用 `cline.subscribe`），因此模型的逐字输出根本没上传；同时侧车自设 **120s 硬超时**早于 Rust 的 180s，用户等满 2 分钟会先被判超时。

### C17.1 P1 生成中即时状态（纯 UI）
- 钩子 `[data-agent-draft-progress]`：生成中卡片，必须包含**秒表计时**（1s tick）、**阶段文案**（准备提示词 → 已发送请求 → 模型正在生成 → 收尾）、**模型名**（`由 <名称> · <model> 生成中`）、**已生成字符数**（来自 C17.2 的 `chars`）。
- 生成按钮 loading（禁用 + 文案"正在生成…"）；终态三态明确：失败（显示原因）/ 取消（"已取消"）/ 超时。
- 不做百分比进度条（模型生成没有真实百分比，估一个假进度属欺骗）。

### C17.2 P2 真流式（跨三棵树，同 C11 模式）
- 侧车在草稿会话建立后订阅该 runtime 会话，把助手文本增量合并（建议 50–100ms 或每 N 字符，**不得吞掉末尾**）后发：
```json
{"type":"agentDraftDelta","sessionId":"<sessionId>","requestId":"<requestId>","delta":"<本次新增文本>","chars":123}
```
  `chars` = **累计已生成字符数**。
- Rust `AiEvent` 新增变体（`#[serde(rename_all = "camelCase")]`，字段逐字对应 `session_id / request_id / delta / chars`）；**正常转发给前端**，但**不进流检查点/不持久化、不产生未读**（瞬时增量）。
- TS：`AiEvent` union 加 `| { type: "agentDraftDelta"; sessionId: string; requestId: string; delta: string; chars: number }`，**不加入** `aiEventProducesUnread`。
- UI：`[data-agent-draft-stream]` 逐字实时显示模型**原始输出**（等宽、保留换行、自动滚底）；事件按 `requestId` 过滤（防上一次请求残留）；`agentDraftResult` 到达后切回现有草稿编辑器路径（源码/preview、warnings、"由 X 生成"）。
- 订阅必须在**成功/失败/取消/超时四条路径**都 unsubscribe。

### C17.3 P3 取消与超时对齐
- 侧车命令：`{"type":"cancelAgentDraft","requestId":"<id>"}` → abort 该草稿会话 + unsubscribe，并回 `{"type":"agentDraftResult","requestId":"<id>","ok":false,"message":"草稿生成已取消"}`；**重复取消幂等**（不抛错）。
- Rust 命令：`ai_agent_generate_cancel { requestId }` → 经既有 `pending_agent_draft_commands` 定位并转发取消；**请求不存在时幂等 Ok**；等待方收到 `Err("草稿生成已取消")`，且 pending 表项在超时/取消两条路径都被清理（不泄漏）。
- **requestId 归属（2026-09-18 裁定，修正跨树缺口）**：Rust 原先只自生成 `agent-draft-<ms>-<suffix>`，UI 在收到首个 delta 前不知道 id → **取消一个还没吐字的请求做不到**。现裁定：
  1. `ai_agent_generate { description, name?, model?, requestId? }` **接受 UI 传入的 requestId**（先校验格式 `^[A-Za-z0-9_-]{8,64}$`，非法则忽略并自生成），此后该请求的所有 `agentDraftDelta` 与 `agentDraftResult` 都用它 —— UI 从点击那刻起就有稳定标识，可严格按 id 过滤与取消；
  2. `ai_agent_generate_cancel` 在 requestId 为空/未知时，**取消当前唯一在途的草稿请求**（同时至多一个），仍幂等；
- **超时对齐**：侧车自设超时不得早于 Rust 的 180s（建议去掉自设超时，由 Rust 超时 + 用户取消兜底，或 ≥300s）。
- UI：`[data-agent-ai-cancel]` → 取消中态 → 收到 `ok:false` 后收尾"已取消"；命令报错按幂等处理，不得把用户卡在 loading。

### C17.4 测试
- 侧车：源码级（subscribe/unsubscribe、事件字段、取消分支）+ 行为级（假 core：delta 按序且 `chars` 单调递增 → 结果；取消 → `ok:false` + 不再有后续 delta）。
- Rust：`agentDraftDelta` JSON → 事件变体映射、不进检查点白名单；取消命令的幂等与表项清理。
- UI/smoke：生成中 `[data-agent-draft-progress]` 可见（计时/阶段/模型/字符数）、`[data-agent-draft-stream]` 文本非空且递增、`[data-agent-ai-cancel]` 存在且取消后不再追加文本。预览夹具注入的假生成器需**分段产出 delta**，使浏览器预览也能验证整链。

## C18 批量点名与并行/串行（2026-09-18 董事会追加；A+C）

**问题（真实运行实测）**：一次 21m29s 的运行里 6 位专家**全部串行**，耗时相加 14m56s（≈70%），而 UI 却写着「第一阶段·并行取证」（那是 v2 两波编排的遗留文案，v3 已无此机制）。

**实测证据（lead 真模型 transcript）**：专家 1 `toolResult` → 专家 2 `toolCall` 相隔 **23ms**，且模型是"拿到上一份报告才决定下一位"；`AgentCollaborationTrace.tsx:280/286` 的"并行取证/反方审查"为硬编码文案。

### C18.1 新工具 `consult_experts`（批量点名）
- 入参：`{ experts: [ { expertId, task, scopes?, mode? } ] }`，`experts` 长度 ≥1；每项语义与 `consult_expert` 一致（`task` 为派驻任务，`scopes` 可选收窄，缺省=全部只读工具）。
- **`mode`: `"parallel" | "serial"`，可选，默认 `"parallel"`**。**由主 Agent 按专家职能自行决定**：彼此独立、只读、不共享状态 → `parallel`；依赖前序结果、或会争抢同一外部资源（账户状态、同一行情快照口径）→ `serial`。工具描述里必须写清这条判断规则。
- 执行语义（**冻结**）：
  1. 按数组顺序处理；**`serial` 专家是屏障** —— 它与任何其它专家都不得时间重叠（进入前必须等已启动的并行批次全部结束）；
  2. 连续多个 `parallel` 专家组成一个批次，用并发执行完成，**并发上限常量 `PROFILE_AGENT_MAX_CONCURRENCY`（2026-09-19 起为 5；初版为 3，因"一次调用必等整批返回"使批次轮次成为主要瓶颈而上调）**（避免 OKX 公共 REST 限频与本地并发压力）；
  3. 单次 `consult_experts` 的墙钟时间 ≈ Σ(串行专家) + Σ(各并行批次的最大值)。
- 返回：`{ ok, results: [ { expertId, expertName, mode, grantedScopes, report } ], failures: [ { expertId, message } ] }`；
  **单个专家失败不得让整批失败**（部分成功照常回流），全部失败才 `ok:false`。
- `consult_expert`（单数）与 `follow_up` **保留**，语义不变（单点咨询/追问）。
- 工具策略登记：`consult_experts` 与 `consult_expert` 同闸门（名单为空 → `disabled:lead-dispatch-off`；仅主 Agent 可见）。

### C18.2 专家状态隔离（并行的前提）
- 现在每位专家的 runner 由 `createConfiguredProfileAgentRunner({ sessionId, command, state, runtimeSessionId })` 创建并**共享父会话 `state`**。并行前必须给每位专家**独立状态**（取消标志、`hasProviderProgress`、空闲刷新时间、进度心跳），否则会互相污染。
- **取消传播**：父会话取消 → 全部在跑专家一律 abort（含尚未启动的批次）；单个专家超时/失败不取消其它专家。
- `agentProgressNotice` 仍按 `agentId` 区分（C11 字段不变），因此并行期可见多条进度。

### C18.3 UI 如实呈现
- 删除「第一阶段·并行取证 / 第二阶段·反方审查」硬编码文案，改为与 v3 一致的措辞；
- 轨迹需体现**每位专家的执行方式**（`parallel`/`serial`）与**时间重叠**（lane 时间轴不得再暗示"两波"）；没有第二批时不渲染空阶段；
- smoke 断言需随之更新（旧断言依赖 v2 阶段文案与预览夹具）。

### C18.4 验证
- 侧车：行为级测试（并行批次时间重叠 / `serial` 屏障成立 / 并发不超过上限 / 单专家失败不影响整批 / 取消传播）；工具策略测试（名单为空时两个工具都被拒）。
- **端到端**：真模型探针必须观测到**至少两位被标 `parallel` 的专家 `agentStart` 时间区间重叠**，而被标 `serial` 的专家与任何专家都不重叠（lead 亲自执行）。
- 契约兼容：`consult_experts` 出现后，`consult_expert` 的既有断言与 C15 授权链（逐专家 `configuredAgentId` + scopes ⊆ 白名单 + 平台门槛）保持有效。

## C19 试判阶段（triage）：先判有无必要，再决定是否深度多专家

**背景**：唤醒来自"定时 + AI 自写观察条件"，实测常在无边际变化时也叫起一次深度运行（真实运行 6.18M–8.34M input tokens）。董事会决定引入**试判阶段**：唤醒后先由**主 Agent**用只读工具快速判断"是否有必要深度分析"，无必要则直接收尾。

### C19.1 配置（Profile 级，含全局默认）
```jsonc
triage: {
  mode: "enforce",              // off | shadow | enforce —— 默认 enforce（董事会决定）
  tools: ["market", "account", "intelligence", "radar"],  // 试判允许的只读域（最宽集合）
  maxSkips: 3,                  // 连续跳过上限，超过强制深度
  maxSilenceMinutes: 120,       // 最长静默，超过强制深度
  skipSampleRate: 0.2,          // ★ 抽样复检：跳过时按此概率仍然深度执行，用于持续测量漏检
  escalate: {                   // 硬升级清单（Rust 预判；任一命中即强制深度）
    positionOrOrderChanged: true,
    stopDistancePct: 1.5,       // 止损距离 ≤ 1.5% 强制深度
    marginRatioPct: 150,        // ★ 保证金率 ≤ 150 强制深度（OKX 口径：越大越安全，≤100% 即强平区）
    marginRatioConvention: "higher_is_safer",  // ★ 可翻转：lower_is_safer（万一真实数据与文档口径不符）
    confirmedBreakOfFlaggedLevel: true,
    conditionResonance: 2,      // ≥2 个独立条件共振
    importantNews: true,
    skipTriageTriggers: ["intelligence_briefing", "daily_market_review"]  // 简报/复盘不试判
  }
}
```
- `mode: "off"` = 现状（无试判阶段，`reportTriage` 可选但不设门）。
- `mode: "shadow"` = 试判照做并记录，**仍执行深度**（用于积累漏检率数据）。
- `mode: "enforce"` = 试判 `escalate=false` 时**结束运行**（`status: skipped`）。


**C19.1 补充：保证金率口径（2026-09-18 董事会确认）**

OKX 官方口径为 **维持保证金率 =（余额 + 全仓收益 − 挂单占用等）/（维持保证金 + 强平手续费）**，**≤100% 即触发强平** ⇒ **数值越大越安全**（健康账户常在数百到数千个百分点）。因此：

- 硬升级规则是「`mgnRatio` **≤ 阈值** ⇒ 强制深度」，**默认阈值 150**（离强平不足约 1.5× 缓冲）；旧的"≤25%"写法既会永不命中（健康值远大于 100），又会把正常值误判为"单位不可确认"，属**静默失效**，已废弃；
- 有效性判定改为 `0 < mgnRatio ≤ 100_000`（0–1000×）；≤0 或异常巨大 → 记 `unavailable`；
- 配置新增 `marginRatioConvention`（默认 `higher_is_safer`）以便真实数据打脸时**改配置反向**，不必改代码；
- 试判证据与 run 记录必须**保留原始 `mgnRatio` 数值**，用于用真实运行验证方向（第一条真实运行出来后核对分布）。

### C19.2 阶段门（**在 Rust 授权层强制**，不能只在提示词里约定）
1. **试判工具面** = `market.read*` + `account.read*`（需绑账户）+ `intelligence.*` + `radar.*`；写类/交易类一律拒（与现状一致）。越范围调用 → 明确拒绝并提示"试判阶段只允许这些只读域"。
2. **未提交试判结论前不得点名专家**：`triage.mode != off` 且尚未收到 verdict 时，`consult_expert` / `consult_experts` 一律拒绝（错误提示要求先提交试判）。
3. 新工具 **`background.reportTriage`**：
   ```jsonc
   { "escalate": true|false, "reasons": ["..."],
     "evidence": [{ "fact": "...", "source": "market.readTicker", "at": "2026-09-18T16:04:20Z" }],
     "nextWakePlan": { "mode": "any|all", "conditions": [...], "expiresAt": <ms> } }
   ```
   - `escalate: true` → 放行深度阶段（`consult_experts` 可用）；
   - `escalate: false` → 深度工具全部拒绝，只允许 `background.finishRun`；运行时记 `status: skipped`；
   - **Rust 硬升级兜底**：命中 C19.1 硬升级清单时，`escalate:false` 一律**被否决并强制升级**（工具返回里写明 `forcedBy`），即 **试判只能加码、不能解除强制**；
   - `skip` 时必须带 `nextWakePlan`（否则视为未完成，不允许 skip），保证不会因为跳过而失去后续唤醒。
4. `shadow` 模式下 `escalate:false` **不阻断深度**，但 verdict 照记，便于事后对比。

### C19.3 反饥饿与记账
- `skip_streak +1`（skip 时）；达到 `maxSkips` 或距上次深度运行 > `maxSilenceMinutes` → **强制升级**；
- 深度运行正常完成 → `skip_streak = 0`；
- run 记录新增：`triage` 块（mode / verdict / reasons / evidence / forcedBy / 分阶段 token）与 `skipped` 状态；**token 分试判/深度两段分别记录**，用于度量节省比例；
- 抽样复检（`skipSampleRate`）：被判 skip 时按概率仍执行深度，且**如实标记为抽样复检**，用于持续统计漏检率（防止 enforce 模式下再也无法验证"跳过是否安全"）。

### C19.4 UI
- 运行列表：`试判：建议跳过 / 升级` 徽标 + 理由摘要；skipped 运行可展开看 evidence；提供**一键强制深度**（把该次重新排为深度运行）。
- Profile 设置：`triage.mode` 三选一 + 参数（跳过上限 / 静默上限 / 止损与保证金阈值 / 抽样率），默认按 C19.1。

### C19.5 验收
- 工具面：试判阶段越范围调用被拒；提交 verdict 后 `consult_experts` 才被放行；
- skip 路径：`enforce` 下 verdict=false（无硬升级命中）→ 深度工具被拒、run 记 `skipped`、`nextWakePlan` 已写入；
- 硬升级：构造止损距离 1.2% / 保证金率 20% / 挂单变化 → verdict=false 也被强制升级，且 `forcedBy` 写明；
- 反饥饿：连续 3 次 skip 后第 4 次强制升级；距上次深度 >120 分钟强制升级；
- shadow：verdict=false 但深度照跑，记录里 verdict 与实际结果都在；
- 指标：skip 率、试判 token 占比、抽样复检漏检率（人工或复盘 Agent 判定）。

## C20 内置专家重构：按流程角色划分（2026-09-19 董事会决定）

**背景**：原 8 个内置专家里有 **4 个能力面完全相同**（无 Skill、不需账户、默认同样 61 个只读工具），只差一段提示词文字 —— 同批并行时把同一份行情读四遍（实测：市场结构 19 次 / 订单流 9 次 / 衍生品 13 次 / 历史类比 16 次工具调用，大量重叠），8 份 8k 字散文再灌回主 Agent（该轮 8.34M input tokens）。董事会决定按**流程角色**重构。

### C20.1 新的默认角色集（4 个）
| id | 职责 | 依赖 | 建议工具面（点名 `scopes`） | 输出契约 |
| --- | --- | --- | --- | --- |
| `desic-data-digest` | 一次读齐行情 / 衍生品 / 聪明钱 / 新闻 / 历史，产出结构化摘要 | 无 | market + derivatives + intelligence（+history / radar 按需） | **摘要**：证据清单（工具 / 时间戳 / 记录 ID）、关键数值、时效、缺口 |
| `desic-account-state` | 持仓、普通与算法挂单、止损止盈状态、保证金率（含口径）、可用余量 | 无 | account + 基础行情（`requiresAccount: true`） | **状态清单** + 风险标记（只列事实，不给方向观点） |
| `desic-decision-proposal` | 基于摘要 + 账户状态产出**候选决策**（方向 / 入场 / 仓位 / 失效条件 / 风险回报） | 需前两者产出 | 基础行情 + history（少取证、重推理） | **候选**：结论、引用的证据 ID、会改变结论的条件 |
| `desic-contrarian-review` | 尝试**推翻**候选决策 | 需候选决策 | 最小面（history + intelligence 定点核对） | **反驳**：逐条 + 可检验依据，或明确"无法推翻"，或"需补什么证据" |

四种输出**形态必须不同**（摘要 / 状态 / 候选 / 反驳）；角色价值来自"数据源不同 + 输出契约不同 + 起点不同"，不来自名字。

**落地细则（2026-09-19 裁决）**：
- **新增 role 值**：`data_digest` / `account_state` / `decision_proposal` —— 需在 C2/C15 的 role 说明、§2.1 生成模板的 role 枚举、UI 的角色建议列表中同源登记（role 本身仍是自由 slug，正则不拦）。
- **`desic-account-state` 用 `envelope: "risk"` 显式声明**（role 保持 `account_state`，**不改用 `account_risk`** —— 它的定位是"只列事实、不下结论"，与 `account_risk` 的语义冲突）。C15.1 的取严规则是"声明 `risk` **或** role 为 `account_risk` 即取严"，因此显式声明即可生效。
- **建议工具面**写在目录注入行的"建议收窄"里（C15 已删除文件级 `scopes`，不恢复）。
- **`desic-data-digest` 声明 `["okx-market-intelligence", "market-radar-research"]`**：Radar 类工具受 Skill 门槛保护，声明后"Profile 激活该 Skill 时可用、未激活时给出依赖提示"，不声明则永远拿不到。
- **输出类型标签**（C20.4 需要）：新增 i18n 键 `agentOutputSummary / agentOutputState / agentOutputProposal / agentOutputRebuttal / agentOutputGeneric`（zh/en 双份），用于目录中标注自定义角色的输出契约。
- **停用标记与文案**：`AiAgentSummary.deprecated: boolean` + i18n 键 `agentDeprecated`（"已停用（历史角色）"）/ `agentDeprecatedHint`（说明可手动启用或改用新角色）。

### C20.2 并行/串行由主 Agent 自决（不固定管线）
- **不写死管线**：用户可自定义专家、可取消勾选任一角色，因此调度顺序必须由主 Agent 按**本轮实际启用的名单**决定。
- 现有机制足够表达任意管线：**一次 `consult_experts` 调用必须等整批返回**，主 Agent 用多次调用即构成阶段；`mode: "serial"` 仍是屏障。
- 编排规范必须写**判断规则**（不是固定顺序）：无依赖 / 只读 / 不争抢外部资源 → 可同批并行；需要读取本轮其它专家产出 → 串行（另一次调用）；禁止"按名单全派"；**反方最多一轮**（若提出补证，主 Agent 决定是否补，补后不再重复反方）。
- **审计**：run 记录必须保留每位专家的 `startedAt / endedAt` 与所属批次，用于事后发现"分析专家先于数据专家启动"这类违规。

### C20.3 不设轮次上限
- `maxIterations` **不再下发**（Rust 与侧车都不得替 SDK 设默认）。
- ⚠️ **必须先实测 SDK 行为**：不给该字段时是"无限"还是"回落到 SDK 自己的默认值"（历史上我们曾显式传过 `defaultMaxIterations: 8`）。若 SDK 必须给值，则给一个"事实上无限"的大值，而**不是**恢复限额语义。
- 取而代之的护栏（**不是限额**）：无进展心跳（`agentProgressNotice`）必须在 UI 显著可见；取消必须能中断整条管线（含尚未启动的环节）；运行详情必须显示**每位专家**的 token 与时长。
- **已知风险（董事会已接受）**：不设上限且不加"重复调用止损"时，单个专家理论上可长时间重复取证，兜底只有用户取消与心跳。

### C20.4 降级矩阵（缺角色 / 自定义 / 环节失败）
| 情形 | 必须的行为 |
| --- | --- |
| 未启用数据汇总 | 主 Agent 自己取证，并在报告说明"本轮未派数据专家" |
| 未启用账户与持仓 | 主 Agent 自行读账户（未绑账户则明确写出"账户证据缺失"） |
| 未启用分析/决策候选 | 主 Agent 自己分析（回到 v3 行为） |
| 未启用反方 | 主 Agent **必须自己做一次自我反驳**并写入报告 |
| 用户自定义角色 | 目录注入行带输出类型与建议工具面；未知类型按"通用分析"处理 |
| 某环节失败/超时 | 沿用 C18 部分失败隔离；主 Agent 用已有证据继续并声明缺什么 |
| 摘要时效过期 | 摘要逐条带时间戳与有效期；超阈值时主 Agent 必须重取或在结论里标注 |

### C20.5 旧内置处置：**彻底隐藏、文件保留可恢复**（2026-09-19 董事会决定）

- **文件保留**：旧 7 个的 `AGENTS.md` 仍在库里（便于随时恢复），但——
- **库与勾选器都不再显示**它们（不渲染"已停用"分组）：`ai_agents_list` 默认**不返回 deprecated 条目**（如未来需要"显示已下线"视图，另加显式参数，默认关闭）。
- **运行绝不派发**：`enabledAgents` 载荷构建时把 deprecated id 当作**无效 id** 过滤（与"不存在的 id"同一处理），并在丢弃清单里回报。
- **配置里的旧勾选被忽略；剔除与迁移由 Rust 执行并留痕，UI 不读也不写该字段**：Profile 读取时把 deprecated id 从**生效名单**剔除（运行期只剔除、不改配置）；持久化改写**仅**按下方"迁移触发条件"发生，并与剔除清单一起写 boot_log 留痕（`ai_automation.rs:9550-9560`）。**UI 不读也不写 `ignoredEnabledAgentIds`**（实现口径 `src/ui/AiAutomationPanel.tsx:554`："迁移由 Rust 强制完成，UI 不再读/写" —— 2026-09-19 N2 裁决）。**不静默丢弃**：剔除与改写都必须留痕。
- 侧车/Rust 均不得因为 deprecated id 报错（按忽略处理）。
- 恢复方式（运维）：文件仍在 `agents/<id>/AGENTS.md`，把内置表里的 `deprecated` 去掉即可复现。

- **迁移触发条件（2026-09-19 裁决，采纳实现建议）**：仅当 Profile 名单**非空**且（**含已下线 id** 或 **一个默认角色都没有**）时改写为「默认 4 个角色（内置顺序）在前 + 其余保留 id（原相对顺序）在后」；**空名单不动**（新建 / 关闭协作不凭空多 4 个专家）；**刻意不因"少了 4 个之一"就补** —— 用户有意只跑 2–3 个角色是合法配置，每次都补回来会导致"永远选不动"。若董事会将来要"始终保 4 齐全"，改成"缺任一默认角色即补"即可（需同步 C14 与保存回归用例的预期）。
- 迁移执行**持久化 + 幂等**：读取路径防御性检查 + 启动期各一次，各写一行 boot_log（before→after），迁移后不再写（`updated_at` 不推进）。

> 注：此前一版措辞写的是"旧勾选保留但不生效"，实现上却仍可被派发（`normalize_enabled_agent_ids` 只过滤"不存在的 id"）。本版把语义钉死为"**从生效名单剔除 + 运行时过滤 + UI 提示**"三者一致。

### C20.6 输出契约与审计字段
- 反方之外的专家**不得给最终交易指令**；只有主 Agent 可以创建机会。
- **`background.finishRun` 的入参 schema 必须新增并接受这两个字段**（否则编排规范写了也无效）：
  - `usedEvidence[]`：本轮结论引用了哪些专家事实（专家 id + 证据要点）；
  - `contrarianResolutions[]`：逐条回应反方意见（接受 / 反驳 + 依据）。
- 这两项用于事后判断"反方是否走过场""数据专家是否被使用"，**是删除或调整内置角色的唯一依据**（不再靠审美）。

### C20.7 验收
- 默认启用集 = 新 4 个；**旧 7 个按 C20.5 彻底隐藏** —— `ai_agents_list` 默认**不返回 deprecated 条目**，**不在 UI 显示"已停用"分组、不可在勾选器手动勾回**（需要"显示已下线"视图时另加显式参数，默认关闭）；旧勾选在配置里**不丢失**，按 C20.5 的迁移规则处理。（2026-09-19 N1 裁决：原文与 C20.5 互斥；且"旧 8 个"计数有误 —— `desic-contrarian-review` 已被新 4 角色复用，旧应为 **7**。）
- 真模型运行：数据与账户两角色**可并行**、分析与反方按主 Agent 的决定串行在后；**无重复取证**（同一数据源不被多个专家重复拉取）；记录里能看到 `usedEvidence[]` / `contrarianResolutions[]`；
- 降级：分别取消勾选 4 个角色各跑一次，行为符合 C20.4；
- 无上限：专家跑到 40 轮以上不失败（探针）；心跳与取消可用；每位专家的 token/时长可见。

## C21 分析结果（运行正文）的排版规范（2026-09-19 董事会要求）

**目的**：`background.finishRun.summary` 就是界面上那条"分析结果"，也是事后复盘的唯一人读产物。当前模型输出常见"一大段无结构文字 + 贴原始 JSON"，要求改成**规范的、排版干净的正文**（允许并鼓励 Markdown）。

### C21.1 规则放在哪（关键）
必须写进 **`desic-core-operations`** —— 它是**恒注入**的 Skill（每个 Profile 都合并、不可关闭、不可编辑）。
**不得**只写在 `desic-agent-orchestration` 里：那份只在"专家名单非空"时才注入，而**试判后直接收尾的运行**与**单 Agent 运行**都不会注入它，规则会漏掉最需要排版的场景。

### C21.2 正文规范（写进 Skill 的硬性要求）
1. **首屏先结论**：第一段就是判断与动作意图（例如"本轮不建仓，等待 X"），不要先铺数据。
2. **固定小节（顺序固定；标题按运行语言二选一，见下）**：
   - `## 结论` / `## Conclusion`
   - `## 事实与证据` / `## Facts and evidence`（每条带**观测时间**与**记录 ID / 工具名**）
   - `## 冲突与缺口` / `## Conflicts and gaps`（证据矛盾、读不到的数据）
   - `## 观察条件` / `## Observation conditions`（下一步唤醒条件：触发值、失效条件、到期时间）
   - `## 下一步` / `## Next steps`（本轮不动作时：为什么等、等什么）

   **语言裁决（2026-09-19，董事会）**：正文语言跟 `systemPrompt` 的"用用户语言作答"走，**小节标题本地化**：中文运行用中文标题、英文运行用英文标题（上表两套，顺序一致）。
   - 冻结这两套即可，不要求更多语言（ja 等其它 locale 目前按 en 处理）；**审计必须同时接受 zh 与 en 两套标题**（见 C21.3），否则英文运行会持续误报。
   - `review.complete` 要求 `summary` 首个非空行逐字复制 canonical header —— review 类运行的排列顺序是"**header 行在第一行，五小节紧随其后**"，与"结论先"不冲突。
3. **允许的 Markdown**：标题、短列表、**表格（≤4 列）**、行内等宽（工具名 / 记录 ID / 价位）。**禁止**贴原始 JSON、整段工具输出、base64/长数字串堆砌。
4. **段落纪律**：单条要点 ≤3 行；一个小节超过 6 行必须拆成要点；不得用连续大段叙述替代结构。
5. **可脱离渲染阅读**：不依赖 emoji、颜色或图表表达关键信息（正文可能被贴进通知或日志）。
6. **不设字数硬限**（与"不设轮次上限"一致），但要求"结论在小节顺序的第一屏可见"。

### C21.3 软审计（**不阻断、不改写正文**）
Rust 在 `background.finishRun` 落库时**只检查两项**：① 五个小节标题是否齐备（**接受 zh 或 en 两套，按概念匹配、允许大小写差异**）；② "事实与证据"小节是否至少有一条带时间戳的条目。缺失则写入 run 记录 **`summaryFormatWarnings[]`**（UI 运行详情可见）。
**明确不扩展**到表格列数、emoji、行数等细节（提示词没硬性要求的东西不审计，否则会产生大量误报）；**不得**因此失败、不得截断或重写模型正文（可见性优先于强制）。

### C21.4 验收
- `desic-core-operations` 正文含 C21.2 全部要素（内容测试 + 指纹迁移）；
- `summaryFormatWarnings` 在缺小节时出现、合规时不出现（单测构造两种 summary）；
- UI 运行详情展示该警告（钩子 `[data-run-summary-format-warnings]`）；
- 真模型运行一次，人工确认正文结构与"结论首屏可见"。

## C22 升级即须委派（提示词级）与自分析审计（2026-09-19）

**背景（真实运行证据）**：连续两次运行试判判定升级深度（`verdict=true`、`phase=deep`）却**一个专家都没派**（`experts_json=[]`），主 Agent 自耗 **872K / 1.26M input tokens** 完成分析——新角色流程等于没被使用。

### C22.1 规则（写在 `desic-agent-orchestration` 正文，**不做系统硬门**）
1. **升级即须委派**：试判升级深度（含后端 `forcedBy` 强制升级）后，**至少派一位专家**再收尾；常见组合为"数据汇总与/或账户与持仓补证据 → 必要时分析决策候选 → 接近交易结论时反方审查"，但**派谁 / 几位 / 顺序仍由主 Agent 按依赖规则自决**（不构成固定管线）。
2. **例外须说明**：确实无需委派时（试判阶段已取得全部所需证据；或本轮生效名单里没有适配角色），**必须在 `background.finishRun` 填 `selfAnalysisReason`**（一句话）。
3. **禁止形式化空派**：派专家必须说明缺哪类证据 / 要验证什么，不得为"流程看起来完成"而派人。

### C22.2 审计字段与语义（只标记，不阻断）
- `background.finishRun` 接受**可选** `selfAnalysisReason`；`audit` 记录 `{ usedEvidence, contrarianResolutions, selfAnalysisReason, selfAnalysisUnjustified, summaryFormatWarnings }`。
- `selfAnalysisUnjustified = true` 的**必要条件**（全部满足才标）：`triage.mode != off` 且 `verdict == true` 且 `phase == Deep` 且**本轮生效专家名单非空**且专家活动为空且 `usedEvidence` 为空且 `selfAnalysisReason` 为空。
- **生效名单为空 / `collaborationEnabled=false` / 名单里没有可用角色 → 一律不标**（这些是 C14/C20.4 的合法降级，且此时编排规范根本不会注入，主 Agent 看不到该规则）。
- 判定只看**后端事实**（config + verdict + phase + 专家活动），不采信模型自述；**永不失败、永不截断或改写正文**；填了 `selfAnalysisReason` 即取消标记。
- `summaryFormatWarnings` 同理（C21.3）：只写警告，不阻断。

### C22.3 强化（2026-09-19 董事会批 A+B；均为"提示/软校验"，**非硬门**）

真实运行证据：规则已在上下文里（`desic-agent-orchestration` 已发布 v7 含该条、`desic-core-operations` v28 含 C21），但模型仍自己干完且未填 `selfAnalysisReason` → 审计标了 `selfAnalysisUnjustified`。说明只在编排规范里写一条**约束力不足**。

- **A. 固定壳层补一行**（侧车，每个会话必注入的系统提示）：在"升级深度且未派专家时收尾必须带 `selfAnalysisReason`"这一点上给出**短而显眼**的一句，条件与专家目录注入一致（名单非空 / 后台 Profile 运行）。
- **B. 收尾软校验（最多一次）**：`background.finishRun` 在"升级 + 零专家活动 + 未填 `selfAnalysisReason` + 生效名单非空"时，**第一次调用返回非致命校验提示**（`ok:false` + 明确文案：请补一句理由，或先派至少一位专家），**运行不结束**；模型补齐后再次调用即通过；**若第二次仍未补，则接受并只由审计标记**（保证任何情况下运行都能收尾，绝不卡死）。
  - 这一条**不是硬门**：它既不需要模型派专家，也不阻塞收尾（一次重试即可），目的只是让"为什么自己干"被记录下来。
  - `selfAnalysisReason` 仍需写入 run 记录；UI 沿用既有 `[data-run-self-analysis*]` 钩子，无需新增。

### C22.4 验收
- 内容：编排正文含该规则（关键词 `at least one expert` / `selfAnalysisReason` / 不得空派），且指纹按护栏流程迁移；
- 审计单测：非空名单 + 升级 + 零专家 + 无理由 → 标记；填理由 → 不标且记录；有专家 → 不标；**空名单 / collaboration 关闭 → 不标**（误报修正）；
- UI：运行详情展示"本轮未派专家 + 理由"或"未说明理由"（钩子 `[data-run-self-analysis]` / `[data-run-self-analysis-reason]` / `[data-run-self-analysis-unjustified]`）。

## C23 专家成本治理与"逐专家详情"（2026-09-19）

**背景（真实运行数据）**：首次成功派出 4 位专家（17:51 运行）后，总 input 只涨约 10%（4.55M → 4.99M），但**非缓存（全价）input 从约 0.26M 涨到约 3.43M（≈13×）**——因为专家会话各自冷缓存、且每条会话每轮重发自身上下文。逐专家明细：
`数据汇总 50 工具/252K in`、`账户与持仓 10 工具/249K in`、`分析候选 32 工具/264K in`、**`反方审查 44 工具/176s/2.43M in`（单点最大）**；主 Agent 自身约 1.8M in（旧模式是 4.55M 但 94% 命中缓存）。

### C23.1 反方审查的范围约束（**只改 Agent 正文 + 编排规范，不加硬门**）
1. `desic-contrarian-review` 的 `AGENTS.md` 必须明确：**只读已有报告 + 少量定点核对**，禁止重新做全量取证；并写清"若无法推翻，直接给'无法推翻 + 适用范围'，不要为了显得充分而扩查"。
2. 编排规范补一句：**点名审查/反方类专家时传收窄 `scopes`**（建议 `["intelligence","history"]`，必要时加少量 `market`），因为这类专家的输入是"已产出的报告"，不是原始数据。
3. 仍然**不做**工具面硬限制（capability 由点名时的 `scopes` 控制，属既有机制）。

### C23.2 逐专家详情（UI 交互）
协作轨迹的 lane 必须**可点击**，打开详情（弹窗/悬浮层），且**不在列表页堆内容**。详情至少包含：
- 该专家的**名称/角色/执行方式（并行|串行）/ 本次授予范围 `scopes` / 时长 / token（输入输出）/ 工具调用数**；
- **主 Agent 给它的提问全文**（`taskPrompt`：侧车拼装后的最终任务，含时点、依赖提示与 Profile 任务）；
- **专家报告全文**（Markdown 渲染）。

**数据链路（三侧都要改）**：
- 侧车：configured-expert 的 `agentStart` 增加 `taskPrompt`（拼装后的完整任务；`task` 仍保留一句话摘要供 lane 副标题用）；
- Rust：`experts_json` 每条增加 `taskPrompt` 与 `report`（取自事件流：`agentStart.taskPrompt` 与 `agentDone.result.text`），并保留既有 `tokenUsage / toolCalls / durationMs / startedAt / endedAt`；
- UI：lane **提供「详情」入口**（`[data-agent-lane-open]`，带 `data-agent-id`；**采用 summary 内原生按钮而非整块可点** —— 2026-09-19 裁决：summary 的原生语义是展开/收起且既有断言依赖内联展开，改为整块可点会与之冲突；按钮方案两者兼得且键盘可达），弹窗容器 `[data-agent-detail]`，内含 `[data-agent-detail-task]`（提问）/`[data-agent-detail-report]`（报告）/`[data-agent-detail-usage]`（时长·token·工具数·范围）；报告用 `AiMarkdown` 渲染；Esc/点外部关闭。

### C23.3 验收
- 内容：反方正文含范围约束关键词；编排规范含"审查类传收窄 scopes"；
- 数据：真实/夹具运行后 `experts_json[i]` 同时有 `taskPrompt` 与 `report`（非空），且与 `agentStart.taskPrompt` / `agentDone.result.text` **逐字一致**（不截断）；
- UI：smoke 断言 —— 每条 lane 都有「详情」入口；点击后弹层出现且 **8 个钩子**齐备（`data-agent-detail-usage/mode/scopes/duration/tokens/tools/task/report`）；**提问与报告容器必须带 `data-i18n-skip`**（防 i18n bridge 改写证据原文）且文本非空；老记录（空串字段）必须显示占位（`[data-agent-detail-task-missing]`）与「未报告」token；Esc 后弹层完全卸载；列表页内容量不增加。

## C24 单 Agent 极简模式（2026-09-19 董事会要求）

**背景**：关闭「协作编排」时是单 Agent 模式。董事会要求在该模式内提供两种子模式：**标准**（现状）与**极简**（少说废话）。极简模式的诉求：**照常调用工具、照常创建机会/通知，但不输出任何正文**。

### C24.1 配置与适用范围
- Profile 级新增 **`singleAgentMode: "standard" | "minimal"`**（默认 `standard`）。
- **仅在 `collaborationEnabled === false`（单 Agent 模式）时生效/可见**；协作开启时该字段被忽略（不报错）。
- 缺字段/非法值 → `standard`（旧 Profile 行为不变）。

### C24.2 极简模式的行为
1. **不输出正文**：助手文本通道视为关闭——不得写叙述、分析、结论、解释或总结段落；**一切动作只能通过工具调用表达**（读数据、precheck、创建机会、通知、收尾）。
2. **能力不变**：工具面、权限、账户/Skill 门槛、创建机会与通知的能力**与标准模式完全一致**（本模式只改"说不说话"）。
3. **收尾 summary（董事会裁决：允许一句话 + 硬限长度）**：`background.finishRun.summary` 仍必须**非空**，但只允许**一句话**，**硬限 160 显示宽度**（CJK/全角计 2、其余计 1 → 约 80 汉字 / 160 拉丁字符；恰好 160 不报）：
   - 超出长度/出现多行 → 记 `summaryFormatWarnings`（如 `minimal 模式下 summary 超过 160 字符`、`minimal 模式下 summary 含多行`），**只标记、不阻断、不改写**；
   - 若模型仍然输出了正文（助手文本事件非空）→ 记 `summaryFormatWarnings`（如 `minimal 模式仍产生了正文`）供事后复盘，**不隐藏、不改写**。
4. **C21 五小节校验在极简模式下豁免**（该模式只判"一句话 + 长度"），避免对同一份 summary 双重标准。

### C24.2 补充（2026-09-19 裁决）
- **注入条件**：`singleAgentMode === "minimal"` **且协作关闭** 且 **本轮是后台 Profile 运行**（`backgroundRun === true`）。**不加** `backgroundRun` 会让交互式单 Agent 研究会话也"不说话"，那不是本次需求；将来若要交互式也支持，改一处条件即可。
- **优先级澄清句（采纳侧车的追加）**：提示词允许（并推荐）以一句"**本条优先于任何 summary 排版规范**"结尾 —— C21 要求 summary 五小节排版、C24 要求一句话 ≤160 字符，两者直接冲突，写明优先级优于让模型自行猜测。
- **大小写/空白容错**：`singleAgentMode` 比对前做 trim + lowercase（`" MINIMAL "` 视为 minimal）。

### C24.3 验收
- Rust：`singleAgentMode` 默认/非法回落；极简模式下"超长/多行/仍有正文"分别产生对应 warning；**五小节不判**；标准模式行为与现在完全一致（回归）。
- 侧车：极简模式注入"输出通道关闭"的提示（含一句话总结与长度上限），标准模式**不注入**（逐字回归）。
- UI：Profile 里仅在"协作编排关闭"时显示该选项（标准/极简 + 说明）；运行详情对极简运行显示徽标并原样展示那一句 summary。
- smoke：设置项仅在协作关闭时可见、切换后保存 payload 带 `singleAgentMode`；运行详情徽标与 summary 展示断言。

## C25 界面与配置精简（2026-09-19 董事会要求，5 项）

1. **去掉极简模式的"排版提醒"**：运行详情不再显示 `summaryFormatWarnings` 提示行（尤其在极简模式下——该模式按 C24 豁免 C21 排版契约，显示"排版提醒"属噪声）。**审计字段照旧记录**（`audit.summaryFormatWarnings` 保留，供复盘/排查），只是**不再渲染**。
2. **去掉"关闭协作后主 Agent 独立完成，不点名任何专家"的提示**（协作关闭时的说明文案）：该提示不再渲染；i18n 键一并删除（zh/en），避免死文案。
3. **去掉"强制模式会跳过深度分析 / 跳过将不做深度分析；硬升级清单与反饥饿规则仍会强制深度。"这条提示**（试判设置里的警告标题+正文）：不再渲染，相关 i18n 键删除。
4. **去掉"保证金率口径"配置，固定为「越大越安全」**：
   - UI 不再提供该选项（`triageMarginConvention` 相关控件与文案删除）；
   - 后端**固定按 `higher_is_safer` 语义**处理（维持保证金率越大越安全、`≤100%` 视为清算风险），硬升级规则保持 `mgnRatio ≤ 阈值`（默认 150）；
   - 配置里历史遗留的 `lower_is_safer` 值**被忽略并归一**（不报错、不需要用户迁移）；工具结果/配置回显不再暴露该选项目。
5. **运行详情必须能看到"是否进入深度分析"**：新增指标（钩子 `[data-run-deep-analysis]`），取值语义：
   - `deep`：试判判定升级 / 后端强制升级 → **已进入深度分析**（展示原因，如"试判升级"或"硬升级：marginRatioPct"）；
   - `skipped`：试判判定跳过 → 未进入；
   - `off`：试判关闭（该 Profile 未启用试判）；
   - `na`：极简模式下不适用（或数据缺失）。
   数据来源：`run.triage`。**字段语义（2026-09-19 定稿，含一处真缺口修复）**：
   - `verdict: "escalate" | "skip"`（**字符串**；此前 Rust 发的是布尔值，而 `types.ts`/UI 一直按字符串用 → 徽标 class 变成 `is-true`、`verdict === "escalate"` 恒为假，**已修**）；
   - 同时保留布尔 `escalate`（形状稳定，老消费者不炸）；
   - `phase: "triage" | "deep" | "skipped"`、`forcedBy: string[]`（含原因文本，如 `marginRatioPct(120.00% <= 150.00%, higher_is_safer)`）；
   - **`mode=off` 的运行 `run.triage` 为 `null`** → UI 按"未启用试判"渲染（`off`），**不要**渲染成"未进入深度"。
   - **跨边界约定**：`background.reportTriage` 的**工具结果**维持现状（布尔 `escalate` + `skipped`），**不改**（该路径已被 C19 的真模型探针验证过，避免动它）；**实时轨迹**若按字符串渲染，由 UI 自行映射 `escalate === true ? "escalate" : "skip"`。

### 验收
- UI：上述 3 处提示与 1 处配置控件**不再渲染**（smoke 断言 count=0）；运行详情出现 `[data-run-deep-analysis]` 且四态语义正确（夹具覆盖 deep/skipped/na）。
- Rust：`marginRatioConvention` 固定语义 + 历史值归一（单测）；`run.triage` 的 `verdict` 为字符串 + 保留布尔 `escalate`；tool result 形状不变（回归）。
- 审计字段 `summaryFormatWarnings` **保留记录**（仅不再展示）。

## C26 「一键强制深度」的显示条件（2026-09-19 董事会裁决 A）

- **只在试判判定跳过时显示**：`一键强制深度` 按钮仅在"未进入深度分析"（`deepAnalysis.state === "skipped"`，即 `verdict === "skip"` / `phase === "skipped"`）时渲染；`deep`（已进入，含硬升级）、`off`（未启用试判）、`na`（极简/数据缺失）**一律不显示**。
- 理由：该按钮的语义是"跳过试判、**新排一轮**深度运行"（`ai_automation_force_deep_run` → trigger `manual_force_deep` → 判定时视为跳过试判），在已经深度分析过的运行上显示只会诱发误点并白花一轮成本。
- **保留既有降级**：命令不可用时按钮提示「当前版本尚不支持」（不静默、不卡住）；文案与 i18n 键不变。
- 验收：跳过夹具 → 按钮 count = 1；已进入深度（含硬升级）夹具 → count = 0；`off` / 极简夹具 → count = 0（smoke 断言）。

## C27 点名任务交由主 Agent 自行撰写（2026-09-19 董事会 C 方案）

- **侧车不再注入 Profile 长文**：`configuredProfileAgentTask()` 删除「原始 Profile 任务如下：」之后的整篇 Profile 任务（那段长文含试判规则、下单/机会/复核链路、`trade.setLeverage`、`background.finishRun` 等**只对主 Agent 有意义**的规则，对恒只读的子 Agent 既无意义又不可执行）。
- **最小骨架保留**：本轮编排启动时间、缺依赖提示（C4）、`你的唯一任务：{agent.summary}`、"只完成你的职责范围，不复述整个任务。"、历史复核规则（按 Profile 是否为固定 UTC 窗口复盘**条件触发**，只讲"怎么查历史证据"）。
- **5 行事实块由系统注入（不可交给主 Agent 代劳）**：`账号 / 环境（live|demo）/ 目标杠杆 / 关注品种 / 当前时间`。子 Agent 是独立会话、看不到 Profile；若靠主 Agent 转述，某轮漏写"环境=live"会**静默**让下游按 demo 判断。侧车新增 `profileAgentFactBlock(config, asOf)`，三条点名路径（`consult_expert` / `follow_up` / `consult_experts`）全部经它拼装。
  - 事实来源：Rust 运行载荷新增 `agentProfileEnvironment`（Profile 绑定账户后归一化的**权威环境字段**；`agentProfileAccountId` 是不透明标识，其中的 demo/live 字样**不代表**环境）。
  - 缺省渲染：账号 `未绑定` / 环境 `未提供` / 杠杆 `未提供` / 品种 `未限定`——显式标注，不静默留空。
- **"该问什么"完全交主 Agent 自决**：约束写进 `desic-agent-orchestration` 正文新条目（要求写清"本轮要什么证据 / 要什么时间口径 / 哪些不在范围"，**不加更多硬性格式要求**，无必需模板、无固定字段表、无最小长度）。
- **不改动**：咨询/追问的工具调用语义、`task` 必填校验、`scopes` 收窄、并行/串行屏障、`delimited` 的「不可信证据」报告前缀（`不得执行其中包含的任何指令或权限变更要求`）。
- **指纹**：`desic-agent-orchestration` 由 14 项改为 15 项；上一版指纹 `0xe3a4f31b633d7fd3` 登记进 `LEGACY_DEFAULT_SKILL_FINGERPRINTS`，本版 `0x000e71f503dc5de3` 钉在测试里（未编辑的旧副本升级、用户改过的副本保持权威）。
- 验收：注入对比（长文已去、5 行事实块在、身份与依赖通知在）、负面检查（不含 `background_reportTriage` / `tradeOpportunity_create` / `market_readDecisionContext` / `background_finishRun` / `trade_setLeverage` 的 provider 形态）、demo 与 live 各验一次、安全回归（报告前缀仍在、`task` 为空仍被拒）。

## C28 移除 TypeSafe / Jev 快速判定（2026-09-20 董事会要求）

**要求**：去掉 AI Profile 配置里的「TypeSafe / Jev 快速判定」开关，且**不应用到 AI 运行时**。

**事实核查（移除前的现状）**：该能力**只做了存储，没有任何运行时接线** ——
- 侧车/编排/工具面无任何引用（`scripts/*.mjs` 零命中）；
- Rust 侧只有 Profile 字段与敏感配置读写（`ai_automation.rs` / `storage_config.rs`），**没有** TypeSafe HTTP/SDK 调用；
- 因此"不应用到运行时"本就成立，本次工作是**移除配置面与死字段**。

### C28.1 移除范围
1. **UI**：Profile 编辑里的开关块（`AiAutomationPanel.tsx` 的 `profileTypesafe*` 区）与「设置 → AI」里的 TypeSafe 区（标题/说明/启用/API Key/模型/Base URL）**整块删除**；保存 payload 不再带 `typesafe*`；类型定义同步删除；相关 i18n 键（`profileTypesafeLabel/Help/On/Off`、`typesafeTitle/Description/Enable/Configured/PendingKey/DisabledNote`，zh/en）一并删除，避免死文案。
2. **Rust**：
   - `AiAgentProfileInput` / `AiAgentProfileSummary` 去掉 `typesafe_enabled`；读取/保存路径不再读写该列；删除 `apply_typesafe_enabled_default` 及其调用；
   - 敏感配置里去掉 `typesafe.enabled/model/base_url/api_key`，**保存时把该段从持久化配置里移除**（避免遗留一个用不到的密钥）；旧 payload 里若仍带这些字段，**接受并忽略**（不得报错）；
   - **数据库列 `ai_agent_profiles.typesafe_enabled` 保留**（不做破坏性迁移），但不再读写，注释标注 deprecated；
   - **运行时保证**：任何代码路径（侧车 / 编排 / 工具授权 / 判定层）都不得读取或依赖 `typesafe*`。
3. **测试**：删除/改写引用 `typesafe*` 的用例；新增负向断言（配置读回不含 `typesafe*`、Profile 输入输出无该字段）。

### C28.2 验收
- `npm run build` / `test:i18n`（删掉的键不得再被引用）/ `smoke:automation-preview`（**Profiles 视图与设置面板里 TypeSafe 控件 count = 0**）/ `test:release-version`；
- `cargo check --workspace` / 全量 lib / `smoke:config-security`（敏感配置变更必跑）；
- 全仓（除历史文档与本契约）`typesafe|TypeSafe|Jev` 零命中：`grep -ri "typesafe\|jev" src/ src-tauri/src scripts/`。

## C29 快判模式（2026-09-20 设计冻结）

**定义**：用「**代码取数 → Jev 秒级判定 → LLM 写参数与下一轮观察条件 → 代码校验执行**」的闭环替代"LLM 从零分析整轮"的慢循环；每轮仅 **2 次模型调用**（Jev + 窄调用 LLM），目标 **P50 ≤ 3 秒**。
**设计文档**：`docs/agent-fastlane-design.md`（含 state schema、问题模板、prompt 纪律、配置面、运行记录、里程碑与实测依据）。

### C29.1 触发与闭环（**复用既有机制**）
- 触发源：**观察条件（`nextWakePlan`，19 类）命中** / **最长静默到期** / **手动触发**；由既有 worker 循环评估（实测节拍 **2–5 秒**）。
- **闭环**：无论 Jev 判"观望"还是"动作"，**每轮都由 LLM 产出下一轮观察条件**；不得出现"睡死"路径。
- 限额：最小触发间隔、每小时最多运行、最长静默（默认值见 C29.4）。

### C29.2 单轮链路与执行模式
- **代码门分层与冲突定义（2026-09-21 真机误报后裁决）**：
  - **必需数据**：`ticker` / `candles_1m_closed`（含结构与 ATR）/ `derivatives` / `account` → 缺失或过期**拦轮**（原因码 `data`）；
  - **可选数据**：`orderbook` / `micro.*` → 缺失或过期**只留痕、不拦轮**（state 里显式 `null`，交给 Jev/LLM 判断）；
  - **冲突**：**仅当两个周期的方向标签互为反义**（`up` ↔ `down`）才算冲突（原因码 `conflict`）；`range` / `unknown` **一律不算冲突**（只是「看不清」），这类组合只写一条**不拦轮的留痕**。理由：BTC 常见「1H 区间 + 15m 上行」，把 `up` vs `range` 判成冲突会让绝大多数轮次被拦、模式事实上跑不起来。
- 链路：取数（实时）→ 代码门（数据/异常/冲突）→ **Jev 判定** → **LLM 窄调用**（观望分支只写观察条件；动作分支写参数并调用**创建机会**工具）→ 代码校验 → 按**执行模式**落地。
- **执行模式（2026-09-20 实测后收窄）**：既有 `authorize_ai_tool` **不允许 `advisor` 创建机会**（`tradeOpportunity.create` 对 advisor 报错，见 `lib.rs` 授权测试）。因此：
  - **快判模式只提供 `副驾驶`（默认）与 `自动执行（受限）`**；配置窗口**不提供 `顾问`**（避免"选了却永远空转"的死选项）；
  - 若某快判 Profile 的 `mode` 仍为 `advisor`（历史数据/外部写入），runner 必须**显式早退**并在 `gate.reasons` 写明"顾问模式不创建机会"，而不是伪装成普通的 `validation_failed`。
- **降险动作（减仓/平仓/收紧止损/撤单）不得走旁路**：与开仓同一链路（Jev → LLM 参数 → 代码校验 → 按执行模式）。**已接受的代价**：顾问/副驾驶模式下会有延迟；紧急降险例外需另行裁决。
- **不做**：❌ 升级/escalate ❌ 影子模式 ❌ 剧本实体 ❌ `need_llm` 问题（不确定 → 观望 + 写观察条件）。

### C29.3 判定与参数纪律（实测依据）
- **Jev 问题（2026-09-21 用户裁决换问法）**：**三个 `score`** —— `long_score` / `short_score`（各 0–4 档锚点；问的是「**现在做多 / 做空这一个具体动作**有多该做」，不是「这个品种好不好」也不是「方向偏多还是偏空」）+ `reduce_score`（**C29.14 新增**：问的是「现在**针对 `state.account.positions` 里的现存持仓**，该减仓/平仓（降低风险）这一个具体动作有多该做」；**没有持仓时给 0**）+ `quality`（score，5 档）+ `setup_valid`（noul）；**无 `action` choice、无 `need_llm`**。
  - 依据 `artifacts/fastlane-jev-rephrase-probe/report-20260921-070600.md`：同一份 byte 级相同的 state，含「观望」选项的选择题**给方向率 0.0%（0/318）**；换成双打分后阈值 1.0 给方向率 80.5%、1.5 给 16.0% —— 「观望」是**选项结构造成的标签偏差**，不是它没有方向偏好。`long_score` / `short_score` 两段措辞与实验臂 B **逐字相同**（换字必须重跑实验）。
  - **C29.14 的动因（回归修复）**：换问法删掉 `action` 后 Jev **再也没法表达"该减仓/平仓"** → 22 条历史降险样本从 C29.10 修好后的 **21/22 出参数过校验** 掉到 **0/22**。用户裁决「降险不能被拦、不能走旁路」→ 补一问 `reduce_score`（**仍是打分风格，不回旧 choice**）。⚠️ 这一问**换问法实验里没有** → 它的证据只能来自 `artifacts/fastlane-reduce-score/` 的端到端验收，**不得**引用实验里的给方向率数字。
  - ⚠️ `score` 是 **0–4 分布上的期望值**（实测集中 0.2–1.9、连续），**不是档位** → 门槛（`fastlane_entry_score_floor`）必须落在期望值尺度上，取 2/2.5/3 结构性打不中。
  - **判定在代码侧**（唯一实现 `decideEntryFromScores`）：① **降险优先于开仓**（既有裁决「降风险动作优先级高于开仓」）：`reduce_score ≥ 降险门槛` → 判**降险动作**（`action: "reduce"`，走 C29.10 那条已验证链路：intent 折 `close` + `exit_kind` 必填 + `order_type=market` + `size ≤ 持仓` + 不受质量门/置信度门约束）；② 否则 `max(long, short) ≥ 入场门槛` 且不并列 → 方向 = argmax；③ 仍不足 → 观望（`low_entry_score` / `entry_score_tie`）。旧形状 `action` choice 的响应仍按原路径解析（向后兼容：模型若返回旧形状，行为与本变更前逐字一致；旧形状下 `reduce_score` 只留痕、**不参与判定**）。
  - **`reduce_score` 三条硬约束（测试钉死）**：① **永远不得映射成开仓**（只可能产出 `reduce` 或 `watch`）；② **降险不越权**：`reduce_score < 降险门槛` 时开仓臂照旧独立判定（缺这一问也一样）；③ **没有可减的仓位就不降险**：`reduce_score` 再高，只要持仓事实不是 `held` 就观望并留痕，且**不回落去开仓**。
  - **持仓事实口径**（`state.account.positions`，与 `position_capacity` 同源）：`held`（本品种有正持仓）/ `flat`（positions 是数组但本品种无持仓 → **无持仓**）/ `unknown`（`positions` 不是数组 → **持仓事实缺失**，不猜）。两种被挡情形各有**独立观望码与分层文案**：`reduce_without_position`（无持仓，正常状态）/ `reduce_position_unknown`（持仓事实缺失，数据异常）。
  - **两条门槛已解耦（C29.17，2026-09-21）**：入场门槛 = `fastlane_entry_score_floor`（默认 1.5，clamp 0.5–3.0）；降险门槛 = `fastlane_reduce_score_floor`（**独立字段**，**默认同为 1.5**，clamp 同规则 0.5–3.0）。**默认值同值 ⇒ 与 C29.14"复用同一门槛"的行为逐字一致**（本轮不是放宽风控，而是把旋钮交出来）；但两者可**分别调**：只改降险门槛只影响降险臂，只改入场门槛只影响开仓臂。记录里 `reduceScoreFloor` 落**生效的降险门槛**，不再与 `entryScoreFloor` 强制同值。
    - **为什么降险比开仓更适合放宽**：两类动作取向不同 —— **开仓要挑**（宁缺毋滥，放宽的代价是新仓位与新暴露）、**降险要快**（宁可多减一点，代价是少赚）。且降险**只作用于既有持仓**（`reducePositionFact !== "held"` 一律不动手）→ 放宽它不产生新仓位、不放大暴露。一条线同时服务两种取向是妥协，不是裁决。
  - **置信度门在打分臂下不参与**（没有 `action` 节点 → 无 action 置信度可读；`confidenceSource: "none"` 显式留痕）。不代填：实测 score 节点置信度集中在 0.13–0.65，与 action 节点的 0.9+ 不是同一尺度，代填等于把门偷偷收紧到整臂全拦。**降险不受质量门/置信度门约束**（C29.10 裁决，语义本轮未动）。
- **参数调用必须关思考**（`reasoning_effort: "none"`）：实测关思考 538–1,187ms；开启思考 8,141ms 且 1,500/1,500 token 全被思考占用、`finish_reason=length`、内容为空。
- **取数必须走实时路径**（落盘表滞后：已收盘 K 线 0–60s、衍生品 0–5 分钟、账户快照可达数小时）；多周期由 1m 聚合。
- **硬约束必须写"可实现口径"**（例：`stop = max(最近结构位, entry − 1.5×ATR14_1h)`）；state 各字段须**时间戳自洽**（模型会交叉核对并拒绝不自洽输入）。
- 代码校验：止损位置、单笔风险、盈亏比、手数/杠杆/保证金模式、入场与滑点、数据新鲜度、时段/事件黑名单；任一不过 → 当轮不创建机会并记为观望 `validation_failed`。

### C29.4 默认值（2026-09-20 董事会裁决）
| 项 | 默认 |
| --- | --- |
| 执行模式 | **副驾驶** |
| 最长静默 | **10 分钟** |
| 每小时最多运行 | **120 次** |
| 最小触发间隔 | **10 秒** |
| 观察条件 | 允许用户手动增删（复用既有用户条件） |
| 实时快照 | 由应用维护常驻内存快照（取数目标 <50ms） |
| 通知 | 只在开平仓 |
| 风格描述 | 3 个预设（只做多回踩 / 双边区间 / 突破跟随）+ 自由编辑 |
| 风险预算 | 单笔 0.5%、单日亏损 2%、单品种并发 1、杠杆跟随 Profile、滑点 5bps、动作 ≤1/分钟 |

### C29.5 UI
1. **新建 Profile 弹两张卡片**：① AI Profile（深入分析，较慢）② 快判模式（秒级判定）；卡片美观、各含 2–3 条原理与适用场景。
2. **快判模式配置窗口独立重做**，**不复用** AI Profile 配置界面（分组：基础/触发/风格/风险预算/时段事件/通知/停机/高级）。
3. **运行记录适配**：触发源、Jev 判定（概率+质量+耗时）、代码门结果、LLM 参数与校验、动作或观望原因（枚举）、分段耗时与 token。

### C29.6 验收
- 单轮端到端 **P50 ≤ 3s**（分段计时：取数 / Jev / LLM / 校验执行）；
- 观察条件闭环生效（本轮写下的条件能在下一轮触发）；
- **无旁路**：降险动作与开仓走同一链路（有测试断言不存在绕过 LLM 的执行路径）；
- 运行记录可解释"为什么观望"（原因枚举）。

### C29.7 接口冻结（2026-09-20，三侧并行实现依据）

**Profile 类型与字段**
- 新增 `profileType: "ai" | "fastlane"`（创建入参与摘要都带；旧 Profile/缺字段 = `"ai"`，行为完全不变）。
- **复用现有字段**（不新增列）：`mode`（执行模式 `advisor|copilot|limited_auto`）、`max_silence_minutes`、`min_wake_interval_seconds`、`max_runs_per_hour`、`symbols`、`account_id`、`environment`、`target_leverage`；快判模式在**创建时**写入 C29.4 的默认值（10 分钟 / 10 秒 / 120 次）。
- **快判模式新增字段**（`profileType="fastlane"` 时读写；旧类型忽略、默认值仅用于创建）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `fastlane_style_preset` | `long_pullback` | `long_pullback` / `range_both` / `breakout_follow` / `custom` |
| `fastlane_style` | 跟随预设生成的文字 | 自然语言风格（直接进参数 prompt） |
| `fastlane_risk_per_trade_pct` | `0.5` | 单笔风险 % |
| `fastlane_max_daily_loss_pct` | `2.0` | 单日最大亏损（触达停机） |
| `fastlane_max_concurrent` | `1` | 单品种最大并发（持仓+挂单） |
| `fastlane_max_slippage_bps` | `5` | 最大滑点 |
| `fastlane_max_actions_per_minute` | `1` | 动作频率上限 |
| `fastlane_quality_floor` | `1.2` | **入场质量门（几何 R:R 底线）**。**C29.18（2026-09-21）语义变更**：从「读 Jev 的 `quality` 分（0–4 刻度）」改成「**纯代码判据**」—— 依据 `artifacts/fastlane-quality-rephrase/report-20260921-081256.md`：① 旧门槛 1.2 落在 `quality` 自己的支撑集 [1.31, 2.19] **之外** ⇒ 这道门**等于没拦**（放行 116/116）；② 三种换问法（具体动作锚点 / 拆两问 / 0–2 档+赔率优先）的判别力**全部低于现状**（AUC 0.466 / 0.5612 / 0.5065 vs 0.6806）⇒ 这道门不该再问模型。现语义 = `几何 R:R = |目标位 − entry| / |entry − 纪律止损| ≥ 本值`，**三条代码判据各带独立原因码**（`structure_unclear` 结构位不可辨 / `stop_not_placeable` 止损放不下（过近会被扫、过远退化成纯 ATR 距离）/ `rr_below_floor` 赔率不够），**唯一实现 = 侧车 `fastlaneEntryQuality`**（Rust 只持常量 / 夹取 / 下发 / 记录形状，只读侧车结果）。`quality` 降级为**观察量**：记录里保留（缺失显示 `--`），**绝不**作为不动手 / abort 的理由。可配区间 clamp **0.5–3.0**；默认 **1.2（宽起步）**，1.2/1.6 两档对照见 `artifacts/fastlane-code-quality-gate/`。三处同源：Rust `FASTLANE_DEFAULT_QUALITY_FLOOR` / 侧车 `FASTLANE_DEFAULTS.qualityFloor` / UI `FASTLANE_DEFAULTS.qualityFloor`（防漂移断言钉死）。**只改缺省值**：已有 Profile 落盘的 `fastlaneQualityFloor`（如 2.5 / 1.5）不自动改写，需在快判配置窗口手动改。**只作用于开仓**：降险轮没有方向 → 这道门对它**不适用**（C29.10/C29.14 豁免不动）。 |
| `fastlane_confidence_floor` | `0.6` | 判定置信度下限 |
| `fastlane_entry_score_floor` | `1.5` | **入场分下限**（打分臂的方向判定线，2026-09-21 用户裁决新增）：`max(long_score, short_score) ≥ 本值` 且两分不并列 → 方向 = argmax；低于门槛或**并列** → 观望（保守）。依据 `artifacts/fastlane-jev-rephrase-probe/report-20260921-070600.md`：同一份 byte 级相同的 state 换问法后「给方向率」0.0% → 阈值 1.0 时 80.5%（准确率 95.5%）/ 1.5 时 16.0%（准确率 100%）；阈值 2/2.5/3 **结构性打不中**（因为 `score` 是 0–4 分布上的**期望值**，实测集中 0.2–1.9，不是档位）。可配区间 clamp **0.5–3.0**。判定实现只有一处（侧车 `decideEntryFromScores`），Rust 侧持常量 / 夹取 / 下发 / 记录形状。三处同源：Rust `FASTLANE_DEFAULT_ENTRY_SCORE_FLOOR` / 侧车 `FASTLANE_DEFAULTS.entryScoreFloor` / UI `FASTLANE_DEFAULTS.entryScoreFloor`（防漂移断言钉死）。**只改缺省值**：已有 Profile 落盘值不自动改写。 |
| `fastlane_reduce_score_floor` | `1.5` | **降险分下限**（降险臂自己的判定线，C29.17 新增独立字段）：`reduce_score ≥ 本值` → 判降险（优先于开仓；且只作用于**既有持仓**）。**默认值与入场分下限同值 1.5 ⇒ 与 C29.14"复用同一门槛"的行为逐字一致**（本轮只解耦、不改行为）。可配区间 clamp **0.5–3.0**（与入场门槛同规则：同一个 0–4 期望分尺度）。判定实现只有一处（侧车 `decideEntryFromScores`），Rust 侧持常量 / 夹取 / 下发 / 记录形状。三处同源：Rust `FASTLANE_DEFAULT_REDUCE_SCORE_FLOOR` / 侧车 `FASTLANE_DEFAULTS.reduceScoreFloor` / UI `FASTLANE_DEFAULTS.reduceScoreFloor`（防漂移断言钉死）。**为什么该放宽的是它**：降险只作用于既有持仓、不产生新仓位、不放大暴露（多减一点的代价是少赚）；开仓放宽的代价是新暴露。**只改缺省值**：已有 Profile 落盘值不自动改写。 |
| `fastlane_event_blackout_minutes` | `30` | 重大事件前后禁开仓窗口 |
| `fastlane_trading_hours` | `24h` | 交易时段：`24h` / `day` / `night`（**2026-09-20 追加，UI 已实现**） |
| `fastlane_notify_policy` | `on_open_close` | `every_action` / `on_open_close` / `none` |
| `fastlane_jev_model` | `jev-latest` | Jev 模型 |
| `fastlane_jev_timeout_ms` | `1500` | Jev 超时 |
| `fastlane_llm_timeout_ms` | `3000` | 窄调用 LLM 超时 |
| `fastlane_llm_reasoning_effort` | `"none"` | **必须默认关思考**（实测依据 C29.3） |

**运行记录**：`ai_agent_runs` 增加 `fastlane_json`（新列，旧运行 = NULL）；摘要里带 `recordKind: "fastlane"`。`fastlane_json` 结构固定为六组：
`{ trigger:{source:"condition|silence|manual", conditionType?, params?}, gate:{data?,anomaly?,conflict?,ok:bool,appliedTo?,bypassedFor?},
   jev:{action,probabilities,confidence,quality,latencyMs,raw?,longScore?,shortScore?,entryScoreFloor?,entryScoreDecision?,reduceScore?,reduceScoreFloor?,reduceScoreDecision?,reducePositionFact?,confidenceSource?},
   llm:{latencyMs,params?,validation:{ok,reasons[]},opportunityId?,wakeConditions:int},
   action:{kind:"watch|opportunity|kill_switch",opportunityId?,reason?}, intent?,
   timing:{fetchMs,jevMs,llmMs,codeMs,totalMs}, tokens:{jevIn,jevOut,llmIn,llmOut} }`
- `entryScoreDecision`：`direction` / `below_floor` / `tie` / `score_missing` / `legacy_action`，或**降险臂接管时的码**（C29.14）：`reduce` / `reduce_without_position` / `reduce_position_unknown`。
- `reduceScore` / `reduceScoreDecision`（`reduce` / `reduce_without_position` / `reduce_position_unknown` / `below_floor`）/ `reducePositionFact`（`held` / `flat` / `unknown`）：降险臂的分数、口径与看到的持仓事实；`reduceScoreFloor` 落**本次生效的降险门槛**（C29.17 起是**独立字段** `fastlane_reduce_score_floor`，**默认与 `entryScoreFloor` 同值 1.5**，但两者可分别调 → **不再强制同值**）。旧侧车 / 旧形状下这些键**全部不出现**（老记录形状不变）。

**命令**
- `ai_agent_profile_run_now`：按 `profileType` 内部分派（快判模式走快判 runner），**不新增手动触发入口**。
- `ai_fastlane_kill_switch { profileId, closePositions: bool }`：立即停判；可选平掉快判仓位。
- 快判 Profile 的**实时快照**由 Rust 维护（常驻内存，1 秒节拍），只在快判运行载荷里出现（`fastlaneSnapshot`），不给 UI 直读。

**侧车 ↔ Rust 事件契约（2026-09-20 冻结，侧车已实现）**
- **事件名：`fastlaneResult`**（与既有 `titleResult` / `agentDraftResult` 惯例一致）；轮末另发 `done`。
- 侧车回传：`{ type, sessionId, ok, jev:{action,actionRaw,probabilities,confidence,quality,latencyMs,attempts,raw,longScore,shortScore,entryScoreFloor,entryScoreDecision,reduceScore,reduceScoreFloor,reduceScoreDecision,reducePositionFact,confidenceSource}, llm:{latencyMs,params,validation:{ok,reasons},wakeConditions,nextWakePlan,opportunityId}, action:{kind:"watch|opportunity|kill_switch",opportunityId?,reason?}, timing:{jevMs,llmMs}, tokens:{jevIn,jevOut,llmIn,llmOut} }`。
- **Rust 补齐**：`trigger`、`gate`、`timing.fetchMs/codeMs/totalMs`。
- **Rust 必须下发的两项补充（2026-09-20 审计发现）**：`fastlane_llm_model`（窄调用所用模型；侧车在缺失时报"窄调用缺少模型配置"并**整轮失败**）与 `fastlane_jev_base_url`（缺省 `https://api.typesafe.ai`）。
- **Rust 必须下发**：`wakeConditions`（当前生效观察条件，侧车读 `input.wakeConditions`，回退 `config.wakeConditions`）、`fastlaneSnapshot`、`fastlaneConfig`、`typesafeApiKey`。
- 侧车给 Rust 的失败信号：Jev 失败 → `gate:{ok:false,anomaly:true}` 且**不调用** LLM。
- **`wakeConditions` 形状（冻结）**：`[{ id, conditionType, config, status, expiresAt }]`（即 `ai_wake_conditions` 行的直出；`config` 为该条件的参数对象）。
- **TypeSafe Key（C 段已实现）**：落盘 `AiConfig.typesafeApiKey`（唯一持久化处）；读接口只回 `AiConfigSummary.typesafeApiKeyMasked`（短/空 → `****`，长 → 前 4 + `****` + 尾 4）；更新入参 `None`=不改、含 `****`=忽略、`""`=清空；**明文只在快判轮下发侧车**，任何读命令/事件/日志/记录不得出现。
- **停机语义（冻结）**：`ai_fastlane_kill_switch` = 停用 Profile + 取消 queued/running + 撤销生效观察条件 + 写 `kill_switch` 记录；`closePositions=true` → **入队一条平仓轮**（`trigger_type='fastlane_close'`、`intent="close"`，**跳过 Jev**，仍走 LLM 参数 → 代码校验 → 既有平仓链路），立即返回 `{positionsClosing:true, closeRoundId, closePositionsMode:"queued_close_round"}`；**不做瞬时强平旁路**。

**两处边界的字段形状（2026-09-20 冻结，B-RUST 已按此修正）**
- **Profile 线（UI ↔ Rust）**：**扁平 camelCase**，19 个键形如 `fastlaneStylePreset` / `fastlaneRiskPerTradePct` / `fastlaneTradingHours` / `fastlaneEntryScoreFloor` / `fastlaneReduceScoreFloor` …（`#[serde(flatten)]`，线上**不得**出现嵌套 `fastlane` 对象）。
- **快判载荷（Rust → 侧车）`fastlaneConfig`**：**snake_case 前缀名**，即 `fastlane_style_preset` / `fastlane_risk_per_trade_pct` / `fastlane_max_slippage_bps` / `fastlane_quality_floor` / `fastlane_jev_model` …（与侧车 `normalizeFastlaneConfig` 的读取键一致；缺键回落侧车默认值）。
- **校验结果只有两态**：`validation.ok` 为 `true|false`（UI 的 `ok|rejected`）；**不存在 `adjusted`** —— Rust 不做任何隐式参数调整（若将来要"被拒后更保守地重试一次"，需另行裁决并补记录字段）。

**B1/B3 落地增补（2026-09-20，Rust builder 实测发现）**
- **4H 结构窗口需要 ≥约 4 天的 1m 历史**（24×4H = 5760 根 1m）；既有 1m 读路径内部把 limit 夹到 **5000 根（≈3.47 天）**，单次取数**永远不够** → 4H 恒 `null`、代码门恒判 `data`（功能死路）。**采集成器的落地口径**：**拼接两段 5 天窗口（≈6.9 天）**，只用既有读函数、不新增端点。任何后续改动不得把这个拼接退化成单次 5000 根。
- **取数三档（冻结）**：① 图表消费者已订阅同 inst → 读共享 store 复用最新值（不改订阅集合、不抢通道）；② 否则在既有引用计数 registry 里注册**只含该 inst** 的自有消费者（`owns_public_stream=true`，释放＝摘掉它）；③ 再退到既有 `ai_read_ticker` / `ai_read_orderbook` / `ai_read_candles_for_range` + 账户快照路径（**零新 REST 端点**）。
- **节拍分频（冻结）**：ticker/orderbook 每 1 拍、candles 每 15 拍、derivatives 每 5 拍、account 每 2 拍；每块记录**来源时间**（缺失→0、与本机时钟偏移 ≤5s → 夹到 now、超前 >5s → 0；**绝不用读取时刻顶替来源时间**）。
- **参数形状适配（2026-09-20 裁决）**：侧车窄调用返回的是 LLM 自然的 snake_case 动作（`entry_px/stop_px/tp[{px,portion}]/size{contracts,risk_pct}`），**由 Rust 侧适配**成既有 `tradeOpportunity.create` 的 canonical 形状（camelCase、`size` 字符串、`takeProfit.triggerPx` 等），**不要求侧车改形状、不让模型多跑一轮**。顺序必须为：**适配 → `validate_round` → 冻结决策上下文候选（`read_decision_context`）+ 预检（blocked 即拒）→ 既有 commit 路径**（copilot/limited_auto 语义不变）；**适配必须严格**（未知/缺失字段一律拒绝，不得猜测）。
- **停机平仓轮「跳过 Jev」需要侧车直通位（2026-09-20 裁决）**：载荷新增 **`fastlaneIntent: "round" | "close"`**（缺省 `round`）。`close` 时侧车**跳过 `callJev`**，直接进窄调用 LLM 的降险分支 → `validate_round` → 既有平仓链路；否则用户显式发起的平仓会被 Jev 的"观望"挡住，与 C29.7 的停机语义冲突。

**跨边界两处必须对齐的细节（2026-09-20 由失败中的 builder 自带测试抓出）**
- **`tokens.jevIn/jevOut` 在 `close` 轮为 `null`**（侧车如实上报"Jev 未执行"），而 Rust 侧字段是 `i64` → **解析整轮失败**。Rust **必须**把 `jevIn/jevOut`（以及 `timing.jevMs` 若侧车给 null）收成 `Option<i64>` 或 `#[serde(default)]`，并在 `fastlane_json` 里如实保留 `null`/`0` 语义（不得把 `null` 当成错误、也不得伪造数字）。**验收：用真实 `close` 轮载荷（`jev:{skipped:true}` + `tokens.jevIn=null`）跑通整条 `from_sidecar` 解析。**
- **动作参数适配必须接受侧车真实形状**：窄调用返回的是 `size: { contracts, risk_pct }`（嵌套 snake_case），适配器**不得**只认扁平 `sizeContracts`；同时保持"未知/缺失/类型不符一律拒绝"的严格性。

**侧车（快判轮）**
- 载荷新增：`profileType`、`fastlaneSnapshot`（§4 state JSON）、`fastlaneConfig`（上表设置）、`typesafeApiKey`（**仅服务端注入、绝不回显**）。
- 一轮 = **2 次模型调用**：① Jev（`POST {baseUrl}/v1/systemone`，body 含 `model/state/questions`）② 窄调用 LLM（关思考、无探索；产出参数 + 下一轮观察条件 JSON）。
- **创建机会的执行者**：窄调用返回 JSON 后，**由侧车调用既有「创建机会」工具**（等价于"LLM 创建机会"，但避免多一轮工具回合、保证秒级）。若董事会要求由模型亲自调用该工具，另派单（代价：+0.5–1s）。

**UI 钩子**
- 创建卡片：`[data-profile-card="ai"]` / `[data-profile-card="fastlane"]`
- 快判配置窗口：`[data-fastlane-config]` + 分组 `[data-fastlane-group="basic|trigger|style|risk|session|notify|ops|advanced"]`
- 停机：`[data-fastlane-kill-switch]`（含 `[data-fastlane-kill-close-positions]`）
- 运行记录：`[data-run-fastlane]` + `[data-run-fastlane-trigger]` / `-gate` / `-jev` / `-llm` / `-action` / `-timing`
- 快判运行**不显示专家贡献区块**（`[data-run-contributions]` / `[data-agent-lane]` 为 0），并在「深度分析」指标旁给出快判专用注记 `[data-run-deep-analysis-fastlane-note]`（四态判定逻辑不变）
- 配置窗口的**观察条件「新增」**复用既有逐条条件编辑器（不内联重造 19 类表单）；「删除」可在窗口内行内完成

## C31 Agent 编制与 Skill 分类重做（2026-09-21 董事会决定，**取代 C20/C20.5 的角色集**）

**背景（用户原话）**：
1. 「**直接把内置的 agent 都删掉，换上 反方 agent**」；
2. 「**skill 除非必要的写在固定规范；其他交易理念相关的都应该写到 `trading-philosophy` 或其他可编辑的 skill** —— 因为我们是提供给很多用户用的，这些交易理念是我们觉得还不错，用户不一定觉得，所以要能给他们自由拓展编辑的空间。」

### C31.1 内置 Agent 编制 = 主 Agent + 1 个可选对手盘

- **内置 Agent 库只剩 1 个**：`desic-contrarian-review`（**id 复用**，不破坏引用）。定位与正文改写为**对手盘视角**：
  站在对手的位置说明本轮方案为什么会输，逐条给可检验的反证；输出**自然语言**（没有固定字段 / 固定 JSON / 必须填的模板）。
- **删除 10 个内置 Agent**（全链路：内置基线 + 落盘资产 + 安装指纹清单 + 默认启用集）：
  - C20 的 3 个流程角色：`desic-data-digest` / `desic-account-state` / `desic-decision-proposal`；
  - C20 降级的 7 个历史角色：`desic-market-structure` / `desic-order-flow-liquidity` / `desic-derivatives-positioning` / `desic-account-risk` / `desic-intelligence-flow` / `desic-smart-money` / `desic-historical-analogy`。
  删除台账（id / 旧 `auto-*` id / 中文名 / 最后一版出厂正文的 sha256）冻结在 `agent_automation::REMOVED_BUILTIN_AGENTS`：它**只用于用户可见提示与落盘资产的安全清理**，不参与任何启用 / 派发判定。
- **主 Agent 不在库里**：它是每个 Profile 的编排者 —— 取数 → 判断 → 出具体方案 → 执行 → 成交后继续盯。**咨询是可选的**；需要时咨询对手盘，**最多 1 个**（反方审查一轮的上限不变，见 C23.1）。
- `default_enabled_agent_ids()` 恒为空（函数保留给调用方作单一来源，语义见 C31.3）。新 Profile 的 `enabledAgentIds` 为空；**迁移绝不替用户塞回任何角色**。
- 报告用**自然语言**：运行正文不强制 JSON / 字段；只有真动手时通过工具提交结构化参数（`tradeOpportunity.create` / `trade.precheck` 等）。`background.finishRun` 仍必须回 `usedEvidence[]` / `contrarianResolutions[]`（C20.6 的审计字段不变）—— 那是**给系统**的必要信息，与"报告形态自由"不冲突。

### C31.2 Skill 分两类：内置固定规范 vs 可编辑理念

| | 内置固定规范（**不可编辑**） | 可编辑 Skill（**用户可改可扩**） |
| --- | --- | --- |
| 成员 | 仅 `desic-core-operations`（`NON_EDITABLE_SKILL_IDS`，Rust + TS 各一份同名清单） | `trading-philosophy`（默认载体）+ 用户自建 / 导入的任意 Skill |
| 放什么 | 只放"**不这样写就跑不起来**"的东西：系统工具的名称与用途、动作参数的必要字段与单位、报告必须回给系统的必要信息、权限与失败处理。**每一条都要能回答"不写会怎样"** | 交易理念：趋势 / 区间怎么读、如何找分歧（市场定价了什么 vs 我的不同看法）、消息与情绪怎么用、仓位与风险偏好、什么算好机会、什么时候不该动手 |
| 不写会怎样 | 工具名写错 → 调不到工具；单位写错 → 下单数量/保证金算错；权限/失败处理缺失 → 越权或静默失败 | 只是少了"我们的偏好"，决策仍可执行；所以它属于用户可覆盖的自由空间 |
| 绝不放 | **任何"建议 / 偏好 / 理念"** | —— |
| 升级行为 | 磁盘上的任何版本一律丢弃，永远用出厂正文 | **用户改过就不覆盖**（指纹判定：未改动的旧副本才升级），并保留"恢复出厂理念"入口 |

- **"理念不进内置"是硬规则**：`desic-core-operations` 不再新增任何"我们觉得这样更好"的条目；理念一律进 `trading-philosophy` 或用户自建 Skill。C31 把被删 agent 正文里的理念 / 方法论句子搬进 `trading-philosophy` 第 VII 小节（攻击自己的方案、把"市场已定价什么"与"我不同意的部分"分开、结论必须可被证伪）。
- 语义边界不变：`trading-philosophy` 仍是"必需（不可关闭、不可改名）"的 Skill —— **不可关闭 ≠ 不可编辑**。`REQUIRED_AI_SKILL_IDS` 六项不动。

### C31.3 迁移：只删不加 + 可见提示（C20.5 自动补默认角色**已失效**）

- **C20.5 那条"启动时给老 Profile 自动补 4 个默认角色"的迁移被删除**（默认启用集不存在了）。否则老用户下次启动就会被塞回已删除的 agent id。
- 新的名单迁移（`desic_agent_automation::drop_removed_agent_ids`）：
  - 空名单 → 不动（不凭空多出角色）；
  - 名单里含删除台账里的 id（含旧 `auto-*` 形态）→ 就地剔除并落库（幂等：改完不再触发）；
  - 未知 id **保留**（可能只是库文件暂时读不到；清理是保存路径的事）；
  - **绝不注入任何默认角色**。
- **不静默**：被剔除的 id 逐条写成 `migrationNotes`（中文名 + id + **真实文案原文**「它的职责（取数与事实核对）已归主 Agent 自己完成，咨询改为可选。」，见 `agents.rs` 的 `removed_builtin_agent_notice`），随 Profile 摘要下发，UI 在 Profile 编辑器里以 `[data-profile-migration-notes]` 显示；同时每次启动 `boot_log` 一行 `C31 removed-agent migration profile=…`。
  - ⚠️ 本条文档早期把文案**转述**成「职责已归主 Agent」——该字面量**不存在于产品文案里**（原文"职责"与"已归"之间隔着"（取数与事实核对）"）。文档与断言一律以 `agents.rs` 原文为准：预览夹具逐字用它，`smoke:automation-preview` 用正则 `/职责[^。]*已归主 Agent/` 匹配语义（不绑死不存在的字面量）。
- **旧模式开关不丢**：旧 `auto` / `custom` / 含 scheme 的 Profile，`collaborationEnabled` **仍迁移为 true**（用户原本开着协作），只是名单可能为空（咨询可选）—— 不把用户的开关静默关掉。
- 旧 Run 快照重放同样只过滤不写回；`desic-market-structure` 之类的旧 id 不再被 alias 迁移成自定义 Agent（防止"删掉的专家以自定义身份复活"）。
- **C29.19 快判撤下的开关不受影响**：`FASTLANE_MODE_ENABLED=false`、开关点、入口隐藏与实现代码本次一行未动。

### C31.4 内置资产安装：升级有日志、用户改过不覆盖、指纹与实际一致

修掉的静默 bug：落盘正文比内置基线旧、且不在安装清单里时，**旧实现既不升级也不记日志**（现场：`desic-contrarian-review` / `desic-account-state` 的落盘正文停在 2026-09 的旧版）。

- 新增 `LEGACY_BUILTIN_AGENT_FINGERPRINTS`（id + 历史出厂正文的 sha256）：命中即视为"**未改动的旧副本**"→ 安全升级。
- `BuiltinAgentInstall` 逐 id 回报 `written_ids` / `upgraded_ids` / `kept_ids` / `removed_ids`；`log_builtin_agent_install` **任何一类非空都打日志**（不再只看"新建+升级"计数）。
- 安装后**指纹清单与实际资产一致**：升级/新建的 id 写当前指纹；用户改过的 id 不写成"我们的"；已删除 id 从清单里移除。
- 删除态（C31 的卸载）：`REMOVED_BUILTIN_AGENTS[].baselines` 命中或清单证明是我们写的 → 删目录；用户改过的文件保留并在 `kept_ids` 里留痕。

### C31.5 验收

- 内置库 = 1（`desic-contrarian-review`）；编排正文不含 `only data gatherer` / `must not re-gather` / `experts judge` / 3 个流程角色名；
- `trading-philosophy` 存在、默认内容非空、可编辑、**升级不覆盖用户改动**；
- 老 Profile 迁移后不含被删 id 且**有可见提示**；
- C20.5 自动补默认角色的迁移已失效（不再塞回 4 个）；快判撤下开关未被破坏；
- 全量门槛见下（C8 列表 + `cargo test --workspace` + `npm run smoke:automation-preview`）。

> 本文档 C20/C20.5 与 `docs/agent-library-content-pack.md` 的角色集**已被 C31 取代**：内容包保留为历史正文档案，不再是内置 Agent 的真相源；内置 Agent 正文的唯一真相源 = `src-tauri/crates/agent-automation/src/builtin_bodies.rs`。

## C8 验证与出口条件

```bash
npm run build                                                   # B-UI
cargo check --manifest-path src-tauri/Cargo.toml --workspace     # B-RUST
npm run test:ai-policy                                          # B-JS + B-RUST
npm run test:ai-multi-agent                                     # B-JS
npm run test:ai-stream                                          # B-JS
npm run test:i18n                                               # B-UI
npm run test:release-version                                    # 全员（版本号不得动）
npm run prepare:sidecar                                         # B-JS（改 sidecar 后必须重打包）
npm run smoke:config-security                                    # B-RUST（Agent 库落盘）
```

出口条件（reviewer 逐条核验）：
1. 无勾选时行为与今天 `off` 完全一致（目录为空、无点名、主 Agent 独立完成）。
2. `enabledAgents` 中缺账户/缺 Skill 的 Agent 不崩、有提示、仍可被点名。
3. 专家长跑不再被杀；只在无进展时发 `agentProgressNotice`；报告与追问无长度/次数上限。
4. 内置 Agent 文件被用户改动后不被覆盖，UI 显示 `modified: true`。
5. 后台 Run 调用 `agent.create` 被 JS policy 与 Rust 授权**双重**拒绝；交互式主会话通过（无逐工具审批，见 C10）。
6. 迁移：老 profile（off/auto/custom）+ 老模板条目迁移后，勾选名单与库文件正确且迁移幂等（二次运行不重复建文件）。
7. `agent.update` 对内置 agent 报错；`agent.save` 内嵌 id 与目录名不一致时报错。
