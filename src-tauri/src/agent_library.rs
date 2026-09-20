//! Agent 库命令层与工具宿主共用实现（契约 C1/C2/C3/C6/C9）。
//!
//! 文件是真相：`<data_dir>/workspace/.cline/agents/<id>/AGENTS.md`（可选
//! `references/*.md`）。**不新建 `ai_agents` 表**——列表 = 扫目录 + 解析
//! （数量级 10–50，开销可忽略），`enabledByProfiles` 由 profile 行内 JSON 统计。
//!
//! 解析/校验/渲染全部走 `desic_agent_automation`（单一实现）；路径与读写走
//! `crate::storage_config` 的 Agent 库 helper。命令与工具必须调用同一批函数，
//! 不允许在 `lib.rs` 里重复实现校验。

use super::*;
use desic_agent_automation::{
    agent_draft_from_role_json, agent_draft_few_shot_messages, agent_draft_system_prompt,
    build_agent_draft_user_prompt, is_builtin_agent_id, normalize_enabled_agent_ids,
    parse_agent_markdown, plan_legacy_agent_migration, render_agent_markdown,
    render_agent_skeleton, resolve_agent_envelope, unique_custom_agent_id,
    validate_agent_definition, validate_agent_file, validate_agent_source_for_save, AiAgentDefinition,
    AiAgentDetail, AiAgentDraftOutcome, AiAgentSummary, LegacyAgentMigrationPlan,
    AGENT_MAX_FILE_BYTES, AGENT_NAME_MAX_CHARS, AGENT_SOURCE_AI, AGENT_SOURCE_BUILTIN,
    AGENT_SOURCE_CUSTOM,
};
use std::collections::HashSet;
use std::path::PathBuf;

/// `ai_agent_generate` 的一次性请求超时（C9 沿用既有通道与错误处理）。
///
/// lead 裁决：整篇 250–450 字草稿 + 本地小模型很容易超过标题生成的 24s，
/// 因此放宽到 180s。这是 UI 草稿一次性请求，不属于"专家分析不做预算护栏"的范围。
/// 超时/传输失败 → 命令返回 Err → 前端走 `agentGenerateFailed`（不会静默卡住）。
const AI_AGENT_DRAFT_TIMEOUT_SECS: u64 = 180;

/// 库内一条 Agent：解析结果 + 原始文本 + 时间戳。
#[derive(Debug, Clone)]
pub(crate) struct AgentLibraryEntry {
    pub definition: AiAgentDefinition,
    pub content: String,
    pub path: PathBuf,
    pub updated_at: i64,
}

fn file_modified_ms(path: &std::path::Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_else(now_ms)
}

/// 扫目录 + 解析。非法条目只记录并跳过，不让整张列表失败。
pub(crate) fn load_agent_library() -> Vec<AgentLibraryEntry> {
    let mut entries = Vec::new();
    for id in crate::storage_config::list_agent_bundle_ids() {
        let content = match crate::storage_config::read_agent_bundle(&id) {
            Ok(Some(content)) => content,
            Ok(None) => continue,
            Err(error) => {
                crate::boot_log(&format!("agent library read failed for {id}: {error}"));
                continue;
            }
        };
        match parse_agent_markdown(&content) {
            Ok(mut definition) if definition.id == id => {
                // C20.5：`deprecated` 不在文件里（正文是唯一真相），由内置表标注；
                // 文件始终保留，"把内置表的 deprecated 去掉"即可恢复可见/可派。
                desic_agent_automation::apply_builtin_deprecation(&mut definition);
                let path = crate::storage_config::agent_bundle_markdown_path(&id)
                    .unwrap_or_else(|_| PathBuf::from(&id));
                let updated_at = file_modified_ms(&path);
                entries.push(AgentLibraryEntry {
                    definition,
                    content,
                    path,
                    updated_at,
                });
            }
            Ok(definition) => crate::boot_log(&format!(
                "agent library skipped {}: frontmatter id mismatch ({})",
                id, definition.id
            )),
            Err(error) => {
                crate::boot_log(&format!("agent library skipped {id}: {error}"));
            }
        }
    }
    entries
}

pub(crate) fn load_agent_library_entry(id: &str) -> Result<AgentLibraryEntry, String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("Agent id 不能为空".to_string());
    }
    let content = crate::storage_config::read_agent_bundle(id)?
        .ok_or_else(|| format!("Agent 不存在：{id}"))?;
    let mut definition = parse_agent_markdown(&content)
        .map_err(|error| format!("Agent 文件非法（{id}）：{error}"))?;
    desic_agent_automation::apply_builtin_deprecation(&mut definition);
    desic_agent_automation::validate_agent_directory_id(id, &definition)?;
    let path = crate::storage_config::agent_bundle_markdown_path(id)?;
    Ok(AgentLibraryEntry {
        updated_at: file_modified_ms(&path),
        definition,
        content,
        path,
    })
}

/// 库内定义快照（勾选名单规范化与运行时载荷共用）。
pub(crate) fn agent_library_definitions() -> Vec<AiAgentDefinition> {
    load_agent_library()
        .into_iter()
        .map(|entry| entry.definition)
        .collect()
}

/// 内置 Agent 文件是否被本地改动（C8 出口条件 4）。
/// 判据：文件内容与内置渲染不一致（忽略行尾换行差异）。
fn agent_is_modified(entry: &AgentLibraryEntry) -> bool {
    if entry.definition.source != AGENT_SOURCE_BUILTIN && !is_builtin_agent_id(&entry.definition.id) {
        return false;
    }
    let Some(expected) = desic_agent_automation::builtin_agent_markdown(&entry.definition.id) else {
        return false;
    };
    entry.content.trim_end() != expected.trim_end()
}

/// 当前启用（激活）的 Skill id 集合。
fn active_skill_ids(app: &tauri::AppHandle) -> HashSet<String> {
    crate::storage_config::load_ai_config(app)
        .map(|config| {
            config
                .enabled_skills
                .into_iter()
                .map(|skill| skill.trim().to_string())
                .filter(|skill| !skill.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn summary_for(
    entry: &AgentLibraryEntry,
    bindings: &[crate::ai_automation::AgentLibraryProfileBinding],
    active_skills: &HashSet<String>,
) -> AiAgentSummary {
    let definition = &entry.definition;
    let enabled_by_profiles = bindings
        .iter()
        .filter(|binding| {
            binding
                .enabled_agent_ids
                .iter()
                .any(|id| desic_agent_automation::resolve_agent_id_alias(id) == definition.id)
        })
        .map(|binding| binding.profile_id.clone())
        .collect::<Vec<_>>();
    let missing_skills = definition
        .skills
        .iter()
        .filter(|skill| !active_skills.contains(skill.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    let missing_account = definition.requires_account
        && bindings
            .iter()
            .filter(|binding| enabled_by_profiles.contains(&binding.profile_id))
            .any(|binding| !binding.has_account);
    let mut summary = definition.to_summary(entry.updated_at);
    summary.enabled_by_profiles = enabled_by_profiles;
    summary.missing_skills = missing_skills;
    summary.missing_account = missing_account;
    summary.modified = agent_is_modified(entry);
    summary
}

fn source_rank(source: &str) -> u8 {
    match source {
        AGENT_SOURCE_BUILTIN => 0,
        AGENT_SOURCE_CUSTOM => 1,
        AGENT_SOURCE_AI => 2,
        _ => 3,
    }
}

fn sort_summaries(summaries: &mut [AiAgentSummary]) {
    summaries.sort_by(|left, right| {
        source_rank(&left.source)
            .cmp(&source_rank(&right.source))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.id.cmp(&right.id))
    });
}

/// C20.5：库列表**默认不返回已下线（`deprecated`）条目**。`include_deprecated` 只给
/// 将来可能出现的"显示已下线"视图用（默认关闭，当前没有 UI 入口）。
pub(crate) fn agent_library_summaries(
    app: &tauri::AppHandle,
) -> Result<Vec<AiAgentSummary>, String> {
    agent_library_summaries_with(app, false)
}

pub(crate) fn agent_library_summaries_with(
    app: &tauri::AppHandle,
    include_deprecated: bool,
) -> Result<Vec<AiAgentSummary>, String> {
    // 内置包安装/升级（带指纹清单）：DB 与运行时都已就绪，能安全区分"旧版本"与
    // "用户改动"。失败只记日志，不影响列表。
    crate::ai_automation::sync_builtin_agent_bundles(app);
    // 旧模板成员按需入库（幂等、只增不改勾选）：契约 C3 的迁移只覆盖"被 Profile
    // 引用"的模板，未被引用的用户模板靠这里补齐，否则升级后在 agents tab 看不到。
    crate::ai_automation::sync_legacy_scheme_agents(app);
    let bindings = crate::ai_automation::agent_library_profile_bindings(app)?;
    let active_skills = active_skill_ids(app);
    let mut summaries = load_agent_library()
        .iter()
        .map(|entry| summary_for(entry, &bindings, &active_skills))
        .collect::<Vec<_>>();
    sort_summaries(&mut summaries);
    Ok(visible_summaries(summaries, include_deprecated))
}

/// C20.5：可见性过滤（纯函数，便于单测覆盖"恢复路径"）。
fn visible_summaries(
    summaries: Vec<AiAgentSummary>,
    include_deprecated: bool,
) -> Vec<AiAgentSummary> {
    if include_deprecated {
        return summaries;
    }
    summaries
        .into_iter()
        .filter(|summary| !summary.deprecated)
        .collect()
}

fn summary_for_id(app: &tauri::AppHandle, id: &str) -> Result<AiAgentSummary, String> {
    let entry = load_agent_library_entry(id)?;
    let bindings = crate::ai_automation::agent_library_profile_bindings(app)?;
    let active_skills = active_skill_ids(app);
    Ok(summary_for(&entry, &bindings, &active_skills))
}

/// 统一换行并保证以单个 `\n` 结尾（用户内容仍是唯一真相，不做语义改写）。
fn normalize_agent_markdown_text(content: &str) -> String {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    format!("{}\n", normalized.trim_end())
}

/// `ai_agent_save` 与工具 `agent.update` 的共用实现。
///
/// 规则（C3 + lead 裁决 3）：以正文 frontmatter 的 id 为准；id 与传入 `id` 不一致 →
/// 报错；内置 id → 报错；新建时 id 已存在 → 报错（提示改 id 或复制）。
pub(crate) fn save_agent_markdown(
    id_param: Option<&str>,
    content: &str,
) -> Result<AgentLibraryEntry, String> {
    if content.trim().is_empty() {
        return Err("Agent 文件内容不能为空".to_string());
    }
    if content.len() > AGENT_MAX_FILE_BYTES {
        return Err(format!(
            "Agent 文件超过 {}KB 上限",
            AGENT_MAX_FILE_BYTES / 1024
        ));
    }
    let text = normalize_agent_markdown_text(content);
    validate_agent_file(&text)?;
    let definition = parse_agent_markdown(&text)?;
    if is_builtin_agent_id(&definition.id) {
        return Err(format!(
            "内置 Agent 不可编辑（{}）；请使用「复制为自定义」后再修改",
            definition.id
        ));
    }
    validate_agent_source_for_save(&definition.id, &definition.source)?;
    let requested_id = id_param
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Some(requested) = requested_id.as_deref() {
        if requested != definition.id {
            return Err(format!(
                "Agent id 与内容不一致：入参 id={requested}，frontmatter id={}",
                definition.id
            ));
        }
    }
    let existing = crate::storage_config::read_agent_bundle(&definition.id)?;
    if existing.is_none() && requested_id.is_none() {
        // 新建：id 由正文提供，撞已有 id 由下面的分支拦；这里只提示用户如何改名。
        // （落地前的重复检查统一放在 existing.is_some() 分支，避免两处规则漂移。）
    }
    if let Some(existing_content) = existing.as_deref() {
        let existing_definition = parse_agent_markdown(existing_content)
            .map_err(|error| format!("已有 Agent 文件非法（{}）：{error}", definition.id))?;
        if existing_definition.source == AGENT_SOURCE_BUILTIN {
            return Err(format!(
                "内置 Agent 不可编辑（{}）；请使用「复制为自定义」后再修改",
                definition.id
            ));
        }
        if requested_id.is_none() {
            return Err(format!(
                "Agent id 已存在：{}；请修改正文 frontmatter 的 id，或使用 ai_agent_duplicate",
                definition.id
            ));
        }
    }
    let write = crate::storage_config::write_agent_bundle(&definition.id, &text, true)?;
    let entry = load_agent_library_entry(&definition.id)?;
    crate::boot_log(&format!(
        "agent library saved {} at {}",
        definition.id,
        write.path.display()
    ));
    Ok(entry)
}

/// 复制 `references/*.md`（`ai_agent_duplicate` 用）。
fn copy_agent_references(from_id: &str, to_id: &str) -> Result<usize, String> {
    let mut copied = 0usize;
    for relative in crate::storage_config::list_agent_reference_paths(from_id)? {
        let Some(content) = crate::storage_config::read_agent_reference(from_id, &relative)? else {
            continue;
        };
        crate::storage_config::write_agent_reference(to_id, &relative, &content)?;
        copied += 1;
    }
    Ok(copied)
}

/// 迁移计划里的自定义 Agent 落盘（幂等：库文件已存在则不重写）。
/// 返回 (本次新建文件数, 用户可见提示)。
pub(crate) fn persist_migrated_agent_bundles(
    plan: &LegacyAgentMigrationPlan,
) -> (usize, Vec<String>) {
    let mut notes = plan.notes.clone();
    let mut written = 0usize;
    for definition in &plan.library_agents {
        let markdown = render_agent_markdown(definition, &definition.body);
        match crate::storage_config::write_agent_bundle(&definition.id, &markdown, false) {
            Ok(result) => {
                if result.wrote {
                    written += 1;
                }
            }
            Err(error) => {
                let note = format!("迁移 Agent {} 失败：{error}", definition.id);
                crate::boot_log(&format!("agent library migration failed: {note}"));
                notes.push(note);
            }
        }
    }
    if written > 0 {
        crate::boot_log(&format!(
            "agent library migration wrote {written} agent file(s)"
        ));
    }
    (written, notes)
}

/// 旧 profile 行（含旧 scheme）→ 勾选名单 + 待落盘库文件 + 提示（纯计划，不落盘）。
pub(crate) fn plan_agent_migration_from_legacy(
    multi_agent_mode: Option<&str>,
    multi_agents: Vec<desic_agent_automation::AiProfileSubAgent>,
    scheme_agents: Vec<desic_agent_automation::AiProfileSubAgent>,
    scheme_instructions: Option<&str>,
    now: i64,
) -> LegacyAgentMigrationPlan {
    plan_legacy_agent_migration(
        &desic_agent_automation::LegacyAgentMigrationInput {
            multi_agent_mode: multi_agent_mode.map(str::to_string),
            legacy_agents: multi_agents,
            scheme_agents,
            scheme_instructions: scheme_instructions.map(str::to_string),
        },
        now,
    )
}

/// C4 运行时载荷：勾选且库中存在的 Agent，按勾选顺序去重，
/// **不做数量截断、不做相关性打分、不做资格静默过滤**。
pub(crate) fn agent_runtime_payload(definition: &AiAgentDefinition) -> Value {
    json!({
        "id": definition.id,
        "name": definition.name,
        "role": definition.role,
        "envelope": definition.envelope,
        "skills": definition.skills,
        "requiresAccount": definition.requires_account,
        "source": definition.source,
        "version": definition.version,
        "summary": definition.summary,
        "body": definition.body,
    })
}

/// 载荷 + 被忽略的已下线 id（C20.5：运行绝不派发，但要如实回报，不静默）。
///
/// 返回 `(agents, ignored_deprecated)`；`ignored_deprecated` 只包含"库中存在但已下线"
/// 的勾选项，未知 id 由 Profile 读取/保存路径负责提示（C3）。
pub(crate) fn collaboration_payload_agents_with_ignored(
    collaboration_enabled: bool,
    enabled_ids: &[String],
) -> (Vec<AiAgentDefinition>, Vec<String>) {
    if !collaboration_enabled {
        return (Vec::new(), Vec::new());
    }
    let definitions = agent_library_definitions();
    let selection = desic_agent_automation::resolve_enabled_agent_selection(enabled_ids, &definitions);
    // 顺序 = 用户勾选顺序（C4：不做数量截断、不排序、不打分）。
    let agents = selection
        .enabled
        .iter()
        .filter_map(|id| definitions.iter().find(|agent| &agent.id == id).cloned())
        .collect::<Vec<_>>();
    (agents, selection.ignored_deprecated)
}


/// 勾选名单里的 id 是否都存在于库中（保存时用于提示丢弃项）。
pub(crate) fn split_known_enabled_agent_ids(ids: &[String]) -> (Vec<String>, Vec<String>) {
    let definitions = agent_library_definitions();
    // 库为空（数据根还没就绪 / 目录被清空）→ **一个勾选都不丢**：宁可保留配置也不错删。
    // 真正的"不存在的 id 丢弃"只在库确实读得到的时候做。
    if definitions.is_empty() {
        let mut seen = std::collections::HashSet::new();
        return (
            ids.iter()
                .map(|id| desic_agent_automation::resolve_agent_id_alias(id))
                .filter(|id| !id.is_empty() && seen.insert(id.clone()))
                .collect(),
            Vec::new(),
        );
    }
    let known = normalize_enabled_agent_ids(ids, &definitions);
    let dropped = ids
        .iter()
        .map(|id| desic_agent_automation::resolve_agent_id_alias(id))
        .filter(|id| !id.is_empty() && !known.contains(id))
        .collect::<Vec<_>>();
    (known, dropped)
}

// ===== 命令（契约 C3）=====

/// C20.5：库列表默认**不返回已下线（`deprecated`）条目** —— 旧 7 个历史角色彻底隐藏，
/// 文件仍保留在 `agents/<id>/AGENTS.md`（把内置表的 `deprecated` 去掉即可恢复）。
///
/// `includeDeprecated` 是显式开关、**默认关闭**；当前没有 UI 入口，只为将来可能的
/// "显示已下线"视图预留（调用方必须自己opt-in，不会误开）。
#[tauri::command]
pub(crate) fn ai_agents_list(
    app: tauri::AppHandle,
    include_deprecated: Option<bool>,
) -> Result<Vec<AiAgentSummary>, String> {
    agent_library_summaries_with(&app, include_deprecated.unwrap_or(false))
}

#[tauri::command]
pub(crate) fn ai_agent_read(
    app: tauri::AppHandle,
    id: String,
) -> Result<AiAgentDetail, String> {
    let summary = summary_for_id(&app, &id)?;
    let entry = load_agent_library_entry(&id)?;
    Ok(AiAgentDetail {
        summary,
        content: entry.content,
    })
}

#[tauri::command]
pub(crate) fn ai_agent_save(
    app: tauri::AppHandle,
    id: Option<String>,
    content: String,
) -> Result<AiAgentSummary, String> {
    let entry = save_agent_markdown(id.as_deref(), &content)?;
    summary_for_id(&app, &entry.definition.id)
}

#[tauri::command]
pub(crate) fn ai_agent_duplicate(
    app: tauri::AppHandle,
    id: String,
    name: Option<String>,
) -> Result<AiAgentSummary, String> {
    let source = load_agent_library_entry(&id)?;
    let requested_name = name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let new_name = match requested_name {
        Some(name) => name.chars().take(AGENT_NAME_MAX_CHARS).collect::<String>(),
        None => {
            let base = format!("{} 副本", source.definition.name);
            base.chars().take(AGENT_NAME_MAX_CHARS).collect::<String>()
        }
    };
    if new_name.trim().is_empty() {
        return Err("复制 Agent 的名称不能为空".to_string());
    }
    let existing = crate::storage_config::list_agent_bundle_ids();
    let new_id = unique_custom_agent_id(&new_name, &source.definition.id, &existing);
    let mut definition = source.definition.clone();
    definition.id = new_id.clone();
    definition.name = new_name;
    definition.source = AGENT_SOURCE_CUSTOM.to_string();
    definition.version = 1;
    definition.created_at = now_ms();
    definition.summary =
        desic_agent_automation::summarize_agent_body(&definition.body);
    validate_agent_definition(&definition)?;
    let markdown = render_agent_markdown(&definition, &definition.body);
    crate::storage_config::write_agent_bundle(&new_id, &markdown, true)?;
    let copied = copy_agent_references(&source.definition.id, &new_id)?;
    crate::boot_log(&format!(
        "agent library duplicated {} -> {} (references: {copied})",
        source.definition.id, new_id
    ));
    summary_for_id(&app, &new_id)
}

#[tauri::command]
pub(crate) fn ai_agent_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let entry = load_agent_library_entry(&id)?;
    if is_builtin_agent_id(&entry.definition.id)
        || entry.definition.source == AGENT_SOURCE_BUILTIN
    {
        return Err(format!("内置 Agent 不可删除：{}", entry.definition.id));
    }
    if !matches!(
        entry.definition.source.as_str(),
        AGENT_SOURCE_CUSTOM | AGENT_SOURCE_AI
    ) {
        return Err(format!(
            "只允许删除 custom/ai 来源的 Agent：{}",
            entry.definition.id
        ));
    }
    crate::storage_config::delete_agent_bundle(&entry.definition.id)?;
    let updated_profiles =
        crate::ai_automation::strip_agent_from_all_profiles(&app, &entry.definition.id)?;
    crate::boot_log(&format!(
        "agent library deleted {} (profiles updated: {})",
        entry.definition.id,
        updated_profiles.join(",")
    ));
    Ok(())
}

#[tauri::command]
pub(crate) async fn ai_agent_generate(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, AiRuntime>,
    description: String,
    name: Option<String>,
    model: Option<String>,
    request_id: Option<String>,
) -> Result<AiAgentDraftOutcome, String> {
    let description = description.trim().to_string();
    if description.is_empty() {
        return Err("Agent 描述不能为空".to_string());
    }
    let name = name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    // 草稿请求必须自带模型配置（probe：不带 config 的请求会被侧车以
    // `path: ["model"] invalid_type` 拒绝 → 「AI 创建 Agent」必失败）。
    let config = resolve_agent_draft_model(
        &crate::storage_config::load_ai_config(&app)?,
        model.as_deref(),
    )?;
    let runtime = runtime.inner().clone();
    let raw = request_agent_draft_from_sidecar(
        &app,
        &runtime,
        &description,
        name.as_deref(),
        &config,
        request_id.as_deref(),
    )
    .await?;
    // 侧车只回模型输出（roleJson）；frontmatter 渲染与白名单归一化在 Rust（C9）。
    agent_draft_from_role_json(Some(&raw), &description, name.as_deref(), now_ms())
}

/// 草稿生成用的模型选择（纯函数，便于单测）：
/// - `requested` 为空 → 当前模型（`activeModelId`，缺失时取第一个）；
/// - `requested` 非空 → 必须精确命中 `id` / `model` / `name`，否则 **Err** 并列出可用模型
///   （绝不静默回落到当前模型——用户选了不存在的模型必须看得见）。
pub(crate) fn resolve_agent_draft_model(
    config: &desic_storage_config::AiConfig,
    requested: Option<&str>,
) -> Result<desic_storage_config::AiConfig, String> {
    let selector = requested.map(str::trim).filter(|value| !value.is_empty());
    let selected = match selector {
        None => config
            .models
            .iter()
            .find(|model| model.id == config.active_model_id)
            .or_else(|| config.models.first())
            .ok_or_else(|| "尚未配置可用的 AI 模型".to_string())?,
        Some(selector) => config
            .models
            .iter()
            .find(|model| model.id == selector || model.model == selector || model.name == selector)
            .ok_or_else(|| {
                let available = config
                    .models
                    .iter()
                    .map(|model| model.id.clone())
                    .collect::<Vec<_>>();
                if available.is_empty() {
                    format!("未找到模型 {selector}：尚未配置任何 AI 模型")
                } else {
                    format!(
                        "未找到模型 {selector}；可用模型：{}",
                        available.join("、")
                    )
                }
            })?,
    };
    let mut next = config.clone();
    next.active_model_id = selected.id.clone();
    next.provider = Some(selected.provider.clone());
    next.model = selected.model.clone();
    next.base_url = selected.base_url.clone();
    next.api_key = selected.api_key.clone();
    next.permission_mode = selected.permission_mode.clone();
    next.reasoning_depth = selected.reasoning_depth.clone();
    next.context_window = selected.context_window;
    Ok(next)
}

/// 草稿请求载荷（纯函数，便于单测）：`config` 六键与标题生成同款，
/// 并额外带一个顶层 `model` 供侧车兜底。
pub(crate) fn build_agent_draft_payload(
    request_id: &str,
    description: &str,
    name: Option<&str>,
    config: &desic_storage_config::AiConfig,
) -> Value {
    json!({
        "type": "generateAgentDraft",
        "requestId": request_id,
        "description": description,
        "name": name,
        // 顶层兜底：侧车若直接从根字段取 model 也能工作。
        "model": config.model.clone(),
        "config": crate::ai_automation::with_request_timeout(json!({
            "provider": config.provider.clone().unwrap_or_else(|| "openai-compatible".to_string()),
            "model": config.model.clone(),
            "baseUrl": config.base_url.clone(),
            "apiKey": config.api_key.clone(),
            "contextWindow": config.context_window,
            "permissionMode": "advisor",
            "reasoningDepth": "none",
        })),
        "prompts": {
            "system": agent_draft_system_prompt(),
            "user": build_agent_draft_user_prompt(description, name),
            "messages": agent_draft_few_shot_messages()
                .into_iter()
                .map(|(role, content)| json!({ "role": role, "content": content }))
                .collect::<Vec<_>>(),
        },
    })
}

/// P3：本地取消——立刻让等待方收到 `Err("草稿生成已取消")` 并移除 pending 表项
/// （不依赖侧车回包，因此不会泄漏；侧车稍后回的 `ok:false` 因表项已移除会被忽略）。
/// 返回是否真的找到了在等结果的一方。
pub(crate) fn cancel_agent_draft_locally(runtime: &AiRuntime, request_id: &str) -> bool {
    let requested = request_id.trim();
    let Some(waiter) = runtime
        .pending_agent_draft_commands
        .lock()
        .ok()
        .and_then(|mut pending| {
            // C17.3：id 为空或未知时兜底取消**当前唯一在途**的草稿请求
            // （草稿生成同时至多一个在途），这样"取消一个还没吐字的请求"也能成功。
            let key = if !requested.is_empty() && pending.contains_key(requested) {
                Some(requested.to_string())
            } else if pending.len() == 1 {
                pending.keys().next().cloned()
            } else {
                None
            };
            key.and_then(|key| pending.remove(&key))
        })
    else {
        return false;
    };
    let _ = waiter.send(Err("草稿生成已取消".to_string()));
    true
}

/// P3：取消 AI 创建 Agent 的草稿生成（幂等）。
///
/// - 找到在等结果的请求 → 通知侧车 `cancelAgentDraft`，并立刻让等待方收到
///   `Err("草稿生成已取消")`、清理 pending 表项；
/// - 请求不存在（已完成 / 已取消 / 从未发出）→ 直接 `Ok(())`，不报错。
#[tauri::command]
pub(crate) async fn ai_agent_generate_cancel(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, AiRuntime>,
    request_id: String,
) -> Result<(), String> {
    let runtime = runtime.inner().clone();
    // 先本地取消（等待方立刻返回且 pending 一定被清理），再尽力通知侧车停止生成。
    let cancelled = cancel_agent_draft_locally(&runtime, &request_id);
    let request_id = request_id.trim().to_string();
    if !request_id.is_empty() {
        if let Err(error) = send_ai_sidecar_command(
            &app,
            &runtime,
            json!({ "type": "cancelAgentDraft", "requestId": request_id }),
        )
        .await
        {
            crate::boot_log(&format!("cancelAgentDraft 通知侧车失败（本地已取消）: {error}"));
        }
    }
    if cancelled {
        crate::boot_log("agent draft cancelled by user");
    }
    Ok(())
}

/// C17.3：UI 自带的 requestId 只接受 `^[A-Za-z0-9_-]{8,64}$`（逐字照契约）。
pub(crate) fn is_valid_agent_draft_request_id(value: &str) -> bool {
    (8..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// C17.3：合法就用 UI 的 id（UI 从点击那刻起就有稳定标识，可严格按 id 过滤与取消），
/// 非法或缺失则用自生成的 id。**此后该请求的所有 `agentDraftDelta` /
/// `agentDraftResult` 都用同一 id**——请求载荷、pending 表键、侧车回包匹配三处同源。
pub(crate) fn resolve_agent_draft_request_id(requested: Option<&str>, generated: String) -> String {
    match requested.map(str::trim) {
        Some(requested) if is_valid_agent_draft_request_id(requested) => requested.to_string(),
        _ => generated,
    }
}

/// 一次性侧车请求（契构 C9）：`generateAgentDraft` → `agentDraftResult`。
///
/// 提示词真相源在 Rust（内容包 §2）：随请求附带 `prompts`（system / user /
/// few-shot messages），侧车可直接使用，避免两份文案漂移；`type` 与
/// `requestId`/`description`/`name` 四个字段严格照契约。
pub(crate) async fn request_agent_draft_from_sidecar(
    app: &tauri::AppHandle,
    runtime: &AiRuntime,
    description: &str,
    name: Option<&str>,
    config: &desic_storage_config::AiConfig,
    requested_request_id: Option<&str>,
) -> Result<String, String> {
    let request_id = resolve_agent_draft_request_id(
        requested_request_id,
        format!("agent-draft-{}-{}", now_ms(), crate::ai_automation::unique_suffix()),
    );
    let (result_tx, result_rx) = oneshot::channel();
    runtime
        .pending_agent_draft_commands
        .lock()
        .map_err(|error| error.to_string())?
        .insert(request_id.clone(), result_tx);
    let payload = build_agent_draft_payload(&request_id, description, name, config);
    let result = async {
        send_ai_sidecar_command(app, runtime, payload).await?;
        timeout(Duration::from_secs(AI_AGENT_DRAFT_TIMEOUT_SECS), result_rx)
            .await
            .map_err(|_| "AI Agent 草稿生成超时".to_string())?
            .map_err(|_| "AI Agent 草稿响应通道已关闭".to_string())?
    }
    .await;
    if let Ok(mut pending) = runtime.pending_agent_draft_commands.lock() {
        pending.remove(&request_id);
    }
    result
}

// ===== 工具宿主（契约 C6）=====

/// `agent.list` 工具（C20.5：与 `ai_agents_list` 同口径 —— **不含已下线条目**）。
/// 主 Agent 因此看不到旧角色，也就不会去点名它们。
pub(crate) fn tool_agent_list(app: &tauri::AppHandle) -> Result<Value, String> {
    Ok(json!({
        "agents": agent_library_summaries(app)?,
        "ignoredDeprecatedAgents": desic_agent_automation::deprecated_builtin_agent_ids(),
    }))
}

pub(crate) fn tool_agent_read(_app: &tauri::AppHandle, id: &str) -> Result<Value, String> {
    let entry = load_agent_library_entry(id)?;
    Ok(json!({
        "id": entry.definition.id,
        "name": entry.definition.name,
        "role": entry.definition.role,
        "content": entry.content,
    }))
}

/// `agent.create` 的归一化结果（纯函数产物，便于单测覆盖校验路径）。
#[derive(Debug)]
pub(crate) struct AgentCreateInput {
    pub name: String,
    pub role: String,
    pub envelope: String,
    pub skills: Vec<String>,
    pub requires_account: bool,
    pub body: String,
    pub references: Vec<(String, String)>,
    pub warnings: Vec<String>,
}

/// `agent.create` 入参校验与归一化（P1 R2-1 + C15）。
///
/// - C15：AGENTS.md 不再有 `scopes`，工具也不再接受该入参（传了会被忽略）。
/// - `envelope` 提供但非法 → **Err**；缺失 → 由"取更严者"规则决定
///   （声明 `risk` 或 `role == account_risk`）。
pub(crate) fn normalize_agent_create_input(input: &Value) -> Result<AgentCreateInput, String> {
    let name = input
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if name.is_empty() {
        return Err("agent.create 需要 name".to_string());
    }
    if name.chars().count() > AGENT_NAME_MAX_CHARS {
        return Err(format!(
            "Agent 名称长度必须为 1-{AGENT_NAME_MAX_CHARS} 个字符"
        ));
    }
    let responsibility = input
        .get("responsibility")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if responsibility.is_empty() {
        return Err("agent.create 需要 responsibility".to_string());
    }
    let role = desic_agent_automation::normalize_agent_create_role(
        input.get("role").and_then(Value::as_str).unwrap_or("custom"),
    );

    let skills = input
        .get("skills")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    // envelope：缺失 → None（走"取更严者"）；提供但非法 → Err。
    let raw_envelope = input
        .get("envelope")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let declared_envelope = desic_agent_automation::parse_agent_envelope(raw_envelope)
        .map_err(|error| format!("agent.create 入参非法：{error}"))?;
    let envelope = resolve_agent_envelope(declared_envelope.as_deref(), &role);
    let requires_account = input
        .get("requiresAccount")
        .or_else(|| input.get("requires_account"))
        .and_then(Value::as_bool)
        .unwrap_or(envelope == desic_agent_automation::AGENT_ENVELOPE_RISK);

    // C15：`scopes` 入参已移除，create 路径不再产生归一化提示（字段保留给后续扩展）。
    let warnings: Vec<String> = Vec::new();
    let mut references = Vec::new();
    if let Some(items) = input.get("references").and_then(Value::as_array) {
        for reference in items {
            let path = reference
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            if path.is_empty() {
                continue;
            }
            // 简写（不带 `references/` 前缀）统一归一化后由存储层二次校验。
            let normalized = if path.contains('/') {
                path
            } else {
                format!(
                    "{}/{}",
                    desic_agent_automation::AGENT_REFERENCES_DIR,
                    path
                )
            };
            let content = reference
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            references.push((normalized, content));
        }
    }

    Ok(AgentCreateInput {
        name,
        role,
        envelope,
        skills,
        requires_account,
        body: render_agent_skeleton(&responsibility),
        references,
        warnings,
    })
}

/// `agent.create`：用 `responsibility` 渲染五段骨架正文，`source = "ai"`。
pub(crate) fn tool_agent_create(app: &tauri::AppHandle, input: &Value) -> Result<Value, String> {
    let normalized = normalize_agent_create_input(input)?;
    for warning in &normalized.warnings {
        crate::boot_log(&format!("agent.create warning: {warning}"));
    }
    let AgentCreateInput {
        name,
        role,
        envelope,
        skills,
        requires_account,
        body,
        references,
        warnings,
        ..
    } = normalized;
    let existing = crate::storage_config::list_agent_bundle_ids();
    let id = unique_custom_agent_id(&name, "", &existing);
    let mut definition = AiAgentDefinition {
        id: id.clone(),
        name,
        role,
        envelope,
        skills,
        requires_account,
        source: AGENT_SOURCE_AI.to_string(),
        version: 1,
        created_at: now_ms(),
        summary: String::new(),
        body,
        deprecated: false,
        scopes_deprecated: false,
        path: PathBuf::new(),
    };
    definition.refresh_summary();
    validate_agent_definition(&definition)?;
    let markdown = render_agent_markdown(&definition, &definition.body);
    let write = crate::storage_config::write_agent_bundle(&id, &markdown, true)?;
    let mut references_written = 0usize;
    for (path, content) in &references {
        crate::storage_config::write_agent_reference(&id, path, content)?;
        references_written += 1;
    }
    crate::boot_log(&format!(
        "agent tool created {} at {} (references: {references_written})",
        id,
        write.path.display()
    ));
    let _ = app;
    Ok(json!({
        "id": id,
        "path": write.path.to_string_lossy(),
        "name": definition.name,
        "role": definition.role,
        // 增量字段：回填等归一化提示（C6 冻结的四个键仍在，模型可忽略多余键）。
        "warnings": warnings,
    }))
}

/// `agent.update`：完整 AGENTS.md 覆盖，frontmatter 必须合法且 id 匹配；
/// 内置 Agent 拒绝（提示改用复制）。
pub(crate) fn tool_agent_update(
    app: &tauri::AppHandle,
    id: &str,
    content: &str,
) -> Result<Value, String> {
    if is_builtin_agent_id(id.trim()) {
        return Err(format!(
            "内置 Agent 不可编辑（{}）；请使用 agent.duplicate 复制为自定义后再修改",
            id.trim()
        ));
    }
    let entry = save_agent_markdown(Some(id), content)?;
    let _ = app;
    Ok(json!({
        "id": entry.definition.id,
        "path": entry.path.to_string_lossy(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use desic_agent_automation::AiProfileSubAgent;

    /// 旧 Profile / 旧模板成员（C15：其中的 `scopes` 会被丢弃，不写入新文件）。
    fn legacy_agent(id: &str, name: &str, role: &str, responsibility: &str, scopes: &[&str]) -> AiProfileSubAgent {
        AiProfileSubAgent {
            id: id.to_string(),
            name: name.to_string(),
            role: role.to_string(),
            responsibility: responsibility.to_string(),
            scopes: scopes.iter().map(|scope| (*scope).to_string()).collect(),
            required: false,
            enabled: true,
        }
    }

    /// 迁移测试用的库 id（避免碰到真实用户 Agent）。
    const MIGRATION_TEST_IDS: [&str; 3] = [
        "agent-library-migration-test-alpha",
        "agent-library-migration-test-beta",
        "agent-library-migration-test-gamma",
    ];

    fn cleanup_migration_test_agents() {
        for id in MIGRATION_TEST_IDS {
            let _ = crate::storage_config::delete_agent_bundle(id);
        }
    }

    #[test]
    fn agent_library_payload_shape_matches_contract_c4() {
        let definition = desic_agent_automation::builtin_agent_definition("desic-market-structure")
            .expect("builtin");
        let payload = agent_runtime_payload(&definition);
        let object = payload.as_object().expect("object");
        let mut keys = object.keys().cloned().collect::<Vec<_>>();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "body".to_string(),
                "envelope".to_string(),
                "id".to_string(),
                "name".to_string(),
                "requiresAccount".to_string(),
                "role".to_string(),
                "skills".to_string(),
                "source".to_string(),
                "summary".to_string(),
                "version".to_string(),
            ],
            "C15：载荷不再有 scopes"
        );
        assert!(payload["body"].as_str().unwrap_or_default().contains("## 职责"));
        assert_eq!(
            payload["summary"].as_str().unwrap_or_default(),
            "检查多周期价格结构、趋势、波动、成交、盘口和关键失效位，明确事实与推断。"
        );
    }

    #[test]
    fn agent_library_summary_serialization_uses_camel_case() {
        let definition = desic_agent_automation::builtin_agent_definition("desic-account-risk")
            .expect("builtin");
        let summary = definition.to_summary(1_700_000_000_000);
        let value = serde_json::to_value(&summary).expect("serialize");
        assert!(value.get("requiresAccount").is_some());
        assert!(value.get("enabledByProfiles").is_some());
        assert!(value.get("missingSkills").is_some());
        assert!(value.get("missingAccount").is_some());
        assert!(value.get("modified").is_some());
        assert!(value.get("updatedAt").is_some());
        // C15：列表契约不再有 `scopes`，改为一次性 `scopesDeprecated` 提示。
        assert!(value.get("scopes").is_none(), "C15 起不再序列化 scopes");
        assert_eq!(value.get("scopesDeprecated"), Some(&serde_json::json!(false)));
        let detail = AiAgentDetail {
            summary,
            content: "content".to_string(),
        };
        let detail_value = serde_json::to_value(&detail).expect("serialize detail");
        assert_eq!(detail_value["content"], "content");
        assert_eq!(detail_value["id"], "desic-account-risk");
    }

    /// C8 出口条件 6：老 profile（off/auto/custom）+ 老模板条目迁移后勾选名单与
    /// 库文件正确，且**迁移幂等**（二次运行不重复建文件）。
    #[test]
    fn agent_library_migration_is_idempotent_on_disk() {
        cleanup_migration_test_agents();
        let now = 1_700_000_000_000_i64;

        // off：空勾选、不建文件。
        let off = plan_agent_migration_from_legacy(Some("off"), Vec::new(), Vec::new(), None, now);
        assert!(off.enabled_agent_ids.is_empty());
        assert!(off.library_agents.is_empty());

        // auto：8 个内置 id，不需要库文件。
        let auto = plan_agent_migration_from_legacy(Some("auto"), Vec::new(), Vec::new(), None, now);
        // C20：auto（旧全池）迁移到**新默认启用集**（4 个流程角色）；
        // 历史 7 个角色文件保留、可手动勾选，但不再默认启用。
        assert_eq!(
            auto.enabled_agent_ids,
            desic_agent_automation::default_enabled_agent_ids()
        );
        assert_eq!(auto.enabled_agent_ids.len(), 4);
        assert!(auto.enabled_agent_ids.iter().all(|id| id.starts_with("desic-")));
        assert!(auto.library_agents.is_empty());

        // custom + 旧模板条目：旧 auto-* id 走 alias；自定义条目落库文件。
        let custom = plan_agent_migration_from_legacy(
            Some("custom"),
            vec![
                legacy_agent(
                    "auto-market-structure",
                    "市场结构",
                    "market_structure",
                    "检查价格结构。",
                    &["market"],
                ),
                legacy_agent(
                    MIGRATION_TEST_IDS[0],
                    "迁移测试自定义",
                    "custom",
                    "迁移测试职责说明。",
                    &["market"],
                ),
            ],
            vec![legacy_agent(
                MIGRATION_TEST_IDS[1],
                "迁移测试模板",
                "custom",
                "模板里的职责。",
                &["intelligence"],
            )],
            Some("旧模板指令"),
            now,
        );
        assert!(custom
            .enabled_agent_ids
            .contains(&"desic-market-structure".to_string()));
        assert!(custom
            .enabled_agent_ids
            .contains(&MIGRATION_TEST_IDS[0].to_string()));
        assert!(custom
            .enabled_agent_ids
            .contains(&MIGRATION_TEST_IDS[1].to_string()));
        assert_eq!(custom.library_agents.len(), 2);
        assert!(custom
            .notes
            .iter()
            .any(|note| note.contains("instructions")));

        let (first_written, _) = persist_migrated_agent_bundles(&custom);
        assert_eq!(first_written, 2, "首次迁移应写入 2 个库文件");
        let (second_written, second_notes) = persist_migrated_agent_bundles(&custom);
        assert_eq!(second_written, 0, "二次迁移必须幂等（不重复建文件）");
        assert!(second_notes
            .iter()
            .all(|note| !note.contains("失败")));

        // 勾选名单在库中可解析（自定义条目与内置条目都能被 normalize 保留）。
        let definitions = agent_library_definitions();
        let normalized =
            desic_agent_automation::normalize_enabled_agent_ids(&custom.enabled_agent_ids, &definitions);
        assert!(normalized.contains(&MIGRATION_TEST_IDS[0].to_string()));
        assert!(normalized.contains(&MIGRATION_TEST_IDS[1].to_string()));
        assert!(normalized.contains(&"desic-market-structure".to_string()));

        // 落盘文件可解析、source=custom、正文取自迁移骨架。
        let migrated = load_agent_library_entry(MIGRATION_TEST_IDS[0]).expect("migrated entry");
        assert_eq!(migrated.definition.source, AGENT_SOURCE_CUSTOM);
        assert!(migrated.definition.body.contains("迁移测试职责说明。"));
        assert!(!agent_is_modified(&migrated));

        cleanup_migration_test_agents();
    }

    #[test]
    fn agent_library_save_rules_reject_builtin_and_id_mismatch() {
        // 内置 id 一律拒绝（C8 出口条件 7）。
        let builtin_markdown =
            desic_agent_automation::builtin_agent_markdown("desic-market-structure")
                .expect("builtin markdown");
        assert!(save_agent_markdown(None, &builtin_markdown).is_err());
        assert!(save_agent_markdown(Some("desic-market-structure"), &builtin_markdown).is_err());

        // id 与入参不一致 → 报错（C8 出口条件 7）。
        let custom = "---\nid: agent-library-save-test\nname: 保存测试\nrole: custom\nscopes: [market]\n---\n## 职责\n保存测试职责。\n";
        assert!(save_agent_markdown(Some("other-id"), custom).is_err());

        // 非法 frontmatter 被 Rust 权威校验拦下。
        let invalid = "---\nid: agent-library-save-test\nname: 保存测试\nrole: Market\n---\n## 职责\n职责。\n";
        assert!(save_agent_markdown(None, invalid).is_err());

        // 超 200KB 拦下。
        let oversized = format!(
            "---\nid: agent-library-save-test\nname: 保存测试\nrole: custom\n---\n{}",
            "字".repeat(AGENT_MAX_FILE_BYTES)
        );
        assert!(save_agent_markdown(None, &oversized).is_err());
    }

    /// 验收手册 B7 + C15：`agent.create` 的 `envelope` 校验必须硬报错；
    /// `scopes` 入参已移除（传了忽略，不入库、不报错）。
    #[test]
    fn agent_library_create_input_is_strict_on_envelope_and_ignores_scopes() {
        let base = |extra: serde_json::Value| {
            let mut value = json!({
                "name": "创建测试",
                "role": "custom",
                "responsibility": "创建测试职责。",
            });
            let object = value.as_object_mut().expect("object");
            for (key, item) in extra.as_object().expect("extra object") {
                object.insert(key.clone(), item.clone());
            }
            value
        };

        // 非法 envelope：直接报错，不得降级为 standard。
        let error = normalize_agent_create_input(&base(json!({ "envelope": "none" })))
            .expect_err("invalid envelope must fail");
        assert!(error.contains("envelope"), "{error}");

        // C15：scopes 入参被忽略（含白名单外的值也不报错），不再进入库定义。
        let normalized = normalize_agent_create_input(&base(json!({ "scopes": ["shell", "market"] })))
            .expect("scopes input is ignored");
        assert!(normalized.warnings.is_empty());
        assert!(normalized.skills.is_empty());

        // 缺省 envelope 时 role=account_risk 仍取严为 risk + requiresAccount。
        let normalized = normalize_agent_create_input(&base(json!({ "role": "account_risk" })))
            .expect("create input");
        assert_eq!(normalized.envelope, "risk");
        assert!(normalized.requires_account);

        // 显式 envelope: risk 也取严。
        let normalized = normalize_agent_create_input(&base(json!({ "envelope": "risk" })))
            .expect("create input");
        assert_eq!(normalized.envelope, "risk");
        assert!(normalized.requires_account);

        // 普通角色 + 缺省 envelope → standard。
        let normalized = normalize_agent_create_input(&base(json!({}))).expect("create input");
        assert_eq!(normalized.envelope, "standard");
        assert!(!normalized.requires_account);
    }

    /// P2 收口：**没有任何 Profile 引用**的旧模板行，其成员也要入库（只增不勾选），
    /// 且重复执行幂等（第二次 wrote=0）、不动 Profile 勾选列、不删旧表行。
    #[test]
    fn agent_library_imports_unreferenced_scheme_members_idempotently() {
        use rusqlite::Connection;

        let conn = Connection::open_in_memory().expect("open in-memory database");
        crate::ai_automation::migrate_ai_automation(&conn).expect("migrate automation schema");

        let scheme_member = "agent-library-scheme-sweep-test";
        let agents_json = serde_json::json!([
            {
                "id": scheme_member,
                "name": "模板成员",
                "role": "custom",
                "responsibility": "模板成员职责说明。",
                "scopes": ["market"],
                "required": false,
                "enabled": true
            }
        ])
        .to_string();
        conn.execute(
            "INSERT INTO ai_agent_schemes(id,name,description,agents_json,created_at,updated_at)
             VALUES('scheme-sweep-test','模板','',?1,1,1)",
            rusqlite::params![agents_json],
        )
        .expect("insert legacy scheme row");
        // 一个引用该模板的 Profile：勾选列必须保持原状（不得被迁移写入）。
        conn.execute(
            "INSERT INTO ai_agent_profiles(
               id,name,enabled,mode,environment,symbols_json,scan_interval_minutes,
               skill_ids_json,skill_versions_json,history_lookback_days,
               similarity_window_minutes,entry_tolerance_bps,max_runtime_seconds,
               min_wake_interval_seconds,max_runs_per_hour,allowed_wake_condition_types_json,
               multi_agent_scheme_id,enabled_agent_ids_json,created_at,updated_at
             ) VALUES('profile-sweep-test','Test',1,'advisor','demo','[\"BTC-USDT-SWAP\"]',15,
               '[]','{}',30,10,30,180,60,12,'[]','scheme-sweep-test','[]',1,1)",
            [],
        )
        .expect("insert profile row");

        let _ = crate::storage_config::delete_agent_bundle(scheme_member);
        crate::ai_automation::clear_legacy_scheme_migration_marker_for_test(&conn);

        let (written, notes) = crate::ai_automation::sync_legacy_scheme_rows(&conn);
        assert!(written >= 1, "未被引用的模板成员必须入库：{notes:?}");
        let entry = load_agent_library_entry(scheme_member).expect("library entry");
        assert_eq!(
            entry.definition.source,
            desic_agent_automation::AGENT_SOURCE_CUSTOM
        );
        assert!(entry.definition.body.contains("模板成员职责说明。"));

        // 幂等：第二次调用不再写盘（已处理过的 scheme 行被标记）。
        let (second_written, _) = crate::ai_automation::sync_legacy_scheme_rows(&conn);
        assert_eq!(second_written, 0, "二次扫描必须幂等");

        // 勾选列与旧表行都不受影响。
        let enabled: String = conn
            .query_row(
                "SELECT enabled_agent_ids_json FROM ai_agent_profiles WHERE id='profile-sweep-test'",
                [],
                |row| row.get(0),
            )
            .expect("profile enabled ids");
        assert_eq!(enabled, "[]", "模板入库不得改动任何 Profile 的勾选名单");
        let scheme_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM ai_agent_schemes", [], |row| row.get(0))
            .expect("scheme rows");
        assert_eq!(scheme_rows, 1, "旧模板行必须保留（回滚需要）");

        // 被引用模板的既有迁移路径不受影响（同一夹具，profile 迁移仍能拿到成员）。
        let plan = crate::agent_library::plan_agent_migration_from_legacy(
            Some("off"),
            Vec::new(),
            vec![desic_agent_automation::AiProfileSubAgent {
                id: scheme_member.to_string(),
                name: "模板成员".to_string(),
                role: "custom".to_string(),
                responsibility: "模板成员职责说明。".to_string(),
                scopes: vec!["market".to_string()],
                required: false,
                enabled: true,
            }],
            None,
            1,
        );
        assert_eq!(plan.enabled_agent_ids, vec![scheme_member.to_string()]);
        assert_eq!(plan.library_agents.len(), 1);

        let _ = crate::storage_config::delete_agent_bundle(scheme_member);
    }

    /// C14 ① 开关关闭 + 勾选 3 个 → 载荷为空，且**保存后勾选列仍是那 3 个**。
    #[test]
    fn agent_library_collaboration_toggle_gates_payload_without_clearing_selection() {
        use rusqlite::Connection;

        // C20.5：默认启用集（4 个流程角色）里的前 3 个 —— 已下线的历史角色不再派发。
        let payload_ids = vec![
            "desic-data-digest".to_string(),
            "desic-account-state".to_string(),
            "desic-decision-proposal".to_string(),
        ];

        // ① 关闭：载荷为空（闸门），勾选列表原样保留。
        assert!(collaboration_payload_agents_with_ignored(false, &payload_ids).0.is_empty());
        // ② 开启：载荷含 3 个（库中存在且未下线的内置条目）。
        let payload = collaboration_payload_agents_with_ignored(true, &payload_ids).0;
        assert_eq!(payload.len(), 3, "开启后必须按勾选名单注入");
        assert_eq!(payload[0].id, "desic-data-digest");
        assert_eq!(payload[2].id, "desic-decision-proposal");
        assert!(payload.iter().all(|agent| !agent.body.is_empty()));
        // 开启但名单为空 → 仍是空载荷（"已开启但未勾选"，行为等价独立工作）。
        assert!(collaboration_payload_agents_with_ignored(true, &[]).0.is_empty());
        // 未勾选/重复 id 仍在闸门内去重。
        let deduped = collaboration_payload_agents_with_ignored(
            true,
            &["desic-data-digest".to_string(), "desic-data-digest".to_string()],
        )
        .0;
        assert_eq!(deduped.len(), 1);

        // 保存路径：关闭开关不得清空勾选列。
        let conn = Connection::open_in_memory().expect("open in-memory database");
        crate::ai_automation::migrate_ai_automation(&conn).expect("migrate automation schema");
        let profile = crate::ai_automation::normalize_profile_for_test(
            serde_json::from_value::<crate::ai_automation::AiAgentProfileInput>(
                serde_json::json!({
                    "name": "协作开关测试",
                    "symbols": ["BTC-USDT-SWAP"],
                    "collaborationEnabled": false,
                    "enabledAgentIds": payload_ids,
                }),
            )
            .expect("deserialize profile input"),
        )
        .expect("normalize profile input");
        crate::ai_automation::upsert_profile_row_for_test(
            &conn,
            &profile,
            "profile-collaboration-test",
            1_000,
            2_000,
        )
        .expect("insert profile row");
        let loaded = crate::ai_automation::load_profile_for_test(&conn, "profile-collaboration-test")
            .expect("load profile");
        assert!(!loaded.collaboration_enabled, "关闭状态必须被持久化");
        assert_eq!(loaded.enabled_agent_ids, payload_ids, "关开关不得清空勾选");
        assert!(collaboration_payload_agents_with_ignored(
            loaded.collaboration_enabled,
            &loaded.enabled_agent_ids
        )
        .0
        .is_empty());

        // 重新开启：勾选立即恢复（同一行，不改名单）。
        let reopened = crate::ai_automation::normalize_profile_for_test(
            serde_json::from_value::<crate::ai_automation::AiAgentProfileInput>(
                serde_json::json!({
                    "id": "profile-collaboration-test",
                    "name": "协作开关测试",
                    "symbols": ["BTC-USDT-SWAP"],
                    "collaborationEnabled": true,
                    "enabledAgentIds": loaded.enabled_agent_ids.clone(),
                }),
            )
            .expect("deserialize profile input"),
        )
        .expect("normalize profile input");
        crate::ai_automation::upsert_profile_row_for_test(
            &conn,
            &reopened,
            "profile-collaboration-test",
            1_000,
            3_000,
        )
        .expect("update profile row");
        let reloaded =
            crate::ai_automation::load_profile_for_test(&conn, "profile-collaboration-test")
                .expect("reload profile");
        assert!(reloaded.collaboration_enabled);
        assert_eq!(
            collaboration_payload_agents_with_ignored(true, &reloaded.enabled_agent_ids)
                .0
                .len(),
            3
        );

        // C14 兼容：旧前端不带 `collaborationEnabled` 字段时保留库中现值（不得静默关闭）。
        let mut legacy_ui_save = crate::ai_automation::normalize_profile_for_test(
            serde_json::from_value::<crate::ai_automation::AiAgentProfileInput>(
                serde_json::json!({
                    "id": "profile-collaboration-test",
                    "name": "协作开关测试",
                    "symbols": ["BTC-USDT-SWAP"],
                    "enabledAgentIds": reloaded.enabled_agent_ids.clone(),
                }),
            )
            .expect("deserialize legacy-UI profile input"),
        )
        .expect("normalize legacy-UI profile input");
        assert!(legacy_ui_save.collaboration_enabled.is_none());
        crate::ai_automation::apply_collaboration_default_for_test(
            &conn,
            &mut legacy_ui_save,
            "profile-collaboration-test",
        );
        crate::ai_automation::upsert_profile_row_for_test(
            &conn,
            &legacy_ui_save,
            "profile-collaboration-test",
            1_000,
            4_000,
        )
        .expect("update profile row");
        let after_legacy_save =
            crate::ai_automation::load_profile_for_test(&conn, "profile-collaboration-test")
                .expect("reload profile");
        assert!(
            after_legacy_save.collaboration_enabled,
            "字段缺失时不得把已开启的协作静默关掉"
        );
        assert_eq!(after_legacy_save.enabled_agent_ids, payload_ids);
    }

    /// C20.5：库列表**默认不含已下线（deprecated）条目**；`includeDeprecated` 是显式开关
    /// （默认关闭、当前无 UI 入口）；把内置表的 `deprecated` 去掉即恢复可见。
    #[test]
    fn agent_library_hides_deprecated_builtins_by_default() {
        let mut all = Vec::new();
        let mut deprecated_definition = None;
        for id in desic_agent_automation::builtin_agent_ids() {
            // 文件里没有 `deprecated` 字段（正文是唯一真相）：解析结果是 false，
            // 由内置表标注后才与 builtin_agent_definition 一致。
            let markdown = desic_agent_automation::builtin_agent_markdown(&id).expect("markdown");
            let mut parsed =
                desic_agent_automation::parse_agent_markdown(&markdown).expect("parse builtin");
            assert!(!parsed.deprecated, "{id}: 文件里不应带 deprecated");
            desic_agent_automation::apply_builtin_deprecation(&mut parsed);
            let spec = desic_agent_automation::builtin_agent_definition(&id).expect("definition");
            assert_eq!(parsed.deprecated, spec.deprecated, "{id}");
            if parsed.deprecated {
                deprecated_definition = Some(parsed.clone());
            }
            all.push(parsed.to_summary(0));
        }
        assert_eq!(all.len(), 11, "内置文件全部保留（含历史角色）");
        // 默认视图：只剩当前 4 个流程角色。
        let default_view = visible_summaries(all.clone(), false);
        assert_eq!(default_view.len(), 4, "默认只显示当前角色");
        assert!(default_view.iter().all(|summary| !summary.deprecated));
        assert!(default_view.iter().all(|summary| summary.id != "desic-smart-money"));
        assert!(default_view
            .iter()
            .any(|summary| summary.id == "desic-contrarian-review"));
        // 显式开关（默认关闭）：将来做"显示已下线"视图时用得上。
        assert_eq!(visible_summaries(all, true).len(), 11);

        // 恢复路径：`deprecated` 置回 false → 立刻回到默认可见集。
        let mut restored = deprecated_definition.expect("deprecated builtin");
        assert!(desic_agent_automation::is_deprecated_agent_id(&restored.id));
        restored.deprecated = false;
        let restored_id = restored.id.clone();
        let view = visible_summaries(vec![restored.to_summary(0)], false);
        assert_eq!(view.len(), 1);
        assert_eq!(view[0].id, restored_id);
    }

    /// C20.5：已下线的勾选**绝不进载荷**，但出现在丢弃清单里（不静默）；未知 id 不算
    /// "已下线"（它走 C3 的"不存在"路径，由 Profile 读取/保存提示）。
    #[test]
    fn collaboration_payload_drops_deprecated_agents_and_reports_them() {
        let ids = vec![
            "desic-data-digest".to_string(),
            "desic-smart-money".to_string(),
            "desic-historical-analogy".to_string(),
            "not-in-library".to_string(),
        ];
        let (agents, ignored) = collaboration_payload_agents_with_ignored(true, &ids);
        assert_eq!(agents.len(), 1, "{agents:?}");
        assert_eq!(agents[0].id, "desic-data-digest");
        assert_eq!(
            ignored,
            vec![
                "desic-smart-money".to_string(),
                "desic-historical-analogy".to_string()
            ]
        );
        // 关闭闸门 → 空载荷（且不报"已忽略"，因为压根没构建）。
        let (off_agents, off_ignored) = collaboration_payload_agents_with_ignored(false, &ids);
        assert!(off_agents.is_empty());
        assert!(off_ignored.is_empty());
        // 纯函数级恢复路径：同一条定义把 deprecated 置回 false → 立刻可派。
        let definitions = agent_library_definitions();
        let mut restored = definitions.clone();
        for agent in restored.iter_mut() {
            if agent.id == "desic-smart-money" {
                agent.deprecated = false;
            }
        }
        let selection = desic_agent_automation::resolve_enabled_agent_selection(&ids, &restored);
        assert!(selection.enabled.contains(&"desic-smart-money".to_string()));
        assert!(selection
            .ignored_deprecated
            .contains(&"desic-historical-analogy".to_string()));
        assert_eq!(selection.dropped_unknown, vec!["not-in-library".to_string()]);
        // 未恢复时：已下线进 ignored_deprecated，而不是 enabled。
        let selection = desic_agent_automation::resolve_enabled_agent_selection(&ids, &definitions);
        assert!(!selection.enabled.contains(&"desic-smart-money".to_string()));
        assert!(selection
            .ignored_deprecated
            .contains(&"desic-smart-money".to_string()));
    }

    /// C14 ③ 迁移三态：旧 off（无 scheme）→ false；auto → true + 8 内置；custom/scheme → true。
    #[test]
    fn agent_library_collaboration_flag_migrates_all_legacy_modes() {
        use rusqlite::Connection;

        let conn = Connection::open_in_memory().expect("open in-memory database");
        crate::ai_automation::migrate_ai_automation(&conn).expect("migrate automation schema");

        let insert = |id: &str, mode: &str, scheme_id: Option<&str>, agents_json: &str| {
            conn.execute(
                "INSERT INTO ai_agent_profiles(
                   id,name,enabled,mode,environment,symbols_json,scan_interval_minutes,
                   skill_ids_json,skill_versions_json,history_lookback_days,
                   similarity_window_minutes,entry_tolerance_bps,max_runtime_seconds,
                   min_wake_interval_seconds,max_runs_per_hour,allowed_wake_condition_types_json,
                   multi_agent_scheme_id,multi_agents_json,multi_agent_mode,
                   enabled_agent_ids_json,created_at,updated_at
                 ) VALUES(?1,'Test',1,'advisor','demo','[\"BTC-USDT-SWAP\"]',15,
                   '[]','{}',30,10,30,180,60,12,'[]',?2,?3,?4,'[]',1,1)",
                rusqlite::params![id, scheme_id, agents_json, mode],
            )
            .expect("insert legacy profile row");
        };

        insert("profile-c14-off", "off", None, "[]");
        insert("profile-c14-auto", "auto", None, "[]");
        insert("profile-c14-custom", "custom", None, &serde_json::json!([
            {
                "id": "agent-library-c14-custom-test",
                "name": "自定义成员",
                "role": "custom",
                "responsibility": "自定义职责。",
                "scopes": ["market"],
                "required": false,
                "enabled": true
            }
        ])
        .to_string());
        insert(
            "profile-c14-scheme",
            "off",
            Some("scheme-c14-test"),
            "[]",
        );
        conn.execute(
            "INSERT INTO ai_agent_schemes(id,name,description,agents_json,created_at,updated_at)
             VALUES('scheme-c14-test','模板','',?1,1,1)",
            rusqlite::params![serde_json::json!([
                {
                    "id": "agent-library-c14-scheme-test",
                    "name": "模板成员",
                    "role": "custom",
                    "responsibility": "模板职责。",
                    "scopes": ["intelligence"],
                    "required": false,
                    "enabled": true
                }
            ])
            .to_string()],
        )
        .expect("insert scheme row");

        let off = crate::ai_automation::load_profile_for_test(&conn, "profile-c14-off")
            .expect("load off profile");
        assert!(!off.collaboration_enabled, "旧 off（无 scheme）→ false");
        assert!(off.enabled_agent_ids.is_empty());

        let auto = crate::ai_automation::load_profile_for_test(&conn, "profile-c14-auto")
            .expect("load auto profile");
        assert!(auto.collaboration_enabled, "旧 auto → true");
        assert_eq!(
            auto.enabled_agent_ids,
            desic_agent_automation::default_enabled_agent_ids(),
            "C20：auto 迁移到默认启用集（4 个流程角色）"
        );
        assert_eq!(auto.enabled_agent_ids.len(), 4);
        assert!(auto.enabled_agent_ids.iter().all(|id| id.starts_with("desic-")));

        let custom = crate::ai_automation::load_profile_for_test(&conn, "profile-c14-custom")
            .expect("load custom profile");
        assert!(custom.collaboration_enabled, "旧 custom → true");
        // C20.5（强制迁移版）：旧 custom Profile 里一个默认角色都没有 → 补齐新 4 个，
        // 自定义成员原样保留（顺序：默认 4 在前、其余保留原相对顺序）。
        let mut expected = desic_agent_automation::default_enabled_agent_ids();
        expected.push("agent-library-c14-custom-test".to_string());
        assert_eq!(custom.enabled_agent_ids, expected);

        let scheme = crate::ai_automation::load_profile_for_test(&conn, "profile-c14-scheme")
            .expect("load scheme profile");
        assert!(scheme.collaboration_enabled, "引用 scheme → true");
        // 同上：旧 scheme 成员 + 补齐的新 4 个角色。
        let mut expected = desic_agent_automation::default_enabled_agent_ids();
        expected.push("agent-library-c14-scheme-test".to_string());
        assert_eq!(scheme.enabled_agent_ids, expected);

        // 已有勾选的旧行（列刚加入时的一次性回填）也视为开启：
        // 用"列尚不存在"的旧库跑一次真实 migrate，验证回填语句本身生效。
        let legacy_conn = Connection::open_in_memory().expect("open legacy database");
        legacy_conn
            .execute_batch(
                "CREATE TABLE ai_agent_profiles(
                   id TEXT PRIMARY KEY,
                   enabled INTEGER NOT NULL DEFAULT 0,
                   deleted_at INTEGER,
                   updated_at INTEGER NOT NULL DEFAULT 0,
                   enabled_agent_ids_json TEXT NOT NULL DEFAULT '[]'
                 );
                 INSERT INTO ai_agent_profiles(id,enabled_agent_ids_json)
                   VALUES('profile-c14-backfill','[\"desic-smart-money\"]');
                 INSERT INTO ai_agent_profiles(id,enabled_agent_ids_json)
                   VALUES('profile-c14-backfill-empty','[]');",
            )
            .expect("create legacy profile schema");
        crate::ai_automation::migrate_ai_automation(&legacy_conn).expect("migrate legacy schema");
        let backfilled: i64 = legacy_conn
            .query_row(
                "SELECT collaboration_enabled FROM ai_agent_profiles WHERE id='profile-c14-backfill'",
                [],
                |row| row.get(0),
            )
            .expect("backfilled flag");
        assert_eq!(backfilled, 1, "勾选非空的旧行 → true");
        let untouched: i64 = legacy_conn
            .query_row(
                "SELECT collaboration_enabled FROM ai_agent_profiles WHERE id='profile-c14-backfill-empty'",
                [],
                |row| row.get(0),
            )
            .expect("untouched flag");
        assert_eq!(untouched, 0, "无勾选的旧行 → false（等价旧 off）");

        let _ = crate::storage_config::delete_agent_bundle("agent-library-c14-custom-test");
        let _ = crate::storage_config::delete_agent_bundle("agent-library-c14-scheme-test");
    }

    /// C8 出口条件 4（纯判定，不碰盘）：内置文件被用户改动 → `modified: true`；
    /// 与当前内置渲染一致 → false。安装层"不覆盖 + 清单可升级"由下一条用例覆盖。
    #[test]
    fn agent_library_reports_locally_modified_builtin() {
        let id = "desic-market-structure";
        let expected = desic_agent_automation::builtin_agent_markdown(id).expect("builtin markdown");
        let entry = |content: String| AgentLibraryEntry {
            definition: desic_agent_automation::parse_agent_markdown(&content).expect("parse"),
            content,
            path: std::path::PathBuf::new(),
            updated_at: 0,
        };
        assert!(!agent_is_modified(&entry(expected.clone())), "未被改动的内置文件不是 modified");
        let mutated = format!("{expected}\n<!-- local edit -->\n");
        assert!(agent_is_modified(&entry(mutated)), "被改动的内置文件必须是 modified");

        // 非内置来源永不参与该判定。
        let custom_markdown =
            "---\nid: custom-modified-check\nname: 自定义\nrole: custom\n---\n## 职责\n职责。\n";
        let mut custom = entry(custom_markdown.to_string());
        custom.definition.source = AGENT_SOURCE_CUSTOM.to_string();
        assert!(!agent_is_modified(&custom));
    }

    /// 内置安装清单指纹（C1 + lead 裁决）：全部在**临时根目录**做，避免与并发测试
    /// 抢同一份 dev 库文件（写盘 + 读盘跨线程会看到半截内容）。
    /// ① 装一遍写清单 → ② 手改不被覆盖 → ③ 清单证明未改动 → 升级为新版 → ④ 清单缺失不猜。
    #[test]
    fn agent_library_builtin_fingerprint_manifest_controls_upgrades() {
        use rusqlite::Connection;
        use std::collections::HashMap;

        let conn = Connection::open_in_memory().expect("open in-memory database");
        crate::ai_automation::migrate_ai_automation(&conn).expect("migrate automation schema");
        let root = std::env::temp_dir().join(format!(
            "desic-agent-manifest-test-{}-{}",
            std::process::id(),
            crate::ai_automation::unique_suffix()
        ));
        let id = "desic-smart-money";
        let current = desic_agent_automation::builtin_agent_markdown(id).expect("builtin markdown");
        let read = |id: &str| {
            std::fs::read_to_string(root.join(id).join(desic_agent_automation::AGENT_FILE_NAME))
                .expect("read installed builtin")
        };
        let write = |id: &str, content: &str| {
            let dir = root.join(id);
            std::fs::create_dir_all(&dir).expect("create dir");
            std::fs::write(dir.join(desic_agent_automation::AGENT_FILE_NAME), content)
                .expect("write builtin");
        };
        let cleanup = || {
            let _ = std::fs::remove_dir_all(&root);
        };
        cleanup();

        // ① 全新目录 + 空清单 → 8 个文件全部新建，清单写入 8 条指纹。
        let first = crate::storage_config::install_builtin_agent_bundles_with_manifest(
            &root,
            Some(&HashMap::new()),
        )
        .expect("first install");
        assert_eq!(
            first.written,
            desic_agent_automation::builtin_agent_ids().len(),
            "首次安装应写入全部内置文件"
        );
        assert_eq!((first.upgraded, first.kept), (0, 0));
        let manifest = first.manifest.clone().expect("manifest produced");
        assert_eq!(manifest.len(), desic_agent_automation::builtin_agent_ids().len());
        assert_eq!(read(id), current);
        crate::ai_automation::save_builtin_agent_fingerprint_manifest_for_test(&conn, &manifest)
            .expect("persist manifest");
        let stored = crate::ai_automation::load_builtin_agent_fingerprint_manifest(&conn)
            .expect("stored manifest");
        assert_eq!(stored, manifest);

        // 重复安装 → 无写、无升级。
        let second = crate::storage_config::install_builtin_agent_bundles_with_manifest(
            &root,
            Some(&stored),
        )
        .expect("reinstall");
        assert_eq!((second.written, second.upgraded, second.kept), (0, 0, 0));

        // ② 只手改一个内置文件 → 再安装：不被覆盖（并因此 modified: true）。
        let edited = format!("{current}\n<!-- user edit -->\n");
        write(id, &edited);
        let after_edit = crate::storage_config::install_builtin_agent_bundles_with_manifest(
            &root,
            Some(&stored),
        )
        .expect("install after user edit");
        assert_eq!(after_edit.kept, 1, "用户改动必须被保留");
        assert_eq!(read(id), edited);
        assert!(agent_is_modified(&AgentLibraryEntry {
            definition: desic_agent_automation::parse_agent_markdown(&edited).expect("parse"),
            content: edited.clone(),
            path: std::path::PathBuf::new(),
            updated_at: 0,
        }));

        // ③ 清单证明"我们上次装过这份"→ 盘上换成旧版内容后安装 → 升级为新版。
        let stale = "---\nid: desic-smart-money\nname: Smart Money\nrole: smart_money\n---\n更旧正文。\n";
        write(id, stale);
        let mut downgraded = stored.clone();
        downgraded.insert(
            id.to_string(),
            crate::storage_config::sha256_bytes(stale.as_bytes()),
        );
        crate::ai_automation::save_builtin_agent_fingerprint_manifest_for_test(&conn, &downgraded)
            .expect("persist downgraded manifest");
        let upgraded = crate::storage_config::install_builtin_agent_bundles_with_manifest(
            &root,
            Some(&downgraded),
        )
        .expect("install upgrade");
        assert_eq!(upgraded.upgraded, 1, "未改动的旧版必须被升级");
        assert_eq!(read(id), current);
        assert_eq!(
            upgraded
                .manifest
                .expect("manifest")
                .get(id)
                .map(String::as_str),
            Some(crate::storage_config::sha256_bytes(current.as_bytes()).as_str())
        );
        // 未改动的其它内置文件保持原样。
        assert_eq!(
            read("desic-market-structure"),
            desic_agent_automation::builtin_agent_markdown("desic-market-structure")
                .expect("markdown")
        );

        // ④ 清单缺失 + 已存在但内容不同 → 不覆盖 + 标记"清单缺失"；无清单不回写清单。
        write(id, stale);
        let missing =
            crate::storage_config::install_builtin_agent_bundles_with_manifest(&root, None)
                .expect("install without manifest");
        assert!(missing.manifest_missing, "清单缺失必须被标记（调用方据此记一行日志）");
        assert_eq!(missing.kept, 1);
        assert_eq!(read(id), stale, "清单缺失时不得猜测覆盖");
        assert!(missing.manifest.is_none(), "无清单路径不回写清单");

        cleanup();
    }

    /// ③-1/2/4：草稿请求必须自带完整模型配置（probe：不带 config → 侧车 `path:["model"]`
    /// invalid_type，必然失败）。覆盖：不传→当前模型；传合法 id→该模型的凭据；
    /// 传非法 id→Err（列出可用模型）；payload 的 config 六键齐备 + 顶层 model。
    #[test]
    fn agent_library_draft_request_carries_resolved_model_config() {
        use desic_storage_config::AiConfig;

        let model = |id: &str, name: &str, provider: &str, base_url: &str, api_key: &str| {
            serde_json::json!({
                "id": id,
                "name": name,
                "provider": provider,
                "model": format!("{id}-model"),
                "baseUrl": base_url,
                "apiKey": api_key,
                "permissionMode": "copilot",
                "reasoningDepth": "high",
                "contextWindow": 131_072_u32,
            })
        };
        let config: AiConfig = serde_json::from_value(serde_json::json!({
            "provider": "openai-compatible",
            "model": "model-a-model",
            "baseUrl": "http://127.0.0.1:8004/v1",
            "apiKey": "sk-local-a",
            "activeModelId": "model-a",
            "models": [
                model("model-a", "模型 A", "openai-compatible", "http://127.0.0.1:8004/v1", "sk-local-a"),
                model("model-b", "模型 B", "anthropic", "https://api.example.invalid", "sk-local-b"),
            ],
        }))
        .expect("deserialize ai config");

        // ① 不传 model → 当前模型（activeModelId）。
        let resolved = resolve_agent_draft_model(&config, None).expect("current model");
        assert_eq!(resolved.active_model_id, "model-a");
        assert_eq!(resolved.model, "model-a-model");
        let payload = build_agent_draft_payload("req-1", "看 BTC 盘口", Some("盘口"), &resolved);
        assert_eq!(payload["config"]["model"], "model-a-model");
        assert_eq!(payload["model"], "model-a-model", "顶层兜底 model 必须存在");
        assert_eq!(payload["config"]["provider"], "openai-compatible");
        assert_eq!(payload["config"]["baseUrl"], "http://127.0.0.1:8004/v1");
        assert_eq!(payload["config"]["apiKey"], "sk-local-a");
        assert_eq!(payload["config"]["contextWindow"], 131_072);
        assert_eq!(payload["config"]["permissionMode"], "advisor");
        assert_eq!(payload["config"]["reasoningDepth"], "none");
        // 线上事故热修：一次性 provider 请求也要显式下发空闲上限（60s → 240s）。
        assert_eq!(
            payload["config"]["requestTimeoutMs"],
            crate::ai_automation::AI_REQUEST_IDLE_TIMEOUT_MS
        );
        assert_eq!(payload["config"]["requestTimeoutMs"], 240_000);
        assert_eq!(payload["type"], "generateAgentDraft");
        assert_eq!(payload["description"], "看 BTC 盘口");
        assert_eq!(payload["name"], "盘口");
        assert!(payload["prompts"]["system"].as_str().is_some_and(|v| !v.is_empty()));
        assert!(payload["prompts"]["messages"].as_array().is_some_and(|v| v.len() == 4));

        // ② 传合法 model → 该模型（含 provider/baseUrl/apiKey）。
        let resolved = resolve_agent_draft_model(&config, Some("model-b")).expect("selected model");
        assert_eq!(resolved.active_model_id, "model-b");
        let payload = build_agent_draft_payload("req-2", "描述", None, &resolved);
        assert_eq!(payload["config"]["model"], "model-b-model");
        assert_eq!(payload["config"]["provider"], "anthropic");
        assert_eq!(payload["config"]["baseUrl"], "https://api.example.invalid");
        assert_eq!(payload["config"]["apiKey"], "sk-local-b");
        assert_eq!(payload["model"], "model-b-model");
        assert!(payload["name"].is_null(), "未指定名称时下发 null，由侧车/提示词自行命名");

        // ③ 传非法 id → Err 并列出可用模型（不静默回落）。
        let error = resolve_agent_draft_model(&config, Some("model-missing"))
            .expect_err("unknown model must fail");
        assert!(error.contains("model-missing"), "{error}");
        assert!(error.contains("model-a"), "{error}");
        assert!(error.contains("model-b"), "{error}");

        // ④ config 六键齐备（模型/凭据缺失是不能回归的点）。
        let resolved = resolve_agent_draft_model(&config, None).expect("current");
        let payload = build_agent_draft_payload("req-3", "描述", None, &resolved);
        let config_object = payload["config"].as_object().expect("config object");
        for key in [
            "provider",
            "model",
            "baseUrl",
            "apiKey",
            "contextWindow",
            "permissionMode",
            "reasoningDepth",
        ] {
            assert!(config_object.contains_key(key), "config 缺少 {key}");
        }
        assert!(!payload["config"]["apiKey"].as_str().unwrap_or_default().is_empty());

        // 没有任何模型 → 明确 Err。
        let empty: AiConfig = serde_json::from_value(serde_json::json!({
            "model": "",
            "baseUrl": "",
            "models": [],
            "activeModelId": "",
        }))
        .expect("deserialize empty ai config");
        assert!(resolve_agent_draft_model(&empty, None).is_err());
        assert!(resolve_agent_draft_model(&empty, Some("model-a"))
            .expect_err("no models")
            .contains("尚未配置任何 AI 模型"));
    }

    /// C17 / P2：`agentDraftDelta` → `AiEvent::AgentDraftDelta`，字段逐字映射；
    /// 它是**瞬时事件**：不进流检查点（持久化）白名单。
    #[test]
    fn agent_library_draft_delta_event_maps_and_stays_transient() {
        let event = cline_event_from_value(
            "session-fallback",
            &json!({
                "type": "agentDraftDelta",
                "sessionId": "agent-draft-req-42",
                "requestId": "req-42",
                "delta": "## 身份\n只读专家",
                "chars": 1
            }),
        )
        .expect("parse agent draft delta");
        assert_eq!(ai_event_session_id(&event), "agent-draft-req-42");
        match &event {
            AiEvent::AgentDraftDelta {
                session_id,
                request_id,
                delta,
                chars,
            } => {
                assert_eq!(session_id, "agent-draft-req-42");
                assert_eq!(request_id, "req-42");
                assert_eq!(delta, "## 身份\n只读专家");
                assert_eq!(*chars, 1);
            }
            other => panic!("unexpected event: {other:?}"),
        }
        // 瞬时：不进检查点（与 C11 的 AgentProgressNotice 同款）。
        assert!(!ai_event_triggers_checkpoint(&event));
        assert!(!ai_event_triggers_checkpoint(&AiEvent::AgentProgressNotice {
            session_id: "s".to_string(),
            agent_id: "a".to_string(),
            agent_name: "A".to_string(),
            elapsed_ms: 1,
            silent_ms: 1,
            phase: "consult".to_string(),
        }));
        // 对照组：真正会落盘的事件仍为 true。
        assert!(ai_event_triggers_checkpoint(&AiEvent::Delta {
            session_id: "s".to_string(),
            channel: "assistant".to_string(),
            content: "x".to_string(),
            reasoning_id: None,
            reasoning_summary: None,
        }));
        assert!(ai_event_triggers_checkpoint(&AiEvent::AgentDone {
            session_id: "s".to_string(),
            agent_id: "a".to_string(),
            configured_agent_id: None,
            status: "done".to_string(),
            result: json!({}),
            error: None,
            ended_at: None,
        }));
        // 未知 type 不产生事件（不会污染其它会话的状态机）。
        assert!(cline_event_from_value("", &json!({ "type": "agentDraftUnknown" })).is_none());
    }

    /// C17 / P3：取消草稿生成——等待方立刻收到 `Err("草稿生成已取消")` 且 pending 表项被
    /// 清理；对不存在 / 空 requestId 幂等（不报错、不残留）。
    #[test]
    fn agent_library_draft_cancel_notifies_waiter_and_clears_pending() {
        let runtime = AiRuntime::default();
        let (tx, mut rx) = oneshot::channel::<Result<String, String>>();
        runtime
            .pending_agent_draft_commands
            .lock()
            .expect("lock pending")
            .insert("req-cancel".to_string(), tx);

        assert!(
            cancel_agent_draft_locally(&runtime, "req-cancel"),
            "存在等待方时必须返回 true"
        );
        let received = rx.try_recv().expect("waiter notified");
        assert_eq!(
            received.expect_err("cancelled draft must surface as Err"),
            "草稿生成已取消"
        );
        assert!(
            !runtime
                .pending_agent_draft_commands
                .lock()
                .expect("lock pending")
                .contains_key("req-cancel"),
            "pending 表项必须被清理（不泄漏）"
        );

        // 幂等：无在途请求时（已完成 / 已取消 / 从未发出）返回 false，命令层返回 Ok(()).
        assert!(!cancel_agent_draft_locally(&runtime, "req-cancel"));
        assert!(!cancel_agent_draft_locally(&runtime, "req-never-sent"));
        assert!(!cancel_agent_draft_locally(&runtime, "   "));

        // C17.3 兜底：未知 id / 空 id 但存在**唯一在途**请求 → 仍能取消成功。
        let (tx_unknown, mut rx_unknown) = oneshot::channel::<Result<String, String>>();
        runtime
            .pending_agent_draft_commands
            .lock()
            .expect("lock pending")
            .insert("req-in-flight".to_string(), tx_unknown);
        assert!(
            cancel_agent_draft_locally(&runtime, "req-unknown-id"),
            "未知 id 时兜底取消唯一在途请求"
        );
        assert_eq!(
            rx_unknown
                .try_recv()
                .expect("waiter notified")
                .expect_err("cancelled"),
            "草稿生成已取消"
        );
        assert!(runtime
            .pending_agent_draft_commands
            .lock()
            .expect("lock pending")
            .is_empty());

        let (tx_blank, mut rx_blank) = oneshot::channel::<Result<String, String>>();
        runtime
            .pending_agent_draft_commands
            .lock()
            .expect("lock pending")
            .insert("req-in-flight-2".to_string(), tx_blank);
        assert!(
            cancel_agent_draft_locally(&runtime, "   "),
            "空 id 时兜底取消唯一在途请求"
        );
        assert!(rx_blank.try_recv().is_ok());
        assert!(runtime
            .pending_agent_draft_commands
            .lock()
            .expect("lock pending")
            .is_empty());

        // 侧车稍后回的 ok:false 因表项已移除会被忽略（不会二次唤醒 / 不会 panic）。
        assert!(!runtime
            .pending_agent_draft_commands
            .lock()
            .expect("lock pending")
            .contains_key("req-cancel"));
    }

    /// C17.3：UI 传入的 requestId —— 合法则原样使用（载荷与等待方同源），
    /// 非法/缺失则自生成且不报错。
    #[test]
    fn agent_library_draft_request_id_accepts_ui_id_or_generates() {
        let generated = "agent-draft-1760000000000-ab12cd".to_string();
        let ui_id = "ui-draft_2026-09-18-01";

        // 合法：原样使用，并进入请求载荷（等待方与侧车回包都用同一 id）。
        assert!(is_valid_agent_draft_request_id(ui_id));
        let resolved =
            resolve_agent_draft_request_id(Some(ui_id), generated.clone());
        assert_eq!(resolved, ui_id);
        let config: desic_storage_config::AiConfig = serde_json::from_value(serde_json::json!({
            "provider": "openai-compatible",
            "model": "m",
            "baseUrl": "http://127.0.0.1:8004/v1",
            "apiKey": "sk-local",
            "activeModelId": "model-a",
            "models": [{
                "id": "model-a", "name": "A", "provider": "openai-compatible",
                "model": "m", "baseUrl": "http://127.0.0.1:8004/v1", "apiKey": "sk-local"
            }],
        }))
        .expect("deserialize ai config");
        let payload = build_agent_draft_payload(&resolved, "描述", None, &config);
        assert_eq!(payload["requestId"], ui_id);
        assert_eq!(payload["type"], "generateAgentDraft");
        // 空白裁剪后同样可用。
        assert_eq!(
            resolve_agent_draft_request_id(Some("  ui-draft_2026-09-18-01  "), generated.clone()),
            ui_id
        );

        // 非法 / 缺失：忽略并自生成，不报错。
        for invalid in [
            None,
            Some(""),
            Some("   "),
            Some("a"),
            Some("短id短"),                  // 非 ASCII
            Some("has/slash-123456"),
            Some("有中文的requestid1234"),
            Some("space in id 12345"),
            // 65 字符：超出上限 64。
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        ] {
            let resolved = resolve_agent_draft_request_id(invalid, generated.clone());
            assert_eq!(resolved, generated, "非法 id {invalid:?} 必须被忽略");
        }
        assert!(is_valid_agent_draft_request_id("A-Za-z0-9_-"));
        assert_eq!(is_valid_agent_draft_request_id("1234567"), false, "长度下限 8");
        assert_eq!(
            is_valid_agent_draft_request_id(&"a".repeat(64)),
            true,
            "长度上限 64"
        );
        assert_eq!(is_valid_agent_draft_request_id(&"a".repeat(65)), false);
    }

    #[test]
    fn agent_library_split_reports_dropped_ids() {
        let (known, dropped) = split_known_enabled_agent_ids(&[
            "desic-market-structure".to_string(),
            "auto-smart-money".to_string(),
            "not-in-library".to_string(),
            "desic-market-structure".to_string(),
        ]);
        assert_eq!(
            known,
            vec![
                "desic-market-structure".to_string(),
                "desic-smart-money".to_string()
            ]
        );
        assert_eq!(dropped, vec!["not-in-library".to_string()]);
    }
}
