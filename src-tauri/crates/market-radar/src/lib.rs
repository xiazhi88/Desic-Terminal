#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DailyObservation {
    pub open_time: i64,
    pub close: f64,
    pub volume_quote: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResearchMetrics {
    pub as_of: i64,
    pub observations: usize,
    pub relative_strength_30d: f64,
    pub volatility_20d: f64,
    pub volume_ratio_20d: Option<f64>,
    pub trend_quality_30d: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResearchCandidate {
    pub instrument_id: String,
    pub metrics: ResearchMetrics,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResearchScore {
    pub instrument_id: String,
    pub metrics: ResearchMetrics,
    pub strength_score: f64,
    pub low_volatility_score: f64,
    pub activity_score: f64,
    pub trend_quality_score: f64,
    pub composite_score: f64,
    pub rank: usize,
}

pub fn calculate_research_metrics(observations: &[DailyObservation]) -> Option<ResearchMetrics> {
    let mut valid = observations
        .iter()
        .copied()
        .filter(|row| row.open_time > 0 && row.close.is_finite() && row.close > 0.0)
        .collect::<Vec<_>>();
    valid.sort_by_key(|row| row.open_time);
    valid.dedup_by_key(|row| row.open_time);
    if valid.len() < 31 {
        return None;
    }

    let tail = &valid[valid.len() - 31..];
    let latest = *tail.last()?;
    let relative_strength_30d = latest.close / tail.first()?.close - 1.0;
    let returns = tail
        .windows(2)
        .map(|pair| pair[1].close / pair[0].close - 1.0)
        .collect::<Vec<_>>();
    let volatility_20d = sample_std_dev(&returns[returns.len() - 20..]);
    let trend_quality_30d =
        linear_trend_quality(&tail.iter().map(|row| row.close.ln()).collect::<Vec<_>>());

    let recent_volumes = tail
        .iter()
        .filter_map(|row| {
            row.volume_quote
                .filter(|value| value.is_finite() && *value >= 0.0)
        })
        .collect::<Vec<_>>();
    let volume_ratio_20d = if recent_volumes.len() >= 21 {
        let latest_volume = *recent_volumes.last()?;
        let prior = &recent_volumes[recent_volumes.len() - 21..recent_volumes.len() - 1];
        let mean = prior.iter().sum::<f64>() / prior.len() as f64;
        (mean > 0.0).then_some(latest_volume / mean)
    } else {
        None
    };

    Some(ResearchMetrics {
        as_of: latest.open_time,
        observations: valid.len(),
        relative_strength_30d,
        volatility_20d,
        volume_ratio_20d,
        trend_quality_30d,
    })
}

pub fn score_cross_section(candidates: Vec<ResearchCandidate>) -> Vec<ResearchScore> {
    let strength_values = candidates
        .iter()
        .map(|row| row.metrics.relative_strength_30d)
        .collect::<Vec<_>>();
    let volatility_values = candidates
        .iter()
        .map(|row| row.metrics.volatility_20d)
        .collect::<Vec<_>>();
    let activity_values = candidates
        .iter()
        .filter_map(|row| row.metrics.volume_ratio_20d)
        .collect::<Vec<_>>();
    let trend_values = candidates
        .iter()
        .map(|row| row.metrics.trend_quality_30d)
        .collect::<Vec<_>>();

    let mut scores = candidates
        .into_iter()
        .map(|candidate| {
            let strength_score = percentile(
                &strength_values,
                candidate.metrics.relative_strength_30d,
                true,
            ) * 100.0;
            let low_volatility_score =
                percentile(&volatility_values, candidate.metrics.volatility_20d, false) * 100.0;
            let activity_score = candidate
                .metrics
                .volume_ratio_20d
                .map(|value| percentile(&activity_values, value, true) * 100.0)
                .unwrap_or(50.0);
            let trend_quality_score =
                percentile(&trend_values, candidate.metrics.trend_quality_30d, true) * 100.0;
            let composite_score = strength_score * 0.45
                + low_volatility_score * 0.20
                + activity_score * 0.20
                + trend_quality_score * 0.15;
            ResearchScore {
                instrument_id: candidate.instrument_id,
                metrics: candidate.metrics,
                strength_score,
                low_volatility_score,
                activity_score,
                trend_quality_score,
                composite_score,
                rank: 0,
            }
        })
        .collect::<Vec<_>>();
    scores.sort_by(|left, right| {
        right
            .composite_score
            .total_cmp(&left.composite_score)
            .then_with(|| left.instrument_id.cmp(&right.instrument_id))
    });
    for (index, score) in scores.iter_mut().enumerate() {
        score.rank = index + 1;
    }
    scores
}

fn percentile(values: &[f64], target: f64, higher_is_better: bool) -> f64 {
    let mut sorted = values
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    sorted.sort_by(f64::total_cmp);
    if sorted.len() <= 1 {
        return 0.5;
    }
    let first = sorted.partition_point(|value| *value < target);
    let end = sorted.partition_point(|value| *value <= target);
    let average_index = (first + end.saturating_sub(1)) as f64 / 2.0;
    let raw = average_index / (sorted.len() - 1) as f64;
    if higher_is_better {
        raw
    } else {
        1.0 - raw
    }
}

fn sample_std_dev(values: &[f64]) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let variance = values
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f64>()
        / (values.len() - 1) as f64;
    variance.sqrt()
}

fn linear_trend_quality(values: &[f64]) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    let x_mean = (values.len() - 1) as f64 / 2.0;
    let y_mean = values.iter().sum::<f64>() / values.len() as f64;
    let mut covariance = 0.0;
    let mut x_variance = 0.0;
    let mut y_variance = 0.0;
    for (index, value) in values.iter().copied().enumerate() {
        let x_delta = index as f64 - x_mean;
        let y_delta = value - y_mean;
        covariance += x_delta * y_delta;
        x_variance += x_delta.powi(2);
        y_variance += y_delta.powi(2);
    }
    if x_variance <= f64::EPSILON || y_variance <= f64::EPSILON {
        return 0.0;
    }
    (covariance.powi(2) / (x_variance * y_variance)).clamp(0.0, 1.0)
}

#[derive(Clone, Debug)]
pub struct ValidationObservation {
    pub snapshot_at: i64,
    pub instrument_id: String,
    pub rank: usize,
    pub score: f64,
    pub forward_return: f64,
    pub spread_bps: Option<f64>,
}

#[derive(Clone, Debug, Default)]
pub struct ValidationStats {
    pub observations: usize,
    pub dates: usize,
    pub rank_ic: Option<f64>,
    pub training_rank_ic: Option<f64>,
    pub validation_rank_ic: Option<f64>,
    pub top_quantile_return: Option<f64>,
    pub bottom_quantile_return: Option<f64>,
    pub gross_spread: Option<f64>,
    pub net_spread_after_cost: Option<f64>,
    pub top_quantile_win_rate: Option<f64>,
    pub top_quantile_turnover: Option<f64>,
}

pub fn evaluate_validation(observations: &[ValidationObservation]) -> ValidationStats {
    use std::collections::{BTreeMap, HashSet};

    let mut dates = BTreeMap::<i64, Vec<&ValidationObservation>>::new();
    for row in observations
        .iter()
        .filter(|row| row.rank > 0 && row.score.is_finite() && row.forward_return.is_finite())
    {
        dates.entry(row.snapshot_at).or_default().push(row);
    }
    let mut ics = Vec::new();
    let mut top_returns = Vec::new();
    let mut bottom_returns = Vec::new();
    let mut net_spreads = Vec::new();
    let mut turnovers = Vec::new();
    let mut previous_top = HashSet::<String>::new();
    for rows in dates.values_mut() {
        rows.sort_by_key(|row| row.rank);
        if rows.len() < 5 {
            continue;
        }
        let scores = rows.iter().map(|row| row.score).collect::<Vec<_>>();
        let returns = rows
            .iter()
            .map(|row| row.forward_return)
            .collect::<Vec<_>>();
        if let Some(ic) = spearman_correlation(&scores, &returns) {
            ics.push(ic);
        }
        let quantile_size = (rows.len() as f64 * 0.10).ceil().max(1.0) as usize;
        let top = &rows[..quantile_size.min(rows.len())];
        let bottom = &rows[rows.len().saturating_sub(quantile_size)..];
        let top_return = mean(top.iter().map(|row| row.forward_return));
        let bottom_return = mean(bottom.iter().map(|row| row.forward_return));
        let cost = mean(
            top.iter()
                .chain(bottom.iter())
                .filter_map(|row| row.spread_bps),
        )
        .unwrap_or(0.0)
            / 10_000.0;
        if let (Some(top_return), Some(bottom_return)) = (top_return, bottom_return) {
            top_returns.push(top_return);
            bottom_returns.push(bottom_return);
            net_spreads.push(top_return - bottom_return - cost);
        }
        let current_top = top
            .iter()
            .map(|row| row.instrument_id.clone())
            .collect::<HashSet<_>>();
        if !previous_top.is_empty() {
            let retained = current_top.intersection(&previous_top).count();
            turnovers.push(1.0 - retained as f64 / current_top.len().max(1) as f64);
        }
        previous_top = current_top;
    }
    let split = (ics.len() as f64 * 0.70).ceil() as usize;
    let training_rank_ic = mean(ics.iter().take(split).copied());
    let validation_rank_ic = mean(ics.iter().skip(split).copied());
    let top_quantile_return = mean(top_returns.iter().copied());
    let bottom_quantile_return = mean(bottom_returns.iter().copied());
    ValidationStats {
        observations: observations.len(),
        dates: dates.len(),
        rank_ic: mean(ics.iter().copied()),
        training_rank_ic,
        validation_rank_ic,
        top_quantile_return,
        bottom_quantile_return,
        gross_spread: top_quantile_return
            .zip(bottom_quantile_return)
            .map(|(top, bottom)| top - bottom),
        net_spread_after_cost: mean(net_spreads.iter().copied()),
        top_quantile_win_rate: if top_returns.is_empty() {
            None
        } else {
            Some(
                top_returns.iter().filter(|value| **value > 0.0).count() as f64
                    / top_returns.len() as f64,
            )
        },
        top_quantile_turnover: mean(turnovers.iter().copied()),
    }
}

fn mean(values: impl Iterator<Item = f64>) -> Option<f64> {
    let values = values.filter(|value| value.is_finite()).collect::<Vec<_>>();
    if values.is_empty() {
        None
    } else {
        Some(values.iter().sum::<f64>() / values.len() as f64)
    }
}

fn spearman_correlation(left: &[f64], right: &[f64]) -> Option<f64> {
    if left.len() != right.len() || left.len() < 3 {
        return None;
    }
    pearson_correlation(&ranks(left), &ranks(right))
}

fn ranks(values: &[f64]) -> Vec<f64> {
    let mut indices = (0..values.len()).collect::<Vec<_>>();
    indices.sort_by(|left, right| values[*left].total_cmp(&values[*right]));
    let mut result = vec![0.0; values.len()];
    let mut start = 0;
    while start < indices.len() {
        let mut end = start + 1;
        while end < indices.len() && values[indices[end]] == values[indices[start]] {
            end += 1;
        }
        let average_rank = (start + end - 1) as f64 / 2.0;
        for index in &indices[start..end] {
            result[*index] = average_rank;
        }
        start = end;
    }
    result
}

fn pearson_correlation(left: &[f64], right: &[f64]) -> Option<f64> {
    let left_mean = left.iter().sum::<f64>() / left.len() as f64;
    let right_mean = right.iter().sum::<f64>() / right.len() as f64;
    let mut covariance = 0.0;
    let mut left_variance = 0.0;
    let mut right_variance = 0.0;
    for (left, right) in left.iter().zip(right) {
        covariance += (left - left_mean) * (right - right_mean);
        left_variance += (left - left_mean).powi(2);
        right_variance += (right - right_mean).powi(2);
    }
    let denominator = (left_variance * right_variance).sqrt();
    (denominator > f64::EPSILON).then_some(covariance / denominator)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observations(slope: f64, volume_multiplier: f64) -> Vec<DailyObservation> {
        (0..40)
            .map(|day| DailyObservation {
                open_time: 1_700_000_000_000 + day * 86_400_000,
                close: 100.0 + day as f64 * slope,
                volume_quote: Some(if day == 39 {
                    1_000.0 * volume_multiplier
                } else {
                    1_000.0
                }),
            })
            .collect()
    }

    #[test]
    fn metrics_capture_direction_stability_and_volume_change() {
        let metrics = calculate_research_metrics(&observations(1.0, 2.0)).expect("metrics");
        assert!(metrics.relative_strength_30d > 0.20);
        assert!(metrics.trend_quality_30d > 0.99);
        assert!((metrics.volume_ratio_20d.unwrap_or_default() - 2.0).abs() < 1e-12);
    }

    #[test]
    fn metrics_require_thirty_return_periods() {
        assert!(calculate_research_metrics(&observations(1.0, 1.0)[..30]).is_none());
    }

    #[test]
    fn validation_separates_top_and_bottom_without_future_inputs() {
        let rows = (0..3)
            .flat_map(|day| {
                (0..10).map(move |rank| ValidationObservation {
                    snapshot_at: day * 86_400_000,
                    instrument_id: format!("ASSET-{rank}"),
                    rank: rank + 1,
                    score: (100 - rank) as f64,
                    forward_return: (10 - rank) as f64 / 100.0,
                    spread_bps: Some(2.0),
                })
            })
            .collect::<Vec<_>>();
        let report = evaluate_validation(&rows);
        assert_eq!(report.dates, 3);
        assert!(report.rank_ic.unwrap_or_default() > 0.99);
        assert!(report.gross_spread.unwrap_or_default() > 0.08);
        assert!(report.net_spread_after_cost.unwrap_or_default() < report.gross_spread.unwrap());
    }

    #[test]
    fn cross_section_rewards_strength_and_low_volatility() {
        let strong = calculate_research_metrics(&observations(1.0, 1.5)).expect("strong");
        let weak = calculate_research_metrics(&observations(-0.5, 0.8)).expect("weak");
        let scores = score_cross_section(vec![
            ResearchCandidate {
                instrument_id: "STRONG".to_string(),
                metrics: strong,
            },
            ResearchCandidate {
                instrument_id: "WEAK".to_string(),
                metrics: weak,
            },
        ]);
        assert_eq!(scores[0].instrument_id, "STRONG");
        assert_eq!(scores[0].rank, 1);
    }
}
