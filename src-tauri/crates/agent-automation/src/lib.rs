mod agent_draft;
mod agents;
mod builtin_bodies;
mod draft_content;
mod usage;

pub use agent_draft::{
    agent_draft_few_shot_messages, agent_draft_from_role_json, agent_draft_system_prompt,
    build_agent_draft_user_prompt, draft_agent_id, draft_summary, normalize_agent_create_role,
    parse_agent_role_json, validate_agent_source_for_save, AiAgentDraftOutcome,
    AGENT_DRAFT_DESCRIPTION_PLACEHOLDER, AGENT_DRAFT_KNOWN_SKILLS,
    AGENT_DRAFT_NAME_LINE_PLACEHOLDER, AI_AGENT_DRAFT_FALLBACK_SKELETON,
    AI_AGENT_DRAFT_FEW_SHOT_A, AI_AGENT_DRAFT_FEW_SHOT_B, AI_AGENT_DRAFT_FEW_SHOTS,
    AI_AGENT_DRAFT_SYSTEM_PROMPT, AI_AGENT_DRAFT_USER_PROMPT,
};
pub use agents::{
    agent_role_slug, agent_slug, build_agent_body, builtin_agent_definition,
    builtin_agent_definitions, builtin_agent_ids, builtin_agent_markdown, builtin_agent_spec,
    current_time_ms as agent_current_time_ms, custom_agent_from_legacy, is_builtin_agent_id,
    is_recommended_agent_role, is_valid_agent_id, is_valid_agent_role, legacy_agent_id_alias,
    normalize_agent_envelope, normalize_agent_source, normalize_enabled_agent_ids,
    default_enabled_agent_ids, deprecated_builtin_agent_ids, drop_removed_agent_ids,
    is_removed_builtin_agent_id, removed_builtin_agent, removed_builtin_agent_ids,
    removed_builtin_agent_labels, removed_builtin_agent_notice,
    parse_agent_draft_markdown, parse_agent_envelope, parse_agent_markdown,
    plan_legacy_agent_migration,
    remove_enabled_agent_id, render_agent_skeleton, resolve_agent_envelope,
    render_agent_markdown, resolve_agent_id_alias, resolve_enabled_agents, summarize_agent_body,
    apply_builtin_deprecation, is_deprecated_agent_id, resolve_enabled_agent_selection,
    unique_custom_agent_id, validate_agent_definition, validate_agent_directory_id,
    strip_agent_body_wrappers, validate_agent_file, validate_agent_reference_path,
    validate_agent_scope_values,
    AgentBodyParts, AiAgentDefinition, EnabledAgentSelection,
    AiAgentDetail, AiAgentSummary, BuiltinAgentSpec, LegacyAgentMigrationInput,
    LegacyAgentMigrationPlan, AGENT_BUILTIN_CREATED_AT_MS, AGENT_BODY_SECTION_DUTIES,
    AGENT_BODY_SECTION_GAP, AGENT_BODY_SECTION_IDENTITY, AGENT_BODY_SECTION_METHOD,
    AGENT_BODY_SECTION_OUTPUT, AGENT_ENVELOPES, AGENT_ENVELOPE_RISK, AGENT_ENVELOPE_STANDARD,
    AGENT_FILE_NAME, AGENT_ID_PATTERN_HINT, AGENT_MAX_FILE_BYTES, AGENT_NAME_MAX_CHARS,
    AGENT_NAME_MIN_CHARS, AGENT_REFERENCES_DIR, AGENT_ROLE_ENUM, AGENT_ROLE_PATTERN_HINT,
    AGENT_SCOPES, AGENT_SCOPE_ACCOUNT, AGENT_SCOPE_DERIVATIVES, AGENT_SCOPE_HISTORY,
    AGENT_SCOPE_INTELLIGENCE, AGENT_SCOPE_MARKET, AGENT_SOURCES, AGENT_SOURCE_AI,
    AGENT_SOURCE_BUILTIN, AGENT_SOURCE_CUSTOM, AGENT_SUMMARY_MAX_CHARS, BUILTIN_AGENT_SPECS,
    REMOVED_BUILTIN_AGENTS, RemovedBuiltinAgent,
};
pub use usage::{
    build_ai_usage_summary, AiTokenUsage, AiUsageCoverage, AiUsageQuality, AiUsageSummary,
    AI_USAGE_SCHEMA_VERSION,
};

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};

pub const ADVISOR_MODE: &str = "advisor";
pub const COPILOT_MODE: &str = "copilot";
pub const LIMITED_AUTO_MODE: &str = "limited_auto";

/// DEPRECATED（契约 C3 迁移表 / plan v3 §10）：旧 `ai_agent_profiles.multi_agent_mode`
/// 列只在迁移期被读取。v3 用 Profile 的 `enabledAgentIds` 勾选名单表达"是否协作"
/// （空数组 = 主 Agent 独立完成），不再有主开关、后端编排器与专家来源维度。
/// 不要在任何新代码路径里依赖这些常量。
pub const MULTI_AGENT_OFF_MODE: &str = "off";
pub const MULTI_AGENT_AUTO_MODE: &str = "auto";
pub const MULTI_AGENT_CUSTOM_MODE: &str = "custom";

pub fn normalize_permission_mode(value: Option<&str>) -> &'static str {
    match value.unwrap_or_default().trim() {
        LIMITED_AUTO_MODE => LIMITED_AUTO_MODE,
        COPILOT_MODE | "approval" | "full" => COPILOT_MODE,
        ADVISOR_MODE | "readonly" => ADVISOR_MODE,
        _ => ADVISOR_MODE,
    }
}

/// DEPRECATED：仅用于读旧列做迁移（off/auto/custom）。
/// INFO (DES-27): trim + ASCII lowercase to match the JS side's `normalize*`
/// behavior. 新代码请使用 `plan_legacy_agent_migration`。
pub fn normalize_multi_agent_mode(value: Option<&str>) -> &'static str {
    match value.unwrap_or_default().trim().to_ascii_lowercase().as_str() {
        MULTI_AGENT_AUTO_MODE => MULTI_AGENT_AUTO_MODE,
        MULTI_AGENT_CUSTOM_MODE => MULTI_AGENT_CUSTOM_MODE,
        MULTI_AGENT_OFF_MODE => MULTI_AGENT_OFF_MODE,
        _ => MULTI_AGENT_OFF_MODE,
    }
}

/// 旧 Profile 自定义子 Agent（`multi_agents_json` / `ai_agent_schemes.agents_json`）。
/// v3 起**只用于迁移读取**：运行时真相源是 Agent 库 frontmatter
/// （`AiAgentDefinition`），不再有子 Agent 名单校验与并发上限。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiProfileSubAgent {
    pub id: String,
    pub name: String,
    pub role: String,
    pub responsibility: String,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub enabled: bool,
}

/// 后台 Run 决策措辞（保留 P2a 的诚实口径，v3 简化为两分支）：策划者只有主 Agent，
/// 专家是否上场由 Profile 勾选名单决定，专家报告是运行中实际收到的只读证据。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MultiAgentDecisionWording {
    pub analysis_owner: &'static str,
    pub confirmed_by: &'static str,
    pub rerun_workflow: &'static str,
}

/// `collaboration_enabled == false`（勾选名单为空）时行为与今天的 `off` 完全一致。
pub fn enabled_agents_decision_wording(
    collaboration_enabled: bool,
    chinese: bool,
) -> MultiAgentDecisionWording {
    if !collaboration_enabled {
        return if chinese {
            MultiAgentDecisionWording {
                analysis_owner: "由主 Agent 独立完成证据分析并决定是否形成交易候选",
                confirmed_by: "本轮主 Agent 分析",
                rerun_workflow: "重新运行当前 Profile",
            }
        } else {
            MultiAgentDecisionWording {
                analysis_owner:
                    "the main Agent independently analyzes the evidence and decides whether to form a trade candidate",
                confirmed_by: "this run's main-Agent analysis",
                rerun_workflow: "rerunning the current Profile",
            }
        };
    }
    if chinese {
        MultiAgentDecisionWording {
            analysis_owner:
                "由主 Agent 主导证据分析并决定是否形成交易候选，专家意见以本轮实际收到的专家报告为准",
            confirmed_by: "本轮主 Agent 分析（专家意见以本轮实际收到的专家报告为准）",
            rerun_workflow: "重新运行当前 Profile",
        }
    } else {
        MultiAgentDecisionWording {
            analysis_owner:
                "the main Agent leads the evidence analysis and decides whether to form a trade candidate; expert opinions count only through expert reports actually received this run",
            confirmed_by:
                "this run's main-Agent analysis (expert opinions count only through expert reports actually received)",
            rerun_workflow: "rerunning the current Profile",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WakeCondition {
    Timer {
        #[serde(default)]
        at_ms: Option<i64>,
        #[serde(default)]
        interval_minutes: Option<u32>,
    },
    PriceCross {
        inst_id: String,
        direction: String,
        price: f64,
    },
    PriceChangePct {
        inst_id: String,
        window_minutes: u32,
        direction: String,
        threshold_pct: f64,
    },
    CandleVolumeRatio {
        inst_id: String,
        #[serde(default = "default_bar")]
        bar: String,
        #[serde(default = "default_volume_lookback")]
        lookback: usize,
        ratio: f64,
    },
    FundingRateThreshold {
        inst_id: String,
        direction: String,
        rate: f64,
    },
    OrderbookImbalance {
        inst_id: String,
        #[serde(default = "default_depth")]
        depth: usize,
        direction: String,
        ratio: f64,
    },
    OrderStateChanged {
        #[serde(default)]
        account_id: Option<String>,
        #[serde(default)]
        inst_id: Option<String>,
        #[serde(default)]
        states: Vec<String>,
    },
    PositionChanged {
        #[serde(default)]
        account_id: Option<String>,
        #[serde(default)]
        inst_id: Option<String>,
    },
    OpportunityStateChanged {
        #[serde(default)]
        opportunity_id: Option<String>,
        #[serde(default)]
        states: Vec<String>,
    },
    EpisodeClosed {
        #[serde(default)]
        account_id: Option<String>,
        #[serde(default)]
        inst_id: Option<String>,
    },
    OpenInterestAnomaly {
        #[serde(default)]
        inst_id: Option<String>,
    },
    TakerFlowImbalance {
        #[serde(default)]
        inst_id: Option<String>,
    },
    CrowdingDivergence {
        #[serde(default)]
        inst_id: Option<String>,
    },
    FundingExtreme {
        #[serde(default)]
        inst_id: Option<String>,
    },
    LiquidationCluster {
        #[serde(default)]
        inst_id: Option<String>,
    },
    ImportantNewsEvent {
        #[serde(default)]
        inst_id: Option<String>,
    },
    SentimentReversal {
        #[serde(default)]
        inst_id: Option<String>,
    },
    SmartMoneyChange {
        #[serde(default)]
        inst_id: Option<String>,
    },
    MacroEventWindow {
        #[serde(default)]
        inst_id: Option<String>,
    },
}

fn default_bar() -> String {
    "5m".to_string()
}

fn default_volume_lookback() -> usize {
    20
}

fn default_depth() -> usize {
    5
}

#[derive(Debug, Clone, Default)]
pub struct WakeMarketState {
    pub now_ms: i64,
    pub prices: HashMap<String, f64>,
    pub previous_prices: HashMap<String, f64>,
    pub price_changes_pct: HashMap<(String, u32), f64>,
    pub candle_volume_ratios: HashMap<(String, String, usize), f64>,
    pub funding_rates: HashMap<String, f64>,
    pub orderbook_imbalances: HashMap<(String, usize), f64>,
    pub domain_events: Vec<DomainEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DomainEvent {
    pub event_type: String,
    pub account_id: Option<String>,
    pub inst_id: Option<String>,
    pub opportunity_id: Option<String>,
    pub episode_id: Option<String>,
    pub state: Option<String>,
    pub occurred_at: i64,
}

pub fn evaluate_condition(
    condition: &WakeCondition,
    state: &WakeMarketState,
    created_at_ms: i64,
    last_triggered_at_ms: Option<i64>,
) -> bool {
    match condition {
        WakeCondition::Timer {
            at_ms,
            interval_minutes,
        } => {
            if let Some(at) = at_ms {
                return state.now_ms >= *at
                    && last_triggered_at_ms.map(|last| last < *at).unwrap_or(true);
            }
            let interval_ms = i64::from(interval_minutes.unwrap_or(1).max(1)) * 60_000;
            state
                .now_ms
                .saturating_sub(last_triggered_at_ms.unwrap_or(created_at_ms))
                >= interval_ms
        }
        WakeCondition::PriceCross {
            inst_id,
            direction,
            price,
        } => {
            let Some(current) = state.prices.get(inst_id) else {
                return false;
            };
            let Some(previous) = state.previous_prices.get(inst_id) else {
                return false;
            };
            match direction.as_str() {
                "down" | "below" => *previous > *price && *current <= *price,
                _ => *previous < *price && *current >= *price,
            }
        }
        WakeCondition::PriceChangePct {
            inst_id,
            window_minutes,
            direction,
            threshold_pct,
        } => {
            let Some(change) = state
                .price_changes_pct
                .get(&(inst_id.clone(), *window_minutes))
            else {
                return false;
            };
            match direction.as_str() {
                "down" | "below" => *change <= -threshold_pct.abs(),
                "absolute" => change.abs() >= threshold_pct.abs(),
                _ => *change >= threshold_pct.abs(),
            }
        }
        WakeCondition::CandleVolumeRatio {
            inst_id,
            bar,
            lookback,
            ratio,
        } => state
            .candle_volume_ratios
            .get(&(inst_id.clone(), bar.clone(), *lookback))
            .map(|current| *current >= *ratio)
            .unwrap_or(false),
        WakeCondition::FundingRateThreshold {
            inst_id,
            direction,
            rate,
        } => state
            .funding_rates
            .get(inst_id)
            .map(|current| match direction.as_str() {
                "below" | "down" => *current <= *rate,
                "absolute" => current.abs() >= rate.abs(),
                _ => *current >= *rate,
            })
            .unwrap_or(false),
        WakeCondition::OrderbookImbalance {
            inst_id,
            depth,
            direction,
            ratio,
        } => state
            .orderbook_imbalances
            .get(&(inst_id.clone(), *depth))
            .map(|current| match direction.as_str() {
                "sell" | "ask" | "down" => *current <= 1.0 - *ratio,
                _ => *current >= *ratio,
            })
            .unwrap_or(false),
        WakeCondition::OrderStateChanged {
            account_id,
            inst_id,
            states,
        } => state.domain_events.iter().any(|event| {
            event.event_type == "order_state_changed"
                && option_matches(account_id, &event.account_id)
                && option_matches(inst_id, &event.inst_id)
                && states_match(states, event.state.as_deref())
        }),
        WakeCondition::PositionChanged {
            account_id,
            inst_id,
        } => state.domain_events.iter().any(|event| {
            event.event_type == "position_changed"
                && option_matches(account_id, &event.account_id)
                && option_matches(inst_id, &event.inst_id)
        }),
        WakeCondition::OpportunityStateChanged {
            opportunity_id,
            states,
        } => state.domain_events.iter().any(|event| {
            event.event_type == "opportunity_state_changed"
                && option_matches(opportunity_id, &event.opportunity_id)
                && states_match(states, event.state.as_deref())
        }),
        WakeCondition::EpisodeClosed {
            account_id,
            inst_id,
        } => state.domain_events.iter().any(|event| {
            event.event_type == "episode_closed"
                && option_matches(account_id, &event.account_id)
                && option_matches(inst_id, &event.inst_id)
        }),
        WakeCondition::OpenInterestAnomaly { inst_id } => {
            intelligence_event_matches(&state.domain_events, "open_interest_anomaly", inst_id)
        }
        WakeCondition::TakerFlowImbalance { inst_id } => {
            intelligence_event_matches(&state.domain_events, "taker_flow_imbalance", inst_id)
        }
        WakeCondition::CrowdingDivergence { inst_id } => {
            intelligence_event_matches(&state.domain_events, "crowding_divergence", inst_id)
        }
        WakeCondition::FundingExtreme { inst_id } => {
            intelligence_event_matches(&state.domain_events, "funding_extreme", inst_id)
        }
        WakeCondition::LiquidationCluster { inst_id } => {
            intelligence_event_matches(&state.domain_events, "liquidation_cluster", inst_id)
        }
        WakeCondition::ImportantNewsEvent { inst_id } => {
            intelligence_event_matches(&state.domain_events, "important_news_event", inst_id)
        }
        WakeCondition::SentimentReversal { inst_id } => {
            intelligence_event_matches(&state.domain_events, "sentiment_reversal", inst_id)
        }
        WakeCondition::SmartMoneyChange { inst_id } => {
            intelligence_event_matches(&state.domain_events, "smart_money_change", inst_id)
        }
        WakeCondition::MacroEventWindow { inst_id } => {
            intelligence_event_matches(&state.domain_events, "macro_event_window", inst_id)
        }
    }
}

fn intelligence_event_matches(
    events: &[DomainEvent],
    event_type: &str,
    inst_id: &Option<String>,
) -> bool {
    events
        .iter()
        .any(|event| event.event_type == event_type && option_matches(inst_id, &event.inst_id))
}

fn option_matches(expected: &Option<String>, actual: &Option<String>) -> bool {
    expected
        .as_ref()
        .map(|value| actual.as_deref() == Some(value.as_str()))
        .unwrap_or(true)
}

fn states_match(expected: &[String], actual: Option<&str>) -> bool {
    expected.is_empty()
        || actual
            .map(|value| expected.iter().any(|item| item == value))
            .unwrap_or(false)
}

#[derive(Debug, Clone, Copy)]
struct TimedValue {
    at_ms: i64,
    value: f64,
}

#[derive(Debug, Clone, Copy)]
struct CandleValue {
    at_ms: i64,
    volume: f64,
}

#[derive(Default)]
pub struct RollingFeatureCache {
    prices: HashMap<String, VecDeque<TimedValue>>,
    candle_volumes: HashMap<(String, String), VecDeque<CandleValue>>,
    last_prices: HashMap<String, f64>,
}

impl RollingFeatureCache {
    pub fn record_price(&mut self, inst_id: &str, at_ms: i64, price: f64) {
        if !price.is_finite() || price <= 0.0 {
            return;
        }
        let values = self.prices.entry(inst_id.to_string()).or_default();
        if values
            .back()
            .map(|item| item.at_ms == at_ms)
            .unwrap_or(false)
        {
            if let Some(last) = values.back_mut() {
                last.value = price;
            }
        } else {
            values.push_back(TimedValue {
                at_ms,
                value: price,
            });
        }
        let cutoff = at_ms.saturating_sub(24 * 60 * 60 * 1_000);
        while values
            .front()
            .map(|item| item.at_ms < cutoff)
            .unwrap_or(false)
        {
            values.pop_front();
        }
        self.last_prices.insert(inst_id.to_string(), price);
    }

    pub fn previous_price(&self, inst_id: &str) -> Option<f64> {
        self.prices.get(inst_id).and_then(|values| {
            if values.len() < 2 {
                None
            } else {
                values.get(values.len() - 2).map(|item| item.value)
            }
        })
    }

    pub fn current_price(&self, inst_id: &str) -> Option<f64> {
        self.last_prices.get(inst_id).copied()
    }

    pub fn price_change_pct(&self, inst_id: &str, window_minutes: u32, now_ms: i64) -> Option<f64> {
        let values = self.prices.get(inst_id)?;
        let current = values.back()?.value;
        let target = now_ms.saturating_sub(i64::from(window_minutes.max(1)) * 60_000);
        let base = values
            .iter()
            .rev()
            .find(|item| item.at_ms <= target)
            .or_else(|| values.front())?
            .value;
        if base == 0.0 {
            None
        } else {
            Some((current - base) / base * 100.0)
        }
    }

    pub fn record_candle(&mut self, inst_id: &str, bar: &str, at_ms: i64, volume: f64) {
        if !volume.is_finite() || volume < 0.0 {
            return;
        }
        let values = self
            .candle_volumes
            .entry((inst_id.to_string(), bar.to_string()))
            .or_default();
        if let Some(existing) = values.iter_mut().find(|item| item.at_ms == at_ms) {
            existing.volume = volume;
        } else {
            values.push_back(CandleValue { at_ms, volume });
        }
        while values.len() > 500 {
            values.pop_front();
        }
    }

    pub fn candle_volume_ratio(&self, inst_id: &str, bar: &str, lookback: usize) -> Option<f64> {
        let values = self
            .candle_volumes
            .get(&(inst_id.to_string(), bar.to_string()))?;
        let current = values.back()?.volume;
        let take = lookback.max(1).min(values.len().saturating_sub(1));
        if take == 0 {
            return None;
        }
        let sum = values
            .iter()
            .rev()
            .skip(1)
            .take(take)
            .map(|item| item.volume)
            .sum::<f64>();
        let average = sum / take as f64;
        if average <= 0.0 {
            None
        } else {
            Some(current / average)
        }
    }
}

pub fn orderbook_imbalance(bid_sizes: &[f64], ask_sizes: &[f64], depth: usize) -> Option<f64> {
    let limit = depth.max(1);
    let bids = bid_sizes
        .iter()
        .take(limit)
        .copied()
        .filter(|value| value.is_finite())
        .sum::<f64>();
    let asks = ask_sizes
        .iter()
        .take(limit)
        .copied()
        .filter(|value| value.is_finite())
        .sum::<f64>();
    let total = bids + asks;
    if total <= 0.0 {
        None
    } else {
        Some(bids / total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;





    #[test]
    fn decision_wording_tracks_the_enabled_agent_selection() {
        let off = enabled_agents_decision_wording(false, true);
        assert_eq!(off.confirmed_by, "本轮主 Agent 分析");
        assert_eq!(off.rerun_workflow, "重新运行当前 Profile");
        let off_en = enabled_agents_decision_wording(false, false);
        assert_eq!(off_en.confirmed_by, "this run's main-Agent analysis");

        let on = enabled_agents_decision_wording(true, true);
        assert_eq!(
            on.confirmed_by,
            "本轮主 Agent 分析（专家意见以本轮实际收到的专家报告为准）"
        );
        assert!(on.analysis_owner.contains("实际收到的专家报告"));
        let on_en = enabled_agents_decision_wording(true, false);
        assert_eq!(
            on_en.confirmed_by,
            "this run's main-Agent analysis (expert opinions count only through expert reports actually received)"
        );
    }

    #[test]
    fn legacy_modes_migrate_without_granting_auto_trade() {
        assert_eq!(normalize_permission_mode(Some("readonly")), ADVISOR_MODE);
        assert_eq!(normalize_permission_mode(Some("approval")), COPILOT_MODE);
        assert_eq!(normalize_permission_mode(Some("full")), COPILOT_MODE);
        assert_eq!(
            normalize_permission_mode(Some("limited_auto")),
            LIMITED_AUTO_MODE
        );
    }

    #[test]
    fn multi_agent_modes_default_to_off() {
        assert_eq!(normalize_multi_agent_mode(None), MULTI_AGENT_OFF_MODE);
        assert_eq!(
            normalize_multi_agent_mode(Some("unknown")),
            MULTI_AGENT_OFF_MODE
        );
        assert_eq!(
            normalize_multi_agent_mode(Some("auto")),
            MULTI_AGENT_AUTO_MODE
        );
        assert_eq!(
            normalize_multi_agent_mode(Some("custom")),
            MULTI_AGENT_CUSTOM_MODE
        );
    }








    #[test]
    fn price_cross_requires_an_actual_cross() {
        let condition = WakeCondition::PriceCross {
            inst_id: "BTC-USDT-SWAP".to_string(),
            direction: "up".to_string(),
            price: 100.0,
        };
        let mut state = WakeMarketState {
            now_ms: 1,
            ..Default::default()
        };
        state
            .previous_prices
            .insert("BTC-USDT-SWAP".to_string(), 99.0);
        state.prices.insert("BTC-USDT-SWAP".to_string(), 101.0);
        assert!(evaluate_condition(&condition, &state, 0, None));
        state
            .previous_prices
            .insert("BTC-USDT-SWAP".to_string(), 101.0);
        assert!(!evaluate_condition(&condition, &state, 0, None));
    }

    #[test]
    fn rolling_features_calculate_change_and_volume_ratio() {
        let mut cache = RollingFeatureCache::default();
        cache.record_price("BTC", 0, 100.0);
        cache.record_price("BTC", 60_000, 102.0);
        assert_eq!(
            cache
                .price_change_pct("BTC", 1, 60_000)
                .map(|value| value.round()),
            Some(2.0)
        );
        cache.record_candle("BTC", "5m", 0, 10.0);
        cache.record_candle("BTC", "5m", 1, 20.0);
        cache.record_candle("BTC", "5m", 2, 30.0);
        assert_eq!(cache.candle_volume_ratio("BTC", "5m", 2), Some(2.0));
    }

    #[test]
    fn orderbook_imbalance_is_bid_share() {
        assert_eq!(
            orderbook_imbalance(&[3.0, 1.0], &[1.0, 1.0], 2),
            Some(4.0 / 6.0)
        );
    }
}
