//! 交易员的临时指令：用户对一段时间、一个范围下的命令（「今晚不开新仓」「这周只做多 BTC」「周五非农前别加仓」）。
//! `no_entry` / `long_only` / `short_only` 由代码在开仓守卫里强制；`note` 只写进简报给 AI 参考，从不拦截。
//! 指令只能让交易更保守，不能放宽任何硬风控。这里是纯逻辑；存库与编排在主程序。

use serde::{Deserialize, Serialize};

pub const INSTRUCTION_NO_ENTRY: &str = "no_entry";
pub const INSTRUCTION_LONG_ONLY: &str = "long_only";
pub const INSTRUCTION_SHORT_ONLY: &str = "short_only";
pub const INSTRUCTION_NOTE: &str = "note";
/// 一条指令最长有效 30 天；同时生效的最多 20 条；说明最多 200 字。
pub const MAX_INSTRUCTION_DURATION_MS: i64 = 30 * 24 * 60 * 60_000;
pub const MAX_ACTIVE_INSTRUCTIONS: usize = 20;
pub const MAX_INSTRUCTION_TEXT_CHARS: usize = 200;
/// 简报里最多列这么多条，其余写「另有 N 条」。代码强制的排在前面。
const MAX_BRIEFING_LINES: usize = 8;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraderInstruction {
    pub id: String,
    /// 空 = 所有交易员 Profile。
    pub profile_id: Option<String>,
    /// 空 = 所有品种。
    pub inst_id: Option<String>,
    pub kind: String,
    pub text: String,
    pub created_at: i64,
    pub expires_at: i64,
}

impl TraderInstruction {
    pub fn is_enforced(&self) -> bool {
        matches!(self.kind.as_str(), INSTRUCTION_NO_ENTRY | INSTRUCTION_LONG_ONLY | INSTRUCTION_SHORT_ONLY)
    }

    pub fn is_active(&self, now: i64) -> bool {
        self.expires_at > now
    }

    /// 是否作用于这个 Profile（以及这个品种；`inst_id` 为空表示只看 Profile 范围）。
    pub fn applies_to(&self, profile_id: &str, inst_id: Option<&str>) -> bool {
        self.profile_id.as_deref().is_none_or(|scope| scope == profile_id)
            && match (self.inst_id.as_deref(), inst_id) {
                (Some(scope), Some(inst_id)) => scope.eq_ignore_ascii_case(inst_id),
                _ => true,
            }
    }

    /// 这条指令会不会拦下这个方向的开仓。
    pub fn blocks(&self, direction: &str) -> bool {
        match self.kind.as_str() {
            INSTRUCTION_NO_ENTRY => true,
            INSTRUCTION_LONG_ONLY => direction == "short",
            INSTRUCTION_SHORT_ONLY => direction == "long",
            _ => false,
        }
    }
}

pub fn valid_instruction_kind(kind: &str) -> bool {
    matches!(kind, INSTRUCTION_NO_ENTRY | INSTRUCTION_LONG_ONLY | INSTRUCTION_SHORT_ONLY | INSTRUCTION_NOTE)
}

/// 保存前的校验：类型合法；到期在将来且不超过 30 天；`note` 必须写内容；说明不超过 200 字。
pub fn validate_instruction(kind: &str, text: &str, expires_at: i64, now: i64) -> Result<(), String> {
    if !valid_instruction_kind(kind) {
        return Err(format!("指令类型只能是 {INSTRUCTION_NO_ENTRY} / {INSTRUCTION_LONG_ONLY} / {INSTRUCTION_SHORT_ONLY} / {INSTRUCTION_NOTE}"));
    }
    if kind == INSTRUCTION_NOTE && text.trim().is_empty() {
        return Err("「说明」类指令要写内容".to_string());
    }
    if text.chars().count() > MAX_INSTRUCTION_TEXT_CHARS {
        return Err(format!("指令说明最多 {MAX_INSTRUCTION_TEXT_CHARS} 个字"));
    }
    if expires_at <= now {
        return Err("到期时间要在将来".to_string());
    }
    if expires_at - now > MAX_INSTRUCTION_DURATION_MS {
        return Err("一条指令最长有效 30 天".to_string());
    }
    Ok(())
}

fn kind_label(kind: &str, chinese: bool) -> &'static str {
    match (kind, chinese) {
        (INSTRUCTION_NO_ENTRY, true) => "不开新仓",
        (INSTRUCTION_LONG_ONLY, true) => "只做多",
        (INSTRUCTION_SHORT_ONLY, true) => "只做空",
        (_, true) => "说明",
        (INSTRUCTION_NO_ENTRY, false) => "no new entries",
        (INSTRUCTION_LONG_ONLY, false) => "long only",
        (INSTRUCTION_SHORT_ONLY, false) => "short only",
        (_, false) => "note",
    }
}

fn scope_label(instruction: &TraderInstruction, chinese: bool) -> String {
    let profile = match (instruction.profile_id.is_some(), chinese) {
        (true, true) => "本 Profile",
        (true, false) => "this Profile",
        (false, true) => "全部交易员",
        (false, false) => "all traders",
    };
    let inst = instruction.inst_id.clone().unwrap_or_else(|| (if chinese { "全部品种" } else { "all instruments" }).to_string());
    format!("{profile} · {inst}")
}

/// 守卫用：这个交易员 Profile 在这个品种、这个方向开仓会被哪些生效中的指令拦下。
pub fn instruction_open_reasons(instructions: &[TraderInstruction], profile_id: &str, inst_id: &str, direction: &str, now: i64) -> Vec<String> {
    instructions
        .iter()
        .filter(|item| item.is_active(now) && item.applies_to(profile_id, Some(inst_id)) && item.blocks(direction))
        .map(|item| {
            let detail = if item.text.trim().is_empty() { String::new() } else { format!("；用户说明：{}", item.text.trim()) };
            format!(
                "instruction_{}：用户的临时指令「{}」（{}）生效中，不能开这个仓{detail}。要开仓需先在「交易员 → 临时指令」里取消这条指令",
                item.kind,
                kind_label(&item.kind, true),
                scope_label(item, true)
            )
        })
        .collect()
}

/// 写进简报的「用户的临时指令」：只列作用于这个 Profile 的生效中的指令，代码强制的在前、新的在前，
/// 最多 8 行。`until` 把毫秒时间格式化成简报里用的本地时间。没有指令时返回 `None`。
pub fn render_instructions(
    instructions: &[TraderInstruction],
    profile_id: &str,
    now: i64,
    chinese: bool,
    until: &dyn Fn(i64) -> String,
) -> Option<String> {
    let mut active = instructions
        .iter()
        .filter(|item| item.is_active(now) && item.applies_to(profile_id, None))
        .collect::<Vec<_>>();
    if active.is_empty() {
        return None;
    }
    active.sort_by(|a, b| b.is_enforced().cmp(&a.is_enforced()).then(b.created_at.cmp(&a.created_at)));
    let mut lines = active
        .iter()
        .take(MAX_BRIEFING_LINES)
        .map(|item| {
            let tag = match (item.is_enforced(), chinese) {
                (true, true) => "代码强制",
                (true, false) => "enforced by code",
                (false, true) => "参考",
                (false, false) => "guidance",
            };
            let text = item.text.trim().chars().take(MAX_INSTRUCTION_TEXT_CHARS).collect::<String>();
            let text = if text.is_empty() { String::new() } else if chinese { format!("：{text}") } else { format!(": {text}") };
            if chinese {
                format!("- [{tag}] {}（{}，到 {}）{text}", kind_label(&item.kind, true), scope_label(item, true), until(item.expires_at))
            } else {
                format!("- [{tag}] {} ({}, until {}){text}", kind_label(&item.kind, false), scope_label(item, false), until(item.expires_at))
            }
        })
        .collect::<Vec<_>>();
    if active.len() > MAX_BRIEFING_LINES {
        let more = active.len() - MAX_BRIEFING_LINES;
        lines.push(if chinese { format!("- 另有 {more} 条") } else { format!("- {more} more") });
    }
    let intro = if chinese {
        "用户下达的临时指令，优先于手册。标「代码强制」的会被后端直接拒绝开仓；「参考」的由你判断如何遵守。"
    } else {
        "Temporary instructions from the user; they take precedence over the handbook. Code rejects openings that break an enforced one; follow the guidance ones with judgement."
    };
    Some(format!("{intro}\n{}", lines.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, profile: Option<&str>, inst: Option<&str>, kind: &str, created_at: i64, expires_at: i64) -> TraderInstruction {
        TraderInstruction {
            id: id.into(),
            profile_id: profile.map(str::to_string),
            inst_id: inst.map(str::to_string),
            kind: kind.into(),
            text: String::new(),
            created_at,
            expires_at,
        }
    }

    #[test]
    fn scope_kind_and_expiry_decide_what_is_blocked() {
        let now = 1_000;
        let list = vec![
            item("a", None, None, INSTRUCTION_NO_ENTRY, 1, 2_000),
            item("b", Some("p1"), Some("BTC-USDT-SWAP"), INSTRUCTION_LONG_ONLY, 2, 2_000),
            item("c", Some("p2"), None, INSTRUCTION_SHORT_ONLY, 3, 2_000),
            item("d", None, None, INSTRUCTION_NOTE, 4, 2_000),
            item("e", None, None, INSTRUCTION_NO_ENTRY, 5, 900),
        ];
        // 全局「不开新仓」挡住所有 Profile、所有方向。
        let reasons = instruction_open_reasons(&list, "p9", "ETH-USDT-SWAP", "long", now);
        assert_eq!(reasons.len(), 1);
        assert!(reasons[0].starts_with("instruction_no_entry"), "{reasons:?}");
        // 只做多：只挡做空，而且只在它的 Profile 与品种。
        let only = &list[1..2];
        assert_eq!(instruction_open_reasons(only, "p1", "BTC-USDT-SWAP", "short", now).len(), 1);
        assert!(instruction_open_reasons(only, "p1", "BTC-USDT-SWAP", "long", now).is_empty());
        assert!(instruction_open_reasons(only, "p1", "ETH-USDT-SWAP", "short", now).is_empty());
        assert!(instruction_open_reasons(only, "p2", "BTC-USDT-SWAP", "short", now).is_empty());
        // 说明从不拦截；过期的不再生效。
        assert!(instruction_open_reasons(&list[3..], "p1", "BTC-USDT-SWAP", "long", now).is_empty());
        assert_eq!(instruction_open_reasons(&list[2..3], "p2", "SOL-USDT-SWAP", "long", now).len(), 1);
    }

    #[test]
    fn briefing_lists_enforced_first_and_caps_the_lines() {
        let now = 1_000;
        let mut list = vec![item("note", None, None, INSTRUCTION_NOTE, 9, 2_000)];
        list[0].text = "周五非农前别加仓".into();
        for index in 0..10 {
            list.push(item(&format!("n{index}"), Some("p1"), Some("BTC-USDT-SWAP"), INSTRUCTION_LONG_ONLY, index, 2_000));
        }
        list.push(item("other", Some("p2"), None, INSTRUCTION_NO_ENTRY, 20, 2_000));
        let text = render_instructions(&list, "p1", now, true, &|_| "10-05 18:00".to_string()).unwrap();
        assert!(text.lines().nth(1).unwrap().contains("[代码强制] 只做多"), "{text}");
        assert!(text.contains("另有 3 条"), "{text}");
        assert!(!text.contains("周五非农"), "the note is beyond the first eight lines here: {text}");
        assert_eq!(text.lines().count(), 1 + 8 + 1);
        assert!(render_instructions(&list, "p3", now, true, &|_| String::new()).unwrap().contains("周五非农前别加仓"));
        assert!(render_instructions(&[], "p1", now, true, &|_| String::new()).is_none());
        assert!(render_instructions(&list, "p1", now, false, &|_| "18:00".to_string()).unwrap().contains("[enforced by code] long only"));
    }

    #[test]
    fn validation_bounds_kind_text_and_expiry() {
        let now = 1_000_000;
        assert!(validate_instruction(INSTRUCTION_NO_ENTRY, "", now + 1, now).is_ok());
        assert!(validate_instruction("flip", "", now + 1, now).is_err());
        assert!(validate_instruction(INSTRUCTION_NOTE, "  ", now + 1, now).is_err());
        assert!(validate_instruction(INSTRUCTION_NOTE, &"x".repeat(201), now + 1, now).is_err());
        assert!(validate_instruction(INSTRUCTION_LONG_ONLY, "", now, now).is_err());
        assert!(validate_instruction(INSTRUCTION_LONG_ONLY, "", now + MAX_INSTRUCTION_DURATION_MS + 1, now).is_err());
    }
}
