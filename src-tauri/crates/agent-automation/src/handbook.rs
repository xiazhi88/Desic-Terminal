//! 交易员 Profile 的「交易手册」：有版本号的结构化文档，每条规则都可单独引用。
//! 交易员只能用手册里的形态开仓（候选必须带 `setupId`）；手册只通过「汇总数据提出 → 回放验证 →
//! 用户批准」演进。方向纪律是软规则：写进手册、由成绩单统计执行情况，代码不拦截。
//! 用户手动暂停的形态由代码拒绝开仓（这是用户的明确操作）。

use crate::regime::DailyRegime;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Handbook {
    pub direction_policy: String,
    pub setups: Vec<HandbookSetup>,
    pub no_trade_rules: Vec<HandbookRule>,
    pub management_rules: Vec<HandbookRule>,
    #[serde(default)]
    pub paused: Vec<PausedSetup>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandbookSetup {
    pub id: String,
    pub name: String,
    /// 适用的日线阶段：`up` / `down` / `mixed`。
    pub regimes: Vec<String>,
    /// `with_trend`：日线上升只做多、下降只做空，日线不明时两个方向都可；`both`：两个方向都可。
    pub direction: String,
    pub entry: String,
    pub stop: String,
    pub target: String,
    pub invalidation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_net_rr: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_atr_min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_atr_max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandbookRule {
    pub id: String,
    pub text: String,
}

/// 用户手动暂停的形态；`regime` / `side` 为空表示所有阶段 / 所有方向。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PausedSetup {
    pub setup_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub regime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,
    pub reason: String,
    pub paused_at: i64,
}

fn rule(id: &str, text: &str) -> HandbookRule {
    HandbookRule { id: id.to_string(), text: text.to_string() }
}

/// 内置 v1：迁移时写入，作为第一个发布版本。
pub fn default_handbook() -> Handbook {
    let setup = |id: &str, name: &str, regimes: &[&str], direction: &str, entry: &str, stop: &str, target: &str, invalidation: &str| HandbookSetup {
        id: id.to_string(),
        name: name.to_string(),
        regimes: regimes.iter().map(|value| value.to_string()).collect(),
        direction: direction.to_string(),
        entry: entry.to_string(),
        stop: stop.to_string(),
        target: target.to_string(),
        invalidation: invalidation.to_string(),
        min_net_rr: None,
        stop_atr_min: Some(1.0),
        stop_atr_max: None,
        size_note: None,
    };
    let mut flush = setup(
        "flush_reversal",
        "挤压反转",
        &["up", "down", "mixed"],
        "with_trend",
        "爆仓笔数激增、资金费率极端、持仓量骤降之后，价格收回挤压前的结构位再入场；不追第一根反弹。",
        "放在挤压极值之外。",
        "回到挤压发起前的价位。",
        "价格再次跌破（或升破）挤压极值。",
    );
    flush.size_note = Some("仓位减半；简报里爆仓数据不可用时不得使用这个形态。".to_string());
    Handbook {
        direction_policy: "日线上升只做多、日线下降只做空；日线不明时只用 breakout_retest 或 range_edge。".to_string(),
        setups: vec![
            setup(
                "trend_pullback",
                "顺势回踩",
                &["up", "down"],
                "with_trend",
                "与日线趋势同向；价格回撤到 1h / 4h 结构位或 EMA20 附近，并出现拒绝信号（长影线、收回结构位）后入场，以限价单为主。",
                "放在结构位之外，至少 1×ATR(1h)。",
                "前高 / 前低，且至少 2R。",
                "收盘有效跌破（做空则升破）结构位。",
            ),
            setup(
                "breakout_retest",
                "突破回踩",
                &["up", "down", "mixed"],
                "with_trend",
                "4h 区间被收盘突破后，回踩区间边缘不破再入场；只做突破方向。",
                "回到区间内 1×ATR(1h)。",
                "按区间高度向突破方向投射。",
                "收盘重新回到区间内部。",
            ),
            setup(
                "range_edge",
                "区间边缘",
                &["mixed"],
                "both",
                "只在日线不明且 4h 为区间时使用：区间上沿出现拒绝做空、下沿出现拒绝做多；不在区间中部开仓。",
                "放在区间外，至少 1×ATR(1h)。",
                "先看区间中轴，再看对侧边缘。",
                "收盘突破区间边缘。",
            ),
            flush,
        ],
        no_trade_rules: vec![
            rule("no_data", "简报里的结构、ATR 或行情阶段有任何一项不可用。"),
            rule("event_window", "重大事件前后 30 分钟。"),
            rule("loss_budget", "今日剩余亏损额度小于单笔风险预算。"),
            rule("mid_range", "价格处于所在区间的中部（40%–60%）。"),
            rule("noise_stop", "止损距离小于 0.8×ATR(1h)。"),
            rule("duplicate", "同一品种已有同方向的持仓或挂单（管理已有仓位除外）。"),
        ],
        management_rules: vec![
            rule("breakeven", "浮盈达到 1R 后，可以把止损移到保本（覆盖手续费）。"),
            rule("invalidation_exit", "失效条件触发就离场，不等止损。"),
            rule("no_averaging_down", "不在亏损的仓位上加仓。"),
        ],
        paused: Vec::new(),
    }
}

pub fn find_setup<'a>(handbook: &'a Handbook, id: &str) -> Option<&'a HandbookSetup> {
    handbook.setups.iter().find(|setup| setup.id == id)
}

/// 命中的用户暂停条目（形态 + 可选的阶段 / 方向）。
pub fn paused_entry<'a>(handbook: &'a Handbook, setup_id: &str, regime: Option<&str>, side: &str) -> Option<&'a PausedSetup> {
    handbook.paused.iter().find(|entry| {
        entry.setup_id == setup_id
            && entry.regime.as_deref().map_or(true, |paused| Some(paused) == regime)
            && entry.side.as_deref().map_or(true, |paused| paused == side)
    })
}

/// 软纪律的执行情况：(是否违反方向纪律, 形态是否不适用于当前日线阶段)。日线阶段不可用时都记为 false。
pub fn direction_policy_flags(setup: Option<&HandbookSetup>, regime: Option<DailyRegime>, long: bool) -> (bool, bool) {
    let Some(regime) = regime else {
        return (false, false);
    };
    let against = matches!((regime, long), (DailyRegime::Up, false) | (DailyRegime::Down, true));
    let mismatch = setup.is_some_and(|setup| !setup.regimes.iter().any(|value| value == regime.as_str()));
    (against, mismatch)
}

/// 手册自洽性：形态 id 唯一且非空、阶段和方向取值合法。
pub fn validate_handbook(handbook: &Handbook) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for setup in &handbook.setups {
        if setup.id.trim().is_empty() || !seen.insert(setup.id.as_str()) {
            return Err(format!("形态 id 为空或重复：{}", setup.id));
        }
        if setup.regimes.is_empty() || setup.regimes.iter().any(|value| DailyRegime::parse(value).is_none()) {
            return Err(format!("形态 {} 的适用阶段无效", setup.id));
        }
        if !matches!(setup.direction.as_str(), "with_trend" | "both") {
            return Err(format!("形态 {} 的方向规则无效", setup.id));
        }
    }
    Ok(())
}

fn regime_label(value: &str) -> &str {
    match value {
        "up" => "上升",
        "down" => "下降",
        "mixed" => "不明",
        other => other,
    }
}

/// 渲染成提示词里的手册正文（约 2–3 千字符）。
pub fn render_handbook(handbook: &Handbook, version: i64) -> String {
    let mut out = format!("【交易手册 v{version}】只能用下面的形态开仓，开仓候选的 setupId 必须是其中一个 id；没有合适的形态就不开仓。\n");
    out.push_str(&format!("方向纪律：{}\n", handbook.direction_policy));
    out.push_str("可用形态：\n");
    for setup in &handbook.setups {
        let regimes = setup.regimes.iter().map(|value| regime_label(value)).collect::<Vec<_>>().join(" / ");
        let direction = if setup.direction == "both" { "两个方向" } else { "顺日线趋势" };
        out.push_str(&format!("- {}（{}）｜适用日线：{}｜方向：{}\n", setup.id, setup.name, regimes, direction));
        out.push_str(&format!("  入场：{}\n  止损：{}\n  目标：{}\n  失效：{}\n", setup.entry, setup.stop, setup.target, setup.invalidation));
        let mut limits = Vec::new();
        if let Some(value) = setup.min_net_rr {
            limits.push(format!("净盈亏比至少 {value}"));
        }
        if let Some(value) = setup.stop_atr_min {
            limits.push(format!("止损至少 {value}×ATR(1h)"));
        }
        if let Some(value) = setup.stop_atr_max {
            limits.push(format!("止损不超过 {value}×ATR(1h)"));
        }
        if let Some(note) = setup.size_note.as_deref() {
            limits.push(note.to_string());
        }
        if !limits.is_empty() {
            out.push_str(&format!("  限制：{}\n", limits.join("；")));
        }
    }
    out.push_str("不做清单（命中任何一条就不开仓）：\n");
    for item in &handbook.no_trade_rules {
        out.push_str(&format!("- {}\n", item.text));
    }
    out.push_str("持仓管理：\n");
    for item in &handbook.management_rules {
        out.push_str(&format!("- {}\n", item.text));
    }
    if !handbook.paused.is_empty() {
        out.push_str("已暂停（用户手动，暂停期间不得用于开仓）：\n");
        for entry in &handbook.paused {
            let scope = [entry.regime.as_deref().map(regime_label), entry.side.as_deref()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" · ");
            let scope = if scope.is_empty() { "全部".to_string() } else { scope };
            out.push_str(&format!("- {}（{}）：{}\n", entry.setup_id, scope, entry.reason));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_handbook_is_valid_and_renders_every_setup() {
        let handbook = default_handbook();
        validate_handbook(&handbook).expect("v1 is valid");
        let text = render_handbook(&handbook, 1);
        for id in ["trend_pullback", "breakout_retest", "range_edge", "flush_reversal"] {
            assert!(text.contains(id), "{id} missing");
        }
        assert!(text.contains("方向纪律：日线上升只做多"));
        assert!(text.contains("止损距离小于 0.8×ATR(1h)"));
        assert!(text.chars().count() < 3_000, "{}", text.chars().count());
        // 序列化往返（存库）不丢字段。
        let json = serde_json::to_string(&handbook).unwrap();
        assert_eq!(serde_json::from_str::<Handbook>(&json).unwrap(), handbook);
    }

    #[test]
    fn direction_flags_follow_the_daily_regime() {
        let handbook = default_handbook();
        let pullback = find_setup(&handbook, "trend_pullback");
        let range = find_setup(&handbook, "range_edge");
        assert_eq!(direction_policy_flags(pullback, Some(DailyRegime::Up), true), (false, false));
        assert_eq!(direction_policy_flags(pullback, Some(DailyRegime::Up), false), (true, false));
        assert_eq!(direction_policy_flags(pullback, Some(DailyRegime::Mixed), true), (false, true));
        assert_eq!(direction_policy_flags(range, Some(DailyRegime::Mixed), false), (false, false));
        assert_eq!(direction_policy_flags(range, None, false), (false, false));
    }

    #[test]
    fn pauses_match_setup_and_optional_scope() {
        let mut handbook = default_handbook();
        handbook.paused.push(PausedSetup {
            setup_id: "range_edge".into(),
            regime: Some("mixed".into()),
            side: Some("short".into()),
            reason: "n=18，平均 −0.4R".into(),
            paused_at: 1,
        });
        assert!(paused_entry(&handbook, "range_edge", Some("mixed"), "short").is_some());
        assert!(paused_entry(&handbook, "range_edge", Some("mixed"), "long").is_none());
        assert!(paused_entry(&handbook, "trend_pullback", Some("up"), "long").is_none());
        assert!(render_handbook(&handbook, 2).contains("range_edge（不明 · short）"));
    }

    #[test]
    fn invalid_handbooks_are_rejected() {
        let mut handbook = default_handbook();
        handbook.setups[1].id = handbook.setups[0].id.clone();
        assert!(validate_handbook(&handbook).is_err());
        let mut handbook = default_handbook();
        handbook.setups[0].regimes = vec!["sideways".into()];
        assert!(validate_handbook(&handbook).is_err());
    }
}
