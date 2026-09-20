//! Agent 库（契约 C1/C2/C3）。
//!
//! 单一实现：frontmatter 解析 / 校验 / 渲染 / 内置定义 / 勾选名单规范化 /
//! 旧配置迁移计划。命令层（`src/agent_library.rs`）与工具层（`lib.rs`
//! `execute_ai_tool`）必须共用这里的函数，不得各自重复实现校验。
//!
//! 说明（写入代码注释的契约要求）：`scopes` 只是**意图声明**，真正的权限边界在
//! Rust `authorize_ai_tool`（账户绑定、Skill 门槛、`agent_role` 只读、
//! `tool_allowlist`）。固定运行时外壳由侧车无条件前置拼接，AGENTS.md 无法覆盖或
//! 关闭；这里不做文本对抗式过滤。
//!
//! 内置正文的真相源是 `docs/agent-library-content-pack.md` §1（`builtin_bodies.rs`
//! 由该内容包机械生成）。改正文必须改内容包并重新生成，不要手改 `builtin_bodies.rs`。

use crate::builtin_bodies;
use crate::AiProfileSubAgent;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// `^[a-z0-9][a-z0-9-]{1,47}$`
pub const AGENT_ID_PATTERN_HINT: &str = "^[a-z0-9][a-z0-9-]{1,47}$";
/// `^[a-z][a-z0-9_]{0,31}$`
pub const AGENT_ROLE_PATTERN_HINT: &str = "^[a-z][a-z0-9_]{0,31}$";

pub const AGENT_NAME_MIN_CHARS: usize = 1;
pub const AGENT_NAME_MAX_CHARS: usize = 40;
pub const AGENT_MAX_FILE_BYTES: usize = 200 * 1024;
pub const AGENT_SUMMARY_MAX_CHARS: usize = 200;

pub const AGENT_FILE_NAME: &str = "AGENTS.md";
pub const AGENT_REFERENCES_DIR: &str = "references";

pub const AGENT_ENVELOPE_STANDARD: &str = "standard";
pub const AGENT_ENVELOPE_RISK: &str = "risk";
pub const AGENT_ENVELOPES: [&str; 2] = [AGENT_ENVELOPE_STANDARD, AGENT_ENVELOPE_RISK];

pub const AGENT_SCOPE_MARKET: &str = "market";
pub const AGENT_SCOPE_DERIVATIVES: &str = "derivatives";
pub const AGENT_SCOPE_INTELLIGENCE: &str = "intelligence";
pub const AGENT_SCOPE_ACCOUNT: &str = "account";
pub const AGENT_SCOPE_HISTORY: &str = "history";
pub const AGENT_SCOPES: [&str; 5] = [
    AGENT_SCOPE_MARKET,
    AGENT_SCOPE_DERIVATIVES,
    AGENT_SCOPE_INTELLIGENCE,
    AGENT_SCOPE_ACCOUNT,
    AGENT_SCOPE_HISTORY,
];

pub const AGENT_SOURCE_BUILTIN: &str = "builtin";
pub const AGENT_SOURCE_CUSTOM: &str = "custom";
pub const AGENT_SOURCE_AI: &str = "ai";
pub const AGENT_SOURCES: [&str; 3] = [
    AGENT_SOURCE_BUILTIN,
    AGENT_SOURCE_CUSTOM,
    AGENT_SOURCE_AI,
];

/// 推荐 role 枚举（C2）。校验只强制正则，`custom` 是合法兜底值。
pub const AGENT_ROLE_ENUM: [&str; 12] = [
    // C20 流程角色（默认启用集）
    "data_digest",
    "account_state",
    "decision_proposal",
    "contrarian",
    // C20 起的历史角色（文件保留、可手动勾选）
    "market_structure",
    "order_flow_liquidity",
    "derivatives_positioning",
    "account_risk",
    "intelligence_flow",
    "smart_money",
    "historical_analogy",
    "custom",
];

/// 内置 Agent 的 `createdAt` 常量：内置指纹必须稳定，不能随安装时间变化。
pub const AGENT_BUILTIN_CREATED_AT_MS: i64 = 1_760_000_000_000;

pub const AGENT_BODY_SECTION_IDENTITY: &str = "## 身份";
pub const AGENT_BODY_SECTION_DUTIES: &str = "## 职责";
pub const AGENT_BODY_SECTION_METHOD: &str = "## 方法与证据要求";
pub const AGENT_BODY_SECTION_OUTPUT: &str = "## 输出偏好";
pub const AGENT_BODY_SECTION_GAP: &str = "## 数据缺口处理";

/// 解析结果（C3）。`path` 为落盘位置，不参与序列化；`created_at` 用于
/// frontmatter 往返渲染（内置指纹依赖它的稳定性）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiAgentDefinition {
    pub id: String,
    pub name: String,
    pub role: String,
    pub envelope: String,
    pub skills: Vec<String>,
    pub requires_account: bool,
    pub source: String,
    pub version: i64,
    pub created_at: i64,
    pub summary: String,
    pub body: String,
    /// C20：内置历史角色（默认不启用；文件保留、可手动勾选）。
    pub deprecated: bool,
    /// C15：旧文件里出现过已废弃的 `scopes` 键（忽略不报错，仅提示用户可删除）。
    pub scopes_deprecated: bool,
    pub path: PathBuf,
}

/// 列表行（C3）。不返回 body。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentSummary {
    pub id: String,
    pub name: String,
    pub role: String,
    pub envelope: String,
    pub skills: Vec<String>,
    pub requires_account: bool,
    pub source: String,
    pub version: i64,
    /// C20：内置历史角色（UI 标灰、默认不启用、全选内置时跳过）。
    #[serde(default)]
    pub deprecated: bool,
    /// C15：旧文件里出现过已废弃的 `scopes` 键（UI 显示一行灰字提示即可）。
    #[serde(default)]
    pub scopes_deprecated: bool,
    pub updated_at: i64,
    /// 勾选该 Agent 的 Profile id 列表（数据库 JSON 列统计）。
    pub enabled_by_profiles: Vec<String>,
    /// 本机未激活、缺失的 Skill id（只提示，不报错、不静默丢弃）。
    pub missing_skills: Vec<String>,
    /// 该 Agent 勾选它的 Profile 中至少一个未绑定账户（仅 requiresAccount 有意义）。
    pub missing_account: bool,
    /// 内置文件被用户改动（指纹与内置渲染不一致）。
    pub modified: bool,
}

/// 详情（C3）：summary 字段 + 完整 AGENTS.md 文本。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentDetail {
    #[serde(flatten)]
    pub summary: AiAgentSummary,
    pub content: String,
}

impl AiAgentDefinition {
    /// 由正文派生的目录摘要（C4 使用）。
    pub fn refresh_summary(&mut self) {
        self.summary = summarize_agent_body(&self.body);
    }

    pub fn to_summary(&self, updated_at: i64) -> AiAgentSummary {
        AiAgentSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            role: self.role.clone(),
            envelope: self.envelope.clone(),
            skills: self.skills.clone(),
            requires_account: self.requires_account,
            source: self.source.clone(),
            version: self.version,
            deprecated: self.deprecated,
            scopes_deprecated: self.scopes_deprecated,
            updated_at,
            enabled_by_profiles: Vec::new(),
            missing_skills: Vec::new(),
            missing_account: false,
            modified: false,
        }
    }
}

// ===== 校验（C2）=====

pub fn is_valid_agent_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if !(2..=48).contains(&bytes.len()) {
        return false;
    }
    let first = bytes[0];
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

pub fn is_valid_agent_role(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 32 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
}

pub fn is_recommended_agent_role(value: &str) -> bool {
    AGENT_ROLE_ENUM.contains(&value)
}

pub fn normalize_agent_envelope(value: Option<&str>) -> String {
    match value.map(str::trim).unwrap_or_default().to_ascii_lowercase().as_str() {
        AGENT_ENVELOPE_RISK => AGENT_ENVELOPE_RISK.to_string(),
        _ => AGENT_ENVELOPE_STANDARD.to_string(),
    }
}

/// 严格解析 frontmatter / 工具入参里的 `envelope`（C2 / 验收手册 B7）：
/// - 未提供或空白 → `Ok(None)`（由调用方按 `standard` 兜底）；
/// - 提供且是 `standard` / `risk` → `Ok(Some(...))`；
/// - 提供但不在白名单（如 `"none"`）→ **Err**，不得静默降级成 `standard`。
pub fn parse_agent_envelope(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = value.map(str::trim).filter(|item| !item.is_empty()) else {
        return Ok(None);
    };
    match raw.to_ascii_lowercase().as_str() {
        AGENT_ENVELOPE_STANDARD => Ok(Some(AGENT_ENVELOPE_STANDARD.to_string())),
        AGENT_ENVELOPE_RISK => Ok(Some(AGENT_ENVELOPE_RISK.to_string())),
        _ => Err(format!(
            "Agent envelope 非法：{raw}（允许 {}）",
            AGENT_ENVELOPES.join("|")
        )),
    }
}

/// 最终 envelope 取更严者（契约 C15.1）：声明 `risk` **或** `role == account_risk`
/// → `risk`；否则 `standard`。C15 起不再由 `scopes` 推导（字段已移除）。
pub fn resolve_agent_envelope(envelope: Option<&str>, role: &str) -> String {
    let declared = normalize_agent_envelope(envelope);
    if declared == AGENT_ENVELOPE_RISK || role.trim() == "account_risk" {
        AGENT_ENVELOPE_RISK.to_string()
    } else {
        AGENT_ENVELOPE_STANDARD.to_string()
    }
}

pub fn normalize_agent_source(value: Option<&str>) -> String {
    match value.map(str::trim).unwrap_or_default().to_ascii_lowercase().as_str() {
        AGENT_SOURCE_BUILTIN => AGENT_SOURCE_BUILTIN.to_string(),
        AGENT_SOURCE_AI => AGENT_SOURCE_AI.to_string(),
        _ => AGENT_SOURCE_CUSTOM.to_string(),
    }
}

/// 正文非空 + 单文件 ≤ 200KB（C2）。
pub fn validate_agent_file(content: &str) -> Result<(), String> {
    if content.trim().is_empty() {
        return Err("Agent 文件内容不能为空".to_string());
    }
    if content.len() > AGENT_MAX_FILE_BYTES {
        return Err(format!(
            "Agent 文件超过 {}KB 上限",
            AGENT_MAX_FILE_BYTES / 1024
        ));
    }
    Ok(())
}

/// `references/*.md` 相对路径：禁止绝对路径与 `..`（C2）。
pub fn validate_agent_reference_path(value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Agent 引用文件路径不能为空".to_string());
    }
    if trimmed.len() > 180 {
        return Err("Agent 引用文件路径过长".to_string());
    }
    if trimmed.contains('\\') || trimmed.contains('\0') {
        return Err(format!("Agent 引用文件路径不合法：{trimmed}"));
    }
    let candidate = std::path::Path::new(trimmed);
    if candidate.is_absolute() {
        return Err(format!("Agent 引用文件必须是相对路径：{trimmed}"));
    }
    // `Path::components` 会静默丢弃 `.`，因此先在原始文本上拒绝点前缀与空段。
    if trimmed
        .split('/')
        .any(|segment| {
            segment.is_empty()
                || segment == ".."
                || segment.starts_with('.')
                || segment.contains(':')
        })
    {
        return Err(format!("Agent 引用文件路径不合法：{trimmed}"));
    }
    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            std::path::Component::Normal(part) => {
                let text = part
                    .to_str()
                    .ok_or_else(|| format!("Agent 引用文件路径不合法：{trimmed}"))?;
                if text.starts_with('.') {
                    return Err(format!("Agent 引用文件路径不合法：{trimmed}"));
                }
                normalized.push(text);
            }
            _ => return Err(format!("Agent 引用文件路径不合法：{trimmed}")),
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err(format!("Agent 引用文件路径不合法：{trimmed}"));
    }
    Ok(normalized)
}

/// 完整校验一个已解析的定义（不含目录名一致性，那是落盘层的事）。
pub fn validate_agent_definition(def: &AiAgentDefinition) -> Result<(), String> {
    if !is_valid_agent_id(&def.id) {
        return Err(format!(
            "Agent id 不合法：{}；必须匹配 {}",
            def.id, AGENT_ID_PATTERN_HINT
        ));
    }
    let name_len = def.name.trim().chars().count();
    if !(AGENT_NAME_MIN_CHARS..=AGENT_NAME_MAX_CHARS).contains(&name_len) {
        return Err(format!(
            "Agent 名称长度必须为 {}-{} 个字符：{}",
            AGENT_NAME_MIN_CHARS, AGENT_NAME_MAX_CHARS, def.id
        ));
    }
    if !is_valid_agent_role(&def.role) {
        return Err(format!(
            "Agent role 不合法：{}；必须匹配 {}",
            def.role, AGENT_ROLE_PATTERN_HINT
        ));
    }
    if !AGENT_ENVELOPES.contains(&def.envelope.as_str()) {
        return Err(format!("Agent envelope 必须是 standard 或 risk：{}", def.id));
    }
    if !AGENT_SOURCES.contains(&def.source.as_str()) {
        return Err(format!(
            "Agent source 必须是 builtin/custom/ai：{}",
            def.id
        ));
    }
    if def.version < 1 {
        return Err(format!("Agent version 必须 ≥ 1：{}", def.id));
    }
    if def.body.trim().is_empty() {
        return Err(format!("Agent 正文不能为空：{}", def.id));
    }
    Ok(())
}

// ===== frontmatter 解析 / 渲染 =====

/// 解析 `AGENTS.md`。容错规则（C2）：
/// - 未知 frontmatter 键忽略；
/// - `envelope` 缺省 `standard`；`createdAt` 缺省当前毫秒；`version` 缺省 1；
/// - `scopes` / `skills` 支持 `[a, b]` 内联列表与 `- item` 块列表。
pub fn parse_agent_markdown(content: &str) -> Result<AiAgentDefinition, String> {
    parse_agent_markdown_internal(content, true)
}

/// 草稿容错解析（C9 / 内容包 §2.4）：只要求结构合法，不强制 id / name / role；
/// 调用方必须补全 id 并重新走 `validate_agent_definition` 后才能落盘。
pub fn parse_agent_draft_markdown(content: &str) -> Result<AiAgentDefinition, String> {
    parse_agent_markdown_internal(content, false)
}

fn parse_agent_markdown_internal(
    content: &str,
    strict: bool,
) -> Result<AiAgentDefinition, String> {
    validate_agent_file(content)?;
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let normalized = normalized.trim_start_matches('\u{feff}');
    let all_lines = normalized.lines().collect::<Vec<_>>();
    let Some(first) = all_lines.first() else {
        return Err("Agent 文件缺少 frontmatter".to_string());
    };
    if first.trim() != "---" {
        return Err("Agent 文件必须以 frontmatter 分隔符开头".to_string());
    }
    let mut header: Vec<(String, String, Vec<String>)> = Vec::new();
    let mut body_start = None;
    let mut pending_key: Option<usize> = None;
    for (index, line) in all_lines.iter().enumerate().skip(1) {
        if line.trim() == "---" {
            body_start = Some(index + 1);
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(item) = trimmed.strip_prefix("- ") {
            match pending_key.and_then(|key_index| header.get_mut(key_index)) {
                Some(entry) => entry.2.push(parse_yaml_scalar(item)),
                None => return Err(format!("Agent frontmatter 列表项缺少键：{trimmed}")),
            }
            continue;
        }
        // 续行（块列表）以缩进开头；其余情况要求 `key: value`。
        if line.starts_with(' ') || line.starts_with('\t') {
            if pending_key.is_some() {
                continue;
            }
            return Err(format!("Agent frontmatter 行不合法：{trimmed}"));
        }
        let Some((raw_key, raw_value)) = trimmed.split_once(':') else {
            return Err(format!("Agent frontmatter 行不合法：{trimmed}"));
        };
        let key = raw_key.trim().to_ascii_lowercase();
        let value = raw_value.trim();
        let mut items = Vec::new();
        if value.starts_with('[') {
            let inner = value
                .trim_start_matches('[')
                .trim_end_matches(']')
                .trim();
            if !inner.is_empty() {
                items = inner
                    .split(',')
                    .map(|item| parse_yaml_scalar(item.trim()))
                    .filter(|item| !item.is_empty())
                    .collect();
            }
        }
        header.push((key, value.to_string(), items));
        pending_key = Some(header.len() - 1);
    }
    let Some(body_start) = body_start else {
        return Err("Agent frontmatter 缺少结束分隔符".to_string());
    };
    let body = all_lines[body_start.min(all_lines.len())..]
        .join("\n")
        .trim()
        .to_string();
    if body.is_empty() {
        return Err("Agent 正文不能为空".to_string());
    }

    let value_of = |keys: &[&str]| -> Option<String> {
        header
            .iter()
            .find(|(key, _, _)| keys.contains(&key.as_str()))
            .map(|(_, value, _)| value.clone())
    };
    let list_of = |keys: &[&str]| -> Vec<String> {
        header
            .iter()
            .find(|(key, _, _)| keys.contains(&key.as_str()))
            .map(|(_, value, items)| {
                // 显式内联列表（含 `[]`）与块列表都按条目读取；`[]` 表示空列表，
                // **不能**落进下面 "a, b" 的逗号回退分支（否则会解析出字面量 "[]"）。
                if value.trim().starts_with('[') || !items.is_empty() {
                    return items.clone();
                }
                // 宽松写法：`key: a, b` 无方括号。
                value
                    .split(',')
                    .map(|item| parse_yaml_scalar(item.trim()))
                    .filter(|item| !item.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    };

    let id = value_of(&["id"]).map(|value| parse_yaml_scalar(&value)).unwrap_or_default();
    let name = value_of(&["name"]).map(|value| parse_yaml_scalar(&value)).unwrap_or_default();
    let role = value_of(&["role"]).map(|value| parse_yaml_scalar(&value)).unwrap_or_default();
    // 提供但非法的 envelope 必须报错（不能静默降级）；缺失才默认 standard。
    let raw_envelope = value_of(&["envelope"]).map(|value| parse_yaml_scalar(&value));
    let declared_envelope = parse_agent_envelope(raw_envelope.as_deref())?;
    // C15：`scopes` 已废弃——出现即忽略（不报错、不写入新文件），只标记提示。
    let scopes_deprecated = header.iter().any(|(key, _, _)| key == "scopes");
    let skills = normalize_agent_skills(list_of(&["skills"]));
    let envelope = resolve_agent_envelope(declared_envelope.as_deref(), &role);
    let requires_account = value_of(&["requiresaccount", "requires_account"])
        .map(|value| parse_yaml_bool(&parse_yaml_scalar(&value)))
        .unwrap_or(false);
    let source = normalize_agent_source(
        value_of(&["source"])
            .map(|value| parse_yaml_scalar(&value))
            .as_deref(),
    );
    let version = value_of(&["version"])
        .map(|value| parse_yaml_scalar(&value))
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(1);
    let created_at = value_of(&["createdat", "created_at"])
        .map(|value| parse_yaml_scalar(&value))
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);

    let mut def = AiAgentDefinition {
        id,
        name,
        role,
        envelope,
        skills,
        requires_account,
        source,
        version,
        created_at,
        summary: String::new(),
        body,
        deprecated: false,
        scopes_deprecated,
        path: PathBuf::new(),
    };
    def.refresh_summary();
    if strict {
        validate_agent_definition(&def)?;
    }
    Ok(def)
}

/// 渲染 `AGENTS.md`：frontmatter 由 Rust 生成，正文原样写入。
pub fn render_agent_markdown(def: &AiAgentDefinition, body: &str) -> String {
    let body = body.trim();
    let created_at = if def.created_at > 0 {
        def.created_at
    } else {
        current_time_ms()
    };
    let mut rendered = String::new();
    rendered.push_str("---\n");
    rendered.push_str(&format!("id: {}\n", def.id.trim()));
    rendered.push_str(&format!("name: {}\n", yaml_scalar(def.name.trim())));
    rendered.push_str(&format!("role: {}\n", def.role.trim()));
    rendered.push_str(&format!("envelope: {}\n", def.envelope.trim()));
    // C15：frontmatter 不再有 `scopes`。
    rendered.push_str(&format!("skills: {}\n", yaml_inline_list(&def.skills)));
    rendered.push_str(&format!(
        "requiresAccount: {}\n",
        if def.requires_account { "true" } else { "false" }
    ));
    rendered.push_str(&format!("source: {}\n", def.source.trim()));
    rendered.push_str(&format!("version: {}\n", def.version.max(1)));
    rendered.push_str(&format!("createdAt: {created_at}\n"));
    rendered.push_str("---\n");
    rendered.push_str(body);
    rendered.push('\n');
    rendered
}

fn yaml_inline_list(items: &[String]) -> String {
    format!(
        "[{}]",
        items
            .iter()
            .map(|item| item.trim())
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/// YAML 标量：只在必要时加引号，保证 parse(render(x)) == x。
fn yaml_scalar(value: &str) -> String {
    let needs_quotes = value.is_empty()
        || value != value.trim()
        || value
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '#' | ':' | '[' | ']' | '{' | '}' | ',' | '"' | '\'' | '&' | '*' | '!' | '|' | '>' | '%' | '@' | '`'));
    if !needs_quotes {
        return value.to_string();
    }
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

fn parse_yaml_scalar(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        let inner = &trimmed[1..trimmed.len() - 1];
        let mut result = String::with_capacity(inner.len());
        let mut chars = inner.chars();
        while let Some(ch) = chars.next() {
            if ch == '\\' {
                match chars.next() {
                    Some('n') => result.push('\n'),
                    Some('t') => result.push('\t'),
                    Some(other) => result.push(other),
                    None => {}
                }
            } else {
                result.push(ch);
            }
        }
        return result;
    }
    if trimmed.len() >= 2 && trimmed.starts_with('\'') && trimmed.ends_with('\'') {
        return trimmed[1..trimmed.len() - 1].replace("''", "'");
    }
    // 未加引号时的行尾注释（` #` 之前为值）。
    match trimmed.find(" #") {
        Some(index) => trimmed[..index].trim().to_string(),
        None => trimmed.to_string(),
    }
}

fn parse_yaml_bool(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "true" | "yes" | "on" | "1"
    )
}

fn normalize_agent_skills(items: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    for item in items {
        let skill = item.trim().to_string();
        if skill.is_empty() || !seen.insert(skill.clone()) {
            continue;
        }
        result.push(skill);
    }
    result
}

/// 校验 `scopes` 原始输入（C2 / 验收手册 B7）：出现白名单外的值 → Err 并列出非法值。
/// 空数组 / 缺失**不是错误**（C2：空 = 全部只读工具）。
pub fn validate_agent_scope_values(values: &[String]) -> Result<(), String> {
    let invalid = values
        .iter()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty() && !AGENT_SCOPES.contains(&value.as_str()))
        .fold(Vec::<String>::new(), |mut acc, value| {
            if !acc.contains(&value) {
                acc.push(value);
            }
            acc
        });
    if invalid.is_empty() {
        return Ok(());
    }
    Err(format!(
        "Agent 数据范围非法：{}（允许 {}）",
        invalid.join("、"),
        AGENT_SCOPES.join("|")
    ))
}

/// 目录名必须等于 frontmatter id（C2）。
pub fn validate_agent_directory_id(directory_id: &str, def: &AiAgentDefinition) -> Result<(), String> {
    let directory_id = directory_id.trim();
    if directory_id != def.id {
        return Err(format!(
            "Agent id 与目录名不一致：frontmatter={}，目录={directory_id}",
            def.id
        ));
    }
    Ok(())
}

// ===== 摘要 =====

/// 目录摘要（C4）：优先取 `## 职责` 段首段的首句（契约 C4 示例与内容包 §1.9
/// 核对表都要求「正文『职责』段首句 = AUTO_PROFILE_AGENTS.responsibility 原文」）；
/// 没有职责段时跳过标题行与空行取正文第一段有意义文字。
/// 结果单行化并截到 200 字符。
pub fn summarize_agent_body(body: &str) -> String {
    if let Some(section) = section_first_paragraph(body, AGENT_BODY_SECTION_DUTIES) {
        return collapse_to_chars(&single_line(&first_sentence(&section)), AGENT_SUMMARY_MAX_CHARS);
    }
    if let Some(section) = section_first_paragraph(body, "## Responsibility") {
        return collapse_to_chars(&single_line(&first_sentence(&section)), AGENT_SUMMARY_MAX_CHARS);
    }
    let mut paragraph: Vec<&str> = Vec::new();
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if !paragraph.is_empty() {
                break;
            }
            continue;
        }
        if paragraph.is_empty() && trimmed.starts_with('#') {
            continue;
        }
        paragraph.push(trimmed);
    }
    collapse_to_chars(
        &single_line(&first_sentence(&paragraph.join(" "))),
        AGENT_SUMMARY_MAX_CHARS,
    )
}

/// 首句（含句末标点）；没有句末标点时返回整段。
/// 注意：`；` 不是句末（`desic-account-risk` 的 responsibility 原文内部就含 `；`）。
fn first_sentence(value: &str) -> String {
    let trimmed = value.trim();
    let mut end = trimmed.len();
    for (index, ch) in trimmed.char_indices() {
        if matches!(ch, '。' | '！' | '？' | '\n') {
            end = index + ch.len_utf8();
            break;
        }
    }
    trimmed[..end].trim().to_string()
}

fn section_first_paragraph(body: &str, heading: &str) -> Option<String> {
    let mut collected: Vec<&str> = Vec::new();
    let mut inside = false;
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            if inside {
                break;
            }
            inside = trimmed == heading;
            continue;
        }
        if !inside {
            continue;
        }
        if trimmed.is_empty() {
            if !collected.is_empty() {
                break;
            }
            continue;
        }
        collected.push(trimmed);
    }
    if collected.is_empty() {
        None
    } else {
        Some(collected.join(" "))
    }
}

fn single_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn collapse_to_chars(value: &str, limit: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    trimmed.chars().take(limit).collect()
}

// ===== 正文骨架（内置 / 迁移 / 工具创建共用）=====

pub struct AgentBodyParts<'a> {
    pub name: &'a str,
    pub role: &'a str,
    pub responsibility: &'a str,
    pub envelope: &'a str,
}

/// 五段骨架正文（C2 / C6）。
pub fn build_agent_body(parts: AgentBodyParts<'_>) -> String {
    let risk_rules = if parts.envelope == AGENT_ENVELOPE_RISK {
        "\n- 风险口径只使用 account.readRisk、trade.evaluatePlan 或 trade.precheck 返回的结构化字段，不自行手算张数、名义敞口、保证金与止损风险。\n- 涉及开仓可行性时必须以 trade.precheck 的结构化结果为准，并原样引用其中字段，不发明风险阈值。"
    } else {
        ""
    };
    format!(
        "{identity}\n\n{duties}\n\n{method}\n\n{output}\n\n{gap}\n",
        identity = AGENT_BODY_SECTION_IDENTITY,
        duties = AGENT_BODY_SECTION_DUTIES,
        method = AGENT_BODY_SECTION_METHOD,
        output = AGENT_BODY_SECTION_OUTPUT,
        gap = AGENT_BODY_SECTION_GAP,
    )
    .replacen(
        AGENT_BODY_SECTION_IDENTITY,
        &format!(
            "{AGENT_BODY_SECTION_IDENTITY}\n{} 是只读分析专家，角色标识 {}。",
            parts.name.trim(),
            parts.role.trim()
        ),
        1,
    )
    .replacen(
        AGENT_BODY_SECTION_DUTIES,
        &format!("{AGENT_BODY_SECTION_DUTIES}\n{}", parts.responsibility.trim()),
        1,
    )
    .replacen(
        AGENT_BODY_SECTION_METHOD,
        &format!(
            "{AGENT_BODY_SECTION_METHOD}\n- 只使用本次会话可用的只读工具取证，每条关键证据标注来源与观测时间（工具返回的 13 位毫秒时间戳或快照时间）。\n- 区分直接观测、派生计算、推断与未知；不用较新的快照改写更早的计算而不说明变化。{risk_rules}"
        ),
        1,
    )
    .replacen(
        AGENT_BODY_SECTION_OUTPUT,
        &format!(
            "{AGENT_BODY_SECTION_OUTPUT}\n- 先给结论，再给支撑证据、失效条件与反例；不重复其他专家的正向结论。\n- 明确列出证据冲突、数据缺口与不确定性，不使用无法验证的措辞。\n- 报告是主 Agent 的只读证据，不替主 Agent 做最终交易决策，也不直接下单。"
        ),
        1,
    )
    .replacen(
        AGENT_BODY_SECTION_GAP,
        &format!(
            "{AGENT_BODY_SECTION_GAP}\n- 缺数据时说明缺失项、影响范围、可替代证据与下一次复核条件，不编造数值。\n- 账户类证据不可用（未绑定账户）或 Skill 未激活时，明确标注对应结论不可用。"
        ),
        1,
    )
}

// ===== 内置 Agent（C1）=====

/// 兜底正文骨架（内容包 §2.5，逐字）。`ai_agent_generate` 的 JSON 解析失败路径与
/// `agent.create` 工具共用这一份常量，避免两处文案漂移（内容包 §5.8）。
pub fn render_agent_skeleton(responsibility: &str) -> String {
    let responsibility = responsibility.trim();
    format!(
        "{identity}\n待补充：写明这个 Agent 是谁、只看哪类证据、不做哪些事。\n\n{duties}\n{}\n\n{method}\n待补充：写明需要的证据类型、每条结论要附的工具记录 ID 与观测时间，以及事实、推断、冲突、缺口的区分方式。\n\n{output}\nMarkdown 或散文自由撰写；如需结构化摘要可附 JSON，但不是必须。\n\n{gap}\n待补充：写明证据不可用时的降级表述，不编造数值。\n",
        if responsibility.is_empty() {
            "待补充：写明这个 Agent 的职责范围。"
        } else {
            responsibility
        },
        identity = AGENT_BODY_SECTION_IDENTITY,
        duties = AGENT_BODY_SECTION_DUTIES,
        method = AGENT_BODY_SECTION_METHOD,
        output = AGENT_BODY_SECTION_OUTPUT,
        gap = AGENT_BODY_SECTION_GAP,
    )
}

/// 补齐五段骨架：缺少的段落按骨架顺序补 `待补充` 句（内容包 §2.4 第 3 条）。
pub fn complete_agent_body_sections(body: &str) -> (String, Vec<String>) {
    let mut missing = Vec::new();
    for section in [
        AGENT_BODY_SECTION_IDENTITY,
        AGENT_BODY_SECTION_DUTIES,
        AGENT_BODY_SECTION_METHOD,
        AGENT_BODY_SECTION_OUTPUT,
        AGENT_BODY_SECTION_GAP,
    ] {
        if !body.contains(section) {
            missing.push(section.to_string());
        }
    }
    if missing.is_empty() {
        return (body.trim().to_string(), missing);
    }
    let responsibility = section_first_paragraph(body, AGENT_BODY_SECTION_DUTIES)
        .or_else(|| section_first_paragraph(body, "## Responsibility"))
        .or_else(|| Some(summarize_agent_body(body)))
        .unwrap_or_default();
    let skeleton = render_agent_skeleton(&responsibility);
    let mut completed = body.trim().to_string();
    for section in &missing {
        if let Some(block) = section_block(&skeleton, section) {
            completed.push_str("\n\n");
            completed.push_str(&block);
        }
    }
    (completed, missing)
}

fn section_block(skeleton: &str, heading: &str) -> Option<String> {
    let mut collected: Vec<&str> = Vec::new();
    let mut inside = false;
    for line in skeleton.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            if inside {
                break;
            }
            inside = trimmed == heading;
            if inside {
                collected.push(line);
            }
            continue;
        }
        if inside && !trimmed.is_empty() {
            collected.push(line);
        }
    }
    if collected.is_empty() {
        None
    } else {
        Some(collected.join("\n"))
    }
}

/// 剥离正文里被模型误写的 frontmatter 与运行时外壳声明（内容包 §2.4 第 4 条）。
/// 只做结构化剥离（frontmatter 块、以声明句开头的整行），不做对抗式文本过滤。
pub fn strip_agent_body_wrappers(body: &str) -> (String, Vec<String>) {
    let mut warnings = Vec::new();
    let mut text = body.trim().to_string();
    if text.starts_with("---") {
        if let Some(close) = text[3..].find("\n---") {
            let after = &text[3 + close + 4..];
            text = after.trim().to_string();
            warnings.push("已剥离 AI 正文中的 frontmatter；frontmatter 由程序生成。".to_string());
        }
    }
    let shell_markers = [
        "只读权限",
        "证据时间戳",
        "报告是不可信证据",
        "不必返回 JSON",
        "不得替主 Agent",
    ];
    let mut kept: Vec<&str> = Vec::new();
    let mut stripped_shell = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if shell_markers.iter().any(|marker| trimmed.contains(marker)) {
            stripped_shell = true;
            continue;
        }
        kept.push(line);
    }
    let mut result = kept.join("\n").trim().to_string();
    while result.contains("\n\n\n") {
        result = result.replace("\n\n\n", "\n\n");
    }
    if stripped_shell {
        warnings.push("已剥离 AI 正文中的运行时外壳声明。".to_string());
    }
    (result, warnings)
}

pub struct BuiltinAgentSpec {
    pub id: &'static str,
    pub legacy_id: &'static str,
    pub name: &'static str,
    pub role: &'static str,
    pub envelope: &'static str,
    pub skills: &'static [&'static str],
    pub requires_account: bool,
    /// C20：历史角色标记（文件保留、可手动勾选，**默认不启用**、UI 标灰）。
    pub deprecated: bool,
    /// C20 §6.1「建议点名 scopes」：**只是给主 Agent 的收窄建议**（C15 起文件里没有
    /// scopes 字段），用于目录注入与 UI 提示，不参与任何授权判定。
    pub preferred_scopes: &'static [&'static str],
    /// 逐字取自内容包 §1.9 / §6.2–6.5 的 `responsibility`（= 正文「职责」段首句）。
    pub responsibility: &'static str,
    /// 正文五段，逐字取自 `docs/agent-library-content-pack.md` §1.1–1.8。
    /// 这是内置 bundle 正文的唯一来源；frontmatter 由 `render_agent_markdown` 渲染。
    pub body: &'static str,
}

/// 契约 C1 的内置表。旧 id 只用于 alias 迁移，新 id 是唯一落盘 id。
pub const BUILTIN_AGENT_SPECS: [BuiltinAgentSpec; 11] = [
    BuiltinAgentSpec {
        id: "desic-market-structure",
        legacy_id: "auto-market-structure",
        name: "市场结构",
        role: "market_structure",
        envelope: AGENT_ENVELOPE_STANDARD,
        skills: &[],
        requires_account: false,
        deprecated: true,
        preferred_scopes: &["market", "derivatives"],
        responsibility: "检查多周期价格结构、趋势、波动、成交、盘口和关键失效位，明确事实与推断。",
        body: builtin_bodies::BODY_MARKET_STRUCTURE,
    },
    BuiltinAgentSpec {
        id: "desic-order-flow-liquidity",
        legacy_id: "auto-order-flow-liquidity",
        name: "订单流与流动性",
        role: "order_flow_liquidity",
        envelope: AGENT_ENVELOPE_STANDARD,
        skills: &[],
        requires_account: false,
        deprecated: true,
        preferred_scopes: &["market"],
        responsibility: "检查盘口深度、买卖价差、逐笔成交、主动买卖和流动性缺口，识别短时冲击与滑点风险。",
        body: builtin_bodies::BODY_ORDER_FLOW_LIQUIDITY,
    },
    BuiltinAgentSpec {
        id: "desic-derivatives-positioning",
        legacy_id: "auto-derivatives-positioning",
        name: "衍生品仓位",
        role: "derivatives_positioning",
        envelope: AGENT_ENVELOPE_STANDARD,
        skills: &[],
        requires_account: false,
        deprecated: true,
        preferred_scopes: &["derivatives", "market"],
        responsibility: "检查资金费率、基差、持仓拥挤、爆仓样本和仓位变化，判断杠杆方向及挤压风险。",
        body: builtin_bodies::BODY_DERIVATIVES_POSITIONING,
    },
    BuiltinAgentSpec {
        id: "desic-account-risk",
        legacy_id: "auto-account-risk",
        name: "账户风险",
        role: "account_risk",
        envelope: AGENT_ENVELOPE_RISK,
        skills: &[],
        requires_account: true,
        deprecated: true,
        preferred_scopes: &["account", "history", "market"],
        responsibility: "检查仓位、余额、保证金、挂单、集中度与历史相似交易；风险结论只能收紧或否决。",
        body: builtin_bodies::BODY_ACCOUNT_RISK,
    },
    BuiltinAgentSpec {
        id: "desic-intelligence-flow",
        legacy_id: "auto-intelligence-flow",
        name: "新闻与宏观",
        role: "intelligence_flow",
        envelope: AGENT_ENVELOPE_STANDARD,
        skills: &["okx-market-intelligence"],
        requires_account: false,
        deprecated: true,
        preferred_scopes: &["intelligence"],
        responsibility: "检查新闻、宏观日历、事件、情绪与市场反应，标注发布时间、来源、重要性和证据冲突。",
        body: builtin_bodies::BODY_INTELLIGENCE_FLOW,
    },
    BuiltinAgentSpec {
        id: "desic-smart-money",
        legacy_id: "auto-smart-money",
        name: "Smart Money",
        role: "smart_money",
        envelope: AGENT_ENVELOPE_STANDARD,
        skills: &["okx-market-intelligence"],
        requires_account: false,
        deprecated: true,
        preferred_scopes: &["intelligence", "derivatives"],
        responsibility: "检查精英交易员仓位、绩效、订单历史、共识分歧和资金流趋势，区分领先信号与拥挤跟随。",
        body: builtin_bodies::BODY_SMART_MONEY,
    },
    BuiltinAgentSpec {
        id: "desic-historical-analogy",
        legacy_id: "auto-historical-analogy",
        name: "历史类比",
        role: "historical_analogy",
        envelope: AGENT_ENVELOPE_STANDARD,
        skills: &[],
        requires_account: false,
        deprecated: true,
        preferred_scopes: &["history", "market"],
        responsibility: "检索历史订单、成交、持仓阶段和既有交易机会，比较相似情境、结果分布与失效条件。",
        body: builtin_bodies::BODY_HISTORICAL_ANALOGY,
    },
    BuiltinAgentSpec {
        id: "desic-data-digest",
        legacy_id: "desic-data-digest",
        name: "数据汇总",
        role: "data_digest",
        envelope: AGENT_ENVELOPE_STANDARD,
        skills: &["okx-market-intelligence", "market-radar-research"],
        requires_account: false,
        deprecated: false,
        preferred_scopes: &["market", "derivatives", "intelligence"],
        responsibility: "一次读齐行情、衍生品、聪明钱、新闻与历史数据，产出可引用的结构化摘要，不做方向判断。",
        body: builtin_bodies::BODY_DATA_DIGEST,
    },
    BuiltinAgentSpec {
        id: "desic-account-state",
        legacy_id: "desic-account-state",
        name: "账户与持仓",
        role: "account_state",
        // C20 裁决：role 保持 `account_state`，用**显式声明 risk** 让 C15.1 取严规则生效。
        envelope: AGENT_ENVELOPE_RISK,
        skills: &[],
        requires_account: true,
        deprecated: false,
        preferred_scopes: &["account", "market"],
        responsibility: "读取持仓、普通与算法挂单、止损止盈状态、保证金率与可用余量，输出纯客观的状态清单与风险标记。",
        body: builtin_bodies::BODY_ACCOUNT_STATE,
    },
    BuiltinAgentSpec {
        id: "desic-decision-proposal",
        legacy_id: "desic-decision-proposal",
        name: "分析/决策候选",
        role: "decision_proposal",
        envelope: AGENT_ENVELOPE_STANDARD,
        skills: &[],
        requires_account: false,
        deprecated: false,
        preferred_scopes: &["market", "history"],
        responsibility: "基于数据摘要与账户状态给出候选决策（方向、入场、仓位、失效条件、风险回报），并声明这是候选而不是最终决策。",
        body: builtin_bodies::BODY_DECISION_PROPOSAL,
    },
    BuiltinAgentSpec {
        id: "desic-contrarian-review",
        legacy_id: "auto-contrarian-review",
        name: "反方审查",
        role: "contrarian",
        envelope: AGENT_ENVELOPE_STANDARD,
        skills: &["okx-market-intelligence"],
        requires_account: false,
        deprecated: false,
        preferred_scopes: &["intelligence", "history"],
        responsibility: "尝试推翻候选决策，逐条给出可检验的反驳依据，或明确说明无法推翻、还需要补哪些证据。",
        body: builtin_bodies::BODY_CONTRARIAN_REVIEW,
    },
];

/// 全部内置 id（含 C20 起降级的历史角色）——安装、内置保护、UI 列表都用它。
pub fn builtin_agent_ids() -> Vec<String> {
    BUILTIN_AGENT_SPECS
        .iter()
        .map(|spec| spec.id.to_string())
        .collect()
}

/// C20 默认启用集（新 4 个流程角色）：新 Profile 与迁移后默认勾选这些；
/// 历史角色（`deprecated: true`）文件保留、可手动勾选，但**不默认启用**。
pub fn default_enabled_agent_ids() -> Vec<String> {
    BUILTIN_AGENT_SPECS
        .iter()
        .filter(|spec| !spec.deprecated)
        .map(|spec| spec.id.to_string())
        .collect()
}

/// C20：内置历史角色 id（UI 标灰、全选内置时跳过）。
pub fn deprecated_builtin_agent_ids() -> Vec<String> {
    BUILTIN_AGENT_SPECS
        .iter()
        .filter(|spec| spec.deprecated)
        .map(|spec| spec.id.to_string())
        .collect()
}

pub fn builtin_agent_spec(id: &str) -> Option<&'static BuiltinAgentSpec> {
    let id = id.trim();
    BUILTIN_AGENT_SPECS
        .iter()
        .find(|spec| spec.id == id || spec.legacy_id == id)
}

pub fn is_builtin_agent_id(id: &str) -> bool {
    builtin_agent_spec(id).is_some()
}

pub fn builtin_agent_definition(id: &str) -> Option<AiAgentDefinition> {
    let spec = builtin_agent_spec(id)?;
    let body = spec.body.trim().to_string();
    let mut def = AiAgentDefinition {
        id: spec.id.to_string(),
        name: spec.name.to_string(),
        role: spec.role.to_string(),
        envelope: spec.envelope.to_string(),
        skills: spec
            .skills
            .iter()
            .map(|skill| (*skill).to_string())
            .collect(),
        requires_account: spec.requires_account,
        source: AGENT_SOURCE_BUILTIN.to_string(),
        version: 1,
        created_at: AGENT_BUILTIN_CREATED_AT_MS,
        summary: String::new(),
        body,
        deprecated: spec.deprecated,
        scopes_deprecated: false,
        path: PathBuf::new(),
    };
    def.refresh_summary();
    Some(def)
}

pub fn builtin_agent_definitions() -> Vec<AiAgentDefinition> {
    BUILTIN_AGENT_SPECS
        .iter()
        .filter_map(|spec| builtin_agent_definition(spec.id))
        .collect()
}

/// 内置 Agent 的规范文件内容（指纹基准）。
pub fn builtin_agent_markdown(id: &str) -> Option<String> {
    let def = builtin_agent_definition(id)?;
    Some(render_agent_markdown(&def, &def.body))
}

/// 旧 id → 新 id（C1 表）。非 `auto-*` 输入返回 None。
pub fn legacy_agent_id_alias(id: &str) -> Option<&'static str> {
    let id = id.trim();
    BUILTIN_AGENT_SPECS
        .iter()
        .find(|spec| spec.legacy_id == id)
        .map(|spec| spec.id)
}

/// 解析任意形态的 agent id：旧 `auto-*` → 新 `desic-*`，其余原样。
pub fn resolve_agent_id_alias(id: &str) -> String {
    match legacy_agent_id_alias(id) {
        Some(alias) => alias.to_string(),
        None => id.trim().to_string(),
    }
}

// ===== 勾选名单规范化（C3 / C20.5）=====

/// 去重（按勾选顺序）、丢弃库中不存在的 id；不排序、不截断、不打分。
///
/// **注意**：本函数只判"存在"。C20.5 起"已下线（`deprecated`）的内置角色"必须走
/// [`resolve_enabled_agent_selection`] / [`resolve_enabled_agents`] 才会被剔除——
/// 它们的定义仍在库里，所以这里**能**通过（这正是旧勾选曾被继续派发的原因）。
pub fn normalize_enabled_agent_ids(ids: &[String], known: &[AiAgentDefinition]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    for raw in ids {
        let id = resolve_agent_id_alias(raw);
        if id.is_empty() {
            continue;
        }
        if !known.iter().any(|agent| agent.id == id) {
            continue;
        }
        if seen.insert(id.clone()) {
            result.push(id);
        }
    }
    result
}

/// 内置表判定：该 id 是否属于"已下线（历史角色）"。恢复方式 = 把内置表里的
/// `deprecated` 去掉（C20.5），文件始终保留在 `agents/<id>/AGENTS.md`。
pub fn is_deprecated_agent_id(id: &str) -> bool {
    builtin_agent_spec(id).is_some_and(|spec| spec.deprecated)
}

/// 用内置表给解析出来的定义补上 `deprecated`（文件里没有这个字段，正文是唯一真相，
/// "角色是否下线"由内置表决定；非内置 id 保持原样）。
pub fn apply_builtin_deprecation(definition: &mut AiAgentDefinition) {
    if let Some(spec) = builtin_agent_spec(&definition.id) {
        definition.deprecated = spec.deprecated;
    }
}

/// 勾选名单的三分结果（C3 保存校验 + C20.5 隐藏已下线角色共用）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EnabledAgentSelection {
    /// 生效名单：顺序 = 用户勾选顺序，alias 已归一、已去重，已剔除已下线与不存在的 id。
    pub enabled: Vec<String>,
    /// 被忽略的**已下线** id（C20.5：不算错误、不失败，但要明确回报给用户）。
    pub ignored_deprecated: Vec<String>,
    /// 库里不存在的 id（C3：丢弃并提示，不阻断保存）。
    pub dropped_unknown: Vec<String>,
}

/// 把用户勾选名单解析成"生效 / 被忽略 / 不存在"三份（纯函数，恢复路径可测：
/// 把 `known` 里某条定义的 `deprecated` 置回 `false`，它立刻回到 `enabled`）。
pub fn resolve_enabled_agent_selection(
    ids: &[String],
    known: &[AiAgentDefinition],
) -> EnabledAgentSelection {
    let mut selection = EnabledAgentSelection::default();
    let mut seen = std::collections::HashSet::new();
    for raw in ids {
        let id = resolve_agent_id_alias(raw);
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        match known.iter().find(|agent| agent.id == id) {
            None => selection.dropped_unknown.push(id),
            Some(agent) if agent.deprecated => selection.ignored_deprecated.push(id),
            Some(_) => selection.enabled.push(id),
        }
    }
    selection
}

/// 勾选名单 → 顺序一致的定义列表（含正文）。
///
/// C20.5：**已下线的内置角色一律不派发**（`deprecated` 定义被当作无效 id 过滤掉），
/// 因此运行载荷里不可能出现它们。
pub fn resolve_enabled_agents(
    ids: &[String],
    known: &[AiAgentDefinition],
) -> Vec<AiAgentDefinition> {
    normalize_enabled_agent_ids(ids, known)
        .into_iter()
        .filter_map(|id| known.iter().find(|agent| agent.id == id).cloned())
        .filter(|agent| !agent.deprecated)
        .collect()
}

// ===== 旧配置迁移计划（C3 迁移表 / C8 出口条件 6）=====

#[derive(Debug, Clone, Default)]
pub struct LegacyAgentMigrationInput {
    /// 旧 `multi_agent_mode`（off / auto / custom）。
    pub multi_agent_mode: Option<String>,
    /// 旧 `multi_agents_json`。
    pub legacy_agents: Vec<AiProfileSubAgent>,
    /// 旧 `ai_agent_schemes.agents_json`（scheme 引用的专家）。
    pub scheme_agents: Vec<AiProfileSubAgent>,
    /// 旧 scheme 是否带 `instructions`（丢弃并计入迁移报告）。
    pub scheme_instructions: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct LegacyAgentMigrationPlan {
    pub enabled_agent_ids: Vec<String>,
    /// 需要落盘的自定义 Agent 库条目（幂等：文件已存在则不重写）。
    pub library_agents: Vec<AiAgentDefinition>,
    /// 用户可见的迁移提示（前端提示字段 / 启动日志共用）。
    pub notes: Vec<String>,
}

pub fn plan_legacy_agent_migration(
    input: &LegacyAgentMigrationInput,
    now_ms: i64,
) -> LegacyAgentMigrationPlan {
    let mut plan = LegacyAgentMigrationPlan::default();
    let mode = input
        .multi_agent_mode
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match mode.as_str() {
        "auto" => {
            // C20：auto（旧"全池"）迁移到**新默认启用集**（4 个流程角色）；
            // 历史角色不再默认启用，但仍可在 Profile 里手动勾选。
            plan.enabled_agent_ids = default_enabled_agent_ids();
            plan.notes.push(format!(
                "多 Agent 模式 auto 已迁移为默认启用集（{} 个流程角色）",
                plan.enabled_agent_ids.len()
            ));
        }
        "custom" => {
            let migrated = migrate_legacy_agent_list(&input.legacy_agents, &mut plan, now_ms);
            plan.enabled_agent_ids = migrated;
            if !plan.enabled_agent_ids.is_empty() {
                plan.notes.push(format!(
                    "已把 {} 个自定义 Agent 迁移到 Agent 库",
                    plan.library_agents.len()
                ));
            }
        }
        _ => {
            if !input.legacy_agents.is_empty() {
                plan.notes
                    .push("多 Agent 模式为 off，旧自定义 Agent 未启用".to_string());
            }
        }
    }
    // 旧模板（scheme）条目：只增不删，id 并集写入。
    if !input.scheme_agents.is_empty() {
        let mut union = plan.enabled_agent_ids.clone();
        let scheme_ids = migrate_legacy_agent_list(&input.scheme_agents, &mut plan, now_ms);
        for id in scheme_ids {
            if !union.contains(&id) {
                union.push(id);
            }
        }
        plan.enabled_agent_ids = union;
        plan.notes
            .push("旧 Agent 模板条目已迁移到 Agent 库".to_string());
    }
    if input
        .scheme_instructions
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
    {
        plan.notes
            .push("旧 Agent 模板 instructions 已丢弃（新模型不再有方案级指令）".to_string());
    }
    plan
}

fn migrate_legacy_agent_list(
    agents: &[AiProfileSubAgent],
    plan: &mut LegacyAgentMigrationPlan,
    now_ms: i64,
) -> Vec<String> {
    let mut enabled = Vec::new();
    for agent in agents {
        if !agent.enabled {
            continue;
        }
        let resolved_id = resolve_agent_id_alias(&agent.id);
        if is_builtin_agent_id(&resolved_id) {
            // 旧 `auto-*` 名单直接落到新内置 id，不需要额外库文件。
            if !enabled.contains(&resolved_id) {
                enabled.push(resolved_id);
            }
            continue;
        }
        let Some(def) = custom_agent_from_legacy(agent, now_ms) else {
            plan.notes
                .push(format!("旧 Agent {} 缺少可用名称或职责，已跳过迁移", agent.id));
            continue;
        };
        if !plan
            .library_agents
            .iter()
            .any(|existing| existing.id == def.id)
        {
            plan.library_agents.push(def.clone());
        }
        if !enabled.contains(&def.id) {
            enabled.push(def.id.clone());
        }
    }
    enabled
}

/// 旧自定义 Agent（profile JSON / scheme agents_json 条目）→ 库条目。
/// role/scopes 原样（scopes 过滤白名单），source=custom。
pub fn custom_agent_from_legacy(agent: &AiProfileSubAgent, now_ms: i64) -> Option<AiAgentDefinition> {
    let name = collapse_to_chars(&single_line(&agent.name), AGENT_NAME_MAX_CHARS);
    let responsibility = agent.responsibility.trim();
    if name.is_empty() || responsibility.is_empty() {
        return None;
    }
    let mut id = agent_slug(&agent.id);
    if id.len() < 2 || is_builtin_agent_id(&id) {
        let fallback = agent_slug(&name);
        id = if fallback.len() >= 2 { fallback } else { "custom-agent".to_string() };
    }
    let role = agent_role_slug(&agent.role, &id);
    // C15：旧 Profile/模板成员里的 `scopes` 直接丢弃，不写入新文件。
    let requires_account = role == "account_risk";
    let envelope = resolve_agent_envelope(None, &role);
    let body = build_agent_body(AgentBodyParts {
        name: &name,
        role: &role,
        responsibility,
        envelope: &envelope,
    });
    let mut def = AiAgentDefinition {
        id,
        name,
        role,
        envelope: envelope.to_string(),
        skills: Vec::new(),
        requires_account,
        source: AGENT_SOURCE_CUSTOM.to_string(),
        version: 1,
        created_at: now_ms,
        summary: String::new(),
        body,
        deprecated: false,
        scopes_deprecated: false,
        path: PathBuf::new(),
    };
    def.refresh_summary();
    validate_agent_definition(&def).ok()?;
    Some(def)
}

/// 名称/id → 合法 slug（`^[a-z0-9][a-z0-9-]{1,47}$`）。
pub fn agent_slug(value: &str) -> String {
    let lowered = value.trim().to_ascii_lowercase();
    let mut slug = String::new();
    let mut last_dash = true;
    for ch in lowered.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    let slug = slug.trim_matches('-').to_string();
    let slug: String = slug.chars().take(48).collect();
    let slug = slug.trim_end_matches('-').to_string();
    if slug.len() < 2 || !slug.as_bytes()[0].is_ascii_lowercase() {
        // 全中文名称等无法生成 ASCII slug 的情况：交由调用方兜底。
        if slug.len() >= 2 && slug.as_bytes()[0].is_ascii_digit() {
            return slug;
        }
        return String::new();
    }
    slug
}

/// role 规整：合法则原样，否则退化为 `custom`（C2 role 正则）。
pub fn agent_role_slug(value: &str, seed: &str) -> String {
    let trimmed = value.trim().to_ascii_lowercase();
    if is_valid_agent_role(&trimmed) {
        return trimmed;
    }
    let candidate = trimmed
        .chars()
        .map(|ch| if ch.is_ascii_lowercase() || ch.is_ascii_digit() { ch } else { '_' })
        .collect::<String>();
    let candidate = candidate.trim_matches('_').to_string();
    let candidate = if candidate.as_bytes().first().is_some_and(u8::is_ascii_alphabetic) {
        candidate
    } else {
        String::new()
    };
    let candidate: String = candidate.chars().take(32).collect();
    if is_valid_agent_role(&candidate) {
        return candidate;
    }
    let seeded = agent_slug(seed).replace('-', "_");
    if is_valid_agent_role(&seeded) {
        return seeded;
    }
    "custom".to_string()
}

/// 复制 / AI 创建的新 id：`custom-<slug>-<n>`（与已存在 id 去重）。
pub fn unique_custom_agent_id(name: &str, source_id: &str, existing: &[String]) -> String {
    let mut base = agent_slug(name);
    if base.is_empty() {
        base = agent_slug(source_id);
    }
    for prefix in ["custom-", "desic-"] {
        if let Some(stripped) = base.strip_prefix(prefix) {
            base = stripped.to_string();
        }
    }
    if base.len() < 2 {
        base = "agent".to_string();
    }
    for index in 1..1000 {
        let candidate = format!("custom-{base}-{index}");
        if candidate.len() > 48 {
            let keep = 48 - "custom--".len() - index.to_string().len();
            let truncated: String = base.chars().take(keep.max(2)).collect();
            let candidate = format!("custom-{truncated}-{index}");
            if !existing.iter().any(|id| id == &candidate) {
                return candidate;
            }
            continue;
        }
        if !existing.iter().any(|id| id == &candidate) {
            return candidate;
        }
    }
    format!("custom-agent-{}", current_time_ms())
}

pub fn current_time_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// 从勾选名单里剥掉某个 id（删除 Agent 时同步清理 Profile）。
pub fn remove_enabled_agent_id(ids: &[String], target: &str) -> (Vec<String>, bool) {
    let mut changed = false;
    let result = ids
        .iter()
        .filter(|id| {
            let keep = resolve_agent_id_alias(id) != target.trim();
            if !keep {
                changed = true;
            }
            keep
        })
        .cloned()
        .collect::<Vec<_>>();
    (result, changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn builtin_documents() -> Vec<AiAgentDefinition> {
        builtin_agent_definitions()
    }

    fn builtin_definitions() -> Vec<AiAgentDefinition> {
        builtin_agent_definitions()
    }

    /// C20：内置表 = 4 个新流程角色（默认启用）+ 7 个历史角色（deprecated）；
    /// `desic-contrarian-review` 是 id 复用（新正文、不标停用）。
    #[test]
    fn builtin_table_matches_c20_roles_and_deprecations() {
        let defs = builtin_definitions();
        assert_eq!(defs.len(), 11, "4 新 + 7 历史");
        assert_eq!(
            default_enabled_agent_ids(),
            vec![
                "desic-data-digest",
                "desic-account-state",
                "desic-decision-proposal",
                "desic-contrarian-review"
            ]
        );
        assert_eq!(deprecated_builtin_agent_ids().len(), 7);
        assert!(!deprecated_builtin_agent_ids().contains(&"desic-contrarian-review".to_string()));

        let digest = defs
            .iter()
            .find(|def| def.id == "desic-data-digest")
            .expect("data digest");
        assert_eq!(digest.name, "数据汇总");
        assert_eq!(digest.role, "data_digest");
        assert_eq!(digest.envelope, AGENT_ENVELOPE_STANDARD);
        assert_eq!(
            digest.skills,
            vec!["okx-market-intelligence", "market-radar-research"]
        );
        assert!(!digest.deprecated);
        assert_eq!(
            digest.summary,
            "一次读齐行情、衍生品、聪明钱、新闻与历史数据，产出可引用的结构化摘要，不做方向判断。"
        );

        // C20 裁决：role=account_state + 显式 envelope=risk（不是把 role 改成 account_risk）。
        let account = defs
            .iter()
            .find(|def| def.id == "desic-account-state")
            .expect("account state");
        assert_eq!(account.role, "account_state");
        assert_eq!(account.envelope, AGENT_ENVELOPE_RISK, "显式声明 risk");
        assert!(account.requires_account);

        let proposal = defs
            .iter()
            .find(|def| def.id == "desic-decision-proposal")
            .expect("decision proposal");
        assert_eq!(proposal.role, "decision_proposal");
        assert!(!proposal.requires_account);

        let contrarian = defs
            .iter()
            .find(|def| def.id == "desic-contrarian-review")
            .expect("contrarian");
        assert_eq!(contrarian.role, "contrarian");
        assert!(!contrarian.deprecated, "id 复用，不标停用");
        assert!(contrarian.body.contains("尝试推翻候选决策"));
        assert_eq!(
            contrarian.summary,
            "尝试推翻候选决策，逐条给出可检验的反驳依据，或明确说明无法推翻、还需要补哪些证据。"
        );

        // 历史角色：文件仍在、可解析，只是标停用。
        for id in deprecated_builtin_agent_ids() {
            let def = defs.iter().find(|def| def.id == id).expect("legacy builtin");
            assert!(def.deprecated, "{id} 必须标 deprecated");
            assert!(def.source == AGENT_SOURCE_BUILTIN);
            assert!(builtin_agent_markdown(&id).is_some(), "{id} 仍要能安装");
        }
        assert!(defs.iter().all(|def| !def.id.starts_with("auto-")));
    }

    /// C23.1：反方审查的范围约束 —— 默认输入是**本轮已产出的报告**、只做**少量定点核对**、
    /// **禁止重新做全量取证**，无法推翻时直接给「无法推翻 + 适用范围」。
    #[test]
    fn contrarian_review_body_forbids_full_refetch() {
        let contrarian =
            builtin_agent_definition("desic-contrarian-review").expect("contrarian definition");
        for expected in [
            "默认输入是**本轮已产出的报告**",
            "少量定点核对",
            "**禁止重新做全量取证**",
            "不重取 K 线序列",
            "无法推翻",
        ] {
            assert!(
                contrarian.body.contains(expected),
                "C23.1 反方正文缺少范围约束：{expected}"
            );
        }
        // 正文变了但 `summary`（= 「职责」段首句）仍必须逐字等于内置表的 `responsibility`。
        assert_eq!(
            contrarian.summary,
            builtin_agent_spec("desic-contrarian-review")
                .expect("spec")
                .responsibility
        );
        // 未动过的三位专家正文不得被"顺手对齐"（内容包 §6.6 的既定分工）。
        for (id, marker) in [
            ("desic-data-digest", "一次读齐"),
            ("desic-account-state", "只读「账户与持仓」专家"),
            ("desic-decision-proposal", "逐条引用证据 ID、时间戳与来源工具"),
        ] {
            let definition = builtin_agent_definition(id).expect("definition");
            assert!(
                definition.body.contains(marker),
                "{id} 正文不应对齐反方范围约束（内容包 §6.6）"
            );
            assert!(
                !definition.body.contains("**禁止重新做全量取证**"),
                "{id} 不是反方角色，不该带反方的禁止全量取证约束"
            );
        }
    }

    /// C20.5：勾选名单三分（生效 / 已下线忽略 / 不存在）+ 恢复路径（纯函数级）。
    #[test]
    fn deprecated_agents_are_ignored_until_restored() {
        let mut known = builtin_agent_definitions();
        let ids = vec![
            "desic-smart-money".to_string(),
            "desic-contrarian-review".to_string(),
            "not-in-library".to_string(),
        ];
        for id in deprecated_builtin_agent_ids() {
            assert!(is_deprecated_agent_id(&id), "{id}");
        }
        assert!(!is_deprecated_agent_id("desic-contrarian-review"), "id 复用，未下线");
        assert!(!is_deprecated_agent_id("not-in-library"));

        let selection = resolve_enabled_agent_selection(&ids, &known);
        assert_eq!(selection.enabled, vec!["desic-contrarian-review".to_string()]);
        assert_eq!(selection.ignored_deprecated, vec!["desic-smart-money".to_string()]);
        assert_eq!(selection.dropped_unknown, vec!["not-in-library".to_string()]);
        // 载荷侧：已下线的定义被当无效 id 过滤掉（运行绝不派发）。
        assert!(resolve_enabled_agents(&ids, &known)
            .iter()
            .all(|agent| agent.id != "desic-smart-money"));
        // 旧兼容层只判"存在"——已下线的定义仍在库里，所以它能通过（这正是旧行为误派的原因）。
        assert!(normalize_enabled_agent_ids(&ids, &known).contains(&"desic-smart-money".to_string()));

        // 恢复路径：把 `deprecated` 去掉 → 立刻回到生效名单。
        for agent in known.iter_mut() {
            if agent.id == "desic-smart-money" {
                agent.deprecated = false;
            }
        }
        let restored = resolve_enabled_agent_selection(&ids, &known);
        assert_eq!(
            restored.enabled,
            vec![
                "desic-smart-money".to_string(),
                "desic-contrarian-review".to_string()
            ]
        );
        assert!(restored.ignored_deprecated.is_empty());

        // 文件里没有 `deprecated` 字段：靠内置表标注（非内置条目原样不动）。
        let mut parsed = parse_agent_markdown(
            &builtin_agent_markdown("desic-smart-money").expect("builtin markdown"),
        )
        .expect("parse builtin");
        assert!(!parsed.deprecated);
        apply_builtin_deprecation(&mut parsed);
        assert!(parsed.deprecated);
        let mut custom = builtin_agent_definition("desic-data-digest").expect("definition");
        custom.id = "custom-agent".to_string();
        custom.deprecated = true;
        apply_builtin_deprecation(&mut custom);
        assert!(custom.deprecated, "非内置条目保持原样");
    }

    #[test]
    fn builtin_render_is_stable_and_round_trips() {
        let first = builtin_agent_markdown("desic-smart-money").expect("builtin markdown");
        let second = builtin_agent_markdown("desic-smart-money").expect("builtin markdown");
        assert_eq!(first, second, "内置指纹必须稳定");
        let parsed = parse_agent_markdown(&first).expect("parse builtin");
        assert_eq!(parsed.id, "desic-smart-money");
        assert_eq!(parsed.created_at, AGENT_BUILTIN_CREATED_AT_MS);
        let rendered = render_agent_markdown(&parsed, &parsed.body);
        assert_eq!(rendered, first, "渲染必须字节级幂等");
    }

    #[test]
    fn parse_ignores_unknown_keys_and_defaults_envelope_version_created_at() {
        let content = "---\nid: custom-demo\nname: 演示\nrole: custom\nunknownKey: 忽略\nscopes: [market]\n---\n## 身份\n演示。\n";
        let parsed = parse_agent_markdown(content).expect("parse tolerant");
        assert_eq!(parsed.envelope, AGENT_ENVELOPE_STANDARD);
        assert_eq!(parsed.version, 1);
        assert_eq!(parsed.created_at, 0);
        assert_eq!(parsed.source, AGENT_SOURCE_CUSTOM);
        assert!(!parsed.requires_account);
        assert_eq!(parsed.summary, "演示。");
    }

    #[test]
    fn parse_supports_block_lists_and_quoted_names() {
        let content = "---\nid: custom-block\nname: \"带,逗号 的名字\"\nrole: custom\nscopes:\n  - market\n  - derivatives\nskills:\n  - okx-market-intelligence\nversion: 3\n---\n正文第一段。\n\n第二段。\n";
        let parsed = parse_agent_markdown(content).expect("parse block list");
        assert_eq!(parsed.name, "带,逗号 的名字");
        // C15：文件里的废弃 `scopes` 被忽略（不报错），只标记提示。
        assert!(parsed.scopes_deprecated);
        assert_eq!(parsed.skills, vec!["okx-market-intelligence"]);
        assert_eq!(parsed.version, 3);
        assert_eq!(parsed.summary, "正文第一段。");
    }

    #[test]
    fn validation_rejects_contract_c2_violations() {
        let ok = "---\nid: custom-ok\nname: 可用\nrole: custom\nscopes: [market]\n---\n正文。\n";
        assert!(parse_agent_markdown(ok).is_ok());

        let bad_id = "---\nid: Bad_Id\nname: 名称\nrole: custom\n---\n正文。\n";
        assert!(parse_agent_markdown(bad_id).is_err());

        let long_name = format!(
            "---\nid: custom-name\nname: {}\nrole: custom\n---\n正文。\n",
            "字".repeat(41)
        );
        assert!(parse_agent_markdown(&long_name).is_err());

        let bad_role = "---\nid: custom-role\nname: 名称\nrole: Market\n---\n正文。\n";
        assert!(parse_agent_markdown(bad_role).is_err());

        // C15：`scopes`（含白名单外的值）不再是校验项，只标记废弃提示。
        let deprecated_scopes = "---\nid: custom-scope\nname: 名称\nrole: custom\nscopes: [trade]\n---\n正文。\n";
        let parsed = parse_agent_markdown(deprecated_scopes).expect("scopes is ignored");
        assert!(parsed.scopes_deprecated);

        let empty_body = "---\nid: custom-empty\nname: 名称\nrole: custom\n---\n\n";
        assert!(parse_agent_markdown(empty_body).is_err());

        let oversized = format!(
            "---\nid: custom-big\nname: 名称\nrole: custom\n---\n{}",
            "字".repeat(AGENT_MAX_FILE_BYTES)
        );
        assert!(parse_agent_markdown(&oversized).is_err());
    }

    /// 验收手册 B7 + C15：`envelope` 提供但非法必须 Err；缺失才默认 standard；
    /// `scopes` 已废弃——出现即忽略并标记 `scopes_deprecated`，绝不报错。
    #[test]
    fn envelope_is_strict_and_deprecated_scopes_are_ignored() {
        let invalid_envelope =
            "---\nid: custom-env\nname: 名称\nrole: custom\nenvelope: none\nscopes: [market]\n---\n正文。\n";
        let error = parse_agent_markdown(invalid_envelope).expect_err("envelope must not degrade");
        assert!(error.contains("envelope"), "{error}");
        assert!(error.contains("none"), "{error}");

        let missing_envelope = "---\nid: custom-env\nname: 名称\nrole: custom\n---\n正文。\n";
        let parsed = parse_agent_markdown(missing_envelope).expect("missing envelope defaults");
        assert_eq!(parsed.envelope, AGENT_ENVELOPE_STANDARD);
        assert!(!parsed.scopes_deprecated, "没有 scopes 键不该报废弃");

        // 取更严者（C15.1）：role=account_risk → risk；显式 risk → risk。
        let account_role = "---\nid: custom-env\nname: 名称\nrole: account_risk\n---\n正文。\n";
        assert_eq!(
            parse_agent_markdown(account_role).expect("role drives risk").envelope,
            AGENT_ENVELOPE_RISK
        );
        let declared_risk = "---\nid: custom-env\nname: 名称\nrole: custom\nenvelope: risk\n---\n正文。\n";
        assert_eq!(
            parse_agent_markdown(declared_risk).expect("declared risk").envelope,
            AGENT_ENVELOPE_RISK
        );

        // C15：旧文件里的 `scopes`（含白名单外的值）一律忽略，不报错、不进入解析结果。
        for scopes_line in ["[market, derivatives]", "[]", "[shell]"] {
            let content = format!(
                "---\nid: custom-scope\nname: 名称\nrole: custom\nscopes: {scopes_line}\n---\n正文。\n"
            );
            let parsed = parse_agent_markdown(&content)
                .unwrap_or_else(|error| panic!("scopes 必须被忽略：{scopes_line} → {error}"));
            assert!(parsed.scopes_deprecated, "{scopes_line}");
        }

        // 渲染不再写 `scopes`。
        let rendered = render_agent_markdown(
            &parse_agent_markdown(missing_envelope).expect("parse"),
            "## 职责\n职责。\n",
        );
        assert!(!rendered.contains("scopes"), "{rendered}");

        // `validate_agent_scope_values` 保留（改用途：校验点名时声明的收窄范围）。
        assert!(validate_agent_scope_values(&["market".to_string()]).is_ok());
        assert!(validate_agent_scope_values(&[]).is_ok());
        let error = validate_agent_scope_values(&["shell".to_string(), "market".to_string()])
            .expect_err("whitelist violation must be reported");
        assert!(error.contains("shell"), "{error}");
        assert!(error.contains("允许"), "{error}");
    }

    #[test]
    fn reference_paths_reject_absolute_and_parent_traversal() {
        assert_eq!(
            validate_agent_reference_path("references/evidence.md").expect("relative ok"),
            PathBuf::from("references/evidence.md")
        );
        assert!(validate_agent_reference_path("/etc/passwd").is_err());
        assert!(validate_agent_reference_path("references/../../escape.md").is_err());
        assert!(validate_agent_reference_path("../escape.md").is_err());
        assert!(validate_agent_reference_path("C:/windows/system32").is_err());
        assert!(validate_agent_reference_path("references/.hidden.md").is_err());
    }

    #[test]
    fn summary_is_single_line_and_bounded() {
        let body = "## 身份\n身份段。\n\n## 职责\n第一行\n第二行\n\n## 输出偏好\n其它。\n";
        assert_eq!(summarize_agent_body(body), "第一行 第二行");
        let long = format!("---\nid: custom-long\nname: 名称\nrole: custom\n---\n{}", "字".repeat(400));
        let parsed = parse_agent_markdown(&long).expect("parse long body");
        assert_eq!(parsed.summary.chars().count(), AGENT_SUMMARY_MAX_CHARS);
        assert!(!parsed.summary.contains('\n'));
    }

    #[test]
    fn enabled_ids_are_ordered_deduped_and_filtered() {
        let defs = builtin_documents();
        let raw = vec![
            "desic-smart-money".to_string(),
            "auto-market-structure".to_string(),
            "desic-smart-money".to_string(),
            "does-not-exist".to_string(),
            "".to_string(),
            "desic-smart-money".to_string(),
        ];
        // 兼容层（只判"存在"，签名不变）：两个 id 都在库里。
        assert_eq!(
            normalize_enabled_agent_ids(&raw, &defs),
            vec!["desic-smart-money".to_string(), "desic-market-structure".to_string()]
        );
        // C20.5：这两个都是已下线的历史角色 → 载荷里一个都不派发。
        assert!(resolve_enabled_agents(&raw, &defs).is_empty());
        // 换成仍启用的角色：按勾选顺序、去重、带正文、丢弃不存在的 id。
        let live = vec![
            "desic-decision-proposal".to_string(),
            "desic-data-digest".to_string(),
            "desic-data-digest".to_string(),
            "does-not-exist".to_string(),
        ];
        let resolved = resolve_enabled_agents(&live, &defs);
        assert_eq!(
            resolved
                .iter()
                .map(|def| def.id.as_str())
                .collect::<Vec<_>>(),
            vec!["desic-decision-proposal", "desic-data-digest"]
        );
        assert!(resolved.iter().all(|def| !def.body.is_empty()));
    }

    #[test]
    fn migration_covers_off_auto_custom_and_scheme_entries() {
        let off = plan_legacy_agent_migration(
            &LegacyAgentMigrationInput {
                multi_agent_mode: Some("off".to_string()),
                ..Default::default()
            },
            1_000,
        );
        assert!(off.enabled_agent_ids.is_empty());
        assert!(off.library_agents.is_empty());

        let auto = plan_legacy_agent_migration(
            &LegacyAgentMigrationInput {
                multi_agent_mode: Some("AUTO".to_string()),
                ..Default::default()
            },
            1_000,
        );
        assert_eq!(auto.enabled_agent_ids, default_enabled_agent_ids());
        assert_eq!(auto.enabled_agent_ids.len(), 4, "C20 默认启用集是新 4 个流程角色");

        let custom = plan_legacy_agent_migration(
            &LegacyAgentMigrationInput {
                multi_agent_mode: Some("custom".to_string()),
                legacy_agents: vec![
                    AiProfileSubAgent {
                        id: "auto-market-structure".to_string(),
                        name: "市场结构".to_string(),
                        role: "market_structure".to_string(),
                        responsibility: "检查价格结构。".to_string(),
                        scopes: vec!["market".to_string()],
                        required: true,
                        enabled: true,
                    },
                    AiProfileSubAgent {
                        id: "my-custom".to_string(),
                        name: "自建分析".to_string(),
                        role: "中文角色".to_string(),
                        responsibility: "自定义职责说明。".to_string(),
                        scopes: vec!["market".to_string(), "unknown".to_string()],
                        required: false,
                        enabled: true,
                    },
                ],
                ..Default::default()
            },
            1_000,
        );
        assert_eq!(
            custom.enabled_agent_ids,
            vec!["desic-market-structure".to_string(), "my-custom".to_string()]
        );
        assert_eq!(custom.library_agents.len(), 1);
        let migrated = &custom.library_agents[0];
        assert_eq!(migrated.id, "my-custom");
        assert_eq!(migrated.source, AGENT_SOURCE_CUSTOM);
        // C15：旧成员的 scopes 丢弃，不再进入新文件。
        assert!(!migrated.scopes_deprecated);
        assert_eq!(migrated.role, "my_custom");
        assert_eq!(migrated.created_at, 1_000);
        assert!(migrated.body.contains("自定义职责说明。"));

        let scheme = plan_legacy_agent_migration(
            &LegacyAgentMigrationInput {
                multi_agent_mode: Some("off".to_string()),
                scheme_agents: vec![AiProfileSubAgent {
                    id: "scheme-agent".to_string(),
                    name: "方案专家".to_string(),
                    role: "custom".to_string(),
                    responsibility: "方案里的职责。".to_string(),
                    scopes: vec!["intelligence".to_string()],
                    required: false,
                    enabled: true,
                }],
                scheme_instructions: Some("旧方案指令".to_string()),
                ..Default::default()
            },
            2_000,
        );
        assert_eq!(scheme.enabled_agent_ids, vec!["scheme-agent".to_string()]);
        assert_eq!(scheme.library_agents.len(), 1);
        assert!(scheme.notes.iter().any(|note| note.contains("instructions")));
    }

    #[test]
    fn migration_plan_is_idempotent() {
        let input = LegacyAgentMigrationInput {
            multi_agent_mode: Some("custom".to_string()),
            legacy_agents: vec![AiProfileSubAgent {
                id: "my-custom".to_string(),
                name: "自建分析".to_string(),
                role: "custom".to_string(),
                responsibility: "自定义职责说明。".to_string(),
                scopes: vec!["market".to_string()],
                required: false,
                enabled: true,
            }],
            ..Default::default()
        };
        let first = plan_legacy_agent_migration(&input, 1_000);
        let second = plan_legacy_agent_migration(&input, 9_999);
        assert_eq!(first.enabled_agent_ids, second.enabled_agent_ids);
        assert_eq!(first.library_agents[0].id, second.library_agents[0].id);
        assert_eq!(first.library_agents[0].body, second.library_agents[0].body);
    }

    #[test]
    fn duplicate_ids_are_unique_and_slugified() {
        let existing = vec!["custom-market-structure-1".to_string()];
        assert_eq!(
            unique_custom_agent_id("市场结构", "desic-market-structure", &existing),
            "custom-market-structure-2"
        );
        assert_eq!(
            unique_custom_agent_id("My Agent", "desic-market-structure", &[]),
            "custom-my-agent-1"
        );
    }

    #[test]
    fn body_skeleton_has_five_contract_sections_and_envelope_risk_rules() {
        let body = build_agent_body(AgentBodyParts {
            name: "账户风险",
            role: "account_risk",
            responsibility: "检查账户风险。",
            envelope: AGENT_ENVELOPE_RISK,
        });
        for section in [
            AGENT_BODY_SECTION_IDENTITY,
            AGENT_BODY_SECTION_DUTIES,
            AGENT_BODY_SECTION_METHOD,
            AGENT_BODY_SECTION_OUTPUT,
            AGENT_BODY_SECTION_GAP,
        ] {
            assert!(body.contains(section), "缺少段落：{section}");
        }
        assert!(body.contains("trade.precheck"));
        assert_eq!(summarize_agent_body(&body), "检查账户风险。");
    }

    #[test]
    fn directory_id_must_match_frontmatter() {
        let def = builtin_agent_definition("desic-market-structure").expect("builtin");
        assert!(validate_agent_directory_id("desic-market-structure", &def).is_ok());
        assert!(validate_agent_directory_id("other-dir", &def).is_err());
    }

    /// 内容包 §1.9 逐字口径核对表：正文「职责」段首句必须等于
    /// `AUTO_PROFILE_AGENTS[].responsibility` 原文，且 C4 的目录 summary 取同一句。
    #[test]
    fn builtin_bodies_match_content_pack_verbatim_table() {
        for spec in BUILTIN_AGENT_SPECS.iter() {
            let body = spec.body.trim();
            for section in [
                AGENT_BODY_SECTION_IDENTITY,
                AGENT_BODY_SECTION_DUTIES,
                AGENT_BODY_SECTION_METHOD,
                AGENT_BODY_SECTION_OUTPUT,
                AGENT_BODY_SECTION_GAP,
            ] {
                assert!(body.contains(section), "{} 缺少段落 {section}", spec.id);
            }
            assert!(!body.starts_with("---"), "{} 正文不应含 frontmatter", spec.id);
            let duties = section_first_paragraph(body, AGENT_BODY_SECTION_DUTIES)
                .unwrap_or_else(|| panic!("{} 缺少职责段", spec.id));
            assert!(
                duties.starts_with(spec.responsibility),
                "{} 职责段首句与 responsibility 口径不一致：\n{}\n{}",
                spec.id,
                duties,
                spec.responsibility
            );
            let def = builtin_agent_definition(spec.id).expect("builtin definition");
            assert_eq!(
                def.summary, spec.responsibility,
                "{} 的 summary 必须等于 responsibility 原文",
                spec.id
            );
        }
    }

    #[test]
    fn shared_skeleton_is_used_for_tool_create_and_ai_fallback() {
        let skeleton = render_agent_skeleton("检查账户风险。");
        for section in [
            AGENT_BODY_SECTION_IDENTITY,
            AGENT_BODY_SECTION_DUTIES,
            AGENT_BODY_SECTION_METHOD,
            AGENT_BODY_SECTION_OUTPUT,
            AGENT_BODY_SECTION_GAP,
        ] {
            assert!(skeleton.contains(section), "骨架缺少段落：{section}");
        }
        assert!(skeleton.contains("检查账户风险。"));
        assert_eq!(summarize_agent_body(&skeleton), "检查账户风险。");

        let (completed, missing) =
            complete_agent_body_sections("## 职责\n补齐段落。\n");
        assert_eq!(missing.len(), 4);
        for section in [
            AGENT_BODY_SECTION_IDENTITY,
            AGENT_BODY_SECTION_METHOD,
            AGENT_BODY_SECTION_OUTPUT,
            AGENT_BODY_SECTION_GAP,
        ] {
            assert!(completed.contains(section));
        }
        let (untouched, missing) = complete_agent_body_sections(&skeleton);
        assert!(missing.is_empty());
        assert_eq!(untouched, skeleton.trim());
    }

    #[test]
    fn body_wrappers_are_stripped_with_warnings() {
        let body = "---\nid: x\n---\n## 身份\n身份。\n\n## 职责\n职责。\n\n## 方法与证据要求\n方法与证据要求。\n\n## 输出偏好\n输出偏好。\n\n## 数据缺口处理\n数据缺口处理。\n";
        let (stripped, warnings) = strip_agent_body_wrappers(body);
        assert!(!stripped.starts_with("---"));
        assert!(stripped.starts_with("## 身份"));
        assert_eq!(warnings.len(), 1);

        let (shell_removed, warnings) =
            strip_agent_body_wrappers("## 身份\n只读权限：本 Agent 只读。\n正文。\n");
        assert!(!shell_removed.contains("只读权限"));
        assert!(shell_removed.contains("正文。"));
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn draft_parse_allows_placeholder_id_but_strict_parse_rejects_it() {
        let draft = "---\nid: \nname: 新专家\nrole: custom\n---\n## 职责\n未填写。\n";
        let parsed = parse_agent_draft_markdown(draft).expect("draft parse is lenient");
        assert!(parsed.id.is_empty());
        assert_eq!(parsed.name, "新专家");
        assert!(parse_agent_markdown(draft).is_err());
    }
}
