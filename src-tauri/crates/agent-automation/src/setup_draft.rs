//! 交易手册形态的 AI 起草：用户用大白话描述打法 → 一个手册形态（新形态一律「观察中」）；
//! 以及按用户的纠正改写已有形态（手册修改建议）。只出草稿，由用户看过、确认后才写进手册。
//! 这里是纯逻辑：提示词、示例与宽松解析（数值夹到合法范围、缺的字段如实提示）。

use crate::agent_draft::extract_json_object;
use crate::handbook::{
    sanitize_handbook_text, valid_identifier, HandbookSetup, MAX_NAME_CHARS, MAX_RULE_CHARS, MAX_SETUP_TEXT_CHARS,
    SETUP_STATUS_OBSERVING,
};
use serde::Serialize;
use serde_json::Value;

pub const SETUP_DRAFT_SYSTEM_PROMPT: &str = "你是交易手册编辑助手。把用户用大白话描述的交易打法整理成交易手册里的一个「形态」，只输出一个 JSON 对象，不要输出其它文字。
规则：
1. 只整理用户说过的内容，不编造用户没给的数字（价位、倍数、比例、时长）。用户没说清楚的地方写进 notes，请用户补充；可选的限制字段（minNetRr、stopAtrMin、stopAtrMax、sizeNote）用户没给就不要写。
2. entry / stop / target / invalidation 各写一句能执行的话，尽量引用简报里有的数据（结构位、ATR(1h)、EMA、资金费率、持仓量、爆仓等）。
3. regimes 只能从 up / down / mixed 里选（日线上升 / 下降 / 不明）；用户没说时按打法本身判断，并在 notes 里说明你的判断。direction 只能是 with_trend（顺日线趋势）或 both（两个方向）。
4. id 用小写字母、数字和下划线（不超过 40 个字符），能看出是什么打法。
5. 不写任何放宽风控、仓位上限或杠杆的话；这些由系统的硬风控决定。
输出字段：name, id, regimes, direction, entry, stop, target, invalidation, minNetRr（可选）, stopAtrMin（可选）, stopAtrMax（可选）, sizeNote（可选）, notes（字符串数组，需要用户确认或补充的地方）。";

/// 用户提示模板：侧车把 `{{description}}` 换成描述（含手册里已有的形态 id），`{{name_line}}` 换成名称要求。
pub const SETUP_DRAFT_USER_PROMPT: &str = "把下面这段打法整理成一个交易手册形态。
{{name_line}}
用户的描述：
{{description}}";

const SETUP_DRAFT_EXAMPLE_USER: &str = "把下面这段打法整理成一个交易手册形态。
用户未指定名称，请自行命名（1-40 字）。
用户的描述：
资金费率连续三次超过 0.05% 但价格不再创新高的时候，等 15 分钟 K 线跌破前低再做空，止损放最近高点上面，目标看回到费率转正之前的价格，价格放量创新高就算失败。仓位只用平时的一半。
（手册里已有的形态 id：trend_pullback, breakout_retest。新形态的 id 不要和它们重复。）";

const SETUP_DRAFT_EXAMPLE_ASSISTANT: &str = r#"{"name":"资金费率背离","id":"funding_fade","regimes":["up","mixed"],"direction":"both","entry":"资金费率连续 3 期 > 0.05% 且价格不再创新高时，等 15m 收盘跌破前低再做空。","stop":"最近高点之上。","target":"回到费率转正前的价位。","invalidation":"价格放量创新高。","sizeNote":"只用正常仓位的一半","notes":["没有说明适用的日线阶段：按「拥挤后回落」的打法先选了上升和不明，请确认","「放量」没有给出标准，可以补一个成交量倍数"]}"#;

pub fn setup_draft_messages() -> Vec<(&'static str, &'static str)> {
    vec![("user", SETUP_DRAFT_EXAMPLE_USER), ("assistant", SETUP_DRAFT_EXAMPLE_ASSISTANT)]
}

pub const SETUP_REVISION_SYSTEM_PROMPT: &str = "你是交易手册编辑助手。用户对 AI 交易员用某个形态做出的几条决策写了纠正意见。请据此修改这个形态，只输出一个 JSON 对象，不要输出其它文字。
规则：
1. 只根据纠正修改；纠正没涉及的部分保持原样，不要把它改成另一种打法。
2. 用户也可能判断错：每条纠正都附了当时的结果，结果和纠正明显矛盾的不要照搬，在 risks 里说明。
3. 不编造用户没给的数字；需要数字而用户没给的，用保守的描述并在 risks 里说明。
4. 不写任何放宽风控、仓位上限或杠杆的话。
5. benefits 写成「如果纠正是对的，预期会……」这样的假设，不要承诺收益。
输出：{\"setup\": {name, regimes, direction, entry, stop, target, invalidation, minNetRr（可选）, stopAtrMin（可选）, stopAtrMax（可选）, sizeNote（可选）}, \"changes\": \"改了什么（一两句）\", \"benefits\": \"……\", \"risks\": \"……\"}。形态的 id 和状态不变，不用输出。";

pub const SETUP_REVISION_USER_PROMPT: &str = "按用户的纠正修改这个交易手册形态。
{{name_line}}
{{description}}";

const SETUP_REVISION_EXAMPLE_USER: &str = "按用户的纠正修改这个交易手册形态。
保持原名称。
当前形态：
{\"name\":\"区间边缘\",\"regimes\":[\"mixed\"],\"direction\":\"both\",\"entry\":\"区间上沿拒绝做空、下沿拒绝做多。\",\"stop\":\"区间外，至少 1×ATR(1h)。\",\"target\":\"中轴，再看对侧。\",\"invalidation\":\"收盘突破区间边缘。\",\"stopAtrMin\":1}
用户的纠正（最近 30 天）：
- 10-02 BTC-USDT-SWAP 做空 挂限价｜方向错：日线已经转上升了，还在上沿做空（影子结果 -1.05R）
- 10-03 BTC-USDT-SWAP 做空 挂限价｜位置不好：只碰了一下上沿就挂单，没等拒绝（影子结果 -1.00R）
- 10-04 ETH-USDT-SWAP 做多 挂限价｜位置不好：下沿没有拒绝信号就做多（影子结果 +0.40R）";

const SETUP_REVISION_EXAMPLE_ASSISTANT: &str = r#"{"setup":{"name":"区间边缘","regimes":["mixed"],"direction":"both","entry":"日线不明、价格在区间上沿（或下沿）出现 1h 收盘拒绝（长影线回到区间内）后再入场：上沿做空、下沿做多；只碰到边缘不算。","stop":"区间外，至少 1×ATR(1h)。","target":"中轴，再看对侧。","invalidation":"收盘突破区间边缘，或日线阶段变成上升 / 下降。","stopAtrMin":1},"changes":"入场要求先出现 1h 收盘拒绝；日线阶段离开「不明」时视为失效。","benefits":"如果纠正是对的，预期会减少在趋势启动初期逆势挂单、以及刚碰边缘就成交被打止损的情况。","risks":"等收盘拒绝会错过一部分快速反转；10-04 那笔做多的影子结果是正的，「必须等拒绝」可能让这类单子变少。"}"#;

pub fn setup_revision_messages() -> Vec<(&'static str, &'static str)> {
    vec![("user", SETUP_REVISION_EXAMPLE_USER), ("assistant", SETUP_REVISION_EXAMPLE_ASSISTANT)]
}

/// 新形态草稿的解析结果。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupDraft {
    pub setup: HandbookSetup,
    /// 模型提出、需要用户确认或补充的地方。
    pub notes: Vec<String>,
    /// 解析时做过的修正（夹了范围、补了默认值、截断了过长的文字）。
    pub warnings: Vec<String>,
}

/// 按纠正改写已有形态的解析结果（id 与状态保持原样）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupRevisionDraft {
    pub setup: HandbookSetup,
    pub changes: String,
    pub benefits: String,
    pub risks: String,
    pub warnings: Vec<String>,
}

fn text_field(value: &Value, key: &str, max: usize, warnings: &mut Vec<String>) -> String {
    let text = sanitize_handbook_text(value.get(key).and_then(Value::as_str).unwrap_or_default(), true);
    if text.chars().count() > max {
        warnings.push(format!("{key} 超过 {max} 个字，已截断"));
        return text.chars().take(max).collect();
    }
    text
}

fn number_field(value: &Value, key: &str, min: f64, max: f64, warnings: &mut Vec<String>) -> Option<f64> {
    let raw = value.get(key)?;
    let number = raw.as_f64().or_else(|| raw.as_str().and_then(|text| text.trim().parse::<f64>().ok()))?;
    if !number.is_finite() {
        return None;
    }
    let clamped = number.clamp(min, max);
    if (clamped - number).abs() > f64::EPSILON {
        warnings.push(format!("{key} 超出 {min}–{max}，已调整为 {clamped}"));
    }
    Some((clamped * 100.0).round() / 100.0)
}

fn regimes_field(value: &Value, warnings: &mut Vec<String>) -> Vec<String> {
    let mut regimes = Vec::new();
    for item in value.get("regimes").and_then(Value::as_array).into_iter().flatten() {
        let mapped = match item.as_str().map(str::trim).unwrap_or_default() {
            "up" | "上升" | "日线上升" => "up",
            "down" | "下降" | "日线下降" => "down",
            "mixed" | "不明" | "日线不明" | "range" => "mixed",
            _ => continue,
        };
        if !regimes.iter().any(|existing: &String| existing == mapped) {
            regimes.push(mapped.to_string());
        }
    }
    if regimes.is_empty() {
        warnings.push("草稿没有写出有效的适用日线阶段，先按全部阶段，请确认".to_string());
        regimes = vec!["up".into(), "down".into(), "mixed".into()];
    }
    // 固定顺序，便于对比。
    regimes.sort_by_key(|regime| match regime.as_str() {
        "up" => 0,
        "down" => 1,
        _ => 2,
    });
    regimes
}

fn direction_field(value: &Value, warnings: &mut Vec<String>) -> String {
    match value.get("direction").and_then(Value::as_str).map(str::trim).unwrap_or_default() {
        "both" | "两个方向" | "双向" => "both".to_string(),
        "with_trend" | "顺势" | "顺日线趋势" => "with_trend".to_string(),
        _ => {
            warnings.push("草稿没有写出有效的方向规则，先按顺日线趋势，请确认".to_string());
            "with_trend".to_string()
        }
    }
}

/// 形态正文字段（名称、阶段、方向、四句话、可选限制）；id 与状态由调用方决定。
fn setup_body(value: &Value, warnings: &mut Vec<String>) -> HandbookSetup {
    let mut setup = HandbookSetup {
        id: String::new(),
        name: text_field(value, "name", MAX_NAME_CHARS, warnings),
        regimes: regimes_field(value, warnings),
        direction: direction_field(value, warnings),
        entry: text_field(value, "entry", MAX_SETUP_TEXT_CHARS, warnings),
        stop: text_field(value, "stop", MAX_SETUP_TEXT_CHARS, warnings),
        target: text_field(value, "target", MAX_SETUP_TEXT_CHARS, warnings),
        invalidation: text_field(value, "invalidation", MAX_SETUP_TEXT_CHARS, warnings),
        min_net_rr: number_field(value, "minNetRr", 0.5, 10.0, warnings),
        stop_atr_min: number_field(value, "stopAtrMin", 0.1, 10.0, warnings),
        stop_atr_max: number_field(value, "stopAtrMax", 0.1, 10.0, warnings),
        size_note: Some(text_field(value, "sizeNote", MAX_RULE_CHARS, warnings)).filter(|note| !note.is_empty()),
        status: SETUP_STATUS_OBSERVING.to_string(),
    };
    if let (Some(min), Some(max)) = (setup.stop_atr_min, setup.stop_atr_max) {
        if min > max {
            warnings.push("止损 ATR 下限大于上限，已对调".to_string());
            setup.stop_atr_min = Some(max);
            setup.stop_atr_max = Some(min);
        }
    }
    for (label, text) in [("entry", &setup.entry), ("stop", &setup.stop), ("target", &setup.target), ("invalidation", &setup.invalidation)] {
        if text.is_empty() {
            warnings.push(format!("草稿没有写 {label}，需要你补上"));
        }
    }
    setup
}

/// 新形态的 id：用模型给的（合法且没被占用），否则从名称或 `setup_N` 生成。
fn unique_setup_id(proposed: &str, name: &str, existing: &[String]) -> String {
    let taken = |id: &str| existing.iter().any(|item| item == id);
    let proposed = proposed.trim().to_ascii_lowercase();
    if valid_identifier(&proposed) && !taken(&proposed) {
        return proposed;
    }
    let slug = name
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect::<String>()
        .split('_')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("_");
    let base = if valid_identifier(&slug) && slug.starts_with(|ch: char| ch.is_ascii_lowercase()) {
        slug.chars().take(32).collect::<String>()
    } else if valid_identifier(&proposed) {
        proposed.chars().take(32).collect::<String>()
    } else {
        "setup".to_string()
    };
    if !taken(&base) && base != "setup" {
        return base;
    }
    (1..1_000).map(|index| format!("{base}_{index}")).find(|id| !taken(id)).unwrap_or_else(|| format!("{base}_new"))
}

/// 解析新形态草稿。模型输出不是一个 JSON 对象或没有名称时报错，其余问题记进 warnings 让用户确认。
pub fn parse_setup_draft(raw: &str, existing_ids: &[String]) -> Result<SetupDraft, String> {
    let value = extract_json_object(raw).ok_or_else(|| "AI 没有返回可用的形态（不是一个 JSON 对象）".to_string())?;
    let mut warnings = Vec::new();
    let mut setup = setup_body(&value, &mut warnings);
    if setup.name.is_empty() {
        return Err("AI 返回的形态没有名称".to_string());
    }
    setup.id = unique_setup_id(value.get("id").and_then(Value::as_str).unwrap_or_default(), &setup.name, existing_ids);
    let notes = value
        .get("notes")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|note| sanitize_handbook_text(note, true).chars().take(MAX_RULE_CHARS).collect::<String>())
                .filter(|note| !note.is_empty())
                .take(8)
                .collect()
        })
        .unwrap_or_default();
    Ok(SetupDraft { setup, notes, warnings })
}

/// 解析按纠正改写的形态：id 与状态沿用当前形态；名称没给时沿用原名。
pub fn parse_setup_revision(raw: &str, current: &HandbookSetup) -> Result<SetupRevisionDraft, String> {
    let value = extract_json_object(raw).ok_or_else(|| "AI 没有返回可用的修改（不是一个 JSON 对象）".to_string())?;
    let body = value.get("setup").cloned().ok_or_else(|| "AI 返回的修改里没有 setup".to_string())?;
    let mut warnings = Vec::new();
    let mut setup = setup_body(&body, &mut warnings);
    if setup.name.is_empty() {
        setup.name = current.name.clone();
    }
    setup.id = current.id.clone();
    setup.status = current.status.clone();
    let mut text = |key: &str, max: usize| text_field(&value, key, max, &mut warnings);
    let changes = text("changes", MAX_SETUP_TEXT_CHARS);
    let benefits = text("benefits", MAX_SETUP_TEXT_CHARS);
    let risks = text("risks", MAX_SETUP_TEXT_CHARS);
    if setup == *current {
        return Err("AI 起草的修改和当前形态一模一样".to_string());
    }
    Ok(SetupRevisionDraft { setup, changes, benefits, risks, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handbook::{default_handbook, SETUP_STATUS_LIVE};

    #[test]
    fn example_output_parses_into_an_observing_setup() {
        let draft = parse_setup_draft(SETUP_DRAFT_EXAMPLE_ASSISTANT, &["trend_pullback".into()]).unwrap();
        assert_eq!(draft.setup.id, "funding_fade");
        assert_eq!(draft.setup.status, SETUP_STATUS_OBSERVING);
        assert_eq!(draft.setup.regimes, vec!["up".to_string(), "mixed".to_string()]);
        assert_eq!(draft.setup.size_note.as_deref(), Some("只用正常仓位的一半"));
        assert_eq!(draft.notes.len(), 2);
        assert!(draft.warnings.is_empty(), "{:?}", draft.warnings);
    }

    #[test]
    fn lenient_parsing_fixes_ids_ranges_and_reports_gaps() {
        let raw = "好的，这是草稿：\n```json\n{\"name\":\"Breakout Retest\",\"id\":\"Bad Id!\",\"regimes\":[\"上升\",\"sideways\"],\"direction\":\"顺势\",\"entry\":\"突破后回踩\",\"stop\":\"\",\"target\":\"2R\",\"invalidation\":\"回到区间\",\"minNetRr\":30,\"stopAtrMin\":\"3\",\"stopAtrMax\":1,\"status\":\"live\"}\n```";
        let draft = parse_setup_draft(raw, &["breakout_retest".into()]).unwrap();
        assert_eq!(draft.setup.id, "breakout_retest_1", "invalid id replaced by a unique slug of the name");
        assert_eq!(draft.setup.status, SETUP_STATUS_OBSERVING, "drafts always start observing");
        assert_eq!(draft.setup.regimes, vec!["up".to_string()]);
        assert_eq!(draft.setup.direction, "with_trend");
        assert_eq!(draft.setup.min_net_rr, Some(10.0));
        assert_eq!((draft.setup.stop_atr_min, draft.setup.stop_atr_max), (Some(1.0), Some(3.0)));
        assert!(draft.warnings.iter().any(|warning| warning.contains("stop")), "{:?}", draft.warnings);
        assert!(parse_setup_draft("没有 JSON", &[]).is_err());
        assert!(parse_setup_draft("{\"entry\":\"x\"}", &[]).is_err(), "a setup needs a name");
        // 中文名称生成 setup_N。
        let chinese = parse_setup_draft("{\"name\":\"挤压反转\",\"regimes\":[\"down\"],\"direction\":\"both\"}", &["setup_1".into()]).unwrap();
        assert_eq!(chinese.setup.id, "setup_2");
    }

    #[test]
    fn revisions_keep_id_and_status_and_reject_no_ops() {
        let mut current = default_handbook().setups.into_iter().find(|setup| setup.id == "range_edge").unwrap();
        current.status = SETUP_STATUS_LIVE.into();
        let revision = parse_setup_revision(SETUP_REVISION_EXAMPLE_ASSISTANT, &current).unwrap();
        assert_eq!((revision.setup.id.as_str(), revision.setup.status.as_str()), ("range_edge", SETUP_STATUS_LIVE));
        assert!(revision.setup.entry.contains("1h 收盘拒绝"));
        assert!(revision.benefits.starts_with("如果纠正是对的"));
        let same = format!("{{\"setup\":{}}}", serde_json::to_string(&current).unwrap());
        assert!(parse_setup_revision(&same, &current).is_err());
        assert!(parse_setup_revision("{\"changes\":\"x\"}", &current).is_err());
    }

    #[test]
    fn prompts_carry_the_placeholders_the_sidecar_fills() {
        for template in [SETUP_DRAFT_USER_PROMPT, SETUP_REVISION_USER_PROMPT] {
            assert!(template.contains("{{description}}") && template.contains("{{name_line}}"));
        }
        assert_eq!(setup_draft_messages().len(), 2);
        assert_eq!(setup_revision_messages()[1].0, "assistant");
    }
}
