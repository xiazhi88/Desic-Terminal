use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{
    EventDrivenStrategy, MarketDataWindow, PaperIntent, StrategyDecision, SystematicError,
};

const MAX_PERIOD: usize = 2_000;
const MAX_TARGET_CONTRACTS: f64 = 10_000_000.0;
const MAX_COMPOSITE_CONDITIONS: usize = 8;

/// A single directional condition for a composite visual rule. Conditions are
/// intentionally constrained to deterministic, closed-bar computations so a
/// saved strategy remains reviewable and replayable without arbitrary code.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum VisualRuleCondition {
    Momentum {
        #[serde(alias = "lookback_bars")]
        lookback_bars: usize,
        #[serde(alias = "threshold_pct")]
        threshold_pct: f64,
    },
    MacdCross {
        #[serde(alias = "fast_period")]
        fast_period: usize,
        #[serde(alias = "slow_period")]
        slow_period: usize,
        #[serde(alias = "signal_period")]
        signal_period: usize,
    },
    Breakout {
        #[serde(alias = "lookback_bars")]
        lookback_bars: usize,
    },
}

/// Versioned, visual-rule definitions supported by the first research runtime.
///
/// Every rule is evaluated at the current closed-bar cutoff. The definition is
/// deliberately data-only so it can be persisted, reviewed, versioned, and
/// recreated in another desktop installation without executable code.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum VisualRuleDefinition {
    Momentum {
        #[serde(alias = "strategy_id")]
        strategy_id: String,
        #[serde(alias = "lookback_bars")]
        lookback_bars: usize,
        #[serde(alias = "long_threshold_pct")]
        long_threshold_pct: f64,
        #[serde(alias = "short_threshold_pct")]
        short_threshold_pct: f64,
        #[serde(alias = "exit_threshold_pct")]
        exit_threshold_pct: f64,
        #[serde(alias = "target_contracts")]
        target_contracts: f64,
        #[serde(alias = "stop_loss_pct")]
        stop_loss_pct: f64,
        #[serde(alias = "take_profit_pct")]
        take_profit_pct: f64,
    },
    MacdCross {
        #[serde(alias = "strategy_id")]
        strategy_id: String,
        #[serde(alias = "fast_period")]
        fast_period: usize,
        #[serde(alias = "slow_period")]
        slow_period: usize,
        #[serde(alias = "signal_period")]
        signal_period: usize,
        #[serde(alias = "target_contracts")]
        target_contracts: f64,
        #[serde(alias = "stop_loss_pct")]
        stop_loss_pct: f64,
        #[serde(alias = "take_profit_pct")]
        take_profit_pct: f64,
    },
    Breakout {
        #[serde(alias = "strategy_id")]
        strategy_id: String,
        #[serde(alias = "lookback_bars")]
        lookback_bars: usize,
        #[serde(alias = "target_contracts")]
        target_contracts: f64,
        #[serde(alias = "stop_loss_pct")]
        stop_loss_pct: f64,
        #[serde(alias = "take_profit_pct")]
        take_profit_pct: f64,
    },
    /// A current-time AND / at-least-N-of-M composition of closed-bar
    /// conditions. Long and short confirmations are counted separately; a
    /// mixed direction never becomes a trade signal.
    Composite {
        #[serde(alias = "strategy_id")]
        strategy_id: String,
        conditions: Vec<VisualRuleCondition>,
        #[serde(alias = "min_confirmations")]
        min_confirmations: usize,
        #[serde(alias = "target_contracts")]
        target_contracts: f64,
        #[serde(alias = "stop_loss_pct")]
        stop_loss_pct: f64,
        #[serde(alias = "take_profit_pct")]
        take_profit_pct: f64,
    },
}

impl VisualRuleDefinition {
    pub fn default_macd(strategy_id: impl Into<String>) -> Self {
        Self::MacdCross {
            strategy_id: strategy_id.into(),
            fast_period: 12,
            slow_period: 26,
            signal_period: 9,
            target_contracts: 1.0,
            stop_loss_pct: 0.015,
            take_profit_pct: 0.03,
        }
    }

    pub fn strategy_id(&self) -> &str {
        match self {
            Self::Momentum { strategy_id, .. }
            | Self::MacdCross { strategy_id, .. }
            | Self::Breakout { strategy_id, .. }
            | Self::Composite { strategy_id, .. } => strategy_id,
        }
    }

    pub fn with_strategy_id(mut self, strategy_id: impl Into<String>) -> Self {
        let strategy_id = strategy_id.into();
        match &mut self {
            Self::Momentum {
                strategy_id: current,
                ..
            }
            | Self::MacdCross {
                strategy_id: current,
                ..
            }
            | Self::Breakout {
                strategy_id: current,
                ..
            }
            | Self::Composite {
                strategy_id: current,
                ..
            } => *current = strategy_id,
        }
        self
    }

    pub fn minimum_bars(&self) -> usize {
        match self {
            Self::Momentum { lookback_bars, .. } => lookback_bars.saturating_add(1),
            Self::MacdCross {
                slow_period,
                signal_period,
                ..
            } => slow_period.saturating_add(*signal_period).saturating_add(2),
            Self::Breakout { lookback_bars, .. } => lookback_bars.saturating_add(1),
            Self::Composite { conditions, .. } => conditions
                .iter()
                .map(VisualRuleCondition::minimum_bars)
                .max()
                .unwrap_or(1),
        }
    }

    pub fn validate(&self) -> Result<(), SystematicError> {
        validate_strategy_id(self.strategy_id())?;
        match self {
            Self::Momentum {
                lookback_bars,
                long_threshold_pct,
                short_threshold_pct,
                exit_threshold_pct,
                target_contracts,
                stop_loss_pct,
                take_profit_pct,
                ..
            } => {
                validate_period("lookbackBars", *lookback_bars, 1)?;
                validate_non_negative_fraction("longThresholdPct", *long_threshold_pct, false)?;
                validate_non_negative_fraction("shortThresholdPct", *short_threshold_pct, false)?;
                validate_non_negative_fraction("exitThresholdPct", *exit_threshold_pct, true)?;
                if *exit_threshold_pct > long_threshold_pct.min(*short_threshold_pct) {
                    return Err(SystematicError::invalid_argument(
                        "exitThresholdPct",
                        "must not exceed the smaller entry threshold",
                    ));
                }
                validate_execution_shape(*target_contracts, *stop_loss_pct, *take_profit_pct)?;
            }
            Self::MacdCross {
                fast_period,
                slow_period,
                signal_period,
                target_contracts,
                stop_loss_pct,
                take_profit_pct,
                ..
            } => {
                validate_period("fastPeriod", *fast_period, 1)?;
                validate_period("slowPeriod", *slow_period, 2)?;
                validate_period("signalPeriod", *signal_period, 1)?;
                if fast_period >= slow_period {
                    return Err(SystematicError::invalid_argument(
                        "fastPeriod",
                        "must be smaller than slowPeriod",
                    ));
                }
                validate_execution_shape(*target_contracts, *stop_loss_pct, *take_profit_pct)?;
            }
            Self::Breakout {
                lookback_bars,
                target_contracts,
                stop_loss_pct,
                take_profit_pct,
                ..
            } => {
                validate_period("lookbackBars", *lookback_bars, 2)?;
                validate_execution_shape(*target_contracts, *stop_loss_pct, *take_profit_pct)?;
            }
            Self::Composite {
                conditions,
                min_confirmations,
                target_contracts,
                stop_loss_pct,
                take_profit_pct,
                ..
            } => {
                if !(2..=MAX_COMPOSITE_CONDITIONS).contains(&conditions.len()) {
                    return Err(SystematicError::invalid_argument(
                        "conditions",
                        format!(
                            "must contain between 2 and {MAX_COMPOSITE_CONDITIONS} closed-bar conditions"
                        ),
                    ));
                }
                if *min_confirmations == 0 || *min_confirmations > conditions.len() {
                    return Err(SystematicError::invalid_argument(
                        "minConfirmations",
                        "must be at least one and no greater than the number of conditions",
                    ));
                }
                for condition in conditions {
                    condition.validate()?;
                }
                validate_execution_shape(*target_contracts, *stop_loss_pct, *take_profit_pct)?;
            }
        }
        Ok(())
    }
}

/// Stateful wrapper for a persisted visual-rule definition. It keeps no
/// wall-clock, account, network, or future-series state; all calculations are
/// derived from the callback's current market window.
#[derive(Debug, Clone)]
pub struct VisualRuleStrategy {
    definition: VisualRuleDefinition,
}

impl VisualRuleStrategy {
    pub fn new(definition: VisualRuleDefinition) -> Result<Self, SystematicError> {
        definition.validate()?;
        Ok(Self { definition })
    }

    pub fn definition(&self) -> &VisualRuleDefinition {
        &self.definition
    }
}

impl EventDrivenStrategy for VisualRuleStrategy {
    fn on_bar(&mut self, context: &MarketDataWindow) -> Result<StrategyDecision, SystematicError> {
        match &self.definition {
            VisualRuleDefinition::Momentum {
                strategy_id,
                lookback_bars,
                long_threshold_pct,
                short_threshold_pct,
                exit_threshold_pct,
                target_contracts,
                stop_loss_pct,
                take_profit_pct,
            } => momentum_decision(
                context,
                strategy_id,
                *lookback_bars,
                *long_threshold_pct,
                *short_threshold_pct,
                *exit_threshold_pct,
                *target_contracts,
                *stop_loss_pct,
                *take_profit_pct,
            ),
            VisualRuleDefinition::MacdCross {
                strategy_id,
                fast_period,
                slow_period,
                signal_period,
                target_contracts,
                stop_loss_pct,
                take_profit_pct,
            } => macd_cross_decision(
                context,
                strategy_id,
                *fast_period,
                *slow_period,
                *signal_period,
                *target_contracts,
                *stop_loss_pct,
                *take_profit_pct,
            ),
            VisualRuleDefinition::Breakout {
                strategy_id,
                lookback_bars,
                target_contracts,
                stop_loss_pct,
                take_profit_pct,
            } => breakout_decision(
                context,
                strategy_id,
                *lookback_bars,
                *target_contracts,
                *stop_loss_pct,
                *take_profit_pct,
            ),
            VisualRuleDefinition::Composite {
                strategy_id,
                conditions,
                min_confirmations,
                target_contracts,
                stop_loss_pct,
                take_profit_pct,
            } => composite_decision(
                context,
                strategy_id,
                conditions,
                *min_confirmations,
                *target_contracts,
                *stop_loss_pct,
                *take_profit_pct,
            ),
        }
    }
}

impl VisualRuleCondition {
    fn minimum_bars(&self) -> usize {
        match self {
            Self::Momentum { lookback_bars, .. } | Self::Breakout { lookback_bars } => {
                (*lookback_bars).saturating_add(1)
            }
            Self::MacdCross {
                slow_period,
                signal_period,
                ..
            } => (*slow_period)
                .saturating_add(*signal_period)
                .saturating_add(2),
        }
    }

    fn validate(&self) -> Result<(), SystematicError> {
        match self {
            Self::Momentum {
                lookback_bars,
                threshold_pct,
            } => {
                validate_period("conditions[].lookbackBars", *lookback_bars, 1)?;
                validate_non_negative_fraction("conditions[].thresholdPct", *threshold_pct, false)
            }
            Self::MacdCross {
                fast_period,
                slow_period,
                signal_period,
            } => {
                validate_period("conditions[].fastPeriod", *fast_period, 1)?;
                validate_period("conditions[].slowPeriod", *slow_period, 2)?;
                validate_period("conditions[].signalPeriod", *signal_period, 1)?;
                if fast_period >= slow_period {
                    return Err(SystematicError::invalid_argument(
                        "conditions[].fastPeriod",
                        "must be smaller than its slowPeriod",
                    ));
                }
                Ok(())
            }
            Self::Breakout { lookback_bars } => {
                validate_period("conditions[].lookbackBars", *lookback_bars, 2)
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConditionDirection {
    Long,
    Short,
    Neutral,
}

#[allow(clippy::too_many_arguments)]
fn momentum_decision(
    context: &MarketDataWindow,
    strategy_id: &str,
    lookback_bars: usize,
    long_threshold_pct: f64,
    short_threshold_pct: f64,
    exit_threshold_pct: f64,
    target_contracts: f64,
    stop_loss_pct: f64,
    take_profit_pct: f64,
) -> Result<StrategyDecision, SystematicError> {
    if context.len() < lookback_bars.saturating_add(1) {
        return Ok(StrategyDecision::NoAction {
            reason: Some("waiting for closed-bar momentum history".to_string()),
        });
    }
    let latest = context.latest_bar().close;
    let reference = context.bars()[context.len() - 1 - lookback_bars].close;
    let momentum = latest / reference - 1.0;
    let mut diagnostics = BTreeMap::new();
    diagnostics.insert("momentumPct".to_string(), momentum);
    diagnostics.insert("lookbackBars".to_string(), lookback_bars as f64);
    if momentum >= long_threshold_pct {
        return paper_intent(
            context,
            strategy_id,
            target_contracts,
            stop_loss_pct,
            take_profit_pct,
            "closed-bar momentum exceeded the long threshold",
            diagnostics,
        );
    }
    if momentum <= -short_threshold_pct {
        return paper_intent(
            context,
            strategy_id,
            -target_contracts,
            stop_loss_pct,
            take_profit_pct,
            "closed-bar momentum exceeded the short threshold",
            diagnostics,
        );
    }
    if momentum.abs() <= exit_threshold_pct {
        return Ok(StrategyDecision::PaperIntent {
            intent: PaperIntent {
                strategy_id: strategy_id.to_string(),
                inst_id: context.inst_id().to_string(),
                as_of_ms: context.as_of_ms(),
                target_quantity: 0.0,
                stop_loss: None,
                take_profit: None,
                execution: Default::default(),
                reason: "closed-bar momentum returned inside the exit band".to_string(),
                diagnostics,
            },
        });
    }
    Ok(StrategyDecision::NoAction {
        reason: Some("closed-bar momentum is between entry and exit thresholds".to_string()),
    })
}

#[allow(clippy::too_many_arguments)]
fn macd_cross_decision(
    context: &MarketDataWindow,
    strategy_id: &str,
    fast_period: usize,
    slow_period: usize,
    signal_period: usize,
    target_contracts: f64,
    stop_loss_pct: f64,
    take_profit_pct: f64,
) -> Result<StrategyDecision, SystematicError> {
    let minimum = slow_period.saturating_add(signal_period).saturating_add(2);
    if context.len() < minimum {
        return Ok(StrategyDecision::NoAction {
            reason: Some("waiting for closed-bar MACD history".to_string()),
        });
    }
    let closes = context
        .bars()
        .iter()
        .map(|bar| bar.close)
        .collect::<Vec<_>>();
    let macd_series = macd_series(&closes, fast_period, slow_period)?;
    let signal_series = ema_series(&macd_series, signal_period)?;
    let current_macd = *macd_series
        .last()
        .ok_or_else(|| SystematicError::data_contract("MACD series is unexpectedly empty"))?;
    let previous_macd = macd_series[macd_series.len() - 2];
    let current_signal = *signal_series.last().ok_or_else(|| {
        SystematicError::data_contract("MACD signal series is unexpectedly empty")
    })?;
    let previous_signal = signal_series[signal_series.len() - 2];
    let mut diagnostics = BTreeMap::new();
    diagnostics.insert("macd".to_string(), current_macd);
    diagnostics.insert("macdSignal".to_string(), current_signal);
    diagnostics.insert("macdHistogram".to_string(), current_macd - current_signal);
    if previous_macd <= previous_signal && current_macd > current_signal {
        return paper_intent(
            context,
            strategy_id,
            target_contracts,
            stop_loss_pct,
            take_profit_pct,
            "closed-bar MACD crossed above its signal",
            diagnostics,
        );
    }
    if previous_macd >= previous_signal && current_macd < current_signal {
        return paper_intent(
            context,
            strategy_id,
            -target_contracts,
            stop_loss_pct,
            take_profit_pct,
            "closed-bar MACD crossed below its signal",
            diagnostics,
        );
    }
    Ok(StrategyDecision::NoAction {
        reason: Some("no closed-bar MACD crossover".to_string()),
    })
}

#[allow(clippy::too_many_arguments)]
fn breakout_decision(
    context: &MarketDataWindow,
    strategy_id: &str,
    lookback_bars: usize,
    target_contracts: f64,
    stop_loss_pct: f64,
    take_profit_pct: f64,
) -> Result<StrategyDecision, SystematicError> {
    if context.len() < lookback_bars.saturating_add(1) {
        return Ok(StrategyDecision::NoAction {
            reason: Some("waiting for closed-bar breakout history".to_string()),
        });
    }
    let history = &context.bars()[context.len() - 1 - lookback_bars..context.len() - 1];
    let prior_high = history
        .iter()
        .map(|bar| bar.high)
        .fold(f64::NEG_INFINITY, f64::max);
    let prior_low = history
        .iter()
        .map(|bar| bar.low)
        .fold(f64::INFINITY, f64::min);
    let close = context.latest_bar().close;
    let mut diagnostics = BTreeMap::new();
    diagnostics.insert("priorHigh".to_string(), prior_high);
    diagnostics.insert("priorLow".to_string(), prior_low);
    if close > prior_high {
        return paper_intent(
            context,
            strategy_id,
            target_contracts,
            stop_loss_pct,
            take_profit_pct,
            "closed bar broke above the prior range high",
            diagnostics,
        );
    }
    if close < prior_low {
        return paper_intent(
            context,
            strategy_id,
            -target_contracts,
            stop_loss_pct,
            take_profit_pct,
            "closed bar broke below the prior range low",
            diagnostics,
        );
    }
    Ok(StrategyDecision::NoAction {
        reason: Some("close remains inside the prior breakout range".to_string()),
    })
}

#[allow(clippy::too_many_arguments)]
fn composite_decision(
    context: &MarketDataWindow,
    strategy_id: &str,
    conditions: &[VisualRuleCondition],
    min_confirmations: usize,
    target_contracts: f64,
    stop_loss_pct: f64,
    take_profit_pct: f64,
) -> Result<StrategyDecision, SystematicError> {
    let required_bars = conditions
        .iter()
        .map(VisualRuleCondition::minimum_bars)
        .max()
        .unwrap_or(1);
    if context.len() < required_bars {
        return Ok(StrategyDecision::NoAction {
            reason: Some("waiting for closed-bar composite condition history".to_string()),
        });
    }

    let mut long_confirmations = 0usize;
    let mut short_confirmations = 0usize;
    let mut diagnostics = BTreeMap::new();
    diagnostics.insert("conditionCount".to_string(), conditions.len() as f64);
    diagnostics.insert("minConfirmations".to_string(), min_confirmations as f64);

    for (index, condition) in conditions.iter().enumerate() {
        let direction = condition_direction(context, condition)?;
        let value = match direction {
            ConditionDirection::Long => {
                long_confirmations = long_confirmations.saturating_add(1);
                1.0
            }
            ConditionDirection::Short => {
                short_confirmations = short_confirmations.saturating_add(1);
                -1.0
            }
            ConditionDirection::Neutral => 0.0,
        };
        diagnostics.insert(format!("condition{index}"), value);
    }
    diagnostics.insert("longConfirmations".to_string(), long_confirmations as f64);
    diagnostics.insert("shortConfirmations".to_string(), short_confirmations as f64);

    if long_confirmations >= min_confirmations && long_confirmations > short_confirmations {
        return paper_intent(
            context,
            strategy_id,
            target_contracts,
            stop_loss_pct,
            take_profit_pct,
            "enough closed-bar composite conditions confirm a long target",
            diagnostics,
        );
    }
    if short_confirmations >= min_confirmations && short_confirmations > long_confirmations {
        return paper_intent(
            context,
            strategy_id,
            -target_contracts,
            stop_loss_pct,
            take_profit_pct,
            "enough closed-bar composite conditions confirm a short target",
            diagnostics,
        );
    }
    Ok(StrategyDecision::NoAction {
        reason: Some(
            if long_confirmations >= min_confirmations || short_confirmations >= min_confirmations {
                "closed-bar composite conditions disagree on direction".to_string()
            } else {
                "not enough closed-bar composite conditions confirm one direction".to_string()
            },
        ),
    })
}

fn condition_direction(
    context: &MarketDataWindow,
    condition: &VisualRuleCondition,
) -> Result<ConditionDirection, SystematicError> {
    match condition {
        VisualRuleCondition::Momentum {
            lookback_bars,
            threshold_pct,
        } => {
            let required_bars = (*lookback_bars).saturating_add(1);
            if context.len() < required_bars {
                return Ok(ConditionDirection::Neutral);
            }
            let latest = context.latest_bar().close;
            let reference = context.bars()[context.len() - 1 - *lookback_bars].close;
            let momentum = latest / reference - 1.0;
            Ok(if momentum >= *threshold_pct {
                ConditionDirection::Long
            } else if momentum <= -*threshold_pct {
                ConditionDirection::Short
            } else {
                ConditionDirection::Neutral
            })
        }
        VisualRuleCondition::MacdCross {
            fast_period,
            slow_period,
            signal_period,
        } => {
            let minimum = slow_period.saturating_add(*signal_period).saturating_add(2);
            if context.len() < minimum {
                return Ok(ConditionDirection::Neutral);
            }
            let closes = context
                .bars()
                .iter()
                .map(|bar| bar.close)
                .collect::<Vec<_>>();
            let macd = macd_series(&closes, *fast_period, *slow_period)?;
            let signal = ema_series(&macd, *signal_period)?;
            let current_macd = *macd.last().ok_or_else(|| {
                SystematicError::data_contract("MACD series is unexpectedly empty")
            })?;
            let previous_macd = macd[macd.len() - 2];
            let current_signal = *signal.last().ok_or_else(|| {
                SystematicError::data_contract("MACD signal series is unexpectedly empty")
            })?;
            let previous_signal = signal[signal.len() - 2];
            Ok(
                if previous_macd <= previous_signal && current_macd > current_signal {
                    ConditionDirection::Long
                } else if previous_macd >= previous_signal && current_macd < current_signal {
                    ConditionDirection::Short
                } else {
                    ConditionDirection::Neutral
                },
            )
        }
        VisualRuleCondition::Breakout { lookback_bars } => {
            let required_bars = (*lookback_bars).saturating_add(1);
            if context.len() < required_bars {
                return Ok(ConditionDirection::Neutral);
            }
            let history = &context.bars()[context.len() - 1 - *lookback_bars..context.len() - 1];
            let prior_high = history
                .iter()
                .map(|bar| bar.high)
                .fold(f64::NEG_INFINITY, f64::max);
            let prior_low = history
                .iter()
                .map(|bar| bar.low)
                .fold(f64::INFINITY, f64::min);
            let close = context.latest_bar().close;
            Ok(if close > prior_high {
                ConditionDirection::Long
            } else if close < prior_low {
                ConditionDirection::Short
            } else {
                ConditionDirection::Neutral
            })
        }
    }
}

fn paper_intent(
    context: &MarketDataWindow,
    strategy_id: &str,
    target_quantity: f64,
    stop_loss_pct: f64,
    take_profit_pct: f64,
    reason: &str,
    diagnostics: BTreeMap<String, f64>,
) -> Result<StrategyDecision, SystematicError> {
    let close = context.latest_bar().close;
    let (stop_loss, take_profit) = if target_quantity > 0.0 {
        (
            Some(close * (1.0 - stop_loss_pct)),
            Some(close * (1.0 + take_profit_pct)),
        )
    } else {
        (
            Some(close * (1.0 + stop_loss_pct)),
            Some(close * (1.0 - take_profit_pct)),
        )
    };
    Ok(StrategyDecision::PaperIntent {
        intent: PaperIntent {
            strategy_id: strategy_id.to_string(),
            inst_id: context.inst_id().to_string(),
            as_of_ms: context.as_of_ms(),
            target_quantity,
            stop_loss,
            take_profit,
            execution: Default::default(),
            reason: reason.to_string(),
            diagnostics,
        },
    })
}

fn macd_series(
    closes: &[f64],
    fast_period: usize,
    slow_period: usize,
) -> Result<Vec<f64>, SystematicError> {
    let fast = ema_series(closes, fast_period)?;
    let slow = ema_series(closes, slow_period)?;
    Ok(fast
        .into_iter()
        .zip(slow)
        .map(|(fast, slow)| fast - slow)
        .collect())
}

fn ema_series(values: &[f64], period: usize) -> Result<Vec<f64>, SystematicError> {
    validate_period("period", period, 1)?;
    if values.is_empty() {
        return Err(SystematicError::data_contract(
            "EMA requires at least one value",
        ));
    }
    let alpha = 2.0 / (period as f64 + 1.0);
    let mut result = Vec::with_capacity(values.len());
    let mut current = values[0];
    for value in values {
        // Prices are validated by ClosedBar, but derived indicator series such
        // as MACD legitimately start at zero and can be negative.
        if !value.is_finite() {
            return Err(SystematicError::data_contract("EMA values must be finite"));
        }
        current = alpha * value + (1.0 - alpha) * current;
        if !current.is_finite() {
            return Err(SystematicError::data_contract(
                "EMA calculation produced a non-finite value",
            ));
        }
        result.push(current);
    }
    Ok(result)
}

fn validate_strategy_id(value: &str) -> Result<(), SystematicError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 128 {
        return Err(SystematicError::invalid_argument(
            "strategyId",
            "must contain 1 to 128 non-whitespace bytes",
        ));
    }
    Ok(())
}

fn validate_period(
    field: &'static str,
    period: usize,
    minimum: usize,
) -> Result<(), SystematicError> {
    if !(minimum..=MAX_PERIOD).contains(&period) {
        return Err(SystematicError::invalid_argument(
            field,
            format!("must be between {minimum} and {MAX_PERIOD}"),
        ));
    }
    Ok(())
}

fn validate_non_negative_fraction(
    field: &'static str,
    value: f64,
    allow_zero: bool,
) -> Result<(), SystematicError> {
    let valid = value.is_finite()
        && value < 1.0
        && if allow_zero {
            value >= 0.0
        } else {
            value > 0.0
        };
    if !valid {
        return Err(SystematicError::invalid_argument(
            field,
            if allow_zero {
                "must be finite, at least zero, and below one"
            } else {
                "must be finite, greater than zero, and below one"
            },
        ));
    }
    Ok(())
}

fn validate_execution_shape(
    target_contracts: f64,
    stop_loss_pct: f64,
    take_profit_pct: f64,
) -> Result<(), SystematicError> {
    if !target_contracts.is_finite()
        || target_contracts <= 0.0
        || target_contracts > MAX_TARGET_CONTRACTS
    {
        return Err(SystematicError::invalid_argument(
            "targetContracts",
            "must be finite, greater than zero, and within the research limit",
        ));
    }
    validate_non_negative_fraction("stopLossPct", stop_loss_pct, false)?;
    validate_non_negative_fraction("takeProfitPct", take_profit_pct, false)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ClosedBar, ONE_MINUTE_MS};

    fn context(closes: &[f64]) -> MarketDataWindow {
        let bars = closes
            .iter()
            .enumerate()
            .map(|(index, close)| {
                let open_time = index as i64 * ONE_MINUTE_MS;
                ClosedBar::new(
                    open_time,
                    open_time + ONE_MINUTE_MS,
                    *close,
                    *close + 0.5,
                    *close - 0.5,
                    *close,
                    10.0,
                )
                .unwrap()
            })
            .collect();
        MarketDataWindow::from_closed_bars(
            "BTC-USDT-SWAP",
            closes.len() as i64 * ONE_MINUTE_MS,
            ONE_MINUTE_MS,
            bars,
            BTreeMap::new(),
        )
        .unwrap()
    }

    #[test]
    fn visual_rule_wire_format_is_camel_case_and_reads_legacy_snake_case() {
        let definition = VisualRuleDefinition::default_macd("wire-format");
        let encoded = serde_json::to_value(&definition).expect("serialize rule");
        assert_eq!(encoded["strategyId"], "wire-format");
        assert_eq!(encoded["fastPeriod"], 12);
        assert!(encoded.get("strategy_id").is_none());
        assert!(encoded.get("fast_period").is_none());
        let camel_case: VisualRuleDefinition =
            serde_json::from_value(encoded).expect("decode camel-case rule");
        assert_eq!(camel_case, definition);

        let legacy = serde_json::json!({
            "kind": "macdCross",
            "strategy_id": "wire-format",
            "fast_period": 12,
            "slow_period": 26,
            "signal_period": 9,
            "target_contracts": 1.0,
            "stop_loss_pct": 0.015,
            "take_profit_pct": 0.03
        });
        let decoded: VisualRuleDefinition =
            serde_json::from_value(legacy).expect("decode legacy rule");
        assert_eq!(decoded, definition);
    }

    #[test]
    fn momentum_only_emits_a_current_cutoff_intent() {
        let mut strategy = VisualRuleStrategy::new(VisualRuleDefinition::Momentum {
            strategy_id: "momentum".to_string(),
            lookback_bars: 2,
            long_threshold_pct: 0.01,
            short_threshold_pct: 0.01,
            exit_threshold_pct: 0.002,
            target_contracts: 1.0,
            stop_loss_pct: 0.01,
            take_profit_pct: 0.02,
        })
        .unwrap();
        let context = context(&[100.0, 101.0, 103.0]);

        let decision = strategy.on_bar(&context).unwrap();
        decision.validate_for(&context).unwrap();
        assert!(matches!(decision, StrategyDecision::PaperIntent { .. }));
    }

    #[test]
    fn invalid_macd_periods_are_rejected_before_execution() {
        assert!(VisualRuleStrategy::new(VisualRuleDefinition::MacdCross {
            strategy_id: "bad".to_string(),
            fast_period: 26,
            slow_period: 12,
            signal_period: 9,
            target_contracts: 1.0,
            stop_loss_pct: 0.01,
            take_profit_pct: 0.02,
        })
        .is_err());
    }

    #[test]
    fn macd_rule_accepts_zero_and_negative_derived_values() {
        let closes = (0..40)
            .map(|index| 100.0 - index as f64 * 0.5)
            .collect::<Vec<_>>();
        let context = context(&closes);
        let mut strategy =
            VisualRuleStrategy::new(VisualRuleDefinition::default_macd("macd-derived-values"))
                .expect("valid MACD rule");

        let decision = strategy
            .on_bar(&context)
            .expect("zero and negative MACD values are valid EMA inputs");

        decision
            .validate_for(&context)
            .expect("MACD decision remains valid for the current cutoff");
    }

    #[test]
    fn composite_rule_requires_current_time_directional_confirmation() {
        let mut strategy = VisualRuleStrategy::new(VisualRuleDefinition::Composite {
            strategy_id: "two-of-two".to_string(),
            conditions: vec![
                VisualRuleCondition::Momentum {
                    lookback_bars: 2,
                    threshold_pct: 0.01,
                },
                VisualRuleCondition::Breakout { lookback_bars: 2 },
            ],
            min_confirmations: 2,
            target_contracts: 1.0,
            stop_loss_pct: 0.01,
            take_profit_pct: 0.02,
        })
        .unwrap();
        let context = context(&[100.0, 100.5, 102.0]);

        let decision = strategy.on_bar(&context).unwrap();
        decision.validate_for(&context).unwrap();
        assert!(matches!(decision, StrategyDecision::PaperIntent { .. }));
    }

    #[test]
    fn composite_rule_rejects_impossible_confirmation_count() {
        assert!(VisualRuleStrategy::new(VisualRuleDefinition::Composite {
            strategy_id: "invalid-composite".to_string(),
            conditions: vec![
                VisualRuleCondition::Momentum {
                    lookback_bars: 2,
                    threshold_pct: 0.01,
                },
                VisualRuleCondition::Breakout { lookback_bars: 2 },
            ],
            min_confirmations: 3,
            target_contracts: 1.0,
            stop_loss_pct: 0.01,
            take_profit_pct: 0.02,
        })
        .is_err());
    }
}
