//! Read-only preview parsing for Codex-style agent TOML definitions.
//!
//! Desic never adopts a Codex file directly. This module converts one agent
//! table into a bounded Agent Template draft plus an explicit list of fields
//! that were ignored, so the desktop can show the user exactly what will and
//! will not be imported before anything is saved.

use serde::{Deserialize, Serialize};

/// Maximum instruction characters kept in a preview draft. Matches the Agent
/// Template limit enforced when the draft is actually saved.
pub const MAX_TEMPLATE_INSTRUCTION_CHARS: usize = 4_000;
/// Maximum suggested Skill ids kept in a preview draft.
pub const MAX_TEMPLATE_SKILL_IDS: usize = 24;

const TEMPLATE_PHASES: [&str; 3] = ["primary", "review", "final"];

/// Keys that must never influence Desic behavior, even if a Codex file sets
/// them. They are reported to the user rather than silently dropped.
const REJECTED_KEYS: [&str; 12] = [
    "sandbox",
    "sandbox_mode",
    "sandbox_workspace_write",
    "mcp_servers",
    "mcp",
    "tools",
    "shell",
    "approval_policy",
    "network_access",
    "env",
    "command",
    "cwd",
];

/// A bounded Agent Template draft produced from a Codex agent definition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTemplatePreview {
    pub name: String,
    pub description: String,
    pub instructions: String,
    pub skill_ids: Vec<String>,
    pub phase: String,
    pub model: Option<String>,
    /// Codex keys that were recognized but deliberately not imported.
    pub rejected_fields: Vec<String>,
    /// Human-readable notes about truncation or normalization.
    pub notes: Vec<String>,
}

/// Parses one Codex agent definition into a preview draft.
///
/// `agent_name` selects a named table under `[agents.<name>]`; when omitted the
/// document root is treated as a single agent definition. The result is advisory
/// only: it carries no permission, sandbox, MCP, account, or tool authority.
pub fn preview_codex_agent_template(
    content: &str,
    agent_name: Option<&str>,
) -> Result<CodexTemplatePreview, String> {
    if content.len() > 256 * 1024 {
        return Err("Codex agent 定义超过 256 KiB 预览上限".to_string());
    }
    let document = content
        .parse::<toml::Value>()
        .map_err(|error| format!("Codex agent TOML 语法无效：{error}"))?;
    let table = resolve_agent_table(&document, agent_name)?;

    let mut notes = Vec::new();
    let mut rejected_fields = Vec::new();
    for key in REJECTED_KEYS {
        if table.get(key).is_some() {
            rejected_fields.push(key.to_string());
        }
    }

    let name = bounded_string(table.get("name"), 80)
        .or_else(|| agent_name.map(|value| value.trim().to_string()))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Codex agent 定义缺少可用名称".to_string())?;
    let description = bounded_string(table.get("description"), 200).unwrap_or_default();

    let instructions_source = table
        .get("instructions")
        .or_else(|| table.get("prompt"))
        .or_else(|| table.get("system_prompt"));
    let mut instructions = match instructions_source {
        Some(toml::Value::String(value)) => value.trim().to_string(),
        Some(toml::Value::Array(values)) => values
            .iter()
            .filter_map(toml::Value::as_str)
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Some(_) => return Err("Codex agent 指令必须是字符串或字符串数组".to_string()),
        None => String::new(),
    };
    if instructions.chars().count() > MAX_TEMPLATE_INSTRUCTION_CHARS {
        instructions = instructions
            .chars()
            .take(MAX_TEMPLATE_INSTRUCTION_CHARS)
            .collect();
        notes.push(format!(
            "指令已截断到 {MAX_TEMPLATE_INSTRUCTION_CHARS} 个字符"
        ));
    }

    let mut skill_ids = Vec::new();
    if let Some(values) = table
        .get("skills")
        .or_else(|| table.get("skill_ids"))
        .and_then(toml::Value::as_array)
    {
        for value in values {
            let Some(id) = value.as_str().map(str::trim).filter(|id| !id.is_empty()) else {
                continue;
            };
            if !valid_skill_id(id) {
                return Err(format!("Codex agent 引用的 Skill ID 无效：{id}"));
            }
            if !skill_ids.iter().any(|existing| existing == id) {
                skill_ids.push(id.to_string());
            }
        }
    }
    if skill_ids.len() > MAX_TEMPLATE_SKILL_IDS {
        skill_ids.truncate(MAX_TEMPLATE_SKILL_IDS);
        notes.push(format!("Skill 列表已截断到 {MAX_TEMPLATE_SKILL_IDS} 个"));
    }

    let phase = match bounded_string(table.get("phase"), 16) {
        Some(value) => {
            let normalized = value.to_ascii_lowercase();
            if TEMPLATE_PHASES.contains(&normalized.as_str()) {
                normalized
            } else {
                notes.push(format!("阶段 {value} 不受支持，已回退为 primary"));
                TEMPLATE_PHASES[0].to_string()
            }
        }
        None => TEMPLATE_PHASES[0].to_string(),
    };

    // Only a stable model identifier is previewed. Provider endpoints, keys, and
    // headers are never carried over from a Codex file.
    let model = bounded_string(table.get("model"), 120).filter(|value| !value.is_empty());

    if !rejected_fields.is_empty() {
        notes.push(
            "sandbox、MCP、工具与命令配置不会被导入；Desic 的权限与工具授权保持不变。".to_string(),
        );
    }

    Ok(CodexTemplatePreview {
        name,
        description,
        instructions,
        skill_ids,
        phase,
        model,
        rejected_fields,
        notes,
    })
}

fn resolve_agent_table<'a>(
    document: &'a toml::Value,
    agent_name: Option<&str>,
) -> Result<&'a toml::Table, String> {
    let root = document
        .as_table()
        .ok_or_else(|| "Codex agent 定义必须是 TOML 表".to_string())?;
    let Some(agent_name) = agent_name.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(root);
    };
    root.get("agents")
        .and_then(toml::Value::as_table)
        .and_then(|agents| agents.get(agent_name))
        .and_then(toml::Value::as_table)
        .ok_or_else(|| format!("Codex 定义中找不到 agent：{agent_name}"))
}

fn bounded_string(value: Option<&toml::Value>, limit: usize) -> Option<String> {
    value
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(limit).collect())
}

fn valid_skill_id(value: &str) -> bool {
    value.len() <= 120
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_imports_bounded_fields_and_reports_rejected_configuration() {
        let preview = preview_codex_agent_template(
            r#"
            [agents.research]
            name = "Research desk"
            description = "Multi-source evidence review"
            instructions = ["Check funding basis first.", "Report conflicts explicitly."]
            skills = ["okx-market-intelligence", "okx-market-intelligence"]
            phase = "REVIEW"
            model = "gpt-5-codex"
            sandbox = "workspace-write"
            mcp_servers = { local = { command = "node" } }
            tools = ["shell"]
            "#,
            Some("research"),
        )
        .expect("preview");
        assert_eq!(preview.name, "Research desk");
        assert_eq!(
            preview.instructions,
            "Check funding basis first.\nReport conflicts explicitly."
        );
        assert_eq!(
            preview.skill_ids,
            vec!["okx-market-intelligence".to_string()]
        );
        assert_eq!(preview.phase, "review");
        assert_eq!(preview.model.as_deref(), Some("gpt-5-codex"));
        assert!(preview.rejected_fields.contains(&"sandbox".to_string()));
        assert!(preview.rejected_fields.contains(&"mcp_servers".to_string()));
        assert!(preview.rejected_fields.contains(&"tools".to_string()));
        assert!(preview.notes.iter().any(|note| note.contains("sandbox")));
    }

    #[test]
    fn preview_truncates_oversized_instructions_and_unknown_phase() {
        let long = "x".repeat(MAX_TEMPLATE_INSTRUCTION_CHARS + 50);
        let preview = preview_codex_agent_template(
            &format!("name = \"solo\"\nphase = \"execute\"\ninstructions = \"\"\"{long}\"\"\"\n"),
            None,
        )
        .expect("preview");
        assert_eq!(
            preview.instructions.chars().count(),
            MAX_TEMPLATE_INSTRUCTION_CHARS
        );
        assert_eq!(preview.phase, "primary");
        assert!(preview.notes.iter().any(|note| note.contains("截断")));
        assert!(preview.notes.iter().any(|note| note.contains("primary")));
    }

    #[test]
    fn preview_rejects_missing_agent_and_invalid_skill_ids() {
        assert!(preview_codex_agent_template("name = \"a\"\n", Some("missing")).is_err());
        assert!(
            preview_codex_agent_template("name = \"a\"\nskills = [\"../escape\"]\n", None).is_err()
        );
        assert!(preview_codex_agent_template("name = \"a\"\ninstructions = 5\n", None).is_err());
    }
}
