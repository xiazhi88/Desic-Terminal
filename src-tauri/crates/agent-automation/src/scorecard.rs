//! 交易员 Profile 的成绩单：把决策日志（含影子结算与真实结果）按「形态 × 日线阶段 × 方向」汇总。
//!
//! 学习在汇总层面发生，不看单笔：小样本的平均 R 会向 0 收缩（乘以 n/(n+10)），
//! 只有样本足够且收缩后仍明显为负的分组才标「建议暂停」（只提醒，由用户决定）。

use serde::{Deserialize, Serialize};

/// 收缩强度：平均 R × n/(n + SHRINK_K)。
pub const SHRINK_K: f64 = 10.0;
/// 「建议暂停」：样本至少这么多……
pub const FLAG_MIN_SAMPLES: usize = 15;
/// ……且收缩后的平均 R 不高于这个值。
pub const FLAG_MAX_SHRUNK_R: f64 = -0.25;

/// 一条已记录的决策（及其结果）。`r` 由调用方选定：真实成交有结果就用真实 R，否则用影子 R。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionOutcome {
    pub id: String,
    pub created_at: i64,
    pub inst_id: String,
    pub setup_id: Option<String>,
    pub regime_daily: Option<String>,
    pub side: Option<String>,
    pub action: String,
    pub probability: Option<f64>,
    pub executed: bool,
    pub shadow_r: Option<f64>,
    pub real_r: Option<f64>,
    pub against_direction: bool,
    pub regime_mismatch: bool,
    pub handbook_version: Option<i64>,
}

impl DecisionOutcome {
    /// 用来统计的 R：真实成交优先，其次影子结果。
    pub fn effective_r(&self) -> Option<f64> {
        self.real_r.or(self.shadow_r).filter(|value| value.is_finite())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupStat {
    pub setup_id: String,
    pub regime: String,
    pub side: String,
    pub n: usize,
    pub wins: usize,
    pub avg_r: f64,
    pub shrunk_avg_r: f64,
    pub total_r: f64,
    /// 其中真实成交的条数与平均 R。
    pub real_n: usize,
    pub real_avg_r: Option<f64>,
    pub flagged: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationBucket {
    pub lo: f64,
    pub hi: f64,
    pub n: usize,
    pub predicted: f64,
    pub realized: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitStats {
    /// 没执行、但有可结算候选的决策数。
    pub n: usize,
    /// 错过的盈利（影子结果为正的合计 R）。
    pub missed_r: f64,
    /// 躲过的亏损（影子结果为负的合计 R，取绝对值）。
    pub avoided_r: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComplianceStats {
    pub against_n: usize,
    pub against_avg_r: Option<f64>,
    pub aligned_n: usize,
    pub aligned_avg_r: Option<f64>,
    pub regime_mismatch_n: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionStat {
    pub version: i64,
    pub n: usize,
    pub avg_r: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scorecard {
    pub decisions: usize,
    pub resolved: usize,
    pub executed: usize,
    pub groups: Vec<GroupStat>,
    pub calibration: Vec<CalibrationBucket>,
    pub waits: WaitStats,
    pub compliance: ComplianceStats,
    pub versions: Vec<VersionStat>,
}

fn mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

pub fn shrink(avg_r: f64, n: usize) -> f64 {
    avg_r * n as f64 / (n as f64 + SHRINK_K)
}

pub fn build_scorecard(rows: &[DecisionOutcome]) -> Scorecard {
    let resolved = rows.iter().filter(|row| row.effective_r().is_some()).collect::<Vec<_>>();
    // 分组：只统计有形态、有方向、有结果的决策。
    let mut keys: Vec<(String, String, String)> = Vec::new();
    for row in &resolved {
        if let (Some(setup), Some(side)) = (row.setup_id.as_deref(), row.side.as_deref()) {
            if setup == "none" || !matches!(side, "long" | "short") {
                continue;
            }
            let key = (setup.to_string(), row.regime_daily.clone().unwrap_or_else(|| "unknown".to_string()), side.to_string());
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
    }
    let mut groups = keys
        .into_iter()
        .map(|(setup_id, regime, side)| {
            let members = resolved
                .iter()
                .filter(|row| {
                    row.setup_id.as_deref() == Some(setup_id.as_str())
                        && row.regime_daily.as_deref().unwrap_or("unknown") == regime
                        && row.side.as_deref() == Some(side.as_str())
                })
                .collect::<Vec<_>>();
            let values = members.iter().filter_map(|row| row.effective_r()).collect::<Vec<_>>();
            let real = members.iter().filter_map(|row| row.real_r).collect::<Vec<_>>();
            let n = values.len();
            let avg_r = mean(&values).unwrap_or(0.0);
            let shrunk_avg_r = shrink(avg_r, n);
            GroupStat {
                setup_id,
                regime,
                side,
                n,
                wins: values.iter().filter(|value| **value > 0.0).count(),
                avg_r,
                shrunk_avg_r,
                total_r: values.iter().sum(),
                real_n: real.len(),
                real_avg_r: mean(&real),
                flagged: n >= FLAG_MIN_SAMPLES && shrunk_avg_r <= FLAG_MAX_SHRUNK_R,
            }
        })
        .collect::<Vec<_>>();
    groups.sort_by(|left, right| right.n.cmp(&left.n).then_with(|| left.setup_id.cmp(&right.setup_id)));

    // 信心校准：AI 给的「先到目标」概率分 5 档，对比实际胜率。
    let edges = [0.0, 0.3, 0.45, 0.6, 0.75, 1.0001];
    let calibration = edges
        .windows(2)
        .filter_map(|edge| {
            let members = resolved
                .iter()
                .filter(|row| row.probability.is_some_and(|value| value >= edge[0] && value < edge[1]))
                .collect::<Vec<_>>();
            if members.is_empty() {
                return None;
            }
            let predicted = members.iter().filter_map(|row| row.probability).sum::<f64>() / members.len() as f64;
            let realized = members.iter().filter(|row| row.effective_r().unwrap_or(0.0) > 0.0).count() as f64 / members.len() as f64;
            Some(CalibrationBucket { lo: edge[0], hi: edge[1].min(1.0), n: members.len(), predicted, realized })
        })
        .collect::<Vec<_>>();

    // 「不做」的打分：没执行、但有可结算候选（影子结果）的决策。
    let mut waits = WaitStats::default();
    for row in rows.iter().filter(|row| !row.executed) {
        if let Some(r) = row.shadow_r.filter(|value| value.is_finite()) {
            waits.n += 1;
            if r > 0.0 {
                waits.missed_r += r;
            } else {
                waits.avoided_r += -r;
            }
        }
    }

    // 方向纪律（软规则）的执行情况。
    let against = resolved.iter().filter(|row| row.against_direction).filter_map(|row| row.effective_r()).collect::<Vec<_>>();
    let aligned = resolved.iter().filter(|row| !row.against_direction).filter_map(|row| row.effective_r()).collect::<Vec<_>>();
    let compliance = ComplianceStats {
        against_n: against.len(),
        against_avg_r: mean(&against),
        aligned_n: aligned.len(),
        aligned_avg_r: mean(&aligned),
        regime_mismatch_n: rows.iter().filter(|row| row.regime_mismatch).count(),
    };

    let mut version_ids = resolved.iter().filter_map(|row| row.handbook_version).collect::<Vec<_>>();
    version_ids.sort_unstable();
    version_ids.dedup();
    let versions = version_ids
        .into_iter()
        .map(|version| {
            let values = resolved.iter().filter(|row| row.handbook_version == Some(version)).filter_map(|row| row.effective_r()).collect::<Vec<_>>();
            VersionStat { version, n: values.len(), avg_r: mean(&values).unwrap_or(0.0) }
        })
        .collect();

    Scorecard {
        decisions: rows.len(),
        resolved: resolved.len(),
        executed: rows.iter().filter(|row| row.executed).count(),
        groups,
        calibration,
        waits,
        compliance,
        versions,
    }
}

fn regime_label(value: &str, chinese: bool) -> &str {
    match (value, chinese) {
        ("up", true) => "日线上升",
        ("down", true) => "日线下降",
        ("mixed", true) => "日线不明",
        ("up", false) => "daily up",
        ("down", false) => "daily down",
        ("mixed", false) => "daily mixed",
        (_, true) => "阶段不明",
        (_, false) => "regime n/a",
    }
}

fn side_label(value: &str, chinese: bool) -> &str {
    match (value, chinese) {
        ("long", true) => "做多",
        ("short", true) => "做空",
        (other, _) => other,
    }
}

/// 写进简报的「你的成绩单」（不超过约 700 字符）。`current_regime` 用来挑与当前行情相关的分组；
/// `pooled` 为 true 表示样本不足、用的是所有交易员 Profile 的合计。
pub fn render_scorecard_brief(card: &Scorecard, recent: &[DecisionOutcome], current_regime: Option<&str>, pooled: bool, chinese: bool) -> String {
    let mut lines: Vec<String> = Vec::new();
    if card.resolved == 0 {
        lines.push(if chinese {
            "还没有已结算的决策（每条决策都会按之后的 K 线自动结算，包括没执行的候选）。".to_string()
        } else {
            "No settled decisions yet (every decision, including untaken candidates, is settled against later candles).".to_string()
        });
        return lines.join("\n");
    }
    lines.push(if chinese {
        format!(
            "{}已结算 {} 条决策（真实成交 {} 条）。平均 R 已向 0 收缩（×n/(n+10)），样本少时别当真。",
            if pooled { "（样本不足，以下为所有交易员 Profile 的合计）" } else { "" },
            card.resolved,
            card.executed
        )
    } else {
        format!(
            "{}{} settled decisions ({} real fills). Average R is shrunk toward 0 (×n/(n+10)); small samples mean little.",
            if pooled { "(Small sample: totals across all trader Profiles.) " } else { "" },
            card.resolved,
            card.executed
        )
    });
    let mut relevant = card
        .groups
        .iter()
        .filter(|group| current_regime.map_or(true, |regime| group.regime == regime))
        .take(4)
        .collect::<Vec<_>>();
    for flagged in card.groups.iter().filter(|group| group.flagged) {
        if !relevant.iter().any(|group| std::ptr::eq(*group, flagged)) {
            relevant.push(flagged);
        }
    }
    for group in relevant {
        lines.push(format!(
            "- {} · {} · {}：n={}，胜 {}，平均 {:+.2}R（收缩后 {:+.2}R）{}",
            group.setup_id,
            regime_label(&group.regime, chinese),
            side_label(&group.side, chinese),
            group.n,
            group.wins,
            group.avg_r,
            group.shrunk_avg_r,
            if group.flagged { if chinese { "【建议暂停】" } else { " [suggest pause]" } } else { "" }
        ));
    }
    if let Some(bucket) = card.calibration.iter().filter(|bucket| bucket.n >= 5).max_by_key(|bucket| bucket.n) {
        lines.push(if chinese {
            format!("- 信心校准：你给出 {:.0}% 左右把握的决策，实际兑现 {:.0}%（n={}）", bucket.predicted * 100.0, bucket.realized * 100.0, bucket.n)
        } else {
            format!("- Calibration: decisions you rated ~{:.0}% came true {:.0}% of the time (n={})", bucket.predicted * 100.0, bucket.realized * 100.0, bucket.n)
        });
    }
    let compliance = &card.compliance;
    if compliance.against_n > 0 {
        lines.push(if chinese {
            format!(
                "- 违反方向纪律的决策 {} 条，平均 {:+.2}R；顺纪律的 {} 条，平均 {:+.2}R",
                compliance.against_n,
                compliance.against_avg_r.unwrap_or(0.0),
                compliance.aligned_n,
                compliance.aligned_avg_r.unwrap_or(0.0)
            )
        } else {
            format!(
                "- Against the direction policy: {} decisions, avg {:+.2}R; aligned: {}, avg {:+.2}R",
                compliance.against_n,
                compliance.against_avg_r.unwrap_or(0.0),
                compliance.aligned_n,
                compliance.aligned_avg_r.unwrap_or(0.0)
            )
        });
    }
    if card.waits.n > 0 {
        lines.push(if chinese {
            format!("- 没执行的候选 {} 条：错过 {:+.1}R，躲过 {:.1}R", card.waits.n, card.waits.missed_r, card.waits.avoided_r)
        } else {
            format!("- Untaken candidates {}: missed {:+.1}R, avoided {:.1}R", card.waits.n, card.waits.missed_r, card.waits.avoided_r)
        });
    }
    let recent_r = recent
        .iter()
        .filter_map(|row| row.effective_r().map(|r| format!("{r:+.1}")))
        .take(5)
        .collect::<Vec<_>>();
    if !recent_r.is_empty() {
        lines.push(format!("- {}{}", if chinese { "最近已结算：" } else { "Recent settled: " }, recent_r.join(" / ")));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: usize, setup: &str, regime: &str, side: &str, r: Option<f64>, probability: Option<f64>) -> DecisionOutcome {
        DecisionOutcome {
            id: format!("d{id}"),
            created_at: id as i64,
            inst_id: "BTC-USDT-SWAP".into(),
            setup_id: Some(setup.into()),
            regime_daily: Some(regime.into()),
            side: Some(side.into()),
            action: "limit_order".into(),
            probability,
            executed: false,
            shadow_r: r,
            real_r: None,
            against_direction: regime == "up" && side == "short",
            regime_mismatch: false,
            handbook_version: Some(1),
        }
    }

    #[test]
    fn groups_shrink_and_flag_persistent_losers_only_with_enough_samples() {
        let mut rows = (0..16).map(|index| row(index, "range_edge", "up", "short", Some(-1.0), Some(0.6))).collect::<Vec<_>>();
        rows.extend((16..20).map(|index| row(index, "trend_pullback", "up", "long", Some(2.0), Some(0.5))));
        let card = build_scorecard(&rows);
        let losers = card.groups.iter().find(|group| group.setup_id == "range_edge").unwrap();
        assert_eq!((losers.n, losers.wins), (16, 0));
        assert!((losers.shrunk_avg_r - (-16.0 / 26.0)).abs() < 1e-9);
        assert!(losers.flagged);
        let winners = card.groups.iter().find(|group| group.setup_id == "trend_pullback").unwrap();
        assert!(!winners.flagged && (winners.shrunk_avg_r - 2.0 * 4.0 / 14.0).abs() < 1e-9);
        // 只有 5 条亏损时不提醒（样本不够）。
        let few = build_scorecard(&rows[..5]);
        assert!(!few.groups[0].flagged);
    }

    #[test]
    fn real_results_override_shadow_and_waits_are_scored() {
        let mut taken = row(1, "trend_pullback", "up", "long", Some(-1.0), Some(0.6));
        taken.executed = true;
        taken.real_r = Some(1.5);
        let skipped_winner = row(2, "trend_pullback", "up", "long", Some(2.0), Some(0.6));
        let skipped_loser = row(3, "trend_pullback", "up", "long", Some(-1.0), Some(0.6));
        let card = build_scorecard(&[taken, skipped_winner, skipped_loser]);
        assert_eq!(card.executed, 1);
        assert_eq!(card.groups[0].real_n, 1);
        assert_eq!(card.groups[0].real_avg_r, Some(1.5));
        assert_eq!(card.waits.n, 2);
        assert!((card.waits.missed_r - 2.0).abs() < 1e-9 && (card.waits.avoided_r - 1.0).abs() < 1e-9);
    }

    #[test]
    fn calibration_and_compliance_are_reported() {
        let rows = vec![
            row(1, "range_edge", "up", "short", Some(-1.0), Some(0.7)),
            row(2, "range_edge", "up", "short", Some(-1.0), Some(0.7)),
            row(3, "trend_pullback", "up", "long", Some(1.0), Some(0.7)),
            row(4, "trend_pullback", "up", "long", None, Some(0.7)),
        ];
        let card = build_scorecard(&rows);
        let bucket = card.calibration.iter().find(|bucket| bucket.lo == 0.6).unwrap();
        assert_eq!(bucket.n, 3, "未结算的不进校准");
        assert!((bucket.realized - 1.0 / 3.0).abs() < 1e-9);
        assert_eq!(card.compliance.against_n, 2);
        assert_eq!(card.compliance.against_avg_r, Some(-1.0));
        assert_eq!(card.resolved, 3);
    }

    #[test]
    fn brief_mentions_flags_calibration_and_pooling() {
        let rows = (0..16).map(|index| row(index, "range_edge", "mixed", "short", Some(-1.0), Some(0.7))).collect::<Vec<_>>();
        let card = build_scorecard(&rows);
        let text = render_scorecard_brief(&card, &rows, Some("up"), true, true);
        assert!(text.contains("所有交易员 Profile 的合计"));
        assert!(text.contains("range_edge · 日线不明 · 做空"), "{text}");
        assert!(text.contains("【建议暂停】"));
        assert!(text.contains("信心校准"));
        assert!(text.chars().count() < 700, "{}", text.chars().count());
        let empty = render_scorecard_brief(&build_scorecard(&[]), &[], None, false, true);
        assert!(empty.contains("还没有已结算的决策"));
    }
}
