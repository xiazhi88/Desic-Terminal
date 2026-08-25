use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{MarketDataWindow, SystematicError};

/// Direction for a paper-trading intent or an informational strategy signal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TradeSide {
    Long,
    Short,
}

/// The intentionally narrow execution vocabulary exposed to Python
/// strategies. More exchange-specific time-in-force and maker/taker modes
/// remain host-owned until their replay and live reconciliation semantics are
/// modelled consistently.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum StrategyOrderType {
    #[default]
    Market,
    Limit,
}

/// Execution details supplied with an entry or exit action. A market action
/// has no price; a limit action must use one positive absolute price.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StrategyExecution {
    #[serde(default)]
    pub order_type: StrategyOrderType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_price: Option<f64>,
}

impl StrategyExecution {
    pub fn validate(&self) -> Result<(), SystematicError> {
        match (self.order_type, self.limit_price) {
            (StrategyOrderType::Market, None) => Ok(()),
            (StrategyOrderType::Market, Some(_)) => Err(SystematicError::output_contract(
                "market execution must not include limitPrice",
            )),
            (StrategyOrderType::Limit, Some(price)) if price.is_finite() && price > 0.0 => Ok(()),
            (StrategyOrderType::Limit, _) => Err(SystematicError::output_contract(
                "limit execution requires a finite positive limitPrice",
            )),
        }
    }
}

impl TradeSide {
    pub(crate) fn sign(self) -> f64 {
        match self {
            Self::Long => 1.0,
            Self::Short => -1.0,
        }
    }
}

/// How complete and current an output's input data was at its cutoff.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DataCoverage {
    Complete,
    Partial,
    Stale,
    Unavailable,
}

/// A current-time observation emitted by a single-instrument strategy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategySignal {
    pub strategy_id: String,
    pub inst_id: String,
    pub as_of_ms: i64,
    pub side: TradeSide,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strength: Option<f64>,
    pub reason: String,
    #[serde(default)]
    pub diagnostics: BTreeMap<String, f64>,
}

/// A paper-only target position. A positive target opens or maintains a long;
/// a negative target opens or maintains a short; zero exits the instrument.
///
/// This is deliberately a target rather than an exchange order. The domain
/// engine decides the conservative simulated fill, while a future live layer
/// must still pass it through Desic-owned risk and execution controls.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperIntent {
    pub strategy_id: String,
    pub inst_id: String,
    pub as_of_ms: i64,
    pub target_quantity: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_loss: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub take_profit: Option<f64>,
    #[serde(default)]
    pub execution: StrategyExecution,
    pub reason: String,
    #[serde(default)]
    pub diagnostics: BTreeMap<String, f64>,
}

/// A stateful strategy's requested paper action at the current closed-bar
/// cutoff. It is deliberately smaller than an exchange order: the engine
/// supplies the strategy/instrument/time identity, queues the action for the
/// next bar open, and owns all simulated fills, costs, and account state.
///
/// The action labels use the managed Python protocol's snake-case vocabulary.
/// The host maps that protocol's validated output envelope into this domain
/// type; camel-case aliases keep desktop adapters convenient as well.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum StrategyAction {
    #[serde(rename = "no_action", alias = "noAction")]
    NoAction {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    #[serde(rename = "open_long", alias = "openLong")]
    OpenLong {
        quantity: f64,
        #[serde(default)]
        execution: StrategyExecution,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stop_loss: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        take_profit: Option<f64>,
        reason: String,
        #[serde(default)]
        diagnostics: BTreeMap<String, f64>,
    },
    #[serde(rename = "open_short", alias = "openShort")]
    OpenShort {
        quantity: f64,
        #[serde(default)]
        execution: StrategyExecution,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stop_loss: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        take_profit: Option<f64>,
        reason: String,
        #[serde(default)]
        diagnostics: BTreeMap<String, f64>,
    },
    #[serde(rename = "close_long", alias = "closeLong")]
    CloseLong {
        quantity: f64,
        #[serde(default)]
        execution: StrategyExecution,
        reason: String,
        #[serde(default)]
        diagnostics: BTreeMap<String, f64>,
    },
    #[serde(rename = "close_short", alias = "closeShort")]
    CloseShort {
        quantity: f64,
        #[serde(default)]
        execution: StrategyExecution,
        reason: String,
        #[serde(default)]
        diagnostics: BTreeMap<String, f64>,
    },
    /// Updates the protection attached to the currently open virtual
    /// position. `None` means preserve that side of the protection, while
    /// `Some(None)` explicitly clears it and `Some(Some(price))` replaces it.
    #[serde(rename = "set_protection", alias = "setProtection")]
    SetProtection {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stop_loss: Option<Option<f64>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        take_profit: Option<Option<f64>>,
        reason: String,
        #[serde(default)]
        diagnostics: BTreeMap<String, f64>,
    },
    /// Removes both stop-loss and take-profit from the currently open virtual
    /// position. The action is separate from a close because future live
    /// adapters must cancel native protection before reconciling a close.
    #[serde(rename = "cancel_protection", alias = "cancelProtection")]
    CancelProtection {
        reason: String,
        #[serde(default)]
        diagnostics: BTreeMap<String, f64>,
    },
    /// Cancels one currently open normal strategy order. The action is queued
    /// to the next one-minute open just like entries and exits.
    #[serde(rename = "cancel_order", alias = "cancelOrder")]
    CancelOrder {
        order_id: String,
        reason: String,
        #[serde(default)]
        diagnostics: BTreeMap<String, f64>,
    },
}

impl StrategyAction {
    /// Validates values which do not depend on an instrument's contract rules
    /// or the current virtual portfolio. Those checks happen in the backtest
    /// engine when this action is translated into a paper intent.
    pub fn validate(&self) -> Result<(), SystematicError> {
        match self {
            Self::NoAction { reason } => {
                if let Some(reason) = reason {
                    validate_text("reason", reason, false)?;
                }
            }
            Self::OpenLong {
                quantity,
                execution,
                stop_loss,
                take_profit,
                reason,
                diagnostics,
            }
            | Self::OpenShort {
                quantity,
                execution,
                stop_loss,
                take_profit,
                reason,
                diagnostics,
            } => {
                validate_action_quantity(*quantity)?;
                execution.validate()?;
                validate_action_protection("stopLoss", *stop_loss)?;
                validate_action_protection("takeProfit", *take_profit)?;
                validate_text("reason", reason, true)?;
                validate_diagnostics(diagnostics)?;
            }
            Self::CloseLong {
                quantity,
                execution,
                reason,
                diagnostics,
            }
            | Self::CloseShort {
                quantity,
                execution,
                reason,
                diagnostics,
            } => {
                validate_action_quantity(*quantity)?;
                execution.validate()?;
                validate_text("reason", reason, true)?;
                validate_diagnostics(diagnostics)?;
            }
            Self::SetProtection {
                stop_loss,
                take_profit,
                reason,
                diagnostics,
            } => {
                if stop_loss.is_none() && take_profit.is_none() {
                    return Err(SystematicError::output_contract(
                        "set_protection must update or clear stopLoss and/or takeProfit",
                    ));
                }
                if let Some(Some(price)) = stop_loss {
                    validate_action_protection("stopLoss", Some(*price))?;
                }
                if let Some(Some(price)) = take_profit {
                    validate_action_protection("takeProfit", Some(*price))?;
                }
                validate_text("reason", reason, true)?;
                validate_diagnostics(diagnostics)?;
            }
            Self::CancelProtection {
                reason,
                diagnostics,
            } => {
                validate_text("reason", reason, true)?;
                validate_diagnostics(diagnostics)?;
            }
            Self::CancelOrder {
                order_id,
                reason,
                diagnostics,
            } => {
                validate_text("orderId", order_id, true)?;
                validate_text("reason", reason, true)?;
                validate_diagnostics(diagnostics)?;
            }
        }
        Ok(())
    }
}

/// Output from an event-driven strategy. Signals are recorded but do not trade;
/// only explicit `PaperIntent` values are eligible for the paper backtest
/// engine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StrategyDecision {
    NoAction {
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    Signal {
        signal: StrategySignal,
    },
    PaperIntent {
        intent: PaperIntent,
    },
}

impl StrategyDecision {
    /// Validates that an output belongs to the exact current event cutoff.
    /// This rejects stale/future responses from external runners before an
    /// intent can enter a deterministic paper queue.
    pub fn validate_for(&self, context: &MarketDataWindow) -> Result<(), SystematicError> {
        match self {
            Self::NoAction { reason } => {
                if let Some(reason) = reason {
                    validate_text("reason", reason, false)?;
                }
            }
            Self::Signal { signal } => validate_signal(signal, context)?,
            Self::PaperIntent { intent } => validate_paper_intent(intent, context)?,
        }
        Ok(())
    }
}

/// A per-instrument scalar factor value. `None` is valid only when coverage is
/// incomplete, stale, or unavailable; it prevents callers from inventing a
/// rank for an instrument whose required data was missing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactorOutput {
    pub factor_id: String,
    pub inst_id: String,
    pub as_of_ms: i64,
    pub value: Option<f64>,
    pub coverage: DataCoverage,
    #[serde(default)]
    pub diagnostics: BTreeMap<String, f64>,
}

impl FactorOutput {
    pub fn validate_for(&self, context: &MarketDataWindow) -> Result<(), SystematicError> {
        validate_time_and_instrument(&self.inst_id, self.as_of_ms, context, "factor")?;
        validate_identifier("factorId", &self.factor_id)?;
        validate_optional_value(self.value, self.coverage, "factor value")?;
        validate_diagnostics(&self.diagnostics)?;
        Ok(())
    }
}

/// A model's current cross-sectional prediction for one instrument. The score
/// is intentionally not an order instruction; portfolio construction and risk
/// management turn scores into targets later.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaOutput {
    pub model_id: String,
    pub model_version: String,
    pub inst_id: String,
    pub as_of_ms: i64,
    pub horizon_ms: i64,
    pub score: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    pub coverage: DataCoverage,
    #[serde(default)]
    pub diagnostics: BTreeMap<String, f64>,
}

impl AlphaOutput {
    pub fn validate_for(&self, context: &MarketDataWindow) -> Result<(), SystematicError> {
        validate_time_and_instrument(&self.inst_id, self.as_of_ms, context, "alpha")?;
        validate_identifier("modelId", &self.model_id)?;
        validate_identifier("modelVersion", &self.model_version)?;
        if self.horizon_ms <= 0 {
            return Err(SystematicError::invalid_argument(
                "horizonMs",
                "must be greater than zero",
            ));
        }
        validate_optional_value(self.score, self.coverage, "alpha score")?;
        if let Some(confidence) = self.confidence {
            if !confidence.is_finite() || !(0.0..=1.0).contains(&confidence) {
                return Err(SystematicError::output_contract(
                    "alpha confidence must be finite and between zero and one",
                ));
            }
        }
        validate_diagnostics(&self.diagnostics)?;
        Ok(())
    }
}

/// Position-level data within a cross-sectional portfolio target.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioTargetPosition {
    pub target_weight: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alpha_score: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    pub coverage: DataCoverage,
    #[serde(default)]
    pub diagnostics: BTreeMap<String, f64>,
}

/// A current-time collection of target weights. `BTreeMap` makes ordering and
/// hashes stable across machines and avoids duplicate instrument targets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioTarget {
    pub portfolio_id: String,
    pub model_id: String,
    pub model_version: String,
    pub as_of_ms: i64,
    pub rebalance_interval_ms: i64,
    pub positions: BTreeMap<String, PortfolioTargetPosition>,
    #[serde(default)]
    pub diagnostics: BTreeMap<String, f64>,
}

/// Desic-owned outer limits for an untrusted factor/model package's proposed
/// target weights. These are research/paper constraints, not replacements for
/// account-level trade risk controls.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioConstraints {
    pub max_abs_weight: f64,
    pub max_gross_exposure: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_abs_net_exposure: Option<f64>,
}

impl Default for PortfolioConstraints {
    fn default() -> Self {
        Self {
            max_abs_weight: 1.0,
            max_gross_exposure: 1.0,
            max_abs_net_exposure: Some(0.1),
        }
    }
}

impl PortfolioTarget {
    pub fn gross_exposure(&self) -> f64 {
        self.positions
            .values()
            .map(|position| position.target_weight.abs())
            .sum()
    }

    pub fn net_exposure(&self) -> f64 {
        self.positions
            .values()
            .map(|position| position.target_weight)
            .sum()
    }

    pub fn validate_at(
        &self,
        as_of_ms: i64,
        constraints: PortfolioConstraints,
    ) -> Result<(), SystematicError> {
        validate_identifier("portfolioId", &self.portfolio_id)?;
        validate_identifier("modelId", &self.model_id)?;
        validate_identifier("modelVersion", &self.model_version)?;
        if self.as_of_ms != as_of_ms {
            return Err(SystematicError::output_contract(format!(
                "portfolio asOfMs {} does not match current cutoff {}",
                self.as_of_ms, as_of_ms
            )));
        }
        if self.rebalance_interval_ms <= 0 {
            return Err(SystematicError::invalid_argument(
                "rebalanceIntervalMs",
                "must be greater than zero",
            ));
        }
        validate_constraints(constraints)?;
        if self.positions.is_empty() {
            return Err(SystematicError::output_contract(
                "portfolio targets must contain at least one instrument",
            ));
        }
        for (inst_id, position) in &self.positions {
            validate_identifier("positions.instId", inst_id)?;
            if !position.target_weight.is_finite()
                || position.target_weight.abs() > constraints.max_abs_weight
            {
                return Err(SystematicError::output_contract(format!(
                    "target weight for {inst_id} must be finite and within maxAbsWeight"
                )));
            }
            if let Some(alpha_score) = position.alpha_score {
                if !alpha_score.is_finite() {
                    return Err(SystematicError::output_contract(format!(
                        "alpha score for {inst_id} must be finite"
                    )));
                }
            }
            if let Some(confidence) = position.confidence {
                if !confidence.is_finite() || !(0.0..=1.0).contains(&confidence) {
                    return Err(SystematicError::output_contract(format!(
                        "confidence for {inst_id} must be between zero and one"
                    )));
                }
            }
            validate_diagnostics(&position.diagnostics)?;
        }
        validate_diagnostics(&self.diagnostics)?;
        let gross = self.gross_exposure();
        if gross > constraints.max_gross_exposure + f64::EPSILON {
            return Err(SystematicError::output_contract(format!(
                "gross exposure {gross} exceeds maximum {}",
                constraints.max_gross_exposure
            )));
        }
        if let Some(max_net) = constraints.max_abs_net_exposure {
            let net = self.net_exposure();
            if net.abs() > max_net + f64::EPSILON {
                return Err(SystematicError::output_contract(format!(
                    "net exposure {net} exceeds absolute maximum {max_net}"
                )));
            }
        }
        Ok(())
    }
}

fn validate_signal(
    signal: &StrategySignal,
    context: &MarketDataWindow,
) -> Result<(), SystematicError> {
    validate_time_and_instrument(&signal.inst_id, signal.as_of_ms, context, "signal")?;
    validate_identifier("strategyId", &signal.strategy_id)?;
    validate_text("reason", &signal.reason, true)?;
    if let Some(strength) = signal.strength {
        if !strength.is_finite() || !(0.0..=1.0).contains(&strength) {
            return Err(SystematicError::output_contract(
                "signal strength must be finite and between zero and one",
            ));
        }
    }
    validate_diagnostics(&signal.diagnostics)
}

fn validate_paper_intent(
    intent: &PaperIntent,
    context: &MarketDataWindow,
) -> Result<(), SystematicError> {
    validate_time_and_instrument(&intent.inst_id, intent.as_of_ms, context, "paper intent")?;
    validate_identifier("strategyId", &intent.strategy_id)?;
    validate_text("reason", &intent.reason, true)?;
    intent.execution.validate()?;
    if !intent.target_quantity.is_finite() {
        return Err(SystematicError::output_contract(
            "target quantity must be finite",
        ));
    }
    for (field, value) in [
        ("stopLoss", intent.stop_loss),
        ("takeProfit", intent.take_profit),
    ] {
        if let Some(value) = value {
            if !value.is_finite() || value <= 0.0 {
                return Err(SystematicError::output_contract(format!(
                    "{field} must be finite and greater than zero"
                )));
            }
        }
    }
    if intent.target_quantity == 0.0 && (intent.stop_loss.is_some() || intent.take_profit.is_some())
    {
        return Err(SystematicError::output_contract(
            "an exit target cannot declare stop-loss or take-profit prices",
        ));
    }
    if intent.target_quantity > 0.0 {
        validate_long_protection(intent, context.latest_bar().close)?;
    } else if intent.target_quantity < 0.0 {
        validate_short_protection(intent, context.latest_bar().close)?;
    }
    validate_diagnostics(&intent.diagnostics)
}

fn validate_long_protection(
    intent: &PaperIntent,
    reference_price: f64,
) -> Result<(), SystematicError> {
    if let Some(stop) = intent.stop_loss {
        if stop >= reference_price {
            return Err(SystematicError::output_contract(
                "a long stop-loss must be below the current closed price",
            ));
        }
    }
    if let Some(take_profit) = intent.take_profit {
        if take_profit <= reference_price {
            return Err(SystematicError::output_contract(
                "a long take-profit must be above the current closed price",
            ));
        }
    }
    Ok(())
}

fn validate_short_protection(
    intent: &PaperIntent,
    reference_price: f64,
) -> Result<(), SystematicError> {
    if let Some(stop) = intent.stop_loss {
        if stop <= reference_price {
            return Err(SystematicError::output_contract(
                "a short stop-loss must be above the current closed price",
            ));
        }
    }
    if let Some(take_profit) = intent.take_profit {
        if take_profit >= reference_price {
            return Err(SystematicError::output_contract(
                "a short take-profit must be below the current closed price",
            ));
        }
    }
    Ok(())
}

fn validate_time_and_instrument(
    inst_id: &str,
    as_of_ms: i64,
    context: &MarketDataWindow,
    output_name: &str,
) -> Result<(), SystematicError> {
    if inst_id != context.inst_id() {
        return Err(SystematicError::output_contract(format!(
            "{output_name} instrument {inst_id} does not match current context {}",
            context.inst_id()
        )));
    }
    if as_of_ms != context.as_of_ms() {
        return Err(SystematicError::output_contract(format!(
            "{output_name} asOfMs {as_of_ms} does not match current cutoff {}",
            context.as_of_ms()
        )));
    }
    Ok(())
}

fn validate_optional_value(
    value: Option<f64>,
    coverage: DataCoverage,
    name: &str,
) -> Result<(), SystematicError> {
    match (value, coverage) {
        (Some(value), _) if value.is_finite() => Ok(()),
        (Some(_), _) => Err(SystematicError::output_contract(format!(
            "{name} must be finite"
        ))),
        (None, DataCoverage::Complete) => Err(SystematicError::output_contract(format!(
            "complete coverage requires a {name}"
        ))),
        (None, _) => Ok(()),
    }
}

fn validate_diagnostics(values: &BTreeMap<String, f64>) -> Result<(), SystematicError> {
    for (key, value) in values {
        validate_identifier("diagnostics.key", key)?;
        if !value.is_finite() {
            return Err(SystematicError::output_contract(format!(
                "diagnostic {key} must be finite"
            )));
        }
    }
    Ok(())
}

fn validate_constraints(constraints: PortfolioConstraints) -> Result<(), SystematicError> {
    if !constraints.max_abs_weight.is_finite() || constraints.max_abs_weight <= 0.0 {
        return Err(SystematicError::invalid_argument(
            "maxAbsWeight",
            "must be finite and greater than zero",
        ));
    }
    if !constraints.max_gross_exposure.is_finite() || constraints.max_gross_exposure <= 0.0 {
        return Err(SystematicError::invalid_argument(
            "maxGrossExposure",
            "must be finite and greater than zero",
        ));
    }
    if let Some(max_net) = constraints.max_abs_net_exposure {
        if !max_net.is_finite() || max_net < 0.0 {
            return Err(SystematicError::invalid_argument(
                "maxAbsNetExposure",
                "must be finite and non-negative",
            ));
        }
    }
    Ok(())
}

fn validate_identifier(field: &'static str, value: &str) -> Result<(), SystematicError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 128 {
        return Err(SystematicError::invalid_argument(
            field,
            "must contain 1 to 128 non-whitespace bytes",
        ));
    }
    Ok(())
}

fn validate_text(field: &'static str, value: &str, required: bool) -> Result<(), SystematicError> {
    let value = value.trim();
    if (required && value.is_empty()) || value.len() > 2_000 {
        return Err(SystematicError::invalid_argument(
            field,
            "must be non-empty when required and at most 2,000 bytes",
        ));
    }
    Ok(())
}

fn validate_action_quantity(quantity: f64) -> Result<(), SystematicError> {
    if !quantity.is_finite() || quantity <= 0.0 {
        return Err(SystematicError::output_contract(
            "strategy action quantity must be finite and greater than zero",
        ));
    }
    Ok(())
}

fn validate_action_protection(
    field: &'static str,
    value: Option<f64>,
) -> Result<(), SystematicError> {
    if let Some(value) = value {
        if !value.is_finite() || value <= 0.0 {
            return Err(SystematicError::output_contract(format!(
                "{field} must be finite and greater than zero"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ClosedBar, MarketDataWindow, ONE_MINUTE_MS};

    fn context() -> MarketDataWindow {
        MarketDataWindow::from_closed_bars(
            "BTC-USDT-SWAP",
            ONE_MINUTE_MS,
            ONE_MINUTE_MS,
            vec![ClosedBar::new(0, ONE_MINUTE_MS, 100.0, 101.0, 99.0, 100.0, 1.0).unwrap()],
            BTreeMap::new(),
        )
        .unwrap()
    }

    #[test]
    fn rejects_future_strategy_intent() {
        let context = context();
        let decision = StrategyDecision::PaperIntent {
            intent: PaperIntent {
                strategy_id: "macd".to_string(),
                inst_id: "BTC-USDT-SWAP".to_string(),
                as_of_ms: ONE_MINUTE_MS + 1,
                target_quantity: 1.0,
                stop_loss: Some(90.0),
                take_profit: Some(110.0),
                execution: StrategyExecution::default(),
                reason: "closed-bar crossover".to_string(),
                diagnostics: BTreeMap::new(),
            },
        };

        assert!(matches!(
            decision.validate_for(&context),
            Err(SystematicError::OutputContractViolation { .. })
        ));
    }

    #[test]
    fn complete_factor_cannot_hide_a_missing_value() {
        let context = context();
        let output = FactorOutput {
            factor_id: "momentum".to_string(),
            inst_id: "BTC-USDT-SWAP".to_string(),
            as_of_ms: ONE_MINUTE_MS,
            value: None,
            coverage: DataCoverage::Complete,
            diagnostics: BTreeMap::new(),
        };

        assert!(output.validate_for(&context).is_err());
    }

    #[test]
    fn portfolio_target_enforces_desic_owned_exposure_limits() {
        let mut positions = BTreeMap::new();
        positions.insert(
            "BTC-USDT-SWAP".to_string(),
            PortfolioTargetPosition {
                target_weight: 0.8,
                alpha_score: Some(1.0),
                confidence: Some(0.8),
                coverage: DataCoverage::Complete,
                diagnostics: BTreeMap::new(),
            },
        );
        positions.insert(
            "ETH-USDT-SWAP".to_string(),
            PortfolioTargetPosition {
                target_weight: -0.8,
                alpha_score: Some(-1.0),
                confidence: Some(0.8),
                coverage: DataCoverage::Complete,
                diagnostics: BTreeMap::new(),
            },
        );
        let target = PortfolioTarget {
            portfolio_id: "demo".to_string(),
            model_id: "blend".to_string(),
            model_version: "1.0.0".to_string(),
            as_of_ms: ONE_MINUTE_MS,
            rebalance_interval_ms: ONE_MINUTE_MS,
            positions,
            diagnostics: BTreeMap::new(),
        };

        assert!(target
            .validate_at(
                ONE_MINUTE_MS,
                PortfolioConstraints {
                    max_abs_weight: 1.0,
                    max_gross_exposure: 1.0,
                    max_abs_net_exposure: Some(1.0),
                },
            )
            .is_err());
    }
}
