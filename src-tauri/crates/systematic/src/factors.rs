use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

use crate::SystematicError;

/// Lowest supported lookback for a cross-sectional K-line factor.  The
/// evaluator consumes one additional closed bar to calculate a return.
pub const MIN_KLINE_FACTOR_LOOKBACK_BARS: usize = 5;
pub const MAX_KLINE_FACTOR_LOOKBACK_BARS: usize = 2_000;
pub const MAX_KLINE_FACTOR_COMPONENT_WEIGHT: f64 = 5.0;

/// A transparent cross-sectional factor composed from local, confirmed K-line
/// inputs.  It is deliberately not a trained model and does not claim any
/// predictive validation until a separate factor-backtest protocol is added.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KlineBlendFactorDefinition {
    pub factor_id: String,
    pub lookback_bars: usize,
    pub momentum_weight: f64,
    pub volatility_penalty_weight: f64,
    pub volume_weight: f64,
}

impl KlineBlendFactorDefinition {
    pub fn baseline(factor_id: impl Into<String>) -> Self {
        Self {
            factor_id: factor_id.into(),
            lookback_bars: 60,
            momentum_weight: 1.0,
            volatility_penalty_weight: 1.0,
            volume_weight: 0.25,
        }
    }

    pub fn with_factor_id(mut self, factor_id: impl Into<String>) -> Self {
        self.factor_id = factor_id.into();
        self
    }

    pub fn minimum_bars(&self) -> usize {
        self.lookback_bars.saturating_add(1)
    }

    pub fn validate(&self) -> Result<(), SystematicError> {
        validate_factor_id(&self.factor_id)?;
        if !(MIN_KLINE_FACTOR_LOOKBACK_BARS..=MAX_KLINE_FACTOR_LOOKBACK_BARS)
            .contains(&self.lookback_bars)
        {
            return Err(SystematicError::invalid_argument(
                "lookbackBars",
                format!(
                    "must be an integer between {MIN_KLINE_FACTOR_LOOKBACK_BARS} and {MAX_KLINE_FACTOR_LOOKBACK_BARS}"
                ),
            ));
        }
        validate_weight("momentumWeight", self.momentum_weight, true)?;
        validate_weight(
            "volatilityPenaltyWeight",
            self.volatility_penalty_weight,
            false,
        )?;
        validate_weight("volumeWeight", self.volume_weight, true)?;
        if self.momentum_weight.abs() + self.volatility_penalty_weight + self.volume_weight.abs()
            <= f64::EPSILON
        {
            return Err(SystematicError::invalid_argument(
                "weights",
                "at least one component weight must be non-zero",
            ));
        }
        Ok(())
    }
}

/// Inputs are computed by the host from one aligned, confirmed data cutoff.
/// The pure scorer only consumes the finite values supplied here.
#[derive(Debug, Clone, PartialEq)]
pub struct KlineFactorFeatures {
    pub inst_id: String,
    pub momentum_pct: f64,
    pub realized_volatility_pct: f64,
    pub volume_ratio: f64,
}

/// A deterministic score for one instrument.  `normalized_score` is a
/// cross-sectional z-score for the selected factor and is only comparable
/// within the same aligned universe snapshot.
#[derive(Debug, Clone, PartialEq)]
pub struct KlineFactorScore {
    pub inst_id: String,
    pub raw_score: f64,
    pub normalized_score: f64,
}

/// Scores an aligned universe using z-scored components.  Higher realized
/// volatility is subtracted through the explicitly named penalty weight.
/// Momentum and volume weights may be negative for contrarian formulas.
pub fn score_kline_blend(
    definition: &KlineBlendFactorDefinition,
    features: &[KlineFactorFeatures],
) -> Result<Vec<KlineFactorScore>, SystematicError> {
    definition.validate()?;
    if features.is_empty() {
        return Ok(Vec::new());
    }

    let mut seen = std::collections::BTreeSet::new();
    for feature in features {
        validate_feature(feature)?;
        if !seen.insert(feature.inst_id.as_str()) {
            return Err(SystematicError::invalid_argument(
                "features",
                "instrument identifiers must be unique within an aligned universe",
            ));
        }
    }

    let momentum = z_scores(
        &features
            .iter()
            .map(|feature| feature.momentum_pct)
            .collect::<Vec<_>>(),
    );
    let volatility = z_scores(
        &features
            .iter()
            .map(|feature| feature.realized_volatility_pct)
            .collect::<Vec<_>>(),
    );
    let volume = z_scores(
        &features
            .iter()
            .map(|feature| feature.volume_ratio)
            .collect::<Vec<_>>(),
    );
    let raw_scores = features
        .iter()
        .enumerate()
        .map(|(index, _)| {
            definition.momentum_weight * momentum[index]
                - definition.volatility_penalty_weight * volatility[index]
                + definition.volume_weight * volume[index]
        })
        .collect::<Vec<_>>();
    let normalized = z_scores(&raw_scores);
    let mut scores = features
        .iter()
        .enumerate()
        .map(|(index, feature)| KlineFactorScore {
            inst_id: feature.inst_id.clone(),
            raw_score: raw_scores[index],
            normalized_score: normalized[index],
        })
        .collect::<Vec<_>>();
    scores.sort_by(|left, right| {
        right
            .normalized_score
            .partial_cmp(&left.normalized_score)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.inst_id.cmp(&right.inst_id))
    });
    Ok(scores)
}

fn validate_factor_id(value: &str) -> Result<(), SystematicError> {
    if value.is_empty()
        || value.len() > 160
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(SystematicError::invalid_argument(
            "factorId",
            "must contain only ASCII letters, digits, '-', '_' or '.'",
        ));
    }
    Ok(())
}

fn validate_weight(
    field: &'static str,
    value: f64,
    permits_negative: bool,
) -> Result<(), SystematicError> {
    let in_range = if permits_negative {
        value.abs() <= MAX_KLINE_FACTOR_COMPONENT_WEIGHT
    } else {
        (0.0..=MAX_KLINE_FACTOR_COMPONENT_WEIGHT).contains(&value)
    };
    if !value.is_finite() || !in_range {
        let range = if permits_negative {
            format!(
                "must be finite and between -{MAX_KLINE_FACTOR_COMPONENT_WEIGHT} and {MAX_KLINE_FACTOR_COMPONENT_WEIGHT}"
            )
        } else {
            format!("must be finite and between 0 and {MAX_KLINE_FACTOR_COMPONENT_WEIGHT}")
        };
        return Err(SystematicError::invalid_argument(field, range));
    }
    Ok(())
}

fn validate_feature(feature: &KlineFactorFeatures) -> Result<(), SystematicError> {
    if feature.inst_id.trim().is_empty() || feature.inst_id.len() > 160 {
        return Err(SystematicError::invalid_argument(
            "instId",
            "must be a non-empty instrument identifier",
        ));
    }
    for (field, value, permits_negative) in [
        ("momentumPct", feature.momentum_pct, true),
        (
            "realizedVolatilityPct",
            feature.realized_volatility_pct,
            false,
        ),
        ("volumeRatio", feature.volume_ratio, false),
    ] {
        if !value.is_finite() || (!permits_negative && value < 0.0) {
            return Err(SystematicError::data_contract(format!(
                "factor feature {field} is invalid"
            )));
        }
    }
    Ok(())
}

fn z_scores(values: &[f64]) -> Vec<f64> {
    if values.len() < 2 {
        return vec![0.0; values.len()];
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let standard_deviation = (values
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f64>()
        / values.len() as f64)
        .sqrt();
    if standard_deviation <= f64::EPSILON {
        return vec![0.0; values.len()];
    }
    values
        .iter()
        .map(|value| (value - mean) / standard_deviation)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn factor_definition_rejects_an_empty_formula() {
        let definition = KlineBlendFactorDefinition {
            factor_id: "factor-test".to_string(),
            lookback_bars: 60,
            momentum_weight: 0.0,
            volatility_penalty_weight: 0.0,
            volume_weight: 0.0,
        };
        assert!(definition.validate().is_err());
    }

    #[test]
    fn factor_definition_bounds_the_lookback_and_weights() {
        let too_short = KlineBlendFactorDefinition {
            lookback_bars: 4,
            ..KlineBlendFactorDefinition::baseline("factor-test")
        };
        assert!(too_short.validate().is_err());
        let invalid_weight = KlineBlendFactorDefinition {
            momentum_weight: 5.1,
            ..KlineBlendFactorDefinition::baseline("factor-test")
        };
        assert!(invalid_weight.validate().is_err());
    }

    #[test]
    fn momentum_formula_ranks_higher_momentum_first() {
        let definition = KlineBlendFactorDefinition {
            volatility_penalty_weight: 0.0,
            volume_weight: 0.0,
            ..KlineBlendFactorDefinition::baseline("factor-test")
        };
        let scores = score_kline_blend(
            &definition,
            &[
                KlineFactorFeatures {
                    inst_id: "BTC-USDT-SWAP".to_string(),
                    momentum_pct: 0.02,
                    realized_volatility_pct: 0.01,
                    volume_ratio: 1.0,
                },
                KlineFactorFeatures {
                    inst_id: "ETH-USDT-SWAP".to_string(),
                    momentum_pct: 0.08,
                    realized_volatility_pct: 0.01,
                    volume_ratio: 1.0,
                },
            ],
        )
        .expect("scores");
        assert_eq!(scores[0].inst_id, "ETH-USDT-SWAP");
        assert!(scores[0].normalized_score > scores[1].normalized_score);
    }

    #[test]
    fn ties_are_deterministic_by_instrument_identifier() {
        let definition = KlineBlendFactorDefinition::baseline("factor-test");
        let scores = score_kline_blend(
            &definition,
            &[
                KlineFactorFeatures {
                    inst_id: "SOL-USDT-SWAP".to_string(),
                    momentum_pct: 0.02,
                    realized_volatility_pct: 0.01,
                    volume_ratio: 1.0,
                },
                KlineFactorFeatures {
                    inst_id: "BTC-USDT-SWAP".to_string(),
                    momentum_pct: 0.02,
                    realized_volatility_pct: 0.01,
                    volume_ratio: 1.0,
                },
            ],
        )
        .expect("scores");
        assert_eq!(scores[0].inst_id, "BTC-USDT-SWAP");
    }
}
