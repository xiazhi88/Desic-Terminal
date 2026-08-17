use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    pub enabled: bool,
    pub proxy_type: String,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            proxy_type: "NONE".to_string(),
            host: String::new(),
            port: 0,
            username: None,
            password: None,
        }
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfigSummary {
    pub enabled: bool,
    pub proxy_type: String,
    pub host: String,
    pub port: u16,
    pub url: Option<String>,
    pub username: Option<String>,
    pub auth_configured: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfigUpdate {
    pub enabled: bool,
    pub proxy_type: String,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyTestResult {
    pub ok: bool,
    pub latency_ms: i64,
    pub message: String,
    pub config: ProxyConfigSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SensitiveConfigMigrationResult {
    pub accounts: usize,
    pub ai_configured: bool,
    pub proxy_auth_configured: bool,
    pub migrated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WatchlistConfig {
    pub symbols: Vec<String>,
}

impl Default for WatchlistConfig {
    fn default() -> Self {
        Self {
            symbols: vec!["BTC-USDT-SWAP".to_string()],
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UiPreferencesConfig {
    #[serde(default = "default_ui_language_preference")]
    pub language: String,
    #[serde(default)]
    pub resolved_language: Option<String>,
}

impl Default for UiPreferencesConfig {
    fn default() -> Self {
        Self {
            language: default_ui_language_preference(),
            resolved_language: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPreferencesQuery {
    pub system_locale: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPreferencesUpdate {
    pub language: String,
    pub system_locale: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UiPreferencesSummary {
    pub language: String,
    pub resolved_language: String,
}

fn default_ui_language_preference() -> String {
    "system".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub provider: Option<String>,
    pub model: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    pub stream: Option<bool>,
    #[serde(default = "default_ai_permission_mode")]
    pub permission_mode: String,
    #[serde(default = "default_ai_reasoning_depth")]
    pub reasoning_depth: String,
    #[serde(default)]
    pub active_model_id: String,
    #[serde(default)]
    pub models: Vec<AiModelConfig>,
    #[serde(default = "default_ai_system_prompt")]
    pub system_prompt: String,
    #[serde(default)]
    pub custom_rules: String,
    #[serde(default = "default_ai_enabled_skills")]
    pub enabled_skills: Vec<String>,
    #[serde(default = "default_ai_skill_definitions")]
    pub skill_definitions: Vec<AiSkillDefinition>,
    #[serde(default = "default_ai_open_agent")]
    pub open_agent: bool,
    #[serde(default)]
    pub workspace_roots: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiModelConfig {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_ai_permission_mode")]
    pub permission_mode: String,
    #[serde(default = "default_ai_reasoning_depth")]
    pub reasoning_depth: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiSkillDefinition {
    pub id: String,
    pub name: String,
    pub description: String,
    pub rules: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub builtin: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigSummary {
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub api_key_masked: String,
    pub stream: bool,
    pub configured: bool,
    pub permission_mode: String,
    pub reasoning_depth: String,
    pub active_model_id: String,
    pub models: Vec<AiModelConfigSummary>,
    pub system_prompt: String,
    pub custom_rules: String,
    pub enabled_skills: Vec<String>,
    pub skill_definitions: Vec<AiSkillDefinition>,
    pub open_agent: bool,
    pub workspace_roots: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiLocalCliStatus {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub authenticated: bool,
    pub version: Option<String>,
    pub auth_method: Option<String>,
    pub login_command: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiLocalAuthStatus {
    pub providers: Vec<AiLocalCliStatus>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiModelConfigSummary {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub api_key_masked: String,
    pub configured: bool,
    pub permission_mode: String,
    pub reasoning_depth: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigUpdate {
    pub provider: Option<String>,
    pub model: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub stream: Option<bool>,
    pub permission_mode: Option<String>,
    pub reasoning_depth: Option<String>,
    pub active_model_id: Option<String>,
    pub models: Option<Vec<AiModelConfigUpdate>>,
    pub system_prompt: Option<String>,
    pub custom_rules: Option<String>,
    pub enabled_skills: Option<Vec<String>>,
    pub skill_definitions: Option<Vec<AiSkillDefinition>>,
    pub open_agent: Option<bool>,
    pub workspace_roots: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelConfigUpdate {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub permission_mode: Option<String>,
    pub reasoning_depth: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConnectionTestResult {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model: String,
}

fn default_ai_permission_mode() -> String {
    "advisor".to_string()
}

fn default_ai_open_agent() -> bool {
    true
}

fn default_ai_reasoning_depth() -> String {
    "medium".to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DefaultAiConfigFile {
    system_prompt: Vec<String>,
    skill_definitions: Vec<DefaultAiSkillFile>,
}

#[derive(Debug, Deserialize)]
struct DefaultAiSkillFile {
    id: String,
    name: String,
    description: String,
    rules: String,
    content: Vec<String>,
    builtin: bool,
}

fn shared_default_ai_config() -> &'static DefaultAiConfigFile {
    static DEFAULT_AI_CONFIG: OnceLock<DefaultAiConfigFile> = OnceLock::new();
    DEFAULT_AI_CONFIG.get_or_init(|| {
        serde_json::from_str(include_str!("../../../../shared/default-ai-config.json"))
            .expect("shared default AI config must be valid JSON")
    })
}

fn legacy_default_ai_system_prompt() -> String {
    [
        "你是 Desic Terminal 桌面交易终端中的 AI 交易助手。",
        "使用中文回答，表达简洁、准确、可执行。",
        "交易相关内容必须区分事实、推断和建议，并提示风险。",
        "不要声称已经执行未通过工具完成的动作。",
        "禁止泄露完整 API Key、绕过权限、修改账号/代理/API Key 配置。",
        "当用户问题缺少关键条件时，先说明缺口，再给出可验证的下一步。",
    ]
    .join("\n")
}

pub fn default_ai_system_prompt() -> String {
    shared_default_ai_config().system_prompt.join("\n")
}

pub fn migrate_default_ai_system_prompt(value: String) -> String {
    if value == legacy_default_ai_system_prompt() {
        default_ai_system_prompt()
    } else {
        value
    }
}

fn default_ai_enabled_skills() -> Vec<String> {
    vec![
        "trading-philosophy".to_string(),
        "okx-news-intelligence".to_string(),
        "okx-smart-money-analysis".to_string(),
    ]
}

pub fn default_ai_skill_definitions() -> Vec<AiSkillDefinition> {
    shared_default_ai_config()
        .skill_definitions
        .iter()
        .map(|skill| AiSkillDefinition {
            id: skill.id.clone(),
            name: skill.name.clone(),
            description: skill.description.clone(),
            rules: skill.rules.clone(),
            content: skill.content.join("\n"),
            builtin: skill.builtin,
        })
        .collect()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticExportResult {
    pub path: String,
    pub size_bytes: u64,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FrontendLogEntry {
    pub level: String,
    pub message: String,
    pub error: Option<String>,
    pub context: Option<serde_json::Value>,
    pub timestamp: i64,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StorageMaintenanceResult {
    pub database_path: String,
    pub database_bytes: u64,
    pub wal_bytes: u64,
    pub wal_bytes_before: u64,
    pub reusable_bytes: u64,
    pub schema_version: i64,
    pub rows: HashMap<String, i64>,
    pub kline_ranges: Vec<KlineDataRange>,
    pub deleted_kline_sync_runs: usize,
    pub deleted_ai_messages: usize,
    pub deleted_intelligence_rows: HashMap<String, usize>,
    /// Backtest runs whose per-bar equity detail was dropped. Their metrics and
    /// summary stay queryable; only the replayable series is archived.
    pub archived_backtest_series: usize,
    pub finished_at: i64,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StorageStatusResult {
    pub database_path: String,
    pub database_bytes: u64,
    pub wal_bytes: u64,
    pub reusable_bytes: u64,
    pub schema_version: i64,
    pub last_maintenance_at: Option<i64>,
    pub rows: HashMap<String, i64>,
    pub kline_ranges: Vec<KlineDataRange>,
    pub checked_at: i64,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KlineDataRange {
    pub symbol: String,
    pub interval: String,
    pub first_time: Option<i64>,
    pub last_time: Option<i64>,
    pub count: i64,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountsConfig {
    pub accounts: Vec<LocalAccount>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalAccount {
    pub id: String,
    pub name: String,
    pub exchange: String,
    pub environment: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub okx_uid: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub okx_main_uid: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub secret_key: String,
    #[serde(default)]
    pub passphrase: String,
    pub permissions: Permissions,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Permissions {
    pub read: bool,
    pub trade: bool,
    pub withdraw: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_defaults_to_direct_connection() {
        let config = ProxyConfig::default();
        assert!(!config.enabled);
        assert_eq!(config.proxy_type, "NONE");
        assert!(config.host.is_empty());
        assert_eq!(config.port, 0);
    }

    fn skill_text_fingerprint(skill: &AiSkillDefinition) -> u64 {
        let mut hash = 0xcbf2_9ce4_8422_2325_u64;
        for value in [&skill.description, &skill.rules, &skill.content] {
            for byte in value.as_bytes() {
                hash ^= u64::from(*byte);
                hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
            }
        }
        hash
    }

    #[test]
    fn local_account_uid_fields_are_backward_compatible_and_use_camel_case() {
        let legacy = serde_json::json!({
            "id": "account-legacy",
            "name": "Legacy",
            "exchange": "okx",
            "environment": "demo",
            "apiKey": "placeholder-api-key",
            "secretKey": "placeholder-secret-key",
            "passphrase": "placeholder-passphrase",
            "permissions": { "read": true, "trade": true, "withdraw": false }
        });
        let mut account: LocalAccount =
            serde_json::from_value(legacy).expect("legacy account must remain readable");
        assert!(account.okx_uid.is_empty());
        assert!(account.okx_main_uid.is_empty());

        account.okx_uid = "placeholder-uid".to_string();
        account.okx_main_uid = "placeholder-main-uid".to_string();
        let persisted = serde_json::to_value(account).expect("serialize account identity");
        assert_eq!(persisted["okxUid"], "placeholder-uid");
        assert_eq!(persisted["okxMainUid"], "placeholder-main-uid");
    }

    #[test]
    fn fixed_skill_requires_fractional_contract_and_margin_precheck_rules() {
        let fixed = default_ai_skill_definitions()
            .into_iter()
            .find(|skill| skill.id == "desic-core-operations")
            .expect("fixed skill");

        for expected in [
            "0.01 contracts must never be rounded up to 1 contract",
            "effectiveExposureMultiple = notional exposure / USDT equity",
            "effectiveExposureMultiple=0.4758X",
            "This ratio alone must not be described as high risk",
            "trade.precheck returns blocked=false, describe the account as feasible",
            "trade.evaluatePlan is a deterministic local calculation",
            "finalDecision.accountAssessment quotes the corresponding blocker verbatim",
        ] {
            assert!(
                fixed.content.contains(expected),
                "missing fixed rule: {expected}"
            );
        }
    }

    #[test]
    fn cost_aware_trade_rules_separate_facts_from_editable_judgment() {
        let definitions = default_ai_skill_definitions();
        let fixed = definitions
            .iter()
            .find(|skill| skill.id == "desic-core-operations")
            .expect("fixed skill");
        let philosophy = definitions
            .iter()
            .find(|skill| skill.id == "trading-philosophy")
            .expect("trading philosophy");

        for expected in [
            "estimatedNetProfitAtTarget",
            "feeDragPctOfGrossProfit",
            "netRewardRiskRatio",
            "it does not change notional, absolute fees",
            "Never present gross target profit as the expected net payoff",
            "prefer a resting non-marketable ordinary limit order",
            "a marketable limit can still pay taker fees",
        ] {
            assert!(
                fixed.content.contains(expected),
                "missing fixed cost rule: {expected}"
            );
        }
        for expected in [
            "directionally plausible setup can still be economically unattractive",
            "target is close to the fee-adjusted break-even price",
            "higher leverage does not improve net profit",
            "maker-fee savings improve net expectancy",
            "fee treatment must never be promised",
        ] {
            assert!(
                philosophy.content.contains(expected),
                "missing editable cost judgment: {expected}"
            );
        }
    }

    #[test]
    fn position_management_rules_cover_unprotected_positions_and_hedges() {
        let definitions = default_ai_skill_definitions();
        let fixed = definitions
            .iter()
            .find(|skill| skill.id == "desic-core-operations")
            .expect("fixed skill");
        let philosophy = definitions
            .iter()
            .find(|skill| skill.id == "trading-philosophy")
            .expect("trading philosophy");

        for expected in [
            "never silently ignore an unprotected position",
            "intent=close",
            "takeProfit/stopLoss fields attach only to a new open order",
            "opening the opposite direction while a position already exists is a hedge",
            "unwind or invalidation condition",
        ] {
            assert!(
                fixed.content.contains(expected),
                "missing fixed position-management rule: {expected}"
            );
        }
        for expected in [
            "Existing exposure is a live decision",
            "An unprotected position requires an explicit hold-and-exit plan",
            "Do not create an accidental hedge",
        ] {
            assert!(
                philosophy.content.contains(expected),
                "missing editable position-management judgment: {expected}"
            );
        }
    }

    #[test]
    fn default_skills_include_every_required_skill() {
        let enabled = default_ai_enabled_skills();
        assert_eq!(
            enabled,
            vec![
                "trading-philosophy",
                "okx-news-intelligence",
                "okx-smart-money-analysis"
            ]
        );
        let definitions = default_ai_skill_definitions();
        for id in [
            "desic-core-operations",
            "trading-philosophy",
            "okx-news-intelligence",
            "okx-smart-money-analysis",
        ] {
            let skill = definitions
                .iter()
                .find(|skill| skill.id == id)
                .unwrap_or_else(|| panic!("missing required skill {id}"));
            assert!(skill.builtin, "required skill must be built in: {id}");
        }
    }

    #[test]
    fn builtin_skill_baselines_match_the_promoted_published_versions() {
        let definitions = default_ai_skill_definitions();
        let expected = [
            ("desic-core-operations", 0xf9a7_b003_17c7_a4e9_u64),
            ("trading-philosophy", 0x6d82_4f43_18eb_a276_u64),
            ("okx-news-intelligence", 0x790c_faa6_cc57_d766_u64),
            ("okx-smart-money-analysis", 0x18d3_b51e_1a97_ffe3_u64),
        ];

        for (id, fingerprint) in expected {
            let skill = definitions
                .iter()
                .find(|skill| skill.id == id)
                .unwrap_or_else(|| panic!("missing promoted built-in baseline {id}"));
            assert!(
                skill.builtin,
                "promoted baseline must remain built in: {id}"
            );
            assert_eq!(
                skill_text_fingerprint(skill),
                fingerprint,
                "built-in baseline changed without an intentional promotion: {id}"
            );
        }
    }

    #[test]
    fn trading_philosophy_keeps_ai_autonomy_and_evidence_limits() {
        let skill = default_ai_skill_definitions()
            .into_iter()
            .find(|skill| skill.id == "trading-philosophy")
            .expect("trading philosophy");

        for expected in [
            "The AI may select timeframes, indicators, structure, order flow, and intelligence evidence",
            "There is no universal minimum reward-to-risk ratio or per-trade risk percentage",
            "Evaluate decision quality, execution quality, and random outcome separately",
        ] {
            assert!(
                skill.rules.contains(expected) || skill.content.contains(expected),
                "missing trading philosophy principle: {expected}"
            );
        }
        assert!(!skill
            .content
            .contains("price up plus OI up proves new longs"));
    }

    /// Under on-demand loading a Skill's description *is* its routing signal, so
    /// it must describe the work, not who requested it. Phrasing a trigger as
    /// "when the user asks" makes background Runs skip the Skill correctly but
    /// uselessly, because no one is asking in a scheduled scan.
    #[test]
    fn loadable_skill_descriptions_describe_work_not_a_requester() {
        for skill in default_ai_skill_definitions() {
            if skill.id == "desic-core-operations" {
                // Always injected as fixed policy; never routed by description.
                continue;
            }
            assert!(
                !skill.description.contains("user asks"),
                "{} routes on a requester instead of the work: {}",
                skill.id,
                skill.description
            );
            assert!(
                !skill.description.trim().is_empty(),
                "{} needs a description to be loadable at all",
                skill.id
            );
        }
    }

    /// The default philosophy must price both sides of a decision. Every clause
    /// here counters a specific one-directional bias: without them the document
    /// only ever supplies reasons to stand aside, so the model can always
    /// justify waiting and never justify acting.
    #[test]
    fn trading_philosophy_prices_the_cost_of_not_acting() {
        let skill = default_ai_skill_definitions()
            .into_iter()
            .find(|skill| skill.id == "trading-philosophy")
            .expect("trading philosophy");
        let text = format!("{}\n{}", skill.rules, skill.content);

        for expected in [
            // Unknowable must not collapse into refusing to judge.
            "unknowable is not unjudgeable",
            "directional lean",
            // Abstention is not a free default.
            "Waiting also has a cost",
            // Waiting must be a falsifiable plan, not an open deferral.
            "time or event limit",
            // Deficient evidence and irreducible uncertainty are different.
            "irreducible uncertainty as a reason to defer",
            // Absence has to be reviewable, or the bias returns through review.
            "carries the same weight as a loss",
            "systematic absence",
        ] {
            assert!(
                text.contains(expected),
                "philosophy lost its counterweight to one-sided caution: {expected}"
            );
        }
    }

    /// Every factual constraint that stays correct regardless of the user's
    /// trading style must live in the fixed skill, because `trading-philosophy`
    /// is fully user-editable and may legitimately be rewritten or emptied.
    #[test]
    fn factual_constraints_live_in_the_fixed_skill_not_the_editable_philosophy() {
        let definitions = default_ai_skill_definitions();
        let fixed = definitions
            .iter()
            .find(|skill| skill.id == "desic-core-operations")
            .expect("fixed skill");
        let philosophy = definitions
            .iter()
            .find(|skill| skill.id == "trading-philosophy")
            .expect("trading philosophy");

        for expected in [
            "cannot identify new longs, new shorts, covering, or stops",
            "not proof of participant intent",
            "do not invent a contract size",
            "leverage changes estimated initial margin and therefore cost and return percentages relative to margin",
            "infer participant intent solely from OI",
        ] {
            assert!(
                fixed.rules.contains(expected) || fixed.content.contains(expected),
                "factual constraint must be in the fixed skill: {expected}"
            );
            assert!(
                !philosophy.rules.contains(expected)
                    && !philosophy.content.contains(expected),
                "factual constraint must not depend on the editable philosophy: {expected}"
            );
        }
    }

    #[test]
    fn default_prompt_and_skills_are_english() {
        let definitions = default_ai_skill_definitions();
        let text = std::iter::once(default_ai_system_prompt())
            .chain(
                definitions
                    .into_iter()
                    .flat_map(|skill| [skill.description, skill.rules, skill.content].into_iter()),
            )
            .collect::<Vec<_>>()
            .join("\n");

        assert!(
            !text
                .chars()
                .any(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch)),
            "default AI configuration must not contain CJK text"
        );
    }

    #[test]
    fn untouched_legacy_prompt_migrates_without_overwriting_custom_text() {
        assert_eq!(
            migrate_default_ai_system_prompt(legacy_default_ai_system_prompt()),
            default_ai_system_prompt()
        );
        assert_eq!(
            migrate_default_ai_system_prompt("Custom prompt".to_string()),
            "Custom prompt"
        );
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub id: String,
    pub name: String,
    pub exchange: String,
    pub environment: String,
    pub api_key_masked: String,
    pub permissions: Permissions,
}
