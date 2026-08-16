use super::*;
use desic_agent_automation::{
    evaluate_condition, normalize_multi_agent_mode, normalize_permission_mode,
    normalize_profile_sub_agents, orderbook_imbalance, validate_profile_sub_agent_capacity,
    AiProfileSubAgent, DomainEvent, RollingFeatureCache, WakeCondition, WakeMarketState,
    ADVISOR_MODE, MULTI_AGENT_CUSTOM_MAX_AGENTS,
};
use rusqlite::{params_from_iter, TransactionBehavior};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::{Notify, Semaphore};

const AUTOMATION_EVENT: &str = "ai:automation-event";
const FEISHU_CONFIG_EVENT_TYPES_VERSION: i64 = 2;
const FEISHU_STRATEGY_SIGNAL_EVENT: &str = "strategy_signal";
const AUTOMATION_RUN_LIST_PAGE_SIZE: i64 = 50;
const SKILL_FILES_FINGERPRINT_SETTING: &str = "skill_files_fingerprint";
const BUILTIN_PERPETUAL_DECISION_DESK_ID: &str = "builtin-perpetual-decision-desk";
const REQUIRED_PROFILE_SKILL_IDS: [&str; 4] = [
    "desic-core-operations",
    "trading-philosophy",
    "okx-news-intelligence",
    "okx-smart-money-analysis",
];
const DAILY_MARKET_REVIEW_EVIDENCE_RULES: &str = "历史 Smart Money 日内证据必须优先使用 intelligence.smartMoney.readSignalTrendByFilter：instId 使用完整永续交易对，granularity=1h，ts 使用 windowEnd-1 的 13 位毫秒字符串，limit 按窗口小时数设置；后端会把 ts 转成 OKX UTC+8 小时 dataVersion，绝不向上游发送 ts。readSignalOverviewByFilter 是当前小时快照且不得传 ts/dataVersion，只能作为明确标注的复盘后补充，不能归入目标日期或用于制造历史证据冲突。Daily Briefing 是可选的预生成产物；未启用或返回空列表不属于原始市场数据缺口，不得单独据此否决结论。System Stress 应按返回时间桶和 coverage 披露实际覆盖范围；ADL unknown 只表示没有可确认的警告状态。accountId 是不透明稳定标识，其中的 demo/live 字样不代表环境；只以独立 environment 字段和后端账户绑定校验为准。";
const PERPETUAL_ACCOUNT_RISK_LANGUAGE_RULES: &str = "永续合约的张数、币数量、名义敞口、保证金、止损和 ATR 风险只使用 account.readRisk 的 instrumentEvaluations、trade.evaluatePlan 或 trade.precheck 返回的结构化字段，不得自行手算。effectiveExposureMultiple=名义敞口÷USDT权益，notionalPctOfEquity=effectiveExposureMultiple×100%；例如 notionalPctOfEquity=47.58% 等于 effectiveExposureMultiple=0.4758X，表示标的反向波动1%时，忽略费用、资金费和滑点，权益约损失0.4758%，不是占用47.58%保证金。notionalPctOfEquity不超过100%表示有效敞口不超过1X；不得仅凭账户余额绝对值、minSz或名义敞口比例称为高风险、高杠杆、账户太小、容错空间有限或不适合开仓。账户容错只能结合stopRiskPctOfEquity、oneAtrRiskPctOfEquity、marginPctOfEquity、剩余保证金、强平距离、已有持仓和组合总风险判断。trade.precheck返回blocked=false时必须称为账户可行；没有明确用户风险预算时只报告结构化数值，不自行发明风险阈值。";
const DAILY_MARKET_REVIEW_EVIDENCE_RULES_EN: &str = "For historical intraday Smart Money evidence, prefer intelligence.smartMoney.readSignalTrendByFilter. Use the complete perpetual instId, granularity=1h, a 13-digit millisecond ts equal to windowEnd-1, and a limit matching the window hours. The backend converts ts to the OKX UTC+8 hourly dataVersion and never forwards ts upstream. readSignalOverviewByFilter is a current-hour snapshot and must not receive ts/dataVersion; it may only be cited as a clearly labelled post-review supplement and must not be attributed to the target date or used to fabricate a historical evidence conflict. Daily Briefing is an optional pre-generated artifact; disabled or empty briefing results are not an original market-data gap and cannot independently invalidate a conclusion. Report the actual System Stress time buckets and coverage. ADL unknown only means that no warning state was confirmed. accountId is an opaque stable identifier; demo/live text inside it does not define the environment. Use only the separate environment field and backend account binding validation.";
const PERPETUAL_ACCOUNT_RISK_LANGUAGE_RULES_EN: &str = "For perpetual contracts, use only structured fields returned by account.readRisk instrumentEvaluations, trade.evaluatePlan, or trade.precheck for contract quantity, base quantity, notional exposure, margin, stop risk, and ATR risk. Never recompute them manually. effectiveExposureMultiple equals notional exposure divided by USDT equity, and notionalPctOfEquity equals effectiveExposureMultiple multiplied by 100%. For example, notionalPctOfEquity=47.58% means effectiveExposureMultiple=0.4758X: ignoring fees, funding, and slippage, an adverse 1% move in the instrument implies about a 0.4758% equity loss; it does not mean 47.58% margin usage. notionalPctOfEquity at or below 100% means effective exposure at or below 1X. Do not label an account high-risk, highly leveraged, too small, low-tolerance, or unsuitable solely from absolute balance, minSz, or notional exposure percentage. Judge account tolerance only with stopRiskPctOfEquity, oneAtrRiskPctOfEquity, marginPctOfEquity, remaining margin, liquidation distance, existing positions, and portfolio risk. If trade.precheck returns blocked=false, describe the account as feasible. Without an explicit user risk budget, report structured values and do not invent thresholds.";

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
    pub multi_agent_mode: String,
    pub multi_agent_max_agents: u32,
    pub multi_agents: Vec<AiProfileSubAgent>,
    #[serde(default)]
    pub multi_agent_scheme_id: Option<String>,
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
    #[serde(default = "default_multi_agent_mode")]
    pub multi_agent_mode: String,
    #[serde(default = "default_multi_agent_max_agents")]
    pub multi_agent_max_agents: u32,
    #[serde(default)]
    pub multi_agents: Vec<AiProfileSubAgent>,
    #[serde(default)]
    pub multi_agent_scheme_id: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiAgentScheme {
    pub id: String,
    pub name: String,
    pub description: String,
    pub builtin: bool,
    pub agents: Vec<AiProfileSubAgent>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiAgentSchemeInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub agents: Vec<AiProfileSubAgent>,
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

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiTokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub reasoning_tokens: u64,
    pub total_tokens: u64,
}

impl AiTokenUsage {
    fn add_assign(&mut self, other: &Self) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.cache_read_tokens = self
            .cache_read_tokens
            .saturating_add(other.cache_read_tokens);
        self.cache_write_tokens = self
            .cache_write_tokens
            .saturating_add(other.cache_write_tokens);
        self.reasoning_tokens = self.reasoning_tokens.saturating_add(other.reasoning_tokens);
        self.total_tokens = self.input_tokens.saturating_add(self.output_tokens);
    }

    fn is_empty(&self) -> bool {
        self.input_tokens == 0
            && self.output_tokens == 0
            && self.cache_read_tokens == 0
            && self.cache_write_tokens == 0
            && self.reasoning_tokens == 0
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiUsageSummary {
    pub provider: String,
    pub model_id: String,
    pub model: String,
    pub model_name: String,
    pub reported: bool,
    pub agent_count: u32,
    pub usage: AiTokenUsage,
    pub main_usage: AiTokenUsage,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiTokenUsagePeriod {
    pub usage: AiTokenUsage,
    pub turn_count: u32,
    pub session_count: u32,
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
    pub tracked_from: Option<i64>,
    pub today: AiTokenUsagePeriod,
    pub yesterday: AiTokenUsagePeriod,
    pub seven_days: AiTokenUsagePeriod,
    pub by_model: Vec<AiTokenUsageByModel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiAgentRunSummary {
    pub id: String,
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
    pub agent_schemes: Vec<AiAgentScheme>,
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
    pub agent_schemes: Vec<AiAgentScheme>,
    pub skill_versions: Vec<AiSkillVersionSummary>,
    pub counts: AiAutomationCounts,
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
    pub multi_agent_mode: String,
    pub multi_agent_max_agents: u32,
    pub multi_agents: Vec<AiProfileSubAgent>,
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
}

#[derive(Debug, Deserialize)]
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
    15
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
fn default_multi_agent_mode() -> String {
    desic_agent_automation::MULTI_AGENT_OFF_MODE.to_string()
}
fn default_multi_agent_max_agents() -> u32 {
    4
}
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
        Ok(AiAutomationSummary {
            master_enabled: automation_master_enabled_with_conn(&conn),
            profiles: load_profiles(&conn)?,
            agent_schemes: load_agent_schemes(&conn)?,
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
        Ok(AiAutomationOverview {
            master_enabled: automation_master_enabled_with_conn(&conn),
            profiles: load_profiles(&conn)?,
            agent_schemes: load_agent_schemes(&conn)?,
            skill_versions: load_skill_versions(&conn, 200)?,
            counts: load_automation_counts(&conn)?,
        })
    })
    .await
    .map_err(|err| format!("读取自动化概览任务失败: {err}"))?
}

pub(crate) fn sync_ai_skill_versions(app: &tauri::AppHandle) -> Result<(), String> {
    let conn = open_automation_database(app)?;
    ensure_skill_versions(app, &conn)
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
    sessions: HashSet<String>,
    turn_count: u32,
    unreported_turn_count: u32,
}

impl AiUsageAccumulator {
    fn add(&mut self, record: &AiUsageRecord) {
        self.turn_count = self.turn_count.saturating_add(1);
        self.sessions.insert(record.session_id.clone());
        if record.summary.reported {
            self.usage.add_assign(&record.summary.usage);
        } else {
            self.unreported_turn_count = self.unreported_turn_count.saturating_add(1);
        }
    }

    fn finish(self) -> AiTokenUsagePeriod {
        AiTokenUsagePeriod {
            usage: self.usage,
            turn_count: self.turn_count,
            session_count: self.sessions.len() as u32,
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

fn extract_compact_usage_summary(value: &str) -> Option<AiUsageSummary> {
    const MARKER: &str = "{\"__desicUsageSummary\":";
    let start = value.rfind(MARKER)?;
    let event = value[start..].trim().strip_suffix(']')?.trim();
    let event = serde_json::from_str::<Value>(event).ok()?;
    serde_json::from_value(event.get("__desicUsageSummary")?.clone()).ok()
}

fn load_ai_token_usage_dashboard(
    conn: &Connection,
    now: i64,
) -> Result<AiTokenUsageDashboard, String> {
    const DAY_MS: i64 = 86_400_000;
    const SHANGHAI_OFFSET_MS: i64 = 8 * 60 * 60 * 1000;
    const SUMMARY_TAIL_BYTES: i64 = 32_768;
    let today_start =
        (now.saturating_add(SHANGHAI_OFFSET_MS)).div_euclid(DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS;
    let yesterday_start = today_start.saturating_sub(DAY_MS);
    let seven_days_start = today_start.saturating_sub(6 * DAY_MS);
    let mut stmt = conn
        .prepare(
            "SELECT session_id,created_at,substr(tool_json, -?2)
             FROM ai_messages
             WHERE role='assistant' AND created_at>=?1 AND tool_json IS NOT NULL
             ORDER BY created_at ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![seven_days_start, SUMMARY_TAIL_BYTES], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut records = Vec::new();
    for row in rows {
        let (session_id, created_at, tail) = row.map_err(|error| error.to_string())?;
        let Some(summary) = extract_compact_usage_summary(&tail) else {
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
        tracked_from: records.first().map(|record| record.created_at),
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
        let conn = open_read_database(&app)?;
        load_ai_token_usage_dashboard(&conn, now_ms())
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

fn builtin_agent_schemes() -> Vec<AiAgentScheme> {
    vec![AiAgentScheme {
        id: BUILTIN_PERPETUAL_DECISION_DESK_ID.to_string(),
        name: "永续合约决策台".to_string(),
        description: "市场、情报与账户并行取证，反方审查后由主 Agent 汇总决策。".to_string(),
        builtin: true,
        agents: vec![
            AiProfileSubAgent {
                id: "market-structure".to_string(),
                name: "市场结构".to_string(),
                role: "市场结构分析".to_string(),
                responsibility:
                    "分析 K 线结构、成交、盘口、资金费率、持仓量与流动性，输出方向、关键价位和证据。"
                        .to_string(),
                scopes: vec![
                    "market".to_string(),
                    "derivatives".to_string(),
                    "history".to_string(),
                ],
                required: true,
                enabled: true,
            },
            AiProfileSubAgent {
                id: "intelligence-flow".to_string(),
                name: "情报资金".to_string(),
                role: "情报与资金分析".to_string(),
                responsibility:
                    "核对新闻、宏观事件、情绪、Smart Money 与资金流，区分事实、推断和时效。"
                        .to_string(),
                scopes: vec![
                    "intelligence".to_string(),
                    "derivatives".to_string(),
                    "history".to_string(),
                ],
                required: false,
                enabled: true,
            },
            AiProfileSubAgent {
                id: "account-risk".to_string(),
                name: "账户风险".to_string(),
                role: "账户与执行风险".to_string(),
                responsibility: "检查仓位、保证金、订单、交易预检和历史风险暴露，给出可执行约束。"
                    .to_string(),
                scopes: vec![
                    "account".to_string(),
                    "history".to_string(),
                    "market".to_string(),
                ],
                required: true,
                enabled: true,
            },
            AiProfileSubAgent {
                id: "contrarian-review".to_string(),
                name: "反方审查".to_string(),
                role: "反方与数据缺口审查".to_string(),
                responsibility: "主动寻找结论冲突、数据缺口、无效假设和极端风险，给出明确否决条件。"
                    .to_string(),
                scopes: vec![
                    "market".to_string(),
                    "derivatives".to_string(),
                    "intelligence".to_string(),
                    "account".to_string(),
                    "history".to_string(),
                ],
                required: false,
                enabled: true,
            },
        ],
        created_at: 0,
        updated_at: 0,
    }]
}

fn normalize_agent_scheme_input(
    mut scheme: AiAgentSchemeInput,
) -> Result<AiAgentSchemeInput, String> {
    scheme.id = scheme
        .id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if scheme.id.as_deref() == Some(BUILTIN_PERPETUAL_DECISION_DESK_ID) {
        return Err("内置 Agent 方案不能覆盖".to_string());
    }
    if let Some(id) = scheme.id.as_deref() {
        if id.chars().count() > 100
            || !id
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        {
            return Err("Agent 方案 ID 无效".to_string());
        }
    }
    scheme.name = scheme.name.trim().to_string();
    if !(1..=80).contains(&scheme.name.chars().count()) {
        return Err("Agent 方案名称长度必须为 1-80 个字符".to_string());
    }
    scheme.description = scheme.description.trim().to_string();
    if scheme.description.chars().count() > 500 {
        return Err("Agent 方案说明不能超过 500 个字符".to_string());
    }
    scheme.agents = normalize_profile_sub_agents(
        desic_agent_automation::MULTI_AGENT_CUSTOM_MODE,
        scheme.agents,
    )?;
    if !(2..=MULTI_AGENT_CUSTOM_MAX_AGENTS as usize).contains(&scheme.agents.len()) {
        return Err(format!(
            "Agent 方案必须配置 2-{} 个子 Agent",
            MULTI_AGENT_CUSTOM_MAX_AGENTS
        ));
    }
    Ok(scheme)
}

fn load_agent_schemes(conn: &Connection) -> Result<Vec<AiAgentScheme>, String> {
    let mut schemes = builtin_agent_schemes();
    let mut stmt = conn
        .prepare(
            "SELECT id,name,description,agents_json,created_at,updated_at
             FROM ai_agent_schemes WHERE id<>?1 ORDER BY updated_at DESC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![BUILTIN_PERPETUAL_DECISION_DESK_ID], |row| {
            let agents_json = row.get::<_, String>(3)?;
            let agents = serde_json::from_str::<Vec<AiProfileSubAgent>>(&agents_json)
                .map_err(|error| invalid_profile_row(3, format!("agents_json 无效：{error}")))?;
            let agents = normalize_profile_sub_agents(
                desic_agent_automation::MULTI_AGENT_CUSTOM_MODE,
                agents,
            )
            .map_err(|error| invalid_profile_row(3, error))?;
            if !(2..=MULTI_AGENT_CUSTOM_MAX_AGENTS as usize).contains(&agents.len()) {
                return Err(invalid_profile_row(
                    3,
                    format!(
                        "Agent 方案必须配置 2-{} 个子 Agent",
                        MULTI_AGENT_CUSTOM_MAX_AGENTS
                    ),
                ));
            }
            Ok(AiAgentScheme {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                builtin: false,
                agents,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|err| err.to_string())?;
    schemes.extend(
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?,
    );
    Ok(schemes)
}

fn agent_scheme_exists(conn: &Connection, id: &str) -> Result<bool, String> {
    if id == BUILTIN_PERPETUAL_DECISION_DESK_ID {
        return Ok(true);
    }
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM ai_agent_schemes WHERE id=?1)",
        params![id],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value != 0)
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn ai_agent_scheme_save(
    app: tauri::AppHandle,
    scheme: AiAgentSchemeInput,
) -> Result<AiAgentScheme, String> {
    let conn = open_automation_database(&app)?;
    save_agent_scheme_with_conn(&conn, scheme)
}

fn save_agent_scheme_with_conn(
    conn: &Connection,
    scheme: AiAgentSchemeInput,
) -> Result<AiAgentScheme, String> {
    let scheme = normalize_agent_scheme_input(scheme)?;
    let now = now_ms();
    let id = scheme
        .id
        .clone()
        .unwrap_or_else(|| format!("scheme-{}", unique_suffix()));
    let created_at = conn
        .query_row(
            "SELECT created_at FROM ai_agent_schemes WHERE id=?1",
            params![id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .unwrap_or(now);
    conn.execute(
        "INSERT INTO ai_agent_schemes(id,name,description,agents_json,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,
           agents_json=excluded.agents_json,updated_at=excluded.updated_at",
        params![
            id,
            scheme.name,
            scheme.description,
            to_json(&scheme.agents)?,
            created_at,
            now,
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(AiAgentScheme {
        id,
        name: scheme.name,
        description: scheme.description,
        builtin: false,
        agents: scheme.agents,
        created_at,
        updated_at: now,
    })
}

#[tauri::command]
pub(crate) fn ai_agent_scheme_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut conn = open_automation_database(&app)?;
    delete_agent_scheme_with_conn(&mut conn, &id)
}

fn delete_agent_scheme_with_conn(conn: &mut Connection, id: &str) -> Result<(), String> {
    let id = id.trim();
    if id == BUILTIN_PERPETUAL_DECISION_DESK_ID {
        return Err("内置 Agent 方案不能删除".to_string());
    }
    if id.is_empty() {
        return Err("Agent 方案 ID 不能为空".to_string());
    }
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let changed = tx
        .execute("DELETE FROM ai_agent_schemes WHERE id=?1", params![id])
        .map_err(|err| err.to_string())?;
    if changed == 0 {
        return Err("Agent 方案不存在".to_string());
    }
    tx.execute(
        "UPDATE ai_agent_profiles SET multi_agent_scheme_id=NULL,updated_at=?2
         WHERE multi_agent_scheme_id=?1",
        params![id, now_ms()],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(())
}

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
        skill_versions_json,
        initial_market_snapshot_json,
        final_decision_json,
    ) = conn
        .query_row(
            "SELECT trigger_json,profile_snapshot_json,skill_versions_json,
                    initial_market_snapshot_json,final_decision_json
             FROM ai_agent_runs WHERE id=?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
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
    if let Some(scheme_id) = profile.multi_agent_scheme_id.as_deref() {
        if !agent_scheme_exists(&conn, scheme_id)? {
            return Err("Profile 引用的 Agent 方案不存在".to_string());
        }
    }
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
    conn.execute(
        "INSERT INTO ai_agent_profiles (
          id,name,enabled,mode,account_id,environment,symbols_json,scan_interval_minutes,
          skill_ids_json,skill_versions_json,skill_version_modes_json,model,reasoning_depth,history_lookback_days,similarity_window_minutes,
          entry_tolerance_bps,max_runtime_seconds,min_wake_interval_seconds,max_runs_per_hour,
          feishu_enabled,daily_review_enabled,allowed_wake_condition_types_json,
          multi_agent_mode,multi_agent_max_agents,multi_agents_json,multi_agent_scheme_id,
          created_at,updated_at,deleted_at,target_leverage,max_single_trade_margin_pct
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,NULL,?29,?30)
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
          target_leverage=excluded.target_leverage,
          max_single_trade_margin_pct=excluded.max_single_trade_margin_pct,
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
            profile.multi_agent_mode,
            profile.multi_agent_max_agents,
            to_json(&profile.multi_agents)?,
            profile.multi_agent_scheme_id,
            created_at,
            now,
            profile.target_leverage,
            profile.max_single_trade_margin_pct,
        ],
    )
    .map_err(|err| err.to_string())?;
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
    load_profile(&conn, &id)
}

#[tauri::command]
pub(crate) fn ai_agent_profile_systematic_conflicts(
    app: tauri::AppHandle,
    request: AiAgentProfileSystematicConflictRequest,
) -> Result<Vec<AiAgentProfileSystematicConflict>, String> {
    let conn = open_automation_database(&app)?;
    let environment = match request.account_id.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(account_id) => normalize_environment(&load_local_account_secret(&app, Some(account_id))?.environment),
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
    let proposed =
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
    let proposed_content = serde_json::to_string(&proposed).map_err(|err| err.to_string())?;
    if proposed_content == base_content {
        return Err("候选 Skill 与当前基线完全相同".to_string());
    }

    let mut config = crate::storage_config::load_ai_config_locked(app)?;
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
    let definition = serde_json::from_value::<desic_storage_config::AiSkillDefinition>(
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
        "UPDATE ai_skill_versions SET status='published',published_at=?2
         WHERE id=?1 AND status='draft'
           AND NOT EXISTS (
             SELECT 1 FROM ai_skill_versions
             WHERE skill_id=?3 AND status='published' AND version>=?4
           )",
        params![id, now, &version.skill_id, i64::from(version.version)],
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
    profile.multi_agent_mode =
        normalize_multi_agent_mode(Some(&profile.multi_agent_mode)).to_string();
    profile.multi_agent_scheme_id = profile
        .multi_agent_scheme_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    profile.multi_agents =
        normalize_profile_sub_agents(&profile.multi_agent_mode, profile.multi_agents)?;
    validate_profile_sub_agent_capacity(
        &profile.multi_agent_mode,
        profile.multi_agent_max_agents,
        &profile.multi_agents,
    )?;
    validate_profile_sub_agent_account_scope(
        &profile.multi_agent_mode,
        profile.account_id.as_deref(),
        &profile.multi_agents,
    )?;
    Ok(profile)
}

fn with_required_profile_skills(items: Vec<String>) -> Vec<String> {
    let mut result = REQUIRED_PROFILE_SKILL_IDS
        .iter()
        .map(|skill_id| (*skill_id).to_string())
        .collect::<Vec<_>>();
    for skill_id in normalize_strings(items) {
        if !result.iter().any(|existing| existing == &skill_id) {
            result.push(skill_id);
        }
    }
    result
}

fn normalize_profile_reasoning_depth(value: &str) -> String {
    match value.trim() {
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" => value.trim().to_string(),
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

fn validate_profile_sub_agent_account_scope(
    mode: &str,
    account_id: Option<&str>,
    agents: &[AiProfileSubAgent],
) -> Result<(), String> {
    if normalize_multi_agent_mode(Some(mode)) == desic_agent_automation::MULTI_AGENT_CUSTOM_MODE
        && account_id.is_none()
        && agents
            .iter()
            .any(|agent| agent.enabled && agent.scopes.iter().any(|scope| scope == "account"))
    {
        return Err("自定义多 Agent 中启用了账户范围，Profile 必须绑定账户".to_string());
    }
    Ok(())
}

fn validate_profile_snapshot(
    mut profile: AiAgentProfileSummary,
) -> Result<AiAgentProfileSummary, String> {
    let raw_mode = profile.multi_agent_mode.trim();
    if !matches!(
        raw_mode,
        desic_agent_automation::MULTI_AGENT_OFF_MODE
            | desic_agent_automation::MULTI_AGENT_AUTO_MODE
            | desic_agent_automation::MULTI_AGENT_CUSTOM_MODE
    ) {
        return Err(format!(
            "Run Profile 快照中的多 Agent 模式无效：{}",
            profile.multi_agent_mode
        ));
    }
    profile.multi_agent_mode = raw_mode.to_string();
    profile.multi_agent_scheme_id = profile
        .multi_agent_scheme_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    profile.target_leverage = profile.target_leverage.clamp(1, 125);
    profile.max_single_trade_margin_pct = profile.max_single_trade_margin_pct.clamp(1, 100);
    profile.multi_agents =
        normalize_profile_sub_agents(&profile.multi_agent_mode, profile.multi_agents)?;
    validate_profile_sub_agent_capacity(
        &profile.multi_agent_mode,
        profile.multi_agent_max_agents,
        &profile.multi_agents,
    )?;
    validate_profile_sub_agent_account_scope(
        &profile.multi_agent_mode,
        profile.account_id.as_deref(),
        &profile.multi_agents,
    )?;
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

fn systematic_profile_conflict_message(
    conflicts: &[AiAgentProfileSystematicConflict],
) -> String {
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
             multi_agent_mode,multi_agent_max_agents,multi_agents_json,multi_agent_scheme_id,
             created_at,updated_at,target_leverage,skill_version_modes_json,reasoning_depth,max_single_trade_margin_pct
             FROM ai_agent_profiles WHERE deleted_at IS NULL ORDER BY enabled DESC, updated_at DESC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], profile_from_row)
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn load_profile(conn: &Connection, id: &str) -> Result<AiAgentProfileSummary, String> {
    conn.query_row(
        "SELECT id,name,enabled,mode,account_id,environment,symbols_json,scan_interval_minutes,
         skill_ids_json,skill_versions_json,model,history_lookback_days,similarity_window_minutes,
         entry_tolerance_bps,min_wake_interval_seconds,max_runs_per_hour,
         feishu_enabled,daily_review_enabled,allowed_wake_condition_types_json,
         multi_agent_mode,multi_agent_max_agents,multi_agents_json,multi_agent_scheme_id,
         created_at,updated_at,target_leverage,skill_version_modes_json,reasoning_depth,max_single_trade_margin_pct
         FROM ai_agent_profiles WHERE id=?1 AND deleted_at IS NULL",
        params![id],
        profile_from_row,
    )
    .map_err(|err| err.to_string())
}

fn invalid_profile_row(column: usize, message: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        column,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            message.into(),
        )),
    )
}

fn profile_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiAgentProfileSummary> {
    let symbols: String = row.get(6)?;
    let skill_ids: String = row.get(8)?;
    let skill_versions: String = row.get(9)?;
    let wake_types: String = row.get(18)?;
    let account_id: Option<String> = row.get(4)?;
    let raw_multi_agent_mode = row.get::<_, String>(19)?;
    let multi_agent_mode = match raw_multi_agent_mode.trim() {
        desic_agent_automation::MULTI_AGENT_OFF_MODE => {
            desic_agent_automation::MULTI_AGENT_OFF_MODE.to_string()
        }
        desic_agent_automation::MULTI_AGENT_AUTO_MODE => {
            desic_agent_automation::MULTI_AGENT_AUTO_MODE.to_string()
        }
        desic_agent_automation::MULTI_AGENT_CUSTOM_MODE => {
            desic_agent_automation::MULTI_AGENT_CUSTOM_MODE.to_string()
        }
        _ => {
            return Err(invalid_profile_row(
                19,
                format!("多 Agent 模式无效：{raw_multi_agent_mode}"),
            ))
        }
    };
    let multi_agent_max_agents = u32::try_from(row.get::<_, i64>(20)?)
        .map_err(|_| invalid_profile_row(20, "多 Agent 数量上限无效"))?;
    let multi_agents_json: String = row.get(21)?;
    let multi_agents = serde_json::from_str::<Vec<AiProfileSubAgent>>(&multi_agents_json)
        .map_err(|error| invalid_profile_row(21, format!("multi_agents_json 无效：{error}")))?;
    let multi_agents = normalize_profile_sub_agents(&multi_agent_mode, multi_agents)
        .map_err(|error| invalid_profile_row(21, error))?;
    validate_profile_sub_agent_capacity(&multi_agent_mode, multi_agent_max_agents, &multi_agents)
        .map_err(|error| invalid_profile_row(21, error))?;
    validate_profile_sub_agent_account_scope(
        &multi_agent_mode,
        account_id.as_deref(),
        &multi_agents,
    )
    .map_err(|error| invalid_profile_row(21, error))?;
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
        skill_version_modes: from_json_or_default(&row.get::<_, String>(26)?),
        model: row.get(10)?,
        reasoning_depth: normalize_profile_reasoning_depth(&row.get::<_, String>(27)?),
        history_lookback_days: row.get::<_, i64>(11)?.max(1) as u32,
        similarity_window_minutes: row.get::<_, i64>(12)?.max(1) as u32,
        entry_tolerance_bps: row.get::<_, i64>(13)?.max(1) as u32,
        target_leverage: row.get::<_, i64>(25)?.clamp(1, 125) as u32,
        max_single_trade_margin_pct: row.get::<_, i64>(28)?.clamp(1, 100) as u32,
        min_wake_interval_seconds: row.get::<_, i64>(14)?.max(15) as u32,
        max_runs_per_hour: row.get::<_, i64>(15)?.max(1) as u32,
        feishu_enabled: row.get::<_, i64>(16)? != 0,
        daily_review_enabled: row.get::<_, i64>(17)? != 0,
        allowed_wake_condition_types: from_json_or_default(&wake_types),
        multi_agent_mode,
        multi_agent_max_agents,
        multi_agents,
        multi_agent_scheme_id: row.get(22)?,
        created_at: row.get(23)?,
        updated_at: row.get(24)?,
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
        .and_then(|value| serde_json::from_str(value).ok());
    Some(RunMetadata {
        action_counts,
        token_usage,
    })
}

fn run_summary_from_stored(row: StoredRunRow, metadata: RunMetadata) -> AiAgentRunSummary {
    AiAgentRunSummary {
        id: row.id,
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
        token_usage: token_usage.reported.then(|| token_usage.clone()),
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
                    action_counts_json,token_usage_json
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
                action_counts_json,token_usage_json
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

fn load_run_metadata(
    conn: &Connection,
    run_id: &str,
) -> Result<RunMetadata, String> {
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

fn usage_u64(value: &Value, keys: &[&str]) -> u64 {
    keys.iter()
        .find_map(|key| {
            let value = value.get(*key)?;
            value
                .as_u64()
                .or_else(|| value.as_i64().and_then(|item| u64::try_from(item).ok()))
                .or_else(|| value.as_f64().map(|item| item.max(0.0) as u64))
                .or_else(|| value.as_str()?.parse::<u64>().ok())
        })
        .unwrap_or(0)
}

fn normalize_ai_token_usage(value: &Value) -> AiTokenUsage {
    let input_tokens = usage_u64(
        value,
        &[
            "inputTokens",
            "input_tokens",
            "totalInputTokens",
            "promptTokens",
        ],
    );
    let output_tokens = usage_u64(
        value,
        &[
            "outputTokens",
            "output_tokens",
            "totalOutputTokens",
            "completionTokens",
        ],
    );
    AiTokenUsage {
        input_tokens,
        output_tokens,
        cache_read_tokens: usage_u64(
            value,
            &[
                "cacheReadTokens",
                "cache_read_tokens",
                "cache_read_input_tokens",
                "cachedInputTokens",
            ],
        ),
        cache_write_tokens: usage_u64(
            value,
            &[
                "cacheWriteTokens",
                "cache_write_tokens",
                "cache_creation_input_tokens",
            ],
        ),
        reasoning_tokens: usage_u64(
            value,
            &[
                "reasoningTokens",
                "reasoning_tokens",
                "thoughtsTokens",
                "thoughts_tokens",
            ],
        ),
        total_tokens: input_tokens.saturating_add(output_tokens),
    }
}

fn build_ai_usage_summary(
    events: &[Value],
    provider: &str,
    model_id: &str,
    model: &str,
    model_name: &str,
) -> AiUsageSummary {
    let main_usage = events
        .iter()
        .rev()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("usage"))
        .and_then(|event| event.get("usage"))
        .map(normalize_ai_token_usage)
        .unwrap_or_default();
    let mut agent_usage_by_id = HashMap::<String, AiTokenUsage>::new();
    for (index, event) in events.iter().enumerate() {
        if event.get("type").and_then(Value::as_str) != Some("agentDone") {
            continue;
        }
        let id = event
            .get("configuredAgentId")
            .or_else(|| event.get("agentId"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("agent-{index}"));
        let usage = event
            .pointer("/result/usage")
            .map(normalize_ai_token_usage)
            .unwrap_or_default();
        agent_usage_by_id.insert(id, usage);
    }
    let mut usage = main_usage.clone();
    for agent_usage in agent_usage_by_id.values() {
        usage.add_assign(agent_usage);
    }
    AiUsageSummary {
        provider: provider.to_string(),
        model_id: model_id.to_string(),
        model: model.to_string(),
        model_name: model_name.to_string(),
        reported: !usage.is_empty(),
        agent_count: agent_usage_by_id.len() as u32,
        usage,
        main_usage,
    }
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

fn parse_run_metadata(tool_json: &str) -> RunMetadata {
    let events = serde_json::from_str::<Vec<Value>>(tool_json).unwrap_or_default();
    RunMetadata {
        action_counts: parse_run_action_counts_events(&events),
        token_usage: parse_ai_usage_summary_events(&events),
    }
}

fn parse_ai_usage_summary_events(events: &[Value]) -> Option<AiUsageSummary> {
    if let Some(summary) = events
        .iter()
        .rev()
        .find_map(|event| event.get("__desicUsageSummary"))
        .and_then(|value| serde_json::from_value::<AiUsageSummary>(value.clone()).ok())
    {
        return Some(summary);
    }
    let summary = build_ai_usage_summary(events, "unknown", "unknown", "unknown", "历史记录");
    summary.reported.then_some(summary)
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
    let now = now_ms();
    let id = format!("run-{}", unique_suffix());
    let inserted = conn
        .execute(
            "INSERT OR IGNORE INTO ai_agent_runs(
          id,profile_id,trigger_type,status,trigger_json,profile_snapshot_json,skill_versions_json,
          started_at,created_at,updated_at
         ) VALUES(?1,?2,?3,'queued',?4,?5,?6,?7,?7,?7)",
            params![
                id,
                profile_id,
                trigger_type,
                trigger.to_string(),
                to_json(&run_profile)?,
                to_json(&resolved_skill_versions)?,
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
    for required in ["okx-news-intelligence", "okx-smart-money-analysis"] {
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
    let skill_files_fingerprint = ai_skill_files_fingerprint(&config)?;
    let stored_fingerprint = load_setting(conn, SKILL_FILES_FINGERPRINT_SETTING)
        .and_then(|value| value.as_str().map(str::to_string));
    let mut skill_files_synced = false;
    if stored_fingerprint.as_deref() != Some(skill_files_fingerprint.as_str()) {
        crate::storage_config::sync_cline_skill_files_from_config(&config)?;
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

fn unique_suffix() -> String {
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
    let level = if status == "submitted" { "success" } else { "warning" };
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
    let final_decision_json = if is_intelligence_briefing || is_daily_market_review {
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
    tx.execute(
        "UPDATE ai_agent_runs SET status='completed',summary=?2,error=NULL,finished_at=?3,next_wake_at=?4,
                final_decision_json=?5,updated_at=?3
         WHERE id=?1",
        params![run_id, summary, now, next_wake_at, final_decision_json],
    )
    .map_err(|err| err.to_string())?;
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
        loop {
            tokio::select! {
                _ = sleep(Duration::from_secs(2)) => {},
                _ = runtime.notify.notified() => {},
            }
            if let Err(message) = automation_tick(app.clone(), runtime.clone()).await {
                let _ = app.emit(
                    AUTOMATION_EVENT,
                    json!({
                        "type": "runFailed",
                        "message": format!("AI 自动化调度异常：{}", message),
                        "action": { "tab": "runs" }
                    }),
                );
                sleep(Duration::from_secs(5)).await;
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
        if let Some((run, profile, trigger)) = claim_next_run(&conn, now)? {
            let run_app = app.clone();
            let run_runtime = runtime.clone();
            let failed_run_id = run.id.clone();
            let failed_profile = profile.clone();
            tauri::async_runtime::spawn(async move {
                let _permit = permit;
                if let Err(message) =
                    execute_profile_run(run_app.clone(), run, profile, trigger).await
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
) -> Result<Option<(AiAgentRunSummary, AiAgentProfileSummary, Value)>, String> {
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
    Ok(Some((run, profile, trigger)))
}

async fn execute_profile_run(
    app: tauri::AppHandle,
    run: AiAgentRunSummary,
    mut profile: AiAgentProfileSummary,
    mut trigger: Value,
) -> Result<(), String> {
    let is_intelligence_briefing = run.trigger_type == "intelligence_briefing";
    let is_daily_market_review = run.trigger_type == "daily_market_review";
    if is_intelligence_briefing || is_daily_market_review {
        profile.mode = desic_agent_automation::ADVISOR_MODE.to_string();
        profile.allowed_wake_condition_types.clear();
    }
    let skill_definitions = resolve_profile_skill_snapshot(&app, &mut profile)?;
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
    let multi_agent_instruction = if profile.multi_agent_mode
        == desic_agent_automation::MULTI_AGENT_OFF_MODE
    {
        String::new()
    } else {
        if chinese_prompt {
            format!(
                "\n多 Agent 模式: {}，最多 {} 个分析 Agent。子 Agent 报告只作为只读证据，由主 Agent 比较冲突、识别数据缺口并汇总最终结论；只有主 Agent 可以创建交易机会或提交本轮结果。",
                profile.multi_agent_mode, profile.multi_agent_max_agents
            )
        } else {
            format!(
                "\nMulti-Agent mode: {}, up to {} analysis Agents. Subagent reports are read-only evidence. The main Agent compares conflicts, identifies data gaps, and produces the final conclusion. Only the main Agent may create a trade opportunity or submit the run result.",
                profile.multi_agent_mode, profile.multi_agent_max_agents
            )
        }
    };
    let (analysis_owner, confirmed_by, rerun_workflow) = if profile.multi_agent_mode
        == desic_agent_automation::MULTI_AGENT_OFF_MODE
    {
        if chinese_prompt {
            (
                "由主 Agent 独立完成证据分析并决定是否形成交易候选",
                "本轮主 Agent 分析",
                "重新运行当前 Profile",
            )
        } else {
            (
                    "the main Agent independently analyzes the evidence and decides whether to form a trade candidate",
                    "this run's main-Agent analysis",
                    "rerunning the current Profile",
                )
        }
    } else {
        if chinese_prompt {
            (
                "由专家 Agent 完成证据分析，主 Agent 比较证据并决定是否形成交易候选",
                "本轮多 Agent 讨论",
                "重新运行多 Agent",
            )
        } else {
            (
                    "expert Agents analyze evidence and the main Agent compares it before deciding whether to form a trade candidate",
                    "this run's Multi-Agent review",
                    "rerunning the Multi-Agent workflow",
                )
        }
    };
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
            "{}\n你正在执行 Desic Terminal 后台 Agent Profile。\n当前时间: {}\n当前 Unix 毫秒时间戳: {}\nProfile: {}\n模式: {}\n账号: {}\n环境: {}\n目标杠杆: {}X\n最大单笔开仓保证金: USDT 权益的 {}%（且不超过可用 USDT）\n关注品种: {}\n默认历史回看: 最近 {} 天\n触发原因: {}{}\n{}\n{}\n所有工作完成后必须调用 background.finishRun；只提交 summary、语义化 finalDecision（outcome/reason/reasonCodes）和 nextWakePlan。实际机会 ID、最终复核 ID、账户可行/阻断状态和 blockers 均由后端从本 Run 的持久化记录生成，不要自行填写。最终摘要同样必须遵守账户风险字段语义，不能把账户余额、minSz或名义敞口比例写成账户容错不足。最后给出下一组适合当前市场阶段的类型化观察条件；新条件会替换上一轮 Agent 条件。nextWakePlan.expiresAt 和 timer.atMs 必须使用 13 位 Unix 毫秒时间戳（与 Date.now() 相同单位），不能使用 10 位秒级时间戳；不需要过期时间时可以省略 expiresAt。不要在正文中假装完成该工具。",
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
            PERPETUAL_ACCOUNT_RISK_LANGUAGE_RULES,
            decision_workflow_instruction,
        )
    } else {
        format!(
            "{}\nYou are running a Desic Terminal background Agent Profile.\nCurrent time: {}\nCurrent Unix timestamp in milliseconds: {}\nProfile: {}\nMode: {}\nAccount: {}\nEnvironment: {}\nTarget leverage: {}X\nMaximum opening margin per trade: {}% of USDT equity, capped by available USDT\nWatched markets: {}\nDefault history lookback: the latest {} days\nTrigger: {}{}\n{}\n{}\nAfter all work is complete, you must call background.finishRun. Submit only summary, semantic finalDecision fields (outcome/reason/reasonCodes), and nextWakePlan. The backend derives actual opportunity IDs, final-review IDs, account feasibility or block status, and blockers from persisted records for this Run; do not fill them yourself. The final summary must follow the same account-risk field semantics and must not describe balance, minSz, or notional exposure percentage as insufficient account tolerance. End with the next typed observation conditions appropriate for the current market regime; the new conditions replace the previous Agent conditions. nextWakePlan.expiresAt and timer.atMs must use 13-digit Unix millisecond timestamps, the same unit as Date.now(), never 10-digit seconds. Omit expiresAt when no expiry is needed. Do not claim in prose that the completion tool was called.",
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
            PERPETUAL_ACCOUNT_RISK_LANGUAGE_RULES_EN,
            decision_workflow_instruction,
        )
    };
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
        multi_agent_mode: profile.multi_agent_mode.clone(),
        multi_agent_max_agents: profile.multi_agent_max_agents,
        multi_agents: profile.multi_agents.clone(),
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
        multi_agent_mode: desic_agent_automation::MULTI_AGENT_OFF_MODE.to_string(),
        multi_agent_max_agents: default_multi_agent_max_agents(),
        multi_agents: Vec::new(),
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
                "SELECT id,profile_id,trigger_type,status,profile_snapshot_json,skill_versions_json,started_at,finished_at
                 FROM ai_agent_runs WHERE id=?1",
                params![run_id],
                |row| {
                    let profile_snapshot: Option<String> = row.get(4)?;
                    let skill_versions: String = row.get(5)?;
                    Ok(json!({
                        "id": row.get::<_, String>(0)?,
                        "profileId": row.get::<_, String>(1)?,
                        "triggerType": row.get::<_, String>(2)?,
                        "status": row.get::<_, String>(3)?,
                        "profileSnapshot": profile_snapshot.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
                        "skillVersions": serde_json::from_str::<Value>(&skill_versions).unwrap_or_else(|_| json!({})),
                        "startedAt": row.get::<_, i64>(6)?,
                        "finishedAt": row.get::<_, Option<i64>>(7)?,
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
               created_at INTEGER NOT NULL,action_counts_json TEXT NOT NULL DEFAULT '{}',token_usage_json TEXT
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
        conn.execute(
            "INSERT INTO ai_messages(id,session_id,role,content,tool_json,created_at)
             VALUES('message-1','background:run-1','assistant','done',?1,11)",
            [serde_json::to_string(&events).expect("serialize tool history")],
        )
        .expect("insert tool history");

        let first = load_runs(&conn, 50).expect("hydrate legacy run summary");
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].action_counts.opportunity, 1);
        assert_eq!(first[0].token_usage.as_ref().map(|usage| usage.usage.total_tokens), Some(15));

        conn.execute("DELETE FROM ai_messages", [])
            .expect("remove raw history after cache write");
        let second = load_runs(&conn, 50).expect("read cached run summary");
        assert_eq!(second[0].action_counts.opportunity, 1);
        assert_eq!(second[0].token_usage.as_ref().map(|usage| usage.usage.total_tokens), Some(15));
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
    fn usage_dashboard_groups_shanghai_days_and_models() {
        const DAY_MS: i64 = 86_400_000;
        const OFFSET_MS: i64 = 8 * 60 * 60 * 1000;
        let now = 1_800_000_000_000_i64;
        let today_start = (now + OFFSET_MS).div_euclid(DAY_MS) * DAY_MS - OFFSET_MS;
        let conn = Connection::open_in_memory().expect("open usage database");
        conn.execute_batch(
            "CREATE TABLE ai_messages(
               id TEXT PRIMARY KEY,session_id TEXT NOT NULL,role TEXT NOT NULL,
               content TEXT NOT NULL,reasoning TEXT,tool_json TEXT,status TEXT,created_at INTEGER NOT NULL
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

        let dashboard = load_ai_token_usage_dashboard(&conn, now).expect("load usage dashboard");
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
            "okx-news-intelligence",
            true
        )));
    }

    fn scheme_agent(id: &str, scopes: &[&str]) -> AiProfileSubAgent {
        AiProfileSubAgent {
            id: id.to_string(),
            name: format!("Agent {id}"),
            role: "市场分析".to_string(),
            responsibility: "读取证据并输出独立结论".to_string(),
            scopes: scopes.iter().map(|scope| (*scope).to_string()).collect(),
            required: false,
            enabled: true,
        }
    }

    fn test_scheme_input(id: Option<&str>) -> AiAgentSchemeInput {
        AiAgentSchemeInput {
            id: id.map(str::to_string),
            name: "测试方案".to_string(),
            description: "用于测试方案持久化".to_string(),
            agents: vec![
                scheme_agent("market", &["market"]),
                scheme_agent("risk", &["account", "history"]),
            ],
        }
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
        ] {
            assert!(scheme_columns.contains(column), "missing {column}");
        }
    }

    #[test]
    fn agent_schemes_include_stable_builtin_and_persist_user_schemes() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        migrate_ai_automation(&conn).expect("migrate automation schema");

        let builtin = load_agent_schemes(&conn)
            .expect("load builtin schemes")
            .into_iter()
            .next()
            .expect("builtin scheme");
        assert_eq!(builtin.id, BUILTIN_PERPETUAL_DECISION_DESK_ID);
        assert_eq!(builtin.name, "永续合约决策台");
        assert!(builtin.builtin);
        assert_eq!(
            builtin
                .agents
                .iter()
                .map(|agent| agent.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "market-structure",
                "intelligence-flow",
                "account-risk",
                "contrarian-review"
            ]
        );

        let saved = save_agent_scheme_with_conn(
            &conn,
            test_scheme_input(Some("scheme-user-decision-desk")),
        )
        .expect("save user scheme");
        assert!(!saved.builtin);
        assert_eq!(saved.agents.len(), 2);
        assert!(saved.agents[1].scopes.contains(&"account".to_string()));
        let schemes = load_agent_schemes(&conn).expect("load all schemes");
        assert_eq!(schemes.len(), 2);
        assert_eq!(schemes[1].id, "scheme-user-decision-desk");
    }

    #[test]
    fn builtin_schemes_cannot_be_overwritten_or_deleted() {
        let mut conn = Connection::open_in_memory().expect("open in-memory database");
        migrate_ai_automation(&conn).expect("migrate automation schema");
        let error = save_agent_scheme_with_conn(
            &conn,
            test_scheme_input(Some(BUILTIN_PERPETUAL_DECISION_DESK_ID)),
        )
        .expect_err("builtin scheme must not be overwritten");
        assert!(error.contains("不能覆盖"));
        let error = delete_agent_scheme_with_conn(&mut conn, BUILTIN_PERPETUAL_DECISION_DESK_ID)
            .expect_err("builtin scheme must not be deleted");
        assert!(error.contains("不能删除"));
    }

    #[test]
    fn deleting_user_scheme_clears_profile_reference_but_keeps_frozen_agents() {
        let mut conn = Connection::open_in_memory().expect("open in-memory database");
        migrate_ai_automation(&conn).expect("migrate automation schema");
        let saved =
            save_agent_scheme_with_conn(&conn, test_scheme_input(Some("scheme-delete-test")))
                .expect("save user scheme");
        let agents_json = to_json(&saved.agents).expect("serialize agents");
        insert_test_profile(&conn, "profile-scheme", "custom", 2, &agents_json);
        conn.execute(
            "UPDATE ai_agent_profiles SET multi_agent_scheme_id=?1 WHERE id='profile-scheme'",
            params![saved.id],
        )
        .expect("link profile scheme");

        delete_agent_scheme_with_conn(&mut conn, "scheme-delete-test").expect("delete user scheme");
        let (scheme_id, persisted_agents) = conn
            .query_row(
                "SELECT multi_agent_scheme_id,multi_agents_json FROM ai_agent_profiles
                 WHERE id='profile-scheme'",
                [],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
            )
            .expect("load profile collaboration");
        assert_eq!(scheme_id, None);
        assert_eq!(persisted_agents, agents_json);
    }

    #[test]
    fn account_scoped_custom_agent_requires_a_profile_account() {
        let profile = serde_json::from_value::<AiAgentProfileInput>(json!({
            "name": "账户风险分析",
            "symbols": ["BTC-USDT-SWAP"],
            "multiAgentMode": "custom",
            "multiAgents": [
                {
                    "id": "market",
                    "name": "市场结构",
                    "role": "market_structure",
                    "responsibility": "分析价格结构",
                    "scopes": ["market"],
                    "required": true,
                    "enabled": true
                },
                {
                    "id": "risk",
                    "name": "账户风险",
                    "role": "account_risk",
                    "responsibility": "分析账户和持仓风险",
                    "scopes": ["account", "history"],
                    "required": true,
                    "enabled": true
                }
            ]
        }))
        .expect("deserialize profile");
        let error = normalize_profile(profile).expect_err("account scope must require account");
        assert!(error.contains("必须绑定账户"));
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
                "okx-news-intelligence",
                "okx-smart-money-analysis",
                "custom-risk-check",
            ]
        );
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

    #[test]
    fn custom_enabled_agents_cannot_exceed_profile_limit() {
        let profile = serde_json::from_value::<AiAgentProfileInput>(json!({
            "name": "容量限制",
            "accountId": "account-test",
            "symbols": ["BTC-USDT-SWAP"],
            "multiAgentMode": "custom",
            "multiAgentMaxAgents": 2,
            "multiAgents": [
                { "id": "market", "name": "市场", "role": "market_structure", "responsibility": "市场结构", "scopes": ["market"], "required": true, "enabled": true },
                { "id": "risk", "name": "风险", "role": "account_risk", "responsibility": "账户风险", "scopes": ["account"], "required": true, "enabled": true },
                { "id": "news", "name": "情报", "role": "intelligence_flow", "responsibility": "新闻情报", "scopes": ["intelligence"], "required": false, "enabled": true }
            ]
        }))
        .expect("deserialize profile");
        let error = normalize_profile(profile).expect_err("capacity must be enforced");
        assert!(error.contains("超过本轮上限"));
    }

    #[test]
    fn invalid_custom_agent_json_is_not_silently_loaded_as_empty() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        migrate_ai_automation(&conn).expect("migrate automation schema");
        insert_test_profile(&conn, "profile-invalid", "custom", 4, "{");
        let error = load_profile(&conn, "profile-invalid").expect_err("invalid JSON must fail");
        assert!(error.contains("multi_agents_json"));
    }

    #[test]
    fn persisted_profile_rejects_unknown_multi_agent_mode() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        migrate_ai_automation(&conn).expect("migrate automation schema");
        insert_test_profile(&conn, "profile-invalid-mode", "bogus", 4, "[]");
        let error = load_profile(&conn, "profile-invalid-mode")
            .expect_err("unknown persisted mode must fail");
        assert!(error.contains("多 Agent 模式无效"));
    }

    #[test]
    fn claim_run_rejects_malformed_or_invalid_profile_snapshots() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        migrate_ai_automation(&conn).expect("migrate automation schema");
        set_setting(&conn, "master_enabled", json!(true)).expect("enable automation");
        insert_test_profile(&conn, "profile-test", "off", 4, "[]");

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

        let mut invalid_custom = load_profile(&conn, "profile-test").expect("load profile");
        invalid_custom.multi_agent_mode = "custom".to_string();
        invalid_custom.multi_agents = vec![AiProfileSubAgent {
            id: "market".to_string(),
            name: "市场".to_string(),
            role: "market_structure".to_string(),
            responsibility: "市场结构".to_string(),
            scopes: vec!["market".to_string()],
            required: true,
            enabled: true,
        }];
        let invalid_snapshot = to_json(&invalid_custom).expect("serialize invalid snapshot");
        insert_test_run(
            &conn,
            "run-invalid-custom",
            "profile-test",
            Some(&invalid_snapshot),
        );
        let error = claim_next_run(&conn, 200).expect_err("invalid custom snapshot must fail");
        assert!(error.contains("至少需要启用 2 个"));

        let current = load_profile(&conn, "profile-test").expect("load current profile");
        let mut missing_fields = serde_json::to_value(&current).expect("serialize profile");
        missing_fields
            .as_object_mut()
            .expect("profile object")
            .remove("multiAgentMode");
        let missing_fields = missing_fields.to_string();
        insert_test_run(
            &conn,
            "run-missing-multi-agent-fields",
            "profile-test",
            Some(&missing_fields),
        );
        let error = claim_next_run(&conn, 300).expect_err("missing fields must fail");
        assert!(error.contains("Profile 快照"));

        let mut unknown_mode = current.clone();
        unknown_mode.multi_agent_mode = "bogus".to_string();
        let unknown_mode = to_json(&unknown_mode).expect("serialize unknown mode snapshot");
        insert_test_run(
            &conn,
            "run-unknown-mode",
            "profile-test",
            Some(&unknown_mode),
        );
        let error = claim_next_run(&conn, 400).expect_err("unknown mode must fail");
        assert!(error.contains("模式无效"));

        let mut auto_over_limit = current.clone();
        auto_over_limit.multi_agent_mode = "auto".to_string();
        auto_over_limit.multi_agent_max_agents = 9;
        let auto_over_limit = to_json(&auto_over_limit).expect("serialize auto snapshot");
        insert_test_run(
            &conn,
            "run-auto-over-limit",
            "profile-test",
            Some(&auto_over_limit),
        );
        let error = claim_next_run(&conn, 500).expect_err("auto max must be strict");
        assert!(error.contains("2-8"));

        let mut custom_over_limit = current;
        custom_over_limit.multi_agent_mode = "custom".to_string();
        custom_over_limit.multi_agent_max_agents = 11;
        custom_over_limit.multi_agents = vec![
            scheme_agent("market", &["market"]),
            scheme_agent("history", &["history"]),
        ];
        let custom_over_limit = to_json(&custom_over_limit).expect("serialize custom snapshot");
        insert_test_run(
            &conn,
            "run-custom-over-limit",
            "profile-test",
            Some(&custom_over_limit),
        );
        let error = claim_next_run(&conn, 600).expect_err("custom max must be strict");
        assert!(error.contains("2-10"));
    }

    #[test]
    fn claim_run_without_snapshot_uses_current_profile() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        migrate_ai_automation(&conn).expect("migrate automation schema");
        set_setting(&conn, "master_enabled", json!(true)).expect("enable automation");
        insert_test_profile(&conn, "profile-current", "off", 4, "[]");
        insert_test_run(&conn, "run-current", "profile-current", None);
        let (_, profile, _) = claim_next_run(&conn, 100)
            .expect("claim run")
            .expect("queued run");
        assert_eq!(profile.id, "profile-current");
    }

    #[test]
    fn strict_profile_snapshot_accepts_mode_boundaries() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        migrate_ai_automation(&conn).expect("migrate automation schema");
        insert_test_profile(&conn, "profile-boundary", "off", 4, "[]");
        let current = load_profile(&conn, "profile-boundary").expect("load profile");

        let mut automatic = current.clone();
        automatic.multi_agent_mode = "auto".to_string();
        automatic.multi_agent_max_agents = 8;
        validate_profile_snapshot(automatic).expect("auto boundary is valid");

        let mut custom = current;
        custom.multi_agent_mode = "custom".to_string();
        custom.multi_agent_max_agents = 10;
        custom.multi_agents = (0..10)
            .map(|index| scheme_agent(&format!("agent-{index}"), &["market"]))
            .collect();
        validate_profile_snapshot(custom).expect("custom boundary is valid");
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
        assert!(!normalized_saved.iter().any(|value| value == "strategy_signal"));
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
            }],
            system_prompt: "test".to_string(),
            custom_rules: String::new(),
            enabled_skills: Vec::new(),
            skill_definitions: desic_storage_config::default_ai_skill_definitions(),
            open_agent: true,
            workspace_roots: Vec::new(),
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
}
