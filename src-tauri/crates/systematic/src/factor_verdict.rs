//! Mechanical verdicts on a factor evaluation.
//!
//! # Why this exists
//!
//! Every factor-research tool surveyed produces metrics and charts, and none of
//! them says whether the factor is any good. The sharpest illustration is that a
//! widely used open-source analyser ships a README example demonstrating a factor
//! with negative IC at every horizon, a t-statistic of -7.6, and a top quantile
//! performing *worse* than its bottom — without a sentence noting that it fails.
//! A reader who can already interpret those numbers did not need the tool.
//!
//! Every check here is decidable from numbers already computed. There is no
//! model, no inference, and no judgement call: a negative mean IC means the
//! ranking points the wrong way, and that can simply be stated.
//!
//! # What is deliberately not asserted
//!
//! Verdicts describe the *measurement*, never the tradability of the factor. A
//! result can pass every check and still lose money once funding, depth and
//! margin are accounted for. Findings therefore say what was measured and what
//! follows arithmetically, and stop there.

use serde::{Deserialize, Serialize};

use crate::factor_eval::{IcSummary, QuantileStat};

/// How much attention a finding demands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VerdictLevel {
    /// The measurement supports using the factor as intended.
    Pass,
    /// Usable, but something material limits interpretation.
    Caution,
    /// The measurement contradicts the factor's intended use.
    Fail,
}

/// One mechanically derived finding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerdictFinding {
    /// Stable identifier so the UI can attach its own copy and ordering.
    ///
    /// Owned rather than borrowed because findings are persisted with an
    /// evaluation and read back later, so the value has to outlive the code that
    /// produced it.
    pub code: String,
    pub level: VerdictLevel,
    /// The measured values this finding rests on, for display next to the text.
    pub detail: VerdictDetail,
}

/// Numbers backing a finding, so the UI never has to recompute them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerdictDetail {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub measured: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threshold: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
}

impl VerdictDetail {
    fn measured(value: f64) -> Self {
        Self {
            measured: Some(value),
            threshold: None,
            count: None,
        }
    }

    fn against(value: f64, threshold: f64) -> Self {
        Self {
            measured: Some(value),
            threshold: Some(threshold),
            count: None,
        }
    }

    fn counted(count: usize) -> Self {
        Self {
            measured: None,
            threshold: None,
            count: Some(count),
        }
    }

    fn empty() -> Self {
        Self {
            measured: None,
            threshold: None,
            count: None,
        }
    }
}

/// Direction a factor's author intended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IntendedSign {
    /// A higher score should precede a higher return.
    Positive,
    /// A higher score should precede a lower return.
    Negative,
    /// No direction declared; sign checks are skipped rather than guessed.
    Unspecified,
}

/// Everything the checks need. Assembled by the caller from an evaluation.
#[derive(Debug, Clone, PartialEq)]
pub struct VerdictInput {
    pub intended_sign: IntendedSign,
    /// In-sample IC summary.
    pub train_ic: Option<IcSummary>,
    /// Out-of-sample IC summary. Absent when the window was too short to split.
    pub validation_ic: Option<IcSummary>,
    pub quantiles: Vec<QuantileStat>,
    /// Mean rank autocorrelation between consecutive rebalances, if measured.
    pub rank_autocorrelation: Option<f64>,
    /// Mean per-rebalance turnover of the traded buckets, 0.0 to 1.0.
    pub turnover: Option<f64>,
    /// Annualised fee-only drag implied by the rebalance cadence at full
    /// turnover, as a fraction. Compared against the measured spread.
    pub annualised_cost_at_full_turnover: Option<f64>,
    /// Realised annualised Sharpe, when the caller computed one.
    pub sharpe: Option<f64>,
    /// Instruments scored in the thinnest rebalance.
    pub min_cross_section: usize,
    pub buckets: usize,
    /// Share of eligible instruments that produced no score, 0.0 to 1.0.
    pub dropped_pct: f64,
    /// Previews run before this evaluation, as a trial count.
    ///
    /// Selecting the best of many attempts inflates the apparent result, so the
    /// count is needed to interpret it.
    pub trials: usize,
}

/// Upper bound on a plausible cost-aware out-of-sample single-factor Sharpe.
///
/// Verified cost-aware results cluster around 0.4 to 1.0, with multi-factor
/// combinations reaching 2.0 to 2.5. A single-factor figure far above that range
/// is much more likely to indicate survivorship bias, look-ahead, unpaid fees or
/// uncounted funding than genuine skill, so it is flagged for inspection rather
/// than celebrated.
pub const IMPLAUSIBLE_SINGLE_FACTOR_SHARPE: f64 = 2.0;

/// Rank autocorrelation below which a ranking is effectively redrawn each period.
pub const LOW_RANK_AUTOCORRELATION: f64 = 0.5;

/// Trial count beyond which selection effects dominate a single result.
pub const HIGH_TRIAL_COUNT: usize = 20;

/// Coverage loss above which a ranking describes a small part of the universe.
pub const HIGH_DROPPED_PCT: f64 = 0.5;

/// Evaluates every check and returns findings ordered worst-first.
///
/// Ordering is by level so the UI can render the list top-down and have the most
/// consequential statement appear first without re-sorting.
pub fn evaluate_verdicts(input: &VerdictInput) -> Vec<VerdictFinding> {
    let mut findings = Vec::new();

    // The primary check: does the ranking point the intended way? This is the
    // one the reference tools omit, and it is decidable from the sign alone.
    if let Some(train) = &input.train_ic {
        match input.intended_sign {
            IntendedSign::Positive if train.mean < 0.0 => findings.push(VerdictFinding {
                code: "icSignInverted".to_string(),
                level: VerdictLevel::Fail,
                detail: VerdictDetail::measured(train.mean),
            }),
            IntendedSign::Negative if train.mean > 0.0 => findings.push(VerdictFinding {
                code: "icSignInverted".to_string(),
                level: VerdictLevel::Fail,
                detail: VerdictDetail::measured(train.mean),
            }),
            IntendedSign::Unspecified => {}
            _ => findings.push(VerdictFinding {
                code: "icSignAsIntended".to_string(),
                level: VerdictLevel::Pass,
                detail: VerdictDetail::measured(train.mean),
            }),
        }

        // A hit rate at or below a coin flip means the sign is not dependable
        // even when the mean happens to be favourable.
        if train.hit_rate <= 0.5 {
            findings.push(VerdictFinding {
                code: "hitRateAtChance".to_string(),
                level: VerdictLevel::Caution,
                detail: VerdictDetail::against(train.hit_rate, 0.5),
            });
        }
    } else {
        findings.push(VerdictFinding {
            code: "noIcMeasured".to_string(),
            level: VerdictLevel::Fail,
            detail: VerdictDetail::empty(),
        });
    }

    // Out-of-sample deterioration is the signature of a fitted result.
    if let (Some(train), Some(validation)) = (&input.train_ic, &input.validation_ic) {
        if train.mean.signum() != validation.mean.signum() && validation.mean.abs() > 1e-12 {
            findings.push(VerdictFinding {
                code: "signFlippedOutOfSample".to_string(),
                level: VerdictLevel::Fail,
                detail: VerdictDetail::against(validation.mean, train.mean),
            });
        } else if validation.mean.abs() < train.mean.abs() * 0.5 {
            findings.push(VerdictFinding {
                code: "weakenedOutOfSample".to_string(),
                level: VerdictLevel::Caution,
                detail: VerdictDetail::against(validation.mean, train.mean),
            });
        } else {
            findings.push(VerdictFinding {
                code: "heldOutOfSample".to_string(),
                level: VerdictLevel::Pass,
                detail: VerdictDetail::against(validation.mean, train.mean),
            });
        }
    } else if input.train_ic.is_some() {
        // Without a split there is no defence against fitting.
        findings.push(VerdictFinding {
            code: "noOutOfSampleWindow".to_string(),
            level: VerdictLevel::Caution,
            detail: VerdictDetail::empty(),
        });
    }

    // Thin buckets: the check no surveyed tool implements, and the one that
    // matters most on a universe of tens rather than thousands.
    if !input.quantiles.is_empty() {
        let thinnest = input
            .quantiles
            .iter()
            .map(|stat| stat.min_members_per_period)
            .min()
            .unwrap_or(0);
        if thinnest < 5 {
            findings.push(VerdictFinding {
                code: "thinQuantiles".to_string(),
                level: VerdictLevel::Caution,
                detail: VerdictDetail::counted(thinnest),
            });
        }

        // Report non-monotonicity without calling it failure: a profile that pays
        // at both extremes is tradable, and a monotonicity-only summary would
        // misdescribe it.
        if !crate::factor_eval::is_monotonic(&input.quantiles) {
            findings.push(VerdictFinding {
                code: "nonMonotonicProfile".to_string(),
                level: VerdictLevel::Caution,
                detail: VerdictDetail::empty(),
            });
        }

        // Overlapping error bars mean the spread is not distinguishable from
        // noise, regardless of its size.
        if let (Some(first), Some(last)) = (input.quantiles.first(), input.quantiles.last()) {
            let spread = last.mean_return - first.mean_return;
            let joint_error = (first.standard_error.powi(2) + last.standard_error.powi(2)).sqrt();
            if joint_error > 0.0 && spread.abs() < joint_error * 2.0 {
                findings.push(VerdictFinding {
                    code: "spreadWithinNoise".to_string(),
                    level: VerdictLevel::Caution,
                    detail: VerdictDetail::against(spread, joint_error * 2.0),
                });
            }
        }
    }

    // Turnover economics: gross return scales with the square root of rebalance
    // frequency while cost scales linearly, so a spread has to clear the cost of
    // the churn that produced it.
    if let (Some(turnover), Some(annual_cost)) =
        (input.turnover, input.annualised_cost_at_full_turnover)
    {
        let realised_cost = annual_cost * turnover;
        if let Some(spread) = crate::factor_eval::quantile_spread(&input.quantiles) {
            if spread.abs() < realised_cost {
                findings.push(VerdictFinding {
                    code: "costExceedsSpread".to_string(),
                    level: VerdictLevel::Fail,
                    detail: VerdictDetail::against(spread.abs(), realised_cost),
                });
            }
        }
    }

    if let Some(autocorrelation) = input.rank_autocorrelation {
        if autocorrelation < LOW_RANK_AUTOCORRELATION {
            findings.push(VerdictFinding {
                code: "rankingUnstable".to_string(),
                level: VerdictLevel::Caution,
                detail: VerdictDetail::against(autocorrelation, LOW_RANK_AUTOCORRELATION),
            });
        }
    }

    // An implausibly strong result is a prompt to check the inputs.
    if let Some(sharpe) = input.sharpe {
        if sharpe.abs() > IMPLAUSIBLE_SINGLE_FACTOR_SHARPE {
            findings.push(VerdictFinding {
                code: "implausiblyStrong".to_string(),
                level: VerdictLevel::Caution,
                detail: VerdictDetail::against(sharpe, IMPLAUSIBLE_SINGLE_FACTOR_SHARPE),
            });
        }
    }

    // A cross-section below two members is not a ranking at all.
    if input.min_cross_section < 2 {
        findings.push(VerdictFinding {
            code: "crossSectionTooNarrow".to_string(),
            level: VerdictLevel::Fail,
            detail: VerdictDetail::counted(input.min_cross_section),
        });
    } else if input.min_cross_section < input.buckets.saturating_mul(2) {
        findings.push(VerdictFinding {
            code: "crossSectionBelowBucketRequirement".to_string(),
            level: VerdictLevel::Caution,
            detail: VerdictDetail::counted(input.min_cross_section),
        });
    }

    if input.dropped_pct > HIGH_DROPPED_PCT {
        findings.push(VerdictFinding {
            code: "coverageLow".to_string(),
            level: VerdictLevel::Caution,
            detail: VerdictDetail::against(input.dropped_pct, HIGH_DROPPED_PCT),
        });
    }

    // Selection across many attempts inflates the best one. The expected maximum
    // from luck alone rises with the number of trials, so the count has to travel
    // with the result.
    if input.trials > HIGH_TRIAL_COUNT {
        findings.push(VerdictFinding {
            code: "manyTrials".to_string(),
            level: VerdictLevel::Caution,
            detail: VerdictDetail::counted(input.trials),
        });
    }

    findings.sort_by(|left, right| right.level.cmp(&left.level));
    findings
}

/// Worst level present, for a single headline state.
pub fn overall_level(findings: &[VerdictFinding]) -> VerdictLevel {
    findings
        .iter()
        .map(|finding| finding.level)
        .max()
        .unwrap_or(VerdictLevel::Pass)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ic(mean: f64, hit_rate: f64) -> IcSummary {
        IcSummary {
            mean,
            std_dev: 0.1,
            icir: mean / 0.1,
            t_stat: mean / 0.1 * 10.0,
            hit_rate,
            periods: 100,
        }
    }

    fn quantile(bucket: usize, mean_return: f64, members: usize) -> QuantileStat {
        QuantileStat {
            bucket,
            mean_return,
            std_dev: 0.001,
            count: members * 100,
            standard_error: 0.0001,
            min_members_per_period: members,
        }
    }

    fn healthy() -> VerdictInput {
        VerdictInput {
            intended_sign: IntendedSign::Positive,
            train_ic: Some(ic(0.04, 0.58)),
            validation_ic: Some(ic(0.038, 0.56)),
            quantiles: vec![
                quantile(0, -0.01, 10),
                quantile(1, 0.0, 10),
                quantile(2, 0.012, 10),
            ],
            rank_autocorrelation: Some(0.85),
            turnover: Some(0.1),
            annualised_cost_at_full_turnover: Some(0.05),
            sharpe: Some(0.7),
            min_cross_section: 30,
            buckets: 3,
            dropped_pct: 0.1,
            trials: 3,
        }
    }

    fn codes(findings: &[VerdictFinding]) -> Vec<&str> {
        findings
            .iter()
            .map(|finding| finding.code.as_str())
            .collect()
    }

    #[test]
    fn a_healthy_factor_passes_every_check() {
        let findings = evaluate_verdicts(&healthy());
        assert_eq!(overall_level(&findings), VerdictLevel::Pass);
        assert!(codes(&findings).contains(&"icSignAsIntended"));
        assert!(codes(&findings).contains(&"heldOutOfSample"));
    }

    #[test]
    fn an_inverted_factor_is_called_out() {
        // This is the case the reference tools ship without comment: every metric
        // is present and the factor points the wrong way.
        let mut input = healthy();
        input.train_ic = Some(ic(-0.031, 0.38));
        input.validation_ic = Some(ic(-0.028, 0.39));
        input.quantiles = vec![
            quantile(0, 0.012, 10),
            quantile(1, 0.0, 10),
            quantile(2, -0.01, 10),
        ];
        let findings = evaluate_verdicts(&input);

        assert_eq!(overall_level(&findings), VerdictLevel::Fail);
        assert!(codes(&findings).contains(&"icSignInverted"));
        assert!(codes(&findings).contains(&"hitRateAtChance"));
        // Worst-first ordering, so the failure leads.
        assert_eq!(findings[0].level, VerdictLevel::Fail);
        // The measured value travels with the finding.
        let inverted = findings
            .iter()
            .find(|finding| finding.code == "icSignInverted")
            .expect("finding");
        assert_eq!(inverted.detail.measured, Some(-0.031));
    }

    #[test]
    fn a_declared_negative_factor_is_not_penalised_for_being_negative() {
        // A reversal factor is supposed to have negative IC against raw score.
        // Judging it by a positive expectation would report a working factor as
        // broken.
        let mut input = healthy();
        input.intended_sign = IntendedSign::Negative;
        input.train_ic = Some(ic(-0.04, 0.57));
        input.validation_ic = Some(ic(-0.037, 0.55));
        let findings = evaluate_verdicts(&input);
        assert!(codes(&findings).contains(&"icSignAsIntended"));
        assert!(!codes(&findings).contains(&"icSignInverted"));
    }

    #[test]
    fn unspecified_intent_skips_the_sign_check_rather_than_guessing() {
        let mut input = healthy();
        input.intended_sign = IntendedSign::Unspecified;
        input.train_ic = Some(ic(-0.04, 0.45));
        let findings = evaluate_verdicts(&input);
        assert!(!codes(&findings).contains(&"icSignInverted"));
        assert!(!codes(&findings).contains(&"icSignAsIntended"));
    }

    #[test]
    fn out_of_sample_deterioration_is_graded() {
        let mut input = healthy();
        // Sign flip is the strongest evidence of fitting.
        input.validation_ic = Some(ic(-0.02, 0.44));
        assert!(codes(&evaluate_verdicts(&input)).contains(&"signFlippedOutOfSample"));

        // Same sign but much weaker is a caution, not a failure.
        input.validation_ic = Some(ic(0.005, 0.51));
        let findings = evaluate_verdicts(&input);
        assert!(codes(&findings).contains(&"weakenedOutOfSample"));
        assert!(!codes(&findings).contains(&"signFlippedOutOfSample"));

        // No split at all is its own caution.
        input.validation_ic = None;
        assert!(codes(&evaluate_verdicts(&input)).contains(&"noOutOfSampleWindow"));
    }

    #[test]
    fn thin_buckets_are_flagged() {
        // The crypto-specific case: a decile over forty instruments holds four
        // names, so its mean is an individual instrument's return.
        let mut input = healthy();
        input.quantiles = vec![
            quantile(0, -0.01, 4),
            quantile(1, 0.0, 4),
            quantile(2, 0.012, 4),
        ];
        assert!(codes(&evaluate_verdicts(&input)).contains(&"thinQuantiles"));

        // Ten members per bucket does not trip it.
        assert!(!codes(&evaluate_verdicts(&healthy())).contains(&"thinQuantiles"));
    }

    #[test]
    fn a_u_shaped_profile_is_a_caution_not_a_failure() {
        // Tradable but not monotonic: the finding must not be a failure, or a
        // real signal gets discarded.
        let mut input = healthy();
        input.quantiles = vec![
            quantile(0, 0.03, 10),
            quantile(1, -0.01, 10),
            quantile(2, 0.03, 10),
        ];
        let findings = evaluate_verdicts(&input);
        let finding = findings
            .iter()
            .find(|finding| finding.code == "nonMonotonicProfile")
            .expect("finding");
        assert_eq!(finding.level, VerdictLevel::Caution);
    }

    #[test]
    fn cost_exceeding_the_spread_is_a_failure() {
        let mut input = healthy();
        // Full-turnover annual cost of 110% at 80% turnover leaves 88% to clear,
        // which a spread of ~2% cannot.
        input.annualised_cost_at_full_turnover = Some(1.095);
        input.turnover = Some(0.8);
        let findings = evaluate_verdicts(&input);
        assert!(codes(&findings).contains(&"costExceedsSpread"));
        assert_eq!(overall_level(&findings), VerdictLevel::Fail);
    }

    #[test]
    fn unstable_rankings_and_implausible_strength_are_flagged() {
        let mut input = healthy();
        input.rank_autocorrelation = Some(0.31);
        assert!(codes(&evaluate_verdicts(&input)).contains(&"rankingUnstable"));

        let mut input = healthy();
        input.sharpe = Some(3.2);
        assert!(codes(&evaluate_verdicts(&input)).contains(&"implausiblyStrong"));

        // A plausible figure is not flagged.
        assert!(!codes(&evaluate_verdicts(&healthy())).contains(&"implausiblyStrong"));
    }

    #[test]
    fn narrow_cross_sections_and_low_coverage_are_flagged() {
        let mut input = healthy();
        input.min_cross_section = 1;
        let findings = evaluate_verdicts(&input);
        assert!(codes(&findings).contains(&"crossSectionTooNarrow"));
        assert_eq!(overall_level(&findings), VerdictLevel::Fail);

        // Five members cannot support three buckets at two per bucket.
        let mut input = healthy();
        input.min_cross_section = 5;
        assert!(codes(&evaluate_verdicts(&input)).contains(&"crossSectionBelowBucketRequirement"));

        let mut input = healthy();
        input.dropped_pct = 0.78;
        assert!(codes(&evaluate_verdicts(&input)).contains(&"coverageLow"));
    }

    #[test]
    fn many_trials_are_reported_so_selection_can_be_judged() {
        let mut input = healthy();
        input.trials = 120;
        let findings = evaluate_verdicts(&input);
        let finding = findings
            .iter()
            .find(|finding| finding.code == "manyTrials")
            .expect("finding");
        assert_eq!(finding.detail.count, Some(120));
    }

    #[test]
    fn a_missing_ic_is_itself_a_failure() {
        let mut input = healthy();
        input.train_ic = None;
        input.validation_ic = None;
        let findings = evaluate_verdicts(&input);
        assert!(codes(&findings).contains(&"noIcMeasured"));
        assert_eq!(overall_level(&findings), VerdictLevel::Fail);
    }

    #[test]
    fn findings_are_ordered_worst_first() {
        let mut input = healthy();
        input.train_ic = Some(ic(-0.03, 0.4));
        input.min_cross_section = 1;
        input.trials = 100;
        let findings = evaluate_verdicts(&input);
        // Levels must be non-increasing so the UI can render top-down.
        for pair in findings.windows(2) {
            assert!(pair[0].level >= pair[1].level);
        }
    }
}
