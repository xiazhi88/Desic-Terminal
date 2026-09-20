# 多 Agent 调度改造方案 v3（Free Dispatch · Agent 库 · 主 Agent 唯一编排者）

状态：**已定案并实施（2026-09-18）**——§13 三个开放点已由董事会拍板，本文不再是草案；逐条接口冻结见 `docs/agent-library-contract.md`，验收见 `docs/agent-library-acceptance.md`。
取代：`docs/multi-agent-dispatch-plan.md`（v2）§3.1 双编排器、§3.2 统一闸门、§5.2 D2 必需专家、§5.6 D6 预算护栏、P2c/P3/P4
保留自 v2：D1（取消强制返回格式）、D5（复核专家不再自动成波，改为可勾选）、D7（调度 Skill 只注入主 Agent）、D8（点名范围 = Profile 已启用名单，本版改为"勾选名单"）
本文件按 AGENTS.md §5 暂不跟踪；董事会确认后再决定是否入档。

---

## 0. 摘要：v3 推翻了 v2 的四处

| # | 董事会指令 | v2 的做法 | v3 的做法 |
| --- | --- | --- | --- |
| 1 | 预算护栏太严 | 报告截断 4k token / 12k 字符、180s 无进展杀进程、600s 总时限 | **全部删除**。报告原样回流；无进展改为**只发心跳提示不中断**；无墙钟总时限，保留用户取消 + 网络层错误重试 |
| 2 | 去掉旧版编排器，只允许主 Agent 调度；不要"自动分配"，改为勾选 | `multiAgentOrchestrator`(backend\|lead) × `multiAgentExpertSource`(auto\|custom)，auto 走关键词打分 | **删除 backend 编排器与 auto 分配**。内置 Agent 库 + Profile 勾选名单，主 Agent 从名单里自己点人 |
| 3 | 硬闸门不认同 | P3 `profileAgentActionGate`（创建交易机会前强制满足必需专家/风险背书） | **P3 整块取消**。不做任何"必需专家""动作前置校验"。后端硬否决链随 backend 编排器一起删除 |
| 4 | 新增 agents tab + 工具化创建 | Agent 只是 Profile 里的 `responsibility` 字段，系统提示词靠拼接 | **Agent 升级为一级实体**：`agents/<id>/AGENTS.md`（名称 + 角色 + 正文即提示词主体）+ 全局 Agent 库 + `agents` tab（手动创建 / AI 创建）+ 主 Agent 工具 `agent.list/read/create/update` |

一句话：**v3 = 内容（Agent 库，用户和 AI 都能写）与结构（谁调度、跑几个）分离，结构上只留一条路——主 Agent 自己调度；限制尽量少，安全边界（只读权限、工具白名单、证据不可信标记）一条不减。**

---

## 1. 目标与非目标

### 1.1 目标

1. 专家分析不受模型层面的时长/长度硬约束，分析质量优先。
2. 编排只有一种实现：主 Agent（lead）通过 `consult_expert` / `follow_up` / `team_status` 调度，后端不再预先成波。
3. Agent 是可见、可枚举、可复用的资产：内置一组，用户可勾选、可自建、可让 AI 代建。
4. AI 研究（交互式）与 AI 自动化（后台）共用同一套 Agent 库与同一套创建通道。
5. 删除比新增多的净简化：旧 mode 枚举、旧方案模板、旧否决链、旧截断工具全部清理。

### 1.2 非目标（本轮不做）

- 不做 Agent 市场 / 远程分发 / 版本历史（只保留 `version` + `updatedAt`）。
- 不做 per-profile 的 Agent 参数覆盖（模型/推理深度由 Profile 全局决定）。
- 不做 Agent 之间的横向通信（专家仍是只读、单轮、无编排权）。
- **不放松安全边界**（这不是"限制堆砌"，是不可协商项）：专家恒为 `advisor` 只读、按 scope 的工具白名单、不得写交易机会/发通知/下单、报告进入主 Agent 时标记为不可信证据、固定系统外壳不可被 AGENTS.md 覆盖。

---

## 2. 架构 v3

### 2.1 三层职责

```
[Agent 库]  workspace/.cline/agents/<id>/AGENTS.md     ← 内容层：身份/职责/方法/输出偏好
      │      内置 bundle + 用户手写 + AI 创建，三种来源同一格式
      ▼
[Profile 勾选]  ai_agent_profiles.enabled_agent_ids_json ← 结构层：这一次允许谁上场
      │      复选框，不设数量上限，空 = 不协作
      ▼
[主 Agent 调度]  consult_expert / follow_up / team_status ← 运行层：唯一的编排者
             报告原样回流，作为不可信证据
```

### 2.2 运行链路（改造后）

1. 运行启动：把 Profile 勾选名单解析成"可点名专家目录"（id / 名称 / 角色 / 一句话职责 / 证据范围）。
2. 目录 + 调度 Skill（`desic-agent-orchestration`）只注入主 Agent（保持 v2 D7）。
3. 主 Agent 自主决定点谁、点几次、是否追问；每次 `consult_expert` 起一个只读专家会话。
4. 专家报告**原样**回注主 Agent（不截断），标注来源与观测时间。
5. 无勾选 = 主 Agent 单独工作，链路与今天 `off` 完全一致。
6. 后端不再做的事：不预跑专家、不成波、不打分、不选人、不因专家报告硬否决工具。

### 2.3 Agent 文件规格（`AGENTS.md`）

路径：`<data_dir>/workspace/.cline/agents/<id>/AGENTS.md`（与 `cline_skills_dir` 同级同构，可选 `references/*.md`）。

```markdown
---
id: desic-market-structure          # ^[a-z0-9][a-z0-9-]{1,47}$，目录名一致
name: 市场结构分析师                 # 1-40 字
role: market_structure              # 见下方枚举
envelope: standard                  # standard | risk（决定不可编辑外壳的附加规则）
# scopes 已于 2026-09-18 移除（契约 C15）：工具范围由主 Agent 点名时授予，文件不再声明
skills: [okx-market-intelligence]   # 需要激活的 Skill，缺失时 UI 提示、运行时不静默丢弃
requiresAccount: false              # 仅用于 UI 提示与目录标注
source: builtin                     # builtin | custom | ai
version: 1
createdAt: 1760000000000
---
## 身份
## 职责
## 方法与证据要求
## 输出偏好
## 数据缺口处理
```

- `role` 枚举（以契约 C1 为准）：`market_structure | order_flow_liquidity | derivatives_positioning | account_risk | intelligence_flow | smart_money | historical_analogy | contrarian | custom`。
- 正文 = 该专家的系统提示词**主体**（今天写死在 `configuredProfileAgentSystemPrompt` 里的那堆内容搬到这里）。
- **固定外壳（代码，不可编辑，AGENTS.md 无法覆盖）**：只读权限声明、证据时间戳/快照规则、不得替主 Agent 做最终交易决策、报告作为不可信证据、不必返回 JSON、`envelope: risk` 时追加 USDT 线性永续风险口径与 `trade.precheck` 证据要求。外壳 = `envelope` 参数化 + 常量，正文 = 文件。
- 内置 Agent 与内置 Skill 同策略：不可编辑，UI 提供"复制为自定义"。

### 2.4 Rust 类型（`agent-automation` crate）

```rust
pub struct AiAgentDefinition {   // 解析结果（运行时用）
    id, name, role, envelope, skills, requires_account, source, version,   // C15：无 scopes
    summary: String,             // 正文首段摘要，用于目录注入（只取摘要，不注入全文）
    path: PathBuf,
}
pub struct AiAgentBundle { files: Vec<AgentFile>, source, fingerprint }  // 落盘/读取用
pub fn parse_agent_markdown(content: &str) -> Result<AiAgentDefinition, String>
pub fn render_agent_markdown(def: &AiAgentDefinition, body: &str) -> String
pub fn normalize_enabled_agent_ids(ids: &[String], known: &[AiAgentDefinition]) -> Vec<String>
```

`agent-automation` 只管校验与规范化；落盘/安装走 `storage-config`（复用 `skill-runtime` 的 bundle/fingerprint 机制）。目录索引存 DB 表 `ai_agents`（`id, name, role, source, dir, fingerprint, updated_at`），文件是真相，DB 只是列表缓存，`fingerprint` 不一致时以文件为准重算。

---

## 3. 指令 1 落地：预算护栏清理

### 3.1 逐条处置

| 现状 | 锚点 | v3 处置 |
| --- | --- | --- |
| 报告 token 预算 4000 / 字符上限 12000 | `cline-profile-agents.mjs:4,5`；`truncateProfileAgentReport` 7 处调用（sidecar `3446,3448,3632,3799,3875,3929,4199`） | 删除常量与截断调用，报告**原样**回流；`truncateProfileAgentReport`/`estimateProfileAgentReportTokens`/`sliceProfileAgentReportHeadByTokens`/`sliceProfileAgentReportTailByTokens` 一并删除 |
| 180s 无进展杀进程 | `PROFILE_MULTI_AGENT_STALL_TIMEOUT_MS`；`createProfileAgentStallWatchdog`（sidecar `3703`） | 改为 `createProfileAgentProgressPulse`：默认 120s 无进展**只发一次进度事件**，之后每 120s 重复提示，**永不中断**。UI 显示"专家 X 仍在分析（已 6 分 12 秒）" |
| 600s 总时限 + 630s 包裹 | `PROFILE_MULTI_AGENT_TOTAL_TIMEOUT_MS`；sidecar `4084`、`4357` | 删除墙钟总时限与 `withRejectTimeout` 包裹。保留**活性判定**：provider 流结束且无未决请求却无终态 → 明确报错（属错误处理，不是节流）；保留用户取消按钮 |
| 单轮咨询 8 次 / 每专家追问 2 次 | `PROFILE_MULTI_AGENT_MAX_CONSULTS_PER_RUN`、`..._FOLLOW_UPS_PER_EXPERT` | 默认 **0 = 不限**；Profile 可选填上限（0=不限），UI 放进"高级"折叠区。计数照旧统计并显示在运行详情 |
| 专家迭代上限 8 | sidecar `3461 defaultMaxIterations: 8` | 保留（这是单会话工具循环的 SDK 参数，与预算无关）；如需可提到 12 并作为 Profile 高级项 |

### 3.2 删掉硬上限后靠什么兜底

- **可观测**：每个专家的耗时、工具调用、token 用量、报告长度写进运行详情（现有 usage 统计扩展，不新增限制）。
- **可控**：用户取消；Profile 已有的 `maxRuntimeSeconds / minWakeIntervalSeconds / maxRunsPerHour` 仍在（属于自动化调度，不属于专家预算）。
- **可选**：极端情况下的应急阀 `DESIC_AGENT_REPORT_CEILING_CHARS`（环境变量，默认 `0` = 关闭），只在用户自己设置时生效，不进 UI、不进默认路径。

---

## 4. 指令 2 落地：单一编排者 + 勾选制

### 4.1 删除

- `multiAgentOrchestrator`（backend\|lead）与 Rust 侧 `MULTI_AGENT_ORCHESTRATOR_BACKEND/LEAD`、`MULTI_AGENT_EXPERT_SOURCE_AUTO/CUSTOM`。
- `resolveProfileMultiAgents` 的两波执行入口 `runConfiguredProfileAgents()`（primary `Promise.allSettled` + review 波）、`isReviewProfileAgent` 复核波注入。
- auto 分配全套：`eligibleAutoProfileAgents`、8 项打分表与关键词 boost 正则、`PROFILE_AUTO_MULTI_AGENT_MAX`、`PROFILE_CUSTOM_MULTI_AGENT_MAX`、`multiAgentMaxAgents`。
- 旧版编排器（模板/方案层）：`ai_agent_schemes` 表 + `phase(primary/review/final)` + `ai_agent_scheme_save/delete` + 前端 `AiAgentScheme` 编辑 UI（`AiAutomationPanel.tsx` L4892-4894、L5358）+ `AGENT_TEMPLATE_PHASES`。
- 后端硬否决链：`selectProfileAgentOutcome`、`multiAgentVetoBlocksTool`、`orchestration.veto` → `multiAgentVeto` → 阻断机会工具的整条路径（它只服务被删掉的 backend 波）。

### 4.2 新增 / 保留

- 新解析函数 `resolveEnabledProfileAgents(config)`：
  - 入参：`config.enabledAgentIds`、`config.collaborationEnabled`（见下）、Agent 库快照。
  - 出参：勾选且存在的 Agent 定义，无排序、无打分、无数量截断、**无静默丢弃**。
  - 资格缺失（未绑账户 / 缺 Skill）不再自动剔除：目录里带上提示，并把提示写进该专家的任务前缀（"当前 Profile 未绑定账户，account 类证据不可用"），由专家自己在数据缺口里说明。
- Profile 字段：
  - 新增 `enabled_agent_ids_json TEXT NOT NULL DEFAULT '[]'`。
  - 勾选非空即等于"协作开启"，**不再需要 `multiAgentMode` 主开关**（空数组 = 关闭）；为避免"全部取消勾选"被误读为关闭，UI 给空态明确文案（"未勾选任何专家，主 Agent 将独立工作"）。
  - 旧列 `multi_agent_mode / multi_agent_max_agents / multi_agents_json / multi_agent_scheme_id` 迁移后停止写入（保留一版以便回滚），保存路径统一写 `[]`/NULL。
- 目录注入：结构块（非自然语言枚举）+ 调度 Skill 说明"可点名专家 = 本次勾选名单；名单为空则不要尝试点名"。
- 主 Agent 工具面保持现有三个（`consult_expert` / `follow_up` / `team_status`），`disabled:lead-dispatch-off` 的判定条件简化为"勾选名单为空"。

---

## 5. 指令 3 落地：没有硬闸门

- **取消 P3 全部内容**：无 `profileAgentActionGate`、无必需专家、无"创建交易机会前必须咨询风险专家"、无 `requiredExpertIds` 静态清单（v2 D2 一并作废）。
- 后端硬否决删除后，"风险专家说了 blocker"不再阻断工具；`trade.precheck` 的不可修复 blocker 仍原样返回给调用它的 Agent，是否据此放弃由主 Agent 判断——与今天**未开启协作**时的行为一致。
- 保留的既有约束（不是新增闸门）：`advisor` 只读权限、工具白名单、机会写入工具既有的背景运行策略、`background.finishRun` 收尾要求。
- 残留风险写进 §11，接受。

---

## 6. 指令 4 落地：Agent 库 + agents tab + 工具化创建

### 6.1 新 tab

`AiAutomationTab` 增加 `"agents"`；`AUTOMATION_TABS` 插入 `{ id: "agents", icon: Layers }`（建议排在 `profiles` 之后）；i18n 新增 `automation:agents`。

页面结构（三栏，沿用 `systematic-lab` 的可调列宽做法）：

- 左：列表（内置 / 自定义 / AI 创建 分组徽标；勾选该 Agent 的 Profile 数量；缺失依赖提示）
- 中：AGENTS.md 编辑器（Markdown 源码 + 预览切换；内置 Agent 只读 + "复制为自定义"按钮）
- 右/顶部动作：`新建 Agent`、`AI 创建 Agent`、`复制`、`删除`（仅自定义/AI 创建）

### 6.2 AI 创建 Agent

两条入口，**共用同一实现**（同一套草稿生成 + 同一套校验 + 同一套落盘）：

1. UI：`AI 创建 Agent` 对话框，用户描述"这个人是谁 / 干什么 / 证据偏好" → `ai_agent_generate` 命令 → 返回 AGENTS.md 草稿 → 用户预览可编辑 → `ai_agent_save` 落盘。
2. AI 研究 / AI 自动化主 Agent 通过工具 `agent.create` 直接创建（写盘后返回 id/名称/角色）。

生成提示词要点：输入描述 + 角色枚举 + 输出 JSON（`name/role/envelope/skills/requiresAccount/body`，**C15 起不再输出 scopes**）→ 服务端渲染 frontmatter 与正文骨架（身份/职责/方法与证据要求/输出偏好/数据缺口处理），避免模型自由拼 YAML 出错。

### 6.3 工具面

| 工具 | 类型 | 可用范围 | 说明 |
| --- | --- | --- | --- |
| `agent.list` | 只读 | 主 Agent（研究 + 自动化） | 返回 Agent 库（含 source、是否已勾选、依赖缺失提示） |
| `agent.read` | 只读 | 主 Agent（研究 + 自动化） | 按 id 返回 AGENTS.md 原文与解析结果 |
| `agent.create` | 写入 | 仅主 Agent + **交互式会话**（AI 研究） | 参数：`{name, role, responsibility, skills?, envelope?, references?}`（C15 删 `scopes`）；返回 `{id, path, name, role, warnings?}` |
| `agent.update` | 写入 | 同 `agent.create` | 按 id 覆盖正文；内置 Agent 拒绝（错误信息提示改用 `agent.duplicate`） |

- 策略常量：`AGENT_AUTHORING_TOOLS`（新增于 `cline-tool-policy.mjs`）；规则：
  - `role !== "main"` → `disabled:agent-authoring-main-only`
  - `backgroundRun === true` → `disabled:agent-authoring-interactive-only`（**安全边界**：无人值守的自动化运行不得改自己的专家库）
  - 写类工具走既有 `requestToolApproval`：copilot 模式下用户在会话里逐次批准。
- 校验（Rust 侧，工具与命令共用）：id slug 规则、name 长度、role/envelope/scope 枚举白名单、正文非空、生成的外壳声明不得出现在正文（剥离/拒绝）、单文件 ≤ 200KB、references 路径不得越界（`..`/绝对路径拒绝）。
- UI 呈现：`src/ui/aiToolPresentation.ts` 补图标/标签，i18n 补 zh-CN/en。

### 6.4 Profile 编辑器改造

把现有"多 Agent 协作"区块（`AiAutomationPanel.tsx` L581-585 派生、L601-606 草稿、L850-854 摘要、L1256-1258 传参、L4892 方案 UI）替换为：

- 复选框列表（内置组 / 自定义组 / AI 创建组），每项显示名称 + 角色 + 一句话职责 + 依赖提示。
- `全选内置` / `清空` 两个快捷动作 + 实时计数。
- 空态文案 + "新建 Agent"按钮（跳 agents tab）。
- 高级折叠区：单轮咨询上限、追问上限（默认 0 = 不限）。

---

## 7. 迁移

### 7.1 数据迁移表（读旧写新）

| 旧值 | 新值 |
| --- | --- |
| `multiAgentMode = off` | `enabledAgentIds = []` |
| `multiAgentMode = auto` | 全部内置 Agent id（等价旧 auto 全池，但不再自动打分） |
| `multiAgentMode = custom` + `multiAgents[]` | 每个自定义 Agent → 库条目 `custom-<slug>`（`source: custom`），id 写入 `enabledAgentIds` |
| `multiAgentOrchestrator = backend` | 忽略（backend 已删除），按上表处理 |
| `multiAgentSchemeId = X` | `ai_agent_schemes.agents_json` 内每个 Agent → 库条目（`source: custom`），id 并集写入；`scheme.instructions` 丢弃并计入迁移报告 |
| 旧 `auto-*` id（若采纳 §13-1 重命名） | alias 表映射到新 id（`auto-market-structure → desic-market-structure` 等） |

迁移时机：配置加载时的**内存迁移**（不改盘）+ 首次保存/首次成功运行后**落盘**。迁移结果写进运行详情/启动日志，并生成用户可见的一次性提示（"已把 3 个自定义 Agent 迁移到 Agent 库"）。

### 7.2 DB 迁移

- `ai_agent_profiles`：`ADD COLUMN enabled_agent_ids_json TEXT NOT NULL DEFAULT '[]'`（沿用 `ensure_column` 既有写法，`ai_automation.rs:1019-1027` 一带）。
- 新表 `ai_agents(id PRIMARY KEY, name, role, source, dir, fingerprint, created_at, updated_at)`。
- 旧列与 `ai_agent_schemes` 表**不立即 DROP**（回滚需要），命令层删除；下一版再清理。

### 7.3 内置 bundle 安装

`ensure_builtin_agent_bundles()`（`storage_config.rs`，与 `ensure_builtin_skill_bundles()` 同构、幂等、best-effort）：把 8 个内置 Agent 的 AGENTS.md 写到 `cline_agents_dir`，指纹一致跳过，用户改动内置文件时按技能库既有策略处理（不覆盖、以指纹判定、UI 显示"已本地改动"）。现有 8 个内置 Agent 的职责文本从 `AUTO_PROFILE_AGENTS` 平移，不改内容口径。

---

## 8. 实施阶段（P0–P6）

| 阶段 | 内容 | 估算 | 风险级别 |
| --- | --- | --- | --- |
| P0 | 冻结本文档，标注 v2 §3.1/§3.2/§5.2/§5.6 与 P2c/P3/P4 作废；先写测试骨架（迁移表、frontmatter 往返、策略规则） | 0.5d | 低 |
| P1 | 护栏清理（§3）：删截断、stall 改心跳、删总时限、咨询上限默认不限；更新 `test:ai-multi-agent`、`test:ai-stream` | 1.5d | 中（影响在跑的运行：需回归一次真实后台运行） |
| P2 | Agent 库落地（§2.3、§2.4、§7.3、Rust 命令）：文件 + frontmatter + 解析/渲染 + 内置 bundle + `ai_agents` 表 | 2.5d | 中（新增，可独立验证） |
| P3 | 删 backend 编排器与 auto 分配，改勾选模型（§4、§6.4）；`resolveEnabledProfileAgents` + 目录注入 + UI 复选框 + 迁移 | 2.5d | **高**（运行链路切换，需 `smoke:ai-subagent` 全绿） |
| P4 | agents tab UI（列表/编辑器/手动创建/AI 创建对话框） | 2d | 中 |
| P5 | 工具面打通（§6.3）：`agent.list/read/create/update` + 策略 + AI 研究联调 + i18n + `PRODUCT.md`/`docs/ai-automation-guide.md` 更新 | 1.5d | 中（工具权限属高风险区，须 `test:ai-policy` + `smoke:config-security`） |
| P6 | 迁移回归 + 端到端（研究创建 Agent → Profile 勾选 → 后台运行调度 → 报告回流）+ 版本 v0.1.42 | 1.5d | 中 |

合计约 12 人日。P1 与 P2 可并行（不同文件）；P3 依赖 P2；P5 依赖 P3/P4。

---

## 9. 验证清单

```bash
npm run build                                   # TS/前端
cargo check --manifest-path src-tauri/Cargo.toml --workspace   # Rust
npm run test:ai-policy                          # 工具策略（新增 agent.* 规则）
npm run test:ai-multi-agent                     # 勾选解析、报告原样回流
npm run test:ai-stream                          # 心跳不影响流
npm run smoke:ai-subagent                       # 端到端调度（需本地模型后端）
npm run smoke:config-security                   # 数据目录与 Agent 库落盘安全
npm run smoke:ai-preview                        # AI 预览
npm run test:i18n                               # agents tab 文案
npm run test:release-version                    # 版本四处一致
node scripts/test-agent-library.mjs             # 新增：frontmatter 往返 + 内置 bundle 幂等 + 迁移表
npm run prepare:sidecar                         # sidecar 重新打包后再跑 smoke
```

关键回归点：① 无勾选时行为与今天 `off` 完全一致；② 勾选名单里有缺账户/缺 Skill 的 Agent 时不崩、有提示；③ 长时间专家分析不再被杀、UI 有进度提示；④ 内置 Agent 文件被用户改动后不被覆盖；⑤ 后台运行**不能**创建 Agent（策略拒绝）。

---

## 10. 删除清单（执行锚点）

- `scripts/cline-profile-agents.mjs`：`PROFILE_AUTO_MULTI_AGENT_MAX`、`PROFILE_CUSTOM_MULTI_AGENT_MAX`、`PROFILE_MULTI_AGENT_MAX`、`PROFILE_MULTI_AGENT_REPORT_LIMIT`、`..._REPORT_TOKEN_BUDGET`、`..._STALL_TIMEOUT_MS`、`..._TOTAL_TIMEOUT_MS`、`..._MAX_CONSULTS_PER_RUN`、`..._FOLLOW_UPS_PER_EXPERT`、`resolveProfileMultiAgents`、`eligibleAutoProfileAgents`、打分与 boost 逻辑、`truncateProfileAgentReport` 及两个 slice 辅助、`createProfileAgentStallWatchdog`（→ `createProfileAgentProgressPulse`）
- `scripts/cline-sidecar.mjs`：`runConfiguredProfileAgents`（L3833 orchestrator 分支 + L3835 起两波）、复核波判断、`selectProfileAgentOutcome`（L3640–3660）、`multiAgentVetoBlocksTool`（L783/942/2283/2376）、截断调用（L3446/3448/3632/3799/3875/3929/4199）、总时限相关（L4084-4086 参数默认、L4357 `withRejectTimeout` 包裹）、stall 杀进程（L3703-3706）
- `scripts/cline-tool-policy.mjs`：`disabled:lead-dispatch-off` 的 orchestrator 分支（简化为"名单为空"）
- `src-tauri/crates/agent-automation/src/lib.rs`：`MULTI_AGENT_ORCHESTRATOR_*`、`MULTI_AGENT_EXPERT_SOURCE_*`、`MULTI_AGENT_AUTO_MODE/CUSTOM_MODE`（迁移期仅保留 `normalize_multi_agent_mode` 供读旧）、`AiProfileSubAgent` → `AiAgentDefinition`
- `src-tauri/src/ai_automation.rs`：`AGENT_TEMPLATE_PHASES`、`ai_agent_scheme_*` 命令、`multi_agent_*` 列写入路径
- `src/ui/AiAutomationPanel.tsx`：L581-585（派生）、L601-606（草稿上限）、L637-638（默认值）、L850-854（协作摘要）、L1256-1258（传参）、L4405-4434（保存前校验与 payload）、L4892-4894 与 L5358（方案模板 UI）
- `src/types.ts`：`AiAgentScheme*`、`AiAgentTemplatePhase`、`multiAgentMode/maxAgents/multiAgents` → `enabledAgentIds`

---

## 11. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 去掉全部预算后 token 成本上升 | 成本不可预期 | 运行详情可视化用量 + Profile 可选上限 + 用户取消；不做静默节流 |
| 主 Agent 滥点专家（循环咨询） | 长尾耗时 | 心跳与计数可见；建议默认给主 Agent 的提示词写明"证据充分即返回、不为凑数点名"；如仍发生再考虑软提示而非硬闸门 |
| 删除后端硬否决 | 风险专家 blocker 不再强制阻断 | 明确写入文档与 UI 提示（"专家意见仅供参考，最终由主 Agent 判断"）；`trade.precheck` 结构化 blocker 仍可见 |
| AGENTS.md 成为提示词注入面 | 恶意 agent 文件影响主 Agent | 固定外壳不可覆盖；报告仍按不可信证据注入；AI 创建需人工确认；工具创建限定交互式会话 |
| 迁移丢失自定义 Agent | 用户资产损失 | 迁移只增不删；旧列/旧表保留一版；迁移报告落盘可追溯 |
| 勾选模型切换期间的旧配置误读 | 行为突变 | 读旧写新 + "无勾选=独立工作"的等价性测试作为 P3 出口条件 |

---

## 12. 与 v2 的差异对照

| 主题 | v2 | v3 |
| --- | --- | --- |
| 编排者 | 双编排器（backend \| lead），正交两字段 | 唯一：主 Agent |
| 专家来源 | auto 关键词打分 / custom 列表 | Agent 库 + Profile 勾选（无打分、无截断、无静默过滤） |
| 必需专家 | 动作绑定规则（D2） | 取消 |
| 动作闸门 | P3 `profileAgentActionGate` | 取消 |
| 预算 | 后端硬约束（D6） | 取消，改可观测 |
| 复核波 | 自动成波（D5） | 取消；复核专家变成"可勾选、可点名"的普通 Agent |
| Agent 载体 | Profile 内字段 + 拼接提示词 | 一级实体：`agents/<id>/AGENTS.md` |
| 创建通道 | 仅 UI 手填 | 手动 + AI 创建（UI 与 AI 工具共用实现） |
| 旧方案模板 | 保留 | 删除，内容迁移进 Agent 库 |

---

## 13. 董事会已拍板（原"待确认 3 点"，已定案）

1. **内置 Agent id 去掉 `auto-` 前缀 → `desic-*`**，旧 id 走 alias 迁移（映射表见契约 C1）。
2. **咨询/追问次数不做上限，也不做可选上限字段**（连 Profile 高级区的可选项都不加）。
3. **旧 `ai_agent_schemes` 方案/模板确认删除**，模板内每个 Agent 自动迁移为库条目（`source=custom`），模板级 `instructions` 丢弃并计入迁移报告。

施工基准与逐条接口冻结见 `docs/agent-library-contract.md`（并行 builder 共用）。
