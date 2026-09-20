> ⚠️ **2026-09-18 后续变更（契约 C15）**：`scopes` 字段已从 AGENTS.md 移除，专家的只读工具面改由主 Agent 点名时决定（缺省全部只读、可传 `scopes` 收窄）。因此本规格里涉及 **scopes chip / 范围标签 / 详情"证据范围"行**的条目**已失效**，实现时请忽略；其余布局、令牌、层级与降级规则仍然有效。运行轨迹新增"本次授予范围"徽标（`[data-agent-granted-scopes]`，复用既有 lane meta 样式）。

# Agent 库 / Profile 勾选器 视觉重设计规格

> 状态：可施工规格（本轮不改代码）。依据：真实截图（见 §1.2）+ 源码通读。
> 范围：`src/ui/agent-library/AgentLibraryView.tsx`、`ProfileAgentSelector.tsx`、`AgentLibrary.css`，以及与 `AutomationPreview` agents 分支相关的视觉表现。
> 目标：消除"丑"的具体来源，与 `SystematicStrategyLab`（下称 lab）同族，遵守全部测试钩子与容器查询约束。

---

## 1. 现状证据

### 1.1 阅读过的源码

- `src/ui/agent-library/AgentLibraryView.tsx`（884 行，三栏 + 两对话框）
- `src/ui/agent-library/ProfileAgentSelector.tsx`（201 行，C14 协作开关 + 勾选列表）
- `src/ui/agent-library/AgentLibrary.css`（全量）
- `src/ui/AiAutomationPanel.tsx`（`AutomationPreview` agents/config 分支、ProfileEditor 挂载点）
- `src/ui/SystematicStrategyLab.css`（设计令牌与 row/pane-head/badge 范式）
- `src/styles.css`（`:root` 全局变量）
- `scripts/smoke-automation-preview.mjs`（钩子断言与源码框高度断言）

### 1.2 逐张看过的截图（`npm run smoke:automation-preview` 本轮产物）

| 文件 | 尺寸 | 内容 |
| --- | --- | --- |
| `automation-1440x900-agent-library-builtin.png` | 1440×900 | agents tab，选中内置"市场结构" |
| `automation-1280x720-agent-library-builtin.png` | 1280×720 | 同上，窄一档 |
| `automation-1440x900-agent-selector.png` | 1440×900 | Profile 配置内勾选器，已勾选 4/7 |
| `automation-1280x720-agent-selector.png` | 1280×720 | 同上，可见协作开关渲染破损 |
| `automation-1280x720-agent-selector-empty.png` | 1280×720 | 清空后空态 hint |
| `automation-1440x900-agents-create-ai.png` | 1440×900 | AI 创建对话框（生成前） |

注：smoke 在"关闭 AI 创建对话框"点击步骤超时失败（exit 1，Playwright stability 重试与导航竞态），自定义 Agent 与手动创建对话框截图未产出；这两个区域的判断以源码为准，下一轮实现后必须补齐截图复查。此失败本身也需复查（疑似 `modal-actions` 按钮动画/重挂载导致不稳定，见 P2-12）。

---

## 2. 问题清单（按严重度）

严重度：**P0** = 渲染破损/信息不可读；**P1** = 明显丑、拉低专业感；**P2** = 不一致/可更好。

### P0

**P0-1 协作总开关视觉破损（勾选器）**
截图：`automation-1280x720-agent-selector.png` / `-empty.png` 顶部。
现象：渲染出原始 i18n key 连排文本 `profileCollaborationToggleprofileCollaborationToggleHint`（无间隔、无大小写层级），右侧挂一个原生 checkbox；JSX 里的 `.agent-picker__toggle-track` 轨道 span **在 CSS 中完全没有样式**（grep 全仓库无匹配），所谓"开关"实际是个未装饰的复选框。
改为：① 补齐 track/knob 开关样式（规格见 §4.6）；② 排查预览环境 key 回退（key 在 `src/i18n/resources.ts:603/1161` 存在，却回退成原始 key 且连排——需确认 `AutomationPreview` 的 i18n 初始化是否漏挂 automation 命名空间，或 `legacyBridge` 未覆盖新增 key）；③ 无论 key 是否命中，toggle-copy 的 `strong`/`small` 必须分行（grid gap 2px），永不连排。

**P0-2 勾选器行徽标被截断成乱码感**
截图：`automation-1280x720-agent-selector.png` 各行右侧——"已被 1 个 Profi"、"已本"、"未激活的 Skill: ok" 均被 `.agent-picker__row-tags { max-width: 44% }` + 单行 nowrap 切断，信息不可读且看起来像 bug。
改为：徽标改"优先级 + 限量"策略——每行最多显示 2 枚（优先级：风险审查 > 缺失账户/技能 > 已本地改动 > 被 N 个 Profile 勾选），其余折叠为 `+n` 计数徽标（title 承载全文）；单枚徽标 `max-width: 180px` 内 ellipsis，行容器不再设 44% 硬上限，改为 `flex: 0 1 auto` 自然收缩。

**P0-3 编辑器三列顶线不齐 + 右栏顶部直接是按钮墙**
截图：两张 `*-agent-library-builtin.png`。
现象：左列头部 ~74px（标题+两行说明）、中列编辑器头 ~57px、右列没有头部、第一颗像素就是"新建 Agent"紫底按钮。三条列的第一条水平基线互相对不上，是"排版丑"最直观的来源。
改为：三列统一 40px pane-head（规格 §4.1），说明文案移出头部（见 P1-2），右列增加同高头部"操作"。

### P1

**P1-1 右栏 rail：按钮墙 + 表单式 facts 表 + 信息重复**
截图：`*-agent-library-builtin.png` 右列。
现象：① 4 颗全宽按钮竖排（紫底/描边/描边/红字），占据 rail 顶部约 1/3，视觉重量远超其使用频率；② facts 表 8 行 label:value 带 hairline，74px 标签列像一张只读表单，而同样的信息（来源/角色/范围/风险）在编辑器头部徽章里已出现一次；③ "已被 1 个 Profile 勾选" flag 框下面又裸列一行 "BTC 永续决策台"，同一件事表达两遍；④ 路径虚线框 9.5px 等宽字收尾，孤零零。
改为：操作区改 2 列紧凑网格（主按钮跨 2 列，§4.3）；facts 收敛为 4 行关键项（角色/范围/版本/更新时间），来源与风险由头部徽章承担；Profile 名单改 chip 行并入 flag 区；路径降为 rail 底部 pinned footer（更弱一级）。

**P1-2 左列头部说明文案挤占头部**
截图：`*-agent-library-builtin.png` 左上。
现象：`agentsIntro` 三行 10px 灰字把列表头撑到 74px，是 P0-3 的直接原因；且这段"教学文案"每次进入 tab 都常驻。
改为：头部只留 `Bot 图标 + Agent 库 + 计数 chip + 刷新` 一行（40px）；intro 文案只在空态（`data-agent-library-empty`）和搜索无结果态出现。JSX 需微调（规格 §5.2）。

**P1-3 列表行徽章行噪声过高**
截图：`*-agent-library-builtin.png` 左列，如"账户风险"行：`account · history · market` + 橙色"需要绑定账户" + 紫色"已 1 个"三枚 9px 描边徽章挤一行，加 wrap 后各行高度不一。
改为：行结构两级化——第一行：名称（12px/600）+ 角色（右端 9px mono 灰）；第二行：scope 文本（9px 灰，不带框）+ 语义徽章最多 2 枚（警告类优先），规则与 P0-2 相同。徽章从"描边小盒子"改为 lab 式 `currentColor` 细边框 chip（§3.4）。

**P1-4 编辑器头部：模式切换与保存按钮关系不清**
截图：`*-agent-library-builtin.png` 中列右上。
现象：分段控件（源码/preview）与"保存"按钮同为描边样式、只差 8px 间距，保存是这个头部的**主动作**却视觉最弱；禁用态 `opacity:.45` 让按钮看起来像"脏了"。标题下方的徽章带（内置/market_structure/风险/已改动/未保存）最多 5 枚，与标题两行排布又把头部撑高。
改为：头部固定 44px 单行——左：名称（13px）+ 徽章带（与名称同一基线，空间不足才换行）；右：分段控件（保持）+ 1px 竖分隔 + 保存按钮改 accent-tint 主按钮（lab `.systematic-lab__save-button` 同款：`color-mix(in srgb, var(--accent) 14%, transparent)` 底 + 58% accent 边）；禁用态改为"降低对比"（文字/边框各 40% 透明度）而非整钮半透明。

**P1-5 三种近黑底色无层次逻辑**
现象（源码）：列表 `var(--panel)` #080a0e、编辑器 #090a0d、rail #08090c、源码框 #05060a——四个任意近黑色，既不是明度递进也不是功能分区。
改为：对齐 lab 两层体系——列体统一 `--agent-bg: #0a0d12`（lab 列体同色），pane-head 同底色以 hairline 分隔；源码框作为唯一"深井" `#05060a`，并加 1px `var(--line-soft)` 内边框 + 6px 圆角 + 外圈 10px padding（lab `.systematic-lab-code-surface__editor-wrap` 手法），让"深"成为有意图的 inset 而不是第四种面板色。**注意保持源码框高度断言成立（§6 验收）。**

**P1-6 AI 创建对话框：半空表单 + 失衡双栏**
截图：`automation-1440x900-agents-create-ai.png`。
现象：① 1080px 宽对话框里左栏表单内容只占了上半，下方大片纯黑；② 右栏预览区生成前只有一句弱灰提示孤零零悬在中央；③ 预览头的"源码/preview"是两颗描边小按钮，与主编辑器的分段控件样式不一致；④ 底部三按钮（取消/生成草稿/保存）中"生成草稿"是流程主动作却与"保存"并列，保存禁用态灰成一坨。
改为：表单字段收紧（label 全大写 nano、input 高 30px、间距 10px，§4.5）；预览空态改居中 icon + 两行引导文案 + 虚线框（与列表空态同族）；预览头换成与编辑器同款分段控件；底部按钮分级——取消（quiet）、生成草稿（accent-tint 主按钮）、保存（confirm 实心，生成前禁用并附 `title` 说明）。

### P2

**P2-7 分组标题与计数脱节**
截图：勾选器 "内置 ……… 5"，计数漂到行最右端，与标题之间一条空白。
改为：计数 chip 紧跟标题文本（gap 6px），样式统一为 lab tab 计数 chip（`min-width:18px; padding:2px 4px; radius:6px; background:rgba(255,255,255,.055)`）。列表与勾选器共用。

**P2-8 勾选器行"卡片化"过重**
截图：`*-agent-selector.png`——7 行 = 7 个带边框圆角盒子，与 Profile 编辑器其他区块（hairline 分隔的表单节）风格断裂。
改为：去卡片，改 lab 行范式：行间 1px `var(--line-soft)` hairline、选中态 `inset 2px 0 0 var(--accent)` + `color-mix(accent 6%)` 底、hover 4.5% wash；checkbox 自定义 14px（accent 描边、勾选时 accent 底 + 对勾）。行内 padding 收敛为 `8px 10px`。

**P2-9 勾选器头部三个右对齐元素不在一条基线**
截图：`*-agent-selector.png`——"已勾选 4/7"在标题行右侧，"管理 Agent 库 + 刷新"在下一行右侧，中间夹左对齐的"全选内置/清空"。
改为：两行结构固定——行 1：标题+hint（左）| 计数 chip（右）；行 2：快捷动作（左：全选内置/清空）| 跳转+刷新（右）。两行各自 `align-items:center` 单基线。

**P2-10 内置/自定义/AI 创建三组区分度不足**
现象：三组仅靠 10px 灰字标题区分；内置组其实承担"官方只读"语义。
改为：组标题行右侧（计数 chip 旁）给内置组追加一个极弱的"只读"标注（nano 8px 大写 tracked，`var(--weak)`）；三组的图标色微分（内置=accent 60%、自定义=muted、AI=down 60%），列表行不再每行重复来源徽章（来源已由分组表达）。

**P2-11 空态/加载态/错误态样式三处漂移**
现象：空态有两种虚线框（`__empty-hint` 6px / `__empty` 8px radius）；`__state` 是裸文本行；`__list-error` 又是带框 banner。
改为：统一一个 state 范式——`icon + 一行文案 +（可选）一个描边小动作按钮`，居中网格、padding 20px；错误态仅换 `var(--status-failed)` 色；虚线框统一 `radius:6px; border-color:#2b2a33`。

**P2-12 预览面板未填满高度 + smoke 对话框点击不稳定**
截图：`*-agent-library-builtin.png` 底部约 200px 纯黑（面板在 ~690px 处收尾）。
改为：确认真实窗口中 `.automation-content--library` 的 flex 链使 `.agent-lib` 铺满（预览页的留白若是 harness 固有则不处理，但要在真实 Tauri 窗口验证一次）；smoke 的"取消"点击超时疑似 modal 关闭时重挂载竞态，实现轮复跑确认是否消失，不消失则在 `scripts/smoke-automation-preview.mjs` 之外排查（本规格不改 scripts）。

**P2-13 徽章/图标紫色硬编码族外值**
现象：`#b9a3ff`、`#9380bd`、`#81778e`、`#34303d`、`#2b2a33`、`#24232b` 等一批"另一套紫灰"硬编码散布在 AgentLibrary.css，与全局 `--accent` 体系和 lab 的 `color-mix` 派生不一致，后续换肤必漂移。
改为：全部收敛到 §3 令牌的 `color-mix` 派生值；硬编码只允许出现在令牌定义处。

---

## 3. 设计令牌

在 `AgentLibrary.css` 顶部、`.agent-lib` 与 `.agent-picker` 共同作用域定义局部令牌（对齐 lab 的 `--lab-*` 手法，别名全局变量，不新增全局变量）：

```css
.agent-lib, .agent-picker, .agent-lib-dialog {
  /* 背景层级：列体 / 头部同层，深井仅源码框 */
  --agent-bg: #0a0d12;            /* 列体 = lab 列体色 */
  --agent-bg-head: #0a0d12;       /* pane-head 同色，靠 hairline 分层 */
  --agent-well: #05060a;          /* 源码深井（唯一更暗的面） */
  --agent-hover: color-mix(in srgb, var(--accent) 4.5%, transparent);
  --agent-selected: color-mix(in srgb, var(--accent) 10.5%, transparent);

  /* 线条 */
  --agent-line: var(--line);            /* rgba(174,186,210,.17) 列分隔 */
  --agent-line-soft: var(--line-soft);  /* rgba(174,186,210,.085) 行 hairline */

  /* 文字（直接别名全局，禁新增色值） */
  --agent-text: var(--text);
  --agent-muted: var(--muted);
  --agent-weak: var(--weak);

  /* 语义 */
  --agent-warn: var(--warn);
  --agent-danger: var(--danger);
  --agent-accent-fg: #d9cbff;                       /* accent 上的文字 */
  --agent-accent-line: color-mix(in srgb, var(--accent) 38%, transparent);
  --agent-accent-soft: color-mix(in srgb, var(--accent) 11%, transparent);

  /* 间距刻度（4 的倍数，2 档微调） */
  --agent-space-2xs: 4px; --agent-space-xs: 6px; --agent-space-sm: 10px;
  --agent-space-md: 14px; --agent-space-lg: 20px;

  /* 字号/行高刻度（与 lab 同档） */
  --agent-text-title: 13px;   /* 编辑器标题、对话框标题 */
  --agent-text-strong: 12px;  /* 行名称、区块标题 */
  --agent-text-body: 11px;    /* 按钮、输入框 */
  --agent-text-label: 10px;   /* label、说明、facts */
  --agent-text-micro: 9px;    /* 徽章、mono 辅助 */
  --agent-text-nano: 8px;     /* 大写 tracked 标注 */
  --agent-lh-prose: 1.6;

  /* 圆角 */
  --agent-radius-control: 6px;  /* 按钮/输入/chip */
  --agent-radius-surface: 10px; /* 面板/对话框 */
}
```

**强调色使用规则**（全模块一致）：
- accent 只给：选中态（inset 条 + 10.5% 底）、主按钮（14% 底 + 58% 边）、focus 环、拖拽条激活、"管理 Agent 库"这类导航性强调。
- warn 只给：需要绑定账户、未激活 Skill、未保存改动。danger 只给删除与错误。`--down` 绿仅出现在 AI 来源图标/徽章（沿用现状语义）。
- 禁止再出现 `#b9a3ff`/`#9380bd` 等族外紫色；需要的"紫灰"一律 `color-mix(in srgb, var(--accent) X%, var(--muted))` 派生。

**徽标（chip）统一范式**——一处定义，四处复用（列表行 / 编辑器头 / rail flag / 勾选器行）：

```css
.agent-chip {
  display: inline-flex; align-items: center; gap: 3px;
  max-width: 180px; padding: 1px 5px;
  border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
  border-radius: var(--agent-radius-control);
  color: var(--agent-weak);
  font-size: var(--agent-text-micro); line-height: 1.4;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.agent-chip.is-accent { color: var(--agent-accent-fg); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.agent-chip.is-warn   { color: var(--agent-warn); }
.agent-chip.is-danger { color: var(--agent-danger); }
.agent-chip.is-quiet  { color: var(--agent-weak); border-style: dashed; }
```

---

## 4. 逐区域布局规格

### 4.1 三栏骨架与 pane-head（对齐基线）

```
.agent-lib  grid-template-columns:
  var(--agent-lib-list-width, minmax(228px, 288px))
  minmax(340px, 1fr)
  var(--agent-lib-rail-width, minmax(240px, 288px))
```

- 三列各有一个 **40px pane-head**：`display:flex; align-items:center; justify-content:space-between; padding:0 12px; border-bottom:1px solid var(--agent-line)`；标题 10px / 700 / uppercase / `letter-spacing:.06em` / `var(--agent-muted)`（lab pane-head 同款）。
  - 左列 head：`Bot 图标 + AGENTS` | 计数 chip + 刷新 icon-button（25×25）。
  - 中列 head：见 §4.2（内容不同但外盒同高同 padding，第一条基线即对齐）。
  - 右列 head：`操作` 文案 | （无动作）。
- 列宽拖拽条、双击复位、键盘 ←/→ 全部保留现状（已是 lab 同源实现）。limits 不变（list 220–460 / rail 248–460），仅默认值收窄。
- 滚动归属：左列 `.agent-lib__list-scroll`、右列 `.agent-lib__rail-body`、中列源码框/预览各自滚动；头部永不滚。

### 4.2 编辑器（中列）

- **头部 44px**（比侧列 head 多 4px 容纳控件，但顶线对齐、底线同为 hairline）：
  - 左区（min-width:0）：名称 13px/650 单行 ellipsis + 徽章带同行 baseline（source / role / risk / modified / dirty，`agent-chip`），空间不足时徽章带整体换行到第二行，头部此时长高为 auto（仅 ≥1040 允许，窄档强制换行）。
  - 右区（flex:0 0 auto）：分段控件（保持现有 `.agent-lib__mode` 结构，样式改为 1px `--agent-line` 边、激活段 `--agent-accent-soft` 底）+ 1×18px 竖分隔 + 保存按钮（accent-tint 主按钮，30px 高）。
  - `data-agent-save`、禁用逻辑（readOnly || !dirty || busy）不动。
- **源码框**：外包 `.agent-lib__source-wrap { padding:10px 12px 12px; display:grid; }`，textarea 本身 `border:1px solid var(--agent-line-soft); border-radius:8px; background:var(--agent-well); padding:10px 12px; font: 11.5px/1.65 ui-monospace…`。**高度断言保护**：wrap 用 `grid-template-rows:minmax(0,1fr)` 且 textarea `height:100%`，编辑器列行模板 `auto minmax(0,1fr) auto` 不变——实现后必须复测 §6 的 240px/55% 断言。
- 只读提示条保留在列底部，样式降为 `--agent-text-label` + 左侧 ShieldAlert，背景改 `color-mix(accent 5%)`，与 dirty 徽章二选一同时出现时以提示条为准。
- 预览态 `.agent-lib__preview` padding 对齐源码 wrap（12px 14px），scrollbar-gutter 保留。

### 4.3 右栏 rail

- head（40px，§4.1）之下：
- **操作区**：`display:grid; grid-template-columns:1fr 1fr; gap:6px; padding:10px 12px; border-bottom:hairline`。
  - 新建 Agent：跨 2 列，accent-tint 主按钮（`is-primary`）。
  - AI 创建 / 复制为自定义：各 1 列，描边 quiet 按钮。
  - 删除 Agent：跨 2 列或独占行右端，danger 描边（`color-mix(danger 34%)` 边 + danger 文字），禁用态降对比。
  - 按钮统一 28px 高、11px、图标 12px。钩子 `data-agent-create-manual/-ai/-duplicate/-delete` 原位保留。
- **facts**：只保留 4 行（角色 / 证据范围 / 版本 / 更新时间）；`grid-template-columns:64px 1fr`；dt 9px uppercase tracked `var(--agent-weak)`；dd 11px `var(--agent-muted)`；行间 hairline-soft；版本与时间用 tabular-nums。
- **状态区**：账户/技能/改动/Profile 全部收成 `agent-chip` 流式行（wrap，gap 4px）；Profile 名单直接渲染为 `is-quiet` chip 列表（不再 flag 框 + 裸文本两遍）。
- **路径 footer**：`margin-top:auto; padding:8px 12px; border-top:hairline;` 9px mono `var(--agent-weak)`，虚线框去除（降到纯文本级）。rail-body 改 flex column 以支持 footer pinned。

### 4.4 左列列表

- 搜索行保持结构，样式：margin `7px 9px 6px`、1px `--agent-line` 边、radius 6、focus-within 时 accent 62% 边 + 12% 外环（lab 搜索框同款）。
- 组标题：`padding:10px 12px 4px`；图标 12px（按组微分色，P2-10）+ 名称 10px/700 uppercase tracked + 计数 chip 紧跟（gap 6px，不再 margin-left:auto 漂右端）+ 内置组追加 `只读` nano 标注。
- 行（`.agent-lib__row`）：去 `border-left`，改 lab 范式——
  - `padding:8px 12px; border-bottom:1px solid var(--agent-line-soft);`
  - hover：`background:var(--agent-hover)`；active：`box-shadow:inset 2px 0 0 var(--accent); background:var(--agent-selected);`
  - 行 1：`名称 12px/600 ellipsis` + `角色 9px mono var(--agent-weak)`（baseline 对齐，gap 7px）。
  - 行 2：scope 纯文本 9px `var(--agent-weak)`（不再带框）+ 最多 2 枚语义 chip（P0-2 规则）+ 被勾选计数 chip `is-quiet`。
  - 行 gap 3px；相邻行高差 ≤2px（徽章缺失行用 `min-height` 补齐）。
- 空态/无结果/错误：统一 §2-P2-11 的 state 范式；`data-agent-library-empty` 结构不动。

### 4.5 三个对话框（共用 `.modal-shell.agent-lib-dialog`）

- 尺寸：手动创建/AI 创建保持 `min(1080px, 100vw-64px) × min(720px, 100vh-64px)`；radius 10px。
- 头部 52px：标题 13px + 副标题 10px `var(--agent-weak)`，关闭按钮 28×28。
- 表单栏规范（两对话框共用）：
  - label：9px uppercase tracked `var(--agent-weak)`，与控件 gap 5px。
  - input/select：高 30px、padding `0 8px`、radius 6、`background:#090c11`、1px `--agent-line`；focus accent 边 + 12% 外环。
  - textarea：min-height 88px（职责）/ 120px（AI 描述），`resize:vertical`。
  - scopes 改 chip-checkbox：每枚 `agent-chip` 样式，勾选时 `is-accent`；原生 checkbox 视觉隐藏但保留 a11y（`position:absolute; opacity:0` + label 承载）。
  - 字段间距 10px；note/error/warnings 统一为 §2-P2-11 banner 范式（error=danger 色、warnings=warn 色、note=weak）。
- 预览栏：头部换与编辑器同款分段控件；空态居中 `Sparkles 图标 + 引导两行 + 虚线框`；生成后源码 textarea 复用 `.agent-lib__source`（含深井样式）。
- 底部 actions 行：高 52px、右对齐、gap 8px；分级 = 取消（quiet 描边）/ 生成草稿（accent-tint）/ 保存（confirm 实心）。`data-agent-ai-description` / `data-agent-ai-generate` 不动。
- 删除确认：复用 `ConfirmPrompt`，确认其 danger 按钮与本规格 `--agent-danger` 一致；不一致则在 ConfirmPrompt 全局样式层对齐（不动组件 API）。
- ≤1180px 媒体查询现状（单栏堆叠）保留，补充：单栏时预览栏 max-height 40%。

### 4.6 Profile 勾选器（`.agent-picker`，嵌入 Profile 编辑器）

- 容器：沿用 `.automation-form-section`，内部 gap 10px。
- **头部行 1**：`Users 图标 + 参与 Agent` 12px/650 + hint 10px（左）| 计数 chip `已勾选 4/7`（右，accent-quiet 样式，aria-live 保留）。
- **协作总开关行**：整行是可点 label，hairline 上下各一条（去卡片边框）：
  - 左：`协作编排` 11px/600 + hint 10px 两行（grid gap 2px，**永不连排**，P0-1③）。
  - 右：开关——原生 `<input type=checkbox data-agent-collaboration-toggle>` 视觉隐藏（保留焦点环到 track 上），`.agent-picker__toggle-track` 实现为 30×17 pill：`border:1px solid var(--agent-line); background:#0d1118; transition:120ms`；knob 13px 圆 `var(--agent-muted)`；`:checked` 时 track `background:color-mix(accent 30%); border-color:color-mix(accent 55%)`、knob 右移 13px 且变白；`:focus-visible` track 加 2px accent outline。
  - 关闭时列表区整体 `opacity:.55; pointer-events:none`（除开关行），并显示 `data-agent-collaboration-off-hint`（warn 色虚线 banner）。**钩子与"不清空名单"逻辑不动。**
- **动作行 2**：左 `全选内置 / 清空`（quiet 描边 24px 高）；右 `管理 Agent 库`（accent 描边文字钮）+ 刷新 24×24 icon-button；单行基线（P2-9）。
- **列表**：去卡片化（P2-8）；行结构 = `checkbox 14px | 名称+职责（2 行，职责 1 行 ellipsis 10px weak）| chip 区（P0-2 规则）`；`align-items:center`；行高 ≤52px。
- 空态 / 未勾选 hint / 加载 / 错误：全部走统一 state 范式；`data-agent-selector-empty` 两处（无 Agent / 未勾选）保持各自语义文案。
- **与 Profile 卡片摘要的关系**：勾选结果在 Profile 卡片摘要行（"自定义团队 · 三路取证…"）不重复渲染名单；勾选器头部的 `已勾选 n/total` 是唯一计数出口，卡片摘要仅在有勾选时追加 `· n 位专家` 短文本（若摘要行已有此信息则保持现状，本项为一致性确认而非新增）。

### 4.7 响应式档位（容器查询挂在 tab 根节点，现状保留并细化）

| 档位 | 取舍 |
| --- | --- |
| **>1040px** | 三栏全量（§4.1）。 |
| **≤1040px** | 右栏收成底部工具条：操作区 `repeat(auto-fit, minmax(132px,1fr))` 横排（现状保留），rail 头部隐藏，facts/状态/路径改 `repeat(auto-fit, minmax(210px,1fr))` 横排卡片流，`max-height:42%`；拖拽条隐藏（现状保留）。编辑器头部允许徽章带换行。 |
| **≤760px** | 单列：列表横向滚动行卡（185px 固定宽，现状保留），active 条改 `inset 0 -2px 0 0`→底部 2px（现状保留，改用 box-shadow 实现）；编辑器占满剩余高度且源码框断言仍须成立；rail 底部 `max-height:44%`。 |
| **≤580px** | chip 只留图标 + title tooltip；隐藏 `is-quiet` 计数；编辑器头部强制两行（标题行 / 控件行）；对话框预览栏隐藏（现状 `.agent-dialog` 选择器有笔误——实际类名是 `.agent-lib-dialog`，修正此失效规则）。 |

---

## 5. 改动清单（文件 → 选择器/组件 → 改什么）

### 5.1 `src/ui/agent-library/AgentLibrary.css`（重写量最大）

1. 顶部新增 §3 令牌块（`.agent-lib, .agent-picker, .agent-lib-dialog` 作用域）+ `.agent-chip` 范式。
2. `.agent-lib`：grid 默认值收窄（rail 默认 240–288）；三列背景统一 `--agent-bg`；删 `.agent-lib > section.agent-lib__editor` 与 `> aside.agent-lib__rail` 上的 `#090a0d`/`#08090c` 硬编码。
3. 新增 `.agent-lib__pane-head`（40px 规范），`.agent-lib__list-head` 改为其实例；搜索框按 §4.4 重写。
4. `.agent-lib__group-title`：计数 chip 化、内置组只读标注位。
5. `.agent-lib__row`：去 border-left → hairline + inset 条范式（§4.4）；`__row-title`/`__row-meta` 按两级行重写；`__row-meta em` 全部替换为 `.agent-chip`。
6. `.agent-lib__editor-head`：44px、单行、徽章带 inline、竖分隔、保存按钮 accent-tint（`.agent-lib__save` 重写，禁用态降对比非整钮透明）。
7. `.agent-lib__source`：外包 wrap + 深井 inset 样式（§4.2，保高度断言）。
8. `.agent-lib__rail-*`：操作区 2 列网格（`is-primary` 跨列）、facts 收敛 4 行、flag 区 chip 化、profiles chip 化、路径 footer pinned（rail-body 改 flex）。
9. `.agent-picker__*`：头部两行基线、toggle track/knob 全套（§4.6）、行去卡片化、tags 区限量策略、空态统一。
10. `.agent-lib-dialog__*`：表单控件规范（30px 输入、nano 大写 label）、scopes chip-checkbox、预览分段控件、actions 分级。
11. 容器查询三档按 §4.7 修订（含 `.agent-dialog`→`.agent-lib-dialog` 笔误修正）。
12. 全文替换硬编码紫灰（`#b9a3ff` `#9380bd` `#81778e` `#34303d` `#2b2a33` `#24232b`）为令牌派生（P2-13）。

### 5.2 `src/ui/agent-library/AgentLibraryView.tsx`（结构性微调，钩子不动）

1. 列表头：`agentsIntro` 从 head 移出（仅空态/无结果态使用）；head 改 pane-head 结构 + 计数 chip。`data-agent-library-item`、`data-agents-tab` 等钩子全部原位。
2. 编辑器头：徽章带从独立行改为与名称同基线的 inline 容器；保存按钮前加竖分隔 span。
3. rail：顶部加 pane-head（"操作"）；actions 区加跨列 class；facts 删减为 4 行（角色/范围/版本/更新时间）；Profile 名单改 chip 渲染；路径移入 footer 容器。
4. 行徽标渲染加"优先级限量 + `+n`"逻辑（纯渲染层，可提取 8 行小函数 `visibleRowChips(agent)`）。
5. AI 创建/手动创建对话框：预览头换分段控件组件结构（与编辑器头同款 class），scopes 改 chip-checkbox label 结构（保留原生 input）。

### 5.3 `src/ui/agent-library/ProfileAgentSelector.tsx`

1. 计数文本改 chip 容器（`aria-live` 保留）。
2. 行 tags 区加优先级限量 + `+n`（与 5.2-4 共用函数）。
3. 组标题计数 chip 化。
4. toggle 行 JSX 不变（track span 已存在），仅 CSS 补齐；确认 `data-agent-collaboration-toggle` / `-off-hint` 原位。

### 5.4 其他

- `src/i18n/resources.ts`：**不改键值**，仅作为排查对象——确认 AutomationPreview 环境下 `profileCollaborationToggle*` 回退原因（P0-1②）。
- `src/styles.css`：不动（令牌全部局部化）。
- `scripts/`、`src-tauri/`、`package.json`：不动。
- 已知笔误顺带修：`.agent-dialog .agent-lib__preview`（CSS 选择器永不命中）。

---

## 6. 验收清单（实现轮逐条自检）

**钩子与功能（smoke 断言）**
- [ ] 16 个钩子全部仍在 DOM：`data-agents-tab` / `data-agent-library-item` / `data-agent-editor` / `data-agent-save` / `data-agent-duplicate` / `data-agent-delete` / `data-agent-create-manual` / `data-agent-create-ai` / `data-agent-ai-description` / `data-agent-ai-generate` / `data-agent-selector` / `data-agent-selector-item` / `data-agent-selector-empty` / `data-agent-select-all` / `data-agent-select-clear` / `data-agent-collaboration-toggle`（另保留既有 `data-agent-library-empty`、`data-agent-collaboration-off-hint`）。
- [ ] 源码框高度 ≥240px 且 ≥ 编辑器面板 55%（两个尺寸都测）。
- [ ] 自定义 Agent 可输入、输入后保存按钮可用；内置 Agent 只读且保存禁用。
- [ ] 协作开关关闭时列表禁用且勾选名单不清空（C14）。
- [ ] 删除确认、未保存切换确认、重复创建、搜索过滤、列宽拖拽/双击复位/键盘调整全部回归。

**命令**
- [ ] `npm run build` 绿。
- [ ] `npm run test:i18n` 绿（重点：协作开关两键在 zh/en 均不渲染原始 key）。
- [ ] `npm run smoke:automation-preview` 绿（含此前失败的"关闭 AI 创建对话框"步骤；若仍超时须定位原因，不得跳过）。

**视觉复查（逐张看新截图）**
- [ ] `artifacts/automation-preview/` 两个尺寸的 6+ 张 agents 相关截图全部重看：三栏顶线对齐、列表行两级结构、徽章无截断、rail 无按钮墙、勾选器开关为 pill 样式、AI 对话框表单与预览平衡。
- [ ] 手动补测：1040/760/580 三档容器查询实际生效（devtools 拉宽或改预览容器宽），各档取舍与 §4.7 一致。
- [ ] 真实 Tauri 窗口（非预览页）确认 `.agent-lib` 铺满高度、无底部异常留白（P2-12）。
- [ ] 与 SystematicStrategyLab 并排截图对比：pane-head、行范式、chip、按钮分级肉眼同族。

---

## 7. 本轮结论速览

- 问题清单共 **13 条**（P0×3 / P1×6 / P2×4，编号 P0-1…P2-13）。
- 最提升观感的 3 个改动：**P0-3+§4.1 三栏统一 40px pane-head**（一次解决"排版歪"的主观感）；**P0-2+P1-3 徽标优先级限量 + lab 式行范式**（列表与勾选器同时降噪）；**P1-4 编辑器头部单行化 + 保存按钮 accent-tint 分级**（建立全面板唯一明确的动作层级）。
