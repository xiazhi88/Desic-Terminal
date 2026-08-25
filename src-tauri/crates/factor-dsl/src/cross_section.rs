//! Cross-sectional operators: statistics taken across instruments at one bar.
//!
//! Every operator here shares three rules, and they are the rules that make a
//! factor engine trustworthy rather than merely functional:
//!
//! 1. **A missing value stays missing.** An instrument without a value is
//!    excluded from the statistic and stays `None` in the output. Substituting
//!    zero would place it at the centre of the distribution, which is a claim
//!    about the instrument that the data does not support.
//! 2. **A degenerate cross-section returns zero, not an error.** One member, or
//!    every member equal, yields zero for everyone. That matches the existing
//!    K-line blend scorer, so switching a factor to an expression cannot change
//!    behaviour in that edge case.
//! 3. **Statistics use only the current bar.** Nothing reaches across
//!    timestamps. A widely used reference implementation winsorises using
//!    whole-sample moments and its own documentation admits this introduces
//!    look-ahead bias; doing that here would corrupt every evaluation, so it is
//!    structurally impossible in this module.

use serde::{Deserialize, Serialize};

use crate::FactorDslError;

/// How `cs_winsorize` decides what counts as an outlier.
///
/// Three named methods are offered rather than one opaque switch because they
/// disagree materially on heavy-tailed data, and crypto cross-sections are
/// heavy-tailed. MAD is the default because it does not itself depend on the
/// outliers it is meant to suppress.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "camelCase")]
pub enum WinsorizeMethod {
    /// Median plus/minus `scale` times the median absolute deviation.
    Mad { scale: f64 },
    /// Clip below `lower` and above `upper`, both fractions in 0..1.
    Percentile { lower: f64, upper: f64 },
    /// Mean plus/minus `scale` standard deviations.
    StdDev { scale: f64 },
}

/// Cross-sectional operator, applied across instruments at a single bar.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum CrossSectionOp {
    /// Fractional rank in 0..1, ties averaged.
    ///
    /// Rank discards magnitude, which makes it robust to the single-instrument
    /// outliers that are routine in crypto. It is usually the safer choice, and
    /// `cs_zscore` should be a deliberate decision rather than a default.
    CsRank { ascending: bool },
    /// `(x - mean) / std` across the cross-section.
    CsZscore,
    /// `x - mean(x)`; the minimal step toward a dollar-neutral score.
    CsDemean,
    /// Rescale so the absolute values sum to one.
    CsScale,
    /// Clip cross-sectional outliers before any later statistic.
    CsWinsorize { method: WinsorizeMethod },
    /// Clamp into an explicit range.
    CsClamp { min: f64, max: f64 },
    /// Assign bucket indices `0..buckets-1` by rank.
    ///
    /// Refuses to run when the cross-section is narrower than twice the bucket
    /// count: with fewer members than that, a bucket mean is dominated by
    /// individual instruments and reports precision it does not have.
    CsQuantize { buckets: usize },
}

impl CrossSectionOp {
    /// Stable operator name, matching the `cs_` naming convention.
    pub fn name(self) -> &'static str {
        match self {
            Self::CsRank { .. } => "cs_rank",
            Self::CsZscore => "cs_zscore",
            Self::CsDemean => "cs_demean",
            Self::CsScale => "cs_scale",
            Self::CsWinsorize { .. } => "cs_winsorize",
            Self::CsClamp { .. } => "cs_clamp",
            Self::CsQuantize { .. } => "cs_quantize",
        }
    }

    pub fn validate(&self) -> Result<(), FactorDslError> {
        match self {
            Self::CsRank { .. } | Self::CsZscore | Self::CsDemean | Self::CsScale => Ok(()),
            Self::CsWinsorize { method } => match method {
                WinsorizeMethod::Mad { scale } | WinsorizeMethod::StdDev { scale } => {
                    if !scale.is_finite() || *scale <= 0.0 || *scale > 20.0 {
                        return Err(FactorDslError::InvalidParameter {
                            field: "winsorizeScale",
                            message: "must be finite and between 0 and 20".to_string(),
                        });
                    }
                    Ok(())
                }
                WinsorizeMethod::Percentile { lower, upper } => {
                    if !lower.is_finite()
                        || !upper.is_finite()
                        || *lower < 0.0
                        || *upper > 1.0
                        || lower >= upper
                    {
                        return Err(FactorDslError::InvalidParameter {
                            field: "winsorizePercentile",
                            message: "must satisfy 0 <= lower < upper <= 1".to_string(),
                        });
                    }
                    Ok(())
                }
            },
            Self::CsClamp { min, max } => {
                if !min.is_finite() || !max.is_finite() || min >= max {
                    return Err(FactorDslError::InvalidParameter {
                        field: "clampBounds",
                        message: "must be finite with min < max".to_string(),
                    });
                }
                Ok(())
            }
            Self::CsQuantize { buckets } => {
                if *buckets < 2 || *buckets > 20 {
                    return Err(FactorDslError::InvalidParameter {
                        field: "buckets",
                        message: "must be between 2 and 20".to_string(),
                    });
                }
                Ok(())
            }
        }
    }

    /// Smallest cross-section this operator will act on.
    ///
    /// Below it the operator returns all-`None` rather than a misleading number.
    pub fn minimum_members(self) -> usize {
        match self {
            Self::CsQuantize { buckets } => buckets.saturating_mul(2),
            _ => crate::MIN_CROSS_SECTION_MEMBERS,
        }
    }
}

/// Applies one cross-sectional operator to a single bar's values.
///
/// `values` is one entry per instrument in the panel, in a stable order. `None`
/// means the instrument has no value at this bar; it is excluded from the
/// statistic and remains `None` in the result.
pub fn apply_cross_section(op: CrossSectionOp, values: &[Option<f64>]) -> Vec<Option<f64>> {
    let present: Vec<(usize, f64)> = values
        .iter()
        .enumerate()
        .filter_map(|(index, value)| value.and_then(|v| v.is_finite().then_some((index, v))))
        .collect();

    // Too thin to say anything: report nothing rather than a number that looks
    // like a ranking but is not.
    if present.len() < op.minimum_members() {
        return vec![None; values.len()];
    }

    let mut output = vec![None; values.len()];
    match op {
        CrossSectionOp::CsRank { ascending } => {
            // Average ties so equal inputs receive equal ranks. Sorting by value
            // then by index keeps the result deterministic.
            let mut ordered = present.clone();
            ordered.sort_by(|left, right| {
                left.1
                    .partial_cmp(&right.1)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| left.0.cmp(&right.0))
            });
            let count = ordered.len();
            let mut position = 0_usize;
            while position < count {
                let mut end = position + 1;
                while end < count && ordered[end].1 == ordered[position].1 {
                    end += 1;
                }
                // Mean of the 0-based positions this tie group spans, mapped to
                // 0..1 so the output is scale-free.
                let mean_position = (position + end - 1) as f64 / 2.0;
                let fraction = if count == 1 {
                    0.5
                } else {
                    mean_position / (count - 1) as f64
                };
                let fraction = if ascending { fraction } else { 1.0 - fraction };
                for entry in &ordered[position..end] {
                    output[entry.0] = Some(fraction);
                }
                position = end;
            }
        }
        CrossSectionOp::CsZscore => {
            let (mean, deviation) = mean_and_deviation(&present);
            for (index, value) in &present {
                // A flat cross-section carries no information; zero for everyone
                // matches the existing blend scorer instead of dividing by zero.
                output[*index] = Some(if deviation <= f64::EPSILON {
                    0.0
                } else {
                    (value - mean) / deviation
                });
            }
        }
        CrossSectionOp::CsDemean => {
            let (mean, _) = mean_and_deviation(&present);
            for (index, value) in &present {
                output[*index] = Some(value - mean);
            }
        }
        CrossSectionOp::CsScale => {
            let total: f64 = present.iter().map(|(_, value)| value.abs()).sum();
            for (index, value) in &present {
                output[*index] = Some(if total <= f64::EPSILON {
                    0.0
                } else {
                    value / total
                });
            }
        }
        CrossSectionOp::CsWinsorize { method } => {
            let (low, high) = winsorize_bounds(&present, method);
            for (index, value) in &present {
                output[*index] = Some(value.clamp(low, high));
            }
        }
        CrossSectionOp::CsClamp { min, max } => {
            for (index, value) in &present {
                output[*index] = Some(value.clamp(min, max));
            }
        }
        CrossSectionOp::CsQuantize { buckets } => {
            let mut ordered = present.clone();
            ordered.sort_by(|left, right| {
                left.1
                    .partial_cmp(&right.1)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| left.0.cmp(&right.0))
            });
            let count = ordered.len();
            for (position, entry) in ordered.iter().enumerate() {
                // Equal-count buckets; integer arithmetic keeps the split
                // deterministic and free of floating-point edge cases.
                let bucket = (position * buckets) / count;
                output[entry.0] = Some(bucket.min(buckets - 1) as f64);
            }
        }
    }
    output
}

/// Population mean and standard deviation of the present values.
///
/// Population (ddof = 0), matching the existing blend scorer. Sample standard
/// deviation is deliberately not used here: a separate reference implementation
/// uses ddof = 1 for its IC dispersion, and sharing one helper across the two
/// would silently change one of them.
fn mean_and_deviation(present: &[(usize, f64)]) -> (f64, f64) {
    let count = present.len() as f64;
    let mean = present.iter().map(|(_, value)| value).sum::<f64>() / count;
    let variance = present
        .iter()
        .map(|(_, value)| (value - mean).powi(2))
        .sum::<f64>()
        / count;
    (mean, variance.sqrt())
}

fn winsorize_bounds(present: &[(usize, f64)], method: WinsorizeMethod) -> (f64, f64) {
    match method {
        WinsorizeMethod::Mad { scale } => {
            let mut sorted = present.iter().map(|(_, value)| *value).collect::<Vec<_>>();
            sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let median = percentile_of_sorted(&sorted, 0.5);
            let mut deviations = sorted
                .iter()
                .map(|value| (value - median).abs())
                .collect::<Vec<_>>();
            deviations.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let mad = percentile_of_sorted(&deviations, 0.5);
            // 1.4826 scales the MAD to be comparable with a standard deviation
            // under normality, so `scale` reads like a sigma multiple.
            let spread = mad * 1.482_6 * scale;
            if spread <= f64::EPSILON {
                (f64::NEG_INFINITY, f64::INFINITY)
            } else {
                (median - spread, median + spread)
            }
        }
        WinsorizeMethod::Percentile { lower, upper } => {
            let mut sorted = present.iter().map(|(_, value)| *value).collect::<Vec<_>>();
            sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            (
                percentile_of_sorted(&sorted, lower),
                percentile_of_sorted(&sorted, upper),
            )
        }
        WinsorizeMethod::StdDev { scale } => {
            let (mean, deviation) = mean_and_deviation(present);
            if deviation <= f64::EPSILON {
                (f64::NEG_INFINITY, f64::INFINITY)
            } else {
                (mean - deviation * scale, mean + deviation * scale)
            }
        }
    }
}

/// Linear-interpolated percentile of an ascending slice.
fn percentile_of_sorted(sorted: &[f64], fraction: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    if sorted.len() == 1 {
        return sorted[0];
    }
    let position = fraction.clamp(0.0, 1.0) * (sorted.len() - 1) as f64;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    if lower == upper {
        return sorted[lower];
    }
    let weight = position - lower as f64;
    sorted[lower] * (1.0 - weight) + sorted[upper] * weight
}

#[cfg(test)]
mod tests {
    use super::*;

    fn some(values: &[f64]) -> Vec<Option<f64>> {
        values.iter().copied().map(Some).collect()
    }

    #[test]
    fn rank_is_fractional_and_averages_ties() {
        let values = some(&[10.0, 20.0, 30.0, 40.0]);
        let ranked = apply_cross_section(CrossSectionOp::CsRank { ascending: true }, &values);
        assert_eq!(
            ranked,
            vec![Some(0.0), Some(1.0 / 3.0), Some(2.0 / 3.0), Some(1.0)]
        );

        // Descending inverts, so the largest value ranks first.
        let descending = apply_cross_section(CrossSectionOp::CsRank { ascending: false }, &values);
        assert_eq!(descending[3], Some(0.0));
        assert_eq!(descending[0], Some(1.0));

        // A tie group receives the mean of the positions it spans.
        let tied = some(&[5.0, 5.0, 9.0]);
        let ranked = apply_cross_section(CrossSectionOp::CsRank { ascending: true }, &tied);
        assert_eq!(ranked[0], ranked[1]);
        assert_eq!(ranked[0], Some(0.25));
        assert_eq!(ranked[2], Some(1.0));
    }

    #[test]
    fn zscore_is_population_and_flat_when_degenerate() {
        let values = some(&[1.0, 2.0, 3.0]);
        let scored = apply_cross_section(CrossSectionOp::CsZscore, &values);
        let mean = scored.iter().filter_map(|v| *v).sum::<f64>() / 3.0;
        assert!(mean.abs() < 1e-12);
        // Population deviation of [1,2,3] is sqrt(2/3), so the ends are +-1.2247.
        assert!((scored[0].unwrap() + 1.224_744_871_391_589).abs() < 1e-9);

        // Identical inputs carry no cross-sectional information.
        let flat = some(&[7.0, 7.0, 7.0]);
        let scored = apply_cross_section(CrossSectionOp::CsZscore, &flat);
        assert_eq!(scored, vec![Some(0.0), Some(0.0), Some(0.0)]);
    }

    #[test]
    fn missing_values_are_excluded_and_stay_missing() {
        // The absent instrument must not be imputed to the mean, which is what
        // substituting zero would do after demeaning.
        let values = vec![Some(1.0), None, Some(3.0)];
        let scored = apply_cross_section(CrossSectionOp::CsDemean, &values);
        assert_eq!(scored[1], None);
        assert_eq!(scored[0], Some(-1.0));
        assert_eq!(scored[2], Some(1.0));

        // A non-finite value is treated as absent rather than poisoning the
        // statistic.
        let with_nan = vec![Some(1.0), Some(f64::NAN), Some(3.0)];
        let scored = apply_cross_section(CrossSectionOp::CsDemean, &with_nan);
        assert_eq!(scored[1], None);
        assert_eq!(scored[0], Some(-1.0));
    }

    #[test]
    fn thin_cross_sections_return_nothing() {
        // One member is not a ranking.
        let single = some(&[42.0]);
        assert_eq!(
            apply_cross_section(CrossSectionOp::CsZscore, &single),
            vec![None]
        );

        // Quantize needs at least two members per bucket, so five members cannot
        // support three buckets.
        let five = some(&[1.0, 2.0, 3.0, 4.0, 5.0]);
        assert_eq!(
            apply_cross_section(CrossSectionOp::CsQuantize { buckets: 3 }, &five),
            vec![None; 5]
        );
        // Six can.
        let six = some(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
        let bucketed = apply_cross_section(CrossSectionOp::CsQuantize { buckets: 3 }, &six);
        assert_eq!(
            bucketed,
            vec![
                Some(0.0),
                Some(0.0),
                Some(1.0),
                Some(1.0),
                Some(2.0),
                Some(2.0)
            ]
        );
    }

    #[test]
    fn scale_normalises_gross_exposure_to_one() {
        let values = some(&[3.0, -1.0]);
        let scaled = apply_cross_section(CrossSectionOp::CsScale, &values);
        let gross: f64 = scaled.iter().filter_map(|v| *v).map(f64::abs).sum();
        assert!((gross - 1.0).abs() < 1e-12);
        assert_eq!(scaled[0], Some(0.75));
        assert_eq!(scaled[1], Some(-0.25));
    }

    #[test]
    fn winsorize_clips_outliers_by_each_method() {
        // A single extreme value must be pulled in, not allowed to dominate.
        let values = some(&[1.0, 2.0, 3.0, 4.0, 500.0]);

        let mad = apply_cross_section(
            CrossSectionOp::CsWinsorize {
                method: WinsorizeMethod::Mad { scale: 3.0 },
            },
            &values,
        );
        assert!(mad[4].unwrap() < 500.0);
        assert_eq!(mad[0], Some(1.0));

        let percentile = apply_cross_section(
            CrossSectionOp::CsWinsorize {
                method: WinsorizeMethod::Percentile {
                    lower: 0.1,
                    upper: 0.9,
                },
            },
            &values,
        );
        assert!(percentile[4].unwrap() < 500.0);

        let std_dev = apply_cross_section(
            CrossSectionOp::CsWinsorize {
                method: WinsorizeMethod::StdDev { scale: 1.0 },
            },
            &values,
        );
        assert!(std_dev[4].unwrap() < 500.0);

        // Zero spread leaves values untouched rather than collapsing them.
        let flat = some(&[5.0, 5.0, 5.0]);
        let unchanged = apply_cross_section(
            CrossSectionOp::CsWinsorize {
                method: WinsorizeMethod::Mad { scale: 3.0 },
            },
            &flat,
        );
        assert_eq!(unchanged, vec![Some(5.0), Some(5.0), Some(5.0)]);
    }

    #[test]
    fn operator_parameters_are_validated() {
        assert!(CrossSectionOp::CsQuantize { buckets: 1 }
            .validate()
            .is_err());
        assert!(CrossSectionOp::CsQuantize { buckets: 5 }.validate().is_ok());
        assert!(CrossSectionOp::CsClamp { min: 1.0, max: 0.0 }
            .validate()
            .is_err());
        assert!(CrossSectionOp::CsWinsorize {
            method: WinsorizeMethod::Percentile {
                lower: 0.9,
                upper: 0.1
            }
        }
        .validate()
        .is_err());
        assert!(CrossSectionOp::CsWinsorize {
            method: WinsorizeMethod::Mad { scale: 0.0 }
        }
        .validate()
        .is_err());
    }

    #[test]
    fn operator_names_carry_their_scope() {
        // The naming convention is load-bearing: a bare `rank` is ambiguous
        // between cross-sectional and time-series meaning.
        assert_eq!(CrossSectionOp::CsRank { ascending: true }.name(), "cs_rank");
        assert_eq!(CrossSectionOp::CsZscore.name(), "cs_zscore");
        assert!(CrossSectionOp::CsScale.name().starts_with("cs_"));
    }
}
