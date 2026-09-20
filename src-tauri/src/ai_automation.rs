use super::*;
use desic_agent_automation::{
    build_ai_usage_summary, evaluate_condition,
    normalize_permission_mode, orderbook_imbalance, AiProfileSubAgent,
    DomainEvent, RollingFeatureCache, WakeCondition, WakeMarketState, ADVISOR_MODE,
    AI_USAGE_SCHEMA_VERSION,
};
pub(crate) use desic_agent_automation::{
    AiTokenUsage, AiUsageCoverage, AiUsageQuality, AiUsageSummary,
};
use rusqlite::{params_from_iter, TransactionBehavior};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::{Notify, Semaphore};

const AUTOMATION_EVENT: &str = "ai:automation-event";

/// 单次 provider 请求的空闲上限（毫秒），随每条 AI 命令 config 显式下发给侧车。
///
/// 来源：线上事故热修（2026-09-19）把侧车 `AI_REQUEST_IDLE_TIMEOUT_MS` 由 60s 提到
/// 240s（仍是"无 provider 活动"的空闲约束，不是总时长；本地 CLI provider 不受限）。
/// Rust 侧显式下发同一个值，避免"侧车支持但 Rust 永不下发"的配置漂移，
/// 将来要做成用户可配置时也有唯一落点。
pub(crate) const AI_REQUEST_IDLE_TIMEOUT_MS: i64 = 240_000;

/// 把单次请求的空闲上限显式写进侧车 config（唯一落点，便于测试断言）。
/// 幂等：重复调用只覆盖同一个键，不动其它字段。
pub(crate) fn with_request_timeout(mut config: Value) -> Value {
    if let Some(object) = config.as_object_mut() {
        object.insert(
            "requestTimeoutMs".to_string(),
            json!(AI_REQUEST_IDLE_TIMEOUT_MS),
        );
    }
    config
}
const FEISHU_CONFIG_EVENT_TYPES_VERSION: i64 = 2;
const FEISHU_STRATEGY_SIGNAL_EVENT: &str = "strategy_signal";
const AUTOMATION_RUN_LIST_PAGE_SIZE: i64 = 50;
const SKILL_FILES_FINGERPRINT_SETTING: &str = "skill_files_fingerprint";
const MAX_PROFILE_SYMBOLS: usize = 3;
const REQUIRED_PROFILE_SKILL_IDS: [&str; 6] = [
    "desic-core-operations",
    "trading-philosophy",
    "okx-market-intelligence",
    "market-radar-research",
    "desic-trade-operations",
    "desic-agent-orchestration",
];
const DAILY_MARKET_REVIEW_EVIDENCE_RULES: &str = "历史 Smart Money 日内证据必须优先使用 intelligence.smartMoney.readSignalTrendByFilter：instId 使用完整永续交易对，granularity=1h，ts 使用 windowEnd-1 的 13 位毫秒字符串，limit 按窗口小时数设置；后端会把 ts 转成 OKX UTC+8 小时 dataVersion，绝不向上游发送 ts。readSignalOverviewByFilter 是当前小时快照且不得传 ts/dataVersion，只能作为明确标注的复盘后补充，不能归入目标日期或用于制造历史证据冲突。Daily Briefing 是可选的预生成产物；未启用或返回空列表不属于原始市场数据缺口，不得单独据此否决结论。System Stress 应按返回时间桶和 coverage 披露实际覆盖范围；ADL unknown 只表示没有可确认的警告状态。accountId 是不透明稳定标识，其中的 demo/live 字样不代表环境；只以独立 environment 字段和后端账户绑定校验为准。";
const PERPETUAL_ACCOUNT_RISK_LANGUAGE_RULES: &str = "永续合约的张数、币数量、名义敞口、保证金、止损和 ATR 风险只使用 account.readRisk 的 instrumentEvaluations、trade.evaluatePlan 或 trade.precheck 返回的结构化字段，不得自行手算。effectiveExposureMultiple=名义敞口÷USDT权益，notionalPctOfEquity=effectiveExposureMultiple×100%；例如 notionalPctOfEquity=47.58% 等于 effectiveExposureMultiple=0.4758X，表示标的反向波动1%时，忽略费用、资金费和滑点，权益约损失0.4758%，不是占用47.58%保证金。notionalPctOfEquity不超过100%表示有效敞口不超过1X；不得仅凭账户余额绝对值、minSz或名义敞口比例称为高风险、高杠杆、账户太小、容错空间有限或不适合开仓。账户容错只能结合stopRiskPctOfEquity、oneAtrRiskPctOfEquity、marginPctOfEquity、剩余保证金、强平距离、已有持仓和组合总风险判断。trade.precheck返回blocked=false时必须称为账户可行；没有明确用户风险预算时只报告结构化数值，不自行发明风险阈值。";
const DAILY_MARKET_REVIEW_EVIDENCE_RULES_EN: &str = "For historical intraday Smart Money evidence, prefer intelligence.smartMoney.readSignalTrendByFilter. Use the complete perpetual instId, granularity=1h, a 13-digit millisecond ts equal to windowEnd-1, and a limit matching the window hours. The backend converts ts to the OKX UTC+8 hourly dataVersion and never forwards ts upstream. readSignalOverviewByFilter is a current-hour snapshot and must not receive ts/dataVersion; it may only be cited as a clearly labelled post-review supplement and must not be attributed to the target date or used to fabricate a historical evidence conflict. Daily Briefing is an optional pre-generated artifact; disabled or empty briefing results are not an original market-data gap and cannot independently invalidate a conclusion. Report the actual System Stress time buckets and coverage. ADL unknown only means that no warning state was confirmed. accountId is an opaque stable identifier; demo/live text inside it does not define the environment. Use only the separate environment field and backend account binding validation.";
const PERPETUAL_ACCOUNT_RISK_LANGUAGE_RULES_EN: &str = "For perpetual contracts, use only structured fields returned by account.readRisk instrumentEvaluations, trade.evaluatePlan, or trade.precheck for contract quantity, base quantity, notional exposure, margin, stop risk, and ATR risk. Never recompute them manually. effectiveExposureMultiple equals notional exposure divided by USDT equity, and notionalPctOfEquity equals effectiveExposureMultiple multiplied by 100%. For example, notionalPctOfEquity=47.58% means effectiveExposureMultiple=0.4758X: ignoring fees, funding, and slippage, an adverse 1% move in the instrument implies about a 0.4758% equity loss; it does not mean 47.58% margin usage. notionalPctOfEquity at or below 100% means effective exposure at or below 1X. Do not label an account high-risk, highly leveraged, too small, low-tolerance, or unsuitable solely from absolute balance, minSz, or notional exposure percentage. Judge account tolerance only with stopRiskPctOfEquity, oneAtrRiskPctOfEquity, marginPctOfEquity, remaining margin, liquidation distance, existing positions, and portfolio risk. If trade.precheck returns blocked=false, describe the account as feasible. Without an explicit user risk budget, report structured values and do not invent thresholds.";
const EXISTING_POSITION_MANAGEMENT_RULES: &str = "每轮必须把关注品种的现有持仓、当前普通和策略委托、已保存交易机会逐一核对，并把止损保护与止盈退出分开评估。每个仓位都必须在本轮输出 stopLossStatus、takeProfitStatus 和 positionDecision；已有止损不等于已经完成退出管理。止损用于失效或风险失控，止盈用于已验证的目标、阻力/支撑到达、剩余收益不足或有利动量衰减。没有证据支持的目标可以不创建止盈单，但必须明确说明暂无可验证止盈目标和下一次复评条件，不能编造目标价。有效目标应通过正常最终复核和 tradeOpportunity.create 创建 intent=close、exitKind=take_profit、orderType=limit、price=目标价、size=要平的张数；目标已达到且立即执行更安全时使用 exitKind=take_profit、orderType=market。止损使用 intent=close、exitKind=stop_loss：market 是立即风险退出，trigger 是保护性止损。所有 close 机会都必须填写 exitKind，closeFraction 只是可选元数据，size 才是权威平仓张数；已有仓位不得填写 takeProfit/stopLoss 字段。创建任何新退出前，必须按精确订单 ID 和语义角色与当前委托、已保存机会匹配；如果已有止盈或止损只需要移动价格，应使用带精确订单身份和新价格的 intent=amend 管理机会，不得再创建另一笔 close 委托。同一退出角色的活动平仓数量不得超过可平仓数量；如果已经存在重复委托，除非是数量互不重叠且有明确理由的分段退出，否则必须按精确订单身份取消或改单冗余委托。部分止盈后必须重新确认剩余仓位仍有有效止损。在 long/short 模式下同时持有反向仓位可以是对冲，但新开反向仓前必须明确说明对冲目标、规模关系、期限、解除/失效条件、双方退出机制和组合总风险；缺少这些组合层理由时优先管理已有敞口。";
const EXISTING_POSITION_MANAGEMENT_RULES_EN: &str = "On every run, reconcile each watched instrument's existing positions, current ordinary and algo orders, and saved trade opportunities, then evaluate stop-loss protection and take-profit exit separately. Every position must produce stopLossStatus, takeProfitStatus, and positionDecision; having a stop-loss does not complete exit management. Stop loss handles invalidation or unacceptable risk. Take profit handles a validated target, resistance/support reached, reward consumed, or favorable momentum decay. A target order is optional when no evidence-based target exists, but the run must explicitly state that no verifiable target exists and name the next reevaluation condition; never invent a target price. When a target is valid, use the normal final review and tradeOpportunity.create workflow with intent=close, exitKind=take_profit, orderType=limit, price equal to the target, and size equal to the contracts to close. If the target is already reached and immediate execution is safer, use exitKind=take_profit with orderType=market. For stop loss use intent=close and exitKind=stop_loss: market is an immediate risk exit and trigger is a protective stop. Every close opportunity must include exitKind; closeFraction is optional metadata and size is the authoritative close quantity. Existing-position close opportunities must not include takeProfit/stopLoss fields. Before creating any new exit, match it against current orders and saved opportunities by exact IDs and semantic role. If an existing take-profit or stop-loss should move, create an order-management opportunity with intent=amend, the exact order identity, and the new price; do not create another close order. For each exit role, active close quantity must not exceed the closable position size. If duplicates already exist, preserve only a documented staged plan with disjoint quantities and otherwise cancel or amend the redundant orders through their exact identities. After a partial take-profit, verify that the remaining position still has a valid stop loss. Opposite positions in long/short mode may be a hedge, but before opening the opposite side state its objective, size relationship, duration, unwind/invalidation condition, exits for both sides, and combined portfolio risk. Without that portfolio-level rationale, manage the existing exposure first.";

fn automation_response_instruction(locale: &str) -> &'static str {
    match locale {
        "zh-CN" => "请使用简体中文完成本轮分析与最终摘要。",
        "zh-TW" => "請使用繁體中文完成本輪分析與最終摘要。",
        "ja-JP" => "Respond in Japanese for the analysis and final summary.",
        "ko-KR" => "Respond in Korean for the analysis and final summary.",
        "de-DE" => "Respond in German for the analysis and final summary.",
        "fr-FR" => "Respond in French for the analysis and final summary.",
        "es-ES" => "Respond in Spanish for the analysis and final summary.",
        "pt-BR" => "Respond in Brazilian Portuguese for the analysis and final summary.",
        "ru-RU" => "Respond in Russian for the analysis and final summary.",
        _ => "Respond in English for the analysis and final summary.",
    }
}

fn automation_prompt_uses_chinese(locale: &str) -> bool {
    matches!(locale, "zh-CN" | "zh-TW")
}

#[derive(Clone)]
pub(crate) struct AiAutomationRuntime {
    notify: Arc<Notify>,
    started: Arc<AtomicBool>,
    feature_cache: Arc<Mutex<RollingFeatureCache>>,
    private_fingerprints: Arc<Mutex<HashMap<String, (String, String)>>>,
    run_slots: Arc<Semaphore>,
}

impl Default for AiAutomationRuntime {
    fn default() -> Self {
        Self {
            notify: Arc::new(Notify::new()),
            started: Arc::new(AtomicBool::new(false)),
            feature_cache: Arc::new(Mutex::new(RollingFeatureCache::default())),
            private_fingerprints: Arc::new(Mutex::new(HashMap::new())),
            run_slots: Arc::new(Semaphore::new(3)),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiAgentProfileSummary {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub mode: String,
    pub account_id: Option<String>,
    pub environment: String,
    pub symbols: Vec<String>,
    pub scan_interval_minutes: u32,
    pub skill_ids: Vec<String>,
    pub skill_versions: HashMap<String, u32>,
    #[serde(default)]
    pub skill_version_modes: HashMap<String, String>,
    pub model: Option<String>,
    #[serde(default = "default_profile_reasoning_depth")]
    pub reasoning_depth: String,
    pub history_lookback_days: u32,
    pub similarity_window_minutes: u32,
    pub entry_tolerance_bps: u32,
    #[serde(default = "default_target_leverage")]
    pub target_leverage: u32,
    #[serde(default = "default_max_single_trade_margin_pct")]
    pub max_single_trade_margin_pct: u32,
    pub min_wake_interval_seconds: u32,
    pub max_runs_per_hour: u32,
    pub feishu_enabled: bool,
    pub daily_review_enabled: bool,
    pub allowed_wake_condition_types: Vec<String>,
    /// 协作编排总开关（C14）：`false` → 运行载荷 `enabledAgents: []`（等价旧 `off`）。
    /// **关开关不清空勾选**：`enabled_agent_ids` 原样保留，重新开启即恢复。
    #[serde(default)]
    pub collaboration_enabled: bool,
    /// 勾选名单（C3）：空数组 = 主 Agent 独立工作（等价旧 `multiAgentMode=off`）。
    /// C20.5（强制迁移版）：**不再有"已忽略"提示字段** —— 含已下线 id 的旧 Profile
    /// 会被迁移成「默认 4 个角色 + 其余保留 id」并落库，所以生效名单里不会残留已下线 id。
    #[serde(default)]
    pub enabled_agent_ids: Vec<String>,
    /// C24 单 Agent 子模式（`standard` | `minimal`）。**仅在协作关闭时生效**；
    /// 协作开启时被忽略（读出来仍是 Profile 里存的值，供 UI 回显该设置）。
    #[serde(default = "default_single_agent_mode")]
    pub single_agent_mode: String,
    /// TypeSafe / Jev：本 Profile 运行时是否启用 Jev 快速判定（判定层，默认关闭）。
    #[serde(default)]
    pub typesafe_enabled: bool,
    /// C19 试判配置（缺字段 = C19.1 默认，`mode=enforce`）。
    #[serde(default)]
    pub triage: crate::ai_triage::AiAgentTriageConfig,
    /// C19 反饥饿统计：连续跳过次数（深度正常完成或强制升级后清零）。
    #[serde(default)]
    pub triage_skip_streak: u32,
    /// C19 反饥饿统计：上次深度运行完成时间（毫秒）。
    #[serde(default)]
    pub triage_last_deep_at: Option<i64>,
    // ===== DEPRECATED：旧列/旧快照只读兼容（迁移输入）=====
    // 只读、不写盘（`skip_serializing`）；旧的运行快照（profileSnapshotJson）里
    // 仍有 `multiAgentMode` / `multiAgents` / `multiAgentSchemeId`，
    // deserialize 时接住它们，用于内存迁移，保证升级后重放旧 Run 不改变行为。
    #[serde(default, rename = "multiAgentMode", skip_serializing)]
    pub(crate) legacy_multi_agent_mode: String,
    #[serde(default, rename = "multiAgents", skip_serializing)]
    pub(crate) legacy_multi_agents: Vec<AiProfileSubAgent>,
    #[serde(default, rename = "multiAgentSchemeId", skip_serializing)]
    pub(crate) legacy_multi_agent_scheme_id: Option<String>,
    /// 旧配置迁移提示（读旧写新时填充；空则不序列化，仅用于前端一次性提示与日志）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub migration_notes: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiAgentProfileInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_profile_mode")]
    pub mode: String,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default = "default_environment")]
    pub environment: String,
    #[serde(default)]
    pub symbols: Vec<String>,
    #[serde(default = "default_scan_interval")]
    pub scan_interval_minutes: u32,
    #[serde(default)]
    pub skill_ids: Vec<String>,
    #[serde(default)]
    pub skill_versions: HashMap<String, u32>,
    #[serde(default)]
    pub skill_version_modes: HashMap<String, String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default = "default_profile_reasoning_depth")]
    pub reasoning_depth: String,
    #[serde(default = "default_history_days")]
    pub history_lookback_days: u32,
    #[serde(default = "default_similarity_window")]
    pub similarity_window_minutes: u32,
    #[serde(default = "default_entry_tolerance")]
    pub entry_tolerance_bps: u32,
    #[serde(default = "default_target_leverage")]
    pub target_leverage: u32,
    #[serde(default = "default_max_single_trade_margin_pct")]
    pub max_single_trade_margin_pct: u32,
    #[serde(default = "default_max_runtime")]
    pub max_runtime_seconds: u32,
    #[serde(default = "default_min_wake_interval")]
    pub min_wake_interval_seconds: u32,
    #[serde(default = "default_max_runs_per_hour")]
    pub max_runs_per_hour: u32,
    #[serde(default)]
    pub feishu_enabled: bool,
    #[serde(default)]
    pub daily_review_enabled: bool,
    #[serde(default = "default_wake_condition_types")]
    pub allowed_wake_condition_types: Vec<String>,
    /// 协作编排总开关（C14）。
    ///
    /// 用 `Option` 区分两种"假"：`Some(false)` = 用户显式关闭；
    /// `None` = 调用方（例如尚未带上该字段的旧前端）没提供 → 保存时保留库中现值，
    /// 避免静默把已开启的协作关掉。新 Profile 缺省仍按关闭处理。
    #[serde(default)]
    pub collaboration_enabled: Option<bool>,
    /// 勾选名单（C3）：保存时用 Agent 库校验，不存在的 id 丢弃并记日志（不阻断保存）。
    #[serde(default)]
    pub enabled_agent_ids: Vec<String>,
    /// C19 试判配置（未设置 = C19.1 默认）。
    #[serde(default)]
    pub triage: crate::ai_triage::AiAgentTriageConfig,
    /// C24 单 Agent 子模式。
    ///
    /// 用 `Option` 区分两种"没选"：`Some(非法值)` = 用户/前端给了不认的值 → 回落 `standard`；
    /// `None` = 调用方（例如尚未带上该字段的旧前端）没提供 → **保留库中现值**，
    /// 与 `collaboration_enabled` 同一处理，避免静默把用户选的 `minimal` 改回 `standard`。
    /// 旧 Profile 行没有该列时列默认值就是 `standard`，所以"旧 Profile = standard"仍成立。
    #[serde(default)]
    pub single_agent_mode: Option<String>,
    /// TypeSafe / Jev：`None` = 调用方未提供 → 保存时保留库中现值（与 `collaboration_enabled`
    /// 同一规则，避免旧前端保存时静默关掉它）；旧 Profile 行该列为 0，所以"旧 Profile = 关闭"成立。
    #[serde(default)]
    pub typesafe_enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiAgentProfileSystematicConflictRequest {
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default = "default_environment")]
    pub environment: String,
    #[serde(default)]
    pub symbols: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiAgentProfileSystematicConflict {
    pub id: String,
    pub name: String,
    pub inst_id: String,
}



#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiAgentRunActionCounts {
    #[serde(default)]
    pub opportunity: u32,
    #[serde(default)]
    pub wake: u32,
    #[serde(default)]
    pub trade: u32,
    #[serde(default)]
    pub notification: u32,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiTokenUsagePeriod {
    pub usage: AiTokenUsage,
    pub coverage: AiUsageCoverage,
    pub turn_count: u32,
    pub session_count: u32,
    pub partial_turn_count: u32,
    pub unreported_turn_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiTokenUsageByModel {
    pub provider: String,
    pub model_id: String,
    pub model: String,
    pub model_name: String,
    pub today: AiTokenUsagePeriod,
    pub yesterday: AiTokenUsagePeriod,
    pub seven_days: AiTokenUsagePeriod,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiTokenUsageDashboard {
    pub generated_at: i64,
    pub window_start: i64,
    pub today: AiTokenUsagePeriod,
    pub yesterday: AiTokenUsagePeriod,
    pub seven_days: AiTokenUsagePeriod,
    pub by_model: Vec<AiTokenUsageByModel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiAgentRunSummary {
    pub id: String,
    /// C19 试判记录（mode/verdict/reasons/evidence/forcedBy/sampled/分阶段 token）。
    #[serde(default)]
    pub triage: Option<Value>,
    /// P1：专家级用量（`[{ expertId, configuredAgentId, toolCalls, startedAt, endedAt,
    /// durationMs, tokenUsage?, tokensUnavailable? }]`）——"不设轮次上限"的替代护栏。
    #[serde(default)]
    pub experts: Option<Value>,
    /// C20.6：`{ usedEvidence[], contrarianResolutions[], selfAnalysisReason?,
    /// selfAnalysisUnjustified?, summaryFormatWarnings[] }`（UI 展示审计轨迹）。
    #[serde(default)]
    pub audit: Option<Value>,
    /// C21.3 软审计：分析结果排版提醒（缺小节 / 无时间戳）。**只提示，不阻断、不改写正文**。
    #[serde(default)]
    pub summary_format_warnings: Vec<String>,
    /// C20.6：本轮结论引用了哪些专家事实（扁平暴露，UI 直接读 `run.usedEvidence`）。
    #[serde(default)]
    pub used_evidence: Option<Value>,
    /// C20.6：逐条回应反方意见（扁平暴露，UI 直接读 `run.contrarianResolutions`）。
    #[serde(default)]
    pub contrarian_resolutions: Option<Value>,
    /// C24：本次运行**实际生效**的单 Agent 子模式（`standard` | `minimal`）。
    /// 协作开启的运行恒为 `standard`；UI 用它显示极简徽标。
    #[serde(default = "default_single_agent_mode")]
    pub single_agent_mode: String,
    pub profile_id: String,
    pub trigger_type: String,
    pub status: String,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub next_wake_at: Option<i64>,
    pub action_counts: AiAgentRunActionCounts,
    pub token_usage: Option<AiUsageSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiAgentRunStatus {
    pub id: String,
    pub status: String,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub finished_at: Option<i64>,
    pub next_wake_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiAgentRunDetail {
    pub run: AiAgentRunSummary,
    pub trigger: Value,
    pub profile_snapshot: Value,
    pub template_snapshot: Value,
    pub skill_versions: Value,
    pub assistant_text: Option<String>,
    pub reasoning: Option<String>,
    pub tool_events: Vec<Value>,
    pub initial_market_snapshot: Value,
    pub final_decision: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiWakeConditionSummary {
    pub id: String,
    pub profile_id: String,
    pub source: String,
    pub plan_mode: String,
    pub condition_type: String,
    pub config: Value,
    pub status: String,
    pub expires_at: Option<i64>,
    pub last_triggered_at: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiTradeReviewSummary {
    pub id: String,
    pub episode_id: String,
    pub status: String,
    pub summary: String,
    pub findings: Vec<String>,
    pub suggestions: Vec<String>,
    pub net_pnl: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiDailyMarketReviewSummary {
    pub id: String,
    pub profile_id: String,
    pub profile_name: String,
    pub review_date: String,
    pub status: String,
    pub symbols: Vec<String>,
    pub summary: String,
    pub error: Option<String>,
    pub run_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiOptimizationSuggestionSummary {
    pub id: String,
    pub review_id: Option<String>,
    pub title: String,
    pub problem: String,
    pub evidence: Vec<String>,
    pub sample_size: u32,
    pub current_skill_id: Option<String>,
    pub current_skill_version: Option<u32>,
    pub proposed_changes: String,
    pub baseline_skill: Option<Value>,
    pub proposed_skill: Option<Value>,
    pub benefits: String,
    pub risks: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiNotificationDeliverySummary {
    pub id: String,
    pub channel: String,
    pub status: String,
    pub title: String,
    pub content: Option<String>,
    pub level: Option<String>,
    pub profile_id: Option<String>,
    pub profile_name: Option<String>,
    pub run_id: Option<String>,
    pub related_type: Option<String>,
    pub related_id: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
    pub sent_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiSkillVersionSummary {
    pub id: String,
    pub skill_id: String,
    pub version: u32,
    pub status: String,
    pub definition: Value,
    pub source_suggestion_id: Option<String>,
    pub created_at: i64,
    pub published_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeishuConfigSummary {
    pub enabled: bool,
    pub configured: bool,
    pub webhook_masked: String,
    pub event_types: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeishuConfigInput {
    pub enabled: bool,
    #[serde(default)]
    pub webhook_url: Option<String>,
    #[serde(default)]
    pub event_types: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiAutomationSummary {
    pub master_enabled: bool,
    pub profiles: Vec<AiAgentProfileSummary>,
    pub runs: Vec<AiAgentRunSummary>,
    pub wake_conditions: Vec<AiWakeConditionSummary>,
    pub reviews: Vec<AiTradeReviewSummary>,
    pub daily_market_reviews: Vec<AiDailyMarketReviewSummary>,
    pub optimization_suggestions: Vec<AiOptimizationSuggestionSummary>,
    pub notification_deliveries: Vec<AiNotificationDeliverySummary>,
    pub skill_versions: Vec<AiSkillVersionSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiAutomationOverview {
    pub master_enabled: bool,
    pub profiles: Vec<AiAgentProfileSummary>,
    pub skill_versions: Vec<AiSkillVersionSummary>,
    pub counts: AiAutomationCounts,
    pub profile_performance: Vec<AiProfilePerformance>,
}

/// Realised result attributed to one Profile over a trailing window.
///
/// A run does not carry money: profit lands on fills. Fills reference the run
/// that produced them via `agent_run_id`, so the Profile is reached through
/// `ai_agent_runs`. Fees arrive already signed negative, so the net figure is
/// `fill_pnl + fee` — the same convention the account performance page uses.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiProfilePerformance {
    pub profile_id: String,
    pub net_pnl_usdt: f64,
    pub fees_usdt: f64,
    pub fill_count: i64,
    pub window_days: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiAutomationCounts {
    pub runs: i64,
    pub running_runs: i64,
    pub active_wake_conditions: i64,
    pub reviews: i64,
    pub pending_optimization_suggestions: i64,
    pub notifications: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiAutomationSection {
    pub section: String,
    pub runs: Vec<AiAgentRunSummary>,
    pub wake_conditions: Vec<AiWakeConditionSummary>,
    pub reviews: Vec<AiTradeReviewSummary>,
    pub daily_market_reviews: Vec<AiDailyMarketReviewSummary>,
    pub optimization_suggestions: Vec<AiOptimizationSuggestionSummary>,
    pub notification_deliveries: Vec<AiNotificationDeliverySummary>,
    pub skill_versions: Vec<AiSkillVersionSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotificationSettingsSummary {
    pub feishu: FeishuConfigSummary,
}

/// C24：单 Agent 子模式（仅在 `collaborationEnabled === false` 的单 Agent 模式下生效）。
pub(crate) const SINGLE_AGENT_MODE_STANDARD: &str = "standard";
/// 极简模式：照常调用工具/创建机会/通知，但**不输出正文**，收尾只允许一句话。
pub(crate) const SINGLE_AGENT_MODE_MINIMAL: &str = "minimal";
/// C24.2-3：极简模式的 summary 硬限（按**显示宽度**计：CJK/全角 = 2、其余 = 1，
/// 因此约等于 80 个汉字）。**只标记、不阻断、不改写**。
pub(crate) const MINIMAL_SUMMARY_MAX_WIDTH: usize = 160;

/// C24.1：缺字段/非法值 → `standard`（旧 Profile 行为不变）。
pub(crate) fn normalize_single_agent_mode(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        SINGLE_AGENT_MODE_MINIMAL => SINGLE_AGENT_MODE_MINIMAL.to_string(),
        _ => SINGLE_AGENT_MODE_STANDARD.to_string(),
    }
}

/// C24.1：该 Profile 上**实际生效**的单 Agent 子模式。
/// 协作开启时该字段被忽略（不报错）→ 一律 `standard`（协作运行本来就有专家会话）。
pub(crate) fn effective_single_agent_mode(
    collaboration_enabled: bool,
    single_agent_mode: Option<&str>,
) -> String {
    if collaboration_enabled {
        return SINGLE_AGENT_MODE_STANDARD.to_string();
    }
    normalize_single_agent_mode(single_agent_mode.unwrap_or(SINGLE_AGENT_MODE_STANDARD))
}

/// C21 排版小节在 `desic-core-operations` 正文里的标题（极简模式要剔除它）。
const CORE_OPERATIONS_RUN_SUMMARY_MARKER: &str = "V. Analysis-result formatting (run summary)";

/// C24.2：极简模式**替代 C21 排版小节**的一行规则（中英双语，附显示宽度口径）。
const MINIMAL_SUMMARY_RULE: &str = "V. Minimal mode (single agent): this run runs in Minimal mode. Do not output any assistant prose — express every action through tool calls only (data reads, prechecks, opportunity creation, notifications, finishRun). The summary submitted to background.finishRun must be ONE single sentence with no line breaks and at most 160 display columns (CJK / full-width characters count as 2, so about 80 Chinese characters): no sections, no headings, no bullet lists.\n极简模式：本轮不输出正文，一切动作只用工具调用表达；background.finishRun 的 summary 必须是一句话、不含换行、不超过 160 显示宽度（中文/全角字符按 2 计，约 80 个汉字），不要小节、不要标题、不要列表。";

/// C24.2：极简模式下把 `desic-core-operations` 的 **C21 排版小节**（`V. …` 及其条目 28–34）
/// 换成 [`MINIMAL_SUMMARY_RULE`]。
///
/// 原因（真实运行证据）：`desic-core-operations` 是**恒注入**的，它要求"首屏先结论 + 五个固定
/// 小节"，而极简模式要求"一句话、不要小节" —— 两条指令直接冲突，模型会选更长更具体的那条
/// （Skill）。**从源头消除冲突**比让模型二选一可靠。
fn minimal_core_operations_content(content: &str) -> String {
    match content.find(CORE_OPERATIONS_RUN_SUMMARY_MARKER) {
        Some(index) => {
            // 小节从它前面那个空行开始，一起剔除（保留 1–27 原样）。
            let head = content[..index].trim_end();
            format!("{head}\n\n{MINIMAL_SUMMARY_RULE}")
        }
        // 旧版（还没有 C21 小节）：直接补上极简规则，不动既有内容。
        None => format!("{}\n\n{MINIMAL_SUMMARY_RULE}", content.trim_end()),
    }
}

/// C24.2：把生效模式应用到**本轮下发**的技能定义上。
/// 标准模式**逐字不变**（C21 小节照旧注入）。
pub(crate) fn apply_single_agent_mode_to_skill_definitions(
    definitions: &mut [desic_storage_config::AiSkillDefinition],
    single_agent_mode: &str,
) {
    if single_agent_mode != SINGLE_AGENT_MODE_MINIMAL {
        return;
    }
    for skill in definitions.iter_mut() {
        if skill.id == "desic-core-operations" {
            skill.content = minimal_core_operations_content(&skill.content);
        }
    }
}

/// C24.2-3：极简模式 summary 的**显示宽度**（CJK / 全角标点按 2 计）。
fn text_display_width(text: &str) -> usize {
    text.chars()
        .map(|character| {
            let code = character as u32;
            let wide = matches!(code,
                0x1100..=0x115F
                    | 0x2E80..=0xA4CF
                    | 0xA960..=0xA97F
                    | 0xAC00..=0xD7A3
                    | 0xF900..=0xFAFF
                    | 0xFE30..=0xFE6F
                    | 0xFF00..=0xFF60
                    | 0xFFE0..=0xFFE6
                    | 0x1F300..=0x1FAFF
            );
            if wide {
                2
            } else {
                1
            }
        })
        .sum()
}

/// C22.3-B：收尾软校验（最多打回一次）的 **run 级**状态。
///
/// 与 triage 状态同源：挂在 `BackgroundRunContext` 上、随运行创建/销毁，
/// **不新增全局表、不跨运行泄漏**（新运行 = 新状态 = 计数归零）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct FinishGateState {
    /// 已因"升级深度却零专家且未填 `selfAnalysisReason`"打回过的次数（C22.3-B）。
    pub self_analysis_pushbacks: u8,
}

/// C22.3-B：软校验最多打回的次数。**软校验的边界**：打回一次之后必须接受，
/// 任何情况下都不允许把运行卡死或判失败。
pub(crate) const SELF_ANALYSIS_MAX_PUSHBACKS: u8 = 1;

#[derive(Debug, Clone)]
pub(crate) struct BackgroundRunContext {
    pub permission_mode: String,
    pub account_id: Option<String>,
    pub environment: Option<String>,
    pub symbols: Vec<String>,
    pub profile_id: Option<String>,
    pub run_id: Option<String>,
    pub enabled_skills: Vec<String>,
    pub skill_versions: HashMap<String, u32>,
    pub skill_definitions: Vec<desic_storage_config::AiSkillDefinition>,
    pub model: Option<String>,
    pub reasoning_depth: String,
    pub history_lookback_days: u32,
    pub target_leverage: u32,
    pub max_single_trade_margin_pct: u32,
    pub allowed_wake_condition_types: Vec<String>,
    /// 本次运行可点名专家（契约 C4）：Profile 勾选且库中存在的库条目（含正文）。
    /// 顺序按勾选顺序去重；空 = 主 Agent 独立完成（等价旧 off）。
    pub enabled_agents: Vec<desic_agent_automation::AiAgentDefinition>,
    /// C19 试判阶段状态：`Arc<Mutex<..>>` 让同一次运行的所有工具调用共享阶段与 verdict
    /// （阶段门必须在授权层可读，见 `lib.rs::authorize_ai_tool`）。
    pub triage: Arc<Mutex<crate::ai_triage::RunTriageState>>,
    /// C22.3-B 收尾软校验状态（同一次运行的所有 `finishRun` 调用共享）。
    pub finish_gate: Arc<Mutex<FinishGateState>>,
    /// C24：本次运行**实际生效**的单 Agent 子模式（`standard` | `minimal`）。
    /// 协作开启时恒为 `standard`（该字段在协作模式下被忽略）。
    pub single_agent_mode: String,
    /// 本次运行的触发载荷（C19：条件共振与"是否突破 AI 标记位"由它推导）。
    pub trigger: serde_json::Value,
    pub review_id: Option<String>,
    pub episode_id: Option<String>,
}

impl BackgroundRunContext {
    pub fn is_background(&self) -> bool {
        self.profile_id.is_some() && self.run_id.is_some()
    }

    pub fn is_review(&self) -> bool {
        self.review_id.is_some()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundFinishRunInput {
    pub summary: String,
    #[serde(default)]
    pub final_decision: Option<Value>,
    pub next_wake_plan: BackgroundWakePlanInput,
    /// C20.6 审计字段：本轮实际用到的证据（专家 id + 证据要点）。**可选**，形状宽容。
    #[serde(default)]
    pub used_evidence: Vec<Value>,
    /// C20.6 审计字段：对反方审查逐条回应与最终决定。**可选**，形状宽容。
    #[serde(default)]
    pub contrarian_resolutions: Vec<Value>,
    /// C20.6 补充（**可选**）：升级为深度运行却没有任何专家活动时，主 Agent 自己
    /// 取证并判断的理由。缺省不报错；空 + 无专家活动 + 无 usedEvidence → 审计里
    /// 记 `selfAnalysisUnjustified: true`（**只标记，不失败**）。
    #[serde(default)]
    pub self_analysis_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundWakePlanInput {
    #[serde(default = "default_wake_mode")]
    pub mode: String,
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub conditions: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeishuSendInput {
    pub title: String,
    pub content: String,
    #[serde(default = "default_notification_level")]
    pub level: String,
    #[serde(default)]
    pub related_type: Option<String>,
    #[serde(default)]
    pub related_id: Option<String>,
    #[serde(default)]
    pub agent_profile_id: Option<String>,
    #[serde(default)]
    pub agent_run_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewCompleteInput {
    pub summary: String,
    #[serde(default)]
    pub findings: Vec<String>,
    #[serde(default)]
    pub suggestions: Vec<String>,
    #[serde(default)]
    pub skill_version: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OptimizationSuggestionInput {
    pub title: String,
    pub problem: String,
    #[serde(default)]
    pub evidence: Vec<String>,
    #[serde(default = "default_sample_size")]
    pub sample_size: u32,
    #[serde(default)]
    pub current_skill_id: Option<String>,
    #[serde(default)]
    pub current_skill_version: Option<u32>,
    pub proposed_changes: String,
    #[serde(default)]
    pub proposed_skill: Option<desic_storage_config::AiSkillDefinition>,
    pub benefits: String,
    pub risks: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewSkillVersionInput {
    pub skill_id: String,
    pub version: u32,
}

fn default_profile_mode() -> String {
    ADVISOR_MODE.to_string()
}
fn default_environment() -> String {
    "demo".to_string()
}
fn default_scan_interval() -> u32 {
    30
}
fn default_history_days() -> u32 {
    30
}
fn default_similarity_window() -> u32 {
    10
}
fn default_entry_tolerance() -> u32 {
    30
}
fn default_target_leverage() -> u32 {
    20
}
fn default_max_single_trade_margin_pct() -> u32 {
    30
}
/// C24.1：缺字段 → `standard`。
fn default_single_agent_mode() -> String {
    SINGLE_AGENT_MODE_STANDARD.to_string()
}
fn default_profile_reasoning_depth() -> String {
    "medium".to_string()
}
fn default_max_runtime() -> u32 {
    180
}
fn default_min_wake_interval() -> u32 {
    60
}
fn default_max_runs_per_hour() -> u32 {
    12
}
/// DEPRECATED 读旧列兜底：仅迁移路径使用。
fn default_wake_mode() -> String {
    "any".to_string()
}
fn default_notification_level() -> String {
    "info".to_string()
}
fn default_sample_size() -> u32 {
    1
}

fn default_wake_condition_types() -> Vec<String> {
    [
        "timer",
        "price_cross",
        "price_change_pct",
        "candle_volume_ratio",
        "funding_rate_threshold",
        "orderbook_imbalance",
        "order_state_changed",
        "position_changed",
        "opportunity_state_changed",
        "episode_closed",
        "open_interest_anomaly",
        "taker_flow_imbalance",
        "crowding_divergence",
        "funding_extreme",
        "liquidation_cluster",
        "important_news_event",
        "sentiment_reversal",
        "smart_money_change",
        "macro_event_window",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

pub(crate) fn migrate_ai_automation(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS ai_automation_settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ai_agent_profiles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 0,
          mode TEXT NOT NULL,
          account_id TEXT,
          environment TEXT NOT NULL,
          symbols_json TEXT NOT NULL,
          scan_interval_minutes INTEGER NOT NULL,
          skill_ids_json TEXT NOT NULL,
          skill_versions_json TEXT NOT NULL DEFAULT '{}',
          skill_version_modes_json TEXT NOT NULL DEFAULT '{}',
          model TEXT,
          reasoning_depth TEXT NOT NULL DEFAULT 'medium',
          history_lookback_days INTEGER NOT NULL,
          similarity_window_minutes INTEGER NOT NULL,
          entry_tolerance_bps INTEGER NOT NULL,
          max_runtime_seconds INTEGER NOT NULL,
          min_wake_interval_seconds INTEGER NOT NULL,
          max_runs_per_hour INTEGER NOT NULL,
          feishu_enabled INTEGER NOT NULL DEFAULT 0,
          daily_review_enabled INTEGER NOT NULL DEFAULT 0,
          allowed_wake_condition_types_json TEXT NOT NULL,
          multi_agent_mode TEXT NOT NULL DEFAULT 'off',
          multi_agent_max_agents INTEGER NOT NULL DEFAULT 4,
          multi_agents_json TEXT NOT NULL DEFAULT '[]',
          multi_agent_scheme_id TEXT,
          target_leverage INTEGER NOT NULL DEFAULT 20,
          max_single_trade_margin_pct INTEGER NOT NULL DEFAULT 30,
          typesafe_enabled INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          deleted_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_ai_agent_profiles_enabled
          ON ai_agent_profiles(enabled, deleted_at, updated_at DESC);
        CREATE TABLE IF NOT EXISTS ai_agent_schemes (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          agents_json TEXT NOT NULL,
          instructions TEXT NOT NULL DEFAULT '',
          skill_ids_json TEXT NOT NULL DEFAULT '[]',
          phase TEXT NOT NULL DEFAULT 'primary',
          model TEXT,
          reasoning_depth TEXT NOT NULL DEFAULT 'medium',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_agent_schemes_updated
          ON ai_agent_schemes(updated_at DESC);
        CREATE TABLE IF NOT EXISTS ai_agent_runs (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL,
          trigger_type TEXT NOT NULL,
          status TEXT NOT NULL,
          trigger_json TEXT,
          profile_snapshot_json TEXT,
           template_snapshot_json TEXT,
          skill_versions_json TEXT NOT NULL DEFAULT '{}',
          initial_market_snapshot_json TEXT,
          final_decision_json TEXT,
          action_counts_json TEXT NOT NULL DEFAULT '{}',
          token_usage_json TEXT,
          summary TEXT,
          error TEXT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          next_wake_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_queue
          ON ai_agent_runs(status, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_profile
          ON ai_agent_runs(profile_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_created
          ON ai_agent_runs(created_at DESC);
        CREATE TABLE IF NOT EXISTS ai_wake_conditions (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL,
          source TEXT NOT NULL,
          plan_mode TEXT NOT NULL DEFAULT 'any',
          condition_type TEXT NOT NULL,
          config_json TEXT NOT NULL,
          status TEXT NOT NULL,
          expires_at INTEGER,
          last_triggered_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_wake_conditions_active
          ON ai_wake_conditions(profile_id, status, expires_at);
        CREATE TABLE IF NOT EXISTS ai_trade_reviews (
          id TEXT PRIMARY KEY,
          episode_id TEXT NOT NULL,
          review_version INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          findings_json TEXT NOT NULL DEFAULT '[]',
          suggestions_json TEXT NOT NULL DEFAULT '[]',
          net_pnl TEXT,
          skill_version INTEGER,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(episode_id, review_version)
        );
        CREATE INDEX IF NOT EXISTS idx_ai_trade_reviews_status
          ON ai_trade_reviews(status, created_at ASC);
        CREATE TABLE IF NOT EXISTS ai_daily_market_reviews (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL,
          review_date TEXT NOT NULL,
          status TEXT NOT NULL,
          symbols_json TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          error TEXT,
          run_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(profile_id, review_date)
        );
        CREATE INDEX IF NOT EXISTS idx_ai_daily_market_reviews_date
          ON ai_daily_market_reviews(review_date DESC, updated_at DESC);
        CREATE TABLE IF NOT EXISTS ai_optimization_suggestions (
          id TEXT PRIMARY KEY,
          review_id TEXT,
          title TEXT NOT NULL,
          problem TEXT NOT NULL,
          evidence_json TEXT NOT NULL,
          sample_size INTEGER NOT NULL,
          current_skill_id TEXT,
          current_skill_version INTEGER,
          proposed_changes TEXT NOT NULL,
          proposed_skill_json TEXT,
          benefits TEXT NOT NULL,
          risks TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_optimization_suggestions_status
          ON ai_optimization_suggestions(status, created_at DESC);
        CREATE TABLE IF NOT EXISTS ai_notification_deliveries (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          status TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          level TEXT NOT NULL,
          profile_id TEXT,
          run_id TEXT,
          related_type TEXT,
          related_id TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          sent_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_ai_notification_deliveries_created
          ON ai_notification_deliveries(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_notification_deliveries_run
          ON ai_notification_deliveries(run_id);
        CREATE TABLE IF NOT EXISTS ai_domain_events (
          id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          account_id TEXT,
          inst_id TEXT,
          opportunity_id TEXT,
          episode_id TEXT,
          state TEXT,
          payload_json TEXT NOT NULL DEFAULT '{}',
          occurred_at INTEGER NOT NULL,
          processed_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_ai_domain_events_pending
          ON ai_domain_events(processed_at, occurred_at ASC);
        CREATE TABLE IF NOT EXISTS ai_skill_versions (
          id TEXT PRIMARY KEY,
          skill_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          status TEXT NOT NULL,
          content TEXT NOT NULL,
          source_suggestion_id TEXT,
          created_at INTEGER NOT NULL,
          published_at INTEGER,
          UNIQUE(skill_id, version)
        );
        ",
    )
    .map_err(|err| err.to_string())?;
    let _ = conn.execute(
        "DELETE FROM ai_skill_versions
         WHERE rowid IN (
           SELECT rowid FROM (
             SELECT rowid,
                    ROW_NUMBER() OVER (
                      PARTITION BY source_suggestion_id
                      ORDER BY CASE WHEN status='published' THEN 0 ELSE 1 END,version DESC,created_at DESC
                    ) AS row_num
             FROM ai_skill_versions WHERE source_suggestion_id IS NOT NULL
           ) WHERE row_num>1
         )",
        [],
    );
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_skill_versions_source_suggestion
         ON ai_skill_versions(source_suggestion_id) WHERE source_suggestion_id IS NOT NULL",
        [],
    )
    .map_err(|err| err.to_string())?;
    let _ = conn.execute(
        "ALTER TABLE ai_agent_runs ADD COLUMN profile_snapshot_json TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_agent_runs ADD COLUMN template_snapshot_json TEXT",
        [],
    );
    // C19：run 级试判记录（mode / verdict / reasons / evidence / forcedBy / sampled /
    // nextWakePlan / 分阶段 token）。
    let _ = conn.execute(
        "ALTER TABLE ai_agent_runs ADD COLUMN triage_json TEXT",
        [],
    );
    // P1（C20）：专家级用量（每位专家的工具次数、起止时间、时长、可用时的 token）。
    let _ = conn.execute(
        "ALTER TABLE ai_agent_runs ADD COLUMN experts_json TEXT",
        [],
    );
    // C20.6：审计字段（usedEvidence / contrarianResolutions）。
    let _ = conn.execute(
        "ALTER TABLE ai_agent_runs ADD COLUMN audit_json TEXT",
        [],
    );
    // C24：该运行**实际生效**的单 Agent 子模式（协作开启时恒为 `standard`）。
    // 存 run 行是为了运行详情能显示徽标、过后也能复盘"这轮是不是极简"。
    let _ = conn.execute(
        "ALTER TABLE ai_agent_runs ADD COLUMN single_agent_mode TEXT NOT NULL DEFAULT 'standard'",
        [],
    );
    // TypeSafe / Jev：Profile 级开关（默认关闭）。旧库补列，幂等（列已存在时忽略错误）。
    let _ = conn.execute(
        "ALTER TABLE ai_agent_profiles ADD COLUMN typesafe_enabled INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_agent_runs ADD COLUMN initial_market_snapshot_json TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_agent_runs ADD COLUMN final_decision_json TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_agent_runs ADD COLUMN skill_versions_json TEXT NOT NULL DEFAULT '{}'",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_agent_runs ADD COLUMN action_counts_json TEXT NOT NULL DEFAULT '{}'",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_agent_runs ADD COLUMN token_usage_json TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_messages ADD COLUMN token_usage_json TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_messages ADD COLUMN token_usage_version INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_ai_messages_usage_window
         ON ai_messages(role, created_at) WHERE token_usage_json IS NOT NULL",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_notification_deliveries ADD COLUMN content TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_optimization_suggestions ADD COLUMN proposed_skill_json TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_notification_deliveries ADD COLUMN profile_id TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_notification_deliveries ADD COLUMN run_id TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_agent_profiles ADD COLUMN daily_review_enabled INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_agent_profiles ADD COLUMN multi_agent_mode TEXT NOT NULL DEFAULT 'off'",
        [],
    );
    // v3（契约 C3）：勾选名单。旧列保留不写不读（回滚需要），新列是唯一写入口。
    let _ = conn.execute(
        "ALTER TABLE ai_agent_profiles ADD COLUMN enabled_agent_ids_json TEXT NOT NULL DEFAULT '[]'",
        [],
    );
    // C24：单 Agent 子模式（`standard` | `minimal`；列默认 = 旧 Profile 行为不变）。
    let _ = conn.execute(
        "ALTER TABLE ai_agent_profiles ADD COLUMN single_agent_mode TEXT NOT NULL DEFAULT 'standard'",
        [],
    );
    // C19 试判：Profile 级配置（JSON，缺字段由 serde 默认补成 C19.1）+ 反饥饿统计。
    let _ = conn.execute(
        "ALTER TABLE ai_agent_profiles ADD COLUMN triage_json TEXT NOT NULL DEFAULT '{}'",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_agent_profiles ADD COLUMN triage_skip_streak INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_agent_profiles ADD COLUMN triage_last_deep_at INTEGER",
        [],
    );
    // v3（契约 C14）：协作编排总开关。列是**载荷闸门**，不是新的 JS 分支。
    let collaboration_column_existed = conn
        .prepare("PRAGMA table_info(ai_agent_profiles)")
        .and_then(|mut stmt| {
            stmt.query_map([], |row| row.get::<_, String>(1))
                .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        })
        .map(|columns| columns.iter().any(|column| column == "collaboration_enabled"))
        .unwrap_or(true);
    let _ = conn.execute(
        "ALTER TABLE ai_agent_profiles ADD COLUMN collaboration_enabled INTEGER NOT NULL DEFAULT 0",
        [],
    );
    if !collaboration_column_existed {
        // 一次性回填（只在列首次加入时执行）：C14 迁移规则最后一条——
        // 已有勾选的旧行一律视为"协作开启"；之后用户显式关闭的 0 不会被这条覆盖。
        let _ = conn.execute(
            "UPDATE ai_agent_profiles SET collaboration_enabled=1
             WHERE enabled_agent_ids_json IS NOT NULL AND enabled_agent_ids_json NOT IN ('', '[]')",
            [],
        );
    }
    let _ = conn.execute(
        "ALTER TABLE ai_agent_profiles ADD COLUMN multi_agent_orchestrator TEXT NOT NULL DEFAULT 'backend'",
        [],
    );
    // expert_source 默认留空：读取时空值由 multiAgentMode 推导（custom→custom），
    // 避免迁移把存量 custom Profile 误标为 auto 名单。
    let _ = conn.execute(
        "ALTER TABLE ai_agent_profiles ADD COLUMN multi_agent_expert_source TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_agent_profiles ADD COLUMN multi_agent_max_agents INTEGER NOT NULL DEFAULT 4",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_agent_profiles ADD COLUMN multi_agents_json TEXT NOT NULL DEFAULT '[]'",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_agent_profiles ADD COLUMN multi_agent_scheme_id TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_agent_profiles ADD COLUMN target_leverage INTEGER NOT NULL DEFAULT 20",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_agent_profiles ADD COLUMN max_single_trade_margin_pct INTEGER NOT NULL DEFAULT 30",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_agent_profiles ADD COLUMN skill_version_modes_json TEXT NOT NULL DEFAULT '{}'",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_agent_profiles ADD COLUMN reasoning_depth TEXT NOT NULL DEFAULT 'medium'",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_agent_schemes ADD COLUMN instructions TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_agent_schemes ADD COLUMN skill_ids_json TEXT NOT NULL DEFAULT '[]'",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE ai_agent_schemes ADD COLUMN phase TEXT NOT NULL DEFAULT 'primary'",
        [],
    );
    let _ = conn.execute("ALTER TABLE ai_agent_schemes ADD COLUMN model TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE ai_agent_schemes ADD COLUMN reasoning_depth TEXT NOT NULL DEFAULT 'medium'",
        [],
    );
    let _ = conn.execute(
        "UPDATE ai_agent_runs SET status='cancelled',error='迁移时合并了重复活动 Run',finished_at=updated_at
         WHERE id IN (
           SELECT id FROM (
             SELECT id,ROW_NUMBER() OVER (PARTITION BY profile_id ORDER BY created_at ASC) AS row_num
             FROM ai_agent_runs WHERE status IN ('queued','running')
           ) WHERE row_num>1
         )",
        [],
    );
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_agent_runs_one_active_profile
         ON ai_agent_runs(profile_id) WHERE status IN ('queued','running')",
        [],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_created
         ON ai_agent_runs(created_at DESC)",
        [],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_ai_notification_deliveries_run
         ON ai_notification_deliveries(run_id)",
        [],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn ai_automation_summary(
    app: tauri::AppHandle,
) -> Result<AiAutomationSummary, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_automation_database(&app)?;
        ensure_skill_versions(&app, &conn)?;
        reconcile_profile_model_references(&app, &conn)?;
        // 首次查询兜底：清掉进程已死但状态仍是 running 的运行（幂等，失败不影响查询）。
        let _ = fail_stale_running_runs(&conn, now_ms());
        Ok(AiAutomationSummary {
            master_enabled: automation_master_enabled_with_conn(&conn),
            profiles: load_profiles(&conn)?,
            runs: load_runs(&conn, 100)?,
            wake_conditions: load_wake_conditions(&conn, 200)?,
            reviews: load_reviews(&conn, 100)?,
            daily_market_reviews: load_daily_market_reviews(&conn, 100)?,
            optimization_suggestions: load_optimization_suggestions(&conn, 100)?,
            notification_deliveries: load_notification_deliveries(&conn, 100)?,
            skill_versions: load_skill_versions(&conn, 200)?,
        })
    })
    .await
    .map_err(|err| format!("读取自动化摘要任务失败: {err}"))?
}

#[tauri::command]
pub(crate) async fn ai_automation_overview(
    app: tauri::AppHandle,
) -> Result<AiAutomationOverview, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_automation_database(&app)?;
        ensure_skill_versions(&app, &conn)?;
        // 首次查询兜底：清掉进程已死但状态仍是 running 的运行（幂等，失败不影响查询）。
        let _ = fail_stale_running_runs(&conn, now_ms());
        Ok(AiAutomationOverview {
            master_enabled: automation_master_enabled_with_conn(&conn),
            profiles: load_profiles(&conn)?,
            skill_versions: load_skill_versions(&conn, 200)?,
            counts: load_automation_counts(&conn)?,
            profile_performance: load_profile_performance(&conn, PROFILE_PERFORMANCE_WINDOW_DAYS)?,
        })
    })
    .await
    .map_err(|err| format!("读取自动化概览任务失败: {err}"))?
}

pub(crate) fn sync_ai_skill_versions(app: &tauri::AppHandle) -> Result<(), String> {
    let conn = open_automation_database(app)?;
    ensure_skill_versions(app, &conn)
}

/// Trailing window used for the Profile cards. Seven days was too short in
/// practice: an account that traded a couple of weeks ago showed no result at
/// all, so the card looked broken rather than quiet. Thirty days covers a normal
/// review cycle while still describing current behaviour.
const PROFILE_PERFORMANCE_WINDOW_DAYS: i64 = 30;

/// Aggregates realised profit per Profile over the trailing window.
///
/// Only fills that name a run are counted: a manual trade on the same account
/// is not this Profile's result. Rows with unparsable numbers contribute zero
/// rather than poisoning the sum.
fn load_profile_performance(
    conn: &Connection,
    window_days: i64,
) -> Result<Vec<AiProfilePerformance>, String> {
    let since = now_ms() - window_days * 24 * 60 * 60 * 1000;
    let mut statement = conn
        .prepare(
            "SELECT ar.profile_id,
                    COALESCE(SUM(CAST(f.fill_pnl AS REAL)), 0.0) AS pnl,
                    COALESCE(SUM(CAST(f.fee AS REAL)), 0.0) AS fee,
                    COUNT(*) AS fills
             FROM okx_fills f
             JOIN ai_agent_runs ar ON ar.id = f.agent_run_id
             WHERE f.agent_run_id IS NOT NULL
               AND f.okx_ts >= ?1
             GROUP BY ar.profile_id",
        )
        .map_err(|err| err.to_string())?;
    let rows = statement
        .query_map(params![since], |row| {
            let pnl: f64 = row.get(1)?;
            let fee: f64 = row.get(2)?;
            Ok(AiProfilePerformance {
                profile_id: row.get(0)?,
                // Fees are stored negative, so adding them yields the net result.
                net_pnl_usdt: pnl + fee,
                fees_usdt: fee.abs(),
                fill_count: row.get(3)?,
                window_days,
            })
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    Ok(rows)
}

fn load_automation_counts(conn: &Connection) -> Result<AiAutomationCounts, String> {
    conn.query_row(
        "SELECT
           MIN((SELECT COUNT(*) FROM ai_agent_runs), 100),
           MIN((SELECT COUNT(*) FROM ai_agent_runs WHERE status IN ('queued', 'running')), 100),
           MIN((SELECT COUNT(*) FROM ai_wake_conditions WHERE status = 'active'), 200),
           MIN((SELECT COUNT(*) FROM ai_trade_reviews), 100)
             + MIN((SELECT COUNT(*) FROM ai_daily_market_reviews), 100),
           MIN((SELECT COUNT(*) FROM ai_optimization_suggestions
                WHERE status IN ('pending', 'pending_review', 'validating', 'ready')), 100),
           MIN((SELECT COUNT(*) FROM ai_notification_deliveries), 100)",
        [],
        |row| {
            Ok(AiAutomationCounts {
                runs: row.get(0)?,
                running_runs: row.get(1)?,
                active_wake_conditions: row.get(2)?,
                reviews: row.get(3)?,
                pending_optimization_suggestions: row.get(4)?,
                notifications: row.get(5)?,
            })
        },
    )
    .map_err(|err| format!("读取自动化计数失败: {err}"))
}

#[tauri::command]
pub(crate) async fn ai_automation_section(
    app: tauri::AppHandle,
    section: String,
) -> Result<AiAutomationSection, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_automation_database(&app)?;
        let mut result = AiAutomationSection {
            section: section.clone(),
            ..Default::default()
        };
        match section.as_str() {
            "runs" => {
                result.runs = load_runs(&conn, AUTOMATION_RUN_LIST_PAGE_SIZE)?;
                result.notification_deliveries =
                    load_notification_deliveries(&conn, AUTOMATION_RUN_LIST_PAGE_SIZE)?;
            }
            "wake_conditions" => {
                result.wake_conditions = load_wake_conditions(&conn, 200)?;
                result.runs = load_runs(&conn, AUTOMATION_RUN_LIST_PAGE_SIZE)?;
            }
            "reviews" => {
                result.reviews = load_reviews(&conn, 100)?;
                result.daily_market_reviews = load_daily_market_reviews(&conn, 100)?;
            }
            "optimization" => {
                result.optimization_suggestions = load_optimization_suggestions(&conn, 100)?;
                result.skill_versions = load_skill_versions(&conn, 200)?;
            }
            "notifications" => {
                result.notification_deliveries = load_notification_deliveries(&conn, 100)?;
            }
            _ => return Err(format!("未知自动化数据区段: {section}")),
        }
        Ok(result)
    })
    .await
    .map_err(|err| format!("读取自动化区段任务失败: {err}"))?
}

struct AiUsageRecord {
    session_id: String,
    created_at: i64,
    summary: AiUsageSummary,
}

#[derive(Default)]
struct AiUsageAccumulator {
    usage: AiTokenUsage,
    coverage: Option<AiUsageCoverage>,
    sessions: HashSet<String>,
    turn_count: u32,
    partial_turn_count: u32,
    unreported_turn_count: u32,
}

impl AiUsageAccumulator {
    fn add(&mut self, record: &AiUsageRecord) {
        self.turn_count = self.turn_count.saturating_add(1);
        self.sessions.insert(record.session_id.clone());
        if record.summary.reported {
            self.usage.add_assign(&record.summary.usage);
            self.coverage = Some(match self.coverage.take() {
                Some(mut coverage) => {
                    coverage.input_output &= record.summary.coverage.input_output;
                    coverage.cache_read &= record.summary.coverage.cache_read;
                    coverage.cache_write &= record.summary.coverage.cache_write;
                    coverage.reasoning &= record.summary.coverage.reasoning;
                    coverage
                }
                None => record.summary.coverage.clone(),
            });
            if record.summary.quality == AiUsageQuality::Partial {
                self.partial_turn_count = self.partial_turn_count.saturating_add(1);
            }
        } else {
            self.unreported_turn_count = self.unreported_turn_count.saturating_add(1);
        }
    }

    fn finish(self) -> AiTokenUsagePeriod {
        AiTokenUsagePeriod {
            usage: self.usage,
            coverage: self.coverage.unwrap_or_default(),
            turn_count: self.turn_count,
            session_count: self.sessions.len() as u32,
            partial_turn_count: self.partial_turn_count,
            unreported_turn_count: self.unreported_turn_count,
        }
    }
}

fn usage_period(records: &[&AiUsageRecord]) -> AiTokenUsagePeriod {
    let mut accumulator = AiUsageAccumulator::default();
    for record in records {
        accumulator.add(record);
    }
    accumulator.finish()
}

#[cfg(test)]
fn extract_compact_usage_summary(value: &str) -> Option<AiUsageSummary> {
    const MARKER: &str = "{\"__desicUsageSummary\":";
    let start = value.rfind(MARKER)?;
    let event = value[start..].trim().strip_suffix(']')?.trim();
    let event = serde_json::from_str::<Value>(event).ok()?;
    serde_json::from_value(event.get("__desicUsageSummary")?.clone()).ok()
}

fn load_ai_token_usage_dashboard(
    conn: &mut Connection,
    now: i64,
) -> Result<AiTokenUsageDashboard, String> {
    const DAY_MS: i64 = 86_400_000;
    const SHANGHAI_OFFSET_MS: i64 = 8 * 60 * 60 * 1000;
    let today_start =
        (now.saturating_add(SHANGHAI_OFFSET_MS)).div_euclid(DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS;
    let yesterday_start = today_start.saturating_sub(DAY_MS);
    let seven_days_start = today_start.saturating_sub(6 * DAY_MS);
    ensure_ai_message_usage_since(conn, seven_days_start)?;
    let mut stmt = conn
        .prepare(
            "SELECT session_id,created_at,token_usage_json
             FROM ai_messages
             WHERE role='assistant' AND created_at>=?1
               AND token_usage_version>=?2 AND token_usage_json IS NOT NULL
             ORDER BY created_at ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![seven_days_start, AI_USAGE_SCHEMA_VERSION], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut records = Vec::new();
    for row in rows {
        let (session_id, created_at, summary_json) = row.map_err(|error| error.to_string())?;
        let Ok(summary) = serde_json::from_str::<AiUsageSummary>(&summary_json) else {
            continue;
        };
        records.push(AiUsageRecord {
            session_id,
            created_at,
            summary,
        });
    }
    let today_records = records
        .iter()
        .filter(|record| record.created_at >= today_start && record.created_at <= now)
        .collect::<Vec<_>>();
    let yesterday_records = records
        .iter()
        .filter(|record| record.created_at >= yesterday_start && record.created_at < today_start)
        .collect::<Vec<_>>();
    let seven_day_records = records.iter().collect::<Vec<_>>();

    let mut model_groups = BTreeMap::<String, Vec<&AiUsageRecord>>::new();
    for record in &records {
        let key = format!(
            "{}\u{1f}{}\u{1f}{}",
            record.summary.provider, record.summary.model_id, record.summary.model
        );
        model_groups.entry(key).or_default().push(record);
    }
    let mut by_model = model_groups
        .into_values()
        .filter_map(|items| {
            let first = items.first()?;
            let today = items
                .iter()
                .copied()
                .filter(|record| record.created_at >= today_start && record.created_at <= now)
                .collect::<Vec<_>>();
            let yesterday = items
                .iter()
                .copied()
                .filter(|record| {
                    record.created_at >= yesterday_start && record.created_at < today_start
                })
                .collect::<Vec<_>>();
            Some(AiTokenUsageByModel {
                provider: first.summary.provider.clone(),
                model_id: first.summary.model_id.clone(),
                model: first.summary.model.clone(),
                model_name: first.summary.model_name.clone(),
                today: usage_period(&today),
                yesterday: usage_period(&yesterday),
                seven_days: usage_period(&items),
            })
        })
        .collect::<Vec<_>>();
    by_model.sort_by(|left, right| {
        right
            .seven_days
            .usage
            .total_tokens
            .cmp(&left.seven_days.usage.total_tokens)
            .then_with(|| left.model_name.cmp(&right.model_name))
    });

    Ok(AiTokenUsageDashboard {
        generated_at: now,
        window_start: seven_days_start,
        today: usage_period(&today_records),
        yesterday: usage_period(&yesterday_records),
        seven_days: usage_period(&seven_day_records),
        by_model,
    })
}

#[tauri::command]
pub(crate) async fn ai_token_usage_summary(
    app: tauri::AppHandle,
) -> Result<AiTokenUsageDashboard, String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_automation_database(&app)?;
        load_ai_token_usage_dashboard(&mut conn, now_ms())
    })
    .await
    .map_err(|error| format!("读取 AI Token 统计任务失败: {error}"))?
}

#[tauri::command]
pub(crate) async fn ai_automation_run_statuses(
    app: tauri::AppHandle,
    ids: Vec<String>,
) -> Result<Vec<AiAgentRunStatus>, String> {
    let ids = ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .take(100)
        .collect::<Vec<_>>();
    tokio::task::spawn_blocking(move || {
        let conn = open_read_database(&app)?;
        load_run_statuses(&conn, &ids)
    })
    .await
    .map_err(|err| format!("读取 Run 状态任务失败: {err}"))?
}




/// Reads the bounded supplement of the Profile's selected Agent Template.
/// A missing template, an unreadable database, or empty text yields None so a
/// Run never fails or silently changes behavior because of template state.






fn reconcile_profile_model_references(
    app: &tauri::AppHandle,
    conn: &Connection,
) -> Result<(), String> {
    let config = match load_ai_config(app) {
        Ok(config) => config,
        Err(error) if crate::storage_config::is_unconfigured_ai_config_error(&error) => {
            return Ok(())
        }
        Err(error) => return Err(error),
    };
    for profile in load_profiles(conn)? {
        let selected = crate::storage_config::select_ai_model(&config, profile.model.as_deref())?;
        if profile.model.as_deref() == Some(selected.active_model_id.as_str()) {
            continue;
        }
        conn.execute(
            "UPDATE ai_agent_profiles SET model=?2,updated_at=?3 WHERE id=?1",
            params![profile.id, selected.active_model_id, now_ms()],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn ai_automation_run_detail(
    app: tauri::AppHandle,
    id: String,
) -> Result<AiAgentRunDetail, String> {
    tauri::async_runtime::spawn_blocking(move || ai_automation_run_detail_blocking(app, id))
        .await
        .map_err(|error| format!("读取 Run 详情任务失败: {error}"))?
}

fn ai_automation_run_detail_blocking(
    app: tauri::AppHandle,
    id: String,
) -> Result<AiAgentRunDetail, String> {
    let conn = open_read_database(&app)?;
    let run = load_run(&conn, &id)?;
    let (
        trigger_json,
        profile_snapshot_json,
        template_snapshot_json,
        skill_versions_json,
        initial_market_snapshot_json,
        final_decision_json,
    ) = conn
        .query_row(
            "SELECT trigger_json,profile_snapshot_json,template_snapshot_json,skill_versions_json,
                    initial_market_snapshot_json,final_decision_json
             FROM ai_agent_runs WHERE id=?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .map_err(|err| err.to_string())?;
    let session_id = format!("background:{}", run.id);
    let message = conn
        .query_row(
            "SELECT content,reasoning,tool_json FROM ai_messages
             WHERE session_id=?1 AND role='assistant' ORDER BY created_at DESC LIMIT 1",
            params![session_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let (assistant_text, reasoning, tool_json) = message
        .map(|(content, reasoning, tools)| {
            (
                non_empty_string(content),
                reasoning.and_then(non_empty_string),
                tools,
            )
        })
        .unwrap_or((None, None, None));
    Ok(AiAgentRunDetail {
        run,
        trigger: from_json_or_default(&trigger_json),
        profile_snapshot: profile_snapshot_json
            .as_deref()
            .map(from_json_or_default)
            .unwrap_or(Value::Null),
        template_snapshot: template_snapshot_json
            .as_deref()
            .map(from_json_or_default)
            .unwrap_or(Value::Null),
        skill_versions: from_json_or_default(&skill_versions_json),
        assistant_text,
        reasoning,
        tool_events: tool_json
            .as_deref()
            .map(from_json_or_default)
            .unwrap_or_default(),
        initial_market_snapshot: initial_market_snapshot_json
            .as_deref()
            .map(from_json_or_default)
            .unwrap_or(Value::Null),
        final_decision: final_decision_json
            .as_deref()
            .map(from_json_or_default)
            .unwrap_or(Value::Null),
    })
}

fn non_empty_string(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[tauri::command]
pub(crate) fn notification_settings_summary(
    app: tauri::AppHandle,
) -> Result<NotificationSettingsSummary, String> {
    let conn = open_automation_database(&app)?;
    Ok(NotificationSettingsSummary {
        feishu: load_feishu_config(&conn),
    })
}

#[tauri::command]
pub(crate) fn ai_automation_save_master_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<bool, String> {
    set_automation_master_enabled(&app, enabled)
}

pub(crate) fn set_automation_master_enabled(
    app: &tauri::AppHandle,
    enabled: bool,
) -> Result<bool, String> {
    let conn = open_automation_database(app)?;
    let sessions_to_stop = if enabled {
        Vec::new()
    } else {
        load_running_automation_sessions(&conn, None)?
    };
    if enabled && load_setting(&conn, "review_auto_start_at").is_none() {
        set_setting(&conn, "review_auto_start_at", json!(now_ms()))?;
    }
    set_setting(&conn, "master_enabled", json!(enabled))?;
    if !enabled {
        conn.execute(
            "UPDATE ai_agent_runs SET status='cancelled',error='AI 自动化总开关已关闭',finished_at=?1,updated_at=?1
             WHERE status IN ('queued','running')",
            params![now_ms()],
        )
        .map_err(|err| err.to_string())?;
        conn.execute(
            "UPDATE ai_trade_reviews SET status='cancelled',error='AI 自动化总开关已关闭',updated_at=?1
             WHERE status IN ('queued','running')",
            params![now_ms()],
        )
        .map_err(|err| err.to_string())?;
        conn.execute(
            "UPDATE ai_daily_market_reviews SET status='cancelled',error='AI 自动化总开关已关闭',updated_at=?1
             WHERE status IN ('queued','running')",
            params![now_ms()],
        )
        .map_err(|err| err.to_string())?;
    }
    let runtime = app.state::<AiAutomationRuntime>();
    runtime.notify.notify_one();
    stop_automation_sessions(app, sessions_to_stop);
    Ok(enabled)
}

#[tauri::command]
pub(crate) async fn ai_agent_profile_save(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, AiAutomationRuntime>,
    profile: AiAgentProfileInput,
    force_systematic_conflict: Option<bool>,
) -> Result<AiAgentProfileSummary, String> {
    let conn = open_automation_database(&app)?;
    ensure_skill_versions(&app, &conn)?;
    let mut profile = normalize_profile(profile)?;
    // C3：勾选名单用 Agent 库校验 —— 不存在的 id 丢弃并在返回值/日志里提示，
    // **不阻断保存**；库读不到时一个都不丢（见 `split_known_enabled_agent_ids`）。
    let (known_agent_ids, dropped_agent_ids) =
        crate::agent_library::split_known_enabled_agent_ids(&profile.enabled_agent_ids);
    if !dropped_agent_ids.is_empty() {
        crate::boot_log(&format!(
            "profile save dropped unknown agent ids: {}",
            dropped_agent_ids.join(",")
        ));
    }
    profile.enabled_agent_ids = known_agent_ids;
    let ai_config = load_ai_config(&app)?;
    let selected_model = crate::storage_config::select_ai_model(
        &ai_config,
        profile
            .model
            .as_deref()
            .or(Some(&ai_config.active_model_id)),
    )?;
    profile.model = Some(selected_model.active_model_id);
    bind_profile_account_environment(&app, &mut profile)?;
    if profile.enabled {
        if let Some(account_id) = profile.account_id.as_deref() {
            let account = load_local_account_secret(&app, Some(account_id))?;
            crate::require_okx_long_short_mode(&app, &account).await?;
        }
    }
    let systematic_conflicts = enabled_systematic_profile_conflicts(
        &conn,
        profile.account_id.as_deref(),
        &profile.environment,
        &profile.symbols,
    )?;
    if profile.enabled
        && !systematic_conflicts.is_empty()
        && !force_systematic_conflict.unwrap_or(false)
    {
        return Err(systematic_profile_conflict_message(&systematic_conflicts));
    }
    normalize_profile_skill_version_preferences(&mut profile);
    let _ = resolve_skill_versions(
        &conn,
        &profile.skill_ids,
        &profile.skill_versions,
        &profile.skill_version_modes,
    )?;
    let now = now_ms();
    let id = profile
        .id
        .clone()
        .unwrap_or_else(|| format!("profile-{}", unique_suffix()));
    let sessions_to_stop = if profile.enabled {
        Vec::new()
    } else {
        load_running_automation_sessions(&conn, Some(&id))?
    };
    let created_at = conn
        .query_row(
            "SELECT created_at FROM ai_agent_profiles WHERE id=?1",
            params![id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .unwrap_or(now);
    // 读旧写新：首次保存时把旧自定义 Agent / 旧模板条目写成库文件（幂等），
    // 并把这些提示回给前端做一次性提示（契约 C3 迁移报告）。
    let migration = persist_legacy_agent_migration(&conn, &id, now);
    apply_collaboration_default(&conn, &mut profile, &id);
    apply_single_agent_mode_default(&conn, &mut profile, &id);
    apply_typesafe_enabled_default(&conn, &mut profile, &id);
    // C14：旧行（auto/custom/scheme）保存时补上"协作开启"，避免把迁移出来的
    // 协作在首次保存时静默关掉。
    if migration.legacy_row && !profile.enabled_agent_ids.is_empty() {
        profile.collaboration_enabled = Some(true);
    }
    let migration_notes = {
        let mut notes = migration.notes;
        if !dropped_agent_ids.is_empty() {
            notes.push(format!(
                "以下 Agent 不在 Agent 库中，已从勾选名单移除：{}",
                dropped_agent_ids.join("、")
            ));
        }
        notes
    };
    upsert_profile_row(&conn, &profile, &id, created_at, now)?;
    if !profile.enabled {
        conn.execute(
            "UPDATE ai_agent_runs SET status='cancelled',error='Agent Profile 已停用',finished_at=?2,updated_at=?2
             WHERE profile_id=?1 AND status IN ('queued','running')",
            params![id, now],
        )
        .map_err(|err| err.to_string())?;
        conn.execute(
            "UPDATE ai_daily_market_reviews SET status='cancelled',error='Agent Profile 已停用',updated_at=?2
             WHERE profile_id=?1 AND status IN ('queued','running')",
            params![id, now],
        )
        .map_err(|err| err.to_string())?;
    }
    stop_automation_sessions(&app, sessions_to_stop);
    runtime.notify.notify_one();
    let mut saved = load_profile(&conn, &id)?;
    if !migration_notes.is_empty() {
        saved.migration_notes = migration_notes;
    }
    Ok(saved)
}

// 保存路径的落库单元：ai_agent_profile_save 与回归测试共用同一条 UPSERT，
// 列位置 ↔ 值位置必须逐位对齐（NULL 对应 deleted_at）。
fn upsert_profile_row(
    conn: &Connection,
    profile: &AiAgentProfileInput,
    id: &str,
    created_at: i64,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO ai_agent_profiles (
          id,name,enabled,mode,account_id,environment,symbols_json,scan_interval_minutes,
          skill_ids_json,skill_versions_json,skill_version_modes_json,model,reasoning_depth,history_lookback_days,similarity_window_minutes,
          entry_tolerance_bps,max_runtime_seconds,min_wake_interval_seconds,max_runs_per_hour,
          feishu_enabled,daily_review_enabled,allowed_wake_condition_types_json,
          multi_agent_mode,multi_agent_max_agents,multi_agents_json,multi_agent_scheme_id,
          multi_agent_orchestrator,multi_agent_expert_source,enabled_agent_ids_json,
          collaboration_enabled,triage_json,single_agent_mode,
          created_at,updated_at,deleted_at,target_leverage,max_single_trade_margin_pct,typesafe_enabled
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,NULL,?35,?36,?37)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name,enabled=excluded.enabled,mode=excluded.mode,account_id=excluded.account_id,
          environment=excluded.environment,symbols_json=excluded.symbols_json,
          scan_interval_minutes=excluded.scan_interval_minutes,skill_ids_json=excluded.skill_ids_json,
          skill_versions_json=excluded.skill_versions_json,skill_version_modes_json=excluded.skill_version_modes_json,
          model=excluded.model,reasoning_depth=excluded.reasoning_depth,
          history_lookback_days=excluded.history_lookback_days,
          similarity_window_minutes=excluded.similarity_window_minutes,
          entry_tolerance_bps=excluded.entry_tolerance_bps,max_runtime_seconds=excluded.max_runtime_seconds,
          min_wake_interval_seconds=excluded.min_wake_interval_seconds,max_runs_per_hour=excluded.max_runs_per_hour,
          feishu_enabled=excluded.feishu_enabled,
          daily_review_enabled=excluded.daily_review_enabled,
          allowed_wake_condition_types_json=excluded.allowed_wake_condition_types_json,
          multi_agent_mode=excluded.multi_agent_mode,
          multi_agent_max_agents=excluded.multi_agent_max_agents,
          multi_agents_json=excluded.multi_agents_json,
          multi_agent_scheme_id=excluded.multi_agent_scheme_id,
          multi_agent_orchestrator=excluded.multi_agent_orchestrator,
          multi_agent_expert_source=excluded.multi_agent_expert_source,
          enabled_agent_ids_json=excluded.enabled_agent_ids_json,
          collaboration_enabled=excluded.collaboration_enabled,
          triage_json=excluded.triage_json,
          single_agent_mode=excluded.single_agent_mode,
          target_leverage=excluded.target_leverage,
          max_single_trade_margin_pct=excluded.max_single_trade_margin_pct,
          typesafe_enabled=excluded.typesafe_enabled,
          updated_at=excluded.updated_at,deleted_at=NULL",
        params![
            id,
            profile.name,
            bool_to_i64(profile.enabled),
            profile.mode,
            profile.account_id,
            profile.environment,
            to_json(&profile.symbols)?,
            profile.scan_interval_minutes,
            to_json(&profile.skill_ids)?,
            to_json(&profile.skill_versions)?,
            to_json(&profile.skill_version_modes)?,
            profile.model,
            profile.reasoning_depth,
            profile.history_lookback_days,
            profile.similarity_window_minutes,
            profile.entry_tolerance_bps,
            profile.max_runtime_seconds,
            profile.min_wake_interval_seconds,
            profile.max_runs_per_hour,
            bool_to_i64(profile.feishu_enabled),
            bool_to_i64(profile.daily_review_enabled),
            to_json(&profile.allowed_wake_condition_types)?,
            // 旧列停止写入（契约 C3）：mode='off' 表示"新模型里没有主开关"，
            // orchestrator='lead' 表示"编排者只有主 Agent"，expertSource 留空。
            desic_agent_automation::MULTI_AGENT_OFF_MODE,
            0_i64,
            "[]",
            Option::<String>::None,
            "lead",
            "",
            to_json(&profile.enabled_agent_ids)?,
            bool_to_i64(profile.collaboration_enabled.unwrap_or(false)),
            to_json(&profile.triage.clone().normalized())?,
            // C24：缺省（None）时保存路径已先查库补上现值；真缺失就按 `standard`。
            profile
                .single_agent_mode
                .clone()
                .unwrap_or_else(default_single_agent_mode),
            created_at,
            now,
            profile.target_leverage,
            profile.max_single_trade_margin_pct,
            // TypeSafe / Jev：`None` 时保存路径已先查库补现值；真缺失按「关闭」。
            bool_to_i64(profile.typesafe_enabled.unwrap_or(false)),
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn ai_agent_profile_systematic_conflicts(
    app: tauri::AppHandle,
    request: AiAgentProfileSystematicConflictRequest,
) -> Result<Vec<AiAgentProfileSystematicConflict>, String> {
    let conn = open_automation_database(&app)?;
    let environment = match request
        .account_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(account_id) => {
            normalize_environment(&load_local_account_secret(&app, Some(account_id))?.environment)
        }
        None => normalize_environment(&request.environment),
    };
    enabled_systematic_profile_conflicts(
        &conn,
        request.account_id.as_deref(),
        &environment,
        &request.symbols,
    )
}

#[tauri::command]
pub(crate) fn ai_agent_profile_delete(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, AiAutomationRuntime>,
    id: String,
) -> Result<(), String> {
    let conn = open_automation_database(&app)?;
    let now = now_ms();
    let sessions_to_stop = load_running_automation_sessions(&conn, Some(&id))?;
    let changed = conn
        .execute(
            "UPDATE ai_agent_profiles SET enabled=0, deleted_at=?2, updated_at=?2 WHERE id=?1 AND deleted_at IS NULL",
            params![id, now],
        )
        .map_err(|err| err.to_string())?;
    if changed == 0 {
        return Err("Agent Profile 不存在".to_string());
    }
    conn.execute(
        "UPDATE ai_wake_conditions SET status='cancelled', updated_at=?2 WHERE profile_id=?1 AND status='active'",
        params![id, now],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "UPDATE ai_agent_runs SET status='cancelled',error='Agent Profile 已删除',finished_at=?2,updated_at=?2
         WHERE profile_id=?1 AND status IN ('queued','running')",
        params![id, now],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "UPDATE ai_daily_market_reviews SET status='cancelled',error='Agent Profile 已删除',updated_at=?2
         WHERE profile_id=?1 AND status IN ('queued','running')",
        params![id, now],
    )
    .map_err(|err| err.to_string())?;
    runtime.notify.notify_one();
    stop_automation_sessions(&app, sessions_to_stop);
    Ok(())
}

fn load_running_automation_sessions(
    conn: &Connection,
    profile_id: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut sessions = Vec::new();
    if let Some(profile_id) = profile_id {
        let mut stmt = conn
            .prepare("SELECT id FROM ai_agent_runs WHERE profile_id=?1 AND status='running'")
            .map_err(|err| err.to_string())?;
        sessions.extend(
            stmt.query_map(params![profile_id], |row| row.get::<_, String>(0))
                .map_err(|err| err.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?
                .into_iter()
                .map(|id| format!("background:{id}")),
        );
    } else {
        let mut run_stmt = conn
            .prepare("SELECT id FROM ai_agent_runs WHERE status='running'")
            .map_err(|err| err.to_string())?;
        sessions.extend(
            run_stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|err| err.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?
                .into_iter()
                .map(|id| format!("background:{id}")),
        );
        let mut review_stmt = conn
            .prepare("SELECT id FROM ai_trade_reviews WHERE status='running'")
            .map_err(|err| err.to_string())?;
        sessions.extend(
            review_stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|err| err.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?
                .into_iter()
                .map(|id| format!("review:{id}")),
        );
    }
    Ok(sessions)
}

fn stop_automation_sessions(app: &tauri::AppHandle, session_ids: Vec<String>) {
    if session_ids.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let runtime = app.state::<AiRuntime>().inner().clone();
        for session_id in session_ids {
            mark_ai_session_cancelled(&runtime, &session_id);
            let _ = send_ai_sidecar_command(
                &app,
                &runtime,
                json!({
                    "type": "stop",
                    "sessionId": session_id,
                    "requestId": format!("automation-stop-{}", unique_suffix())
                }),
            )
            .await;
        }
    });
}

/// C19 run 级试判记录的 JSON 形状（字段名与 UI 约定逐字对齐，见 C19.4）。
#[allow(clippy::too_many_arguments)]
fn triage_record_value(
    config: &crate::ai_triage::AiAgentTriageConfig,
    escalate: bool,
    decision: &crate::ai_triage::TriageDecision,
    reasons: &[String],
    evidence: &[crate::ai_triage::AiTriageEvidence],
    unavailable: &[String],
    inputs: &crate::ai_triage::TriageEscalationInputs,
    skip_streak: u32,
    triage_usage: &Value,
    now: i64,
) -> Value {
    json!({
        "mode": config.mode,
        // UI 读取的字段集合（C19.4）：mode / verdict / phase / reasons / evidence / forcedBy /
        // forced / sampled / triageTokens / deepTokens / triageUsage / deepUsage。
        //
        // C25-5：`verdict` 是**字符串** `"escalate" | "skip"`（与 `types.ts` 的
        // `AiRunTriageVerdict` 以及 UI 的 `triage.verdict === "skip" / "escalate"` 一致）；
        // 布尔形式同时以 `escalate` 字段保留（形状稳定、老消费者不炸）。
        "verdict": if escalate { "escalate" } else { "skip" },
        "escalate": escalate,
        "forced": !decision.forced_by.is_empty(),
        "forcedBy": decision.forced_by,
        "sampled": decision.sampled,
        "skipped": decision.skipped,
        "reasons": reasons,
        "evidence": evidence,
        "triageUsage": triage_usage,
        "triageTokens": triage_usage
            .get("totalTokens")
            .or_else(|| triage_usage.get("usage").and_then(|usage| usage.get("totalTokens")))
            .and_then(Value::as_i64)
            .unwrap_or(0),
        // 后端诊断用（UI 可忽略；形状宽容）。
        "effectiveEscalate": decision.phase != crate::ai_triage::TriagePhase::Skipped,
        "phase": decision.phase.as_str(),
        "unavailable": unavailable,
        "checked": {
            "positionOrOrderChanged": inputs.position_or_order_changed,
            "minStopDistancePct": inputs.min_stop_distance_pct,
            "marginRatios": inputs.margin_ratios,
            "minMarginRatioPct": inputs.margin_ratios.iter().copied().reduce(f64::min),
            "maxMarginRatioPct": inputs.margin_ratios.iter().copied().reduce(f64::max),
            "marginRatioConvention": config.escalate.margin_ratio_convention,
            "confirmedBreakOfFlaggedLevel": inputs.confirmed_break_of_flagged_level,
            "conditionResonance": inputs.condition_resonance,
            "importantNews": inputs.important_news,
        },
        "skipStreak": skip_streak,
        "maxSkips": config.max_skips,
        "maxSilenceMinutes": config.max_silence_minutes,
        "skipSampleRate": config.skip_sample_rate,
        "reportedAt": now,
    })
}

/// `background.reportTriage`（C19.2）：记录试判结论、执行硬升级/反饥饿/抽样裁定并记账。
pub(crate) fn background_report_triage(
    app: tauri::AppHandle,
    context: &BackgroundRunContext,
    input: BackgroundReportTriageInput,
) -> Result<Value, String> {
    let run_id = context
        .run_id
        .as_deref()
        .ok_or_else(|| "background.reportTriage 缺少 agentRunId".to_string())?;
    let profile_id = context
        .profile_id
        .as_deref()
        .ok_or_else(|| "background.reportTriage 只能用于后台 Profile Run".to_string())?;
    let reasons = input
        .reasons
        .iter()
        .map(|reason| reason.trim().to_string())
        .filter(|reason| !reason.is_empty())
        .collect::<Vec<_>>();
    let evidence = input
        .evidence
        .iter()
        .map(|item| crate::ai_triage::AiTriageEvidence {
            fact: item.fact.trim().to_string(),
            source: item.source.trim().to_string(),
            at: item.at.trim().to_string(),
        })
        .filter(|item| !item.fact.is_empty())
        .collect::<Vec<_>>();
    if let Some(plan) = input.next_wake_plan.as_ref() {
        if !matches!(plan.mode.as_str(), "any" | "all") {
            return Err("nextWakePlan.mode 必须是 any 或 all".to_string());
        }
        validate_wake_expiry(plan.expires_at, now_ms())?;
    }
    // skip 必须带 nextWakePlan（C19.2：不允许因为跳过而失去后续唤醒）。
    validate_triage_report_input(input.escalate, input.next_wake_plan.is_some())?;

    let conn = open_automation_database(&app)?;
    let now = now_ms();
    let (config, skip_streak, last_deep_at) = {
        let state = context
            .triage
            .lock()
            .map_err(|error| error.to_string())?;
        if state.config.is_off() {
            return Err("当前 Profile 未启用试判（triage.mode=off）".to_string());
        }
        if state.verdict.is_some() {
            return Err("本次运行已提交过试判结论".to_string());
        }
        (
            state.config.clone(),
            state.skip_streak,
            state.last_deep_at,
        )
    };
    let (escalation_inputs, unavailable) = collect_triage_escalation_inputs(
        &app,
        &conn,
        context,
        &context.trigger,
        last_deep_at,
    );
    let minutes_since_deep = last_deep_at
        .map(|at| now.saturating_sub(at) / 60_000)
        .or_else(|| Some(now.saturating_sub(0) / 60_000).filter(|_| false));
    let forced_by = crate::ai_triage::evaluate_triage_escalation(
        &config,
        &escalation_inputs,
        skip_streak,
        minutes_since_deep,
    );
    let sampled = {
        let state = context.triage.lock().map_err(|error| error.to_string())?;
        crate::ai_triage::sampling_hit(config.skip_sample_rate, state.sample_unit)
    };
    let decision =
        crate::ai_triage::decide_triage_outcome(&config, input.escalate, forced_by.clone(), sampled);

    // 试判阶段的 token 快照：从会话事件里的 usage 汇总取（**不要**读可能尚未写回的列，
    // 那正是 0/0/0 的根因）。
    let triage_usage = load_run_metadata(&conn, run_id)
        .ok()
        .and_then(|metadata| metadata.token_usage)
        .and_then(|usage| serde_json::to_value(usage).ok());

    {
        let mut state = context
            .triage
            .lock()
            .map_err(|error| error.to_string())?;
        state.verdict = Some(decision.phase != crate::ai_triage::TriagePhase::Skipped);
        state.reasons = reasons.clone();
        state.evidence = evidence.clone();
        state.forced_by = decision.forced_by.clone();
        state.sampled = decision.sampled;
        state.skipped = decision.skipped;
        state.next_wake_plan = input
            .next_wake_plan
            .as_ref()
            .and_then(|plan| serde_json::to_value(plan).ok());
        state.triage_usage = triage_usage.clone();
    }
    let record = triage_record_value(
        &config,
        input.escalate,
        &decision,
        &reasons,
        &evidence,
        &unavailable,
        &escalation_inputs,
        skip_streak,
        triage_usage.as_ref().unwrap_or(&Value::Null),
        now,
    );
    conn.execute(
        "UPDATE ai_agent_runs SET triage_json=?2,updated_at=?3 WHERE id=?1",
        params![run_id, record.to_string(), now],
    )
    .map_err(|error| error.to_string())?;
    if decision.skipped {
        // 记此刻就 +1：即使之后进程崩溃，反饥饿计数也不会丢。
        conn.execute(
            "UPDATE ai_agent_profiles SET triage_skip_streak=?2,updated_at=?3 WHERE id=?1",
            params![profile_id, i64::from(skip_streak) + 1, now],
        )
        .map_err(|error| error.to_string())?;
    }
    crate::boot_log(&format!(
        "triage verdict run={run_id} mode={} verdict={} skipped={} sampled={} forced={:?}",
        config.mode, input.escalate, decision.skipped, decision.sampled, decision.forced_by
    ));
    Ok(json!({
        "ok": true,
        "mode": config.mode,
        "verdict": input.escalate,
        "skipped": decision.skipped,
        "sampled": decision.sampled,
        "forcedBy": decision.forced_by,
        "unavailable": record["unavailable"],
        "phase": decision.phase.as_str(),
        "message": if decision.skipped {
            "试判判定跳过：本次运行只允许调用 background.finishRun 收尾（nextWakePlan 已记录）"
        } else if !decision.forced_by.is_empty() {
            "硬升级命中：escalate=false 被否决，已强制进入深度阶段"
        } else if decision.sampled {
            "抽样复检命中：本次仍执行深度分析"
        } else {
            "试判已放行深度阶段"
        },
    }))
}

#[tauri::command]
pub(crate) fn ai_agent_profile_run_now(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, AiAutomationRuntime>,
    id: String,
) -> Result<AiAgentRunSummary, String> {
    let conn = open_automation_database(&app)?;
    if !automation_master_enabled_with_conn(&conn) {
        return Err("AI 自动化总开关未开启".to_string());
    }
    let profile = load_profile(&conn, &id)?;
    if !profile.enabled {
        return Err("Agent Profile 未启用".to_string());
    }
    let run = queue_run(
        &conn,
        &profile.id,
        "manual",
        json!({ "requestedBy": "user" }),
    )?;
    runtime.notify.notify_one();
    Ok(run)
}

#[tauri::command]
pub(crate) fn ai_agent_profile_run_daily_review(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, AiAutomationRuntime>,
    id: String,
) -> Result<AiDailyMarketReviewSummary, String> {
    let conn = open_automation_database(&app)?;
    if !automation_master_enabled_with_conn(&conn) {
        return Err("AI 自动化总开关未开启".to_string());
    }
    let profile = load_profile(&conn, &id)?;
    if !profile.enabled {
        return Err("Agent Profile 未启用".to_string());
    }
    let review_date = previous_utc_date();
    let review = queue_daily_market_review(&conn, &profile, &review_date, "manual")?;
    runtime.notify.notify_one();
    Ok(review)
}

#[tauri::command]
pub(crate) fn ai_user_wake_condition_save(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, AiAutomationRuntime>,
    profile_id: String,
    condition_id: Option<String>,
    plan_mode: String,
    mut condition: Value,
    expires_at: Option<i64>,
) -> Result<AiWakeConditionSummary, String> {
    let conn = open_automation_database(&app)?;
    let profile = load_profile(&conn, &profile_id)?;
    let plan_mode = plan_mode.trim();
    if !matches!(plan_mode, "any" | "all") {
        return Err("唤醒条件 planMode 必须是 any 或 all".to_string());
    }
    normalize_wake_scope(
        &conn,
        profile.account_id.as_deref(),
        Some(&profile.environment),
        &profile.symbols,
        &mut condition,
    )?;
    let condition_type = condition
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "唤醒条件缺少 type".to_string())?
        .to_string();
    if !profile
        .allowed_wake_condition_types
        .iter()
        .any(|item| item == &condition_type)
    {
        return Err(format!("Profile 不允许使用唤醒条件：{}", condition_type));
    }
    let parsed = serde_json::from_value::<WakeCondition>(condition.clone())
        .map_err(|err| format!("唤醒条件 {} 参数无效：{}", condition_type, err))?;
    let now = now_ms();
    validate_wake_condition_limits(&parsed, now)?;
    validate_wake_expiry(expires_at, now)?;
    let id = condition_id
        .and_then(|value| {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        })
        .unwrap_or_else(|| format!("wake-user-{}", unique_suffix()));
    let active_count = conn
        .query_row(
            "SELECT COUNT(*) FROM ai_wake_conditions WHERE profile_id=?1 AND source='user' AND status='active' AND id<>?2",
            params![profile_id, id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| err.to_string())?;
    if active_count >= 32 {
        return Err("每个 Profile 最多配置 32 条用户唤醒条件".to_string());
    }
    let changed = conn
        .execute(
            "INSERT INTO ai_wake_conditions(
              id,profile_id,source,plan_mode,condition_type,config_json,status,expires_at,created_at,updated_at
             ) VALUES(?1,?2,'user',?3,?4,?5,'active',?6,?7,?7)
             ON CONFLICT(id) DO UPDATE SET
               plan_mode=excluded.plan_mode,condition_type=excluded.condition_type,
               config_json=excluded.config_json,status='active',expires_at=excluded.expires_at,
               last_triggered_at=NULL,updated_at=excluded.updated_at
             WHERE ai_wake_conditions.profile_id=excluded.profile_id AND ai_wake_conditions.source='user'",
            params![id, profile_id, plan_mode, condition_type, condition.to_string(), expires_at, now],
        )
        .map_err(|err| err.to_string())?;
    if changed == 0 {
        return Err("只能修改当前 Profile 的用户唤醒条件".to_string());
    }
    runtime.notify.notify_one();
    load_wake_condition(&conn, &id)
}

#[tauri::command]
pub(crate) fn ai_user_wake_condition_delete(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, AiAutomationRuntime>,
    id: String,
) -> Result<(), String> {
    let conn = open_automation_database(&app)?;
    let changed = conn
        .execute(
            "UPDATE ai_wake_conditions SET status='cancelled',updated_at=?2
             WHERE id=?1 AND source='user' AND status!='cancelled'",
            params![id, now_ms()],
        )
        .map_err(|err| err.to_string())?;
    if changed == 0 {
        return Err("用户唤醒条件不存在或已删除".to_string());
    }
    runtime.notify.notify_one();
    Ok(())
}

#[tauri::command]
pub(crate) fn notification_feishu_config_save(
    app: tauri::AppHandle,
    config: FeishuConfigInput,
) -> Result<FeishuConfigSummary, String> {
    let conn = open_automation_database(&app)?;
    if let Some(webhook) = config.webhook_url.as_deref() {
        let webhook = webhook.trim();
        if !webhook.is_empty() && !webhook.contains("****") {
            validate_feishu_webhook(webhook)?;
            save_notification_webhook(webhook)?;
        }
    }
    let event_types = normalize_strings(config.event_types);
    for event_type in &event_types {
        if !matches!(
            event_type.as_str(),
            "agent_message"
                | "run_completed"
                | "run_failed"
                | "review_completed"
                | "daily_review_completed"
                | "suggestion_created"
                | "strategy_signal"
        ) {
            return Err(format!("暂不支持飞书事件类型：{}", event_type));
        }
    }
    set_setting(
        &conn,
        "feishu_config",
        json!({
            "enabled": config.enabled,
            "eventTypes": event_types,
            "eventTypesVersion": FEISHU_CONFIG_EVENT_TYPES_VERSION
        }),
    )?;
    Ok(load_feishu_config(&conn))
}

#[tauri::command]
pub(crate) async fn notification_feishu_test(
    app: tauri::AppHandle,
) -> Result<AiNotificationDeliverySummary, String> {
    send_feishu_delivery(
        app,
        FeishuSendInput {
            title: "Desic Terminal Markdown 卡片测试".to_string(),
            content: concat!(
                "## Markdown 消息卡片已启用\n\n",
                "**加粗文本**、`行内代码` 与列表应正确渲染：\n\n",
                "- 飞书 Webhook 连接正常\n",
                "- Desic Terminal 已改用卡片 JSON 2.0\n\n",
                "> 后续 Agent 分析正文会保留 Markdown 排版。"
            )
            .to_string(),
            level: "info".to_string(),
            related_type: Some("configuration".to_string()),
            related_id: None,
            agent_profile_id: None,
            agent_run_id: None,
        },
        false,
        None,
    )
    .await
}

#[tauri::command]
pub(crate) fn ai_optimization_suggestion_update(
    app: tauri::AppHandle,
    id: String,
    status: String,
) -> Result<AiOptimizationSuggestionSummary, String> {
    let status = normalize_suggestion_status(&status)?;
    if status == "applied" {
        return apply_optimization_suggestion(&app, &id);
    }
    let conn = open_automation_database(&app)?;
    let now = now_ms();
    let changed = conn
        .execute(
            "UPDATE ai_optimization_suggestions SET status=?2, updated_at=?3 WHERE id=?1",
            params![id, status, now],
        )
        .map_err(|err| err.to_string())?;
    if changed == 0 {
        return Err("优化建议不存在".to_string());
    }
    load_optimization_suggestion(&conn, &id)
}

fn apply_optimization_suggestion(
    app: &tauri::AppHandle,
    suggestion_id: &str,
) -> Result<AiOptimizationSuggestionSummary, String> {
    let _config_write_guard = crate::storage_config::lock_ai_config_writes()?;
    let mut conn = open_automation_database(app)?;
    ensure_skill_versions(app, &conn)?;
    let suggestion = load_optimization_suggestion(&conn, suggestion_id)?;
    if suggestion.status == "applied" {
        return Ok(suggestion);
    }
    if suggestion.status == "rejected" {
        return Err("已拒绝的优化建议不能采用".to_string());
    }
    let skill_id = suggestion
        .current_skill_id
        .as_deref()
        .ok_or_else(|| "该旧优化建议没有绑定 Skill，不能直接采用".to_string())?;
    let base_version = suggestion
        .current_skill_version
        .ok_or_else(|| "该旧优化建议没有固定基线版本，不能直接采用".to_string())?;
    let review_id = suggestion
        .review_id
        .as_deref()
        .ok_or_else(|| "优化建议没有关联复盘记录，不能直接采用".to_string())?;
    let episode_id = conn
        .query_row(
            "SELECT episode_id FROM ai_trade_reviews WHERE id=?1",
            params![review_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|err| format!("找不到优化建议关联的复盘记录：{}", err))?;
    let _ = load_review_skill_definition(&conn, &episode_id, skill_id, base_version)?;
    let proposed_value = suggestion
        .proposed_skill
        .clone()
        .ok_or_else(|| "该旧优化建议没有完整候选 Skill，只能拒绝或重新复盘".to_string())?;
    let mut proposed =
        serde_json::from_value::<desic_storage_config::AiSkillDefinition>(proposed_value)
            .map_err(|err| format!("候选 Skill 结构无效：{}", err))?;
    let base_content = conn
        .query_row(
            "SELECT content FROM ai_skill_versions
             WHERE skill_id=?1 AND version=?2 AND status='published'",
            params![skill_id, i64::from(base_version)],
            |row| row.get::<_, String>(0),
        )
        .map_err(|err| format!("找不到建议引用的 Skill 基线：{}", err))?;
    let base = serde_json::from_str::<desic_storage_config::AiSkillDefinition>(&base_content)
        .map_err(|err| format!("Skill 基线结构无效：{}", err))?;
    if proposed.id != skill_id || proposed.builtin != base.builtin {
        return Err("候选 Skill 的 id 或内置属性与基线不一致".to_string());
    }
    if proposed.name.trim().is_empty() || proposed.content.trim().is_empty() {
        return Err("候选 Skill 的名称和正文不能为空".to_string());
    }
    if !skill_draft_can_be_published(&proposed) {
        return Err("该固定内置 Skill 不能通过优化建议覆盖".to_string());
    }
    let latest_published_version = conn
        .query_row(
            "SELECT MAX(version) FROM ai_skill_versions
             WHERE skill_id=?1 AND status='published'",
            params![skill_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .map_err(|err| err.to_string())?
        .unwrap_or_default();
    if latest_published_version != i64::from(base_version) {
        return Err(format!(
            "Skill {} 已从 v{} 更新到 v{}，为避免覆盖后续修改，本建议不能直接采用",
            skill_id, base_version, latest_published_version
        ));
    }
    let source_version_exists = conn
        .query_row(
            "SELECT COUNT(*) FROM ai_skill_versions WHERE source_suggestion_id=?1",
            params![suggestion_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| err.to_string())?;
    if source_version_exists > 0 {
        return Err("该建议已关联旧流程 Skill 草稿，请先在 Skills 中处理该草稿".to_string());
    }
    let next_version = conn
        .query_row(
            "SELECT COALESCE(MAX(version),0)+1 FROM ai_skill_versions WHERE skill_id=?1",
            params![skill_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| err.to_string())?;
    let mut config = crate::storage_config::load_ai_config_locked(app)?;
    proposed =
        crate::storage_config::prepare_ai_skill_bundle_definitions(vec![proposed], Some(&config))?
            .into_iter()
            .next()
            .ok_or_else(|| "候选 Skill 为空".to_string())?;
    let proposed_content = serde_json::to_string(&proposed).map_err(|err| err.to_string())?;
    if proposed_content == base_content {
        return Err("候选 Skill 与当前基线完全相同".to_string());
    }
    let original_config = config.clone();
    let restore_original_config = || -> Result<(), String> {
        crate::storage_config::save_ai_config(app, &original_config)?;
        crate::storage_config::sync_cline_skill_files_from_config(&original_config)
    };
    if let Some(existing) = config
        .skill_definitions
        .iter_mut()
        .find(|item| item.id == proposed.id)
    {
        *existing = proposed.clone();
    } else {
        config.skill_definitions.push(proposed.clone());
    }
    if !config
        .enabled_skills
        .iter()
        .any(|item| item == &proposed.id)
    {
        config.enabled_skills.push(proposed.id.clone());
    }
    crate::storage_config::revoke_runtime_trust_for_changed_bundles(
        Some(&original_config),
        &config.skill_definitions,
        &mut config.skill_runtime_trust,
    );
    crate::storage_config::save_ai_config(app, &config)?;
    if let Err(sync_error) = crate::storage_config::sync_cline_skill_files_from_config(&config) {
        let rollback_error = restore_original_config().err();
        return Err(match rollback_error {
            Some(rollback_error) => format!(
                "候选 Skill 文件同步失败：{}；恢复原配置也失败：{}",
                sync_error, rollback_error
            ),
            None => format!("候选 Skill 文件同步失败：{}；已恢复原配置", sync_error),
        });
    }

    let tx = match conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate) {
        Ok(tx) => tx,
        Err(error) => {
            let rollback_error = restore_original_config().err();
            return Err(match rollback_error {
                Some(rollback_error) => format!(
                    "采用建议事务启动失败：{}；恢复原配置也失败：{}",
                    error, rollback_error
                ),
                None => format!("采用建议事务启动失败：{}；已恢复原配置", error),
            });
        }
    };
    let now = now_ms();
    let persist_result = (|| -> Result<(), String> {
        tx.execute(
            "INSERT INTO ai_skill_versions(
               id,skill_id,version,status,content,source_suggestion_id,created_at,published_at
             ) VALUES(?1,?2,?3,'published',?4,?5,?6,?6)",
            params![
                format!("skill-version-{}", unique_suffix()),
                skill_id,
                next_version,
                proposed_content,
                suggestion_id,
                now,
            ],
        )
        .map_err(|err| err.to_string())?;
        let changed = tx
            .execute(
                "UPDATE ai_optimization_suggestions SET status='applied',updated_at=?2
                 WHERE id=?1 AND status<>'rejected' AND status<>'applied'",
                params![suggestion_id, now],
            )
            .map_err(|err| err.to_string())?;
        if changed != 1 {
            return Err("优化建议状态已变化，请刷新后重试".to_string());
        }
        tx.commit().map_err(|err| err.to_string())
    })();
    if let Err(error) = persist_result {
        let rollback_error = restore_original_config().err();
        return Err(match rollback_error {
            Some(rollback_error) => format!(
                "采用建议写入失败：{}；恢复原配置也失败：{}",
                error, rollback_error
            ),
            None => format!("采用建议写入失败：{}；已恢复原配置", error),
        });
    }
    load_optimization_suggestion(&conn, suggestion_id)
}

#[tauri::command]
pub(crate) fn ai_skill_version_publish(
    app: tauri::AppHandle,
    id: String,
) -> Result<AiSkillVersionSummary, String> {
    let _config_write_guard = crate::storage_config::lock_ai_config_writes()?;
    let mut conn = open_automation_database(&app)?;
    let version = load_skill_version(&conn, &id)?;
    if version.status != "draft" {
        return Err("只有 draft 状态的 Skill 版本可以发布".to_string());
    }
    let latest_published_version = conn
        .query_row(
            "SELECT MAX(version) FROM ai_skill_versions
             WHERE skill_id=?1 AND status='published'",
            params![&version.skill_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .map_err(|err| err.to_string())?;
    if latest_published_version.is_some_and(|published| published >= i64::from(version.version)) {
        return Err("该 Skill 草稿早于当前已发布版本，请基于最新版重新生成草稿".to_string());
    }
    let mut definition = serde_json::from_value::<desic_storage_config::AiSkillDefinition>(
        version.definition.clone(),
    )
    .map_err(|err| format!("Skill 草稿结构无效：{}", err))?;
    if definition.id != version.skill_id || definition.content.trim().is_empty() {
        return Err("Skill 草稿的 id 不匹配或正文为空".to_string());
    }
    if !skill_draft_can_be_published(&definition) {
        return Err("该固定内置 Skill 不能通过优化建议草稿覆盖".to_string());
    }
    let mut config = crate::storage_config::load_ai_config_locked(&app)?;
    definition = crate::storage_config::prepare_ai_skill_bundle_definitions(
        vec![definition],
        Some(&config),
    )?
    .into_iter()
    .next()
    .ok_or_else(|| "Skill 草稿为空".to_string())?;
    let definition_content = serde_json::to_string(&definition).map_err(|err| err.to_string())?;
    let original_config = config.clone();
    let restore_original_config = || -> Result<(), String> {
        crate::storage_config::save_ai_config(&app, &original_config)?;
        crate::storage_config::sync_cline_skill_files_from_config(&original_config)
    };
    if let Some(existing) = config
        .skill_definitions
        .iter_mut()
        .find(|item| item.id == definition.id)
    {
        *existing = definition.clone();
    } else {
        config.skill_definitions.push(definition.clone());
    }
    if !config
        .enabled_skills
        .iter()
        .any(|skill_id| skill_id == &definition.id)
    {
        config.enabled_skills.push(definition.id.clone());
    }
    crate::storage_config::revoke_runtime_trust_for_changed_bundles(
        Some(&original_config),
        &config.skill_definitions,
        &mut config.skill_runtime_trust,
    );
    crate::storage_config::save_ai_config(&app, &config)?;
    if let Err(sync_error) = crate::storage_config::sync_cline_skill_files_from_config(&config) {
        let rollback_error = restore_original_config().err();
        return Err(match rollback_error {
            Some(rollback_error) => format!(
                "Skill 文件同步失败：{}；恢复原配置也失败：{}",
                sync_error, rollback_error
            ),
            None => format!("Skill 文件同步失败：{}；已恢复原配置", sync_error),
        });
    }
    let tx = match conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate) {
        Ok(tx) => tx,
        Err(database_error) => {
            let rollback_error = restore_original_config().err();
            return Err(match rollback_error {
                Some(rollback_error) => format!(
                    "Skill 发布事务启动失败：{}；恢复原配置也失败：{}",
                    database_error, rollback_error
                ),
                None => format!("Skill 发布事务启动失败：{}；已恢复原配置", database_error),
            });
        }
    };
    let now = now_ms();
    let changed = match tx.execute(
        "UPDATE ai_skill_versions SET content=?2,status='published',published_at=?3
         WHERE id=?1 AND status='draft'
           AND NOT EXISTS (
             SELECT 1 FROM ai_skill_versions
             WHERE skill_id=?4 AND status='published' AND version>=?5
           )",
        params![
            id,
            definition_content,
            now,
            &version.skill_id,
            i64::from(version.version)
        ],
    ) {
        Ok(changed) => changed,
        Err(database_error) => {
            let rollback_error = restore_original_config().err();
            return Err(match rollback_error {
                Some(rollback_error) => format!(
                    "Skill 发布状态写入失败：{}；恢复原配置也失败：{}",
                    database_error, rollback_error
                ),
                None => format!("Skill 发布状态写入失败：{}；已恢复原配置", database_error),
            });
        }
    };
    if changed != 1 {
        let rollback_error = restore_original_config().err();
        return Err(match rollback_error {
            Some(rollback_error) => format!(
                "Skill 草稿状态已变化，请刷新后重试；恢复原配置也失败：{}",
                rollback_error
            ),
            None => "Skill 草稿状态已变化，请刷新后重试；已恢复原配置".to_string(),
        });
    }
    if let Err(database_error) = tx.commit() {
        let rollback_error = restore_original_config().err();
        return Err(match rollback_error {
            Some(rollback_error) => format!(
                "Skill 发布事务提交失败：{}；恢复原配置也失败：{}",
                database_error, rollback_error
            ),
            None => format!("Skill 发布事务提交失败：{}；已恢复原配置", database_error),
        });
    }
    let mut published_version = version;
    published_version.status = "published".to_string();
    published_version.definition =
        serde_json::to_value(&definition).map_err(|err| err.to_string())?;
    published_version.published_at = Some(now);
    Ok(published_version)
}

fn skill_draft_can_be_published(definition: &desic_storage_config::AiSkillDefinition) -> bool {
    definition.id != "desic-core-operations"
        && (!definition.builtin || definition.id == "trading-philosophy")
}

#[tauri::command]
pub(crate) fn ai_skill_version_discard(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let _config_write_guard = crate::storage_config::lock_ai_config_writes()?;
    let conn = open_automation_database(&app)?;
    let changed = conn
        .execute(
            "DELETE FROM ai_skill_versions WHERE id=?1 AND status='draft'",
            params![id],
        )
        .map_err(|err| err.to_string())?;
    if changed != 1 {
        return Err("Skill 草稿不存在或已经发布".to_string());
    }
    Ok(())
}

fn open_automation_database(app: &tauri::AppHandle) -> Result<Connection, String> {
    open_database(app)
}

pub(crate) fn notify_automation_run_record_persisted(app: &tauri::AppHandle, run_id: &str) {
    let _ = app.emit(
        AUTOMATION_EVENT,
        json!({
            "type": "runRecordUpdated",
            "message": "AI 运行记录已持久化",
            "action": { "tab": "runs", "id": run_id }
        }),
    );
}

pub(crate) fn automation_master_enabled_with_conn(conn: &Connection) -> bool {
    load_setting(conn, "master_enabled")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn load_setting(conn: &Connection, key: &str) -> Option<Value> {
    conn.query_row(
        "SELECT value_json FROM ai_automation_settings WHERE key=?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .and_then(|value| serde_json::from_str(&value).ok())
}

fn set_setting(conn: &Connection, key: &str, value: Value) -> Result<(), String> {
    conn.execute(
        "INSERT INTO ai_automation_settings(key,value_json,updated_at) VALUES(?1,?2,?3)
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
        params![key, value.to_string(), now_ms()],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

// ===== Agent 库落盘 / 旧配置迁移（C1 安装清单指纹 + C3 读旧写新 + C14 协作开关）=====

/// 内置 Agent 文件的安装清单指纹（C1 升级路径）：只记录"我们确实写下的内容"，
/// 未知文件的指纹**不猜测**（用户改动永不被覆盖）。
const BUILTIN_AGENT_FINGERPRINT_SETTING: &str = "builtin_agent_files_fingerprint";
/// 旧模板（`ai_agent_schemes`）成员扫库标记：记录已处理过的 scheme id，保证幂等。
const LEGACY_SCHEME_SWEEP_SETTING: &str = "legacy_scheme_agent_sweep";

pub(crate) fn load_builtin_agent_fingerprint_manifest(
    conn: &Connection,
) -> Result<HashMap<String, String>, String> {
    Ok(
        load_setting(conn, BUILTIN_AGENT_FINGERPRINT_SETTING)
            .and_then(|value| serde_json::from_value::<HashMap<String, String>>(value).ok())
            .unwrap_or_default(),
    )
}

fn save_builtin_agent_fingerprint_manifest(
    conn: &Connection,
    manifest: &HashMap<String, String>,
) -> Result<(), String> {
    set_setting(conn, BUILTIN_AGENT_FINGERPRINT_SETTING, json!(manifest))
}

#[cfg(test)]
pub(crate) fn save_builtin_agent_fingerprint_manifest_for_test(
    conn: &Connection,
    manifest: &HashMap<String, String>,
) -> Result<(), String> {
    save_builtin_agent_fingerprint_manifest(conn, manifest)
}

/// 内置 Agent 包安装/升级（C1 三态 + 清单指纹）。失败只记日志，不影响列表与保存。
pub(crate) fn sync_builtin_agent_bundles(app: &tauri::AppHandle) {
    let Ok(conn) = open_automation_database(app) else {
        return;
    };
    let manifest = load_builtin_agent_fingerprint_manifest(&conn).unwrap_or_default();
    match crate::storage_config::install_builtin_agent_bundles_with_manifest(
        &crate::storage_config::agent_library_dir(),
        Some(&manifest),
    ) {
        Ok(result) => {
            if result.manifest_missing {
                crate::boot_log(
                    "builtin agent fingerprint manifest missing; unmanaged files kept as-is",
                );
            }
            if let Some(next) = result.manifest.as_ref() {
                if let Err(error) = save_builtin_agent_fingerprint_manifest(&conn, next) {
                    crate::boot_log(&format!("builtin agent manifest persist failed: {error}"));
                }
            }
            if result.written + result.upgraded > 0 {
                crate::boot_log(&format!(
                    "agents: builtin bundles written={} upgraded={} kept={}",
                    result.written, result.upgraded, result.kept
                ));
            }
        }
        Err(error) => crate::boot_log(&format!("builtin agent bundles install failed: {error}")),
    }
}

/// Profile 行里的"Agent 库绑定"（C3：`enabledByProfiles` / 缺账户提示的唯一来源）。
pub(crate) struct AgentLibraryProfileBinding {
    pub profile_id: String,
    pub enabled_agent_ids: Vec<String>,
    pub has_account: bool,
}

/// 读取全部未删除 Profile 的绑定（含内存迁移后的勾选名单）。
pub(crate) fn agent_library_profile_bindings(
    app: &tauri::AppHandle,
) -> Result<Vec<AgentLibraryProfileBinding>, String> {
    let conn = open_automation_database(app)?;
    Ok(load_profiles(&conn)?
        .into_iter()
        .map(|profile| AgentLibraryProfileBinding {
            profile_id: profile.id,
            enabled_agent_ids: profile.enabled_agent_ids,
            has_account: profile.account_id.is_some(),
        })
        .collect())
}

/// C3：删除 Agent 后从**所有** Profile 的勾选名单里剔除（返回被改动的 profile id）。
pub(crate) fn strip_agent_from_all_profiles(
    app: &tauri::AppHandle,
    agent_id: &str,
) -> Result<Vec<String>, String> {
    let conn = open_automation_database(app)?;
    let now = now_ms();
    let mut updated = Vec::new();
    for profile in load_profiles(&conn)? {
        let (next, changed) =
            desic_agent_automation::remove_enabled_agent_id(&profile.enabled_agent_ids, agent_id);
        if !changed {
            continue;
        }
        conn.execute(
            "UPDATE ai_agent_profiles SET enabled_agent_ids_json=?2,updated_at=?3 WHERE id=?1",
            params![profile.id, to_json(&next)?, now],
        )
        .map_err(|err| err.to_string())?;
        updated.push(profile.id);
    }
    Ok(updated)
}

/// 迁移日志去重槽位：同一个来源（`profile:<id>` / `snapshot:<runId>`）只记一行日志。
/// 迁移发生在**每次读取**路径上，不去重会把日志刷爆（并掩盖别的信息）。
fn migration_log_slot(key: &str) -> bool {
    static MIGRATION_LOG_SLOTS: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let Ok(mut slots) = MIGRATION_LOG_SLOTS.lock() else {
        return false;
    };
    if slots.iter().any(|existing| existing == key) {
        return false;
    }
    slots.push(key.to_string());
    true
}

/// `ai_agent_profile_save` 的迁移报告（契约 C3：用户可见提示 + 一次性前端提示）。
#[derive(Debug, Clone, Default)]
struct LegacyAgentMigrationReport {
    /// 这一行是"旧行"（库里还没有勾选名单，但有旧 multi-agent 配置）。
    legacy_row: bool,
    notes: Vec<String>,
}

/// 读旧写新：保存路径把旧自定义成员 / 旧模板成员写成库文件（**幂等**：文件已存在不重写，
/// 用户改动永不被覆盖），并把迁移提示回给调用方。返回的 `legacy_row` 用于 C14：
/// 旧行迁移出非空名单 = 旧行为里协作是开着的。
fn persist_legacy_agent_migration(
    conn: &Connection,
    profile_id: &str,
    now: i64,
) -> LegacyAgentMigrationReport {
    let mut report = LegacyAgentMigrationReport::default();
    let Ok(profile) = load_profile(conn, profile_id) else {
        return report;
    };
    let stored_ids = conn
        .query_row(
            "SELECT enabled_agent_ids_json FROM ai_agent_profiles WHERE id=?1",
            params![profile_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
        .map(|value| from_json_or_default::<Vec<String>>(&value))
        .unwrap_or_default();
    let legacy_config = profile.legacy_multi_agent_scheme_id.is_some()
        || !profile.legacy_multi_agents.is_empty()
        || matches!(
            profile.legacy_multi_agent_mode.trim(),
            desic_agent_automation::MULTI_AGENT_AUTO_MODE
                | desic_agent_automation::MULTI_AGENT_CUSTOM_MODE
        );
    report.legacy_row = stored_ids.is_empty() && legacy_config;
    report.notes = profile.migration_notes.clone();
    let (scheme_agents, scheme_instructions) = profile
        .legacy_multi_agent_scheme_id
        .as_deref()
        .and_then(|scheme_id| load_legacy_scheme_row(conn, scheme_id))
        .map(|(agents, instructions)| (agents, Some(instructions)))
        .unwrap_or_default();
    let plan = desic_agent_automation::plan_legacy_agent_migration(
        &desic_agent_automation::LegacyAgentMigrationInput {
            multi_agent_mode: Some(profile.legacy_multi_agent_mode.clone()),
            legacy_agents: profile.legacy_multi_agents.clone(),
            scheme_agents,
            scheme_instructions,
        },
        now,
    );
    // 旧成员落盘（幂等：文件已存在不重写，用户改动永不被覆盖）。落盘实现只有一份
    // （`agent_library::persist_migrated_agent_bundles`），避免两处各写一套。
    let (written, mut notes) = crate::agent_library::persist_migrated_agent_bundles(&plan);
    for note in notes.drain(..) {
        if !report.notes.contains(&note) {
            report.notes.push(note);
        }
    }
    if written > 0 {
        report
            .notes
            .push(format!("已把 {written} 个旧 Agent 迁移到 Agent 库"));
    }
    for note in plan.notes {
        if !report.notes.contains(&note) {
            report.notes.push(note);
        }
    }
    report
}

/// C14：保存时 `collaborationEnabled` 缺省（旧前端不带该字段 / 老 App 回写）→
/// **保留库中现值**，不得静默关闭；库里也没有值而这是旧行 → true；新 Profile → false。
/// C24.1：保存时 `singleAgentMode` 缺省（旧前端不带该字段）→ **保留库中现值**；
/// 库里没有该行 / 没有值时按 `standard`。提供的非法值已在 `normalize_profile` 回落成 `standard`。
/// TypeSafe / Jev：与 `single_agent_mode` / `collaboration_enabled` 同一规则 ——
/// 调用方未提供（`None`）时保留库中现值，避免旧前端保存时把已开启的 Jev 静默关掉。
fn apply_typesafe_enabled_default(
    conn: &Connection,
    profile: &mut AiAgentProfileInput,
    profile_id: &str,
) {
    if profile.typesafe_enabled.is_some() {
        return;
    }
    let stored = conn
        .query_row(
            "SELECT typesafe_enabled FROM ai_agent_profiles WHERE id=?1",
            params![profile_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .ok()
        .flatten()
        .unwrap_or(0);
    profile.typesafe_enabled = Some(stored != 0);
}

fn apply_single_agent_mode_default(
    conn: &Connection,
    profile: &mut AiAgentProfileInput,
    profile_id: &str,
) {
    if profile.single_agent_mode.is_some() {
        return;
    }
    let stored = conn
        .query_row(
            "SELECT single_agent_mode FROM ai_agent_profiles WHERE id=?1",
            params![profile_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten();
    profile.single_agent_mode = Some(
        stored
            .as_deref()
            .map(normalize_single_agent_mode)
            .unwrap_or_else(default_single_agent_mode),
    );
}

fn apply_collaboration_default(
    conn: &Connection,
    profile: &mut AiAgentProfileInput,
    profile_id: &str,
) {
    if profile.collaboration_enabled.is_some() {
        return;
    }
    let stored = conn
        .query_row(
            "SELECT collaboration_enabled,multi_agent_mode,multi_agents_json,
                    multi_agent_scheme_id,enabled_agent_ids_json
             FROM ai_agent_profiles WHERE id=?1",
            params![profile_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()
        .ok()
        .flatten();
    let Some((flag, mode, agents_json, scheme_id, ids_json)) = stored else {
        profile.collaboration_enabled = Some(false);
        return;
    };
    let stored_ids = from_json_or_default::<Vec<String>>(&ids_json);
    let legacy_config = scheme_id.is_some_and(|value| !value.trim().is_empty())
        || matches!(
            mode.trim(),
            desic_agent_automation::MULTI_AGENT_AUTO_MODE
                | desic_agent_automation::MULTI_AGENT_CUSTOM_MODE
        )
        || matches!(
            serde_json::from_str::<Vec<AiProfileSubAgent>>(&agents_json),
            Ok(agents) if !agents.is_empty()
        );
    profile.collaboration_enabled = Some(flag != 0 || (stored_ids.is_empty() && legacy_config));
}

/// P2 收口：没有任何 Profile 引用的旧模板行，其成员也要入库（**只增不勾选**），
/// 且重复执行幂等（第二次 `wrote=0`）、不动 Profile 勾选列、不删旧表行（回滚需要）。
pub(crate) fn sync_legacy_scheme_rows(conn: &Connection) -> (usize, Vec<String>) {
    let now = now_ms();
    let mut processed = load_setting(conn, LEGACY_SCHEME_SWEEP_SETTING)
        .and_then(|value| serde_json::from_value::<Vec<String>>(value).ok())
        .unwrap_or_default();
    let mut rows = Vec::new();
    if let Ok(mut stmt) = conn.prepare("SELECT id,agents_json FROM ai_agent_schemes") {
        if let Ok(mapped) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            for item in mapped.flatten() {
                rows.push(item);
            }
        }
    }
    let mut written = 0usize;
    let mut notes = Vec::new();
    let mut changed = false;
    for (scheme_id, agents_json) in rows {
        if processed.contains(&scheme_id) {
            continue;
        }
        let agents =
            serde_json::from_str::<Vec<AiProfileSubAgent>>(&agents_json).unwrap_or_default();
        let plan = desic_agent_automation::plan_legacy_agent_migration(
            &desic_agent_automation::LegacyAgentMigrationInput {
                multi_agent_mode: Some(
                    desic_agent_automation::MULTI_AGENT_CUSTOM_MODE.to_string(),
                ),
                legacy_agents: agents,
                scheme_agents: Vec::new(),
                scheme_instructions: None,
            },
            now,
        );
        let (scheme_written, scheme_notes) = crate::agent_library::persist_migrated_agent_bundles(&plan);
        written += scheme_written;
        for note in scheme_notes {
            if !notes.contains(&note) {
                notes.push(note);
            }
        }
        processed.push(scheme_id);
        changed = true;
    }
    if changed {
        let _ = set_setting(conn, LEGACY_SCHEME_SWEEP_SETTING, json!(processed));
    }
    (written, notes)
}

/// Agent 列表路径的旧模板兜底（幂等、只增不改勾选）；失败只记日志。
pub(crate) fn sync_legacy_scheme_agents(app: &tauri::AppHandle) {
    let Ok(conn) = open_automation_database(app) else {
        return;
    };
    let (written, notes) = sync_legacy_scheme_rows(&conn);
    if written > 0 || !notes.is_empty() {
        crate::boot_log(&format!(
            "agents: legacy scheme sweep written={written} notes={notes:?}"
        ));
    }
}

#[cfg(test)]
pub(crate) fn clear_legacy_scheme_migration_marker_for_test(conn: &Connection) {
    let _ = conn.execute(
        "DELETE FROM ai_automation_settings WHERE key=?1",
        params![LEGACY_SCHEME_SWEEP_SETTING],
    );
}

#[cfg(test)]
pub(crate) fn normalize_profile_for_test(
    profile: AiAgentProfileInput,
) -> Result<AiAgentProfileInput, String> {
    normalize_profile(profile)
}

#[cfg(test)]
pub(crate) fn upsert_profile_row_for_test(
    conn: &Connection,
    profile: &AiAgentProfileInput,
    id: &str,
    created_at: i64,
    now: i64,
) -> Result<(), String> {
    upsert_profile_row(conn, profile, id, created_at, now)
}

#[cfg(test)]
pub(crate) fn load_profile_for_test(
    conn: &Connection,
    id: &str,
) -> Result<AiAgentProfileSummary, String> {
    load_profile(conn, id)
}

#[cfg(test)]
pub(crate) fn apply_collaboration_default_for_test(
    conn: &Connection,
    profile: &mut AiAgentProfileInput,
    profile_id: &str,
) {
    apply_collaboration_default(conn, profile, profile_id)
}

#[cfg(test)]
pub(crate) fn build_triage_record_for_test(
    config: &crate::ai_triage::AiAgentTriageConfig,
    escalate: bool,
    decision: &crate::ai_triage::TriageDecision,
    reasons: &[String],
    evidence: &[crate::ai_triage::AiTriageEvidence],
    unavailable: &[String],
    inputs: &crate::ai_triage::TriageEscalationInputs,
    skip_streak: u32,
    triage_usage: &Value,
    now: i64,
) -> Value {
    triage_record_value(
        config,
        escalate,
        decision,
        reasons,
        evidence,
        unavailable,
        inputs,
        skip_streak,
        triage_usage,
        now,
    )
}

#[cfg(test)]
pub(crate) fn subtract_usage_for_test(total: &Value, part: &Value) -> Value {
    subtract_usage(total, part)
}

fn normalize_profile(mut profile: AiAgentProfileInput) -> Result<AiAgentProfileInput, String> {
    profile.name = profile.name.trim().to_string();
    if profile.name.is_empty() {
        return Err("Profile 名称不能为空".to_string());
    }
    profile.mode = normalize_permission_mode(Some(&profile.mode)).to_string();
    profile.environment = normalize_environment(&profile.environment);
    profile.account_id = profile
        .account_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if profile.enabled && profile.mode != ADVISOR_MODE && profile.account_id.is_none() {
        return Err("副驾驶和受限自动模式必须绑定账号".to_string());
    }
    profile.symbols = normalize_symbols(profile.symbols);
    if profile.symbols.is_empty() {
        return Err("至少配置一个关注交易品种".to_string());
    }
    if profile.symbols.len() > MAX_PROFILE_SYMBOLS {
        return Err(format!(
            "每个 Profile 最多配置 {MAX_PROFILE_SYMBOLS} 个关注交易品种"
        ));
    }
    profile.skill_ids = with_required_profile_skills(profile.skill_ids);
    profile.allowed_wake_condition_types = normalize_strings(profile.allowed_wake_condition_types);
    if profile.allowed_wake_condition_types.is_empty() {
        profile.allowed_wake_condition_types = default_wake_condition_types();
    }
    profile.scan_interval_minutes = profile.scan_interval_minutes.clamp(1, 1_440);
    profile.history_lookback_days = profile.history_lookback_days.clamp(1, 365);
    profile.similarity_window_minutes = profile.similarity_window_minutes.clamp(1, 1_440);
    profile.entry_tolerance_bps = profile.entry_tolerance_bps.clamp(1, 2_000);
    profile.target_leverage = profile.target_leverage.clamp(1, 125);
    profile.max_single_trade_margin_pct = profile.max_single_trade_margin_pct.clamp(1, 100);
    // Retain the legacy database column for migration compatibility. Agent Runs no longer
    // use a wall-clock execution limit.
    profile.max_runtime_seconds = default_max_runtime();
    profile.min_wake_interval_seconds = profile.min_wake_interval_seconds.clamp(15, 86_400);
    profile.max_runs_per_hour = profile.max_runs_per_hour.clamp(1, 60);
    profile.model = profile
        .model
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    profile.reasoning_depth = normalize_profile_reasoning_depth(&profile.reasoning_depth);
    // C3/C14/C15：多 Agent 由「Agent 库 + 勾选名单」驱动；旧字段（multiAgentMode /
    // multiAgents / multiAgentSchemeId / orchestrator / expertSource）已从输入类型删除，
    // DB 旧列只读不写（见 `upsert_profile_row`）。勾选 id 归一到库里的正式 id
    // （旧 `auto-*` alias → `desic-*`），保序去重；"id 是否存在"由保存路径校验
    // （C3：不存在的 id 丢弃并提示，不阻断保存）。
    profile.enabled_agent_ids = normalize_agent_id_list(profile.enabled_agent_ids);
    // C19：试判配置宽容归一化（缺字段 = C19.1 默认，mode=enforce）。
    profile.triage = profile.triage.normalized();
    // C24.1：单 Agent 子模式非法值 → `standard`（不报错、不阻断保存）；
    // 只有调用方真的提供了字段时才归一（None 留给保存路径保留库中现值）。
    profile.single_agent_mode = profile
        .single_agent_mode
        .as_deref()
        .map(normalize_single_agent_mode);
    Ok(profile)
}

/// 勾选名单归一化：trim、丢掉空值、旧 id alias → 正式 id、保序去重。
fn normalize_agent_id_list(items: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    normalize_strings(items)
        .into_iter()
        .map(|id| desic_agent_automation::resolve_agent_id_alias(&id))
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

fn with_required_profile_skills(items: Vec<String>) -> Vec<String> {
    let mut result = REQUIRED_PROFILE_SKILL_IDS
        .iter()
        .map(|skill_id| (*skill_id).to_string())
        .collect::<Vec<_>>();
    for skill_id in normalize_strings(items) {
        let skill_id = match skill_id.as_str() {
            "okx-news-intelligence" | "okx-smart-money-analysis" => {
                "okx-market-intelligence".to_string()
            }
            "desic-perpetual-risk" | "desic-position-management" | "desic-market-analysis" => {
                "desic-trade-operations".to_string()
            }
            _ => skill_id,
        };
        if !result.iter().any(|existing| existing == &skill_id) {
            result.push(skill_id);
        }
    }
    result
}

fn normalize_profile_reasoning_depth(value: &str) -> String {
    match value.trim() {
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" => value.trim().to_string(),
        // Compatibility for local Profile rows written before the tier was removed.
        "ultra" => "xhigh".to_string(),
        _ => default_profile_reasoning_depth(),
    }
}

fn normalize_profile_skill_version_preferences(profile: &mut AiAgentProfileInput) {
    let selected = profile.skill_ids.iter().cloned().collect::<HashSet<_>>();
    profile
        .skill_version_modes
        .retain(|skill_id, mode| selected.contains(skill_id) && mode == "pinned");
    profile.skill_versions.retain(|skill_id, version| {
        selected.contains(skill_id)
            && *version > 0
            && profile
                .skill_version_modes
                .get(skill_id)
                .is_some_and(|mode| mode == "pinned")
    });
}

/// C7「运行历史兼容」+ C3 迁移：Run 快照宽容校验。
///
/// v3 里 `off / auto / custom / 未知` 都不再是校验错误（多 Agent 模式概念已删除）；
/// 旧快照的 `multiAgentMode` / `multiAgents` 在**内存里**迁移成 `enabledAgentIds`
/// （幂等，不写盘、不建文件——落盘只发生在保存路径），新快照的 `enabledAgentIds`
/// 原样生效（库校验只在保存路径，见 C3）。
fn validate_profile_snapshot(
    mut profile: AiAgentProfileSummary,
) -> Result<AiAgentProfileSummary, String> {
    profile.target_leverage = profile.target_leverage.clamp(1, 125);
    profile.max_single_trade_margin_pct = profile.max_single_trade_margin_pct.clamp(1, 100);
    if profile.enabled_agent_ids.is_empty() {
        let plan = desic_agent_automation::plan_legacy_agent_migration(
            &desic_agent_automation::LegacyAgentMigrationInput {
                multi_agent_mode: Some(profile.legacy_multi_agent_mode.clone()),
                legacy_agents: profile.legacy_multi_agents.clone(),
                // 旧模板成员属于"被 Profile 引用"的迁移路径，读取时按 scheme 补上。
                scheme_agents: Vec::new(),
                scheme_instructions: None,
            },
            now_ms(),
        );
        profile.enabled_agent_ids = normalize_agent_id_list(plan.enabled_agent_ids);
        profile.migration_notes.extend(plan.notes);
        if migration_log_slot(&format!("snapshot:{}", profile.id)) {
            crate::boot_log(&format!(
                "agent migration snapshot={} mode={} ids={:?}",
                profile.id, profile.legacy_multi_agent_mode, profile.enabled_agent_ids
            ));
        }
    } else {
        profile.enabled_agent_ids = normalize_agent_id_list(profile.enabled_agent_ids.clone());
    }
    // C20.5：旧 Run 快照重放同样剔除已下线角色（否则历史快照仍能派发旧专家）。
    // 快照是历史记录：只过滤，不迁移、不回写。
    let (effective, _ignored) =
        split_deprecated_agent_ids(std::mem::take(&mut profile.enabled_agent_ids));
    profile.enabled_agent_ids = effective;
    Ok(profile)
}

fn bind_profile_account_environment(
    app: &tauri::AppHandle,
    profile: &mut AiAgentProfileInput,
) -> Result<(), String> {
    let Some(account_id) = profile.account_id.as_deref() else {
        return Ok(());
    };
    let account = load_local_account_secret(app, Some(account_id))?;
    profile.environment = normalize_environment(&account.environment);
    if profile.enabled && !account.permissions.read {
        return Err("启用 Agent Profile 前必须给绑定账号开启读取权限".to_string());
    }
    if profile.enabled && profile.mode != ADVISOR_MODE && !account.permissions.trade {
        return Err("副驾驶和受限自动模式需要交易权限，以便按 Profile 目标同步杠杆".to_string());
    }
    Ok(())
}

fn normalize_symbols(items: Vec<String>) -> Vec<String> {
    normalize_strings(items)
        .into_iter()
        .map(|value| value.to_ascii_uppercase())
        .filter(|value| value.ends_with("-SWAP"))
        .collect()
}

fn enabled_systematic_profile_conflicts(
    conn: &Connection,
    account_id: Option<&str>,
    environment: &str,
    symbols: &[String],
) -> Result<Vec<AiAgentProfileSystematicConflict>, String> {
    let Some(account_id) = account_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(Vec::new());
    };
    let symbols = normalize_symbols(symbols.to_vec())
        .into_iter()
        .collect::<HashSet<_>>();
    if symbols.is_empty() {
        return Ok(Vec::new());
    }
    let environment = normalize_environment(environment);
    let mut statement = conn
        .prepare(
            "SELECT id,name,inst_id FROM systematic_profiles
             WHERE enabled=1 AND account_id=?1 AND environment=?2
             ORDER BY updated_at DESC,name COLLATE NOCASE ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![account_id, environment], |row| {
            Ok(AiAgentProfileSystematicConflict {
                id: row.get(0)?,
                name: row.get(1)?,
                inst_id: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.filter_map(|row| match row {
        Ok(conflict) if symbols.contains(&conflict.inst_id) => Some(Ok(conflict)),
        Ok(_) => None,
        Err(error) => Some(Err(error.to_string())),
    })
    .collect()
}

fn systematic_profile_conflict_message(conflicts: &[AiAgentProfileSystematicConflict]) -> String {
    let scopes = conflicts
        .iter()
        .map(|conflict| format!("{} ({})", conflict.name, conflict.inst_id))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "An enabled strategy Profile already manages the same account, environment, and contract: {scopes}. Review the conflict or explicitly confirm enabling this AI Profile."
    )
}

fn normalize_strings(items: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for item in items {
        let value = item.trim();
        if !value.is_empty() && seen.insert(value.to_string()) {
            result.push(value.to_string());
        }
    }
    result
}

fn load_profiles(conn: &Connection) -> Result<Vec<AiAgentProfileSummary>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,name,enabled,mode,account_id,environment,symbols_json,scan_interval_minutes,
             skill_ids_json,skill_versions_json,model,history_lookback_days,similarity_window_minutes,
             entry_tolerance_bps,min_wake_interval_seconds,max_runs_per_hour,
             feishu_enabled,daily_review_enabled,allowed_wake_condition_types_json,
             created_at,updated_at,target_leverage,skill_version_modes_json,reasoning_depth,max_single_trade_margin_pct,
             multi_agent_mode,multi_agents_json,multi_agent_scheme_id,
             enabled_agent_ids_json,collaboration_enabled,triage_json,triage_skip_streak,triage_last_deep_at,
             single_agent_mode,typesafe_enabled
             FROM ai_agent_profiles WHERE deleted_at IS NULL ORDER BY enabled DESC, updated_at DESC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], profile_from_row)
        .map_err(|err| err.to_string())?;
    let mut profiles = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    for profile in profiles.iter_mut() {
        apply_legacy_agent_migration(conn, profile);
    }
    Ok(profiles)
}

fn load_profile(conn: &Connection, id: &str) -> Result<AiAgentProfileSummary, String> {
    let mut profile = conn
        .query_row(
            "SELECT id,name,enabled,mode,account_id,environment,symbols_json,scan_interval_minutes,
             skill_ids_json,skill_versions_json,model,history_lookback_days,similarity_window_minutes,
             entry_tolerance_bps,min_wake_interval_seconds,max_runs_per_hour,
             feishu_enabled,daily_review_enabled,allowed_wake_condition_types_json,
             created_at,updated_at,target_leverage,skill_version_modes_json,reasoning_depth,max_single_trade_margin_pct,
             multi_agent_mode,multi_agents_json,multi_agent_scheme_id,
             enabled_agent_ids_json,collaboration_enabled,triage_json,triage_skip_streak,triage_last_deep_at,
             single_agent_mode,typesafe_enabled
             FROM ai_agent_profiles WHERE id=?1 AND deleted_at IS NULL",
            params![id],
            profile_from_row,
        )
        .map_err(|err| err.to_string())?;
    apply_legacy_agent_migration(conn, &mut profile);
    Ok(profile)
}

/// 旧模板（`ai_agent_schemes`）行：表结构保留（回滚需要），命令层已删除，只做迁移输入。
fn load_legacy_scheme_row(
    conn: &Connection,
    scheme_id: &str,
) -> Option<(Vec<AiProfileSubAgent>, String)> {
    conn.query_row(
        "SELECT agents_json,instructions FROM ai_agent_schemes WHERE id=?1",
        params![scheme_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )
    .optional()
    .ok()
    .flatten()
    .map(|(agents_json, instructions)| {
        (
            serde_json::from_str::<Vec<AiProfileSubAgent>>(&agents_json).unwrap_or_default(),
            instructions,
        )
    })
}

/// C3/C14 **读取路径**的内存迁移（幂等、**不写盘、不建文件**；落盘只发生在保存路径
/// `persist_legacy_agent_migration`）：
///
/// - `enabled_agent_ids_json` 非空 = 已迁移（或本来就是新模型）→ 原样生效，不看旧列；
/// - 否则由旧 `multi_agent_mode` / `multi_agents_json` / `multi_agent_scheme_id` 推导；
/// - 推导出的名单非空 → `collaborationEnabled = true`（C14 迁移三态：auto/custom/scheme
///   都是"旧行为里开了协作"），但**从不**把已有配置置 false（关开关不清空勾选）。
fn apply_legacy_agent_migration(conn: &Connection, profile: &mut AiAgentProfileSummary) {
    if profile.enabled_agent_ids.is_empty() {
        apply_legacy_agent_migration_once(conn, profile);
    }
    // C20.5（强制迁移版）：防御性检查 —— 含已下线 id / 缺默认角色的旧 Profile 在这里
    // 被改写成「默认 4 角色 + 其余保留 id」并**落库**（幂等：改写后就不再触发）。
    // 已合规与空名单的 Profile 一个字节都不动。
    let stored = normalize_agent_id_list(std::mem::take(&mut profile.enabled_agent_ids));
    match plan_enabled_agent_ids_migration(&stored) {
        Some(migrated) => {
            persist_enabled_agent_ids(conn, &profile.id, &stored, &migrated);
            profile.enabled_agent_ids = migrated;
        }
        None => profile.enabled_agent_ids = stored,
    }
}

/// C20.5（强制迁移版）：把旧勾选改写成「**默认 4 个角色（内置顺序）** + 其余保留 id
/// （原相对顺序）」，即"只换掉已下线的、补齐新 4 个、保留自定义与仍有效的角色"。
///
/// 触发条件（**只对需要迁移的 Profile 动手**）：
/// - 名单**非空**（空名单 = 新建 / 用户没勾：不凭空塞进 4 个专家）；
/// - 且「**含已下线 id**」（董事会的原始触发条件）**或**「名单里一个默认角色都没有」
///   （= 纯自定义 / 旧 custom、scheme 迁移出来的 Profile，董事会要求的"补齐新 4 个"）。
///
/// 刻意**不**因为"少了 4 个里的某一个"就动手：用户有意只跑 2–3 个角色是合法配置，
/// 每次都补回来会让人永远选不动（"只换掉已下线的、补齐新 4 个"的补齐对象是**旧配置**，
/// 不是用户当下的勾选）。
///
/// 已合规（含默认角色且无已下线 id）→ `None`（一个字节不改，因此幂等）。
/// 纯函数，便于单测覆盖各种形态。
fn plan_enabled_agent_ids_migration(stored: &[String]) -> Option<Vec<String>> {
    if stored.is_empty() {
        return None;
    }
    let defaults = desic_agent_automation::default_enabled_agent_ids();
    let has_deprecated = stored
        .iter()
        .any(|id| desic_agent_automation::is_deprecated_agent_id(id));
    let has_default = stored.iter().any(|id| defaults.contains(id));
    if !has_deprecated && has_default {
        return None;
    }
    let mut migrated = defaults;
    for id in stored {
        // 已下线的踢掉；未知 id 保留（可能只是库文件暂时读不到，清理是 C3 保存路径的事）。
        if desic_agent_automation::is_deprecated_agent_id(id) {
            continue;
        }
        if !migrated.contains(id) {
            migrated.push(id.clone());
        }
    }
    if &migrated == stored {
        return None;
    }
    Some(migrated)
}

/// 把迁移结果写回 `enabled_agent_ids_json`；返回是否真的写了（幂等路径返回 false）。
fn persist_enabled_agent_ids(
    conn: &Connection,
    profile_id: &str,
    before: &[String],
    after: &[String],
) -> bool {
    let Ok(payload) = to_json(&after.to_vec()) else {
        return false;
    };
    if conn
        .execute(
            "UPDATE ai_agent_profiles SET enabled_agent_ids_json=?2,updated_at=?3 WHERE id=?1",
            params![profile_id, payload, now_ms()],
        )
        .is_err()
    {
        return false;
    }
    if migration_log_slot(&format!("enabled-agents:{profile_id}")) {
        crate::boot_log(&format!(
            "C20.5 enabled-agent migration profile={profile_id} before={before:?} after={after:?}"
        ));
    }
    true
}

/// 启动期迁移：逐 Profile 做同一次强制迁移（幂等、只对需要迁移的行动手）。
/// 返回本次真正改写的 Profile 数；任何单行失败都不影响其它行，也绝不阻断启动。
pub(crate) fn migrate_deprecated_enabled_agents(conn: &Connection) -> usize {
    let mut ids = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT id,enabled_agent_ids_json FROM ai_agent_profiles WHERE deleted_at IS NULL",
    ) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            for row in rows.flatten() {
                ids.push(row);
            }
        }
    }
    let mut migrated_count = 0usize;
    for (profile_id, raw) in ids {
        let stored = normalize_agent_id_list(from_json_or_default::<Vec<String>>(&raw));
        let Some(migrated) = plan_enabled_agent_ids_migration(&stored) else {
            continue;
        };
        if persist_enabled_agent_ids(conn, &profile_id, &stored, &migrated) {
            migrated_count += 1;
        }
    }
    if migrated_count > 0 {
        crate::boot_log(&format!(
            "C20.5 startup enabled-agent migration rewrote {migrated_count} profile(s)"
        ));
    }
    migrated_count
}

/// C20.5：把勾选名单拆成"生效 / 被忽略（已下线）"两份（纯函数，恢复路径可测）。
fn split_deprecated_agent_ids(ids: Vec<String>) -> (Vec<String>, Vec<String>) {
    let mut effective = Vec::new();
    let mut ignored = Vec::new();
    for id in ids {
        if desic_agent_automation::is_deprecated_agent_id(&id) {
            ignored.push(id);
        } else {
            effective.push(id);
        }
    }
    (effective, ignored)
}

fn apply_legacy_agent_migration_once(conn: &Connection, profile: &mut AiAgentProfileSummary) {
    if !profile.enabled_agent_ids.is_empty() {
        return;
    }
    let (scheme_agents, scheme_instructions) = profile
        .legacy_multi_agent_scheme_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|scheme_id| load_legacy_scheme_row(conn, scheme_id))
        .map(|(agents, instructions)| (agents, Some(instructions)))
        .unwrap_or_default();
    // 迁移计划的唯一实现（crate）+ 唯一包装（agent_library），这里不另写一套。
    let plan = crate::agent_library::plan_agent_migration_from_legacy(
        Some(profile.legacy_multi_agent_mode.as_str()),
        profile.legacy_multi_agents.clone(),
        scheme_agents,
        scheme_instructions.as_deref(),
        now_ms(),
    );
    if plan.enabled_agent_ids.is_empty() && plan.notes.is_empty() {
        return;
    }
    let migrated = normalize_agent_id_list(plan.enabled_agent_ids);
    if !migrated.is_empty() {
        profile.enabled_agent_ids = migrated;
        profile.collaboration_enabled = true;
    }
    for note in plan.notes {
        if !profile.migration_notes.contains(&note) {
            profile.migration_notes.push(note);
        }
    }
    // 去重：每次读取都会算一遍迁移，同一个 Profile 只记一行日志（见 `migration_log_slot`）。
    if migration_log_slot(&format!("profile:{}", profile.id)) {
        crate::boot_log(&format!(
            "agent migration profile={} mode={} ids={:?} notes={:?}",
            profile.id, profile.legacy_multi_agent_mode, profile.enabled_agent_ids, profile.migration_notes
        ));
    }
}


/// Profile 行 → 摘要。
///
/// 列序与 `load_profiles` / `load_profile` 的 SELECT **逐位对齐**（改一处必须改两处）。
/// 旧列（`multi_agent_mode` / `multi_agents_json` / `multi_agent_scheme_id`）只读不写，
/// 读出来放进 `legacy_*` 字段供内存迁移；旧值损坏不再让整行读不出来（宽容：
/// 未知 mode 与坏 JSON 都退化成"没有旧配置"）。
fn profile_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiAgentProfileSummary> {
    let symbols: String = row.get(6)?;
    let skill_ids: String = row.get(8)?;
    let skill_versions: String = row.get(9)?;
    let wake_types: String = row.get(18)?;
    let account_id: Option<String> = row.get(4)?;
    let legacy_mode: String = row.get(25)?;
    let legacy_agents_json: String = row.get(26)?;
    let legacy_scheme_id: Option<String> = row.get(27)?;
    let enabled_agent_ids: String = row.get(28)?;
    let triage_json: Option<String> = row.get(30)?;
    let single_agent_mode: Option<String> = row.get(33)?;
    let typesafe_enabled: Option<i64> = row.get(34).ok();
    Ok(AiAgentProfileSummary {
        id: row.get(0)?,
        name: row.get(1)?,
        enabled: row.get::<_, i64>(2)? != 0,
        mode: normalize_permission_mode(row.get::<_, String>(3).ok().as_deref()).to_string(),
        account_id,
        environment: row.get(5)?,
        symbols: from_json_or_default(&symbols),
        scan_interval_minutes: row.get::<_, i64>(7)?.max(1) as u32,
        skill_ids: with_required_profile_skills(from_json_or_default(&skill_ids)),
        skill_versions: from_json_or_default(&skill_versions),
        skill_version_modes: from_json_or_default(&row.get::<_, String>(22)?),
        model: row.get(10)?,
        reasoning_depth: normalize_profile_reasoning_depth(&row.get::<_, String>(23)?),
        history_lookback_days: row.get::<_, i64>(11)?.max(1) as u32,
        similarity_window_minutes: row.get::<_, i64>(12)?.max(1) as u32,
        entry_tolerance_bps: row.get::<_, i64>(13)?.max(1) as u32,
        target_leverage: row.get::<_, i64>(21)?.clamp(1, 125) as u32,
        max_single_trade_margin_pct: row.get::<_, i64>(24)?.clamp(1, 100) as u32,
        min_wake_interval_seconds: row.get::<_, i64>(14)?.max(15) as u32,
        max_runs_per_hour: row.get::<_, i64>(15)?.max(1) as u32,
        feishu_enabled: row.get::<_, i64>(16)? != 0,
        daily_review_enabled: row.get::<_, i64>(17)? != 0,
        allowed_wake_condition_types: from_json_or_default(&wake_types),
        collaboration_enabled: row.get::<_, i64>(29)? != 0,
        enabled_agent_ids: normalize_agent_id_list(from_json_or_default(&enabled_agent_ids)),
        // C24：列默认 `standard`，因此旧 Profile 行天然是"标准模式"。
        single_agent_mode: single_agent_mode
            .as_deref()
            .map(normalize_single_agent_mode)
            .unwrap_or_else(default_single_agent_mode),
        typesafe_enabled: typesafe_enabled.unwrap_or(0) != 0,
        triage: triage_json
            .as_deref()
            .and_then(|value| {
                serde_json::from_str::<crate::ai_triage::AiAgentTriageConfig>(value).ok()
            })
            .unwrap_or_default()
            .normalized(),
        triage_skip_streak: row.get::<_, i64>(31)?.max(0) as u32,
        triage_last_deep_at: row.get(32)?,
        legacy_multi_agent_mode: legacy_mode,
        legacy_multi_agents: serde_json::from_str::<Vec<AiProfileSubAgent>>(&legacy_agents_json)
            .unwrap_or_default(),
        legacy_multi_agent_scheme_id: legacy_scheme_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        migration_notes: Vec::new(),
        created_at: row.get(19)?,
        updated_at: row.get(20)?,
    })
}

#[derive(Debug, Clone)]
struct StoredRunRow {
    id: String,
    profile_id: String,
    trigger_type: String,
    status: String,
    summary: Option<String>,
    error: Option<String>,
    started_at: i64,
    finished_at: Option<i64>,
    next_wake_at: Option<i64>,
    action_counts_json: String,
    token_usage_json: Option<String>,
    /// C19.3：试判块（含分阶段 token）。
    triage_json: Option<String>,
    /// P1（C20）：专家级用量。
    experts_json: Option<String>,
    /// C20.6 / C21.3：审计字段（usedEvidence / contrarianResolutions / selfAnalysis* /
    /// summaryFormatWarnings）。
    audit_json: Option<String>,
    /// C24：本次运行生效的单 Agent 子模式。
    single_agent_mode: String,
}

#[derive(Debug, Clone)]
struct RunMetadata {
    action_counts: AiAgentRunActionCounts,
    token_usage: Option<AiUsageSummary>,
}

fn stored_run_row_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredRunRow> {
    Ok(StoredRunRow {
        id: row.get(0)?,
        profile_id: row.get(1)?,
        trigger_type: row.get(2)?,
        status: row.get(3)?,
        summary: row.get(4)?,
        error: row.get(5)?,
        started_at: row.get(6)?,
        finished_at: row.get(7)?,
        next_wake_at: row.get(8)?,
        action_counts_json: row.get(9)?,
        token_usage_json: row.get(10)?,
        triage_json: row.get(11)?,
        experts_json: row.get(12)?,
        audit_json: row.get(13)?,
        single_agent_mode: normalize_single_agent_mode(
            &row.get::<_, Option<String>>(14)?.unwrap_or_default(),
        ),
    })
}

fn cached_run_metadata(row: &StoredRunRow) -> Option<RunMetadata> {
    if row.action_counts_json.trim().is_empty() || row.action_counts_json.trim() == "{}" {
        return None;
    }
    let action_counts = serde_json::from_str(&row.action_counts_json).ok()?;
    let token_usage = row
        .token_usage_json
        .as_deref()
        .and_then(|value| serde_json::from_str::<AiUsageSummary>(value).ok())?;
    if token_usage.schema_version < AI_USAGE_SCHEMA_VERSION {
        return None;
    }
    Some(RunMetadata {
        action_counts,
        token_usage: Some(token_usage),
    })
}

fn run_summary_from_stored(row: StoredRunRow, metadata: RunMetadata) -> AiAgentRunSummary {
    // 三列都是"落库时的原始 JSON"，形状宽容：读不出来的就当没有（不猜、不报错）。
    let read_json = |value: &Option<String>| {
        value
            .as_deref()
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
            .filter(|value| !value.is_null())
    };
    let triage = read_json(&row.triage_json);
    let experts = read_json(&row.experts_json);
    let audit = read_json(&row.audit_json);
    // C21.3 / C20.6：软审计与审计明细在 run 上**同时**扁平暴露
    // （UI 直接读 `run.summaryFormatWarnings` / `run.usedEvidence` /
    // `run.contrarianResolutions`，轨迹面板读 `run.audit.*`）。
    let summary_format_warnings = audit
        .as_ref()
        .and_then(|value| value.get("summaryFormatWarnings"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let used_evidence = audit
        .as_ref()
        .and_then(|value| value.get("usedEvidence"))
        .cloned();
    let contrarian_resolutions = audit
        .as_ref()
        .and_then(|value| value.get("contrarianResolutions"))
        .cloned();
    AiAgentRunSummary {
        id: row.id,
        triage,
        experts,
        audit,
        summary_format_warnings,
        used_evidence,
        contrarian_resolutions,
        single_agent_mode: row.single_agent_mode,
        profile_id: row.profile_id,
        trigger_type: row.trigger_type,
        status: row.status,
        summary: row.summary,
        error: row.error,
        started_at: row.started_at,
        finished_at: row.finished_at,
        next_wake_at: row.next_wake_at,
        action_counts: metadata.action_counts,
        token_usage: metadata.token_usage,
    }
}

fn run_ids_placeholders(ids: &[String]) -> String {
    vec!["?"; ids.len()].join(",")
}

fn load_run_delivery_counts(
    conn: &Connection,
    run_ids: &[String],
) -> Result<HashMap<String, u32>, String> {
    if run_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = run_ids_placeholders(run_ids);
    let query = format!(
        "SELECT run_id,COUNT(*) FROM ai_notification_deliveries
         WHERE run_id IN ({placeholders}) GROUP BY run_id"
    );
    let mut stmt = conn.prepare(&query).map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(run_ids.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let counts = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|(run_id, count)| (run_id, count.max(0) as u32))
        .collect::<HashMap<_, _>>();
    Ok(counts)
}

fn load_missing_run_metadata(
    conn: &Connection,
    run_ids: &[String],
) -> Result<HashMap<String, RunMetadata>, String> {
    if run_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let session_to_run = run_ids
        .iter()
        .map(|run_id| (format!("background:{run_id}"), run_id.clone()))
        .collect::<HashMap<_, _>>();
    let session_ids = session_to_run.keys().cloned().collect::<Vec<_>>();
    let placeholders = run_ids_placeholders(&session_ids);
    let query = format!(
        "SELECT session_id,tool_json FROM ai_messages
         WHERE role='assistant' AND tool_json IS NOT NULL AND session_id IN ({placeholders})
         ORDER BY session_id ASC,created_at DESC"
    );
    let mut stmt = conn.prepare(&query).map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(session_ids.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let mut results = HashMap::new();
    for row in rows {
        let (session_id, tool_json) = row.map_err(|error| error.to_string())?;
        let Some(run_id) = session_to_run.get(&session_id) else {
            continue;
        };
        if results.contains_key(run_id) {
            continue;
        }
        results.insert(run_id.clone(), parse_run_metadata(&tool_json));
    }
    Ok(results)
}

fn persist_run_metadata(
    conn: &Connection,
    run_id: &str,
    metadata: &RunMetadata,
) -> Result<(), String> {
    conn.execute(
        "UPDATE ai_agent_runs SET action_counts_json=?2,token_usage_json=?3 WHERE id=?1",
        params![
            run_id,
            to_json(&metadata.action_counts)?,
            metadata.token_usage.as_ref().map(to_json).transpose()?,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn persist_ai_automation_run_metadata(
    conn: &Connection,
    run_id: &str,
    tool_json: &str,
    token_usage: &AiUsageSummary,
) -> Result<(), String> {
    let mut metadata = RunMetadata {
        action_counts: parse_run_action_counts(tool_json),
        token_usage: Some(token_usage.clone()),
    };
    let delivery_count = load_run_delivery_counts(conn, &[run_id.to_string()])
        .ok()
        .and_then(|counts| counts.get(run_id).copied())
        .unwrap_or(0);
    metadata.action_counts.notification = metadata.action_counts.notification.max(delivery_count);
    persist_run_metadata(conn, run_id, &metadata)
}

fn load_runs(conn: &Connection, limit: i64) -> Result<Vec<AiAgentRunSummary>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,profile_id,trigger_type,status,summary,error,started_at,finished_at,next_wake_at,
                    action_counts_json,token_usage_json,triage_json,experts_json,audit_json,
                    single_agent_mode
             FROM ai_agent_runs ORDER BY created_at DESC LIMIT ?1",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![limit], stored_run_row_from_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let run_ids = rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>();
    let delivery_counts = load_run_delivery_counts(conn, &run_ids)?;
    let missing_ids = rows
        .iter()
        .filter(|row| cached_run_metadata(row).is_none())
        .map(|row| row.id.clone())
        .collect::<Vec<_>>();
    let hydrated_metadata = load_missing_run_metadata(conn, &missing_ids)?;
    let mut cache_updates = Vec::new();
    let runs = rows
        .into_iter()
        .map(|row| {
            let cache_missing = cached_run_metadata(&row).is_none();
            let mut metadata = cached_run_metadata(&row)
                .or_else(|| hydrated_metadata.get(&row.id).cloned())
                .unwrap_or(RunMetadata {
                    action_counts: AiAgentRunActionCounts::default(),
                    token_usage: None,
                });
            metadata.action_counts.notification = metadata
                .action_counts
                .notification
                .max(delivery_counts.get(&row.id).copied().unwrap_or(0));
            if cache_missing && hydrated_metadata.contains_key(&row.id) {
                cache_updates.push((row.id.clone(), metadata.clone()));
            }
            run_summary_from_stored(row, metadata)
        })
        .collect::<Vec<_>>();
    for (run_id, metadata) in cache_updates {
        let _ = persist_run_metadata(conn, &run_id, &metadata);
    }
    Ok(runs)
}

fn load_run_statuses(conn: &Connection, ids: &[String]) -> Result<Vec<AiAgentRunStatus>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,status,summary,error,finished_at,next_wake_at
             FROM ai_agent_runs WHERE id=?1",
        )
        .map_err(|err| err.to_string())?;
    ids.iter()
        .filter_map(|id| {
            match stmt
                .query_row(params![id], |row| {
                    Ok(AiAgentRunStatus {
                        id: row.get(0)?,
                        status: row.get(1)?,
                        summary: row.get(2)?,
                        error: row.get(3)?,
                        finished_at: row.get(4)?,
                        next_wake_at: row.get(5)?,
                    })
                })
                .optional()
            {
                Ok(Some(status)) => Some(Ok(status)),
                Ok(None) => None,
                Err(err) => Some(Err(err.to_string())),
            }
        })
        .collect()
}

fn load_run(conn: &Connection, id: &str) -> Result<AiAgentRunSummary, String> {
    conn.query_row(
        "SELECT id,profile_id,trigger_type,status,summary,error,started_at,finished_at,next_wake_at,
                action_counts_json,token_usage_json,triage_json,experts_json,audit_json,
                single_agent_mode
         FROM ai_agent_runs WHERE id=?1",
        params![id],
        stored_run_row_from_row,
    )
    .map_err(|err| err.to_string())
    .and_then(|row| {
        let metadata = cached_run_metadata(&row)
            .map(Ok)
            .unwrap_or_else(|| load_run_metadata(conn, &row.id));
        metadata.map(|metadata| run_summary_from_stored(row, metadata))
    })
}

fn load_run_metadata(conn: &Connection, run_id: &str) -> Result<RunMetadata, String> {
    let session_id = format!("background:{run_id}");
    let tool_json = conn
        .query_row(
            "SELECT tool_json FROM ai_messages
             WHERE session_id=?1 AND role='assistant' AND tool_json IS NOT NULL
             ORDER BY created_at DESC LIMIT 1",
            params![session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .flatten();
    let mut metadata = tool_json
        .as_deref()
        .map(parse_run_metadata)
        .unwrap_or(RunMetadata {
            action_counts: AiAgentRunActionCounts::default(),
            token_usage: None,
        });
    let delivery_count = load_run_delivery_counts(conn, &[run_id.to_string()])
        .ok()
        .and_then(|counts| counts.get(run_id).copied())
        .unwrap_or(0);
    metadata.action_counts.notification = metadata.action_counts.notification.max(delivery_count);
    Ok(metadata)
}

pub(crate) fn append_ai_usage_summary_event(
    events: &mut Vec<Value>,
    provider: &str,
    model_id: &str,
    model: &str,
    model_name: &str,
) -> AiUsageSummary {
    let summary = build_ai_usage_summary(events, provider, model_id, model, model_name);
    events.push(json!({
        "__desicUsageSummary": summary,
        "type": "usageSummary"
    }));
    summary
}

pub(crate) fn persist_ai_message_usage_summary(
    conn: &Connection,
    message_id: &str,
    summary: &AiUsageSummary,
) -> Result<(), String> {
    conn.execute(
        "UPDATE ai_messages
         SET token_usage_json=?2,token_usage_version=?3
         WHERE id=?1",
        params![message_id, to_json(summary)?, AI_USAGE_SCHEMA_VERSION],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn rebuild_ai_message_usage_summary(tool_json: Option<&str>) -> AiUsageSummary {
    let events = tool_json
        .and_then(|value| serde_json::from_str::<Vec<Value>>(value).ok())
        .unwrap_or_default();
    parse_ai_usage_summary_events(&events).unwrap_or_else(|| {
        build_ai_usage_summary(&events, "unknown", "unknown", "unknown", "历史记录")
    })
}

fn persist_rebuilt_ai_usage_rows(
    conn: &mut Connection,
    rows: Vec<(String, Option<String>)>,
) -> Result<(), String> {
    if rows.is_empty() {
        return Ok(());
    }
    let rebuilt = rows
        .into_iter()
        .map(|(id, tool_json)| {
            let summary = rebuild_ai_message_usage_summary(tool_json.as_deref());
            to_json(&summary).map(|summary_json| (id, summary_json))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    {
        let mut statement = tx
            .prepare(
                "UPDATE ai_messages
                 SET token_usage_json=?2,token_usage_version=?3
                 WHERE id=?1 AND token_usage_version<?3",
            )
            .map_err(|error| error.to_string())?;
        for (id, summary_json) in rebuilt {
            statement
                .execute(params![id, summary_json, AI_USAGE_SCHEMA_VERSION])
                .map_err(|error| error.to_string())?;
        }
    }
    tx.commit().map_err(|error| error.to_string())
}

pub(crate) fn ensure_ai_message_usage_for_session(
    conn: &mut Connection,
    session_id: &str,
) -> Result<(), String> {
    let rows = {
        let mut statement = conn
            .prepare(
                "SELECT id,tool_json FROM ai_messages
                 WHERE session_id=?1 AND role='assistant' AND token_usage_version<?2
                 ORDER BY created_at ASC",
            )
            .map_err(|error| error.to_string())?;
        let collected = statement
            .query_map(params![session_id, AI_USAGE_SCHEMA_VERSION], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        collected
    };
    persist_rebuilt_ai_usage_rows(conn, rows)
}

fn ensure_ai_message_usage_since(conn: &mut Connection, since: i64) -> Result<(), String> {
    let rows = {
        let mut statement = conn
            .prepare(
                "SELECT id,tool_json FROM ai_messages
                 WHERE role='assistant' AND created_at>=?1 AND token_usage_version<?2
                 ORDER BY created_at ASC",
            )
            .map_err(|error| error.to_string())?;
        let collected = statement
            .query_map(params![since, AI_USAGE_SCHEMA_VERSION], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        collected
    };
    persist_rebuilt_ai_usage_rows(conn, rows)
}

fn parse_run_metadata(tool_json: &str) -> RunMetadata {
    let events = serde_json::from_str::<Vec<Value>>(tool_json).unwrap_or_default();
    let token_usage = parse_ai_usage_summary_events(&events).unwrap_or_else(|| {
        build_ai_usage_summary(&events, "unknown", "unknown", "unknown", "历史记录")
    });
    RunMetadata {
        action_counts: parse_run_action_counts_events(&events),
        token_usage: Some(token_usage),
    }
}

fn parse_ai_usage_summary_events(events: &[Value]) -> Option<AiUsageSummary> {
    let stored_summary = events
        .iter()
        .rev()
        .find_map(|event| event.get("__desicUsageSummary"))
        .and_then(|value| serde_json::from_value::<AiUsageSummary>(value.clone()).ok());
    if let Some(summary) = stored_summary.as_ref() {
        if summary.schema_version >= AI_USAGE_SCHEMA_VERSION {
            return Some(summary.clone());
        }
    }
    let summary = stored_summary.as_ref();
    let rebuilt = build_ai_usage_summary(
        events,
        summary
            .map(|item| item.provider.as_str())
            .unwrap_or("unknown"),
        summary
            .map(|item| item.model_id.as_str())
            .unwrap_or("unknown"),
        summary.map(|item| item.model.as_str()).unwrap_or("unknown"),
        summary
            .map(|item| item.model_name.as_str())
            .unwrap_or("历史记录"),
    );
    if rebuilt.reported || stored_summary.is_some() {
        Some(rebuilt)
    } else {
        None
    }
}

fn parse_ai_usage_summary(tool_json: &str) -> Option<AiUsageSummary> {
    let events = serde_json::from_str::<Vec<Value>>(tool_json).ok()?;
    parse_ai_usage_summary_events(&events)
}

fn parse_run_action_counts(tool_json: &str) -> AiAgentRunActionCounts {
    let events = serde_json::from_str::<Vec<Value>>(tool_json).unwrap_or_default();
    parse_run_action_counts_events(&events)
}

fn parse_run_action_counts_events(events: &[Value]) -> AiAgentRunActionCounts {
    let mut counts = AiAgentRunActionCounts::default();
    let internal_tool_call_ids = events
        .iter()
        .filter(|event| {
            event.get("type").and_then(Value::as_str) == Some("toolCall")
                && event.get("policy").and_then(Value::as_str) == Some("rust:tool-execute-request")
        })
        .filter_map(|event| event.get("toolCallId").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<HashSet<_>>();
    let mut results: HashMap<String, Value> = HashMap::new();
    for event in events {
        if event.get("type").and_then(Value::as_str) == Some("toolResult") {
            if let Some(tool_call_id) = event.get("toolCallId").and_then(Value::as_str) {
                if internal_tool_call_ids.contains(tool_call_id) {
                    continue;
                }
                results.insert(tool_call_id.to_string(), event.clone());
            }
        }
    }
    for (index, event) in events.iter().enumerate() {
        if event.get("type").and_then(Value::as_str) != Some("toolCall") {
            continue;
        }
        let Some(name) = event.get("name").and_then(Value::as_str) else {
            continue;
        };
        let tool_call_id = event
            .get("toolCallId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("{name}-{index}"));
        if internal_tool_call_ids.contains(&tool_call_id) {
            continue;
        }
        let blocked = event
            .get("blocked")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let result_ok = results
            .get(&tool_call_id)
            .and_then(|value| value.get("ok"))
            .and_then(Value::as_bool)
            .unwrap_or(!blocked);
        if blocked || !result_ok {
            continue;
        }
        match name {
            "tradeOpportunity.create" => counts.opportunity = counts.opportunity.saturating_add(1),
            "background.finishRun" => {
                let conditions = event
                    .get("arguments")
                    .and_then(|value| value.get("nextWakePlan"))
                    .and_then(|value| value.get("conditions"))
                    .and_then(Value::as_array)
                    .map(|items| items.len() as u32)
                    .unwrap_or(0);
                counts.wake = counts.wake.saturating_add(conditions);
            }
            "notification.feishu.send" => {
                counts.notification = counts.notification.saturating_add(1)
            }
            "trade.placeOrder"
            | "trade.cancelOrder"
            | "trade.amendOrder"
            | "trade.closePosition"
            | "trade.setLeverage"
            | "trade.setMarginMode"
            | "order.create"
            | "order.cancel"
            | "okx.placeOrder"
            | "okx.cancelOrder"
            | "okx.amendOrder"
            | "okx.closePosition"
            | "okx.setLeverage"
            | "okx.setMarginMode" => {
                counts.trade = counts.trade.saturating_add(1);
            }
            _ => {}
        }
    }
    counts
}

fn parse_background_finish_failure(tool_json: &str) -> Option<String> {
    let events = serde_json::from_str::<Vec<Value>>(tool_json).ok()?;
    let finish_call_ids = events
        .iter()
        .filter(|event| {
            event.get("type").and_then(Value::as_str) == Some("toolCall")
                && event.get("name").and_then(Value::as_str) == Some("background.finishRun")
        })
        .filter_map(|event| event.get("toolCallId").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    if finish_call_ids.is_empty() {
        return None;
    }
    let result_event = events.iter().rev().find(|event| {
        event.get("type").and_then(Value::as_str) == Some("toolResult")
            && event
                .get("toolCallId")
                .and_then(Value::as_str)
                .is_some_and(|id| finish_call_ids.contains(id))
    });
    let Some(result_event) = result_event else {
        return Some("background.finishRun 调用未返回结果".to_string());
    };
    let result = result_event.get("result").unwrap_or(result_event);
    let completed = result.get("accepted").and_then(Value::as_bool) == Some(true)
        || result.get("executed").and_then(Value::as_bool) == Some(true);
    if completed {
        return None;
    }
    let mut details = result
        .get("errors")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if details.is_empty() {
        for key in ["error", "correction", "summary"] {
            if let Some(value) = result.get(key).and_then(Value::as_str).map(str::trim) {
                if !value.is_empty() {
                    details.push(value.to_string());
                    break;
                }
            }
        }
    }
    Some(if details.is_empty() {
        "background.finishRun 调用未完成".to_string()
    } else {
        format!("background.finishRun 未完成：{}", details.join("；"))
    })
}

fn load_background_finish_failure(conn: &Connection, run_id: &str) -> Option<String> {
    let session_id = format!("background:{run_id}");
    conn.query_row(
        "SELECT tool_json FROM ai_messages
         WHERE session_id=?1 AND role='assistant' AND tool_json IS NOT NULL
         ORDER BY created_at DESC LIMIT 1",
        params![session_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .and_then(|tool_json| parse_background_finish_failure(&tool_json))
}

fn load_wake_conditions(
    conn: &Connection,
    limit: i64,
) -> Result<Vec<AiWakeConditionSummary>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,profile_id,source,plan_mode,condition_type,config_json,status,expires_at,last_triggered_at,created_at
             FROM ai_wake_conditions ORDER BY created_at DESC LIMIT ?1",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![limit], |row| {
            let config: String = row.get(5)?;
            Ok(AiWakeConditionSummary {
                id: row.get(0)?,
                profile_id: row.get(1)?,
                source: row.get(2)?,
                plan_mode: row.get(3)?,
                condition_type: row.get(4)?,
                config: serde_json::from_str(&config).unwrap_or_else(|_| json!({})),
                status: row.get(6)?,
                expires_at: row.get(7)?,
                last_triggered_at: row.get(8)?,
                created_at: row.get(9)?,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn load_wake_condition(conn: &Connection, id: &str) -> Result<AiWakeConditionSummary, String> {
    conn.query_row(
        "SELECT id,profile_id,source,plan_mode,condition_type,config_json,status,expires_at,last_triggered_at,created_at
         FROM ai_wake_conditions WHERE id=?1",
        params![id],
        |row| {
            let config: String = row.get(5)?;
            Ok(AiWakeConditionSummary {
                id: row.get(0)?,
                profile_id: row.get(1)?,
                source: row.get(2)?,
                plan_mode: row.get(3)?,
                condition_type: row.get(4)?,
                config: serde_json::from_str(&config).unwrap_or_else(|_| json!({})),
                status: row.get(6)?,
                expires_at: row.get(7)?,
                last_triggered_at: row.get(8)?,
                created_at: row.get(9)?,
            })
        },
    )
    .map_err(|err| err.to_string())
}

fn load_reviews(conn: &Connection, limit: i64) -> Result<Vec<AiTradeReviewSummary>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,episode_id,status,summary,findings_json,suggestions_json,net_pnl,created_at,updated_at
             FROM ai_trade_reviews ORDER BY created_at DESC LIMIT ?1",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![limit], |row| {
            let findings: String = row.get(4)?;
            let suggestions: String = row.get(5)?;
            Ok(AiTradeReviewSummary {
                id: row.get(0)?,
                episode_id: row.get(1)?,
                status: row.get(2)?,
                summary: row.get(3)?,
                findings: from_json_or_default(&findings),
                suggestions: from_json_or_default(&suggestions),
                net_pnl: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn load_daily_market_reviews(
    conn: &Connection,
    limit: i64,
) -> Result<Vec<AiDailyMarketReviewSummary>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT r.id,r.profile_id,p.name,r.review_date,r.status,r.symbols_json,r.summary,
                    r.error,r.run_id,r.created_at,r.updated_at
             FROM ai_daily_market_reviews r
             LEFT JOIN ai_agent_profiles p ON p.id=r.profile_id
             ORDER BY r.review_date DESC,r.updated_at DESC LIMIT ?1",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![limit], |row| {
            let symbols: String = row.get(5)?;
            Ok(AiDailyMarketReviewSummary {
                id: row.get(0)?,
                profile_id: row.get(1)?,
                profile_name: row
                    .get::<_, Option<String>>(2)?
                    .unwrap_or_else(|| "已删除 Profile".to_string()),
                review_date: row.get(3)?,
                status: row.get(4)?,
                symbols: from_json_or_default(&symbols),
                summary: row.get(6)?,
                error: row.get(7)?,
                run_id: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn load_optimization_suggestions(
    conn: &Connection,
    limit: i64,
) -> Result<Vec<AiOptimizationSuggestionSummary>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,review_id,title,problem,evidence_json,sample_size,current_skill_id,current_skill_version,
             proposed_changes,
             (SELECT content FROM ai_skill_versions v
               WHERE v.skill_id=ai_optimization_suggestions.current_skill_id
                 AND v.version=ai_optimization_suggestions.current_skill_version
                 AND v.status='published' LIMIT 1),
             proposed_skill_json,benefits,risks,status,created_at,updated_at
             FROM ai_optimization_suggestions ORDER BY created_at DESC LIMIT ?1",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![limit], optimization_suggestion_from_row)
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn load_optimization_suggestion(
    conn: &Connection,
    id: &str,
) -> Result<AiOptimizationSuggestionSummary, String> {
    conn.query_row(
        "SELECT id,review_id,title,problem,evidence_json,sample_size,current_skill_id,current_skill_version,
         proposed_changes,
         (SELECT content FROM ai_skill_versions v
           WHERE v.skill_id=ai_optimization_suggestions.current_skill_id
             AND v.version=ai_optimization_suggestions.current_skill_version
             AND v.status='published' LIMIT 1),
         proposed_skill_json,benefits,risks,status,created_at,updated_at
         FROM ai_optimization_suggestions WHERE id=?1",
        params![id],
        optimization_suggestion_from_row,
    )
    .map_err(|err| err.to_string())
}

fn optimization_suggestion_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<AiOptimizationSuggestionSummary> {
    let evidence: String = row.get(4)?;
    let baseline_skill: Option<String> = row.get(9)?;
    let proposed_skill: Option<String> = row.get(10)?;
    Ok(AiOptimizationSuggestionSummary {
        id: row.get(0)?,
        review_id: row.get(1)?,
        title: row.get(2)?,
        problem: row.get(3)?,
        evidence: from_json_or_default(&evidence),
        sample_size: row.get::<_, i64>(5)?.max(0) as u32,
        current_skill_id: row.get(6)?,
        current_skill_version: row
            .get::<_, Option<i64>>(7)?
            .map(|value| value.max(1) as u32),
        proposed_changes: row.get(8)?,
        baseline_skill: baseline_skill.and_then(|value| serde_json::from_str(&value).ok()),
        proposed_skill: proposed_skill.and_then(|value| serde_json::from_str(&value).ok()),
        benefits: row.get(11)?,
        risks: row.get(12)?,
        status: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    })
}

fn load_notification_deliveries(
    conn: &Connection,
    limit: i64,
) -> Result<Vec<AiNotificationDeliverySummary>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT d.id,d.channel,d.status,d.title,d.content,d.level,d.profile_id,p.name,d.run_id,
                    d.related_type,d.related_id,d.error,d.created_at,d.sent_at
             FROM ai_notification_deliveries d
             LEFT JOIN ai_agent_profiles p ON p.id=d.profile_id
             WHERE COALESCE(d.related_type, '') NOT IN ('systematic_profile_signal', 'strategy_signal')
             ORDER BY d.created_at DESC LIMIT ?1",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![limit], |row| {
            Ok(AiNotificationDeliverySummary {
                id: row.get(0)?,
                channel: row.get(1)?,
                status: row.get(2)?,
                title: row.get(3)?,
                content: row.get(4)?,
                level: row.get(5)?,
                profile_id: row.get(6)?,
                profile_name: row.get(7)?,
                run_id: row.get(8)?,
                related_type: row.get(9)?,
                related_id: row.get(10)?,
                error: row.get(11)?,
                created_at: row.get(12)?,
                sent_at: row.get(13)?,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn load_skill_versions(
    conn: &Connection,
    limit: i64,
) -> Result<Vec<AiSkillVersionSummary>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,skill_id,version,status,content,source_suggestion_id,created_at,published_at
             FROM ai_skill_versions ORDER BY skill_id ASC,version DESC LIMIT ?1",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![limit], skill_version_from_row)
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn load_skill_version(conn: &Connection, id: &str) -> Result<AiSkillVersionSummary, String> {
    conn.query_row(
        "SELECT id,skill_id,version,status,content,source_suggestion_id,created_at,published_at
         FROM ai_skill_versions WHERE id=?1",
        params![id],
        skill_version_from_row,
    )
    .map_err(|err| err.to_string())
}

fn skill_version_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiSkillVersionSummary> {
    let skill_id: String = row.get(1)?;
    let content: String = row.get(4)?;
    let definition = serde_json::from_str::<Value>(&content).unwrap_or_else(|_| {
        json!({
            "id": skill_id,
            "name": skill_id,
            "description": "历史 Skill 版本",
            "rules": "",
            "content": content,
            "builtin": false
        })
    });
    Ok(AiSkillVersionSummary {
        id: row.get(0)?,
        skill_id,
        version: row.get::<_, i64>(2)?.max(1) as u32,
        status: row.get(3)?,
        definition,
        source_suggestion_id: row.get(5)?,
        created_at: row.get(6)?,
        published_at: row.get(7)?,
    })
}

fn template_snapshot_for_profile(
    conn: &Connection,
    profile: &AiAgentProfileSummary,
) -> Result<Option<Value>, String> {
    // v3：Agent 模板（`ai_agent_schemes`）命令层已删除；旧 Profile 引用的模板只在
    // Run 快照里留一份"当时是什么"，供历史回放阅读（不再参与运行）。
    let Some(scheme_id) = profile
        .legacy_multi_agent_scheme_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    else {
        return Ok(None);
    };
    let row = conn
        .query_row(
            "SELECT id,name,description,instructions FROM ai_agent_schemes WHERE id=?1",
            params![scheme_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|err| err.to_string())?;
    Ok(row.map(|(id, name, description, instructions)| {
        json!({
            "id": id,
            "name": name,
            "description": description,
            "builtin": false,
            "instructions": instructions,
            "capturedAt": now_ms()
        })
    }))
}

fn queue_run(
    conn: &Connection,
    profile_id: &str,
    trigger_type: &str,
    trigger: Value,
) -> Result<AiAgentRunSummary, String> {
    if let Some(existing) = conn
        .query_row(
            "SELECT id FROM ai_agent_runs WHERE profile_id=?1 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
            params![profile_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
    {
        return load_run(conn, &existing);
    }
    let profile = load_profile(conn, profile_id)?;
    let resolved_skill_versions = resolve_skill_versions(
        conn,
        &profile.skill_ids,
        &profile.skill_versions,
        &profile.skill_version_modes,
    )?;
    let mut run_profile = profile.clone();
    run_profile.skill_versions = resolved_skill_versions.clone();
    run_profile.skill_version_modes = resolved_skill_versions
        .keys()
        .map(|skill_id| (skill_id.clone(), "pinned".to_string()))
        .collect();
    let template_snapshot = template_snapshot_for_profile(conn, &run_profile)?;
    // C24.1：把**本次运行生效**的单 Agent 子模式冻进 run 行（协作开启 → standard）。
    let single_agent_mode = effective_single_agent_mode(
        run_profile.collaboration_enabled,
        Some(run_profile.single_agent_mode.as_str()),
    );
    let now = now_ms();
    let id = format!("run-{}", unique_suffix());
    let inserted = conn
        .execute(
            "INSERT OR IGNORE INTO ai_agent_runs(
          id,profile_id,trigger_type,status,trigger_json,profile_snapshot_json,template_snapshot_json,skill_versions_json,
          single_agent_mode,started_at,created_at,updated_at
         ) VALUES(?1,?2,?3,'queued',?4,?5,?6,?7,?8,?9,?9,?9)",
            params![
                id,
                profile_id,
                trigger_type,
                trigger.to_string(),
                to_json(&run_profile)?,
                 template_snapshot.as_ref().map(Value::to_string),
                to_json(&resolved_skill_versions)?,
                single_agent_mode,
                now,
            ],
        )
        .map_err(|err| err.to_string())?;
    if inserted == 0 {
        let existing = conn
            .query_row(
                "SELECT id FROM ai_agent_runs
                 WHERE profile_id=?1 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
                params![profile_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|err| err.to_string())?;
        return load_run(conn, &existing);
    }
    load_run(conn, &id)
}

fn previous_utc_date() -> String {
    chrono::Utc::now()
        .date_naive()
        .pred_opt()
        .unwrap_or_else(|| chrono::Utc::now().date_naive())
        .format("%Y-%m-%d")
        .to_string()
}

fn daily_review_window(review_date: &str) -> Result<(i64, i64), String> {
    let date = chrono::NaiveDate::parse_from_str(review_date, "%Y-%m-%d")
        .map_err(|_| "每日复盘日期格式无效".to_string())?;
    let start = date
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| "无法构造每日复盘开始时间".to_string())?;
    let end = date
        .succ_opt()
        .and_then(|value| value.and_hms_opt(0, 0, 0))
        .ok_or_else(|| "无法构造每日复盘结束时间".to_string())?;
    Ok((
        chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(start, chrono::Utc)
            .timestamp_millis(),
        chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(end, chrono::Utc)
            .timestamp_millis(),
    ))
}

fn load_daily_market_review(
    conn: &Connection,
    profile_id: &str,
    review_date: &str,
) -> Result<AiDailyMarketReviewSummary, String> {
    load_daily_market_reviews(conn, 500)?
        .into_iter()
        .find(|review| review.profile_id == profile_id && review.review_date == review_date)
        .ok_or_else(|| "每日市场复盘不存在".to_string())
}

fn queue_daily_market_review(
    conn: &Connection,
    profile: &AiAgentProfileSummary,
    review_date: &str,
    requested_by: &str,
) -> Result<AiDailyMarketReviewSummary, String> {
    if let Ok(existing) = load_daily_market_review(conn, &profile.id, review_date) {
        if matches!(existing.status.as_str(), "queued" | "running")
            || (existing.status == "completed" && requested_by != "manual")
        {
            return Ok(existing);
        }
    }
    let active = conn
        .query_row(
            "SELECT COUNT(*) FROM ai_agent_runs WHERE profile_id=?1 AND status IN ('queued','running')",
            params![profile.id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| err.to_string())?;
    if active > 0 {
        return Err("该 Profile 当前已有排队或运行中的任务，每日复盘会稍后重试".to_string());
    }
    let (window_start, window_end) = daily_review_window(review_date)?;
    let run = queue_run(
        conn,
        &profile.id,
        "daily_market_review",
        json!({
            "reviewDate": review_date,
            "windowStart": window_start,
            "windowEnd": window_end,
            "timezone": "UTC",
            "requestedBy": requested_by,
            "forcedPermissionMode": "advisor",
        }),
    )?;
    let now = now_ms();
    let id = format!("daily-review-{}-{}", profile.id, review_date);
    conn.execute(
        "INSERT INTO ai_daily_market_reviews(
           id,profile_id,review_date,status,symbols_json,summary,error,run_id,created_at,updated_at
         ) VALUES(?1,?2,?3,'queued',?4,'',NULL,?5,?6,?6)
         ON CONFLICT(profile_id,review_date) DO UPDATE SET
           status='queued',symbols_json=excluded.symbols_json,summary='',error=NULL,
           run_id=excluded.run_id,updated_at=excluded.updated_at",
        params![
            id,
            profile.id,
            review_date,
            to_json(&profile.symbols)?,
            run.id,
            now
        ],
    )
    .map_err(|err| err.to_string())?;
    load_daily_market_review(conn, &profile.id, review_date)
}

pub(crate) fn queue_intelligence_briefing_run(
    app: &tauri::AppHandle,
    profile_id: &str,
    briefing_id: &str,
    briefing_date: &str,
) -> Result<AiAgentRunSummary, String> {
    let conn = open_automation_database(app)?;
    let profile = load_profile(&conn, profile_id)?;
    for required in ["okx-market-intelligence"] {
        if !profile
            .skill_ids
            .iter()
            .any(|skill_id| skill_id == required)
        {
            return Err(format!("市场简报 Profile 必须固定启用 {required}"));
        }
    }
    let active: i64 = conn.query_row(
        "SELECT COUNT(*) FROM ai_agent_runs WHERE profile_id=?1 AND status IN ('queued','running')",
        params![profile_id], |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    if active > 0 {
        return Err("该 Agent Profile 当前已有排队或运行中的任务，无法生成市场简报".to_string());
    }
    queue_run(
        &conn,
        profile_id,
        "intelligence_briefing",
        json!({
            "briefingId": briefing_id,
            "briefingDate": briefing_date,
            "forcedPermissionMode": "advisor",
        }),
    )
}

fn load_feishu_config(conn: &Connection) -> FeishuConfigSummary {
    let value = load_setting(conn, "feishu_config").unwrap_or_else(|| json!({}));
    let webhook = load_notification_webhook().unwrap_or_default();
    FeishuConfigSummary {
        enabled: value
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        configured: !webhook.trim().is_empty(),
        webhook_masked: mask_webhook(&webhook),
        event_types: normalized_feishu_event_types(&value),
    }
}

fn normalized_feishu_event_types(value: &Value) -> Vec<String> {
    let mut event_types = value
        .get("eventTypes")
        .cloned()
        .and_then(|item| serde_json::from_value::<Vec<String>>(item).ok())
        .map(normalize_strings)
        .unwrap_or_default();
    // `strategy_signal` was added after the original Feishu settings shape.
    // Treat an unversioned non-empty list as that legacy shape so existing
    // users do not silently lose Profile signal delivery after an upgrade.
    if value
        .get("eventTypesVersion")
        .and_then(Value::as_i64)
        .is_none()
        && !event_types.is_empty()
        && !event_types
            .iter()
            .any(|event_type| event_type == FEISHU_STRATEGY_SIGNAL_EVENT)
    {
        event_types.push(FEISHU_STRATEGY_SIGNAL_EVENT.to_string());
    }
    event_types
}

fn validate_feishu_webhook(value: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(value).map_err(|_| "飞书 Webhook URL 格式不正确".to_string())?;
    let valid = url.scheme() == "https"
        && url.host_str() == Some("open.feishu.cn")
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.query().is_none()
        && url
            .path()
            .strip_prefix("/open-apis/bot/v2/hook/")
            .is_some_and(|token| !token.is_empty() && !token.contains('/'));
    if !valid {
        return Err("飞书 Webhook URL 格式不正确".to_string());
    }
    Ok(())
}

fn mask_webhook(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    let tail = value
        .chars()
        .rev()
        .take(6)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("https://open.feishu.cn/***{}", tail)
}

fn normalize_suggestion_status(value: &str) -> Result<&'static str, String> {
    match value.trim() {
        "pending" | "pending_review" => Ok("pending_review"),
        "validating" | "validation" => Ok("validating"),
        "ready" => Ok("ready"),
        "applied" => Ok("applied"),
        "rejected" => Ok("rejected"),
        _ => Err("未知的优化建议状态".to_string()),
    }
}

fn ensure_skill_versions(app: &tauri::AppHandle, conn: &Connection) -> Result<(), String> {
    let _config_write_guard = crate::storage_config::lock_ai_config_writes()?;
    let config = match crate::storage_config::load_ai_config_locked(app) {
        Ok(config) => config,
        Err(error) if error.starts_with("AI config not found:") => return Ok(()),
        Err(error) => return Err(format!("加载 AI 配置失败：{}", error)),
    };
    // Skill 相关步骤为尽力而为：Windows 上曾因内置 Skill 包安装的 io 错误导致
    // AI 自动化面板整体不可用（前端报 ai_automation_summary / overview 失败）。缺失只记录日志。
    if let Err(error) = crate::storage_config::ensure_builtin_skill_bundles() {
        crate::boot_log(&format!(
            "ensure_skill_versions: builtin skill bundles failed: {error}"
        ));
    }
    let skill_files_fingerprint = match ai_skill_files_fingerprint(&config) {
        Ok(value) => value,
        Err(error) => {
            crate::boot_log(&format!(
                "ensure_skill_versions: skill files fingerprint failed: {error}"
            ));
            return Ok(());
        }
    };
    let stored_fingerprint = load_setting(conn, SKILL_FILES_FINGERPRINT_SETTING)
        .and_then(|value| value.as_str().map(str::to_string));
    let mut skill_files_synced = false;
    if stored_fingerprint.as_deref() != Some(skill_files_fingerprint.as_str()) {
        if let Err(error) = crate::storage_config::sync_cline_skill_files_from_config(&config) {
            crate::boot_log(&format!(
                "ensure_skill_versions: skill file sync failed: {error}"
            ));
            return Ok(());
        }
        set_setting(
            conn,
            SKILL_FILES_FINGERPRINT_SETTING,
            Value::String(skill_files_fingerprint),
        )?;
        skill_files_synced = true;
    }
    for skill in &config.skill_definitions {
        if skill.id.trim().is_empty() {
            continue;
        }
        let content = serde_json::to_string(&skill).map_err(|err| err.to_string())?;
        if let Some(draft_id) = find_matching_newer_skill_draft(conn, &skill.id, &content)? {
            if !skill_files_synced {
                crate::storage_config::sync_cline_skill_files_from_config(&config)?;
                skill_files_synced = true;
            }
            let changed = conn
                .execute(
                    "UPDATE ai_skill_versions SET status='published',published_at=?2
                     WHERE id=?1 AND status='draft'",
                    params![draft_id, now_ms()],
                )
                .map_err(|err| err.to_string())?;
            if changed == 1 {
                continue;
            }
        }
        if latest_published_skill_content_matches(conn, &skill.id, &content)? {
            continue;
        }
        if !skill_files_synced {
            crate::storage_config::sync_cline_skill_files_from_config(&config)?;
            skill_files_synced = true;
        }
        insert_published_skill_version_if_changed(conn, &skill.id, &content, now_ms())?;
    }
    Ok(())
}

fn ai_skill_files_fingerprint(config: &desic_storage_config::AiConfig) -> Result<String, String> {
    let payload = serde_json::to_vec(&json!({
        "enabledSkills": &config.enabled_skills,
        "skillDefinitions": &config.skill_definitions,
    }))
    .map_err(|err| err.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(payload);
    Ok(format!("{:x}", hasher.finalize()))
}

fn latest_published_skill_content_matches(
    conn: &Connection,
    skill_id: &str,
    content: &str,
) -> Result<bool, String> {
    let latest = conn
        .query_row(
            "SELECT content FROM ai_skill_versions
             WHERE skill_id=?1 AND status='published'
             ORDER BY version DESC LIMIT 1",
            params![skill_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    Ok(latest.as_deref() == Some(content))
}

fn find_matching_newer_skill_draft(
    conn: &Connection,
    skill_id: &str,
    content: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT id FROM ai_skill_versions
         WHERE skill_id=?1 AND status='draft' AND content=?2
           AND version>COALESCE((
             SELECT MAX(version) FROM ai_skill_versions
             WHERE skill_id=?1 AND status='published'
           ),0)
         ORDER BY version DESC LIMIT 1",
        params![skill_id, content],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn insert_published_skill_version_if_changed(
    conn: &Connection,
    skill_id: &str,
    content: &str,
    now: i64,
) -> Result<bool, String> {
    let changed = conn
        .execute(
            "INSERT INTO ai_skill_versions(
               id,skill_id,version,status,content,created_at,published_at
             )
             SELECT ?1,?2,
                    COALESCE((SELECT MAX(version) FROM ai_skill_versions WHERE skill_id=?2),0)+1,
                    'published',?3,?4,?4
             WHERE NOT EXISTS (
               SELECT 1 FROM ai_skill_versions
               WHERE skill_id=?2 AND status='published' AND content=?3
                 AND version=(
                   SELECT MAX(version) FROM ai_skill_versions
                   WHERE skill_id=?2 AND status='published'
                 )
             )",
            params![
                format!("skill-version-{}", unique_suffix()),
                skill_id,
                content,
                now
            ],
        )
        .map_err(|err| err.to_string())?;
    Ok(changed == 1)
}

fn resolve_skill_versions(
    conn: &Connection,
    skill_ids: &[String],
    requested: &HashMap<String, u32>,
    modes: &HashMap<String, String>,
) -> Result<HashMap<String, u32>, String> {
    let mut pinned = HashMap::new();
    for skill_id in skill_ids {
        let requested_version = modes
            .get(skill_id)
            .filter(|mode| mode.as_str() == "pinned")
            .and_then(|_| requested.get(skill_id))
            .copied()
            .filter(|version| *version > 0);
        let version = if let Some(version) = requested_version {
            let exists = conn
                .query_row(
                    "SELECT COUNT(*) FROM ai_skill_versions
                     WHERE skill_id=?1 AND version=?2 AND status='published'",
                    params![skill_id, i64::from(version)],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|err| err.to_string())?;
            if exists != 1 {
                return Err(format!(
                    "Skill {} 的已发布版本 {} 不存在",
                    skill_id, version
                ));
            }
            version
        } else {
            conn.query_row(
                "SELECT version FROM ai_skill_versions
                 WHERE skill_id=?1 AND status='published' ORDER BY version DESC LIMIT 1",
                params![skill_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|err| err.to_string())?
            .map(|version| version.max(1) as u32)
            .ok_or_else(|| format!("Skill {} 没有可用的已发布版本", skill_id))?
        };
        pinned.insert(skill_id.clone(), version);
    }
    Ok(pinned)
}

fn resolve_profile_skill_snapshot(
    app: &tauri::AppHandle,
    profile: &mut AiAgentProfileSummary,
) -> Result<Vec<desic_storage_config::AiSkillDefinition>, String> {
    let conn = open_automation_database(app)?;
    ensure_skill_versions(app, &conn)?;
    let pinned = resolve_skill_versions(
        &conn,
        &profile.skill_ids,
        &profile.skill_versions,
        &profile.skill_version_modes,
    )?;
    profile.skill_versions = pinned.clone();
    profile.skill_version_modes = pinned
        .keys()
        .map(|skill_id| (skill_id.clone(), "pinned".to_string()))
        .collect();
    let config = load_ai_config(app)?;
    let mut definitions = config
        .skill_definitions
        .into_iter()
        .filter(|skill| skill.id == "desic-core-operations")
        .collect::<Vec<_>>();
    for skill_id in profile
        .skill_ids
        .iter()
        .filter(|skill_id| skill_id.as_str() != "desic-core-operations")
    {
        let version = pinned
            .get(skill_id)
            .copied()
            .ok_or_else(|| format!("Skill {} 未固定版本", skill_id))?;
        let content = conn
            .query_row(
                "SELECT content FROM ai_skill_versions
                 WHERE skill_id=?1 AND version=?2 AND status='published'",
                params![skill_id, i64::from(version)],
                |row| row.get::<_, String>(0),
            )
            .map_err(|err| err.to_string())?;
        let snapshot = if let Ok(snapshot) =
            serde_json::from_str::<desic_storage_config::AiSkillDefinition>(&content)
        {
            snapshot
        } else {
            // 兼容早期仅保存正文的版本；新版本都会保存完整 Skill JSON。
            desic_storage_config::AiSkillDefinition {
                id: skill_id.clone(),
                name: skill_id.clone(),
                description: format!("固定的历史 Skill {} v{}", skill_id, version),
                rules: String::new(),
                content,
                builtin: false,
                bundle: None,
            }
        };
        if let Some(existing) = definitions.iter_mut().find(|item| item.id == *skill_id) {
            *existing = snapshot;
        } else {
            definitions.push(snapshot);
        }
    }
    Ok(definitions)
}

fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn to_json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|err| err.to_string())
}

fn from_json_or_default<T: serde::de::DeserializeOwned + Default>(value: &str) -> T {
    serde_json::from_str(value).unwrap_or_default()
}

pub(crate) fn unique_suffix() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos().to_string())
        .unwrap_or_else(|_| now_ms().to_string())
}

pub(crate) async fn notification_feishu_send(
    app: tauri::AppHandle,
    input: FeishuSendInput,
) -> Result<AiNotificationDeliverySummary, String> {
    send_feishu_delivery(app, input, true, Some("agent_message")).await
}

fn feishu_header_template(level: &str) -> &'static str {
    match level.trim().to_ascii_lowercase().as_str() {
        "warning" => "orange",
        "success" => "green",
        "error" => "red",
        "trade" => "purple",
        _ => "blue",
    }
}

fn feishu_markdown_card(input: &FeishuSendInput) -> Value {
    json!({
        "msg_type": "interactive",
        "card": {
            "schema": "2.0",
            "config": {
                "update_multi": true,
                "style": {
                    "text_size": {
                        "normal_v2": {
                            "default": "normal",
                            "pc": "normal",
                            "mobile": "normal"
                        }
                    }
                }
            },
            "header": {
                "title": {
                    "tag": "plain_text",
                    "content": input.title
                },
                "subtitle": {
                    "tag": "plain_text",
                    "content": format!("Desic Terminal · {}", input.level.to_ascii_uppercase())
                },
                "template": feishu_header_template(&input.level),
                "padding": "12px 12px 12px 12px"
            },
            "body": {
                "direction": "vertical",
                "padding": "12px 12px 12px 12px",
                "elements": [{
                    "tag": "markdown",
                    "content": input.content,
                    "text_align": "left",
                    "text_size": "normal_v2",
                    "margin": "0px 0px 0px 0px"
                }]
            }
        }
    })
}

async fn send_feishu_delivery(
    app: tauri::AppHandle,
    mut input: FeishuSendInput,
    require_enabled: bool,
    event_type: Option<&str>,
) -> Result<AiNotificationDeliverySummary, String> {
    input.title = input.title.trim().to_string();
    input.content = input.content.trim().to_string();
    if input.title.is_empty() || input.content.is_empty() {
        return Err("飞书通知标题和内容不能为空".to_string());
    }
    let conn = open_automation_database(&app)?;
    let config = load_feishu_config(&conn);
    let event_disabled = require_enabled
        && !config.event_types.is_empty()
        && event_type
            .is_some_and(|event| !config.event_types.iter().any(|allowed| allowed == event));
    let delivery_id = format!("delivery-{}", unique_suffix());
    let created_at = now_ms();
    let profile_id = input
        .agent_profile_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let run_id = input
        .agent_run_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    conn.execute(
        "INSERT INTO ai_notification_deliveries(
          id,channel,status,title,content,level,profile_id,run_id,related_type,related_id,created_at
        ) VALUES(?1,'feishu','pending',?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            delivery_id,
            input.title,
            input.content,
            input.level,
            profile_id,
            run_id,
            input.related_type,
            input.related_id,
            created_at,
        ],
    )
    .map_err(|err| err.to_string())?;

    if event_disabled {
        return fail_delivery(
            &app,
            &conn,
            &delivery_id,
            &format!(
                "FEISHU_EVENT_DISABLED: 当前配置未允许事件类型 {}",
                event_type.unwrap_or("unknown")
            ),
            false,
        );
    }

    if require_enabled {
        if let Some(profile_id) = input
            .agent_profile_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            match load_profile(&conn, profile_id) {
                Ok(profile) if !profile.feishu_enabled => {
                    return fail_delivery(
                        &app,
                        &conn,
                        &delivery_id,
                        "FEISHU_PROFILE_DISABLED: 当前 Profile 未开启飞书通知",
                        false,
                    );
                }
                Err(err) => {
                    return fail_delivery(
                        &app,
                        &conn,
                        &delivery_id,
                        &format!("FEISHU_PROFILE_NOT_FOUND: {}", err),
                        false,
                    );
                }
                _ => {}
            }
        }
    }

    if require_enabled && !config.enabled {
        return fail_delivery(
            &app,
            &conn,
            &delivery_id,
            "FEISHU_DISABLED: 飞书通知未启用",
            true,
        );
    }
    let webhook = load_notification_webhook().unwrap_or_default();
    if webhook.trim().is_empty() {
        return fail_delivery(
            &app,
            &conn,
            &delivery_id,
            "FEISHU_NOT_CONFIGURED: 请先在 AI 自动化设置中配置 Webhook URL",
            true,
        );
    }
    let body = feishu_markdown_card(&input);
    let client = reqwest_client()?;
    let mut last_error = String::new();
    for attempt in 0..3 {
        match client.post(&webhook).json(&body).send().await {
            Ok(response) => {
                let status = response.status();
                match response.json::<Value>().await {
                    Ok(payload) if status.is_success() && feishu_response_ok(&payload) => {
                        let sent_at = now_ms();
                        conn.execute(
                            "UPDATE ai_notification_deliveries SET status='sent',sent_at=?2,error=NULL WHERE id=?1",
                            params![delivery_id, sent_at],
                        )
                        .map_err(|err| err.to_string())?;
                        return load_notification_delivery(&conn, &delivery_id);
                    }
                    Ok(payload) => {
                        last_error = format!(
                            "飞书返回失败：HTTP {}，code={}，message={}",
                            status.as_u16(),
                            payload
                                .get("code")
                                .or_else(|| payload.get("StatusCode"))
                                .and_then(Value::as_i64)
                                .unwrap_or(-1),
                            payload
                                .get("msg")
                                .or_else(|| payload.get("StatusMessage"))
                                .and_then(Value::as_str)
                                .unwrap_or("unknown")
                        );
                    }
                    Err(err) => {
                        last_error = format!("飞书响应解析失败：{}", feishu_transport_error(&err));
                    }
                }
            }
            Err(err) => {
                last_error = format!("飞书请求失败：{}", feishu_transport_error(&err));
            }
        }
        if attempt < 2 {
            sleep(Duration::from_millis(500 * (attempt + 1) as u64)).await;
        }
    }
    let sanitized_error = sanitize_feishu_error(&last_error, &webhook);
    fail_delivery(&app, &conn, &delivery_id, &sanitized_error, false)
}

fn spawn_feishu_notification(
    app: &tauri::AppHandle,
    input: FeishuSendInput,
    event_type: &'static str,
) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = send_feishu_delivery(app, input, true, Some(event_type)).await;
    });
}

pub(crate) fn spawn_chart_alert_feishu(
    app: &tauri::AppHandle,
    title: String,
    content: String,
    related_id: String,
) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = send_feishu_delivery(
            app,
            FeishuSendInput {
                title,
                content,
                level: "warning".to_string(),
                related_type: Some("chart_alert".to_string()),
                related_id: Some(related_id),
                agent_profile_id: None,
                agent_run_id: None,
            },
            true,
            Some("chart_alert"),
        )
        .await;
    });
}

pub(crate) fn spawn_systematic_profile_signal_feishu(
    app: &tauri::AppHandle,
    profile_name: &str,
    inst_id: &str,
    action: &str,
    quantity: f64,
    reason: &str,
    status: &str,
    profile_id: &str,
) {
    let level = if status == "submitted" {
        "success"
    } else {
        "warning"
    };
    spawn_feishu_notification(
        app,
        FeishuSendInput {
            title: format!("策略信号 {}: {}", status, profile_name),
            content: format!(
                "**合约**：`{inst_id}`\n\n**动作**：`{action}`\n\n**数量**：`{quantity}` 张\n\n**原因**：{}",
                reason.chars().take(1_000).collect::<String>(),
            ),
            level: level.to_string(),
            related_type: Some("systematic_profile_signal".to_string()),
            related_id: Some(profile_id.to_string()),
            agent_profile_id: None,
            agent_run_id: None,
        },
        "strategy_signal",
    );
}

fn feishu_transport_error(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "请求超时"
    } else if error.is_connect() {
        "连接失败"
    } else if error.is_decode() {
        "响应格式无效"
    } else if error.is_request() {
        "请求构造失败"
    } else {
        "网络请求失败"
    }
}

fn sanitize_feishu_error(message: &str, webhook: &str) -> String {
    if webhook.trim().is_empty() {
        message.to_string()
    } else {
        message.replace(webhook, "[redacted-webhook]")
    }
}

fn feishu_response_ok(value: &Value) -> bool {
    value.get("code").and_then(Value::as_i64) == Some(0)
        || value.get("StatusCode").and_then(Value::as_i64) == Some(0)
}

fn fail_delivery<T>(
    app: &tauri::AppHandle,
    conn: &Connection,
    id: &str,
    message: &str,
    needs_configuration: bool,
) -> Result<T, String> {
    let _ = conn.execute(
        "UPDATE ai_notification_deliveries SET status='failed',error=?2 WHERE id=?1",
        params![id, message],
    );
    let _ = app.emit(
        AUTOMATION_EVENT,
        json!({
            "type": "notificationError",
            "message": message,
            "action": if needs_configuration {
                json!({ "settingsTab": "notifications" })
            } else {
                json!({ "tab": "notifications", "id": id })
            }
        }),
    );
    Err(message.to_string())
}

fn load_notification_delivery(
    conn: &Connection,
    id: &str,
) -> Result<AiNotificationDeliverySummary, String> {
    conn.query_row(
        "SELECT d.id,d.channel,d.status,d.title,d.content,d.level,d.profile_id,p.name,d.run_id,
                d.related_type,d.related_id,d.error,d.created_at,d.sent_at
         FROM ai_notification_deliveries d
         LEFT JOIN ai_agent_profiles p ON p.id=d.profile_id
         WHERE d.id=?1",
        params![id],
        |row| {
            Ok(AiNotificationDeliverySummary {
                id: row.get(0)?,
                channel: row.get(1)?,
                status: row.get(2)?,
                title: row.get(3)?,
                content: row.get(4)?,
                level: row.get(5)?,
                profile_id: row.get(6)?,
                profile_name: row.get(7)?,
                run_id: row.get(8)?,
                related_type: row.get(9)?,
                related_id: row.get(10)?,
                error: row.get(11)?,
                created_at: row.get(12)?,
                sent_at: row.get(13)?,
            })
        },
    )
    .map_err(|err| err.to_string())
}

#[derive(Debug, Clone)]
struct RunOpportunityFact {
    id: String,
    status: String,
    decision_context_id: Option<String>,
    account_id: Option<String>,
    environment: String,
    inst_id: String,
    resolution: String,
}

fn load_run_opportunity_facts(
    conn: &Connection,
    run_id: &str,
    profile_id: &str,
) -> Result<Vec<RunOpportunityFact>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id,status,decision_context_id,account_id,environment,inst_id
             FROM trade_opportunities
             WHERE agent_run_id=?1 AND agent_profile_id=?2
             ORDER BY created_at ASC,id ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![run_id, profile_id], |row| {
            Ok(RunOpportunityFact {
                id: row.get(0)?,
                status: row.get(1)?,
                decision_context_id: row.get(2)?,
                account_id: row.get(3)?,
                environment: row.get(4)?,
                inst_id: row.get(5)?,
                resolution: "create".to_string(),
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut rows = rows;
    let direct_ids = rows
        .iter()
        .map(|item| item.id.clone())
        .collect::<HashSet<_>>();
    let mut statement = conn
        .prepare(
            "SELECT DISTINCT o.id,o.status,
                    (SELECT c.id FROM ai_decision_contexts c
                     WHERE c.agent_run_id=e.agent_run_id AND c.agent_profile_id=?2
                       AND c.consumed_opportunity_id=o.id AND c.consumed_at IS NOT NULL
                     ORDER BY c.consumed_at DESC,c.id DESC LIMIT 1),
                    o.account_id,o.environment,o.inst_id
             FROM trade_opportunity_resolution_events e
             JOIN trade_opportunities o ON o.id=e.opportunity_id
             WHERE e.agent_run_id=?1 AND e.resolution='reuse'
             ORDER BY e.created_at ASC,o.id ASC",
        )
        .map_err(|error| error.to_string())?;
    let reused = statement
        .query_map(params![run_id, profile_id], |row| {
            Ok(RunOpportunityFact {
                id: row.get(0)?,
                status: row.get(1)?,
                decision_context_id: row.get(2)?,
                account_id: row.get(3)?,
                environment: row.get(4)?,
                inst_id: row.get(5)?,
                resolution: "reuse".to_string(),
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    rows.extend(
        reused
            .into_iter()
            .filter(|item| !direct_ids.contains(&item.id)),
    );
    Ok(rows)
}

fn final_decision_context_rows(
    conn: &Connection,
    run_id: &str,
    profile_id: &str,
    opportunities: &[RunOpportunityFact],
) -> Result<Vec<(String, Value)>, String> {
    if opportunities.iter().any(|item| {
        item.decision_context_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
    }) {
        return Err("后台交易机会缺少持久化最终复核，拒绝完成 Run".to_string());
    }
    let mut context_ids = opportunities
        .iter()
        .filter_map(|item| {
            item.decision_context_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .collect::<Vec<_>>();
    context_ids.sort();
    context_ids.dedup();
    if context_ids.is_empty() && opportunities.is_empty() {
        if let Some(context_id) = conn
            .query_row(
                "SELECT id FROM ai_decision_contexts
                 WHERE agent_run_id=?1 AND agent_profile_id=?2
                 ORDER BY captured_at DESC,id DESC LIMIT 1",
                params![run_id, profile_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
        {
            context_ids.push(context_id);
        }
    }

    let mut rows = Vec::with_capacity(context_ids.len());
    for context_id in context_ids {
        let snapshot_json = conn
            .query_row(
                "SELECT snapshot_json FROM ai_decision_contexts
                 WHERE id=?1 AND agent_run_id=?2 AND agent_profile_id=?3",
                params![context_id, run_id, profile_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("交易机会引用的最终复核不存在或不属于当前 Run：{context_id}"))?;
        let snapshot = serde_json::from_str::<Value>(&snapshot_json)
            .map_err(|error| format!("最终复核快照损坏：{error}"))?;
        rows.push((context_id, snapshot));
    }
    Ok(rows)
}
/// C19.4：一键"强制深度"的 trigger type。豁免 `skipTriageTriggers`（用户显式要求深度），
/// 直接以 `mode=off` 进入深度阶段。
pub(crate) const MANUAL_FORCE_DEEP_TRIGGER: &str = "manual_force_deep";

/// `background.reportTriage` 入参（C19.2）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundReportTriageInput {
    pub escalate: bool,
    #[serde(default)]
    pub reasons: Vec<String>,
    #[serde(default)]
    pub evidence: Vec<BackgroundTriageEvidenceInput>,
    /// skip 必须带（见 `validate_triage_report_input`）；escalate=true 时可省略。
    #[serde(default)]
    pub next_wake_plan: Option<BackgroundWakePlanInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundTriageEvidenceInput {
    #[serde(default)]
    pub fact: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub at: String,
}

/// C19.1：本次运行**生效**的试判配置。简报/复盘类 trigger 与手工强制深度直接豁免
/// （`mode=off`，不下发试判阶段、不设门）。
fn triage_config_for_run(
    config: &crate::ai_triage::AiAgentTriageConfig,
    trigger_type: &str,
) -> crate::ai_triage::AiAgentTriageConfig {
    let config = config.clone().normalized();
    if trigger_type == MANUAL_FORCE_DEEP_TRIGGER || config.skips_trigger(trigger_type) {
        return crate::ai_triage::AiAgentTriageConfig {
            mode: crate::ai_triage::TRIAGE_MODE_OFF.to_string(),
            ..config
        };
    }
    config
}

/// C19.2-3：`escalate=false` 必须带 `nextWakePlan`，否则视为未完成、不允许 skip
/// （保证不会因为判定跳过而失去后续唤醒）。
fn validate_triage_report_input(escalate: bool, has_next_wake_plan: bool) -> Result<(), String> {
    if !escalate && !has_next_wake_plan {
        return Err(
            "试判判定跳过（escalate=false）时必须给出 nextWakePlan（mode/conditions/expiresAt），否则不允许 skip"
                .to_string(),
        );
    }
    Ok(())
}

/// C19.3-1：硬升级输入里的保证金率有效性窗口 `0 < mgnRatio <= 100_000`（C19.1 补充）。
fn valid_margin_ratio(value: f64) -> bool {
    value.is_finite() && value > 0.0 && value <= crate::ai_triage::TRIAGE_MARGIN_RATIO_MAX_PCT
}

/// C19.2：采集硬升级输入。**只采后端数据**（唤醒条件行 + 运行触发载荷），
/// 不采信模型自述；拿不到的项进 `unavailable`（明确"不知道"而不是"没问题"）。
fn collect_triage_escalation_inputs(
    app: &tauri::AppHandle,
    conn: &Connection,
    context: &BackgroundRunContext,
    trigger: &Value,
    last_deep_at: Option<i64>,
) -> (crate::ai_triage::TriageEscalationInputs, Vec<String>) {
    let mut inputs = crate::ai_triage::TriageEscalationInputs::default();
    let mut unavailable = Vec::new();
    // 触发的唤醒条件行：本轮的"后端事实"来源。
    let condition_ids = trigger
        .get("conditionIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut condition_types = Vec::new();
    let mut configs = Vec::new();
    for condition_id in &condition_ids {
        let row = conn
            .query_row(
                "SELECT condition_type,config_json FROM ai_wake_conditions WHERE id=?1 AND profile_id=?2",
                params![condition_id, context.profile_id.clone().unwrap_or_default()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                    ))
                },
            )
            .optional()
            .ok()
            .flatten();
        if let Some((condition_type, config_json)) = row {
            let config = serde_json::from_str::<Value>(&config_json).unwrap_or(Value::Null);
            if !condition_types.contains(&condition_type) {
                condition_types.push(condition_type);
            }
            configs.push(config);
        }
    }
    let has_type = |needle: &str| condition_types.iter().any(|item| item == needle);
    let config_true = |key: &str| {
        configs.iter().any(|config| {
            config
                .get(key)
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
    };
    if !condition_ids.is_empty() {
        inputs.position_or_order_changed = Some(
            has_type("position_changed")
                || has_type("order_state_changed")
                || has_type("opportunity_state_changed"),
        );
        inputs.confirmed_break_of_flagged_level =
            Some(has_type("price_cross") && config_true("confirmed"));
        inputs.important_news = Some(has_type("important_news_event") || has_type("sentiment_reversal"));
        // 独立条件共振 = 本轮命中的**不同条件类型**数。
        inputs.condition_resonance = Some(condition_types.len() as u32);
    } else {
        for key in [
            "positionOrOrderChanged",
            "confirmedBreakOfFlaggedLevel",
            "importantNews",
            "conditionResonance",
        ] {
            unavailable.push(key.to_string());
        }
    }
    // 止损距离 / 保证金率：来自条件配置里记录的真实账户数值（后端口径）。
    let stop_distances = configs
        .iter()
        .filter_map(|config| config.get("stopDistancePct").and_then(Value::as_f64))
        .filter(|value| value.is_finite() && *value >= 0.0)
        .collect::<Vec<_>>();
    inputs.min_stop_distance_pct = stop_distances.iter().copied().reduce(f64::min);
    if inputs.min_stop_distance_pct.is_none() {
        unavailable.push("minStopDistancePct".to_string());
    }
    let raw_ratios = configs
        .iter()
        .flat_map(|config| {
            config
                .get("marginRatios")
                .or_else(|| config.get("mgnRatios"))
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_f64)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        })
        .collect::<Vec<_>>();
    let (valid, invalid): (Vec<f64>, Vec<f64>) =
        raw_ratios.into_iter().partition(|value| valid_margin_ratio(*value));
    inputs.margin_ratios = valid;
    if inputs.margin_ratios.is_empty() {
        unavailable.push("marginRatios".to_string());
    }
    if !invalid.is_empty() {
        // 越界值不参与判定，但必须留痕（C19.1 补充：0/异常巨大 → unavailable）。
        crate::boot_log(&format!(
            "triage escalation: {} margin ratio samples out of window 0<x<={} ignored",
            invalid.len(),
            crate::ai_triage::TRIAGE_MARGIN_RATIO_MAX_PCT
        ));
    }
    if let Some(at) = last_deep_at {
        if at > now_ms() {
            unavailable.push("lastDeepAt".to_string());
        }
    }
    crate::boot_log(&format!(
        "triage escalation inputs run={} conditions={} unavailable={:?}",
        context.run_id.as_deref().unwrap_or("-"),
        condition_ids.len(),
        unavailable
    ));
    let _ = app;
    (inputs, unavailable)
}

/// C23.2：取事件里的文本字段（**逐字保留**，不 trim、不截断）；缺失/非字符串 → `None`。
fn text_field(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// 取一份 usage 快照的 `totalTokens`（宽容：顶层或嵌套 `usage.totalTokens`）。
fn token_field(usage: &Value) -> i64 {
    usage
        .get("totalTokens")
        .or_else(|| {
            usage
                .get("usage")
                .and_then(|nested| nested.get("totalTokens"))
        })
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

/// 逐字段相减（`total - part`，不为负）：分阶段记账的唯一减法实现。
fn subtract_usage(total: &Value, part: &Value) -> Value {
    match total {
        Value::Object(map) => {
            let part_map = part.as_object();
            let mut output = serde_json::Map::new();
            for (key, value) in map {
                let previous = part_map.and_then(|entries| entries.get(key));
                let next = match (value, previous) {
                    (Value::Number(number), Some(Value::Number(previous))) => {
                        let base = number.as_i64().or_else(|| number.as_f64().map(|item| item as i64));
                        let offset = previous
                            .as_i64()
                            .or_else(|| previous.as_f64().map(|item| item as i64));
                        match (base, offset) {
                            (Some(base), Some(offset)) => json!(base.saturating_sub(offset).max(0)),
                            _ => value.clone(),
                        }
                    }
                    (Value::Object(_), Some(Value::Object(_))) => subtract_usage(value, previous.unwrap()),
                    _ => value.clone(),
                };
                output.insert(key.clone(), next);
            }
            Value::Object(output)
        }
        _ => total.clone(),
    }
}

/// C19.3-2：分阶段 token 记账块。
///
/// **根因（2026-09-19 线上 0/0/0）**：试判段与深度段曾经各取一次数——试判段读
/// `ai_agent_runs.token_usage_json`（那一列只在 `finishRun` 才写回，试判时永远是 0），
/// 总量又在收尾时重新水合，两次数值来自不同时刻、不同来源，于是
/// `triageTokens + deepTokens != totalTokens`（UI 显示"试判 0 / 深度 X"）。
/// 现在两段都走**同一个取数源**（会话事件的 usageSummary 水合，见 `load_run_metadata`）：
/// 试判段是 `reportTriage` 时的快照，总量是收尾时的快照，深度段用减法得出 →
/// 恒等式 `triageTokens + deepTokens == totalTokens` 由构造保证。
fn phase_token_block(conn: &Connection, run_id: &str, triage_snapshot: &Value) -> Value {
    let triage_usage = if triage_snapshot.is_null() {
        json!({})
    } else {
        triage_snapshot.clone()
    };
    let observed_total = load_run_metadata(conn, run_id)
        .ok()
        .and_then(|metadata| metadata.token_usage)
        .and_then(|usage| serde_json::to_value(usage).ok())
        .unwrap_or(Value::Null);
    let triage_tokens = token_field(&triage_usage);
    // 试判段是深度的下界：水合出来的总量若小于试判快照（取数源回退），用试判快照当总量。
    let total_usage = if observed_total.is_null() || token_field(&observed_total) < triage_tokens {
        triage_usage.clone()
    } else {
        observed_total
    };
    let total_tokens = token_field(&total_usage).max(triage_tokens);
    let deep_tokens = total_tokens.saturating_sub(triage_tokens);
    let deep_usage = {
        let subtracted = subtract_usage(&total_usage, &triage_usage);
        // 数值口径以恒等式为准（减法实现与 token_field 必须给出同一个深度段数字）。
        match subtracted {
            Value::Object(mut map) => {
                map.insert("totalTokens".to_string(), json!(deep_tokens));
                if let Some(nested) = map.get_mut("usage").and_then(Value::as_object_mut) {
                    nested.insert("totalTokens".to_string(), json!(deep_tokens));
                }
                Value::Object(map)
            }
            other => other,
        }
    };
    json!({
        "triage": triage_usage,
        "deep": deep_usage,
        "total": total_usage,
        "triageTokens": triage_tokens,
        "deepTokens": deep_tokens,
        "totalTokens": total_tokens,
    })
}

/// P1（C20）：专家级用量采集——工具次数、起止时间、时长、可用时的 token，
/// 拿不到 token 时显式标记 `tokensUnavailable`（不猜），无专家会话时是空数组。
fn collect_expert_activity(conn: &Connection, run_id: &str) -> Vec<Value> {
    let session_id = format!("background:{run_id}");
    let mut events = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT tool_json FROM ai_messages
         WHERE session_id=?1 AND tool_json IS NOT NULL ORDER BY created_at ASC",
    ) {
        if let Ok(rows) = stmt.query_map(params![session_id], |row| row.get::<_, String>(0)) {
            for tool_json in rows.flatten() {
                if let Ok(mut parsed) = serde_json::from_str::<Vec<Value>>(&tool_json) {
                    events.append(&mut parsed);
                }
            }
        }
    }
    aggregate_expert_activity(&events)
}

#[derive(Default)]
struct ExpertActivity {
    agent_id: String,
    configured_agent_id: String,
    name: Option<String>,
    /// C23.2：专家角色（`agentStart.role`）；缺失 = 空字符串。
    role: Option<String>,
    /// C23.2：主 Agent 给它的提问全文（`agentStart.taskPrompt`，**逐字不截断**）。
    task_prompt: Option<String>,
    /// C23.2：专家报告全文（`agentDone.result.text`，**逐字不截断**）。
    report: Option<String>,
    tool_calls: i64,
    started_at: Option<i64>,
    ended_at: Option<i64>,
    token_usage: Option<Value>,
}

pub(crate) fn aggregate_expert_activity(events: &[Value]) -> Vec<Value> {
    let mut order: Vec<String> = Vec::new();
    let mut activity: BTreeMap<String, ExpertActivity> = BTreeMap::new();
    for event in events {
        let agent_id = event
            .get("agentId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let configured = event
            .get("configuredAgentId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        if agent_id.is_empty() && configured.is_empty() {
            continue;
        }
        let key = if configured.is_empty() {
            agent_id.clone()
        } else {
            configured.clone()
        };
        let event_type = event.get("type").and_then(Value::as_str).unwrap_or_default();
        let mut entry = ExpertActivity {
            agent_id,
            configured_agent_id: configured,
            ..Default::default()
        };
        match event_type {
            "agentStart" => {
                entry.name = event
                    .get("title")
                    .or_else(|| event.get("name"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .filter(|value| !value.trim().is_empty());
                // C23.2：角色 + 侧车拼装后的完整任务原文；**原样保留**（不 trim、不截断）。
                entry.role = text_field(event.get("role"));
                entry.task_prompt = text_field(event.get("taskPrompt"));
                entry.started_at = event.get("startedAt").and_then(Value::as_i64);
            }
            "toolCall" | "toolResult" | "tool" => {
                entry.tool_calls = 1;
                entry.started_at = event.get("startedAt").and_then(Value::as_i64);
                entry.ended_at = event.get("endedAt").and_then(Value::as_i64);
            }
            "usage" => {
                entry.token_usage = event.get("usage").cloned().filter(|value| !value.is_null());
            }
            "agentDone" => {
                entry.ended_at = event.get("endedAt").and_then(Value::as_i64);
                // C23.2：报告全文（逐字、不截断）；与报告"不被改写"的既有约定一致。
                entry.report = text_field(event.pointer("/result/text"));
                if entry.token_usage.is_none() {
                    entry.token_usage = event
                        .pointer("/result/usage")
                        .cloned()
                        .filter(|value| !value.is_null());
                }
            }
            _ => {}
        }
        merge_expert_activity(&mut order, &mut activity, key, entry);
    }
    order
        .into_iter()
        .filter_map(|key| {
            let ExpertActivity {
                agent_id,
                configured_agent_id,
                name,
                role,
                task_prompt,
                report,
                tool_calls,
                started_at,
                ended_at,
                token_usage,
            } = activity.remove(&key)?;
            let expert_id = if configured_agent_id.is_empty() {
                agent_id.clone()
            } else {
                configured_agent_id.clone()
            };
            let display_name = name.unwrap_or_else(|| expert_id.clone());
            let duration = match (started_at, ended_at) {
                (Some(start), Some(end)) => Some(end.saturating_sub(start)),
                _ => None,
            };
            let mut value = json!({
                "expertId": expert_id,
                "configuredAgentId": configured_agent_id,
                "agentId": agent_id,
                "name": display_name,
                // C23.2：角色（缺失 = 空字符串，形状稳定）。
                "role": role.unwrap_or_default(),
                // C23.2：提问与报告全文。**缺失时是空字符串**（不是 null、不是缺键）：
                // 老运行 / 事件里没有这两个字段时数组形状不变，UI 直接按字符串渲染即可。
                "taskPrompt": task_prompt.unwrap_or_default(),
                "report": report.unwrap_or_default(),
                "toolCalls": tool_calls,
                "startedAt": started_at,
                "endedAt": ended_at,
                "durationMs": duration,
            });
            if let Some(object) = value.as_object_mut() {
                match token_usage {
                    Some(usage) => {
                        object.insert("tokenUsage".to_string(), usage.clone());
                        object.insert("tokens".to_string(), json!(token_field(&usage)));
                    }
                    None => {
                        object.insert("tokensUnavailable".to_string(), json!(true));
                    }
                }
            }
            Some(value)
        })
        .collect()
}

fn merge_expert_activity(
    order: &mut Vec<String>,
    activity: &mut BTreeMap<String, ExpertActivity>,
    key: String,
    entry: ExpertActivity,
) {
    if !order.contains(&key) {
        order.push(key.clone());
    }
    let slot = activity.entry(key).or_default();
    slot.merge_from(&entry);
}

impl ExpertActivity {
    fn merge_from(&mut self, other: &ExpertActivity) {
        if self.configured_agent_id.is_empty() {
            self.configured_agent_id = other.configured_agent_id.clone();
        }
        if self.agent_id.is_empty() {
            self.agent_id = other.agent_id.clone();
        }
        if self.name.is_none() {
            self.name = other.name.clone();
        }
        if self.role.is_none() {
            self.role = other.role.clone();
        }
        // C23.2：同一位专家被点名多次时，取**首个非空**的提问/报告（与 name/tokenUsage 同规则）。
        if self.task_prompt.is_none() {
            self.task_prompt = other.task_prompt.clone();
        }
        if self.report.is_none() {
            self.report = other.report.clone();
        }
        self.tool_calls = self.tool_calls.saturating_add(other.tool_calls);
        for candidate in [other.started_at, other.ended_at].into_iter().flatten() {
            self.started_at = Some(match self.started_at {
                Some(current) => current.min(candidate),
                None => candidate,
            });
            self.ended_at = Some(match self.ended_at {
                Some(current) => current.max(candidate),
                None => candidate,
            });
        }
        if self.token_usage.is_none() {
            self.token_usage = other.token_usage.clone();
        }
    }
}

// ===== C21.3 软审计：只判两项，不阻断、不改写正文 =====

/// C21.2 冻结的两套小节标题（zh / en）。审计按**概念**匹配、允许大小写与首尾空格差异，
/// 混用两套也算通过；不存在第三套写法。
const SUMMARY_SECTION_HEADINGS: [(&str, [&str; 2]); 5] = [
    ("结论", ["结论", "conclusion"]),
    ("事实与证据", ["事实与证据", "facts and evidence"]),
    ("冲突与缺口", ["冲突与缺口", "conflicts and gaps"]),
    ("观察条件", ["观察条件", "observation conditions"]),
    ("下一步", ["下一步", "next steps"]),
];

/// 规范化一条 Markdown 标题行（非标题返回 `None`）：去 `#`、去首尾空格、
/// 去尾随装饰冒号，ASCII 小写（中文不受影响）。
fn normalize_summary_heading(line: &str) -> Option<String> {
    let trimmed = line.trim();
    let hashes = trimmed.chars().take_while(|character| *character == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = trimmed[hashes..].trim();
    if rest.is_empty() {
        return None;
    }
    let rest = rest
        .trim_end_matches('#')
        .trim_end_matches(|character: char| character == '：' || character == ':')
        .trim();
    if rest.is_empty() {
        return None;
    }
    Some(
        rest.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_lowercase(),
    )
}

/// 文本里是否出现可识别的时间戳：ISO/斜杠/点分日期、时钟时间（`HH:MM[:SS]`）、
/// 10–13 位 epoch（秒/毫秒）。只做形状识别，不校验语义。
fn contains_timestamp(text: &str) -> bool {
    let bytes = text.as_bytes();
    let digits = |index: usize| -> usize {
        let mut count = 0;
        while index + count < bytes.len() && bytes[index + count].is_ascii_digit() {
            count += 1;
        }
        count
    };
    let mut index = 0;
    while index < bytes.len() {
        if !bytes[index].is_ascii_digit() {
            index += 1;
            continue;
        }
        let run = digits(index);
        // 日期：YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD（也覆盖 ISO `T` 时间部分）。
        if run == 4 {
            let separator = bytes.get(index + 4).copied();
            if matches!(separator, Some(b'-') | Some(b'/') | Some(b'.')) {
                let month = digits(index + 5);
                if (1..=2).contains(&month)
                    && matches!(bytes.get(index + 5 + month).copied(), Some(value) if value == separator.unwrap())
                {
                    let day = digits(index + 6 + month);
                    if (1..=2).contains(&day) {
                        return true;
                    }
                }
            }
        }
        // epoch：10–13 位连续数字。
        if (10..=13).contains(&run) {
            return true;
        }
        // 时钟时间：H:MM 或 HH:MM[:SS]。
        if (1..=2).contains(&run) && bytes.get(index + run) == Some(&b':') {
            let minute = digits(index + run + 1);
            if minute == 2 {
                return true;
            }
        }
        index += run.max(1);
    }
    false
}

/// C21.3：五项概念各自的小节起始行（行号）。
fn summary_section_lines(summary: &str) -> Vec<Option<usize>> {
    let mut found = vec![None; SUMMARY_SECTION_HEADINGS.len()];
    for (index, line) in summary.lines().enumerate() {
        let Some(heading) = normalize_summary_heading(line) else {
            continue;
        };
        for (concept, (_, variants)) in SUMMARY_SECTION_HEADINGS.iter().enumerate() {
            if found[concept].is_none() && variants.contains(&heading.as_str()) {
                found[concept] = Some(index);
            }
        }
    }
    found
}

/// C24.2-3：极简模式的 summary 软校验（**只写警告，不阻断、不改写**）。
///
/// 董事会裁决：极简模式允许"一句话 + 硬限长度"，因此这里**豁免 C21 五小节校验**，
/// 只判三件事：① 非空（非空本身仍由 `background.finishRun` 的既有校验保证）；
/// ② 显示宽度 ≤ 160（CJK/全角按 2 计，约 80 个汉字）；③ 不含换行（出现换行即视为多句）。
/// 另有 ④：模型仍然输出了正文（助手文本事件非空）→ 也记一条，供事后复盘
/// —— 目的是发现"提示词没约束住"，**不隐藏、不改写**。
fn minimal_summary_warnings(summary: &str, has_assistant_text: bool) -> Vec<String> {
    let mut warnings = Vec::new();
    if text_display_width(summary) > MINIMAL_SUMMARY_MAX_WIDTH {
        warnings.push(format!(
            "minimal 模式下 summary 超过 {MINIMAL_SUMMARY_MAX_WIDTH} 字符"
        ));
    }
    if summary.contains('\n') || summary.contains('\r') {
        warnings.push("minimal 模式下 summary 含多行".to_string());
    }
    if has_assistant_text {
        warnings.push("minimal 模式仍产生了正文".to_string());
    }
    warnings
}

/// C24.2-3：本轮运行会话里是否存在**非空助手文本**（极简模式"仍然输出了正文"的判据）。
///
/// 只看 `ai_messages.content`（助手正文通道），不看 reasoning、不看工具事件：
/// 极简模式关的是"说话"，工具调用照常。
fn run_has_assistant_text(conn: &Connection, run_id: &str) -> bool {
    let session_id = format!("background:{run_id}");
    let mut statement = match conn.prepare(
        "SELECT content FROM ai_messages WHERE session_id=?1 AND role='assistant'",
    ) {
        Ok(statement) => statement,
        Err(_) => return false,
    };
    let Ok(rows) = statement.query_map(params![session_id], |row| row.get::<_, String>(0)) else {
        return false;
    };
    let texts = rows.flatten().collect::<Vec<String>>();
    texts.iter().any(|text| !text.trim().is_empty())
}

/// C22.3-B：收尾软校验的**非致命**打回值（中英双语；`ok:false` 只是"这次输入被打回"，
/// 不是运行失败）。模型补齐 `selfAnalysisReason`（或先派一位专家）后再次调用即可通过。
fn self_analysis_pushback_value() -> Value {
    json!({
        "ok": false,
        "errorCode": "self_analysis_reason_required",
        "retryable": true,
        "runEnded": false,
        "pushbackCount": 1,
        "maxPushbacks": SELF_ANALYSIS_MAX_PUSHBACKS,
        "warning": "本轮已升级深度但未派任何专家：请补一句 selfAnalysisReason（说明为何自己完成），或先派至少一位专家后再收尾。本次收尾未落库、运行未结束；这条软校验只会打回一次。",
        "message": "This round escalated to the deep stage but dispatched no expert. Add a one-line selfAnalysisReason explaining why you completed the analysis yourself, or dispatch at least one expert, then call background.finishRun again. Nothing was persisted and the run is still open; this soft check pushes back only once.",
        "nextStep": "call background.finishRun again with selfAnalysisReason (or after dispatching at least one expert)",
    })
}

/// C22.3-B：收尾软校验的纯决策 —— 返回 `Some(打回值)` = 这一次**打回**（调用方必须
/// 直接返回、不落库、不结束运行）；`None` = 正常收尾。
///
/// 三条边界（与 C22.3 对齐）：
/// - 只有 `finish_run_audit` 判出 `selfAnalysisUnjustified` 才可能打回。该标记本身已要求
///   "后台 Profile 运行 + 试判升级 + 生效专家名单非空" → 交互式会话、非 Profile 运行、
///   名单为空的运行**天然不走**这条软校验（名单为空时该标记必为 false）。
/// - **最多打回一次**：计数在每个运行自己的状态里（`FinishGateState`，不新增全局表），
///   第二次一律接受并落库，绝不允许把运行卡死或判失败。
/// - 锁中毒（`Err`）时**宁可通过**：软校验永远不能变成新的故障点。
fn self_analysis_pushback(gate: &Arc<Mutex<FinishGateState>>, audit: &Value) -> Option<Value> {
    if !audit
        .get("selfAnalysisUnjustified")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let Ok(mut state) = gate.lock() else {
        return None;
    };
    if state.self_analysis_pushbacks >= SELF_ANALYSIS_MAX_PUSHBACKS {
        return None;
    }
    state.self_analysis_pushbacks += 1;
    Some(self_analysis_pushback_value())
}

/// C22.3-B：收尾软校验的落库前判定（只读）。
///
/// 返回 `(experts, audit, pushback)`：
/// - `experts` / `audit` 与最终落库用的是**同一份**（保证"打过回的那次"与落库判定一致）；
/// - `pushback = Some(..)` → 调用方必须**直接返回、不落库、不结束运行**。
///
/// 抽成独立函数的意义：它只读，因此可以在真库上断言"打回时零写入、运行状态不变"。
fn finish_run_audit_and_soft_check(
    conn: &Connection,
    context: &BackgroundRunContext,
    input: &BackgroundFinishRunInput,
    summary: &str,
    run_id: &str,
) -> Result<(Vec<Value>, Value, Option<Value>), String> {
    let triage_final = {
        let state = context.triage.lock().map_err(|error| error.to_string())?;
        state.clone()
    };
    // P1（C20）：专家级用量（工具次数/时长/可用时的 token）——"不设轮次上限"的替代护栏。
    let experts = collect_expert_activity(conn, run_id);
    // C24.2-3：极简模式的"仍然输出了正文"判据来自本轮会话的助手文本事件。
    let has_assistant_text = context.single_agent_mode == SINGLE_AGENT_MODE_MINIMAL
        && run_has_assistant_text(conn, run_id);
    // C20.6 补充 + C21.3 + C22.3-B + C24.2-3：审计块（纯函数、**永不失败**：格式问题只产出警告）。
    let audit = finish_run_audit(
        &triage_final,
        &context.enabled_agents,
        &experts,
        input,
        summary,
        &context.single_agent_mode,
        has_assistant_text,
    );
    // C22.3-B：唯一的收尾软校验（最多打回一次）。
    //
    // C24.2 的极简模式**刻意不做任何打回**：命中只写 `summaryFormatWarnings` 审计
    // （见 `minimal_summary_warnings`）。原因是一次真实运行（run-1789823396526501000）：
    // 极简 summary 已合规、唯一瑕疵是"仍产生了 8 字正文"，打回后模型没有重试，
    // 整轮以 `background.finishRun 调用未完成` **失败** —— 把格式小瑕疵变成整轮失败的
    // 代价不可接受。极简模式的可见性只靠审计字段（UI 运行详情可读）。
    let pushback = if let Some(value) = self_analysis_pushback(&context.finish_gate, &audit) {
        crate::boot_log(&format!(
            "finishRun soft check pushed back run={run_id} (escalated deep, zero experts, no selfAnalysisReason)"
        ));
        Some(value)
    } else {
        None
    };
    Ok((experts, audit, pushback))
}

/// C21.3 软审计：① 五个小节标题齐备（zh 或 en，按概念匹配）；② 「事实与证据」至少
/// 一条带时间戳。**只写警告，不失败、不截断、不重写正文**（可见性优先于强制）。
fn summary_format_warnings(summary: &str) -> Vec<String> {
    let found = summary_section_lines(summary);
    let mut warnings = Vec::new();
    for (concept, (label, _)) in SUMMARY_SECTION_HEADINGS.iter().enumerate() {
        if found[concept].is_none() {
            warnings.push(format!("缺小节：{label}"));
        }
    }
    if let Some(start) = found[1] {
        let lines = summary.lines().collect::<Vec<_>>();
        let end = lines
            .iter()
            .enumerate()
            .skip(start + 1)
            .find(|(_, line)| normalize_summary_heading(line).is_some())
            .map(|(index, _)| index)
            .unwrap_or(lines.len());
        let body = lines[start + 1..end].join("\n");
        if !contains_timestamp(&body) {
            warnings.push("事实与证据无时间戳".to_string());
        }
    }
    warnings
}

/// C20.6 补充 + C21.3：`background.finishRun` 的审计块（纯函数）。
///
/// - `summaryFormatWarnings`：只判五小节齐备 + 「事实与证据」带时间戳；
/// - `selfAnalysisReason` / `selfAnalysisUnjustified`：升级为深度运行却**零专家活动 +
///   零 usedEvidence + 无理由** → 标记"未说明理由"。判定只看后端事实（试判 verdict 与
///   专家会话记录），不采信正文自述。
///
/// **前置条件（2026-09-19 修误报）**：只有本次运行的**生效专家名单非空**时才可能标记
/// `selfAnalysisUnjustified`。名单为空 = 主 Agent 根本派不出专家（协作关闭 / 未勾选），
/// 那种"没有专家活动"是配置事实，不是主 Agent 走过场 —— 空名单一律不标。
///
/// **永不失败、永不改写正文**：格式问题只产出警告（可见性优先于强制，C21.3）。
///
/// C24.2-3：`summaryFormatWarnings` 的来源按**本次运行生效的单 Agent 子模式**分叉 ——
/// `minimal` 走"一句话 + 长度 + 不含换行 + 没有正文"（**豁免 C21 五小节**），
/// `standard` 走原有的 C21 两条（五小节齐备 + 事实与证据带时间戳），逐字不变。
fn finish_run_audit(
    triage: &crate::ai_triage::RunTriageState,
    enabled_agents: &[desic_agent_automation::AiAgentDefinition],
    experts: &[Value],
    input: &BackgroundFinishRunInput,
    summary: &str,
    single_agent_mode: &str,
    has_assistant_text: bool,
) -> Value {
    let summary_warnings = if single_agent_mode == SINGLE_AGENT_MODE_MINIMAL {
        minimal_summary_warnings(summary, has_assistant_text)
    } else {
        summary_format_warnings(summary)
    };
    let self_analysis_reason = input
        .self_analysis_reason
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let escalated = !triage.config.is_off()
        && triage.verdict == Some(true)
        && triage.phase() == crate::ai_triage::TriagePhase::Deep;
    let self_analysis_unjustified = escalated
        && !enabled_agents.is_empty()
        && experts.is_empty()
        && input.used_evidence.is_empty()
        && self_analysis_reason.is_none();
    json!({
        "usedEvidence": input.used_evidence,
        "contrarianResolutions": input.contrarian_resolutions,
        "selfAnalysisReason": self_analysis_reason,
        "selfAnalysisUnjustified": self_analysis_unjustified,
        // C21.3 / C24.2-3：软审计结果（UI 读 run.summaryFormatWarnings，这里同时留在 audit 里）。
        "summaryFormatWarnings": summary_warnings,
        // C24：本次运行生效的子模式（复盘时能对上"为什么这次的 summary 按一句话判"）。
        "singleAgentMode": single_agent_mode,
    })
}

/// C19.4：一键强制深度 —— 把被跳过（或已结束）的那次运行重新排为**深度运行**。
///
/// `manual_force_deep` 直接豁免试判（`triage_config_for_run` 对它返回 `mode=off`），
/// 所以重排出来的运行不再做试判、不会被再次判为跳过。
#[tauri::command]
pub(crate) fn ai_automation_force_deep_run(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, AiAutomationRuntime>,
    run_id: String,
) -> Result<AiAgentRunSummary, String> {
    let conn = open_automation_database(&app)?;
    if !automation_master_enabled_with_conn(&conn) {
        return Err("AI 自动化总开关未开启".to_string());
    }
    let source_run = conn
        .query_row(
            "SELECT profile_id,status,trigger_type FROM ai_agent_runs WHERE id=?1",
            params![run_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "运行不存在".to_string())?;
    let profile = load_profile(&conn, &source_run.0)?;
    if !profile.enabled {
        return Err("Agent Profile 未启用".to_string());
    }
    crate::boot_log(&format!(
        "force deep run: source={run_id} status={} trigger={} profile={}",
        source_run.1, source_run.2, profile.id
    ));
    let run = queue_run(
        &conn,
        &profile.id,
        MANUAL_FORCE_DEEP_TRIGGER,
        json!({
            "requestedBy": "user",
            "forcedFromRunId": run_id,
            "forcedFromStatus": source_run.1,
            "forcedAt": now_ms(),
        }),
    )?;
    runtime.notify.notify_one();
    Ok(run)
}

pub(crate) fn background_finish_run(
    app: tauri::AppHandle,
    context: &BackgroundRunContext,
    input: BackgroundFinishRunInput,
) -> Result<Value, String> {
    let profile_id = context
        .profile_id
        .as_deref()
        .ok_or_else(|| "background.finishRun 只能用于后台 Profile Run".to_string())?;
    let run_id = context
        .run_id
        .as_deref()
        .ok_or_else(|| "background.finishRun 缺少 agentRunId".to_string())?;
    let summary = input.summary.trim();
    if summary.is_empty() {
        return Err("本次运行摘要不能为空".to_string());
    }
    if !matches!(input.next_wake_plan.mode.as_str(), "any" | "all") {
        return Err("nextWakePlan.mode 必须是 any 或 all".to_string());
    }
    if input.next_wake_plan.conditions.len() > 32 {
        return Err("nextWakePlan.conditions 最多允许 32 条".to_string());
    }
    validate_wake_expiry(input.next_wake_plan.expires_at, now_ms())?;
    let mut conn = open_automation_database(&app)?;
    let profile = load_profile(&conn, profile_id)?;
    let trigger_type = conn
        .query_row(
            "SELECT trigger_type FROM ai_agent_runs WHERE id=?1",
            params![run_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| error.to_string())?;
    let is_intelligence_briefing = trigger_type == "intelligence_briefing";
    let is_daily_market_review = trigger_type == "daily_market_review";
    let opportunity_facts = load_run_opportunity_facts(&conn, run_id, profile_id)?;
    let created_opportunity_ids = opportunity_facts
        .iter()
        .filter(|item| item.resolution == "create")
        .map(|item| item.id.clone())
        .collect::<Vec<_>>();
    let reused_opportunity_ids = opportunity_facts
        .iter()
        .filter(|item| item.resolution == "reuse")
        .map(|item| item.id.clone())
        .collect::<Vec<_>>();
    if (is_intelligence_briefing || is_daily_market_review) && !opportunity_facts.is_empty() {
        return Err("只读市场复盘运行禁止创建交易机会".to_string());
    }
    // C19：试判判定跳过的运行没有交易决策，不要求 finalDecision（skip 路径只收尾）。
    let triage_skip_finish = {
        let state = context.triage.lock().map_err(|error| error.to_string())?;
        state.skipped && state.phase() == crate::ai_triage::TriagePhase::Skipped
    };
    let final_decision_json = if is_intelligence_briefing || is_daily_market_review || triage_skip_finish {
        input.final_decision.as_ref().map(Value::to_string)
    } else {
        let submitted_decision = input.final_decision.as_ref().ok_or_else(|| {
            "后台 Run 必须提交 finalDecision（execute/revise/wait/abandon）".to_string()
        })?;
        let outcome = submitted_decision
            .get("outcome")
            .and_then(Value::as_str)
            .ok_or_else(|| "finalDecision.outcome 缺失".to_string())?;
        if !matches!(outcome, "execute" | "revise" | "wait" | "abandon") {
            return Err(
                "finalDecision.outcome 必须是 execute、revise、wait 或 abandon".to_string(),
            );
        }
        if submitted_decision
            .get("reason")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .is_empty()
        {
            return Err("finalDecision.reason 不能为空".to_string());
        }
        let decision = normalize_final_decision(
            &conn,
            run_id,
            profile_id,
            submitted_decision,
            &opportunity_facts,
        )?;
        Some(decision.to_string())
    };
    if is_intelligence_briefing {
        for section in [
            "隔夜市场",
            "重要事件",
            "宏观窗口",
            "衍生品仓位",
            "Smart Money",
            "异常",
            "证据冲突",
            "数据缺口",
            "今日观察",
        ] {
            if !summary.contains(section) {
                return Err(format!("市场简报缺少固定章节：{section}"));
            }
        }
    }
    let mut parsed_conditions = Vec::new();
    for value in &input.next_wake_plan.conditions {
        let mut scoped_value = value.clone();
        normalize_background_wake_scope(&conn, context, &mut scoped_value)?;
        let condition_type = scoped_value
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| "唤醒条件缺少 type".to_string())?
            .to_string();
        if !context
            .allowed_wake_condition_types
            .iter()
            .any(|item| item == &condition_type)
        {
            return Err(format!("Profile 不允许使用唤醒条件：{}", condition_type));
        }
        let condition = serde_json::from_value::<WakeCondition>(scoped_value.clone())
            .map_err(|err| format!("唤醒条件 {} 参数无效：{}", condition_type, err))?;
        validate_wake_condition_limits(&condition, now_ms())?;
        parsed_conditions.push((condition_type, condition, scoped_value));
    }

    // C22.3-B：收尾软校验（最多打回一次）—— 在**任何写入之前**判定，因此打回时零副作用：
    // 不落库、不改运行状态、不结束运行（这里直接返回即可）。helper 全是只读操作。
    let (experts, audit, pushback) =
        finish_run_audit_and_soft_check(&conn, context, &input, summary, run_id)?;
    if let Some(pushback) = pushback {
        return Ok(pushback);
    }
    // 打回之后才真正收尾：试判状态快照（与软校验里那份是同一个状态，重新取一次即可）。
    let triage_final = {
        let state = context.triage.lock().map_err(|error| error.to_string())?;
        state.clone()
    };

    let now = now_ms();
    let next_wake_at = now.saturating_add(i64::from(profile.scan_interval_minutes) * 60_000);
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| err.to_string())?;
    let active_run = tx
        .query_row(
            "SELECT COUNT(*) FROM ai_agent_runs WHERE id=?1 AND profile_id=?2 AND status IN ('queued','running')",
            params![run_id, profile_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| err.to_string())?;
    if active_run != 1 {
        return Err("后台 Run 已结束或状态不允许完成".to_string());
    }
    if !is_intelligence_briefing && !is_daily_market_review {
        tx.execute(
            "UPDATE ai_wake_conditions SET status='replaced',updated_at=?2
             WHERE profile_id=?1 AND source='agent' AND status='active'",
            params![profile_id, now],
        )
        .map_err(|err| err.to_string())?;
        for (condition_type, _condition, value) in parsed_conditions {
            tx.execute(
                "INSERT INTO ai_wake_conditions(
                  id,profile_id,source,plan_mode,condition_type,config_json,status,expires_at,created_at,updated_at
                ) VALUES(?1,?2,'agent',?3,?4,?5,'active',?6,?7,?7)",
                params![
                    format!("wake-{}", unique_suffix()),
                    profile_id,
                    input.next_wake_plan.mode,
                    condition_type,
                    value.to_string(),
                    input.next_wake_plan.expires_at,
                    now,
                ],
            )
            .map_err(|err| err.to_string())?;
        }
    }
    // C19：试判判定跳过（enforce 且非抽样、未强制升级）→ 运行以 `skipped` 收尾，
    // 不要求 finalDecision（跳过本来就没有交易决策），但 nextWakePlan 已在 reportTriage 记录。
    let triage_skipped = triage_final.skipped
        && triage_final.phase() == crate::ai_triage::TriagePhase::Skipped;
    let (status, final_decision_json) = if triage_skipped {
        ("skipped", None)
    } else {
        ("completed", final_decision_json)
    };
    tx.execute(
        "UPDATE ai_agent_runs SET status=?6,summary=?2,error=NULL,finished_at=?3,next_wake_at=?4,
                final_decision_json=?5,updated_at=?3
         WHERE id=?1",
        params![run_id, summary, now, next_wake_at, final_decision_json, status],
    )
    .map_err(|err| err.to_string())?;
    // C19 记账：triage 块（含分阶段 token）+ 反饥饿计数（深度正常完成 → 清零并记时间）。
    if triage_final.config.mode != crate::ai_triage::TRIAGE_MODE_OFF {
        let triage_usage = triage_final.triage_usage.clone().unwrap_or(Value::Null);
        let token_block = phase_token_block(&tx, run_id, &triage_usage);
        let total_usage = token_block["total"].clone();
        let deep_usage = token_block["deep"].clone();
        let triage_tokens = token_block["triageTokens"].as_i64().unwrap_or(0);
        let deep_tokens = token_block["deepTokens"].as_i64().unwrap_or(0);
        let total_tokens = token_block["totalTokens"].as_i64().unwrap_or(0);
        let phase_tokens = json!({
            "triage": token_block["triage"],
            "deep": deep_usage,
            "total": total_usage,
        });
        // 顺手把水合出来的元数据写回列，避免 UI 摘要与 run 详情读到旧值。
        if let Ok(metadata) = load_run_metadata(&tx, run_id) {
            let _ = persist_run_metadata(&tx, run_id, &metadata);
        }
        let mut record = tx
            .query_row(
                "SELECT triage_json FROM ai_agent_runs WHERE id=?1",
                params![run_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|err| err.to_string())?
            .flatten()
            .and_then(|value| serde_json::from_str::<Value>(&value).ok())
            .unwrap_or_else(|| json!({}));
        if let Some(object) = record.as_object_mut() {
            object.insert("triageUsage".to_string(), triage_usage.clone());
            object.insert("deepUsage".to_string(), deep_usage.clone());
            object.insert("totalUsage".to_string(), total_usage.clone());
            object.insert("triageTokens".to_string(), json!(triage_tokens));
            object.insert("deepTokens".to_string(), json!(deep_tokens));
            object.insert("totalTokens".to_string(), json!(total_tokens));
            object.insert("phaseTokens".to_string(), phase_tokens);
            object.insert(
                "finishedAs".to_string(),
                json!(if triage_skipped { "skipped" } else { "deep" }),
            );
            object.insert("finishedAt".to_string(), json!(now));
        }
        tx.execute(
            "UPDATE ai_agent_runs SET triage_json=?2 WHERE id=?1",
            params![run_id, record.to_string()],
        )
        .map_err(|err| err.to_string())?;
        if triage_skipped {
            // 跳过：计数已在 reportTriage 时 +1（这里不重复加）。
        } else {
            tx.execute(
                "UPDATE ai_agent_profiles
                    SET triage_skip_streak=0,triage_last_deep_at=?2,updated_at=?2
                  WHERE id=?1",
                params![profile_id, now],
            )
            .map_err(|err| err.to_string())?;
        }
    }
    if is_daily_market_review {
        tx.execute(
            "UPDATE ai_daily_market_reviews
             SET status='completed',summary=?2,error=NULL,updated_at=?3
             WHERE run_id=?1",
            params![run_id, summary, now],
        )
        .map_err(|err| err.to_string())?;
    }
    for opportunity in &opportunity_facts {
        if let Some(expected_account) = context.account_id.as_deref() {
            if opportunity.account_id.as_deref() != Some(expected_account) {
                return Err(format!(
                    "交易机会账号不属于当前 Profile：{}",
                    opportunity.id
                ));
            }
        }
        if let Some(expected_environment) = context.environment.as_deref() {
            if normalize_environment(&opportunity.environment)
                != normalize_environment(expected_environment)
            {
                return Err(format!(
                    "交易机会环境不属于当前 Profile：{}",
                    opportunity.id
                ));
            }
        }
        if !context.symbols.is_empty()
            && !context
                .symbols
                .iter()
                .any(|symbol| symbol == &opportunity.inst_id)
        {
            return Err(format!(
                "交易机会品种不属于当前 Profile：{}",
                opportunity.id
            ));
        }
    }
    // P1（C20）+ C20.6 / C21.3 / C22.3-B：`experts` 与 `audit` 已在事务之前算好
    // （软校验用的就是同一份，保证"打过回的那次"与最终落库的判定完全一致）。
    tx.execute(
        "UPDATE ai_agent_runs SET audit_json=?2,experts_json=?3 WHERE id=?1",
        params![
            run_id,
            audit.to_string(),
            serde_json::to_string(&experts).map_err(|err| err.to_string())?,
        ],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;
    if is_intelligence_briefing {
        let evidence_ids = summary
            .split_whitespace()
            .map(|token| {
                token.trim_matches(|character: char| {
                    !character.is_ascii_alphanumeric() && character != '-' && character != '_'
                })
            })
            .filter(|token| {
                token.starts_with("news-event-")
                    || token.starts_with("anomaly-")
                    || token.starts_with("intelligence-")
                    || token.starts_with("smart-")
            })
            .map(str::to_string)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .take(500)
            .collect::<Vec<_>>();
        desic_intelligence::complete_briefing(
            &conn,
            run_id,
            summary,
            &json!({
                "skillVersions": context.skill_versions,
                "symbols": context.symbols,
                "profileId": profile_id,
                "evidenceIds": evidence_ids,
                "toolAuditRunId": run_id,
            }),
            None,
            now,
        )?;
    }

    let daily_review_id = if is_daily_market_review {
        conn.query_row(
            "SELECT id FROM ai_daily_market_reviews WHERE run_id=?1",
            params![run_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
    } else {
        None
    };
    let _ = app.emit(
        AUTOMATION_EVENT,
        json!({
            "type": "runCompleted",
            "message": if is_daily_market_review {
                format!("{} 的每日市场复盘已完成", profile.name)
            } else {
                format!("后台 Agent {} 已完成", profile.name)
            },
            "action": if is_daily_market_review {
                json!({ "tab": "reviews", "id": daily_review_id })
            } else {
                json!({ "tab": "runs", "id": run_id })
            }
        }),
    );
    if profile.feishu_enabled {
        let app_handle = app.clone();
        let title = if is_daily_market_review {
            format!("每日市场复盘：{}", profile.name)
        } else {
            format!("后台 Agent：{}", profile.name)
        };
        let content = summary.to_string();
        let related_id = run_id.to_string();
        let profile_id_for_notification = profile_id.to_string();
        tauri::async_runtime::spawn(async move {
            let _ = send_feishu_delivery(
                app_handle,
                FeishuSendInput {
                    title,
                    content,
                    level: "info".to_string(),
                    related_type: Some("agent_run".to_string()),
                    related_id: Some(related_id.clone()),
                    agent_profile_id: Some(profile_id_for_notification),
                    agent_run_id: Some(related_id),
                },
                true,
                Some(if is_daily_market_review {
                    "daily_review_completed"
                } else {
                    "run_completed"
                }),
            )
            .await;
        });
    }
    Ok(json!({
        "status": "completed",
        "runId": run_id,
        "profileId": profile_id,
        "createdOpportunityIds": created_opportunity_ids,
        "reusedOpportunityIds": reused_opportunity_ids,
        "nextWakeAt": next_wake_at,
        "conditionCount": input.next_wake_plan.conditions.len()
    }))
}

fn normalize_final_decision(
    conn: &Connection,
    run_id: &str,
    profile_id: &str,
    decision: &Value,
    opportunities: &[RunOpportunityFact],
) -> Result<Value, String> {
    const REASON_CODES: &[&str] = &[
        "trade_created",
        "pending_order",
        "market_uncertain",
        "evidence_conflict",
        "signal_not_triggered",
        "data_incomplete",
        "execution_blocked",
        "account_blocked",
        "risk_reward_invalid",
        "duplicate_opportunity",
        "no_action_required",
    ];
    let reason_codes = decision
        .get("reasonCodes")
        .and_then(Value::as_array)
        .filter(|codes| !codes.is_empty())
        .ok_or_else(|| "finalDecision.reasonCodes 必须是非空类型化原因数组".to_string())?;
    let mut normalized_codes = Vec::new();
    let mut unique_codes = HashSet::new();
    for code in reason_codes {
        let code = code
            .as_str()
            .map(str::trim)
            .filter(|code| REASON_CODES.contains(code))
            .ok_or_else(|| "finalDecision.reasonCodes 包含未知原因".to_string())?;
        if !unique_codes.insert(code.to_string()) {
            return Err(format!("finalDecision.reasonCodes 重复：{code}"));
        }
        if !matches!(
            code,
            "account_blocked" | "trade_created" | "pending_order" | "duplicate_opportunity"
        ) {
            normalized_codes.push(code.to_string());
        }
    }

    let context_rows = final_decision_context_rows(conn, run_id, profile_id, opportunities)?;
    let context_ids = context_rows
        .iter()
        .map(|(context_id, _)| context_id.clone())
        .collect::<Vec<_>>();
    let mut blockers = BTreeSet::new();
    let mut blocked = false;
    for (_, snapshot) in &context_rows {
        if snapshot
            .pointer("/precheck/blocked")
            .and_then(Value::as_bool)
            == Some(true)
        {
            blocked = true;
            for reason in snapshot
                .pointer("/precheck/reasons")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                blockers.insert(reason.to_string());
            }
        }
    }
    let account_status = if context_rows.is_empty() {
        "not_evaluated"
    } else if blocked {
        "blocked"
    } else {
        "feasible"
    };
    let account_source = if context_rows.is_empty() {
        "not_evaluated"
    } else {
        "market.readDecisionContext"
    };

    let created_opportunity_ids = opportunities
        .iter()
        .filter(|item| item.resolution == "create")
        .map(|item| item.id.clone())
        .collect::<Vec<_>>();
    let reused_opportunity_ids = opportunities
        .iter()
        .filter(|item| item.resolution == "reuse")
        .map(|item| item.id.clone())
        .collect::<Vec<_>>();
    if !opportunities.is_empty() {
        normalized_codes.retain(|code| code != "no_action_required");
        if !created_opportunity_ids.is_empty() {
            normalized_codes.push("trade_created".to_string());
        }
        if !reused_opportunity_ids.is_empty() {
            normalized_codes.push("duplicate_opportunity".to_string());
        }
        if opportunities.iter().any(|item| {
            matches!(
                item.status.as_str(),
                "pending" | "approved" | "executing" | "submitted" | "partially_filled"
            )
        }) {
            normalized_codes.push("pending_order".to_string());
        }
    }
    if blocked {
        normalized_codes.push("account_blocked".to_string());
    }
    if normalized_codes.is_empty() {
        normalized_codes.push("no_action_required".to_string());
    }
    let mut seen = HashSet::new();
    normalized_codes.retain(|code| seen.insert(code.clone()));

    let mut normalized = decision.clone();
    let object = normalized
        .as_object_mut()
        .ok_or_else(|| "finalDecision 必须是对象".to_string())?;
    if !opportunities.is_empty() {
        let committed = opportunities.iter().any(|item| {
            matches!(
                item.status.as_str(),
                "approved" | "executing" | "submitted" | "partially_filled" | "executed" | "closed"
            )
        });
        object.insert(
            "outcome".to_string(),
            json!(if committed { "execute" } else { "wait" }),
        );
    }
    object.insert("reasonCodes".to_string(), json!(normalized_codes));
    object.insert(
        "createdOpportunityIds".to_string(),
        json!(created_opportunity_ids),
    );
    object.insert(
        "reusedOpportunityIds".to_string(),
        json!(reused_opportunity_ids),
    );
    object.insert("decisionContextIds".to_string(), json!(context_ids.clone()));
    object.insert(
        "decisionContextId".to_string(),
        context_ids
            .last()
            .cloned()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    object.insert(
        "accountAssessment".to_string(),
        json!({
            "status": account_status,
            "source": account_source,
            "evaluationId": context_ids.last(),
            "decisionContextId": context_ids.last(),
            "decisionContextIds": context_ids,
            "blockers": blockers.into_iter().collect::<Vec<_>>()
        }),
    );
    Ok(normalized)
}

fn normalize_background_wake_scope(
    conn: &Connection,
    context: &BackgroundRunContext,
    value: &mut Value,
) -> Result<(), String> {
    normalize_wake_scope(
        conn,
        context.account_id.as_deref(),
        context.environment.as_deref(),
        &context.symbols,
        value,
    )
}

fn normalize_wake_scope(
    conn: &Connection,
    account_id: Option<&str>,
    environment: Option<&str>,
    symbols: &[String],
    value: &mut Value,
) -> Result<(), String> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| "唤醒条件必须是对象".to_string())?;
    let condition_type = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if let Some(inst_id) = object
        .get("instId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        if !symbols.is_empty() && !symbols.iter().any(|allowed| allowed == inst_id) {
            return Err(format!("唤醒条件品种不在当前 Profile 范围内：{inst_id}"));
        }
    }
    if matches!(
        condition_type.as_str(),
        "order_state_changed" | "position_changed" | "episode_closed"
    ) {
        if let Some(expected) = account_id {
            if let Some(actual) = object.get("accountId").and_then(Value::as_str) {
                if actual != expected {
                    return Err("唤醒条件账号不在当前 Profile 范围内".to_string());
                }
            }
            object.insert("accountId".to_string(), json!(expected));
        }
    }
    if condition_type == "opportunity_state_changed" {
        let opportunity_id = object
            .get("opportunityId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .ok_or_else(|| {
                "opportunity_state_changed 必须指定当前 Profile 的 opportunityId".to_string()
            })?;
        let scope = conn
            .query_row(
                "SELECT account_id,environment,inst_id FROM trade_opportunities WHERE id=?1",
                params![opportunity_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|err| err.to_string())?
            .ok_or_else(|| "唤醒条件引用的交易机会不存在".to_string())?;
        if account_id.is_some_and(|expected| scope.0.as_deref() != Some(expected))
            || environment.is_some_and(|expected| {
                normalize_environment(&scope.1) != normalize_environment(expected)
            })
            || (!symbols.is_empty() && !symbols.iter().any(|allowed| allowed == &scope.2))
        {
            return Err("唤醒条件引用的交易机会不在当前 Profile 范围内".to_string());
        }
    }
    Ok(())
}

fn validate_wake_expiry(expires_at: Option<i64>, now: i64) -> Result<(), String> {
    if let Some(expires_at) = expires_at {
        validate_unix_millisecond_timestamp("nextWakePlan.expiresAt", expires_at)?;
        if expires_at <= now {
            return Err(
                "唤醒计划 expiresAt 必须晚于当前时间，单位为 13 位 Unix 毫秒时间戳".to_string(),
            );
        }
        if expires_at > now.saturating_add(366 * 24 * 60 * 60_000) {
            return Err("唤醒计划 expiresAt 最多设置到一年后".to_string());
        }
    }
    Ok(())
}

fn validate_unix_millisecond_timestamp(field: &str, value: i64) -> Result<(), String> {
    if (1_000_000_000..100_000_000_000).contains(&value) {
        return Err(format!(
            "{field} 必须使用 13 位 Unix 毫秒时间戳；当前值 {value} 看起来是 10 位秒级时间戳，请改为 {}",
            value.saturating_mul(1_000)
        ));
    }
    Ok(())
}

fn validate_wake_condition_limits(condition: &WakeCondition, now: i64) -> Result<(), String> {
    let finite_positive = |value: f64, name: &str| {
        if value.is_finite() && value > 0.0 {
            Ok(())
        } else {
            Err(format!("{} 必须是有限正数", name))
        }
    };
    match condition {
        WakeCondition::Timer {
            at_ms,
            interval_minutes,
        } => {
            if at_ms.is_none() && interval_minutes.is_none() {
                return Err("timer 必须提供 atMs 或 intervalMinutes".to_string());
            }
            if let Some(at_ms) = at_ms {
                validate_unix_millisecond_timestamp("timer.atMs", *at_ms)?;
                if *at_ms <= now || *at_ms > now.saturating_add(366 * 24 * 60 * 60_000) {
                    return Err("timer.atMs 必须是未来一年内的 13 位 Unix 毫秒时间戳".to_string());
                }
            }
            if interval_minutes.is_some_and(|value| !(1..=1_440).contains(&value)) {
                return Err("timer.intervalMinutes 必须在 1 到 1440 之间".to_string());
            }
        }
        WakeCondition::PriceCross {
            price, direction, ..
        } => {
            finite_positive(*price, "price_cross.price")?;
            if !matches!(direction.as_str(), "up" | "above" | "down" | "below") {
                return Err("price_cross.direction 必须是 up/above/down/below".to_string());
            }
        }
        WakeCondition::PriceChangePct {
            window_minutes,
            direction,
            threshold_pct,
            ..
        } => {
            if !(1..=1_440).contains(window_minutes) {
                return Err("price_change_pct.windowMinutes 必须在 1 到 1440 之间".to_string());
            }
            finite_positive(threshold_pct.abs(), "price_change_pct.thresholdPct")?;
            if threshold_pct.abs() > 1_000.0 {
                return Err("price_change_pct.thresholdPct 不能超过 1000%".to_string());
            }
            if !matches!(
                direction.as_str(),
                "up" | "above" | "down" | "below" | "absolute"
            ) {
                return Err("price_change_pct.direction 无效".to_string());
            }
        }
        WakeCondition::CandleVolumeRatio {
            bar,
            lookback,
            ratio,
            ..
        } => {
            if !(1..=500).contains(lookback) {
                return Err("candle_volume_ratio.lookback 必须在 1 到 500 之间".to_string());
            }
            if !matches!(
                bar.as_str(),
                "1m" | "3m" | "5m" | "15m" | "30m" | "1H" | "2H" | "4H" | "6H" | "12H" | "1D"
            ) {
                return Err("candle_volume_ratio.bar 不受支持".to_string());
            }
            finite_positive(*ratio, "candle_volume_ratio.ratio")?;
            if *ratio > 100.0 {
                return Err("candle_volume_ratio.ratio 不能超过 100".to_string());
            }
        }
        WakeCondition::FundingRateThreshold {
            direction, rate, ..
        } => {
            if !rate.is_finite() || rate.abs() > 1.0 {
                return Err("funding_rate_threshold.rate 必须是 -1 到 1 的有限数".to_string());
            }
            if !matches!(
                direction.as_str(),
                "up" | "above" | "down" | "below" | "absolute"
            ) {
                return Err("funding_rate_threshold.direction 无效".to_string());
            }
        }
        WakeCondition::OrderbookImbalance {
            depth,
            direction,
            ratio,
            ..
        } => {
            if !(1..=50).contains(depth) {
                return Err("orderbook_imbalance.depth 必须在 1 到 50 之间".to_string());
            }
            if !ratio.is_finite() || *ratio <= 0.0 || *ratio > 1.0 {
                return Err("orderbook_imbalance.ratio 必须在 0 到 1 之间".to_string());
            }
            if !matches!(
                direction.as_str(),
                "buy" | "bid" | "up" | "sell" | "ask" | "down"
            ) {
                return Err("orderbook_imbalance.direction 无效".to_string());
            }
        }
        WakeCondition::OrderStateChanged { states, .. }
        | WakeCondition::OpportunityStateChanged { states, .. } => {
            if states.len() > 32 || states.iter().any(|value| value.len() > 64) {
                return Err("状态过滤最多 32 项，单项最多 64 个字符".to_string());
            }
        }
        WakeCondition::PositionChanged { .. }
        | WakeCondition::EpisodeClosed { .. }
        | WakeCondition::OpenInterestAnomaly { .. }
        | WakeCondition::TakerFlowImbalance { .. }
        | WakeCondition::CrowdingDivergence { .. }
        | WakeCondition::FundingExtreme { .. }
        | WakeCondition::LiquidationCluster { .. }
        | WakeCondition::ImportantNewsEvent { .. }
        | WakeCondition::SentimentReversal { .. }
        | WakeCondition::SmartMoneyChange { .. }
        | WakeCondition::MacroEventWindow { .. } => {}
    }
    Ok(())
}

pub(crate) fn review_complete(
    app: tauri::AppHandle,
    context: &BackgroundRunContext,
    input: ReviewCompleteInput,
) -> Result<Value, String> {
    let review_id = context
        .review_id
        .as_deref()
        .ok_or_else(|| "review.complete 只能用于复盘 Run".to_string())?;
    let summary = input.summary.trim();
    if summary.is_empty() {
        return Err("复盘摘要不能为空".to_string());
    }
    let conn = open_automation_database(&app)?;
    let (inst_id, environment, open_time, close_time) = conn
        .query_row(
            "SELECT p.inst_id,p.environment,p.open_time,p.close_time
             FROM ai_trade_reviews r
             JOIN position_episodes p ON p.id=r.episode_id
             WHERE r.id=?1",
            params![review_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            },
        )
        .map_err(|err| format!("读取复盘仓位时间事实失败：{err}"))?;
    let canonical_facts =
        build_review_canonical_facts(&inst_id, &environment, open_time, close_time)?;
    validate_review_summary(summary, &canonical_facts)?;
    let now = now_ms();
    let changed = conn
        .execute(
            "UPDATE ai_trade_reviews SET status='completed',summary=?2,findings_json=?3,
             suggestions_json=?4,skill_version=?5,error=NULL,updated_at=?6
             WHERE id=?1 AND status IN ('queued','running','failed')",
            params![
                review_id,
                summary,
                to_json(&normalize_strings(input.findings))?,
                to_json(&normalize_strings(input.suggestions))?,
                input.skill_version,
                now,
            ],
        )
        .map_err(|err| err.to_string())?;
    if changed == 0 {
        return Err("复盘已完成或不存在".to_string());
    }
    let _ = app.emit(
        AUTOMATION_EVENT,
        json!({
            "type": "reviewCreated",
            "message": "新的交易复盘已生成",
            "action": { "tab": "reviews", "id": review_id }
        }),
    );
    spawn_feishu_notification(
        &app,
        FeishuSendInput {
            title: "交易复盘已完成".to_string(),
            content: summary.to_string(),
            level: "info".to_string(),
            related_type: Some("review".to_string()),
            related_id: Some(review_id.to_string()),
            agent_profile_id: context.profile_id.clone(),
            agent_run_id: context.run_id.clone(),
        },
        "review_completed",
    );
    Ok(json!({ "status": "completed", "reviewId": review_id }))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ReviewCanonicalFacts {
    timezone: String,
    open_time_ms: i64,
    close_time_ms: i64,
    open_time_text: String,
    close_time_text: String,
    holding_duration_ms: i64,
    holding_duration_text: String,
    environment: String,
    environment_label: String,
    summary_header: String,
}

fn build_review_canonical_facts(
    inst_id: &str,
    environment: &str,
    open_time: i64,
    close_time: Option<i64>,
) -> Result<ReviewCanonicalFacts, String> {
    let close_time =
        close_time.ok_or_else(|| "已关闭仓位缺少平仓时间，无法完成复盘".to_string())?;
    if close_time < open_time {
        return Err("仓位平仓时间早于开仓时间，无法完成复盘".to_string());
    }
    let timezone = "Asia/Shanghai (UTC+8)".to_string();
    let open_time_text = format_review_timestamp(open_time)?;
    let close_time_text = format_review_timestamp(close_time)?;
    let holding_duration_ms = close_time.saturating_sub(open_time);
    let holding_duration_text = format_review_duration(holding_duration_ms);
    let environment = normalize_environment(environment);
    let environment_label = if environment == "live" {
        "实盘账户"
    } else {
        "模拟盘账户"
    }
    .to_string();
    let summary_header = format!(
        "{} 仓位复盘（{} → {}，UTC+8，{}，持仓 {}）",
        inst_id, open_time_text, close_time_text, environment_label, holding_duration_text
    );
    Ok(ReviewCanonicalFacts {
        timezone,
        open_time_ms: open_time,
        close_time_ms: close_time,
        open_time_text,
        close_time_text,
        holding_duration_ms,
        holding_duration_text,
        environment,
        environment_label,
        summary_header,
    })
}

fn format_review_timestamp(timestamp_ms: i64) -> Result<String, String> {
    let timestamp = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(timestamp_ms)
        .ok_or_else(|| format!("复盘时间戳无效：{timestamp_ms}"))?;
    let shanghai = chrono::FixedOffset::east_opt(8 * 60 * 60)
        .ok_or_else(|| "无法创建 Asia/Shanghai 时区".to_string())?;
    Ok(timestamp
        .with_timezone(&shanghai)
        .format("%Y-%m-%d %H:%M:%S")
        .to_string())
}

fn format_review_duration(duration_ms: i64) -> String {
    let total_seconds = duration_ms.max(0) / 1000;
    let days = total_seconds / 86_400;
    let hours = total_seconds % 86_400 / 3_600;
    let minutes = total_seconds % 3_600 / 60;
    let seconds = total_seconds % 60;
    if days > 0 {
        format!("{days}天{hours}小时{minutes}分{seconds}秒")
    } else if hours > 0 {
        format!("{hours}小时{minutes}分{seconds}秒")
    } else if minutes > 0 {
        format!("{minutes}分{seconds}秒")
    } else {
        format!("{seconds}秒")
    }
}

fn validate_review_summary(
    summary: &str,
    canonical_facts: &ReviewCanonicalFacts,
) -> Result<(), String> {
    let first_line = summary
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    if first_line != canonical_facts.summary_header {
        return Err(format!(
            "复盘摘要首行与仓位事实不一致。请逐字使用 canonicalFacts.summaryHeader：{}",
            canonical_facts.summary_header
        ));
    }
    Ok(())
}

fn load_review_skill_definition(
    conn: &Connection,
    episode_id: &str,
    skill_id: &str,
    version: u32,
) -> Result<desic_storage_config::AiSkillDefinition, String> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT r.skill_versions_json
             FROM ai_agent_runs r
             WHERE r.id IN (
               SELECT agent_run_id FROM position_episode_events
                WHERE episode_id=?1 AND agent_run_id IS NOT NULL
               UNION
               SELECT agent_run_id FROM position_episode_opportunities
                WHERE episode_id=?1 AND agent_run_id IS NOT NULL
               UNION
               SELECT t.agent_run_id
                 FROM position_episode_opportunities l
                 JOIN trade_opportunities t ON t.id=l.opportunity_id
                WHERE l.episode_id=?1 AND t.agent_run_id IS NOT NULL
               UNION
               SELECT t.agent_run_id
                 FROM position_episodes e
                 JOIN trade_opportunities t ON t.id=e.strategy_id
                WHERE e.id=?1 AND t.agent_run_id IS NOT NULL
             )",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![episode_id], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?;
    let mut used_by_episode = false;
    for row in rows {
        let versions =
            from_json_or_default::<HashMap<String, u32>>(&row.map_err(|err| err.to_string())?);
        if versions.get(skill_id).copied() == Some(version) {
            used_by_episode = true;
            break;
        }
    }
    if !used_by_episode {
        return Err(format!(
            "Skill {} v{} 不属于该仓位关联决策 Run 的固定版本",
            skill_id, version
        ));
    }
    let content = conn
        .query_row(
            "SELECT content FROM ai_skill_versions
             WHERE skill_id=?1 AND version=?2 AND status='published'",
            params![skill_id, i64::from(version)],
            |row| row.get::<_, String>(0),
        )
        .map_err(|err| format!("找不到复盘引用的 Skill {} v{}：{}", skill_id, version, err))?;
    Ok(
        serde_json::from_str::<desic_storage_config::AiSkillDefinition>(&content).unwrap_or_else(
            |_| desic_storage_config::AiSkillDefinition {
                id: skill_id.to_string(),
                name: skill_id.to_string(),
                description: format!("历史 Skill {} v{}", skill_id, version),
                rules: String::new(),
                content,
                builtin: false,
                bundle: None,
            },
        ),
    )
}

pub(crate) fn review_read_skill_version(
    app: tauri::AppHandle,
    context: &BackgroundRunContext,
    input: ReviewSkillVersionInput,
) -> Result<Value, String> {
    context
        .review_id
        .as_deref()
        .ok_or_else(|| "review.readSkillVersion 只能用于复盘 Run".to_string())?;
    let episode_id = context
        .episode_id
        .as_deref()
        .ok_or_else(|| "复盘 Run 缺少 episodeId".to_string())?;
    let skill_id = input.skill_id.trim();
    if skill_id.is_empty() || input.version == 0 {
        return Err("读取 Skill 基线必须提供 skillId 和正整数 version".to_string());
    }
    let conn = open_automation_database(&app)?;
    let definition = load_review_skill_definition(&conn, episode_id, skill_id, input.version)?;
    Ok(json!({
        "skillId": skill_id,
        "version": input.version,
        "definition": definition,
        "immutable": true,
    }))
}

pub(crate) fn optimization_suggestion_create(
    app: tauri::AppHandle,
    context: &BackgroundRunContext,
    input: OptimizationSuggestionInput,
) -> Result<Value, String> {
    let review_id = context
        .review_id
        .as_deref()
        .ok_or_else(|| "optimizationSuggestion.create 只能用于复盘 Run".to_string())?;
    let episode_id = context
        .episode_id
        .as_deref()
        .ok_or_else(|| "复盘 Run 缺少 episodeId".to_string())?;
    if input.title.trim().is_empty()
        || input.problem.trim().is_empty()
        || input.proposed_changes.trim().is_empty()
    {
        return Err("优化建议必须包含标题、问题和建议修改内容".to_string());
    }
    let evidence = normalize_strings(input.evidence);
    if evidence.is_empty() || input.sample_size == 0 {
        return Err("优化建议必须提供非空证据和真实样本数".to_string());
    }
    let skill_id = input
        .current_skill_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "优化建议必须绑定该仓位实际使用的 Skill".to_string())?;
    let version = input
        .current_skill_version
        .filter(|value| *value > 0)
        .ok_or_else(|| "优化建议必须绑定该仓位实际使用的 Skill 版本".to_string())?;
    let proposed_skill = input
        .proposed_skill
        .ok_or_else(|| "优化建议必须提交完整 proposedSkill，供用户预览差异".to_string())?;
    let conn = open_automation_database(&app)?;
    let baseline = load_review_skill_definition(&conn, episode_id, skill_id, version)?;
    if proposed_skill.id != skill_id {
        return Err("proposedSkill.id 必须与 currentSkillId 完全一致".to_string());
    }
    if proposed_skill.builtin != baseline.builtin {
        return Err("proposedSkill 不能改变 Skill 的内置属性".to_string());
    }
    if proposed_skill.name.trim().is_empty() || proposed_skill.content.trim().is_empty() {
        return Err("proposedSkill 的名称和正文不能为空".to_string());
    }
    if !skill_draft_can_be_published(&proposed_skill) {
        return Err("该固定内置 Skill 不允许通过复盘优化建议修改".to_string());
    }
    let baseline_value = serde_json::to_value(&baseline).map_err(|err| err.to_string())?;
    if baseline_value == serde_json::to_value(&proposed_skill).map_err(|err| err.to_string())? {
        return Err("proposedSkill 与基线完全相同，不需要创建优化建议".to_string());
    }
    let id = format!("suggestion-{}", unique_suffix());
    let now = now_ms();
    conn.execute(
        "INSERT INTO ai_optimization_suggestions(
          id,review_id,title,problem,evidence_json,sample_size,current_skill_id,current_skill_version,
          proposed_changes,proposed_skill_json,benefits,risks,status,created_at,updated_at
        ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'pending_review',?13,?13)",
        params![
            id,
            review_id,
            input.title.trim(),
            input.problem.trim(),
            to_json(&evidence)?,
            input.sample_size,
            skill_id,
            version,
            input.proposed_changes.trim(),
            to_json(&proposed_skill)?,
            input.benefits.trim(),
            input.risks.trim(),
            now,
        ],
    )
    .map_err(|err| err.to_string())?;
    let _ = app.emit(
        AUTOMATION_EVENT,
        json!({
            "type": "suggestionCreated",
            "message": "复盘 Agent 提交了新的优化建议",
            "action": { "tab": "optimization", "id": id }
        }),
    );
    spawn_feishu_notification(
        &app,
        FeishuSendInput {
            title: "新的 AI 优化建议".to_string(),
            content: input.title.trim().to_string(),
            level: "info".to_string(),
            related_type: Some("optimization_suggestion".to_string()),
            related_id: Some(id.clone()),
            agent_profile_id: context.profile_id.clone(),
            agent_run_id: context.run_id.clone(),
        },
        "suggestion_created",
    );
    Ok(json!({ "status": "pending_review", "suggestionId": id, "reviewId": review_id }))
}

pub(crate) fn record_domain_event_with_conn(
    conn: &Connection,
    event: &DomainEvent,
    payload: Value,
) -> Result<String, String> {
    let id = format!("domain-event-{}", unique_suffix());
    conn.execute(
        "INSERT INTO ai_domain_events(
          id,event_type,account_id,inst_id,opportunity_id,episode_id,state,payload_json,occurred_at
        ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            id,
            event.event_type,
            event.account_id,
            event.inst_id,
            event.opportunity_id,
            event.episode_id,
            event.state,
            payload.to_string(),
            event.occurred_at,
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(id)
}

pub(crate) fn record_domain_event_once_with_conn(
    conn: &Connection,
    source_id: &str,
    event: &DomainEvent,
    payload: Value,
) -> Result<bool, String> {
    let id = format!("intelligence-domain-event-{source_id}");
    let changed = conn
        .execute(
            "INSERT OR IGNORE INTO ai_domain_events(
              id,event_type,account_id,inst_id,opportunity_id,episode_id,state,payload_json,occurred_at
            ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                id,
                event.event_type,
                event.account_id,
                event.inst_id,
                event.opportunity_id,
                event.episode_id,
                event.state,
                payload.to_string(),
                event.occurred_at,
            ],
        )
        .map_err(|err| err.to_string())?;
    Ok(changed == 1)
}

pub(crate) fn record_domain_event(
    app: &tauri::AppHandle,
    event: &DomainEvent,
    payload: Value,
) -> Result<(), String> {
    let conn = open_automation_database(app)?;
    record_domain_event_with_conn(&conn, event, payload).map(|_| ())
}

pub(crate) fn enqueue_closed_episode_reviews(
    conn: &Connection,
    account_id: &str,
    environment: &str,
    inst_id: Option<&str>,
) -> Result<usize, String> {
    if !automation_master_enabled_with_conn(conn) {
        return Ok(0);
    }
    let review_start_at = load_setting(conn, "review_auto_start_at")
        .and_then(|value| value.as_i64())
        .unwrap_or_else(now_ms);
    let mut sql = "SELECT p.id,p.inst_id,p.net_pnl,p.close_time
        FROM position_episodes p
        LEFT JOIN ai_trade_reviews r ON r.episode_id=p.id AND r.review_version=1
        WHERE p.account_id=?1 AND p.environment=?2 AND p.status='closed' AND p.primary_origin<>'exchange' AND r.id IS NULL
          AND COALESCE(p.close_time,p.updated_at)>=?3"
        .to_string();
    if inst_id.is_some() {
        sql.push_str(" AND p.inst_id=?4");
    }
    sql.push_str(" ORDER BY COALESCE(p.close_time,p.updated_at) ASC LIMIT 20");
    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let mapper = |row: &rusqlite::Row<'_>| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<i64>>(3)?,
        ))
    };
    let rows = if let Some(symbol) = inst_id {
        stmt.query_map(
            params![account_id, environment, review_start_at, symbol],
            mapper,
        )
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?
    } else {
        stmt.query_map(params![account_id, environment, review_start_at], mapper)
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    };
    let mut created = 0;
    for (episode_id, symbol, net_pnl, close_time) in rows {
        let now = now_ms();
        let review_id = format!("review:{}:1", episode_id);
        let inserted = conn
            .execute(
                "INSERT OR IGNORE INTO ai_trade_reviews(
                  id,episode_id,review_version,status,summary,findings_json,suggestions_json,net_pnl,created_at,updated_at
                ) VALUES(?1,?2,1,'queued','','[]','[]',?3,?4,?4)",
                params![review_id, episode_id, net_pnl, now],
            )
            .map_err(|err| err.to_string())?;
        if inserted > 0 {
            let _ = record_domain_event_with_conn(
                conn,
                &DomainEvent {
                    event_type: "episode_closed".to_string(),
                    account_id: Some(account_id.to_string()),
                    inst_id: Some(symbol),
                    episode_id: Some(episode_id),
                    occurred_at: close_time.unwrap_or(now),
                    ..Default::default()
                },
                json!({ "reviewId": review_id }),
            );
            created += 1;
        }
    }
    Ok(created)
}

/// Ticks of uninterrupted contention tolerated before the user is told. At one
/// retry every two seconds this is roughly half a minute of silent retrying,
/// long enough to outlast a large backtest report or a candle backfill.
const CONTENTION_ESCALATION_TICKS: u32 = 15;

/// True when a scheduler error is SQLite lock contention rather than a real
/// fault. Matched on the text because the error reaches this layer as a String.
fn is_transient_database_contention(message: &str) -> bool {
    let lowered = message.to_ascii_lowercase();
    lowered.contains("database is locked")
        || lowered.contains("database table is locked")
        || lowered.contains("database is busy")
}

/// 僵尸运行判定阈值：`started_at` 与心跳（`updated_at`，由流式检查点推进）
/// **双双**超过 30 分钟才判定为进程已死的残留。
const STALE_RUNNING_RUN_IDLE_MS: i64 = 30 * 60 * 1000;
/// 僵尸运行的错误文案（用户可见）。
const STALE_RUNNING_RUN_ERROR: &str = "运行被中断（应用退出/崩溃）";

/// 清理僵尸运行（应用退出/崩溃留下的 `running` 行）。
///
/// 判据是 **`started_at` + 心跳**：流式检查点会把 `ai_agent_runs.updated_at` 推进
/// （`ai_stream_checkpoint::persist_ai_stream_checkpoint_with_conn`），所以只要运行还活着，
/// `updated_at` 就在更新，**不会**误伤正在正常跑的长运行。
/// 启动期与首次查询（overview/summary）都会调用；幂等。
pub(crate) fn fail_stale_running_runs(conn: &Connection, now: i64) -> Result<usize, String> {
    let cutoff = now.saturating_sub(STALE_RUNNING_RUN_IDLE_MS);
    let changed = conn
        .execute(
            "UPDATE ai_agent_runs
                SET status='failed',error=?2,finished_at=?3,updated_at=?3
              WHERE status='running' AND started_at<?1 AND updated_at<?1",
            params![cutoff, STALE_RUNNING_RUN_ERROR, now],
        )
        .map_err(|error| error.to_string())?;
    if changed > 0 {
        crate::boot_log(&format!(
            "stale running agent runs marked failed: {changed} (idle > {} min)",
            STALE_RUNNING_RUN_IDLE_MS / 60_000
        ));
    }
    Ok(changed)
}

pub(crate) fn start_ai_automation_worker(app: tauri::AppHandle) {
    let runtime = app.state::<AiAutomationRuntime>().inner().clone();
    if runtime.started.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Ok(conn) = open_automation_database(&app) {
            let now = now_ms();
            let _ = conn.execute(
                "UPDATE ai_agent_runs SET status='failed',error='应用重启，中断了上一次运行',finished_at=?1,
                 next_wake_at=?1+60000,updated_at=?1 WHERE status='running'",
                params![now],
            );
            let _ = conn.execute(
                "UPDATE ai_trade_reviews SET status='queued',error='应用重启，复盘任务将重新运行',updated_at=?1
                 WHERE status='running'",
                params![now],
            );
            // 兜底：进程被杀/崩溃（没有走正常启动路径）时残留的 running 行。
            let _ = fail_stale_running_runs(&conn, now);
            // C20.5（强制迁移版）：启动期把含已下线 id 的旧 Profile 勾选迁移成
            // 「默认 4 角色 + 其余保留 id」（幂等、持久化；失败只记日志，绝不阻断启动）。
            migrate_deprecated_enabled_agents(&conn);
        }
        match crate::trade_commands::recover_pending_trade_executions(&app).await {
            Ok(summary) => {
                if pending_trade_recovery_unknown_count(&summary) > 0 {
                    let _ = app.emit(
                        AUTOMATION_EVENT,
                        json!({
                            "type": "runFailed",
                            "message": "存在重启后仍无法确认的下单或改单请求，请检查执行记录和 OKX 订单",
                            "action": { "tab": "runs" },
                            "recovery": summary
                        }),
                    );
                }
            }
            Err(message) => {
                let _ = app.emit(
                    AUTOMATION_EVENT,
                    json!({
                        "type": "runFailed",
                        "message": format!("交易执行恢复失败：{}", message),
                        "action": { "tab": "runs" }
                    }),
                );
            }
        }
        // Consecutive busy-database ticks. Any completed tick resets it, so only
        // sustained contention is escalated to the user.
        let mut consecutive_contention: u32 = 0;
        loop {
            tokio::select! {
                _ = sleep(Duration::from_secs(2)) => {},
                _ = runtime.notify.notified() => {},
            }
            if let Err(message) = automation_tick(app.clone(), runtime.clone()).await {
                // A busy database is a transient peer conflict, not a failure of
                // this Profile: the next tick a couple of seconds later succeeds.
                // Reporting it as a run failure sent users to the runs tab for
                // something that needed no action, so it is logged and retried
                // instead. Repeated contention still escalates so a genuinely
                // stuck writer stays visible.
                if is_transient_database_contention(&message) {
                    consecutive_contention = consecutive_contention.saturating_add(1);
                    eprintln!(
                        "automation_tick database contention (attempt {consecutive_contention}): {message}"
                    );
                    if consecutive_contention < CONTENTION_ESCALATION_TICKS {
                        sleep(Duration::from_secs(2)).await;
                        continue;
                    }
                }
                let _ = app.emit(
                    AUTOMATION_EVENT,
                    json!({
                        "type": "runFailed",
                        "message": format!("AI 自动化调度异常：{}", message),
                        "action": { "tab": "runs" }
                    }),
                );
                consecutive_contention = 0;
                sleep(Duration::from_secs(5)).await;
            } else {
                consecutive_contention = 0;
            }
        }
    });
}

fn pending_trade_recovery_unknown_count(summary: &Value) -> u64 {
    let unknown_orders = summary.get("unknown").and_then(Value::as_u64).unwrap_or(0);
    let unknown_amends = summary
        .pointer("/amend/unknown")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    unknown_orders.saturating_add(unknown_amends)
}

async fn automation_tick(
    app: tauri::AppHandle,
    runtime: AiAutomationRuntime,
) -> Result<(), String> {
    let conn = open_automation_database(&app)?;
    if !automation_master_enabled_with_conn(&conn) {
        return Ok(());
    }
    let now = now_ms();
    ensure_skill_versions(&app, &conn)?;
    conn.execute(
        "UPDATE ai_wake_conditions SET status='expired',updated_at=?1
         WHERE status='active' AND expires_at IS NOT NULL AND expires_at<=?1",
        params![now],
    )
    .map_err(|err| err.to_string())?;
    enqueue_missing_reviews(&conn)?;
    queue_due_daily_market_reviews(&conn)?;
    queue_due_profile_runs(&conn, now)?;
    evaluate_dynamic_wake_conditions(&app, &runtime, &conn, now)?;

    loop {
        let Ok(permit) = runtime.run_slots.clone().try_acquire_owned() else {
            break;
        };
        if let Some((run, profile, trigger, template_snapshot)) = claim_next_run(&conn, now)? {
            let run_app = app.clone();
            let run_runtime = runtime.clone();
            let failed_run_id = run.id.clone();
            let failed_profile = profile.clone();
            tauri::async_runtime::spawn(async move {
                let _permit = permit;
                if let Err(message) =
                    execute_profile_run(run_app.clone(), run, profile, trigger, template_snapshot)
                        .await
                {
                    if finalize_profile_run_if_needed(
                        &run_app,
                        &failed_run_id,
                        &failed_profile,
                        Some(message.clone()),
                    )
                    .is_err()
                    {
                        let _ = run_app.emit(
                            AUTOMATION_EVENT,
                            json!({ "type": "runFailed", "message": message, "action": { "tab": "runs", "id": failed_run_id } }),
                        );
                    }
                }
                // Drop this Run's private Skill-snapshot workspace on both the
                // success and failure paths.
                crate::storage_config::cleanup_run_scoped_workspace(&failed_run_id);
                run_runtime.notify.notify_one();
            });
            continue;
        }
        if let Some(review) = claim_next_review(&conn, now)? {
            let review_app = app.clone();
            let review_runtime = runtime.clone();
            let failed_review_id = review.id.clone();
            tauri::async_runtime::spawn(async move {
                let _permit = permit;
                if let Err(message) = execute_review_run(review_app.clone(), review).await {
                    let _ = finalize_review_run_if_needed(&review_app, &failed_review_id, &message);
                    let _ = review_app.emit(
                        AUTOMATION_EVENT,
                        json!({ "type": "reviewFailed", "message": message, "action": { "tab": "reviews", "id": failed_review_id } }),
                    );
                }
                // Review Runs key their Skill workspace off the review id.
                crate::storage_config::cleanup_run_scoped_workspace(&failed_review_id);
                review_runtime.notify.notify_one();
            });
            continue;
        }
        drop(permit);
        break;
    }
    Ok(())
}

fn enqueue_missing_reviews(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT account_id,environment FROM position_episodes WHERE status='closed'",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    for (account_id, environment) in rows {
        let _ = enqueue_closed_episode_reviews(conn, &account_id, &environment, None)?;
    }
    Ok(())
}

fn queue_due_daily_market_reviews(conn: &Connection) -> Result<(), String> {
    let review_date = previous_utc_date();
    for profile in load_profiles(conn)?
        .into_iter()
        .filter(|profile| profile.enabled && profile.daily_review_enabled)
    {
        let already_exists = conn
            .query_row(
                "SELECT COUNT(*) FROM ai_daily_market_reviews
                 WHERE profile_id=?1 AND review_date=?2",
                params![profile.id, review_date],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|err| err.to_string())?;
        if already_exists > 0 {
            continue;
        }
        let _ = queue_daily_market_review(conn, &profile, &review_date, "utc_schedule");
    }
    Ok(())
}

fn queue_due_profile_runs(conn: &Connection, now: i64) -> Result<(), String> {
    for profile in load_profiles(conn)?
        .into_iter()
        .filter(|profile| profile.enabled)
    {
        if !profile_rate_limit_allows(conn, &profile, now)? {
            continue;
        }
        let last_run = conn
            .query_row(
                "SELECT started_at,finished_at,next_wake_at
                 FROM ai_agent_runs WHERE profile_id=?1 ORDER BY created_at DESC LIMIT 1",
                params![profile.id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|err| err.to_string())?;
        let due_at = last_run
            .map(|(started_at, finished_at, next_wake_at)| {
                let last_activity = finished_at.unwrap_or(started_at);
                let fallback_due =
                    last_activity.saturating_add(i64::from(profile.scan_interval_minutes) * 60_000);
                next_wake_at
                    .map(|value| value.min(fallback_due))
                    .unwrap_or(fallback_due)
            })
            .unwrap_or(0);
        if due_at <= now {
            let _ = queue_run(conn, &profile.id, "schedule", json!({ "dueAt": due_at }))?;
        }
    }
    Ok(())
}

fn profile_rate_limit_allows(
    conn: &Connection,
    profile: &AiAgentProfileSummary,
    now: i64,
) -> Result<bool, String> {
    let active = conn
        .query_row(
            "SELECT COUNT(*) FROM ai_agent_runs WHERE profile_id=?1 AND status IN ('queued','running')",
            params![profile.id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| err.to_string())?;
    if active > 0 {
        return Ok(false);
    }
    let last_started = conn
        .query_row(
            "SELECT started_at FROM ai_agent_runs WHERE profile_id=?1 ORDER BY created_at DESC LIMIT 1",
            params![profile.id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    if last_started
        .map(|last| now.saturating_sub(last) < i64::from(profile.min_wake_interval_seconds) * 1_000)
        .unwrap_or(false)
    {
        return Ok(false);
    }
    let runs_last_hour = conn
        .query_row(
            "SELECT COUNT(*) FROM ai_agent_runs WHERE profile_id=?1 AND started_at>=?2",
            params![profile.id, now.saturating_sub(3_600_000)],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| err.to_string())?;
    Ok(runs_last_hour < i64::from(profile.max_runs_per_hour))
}

#[derive(Debug, Clone)]
struct ActiveWakeCondition {
    id: String,
    profile_id: String,
    source: String,
    plan_mode: String,
    condition: WakeCondition,
    last_triggered_at: Option<i64>,
    created_at: i64,
}

fn is_intelligence_wake_condition(condition: &WakeCondition) -> bool {
    matches!(
        condition,
        WakeCondition::OpenInterestAnomaly { .. }
            | WakeCondition::TakerFlowImbalance { .. }
            | WakeCondition::CrowdingDivergence { .. }
            | WakeCondition::FundingExtreme { .. }
            | WakeCondition::LiquidationCluster { .. }
            | WakeCondition::ImportantNewsEvent { .. }
            | WakeCondition::SentimentReversal { .. }
            | WakeCondition::SmartMoneyChange { .. }
            | WakeCondition::MacroEventWindow { .. }
    )
}

fn evaluate_dynamic_wake_conditions(
    app: &tauri::AppHandle,
    runtime: &AiAutomationRuntime,
    conn: &Connection,
    now: i64,
) -> Result<(), String> {
    let conditions = load_active_condition_models(conn, now)?;
    if conditions.is_empty() {
        mark_old_domain_events_processed(conn, now)?;
        return Ok(());
    }
    hydrate_feature_cache(runtime, conn, &conditions)?;
    let domain_events = load_pending_domain_events(conn, 500)?;
    let state = build_wake_market_state(app, runtime, &conditions, Vec::new(), now)?;
    let mut groups: HashMap<(String, String, i64, String), Vec<&ActiveWakeCondition>> =
        HashMap::new();
    for condition in &conditions {
        groups
            .entry((
                condition.profile_id.clone(),
                condition.source.clone(),
                condition.created_at,
                condition.plan_mode.clone(),
            ))
            .or_default()
            .push(condition);
    }
    for ((profile_id, source, created_at, mode), items) in groups {
        let profile = match load_profile(conn, &profile_id) {
            Ok(profile) if profile.enabled => profile,
            _ => continue,
        };
        if !profile_rate_limit_allows(conn, &profile, now)? {
            continue;
        }
        if items
            .iter()
            .any(|item| is_intelligence_wake_condition(&item.condition))
            && items
                .iter()
                .filter_map(|item| item.last_triggered_at)
                .max()
                .is_some_and(|last| now.saturating_sub(last) < 30 * 60_000)
        {
            continue;
        }
        let event_cursor = items
            .iter()
            .filter_map(|item| item.last_triggered_at)
            .max()
            .unwrap_or(created_at);
        let mut group_state = state.clone();
        group_state.domain_events = domain_events
            .iter()
            .filter(|event| {
                event.occurred_at > event_cursor
                    && profile
                        .account_id
                        .as_ref()
                        .map(|account_id| {
                            event
                                .account_id
                                .as_deref()
                                .map(|value| value == account_id)
                                .unwrap_or(true)
                        })
                        .unwrap_or(true)
                    && event
                        .inst_id
                        .as_ref()
                        .map(|inst_id| profile.symbols.iter().any(|symbol| symbol == inst_id))
                        .unwrap_or(true)
            })
            .cloned()
            .collect();
        let results = items
            .iter()
            .map(|item| {
                evaluate_condition(
                    &item.condition,
                    &group_state,
                    item.created_at,
                    item.last_triggered_at,
                )
            })
            .collect::<Vec<_>>();
        let matched = if mode == "all" {
            !results.is_empty() && results.iter().all(|value| *value)
        } else {
            results.iter().any(|value| *value)
        };
        if !matched {
            continue;
        }
        let matched_ids = items
            .iter()
            .zip(results.iter())
            .filter_map(|(item, matched)| {
                if *matched {
                    Some(item.id.clone())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        let _ = queue_run(
            conn,
            &profile_id,
            "wake_condition",
            json!({
                "source": source,
                "planCreatedAt": created_at,
                "conditionIds": matched_ids
            }),
        )?;
        for item in items {
            let _ = conn.execute(
                "UPDATE ai_wake_conditions SET last_triggered_at=?2,updated_at=?2 WHERE id=?1",
                params![item.id, now],
            );
        }
    }
    mark_old_domain_events_processed(conn, now)?;
    Ok(())
}

fn load_active_condition_models(
    conn: &Connection,
    now: i64,
) -> Result<Vec<ActiveWakeCondition>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,profile_id,source,plan_mode,condition_type,config_json,expires_at,last_triggered_at,created_at
             FROM ai_wake_conditions WHERE source='agent' AND status='active' AND (expires_at IS NULL OR expires_at>?1)
             ORDER BY created_at ASC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![now], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<i64>>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    let mut result = Vec::new();
    for (
        id,
        profile_id,
        source,
        plan_mode,
        _condition_type,
        config_json,
        _expires_at,
        last_triggered_at,
        created_at,
    ) in rows
    {
        let config = serde_json::from_str::<Value>(&config_json).unwrap_or_else(|_| json!({}));
        match serde_json::from_value::<WakeCondition>(config.clone()) {
            Ok(condition) => result.push(ActiveWakeCondition {
                id,
                profile_id,
                source,
                plan_mode,
                condition,
                last_triggered_at,
                created_at,
            }),
            Err(_) => {
                let _ = conn.execute(
                    "UPDATE ai_wake_conditions SET status='invalid',updated_at=?2 WHERE id=?1",
                    params![id, now],
                );
            }
        }
    }
    Ok(result)
}

fn hydrate_feature_cache(
    runtime: &AiAutomationRuntime,
    conn: &Connection,
    conditions: &[ActiveWakeCondition],
) -> Result<(), String> {
    let mut requests: HashMap<(String, String), usize> = HashMap::new();
    for item in conditions {
        match &item.condition {
            WakeCondition::PriceChangePct {
                inst_id,
                window_minutes,
                ..
            } => {
                requests
                    .entry((inst_id.clone(), "1m".to_string()))
                    .and_modify(|limit| *limit = (*limit).max(*window_minutes as usize + 5))
                    .or_insert(*window_minutes as usize + 5);
            }
            WakeCondition::CandleVolumeRatio {
                inst_id,
                bar,
                lookback,
                ..
            } => {
                requests
                    .entry((inst_id.clone(), bar.clone()))
                    .and_modify(|limit| *limit = (*limit).max(*lookback + 2))
                    .or_insert(*lookback + 2);
            }
            _ => {}
        }
    }
    for ((inst_id, bar), limit) in requests {
        let mut stmt = conn
            .prepare(
                "SELECT open_time,close,volume FROM candles
                 WHERE symbol=?1 AND interval=?2 AND confirm=1 ORDER BY open_time DESC LIMIT ?3",
            )
            .map_err(|err| err.to_string())?;
        let mut rows = stmt
            .query_map(params![inst_id, bar, limit as i64], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        rows.reverse();
        let mut cache = runtime
            .feature_cache
            .lock()
            .map_err(|err| err.to_string())?;
        for (at, close, volume) in rows {
            if let Ok(value) = close.parse::<f64>() {
                cache.record_price(&inst_id, at, value);
            }
            if let Ok(value) = volume.parse::<f64>() {
                cache.record_candle(&inst_id, &bar, at, value);
            }
        }
    }
    Ok(())
}

fn build_wake_market_state(
    app: &tauri::AppHandle,
    runtime: &AiAutomationRuntime,
    conditions: &[ActiveWakeCondition],
    mut domain_events: Vec<DomainEvent>,
    now: i64,
) -> Result<WakeMarketState, String> {
    let market_runtime = app.state::<MarketRuntime>();
    let store = market_runtime.store.lock().map_err(|err| err.to_string())?;
    let tickers = store.tickers.clone();
    let candles = store.candles.clone();
    let funding_rates = store.funding_rates.clone();
    let orderbooks = store.orderbooks.clone();
    let private_snapshots = store.private_snapshots.clone();
    drop(store);

    let mut cache = runtime
        .feature_cache
        .lock()
        .map_err(|err| err.to_string())?;
    for (inst_id, ticker) in &tickers {
        if let Ok(price) = ticker.last.parse::<f64>() {
            cache.record_price(inst_id, ticker.ts.max(now.saturating_sub(1)), price);
        }
    }
    for (key, candle) in &candles {
        if let Some((inst_id, bar)) = key.split_once(':') {
            cache.record_candle(
                inst_id,
                bar,
                candle.time.saturating_mul(1_000),
                candle.volume,
            );
        }
    }
    let mut state = WakeMarketState {
        now_ms: now,
        ..Default::default()
    };
    for inst_id in tickers.keys() {
        if let Some(value) = cache.current_price(inst_id) {
            state.prices.insert(inst_id.clone(), value);
        }
        if let Some(value) = cache.previous_price(inst_id) {
            state.previous_prices.insert(inst_id.clone(), value);
        }
    }
    for item in conditions {
        match &item.condition {
            WakeCondition::PriceChangePct {
                inst_id,
                window_minutes,
                ..
            } => {
                if let Some(value) = cache.price_change_pct(inst_id, *window_minutes, now) {
                    state
                        .price_changes_pct
                        .insert((inst_id.clone(), *window_minutes), value);
                }
            }
            WakeCondition::CandleVolumeRatio {
                inst_id,
                bar,
                lookback,
                ..
            } => {
                if let Some(value) = cache.candle_volume_ratio(inst_id, bar, *lookback) {
                    state
                        .candle_volume_ratios
                        .insert((inst_id.clone(), bar.clone(), *lookback), value);
                }
            }
            WakeCondition::OrderbookImbalance { inst_id, depth, .. } => {
                if let Some(book) = orderbooks.get(inst_id) {
                    let bids = book
                        .bids
                        .iter()
                        .filter_map(|level| level.sz.parse::<f64>().ok())
                        .collect::<Vec<_>>();
                    let asks = book
                        .asks
                        .iter()
                        .filter_map(|level| level.sz.parse::<f64>().ok())
                        .collect::<Vec<_>>();
                    if let Some(value) = orderbook_imbalance(&bids, &asks, *depth) {
                        state
                            .orderbook_imbalances
                            .insert((inst_id.clone(), *depth), value);
                    }
                }
            }
            _ => {}
        }
    }
    drop(cache);
    for (inst_id, funding) in funding_rates {
        if let Ok(value) = funding.funding_rate.parse::<f64>() {
            state.funding_rates.insert(inst_id, value);
        }
    }
    let detected_events = detect_private_snapshot_events(runtime, private_snapshots, now)?;
    if !detected_events.is_empty() {
        let conn = open_automation_database(app)?;
        for event in &detected_events {
            record_domain_event_with_conn(&conn, event, json!({ "source": "private_snapshot" }))?;
        }
    }
    domain_events.extend(detected_events);
    state.domain_events = domain_events;
    Ok(state)
}

fn detect_private_snapshot_events(
    runtime: &AiAutomationRuntime,
    snapshots: HashMap<String, PrivateAccountSnapshot>,
    now: i64,
) -> Result<Vec<DomainEvent>, String> {
    let mut result = Vec::new();
    let mut fingerprints = runtime
        .private_fingerprints
        .lock()
        .map_err(|err| err.to_string())?;
    for (_, snapshot) in snapshots {
        let orders = serde_json::to_string(&snapshot.orders).unwrap_or_else(|_| "[]".to_string());
        let positions =
            serde_json::to_string(&snapshot.positions).unwrap_or_else(|_| "[]".to_string());
        let key = format!("{}:{}", snapshot.account_id, snapshot.environment);
        if let Some((previous_orders, previous_positions)) = fingerprints.get(&key) {
            if previous_orders != &orders {
                let previous = serde_json::from_str::<Vec<OkxPendingOrder>>(previous_orders)
                    .unwrap_or_default();
                let previous_by_id = previous
                    .into_iter()
                    .map(|order| (private_order_key(&order), order))
                    .collect::<HashMap<_, _>>();
                let current_by_id = snapshot
                    .orders
                    .iter()
                    .cloned()
                    .map(|order| (private_order_key(&order), order))
                    .collect::<HashMap<_, _>>();
                for (order_id, order) in &current_by_id {
                    let changed = previous_by_id
                        .get(order_id)
                        .map(|previous| {
                            previous.state != order.state
                                || previous.acc_fill_sz != order.acc_fill_sz
                        })
                        .unwrap_or(true);
                    if changed {
                        result.push(DomainEvent {
                            event_type: "order_state_changed".to_string(),
                            account_id: Some(snapshot.account_id.clone()),
                            inst_id: Some(order.inst_id.clone()),
                            state: Some(if order.state.trim().is_empty() {
                                "live".to_string()
                            } else {
                                order.state.clone()
                            }),
                            occurred_at: now,
                            ..Default::default()
                        });
                    }
                }
                for (order_id, order) in previous_by_id {
                    if !current_by_id.contains_key(&order_id) {
                        result.push(DomainEvent {
                            event_type: "order_state_changed".to_string(),
                            account_id: Some(snapshot.account_id.clone()),
                            inst_id: Some(order.inst_id),
                            state: Some("removed".to_string()),
                            occurred_at: now,
                            ..Default::default()
                        });
                    }
                }
            }
            if previous_positions != &positions {
                let previous = serde_json::from_str::<Vec<OkxPosition>>(previous_positions)
                    .unwrap_or_default();
                let previous_by_id = previous
                    .into_iter()
                    .map(|position| (private_position_key(&position), position))
                    .collect::<HashMap<_, _>>();
                let current_by_id = snapshot
                    .positions
                    .iter()
                    .cloned()
                    .map(|position| (private_position_key(&position), position))
                    .collect::<HashMap<_, _>>();
                for (position_id, position) in &current_by_id {
                    let state = match previous_by_id.get(position_id) {
                        None => "opened",
                        Some(previous) if previous.pos != position.pos => "changed",
                        Some(_) => continue,
                    };
                    result.push(DomainEvent {
                        event_type: "position_changed".to_string(),
                        account_id: Some(snapshot.account_id.clone()),
                        inst_id: Some(position.inst_id.clone()),
                        state: Some(state.to_string()),
                        occurred_at: now,
                        ..Default::default()
                    });
                }
                for (position_id, position) in previous_by_id {
                    if !current_by_id.contains_key(&position_id) {
                        result.push(DomainEvent {
                            event_type: "position_changed".to_string(),
                            account_id: Some(snapshot.account_id.clone()),
                            inst_id: Some(position.inst_id),
                            state: Some("closed".to_string()),
                            occurred_at: now,
                            ..Default::default()
                        });
                    }
                }
            }
        }
        fingerprints.insert(key, (orders, positions));
    }
    Ok(result)
}

fn private_order_key(order: &OkxPendingOrder) -> String {
    optional_string(order.ord_id.clone())
        .or_else(|| optional_string(order.algo_id.clone()))
        .or_else(|| optional_string(order.cl_ord_id.clone()))
        .or_else(|| optional_string(order.algo_cl_ord_id.clone()))
        .unwrap_or_else(|| format!("{}:{}:{}", order.inst_id, order.side, order.c_time))
}

fn private_position_key(position: &OkxPosition) -> String {
    optional_string(position.pos_id.clone()).unwrap_or_else(|| {
        format!(
            "{}:{}:{}",
            position.inst_id, position.pos_side, position.mgn_mode
        )
    })
}

fn load_pending_domain_events(conn: &Connection, limit: i64) -> Result<Vec<DomainEvent>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT event_type,account_id,inst_id,opportunity_id,episode_id,state,occurred_at
             FROM ai_domain_events WHERE processed_at IS NULL ORDER BY occurred_at ASC LIMIT ?1",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![limit], |row| {
            Ok(DomainEvent {
                event_type: row.get(0)?,
                account_id: row.get(1)?,
                inst_id: row.get(2)?,
                opportunity_id: row.get(3)?,
                episode_id: row.get(4)?,
                state: row.get(5)?,
                occurred_at: row.get(6)?,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn mark_old_domain_events_processed(conn: &Connection, now: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE ai_domain_events SET processed_at=?1 WHERE processed_at IS NULL AND occurred_at<?2",
        params![now, now.saturating_sub(86_400_000)],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn claim_next_run(
    conn: &Connection,
    now: i64,
) -> Result<
    Option<(
        AiAgentRunSummary,
        AiAgentProfileSummary,
        Value,
        Option<String>,
    )>,
    String,
> {
    if !automation_master_enabled_with_conn(conn) {
        return Ok(None);
    }
    let row = conn
        .query_row(
            "SELECT r.id,r.profile_id,r.trigger_json,r.profile_snapshot_json,r.skill_versions_json
             FROM ai_agent_runs r
             JOIN ai_agent_profiles p ON p.id=r.profile_id
             WHERE r.status='queued' AND p.enabled=1 AND p.deleted_at IS NULL
             ORDER BY r.created_at ASC LIMIT 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let Some((run_id, profile_id, trigger_json, profile_snapshot_json, run_skill_versions_json)) =
        row
    else {
        return Ok(None);
    };
    let template_snapshot_json = conn
        .query_row(
            "SELECT template_snapshot_json FROM ai_agent_runs WHERE id=?1",
            params![run_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten();
    let profile_result = match profile_snapshot_json {
        Some(snapshot) => serde_json::from_str::<AiAgentProfileSummary>(&snapshot)
            .map_err(|error| format!("Run {run_id} 的 Profile 快照解析失败：{error}"))
            .and_then(validate_profile_snapshot),
        None => load_profile(conn, &profile_id),
    };
    let mut profile = match profile_result {
        Ok(profile) => profile,
        Err(error) => {
            let message = format!("Run Profile 快照无效：{error}");
            conn.execute(
                "UPDATE ai_agent_runs SET status='failed',error=?2,finished_at=?3,updated_at=?3
                 WHERE id=?1 AND status='queued'",
                params![run_id, message, now],
            )
            .map_err(|db_error| db_error.to_string())?;
            conn.execute(
                "UPDATE ai_daily_market_reviews SET status='failed',error=?2,updated_at=?3
                 WHERE run_id=?1 AND status='queued'",
                params![run_id, message, now],
            )
            .map_err(|db_error| db_error.to_string())?;
            return Err(message);
        }
    };
    let run_skill_versions = from_json_or_default::<HashMap<String, u32>>(&run_skill_versions_json);
    if !run_skill_versions.is_empty() {
        profile.skill_versions = run_skill_versions.clone();
        profile.skill_version_modes = run_skill_versions
            .keys()
            .map(|skill_id| (skill_id.clone(), "pinned".to_string()))
            .collect();
    }
    let changed = conn
        .execute(
            "UPDATE ai_agent_runs SET status='running',started_at=?2,updated_at=?2 WHERE id=?1 AND status='queued'",
            params![run_id, now],
        )
        .map_err(|err| err.to_string())?;
    if changed == 0 {
        return Ok(None);
    }
    conn.execute(
        "UPDATE ai_daily_market_reviews SET status='running',updated_at=?2
         WHERE run_id=?1 AND status='queued'",
        params![run_id, now],
    )
    .map_err(|err| err.to_string())?;
    let run = load_run(conn, &run_id)?;
    let trigger = trigger_json
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_else(|| json!({}));
    Ok(Some((run, profile, trigger, template_snapshot_json)))
}

async fn execute_profile_run(
    app: tauri::AppHandle,
    run: AiAgentRunSummary,
    mut profile: AiAgentProfileSummary,
    mut trigger: Value,
    // 旧模板快照（只读历史字段）：v3 不再用它注入提示词。
    _template_snapshot: Option<String>,
) -> Result<(), String> {
    let is_intelligence_briefing = run.trigger_type == "intelligence_briefing";
    let is_daily_market_review = run.trigger_type == "daily_market_review";
    if is_intelligence_briefing || is_daily_market_review {
        profile.mode = desic_agent_automation::ADVISOR_MODE.to_string();
        profile.allowed_wake_condition_types.clear();
    }
    let mut skill_definitions = resolve_profile_skill_snapshot(&app, &mut profile)?;
    // C24.1/C24.2：本次运行生效的单 Agent 子模式（协作开启时恒为 standard）。
    let single_agent_mode = effective_single_agent_mode(
        profile.collaboration_enabled,
        Some(profile.single_agent_mode.as_str()),
    );
    // C24.2：极简模式下**不下发** C21 排版小节（换成一句话规则），从源头消除指令冲突。
    apply_single_agent_mode_to_skill_definitions(&mut skill_definitions, &single_agent_mode);
    let session_id = format!("background:{}", run.id);
    let message_id = format!("background-message:{}", run.id);
    let shanghai_offset = chrono::FixedOffset::east_opt(8 * 60 * 60)
        .ok_or_else(|| "无法构造 Asia/Shanghai 时区".to_string())?;
    let current_time = chrono::Utc::now()
        .with_timezone(&shanghai_offset)
        .format("%Y-%m-%d %H:%M:%S UTC+8")
        .to_string();
    let current_timestamp_ms = now_ms();
    let prompt_locale = trigger
        .get("promptLocale")
        .and_then(Value::as_str)
        .filter(|value| {
            matches!(
                *value,
                "zh-CN"
                    | "zh-TW"
                    | "en-US"
                    | "ja-JP"
                    | "ko-KR"
                    | "de-DE"
                    | "fr-FR"
                    | "es-ES"
                    | "pt-BR"
                    | "ru-RU"
            )
        })
        .map(str::to_string)
        .unwrap_or_else(crate::storage_config::automation_prompt_locale);
    if trigger.get("promptLocale").and_then(Value::as_str) != Some(prompt_locale.as_str()) {
        if !trigger.is_object() {
            trigger = json!({ "originalTrigger": trigger });
        }
        trigger["promptLocale"] = json!(prompt_locale);
        if let Ok(conn) = open_automation_database(&app) {
            let _ = conn.execute(
                "UPDATE ai_agent_runs SET trigger_json=?2,updated_at=?3 WHERE id=?1",
                params![run.id, trigger.to_string(), current_timestamp_ms],
            );
        }
    }
    let response_instruction = automation_response_instruction(&prompt_locale);
    let chinese_prompt = automation_prompt_uses_chinese(&prompt_locale);
    let intelligence_runtime = app.state::<IntelligenceRuntime>();
    crate::intelligence::mark_active_instruments(intelligence_runtime.inner(), &profile.symbols);
    crate::intelligence::queue_active_intelligence_refresh(
        app.clone(),
        intelligence_runtime.inner().clone(),
    );
    let baseline_snapshots = profile
        .symbols
        .iter()
        .map(|inst_id| {
            (
                inst_id.clone(),
                capture_trade_opportunity_market_snapshot(
                    app.state::<MarketRuntime>().inner(),
                    inst_id,
                ),
            )
        })
        .collect::<serde_json::Map<String, Value>>();
    if let Ok(conn) = open_automation_database(&app) {
        let baseline = json!({
            "capturedAt": current_timestamp_ms,
            "symbols": baseline_snapshots,
        });
        let _ = conn.execute(
            "UPDATE ai_agent_runs SET initial_market_snapshot_json=?2,updated_at=?3 WHERE id=?1",
            params![run.id, baseline.to_string(), current_timestamp_ms],
        );
    }
    let daily_candle_query = trigger
        .get("windowStart")
        .and_then(Value::as_i64)
        .zip(trigger.get("windowEnd").and_then(Value::as_i64))
        .map(|(start, end_exclusive)| {
            if chinese_prompt {
                format!(
                    "startTime={}，endTime={}（windowEnd 为开区间，K 线工具 endTime 为闭区间）",
                    start,
                    end_exclusive.saturating_sub(1)
                )
            } else {
                format!(
                    "startTime={}, endTime={} (windowEnd is exclusive; the candle tool endTime is inclusive)",
                    start,
                    end_exclusive.saturating_sub(1)
                )
            }
        })
        .unwrap_or_else(|| {
            if chinese_prompt {
                "使用复盘上下文中的 UTC 毫秒时间窗".to_string()
            } else {
                "Use the UTC millisecond window from the review context".to_string()
            }
        });
    // C19：试判阶段状态。简报/复盘类 trigger 直接豁免（生效 mode=off，不下发 triage）。
    let triage_state = {
        let config = triage_config_for_run(&profile.triage, &run.trigger_type);
        let mut state = crate::ai_triage::RunTriageState::new(
            config,
            profile.triage_skip_streak,
            profile.triage_last_deep_at,
            now_ms(),
        );
        // 抽样复检的判定单元：用运行时间戳的毫秒尾数（确定可测，且无需额外随机源）。
        state.sample_unit = (now_ms().rem_euclid(1_000) as f64) / 1_000.0;
        state
    };
    let triage_instruction = {
        let state = triage_state.clone();
        if state.config.is_off() {
            String::new()
        } else if chinese_prompt {
            format!(
                "\n本次运行启用试判阶段（triage.mode={}）：先用只读工具（market / account / intelligence / radar）判断是否有必要做深度分析，然后用 background.reportTriage 提交结论（escalate + reasons + evidence + nextWakePlan）。未提交结论前不得点名专家；判定跳过时必须给出 nextWakePlan（status=skipped）。硬升级清单由后端预判：命中即强制深度，你的 escalate=false 会被否决并在返回里写明 forcedBy。抽样复检（skipSampleRate={:.2}）命中时即使判定跳过也会执行深度。",
                state.config.mode, state.config.skip_sample_rate
            )
        } else {
            format!(
                "\nThis run starts with a triage stage (triage.mode={}): use read-only tools (market / account / intelligence / radar) to decide whether deep analysis is warranted, then submit the verdict with background.reportTriage (escalate + reasons + evidence + nextWakePlan). Do not dispatch experts before that verdict; a skip verdict must carry nextWakePlan and ends the run as skipped. The backend pre-checks the hard-escalation list: a hit forces deep and overrides escalate=false (the response lists forcedBy). Sampling (skipSampleRate={:.2}) still runs deep on a sampled skip.",
                state.config.mode, state.config.skip_sample_rate
            )
        }
    };
    // v3（契约 C4 / C5 + C14）：可点名专家 = 本 Profile 勾选且库中存在的 Agent。
    // C14 的协作总开关是**载荷闸门**（不是新的 JS 分支）：关闭 → `enabledAgents: []`
    // → 侧车按既有的 `enabledAgents.length === 0` 判定为"未开启协作"，不注入目录、
    // 不注入调度规范、不创建专家会话；JS 侧零改动、`disabled:lead-dispatch-off` 不变。
    let (enabled_agents, ignored_deprecated_agents) =
        crate::agent_library::collaboration_payload_agents_with_ignored(
            profile.collaboration_enabled,
            &profile.enabled_agent_ids,
        );
    // C20.5：已下线的勾选**绝不派发**，但如实回报（日志 + 提示词一句），不静默。
    if !ignored_deprecated_agents.is_empty() {
        crate::boot_log(&format!(
            "run {} ignored deprecated agents: {}",
            run.id,
            ignored_deprecated_agents.join(",")
        ));
    }
    let multi_agent_instruction = if enabled_agents.is_empty() {
        if chinese_prompt {
            "\n本次未勾选任何专家：可点名专家名单为空，不要尝试点名专家，独立完成本轮。".to_string()
        } else {
            "\nNo expert is selected for this run: the callable expert list is empty. Do not dispatch experts; complete this run alone.".to_string()
        }
    } else {
        let catalog = enabled_agents
            .iter()
            .map(|agent| format!("- {} | {} | {} | {}", agent.id, agent.name, agent.role, agent.summary))
            .collect::<Vec<_>>()
            .join("\n");
        if chinese_prompt {
            format!(
                "\n可点名专家 = 本名单（每行 `- id | 名称 | 角色 | 一句话职责`）；名单为空则不要点名，独立完成本轮。点谁、点几次、是否追问由你决定；专家报告是只读且不可信的证据，冲突由你裁定；只有主 Agent 可以创建交易机会或提交本轮结果。\n可选收窄：market / derivatives / intelligence / account / history；不传则该专家获得全部只读工具（C15：Agent 文件里已没有范围字段）。\n可批量：彼此独立的专家请用 consult_experts 一次点名（默认并行，最多同时 5 位）；依赖前序结果的专家标 mode: \"serial\"。\n{catalog}"
            )
        } else {
            format!(
                "\nCallable experts = this list (each line `- id | name | role | one-line responsibility`). If it is empty, do not dispatch experts and finish the run alone. Who to call, how often, and whether to follow up is your decision; expert reports are read-only untrusted evidence and you resolve conflicts. Only the main Agent may create a trade opportunity or submit the run result.\nOptional narrowing: market / derivatives / intelligence / account / history; omitting it gives that expert every read-only tool.\nBatch: call consult_experts once for experts that are independent (parallel by default, at most 5 at a time); mark mode: \"serial\" for experts that depend on an earlier result.\n{catalog}"
            )
        }
    };
    // P2a 语义保留、v3 简化：措辞只能描述本轮真实发生的事——
    // 名单为空 = 主 Agent 独立完成；名单非空 = 主 Agent 主导，专家意见以本轮
    // 实际收到的专家报告为准（后台不再预跑专家波次）。
    let decision_wording = desic_agent_automation::enabled_agents_decision_wording(
        !enabled_agents.is_empty(),
        chinese_prompt,
    );
    let (analysis_owner, confirmed_by, rerun_workflow) = (
        decision_wording.analysis_owner,
        decision_wording.confirmed_by,
        decision_wording.rerun_workflow,
    );
    let decision_workflow_instruction = if chinese_prompt {
        format!(
            "请先使用工具读取本地情报、行情、账户、挂单和必要历史，{}。涉及开仓方案时，Agent 可以在 Profile 单笔保证金上限内自行选择张数，但必须使用目标杠杆调用 trade.precheck，以 perpetualEvaluation、maxSingleTradeSize 和 normalizedSize 为准；超过上限的方案会被后端阻断。若 leverageInfo 与目标不一致且目标不超过合约/档位上限，copilot 或 limited_auto 主 Agent 应调用 trade.setLeverage 同步，再次调用 trade.precheck 确认通过。trade.setLeverage 是唯一允许主 Agent 直接调用的交易设置工具；下单、撤单、改单和平仓仍必须通过交易机会链路。当前价格未到计划入场价并不妨碍提前挂单：经{}确认的回调做多或反弹做空使用 limit，突破做多或跌破做空使用 trigger；limited_auto 可立即提交为等待成交或触发的 OKX 订单。只有仍依赖未来闭合 K 线、OI、主动流等复合证据时才等待唤醒后{}。只有形成字段完整、准备通过 tradeOpportunity.create 提交的可执行候选时，主 Agent 才使用完整候选参数调用 market.readDecisionContext，独立取得当场行情、账户、杠杆、挂单、预检和本轮起止差异。若结论是 wait 或 abandon 且本轮没有新交易候选，不调用 market.readDecisionContext，直接通过 background.finishRun 结束；不得使用 size=0、缺失 price 或其它占位参数伪造候选。open/close 的 size 必须大于 0，limit/trigger 必须提供 price。revise 后必须用修改后的完整参数重新复核；上下文 60 秒内未用于机会操作就必须重新读取。确认最后一次复核通过后，调用 tradeOpportunity.create 提交系统已经冻结的候选；不要再次抄写候选字段，也不要提交或生成 decisionContextId。limited_auto 模式由后端按 Profile 权限自动批准并执行。",
            analysis_owner, confirmed_by, rerun_workflow,
        )
    } else {
        format!(
            "First use tools to read local intelligence, market data, account state, open orders, and necessary history; {}. For an opening plan, the Agent may choose a contract quantity within the Profile's per-trade margin limit, but it must call trade.precheck with the target leverage and rely on perpetualEvaluation, maxSingleTradeSize, and normalizedSize. The backend blocks plans above the limit. If leverageInfo differs from the target and the target is within instrument and tier limits, the copilot or limited_auto main Agent should call trade.setLeverage, then call trade.precheck again. trade.setLeverage is the only trading-setting tool the main Agent may call directly; placing, cancelling, amending, and closing orders must still go through the trade-opportunity workflow. A planned entry may be submitted before price reaches it: a pullback long or rebound short confirmed by {} uses limit, while a breakout long or breakdown short uses trigger. limited_auto may submit it immediately as an OKX order waiting for fill or trigger. Wait and wake after {} only when the decision still depends on future closed candles, OI, taker flow, or other composite evidence. Call market.readDecisionContext with the complete candidate only after forming a fully specified executable candidate that is ready for tradeOpportunity.create; it independently captures current market, account, leverage, open-order, precheck, and run-delta evidence. If the conclusion is wait or abandon and there is no new candidate, do not call market.readDecisionContext. Finish directly with background.finishRun. Never fabricate a candidate with size=0, a missing price, or placeholder values. open/close size must be greater than 0, and limit/trigger must provide price. After revise, recheck the complete revised parameters. If a context is not consumed by an opportunity action within 60 seconds, read it again. After the final review passes, call tradeOpportunity.create to submit the candidate already frozen by the system. Do not copy candidate fields again and do not submit or invent decisionContextId. In limited_auto, the backend approves and executes according to Profile permissions.",
            analysis_owner, confirmed_by, rerun_workflow,
        )
    };
    let prompt = if is_intelligence_briefing {
        if chinese_prompt {
            format!(
                "{}\n你正在生成 Desic Terminal 每日市场简报。\n当前时间: {}\n当前 Unix 毫秒时间戳: {}\nProfile: {}\n权限模式: advisor（系统强制只读）\n关注品种: {}\n简报上下文: {}\n依次读取隔夜重要新闻事件、市场反应、宏观日历、情绪、衍生品仓位/OI、净主动流、拥挤度、资金费率与基差、Smart Money、异常和系统风险。输出 Markdown，固定包含：隔夜市场、重要事件、宏观窗口、衍生品仓位、Smart Money、异常、证据冲突、数据缺口、今日观察。每条关键结论标注本地记录 ID、时间和来源。不得创建或修改交易机会，不得调用交易工具。完成后调用 background.finishRun，summary 填完整简报正文，nextWakePlan 使用 mode=any 且 conditions 为空。",
                response_instruction,
                current_time,
                current_timestamp_ms,
                profile.name,
                profile.symbols.join(", "),
                trigger,
            )
        } else {
            format!(
                "{}\nYou are generating the Desic Terminal daily market briefing.\nCurrent time: {}\nCurrent Unix timestamp in milliseconds: {}\nProfile: {}\nPermission mode: advisor (system-enforced read-only)\nWatched markets: {}\nBriefing context: {}\nRead, in order, important overnight news events, market reactions, the macro calendar, sentiment, derivatives positioning and OI, net taker flow, crowding, funding and basis, Smart Money, anomalies, and system risk. Produce Markdown with these sections: Overnight Market, Important Events, Macro Window, Derivatives Positioning, Smart Money, Anomalies, Evidence Conflicts, Data Gaps, and Today's Watch. Cite the local record ID, time, and source for each important conclusion. Do not create or modify trade opportunities and do not call trading tools. When complete, call background.finishRun with the full briefing in summary and nextWakePlan set to mode=any with an empty conditions array.",
                response_instruction,
                current_time,
                current_timestamp_ms,
                profile.name,
                profile.symbols.join(", "),
                trigger,
            )
        }
    } else if is_daily_market_review {
        if chinese_prompt {
            format!(
                "{}\n你正在执行 Desic Terminal 每日市场复盘。\n当前时间: {}\n当前 Unix 毫秒时间戳: {}\nProfile: {}\n权限模式: advisor（系统强制只读）\n关注品种: {}\n复盘日期与 UTC 数据窗口: {}\n只分析该 UTC 自然日内的市场表现。对每个关注品种，优先一次调用 market.readCandles，使用 bars=[\"5m\",\"15m\",\"1H\",\"4H\",\"1D\"]、limit=300、confirmedOnly=true，时间参数固定为 {}。startTime/endTime 均为 13 位 Unix 毫秒时间戳；除 1m 外的周期由合并后的本地与内存 1m K 线聚合生成。工具返回 count=0 或 stale=true 时必须报告对应周期缺失或尾部不完整，并引用 staleReason/refreshStatus；不得因未直接存储 5m/15m 而判断不可用，也不得去掉时间窗后用其他日期的数据替代。{}\n随后读取成交、盘口、资金费率、持仓量、主动买卖流、重要新闻及可用的 Smart Money 证据。输出 Markdown，优先按市场概览、价格结构、波动与成交、衍生品状态、重要事件、关键价位、证据冲突、数据缺口、后续观察组织；可以合并含义重复的章节，但不得省略关键事实和数据限制。明确区分事实、推断和复盘结论；不要把复盘写成实时交易建议。不得创建或修改交易机会，不得调用交易、通知或提醒工具。完成后调用 background.finishRun，summary 填完整复盘正文，nextWakePlan 使用 mode=any 且 conditions 为空。",
                response_instruction,
                current_time,
                current_timestamp_ms,
                profile.name,
                profile.symbols.join(", "),
                trigger,
                daily_candle_query,
                DAILY_MARKET_REVIEW_EVIDENCE_RULES,
            )
        } else {
            format!(
                "{}\nYou are running the Desic Terminal daily market review.\nCurrent time: {}\nCurrent Unix timestamp in milliseconds: {}\nProfile: {}\nPermission mode: advisor (system-enforced read-only)\nWatched markets: {}\nReview date and UTC data window: {}\nAnalyze only market behavior inside that UTC calendar day. For each watched market, prefer one market.readCandles call with bars=[\"5m\",\"15m\",\"1H\",\"4H\",\"1D\"], limit=300, confirmedOnly=true, and the fixed time parameters {}. startTime and endTime are 13-digit Unix millisecond timestamps. Timeframes other than 1m are aggregated from merged local and in-memory 1m candles. If the tool returns count=0 or stale=true, report the missing timeframe or incomplete tail and cite staleReason/refreshStatus. Do not mark 5m/15m unavailable merely because they are not stored directly, and do not remove the time window to substitute another date. {}\nThen read fills, order book, funding, open interest, taker flow, important news, and available Smart Money evidence. Produce Markdown organized primarily as Market Overview, Price Structure, Volatility and Volume, Derivatives State, Important Events, Key Levels, Evidence Conflicts, Data Gaps, and Follow-up Watch. You may merge redundant sections, but must retain important facts and data limitations. Clearly distinguish facts, inference, and review conclusions. Do not turn the review into real-time trading advice. Do not create or modify trade opportunities, and do not call trading, notification, or alert tools. When complete, call background.finishRun with the full review in summary and nextWakePlan set to mode=any with an empty conditions array.",
                response_instruction,
                current_time,
                current_timestamp_ms,
                profile.name,
                profile.symbols.join(", "),
                trigger,
                daily_candle_query,
                DAILY_MARKET_REVIEW_EVIDENCE_RULES_EN,
            )
        }
    } else if chinese_prompt {
        format!(
            "{}\n你正在执行 Desic Terminal 后台 Agent Profile。\n当前时间: {}\n当前 Unix 毫秒时间戳: {}\nProfile: {}\n模式: {}\n账号: {}\n环境: {}\n目标杠杆: {}X\n最大单笔开仓保证金: USDT 权益的 {}%（且不超过可用 USDT）\n关注品种: {}\n默认历史回看: 最近 {} 天\n触发原因: {}{}\n{}\n{}\n{}\n{}\n所有工作完成后必须调用 background.finishRun；只提交 summary、语义化 finalDecision（outcome/reason/reasonCodes）和 nextWakePlan。实际机会 ID、最终复核 ID、账户可行/阻断状态和 blockers 均由后端从本 Run 的持久化记录生成，不要自行填写。最终摘要同样必须遵守账户风险字段语义，不能把账户余额、minSz或名义敞口比例写成账户容错不足。最后给出下一组适合当前市场阶段的类型化观察条件；新条件会替换上一轮 Agent 条件。nextWakePlan.expiresAt 和 timer.atMs 必须使用 13 位 Unix 毫秒时间戳（与 Date.now() 相同单位），不能使用 10 位秒级时间戳；不需要过期时间时可以省略 expiresAt。不要在正文中假装完成该工具。",
            response_instruction,
            current_time,
            current_timestamp_ms,
            profile.name,
            profile.mode,
            profile.account_id.as_deref().unwrap_or("未绑定"),
            profile.environment,
            profile.target_leverage,
            profile.max_single_trade_margin_pct,
            profile.symbols.join(", "),
            profile.history_lookback_days,
            trigger,
            multi_agent_instruction,
            triage_instruction,
            PERPETUAL_ACCOUNT_RISK_LANGUAGE_RULES,
            EXISTING_POSITION_MANAGEMENT_RULES,
            decision_workflow_instruction,
        )
    } else {
        format!(
            "{}\nYou are running a Desic Terminal background Agent Profile.\nCurrent time: {}\nCurrent Unix timestamp in milliseconds: {}\nProfile: {}\nMode: {}\nAccount: {}\nEnvironment: {}\nTarget leverage: {}X\nMaximum opening margin per trade: {}% of USDT equity, capped by available USDT\nWatched markets: {}\nDefault history lookback: the latest {} days\nTrigger: {}{}\n{}\n{}\n{}\n{}\nAfter all work is complete, you must call background.finishRun. Submit only summary, semantic finalDecision fields (outcome/reason/reasonCodes), and nextWakePlan. The backend derives actual opportunity IDs, final-review IDs, account feasibility or block status, and blockers from persisted records for this Run; do not fill them yourself. The final summary must follow the same account-risk field semantics and must not describe balance, minSz, or notional exposure percentage as insufficient account tolerance. End with the next typed observation conditions appropriate for the current market regime; the new conditions replace the previous Agent conditions. nextWakePlan.expiresAt and timer.atMs must use 13-digit Unix millisecond timestamps, the same unit as Date.now(), never 10-digit seconds. Omit expiresAt when no expiry is needed. Do not claim in prose that the completion tool was called.",
            response_instruction,
            current_time,
            current_timestamp_ms,
            profile.name,
            profile.mode,
            profile.account_id.as_deref().unwrap_or("unbound"),
            profile.environment,
            profile.target_leverage,
            profile.max_single_trade_margin_pct,
            profile.symbols.join(", "),
            profile.history_lookback_days,
            trigger,
            multi_agent_instruction,
            triage_instruction,
            PERPETUAL_ACCOUNT_RISK_LANGUAGE_RULES_EN,
            EXISTING_POSITION_MANAGEMENT_RULES_EN,
            decision_workflow_instruction,
        )
    };
    // v3：旧 Agent 模板（ai_agent_schemes）已删除，方案级 instructions 不再注入；
    // 历史快照里的 templateSnapshot 仅作只读展示，不参与提示词。
    let prompt = prompt;
    {
        let conn = open_automation_database(&app)?;
        upsert_ai_session(
            &conn,
            &session_id,
            &format!(
                "{} · {}",
                if chinese_prompt {
                    "后台 Agent"
                } else {
                    "Background Agent"
                },
                profile.name
            ),
            "running",
        )?;
        upsert_ai_message(
            &conn,
            &message_id,
            &session_id,
            "user",
            &prompt,
            None,
            None,
            Some("sent"),
        )?;
    }
    let context = BackgroundRunContext {
        permission_mode: profile.mode.clone(),
        account_id: profile.account_id.clone(),
        environment: Some(profile.environment.clone()),
        symbols: profile.symbols.clone(),
        profile_id: Some(profile.id.clone()),
        run_id: Some(run.id.clone()),
        enabled_skills: profile.skill_ids.clone(),
        skill_versions: profile.skill_versions.clone(),
        skill_definitions,
        model: profile.model.clone(),
        reasoning_depth: profile.reasoning_depth.clone(),
        history_lookback_days: profile.history_lookback_days,
        target_leverage: profile.target_leverage,
        max_single_trade_margin_pct: profile.max_single_trade_margin_pct,
        allowed_wake_condition_types: profile.allowed_wake_condition_types.clone(),
        enabled_agents,
        triage: Arc::new(Mutex::new(triage_state)),
        finish_gate: Arc::new(Mutex::new(FinishGateState::default())),
        single_agent_mode,

        trigger: trigger.clone(),
        review_id: None,
        episode_id: None,
    };
    let ai_runtime = app.state::<AiRuntime>().inner().clone();
    let stream_error = run_ai_stream(
        app.clone(),
        ai_runtime,
        session_id,
        vec![AiChatMessage {
            id: Some(message_id),
            role: "user".to_string(),
            content: prompt,
        }],
        Some(context),
        None,
    )
    .await
    .err();
    finalize_profile_run_if_needed(&app, &run.id, &profile, stream_error)
}

fn finalize_profile_run_if_needed(
    app: &tauri::AppHandle,
    run_id: &str,
    profile: &AiAgentProfileSummary,
    stream_error: Option<String>,
) -> Result<(), String> {
    let conn = open_automation_database(app)?;
    let status = conn
        .query_row(
            "SELECT status FROM ai_agent_runs WHERE id=?1",
            params![run_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|err| err.to_string())?;
    if matches!(status.as_str(), "completed" | "cancelled") {
        return Ok(());
    }
    let message = stream_error.unwrap_or_else(|| {
        load_background_finish_failure(&conn, run_id)
            .unwrap_or_else(|| "后台 Agent 未调用 background.finishRun".to_string())
    });
    let now = now_ms();
    let failed_count = conn
        .query_row(
            "SELECT COUNT(*) FROM ai_agent_runs WHERE profile_id=?1 AND status='failed' AND started_at>=?2",
            params![profile.id, now.saturating_sub(3_600_000)],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0);
    let backoff_minutes =
        (1_i64 << failed_count.min(5)).min(i64::from(profile.scan_interval_minutes.max(1)));
    conn.execute(
        "UPDATE ai_agent_runs SET status='failed',error=?2,finished_at=?3,next_wake_at=?4,updated_at=?3
         WHERE id=?1 AND status!='completed'",
        params![run_id, message, now, now.saturating_add(backoff_minutes * 60_000)],
    )
    .map_err(|err| err.to_string())?;
    let trigger_type = conn
        .query_row(
            "SELECT trigger_type FROM ai_agent_runs WHERE id=?1",
            params![run_id],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_default();
    if trigger_type == "intelligence_briefing" {
        let _ = desic_intelligence::complete_briefing(
            &conn,
            run_id,
            "",
            &json!([]),
            Some(&message),
            now,
        );
    }
    if trigger_type == "daily_market_review" {
        conn.execute(
            "UPDATE ai_daily_market_reviews SET status='failed',error=?2,updated_at=?3 WHERE run_id=?1",
            params![run_id, message, now],
        )
        .map_err(|err| err.to_string())?;
    }
    let _ = app.emit(
        AUTOMATION_EVENT,
        json!({
            "type": "runFailed",
            "message": format!("后台 Agent {} 运行失败：{}", profile.name, message),
            "action": { "tab": "runs", "id": run_id }
        }),
    );
    if profile.feishu_enabled {
        spawn_feishu_notification(
            app,
            FeishuSendInput {
                title: format!("后台 Agent 失败：{}", profile.name),
                content: message.clone(),
                level: "error".to_string(),
                related_type: Some("agent_run".to_string()),
                related_id: Some(run_id.to_string()),
                agent_profile_id: Some(profile.id.clone()),
                agent_run_id: Some(run_id.to_string()),
            },
            "run_failed",
        );
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct QueuedReview {
    id: String,
    episode_id: String,
}

fn claim_next_review(conn: &Connection, now: i64) -> Result<Option<QueuedReview>, String> {
    let row = conn
        .query_row(
            "SELECT id,episode_id FROM ai_trade_reviews WHERE status='queued' ORDER BY created_at ASC LIMIT 1",
            [],
            |row| Ok(QueuedReview { id: row.get(0)?, episode_id: row.get(1)? }),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let Some(review) = row else {
        return Ok(None);
    };
    let changed = conn
        .execute(
            "UPDATE ai_trade_reviews SET status='running',error=NULL,updated_at=?2 WHERE id=?1 AND status='queued'",
            params![review.id, now],
        )
        .map_err(|err| err.to_string())?;
    Ok(if changed == 1 { Some(review) } else { None })
}

async fn execute_review_run(app: tauri::AppHandle, review: QueuedReview) -> Result<(), String> {
    let evidence = load_review_evidence(&app, &review.episode_id)?;
    let config = load_ai_config(&app)?;
    let original_model_id = evidence
        .pointer("/reviewRuntime/modelId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let actual_provider = evidence
        .pointer("/reviewRuntime/provider")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && *value != "unknown");
    let actual_model = evidence
        .pointer("/reviewRuntime/model")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && *value != "unknown");
    let model_selector = match (actual_provider, actual_model) {
        (Some(provider), Some(model)) => {
            let matches = config
                .models
                .iter()
                .filter(|item| item.provider == provider && item.model == model)
                .collect::<Vec<_>>();
            matches
                .iter()
                .find(|item| original_model_id == Some(item.id.as_str()))
                .copied()
                .or_else(|| (matches.len() == 1).then_some(matches[0]))
                .map(|item| item.id.as_str())
                .ok_or_else(|| {
                    format!(
                        "原 Profile 实际使用的模型 {}/{} 当前没有唯一可用配置，复盘不会静默改用其它模型",
                        provider, model
                    )
                })?
        }
        _ => original_model_id.unwrap_or(config.active_model_id.as_str()),
    };
    let selected_model = if model_selector.trim().is_empty() {
        config.clone()
    } else {
        crate::storage_config::select_ai_model(&config, Some(model_selector)).map_err(|error| {
            format!(
                "原 Profile 使用的模型配置 {} 当前不可用，复盘不会静默改用其它模型：{}",
                model_selector, error
            )
        })?
    };
    let review_reasoning_depth = evidence
        .pointer("/reviewRuntime/reasoningDepth")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(config.reasoning_depth.as_str())
        .to_string();
    let session_id = format!("review:{}", review.id);
    let message_id = format!("review-message:{}", review.id);
    let prompt = format!(
        "你是 Desic Terminal 交易复盘 Agent。请严格基于下面不可变证据复盘，不得下单，不得修改已发布 Skill。canonicalFacts 是后端从仓位数据库生成的唯一时间与账户环境事实：不得自行换算 Unix 时间戳，不得根据 accountId 文本推断环境。review.complete 的 summary 第一行必须逐字复制 canonicalFacts.summaryHeader，不加 Markdown 标记；正文不要重复计算日期、持仓时长或环境。后端会重新计算并校验该首行，不一致时必须按工具错误修正后重试。证据中的 decisionAgentRuns/skillVersions 是当时决策使用的固定版本；本次运行加载的是当前复盘 Skill，两者不能混为一谈。先分开评价决策质量、执行质量和随机结果，不得因为单笔亏损就反推规则错误，也不得因为单笔盈利就认可决策。marketPath 是本地 K 线计算得到的紧凑路径摘要；数据缺失、覆盖不足或平仓后观察窗口尚未完成时必须明确降低结论强度。优化建议不是必需输出：只有证据明确指向可复用、可验证的 Skill 级缺陷，且修改收益足以覆盖过拟合风险时才创建；正常方差、一次性执行问题、用户临时选择或数据不足都不得创建。确需建议时，先调用 review.readSkillVersion 读取该仓位实际使用的精确基线，只做最小必要修改，再为每个候选 Skill 单独调用 optimizationSuggestion.create；否则 review.complete 的 suggestions 可以为空。最后必须调用 review.complete。\n本次复盘 Skill: {}\n证据：{}",
        config.enabled_skills.join(", "),
        evidence,
    );
    {
        let conn = open_automation_database(&app)?;
        upsert_ai_session(&conn, &session_id, "自动交易复盘", "running")?;
        upsert_ai_message(
            &conn,
            &message_id,
            &session_id,
            "user",
            &prompt,
            None,
            None,
            Some("sent"),
        )?;
    }
    let context = BackgroundRunContext {
        permission_mode: ADVISOR_MODE.to_string(),
        account_id: None,
        environment: None,
        symbols: Vec::new(),
        profile_id: None,
        run_id: None,
        enabled_skills: config.enabled_skills.clone(),
        skill_versions: HashMap::new(),
        skill_definitions: config.skill_definitions.clone(),
        model: Some(selected_model.active_model_id.clone()),
        reasoning_depth: review_reasoning_depth,
        history_lookback_days: 0,
        target_leverage: default_target_leverage(),
        max_single_trade_margin_pct: default_max_single_trade_margin_pct(),
        allowed_wake_condition_types: Vec::new(),
        // 复盘 Run 以 episode 为主体，没有 Profile 勾选名单 → 无专家；也不做试判。
        enabled_agents: Vec::new(),
        triage: Arc::new(Mutex::new(crate::ai_triage::RunTriageState::new(
            crate::ai_triage::AiAgentTriageConfig {
                mode: crate::ai_triage::TRIAGE_MODE_OFF.to_string(),
                ..crate::ai_triage::AiAgentTriageConfig::default()
            },
            0,
            None,
            now_ms(),
        ))),
        finish_gate: Arc::new(Mutex::new(FinishGateState::default())),
        // 复盘 Run 没有 Profile，也没有单 Agent 子模式 → 恒为 standard（C21 校验照旧）。
        single_agent_mode: default_single_agent_mode(),
        trigger: json!({}),
        review_id: Some(review.id.clone()),
        episode_id: Some(review.episode_id.clone()),
    };
    let ai_runtime = app.state::<AiRuntime>().inner().clone();
    let result = run_ai_stream(
        app.clone(),
        ai_runtime,
        session_id,
        vec![AiChatMessage {
            id: Some(message_id),
            role: "user".to_string(),
            content: prompt,
        }],
        Some(context),
        None,
    )
    .await;
    let conn = open_automation_database(&app)?;
    let status = conn
        .query_row(
            "SELECT status FROM ai_trade_reviews WHERE id=?1",
            params![review.id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|err| err.to_string())?;
    if matches!(status.as_str(), "completed" | "cancelled") {
        return Ok(());
    }
    let error = match result {
        Err(message) => message,
        Ok(()) => "复盘 Agent 未调用 review.complete".to_string(),
    };
    conn.execute(
        "UPDATE ai_trade_reviews SET status='failed',error=?2,updated_at=?3 WHERE id=?1",
        params![review.id, error, now_ms()],
    )
    .map_err(|err| err.to_string())?;
    Err(error)
}

fn finalize_review_run_if_needed(
    app: &tauri::AppHandle,
    review_id: &str,
    error: &str,
) -> Result<(), String> {
    let conn = open_automation_database(app)?;
    conn.execute(
        "UPDATE ai_trade_reviews SET status='failed',error=?2,updated_at=?3
         WHERE id=?1 AND status='running'",
        params![review_id, error, now_ms()],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn review_number(value: Option<&Value>) -> Option<f64> {
    value.and_then(|item| {
        item.as_f64()
            .or_else(|| item.as_str().and_then(|text| text.parse::<f64>().ok()))
    })
}

fn review_candle_phase_summary(candles: &[&crate::Candle]) -> Value {
    let Some(first) = candles.first() else {
        return json!({ "count": 0 });
    };
    let last = candles.last().unwrap_or(first);
    let high = candles
        .iter()
        .map(|item| item.high)
        .fold(f64::NEG_INFINITY, f64::max);
    let low = candles
        .iter()
        .map(|item| item.low)
        .fold(f64::INFINITY, f64::min);
    let change_pct = if first.open > 0.0 {
        (last.close - first.open) / first.open * 100.0
    } else {
        0.0
    };
    let range_pct = if first.open > 0.0 {
        (high - low) / first.open * 100.0
    } else {
        0.0
    };
    json!({
        "count": candles.len(),
        "firstAt": first.time.saturating_mul(1000),
        "lastAt": last.time.saturating_mul(1000),
        "firstOpen": first.open,
        "lastClose": last.close,
        "high": high,
        "low": low,
        "changePct": change_pct,
        "rangePct": range_pct,
        "volume": candles.iter().map(|item| item.volume).sum::<f64>(),
        "confirmedCount": candles.iter().filter(|item| item.confirm).count(),
    })
}

fn review_market_path(conn: &Connection, episode: &Value) -> Value {
    let Some(inst_id) = episode.get("instId").and_then(Value::as_str) else {
        return json!({ "available": false, "limitations": ["仓位缺少交易对"] });
    };
    let Some(open_time) = episode.get("openTime").and_then(Value::as_i64) else {
        return json!({ "available": false, "limitations": ["仓位缺少开仓时间"] });
    };
    let close_time = episode
        .get("closeTime")
        .and_then(Value::as_i64)
        .unwrap_or(open_time);
    let window_start = open_time.saturating_sub(6 * 60 * 60 * 1000);
    let window_end = close_time.saturating_add(6 * 60 * 60 * 1000);
    let mut limitations = Vec::<String>::new();
    let mut by_bar = serde_json::Map::new();
    let mut fifteen_minute = Vec::new();
    for (bar, limit) in [("15m", 5000_u16), ("1H", 5000_u16), ("4H", 5000_u16)] {
        match crate::aggregate_candles_from_1m(
            conn,
            inst_id,
            bar,
            Some(window_start / 1000),
            Some(window_end / 1000),
            limit,
            true,
        ) {
            Ok(candles) => {
                let pre_entry = candles
                    .iter()
                    .filter(|item| item.time.saturating_mul(1000) < open_time)
                    .collect::<Vec<_>>();
                let holding = candles
                    .iter()
                    .filter(|item| {
                        let time = item.time.saturating_mul(1000);
                        time >= open_time && time <= close_time
                    })
                    .collect::<Vec<_>>();
                let post_exit = candles
                    .iter()
                    .filter(|item| item.time.saturating_mul(1000) > close_time)
                    .collect::<Vec<_>>();
                let first_at = candles.first().map(|item| item.time.saturating_mul(1000));
                let last_at = candles.last().map(|item| item.time.saturating_mul(1000));
                by_bar.insert(
                    bar.to_string(),
                    json!({
                        "count": candles.len(),
                        "firstAt": first_at,
                        "lastAt": last_at,
                        "preEntry": review_candle_phase_summary(&pre_entry),
                        "holding": review_candle_phase_summary(&holding),
                        "postExit": review_candle_phase_summary(&post_exit),
                    }),
                );
                if bar == "15m" {
                    fifteen_minute = candles;
                }
            }
            Err(error) => limitations.push(format!("{} K 线路径读取失败：{}", bar, error)),
        }
    }
    if fifteen_minute.is_empty() {
        limitations.push("仓位窗口内没有可用的已确认 15m K 线".to_string());
    }
    let available_through = fifteen_minute
        .last()
        .map(|item| item.time.saturating_mul(1000));
    if available_through.is_some_and(|value| value < window_end.saturating_sub(15 * 60 * 1000)) {
        limitations.push("平仓后 6 小时观察窗口尚未完成或本地 K 线覆盖不足".to_string());
    }
    if fifteen_minute.first().is_some_and(|item| {
        item.time.saturating_mul(1000) > window_start.saturating_add(15 * 60 * 1000)
    }) {
        limitations.push("开仓前 6 小时窗口覆盖不完整".to_string());
    }

    let entry_price = review_number(episode.get("avgOpenPx"));
    let side = episode
        .get("side")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let holding = fifteen_minute
        .iter()
        .filter(|item| {
            let time = item.time.saturating_mul(1000);
            time >= open_time && time <= close_time
        })
        .collect::<Vec<_>>();
    let excursion = entry_price
        .filter(|price| *price > 0.0)
        .filter(|_| !holding.is_empty())
        .map(|price| {
            let highest = holding
                .iter()
                .map(|item| item.high)
                .fold(f64::NEG_INFINITY, f64::max);
            let lowest = holding
                .iter()
                .map(|item| item.low)
                .fold(f64::INFINITY, f64::min);
            let (mfe, mae) = if side.eq_ignore_ascii_case("short") {
                ((price - lowest) / price * 100.0, (price - highest) / price * 100.0)
            } else {
                ((highest - price) / price * 100.0, (lowest - price) / price * 100.0)
            };
            json!({
                "averageEntryReference": price,
                "highestPrice": highest,
                "lowestPrice": lowest,
                "maxFavorableExcursionPct": mfe,
                "maxAdverseExcursionPct": mae,
                "calculation": "以仓位平均开仓价和已确认 15m K 线高低点估算；加减仓期间不做逐时仓位加权",
            })
        });

    let mut key_indices = BTreeSet::<usize>::new();
    let pre_indices = fifteen_minute
        .iter()
        .enumerate()
        .filter(|(_, item)| item.time.saturating_mul(1000) < open_time)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let holding_indices = fifteen_minute
        .iter()
        .enumerate()
        .filter(|(_, item)| {
            let time = item.time.saturating_mul(1000);
            time >= open_time && time <= close_time
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let post_indices = fifteen_minute
        .iter()
        .enumerate()
        .filter(|(_, item)| item.time.saturating_mul(1000) > close_time)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    key_indices.extend(pre_indices.iter().rev().take(4).copied());
    key_indices.extend(holding_indices.iter().take(4).copied());
    key_indices.extend(holding_indices.iter().rev().take(4).copied());
    key_indices.extend(post_indices.iter().take(4).copied());
    let key_candles = key_indices
        .into_iter()
        .filter_map(|index| fifteen_minute.get(index))
        .map(|item| {
            let time = item.time.saturating_mul(1000);
            json!({
                "phase": if time < open_time { "preEntry" } else if time <= close_time { "holding" } else { "postExit" },
                "time": time,
                "open": item.open,
                "high": item.high,
                "low": item.low,
                "close": item.close,
                "volume": item.volume,
            })
        })
        .collect::<Vec<_>>();

    json!({
        "available": !fifteen_minute.is_empty(),
        "source": "local-confirmed-1m-aggregated",
        "requestedWindowStart": window_start,
        "requestedWindowEnd": window_end,
        "availableThrough": available_through,
        "postExitObservedMs": available_through.map(|value| value.saturating_sub(close_time).max(0)),
        "bars": by_bar,
        "holdingExcursion": excursion,
        "keyCandles15m": key_candles,
        "limitations": limitations,
    })
}

fn load_review_evidence(app: &tauri::AppHandle, episode_id: &str) -> Result<Value, String> {
    let conn = open_automation_database(app)?;
    let episode = conn
        .query_row(
            "SELECT account_id,environment,inst_id,episode_side,status,primary_origin,strategy_id,
             open_time,close_time,open_qty,max_qty,closed_qty,avg_open_px,avg_close_px,realized_pnl,
             fees,funding_fee,liq_penalty,net_pnl,initial_lever,final_lever
             FROM position_episodes WHERE id=?1",
            params![episode_id],
            |row| {
                Ok(json!({
                    "id": episode_id,
                    "accountId": row.get::<_, String>(0)?,
                    "environment": row.get::<_, String>(1)?,
                    "instId": row.get::<_, String>(2)?,
                    "side": row.get::<_, String>(3)?,
                    "status": row.get::<_, String>(4)?,
                    "origin": row.get::<_, String>(5)?,
                    "strategyId": row.get::<_, Option<String>>(6)?,
                    "openTime": row.get::<_, i64>(7)?,
                    "closeTime": row.get::<_, Option<i64>>(8)?,
                    "openQty": row.get::<_, String>(9)?,
                    "maxQty": row.get::<_, String>(10)?,
                    "closedQty": row.get::<_, String>(11)?,
                    "avgOpenPx": row.get::<_, Option<String>>(12)?,
                    "avgClosePx": row.get::<_, Option<String>>(13)?,
                    "realizedPnl": row.get::<_, Option<String>>(14)?,
                    "fees": row.get::<_, Option<String>>(15)?,
                    "fundingFee": row.get::<_, Option<String>>(16)?,
                    "liqPenalty": row.get::<_, Option<String>>(17)?,
                    "netPnl": row.get::<_, Option<String>>(18)?,
                    "initialLever": row.get::<_, Option<String>>(19)?,
                    "finalLever": row.get::<_, Option<String>>(20)?,
                }))
            },
        )
        .map_err(|err| err.to_string())?;
    let canonical_facts = build_review_canonical_facts(
        episode
            .get("instId")
            .and_then(Value::as_str)
            .ok_or_else(|| "复盘仓位缺少交易对".to_string())?,
        episode
            .get("environment")
            .and_then(Value::as_str)
            .ok_or_else(|| "复盘仓位缺少账户环境".to_string())?,
        episode
            .get("openTime")
            .and_then(Value::as_i64)
            .ok_or_else(|| "复盘仓位缺少开仓时间".to_string())?,
        episode.get("closeTime").and_then(Value::as_i64),
    )?;
    let mut event_stmt = conn
        .prepare(
            "SELECT event_type,origin,actor_id,strategy_id,ord_id,bill_id,trade_id,side,pos_side,qty,price,pnl,fee,
             position_before,position_after,event_time,source,opportunity_id,agent_run_id
             FROM position_episode_events WHERE episode_id=?1 ORDER BY event_time ASC LIMIT 101",
        )
        .map_err(|err| err.to_string())?;
    let mut events = event_stmt
        .query_map(params![episode_id], |row| {
            Ok(json!({
                "eventType": row.get::<_, String>(0)?,
                "origin": row.get::<_, String>(1)?,
                "actorId": row.get::<_, Option<String>>(2)?,
                "strategyId": row.get::<_, Option<String>>(3)?,
                "orderId": row.get::<_, Option<String>>(4)?,
                "billId": row.get::<_, Option<String>>(5)?,
                "tradeId": row.get::<_, Option<String>>(6)?,
                "side": row.get::<_, Option<String>>(7)?,
                "posSide": row.get::<_, Option<String>>(8)?,
                "qty": row.get::<_, String>(9)?,
                "price": row.get::<_, Option<String>>(10)?,
                "pnl": row.get::<_, Option<String>>(11)?,
                "fee": row.get::<_, Option<String>>(12)?,
                "positionBefore": row.get::<_, Option<String>>(13)?,
                "positionAfter": row.get::<_, Option<String>>(14)?,
                "eventTime": row.get::<_, i64>(15)?,
                "source": row.get::<_, String>(16)?,
                "opportunityId": row.get::<_, Option<String>>(17)?,
                "agentRunId": row.get::<_, Option<String>>(18)?,
            }))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    let events_truncated = events.len() > 100;
    events.truncate(100);
    let strategy_id = episode.get("strategyId").and_then(Value::as_str);
    let opportunity = if let Some(id) = strategy_id {
        conn.query_row(
            "SELECT id,account_id,environment,inst_id,direction,action,order_type,price,size,lever,
             entry_condition,take_profit_json,stop_loss_json,invalidation_price,evidence_json,risk_notes_json,
             reason,precheck_json,market_snapshot_json,execution_result_json,agent_profile_id,agent_run_id,revision,status,created_at,updated_at
             FROM trade_opportunities WHERE id=?1",
            params![id],
            |row| {
                let evidence: Option<String> = row.get(14)?;
                let risk_notes: Option<String> = row.get(15)?;
                let precheck: Option<String> = row.get(17)?;
                let market_snapshot: Option<String> = row.get(18)?;
                let execution: Option<String> = row.get(19)?;
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "accountId": row.get::<_, Option<String>>(1)?,
                    "environment": row.get::<_, String>(2)?,
                    "instId": row.get::<_, String>(3)?,
                    "direction": row.get::<_, String>(4)?,
                    "action": row.get::<_, String>(5)?,
                    "orderType": row.get::<_, String>(6)?,
                    "price": row.get::<_, Option<String>>(7)?,
                    "size": row.get::<_, String>(8)?,
                    "lever": row.get::<_, Option<String>>(9)?,
                    "entryCondition": row.get::<_, Option<String>>(10)?,
                    "takeProfit": row.get::<_, Option<String>>(11)?.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
                    "stopLoss": row.get::<_, Option<String>>(12)?.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
                    "invalidationPrice": row.get::<_, Option<String>>(13)?,
                    "evidence": evidence.and_then(|value| serde_json::from_str::<Value>(&value).ok()).unwrap_or_else(|| json!([])),
                    "riskNotes": risk_notes.and_then(|value| serde_json::from_str::<Value>(&value).ok()).unwrap_or_else(|| json!([])),
                    "reason": row.get::<_, String>(16)?,
                    "precheck": precheck.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
                    "marketSnapshot": market_snapshot.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
                    "executionResult": execution.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
                    "agentProfileId": row.get::<_, Option<String>>(20)?,
                    "agentRunId": row.get::<_, Option<String>>(21)?,
                    "revision": row.get::<_, i64>(22)?,
                    "status": row.get::<_, String>(23)?,
                    "createdAt": row.get::<_, i64>(24)?,
                    "updatedAt": row.get::<_, i64>(25)?,
                }))
            },
        )
        .optional()
        .map_err(|err| err.to_string())?
    } else {
        None
    };
    let mut link_stmt = conn
        .prepare(
            "SELECT l.opportunity_id,l.relation_type,l.attributed_qty,l.attribution_type,l.agent_run_id,
             t.reason,t.status,t.revision,t.evidence_json,t.risk_notes_json,t.precheck_json,t.agent_profile_id,
             t.market_snapshot_json,t.agent_run_id
             FROM position_episode_opportunities l
             LEFT JOIN trade_opportunities t ON t.id=l.opportunity_id
             WHERE l.episode_id=?1 ORDER BY l.created_at ASC LIMIT 101",
        )
        .map_err(|err| err.to_string())?;
    let mut links = link_stmt
        .query_map(params![episode_id], |row| {
            Ok(json!({
                "opportunityId": row.get::<_, String>(0)?,
                "relationType": row.get::<_, String>(1)?,
                "attributedQty": row.get::<_, Option<String>>(2)?,
                "attributionType": row.get::<_, String>(3)?,
                "agentRunId": row.get::<_, Option<String>>(4)?,
                "reason": row.get::<_, Option<String>>(5)?,
                "status": row.get::<_, Option<String>>(6)?,
                "revision": row.get::<_, Option<i64>>(7)?,
                "evidence": row.get::<_, Option<String>>(8)?.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
                "riskNotes": row.get::<_, Option<String>>(9)?.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
                "precheck": row.get::<_, Option<String>>(10)?.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
                "agentProfileId": row.get::<_, Option<String>>(11)?,
                "marketSnapshot": row.get::<_, Option<String>>(12)?.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
                "opportunityAgentRunId": row.get::<_, Option<String>>(13)?,
            }))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    let links_truncated = links.len() > 100;
    links.truncate(100);
    let mut decision_run_ids = HashSet::new();
    if let Some(run_id) = opportunity
        .as_ref()
        .and_then(|item| item.get("agentRunId"))
        .and_then(Value::as_str)
    {
        decision_run_ids.insert(run_id.to_string());
    }
    for item in &links {
        for field in ["agentRunId", "opportunityAgentRunId"] {
            if let Some(run_id) = item.get(field).and_then(Value::as_str) {
                decision_run_ids.insert(run_id.to_string());
            }
        }
    }
    for item in &events {
        if let Some(run_id) = item.get("agentRunId").and_then(Value::as_str) {
            decision_run_ids.insert(run_id.to_string());
        }
    }
    let primary_decision_run_id = opportunity
        .as_ref()
        .and_then(|item| item.get("agentRunId"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            events
                .iter()
                .find(|item| {
                    item.get("eventType")
                        .and_then(Value::as_str)
                        .is_some_and(|value| value.eq_ignore_ascii_case("open"))
                })
                .and_then(|item| item.get("agentRunId"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .or_else(|| {
            links
                .iter()
                .find_map(|item| {
                    item.get("opportunityAgentRunId")
                        .or_else(|| item.get("agentRunId"))
                        .and_then(Value::as_str)
                })
                .map(str::to_string)
        });
    let mut decision_runs = Vec::new();
    for run_id in decision_run_ids {
        let mut run = conn
            .query_row(
                "SELECT id,profile_id,trigger_type,status,profile_snapshot_json,template_snapshot_json,skill_versions_json,started_at,finished_at
                 FROM ai_agent_runs WHERE id=?1",
                params![run_id],
                |row| {
                    let profile_snapshot: Option<String> = row.get(4)?;
                    let template_snapshot: Option<String> = row.get(5)?;
                    let skill_versions: String = row.get(6)?;
                    Ok(json!({
                        "id": row.get::<_, String>(0)?,
                        "profileId": row.get::<_, String>(1)?,
                        "triggerType": row.get::<_, String>(2)?,
                        "status": row.get::<_, String>(3)?,
                        "profileSnapshot": profile_snapshot.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
                        "templateSnapshot": template_snapshot.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
                        "skillVersions": serde_json::from_str::<Value>(&skill_versions).unwrap_or_else(|_| json!({})),
                        "startedAt": row.get::<_, i64>(7)?,
                        "finishedAt": row.get::<_, Option<i64>>(8)?,
                    }))
                },
            )
            .optional()
            .map_err(|err| err.to_string())?;
        if let Some(run_value) = run.as_mut() {
            let session_id = format!("background:{}", run_id);
            let actual_model = conn
                .query_row(
                    "SELECT tool_json FROM ai_messages
                     WHERE session_id=?1 AND role='assistant' AND tool_json IS NOT NULL
                     ORDER BY created_at DESC LIMIT 1",
                    params![session_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|err| err.to_string())?
                .and_then(|tool_json| parse_ai_usage_summary(&tool_json));
            if let (Some(object), Some(actual_model)) = (run_value.as_object_mut(), actual_model) {
                object.insert(
                    "actualModel".to_string(),
                    serde_json::to_value(actual_model).unwrap_or(Value::Null),
                );
            }
        }
        if let Some(run) = run {
            decision_runs.push(run);
        }
    }
    decision_runs.sort_by_key(|item| {
        item.get("startedAt")
            .and_then(Value::as_i64)
            .unwrap_or(i64::MAX)
    });
    let primary_decision_run = primary_decision_run_id
        .as_deref()
        .and_then(|run_id| {
            decision_runs
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(run_id))
        })
        .or_else(|| decision_runs.first());
    let actual_model_id = primary_decision_run
        .and_then(|run| run.pointer("/actualModel/modelId"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && *value != "unknown");
    let snapshot_model_id = primary_decision_run
        .and_then(|run| run.pointer("/profileSnapshot/model"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let review_model_id = actual_model_id.or(snapshot_model_id);
    let review_reasoning_depth = primary_decision_run
        .and_then(|run| run.pointer("/profileSnapshot/reasoningDepth"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let review_runtime = json!({
        "primaryDecisionRunId": primary_decision_run.and_then(|run| run.get("id")).cloned(),
        "profileId": primary_decision_run.and_then(|run| run.get("profileId")).cloned(),
        "modelId": review_model_id,
        "provider": primary_decision_run.and_then(|run| run.pointer("/actualModel/provider")).cloned(),
        "model": primary_decision_run.and_then(|run| run.pointer("/actualModel/model")).cloned(),
        "modelSource": if actual_model_id.is_some() {
            "actual-run-usage"
        } else if snapshot_model_id.is_some() {
            "profile-snapshot"
        } else {
            "current-global-fallback-no-associated-profile-run"
        },
        "reasoningDepth": review_reasoning_depth,
    });
    let mut market_snapshots = Vec::new();
    if let Some(snapshot) = opportunity
        .as_ref()
        .and_then(|item| item.get("marketSnapshot"))
        .filter(|item| !item.is_null())
        .cloned()
    {
        market_snapshots.push(json!({
            "opportunityId": opportunity.as_ref().and_then(|item| item.get("id")).cloned(),
            "snapshot": snapshot
        }));
    }
    for item in &links {
        if let Some(snapshot) = item
            .get("marketSnapshot")
            .filter(|value| !value.is_null())
            .cloned()
        {
            market_snapshots.push(json!({
                "opportunityId": item.get("opportunityId").cloned(),
                "snapshot": snapshot
            }));
        }
    }
    let primary_market_snapshot = market_snapshots
        .first()
        .and_then(|item| item.get("snapshot"))
        .cloned();
    let account_id = episode
        .get("accountId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let environment = episode
        .get("environment")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut order_stmt = conn
        .prepare(
            "SELECT DISTINCT o.ord_id,o.cl_ord_id,o.inst_id,o.side,o.pos_side,o.td_mode,o.ord_type,o.state,
             o.px,o.sz,o.acc_fill_sz,o.avg_px,o.pnl,o.fee,o.operator,o.opportunity_id,o.agent_run_id,
             o.execution_key,o.okx_ctime,o.okx_utime,o.source_endpoint
             FROM okx_orders o
             WHERE o.account_id=?1 AND o.environment=?2 AND (
               EXISTS(SELECT 1 FROM position_episode_events e WHERE e.episode_id=?3 AND e.ord_id=o.ord_id)
               OR EXISTS(SELECT 1 FROM position_episode_opportunities l
                         WHERE l.episode_id=?3 AND l.opportunity_id=o.opportunity_id)
             ) ORDER BY COALESCE(o.okx_utime,o.okx_ctime) ASC LIMIT 101",
        )
        .map_err(|err| err.to_string())?;
    let mut orders = order_stmt
        .query_map(params![account_id, environment, episode_id], |row| {
            Ok(json!({
                "ordId": row.get::<_, String>(0)?, "clOrdId": row.get::<_, Option<String>>(1)?,
                "instId": row.get::<_, String>(2)?, "side": row.get::<_, Option<String>>(3)?,
                "posSide": row.get::<_, Option<String>>(4)?, "tdMode": row.get::<_, Option<String>>(5)?,
                "ordType": row.get::<_, Option<String>>(6)?, "state": row.get::<_, Option<String>>(7)?,
                "px": row.get::<_, Option<String>>(8)?, "sz": row.get::<_, Option<String>>(9)?,
                "filledSize": row.get::<_, Option<String>>(10)?, "avgPx": row.get::<_, Option<String>>(11)?,
                "pnl": row.get::<_, Option<String>>(12)?, "fee": row.get::<_, Option<String>>(13)?,
                "operator": row.get::<_, String>(14)?, "opportunityId": row.get::<_, Option<String>>(15)?,
                "agentRunId": row.get::<_, Option<String>>(16)?, "executionKey": row.get::<_, Option<String>>(17)?,
                "createdAt": row.get::<_, Option<i64>>(18)?, "updatedAt": row.get::<_, Option<i64>>(19)?,
                "source": row.get::<_, String>(20)?,
            }))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    let orders_truncated = orders.len() > 100;
    orders.truncate(100);
    let mut audit_stmt = conn
        .prepare(
            "SELECT event_type,operation,status,order_id,client_order_id,size,price,operator,opportunity_id,
             agent_run_id,execution_key,okx_code,okx_message,error,created_at
             FROM trade_audit_events a
             WHERE a.account_id=?1 AND a.environment=?2 AND (
               EXISTS(SELECT 1 FROM position_episode_events e WHERE e.episode_id=?3 AND e.ord_id=a.order_id)
               OR EXISTS(SELECT 1 FROM position_episode_opportunities l
                         WHERE l.episode_id=?3 AND l.opportunity_id=a.opportunity_id)
             ) ORDER BY a.created_at ASC LIMIT 101",
        )
        .map_err(|err| err.to_string())?;
    let mut audit_events = audit_stmt
        .query_map(params![account_id, environment, episode_id], |row| {
            Ok(json!({
                "eventType": row.get::<_, String>(0)?, "operation": row.get::<_, String>(1)?,
                "status": row.get::<_, String>(2)?, "orderId": row.get::<_, Option<String>>(3)?,
                "clientOrderId": row.get::<_, Option<String>>(4)?, "size": row.get::<_, Option<String>>(5)?,
                "price": row.get::<_, Option<String>>(6)?, "operator": row.get::<_, String>(7)?,
                "opportunityId": row.get::<_, Option<String>>(8)?, "agentRunId": row.get::<_, Option<String>>(9)?,
                "executionKey": row.get::<_, Option<String>>(10)?, "okxCode": row.get::<_, Option<String>>(11)?,
                "okxMessage": row.get::<_, Option<String>>(12)?, "error": row.get::<_, Option<String>>(13)?,
                "createdAt": row.get::<_, i64>(14)?,
            }))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    let audit_events_truncated = audit_events.len() > 100;
    audit_events.truncate(100);
    let market_path = review_market_path(&conn, &episode);
    Ok(json!({
        "canonicalFacts": canonical_facts,
        "episode": episode,
        "events": events,
        "opportunity": opportunity,
        "opportunityLinks": links,
        "orders": orders,
        "tradeAuditEvents": audit_events,
        "evidenceTruncated": {
            "events": events_truncated,
            "opportunityLinks": links_truncated,
            "orders": orders_truncated,
            "tradeAuditEvents": audit_events_truncated,
            "limitPerCollection": 100
        },
        "decisionAgentRuns": decision_runs,
        "reviewRuntime": review_runtime,
        "marketSnapshot": primary_market_snapshot,
        "marketSnapshots": market_snapshots,
        "marketPath": market_path,
        "marketSnapshotNote": if primary_market_snapshot.is_some() {
            "行情快照来自机会创建时的 WSS 内存数据。"
        } else {
            "该历史机会创建于行情快照功能上线前；precheck 是现有的创建时证据。"
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_profile_defaults_to_thirty_minute_maximum_silence() {
        let profile = serde_json::from_value::<AiAgentProfileInput>(json!({ "name": "Test" }))
            .expect("minimal profile input");
        assert_eq!(profile.scan_interval_minutes, 30);
    }

    /// C19：UI 只传部分字段（未暴露 tools / skipTriageTriggers）→ Rust 自行补默认，
    /// 旧 Profile 整块缺失也不崩。
    #[test]
    fn triage_profile_payload_fills_ui_missing_fields() {
        // UI 实际下发的形状（无 tools / skipTriageTriggers）。
        let ui_payload: crate::ai_triage::AiAgentTriageConfig =
            serde_json::from_str(
                r#"{
                    "mode": "enforce",
                    "maxSkips": 3,
                    "maxSilenceMinutes": 120,
                    "skipSampleRate": 0.2,
                    "escalate": {
                        "positionOrOrderChanged": true,
                        "stopDistancePct": 1.5,
                        "marginRatioPct": 150,
                        "confirmedBreakOfFlaggedLevel": true,
                        "conditionResonance": 2,
                        "importantNews": true
                    }
                }"#,
            )
            .expect("deserialize ui payload");
        assert_eq!(
            ui_payload.tools,
            vec!["market", "account", "intelligence", "radar"],
            "UI 未传 tools → Rust 补默认"
        );
        assert_eq!(
            ui_payload.escalate.skip_triage_triggers,
            vec!["intelligence_briefing", "daily_market_review"],
            "UI 未传 skipTriageTriggers → Rust 补默认"
        );
        assert_eq!(
            ui_payload.escalate.margin_ratio_convention,
            crate::ai_triage::MARGIN_RATIO_HIGHER_IS_SAFER,
            "UI 未传 marginRatioConvention → OKX 口径（越大越安全）"
        );
        assert_eq!(ui_payload, crate::ai_triage::AiAgentTriageConfig::default());

        // C25-4：老配置/老前端仍可传反向口径 → **不报错、被忽略**，归一为固定语义。
        for legacy in ["lower_is_safer", "", "anything", "HIGHER_IS_SAFER"] {
            let legacy_config: crate::ai_triage::AiAgentTriageConfig = serde_json::from_str(
                &format!(
                    r#"{{ "mode": "enforce", "escalate": {{ "marginRatioConvention": "{legacy}" }} }}"#
                ),
            )
            .expect("老配置必须可反序列化");
            let normalized = legacy_config.normalized();
            assert_eq!(
                normalized.escalate.margin_ratio_convention,
                crate::ai_triage::MARGIN_RATIO_HIGHER_IS_SAFER,
                "{legacy:?} 必须被归一为固定口径"
            );
            // 回显恒为固定值（UI 不再需要这个选项）。
            assert_eq!(
                crate::ai_triage::AiAgentTriageConfig::default().escalate.margin_ratio_convention,
                crate::ai_triage::MARGIN_RATIO_HIGHER_IS_SAFER
            );
        }

        // 旧 Profile：整块缺失。
        let missing: crate::ai_triage::AiAgentTriageConfig =
            serde_json::from_str("{}").expect("deserialize {}");
        assert_eq!(missing.mode, "enforce");
        assert_eq!(missing.escalate.skip_triage_triggers.len(), 2);
    }

    /// C19：run 记录字段名与 UI 约定逐字对齐（含 forced / triageTokens 等别名）。
    #[test]
    fn triage_record_shape_matches_ui_contract() {
        let config = crate::ai_triage::AiAgentTriageConfig {
            mode: "enforce".to_string(),
            ..crate::ai_triage::AiAgentTriageConfig::default()
        };
        let decision = crate::ai_triage::decide_triage_outcome(
            &config,
            false,
            vec!["stopDistancePct(1.20% <= 1.50%)".to_string()],
            false,
        );
        let record = build_triage_record_for_test(
            &config,
            false,
            &decision,
            &["止损距离不足".to_string()],
            &[crate::ai_triage::AiTriageEvidence {
                fact: "止损距离开仓价 1.2%".to_string(),
                source: "account.readPositions".to_string(),
                at: "2026-09-18T16:04:20Z".to_string(),
            }],
            &["marginRatioPct".to_string()],
            &crate::ai_triage::TriageEscalationInputs {
                min_stop_distance_pct: Some(1.2),
                margin_ratios: vec![1500.0, 120.0],
                ..Default::default()
            },
            2,
            &serde_json::json!({ "totalTokens": 1234 }),
            1_700_000_000_000,
        );
        for key in [
            "mode",
            "verdict",
            "reasons",
            "evidence",
            "forcedBy",
            "forced",
            "sampled",
            "triageTokens",
            "triageUsage",
        ] {
            assert!(record.get(key).is_some(), "缺少 UI 约定字段：{key}");
        }
        assert_eq!(record["mode"], "enforce");
        // C25-5：`verdict` 是字符串（UI 直接用它做 class 与文案判定），布尔另给 `escalate`。
        assert_eq!(record["verdict"], "skip");
        assert_eq!(record["escalate"], false);
        assert_eq!(record["forced"], true, "forcedBy 非空 → forced=true");
        assert_eq!(record["triageTokens"], 1234);
        assert_eq!(record["sampled"], false);
        assert_eq!(record["skipped"], false, "硬升级命中不得是 skip");
        assert_eq!(record["evidence"][0]["source"], "account.readPositions");
        // C19：原始 mgnRatio 必须留在记录里（用于核对方向），并带口径。
        assert_eq!(
            record["checked"]["marginRatios"],
            serde_json::json!([1500.0, 120.0])
        );
        assert_eq!(record["checked"]["minMarginRatioPct"], 120.0);
        assert_eq!(record["checked"]["maxMarginRatioPct"], 1500.0);
        assert_eq!(
            record["checked"]["marginRatioConvention"],
            "higher_is_safer"
        );
    }

    /// C19：手工强制深度的 trigger 与豁免 trigger 都不做试判（直接进深度阶段）。
    #[test]
    fn manual_force_deep_run_bypasses_triage() {
        let profile = crate::ai_triage::AiAgentTriageConfig::default();
        assert_eq!(profile.mode, "enforce");
        for trigger in [
            crate::ai_automation::MANUAL_FORCE_DEEP_TRIGGER,
            "intelligence_briefing",
            "daily_market_review",
        ] {
            let effective = triage_config_for_run(&profile, trigger);
            assert_eq!(effective.mode, "off", "{trigger} 必须绕过试判");
        }
        // 普通运行沿用 Profile 配置。
        assert_eq!(triage_config_for_run(&profile, "wake_condition").mode, "enforce");
        assert_eq!(triage_config_for_run(&profile, "manual").mode, "enforce");
        // 用户显式 off 也不变。
        let off = crate::ai_triage::AiAgentTriageConfig {
            mode: "off".to_string(),
            ..crate::ai_triage::AiAgentTriageConfig::default()
        };
        assert_eq!(triage_config_for_run(&off, "manual").mode, "off");
    }

    /// C19：分阶段 token 记账（深度段 = 总量 − 试判段，逐字段相减且不为负）。
    /// C19.2：skip 必须带 nextWakePlan（否则报错）；escalate=true 不要求。
    #[test]
    fn triage_skip_requires_next_wake_plan() {
        let error = validate_triage_report_input(false, false)
            .expect_err("skip without nextWakePlan must fail");
        assert!(error.contains("nextWakePlan"), "{error}");
        assert!(validate_triage_report_input(false, true).is_ok());
        assert!(validate_triage_report_input(true, false).is_ok());
        assert!(validate_triage_report_input(true, true).is_ok());
    }

    /// P1（C20）：专家级用量采集——工具次数、起止时间、时长、可用时的 token，
    /// 以及拿不到 token 时的显式标记；无专家会话时是空数组（形状稳定）。
    /// C20.6：`background.finishRun` 必须接受并落库两个审计字段（缺省可省略、形状宽容）。
    #[test]
    fn finish_run_accepts_c20_audit_fields() {
        let input: BackgroundFinishRunInput = serde_json::from_value(json!({
            "summary": "本轮完成",
            "finalDecision": { "outcome": "wait", "reason": "证据不足" },
            "nextWakePlan": { "mode": "any", "conditions": [] },
            "usedEvidence": [
                { "expertId": "desic-data-digest", "points": ["5m 结构未确认", "OI 持平"] },
                "自由文本证据要点"
            ],
            "contrarianResolutions": [
                { "claim": "拥挤度高", "decision": "接受", "note": "改为等待" }
            ]
        }))
        .expect("deserialize finish input with audit fields");
        assert_eq!(input.used_evidence.len(), 2);
        assert_eq!(input.contrarian_resolutions.len(), 1);

        // 缺省（旧 UI / 无审计）→ 空数组，不报错。
        let bare: BackgroundFinishRunInput = serde_json::from_value(json!({
            "summary": "本轮完成",
            "nextWakePlan": { "mode": "any", "conditions": [] }
        }))
        .expect("deserialize without audit fields");
        assert!(bare.used_evidence.is_empty());
        assert!(bare.contrarian_resolutions.is_empty());

        // 落库形状（UI 读 run.audit.usedEvidence / run.audit.contrarianResolutions）。
        let audit = json!({
            "usedEvidence": bare.used_evidence,
            "contrarianResolutions": bare.contrarian_resolutions,
        });
        assert!(audit["usedEvidence"].is_array());
        assert!(audit["contrarianResolutions"].is_array());
    }

    /// C20：默认启用集 = 4 个流程角色；历史 7 个标 deprecated（不被全选内置选中）。
    #[test]
    fn default_enabled_agents_are_the_four_process_roles() {
        let defaults = desic_agent_automation::default_enabled_agent_ids();
        assert_eq!(
            defaults,
            vec![
                "desic-data-digest",
                "desic-account-state",
                "desic-decision-proposal",
                "desic-contrarian-review"
            ]
        );
        let deprecated = desic_agent_automation::deprecated_builtin_agent_ids();
        assert_eq!(deprecated.len(), 7);
        assert!(deprecated.contains(&"desic-market-structure".to_string()));
        assert!(
            !deprecated.contains(&"desic-contrarian-review".to_string()),
            "C20：contrarian 是 id 复用，不标停用"
        );
        // 11 个内置文件都要能安装（历史角色文件保留）。
        for id in desic_agent_automation::builtin_agent_ids() {
            assert!(
                desic_agent_automation::builtin_agent_markdown(&id).is_some(),
                "{id} 必须仍可安装"
            );
        }
    }

    /// C20：草稿提示词必须与内容包同源（role 枚举 + 反例约束规则）。
    #[test]
    fn draft_prompt_matches_c20_content_pack() {
        let system = desic_agent_automation::AI_AGENT_DRAFT_SYSTEM_PROMPT;
        for role in ["data_digest", "account_state", "decision_proposal", "contrarian"] {
            assert!(system.contains(role), "role 枚举缺少 {role}");
        }
        assert!(system.contains("反例"), "C20 规则 9（反例约束）必须在内嵌提示词里");
        assert!(system.contains("不要输出 scopes"), "C15 起的字段清单");
        let user = desic_agent_automation::AI_AGENT_DRAFT_USER_PROMPT;
        assert!(user.contains("{{description}}") && user.contains("{{name_line}}"));
        assert!(user.contains("{{description}}"), "占位符必须保留给 Rust 替换");
    }

    /// C23.2 夹具：主 Agent 拼装后的完整任务（多行、含依赖提示与 Profile 任务）。
    const MARKET_TASK_PROMPT: &str = "本轮任务：检查 BTC-USDT-SWAP 的多周期结构。\n时点：2026-09-19T15:00Z（UTC 毫秒 1726758000000）。\n依赖提示：账户与持仓专家可能同时并行，你的报告不需要账户结论。\nProfile 任务：本轮只做 wait/abandon 判断，不要给方向建议。\n输出要求：结论 → 失效位 → 冲突与缺口；每条附工具记录 ID 与观测时间。";
    /// C23.2 夹具：专家报告全文（Markdown 表格 + 行内等宽 + 中文标点 + 长段落）。
    const MARKET_REPORT_TEXT: &str = "# 市场结构报告\n\n## 结论\n15m 结构未确认，**不建议**追多。\n\n## 事实与证据\n| 项 | 值 | 时间 |\n| --- | --- | --- |\n| 价格 | `102_450.5` | 15:00 |\n| OI | `+0.4%` | 15:00 |\n\n- 4H 仍在区间内；`market.readCandles` 记录 ID `candles-7f31`。\n- 资金费率持平（`market.readFundingRate`）。\n\n## 冲突与缺口\n盘口快照与成交活跃度方向不一致，列为冲突，不当作错误。\n\n## 数据缺口\n历史相似窗口只覆盖 30 天。";

    #[test]
    fn expert_activity_reports_tools_and_duration_per_expert() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        migrate_ai_automation(&conn).expect("migrate automation schema");
        // `ai_messages` 由主库迁移建表，这里按需补齐（本用例只用手写工具事件）。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS ai_messages(
               id TEXT PRIMARY KEY,session_id TEXT NOT NULL,role TEXT NOT NULL,
               content TEXT NOT NULL,reasoning TEXT,tool_json TEXT,
               token_usage_json TEXT,token_usage_version INTEGER NOT NULL DEFAULT 0,
               status TEXT,created_at INTEGER NOT NULL
             );",
        )
        .expect("create ai_messages");
        conn.execute(
            "INSERT INTO ai_messages(id,session_id,role,content,tool_json,created_at)
             VALUES('m-expert','background:run-experts','assistant','report',?1,1)",
            params![json!([
                { "type": "agentStart", "agentId": "agent-1", "configuredAgentId": "desic-market-structure",
                  "role": "market_structure", "title": "市场结构", "startedAt": 1_000,
                  "task": "检查多周期价格结构。", "taskPrompt": MARKET_TASK_PROMPT },
                { "type": "toolCall", "agentId": "agent-1", "configuredAgentId": "desic-market-structure", "startedAt": 1_100 },
                { "type": "toolResult", "agentId": "agent-1", "configuredAgentId": "desic-market-structure", "endedAt": 2_400 },
                { "type": "usage", "agentId": "agent-1", "configuredAgentId": "desic-market-structure",
                  "usage": { "totalTokens": 1_200 } },
                { "type": "agentDone", "agentId": "agent-1", "configuredAgentId": "desic-market-structure", "endedAt": 3_000,
                  "result": { "text": MARKET_REPORT_TEXT, "usage": { "totalTokens": 1_200 } } },
                { "type": "toolCall", "agentId": "agent-2", "configuredAgentId": "desic-contrarian-review", "startedAt": 3_100 },
                { "type": "agentDone", "agentId": "agent-2", "configuredAgentId": "desic-contrarian-review", "endedAt": 9_000,
                  "result": {} }
            ])
            .to_string()],
        )
        .expect("insert run session message");

        let experts = collect_expert_activity(&conn, "run-experts");
        assert_eq!(experts.len(), 2, "按专家聚合：{experts:?}");
        let market = experts
            .iter()
            .find(|item| item["configuredAgentId"] == "desic-market-structure")
            .expect("market expert");
        assert_eq!(market["toolCalls"], 2, "toolCall + toolResult 各计一次");
        assert_eq!(market["startedAt"], 1_000);
        assert_eq!(market["endedAt"], 3_000);
        assert_eq!(market["durationMs"], 2_000);
        assert_eq!(market["name"], "市场结构");
        assert_eq!(market["role"], "market_structure");
        assert_eq!(market["tokenUsage"]["totalTokens"], 1_200);
        // C23.2：提问与报告**逐字一致**（不截断、不改写、不 trim）——多行 Markdown +
        // 表格 + 行内等宽 + 中文标点全部原样保留。
        assert_eq!(market["taskPrompt"], MARKET_TASK_PROMPT);
        assert_eq!(market["report"], MARKET_REPORT_TEXT);
        assert_eq!(
            market["report"].as_str().expect("report").chars().count(),
            MARKET_REPORT_TEXT.chars().count(),
            "报告长度必须与源事件完全一致"
        );
        assert_eq!(market["taskPrompt"], json!(MARKET_TASK_PROMPT));

        let contrarian = experts
            .iter()
            .find(|item| item["configuredAgentId"] == "desic-contrarian-review")
            .expect("contrarian expert");
        assert_eq!(contrarian["toolCalls"], 1);
        assert_eq!(contrarian["durationMs"], 5_900);
        // C23.2：事件里没有这些字段（老运行 / 早期格式）→ **空字符串**，形状稳定、不 panic。
        assert_eq!(contrarian["taskPrompt"], "");
        assert_eq!(contrarian["report"], "");
        assert_eq!(contrarian["role"], "");
        assert!(
            contrarian.get("taskPrompt").is_some() && contrarian.get("report").is_some(),
            "键必须始终存在（老运行也不缺键）"
        );
        assert_eq!(
            contrarian["tokensUnavailable"], true,
            "拿不到 per-agent usage 时必须显式标记，不猜"
        );

        // 无专家会话（例如手工运行只有主 Agent）→ 空数组。
        conn.execute(
            "INSERT INTO ai_messages(id,session_id,role,content,tool_json,created_at)
             VALUES('m-solo','background:run-solo','assistant','ok',?1,1)",
            params![json!([{ "type": "toolCall", "name": "market.readTicker" }]).to_string()],
        )
        .expect("insert solo message");
        assert!(collect_expert_activity(&conn, "run-solo").is_empty());
    }

    #[test]
    fn triage_phase_tokens_subtract_deep_from_triage() {
        let triage = json!({ "usage": { "totalTokens": 1000, "inputTokens": 800 }, "totalTokens": 1000 });
        let total = json!({ "usage": { "totalTokens": 3500, "inputTokens": 3000 }, "totalTokens": 3500 });
        let deep = subtract_usage_for_test(&total, &triage);
        assert_eq!(deep["totalTokens"], 2500);
        assert_eq!(deep["usage"]["totalTokens"], 2500);
        assert_eq!(deep["usage"]["inputTokens"], 2200);
        // 总量缺失/更小 → 不为负。
        let smaller = json!({ "totalTokens": 200 });
        let deep = subtract_usage_for_test(&smaller, &triage);
        assert_eq!(deep["totalTokens"], 0);
    }

    #[test]
    fn background_prompt_requires_existing_position_management() {
        for expected in [
            "止损保护与止盈退出分开评估",
            "takeProfitStatus",
            "exitKind=take_profit",
            "size 才是权威平仓张数",
            "intent=amend",
            "精确订单 ID",
            "对冲目标、规模关系、期限",
        ] {
            assert!(EXISTING_POSITION_MANAGEMENT_RULES.contains(expected));
        }
        for expected in [
            "evaluate stop-loss protection and take-profit exit separately",
            "takeProfitStatus",
            "exitKind=take_profit",
            "size is the authoritative close quantity",
            "intent=amend",
            "exact IDs",
            "combined portfolio risk",
        ] {
            assert!(EXISTING_POSITION_MANAGEMENT_RULES_EN.contains(expected));
        }
    }

    #[test]
    fn profile_performance_attributes_only_this_profile_s_fills() {
        let conn = Connection::open_in_memory().expect("database");
        conn.execute_batch(
            "CREATE TABLE ai_agent_runs(id TEXT PRIMARY KEY, profile_id TEXT NOT NULL);
             CREATE TABLE okx_fills(
               bill_id TEXT PRIMARY KEY, fill_pnl TEXT, fee TEXT,
               agent_run_id TEXT, okx_ts INTEGER NOT NULL);
             INSERT INTO ai_agent_runs(id, profile_id) VALUES('run-a','profile-a'),('run-b','profile-b');",
        )
        .expect("schema");
        let now = now_ms();
        let insert = |bill: &str, pnl: &str, fee: &str, run: Option<&str>, ts: i64| {
            conn.execute(
                "INSERT INTO okx_fills(bill_id, fill_pnl, fee, agent_run_id, okx_ts) VALUES(?1,?2,?3,?4,?5)",
                params![bill, pnl, fee, run, ts],
            )
            .expect("insert fill");
        };
        // Profile A: a win and a loss inside the window. Fees are stored negative,
        // so the net figure must be pnl + fee.
        insert("f1", "1.5", "-0.1", Some("run-a"), now - 1_000);
        insert("f2", "-0.5", "-0.2", Some("run-a"), now - 2_000);
        // Profile B, so grouping must keep them apart.
        insert("f3", "2.0", "-0.3", Some("run-b"), now - 3_000);
        // A manual trade on the same account is nobody's automation result.
        insert("f4", "99.0", "-1.0", None, now - 4_000);
        // Older than the window.
        insert(
            "f5",
            "50.0",
            "-5.0",
            Some("run-a"),
            now - 30 * 24 * 60 * 60 * 1000,
        );

        // The shipped window is asserted separately; the label shown on the card
        // must describe the same period the query uses.
        assert_eq!(PROFILE_PERFORMANCE_WINDOW_DAYS, 30);
        let rows = load_profile_performance(&conn, 7).expect("aggregate");
        let of = |id: &str| rows.iter().find(|row| row.profile_id == id).expect("row");

        let a = of("profile-a");
        assert!(
            (a.net_pnl_usdt - 0.7).abs() < 1e-9,
            "net was {}",
            a.net_pnl_usdt
        );
        assert!(
            (a.fees_usdt - 0.3).abs() < 1e-9,
            "fees were {}",
            a.fees_usdt
        );
        assert_eq!(a.fill_count, 2, "the out-of-window fill must be excluded");
        assert_eq!(a.window_days, 7);

        let b = of("profile-b");
        assert!(
            (b.net_pnl_usdt - 1.7).abs() < 1e-9,
            "net was {}",
            b.net_pnl_usdt
        );
        assert_eq!(b.fill_count, 1);

        // The unattributed fill must not create a phantom Profile.
        assert_eq!(
            rows.len(),
            2,
            "only Profiles with attributed fills are reported"
        );
    }

    #[test]
    fn database_contention_is_retried_but_real_faults_are_reported() {
        // The messages SQLite produces when a peer holds the write lock. These
        // must be retried silently instead of surfacing as a run failure.
        assert!(is_transient_database_contention("database is locked"));
        assert!(is_transient_database_contention(
            "AI 自动化调度异常：database is locked"
        ));
        assert!(is_transient_database_contention("Database Is Locked"));
        assert!(is_transient_database_contention("database table is locked"));
        // Genuine faults must still reach the user.
        assert!(!is_transient_database_contention(
            "no such table: ai_agent_runs"
        ));
        assert!(!is_transient_database_contention("OKX 下单失败：余额不足"));
        assert!(!is_transient_database_contention(
            "database disk image is malformed"
        ));
    }

    #[test]
    fn review_skill_version_is_limited_to_the_episode_decision_run() {
        let conn = Connection::open_in_memory().expect("database");
        conn.execute_batch(
            "CREATE TABLE ai_agent_runs(id TEXT PRIMARY KEY,skill_versions_json TEXT NOT NULL);
             CREATE TABLE position_episode_events(episode_id TEXT,agent_run_id TEXT);
             CREATE TABLE position_episode_opportunities(episode_id TEXT,agent_run_id TEXT,opportunity_id TEXT);
             CREATE TABLE trade_opportunities(id TEXT PRIMARY KEY,agent_run_id TEXT);
             CREATE TABLE position_episodes(id TEXT PRIMARY KEY,strategy_id TEXT);
             CREATE TABLE ai_skill_versions(skill_id TEXT,version INTEGER,status TEXT,content TEXT);",
        )
        .expect("schema");
        let definition = desic_storage_config::AiSkillDefinition {
            id: "trading-philosophy".to_string(),
            name: "trading-philosophy".to_string(),
            description: "test".to_string(),
            rules: "rule".to_string(),
            content: "content".to_string(),
            builtin: true,
            bundle: None,
        };
        conn.execute(
            "INSERT INTO ai_agent_runs VALUES('run-open','{\"trading-philosophy\":4}')",
            [],
        )
        .expect("run");
        conn.execute(
            "INSERT INTO position_episode_events VALUES('episode-1','run-open')",
            [],
        )
        .expect("event");
        conn.execute(
            "INSERT INTO ai_skill_versions VALUES('trading-philosophy',4,'published',?1)",
            params![serde_json::to_string(&definition).expect("definition")],
        )
        .expect("skill");

        let loaded = load_review_skill_definition(&conn, "episode-1", "trading-philosophy", 4)
            .expect("episode skill");
        assert_eq!(loaded.content, "content");
        assert!(
            load_review_skill_definition(&conn, "episode-1", "trading-philosophy", 3,).is_err()
        );
    }

    #[test]
    fn review_market_path_reports_candle_phases_and_incomplete_post_exit_window() {
        let conn = Connection::open_in_memory().expect("database");
        conn.execute_batch(
            "CREATE TABLE candles(
               symbol TEXT NOT NULL,interval TEXT NOT NULL,open_time INTEGER NOT NULL,
               open TEXT NOT NULL,high TEXT NOT NULL,low TEXT NOT NULL,close TEXT NOT NULL,
               volume TEXT NOT NULL,confirm INTEGER NOT NULL
             );",
        )
        .expect("schema");
        let open_time = 1_800_000_000_000_i64;
        let close_time = open_time + 60 * 60 * 1000;
        let first_time = open_time - 6 * 60 * 60 * 1000;
        let last_time = close_time + 2 * 60 * 60 * 1000;
        let mut timestamp = first_time;
        let mut index = 0_i64;
        while timestamp < last_time {
            let open = 100.0 + ((index % 30) as f64 - 15.0) / 10.0;
            let close = open + 0.2;
            conn.execute(
                "INSERT INTO candles VALUES('BTC-USDT-SWAP','1m',?1,?2,?3,?4,?5,'10',1)",
                params![
                    timestamp,
                    open.to_string(),
                    (open + 0.5).to_string(),
                    (open - 0.5).to_string(),
                    close.to_string(),
                ],
            )
            .expect("candle");
            timestamp += 60_000;
            index += 1;
        }
        let summary = review_market_path(
            &conn,
            &json!({
                "instId": "BTC-USDT-SWAP",
                "side": "long",
                "openTime": open_time,
                "closeTime": close_time,
                "avgOpenPx": "100",
            }),
        );
        assert_eq!(
            summary.get("available").and_then(Value::as_bool),
            Some(true)
        );
        assert!(summary
            .pointer("/bars/15m/preEntry/count")
            .and_then(Value::as_u64)
            .is_some_and(|count| count > 0));
        assert!(summary
            .pointer("/bars/15m/holding/count")
            .and_then(Value::as_u64)
            .is_some_and(|count| count > 0));
        assert!(summary
            .pointer("/holdingExcursion/maxFavorableExcursionPct")
            .and_then(Value::as_f64)
            .is_some_and(|value| value > 0.0));
        assert!(summary
            .get("limitations")
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().any(|item| {
                item.as_str()
                    .is_some_and(|text| text.contains("平仓后 6 小时"))
            })));
    }

    #[test]
    fn review_canonical_facts_use_backend_time_and_environment() {
        let facts = build_review_canonical_facts(
            "BTC-USDT-SWAP",
            "live",
            1_785_329_917_719,
            Some(1_785_354_473_316),
        )
        .expect("canonical review facts");
        assert_eq!(facts.open_time_text, "2026-07-29 20:58:37");
        assert_eq!(facts.close_time_text, "2026-07-30 03:47:53");
        assert_eq!(facts.holding_duration_text, "6小时49分15秒");
        assert_eq!(facts.environment, "live");
        assert_eq!(facts.environment_label, "实盘账户");
        assert_eq!(
            facts.summary_header,
            "BTC-USDT-SWAP 仓位复盘（2026-07-29 20:58:37 → 2026-07-30 03:47:53，UTC+8，实盘账户，持仓 6小时49分15秒）"
        );
        validate_review_summary(
            &format!("{}\n\n决策质量与执行质量分开评价。", facts.summary_header),
            &facts,
        )
        .expect("canonical header must pass");
        let error = validate_review_summary(
            "BTC-USDT-SWAP 仓位复盘（2025/6/3 → 2025/6/7，模拟盘账户，持仓 91 小时）",
            &facts,
        )
        .expect_err("invented review timeline must fail");
        assert!(error.contains("canonicalFacts.summaryHeader"));
    }

    #[test]
    fn automation_overview_counts_are_available_without_loading_sections() {
        let conn = Connection::open_in_memory().expect("open automation count database");
        conn.execute_batch(
            "CREATE TABLE ai_agent_runs (status TEXT NOT NULL);
             CREATE TABLE ai_wake_conditions (status TEXT NOT NULL);
             CREATE TABLE ai_trade_reviews (id TEXT);
             CREATE TABLE ai_daily_market_reviews (id TEXT);
             CREATE TABLE ai_optimization_suggestions (status TEXT NOT NULL);
             CREATE TABLE ai_notification_deliveries (id TEXT);
             INSERT INTO ai_agent_runs VALUES ('queued'), ('running'), ('completed');
             INSERT INTO ai_wake_conditions VALUES ('active'), ('active'), ('expired');
             INSERT INTO ai_trade_reviews VALUES ('trade-review');
             INSERT INTO ai_daily_market_reviews VALUES ('daily-review');
             INSERT INTO ai_optimization_suggestions VALUES ('pending'), ('ready'), ('published');
             INSERT INTO ai_notification_deliveries VALUES ('notice-1'), ('notice-2');",
        )
        .expect("seed automation counts");

        let counts = load_automation_counts(&conn).expect("load automation counts");
        assert_eq!(counts.runs, 3);
        assert_eq!(counts.running_runs, 2);
        assert_eq!(counts.active_wake_conditions, 2);
        assert_eq!(counts.reviews, 2);
        assert_eq!(counts.pending_optimization_suggestions, 2);
        assert_eq!(counts.notifications, 2);
    }

    #[test]
    fn run_list_hydrates_legacy_metadata_once_and_then_uses_cached_summary() {
        let conn = Connection::open_in_memory().expect("open run list database");
        conn.execute_batch(
            "CREATE TABLE ai_agent_runs(
               id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,trigger_type TEXT NOT NULL,status TEXT NOT NULL,
               summary TEXT,error TEXT,started_at INTEGER NOT NULL,finished_at INTEGER,next_wake_at INTEGER,
               created_at INTEGER NOT NULL,action_counts_json TEXT NOT NULL DEFAULT '{}',token_usage_json TEXT,
               triage_json TEXT,experts_json TEXT,audit_json TEXT,
               single_agent_mode TEXT NOT NULL DEFAULT 'standard'
             );
             CREATE TABLE ai_messages(
               id TEXT PRIMARY KEY,session_id TEXT NOT NULL,role TEXT NOT NULL,
               content TEXT NOT NULL,reasoning TEXT,tool_json TEXT,status TEXT,created_at INTEGER NOT NULL
             );
             CREATE TABLE ai_notification_deliveries(id TEXT PRIMARY KEY,run_id TEXT);",
        )
        .expect("create run list schema");
        let mut events = vec![
            json!({
                "type": "toolCall",
                "toolCallId": "opportunity-1",
                "name": "tradeOpportunity.create"
            }),
            json!({
                "type": "toolResult",
                "toolCallId": "opportunity-1",
                "ok": true
            }),
            json!({
                "type": "usage",
                "usage": { "inputTokens": 12, "outputTokens": 3 }
            }),
        ];
        append_ai_usage_summary_event(&mut events, "test", "model", "model", "Model");
        conn.execute(
            "INSERT INTO ai_agent_runs(
               id,profile_id,trigger_type,status,summary,error,started_at,finished_at,next_wake_at,created_at
             ) VALUES('run-1','profile-1','manual','completed',NULL,NULL,10,11,NULL,11)",
            [],
        )
        .expect("insert run");
        let stale_usage = json!({
            "schemaVersion": 1,
            "provider": "test",
            "modelId": "model",
            "model": "model",
            "modelName": "Model",
            "reported": true,
            "agentCount": 0,
            "usage": {
                "inputTokens": 1,
                "outputTokens": 1,
                "cacheReadTokens": 0,
                "cacheWriteTokens": 0,
                "reasoningTokens": 0,
                "totalTokens": 2
            },
            "mainUsage": {
                "inputTokens": 1,
                "outputTokens": 1,
                "cacheReadTokens": 0,
                "cacheWriteTokens": 0,
                "reasoningTokens": 0,
                "totalTokens": 2
            }
        });
        conn.execute(
            "UPDATE ai_agent_runs SET token_usage_json=?2 WHERE id=?1",
            params!["run-1", stale_usage.to_string()],
        )
        .expect("seed stale run usage cache");
        conn.execute(
            "INSERT INTO ai_messages(id,session_id,role,content,tool_json,created_at)
             VALUES('message-1','background:run-1','assistant','done',?1,11)",
            [serde_json::to_string(&events).expect("serialize tool history")],
        )
        .expect("insert tool history");

        let first = load_runs(&conn, 50).expect("hydrate legacy run summary");
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].action_counts.opportunity, 1);
        assert_eq!(
            first[0]
                .token_usage
                .as_ref()
                .map(|usage| usage.usage.total_tokens),
            Some(15)
        );

        conn.execute("DELETE FROM ai_messages", [])
            .expect("remove raw history after cache write");
        let second = load_runs(&conn, 50).expect("read cached run summary");
        assert_eq!(second[0].action_counts.opportunity, 1);
        assert_eq!(
            second[0]
                .token_usage
                .as_ref()
                .map(|usage| usage.usage.total_tokens),
            Some(15)
        );
    }

    #[test]
    fn usage_summary_adds_main_and_each_sub_agent_once() {
        let mut events = vec![
            json!({
                "type": "usage",
                "usage": {
                    "inputTokens": 100,
                    "outputTokens": 20,
                    "cacheReadTokens": 40
                }
            }),
            json!({
                "type": "agentDone",
                "configuredAgentId": "market",
                "result": { "usage": { "inputTokens": 50, "outputTokens": 10 } }
            }),
            json!({
                "type": "agentDone",
                "configuredAgentId": "risk",
                "result": { "usage": { "input_tokens": 30, "output_tokens": 5 } }
            }),
        ];
        let summary = append_ai_usage_summary_event(
            &mut events,
            "openai-compatible",
            "model-1",
            "test-model",
            "Test Model",
        );
        assert!(summary.reported);
        assert_eq!(summary.agent_count, 2);
        assert_eq!(summary.main_usage.input_tokens, 100);
        assert_eq!(summary.usage.input_tokens, 180);
        assert_eq!(summary.usage.output_tokens, 35);
        assert_eq!(summary.usage.cache_read_tokens, 40);
        assert_eq!(summary.usage.total_tokens, 215);

        let serialized = serde_json::to_string(&events).expect("serialize usage events");
        let parsed = parse_ai_usage_summary(&serialized).expect("parse stored usage summary");
        assert_eq!(parsed.usage, summary.usage);
        let tail = serialized
            .chars()
            .rev()
            .take(32_768)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>();
        let compact = extract_compact_usage_summary(&tail).expect("parse compact usage summary");
        assert_eq!(compact.usage, summary.usage);
    }

    #[test]
    fn usage_summary_reconstructs_cumulative_main_usage_and_cache_deltas() {
        let events = vec![
            json!({
                "type": "usage",
                "usage": {
                    "inputTokens": 100,
                    "outputTokens": 20,
                    "cacheReadTokens": 40,
                    "totalInputTokens": 100,
                    "totalOutputTokens": 20
                }
            }),
            json!({
                "type": "usage",
                "usage": {
                    "inputTokens": 200,
                    "outputTokens": 30,
                    "cacheReadTokens": 60,
                    "totalInputTokens": 300,
                    "totalOutputTokens": 50
                }
            }),
        ];
        let summary = build_ai_usage_summary(
            &events,
            "openai-compatible",
            "model-1",
            "model-1",
            "Model 1",
        );
        assert_eq!(summary.schema_version, AI_USAGE_SCHEMA_VERSION);
        assert_eq!(summary.quality, AiUsageQuality::Reconstructed);
        assert_eq!(summary.main_usage.input_tokens, 300);
        assert_eq!(summary.main_usage.output_tokens, 50);
        assert_eq!(summary.main_usage.cache_read_tokens, 100);
        assert_eq!(summary.main_usage.total_tokens, 350);
    }

    #[test]
    fn usage_summary_prefers_protocol_cache_totals() {
        let events = vec![
            json!({
                "type": "usage",
                "usage": {
                    "usageKind": "delta-with-totals",
                    "inputTokens": 100,
                    "outputTokens": 20,
                    "cacheReadTokens": 40,
                    "totalInputTokens": 100,
                    "totalOutputTokens": 20,
                    "totalCacheReadTokens": 40
                }
            }),
            json!({
                "type": "usage",
                "usage": {
                    "usageKind": "delta-with-totals",
                    "inputTokens": 200,
                    "outputTokens": 30,
                    "cacheReadTokens": 60,
                    "totalInputTokens": 300,
                    "totalOutputTokens": 50,
                    "totalCacheReadTokens": 100
                }
            }),
        ];
        let summary = build_ai_usage_summary(&events, "test", "model", "model", "Model");
        assert_eq!(summary.quality, AiUsageQuality::ProviderReported);
        assert_eq!(summary.main_usage.input_tokens, 300);
        assert_eq!(summary.main_usage.output_tokens, 50);
        assert_eq!(summary.main_usage.cache_read_tokens, 100);
    }

    #[test]
    fn usage_summary_handles_mixed_legacy_and_cumulative_snapshots_without_double_counting() {
        let events = vec![
            json!({
                "type": "usage",
                "usage": {
                    "usageKind": "delta-with-totals",
                    "inputTokens": 100,
                    "outputTokens": 20,
                    "cacheReadTokens": 40,
                    "totalInputTokens": 100,
                    "totalOutputTokens": 20,
                    "totalCacheReadTokens": 40
                }
            }),
            json!({
                "type": "usage",
                "usage": {
                    "usageKind": "cumulative",
                    "inputTokens": 300,
                    "outputTokens": 50,
                    "cacheReadTokens": 100
                }
            }),
        ];
        let summary = build_ai_usage_summary(&events, "test", "model", "model", "Model");
        assert_eq!(summary.main_usage.input_tokens, 300);
        assert_eq!(summary.main_usage.output_tokens, 50);
        assert_eq!(summary.main_usage.cache_read_tokens, 100);
    }

    #[test]
    fn usage_summary_marks_missing_sub_agent_usage_partial() {
        let events = vec![
            json!({
                "type": "usage",
                "usage": {
                    "usageKind": "cumulative",
                    "inputTokens": 100,
                    "outputTokens": 20
                }
            }),
            json!({
                "type": "agentDone",
                "configuredAgentId": "risk",
                "result": { "status": "completed" }
            }),
        ];
        let summary = build_ai_usage_summary(&events, "test", "model", "model", "Model");
        assert!(summary.reported);
        assert_eq!(summary.quality, AiUsageQuality::Partial);
        assert_eq!(summary.agent_count, 1);
        assert_eq!(summary.reported_agent_count, 0);
        assert_eq!(summary.unreported_agent_count, 1);
    }

    #[test]
    fn usage_summary_repairs_legacy_claude_full_input_contract() {
        let events = vec![json!({
            "type": "usage",
            "usage": {
                "inputTokens": 10,
                "outputTokens": 5,
                "cacheReadTokens": 90,
                "totalInputTokens": 10,
                "totalOutputTokens": 5
            }
        })];
        let summary = build_ai_usage_summary(&events, "claude-code", "claude", "claude", "Claude");
        assert_eq!(summary.main_usage.input_tokens, 100);
        assert_eq!(summary.main_usage.output_tokens, 5);
        assert_eq!(summary.main_usage.total_tokens, 105);
    }

    #[test]
    fn background_finish_failure_reports_the_rejected_schema_field() {
        let events = json!([
            {
                "type": "toolCall",
                "toolCallId": "finish-1",
                "name": "background.finishRun",
                "arguments": { "finalDecision": { "confidence": 0.62 } }
            },
            {
                "type": "toolResult",
                "toolCallId": "finish-1",
                "name": "background.finishRun",
                "result": {
                    "accepted": false,
                    "executed": false,
                    "errorCode": "invalid_tool_arguments",
                    "errors": ["/finalDecision 不支持字段 confidence"]
                }
            }
        ]);
        assert_eq!(
            parse_background_finish_failure(&events.to_string()).as_deref(),
            Some("background.finishRun 未完成：/finalDecision 不支持字段 confidence")
        );

        let completed = json!([
            { "type": "toolCall", "toolCallId": "finish-2", "name": "background.finishRun" },
            {
                "type": "toolResult",
                "toolCallId": "finish-2",
                "result": { "accepted": true, "executed": true }
            }
        ]);
        assert_eq!(
            parse_background_finish_failure(&completed.to_string()),
            None
        );
    }

    #[test]
    fn usage_backfill_is_idempotent_and_preserves_raw_tool_history() {
        let mut conn = Connection::open_in_memory().expect("open usage backfill database");
        conn.execute_batch(
            "CREATE TABLE ai_messages(
               id TEXT PRIMARY KEY,session_id TEXT NOT NULL,role TEXT NOT NULL,
               content TEXT NOT NULL,reasoning TEXT,tool_json TEXT,
               token_usage_json TEXT,token_usage_version INTEGER NOT NULL DEFAULT 0,
               status TEXT,created_at INTEGER NOT NULL
             );",
        )
        .expect("create usage backfill schema");
        let events = json!([
            {
                "type": "usage",
                "usage": {
                    "inputTokens": 100,
                    "outputTokens": 20,
                    "cacheReadTokens": 40,
                    "totalInputTokens": 100,
                    "totalOutputTokens": 20
                }
            },
            {
                "type": "usage",
                "usage": {
                    "inputTokens": 200,
                    "outputTokens": 30,
                    "cacheReadTokens": 60,
                    "totalInputTokens": 300,
                    "totalOutputTokens": 50
                }
            },
            {
                "type": "usageSummary",
                "__desicUsageSummary": {
                    "provider": "openai-compatible",
                    "modelId": "model-1",
                    "model": "model-1",
                    "modelName": "Model 1",
                    "reported": true,
                    "agentCount": 0,
                    "usage": {
                        "inputTokens": 200,
                        "outputTokens": 30,
                        "cacheReadTokens": 60,
                        "cacheWriteTokens": 0,
                        "reasoningTokens": 0,
                        "totalTokens": 230
                    },
                    "mainUsage": {
                        "inputTokens": 200,
                        "outputTokens": 30,
                        "cacheReadTokens": 60,
                        "cacheWriteTokens": 0,
                        "reasoningTokens": 0,
                        "totalTokens": 230
                    }
                }
            }
        ]);
        let tool_json = serde_json::to_string(&events).expect("serialize legacy events");
        conn.execute(
            "INSERT INTO ai_messages(id,session_id,role,content,tool_json,status,created_at)
             VALUES('message-1','session-1','assistant','',?1,'done',1),
                   ('message-2','session-1','assistant','','[]','done',2)",
            params![tool_json],
        )
        .expect("insert legacy usage messages");

        ensure_ai_message_usage_for_session(&mut conn, "session-1")
            .expect("backfill usage summaries");
        let (stored_tool_json, summary_json, version) = conn
            .query_row(
                "SELECT tool_json,token_usage_json,token_usage_version
                 FROM ai_messages WHERE id='message-1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .expect("read rebuilt usage");
        let summary: AiUsageSummary =
            serde_json::from_str(&summary_json).expect("parse rebuilt summary");
        assert_eq!(stored_tool_json, tool_json);
        assert_eq!(version, AI_USAGE_SCHEMA_VERSION as i64);
        assert_eq!(summary.provider, "openai-compatible");
        assert_eq!(summary.usage.input_tokens, 300);
        assert_eq!(summary.usage.output_tokens, 50);
        assert_eq!(summary.usage.cache_read_tokens, 100);

        ensure_ai_message_usage_for_session(&mut conn, "session-1").expect("repeat usage backfill");
        let repeated = conn
            .query_row(
                "SELECT token_usage_json FROM ai_messages WHERE id='message-1'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("read repeated summary");
        assert_eq!(repeated, summary_json);
        let unreported: AiUsageSummary = conn
            .query_row(
                "SELECT token_usage_json FROM ai_messages WHERE id='message-2'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok()
            .and_then(|value| serde_json::from_str(&value).ok())
            .expect("parse unreported summary");
        assert!(!unreported.reported);
        assert_eq!(unreported.quality, AiUsageQuality::Unreported);
    }

    #[test]
    fn usage_dashboard_groups_shanghai_days_and_models() {
        const DAY_MS: i64 = 86_400_000;
        const OFFSET_MS: i64 = 8 * 60 * 60 * 1000;
        let now = 1_800_000_000_000_i64;
        let today_start = (now + OFFSET_MS).div_euclid(DAY_MS) * DAY_MS - OFFSET_MS;
        let mut conn = Connection::open_in_memory().expect("open usage database");
        conn.execute_batch(
            "CREATE TABLE ai_messages(
               id TEXT PRIMARY KEY,session_id TEXT NOT NULL,role TEXT NOT NULL,
               content TEXT NOT NULL,reasoning TEXT,tool_json TEXT,
               token_usage_json TEXT,token_usage_version INTEGER NOT NULL DEFAULT 0,
               status TEXT,created_at INTEGER NOT NULL
             );",
        )
        .expect("create usage schema");

        let insert_usage = |id: &str,
                            session_id: &str,
                            created_at: i64,
                            model_id: &str,
                            input: u64,
                            output: u64| {
            let mut events = vec![json!({
                "type": "usage",
                "usage": { "inputTokens": input, "outputTokens": output }
            })];
            append_ai_usage_summary_event(
                &mut events,
                "test-provider",
                model_id,
                model_id,
                model_id,
            );
            conn.execute(
                "INSERT INTO ai_messages(id,session_id,role,content,tool_json,status,created_at)
                 VALUES(?1,?2,'assistant','',?3,'done',?4)",
                params![
                    id,
                    session_id,
                    serde_json::to_string(&events).expect("serialize usage"),
                    created_at
                ],
            )
            .expect("insert usage message");
        };
        insert_usage("today", "session-a", now - 1_000, "model-a", 100, 20);
        insert_usage(
            "yesterday",
            "session-a",
            today_start - 1_000,
            "model-a",
            80,
            10,
        );
        insert_usage(
            "older",
            "session-b",
            today_start - 4 * DAY_MS,
            "model-b",
            50,
            5,
        );

        let dashboard =
            load_ai_token_usage_dashboard(&mut conn, now).expect("load usage dashboard");
        assert_eq!(dashboard.today.turn_count, 1);
        assert_eq!(dashboard.today.usage.total_tokens, 120);
        assert_eq!(dashboard.yesterday.turn_count, 1);
        assert_eq!(dashboard.yesterday.usage.total_tokens, 90);
        assert_eq!(dashboard.seven_days.turn_count, 3);
        assert_eq!(dashboard.seven_days.session_count, 2);
        assert_eq!(dashboard.seven_days.usage.total_tokens, 265);
        assert_eq!(dashboard.by_model.len(), 2);
        let model_a = dashboard
            .by_model
            .iter()
            .find(|item| item.model_id == "model-a")
            .expect("model a row");
        assert_eq!(model_a.seven_days.usage.total_tokens, 210);
    }

    #[test]
    fn only_customizable_required_skill_can_publish_builtin_drafts() {
        let definition = |id: &str, builtin: bool| desic_storage_config::AiSkillDefinition {
            id: id.to_string(),
            name: id.to_string(),
            description: "test".to_string(),
            rules: "test".to_string(),
            content: "test".to_string(),
            builtin,
            bundle: None,
        };

        assert!(skill_draft_can_be_published(&definition(
            "trading-philosophy",
            true
        )));
        assert!(skill_draft_can_be_published(&definition(
            "custom-research",
            false
        )));
        assert!(!skill_draft_can_be_published(&definition(
            "desic-core-operations",
            true
        )));
        assert!(!skill_draft_can_be_published(&definition(
            "okx-market-intelligence",
            true
        )));
    }



    fn insert_test_profile(
        conn: &Connection,
        id: &str,
        multi_agent_mode: &str,
        multi_agent_max_agents: u32,
        multi_agents_json: &str,
    ) {
        conn.execute(
            "INSERT INTO ai_agent_profiles(
               id,name,enabled,mode,environment,symbols_json,scan_interval_minutes,
               skill_ids_json,skill_versions_json,history_lookback_days,
               similarity_window_minutes,entry_tolerance_bps,max_runtime_seconds,
               min_wake_interval_seconds,max_runs_per_hour,allowed_wake_condition_types_json,
               multi_agent_mode,multi_agent_max_agents,multi_agents_json,created_at,updated_at
             ) VALUES(?1,'Test',1,'advisor','demo','[\"BTC-USDT-SWAP\"]',15,
               '[]','{}',30,10,30,180,60,12,'[]',?2,?3,?4,1,1)",
            params![
                id,
                multi_agent_mode,
                multi_agent_max_agents,
                multi_agents_json
            ],
        )
        .expect("insert test profile");
    }

    fn insert_test_run(conn: &Connection, id: &str, profile_id: &str, snapshot: Option<&str>) {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS ai_messages(
               session_id TEXT NOT NULL,
               role TEXT NOT NULL,
               tool_json TEXT,
               created_at INTEGER NOT NULL
             );",
        )
        .expect("create test AI messages table");
        conn.execute(
            "INSERT INTO ai_agent_runs(
               id,profile_id,trigger_type,status,trigger_json,profile_snapshot_json,
               skill_versions_json,started_at,created_at,updated_at
             ) VALUES(?1,?2,'manual','queued','{}',?3,'{}',1,1,1)",
            params![id, profile_id, snapshot],
        )
        .expect("insert test run");
    }

    /// 迁移日志去重：同一 profile 在进程内只记一次，不同 key 互不影响
    /// （旧列要等首次保存才被覆盖 → 每次读都会重新迁移，不能每次都刷 boot_log）。
    /// 线上事故 2026-09-19：单次 provider 请求的空闲上限必须**显式下发**
    /// （60s → 240s 的热修不能让 Rust 侧"支持但永不下发"），并且不能破坏已有 config 键。
    #[test]
    fn request_idle_timeout_is_sent_with_every_ai_config() {
        assert_eq!(crate::ai_automation::AI_REQUEST_IDLE_TIMEOUT_MS, 240_000);
        let config = crate::ai_automation::with_request_timeout(json!({
            "provider": "openai-compatible",
            "model": "model-a",
            "baseUrl": "http://127.0.0.1:8004/v1",
            "permissionMode": "advisor",
            "reasoningDepth": "none"
        }));
        assert_eq!(config["requestTimeoutMs"], 240_000);
        assert_eq!(config["model"], "model-a");
        assert_eq!(config["permissionMode"], "advisor");
        // 幂等：重复包装不改变结果。
        let twice = crate::ai_automation::with_request_timeout(config.clone());
        assert_eq!(twice, config);
        // 非对象输入不 panic（防御）。
        assert_eq!(
            crate::ai_automation::with_request_timeout(json!("not-an-object")),
            json!("not-an-object")
        );
    }

    /// 僵尸运行清理：进程已死（`started_at` 与心跳都超过阈值）的 running 行标记为 failed；
    /// 正在跑的运行（心跳新鲜）与刚启动的运行绝不误伤。
    #[test]
    fn stale_running_runs_are_failed_without_touching_live_ones() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        migrate_ai_automation(&conn).expect("migrate automation schema");

        let now = 1_700_000_000_000_i64;
        // `ai_agent_runs` 对同一 Profile 只允许一个 queued/running 行（部分唯一索引），
        // 因此每个用例一个 Profile。
        let insert_run = |id: &str, started_at: i64, updated_at: i64| {
            let profile_id = format!("profile-{id}");
            insert_test_profile(&conn, &profile_id, "off", 4, "[]");
            conn.execute(
                "INSERT INTO ai_agent_runs(
                   id,profile_id,trigger_type,status,trigger_json,skill_versions_json,
                   started_at,created_at,updated_at
                 ) VALUES(?1,?2,'manual','running','{}','{}',?3,?3,?4)",
                params![id, profile_id, started_at, updated_at],
            )
            .expect("insert running run");
        };
        let thirty_one_minutes = 31 * 60 * 1000_i64;
        let five_minutes = 5 * 60 * 1000_i64;

        insert_run("run-zombie", now - thirty_one_minutes, now - thirty_one_minutes);
        insert_run("run-live-long", now - 3 * 60 * 60 * 1000, now - 1_000);
        insert_run("run-fresh", now - five_minutes, now - five_minutes);
        insert_test_profile(&conn, "profile-run-queued", "off", 4, "[]");
        conn.execute(
            "INSERT INTO ai_agent_runs(
               id,profile_id,trigger_type,status,trigger_json,skill_versions_json,
               started_at,created_at,updated_at
             ) VALUES('run-queued','profile-run-queued','manual','queued','{}','{}',?1,?1,?1)",
            params![now - thirty_one_minutes],
        )
        .expect("insert queued run");

        let failed = crate::ai_automation::fail_stale_running_runs(&conn, now).expect("cleanup");
        assert_eq!(failed, 1, "只应清理僵尸运行");
        let (status, error): (String, Option<String>) = conn
            .query_row(
                "SELECT status,error FROM ai_agent_runs WHERE id='run-zombie'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("load zombie run");
        assert_eq!(status, "failed");
        assert_eq!(error.as_deref(), Some("运行被中断（应用退出/崩溃）"));
        let finished_at: Option<i64> = conn
            .query_row(
                "SELECT finished_at FROM ai_agent_runs WHERE id='run-zombie'",
                [],
                |row| row.get(0),
            )
            .expect("finished_at");
        assert_eq!(finished_at, Some(now));

        // 心跳新鲜的长时间运行、刚启动的运行、以及 queued 行都不受影响。
        for id in ["run-live-long", "run-fresh", "run-queued"] {
            let status: String = conn
                .query_row(
                    "SELECT status FROM ai_agent_runs WHERE id=?1",
                    params![id],
                    |row| row.get(0),
                )
                .expect("load run status");
            assert_eq!(
                status,
                if id == "run-queued" { "queued" } else { "running" },
                "{id} 不得被清理"
            );
        }
        // 幂等：再次清理不重复处理。
        assert_eq!(
            crate::ai_automation::fail_stale_running_runs(&conn, now).expect("cleanup again"),
            0
        );
    }

    /// 心跳来源：后台 Run 的流式检查点会推进 `ai_agent_runs.updated_at`
    /// （僵尸运行清理依赖它，否则只能靠 started_at 猜、会误杀长运行）。
    #[test]
    fn stream_checkpoint_advances_background_run_heartbeat() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        migrate_ai_automation(&conn).expect("migrate automation schema");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS ai_messages(
               id TEXT PRIMARY KEY,
               session_id TEXT NOT NULL,
               role TEXT NOT NULL,
               content TEXT NOT NULL,
               reasoning TEXT,
               tool_json TEXT,
               token_usage_json TEXT,
               token_usage_version INTEGER NOT NULL DEFAULT 0,
               status TEXT,
               created_at INTEGER NOT NULL
             );",
        )
        .expect("create ai_messages");
        insert_test_profile(&conn, "profile-heartbeat", "off", 4, "[]");
        conn.execute(
            "INSERT INTO ai_agent_runs(
               id,profile_id,trigger_type,status,trigger_json,skill_versions_json,
               started_at,created_at,updated_at
             ) VALUES('run-heartbeat','profile-heartbeat','manual','running','{}','{}',1,1,1)",
            [],
        )
        .expect("insert running run");

        crate::ai_stream_checkpoint::persist_ai_stream_checkpoint_with_conn(
            &conn,
            "background:run-heartbeat",
            "message-heartbeat",
            "流式内容",
            None,
            "[]",
            "streaming",
        )
        .expect("persist checkpoint");
        let updated_at: i64 = conn
            .query_row(
                "SELECT updated_at FROM ai_agent_runs WHERE id='run-heartbeat'",
                [],
                |row| row.get(0),
            )
            .expect("updated_at");
        assert!(updated_at > 1, "检查点必须推进运行心跳");
        // 前台会话不推进任何运行心跳。
        crate::ai_stream_checkpoint::persist_ai_stream_checkpoint_with_conn(
            &conn,
            "session-interactive",
            "message-interactive",
            "内容",
            None,
            "[]",
            "streaming",
        )
        .expect("persist interactive checkpoint");
        let unchanged: i64 = conn
            .query_row(
                "SELECT updated_at FROM ai_agent_runs WHERE id='run-heartbeat'",
                [],
                |row| row.get(0),
            )
            .expect("updated_at");
        assert_eq!(unchanged, updated_at);
    }

    #[test]
    fn migration_log_keeps_one_line_per_profile() {
        let profile_key = "profile:log-dedupe-test";
        assert!(migration_log_slot(profile_key), "首次迁移应记录");
        assert!(!migration_log_slot(profile_key), "同一 profile 不得重复记录");
        assert!(
            migration_log_slot("snapshot:log-dedupe-test"),
            "运行快照是独立来源，可各自记录一次"
        );
        assert!(!migration_log_slot("snapshot:log-dedupe-test"));
        assert!(migration_log_slot("profile:log-dedupe-other"));
    }

    #[test]
    fn enabled_systematic_profile_conflicts_match_account_environment_and_symbol() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch(
            "CREATE TABLE systematic_profiles (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               inst_id TEXT NOT NULL,
               account_id TEXT NOT NULL,
               environment TEXT NOT NULL,
               enabled INTEGER NOT NULL,
               updated_at INTEGER NOT NULL
             );
             INSERT INTO systematic_profiles VALUES
               ('strategy-btc','BTC strategy','BTC-USDT-SWAP','account-1','live',1,30),
               ('strategy-eth','ETH strategy','ETH-USDT-SWAP','account-1','live',1,20),
               ('strategy-demo','Demo BTC strategy','BTC-USDT-SWAP','account-1','demo',1,10),
               ('strategy-off','Stopped BTC strategy','BTC-USDT-SWAP','account-1','live',0,40),
               ('strategy-other-account','Other account BTC strategy','BTC-USDT-SWAP','account-2','live',1,50);",
        )
        .expect("create systematic profile fixture");

        let conflicts = enabled_systematic_profile_conflicts(
            &conn,
            Some("account-1"),
            "live",
            &["BTC-USDT-SWAP".to_string(), "SOL-USDT-SWAP".to_string()],
        )
        .expect("load conflicts");

        assert_eq!(
            conflicts,
            vec![AiAgentProfileSystematicConflict {
                id: "strategy-btc".to_string(),
                name: "BTC strategy".to_string(),
                inst_id: "BTC-USDT-SWAP".to_string(),
            }]
        );
    }

    #[test]
    fn automation_profile_schema_includes_multi_agent_configuration() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        migrate_ai_automation(&conn).expect("migrate automation schema");
        let mut stmt = conn
            .prepare("PRAGMA table_info(ai_agent_profiles)")
            .expect("prepare profile columns");
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query profile columns")
            .collect::<Result<HashSet<_>, _>>()
            .expect("collect profile columns");
        for column in [
            // v3 新列（唯一写入口）
            "enabled_agent_ids_json",
            // 旧列保留（回滚需要，不写不读）
            "multi_agent_mode",
            "multi_agent_max_agents",
            "multi_agents_json",
            "multi_agent_scheme_id",
            "target_leverage",
            "max_single_trade_margin_pct",
            "skill_version_modes_json",
            "reasoning_depth",
        ] {
            assert!(columns.contains(column), "missing {column}");
        }
        // 旧方案表结构保留（回滚 + 迁移读取），命令层不再暴露。
        let scheme_columns = conn
            .prepare("PRAGMA table_info(ai_agent_schemes)")
            .expect("prepare scheme columns")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query scheme columns")
            .collect::<Result<HashSet<_>, _>>()
            .expect("collect scheme columns");
        for column in [
            "id",
            "name",
            "description",
            "agents_json",
            "created_at",
            "updated_at",
            "instructions",
            "skill_ids_json",
            "phase",
            "model",
            "reasoning_depth",
        ] {
            assert!(scheme_columns.contains(column), "missing {column}");
        }
    }



    /// C20.5（强制迁移版）：含已下线 id 的旧 Profile 在**读取时**被改写成
    /// 「默认 4 个角色（内置顺序）+ 其余保留 id（原相对顺序）」并**落库**；
    /// 幂等、已合规 Profile 一个字节不改、空名单不动。
    #[test]
    fn profile_read_force_migrates_deprecated_enabled_agents() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        migrate_ai_automation(&conn).expect("migrate automation schema");
        let legacy_ids = json!([
            "desic-smart-money",
            "desic-historical-analogy",
            "desic-contrarian-review",
            "custom-agent",
            "desic-account-risk"
        ]);
        let insert = |id: &str, ids: Value| {
            let profile = normalize_profile(
                serde_json::from_value::<AiAgentProfileInput>(json!({
                    "name": "迁移回归",
                    "symbols": ["BTC-USDT-SWAP"],
                    "enabledAgentIds": ids,
                }))
                .expect("deserialize profile input"),
            )
            .expect("normalize profile input");
            upsert_profile_row(&conn, &profile, id, 1_000, 2_000).expect("insert profile row");
        };
        insert("profile-deprecated-mix", legacy_ids.clone());
        insert("profile-compliant", json!(["desic-data-digest", "desic-account-state", "desic-decision-proposal", "desic-contrarian-review"]));
        insert("profile-custom-only", json!(["custom-agent"]));
        insert("profile-empty", json!([]));

        let expected_migrated = vec![
            "desic-data-digest".to_string(),
            "desic-account-state".to_string(),
            "desic-decision-proposal".to_string(),
            "desic-contrarian-review".to_string(),
            "custom-agent".to_string(),
        ];
        let stored_ids = |id: &str| -> String {
            conn.query_row(
                "SELECT enabled_agent_ids_json FROM ai_agent_profiles WHERE id=?1",
                params![id],
                |row| row.get(0),
            )
            .expect("stored ids")
        };

        // ① 含已下线 + 自定义（董事会给的形状）：4 新在前、其余保留 id 在后，**已落库**。
        let loaded = load_profile(&conn, "profile-deprecated-mix").expect("load profile");
        assert_eq!(loaded.enabled_agent_ids, expected_migrated);
        assert_eq!(
            serde_json::from_str::<Vec<String>>(&stored_ids("profile-deprecated-mix"))
                .expect("persisted ids"),
            expected_migrated,
            "迁移必须持久化（不是只影响生效名单）"
        );

        // ② 幂等：第二次读取/再跑启动迁移都不再改写，`updated_at` 不推进。
        let updated_at: i64 = conn
            .query_row(
                "SELECT updated_at FROM ai_agent_profiles WHERE id='profile-deprecated-mix'",
                [],
                |row| row.get(0),
            )
            .expect("updated_at");
        let again = load_profile(&conn, "profile-deprecated-mix").expect("reload profile");
        assert_eq!(again.enabled_agent_ids, expected_migrated);
        assert_eq!(migrate_deprecated_enabled_agents(&conn), 1, "只剩纯自定义那条要迁");
        let updated_at_after: i64 = conn
            .query_row(
                "SELECT updated_at FROM ai_agent_profiles WHERE id='profile-deprecated-mix'",
                [],
                |row| row.get(0),
            )
            .expect("updated_at");
        assert_eq!(updated_at, updated_at_after, "幂等：已迁移的行不再被写");
        assert_eq!(migrate_deprecated_enabled_agents(&conn), 0, "全部幂等");

        // ③ 已合规 Profile：一个字节不改（连 updated_at 都不动）。
        let compliant_before = stored_ids("profile-compliant");
        let compliant = load_profile(&conn, "profile-compliant").expect("load compliant");
        assert_eq!(compliant.enabled_agent_ids.len(), 4);
        assert_eq!(stored_ids("profile-compliant"), compliant_before);

        // ④ 纯自定义 Profile（无已下线 id）→ 补齐默认 4 个，保留自定义。
        let custom = load_profile(&conn, "profile-custom-only").expect("load custom-only");
        assert_eq!(custom.enabled_agent_ids, expected_migrated);

        // ⑤ 空名单不动（新建 / 关闭协作的 Profile 不该凭空多出专家）。
        let empty = load_profile(&conn, "profile-empty").expect("load empty");
        assert!(empty.enabled_agent_ids.is_empty());
        assert_eq!(
            stored_ids("profile-empty"),
            "[]",
            "空名单不得被补齐成默认 4 个"
        );

        // 纯函数级：触发条件与"用户子集不动"。
        assert!(plan_enabled_agent_ids_migration(&[]).is_none(), "空名单不动");
        assert!(
            plan_enabled_agent_ids_migration(&expected_migrated).is_none(),
            "已合规不动"
        );
        assert_eq!(
            plan_enabled_agent_ids_migration(&[
                "desic-smart-money".to_string(),
                "custom-agent".to_string()
            ]),
            Some(expected_migrated.clone()),
            "含已下线 → 4 新 + 其余保留"
        );
        assert_eq!(
            plan_enabled_agent_ids_migration(&["custom-agent".to_string()]),
            Some(expected_migrated.clone()),
            "纯自定义 → 补齐 4 新"
        );
        assert!(
            plan_enabled_agent_ids_migration(&[
                "desic-data-digest".to_string(),
                "desic-account-state".to_string()
            ])
            .is_none(),
            "用户有意只跑 2 个角色：没有已下线 id 就不动手"
        );
    }

    #[test]
    fn profile_save_upsert_keeps_row_visible_and_timestamps_aligned() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        migrate_ai_automation(&conn).expect("migrate automation schema");
        let profile = normalize_profile(
            serde_json::from_value::<AiAgentProfileInput>(json!({
                "name": "保存回归",
                "symbols": ["BTC-USDT-SWAP"],
                "enabledAgentIds": ["desic-data-digest", "desic-account-state"],
                "targetLeverage": 25,
                "maxSingleTradeMarginPct": 40
            }))
            .expect("deserialize profile input"),
        )
        .expect("normalize profile input");

        // 新建保存：created_at=1000、updated_at=2000，deleted_at 必须保持 NULL，
        // 且保存后的行要能通过 load_profile（WHERE deleted_at IS NULL）读回。
        upsert_profile_row(&conn, &profile, "profile-save-regression", 1_000, 2_000)
            .expect("insert new profile row");
        let loaded = load_profile(&conn, "profile-save-regression").expect("load new profile");
        assert_eq!(loaded.created_at, 1_000);
        assert_eq!(loaded.updated_at, 2_000);
        assert_eq!(
            loaded.enabled_agent_ids,
            vec![
                "desic-data-digest".to_string(),
                "desic-account-state".to_string()
            ]
        );
        assert_eq!(loaded.target_leverage, 25);
        assert_eq!(loaded.max_single_trade_margin_pct, 40);
        let (deleted_at, enabled_json, legacy_mode, target_leverage, margin_pct): (
            Option<i64>,
            String,
            String,
            i64,
            i64,
        ) = conn
            .query_row(
                "SELECT deleted_at,enabled_agent_ids_json,multi_agent_mode,
                 target_leverage,max_single_trade_margin_pct
                 FROM ai_agent_profiles WHERE id='profile-save-regression'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .expect("query saved profile row");
        assert_eq!(deleted_at, None, "新建保存不得写入 deleted_at");
        assert_eq!(
            serde_json::from_str::<Vec<String>>(&enabled_json).expect("enabled ids json"),
            vec![
                "desic-data-digest".to_string(),
                "desic-account-state".to_string()
            ]
        );
        // 旧列停止写入：mode 固定 off（新模型没有主开关）。
        assert_eq!(legacy_mode, "off");
        assert_eq!(target_leverage, 25);
        assert_eq!(margin_pct, 40);

        // 存量重存（ON CONFLICT 路径，created_at 沿用旧值）：created_at 保持、
        // updated_at 前移、deleted_at 仍为 NULL。
        upsert_profile_row(&conn, &profile, "profile-save-regression", 1_000, 3_000)
            .expect("re-save existing profile row");
        let reloaded = load_profile(&conn, "profile-save-regression").expect("reload profile");
        assert_eq!(reloaded.created_at, 1_000, "重存不得改写 created_at");
        assert_eq!(reloaded.updated_at, 3_000, "重存必须前移 updated_at");
        let deleted_after_resave: Option<i64> = conn
            .query_row(
                "SELECT deleted_at FROM ai_agent_profiles WHERE id='profile-save-regression'",
                [],
                |row| row.get(0),
            )
            .expect("query deleted_at after re-save");
        assert_eq!(deleted_after_resave, None, "重存不得软删除已有 Profile");
    }






    #[test]
    fn required_profile_skills_cannot_be_removed() {
        let profile = serde_json::from_value::<AiAgentProfileInput>(json!({
            "name": "固定 Skills",
            "symbols": ["BTC-USDT-SWAP"],
            "skillIds": ["custom-risk-check", "trading-philosophy"]
        }))
        .expect("deserialize profile");
        let profile = normalize_profile(profile).expect("normalize profile");
        assert_eq!(
            profile.skill_ids,
            vec![
                "desic-core-operations",
                "trading-philosophy",
                "okx-market-intelligence",
                "market-radar-research",
                "desic-trade-operations",
                "desic-agent-orchestration",
                "custom-risk-check",
            ]
        );
    }

    #[test]
    fn profile_watch_symbols_are_limited_to_three_markets() {
        let valid = serde_json::from_value::<AiAgentProfileInput>(json!({
            "name": "三个品种",
            "symbols": ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP"]
        }))
        .expect("deserialize three-symbol profile");
        let valid = normalize_profile(valid).expect("three symbols should be accepted");
        assert_eq!(valid.symbols.len(), MAX_PROFILE_SYMBOLS);

        let invalid = serde_json::from_value::<AiAgentProfileInput>(json!({
            "name": "四个品种",
            "symbols": ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP", "DOGE-USDT-SWAP"]
        }))
        .expect("deserialize four-symbol profile");
        let error = normalize_profile(invalid).expect_err("four symbols must be rejected");
        assert!(error.contains("最多配置 3 个"));
    }

    #[test]
    fn profile_trade_limits_default_and_clamp() {
        let default_profile = serde_json::from_value::<AiAgentProfileInput>(json!({
            "name": "默认杠杆",
            "symbols": ["BTC-USDT-SWAP"]
        }))
        .expect("deserialize default profile");
        let default_profile = normalize_profile(default_profile).unwrap();
        assert_eq!(default_profile.target_leverage, 20);
        assert_eq!(default_profile.max_single_trade_margin_pct, 30);

        let high_profile = serde_json::from_value::<AiAgentProfileInput>(json!({
            "name": "杠杆上限",
            "symbols": ["BTC-USDT-SWAP"],
            "targetLeverage": 999
        }))
        .expect("deserialize high leverage profile");
        assert_eq!(
            normalize_profile(high_profile).unwrap().target_leverage,
            125
        );

        let high_margin_profile = serde_json::from_value::<AiAgentProfileInput>(json!({
            "name": "单笔占比上限",
            "symbols": ["BTC-USDT-SWAP"],
            "maxSingleTradeMarginPct": 999
        }))
        .expect("deserialize high margin profile");
        assert_eq!(
            normalize_profile(high_margin_profile)
                .unwrap()
                .max_single_trade_margin_pct,
            100
        );

        let conn = Connection::open_in_memory().expect("open in-memory database");
        migrate_ai_automation(&conn).expect("migrate automation schema");
        insert_test_profile(&conn, "profile-default-leverage", "off", 4, "[]");
        assert_eq!(
            load_profile(&conn, "profile-default-leverage")
                .expect("load migrated profile")
                .target_leverage,
            20
        );
        assert_eq!(
            load_profile(&conn, "profile-default-leverage")
                .expect("load migrated profile")
                .max_single_trade_margin_pct,
            30
        );
    }




    /// C7「运行历史兼容」+ C3 迁移：旧快照（multiAgentMode/multiAgents）不崩，
    /// 内存迁移成 enabledAgentIds；只有真正损坏的 JSON 才让 Run 失败。
    #[test]
    fn claim_run_migrates_legacy_profile_snapshots_without_failing() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        migrate_ai_automation(&conn).expect("migrate automation schema");
        set_setting(&conn, "master_enabled", json!(true)).expect("enable automation");
        // 每个用例一个 Profile：ai_agent_runs 对同一 Profile 只允许一个 queued/running 行。
        insert_test_profile(&conn, "profile-test", "off", 4, "[]");
        insert_test_profile(&conn, "profile-legacy", "custom", 4, "[]");
        insert_test_profile(&conn, "profile-unknown", "off", 4, "[]");
        insert_test_profile(&conn, "profile-explicit", "off", 4, "[]");

        // 真正损坏的快照仍然失败（错误处理未放宽）。
        insert_test_run(&conn, "run-malformed", "profile-test", Some("{"));
        let error = claim_next_run(&conn, 100).expect_err("malformed snapshot must fail");
        assert!(error.contains("Profile 快照"));
        let status = conn
            .query_row(
                "SELECT status FROM ai_agent_runs WHERE id='run-malformed'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("load failed run status");
        assert_eq!(status, "failed");

        // 旧 custom 快照：auto-* 走 alias + 自定义条目内存迁移，不再报错。
        let current = load_profile(&conn, "profile-legacy").expect("load profile");
        let mut legacy = serde_json::to_value(&current).expect("serialize profile");
        let object = legacy.as_object_mut().expect("profile object");
        object.remove("enabledAgentIds");
        object.insert("multiAgentMode".to_string(), json!("custom"));
        object.insert(
            "multiAgents".to_string(),
            json!([
                {
                    "id": "auto-market-structure",
                    "name": "市场结构",
                    "role": "market_structure",
                    "responsibility": "检查价格结构。",
                    "scopes": ["market"],
                    "required": true,
                    "enabled": true
                },
                {
                    "id": "legacy-custom-analyst",
                    "name": "旧自定义",
                    "role": "custom",
                    "responsibility": "旧自定义职责。",
                    "scopes": ["market"],
                    "required": false,
                    "enabled": true
                }
            ]),
        );
        insert_test_run(
            &conn,
            "run-legacy-custom",
            "profile-legacy",
            Some(&legacy.to_string()),
        );
        let (_, migrated_profile, _, _) = claim_next_run(&conn, 200)
            .expect("legacy snapshot must not fail")
            .expect("queued run");
        // C20.5：快照里的 `auto-market-structure` 迁移到**已下线**的历史角色，因此被
        // 过滤掉、不进生效名单（历史快照只读，不迁移不回写 → 旧专家不可能被派发）。
        assert!(!migrated_profile
            .enabled_agent_ids
            .contains(&"desic-market-structure".to_string()));
        assert!(migrated_profile
            .enabled_agent_ids
            .contains(&"legacy-custom-analyst".to_string()));
        assert!(!migrated_profile.migration_notes.is_empty());

        // 未知旧 mode 视为 off（不迁移、不报错）。
        let unknown_profile = load_profile(&conn, "profile-unknown").expect("load profile");
        let mut unknown_mode =
            serde_json::to_value(&unknown_profile).expect("serialize profile");
        let object = unknown_mode.as_object_mut().expect("profile object");
        object.remove("enabledAgentIds");
        object.insert("multiAgentMode".to_string(), json!("bogus"));
        insert_test_run(
            &conn,
            "run-unknown-mode",
            "profile-unknown",
            Some(&unknown_mode.to_string()),
        );
        let (_, profile, _, _) = claim_next_run(&conn, 300)
            .expect("unknown legacy mode is tolerated")
            .expect("queued run");
        assert!(profile.enabled_agent_ids.is_empty());

        // 新快照（enabledAgentIds）原样生效；库校验只发生在保存路径（C3），
        // 快照重放阶段保留原列表（不存在的 id 不会被解析成运行载荷）。
        let explicit_profile = load_profile(&conn, "profile-explicit").expect("load profile");
        let mut explicit =
            serde_json::to_value(&explicit_profile).expect("serialize profile");
        explicit
            .as_object_mut()
            .expect("profile object")
            .insert("enabledAgentIds".to_string(), json!(["desic-smart-money", "nope"]));
        insert_test_run(
            &conn,
            "run-explicit",
            "profile-explicit",
            Some(&explicit.to_string()),
        );
        let (_, profile, _, _) = claim_next_run(&conn, 400)
            .expect("explicit snapshot claims")
            .expect("queued run");
        // C20.5：已下线的 id 从生效名单剔除；"库中不存在"的 id 在**快照重放**阶段仍原样
        // 保留（库校验只发生在保存路径，C3）——两层各自过滤，载荷里两者都进不去。
        assert_eq!(profile.enabled_agent_ids, vec!["nope".to_string()]);
    }

    #[test]
    fn claim_run_without_snapshot_uses_current_profile() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        migrate_ai_automation(&conn).expect("migrate automation schema");
        set_setting(&conn, "master_enabled", json!(true)).expect("enable automation");
        insert_test_profile(&conn, "profile-current", "off", 4, "[]");
        insert_test_run(&conn, "run-current", "profile-current", None);
        let (_, profile, _, _) = claim_next_run(&conn, 100)
            .expect("claim run")
            .expect("queued run");
        assert_eq!(profile.id, "profile-current");
    }

    /// 旧快照的三种 mode 边界在 v3 都不再失败：off/auto/custom 只要 JSON 合法即可读。
    #[test]
    fn profile_snapshot_migrates_all_legacy_modes() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        migrate_ai_automation(&conn).expect("migrate automation schema");
        insert_test_profile(&conn, "profile-boundary", "off", 4, "[]");
        let current = load_profile(&conn, "profile-boundary").expect("load profile");

        let off = validate_profile_snapshot(current.clone()).expect("off snapshot is valid");
        assert!(off.enabled_agent_ids.is_empty());

        let mut automatic = current.clone();
        automatic.legacy_multi_agent_mode = "auto".to_string();
        let automatic =
            validate_profile_snapshot(automatic).expect("auto snapshot migrates to builtins");
        // C20：auto 快照迁移到默认启用集（4 个流程角色）。
        assert_eq!(
            automatic.enabled_agent_ids,
            desic_agent_automation::default_enabled_agent_ids()
        );
        assert_eq!(automatic.enabled_agent_ids.len(), 4);

        let mut custom = current;
        custom.legacy_multi_agent_mode = "custom".to_string();
        custom.legacy_multi_agents = vec![AiProfileSubAgent {
            id: "legacy-custom-analyst".to_string(),
            name: "旧自定义".to_string(),
            role: "custom".to_string(),
            responsibility: "旧自定义职责。".to_string(),
            scopes: vec!["market".to_string()],
            required: false,
            enabled: true,
        }];
        let custom = validate_profile_snapshot(custom).expect("custom snapshot migrates");
        assert_eq!(
            custom.enabled_agent_ids,
            vec!["legacy-custom-analyst".to_string()]
        );
    }

    #[test]
    fn wake_condition_limits_reject_unbounded_feature_requests() {
        let now = 1_700_000_000_000_i64;
        let valid = WakeCondition::PriceChangePct {
            inst_id: "BTC-USDT-SWAP".to_string(),
            window_minutes: 60,
            direction: "absolute".to_string(),
            threshold_pct: 2.5,
        };
        assert!(validate_wake_condition_limits(&valid, now).is_ok());

        let oversized = WakeCondition::CandleVolumeRatio {
            inst_id: "BTC-USDT-SWAP".to_string(),
            bar: "5m".to_string(),
            lookback: 50_000,
            ratio: 2.0,
        };
        assert!(validate_wake_condition_limits(&oversized, now).is_err());

        let deep_book = WakeCondition::OrderbookImbalance {
            inst_id: "BTC-USDT-SWAP".to_string(),
            depth: 500,
            direction: "buy".to_string(),
            ratio: 0.7,
        };
        assert!(validate_wake_condition_limits(&deep_book, now).is_err());
        assert!(validate_wake_expiry(Some(now + 367 * 24 * 60 * 60_000), now).is_err());
    }

    #[test]
    fn wake_timestamps_explain_when_epoch_seconds_are_used() {
        let now = 1_783_900_000_000_i64;
        let seconds = 1_783_947_801_i64;
        let expiry_error =
            validate_wake_expiry(Some(seconds), now).expect_err("seconds must be rejected");
        assert!(expiry_error.contains("13 位 Unix 毫秒时间戳"));
        assert!(expiry_error.contains("1783947801000"));

        let timer = WakeCondition::Timer {
            at_ms: Some(seconds),
            interval_minutes: None,
        };
        let timer_error =
            validate_wake_condition_limits(&timer, now).expect_err("seconds must be rejected");
        assert!(timer_error.contains("timer.atMs"));
        assert!(timer_error.contains("1783947801000"));
    }

    #[test]
    fn feishu_webhook_validation_and_sanitization_never_leak_secret() {
        let webhook = "https://open.feishu.cn/open-apis/bot/v2/hook/test-token";
        assert!(validate_feishu_webhook(webhook).is_ok());
        assert!(
            validate_feishu_webhook("http://open.feishu.cn/open-apis/bot/v2/hook/test").is_err()
        );
        assert!(validate_feishu_webhook("https://example.com/open-apis/bot/v2/hook/test").is_err());
        assert!(validate_feishu_webhook(
            "https://open.feishu.cn/open-apis/bot/v2/hook/test?debug=1"
        )
        .is_err());

        let sanitized = sanitize_feishu_error(&format!("request to {webhook} failed"), webhook);
        assert!(!sanitized.contains("test-token"));
        assert!(sanitized.contains("[redacted-webhook]"));
    }

    #[test]
    fn legacy_feishu_event_settings_enable_new_strategy_signal_event() {
        let legacy = json!({
            "enabled": true,
            "eventTypes": ["agent_message", "run_completed"]
        });
        let normalized = normalized_feishu_event_types(&legacy);
        assert!(normalized.iter().any(|value| value == "strategy_signal"));

        let explicitly_saved = json!({
            "enabled": true,
            "eventTypes": ["agent_message", "run_completed"],
            "eventTypesVersion": FEISHU_CONFIG_EVENT_TYPES_VERSION
        });
        let normalized_saved = normalized_feishu_event_types(&explicitly_saved);
        assert!(!normalized_saved
            .iter()
            .any(|value| value == "strategy_signal"));
    }

    #[test]
    fn feishu_delivery_uses_markdown_card_v2_and_level_color() {
        let input = FeishuSendInput {
            title: "Risk alert".to_string(),
            content: "## Summary\n\n**Do not trade.**".to_string(),
            level: "error".to_string(),
            related_type: None,
            related_id: None,
            agent_profile_id: None,
            agent_run_id: None,
        };
        let payload = feishu_markdown_card(&input);

        assert_eq!(payload["msg_type"], "interactive");
        assert_eq!(payload["card"]["schema"], "2.0");
        assert_eq!(payload["card"]["header"]["title"]["content"], "Risk alert");
        assert_eq!(payload["card"]["header"]["template"], "red");
        assert_eq!(payload["card"]["body"]["elements"][0]["tag"], "markdown");
        assert_eq!(
            payload["card"]["body"]["elements"][0]["content"],
            "## Summary\n\n**Do not trade.**"
        );
        assert_eq!(feishu_header_template("warning"), "orange");
        assert_eq!(feishu_header_template("success"), "green");
        assert_eq!(feishu_header_template("trade"), "purple");
        assert_eq!(feishu_header_template("unknown"), "blue");
    }

    #[test]
    fn published_skill_versions_skip_draft_numbers_without_duplicating_content() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch(
            "CREATE TABLE ai_skill_versions (
               id TEXT PRIMARY KEY,
               skill_id TEXT NOT NULL,
               version INTEGER NOT NULL,
               status TEXT NOT NULL,
               content TEXT NOT NULL,
               source_suggestion_id TEXT,
               created_at INTEGER NOT NULL,
               published_at INTEGER,
               UNIQUE(skill_id, version)
             );",
        )
        .expect("create skill versions table");

        assert!(
            insert_published_skill_version_if_changed(&conn, "trend", "content-a", 10)
                .expect("insert first published version")
        );
        conn.execute(
            "INSERT INTO ai_skill_versions(
               id,skill_id,version,status,content,created_at
             ) VALUES('draft-2','trend',2,'draft','draft-content',20)",
            [],
        )
        .expect("insert draft version");
        assert_eq!(
            find_matching_newer_skill_draft(&conn, "trend", "draft-content")
                .expect("find matching recovery draft"),
            Some("draft-2".to_string())
        );

        assert!(
            !insert_published_skill_version_if_changed(&conn, "trend", "content-a", 30)
                .expect("ignore unchanged published content")
        );
        assert!(
            insert_published_skill_version_if_changed(&conn, "trend", "content-b", 40)
                .expect("insert changed published content")
        );

        let latest = conn
            .query_row(
                "SELECT version,content FROM ai_skill_versions
                 WHERE skill_id='trend' AND status='published'
                 ORDER BY version DESC LIMIT 1",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .expect("load latest published version");
        assert_eq!(latest, (3, "content-b".to_string()));
    }

    #[test]
    fn profile_skill_latest_tracks_new_published_versions_until_explicitly_pinned() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch(
            "CREATE TABLE ai_skill_versions (
               id TEXT PRIMARY KEY,
               skill_id TEXT NOT NULL,
               version INTEGER NOT NULL,
               status TEXT NOT NULL,
               content TEXT NOT NULL,
               source_suggestion_id TEXT,
               created_at INTEGER NOT NULL,
               published_at INTEGER,
               UNIQUE(skill_id, version)
             );
             INSERT INTO ai_skill_versions(id,skill_id,version,status,content,created_at,published_at)
             VALUES('trend-v1','trend',1,'published','v1',1,1),
                   ('trend-v2','trend',2,'published','v2',2,2);",
        )
        .expect("create version fixtures");
        let skill_ids = vec!["trend".to_string()];
        let requested = HashMap::from([("trend".to_string(), 1)]);

        let latest = resolve_skill_versions(&conn, &skill_ids, &requested, &HashMap::new())
            .expect("resolve dynamic latest");
        assert_eq!(latest.get("trend"), Some(&2));

        let modes = HashMap::from([("trend".to_string(), "pinned".to_string())]);
        let pinned = resolve_skill_versions(&conn, &skill_ids, &requested, &modes)
            .expect("resolve explicit pin");
        assert_eq!(pinned.get("trend"), Some(&1));
    }

    #[test]
    fn recovery_warning_counts_unknown_orders_and_amends() {
        assert_eq!(
            pending_trade_recovery_unknown_count(&json!({
                "unknown": 1,
                "amend": { "unknown": 2 }
            })),
            3
        );
    }

    #[test]
    fn run_action_counts_ignore_internal_tool_execution_lifecycle() {
        let events = json!([
            {
                "type": "toolCall",
                "toolCallId": "provider-call",
                "name": "tradeOpportunity.create",
                "arguments": {}
            },
            {
                "type": "toolCall",
                "toolCallId": "internal-execution",
                "name": "tradeOpportunity.create",
                "policy": "rust:tool-execute-request"
            },
            {
                "type": "toolResult",
                "toolCallId": "internal-execution",
                "name": "tradeOpportunity.create",
                "ok": true
            },
            {
                "type": "toolResult",
                "toolCallId": "provider-call",
                "name": "tradeOpportunity.create",
                "ok": true
            }
        ]);
        let counts = parse_run_action_counts(&events.to_string());
        assert_eq!(counts.opportunity, 1);
    }

    #[test]
    fn daily_review_window_matches_one_utc_day() {
        assert!(DAILY_MARKET_REVIEW_EVIDENCE_RULES.contains("readSignalTrendByFilter"));
        assert!(DAILY_MARKET_REVIEW_EVIDENCE_RULES.contains("不透明稳定标识"));
        assert!(DAILY_MARKET_REVIEW_EVIDENCE_RULES.contains("不属于原始市场数据缺口"));
        let (start, end) = daily_review_window("2026-07-21").expect("daily UTC window");
        assert_eq!(end - start, 86_400_000);
        assert_eq!(
            chrono::DateTime::<chrono::Utc>::from_timestamp_millis(start)
                .expect("valid timestamp")
                .format("%Y-%m-%d %H:%M:%S")
                .to_string(),
            "2026-07-21 00:00:00"
        );
    }

    #[test]
    fn skill_file_fingerprint_changes_when_enabled_set_changes() {
        let mut config = desic_storage_config::AiConfig {
            provider: Some("cline-sdk".to_string()),
            model: "test-model".to_string(),
            base_url: "https://example.invalid/v1".to_string(),
            api_key: "test-key".to_string(),
            stream: Some(true),
            permission_mode: "advisor".to_string(),
            reasoning_depth: "medium".to_string(),
            active_model_id: "model-test".to_string(),
            models: vec![desic_storage_config::AiModelConfig {
                id: "model-test".to_string(),
                name: "测试模型".to_string(),
                provider: "cline-sdk".to_string(),
                model: "test-model".to_string(),
                base_url: "https://example.invalid/v1".to_string(),
                api_key: "test-key".to_string(),
                permission_mode: "advisor".to_string(),
                reasoning_depth: "medium".to_string(),
                context_window: None,
            }],
            context_window: None,
            system_prompt: "test".to_string(),
            custom_rules: String::new(),
            enabled_skills: Vec::new(),
            skill_definitions: desic_storage_config::default_ai_skill_definitions(),
            skill_runtime_trust: HashMap::new(),
            open_agent: true,
            workspace_roots: Vec::new(),
            typesafe: desic_storage_config::AiTypesafeConfig::default(),
            tool_read_concurrency: None,
            tool_domain_concurrency: None,
        };
        let disabled = ai_skill_files_fingerprint(&config).expect("fingerprint disabled skills");
        config.enabled_skills.push("trading-philosophy".to_string());
        let enabled = ai_skill_files_fingerprint(&config).expect("fingerprint enabled skills");
        assert_ne!(disabled, enabled);
    }

    #[test]
    fn final_decision_ignores_model_owned_account_claims_without_a_context() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch(
            "CREATE TABLE ai_decision_contexts (
               id TEXT PRIMARY KEY,
               agent_run_id TEXT NOT NULL,
               agent_profile_id TEXT NOT NULL,
               captured_at INTEGER NOT NULL,
               snapshot_json TEXT NOT NULL
             );",
        )
        .expect("create decision context table");
        let submitted = json!({
            "outcome": "abandon",
            "reason": "名义价值占权益较高",
            "reasonCodes": ["account_blocked", "evidence_conflict"],
            "accountAssessment": {
                "status": "blocked",
                "source": "not_evaluated",
                "blockers": ["名义敞口占权益 49%"]
            }
        });
        let normalized = normalize_final_decision(&conn, "run-1", "profile-1", &submitted, &[]);
        let normalized = normalized.expect("normalize system-owned assessment");
        assert_eq!(normalized["accountAssessment"]["status"], "not_evaluated");
        assert_eq!(normalized["accountAssessment"]["blockers"], json!([]));
        assert_eq!(normalized["reasonCodes"], json!(["evidence_conflict"]));
    }

    #[test]
    fn final_decision_derives_account_blockers_from_stored_precheck() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch(
            "CREATE TABLE ai_decision_contexts (
               id TEXT PRIMARY KEY,
               agent_run_id TEXT NOT NULL,
               agent_profile_id TEXT NOT NULL,
               captured_at INTEGER NOT NULL,
               snapshot_json TEXT NOT NULL
             );",
        )
        .expect("create decision context table");
        conn.execute(
            "INSERT INTO ai_decision_contexts(id,agent_run_id,agent_profile_id,captured_at,snapshot_json)
             VALUES(?1,?2,?3,1,?4)",
            params![
                "dctx-1",
                "run-1",
                "profile-1",
                json!({
                    "precheck": {
                        "blocked": true,
                        "reasons": ["可用余额不足"]
                    }
                })
                .to_string()
            ],
        )
        .expect("insert decision context");
        let decision = json!({
            "outcome": "abandon",
            "reason": "最终复核确认余额不足",
            "reasonCodes": ["execution_blocked"]
        });
        let normalized = normalize_final_decision(&conn, "run-1", "profile-1", &decision, &[])
            .expect("derive matching precheck blocker");
        assert_eq!(normalized["accountAssessment"]["status"], "blocked");
        assert_eq!(
            normalized["accountAssessment"]["source"],
            "market.readDecisionContext"
        );
        assert_eq!(
            normalized["accountAssessment"]["blockers"],
            json!(["可用余额不足"])
        );
        assert!(normalized["reasonCodes"]
            .as_array()
            .expect("reason codes")
            .iter()
            .any(|code| code == "account_blocked"));
    }

    #[test]
    fn run_opportunity_facts_distinguish_created_and_reused_opportunities() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch(
            "CREATE TABLE trade_opportunities (
               id TEXT PRIMARY KEY,status TEXT NOT NULL,decision_context_id TEXT,
               account_id TEXT,environment TEXT NOT NULL,inst_id TEXT NOT NULL,
               agent_run_id TEXT,agent_profile_id TEXT,created_at INTEGER NOT NULL
             );
             CREATE TABLE trade_opportunity_resolution_events (
               id TEXT PRIMARY KEY,opportunity_id TEXT NOT NULL,resolution TEXT NOT NULL,
               agent_run_id TEXT,created_at INTEGER NOT NULL
             );
             CREATE TABLE ai_decision_contexts (
               id TEXT PRIMARY KEY,agent_run_id TEXT NOT NULL,agent_profile_id TEXT NOT NULL,
               consumed_opportunity_id TEXT,consumed_at INTEGER
             );",
        )
        .expect("create opportunity fact schema");
        conn.execute(
            "INSERT INTO trade_opportunities VALUES(
               'opp-created','pending','ctx-created','account-1','demo','BTC-USDT-SWAP',
               'run-1','profile-1',1
             )",
            [],
        )
        .expect("insert created opportunity");
        conn.execute(
            "INSERT INTO trade_opportunities VALUES(
               'opp-reused','approved','ctx-old','account-1','demo','BTC-USDT-SWAP',
               'run-old','profile-1',1
             )",
            [],
        )
        .expect("insert reused opportunity");
        conn.execute(
            "INSERT INTO trade_opportunity_resolution_events
             VALUES('resolution-1','opp-reused','reuse','run-1',2)",
            [],
        )
        .expect("insert reuse resolution");
        conn.execute(
            "INSERT INTO ai_decision_contexts
             VALUES('ctx-reuse','run-1','profile-1','opp-reused',2)",
            [],
        )
        .expect("insert reuse context");

        let facts = load_run_opportunity_facts(&conn, "run-1", "profile-1")
            .expect("load run opportunity facts");
        assert_eq!(facts.len(), 2);
        let created = facts
            .iter()
            .find(|item| item.id == "opp-created")
            .expect("created fact");
        assert_eq!(created.resolution, "create");
        let reused = facts
            .iter()
            .find(|item| item.id == "opp-reused")
            .expect("reused fact");
        assert_eq!(reused.resolution, "reuse");
        assert_eq!(reused.decision_context_id.as_deref(), Some("ctx-reuse"));
    }

    #[test]
    fn final_decision_derives_reuse_ids_and_system_reason_codes() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch(
            "CREATE TABLE ai_decision_contexts (
               id TEXT PRIMARY KEY,agent_run_id TEXT NOT NULL,agent_profile_id TEXT NOT NULL,
               captured_at INTEGER NOT NULL,snapshot_json TEXT NOT NULL
             );
             INSERT INTO ai_decision_contexts VALUES(
               'ctx-reuse','run-1','profile-1',1,
               '{\"precheck\":{\"blocked\":false,\"reasons\":[]}}'
             );",
        )
        .expect("create reuse decision context");
        let submitted = json!({
            "outcome": "execute",
            "reason": "复用参数完全相同的待处理机会",
            "reasonCodes": ["trade_created", "no_action_required"]
        });
        let facts = vec![RunOpportunityFact {
            id: "opp-reused".to_string(),
            status: "pending".to_string(),
            decision_context_id: Some("ctx-reuse".to_string()),
            account_id: Some("account-1".to_string()),
            environment: "demo".to_string(),
            inst_id: "BTC-USDT-SWAP".to_string(),
            resolution: "reuse".to_string(),
        }];
        let normalized = normalize_final_decision(&conn, "run-1", "profile-1", &submitted, &facts)
            .expect("normalize reuse decision");
        assert_eq!(normalized["createdOpportunityIds"], json!([]));
        assert_eq!(normalized["reusedOpportunityIds"], json!(["opp-reused"]));
        assert_eq!(normalized["outcome"], "wait");
        assert_eq!(
            normalized["reasonCodes"],
            json!(["duplicate_opportunity", "pending_order"])
        );
    }
    /// C19 用量夹具：往 `background:<run>` 会话里插一条带 `usageSummary` 事件的助手消息
    /// （与侧车真实写入的形状一致：`__desicUsageSummary` + `type: usageSummary`）。
    fn insert_usage_message(conn: &Connection, id: &str, run_id: &str, created_at: i64, total: i64) {
        let tokens = json!({
            "inputTokens": total,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "reasoningTokens": 0,
            "totalTokens": total
        });
        let events = json!([{
            "__desicUsageSummary": {
                "schemaVersion": AI_USAGE_SCHEMA_VERSION,
                "provider": "test",
                "modelId": "test-model",
                "model": "test-model",
                "modelName": "Test",
                "reported": true,
                "agentCount": 1,
                "reportedAgentCount": 1,
                "unreportedAgentCount": 0,
                "usage": tokens,
                "mainUsage": tokens
            },
            "type": "usageSummary"
        }]);
        conn.execute(
            "INSERT INTO ai_messages(id,session_id,role,content,tool_json,created_at)
             VALUES(?1,?2,'assistant','本轮报告',?3,?4)",
            params![id, format!("background:{run_id}"), events.to_string(), created_at],
        )
        .expect("insert usage message");
    }

    fn usage_test_connection() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch(
            "CREATE TABLE ai_messages(
               id TEXT PRIMARY KEY,session_id TEXT NOT NULL,role TEXT NOT NULL,
               content TEXT NOT NULL,reasoning TEXT,tool_json TEXT,
               token_usage_json TEXT,token_usage_version INTEGER NOT NULL DEFAULT 0,
               status TEXT,created_at INTEGER NOT NULL
             );",
        )
        .expect("create ai_messages");
        conn
    }

    /// ① C19.3 分阶段 token 记账（真实库 + 会话事件水合）：
    /// `triageTokens + deepTokens == totalTokens`，且两段都非零。
    ///
    /// 根因回归：旧实现里试判段读 `ai_agent_runs.token_usage_json`（那一列要到
    /// `finishRun` 才写回，试判时恒为 0），总量在收尾时另取一次 → UI 上永远
    /// "试判 0 / 深度 X"。现在两段走同一个取数源（会话事件的 usageSummary 水合），
    /// 深度段由减法得出，恒等式由构造保证。
    #[test]
    fn triage_phase_tokens_add_up_on_a_real_run() {
        let conn = usage_test_connection();
        // 试判阶段结束时的会话累计用量（reportTriage 时读到的快照）。
        insert_usage_message(&conn, "m-triage", "run-tokens", 1, 1_000);
        let triage = load_run_metadata(&conn, "run-tokens")
            .expect("triage metadata")
            .token_usage
            .and_then(|usage| serde_json::to_value(usage).ok())
            .expect("triage usage snapshot");
        assert_eq!(
            triage["usage"]["totalTokens"], 1_000,
            "试判快照必须读到真实用量（不再是 0）：{triage}"
        );

        // 深度阶段继续跑：会话累计到 3_500。
        insert_usage_message(&conn, "m-deep", "run-tokens", 2, 3_500);
        let block = phase_token_block(&conn, "run-tokens", &triage);
        assert_eq!(block["triageTokens"], 1_000);
        assert_eq!(block["deepTokens"], 2_500);
        assert_eq!(block["totalTokens"], 3_500);
        assert_eq!(
            block["triageTokens"].as_i64().expect("triage tokens")
                + block["deepTokens"].as_i64().expect("deep tokens"),
            block["totalTokens"].as_i64().expect("total tokens"),
            "恒等式必须成立（旧实现正是不成立才显示 0/0/0）"
        );
        assert!(
            block["triageTokens"].as_i64().expect("triage tokens") > 0
                && block["deepTokens"].as_i64().expect("deep tokens") > 0,
            "两段都要非零：{block}"
        );
        // 深度段明细也是逐字段相减（不是复制总量）。
        assert_eq!(block["deep"]["usage"]["totalTokens"], 2_500);
        assert_eq!(block["deep"]["usage"]["inputTokens"], 2_500);

        // 取数源回退（水合出的总量小于试判快照）→ 用试判快照当总量，恒等式仍成立。
        let regressed = phase_token_block(&conn, "run-tokens", &json!({ "totalTokens": 9_000 }));
        assert_eq!(regressed["triageTokens"], 9_000);
        assert_eq!(regressed["deepTokens"], 0);
        assert_eq!(regressed["totalTokens"], 9_000);
    }

    /// ② C20.6 补充：升级了深度却"零专家 + 零 usedEvidence + 无理由" → 只标记不失败；
    /// 给了理由、有专家活动、或根本没升级 → 不标。
    #[test]
    fn finish_run_audit_marks_unjustified_self_analysis_without_failing() {
        let mut escalated = crate::ai_triage::RunTriageState::new(
            crate::ai_triage::AiAgentTriageConfig {
                mode: "enforce".to_string(),
                ..crate::ai_triage::AiAgentTriageConfig::default()
            },
            0,
            None,
            0,
        );
        escalated.verdict = Some(true);
        let summary = "## 结论\n本轮不建仓。\n## 事实与证据\n- 15:00 结构未确认（market.readTicker）\n## 冲突与缺口\n无\n## 观察条件\n站上 X\n## 下一步\n等待";
        let bare: BackgroundFinishRunInput = serde_json::from_value(json!({
            "summary": summary,
            "nextWakePlan": { "mode": "any", "conditions": [] }
        }))
        .expect("deserialize finish input without selfAnalysisReason");
        assert!(bare.self_analysis_reason.is_none());
        // 生效专家名单非空：升级 + 零专家 + 零证据 + 无理由 → 标"未说明理由"。
        let deployed = vec![desic_agent_automation::builtin_agent_definition("desic-data-digest")
            .expect("builtin definition")];
        let audit = finish_run_audit(
            &escalated,
            &deployed,
            &[],
            &bare,
            summary,
            SINGLE_AGENT_MODE_STANDARD,
            false,
        );
        assert_eq!(audit["selfAnalysisUnjustified"], true);
        assert_eq!(audit["selfAnalysisReason"], json!(null));
        assert_eq!(audit["summaryFormatWarnings"], json!([]));

        // 误报修正（C22.2）：本轮生效专家名单为空 → 一律不标。
        // 名单为空的两条来源都在载荷层收敛成同一个空切片：`collaborationEnabled=false`
        // （C14 闸门 → `enabledAgents: []`）与"勾选了但库里没有可用角色"（C20.5 过滤）。
        // 否则每次升级都会把"配置里根本没专家"误报成主 Agent 走过场。
        let audit = finish_run_audit(
            &escalated,
            &[],
            &[],
            &bare,
            summary,
            SINGLE_AGENT_MODE_STANDARD,
            false,
        );
        assert_eq!(audit["selfAnalysisUnjustified"], false);
        assert_eq!(audit["selfAnalysisReason"], json!(null));

        // 给了理由 → 记录理由且不再标"未说明理由"。
        let explained: BackgroundFinishRunInput = serde_json::from_value(json!({
            "summary": summary,
            "nextWakePlan": { "mode": "any", "conditions": [] },
            "selfAnalysisReason": "本轮只有行情快照可读，主 Agent 自行取数与判断。"
        }))
        .expect("deserialize finish input with selfAnalysisReason");
        let audit = finish_run_audit(
            &escalated,
            &deployed,
            &[],
            &explained,
            summary,
            SINGLE_AGENT_MODE_STANDARD,
            false,
        );
        assert_eq!(
            audit["selfAnalysisReason"],
            "本轮只有行情快照可读，主 Agent 自行取数与判断。"
        );
        assert_eq!(audit["selfAnalysisUnjustified"], false);

        // 有专家活动 → 不标（升级也确实派了专家）。
        let audit = finish_run_audit(
            &escalated,
            &deployed,
            &[json!({ "expertId": "desic-data-digest" })],
            &bare,
            summary,
            SINGLE_AGENT_MODE_STANDARD,
            false,
        );
        assert_eq!(audit["selfAnalysisUnjustified"], false);

        // 没升级（mode=off / 未提交 verdict）→ 不标。
        for state in [
            crate::ai_triage::RunTriageState::new(
                crate::ai_triage::AiAgentTriageConfig {
                    mode: "off".to_string(),
                    ..crate::ai_triage::AiAgentTriageConfig::default()
                },
                0,
                None,
                0,
            ),
            crate::ai_triage::RunTriageState::default(),
        ] {
            let audit = finish_run_audit(
                &state,
                &deployed,
                &[],
                &bare,
                summary,
                SINGLE_AGENT_MODE_STANDARD,
                false,
            );
            assert_eq!(audit["selfAnalysisUnjustified"], false);
        }
    }

    /// C22.3-B 夹具：一个最小可用的后台 Profile 运行上下文（生效名单可配、试判可升级）。
    fn test_finish_context(
        run_id: &str,
        enabled_agents: Vec<desic_agent_automation::AiAgentDefinition>,
        escalated: bool,
    ) -> BackgroundRunContext {
        test_finish_context_with_mode(run_id, enabled_agents, escalated, SINGLE_AGENT_MODE_STANDARD)
    }

    fn test_finish_context_with_mode(
        run_id: &str,
        enabled_agents: Vec<desic_agent_automation::AiAgentDefinition>,
        escalated: bool,
        single_agent_mode: &str,
    ) -> BackgroundRunContext {
        let mut triage = crate::ai_triage::RunTriageState::new(
            crate::ai_triage::AiAgentTriageConfig {
                mode: if escalated {
                    crate::ai_triage::TRIAGE_MODE_ENFORCE.to_string()
                } else {
                    crate::ai_triage::TRIAGE_MODE_OFF.to_string()
                },
                ..crate::ai_triage::AiAgentTriageConfig::default()
            },
            0,
            None,
            0,
        );
        if escalated {
            triage.verdict = Some(true);
        }
        BackgroundRunContext {
            permission_mode: "advisor".to_string(),
            account_id: None,
            environment: Some("demo".to_string()),
            symbols: vec!["BTC-USDT-SWAP".to_string()],
            profile_id: Some("profile-soft-check".to_string()),
            run_id: Some(run_id.to_string()),
            enabled_skills: Vec::new(),
            skill_versions: HashMap::new(),
            skill_definitions: Vec::new(),
            model: None,
            reasoning_depth: "medium".to_string(),
            history_lookback_days: 30,
            target_leverage: 20,
            max_single_trade_margin_pct: 30,
            allowed_wake_condition_types: Vec::new(),
            enabled_agents,
            triage: std::sync::Arc::new(std::sync::Mutex::new(triage)),
            finish_gate: std::sync::Arc::new(std::sync::Mutex::new(FinishGateState::default())),
            single_agent_mode: single_agent_mode.to_string(),
            trigger: json!({}),
            review_id: None,
            episode_id: None,
        }
    }

    fn soft_check_input(reason: Option<&str>) -> BackgroundFinishRunInput {
        let mut value = json!({
            "summary": "## 结论\n本轮不建仓。\n## 事实与证据\n- 15:00 结构未确认\n## 冲突与缺口\n无\n## 观察条件\n站上 X\n## 下一步\n等待",
            "finalDecision": { "outcome": "wait", "reason": "证据不足" },
            "nextWakePlan": { "mode": "any", "conditions": [] }
        });
        if let Some(reason) = reason {
            value["selfAnalysisReason"] = json!(reason);
        }
        serde_json::from_value(value).expect("deserialize finish input")
    }

    /// C22.3-B：收尾软校验 —— 升级 + 零专家 + 无理由 + 名单非空时**打回一次**；
    /// 补齐理由后通过；第二次仍未补则接受（绝不卡死）。同时断言打回时**零写入**。
    #[test]
    fn finish_run_soft_check_pushes_back_at_most_once() {
        let conn = usage_test_connection();
        let deployed = vec![desic_agent_automation::builtin_agent_definition("desic-data-digest")
            .expect("builtin definition")];
        let context = test_finish_context("run-soft-check", deployed.clone(), true);
        let summary = "## 结论\n本轮不建仓。\n## 事实与证据\n- 15:00 结构未确认\n## 冲突与缺口\n无\n## 观察条件\n站上 X\n## 下一步\n等待";
        let bare = soft_check_input(None);

        // ① 第一次：打回。非致命（返回 Ok + ok:false 负载）、双语文案、运行未结束、零写入。
        let changes_before = conn.total_changes();
        let (_experts, audit, pushback) =
            finish_run_audit_and_soft_check(&conn, &context, &bare, summary, "run-soft-check")
                .expect("soft check must not fail the run");
        assert_eq!(audit["selfAnalysisUnjustified"], true, "审计仍会标记");
        let pushback = pushback.expect("first call must push back");
        assert_eq!(pushback["ok"], false, "打回是非致命提示，不是运行失败");
        assert_eq!(pushback["runEnded"], false);
        assert_eq!(pushback["retryable"], true);
        assert_eq!(pushback["maxPushbacks"], 1);
        assert_eq!(pushback["errorCode"], "self_analysis_reason_required");
        assert!(pushback["warning"]
            .as_str()
            .expect("warning")
            .contains("selfAnalysisReason"));
        assert!(pushback["message"]
            .as_str()
            .expect("message")
            .contains("selfAnalysisReason"));
        assert!(
            conn.total_changes() == changes_before,
            "软校验必须零写入（不落库、不改运行状态）"
        );

        // ② 补齐理由后再次收尾：不再打回，审计里有理由。
        let explained = soft_check_input(Some("试判阶段已取得全部所需证据，故自行完成。"));
        let (_experts, audit, pushback) =
            finish_run_audit_and_soft_check(&conn, &context, &explained, summary, "run-soft-check")
                .expect("explained finish must pass");
        assert!(pushback.is_none(), "补齐理由后必须直接通过");
        assert_eq!(audit["selfAnalysisUnjustified"], false);
        assert_eq!(
            audit["selfAnalysisReason"],
            "试判阶段已取得全部所需证据，故自行完成。"
        );

        // ③ 同条件但第二次仍未补 → 接受（不再打回），审计标记保留。
        let context2 = test_finish_context("run-soft-check-2", deployed.clone(), true);
        let (_e, _a, first) =
            finish_run_audit_and_soft_check(&conn, &context2, &bare, summary, "run-soft-check-2")
                .expect("first");
        assert!(first.is_some());
        let (_e, audit, second) =
            finish_run_audit_and_soft_check(&conn, &context2, &bare, summary, "run-soft-check-2")
                .expect("second");
        assert!(second.is_none(), "最多打回一次：第二次必须接受并收尾");
        assert_eq!(audit["selfAnalysisUnjustified"], true, "标记保留在审计里");
        let pushes = context2
            .finish_gate
            .lock()
            .expect("gate lock")
            .self_analysis_pushbacks;
        assert_eq!(pushes, 1, "计数状态 = 已打回一次");

        // ④ 不走软校验的三种情形：有专家 / 名单为空（含 collaboration 关闭）/ 未升级。
        let with_expert = test_finish_context("run-with-expert", deployed.clone(), true);
        let experts = vec![json!({ "expertId": "desic-data-digest", "toolCalls": 1 })];
        let audit = finish_run_audit(
            &with_expert.triage.lock().expect("lock").clone(),
            &deployed,
            &experts,
            &bare,
            summary,
            SINGLE_AGENT_MODE_STANDARD,
            false,
        );
        assert!(self_analysis_pushback(&with_expert.finish_gate, &audit).is_none());
        let empty_list = test_finish_context("run-empty-list", Vec::new(), true);
        let (_e, audit, pushback) =
            finish_run_audit_and_soft_check(&conn, &empty_list, &bare, summary, "run-empty-list")
                .expect("empty list");
        assert_eq!(audit["selfAnalysisUnjustified"], false, "空名单不标");
        assert!(pushback.is_none(), "空名单不走软校验");
        let not_escalated = test_finish_context("run-not-escalated", deployed.clone(), false);
        let (_e, _audit, pushback) = finish_run_audit_and_soft_check(
            &conn,
            &not_escalated,
            &bare,
            summary,
            "run-not-escalated",
        )
        .expect("not escalated");
        assert!(pushback.is_none(), "未升级/交互式语义不走软校验");
        assert_eq!(
            not_escalated
                .finish_gate
                .lock()
                .expect("gate lock")
                .self_analysis_pushbacks,
            0,
            "没走过软校验就不该消耗打回额度"
        );
    }

    /// C24.1：单 Agent 子模式 —— 缺省 `standard`、非法回落 `standard`、
    /// **协作开启时该字段被忽略**（生效模式恒为 `standard`），但 Profile 里存的值仍可回显。
    #[test]
    fn single_agent_mode_defaults_and_falls_back() {
        assert_eq!(normalize_single_agent_mode("minimal"), "minimal");
        assert_eq!(normalize_single_agent_mode("  MINIMAL "), "minimal");
        assert_eq!(normalize_single_agent_mode("standard"), "standard");
        // 非法值 → standard（不报错）。
        for invalid in ["", "  ", "extreme", "minimalx", "1"] {
            assert_eq!(normalize_single_agent_mode(invalid), "standard", "{invalid}");
        }
        // 协作开启 → 该字段被忽略（生效模式 standard，不报错）。
        assert_eq!(
            effective_single_agent_mode(true, Some("minimal")),
            SINGLE_AGENT_MODE_STANDARD
        );
        assert_eq!(
            effective_single_agent_mode(false, Some("minimal")),
            SINGLE_AGENT_MODE_MINIMAL
        );
        assert_eq!(
            effective_single_agent_mode(false, None),
            SINGLE_AGENT_MODE_STANDARD,
            "缺字段 = standard"
        );

        let conn = Connection::open_in_memory().expect("open in-memory database");
        migrate_ai_automation(&conn).expect("migrate automation schema");
        let save = |id: &str, value: Value, collaboration: bool| -> AiAgentProfileSummary {
            let mut profile = normalize_profile(
                serde_json::from_value::<AiAgentProfileInput>(json!({
                    "name": "极简模式回归",
                    "symbols": ["BTC-USDT-SWAP"],
                    "collaborationEnabled": collaboration,
                    "enabledAgentIds": [],
                    "singleAgentMode": value,
                }))
                .expect("deserialize profile input"),
            )
            .expect("normalize profile input");
            apply_collaboration_default(&conn, &mut profile, id);
            apply_single_agent_mode_default(&conn, &mut profile, id);
            upsert_profile_row(&conn, &profile, id, 1_000, 2_000).expect("insert profile row");
            load_profile(&conn, id).expect("load profile")
        };
        // 非法值 → standard（保存不报错）。
        assert_eq!(
            save("profile-sam-invalid", json!("extreme"), false).single_agent_mode,
            SINGLE_AGENT_MODE_STANDARD
        );
        // 显式 minimal → 存下来并回显。
        assert_eq!(
            save("profile-sam-minimal", json!("minimal"), false).single_agent_mode,
            SINGLE_AGENT_MODE_MINIMAL
        );
        // 协作开启 + minimal：Profile 里仍存 minimal（UI 要回显），但生效模式是 standard。
        let collaboration_on = save("profile-sam-coop", json!("minimal"), true);
        assert_eq!(collaboration_on.single_agent_mode, SINGLE_AGENT_MODE_MINIMAL);
        assert_eq!(
            effective_single_agent_mode(
                collaboration_on.collaboration_enabled,
                Some(collaboration_on.single_agent_mode.as_str())
            ),
            SINGLE_AGENT_MODE_STANDARD,
            "协作开启时极简模式不生效（且不报错）"
        );
        // 缺字段（旧前端）：保留库中现值，不静默改回 standard。
        let mut legacy_ui = normalize_profile(
            serde_json::from_value::<AiAgentProfileInput>(json!({
                "id": "profile-sam-minimal",
                "name": "极简模式回归",
                "symbols": ["BTC-USDT-SWAP"],
                "enabledAgentIds": [],
            }))
            .expect("deserialize legacy-UI input"),
        )
        .expect("normalize legacy-UI input");
        assert!(legacy_ui.single_agent_mode.is_none());
        apply_single_agent_mode_default(&conn, &mut legacy_ui, "profile-sam-minimal");
        upsert_profile_row(&conn, &legacy_ui, "profile-sam-minimal", 1_000, 3_000)
            .expect("resave profile row");
        assert_eq!(
            load_profile(&conn, "profile-sam-minimal")
                .expect("reload")
                .single_agent_mode,
            SINGLE_AGENT_MODE_MINIMAL
        );
    }

    /// C24.2-3：极简模式收尾校验的四态 —— 正常一句话 / 超长 / 多行 / 仍输出正文。
    /// **豁免 C21 五小节**（同一句话里没有小节也不报警），且只标记、不阻断。
    #[test]
    fn minimal_mode_summary_warnings_cover_all_four_states() {
        let one_liner = "本轮不建仓，等待 BTC-USDT-SWAP 站上 102500 再评估。";
        // ① 正常一句话：没有五小节，但极简模式不判 C21 → 无警告。
        assert!(minimal_summary_warnings(one_liner, false).is_empty());

        // ② 超长（显示宽度 > 160：CJK 按 2 计，约 80 汉字为上限）。
        let long = "本轮不建仓。".repeat(20);
        assert!(text_display_width(&long) > MINIMAL_SUMMARY_MAX_WIDTH);
        assert_eq!(
            minimal_summary_warnings(&long, false),
            vec![format!("minimal 模式下 summary 超过 {MINIMAL_SUMMARY_MAX_WIDTH} 字符")]
        );
        // 恰好在 160 显示宽度 = 80 个汉字 → 不报警。
        let exactly = "字".repeat(80);
        assert_eq!(text_display_width(&exactly), MINIMAL_SUMMARY_MAX_WIDTH);
        assert!(minimal_summary_warnings(&exactly, false).is_empty());

        // ③ 多行（出现换行即视为多句）。
        let multiline = "本轮不建仓。\n等待站上 102500。";
        assert_eq!(
            minimal_summary_warnings(multiline, false),
            vec!["minimal 模式下 summary 含多行".to_string()]
        );

        // ④ 模型仍然输出了正文 → 只记录、不隐藏、不改写。
        assert_eq!(
            minimal_summary_warnings(one_liner, true),
            vec!["minimal 模式仍产生了正文".to_string()]
        );
        // 三样都犯 → 三条警告全都在（顺序稳定）。
        assert_eq!(
            minimal_summary_warnings(&format!("{long}\n{one_liner}"), true),
            vec![
                format!("minimal 模式下 summary 超过 {MINIMAL_SUMMARY_MAX_WIDTH} 字符"),
                "minimal 模式下 summary 含多行".to_string(),
                "minimal 模式仍产生了正文".to_string(),
            ]
        );

        // 审计分叉：minimal 走极简规则（且不产生 C21 的"缺小节"），standard 走 C21。
        let triage = crate::ai_triage::RunTriageState::default();
        let input: BackgroundFinishRunInput = serde_json::from_value(json!({
            "summary": one_liner,
            "nextWakePlan": { "mode": "any", "conditions": [] }
        }))
        .expect("deserialize finish input");
        let minimal_audit = finish_run_audit(
            &triage,
            &[],
            &[],
            &input,
            one_liner,
            SINGLE_AGENT_MODE_MINIMAL,
            true,
        );
        assert_eq!(
            minimal_audit["summaryFormatWarnings"],
            json!(["minimal 模式仍产生了正文"]),
            "minimal 模式不判 C21 五小节"
        );
        assert_eq!(minimal_audit["singleAgentMode"], SINGLE_AGENT_MODE_MINIMAL);
        let standard_audit = finish_run_audit(
            &triage,
            &[],
            &[],
            &input,
            one_liner,
            SINGLE_AGENT_MODE_STANDARD,
            true,
        );
        assert_eq!(
            standard_audit["summaryFormatWarnings"].as_array().expect("array").len(),
            5,
            "standard 模式回归：仍然只判 C21（缺五个小节）"
        );
        assert_eq!(standard_audit["singleAgentMode"], SINGLE_AGENT_MODE_STANDARD);
    }

    /// C24.2：极简模式下**不下发 C21 排版小节**（换成一句话规则），标准模式逐字不变。
    #[test]
    fn minimal_mode_skill_definitions_drop_the_c21_section() {
        let base = desic_storage_config::default_ai_skill_definitions()
            .into_iter()
            .find(|skill| skill.id == "desic-core-operations")
            .expect("core operations skill");
        assert!(
            base.content.contains(CORE_OPERATIONS_RUN_SUMMARY_MARKER),
            "标准正文必须含 C21 小节（否则本用例失去意义）"
        );
        assert!(base.content.contains("34. A summary that is missing one of the five sections"));

        // 标准模式：逐字不变（回归）。
        let mut standard = vec![base.clone()];
        apply_single_agent_mode_to_skill_definitions(&mut standard, SINGLE_AGENT_MODE_STANDARD);
        assert_eq!(standard[0].content, base.content);

        // 极简模式：C21 小节与条目 28–34 全部消失，一句话规则替代；1–27 原样保留。
        let mut minimal = vec![base.clone()];
        apply_single_agent_mode_to_skill_definitions(&mut minimal, SINGLE_AGENT_MODE_MINIMAL);
        let content = &minimal[0].content;
        assert!(!content.contains(CORE_OPERATIONS_RUN_SUMMARY_MARKER));
        for item in ["28. ", "29. ", "33. ", "34. "] {
            assert!(!content.contains(item), "C21 条目 {item} 不该在极简注入里");
        }
        assert!(content.contains("极简模式：本轮不输出正文"));
        assert!(content.contains("160 display columns"));
        assert!(
            content.contains("27. Never bypass tool permissions"),
            "1–27 必须原样保留"
        );
        assert_eq!(minimal[0].description, base.description, "只改 content");
        assert_eq!(minimal[0].rules, base.rules, "只改 content");
        // 其它 Skill 完全不动（编排规范等照旧）。
        let mut all = desic_storage_config::default_ai_skill_definitions();
        let before = all.clone();
        apply_single_agent_mode_to_skill_definitions(&mut all, SINGLE_AGENT_MODE_MINIMAL);
        for (after, original) in all.iter().zip(before.iter()) {
            if after.id == "desic-core-operations" {
                continue;
            }
            assert_eq!(after.content, original.content, "{} 不该被改", after.id);
        }
    }

    /// C24.2（warn-only 版）：极简模式的格式问题**只写审计、永不阻断**。
    ///
    /// 回归背景（真实事故 run-1789823396526501000）：极简 summary 已合规、唯一瑕疵是
    /// "仍产生了 8 字正文"，此前的打回设计让模型没有重试 → 整轮以
    /// `background.finishRun 调用未完成` 失败。**格式小瑕疵绝不能变成整轮失败**，
    /// 因此极简路径不再有任何 `ok:false` / `errorCode` / 额度 / 阻止落库。
    #[test]
    fn minimal_mode_summary_is_warn_only_and_never_blocks_finishing() {
        let conn = usage_test_connection();
        // 极简 + 五小节报告（多行）+ 超长 + 本轮有正文 → 三条警告齐全，但**不打回**。
        let summary = "## 结论\n本轮不建仓。\n## 事实与证据\n- 15:00 无变化\n## 冲突与缺口\n无\n## 观察条件\n站上 X\n## 下一步\n等待。本轮不建仓，等待站上 102500 再评估，同时留意资金费率与持仓拥挤度是否出现反向信号，并在下一个整点复核。";
        let input = soft_check_input(None);
        let context = test_finish_context_with_mode(
            "run-minimal-warn",
            Vec::new(),
            false,
            SINGLE_AGENT_MODE_MINIMAL,
        );

        let (_experts, audit, pushback) =
            finish_run_audit_and_soft_check(&conn, &context, &input, summary, "run-minimal-warn")
                .expect("极简收尾不得失败");
        assert!(
            pushback.is_none(),
            "极简模式绝不打回（否则模型不重试就会整轮失败）：{pushback:?}"
        );
        let warnings = audit["summaryFormatWarnings"]
            .as_array()
            .expect("warnings array")
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>();
        assert_eq!(
            warnings,
            vec![
                format!("minimal 模式下 summary 超过 {MINIMAL_SUMMARY_MAX_WIDTH} 字符"),
                "minimal 模式下 summary 含多行".to_string(),
            ],
            "审计必须把问题记全"
        );
        assert_eq!(audit["singleAgentMode"], SINGLE_AGENT_MODE_MINIMAL);
        // 没有任何"打回额度"被消耗：状态字段已删除，gate 只剩 C22 的那一个且仍为 0。
        assert_eq!(
            context.finish_gate.lock().expect("gate").self_analysis_pushbacks,
            0,
            "极简路径不得触碰 C22 的额度"
        );

        // "仍产生了正文"单独一条（summary 本身合规时，就只保留这一条）。
        conn.execute(
            "INSERT INTO ai_messages(id,session_id,role,content,created_at)
             VALUES('m-prose','background:run-minimal-warn','assistant','本轮我的看法…',1)",
            [],
        )
        .expect("insert prose message");
        let one_liner = "无持仓，等待 81227 站稳后再评估。";
        let (_e, audit, pushback) =
            finish_run_audit_and_soft_check(&conn, &context, &input, one_liner, "run-minimal-warn")
                .expect("极简收尾不得失败");
        assert!(pushback.is_none());
        assert_eq!(
            audit["summaryFormatWarnings"],
            json!(["minimal 模式仍产生了正文"])
        );

        // 极简 + 升级 + 零专家 + 无理由：C22 的那一次仍然生效（未被极简改动影响）。
        let escalated = test_finish_context_with_mode(
            "run-minimal-c22",
            vec![desic_agent_automation::builtin_agent_definition("desic-data-digest")
                .expect("definition")],
            true,
            SINGLE_AGENT_MODE_MINIMAL,
        );
        let (_e, audit, first) =
            finish_run_audit_and_soft_check(&conn, &escalated, &input, one_liner, "run-minimal-c22")
                .expect("first");
        assert_eq!(audit["selfAnalysisUnjustified"], true);
        assert_eq!(
            first.expect("C22 pushback")["errorCode"],
            "self_analysis_reason_required"
        );
        let (_e, _a, second) =
            finish_run_audit_and_soft_check(&conn, &escalated, &input, one_liner, "run-minimal-c22")
                .expect("second");
        assert!(second.is_none(), "C22 仍是『最多一次』");
        assert_eq!(
            escalated
                .finish_gate
                .lock()
                .expect("gate")
                .self_analysis_pushbacks,
            1
        );

        // 标准模式回归：同一份五小节报告 → 无警告、无打回（C21 行为不变）。
        let standard = test_finish_context("run-standard-warn", Vec::new(), false);
        let (_e, audit, pushback) =
            finish_run_audit_and_soft_check(&conn, &standard, &input, summary, "run-standard-warn")
                .expect("standard finish");
        assert!(
            audit["summaryFormatWarnings"].as_array().expect("array").is_empty(),
            "标准模式下这份五小节报告是合规的"
        );
        assert!(pushback.is_none());
    }

    /// C24.2-3："仍然输出了正文"的判据只看助手正文通道（工具事件不算说话）。
    #[test]
    fn minimal_mode_detects_assistant_text_in_the_run_session() {
        let conn = usage_test_connection();
        conn.execute(
            "INSERT INTO ai_messages(id,session_id,role,content,created_at)
             VALUES('m-tool-only','background:run-minimal','assistant','',1)",
            [],
        )
        .expect("insert tool-only message");
        assert!(
            !run_has_assistant_text(&conn, "run-minimal"),
            "只有工具调用的轮次不算输出正文"
        );
        conn.execute(
            "INSERT INTO ai_messages(id,session_id,role,content,created_at)
             VALUES('m-prose','background:run-minimal','assistant','本轮我的看法是……',2)",
            [],
        )
        .expect("insert prose message");
        assert!(run_has_assistant_text(&conn, "run-minimal"));
        // 别的会话 / 别轮 Run 不受影响。
        assert!(!run_has_assistant_text(&conn, "run-other"));
    }

    /// ③ C21.3 软审计：**只判两项**（五小节齐备 + 事实与证据带时间戳），
    /// zh / en 两套按概念匹配、允许大小写差异、混用也算通过；
    /// 不扩展表格列数 / emoji / 行长等提示词没硬要求的东西。
    #[test]
    fn summary_format_audit_accepts_zh_and_en_and_never_fails() {
        let zh = "## 结论\n本轮不建仓。\n## 事实与证据\n- 15:00 结构未确认（market.readTicker）\n## 冲突与缺口\n无\n## 观察条件\n站上 X\n## 下一步\n等待";
        assert!(summary_format_warnings(zh).is_empty(), "{:?}", summary_format_warnings(zh));

        let en = "## Conclusion\nNo entry this round.\n## Facts and evidence\n- 2026-09-19T15:00Z structure unconfirmed (market.readTicker)\n## Conflicts and gaps\nnone\n## Observation conditions\nreclaim X\n## Next steps\nwait";
        assert!(summary_format_warnings(en).is_empty(), "{:?}", summary_format_warnings(en));

        // 混用（中文三节 + 英文两节）：五个概念齐全 → 通过。
        let mixed = "## 结论\n等待\n## 事实与证据\n- 15:00 无变化\n## 冲突与缺口\n无\n## Observation conditions\nx\n## Next steps\ny";
        assert!(summary_format_warnings(mixed).is_empty(), "{:?}", summary_format_warnings(mixed));

        // 大小写差异 + 尾随装饰冒号 + 多余空格 → 仍按概念匹配。
        let decorated = "##  CONCLUSION: \n##  Facts  and  evidence\n- 09:30 ok\n## conflicts and gaps\n## observation conditions\n## next steps";
        assert!(summary_format_warnings(decorated).is_empty(), "{:?}", summary_format_warnings(decorated));

        // 缺 `## 观察条件` → 一条警告（正文照旧，不改写）。
        let missing = "## 结论\nx\n## 事实与证据\n- 15:00 ok\n## 冲突与缺口\n无\n## 下一步\n等";
        let warnings = summary_format_warnings(missing);
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(warnings[0].contains("观察条件"), "{warnings:?}");
        assert!(missing.contains("## 下一步"), "审计不得改动正文");

        // 「事实与证据」没有时间戳 → 一条警告。
        let no_stamp = "## 结论\nx\n## 事实与证据\n- 结构未确认\n## 冲突与缺口\n无\n## 观察条件\n等\n## 下一步\n等";
        assert_eq!(
            summary_format_warnings(no_stamp),
            vec!["事实与证据无时间戳".to_string()]
        );

        // 时间戳的多种形状都算：epoch 毫秒 / 月-日 / 时钟。
        for stamped in [
            "## 结论\nx\n## 事实与证据\n- 1726758000000 读数\n## 冲突与缺口\n## 观察条件\n## 下一步",
            "## 结论\nx\n## 事实与证据\n- 2026/09/19 结构\n## 冲突与缺口\n## 观察条件\n## 下一步",
            "## 结论\nx\n## 事实与证据\n- 15:04 读数\n## 冲突与缺口\n## 观察条件\n## 下一步",
        ] {
            assert!(summary_format_warnings(stamped).is_empty(), "{stamped}");
        }

        // 完全没结构（散文体）→ 五条"缺小节"，仍然只是警告。
        assert_eq!(summary_format_warnings("一大段没有小节的散文。").len(), 5);

        // 不扩展审计：4 列表格、emoji、超长段落都不产生警告。
        let extra = "## 结论\n✅ x\n| a | b | c | d |\n## 事实与证据\n- 15:00 ok\n## 冲突与缺口\n## 观察条件\n## 下一步";
        assert!(summary_format_warnings(extra).is_empty(), "{:?}", summary_format_warnings(extra));

        // 任何输入都不得 panic / 失败（含空、只有 `#`、CRLF、超长单行）。
        for hostile in [
            "",
            "#",
            "######",
            "## 事实与证据\r\n- 15:00 ok\r\n## 结论\r\n## 冲突与缺口\r\n## 观察条件\r\n## 下一步",
            &"内容".repeat(20_000),
        ] {
            let _ = summary_format_warnings(hostile);
        }
    }

}
