//! `ai_agent_generate` 的草稿解析与规范化（契约 C9 / 内容包 §2.4、§2.5）。
//!
//! 分工（lead 裁决 1）：侧车只发提示词、收模型输出、尽量 parse，
//! **frontmatter 渲染 + role/scopes/envelope/skills 白名单校验 + 五段骨架兜底
//! 全部在 Rust**。解析失败不抛错中断：用 `description` 走兜底骨架 + warning。

use crate::agents::{
    agent_role_slug, agent_slug, complete_agent_body_sections, is_recommended_agent_role,
    render_agent_markdown, render_agent_skeleton, strip_agent_body_wrappers, summarize_agent_body,
    validate_agent_definition, AiAgentDefinition, AGENT_ENVELOPE_RISK, AGENT_NAME_MAX_CHARS,
    AGENT_SOURCE_AI, AGENT_SOURCE_BUILTIN, AGENT_SOURCE_CUSTOM,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

// 内容包 §2 建议的常量名，逐字对外导出（改文案请改内容包并重新生成 draft_content.rs）。
pub use crate::draft_content::{
    AI_AGENT_DRAFT_FALLBACK_SKELETON, AI_AGENT_DRAFT_FEW_SHOT_A, AI_AGENT_DRAFT_FEW_SHOT_B,
    AI_AGENT_DRAFT_SYSTEM_PROMPT, AI_AGENT_DRAFT_USER_PROMPT,
};

/// 两例 few-shot 成对常量（内容包 §2.3）。
pub const AI_AGENT_DRAFT_FEW_SHOTS: [(&str, &str); 2] =
    [AI_AGENT_DRAFT_FEW_SHOT_A, AI_AGENT_DRAFT_FEW_SHOT_B];

/// 提示词模板中的占位符。
pub const AGENT_DRAFT_DESCRIPTION_PLACEHOLDER: &str = "{{description}}";
pub const AGENT_DRAFT_NAME_LINE_PLACEHOLDER: &str = "{{name_line}}";

/// 提示词里允许的 Skill 白名单（内容包 §2.1）；未知值保留但提示。
pub const AGENT_DRAFT_KNOWN_SKILLS: [&str; 2] =
    ["okx-market-intelligence", "market-radar-research"];

/// 生成结果（C9 的 `ai_agent_generate` 返回体）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentDraftOutcome {
    /// 渲染后的完整 AGENTS.md（frontmatter 由 Rust 生成，草稿不落盘）。
    pub content: String,
    pub warnings: Vec<String>,
}

pub fn agent_draft_system_prompt() -> &'static str {
    AI_AGENT_DRAFT_SYSTEM_PROMPT
}

/// 内容包 §2.2 user 提示词：替换描述与名称行。
pub fn build_agent_draft_user_prompt(description: &str, name: Option<&str>) -> String {
    let name_line = match name.map(str::trim).filter(|value| !value.is_empty()) {
        Some(name) => format!("用户指定名称：{name}"),
        None => "用户未指定名称，请自行命名（1-40 字）。".to_string(),
    };
    AI_AGENT_DRAFT_USER_PROMPT
        .replace(AGENT_DRAFT_DESCRIPTION_PLACEHOLDER, description.trim())
        .replace(AGENT_DRAFT_NAME_LINE_PLACEHOLDER, &name_line)
}

/// 一次性请求的 messages 前缀（两例 few-shot，成对：user/assistant）。
pub fn agent_draft_few_shot_messages() -> Vec<(&'static str, &'static str)> {
    vec![
        ("user", AI_AGENT_DRAFT_FEW_SHOT_A.0),
        ("assistant", AI_AGENT_DRAFT_FEW_SHOT_A.1),
        ("user", AI_AGENT_DRAFT_FEW_SHOT_B.0),
        ("assistant", AI_AGENT_DRAFT_FEW_SHOT_B.1),
    ]
}

/// JSON 容错阶梯（内容包 §2.5，与侧车 `parseProfileAgentJson` 同构）：
/// 原始文本 → 代码围栏内文本 → 首个 `{` 到末个 `}` 的切片；
/// **只有一个**可解析对象才接受，多个候选视为失败。
pub fn parse_agent_role_json(raw: &str) -> Option<Value> {
    let mut candidates = agent_role_json_candidates(raw);
    candidates.dedup();
    let mut parsed = Vec::new();
    for candidate in candidates {
        if let Ok(value) = serde_json::from_str::<Value>(&candidate) {
            if value.is_object() {
                parsed.push(value);
            }
        }
    }
    if parsed.len() == 1 {
        parsed.pop()
    } else {
        None
    }
}

fn agent_role_json_candidates(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let mut candidates: Vec<String> = vec![trimmed.to_string()];
    // 代码围栏：```json ... ``` 或 ``` ... ```
    let mut rest = trimmed;
    while let Some(start) = rest.find("```") {
        let after = &rest[start + 3..];
        let Some(end) = after.find("```") else {
            break;
        };
        let inner = after[..end]
            .trim_start_matches(|ch: char| ch.is_ascii_alphabetic() || ch == '\n' || ch == '\r')
            .trim()
            .to_string();
        if !inner.is_empty() {
            candidates.push(inner);
        }
        rest = &after[end + 3..];
    }
    if let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}')) {
        if start < end {
            let slice = trimmed[start..=end].to_string();
            if !candidates.contains(&slice) {
                candidates.push(slice);
            }
        }
    }
    candidates
}

/// 模型输出 → 可保存的 AGENTS.md（前端渲染契约 §2.4）。
///
/// - `roleJson` 为空 / 解析失败 / 字段全错 → 用 `description` 走兜底骨架 + warning，
///   **不返回 Err**（除 `description` 本身为空）。
/// - `envelope` 取更严者（lead 裁决 2）；`scopes` 过滤白名单，过滤后为空回填
///   `["market"]`（lead 裁决 5）。
pub fn agent_draft_from_role_json(
    role_json: Option<&str>,
    description: &str,
    name_hint: Option<&str>,
    now_ms: i64,
) -> Result<AiAgentDraftOutcome, String> {
    let description = description.trim();
    if description.is_empty() {
        return Err("Agent 描述不能为空".to_string());
    }
    let mut warnings = Vec::new();
    let parsed = role_json
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(parse_agent_role_json);

    let Some(value) = parsed else {
        warnings.push(
            "AI 未返回可解析的角色 JSON，已生成骨架正文；请补充方法与证据要求后再保存。".to_string(),
        );
        let fallback =
            AI_AGENT_DRAFT_FALLBACK_SKELETON.replace(AGENT_DRAFT_DESCRIPTION_PLACEHOLDER, description);
        let name = draft_fallback_name(name_hint, description);
        let mut def = new_draft_definition(&name, "custom", Vec::new(), false, 1, now_ms);
        def.body = fallback.trim().to_string();
        def.refresh_summary();
        validate_agent_definition(&def)?;
        return Ok(AiAgentDraftOutcome {
            content: render_agent_markdown(&def, &def.body),
            warnings,
        });
    };

    // name
    let raw_name = value
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let mut name = if raw_name.is_empty() {
        name_hint
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| draft_fallback_name(None, description))
    } else {
        raw_name
    };
    if name.chars().count() > AGENT_NAME_MAX_CHARS {
        name = name.chars().take(AGENT_NAME_MAX_CHARS).collect();
        warnings.push("AI 返回的 name 超出长度限制，已调整。".to_string());
    }
    if name.trim().is_empty() {
        name = draft_fallback_name(None, description);
        warnings.push("AI 返回的 name 超出长度限制，已调整。".to_string());
    }

    // role
    let raw_role = value
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let role = if is_recommended_agent_role(&raw_role) {
        raw_role.clone()
    } else {
        warnings.push("AI 返回的 role 不在枚举内，已回退为 custom。".to_string());
        "custom".to_string()
    };

    // skills：未知值保留（C2），只提示。
    let skills = value
        .get("skills")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let unknown_skills = skills
        .iter()
        .filter(|skill| !AGENT_DRAFT_KNOWN_SKILLS.contains(&skill.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if !unknown_skills.is_empty() {
        warnings.push(format!(
            "AI 返回的 skills 含未知 Skill，已保留，运行前需确认是否已激活：{}。",
            unknown_skills.join("、")
        ));
    }

    // envelope 取更严者（lead 裁决 2）。模型输出**非法**值时不中断生成
    // （内容包 §2.4/§2.5：草稿路径不得失败），但必须显式告警，并且只用
    // "risk / role=account_risk / scopes 含 account" 的取严规则决定，绝不静默照抄。
    let raw_envelope = value.get("envelope").and_then(Value::as_str);
    let declared_envelope = match crate::agents::parse_agent_envelope(raw_envelope) {
        Ok(parsed) => parsed,
        Err(_) => {
            warnings.push(format!(
                "AI 返回的 envelope 不在白名单内（{}），已按 risk/standard 规则判定。",
                raw_envelope.unwrap_or_default().trim()
            ));
            None
        }
    };
    let mut requires_account = value
        .get("requiresAccount")
        .or_else(|| value.get("requires_account"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let envelope = crate::agents::resolve_agent_envelope(declared_envelope.as_deref(), &role);
    if envelope == AGENT_ENVELOPE_RISK && !requires_account {
        requires_account = true;
        warnings.push("envelope=risk 要求绑定账户，requiresAccount 已置为 true。".to_string());
    }

    // body
    let raw_body = value
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut body = if raw_body.trim().is_empty() {
        render_agent_skeleton(description)
    } else {
        raw_body
    };
    let (stripped, strip_warnings) = strip_agent_body_wrappers(&body);
    body = stripped;
    warnings.extend(strip_warnings);
    let (completed, missing) = complete_agent_body_sections(&body);
    if !missing.is_empty() {
        warnings.push(format!(
            "AI 返回的正文缺少段落，已按骨架补齐：{}。",
            missing.join("、")
        ));
        body = completed;
    }

    let mut def = new_draft_definition(
        &name,
        &role,
        skills,
        requires_account,
        value
            .get("version")
            .and_then(Value::as_i64)
            .unwrap_or(1)
            .max(1),
        now_ms,
    );
    def.envelope = envelope;
    def.body = body.trim().to_string();
    def.refresh_summary();
    validate_agent_definition(&def)?;
    Ok(AiAgentDraftOutcome {
        content: render_agent_markdown(&def, &def.body),
        warnings,
    })
}

/// 兜底命名：用户输入名称 → 描述前 12 字（去换行）。
fn draft_fallback_name(name_hint: Option<&str>, description: &str) -> String {
    if let Some(name) = name_hint.map(str::trim).filter(|value| !value.is_empty()) {
        return name.chars().take(AGENT_NAME_MAX_CHARS).collect();
    }
    let head = description
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or(description);
    let head = head.split_whitespace().collect::<Vec<_>>().join(" ");
    let name = head.chars().take(12).collect::<String>();
    if name.trim().is_empty() {
        "自定义专家".to_string()
    } else {
        name
    }
}

#[allow(clippy::too_many_arguments)]
fn new_draft_definition(
    name: &str,
    role: &str,
    skills: Vec<String>,
    requires_account: bool,
    version: i64,
    now_ms: i64,
) -> AiAgentDefinition {
    let role = if role.trim().is_empty() {
        "custom".to_string()
    } else {
        role.trim().to_string()
    };
    AiAgentDefinition {
        id: draft_agent_id(name),
        name: name.trim().to_string(),
        envelope: crate::agents::resolve_agent_envelope(None, &role),
        role,
        skills,
        requires_account,
        source: AGENT_SOURCE_AI.to_string(),
        version,
        created_at: now_ms,
        summary: String::new(),
        body: String::new(),
        deprecated: false,
        scopes_deprecated: false,
        path: std::path::PathBuf::new(),
    }
}

/// 草稿 id：由 name 归一化；无法生成时回落 `custom-agent`。
/// 真正落盘时以 `ai_agent_save` 的 frontmatter id 为准（lead 裁决 3）。
pub fn draft_agent_id(name: &str) -> String {
    let slug = agent_slug(name);
    if slug.len() >= 2 {
        slug
    } else {
        "custom-agent".to_string()
    }
}

/// 工具 `agent.create` 的 role 归一化：非枚举值退化为 slug 或 `custom`。
pub fn normalize_agent_create_role(role: &str) -> String {
    let trimmed = role.trim();
    if is_recommended_agent_role(trimmed) {
        return trimmed.to_string();
    }
    let fallback = agent_role_slug(trimmed, trimmed);
    if fallback.is_empty() {
        "custom".to_string()
    } else {
        fallback
    }
}

/// 校验 source 字段：`source: builtin` 只能来自内置 id（保存路径用）。
pub fn validate_agent_source_for_save(id: &str, source: &str) -> Result<(), String> {
    if source == AGENT_SOURCE_BUILTIN {
        if crate::agents::is_builtin_agent_id(id) {
            return Ok(());
        }
        return Err(
            "source: builtin 只保留给内置 Agent；自定义 Agent 请使用 custom 或 ai".to_string(),
        );
    }
    if source == AGENT_SOURCE_CUSTOM || source == AGENT_SOURCE_AI {
        return Ok(());
    }
    Err("Agent source 不合法".to_string())
}

/// 正文摘要（工具创建路径复用）。
pub fn draft_summary(body: &str) -> String {
    summarize_agent_body(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::{parse_agent_markdown, AGENT_BODY_SECTION_DUTIES};

    #[test]
    fn user_prompt_replaces_description_and_name_line() {
        let with_name = build_agent_draft_user_prompt("  看 BTC 盘口  ", Some("盘口冲击"));
        assert!(with_name.contains("看 BTC 盘口"));
        assert!(with_name.contains("用户指定名称：盘口冲击"));
        assert!(!with_name.contains(AGENT_DRAFT_DESCRIPTION_PLACEHOLDER));
        let without_name = build_agent_draft_user_prompt("看 BTC 盘口", None);
        assert!(without_name.contains("用户未指定名称，请自行命名（1-40 字）。"));
        assert!(agent_draft_system_prompt().contains("market_structure"));
        assert!(agent_draft_system_prompt().contains("## 数据缺口处理"));
        assert_eq!(agent_draft_few_shot_messages().len(), 4);
    }

    #[test]
    fn role_json_ladder_accepts_single_candidate_only() {
        let plain = r###"{"name":"盘口冲击","role":"order_flow_liquidity","envelope":"standard","scopes":["market"],"skills":[],"requiresAccount":false,"body":"## 身份\n身份。"}"###;
        assert!(parse_agent_role_json(plain).is_some());
        let fenced = format!("```json\n{plain}\n```");
        assert!(parse_agent_role_json(&fenced).is_some());
        let chatty = format!("好的，这是结果：\n{plain}\n请查收。");
        assert!(parse_agent_role_json(&chatty).is_some());
        let two = format!("{plain}\n{plain}");
        assert!(parse_agent_role_json(&two).is_none());
        assert!(parse_agent_role_json("抱歉，我无法完成。").is_none());
        assert!(parse_agent_role_json("").is_none());
    }

    #[test]
    fn draft_renders_frontmatter_and_normalizes_fields() {
        let role_json = r###"{"name":" 账户风险复核 ","role":"account_risk","envelope":"standard","scopes":["account","nope"],"skills":["unknown-skill"],"requiresAccount":false,"body":"## 身份\n身份。\n\n## 职责\n检查账户风险。\n"}"###;
        let outcome = agent_draft_from_role_json(Some(role_json), "检查账户", None, 1_700_000_000_000)
            .expect("draft");
        let def = parse_agent_markdown(&outcome.content).expect("rendered draft parses");
        assert_eq!(def.name, "账户风险复核");
        assert_eq!(def.role, "account_risk");
        // envelope 取更严者：role=account_risk → risk，且 requiresAccount 被置为 true。
        assert_eq!(def.envelope, "risk");
        assert!(def.requires_account);
        assert!(!def.scopes_deprecated);
        assert_eq!(def.skills, vec!["unknown-skill".to_string()]);
        assert_eq!(def.source, "ai");
        assert_eq!(def.created_at, 1_700_000_000_000);
        assert!(def.body.contains(AGENT_BODY_SECTION_DUTIES));
        assert!(outcome.warnings.iter().any(|w| w.contains("未知 Skill")));
        assert!(outcome.warnings.iter().any(|w| w.contains("requiresAccount")));
    }

    /// 草稿路径遇到非法值不中断（C9），但必须告警且不得静默照抄。
    #[test]
    fn draft_never_fails_on_invalid_envelope_but_warns() {
        let role_json = r###"{"name":"非法值","role":"custom","envelope":"none","scopes":["market"],"skills":[],"requiresAccount":false,"body":"## 身份\n身份。\n\n## 职责\n职责。\n\n## 方法与证据要求\n方法。\n\n## 输出偏好\n输出。\n\n## 数据缺口处理\n缺口。"}"###;
        assert!(parse_agent_role_json(role_json).is_some(), "测试样例必须是合法 JSON");
        let outcome = agent_draft_from_role_json(Some(role_json), "描述", None, 1).expect("draft");
        assert!(
            outcome
                .warnings
                .iter()
                .any(|w| w.contains("envelope 不在白名单内")),
            "warnings={:?}",
            outcome.warnings
        );
        let def = parse_agent_markdown(&outcome.content).expect("parse");
        assert_eq!(def.envelope, "standard");

        // 非法 envelope 不得掩盖取严规则：role=account_risk 仍是 risk。
        let risk_json = r###"{"name":"风险","role":"account_risk","envelope":"none","scopes":["market"],"skills":[],"requiresAccount":false,"body":"## 身份\n身份。\n\n## 职责\n职责。\n\n## 方法与证据要求\n方法。\n\n## 输出偏好\n输出。\n\n## 数据缺口处理\n缺口。"}"###;
        let outcome = agent_draft_from_role_json(Some(risk_json), "描述", None, 1).expect("draft");
        let def = parse_agent_markdown(&outcome.content).expect("parse");
        assert_eq!(def.envelope, "risk");
        assert!(def.requires_account);
    }

    #[test]
    fn draft_backfills_empty_scopes_to_market() {
        let role_json = r###"{"name":"宽域","role":"custom","envelope":"standard","scopes":[],"skills":[],"requiresAccount":false,"body":"## 身份\n身份。\n\n## 职责\n职责。\n\n## 方法与证据要求\n方法。\n\n## 输出偏好\n输出。\n\n## 数据缺口处理\n缺口。"}"###;
        let outcome = agent_draft_from_role_json(Some(role_json), "描述", None, 1).expect("draft");
        // C15：草稿不再有 scopes，也不再有"回填 market"的提示。
        assert!(!outcome
            .warnings
            .iter()
            .any(|w| w.contains("scopes") || w.contains("回填")));
        let _ = parse_agent_markdown(&outcome.content).expect("parse");
    }

    #[test]
    fn unparsable_role_json_falls_back_to_skeleton_with_warning() {
        let outcome = agent_draft_from_role_json(
            Some("我无法完成这个任务。"),
            "盯住 BTC 永续的流动性",
            None,
            42,
        )
        .expect("fallback draft");
        assert!(outcome
            .warnings
            .iter()
            .any(|w| w.contains("未返回可解析的角色 JSON")));
        let def = parse_agent_markdown(&outcome.content).expect("parse fallback");
        assert_eq!(def.source, "ai");
        assert!(def.body.contains("盯住 BTC 永续的流动性"));
        assert!(def.body.contains(AGENT_BODY_SECTION_DUTIES));

        let empty = agent_draft_from_role_json(None, "描述文字", Some("名称"), 42).expect("draft");
        assert!(empty
            .warnings
            .iter()
            .any(|w| w.contains("未返回可解析的角色 JSON")));
        assert!(agent_draft_from_role_json(None, "   ", None, 42).is_err());
    }

    #[test]
    fn draft_strips_frontmatter_and_shell_wording_from_body() {
        let role_json = r###"{"name":"剥离","role":"custom","envelope":"standard","scopes":["market"],"skills":[],"requiresAccount":false,"body":"---\nid: 假装\n---\n## 身份\n身份。\n只读权限：本 Agent 只读。\n\n## 职责\n职责。\n\n## 方法与证据要求\n方法。\n\n## 输出偏好\n输出。\n\n## 数据缺口处理\n缺口。"}"###;
        let outcome = agent_draft_from_role_json(Some(role_json), "描述", None, 7).expect("draft");
        assert!(outcome.warnings.iter().any(|w| w.contains("frontmatter")));
        assert!(outcome.warnings.iter().any(|w| w.contains("运行时外壳")));
        let def = parse_agent_markdown(&outcome.content).expect("parse");
        assert!(!def.body.contains("只读权限"));
    }

    #[test]
    fn draft_name_falls_back_to_description_head_and_is_truncated() {
        let long_name = "字".repeat(60);
        let role_json = format!(
            r###"{{"name":"{long_name}","role":"custom","scopes":["market"],"body":"## 职责\n职责。"}}"###
        );
        let outcome = agent_draft_from_role_json(Some(&role_json), "描述", None, 1).expect("draft");
        let def = parse_agent_markdown(&outcome.content).expect("parse");
        assert_eq!(def.name.chars().count(), AGENT_NAME_MAX_CHARS);
        assert!(outcome
            .warnings
            .iter()
            .any(|w| w.contains("name 超出长度限制")));

        let nameless = r###"{"role":"custom","scopes":["market"],"body":"## 职责\n职责。"}"###;
        let outcome = agent_draft_from_role_json(
            Some(nameless),
            "这是描述的前十二个字以外的更多内容",
            None,
            1,
        )
        .expect("draft");
        let def = parse_agent_markdown(&outcome.content).expect("parse");
        assert_eq!(def.name.chars().count(), 12);
        assert_eq!(def.name, "这是描述的前十二个字以外");
    }

    #[test]
    fn create_role_and_source_guards() {
        assert_eq!(normalize_agent_create_role("account_risk"), "account_risk");
        assert_eq!(normalize_agent_create_role("Market Structure"), "market_structure");
        assert_eq!(normalize_agent_create_role("中文角色"), "custom");
        assert!(validate_agent_source_for_save("desic-market-structure", "builtin").is_ok());
        assert!(validate_agent_source_for_save("my-agent", "builtin").is_err());
        assert!(validate_agent_source_for_save("my-agent", "custom").is_ok());
    }
}
