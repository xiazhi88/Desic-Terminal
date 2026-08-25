//! Factor evaluation statistics: does a factor's ranking precede returns?
//!
//! Everything here is a pure function over already-aligned samples. No IO, no
//! clock, no randomness — given the same input it returns the same output. The
//! orchestration that reads candles and walks a grid lives in the app layer.
//!
//! # What is being measured
//!
//! A factor produces a score per instrument at a point in time. The question is
//! whether the *ordering* of those scores anticipates the ordering of subsequent
//! returns. The information coefficient answers exactly that: it is the rank
//! correlation between score and forward return, computed across instruments at
//! one moment, then summarised over many moments.
//!
//! # Deliberate choices, and why
//!
//! **Rank correlation, not linear.** A single instrument can move several hundred
//! percent in a day. Pearson correlation would let that one observation set the
//! result; Spearman only cares that it ranked first.
//!
//! **Ties get average ranks.** Factors quantise — bucketed or clipped scores
//! produce exact ties routinely — and dropping or arbitrarily ordering ties would
//! make the statistic depend on input order.
//!
//! **Sample standard deviation for dispersion across periods (ddof = 1), but
//! population within a cross-section (ddof = 0).** The two are genuinely
//! different estimands: a cross-section is the whole universe at that instant,
//! while the sequence of per-period ICs is a sample from a longer history. Two
//! widely used reference implementations differ on this, so the distinction is
//! made explicit here rather than shared through one helper.
//!
//! **The t-statistic is computed but must not be used as a decision rule at
//! minute resolution.** It grows as `ICIR * sqrt(N)`, so with hundreds of
//! thousands of overlapping observations per year every factor looks
//! overwhelmingly significant. Overlapping forward windows also violate the
//! independence assumption the test rests on. It is reported for completeness and
//! flagged, not used to gate anything.

use serde::{Deserialize, Serialize};

/// Summary of an information-coefficient series.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IcSummary {
    /// Mean IC. The first number to look at: its sign tells you whether the
    /// factor points the way its author intended.
    pub mean: f64,
    /// Sample standard deviation across periods (ddof = 1).
    pub std_dev: f64,
    /// Mean divided by standard deviation: consistency, not magnitude.
    pub icir: f64,
    /// `icir * sqrt(n)`. Inflated at high frequency; see the module note.
    pub t_stat: f64,
    /// Share of periods with a positive IC.
    pub hit_rate: f64,
    /// Periods contributing to the summary.
    pub periods: usize,
}

/// Per-bucket forward-return statistics.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuantileStat {
    /// Zero-based bucket index, ascending by factor score.
    pub bucket: usize,
    pub mean_return: f64,
    pub std_dev: f64,
    /// Observations in this bucket across all periods.
    pub count: usize,
    /// `std_dev / sqrt(count)`. Reported so a bucket mean is never read without
    /// its precision: with a thin universe the error bars often overlap
    /// completely, which a bare mean hides.
    pub standard_error: f64,
    /// Smallest per-period membership seen for this bucket.
    ///
    /// A bucket holding a handful of instruments has a mean dominated by
    /// individual names. This is surfaced so the conclusion layer can say so.
    pub min_members_per_period: usize,
}

/// Spearman rank correlation between two equal-length series.
///
/// Returns `None` when there are fewer than two usable pairs or when either side
/// is constant, because a correlation is undefined in both cases. Returning
/// `None` rather than 0.0 keeps "no information" distinct from "measured zero
/// correlation".
pub fn spearman_rank_ic(scores: &[f64], forwards: &[f64]) -> Option<f64> {
    if scores.len() != forwards.len() || scores.len() < 2 {
        return None;
    }
    let pairs: Vec<(f64, f64)> = scores
        .iter()
        .zip(forwards)
        .filter(|(score, forward)| score.is_finite() && forward.is_finite())
        .map(|(score, forward)| (*score, *forward))
        .collect();
    if pairs.len() < 2 {
        return None;
    }
    let score_ranks = average_ranks(&pairs.iter().map(|pair| pair.0).collect::<Vec<_>>());
    let forward_ranks = average_ranks(&pairs.iter().map(|pair| pair.1).collect::<Vec<_>>());
    pearson(&score_ranks, &forward_ranks)
}

/// Pearson correlation. Exposed because Spearman is Pearson over ranks, and
/// because factor-to-factor correlation is computed on already-ranked inputs.
pub fn pearson(left: &[f64], right: &[f64]) -> Option<f64> {
    if left.len() != right.len() || left.len() < 2 {
        return None;
    }
    let count = left.len() as f64;
    let left_mean = left.iter().sum::<f64>() / count;
    let right_mean = right.iter().sum::<f64>() / count;
    let mut covariance = 0.0;
    let mut left_variance = 0.0;
    let mut right_variance = 0.0;
    for (a, b) in left.iter().zip(right) {
        let da = a - left_mean;
        let db = b - right_mean;
        covariance += da * db;
        left_variance += da * da;
        right_variance += db * db;
    }
    // A constant series has no correlation with anything.
    if left_variance <= f64::EPSILON || right_variance <= f64::EPSILON {
        return None;
    }
    Some(covariance / (left_variance * right_variance).sqrt())
}

/// Average ranks, ties sharing the mean of the positions they span.
fn average_ranks(values: &[f64]) -> Vec<f64> {
    let mut indexed: Vec<(usize, f64)> = values.iter().copied().enumerate().collect();
    indexed.sort_by(|left, right| {
        left.1
            .partial_cmp(&right.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.0.cmp(&right.0))
    });
    let mut ranks = vec![0.0; values.len()];
    let mut position = 0_usize;
    while position < indexed.len() {
        let mut end = position + 1;
        while end < indexed.len() && indexed[end].1 == indexed[position].1 {
            end += 1;
        }
        let mean_rank = ((position + end - 1) as f64) / 2.0 + 1.0;
        for entry in &indexed[position..end] {
            ranks[entry.0] = mean_rank;
        }
        position = end;
    }
    ranks
}

/// Summarises a per-period IC series.
///
/// Non-finite entries are dropped: a period whose cross-section was too thin to
/// produce an IC should not count as a zero.
pub fn summarize_ic(per_period: &[f64]) -> Option<IcSummary> {
    let usable: Vec<f64> = per_period
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect();
    if usable.is_empty() {
        return None;
    }
    let count = usable.len() as f64;
    let mean = usable.iter().sum::<f64>() / count;
    // Sample standard deviation: these periods are a sample from a longer
    // history, not the whole population.
    let std_dev = if usable.len() < 2 {
        0.0
    } else {
        (usable
            .iter()
            .map(|value| (value - mean).powi(2))
            .sum::<f64>()
            / (count - 1.0))
            .sqrt()
    };
    let icir = if std_dev <= f64::EPSILON {
        0.0
    } else {
        mean / std_dev
    };
    let hit_rate = usable.iter().filter(|value| **value > 0.0).count() as f64 / count;
    Some(IcSummary {
        mean,
        std_dev,
        icir,
        t_stat: icir * count.sqrt(),
        hit_rate,
        periods: usable.len(),
    })
}

/// One instrument's observation at one period.
#[derive(Debug, Clone, PartialEq)]
pub struct FactorObservation {
    pub inst_id: String,
    pub score: f64,
    pub forward_return: f64,
}

/// Bucketed forward-return statistics across periods.
///
/// Buckets are assigned per period by score rank, so each period contributes its
/// own cross-sectional split rather than being pooled first. Pooling scores
/// across periods would let a level shift in the factor masquerade as
/// cross-sectional information.
///
/// Returns `None` when no period has at least `2 * buckets` members: below that
/// a bucket mean is dominated by individual instruments and reports precision it
/// does not have.
pub fn quantile_stats(
    periods: &[Vec<FactorObservation>],
    buckets: usize,
) -> Option<Vec<QuantileStat>> {
    if buckets < 2 {
        return None;
    }
    let minimum_members = buckets * 2;
    let mut returns_by_bucket: Vec<Vec<f64>> = vec![Vec::new(); buckets];
    let mut min_members: Vec<usize> = vec![usize::MAX; buckets];
    let mut usable_periods = 0_usize;

    for period in periods {
        let mut usable: Vec<&FactorObservation> = period
            .iter()
            .filter(|observation| {
                observation.score.is_finite() && observation.forward_return.is_finite()
            })
            .collect();
        if usable.len() < minimum_members {
            continue;
        }
        usable_periods += 1;
        usable.sort_by(|left, right| {
            left.score
                .partial_cmp(&right.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.inst_id.cmp(&right.inst_id))
        });
        let count = usable.len();
        let mut members_this_period = vec![0_usize; buckets];
        for (position, observation) in usable.iter().enumerate() {
            // Equal-count buckets via integer arithmetic, so the split is exact
            // and free of floating-point edge cases.
            let bucket = ((position * buckets) / count).min(buckets - 1);
            returns_by_bucket[bucket].push(observation.forward_return);
            members_this_period[bucket] += 1;
        }
        for (bucket, members) in members_this_period.into_iter().enumerate() {
            min_members[bucket] = min_members[bucket].min(members);
        }
    }

    if usable_periods == 0 {
        return None;
    }

    Some(
        returns_by_bucket
            .into_iter()
            .enumerate()
            .map(|(bucket, returns)| {
                let count = returns.len();
                let mean = if count == 0 {
                    0.0
                } else {
                    returns.iter().sum::<f64>() / count as f64
                };
                let std_dev = if count < 2 {
                    0.0
                } else {
                    (returns
                        .iter()
                        .map(|value| (value - mean).powi(2))
                        .sum::<f64>()
                        / (count as f64 - 1.0))
                        .sqrt()
                };
                QuantileStat {
                    bucket,
                    mean_return: mean,
                    std_dev,
                    count,
                    standard_error: if count == 0 {
                        0.0
                    } else {
                        std_dev / (count as f64).sqrt()
                    },
                    min_members_per_period: if min_members[bucket] == usize::MAX {
                        0
                    } else {
                        min_members[bucket]
                    },
                }
            })
            .collect(),
    )
}

/// Top-minus-bottom bucket spread.
pub fn quantile_spread(stats: &[QuantileStat]) -> Option<f64> {
    let first = stats.first()?;
    let last = stats.last()?;
    Some(last.mean_return - first.mean_return)
}

/// Whether bucket means increase monotonically with the factor score.
///
/// Reported alongside the full bucket profile, never instead of it. A real crypto
/// momentum signal has been documented producing a U-shaped profile — profitable
/// at both extremes — which a monotonicity summary alone would describe as
/// broken.
pub fn is_monotonic(stats: &[QuantileStat]) -> bool {
    stats
        .windows(2)
        .all(|pair| pair[1].mean_return >= pair[0].mean_return)
}

/// Fraction of a bucket's members that were not in it the previous period.
///
/// Turnover is the cost side of the trade-off: a factor whose ranking reshuffles
/// every period pays fees on every reshuffle, which is what destroys otherwise
/// real short-horizon signals.
pub fn bucket_turnover(previous: &[String], current: &[String]) -> Option<f64> {
    if current.is_empty() {
        return None;
    }
    let previous_set: std::collections::BTreeSet<&str> =
        previous.iter().map(String::as_str).collect();
    let entered = current
        .iter()
        .filter(|inst_id| !previous_set.contains(inst_id.as_str()))
        .count();
    Some(entered as f64 / current.len() as f64)
}

/// Rank autocorrelation between consecutive periods.
///
/// Near 1.0 means the ranking barely moves, so trading it costs little. Near 0.0
/// means the ranking is effectively redrawn each period. Only instruments present
/// in both periods are compared.
pub fn rank_autocorrelation(previous: &[(String, f64)], current: &[(String, f64)]) -> Option<f64> {
    let previous_map: std::collections::BTreeMap<&str, f64> = previous
        .iter()
        .map(|(inst_id, score)| (inst_id.as_str(), *score))
        .collect();
    let mut left = Vec::new();
    let mut right = Vec::new();
    for (inst_id, score) in current {
        if let Some(previous_score) = previous_map.get(inst_id.as_str()) {
            left.push(*previous_score);
            right.push(*score);
        }
    }
    if left.len() < 2 {
        return None;
    }
    let left_ranks = average_ranks(&left);
    let right_ranks = average_ranks(&right);
    pearson(&left_ranks, &right_ranks)
}

/// Rank correlation between two factors over the instruments they share.
///
/// A new factor highly correlated with an existing one adds little regardless of
/// its own IC: the library's value is in factors that disagree.
pub fn factor_correlation(left: &[(String, f64)], right: &[(String, f64)]) -> Option<f64> {
    let right_map: std::collections::BTreeMap<&str, f64> = right
        .iter()
        .map(|(inst_id, score)| (inst_id.as_str(), *score))
        .collect();
    let mut a = Vec::new();
    let mut b = Vec::new();
    for (inst_id, score) in left {
        if let Some(other) = right_map.get(inst_id.as_str()) {
            a.push(*score);
            b.push(*other);
        }
    }
    if a.len() < 2 {
        return None;
    }
    spearman_rank_ic(&a, &b)
}

/// Splits a period count into training and validation halves.
///
/// The 70/30 boundary matches the split the strategy optimiser already uses, so a
/// factor result and a parameter-tuning result mean the same thing by
/// "validation". Returns `None` when either side would be too small to summarise.
pub fn train_validation_split(periods: usize, minimum_each: usize) -> Option<(usize, usize)> {
    if periods == 0 {
        return None;
    }
    let train = (periods * 7) / 10;
    let validation = periods - train;
    if train < minimum_each || validation < minimum_each {
        return None;
    }
    Some((train, validation))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation(inst_id: &str, score: f64, forward_return: f64) -> FactorObservation {
        FactorObservation {
            inst_id: inst_id.to_string(),
            score,
            forward_return,
        }
    }

    #[test]
    fn spearman_detects_perfect_agreement_and_disagreement() {
        let scores = [1.0, 2.0, 3.0, 4.0];
        let same_order = [10.0, 20.0, 30.0, 40.0];
        assert!((spearman_rank_ic(&scores, &same_order).unwrap() - 1.0).abs() < 1e-12);

        let reversed = [40.0, 30.0, 20.0, 10.0];
        assert!((spearman_rank_ic(&scores, &reversed).unwrap() + 1.0).abs() < 1e-12);

        // Monotone but non-linear: Spearman still reports perfect agreement,
        // which is the reason for preferring it over Pearson here.
        let curved = [1.0, 4.0, 9.0, 1_000.0];
        assert!((spearman_rank_ic(&scores, &curved).unwrap() - 1.0).abs() < 1e-12);
    }

    #[test]
    fn spearman_returns_none_when_undefined() {
        // Fewer than two pairs.
        assert_eq!(spearman_rank_ic(&[1.0], &[2.0]), None);
        // Length mismatch.
        assert_eq!(spearman_rank_ic(&[1.0, 2.0], &[1.0]), None);
        // A constant side has no ordering to correlate.
        assert_eq!(spearman_rank_ic(&[1.0, 1.0, 1.0], &[1.0, 2.0, 3.0]), None);
        // Non-finite pairs are dropped, leaving too few.
        assert_eq!(
            spearman_rank_ic(&[1.0, f64::NAN, f64::NAN], &[1.0, 2.0, 3.0]),
            None
        );
    }

    #[test]
    fn ranks_average_ties() {
        // Two tied values occupying positions 1 and 2 both receive rank 1.5.
        let ranks = average_ranks(&[5.0, 5.0, 9.0]);
        assert_eq!(ranks, vec![1.5, 1.5, 3.0]);

        // Tie handling must not depend on input order.
        let forward = spearman_rank_ic(&[1.0, 1.0, 2.0], &[5.0, 6.0, 7.0]);
        let reordered = spearman_rank_ic(&[1.0, 1.0, 2.0], &[6.0, 5.0, 7.0]);
        assert_eq!(forward, reordered);
    }

    #[test]
    fn ic_summary_reports_consistency_separately_from_magnitude() {
        // Small but perfectly consistent.
        let steady = summarize_ic(&[0.02, 0.02, 0.02, 0.02]).expect("summary");
        assert!((steady.mean - 0.02).abs() < 1e-12);
        assert_eq!(steady.std_dev, 0.0);
        assert_eq!(steady.hit_rate, 1.0);
        assert_eq!(steady.periods, 4);

        // Larger mean but sign-flipping: lower ICIR despite higher mean.
        let erratic = summarize_ic(&[0.30, -0.24, 0.30, -0.24]).expect("summary");
        assert!(erratic.mean > steady.mean);
        assert!(erratic.icir.abs() < 1.0);
        assert_eq!(erratic.hit_rate, 0.5);

        // Non-finite periods are dropped rather than counted as zero.
        let sparse = summarize_ic(&[0.1, f64::NAN, 0.3]).expect("summary");
        assert_eq!(sparse.periods, 2);
        assert!((sparse.mean - 0.2).abs() < 1e-12);

        assert_eq!(summarize_ic(&[]), None);
        assert_eq!(summarize_ic(&[f64::NAN]), None);
    }

    #[test]
    fn negative_ic_is_reported_faithfully() {
        // The case that matters for the conclusion layer: a factor pointing the
        // wrong way must produce a clearly negative mean rather than a small
        // positive one.
        let summary = summarize_ic(&[-0.03, -0.04, -0.02, -0.05]).expect("summary");
        assert!(summary.mean < 0.0);
        assert!(summary.icir < 0.0);
        assert!(summary.t_stat < 0.0);
        assert_eq!(summary.hit_rate, 0.0);
    }

    #[test]
    fn quantile_stats_bucket_per_period_and_expose_thinness() {
        // Six instruments, three buckets: two members each, which is the minimum
        // this function will accept.
        let period = vec![
            observation("A", 1.0, -0.02),
            observation("B", 2.0, -0.01),
            observation("C", 3.0, 0.00),
            observation("D", 4.0, 0.01),
            observation("E", 5.0, 0.02),
            observation("F", 6.0, 0.03),
        ];
        let stats = quantile_stats(&[period.clone(), period], 3).expect("stats");
        assert_eq!(stats.len(), 3);
        // Ascending score buckets, so the top bucket holds the best returns.
        assert!(stats[0].mean_return < stats[2].mean_return);
        assert!(is_monotonic(&stats));
        assert_eq!(stats[0].count, 4);
        assert_eq!(stats[0].min_members_per_period, 2);
        // Bottom bucket averages (-0.02, -0.01) = -0.015; top averages
        // (0.02, 0.03) = 0.025; the spread is therefore 0.04.
        assert!((quantile_spread(&stats).unwrap() - 0.04).abs() < 1e-12);
        // Standard error accompanies every mean.
        assert!(stats.iter().all(|stat| stat.standard_error >= 0.0));
    }

    #[test]
    fn quantile_stats_refuse_a_cross_section_that_is_too_thin() {
        // Five instruments cannot support three buckets: fewer than two per
        // bucket makes a bucket mean an individual instrument's return.
        let thin = vec![
            observation("A", 1.0, 0.01),
            observation("B", 2.0, 0.02),
            observation("C", 3.0, 0.03),
            observation("D", 4.0, 0.04),
            observation("E", 5.0, 0.05),
        ];
        assert_eq!(quantile_stats(&[thin], 3), None);
        // Fewer than two buckets is not a split at all.
        assert_eq!(quantile_stats(&[], 1), None);
    }

    #[test]
    fn u_shaped_profiles_are_visible_rather_than_flattened() {
        // A profile that is profitable at both ends is tradable but not
        // monotonic. The statistics must show the shape instead of reducing it to
        // a single "broken" verdict.
        let period = vec![
            observation("A", 1.0, 0.04),
            observation("B", 2.0, 0.03),
            observation("C", 3.0, -0.01),
            observation("D", 4.0, -0.02),
            observation("E", 5.0, 0.03),
            observation("F", 6.0, 0.05),
        ];
        let stats = quantile_stats(&[period], 3).expect("stats");
        assert!(!is_monotonic(&stats));
        // Both extremes beat the middle.
        assert!(stats[0].mean_return > stats[1].mean_return);
        assert!(stats[2].mean_return > stats[1].mean_return);
        // The spread alone would call this factor nearly worthless.
        assert!(quantile_spread(&stats).unwrap().abs() < 0.02);
    }

    #[test]
    fn turnover_and_autocorrelation_measure_ranking_stability() {
        let previous = vec!["A".to_string(), "B".to_string(), "C".to_string()];
        // One of three names replaced.
        let current = vec!["A".to_string(), "B".to_string(), "D".to_string()];
        assert!((bucket_turnover(&previous, &current).unwrap() - 1.0 / 3.0).abs() < 1e-12);
        // Unchanged membership costs nothing.
        assert_eq!(bucket_turnover(&previous, &previous), Some(0.0));
        assert_eq!(bucket_turnover(&previous, &[]), None);

        let before = vec![
            ("A".to_string(), 3.0),
            ("B".to_string(), 2.0),
            ("C".to_string(), 1.0),
        ];
        // Identical ordering: maximally stable.
        assert!((rank_autocorrelation(&before, &before).unwrap() - 1.0).abs() < 1e-12);
        // Fully reversed ordering: maximally unstable.
        let reversed = vec![
            ("A".to_string(), 1.0),
            ("B".to_string(), 2.0),
            ("C".to_string(), 3.0),
        ];
        assert!((rank_autocorrelation(&before, &reversed).unwrap() + 1.0).abs() < 1e-12);
        // Too few shared instruments to compare.
        let disjoint = vec![("X".to_string(), 1.0), ("Y".to_string(), 2.0)];
        assert_eq!(rank_autocorrelation(&before, &disjoint), None);
    }

    #[test]
    fn factor_correlation_uses_shared_instruments_only() {
        let left = vec![
            ("A".to_string(), 1.0),
            ("B".to_string(), 2.0),
            ("C".to_string(), 3.0),
        ];
        // Same ordering over the shared names, plus one the other lacks.
        let right = vec![
            ("A".to_string(), 10.0),
            ("B".to_string(), 20.0),
            ("C".to_string(), 30.0),
            ("D".to_string(), 40.0),
        ];
        assert!((factor_correlation(&left, &right).unwrap() - 1.0).abs() < 1e-12);

        let opposed = vec![
            ("A".to_string(), 30.0),
            ("B".to_string(), 20.0),
            ("C".to_string(), 10.0),
        ];
        assert!((factor_correlation(&left, &opposed).unwrap() + 1.0).abs() < 1e-12);
    }

    #[test]
    fn train_validation_split_matches_the_optimiser_convention() {
        assert_eq!(train_validation_split(100, 10), Some((70, 30)));
        assert_eq!(train_validation_split(10, 2), Some((7, 3)));
        // Too short for both sides to be summarisable.
        assert_eq!(train_validation_split(10, 5), None);
        assert_eq!(train_validation_split(0, 1), None);
    }
}
