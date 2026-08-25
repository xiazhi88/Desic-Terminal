//! Deterministic cross-sectional factor expressions over confirmed K-line panels.
//!
//! # Why this crate exists separately from `desic-chart-dsl`
//!
//! `desic-chart-dsl` evaluates one instrument's series at a time, which is all a
//! chart indicator needs. A factor is a *relative* statement — "this instrument
//! ranks third of forty on momentum right now" — so it needs every instrument's
//! values at one timestamp simultaneously. That is a different evaluation shape,
//! not a longer expression.
//!
//! # The panel model
//!
//! An earlier design evaluated each instrument independently and applied one
//! cross-sectional normalisation at the very end. That cannot express a formula
//! whose scope alternates, and the canonical formulaic-alpha literature is full
//! of those: `ts_rank(cs_rank(low), 9)` ranks across instruments first, then
//! ranks that rank within its own history. A trailing-normalisation design
//! silently cannot represent it.
//!
//! So evaluation walks the tree with an explicit notion of scope:
//!
//! - Time-series and element-wise nodes evaluate per instrument, independently.
//! - A cross-sectional node is a synchronisation barrier: every instrument's
//!   series must be resolved to that point before the barrier can produce
//!   output, because the statistic is taken across instruments at each bar.
//!
//! Only cross-sectional nodes need the whole panel. With a universe in the tens
//! to low hundreds the panel fits in memory comfortably, which is what makes
//! this practical here.
//!
//! # Naming
//!
//! Every scoped operator carries a `cs_` or `ts_` prefix and there is no bare
//! `rank`. In the formulaic-alpha literature `rank` means cross-sectional while
//! `ts_rank` means time-series, and that collision is a well-known source of
//! silently wrong factors. Making the scope part of every name removes the
//! ambiguity at the type level rather than in documentation.
//!
//! This crate contains no IO, no clock, and no randomness. Given the same panel
//! it returns the same scores.

use std::collections::BTreeMap;
use std::fmt;

use desic_chart_dsl::{DslError, Expression as SeriesExpression, ResourceLimits, ValueType};
use serde::{Deserialize, Serialize};

mod cross_section;
mod eval;
mod presets;

pub use cross_section::{apply_cross_section, CrossSectionOp, WinsorizeMethod};
pub use eval::{evaluate_panel, PanelInput, PanelOutput};
pub use presets::{
    builtin_presets, operator_catalogue, source_catalogue, source_expression, OperatorDescriptor,
    SourceDescriptor,
};

/// Upper bound on instruments in one evaluation.
///
/// Cross-sectional nodes hold the whole panel, so this bounds peak memory. It is
/// far above any tradable perpetual universe.
pub const MAX_PANEL_INSTRUMENTS: usize = 1_000;

/// Upper bound on chained cross-sectional operations in one factor.
pub const MAX_CROSS_SECTION_OPS: usize = 8;

/// Minimum instruments for a cross-sectional statistic to mean anything.
///
/// With one instrument a z-score is zero and a rank is degenerate, so the output
/// carries no information. Callers should surface this rather than presenting a
/// single-member ranking as if it were one.
pub const MIN_CROSS_SECTION_MEMBERS: usize = 2;

/// A factor expression.
///
/// `series` is evaluated per instrument by the reused chart-DSL evaluator, and
/// `pipeline` is the ordered list of scope-crossing stages applied afterwards.
/// Nesting is expressed by alternating stages rather than by nesting the series
/// expression, which keeps the reused evaluator untouched while still supporting
/// `ts_*(cs_*(...))` composition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactorExpression {
    /// Per-instrument series expression. Must evaluate to a numeric series.
    pub series: SeriesExpression,
    /// Scope-crossing stages, applied in order.
    #[serde(default)]
    pub pipeline: Vec<FactorStage>,
}

/// One stage in a factor pipeline.
///
/// A stage either crosses instruments at a fixed timestamp (`CrossSection`) or
/// walks time within each instrument (`TimeSeries`). Alternating them is what
/// gives `ts_rank(cs_rank(low), 9)`: a `CrossSection` stage followed by a
/// `TimeSeries` stage.
/// The operator is flattened into the stage object so a stage reads as one flat
/// record (`{"scope":"crossSection","op":"csRank","ascending":true}`) rather than
/// a doubly-nested `op.op`. The pipeline is authored and reviewed by hand often
/// enough that the shape matters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "scope", rename_all = "camelCase")]
pub enum FactorStage {
    /// Applied across instruments at each timestamp.
    CrossSection {
        #[serde(flatten)]
        op: CrossSectionOp,
    },
    /// Applied along time within each instrument.
    TimeSeries {
        #[serde(flatten)]
        op: TimeSeriesOp,
    },
}

/// Time-series stage operators.
///
/// These duplicate a small part of the chart DSL's rolling vocabulary on
/// purpose: a stage operates on the output of a previous stage, which is a
/// derived series rather than an OHLCV field, so it cannot be expressed as a
/// chart-DSL node.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum TimeSeriesOp {
    /// Percentile of the current value within its own trailing window, 0..1.
    TsRank {
        window: usize,
    },
    TsMean {
        window: usize,
    },
    TsStd {
        window: usize,
    },
    TsSum {
        window: usize,
    },
    TsMin {
        window: usize,
    },
    TsMax {
        window: usize,
    },
    /// Self-normalising trailing z-score.
    TsZscore {
        window: usize,
    },
    /// Value from `n` bars back.
    Delay {
        bars: usize,
    },
    /// Change against `n` bars back.
    Delta {
        bars: usize,
    },
}

impl TimeSeriesOp {
    fn window(self) -> usize {
        match self {
            Self::TsRank { window }
            | Self::TsMean { window }
            | Self::TsStd { window }
            | Self::TsSum { window }
            | Self::TsMin { window }
            | Self::TsMax { window }
            | Self::TsZscore { window } => window,
            Self::Delay { bars } | Self::Delta { bars } => bars.saturating_add(1),
        }
    }

    /// Stable operator name, matching the `ts_` naming convention.
    pub fn name(self) -> &'static str {
        match self {
            Self::TsRank { .. } => "ts_rank",
            Self::TsMean { .. } => "ts_mean",
            Self::TsStd { .. } => "ts_std",
            Self::TsSum { .. } => "ts_sum",
            Self::TsMin { .. } => "ts_min",
            Self::TsMax { .. } => "ts_max",
            Self::TsZscore { .. } => "ts_zscore",
            Self::Delay { .. } => "delay",
            Self::Delta { .. } => "delta",
        }
    }
}

/// Resource ceilings for a factor evaluation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FactorLimits {
    pub max_instruments: usize,
    pub max_cross_section_ops: usize,
    /// Largest window a time-series stage may request.
    pub max_stage_window: usize,
    /// Limits handed to the reused per-instrument evaluator.
    pub series: ResourceLimits,
}

impl Default for FactorLimits {
    fn default() -> Self {
        Self {
            max_instruments: MAX_PANEL_INSTRUMENTS,
            max_cross_section_ops: MAX_CROSS_SECTION_OPS,
            max_stage_window: 2_000,
            series: ResourceLimits::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum FactorDslError {
    /// The per-instrument expression produced booleans; a factor must be numeric.
    NonNumericSeries {
        actual: ValueType,
    },
    EmptyPanel,
    PanelLimitExceeded {
        actual: usize,
        limit: usize,
    },
    CrossSectionOpLimitExceeded {
        actual: usize,
        limit: usize,
    },
    StageWindowInvalid {
        window: usize,
        limit: usize,
    },
    /// Instruments disagree on bar count, so a timestamp column is not aligned.
    MisalignedPanel {
        expected: usize,
        actual: usize,
    },
    DuplicateInstrument {
        inst_id: String,
    },
    InvalidParameter {
        field: &'static str,
        message: String,
    },
    /// Failure inside the reused per-instrument evaluator.
    Series {
        inst_id: String,
        error: DslError,
    },
}

impl fmt::Display for FactorDslError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NonNumericSeries { actual } => write!(
                formatter,
                "a factor expression must produce a numeric series, got {actual:?}"
            ),
            Self::EmptyPanel => write!(formatter, "the panel contains no instruments"),
            Self::PanelLimitExceeded { actual, limit } => write!(
                formatter,
                "the panel has {actual} instruments, above the limit of {limit}"
            ),
            Self::CrossSectionOpLimitExceeded { actual, limit } => write!(
                formatter,
                "the factor chains {actual} cross-sectional operations, above the limit of {limit}"
            ),
            Self::StageWindowInvalid { window, limit } => write!(
                formatter,
                "a time-series stage window must be between 1 and {limit}, got {window}"
            ),
            Self::MisalignedPanel { expected, actual } => write!(
                formatter,
                "every instrument must supply the same bar count; expected {expected}, got {actual}"
            ),
            Self::DuplicateInstrument { inst_id } => {
                write!(formatter, "instrument {inst_id} appears more than once")
            }
            Self::InvalidParameter { field, message } => {
                write!(formatter, "{field} {message}")
            }
            Self::Series { inst_id, error } => {
                write!(formatter, "evaluating {inst_id}: {error}")
            }
        }
    }
}

impl std::error::Error for FactorDslError {}

impl FactorExpression {
    /// Validates structure and resource use without touching data.
    pub fn validate(&self, limits: FactorLimits) -> Result<FactorValidation, FactorDslError> {
        // Reuse the chart DSL's node, depth and window validation rather than
        // re-implementing it.
        let summary =
            self.series
                .validate(limits.series)
                .map_err(|error| FactorDslError::Series {
                    inst_id: "<series>".to_string(),
                    error,
                })?;
        if summary.value_type != ValueType::Number {
            return Err(FactorDslError::NonNumericSeries {
                actual: summary.value_type,
            });
        }

        let cross_section_ops = self
            .pipeline
            .iter()
            .filter(|stage| matches!(stage, FactorStage::CrossSection { .. }))
            .count();
        if cross_section_ops > limits.max_cross_section_ops {
            return Err(FactorDslError::CrossSectionOpLimitExceeded {
                actual: cross_section_ops,
                limit: limits.max_cross_section_ops,
            });
        }

        // Stage windows extend the history a factor needs beyond the series
        // lookback, so they accumulate into the reported requirement.
        let mut stage_lookback = 0_usize;
        for stage in &self.pipeline {
            match stage {
                FactorStage::CrossSection { op } => op.validate()?,
                FactorStage::TimeSeries { op } => {
                    let window = op.window();
                    if window == 0 || window > limits.max_stage_window {
                        return Err(FactorDslError::StageWindowInvalid {
                            window,
                            limit: limits.max_stage_window,
                        });
                    }
                    stage_lookback = stage_lookback.saturating_add(window.saturating_sub(1));
                }
            }
        }

        Ok(FactorValidation {
            series_lookback: summary.max_lookback,
            stage_lookback,
            minimum_bars: summary
                .max_lookback
                .saturating_add(stage_lookback)
                .saturating_add(1),
            cross_section_ops,
        })
    }

    /// True when any stage crosses instruments.
    ///
    /// A factor without one produces a per-instrument series that is not
    /// comparable across instruments, which is almost always a mistake in a
    /// ranking context. Callers can warn on it.
    pub fn has_cross_section(&self) -> bool {
        self.pipeline
            .iter()
            .any(|stage| matches!(stage, FactorStage::CrossSection { .. }))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FactorValidation {
    /// Bars the per-instrument expression needs.
    pub series_lookback: usize,
    /// Extra bars the time-series stages need.
    pub stage_lookback: usize,
    /// Total confirmed bars required per instrument.
    pub minimum_bars: usize,
    pub cross_section_ops: usize,
}

/// A named preset, used to start users from something that already works rather
/// than from an empty formula.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactorPreset {
    pub id: &'static str,
    pub label_en: &'static str,
    pub label_zh: &'static str,
    /// Sign the evidence supports, for interpretation help.
    pub expected_sign: ExpectedSign,
    pub expression: FactorExpression,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExpectedSign {
    /// Higher score should precede higher return.
    Positive,
    /// Higher score should precede lower return.
    Negative,
    Unknown,
}

/// Convenience accessor so callers can report scores keyed by instrument.
pub type FactorScores = BTreeMap<String, Option<f64>>;
