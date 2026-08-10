//! Deterministic, side-effect-free primitives for systematic research.
//!
//! This crate deliberately does not know about Tauri, SQLite, OKX credentials,
//! network clients, or executable strategy code.  It owns the pure contracts
//! shared by visual rules, managed Python strategies, factor models, paper
//! operations, and historical backtests.
//!
//! The event API only exposes completed bars at or before an explicit cutoff.
//! The backtest engine drives that API one bar at a time and schedules intents
//! for the following one-minute bar open, so a strategy cannot accidentally
//! trade with data from its future timeline.

mod backtest;
mod data;
mod error;
mod factors;
mod job;
mod output;
mod rules;

pub use backtest::{
    recommended_backtest_workers, resolve_backtest_position_sizing, BacktestEngine, BacktestMetrics, BacktestPositionSizingOutcome, BacktestReport, BacktestRequest,
    BacktestRunResult, BacktestStatistics, BacktestStatus, BacktestTiming, ClosedTrade,
    EndOfRunPolicy,
    EquityPoint, ExecutionAssumptions, Fill, FillReason, FillSide, FundingEvent, FundingPayment,
    InstrumentContract, MarginAssumptions, OpenPositionSummary, PositionSizing,
    PositionSizingMode, PositionSizingResolution, ReplaySnapshot, resolve_position_sizing,
    OpenOrderSummary, PaperOrderStatus, ReproducibilityMetadata, SignalRecord,
    StrategyActionEvent, StrategyContext, StrategyContextSnapshot, StrategyEvent,
    UnfilledIntent, VirtualPortfolio,
};
pub use data::{
    ClosedBar, CurrentDataSnapshot, MarketBar, MarketDataWindow, TimeframeAggregator,
    ONE_MINUTE_MS, STRATEGY_TIMEFRAMES,
};
pub use error::SystematicError;
pub use factors::{
    score_kline_blend, KlineBlendFactorDefinition, KlineFactorFeatures, KlineFactorScore,
    MAX_KLINE_FACTOR_COMPONENT_WEIGHT, MAX_KLINE_FACTOR_LOOKBACK_BARS,
    MIN_KLINE_FACTOR_LOOKBACK_BARS,
};
pub use job::{BacktestJobControl, BacktestJobProgress, BacktestJobState, CancellationToken};
pub use output::{
    AlphaOutput, DataCoverage, FactorOutput, PaperIntent, PortfolioConstraints, PortfolioTarget,
    PortfolioTargetPosition, StrategyAction, StrategyDecision, StrategyExecution,
    StrategyOrderType, StrategySignal, TradeSide,
};
pub use rules::{VisualRuleCondition, VisualRuleDefinition, VisualRuleStrategy};

/// A deterministic strategy receives only the current closed-data window and
/// returns an observation, signal, or paper intent for that exact cutoff.
///
/// The engine owns chronological iteration and fills. Implementations must not
/// infer a future timestamp from wall-clock time; the provided `as_of_ms` is
/// the only valid decision time.
pub trait EventDrivenStrategy {
    fn on_bar(&mut self, context: &MarketDataWindow) -> Result<StrategyDecision, SystematicError>;
}

/// Stateful counterpart to [`EventDrivenStrategy`] for managed Python-style
/// strategies. The supplied context contains only current/past market data and
/// paper-account state; it cannot place exchange orders or obtain credentials.
///
/// An `OpenLong`/`OpenShort` action may increase a same-side virtual position.
/// Reversal is explicit: a strategy must first emit the matching close action.
pub trait StatefulEventDrivenStrategy {
    fn on_bar(&mut self, context: &StrategyContext<'_>) -> Result<StrategyAction, SystematicError>;

    /// Returns the maximum number of empty-account no-action events this
    /// strategy can evaluate in one host round trip. The engine only uses
    /// this path before any fill or position exists, so an implementation
    /// must return 1 whenever its output can depend on host-side account
    /// changes between bars.
    fn no_action_batch_size(&self) -> usize {
        1
    }

    /// Allows the engine to represent unchanged fill and trade ledgers as
    /// append-only deltas after the first context in a batch. Runtimes that
    /// expose each snapshot directly must keep the default `false` value.
    fn uses_incremental_ledger_batch(&self) -> bool {
        false
    }

    /// Evaluates a speculative sequence of contexts. The engine commits only
    /// the prefix through the first non-no-action result; later results are
    /// discarded. Implementations should therefore stop producing results
    /// after the first action when they can do so efficiently.
    fn on_bar_batch(
        &mut self,
        contexts: &[StrategyContextSnapshot],
    ) -> Result<Vec<StrategyAction>, SystematicError> {
        if contexts.len() == 1 {
            return Err(SystematicError::InvalidState {
                reason: "strategy did not implement single-event batch dispatch".to_string(),
            });
        }
        Err(SystematicError::InvalidState {
            reason: "strategy did not implement batch dispatch".to_string(),
        })
    }
}
