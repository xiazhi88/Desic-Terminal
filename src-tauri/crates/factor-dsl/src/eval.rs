//! Panel evaluation: per-instrument series, then alternating scope stages.
//!
//! The evaluation order is what makes nested scopes work:
//!
//! 1. Evaluate the series expression once per instrument, independently. This
//!    reuses the chart-DSL evaluator unchanged, inheriting its node, depth and
//!    operation budgets.
//! 2. Walk the stage pipeline in order. A time-series stage stays inside each
//!    instrument. A cross-sectional stage transposes to one bar at a time,
//!    computes across instruments, and transposes back.
//!
//! Step 2 is why `ts_rank(cs_rank(low), 9)` is expressible: the cross-sectional
//! rank produces a new per-instrument series, and the following time-series stage
//! consumes that derived series rather than an OHLCV field.

use desic_chart_dsl::{EvaluatedSeries, OhlcvColumns};

use crate::cross_section::apply_cross_section;
use crate::{FactorDslError, FactorExpression, FactorLimits, FactorStage, TimeSeriesOp};

/// One instrument's aligned input.
///
/// Every instrument must supply the same number of bars covering the same
/// timestamps. Misalignment is rejected rather than tolerated: a cross-sectional
/// statistic over rows that represent different moments compares an instrument's
/// present against another's past, which manufactures signal.
#[derive(Debug, Clone, PartialEq)]
pub struct PanelInput {
    pub inst_id: String,
    pub columns: OhlcvColumns,
}

/// Evaluation result.
#[derive(Debug, Clone, PartialEq)]
pub struct PanelOutput {
    /// Instrument order, matching the row order of `series` and `latest`.
    pub inst_ids: Vec<String>,
    /// Full per-instrument output series, same length as the input bars.
    pub series: Vec<Vec<Option<f64>>>,
    /// Value at the final bar for each instrument; the score a ranking uses.
    pub latest: Vec<Option<f64>>,
    /// Instruments holding a finite value at the final bar.
    pub scored_count: usize,
    pub bar_count: usize,
}

impl PanelOutput {
    /// Scores at the final bar, descending, ties broken by identifier.
    ///
    /// Deterministic tie-breaking matters: two instruments with equal scores must
    /// rank in a stable order across runs, or a rank-change display becomes
    /// noise.
    pub fn ranked_latest(&self) -> Vec<(String, f64)> {
        let mut ranked = self
            .inst_ids
            .iter()
            .zip(&self.latest)
            .filter_map(|(inst_id, value)| value.map(|value| (inst_id.clone(), value)))
            .collect::<Vec<_>>();
        ranked.sort_by(|left, right| {
            right
                .1
                .partial_cmp(&left.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.0.cmp(&right.0))
        });
        ranked
    }
}

/// Evaluates a factor over an aligned panel.
pub fn evaluate_panel(
    expression: &FactorExpression,
    panel: &[PanelInput],
    limits: FactorLimits,
) -> Result<PanelOutput, FactorDslError> {
    if panel.is_empty() {
        return Err(FactorDslError::EmptyPanel);
    }
    if panel.len() > limits.max_instruments {
        return Err(FactorDslError::PanelLimitExceeded {
            actual: panel.len(),
            limit: limits.max_instruments,
        });
    }
    expression.validate(limits)?;

    // Duplicate identifiers would make the output ambiguous and let one
    // instrument influence a cross-sectional statistic twice.
    let mut seen = std::collections::BTreeSet::new();
    for input in panel {
        if !seen.insert(input.inst_id.as_str()) {
            return Err(FactorDslError::DuplicateInstrument {
                inst_id: input.inst_id.clone(),
            });
        }
    }

    let bar_count = panel[0].columns.len();
    for input in panel {
        if input.columns.len() != bar_count {
            return Err(FactorDslError::MisalignedPanel {
                expected: bar_count,
                actual: input.columns.len(),
            });
        }
    }

    // Step 1: per-instrument evaluation, independent and reusing the chart DSL.
    let mut series: Vec<Vec<Option<f64>>> = Vec::with_capacity(panel.len());
    for input in panel {
        let evaluated = expression
            .series
            .evaluate(&input.columns, limits.series)
            .map_err(|error| FactorDslError::Series {
                inst_id: input.inst_id.clone(),
                error,
            })?;
        match evaluated {
            EvaluatedSeries::Number(values) => series.push(values),
            EvaluatedSeries::Boolean(_) => {
                return Err(FactorDslError::NonNumericSeries {
                    actual: desic_chart_dsl::ValueType::Boolean,
                })
            }
        }
    }

    // Step 2: stages, in order.
    for stage in &expression.pipeline {
        match stage {
            FactorStage::TimeSeries { op } => {
                for values in series.iter_mut() {
                    *values = apply_time_series(*op, values);
                }
            }
            FactorStage::CrossSection { op } => {
                // Transpose to one bar at a time. This is the synchronisation
                // barrier: the statistic needs every instrument's value at this
                // exact bar, so no instrument can run ahead.
                let mut column = vec![None; series.len()];
                for bar in 0..bar_count {
                    for (row, values) in series.iter().enumerate() {
                        column[row] = values[bar];
                    }
                    let scored = apply_cross_section(*op, &column);
                    for (row, value) in scored.into_iter().enumerate() {
                        series[row][bar] = value;
                    }
                }
            }
        }
    }

    let latest = series
        .iter()
        .map(|values| values.last().copied().flatten())
        .collect::<Vec<_>>();
    let scored_count = latest.iter().filter(|value| value.is_some()).count();

    Ok(PanelOutput {
        inst_ids: panel.iter().map(|input| input.inst_id.clone()).collect(),
        series,
        latest,
        scored_count,
        bar_count,
    })
}

/// Applies a time-series stage within one instrument.
///
/// A bar without enough history yields `None`. Warm-up is not filled in, because
/// a partially-computed window is a different statistic than the one requested.
fn apply_time_series(op: TimeSeriesOp, values: &[Option<f64>]) -> Vec<Option<f64>> {
    let count = values.len();
    let mut output = vec![None; count];
    match op {
        TimeSeriesOp::Delay { bars } => {
            for index in bars..count {
                output[index] = values[index - bars];
            }
        }
        TimeSeriesOp::Delta { bars } => {
            for index in bars..count {
                if let (Some(current), Some(previous)) = (values[index], values[index - bars]) {
                    output[index] = Some(current - previous);
                }
            }
        }
        TimeSeriesOp::TsRank { window } => {
            for index in 0..count {
                if let Some(slice) = trailing_window(values, index, window) {
                    let current = slice[slice.len() - 1];
                    let count_in_window = slice.len();
                    if count_in_window < 2 {
                        output[index] = Some(0.5);
                        continue;
                    }
                    // Fraction of the window at or below the current value, with
                    // ties averaged so equal values receive equal ranks.
                    let below = slice.iter().filter(|value| **value < current).count();
                    let equal = slice.iter().filter(|value| **value == current).count();
                    let position = below as f64 + (equal as f64 - 1.0) / 2.0;
                    output[index] = Some(position / (count_in_window - 1) as f64);
                }
            }
        }
        TimeSeriesOp::TsMean { window } => {
            for index in 0..count {
                if let Some(slice) = trailing_window(values, index, window) {
                    output[index] = Some(slice.iter().sum::<f64>() / slice.len() as f64);
                }
            }
        }
        TimeSeriesOp::TsSum { window } => {
            for index in 0..count {
                if let Some(slice) = trailing_window(values, index, window) {
                    output[index] = Some(slice.iter().sum::<f64>());
                }
            }
        }
        TimeSeriesOp::TsStd { window } => {
            for index in 0..count {
                if let Some(slice) = trailing_window(values, index, window) {
                    output[index] = Some(population_deviation(&slice));
                }
            }
        }
        TimeSeriesOp::TsMin { window } => {
            for index in 0..count {
                if let Some(slice) = trailing_window(values, index, window) {
                    output[index] = slice.iter().copied().fold(None, |acc: Option<f64>, value| {
                        Some(acc.map_or(value, |current| current.min(value)))
                    });
                }
            }
        }
        TimeSeriesOp::TsMax { window } => {
            for index in 0..count {
                if let Some(slice) = trailing_window(values, index, window) {
                    output[index] = slice.iter().copied().fold(None, |acc: Option<f64>, value| {
                        Some(acc.map_or(value, |current| current.max(value)))
                    });
                }
            }
        }
        TimeSeriesOp::TsZscore { window } => {
            for index in 0..count {
                if let Some(slice) = trailing_window(values, index, window) {
                    let mean = slice.iter().sum::<f64>() / slice.len() as f64;
                    let deviation = population_deviation(&slice);
                    let current = slice[slice.len() - 1];
                    output[index] = Some(if deviation <= f64::EPSILON {
                        0.0
                    } else {
                        (current - mean) / deviation
                    });
                }
            }
        }
    }
    output
}

/// Trailing window ending at `index`, or `None` when it is incomplete.
///
/// A window containing any missing value is incomplete. Skipping the gap would
/// compute over a shorter, differently-spaced window and silently report it as
/// the requested one.
fn trailing_window(values: &[Option<f64>], index: usize, window: usize) -> Option<Vec<f64>> {
    if window == 0 || index + 1 < window {
        return None;
    }
    let start = index + 1 - window;
    let mut collected = Vec::with_capacity(window);
    for value in &values[start..=index] {
        match value {
            Some(value) if value.is_finite() => collected.push(*value),
            _ => return None,
        }
    }
    Some(collected)
}

fn population_deviation(values: &[f64]) -> f64 {
    let count = values.len() as f64;
    let mean = values.iter().sum::<f64>() / count;
    (values
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f64>()
        / count)
        .sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cross_section::CrossSectionOp;
    use desic_chart_dsl::{Expression, OhlcvField};

    fn columns(closes: &[f64]) -> OhlcvColumns {
        OhlcvColumns {
            timestamp: (0..closes.len()).map(|i| i as i64 * 60_000).collect(),
            open: closes.to_vec(),
            high: closes.iter().map(|c| c + 1.0).collect(),
            low: closes.iter().map(|c| c - 1.0).collect(),
            close: closes.to_vec(),
            volume: closes.iter().map(|_| 100.0).collect(),
        }
    }

    fn panel(entries: &[(&str, &[f64])]) -> Vec<PanelInput> {
        entries
            .iter()
            .map(|(inst_id, closes)| PanelInput {
                inst_id: (*inst_id).to_string(),
                columns: columns(closes),
            })
            .collect()
    }

    fn close_expression() -> Expression {
        Expression::Field {
            field: OhlcvField::Close,
        }
    }

    #[test]
    fn cross_section_then_time_series_composes() {
        // This is the case a trailing-normalisation design cannot express:
        // ts_rank(cs_rank(close), 3). The cross-sectional rank produces a new
        // per-instrument series that the time-series stage then consumes.
        let expression = FactorExpression {
            series: close_expression(),
            pipeline: vec![
                FactorStage::CrossSection {
                    op: CrossSectionOp::CsRank { ascending: true },
                },
                FactorStage::TimeSeries {
                    op: TimeSeriesOp::TsRank { window: 3 },
                },
            ],
        };
        // A overtakes B across the three bars, so A's cross-sectional rank rises
        // and its rank-of-rank should end at the top of its own window.
        let panel = panel(&[("A", &[1.0, 5.0, 9.0]), ("B", &[8.0, 6.0, 4.0])]);
        let output =
            evaluate_panel(&expression, &panel, FactorLimits::default()).expect("evaluate");

        assert_eq!(output.bar_count, 3);
        assert_eq!(output.scored_count, 2);
        assert_eq!(output.latest[0], Some(1.0));
        assert_eq!(output.latest[1], Some(0.0));

        let ranked = output.ranked_latest();
        assert_eq!(ranked[0].0, "A");
        assert_eq!(ranked[1].0, "B");
    }

    #[test]
    fn cross_section_uses_only_the_current_bar() {
        // Each bar's statistic must depend on that bar alone. Bar 0 has A below
        // B and bar 1 has A above B, so the ranks must invert between them with
        // no influence from the other bar.
        let expression = FactorExpression {
            series: close_expression(),
            pipeline: vec![FactorStage::CrossSection {
                op: CrossSectionOp::CsRank { ascending: true },
            }],
        };
        let panel = panel(&[("A", &[1.0, 9.0]), ("B", &[5.0, 2.0])]);
        let output =
            evaluate_panel(&expression, &panel, FactorLimits::default()).expect("evaluate");

        assert_eq!(output.series[0], vec![Some(0.0), Some(1.0)]);
        assert_eq!(output.series[1], vec![Some(1.0), Some(0.0)]);
    }

    #[test]
    fn misaligned_and_duplicate_panels_are_rejected() {
        let expression = FactorExpression {
            series: close_expression(),
            pipeline: Vec::new(),
        };
        let limits = FactorLimits::default();

        // Different bar counts mean the rows do not represent the same moments.
        let misaligned = panel(&[("A", &[1.0, 2.0, 3.0]), ("B", &[1.0, 2.0])]);
        assert!(matches!(
            evaluate_panel(&expression, &misaligned, limits),
            Err(FactorDslError::MisalignedPanel { .. })
        ));

        let duplicated = panel(&[("A", &[1.0, 2.0]), ("A", &[3.0, 4.0])]);
        assert!(matches!(
            evaluate_panel(&expression, &duplicated, limits),
            Err(FactorDslError::DuplicateInstrument { .. })
        ));

        assert!(matches!(
            evaluate_panel(&expression, &[], limits),
            Err(FactorDslError::EmptyPanel)
        ));
    }

    #[test]
    fn boolean_series_are_rejected() {
        // A factor must be a score. A predicate cannot be ranked.
        let expression = FactorExpression {
            series: Expression::Comparison {
                op: desic_chart_dsl::ComparisonOp::GreaterThan,
                left: Box::new(close_expression()),
                right: Box::new(Expression::Number { value: 1.0 }),
            },
            pipeline: Vec::new(),
        };
        let panel = panel(&[("A", &[1.0, 2.0]), ("B", &[3.0, 4.0])]);
        assert!(matches!(
            evaluate_panel(&expression, &panel, FactorLimits::default()),
            Err(FactorDslError::NonNumericSeries { .. })
        ));
    }

    #[test]
    fn incomplete_windows_yield_no_value() {
        let expression = FactorExpression {
            series: close_expression(),
            pipeline: vec![FactorStage::TimeSeries {
                op: TimeSeriesOp::TsMean { window: 3 },
            }],
        };
        let panel = panel(&[("A", &[1.0, 2.0, 3.0, 4.0]), ("B", &[4.0, 3.0, 2.0, 1.0])]);
        let output =
            evaluate_panel(&expression, &panel, FactorLimits::default()).expect("evaluate");
        // The first two bars cannot fill a three-bar window.
        assert_eq!(output.series[0][0], None);
        assert_eq!(output.series[0][1], None);
        assert_eq!(output.series[0][2], Some(2.0));
        assert_eq!(output.series[0][3], Some(3.0));
    }

    #[test]
    fn delay_and_delta_shift_and_difference() {
        let delayed = apply_time_series(
            TimeSeriesOp::Delay { bars: 1 },
            &[Some(1.0), Some(2.0), Some(3.0)],
        );
        assert_eq!(delayed, vec![None, Some(1.0), Some(2.0)]);

        let differenced = apply_time_series(
            TimeSeriesOp::Delta { bars: 1 },
            &[Some(1.0), Some(4.0), Some(9.0)],
        );
        assert_eq!(differenced, vec![None, Some(3.0), Some(5.0)]);
    }

    #[test]
    fn validation_reports_the_total_history_required() {
        let expression = FactorExpression {
            series: Expression::Rolling {
                function: desic_chart_dsl::RollingFunction::Sma,
                input: Box::new(close_expression()),
                window: 20,
            },
            pipeline: vec![
                FactorStage::CrossSection {
                    op: CrossSectionOp::CsZscore,
                },
                FactorStage::TimeSeries {
                    op: TimeSeriesOp::TsMean { window: 5 },
                },
            ],
        };
        let validation = expression
            .validate(FactorLimits::default())
            .expect("validate");
        assert_eq!(validation.cross_section_ops, 1);
        // The stage adds four bars on top of the 19-bar series lookback.
        assert_eq!(validation.stage_lookback, 4);
        assert_eq!(validation.minimum_bars, validation.series_lookback + 5);
        assert!(expression.has_cross_section());
    }

    #[test]
    fn limits_are_enforced() {
        let expression = FactorExpression {
            series: close_expression(),
            pipeline: vec![FactorStage::TimeSeries {
                op: TimeSeriesOp::TsMean { window: 10 },
            }],
        };
        let limits = FactorLimits {
            max_stage_window: 5,
            ..FactorLimits::default()
        };
        assert!(matches!(
            expression.validate(limits),
            Err(FactorDslError::StageWindowInvalid { .. })
        ));

        let many = FactorExpression {
            series: close_expression(),
            pipeline: (0..3)
                .map(|_| FactorStage::CrossSection {
                    op: CrossSectionOp::CsZscore,
                })
                .collect(),
        };
        let tight = FactorLimits {
            max_cross_section_ops: 2,
            ..FactorLimits::default()
        };
        assert!(matches!(
            many.validate(tight),
            Err(FactorDslError::CrossSectionOpLimitExceeded { .. })
        ));

        let panel = panel(&[("A", &[1.0, 2.0]), ("B", &[3.0, 4.0])]);
        let narrow = FactorLimits {
            max_instruments: 1,
            ..FactorLimits::default()
        };
        assert!(matches!(
            evaluate_panel(&expression, &panel, narrow),
            Err(FactorDslError::PanelLimitExceeded { .. })
        ));
    }

    #[test]
    fn expressions_round_trip_through_json() {
        let expression = FactorExpression {
            series: close_expression(),
            pipeline: vec![
                FactorStage::CrossSection {
                    op: CrossSectionOp::CsRank { ascending: false },
                },
                FactorStage::TimeSeries {
                    op: TimeSeriesOp::TsZscore { window: 30 },
                },
            ],
        };
        let encoded = serde_json::to_string(&expression).expect("encode");
        let decoded = serde_json::from_str::<FactorExpression>(&encoded).expect("decode");
        assert_eq!(decoded, expression);
    }
}
