# Agent 库 v3 验收手册（reviewer 与 lead 共用）

配套文档：`docs/agent-library-contract.md`（冻结接口）、`docs/multi-agent-dispatch-plan-v3.md`（方案）。
本手册只讲**怎么验、看什么、怎么判**；reviewer 只读不改代码，产出缺陷单（模板见 Part C）。

> **修订记录 · 2026-09-20（何茗 · 产品）· 未 commit**
> 依据：C20.5 裁决（司南，`msg_24ff9218` / 最终落地口径 `msg_bb8d8eed`）+ 事实复核（顾砚，`msg_23a5bfbd`）。
> 改动：Part E 的 **E1 / E2 / E3** 期望值改为 C20.5 生效后的口径；**B4 日志行 ↔ E1 加交叉引用**（`written` / `upgraded` 是两个计数）。
> **未改动**：**`scopes` 的四处叙述**（B7 / B8，属 C15 的验证用例，**有意保留**）。
> **第二轮（2026-09-20 · 顾砚核完 B6，`msg_3bf19750`）**：B6 的 `auto` 期望值 **8 → 4**（依据：实现 `agents.rs:1297→1312`；单测 `:1917→1935`）—— **第一轮「B6 标待核、不改值」已被本轮取代**（留痕，不覆盖旧记录）。
> **注意四个数字各就各位（别混成一个）**：**落盘内置目录 11（E2）· UI 列表 4（E3）· boot.log 首启 11（E1，本次新建数、仅 > 0 输出）· 旧 `auto` 迁移后勾选 4（B6）**。
> 五元组（**第二轮改前**）：SHA-1 `1e62d2faeca41c827194fe3a3235b2d9e5027350` · size `13079` · 行数 `133` · mtime `2026-09-20 08:09:46` · 测量时刻 `2026-09-20T00:09:49Z`。
> 五元组（**第二轮改后 · 写入本行之前**）：SHA-1 `171540befa6fdffa3b90c65e5f1ac0561053a3c1` · size `14006` · 行数 `135` · mtime `2026-09-20 08:10:23` · 测量时刻 `2026-09-20T00:10:32Z`（自指说明同前：写入本行会再次改变哈希，**入档请用 `git hash-object` 重新取值**）。
> 五元组（**改前**）：SHA-1 `8f42e3696e77ebb806bb67288834481d00825044` · size `9963` · 行数 `122` · mtime `2026-09-18 17:40:58` · 测量时刻 `2026-09-20T00:08:49Z`。
> 五元组（**改后 · 写入本修订记录之前**）：SHA-1 `e5766c664dc04b2e891c4f080169866ebb9eb382` · size `11966` · 行数 `129` · mtime `2026-09-20 08:09:14` · 测量时刻 `2026-09-20T00:09:17Z`。
> 五元组（**含本修订记录 · 当前基线**）：SHA-1 `b5ef39c5d2212255520676768b74376fb9f36212` · size `12353` · 行数 `131` · mtime `2026-09-20 08:09:36` · 测量时刻 `2026-09-20T00:09:41Z`。
> ⚠️ **自指说明（五元组记不进自己）**：把五元组写进文件这一动作**本身会改变 SHA-1 / size / 行数**，因此本记录里的任何哈希**只描述"写入该行之前"的状态**，永远无法等于"写入之后"的最终值。**入档时请用 `git hash-object <file>` 重新取值**，并以本记录 + `git diff` 作为归属证据；**不要**拿本记录里的哈希去校验最终文件（那样必然对不上，且不是文件错了）。
> diff 证据：`git diff --stat` = **1 file changed, 12 insertions(+), 5 deletions(-)**；共 **4 处 hunk**（修订记录 / B4 日志行交叉引用 / B6 `auto` 标待核 / E1·E2·E3 期望值）。

---

## Part A 命令闸门（每条都要真实跑过并抄回输出结论）

| # | 命令 | 期望 | 归属 |
| --- | --- | --- | --- |
| A1 | `npm run build` | 零 TS 错误 | B-UI |
| A2 | `cargo check --manifest-path src-tauri/Cargo.toml --workspace` | 零错误 | B-RUST |
| A3 | `npm run test:ai-policy` | 全通过（含 `agent.*` 两条新拒绝规则） | B-JS |
| A4 | `npm run test:ai-multi-agent` | 全通过（勾选解析、无截断、心跳只通知） | B-JS |
| A5 | `npm run test:ai-stream` | 全通过（新增事件不破坏流） | B-JS |
| A6 | `npm run test:i18n` | 全通过（契约 C7 键名清单） | B-JS/B-UI |
| A7 | `npm run test:release-version` | 四版本号一致（0.1.41，**本轮不 bump**） | 全员 |
| A8 | `npm run prepare:sidecar` | 成功产出 `src-tauri/resources/ai-sidecar/sidecar.mjs`（未跟踪，不进 diff） | B-JS |
| A9 | `npm run smoke:config-security` | 通过（Agent 库落盘不泄密、不越权） | B-RUST |
| A10 | `npm run smoke:automation-preview` | 通过（按契约 C13 钩子重写后） | B-JS/B-UI |
| A11 | `cargo test -p desic-agent-automation` | 解析/校验/渲染/alias 迁移单测全绿 | B-RUST |
| A12 | `node --check scripts/cline-sidecar.mjs` 等 | 语法零错误 | B-JS |

> 环境提示：本机 `tauri dev` 常驻，`127.0.0.1:1420` 已就绪，Playwright smoke 可直接跑；cargo 命令若长时间等待，是 dev 实例持有 target 锁，不是失败。

---

## Part B 七条出口条件（逐条给验证手法）

### B1 无勾选 = 等价旧 `off`
- 手法：构造 config `enabledAgents: []`，跑 `smoke:ai-subagent` 同款路径或单测；断言：主 Agent 提示词中**不含**专家目录块、`consult_expert` / `follow_up` 策略为 `disabled:lead-dispatch-off`、无任何专家会话被创建。
- 判据：行为与改造前 `multiAgentMode=off` 逐项一致（提示词、工具面、事件流）。

### B2 缺依赖专家不崩、有提示、仍可点名
- 手法：`enabledAgents` 里放 `desic-account-risk`（`requiresAccount: true`）但 `agentProfileAccountId` 为空；放 `desic-intelligence-flow` 但 `activeSkillIds` 不含 `okx-market-intelligence`。
- 断言：目录块仍列出两者；两者的任务前缀出现"未绑定账户/未激活 Skill"提示；**不出现**剔除、不出现异常。
- 反例（必须失败才算漏）：名单被过滤、或抛错终止运行。

### B3 长跑不杀、报告与追问无上限
- 手法：单测注入假计时器推进 30 分钟无进展 → 只产生 `agentProgressNotice`（每 `repeatEveryMs` 一次），**无 abort/无 reject**；synthetic 报告长度 100k 字符 → 回流文本与原始报告 `===`（逐字相等），不存在截断标记；连续 `follow_up` N 次不受限。
- 断言：`grep -rn "truncateProfileAgentReport\|STALL_TIMEOUT\|TOTAL_TIMEOUT\|MAX_CONSULTS\|FOLLOW_UPS_PER_EXPERT" scripts/` 结果为空。

### B4 内置 Agent 的"不覆盖"与"安全升级"（含安装清单指纹）

- **用户改动必须保留**：改一个内置 `AGENTS.md` 正文 → 重启安装流程 → 文件内容仍是用户改动后的版本，`ai_agents_list` 该条 `modified: true`。
- **未改动的旧版本可安全升级**：在清单（`ai_automation_settings.builtin_agent_files_fingerprint`，与 `skill_files_fingerprint` 同构）记录存在且与盘上文件哈希一致时，把该文件内容替换成上一版 → 再跑安装 → **被覆盖为当前版本**（`upgraded`），并回写清单。
- **清单缺失时保守**：删掉清单键、保留一个内容不等于当前内置的文件 → 安装**不覆盖**该文件，记 `manifest_missing` 并在 boot_log 出现 `builtin agent fingerprint manifest missing`，且**不回写清单**（不猜测用户是否改过）。
- **幂等**：连续两次安装，第二次 `written=0 / upgraded=0`，清单条目数 == 内置 Agent 数。
- **日志**：`builtin agent bundles: written N upgraded N kept(user-modified/unknown) N`（⚠️ `written` 与 `upgraded` 是**两个独立计数**：升级走 `upgraded`，**不触发 Part E 的 E1 那一行** —— 与 E1 交叉引用，勿读成矛盾）。

### B5 后台 Run 不能创建 Agent（双重拒绝）
- 手法：① JS：`describeToolPolicy("agent.create", { backgroundRun: true, agentRole: "main" })` → `allowed === false`、`policy === "disabled:agent-authoring-interactive-only"`；② Rust：构造带后台 `run_context` 的 `AiToolExecutionContext` 调 `authorize_ai_tool("agent.create", ...)` → `Err`。
- 允许路径：交互式主会话（`backgroundRun: false`）→ 两侧均放行。

### B6 迁移正确且幂等
- 手法：准备旧 profile 三种形态（`off` / `auto` / `custom` + `multiAgents`）与一条旧模板（`ai_agent_schemes.agents_json` 含 2 个 agent + `instructions`），跑迁移：
  - `off` → `enabledAgentIds == []`
  - `auto` → **4 个**（= `default_enabled_agent_ids()`，即**新 4 流程角色**；**不是旧内置的 8 个**）。依据（A 正文级，两条独立）：实现 `agents.rs:1297 plan_legacy_agent_migration` → `:1312` 对旧 `auto` 形态直接置 `plan.enabled_agent_ids = default_enabled_agent_ids()`；单测 `agents.rs:1917 migration_covers_off_auto_custom_and_scheme_entries` → `:1935 assert_eq!(auto.enabled_agent_ids, default_enabled_agent_ids())`。`default_enabled_agent_ids()`（`:1102-1108`）的过滤条件是 `!spec.deprecated` ⇒ 长度 **4**（`deprecated_builtin_agent_ids()` 才是 7）。**断言以该单测为准** —— 将来角色集变更时，本行随该单测失效，须一并更新
  - `custom` → 每个 agent 落成 `agents/<slug>/AGENTS.md`（`source: custom`），id 进入勾选
  - 旧模板 → 2 个库文件出现、指令被丢弃且计入迁移报告
  - 旧 `auto-*` id → 按 C1 alias 映射为 `desic-*`
- 幂等：再跑一次迁移 → 不新增文件、不覆盖已存在文件、勾选不重复。
- 断言：文件系统 + profile 行 + 迁移报告三处一致。

### B7 保存/更新边界
- `ai_agent_save` 传入正文 frontmatter 的 `id` 与目录名不一致 → `Err`；内置 id → `Err`（提示改用 `ai_agent_duplicate`）。
- `agent.update` 指向内置 agent → `Err`；`agent.create` 生成的条目 `source == "ai"`，且 frontmatter 必含 `id/name/role/envelope`。
- 恶意输入：`envelope: "none"` → `Err`；references 路径含 `..` 或绝对路径 → `Err`；正文 > 200KB → `Err`。
- **C15 起 `scopes` 不再是文件字段**：文件里出现它 → 忽略 + `scopesDeprecated`（不报错）；`agent.create` 传 `scopes` 入参 → 忽略。范围校验改在**点名**侧：`consult_expert`/`follow_up` 传白名单外的域 → 工具调用 `Err`（列出非法值），缺省或 `[]` → 全部只读工具。

### B8 scopes 移除（契约 C15，2026-09-18 追加）
- **文件层**：写一份含 `scopes: [market]` 的 AGENTS.md → `ai_agent_read` 可读、`ai_agents_list` 该条 `scopesDeprecated: true`、序列化结果里**没有** `scopes` 键；`ai_agent_save` 成功后文件里不再写该行（新写的文件不含）。
- **点名层**：`consult_expert` 不传 `scopes` → 专家可用工具 = 全部只读工具（在轨迹/工具面上体现）；传 `["market"]` → 只含 market 域工具；传 `["shell"]` → 工具调用报错且错误里含 `shell`；返回体带 `grantedScopes`（缺省时是五个域或"全部只读"语义）。
- **授权层**：`configuredAgentId` 不在本次勾选名单 → 拒；声明域 ⊆ 白名单；`account.*` 未绑账户仍拒、`intelligence.*`/`radar.*` 缺对应 Skill 仍拒、写与交易类工具对专家恒拒。
- **UI 层**：agents tab 库列表行、详情 facts、创建对话框都不出现 scope 标签/字段；运行轨迹与 AI 研究里显示"本次授予范围：…"（或"全部只读"）。

---

## Part E 真实运行时端到端（A/B 闸门之外的最后一关）

以下步骤需要跑起真实 Tauri 应用（`npm run tauri:dev` 或打包版），在 v3 交付前**必须**至少走一遍并记录结果；未做则必须在交付说明里写进"未验证清单"。

| # | 步骤 | 期望证据 |
| --- | --- | --- |
| E1 | 启动应用，读启动日志（macOS `~/Library/Logs/com.desic.terminal/boot.log`，Windows `%LOCALAPPDATA%\com.desic.terminal\logs\boot.log`） | 该行数字 = **本次新建数**（`written`，**仅在 > 0 时输出**）：**全新数据目录（`agents/` 下无预置文件）首启 = `11`**；**二次启动不出现该行**；**升级场景（内置正文变更，走 `upgraded`）同样不出现该行** ⇒ **不得把「升级后应出现该行」当期望**（与 B4 的 `written` / `upgraded` 两个计数交叉引用，勿读成矛盾） |
| E2 | 检查 dev 工作区 `<repo>/.cline/agents/`（打包版为 `<data_dir>/workspace/.cline/agents/`） | **11 个**内置目录（7 个 `deprecated` + 4 个默认角色），各含 `AGENTS.md`，frontmatter 含 `id/name/role/envelope/source: builtin`｜**dev 路径口径待接口冻结清单 v1**（实际由 `runtime_paths()` 决定；dev 下 `data_dir` 是否等于 repo 根**未核**） |
| E3 | 打开 `AI 自动化 → agents` | 列出 **4 个**内置 Agent（新 4 流程角色；`ai_agents_list` **默认不返回 `deprecated`** ⇒ **UI 不渲染旧 7 个，也不可在勾选器勾回** —— C20.5 裁决），点开编辑器为**只读**、保存按钮禁用｜⚠️ **三个数字各就各位：落盘 11 / 列表 4 / boot.log 首启 11** |
| E4 | 手动创建一个自定义 Agent 并保存 | `<repo>/.cline/agents/custom-*/AGENTS.md` 出现，列表出现 `source: custom` 条目 |
| E5 | 在 Profile 编辑器勾选 1–2 个 Agent 并保存 → 关闭重开该 Profile | 勾选持久化；`ai_agent_profiles.enabled_agent_ids_json` 与界面一致 |
| E6 | 改一个内置 `AGENTS.md` 正文后重启应用 | 文件仍是改动后的内容（不被覆盖），列表该条显示"已本地改动"（`modified: true`） |
| E7 | 删除自定义 Agent | 目录消失；曾经勾选它的 Profile 勾选被剔除；内置 Agent 的删除入口不可用 |
| E8 | AI 研究里让主 Agent 调 `agent.list` / `agent.create`（需可用模型后端） | 工具返回库列表 / 新 Agent 落盘且 `source: ai`；后台自动化运行中同一工具被拒绝 |

已知环境限制：本机 `http://192.168.0.21:8004/v1` 模型后端不可达时 E8 无法执行——记录为未验证，不要伪造。

## Part C 缺陷单模板（reviewer 交付格式）

```
[严重度 P0/P1/P2] 一句话标题
- 契约条款：C1/C2/C3/... 或出口条件 B1-B7
- 证据：<命令> → <原始输出片段>
- 位置：path:line
- 期望 / 实际：
- 影响面：（用户可见？数据安全？迁移？）
- 建议修法（可选，只描述不改代码）：
```

严重度定义：P0 = 静默失效/数据损坏/权限越界；P1 = 契约违反或出口条件不满足；P2 = 体验、文案、幂等瑕疵。

## Part D 证据记录表（reviewer 填写）

| 条件 | 命令/手法 | 观察结果 | 判定 |
| --- | --- | --- | --- |
| A1–A12 | 逐条 | | |
| B1 | | | |
| B2 | | | |
| B3 | | | |
| B4 | | | |
| B5 | | | |
| B6 | | | |
| B7 | | | |
