//! 用户对交易员决策的纠正：用户在成绩单或运行详情里给某条决策写的意见（类别 + 一句话）。
//! 最近的纠正写进简报，让 AI 下一轮参考；同一形态攒够几条后由主程序生成手册修改建议。这里是纯逻辑。

pub const CORRECTION_CATEGORIES: [&str; 6] = ["wrong_direction", "bad_location", "wrong_regime", "bad_levels", "missed_trade", "other"];
pub const MAX_CORRECTION_TEXT_CHARS: usize = 300;
/// 简报里每条纠正的意见最多这么多字。
const BRIEF_TEXT_CHARS: usize = 120;

pub fn valid_correction_category(value: &str) -> bool {
    CORRECTION_CATEGORIES.contains(&value)
}

pub fn correction_category_label(value: &str, chinese: bool) -> &'static str {
    match (value, chinese) {
        ("wrong_direction", true) => "方向错",
        ("bad_location", true) => "位置不好",
        ("wrong_regime", true) => "行情不对",
        ("bad_levels", true) => "止损止盈不对",
        ("missed_trade", true) => "该做没做",
        (_, true) => "其他",
        ("wrong_direction", false) => "wrong direction",
        ("bad_location", false) => "poor location",
        ("wrong_regime", false) => "wrong regime",
        ("bad_levels", false) => "stop / target off",
        ("missed_trade", false) => "should have traded",
        (_, false) => "other",
    }
}

/// 简报里的一条纠正（时间已格式化）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CorrectionNote {
    pub at_label: String,
    pub inst_id: String,
    pub setup_id: Option<String>,
    pub side: Option<String>,
    pub action: String,
    pub category: String,
    pub text: String,
    pub shadow_r: Option<f64>,
    pub real_r: Option<f64>,
    /// 是不是这个 Profile 自己的决策（不是的标「其他交易员 Profile」）。
    pub own_profile: bool,
}

fn side_label(side: Option<&str>, chinese: bool) -> &'static str {
    match (side, chinese) {
        (Some("long"), true) => "做多",
        (Some("short"), true) => "做空",
        (Some("long"), false) => "long",
        (Some("short"), false) => "short",
        _ => "",
    }
}

/// 写进简报的「用户对你之前决策的纠正」。每条附上当时的结果（用户也可能判断错，交给 AI 结合结果看）。
pub fn render_corrections(notes: &[CorrectionNote], chinese: bool) -> Option<String> {
    if notes.is_empty() {
        return None;
    }
    let lines = notes
        .iter()
        .map(|note| {
            let text = note.text.trim().chars().take(BRIEF_TEXT_CHARS).collect::<String>();
            let result = match (note.real_r, note.shadow_r, chinese) {
                (Some(r), _, true) => format!("真实结果 {r:+.2}R"),
                (Some(r), _, false) => format!("real result {r:+.2}R"),
                (None, Some(r), true) => format!("影子结果 {r:+.2}R"),
                (None, Some(r), false) => format!("shadow result {r:+.2}R"),
                (None, None, true) => "结果未出".to_string(),
                (None, None, false) => "no result yet".to_string(),
            };
            let decision = [
                note.inst_id.as_str(),
                note.setup_id.as_deref().unwrap_or("none"),
                side_label(note.side.as_deref(), chinese),
                note.action.as_str(),
            ]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
            let other = match (note.own_profile, chinese) {
                (true, _) => "",
                (false, true) => "（其他交易员 Profile）",
                (false, false) => " (another trader Profile)",
            };
            let body = if text.is_empty() { String::new() } else if chinese { format!("：{text}") } else { format!(": {text}") };
            if chinese {
                format!("- {} {decision}{other}｜{}{body}（{result}）", note.at_label, correction_category_label(&note.category, true))
            } else {
                format!("- {} {decision}{other} | {}{body} ({result})", note.at_label, correction_category_label(&note.category, false))
            }
        })
        .collect::<Vec<_>>();
    let intro = if chinese {
        "用户对你之前决策的纠正（最近 14 天）。用户也可能判断错，结合当时的结果看；同样的情形再出现时把意见考虑进去。"
    } else {
        "The user's corrections of your earlier decisions (last 14 days). The user can be wrong too, so weigh them against the results; take them into account when a similar situation comes up."
    };
    Some(format!("{intro}\n{}", lines.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corrections_render_with_results_and_owner() {
        let notes = vec![
            CorrectionNote {
                at_label: "10-04 21:30".into(),
                inst_id: "BTC-USDT-SWAP".into(),
                setup_id: Some("range_edge".into()),
                side: Some("short".into()),
                action: "limit_order".into(),
                category: "wrong_direction".into(),
                text: "日线上升别逆势做空".into(),
                shadow_r: Some(-1.05),
                real_r: None,
                own_profile: true,
            },
            CorrectionNote {
                at_label: "10-03 09:00".into(),
                inst_id: "ETH-USDT-SWAP".into(),
                action: "no_trade".into(),
                category: "missed_trade".into(),
                own_profile: false,
                ..Default::default()
            },
        ];
        let text = render_corrections(&notes, true).unwrap();
        assert!(text.contains("- 10-04 21:30 BTC-USDT-SWAP range_edge 做空 limit_order｜方向错：日线上升别逆势做空（影子结果 -1.05R）"), "{text}");
        assert!(text.contains("ETH-USDT-SWAP none no_trade（其他交易员 Profile）｜该做没做（结果未出）"), "{text}");
        assert!(render_corrections(&notes, false).unwrap().contains("| wrong direction: "));
        assert!(render_corrections(&[], true).is_none());
        assert!(valid_correction_category("bad_levels") && !valid_correction_category("lucky"));
    }
}
