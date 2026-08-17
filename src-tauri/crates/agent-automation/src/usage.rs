use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

pub const AI_USAGE_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiTokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub reasoning_tokens: u64,
    pub total_tokens: u64,
}

impl AiTokenUsage {
    pub fn add_assign(&mut self, other: &Self) {
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
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiUsageQuality {
    ProviderReported,
    Reconstructed,
    Partial,
    #[default]
    Unreported,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageCoverage {
    pub input_output: bool,
    pub cache_read: bool,
    pub cache_write: bool,
    pub reasoning: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageSummary {
    #[serde(default)]
    pub schema_version: u32,
    pub provider: String,
    pub model_id: String,
    pub model: String,
    pub model_name: String,
    pub reported: bool,
    #[serde(default)]
    pub quality: AiUsageQuality,
    #[serde(default)]
    pub coverage: AiUsageCoverage,
    pub agent_count: u32,
    #[serde(default)]
    pub reported_agent_count: u32,
    #[serde(default)]
    pub unreported_agent_count: u32,
    pub usage: AiTokenUsage,
    pub main_usage: AiTokenUsage,
}

#[derive(Debug, Clone)]
struct NormalizedUsageComponent {
    usage: AiTokenUsage,
    coverage: AiUsageCoverage,
    reported: bool,
    quality: AiUsageQuality,
}

impl Default for NormalizedUsageComponent {
    fn default() -> Self {
        Self {
            usage: AiTokenUsage::default(),
            coverage: AiUsageCoverage::default(),
            reported: false,
            quality: AiUsageQuality::Unreported,
        }
    }
}

const INPUT_KEYS: &[&str] = &["inputTokens", "input_tokens", "promptTokens"];
const OUTPUT_KEYS: &[&str] = &["outputTokens", "output_tokens", "completionTokens"];
const CACHE_READ_KEYS: &[&str] = &[
    "cacheReadTokens",
    "cache_read_tokens",
    "cache_read_input_tokens",
    "cachedInputTokens",
];
const CACHE_WRITE_KEYS: &[&str] = &[
    "cacheWriteTokens",
    "cache_write_tokens",
    "cache_creation_input_tokens",
];
const REASONING_KEYS: &[&str] = &[
    "reasoningTokens",
    "reasoning_tokens",
    "reasoningTokenCount",
    "thoughtsTokens",
    "thoughts_tokens",
    "thoughtsTokenCount",
];

fn usage_u64_option(value: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|key| {
        let value = value.get(*key)?;
        value
            .as_u64()
            .or_else(|| value.as_i64().and_then(|item| u64::try_from(item).ok()))
            .or_else(|| value.as_f64().map(|item| item.max(0.0) as u64))
            .or_else(|| value.as_str()?.parse::<u64>().ok())
    })
}

fn usage_u64(value: &Value, keys: &[&str]) -> u64 {
    usage_u64_option(value, keys).unwrap_or(0)
}

fn usage_kind(value: &Value) -> Option<&str> {
    value.get("usageKind").and_then(Value::as_str)
}

fn normalize_single_usage(value: &Value) -> NormalizedUsageComponent {
    let input = usage_u64_option(value, &["totalInputTokens"])
        .or_else(|| usage_u64_option(value, INPUT_KEYS));
    let output = usage_u64_option(value, &["totalOutputTokens"])
        .or_else(|| usage_u64_option(value, OUTPUT_KEYS));
    let cache_read = usage_u64_option(value, &["totalCacheReadTokens"])
        .or_else(|| usage_u64_option(value, CACHE_READ_KEYS));
    let cache_write = usage_u64_option(value, &["totalCacheWriteTokens"])
        .or_else(|| usage_u64_option(value, CACHE_WRITE_KEYS));
    let reasoning = usage_u64_option(value, &["totalReasoningTokens"])
        .or_else(|| usage_u64_option(value, REASONING_KEYS));
    let reported = input.is_some() || output.is_some();
    let input_tokens = input.unwrap_or(0);
    let output_tokens = output.unwrap_or(0);
    NormalizedUsageComponent {
        usage: AiTokenUsage {
            input_tokens,
            output_tokens,
            cache_read_tokens: cache_read.unwrap_or(0),
            cache_write_tokens: cache_write.unwrap_or(0),
            reasoning_tokens: reasoning.unwrap_or(0),
            total_tokens: input_tokens.saturating_add(output_tokens),
        },
        coverage: AiUsageCoverage {
            input_output: reported,
            cache_read: cache_read.is_some(),
            cache_write: cache_write.is_some(),
            reasoning: reasoning.is_some(),
        },
        reported,
        quality: if !reported {
            AiUsageQuality::Unreported
        } else if usage_kind(value).is_some() {
            AiUsageQuality::ProviderReported
        } else {
            AiUsageQuality::Reconstructed
        },
    }
}

fn adjust_legacy_claude_input(
    provider: &str,
    component: &mut NormalizedUsageComponent,
    canonical_protocol: bool,
) {
    if provider == "claude-code" && component.reported && !canonical_protocol {
        component.usage.input_tokens = component
            .usage
            .input_tokens
            .saturating_add(component.usage.cache_read_tokens)
            .saturating_add(component.usage.cache_write_tokens);
        component.usage.total_tokens = component
            .usage
            .input_tokens
            .saturating_add(component.usage.output_tokens);
    }
}

fn cumulative_value(values: &[&Value], total_key: &str, regular_keys: &[&str]) -> Option<u64> {
    values
        .iter()
        .filter_map(|value| {
            usage_u64_option(value, &[total_key]).or_else(|| {
                (usage_kind(value) == Some("cumulative"))
                    .then(|| usage_u64_option(value, regular_keys))
                    .flatten()
            })
        })
        .max()
}

fn sum_incremental(values: &[&Value], keys: &[&str]) -> u64 {
    values
        .iter()
        .filter(|value| usage_kind(value) != Some("cumulative"))
        .map(|value| usage_u64(value, keys))
        .sum()
}

fn summarize_main_usage(events: &[Value], provider: &str) -> NormalizedUsageComponent {
    let values = events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("usage"))
        .filter_map(|event| event.get("usage"))
        .collect::<Vec<_>>();
    if values.is_empty() {
        return NormalizedUsageComponent::default();
    }

    let canonical_protocol = values.iter().all(|value| usage_kind(value).is_some());
    let has_accumulated_totals = values.iter().any(|value| {
        value.get("totalInputTokens").is_some() || value.get("totalOutputTokens").is_some()
    });
    let all_delta = values
        .iter()
        .all(|value| matches!(usage_kind(value), Some("delta") | Some("delta-with-totals")));
    let all_cumulative = values
        .iter()
        .all(|value| usage_kind(value) == Some("cumulative"));

    let mut component = if has_accumulated_totals {
        let input_tokens = cumulative_value(&values, "totalInputTokens", INPUT_KEYS)
            .unwrap_or_else(|| sum_incremental(&values, INPUT_KEYS));
        let output_tokens = cumulative_value(&values, "totalOutputTokens", OUTPUT_KEYS)
            .unwrap_or_else(|| sum_incremental(&values, OUTPUT_KEYS));
        let total_cache_read = cumulative_value(&values, "totalCacheReadTokens", CACHE_READ_KEYS);
        let total_cache_write =
            cumulative_value(&values, "totalCacheWriteTokens", CACHE_WRITE_KEYS);
        let total_reasoning = cumulative_value(&values, "totalReasoningTokens", REASONING_KEYS);
        let cache_read_tokens =
            total_cache_read.unwrap_or_else(|| sum_incremental(&values, CACHE_READ_KEYS));
        let cache_write_tokens =
            total_cache_write.unwrap_or_else(|| sum_incremental(&values, CACHE_WRITE_KEYS));
        let reasoning_tokens = total_reasoning.unwrap_or_else(|| {
            if all_delta {
                sum_incremental(&values, REASONING_KEYS)
            } else {
                0
            }
        });
        NormalizedUsageComponent {
            usage: AiTokenUsage {
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_write_tokens,
                reasoning_tokens,
                total_tokens: input_tokens.saturating_add(output_tokens),
            },
            coverage: AiUsageCoverage {
                input_output: true,
                cache_read: total_cache_read.is_some()
                    || values
                        .iter()
                        .any(|value| usage_u64_option(value, CACHE_READ_KEYS).is_some()),
                cache_write: total_cache_write.is_some()
                    || values
                        .iter()
                        .any(|value| usage_u64_option(value, CACHE_WRITE_KEYS).is_some()),
                reasoning: total_reasoning.is_some()
                    || (all_delta
                        && values
                            .iter()
                            .any(|value| usage_u64_option(value, REASONING_KEYS).is_some())),
            },
            reported: true,
            quality: if canonical_protocol {
                AiUsageQuality::ProviderReported
            } else {
                AiUsageQuality::Reconstructed
            },
        }
    } else if values.len() == 1 || all_cumulative {
        normalize_single_usage(values.last().expect("usage values is non-empty"))
    } else if all_delta {
        let mut usage = AiTokenUsage::default();
        let mut coverage = AiUsageCoverage {
            input_output: true,
            cache_read: true,
            cache_write: true,
            reasoning: true,
        };
        for value in &values {
            let item = normalize_single_usage(value);
            usage.add_assign(&item.usage);
            coverage.input_output &= item.coverage.input_output;
            coverage.cache_read &= item.coverage.cache_read;
            coverage.cache_write &= item.coverage.cache_write;
            coverage.reasoning &= item.coverage.reasoning;
        }
        NormalizedUsageComponent {
            usage,
            coverage,
            reported: true,
            quality: AiUsageQuality::ProviderReported,
        }
    } else {
        let mut item = normalize_single_usage(values.last().expect("usage values is non-empty"));
        if item.reported {
            item.quality = AiUsageQuality::Partial;
        }
        item
    };
    adjust_legacy_claude_input(provider, &mut component, canonical_protocol);
    component
}

pub fn build_ai_usage_summary(
    events: &[Value],
    provider: &str,
    model_id: &str,
    model: &str,
    model_name: &str,
) -> AiUsageSummary {
    let main = summarize_main_usage(events, provider);
    let mut agent_usage_by_id = HashMap::<String, NormalizedUsageComponent>::new();
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
        let mut component = event
            .pointer("/result/usage")
            .map(normalize_single_usage)
            .unwrap_or_default();
        let canonical_protocol = event
            .pointer("/result/usage")
            .and_then(usage_kind)
            .is_some();
        adjust_legacy_claude_input(provider, &mut component, canonical_protocol);
        agent_usage_by_id.insert(id, component);
    }

    let mut usage = main.usage.clone();
    let mut components = Vec::new();
    if main.reported {
        components.push(&main);
    }
    for agent_usage in agent_usage_by_id.values() {
        if agent_usage.reported {
            usage.add_assign(&agent_usage.usage);
            components.push(agent_usage);
        }
    }
    let reported_agent_count = agent_usage_by_id
        .values()
        .filter(|component| component.reported)
        .count() as u32;
    let unreported_agent_count = agent_usage_by_id
        .len()
        .saturating_sub(reported_agent_count as usize) as u32;
    let reported = !components.is_empty();
    let coverage = if reported {
        AiUsageCoverage {
            input_output: components
                .iter()
                .all(|component| component.coverage.input_output),
            cache_read: components
                .iter()
                .all(|component| component.coverage.cache_read),
            cache_write: components
                .iter()
                .all(|component| component.coverage.cache_write),
            reasoning: components
                .iter()
                .all(|component| component.coverage.reasoning),
        }
    } else {
        AiUsageCoverage::default()
    };
    let quality = if !reported {
        AiUsageQuality::Unreported
    } else if !main.reported
        || unreported_agent_count > 0
        || components
            .iter()
            .any(|component| component.quality == AiUsageQuality::Partial)
    {
        AiUsageQuality::Partial
    } else if components
        .iter()
        .all(|component| component.quality == AiUsageQuality::ProviderReported)
    {
        AiUsageQuality::ProviderReported
    } else {
        AiUsageQuality::Reconstructed
    };

    AiUsageSummary {
        schema_version: AI_USAGE_SCHEMA_VERSION,
        provider: provider.to_string(),
        model_id: model_id.to_string(),
        model: model.to_string(),
        model_name: model_name.to_string(),
        reported,
        quality,
        coverage,
        agent_count: agent_usage_by_id.len() as u32,
        reported_agent_count,
        unreported_agent_count,
        usage,
        main_usage: main.usage,
    }
}
