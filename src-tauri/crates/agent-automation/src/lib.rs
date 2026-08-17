mod usage;

pub use usage::{
    build_ai_usage_summary, AiTokenUsage, AiUsageCoverage, AiUsageQuality, AiUsageSummary,
    AI_USAGE_SCHEMA_VERSION,
};

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};

pub const ADVISOR_MODE: &str = "advisor";
pub const COPILOT_MODE: &str = "copilot";
pub const LIMITED_AUTO_MODE: &str = "limited_auto";
pub const MULTI_AGENT_OFF_MODE: &str = "off";
pub const MULTI_AGENT_AUTO_MODE: &str = "auto";
pub const MULTI_AGENT_CUSTOM_MODE: &str = "custom";
pub const MULTI_AGENT_MIN_AGENTS: u32 = 2;
pub const MULTI_AGENT_AUTO_MAX_AGENTS: u32 = 8;
pub const MULTI_AGENT_CUSTOM_MAX_AGENTS: u32 = 10;

const PROFILE_SUB_AGENT_SCOPES: [&str; 5] = [
    "market",
    "derivatives",
    "intelligence",
    "account",
    "history",
];

pub fn normalize_permission_mode(value: Option<&str>) -> &'static str {
    match value.unwrap_or_default().trim() {
        LIMITED_AUTO_MODE => LIMITED_AUTO_MODE,
        COPILOT_MODE | "approval" | "full" => COPILOT_MODE,
        ADVISOR_MODE | "readonly" => ADVISOR_MODE,
        _ => ADVISOR_MODE,
    }
}

pub fn normalize_multi_agent_mode(value: Option<&str>) -> &'static str {
    match value.unwrap_or_default().trim() {
        MULTI_AGENT_AUTO_MODE => MULTI_AGENT_AUTO_MODE,
        MULTI_AGENT_CUSTOM_MODE => MULTI_AGENT_CUSTOM_MODE,
        MULTI_AGENT_OFF_MODE => MULTI_AGENT_OFF_MODE,
        _ => MULTI_AGENT_OFF_MODE,
    }
}

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

pub fn normalize_profile_sub_agents(
    mode: &str,
    agents: Vec<AiProfileSubAgent>,
) -> Result<Vec<AiProfileSubAgent>, String> {
    if agents.len() > MULTI_AGENT_CUSTOM_MAX_AGENTS as usize {
        return Err(format!(
            "每个 Profile 最多配置 {} 个子 Agent",
            MULTI_AGENT_CUSTOM_MAX_AGENTS
        ));
    }
    let mut ids = HashSet::new();
    let mut normalized = Vec::with_capacity(agents.len());
    for mut agent in agents {
        agent.id = agent.id.trim().to_string();
        if !valid_profile_sub_agent_id(&agent.id) {
            return Err(format!(
                "子 Agent ID 无效：{}；必须以小写字母开头，只能包含小写字母、数字、-、_，且不超过 32 个字符",
                agent.id
            ));
        }
        if !ids.insert(agent.id.clone()) {
            return Err(format!("子 Agent ID 重复：{}", agent.id));
        }
        agent.name = agent.name.trim().to_string();
        let name_len = agent.name.chars().count();
        if !(1..=40).contains(&name_len) {
            return Err(format!("子 Agent 名称长度必须为 1-40 个字符：{}", agent.id));
        }
        agent.role = agent.role.trim().to_string();
        if agent.role.chars().count() > 60 {
            return Err(format!("子 Agent 角色长度不能超过 60 个字符：{}", agent.id));
        }
        if agent.role.is_empty() {
            agent.role = agent.name.clone();
        }
        agent.responsibility = agent.responsibility.trim().to_string();
        let responsibility_len = agent.responsibility.chars().count();
        if !(1..=500).contains(&responsibility_len) {
            return Err(format!(
                "子 Agent 职责长度必须为 1-500 个字符：{}",
                agent.id
            ));
        }
        let mut scopes = Vec::new();
        let mut seen_scopes = HashSet::new();
        for scope in agent.scopes {
            let scope = scope.trim().to_ascii_lowercase();
            if !PROFILE_SUB_AGENT_SCOPES.contains(&scope.as_str()) {
                return Err(format!(
                    "子 Agent {} 包含不支持的数据范围：{}",
                    agent.id, scope
                ));
            }
            if seen_scopes.insert(scope.clone()) {
                scopes.push(scope);
            }
        }
        if scopes.is_empty() {
            return Err(format!("子 Agent {} 至少选择一个数据范围", agent.id));
        }
        agent.scopes = scopes;
        normalized.push(agent);
    }
    if normalize_multi_agent_mode(Some(mode)) == MULTI_AGENT_CUSTOM_MODE
        && normalized.iter().filter(|agent| agent.enabled).count() < 2
    {
        return Err("自定义多 Agent 模式至少需要启用 2 个子 Agent".to_string());
    }
    Ok(normalized)
}

pub fn validate_profile_sub_agent_capacity(
    mode: &str,
    max_agents: u32,
    agents: &[AiProfileSubAgent],
) -> Result<(), String> {
    let mode = normalize_multi_agent_mode(Some(mode));
    let max_allowed = match mode {
        MULTI_AGENT_AUTO_MODE => MULTI_AGENT_AUTO_MAX_AGENTS,
        MULTI_AGENT_CUSTOM_MODE | MULTI_AGENT_OFF_MODE => MULTI_AGENT_CUSTOM_MAX_AGENTS,
        _ => unreachable!("multi-agent mode is normalized"),
    };
    if !(MULTI_AGENT_MIN_AGENTS..=max_allowed).contains(&max_agents) {
        return Err(format!(
            "{}模式的多 Agent 并发数量必须为 {}-{}",
            match mode {
                MULTI_AGENT_AUTO_MODE => "自动",
                MULTI_AGENT_CUSTOM_MODE => "自定义",
                _ => "关闭",
            },
            MULTI_AGENT_MIN_AGENTS,
            max_allowed
        ));
    }
    if mode != MULTI_AGENT_CUSTOM_MODE {
        return Ok(());
    }
    let required_enabled = agents
        .iter()
        .filter(|agent| agent.enabled && agent.required)
        .count();
    if required_enabled > max_agents as usize {
        return Err(format!(
            "必需子 Agent 数量 {} 超过本轮上限 {}",
            required_enabled, max_agents
        ));
    }
    let enabled = agents.iter().filter(|agent| agent.enabled).count();
    if enabled > max_agents as usize {
        return Err(format!(
            "已启用子 Agent 数量 {} 超过本轮上限 {}",
            enabled, max_agents
        ));
    }
    Ok(())
}

fn valid_profile_sub_agent_id(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    value.len() <= 32
        && first.is_ascii_lowercase()
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '-' | '_'))
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

    fn profile_agent(id: &str, enabled: bool, scopes: &[&str]) -> AiProfileSubAgent {
        AiProfileSubAgent {
            id: id.to_string(),
            name: format!("Agent {id}"),
            role: "market_structure".to_string(),
            responsibility: "读取证据并输出事实、冲突和数据缺口".to_string(),
            scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
            required: false,
            enabled,
        }
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
    fn custom_multi_agent_requires_two_enabled_unique_valid_agents() {
        let one = vec![profile_agent("market", true, &["market"])];
        assert!(normalize_profile_sub_agents(MULTI_AGENT_CUSTOM_MODE, one).is_err());

        let duplicate = vec![
            profile_agent("market", true, &["market"]),
            profile_agent("market", true, &["history"]),
        ];
        assert!(normalize_profile_sub_agents(MULTI_AGENT_CUSTOM_MODE, duplicate).is_err());

        let valid = vec![
            profile_agent("market", true, &["market", "market"]),
            profile_agent("risk", true, &["account", "history"]),
        ];
        let normalized = normalize_profile_sub_agents(MULTI_AGENT_CUSTOM_MODE, valid)
            .expect("valid custom agents");
        assert_eq!(normalized[0].scopes, vec!["market"]);
        assert_eq!(normalized.len(), 2);
    }

    #[test]
    fn multi_agent_validation_rejects_invalid_ids_scopes_and_excess_members() {
        let invalid_id = vec![profile_agent("Market Agent", true, &["market"])];
        assert!(normalize_profile_sub_agents(MULTI_AGENT_AUTO_MODE, invalid_id).is_err());

        let invalid_scope = vec![profile_agent("market", true, &["trade"])];
        assert!(normalize_profile_sub_agents(MULTI_AGENT_AUTO_MODE, invalid_scope).is_err());

        let too_many = (0..11)
            .map(|index| profile_agent(&format!("agent-{index}"), true, &["market"]))
            .collect();
        assert!(normalize_profile_sub_agents(MULTI_AGENT_AUTO_MODE, too_many).is_err());
    }

    #[test]
    fn custom_multi_agent_capacity_is_a_hard_limit() {
        let mut agents = vec![
            profile_agent("market", true, &["market"]),
            profile_agent("risk", true, &["account"]),
            profile_agent("news", true, &["intelligence"]),
        ];
        assert!(validate_profile_sub_agent_capacity(MULTI_AGENT_CUSTOM_MODE, 2, &agents).is_err());
        assert!(validate_profile_sub_agent_capacity(MULTI_AGENT_CUSTOM_MODE, 3, &agents).is_ok());

        for agent in &mut agents {
            agent.required = true;
        }
        let error = validate_profile_sub_agent_capacity(MULTI_AGENT_CUSTOM_MODE, 2, &agents)
            .expect_err("required agents must not be truncated");
        assert!(error.contains("必需子 Agent"));
    }

    #[test]
    fn multi_agent_capacity_limits_are_mode_aware() {
        assert!(validate_profile_sub_agent_capacity(MULTI_AGENT_AUTO_MODE, 8, &[]).is_ok());
        assert!(validate_profile_sub_agent_capacity(MULTI_AGENT_AUTO_MODE, 9, &[]).is_err());
        assert!(validate_profile_sub_agent_capacity(MULTI_AGENT_OFF_MODE, 10, &[]).is_ok());

        let agents = (0..10)
            .map(|index| profile_agent(&format!("agent-{index}"), true, &["market"]))
            .collect::<Vec<_>>();
        let normalized = normalize_profile_sub_agents(MULTI_AGENT_CUSTOM_MODE, agents)
            .expect("ten custom agents are supported");
        assert!(
            validate_profile_sub_agent_capacity(MULTI_AGENT_CUSTOM_MODE, 10, &normalized).is_ok()
        );
        assert!(
            validate_profile_sub_agent_capacity(MULTI_AGENT_CUSTOM_MODE, 11, &normalized).is_err()
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
