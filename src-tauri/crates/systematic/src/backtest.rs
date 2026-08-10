use std::{collections::{BTreeMap, VecDeque}, sync::Arc, time::Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    data::{validate_visible_bars, CurrentDataSnapshot},
    CancellationToken, ClosedBar, EventDrivenStrategy, MarketDataWindow, PaperIntent,
    StatefulEventDrivenStrategy, StrategyAction, StrategyDecision, StrategyExecution,
    StrategyOrderType, StrategySignal, SystematicError, TradeSide, ONE_MINUTE_MS,
};

const STEP_ALIGNMENT_EPSILON: f64 = 1e-8;

/// Applies the planned worker cap without depending on a specific async or
/// thread-pool implementation. The caller supplies the system's logical CPU
/// count, usually from `std::thread::available_parallelism()`.
pub fn recommended_backtest_workers(logical_cpu_count: usize) -> usize {
    logical_cpu_count.saturating_sub(2).clamp(1, 4)
}

/// How to value a position which remains open at the end of the requested
/// historical range. Mark-to-market is the default because it preserves the
/// next-bar-open contract; forced close is explicit and reported as such.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum EndOfRunPolicy {
    #[default]
    MarkToMarket,
    CloseAtLastClose,
}

/// A linear USDT perpetual's execution-relevant contract rules. Quantities are
/// contract counts, and `contract_value` is the base-asset quantity per
/// contract, matching OKX linear perpetual semantics.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentContract {
    pub contract_value: f64,
    pub min_size: f64,
    pub lot_size: f64,
}

/// Explicit conservative execution assumptions. Fees are decimal rates, so a
/// five-basis-point fee is `0.0005`; slippage values are basis points.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionAssumptions {
    pub entry_slippage_bps: f64,
    pub exit_slippage_bps: f64,
    pub entry_fee_rate: f64,
    pub exit_fee_rate: f64,
}

/// Isolated-margin assumptions for a reproducible virtual-account run.
/// `margin_safety_multiplier` reserves additional collateral above the
/// leverage-derived minimum without changing the strategy's contract size.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarginAssumptions {
    pub leverage: f64,
    pub margin_safety_multiplier: f64,
}

impl Default for MarginAssumptions {
    fn default() -> Self {
        Self {
            leverage: 10.0,
            margin_safety_multiplier: 1.0,
        }
    }
}

/// How the host converts a strategy opening intent into perpetual contracts.
/// Strategy source deliberately does not carry a contract count: the same
/// source must be runnable against instruments with different contract value,
/// minimum size, and lot-size rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum PositionSizingMode {
    FixedUsdt,
    #[default]
    EquityPercent,
}

/// Entry and same-side capacity expressed in one shared unit. Fixed values
/// are initial-margin USDT; percentage values are percentages of the current
/// account equity at the decision point.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionSizing {
    #[serde(default)]
    pub mode: PositionSizingMode,
    pub per_entry_budget: f64,
    pub same_side_total_budget: f64,
}

impl Default for PositionSizing {
    fn default() -> Self {
        Self {
            mode: PositionSizingMode::EquityPercent,
            per_entry_budget: 5.0,
            same_side_total_budget: 20.0,
        }
    }
}

/// The host-owned result of sizing one opening action. Values are retained in
/// execution history so a strategy intent can be audited without making the
/// strategy itself an order-size authority.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionSizingResolution {
    pub contracts: f64,
    pub estimated_initial_margin_usdt: f64,
    pub entry_budget_usdt: f64,
    pub same_side_total_budget_usdt: f64,
    pub current_same_side_margin_usdt: f64,
}

/// The outcome of resolving an opening size for a historical simulation.
///
/// A budget or lot-size shortfall is a normal no-trade condition in a
/// backtest: the strategy can keep evaluating later bars after it is unable to
/// open on this one. Invalid sizing inputs remain errors.
#[derive(Debug, Clone, PartialEq)]
pub enum BacktestPositionSizingOutcome {
    Sized(PositionSizingResolution),
    Skipped { reason: String },
}

impl PositionSizing {
    pub fn validate(&self) -> Result<(), SystematicError> {
        let maximum = match self.mode {
            PositionSizingMode::FixedUsdt => f64::INFINITY,
            PositionSizingMode::EquityPercent => 100.0,
        };
        for (field, value) in [
            ("perEntryBudget", self.per_entry_budget),
            ("sameSideTotalBudget", self.same_side_total_budget),
        ] {
            if !value.is_finite() || value <= 0.0 || value > maximum {
                let unit = match self.mode {
                    PositionSizingMode::FixedUsdt => "a finite positive USDT amount",
                    PositionSizingMode::EquityPercent => "a finite percentage above zero and at most 100",
                };
                return Err(SystematicError::invalid_argument(field, unit));
            }
        }
        if self.per_entry_budget > self.same_side_total_budget {
            return Err(SystematicError::invalid_argument(
                "perEntryBudget",
                "must not exceed sameSideTotalBudget",
            ));
        }
        Ok(())
    }

    pub fn budgets_for_equity(&self, equity_usdt: f64) -> Result<(f64, f64), SystematicError> {
        self.validate()?;
        if !equity_usdt.is_finite() || equity_usdt <= 0.0 {
            return Err(SystematicError::invalid_argument(
                "equityUsdt",
                "must be a finite positive USDT amount",
            ));
        }
        let multiplier = match self.mode {
            PositionSizingMode::FixedUsdt => 1.0,
            PositionSizingMode::EquityPercent => equity_usdt / 100.0,
        };
        Ok((
            self.per_entry_budget * multiplier,
            self.same_side_total_budget * multiplier,
        ))
    }
}

/// Converts the remaining host-owned margin budget to a legal linear USDT
/// perpetual contract count. The count is always rounded down to `lot_size`;
/// a minimum-order shortfall is rejected instead of being rounded up past the
/// configured risk budget.
pub fn resolve_position_sizing(
    sizing: PositionSizing,
    contract: InstrumentContract,
    leverage: f64,
    equity_usdt: f64,
    current_same_side_contracts: f64,
    execution_price: f64,
) -> Result<PositionSizingResolution, SystematicError> {
    sizing.validate()?;
    for (field, value) in [
        ("contractValue", contract.contract_value),
        ("minSize", contract.min_size),
        ("lotSize", contract.lot_size),
        ("leverage", leverage),
        ("executionPrice", execution_price),
    ] {
        if !value.is_finite() || value <= 0.0 {
            return Err(SystematicError::invalid_argument(
                field,
                "must be a finite positive value",
            ));
        }
    }
    if !current_same_side_contracts.is_finite() || current_same_side_contracts < 0.0 {
        return Err(SystematicError::invalid_argument(
            "currentSameSideContracts",
            "must be a finite non-negative contract count",
        ));
    }
    let (entry_budget_usdt, same_side_total_budget_usdt) = sizing.budgets_for_equity(equity_usdt)?;
    let margin_per_contract = contract.contract_value * execution_price / leverage;
    let current_same_side_margin_usdt = current_same_side_contracts * margin_per_contract;
    let remaining_total_budget = same_side_total_budget_usdt - current_same_side_margin_usdt;
    if remaining_total_budget <= STEP_ALIGNMENT_EPSILON {
        return Err(SystematicError::InvalidState {
            reason: "same-side position budget is already fully used".to_string(),
        });
    }
    let allowed_margin = entry_budget_usdt.min(remaining_total_budget);
    let raw_contracts = allowed_margin / margin_per_contract;
    let contracts = ((raw_contracts / contract.lot_size) + STEP_ALIGNMENT_EPSILON).floor()
        * contract.lot_size;
    if !contracts.is_finite() || contracts + STEP_ALIGNMENT_EPSILON < contract.min_size {
        let minimum_margin = contract.min_size * margin_per_contract;
        return Err(SystematicError::InvalidState {
            reason: format!(
                "entry budget is below this contract's minimum order: at least {minimum_margin:.8} USDT initial margin is required"
            ),
        });
    }
    let estimated_initial_margin_usdt = contracts * margin_per_contract;
    Ok(PositionSizingResolution {
        contracts,
        estimated_initial_margin_usdt,
        entry_budget_usdt,
        same_side_total_budget_usdt,
        current_same_side_margin_usdt,
    })
}

/// Resolves an opening size for a historical backtest.
///
/// Insufficient remaining margin or a budget below the instrument minimum do
/// not invalidate the simulation. They are returned as `Skipped` so callers
/// can retain an auditable no-action event and continue processing later bars.
/// The stricter [`resolve_position_sizing`] API remains available to live
/// Profile execution, where the host records a blocked action instead.
pub fn resolve_backtest_position_sizing(
    sizing: PositionSizing,
    contract: InstrumentContract,
    leverage: f64,
    equity_usdt: f64,
    current_same_side_contracts: f64,
    execution_price: f64,
) -> Result<BacktestPositionSizingOutcome, SystematicError> {
    match resolve_position_sizing(
        sizing,
        contract,
        leverage,
        equity_usdt,
        current_same_side_contracts,
        execution_price,
    ) {
        Ok(resolution) => Ok(BacktestPositionSizingOutcome::Sized(resolution)),
        Err(SystematicError::InvalidState { reason }) => {
            Ok(BacktestPositionSizingOutcome::Skipped { reason })
        }
        Err(error) => Err(error),
    }
}

fn legacy_default_leverage() -> f64 {
    1.0
}

fn legacy_default_margin_safety_multiplier() -> f64 {
    1.0
}

impl Default for ExecutionAssumptions {
    fn default() -> Self {
        Self {
            entry_slippage_bps: 2.0,
            exit_slippage_bps: 2.0,
            entry_fee_rate: 0.0005,
            exit_fee_rate: 0.0005,
        }
    }
}

/// A historical perpetual funding observation. Positive rates charge longs and
/// credit shorts; negative rates do the opposite. For a minute bar, funding is
/// conservatively applied after an opening fill and before intrabar protective
/// exits whenever the event timestamp falls in that bar.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FundingEvent {
    pub timestamp_ms: i64,
    pub rate: f64,
}

/// Immutable input for one reproducible historical run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BacktestRequest {
    pub run_id: String,
    pub strategy_id: String,
    pub strategy_version: String,
    pub package_hash: String,
    pub data_snapshot_id: String,
    pub inst_id: String,
    pub bars: Vec<ClosedBar>,
    #[serde(default)]
    pub funding_events: Vec<FundingEvent>,
    pub initial_equity_usdt: f64,
    pub contract: InstrumentContract,
    pub execution: ExecutionAssumptions,
    #[serde(default)]
    pub margin: MarginAssumptions,
    #[serde(default)]
    pub position_sizing: PositionSizing,
    /// Confirmed bars loaded strictly before the evaluation range. They are
    /// visible to the first strategy decision but never enter the report's
    /// equity curve, replay, or performance statistics.
    #[serde(default, alias = "warmupBars")]
    pub preload_bars: usize,
    #[serde(default)]
    pub end_of_run_policy: EndOfRunPolicy,
}

/// Whether a backtest finished every eligible minute or was cooperatively
/// cancelled. A cancelled report is deterministic for the processed prefix and
/// intentionally not eligible for publication as a complete backtest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BacktestStatus {
    Completed,
    Cancelled,
}

/// Buy/sell direction of a simulated fill.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FillSide {
    Buy,
    Sell,
}

/// Why the engine generated a fill. Protective ambiguity always chooses
/// `ProtectiveStop` when a one-minute bar reaches both stop and take profit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FillReason {
    TargetIncrease,
    TargetDecrease,
    TargetFlipExit,
    TargetFlipEntry,
    /// A normal limit entry filled under the conservative 1m OHLCV model.
    LimitEntry,
    /// A normal limit exit filled under the conservative 1m OHLCV model.
    LimitExit,
    ProtectiveStop,
    ProtectiveTakeProfit,
    MarginExhaustion,
    EndOfRunClose,
}

/// A conservative simulated fill. `raw_price` is the next-bar open or stop/TP
/// trigger price before directional slippage; `fill_price` includes slippage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fill {
    pub time_ms: i64,
    pub inst_id: String,
    pub side: FillSide,
    pub quantity: f64,
    pub raw_price: f64,
    pub fill_price: f64,
    #[serde(default)]
    pub notional_usdt: f64,
    pub fee_usdt: f64,
    /// Positive when an opening fill freezes more collateral and negative
    /// when a closing fill releases it.
    #[serde(default)]
    pub margin_delta_usdt: f64,
    #[serde(default)]
    pub margin_after_usdt: f64,
    pub reason: FillReason,
}

/// One realized closed (or partially closed) paper position fragment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedTrade {
    pub strategy_id: String,
    pub inst_id: String,
    pub side: TradeSide,
    pub quantity: f64,
    pub entry_time_ms: i64,
    pub exit_time_ms: i64,
    pub entry_price: f64,
    pub exit_price: f64,
    #[serde(default)]
    pub entry_notional_usdt: f64,
    #[serde(default)]
    pub exit_notional_usdt: f64,
    #[serde(default)]
    pub used_margin_usdt: f64,
    #[serde(default = "legacy_default_leverage")]
    pub leverage: f64,
    #[serde(default = "legacy_default_margin_safety_multiplier")]
    pub margin_safety_multiplier: f64,
    pub gross_pnl_usdt: f64,
    pub entry_fee_usdt: f64,
    pub exit_fee_usdt: f64,
    pub funding_cashflow_usdt: f64,
    pub net_pnl_usdt: f64,
    pub exit_reason: FillReason,
}

/// A funding cashflow attributed to the currently open position.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FundingPayment {
    pub timestamp_ms: i64,
    pub inst_id: String,
    pub position_quantity: f64,
    pub rate: f64,
    pub mark_price: f64,
    pub cashflow_usdt: f64,
}

/// An equity observation after fills, funding, and conservative intrabar exits
/// for one closed minute.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EquityPoint {
    pub time_ms: i64,
    pub equity_usdt: f64,
    pub realized_cash_usdt: f64,
    pub unrealized_pnl_usdt: f64,
}

/// Immutable account and ledger boundary at the end of a confirmed bar. The
/// counts deliberately point into the report's append-only collections so a
/// replay consumer can render the exact historical prefix without attempting
/// to infer it from fill timestamps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaySnapshot {
    pub time_ms: i64,
    pub equity_usdt: f64,
    pub cash_usdt: f64,
    pub unrealized_pnl_usdt: f64,
    #[serde(default)]
    pub used_margin_usdt: f64,
    #[serde(default)]
    pub available_margin_usdt: f64,
    pub fill_count: usize,
    pub closed_trade_count: usize,
    pub funding_payment_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<OpenPositionSummary>,
}

/// A strategy callback and its current-time output. Keeping every decision
/// makes an external result reproducible and explains why a run did not trade.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyEvent {
    pub as_of_ms: i64,
    pub decision: StrategyDecision,
}

/// The explicit stateful-strategy action requested at a closed-bar cutoff.
/// It is kept alongside the translated paper intent so result consumers can
/// distinguish an intent target from the original strategy instruction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyActionEvent {
    pub as_of_ms: i64,
    pub action: StrategyAction,
}

/// A non-trading strategy signal preserved separately for research UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalRecord {
    pub as_of_ms: i64,
    pub signal: StrategySignal,
}

/// An intent that had no following one-minute opening bar, or whose run was
/// cancelled before the engine could simulate it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnfilledIntent {
    pub submitted_at_ms: i64,
    pub intent: PaperIntent,
    pub reason: String,
}

/// Lifecycle state of a strategy-owned normal order in the paper engine.
/// Limit results are intentionally an OHLCV-based estimate, never a claim
/// about exchange queue priority or tick-by-tick liquidity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaperOrderStatus {
    Open,
    PartiallyFilled,
    Filled,
    Cancelled,
    Expired,
    Rejected,
}

/// An auditable normal-order state transition. `Open` and
/// `PartiallyFilled` rows are also supplied to Python as
/// `ctx.portfolio.open_orders` at the next callback.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOrderSummary {
    pub id: String,
    pub inst_id: String,
    pub action: String,
    pub order_type: StrategyOrderType,
    pub quantity: f64,
    pub filled_quantity: f64,
    pub status: PaperOrderStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_price: Option<f64>,
    pub submitted_at_ms: i64,
    pub updated_at_ms: i64,
    pub reason: String,
}

/// Open-position valuation left by a mark-to-market run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPositionSummary {
    pub strategy_id: String,
    pub inst_id: String,
    pub side: TradeSide,
    pub quantity: f64,
    pub entry_time_ms: i64,
    pub average_entry_price: f64,
    pub marked_price: f64,
    #[serde(default)]
    pub contract_value: f64,
    #[serde(default)]
    pub notional_usdt: f64,
    #[serde(default)]
    pub used_margin_usdt: f64,
    #[serde(default = "legacy_default_leverage")]
    pub leverage: f64,
    #[serde(default = "legacy_default_margin_safety_multiplier")]
    pub margin_safety_multiplier: f64,
    pub unrealized_pnl_usdt: f64,
    pub entry_fee_usdt: f64,
    pub funding_cashflow_usdt: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_loss: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub take_profit: Option<f64>,
}

/// The paper-only account state visible to a stateful strategy callback. It
/// contains no exchange account data and is valued at the current bar close.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualPortfolio {
    pub initial_equity_usdt: f64,
    pub cash_usdt: f64,
    pub equity_usdt: f64,
    pub unrealized_pnl_usdt: f64,
    pub used_margin_usdt: f64,
    pub available_margin_usdt: f64,
    #[serde(default)]
    pub open_orders: Vec<OpenOrderSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<OpenPositionSummary>,
}

/// Serializable stateful strategy input used by managed runners. The engine
/// creates it only from data visible at the active closed-bar cutoff.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyContextSnapshot {
    pub market: CurrentDataSnapshot,
    pub portfolio: VirtualPortfolio,
    pub fills: Vec<Fill>,
    pub closed_trades: Vec<ClosedTrade>,
    pub funding_payments: Vec<FundingPayment>,
}

/// Borrowed current-time view passed to a stateful strategy. Its market
/// window, virtual position, fills, and closed trades are all constrained to
/// the active event; no field can expose a later historical bar or fill.
#[derive(Debug)]
pub struct StrategyContext<'a> {
    market: &'a MarketDataWindow,
    portfolio: VirtualPortfolio,
    fills: &'a [Fill],
    closed_trades: &'a [ClosedTrade],
    funding_payments: &'a [FundingPayment],
}

impl<'a> StrategyContext<'a> {
    /// Creates a bounded point-in-time context for a managed runtime adapter.
    /// Callers must construct the market window from only bars closed at the
    /// supplied cutoff and must not add future fills or account state.
    pub fn from_snapshot(
        market: &'a MarketDataWindow,
        portfolio: VirtualPortfolio,
        fills: &'a [Fill],
        closed_trades: &'a [ClosedTrade],
        funding_payments: &'a [FundingPayment],
    ) -> Self {
        Self::new(market, portfolio, fills, closed_trades, funding_payments)
    }

    fn new(
        market: &'a MarketDataWindow,
        portfolio: VirtualPortfolio,
        fills: &'a [Fill],
        closed_trades: &'a [ClosedTrade],
        funding_payments: &'a [FundingPayment],
    ) -> Self {
        Self {
            market,
            portfolio,
            fills,
            closed_trades,
            funding_payments,
        }
    }

    pub fn market(&self) -> &MarketDataWindow {
        self.market
    }

    pub fn portfolio(&self) -> &VirtualPortfolio {
        &self.portfolio
    }

    pub fn fills(&self) -> &[Fill] {
        self.fills
    }

    pub fn closed_trades(&self) -> &[ClosedTrade] {
        self.closed_trades
    }

    pub fn funding_payments(&self) -> &[FundingPayment] {
        self.funding_payments
    }

    pub fn snapshot(&self) -> StrategyContextSnapshot {
        StrategyContextSnapshot {
            market: self.market.snapshot(),
            portfolio: self.portfolio.clone(),
            fills: self.fills.to_vec(),
            closed_trades: self.closed_trades.to_vec(),
            funding_payments: self.funding_payments.to_vec(),
        }
    }
}

/// Summary metrics with explicit cost and unrealized-PnL components.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BacktestMetrics {
    pub initial_equity_usdt: f64,
    pub final_equity_usdt: f64,
    pub net_pnl_usdt: f64,
    pub gross_pnl_usdt: f64,
    pub realized_gross_pnl_usdt: f64,
    pub unrealized_pnl_usdt: f64,
    pub fees_usdt: f64,
    pub funding_cashflow_usdt: f64,
    pub max_drawdown_usdt: f64,
    pub max_drawdown_pct: f64,
    pub closed_trade_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub win_rate: Option<f64>,
}

/// Supplemental, reproducible strategy-evaluation statistics. Return-based
/// figures annualize one-minute equity returns with a zero risk-free rate;
/// consumers should label that assumption instead of presenting these values
/// as a forecast.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BacktestStatistics {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annualized_sharpe: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annualized_sortino: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annualized_volatility_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profit_factor: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expectancy_usdt: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub average_win_usdt: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub average_loss_usdt: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payoff_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub average_holding_ms: Option<i64>,
    pub exposure_pct: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub largest_win_usdt: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub largest_loss_usdt: Option<f64>,
    pub max_consecutive_wins: usize,
    pub max_consecutive_losses: usize,
}

/// Inputs which must accompany any report imported, shared, or compared in a
/// community registry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReproducibilityMetadata {
    pub run_id: String,
    pub strategy_id: String,
    pub strategy_version: String,
    pub package_hash: String,
    pub data_snapshot_id: String,
    pub request_hash: String,
    /// Absent on reports produced before preloaded-history semantics existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preload_start_time_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preload_bar_count: Option<usize>,
    pub start_time_ms: i64,
    pub end_time_ms: i64,
    pub processed_bar_count: usize,
}

/// Full deterministic result. `report_hash` is SHA-256 of canonical JSON for
/// this report with the hash field blanked, so it is stable without depending
/// on wall-clock execution time or a database-generated ID.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BacktestReport {
    pub schema_version: String,
    pub status: BacktestStatus,
    pub reproducibility: ReproducibilityMetadata,
    pub execution: ExecutionAssumptions,
    #[serde(default)]
    pub margin: MarginAssumptions,
    pub metrics: BacktestMetrics,
    pub equity_curve: Vec<EquityPoint>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub replay_snapshots: Vec<ReplaySnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub statistics: Option<BacktestStatistics>,
    pub fills: Vec<Fill>,
    pub closed_trades: Vec<ClosedTrade>,
    pub funding_payments: Vec<FundingPayment>,
    pub strategy_events: Vec<StrategyEvent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub strategy_actions: Vec<StrategyActionEvent>,
    /// Complete normal-order state history. Limit fills carry the explicit
    /// OHLCV-conservative assumption in `limit_order_fill_model`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub order_events: Vec<OpenOrderSummary>,
    #[serde(default = "default_limit_order_fill_model")]
    pub limit_order_fill_model: String,
    pub signals: Vec<SignalRecord>,
    pub unfilled_intents: Vec<UnfilledIntent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_position: Option<OpenPositionSummary>,
    pub report_hash: String,
}

fn default_limit_order_fill_model() -> String {
    "kline_conservative_estimate".to_string()
}

impl BacktestReport {
    pub fn deterministic_hash(&self) -> Result<String, SystematicError> {
        let mut canonical = self.clone();
        canonical.report_hash.clear();
        hash_value(&canonical)
    }

    pub fn has_valid_hash(&self) -> Result<bool, SystematicError> {
        Ok(self.report_hash == self.deterministic_hash()?)
    }
}

/// Result wrapper used by background workers. Cancellation is a completed,
/// inspectable outcome rather than a discarded error, allowing the UI to show
/// partial data while correctly labelling it non-final.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BacktestRunResult {
    pub status: BacktestStatus,
    pub report: BacktestReport,
    /// Non-deterministic diagnostics are intentionally excluded from the
    /// persisted report and its reproducibility hash.
    #[serde(skip)]
    pub timing: BacktestTiming,
}

/// Coarse phase timings for one engine run, expressed in microseconds.
///
/// These values are diagnostic only. They are kept outside [`BacktestReport`]
/// so wall-clock differences cannot change a report's deterministic hash.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BacktestTiming {
    pub setup_us: u64,
    pub simulation_us: u64,
    pub strategy_callback_us: u64,
    pub report_build_us: u64,
    pub strategy_callback_count: u64,
}

/// Stateless deterministic minute-backtest engine.
#[derive(Debug, Default, Clone, Copy)]
pub struct BacktestEngine;

impl BacktestEngine {
    pub fn run<S: EventDrivenStrategy>(
        request: &BacktestRequest,
        strategy: &mut S,
        cancellation: &CancellationToken,
    ) -> Result<BacktestRunResult, SystematicError> {
        Self::run_with_progress(request, strategy, cancellation, |_, _| {})
    }

    /// Runs a deterministic backtest and reports coarse, monotonic progress.
    /// The callback is intentionally invoked at most once per 256 bars (plus
    /// completion/cancellation), so application layers can persist and emit
    /// status without turning long minute-data runs into database-event churn.
    pub fn run_with_progress<S, F>(
        request: &BacktestRequest,
        strategy: &mut S,
        cancellation: &CancellationToken,
        mut on_progress: F,
    ) -> Result<BacktestRunResult, SystematicError>
    where
        S: EventDrivenStrategy,
        F: FnMut(u64, u64),
    {
        Self::run_with_progress_internal(
            request,
            cancellation,
            |completed, total| on_progress(completed, total),
            "1",
            |market, _state| {
                Ok(CallbackOutcome {
                    decision: strategy.on_bar(market)?,
                    action: None,
                })
            },
        )
    }

    /// Runs a stateful paper backtest. The callback receives only the current
    /// closed-bar market window plus the virtual portfolio, fills, and closed
    /// trades known at that same cutoff. Its action is queued for the following
    /// one-minute opening fill just like legacy paper intents.
    pub fn run_stateful<S: StatefulEventDrivenStrategy>(
        request: &BacktestRequest,
        strategy: &mut S,
        cancellation: &CancellationToken,
    ) -> Result<BacktestRunResult, SystematicError> {
        Self::run_stateful_with_progress(request, strategy, cancellation, |_, _| {})
    }

    /// Stateful equivalent of [`Self::run_with_progress`]. Independent runs
    /// may be scheduled concurrently by application code, while this method
    /// keeps one strategy's timeline strictly serial.
    pub fn run_stateful_with_progress<S, F>(
        request: &BacktestRequest,
        strategy: &mut S,
        cancellation: &CancellationToken,
        mut on_progress: F,
    ) -> Result<BacktestRunResult, SystematicError>
    where
        S: StatefulEventDrivenStrategy,
        F: FnMut(u64, u64),
    {
        let incremental_ledger_batch = strategy.uses_incremental_ledger_batch();
        let inst_id: Arc<str> = request.inst_id.as_str().into();
        let mut queued_actions = VecDeque::<(i64, StrategyAction)>::new();
        Self::run_with_progress_internal(
            request,
            cancellation,
            |completed, total| on_progress(completed, total),
            "2",
            |market, state| {
                let context = StrategyContext::new(
                    market,
                    virtual_portfolio(request, state, market.latest_bar().close),
                    &state.fills,
                    &state.closed_trades,
                    &state.funding_payments,
                );
                let action = if let Some((as_of_ms, action)) = queued_actions.pop_front() {
                    if as_of_ms != context.market().as_of_ms() {
                        return Err(SystematicError::InvalidState {
                            reason: "strategy batch output was out of order".to_string(),
                        });
                    }
                    if !matches!(action, StrategyAction::NoAction { .. }) {
                        queued_actions.clear();
                    }
                    action
                } else {
                    let current_index = request
                        .bars
                        .partition_point(|bar| bar.close_time_ms <= context.market().as_of_ms())
                        .checked_sub(1);
                    // A managed runtime may shrink its next batch after an
                    // early action, avoiding speculative event construction
                    // and IPC payloads it knows will be discarded.
                    let batch_size = strategy.no_action_batch_size().clamp(1, 64);
                    let can_batch = batch_size > 1
                        && current_index.is_some_and(|index| index >= request.preload_bars)
                        && state.position.is_none()
                        && state.open_orders.is_empty();
                    if can_batch {
                        let current_index = current_index.expect("batch index was checked");
                        let end = (current_index + batch_size).min(request.bars.len());
                        let mut snapshots = Vec::with_capacity(end - current_index);
                        // Each batch event only needs the bars new since the
                        // previous dispatch. The engine cursor already
                        // validated the full window once; snapshotting the
                        // whole visible window per event would re-copy the
                        // entire evaluation range on every batch (O(n) per
                        // event) and dominate the IPC round-trip savings.
                        let mut incremental_bars: Vec<ClosedBar> =
                            Vec::with_capacity(end - current_index);
                        for index in current_index..end {
                            let bar = &request.bars[index];
                            let include_ledger = index == current_index || !incremental_ledger_batch;
                            incremental_bars.push(bar.clone());
                            snapshots.push(StrategyContextSnapshot {
                                market: CurrentDataSnapshot {
                                    inst_id: inst_id.to_string(),
                                    as_of_ms: bar.close_time_ms,
                                    interval_ms: ONE_MINUTE_MS,
                                    bars: incremental_bars.clone(),
                                    features: BTreeMap::new(),
                                },
                                portfolio: virtual_portfolio(request, state, bar.close),
                                fills: if include_ledger { state.fills.clone() } else { Vec::new() },
                                closed_trades: if include_ledger { state.closed_trades.clone() } else { Vec::new() },
                                funding_payments: if include_ledger { state.funding_payments.clone() } else { Vec::new() },
                            });
                        }
                        let outputs = strategy.on_bar_batch(&snapshots)?;
                        if outputs.is_empty() || outputs.len() > snapshots.len() {
                            return Err(SystematicError::InvalidState {
                                reason: "strategy batch returned an invalid output count".to_string(),
                            });
                        }
                        let mut first_action_index = None;
                        for (index, output) in outputs.iter().enumerate() {
                            if !matches!(output, StrategyAction::NoAction { .. }) {
                                first_action_index = Some(index);
                                break;
                            }
                        }
                        let retained = first_action_index.map_or(outputs.len(), |index| index + 1);
                        for index in 0..retained {
                            queued_actions.push_back((
                                snapshots[index].market.as_of_ms,
                                outputs[index].clone(),
                            ));
                        }
                        queued_actions
                            .pop_front()
                            .map(|(_, action)| action)
                            .expect("a non-empty strategy batch must queue its first output")
                    } else {
                        strategy.on_bar(&context)?
                    }
                };
                let decision = decision_for_action(request, &context, &action)?;
                Ok(CallbackOutcome {
                    decision,
                    action: Some(action),
                })
            },
        )
    }

    fn run_with_progress_internal<F, P>(
        request: &BacktestRequest,
        cancellation: &CancellationToken,
        mut on_progress: P,
        schema_version: &str,
        mut on_bar: F,
    ) -> Result<BacktestRunResult, SystematicError>
    where
        F: FnMut(&MarketDataWindow, &SimulationState) -> Result<CallbackOutcome, SystematicError>,
        P: FnMut(u64, u64),
    {
        let setup_started = Instant::now();
        validate_request(request)?;
        let request_hash = hash_value(request)?;
        let bars: Arc<[ClosedBar]> = Arc::from(request.bars.clone());
        let inst_id: Arc<str> = request.inst_id.as_str().into();
        let total_steps = request.bars.len() as u64;
        let evaluation_steps = request.bars.len().saturating_sub(request.preload_bars);
        let mut state = SimulationState::new(request.initial_equity_usdt, evaluation_steps);
        let setup_us = elapsed_micros(setup_started);
        let mut funding_index = 0usize;
        let mut pending_intent: Option<PendingIntent> = None;
        let mut pending_strategy_actions = Vec::<PendingStrategyAction>::new();
        let mut status = BacktestStatus::Completed;
        let mut processed_input_count = 0usize;
        let simulation_started = Instant::now();
        let mut strategy_callback_us = 0_u64;
        let mut strategy_callback_count = 0_u64;

        for (index, bar) in request.bars.iter().enumerate() {
            if cancellation.is_cancelled() {
                status = BacktestStatus::Cancelled;
                on_progress(index as u64, total_steps);
                break;
            }

            let is_evaluation_bar = index >= request.preload_bars;
            if is_evaluation_bar {
                if let Some(pending) = pending_intent.take() {
                    apply_intent_at_open(request, &mut state, pending.intent, bar)?;
                }

                apply_pending_strategy_actions_at_open(
                    request,
                    &mut state,
                    &mut pending_strategy_actions,
                    bar,
                )?;
                apply_funding_through_bar(request, &mut state, bar, &mut funding_index)?;
                apply_protective_exit(request, &mut state, bar)?;
                apply_open_limit_orders(request, &mut state, bar)?;

                let unrealized =
                    unrealized_pnl(state.position.as_ref(), bar.close, request.contract);
                let equity_point = EquityPoint {
                    time_ms: bar.close_time_ms,
                    equity_usdt: state.cash_usdt + unrealized,
                    realized_cash_usdt: state.cash_usdt,
                    unrealized_pnl_usdt: unrealized,
                };
                let replay_snapshot =
                    replay_snapshot(request, &state, bar.close_time_ms, bar.close, unrealized);
                state.equity_curve.push(equity_point);
                state.replay_snapshots.push(replay_snapshot);
            }

            // The final preloaded bar closes exactly at evaluation start. It
            // may produce a signal that fills at the following evaluation-bar
            // open, while the preloaded history itself remains outside all
            // performance and replay outputs.
            let should_dispatch = is_evaluation_bar || index + 1 == request.preload_bars;
            if should_dispatch {
                let context = MarketDataWindow::for_backtest(
                    &inst_id,
                    bar.close_time_ms,
                    ONE_MINUTE_MS,
                    Arc::clone(&bars),
                    index + 1,
                )?;
                let callback_started = Instant::now();
                let callback = on_bar(&context, &state)?;
                strategy_callback_us = strategy_callback_us
                    .saturating_add(elapsed_micros(callback_started));
                strategy_callback_count = strategy_callback_count.saturating_add(1);
                let decision = callback.decision;
                decision.validate_for(&context)?;
                let mut stateful_action = false;
                if let Some(action) = callback.action {
                    state.strategy_actions.push(StrategyActionEvent {
                        as_of_ms: context.as_of_ms(),
                        action: action.clone(),
                    });
                    pending_strategy_actions.push(PendingStrategyAction {
                        submitted_at_ms: context.as_of_ms(),
                        action,
                    });
                    stateful_action = true;
                }
                state.strategy_events.push(StrategyEvent {
                    as_of_ms: context.as_of_ms(),
                    decision: decision.clone(),
                });
                match decision {
                    StrategyDecision::NoAction { .. } => {}
                    StrategyDecision::Signal { signal } => state.signals.push(SignalRecord {
                        as_of_ms: context.as_of_ms(),
                        signal,
                    }),
                    StrategyDecision::PaperIntent { intent } if !stateful_action => {
                        pending_intent = Some(PendingIntent {
                            submitted_at_ms: context.as_of_ms(),
                            intent,
                        });
                    }
                    StrategyDecision::PaperIntent { .. } => {}
                }
            }

            let completed_steps = (index + 1) as u64;
            processed_input_count = index + 1;
            if completed_steps % 256 == 0 || completed_steps == total_steps {
                on_progress(completed_steps, total_steps);
            }
        }

        let simulation_us = elapsed_micros(simulation_started);
        let processed_count = state.equity_curve.len();
        let last_bar = processed_count
            .checked_sub(1)
            .and_then(|index| request.bars.get(request.preload_bars + index));

        if let Some(pending) = pending_intent {
            let reason = if status == BacktestStatus::Cancelled {
                "run cancelled before the next one-minute opening fill"
            } else {
                "no following one-minute bar was available for the scheduled opening fill"
            };
            state.unfilled_intents.push(UnfilledIntent {
                submitted_at_ms: pending.submitted_at_ms,
                intent: pending.intent,
                reason: reason.to_string(),
            });
        }
        expire_open_paper_orders(request, &mut state, &mut pending_strategy_actions, status);

        if status == BacktestStatus::Completed
            && request.end_of_run_policy == EndOfRunPolicy::CloseAtLastClose
        {
            if let Some(last_bar) = last_bar {
                close_entire_position(
                    request,
                    &mut state,
                    last_bar.close_time_ms,
                    last_bar.close,
                    FillReason::EndOfRunClose,
                )?;
                if let Some(last_point) = state.equity_curve.last_mut() {
                    last_point.equity_usdt = state.cash_usdt;
                    last_point.realized_cash_usdt = state.cash_usdt;
                    last_point.unrealized_pnl_usdt = 0.0;
                }
                let snapshot =
                    replay_snapshot(request, &state, last_bar.close_time_ms, last_bar.close, 0.0);
                if let Some(last_snapshot) = state.replay_snapshots.last_mut() {
                    *last_snapshot = snapshot;
                }
            }
        }

        let marked_price = last_bar.map(|bar| bar.close);
        let report_started = Instant::now();
        let report = build_report(
            request,
            request_hash,
            status,
            state,
            marked_price,
            schema_version,
        )?;
        let report_build_us = elapsed_micros(report_started);
        on_progress(processed_input_count as u64, total_steps);
        Ok(BacktestRunResult {
            status,
            report,
            timing: BacktestTiming {
                setup_us,
                simulation_us,
                strategy_callback_us,
                report_build_us,
                strategy_callback_count,
            },
        })
    }
}

fn elapsed_micros(started: Instant) -> u64 {
    started.elapsed().as_micros().min(u128::from(u64::MAX)) as u64
}

#[derive(Debug)]
struct CallbackOutcome {
    decision: StrategyDecision,
    action: Option<StrategyAction>,
}

#[derive(Debug, Clone)]
struct PendingIntent {
    submitted_at_ms: i64,
    intent: PaperIntent,
}

#[derive(Debug, Clone)]
struct PendingStrategyAction {
    submitted_at_ms: i64,
    action: StrategyAction,
}

#[derive(Debug, Clone)]
struct OpenPaperOrder {
    summary: OpenOrderSummary,
    action: StrategyAction,
}

#[derive(Debug, Clone)]
struct OpenPosition {
    strategy_id: String,
    quantity: f64,
    entry_time_ms: i64,
    average_entry_price: f64,
    entry_fee_usdt: f64,
    funding_cashflow_usdt: f64,
    used_margin_usdt: f64,
    stop_loss: Option<f64>,
    take_profit: Option<f64>,
}

impl OpenPosition {
    fn side(&self) -> TradeSide {
        if self.quantity > 0.0 {
            TradeSide::Long
        } else {
            TradeSide::Short
        }
    }

    fn absolute_quantity(&self) -> f64 {
        self.quantity.abs()
    }
}

#[derive(Debug)]
struct SimulationState {
    cash_usdt: f64,
    position: Option<OpenPosition>,
    fills: Vec<Fill>,
    closed_trades: Vec<ClosedTrade>,
    funding_payments: Vec<FundingPayment>,
    equity_curve: Vec<EquityPoint>,
    replay_snapshots: Vec<ReplaySnapshot>,
    strategy_events: Vec<StrategyEvent>,
    strategy_actions: Vec<StrategyActionEvent>,
    open_orders: Vec<OpenPaperOrder>,
    order_events: Vec<OpenOrderSummary>,
    next_order_sequence: u64,
    signals: Vec<SignalRecord>,
    unfilled_intents: Vec<UnfilledIntent>,
}

impl SimulationState {
    fn new(initial_equity_usdt: f64, evaluation_steps: usize) -> Self {
        Self {
            cash_usdt: initial_equity_usdt,
            position: None,
            fills: Vec::new(),
            closed_trades: Vec::new(),
            funding_payments: Vec::new(),
            equity_curve: Vec::with_capacity(evaluation_steps),
            replay_snapshots: Vec::with_capacity(evaluation_steps),
            // The final preloaded bar can dispatch one additional strategy
            // event before the evaluation curve begins.
            strategy_events: Vec::with_capacity(evaluation_steps.saturating_add(1)),
            strategy_actions: Vec::new(),
            open_orders: Vec::new(),
            order_events: Vec::new(),
            next_order_sequence: 1,
            signals: Vec::new(),
            unfilled_intents: Vec::new(),
        }
    }
}

fn virtual_portfolio(
    request: &BacktestRequest,
    state: &SimulationState,
    marked_price: f64,
) -> VirtualPortfolio {
    let unrealized_pnl_usdt =
        unrealized_pnl(state.position.as_ref(), marked_price, request.contract);
    let equity_usdt = state.cash_usdt + unrealized_pnl_usdt;
    let used_margin_usdt = state
        .position
        .as_ref()
        .map(|position| position.used_margin_usdt)
        .unwrap_or(0.0);
    VirtualPortfolio {
        initial_equity_usdt: request.initial_equity_usdt,
        cash_usdt: state.cash_usdt,
        equity_usdt,
        unrealized_pnl_usdt,
        used_margin_usdt,
        available_margin_usdt: (equity_usdt - used_margin_usdt).max(0.0),
        open_orders: state
            .open_orders
            .iter()
            .map(|order| order.summary.clone())
            .collect(),
        position: state.position.as_ref().map(|position| {
            open_position_summary(request, position, marked_price, unrealized_pnl_usdt)
        }),
    }
}

fn decision_for_action(
    request: &BacktestRequest,
    context: &StrategyContext<'_>,
    action: &StrategyAction,
) -> Result<StrategyDecision, SystematicError> {
    action.validate()?;
    match action {
        StrategyAction::NoAction { reason } => Ok(StrategyDecision::NoAction {
            reason: reason.clone(),
        }),
        StrategyAction::OpenLong {
            quantity,
            execution,
            stop_loss,
            take_profit,
            reason,
            diagnostics,
        } => open_action_decision(
            request,
            context,
            TradeSide::Long,
            *quantity,
            execution.clone(),
            *stop_loss,
            *take_profit,
            reason,
            diagnostics,
        ),
        StrategyAction::OpenShort {
            quantity,
            execution,
            stop_loss,
            take_profit,
            reason,
            diagnostics,
        } => open_action_decision(
            request,
            context,
            TradeSide::Short,
            *quantity,
            execution.clone(),
            *stop_loss,
            *take_profit,
            reason,
            diagnostics,
        ),
        StrategyAction::CloseLong {
            quantity,
            execution,
            reason,
            diagnostics,
        } => close_action_decision(
            request,
            context,
            TradeSide::Long,
            *quantity,
            execution.clone(),
            reason,
            diagnostics,
        ),
        StrategyAction::CloseShort {
            quantity,
            execution,
            reason,
            diagnostics,
        } => close_action_decision(
            request,
            context,
            TradeSide::Short,
            *quantity,
            execution.clone(),
            reason,
            diagnostics,
        ),
        StrategyAction::SetProtection {
            stop_loss,
            take_profit,
            reason,
            diagnostics,
        } => protection_action_decision(
            request,
            context,
            *stop_loss,
            *take_profit,
            reason,
            diagnostics,
        ),
        StrategyAction::CancelProtection {
            reason,
            diagnostics,
        } => protection_action_decision(
            request,
            context,
            Some(None),
            Some(None),
            reason,
            diagnostics,
        ),
        StrategyAction::CancelOrder { reason, .. } => Ok(StrategyDecision::NoAction {
            reason: Some(format!("{reason}: order cancellation is handled by the stateful order queue")),
        }),
    }
}

fn protection_action_decision(
    request: &BacktestRequest,
    context: &StrategyContext<'_>,
    stop_loss: Option<Option<f64>>,
    take_profit: Option<Option<f64>>,
    reason: &str,
    diagnostics: &BTreeMap<String, f64>,
) -> Result<StrategyDecision, SystematicError> {
    let Some(position) = context.portfolio().position.as_ref() else {
        return Ok(StrategyDecision::NoAction {
            reason: Some(format!("{reason}: no virtual position is open")),
        });
    };
    let stop_loss = stop_loss.unwrap_or(position.stop_loss);
    let take_profit = take_profit.unwrap_or(position.take_profit);
    Ok(StrategyDecision::PaperIntent {
        intent: PaperIntent {
            strategy_id: request.strategy_id.clone(),
            inst_id: request.inst_id.clone(),
            as_of_ms: context.market().as_of_ms(),
            target_quantity: position.side.sign() * position.quantity,
            stop_loss,
            take_profit,
            execution: StrategyExecution::default(),
            reason: reason.to_string(),
            diagnostics: diagnostics.clone(),
        },
    })
}

#[allow(clippy::too_many_arguments)]
fn open_action_decision(
    request: &BacktestRequest,
    context: &StrategyContext<'_>,
    side: TradeSide,
    quantity: f64,
    execution: StrategyExecution,
    stop_loss: Option<f64>,
    take_profit: Option<f64>,
    reason: &str,
    diagnostics: &BTreeMap<String, f64>,
) -> Result<StrategyDecision, SystematicError> {
    let (target_quantity, stop_loss, take_profit) = match context.portfolio().position.as_ref() {
        Some(position) if position.side == side => (
            side.sign() * (position.quantity + quantity),
            stop_loss.or(position.stop_loss),
            take_profit.or(position.take_profit),
        ),
        Some(position) => {
            return Err(SystematicError::output_contract(format!(
                "cannot open {} while a virtual {} position is still open; emit the matching close action first",
                action_side_name(side),
                action_side_name(position.side),
            )));
        }
        None => (side.sign() * quantity, stop_loss, take_profit),
    };
    validate_target_quantity(target_quantity, request.contract)?;
    Ok(StrategyDecision::PaperIntent {
        intent: PaperIntent {
            strategy_id: request.strategy_id.clone(),
            inst_id: request.inst_id.clone(),
            as_of_ms: context.market().as_of_ms(),
            target_quantity,
            stop_loss,
            take_profit,
            execution,
            reason: reason.to_string(),
            diagnostics: diagnostics.clone(),
        },
    })
}

fn close_action_decision(
    request: &BacktestRequest,
    context: &StrategyContext<'_>,
    side: TradeSide,
    quantity: f64,
    execution: StrategyExecution,
    reason: &str,
    diagnostics: &BTreeMap<String, f64>,
) -> Result<StrategyDecision, SystematicError> {
    let Some(position) = context.portfolio().position.as_ref() else {
        return Ok(StrategyDecision::NoAction {
            reason: Some(format!(
                "{reason}: no virtual {} position is open",
                action_side_name(side)
            )),
        });
    };
    if position.side != side {
        return Ok(StrategyDecision::NoAction {
            reason: Some(format!(
                "{reason}: virtual portfolio holds {}, not {}",
                action_side_name(position.side),
                action_side_name(side),
            )),
        });
    }
    if quantity > position.quantity + STEP_ALIGNMENT_EPSILON {
        return Err(SystematicError::output_contract(format!(
            "cannot close {quantity} {} contracts when the virtual portfolio holds {}",
            action_side_name(side),
            position.quantity,
        )));
    }
    validate_target_quantity(quantity, request.contract)?;
    let remaining_quantity = (position.quantity - quantity).max(0.0);
    let target_quantity = side.sign() * remaining_quantity;
    Ok(StrategyDecision::PaperIntent {
        intent: PaperIntent {
            strategy_id: request.strategy_id.clone(),
            inst_id: request.inst_id.clone(),
            as_of_ms: context.market().as_of_ms(),
            target_quantity,
            stop_loss: if target_quantity == 0.0 {
                None
            } else {
                position.stop_loss
            },
            take_profit: if target_quantity == 0.0 {
                None
            } else {
                position.take_profit
            },
            execution,
            reason: reason.to_string(),
            diagnostics: diagnostics.clone(),
        },
    })
}

fn action_side_name(side: TradeSide) -> &'static str {
    match side {
        TradeSide::Long => "long",
        TradeSide::Short => "short",
    }
}

fn validate_request(request: &BacktestRequest) -> Result<(), SystematicError> {
    for (field, value) in [
        ("runId", &request.run_id),
        ("strategyId", &request.strategy_id),
        ("strategyVersion", &request.strategy_version),
        ("packageHash", &request.package_hash),
        ("dataSnapshotId", &request.data_snapshot_id),
        ("instId", &request.inst_id),
    ] {
        if value.trim().is_empty() || value.len() > 256 {
            return Err(SystematicError::invalid_argument(
                field,
                "must contain 1 to 256 non-whitespace bytes",
            ));
        }
    }
    if !request.initial_equity_usdt.is_finite() || request.initial_equity_usdt <= 0.0 {
        return Err(SystematicError::invalid_argument(
            "initialEquityUsdt",
            "must be finite and greater than zero",
        ));
    }
    if request.preload_bars >= request.bars.len() {
        return Err(SystematicError::invalid_argument(
            "preloadBars",
            "must leave at least one one-minute evaluation bar",
        ));
    }
    validate_visible_bars(
        &request.bars,
        request.bars.len(),
        request
            .bars
            .last()
            .map(|bar| bar.close_time_ms)
            .unwrap_or_default(),
        ONE_MINUTE_MS,
        true,
    )?;
    validate_contract(request.contract)?;
    validate_execution(request.execution)?;
    validate_margin(request.margin)?;
    let mut previous_funding_time = None;
    for event in &request.funding_events {
        if event.timestamp_ms < 0 || !event.rate.is_finite() {
            return Err(SystematicError::invalid_argument(
                "fundingEvents",
                "timestamps must be non-negative and rates must be finite",
            ));
        }
        if let Some(previous) = previous_funding_time {
            if event.timestamp_ms <= previous {
                return Err(SystematicError::data_contract(
                    "funding events must be strictly ordered by timestamp",
                ));
            }
        }
        previous_funding_time = Some(event.timestamp_ms);
    }
    Ok(())
}

fn validate_margin(margin: MarginAssumptions) -> Result<(), SystematicError> {
    if !margin.leverage.is_finite() || !(1.0..=50.0).contains(&margin.leverage) {
        return Err(SystematicError::invalid_argument(
            "leverage",
            "must be finite and between 1 and 50",
        ));
    }
    if !margin.margin_safety_multiplier.is_finite()
        || !(1.0..=20.0).contains(&margin.margin_safety_multiplier)
    {
        return Err(SystematicError::invalid_argument(
            "marginSafetyMultiplier",
            "must be finite and between 1 and 20",
        ));
    }
    Ok(())
}

fn validate_contract(contract: InstrumentContract) -> Result<(), SystematicError> {
    for (field, value) in [
        ("contractValue", contract.contract_value),
        ("minSize", contract.min_size),
        ("lotSize", contract.lot_size),
    ] {
        if !value.is_finite() || value <= 0.0 {
            return Err(SystematicError::invalid_argument(
                field,
                "must be finite and greater than zero",
            ));
        }
    }
    if !is_step_aligned(contract.min_size, contract.lot_size) {
        return Err(SystematicError::invalid_argument(
            "minSize",
            "must align to lotSize",
        ));
    }
    Ok(())
}

fn validate_execution(execution: ExecutionAssumptions) -> Result<(), SystematicError> {
    for (field, value) in [
        ("entrySlippageBps", execution.entry_slippage_bps),
        ("exitSlippageBps", execution.exit_slippage_bps),
    ] {
        if !value.is_finite() || !(0.0..=10_000.0).contains(&value) {
            return Err(SystematicError::invalid_argument(
                field,
                "must be finite and between zero and 10,000 basis points",
            ));
        }
    }
    for (field, value) in [
        ("entryFeeRate", execution.entry_fee_rate),
        ("exitFeeRate", execution.exit_fee_rate),
    ] {
        if !value.is_finite() || !(0.0..=1.0).contains(&value) {
            return Err(SystematicError::invalid_argument(
                field,
                "must be finite and between zero and one",
            ));
        }
    }
    Ok(())
}

const LIMIT_ORDER_MAX_BAR_VOLUME_PARTICIPATION: f64 = 0.10;

fn apply_pending_strategy_actions_at_open(
    request: &BacktestRequest,
    state: &mut SimulationState,
    pending_actions: &mut Vec<PendingStrategyAction>,
    bar: &ClosedBar,
) -> Result<(), SystematicError> {
    let actions = std::mem::take(pending_actions);
    for pending in actions {
        match &pending.action {
            StrategyAction::NoAction { .. } => {}
            StrategyAction::SetProtection {
                stop_loss,
                take_profit,
                ..
            } => {
                if let Some(position) = state.position.as_mut() {
                    if let Some(value) = stop_loss {
                        position.stop_loss = *value;
                    }
                    if let Some(value) = take_profit {
                        position.take_profit = *value;
                    }
                }
            }
            StrategyAction::CancelProtection { .. } => {
                if let Some(position) = state.position.as_mut() {
                    position.stop_loss = None;
                    position.take_profit = None;
                }
            }
            StrategyAction::CancelOrder { order_id, reason, .. } => {
                if let Some(index) = state
                    .open_orders
                    .iter()
                    .position(|order| order.summary.id == *order_id)
                {
                    let mut cancelled = state.open_orders.remove(index).summary;
                    cancelled.status = PaperOrderStatus::Cancelled;
                    cancelled.updated_at_ms = bar.open_time_ms;
                    cancelled.reason = reason.clone();
                    state.order_events.push(cancelled);
                }
            }
            StrategyAction::OpenLong { execution, .. }
            | StrategyAction::OpenShort { execution, .. }
            | StrategyAction::CloseLong { execution, .. }
            | StrategyAction::CloseShort { execution, .. } => match execution.order_type {
                StrategyOrderType::Market => {
                    let _ = apply_strategy_action_fill(
                        request,
                        state,
                        &pending.action,
                        action_quantity(&pending.action).unwrap_or_default(),
                        bar.open_time_ms,
                        bar.open,
                        false,
                    )?;
                }
                StrategyOrderType::Limit => {
                    let quantity = action_quantity(&pending.action).unwrap_or_default();
                    let limit_price = execution.limit_price.ok_or_else(|| {
                        SystematicError::output_contract("limit action has no limit price")
                    })?;
                    let id = format!(
                        "paper-order-{}-{}",
                        pending.submitted_at_ms, state.next_order_sequence
                    );
                    state.next_order_sequence = state.next_order_sequence.saturating_add(1);
                    let summary = OpenOrderSummary {
                        id,
                        inst_id: request.inst_id.clone(),
                        action: strategy_action_name(&pending.action).to_string(),
                        order_type: StrategyOrderType::Limit,
                        quantity,
                        filled_quantity: 0.0,
                        status: PaperOrderStatus::Open,
                        limit_price: Some(limit_price),
                        submitted_at_ms: pending.submitted_at_ms,
                        updated_at_ms: bar.open_time_ms,
                        reason: strategy_action_reason(&pending.action).to_string(),
                    };
                    state.order_events.push(summary.clone());
                    state.open_orders.push(OpenPaperOrder {
                        summary,
                        action: pending.action,
                    });
                }
            },
        }
    }
    Ok(())
}

fn apply_open_limit_orders(
    request: &BacktestRequest,
    state: &mut SimulationState,
    bar: &ClosedBar,
) -> Result<(), SystematicError> {
    let mut remaining_volume = (bar.volume * LIMIT_ORDER_MAX_BAR_VOLUME_PARTICIPATION).max(0.0);
    let mut still_open = Vec::with_capacity(state.open_orders.len());
    for mut order in std::mem::take(&mut state.open_orders) {
        let Some(limit_price) = order.summary.limit_price else {
            order.summary.status = PaperOrderStatus::Rejected;
            order.summary.updated_at_ms = bar.close_time_ms;
            order.summary.reason = "limit order has no price".to_string();
            state.order_events.push(order.summary);
            continue;
        };
        if !limit_price_reached(&order.action, limit_price, bar) {
            still_open.push(order);
            continue;
        }
        let remaining_quantity = (order.summary.quantity - order.summary.filled_quantity).max(0.0);
        let candidate = align_down_to_lot(
            remaining_quantity.min(remaining_volume),
            request.contract.lot_size,
        );
        if candidate + STEP_ALIGNMENT_EPSILON < request.contract.min_size {
            still_open.push(order);
            continue;
        }
        let filled = apply_strategy_action_fill(
            request,
            state,
            &order.action,
            candidate,
            bar.close_time_ms,
            limit_price,
            true,
        )?;
        if filled <= STEP_ALIGNMENT_EPSILON {
            still_open.push(order);
            continue;
        }
        remaining_volume = (remaining_volume - filled).max(0.0);
        order.summary.filled_quantity = (order.summary.filled_quantity + filled).min(order.summary.quantity);
        order.summary.updated_at_ms = bar.close_time_ms;
        if order.summary.quantity - order.summary.filled_quantity <= STEP_ALIGNMENT_EPSILON {
            order.summary.status = PaperOrderStatus::Filled;
            state.order_events.push(order.summary);
        } else {
            order.summary.status = PaperOrderStatus::PartiallyFilled;
            state.order_events.push(order.summary.clone());
            still_open.push(order);
        }
    }
    state.open_orders = still_open;
    Ok(())
}

fn apply_strategy_action_fill(
    request: &BacktestRequest,
    state: &mut SimulationState,
    action: &StrategyAction,
    quantity: f64,
    time_ms: i64,
    raw_price: f64,
    is_limit: bool,
) -> Result<f64, SystematicError> {
    if quantity <= STEP_ALIGNMENT_EPSILON {
        return Ok(0.0);
    }
    let (entry_slippage, exit_slippage) = if is_limit {
        (0.0, 0.0)
    } else {
        (
            request.execution.entry_slippage_bps,
            request.execution.exit_slippage_bps,
        )
    };
    match action {
        StrategyAction::OpenLong {
            stop_loss,
            take_profit,
            reason,
            diagnostics,
            ..
        } => {
            if state.position.as_ref().is_some_and(|position| position.side() == TradeSide::Short) {
                return Ok(0.0);
            }
            let intent = PaperIntent {
                strategy_id: request.strategy_id.clone(),
                inst_id: request.inst_id.clone(),
                as_of_ms: time_ms,
                target_quantity: quantity,
                stop_loss: *stop_loss,
                take_profit: *take_profit,
                execution: StrategyExecution::default(),
                reason: reason.clone(),
                diagnostics: diagnostics.clone(),
            };
            let fill_count_before = state.fills.len();
            open_or_increase_position(
                request,
                state,
                &intent,
                quantity,
                time_ms,
                raw_price,
                if is_limit { FillReason::LimitEntry } else { FillReason::TargetIncrease },
                entry_slippage,
            )?;
            Ok(if state.fills.len() > fill_count_before { quantity } else { 0.0 })
        }
        StrategyAction::OpenShort {
            stop_loss,
            take_profit,
            reason,
            diagnostics,
            ..
        } => {
            if state.position.as_ref().is_some_and(|position| position.side() == TradeSide::Long) {
                return Ok(0.0);
            }
            let intent = PaperIntent {
                strategy_id: request.strategy_id.clone(),
                inst_id: request.inst_id.clone(),
                as_of_ms: time_ms,
                target_quantity: -quantity,
                stop_loss: *stop_loss,
                take_profit: *take_profit,
                execution: StrategyExecution::default(),
                reason: reason.clone(),
                diagnostics: diagnostics.clone(),
            };
            let fill_count_before = state.fills.len();
            open_or_increase_position(
                request,
                state,
                &intent,
                -quantity,
                time_ms,
                raw_price,
                if is_limit { FillReason::LimitEntry } else { FillReason::TargetIncrease },
                entry_slippage,
            )?;
            Ok(if state.fills.len() > fill_count_before { quantity } else { 0.0 })
        }
        StrategyAction::CloseLong { .. } => {
            let available = state
                .position
                .as_ref()
                .filter(|position| position.side() == TradeSide::Long)
                .map(OpenPosition::absolute_quantity)
                .unwrap_or(0.0);
            let filled = quantity.min(available);
            if filled <= STEP_ALIGNMENT_EPSILON {
                return Ok(0.0);
            }
            close_position_quantity(
                request,
                state,
                filled,
                time_ms,
                raw_price,
                if is_limit { FillReason::LimitExit } else { FillReason::TargetDecrease },
                exit_slippage,
            )?;
            Ok(filled)
        }
        StrategyAction::CloseShort { .. } => {
            let available = state
                .position
                .as_ref()
                .filter(|position| position.side() == TradeSide::Short)
                .map(OpenPosition::absolute_quantity)
                .unwrap_or(0.0);
            let filled = quantity.min(available);
            if filled <= STEP_ALIGNMENT_EPSILON {
                return Ok(0.0);
            }
            close_position_quantity(
                request,
                state,
                filled,
                time_ms,
                raw_price,
                if is_limit { FillReason::LimitExit } else { FillReason::TargetDecrease },
                exit_slippage,
            )?;
            Ok(filled)
        }
        _ => Ok(0.0),
    }
}

fn action_quantity(action: &StrategyAction) -> Option<f64> {
    match action {
        StrategyAction::OpenLong { quantity, .. }
        | StrategyAction::OpenShort { quantity, .. }
        | StrategyAction::CloseLong { quantity, .. }
        | StrategyAction::CloseShort { quantity, .. } => Some(*quantity),
        _ => None,
    }
}

fn strategy_action_name(action: &StrategyAction) -> &'static str {
    match action {
        StrategyAction::OpenLong { .. } => "open_long",
        StrategyAction::OpenShort { .. } => "open_short",
        StrategyAction::CloseLong { .. } => "close_long",
        StrategyAction::CloseShort { .. } => "close_short",
        StrategyAction::SetProtection { .. } => "set_protection",
        StrategyAction::CancelProtection { .. } => "cancel_protection",
        StrategyAction::CancelOrder { .. } => "cancel_order",
        StrategyAction::NoAction { .. } => "no_action",
    }
}

fn strategy_action_reason(action: &StrategyAction) -> &str {
    match action {
        StrategyAction::OpenLong { reason, .. }
        | StrategyAction::OpenShort { reason, .. }
        | StrategyAction::CloseLong { reason, .. }
        | StrategyAction::CloseShort { reason, .. }
        | StrategyAction::SetProtection { reason, .. }
        | StrategyAction::CancelProtection { reason, .. }
        | StrategyAction::CancelOrder { reason, .. } => reason,
        StrategyAction::NoAction { reason } => reason.as_deref().unwrap_or_default(),
    }
}

fn limit_price_reached(action: &StrategyAction, limit_price: f64, bar: &ClosedBar) -> bool {
    match action {
        StrategyAction::OpenLong { .. } | StrategyAction::CloseShort { .. } => {
            bar.open < limit_price || bar.low < limit_price
        }
        StrategyAction::OpenShort { .. } | StrategyAction::CloseLong { .. } => {
            bar.open > limit_price || bar.high > limit_price
        }
        _ => false,
    }
}

fn align_down_to_lot(quantity: f64, lot_size: f64) -> f64 {
    if !quantity.is_finite() || !lot_size.is_finite() || lot_size <= 0.0 {
        return 0.0;
    }
    (quantity / lot_size).floor() * lot_size
}

fn expire_open_paper_orders(
    request: &BacktestRequest,
    state: &mut SimulationState,
    pending_actions: &mut Vec<PendingStrategyAction>,
    status: BacktestStatus,
) {
    let reason = if status == BacktestStatus::Cancelled {
        "backtest cancelled before order completion"
    } else {
        "backtest range ended before order completion"
    };
    for mut order in std::mem::take(&mut state.open_orders) {
        order.summary.status = PaperOrderStatus::Expired;
        order.summary.reason = reason.to_string();
        state.order_events.push(order.summary);
    }
    for pending in std::mem::take(pending_actions) {
        if let Some(quantity) = action_quantity(&pending.action) {
            state.order_events.push(OpenOrderSummary {
                id: format!("paper-order-{}-queued", pending.submitted_at_ms),
                inst_id: request.inst_id.clone(),
                action: strategy_action_name(&pending.action).to_string(),
                order_type: match &pending.action {
                    StrategyAction::OpenLong { execution, .. }
                    | StrategyAction::OpenShort { execution, .. }
                    | StrategyAction::CloseLong { execution, .. }
                    | StrategyAction::CloseShort { execution, .. } => execution.order_type,
                    _ => StrategyOrderType::Market,
                },
                quantity,
                filled_quantity: 0.0,
                status: PaperOrderStatus::Expired,
                limit_price: match &pending.action {
                    StrategyAction::OpenLong { execution, .. }
                    | StrategyAction::OpenShort { execution, .. }
                    | StrategyAction::CloseLong { execution, .. }
                    | StrategyAction::CloseShort { execution, .. } => execution.limit_price,
                    _ => None,
                },
                submitted_at_ms: pending.submitted_at_ms,
                updated_at_ms: pending.submitted_at_ms,
                reason: reason.to_string(),
            });
        }
    }
}

fn apply_intent_at_open(
    request: &BacktestRequest,
    state: &mut SimulationState,
    intent: PaperIntent,
    bar: &ClosedBar,
) -> Result<(), SystematicError> {
    validate_target_quantity(intent.target_quantity, request.contract)?;
    let current_quantity = state
        .position
        .as_ref()
        .map(|position| position.quantity)
        .unwrap_or(0.0);
    let target_quantity = intent.target_quantity;

    if approximately_equal(current_quantity, target_quantity) {
        if let Some(position) = state.position.as_mut() {
            position.strategy_id = intent.strategy_id;
            position.stop_loss = intent.stop_loss;
            position.take_profit = intent.take_profit;
        }
        return Ok(());
    }

    if current_quantity == 0.0 {
        open_or_increase_position(
            request,
            state,
            &intent,
            target_quantity,
            bar.open_time_ms,
            bar.open,
            FillReason::TargetIncrease,
            request.execution.entry_slippage_bps,
        )?;
        return Ok(());
    }

    if target_quantity == 0.0 {
        close_position_quantity(
            request,
            state,
            current_quantity.abs(),
            bar.open_time_ms,
            bar.open,
            FillReason::TargetDecrease,
            request.execution.exit_slippage_bps,
        )?;
        return Ok(());
    }

    if current_quantity.signum() == target_quantity.signum() {
        let current_abs = current_quantity.abs();
        let target_abs = target_quantity.abs();
        if target_abs > current_abs {
            open_or_increase_position(
                request,
                state,
                &intent,
                target_quantity - current_quantity,
                bar.open_time_ms,
                bar.open,
                FillReason::TargetIncrease,
                request.execution.entry_slippage_bps,
            )?;
        } else {
            close_position_quantity(
                request,
                state,
                current_abs - target_abs,
                bar.open_time_ms,
                bar.open,
                FillReason::TargetDecrease,
                request.execution.exit_slippage_bps,
            )?;
            if let Some(position) = state.position.as_mut() {
                position.strategy_id = intent.strategy_id;
                position.stop_loss = intent.stop_loss;
                position.take_profit = intent.take_profit;
            }
        }
        return Ok(());
    }

    close_position_quantity(
        request,
        state,
        current_quantity.abs(),
        bar.open_time_ms,
        bar.open,
        FillReason::TargetFlipExit,
        request.execution.exit_slippage_bps,
    )?;
    open_or_increase_position(
        request,
        state,
        &intent,
        target_quantity,
        bar.open_time_ms,
        bar.open,
        FillReason::TargetFlipEntry,
        request.execution.entry_slippage_bps,
    )
}

fn open_or_increase_position(
    request: &BacktestRequest,
    state: &mut SimulationState,
    intent: &PaperIntent,
    quantity_delta: f64,
    time_ms: i64,
    raw_price: f64,
    reason: FillReason,
    slippage_bps: f64,
) -> Result<(), SystematicError> {
    if quantity_delta == 0.0 {
        return Ok(());
    }
    let side = fill_side_for_delta(quantity_delta);
    let fill_price = apply_slippage(raw_price, side, slippage_bps)?;
    let quantity = quantity_delta.abs();
    let notional = notional_usdt(quantity, fill_price, request.contract);
    let required_margin = required_margin_usdt(notional, request.margin);
    let fee = notional * request.execution.entry_fee_rate;
    let current_unrealized = unrealized_pnl(state.position.as_ref(), raw_price, request.contract);
    let current_used_margin = state
        .position
        .as_ref()
        .map(|position| position.used_margin_usdt)
        .unwrap_or(0.0);
    let available_margin = (state.cash_usdt + current_unrealized - current_used_margin).max(0.0);
    if required_margin + fee > available_margin + STEP_ALIGNMENT_EPSILON {
        state.unfilled_intents.push(UnfilledIntent {
            submitted_at_ms: intent.as_of_ms,
            intent: intent.clone(),
            reason: format!(
                "insufficient available isolated margin: requires {:.8} USDT including fees, has {:.8} USDT",
                required_margin + fee,
                available_margin
            ),
        });
        return Ok(());
    }
    state.cash_usdt -= fee;
    state.fills.push(Fill {
        time_ms,
        inst_id: request.inst_id.clone(),
        side,
        quantity,
        raw_price,
        fill_price,
        notional_usdt: notional,
        fee_usdt: fee,
        margin_delta_usdt: required_margin,
        margin_after_usdt: current_used_margin + required_margin,
        reason,
    });

    match state.position.as_mut() {
        Some(position) => {
            let previous_quantity = position.absolute_quantity();
            let new_quantity = previous_quantity + quantity;
            position.average_entry_price = (position.average_entry_price * previous_quantity
                + fill_price * quantity)
                / new_quantity;
            position.quantity += quantity_delta;
            position.entry_fee_usdt += fee;
            position.used_margin_usdt += required_margin;
            position.strategy_id = intent.strategy_id.clone();
            position.stop_loss = intent.stop_loss;
            position.take_profit = intent.take_profit;
        }
        None => {
            state.position = Some(OpenPosition {
                strategy_id: intent.strategy_id.clone(),
                quantity: quantity_delta,
                entry_time_ms: time_ms,
                average_entry_price: fill_price,
                entry_fee_usdt: fee,
                funding_cashflow_usdt: 0.0,
                used_margin_usdt: required_margin,
                stop_loss: intent.stop_loss,
                take_profit: intent.take_profit,
            });
        }
    }
    Ok(())
}

fn close_position_quantity(
    request: &BacktestRequest,
    state: &mut SimulationState,
    quantity_to_close: f64,
    time_ms: i64,
    raw_price: f64,
    reason: FillReason,
    slippage_bps: f64,
) -> Result<(), SystematicError> {
    let Some(position) = state.position.as_ref() else {
        return Ok(());
    };
    if !quantity_to_close.is_finite()
        || quantity_to_close <= 0.0
        || quantity_to_close > position.absolute_quantity() + STEP_ALIGNMENT_EPSILON
    {
        return Err(SystematicError::InvalidState {
            reason: "attempted to close an invalid paper-position quantity".to_string(),
        });
    }

    let position_snapshot = position.clone();
    let signed_closed_quantity = position_snapshot.side().sign() * quantity_to_close;
    let side = fill_side_for_delta(-signed_closed_quantity);
    let fill_price = apply_slippage(raw_price, side, slippage_bps)?;
    let exit_fee = notional_usdt(quantity_to_close, fill_price, request.contract)
        * request.execution.exit_fee_rate;
    let allocation = quantity_to_close / position_snapshot.absolute_quantity();
    let allocated_entry_fee = position_snapshot.entry_fee_usdt * allocation;
    let allocated_funding = position_snapshot.funding_cashflow_usdt * allocation;
    let allocated_margin = position_snapshot.used_margin_usdt * allocation;
    let gross_pnl = signed_closed_quantity
        * request.contract.contract_value
        * (fill_price - position_snapshot.average_entry_price);
    let net_pnl = gross_pnl - allocated_entry_fee - exit_fee + allocated_funding;
    state.cash_usdt += gross_pnl - exit_fee;
    state.fills.push(Fill {
        time_ms,
        inst_id: request.inst_id.clone(),
        side,
        quantity: quantity_to_close,
        raw_price,
        fill_price,
        notional_usdt: notional_usdt(quantity_to_close, fill_price, request.contract),
        fee_usdt: exit_fee,
        margin_delta_usdt: -allocated_margin,
        margin_after_usdt: (position_snapshot.used_margin_usdt - allocated_margin).max(0.0),
        reason,
    });
    state.closed_trades.push(ClosedTrade {
        strategy_id: position_snapshot.strategy_id.clone(),
        inst_id: request.inst_id.clone(),
        side: position_snapshot.side(),
        quantity: quantity_to_close,
        entry_time_ms: position_snapshot.entry_time_ms,
        exit_time_ms: time_ms,
        entry_price: position_snapshot.average_entry_price,
        exit_price: fill_price,
        entry_notional_usdt: notional_usdt(
            quantity_to_close,
            position_snapshot.average_entry_price,
            request.contract,
        ),
        exit_notional_usdt: notional_usdt(quantity_to_close, fill_price, request.contract),
        used_margin_usdt: allocated_margin,
        leverage: request.margin.leverage,
        margin_safety_multiplier: request.margin.margin_safety_multiplier,
        gross_pnl_usdt: gross_pnl,
        entry_fee_usdt: allocated_entry_fee,
        exit_fee_usdt: exit_fee,
        funding_cashflow_usdt: allocated_funding,
        net_pnl_usdt: net_pnl,
        exit_reason: reason,
    });

    let remaining_quantity = position_snapshot.absolute_quantity() - quantity_to_close;
    if remaining_quantity <= STEP_ALIGNMENT_EPSILON {
        state.position = None;
    } else if let Some(position) = state.position.as_mut() {
        position.quantity = position_snapshot.side().sign() * remaining_quantity;
        position.entry_fee_usdt = position_snapshot.entry_fee_usdt - allocated_entry_fee;
        position.funding_cashflow_usdt =
            position_snapshot.funding_cashflow_usdt - allocated_funding;
        position.used_margin_usdt =
            (position_snapshot.used_margin_usdt - allocated_margin).max(0.0);
    }
    Ok(())
}

fn close_entire_position(
    request: &BacktestRequest,
    state: &mut SimulationState,
    time_ms: i64,
    raw_price: f64,
    reason: FillReason,
) -> Result<(), SystematicError> {
    let quantity = state
        .position
        .as_ref()
        .map(OpenPosition::absolute_quantity)
        .unwrap_or(0.0);
    if quantity > 0.0 {
        close_position_quantity(
            request,
            state,
            quantity,
            time_ms,
            raw_price,
            reason,
            request.execution.exit_slippage_bps,
        )?;
    }
    Ok(())
}

fn apply_funding_through_bar(
    request: &BacktestRequest,
    state: &mut SimulationState,
    bar: &ClosedBar,
    funding_index: &mut usize,
) -> Result<(), SystematicError> {
    while let Some(event) = request.funding_events.get(*funding_index) {
        if event.timestamp_ms > bar.close_time_ms {
            break;
        }
        if event.timestamp_ms >= bar.open_time_ms {
            if let Some(position) = state.position.as_mut() {
                let notional =
                    notional_usdt(position.absolute_quantity(), bar.open, request.contract);
                let cashflow = -position.quantity.signum() * event.rate * notional;
                state.cash_usdt += cashflow;
                position.funding_cashflow_usdt += cashflow;
                state.funding_payments.push(FundingPayment {
                    timestamp_ms: event.timestamp_ms,
                    inst_id: request.inst_id.clone(),
                    position_quantity: position.quantity,
                    rate: event.rate,
                    mark_price: bar.open,
                    cashflow_usdt: cashflow,
                });
            }
        }
        *funding_index += 1;
    }
    Ok(())
}

fn apply_protective_exit(
    request: &BacktestRequest,
    state: &mut SimulationState,
    bar: &ClosedBar,
) -> Result<(), SystematicError> {
    let Some(position) = state.position.as_ref() else {
        return Ok(());
    };
    // An opening gap can exhaust the virtual collateral before any configured
    // protection can be simulated. Once the open is viable, a triggered
    // stop/TP owns the position's intra-minute exit; otherwise a low/high
    // excursion may still force the conservative virtual-margin close.
    let selected = if margin_is_exhausted(request, position, bar.open) {
        Some((FillReason::MarginExhaustion, bar.open))
    } else {
        protective_exit(position, bar).or_else(|| margin_exhaustion_exit(request, position, bar))
    };
    let Some((reason, raw_price)) = selected else {
        return Ok(());
    };
    // A one-minute OHLC bar cannot provide an exact intrabar timestamp. Record
    // the protective fill at the completed bar boundary rather than falsely
    // claiming it happened at the opening tick.
    close_entire_position(request, state, bar.close_time_ms, raw_price, reason)
}

fn margin_exhaustion_exit(
    request: &BacktestRequest,
    position: &OpenPosition,
    bar: &ClosedBar,
) -> Option<(FillReason, f64)> {
    let adverse_price = match position.side() {
        TradeSide::Long => bar.low,
        TradeSide::Short => bar.high,
    };
    let trigger_price = if margin_is_exhausted(request, position, bar.open) {
        bar.open
    } else if margin_is_exhausted(request, position, adverse_price) {
        adverse_price
    } else {
        return None;
    };
    Some((FillReason::MarginExhaustion, trigger_price))
}

fn margin_is_exhausted(
    request: &BacktestRequest,
    position: &OpenPosition,
    mark_price: f64,
) -> bool {
    let unrealized = position.quantity
        * request.contract.contract_value
        * (mark_price - position.average_entry_price);
    let estimated_exit_fee =
        notional_usdt(position.absolute_quantity(), mark_price, request.contract)
            * request.execution.exit_fee_rate;
    position.used_margin_usdt + unrealized + position.funding_cashflow_usdt
        <= estimated_exit_fee + STEP_ALIGNMENT_EPSILON
}

fn protective_exit(position: &OpenPosition, bar: &ClosedBar) -> Option<(FillReason, f64)> {
    let (stop_trigger, take_profit_trigger) = match position.side() {
        TradeSide::Long => (
            position.stop_loss.map(|stop| {
                if bar.open <= stop {
                    bar.open
                } else if bar.low <= stop {
                    stop
                } else {
                    f64::NAN
                }
            }),
            position.take_profit.map(|take_profit| {
                if bar.open >= take_profit {
                    bar.open
                } else if bar.high >= take_profit {
                    take_profit
                } else {
                    f64::NAN
                }
            }),
        ),
        TradeSide::Short => (
            position.stop_loss.map(|stop| {
                if bar.open >= stop {
                    bar.open
                } else if bar.high >= stop {
                    stop
                } else {
                    f64::NAN
                }
            }),
            position.take_profit.map(|take_profit| {
                if bar.open <= take_profit {
                    bar.open
                } else if bar.low <= take_profit {
                    take_profit
                } else {
                    f64::NAN
                }
            }),
        ),
    };
    let stop_trigger = stop_trigger.filter(|price| price.is_finite());
    let take_profit_trigger = take_profit_trigger.filter(|price| price.is_finite());
    // Without tick order, a minute that reaches both thresholds is adverse:
    // choose the stop rather than fabricating a profitable TP-first sequence.
    match (stop_trigger, take_profit_trigger) {
        (Some(stop), _) => Some((FillReason::ProtectiveStop, stop)),
        (None, Some(take_profit)) => Some((FillReason::ProtectiveTakeProfit, take_profit)),
        (None, None) => None,
    }
}

fn build_report(
    request: &BacktestRequest,
    request_hash: String,
    status: BacktestStatus,
    state: SimulationState,
    marked_price: Option<f64>,
    schema_version: &str,
) -> Result<BacktestReport, SystematicError> {
    let unrealized = marked_price
        .map(|price| unrealized_pnl(state.position.as_ref(), price, request.contract))
        .unwrap_or(0.0);
    let final_equity = state.cash_usdt + unrealized;
    let realized_gross: f64 = state
        .closed_trades
        .iter()
        .map(|trade| trade.gross_pnl_usdt)
        .sum();
    let gross = realized_gross + unrealized;
    let fees: f64 = state.fills.iter().map(|fill| fill.fee_usdt).sum();
    let funding: f64 = state
        .funding_payments
        .iter()
        .map(|payment| payment.cashflow_usdt)
        .sum();
    let (max_drawdown_usdt, max_drawdown_pct) =
        max_drawdown(request.initial_equity_usdt, &state.equity_curve);
    let win_rate = if state.closed_trades.is_empty() {
        None
    } else {
        Some(
            state
                .closed_trades
                .iter()
                .filter(|trade| trade.net_pnl_usdt > 0.0)
                .count() as f64
                / state.closed_trades.len() as f64,
        )
    };
    let open_position = match (state.position.as_ref(), marked_price) {
        (Some(position), Some(marked_price)) => Some(open_position_summary(
            request,
            position,
            marked_price,
            unrealized,
        )),
        _ => None,
    };
    let preload_start_time_ms = request
        .bars
        .first()
        .map(|bar| bar.open_time_ms)
        .unwrap_or_default();
    let start_time_ms = request
        .bars
        .get(request.preload_bars)
        .map(|bar| bar.open_time_ms)
        .unwrap_or(preload_start_time_ms);
    let end_time_ms = state
        .equity_curve
        .last()
        .map(|point| point.time_ms)
        .unwrap_or(start_time_ms);
    let metrics = BacktestMetrics {
        initial_equity_usdt: request.initial_equity_usdt,
        final_equity_usdt: final_equity,
        net_pnl_usdt: final_equity - request.initial_equity_usdt,
        gross_pnl_usdt: gross,
        realized_gross_pnl_usdt: realized_gross,
        unrealized_pnl_usdt: unrealized,
        fees_usdt: fees,
        funding_cashflow_usdt: funding,
        max_drawdown_usdt,
        max_drawdown_pct,
        closed_trade_count: state.closed_trades.len(),
        win_rate,
    };
    let statistics = backtest_statistics(
        &state.equity_curve,
        &state.closed_trades,
        &state.replay_snapshots,
    );
    let mut report = BacktestReport {
        schema_version: schema_version.to_string(),
        status,
        reproducibility: ReproducibilityMetadata {
            run_id: request.run_id.clone(),
            strategy_id: request.strategy_id.clone(),
            strategy_version: request.strategy_version.clone(),
            package_hash: request.package_hash.clone(),
            data_snapshot_id: request.data_snapshot_id.clone(),
            request_hash,
            preload_start_time_ms: Some(preload_start_time_ms),
            preload_bar_count: Some(request.preload_bars),
            start_time_ms,
            end_time_ms,
            processed_bar_count: state.equity_curve.len(),
        },
        execution: request.execution,
        margin: request.margin,
        metrics,
        equity_curve: state.equity_curve,
        replay_snapshots: state.replay_snapshots,
        statistics: Some(statistics),
        fills: state.fills,
        closed_trades: state.closed_trades,
        funding_payments: state.funding_payments,
        strategy_events: state.strategy_events,
        strategy_actions: state.strategy_actions,
        order_events: state.order_events,
        limit_order_fill_model: default_limit_order_fill_model(),
        signals: state.signals,
        unfilled_intents: state.unfilled_intents,
        open_position,
        report_hash: String::new(),
    };
    report.report_hash = report.deterministic_hash()?;
    Ok(report)
}

fn replay_snapshot(
    request: &BacktestRequest,
    state: &SimulationState,
    time_ms: i64,
    marked_price: f64,
    unrealized_pnl_usdt: f64,
) -> ReplaySnapshot {
    let equity_usdt = state.cash_usdt + unrealized_pnl_usdt;
    let used_margin_usdt = state
        .position
        .as_ref()
        .map(|position| position.used_margin_usdt)
        .unwrap_or(0.0);
    ReplaySnapshot {
        time_ms,
        equity_usdt,
        cash_usdt: state.cash_usdt,
        unrealized_pnl_usdt,
        used_margin_usdt,
        available_margin_usdt: (equity_usdt - used_margin_usdt).max(0.0),
        fill_count: state.fills.len(),
        closed_trade_count: state.closed_trades.len(),
        funding_payment_count: state.funding_payments.len(),
        position: state.position.as_ref().map(|position| {
            open_position_summary(request, position, marked_price, unrealized_pnl_usdt)
        }),
    }
}

fn backtest_statistics(
    equity_curve: &[EquityPoint],
    closed_trades: &[ClosedTrade],
    replay_snapshots: &[ReplaySnapshot],
) -> BacktestStatistics {
    const MINUTES_PER_YEAR: f64 = 365.0 * 24.0 * 60.0;
    let returns = equity_curve
        .windows(2)
        .filter_map(|pair| {
            let previous = pair[0].equity_usdt;
            let current = pair[1].equity_usdt;
            (previous.is_finite() && previous > 0.0 && current.is_finite())
                .then_some(current / previous - 1.0)
        })
        .collect::<Vec<_>>();
    let (annualized_sharpe, annualized_volatility_pct) = if returns.len() >= 2 {
        let mean = returns.iter().sum::<f64>() / returns.len() as f64;
        let variance = returns
            .iter()
            .map(|value| (value - mean).powi(2))
            .sum::<f64>()
            / (returns.len() - 1) as f64;
        let deviation = variance.sqrt();
        if deviation > f64::EPSILON {
            (
                Some(mean / deviation * MINUTES_PER_YEAR.sqrt()),
                Some(deviation * MINUTES_PER_YEAR.sqrt() * 100.0),
            )
        } else {
            (None, Some(0.0))
        }
    } else {
        (None, None)
    };
    let annualized_sortino = if returns.len() >= 2 {
        let mean = returns.iter().sum::<f64>() / returns.len() as f64;
        let downside_variance = returns
            .iter()
            .map(|value| value.min(0.0).powi(2))
            .sum::<f64>()
            / returns.len() as f64;
        let downside_deviation = downside_variance.sqrt();
        if downside_deviation > f64::EPSILON {
            Some(mean / downside_deviation * MINUTES_PER_YEAR.sqrt())
        } else {
            None
        }
    } else {
        None
    };

    let wins = closed_trades
        .iter()
        .filter(|trade| trade.net_pnl_usdt > 0.0)
        .collect::<Vec<_>>();
    let losses = closed_trades
        .iter()
        .filter(|trade| trade.net_pnl_usdt < 0.0)
        .collect::<Vec<_>>();
    let gross_profit = wins.iter().map(|trade| trade.net_pnl_usdt).sum::<f64>();
    let gross_loss = losses
        .iter()
        .map(|trade| trade.net_pnl_usdt.abs())
        .sum::<f64>();
    let average_win_usdt = if wins.is_empty() {
        None
    } else {
        Some(gross_profit / wins.len() as f64)
    };
    let average_loss_usdt = if losses.is_empty() {
        None
    } else {
        Some(losses.iter().map(|trade| trade.net_pnl_usdt).sum::<f64>() / losses.len() as f64)
    };
    let profit_factor = if gross_loss > f64::EPSILON {
        Some(gross_profit / gross_loss)
    } else {
        None
    };
    let payoff_ratio = average_win_usdt
        .zip(average_loss_usdt)
        .and_then(|(win, loss)| {
            if loss.abs() > f64::EPSILON {
                Some(win / loss.abs())
            } else {
                None
            }
        });
    let expectancy_usdt = if closed_trades.is_empty() {
        None
    } else {
        Some(
            closed_trades
                .iter()
                .map(|trade| trade.net_pnl_usdt)
                .sum::<f64>()
                / closed_trades.len() as f64,
        )
    };
    let average_holding_ms = if closed_trades.is_empty() {
        None
    } else {
        Some(
            closed_trades
                .iter()
                .map(|trade| trade.exit_time_ms.saturating_sub(trade.entry_time_ms))
                .sum::<i64>()
                / closed_trades.len() as i64,
        )
    };
    let largest_win_usdt = wins
        .iter()
        .map(|trade| trade.net_pnl_usdt)
        .max_by(|left, right| left.total_cmp(right));
    let largest_loss_usdt = losses
        .iter()
        .map(|trade| trade.net_pnl_usdt)
        .min_by(|left, right| left.total_cmp(right));
    let (max_consecutive_wins, max_consecutive_losses) = consecutive_trade_streaks(closed_trades);
    let exposure_pct = if replay_snapshots.is_empty() {
        0.0
    } else {
        replay_snapshots
            .iter()
            .filter(|snapshot| snapshot.position.is_some())
            .count() as f64
            / replay_snapshots.len() as f64
            * 100.0
    };

    BacktestStatistics {
        annualized_sharpe,
        annualized_sortino,
        annualized_volatility_pct,
        profit_factor,
        expectancy_usdt,
        average_win_usdt,
        average_loss_usdt,
        payoff_ratio,
        average_holding_ms,
        exposure_pct,
        largest_win_usdt,
        largest_loss_usdt,
        max_consecutive_wins,
        max_consecutive_losses,
    }
}

fn consecutive_trade_streaks(closed_trades: &[ClosedTrade]) -> (usize, usize) {
    let mut current_wins = 0usize;
    let mut current_losses = 0usize;
    let mut max_wins = 0usize;
    let mut max_losses = 0usize;
    for trade in closed_trades {
        if trade.net_pnl_usdt > 0.0 {
            current_wins += 1;
            current_losses = 0;
            max_wins = max_wins.max(current_wins);
        } else if trade.net_pnl_usdt < 0.0 {
            current_losses += 1;
            current_wins = 0;
            max_losses = max_losses.max(current_losses);
        } else {
            current_wins = 0;
            current_losses = 0;
        }
    }
    (max_wins, max_losses)
}

fn open_position_summary(
    request: &BacktestRequest,
    position: &OpenPosition,
    marked_price: f64,
    unrealized_pnl_usdt: f64,
) -> OpenPositionSummary {
    OpenPositionSummary {
        strategy_id: position.strategy_id.clone(),
        inst_id: request.inst_id.clone(),
        side: position.side(),
        quantity: position.absolute_quantity(),
        entry_time_ms: position.entry_time_ms,
        average_entry_price: position.average_entry_price,
        marked_price,
        contract_value: request.contract.contract_value,
        notional_usdt: notional_usdt(position.absolute_quantity(), marked_price, request.contract),
        used_margin_usdt: position.used_margin_usdt,
        leverage: request.margin.leverage,
        margin_safety_multiplier: request.margin.margin_safety_multiplier,
        unrealized_pnl_usdt,
        entry_fee_usdt: position.entry_fee_usdt,
        funding_cashflow_usdt: position.funding_cashflow_usdt,
        stop_loss: position.stop_loss,
        take_profit: position.take_profit,
    }
}

fn validate_target_quantity(
    quantity: f64,
    contract: InstrumentContract,
) -> Result<(), SystematicError> {
    if !quantity.is_finite() {
        return Err(SystematicError::output_contract(
            "paper target quantity must be finite",
        ));
    }
    if quantity == 0.0 {
        return Ok(());
    }
    if quantity.abs() + STEP_ALIGNMENT_EPSILON < contract.min_size {
        return Err(SystematicError::output_contract(format!(
            "paper target quantity must be zero or at least the contract minimum {}",
            contract.min_size
        )));
    }
    if !is_step_aligned(quantity.abs(), contract.lot_size) {
        return Err(SystematicError::output_contract(format!(
            "paper target quantity {quantity} does not align to lot size {}",
            contract.lot_size
        )));
    }
    Ok(())
}

fn apply_slippage(
    raw_price: f64,
    side: FillSide,
    slippage_bps: f64,
) -> Result<f64, SystematicError> {
    let adjustment = slippage_bps / 10_000.0;
    let multiplier = match side {
        FillSide::Buy => 1.0 + adjustment,
        FillSide::Sell => 1.0 - adjustment,
    };
    let fill_price = raw_price * multiplier;
    if !fill_price.is_finite() || fill_price <= 0.0 {
        return Err(SystematicError::InvalidState {
            reason: "slippage assumptions produced a non-positive fill price".to_string(),
        });
    }
    Ok(fill_price)
}

fn fill_side_for_delta(quantity_delta: f64) -> FillSide {
    if quantity_delta > 0.0 {
        FillSide::Buy
    } else {
        FillSide::Sell
    }
}

fn notional_usdt(quantity: f64, price: f64, contract: InstrumentContract) -> f64 {
    quantity * price * contract.contract_value
}

fn required_margin_usdt(notional: f64, margin: MarginAssumptions) -> f64 {
    notional / margin.leverage * margin.margin_safety_multiplier
}

fn unrealized_pnl(
    position: Option<&OpenPosition>,
    mark_price: f64,
    contract: InstrumentContract,
) -> f64 {
    position
        .map(|position| {
            position.quantity
                * contract.contract_value
                * (mark_price - position.average_entry_price)
        })
        .unwrap_or(0.0)
}

fn max_drawdown(initial_equity: f64, curve: &[EquityPoint]) -> (f64, f64) {
    let mut peak = initial_equity;
    let mut max_drawdown_usdt: f64 = 0.0;
    let mut max_drawdown_pct: f64 = 0.0;
    for point in curve {
        peak = peak.max(point.equity_usdt);
        let drawdown = (peak - point.equity_usdt).max(0.0);
        max_drawdown_usdt = max_drawdown_usdt.max(drawdown);
        if peak > 0.0 {
            max_drawdown_pct = max_drawdown_pct.max(drawdown / peak);
        }
    }
    (max_drawdown_usdt, max_drawdown_pct)
}

fn is_step_aligned(value: f64, step: f64) -> bool {
    let ratio = value / step;
    (ratio - ratio.round()).abs() <= STEP_ALIGNMENT_EPSILON * ratio.abs().max(1.0)
}

fn approximately_equal(left: f64, right: f64) -> bool {
    (left - right).abs() <= STEP_ALIGNMENT_EPSILON * left.abs().max(right.abs()).max(1.0)
}

fn hash_value<T: Serialize>(value: &T) -> Result<String, SystematicError> {
    let bytes = serde_json::to_vec(value).map_err(|error| SystematicError::Serialization {
        reason: error.to_string(),
    })?;
    let digest = Sha256::digest(bytes);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ClosedBar, EventDrivenStrategy, PaperIntent, StatefulEventDrivenStrategy, StrategyAction,
        StrategyContext, StrategyDecision, SystematicError,
    };
    use std::collections::BTreeMap;

    fn bar(open_time_ms: i64, open: f64, high: f64, low: f64, close: f64) -> ClosedBar {
        ClosedBar::new(
            open_time_ms,
            open_time_ms + ONE_MINUTE_MS,
            open,
            high,
            low,
            close,
            10.0,
        )
        .unwrap()
    }

    fn request(bars: Vec<ClosedBar>) -> BacktestRequest {
        BacktestRequest {
            run_id: "run-fixture".to_string(),
            strategy_id: "fixture-strategy".to_string(),
            strategy_version: "1.0.0".to_string(),
            package_hash: "fixture-package-hash".to_string(),
            data_snapshot_id: "fixture-data-snapshot".to_string(),
            inst_id: "BTC-USDT-SWAP".to_string(),
            bars,
            funding_events: Vec::new(),
            initial_equity_usdt: 1_000.0,
            contract: InstrumentContract {
                contract_value: 1.0,
                min_size: 1.0,
                lot_size: 1.0,
            },
            execution: ExecutionAssumptions {
                entry_slippage_bps: 0.0,
                exit_slippage_bps: 0.0,
                entry_fee_rate: 0.0,
                exit_fee_rate: 0.0,
            },
            margin: MarginAssumptions::default(),
            position_sizing: PositionSizing::default(),
            preload_bars: 0,
            end_of_run_policy: EndOfRunPolicy::MarkToMarket,
        }
    }

    #[test]
    fn position_sizing_resolves_fixed_margin_to_contracts() {
        let result = resolve_position_sizing(
            PositionSizing {
                mode: PositionSizingMode::FixedUsdt,
                per_entry_budget: 100.0,
                same_side_total_budget: 200.0,
            },
            InstrumentContract {
                contract_value: 0.01,
                min_size: 1.0,
                lot_size: 1.0,
            },
            10.0,
            10_000.0,
            0.0,
            1_000.0,
        )
        .expect("fixed margin should resolve");
        assert_eq!(result.contracts, 100.0);
        assert_eq!(result.estimated_initial_margin_usdt, 100.0);
        assert_eq!(result.entry_budget_usdt, 100.0);
    }

    #[test]
    fn position_sizing_resolves_equity_percentage() {
        let result = resolve_position_sizing(
            PositionSizing::default(),
            InstrumentContract {
                contract_value: 0.01,
                min_size: 1.0,
                lot_size: 1.0,
            },
            10.0,
            10_000.0,
            0.0,
            1_000.0,
        )
        .expect("equity percentage should resolve");
        assert_eq!(result.entry_budget_usdt, 500.0);
        assert_eq!(result.same_side_total_budget_usdt, 2_000.0);
        assert_eq!(result.contracts, 500.0);
    }

    #[test]
    fn position_sizing_respects_lot_size_and_rejects_minimum_shortfall() {
        let rounded = resolve_position_sizing(
            PositionSizing {
                mode: PositionSizingMode::FixedUsdt,
                per_entry_budget: 95.0,
                same_side_total_budget: 95.0,
            },
            InstrumentContract {
                contract_value: 1.0,
                min_size: 2.0,
                lot_size: 2.0,
            },
            10.0,
            10_000.0,
            0.0,
            10.0,
        )
        .expect("lot size should round down");
        assert_eq!(rounded.contracts, 94.0);

        let rejected = resolve_position_sizing(
            PositionSizing {
                mode: PositionSizingMode::FixedUsdt,
                per_entry_budget: 1.0,
                same_side_total_budget: 1.0,
            },
            InstrumentContract {
                contract_value: 1.0,
                min_size: 2.0,
                lot_size: 2.0,
            },
            10.0,
            10_000.0,
            0.0,
            10.0,
        );
        assert!(rejected.is_err());
    }

    #[test]
    fn backtest_position_sizing_skips_minimum_order_shortfall() {
        let outcome = resolve_backtest_position_sizing(
            PositionSizing {
                mode: PositionSizingMode::FixedUsdt,
                per_entry_budget: 1.0,
                same_side_total_budget: 1.0,
            },
            InstrumentContract {
                contract_value: 1.0,
                min_size: 2.0,
                lot_size: 2.0,
            },
            10.0,
            10_000.0,
            0.0,
            10.0,
        )
        .expect("a valid capacity shortfall must not fail the backtest");

        assert!(matches!(
            outcome,
            BacktestPositionSizingOutcome::Skipped { reason }
                if reason.contains("entry budget is below this contract's minimum order")
        ));
    }

    #[test]
    fn backtest_position_sizing_keeps_invalid_inputs_as_errors() {
        let outcome = resolve_backtest_position_sizing(
            PositionSizing::default(),
            InstrumentContract {
                contract_value: 1.0,
                min_size: 1.0,
                lot_size: 1.0,
            },
            0.0,
            10_000.0,
            0.0,
            10.0,
        );

        assert!(outcome.is_err());
    }

    #[test]
    fn position_sizing_caps_same_side_pyramiding() {
        let result = resolve_position_sizing(
            PositionSizing {
                mode: PositionSizingMode::FixedUsdt,
                per_entry_budget: 100.0,
                same_side_total_budget: 120.0,
            },
            InstrumentContract {
                contract_value: 1.0,
                min_size: 1.0,
                lot_size: 1.0,
            },
            10.0,
            10_000.0,
            50.0,
            10.0,
        )
        .expect("remaining same-side budget should resolve");
        assert_eq!(result.current_same_side_margin_usdt, 50.0);
        assert_eq!(result.contracts, 70.0);
    }

    fn intent(context: &MarketDataWindow, target_quantity: f64) -> StrategyDecision {
        StrategyDecision::PaperIntent {
            intent: PaperIntent {
                strategy_id: "fixture-strategy".to_string(),
                inst_id: context.inst_id().to_string(),
                as_of_ms: context.as_of_ms(),
                target_quantity,
                stop_loss: None,
                take_profit: None,
                execution: StrategyExecution::default(),
                reason: "fixture target".to_string(),
                diagnostics: BTreeMap::new(),
            },
        }
    }

    struct VisibilityStrategy {
        expected_lengths: Vec<usize>,
        seen_lengths: Vec<usize>,
    }

    impl EventDrivenStrategy for VisibilityStrategy {
        fn on_bar(
            &mut self,
            context: &MarketDataWindow,
        ) -> Result<StrategyDecision, SystematicError> {
            assert!(context
                .bars()
                .iter()
                .all(|bar| bar.close_time_ms <= context.as_of_ms()));
            self.seen_lengths.push(context.len());
            Ok(StrategyDecision::NoAction { reason: None })
        }
    }

    #[test]
    fn event_loop_exposes_only_current_closed_timeline_data() {
        let data = vec![
            bar(0, 100.0, 101.0, 99.0, 100.0),
            bar(ONE_MINUTE_MS, 100.0, 102.0, 99.0, 101.0),
            bar(2 * ONE_MINUTE_MS, 101.0, 103.0, 100.0, 102.0),
        ];
        let mut strategy = VisibilityStrategy {
            expected_lengths: vec![1, 2, 3],
            seen_lengths: Vec::new(),
        };

        let result =
            BacktestEngine::run(&request(data), &mut strategy, &CancellationToken::default())
                .unwrap();

        assert_eq!(result.status, BacktestStatus::Completed);
        assert_eq!(strategy.seen_lengths, strategy.expected_lengths);
        assert_eq!(result.timing.strategy_callback_count, 3);
        assert!(result.timing.simulation_us >= result.timing.strategy_callback_us);
        let encoded = serde_json::to_value(&result).expect("serialize run result");
        assert!(encoded.get("timing").is_none());
    }

    struct PreloadedHistoryStrategy {
        seen_lengths: Vec<usize>,
        calls: usize,
    }

    impl EventDrivenStrategy for PreloadedHistoryStrategy {
        fn on_bar(
            &mut self,
            context: &MarketDataWindow,
        ) -> Result<StrategyDecision, SystematicError> {
            self.calls += 1;
            self.seen_lengths.push(context.len());
            if self.calls == 1 {
                return Ok(intent(context, 1.0));
            }
            Ok(StrategyDecision::NoAction { reason: None })
        }
    }

    #[test]
    fn preloaded_history_is_visible_but_excluded_from_the_evaluation_report() {
        let data = vec![
            bar(0, 100.0, 101.0, 99.0, 100.0),
            bar(ONE_MINUTE_MS, 100.0, 102.0, 99.0, 101.0),
            bar(2 * ONE_MINUTE_MS, 101.0, 104.0, 100.0, 103.0),
            bar(3 * ONE_MINUTE_MS, 103.0, 105.0, 102.0, 104.0),
            bar(4 * ONE_MINUTE_MS, 104.0, 106.0, 103.0, 105.0),
        ];
        let mut backtest_request = request(data);
        backtest_request.preload_bars = 2;
        let mut strategy = PreloadedHistoryStrategy {
            seen_lengths: Vec::new(),
            calls: 0,
        };

        let result = BacktestEngine::run(
            &backtest_request,
            &mut strategy,
            &CancellationToken::default(),
        )
        .expect("preloaded history backtest");

        assert_eq!(result.status, BacktestStatus::Completed);
        // Only the final preloaded bar dispatches a decision. Its close is the
        // formal evaluation start, so its target fills at the first evaluation
        // bar open without making the preloaded bars part of the report.
        assert_eq!(strategy.seen_lengths, vec![2, 3, 4, 5]);
        assert_eq!(result.report.fills.len(), 1);
        assert_eq!(result.report.fills[0].time_ms, 2 * ONE_MINUTE_MS);
        assert_eq!(result.report.equity_curve.len(), 3);
        assert_eq!(result.report.replay_snapshots.len(), 3);
        assert_eq!(result.report.reproducibility.preload_start_time_ms, Some(0));
        assert_eq!(result.report.reproducibility.preload_bar_count, Some(2));
        assert_eq!(
            result.report.reproducibility.start_time_ms,
            2 * ONE_MINUTE_MS
        );
        assert_eq!(result.report.reproducibility.processed_bar_count, 3);
        assert!(result.report.has_valid_hash().expect("report hash"));
    }

    struct StatefulLifecycleStrategy {
        calls: usize,
        snapshots: Vec<StrategyContextSnapshot>,
    }

    impl StatefulEventDrivenStrategy for StatefulLifecycleStrategy {
        fn on_bar(
            &mut self,
            context: &StrategyContext<'_>,
        ) -> Result<StrategyAction, SystematicError> {
            self.calls += 1;
            let snapshot = context.snapshot();
            assert_eq!(snapshot.market.bars.len(), self.calls);
            assert!(snapshot
                .market
                .bars
                .iter()
                .all(|bar| bar.close_time_ms <= snapshot.market.as_of_ms));
            assert_eq!(context.market().bars().len(), self.calls);

            match self.calls {
                1 => {
                    assert!(snapshot.portfolio.position.is_none());
                    assert!(snapshot.fills.is_empty());
                    assert!(snapshot.closed_trades.is_empty());
                }
                2 => {
                    let position = snapshot.portfolio.position.as_ref().unwrap();
                    assert_eq!(position.side, TradeSide::Long);
                    assert_eq!(position.quantity, 1.0);
                    assert_eq!(snapshot.fills.len(), 1);
                    assert_eq!(snapshot.fills[0].time_ms, ONE_MINUTE_MS);
                    assert_eq!(snapshot.closed_trades.len(), 0);
                }
                3 => {
                    assert!(snapshot.portfolio.position.is_none());
                    assert_eq!(snapshot.fills.len(), 2);
                    assert_eq!(snapshot.closed_trades.len(), 1);
                    assert_eq!(snapshot.closed_trades[0].side, TradeSide::Long);
                }
                _ => unreachable!("fixture has three callbacks"),
            }
            self.snapshots.push(snapshot);

            Ok(match self.calls {
                1 => StrategyAction::OpenLong {
                    quantity: 1.0,
                    execution: StrategyExecution::default(),
                    stop_loss: None,
                    take_profit: None,
                    reason: "stateful long entry".to_string(),
                    diagnostics: BTreeMap::new(),
                },
                2 => StrategyAction::CloseLong {
                    quantity: 1.0,
                    execution: StrategyExecution::default(),
                    reason: "stateful long exit".to_string(),
                    diagnostics: BTreeMap::new(),
                },
                _ => StrategyAction::NoAction { reason: None },
            })
        }
    }

    #[test]
    fn stateful_actions_receive_current_account_state_and_fill_next_open() {
        let data = vec![
            bar(0, 100.0, 101.0, 99.0, 100.0),
            bar(ONE_MINUTE_MS, 110.0, 111.0, 109.0, 110.0),
            bar(2 * ONE_MINUTE_MS, 120.0, 121.0, 119.0, 120.0),
        ];
        let mut request = request(data);
        request.execution.entry_slippage_bps = 10.0;
        request.execution.exit_slippage_bps = 10.0;
        request.execution.entry_fee_rate = 0.001;
        request.execution.exit_fee_rate = 0.001;
        let mut strategy = StatefulLifecycleStrategy {
            calls: 0,
            snapshots: Vec::new(),
        };

        let report =
            BacktestEngine::run_stateful(&request, &mut strategy, &CancellationToken::default())
                .unwrap()
                .report;

        assert_eq!(strategy.snapshots.len(), 3);
        assert_eq!(report.schema_version, "2");
        assert_eq!(report.strategy_actions.len(), 3);
        assert!(matches!(
            report.strategy_actions[0].action,
            StrategyAction::OpenLong { .. }
        ));
        assert!(matches!(
            report.strategy_actions[1].action,
            StrategyAction::CloseLong { .. }
        ));
        assert!(matches!(
            report.strategy_actions[2].action,
            StrategyAction::NoAction { .. }
        ));
        assert_eq!(report.fills.len(), 2);
        assert_eq!(report.fills[0].time_ms, ONE_MINUTE_MS);
        assert_eq!(report.fills[0].side, FillSide::Buy);
        assert!((report.fills[0].fill_price - 110.11).abs() < 1e-10);
        assert!((report.fills[0].fee_usdt - 0.11011).abs() < 1e-10);
        assert_eq!(report.fills[1].time_ms, 2 * ONE_MINUTE_MS);
        assert_eq!(report.fills[1].side, FillSide::Sell);
        assert!((report.fills[1].fill_price - 119.88).abs() < 1e-10);
        assert!((report.fills[1].fee_usdt - 0.11988).abs() < 1e-10);
        assert_eq!(report.closed_trades.len(), 1);
        assert_eq!(report.replay_snapshots.len(), 3);
        assert_eq!(report.replay_snapshots[0].fill_count, 0);
        assert!(report.replay_snapshots[0].position.is_none());
        assert_eq!(report.replay_snapshots[1].fill_count, 1);
        assert_eq!(report.replay_snapshots[1].closed_trade_count, 0);
        assert!(report.replay_snapshots[1].position.is_some());
        assert_eq!(report.replay_snapshots[2].fill_count, 2);
        assert_eq!(report.replay_snapshots[2].closed_trade_count, 1);
        assert!(report.replay_snapshots[2].position.is_none());
        assert_eq!(report.statistics.as_ref().unwrap().max_consecutive_wins, 1);
        assert_eq!(
            report.statistics.as_ref().unwrap().max_consecutive_losses,
            0
        );
        assert_eq!(
            report.closed_trades[0].exit_reason,
            FillReason::TargetDecrease
        );
        assert!((report.closed_trades[0].net_pnl_usdt - 9.54001).abs() < 1e-10);
        assert!(report.has_valid_hash().unwrap());
    }

    struct BatchedNoActionStrategy {
        batch_sizes: Vec<usize>,
        fallback_calls: usize,
    }

    impl StatefulEventDrivenStrategy for BatchedNoActionStrategy {
        fn on_bar(
            &mut self,
            _context: &StrategyContext<'_>,
        ) -> Result<StrategyAction, SystematicError> {
            self.fallback_calls += 1;
            Ok(StrategyAction::NoAction {
                reason: Some("post-entry minute".to_string()),
            })
        }

        fn no_action_batch_size(&self) -> usize {
            4
        }

        fn on_bar_batch(
            &mut self,
            contexts: &[StrategyContextSnapshot],
        ) -> Result<Vec<StrategyAction>, SystematicError> {
            self.batch_sizes.push(contexts.len());
            assert!(contexts.iter().all(|context| {
                context.portfolio.position.is_none()
                    && context.portfolio.open_orders.is_empty()
                    && context.fills.is_empty()
                    && context.closed_trades.is_empty()
            }));
            Ok(contexts
                .iter()
                .enumerate()
                .map(|(index, _)| {
                    if index == 2 {
                        StrategyAction::OpenLong {
                            quantity: 1.0,
                            execution: StrategyExecution::default(),
                            stop_loss: None,
                            take_profit: None,
                            reason: "batched entry".to_string(),
                            diagnostics: BTreeMap::new(),
                        }
                    } else {
                        StrategyAction::NoAction {
                            reason: Some("batched wait".to_string()),
                        }
                    }
                })
                .collect())
        }
    }

    #[test]
    fn stateful_no_action_batches_stop_before_the_first_action() {
        let data = (0..6)
            .map(|index| {
                let price = 100.0 + index as f64;
                bar(index * ONE_MINUTE_MS, price, price + 1.0, price - 1.0, price)
            })
            .collect();
        let mut strategy = BatchedNoActionStrategy {
            batch_sizes: Vec::new(),
            fallback_calls: 0,
        };

        let report = BacktestEngine::run_stateful(
            &request(data),
            &mut strategy,
            &CancellationToken::default(),
        )
        .expect("batched stateful backtest")
        .report;

        assert_eq!(strategy.batch_sizes, vec![4]);
        assert_eq!(strategy.fallback_calls, 3);
        assert_eq!(report.strategy_actions.len(), 6);
        assert!(matches!(
            report.strategy_actions[2].action,
            StrategyAction::OpenLong { .. }
        ));
        assert_eq!(report.fills.len(), 1);
        assert_eq!(report.fills[0].time_ms, 3 * ONE_MINUTE_MS);
        assert!(report.has_valid_hash().expect("report hash"));
    }

    struct AdaptiveNoActionBatchStrategy {
        next_batch_size: usize,
        batch_sizes: Vec<usize>,
    }

    impl StatefulEventDrivenStrategy for AdaptiveNoActionBatchStrategy {
        fn on_bar(
            &mut self,
            _context: &StrategyContext<'_>,
        ) -> Result<StrategyAction, SystematicError> {
            Ok(StrategyAction::NoAction { reason: None })
        }

        fn no_action_batch_size(&self) -> usize {
            self.next_batch_size
        }

        fn on_bar_batch(
            &mut self,
            contexts: &[StrategyContextSnapshot],
        ) -> Result<Vec<StrategyAction>, SystematicError> {
            self.batch_sizes.push(contexts.len());
            self.next_batch_size = 2;
            Ok(contexts
                .iter()
                .map(|_| StrategyAction::NoAction { reason: None })
                .collect())
        }
    }

    #[test]
    fn stateful_batch_size_is_read_again_after_each_processed_batch() {
        let data = (0..7)
            .map(|index| {
                let price = 100.0 + index as f64;
                bar(index * ONE_MINUTE_MS, price, price + 1.0, price - 1.0, price)
            })
            .collect();
        let mut strategy = AdaptiveNoActionBatchStrategy {
            next_batch_size: 4,
            batch_sizes: Vec::new(),
        };

        let report = BacktestEngine::run_stateful(
            &request(data),
            &mut strategy,
            &CancellationToken::default(),
        )
        .expect("adaptive batched stateful backtest")
        .report;

        // The first batch uses 4; after its callback changes the runtime's
        // preference, the next eligible batch is constructed with 2 instead
        // of the start-of-run value.
        assert_eq!(strategy.batch_sizes, vec![4, 2, 1]);
        assert_eq!(report.strategy_actions.len(), 7);
        assert!(report.has_valid_hash().expect("report hash"));
    }

    struct ShortThenClose {
        calls: usize,
    }

    impl StatefulEventDrivenStrategy for ShortThenClose {
        fn on_bar(
            &mut self,
            _context: &StrategyContext<'_>,
        ) -> Result<StrategyAction, SystematicError> {
            self.calls += 1;
            Ok(match self.calls {
                1 => StrategyAction::OpenShort {
                    quantity: 1.0,
                    execution: StrategyExecution::default(),
                    stop_loss: None,
                    take_profit: None,
                    reason: "short entry".to_string(),
                    diagnostics: BTreeMap::new(),
                },
                2 => StrategyAction::CloseShort {
                    quantity: 1.0,
                    execution: StrategyExecution::default(),
                    reason: "short exit".to_string(),
                    diagnostics: BTreeMap::new(),
                },
                _ => StrategyAction::NoAction { reason: None },
            })
        }
    }

    #[test]
    fn stateful_short_actions_open_and_close_without_crossing_sides() {
        let data = vec![
            bar(0, 100.0, 101.0, 99.0, 100.0),
            bar(ONE_MINUTE_MS, 100.0, 101.0, 99.0, 100.0),
            bar(2 * ONE_MINUTE_MS, 90.0, 91.0, 89.0, 90.0),
        ];
        let mut strategy = ShortThenClose { calls: 0 };

        let report = BacktestEngine::run_stateful(
            &request(data),
            &mut strategy,
            &CancellationToken::default(),
        )
        .unwrap()
        .report;

        assert_eq!(report.fills.len(), 2);
        assert_eq!(report.fills[0].side, FillSide::Sell);
        assert_eq!(report.fills[1].side, FillSide::Buy);
        assert_eq!(report.closed_trades.len(), 1);
        assert_eq!(report.closed_trades[0].side, TradeSide::Short);
        assert_eq!(
            report.closed_trades[0].exit_reason,
            FillReason::TargetDecrease
        );
    }

    struct PartialExitStrategy {
        calls: usize,
    }

    impl StatefulEventDrivenStrategy for PartialExitStrategy {
        fn on_bar(
            &mut self,
            _context: &StrategyContext<'_>,
        ) -> Result<StrategyAction, SystematicError> {
            self.calls += 1;
            Ok(match self.calls {
                1 => StrategyAction::OpenLong {
                    quantity: 2.0,
                    execution: StrategyExecution::default(),
                    stop_loss: Some(90.0),
                    take_profit: Some(120.0),
                    reason: "two-contract entry".to_string(),
                    diagnostics: BTreeMap::new(),
                },
                2 => StrategyAction::CloseLong {
                    quantity: 1.0,
                    execution: StrategyExecution::default(),
                    reason: "scale out".to_string(),
                    diagnostics: BTreeMap::new(),
                },
                _ => StrategyAction::NoAction { reason: None },
            })
        }
    }

    #[test]
    fn stateful_close_action_can_reduce_only_part_of_a_virtual_position() {
        let data = vec![
            bar(0, 100.0, 101.0, 99.0, 100.0),
            bar(ONE_MINUTE_MS, 100.0, 101.0, 99.0, 100.0),
            bar(2 * ONE_MINUTE_MS, 110.0, 111.0, 109.0, 110.0),
        ];
        let mut strategy = PartialExitStrategy { calls: 0 };
        let mut backtest_request = request(data);
        backtest_request.margin = MarginAssumptions {
            leverage: 10.0,
            margin_safety_multiplier: 2.0,
        };

        let report = BacktestEngine::run_stateful(
            &backtest_request,
            &mut strategy,
            &CancellationToken::default(),
        )
        .unwrap()
        .report;

        assert_eq!(report.fills.len(), 2);
        assert_eq!(report.closed_trades.len(), 1);
        assert_eq!(report.closed_trades[0].quantity, 1.0);
        assert_eq!(report.fills[0].notional_usdt, 200.0);
        assert_eq!(report.fills[0].margin_delta_usdt, 40.0);
        assert_eq!(report.fills[0].margin_after_usdt, 40.0);
        assert_eq!(report.fills[1].margin_delta_usdt, -20.0);
        assert_eq!(report.fills[1].margin_after_usdt, 20.0);
        assert_eq!(report.closed_trades[0].used_margin_usdt, 20.0);
        assert_eq!(report.closed_trades[0].leverage, 10.0);
        assert_eq!(report.closed_trades[0].margin_safety_multiplier, 2.0);
        let open_position = report.open_position.as_ref().unwrap();
        assert_eq!(open_position.side, TradeSide::Long);
        assert_eq!(open_position.quantity, 1.0);
        assert_eq!(open_position.used_margin_usdt, 20.0);
        assert_eq!(open_position.leverage, 10.0);
        assert_eq!(open_position.margin_safety_multiplier, 2.0);
        assert_eq!(open_position.stop_loss, Some(90.0));
        assert_eq!(open_position.take_profit, Some(120.0));
    }

    struct LimitThenCancelStrategy {
        calls: usize,
    }

    impl StatefulEventDrivenStrategy for LimitThenCancelStrategy {
        fn on_bar(
            &mut self,
            context: &StrategyContext<'_>,
        ) -> Result<StrategyAction, SystematicError> {
            self.calls += 1;
            match self.calls {
                1 => Ok(StrategyAction::OpenLong {
                    quantity: 2.0,
                    execution: StrategyExecution {
                        order_type: StrategyOrderType::Limit,
                        limit_price: Some(101.0),
                    },
                    stop_loss: Some(90.0),
                    take_profit: Some(120.0),
                    reason: "enter only on the pullback".to_string(),
                    diagnostics: BTreeMap::new(),
                }),
                2 => {
                    let order = context
                        .portfolio()
                        .open_orders
                        .first()
                        .expect("partial limit order must be visible to the next callback");
                    assert_eq!(order.status, PaperOrderStatus::PartiallyFilled);
                    assert_eq!(order.quantity, 2.0);
                    assert_eq!(order.filled_quantity, 1.0);
                    Ok(StrategyAction::CancelOrder {
                        order_id: order.id.clone(),
                        reason: "remaining bid is no longer valid".to_string(),
                        diagnostics: BTreeMap::new(),
                    })
                }
                _ => Ok(StrategyAction::NoAction { reason: None }),
            }
        }
    }

    #[test]
    fn limit_orders_are_conservative_partially_fill_and_can_be_cancelled() {
        let data = vec![
            bar(0, 102.0, 103.0, 101.0, 102.0),
            // Strictly traverses the 101 bid; ten contracts of volume limit
            // the conservative 10% participation model to one contract.
            bar(ONE_MINUTE_MS, 102.0, 103.0, 100.0, 102.0),
            bar(2 * ONE_MINUTE_MS, 102.0, 104.0, 99.0, 103.0),
            bar(3 * ONE_MINUTE_MS, 103.0, 104.0, 102.0, 103.0),
        ];
        let mut strategy = LimitThenCancelStrategy { calls: 0 };
        let report = BacktestEngine::run_stateful(
            &request(data),
            &mut strategy,
            &CancellationToken::default(),
        )
        .unwrap()
        .report;

        assert_eq!(report.limit_order_fill_model, "kline_conservative_estimate");
        assert_eq!(report.fills.len(), 1);
        assert_eq!(report.fills[0].reason, FillReason::LimitEntry);
        assert_eq!(report.fills[0].fill_price, 101.0);
        assert!(report.order_events.iter().any(|event| event.status == PaperOrderStatus::Open));
        assert!(report
            .order_events
            .iter()
            .any(|event| event.status == PaperOrderStatus::PartiallyFilled));
        assert!(report
            .order_events
            .iter()
            .any(|event| event.status == PaperOrderStatus::Cancelled));
        assert_eq!(report.open_position.unwrap().quantity, 1.0);
    }

    struct ProtectionLifecycleStrategy {
        calls: usize,
    }

    impl StatefulEventDrivenStrategy for ProtectionLifecycleStrategy {
        fn on_bar(
            &mut self,
            context: &StrategyContext<'_>,
        ) -> Result<StrategyAction, SystematicError> {
            self.calls += 1;
            match self.calls {
                1 => Ok(StrategyAction::OpenLong {
                    quantity: 1.0,
                    execution: StrategyExecution::default(),
                    stop_loss: Some(90.0),
                    take_profit: Some(120.0),
                    reason: "protected entry".to_string(),
                    diagnostics: BTreeMap::new(),
                }),
                2 => Ok(StrategyAction::SetProtection {
                    stop_loss: Some(Some(95.0)),
                    take_profit: None,
                    reason: "trail stop".to_string(),
                    diagnostics: BTreeMap::new(),
                }),
                3 => {
                    let position = context.portfolio().position.as_ref().unwrap();
                    assert_eq!(position.stop_loss, Some(95.0));
                    assert_eq!(position.take_profit, Some(120.0));
                    Ok(StrategyAction::CancelProtection {
                        reason: "remove protection".to_string(),
                        diagnostics: BTreeMap::new(),
                    })
                }
                4 => {
                    let position = context.portfolio().position.as_ref().unwrap();
                    assert!(position.stop_loss.is_none());
                    assert!(position.take_profit.is_none());
                    Ok(StrategyAction::CloseLong {
                        quantity: 1.0,
                        execution: StrategyExecution::default(),
                        reason: "flat before finish".to_string(),
                        diagnostics: BTreeMap::new(),
                    })
                }
                _ => Ok(StrategyAction::NoAction { reason: None }),
            }
        }
    }

    #[test]
    fn protection_actions_update_cancel_and_full_close_removes_protection() {
        let data = (0..5)
            .map(|index| bar(index * ONE_MINUTE_MS, 100.0, 101.0, 99.0, 100.0))
            .collect();
        let mut strategy = ProtectionLifecycleStrategy { calls: 0 };

        let report = BacktestEngine::run_stateful(
            &request(data),
            &mut strategy,
            &CancellationToken::default(),
        )
        .unwrap()
        .report;

        assert_eq!(report.fills.len(), 2);
        assert_eq!(report.closed_trades.len(), 1);
        assert!(report.open_position.is_none());
        assert!(matches!(
            report.strategy_actions[1].action,
            StrategyAction::SetProtection { .. }
        ));
        assert!(matches!(
            report.strategy_actions[2].action,
            StrategyAction::CancelProtection { .. }
        ));
        assert!(report.replay_snapshots[2]
            .position
            .as_ref()
            .is_some_and(|position| position.stop_loss == Some(95.0)));
        assert!(
            report.replay_snapshots[3]
                .position
                .as_ref()
                .is_some_and(
                    |position| position.stop_loss.is_none() && position.take_profit.is_none()
                )
        );
    }

    struct EnterThenExit {
        calls: usize,
    }

    impl EventDrivenStrategy for EnterThenExit {
        fn on_bar(
            &mut self,
            context: &MarketDataWindow,
        ) -> Result<StrategyDecision, SystematicError> {
            self.calls += 1;
            Ok(match self.calls {
                1 => intent(context, 1.0),
                2 => intent(context, 0.0),
                _ => StrategyDecision::NoAction { reason: None },
            })
        }
    }

    #[test]
    fn fills_on_next_minute_open_and_charges_fees() {
        let data = vec![
            bar(0, 100.0, 101.0, 99.0, 100.0),
            bar(ONE_MINUTE_MS, 100.0, 101.0, 99.0, 100.0),
            bar(2 * ONE_MINUTE_MS, 110.0, 111.0, 109.0, 110.0),
        ];
        let mut request = request(data);
        request.execution.entry_fee_rate = 0.001;
        request.execution.exit_fee_rate = 0.001;
        let mut strategy = EnterThenExit { calls: 0 };

        let report = BacktestEngine::run(&request, &mut strategy, &CancellationToken::default())
            .unwrap()
            .report;

        assert_eq!(report.fills.len(), 2);
        assert_eq!(report.fills[0].time_ms, ONE_MINUTE_MS);
        assert_eq!(report.fills[0].fill_price, 100.0);
        assert_eq!(report.fills[1].time_ms, 2 * ONE_MINUTE_MS);
        assert_eq!(report.fills[1].fill_price, 110.0);
        assert_eq!(report.closed_trades.len(), 1);
        assert!((report.closed_trades[0].net_pnl_usdt - 9.79).abs() < 1e-10);
        assert!((report.metrics.final_equity_usdt - 1_009.79).abs() < 1e-10);
    }

    #[test]
    fn slippage_is_directionally_adverse_for_a_long_round_trip() {
        let data = vec![
            bar(0, 100.0, 101.0, 99.0, 100.0),
            bar(ONE_MINUTE_MS, 100.0, 101.0, 99.0, 100.0),
            bar(2 * ONE_MINUTE_MS, 110.0, 111.0, 109.0, 110.0),
        ];
        let mut request = request(data);
        request.execution.entry_slippage_bps = 10.0;
        request.execution.exit_slippage_bps = 10.0;
        let mut strategy = EnterThenExit { calls: 0 };

        let report = BacktestEngine::run(&request, &mut strategy, &CancellationToken::default())
            .unwrap()
            .report;

        assert!((report.fills[0].fill_price - 100.1).abs() < 1e-10);
        assert!((report.fills[1].fill_price - 109.89).abs() < 1e-10);
        assert!((report.metrics.net_pnl_usdt - 9.79).abs() < 1e-10);
    }

    struct ProtectiveStrategy {
        emitted: bool,
    }

    impl EventDrivenStrategy for ProtectiveStrategy {
        fn on_bar(
            &mut self,
            context: &MarketDataWindow,
        ) -> Result<StrategyDecision, SystematicError> {
            if self.emitted {
                return Ok(StrategyDecision::NoAction { reason: None });
            }
            self.emitted = true;
            Ok(StrategyDecision::PaperIntent {
                intent: PaperIntent {
                    strategy_id: "fixture-strategy".to_string(),
                    inst_id: context.inst_id().to_string(),
                    as_of_ms: context.as_of_ms(),
                    target_quantity: 1.0,
                    stop_loss: Some(90.0),
                    take_profit: Some(110.0),
                    execution: StrategyExecution::default(),
                    reason: "protected entry".to_string(),
                    diagnostics: BTreeMap::new(),
                },
            })
        }
    }

    #[test]
    fn dual_stop_take_profit_bar_uses_adverse_stop_fill() {
        let data = vec![
            bar(0, 100.0, 101.0, 99.0, 100.0),
            bar(ONE_MINUTE_MS, 100.0, 120.0, 80.0, 100.0),
        ];
        let mut strategy = ProtectiveStrategy { emitted: false };
        let report =
            BacktestEngine::run(&request(data), &mut strategy, &CancellationToken::default())
                .unwrap()
                .report;

        assert_eq!(report.closed_trades.len(), 1);
        assert_eq!(
            report.closed_trades[0].exit_reason,
            FillReason::ProtectiveStop
        );
        assert_eq!(report.closed_trades[0].exit_price, 90.0);
    }

    struct EnterOnce;

    impl EventDrivenStrategy for EnterOnce {
        fn on_bar(
            &mut self,
            context: &MarketDataWindow,
        ) -> Result<StrategyDecision, SystematicError> {
            if context.len() == 1 {
                Ok(intent(context, 1.0))
            } else {
                Ok(StrategyDecision::NoAction { reason: None })
            }
        }
    }

    struct EnterTooLarge;

    impl EventDrivenStrategy for EnterTooLarge {
        fn on_bar(
            &mut self,
            context: &MarketDataWindow,
        ) -> Result<StrategyDecision, SystematicError> {
            if context.len() == 1 {
                Ok(intent(context, 101.0))
            } else {
                Ok(StrategyDecision::NoAction { reason: None })
            }
        }
    }

    #[test]
    fn insufficient_margin_keeps_the_run_reproducible_and_marks_the_intent_unfilled() {
        let data = vec![
            bar(0, 100.0, 101.0, 99.0, 100.0),
            bar(ONE_MINUTE_MS, 100.0, 101.0, 99.0, 100.0),
        ];
        let report = BacktestEngine::run(
            &request(data),
            &mut EnterTooLarge,
            &CancellationToken::default(),
        )
        .unwrap()
        .report;

        assert!(report.fills.is_empty());
        assert_eq!(report.unfilled_intents.len(), 1);
        assert!(report.unfilled_intents[0]
            .reason
            .contains("insufficient available isolated margin"));
        assert!(report.has_valid_hash().unwrap());
    }

    #[test]
    fn exhausted_virtual_margin_closes_at_the_adverse_minute_extreme() {
        let data = vec![
            bar(0, 100.0, 101.0, 99.0, 100.0),
            bar(ONE_MINUTE_MS, 100.0, 101.0, 89.0, 90.0),
        ];
        let report = BacktestEngine::run(
            &request(data),
            &mut EnterOnce,
            &CancellationToken::default(),
        )
        .unwrap()
        .report;

        assert_eq!(report.closed_trades.len(), 1);
        assert_eq!(
            report.closed_trades[0].exit_reason,
            FillReason::MarginExhaustion
        );
        assert_eq!(report.closed_trades[0].exit_price, 89.0);
        assert!(report.open_position.is_none());
    }

    #[test]
    fn positive_funding_charges_a_long_position() {
        let data = vec![
            bar(0, 100.0, 101.0, 99.0, 100.0),
            bar(ONE_MINUTE_MS, 100.0, 101.0, 99.0, 100.0),
        ];
        let mut request = request(data);
        request.funding_events.push(FundingEvent {
            timestamp_ms: 2 * ONE_MINUTE_MS,
            rate: 0.01,
        });
        let report = BacktestEngine::run(&request, &mut EnterOnce, &CancellationToken::default())
            .unwrap()
            .report;

        assert_eq!(report.funding_payments.len(), 1);
        assert!((report.funding_payments[0].cashflow_usdt + 1.0).abs() < 1e-10);
        assert!((report.metrics.final_equity_usdt - 999.0).abs() < 1e-10);
    }

    #[test]
    fn report_hash_is_deterministic_and_verifiable() {
        let data = vec![
            bar(0, 100.0, 101.0, 99.0, 100.0),
            bar(ONE_MINUTE_MS, 100.0, 101.0, 99.0, 100.0),
        ];
        let request = request(data);
        let first = BacktestEngine::run(&request, &mut EnterOnce, &CancellationToken::default())
            .unwrap()
            .report;
        let second = BacktestEngine::run(&request, &mut EnterOnce, &CancellationToken::default())
            .unwrap()
            .report;

        assert_eq!(first.report_hash, second.report_hash);
        assert!(first.has_valid_hash().unwrap());
    }

    #[test]
    fn legacy_reports_remain_hash_compatible_without_replay_extensions() {
        let data = vec![
            bar(0, 100.0, 101.0, 99.0, 100.0),
            bar(ONE_MINUTE_MS, 100.0, 101.0, 99.0, 100.0),
        ];
        let mut report = BacktestEngine::run(
            &request(data),
            &mut EnterOnce,
            &CancellationToken::default(),
        )
        .unwrap()
        .report;

        report.replay_snapshots.clear();
        report.statistics = None;
        report.report_hash = report.deterministic_hash().unwrap();
        let serialized = serde_json::to_value(&report).unwrap();

        assert!(serialized.get("replaySnapshots").is_none());
        assert!(serialized.get("statistics").is_none());
        let decoded: BacktestReport = serde_json::from_value(serialized).unwrap();
        assert!(decoded.has_valid_hash().unwrap());
    }

    struct CancelAfterFirstEvent {
        token: CancellationToken,
        calls: usize,
    }

    impl EventDrivenStrategy for CancelAfterFirstEvent {
        fn on_bar(
            &mut self,
            _context: &MarketDataWindow,
        ) -> Result<StrategyDecision, SystematicError> {
            self.calls += 1;
            self.token.cancel();
            Ok(StrategyDecision::NoAction { reason: None })
        }
    }

    #[test]
    fn cancellation_returns_a_labeled_partial_report() {
        let data = vec![
            bar(0, 100.0, 101.0, 99.0, 100.0),
            bar(ONE_MINUTE_MS, 100.0, 101.0, 99.0, 100.0),
            bar(2 * ONE_MINUTE_MS, 100.0, 101.0, 99.0, 100.0),
        ];
        let token = CancellationToken::default();
        let mut strategy = CancelAfterFirstEvent {
            token: token.clone(),
            calls: 0,
        };

        let result = BacktestEngine::run(&request(data), &mut strategy, &token).unwrap();

        assert_eq!(strategy.calls, 1);
        assert_eq!(result.status, BacktestStatus::Cancelled);
        assert_eq!(result.report.reproducibility.processed_bar_count, 1);
        assert!(result.report.has_valid_hash().unwrap());
    }

    #[test]
    fn worker_recommendation_preserves_two_cores_and_caps_at_four() {
        assert_eq!(recommended_backtest_workers(0), 1);
        assert_eq!(recommended_backtest_workers(2), 1);
        assert_eq!(recommended_backtest_workers(4), 2);
        assert_eq!(recommended_backtest_workers(32), 4);
    }
}
