//! 快判模式（契约 C29 / 设计文档 `docs/agent-fastlane-design.md`）。
//!
//! 三轮链路：**代码取数 → Jev 秒级判定 → LLM 写参数与下一轮观察条件 → 代码校验执行**。
//! 本模块只放**纯逻辑**（配置归一、state 组装、代码门/代码校验、预算闸门、运行记录形状），
//! 所有 IO（实时快照读取、Jev HTTP、窄调用 LLM、创建机会）都在 `ai_automation` 的 runner 里，
//! 这样"校验必须先于任何执行"可以在类型层面被钉住（见 [`ValidatedRound`]）。
//!
//! **无旁路（C29.2/C29.6）**：降险动作与开仓走同一条链路。执行侧（`ValidatedRound`）
//! 只能由 [`validate_round`] 构造，因此不存在"跳过校验直接执行"的代码路径。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};

/// 运行摘要里的记录种类（`recordKind`）。
pub const FASTLANE_RECORD_KIND: &str = "fastlane";

// ===== C29.19：快判模式**产品面总开关**（本版本未开放）=====

/// 快判模式总开关 —— **本版本未开放**（产品决定：本版只发布改版后的原有 AI Profile 模式）。
///
/// **下个版本开放只需把本常量改成 `true`**（UI 侧同值开关见 `src/ui/fastlane/fastlaneMode.ts`）；
/// 快判的代码本体（本文件 / `scripts/cline-fastlane.mjs` / `src/ui/fastlane/*`）一行未删。
///
/// 值为 `false` 时的**全部**后果（所有"是否启用快判"的判断都读这一个常量，
/// 见 `ai_automation::fastlane_mode_enabled`）：
///   ① 分派：`run_uses_fastlane_runner()` 恒 `false`；快判轮次既不派给快判 runner，
///      也**不**误派给 AI Profile runner —— 入队前拦下（`queue_run`）+ 认领时拦下
///      （`claim_next_run`）+ runner 入口再拦一道（`execute_fastlane_round`），原因明确留痕；
///   ② 采集器：`fastlane_collector_plan` 返回空 ⇒ 不起节拍任务、不订阅行情；
///      已存在的条目在 `sync_fastlane_collectors` 里按既有释放路径摘掉；
///   ③ 触发：定时轮（`schedule`）/ 观察条件轮（`wake_condition`）/ 停机平仓轮（`fastlane_close`）
///      一律不再入队；残留的排队/运行中快判轮被取消并写明原因；
///   ④ 侧车：`scripts/cline-fastlane.mjs` 保持原样，但 runner 不可达 ⇒ **不会被调用**。
///
/// **不含**：任何 AI Profile（C20–C28 协作编排）行为；多 Agent / 专家 / 试判 / 极简模式；
/// 用户库里的 Profile 配置（开关关闭时**一行都不改**）。
pub const FASTLANE_MODE_ENABLED: bool = false;

/// 开关关闭时给调用方 / 日志 / 运行记录看的**明确原因**（要求"不静默"）。
///
/// 落点：`queue_run` 的 `Err`、被拦轮次的 `ai_agent_runs.error`、`ai_fastlane_kill_switch`
/// 的返回值、以及 `boot_log`。
pub const FASTLANE_MODE_DISABLED_REASON: &str =
    "快判模式本版本未开放（FASTLANE_MODE_ENABLED=false）：该 Profile 不会运行、不会起采集器；下一个版本开放后可继续使用。";

// ===== 默认值与区间（C29.4 / C29.7）=====

pub const FASTLANE_DEFAULT_STYLE_PRESET: &str = "long_pullback";
pub const FASTLANE_DEFAULT_RISK_PER_TRADE_PCT: f64 = 0.5;
pub const FASTLANE_DEFAULT_MAX_DAILY_LOSS_PCT: f64 = 2.0;
pub const FASTLANE_DEFAULT_MAX_CONCURRENT: u32 = 1;
pub const FASTLANE_DEFAULT_MAX_SLIPPAGE_BPS: u32 = 5;
pub const FASTLANE_DEFAULT_MAX_ACTIONS_PER_MINUTE: u32 = 1;
/// **入场质量门（几何 R:R 底线）默认值 1.2** —— 名字 / clamp 区间 / 三处同源纪律沿用，
/// **语义在 C29.18（2026-09-21）变了**：从「读 Jev `quality` 分」改成「**纯代码判据的几何 R:R 底线**」。
///
/// 依据 `artifacts/fastlane-quality-rephrase/report-20260921-081256.md`（§0/§1/§2/§6）：
///   - **门槛 1.2 落在 `quality` 自己的支撑集 [1.31, 2.19] 之外 ⇒ 这道门等于没拦**（门槛 1.2 下
///     放行 116/116 = 100%，TPR 100% / FPR 100%）；最好的分辨点 1.6 也只有 TPR 46.3% / FPR 12.2%；
///   - 三种换问法（具体动作锚点 / 拆两问 / 0–2 档+赔率优先）**判别力全部低于现状**
///     （AUC 0.466 / 0.5612 / 0.5065 vs 现状 0.6806；ΔAUC 配对 bootstrap 的 2.5% 分位全部 < 0）
///     ⇒ **换问法没用，这道门不该再问模型**（报告 §6 建议①②③④ = 本条的改动清单）。
///
/// 语义（**唯一实现 = 侧车 `scripts/cline-fastlane.mjs::fastlaneEntryQuality`**；Rust **只持常量 /
/// 夹取 / 下发与记录形状**，不实现第二份判定）：
///   `几何 R:R = |目标位 − entry| / |entry − 止损| ≥ 本值`，三条代码判据各带独立原因码
///   （`structure_unclear` / `stop_not_placeable` / `rr_below_floor`，见 [`FASTLANE_WATCH_REASONS`]）。
///   目标位 = 「**能付得起这份风险的最近合理结构位**」，与 C29.15 修正后的「第一目标」**同一取数**
///   （`hardConstraints` 的候选 = `tf_15m/1h/4h` 的 `window_*/last_swing_*`，只换门槛参数）。
///
/// **默认 1.2（宽起步，用户拍板）**：1.2 / 1.6 两档对照见 `artifacts/fastlane-code-quality-gate/`
/// （1.6 = C29.16 实测的现状最佳分辨点）。值仍 clamp 到
/// [`FASTLANE_QUALITY_FLOOR_MIN`]–[`FASTLANE_QUALITY_FLOOR_MAX`]（0.5–3.0）。
///
/// 同源三处：本常量 / 侧车 `FASTLANE_DEFAULTS.qualityFloor` / UI `FASTLANE_DEFAULTS.qualityFloor`。
/// **不是放宽风控**：本门只作用于**开仓**；降险（C29.10/C29.14）连方向都没有 → 本门对它**不适用**；
/// `validate_round` / 事件黑名单 / 盈亏比 / 单笔风险 / 滑点全部照旧。
/// `jev.quality` 降级为**观察量**：记录里保留（缺失即字段不出现，UI 显示 `--`），**绝不再**作为
/// 不动手 / abort 的理由。
pub const FASTLANE_DEFAULT_QUALITY_FLOOR: f64 = 1.2;
/// 入场质量门（几何 R:R 底线）的可配区间 —— **与侧车 `FASTLANE_QUALITY_FLOOR_MIN/MAX` 和 UI
/// `normalizeFastlaneConfig` 三处同源**（有源码级防漂移断言）。
///   下界 0.5：几何 R:R < 0.5 的单子在本仓纪律里本来就不成立（`validate_round` 的盈亏比门槛是 1.5），
///   再往下降只是把这道门关掉 —— 要关就显式取 0.5；
///   上界 3.0：本批实测的几何 R:R 上界远低于 3.0 → 3.0 之上结构性打不中（旧 2.5 的教训：
///   门槛落在观测支撑集之外 = 这道门只会观望）。
pub const FASTLANE_QUALITY_FLOOR_MIN: f64 = 0.5;
pub const FASTLANE_QUALITY_FLOOR_MAX: f64 = 3.0;
pub const FASTLANE_DEFAULT_CONFIDENCE_FLOOR: f64 = 0.6;
/// **入场分门槛**默认值 **1.5**（2026-09-21 用户裁决：Jev 问题面改双打分 + 代码侧阈值）。
///
/// 依据：`artifacts/fastlane-jev-rephrase-probe/report-20260921-070600.md`（真实调用 Jev 408 次）——
/// 把「该做什么？」（choice，含观望）换成两个 `score`（`long_score` / `short_score`：**现在做多 /
/// 做空这一个具体动作**有多该做）之后，同一份 byte 级相同的 state 上「给方向率」从 **0.0%** 变成
/// 阈值 1.0 时 **80.5%**（方向准确率 95.5%）、阈值 1.5 时 16.0%（准确率 100%）；阈值 2/2.5/3
/// 结构性打不中（0%）—— 因为 `score` 是 **0–4 分布上的期望值**（实测集中 0.2–1.9），不是档位。
///
/// 语义：`max(long_score, short_score) ≥ 本值` 且两分**不并列** → 方向 = argmax；否则观望。
/// 判定在**侧车**（`scripts/cline-fastlane.mjs::decideEntryFromScores`，唯一实现）；
/// Rust 侧只持常量 / 夹取 / 下发与记录形状，**不实现第二份判定**（避免两处漂移）。
///
/// 同源三处：本常量 / 侧车 `FASTLANE_DEFAULTS.entryScoreFloor` /
/// UI `src/ui/fastlane/fastlaneDefaults.ts::FASTLANE_DEFAULTS.entryScoreFloor`（防漂移断言钉死）。
/// `normalized()` 里 clamp 到 **0.5–3.0**（低于 0.5 等于对任何打分都放行；高于 3.0 结构性打不中）。
pub const FASTLANE_DEFAULT_ENTRY_SCORE_FLOOR: f64 = 1.5;
/// **降险分门槛**默认值 **1.5**（C29.17，2026-09-21）—— 与入场分门槛**解耦**后的独立旋钮。
///
/// 背景：C29.14 让降险臂**复用** `FASTLANE_DEFAULT_ENTRY_SCORE_FLOOR`，记录里
/// `reduceScoreFloor` 与 `entryScoreFloor` 恒同值（22/22 核对过）—— 那时"想把降险放宽一点"
/// 只能连带放宽开仓，而两类动作的取向本来就不同：**开仓要挑**（宁缺毋滥，代价是错过）、
/// **降险要快**（宁可多减一点，代价是少赚）—— 一条线同时服务两种取向是妥协，不是裁决。
///
/// ⚠️ **默认值仍是 1.5，行为与解耦前逐字一致**（同一个门槛值，只是现在能分别调）：
/// 这不是"放宽风控"，而是**把旋钮交出来**。
///
/// 语义与开仓门槛**同规则**：`reduce_score ≥ 本值` → 判降险（优先于开仓，且只作用于**既有持仓**；
/// `positionFact != "held"` 时一律观望，不凭空产生动作）。判定在**侧车**
/// （`scripts/cline-fastlane.mjs::decideEntryFromScores`，唯一实现）；Rust 侧只持常量 /
/// 夹取 / 下发与记录形状，**不实现第二份判定**。
///
/// 同源三处：本常量 / 侧车 `FASTLANE_DEFAULTS.reduceScoreFloor` /
/// UI `src/ui/fastlane/fastlaneDefaults.ts::FASTLANE_DEFAULTS.reduceScoreFloor`（防漂移断言钉死）。
/// `normalized()` 里 clamp 到 **0.5–3.0**（与入场门槛同规则：低于 0.5 等于对任何打分都放行；
/// 高于 3.0 结构性打不中）。
pub const FASTLANE_DEFAULT_REDUCE_SCORE_FLOOR: f64 = 1.5;
pub const FASTLANE_DEFAULT_EVENT_BLACKOUT_MINUTES: u32 = 30;
pub const FASTLANE_DEFAULT_NOTIFY_POLICY: &str = "on_open_close";
pub const FASTLANE_DEFAULT_JEV_MODEL: &str = "jev-latest";
pub const FASTLANE_DEFAULT_JEV_TIMEOUT_MS: u32 = 1_500;
pub const FASTLANE_DEFAULT_LLM_TIMEOUT_MS: u32 = 3_000;
/// C29.3：**参数调用必须关思考**（实测：开思考 8.1s 且输出为空）。
pub const FASTLANE_DEFAULT_LLM_REASONING_EFFORT: &str = "none";

/// C29.4：快判 Profile 创建时的触发默认值（现有 AI Profile 默认是 30 分钟 / 60 秒 / 12 次）。
pub const FASTLANE_DEFAULT_MAX_SILENCE_MINUTES: u32 = 10;
pub const FASTLANE_DEFAULT_MIN_WAKE_INTERVAL_SECONDS: u32 = 10;
pub const FASTLANE_DEFAULT_MAX_RUNS_PER_HOUR: u32 = 120;
/// C29.4：默认执行模式＝副驾驶。
pub const FASTLANE_DEFAULT_PERMISSION_MODE: &str = "copilot";

pub const FASTLANE_STYLE_PRESETS: [&str; 3] = ["long_pullback", "range_both", "breakout_follow"];
pub const FASTLANE_NOTIFY_POLICIES: [&str; 3] = ["every_action", "on_open_close", "none"];
pub const FASTLANE_DEFAULT_TRADING_HOURS: &str = "24h";
/// C29.7（审计回填）：Jev（TypeSafe）默认端点（侧车有同一默认值；显式下发便于私有部署）。
pub const FASTLANE_DEFAULT_JEV_BASE_URL: &str = "https://api.typesafe.ai";
pub const FASTLANE_TRADING_HOURS: [&str; 3] = ["24h", "day", "night"];
pub const FASTLANE_LLM_REASONING_EFFORTS: [&str; 4] = ["none", "minimal", "low", "medium"];

/// 顾问模式（`advisor`）在快判轮里**不可能产生动作**：既有授权层不允许 advisor
/// 创建/修改交易机会（`lib.rs::authorize_ai_tool`）。runner 遇到 advisor 的快判 Profile
/// 必须**显式早退**（不调侧车 → 零 Jev / 零 LLM 花费），并把原因写清：
/// 不是"参数没通过校验"，而是"这个执行模式不支持动作"。
pub const FASTLANE_ADVISOR_UNSUPPORTED_REASON: &str =
    "顾问模式不创建交易机会，请改用副驾驶或自动执行（受限）";

/// 观望原因枚举（C29 设计 §10）——记录与 UI 都用这一套。
///
/// **2026-09-21 变更 B 新增两个码**（打分臂的**代码判定**，不是模型自述）：
///   - `low_entry_score`：`max(long_score, short_score) < entryScoreFloor` → 分数不足 → 观望；
///   - `entry_score_tie`：两个分数并列 → 保守观望（分数可能够，但方向不唯一）。
///
/// **2026-09-21 C29.14 再加两个码**（降险臂的**代码判定**：该降险，但没有可减的仓位）：
///   - `reduce_without_position`：`reduce_score ≥ 门槛` 但本品种**当前无持仓** → 没有风险可降 → 观望；
///   - `reduce_position_unknown`：`reduce_score ≥ 门槛` 但**持仓事实缺失**（读不到 positions）
///     → 无法确认可减仓位 → 观望（不猜）。
///   两个码必须分开：前者是**正常状态**（没仓位当然没得减），后者是**数据异常**，文案分层。
///
/// 侧车 `JEV_ENTRY_SCORE_WATCH_REASONS` / `JEV_REDUCE_SCORE_WATCH_REASONS` /
/// `FASTLANE_ENTRY_QUALITY_WATCH_REASONS` 与 UI `FASTLANE_WATCH_REASONS` 必须同码
/// （UI 按码渲染文案）。`low_quality` **保留**（老记录 / 老侧车仍会出现），但 C29.18 起
/// **代码侧不再产生它**（那道门不再读 `jev.quality`）。
pub const FASTLANE_WATCH_REASONS: [&str; 16] = [
    "data",
    "anomaly",
    "conflict",
    "low_confidence",
    "low_quality",
    "no_setup",
    "validation_failed",
    "budget_exhausted",
    // C29.7（审计回填）：不在配置的交易时段内 → 当轮不判定。
    "session_closed",
    // 变更 B（2026-09-21）：打分臂的两个代码判定观望码。
    "low_entry_score",
    "entry_score_tie",
    // C29.14（2026-09-21）：降险臂的两个代码判定观望码（该降险但没有可减的仓位）。
    "reduce_without_position",
    "reduce_position_unknown",
    // **C29.18（2026-09-21）：入场质量门（纯代码判据）的三个观望码** —— 三条各自独立，
    // 记录里必须能分清是哪一条不过（侧车 `FASTLANE_ENTRY_QUALITY_WATCH_REASONS` 同码）：
    //   - `structure_unclear`：结构位缺失 / 只有单侧 / 离现价 > 3×ATR14_1h（或 ATR 缺失）；
    //   - `stop_not_placeable`：纪律止损放不下 —— 过近（< 0.25×ATR14_1h，会被扫）或过远
    //     （结构锚 > 1.5×ATR14_1h ⇒ 止损退化成纯 ATR 距离）；
    //   - `rr_below_floor`：几何 R:R < `FASTLANE_DEFAULT_QUALITY_FLOOR`（没有能付得起这份风险的
    //     最近合理结构位）。
    "structure_unclear",
    "stop_not_placeable",
    "rr_below_floor",
];

/// 交易时段是否允许判定 —— **执行点**（`trading_hours` 不能只解析不生效）。
/// `24h` 恒放行；`day` = 08:00–19:59；`night` = 20:00–07:59（跨零点）。
pub fn trading_session_allows(trading_hours: &str, local_hour: u32) -> bool {
    let hour = local_hour % 24;
    match trading_hours.trim().to_ascii_lowercase().as_str() {
        "day" => (8..20).contains(&hour),
        "night" => !(8..20).contains(&hour),
        _ => true,
    }
}

/// 不在时段内 → `Some("session_closed")`（runner 据此当轮不判定、记为观望）。
pub fn session_watch_reason(trading_hours: &str, local_hour: u32) -> Option<&'static str> {
    if trading_session_allows(trading_hours, local_hour) {
        None
    } else {
        Some("session_closed")
    }
}

/// C29.7 的 15 个快判字段（`profileType="fastlane"` 时读写；`ai` 类型忽略、不报错）。
/// 质量门默认 **1.5**（2026-09-21 用户裁决；旧值 2.5）：依据真机 + 回放实测，`jev-1.13.0` 的
/// `quality`（0 很差 / 1 偏弱 / 2 一般 / 3 好 / 4 很好）在真实 state 上落在 **1.5–1.9**，
/// 2.5 会让**每一轮**都判 `low_quality` → 永不进动作分支（质量门退化成"只会观望"）。
/// 裁决口径：宁可让中等质量的机会进入动作分支（后面还有 `validate_round` 代码校验、预检、审批），
/// 也不要质量门把模式卡成只会观望。**只改缺省值**：已有 Profile 落盘的 `fastlaneQualityFloor`
/// 不会被自动改写。侧车 `scripts/cline-fastlane.mjs` 的 `FASTLANE_DEFAULTS.qualityFloor` 与
/// UI `src/ui/fastlane/fastlaneDefaults.ts` 必须与这里同值（有防漂移断言钉死）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FastlaneConfig {
    #[serde(default = "default_fastlane_style_preset")]
    #[serde(rename = "fastlaneStylePreset")]
    pub style_preset: String,
    /// 自然语言风格：缺字段时由预设生成（见 [`style_text_for_preset`]）。
    #[serde(default = "default_fastlane_style")]
    #[serde(rename = "fastlaneStyle")]
    pub style: String,
    #[serde(default = "default_fastlane_risk_per_trade_pct")]
    #[serde(rename = "fastlaneRiskPerTradePct")]
    pub risk_per_trade_pct: f64,
    #[serde(default = "default_fastlane_max_daily_loss_pct")]
    #[serde(rename = "fastlaneMaxDailyLossPct")]
    pub max_daily_loss_pct: f64,
    #[serde(default = "default_fastlane_max_concurrent")]
    #[serde(rename = "fastlaneMaxConcurrent")]
    pub max_concurrent: u32,
    #[serde(default = "default_fastlane_max_slippage_bps")]
    #[serde(rename = "fastlaneMaxSlippageBps")]
    pub max_slippage_bps: u32,
    #[serde(default = "default_fastlane_max_actions_per_minute")]
    #[serde(rename = "fastlaneMaxActionsPerMinute")]
    pub max_actions_per_minute: u32,
    #[serde(default = "default_fastlane_quality_floor")]
    #[serde(rename = "fastlaneQualityFloor")]
    pub quality_floor: f64,
    /// C29 变更 B（2026-09-21）：**入场分门槛** —— 打分臂的方向判定线（`max(long, short) ≥ 本值`）。
    #[serde(default = "default_fastlane_entry_score_floor")]
    #[serde(rename = "fastlaneEntryScoreFloor")]
    pub entry_score_floor: f64,
    /// C29.17（2026-09-21）：**降险分门槛** —— 降险臂自己的判定线（`reduce_score ≥ 本值`）。
    ///
    /// 与 `entry_score_floor` 各自独立（默认同为 1.5 → 解耦前后行为一致）；`normalized()` 里
    /// **同规则** clamp 到 0.5–3.0。
    #[serde(default = "default_fastlane_reduce_score_floor")]
    #[serde(rename = "fastlaneReduceScoreFloor")]
    pub reduce_score_floor: f64,
    #[serde(default = "default_fastlane_confidence_floor")]
    #[serde(rename = "fastlaneConfidenceFloor")]
    pub confidence_floor: f64,
    #[serde(default = "default_fastlane_event_blackout_minutes")]
    #[serde(rename = "fastlaneEventBlackoutMinutes")]
    pub event_blackout_minutes: u32,
    #[serde(default = "default_fastlane_notify_policy")]
    #[serde(rename = "fastlaneNotifyPolicy")]
    pub notify_policy: String,
    #[serde(default = "default_fastlane_jev_model")]
    #[serde(rename = "fastlaneJevModel")]
    pub jev_model: String,
    #[serde(default = "default_fastlane_jev_timeout_ms")]
    #[serde(rename = "fastlaneJevTimeoutMs")]
    pub jev_timeout_ms: u32,
    #[serde(default = "default_fastlane_llm_timeout_ms")]
    #[serde(rename = "fastlaneLlmTimeoutMs")]
    pub llm_timeout_ms: u32,
    #[serde(default = "default_fastlane_llm_reasoning_effort")]
    #[serde(rename = "fastlaneLlmReasoningEffort")]
    pub llm_reasoning_effort: String,
    /// C29：交易时段（`24h` | `day` | `night`；设计 §9.2「时段与事件」分组）。
    #[serde(default = "default_fastlane_trading_hours")]
    #[serde(rename = "fastlaneTradingHours")]
    pub trading_hours: String,
    /// C29.7（审计回填）：Jev 端点（私有部署可改）。
    #[serde(
        rename = "fastlaneJevBaseUrl",
        default = "default_fastlane_jev_base_url"
    )]
    pub jev_base_url: String,
}

fn default_fastlane_style() -> String {
    style_text_for_preset(FASTLANE_DEFAULT_STYLE_PRESET)
}
fn default_fastlane_style_preset() -> String {
    FASTLANE_DEFAULT_STYLE_PRESET.to_string()
}
fn default_fastlane_risk_per_trade_pct() -> f64 {
    FASTLANE_DEFAULT_RISK_PER_TRADE_PCT
}
fn default_fastlane_max_daily_loss_pct() -> f64 {
    FASTLANE_DEFAULT_MAX_DAILY_LOSS_PCT
}
fn default_fastlane_max_concurrent() -> u32 {
    FASTLANE_DEFAULT_MAX_CONCURRENT
}
fn default_fastlane_max_slippage_bps() -> u32 {
    FASTLANE_DEFAULT_MAX_SLIPPAGE_BPS
}
fn default_fastlane_max_actions_per_minute() -> u32 {
    FASTLANE_DEFAULT_MAX_ACTIONS_PER_MINUTE
}
fn default_fastlane_quality_floor() -> f64 {
    FASTLANE_DEFAULT_QUALITY_FLOOR
}
fn default_fastlane_entry_score_floor() -> f64 {
    FASTLANE_DEFAULT_ENTRY_SCORE_FLOOR
}
fn default_fastlane_reduce_score_floor() -> f64 {
    FASTLANE_DEFAULT_REDUCE_SCORE_FLOOR
}
fn default_fastlane_confidence_floor() -> f64 {
    FASTLANE_DEFAULT_CONFIDENCE_FLOOR
}
fn default_fastlane_event_blackout_minutes() -> u32 {
    FASTLANE_DEFAULT_EVENT_BLACKOUT_MINUTES
}
fn default_fastlane_notify_policy() -> String {
    FASTLANE_DEFAULT_NOTIFY_POLICY.to_string()
}
fn default_fastlane_jev_model() -> String {
    FASTLANE_DEFAULT_JEV_MODEL.to_string()
}
fn default_fastlane_jev_timeout_ms() -> u32 {
    FASTLANE_DEFAULT_JEV_TIMEOUT_MS
}
fn default_fastlane_llm_timeout_ms() -> u32 {
    FASTLANE_DEFAULT_LLM_TIMEOUT_MS
}
fn default_fastlane_jev_base_url() -> String {
    FASTLANE_DEFAULT_JEV_BASE_URL.to_string()
}
fn default_fastlane_trading_hours() -> String {
    FASTLANE_DEFAULT_TRADING_HOURS.to_string()
}
fn default_fastlane_llm_reasoning_effort() -> String {
    FASTLANE_DEFAULT_LLM_REASONING_EFFORT.to_string()
}

/// C29.7：三个预设的风格正文（`custom` 时用用户自己写的 `style`）。
pub fn style_text_for_preset(preset: &str) -> String {
    match preset {
        "range_both" => "双边做区间：只在区间两端反向做，靠近区间中部一律观望；止损放在区间外，逆势单不做。".to_string(),
        "breakout_follow" => "只做突破跟随：等关键位被收盘确认后顺势进，不抢跑；突破失败（收回位内）立即止损，不逆势加仓。".to_string(),
        _ => "只做多回踩：只在上升结构里等回踩到位做多，不追高；止损放在最近结构位下方，宁可错过不做错。".to_string(),
    }
}

impl Default for FastlaneConfig {
    fn default() -> Self {
        Self {
            style_preset: default_fastlane_style_preset(),
            style: style_text_for_preset(FASTLANE_DEFAULT_STYLE_PRESET),
            risk_per_trade_pct: default_fastlane_risk_per_trade_pct(),
            max_daily_loss_pct: default_fastlane_max_daily_loss_pct(),
            max_concurrent: default_fastlane_max_concurrent(),
            max_slippage_bps: default_fastlane_max_slippage_bps(),
            max_actions_per_minute: default_fastlane_max_actions_per_minute(),
            quality_floor: default_fastlane_quality_floor(),
            entry_score_floor: default_fastlane_entry_score_floor(),
            reduce_score_floor: default_fastlane_reduce_score_floor(),
            confidence_floor: default_fastlane_confidence_floor(),
            event_blackout_minutes: default_fastlane_event_blackout_minutes(),
            notify_policy: default_fastlane_notify_policy(),
            jev_model: default_fastlane_jev_model(),
            jev_timeout_ms: default_fastlane_jev_timeout_ms(),
            llm_timeout_ms: default_fastlane_llm_timeout_ms(),
            llm_reasoning_effort: default_fastlane_llm_reasoning_effort(),
            trading_hours: default_fastlane_trading_hours(),
            jev_base_url: default_fastlane_jev_base_url(),
        }
    }
}

impl FastlaneConfig {
    /// 归一化 + 非法回落（**不报错**：快判是自动运行的模式，配置问题不能让它停摆）。
    pub fn normalized(mut self) -> Self {
        let preset = self.style_preset.trim().to_ascii_lowercase();
        self.style_preset = if FASTLANE_STYLE_PRESETS.contains(&preset.as_str()) {
            preset
        } else if preset == "custom" {
            "custom".to_string()
        } else {
            FASTLANE_DEFAULT_STYLE_PRESET.to_string()
        };
        self.style = self.style.trim().to_string();
        if self.style.is_empty() {
            // `custom` 但没有正文 → 回落到预设，保证参数 prompt 永远有风格可依。
            self.style = style_text_for_preset(&self.style_preset);
            if self.style_preset == "custom" {
                self.style_preset = FASTLANE_DEFAULT_STYLE_PRESET.to_string();
            }
        }
        self.risk_per_trade_pct = clamp_finite(
            self.risk_per_trade_pct,
            0.01,
            10.0,
            FASTLANE_DEFAULT_RISK_PER_TRADE_PCT,
        );
        self.max_daily_loss_pct = clamp_finite(
            self.max_daily_loss_pct,
            0.1,
            50.0,
            FASTLANE_DEFAULT_MAX_DAILY_LOSS_PCT,
        );
        self.max_concurrent = self.max_concurrent.clamp(1, 5);
        self.max_slippage_bps = self.max_slippage_bps.clamp(1, 100);
        self.max_actions_per_minute = self.max_actions_per_minute.clamp(1, 60);
        // C29.18（2026-09-21）：入场质量门语义改为「几何 R:R 底线」→ 夹取区间也随之改成 **0.5–3.0**
        // （与入场分门槛 / 降险门槛同规则：低于 0.5 等于对任何几何都不拦，高于 3.0 结构性打不中）。
        self.quality_floor = clamp_finite(
            self.quality_floor,
            FASTLANE_QUALITY_FLOOR_MIN,
            FASTLANE_QUALITY_FLOOR_MAX,
            FASTLANE_DEFAULT_QUALITY_FLOOR,
        );
        // 变更 B（2026-09-21）：入场分门槛夹到 **0.5–3.0** —— 低于 0.5 等于对任何打分都放行
        // （实测分值群中位数 ~0.9），高于 3.0 结构性打不中（实测 0% 给方向率）。
        self.entry_score_floor = clamp_finite(
            self.entry_score_floor,
            0.5,
            3.0,
            FASTLANE_DEFAULT_ENTRY_SCORE_FLOOR,
        );
        // C29.17（2026-09-21）：降险分门槛与入场分门槛**同规则**夹到 0.5–3.0
        // （两者都在同一个 0–4 期望分尺度上，边界理由逐字相同）。
        self.reduce_score_floor = clamp_finite(
            self.reduce_score_floor,
            0.5,
            3.0,
            FASTLANE_DEFAULT_REDUCE_SCORE_FLOOR,
        );
        self.confidence_floor = clamp_finite(
            self.confidence_floor,
            0.0,
            1.0,
            FASTLANE_DEFAULT_CONFIDENCE_FLOOR,
        );
        self.event_blackout_minutes = self.event_blackout_minutes.min(720);
        let policy = self.notify_policy.trim().to_ascii_lowercase();
        self.notify_policy = if FASTLANE_NOTIFY_POLICIES.contains(&policy.as_str()) {
            policy
        } else {
            FASTLANE_DEFAULT_NOTIFY_POLICY.to_string()
        };
        self.jev_model = non_empty_or(self.jev_model, FASTLANE_DEFAULT_JEV_MODEL);
        self.jev_timeout_ms = self.jev_timeout_ms.clamp(200, 10_000);
        self.llm_timeout_ms = self.llm_timeout_ms.clamp(500, 30_000);
        // C29.3 / 侧车硬要求：参数调用**必须关思考**，侧车把 `reasoning_effort:"none"` 写死。
        // 因此这里也固定为 `none`：入参给什么都不报错、但一律忽略（与保证金率口径同一处理），
        // 避免"配置写 high、实际 none"的漂移，也不在 UI 暴露成可改。
        self.llm_reasoning_effort = FASTLANE_DEFAULT_LLM_REASONING_EFFORT.to_string();
        // C29：交易时段非法 → `24h`（不报错；UI 的 `fastlaneTradingHours` 直接落这里）。
        let hours = self.trading_hours.trim().to_ascii_lowercase();
        self.trading_hours = if FASTLANE_TRADING_HOURS.contains(&hours.as_str()) {
            hours
        } else {
            FASTLANE_DEFAULT_TRADING_HOURS.to_string()
        };
        self.jev_base_url = self.jev_base_url.trim().to_string();
        if self.jev_base_url.is_empty() {
            self.jev_base_url = default_fastlane_jev_base_url();
        }
        self
    }
}

fn clamp_finite(value: f64, min: f64, max: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        fallback
    }
}

fn non_empty_or(value: String, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

// ===== §4 state（快判 state schema，字段名与设计文档逐字对齐）=====

/// 每个数据块的来源时间（毫秒），state 的 `data_age_ms` 由它推导。
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct DataAges {
    pub ticker: i64,
    pub orderbook: i64,
    pub candles_1m_closed: i64,
    pub derivatives: i64,
    pub account: i64,
}

impl DataAges {
    /// 距 `anchor_ms` 的年龄（负值夹到 0）。
    pub fn age_ms(self, anchor_ms: i64) -> DataAges {
        let age = |at: i64| {
            if at <= 0 {
                i64::MAX
            } else {
                (anchor_ms - at).max(0)
            }
        };
        DataAges {
            ticker: age(self.ticker),
            orderbook: age(self.orderbook),
            candles_1m_closed: age(self.candles_1m_closed),
            derivatives: age(self.derivatives),
            account: age(self.account),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct StateInstrument {
    pub tick_size: f64,
    pub lot_size: f64,
    pub min_size: f64,
    pub contract_value: String,
    pub max_leverage: u32,
    /// 合约面值（**基础币/张**，来自 OKX `ctVal`）：只用于代码校验的保证金/风险换算，
    /// **不进 state JSON**（给模型看的形态是 `contract_value` 字符串）。
    #[serde(skip)]
    pub ct_val: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StatePrice {
    pub last: f64,
    pub chg_5m_pct: f64,
    pub chg_1h_pct: f64,
    pub chg_24h_pct: f64,
    pub high_24h: f64,
    pub low_24h: f64,
    pub open_24h: f64,
}

/// **必须来自实时盘口**（C29 设计 §4 注：点差/失衡/深度不能用落盘表）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StateMicro {
    /// 盘口拿不到时这里是 `null`（**对象保留、字段为 null**，不整键消失：
    /// 稳定 schema 对侧车与 Jev 更友好 —— 模型看到"未知"而不是"0"）。
    pub spread_bps: Option<f64>,
    pub bid_ask_imbalance: Option<f64>,
    pub depth_5bps_usd: Option<f64>,
    pub taker_buy_ratio_5m: Option<f64>,
}

impl StateMicro {
    /// 实时盘口不可用时的形态：对象在、值全 `null`。
    pub fn unavailable() -> Self {
        Self {
            spread_bps: None,
            bid_ask_imbalance: None,
            depth_5bps_usd: None,
            taker_buy_ratio_5m: None,
        }
    }

    pub fn is_available(&self) -> bool {
        self.spread_bps.is_some()
            && self.bid_ask_imbalance.is_some()
            && self.depth_5bps_usd.is_some()
            && self.taker_buy_ratio_5m.is_some()
    }
}

/// 装配 `micro` 块：**实时盘口可用 → 真值；否则保留对象、字段全 null**。
/// 两条"不可用"表达必须一致：这里返回 `unavailable()`，`data_age_ms.orderbook` 同步为
/// `i64::MAX`（由 [`FastlaneSnapshotCache::source_times`] 在缺块时给出）。
pub fn micro_block(orderbook: Option<&Value>, taker_buy_ratio_5m: Option<f64>) -> StateMicro {
    orderbook
        .and_then(|book| micro_from_orderbook(book, taker_buy_ratio_5m))
        .unwrap_or_else(StateMicro::unavailable)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StateVolatility {
    /// 数据不足时是 `null`（**不是 0**：0 会被当成"波动为零"）。
    pub atr14_5m: Option<f64>,
    pub atr14_1h: Option<f64>,
    pub atr14_4h: Option<f64>,
    pub regime: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StateTimeframe {
    /// `up` | `down` | `range` | `unknown`（样本不足或均线不可得 → `unknown`）。
    pub trend: String,
    /// 该周期**不可用**时全部是 `null`（件数不足不给 0，装配侧据此判不可用）。
    pub window_high: Option<f64>,
    pub window_low: Option<f64>,
    pub range_pos: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_swing_high: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_swing_low: Option<f64>,
}

impl StateTimeframe {
    /// 该周期是否可用（装配与代码门都据此判，而不是看数值是否是 0）。
    pub fn is_available(&self) -> bool {
        self.window_high.is_some() && self.window_low.is_some() && self.range_pos.is_some()
    }

    pub fn unavailable() -> Self {
        Self {
            trend: "unknown".to_string(),
            window_high: None,
            window_low: None,
            range_pos: None,
            last_swing_high: None,
            last_swing_low: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StateStructure {
    pub tf_15m: StateTimeframe,
    pub tf_1h: StateTimeframe,
    pub tf_4h: StateTimeframe,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StateDerivatives {
    pub funding_rate: f64,
    pub funding_next_ms: i64,
    pub mark_price: f64,
    pub index_price: f64,
    pub basis_pct: f64,
    pub oi_usd: f64,
    pub oi_change_1h_pct: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StateEvent {
    pub title: String,
    pub importance: String,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StatePosition {
    pub inst_id: String,
    pub side: String,
    pub size: f64,
    pub entry_px: f64,
    pub upl_pct: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_px: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StateOpenOrder {
    pub side: String,
    pub px: f64,
    pub sz: f64,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StateAccount {
    pub equity_usdt: f64,
    pub available_usdt: f64,
    pub positions: Vec<StatePosition>,
    pub open_orders: Vec<StateOpenOrder>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct StateLimits {
    pub target_leverage: u32,
    pub max_single_trade_margin_pct: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StateRecentAction {
    pub at: i64,
    pub action: String,
    pub reason: String,
}

/// 一轮快判的实时快照（常驻内存缓存的一份拷贝）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FastlaneSnapshot {
    pub as_of: String,
    pub inst_id: String,
    pub instrument: StateInstrument,
    pub price: StatePrice,
    pub micro: StateMicro,
    pub volatility: StateVolatility,
    pub structure: StateStructure,
    pub derivatives: StateDerivatives,
    #[serde(default)]
    pub events: Vec<StateEvent>,
    pub account: StateAccount,
    pub limits: StateLimits,
    #[serde(default)]
    pub recent: Vec<StateRecentAction>,
    /// 各来源时间（内部用，不直接进 state）。
    #[serde(default)]
    pub source_times: DataAges,
}

impl FastlaneSnapshot {
    /// 各块来源时间（`data_age_ms` 的唯一来源）。
    pub fn source_times(&self) -> DataAges {
        self.source_times
    }

    /// §4 的 state JSON：`data_age_ms` 由 `source_times` 与 `as_of_ms` 推导。
    pub fn to_state(&self, as_of_ms: i64) -> Value {
        let mut value = serde_json::to_value(self).unwrap_or_else(|_| json!({}));
        if let Some(object) = value.as_object_mut() {
            // 内部字段不下发（state 只给"判断要不要动手"所需的摘要）。
            object.remove("source_times");
            object.insert(
                "data_age_ms".to_string(),
                serde_json::to_value(self.source_times.age_ms(as_of_ms)).unwrap_or(Value::Null),
            );
        }
        value
    }
}

// ===== 多周期聚合 / ATR14 / 结构（口径与 `scripts/experiments/fastlane-shadow-probe.mjs` 一致）=====

/// 一根 1m K 线（字段名与既有行情读取一致）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Bar {
    /// 开盘时间（毫秒）。
    pub t: i64,
    pub o: f64,
    pub h: f64,
    pub l: f64,
    pub c: f64,
    #[serde(default)]
    pub v: f64,
}

/// 把 1m K 线聚合成更高周期：按 `floor(t / bar_ms) * bar_ms` 分桶，
/// `o` 取桶内第一根、`h/l` 取极值、`c` 取最后一根、`v` 求和（与探针逐行一致）。
pub fn aggregate_bars(bars_1m: &[Bar], minutes: i64) -> Vec<Bar> {
    if minutes <= 1 || bars_1m.is_empty() {
        return bars_1m.to_vec();
    }
    let bar_ms = minutes * 60_000;
    let mut buckets: Vec<Bar> = Vec::new();
    let mut current_key: Option<i64> = None;
    for bar in bars_1m {
        let key = bar.t.div_euclid(bar_ms) * bar_ms;
        match current_key {
            Some(existing) if existing == key => {
                if let Some(last) = buckets.last_mut() {
                    last.h = last.h.max(bar.h);
                    last.l = last.l.min(bar.l);
                    last.c = bar.c;
                    last.v += bar.v;
                }
            }
            _ => {
                current_key = Some(key);
                buckets.push(Bar { t: key, ..*bar });
            }
        }
    }
    buckets
}

/// ATR14：最近 14 根的 TR 均值（TR = `max(h-l, |h-prevClose|, |l-prevClose|)`）。
/// **样本不足 `< n + 1` 根 → `None`**（不可用，不给 0）。
pub fn atr14(bars: &[Bar]) -> Option<f64> {
    const N: usize = 14;
    if bars.len() < N + 1 {
        return None;
    }
    let window = &bars[bars.len() - N..];
    let mut total = 0.0;
    for (index, bar) in window.iter().enumerate() {
        let previous_close = bars[bars.len() - N + index - 1].c;
        total += (bar.h - bar.l)
            .max((bar.h - previous_close).abs())
            .max((bar.l - previous_close).abs());
    }
    let atr = total / N as f64;
    atr.is_finite().then_some(atr)
}

fn ema(values: &[f64], n: usize) -> Option<f64> {
    if values.len() < n || n == 0 {
        return None;
    }
    let k = 2.0 / (n as f64 + 1.0);
    let mut value = values[..n].iter().sum::<f64>() / n as f64;
    for item in &values[n..] {
        value = item * k + value * (1.0 - k);
    }
    value.is_finite().then_some(value)
}

/// 结构视图：窗口高低、`range_pos`、最近摆动高低、趋势（EMA20/EMA50 + 前后半段摆动）。
/// **窗口不足 4 根 → `None`**（该周期标不可用，不给 0）。
pub fn structure_view(bars: &[Bar], lookback: usize) -> Option<StateTimeframe> {
    if lookback < 4 || bars.len() < lookback {
        return None;
    }
    let window = &bars[bars.len() - lookback..];
    let high = window.iter().fold(f64::MIN, |acc, bar| acc.max(bar.h));
    let low = window.iter().fold(f64::MAX, |acc, bar| acc.min(bar.l));
    let last = window.last()?.c;
    let closes = bars.iter().map(|bar| bar.c).collect::<Vec<_>>();
    let e20 = ema(&closes, 20);
    let e50 = ema(&closes, 50);
    let half = window.len() / 2;
    let (first, second) = window.split_at(half);
    if first.is_empty() || second.is_empty() {
        return None;
    }
    let previous_high = first.iter().fold(f64::MIN, |acc, bar| acc.max(bar.h));
    let previous_low = first.iter().fold(f64::MAX, |acc, bar| acc.min(bar.l));
    let last_high = second.iter().fold(f64::MIN, |acc, bar| acc.max(bar.h));
    let last_low = second.iter().fold(f64::MAX, |acc, bar| acc.min(bar.l));
    let trend = match (e20, e50) {
        (Some(e20), Some(e50))
            if e20 > e50 && last_high >= previous_high && last_low >= previous_low =>
        {
            "up"
        }
        (Some(e20), Some(e50))
            if e20 < e50 && last_high <= previous_high && last_low <= previous_low =>
        {
            "down"
        }
        (Some(_), Some(_)) => "range",
        _ => "unknown",
    };
    Some(StateTimeframe {
        trend: trend.to_string(),
        window_high: Some(high).filter(|value| value.is_finite()),
        window_low: Some(low).filter(|value| value.is_finite()),
        range_pos: (high > low).then_some((last - low) / (high - low)),
        last_swing_high: Some(last_high).filter(|value| value.is_finite()),
        last_swing_low: Some(last_low).filter(|value| value.is_finite()),
    })
}

/// `micro.*`：**只接受实时盘口 + 实时主动买卖比**。
///
/// 拿不到盘口（或拿不到主动买卖比）→ `None`：装配侧必须把该块标不可用
/// （`data_age_ms.orderbook = i64::MAX`），**绝不用落盘表或推算值凑**。
pub fn micro_from_orderbook(
    orderbook: &Value,
    taker_buy_ratio_5m: Option<f64>,
) -> Option<StateMicro> {
    let asks = orderbook.get("asks")?.as_array()?;
    let bids = orderbook.get("bids")?.as_array()?;
    let level = |items: &Vec<Value>| -> Option<(f64, f64)> {
        let px = items.first()?.get(0).and_then(Value::as_f64)?;
        let sz = items.first()?.get(1).and_then(Value::as_f64)?;
        Some((px, sz))
    };
    let (best_ask, ask_size) = level(asks)?;
    let (best_bid, bid_size) = level(bids)?;
    if !(best_ask.is_finite() && best_bid.is_finite()) || best_ask <= 0.0 || best_bid <= 0.0 {
        return None;
    }
    let mid = (best_ask + best_bid) / 2.0;
    if mid <= 0.0 {
        return None;
    }
    // 5bps 深度：买盘价 ≥ mid*(1-5bp)、卖盘价 ≤ mid*(1+5bp) 的累计名义价值。
    let lower = mid * (1.0 - 0.0005);
    let upper = mid * (1.0 + 0.0005);
    let depth = |items: &Vec<Value>, keep_bid: bool| -> f64 {
        items
            .iter()
            .filter_map(|item| {
                let px = item.get(0).and_then(Value::as_f64)?;
                let sz = item.get(1).and_then(Value::as_f64)?;
                let inside = if keep_bid { px >= lower } else { px <= upper };
                inside.then_some(px * sz)
            })
            .sum()
    };
    let total = bid_size + ask_size;
    Some(StateMicro {
        spread_bps: Some((best_ask - best_bid) / mid * 10_000.0),
        bid_ask_imbalance: Some(if total > 0.0 {
            (bid_size - ask_size) / total
        } else {
            0.0
        }),
        depth_5bps_usd: Some(depth(bids, true) + depth(asks, false)),
        taker_buy_ratio_5m: Some(taker_buy_ratio_5m?),
    })
}

// ===== §4 装配（B2：把纯函数串起来 + 字段映射表）=====

/// §4 state 的**字段映射表**（逐字段来源，三线审计后会按此复核）：
///
/// | state 字段 | 来源（既有工具输出） |
/// | --- | --- |
/// | `price.last` | `ticker.last` |
/// | `price.chg_{5m,1h,24h}_pct` | `ticker.chg5mPct` / `chg1hPct` / `chg24hPct`（也容忍 `chg5MPct` 等写法） |
/// | `price.{high,low,open}_24h` | `ticker.high24h` / `low24h` / `open24h` |
/// | `micro.*` | `micro_block(orderbook, taker_buy_ratio_5m)`：**实时盘口 + 实时成交流**；缺 → 四键 `null` |
/// | `volatility.atr14_{5m,1h,4h}` | `atr14(aggregate_bars(1m, 5 / 60 / 240))`；样本不足 → `null` |
/// | `structure.tf_{15m,1h,4h}` | `structure_view(aggregate_bars(1m, 15 / 60 / 240), lookback)`；不足 → 全 `null` |
/// | `derivatives.{funding_rate,funding_next_ms,mark_price,index_price,basis_pct,oi_usd,oi_change_1h_pct}` | `derivatives.fundingRate / fundingNextMs / markPx / idxPx / basisPct / oiUsd / oiChange1hPct` |
/// | `account.{equity_usdt,available_usdt}` | 账户快照/风控输出：`usdtEquity` / `availableUsdt` |
/// | `account.{positions,open_orders}` | 账户快照 `snapshot.positions` / `snapshot.openOrders` |
/// | `data_age_ms` | **各块来源时间**（`SnapshotSlot::at_ms`），缺失块 → `i64::MAX` |
///
/// 缺失一律留空/`None`（**不塞 0**）：由 `evaluate_gate` 判 `data`。
#[derive(Debug, Clone, Default)]
pub struct SnapshotInputs {
    pub inst_id: String,
    pub ticker: Option<SnapshotSlot<Value>>,
    pub orderbook: Option<SnapshotSlot<Value>>,
    pub candles_1m: Option<SnapshotSlot<Vec<Bar>>>,
    pub derivatives: Option<SnapshotSlot<Value>>,
    pub account: Option<SnapshotSlot<Value>>,
    /// 实时主动买卖比（来自成交流）；拿不到 → `None` → `micro` 整块不可用。
    pub taker_buy_ratio_5m: Option<f64>,
    pub instrument: StateInstrument,
    pub limits: StateLimits,
    pub events: Vec<StateEvent>,
    pub recent: Vec<StateRecentAction>,
}

fn pick_f64(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_f64))
        .filter(|item| item.is_finite())
}

fn pick_i64(value: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| {
        value.get(*key).and_then(|item| {
            item.as_i64()
                .or_else(|| item.as_f64().map(|float| float as i64))
        })
    })
}

/// 数值字段的宽容读取：OKX 的资金费率/持仓量等既有返回是**字符串**（`"0.0001"`），
/// 既有工具的字段映射表（见 [`SnapshotInputs`]）对两种形态都要认。
fn pick_number(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| {
            let item = value.get(*key)?;
            item.as_f64().or_else(|| {
                item.as_str()
                    .and_then(|text| text.trim().parse::<f64>().ok())
            })
        })
        .filter(|item| item.is_finite())
}

/// §4 装配：把缓存里的原始块 + 已实现的纯函数串成 state。
pub fn assemble_snapshot(inputs: &SnapshotInputs, as_of_ms: i64) -> FastlaneSnapshot {
    let ticker = inputs.ticker.as_ref().map(|slot| &slot.value);
    let derivatives = inputs.derivatives.as_ref().map(|slot| &slot.value);
    let account = inputs.account.as_ref().map(|slot| &slot.value);
    let empty = Value::Null;

    let bars_1m = inputs
        .candles_1m
        .as_ref()
        .map(|slot| slot.value.clone())
        .unwrap_or_default();
    let tf_view = |minutes: i64, lookback: usize| -> StateTimeframe {
        let bars = aggregate_bars(&bars_1m, minutes);
        structure_view(&bars, lookback).unwrap_or_else(StateTimeframe::unavailable)
    };
    let atr = |minutes: i64| -> Option<f64> { atr14(&aggregate_bars(&bars_1m, minutes)) };
    // 观察窗口按周期取（15m 60 根 ≈ 15 小时、1H 48 根 ≈ 2 天、4H 24 根 ≈ 4 天）。
    // ⚠️ 采集器必须提供**足够长的 1m 历史**（≥ 4H 窗口 24×4h = 4 天），否则该周期会是 `null`
    // —— 这是"不凑数"的必然结果，不是 bug（窗口不足时宁缺勿假）。
    let structure = StateStructure {
        tf_15m: tf_view(15, 60),
        tf_1h: tf_view(60, 48),
        tf_4h: tf_view(240, 24),
    };
    let volatility = StateVolatility {
        atr14_5m: atr(5),
        atr14_1h: atr(60),
        atr14_4h: atr(240),
        regime: volatility_regime(&structure, &bars_1m),
    };
    let account_value = account.unwrap_or(&empty);
    let snapshot_value = account_value.get("snapshot").unwrap_or(account_value);
    let account_block = StateAccount {
        equity_usdt: pick_f64(account_value, &["usdtEquity", "equityUsdt"])
            .or_else(|| pick_f64(snapshot_value, &["usdtEquity", "equityUsdt"]))
            .unwrap_or(f64::NAN),
        available_usdt: pick_f64(account_value, &["availableUsdt"])
            .or_else(|| pick_f64(snapshot_value, &["availableUsdt"]))
            .unwrap_or(f64::NAN),
        positions: snapshot_value
            .get("positions")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(parse_position).collect())
            .unwrap_or_default(),
        open_orders: snapshot_value
            .get("openOrders")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(parse_open_order).collect())
            .unwrap_or_default(),
    };
    let ticker_value = ticker.unwrap_or(&empty);
    let derivatives_value = derivatives.unwrap_or(&empty);
    FastlaneSnapshot {
        as_of: as_of_ms.to_string(),
        inst_id: inputs.inst_id.clone(),
        instrument: inputs.instrument.clone(),
        price: StatePrice {
            last: pick_f64(ticker_value, &["last", "lastPx"]).unwrap_or(f64::NAN),
            chg_5m_pct: pick_f64(ticker_value, &["chg5mPct", "chg5MPct"]).unwrap_or(f64::NAN),
            chg_1h_pct: pick_f64(ticker_value, &["chg1hPct", "chg1HPct"]).unwrap_or(f64::NAN),
            chg_24h_pct: pick_f64(ticker_value, &["chg24hPct"]).unwrap_or(f64::NAN),
            high_24h: pick_f64(ticker_value, &["high24h", "high24HPx"]).unwrap_or(f64::NAN),
            low_24h: pick_f64(ticker_value, &["low24h", "low24HPx"]).unwrap_or(f64::NAN),
            open_24h: pick_f64(ticker_value, &["open24h", "open24HPx"]).unwrap_or(f64::NAN),
        },
        micro: micro_block(
            inputs.orderbook.as_ref().map(|slot| &slot.value),
            inputs.taker_buy_ratio_5m,
        ),
        volatility,
        structure,
        derivatives: StateDerivatives {
            funding_rate: pick_f64(derivatives_value, &["fundingRate"]).unwrap_or(f64::NAN),
            funding_next_ms: pick_i64(derivatives_value, &["fundingNextMs", "nextFundingTime"])
                .unwrap_or(0),
            mark_price: pick_f64(derivatives_value, &["markPx", "markPrice"]).unwrap_or(f64::NAN),
            index_price: pick_f64(derivatives_value, &["idxPx", "indexPrice"]).unwrap_or(f64::NAN),
            basis_pct: pick_f64(derivatives_value, &["basisPct"]).unwrap_or(f64::NAN),
            oi_usd: pick_f64(derivatives_value, &["oiUsd"]).unwrap_or(f64::NAN),
            oi_change_1h_pct: pick_f64(derivatives_value, &["oiChange1hPct"]).unwrap_or(f64::NAN),
        },
        events: inputs.events.clone(),
        account: account_block,
        limits: inputs.limits,
        recent: inputs.recent.clone(),
        // **data_age_ms 的唯一来源**：各块自己的来源时间（缺块 → 0 → `age_ms` 判 i64::MAX）。
        source_times: DataAges {
            ticker: inputs.ticker.as_ref().map(|slot| slot.at_ms).unwrap_or(0),
            orderbook: inputs
                .orderbook
                .as_ref()
                .map(|slot| slot.at_ms)
                .unwrap_or(0),
            candles_1m_closed: inputs
                .candles_1m
                .as_ref()
                .map(|slot| slot.at_ms)
                .unwrap_or(0),
            derivatives: inputs
                .derivatives
                .as_ref()
                .map(|slot| slot.at_ms)
                .unwrap_or(0),
            account: inputs.account.as_ref().map(|slot| slot.at_ms).unwrap_or(0),
        },
    }
}

fn volatility_regime(structure: &StateStructure, bars_1m: &[Bar]) -> String {
    if !structure.tf_1h.is_available() {
        return "unknown".to_string();
    }
    let atr = atr14(&aggregate_bars(bars_1m, 60));
    match (atr, structure.tf_1h.window_high, structure.tf_1h.window_low) {
        (Some(atr), Some(high), Some(low)) if high > low => {
            let ratio = atr / (high - low);
            if ratio >= 0.25 {
                "volatile".to_string()
            } else if structure.tf_1h.trend == "range" {
                "range".to_string()
            } else {
                "trend".to_string()
            }
        }
        _ => "unknown".to_string(),
    }
}

fn parse_position(value: &Value) -> Option<StatePosition> {
    Some(StatePosition {
        inst_id: value.get("instId")?.as_str()?.to_string(),
        side: value
            .get("posSide")
            .and_then(Value::as_str)
            .unwrap_or("net")
            .to_string(),
        size: pick_f64(value, &["pos", "size"])?,
        entry_px: pick_f64(value, &["avgPx", "entryPx"])?,
        upl_pct: pick_f64(value, &["uplRatioPct", "uplPct"]).unwrap_or(0.0),
        stop_px: pick_f64(value, &["stopPx", "slTriggerPx"]),
    })
}

fn parse_open_order(value: &Value) -> Option<StateOpenOrder> {
    Some(StateOpenOrder {
        side: value.get("side")?.as_str()?.to_string(),
        px: pick_f64(value, &["px", "price"])?,
        sz: pick_f64(value, &["sz", "size"])?,
        state: value
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("live")
            .to_string(),
    })
}

/// 一块实时数据：**值 + 来源时间**（C29 约束 c：`data_age_ms` 必须反映真实来源时间，
/// 不许用"读取时刻"顶替）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotSlot<T> {
    pub value: T,
    /// 该值的**来源时间**（交易所时间戳 / 成交回报时间 / 账户快照时间）。
    pub at_ms: i64,
}

impl<T> SnapshotSlot<T> {
    pub fn new(value: T, at_ms: i64) -> Self {
        Self { value, at_ms }
    }

    /// 距 `anchor_ms` 的年龄（来源时间缺失/未来 → `i64::MAX` = 视为不可用）。
    pub fn age_ms(&self, anchor_ms: i64) -> i64 {
        if self.at_ms <= 0 || self.at_ms > anchor_ms {
            i64::MAX
        } else {
            anchor_ms - self.at_ms
        }
    }
}

/// 快判 Profile 的**常驻内存快照缓存**（按 `(account, inst)` 一份，1 秒节拍刷新）。
///
/// 本类型只负责**存与判**：每个块各记来源时间、按块判新鲜度；
/// 取数（公开 WS 复用 / 既有读函数）由 runner 侧的采集器负责写入。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FastlaneSnapshotCache {
    pub account_id: String,
    pub inst_id: String,
    pub ticker: Option<SnapshotSlot<Value>>,
    pub orderbook: Option<SnapshotSlot<Value>>,
    pub candles_1m: Option<SnapshotSlot<Vec<Value>>>,
    pub derivatives: Option<SnapshotSlot<Value>>,
    pub account: Option<SnapshotSlot<Value>>,
    /// 5 分钟主动买卖比（`micro.taker_buy_ratio_5m`；窗口内无成交 → `None`）。
    /// 由采集器的实时成交流窗口（[`TakerWindow`]）写入。
    #[serde(default)]
    pub taker_buy_ratio_5m: Option<f64>,
    /// 该缓存**是否自己持有**一份公开 WS 订阅（复用了图表消费者时为 false）——
    /// 停机/停用必须据此释放（C29 约束 b：不能泄漏订阅）。
    pub owns_public_stream: bool,
}

impl FastlaneSnapshotCache {
    pub fn new(account_id: impl Into<String>, inst_id: impl Into<String>) -> Self {
        Self {
            account_id: account_id.into(),
            inst_id: inst_id.into(),
            ticker: None,
            orderbook: None,
            candles_1m: None,
            derivatives: None,
            account: None,
            taker_buy_ratio_5m: None,
            owns_public_stream: false,
        }
    }

    /// 供 `data_age_ms` 使用的各块来源时间（缺失块 → 0，`DataAges::age_ms` 会把它判为不可用）。
    pub fn source_times(&self) -> DataAges {
        DataAges {
            ticker: self.ticker.as_ref().map(|slot| slot.at_ms).unwrap_or(0),
            orderbook: self.orderbook.as_ref().map(|slot| slot.at_ms).unwrap_or(0),
            candles_1m_closed: self.candles_1m.as_ref().map(|slot| slot.at_ms).unwrap_or(0),
            derivatives: self
                .derivatives
                .as_ref()
                .map(|slot| slot.at_ms)
                .unwrap_or(0),
            account: self.account.as_ref().map(|slot| slot.at_ms).unwrap_or(0),
        }
    }

    /// 按来源时间算出每块年龄（**不用读取时刻**）。
    pub fn ages(&self, anchor_ms: i64) -> DataAges {
        self.source_times().age_ms(anchor_ms)
    }

    /// 释放自己持有的公开流订阅（复用时不动别人的订阅）。
    ///
    /// 返回 `true` = 本次确实需要调用方去停掉自己的订阅；`false` = 复用了图表消费者的订阅，
    /// 什么都不做（约束 a：不得干扰图表消费者）。
    pub fn release_public_stream(&mut self) -> bool {
        if self.owns_public_stream {
            self.owns_public_stream = false;
            return true;
        }
        false
    }

    /// 是否所有块都在阈值内（代码门 ①数据的判定底座）。
    pub fn fresh_enough(&self, anchor_ms: i64, max_age: &DataAges) -> bool {
        let ages = self.ages(anchor_ms);
        ages.ticker <= max_age.ticker
            && ages.orderbook <= max_age.orderbook
            && ages.candles_1m_closed <= max_age.candles_1m_closed
            && ages.derivatives <= max_age.derivatives
            && ages.account <= max_age.account
    }
}

/// 快照是否够新鲜（代码门 ①数据；阈值由调用方给，默认见 [`DEFAULT_MAX_DATA_AGE_MS`]）。
///
/// **门限口径（冻结，C29.7 补充）**：块是"实时流"还是"推送/桶"决定门限的**下限**——
/// 门限必须 ≥ 该块自身的更新粒度，否则"过期"是口径错误而不是数据问题。
/// - `ticker` / `orderbook` / `account`：WS 实时推送（≤1s）→ 2s / 2s / **15s**；
///   （`orderbook` 是**可选**块：超门限只留痕不拦轮，见 [`FASTLANE_OPTIONAL_DATA_BLOCKS`]）；
/// - `candles_1m_closed`：1m 收盘 K 线 → 90s（一根 + 余量）；
/// - `derivatives`：交易所**推送/桶粒度**数据（OKX funding-rate 推送 30–60s，OI 快照分钟级
///   且落库粒度 5 分钟）→ **360s**（= 5 分钟桶 + 60s 余量）。
///   ⚠️ 旧值 60s 是**口径错误**：桶数据天生不可能满足 60s，真机上表现为"每轮都判过期"。
///   来源时间口径见 [`normalize_derivatives_block`]（交易所 `ts` 优先，否则采集时刻；
///   两者都把桶时间落进 `bucketAtMs` 以便审计）。
///
/// ⚠️ `account` 旧值 5s 是**同一类口径错误**（2026-09-21 真机）：账户块的来源时间是私有快照的
/// `syncedAt`，而"这个快照还算新鲜"的唯一规则是 [`crate::AI_MEMORY_PRIVATE_SNAPSHOT_MAX_AGE_MS`]
/// = **15s**（`ai_read_fresh_memory_account_snapshot` 的判据）—— 采集器据此**不再重新拉取**，
/// 于是"5s 门限 + 15s 缓存规则"必然自相矛盾：实测账户块恒 7.5s / 10.3s 旧，连续两轮被拦。
/// 现在**直接引用该常量**（不是抄一个 15_000），门限不可能再比"账户快照可用"的规则更严。
pub const DEFAULT_MAX_DATA_AGE_MS: DataAges = DataAges {
    ticker: 2_000,
    orderbook: 2_000,
    candles_1m_closed: 90_000,
    derivatives: 360_000,
    account: crate::AI_MEMORY_PRIVATE_SNAPSHOT_MAX_AGE_MS,
};

/// 结构方向是否**互为反义**（冲突判定的**唯一**依据，C29.7 收窄）。
///
/// **只有 `up` ↔ `down` 算反义**；`range` / `unknown` 一律不算（它们是"看不清"，
/// 不是"互相矛盾"）。BTC 上"1H 区间 + 15m 上行"是区间内的一次上行 —— 把 `up` vs `range`
/// 判成冲突会让绝大多数轮次被拦、模式事实上跑不起来（真机就这样被拦下了）。
pub fn trends_are_opposed(left: &str, right: &str) -> bool {
    matches!((left.trim(), right.trim()), ("up", "down") | ("down", "up"))
}

/// 非反义的多周期结构不一致 → **不拦轮**，只留痕（与可选块同一形态：不静默、也不拦）。
pub fn non_opposed_structure_text(
    left_label: &str,
    left: &str,
    right_label: &str,
    right: &str,
) -> String {
    format!(
        "多周期结构不一致：{left_label} {} / {right_label} {}（非反义，不拦轮）",
        left.trim(),
        right.trim()
    )
}

/// 数据门的块口径表（**唯一来源**）：门与"按需预热"都读它，改一处不会漂。
///
/// 顺序＝门报错时的先后（第一道不合格的门决定文案）。
pub const FASTLANE_DATA_BLOCKS: [&str; 5] = [
    "ticker",
    "orderbook",
    "candles_1m_closed",
    "derivatives",
    "account",
];

/// **可选**块：缺了/过期**不拦轮**（只在 `gate.reasons` 里如实留痕，由 Jev/LLM 自行判断）。
///
/// 为什么：`orderbook` 与由它派生的 `micro.*` 依赖**内存盘口/成交流**，冷启动或成交流稀疏时
/// 天然为 `None`；把它当必需的，快判模式在 taker 窗口热起来之前每一轮都会被拦 →
/// 事实上的"跑不起来"（真机 `takerRatio=None` 就是这一幕）。
/// 必需块（缺了确实无法定价/定量/校验）：`ticker` / `candles_1m_closed` / `derivatives` / `account`；
/// 结构周期与 `atr14_*` 属于 `candles_1m_closed` 的能力，**仍然拦**。
pub const FASTLANE_OPTIONAL_DATA_BLOCKS: [&str; 1] = ["orderbook"];

/// 该块是否**必需**（缺/过期 → 当轮不判定）。
pub fn data_block_is_required(block: &str) -> bool {
    !FASTLANE_OPTIONAL_DATA_BLOCKS.contains(&block)
}

/// 可选块的留痕文案（`ok` 不受影响；**不静默**）。
pub fn optional_data_text(detail: &str) -> String {
    format!("{detail}（可选，不拦轮）")
}

/// `micro` 不可用的留痕文案（可选块的能力：盘口派生）。
pub fn optional_micro_text() -> String {
    optional_data_text("micro 不可用（实时盘口/主动买卖比缺失）")
}

/// 某块的年龄（门票；`None` = 不认识的块名）。
pub fn data_age_for(block: &str, ages: &DataAges) -> Option<i64> {
    match block {
        "ticker" => Some(ages.ticker),
        "orderbook" => Some(ages.orderbook),
        "candles_1m_closed" => Some(ages.candles_1m_closed),
        "derivatives" => Some(ages.derivatives),
        "account" => Some(ages.account),
        _ => None,
    }
}

/// 某块的门限（门票；`None` = 不认识的块名）。与 [`data_age_for`] 成对使用。
pub fn data_age_limit_for(block: &str, max_age: &DataAges) -> Option<i64> {
    data_age_for(block, max_age)
}

/// 代码门结果（C29.7 `gate` 组）。
///
/// **变更 A（2026-09-21）**：质量门 / 置信度门只作用于**开新仓**，降险动作（Jev 自判减仓/平仓）
/// 不受这两道门约束 → 必须能看出"这一轮门没过、但因为是降险而放行"。因此新增两个**标注位**：
/// `applied_to`（这道门作用于哪条路径，恒为 `open`）与 `bypassed_for`（`risk_reduction` = 被降险豁免）。
/// `ok` **绝不改写**：它永远是门自己的结论（把 false 改成 true 就是伪造事实）。
///
/// **C29.18（2026-09-21）**：入场质量门改成纯代码判据后，多一个 `entry_quality` **读数**位 ——
/// 侧车算好（三条判据的取数 / 阈值 / 结论），Rust **只读透传**（不重算、不解释内部字段，
/// 避免出现第二份判定实现）。形状由侧车契约冻结，UI 直接渲染。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateOutcome {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anomaly: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<String>,
    /// 其余代码门（目前只有 `session_closed`；UI 已有 `gate.reasons` 渲染位）。
    /// 用列表是为了**同时如实保留**多道门的结果（例如"时段已关 + 数据过期"）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reasons: Vec<String>,
    pub ok: bool,
    /// 这道门的作用域（侧车质量/置信度门恒为 `open`：只作用于开新仓）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_to: Option<String>,
    /// 这道门被谁豁免（`risk_reduction` = Jev 判减仓/平仓，降险轮不受质量/置信度门约束）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bypassed_for: Option<String>,
    /// **C29.18 入场质量门的读数**（侧车算、Rust 只读透传）：三条代码判据的取数 / 阈值 / 结论。
    /// 缺字段 = 老侧车 / 未评估（行为不变）—— 这里刻意用 `Value` 透传：Rust **不重算、不解释**，
    /// 免得出现第二份判定实现（判据唯一实现在侧车 `fastlaneEntryQuality`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_quality: Option<Value>,
}

impl GateOutcome {
    pub fn pass() -> Self {
        Self {
            data: None,
            anomaly: None,
            conflict: None,
            reasons: Vec::new(),
            ok: true,
            applied_to: None,
            bypassed_for: None,
            entry_quality: None,
        }
    }

    pub fn data_failed(reason: impl Into<String>) -> Self {
        Self {
            data: Some(reason.into()),
            anomaly: None,
            conflict: None,
            reasons: Vec::new(),
            ok: false,
            applied_to: None,
            bypassed_for: None,
            entry_quality: None,
        }
    }

    pub fn anomaly_failed(reason: impl Into<String>) -> Self {
        Self {
            data: None,
            anomaly: Some(reason.into()),
            conflict: None,
            reasons: Vec::new(),
            ok: false,
            applied_to: None,
            bypassed_for: None,
            entry_quality: None,
        }
    }

    pub fn conflict_failed(reason: impl Into<String>) -> Self {
        Self {
            data: None,
            anomaly: None,
            conflict: Some(reason.into()),
            reasons: Vec::new(),
            ok: false,
            applied_to: None,
            bypassed_for: None,
            entry_quality: None,
        }
    }

    /// 数据/异常/冲突之外的代码门（时段门、配置门…）：只填 `reasons`，`ok: false`。
    ///
    /// **不新增观望原因枚举**：调用方把冻结枚举里的原因码写进 `action.reason`，
    /// 这里写人类可读的原因（`gate.reasons`）。
    pub fn blocked_by_gate(reason: impl Into<String>) -> Self {
        Self {
            data: None,
            anomaly: None,
            conflict: None,
            reasons: vec![reason.into()],
            ok: false,
            applied_to: None,
            bypassed_for: None,
            entry_quality: None,
        }
    }

    /// 时段门（`fastlane_trading_hours`）：不在配置的时段内 → 当轮不判定。
    pub fn session_closed(reason: impl Into<String>) -> Self {
        Self::blocked_by_gate(reason)
    }

    /// 配置门：这个 Profile 的执行模式**不支持动作**（目前只有 advisor）→ 当轮不判定。
    pub fn config_blocked(reason: impl Into<String>) -> Self {
        Self::blocked_by_gate(reason)
    }

    /// 命中第一个不合格的门时对应的观望原因码（无门失败 → `None`）。
    pub fn watch_reason(&self) -> Option<&'static str> {
        if self.data.is_some() {
            Some("data")
        } else if self.anomaly.is_some() {
            Some("anomaly")
        } else if self.conflict.is_some() {
            Some("conflict")
        } else {
            None
        }
    }
}

/// 数据块的"缺失"哨兵（`DataAges::age_ms` / `SnapshotSlot::age_ms` 在没有来源时间时给的值）。
///
/// **它是"没有数据"，不是"数据很旧"**：文案里绝不允许打印这个数字。
pub fn data_age_is_missing(age: i64) -> bool {
    age == i64::MAX
}

/// 年龄/上限 → 人读单位（`<1000ms` 用 `ms`，`≥1000ms` 用一位小数的 `s`；两处同一规则）。
pub fn format_data_age_ms(value: i64) -> String {
    if value >= 1_000 {
        format!("{:.1}s", value as f64 / 1_000.0)
    } else {
        format!("{value}ms")
    }
}

/// 数据块的**缺失**文案（采集器尚未产出；不打印哨兵数字）。
pub fn data_missing_text(label: &str) -> String {
    format!("{label} 数据缺失（采集器尚未产出）")
}

/// 代码门：数据新鲜度 → 异常 → 多周期冲突（顺序固定，先到先记）。
///
/// 三条都是**纯判定**：命中任何一条都当轮不判定（观望），由 LLM 写下一轮观察条件。
///
/// **必需 / 可选分层（lead 裁决 2026-09-20）**：数据门只拦
/// [`FASTLANE_DATA_BLOCKS`] 里的**必需块**（ticker / candles_1m_closed / derivatives / account）
/// 以及它们的能力（结构周期、`atr14_*`）；**可选块**（`orderbook` 与由它派生的 `micro.*`）
/// 缺失/过期时**不影响 `ok`**，只在 `reasons` 里留一条 `（可选，不拦轮）` 的痕迹，
/// 由 Jev/LLM 按 state 里的显式 `null` 自行判断。
pub fn evaluate_gate(
    ages: &DataAges,
    snapshot: &FastlaneSnapshot,
    anomalies: &[String],
    max_age: &DataAges,
) -> GateOutcome {
    // 可选块（`orderbook` / `micro.*`）的留痕：**不影响 `ok`**，但绝不静默。
    let mut notes = Vec::new();
    let with_notes = |mut gate: GateOutcome, notes: &[String]| -> GateOutcome {
        for note in notes {
            if !gate.reasons.iter().any(|item| item == note) {
                gate.reasons.push(note.clone());
            }
        }
        gate
    };
    for label in FASTLANE_DATA_BLOCKS {
        let (Some(age), Some(limit)) = (
            data_age_for(label, ages),
            data_age_limit_for(label, max_age),
        ) else {
            continue;
        };
        // ① 缺失（哨兵）与 ② 真过期是**两件事**：文案分开，且都不打印哨兵数字。
        let full = if data_age_is_missing(age) {
            data_missing_text(label)
        } else if age > limit {
            format!(
                "{label} 数据过期：{} > {}（上限 {}ms）",
                format_data_age_ms(age),
                format_data_age_ms(limit),
                limit
            )
        } else {
            continue;
        };
        if data_block_is_required(label) {
            // 必需块：缺了确实无法定价/定量/校验 → 当轮不判定（可选块的留痕一并带上）。
            return with_notes(GateOutcome::data_failed(full), &notes);
        }
        // 可选块：只留痕，不拦轮（`orderbook` 衍生出 `micro.*`，由 Jev/LLM 自行判断）。
        notes.push(optional_data_text(&full));
    }
    // `micro` 不可用（`null`）：**不拦**，但必须在 state 里显式 `null`、
    // 并在 `reasons` 留痕（"波动为零 / 点差为零"这种误读由 prompt 的 null 规则杜绝）。
    if !snapshot.micro.is_available() {
        notes.push(optional_micro_text());
    }
    for (label, view) in [
        ("tf_15m", &snapshot.structure.tf_15m),
        ("tf_1h", &snapshot.structure.tf_1h),
        ("tf_4h", &snapshot.structure.tf_4h),
    ] {
        if !view.is_available() {
            // 结构周期属于**必需块** `candles_1m_closed` 的能力：没有结构就没有定价/失效位。
            return with_notes(
                GateOutcome::data_failed(data_missing_text(&format!("{label} 结构"))),
                &notes,
            );
        }
    }
    for (label, atr) in [
        ("atr14_5m", snapshot.volatility.atr14_5m),
        ("atr14_1h", snapshot.volatility.atr14_1h),
        ("atr14_4h", snapshot.volatility.atr14_4h),
    ] {
        if atr.is_none() {
            // 同理：ATR 是 `candles_1m_closed` 的能力，**仍然拦**。
            return with_notes(
                GateOutcome::data_failed(data_missing_text(&format!("{label}（样本不足）"))),
                &notes,
            );
        }
    }
    if let Some(first) = anomalies.iter().find(|item| !item.trim().is_empty()) {
        return with_notes(GateOutcome::anomaly_failed(first.clone()), &notes);
    }
    // 多周期冲突（C29.7 收窄）：**只有反义组合**（`up` ↔ `down`）才算冲突。
    // `range` / `unknown` 参与的任意组合都不拦轮，只在下方留痕（不静默）。
    // 注：冲突判定只看 15m 与 1h（4H 不参与；若将来加入，同样只按反义判）。
    let trend_15m = snapshot.structure.tf_15m.trend.trim();
    let trend_1h = snapshot.structure.tf_1h.trend.trim();
    if trends_are_opposed(trend_15m, trend_1h) {
        return with_notes(
            GateOutcome::conflict_failed(format!("15m {trend_15m} 与 1h {trend_1h} 趋势相反")),
            &notes,
        );
    }
    if trend_15m != trend_1h {
        notes.push(non_opposed_structure_text("15m", trend_15m, "1h", trend_1h));
    }
    with_notes(GateOutcome::pass(), &notes)
}

// ===== §8.1 代码校验 =====

/// 盈亏比底线（设计 §8.1-3）。
pub const MIN_REWARD_RISK_RATIO: f64 = 1.5;

/// Jev/LLM 的动作分支产物（LLM 写参数）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FastlanePlan {
    /// `long` | `short`（降险动作同样经这里：`reduce`/`close` 用 `order_type` 区分）。
    pub side: String,
    /// `limit` | `market` | `reduce` | `close`。
    pub order_type: String,
    pub entry_px: f64,
    pub stop_px: f64,
    #[serde(default)]
    pub take_profit: Vec<f64>,
    pub size_contracts: f64,
    pub risk_pct: f64,
    #[serde(default)]
    pub margin_mode: String,
    /// 失效位（做多：`stop_px < invalidation`；做空反之）。
    pub invalidation: f64,
    #[serde(default)]
    pub reason_tags: Vec<String>,
    #[serde(default)]
    pub confidence: f64,
}

/// 校验所需的账户/合约事实（全部来自实时快照与 Profile）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ValidationInputs {
    pub last_price: f64,
    pub equity_usdt: f64,
    pub target_leverage: u32,
    pub max_leverage: u32,
    pub min_size: f64,
    pub max_size: f64,
    pub profile_max_single_trade_margin_pct: f64,
    pub risk_per_trade_pct: f64,
    pub max_slippage_bps: u32,
    pub blackout_active: bool,
    pub margin_mode_allowed: bool,
}

/// 校验拒绝（`llm.validation` 组：`{ ok:false, reasons[] }`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationRejection {
    pub ok: bool,
    pub reasons: Vec<String>,
}

impl Default for ValidationRejection {
    /// **缺键 = 未通过**（侧车只在窄调用 LLM 没跑完时才不回 `validation`）：
    /// 默认 `{ ok: false, reasons: [] }`，调用方再把错误原文补进 `reasons`。
    fn default() -> Self {
        Self {
            ok: false,
            reasons: Vec::new(),
        }
    }
}

/// 通过代码校验的一轮产物。
///
/// **唯一构造入口是 [`validate_round`]** —— 执行侧（创建机会 / 降险动作）只接受这个类型，
/// 因此"跳过校验直接执行"在类型层面就不存在（C29.2/C29.6 的"无旁路"要求）。
#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedRound {
    plan: FastlanePlan,
}

impl ValidatedRound {
    pub fn plan(&self) -> &FastlanePlan {
        &self.plan
    }
}

/// §8.1 的七项代码校验（LLM 之后必须再过一遍；任一不过 → 当轮不执行）。
///
/// **降险口径（C29.7 / 2026-09-20 审计裁决，开仓与降险不是同一套准入）**：
/// `order_type ∈ {reduce, close}`（减仓/平仓/撤单/改单）**只**受这些约束——
///   ④ 手数上限（可平数量）、杠杆上限（不查）、保证金模式合规（账户能力）
///   ② 单笔风险/保证金（不查：已经在减风险）
///   ⑤ 入场价与滑点（不查：市价平仓没有报价）
///   ③ 盈亏比（不查）、最小手数（不查：降险可以小于开仓最小手数）
///   ① 止损/失效位（不查）
/// 外加调用方对**数据新鲜度/事件黑名单**的处理：见 [`gate_blocks_round`] ——
/// ticker 过期就把用户的停机平仓挡住，是必须避免的失效（侧车 close 分支同口径）。
pub fn validate_round(
    plan: FastlanePlan,
    inputs: &ValidationInputs,
) -> Result<ValidatedRound, ValidationRejection> {
    let mut reasons = Vec::new();
    let is_long = plan.side == "long";
    let is_reduce = matches!(plan.order_type.as_str(), "reduce" | "close");

    // ① 止损必须在失效位之外。
    if !is_reduce {
        if is_long && !(plan.stop_px < plan.invalidation) {
            reasons.push(format!(
                "stop_inside_invalidation: 做多止损 {} 必须在失效位 {} 之下",
                plan.stop_px, plan.invalidation
            ));
        }
        if !is_long && !(plan.stop_px > plan.invalidation) {
            reasons.push(format!(
                "stop_inside_invalidation: 做空止损 {} 必须在失效位 {} 之上",
                plan.stop_px, plan.invalidation
            ));
        }
    }

    // ② 单笔风险 ≤ 上限；保证金 ≤ Profile 上限。
    if !is_reduce {
        if !(plan.risk_pct.is_finite() && plan.risk_pct > 0.0) {
            reasons.push("risk_not_positive: 单笔风险必须是有限正数".to_string());
        } else if plan.risk_pct > inputs.risk_per_trade_pct + 1e-9 {
            reasons.push(format!(
                "risk_over_limit: 单笔风险 {:.4}% > 上限 {:.4}%",
                plan.risk_pct, inputs.risk_per_trade_pct
            ));
        }
        let stop_distance = (plan.entry_px - plan.stop_px).abs();
        if !(stop_distance.is_finite() && stop_distance > 0.0) {
            reasons.push("stop_distance_zero: 入场价与止损价必须不同".to_string());
        } else if inputs.equity_usdt > 0.0 {
            let risk_usdt = plan.risk_pct / 100.0 * inputs.equity_usdt;
            let notional = risk_usdt * plan.entry_px / stop_distance;
            let margin = if inputs.target_leverage > 0 {
                notional / f64::from(inputs.target_leverage)
            } else {
                f64::INFINITY
            };
            let margin_pct = margin / inputs.equity_usdt * 100.0;
            if margin_pct > inputs.profile_max_single_trade_margin_pct + 1e-9 {
                reasons.push(format!(
                    "margin_over_profile_limit: 预计保证金 {margin_pct:.2}% > Profile 上限 {:.2}%",
                    inputs.profile_max_single_trade_margin_pct
                ));
            }
        }
    }

    // ③ 盈亏比 ≥ 1.5。
    if !is_reduce {
        let best_tp = plan
            .take_profit
            .iter()
            .copied()
            .filter(|value| value.is_finite())
            .reduce(|left, right| {
                if is_long {
                    left.max(right)
                } else {
                    left.min(right)
                }
            });
        let stop_distance = (plan.entry_px - plan.stop_px).abs();
        match (best_tp, stop_distance > 0.0) {
            (None, _) => reasons.push("missing_take_profit: 缺少止盈目标".to_string()),
            (Some(tp), true) => {
                let reward = (tp - plan.entry_px).abs();
                let ratio = reward / stop_distance;
                if ratio < MIN_REWARD_RISK_RATIO {
                    reasons.push(format!(
                        "reward_risk_below_floor: 盈亏比 {ratio:.2} < {MIN_REWARD_RISK_RATIO}"
                    ));
                }
            }
            _ => {}
        }
    }

    // ④ 手数 / 杠杆 / 保证金模式。
    // 降险动作（减仓/平仓）不受**最小手数**约束：已经持有的仓位必须能减、能平，
    // 否则"最小手数"会反过来阻止降险（安全 > 一致）。上限仍然管。
    if !plan.size_contracts.is_finite() {
        reasons.push(format!(
            "size_invalid: 手数必须是有限数：{}",
            plan.size_contracts
        ));
    } else if !is_reduce && plan.size_contracts < inputs.min_size {
        reasons.push(format!(
            "size_below_min: 手数 {} 小于最小手数 {}",
            plan.size_contracts, inputs.min_size
        ));
    } else if plan.size_contracts > inputs.max_size {
        reasons.push(format!(
            "size_over_limit: 手数 {} 超过上限 {}",
            plan.size_contracts, inputs.max_size
        ));
    }
    // 杠杆只约束**开仓**：平仓/减仓不需要建立杠杆（C29.7 降险口径）。
    if !is_reduce && inputs.target_leverage > inputs.max_leverage {
        reasons.push(format!(
            "leverage_over_instrument_limit: 目标杠杆 {} > 合约上限 {}",
            inputs.target_leverage, inputs.max_leverage
        ));
    }
    if !inputs.margin_mode_allowed {
        reasons.push(format!(
            "margin_mode_not_allowed: 保证金模式 {:?} 不被允许",
            plan.margin_mode
        ));
    }

    // ⑤ 入场价与滑点 —— **降险轮不查**（C29.7 降险口径：市价平仓根本没有报价，
    // 而且"价格区间/滑点"是开仓的准入条件，不是降险的准入条件）。
    if !is_reduce && !(plan.entry_px.is_finite() && plan.entry_px > 0.0) {
        reasons.push("entry_price_invalid: 入场价必须是有限正数".to_string());
    } else if !is_reduce && matches!(plan.order_type.as_str(), "market") && inputs.last_price > 0.0
    {
        let slippage_bps =
            ((plan.entry_px - inputs.last_price).abs() / inputs.last_price) * 10_000.0;
        if slippage_bps > f64::from(inputs.max_slippage_bps) {
            reasons.push(format!(
                "slippage_over_limit: 市价滑点 {slippage_bps:.1}bps > {}bps",
                inputs.max_slippage_bps
            ));
        }
    }

    // ⑥ 数据新鲜度：由代码门先行把关（这里只要求调用方已通过 gate）。
    // ⑦ 时段 / 事件黑名单（**只禁开仓**：设计 §9.2 是"重大事件前后禁开仓窗口"，
    // 黑名单不该把降险动作一起关在门外）。
    if !is_reduce && inputs.blackout_active {
        reasons.push("blackout_active: 处于时段或重大事件黑名单窗口".to_string());
    }

    if reasons.is_empty() {
        Ok(ValidatedRound { plan })
    } else {
        Err(ValidationRejection { ok: false, reasons })
    }
}

// ===== §8.2 频率与预算 =====

/// 预算闸门的输入（全部由调用方从库/内存里取，纯判定）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BudgetInputs {
    pub now: i64,
    pub last_run_at: Option<i64>,
    pub min_wake_interval_seconds: u32,
    pub runs_last_hour: u32,
    pub max_runs_per_hour: u32,
    pub daily_pnl_pct: f64,
    pub max_daily_loss_pct: f64,
    pub open_and_pending: u32,
    pub max_concurrent: u32,
    pub actions_last_minute: u32,
    pub max_actions_per_minute: u32,
}

/// 命中预算 → 当轮**不判定**，记 `budget_exhausted`（返回原因码）。
pub fn budget_block(inputs: &BudgetInputs) -> Option<&'static str> {
    if let Some(last_run_at) = inputs.last_run_at {
        let elapsed_ms = inputs.now.saturating_sub(last_run_at);
        if elapsed_ms < i64::from(inputs.min_wake_interval_seconds) * 1_000 {
            return Some("min_interval");
        }
    }
    if inputs.runs_last_hour >= inputs.max_runs_per_hour {
        return Some("hourly_limit");
    }
    if inputs.max_daily_loss_pct > 0.0 && inputs.daily_pnl_pct <= -inputs.max_daily_loss_pct {
        return Some("daily_loss_limit");
    }
    if inputs.open_and_pending >= inputs.max_concurrent {
        return Some("concurrent_limit");
    }
    if inputs.actions_last_minute >= inputs.max_actions_per_minute {
        return Some("action_rate_limit");
    }
    None
}

// ===== C29.7 运行记录（六组）=====

/// `fastlane_json` 的六个分组（字段名与 C29.7 逐字对齐）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FastlaneRecord {
    pub record_kind: String,
    pub trigger: FastlaneTrigger,
    pub gate: GateOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jev: Option<FastlaneJev>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm: Option<FastlaneLlm>,
    pub action: FastlaneAction,
    /// 本轮动作分支的 intent 口径（侧车给）：`round` / `close`（停机平仓轮）/ `reduce`（Jev 判降险）。
    /// 动作体里的 `intent` 在两种降险里都是 `close`（Rust `action_intent` 只认那个），
    /// **靠这个字段把"用户停机命令"与"Jev 自判减仓"区分开**（缺省 = 老侧车，不写）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
    pub timing: FastlaneTiming,
    pub tokens: FastlaneTokens,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FastlaneTrigger {
    /// `condition` | `silence` | `manual`。
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FastlaneJev {
    /// 跳过时是 `"skipped"`（**不是**伪造的判定值）。
    pub action: String,
    /// 侧车给的原始动作串（保留原文，便于复盘口径漂移）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_raw: Option<String>,
    #[serde(default)]
    pub probabilities: Value,
    #[serde(default)]
    pub confidence: f64,
    /// **`quality` 是观察量（C29.18，2026-09-21）**：Jev 的问题面里已**不再有这一问**（换问法实验证明
    /// 它对"该不该做"没有可用判别力），入场质量改由代码判据决定（`gate.entryQuality`）。
    /// 记录里**保留**这个字段只为复盘：老记录 / 老侧车响应带它 → 照原样留痕；**缺失时字段不出现**
    /// （`Option` + `skip_serializing_if`，UI 显示 `--`），绝不写成 0.0 —— 那是编造。
    /// **它不参与任何判定**，也绝不再是"不动手 / abort"的理由。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<f64>,
    /// **打分臂留痕（C29 变更 B，2026-09-21）**：两个 0–4 期望分、判定用的门槛与判定依据。
    /// 这是"本轮观望是**代码按分数**判的，不是模型说观望"的唯一凭据（UI 直接渲染这几个字段）。
    /// 旧侧车 / 旧形状下全部缺省（序列化时整个字段不出现 —— 老记录形状不变）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub long_score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub short_score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_score_floor: Option<f64>,
    /// `direction`（argmax 给方向）/ `below_floor`（分数不足）/ `tie`（并列）/ `score_missing` /
    /// `legacy_action`（旧形状 action 优先，分数未参与判定）/**降险臂的码**（C29.14）：
    /// `reduce`（降险优先，本轮按降险动作） / `reduce_without_position` / `reduce_position_unknown`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_score_decision: Option<String>,
    /// **降险臂留痕（C29.14，2026-09-21）**：降险分 + 用的**降险门槛** + 降险口径 + 看到的持仓事实。
    /// `reduce_score_floor` 自 **C29.17** 起是**独立配置字段**（`fastlane_reduce_score_floor`）：
    /// **默认与 `entry_score_floor` 同值 1.5**（行为与解耦前逐字一致），但两者可分别调
    /// （降险比开仓更适合放宽）→ 落一份是"这一轮降险用的是哪条线"的唯一凭据，不再靠推断。
    /// 旧侧车 / 旧形状下全部缺省（字段不出现 —— 老记录形状不变）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reduce_score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reduce_score_floor: Option<f64>,
    /// `reduce`（判降险）/ `reduce_without_position` / `reduce_position_unknown`（该降险但没得减）
    /// / `below_floor`（未达门槛，降险不越权）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reduce_score_decision: Option<String>,
    /// 降险臂看到的持仓事实：`held` / `flat` / `unknown`（读不到 → 不猜、不降险）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reduce_position_fact: Option<String>,
    /// 置信度门的值来源：`action_node`（旧形状）/ `none`（打分臂无 action 节点 → 该门本轮不参与）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence_source: Option<String>,
    #[serde(default)]
    pub latency_ms: i64,
    /// Jev 重试次数（1 = 一次成功；跳过时是 0）。
    #[serde(default)]
    pub attempts: u32,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub raw: Value,
    /// `close` 轮侧车跳过 Jev（`intent="close"` 直通位）——记录里如实留痕。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub skipped: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Jev **未完成**时的错误原文（`action` 为空串）；只在实际失败时出现。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 失败分类元信息（侧车给的 HTTP 状态码与分类；原样落 `fastlane_json.jev`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_kind: Option<String>,
    /// 侧车给的**可行动**提示（`gate.anomaly` 优先取它）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FastlaneLlm {
    pub latency_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
    pub validation: ValidationRejection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opportunity_id: Option<String>,
    pub wake_conditions: u32,
    /// 侧车增量留痕：窄调用**实际下发**的模型名与重试次数（模型名传错这类问题一眼可见）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempts: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FastlaneAction {
    /// `watch` | `opportunity` | `kill_switch`。
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opportunity_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// 分段耗时（验收 P50 ≤ 3s 的唯一依据）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FastlaneTiming {
    pub fetch_ms: i64,
    pub jev_ms: i64,
    pub llm_ms: i64,
    pub code_ms: i64,
    pub total_ms: i64,
}

/// Jev 与 LLM 的 token 分开记。
///
/// **`null` 是合法值**（C29.7）：`close` 轮侧车**根本没执行 Jev**，它如实上报
/// `tokens.jevIn/jevOut = null`。这里保持 `Option<i64>` 并**原样落库**（JSON 里就是 `null`）——
/// 既不能当解析错误（那会让整轮记录失败），也不能伪造 `0`（那是在编造"Jev 消耗了 0 token"）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FastlaneTokens {
    pub jev_in: Option<i64>,
    pub jev_out: Option<i64>,
    pub llm_in: Option<i64>,
    pub llm_out: Option<i64>,
}

impl FastlaneRecord {
    pub fn new(trigger: FastlaneTrigger) -> Self {
        Self {
            record_kind: FASTLANE_RECORD_KIND.to_string(),
            trigger,
            gate: GateOutcome::pass(),
            jev: None,
            llm: None,
            action: FastlaneAction {
                kind: "watch".to_string(),
                opportunity_id: None,
                reason: None,
            },
            intent: None,
            timing: FastlaneTiming::default(),
            tokens: FastlaneTokens::default(),
        }
    }

    /// 观望（含数据/异常/冲突/置信度/质量/校验失败/预算耗尽等全部原因码）。
    pub fn watch(mut self, reason: &str) -> Self {
        self.action = FastlaneAction {
            kind: "watch".to_string(),
            opportunity_id: None,
            reason: Some(reason.to_string()),
        };
        self
    }

    /// 停机（一键停机命令写的就是这个）。
    pub fn kill_switch(mut self, reason: &str) -> Self {
        self.action = FastlaneAction {
            kind: "kill_switch".to_string(),
            opportunity_id: None,
            reason: Some(reason.to_string()),
        };
        self
    }

    /// 计划级但**非致命**的诊断（条件已照写，只是这件事要留痕）：目前只有
    /// `expiresAtMs` 失效 → 按「无到期」写入。**不改 `ok`、不改 `wakeConditions`**。
    pub fn note_wake_plan_notes(&mut self, notes: &[String]) {
        if let Some(llm) = self.llm.as_mut() {
            for note in notes {
                if !llm.validation.reasons.iter().any(|item| item == note) {
                    llm.validation.reasons.push(note.clone());
                }
            }
        }
    }

    pub fn with_action(mut self, kind: &str, opportunity_id: Option<String>) -> Self {
        self.action = FastlaneAction {
            kind: kind.to_string(),
            opportunity_id,
            reason: None,
        };
        self
    }

    /// **部分接受**：`wakeConditions` 记**真正写库**的条数，丢弃原因进 `llm.validation.reasons`
    /// （一条 timer 参数不合规不该废掉整份 plan，也不该静默）。
    ///
    /// **不动 `validation.ok`**（2026-09-21 裁决）：`ok` 是"这一轮的动作/参数是否被代码门接受"的
    /// 单一判据 —— 能跑到这里就说明已通过 `validate_round`。若因为"附加的观察条件里有一条被丢弃"
    /// 就翻成 `rejected`，运行记录会出现"运行 completed + LLM 拒绝"的自相矛盾。丢弃信息靠
    /// `reasons`（非空即渲染）表达，属诊断不属状态。
    pub fn note_wake_conditions_dropped(&mut self, written: usize, dropped: &[String]) {
        if let Some(llm) = self.llm.as_mut() {
            llm.wake_conditions = written.min(u32::MAX as usize) as u32;
            let reason = format!(
                "已丢弃 {} 条观察条件：{}",
                dropped.len(),
                dropped.join("；")
            );
            if !llm.validation.reasons.iter().any(|item| item == &reason) {
                llm.validation.reasons.push(reason);
            }
        }
    }

    /// **观察条件没写成**时如实留痕（真机 `run_1789927808343894000` 之前的整份拒绝形态）：
    /// 原因进 `llm.validation.reasons`、`wakeConditions` 归零（写库条数才是事实）、
    /// `validation.ok=false` 让人一眼看到"这一轮有东西没落地"。
    ///
    /// **不改 `action`/`trigger`/`gate`/`jev`/`llm.params`/`timing`**：判定与参数阶段的结果照旧，
    /// 整轮也不因此判失败（收尾方按 `completed` 写运行行）。
    pub fn note_wake_plan_rejected(&mut self, error: &str) {
        if let Some(llm) = self.llm.as_mut() {
            llm.validation.ok = false;
            llm.wake_conditions = 0;
            let reason = format!("观察条件未写入：{error}");
            if !llm.validation.reasons.iter().any(|item| item == &reason) {
                llm.validation.reasons.push(reason);
            }
        }
    }

    /// 挂上代码门结果（数据/异常/冲突/时段）。
    pub fn with_gate(mut self, gate: GateOutcome) -> Self {
        self.gate = gate;
        self
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or_else(|_| json!({}))
    }
}

/// 观望原因是否在冻结枚举里（记录/UI 都对得上）。
pub fn is_known_watch_reason(reason: &str) -> bool {
    FASTLANE_WATCH_REASONS.contains(&reason)
}

/// C29.7（冻结）：快判载荷里 `fastlaneConfig` 的键名是 **snake_case 前缀** ——
/// 侧车的 `normalizeFastlaneConfig` 读的就是 `source.fastlane_*`（缺键回落它自己的默认值）。
///
/// **注意两处边界形状不同、都冻结了**：
/// - Profile 线（UI ↔ Rust）：扁平 camelCase `fastlaneXxx`（见 `AiAgentProfileSummary` 的 flatten）；
/// - 快判载荷（Rust → 侧车）：本函数产出的 `fastlane_xxx`。
pub fn sidecar_config_value(config: &FastlaneConfig, llm_model: &str) -> Value {
    let config = config.clone().normalized();
    json!({
        // 侧车 `source.fastlane_llm_model || source.llmModel` 两者都空 → 整轮失败，必须显式给。
        "fastlane_llm_model": llm_model.trim(),
        "fastlane_style_preset": config.style_preset,
        "fastlane_style": config.style,
        "fastlane_risk_per_trade_pct": config.risk_per_trade_pct,
        "fastlane_max_daily_loss_pct": config.max_daily_loss_pct,
        "fastlane_max_concurrent": config.max_concurrent,
        "fastlane_max_slippage_bps": config.max_slippage_bps,
        "fastlane_max_actions_per_minute": config.max_actions_per_minute,
        "fastlane_quality_floor": config.quality_floor,
        // 变更 B（2026-09-21）：侧车 `decideEntryFromScores` 读的键（打分臂方向判定线）。
        "fastlane_entry_score_floor": config.entry_score_floor,
        // C29.17（2026-09-21）：降险臂**自己的**门槛（默认 1.5，与入场门槛解耦后仍同值）。
        "fastlane_reduce_score_floor": config.reduce_score_floor,
        "fastlane_confidence_floor": config.confidence_floor,
        "fastlane_event_blackout_minutes": config.event_blackout_minutes,
        "fastlane_trading_hours": config.trading_hours,
        "fastlane_notify_policy": config.notify_policy,
        "fastlane_jev_model": config.jev_model,
        "fastlane_jev_timeout_ms": config.jev_timeout_ms,
        "fastlane_llm_timeout_ms": config.llm_timeout_ms,
        // C29.3：侧车硬写死 `none`；这里透传同一个值（配置改 high 也不放开）。
        "fastlane_llm_reasoning_effort": config.llm_reasoning_effort,
        // 私有部署时可改的 Jev 端点（侧车有同一默认值）。
        "fastlane_jev_base_url": config.jev_base_url,
    })
}

// ===== 侧车 ↔ Rust 事件契约（C29.7 冻结：`fastlaneResult`）=====

/// 侧车 `fastlaneResult` 里的 `jev` 组（字段名逐字对齐冻结契约）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarJev {
    /// `close` 轮侧车跳过 Jev 时这里没有判定值（`skipped: true`）；
    /// Jev 失败时侧车写的是**显式 `null`**（不是缺键）→ 必须能解析。
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_raw: Option<String>,
    #[serde(default)]
    pub probabilities: Value,
    /// **`null` 是合法值**（变更 B 之后打分臂没有 action 节点 → 侧车不发/发 null）：
    /// 解析失败会让整轮记录丢失，所以这里按"容缺"读；记录里落 0.0（与既有缺键口径一致，
    /// "本轮到底有没有 action 置信度"由 `confidenceSource` 说话）。
    #[serde(default)]
    pub confidence: Option<f64>,
    #[serde(default)]
    pub quality: Option<f64>,
    /// C29 变更 B（2026-09-21）：打分臂的三个数值 + 判定依据（侧车 `normalizeJevVerdict` 产出）。
    /// **全部容缺**：旧侧车不写这些键 → `None`（记录里不出现该字段，行为不变）。
    #[serde(default)]
    pub long_score: Option<f64>,
    #[serde(default)]
    pub short_score: Option<f64>,
    #[serde(default)]
    pub entry_score_floor: Option<f64>,
    #[serde(default)]
    pub entry_score_decision: Option<String>,
    /// **C29.14（2026-09-21）降险臂**：降险分 / 降险自己的门槛 / 降险口径 / 持仓事实。**全部容缺**：
    /// 旧侧车不写这些键 → `None`（记录里不出现该字段，行为不变）。
    #[serde(default)]
    pub reduce_score: Option<f64>,
    #[serde(default)]
    pub reduce_score_floor: Option<f64>,
    #[serde(default)]
    pub reduce_score_decision: Option<String>,
    #[serde(default)]
    pub reduce_position_fact: Option<String>,
    /// 置信度门的**值来源**：`action_node`（旧形状）/ `none`（打分臂没有 action 节点 → 门不参与）。
    #[serde(default)]
    pub confidence_source: Option<String>,
    #[serde(default)]
    pub latency_ms: i64,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub raw: Value,
    /// C29.7（`fastlaneIntent` 直通位）：`close` 轮侧车**跳过 Jev** 时为 `true`。
    #[serde(default)]
    pub skipped: bool,
    /// 跳过原因（目前只有 `intent_close`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Jev **未完成**时的错误原文（侧车 `{action:null, error, latencyMs, attempts}` 形状）。
    #[serde(default)]
    pub error: Option<String>,
    /// 侧车给的失败分类元信息（`status`/`failureKind`/`hint`，全部原样落库）。
    ///
    /// `hint` 是侧车已经写好的**可行动文案**（例如"请在 设置 → AI 填写/更新 TypeSafe API Key"），
    /// `gate.anomaly` 优先用它；`status`/`failureKind` 只留痕，便于按类型统计失败率。
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(default)]
    pub failure_kind: Option<String>,
    #[serde(default)]
    pub hint: Option<String>,
}

/// 侧车 `fastlaneResult` 里的 `llm` 组。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarLlm {
    pub latency_ms: i64,
    #[serde(default)]
    pub params: Option<Value>,
    /// 窄调用 LLM 失败时侧车**只回 `{latencyMs, error, wakeConditions}`**（没有 `validation` 键）
    /// → 缺键按"未通过"落，错误原文进 `reasons`（见 [`FastlaneRecord::from_sidecar`]），不静默。
    #[serde(default)]
    pub validation: ValidationRejection,
    #[serde(default)]
    pub wake_conditions: u32,
    /// 下一轮观察条件（**侧车返回的那份**，Rust 直接落库，不重新生成）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_wake_plan: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opportunity_id: Option<String>,
    /// 窄调用 LLM 未完成时的错误原文。
    #[serde(default)]
    pub error: Option<String>,
    /// 窄调用的 HTTP 状态码与 provider 原文（侧车已脱敏；**原样落库以便诊断**）。
    ///
    /// 真机教训：只有 `窄调用 HTTP 400` 而没有 body 时无法定位（同一轮的根因是模型名传错）。
    /// 侧车把 `{status, raw/detail}` 带上来时，这里会把它们**脱敏 + 截断 ≤200 字符**后
    /// 拼进 `llm.validation.reasons`（见 [`llm_failure_reason`]）。
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub raw: Value,
    /// 侧车增量字段：窄调用的重试次数与**实际下发**的模型名（缺字段不影响解析）。
    #[serde(default)]
    pub attempts: Option<u32>,
    #[serde(default)]
    pub model: Option<String>,
}

/// 侧车 `fastlaneResult` 里的 `action` / `timing` / `tokens` 组。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarAction {
    pub kind: String,
    #[serde(default)]
    pub opportunity_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

/// 侧车 `timing` 组。
///
/// 侧车的初始形状就是 `{ jevMs: null, llmMs: null }`，并且**某些真实分支会让某一段保持 null**
/// （例如 Jev 失败提前返回时 `llmMs` 从未被写入；`close` 轮 `jevMs = 0` 是显式写的）。
/// 所以两段都必须能解析 `null`：`null` ≠ 解析失败，它是"这一段没有发生/没有上报"。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarTiming {
    #[serde(default)]
    pub jev_ms: Option<i64>,
    #[serde(default)]
    pub llm_ms: Option<i64>,
}

/// 侧车 `tokens` 组：**四个字段都可能是 `null`**（Jev 未执行 / LLM 未上报 usage）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarTokens {
    #[serde(default)]
    pub jev_in: Option<i64>,
    #[serde(default)]
    pub jev_out: Option<i64>,
    #[serde(default)]
    pub llm_in: Option<i64>,
    #[serde(default)]
    pub llm_out: Option<i64>,
}

/// 侧车 `fastlaneResult` 里的 `gate` 组（**侧车自己的门**：质量门 / 置信度门）。
///
/// 与本地代码门（数据新鲜度 / 时段）不是同一道门：本地门在**下发之前**就已经拦过（见
/// [`gate_blocks_round`]），而质量/置信度门由侧车在 Jev 之后判。变更 A 之后侧车会**照实上报**
/// 这道门的结果（`ok` 不许改写成 true），并带上作用域与豁免标注。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarGateOutcome {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub reasons: Vec<String>,
    /// 这道门作用于哪条路径（`open` = 只作用于开新仓）。
    #[serde(default)]
    pub applied_to: Option<String>,
    /// 这道门被谁豁免（`risk_reduction` = Jev 判减仓/平仓 → 降险不受质量/置信度门约束）。
    #[serde(default)]
    pub bypassed_for: Option<String>,
    /// **C29.18**：入场质量门（纯代码判据）的读数 —— 三条判据的取数 / 阈值 / 结论，**原样透传**进
    /// 记录（`gate.entryQuality`）。缺字段 = 老侧车（记录里不出现该字段，行为不变）。
    #[serde(default)]
    pub entry_quality: Option<Value>,
}

/// 侧车一轮快判的完整回传（`type: "fastlaneResult"`）。
///
/// Rust 侧只补它算不了的三样：`trigger`、`gate`（数据/冲突由本地代码门判定）、
/// `timing.fetchMs/codeMs/totalMs`。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FastlaneSidecarResult {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub jev: Option<SidecarJev>,
    #[serde(default)]
    pub llm: Option<SidecarLlm>,
    #[serde(default)]
    pub action: Option<SidecarAction>,
    #[serde(default)]
    pub timing: SidecarTiming,
    #[serde(default)]
    pub tokens: SidecarTokens,
    /// 侧车的质量/置信度门结果 + 降险豁免标注（缺字段 = 老侧车，行为不变）。
    #[serde(default)]
    pub gate: Option<SidecarGateOutcome>,
    /// 本轮动作分支的 intent 口径：`round`（开仓）/ `close`（停机平仓轮）/ `reduce`（Jev 判降险）。
    /// **停机轮与 Jev 自判降险在记录里必须可区分**，而两者的动作体 intent 都是 `close`。
    #[serde(default)]
    pub intent: Option<String>,
}

impl FastlaneRecord {
    /// 把侧车回传 + 本地代码门/计时组装成 `fastlane_json` 的六组。
    ///
    /// `total_ms` 用本地实测的四段之和（fetch + jev + llm + code）——
    /// 这是验收 P50 ≤ 3s 的口径；不采信侧车自己报的总时长。
    pub fn from_sidecar(
        trigger: FastlaneTrigger,
        gate: GateOutcome,
        result: &FastlaneSidecarResult,
        fetch_ms: i64,
        code_ms: i64,
    ) -> Self {
        let jev_ms = result
            .jev
            .as_ref()
            .map(|jev| jev.latency_ms)
            .or(result.timing.jev_ms)
            // 侧车没上报这一段 → 记 0（不是伪造判定：耗时口径 P50 只做加总）。
            .unwrap_or(0);
        let llm_ms = result
            .llm
            .as_ref()
            .map(|llm| llm.latency_ms)
            .or(result.timing.llm_ms)
            .unwrap_or(0);
        let action = result
            .action
            .as_ref()
            .map(|action| FastlaneAction {
                kind: action.kind.clone(),
                opportunity_id: action.opportunity_id.clone(),
                reason: action.reason.clone(),
            })
            .unwrap_or_else(|| FastlaneAction {
                kind: "watch".to_string(),
                opportunity_id: None,
                reason: Some("no_setup".to_string()),
            });
        Self {
            record_kind: FASTLANE_RECORD_KIND.to_string(),
            trigger,
            // 侧车的质量/置信度门结果 + 降险豁免标注（`ok` 保持侧车结论，绝不改写）。
            gate: merge_sidecar_gate(gate, result.gate.as_ref()),
            intent: result.intent.clone(),
            jev: result.jev.as_ref().map(|jev| FastlaneJev {
                // 跳过 Jev 时侧车只给 `{skipped:true, reason}`：这里如实落 `"skipped"`，
                // 绝不编造一个判定值（`timing.jevMs` 同理保持侧车给的 0）。
                // Jev 失败时侧车给 `{action:null, error}`：`action` 落空串、`error` 原样留痕。
                action: if jev.skipped {
                    "skipped".to_string()
                } else {
                    jev.action.clone().unwrap_or_default()
                },
                action_raw: jev.action_raw.clone(),
                probabilities: jev.probabilities.clone(),
                // `null`/缺键 → 0.0（既有缺键口径；是不是"没有 action 置信度"看 `confidenceSource`）。
                confidence: jev.confidence.unwrap_or(0.0),
                // **观察量（C29.18）**：侧车给什么落什么；缺失 → 字段不出现（UI 显示 `--`）——
                // 旧代码 `unwrap_or(0.0)` 会把"没这一问"显示成"质量 0 分"，那是编造。
                quality: jev.quality,
                // 打分臂留痕（变更 B）：侧车给什么落什么；旧侧车缺键 → `None`（字段不出现）。
                long_score: jev.long_score,
                short_score: jev.short_score,
                entry_score_floor: jev.entry_score_floor,
                entry_score_decision: jev.entry_score_decision.clone(),
                // 降险臂留痕（C29.14）：同上，全部容缺。
                reduce_score: jev.reduce_score,
                reduce_score_floor: jev.reduce_score_floor,
                reduce_score_decision: jev.reduce_score_decision.clone(),
                reduce_position_fact: jev.reduce_position_fact.clone(),
                confidence_source: jev.confidence_source.clone(),
                latency_ms: jev.latency_ms,
                attempts: jev.attempts,
                raw: jev.raw.clone(),
                skipped: jev.skipped,
                reason: jev.reason.clone(),
                error: jev.error.clone(),
                status: jev.status,
                failure_kind: jev.failure_kind.clone(),
                hint: jev.hint.clone(),
            }),
            llm: result.llm.as_ref().map(|llm| {
                // 侧车只在窄调用 LLM 失败时省略 `validation`；缺键 + `error` → 如实记未通过。
                // 错误明细（HTTP 状态码 + provider 原文）**脱敏 + 截断 ≤200 字符**后一并落库。
                let mut validation = llm.validation.clone();
                if let Some(error) = llm
                    .error
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    // provider 原文：`detail` 优先；否则取 `raw`（字符串直接用，对象序列化）。
                    let detail = llm
                        .detail
                        .clone()
                        .or_else(|| llm.raw.as_str().map(str::to_string))
                        .or_else(|| llm.raw.is_object().then(|| llm.raw.to_string()));
                    let reason = llm_failure_reason(error, llm.status, detail.as_deref());
                    if !validation.reasons.iter().any(|item| item == &reason) {
                        validation.reasons.push(reason);
                    }
                }
                FastlaneLlm {
                    latency_ms: llm.latency_ms,
                    params: llm.params.clone(),
                    validation,
                    opportunity_id: llm.opportunity_id.clone(),
                    wake_conditions: llm.wake_conditions,
                    model: llm.model.clone(),
                    attempts: llm.attempts,
                }
            }),
            action,
            timing: FastlaneTiming {
                fetch_ms,
                jev_ms,
                llm_ms,
                code_ms,
                total_ms: fetch_ms + jev_ms + llm_ms + code_ms,
            },
            // token 四格**原样透传**：侧车给 `null` 就落 `null`（`close` 轮的 Jev 未执行）。
            tokens: FastlaneTokens {
                jev_in: result.tokens.jev_in,
                jev_out: result.tokens.jev_out,
                llm_in: result.tokens.llm_in,
                llm_out: result.tokens.llm_out,
            },
        }
    }

    /// 下一轮观察条件（侧车返回的那份；缺省 → `None`，由调用方回落既有机制）。
    pub fn next_wake_plan(result: &FastlaneSidecarResult) -> Option<Value> {
        result
            .llm
            .as_ref()
            .and_then(|llm| llm.next_wake_plan.clone())
    }
}

/// 侧车在 Jev 失败时只给 `{ok:false, anomaly:true}`，其余数据/冲突判定由本地算。
///
/// **错误原文绝不吞掉**：侧车给的 `jev.error` / `llm.error` 要出现在 `gate.anomaly` 里
/// （真机 `Jev HTTP 403` 就是靠这条定位到"旧 Key 没被迁移"的）。
pub fn gate_from_sidecar_failure(
    result: &FastlaneSidecarResult,
    local: GateOutcome,
) -> GateOutcome {
    if result.ok {
        return local;
    }
    if !local.ok {
        return local;
    }
    let hint = result.jev.as_ref().and_then(|jev| jev.hint.as_deref());
    let error = result
        .jev
        .as_ref()
        .and_then(|jev| jev.error.as_deref())
        .or_else(|| result.llm.as_ref().and_then(|llm| llm.error.as_deref()));
    GateOutcome::anomaly_failed(sidecar_failure_text(hint, error))
}

/// 侧车质量/置信度门 → 记录里的 `gate`（**变更 A：可见性，不许静默**）。
///
/// 四条口径：
///   1. `ok` 用**合取**（本地门 ∧ 侧车门）：只会把 `true` 变成 `false`（多报一次没通过），
///      **永远不会把 `false` 改成 `true`** —— 后者才是伪造"门过了"；
///   2. 侧车的门原因码（`low_quality` / `low_confidence`）原样进 `gate.reasons`（复用既有渲染位）；
///   3. `appliedTo` / `bypassedFor` 原样搬过来；
///   4. 被降险豁免时在 `reasons` 里追加一条 `risk_reduction_gate_bypass` 标记
///      （"这一轮门没过、但因为是降险动作而放行"一眼可见，UI 的豁免 chip 读 `bypassedFor`）；
///   5. **C29.18**：`entryQuality`（入场质量门的读数）原样透传 —— Rust 不重算，也不改它的字段。
pub fn merge_sidecar_gate(local: GateOutcome, sidecar: Option<&SidecarGateOutcome>) -> GateOutcome {
    let Some(sidecar) = sidecar else { return local };
    let mut gate = local;
    gate.ok = gate.ok && sidecar.ok;
    if sidecar.applied_to.is_some() {
        gate.applied_to = sidecar.applied_to.clone();
    }
    if sidecar.bypassed_for.is_some() {
        gate.bypassed_for = sidecar.bypassed_for.clone();
    }
    if sidecar.entry_quality.is_some() {
        gate.entry_quality = sidecar.entry_quality.clone();
    }
    if !sidecar.ok {
        for reason in &sidecar.reasons {
            if !gate.reasons.iter().any(|item| item == reason) {
                gate.reasons.push(reason.clone());
            }
        }
    }
    if sidecar.bypassed_for.as_deref() == Some("risk_reduction") {
        let marker = "risk_reduction_gate_bypass".to_string();
        if !gate.reasons.iter().any(|item| item == &marker) {
            gate.reasons.push(marker);
        }
    }
    gate
}

/// provider/侧车错误明细的**落库上限**（`llm.validation.reasons` 里那一条的长度）。
pub const FASTLANE_ERROR_DETAIL_MAX_CHARS: usize = 200;

/// 错误明细 → 可落库的一行：**脱敏 → 压平空白 → 截断 ≤200 字符**。
///
/// 脱敏针对"provider 回显了凭据"这类情况（`Bearer …` / `sk-…` / 超长疑似令牌），
/// 侧车自己也做了一次 `redact`，这里是落库前的第二道闸（纵深防御，不是替代）。
pub fn sanitize_error_detail(text: &str) -> String {
    let mut redacted = String::with_capacity(text.len());
    for (index, token) in text.split_whitespace().enumerate() {
        if index > 0 {
            redacted.push(' ');
        }
        let lower = token.to_ascii_lowercase();
        let looks_like_secret = lower.starts_with("sk-")
            || lower.starts_with("bearer")
            || token.len() >= 32
                && token
                    .chars()
                    .all(|item| item.is_ascii_alphanumeric() || "+/=_-".contains(item));
        if looks_like_secret {
            redacted.push_str("****");
        } else {
            redacted.push_str(token);
        }
    }
    let redacted = redacted.trim();
    if redacted.chars().count() <= FASTLANE_ERROR_DETAIL_MAX_CHARS {
        return redacted.to_string();
    }
    let kept = redacted
        .chars()
        .take(FASTLANE_ERROR_DETAIL_MAX_CHARS.saturating_sub(1))
        .collect::<String>();
    format!("{kept}…")
}

/// 窄调用失败 → `llm.validation.reasons` 里那一条：
/// `"窄调用 HTTP 400：model not found"`（带得上的话附上状态码与 provider 原文）。
pub fn llm_failure_reason(error: &str, status: Option<u16>, detail: Option<&str>) -> String {
    let mut text = error.trim().to_string();
    if let Some(status) = status.filter(|status| (100..600).contains(status)) {
        if http_status_in(&text).is_none() {
            text = format!("{text}（HTTP {status}）");
        }
    }
    if let Some(detail) = detail.map(str::trim).filter(|value| !value.is_empty()) {
        let detail = sanitize_error_detail(detail);
        if !detail.is_empty() && !text.contains(&detail) {
            text = format!("{text}：{detail}");
        }
    }
    sanitize_error_detail(&text)
}

/// 侧车失败 → `gate.anomaly` 文案：**`hint`（侧车写好的可行动文案）优先，其次 `error` 原文**；
/// 两者都缺时才回退到泛化文案（"侧车判定失败（jev/llm 未完成）"会让用户无从下手）。
///
/// `hint` 由侧车给（见 `jev.hint`）；旧侧车只给 `"Jev HTTP 403"` 这类裸错误码时，
/// 这里把鉴权类（401/403）映射成与新版侧车同一句可行动文案，**错误码仍然留在文本里**。
pub fn sidecar_failure_text(hint: Option<&str>, error: Option<&str>) -> String {
    if let Some(hint) = hint.map(str::trim).filter(|value| !value.is_empty()) {
        return hint.to_string();
    }
    let Some(error) = error.map(str::trim).filter(|value| !value.is_empty()) else {
        return "侧车判定失败（jev/llm 未完成）".to_string();
    };
    match http_status_in(error) {
        Some(status @ (401 | 403)) => {
            format!("Jev 鉴权失败（HTTP {status}）：请在 设置 → AI 填写/更新 TypeSafe API Key")
        }
        _ => format!("侧车判定失败（jev/llm 未完成）：{error}"),
    }
}

/// 从侧车错误文本里取 HTTP 状态码（`"Jev HTTP 403"` / `"403 Forbidden"` 都能认）。
fn http_status_in(error: &str) -> Option<u16> {
    let tokens = error
        .split(|item: char| !item.is_ascii_alphanumeric())
        .map(|item| item.to_ascii_lowercase())
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>();
    for (index, token) in tokens.iter().enumerate() {
        if token == "http" {
            if let Some(status) = tokens
                .get(index + 1)
                .and_then(|next| next.parse::<u16>().ok())
                .filter(|status| (100..600).contains(status))
            {
                return Some(status);
            }
        }
    }
    for status in [401u16, 403] {
        if tokens.iter().any(|token| token == &status.to_string()) {
            return Some(status);
        }
    }
    None
}

// ===== B1：常驻快照采集器（registry + 生命周期，全部可注入替身）=====
//
// 采集器由**三段**组成，边界刻意画清：
// ① `FastlaneSnapshotRegistry`（本文件）= 存与判 + 生命周期记账，**不含任何 IO**；
// ② 节拍任务/公开订阅/既有读函数 → `ai_automation` 的生产实现（`AppHandle` + `MarketRuntime`）；
// ③ 测试替身 = 计数句柄（不依赖真实 WS/Tokio）。
//
// 生命周期不变式（B3 的验收点，见 `registry_*` 单测）：
// - `len() == 活跃快判 Profile 数`；
// - 停机后 `owned_stream_count() == 0`（**只释放自己起的订阅**，复用的图表订阅一律不动）；
// - 停机后 `dangling_beat_count() == 0`（没有"起了任务没人停"）。

/// 节拍任务句柄。真实实现包着 Tokio 任务；测试用计数替身。
pub trait FastlaneBeatHandle: Send + Sync {
    /// 幂等停止：第一次返回 `true`（这次确实停了），之后返回 `false`。
    fn stop(&self) -> bool;
    /// 是否已停（泄漏回归测试据此断言"无悬挂任务句柄"）。
    fn is_stopped(&self) -> bool;
}

/// 自起公开订阅的租约（`owns_public_stream = true` 时才有）。
pub trait FastlaneStreamLease: Send + Sync {
    /// 幂等释放：第一次返回 `true`（这次确实退订了）。
    fn release(&self) -> bool;
    fn is_released(&self) -> bool;
}

/// 采集器每个 tick 写入的一块数据（值 + **来源时间**）。
pub enum FastlaneBlock {
    Ticker(SnapshotSlot<Value>),
    Orderbook(SnapshotSlot<Value>),
    Candles1m(SnapshotSlot<Vec<Value>>),
    Derivatives(SnapshotSlot<Value>),
    Account(SnapshotSlot<Value>),
}

impl FastlaneBlock {
    /// 该块的来源时间（写库前不必解构）。
    pub fn at_ms(&self) -> i64 {
        match self {
            FastlaneBlock::Ticker(slot) => slot.at_ms,
            FastlaneBlock::Orderbook(slot) => slot.at_ms,
            FastlaneBlock::Candles1m(slot) => slot.at_ms,
            FastlaneBlock::Derivatives(slot) => slot.at_ms,
            FastlaneBlock::Account(slot) => slot.at_ms,
        }
    }

    fn apply(self, cache: &mut FastlaneSnapshotCache) {
        match self {
            FastlaneBlock::Ticker(slot) => cache.ticker = Some(slot),
            FastlaneBlock::Orderbook(slot) => cache.orderbook = Some(slot),
            FastlaneBlock::Candles1m(slot) => cache.candles_1m = Some(slot),
            FastlaneBlock::Derivatives(slot) => cache.derivatives = Some(slot),
            FastlaneBlock::Account(slot) => cache.account = Some(slot),
        }
    }
}

/// 一个 Profile 的采集条目。
pub struct FastlaneSnapshotEntry {
    pub account_id: String,
    pub inst_id: String,
    pub cache: FastlaneSnapshotCache,
    /// 合约规格：采集器起时取一次（静态元数据，不需要每秒读）。
    pub instrument: StateInstrument,
    /// 该 inst 是否**复用**图表消费者的订阅（复用时 registry 不持有租约）。
    pub reuses_chart_stream: bool,
    beat: Box<dyn FastlaneBeatHandle>,
    lease: Option<Box<dyn FastlaneStreamLease>>,
}

/// 快判快照 registry（挂 `AiAutomationRuntime`，每个活跃快判 Profile 一条）。
#[derive(Default)]
pub struct FastlaneSnapshotRegistry {
    entries: HashMap<String, FastlaneSnapshotEntry>,
}

impl FastlaneSnapshotRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn contains(&self, profile_id: &str) -> bool {
        self.entries.contains_key(profile_id)
    }

    /// 活跃 Profile id（排序，便于断言与日志）。
    pub fn active_profile_ids(&self) -> Vec<String> {
        let mut ids = self.entries.keys().cloned().collect::<Vec<_>>();
        ids.sort();
        ids
    }

    pub fn entry(&self, profile_id: &str) -> Option<&FastlaneSnapshotEntry> {
        self.entries.get(profile_id)
    }

    pub fn cache(&self, profile_id: &str) -> Option<&FastlaneSnapshotCache> {
        self.entries.get(profile_id).map(|entry| &entry.cache)
    }

    /// 起一份采集器（**已经存在就什么都不做**，并把这次传进来的句柄立刻收掉，
    /// 否则就是"起了任务没人停"的泄漏——这正是 B3 要防的状态）。
    ///
    /// 返回值：`true` = 本次真的起了；`false` = 已存在（调用方应视为无操作）。
    /// inst 变化（Profile 改品种）由调用方先 [`Self::release`] 再 `ensure`。
    pub fn ensure(
        &mut self,
        profile_id: &str,
        account_id: impl Into<String>,
        inst_id: impl Into<String>,
        instrument: StateInstrument,
        reuses_chart_stream: bool,
        owns_public_stream: bool,
        beat: Box<dyn FastlaneBeatHandle>,
        lease: Option<Box<dyn FastlaneStreamLease>>,
    ) -> bool {
        if self.entries.contains_key(profile_id) {
            beat.stop();
            if let Some(lease) = lease {
                lease.release();
            }
            return false;
        }
        let mut cache = FastlaneSnapshotCache::new(account_id.into(), inst_id.into());
        cache.owns_public_stream = owns_public_stream;
        self.entries.insert(
            profile_id.to_string(),
            FastlaneSnapshotEntry {
                account_id: cache.account_id.clone(),
                inst_id: cache.inst_id.clone(),
                cache,
                instrument,
                reuses_chart_stream,
                beat,
                lease,
            },
        );
        true
    }

    /// 写入一块（条目不存在 → 忽略；采集器可能在停机竞态里多跑一拍）。
    pub fn write(&mut self, profile_id: &str, block: FastlaneBlock) -> bool {
        let Some(entry) = self.entries.get_mut(profile_id) else {
            return false;
        };
        block.apply(&mut entry.cache);
        true
    }

    /// 写入 5 分钟主动买卖比（`None` = 窗口内无成交 → 覆盖旧值，避免拿旧读数当现值）。
    pub fn set_taker_ratio(&mut self, profile_id: &str, ratio: Option<f64>) -> bool {
        let Some(entry) = self.entries.get_mut(profile_id) else {
            return false;
        };
        entry.cache.taker_buy_ratio_5m = ratio.filter(|value| value.is_finite());
        true
    }

    /// 释放：① 停节拍任务 ② 释放（**只释放自己起的**）公开订阅 ③ 从 registry 摘除。
    ///
    /// 幂等：第二次调用返回 `false`、不做任何事。三道顺序固定，任何一条失败都不影响其余两条。
    pub fn release(&mut self, profile_id: &str) -> bool {
        let Some(mut entry) = self.entries.remove(profile_id) else {
            return false;
        };
        if entry.cache.release_public_stream() {
            if let Some(lease) = entry.lease.take() {
                lease.release();
            }
        }
        entry.beat.stop();
        true
    }

    /// 全部释放（应用退出 / 总开关关闭）。
    pub fn release_all(&mut self) -> usize {
        let ids = self.entries.keys().cloned().collect::<Vec<_>>();
        ids.iter().filter(|id| self.release(id)).count()
    }

    /// 停机后仍持有自有订阅的条目数（泄漏回归断言点）。
    pub fn owned_stream_count(&self) -> usize {
        self.entries
            .values()
            .filter(|entry| entry.cache.owns_public_stream)
            .count()
    }

    /// 仍在跑（未停）的任务句柄数（泄漏回归断言点）。
    pub fn dangling_beat_count(&self) -> usize {
        self.entries
            .values()
            .filter(|entry| !entry.beat.is_stopped())
            .count()
    }
}

/// 5 分钟主动买卖比窗口（**实时成交流**，设计 §4 的 `micro.taker_buy_ratio_5m`）。
///
/// 采集器每一拍把成交流里的新成交喂进来（按 `tradeId` 去重），窗口固定 5 分钟。
/// 窗口内一笔都没有 → `None`（**不给 0**：0 会被读成"全是卖"）。
#[derive(Default)]
pub struct TakerWindow {
    trades: VecDeque<(i64, String, f64, f64)>,
    seen: HashSet<String>,
    buy_size: f64,
    sell_size: f64,
}

impl TakerWindow {
    pub const WINDOW_MS: i64 = 300_000;

    pub fn new() -> Self {
        Self::default()
    }

    /// 喂一笔成交（`side` 为 `buy`/`sell`；未知方向不计入）。返回是否是新成交。
    pub fn observe(&mut self, ts: i64, trade_id: &str, side: &str, size: f64) -> bool {
        if !(size.is_finite() && size > 0.0) || ts <= 0 {
            return false;
        }
        let signed = match side.trim().to_ascii_lowercase().as_str() {
            "buy" => 1.0,
            "sell" => -1.0,
            _ => return false,
        };
        let key = if trade_id.trim().is_empty() {
            format!("{ts}:{side}:{size}")
        } else {
            trade_id.trim().to_string()
        };
        if !self.seen.insert(key.clone()) {
            return false;
        }
        self.trades.push_back((ts, key, signed, size));
        if signed > 0.0 {
            self.buy_size += size;
        } else {
            self.sell_size += size;
        }
        true
    }

    /// 批量喂入（`trades_by_inst` 的 JSON 形态：`tradeId`/`side`/`sz`/`ts`）。返回新增笔数。
    pub fn observe_trades(&mut self, trades: &[Value]) -> usize {
        let mut added = 0;
        for trade in trades {
            let ts = pick_i64(trade, &["ts", "timestamp"]).unwrap_or(0);
            let size = pick_number(trade, &["sz", "size"]).unwrap_or(0.0);
            let side = trade.get("side").and_then(Value::as_str).unwrap_or("");
            let id = trade
                .get("tradeId")
                .or_else(|| trade.get("trade_id"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if self.observe(ts, id, side, size) {
                added += 1;
            }
        }
        added
    }

    /// 窗口内主动买占比（窗口为空 → `None`；同时按 `now_ms` 淘汰过期成交）。
    pub fn ratio(&mut self, now_ms: i64) -> Option<f64> {
        self.prune(now_ms);
        let total = self.buy_size + self.sell_size;
        (total > 0.0).then_some(self.buy_size / total)
    }

    /// 窗口内最新一笔成交时间（`None` = 窗口是空的）。
    pub fn latest_ts(&self) -> Option<i64> {
        self.trades.back().map(|(ts, _, _, _)| *ts)
    }

    pub fn len(&self) -> usize {
        self.trades.len()
    }

    pub fn is_empty(&self) -> bool {
        self.trades.is_empty()
    }

    fn prune(&mut self, now_ms: i64) {
        let cutoff = now_ms.saturating_sub(Self::WINDOW_MS);
        while let Some((ts, _, _, _)) = self.trades.front() {
            if *ts >= cutoff {
                break;
            }
            let Some((_, key, signed, size)) = self.trades.pop_front() else {
                break;
            };
            self.seen.remove(&key);
            if signed > 0.0 {
                self.buy_size = (self.buy_size - size).max(0.0);
            } else {
                self.sell_size = (self.sell_size - size).max(0.0);
            }
        }
    }
}

/// 采集器落槽时的**来源时间口径**（C29 约束 c 的执行点）：
/// ① 缺失（`<= 0`）→ `0`（不可用，绝不用 now 顶替来源时间）；
/// ② 交易所/账户时间略微"超前"本机（时钟偏移 ≤ 5s）→ 夹到 `now`（不因此判过期）；
/// ③ 超前超过 5s → `0`（时间戳不可信 → 不可用），避免"未来时间"看起来永远新鲜。
pub fn snapshot_source_time(source_at_ms: i64, now_ms: i64) -> i64 {
    const MAX_SKEW_MS: i64 = 5_000;
    if source_at_ms <= 0 {
        return 0;
    }
    if source_at_ms > now_ms {
        return if source_at_ms - now_ms <= MAX_SKEW_MS {
            now_ms
        } else {
            0
        };
    }
    source_at_ms
}

/// 1m K 线 JSON（`Candle` 序列化形态：`time/open/high/low/close/volume`）→ [`Bar`]。
///
/// 只取**已收盘**（`confirm == true`）的部分；没有 `confirm` 键的旧形态按已收盘处理
/// （结构/ATR 用未收盘的最后一根会给出会漂移的读数）。
pub fn bars_from_values(values: &[Value]) -> Vec<Bar> {
    values
        .iter()
        .filter(|value| {
            value
                .get("confirm")
                .and_then(Value::as_bool)
                .unwrap_or(true)
        })
        .filter_map(|value| {
            let bar = Bar {
                t: pick_i64(value, &["time", "ts", "openTimeMs"])?,
                o: pick_f64(value, &["open"])?,
                h: pick_f64(value, &["high"])?,
                l: pick_f64(value, &["low"])?,
                c: pick_f64(value, &["close"])?,
                v: pick_f64(value, &["volume", "vol"]).unwrap_or(0.0),
            };
            (bar.t > 0).then_some(bar)
        })
        .collect()
}

/// 最后一个**已收盘** 1m K 线的收盘时刻（`candles_1m_closed` 的来源时间）。
pub fn last_closed_candle_close_ms(values: &[Value]) -> Option<i64> {
    bars_from_values(values).last().map(|bar| bar.t + 60_000)
}

/// §4 装配的便捷入口：常驻缓存 → [`SnapshotInputs`] → [`assemble_snapshot`]。
pub fn assemble_from_cache(
    cache: &FastlaneSnapshotCache,
    instrument: &StateInstrument,
    limits: StateLimits,
    events: Vec<StateEvent>,
    recent: Vec<StateRecentAction>,
    as_of_ms: i64,
) -> FastlaneSnapshot {
    assemble_snapshot(
        &SnapshotInputs {
            inst_id: cache.inst_id.clone(),
            ticker: cache.ticker.clone(),
            orderbook: cache.orderbook.clone(),
            candles_1m: cache
                .candles_1m
                .as_ref()
                .map(|slot| SnapshotSlot::new(bars_from_values(&slot.value), slot.at_ms)),
            derivatives: cache.derivatives.clone(),
            account: cache.account.clone(),
            taker_buy_ratio_5m: cache.taker_buy_ratio_5m,
            instrument: instrument.clone(),
            limits,
            events,
            recent,
        },
        as_of_ms,
    )
}

/// ticker 读取结果 → §4 `price` 块 + 来源时间（`ticker.ts`）。
///
/// 交易所 ticker 只给 `last/open24h/high24h/low24h`：
/// - 24h 涨跌由 `last` 与 `open24h` 直接算（同一份快照 → 时间戳自洽）；
/// - 5m / 1h 涨跌由 **1m K 线**算（设计 §3：多周期由 1m 聚合）。
///
/// 算不出来就留 `null`（**不给 0**：0 会被读成"完全没动"）。
pub fn normalize_ticker_block(value: &Value, bars_1m: &[Bar]) -> Option<(Value, i64)> {
    let ticker = value.get("ticker").unwrap_or(value);
    let last = pick_number(ticker, &["last", "lastPx"])?;
    let open_24h = pick_number(ticker, &["open24h", "open24HPx"]);
    let at_ms = pick_i64(ticker, &["ts"]).unwrap_or(0);
    let change_from_bar = |bars_back: usize| -> Option<f64> {
        if bars_1m.len() <= bars_back {
            return None;
        }
        let reference = bars_1m[bars_1m.len() - 1 - bars_back].c;
        (reference > 0.0).then_some((last - reference) / reference * 100.0)
    };
    Some((
        json!({
            "last": last,
            "chg5mPct": change_from_bar(5),
            "chg1hPct": change_from_bar(60),
            "chg24hPct": open_24h
                .filter(|open| *open > 0.0)
                .map(|open| (last - open) / open * 100.0),
            "high24h": pick_number(ticker, &["high24h", "high24HPx"]),
            "low24h": pick_number(ticker, &["low24h", "low24HPx"]),
            "open24h": open_24h,
            "ts": at_ms,
        }),
        at_ms,
    ))
}

/// 账户读取结果 → §4 `account` 块 + **账户快照时间**（`syncedAt`）。
///
/// 接受两种既有形态（映射表见 [`SnapshotInputs`] 的注释）：
/// - `ai_account_snapshot_tool_value` 的 `{ balanceSemantics:{usdtEquity,availableUsdt}, snapshot:{…} }`；
/// - `PrivateAccountSnapshot` 的直出 `{ balances, positions, orders, syncedAt }`。
///
/// **手数/持仓/挂单逐个字段抄，不做任何推算**：拿不到就是空数组。
pub fn normalize_account_block(value: &Value) -> Option<(Value, i64)> {
    let snapshot = value.get("snapshot").unwrap_or(value);
    let semantics = value.get("balanceSemantics");
    let equity = semantics
        .and_then(|item| pick_f64(item, &["usdtEquity"]))
        .or_else(|| pick_f64(value, &["usdtEquity", "equityUsdt"]))
        .or_else(|| pick_f64(snapshot, &["usdtEquity", "equityUsdt"]));
    let available = semantics
        .and_then(|item| pick_f64(item, &["availableUsdt"]))
        .or_else(|| pick_f64(value, &["availableUsdt"]))
        .or_else(|| pick_f64(snapshot, &["availableUsdt"]));
    let positions = snapshot
        .get("positions")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(normalize_position)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let open_orders = snapshot
        .get("openOrders")
        .or_else(|| snapshot.get("orders"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(normalize_open_order)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let at_ms = pick_i64(value, &["syncedAt", "synced_at"])
        .or_else(|| pick_i64(snapshot, &["syncedAt", "synced_at"]))
        .unwrap_or(0);
    // 连权益和来源时间都拿不到 → 这一块不可用（不塞 0）。
    if equity.is_none() && available.is_none() && at_ms <= 0 {
        return None;
    }
    Some((
        json!({
            "usdtEquity": equity.unwrap_or(f64::NAN),
            "availableUsdt": available.unwrap_or(f64::NAN),
            "snapshot": { "positions": positions, "openOrders": open_orders }
        }),
        at_ms,
    ))
}

fn normalize_position(value: &Value) -> Option<Value> {
    let inst_id = value
        .get("instId")
        .or_else(|| value.get("inst_id"))
        .and_then(Value::as_str)?;
    // OKX 的 `uplRatio` 是**比率**（0.0123），§4 的 `uplPct` 是百分数。
    let upl_pct = pick_number(value, &["uplRatioPct", "uplPct"])
        .or_else(|| pick_number(value, &["uplRatio", "upl_ratio"]).map(|ratio| ratio * 100.0));
    Some(json!({
        "instId": inst_id,
        "posSide": value
            .get("posSide")
            .or_else(|| value.get("pos_side"))
            .and_then(Value::as_str)
            .unwrap_or("net"),
        "pos": pick_number(value, &["pos", "size"]).unwrap_or(f64::NAN),
        "avgPx": pick_number(value, &["avgPx", "avg_px"]).unwrap_or(f64::NAN),
        "uplRatioPct": upl_pct.unwrap_or(0.0),
        "stopPx": pick_f64(value, &["stopPx", "slTriggerPx"]),
    }))
}

fn normalize_open_order(value: &Value) -> Option<Value> {
    Some(json!({
        "side": value.get("side").and_then(Value::as_str)?,
        "px": pick_number(value, &["px", "price"])?,
        "sz": pick_number(value, &["sz", "size"])?,
        "state": value
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("live")
    }))
}

/// 资金费率读取结果 → §4 `derivatives` 块 + 来源时间。
///
/// `ai_funding_rate_value` 把 `fundingRate` 包成对象（`{ fundingRate: { fundingRate, ts, … } }`），
/// 这里摊平成 §4 的数值字段。**没有既有实时来源的字段留 `null`**
/// （mark/index/basis/OI 的公开 WS 通道本应用未订阅；C29 明令不得自造 REST 端点）。
/// `derivatives` 的来源时间口径（**冻结**，C29.7 补充 —— 真机第三轮暴露）：
///
/// 这是**推送/桶粒度**数据（OKX funding-rate 推送 30–60s、OI 快照分钟级、落库粒度 5 分钟），
/// 天生不可能满足秒级门限。因此：
/// 1. **有**交易所推送/数据时间 `ts`（且不超前）→ 用它（真实来源时间，`data_age_ms` 反映推送延迟）；
/// 2. **没有** `ts`（只有桶/结算时间或没有时间）→ 用**采集时刻** `now_ms`：此刻我们从既有读路径
///    真的取到了这份桶数据；
/// 3. **无论走哪条**，交易所给的桶时间都原样落进 `bucketAtMs`，让"这份数据本身有多旧"
///    始终可审计（口径一致、可解释，不靠门限猜）。
/// 门限相应按桶粒度取 [`DEFAULT_MAX_DATA_AGE_MS`]（`derivatives = 360_000`）。
pub fn normalize_derivatives_block(value: &Value, now_ms: i64) -> Option<(Value, i64)> {
    let funding = value.get("fundingRate").unwrap_or(value);
    let rate = funding
        .as_f64()
        .or_else(|| {
            funding
                .as_str()
                .and_then(|item| item.trim().parse::<f64>().ok())
        })
        .or_else(|| pick_number(funding, &["fundingRate"]))
        .or_else(|| pick_number(value, &["fundingRate"]));
    let next_ms = pick_i64(value, &["fundingNextMs", "nextFundingTime"])
        .or_else(|| pick_i64(funding, &["fundingNextMs", "nextFundingTime"]))
        .unwrap_or(0);
    let rate = rate.filter(|item| item.is_finite())?;
    // 交易所给的桶时间（推送/数据时间 → 退化到结算时间；两者都可能是"下一期"这种未来值）。
    let bucket_at = pick_i64(funding, &["ts", "bucketAtMs"])
        .or_else(|| pick_i64(value, &["ts", "bucketAtMs"]))
        .or_else(|| pick_i64(funding, &["fundingTime", "nextFundingTime"]))
        .unwrap_or(0);
    // 只有**过去**的桶时间才能当来源时间；超前的（下一期结算时间）不是来源时间 → 用采集时刻。
    let source_at = if bucket_at > 0 && bucket_at <= now_ms {
        bucket_at
    } else {
        now_ms
    };
    Some((
        json!({
            "fundingRate": rate,
            "fundingNextMs": next_ms,
            "bucketAtMs": if bucket_at > 0 { json!(bucket_at) } else { Value::Null },
            "markPx": Value::Null,
            "idxPx": Value::Null,
            "basisPct": Value::Null,
            "oiUsd": Value::Null,
            "oiChange1hPct": Value::Null
        }),
        source_at,
    ))
}

/// `fastlane_notify_policy` 的**执行点**（C29.7：`every_action | on_open_close | none`）。
///
/// - `none`：不发通知；
/// - `on_open_close`：只在**开平仓**（`action.kind == "opportunity"`）通知，观望不打扰；
/// - `every_action`：每轮都通知（含观望，用于调参与盯盘）。
pub fn fastlane_notify_allows(policy: &str, action_kind: &str) -> bool {
    match policy.trim().to_ascii_lowercase().as_str() {
        "none" => false,
        "every_action" => true,
        _ => action_kind == "opportunity",
    }
}

/// §8.1-7 的**事件黑名单执行点**：重大事件前后 `blackout_minutes` 内禁**开仓**
/// （降险动作不受影响，见 [`validate_round`] 的 `is_reduce` 分支）。
///
/// 只有"重要级"事件（`high`/`important`/`urgent`/`重要`/`高`，或重要级缺失）才算；
/// 明确的低重要级不拦。`blackout_minutes == 0` → 关。
pub fn event_blackout_active(events: &[StateEvent], now_ms: i64, blackout_minutes: u32) -> bool {
    if blackout_minutes == 0 {
        return false;
    }
    let window = i64::from(blackout_minutes) * 60_000;
    events.iter().any(|event| {
        let importance = event.importance.trim().to_ascii_lowercase();
        let blocking = importance.is_empty()
            || matches!(
                importance.as_str(),
                "high" | "important" | "urgent" | "重要" | "高"
            );
        blocking && event.at > 0 && now_ms.saturating_sub(event.at).abs() <= window
    })
}

// ===== B4：触发块 / 动作参数适配 / 下一轮观察条件 =====

/// 触发源（C29.7 冻结：`condition | silence | manual`）。
pub fn trigger_source(trigger_type: &str) -> &'static str {
    match trigger_type {
        "wake_condition" => "condition",
        "schedule" => "silence",
        _ => "manual",
    }
}

/// 触发块：**由运行行 + trigger_json 事实组装**，不做任何推断。
pub fn trigger_block(trigger_type: &str, trigger: &Value) -> FastlaneTrigger {
    let source = trigger_source(trigger_type).to_string();
    let condition_type = trigger
        .get("conditionType")
        .or_else(|| trigger.get("condition_type"))
        .or_else(|| trigger.get("source"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let params = trigger
        .get("conditionIds")
        .or_else(|| trigger.get("dueAt"))
        .map(|_| trigger.clone());
    FastlaneTrigger {
        source,
        condition_type,
        params,
    }
}

/// 动作体允许的键（**白名单，严格适配**）：
/// 侧车窄调用 LLM 的 snake_case 动作形态 + 既有工具参数的 camelCase 形态。
/// 出现白名单以外的键 → 直接拒绝（不得静默忽略，否则"模型写了错字段"会变成"按默认值执行"）。
pub const FASTLANE_ACTION_KEYS: [&str; 27] = [
    // 侧车动作形态（snake_case）
    "intent",
    "direction",
    "order_type",
    "entry_px",
    "stop_px",
    "tp",
    "size",
    // 扁平张数（旧形状）：与嵌套 `size.contracts` 二选一，两条真实形状都认。
    "sizeContracts",
    // 注意：**没有 `leverage`**。模型自报的杠杆不是执行参数（[`FastlanePlan`] 里没有杠杆），
    // 执行杠杆恒取自 Profile 的 `target_leverage`；把自报值当输入收下就等于给"模型改杠杆"开门。
    "margin_mode",
    "invalidation",
    "invalidation_price",
    "reason_tags",
    "confidence",
    "exit_kind",
    "summary",
    // 既有工具形态（camelCase）
    "orderType",
    "price",
    "takeProfit",
    "stopLoss",
    "tdMode",
    "lever",
    "invalidationPrice",
    "reasonTags",
    "riskNotes",
    "evidence",
    "exitKind",
    "reason",
];

/// 动作类型（`open` | `close` | `cancel` | `amend`）。
pub fn action_intent(params: &Value) -> Option<String> {
    params
        .get("intent")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| matches!(value.as_str(), "open" | "close" | "cancel" | "amend"))
}

/// 校验需要的事实（全部来自实时快照与合约规格；**没有就拒绝，不猜**）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlanFacts {
    pub last_price: f64,
    /// 合约面值（基础币/张），用于把张数换成风险金额。
    pub ct_val: f64,
    pub equity_usdt: f64,
    /// 结构失效位（state 的 `structure.tf_1h.last_swing_low/high`，缺失时用 15m）。
    pub structure_low: Option<f64>,
    pub structure_high: Option<f64>,
}

fn type_error(reasons: &mut Vec<String>, field: &str, expected: &str) {
    reasons.push(format!("field_type_invalid: {field} 必须是{expected}"));
}

fn required_number(
    reasons: &mut Vec<String>,
    params: &Value,
    _field: &str,
    keys: &[&str],
) -> Option<f64> {
    for key in keys {
        if let Some(value) = params.get(*key) {
            let parsed = value.as_f64().or_else(|| {
                value
                    .as_str()
                    .and_then(|text| text.trim().parse::<f64>().ok())
            });
            match parsed.filter(|item| item.is_finite()) {
                Some(number) => return Some(number),
                None => {
                    type_error(reasons, key, "数字（或数字字符串）");
                    return None;
                }
            }
        }
    }
    reasons.push(format!("field_missing: 缺少 {}", keys.join("/")));
    None
}

fn optional_number(reasons: &mut Vec<String>, params: &Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(value) = params.get(*key) {
            if value.is_null() {
                return None;
            }
            let parsed = value.as_f64().or_else(|| {
                value
                    .as_str()
                    .and_then(|text| text.trim().parse::<f64>().ok())
            });
            match parsed.filter(|item| item.is_finite()) {
                Some(number) => return Some(number),
                None => {
                    type_error(reasons, key, "数字（或数字字符串）或 null");
                    return None;
                }
            }
        }
    }
    None
}

fn optional_text(params: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| params.get(*key).and_then(Value::as_str))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn text_list(reasons: &mut Vec<String>, params: &Value, key: &str) -> Vec<String> {
    match params.get(key) {
        None => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(|text| text.trim().to_string()))
            .filter(|text| !text.is_empty())
            .collect(),
        Some(_) => {
            type_error(reasons, key, "字符串数组");
            Vec::new()
        }
    }
}

/// 数字或数字字符串（`null` / 其它类型 → `Err`）。
fn number_or_numeric_string(value: &Value) -> Result<f64, ()> {
    if value.is_null() {
        return Err(());
    }
    value
        .as_f64()
        .or_else(|| {
            value
                .as_str()
                .and_then(|text| text.trim().parse::<f64>().ok())
        })
        .filter(|number| number.is_finite())
        .ok_or(())
}

/// `size` 对象里允许的键（严格白名单：多一个键就是"模型写错字段"，必须拒绝）。
const FASTLANE_SIZE_KEYS: [&str; 2] = ["contracts", "risk_pct"];

/// 张数解析（C29.7 跨边界修复：**两条真实形状都认，但仍然严格**）。
///
/// - 嵌套 `size: { contracts, risk_pct }` —— 侧车 prompt 与 `validateFastlaneAction`
///   真正使用的形状（`scripts/cline-fastlane.mjs`）；
/// - 扁平 `sizeContracts` —— 旧形状 / 既有工具口径的别名；
/// - `size` 直接是数字或数字字符串（历史形状）。
///
/// 规则：**只能有一个来源**；`size` 对象里出现 `contracts`/`risk_pct` 之外的键 → `field_unknown`；
/// 缺 `contracts` → `field_missing`；类型不符 → `field_type_invalid`。**不猜、不给默认值**。
/// `risk_pct` 只做形状白名单（单笔风险由代码用张数/入场/止损/面值算，不采信模型自报）。
fn resolve_size_contracts(reasons: &mut Vec<String>, params: &Value) -> Option<f64> {
    if let Some(value) = params.get("sizeContracts") {
        return match number_or_numeric_string(value) {
            Ok(number) => Some(number),
            Err(()) => {
                type_error(reasons, "sizeContracts", "数字（或数字字符串）");
                None
            }
        };
    }
    let Some(size) = params.get("size") else {
        return None;
    };
    let Value::Object(object) = size else {
        return match number_or_numeric_string(size) {
            Ok(number) => Some(number),
            Err(()) => {
                type_error(
                    reasons,
                    "size",
                    "数字（或数字字符串）或 { contracts, risk_pct } 对象",
                );
                None
            }
        };
    };
    for key in object.keys() {
        if !FASTLANE_SIZE_KEYS.contains(&key.as_str()) {
            reasons.push(format!("field_unknown: 不认识的字段 size.{key}"));
        }
    }
    match object.get("contracts") {
        Some(value) => match number_or_numeric_string(value) {
            Ok(number) => Some(number),
            Err(()) => {
                type_error(reasons, "size.contracts", "数字（或数字字符串）");
                None
            }
        },
        None => {
            reasons.push("field_missing: 缺少 size.contracts".to_string());
            None
        }
    }
}

/// 侧车/模型的**动作体 → [`FastlanePlan`]**（严格适配，C29.7 审计裁决）。
///
/// 纪律：
/// - **未知键 → 拒绝**（白名单见 [`FASTLANE_ACTION_KEYS`]）；
/// - **缺字段 / 类型不符 → 拒绝**（不猜、不给默认值）；
/// - 唯一"派生"是 §8.1-1 的**失效位**：模型没写 `invalidationPrice` 时用 **state 里的结构位**
///   （`structure.tf_1h.last_swing_low/high`，退化到 15m）—— 那是模型看过的同一份事实，
///   不是默认值；两处都没有 → 拒绝 `missing_invalidation`。
pub fn plan_from_opportunity(
    params: &Value,
    facts: &PlanFacts,
    intent: &str,
) -> Result<FastlanePlan, Vec<String>> {
    let mut reasons = Vec::new();
    let Some(object) = params.as_object() else {
        return Err(vec!["action_not_object: 动作体必须是对象".to_string()]);
    };
    for key in object.keys() {
        if !FASTLANE_ACTION_KEYS.contains(&key.as_str()) {
            reasons.push(format!("field_unknown: 不认识的字段 {key}"));
        }
    }
    let direction = params
        .get("direction")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase());
    let direction = match direction.as_deref() {
        Some("long") | Some("short") => direction.unwrap_or_default(),
        Some(other) => {
            reasons.push(format!(
                "field_invalid: direction 只能是 long/short（收到 {other}）"
            ));
            String::new()
        }
        None => {
            reasons.push("field_missing: 缺少 direction".to_string());
            String::new()
        }
    };
    let order_type_raw = params
        .get("order_type")
        .or_else(|| params.get("orderType"))
        .map(|value| value.as_str().map(|text| text.trim().to_ascii_lowercase()));
    let order_type_raw = match order_type_raw {
        Some(Some(value)) if matches!(value.as_str(), "limit" | "market" | "trigger") => value,
        Some(Some(other)) => {
            reasons.push(format!("field_invalid: orderType 不受支持（{other}）"));
            String::new()
        }
        Some(None) => {
            type_error(&mut reasons, "orderType", "字符串");
            String::new()
        }
        None => {
            reasons.push("field_missing: 缺少 orderType".to_string());
            String::new()
        }
    };
    let is_reduce = matches!(intent, "close" | "cancel" | "amend");
    // §8.1 的降险口径：close/cancel/amend 走 `reduce`/`close` 分支（跳过开仓专属检查）。
    let order_type = if is_reduce {
        if intent == "close" {
            "close".to_string()
        } else {
            "reduce".to_string()
        }
    } else {
        order_type_raw.clone()
    };
    let entry_px = if is_reduce {
        // 降险轮的入场价是**可选**的（市价平仓没有报价；C29.7 降险口径不查入场价）。
        optional_number(&mut reasons, params, &["entry_px", "price"]).unwrap_or(f64::NAN)
    } else if order_type_raw == "market" {
        // 市价单没有报价：入场基准＝实时最新价（不是"默认值"）。
        if facts.last_price.is_finite() && facts.last_price > 0.0 {
            facts.last_price
        } else {
            reasons.push("market_without_price: 市价单缺少可用最新价".to_string());
            f64::NAN
        }
    } else {
        required_number(&mut reasons, params, "entry_px", &["entry_px", "price"])
            .unwrap_or(f64::NAN)
    };
    let stop_px = optional_number(&mut reasons, params, &["stop_px"]).or_else(|| {
        params
            .get("stopLoss")
            .and_then(|value| optional_number(&mut reasons, value, &["triggerPx"]))
    });
    let stop_px = match stop_px {
        Some(value) => value,
        None => {
            if !is_reduce {
                reasons.push("field_missing: 缺少 stop_px（或 stopLoss.triggerPx）".to_string());
            }
            f64::NAN
        }
    };
    let size_contracts = match resolve_size_contracts(&mut reasons, params) {
        Some(value) => value,
        None => {
            // 只有"确实没有张数"才补一条缺失原因（`size` 给了但没有 `contracts` 时，
            // 上面已经按类型/键报过更具体的原因）。
            if !reasons.iter().any(|item| {
                item.starts_with("field_missing: 缺少 size")
                    || item.starts_with("field_type_invalid: size")
            }) {
                reasons.push("field_missing: 缺少 size（张数）".to_string());
            }
            f64::NAN
        }
    };
    let take_profit = take_profit_list(&mut reasons, params);
    let invalidation = params
        .get("invalidationPrice")
        .or_else(|| params.get("invalidation_price"))
        .map(|value| {
            value.as_f64().or_else(|| {
                value
                    .as_str()
                    .and_then(|text| text.trim().parse::<f64>().ok())
            })
        })
        .transpose_option(&mut reasons, "invalidationPrice")
        .or_else(|| {
            // 结构位 = 模型看过的同一份事实（state.structure）。
            if direction == "short" {
                facts.structure_high
            } else {
                facts.structure_low
            }
        });
    let invalidation = match invalidation {
        Some(value) if value.is_finite() => value,
        _ => {
            if !is_reduce {
                reasons.push("missing_invalidation: 缺少失效位，且 state 结构位不可用".to_string());
            }
            f64::NAN
        }
    };
    // 保证金模式是**开仓准入**字段；降险轮不改保证金模式，缺失时不拦
    // （`margin_mode_allowed` 由 runner 按"开仓校验 / 降险直接放行"给值）。
    let margin_mode = optional_text(params, &["margin_mode", "tdMode"]).unwrap_or_else(|| {
        if !is_reduce {
            reasons.push("field_missing: 缺少 marginMode/tdMode".to_string());
        }
        String::new()
    });
    let risk_pct = compute_risk_pct(size_contracts, entry_px, stop_px, facts);
    let confidence = optional_number(&mut reasons, params, &["confidence"]).unwrap_or(0.0);
    let mut reason_tags = text_list(&mut reasons, params, "reason_tags");
    reason_tags.extend(text_list(&mut reasons, params, "reasonTags"));
    reason_tags.extend(text_list(&mut reasons, params, "riskNotes"));
    reason_tags.extend(text_list(&mut reasons, params, "evidence"));
    if let Some(summary) = optional_text(params, &["summary", "reason"]) {
        reason_tags.push(summary);
    }
    if !reasons.is_empty() {
        return Err(reasons);
    }
    Ok(FastlanePlan {
        side: direction,
        order_type,
        entry_px,
        stop_px,
        take_profit,
        size_contracts,
        risk_pct,
        margin_mode,
        invalidation,
        reason_tags,
        confidence,
    })
}

trait OptionNumberExt {
    fn transpose_option(self, reasons: &mut Vec<String>, field: &str) -> Option<f64>;
}

impl OptionNumberExt for Option<Option<f64>> {
    fn transpose_option(self, reasons: &mut Vec<String>, field: &str) -> Option<f64> {
        match self {
            None => None,
            Some(Some(value)) if value.is_finite() => Some(value),
            Some(_) => {
                type_error(reasons, field, "数字（或数字字符串）");
                None
            }
        }
    }
}

fn take_profit_list(reasons: &mut Vec<String>, params: &Value) -> Vec<f64> {
    if let Some(value) = params.get("tp") {
        match value {
            Value::Array(items) => {
                let mut prices = Vec::new();
                for item in items {
                    let price = item
                        .get("px")
                        .or_else(|| item.get("price"))
                        .and_then(|value| {
                            value.as_f64().or_else(|| {
                                value
                                    .as_str()
                                    .and_then(|text| text.trim().parse::<f64>().ok())
                            })
                        })
                        .or_else(|| item.as_f64());
                    match price.filter(|item| item.is_finite()) {
                        Some(price) => prices.push(price),
                        None => type_error(reasons, "tp[]", "每个元素必须有数字 px"),
                    }
                }
                return prices;
            }
            _ => {
                type_error(reasons, "tp", "数组");
                return Vec::new();
            }
        }
    }
    if let Some(value) = params.get("takeProfit") {
        return match optional_number(reasons, value, &["triggerPx"]) {
            Some(price) => vec![price],
            None => Vec::new(),
        };
    }
    Vec::new()
}

/// 单笔风险%：**由张数/入场/止损/合约面值/权益算**（不采信模型自报的 risk_pct）。
fn compute_risk_pct(size_contracts: f64, entry_px: f64, stop_px: f64, facts: &PlanFacts) -> f64 {
    let stop_distance = (entry_px - stop_px).abs();
    if !(stop_distance.is_finite() && stop_distance > 0.0) {
        return f64::NAN;
    }
    if !(facts.ct_val.is_finite() && facts.ct_val > 0.0) {
        return f64::NAN;
    }
    if !(facts.equity_usdt.is_finite() && facts.equity_usdt > 0.0) {
        return f64::NAN;
    }
    size_contracts * facts.ct_val * stop_distance / facts.equity_usdt * 100.0
}

/// 动作体 → **既有工具参数形状**（`tradeOpportunity.create` 的 canonical camelCase）。
///
/// 只做形状转换：数值/字段来自 [`validate_round`] 通过的那份 plan 与 Profile 事实，
/// 缺失的必填项（`size`/`price`）在这里会变成解析失败（而不是被塞默认值）。
pub fn opportunity_input_from_plan(
    plan: &FastlanePlan,
    params: &Value,
    intent: &str,
    account_id: Option<&str>,
    environment: &str,
    inst_id: &str,
    target_leverage: u32,
    max_slippage_bps: u32,
    session_id: &str,
) -> Value {
    let size = trim_number(plan.size_contracts);
    let price = trim_number(plan.entry_px);
    let stop = trim_number(plan.stop_px);
    let mut input = serde_json::Map::new();
    if let Some(account_id) = account_id.filter(|value| !value.trim().is_empty()) {
        input.insert("accountId".to_string(), json!(account_id));
    }
    input.insert("environment".to_string(), json!(environment));
    input.insert("instId".to_string(), json!(inst_id));
    input.insert("tdMode".to_string(), json!(plan.margin_mode));
    input.insert("intent".to_string(), json!(intent));
    input.insert("direction".to_string(), json!(plan.side));
    input.insert(
        "orderType".to_string(),
        json!(order_type_for_tool(plan, intent)),
    );
    input.insert("size".to_string(), json!(size));
    input.insert("lever".to_string(), json!(target_leverage.to_string()));
    input.insert("maxSlippageBps".to_string(), json!(max_slippage_bps));
    input.insert("confidence".to_string(), json!(plan.confidence));
    input.insert("sourceSessionId".to_string(), json!(session_id));
    if matches!(intent, "close") {
        input.insert(
            "exitKind".to_string(),
            json!(optional_text(params, &["exit_kind", "exitKind"])
                .unwrap_or_else(|| "strategy_exit".to_string())),
        );
    }
    if matches!(intent, "open" | "close") {
        let order_type = order_type_for_tool(plan, intent);
        if matches!(order_type.as_str(), "limit" | "trigger") {
            input.insert("price".to_string(), json!(price));
        }
        if intent == "open" {
            input.insert(
                "stopLoss".to_string(),
                json!({ "kind": "stop_loss", "triggerPx": stop }),
            );
            if let Some(tp) = plan
                .take_profit
                .iter()
                .copied()
                .find(|value| value.is_finite())
            {
                input.insert(
                    "takeProfit".to_string(),
                    json!({ "kind": "take_profit", "triggerPx": trim_number(tp) }),
                );
            }
            input.insert(
                "invalidationPrice".to_string(),
                json!(trim_number(plan.invalidation)),
            );
        }
    }
    input.insert(
        "reason".to_string(),
        json!(
            optional_text(params, &["reason", "summary"]).unwrap_or_else(|| format!(
                "快判{}轮",
                if intent == "close" {
                    "平仓"
                } else {
                    "开仓"
                }
            ))
        ),
    );
    let risk_notes = text_list(&mut Vec::new(), params, "riskNotes");
    if !risk_notes.is_empty() {
        input.insert("riskNotes".to_string(), json!(risk_notes));
    }
    let evidence = text_list(&mut Vec::new(), params, "evidence");
    if !evidence.is_empty() {
        input.insert("evidence".to_string(), json!(evidence));
    }
    Value::Object(input)
}

fn order_type_for_tool(plan: &FastlanePlan, intent: &str) -> String {
    match intent {
        "close" => {
            if plan.order_type == "close" {
                // 降险轮的原始 orderType 已在适配时折叠；用价格是否可用判断形态。
                if plan.entry_px.is_finite() {
                    "limit".to_string()
                } else {
                    "market".to_string()
                }
            } else {
                "market".to_string()
            }
        }
        "cancel" | "amend" => plan.order_type.clone(),
        _ => plan.order_type.clone(),
    }
}

/// 数值 → 字符串（既有工具参数的 `size`/`price` 都是字符串；去掉多余的 0）。
pub fn trim_number(value: f64) -> String {
    if !value.is_finite() {
        return String::new();
    }
    let text = format!("{value:.10}");
    let text = text.trim_end_matches('0').trim_end_matches('.').to_string();
    if text.is_empty() || text == "-" {
        "0".to_string()
    } else {
        text
    }
}

/// 代码门的**拦截口径**：降险轮（`intent="close"`）**不受**数据新鲜度/事件黑名单拦截
/// （C29.7 审计裁决：ticker 过期把用户的停机平仓挡住，正是要避免的失效）。
/// 门的结果仍然**如实**写进 `fastlane_json.gate`，只是不拦这一轮。
pub fn gate_blocks_round(gate: &GateOutcome, is_close_round: bool) -> bool {
    !gate.ok && !is_close_round
}

/// `close` 轮：侧车**是否真的跳过了 Jev**（`fastlaneIntent` 直通位）。
///
/// - 新侧车：`jev: { skipped: true, reason: "intent_close" }`、`timing.jevMs = 0`；
/// - 老侧车（未识别 `fastlaneIntent`）：照旧跑 Jev → `skipped = false` ⇒ 必须留痕。
pub fn close_round_jev_skipped(result: &FastlaneSidecarResult) -> bool {
    result.jev.as_ref().is_some_and(|jev| jev.skipped)
}

/// `close` 轮的**降级判定**：本轮是平仓轮、但最终只是观望
/// （老侧车照旧跑 Jev 且 Jev 判观望时最常见）—— 必须显式通知，不能静默。
pub fn close_round_degraded(is_close_round: bool, record: &FastlaneRecord) -> bool {
    is_close_round && record.action.kind == "watch"
}

/// 下一轮观察条件（侧车 `nextWakePlan`）→ `ai_wake_conditions` 行（C29.7 冻结形状）。
///
/// `conditionFilter` 返回 `false` 的条件会被丢弃（Profile 白名单之外的类型在上层就拒了）。
pub fn wake_condition_rows(
    plan: &Value,
    now_ms: i64,
    mut condition_filter: impl FnMut(&str) -> bool,
) -> Result<Vec<(String, Value)>, String> {
    let mode = plan
        .get("mode")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .ok_or_else(|| "nextWakePlan.mode 必须是 any 或 all".to_string())?;
    if !matches!(mode.as_str(), "any" | "all") {
        return Err("nextWakePlan.mode 必须是 any 或 all".to_string());
    }
    let conditions = plan
        .get("conditions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if conditions.len() > 32 {
        return Err("nextWakePlan.conditions 最多允许 32 条".to_string());
    }
    let mut rows = Vec::new();
    for (index, condition) in conditions.iter().enumerate() {
        let condition_type = condition
            .get("type")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("nextWakePlan.conditions[{index}] 缺少 type"))?
            .to_string();
        if !condition_filter(&condition_type) {
            return Err(format!("Profile 不允许使用唤醒条件：{condition_type}"));
        }
        rows.push((mode.clone(), condition.clone()));
    }
    // 侧车可以只给 expiresAt 而不给条件（纯静默兜底）：那就是"这一轮不写新条件"。
    let _ = now_ms;
    Ok(rows)
}

// ===== B4：单轮下发载荷（冻结形状）=====

/// C28→C29 收养来的**旧全局 Jev 端点**（`typesafe.baseUrl`/`typesafe.model`）。
///
/// 它们只在快判 Profile **没有显式设置过**端点时回落使用（见 [`resolve_inherited_jev_setting`]）：
/// 用户当年在旧配置里改过的 Jev 端点不该因为"旧段被删掉"而静默丢失。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FastlaneInheritedJev {
    pub base_url: Option<String>,
    pub model: Option<String>,
}

/// 回落链：**Profile 显式设置 > 收养来的旧全局值 > 代码默认**。
///
/// "显式设置"的判据是"值不等于代码默认值"：Profile 存的就是值本身，没有"未设置"这一态；
/// 等于默认值 = 用户没动过 → 允许旧全局值接管（这正是"新字段优先、旧值兜底"的落地）。
pub fn resolve_inherited_jev_setting(
    profile_value: &str,
    inherited: Option<&str>,
    code_default: &str,
) -> String {
    let profile_value = profile_value.trim();
    let inherited = inherited.map(str::trim).filter(|value| !value.is_empty());
    if let Some(inherited) = inherited {
        if profile_value.is_empty() || profile_value == code_default {
            return inherited.to_string();
        }
    }
    if profile_value.is_empty() {
        return code_default.to_string();
    }
    profile_value.to_string()
}

/// 侧车 `runFastlaneCommand` 直接读的键（**冻结**，见 `scripts/cline-sidecar.mjs`）：
/// - `input.fastlaneSnapshot` / `input.wakeConditions` / `input.fastlaneIntent` 在**顶层**；
/// - `input.config.profileType === "fastlane"` 决定走快判流程；
/// - 18 个 `fastlane_*` 键与 `input.config.typesafeApiKey` 在**config 里**
///   （`normalizeFastlaneConfig(command.config)` 读的就是 `source.fastlane_*`）。
#[derive(Debug, Clone, PartialEq)]
pub struct FastlaneDispatch {
    /// 合并进 `sendMessage.config` 的键。
    pub config: Value,
    /// 合并进 `sendMessage` 顶层的键。
    pub payload: Value,
    /// `round` | `close`。
    pub intent: String,
}

/// 下发给侧车的 `models` 列表（**白名单字段** `id` / `model` / `name` / `baseUrl`）。
///
/// **红线**：`AiModelConfig` 每条都含 `apiKey` —— 整条 `to_value` 透传会把 provider 凭据
/// 送进侧车进程。所以这里**逐条重新构造**对象（不是"序列化后删键"）：白名单之外的字段
///（`apiKey` / `permissionMode` / `reasoningDepth`）**在结构上不可能出现**。
///
/// 用途：侧车 `resolveNarrowLlmModel` 的"内部 id → provider 名"二道保险。
pub fn sanitized_model_list(models: &[desic_storage_config::AiModelConfig]) -> Value {
    Value::Array(
        models
            .iter()
            .map(|entry| {
                json!({
                    "id": entry.id.trim(),
                    "model": entry.model.trim(),
                    "name": entry.name.trim(),
                    "baseUrl": entry.base_url.trim(),
                })
            })
            .collect(),
    )
}

/// 快判轮下发里**来自 AI 配置**的片段（除 `typesafe_api_key` 外全部可下发；
/// `models` 必须是 [`sanitized_model_list`] 的产物 —— 凭据不进这个结构）。
#[derive(Debug, Clone, PartialEq)]
pub struct FastlaneAiSettings {
    /// 已解析成 provider 模型名的窄调用模型（`fastlane_llm_model`）。
    pub llm_model: String,
    /// TypeSafe（Jev）Key —— 侧车发 `Authorization` 用。
    pub typesafe_api_key: String,
    /// C28→C29 收养的旧全局 Jev 端点。
    pub inherited_jev: FastlaneInheritedJev,
    /// 脱敏后的模型列表（白名单 4 键）。
    pub models: Value,
    /// **窄调用端点/凭据覆盖**（lead 裁决：跟随 Profile 选中的模型条目）。
    ///
    /// 只有当 Profile 绑的是 `config.models[]` 里**非激活**条目时才给值 —— 此时该条目的
    /// `baseUrl`/`apiKey` 覆盖会话里激活模型的那一对（复用既有 `config.baseUrl`/`config.apiKey`
    /// 键，**不新增键**）。`None` = 保持现状（激活模型 / 用户填的是 provider 名 → 不猜）。
    pub llm_base_url: Option<String>,
    pub llm_api_key: Option<String>,
}

impl FastlaneDispatch {
    pub fn build(
        config: &FastlaneConfig,
        ai: &FastlaneAiSettings,
        state: &Value,
        wake_conditions: &Value,
        is_close_round: bool,
    ) -> Self {
        let intent = if is_close_round { "close" } else { "round" };
        // C28→C29：Profile 未显式设置过 Jev 端点时，回落到收养来的旧全局值（否则用代码默认）。
        let mut config = config.clone().normalized();
        let code_default = FastlaneConfig::default();
        config.jev_base_url = resolve_inherited_jev_setting(
            &config.jev_base_url,
            ai.inherited_jev.base_url.as_deref(),
            &code_default.jev_base_url,
        );
        config.jev_model = resolve_inherited_jev_setting(
            &config.jev_model,
            ai.inherited_jev.model.as_deref(),
            &code_default.jev_model,
        );
        let config = &config;
        let mut config_value = sidecar_config_value(config, &ai.llm_model);
        if let Some(object) = config_value.as_object_mut() {
            object.insert("profileType".to_string(), json!("fastlane"));
            // 唯一允许下发的凭据（侧车 Jev 的 Authorization）。
            object.insert("typesafeApiKey".to_string(), json!(ai.typesafe_api_key));
            // 模型列表（**脱敏白名单**，见 `sanitized_model_list`）：侧车用它做
            // "内部 id → provider 名"的二道保险。加在**合并层**，`sidecar_config_value`
            // 的 18 键口径不变（那条断言断的就是它）。
            object.insert("models".to_string(), ai.models.clone());
            // 窄调用的端点与凭据**跟随 Profile 选中的模型条目**（只在该条目非激活时覆盖；
            // 复用既有键，不新增）。`None` → 保持会话现值（不猜）。
            if let Some(base_url) = ai
                .llm_base_url
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                object.insert("baseUrl".to_string(), json!(base_url));
            }
            if let Some(api_key) = ai
                .llm_api_key
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                object.insert("apiKey".to_string(), json!(api_key));
            }
        }
        Self {
            config: config_value,
            payload: json!({
                "fastlaneSnapshot": state,
                "wakeConditions": wake_conditions,
                "fastlaneIntent": intent,
                // 「类型 → 必填字段」schema（与校验器同源）：侧车原样注入 prompt，
                // 免得模型靠猜字段名（真机 `timer 必须提供 atMs 或 intervalMinutes` 的根因）。
                "wakeConditionSchema": wake_condition_schema(),
            }),
            intent: intent.to_string(),
        }
    }

    /// 侧车**实际看到的**形状（测试与审计用同一份拼装规则，避免测试自造形状）。
    pub fn sidecar_view(&self) -> Value {
        let mut view = self.payload.clone();
        if let Some(object) = view.as_object_mut() {
            object.insert("config".to_string(), self.config.clone());
        }
        view
    }
}

/// 活跃观察条件 → 下发形状（**冻结**）。
///
/// 每条：`{ id, source, planMode, type, params…, expiresAt, lastTriggeredAt }` ——
/// `type` 与条件自己的字段**平铺**（既有 `WakeCondition` 的 serde 形状），
/// 条件类型与参数直接来自库里的 `config_json`（Rust 不重写、不裁剪）。
#[derive(Debug, Clone, PartialEq)]
pub struct WakeConditionView {
    pub id: String,
    pub source: String,
    pub plan_mode: String,
    pub condition: Value,
    pub expires_at: Option<i64>,
    pub last_triggered_at: Option<i64>,
}

pub fn wake_conditions_payload(views: &[WakeConditionView]) -> Value {
    Value::Array(
        views
            .iter()
            .map(|view| {
                let mut object = serde_json::Map::new();
                object.insert("id".to_string(), json!(view.id));
                object.insert("source".to_string(), json!(view.source));
                object.insert("planMode".to_string(), json!(view.plan_mode));
                object.insert("expiresAt".to_string(), json!(view.expires_at));
                object.insert("lastTriggeredAt".to_string(), json!(view.last_triggered_at));
                match view.condition.as_object() {
                    Some(condition) => {
                        for (key, value) in condition {
                            object.insert(key.clone(), value.clone());
                        }
                    }
                    None => {
                        object.insert("type".to_string(), view.condition.clone());
                    }
                }
                Value::Object(object)
            })
            .collect(),
    )
}

/// 账户块里的权益读数（`usdtEquity`；兼容 `balanceSemantics` 包裹与 `equityUsdt` 别名）。
/// 拿不到 → `None`（**不给 0**：0 会让"权益不足"看起来像"权益为零"）。
pub fn pick_equity_usdt(value: &Value) -> Option<f64> {
    let semantics = value.get("balanceSemantics").unwrap_or(value);
    pick_f64(semantics, &["usdtEquity", "equityUsdt"])
        .or_else(|| pick_f64(value, &["usdtEquity", "equityUsdt"]))
        .filter(|number| number.is_finite() && *number > 0.0)
}

/// 账户**可平数量上限**＝实际持有量（`|size|` 之和，多空各自计入；无持仓 → 0）。
///
/// 降险轮的 `ValidationInputs.max_size` 用它：**没有持仓就平不了**（0 → 任何张数都被
/// `size_over_limit` 拦下），而不是"没数据就放行"。侧别是否精确由冻结候选那一步的
/// 既有 `trade_precheck` 再核一次（blocked → 拒）。
pub fn position_capacity(positions: &[StatePosition]) -> f64 {
    positions
        .iter()
        .map(|position| position.size)
        .filter(|size| size.is_finite() && *size > 0.0)
        .sum()
}

/// 开仓数量上限＝Profile 单笔保证金上限换算成张数（拿不到合约面值/价格 → 0，交给调用方决定）。
pub fn open_size_cap(
    equity_usdt: f64,
    max_single_trade_margin_pct: u32,
    target_leverage: u32,
    ct_val: f64,
    last_price: f64,
) -> f64 {
    if !(ct_val.is_finite() && ct_val > 0.0 && last_price.is_finite() && last_price > 0.0) {
        return 0.0;
    }
    if !(equity_usdt.is_finite() && equity_usdt > 0.0) {
        return 0.0;
    }
    let notional = equity_usdt * f64::from(max_single_trade_margin_pct) / 100.0
        * f64::from(target_leverage.max(1));
    notional / (ct_val * last_price)
}

/// 一块为什么需要预热。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WarmupNeed {
    /// 缓存里没有（采集器尚未产出），或来源时间不可用（哨兵）。
    Missing,
    /// 有，但**已超过该块的门限**（门限与 [`evaluate_gate`] 同源）。
    Stale,
}

/// 需要预热的块：**缺块 或 已超过该块门限**（`anchor_ms = 0` 时只判"缺失"）。
///
/// 真机第二面：只看"有没有"不看"够不够新"→ 块一旦过期，**每一轮都被门拦下且从不自愈**
/// （summary 里就是"预热补块 0 个"）。门限来自 [`data_age_limit_for`]，
/// 与 [`evaluate_gate`] 用的是同一张表，改一处不会漂。
pub fn warmup_needed_blocks(
    cache: &FastlaneSnapshotCache,
    anchor_ms: i64,
    max_age: &DataAges,
) -> Vec<(&'static str, WarmupNeed)> {
    let ages = (anchor_ms > 0).then(|| cache.ages(anchor_ms));
    let slot_key = |cache: &FastlaneSnapshotCache, label: &str| -> bool {
        match label {
            "ticker" => cache.ticker.is_some(),
            "orderbook" => cache.orderbook.is_some(),
            "candles_1m_closed" => cache.candles_1m.is_some(),
            "derivatives" => cache.derivatives.is_some(),
            "account" => cache.account.is_some(),
            _ => false,
        }
    };
    let mut needed = Vec::new();
    for label in FASTLANE_DATA_BLOCKS {
        let present = slot_key(cache, label);
        let (Some(ages), Some(limit)) = (ages.as_ref(), data_age_limit_for(label, max_age)) else {
            if !present {
                needed.push((label, WarmupNeed::Missing));
            }
            continue;
        };
        let age = data_age_for(label, ages).unwrap_or(i64::MAX);
        if !present || data_age_is_missing(age) {
            needed.push((label, WarmupNeed::Missing));
        } else if age > limit {
            needed.push((label, WarmupNeed::Stale));
        }
    }
    // 预算紧时**必需块优先**（可选块 `orderbook` 放最后）。
    needed.sort_by_key(|(label, _)| !data_block_is_required(label));
    needed
}

/// 「类型 → 必填字段」的**单一直相**（C29：把校验器的要求下发给侧车，别让模型猜字段）。
///
/// 元组：`(type, required, sample_params, notes)`。
/// - `required` 是**模型必须在 `params` 里写**的字段；`a|b` 表示二选一（两组都缺才非法）。
///   `instId` 由 Rust 用本轮品种回填，因此**不要求模型写**（schema 的 `_note` 里写明）。
/// - `sample_params` 只供**一致性测试**构造"最小合法条件"，不下发给侧车。
/// - 类型集合与 [`crate::ai_automation::default_wake_condition_types`] 的 19 类逐一对应
///   （有测试钉住：schema 类型集合 == 注册表，且每类声明的必填字段**实测**必需）。
pub const FASTLANE_WAKE_CONDITION_SPECS: [(&str, &[&str], &str, &str); 19] = [
    (
        "timer",
        &["atMs|intervalMinutes"],
        // 一致性测试的固定 `now` 是 1_800_000_000_000（2027 年附近）→ 样本取 10 分钟后的未来时间戳。
        r#"{"atMs":1800000600000}"#,
        "atMs 用 13 位**未来**毫秒时间戳（≤ 一年内）；或 intervalMinutes 1-1440。二者至少给一个。",
    ),
    (
        "price_cross",
        &["price", "direction"],
        r#"{"price":80500,"direction":"above"}"#,
        "price 为正数；direction ∈ up|above|down|below（价格上穿/下穿）。",
    ),
    (
        "price_change_pct",
        &["windowMinutes", "direction", "thresholdPct"],
        r#"{"windowMinutes":15,"direction":"down","thresholdPct":1.5}"#,
        "windowMinutes 1-1440；thresholdPct 为正的百分比（≤1000）；direction ∈ up|above|down|below|absolute。",
    ),
    (
        "candle_volume_ratio",
        &["ratio"],
        r#"{"ratio":2.5}"#,
        "ratio 为正数（≤100）；可选 bar（1m|3m|5m|15m|30m|1H|2H|4H|6H|12H|1D）、lookback 1-500。",
    ),
    (
        "funding_rate_threshold",
        &["direction", "rate"],
        r#"{"direction":"above","rate":0.0005}"#,
        "rate 为 -1~1 的费率（小数，不是百分比）；direction ∈ up|above|down|below|absolute。",
    ),
    (
        "orderbook_imbalance",
        &["direction", "ratio"],
        r#"{"direction":"buy","ratio":0.7}"#,
        "ratio 在 0~1 之间；direction ∈ buy|bid|up|sell|ask|down；可选 depth 1-50。",
    ),
    (
        "order_state_changed",
        &[],
        r#"{"states":["filled","cancelled"]}"#,
        "无必填；可选 states 数组（每个 ≤64 字符，最多 32 项）过滤状态。",
    ),
    (
        "position_changed",
        &[],
        r#"{}"#,
        "无必填；账户/品种由系统按 Profile 绑定。",
    ),
    (
        "opportunity_state_changed",
        &["opportunityId"],
        r#"{"opportunityId":"opp-placeholder"}"#,
        "opportunityId **必填**（必须是本 Profile 已存在的机会）；可选 states 过滤。",
    ),
    (
        "episode_closed",
        &[],
        r#"{}"#,
        "无必填；持仓 episode 平仓时触发。",
    ),
    (
        "open_interest_anomaly",
        &[],
        r#"{}"#,
        "无必填；OI 异常由情报侧产出。",
    ),
    (
        "taker_flow_imbalance",
        &[],
        r#"{}"#,
        "无必填；主动买卖失衡由情报侧产出。",
    ),
    (
        "crowding_divergence",
        &[],
        r#"{}"#,
        "无必填；拥挤度背离由情报侧产出。",
    ),
    (
        "funding_extreme",
        &[],
        r#"{}"#,
        "无必填；资金费率极端由情报侧产出。",
    ),
    (
        "liquidation_cluster",
        &[],
        r#"{}"#,
        "无必填；强平簇由情报侧产出。",
    ),
    (
        "important_news_event",
        &[],
        r#"{}"#,
        "无必填；高影响新闻由情报侧产出。",
    ),
    (
        "sentiment_reversal",
        &[],
        r#"{}"#,
        "无必填；情绪反转由情报侧产出。",
    ),
    (
        "smart_money_change",
        &[],
        r#"{}"#,
        "无必填；聪明钱变动由情报侧产出。",
    ),
    (
        "macro_event_window",
        &[],
        r#"{}"#,
        "无必填；宏观事件窗口由情报侧产出。",
    ),
];

/// 「类型 → 必填字段」schema（下发给侧车，由它注入 prompt）：**从校验器同源表派生**。
///
/// 形状（模型能直接照抄）：
/// ```json
/// { "_note": "…instId 可省略…",
///   "timer": { "required": ["atMs|intervalMinutes"], "notes": "…" },
///   "price_cross": { "required": ["price", "direction"], "notes": "…" } }
/// ```
pub fn wake_condition_schema() -> Value {
    let mut object = serde_json::Map::new();
    object.insert(
        "_note".to_string(),
        json!(
            "每个条件写成 {\"type\": <类型>, \"params\": {…}}；params 里只写下面 required 列出的字段（外加可选字段）。instId 可省略：系统用本轮品种回填；数值单位与取值范围见 notes。"
        ),
    );
    for (kind, required, _sample, notes) in FASTLANE_WAKE_CONDITION_SPECS {
        object.insert(
            kind.to_string(),
            json!({ "required": required, "notes": notes }),
        );
    }
    Value::Object(object)
}

/// 同一份 schema 的**白名单视图**（C33：AI Profile 链路下发用）。
///
/// 唯一真相仍是 [`FASTLANE_WAKE_CONDITION_SPECS`]（`wake_condition_schema()` 就是它的一比一投影）：
/// 这里只做"**删掉这个 Profile 不允许的行**"，不改任何一行的内容 —— 于是
/// "改 schema 一处、两条链路同步"是**结构性**成立的，而不是靠两处手抄对齐
///（一致性测试逐字比对过滤后的条目与全量 schema 的同名条目）。
///
/// - `allowed` 非空 → 只列其中的类型，顺序沿用 `FASTLANE_WAKE_CONDITION_SPECS`；
///   名单里出现未知类型（手改库 / 历史遗留）→ 它匹配不到任何一行，**不会**被凭空列出来；
/// - `allowed` 为空 → `None`（**不下发**）：空名单只出现在"这个 Run 根本不写观察条件"的场景
///   （简报/复盘在 `execute_profile_run` 里被 `clear()`；交互会话没有 Profile），
///   给它们列一份类型清单只会诱导模型写一堆写不进去的条件。
pub fn wake_condition_schema_for(allowed: &[String]) -> Option<Value> {
    if allowed.is_empty() {
        return None;
    }
    let mut schema = wake_condition_schema();
    if let Some(object) = schema.as_object_mut() {
        object.retain(|key, _| key.starts_with('_') || allowed.iter().any(|item| item == key));
    }
    Some(schema)
}

/// 侧车 `nextWakePlan.conditions[]` 缺 `instId` 时**回填本轮运行品种**。
///
/// 侧车给的是 `{type, params}`（例如 `{"type":"timer"}`），而既有 `WakeCondition` 的品种字段
/// （`PriceCross.instId` 等）是**必填** → 不回填就会整批校验失败
///（真机 `run-1789926893000094000`：`快判下一轮观察条件无效：missing field 'instId'`）。
/// 快判 Profile 是**单品种语境**：`timer` 这类本就与品种无关，`price_cross` 这类用本轮品种也正确。
///
/// 显式给了 `instId`（顶层或 `params` 里）→ **不动**（模型自己指定的品种优先，
/// 作用域校验仍在 `normalize_wake_scope`）。返回是否回填过。
pub fn backfill_wake_condition_inst_id(condition: &mut Value, inst_id: &str) -> bool {
    let inst_id = inst_id.trim();
    if inst_id.is_empty() {
        return false;
    }
    let Some(object) = condition.as_object_mut() else {
        return false;
    };
    if object
        .get("instId")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
    {
        return false;
    }
    object.insert("instId".to_string(), json!(inst_id));
    true
}

/// 收尾时的本地代码段折算：`codeMs` = **本地代码工作**（载荷构造 + 落库前组装），
/// **不含侧车会话等待** —— 否则 `totalMs`（四段之和）会把 `jevMs`/`llmMs` 重复计一次
///（真机 `codeMs=1999` 就是"整段会话墙钟"，导致记录 3.8s 与运行头 2s 打架）。
pub fn apply_local_code_timing(timing: &mut FastlaneTiming, code_pre_ms: i64, code_post_ms: i64) {
    timing.code_ms = code_pre_ms.max(0).saturating_add(code_post_ms.max(0));
    timing.total_ms = timing
        .fetch_ms
        .saturating_add(timing.jev_ms)
        .saturating_add(timing.llm_ms)
        .saturating_add(timing.code_ms);
}

/// 侧车 `nextWakePlan.conditions[]`（`{ type, params }`）→ 既有唤醒条件形状（扁平 `{ type, …params }`）。
/// **这是闭环的唯一转换点**：侧车与 prompt 用的是 `params` 嵌套形状，
/// 而 `WakeCondition` 的 serde 是 `tag = "type"` + 字段平铺；不转换就会整条条件解析失败（闭环断链）。
/// 只允许 `type` / `params` / 作用域键；其它键 → 拒绝（不猜、不静默丢）。
pub const FASTLANE_WAKE_CONDITION_KEYS: [&str; 5] =
    ["type", "params", "instId", "accountId", "opportunityId"];

pub fn wake_condition_value(condition: &Value) -> Result<Value, String> {
    let object = condition
        .as_object()
        .ok_or_else(|| "nextWakePlan 的唤醒条件必须是对象".to_string())?;
    for key in object.keys() {
        if !FASTLANE_WAKE_CONDITION_KEYS.contains(&key.as_str()) {
            return Err(format!("nextWakePlan 条件出现未知字段：{key}"));
        }
    }
    let condition_type = object
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "nextWakePlan 条件缺少 type".to_string())?
        .to_string();
    let mut flat = serde_json::Map::new();
    flat.insert("type".to_string(), json!(condition_type));
    for key in ["instId", "accountId", "opportunityId"] {
        if let Some(value) = object.get(key) {
            flat.insert(key.to_string(), value.clone());
        }
    }
    if let Some(params) = object.get("params") {
        let params = params
            .as_object()
            .ok_or_else(|| format!("{condition_type}.params 必须是对象"))?;
        for (key, value) in params {
            if key == "type" {
                return Err(format!("{condition_type}.params 不允许覆盖 type"));
            }
            flat.insert(key.clone(), value.clone());
        }
    }
    Ok(Value::Object(flat))
}

// ===== B4：单轮冻结事实（runner 与工具闸门共用）=====

/// 系统注入的动作上下文键：**不是模型写的动作参数**。
///
/// 侧车在调用 `tradeOpportunity.create` 时会把账号/环境/品种/身份塞进同一份 params
/// （`bindProfileAccountInput` + `runFastlaneCommand` 的 spread）。适配层只吃
/// "模型写的动作字段"，所以这些键在适配前剥离；剥离之后仍是严格白名单，未知字段照样拒绝。
pub const FASTLANE_INJECTED_CONTEXT_KEYS: [&str; 9] = [
    "instId",
    "environment",
    "accountId",
    "sourceSessionId",
    "agentRunId",
    "agentProfileId",
    "decisionContextId",
    "duplicateResolution",
    "relatedOpportunityId",
];

/// 剥离系统注入键；**模型自报杠杆**额外做一致性检查（执行杠杆恒取 Profile，绝不采信自报值）。
pub fn normalize_round_action(params: &Value, target_leverage: u32) -> (Value, Vec<String>) {
    let Some(object) = params.as_object() else {
        return (params.clone(), Vec::new());
    };
    let mut reasons = Vec::new();
    for key in ["leverage", "lever"] {
        let Some(value) = object.get(key) else {
            continue;
        };
        let claimed = value.as_f64().or_else(|| {
            value
                .as_str()
                .and_then(|text| text.trim().parse::<f64>().ok())
        });
        if let Some(claimed) = claimed.filter(|value| value.is_finite()) {
            if (claimed - f64::from(target_leverage)).abs() > 1e-9 {
                reasons.push(format!(
                    "leverage_mismatch: 自报杠杆 {claimed} ≠ Profile 目标杠杆 {target_leverage}（执行杠杆恒取 Profile）"
                ));
            }
        } else {
            reasons.push(format!("field_type_invalid: {key} 必须是数字"));
        }
    }
    let mut normalized = object.clone();
    for key in FASTLANE_INJECTED_CONTEXT_KEYS {
        normalized.remove(key);
    }
    normalized.remove("leverage");
    normalized.remove("lever");
    (Value::Object(normalized), reasons)
}

/// 适配/校验的留痕（`fastlane_json` 审计用：不静默、不伪造）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FastlaneRoundTrace {
    /// 本轮的意图（`open` | `close` | `cancel` | `amend`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
    /// 适配后的 plan（通过校验的那份；未通过时为 `None`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapted_plan: Option<Value>,
    /// 代码校验 / 预检的拒绝原因。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rejections: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision_context_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opportunity_id: Option<String>,
}

/// 一轮快判的冻结事实：取数 + 代码门之后固定，之后**只读**。
///
/// 它是"适配 → `validate_round` → 冻结候选 + 预检 → 既有 commit 路径"这条顺序里
/// 前四步的唯一输入来源（工具闸门拿到的就是同一份事实，因此顺序无法被绕过）。
#[derive(Debug, Clone)]
pub struct FastlaneRoundFacts {
    pub profile_id: String,
    pub run_id: String,
    pub account_id: Option<String>,
    pub environment: String,
    pub inst_id: String,
    pub session_id: String,
    /// 停机排队的平仓轮（`intent="close"`）。
    pub is_close_round: bool,
    pub plan_facts: PlanFacts,
    pub validation: ValidationInputs,
    pub target_leverage: u32,
    pub max_slippage_bps: u32,
    pub trace: std::sync::Arc<std::sync::Mutex<FastlaneRoundTrace>>,
}

impl FastlaneRoundFacts {
    /// 适配 → 代码校验（[`validate_round`]）。**顺序固定，不可拆**：
    /// 调用方拿到 [`ValidatedRound`] 才允许去冻结候选/提交。
    pub fn adapt_and_validate(&self, params: &Value) -> Result<ValidatedRound, Vec<String>> {
        let requested = action_intent(params)
            .unwrap_or_else(|| if self.is_close_round { "close" } else { "open" }.to_string());
        // 停机平仓轮：用户的意图**优先**（这一轮就是来平仓的），不让模型把意图改回开仓。
        let intent = if self.is_close_round {
            "close".to_string()
        } else {
            requested
        };
        self.set_intent(&intent);
        let (normalized, reasons) = normalize_round_action(params, self.target_leverage);
        if !reasons.is_empty() {
            self.record_rejection(&reasons);
            return Err(reasons);
        }
        let plan = match plan_from_opportunity(&normalized, &self.plan_facts, &intent) {
            Ok(plan) => plan,
            Err(mut reasons) => {
                reasons.sort();
                self.record_rejection(&reasons);
                return Err(reasons);
            }
        };
        // 保证金模式**取值**合法性（账户能力的一半）：只认 OKX 的 cross / isolated；
        // 「这个账户是否允许该模式」由冻结候选那一步的既有 `trade_precheck` 判（blocked → 拒）。
        let is_reduce_intent = matches!(intent.as_str(), "close" | "cancel" | "amend");
        if !is_reduce_intent && !matches!(plan.margin_mode.as_str(), "cross" | "isolated") {
            let reasons = vec![format!(
                "field_invalid: marginMode 只能是 cross/isolated（收到 {:?}）",
                plan.margin_mode
            )];
            self.record_rejection(&reasons);
            return Err(reasons);
        }
        match validate_round(plan, &self.validation) {
            Ok(validated) => {
                self.set_plan(&validated.plan().to_value());
                Ok(validated)
            }
            Err(rejection) => {
                let mut rejection = rejection.reasons;
                rejection.sort();
                self.record_rejection(&rejection);
                Err(rejection)
            }
        }
    }

    fn trace_lock(&self) -> std::sync::MutexGuard<'_, FastlaneRoundTrace> {
        match self.trace.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    pub fn trace(&self) -> FastlaneRoundTrace {
        self.trace_lock().clone()
    }

    fn set_intent(&self, intent: &str) {
        self.trace_lock().intent = Some(intent.to_string());
    }

    fn set_plan(&self, plan: &Value) {
        self.trace_lock().adapted_plan = Some(plan.clone());
    }

    pub fn record_rejection(&self, reasons: &[String]) {
        let mut trace = self.trace_lock();
        trace.rejections = reasons.to_vec();
    }

    pub fn record_decision_context(&self, context_id: &str) {
        self.trace_lock().decision_context_id = Some(context_id.to_string());
    }

    pub fn record_opportunity(&self, opportunity_id: &str) {
        self.trace_lock().opportunity_id = Some(opportunity_id.to_string());
    }
}

impl FastlanePlan {
    /// plan 的 JSON 留痕（审计用；字段名即执行侧口径）。
    pub fn to_value(&self) -> Value {
        json!({
            "side": self.side,
            "orderType": self.order_type,
            "entryPx": self.entry_px,
            "stopPx": self.stop_px,
            "takeProfit": self.take_profit,
            "sizeContracts": self.size_contracts,
            "riskPct": self.risk_pct,
            "marginMode": self.margin_mode,
            "invalidation": self.invalidation,
            "reasonTags": self.reason_tags,
            "confidence": self.confidence,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tests_snapshot() -> FastlaneSnapshot {
        FastlaneSnapshot {
            as_of: "2026-09-20T12:00:00Z".to_string(),
            inst_id: "BTC-USDT-SWAP".to_string(),
            instrument: StateInstrument {
                tick_size: 0.1,
                lot_size: 1.0,
                min_size: 0.01,
                contract_value: "1 张 = 0.01 BTC".to_string(),
                max_leverage: 100,
                ct_val: 0.01,
            },
            price: StatePrice {
                last: 80_298.3,
                chg_5m_pct: -0.05,
                chg_1h_pct: -0.18,
                chg_24h_pct: -1.13,
                high_24h: 81_930.0,
                low_24h: 80_100.0,
                open_24h: 81_212.4,
            },
            micro: StateMicro {
                spread_bps: Some(1.2),
                bid_ask_imbalance: Some(0.31),
                depth_5bps_usd: Some(1_240_000.0),
                taker_buy_ratio_5m: Some(0.58),
            },
            volatility: StateVolatility {
                atr14_5m: Some(61.0),
                atr14_1h: Some(314.1),
                atr14_4h: Some(844.1),
                regime: "range".to_string(),
            },
            structure: StateStructure {
                tf_15m: StateTimeframe {
                    trend: "down".to_string(),
                    window_high: Some(81_930.0),
                    window_low: Some(80_100.0),
                    range_pos: Some(0.108),
                    last_swing_high: Some(81_346.9),
                    last_swing_low: Some(80_100.0),
                },
                tf_1h: StateTimeframe {
                    trend: "down".to_string(),
                    window_high: Some(81_930.0),
                    window_low: Some(75_982.0),
                    range_pos: Some(0.726),
                    last_swing_high: Some(81_930.0),
                    last_swing_low: Some(80_100.0),
                },
                tf_4h: StateTimeframe {
                    trend: "unknown".to_string(),
                    window_high: Some(81_930.0),
                    window_low: Some(74_896.6),
                    range_pos: Some(0.77),
                    last_swing_high: None,
                    last_swing_low: None,
                },
            },
            derivatives: StateDerivatives {
                funding_rate: 0.0001,
                funding_next_ms: 1_789_948_800_000,
                mark_price: 80_290.1,
                index_price: 80_325.5,
                basis_pct: -0.0441,
                oi_usd: 2_462_780_366.0,
                oi_change_1h_pct: -0.23,
            },
            events: vec![StateEvent {
                title: "FOMC".to_string(),
                importance: "high".to_string(),
                at: 1_789_882_963_000,
            }],
            account: StateAccount {
                equity_usdt: 9.9264,
                available_usdt: 9.9264,
                positions: Vec::new(),
                open_orders: vec![StateOpenOrder {
                    side: "sell".to_string(),
                    px: 80_600.0,
                    sz: 0.02,
                    state: "live".to_string(),
                }],
            },
            limits: StateLimits {
                target_leverage: 20,
                max_single_trade_margin_pct: 30,
            },
            recent: vec![StateRecentAction {
                at: 1_789_901_175_062,
                action: "观望".to_string(),
                reason: "low_quality".to_string(),
            }],
            source_times: DataAges {
                ticker: 1_000,
                orderbook: 1_000,
                candles_1m_closed: 1_000,
                derivatives: 1_000,
                account: 1_000,
            },
        }
    }

    fn plan() -> FastlanePlan {
        FastlanePlan {
            side: "long".to_string(),
            order_type: "limit".to_string(),
            entry_px: 80_200.0,
            stop_px: 79_900.0,
            take_profit: vec![81_000.0],
            size_contracts: 1.0,
            risk_pct: 0.5,
            margin_mode: "cross".to_string(),
            invalidation: 80_000.0,
            reason_tags: vec!["pullback".to_string()],
            confidence: 0.7,
        }
    }

    fn inputs() -> ValidationInputs {
        ValidationInputs {
            last_price: 80_200.0,
            equity_usdt: 10_000.0,
            target_leverage: 20,
            max_leverage: 100,
            min_size: 0.01,
            max_size: 100.0,
            profile_max_single_trade_margin_pct: 30.0,
            risk_per_trade_pct: 0.5,
            max_slippage_bps: 5,
            blackout_active: false,
            margin_mode_allowed: true,
        }
    }

    /// 测试用 AI 片段（无收养值、无模型列表）。
    fn ai_settings(llm_model: &str) -> FastlaneAiSettings {
        FastlaneAiSettings {
            llm_model: llm_model.to_string(),
            typesafe_api_key: "TYPESAFE_PLACEHOLDER_KEY".to_string(),
            inherited_jev: FastlaneInheritedJev::default(),
            models: Value::Array(Vec::new()),
            llm_base_url: None,
            llm_api_key: None,
        }
    }

    /// C29.7：15 个字段全有默认值，且默认值就是董事会裁决的那一套。
    #[test]
    fn fastlane_config_defaults_match_contract() {
        let config = FastlaneConfig::default();
        assert_eq!(config.style_preset, "long_pullback");
        assert!(!config.style.is_empty(), "默认风格正文必须由预设生成");
        assert_eq!(config.risk_per_trade_pct, 0.5);
        assert_eq!(config.max_daily_loss_pct, 2.0);
        assert_eq!(config.max_concurrent, 1);
        assert_eq!(config.max_slippage_bps, 5);
        assert_eq!(config.max_actions_per_minute, 1);
        // C29.15（2026-09-21）：质量门 1.5 → 1.2（依据 artifacts/fastlane-gate-abort-tuning/：
        // 1.5 的判别力为零——门拦/门放两半的真阳率 56.1% vs 61.5%、Spearman 0.083、分档非单调）。
        assert_eq!(
            config.quality_floor, FASTLANE_DEFAULT_QUALITY_FLOOR,
            "C29.18：入场质量门默认 1.2（几何 R:R 底线，宽起步）"
        );
        // 钉死同源：侧车 / UI 的默认值必须与这里一致（防漂移，改一处忘另一处会在这里红）。
        assert_eq!(FASTLANE_DEFAULT_QUALITY_FLOOR, 1.2);
        // 变更 B（2026-09-21 用户裁决）：入场分门槛默认 1.5（保守）。
        // 同源三处：本常量 / 侧车 `FASTLANE_DEFAULTS.entryScoreFloor` / UI `FASTLANE_DEFAULTS.entryScoreFloor`
        // （JS 侧另有一条读源码的防漂移断言钉死三处同值）。
        assert_eq!(config.entry_score_floor, 1.5, "入场分门槛默认 1.5");
        assert_eq!(FASTLANE_DEFAULT_ENTRY_SCORE_FLOOR, 1.5);
        // C29.17（2026-09-21）：降险分门槛**独立成字段**，默认同为 1.5
        //（= C29.14 复用同一门槛的行为 → 解耦后默认行为零变化）。
        // 同源三处：本常量 / 侧车 `FASTLANE_DEFAULTS.reduceScoreFloor` / UI `FASTLANE_DEFAULTS.reduceScoreFloor`
        //（JS 侧另有一条读源码的防漂移断言钉死三处同值）。
        assert_eq!(
            config.reduce_score_floor, 1.5,
            "降险分门槛默认 1.5（与解耦前同值）"
        );
        assert_eq!(FASTLANE_DEFAULT_REDUCE_SCORE_FLOOR, 1.5);
        assert_eq!(
            config.reduce_score_floor, config.entry_score_floor,
            "默认值必须同值：解耦本身不允许改变任何一轮的判定"
        );
        assert_eq!(config.confidence_floor, 0.6, "置信度门本轮未动");
        assert_eq!(config.event_blackout_minutes, 30);
        assert_eq!(config.notify_policy, "on_open_close");
        assert_eq!(config.jev_model, "jev-latest");
        assert_eq!(config.jev_timeout_ms, 1_500);
        assert_eq!(config.llm_timeout_ms, 3_000);
        assert_eq!(config.llm_reasoning_effort, "none", "C29.3：默认必须关思考");
        assert_eq!(config.trading_hours, "24h", "交易时段默认 24h");
        // 缺字段的旧 JSON 也得到同一套默认（快判字段在 `ai` 类型上被忽略、不报错）。
        let bare: FastlaneConfig = serde_json::from_str("{}").expect("deserialize {}");
        assert_eq!(bare, config);
        // 三个预设都有正文。
        for preset in FASTLANE_STYLE_PRESETS {
            assert!(!style_text_for_preset(preset).is_empty(), "{preset}");
        }
    }

    /// 归一化：非法值一律回落（快判是自动模式，配置问题不能让它停摆），并夹到安全区间。
    #[test]
    fn fastlane_config_normalizes_invalid_values_without_erroring() {
        let config = FastlaneConfig {
            style_preset: "nonsense".to_string(),
            style: "   ".to_string(),
            risk_per_trade_pct: f64::NAN,
            max_daily_loss_pct: -5.0,
            max_concurrent: 0,
            max_slippage_bps: 0,
            max_actions_per_minute: 0,
            quality_floor: 99.0,
            entry_score_floor: 99.0,
            reduce_score_floor: 99.0,
            confidence_floor: -1.0,
            event_blackout_minutes: 10_000,
            notify_policy: "loud".to_string(),
            jev_model: "  ".to_string(),
            jev_timeout_ms: 1,
            llm_timeout_ms: 999_999,
            llm_reasoning_effort: "high".to_string(),
            trading_hours: "weekend".to_string(),
            jev_base_url: "   ".to_string(),
        }
        .normalized();
        assert_eq!(config.style_preset, "long_pullback");
        assert!(!config.style.is_empty());
        assert_eq!(config.risk_per_trade_pct, 0.5);
        assert_eq!(config.max_daily_loss_pct, 0.1);
        assert_eq!(config.max_concurrent, 1);
        assert_eq!(config.max_slippage_bps, 1);
        assert_eq!(config.max_actions_per_minute, 1);
        // C29.18：入场质量门语义改为几何 R:R 底线 → clamp 区间改为 0.5–3.0。
        assert_eq!(
            config.quality_floor, 3.0,
            "入场质量门（几何 R:R 底线）clamp 上界 3.0"
        );
        assert_eq!(config.entry_score_floor, 3.0, "入场分门槛 clamp 上界 3.0");
        // C29.17：降险分门槛与入场门槛**同规则**（同一个 0–4 期望分尺度 → 同区间）。
        assert_eq!(
            config.reduce_score_floor, 3.0,
            "降险分门槛 clamp 上界同为 3.0（独立字段，同规则）"
        );
        assert_eq!(config.confidence_floor, 0.0);
        assert_eq!(config.event_blackout_minutes, 720);
        assert_eq!(config.notify_policy, "on_open_close");
        assert_eq!(config.jev_model, "jev-latest");
        assert_eq!(config.jev_timeout_ms, 200);
        assert_eq!(config.llm_timeout_ms, 30_000);
        assert_eq!(config.llm_reasoning_effort, "none");
        assert_eq!(config.trading_hours, "24h", "非法时段回落 24h");
        // 变更 B（2026-09-21）：入场分门槛 clamp 到 0.5–3.0（下界 / 区间内原样）。
        for (input, expected) in [
            (-1.0, 0.5),
            (0.0, 0.5),
            (0.5, 0.5),
            (1.0, 1.0),
            (1.5, 1.5),
            (3.0, 3.0),
            (9.0, 3.0),
        ] {
            let clamped = FastlaneConfig {
                entry_score_floor: input,
                ..FastlaneConfig::default()
            }
            .normalized();
            assert_eq!(
                clamped.entry_score_floor, expected,
                "entry_score_floor({input}) → {expected}"
            );
            // C29.17 反向：改开仓门槛**不得**带动降险门槛（两条线各自独立）。
            assert_eq!(
                clamped.reduce_score_floor, FASTLANE_DEFAULT_REDUCE_SCORE_FLOOR,
                "改开仓门槛不得影响降险门槛"
            );
        }
        // NaN / 非法值回落默认（clamp_finite 的兜底语义）。
        let nan_floor = FastlaneConfig {
            entry_score_floor: f64::NAN,
            ..FastlaneConfig::default()
        }
        .normalized();
        assert_eq!(
            nan_floor.entry_score_floor,
            FASTLANE_DEFAULT_ENTRY_SCORE_FLOOR
        );
        // C29.17：降险分门槛同规则（夹取下界 / 区间内原样 / NaN 回落）。
        for (input, expected) in [
            (-1.0, 0.5),
            (0.5, 0.5),
            (1.0, 1.0),
            (1.5, 1.5),
            (2.0, 2.0),
            (9.0, 3.0),
        ] {
            let clamped = FastlaneConfig {
                reduce_score_floor: input,
                ..FastlaneConfig::default()
            }
            .normalized();
            assert_eq!(
                clamped.reduce_score_floor, expected,
                "reduce_score_floor({input}) → {expected}"
            );
            // 改降险门槛**不得**带动入场门槛（两条线已解耦）。
            assert_eq!(
                clamped.entry_score_floor, FASTLANE_DEFAULT_ENTRY_SCORE_FLOOR,
                "改降险门槛不得影响开仓门槛"
            );
        }
        let nan_reduce_floor = FastlaneConfig {
            reduce_score_floor: f64::NAN,
            ..FastlaneConfig::default()
        }
        .normalized();
        assert_eq!(
            nan_reduce_floor.reduce_score_floor,
            FASTLANE_DEFAULT_REDUCE_SCORE_FLOOR
        );
        assert_eq!(
            config.jev_base_url, "https://api.typesafe.ai",
            "空端点回落默认"
        );
        // 合法时段原样保留（UI 的三选一）。
        for hours in FASTLANE_TRADING_HOURS {
            let config = FastlaneConfig {
                trading_hours: hours.to_string(),
                ..FastlaneConfig::default()
            }
            .normalized();
            assert_eq!(config.trading_hours, hours);
        }
        // `custom` + 有正文 → 保留自定义；`custom` + 空白 → 回落预设。
        let custom = FastlaneConfig {
            style_preset: "custom".to_string(),
            style: "只做我自己的规则".to_string(),
            ..FastlaneConfig::default()
        }
        .normalized();
        assert_eq!(custom.style_preset, "custom");
        assert_eq!(custom.style, "只做我自己的规则");
        let empty_custom = FastlaneConfig {
            style_preset: "custom".to_string(),
            style: String::new(),
            ..FastlaneConfig::default()
        }
        .normalized();
        assert_eq!(empty_custom.style_preset, "long_pullback");
    }

    /// 代码门：数据 → 异常 → 冲突，顺序固定，命中即观望并给出原因码。
    #[test]
    fn gate_checks_data_anomaly_then_conflict() {
        let snapshot = tests_snapshot();
        let fresh = DataAges {
            ticker: 0,
            orderbook: 0,
            candles_1m_closed: 60_000,
            derivatives: 30_000,
            account: 1_000,
        };
        let pass = evaluate_gate(&fresh, &snapshot, &[], &DEFAULT_MAX_DATA_AGE_MS);
        assert!(pass.ok);
        assert_eq!(pass.watch_reason(), None);

        let stale = DataAges {
            ticker: 60_000,
            ..fresh
        };
        let gate = evaluate_gate(&stale, &snapshot, &[], &DEFAULT_MAX_DATA_AGE_MS);
        assert!(!gate.ok, "必需块过期必须拦");
        assert_eq!(gate.watch_reason(), Some("data"));
        let text = gate.data.expect("data reason");
        assert!(
            text.contains("ticker") && text.contains("数据过期"),
            "{text}"
        );
        assert!(text.contains("60.0s"), "人读单位：{text}");

        let gate = evaluate_gate(
            &fresh,
            &snapshot,
            &["盘口单侧抽空".to_string()],
            &DEFAULT_MAX_DATA_AGE_MS,
        );
        assert_eq!(gate.watch_reason(), Some("anomaly"));

        // 只有**反义**组合算冲突（15m down ↔ 1h up）：拦，且 reason=conflict。
        let mut conflicting = snapshot.clone();
        conflicting.structure.tf_1h.trend = "up".to_string();
        let gate = evaluate_gate(&fresh, &conflicting, &[], &DEFAULT_MAX_DATA_AGE_MS);
        assert_eq!(gate.watch_reason(), Some("conflict"));
        // 非反义的不一致（`range`/`unknown`）不拦轮，只留痕。
        let mut unknown = snapshot.clone();
        unknown.structure.tf_1h.trend = "unknown".to_string();
        let gate = evaluate_gate(&fresh, &unknown, &[], &DEFAULT_MAX_DATA_AGE_MS);
        assert!(gate.ok);
        assert!(
            gate.reasons
                .iter()
                .any(|note| note.contains("非反义，不拦轮")),
            "{:?}",
            gate.reasons
        );
    }

    /// **安全红线**：下发给侧车的 `models` 列表只允许 4 个白名单字段，**逐条不得含 `apiKey`**。
    #[test]
    fn dispatched_model_list_is_whitelisted_and_never_leaks_api_keys() {
        let secret = "sk-placeholder-must-never-reach-the-sidecar";
        let model_config = |id: &str, model: &str, key: &str| desic_storage_config::AiModelConfig {
            id: id.to_string(),
            name: format!("{model} 显示名"),
            provider: "openai-compatible".to_string(),
            model: model.to_string(),
            base_url: "https://api.example.invalid".to_string(),
            api_key: key.to_string(),
            permission_mode: "copilot".to_string(),
            reasoning_depth: "high".to_string(),
            context_window: Some(64_000),
        };
        let models = vec![
            model_config("model-1784742123978", "deepseek-v4-flash", secret),
            model_config("model-builtin", "claude-sonnet-4", "sk-another-placeholder"),
        ];
        let sanitized = sanitized_model_list(&models);
        let list = sanitized.as_array().expect("array");
        // 条目数与来源一致。
        assert_eq!(list.len(), models.len());
        for (index, entry) in list.iter().enumerate() {
            let object = entry.as_object().expect("object");
            // **逐条断言 `apiKey` 键不存在**（不是"为空"——键都不该出现）。
            assert!(
                !object.contains_key("apiKey"),
                "第 {index} 条不得含 apiKey：{entry}"
            );
            for forbidden in [
                "permissionMode",
                "reasoningDepth",
                "contextWindow",
                "provider",
            ] {
                assert!(
                    !object.contains_key(forbidden),
                    "第 {index} 条不得含 {forbidden}"
                );
            }
            // 白名单 4 键齐全（键集合**恰好**是这 4 个）。
            let mut keys = object.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            assert_eq!(keys, vec!["baseUrl", "id", "model", "name"]);
            assert_eq!(object["id"], models[index].id);
            assert_eq!(object["model"], models[index].model);
            assert_eq!(object["name"], models[index].name);
            assert_eq!(object["baseUrl"], models[index].base_url);
        }

        // 端到端：真正下发的那份 config 里含 `models`（供侧车二道保险），
        // 且**整份载荷里找不到任何凭据**（除显式下发的 TypeSafe Key 之外）。
        let dispatch = FastlaneDispatch::build(
            &FastlaneConfig::default(),
            &FastlaneAiSettings {
                models: sanitized.clone(),
                ..ai_settings("deepseek-v4-flash")
            },
            &json!({ "inst_id": "BTC-USDT-SWAP" }),
            &json!([]),
            false,
        );
        let view = dispatch.sidecar_view();
        assert_eq!(view["config"]["models"], sanitized);
        assert_eq!(view["config"]["models"].as_array().expect("array").len(), 2);
        let serialized = view.to_string();
        assert!(
            !serialized.contains(secret),
            "provider 凭据绝不能进侧车载荷"
        );
        assert!(!serialized.contains("sk-another-placeholder"));
        assert!(serialized.contains("deepseek-v4-flash"));
        // 20 键口径不受影响（`models` 加在合并层，不碰 `sidecar_config_value`；
        // 20 = 原 18 键 + 变更 B 的 `fastlane_entry_score_floor` + C29.17 的 `fastlane_reduce_score_floor`）。
        let fastlane_keys = view["config"]
            .as_object()
            .expect("config")
            .keys()
            .filter(|key| key.starts_with("fastlane_"))
            .count();
        assert_eq!(fastlane_keys, 20);
        // 例外只有 TypeSafe Key 这一把（显式下发，侧车 Jev 要用）。
        assert_eq!(view["config"]["typesafeApiKey"], "TYPESAFE_PLACEHOLDER_KEY");
    }

    /// 真机（运行头 2s vs 记录 3.8s）：`totalMs` 是**四段之和且不重叠** ——
    /// `codeMs` 只能是本地代码工作，绝不能把侧车会话墙钟算进去（那会把 jev/llm 重复计一次）。
    #[test]
    fn local_code_timing_never_double_counts_the_model_segments() {
        let mut timing = FastlaneTiming {
            fetch_ms: 21,
            jev_ms: 849,
            llm_ms: 953,
            code_ms: 1_999, // 旧口径：整段会话墙钟（错的）
            total_ms: 0,
        };
        apply_local_code_timing(&mut timing, 12, 8);
        assert_eq!(timing.code_ms, 20, "本地代码段 = 载荷构造 + 落库前组装");
        assert_eq!(
            timing.total_ms,
            21 + 849 + 953 + 20,
            "total = 四段之和（不把会话等待当代码段）"
        );
        // 与"运行墙钟"同量级：不再是 3.8s 那种把模型时间算两遍的读数。
        assert!(timing.total_ms < 1_999 + 21);
        assert_eq!(
            timing.total_ms,
            timing.fetch_ms + timing.jev_ms + timing.llm_ms + timing.code_ms
        );
        // 负数保护（时钟回拨不会让 codeMs 变负）。
        apply_local_code_timing(&mut timing, -5, -7);
        assert_eq!(timing.code_ms, 0);
    }

    /// ② 下发 schema 必须**与校验器同源**：
    /// ① 类型集合 == `default_wake_condition_types()`（19 类，逐一对齐）；
    /// ② 每类声明的必填字段**实测**必需（缺了就解析/校验失败），且最小合法样本**能通过**校验。
    #[test]
    fn wake_condition_schema_matches_the_validator_and_type_registry() {
        let schema = wake_condition_schema();
        let map = schema.as_object().expect("schema object");
        // ① 类型集合（去掉 `_note` 这种说明键）。
        let mut actual = map
            .keys()
            .filter(|key| !key.starts_with('_'))
            .cloned()
            .collect::<Vec<_>>();
        actual.sort();
        let mut expected = crate::ai_automation::default_wake_condition_types();
        expected.sort();
        assert_eq!(actual, expected, "schema 类型集合必须与注册表逐一对应");
        assert_eq!(actual.len(), 19, "快判观察条件是 19 类");
        // schema 里不能混进值/凭据：只有 required / notes 两个键。
        for kind in &actual {
            let spec = map[kind].as_object().expect("spec object");
            let mut keys = spec.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            assert_eq!(keys, vec!["notes", "required"], "{kind}");
            assert!(
                spec["required"].is_array() && spec["notes"].is_string(),
                "{kind}"
            );
        }
        assert!(map["_note"].is_string(), "必须告诉模型 instId 可省略");

        // ② 逐类实测：`required` 里的字段（`a|b` 视为二选一）缺了必须失败；最小样本必须过。
        let now = 1_800_000_000_000_i64;
        // 第三级闸门（作用域级必填）需要一个连接；`opportunity_state_changed` 缺 id 时
        // 校验在查询之前就返回错误，因此空库足够。
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory database");
        let symbols = vec!["BTC-USDT-SWAP".to_string()];
        for (kind, required, sample, _notes) in FASTLANE_WAKE_CONDITION_SPECS {
            let params: Value = serde_json::from_str(sample).expect("sample json");
            // 模拟 runner：`params` 平铺 + `instId` 回填。
            let mut minimal = params.as_object().cloned().unwrap_or_default();
            minimal.insert("type".to_string(), json!(kind));
            minimal.insert("instId".to_string(), json!("BTC-USDT-SWAP"));
            let minimal = Value::Object(minimal);
            let parsed =
                serde_json::from_value::<desic_agent_automation::WakeCondition>(minimal.clone())
                    .unwrap_or_else(|error| {
                        panic!("{kind} 最小样本必须能解析：{error} ({minimal})")
                    });
            assert!(
                crate::ai_automation::validate_wake_condition_limits(&parsed, now).is_ok(),
                "{kind} 最小样本必须通过既有校验器"
            );
            for group in required {
                let mut broken = minimal.clone();
                let object = broken.as_object_mut().expect("object");
                for field in group.split('|') {
                    object.remove(field.trim());
                }
                let outcome =
                    serde_json::from_value::<desic_agent_automation::WakeCondition>(broken.clone())
                        .map_err(|error| error.to_string())
                        .and_then(|condition| {
                            crate::ai_automation::validate_wake_condition_limits(&condition, now)
                                .map_err(|error| error.to_string())
                        })
                        // 第三级闸门：作用域级必填（`opportunity_state_changed.opportunityId`）。
                        .and_then(|_| {
                            let mut scoped = broken.clone();
                            crate::ai_automation::normalize_wake_scope(
                                &conn,
                                None,
                                Some("demo"),
                                &symbols,
                                &mut scoped,
                            )
                        });
                assert!(
                    outcome.is_err(),
                    "{kind} 缺 {group} 竟然通过了（schema 与校验器不一致）：{broken}"
                );
            }
        }
        // 与门限/字段无关的说明也要写进 schema（模型能直接照抄）。
        assert!(
            map["timer"]["notes"]
                .as_str()
                .unwrap_or_default()
                .contains("intervalMinutes"),
            "{:?}",
            map["timer"]
        );
    }

    /// C33①：AI Profile 链路下发的条件类型规范 —— **同一份** `wake_condition_schema()` 的
    /// **白名单视图**：只列该 Profile 允许的类型、条目内容与全量 schema 逐字同源、
    /// 名单外的类型（以及名单里的未知类型）绝不出现；空名单 = 不下发。
    #[test]
    fn wake_condition_schema_for_filters_by_profile_allowlist() {
        let full = wake_condition_schema();
        // 真机那类 Profile：只允许这几类（不许把 19 类全塞给它）。
        let allowed = vec![
            "timer".to_string(),
            "price_cross".to_string(),
            "position_changed".to_string(),
            "order_state_changed".to_string(),
            "price_change_pct".to_string(),
        ];
        let filtered = wake_condition_schema_for(&allowed).expect("非空名单必须下发");
        let map = filtered.as_object().expect("schema object");
        let mut actual = map
            .keys()
            .filter(|key| !key.starts_with('_'))
            .cloned()
            .collect::<Vec<_>>();
        actual.sort();
        let mut expected = allowed.clone();
        expected.sort();
        assert_eq!(actual, expected, "只能列这个 Profile 允许的类型");
        // 同源：同名条目的 required / notes 必须与全量 schema **逐字相同**（改一处两处同步）。
        for kind in &actual {
            assert_eq!(
                map[kind], full[kind],
                "{kind} 必须与 wake_condition_schema() 同名条目逐字一致"
            );
        }
        // 白名单外一个都不许出现（真机模型猜出来的 `price` 也不许被"顺手列上"）。
        for kind in [
            "price",
            "candle_volume_ratio",
            "funding_rate_threshold",
            "orderbook_imbalance",
            "open_interest_anomaly",
            "opportunity_state_changed",
        ] {
            assert!(!map.contains_key(kind), "白名单外的 {kind} 不得出现");
        }
        // 「instId 可省略、系统回填本轮品种」的统一说明照旧带上（与全量 schema 同一条文字）。
        assert_eq!(map["_note"], full["_note"]);
        // 名单里的未知类型（手改库 / 历史遗留）匹配不到任何一行 → 不会被凭空列出来。
        let with_unknown = wake_condition_schema_for(&[
            "timer".to_string(),
            "volatility_shift".to_string(),
            "radar_alert".to_string(),
        ])
        .expect("非空名单必须下发");
        let unknown_map = with_unknown.as_object().expect("schema object");
        assert!(unknown_map.contains_key("timer"));
        assert!(!unknown_map.contains_key("volatility_shift"));
        assert!(!unknown_map.contains_key("radar_alert"));
        assert_eq!(unknown_map.len(), 2, "只有 `_note` + timer");
        // 空名单 = 不下发（简报/复盘与交互会话：它们根本不写观察条件）。
        assert!(wake_condition_schema_for(&[]).is_none());
        // 全量名单 → 与 `wake_condition_schema()` 逐字相同（过滤只是"删行"，不改内容）。
        let all = FASTLANE_WAKE_CONDITION_SPECS
            .iter()
            .map(|(kind, ..)| kind.to_string())
            .collect::<Vec<_>>();
        assert_eq!(wake_condition_schema_for(&all), Some(full));
    }

    /// 真机 `run-1789926893000094000` ①：侧车条件缺 `instId` → 回填本轮品种；显式给了不动。
    #[test]
    fn wake_condition_inst_id_backfill_respects_explicit_values() {
        // 真机形状：`{"type":"timer"}`（没有 instId）。
        let mut timer = json!({ "type": "timer", "intervalMinutes": 5 });
        assert!(backfill_wake_condition_inst_id(&mut timer, "BTC-USDT-SWAP"));
        assert_eq!(timer["instId"], "BTC-USDT-SWAP");
        assert_eq!(timer["type"], "timer", "回填不动其它字段");
        // `price_cross` 同理（品种是必填字段，缺了就解不出来）。
        let mut cross = json!({ "type": "price_cross", "direction": "above", "price": 80_500.0 });
        assert!(backfill_wake_condition_inst_id(&mut cross, "BTC-USDT-SWAP"));
        assert_eq!(cross["instId"], "BTC-USDT-SWAP");
        let condition: desic_agent_automation::WakeCondition =
            serde_json::from_value(cross).expect("回填后必须能解析成既有 WakeCondition");
        assert!(matches!(
            condition,
            desic_agent_automation::WakeCondition::PriceCross { .. }
        ));
        // 显式给了（哪怕来自 `params`）→ 不覆盖。
        let mut explicit =
            json!({ "type": "price_cross", "instId": "ETH-USDT-SWAP", "price": 3_500.0 });
        assert!(!backfill_wake_condition_inst_id(
            &mut explicit,
            "BTC-USDT-SWAP"
        ));
        assert_eq!(explicit["instId"], "ETH-USDT-SWAP");
        // 空品种 / 非对象 → 不动手、不报错。
        let mut untouched = json!({ "type": "timer" });
        assert!(!backfill_wake_condition_inst_id(&mut untouched, "   "));
        assert!(untouched.get("instId").is_none());
        let mut scalar = json!("timer");
        assert!(!backfill_wake_condition_inst_id(
            &mut scalar,
            "BTC-USDT-SWAP"
        ));
    }

    /// 真机（窄调用 `HTTP 400`）：provider 原文必须**脱敏 + 截断 ≤200 字符**后落库，
    /// 否则"只有 400、没有 body"根本没法定位（这一次的根因是模型名传错）。
    #[test]
    fn llm_failure_detail_is_sanitized_and_bounded() {
        // 侧车带上 provider 原文 → 直接进 reasons（真机想要的可诊断形状）。
        let reason = llm_failure_reason("窄调用 HTTP 400", Some(400), Some("model not found"));
        assert_eq!(reason, "窄调用 HTTP 400：model not found");
        // 缺状态码时补上；原文里的换行/多空格压平。
        assert_eq!(
            llm_failure_reason(
                "窄调用请求失败",
                Some(400),
                Some("  bad\n\n request   body ")
            ),
            "窄调用请求失败（HTTP 400）：bad request body"
        );
        // 脱敏：Bearer / sk-… / 超长疑似令牌一律打码。
        let reason = llm_failure_reason(
            "窄调用 HTTP 401",
            None,
            Some("Authorization: Bearer ts-placeholder-not-a-real-key-wxyz"),
        );
        assert!(
            !reason.contains("ts-placeholder-not-a-real-key-wxyz"),
            "{reason}"
        );
        assert!(reason.contains("****"), "{reason}");
        let reason = llm_failure_reason(
            "窄调用 HTTP 401",
            None,
            Some("key sk-abcdefghijklmnop rejected"),
        );
        assert!(
            !reason.contains("sk-abcdefghijklmnop") && reason.contains("****"),
            "{reason}"
        );
        // 截断：≤200 字符（含省略号），不会把整段 body 写进记录。
        let long_body = format!("{{{} }}", "\"field\":\"value\",".repeat(40));
        assert!(long_body.chars().count() > 200);
        let reason = llm_failure_reason("窄调用 HTTP 400", None, Some(&long_body));
        assert_eq!(
            reason.chars().count(),
            FASTLANE_ERROR_DETAIL_MAX_CHARS,
            "{reason}"
        );
        assert!(reason.ends_with('…'), "{reason}");
        // 纯 helper 边界。
        assert_eq!(sanitize_error_detail("  "), "");
        assert_eq!(sanitize_error_detail("ok"), "ok");
        // 199 字符（空白分隔、非不透明令牌）→ 不截断；239 字符 → 截到 200（含省略号）。
        assert_eq!(
            sanitize_error_detail(&"ab ".repeat(66)).chars().count(),
            197
        );
        assert_eq!(
            sanitize_error_detail(&"ab ".repeat(80)).chars().count(),
            FASTLANE_ERROR_DETAIL_MAX_CHARS
        );
        // 不透明的长令牌（≥32 个字母数字）一律打码：它几乎必然是 Key / 标识符。
        assert_eq!(sanitize_error_detail(&"y".repeat(300)), "****");
        assert_eq!(
            sanitize_error_detail("key apikey_2abcdefghijklmnopqrstuvwxyz0123456789"),
            "key ****"
        );

        // 端到端：侧车回传 `{status, raw}` → `fastlane_json.llm.validation.reasons` 带上原文。
        let result: FastlaneSidecarResult = serde_json::from_value(json!({
            "ok": false,
            "jev": { "action": "观望", "quality": 1.61, "confidence": 0.78, "latencyMs": 832, "attempts": 1 },
            "llm": { "latencyMs": 146, "error": "窄调用 HTTP 400", "status": 400,
                     "raw": "{\"error\":{\"message\":\"model not found\"}}", "wakeConditions": 0 },
            "timing": { "jevMs": 832, "llmMs": 146 },
            "tokens": { "jevIn": 1919, "jevOut": 89, "llmIn": null, "llmOut": null }
        }))
        .expect("parse narrow llm failure");
        let record = FastlaneRecord::from_sidecar(
            FastlaneTrigger {
                source: "manual".to_string(),
                condition_type: None,
                params: None,
            },
            GateOutcome::pass(),
            &result,
            19,
            943,
        );
        let value = record.to_value();
        let reasons = value["llm"]["validation"]["reasons"]
            .as_array()
            .expect("reasons")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        let reason = reasons.join(" | ");
        assert!(reason.contains("窄调用 HTTP 400"), "{reason}");
        assert!(
            reason.contains("model not found"),
            "provider 原文必须带上：{reason}"
        );
        assert!(
            reason.chars().count() <= FASTLANE_ERROR_DETAIL_MAX_CHARS + 16,
            "{reason}"
        );
        // 侧车增量字段：窄调用**实际下发的模型名**与重试次数原样落库（缺字段也不影响解析）。
        assert_eq!(value["llm"]["model"], Value::Null);
        assert_eq!(value["llm"]["attempts"], Value::Null);
        let with_increments: FastlaneSidecarResult = serde_json::from_value(json!({
            "ok": false,
            "llm": { "latencyMs": 146, "error": "窄调用 HTTP 400", "status": 400,
                     "detail": "窄调用 HTTP 400：model not found",
                     "model": "model-1784742123978", "attempts": 2, "wakeConditions": 0 }
        }))
        .expect("parse llm increments");
        let record = FastlaneRecord::from_sidecar(
            FastlaneTrigger {
                source: "manual".to_string(),
                condition_type: None,
                params: None,
            },
            GateOutcome::pass(),
            &with_increments,
            1,
            1,
        );
        let value = record.to_value();
        assert_eq!(value["llm"]["model"], "model-1784742123978");
        assert_eq!(value["llm"]["attempts"], 2);
        // `raw` 也可以是**对象**（侧车未 stringify 时）→ 序列化后同样落库。
        let object_form: FastlaneSidecarResult = serde_json::from_value(json!({
            "ok": false,
            "llm": { "latencyMs": 146, "error": "窄调用 HTTP 400", "wakeConditions": 0,
                     "raw": { "error": { "message": "model not found" } } }
        }))
        .expect("parse object raw");
        let record = FastlaneRecord::from_sidecar(
            FastlaneTrigger {
                source: "manual".to_string(),
                condition_type: None,
                params: None,
            },
            GateOutcome::pass(),
            &object_form,
            1,
            1,
        );
        let reasons = record.to_value()["llm"]["validation"]["reasons"]
            .as_array()
            .expect("reasons")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" | ");
        assert!(reasons.contains("model not found"), "{reasons}");
    }

    /// 真机（01:26:37 `Jev HTTP 403`）：鉴权失败必须给**可行动**文案，且错误码不被吞。
    #[test]
    fn jev_auth_failure_text_is_actionable() {
        // 新版侧车：`hint` 优先（侧车已经写好可行动文案）。
        assert_eq!(
            sidecar_failure_text(Some("请在 设置 → AI 填写/更新 TypeSafe API Key"), None),
            "请在 设置 → AI 填写/更新 TypeSafe API Key"
        );
        // 旧侧车：只有裸错误码 → 鉴权类映射成同一句可行动文案，且**保留状态码**。
        let text = sidecar_failure_text(None, Some("Jev HTTP 403"));
        assert!(text.contains("HTTP 403"), "{text}");
        assert!(text.contains("设置 → AI"), "{text}");
        let text = sidecar_failure_text(None, Some("401 Unauthorized"));
        assert!(
            text.contains("HTTP 401") && text.contains("设置 → AI"),
            "{text}"
        );
        // 非鉴权错误：原文照带（不吞错误码）。
        let text = sidecar_failure_text(None, Some("Jev HTTP 500"));
        assert!(text.contains("HTTP 500"), "{text}");
        assert!(text.contains("侧车判定失败"), "{text}");
        // 两者都缺 → 才回退泛化文案。
        assert_eq!(
            sidecar_failure_text(None, None),
            "侧车判定失败（jev/llm 未完成）"
        );
        assert_eq!(
            sidecar_failure_text(Some("  "), Some("")),
            "侧车判定失败（jev/llm 未完成）"
        );

        // 端到端：侧车回传 `{hint,status,failureKind,error}` → `gate.anomaly` 取 hint，
        // 且 `status`/`failureKind` **原样落进 `fastlane_json.jev`**。
        let result: FastlaneSidecarResult = serde_json::from_value(json!({
            "ok": false,
            "jev": {
                "error": "Jev 鉴权失败（HTTP 403）：请在 设置 → AI 填写/更新 TypeSafe API Key",
                "status": 403, "failureKind": "auth",
                "hint": "请在 设置 → AI 填写/更新 TypeSafe API Key",
                "attempts": 1, "action": null, "latencyMs": 770
            },
            "timing": { "jevMs": 770, "llmMs": null },
            "tokens": { "jevIn": null, "jevOut": null, "llmIn": null, "llmOut": null }
        }))
        .expect("parse auth failure");
        let gate = gate_from_sidecar_failure(&result, GateOutcome::pass());
        assert_eq!(
            gate.anomaly.as_deref(),
            Some("请在 设置 → AI 填写/更新 TypeSafe API Key"),
            "gate.anomaly 必须取 hint"
        );
        assert_eq!(gate.watch_reason(), Some("anomaly"));
        let record = FastlaneRecord::from_sidecar(
            FastlaneTrigger {
                source: "manual".to_string(),
                condition_type: None,
                params: None,
            },
            gate,
            &result,
            19,
            943,
        );
        let value = record.to_value();
        assert_eq!(value["jev"]["status"], 403);
        assert_eq!(value["jev"]["failureKind"], "auth");
        assert_eq!(
            value["jev"]["hint"],
            "请在 设置 → AI 填写/更新 TypeSafe API Key"
        );
        assert_eq!(
            value["jev"]["error"],
            "Jev 鉴权失败（HTTP 403）：请在 设置 → AI 填写/更新 TypeSafe API Key"
        );
        // 失败但整轮仍然有分段耗时（真机 `totalMs=1732` 的形状）。
        assert_eq!(value["timing"]["totalMs"], 19 + 770 + 0 + 943);
    }

    /// C28→C29 收养的旧全局 Jev 端点：**Profile 显式设置优先**，否则回落，最后才是代码默认。
    #[test]
    fn inherited_jev_settings_fall_back_only_when_unset() {
        let default = FastlaneConfig::default();
        assert_eq!(default.jev_model, "jev-latest");
        // Profile 没动过（等于默认）→ 用收养来的旧全局值。
        assert_eq!(
            resolve_inherited_jev_setting(
                &default.jev_model,
                Some("jev-1.9.0"),
                &default.jev_model
            ),
            "jev-1.9.0"
        );
        // Profile 显式改过 → Profile 胜出。
        assert_eq!(
            resolve_inherited_jev_setting("jev-2.0.0", Some("jev-1.9.0"), &default.jev_model),
            "jev-2.0.0"
        );
        // 没有收养值 → Profile / 代码默认。
        assert_eq!(
            resolve_inherited_jev_setting(&default.jev_model, None, &default.jev_model),
            "jev-latest"
        );
        assert_eq!(
            resolve_inherited_jev_setting("", Some(" "), &default.jev_base_url),
            default.jev_base_url
        );

        // 下发载荷：收养值进得了侧车 config（不是"收养了没人用"）。
        let state = json!({ "inst_id": "BTC-USDT-SWAP" });
        let wake = json!([]);
        let inherited = FastlaneInheritedJev {
            base_url: Some("https://jev.internal.example".to_string()),
            model: Some("jev-1.9.0".to_string()),
        };
        let dispatch = FastlaneDispatch::build(
            &default,
            &FastlaneAiSettings {
                inherited_jev: inherited.clone(),
                ..ai_settings("deepseek-v4-flash")
            },
            &state,
            &wake,
            false,
        );
        assert_eq!(
            dispatch.config["fastlane_jev_base_url"],
            "https://jev.internal.example"
        );
        assert_eq!(dispatch.config["fastlane_jev_model"], "jev-1.9.0");
        // Profile 显式改过 → 收养值不覆盖它。
        let custom = FastlaneConfig {
            jev_model: "jev-2.0.0".to_string(),
            ..FastlaneConfig::default()
        };
        let dispatch = FastlaneDispatch::build(
            &custom,
            &FastlaneAiSettings {
                inherited_jev: inherited.clone(),
                ..ai_settings("deepseek-v4-flash")
            },
            &state,
            &wake,
            false,
        );
        assert_eq!(dispatch.config["fastlane_jev_model"], "jev-2.0.0");
        assert_eq!(
            dispatch.config["fastlane_jev_base_url"], "https://jev.internal.example",
            "端点仍是默认 → 旧全局值接管"
        );
    }

    /// 真机首跑 ①：门文案必须分清**缺失**与**过期**，且**绝不打印 `i64::MAX` 哨兵**。
    #[test]
    fn gate_text_separates_missing_from_expired() {
        let snapshot = tests_snapshot();
        let max_age = DEFAULT_MAX_DATA_AGE_MS;

        // 缺失（哨兵）：说"缺失"，不是"过期了 9.2e18 毫秒"，也不打印哨兵数字。
        let missing = DataAges {
            ticker: i64::MAX,
            ..DataAges::default()
        };
        let gate = evaluate_gate(&missing, &snapshot, &[], &max_age);
        assert!(!gate.ok);
        assert_eq!(gate.watch_reason(), Some("data"), "原因码不变");
        let text = gate.data.expect("data reason");
        assert!(text.contains("ticker"), "{text}");
        assert!(text.contains("数据缺失"), "{text}");
        assert!(text.contains("采集器尚未产出"), "{text}");
        assert!(!text.contains("过期"), "缺失不得说成过期：{text}");
        assert!(
            !text.contains(&i64::MAX.to_string()),
            "不得打印哨兵数字：{text}"
        );

        // 每个块都各自能报"缺失"（顺序＝数据门的固定顺序）。
        // 每个**必需**块各自报缺失（只把该块设成哨兵；顺序＝数据门的固定顺序）。
        for (ages, label) in [
            (
                DataAges {
                    candles_1m_closed: i64::MAX,
                    ..DataAges::default()
                },
                "candles_1m_closed",
            ),
            (
                DataAges {
                    derivatives: i64::MAX,
                    ..DataAges::default()
                },
                "derivatives",
            ),
            (
                DataAges {
                    account: i64::MAX,
                    ..DataAges::default()
                },
                "account",
            ),
        ] {
            let gate = evaluate_gate(&ages, &snapshot, &[], &max_age);
            assert!(!gate.ok, "{label} 是必需块");
            let text = gate.data.unwrap_or_default();
            assert!(text.contains(label) && text.contains("数据缺失"), "{text}");
        }
        // `orderbook` 是**可选**块：缺失只留痕、不拦轮。
        let optional = evaluate_gate(
            &DataAges {
                ticker: 0,
                orderbook: i64::MAX,
                candles_1m_closed: 0,
                derivatives: 0,
                account: 0,
            },
            &snapshot,
            &[],
            &max_age,
        );
        assert!(optional.ok, "可选块缺失不得拦轮");
        assert!(optional.data.is_none());
        assert!(
            optional
                .reasons
                .iter()
                .any(|note| note.contains("orderbook") && note.contains("可选，不拦轮")),
            "{:?}",
            optional.reasons
        );

        // 真过期：打印人读单位（≥1s → `s`；<1s → `ms`），并给出上限。
        let expired = DataAges {
            ticker: 3_400,
            ..DataAges::default()
        };
        let text = evaluate_gate(&expired, &snapshot, &[], &max_age)
            .data
            .expect("data reason");
        assert!(text.contains("ticker 数据过期"), "{text}");
        assert!(text.contains("3.4s"), "人读单位（秒）：{text}");
        assert!(text.contains("2.0s"), "上限也用同一单位：{text}");
        assert!(text.contains("2000ms"), "并给出原始毫秒上限：{text}");
        assert!(!text.contains("9223372036854775807"), "{text}");
        // <1s 的过期用毫秒（同一格式化规则）：必需块 ticker 900ms 超过 500ms 上限。
        let sub_second = DataAges {
            ticker: 900,
            ..DataAges::default()
        };
        let text = evaluate_gate(
            &sub_second,
            &snapshot,
            &[],
            &DataAges {
                ticker: 500,
                ..max_age
            },
        )
        .data
        .expect("data reason");
        assert!(text.contains("900ms") && text.contains("500ms"), "{text}");

        // 格式化函数自身：一条规则、两处同用。
        assert_eq!(format_data_age_ms(0), "0ms");
        assert_eq!(format_data_age_ms(999), "999ms");
        assert_eq!(format_data_age_ms(1_000), "1.0s");
        assert_eq!(format_data_age_ms(120_000), "120.0s");
        assert!(!data_age_is_missing(0) && data_age_is_missing(i64::MAX));
    }

    /// 真机首跑 ②：**空缓存 → 按需预热**之后不再因「缺失」被拦；预热也拿不到 → 文案是「缺失」。
    ///
    /// 这里测预热的**判定与效果**（哪些块缺、补齐之后门是否还拦「缺失」）；
    /// 真正的取数动作复用采集器节拍里的同一批 `ai_read_*` 读函数（应用内运行）。
    /// **同源**：`account` 门限必须等于"账户快照可用"的唯一规则（`ai_read_fresh_memory_account_snapshot`
    /// 的 15s），不能更严。更严 = "缓存说可用、门说过期"，真机表现为每轮被拦（实测 7.5s / 10.3s）。
    /// 这条测试同时钉住"抄一个 15_000"这种漂移：改一边不改另一边就红。
    #[test]
    fn account_age_limit_never_beats_the_memory_snapshot_rule() {
        assert_eq!(
            DEFAULT_MAX_DATA_AGE_MS.account,
            crate::AI_MEMORY_PRIVATE_SNAPSHOT_MAX_AGE_MS,
            "account 门限必须引用同一常量，不得成为第二道真相"
        );
        assert!(DEFAULT_MAX_DATA_AGE_MS.account >= 15_000);
        // 门限必须 ≥ 该块自身的更新粒度（冻结口径）：账户快照的粒度由上面那条规则给出。
        assert_eq!(
            data_age_limit_for("account", &DEFAULT_MAX_DATA_AGE_MS),
            Some(15_000)
        );
    }

    #[test]
    fn warmup_removes_the_missing_block_gate() {
        // 缓存里放的是**采集器写进去的原始块值**（`bars_from_values` 认的键）。
        let mut cache = FastlaneSnapshotCache::new("acct-1", "BTC-USDT-SWAP");
        let anchor = 1_000_000_i64;
        let max_age = DEFAULT_MAX_DATA_AGE_MS;
        // 刚建好的 Profile：五个块全缺 → 首轮必然被数据门拦下（真机现象）。
        assert_eq!(
            warmup_needed_blocks(&cache, anchor, &max_age),
            vec![
                ("ticker", WarmupNeed::Missing),
                ("candles_1m_closed", WarmupNeed::Missing),
                ("derivatives", WarmupNeed::Missing),
                ("account", WarmupNeed::Missing),
                ("orderbook", WarmupNeed::Missing),
            ]
        );
        let instrument = registry_instrument();
        let limits = StateLimits {
            target_leverage: 20,
            max_single_trade_margin_pct: 30,
        };
        let empty =
            assemble_from_cache(&cache, &instrument, limits, Vec::new(), Vec::new(), anchor);
        let gate = evaluate_gate(
            &empty.source_times().age_ms(anchor),
            &empty,
            &[],
            &DEFAULT_MAX_DATA_AGE_MS,
        );
        assert!(!gate.ok);
        let text = gate.data.unwrap_or_default();
        assert!(text.contains("数据缺失"), "{text}");
        assert!(!text.contains(&i64::MAX.to_string()), "{text}");

        // 预热补块（与 runner 的预热写同一批块、同一份来源时间口径）。
        cache.ticker = Some(SnapshotSlot::new(
            json!({ "last": 80_298.3, "chg5mPct": -0.05, "chg1hPct": -0.18, "chg24hPct": -1.13,
                    "high24h": 81_930.0, "low24h": 80_100.0, "open24h": 81_212.4 }),
            999_500,
        ));
        cache.orderbook = Some(SnapshotSlot::new(
            json!({ "bids": [[80_000.0, 2.0]], "asks": [[80_002.0, 1.0]] }),
            999_000,
        ));
        // 6,000 根 1m ≈ 4.2 天：够 4H 结构窗口（24×4h）与 ATR14（生产侧同样需要 ≥4 天）。
        cache.candles_1m = Some(SnapshotSlot::new(
            bar_values(&bars_1m(6_000, 960_000_000)),
            999_900,
        ));
        cache.derivatives = Some(SnapshotSlot::new(
            json!({ "fundingRate": 0.0001, "fundingNextMs": 1_789_948_800_000_i64, "markPx": 80_290.1,
                    "idxPx": 80_325.5, "basisPct": -0.0441, "oiUsd": 2_462_780_366.0,
                    "oiChange1hPct": -0.23 }),
            999_800,
        ));
        // 主动买卖比：与节拍同源（内存成交流），预热也补一次——它决定 `micro.is_available()`。
        cache.taker_buy_ratio_5m = Some(0.58);
        cache.account = Some(SnapshotSlot::new(
            json!({ "usdtEquity": 10_000.0, "availableUsdt": 9_926.4,
                    "snapshot": { "positions": [], "openOrders": [] } }),
            999_000,
        ));
        assert!(
            warmup_needed_blocks(&cache, anchor, &DEFAULT_MAX_DATA_AGE_MS).is_empty(),
            "预热后不得再有缺失/过期块：{:?}",
            warmup_needed_blocks(&cache, anchor, &DEFAULT_MAX_DATA_AGE_MS)
        );
        let warmed =
            assemble_from_cache(&cache, &instrument, limits, Vec::new(), Vec::new(), anchor);
        let gate = evaluate_gate(
            &warmed.source_times().age_ms(anchor),
            &warmed,
            &[],
            &DEFAULT_MAX_DATA_AGE_MS,
        );
        assert!(
            gate.ok,
            "预热补齐后该轮不该再被数据门拦下：{:?} / {:?}",
            gate.data, gate.reasons
        );
        // 来源时间用的仍是**真实来源时间**（不是装配时刻）：age 反映源头延迟。
        let ages = warmed.source_times().age_ms(anchor);
        assert!(
            ages.ticker >= 500 && ages.ticker < i64::MAX,
            "{}",
            ages.ticker
        );
        assert!(ages.candles_1m_closed >= 100 && ages.candles_1m_closed < i64::MAX);
        // 预热也拿不到 → 仍然是「缺失」文案（不是过期、不打印哨兵）。
        let still_missing = FastlaneSnapshotCache::new("acct-1", "BTC-USDT-SWAP");
        let snapshot = assemble_from_cache(
            &still_missing,
            &instrument,
            limits,
            Vec::new(),
            Vec::new(),
            anchor,
        );
        let text = evaluate_gate(
            &snapshot.source_times().age_ms(anchor),
            &snapshot,
            &[],
            &DEFAULT_MAX_DATA_AGE_MS,
        )
        .data
        .unwrap_or_default();
        assert!(
            text.contains("数据缺失") && !text.contains("过期"),
            "{text}"
        );
    }

    /// 真机第二面 ①：预热条件＝**缺块 或 已超过该块门限**（门限与 `evaluate_gate` 同源）。
    ///
    /// 只看"有没有"不看"够不够新"→ 块一旦过期，每轮都被门拦下且从不自愈
    /// （真机 summary 就是"预热补块 0 个"）。
    #[test]
    fn warmup_targets_missing_and_stale_blocks() {
        let instrument = registry_instrument();
        let limits = StateLimits {
            target_leverage: 20,
            max_single_trade_margin_pct: 30,
        };
        let anchor = 1_000_000_i64;
        let max_age = DEFAULT_MAX_DATA_AGE_MS;

        // ① 空缓存：全缺。
        let mut cache = FastlaneSnapshotCache::new("acct-1", "BTC-USDT-SWAP");
        assert_eq!(
            warmup_needed_blocks(&cache, anchor, &max_age),
            vec![
                ("ticker", WarmupNeed::Missing),
                ("candles_1m_closed", WarmupNeed::Missing),
                ("derivatives", WarmupNeed::Missing),
                ("account", WarmupNeed::Missing),
                ("orderbook", WarmupNeed::Missing),
            ]
        );

        // ② 块都在但**过期**：必须被判为 `Stale`（ticker 14.5s > 2s 就是真机第二轮的形状）。
        let at = |age: i64| anchor - age;
        cache.ticker = Some(SnapshotSlot::new(json!({ "last": 80_298.3 }), at(14_500)));
        cache.orderbook = Some(SnapshotSlot::new(
            json!({ "bids": [[80_000.0, 2.0]], "asks": [[80_002.0, 1.0]] }),
            at(300),
        ));
        cache.candles_1m = Some(SnapshotSlot::new(
            (0..40)
                .map(|index| {
                    json!({ "time": 60_000 * index, "open": 1.0, "high": 2.0,
                                     "low": 0.5, "close": 1.5, "volume": 3.0, "confirm": true })
                })
                .collect::<Vec<_>>(),
            at(30_000),
        ));
        // 桶粒度块：4 分钟旧，但在 360s 门限内 → **不需要刷新**（这一步以前会误判"过期"）。
        cache.derivatives = Some(SnapshotSlot::new(
            json!({ "fundingRate": 0.0001, "bucketAtMs": at(240_000) }),
            at(240_000),
        ));
        cache.account = Some(SnapshotSlot::new(
            json!({ "usdtEquity": 10_000.0, "availableUsdt": 9_000.0,
                    "snapshot": { "positions": [], "openOrders": [] } }),
            at(400),
        ));
        assert_eq!(
            warmup_needed_blocks(&cache, anchor, &max_age),
            vec![("ticker", WarmupNeed::Stale)],
            "只有 ticker 需要刷新"
        );
        // 边界：derivatives 359s 不刷新、361s 刷新（门限 = 360s，与门同源）。
        for (age, expected_stale) in [(359_000, false), (361_000, true)] {
            let mut probe = cache.clone();
            probe.derivatives = Some(SnapshotSlot::new(json!({ "fundingRate": 0.0001 }), at(age)));
            let stale = warmup_needed_blocks(&probe, anchor, &max_age)
                .iter()
                .any(|(label, need)| *label == "derivatives" && *need == WarmupNeed::Stale);
            assert_eq!(stale, expected_stale, "derivatives age={age}");
        }
        // 同源证明：把**同一份** `max_age` 收紧成 1s，同一份缓存立刻被判为过期；
        // 改一处（门限表）门与预热一起变，不会漂。
        let tight = DataAges {
            derivatives: 1_000,
            ..max_age
        };
        assert!(warmup_needed_blocks(&cache, anchor, &tight)
            .iter()
            .any(|(label, need)| *label == "derivatives" && *need == WarmupNeed::Stale));
        // 门限取的就是门的 `data_age_limit_for`（唯一来源）。
        assert_eq!(
            data_age_limit_for("derivatives", &max_age),
            Some(360_000),
            "桶粒度块的门限 ≥ 桶粒度"
        );
        assert_eq!(data_age_limit_for("ticker", &max_age), Some(2_000));

        // ③ 刷新到新鲜之后：不再需要预热（该轮不再被门拦）。
        cache.ticker = Some(SnapshotSlot::new(json!({ "last": 80_298.3 }), at(120)));
        assert!(warmup_needed_blocks(&cache, anchor, &max_age).is_empty());
        let snapshot =
            assemble_from_cache(&cache, &instrument, limits, Vec::new(), Vec::new(), anchor);
        let ages = snapshot.source_times().age_ms(anchor);
        assert!(ages.ticker == 120 && ages.derivatives == 240_000);
        // 桶粒度的 4 分钟旧数据**不再**被门判过期（旧 60s 门限时代这里会拦）。
        let gate = evaluate_gate(&ages, &snapshot, &[], &max_age);
        assert!(
            !gate
                .data
                .clone()
                .unwrap_or_default()
                .contains("derivatives"),
            "{:?}",
            gate.data
        );
    }

    /// lead 裁决（2026-09-20 真机"冲突拦截"）：**只有互为反义的组合算冲突**。
    ///
    /// 真机形状 `15m up + 1h range` 曾被判成"趋势相反"→ 绝大多数轮次被拦；现在它只是留痕。
    #[test]
    fn structure_conflict_requires_opposed_trends() {
        let fresh = DataAges {
            ticker: 0,
            orderbook: 0,
            candles_1m_closed: 60_000,
            derivatives: 30_000,
            account: 1_000,
        };
        let with_trends = |trend_15m: &str, trend_1h: &str, trend_4h: &str| -> FastlaneSnapshot {
            let mut snapshot = tests_snapshot();
            snapshot.structure.tf_15m.trend = trend_15m.to_string();
            snapshot.structure.tf_1h.trend = trend_1h.to_string();
            snapshot.structure.tf_4h.trend = trend_4h.to_string();
            snapshot
        };

        // ① 真机反例：`15m up` + `1h range` → **不拦**，`reasons` 留痕。
        let gate = evaluate_gate(
            &fresh,
            &with_trends("up", "range", "range"),
            &[],
            &DEFAULT_MAX_DATA_AGE_MS,
        );
        assert!(gate.ok, "非反义不得拦轮：{:?}", gate);
        assert_eq!(gate.watch_reason(), None);
        assert!(gate.data.is_none() && gate.anomaly.is_none() && gate.conflict.is_none());
        assert!(
            gate.reasons
                .iter()
                .any(|note| note.contains("15m up / 1h range") && note.contains("非反义，不拦轮")),
            "{:?}",
            gate.reasons
        );

        // ② 反义组合：两个方向都拦，且 reason=conflict。
        for (trend_15m, trend_1h) in [("up", "down"), ("down", "up")] {
            let gate = evaluate_gate(
                &fresh,
                &with_trends(trend_15m, trend_1h, "range"),
                &[],
                &DEFAULT_MAX_DATA_AGE_MS,
            );
            assert!(!gate.ok, "{trend_15m}/{trend_1h} 必须拦");
            assert_eq!(gate.watch_reason(), Some("conflict"));
            let text = gate.conflict.expect("conflict reason");
            assert!(
                text.contains(trend_15m) && text.contains(trend_1h),
                "{text}"
            );
        }

        // ③ `range` / `unknown` 参与的**所有**组合都不拦。
        for (trend_15m, trend_1h) in [
            ("range", "range"),
            ("range", "up"),
            ("up", "range"),
            ("range", "down"),
            ("down", "range"),
            ("unknown", "unknown"),
            ("unknown", "up"),
            ("up", "unknown"),
            ("unknown", "down"),
            ("down", "unknown"),
            ("unknown", "range"),
            ("range", "unknown"),
        ] {
            let gate = evaluate_gate(
                &fresh,
                &with_trends(trend_15m, trend_1h, "range"),
                &[],
                &DEFAULT_MAX_DATA_AGE_MS,
            );
            assert!(gate.ok, "{trend_15m}/{trend_1h} 不得拦轮：{:?}", gate.data);
            assert_eq!(gate.watch_reason(), None);
        }
        // 同向一致 → 连留痕都不需要。
        let gate = evaluate_gate(
            &fresh,
            &with_trends("up", "up", "up"),
            &[],
            &DEFAULT_MAX_DATA_AGE_MS,
        );
        assert!(gate.ok && gate.reasons.is_empty(), "{:?}", gate.reasons);

        // ④ 4H **不参与**冲突判定（若将来加入，同样只按反义判）。
        let gate = evaluate_gate(
            &fresh,
            &with_trends("up", "up", "down"),
            &[],
            &DEFAULT_MAX_DATA_AGE_MS,
        );
        assert!(gate.ok, "4H 反义不参与判定：{:?}", gate.conflict);
        // 反义谓词本身：只有 up↔down（含前后空格）成立。
        assert!(trends_are_opposed("up", "down") && trends_are_opposed("down", "up"));
        for (a, b) in [
            ("up", "up"),
            ("up", "range"),
            ("range", "up"),
            ("up", "unknown"),
            ("unknown", "down"),
            ("range", "unknown"),
        ] {
            assert!(!trends_are_opposed(a, b), "{a}/{b} 不是反义");
        }

        // ⑤ 与可选块留痕**共存**：micro 缺失 + `up/range` → 两条留痕、都不拦。
        let mut snapshot = with_trends("up", "range", "range");
        snapshot.micro = StateMicro::unavailable();
        let gate = evaluate_gate(&fresh, &snapshot, &[], &DEFAULT_MAX_DATA_AGE_MS);
        assert!(gate.ok, "{:?}", gate);
        assert!(
            gate.reasons.iter().any(|note| note.contains("micro")),
            "{:?}",
            gate.reasons
        );
        assert!(
            gate.reasons
                .iter()
                .any(|note| note.contains("非反义，不拦轮")),
            "{:?}",
            gate.reasons
        );
        // 真反义 + micro 缺失 → 拦，但 micro 的留痕一起带上（不静默）。
        let mut opposed = with_trends("up", "down", "range");
        opposed.micro = StateMicro::unavailable();
        let gate = evaluate_gate(&fresh, &opposed, &[], &DEFAULT_MAX_DATA_AGE_MS);
        assert!(!gate.ok);
        assert_eq!(gate.watch_reason(), Some("conflict"));
        assert!(
            gate.reasons.iter().any(|note| note.contains("micro")),
            "{:?}",
            gate.reasons
        );
    }

    /// lead 裁决（2026-09-20 真机 `takerRatio=None`）：`orderbook` / `micro.*` 是**可选**块，    /// lead 裁决（2026-09-20 真机 `takerRatio=None`）：`orderbook` / `micro.*` 是**可选**块，
    /// **不得拦轮**；必需块（ticker/candles_1m/derivatives/account）仍旧拦。
    #[test]
    fn optional_orderbook_and_micro_never_block_the_round() {
        let instrument = registry_instrument();
        let limits = StateLimits {
            target_leverage: 20,
            max_single_trade_margin_pct: 30,
        };
        let anchor = 1_000_000_i64;
        // 真机形状：**没有**盘口、**没有**主动买卖比（taker window 未热），其余必需块齐全。
        let mut cache = FastlaneSnapshotCache::new("acct-1", "BTC-USDT-SWAP");
        cache.ticker = Some(SnapshotSlot::new(
            json!({ "last": 80_298.3, "chg5mPct": -0.05, "chg1hPct": -0.18, "chg24hPct": -1.13,
                    "high24h": 81_930.0, "low24h": 80_100.0, "open24h": 81_212.4 }),
            999_500,
        ));
        cache.candles_1m = Some(SnapshotSlot::new(
            bar_values(&bars_1m(6_000, 960_000_000)),
            999_900,
        ));
        cache.derivatives = Some(SnapshotSlot::new(
            json!({ "fundingRate": 0.00012, "fundingNextMs": anchor + 3_600_000,
                    "bucketAtMs": anchor - 45_000 }),
            999_800,
        ));
        cache.account = Some(SnapshotSlot::new(
            json!({ "usdtEquity": 10_000.0, "availableUsdt": 9_926.4,
                    "snapshot": { "positions": [], "openOrders": [] } }),
            999_000,
        ));
        assert_eq!(cache.taker_buy_ratio_5m, None, "真机形状：taker 窗口未热");

        let snapshot =
            assemble_from_cache(&cache, &instrument, limits, Vec::new(), Vec::new(), anchor);
        // state 里 micro **显式 null**（不给 0）、盘口年龄是哨兵 —— 可见性不变。
        let state = snapshot.to_state(anchor);
        for key in [
            "spread_bps",
            "bid_ask_imbalance",
            "depth_5bps_usd",
            "taker_buy_ratio_5m",
        ] {
            assert!(state["micro"].get(key).is_some(), "键必须保留：{key}");
            assert!(state["micro"][key].is_null(), "不可用必须是 null：{key}");
        }
        assert_eq!(state["data_age_ms"]["orderbook"], i64::MAX);
        // `orderbook` 属于**可选**块 → 预热只把它当"可选"，门也不拿它拦轮。
        assert!(!data_block_is_required("orderbook"));
        for required in ["ticker", "candles_1m_closed", "derivatives", "account"] {
            assert!(data_block_is_required(required), "{required} 是必需块");
        }

        // 门：可选块缺失 → **ok=true**，但 reasons 里必须留痕（不静默）。
        let gate = evaluate_gate(
            &snapshot.source_times().age_ms(anchor),
            &snapshot,
            &[],
            &DEFAULT_MAX_DATA_AGE_MS,
        );
        assert!(gate.ok, "可选块（orderbook/micro）缺失不得拦轮：{:?}", gate);
        assert!(gate.data.is_none());
        assert!(gate.watch_reason().is_none());
        assert!(
            gate.reasons
                .iter()
                .any(|note| note.contains("orderbook") && note.contains("可选，不拦轮")),
            "{:?}",
            gate.reasons
        );
        assert!(
            gate.reasons
                .iter()
                .any(|note| note.contains("micro") && note.contains("可选，不拦轮")),
            "{:?}",
            gate.reasons
        );

        // 必需块任一缺失/过期 → 仍旧拦，且文案是"缺失/过期"分类（不是可选留痕）。
        let stale_required = DataAges {
            ticker: 999_998,
            orderbook: i64::MAX,
            candles_1m_closed: 0,
            derivatives: 0,
            account: 0,
        };
        let gate = evaluate_gate(&stale_required, &snapshot, &[], &DEFAULT_MAX_DATA_AGE_MS);
        assert!(!gate.ok, "必需块过期必须拦");
        let text = gate.data.expect("data reason");
        assert!(
            text.contains("ticker") && text.contains("数据过期"),
            "{text}"
        );
        // 顺序语义：ticker 在第一道就拦 → 还没走到可选块，`reasons` 自然是空的
        //（门报"第一道不合格的门"是既有语义）；可选块排在必需块**之前**被检查时，
        // 它的留痕必须跟着失败结果一起带上（不静默）：
        let optional_then_required = DataAges {
            ticker: 0,
            orderbook: i64::MAX,
            candles_1m_closed: i64::MAX,
            derivatives: 0,
            account: 0,
        };
        let gate = evaluate_gate(
            &optional_then_required,
            &snapshot,
            &[],
            &DEFAULT_MAX_DATA_AGE_MS,
        );
        assert!(!gate.ok);
        assert!(
            gate.data.unwrap_or_default().contains("candles_1m_closed"),
            "必需块文案必须点名牌"
        );
        assert!(
            gate.reasons
                .iter()
                .any(|note| note.contains("orderbook") && note.contains("可选，不拦轮")),
            "可选块留痕必须一起带上：{:?}",
            gate.reasons
        );
        for (ages, label) in [
            (
                DataAges {
                    candles_1m_closed: i64::MAX,
                    ..DataAges::default()
                },
                "candles_1m_closed",
            ),
            (
                DataAges {
                    derivatives: i64::MAX,
                    ..DataAges::default()
                },
                "derivatives",
            ),
            (
                DataAges {
                    account: i64::MAX,
                    ..DataAges::default()
                },
                "account",
            ),
        ] {
            let gate = evaluate_gate(&ages, &snapshot, &[], &DEFAULT_MAX_DATA_AGE_MS);
            assert!(!gate.ok, "{label} 缺失必须拦");
            assert!(
                gate.data.unwrap_or_default().contains(label),
                "{label} 的文案必须点名牌"
            );
        }
        // 盘口**过期**（不是缺失）也一样只是可选留痕。
        let stale_optional = DataAges {
            ticker: 0,
            orderbook: 14_500,
            candles_1m_closed: 0,
            derivatives: 0,
            account: 0,
        };
        let gate = evaluate_gate(&stale_optional, &snapshot, &[], &DEFAULT_MAX_DATA_AGE_MS);
        assert!(gate.ok, "{:?}", gate);
        assert!(
            gate.reasons.iter().any(|note| note.contains("orderbook")
                && note.contains("数据过期")
                && note.contains("可选，不拦轮")),
            "{:?}",
            gate.reasons
        );
    }

    /// 真机第三面 ②：`derivatives` 的**来源时间口径**（推送/桶粒度，必须一致、可解释）。    /// 真机第三面 ②：`derivatives` 的**来源时间口径**（推送/桶粒度，必须一致、可解释）。
    #[test]
    fn derivatives_bucket_time_contract_is_consistent() {
        let now = 1_800_000_000_000_i64;
        // ① 有交易所推送/数据时间（过去）→ 用它当来源时间，并原样落 `bucketAtMs`。
        let (block, source_at) = normalize_derivatives_block(
            &json!({ "fundingRate": { "fundingRate": 0.00012, "ts": now - 45_000,
                                     "fundingTime": now + 3_600_000,
                                     "nextFundingTime": now + 3_600_000 } }),
            now,
        )
        .expect("derivatives block");
        assert_eq!(source_at, now - 45_000);
        assert_eq!(block["bucketAtMs"], now - 45_000);
        assert_eq!(block["fundingNextMs"], now + 3_600_000);
        // 45s 旧在 360s 门限内（旧 60s 门限下这里也可能被拦：推送周期本身就是 30–60s）。
        assert!(snapshot_source_time(source_at, now) + 360_000 >= now);

        // ② 只有"下一期结算时间"（未来）→ 它**不是**来源时间；用采集时刻，桶时间仍留痕。
        let (block, source_at) = normalize_derivatives_block(
            &json!({ "fundingRate": { "fundingRate": 0.0001, "fundingTime": now + 3_600_000 } }),
            now,
        )
        .expect("derivatives block");
        assert_eq!(source_at, now, "未来时间不能当来源时间");
        assert_eq!(block["bucketAtMs"], now + 3_600_000);

        // ③ 完全没有时间 → 采集时刻 + `bucketAtMs: null`。
        let (block, source_at) =
            normalize_derivatives_block(&json!({ "fundingRate": { "fundingRate": 0.0001 } }), now)
                .expect("derivatives block");
        assert_eq!(source_at, now);
        assert!(block["bucketAtMs"].is_null());

        // ④ 端到端形状：库里/内存里那份"桶时间 4 分钟前、但刚采集"的样本
        //    经采集器落槽之后 **不再** 被 60s 门限拦（门限已按桶粒度定为 360s）。
        let bucket_at = now - 240_000;
        let (block, _) = normalize_derivatives_block(
            &json!({ "fundingRate": { "fundingRate": 0.0001, "ts": bucket_at } }),
            now,
        )
        .expect("derivatives block");
        let ages = DataAges {
            ticker: 0,
            orderbook: 0,
            candles_1m_closed: 0,
            derivatives: (now - bucket_at).max(0),
            account: 0,
        };
        assert_eq!(ages.derivatives, 240_000);
        let snapshot = tests_snapshot();
        let gate = evaluate_gate(&ages, &snapshot, &[], &DEFAULT_MAX_DATA_AGE_MS);
        assert!(
            !gate
                .data
                .clone()
                .unwrap_or_default()
                .contains("derivatives"),
            "4 分钟前的桶数据不该被桶粒度门限拦：{:?}",
            gate.data
        );
        // 超过桶粒度门限才算过期（边界）。
        let expired = DataAges {
            derivatives: 360_001,
            ..ages
        };
        let text = evaluate_gate(&expired, &snapshot, &[], &DEFAULT_MAX_DATA_AGE_MS)
            .data
            .expect("data reason");
        assert!(
            text.contains("derivatives 数据过期") && text.contains("360.0s"),
            "{text}"
        );
        let _ = block;
    }

    /// §8.1 七项校验：happy path 通过，每个分支都能被单独触发（拒绝原因码稳定）。
    #[test]
    fn validate_round_covers_every_code_check() {
        let inputs = inputs();
        let ok = validate_round(plan(), &inputs).expect("合规方案必须通过");
        assert_eq!(ok.plan().side, "long");

        // ① 止损在失效位内（做多 stop 必须低于失效位）。
        let mut inside = plan();
        inside.stop_px = 80_050.0;
        let rejection = validate_round(inside, &inputs).expect_err("止损在失效位内必须拒");
        assert!(rejection
            .reasons
            .iter()
            .any(|item| item.starts_with("stop_inside_invalidation")));
        // 做空对称。
        let mut short_inside = plan();
        short_inside.side = "short".to_string();
        short_inside.stop_px = 79_950.0;
        short_inside.invalidation = 80_000.0;
        short_inside.entry_px = 79_900.0;
        short_inside.take_profit = vec![79_000.0];
        let rejection = validate_round(short_inside, &inputs).expect_err("做空同样拒");
        assert!(rejection
            .reasons
            .iter()
            .any(|item| item.starts_with("stop_inside_invalidation")));

        // ② 单笔风险超限 + 保证金超 Profile 上限。
        let mut risky = plan();
        risky.risk_pct = 1.5;
        let rejection = validate_round(risky, &inputs).expect_err("风险超限必须拒");
        assert!(rejection
            .reasons
            .iter()
            .any(|item| item.starts_with("risk_over_limit")));
        let mut tiny_margin = inputs;
        tiny_margin.profile_max_single_trade_margin_pct = 0.1;
        let rejection = validate_round(plan(), &tiny_margin).expect_err("保证金超上限必须拒");
        assert!(rejection
            .reasons
            .iter()
            .any(|item| item.starts_with("margin_over_profile_limit")));

        // ③ 盈亏比 < 1.5；缺止盈。
        let mut poor_rr = plan();
        poor_rr.take_profit = vec![80_300.0];
        let rejection = validate_round(poor_rr, &inputs).expect_err("盈亏比不足必须拒");
        assert!(rejection
            .reasons
            .iter()
            .any(|item| item.starts_with("reward_risk_below_floor")));
        let mut no_tp = plan();
        no_tp.take_profit = Vec::new();
        let rejection = validate_round(no_tp, &inputs).expect_err("缺止盈必须拒");
        assert!(rejection
            .reasons
            .iter()
            .any(|item| item.starts_with("missing_take_profit")));

        // ④ 手数上下限、杠杆上限、保证金模式。
        let mut too_small = plan();
        too_small.size_contracts = 0.001;
        let rejection = validate_round(too_small, &inputs).expect_err("手数过小必须拒");
        assert!(rejection
            .reasons
            .iter()
            .any(|item| item.starts_with("size_below_min")));
        let mut too_big = plan();
        too_big.size_contracts = 1_000.0;
        let rejection = validate_round(too_big, &inputs).expect_err("手数超限必须拒");
        assert!(rejection
            .reasons
            .iter()
            .any(|item| item.starts_with("size_over_limit")));
        let mut leverage = inputs;
        leverage.target_leverage = 200;
        let rejection = validate_round(plan(), &leverage).expect_err("杠杆超合约上限必须拒");
        assert!(rejection
            .reasons
            .iter()
            .any(|item| item.starts_with("leverage_over_instrument_limit")));
        let mut margin_mode = inputs;
        margin_mode.margin_mode_allowed = false;
        let rejection = validate_round(plan(), &margin_mode).expect_err("保证金模式不合规必须拒");
        assert!(rejection
            .reasons
            .iter()
            .any(|item| item.starts_with("margin_mode_not_allowed")));

        // ⑤ 入场价非法 + 市价滑点超限。
        let mut bad_entry = plan();
        bad_entry.entry_px = -1.0;
        let rejection = validate_round(bad_entry, &inputs).expect_err("入场价非法必须拒");
        assert!(rejection
            .reasons
            .iter()
            .any(|item| item.starts_with("entry_price_invalid")));
        let mut market = plan();
        market.order_type = "market".to_string();
        market.entry_px = 80_300.0;
        let rejection = validate_round(market, &inputs).expect_err("市价滑点超限必须拒");
        assert!(rejection
            .reasons
            .iter()
            .any(|item| item.starts_with("slippage_over_limit")));

        // ⑦ 时段 / 事件黑名单。
        let mut blackout = inputs;
        blackout.blackout_active = true;
        let rejection = validate_round(plan(), &blackout).expect_err("黑名单窗口必须拒");
        assert!(rejection
            .reasons
            .iter()
            .any(|item| item.starts_with("blackout_active")));
    }

    /// 降险动作（减仓/平仓）**不过开仓类限制**（止损位、风险、盈亏比、最小手数、黑名单），
    /// 但仍然要走同一条链路（LLM 写参数 → 这里的校验 → 按执行模式落地）。
    /// 这是"无旁路"与"不能把降险挡在门外"两条要求的交点。
    #[test]
    fn reduce_actions_skip_open_checks_but_never_bypass_the_pipeline() {
        let reduce = FastlanePlan {
            side: "long".to_string(),
            order_type: "reduce".to_string(),
            entry_px: 80_200.0,
            stop_px: 0.0,
            take_profit: Vec::new(),
            size_contracts: 0.001,
            risk_pct: 0.0,
            margin_mode: "cross".to_string(),
            invalidation: 0.0,
            reason_tags: vec!["de_risk".to_string()],
            confidence: 0.7,
        };
        let mut blackout_inputs = inputs();
        blackout_inputs.blackout_active = true;
        let validated = validate_round(reduce, &blackout_inputs)
            .expect("降险动作不得被止损位/风险/盈亏比/最小手数/黑名单挡住");
        assert_eq!(validated.plan().order_type, "reduce");
        // 但手数上限与保证金模式仍然管（防"降险"被当成绕过上限的借口）。
        let too_big = FastlanePlan {
            size_contracts: 10_000.0,
            ..validated.plan().clone()
        };
        let rejection = validate_round(too_big, &blackout_inputs).expect_err("超上限仍然拒");
        assert!(rejection
            .reasons
            .iter()
            .any(|item| item.starts_with("size_over_limit")));
    }

    /// **无旁路**：`ValidatedRound` 只能由 `validate_round` 构造（私有字段 + 唯一构造点）。
    /// 这条断言是 C29.6「不存在绕过校验/LLM 的执行路径」的编译期/结构保证。
    #[test]
    fn validated_round_can_only_be_built_by_validation() {
        let source = include_str!("fastlane.rs");
        // 拼接出构造 token，避免断言自身把计数抬高。
        let construction = "ValidatedRound { pl".to_string() + "an }";
        assert_eq!(
            source.matches(&construction).count(),
            1,
            "ValidatedRound 只能由 validate_round 构造：多出构造点就是旁路"
        );
        let public_field = "pub pl".to_string() + "an:";
        assert!(
            !source.contains(&public_field),
            "ValidatedRound.plan 必须私有，只能经 plan() 读取"
        );
        let impl_token = "impl Validated".to_string() + "Round";
        assert_eq!(
            source.matches(&impl_token).count(),
            1,
            "唯一实现里只应有 plan() 读取器"
        );
    }

    /// §8.2 预算闸门：每条限制都能单独命中，且都归到 `budget_exhausted`。
    #[test]
    fn budget_gate_blocks_every_limit() {
        let base = BudgetInputs {
            now: 1_000_000,
            last_run_at: Some(900_000),
            min_wake_interval_seconds: 10,
            runs_last_hour: 3,
            max_runs_per_hour: 120,
            daily_pnl_pct: 0.5,
            max_daily_loss_pct: 2.0,
            open_and_pending: 0,
            max_concurrent: 1,
            actions_last_minute: 0,
            max_actions_per_minute: 1,
        };
        assert_eq!(budget_block(&base), None);
        assert_eq!(
            budget_block(&BudgetInputs {
                last_run_at: Some(995_000),
                ..base
            }),
            Some("min_interval")
        );
        assert_eq!(
            budget_block(&BudgetInputs {
                runs_last_hour: 120,
                ..base
            }),
            Some("hourly_limit")
        );
        assert_eq!(
            budget_block(&BudgetInputs {
                daily_pnl_pct: -2.0,
                ..base
            }),
            Some("daily_loss_limit")
        );
        assert_eq!(
            budget_block(&BudgetInputs {
                open_and_pending: 1,
                ..base
            }),
            Some("concurrent_limit")
        );
        assert_eq!(
            budget_block(&BudgetInputs {
                actions_last_minute: 1,
                ..base
            }),
            Some("action_rate_limit")
        );
        assert!(is_known_watch_reason("budget_exhausted"));
        assert!(is_known_watch_reason("validation_failed"));
        assert!(!is_known_watch_reason("whatever"));
        // **C29.18**：入场质量门（纯代码判据）的三个观望码必须在冻结枚举里（UI 按码渲染文案，
        // 缺一码会退化成英文原码）；`low_quality` **保留**（老记录仍会出现），
        // 但代码侧自 C29.18 起不再产生它。
        for reason in ["structure_unclear", "stop_not_placeable", "rr_below_floor"] {
            assert!(is_known_watch_reason(reason), "C29.18 观望码缺失：{reason}");
        }
        assert!(
            is_known_watch_reason("low_quality"),
            "老码必须保留（老记录 / 老侧车）"
        );
        assert_eq!(
            FASTLANE_WATCH_REASONS.len(),
            16,
            "观望原因枚举总数（13 + C29.18 的三个）"
        );
    }

    /// **C29.18**：入场质量门（几何 R:R 底线）的常量、夹取区间与「只读透传」契约。
    #[test]
    fn fastlane_entry_quality_gate_constants_and_passthrough() {
        // ① 默认值与区间（三处同源里 Rust 这一处）。
        assert_eq!(
            FASTLANE_DEFAULT_QUALITY_FLOOR, 1.2,
            "默认 1.2（宽起步，用户拍板）"
        );
        assert_eq!(FASTLANE_QUALITY_FLOOR_MIN, 0.5);
        assert_eq!(FASTLANE_QUALITY_FLOOR_MAX, 3.0);
        // ② clamp：下界 0.5 / 上界 3.0 / 区间内原样 / 非法值回落默认。
        for (input, expected) in [
            (-1.0, 0.5),
            (0.0, 0.5),
            (0.5, 0.5),
            (1.2, 1.2),
            (1.6, 1.6),
            (3.0, 3.0),
            (9.0, 3.0),
        ] {
            let clamped = FastlaneConfig {
                quality_floor: input,
                ..FastlaneConfig::default()
            }
            .normalized();
            assert_eq!(
                clamped.quality_floor, expected,
                "quality_floor({input}) → {expected}"
            );
        }
        let nan = FastlaneConfig {
            quality_floor: f64::NAN,
            ..FastlaneConfig::default()
        }
        .normalized();
        assert_eq!(nan.quality_floor, FASTLANE_DEFAULT_QUALITY_FLOOR);
        // ③ 侧车回传的 `gate.entryQuality` **原样透传**（Rust 不重算、不改字段）；
        //    `quality` 只是观察量：给了就留痕、没给字段不出现（绝不写成 0.0）。
        let result: FastlaneSidecarResult = serde_json::from_value(json!({
            "ok": true,
            "jev": { "action": "open_long", "confidence": null, "latencyMs": 700, "attempts": 1 },
            "gate": {
                "ok": false,
                "reasons": ["stop_not_placeable"],
                "appliedTo": "open",
                "bypassedFor": null,
                "entryQuality": {
                    "applicable": true,
                    "direction": "long",
                    "structure_ok": true,
                    "stop_placeable": false,
                    "rr_ok": null,
                    "rr_floor": 1.2,
                    "reasons": ["stop_not_placeable"],
                    "stop_distance_atr": 0.12
                }
            },
            "action": { "kind": "watch", "reason": "stop_not_placeable" }
        }))
        .expect("deserialize sidecar result with entryQuality");
        let record = FastlaneRecord::from_sidecar(
            FastlaneTrigger {
                source: "condition".to_string(),
                condition_type: None,
                params: None,
            },
            GateOutcome::pass(),
            &result,
            10,
            4,
        );
        let gate = record.gate.clone();
        assert!(!gate.ok);
        assert_eq!(gate.reasons, vec!["stop_not_placeable".to_string()]);
        let entry = gate.entry_quality.clone().expect("entryQuality 必须透传");
        assert_eq!(entry["stop_placeable"], json!(false));
        assert_eq!(entry["rr_floor"], json!(1.2));
        assert_eq!(entry["reasons"], json!(["stop_not_placeable"]));
        let jev = record.jev.clone().expect("jev");
        assert_eq!(jev.quality, None, "没给 quality → 字段缺省（不是 0.0）");
        let serialized = record.to_value();
        assert!(
            serialized["jev"].get("quality").is_none(),
            "缺失的观察量不得序列化出占位值（UI 显示 `--`）"
        );
        assert_eq!(
            serialized["gate"]["entryQuality"]["stop_distance_atr"],
            json!(0.12),
            "Rust 只读透传，不改侧车读数"
        );
        // ④ 老侧车（没有 entryQuality / quality 缺键）→ 行为不变。
        let legacy: FastlaneSidecarResult = serde_json::from_value(json!({
            "ok": true,
            "jev": { "action": "观望", "quality": 1.61, "confidence": 0.7, "latencyMs": 700, "attempts": 1 }
        }))
        .expect("deserialize legacy sidecar result");
        let legacy_record = FastlaneRecord::from_sidecar(
            FastlaneTrigger {
                source: "condition".to_string(),
                condition_type: None,
                params: None,
            },
            GateOutcome::pass(),
            &legacy,
            10,
            4,
        );
        assert!(legacy_record.gate.entry_quality.is_none());
        assert_eq!(
            legacy_record.jev.as_ref().expect("jev").quality,
            Some(1.61),
            "老响应带的 quality 照原样留痕（只观察）"
        );
    }

    /// C29.7 记录形状：六组齐备 + `recordKind`，观望/停机/开仓三种动作都写得出来。
    #[test]
    fn fastlane_record_matches_the_frozen_shape() {
        let record = FastlaneRecord::new(FastlaneTrigger {
            source: "condition".to_string(),
            condition_type: Some("price_cross".to_string()),
            params: Some(json!({ "instId": "BTC-USDT-SWAP", "px": 80_000.0 })),
        })
        .watch("low_quality");
        let value = record.to_value();
        for group in [
            "recordKind",
            "trigger",
            "gate",
            "action",
            "timing",
            "tokens",
        ] {
            assert!(value.get(group).is_some(), "缺少分组：{group}");
        }
        assert_eq!(value["recordKind"], "fastlane");
        assert_eq!(value["trigger"]["source"], "condition");
        assert_eq!(value["trigger"]["conditionType"], "price_cross");
        assert_eq!(value["action"]["kind"], "watch");
        assert_eq!(value["action"]["reason"], "low_quality");
        // 分段耗时与 token 必须落库（验收 P50 ≤ 3s 的唯一依据）。
        let timing = FastlaneTiming {
            fetch_ms: 40,
            jev_ms: 750,
            llm_ms: 900,
            code_ms: 5,
            total_ms: 1_695,
        };
        let tokens = FastlaneTokens {
            jev_in: Some(1_200),
            jev_out: Some(30),
            llm_in: Some(2_400),
            llm_out: Some(300),
        };
        let record = FastlaneRecord {
            timing,
            tokens,
            jev: Some(FastlaneJev {
                action: "观望".to_string(),
                action_raw: Some("观望".to_string()),
                probabilities: json!({ "观望": 0.94 }),
                confidence: 0.93,
                // C29.18：`quality` 是观察量（`Option`）——这一条测试向量带值，照原样留痕。
                quality: Some(2.0),
                // 变更 B（2026-09-21）：拉分臂字段在旧形状记录里全部缺省。
                long_score: None,
                short_score: None,
                entry_score_floor: None,
                entry_score_decision: None,
                // C29.14（2026-09-21）：降险臂字段同样缺省。
                reduce_score: None,
                reduce_score_floor: None,
                reduce_score_decision: None,
                reduce_position_fact: None,
                confidence_source: None,
                latency_ms: 750,
                attempts: 1,
                raw: Value::Null,
                skipped: false,
                reason: None,
                error: None,
                status: None,
                failure_kind: None,
                hint: None,
            }),
            llm: Some(FastlaneLlm {
                latency_ms: 900,
                params: None,
                validation: ValidationRejection {
                    ok: true,
                    reasons: Vec::new(),
                },
                opportunity_id: None,
                wake_conditions: 2,
                model: Some("deepseek-v4-flash".to_string()),
                attempts: Some(1),
            }),
            ..record
        };
        let value = record.to_value();
        assert_eq!(value["timing"]["totalMs"], 1_695);
        assert_eq!(value["tokens"]["jevIn"], 1_200);
        assert_eq!(value["tokens"]["llmOut"], 300);
        assert_eq!(value["jev"]["confidence"], 0.93);
        assert_eq!(value["llm"]["validation"]["ok"], true);
        assert_eq!(value["llm"]["wakeConditions"], 2);
        // 停机记录。
        let killed = FastlaneRecord::new(FastlaneTrigger {
            source: "manual".to_string(),
            condition_type: None,
            params: None,
        })
        .kill_switch("user_kill_switch");
        assert_eq!(killed.to_value()["action"]["kind"], "kill_switch");
        // 开仓记录带机会 ID。
        let opened = FastlaneRecord::new(FastlaneTrigger {
            source: "silence".to_string(),
            condition_type: None,
            params: None,
        })
        .with_action("opportunity", Some("opp-1".to_string()));
        assert_eq!(opened.to_value()["action"]["opportunityId"], "opp-1");
    }

    fn snapshot_inputs() -> SnapshotInputs {
        SnapshotInputs {
            inst_id: "BTC-USDT-SWAP".to_string(),
            ticker: Some(SnapshotSlot::new(
                json!({ "last": 80_298.3, "chg5mPct": -0.05, "chg1hPct": -0.18, "chg24hPct": -1.13,
                        "high24h": 81_930.0, "low24h": 80_100.0, "open24h": 81_212.4 }),
                999_500,
            )),
            orderbook: Some(SnapshotSlot::new(
                json!({ "bids": [[80_000.0, 2.0]], "asks": [[80_002.0, 1.0]] }),
                999_000,
            )),
            // 6,000 根 1m ≈ 4.2 天：够 4H 的 ATR14 与 24 根结构窗口（生产侧同样需要 ≥4 天）。
            candles_1m: Some(SnapshotSlot::new(bars_1m(6_000, 960_000_000), 999_900)),
            derivatives: Some(SnapshotSlot::new(
                json!({ "fundingRate": 0.0001, "fundingNextMs": 1_789_948_800_000_i64, "markPx": 80_290.1,
                        "idxPx": 80_325.5, "basisPct": -0.0441, "oiUsd": 2_462_780_366.0,
                        "oiChange1hPct": -0.23 }),
                999_800,
            )),
            account: Some(SnapshotSlot::new(
                json!({ "usdtEquity": 10_000.0, "availableUsdt": 9_926.4,
                        "snapshot": { "positions": [ { "instId": "BTC-USDT-SWAP", "posSide": "long",
                                                        "pos": 1.0, "avgPx": 80_000.0, "uplRatioPct": 1.2 } ],
                                      "openOrders": [ { "side": "sell", "px": 80_600.0, "sz": 0.02, "state": "live" } ] } }),
                999_000,
            )),
            taker_buy_ratio_5m: Some(0.58),
            instrument: StateInstrument {
                tick_size: 0.1,
                lot_size: 1.0,
                min_size: 0.01,
                contract_value: "1 张 = 0.01 BTC".to_string(),
                max_leverage: 100,
                ct_val: 0.01,
            },
            limits: StateLimits {
                target_leverage: 20,
                max_single_trade_margin_pct: 30,
            },
            events: Vec::new(),
            recent: Vec::new(),
        }
    }

    /// B2 装配：① 各块齐全 → 字段映射逐条对上、`data_age_ms` 与来源时间同源、gate 通过。
    #[test]
    fn assemble_snapshot_maps_every_block_from_real_inputs() {
        let as_of = 1_000_000;
        let snapshot = assemble_snapshot(&snapshot_inputs(), as_of);
        // 字段映射（逐字段断言，防以后改名漂移）。
        assert_eq!(snapshot.price.last, 80_298.3);
        assert_eq!(snapshot.price.chg_24h_pct, -1.13);
        assert_eq!(snapshot.price.high_24h, 81_930.0);
        assert_eq!(snapshot.derivatives.mark_price, 80_290.1);
        assert_eq!(snapshot.derivatives.index_price, 80_325.5);
        assert_eq!(snapshot.derivatives.funding_next_ms, 1_789_948_800_000);
        assert_eq!(snapshot.account.equity_usdt, 10_000.0);
        assert_eq!(snapshot.account.available_usdt, 9_926.4);
        assert_eq!(
            snapshot.account.positions.len(),
            1,
            "快照 snapshot.positions → state.account.positions"
        );
        assert_eq!(snapshot.account.positions[0].side, "long");
        assert_eq!(snapshot.account.open_orders.len(), 1);
        assert_eq!(snapshot.account.open_orders[0].px, 80_600.0);
        // 实时盘口 → micro 真值；ATR/结构由 1m 聚合而来（样本充足 → 全部可用）。
        assert!(snapshot.micro.is_available());
        assert!(snapshot.volatility.atr14_5m.is_some());
        assert!(snapshot.volatility.atr14_1h.is_some());
        assert!(snapshot.volatility.atr14_4h.is_some());
        assert!(snapshot.structure.tf_15m.is_available());
        assert!(snapshot.structure.tf_1h.is_available());
        assert_ne!(snapshot.volatility.regime, "unknown");
        assert_eq!(snapshot.instrument.max_leverage, 100);
        assert_eq!(snapshot.limits.target_leverage, 20);

        // `data_age_ms` 与**各块来源时间**同源（不是读取时刻）。
        let state = snapshot.to_state(as_of);
        assert_eq!(state["data_age_ms"]["ticker"], 500);
        assert_eq!(state["data_age_ms"]["orderbook"], 1_000);
        assert_eq!(state["data_age_ms"]["candles_1m_closed"], 100);
        assert_eq!(state["data_age_ms"]["derivatives"], 200);
        assert_eq!(state["data_age_ms"]["account"], 1_000);
        // 代码门通过（含可用性检查）。
        let fresh = snapshot.source_times().age_ms(as_of);
        assert!(evaluate_gate(&fresh, &snapshot, &[], &DEFAULT_MAX_DATA_AGE_MS).ok);
    }

    /// B2 装配：② 缺 1m 样本 → 三个周期与 ATR 全 `null`（**不给 0**），gate 判 `data`；
    /// ③ 账户/衍生品/ticker 缺失 → 数值 `NaN`（不可用）而非 0，且不 panic。
    #[test]
    fn assemble_snapshot_leaves_missing_blocks_unavailable() {
        let as_of = 1_000_000;
        let mut inputs = snapshot_inputs();
        inputs.candles_1m = None;
        let snapshot = assemble_snapshot(&inputs, as_of);
        assert!(!snapshot.structure.tf_15m.is_available());
        assert!(!snapshot.structure.tf_4h.is_available());
        assert_eq!(
            snapshot.volatility.atr14_5m, None,
            "样本不足 → null，不是 0"
        );
        assert_eq!(snapshot.volatility.regime, "unknown");
        let state = snapshot.to_state(as_of);
        assert!(state["structure"]["tf_1h"]["window_high"].is_null());
        assert!(state["volatility"]["atr14_1h"].is_null());
        assert_eq!(state["data_age_ms"]["candles_1m_closed"], i64::MAX);
        let gate = evaluate_gate(
            &snapshot.source_times().age_ms(as_of),
            &snapshot,
            &[],
            &DEFAULT_MAX_DATA_AGE_MS,
        );
        assert_eq!(gate.watch_reason(), Some("data"));

        // 账户 + 衍生品 + ticker 全缺：不 panic，数值是不可用的 NAN（不是 0）。
        let mut bare = snapshot_inputs();
        bare.account = None;
        bare.derivatives = None;
        bare.ticker = None;
        let snapshot = assemble_snapshot(&bare, as_of);
        assert!(snapshot.account.equity_usdt.is_nan());
        assert!(snapshot.derivatives.mark_price.is_nan());
        assert!(snapshot.price.last.is_nan());
        assert!(snapshot.account.positions.is_empty());
        let state = snapshot.to_state(as_of);
        assert_eq!(state["data_age_ms"]["account"], i64::MAX);
        assert_eq!(state["data_age_ms"]["derivatives"], i64::MAX);
        assert_eq!(
            evaluate_gate(
                &snapshot.source_times().age_ms(as_of),
                &snapshot,
                &[],
                &DEFAULT_MAX_DATA_AGE_MS
            )
            .watch_reason(),
            Some("data")
        );
    }

    /// C29.7（三线字段审计）：载荷必须覆盖**侧车真正读取的键**（20 个 = 18 + 变更 B 的入场分门槛
    /// + C29.17 的降险分门槛），尤其 `fastlane_llm_model`（两者都空侧车整轮失败）与 `fastlane_jev_base_url`。
    #[test]
    fn sidecar_payload_covers_every_key_the_sidecar_reads() {
        let value = sidecar_config_value(&FastlaneConfig::default(), "deepseek-v4-flash");
        let object = value.as_object().expect("config object");
        assert_eq!(object.len(), 20, "{object:?}");
        assert_eq!(value["fastlane_llm_model"], "deepseek-v4-flash");
        assert_eq!(value["fastlane_jev_base_url"], "https://api.typesafe.ai");
        // 变更 B（2026-09-21）：入场分门槛必须真的下发（否则侧车回落它自己的默认 → 改了配置不生效）。
        assert_eq!(value["fastlane_entry_score_floor"], 1.5);
        // C29.17（2026-09-21）：降险分门槛是**独立下发键**（只改这一个 → 只影响降险臂）。
        assert_eq!(value["fastlane_reduce_score_floor"], 1.5);
        // 两条线各自独立下发：改一个**不得**跟着改另一个（否则"解耦"只是字面上的）。
        let split = FastlaneConfig {
            entry_score_floor: 2.0,
            reduce_score_floor: 1.0,
            ..FastlaneConfig::default()
        };
        let split_value = sidecar_config_value(&split, "deepseek-v4-flash");
        assert_eq!(split_value["fastlane_entry_score_floor"], 2.0);
        assert_eq!(
            split_value["fastlane_reduce_score_floor"], 1.0,
            "两条门槛必须能分别下发"
        );
        // 侧车读取键全部有我产出的来源（逐键点名，防以后改名漂移）。
        for key in [
            "fastlane_llm_model",
            "fastlane_jev_base_url",
            "fastlane_style_preset",
            "fastlane_style",
            "fastlane_risk_per_trade_pct",
            "fastlane_max_daily_loss_pct",
            "fastlane_max_concurrent",
            "fastlane_max_slippage_bps",
            "fastlane_max_actions_per_minute",
            "fastlane_quality_floor",
            "fastlane_entry_score_floor",
            "fastlane_reduce_score_floor",
            "fastlane_confidence_floor",
            "fastlane_event_blackout_minutes",
            "fastlane_trading_hours",
            "fastlane_notify_policy",
            "fastlane_jev_model",
            "fastlane_jev_timeout_ms",
            "fastlane_llm_timeout_ms",
            "fastlane_llm_reasoning_effort",
        ] {
            assert!(object.contains_key(key), "载荷缺少侧车读取键：{key}");
        }
        // 模型名两侧去空格；空模型原样下发（调用方负责给 Profile/全局模型）。
        let blank = sidecar_config_value(&FastlaneConfig::default(), "   ");
        assert_eq!(blank["fastlane_llm_model"], "");
        // 私有部署端点覆盖。
        let private = FastlaneConfig {
            jev_base_url: "https://jev.internal.example".to_string(),
            ..FastlaneConfig::default()
        };
        assert_eq!(
            sidecar_config_value(&private, "m")["fastlane_jev_base_url"],
            "https://jev.internal.example"
        );
    }

    /// C29.7（审计回填）：`fastlane_trading_hours` **有执行点** ——
    /// 不在时段内 → 观望 `session_closed`（注入当前小时，边界逐条断言）。
    #[test]
    fn trading_hours_has_an_execution_point() {
        for hour in 0..24 {
            assert!(trading_session_allows("24h", hour), "24h 恒放行");
            assert_eq!(session_watch_reason("24h", hour), None);
        }
        for hour in 8..20 {
            assert!(trading_session_allows("day", hour), "day 应放行 {hour} 点");
            assert!(
                session_watch_reason("night", hour).is_some(),
                "night 应拦 {hour} 点"
            );
        }
        for hour in (20..24).chain(0..8) {
            assert!(
                trading_session_allows("night", hour),
                "night 应放行 {hour} 点"
            );
            assert_eq!(session_watch_reason("day", hour), Some("session_closed"));
        }
        // 边界值：8 点与 20 点分属两边。
        assert!(trading_session_allows("day", 8));
        assert!(!trading_session_allows("day", 20));
        assert!(trading_session_allows("night", 20));
        assert!(!trading_session_allows("night", 8));
        // 非法值已被归一回落 → 放行；枚举里也有 `session_closed`。
        assert!(trading_session_allows("weekend", 3));
        assert!(is_known_watch_reason("session_closed"));
    }

    /// C29.7：两处边界形状**不同且都冻结** —— Profile 线是扁平 camelCase，
    /// 快判载荷给侧车的是 snake_case 前缀 `fastlane_*`（侧车按此实现）。
    #[test]
    fn sidecar_config_uses_snake_case_keys() {
        let value = sidecar_config_value(&FastlaneConfig::default(), "test-model");
        let object = value.as_object().expect("config object");
        for key in [
            "fastlane_style_preset",
            "fastlane_style",
            "fastlane_risk_per_trade_pct",
            "fastlane_max_daily_loss_pct",
            "fastlane_max_concurrent",
            "fastlane_max_slippage_bps",
            "fastlane_max_actions_per_minute",
            "fastlane_quality_floor",
            "fastlane_entry_score_floor",
            "fastlane_reduce_score_floor",
            "fastlane_confidence_floor",
            "fastlane_event_blackout_minutes",
            "fastlane_trading_hours",
            "fastlane_notify_policy",
            "fastlane_jev_model",
            "fastlane_jev_timeout_ms",
            "fastlane_llm_timeout_ms",
            "fastlane_llm_reasoning_effort",
            "fastlane_llm_model",
            "fastlane_jev_base_url",
        ] {
            assert!(object.contains_key(key), "载荷缺少键：{key}");
        }
        assert_eq!(object.len(), 20, "只发这 20 个键：{object:?}");
        assert!(
            object
                .keys()
                .all(|key| key.starts_with("fastlane_") && !key.chars().any(char::is_uppercase)),
            "载荷键必须全是 snake_case 前缀：{object:?}"
        );
        assert_eq!(value["fastlane_llm_reasoning_effort"], "none");
        assert_eq!(value["fastlane_style_preset"], "long_pullback");
        assert_eq!(value["fastlane_trading_hours"], "24h");
    }

    fn bars_1m(count: usize, start_ms: i64) -> Vec<Bar> {
        (0..count)
            .map(|index| {
                let base = 80_000.0 + index as f64;
                Bar {
                    t: start_ms + index as i64 * 60_000,
                    o: base,
                    h: base + 20.0,
                    l: base - 20.0,
                    c: base + 5.0,
                    v: 1.0,
                }
            })
            .collect()
    }

    /// `Vec<Bar>` → 缓存里那份 1m K 线 JSON（`bars_from_values` 认的键）。
    fn bar_values(bars: &[Bar]) -> Vec<Value> {
        bars.iter()
            .map(|bar| {
                json!({ "time": bar.t, "open": bar.o, "high": bar.h, "low": bar.l,
                        "close": bar.c, "volume": bar.v, "confirm": true })
            })
            .collect()
    }

    /// 多周期聚合周期口径（与探针 `fastlane-shadow-probe.mjs` 同算法）：
    /// 分桶 OHLC（首开/极值/末收/量求和）。
    #[test]
    fn aggregate_bars_matches_probe_convention() {
        let bars = vec![
            Bar {
                t: 0,
                o: 10.0,
                h: 12.0,
                l: 9.0,
                c: 11.0,
                v: 1.0,
            },
            Bar {
                t: 60_000,
                o: 11.0,
                h: 15.0,
                l: 10.5,
                c: 14.0,
                v: 2.0,
            },
            Bar {
                t: 120_000,
                o: 14.0,
                h: 14.5,
                l: 8.0,
                c: 9.0,
                v: 3.0,
            },
            Bar {
                t: 300_000,
                o: 9.0,
                h: 10.0,
                l: 8.5,
                c: 9.5,
                v: 4.0,
            },
        ];
        let five = aggregate_bars(&bars, 5);
        assert_eq!(five.len(), 2);
        assert_eq!(five[0].t, 0);
        assert_eq!(five[0].o, 10.0, "开盘取桶内第一根");
        assert_eq!(five[0].h, 15.0, "最高取极值");
        assert_eq!(five[0].l, 8.0, "最低取极值");
        assert_eq!(five[0].c, 9.0, "收盘取最后一根");
        assert_eq!(five[0].v, 6.0, "成交量求和");
        assert_eq!(five[1].t, 300_000);
        // 1m 原样返回；空数组不炸。
        assert_eq!(aggregate_bars(&bars, 1).len(), 4);
        assert!(aggregate_bars(&[], 5).is_empty());
        // 15m / 4H 同口径。
        assert_eq!(aggregate_bars(&bars, 15).len(), 1);
        assert_eq!(aggregate_bars(&bars, 240).len(), 1);
    }

    /// 数据不足必须**标不可用**（`None` / `null`），不许给 0；盘口缺失同样不可用。
    #[test]
    fn insufficient_data_is_unavailable_never_zero() {
        // ATR：样本 < 15 根 → None（不是 0）。
        assert_eq!(atr14(&bars_1m(14, 0)), None);
        let atr = atr14(&bars_1m(40, 0)).expect("样本充足时算出 ATR");
        assert!(atr > 0.0);

        // 结构：窗口不足 4 根 → None（该周期整体不可用）。
        assert!(structure_view(&bars_1m(3, 0), 4).is_none());
        assert!(
            structure_view(&bars_1m(10, 0), 60).is_none(),
            "样本少于窗口长度"
        );
        let view = structure_view(&bars_1m(120, 0), 60).expect("样本充足时给出结构");
        assert!(view.is_available());
        assert!(view.range_pos.expect("range_pos") >= 0.0);
        // 不可用形态：数值全是 null、趋势 unknown（不是 0）。
        let unavailable = StateTimeframe::unavailable();
        assert!(!unavailable.is_available());
        assert_eq!(unavailable.trend, "unknown");
        assert!(unavailable.window_high.is_none());

        // micro：没有盘口 / 没有主动买卖比 → None（禁止用落盘表或推算值凑）。
        assert!(micro_from_orderbook(&json!({}), Some(0.5)).is_none());
        assert!(micro_from_orderbook(&json!({ "bids": [], "asks": [] }), Some(0.5)).is_none());
        let book = json!({
            "bids": [[80_000.0, 2.0], [79_990.0, 1.0]],
            "asks": [[80_002.0, 1.0], [80_010.0, 3.0]]
        });
        assert!(
            micro_from_orderbook(&book, None).is_none(),
            "缺主动买卖比 → 整个 micro 不可用"
        );
        let micro = micro_from_orderbook(&book, Some(0.58)).expect("实时盘口可算");
        assert!(micro.spread_bps.expect("spread") > 0.0);
        // 盘口失衡取**最优档**：买 2 张 vs 卖 1 张 → (2-1)/3。
        assert!(
            (micro.bid_ask_imbalance.expect("imbalance") - 1.0 / 3.0).abs() < 1e-9,
            "{:?}",
            micro.bid_ask_imbalance
        );
        assert!(micro.depth_5bps_usd.expect("depth") > 0.0);
        assert_eq!(micro.taker_buy_ratio_5m, Some(0.58));
    }

    /// C29（董事会口径）：盘口不可用时 **`micro` 对象保留、字段全 `null`**（不整键消失），
    /// 与 `data_age_ms.orderbook = i64::MAX` 一致表达"不可用"；既不崩、也绝不当 0 参与判断。
    ///
    /// 门的分层（lead 裁决 2026-09-20）：`micro`/`orderbook` 是**可选**块 → 只在 `reasons`
    /// 留痕、不拦轮；**结构周期与 `atr14_*` 仍拦**（属于必需块 `candles_1m_closed` 的能力）。
    #[test]
    fn unavailable_blocks_keep_shape_and_only_required_ones_block() {
        // 装配：无盘口 / 缺主动买卖比 → 对象在、值全 null。
        for (book, ratio) in [
            (None, Some(0.6)),
            (Some(json!({})), Some(0.6)),
            (
                Some(json!({ "bids": [[1.0, 1.0]], "asks": [[2.0, 1.0]] })),
                None,
            ),
        ] {
            let micro = micro_block(book.as_ref(), ratio);
            assert!(!micro.is_available());
            let value = serde_json::to_value(&micro).expect("serialize micro");
            for key in [
                "spread_bps",
                "bid_ask_imbalance",
                "depth_5bps_usd",
                "taker_buy_ratio_5m",
            ] {
                assert!(value.get(key).is_some(), "键必须保留：{key}");
                assert!(value[key].is_null(), "不可用时必须是 null 而不是 0：{key}");
            }
        }
        // 盘口可用 → 真值。
        let book = json!({ "bids": [[80_000.0, 2.0]], "asks": [[80_002.0, 1.0]] });
        assert!(micro_block(Some(&book), Some(0.58)).is_available());

        // 代码门（lead 裁决 2026-09-20）：`micro` 是**可选**块的能力 →
        // 不可用**不拦轮**（冷启动/成交流稀疏时它天然为 null），但必须在 `reasons` 留痕。
        let fresh = DataAges {
            ticker: 0,
            orderbook: 1_000,
            candles_1m_closed: 60_000,
            derivatives: 30_000,
            account: 1_000,
        };
        let mut snapshot = tests_snapshot();
        snapshot.micro = StateMicro::unavailable();
        let gate = evaluate_gate(&fresh, &snapshot, &[], &DEFAULT_MAX_DATA_AGE_MS);
        assert!(gate.ok, "micro 不可用不得拦轮");
        assert_eq!(gate.watch_reason(), None);
        assert!(gate.data.is_none());
        assert!(
            gate.reasons
                .iter()
                .any(|note| note.contains("micro") && note.contains("可选，不拦轮")),
            "{:?}",
            gate.reasons
        );

        // 结构不可用（周期样本不足 → null）→ **仍然拦**（属于必需块 `candles_1m_closed` 的能力）。
        snapshot.micro = StateMicro {
            spread_bps: Some(1.2),
            bid_ask_imbalance: Some(0.3),
            depth_5bps_usd: Some(1_000.0),
            taker_buy_ratio_5m: Some(0.5),
        };
        snapshot.structure.tf_4h = StateTimeframe::unavailable();
        assert_eq!(
            evaluate_gate(&fresh, &snapshot, &[], &DEFAULT_MAX_DATA_AGE_MS).watch_reason(),
            Some("data")
        );

        // ATR 不可得（样本不足）→ 也是 data。
        snapshot.structure.tf_4h = tests_snapshot().structure.tf_4h;
        let mut with_missing_atr = snapshot.clone();
        with_missing_atr.volatility.atr14_1h = None;
        assert_eq!(
            evaluate_gate(&fresh, &with_missing_atr, &[], &DEFAULT_MAX_DATA_AGE_MS).watch_reason(),
            Some("data")
        );
        // 全部可用 → 通过（回归）。
        assert!(evaluate_gate(&fresh, &snapshot, &[], &DEFAULT_MAX_DATA_AGE_MS).ok);
    }

    /// C29 约束 c：`data_age_ms` 必须来自**真实来源时间**（读取时刻顶替就是 bug）；
    /// 约束 b：自起的公开流订阅要被释放，复用别人的订阅时什么都不做。
    #[test]
    fn snapshot_cache_tracks_source_times_and_releases_only_its_own_stream() {
        let mut cache = FastlaneSnapshotCache::new("account-1", "BTC-USDT-SWAP");
        // 五个块各自的来源时间**不同**（正是要如实反映的情形）。
        cache.ticker = Some(SnapshotSlot::new(json!({ "last": 80_298.3 }), 999_500));
        cache.orderbook = Some(SnapshotSlot::new(json!({ "asks": [] }), 999_000));
        cache.candles_1m = Some(SnapshotSlot::new(vec![json!({ "c": 80_300.0 })], 960_000));
        cache.derivatives = Some(SnapshotSlot::new(json!({ "fundingRate": 0.0001 }), 940_000));
        cache.account = Some(SnapshotSlot::new(json!({ "equityUsdt": 10.0 }), 998_000));

        let ages = cache.ages(1_000_000);
        assert_eq!(ages.ticker, 500, "按来源时间算，不是按读取时刻");
        assert_eq!(ages.orderbook, 1_000);
        assert_eq!(ages.candles_1m_closed, 40_000);
        assert_eq!(ages.derivatives, 60_000);
        assert_eq!(ages.account, 2_000);
        assert!(cache.fresh_enough(1_000_000, &DEFAULT_MAX_DATA_AGE_MS));

        // 超过任一块阈值 → 不新鲜（代码门会记 `data`）。
        let stale = DataAges {
            ticker: 100,
            ..DEFAULT_MAX_DATA_AGE_MS
        };
        assert!(
            !cache.fresh_enough(1_000_000, &stale),
            "ticker 500ms > 100ms"
        );

        // 缺块 / 来源时间为 0 → 年龄 i64::MAX（视为不可用，绝不当成"新鲜"）。
        let missing = FastlaneSnapshotCache::new("account-1", "BTC-USDT-SWAP");
        assert_eq!(missing.ages(1_000_000).derivatives, i64::MAX);
        assert!(!missing.fresh_enough(1_000_000, &DEFAULT_MAX_DATA_AGE_MS));
        // 来源时间在未来（时钟漂移）→ 也判不可用，不出现负数年龄。
        let future = SnapshotSlot::new(json!({}), 2_000_000);
        assert_eq!(future.age_ms(1_000_000), i64::MAX);

        // 订阅归属：复用时不动别人的订阅；自起时释放一次且只释放一次。
        assert!(
            !cache.release_public_stream(),
            "复用了图表消费者的订阅 → 什么都不做"
        );
        cache.owns_public_stream = true;
        assert!(cache.release_public_stream(), "自起的订阅必须被释放");
        assert!(!cache.release_public_stream(), "不重复释放（幂等）");
        assert!(!cache.owns_public_stream);
    }

    /// §4 state：字段名照抄设计文档，`data_age_ms` 每块都有，内部字段不下发。
    #[test]
    fn state_json_matches_the_design_schema() {
        let state = tests_snapshot().to_state(1_000_000);
        assert!(state.get("source_times").is_none(), "内部字段不得下发");
        let ages = state["data_age_ms"].as_object().expect("data_age_ms");
        for block in [
            "ticker",
            "orderbook",
            "candles_1m_closed",
            "derivatives",
            "account",
        ] {
            assert!(ages.contains_key(block), "缺少 {block} 的新鲜度");
        }
        // 每块都算出了年龄（999_000ms 前的时间戳）。
        assert_eq!(state["data_age_ms"]["ticker"], 999_000);
        for key in [
            "as_of",
            "inst_id",
            "instrument",
            "price",
            "micro",
            "volatility",
            "structure",
            "derivatives",
            "events",
            "account",
            "limits",
            "recent",
        ] {
            assert!(state.get(key).is_some(), "state 缺少字段：{key}");
        }
        // micro 必须是实时盘口（点差/失衡/深度/主动买卖比）。
        for key in [
            "spread_bps",
            "bid_ask_imbalance",
            "depth_5bps_usd",
            "taker_buy_ratio_5m",
        ] {
            assert!(state["micro"].get(key).is_some(), "micro 缺少：{key}");
        }
        assert_eq!(state["structure"]["tf_15m"]["trend"], "down");
        assert_eq!(state["instrument"]["max_leverage"], 100);
        // 完全没有来源时间（at<=0）→ 年龄是 i64::MAX（视为不可用，代码门会拦）。
        let unknown = DataAges::default().age_ms(1_000_000);
        assert_eq!(unknown.ticker, i64::MAX);
    }

    // ===== B1/B3：采集器 registry 的生命周期与防泄漏 =====

    #[derive(Default)]
    struct BeatCounter {
        started: std::sync::atomic::AtomicUsize,
        stopped: std::sync::atomic::AtomicUsize,
    }

    struct BeatDouble {
        counter: std::sync::Arc<BeatCounter>,
        stopped: std::sync::atomic::AtomicBool,
    }

    impl BeatDouble {
        fn new(counter: std::sync::Arc<BeatCounter>) -> Box<dyn FastlaneBeatHandle> {
            counter
                .started
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::new(Self {
                counter,
                stopped: std::sync::atomic::AtomicBool::new(false),
            })
        }
    }

    impl FastlaneBeatHandle for BeatDouble {
        fn stop(&self) -> bool {
            if self.stopped.swap(true, std::sync::atomic::Ordering::SeqCst) {
                return false;
            }
            self.counter
                .stopped
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            true
        }

        fn is_stopped(&self) -> bool {
            self.stopped.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    #[derive(Default)]
    struct LeaseCounter {
        released: std::sync::atomic::AtomicUsize,
    }

    struct LeaseDouble {
        counter: std::sync::Arc<LeaseCounter>,
        released: std::sync::atomic::AtomicBool,
    }

    impl LeaseDouble {
        fn new(counter: std::sync::Arc<LeaseCounter>) -> Box<dyn FastlaneStreamLease> {
            Box::new(Self {
                counter,
                released: std::sync::atomic::AtomicBool::new(false),
            })
        }
    }

    impl FastlaneStreamLease for LeaseDouble {
        fn release(&self) -> bool {
            if self
                .released
                .swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                return false;
            }
            self.counter
                .released
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            true
        }

        fn is_released(&self) -> bool {
            self.released.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    fn registry_instrument() -> StateInstrument {
        StateInstrument {
            tick_size: 0.1,
            lot_size: 1.0,
            min_size: 0.01,
            contract_value: "1 张 = 0.01 BTC".to_string(),
            max_leverage: 100,
            ct_val: 0.01,
        }
    }

    /// B3 防泄漏回归：反复「停机 → 启用 → 停机」N 次后，
    /// 条目数 = 活跃 Profile 数、自有订阅数 = 0、悬挂任务句柄 = 0；
    /// 计数替身证明**既没有漏停/漏释放，也没有重复释放**。
    #[test]
    fn registry_release_is_idempotent_and_leaks_nothing_across_restarts() {
        let beats = std::sync::Arc::new(BeatCounter::default());
        let leases = std::sync::Arc::new(LeaseCounter::default());
        let mut registry = FastlaneSnapshotRegistry::new();
        const CYCLES: usize = 5;
        for cycle in 1..=CYCLES {
            // 启用：起节拍任务 + 自起只订阅该 inst 的公开流。
            assert!(registry.ensure(
                "profile-1",
                "acct-1",
                "BTC-USDT-SWAP",
                registry_instrument(),
                false,
                true,
                BeatDouble::new(beats.clone()),
                Some(LeaseDouble::new(leases.clone())),
            ));
            assert_eq!(registry.len(), 1, "活跃快判 Profile 数 = registry 条目数");
            assert_eq!(registry.owned_stream_count(), 1);
            assert_eq!(registry.dangling_beat_count(), 1);

            // 停机（三处释放路径共用同一个入口）。
            assert!(registry.release("profile-1"));
            assert!(!registry.release("profile-1"), "释放必须幂等");
            assert_eq!(registry.len(), 0, "停机后 registry 必须摘干净");
            assert_eq!(registry.owned_stream_count(), 0, "停机后不得残留自有订阅");
            assert_eq!(
                registry.dangling_beat_count(),
                0,
                "停机后不得有悬挂任务句柄"
            );
            assert_eq!(
                beats.started.load(std::sync::atomic::Ordering::SeqCst),
                cycle,
                "每轮启用只起一个节拍任务"
            );
            assert_eq!(
                beats.stopped.load(std::sync::atomic::Ordering::SeqCst),
                cycle,
                "每轮停机恰好停一个节拍任务"
            );
            assert_eq!(
                leases.released.load(std::sync::atomic::Ordering::SeqCst),
                cycle,
                "每轮停机恰好释放一次自有订阅"
            );
        }
        assert_eq!(registry.active_profile_ids(), Vec::<String>::new());
    }

    /// 复用图表消费者的订阅时：不持有租约、释放**绝不动别人的订阅**。
    #[test]
    fn registry_reuse_does_not_release_the_chart_consumers_subscription() {
        let beats = std::sync::Arc::new(BeatCounter::default());
        let leases = std::sync::Arc::new(LeaseCounter::default());
        let mut registry = FastlaneSnapshotRegistry::new();
        assert!(registry.ensure(
            "profile-2",
            "acct-1",
            "BTC-USDT-SWAP",
            registry_instrument(),
            true,
            false,
            BeatDouble::new(beats.clone()),
            None,
        ));
        assert_eq!(
            registry.owned_stream_count(),
            0,
            "复用他人订阅 → 自有订阅数是 0"
        );
        assert!(registry
            .entry("profile-2")
            .is_some_and(|entry| entry.reuses_chart_stream));
        assert!(registry.release("profile-2"));
        // 没有租约 → 没有任何"释放别人订阅"的调用发生。
        assert_eq!(leases.released.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(registry.len(), 0);
    }

    /// 重复 `ensure` 不得起第二个任务/订阅：传进来的句柄必须当场收掉。
    #[test]
    fn registry_ensure_is_idempotent_and_stops_the_duplicate_handles() {
        let beats = std::sync::Arc::new(BeatCounter::default());
        let leases = std::sync::Arc::new(LeaseCounter::default());
        let mut registry = FastlaneSnapshotRegistry::new();
        assert!(registry.ensure(
            "profile-3",
            "acct-1",
            "BTC-USDT-SWAP",
            registry_instrument(),
            false,
            true,
            BeatDouble::new(beats.clone()),
            Some(LeaseDouble::new(leases.clone())),
        ));
        assert!(!registry.ensure(
            "profile-3",
            "acct-1",
            "BTC-USDT-SWAP",
            registry_instrument(),
            false,
            true,
            BeatDouble::new(beats.clone()),
            Some(LeaseDouble::new(leases.clone())),
        ));
        assert_eq!(registry.len(), 1);
        assert_eq!(beats.started.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(
            beats.stopped.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "重复的那份句柄被立刻停掉（不留悬挂任务）"
        );
        assert_eq!(
            leases.released.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "重复的那份租约被立刻释放（不留重复订阅）"
        );
        assert_eq!(registry.owned_stream_count(), 1, "原本那份订阅仍在");
        assert_eq!(registry.release_all(), 1);
        assert_eq!(registry.owned_stream_count(), 0);
        assert_eq!(registry.dangling_beat_count(), 0);
    }

    /// 五块写入：值 + **来源时间**逐块落进缓存，缺块保持 `None`（不塞 0）。
    #[test]
    fn registry_writes_every_block_with_its_source_time() {
        let beats = std::sync::Arc::new(BeatCounter::default());
        let mut registry = FastlaneSnapshotRegistry::new();
        registry.ensure(
            "profile-4",
            "acct-1",
            "BTC-USDT-SWAP",
            registry_instrument(),
            false,
            true,
            BeatDouble::new(beats.clone()),
            None,
        );
        assert!(registry.write(
            "profile-4",
            FastlaneBlock::Ticker(SnapshotSlot::new(json!({ "last": 80_298.3 }), 1_000))
        ));
        assert!(registry.write(
            "profile-4",
            FastlaneBlock::Orderbook(SnapshotSlot::new(json!({ "bids": [], "asks": [] }), 900))
        ));
        assert!(registry.write(
            "profile-4",
            FastlaneBlock::Candles1m(SnapshotSlot::new(
                vec![json!({ "time": 60_000, "open": 1.0,
                        "high": 2.0, "low": 0.5, "close": 1.5, "volume": 3.0, "confirm": true })],
                120_000
            ))
        ));
        assert!(registry.write(
            "profile-4",
            FastlaneBlock::Derivatives(SnapshotSlot::new(json!({ "fundingRate": 0.0001 }), 800))
        ));
        assert!(registry.write(
            "profile-4",
            FastlaneBlock::Account(SnapshotSlot::new(json!({ "usdtEquity": 10.0 }), 700))
        ));
        assert!(!registry.write(
            "profile-404",
            FastlaneBlock::Ticker(SnapshotSlot::new(json!({}), 1))
        ));
        assert!(registry.set_taker_ratio("profile-4", Some(0.61)));
        assert!(!registry.set_taker_ratio("profile-404", Some(0.5)));
        assert_eq!(
            registry
                .cache("profile-4")
                .and_then(|cache| cache.taker_buy_ratio_5m),
            Some(0.61)
        );
        let cache = registry.cache("profile-4").expect("cache");
        assert_eq!(cache.inst_id, "BTC-USDT-SWAP");
        assert_eq!(cache.account_id, "acct-1");
        assert_eq!(cache.ticker.as_ref().map(|slot| slot.at_ms), Some(1_000));
        assert_eq!(cache.orderbook.as_ref().map(|slot| slot.at_ms), Some(900));
        assert_eq!(
            cache.candles_1m.as_ref().map(|slot| slot.at_ms),
            Some(120_000)
        );
        assert_eq!(cache.derivatives.as_ref().map(|slot| slot.at_ms), Some(800));
        assert_eq!(cache.account.as_ref().map(|slot| slot.at_ms), Some(700));
        assert_eq!(
            cache.source_times(),
            DataAges {
                ticker: 1_000,
                orderbook: 900,
                candles_1m_closed: 120_000,
                derivatives: 800,
                account: 700
            }
        );
    }

    /// 来源时间口径：缺失 → 0；轻微超前（时钟偏移）→ 夹到 now；大幅超前 → 0（不可信）。
    #[test]
    fn snapshot_source_time_never_substitutes_the_read_clock() {
        assert_eq!(snapshot_source_time(0, 1_000_000), 0);
        assert_eq!(snapshot_source_time(-5, 1_000_000), 0);
        assert_eq!(snapshot_source_time(999_000, 1_000_000), 999_000);
        assert_eq!(snapshot_source_time(1_000_200, 1_000_000), 1_000_000);
        assert_eq!(
            snapshot_source_time(1_010_000, 1_000_000),
            0,
            "超前超过 5s = 时间戳不可信"
        );
    }

    /// 5 分钟主动买卖比：去重、滑窗淘汰、窗口空 → `None`（不是 0）。
    #[test]
    fn taker_window_tracks_the_live_trade_tape_only() {
        let mut window = TakerWindow::new();
        assert_eq!(window.ratio(1_000_000), None, "没有成交 → None");
        assert!(window.observe(999_000, "t1", "buy", 3.0));
        assert!(
            !window.observe(999_000, "t1", "buy", 3.0),
            "同一笔不重复计入"
        );
        assert!(window.observe(999_100, "t2", "sell", 1.0));
        assert!(
            !window.observe(999_200, "t3", "unknown", 5.0),
            "方向未知不计入"
        );
        let ratio = window.ratio(1_000_000).expect("ratio");
        assert!((ratio - 0.75).abs() < 1e-9, "{ratio}");
        assert_eq!(window.latest_ts(), Some(999_100));
        // 滑窗淘汰：窗口外那两笔全部过期 → 回到 None。
        assert_eq!(window.ratio(999_100 + TakerWindow::WINDOW_MS + 1), None);
        assert!(window.is_empty());
        // 批量喂入（`trades_by_inst` 的 JSON 形态）。
        let added = window.observe_trades(&[
            json!({ "tradeId": "t4", "side": "buy", "sz": "2", "ts": 1_300_000 }),
            json!({ "tradeId": "t4", "side": "buy", "sz": "2", "ts": 1_300_000 }),
            json!({ "tradeId": "t5", "side": "sell", "sz": "2", "ts": 1_300_100 }),
        ]);
        assert_eq!(added, 2, "同一 tradeId 只计一次");
        let ratio = window.ratio(1_300_200).expect("ratio");
        assert!((ratio - 0.5).abs() < 1e-9, "{ratio}");
    }

    /// 1m K 线 JSON → `Bar`：只取已收盘、缺 `confirm` 的旧形态按已收盘处理。
    #[test]
    fn bars_from_values_uses_closed_candles_only() {
        let values = vec![
            json!({ "time": 60_000, "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 3.0, "confirm": true }),
            json!({ "time": 120_000, "open": 1.5, "high": 2.5, "low": 1.0, "close": 2.0, "volume": 4.0, "confirm": true }),
            json!({ "time": 180_000, "open": 2.0, "high": 3.0, "low": 1.5, "close": 2.5, "volume": 5.0, "confirm": false }),
        ];
        let bars = bars_from_values(&values);
        assert_eq!(bars.len(), 2, "未收盘的最后一根不进结构/ATR");
        assert_eq!(bars[0].t, 60_000);
        assert_eq!(bars[1].c, 2.0);
        assert_eq!(last_closed_candle_close_ms(&values), Some(180_000));
        assert_eq!(last_closed_candle_close_ms(&[]), None);
    }

    /// 账户块归一化：既有工具输出（`balanceSemantics` + `snapshot`）与直出快照两种形态都要认，
    /// `uplRatio`（比率）→ `uplRatioPct`（百分数），来源时间取账户快照时间。
    #[test]
    fn account_block_normalization_maps_every_field() {
        let tool_value = json!({
            "source": "api",
            "ageMs": 12,
            "balanceSemantics": { "usdtEquity": 9.9264, "availableUsdt": 8.5 },
            "snapshot": {
                "accountId": "acct-1",
                "syncedAt": 999_000,
                "positions": [ { "instId": "BTC-USDT-SWAP", "posSide": "long", "pos": "1",
                                 "avgPx": "80000", "uplRatio": "0.0125" } ],
                "orders": [ { "side": "sell", "px": "80600", "sz": "0.02", "state": "live" } ]
            }
        });
        let (block, at_ms) = normalize_account_block(&tool_value).expect("account block");
        assert_eq!(at_ms, 999_000);
        assert_eq!(block["usdtEquity"], 9.9264);
        assert_eq!(block["availableUsdt"], 8.5);
        assert_eq!(block["snapshot"]["positions"][0]["posSide"], "long");
        assert_eq!(block["snapshot"]["positions"][0]["uplRatioPct"], 1.25);
        assert_eq!(block["snapshot"]["openOrders"][0]["px"], 80_600.0);
        // 装配侧真的读得到（不是"归一化完没人用"）。
        let mut cache = FastlaneSnapshotCache::new("acct-1", "BTC-USDT-SWAP");
        cache.account = Some(SnapshotSlot::new(block, at_ms));
        let mut inputs = snapshot_inputs();
        inputs.account = cache.account.clone();
        let snapshot = assemble_snapshot(&inputs, 1_000_000);
        assert_eq!(snapshot.account.equity_usdt, 9.9264);
        assert_eq!(snapshot.account.positions.len(), 1);
        assert_eq!(snapshot.account.open_orders.len(), 1);
        // 空壳（既没有权益也没有来源时间）→ 整块不可用。
        assert!(normalize_account_block(&json!({ "snapshot": {} })).is_none());
    }

    /// 衍生品块归一化：资金费率的字符串形态要认；没有既有实时来源的字段留 `null`（不塞 0）。
    #[test]
    fn derivatives_block_normalization_keeps_unavailable_fields_null() {
        let value = json!({
            "source": "memory",
            "ageMs": 1_200,
            "fundingRate": {
                "instId": "BTC-USDT-SWAP",
                "fundingRate": "0.00012",
                "nextFundingTime": 1_789_948_800_000_i64,
                "ts": 999_500
            }
        });
        let (block, at_ms) =
            normalize_derivatives_block(&value, 1_000_000).expect("derivatives block");
        assert_eq!(at_ms, 999_500);
        assert_eq!(block["fundingRate"], 0.00012);
        assert_eq!(block["fundingNextMs"], 1_789_948_800_000_i64);
        assert!(block["markPx"].is_null());
        assert!(block["oiUsd"].is_null());
        // 装配侧：资金费率有值、mark/OI 是 null（模型看到"未知"而不是 0）。
        let mut inputs = snapshot_inputs();
        inputs.derivatives = Some(SnapshotSlot::new(block, at_ms));
        let snapshot = assemble_snapshot(&inputs, 1_000_000);
        assert_eq!(snapshot.derivatives.funding_rate, 0.00012);
        assert_eq!(snapshot.derivatives.funding_next_ms, 1_789_948_800_000);
        assert!(
            snapshot.derivatives.mark_price.is_nan(),
            "null → 不可用（不是 0）"
        );
        assert!(normalize_derivatives_block(&json!({ "fundingRate": {} }), 1_000_000).is_none());
    }

    /// 事件黑名单（§8.1-7）的**执行点**：只有重要级事件、只有窗口内才拦。
    #[test]
    fn event_blackout_windows_only_block_recent_important_news() {
        let now = 1_800_000_000_000_i64;
        let event = |importance: &str, at: i64| StateEvent {
            title: "FOMC".to_string(),
            importance: importance.to_string(),
            at,
        };
        assert!(!event_blackout_active(&[], now, 30));
        assert!(event_blackout_active(
            &[event("high", now - 60_000)],
            now,
            30
        ));
        assert!(event_blackout_active(
            &[event("重要", now + 60_000)],
            now,
            30
        ));
        assert!(!event_blackout_active(
            &[event("high", now - 31 * 60_000)],
            now,
            30
        ));
        assert!(!event_blackout_active(
            &[event("low", now - 60_000)],
            now,
            30
        ));
        assert!(
            !event_blackout_active(&[event("high", now - 60_000)], now, 0),
            "0 = 关"
        );
    }

    /// 通知策略（C29.7 冻结三档）的**执行点**：三档 × 动作/观望逐格断言。
    #[test]
    fn notify_policy_has_an_execution_point() {
        assert!(fastlane_notify_allows("every_action", "watch"));
        assert!(fastlane_notify_allows("every_action", "opportunity"));
        assert!(!fastlane_notify_allows("on_open_close", "watch"));
        assert!(fastlane_notify_allows("on_open_close", "opportunity"));
        assert!(!fastlane_notify_allows("none", "watch"));
        assert!(!fastlane_notify_allows("none", "opportunity"));
        // 未知取值 → 按缺省 `on_open_close`（不静默变成"全都发"）。
        assert!(!fastlane_notify_allows("", "watch"));
        assert!(fastlane_notify_allows("", "opportunity"));
    }

    // ===== B4：动作参数严格适配 / 降险口径 / close 轮留痕 / 观察条件写库 =====

    fn plan_facts() -> PlanFacts {
        PlanFacts {
            last_price: 80_200.0,
            ct_val: 0.01,
            equity_usdt: 10_000.0,
            structure_low: Some(79_800.0),
            structure_high: Some(80_900.0),
        }
    }

    /// B4（C29.7 审计裁决）：动作参数适配**必须严格** —— 未知字段/缺字段/类型不符一律拒绝，
    /// 不得静默忽略（否则"模型写错字段"会变成"按默认值执行"）。
    #[test]
    fn opportunity_adaptation_is_strict_about_fields() {
        let facts = plan_facts();
        let good = json!({
            "intent": "open", "direction": "long", "order_type": "limit",
            "entry_px": 80_200.0, "stop_px": 79_900.0, "tp": [{ "px": 81_000, "portion": 1 }],
            "size": { "contracts": 1, "risk_pct": 0.5 }, "margin_mode": "cross",
            "invalidationPrice": 80_000.0, "confidence": 0.7
        });
        let plan = plan_from_opportunity(&good, &facts, "open").expect("strict pass");
        assert_eq!(plan.side, "long");
        assert_eq!(plan.order_type, "limit");
        assert_eq!(plan.size_contracts, 1.0);
        assert_eq!(plan.take_profit, vec![81_000.0]);
        // 单笔风险由代码算（不采信模型自报的 risk_pct）。
        assert!((plan.risk_pct - (1.0 * 0.01 * 300.0 / 10_000.0 * 100.0)).abs() < 1e-9);

        // 未知字段 → 拒绝。
        let mut unknown = good.clone();
        unknown["leverage"] = json!(20);
        unknown["entryPx"] = json!(80_200.0);
        let reasons = plan_from_opportunity(&unknown, &facts, "open").unwrap_err();
        assert!(
            reasons
                .iter()
                .any(|item| item.contains("field_unknown") && item.contains("leverage")),
            "{reasons:?}"
        );
        assert!(
            reasons
                .iter()
                .any(|item| item.contains("field_unknown") && item.contains("entryPx")),
            "{reasons:?}"
        );

        // 缺字段 → 拒绝（direction / size / orderType / marginMode）。
        for key in ["direction", "size", "order_type", "margin_mode"] {
            let mut missing = good.clone();
            missing.as_object_mut().expect("object").remove(key);
            let reasons = plan_from_opportunity(&missing, &facts, "open").unwrap_err();
            assert!(
                reasons.iter().any(|item| item.contains("field_missing")),
                "{key}: {reasons:?}"
            );
        }

        // 类型不符 → 拒绝（不是字符串/数字的都给不出 plan）。
        let mut wrong_type = good.clone();
        wrong_type["entry_px"] = json!(true);
        assert!(plan_from_opportunity(&wrong_type, &facts, "open")
            .unwrap_err()
            .iter()
            .any(|item| item.contains("field_type_invalid")));
        let mut wrong_direction = good.clone();
        wrong_direction["direction"] = json!("both");
        assert!(plan_from_opportunity(&wrong_direction, &facts, "open")
            .unwrap_err()
            .iter()
            .any(|item| item.contains("field_invalid")));
        // 非对象、空对象 → 拒绝。
        assert!(plan_from_opportunity(&json!([]), &facts, "open").is_err());
        assert!(plan_from_opportunity(&json!({}), &facts, "open").is_err());

        // 开仓缺失效位（模型没写、state 也没有结构位）→ 拒绝，绝不用默认价格凑。
        let mut no_levels = facts;
        no_levels.structure_low = None;
        no_levels.structure_high = None;
        let mut missing_invalidation = good.clone();
        missing_invalidation
            .as_object_mut()
            .expect("object")
            .remove("invalidationPrice");
        let reasons = plan_from_opportunity(&missing_invalidation, &no_levels, "open").unwrap_err();
        assert!(
            reasons
                .iter()
                .any(|item| item.contains("missing_invalidation")),
            "{reasons:?}"
        );
        // 有 state 结构位时用它（模型看过的同一份事实，不是默认值）。
        let plan = plan_from_opportunity(&missing_invalidation, &plan_facts(), "open")
            .expect("结构位兜底");
        assert_eq!(plan.invalidation, 79_800.0);
    }

    /// B4（lead 2026-09-20 裁决）：**同一份"数据过期 + 滑点超限"事实**，
    /// 开仓口径必须拦、降险口径必须放行 —— 这是"用户停机平仓不被挡住"的可执行证明。
    #[test]
    fn reduce_round_is_not_blocked_by_open_only_checks() {
        // 数据过期：代码门判 data。
        let stale = DataAges::default().age_ms(1_000_000);
        assert!(stale.ticker == i64::MAX);
        let mut inputs = inputs();
        inputs.blackout_active = true;
        inputs.max_slippage_bps = 5;
        inputs.target_leverage = 200; // 超过合约上限
        inputs.min_size = 0.1;

        // 开仓口径：滑点（entry 与最新价差 200bps）+ 黑名单 + 杠杆 → 全部拦下。
        let open_plan = FastlanePlan {
            order_type: "market".to_string(),
            entry_px: 81_802.0,
            ..plan()
        };
        let rejection = validate_round(open_plan, &inputs).unwrap_err();
        for expected in [
            "slippage_over_limit",
            "blackout_active",
            "leverage_over_instrument_limit",
        ] {
            assert!(
                rejection.reasons.iter().any(|item| item.contains(expected)),
                "{expected}: {:?}",
                rejection.reasons
            );
        }

        // 降险口径：同一份事实 + 小于开仓最小手数 + 没有报价 → 放行。
        let reduce_plan = FastlanePlan {
            side: "long".to_string(),
            order_type: "close".to_string(),
            entry_px: f64::NAN,
            stop_px: f64::NAN,
            take_profit: Vec::new(),
            size_contracts: 0.001,
            risk_pct: f64::NAN,
            margin_mode: String::new(),
            invalidation: f64::NAN,
            reason_tags: vec!["kill_switch".to_string()],
            confidence: 0.0,
        };
        let validated = validate_round(reduce_plan.clone(), &inputs).expect("降险轮必须放行");
        assert_eq!(validated.plan().order_type, "close");

        // 降险仍受**账户能力/数量上限**约束（不是无脑放行）。
        let over_size = FastlanePlan {
            size_contracts: 1_000.0,
            ..reduce_plan.clone()
        };
        assert!(validate_round(over_size, &inputs)
            .unwrap_err()
            .reasons
            .iter()
            .any(|item| item.contains("size_over_limit")));
        let mut blocked_margin = inputs;
        blocked_margin.margin_mode_allowed = false;
        assert!(validate_round(reduce_plan, &blocked_margin)
            .unwrap_err()
            .reasons
            .iter()
            .any(|item| item.contains("margin_mode_not_allowed")));

        // 代码门：数据过期在**开仓轮**拦、在**降险轮**不拦（结果仍如实进记录）。
        let gate = GateOutcome::data_failed("ticker 数据过期");
        assert!(gate_blocks_round(&gate, false));
        assert!(!gate_blocks_round(&gate, true));
        assert!(!gate_blocks_round(&GateOutcome::pass(), false));
    }

    fn round_facts(is_close_round: bool, validation: ValidationInputs) -> FastlaneRoundFacts {
        FastlaneRoundFacts {
            profile_id: "profile-fastlane".to_string(),
            run_id: "run-fastlane-1".to_string(),
            account_id: Some("acct-1".to_string()),
            environment: "demo".to_string(),
            inst_id: "BTC-USDT-SWAP".to_string(),
            session_id: "background:run-fastlane-1".to_string(),
            is_close_round,
            plan_facts: plan_facts(),
            validation,
            target_leverage: 20,
            max_slippage_bps: 5,
            trace: std::sync::Arc::new(std::sync::Mutex::new(FastlaneRoundTrace::default())),
        }
    }

    /// B4（对照测试，验收硬要求）：**同一份"ticker 过期 + 滑点超限"事实**，
    /// 开仓口径必须被代码校验拦下、降险口径（停机平仓轮）必须放行 —— 走的是真实
    /// 「适配 → `validate_round`」入口（不是手搓 plan 绕过去）。
    #[test]
    fn round_facts_block_open_and_pass_close_on_the_same_facts() {
        let mut strict = inputs();
        strict.blackout_active = true;
        strict.max_slippage_bps = 5;
        strict.target_leverage = 200; // 超过合约上限
        strict.min_size = 0.1; // 降险轮不受最小手数约束

        // 开仓口径：事件黑名单 + 杠杆超合约上限 + 盈亏比不达标 → 全部拦下。
        let open_params = json!({
            "intent": "open", "direction": "long", "order_type": "limit",
            "entry_px": 80_200.0, "stop_px": 79_900.0, "tp": [{ "px": 80_350, "portion": 1 }],
            "size": { "contracts": 1, "risk_pct": 0.5 }, "margin_mode": "cross",
            "invalidationPrice": 79_900.0, "confidence": 0.7
        });
        let open_round = round_facts(false, strict);
        let rejection = open_round
            .adapt_and_validate(&open_params)
            .expect_err("开仓口径必须被拦");
        for expected in [
            "blackout_active",
            "leverage_over_instrument_limit",
            "reward_risk_below_floor",
        ] {
            assert!(
                rejection.iter().any(|item| item.contains(expected)),
                "{expected}: {rejection:?}"
            );
        }
        // 拒绝原因如实进 trace（记录/审计能解释"为什么这轮没动手"）。
        assert_eq!(open_round.trace().rejections, rejection);
        assert!(open_round.trace().adapted_plan.is_none());

        // ⑤ 滑点超限（同一份事实、同一个限价差）：市价开仓被拦，同一张 plan 走降险口径放行。
        let slippage_plan = FastlanePlan {
            order_type: "market".to_string(),
            entry_px: 81_802.0,
            ..crate::fastlane::tests::plan()
        };
        assert!(validate_round(slippage_plan.clone(), &strict)
            .expect_err("开仓市价滑点超限必须拦")
            .reasons
            .iter()
            .any(|item| item.starts_with("slippage_over_limit")));
        assert!(validate_round(
            FastlanePlan {
                order_type: "close".to_string(),
                ..slippage_plan
            },
            &strict
        )
        .is_ok());

        // 降险口径：同一份事实 + 市价平仓（没有报价、没有止损、小于开仓最小手数）→ 放行。
        let close_params = json!({
            "intent": "close", "direction": "long", "order_type": "market",
            "size": { "contracts": 0.001, "risk_pct": 0.5 }, "exitKind": "stop_loss",
            "reason_tags": ["kill_switch"], "margin_mode": "cross"
        });
        let close_round = round_facts(true, strict);
        let validated = close_round
            .adapt_and_validate(&close_params)
            .expect("停机平仓轮必须放行（ticker 过期/滑点/黑名单都不拦降险）");
        assert_eq!(validated.plan().order_type, "close");
        assert_eq!(close_round.trace().intent.as_deref(), Some("close"));
        assert!(close_round.trace().rejections.is_empty());
        assert_eq!(
            close_round.trace().adapted_plan.expect("plan 留痕")["sizeContracts"],
            0.001
        );

        // 停机平仓轮**不允许**被模型改回开仓：同一份 params 在平仓轮里按 close 口径适配。
        let mut disguised = close_params.clone();
        disguised["intent"] = json!("open");
        disguised["entry_px"] = json!(81_802.0);
        let validated = round_facts(true, strict)
            .adapt_and_validate(&disguised)
            .expect("平仓轮的意图由系统给定");
        assert_eq!(validated.plan().order_type, "close");

        // 降险口径仍然受**账户能力/数量上限**约束（不是无脑放行）。
        let oversized = json!({
            "intent": "close", "direction": "long", "order_type": "market",
            "size": { "contracts": 1000, "risk_pct": 0.5 }, "margin_mode": "cross"
        });
        assert!(round_facts(true, strict)
            .adapt_and_validate(&oversized)
            .expect_err("超可平数量上限必须拦")
            .iter()
            .any(|item| item.contains("size_over_limit")));
        let mut blocked_margin = strict;
        blocked_margin.margin_mode_allowed = false;
        assert!(round_facts(true, blocked_margin)
            .adapt_and_validate(&close_params)
            .expect_err("保证金模式不合规必须拦")
            .iter()
            .any(|item| item.contains("margin_mode_not_allowed")));
    }

    /// **变更 A（2026-09-21）③：侧车 ↔ Rust 的"降险"口径同源（真实函数，不是镜像）**。
    ///
    /// 输入是 **验收实跑产出的真实参数**（`artifacts/fastlane-risk-reduction/20260920-205757-r2.json`
    /// → `run-1785297375424948000`，Jev 判「平仓」、持仓 short 0.14 张，窄调用 LLM 给出的
    /// `order` 逐字段照搬：`intent=close` / `order_type=market` / `entry_px=null` / `stop_px=null` /
    /// `size.contracts=0.14` / `exit_kind=strategy_exit` / `confidence=0.23`）。
    ///
    /// 这条测试同时钉住两件事：
    ///   1. 该形状走真实的「适配 → `validate_round`」入口**按降险口径通过**
    ///      （ticker 过期 / 滑点 / 事件黑名单 / 最小手数 / 无止损无 TP 都不拦）；
    ///   2. **同一个形状若把 `intent` 写成 `reduce`（Rust 不认的意图）就会被按开仓口径拒掉** ——
    ///      这正是侧车必须把 `reduce` 折叠成 `close` 的原因（耦合点，别在代码里"简化"掉）。
    #[test]
    fn sidecar_risk_reduction_shape_passes_rust_reduce_checks() {
        let mut strict = inputs();
        strict.blackout_active = true;
        strict.max_slippage_bps = 5;
        strict.min_size = 0.5; // 降险可以小于开仓最小手数
        strict.last_price = 80_200.0;

        // 验收实跑的真实降险参数（字段与值逐字来自产物）。
        let reduce_params = json!({
            "intent": "close",
            "direction": "short",
            "order_type": "market",
            "entry_px": serde_json::Value::Null,
            "stop_px": serde_json::Value::Null,
            "size": { "contracts": 0.14 },
            "exit_kind": "strategy_exit",
            "confidence": 0.23
        });
        // **普通快判轮**（不是停机平仓轮）：`is_close_round = false`。
        let round = round_facts(false, strict);
        let validated = round
            .adapt_and_validate(&reduce_params)
            .expect("降险形状必须按降险口径通过（ticker 过期/无止损/小于最小手数都不拦）");
        // Rust 侧的"降险"判据：`plan.order_type ∈ {reduce, close}`（validate_round 的 is_reduce）。
        assert_eq!(validated.plan().order_type, "close");
        assert_eq!(validated.plan().size_contracts, 0.14);
        assert_eq!(validated.plan().side, "short");
        assert_eq!(round.trace().intent.as_deref(), Some("close"));
        assert!(round.trace().rejections.is_empty());

        // 落到既有工具形状：市价 + exitKind 必填（createOpportunity 的真实出口）。
        let input = opportunity_input_from_plan(
            validated.plan(),
            &reduce_params,
            "close",
            Some("acct-1"),
            "demo",
            "BTC-USDT-SWAP",
            20,
            5,
            "background:run-fastlane-1",
        );
        assert_eq!(input["intent"], "close");
        assert_eq!(input["orderType"], "market");
        assert_eq!(input["exitKind"], "strategy_exit");
        assert_eq!(input["size"], "0.14");
        assert_eq!(input["direction"], "short");
        assert!(input.get("stopLoss").is_none(), "降险轮不挂保护单");

        // **耦合点**：把 intent 写回模型原本可能写的 `reduce` → Rust 不认这个意图
        // （`action_intent` 只认 open|close|cancel|amend）→ 回落开仓口径 → 被拒。
        // 侧车因此必须做 `reduce → close` 的折叠（`normalizeRiskReductionIntent`）。
        let mut unfolded = reduce_params.clone();
        unfolded["intent"] = json!("reduce");
        let rejection = round_facts(false, strict)
            .adapt_and_validate(&unfolded)
            .expect_err("intent=reduce 不是 Rust 认的意图，必须被拒（所以侧车要折叠）");
        assert!(
            rejection
                .iter()
                .any(|item| item.contains("field_invalid") || item.contains("field_missing")),
            "按开仓口径被拒：{rejection:?}"
        );
    }

    /// **变更 A（2026-09-21）④：门未过但按降险放行 —— 记录与 UI 必须看得见**。
    ///
    /// 用**侧车真实回传形状**（`result.gate` + `result.intent`）走 serde → `from_sidecar`：
    ///   - `gate.ok` 保持 `false`（**不许改写成 true**）；
    ///   - 门原因码原样进 `gate.reasons`，另加 `risk_reduction_gate_bypass` 标记；
    ///   - `appliedTo` / `bypassedFor` 落到记录（UI 的豁免 chip 读它）；
    ///   - `intent = "reduce"`（Jev 自判降险）与 `"close"`（停机平仓轮）在记录里可区分。
    #[test]
    fn sidecar_gate_bypass_for_risk_reduction_is_recorded() {
        let sidecar: FastlaneSidecarResult = serde_json::from_value(json!({
            "ok": true,
            "intent": "reduce",
            "gate": { "ok": false, "reasons": ["low_confidence"], "appliedTo": "open", "bypassedFor": "risk_reduction" },
            "jev": { "action": "reduce", "quality": 1.56, "confidence": 0.32, "latencyMs": 900, "attempts": 1 },
            "llm": { "latencyMs": 1_200, "validation": { "ok": true, "reasons": ["risk_reduction_gate_bypass: 质量/置信度门未过（low_confidence），本轮是降险动作 → 放行；开新仓仍受该门约束"] },
                     "wakeConditions": 1, "params": { "order": { "intent": "close" } } },
            "action": { "kind": "opportunity", "opportunityId": "opp-reduce-1" }
        }))
        .expect("侧车回传必须能解析（新增字段是纯增量）");
        let record = FastlaneRecord::from_sidecar(
            FastlaneTrigger {
                source: "condition".to_string(),
                condition_type: Some("price_cross".to_string()),
                params: None,
            },
            GateOutcome::pass(),
            &sidecar,
            40,
            5,
        );
        // 门没过：ok 绝不改写。
        assert!(
            !record.gate.ok,
            "门没过就是 false，不许因为被豁免而改成 true"
        );
        assert!(
            record
                .gate
                .reasons
                .iter()
                .any(|item| item == "low_confidence"),
            "{:?}",
            record.gate.reasons
        );
        assert!(
            record
                .gate
                .reasons
                .iter()
                .any(|item| item == "risk_reduction_gate_bypass"),
            "{:?}",
            record.gate.reasons
        );
        assert_eq!(record.gate.applied_to.as_deref(), Some("open"));
        assert_eq!(record.gate.bypassed_for.as_deref(), Some("risk_reduction"));
        // 记录里的 intent 值：Jev 自判降险 = "reduce"（停机平仓轮 = "close"，两者不同）。
        assert_eq!(record.intent.as_deref(), Some("reduce"));
        assert_eq!(record.action.kind, "opportunity");
        // 落库 JSON（`fastlane_json`）形状：UI 直接读这三个键。
        let value = record.to_value();
        assert_eq!(value["gate"]["ok"], false);
        assert_eq!(value["gate"]["appliedTo"], "open");
        assert_eq!(value["gate"]["bypassedFor"], "risk_reduction");
        assert_eq!(value["intent"], "reduce");
        // 开新仓轮的门（没被豁免）不得带 `bypassedFor` 标注。
        let open_sidecar: FastlaneSidecarResult = serde_json::from_value(json!({
            "ok": true, "gate": { "ok": false, "reasons": ["low_quality"], "appliedTo": "open" }
        }))
        .expect("开仓轮回传");
        let open_record = FastlaneRecord::from_sidecar(
            FastlaneTrigger {
                source: "manual".to_string(),
                condition_type: None,
                params: None,
            },
            GateOutcome::pass(),
            &open_sidecar,
            1,
            1,
        );
        assert!(!open_record.gate.ok);
        assert_eq!(open_record.gate.bypassed_for, None, "开新仓路径不放宽");
        assert!(open_record
            .gate
            .reasons
            .iter()
            .any(|item| item == "low_quality"));
        assert!(!open_record
            .gate
            .reasons
            .iter()
            .any(|item| item == "risk_reduction_gate_bypass"));
    }

    /// **变更 B（2026-09-21）**：打分臂的两个分数 / 门槛 / 判定依据 / 置信度来源
    /// 必须能从侧车回传落到 `fastlane_json.jev`（UI 靠它们区分"分数不够"与"模型说观望"）。
    ///
    /// 两条口径都钉住：① 新侧车带这些键 → 原样落库；② 旧侧车**不带**这些键 → 记录里不出现该字段
    /// （老记录形状不变，`serde` 缺省 = `None` + `skip_serializing_if`）。
    #[test]
    fn fastlane_record_keeps_entry_score_fields() {
        let sidecar: FastlaneSidecarResult = serde_json::from_value(json!({
            "ok": true,
            "jev": {
                "action": "open_long", "actionRaw": "", "quality": 2.2, "confidence": null,
                "latencyMs": 640, "attempts": 1,
                "longScore": 2.0, "shortScore": 0.4, "entryScoreFloor": 1.5,
                "entryScoreDecision": "direction", "confidenceSource": "none"
            },
            "action": { "kind": "opportunity", "opportunityId": "opp-score-1" }
        }))
        .expect("打分臂回传必须能解析");
        let record = FastlaneRecord::from_sidecar(
            FastlaneTrigger {
                source: "condition".to_string(),
                condition_type: Some("price_cross".to_string()),
                params: None,
            },
            GateOutcome::pass(),
            &sidecar,
            30,
            4,
        );
        let jev = record.jev.clone().expect("jev 段");
        assert_eq!(jev.action, "open_long");
        assert_eq!(jev.long_score, Some(2.0));
        assert_eq!(jev.short_score, Some(0.4));
        assert_eq!(jev.entry_score_floor, Some(1.5));
        assert_eq!(jev.entry_score_decision.as_deref(), Some("direction"));
        assert_eq!(jev.confidence_source.as_deref(), Some("none"));
        assert_eq!(
            jev.confidence, 0.0,
            "打分臂没有 action 节点 → 置信度保持 0（不编造）"
        );
        let value = record.to_value();
        assert_eq!(value["jev"]["longScore"], 2.0);
        assert_eq!(value["jev"]["shortScore"], 0.4);
        assert_eq!(value["jev"]["entryScoreFloor"], 1.5);
        assert_eq!(value["jev"]["entryScoreDecision"], "direction");
        assert_eq!(value["jev"]["confidenceSource"], "none");

        // 旧侧车形状（没有任何打分键）→ 记录里**不出现**这些字段（老记录逐字不变）。
        let legacy: FastlaneSidecarResult = serde_json::from_value(json!({
            "ok": true,
            "jev": { "action": "观望", "quality": 1.56, "confidence": 0.93, "latencyMs": 858, "attempts": 1 },
            "action": { "kind": "watch", "reason": "low_quality" }
        }))
        .expect("旧形状回传必须能解析");
        let legacy_record = FastlaneRecord::from_sidecar(
            FastlaneTrigger {
                source: "silence".to_string(),
                condition_type: None,
                params: None,
            },
            GateOutcome::pass(),
            &legacy,
            30,
            4,
        );
        let legacy_value = legacy_record.to_value();
        for key in [
            "longScore",
            "shortScore",
            "entryScoreFloor",
            "entryScoreDecision",
            "confidenceSource",
            // C29.14：降险臂字段同样不得凭空长出来。
            "reduceScore",
            "reduceScoreFloor",
            "reduceScoreDecision",
            "reducePositionFact",
        ] {
            assert!(
                legacy_value["jev"].get(key).is_none(),
                "旧形状不得凭空长出 {key}"
            );
        }
        assert_eq!(legacy_value["jev"]["confidence"], 0.93);
    }

    /// **C29.14（2026-09-21）**：降险臂的 `reduceScore` / 降险门槛 / 降险口径 / 持仓事实
    /// 必须能从侧车回传落到 `fastlane_json.jev`（UI 靠它们区分"该降险但没得减"的两种情形）。
    ///
    /// **C29.17（2026-09-21）**：降险门槛是**独立字段** —— 本测试额外钉住"两条线能分别落库"
    /// （同值时不得互相覆盖，异值时各落各的）。
    #[test]
    fn fastlane_record_keeps_reduce_score_fields() {
        // ① 判降险（有持仓）：`reduceScore ≥ 门槛` → `reduce`；默认下门槛与开仓门槛同值 1.5。
        let sidecar: FastlaneSidecarResult = serde_json::from_value(json!({
            "ok": true,
            "intent": "reduce",
            "jev": {
                "action": "reduce", "actionRaw": "", "quality": 1.04, "confidence": null,
                "latencyMs": 610, "attempts": 1,
                "longScore": 0.4, "shortScore": 0.2, "entryScoreFloor": 1.5,
                "entryScoreDecision": "reduce", "confidenceSource": "none",
                "reduceScore": 2.3, "reduceScoreFloor": 1.5,
                "reduceScoreDecision": "reduce", "reducePositionFact": "held"
            },
            "action": { "kind": "opportunity", "opportunityId": "opp-reduce-1" }
        }))
        .expect("降险臂回传必须能解析");
        let record = FastlaneRecord::from_sidecar(
            FastlaneTrigger {
                source: "silence".to_string(),
                condition_type: None,
                params: None,
            },
            GateOutcome::pass(),
            &sidecar,
            30,
            4,
        );
        let jev = record.jev.clone().expect("jev 段");
        assert_eq!(jev.action, "reduce");
        assert_eq!(jev.reduce_score, Some(2.3));
        assert_eq!(
            jev.reduce_score_floor,
            Some(1.5),
            "降险门槛照实落库（默认与开仓门槛同值）"
        );
        assert_eq!(jev.reduce_score_decision.as_deref(), Some("reduce"));
        assert_eq!(jev.reduce_position_fact.as_deref(), Some("held"));
        let value = record.to_value();
        assert_eq!(value["jev"]["reduceScore"], 2.3);
        assert_eq!(value["jev"]["reduceScoreFloor"], 1.5);
        assert_eq!(value["jev"]["reduceScoreDecision"], "reduce");
        assert_eq!(value["jev"]["reducePositionFact"], "held");
        assert_eq!(
            record.intent.as_deref(),
            Some("reduce"),
            "记录里区分 Jev 自判降险（不是停机轮 close）"
        );

        // ①-b **C29.17 解耦**：两条门槛不同值时，记录里各落各的 —— 降险用的必须是**降险自己**那条线
        // （若这里变成 2.0，说明降险臂又读回了 `entry_score_floor`；JS 侧另有轮级变异校验）。
        let split: FastlaneSidecarResult = serde_json::from_value(json!({
            "ok": true,
            "intent": "reduce",
            "jev": {
                "action": "reduce", "actionRaw": "", "quality": 2.4, "confidence": null,
                "latencyMs": 600, "attempts": 1,
                "longScore": 0.4, "shortScore": 0.2, "entryScoreFloor": 2.0,
                "entryScoreDecision": "reduce", "confidenceSource": "none",
                "reduceScore": 1.2, "reduceScoreFloor": 1.0,
                "reduceScoreDecision": "reduce", "reducePositionFact": "held"
            },
            "action": { "kind": "opportunity", "opportunityId": "opp-reduce-split" }
        }))
        .expect("解耦后的降险回传必须能解析");
        let split_record = FastlaneRecord::from_sidecar(
            FastlaneTrigger {
                source: "silence".to_string(),
                condition_type: None,
                params: None,
            },
            GateOutcome::pass(),
            &split,
            30,
            4,
        );
        let split_value = split_record.to_value();
        assert_eq!(split_value["jev"]["entryScoreFloor"], 2.0);
        assert_eq!(
            split_value["jev"]["reduceScoreFloor"], 1.0,
            "降险门槛必须落**降险自己**的值"
        );
        assert_ne!(
            split_value["jev"]["reduceScoreFloor"], split_value["jev"]["entryScoreFloor"],
            "两条线解耦：不得再强制同值"
        );

        // ② 该降险但**无持仓** / **持仓事实缺失**：两个码必须原样落库（分层文案的唯一凭据）。
        for (reason, fact) in [
            ("reduce_without_position", "flat"),
            ("reduce_position_unknown", "unknown"),
        ] {
            assert!(
                is_known_watch_reason(reason),
                "观望码必须在冻结枚举里：{reason}"
            );
            let blocked: FastlaneSidecarResult = serde_json::from_value(json!({
                "ok": true,
                "jev": {
                    "action": "watch", "quality": 2.2, "confidence": null, "latencyMs": 600, "attempts": 1,
                    "longScore": 0.4, "shortScore": 0.2, "entryScoreFloor": 1.5,
                    "entryScoreDecision": reason, "confidenceSource": "none",
                    "reduceScore": 2.0, "reduceScoreFloor": 1.5,
                    "reduceScoreDecision": reason, "reducePositionFact": fact
                },
                "action": { "kind": "watch", "reason": reason }
            }))
            .expect("降险被仓位挡住时的回传必须能解析");
            let blocked_record = FastlaneRecord::from_sidecar(
                FastlaneTrigger {
                    source: "silence".to_string(),
                    condition_type: None,
                    params: None,
                },
                GateOutcome::pass(),
                &blocked,
                30,
                4,
            );
            let blocked_value = blocked_record.to_value();
            assert_eq!(blocked_value["action"]["reason"], reason);
            assert_eq!(blocked_value["jev"]["reduceScoreDecision"], reason);
            assert_eq!(blocked_value["jev"]["reducePositionFact"], fact);
            assert_eq!(
                blocked_value["jev"]["reduceScore"], 2.0,
                "分数照实落库（不因为没得减就抹掉）"
            );
        }
    }

    /// B4：系统注入的动作上下文与**自报杠杆**在适配前剥离/核对；剥离后仍是严格白名单。
    #[test]
    fn round_action_normalization_is_not_a_loophole() {
        // 侧车真实注入：instId/environment/accountId/lever + 模型自己的 leverage。
        let params = json!({
            "intent": "open", "direction": "long", "order_type": "limit",
            "entry_px": 80_200.0, "stop_px": 79_900.0, "tp": [{ "px": 81_000, "portion": 1 }],
            "size": { "contracts": 1, "risk_pct": 0.5 }, "margin_mode": "cross",
            "invalidationPrice": 80_000.0, "instId": "BTC-USDT-SWAP", "environment": "demo",
            "accountId": "acct-1", "lever": "20", "leverage": 20
        });
        let (normalized, reasons) = normalize_round_action(&params, 20);
        assert!(reasons.is_empty(), "{reasons:?}");
        for key in ["instId", "environment", "accountId", "lever", "leverage"] {
            assert!(normalized.get(key).is_none(), "{key} 必须被剥离");
        }
        assert!(plan_from_opportunity(&normalized, &plan_facts(), "open").is_ok());

        // 自报杠杆与 Profile 不一致 → **拒绝**（不是静默改成 Profile 值）。
        let mut mismatched = params.clone();
        mismatched["leverage"] = json!(50);
        mismatched.as_object_mut().expect("object").remove("lever");
        let (_, reasons) = normalize_round_action(&mismatched, 20);
        assert!(
            reasons
                .iter()
                .any(|item| item.contains("leverage_mismatch")),
            "{reasons:?}"
        );
        assert!(round_facts(false, inputs())
            .adapt_and_validate(&mismatched)
            .expect_err("自报杠杆不一致必须拒绝")
            .iter()
            .any(|item| item.contains("leverage_mismatch")));

        // 剥离系统键**不等于**放宽白名单：模型写错字段照样拒绝。
        let mut typo = params.clone();
        typo["entryPx"] = json!(80_200.0);
        assert!(round_facts(false, inputs())
            .adapt_and_validate(&typo)
            .expect_err("未知字段必须拒绝")
            .iter()
            .any(|item| item.contains("field_unknown") && item.contains("entryPx")));
    }

    /// B4：下发载荷的冻结形状（侧车读什么键，这里就拼什么键）。
    #[test]
    fn round_dispatch_payload_matches_the_sidecar_contract() {
        let config = FastlaneConfig::default().normalized();
        let state = json!({ "as_of": "2026-09-20T12:00:00Z", "inst_id": "BTC-USDT-SWAP" });
        let wake = wake_conditions_payload(&[WakeConditionView {
            id: "wake-1".to_string(),
            source: "agent".to_string(),
            plan_mode: "any".to_string(),
            condition: json!({ "type": "price_cross", "instId": "BTC-USDT-SWAP",
                               "direction": "above", "price": 80_500.0 }),
            expires_at: Some(1_800_000_000_000),
            last_triggered_at: None,
        }]);
        let round = FastlaneDispatch::build(
            &config,
            &ai_settings("deepseek-v4-flash"),
            &state,
            &wake,
            false,
        );
        let view = round.sidecar_view();
        assert_eq!(round.intent, "round");
        assert_eq!(view["config"]["profileType"], "fastlane");
        assert_eq!(view["config"]["typesafeApiKey"], "TYPESAFE_PLACEHOLDER_KEY");
        assert_eq!(view["fastlaneSnapshot"], state);
        assert_eq!(view["fastlaneIntent"], "round");
        assert_eq!(view["wakeConditions"][0]["type"], "price_cross");
        assert_eq!(view["wakeConditions"][0]["planMode"], "any");
        assert_eq!(view["wakeConditions"][0]["price"], 80_500.0);
        assert!(
            view["wakeConditions"][0].get("params").is_none(),
            "下发形状是平铺"
        );
        // ② schema 随载荷下发（侧车读 `input.wakeConditionSchema` 注入 prompt）：
        // 19 类齐全，`timer` 的必填写法与校验器一致。
        let schema = view["wakeConditionSchema"]
            .as_object()
            .expect("wakeConditionSchema");
        assert_eq!(
            schema.keys().filter(|key| !key.starts_with('_')).count(),
            19,
            "19 类观察条件全在下发 schema 里"
        );
        assert_eq!(
            view["wakeConditionSchema"]["timer"]["required"],
            json!(["atMs|intervalMinutes"])
        );
        assert_eq!(
            view["wakeConditionSchema"]["price_cross"]["required"],
            json!(["price", "direction"])
        );
        assert!(view["wakeConditionSchema"]["_note"]
            .as_str()
            .unwrap_or_default()
            .contains("instId"));
        // 19 键 snake_case + 侧车读的 `fastlane_llm_model`（C29.17：19 → 20，新增 `fastlane_reduce_score_floor`）。
        let keys = view["config"]
            .as_object()
            .expect("config object")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let fastlane_keys = keys
            .iter()
            .filter(|key| key.starts_with("fastlane_"))
            .count();
        assert_eq!(fastlane_keys, 20, "{keys:?}");
        assert!(
            keys.iter().all(|key| !key.contains("fastlaneLlmModel")),
            "{keys:?}"
        );
        // 停机平仓轮：`fastlaneIntent = "close"`（侧车据此跳过 Jev）。
        let close = FastlaneDispatch::build(&config, &ai_settings("m"), &state, &wake, true);
        assert_eq!(close.intent, "close");
        assert_eq!(close.sidecar_view()["fastlaneIntent"], "close");
    }

    /// B4 闭环的关键转换点：侧车 `{type, params}` → 既有 `WakeCondition` 平铺形状。
    #[test]
    fn wake_condition_value_flattens_params_and_rejects_unknown_keys() {
        let flat = wake_condition_value(&json!({
            "type": "price_cross", "params": { "instId": "BTC-USDT-SWAP", "direction": "above", "price": 80_500.0 }
        }))
        .expect("flatten");
        assert_eq!(flat["type"], "price_cross");
        assert_eq!(flat["price"], 80_500.0);
        assert!(flat.get("params").is_none());
        // 直接反序列化成既有 `WakeCondition`（闭环的第一道真校验）。
        let condition: desic_agent_automation::WakeCondition =
            serde_json::from_value(flat).expect("既有形状可解析");
        assert!(validate_wake_condition_limits_shape(&condition));

        // `{type}` 无条件参数（例如 position_changed）也合法。
        assert_eq!(
            wake_condition_value(&json!({ "type": "position_changed" })).expect("no params")
                ["type"],
            "position_changed"
        );
        // 未知字段 / 缺 type / params 非法 / 覆盖 type → 一律拒绝。
        assert!(wake_condition_value(&json!({ "type": "timer", "interval": 5 })).is_err());
        assert!(wake_condition_value(&json!({ "params": { "intervalMinutes": 5 } })).is_err());
        assert!(wake_condition_value(&json!({ "type": "timer", "params": 5 })).is_err());
        assert!(
            wake_condition_value(&json!({ "type": "timer", "params": { "type": "timer" } }))
                .is_err()
        );
        assert!(wake_condition_value(&json!("timer")).is_err());
    }

    fn validate_wake_condition_limits_shape(
        condition: &desic_agent_automation::WakeCondition,
    ) -> bool {
        matches!(
            condition,
            desic_agent_automation::WakeCondition::PriceCross { .. }
        )
    }

    /// B4：账户能力（可平数量上限 / 开仓上限）**由账户事实算**，没有持仓就是 0（不是无限）。
    #[test]
    fn round_capacity_comes_from_the_account_facts() {
        let position = |side: &str, size: f64| StatePosition {
            inst_id: "BTC-USDT-SWAP".to_string(),
            side: side.to_string(),
            size,
            entry_px: 80_000.0,
            upl_pct: 0.0,
            stop_px: None,
        };
        // 没有持仓 → 可平 0（平仓轮任何张数都会被 `size_over_limit` 拦下）。
        assert_eq!(position_capacity(&[]), 0.0);
        assert_eq!(position_capacity(&[position("long", f64::NAN)]), 0.0);
        assert_eq!(position_capacity(&[position("long", -1.0)]), 0.0);
        assert_eq!(
            position_capacity(&[position("long", 1.5), position("short", 0.5)]),
            2.0
        );

        // 开仓上限 = 单笔保证金上限 × 杠杆 ÷（面值 × 价格）；拿不到事实 → 0（调用方决定口径）。
        // 10_000 权益 × 30% 保证金 = 3_000；× 20 倍杠杆 = 60_000 名义；÷（0.01 × 80_000）＝ 75 张。
        let cap = open_size_cap(10_000.0, 30, 20, 0.01, 80_000.0);
        assert!((cap - 75.0).abs() < 1e-9, "{cap}");
        assert_eq!(open_size_cap(10_000.0, 30, 20, 0.0, 80_000.0), 0.0);
        assert_eq!(open_size_cap(10_000.0, 30, 20, 0.01, 0.0), 0.0);
        assert_eq!(open_size_cap(f64::NAN, 30, 20, 0.01, 80_000.0), 0.0);
    }

    /// B4：`close` 轮的 Jev 直通位如实落记录；老侧车（未支持 `fastlaneIntent`）留痕。
    #[test]
    fn close_round_jev_skip_is_recorded_faithfully() {
        let trigger = FastlaneTrigger {
            source: "manual".to_string(),
            condition_type: Some("kill_switch".to_string()),
            params: Some(json!({ "intent": "close" })),
        };
        // 新侧车：跳过 Jev（skipped:true + reason + jevMs=0）。
        let skipped: FastlaneSidecarResult = serde_json::from_value(json!({
            "ok": true,
            "jev": { "skipped": true, "reason": "intent_close" },
            "llm": { "latencyMs": 900, "validation": { "ok": true, "reasons": [] },
                     "wakeConditions": 0, "params": { "summary": "平掉快判仓位" } },
            "action": { "kind": "opportunity", "opportunityId": "opp-close-1" },
            "timing": { "jevMs": 0, "llmMs": 900 },
            "tokens": { "jevIn": null, "jevOut": null, "llmIn": 10, "llmOut": 20 }
        }))
        .expect("parse skipped jev");
        assert!(close_round_jev_skipped(&skipped));
        let record =
            FastlaneRecord::from_sidecar(trigger.clone(), GateOutcome::pass(), &skipped, 40, 15);
        assert_eq!(record.jev.as_ref().expect("jev block").action, "skipped");
        assert!(record.jev.as_ref().expect("jev block").skipped);
        assert_eq!(
            record.jev.as_ref().expect("jev block").reason.as_deref(),
            Some("intent_close")
        );
        assert_eq!(record.timing.jev_ms, 0, "不得把跳过的 Jev 记成真实耗时");
        assert_eq!(record.timing.total_ms, 40 + 0 + 900 + 15);
        assert!(
            !close_round_degraded(true, &record),
            "机会已创建 → 不是降级"
        );
        assert!(!close_round_degraded(false, &record));

        // 老侧车：照旧跑 Jev（真实判定）→ 必须留痕，且 Jev 判观望时视为平仓轮降级。
        let legacy: FastlaneSidecarResult = serde_json::from_value(json!({
            "ok": true,
            "jev": { "action": "watch", "probabilities": { "watch": 0.93 }, "confidence": 0.92,
                     "quality": 2.0, "latencyMs": 760, "attempts": 1 },
            "llm": { "latencyMs": 700, "validation": { "ok": true, "reasons": [] }, "wakeConditions": 1 },
            "action": { "kind": "watch", "reason": "low_quality" },
            "timing": { "jevMs": 760, "llmMs": 700 }
        }))
        .expect("parse legacy jev");
        assert!(
            !close_round_jev_skipped(&legacy),
            "老侧车没跳过 Jev → 必须留痕"
        );
        let record = FastlaneRecord::from_sidecar(trigger, GateOutcome::pass(), &legacy, 30, 12);
        let jev = record.jev.as_ref().expect("jev block");
        assert_eq!(jev.action, "watch");
        assert!(!jev.skipped);
        assert_eq!(record.timing.jev_ms, 760);
        assert!(
            close_round_degraded(true, &record),
            "平仓轮只观望 → 必须显式识别（不准静默）"
        );
    }

    /// B4：侧车 `nextWakePlan` → `ai_wake_conditions` 行；非法计划一律拒绝。
    #[test]
    fn wake_plan_rows_are_validated_before_persisting() {
        let plan = json!({
            "mode": "any",
            "conditions": [
                { "type": "price_cross", "params": { "price": 80_500, "direction": "above" } },
                { "type": "timer", "params": { "intervalMinutes": 10 } }
            ],
            "expiresAtMs": 1_800_000_000_000_i64
        });
        let rows =
            wake_condition_rows(&plan, 1_000, |kind| matches!(kind, "price_cross" | "timer"))
                .expect("valid plan");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, "any");
        assert_eq!(rows[0].1["type"], "price_cross");
        // 白名单外的类型 → 拒绝（不静默丢条件：丢条件 = 闭环断链）。
        assert!(wake_condition_rows(&plan, 1_000, |kind| kind == "price_cross").is_err());
        // mode 非法 / 超过 32 条 / 缺 type → 拒绝。
        assert!(
            wake_condition_rows(&json!({ "mode": "some", "conditions": [] }), 0, |_| true).is_err()
        );
        let many = json!({ "mode": "any", "conditions": vec![json!({"type": "timer"}); 33] });
        assert!(wake_condition_rows(&many, 0, |_| true).is_err());
        assert!(
            wake_condition_rows(&json!({ "mode": "any", "conditions": [ {} ] }), 0, |_| true)
                .is_err()
        );
    }

    /// 从缓存装配：五块齐 → state 完整；缺块 → 对应 `data_age_ms` 是 `i64::MAX`（gate 判 data）。
    #[test]
    fn assemble_from_cache_wires_cache_to_state() {
        let mut cache = FastlaneSnapshotCache::new("acct-1", "BTC-USDT-SWAP");
        assert_eq!(
            assemble_from_cache(
                &cache,
                &registry_instrument(),
                StateLimits {
                    target_leverage: 20,
                    max_single_trade_margin_pct: 30
                },
                Vec::new(),
                Vec::new(),
                1_000_000,
            )
            .to_state(1_000_000)["data_age_ms"]["ticker"],
            i64::MAX
        );
        cache.ticker = Some(SnapshotSlot::new(json!({ "last": 80_298.3 }), 999_000));
        cache.taker_buy_ratio_5m = Some(0.58);
        cache.candles_1m = Some(SnapshotSlot::new(
            (0..40)
                .map(|index| {
                    json!({ "time": 60_000 * index, "open": 1.0, "high": 2.0, "low": 0.5,
                            "close": 1.5, "volume": 3.0, "confirm": true })
                })
                .collect::<Vec<_>>(),
            999_900,
        ));
        let snapshot = assemble_from_cache(
            &cache,
            &registry_instrument(),
            StateLimits {
                target_leverage: 20,
                max_single_trade_margin_pct: 30,
            },
            Vec::new(),
            Vec::new(),
            1_000_000,
        );
        let state = snapshot.to_state(1_000_000);
        assert_eq!(state["data_age_ms"]["ticker"], 1_000);
        assert_eq!(state["data_age_ms"]["candles_1m_closed"], 100);
        assert_eq!(state["price"]["last"], 80_298.3);
        // micro 缺盘口 → 四键 null（对象保留）。
        assert!(state["micro"]["spread_bps"].is_null());
        assert_eq!(state["limits"]["target_leverage"], 20);
        // 主动买卖比进得了装配（不是"写进去没人消费"）。
        assert_eq!(cache.taker_buy_ratio_5m, Some(0.58));
    }
}
