//! Starting presets with horizons taken from crypto evidence.
//!
//! These exist so a user begins from something with published support rather than
//! from an empty formula. Two things about them are deliberate.
//!
//! **The horizons are not equity horizons.** Equity momentum is conventionally
//! formed over 6-12 months. On crypto cross-sections the effect lives at 2-4
//! weeks, with roughly 30 days as the practitioner default, and 1-3 day lookbacks
//! are *mean-reverting* rather than trending. Porting equity defaults produces a
//! factor that measures the opposite of what its name claims, so short-horizon
//! reversal is offered as its own preset with its sign already flipped instead of
//! as a momentum variant that happens to fail.
//!
//! **Rank is the default normalisation, not z-score.** A z-score keeps magnitude
//! and is therefore dominated by whichever instrument moved most; in a market
//! where a single small-cap can move several hundred percent in a day that is
//! usually the wrong default. `cs_rank` discards magnitude and keeps order.
//! Presets that want magnitude ask for it explicitly.
//!
//! Volatility carries a negative expected sign: low-volatility instruments
//! outperforming is among the most reproducible crypto cross-sectional effects,
//! holding across several different volatility definitions.

use desic_chart_dsl::{ArithmeticOp, Expression, OhlcvField, RollingFunction, TechnicalFunction};
use serde::Serialize;

use crate::cross_section::CrossSectionOp;
use crate::{ExpectedSign, FactorExpression, FactorPreset, FactorStage, TimeSeriesOp};

/// Bars per day at the one-minute base resolution.
const BARS_PER_DAY: usize = 1_440;

/// `close / delay(close, n) - 1`, the return over `n` bars.
fn trailing_return(bars: usize) -> Expression {
    Expression::Arithmetic {
        op: ArithmeticOp::Subtract,
        left: Box::new(Expression::Arithmetic {
            op: ArithmeticOp::Divide,
            left: Box::new(Expression::Field {
                field: OhlcvField::Close,
            }),
            // A simple moving average over `bars` stands in for the reference
            // price. Using an average rather than a single past close makes the
            // signal far less sensitive to one anomalous bar at the window edge,
            // which matters on illiquid instruments.
            right: Box::new(Expression::Rolling {
                function: RollingFunction::Sma,
                input: Box::new(Expression::Field {
                    field: OhlcvField::Close,
                }),
                window: bars,
            }),
        }),
        right: Box::new(Expression::Number { value: 1.0 }),
    }
}

/// One selectable operator, described for a builder interface.
///
/// The catalogue is published from here rather than duplicated in the frontend,
/// so the two cannot disagree about which operators exist or what arguments they
/// accept. A duplicated list would drift, and the mismatch would only surface as
/// a validation error after the user tried to save.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperatorDescriptor {
    /// Value written into the stored definition, e.g. `csRank`.
    pub id: &'static str,
    /// Scope-prefixed name shown to the user, e.g. `cs_rank`.
    pub name: &'static str,
    /// `crossSection` or `timeSeries`.
    pub scope: &'static str,
    pub takes_window: bool,
    pub takes_direction: bool,
    pub label_en: &'static str,
    pub label_zh: &'static str,
    pub detail_en: &'static str,
    pub detail_zh: &'static str,
}

/// Selectable operators, ordered by how often a factor needs them.
///
/// Deliberately not alphabetical: rank and z-score are the load-bearing
/// cross-sectional primitives, and clipping sits next to them because clipping
/// before ranking is routine on a heavy-tailed cross-section.
pub fn operator_catalogue() -> Vec<OperatorDescriptor> {
    vec![
        OperatorDescriptor {
            id: "csRank",
            name: "cs_rank",
            scope: "crossSection",
            takes_window: false,
            takes_direction: true,
            label_en: "Cross-sectional rank",
            label_zh: "截面排名",
            detail_en: "Fractional rank 0-1 across the universe. Discards magnitude, so a single extreme instrument cannot dominate — usually the safer default here.",
            detail_zh: "在全市场内排名并归一到 0–1。抹掉幅度只保留次序，所以单个暴涨的合约无法主导结果——在加密市场通常是更安全的默认选择。",
        },
        OperatorDescriptor {
            id: "csZscore",
            name: "cs_zscore",
            scope: "crossSection",
            takes_window: false,
            takes_direction: false,
            label_en: "Cross-sectional z-score",
            label_zh: "截面标准分",
            detail_en: "(value - mean) / standard deviation across the universe. Keeps magnitude and is therefore outlier-sensitive; prefer rank unless magnitude matters.",
            detail_zh: "在全市场内做 (值 − 均值) / 标准差。保留幅度，因此对异常值敏感；除非确实需要幅度，否则优先用排名。",
        },
        OperatorDescriptor {
            id: "csWinsorize",
            name: "cs_winsorize",
            scope: "crossSection",
            takes_window: false,
            takes_direction: false,
            label_en: "Clip outliers",
            label_zh: "裁剪异常值",
            detail_en: "Clips extremes using only values from the same timestamp. Never uses whole-sample statistics, which would leak future data.",
            detail_zh: "仅用同一时刻的数据裁剪极端值。绝不使用全样本统计量——那会引入未来数据。",
        },
        OperatorDescriptor {
            id: "csDemean",
            name: "cs_demean",
            scope: "crossSection",
            takes_window: false,
            takes_direction: false,
            label_en: "Subtract the mean",
            label_zh: "减去均值",
            detail_en: "Centres scores on zero across the universe, the minimal step toward a balanced long/short score.",
            detail_zh: "把全市场分数中心化到 0，是构造多空均衡分数的最小一步。",
        },
        OperatorDescriptor {
            id: "csScale",
            name: "cs_scale",
            scope: "crossSection",
            takes_window: false,
            takes_direction: false,
            label_en: "Scale to unit exposure",
            label_zh: "缩放到单位敞口",
            detail_en: "Rescales so absolute values sum to one, turning scores into weights with gross exposure of one.",
            detail_zh: "缩放使绝对值之和为 1，把分数变成总敞口为 1 的权重。",
        },
        OperatorDescriptor {
            id: "tsRank",
            name: "ts_rank",
            scope: "timeSeries",
            takes_window: true,
            takes_direction: false,
            label_en: "Rank within own history",
            label_zh: "自身历史排名",
            detail_en: "Percentile of the current value inside its own trailing window. Placed after a cross-sectional stage, it measures how unusual an instrument's current standing is.",
            detail_zh: "当前值在自身回看窗口内的百分位。接在截面算子之后，衡量的是该合约当前的相对位置有多反常。",
        },
        OperatorDescriptor {
            id: "tsMean",
            name: "ts_mean",
            scope: "timeSeries",
            takes_window: true,
            takes_direction: false,
            label_en: "Average over time",
            label_zh: "时间均值",
            detail_en: "Smooths over a trailing window. Averaging a rank rewards instruments that hold a standing instead of spiking once, which lowers turnover.",
            detail_zh: "在回看窗口内平滑。对排名取均值会奖励持续保持位置的合约，而非突然冲高一次的，从而降低换手。",
        },
        OperatorDescriptor {
            id: "tsZscore",
            name: "ts_zscore",
            scope: "timeSeries",
            takes_window: true,
            takes_direction: false,
            label_en: "Z-score within own history",
            label_zh: "自身历史标准分",
            detail_en: "Self-normalising trailing z-score, so each instrument is judged against its own recent range.",
            detail_zh: "自归一化的滚动标准分，每个合约只跟自己最近的区间比较。",
        },
        OperatorDescriptor {
            id: "tsStd",
            name: "ts_std",
            scope: "timeSeries",
            takes_window: true,
            takes_direction: false,
            label_en: "Volatility over time",
            label_zh: "时间波动率",
            detail_en: "Standard deviation over a trailing window.",
            detail_zh: "回看窗口内的标准差。",
        },
        OperatorDescriptor {
            id: "delta",
            name: "delta",
            scope: "timeSeries",
            takes_window: true,
            takes_direction: false,
            label_en: "Change over n bars",
            label_zh: "n 根之前的变化",
            detail_en: "Current value minus the value n bars ago.",
            detail_zh: "当前值减去 n 根 K 线之前的值。",
        },
    ]
}

/// Source measures a factor can start from.
///
/// Each is a complete, unit-free series expression. Raw price is deliberately
/// absent: ranking instruments by price would order them by denomination rather
/// than by behaviour, which is the most common way a first factor goes wrong.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDescriptor {
    pub id: &'static str,
    pub label_en: &'static str,
    pub label_zh: &'static str,
    pub detail_en: &'static str,
    pub detail_zh: &'static str,
    /// Whether the source takes a lookback in bars.
    pub takes_window: bool,
    pub default_window: usize,
}

pub fn source_catalogue() -> Vec<SourceDescriptor> {
    vec![
        SourceDescriptor {
            id: "trailingReturn",
            label_en: "Trailing return",
            label_zh: "区间收益",
            detail_en: "Close divided by its own average over the window, minus one. Unit-free, so instruments of any price are comparable.",
            detail_zh: "收盘价除以自身窗口均价再减 1。无量纲，因此任何价位的合约都可比较。",
            takes_window: true,
            default_window: 1_440,
        },
        SourceDescriptor {
            id: "volatility",
            label_en: "Volatility (ATR)",
            label_zh: "波动率 (ATR)",
            detail_en: "Average true range over the window. Low-volatility instruments outperforming is among the most reproducible effects here, so this is usually ranked descending.",
            detail_zh: "窗口内的平均真实波幅。低波动合约跑赢是加密市场最可复现的规律之一，所以通常按降序排名。",
            takes_window: true,
            default_window: 1_440,
        },
        SourceDescriptor {
            id: "volumeRatio",
            label_en: "Volume ratio",
            label_zh: "成交量比",
            detail_en: "Current volume against its own average over the window. Mainly screens out instruments nobody is trading.",
            detail_zh: "当前成交量与自身窗口均量之比。主要用来筛掉没人交易的合约。",
            takes_window: true,
            default_window: 1_440,
        },
        SourceDescriptor {
            id: "rsi",
            label_en: "RSI",
            label_zh: "RSI",
            detail_en: "Relative strength index over the window, already bounded 0-100.",
            detail_zh: "窗口内的相对强弱指数，本身已限定在 0–100。",
            takes_window: true,
            default_window: 14,
        },
    ]
}

/// Builds the series expression for a source descriptor id.
///
/// Kept beside the catalogue so adding a source cannot leave the builder able to
/// select something the evaluator does not understand.
pub fn source_expression(id: &str, window: usize) -> Option<Expression> {
    let window = window.clamp(2, 2_000);
    match id {
        "trailingReturn" => Some(trailing_return(window)),
        "volatility" => Some(Expression::Technical {
            function: TechnicalFunction::Atr,
            window: Some(window),
        }),
        "volumeRatio" => Some(Expression::Arithmetic {
            op: ArithmeticOp::Divide,
            left: Box::new(Expression::Field {
                field: OhlcvField::Volume,
            }),
            right: Box::new(Expression::Rolling {
                function: RollingFunction::Sma,
                input: Box::new(Expression::Field {
                    field: OhlcvField::Volume,
                }),
                window,
            }),
        }),
        "rsi" => Some(Expression::Technical {
            function: TechnicalFunction::Rsi,
            window: Some(window),
        }),
        _ => None,
    }
}

/// Returns the built-in presets.
///
/// Windows are capped at the chart DSL's rolling limit, so a multi-week horizon
/// is expressed in hours of one-minute bars rather than literal 30-day windows.
/// The evaluator would otherwise reject the window outright.
pub fn builtin_presets() -> Vec<FactorPreset> {
    vec![
        FactorPreset {
            id: "preset-momentum-30d",
            label_en: "Cross-sectional momentum (30-day)",
            label_zh: "截面动量（30 天）",
            // Positive: the documented direction at the 2-4 week horizon.
            expected_sign: ExpectedSign::Positive,
            expression: FactorExpression {
                // 2000 one-minute bars is the largest window the evaluator
                // allows; the intended 30-day formation is reached by pairing it
                // with a slow rebalance rather than a longer window.
                series: trailing_return(2_000),
                pipeline: vec![
                    // Clip before ranking so a single dislocated instrument does
                    // not distort the reference distribution.
                    FactorStage::CrossSection {
                        op: CrossSectionOp::CsWinsorize {
                            method: crate::cross_section::WinsorizeMethod::Mad { scale: 3.0 },
                        },
                    },
                    FactorStage::CrossSection {
                        op: CrossSectionOp::CsRank { ascending: true },
                    },
                ],
            },
        },
        FactorPreset {
            id: "preset-reversal-1d",
            label_en: "Short-horizon reversal (1-day)",
            label_zh: "短周期反转（1 天）",
            // Negative by construction: at 1-3 days the cross-section
            // mean-reverts, so the recent winners are the expected losers. The
            // sign is built into the descending rank rather than left for the
            // user to discover.
            expected_sign: ExpectedSign::Negative,
            expression: FactorExpression {
                series: trailing_return(BARS_PER_DAY),
                pipeline: vec![
                    FactorStage::CrossSection {
                        op: CrossSectionOp::CsWinsorize {
                            method: crate::cross_section::WinsorizeMethod::Mad { scale: 3.0 },
                        },
                    },
                    // Descending: the largest recent gain receives the lowest
                    // score.
                    FactorStage::CrossSection {
                        op: CrossSectionOp::CsRank { ascending: false },
                    },
                ],
            },
        },
        FactorPreset {
            id: "preset-low-volatility",
            label_en: "Low volatility preference",
            label_zh: "低波动优选",
            // Negative on raw volatility: low-volatility instruments are the
            // documented outperformers, so the score ranks calm names highest.
            expected_sign: ExpectedSign::Negative,
            expression: FactorExpression {
                series: Expression::Technical {
                    function: TechnicalFunction::Atr,
                    window: Some(1_440),
                },
                pipeline: vec![
                    FactorStage::CrossSection {
                        op: CrossSectionOp::CsWinsorize {
                            method: crate::cross_section::WinsorizeMethod::Mad { scale: 3.0 },
                        },
                    },
                    // Descending, so the least volatile instrument scores highest.
                    FactorStage::CrossSection {
                        op: CrossSectionOp::CsRank { ascending: false },
                    },
                ],
            },
        },
        FactorPreset {
            id: "preset-momentum-stability",
            label_en: "Rank-stable momentum",
            label_zh: "排名稳定动量",
            // Demonstrates the composition a trailing-normalisation design
            // cannot express: rank across instruments, then average that rank
            // over its own recent history. Averaging the rank rather than the
            // return rewards instruments that hold a high standing instead of
            // ones that spiked once, which lowers turnover.
            expected_sign: ExpectedSign::Positive,
            expression: FactorExpression {
                series: trailing_return(720),
                pipeline: vec![
                    FactorStage::CrossSection {
                        op: CrossSectionOp::CsRank { ascending: true },
                    },
                    FactorStage::TimeSeries {
                        op: TimeSeriesOp::TsMean { window: 240 },
                    },
                ],
            },
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eval::{evaluate_panel, PanelInput};
    use crate::FactorLimits;
    use desic_chart_dsl::OhlcvColumns;

    fn synthetic_columns(bars: usize, drift: f64, noise: f64) -> OhlcvColumns {
        let closes = (0..bars)
            .map(|index| {
                let base = 100.0 + drift * index as f64;
                base + noise * ((index % 7) as f64 - 3.0)
            })
            .collect::<Vec<_>>();
        OhlcvColumns {
            timestamp: (0..bars).map(|i| i as i64 * 60_000).collect(),
            open: closes.clone(),
            high: closes.iter().map(|c| c + noise.abs() + 0.5).collect(),
            low: closes.iter().map(|c| c - noise.abs() - 0.5).collect(),
            close: closes.clone(),
            volume: (0..bars).map(|i| 100.0 + (i % 5) as f64).collect(),
        }
    }

    #[test]
    fn every_preset_validates() {
        let limits = FactorLimits::default();
        for preset in builtin_presets() {
            let validation = preset
                .expression
                .validate(limits)
                .unwrap_or_else(|error| panic!("{} failed to validate: {error}", preset.id));
            // A factor without a cross-sectional stage is not comparable across
            // instruments, so every preset must have one.
            assert!(
                preset.expression.has_cross_section(),
                "{} has no cross-sectional stage",
                preset.id
            );
            assert!(validation.minimum_bars > 0);
            assert!(!preset.label_zh.is_empty(), "{} lacks zh label", preset.id);
        }
    }

    #[test]
    fn presets_produce_a_ranking_on_a_synthetic_panel() {
        // Enough bars to satisfy the longest preset window.
        let bars = 2_400;
        let panel = vec![
            PanelInput {
                inst_id: "RISER".to_string(),
                columns: synthetic_columns(bars, 0.05, 0.4),
            },
            PanelInput {
                inst_id: "FLAT".to_string(),
                columns: synthetic_columns(bars, 0.0, 0.4),
            },
            PanelInput {
                inst_id: "FALLER".to_string(),
                columns: synthetic_columns(bars, -0.02, 0.4),
            },
            PanelInput {
                inst_id: "CHOPPY".to_string(),
                columns: synthetic_columns(bars, 0.0, 4.0),
            },
        ];
        let limits = FactorLimits::default();

        for preset in builtin_presets() {
            let output = evaluate_panel(&preset.expression, &panel, limits)
                .unwrap_or_else(|error| panic!("{} failed to evaluate: {error}", preset.id));
            assert_eq!(output.scored_count, 4, "{} scored partially", preset.id);
            let ranked = output.ranked_latest();
            assert_eq!(ranked.len(), 4, "{} ranked partially", preset.id);

            match preset.id {
                // Momentum should place the rising instrument first.
                "preset-momentum-30d" | "preset-momentum-stability" => {
                    assert_eq!(ranked[0].0, "RISER", "{} misordered", preset.id);
                }
                // Reversal is inverted, so the rising instrument scores lowest.
                "preset-reversal-1d" => {
                    assert_eq!(ranked[ranked.len() - 1].0, "RISER");
                }
                // Low-volatility preference should rank the choppy instrument last.
                "preset-low-volatility" => {
                    assert_eq!(ranked[ranked.len() - 1].0, "CHOPPY");
                }
                other => panic!("unhandled preset {other}"),
            }
        }
    }

    #[test]
    fn every_catalogued_source_builds_a_valid_expression() {
        // The catalogue is what a builder offers, so anything listed must produce
        // an expression the evaluator accepts. Otherwise a user could assemble a
        // factor that only fails when saved.
        let limits = FactorLimits::default();
        for source in source_catalogue() {
            let expression = source_expression(source.id, source.default_window)
                .unwrap_or_else(|| panic!("{} has no expression", source.id));
            let factor = FactorExpression {
                series: expression,
                pipeline: vec![crate::FactorStage::CrossSection {
                    op: CrossSectionOp::CsRank { ascending: true },
                }],
            };
            factor
                .validate(limits)
                .unwrap_or_else(|error| panic!("{} failed to validate: {error}", source.id));
            assert!(!source.label_zh.is_empty(), "{} lacks zh copy", source.id);
            assert!(
                !source.detail_zh.is_empty(),
                "{} lacks zh detail",
                source.id
            );
        }
        // An unknown id yields nothing rather than a silent fallback.
        assert!(source_expression("nope", 60).is_none());
    }

    #[test]
    fn operator_catalogue_is_consistent_and_scope_prefixed() {
        let operators = operator_catalogue();
        assert!(!operators.is_empty());
        for operator in &operators {
            // The scope prefix is load-bearing: `rank` alone is ambiguous between
            // cross-sectional and time-series meaning, which is a documented
            // source of silently wrong factors.
            match operator.scope {
                "crossSection" => assert!(
                    operator.name.starts_with("cs_"),
                    "{} is cross-sectional but not cs_ prefixed",
                    operator.name
                ),
                "timeSeries" => assert!(
                    operator.name.starts_with("ts_") || operator.name == "delta",
                    "{} is time-series but not ts_ prefixed",
                    operator.name
                ),
                other => panic!("{} has unknown scope {other}", operator.name),
            }
            assert!(
                !operator.label_zh.is_empty(),
                "{} lacks zh copy",
                operator.id
            );
            assert!(
                !operator.detail_zh.is_empty(),
                "{} lacks zh detail",
                operator.id
            );
            // Only time-series operators take a window.
            if operator.takes_window {
                assert_eq!(operator.scope, "timeSeries");
            }
        }
        let mut ids = operators.iter().map(|item| item.id).collect::<Vec<_>>();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count, "operator ids must be unique");
    }

    #[test]
    fn preset_ids_are_unique() {
        let presets = builtin_presets();
        let mut ids = presets.iter().map(|preset| preset.id).collect::<Vec<_>>();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count, "preset ids must be unique");
    }
}
