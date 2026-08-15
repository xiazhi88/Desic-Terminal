use super::*;
use desic_storage_config::{
    AiConfig, AiConfigSummary, AiConfigUpdate, AiConnectionTestResult, AiLocalAuthStatus,
    AiLocalCliStatus, AiModelConfig, AiModelConfigSummary, AiModelConfigUpdate, AiSkillDefinition,
    DiagnosticExportResult, FrontendLogEntry, KlineDataRange, ProxyConfig, ProxyConfigSummary,
    ProxyConfigUpdate, ProxyTestResult, SensitiveConfigMigrationResult, StorageMaintenanceResult,
    StorageStatusResult, UiPreferencesConfig, UiPreferencesQuery, UiPreferencesSummary,
    UiPreferencesUpdate, WatchlistConfig,
};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use zip::{read::ZipArchive, write::SimpleFileOptions, CompressionMethod, ZipWriter};

static AI_CONFIG_WRITE_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
static ATOMIC_WRITE_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
static RUNTIME_PATHS: std::sync::OnceLock<RuntimePaths> = std::sync::OnceLock::new();
static REQWEST_CLIENT_CACHE: std::sync::OnceLock<
    std::sync::Mutex<Option<(ProxyConfig, reqwest::Client)>>,
> = std::sync::OnceLock::new();
static LAST_STORAGE_MAINTENANCE_AT: std::sync::atomic::AtomicI64 =
    std::sync::atomic::AtomicI64::new(0);

#[derive(Clone, Debug, PartialEq, Eq)]
struct RuntimePaths {
    config_dir: PathBuf,
    cache_dir: PathBuf,
    log_dir: PathBuf,
    diagnostics_dir: PathBuf,
    work_dir: PathBuf,
    cline_skills_dir: PathBuf,
}

pub(crate) fn initialize_runtime_paths(app: &tauri::AppHandle) -> Result<(), String> {
    let paths = if cfg!(debug_assertions) {
        development_runtime_paths()
    } else {
        let config_dir = app.path().app_config_dir().map_err(|err| err.to_string())?;
        let cache_dir = app.path().app_cache_dir().map_err(|err| err.to_string())?;
        let log_dir = app.path().app_log_dir().map_err(|err| err.to_string())?;
        let data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
        for dir in [&config_dir, &cache_dir, &log_dir, &data_dir] {
            migrate_legacy_app_identifier_dir(dir)?;
        }
        RuntimePaths {
            config_dir,
            cache_dir,
            log_dir,
            diagnostics_dir: data_dir.join("diagnostics"),
            work_dir: data_dir.join("workspace"),
            cline_skills_dir: data_dir.join("workspace").join(".cline").join("skills"),
        }
    };

    for dir in [
        &paths.config_dir,
        &paths.cache_dir,
        &paths.log_dir,
        &paths.diagnostics_dir,
        &paths.work_dir,
        &paths.cline_skills_dir,
    ] {
        fs::create_dir_all(dir)
            .map_err(|err| format!("创建应用目录 {} 失败: {}", dir.display(), err))?;
    }
    if !cfg!(debug_assertions) {
        migrate_legacy_workspace_config(&paths.config_dir)?;
    }

    if let Some(existing) = RUNTIME_PATHS.get() {
        if existing == &paths {
            return Ok(());
        }
        return Err("应用运行目录已经使用其它路径初始化".to_string());
    }
    RUNTIME_PATHS
        .set(paths)
        .map_err(|_| "应用运行目录初始化失败".to_string())
}

fn migrate_legacy_app_identifier_dir(destination: &std::path::Path) -> Result<(), String> {
    const LEGACY_IDENTIFIER: &str = "com.desic.tradeai";
    let Some(parent) = destination.parent() else {
        return Ok(());
    };
    let source = parent.join(LEGACY_IDENTIFIER);
    if source == destination || !source.exists() {
        return Ok(());
    }
    copy_missing_directory_tree(&source, destination)
}

fn copy_missing_directory_tree(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|err| format!("创建应用迁移目录 {} 失败: {}", destination.display(), err))?;
    for entry in fs::read_dir(source)
        .map_err(|err| format!("读取旧应用目录 {} 失败: {}", source.display(), err))?
    {
        let entry = entry.map_err(|err| format!("读取旧应用目录项失败: {}", err))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|err| format!("读取旧应用目录项类型失败: {}", err))?;
        if file_type.is_dir() {
            copy_missing_directory_tree(&source_path, &destination_path)?;
        } else if file_type.is_file() && !destination_path.exists() {
            fs::copy(&source_path, &destination_path).map_err(|err| {
                format!(
                    "迁移旧应用文件 {} 到 {} 失败: {}",
                    source_path.display(),
                    destination_path.display(),
                    err
                )
            })?;
        }
    }
    Ok(())
}

fn development_runtime_paths() -> RuntimePaths {
    let root = project_root_path();
    RuntimePaths {
        config_dir: root.join("config"),
        cache_dir: root.join("cache"),
        log_dir: root.join("logs"),
        diagnostics_dir: root.join("diagnostics"),
        work_dir: root.clone(),
        cline_skills_dir: root.join(".cline").join("skills"),
    }
}

fn runtime_paths() -> RuntimePaths {
    RUNTIME_PATHS
        .get()
        .cloned()
        .unwrap_or_else(development_runtime_paths)
}

pub(crate) fn runtime_cache_root() -> PathBuf {
    runtime_paths().cache_dir
}

pub(crate) fn runtime_config_root() -> PathBuf {
    runtime_paths().config_dir
}

pub(crate) fn runtime_work_dir() -> PathBuf {
    runtime_paths().work_dir
}

fn migrate_legacy_workspace_config(config_dir: &std::path::Path) -> Result<(), String> {
    let legacy_dir = project_root_path().join("config");
    if legacy_dir == config_dir || !legacy_dir.exists() {
        return Ok(());
    }
    for file_name in [
        "accounts.local.json",
        "proxy.local.json",
        "ai.local.json",
        "notification.local.json",
        "ui.local.json",
        "watchlist.local.json",
    ] {
        let source = legacy_dir.join(file_name);
        let destination = config_dir.join(file_name);
        if !source.exists() || destination.exists() {
            continue;
        }
        fs::copy(&source, &destination).map_err(|err| {
            format!(
                "迁移旧配置 {} 到 {} 失败: {}",
                source.display(),
                destination.display(),
                err
            )
        })?;
        if matches!(
            file_name,
            "accounts.local.json"
                | "proxy.local.json"
                | "ai.local.json"
                | "notification.local.json"
        ) {
            harden_sensitive_file_permissions(&destination)?;
        }
    }
    Ok(())
}

fn ai_config_write_mutex() -> &'static std::sync::Mutex<()> {
    AI_CONFIG_WRITE_LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

pub(crate) fn lock_ai_config_writes() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    ai_config_write_mutex()
        .lock()
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn export_diagnostics(app: tauri::AppHandle) -> Result<DiagnosticExportResult, String> {
    let created_at = now_ms();
    let dir = diagnostics_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let path = dir.join(format!("desictrade-diagnostics-{}.zip", created_at));

    let accounts = load_accounts_config(&app)
        .unwrap_or_default()
        .accounts
        .into_iter()
        .map(account_summary_from)
        .collect::<Vec<_>>();
    let proxy = proxy_config_summary_from(load_proxy_config().unwrap_or_default());
    let watchlist = load_watchlist_config_file(&app).unwrap_or_default();
    let ai = load_ai_config(&app).ok().map(ai_config_summary_from);
    let market_assets_path = market_assets_cache_dir(&app)?.join("swap-instruments.json");
    let market_assets = fs::read_to_string(market_assets_path)
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .map(|value| {
            json!({
                "total": value.get("total"),
                "iconCached": value.get("iconCached"),
                "iconFailed": value.get("iconFailed"),
                "cacheDir": value.get("cacheDir"),
                "updatedAt": value.get("updatedAt")
            })
        });
    let mut frontend_logs = Vec::new();
    let log_dir = frontend_log_dir(&app)?;
    if let Ok(entries) = fs::read_dir(log_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|item| item.to_str()) != Some("jsonl") {
                continue;
            }
            let content = fs::read_to_string(&path).unwrap_or_default();
            frontend_logs.push(json!({
                "file": path.file_name().and_then(|item| item.to_str()).unwrap_or_default(),
                "content": content
                    .lines()
                    .rev()
                    .take(500)
                    .map(redact_diagnostic_line)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
            }));
        }
    }
    let payload = json!({
        "createdAt": created_at,
        "app": {
            "name": "Desic Terminal",
            "version": env!("CARGO_PKG_VERSION")
        },
        "proxy": proxy,
        "accounts": accounts,
        "watchlist": watchlist,
        "ai": ai,
        "marketAssets": market_assets,
        "frontendLogs": frontend_logs
    });
    let content = serde_json::to_string_pretty(&payload).map_err(|err| err.to_string())?;
    write_diagnostics_zip(&path, &content)?;
    let size_bytes = fs::metadata(&path).map_err(|err| err.to_string())?.len();
    Ok(DiagnosticExportResult {
        path: path.to_string_lossy().to_string(),
        size_bytes,
        created_at,
    })
}

#[tauri::command]
pub(crate) fn frontend_log(app: tauri::AppHandle, entry: FrontendLogEntry) -> Result<(), String> {
    let dir = frontend_log_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let file_name = format!("frontend-{}.jsonl", Utc::now().format("%Y-%m-%d"));
    let path = dir.join(file_name);
    let mut line = serde_json::to_string(&entry).map_err(|err| err.to_string())?;
    line.push('\n');
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| err.to_string())?;
    file.write_all(line.as_bytes())
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn ai_config_summary(app: tauri::AppHandle) -> Result<AiConfigSummary, String> {
    match load_ai_config(&app) {
        Ok(config) => Ok(ai_config_summary_from(config)),
        Err(error) if is_unconfigured_ai_config_error(&error) => {
            Ok(unconfigured_ai_config_summary())
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub(crate) fn ai_save_config(
    app: tauri::AppHandle,
    update: AiConfigUpdate,
) -> Result<AiConfigSummary, String> {
    let _config_write_guard = lock_ai_config_writes()?;
    let existing = match load_ai_config_locked(&app) {
        Ok(config) => Some(config),
        Err(error) if is_unconfigured_ai_config_error(&error) => None,
        Err(error) => return Err(format!("加载现有 AI 配置失败：{}", error)),
    };
    let models = build_updated_ai_models(&update, existing.as_ref())?;
    let active_model_id = update
        .active_model_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            existing
                .as_ref()
                .map(|config| config.active_model_id.clone())
        })
        .filter(|value| models.iter().any(|model| model.id == *value))
        .or_else(|| models.first().map(|model| model.id.clone()))
        .ok_or_else(|| "至少需要配置一个 AI 模型".to_string())?;
    let active_model = models
        .iter()
        .find(|model| model.id == active_model_id)
        .cloned()
        .ok_or_else(|| "当前 AI 模型配置不存在".to_string())?;
    let config = AiConfig {
        provider: Some(active_model.provider.clone()),
        model: active_model.model.clone(),
        base_url: active_model.base_url.clone(),
        api_key: active_model.api_key.clone(),
        stream: Some(true),
        permission_mode: active_model.permission_mode.clone(),
        reasoning_depth: active_model.reasoning_depth.clone(),
        active_model_id,
        models,
        system_prompt: update
            .system_prompt
            .or_else(|| existing.as_ref().map(|config| config.system_prompt.clone()))
            .unwrap_or_else(desic_storage_config::default_ai_system_prompt),
        custom_rules: update
            .custom_rules
            .or_else(|| existing.as_ref().map(|config| config.custom_rules.clone()))
            .unwrap_or_default(),
        enabled_skills: normalize_ai_enabled_skills(
            update
                .enabled_skills
                .or_else(|| {
                    existing
                        .as_ref()
                        .map(|config| config.enabled_skills.clone())
                })
                .unwrap_or_default(),
        ),
        skill_definitions: merge_ai_skill_definitions(
            update
                .skill_definitions
                .or_else(|| {
                    existing
                        .as_ref()
                        .map(|config| config.skill_definitions.clone())
                })
                .unwrap_or_default(),
        ),
        open_agent: update
            .open_agent
            .or_else(|| existing.as_ref().map(|config| config.open_agent))
            .unwrap_or(true),
        workspace_roots: normalize_ai_workspace_roots(
            update
                .workspace_roots
                .or_else(|| existing.as_ref().map(|config| config.workspace_roots.clone()))
                .unwrap_or_default(),
        ),
    };
    validate_ai_config(&config)?;
    save_ai_config(&app, &config)?;
    if let Err(sync_error) = sync_cline_skill_files_from_config(&config) {
        let rollback_error = rollback_ai_config_save(&app, existing.as_ref(), &config).err();
        return Err(match rollback_error {
            Some(rollback_error) => format!(
                "Skill 文件同步失败：{}；恢复原 AI 配置也失败：{}",
                sync_error, rollback_error
            ),
            None => format!("Skill 文件同步失败：{}；已恢复原 AI 配置", sync_error),
        });
    }
    drop(_config_write_guard);
    crate::ai_automation::sync_ai_skill_versions(&app)
        .map_err(|error| format!("AI 配置已保存，但 Skill 版本同步失败：{}", error))?;
    let summary = ai_config_summary_from(config);
    let _ = app.emit("ai:config-updated", summary.clone());
    Ok(summary)
}

fn rollback_ai_config_save(
    app: &tauri::AppHandle,
    existing: Option<&AiConfig>,
    attempted: &AiConfig,
) -> Result<(), String> {
    if let Some(existing) = existing {
        save_ai_config(app, existing)?;
        return sync_cline_skill_files_from_config(existing);
    }

    let path = workspace_ai_config_path();
    let mut errors = Vec::new();
    if path.exists() {
        if let Err(error) = fs::remove_file(&path) {
            errors.push(format!(
                "删除首次写入的 AI 配置 {} 失败：{}",
                path.display(),
                error
            ));
        }
    }
    let mut empty = attempted.clone();
    empty.enabled_skills.clear();
    empty.skill_definitions = desic_storage_config::default_ai_skill_definitions()
        .into_iter()
        .filter(|skill| skill.id == "desic-core-operations")
        .collect();
    if let Err(error) = sync_cline_skill_files_from_config(&empty) {
        errors.push(error);
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}

pub(crate) fn sync_cline_skill_files_from_config(config: &AiConfig) -> Result<(), String> {
    let root = runtime_paths().cline_skills_dir;
    fs::create_dir_all(&root).map_err(|err| err.to_string())?;
    let enabled = config
        .enabled_skills
        .iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty() && item != "desic-core-operations")
        .collect::<std::collections::HashSet<_>>();
    let enabled_dirs = enabled
        .iter()
        .map(|item| sanitize_skill_dir_name(item))
        .collect::<std::collections::HashSet<_>>();
    for entry in fs::read_dir(&root).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            if let Some(name) = path.file_name().and_then(|item| item.to_str()) {
                if !enabled_dirs.contains(name) && !is_runtime_scoped_skill_dir(name) {
                    fs::remove_dir_all(&path).map_err(|err| {
                        format!("删除已停用 Skill 目录 {} 失败：{}", path.display(), err)
                    })?;
                }
            }
        }
    }
    for skill in &config.skill_definitions {
        let id = skill.id.trim();
        if id.is_empty() || id == "desic-core-operations" || !enabled.contains(id) {
            continue;
        }
        let dir = root.join(sanitize_skill_dir_name(id));
        fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
        let content = format!(
            "---\nname: {}\ndescription: {}\ndisabled: false\n---\n\n# {}\n\n## 规则\n{}\n\n## 内容\n{}\n",
            yaml_scalar(id),
            yaml_scalar(&skill.description),
            id,
            skill.rules.trim(),
            skill.content.trim(),
        );
        write_file_atomically(&dir.join("SKILL.md"), content.as_bytes())?;
    }
    Ok(())
}

fn imported_skill_id(value: &str) -> String {
    let mut id = value
        .trim()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch.to_ascii_lowercase() } else { '-' })
        .collect::<String>();
    while id.contains("--") {
        id = id.replace("--", "-");
    }
    id = id.trim_matches('-').chars().take(80).collect();
    if id.is_empty() { format!("imported-skill-{}", now_ms()) } else { id }
}

fn parse_imported_skill(markdown: &str, fallback: &str) -> Result<AiSkillDefinition, String> {
    let mut name = String::new();
    let mut description = String::new();
    let mut body = markdown;
    if let Some(rest) = markdown.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let frontmatter = &rest[..end];
            for line in frontmatter.lines() {
                let Some((key, value)) = line.split_once(':') else { continue };
                let value = value.trim().trim_matches(['\"', '\'']);
                match key.trim() {
                    "name" => name = value.to_string(),
                    "description" => description = value.to_string(),
                    _ => {}
                }
            }
            body = &rest[end + 5..];
        }
    }
    let id = imported_skill_id(if name.trim().is_empty() { fallback } else { &name });
    let description = if description.trim().is_empty() {
        format!("从 {} 导入的 Skill", fallback)
    } else {
        description.trim().to_string()
    };
    let content = body.trim().to_string();
    if content.is_empty() {
        return Err("SKILL.md 内容为空".to_string());
    }
    Ok(AiSkillDefinition {
        id: id.clone(),
        name: if name.trim().is_empty() { id.clone() } else { name.trim().to_string() },
        description,
        rules: String::new(),
        content,
        builtin: false,
    })
}

fn read_imported_skill_markdown(source: &Path) -> Result<String, String> {
    if source.is_dir() {
        let path = source.join("SKILL.md");
        return fs::read_to_string(&path).map_err(|err| format!("读取 {} 失败：{}", path.display(), err));
    }
    if source.extension().and_then(|value| value.to_str()).is_some_and(|value| value.eq_ignore_ascii_case("zip")) {
        let file = fs::File::open(source).map_err(|err| format!("打开 Skill ZIP 失败：{err}"))?;
        let mut archive = ZipArchive::new(file).map_err(|err| format!("读取 Skill ZIP 失败：{err}"))?;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(|err| err.to_string())?;
            let name = entry.name().replace('\\', "/");
            if name.ends_with("SKILL.md") && !name.contains("../") {
                let mut contents = String::new();
                entry.read_to_string(&mut contents).map_err(|err| err.to_string())?;
                return Ok(contents);
            }
        }
        return Err("ZIP 中未找到 SKILL.md".to_string());
    }
    Err("Skill 来源必须是包含 SKILL.md 的目录或 ZIP 文件".to_string())
}

fn persist_imported_skill(app: &tauri::AppHandle, skill: AiSkillDefinition) -> Result<AiConfigSummary, String> {
    let _guard = lock_ai_config_writes()?;
    let mut config = load_ai_config_locked(app)?;
    if let Some(existing) = config.skill_definitions.iter_mut().find(|item| item.id == skill.id) {
        *existing = skill.clone();
    } else {
        config.skill_definitions.push(skill.clone());
    }
    config.enabled_skills.push(skill.id.clone());
    config.enabled_skills = normalize_ai_enabled_skills(config.enabled_skills);
    config.skill_definitions = merge_ai_skill_definitions(config.skill_definitions);
    validate_ai_config(&config)?;
    save_ai_config(app, &config)?;
    sync_cline_skill_files_from_config(&config)?;
    drop(_guard);
    crate::ai_automation::sync_ai_skill_versions(app)?;
    let summary = ai_config_summary_from(config);
    let _ = app.emit("ai:config-updated", summary.clone());
    Ok(summary)
}

#[tauri::command]
pub(crate) fn ai_skill_import(app: tauri::AppHandle, source: String) -> Result<AiConfigSummary, String> {
    let source = PathBuf::from(source.trim());
    if !source.is_absolute() {
        return Err("Skill 来源路径必须是绝对路径".to_string());
    }
    let fallback = source.file_stem().and_then(|value| value.to_str()).unwrap_or("imported-skill");
    let markdown = read_imported_skill_markdown(&source)?;
    persist_imported_skill(&app, parse_imported_skill(&markdown, fallback)?)
}

#[tauri::command]
pub(crate) fn ai_skill_pick_source(app: tauri::AppHandle, kind: String) -> Result<Option<String>, String> {
    let selected = match kind.trim() {
        "directory" => app
            .dialog()
            .file()
            .set_title("选择包含 SKILL.md 的目录")
            .blocking_pick_folder(),
        "zip" => app
            .dialog()
            .file()
            .set_title("选择 Skill ZIP")
            .add_filter("Skill ZIP", &["zip"])
            .blocking_pick_file(),
        _ => return Err("未知的 Skill 来源类型".to_string()),
    };
    let Some(selected) = selected else { return Ok(None) };
    match selected {
        FilePath::Path(path) => Ok(Some(path.to_string_lossy().into_owned())),
        FilePath::Url(_) => Err("Skill 来源必须是本地路径".to_string()),
    }
}

#[tauri::command]
pub(crate) async fn ai_skill_install_git(app: tauri::AppHandle, url: String) -> Result<AiConfigSummary, String> {
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("git@")) {
        return Err("Git 地址只支持 http(s):// 或 git@ 主机格式".to_string());
    }
    let repo = url.rsplit('/').next().unwrap_or("skill").trim_end_matches(".git");
    let target = runtime_work_dir().join(".cline").join("imported-git-skills").join(format!("{}-{}", sanitize_skill_dir_name(repo), now_ms()));
    if let Some(parent) = target.parent() { fs::create_dir_all(parent).map_err(|err| err.to_string())?; }

    // 优先系统 git（支持私有仓库与 SSH 地址）。用户未安装 git 时自动
    // 降级为托管平台的源码包接口，GitHub/GitLab 公开仓库无需 git 即可安装。
    match Command::new("git").args(["clone", "--depth", "1", url]).arg(&target).output().await {
        Ok(output) if output.status.success() => {}
        Ok(output) => {
            // git 可用但克隆失败（认证、网络或仓库问题）：保留 git 的原始诊断。
            return Err(format!("Git 安装失败：{}", String::from_utf8_lossy(&output.stderr).trim()));
        }
        Err(_) => {
            // 系统没有 git：走 HTTP 源码包下载。
            let _ = fs::remove_dir_all(&target);
            download_skill_source_archive(url, &target).await?;
        }
    }

    let markdown = read_imported_skill_markdown(&target)?;
    let fallback = target.file_name().and_then(|value| value.to_str()).unwrap_or("imported-skill");
    persist_imported_skill(&app, parse_imported_skill(&markdown, fallback)?)
}

/// 无 Git 时按顺序尝试的源码包下载地址。
///
/// 只支持公开的 GitHub / GitLab https 仓库：GitHub 用官方 API tarball
/// （跟随重定向，默认分支），GitLab 依次尝试 main 与 master 分支的
/// archive 接口。其余托管平台或 git@ 地址无法无 git 下载。
fn skill_source_archive_candidates(url: &str) -> Result<Vec<String>, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "无法解析 Git 地址".to_string())?;
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    let segments: Vec<String> = parsed
        .path_segments()
        .map(|values| values.map(|value| value.to_string()).collect())
        .unwrap_or_default();
    if host == "github.com" && segments.len() >= 2 {
        let owner = &segments[0];
        let repo = segments[1].trim_end_matches(".git");
        if owner.is_empty() || repo.is_empty() {
            return Err("Git 地址缺少仓库所有者或名称".to_string());
        }
        return Ok(vec![format!("https://api.github.com/repos/{owner}/{repo}/tarball")]);
    }
    if host == "gitlab.com" && segments.len() >= 2 {
        let repo = segments
            .last()
            .map(|value| value.trim_end_matches(".git"))
            .unwrap_or("")
            .to_string();
        let group = segments[..segments.len() - 1].join("/");
        if group.is_empty() || repo.is_empty() {
            return Err("Git 地址缺少仓库组或名称".to_string());
        }
        let base = format!("https://gitlab.com/{group}/{repo}");
        return Ok(vec![
            format!("{base}/-/archive/main/{repo}-main.tar.gz"),
            format!("{base}/-/archive/master/{repo}-master.tar.gz"),
        ]);
    }
    Err(format!(
        "未检测到 Git，且 {} 不是 GitHub 或 GitLab 仓库。请安装 Git 后重试，或改用 GitHub/GitLab 的 https 地址。",
        if host.is_empty() { "该地址" } else { host.as_str() }
    ))
}

async fn download_skill_source_archive(url: &str, target: &Path) -> Result<(), String> {
    let candidates = skill_source_archive_candidates(url)?;
    let mut failures = Vec::<String>::new();
    for candidate in candidates {
        match http_download_skill_archive(&candidate).await {
            Ok(bytes) => return extract_skill_archive(&bytes, target),
            Err(error) => failures.push(error),
        }
    }
    Err(format!(
        "未检测到 Git，且无法从源码包接口下载该仓库（{}）。请确认仓库公开可访问，或安装 Git 后重试。",
        failures.join(" | ")
    ))
}

async fn http_download_skill_archive(url: &str) -> Result<Vec<u8>, String> {
    let response = reqwest::Client::new()
        .get(url)
        .header(reqwest::header::USER_AGENT, "Desic-Terminal")
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|error| format!("下载失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|error| format!("读取下载内容失败：{error}"))
}

/// 解压 tar.gz 源码包到 target。
///
/// tar crate 的 unpack 会拒绝绝对路径与父目录穿越条目（目录穿越是
/// 恶意源码包最危险的向量之一）。GitHub/GitLab 源码包在顶层包了一层
/// 目录（`repo-sha/` 或 `repo-branch/`），这里把唯一的顶层目录提升为
/// target，让导入逻辑直接看到 SKILL.md。
fn extract_skill_archive(bytes: &[u8], target: &Path) -> Result<(), String> {
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);
    let staging_parent = target.parent().ok_or_else(|| "Skill 目标路径无效".to_string())?;
    let staging = staging_parent.join(format!(".skill-unpack-{}", now_ms()));
    fs::create_dir_all(&staging).map_err(|error| format!("创建解压目录失败：{error}"))?;
    if let Err(error) = archive.unpack(&staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("解压源码包失败：{error}"));
    }
    let promoted = match fs::read_dir(&staging) {
        Ok(mut entries) => {
            let first = entries.next();
            let second = entries.next();
            match (first, second) {
                (Some(Ok(first)), None)
                    if first.file_type().map(|kind| kind.is_dir()).unwrap_or(false) =>
                {
                    first.path()
                }
                _ => staging.clone(),
            }
        }
        Err(_) => staging.clone(),
    };
    let _ = fs::remove_dir_all(target);
    fs::rename(&promoted, target).map_err(|error| format!("移动解压内容失败：{error}"))?;
    if promoted != staging {
        let _ = fs::remove_dir_all(&staging);
    }
    Ok(())
}

/// One on-demand file inside a Skill directory, addressed by a relative path.
#[derive(Debug, Clone)]
pub(crate) struct AiSkillResource {
    pub path: String,
    pub contents: String,
}

/// A Skill plus the progressive-disclosure resources it exposes.
#[derive(Debug, Clone)]
pub(crate) struct AiSkillBundle {
    pub definition: AiSkillDefinition,
    pub resources: Vec<AiSkillResource>,
}

/// Writes an application-owned, non-persistent Skill for a narrowly scoped
/// interaction. These Skills are never inserted into the user's AI
/// configuration; the caller must still explicitly include its id in the
/// per-run Cline configuration before it can be used.
///
/// A bundle whose body already carries its own Markdown structure is written
/// verbatim under generated frontmatter, so it keeps the standard
/// `SKILL.md` + `docs/` layout rather than the legacy 规则/内容 sections.
pub(crate) fn sync_cline_runtime_scoped_skill(bundle: &AiSkillBundle) -> Result<(), String> {
    let skill = &bundle.definition;
    let id = skill.id.trim();
    if id.is_empty() || !is_runtime_scoped_skill_id(id) {
        return Err("未知的运行时 Skill 标识".to_string());
    }
    let root = runtime_paths().cline_skills_dir;
    fs::create_dir_all(&root).map_err(|err| err.to_string())?;
    let dir = root.join(sanitize_skill_dir_name(id));
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let content = format!(
        "---\nname: {}\ndescription: {}\ndisabled: false\n---\n\n{}\n",
        yaml_scalar(id),
        yaml_scalar(&skill.description),
        skill.content.trim(),
    );
    write_file_atomically(&dir.join("SKILL.md"), content.as_bytes())?;
    for resource in &bundle.resources {
        let relative = validated_skill_resource_path(&resource.path)?;
        let target = dir.join(&relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|err| {
                format!("创建 Skill 资源目录 {} 失败：{}", parent.display(), err)
            })?;
        }
        write_file_atomically(&target, resource.contents.as_bytes())?;
    }
    Ok(())
}

/// Validates a Skill-relative resource path.
///
/// Rejects absolute paths, parent traversal, and non-normal components so a
/// bundle can only ever write inside its own Skill directory.
pub(crate) fn validated_skill_resource_path(value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Skill 资源路径不能为空".to_string());
    }
    if trimmed.len() > 180 {
        return Err("Skill 资源路径过长".to_string());
    }
    if trimmed.contains('\\') || trimmed.contains('\0') {
        return Err(format!("Skill 资源路径不合法：{}", trimmed));
    }
    let candidate = Path::new(trimmed);
    if candidate.is_absolute() {
        return Err(format!("Skill 资源路径必须是相对路径：{}", trimmed));
    }
    // `Path::components` silently drops `.` segments, so reject any dot-prefixed
    // segment on the raw text before normalization can hide it.
    if trimmed
        .split('/')
        .any(|segment| segment.is_empty() || segment.starts_with('.'))
    {
        return Err(format!("Skill 资源路径不合法：{}", trimmed));
    }
    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            std::path::Component::Normal(part) => {
                let text = part
                    .to_str()
                    .ok_or_else(|| format!("Skill 资源路径不合法：{}", trimmed))?;
                if text.starts_with('.') {
                    return Err(format!("Skill 资源路径不合法：{}", trimmed));
                }
                normalized.push(text);
            }
            _ => return Err(format!("Skill 资源路径不合法：{}", trimmed)),
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err(format!("Skill 资源路径不合法：{}", trimmed));
    }
    Ok(normalized)
}

/// Reads one on-demand resource belonging to an application-owned Skill.
///
/// The path is validated, resolved inside the Skill directory, and the final
/// target must be a regular file that is still inside that directory after
/// symlink resolution.
pub(crate) fn read_cline_skill_resource(
    skill_id: &str,
    resource_path: &str,
) -> Result<String, String> {
    let id = skill_id.trim();
    if id.is_empty() || !is_runtime_scoped_skill_id(id) {
        return Err("未知的运行时 Skill 标识".to_string());
    }
    let relative = validated_skill_resource_path(resource_path)?;
    let dir = runtime_paths()
        .cline_skills_dir
        .join(sanitize_skill_dir_name(id));
    let root = dir
        .canonicalize()
        .map_err(|err| format!("Skill 目录不可用：{}", err))?;
    let target = root.join(&relative);
    let resolved = target.canonicalize().map_err(|_| {
        format!(
            "Skill 资源不存在：{}",
            relative.to_string_lossy().replace('\\', "/")
        )
    })?;
    if !resolved.starts_with(&root) {
        return Err("Skill 资源路径超出该 Skill 目录".to_string());
    }
    let metadata = fs::metadata(&resolved).map_err(|err| err.to_string())?;
    if !metadata.is_file() {
        return Err("Skill 资源不是普通文件".to_string());
    }
    if metadata.len() > 256 * 1024 {
        return Err("Skill 资源超过 256KB 读取上限".to_string());
    }
    fs::read_to_string(&resolved).map_err(|err| format!("读取 Skill 资源失败：{}", err))
}

fn is_runtime_scoped_skill_id(id: &str) -> bool {
    matches!(id, "systematic-strategy-authoring")
}

fn is_runtime_scoped_skill_dir(name: &str) -> bool {
    is_runtime_scoped_skill_id(name)
}

fn sanitize_skill_dir_name(value: &str) -> String {
    let safe = value
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            {
                '_'
            } else {
                ch
            }
        })
        .collect::<String>();
    let safe = safe.trim_matches(|ch: char| ch == ' ' || ch == '.');
    if safe.is_empty() {
        "item".to_string()
    } else {
        safe.to_string()
    }
}

fn yaml_scalar(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", escaped)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AiConnectionProbeProtocol {
    OpenAiResponses,
    AnthropicMessages,
    GeminiGenerateContent,
    OpenAiChat,
}

fn ai_connection_probe_protocol(provider: &str) -> AiConnectionProbeProtocol {
    match provider.trim().to_ascii_lowercase().as_str() {
        "openai-native" => AiConnectionProbeProtocol::OpenAiResponses,
        "anthropic" | "minimax" => AiConnectionProbeProtocol::AnthropicMessages,
        "gemini" => AiConnectionProbeProtocol::GeminiGenerateContent,
        _ => AiConnectionProbeProtocol::OpenAiChat,
    }
}

fn ai_provider_uses_local_cli(provider: &str) -> bool {
    matches!(
        provider.trim().to_ascii_lowercase().as_str(),
        "openai-codex-cli" | "claude-code"
    )
}

fn ai_model_is_configured(provider: &str, api_key: &str) -> bool {
    ai_provider_uses_local_cli(provider) || !api_key.trim().is_empty()
}

fn ai_auth_summary(provider: &str, api_key: &str) -> String {
    if ai_provider_uses_local_cli(provider) {
        "本机 CLI".to_string()
    } else {
        mask_key(api_key)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexProviderRoute {
    provider_id: String,
    name: String,
    base_url: String,
    wire_api: String,
    requires_openai_auth: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    env_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    supports_websockets: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_max_retries: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_max_retries: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_idle_timeout_ms: Option<u64>,
}

fn valid_codex_config_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn valid_environment_variable_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(byte) if byte.is_ascii_alphabetic() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn parse_codex_provider_route(content: &str) -> Result<Option<CodexProviderRoute>, String> {
    let config = content
        .parse::<toml::Value>()
        .map_err(|err| format!("Codex config.toml 语法无效：{err}"))?;
    let Some(provider_id) = config
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let Some(provider) = config
        .get("model_providers")
        .and_then(toml::Value::as_table)
        .and_then(|providers| providers.get(provider_id))
        .and_then(toml::Value::as_table)
    else {
        // Built-in provider ids do not need to be reconstructed after user config is ignored.
        return Ok(None);
    };
    if !valid_codex_config_id(provider_id) {
        return Err("Codex model_provider 只能包含字母、数字、下划线和连字符".to_string());
    }
    let base_url = provider
        .get("base_url")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Codex Provider {provider_id} 缺少 base_url"))?;
    let parsed_url = reqwest::Url::parse(base_url)
        .map_err(|_| format!("Codex Provider {provider_id} 的 base_url 无效"))?;
    if !matches!(parsed_url.scheme(), "http" | "https")
        || !parsed_url.username().is_empty()
        || parsed_url.password().is_some()
        || parsed_url.query().is_some()
        || parsed_url.fragment().is_some()
    {
        return Err(format!(
            "Codex Provider {provider_id} 的 base_url 必须是无凭据、无片段的 HTTP(S) URL"
        ));
    }
    let wire_api = provider
        .get("wire_api")
        .and_then(toml::Value::as_str)
        .unwrap_or("responses")
        .trim();
    if wire_api != "responses" {
        return Err(format!(
            "Codex Provider {provider_id} 的 wire_api={wire_api} 暂不受支持"
        ));
    }
    let env_key = provider
        .get("env_key")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            if valid_environment_variable_name(value) {
                Ok(value.to_string())
            } else {
                Err(format!(
                    "Codex Provider {provider_id} 的 env_key 不是有效环境变量名"
                ))
            }
        })
        .transpose()?;
    let bounded_u64 = |key: &str, maximum: u64| -> Result<Option<u64>, String> {
        provider
            .get(key)
            .map(|value| {
                value
                    .as_integer()
                    .filter(|value| *value >= 0 && (*value as u64) <= maximum)
                    .map(|value| value as u64)
                    .ok_or_else(|| format!("Codex Provider {provider_id} 的 {key} 超出允许范围"))
            })
            .transpose()
    };
    Ok(Some(CodexProviderRoute {
        provider_id: provider_id.to_string(),
        name: provider
            .get("name")
            .and_then(toml::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(provider_id)
            .chars()
            .filter(|ch| !ch.is_control())
            .take(120)
            .collect(),
        base_url: base_url.trim_end_matches('/').to_string(),
        wire_api: wire_api.to_string(),
        requires_openai_auth: provider
            .get("requires_openai_auth")
            .and_then(toml::Value::as_bool)
            .unwrap_or(false),
        env_key,
        supports_websockets: provider
            .get("supports_websockets")
            .and_then(toml::Value::as_bool),
        request_max_retries: bounded_u64("request_max_retries", 100)?,
        stream_max_retries: bounded_u64("stream_max_retries", 100)?,
        stream_idle_timeout_ms: bounded_u64("stream_idle_timeout_ms", 3_600_000)?,
    }))
}

pub(crate) fn load_codex_provider_route() -> Result<Option<CodexProviderRoute>, String> {
    let config_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            let home_var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
            std::env::var_os(home_var)
                .map(PathBuf::from)
                .map(|home| home.join(".codex"))
        });
    let Some(path) = config_home.map(|home| home.join("config.toml")) else {
        return Ok(None);
    };
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("读取 Codex config.toml 失败：{err}")),
    };
    parse_codex_provider_route(&content)
}

fn safe_cli_version(output: &std::process::Output) -> Option<String> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let line = stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    Some(line.chars().take(80).collect())
}

fn ai_cli_candidates(program: &str) -> Vec<PathBuf> {
    let executable_name = if cfg!(windows) {
        format!("{program}.cmd")
    } else {
        program.to_string()
    };
    // A GUI-launched process can have a narrower PATH than an interactive shell.
    // On Windows, prefer known absolute npm locations before a bare command name.
    let mut candidates = if cfg!(windows) {
        Vec::new()
    } else {
        vec![PathBuf::from(program)]
    };
    for env_name in ["NVM_BIN", "VOLTA_HOME"] {
        if let Some(path) = std::env::var_os(env_name).map(PathBuf::from) {
            let bin = if env_name == "VOLTA_HOME" {
                path.join("bin")
            } else {
                path
            };
            candidates.push(bin.join(&executable_name));
        }
    }
    if cfg!(windows) {
        if let Some(app_data) = std::env::var_os("APPDATA").map(PathBuf::from) {
            candidates.push(app_data.join("npm").join(&executable_name));
        }
    }
    let home_var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    if let Some(home) = std::env::var_os(home_var).map(PathBuf::from) {
        for relative in [
            ".local/bin",
            ".npm-global/bin",
            ".volta/bin",
            "AppData/Roaming/npm",
        ] {
            candidates.push(home.join(relative).join(&executable_name));
        }
        let nvm_versions = home.join(".nvm/versions/node");
        if let Ok(entries) = fs::read_dir(nvm_versions) {
            let mut versioned = entries
                .filter_map(Result::ok)
                .map(|entry| entry.path().join("bin").join(&executable_name))
                .collect::<Vec<_>>();
            versioned.sort_by(|left, right| right.cmp(left));
            candidates.extend(versioned);
        }
    }
    if !cfg!(windows) {
        candidates.extend([
            PathBuf::from("/opt/homebrew/bin").join(&executable_name),
            PathBuf::from("/usr/local/bin").join(&executable_name),
        ]);
    } else {
        candidates.push(PathBuf::from(program));
    }
    let mut unique = Vec::new();
    for candidate in candidates {
        if !unique.contains(&candidate) {
            unique.push(candidate);
        }
    }
    unique
}

async fn ai_cli_output(program: &std::path::Path, args: &[&str]) -> Option<std::process::Output> {
    let mut command = if cfg!(windows) {
        let mut command = tokio::process::Command::new("cmd");
        command.arg("/C").arg(program);
        command
    } else {
        tokio::process::Command::new(program)
    };
    command.args(args).kill_on_drop(true);
    tokio::time::timeout(std::time::Duration::from_secs(8), command.output())
        .await
        .ok()?
        .ok()
}

pub(crate) async fn resolve_ai_cli_executable(
    program: &str,
) -> Option<(PathBuf, std::process::Output)> {
    for candidate in ai_cli_candidates(program) {
        let Some(output) = ai_cli_output(&candidate, &["--version"]).await else {
            continue;
        };
        if output.status.success() {
            return Some((candidate, output));
        }
    }
    None
}

async fn read_ai_local_cli_status(provider: &str) -> AiLocalCliStatus {
    let (name, program, status_args, login_command) = match provider {
        "openai-codex-cli" => ("Codex", "codex", vec!["login", "status"], "codex login"),
        _ => (
            "Claude Code",
            "claude",
            vec!["auth", "status", "--json"],
            "claude auth login",
        ),
    };
    let resolved = resolve_ai_cli_executable(program).await;
    let executable = resolved.as_ref().map(|(path, _)| path.clone());
    let version_output = resolved.as_ref().map(|(_, output)| output);
    let installed = executable.is_some();
    let version = version_output.and_then(safe_cli_version);
    let status_output = match executable.as_deref() {
        Some(executable) => ai_cli_output(executable, &status_args).await,
        None => None,
    };
    let mut authenticated = false;
    let mut auth_method = None;
    if let Some(output) = status_output
        .as_ref()
        .filter(|output| output.status.success())
    {
        if provider == "openai-codex-cli" {
            let status_text = format!(
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
            .to_ascii_lowercase();
            authenticated = status_text.contains("logged in");
            auth_method = authenticated.then(|| {
                if status_text.contains("api key") {
                    "API Key".to_string()
                } else {
                    "ChatGPT OAuth".to_string()
                }
            });
        } else if let Ok(status) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
            authenticated = status
                .get("loggedIn")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            auth_method = status
                .get("authMethod")
                .and_then(serde_json::Value::as_str)
                .map(|method| match method {
                    "oauth_token" => "Claude OAuth".to_string(),
                    "api_key" => "API Key".to_string(),
                    other => other.to_string(),
                });
        }
    }
    AiLocalCliStatus {
        id: provider.to_string(),
        name: name.to_string(),
        installed,
        authenticated,
        version,
        auth_method,
        login_command: login_command.to_string(),
    }
}

#[tauri::command]
pub(crate) async fn ai_local_auth_status() -> Result<AiLocalAuthStatus, String> {
    let (codex, claude) = tokio::join!(
        read_ai_local_cli_status("openai-codex-cli"),
        read_ai_local_cli_status("claude-code")
    );
    Ok(AiLocalAuthStatus {
        providers: vec![codex, claude],
    })
}

fn resolve_ai_connection_test_model(
    stored: Option<&AiConfig>,
    update: &AiModelConfigUpdate,
) -> Result<AiModelConfig, String> {
    let id = update.id.trim().to_string();
    let name = update.name.trim().to_string();
    let provider = update.provider.trim().to_string();
    let model = update.model.trim().to_string();
    let base_url = update.base_url.trim().trim_end_matches('/').to_string();
    if id.is_empty()
        || name.is_empty()
        || provider.is_empty()
        || model.is_empty()
        || base_url.is_empty()
    {
        return Err("请补全选中模型的名称、Provider、Model ID 和 Base URL".to_string());
    }
    let stored_key = stored
        .and_then(|config| config.models.iter().find(|item| item.id == id))
        .map(|item| item.api_key.trim())
        .filter(|value| !value.is_empty());
    let api_key = update
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or(stored_key)
        .unwrap_or_default()
        .to_string();
    if api_key.is_empty() && !ai_provider_uses_local_cli(&provider) {
        return Err(format!("AI 模型配置缺少 API Key：{}", name));
    }
    Ok(AiModelConfig {
        id,
        name,
        provider,
        model,
        base_url,
        api_key,
        permission_mode: normalize_ai_permission_mode(update.permission_mode.as_deref()),
        reasoning_depth: normalize_ai_reasoning_depth(update.reasoning_depth.as_deref()),
    })
}

fn ai_connection_probe_endpoint(model: &AiModelConfig) -> Result<String, String> {
    let base_url = model.base_url.trim_end_matches('/');
    match ai_connection_probe_protocol(&model.provider) {
        AiConnectionProbeProtocol::OpenAiResponses => Ok(format!("{base_url}/responses")),
        AiConnectionProbeProtocol::AnthropicMessages => Ok(format!("{base_url}/messages")),
        AiConnectionProbeProtocol::OpenAiChat => Ok(format!("{base_url}/chat/completions")),
        AiConnectionProbeProtocol::GeminiGenerateContent => {
            let mut endpoint = reqwest::Url::parse(base_url)
                .map_err(|error| format!("AI Base URL 无效：{}", error))?;
            endpoint
                .path_segments_mut()
                .map_err(|_| "Gemini Base URL 不能作为 API 基础地址".to_string())?
                .pop_if_empty()
                .push("models")
                .push(&model.model);
            Ok(format!(
                "{}:generateContent",
                endpoint.as_str().trim_end_matches('/')
            ))
        }
    }
}

#[tauri::command]
pub(crate) async fn ai_test_connection(
    app: tauri::AppHandle,
    model: AiModelConfigUpdate,
) -> Result<AiConnectionTestResult, String> {
    let stored = match load_ai_config(&app) {
        Ok(config) => Some(config),
        Err(error) if is_unconfigured_ai_config_error(&error) => None,
        Err(error) => return Err(error),
    };
    let selected = resolve_ai_connection_test_model(stored.as_ref(), &model)?;
    if ai_provider_uses_local_cli(&selected.provider) {
        let status = read_ai_local_cli_status(&selected.provider).await;
        if !status.installed {
            return Err(format!("未检测到 {}，请先安装官方 CLI", status.name));
        }
        if !status.authenticated {
            return Err(format!(
                "{} 尚未登录，请先运行：{}",
                status.name, status.login_command
            ));
        }
        return Ok(AiConnectionTestResult {
            id: selected.id,
            name: selected.name,
            provider: selected.provider,
            model: selected.model,
        });
    }
    let protocol = ai_connection_probe_protocol(&selected.provider);
    let endpoint = ai_connection_probe_endpoint(&selected)?;
    let body = match protocol {
        AiConnectionProbeProtocol::OpenAiResponses => json!({
            "model": selected.model,
            "input": "只回复两个字：收到",
            "max_output_tokens": 16
        }),
        AiConnectionProbeProtocol::AnthropicMessages => json!({
            "model": selected.model,
            "max_tokens": 16,
            "messages": [{ "role": "user", "content": "只回复两个字：收到" }]
        }),
        AiConnectionProbeProtocol::GeminiGenerateContent => json!({
            "contents": [{ "role": "user", "parts": [{ "text": "只回复两个字：收到" }] }],
            "generationConfig": { "maxOutputTokens": 16 }
        }),
        AiConnectionProbeProtocol::OpenAiChat => {
            let mut body = json!({
                "model": selected.model,
                "stream": false,
                "max_tokens": 16,
                "messages": [{ "role": "user", "content": "只回复两个字：收到" }]
            });
            let provider = selected.provider.trim().to_ascii_lowercase();
            let model = selected.model.trim().to_ascii_lowercase();
            if provider == "doubao"
                || (provider == "moonshot" && matches!(model.as_str(), "kimi-k2.6" | "kimi-k2.5"))
            {
                body["thinking"] = json!({ "type": "disabled" });
            }
            body
        }
    };
    let client = reqwest_client()?;
    let mut request = client
        .post(endpoint)
        .header(CONTENT_TYPE, "application/json");
    request = match protocol {
        AiConnectionProbeProtocol::AnthropicMessages => request
            .header("x-api-key", &selected.api_key)
            .header("anthropic-version", "2023-06-01"),
        AiConnectionProbeProtocol::GeminiGenerateContent => {
            request.header("x-goog-api-key", &selected.api_key)
        }
        AiConnectionProbeProtocol::OpenAiResponses | AiConnectionProbeProtocol::OpenAiChat => {
            request.header(AUTHORIZATION, format!("Bearer {}", selected.api_key))
        }
    };
    let response = request
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("AI test failed: {}", err))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!(
            "AI test HTTP {}: {}",
            status,
            sanitize_secret(&text, &selected.api_key)
        ));
    }
    Ok(AiConnectionTestResult {
        id: selected.id,
        name: selected.name,
        provider: selected.provider,
        model: selected.model,
    })
}

#[tauri::command]
pub(crate) fn proxy_config_summary() -> Result<ProxyConfigSummary, String> {
    Ok(proxy_config_summary_from(load_proxy_config()?))
}

#[tauri::command]
pub(crate) fn migrate_sensitive_config(
    app: tauri::AppHandle,
) -> Result<SensitiveConfigMigrationResult, String> {
    let accounts = load_accounts_config(&app)?;
    let ai = match load_ai_config(&app) {
        Ok(config) => Some(config),
        Err(error) if is_unconfigured_ai_config_error(&error) => None,
        Err(error) => return Err(format!("迁移 AI 敏感配置失败：{}", error)),
    };
    let proxy = load_proxy_config().unwrap_or_default();
    harden_existing_sensitive_config_files();
    Ok(SensitiveConfigMigrationResult {
        accounts: accounts.accounts.len(),
        ai_configured: ai.as_ref().is_some_and(|config| {
            ai_model_is_configured(
                config.provider.as_deref().unwrap_or_default(),
                &config.api_key,
            )
        }),
        proxy_auth_configured: proxy
            .password
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty()),
        migrated_at: now_ms(),
    })
}

#[tauri::command]
pub(crate) fn save_proxy_config(update: ProxyConfigUpdate) -> Result<ProxyConfigSummary, String> {
    let existing = load_proxy_config().ok();
    let config = ProxyConfig {
        enabled: update.enabled,
        proxy_type: update.proxy_type,
        host: update.host,
        port: update.port,
        username: update.username.and_then(non_empty_string),
        password: resolve_proxy_password(update.password, existing.as_ref()),
    };
    validate_proxy_config(&config)?;
    save_proxy_config_file(&config)?;
    Ok(proxy_config_summary_from(config))
}

#[tauri::command]
pub(crate) async fn test_proxy_config(
    update: ProxyConfigUpdate,
) -> Result<ProxyTestResult, String> {
    let existing = load_proxy_config().ok();
    let config = ProxyConfig {
        enabled: update.enabled,
        proxy_type: update.proxy_type,
        host: update.host,
        port: update.port,
        username: update.username.and_then(non_empty_string),
        password: resolve_proxy_password(update.password, existing.as_ref()),
    };
    validate_proxy_config(&config)?;
    save_proxy_config_file(&config)?;
    let client = reqwest_client_with_proxy(&config)?;
    let started = now_ms();
    let response = client
        .get(format!("{}{}", REST_BASE, "/api/v5/public/time"))
        .send()
        .await
        .map_err(|err| format!("代理测试失败: {}", err))?;
    let latency_ms = now_ms() - started;
    if !response.status().is_success() {
        return Err(format!("代理测试 HTTP {}", response.status()));
    }
    let envelope = response
        .json::<OkxEnvelope<OkxTime>>()
        .await
        .map_err(|err| format!("代理测试响应解析失败: {}", err))?;
    if envelope.code != "0" {
        return Err(format!("代理测试 OKX {}: {}", envelope.code, envelope.msg));
    }
    Ok(ProxyTestResult {
        ok: true,
        latency_ms,
        message: "OKX REST 可达".to_string(),
        config: proxy_config_summary_from(config),
    })
}

#[tauri::command]
pub(crate) fn load_watchlist_config(app: tauri::AppHandle) -> Result<WatchlistConfig, String> {
    load_watchlist_config_file(&app)
}

#[tauri::command]
pub(crate) fn save_watchlist_config(
    app: tauri::AppHandle,
    config: WatchlistConfig,
) -> Result<WatchlistConfig, String> {
    let normalized = WatchlistConfig {
        symbols: normalize_watchlist_symbols(config.symbols),
    };
    save_watchlist_config_file(&app, &normalized)?;
    Ok(normalized)
}

const SUPPORTED_UI_LOCALES: [&str; 10] = [
    "zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR", "de-DE", "fr-FR", "es-ES", "pt-BR", "ru-RU",
];

fn valid_ui_language_preference(value: &str) -> bool {
    value == "system" || SUPPORTED_UI_LOCALES.contains(&value)
}

fn match_supported_ui_locale(value: Option<&str>) -> Option<&'static str> {
    let normalized = value?.trim().replace('_', "-").to_lowercase();
    if normalized == "zh-hant"
        || normalized.starts_with("zh-hant-")
        || normalized.starts_with("zh-tw")
        || normalized.starts_with("zh-hk")
        || normalized.starts_with("zh-mo")
    {
        return Some("zh-TW");
    }
    if normalized == "zh" || normalized.starts_with("zh-") {
        return Some("zh-CN");
    }
    for (language, locale) in [
        ("en", "en-US"),
        ("ja", "ja-JP"),
        ("ko", "ko-KR"),
        ("de", "de-DE"),
        ("fr", "fr-FR"),
        ("es", "es-ES"),
        ("pt", "pt-BR"),
        ("ru", "ru-RU"),
    ] {
        if normalized == language || normalized.starts_with(&format!("{language}-")) {
            return Some(locale);
        }
    }
    None
}

fn ui_preferences_summary_from(
    config: UiPreferencesConfig,
    system_locale: Option<&str>,
) -> UiPreferencesSummary {
    let language = if valid_ui_language_preference(&config.language) {
        config.language
    } else {
        "system".to_string()
    };
    let resolved_language = if language == "system" {
        match_supported_ui_locale(system_locale)
            .or_else(|| match_supported_ui_locale(config.resolved_language.as_deref()))
            .unwrap_or("en-US")
            .to_string()
    } else {
        language.clone()
    };
    UiPreferencesSummary {
        language,
        resolved_language,
    }
}

pub(crate) fn automation_prompt_locale() -> String {
    let config = load_ui_preferences_config().unwrap_or_default();
    if config.language == "system" {
        match_supported_ui_locale(config.resolved_language.as_deref())
            .unwrap_or("en-US")
            .to_string()
    } else {
        match_supported_ui_locale(Some(&config.language))
            .unwrap_or("en-US")
            .to_string()
    }
}

#[tauri::command]
pub(crate) fn ui_preferences_summary(
    request: UiPreferencesQuery,
) -> Result<UiPreferencesSummary, String> {
    Ok(ui_preferences_summary_from(
        load_ui_preferences_config()?,
        request.system_locale.as_deref(),
    ))
}

#[tauri::command]
pub(crate) fn save_ui_preferences(
    app: tauri::AppHandle,
    request: UiPreferencesUpdate,
) -> Result<UiPreferencesSummary, String> {
    if !valid_ui_language_preference(&request.language) {
        return Err("unsupported UI language preference".to_string());
    }
    let resolved_language = if request.language == "system" {
        match_supported_ui_locale(request.system_locale.as_deref())
            .unwrap_or("en-US")
            .to_string()
    } else {
        request.language.clone()
    };
    let config = UiPreferencesConfig {
        language: request.language,
        resolved_language: Some(resolved_language),
    };
    let content = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    write_file_atomically(&workspace_ui_preferences_path(), content.as_bytes())?;
    let summary = ui_preferences_summary_from(config, request.system_locale.as_deref());
    app.emit("ui:locale-changed", summary.clone())
        .map_err(|error| error.to_string())?;
    Ok(summary)
}

#[tauri::command]
pub(crate) async fn storage_maintenance(
    app: tauri::AppHandle,
) -> Result<StorageMaintenanceResult, String> {
    tauri::async_runtime::spawn_blocking(move || storage_maintenance_blocking(app))
        .await
        .map_err(|error| format!("存储维护任务失败：{error}"))?
}

fn storage_maintenance_blocking(app: tauri::AppHandle) -> Result<StorageMaintenanceResult, String> {
    let path = database_path(&app)?;
    let conn = open_database(&app)?;
    let active_runs = conn
        .query_row(
            "SELECT COUNT(*) FROM ai_agent_runs WHERE status IN ('queued','running')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| err.to_string())?;
    if active_runs > 0 {
        return Err("仍有 AI Agent Run 正在排队或运行，请结束后再执行存储维护".to_string());
    }
    let wal_bytes_before = fs::metadata(path.with_extension("sqlite3-wal"))
        .map(|meta| meta.len())
        .unwrap_or_default();
    let cutoff_kline = now_ms() - 30 * 24 * 60 * 60_000;
    let deleted_kline_sync_runs = conn
        .execute(
            "DELETE FROM kline_sync_runs WHERE started_at < ?1",
            params![cutoff_kline],
        )
        .map_err(|err| err.to_string())?;
    let deleted_ai_messages = trim_ai_messages(&conn, 200)?;
    let archived_backtest_series = crate::systematic::archive_backtest_series(&conn)?;
    // Runs recorded before report slimming still hold 100-270 MB of per-bar
    // arrays each, which slows every read of the backtest history page.
    let compacted_legacy_reports = crate::systematic::compact_legacy_backtest_reports(&conn)?;
    let archived_backtest_series = archived_backtest_series + compacted_legacy_reports;
    let intelligence_settings = desic_intelligence::load_settings(&conn)?;
    let deleted_intelligence_rows =
        desic_intelligence::run_retention(&conn, now_ms(), &intelligence_settings)?;
    let _ = conn.execute_batch(
        "
        PRAGMA wal_checkpoint(TRUNCATE);
        PRAGMA optimize;
        ",
    );
    let rows = storage_table_counts(&conn)?;
    let kline_ranges = storage_kline_ranges(&app, &conn)?;
    let database_bytes = fs::metadata(&path)
        .map(|meta| meta.len())
        .unwrap_or_default();
    let wal_bytes = fs::metadata(path.with_extension("sqlite3-wal"))
        .map(|meta| meta.len())
        .unwrap_or_default();
    let reusable_bytes = storage_reusable_bytes(&conn)?;
    let finished_at = now_ms();
    LAST_STORAGE_MAINTENANCE_AT.store(finished_at, std::sync::atomic::Ordering::Release);
    Ok(StorageMaintenanceResult {
        database_path: path.to_string_lossy().to_string(),
        database_bytes,
        wal_bytes,
        wal_bytes_before,
        reusable_bytes,
        schema_version: database_schema_version(&conn)?,
        rows,
        kline_ranges,
        deleted_kline_sync_runs,
        deleted_ai_messages,
        deleted_intelligence_rows,
        archived_backtest_series,
        finished_at,
    })
}

#[tauri::command]
pub(crate) async fn storage_status(app: tauri::AppHandle) -> Result<StorageStatusResult, String> {
    tauri::async_runtime::spawn_blocking(move || storage_status_blocking(app))
        .await
        .map_err(|error| format!("读取存储状态任务失败：{error}"))?
}

fn storage_status_blocking(app: tauri::AppHandle) -> Result<StorageStatusResult, String> {
    let path = database_path(&app)?;
    let conn = open_read_database(&app)?;
    let last_maintenance_at =
        match LAST_STORAGE_MAINTENANCE_AT.load(std::sync::atomic::Ordering::Acquire) {
            0 => None,
            value => Some(value),
        };
    Ok(StorageStatusResult {
        database_path: path.to_string_lossy().to_string(),
        database_bytes: fs::metadata(&path)
            .map(|meta| meta.len())
            .unwrap_or_default(),
        wal_bytes: fs::metadata(path.with_extension("sqlite3-wal"))
            .map(|meta| meta.len())
            .unwrap_or_default(),
        reusable_bytes: storage_reusable_bytes(&conn)?,
        schema_version: database_schema_version(&conn)?,
        last_maintenance_at,
        rows: storage_table_counts(&conn)?,
        kline_ranges: storage_kline_ranges(&app, &conn)?,
        checked_at: now_ms(),
    })
}

fn storage_reusable_bytes(conn: &Connection) -> Result<u64, String> {
    let page_size = conn
        .query_row("PRAGMA page_size", [], |row| row.get::<_, u64>(0))
        .map_err(|err| err.to_string())?;
    let free_pages = conn
        .query_row("PRAGMA freelist_count", [], |row| row.get::<_, u64>(0))
        .map_err(|err| err.to_string())?;
    Ok(page_size.saturating_mul(free_pages))
}

fn storage_kline_ranges(
    app: &tauri::AppHandle,
    conn: &Connection,
) -> Result<Vec<KlineDataRange>, String> {
    let watchlist = load_watchlist_config_file(app).unwrap_or_default();
    let symbols = normalize_watchlist_symbols(watchlist.symbols);
    let mut rows = Vec::new();
    for symbol in symbols {
        let (first_time, last_time, count) = conn
            .query_row(
                "SELECT MIN(open_time), MAX(open_time), COUNT(*)
                 FROM candles
                 WHERE symbol = ?1 AND interval = '1m'",
                params![symbol],
                |row| {
                    Ok((
                        row.get::<_, Option<i64>>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .map_err(|err| err.to_string())?;
        rows.push(KlineDataRange {
            symbol,
            interval: "1m".to_string(),
            first_time,
            last_time,
            count,
        });
    }
    Ok(rows)
}

fn write_diagnostics_zip(path: &PathBuf, diagnostics_json: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let file = fs::File::create(path).map_err(|err| err.to_string())?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o600);
    zip.start_file("diagnostics.json", options)
        .map_err(|err| err.to_string())?;
    zip.write_all(diagnostics_json.as_bytes())
        .map_err(|err| err.to_string())?;
    zip.start_file("README.txt", options)
        .map_err(|err| err.to_string())?;
    zip.write_all(
        b"Desic Terminal diagnostics export.\nSensitive account, proxy, AI key and authorization fields are redacted before writing this archive.\n",
    )
    .map_err(|err| err.to_string())?;
    zip.finish().map_err(|err| err.to_string())?;
    Ok(())
}

pub(crate) fn load_accounts_config(app: &tauri::AppHandle) -> Result<AccountsConfig, String> {
    let path = workspace_config_path();
    if !path.exists() {
        return Ok(AccountsConfig::default());
    }
    let content = fs::read_to_string(&path).map_err(|err| err.to_string())?;
    let config: AccountsConfig = serde_json::from_str(&content).map_err(|err| err.to_string())?;
    let _ = app;
    Ok(config)
}

pub(crate) fn save_accounts_config(
    app: &tauri::AppHandle,
    config: &AccountsConfig,
) -> Result<(), String> {
    let path = workspace_config_path();
    let content = serde_json::to_string_pretty(config).map_err(|err| err.to_string())?;
    write_sensitive_config_file(&path, &content)?;
    let _ = app;
    Ok(())
}

pub(crate) fn load_proxy_config() -> Result<ProxyConfig, String> {
    let path = workspace_proxy_config_path();
    if !path.exists() {
        return Ok(ProxyConfig::default());
    }
    let content = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let config = serde_json::from_str::<ProxyConfig>(&content).map_err(|err| err.to_string())?;
    validate_proxy_config(&config)?;
    Ok(config)
}

pub(crate) fn ai_sidecar_proxy_url() -> Result<Option<String>, String> {
    ai_sidecar_proxy_url_from(&load_proxy_config()?)
}

fn ai_sidecar_proxy_url_from(config: &ProxyConfig) -> Result<Option<String>, String> {
    if !config.enabled || config.proxy_type.eq_ignore_ascii_case("NONE") {
        return Ok(None);
    }
    if !matches!(config.proxy_type.to_uppercase().as_str(), "HTTP" | "HTTPS") {
        return Err("AI Sidecar 当前仅支持应用的 HTTP/HTTPS 代理".to_string());
    }
    let mut url = reqwest::Url::parse(&proxy_url(config)?)
        .map_err(|err| format!("AI Sidecar 代理配置无效: {err}"))?;
    if let Some(username) = config
        .username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        url.set_username(username)
            .map_err(|_| "AI Sidecar 代理用户名无效".to_string())?;
        url.set_password(Some(config.password.as_deref().unwrap_or("")))
            .map_err(|_| "AI Sidecar 代理密码无效".to_string())?;
    }
    Ok(Some(url.to_string()))
}

pub(crate) fn load_watchlist_config_file(
    _app: &tauri::AppHandle,
) -> Result<WatchlistConfig, String> {
    let path = workspace_watchlist_config_path();
    if !path.exists() {
        return Ok(WatchlistConfig::default());
    }
    let content = fs::read_to_string(&path).map_err(|err| err.to_string())?;
    let config =
        serde_json::from_str::<WatchlistConfig>(&content).map_err(|err| err.to_string())?;
    Ok(WatchlistConfig {
        symbols: normalize_watchlist_symbols(config.symbols),
    })
}

pub(crate) fn save_watchlist_config_file(
    app: &tauri::AppHandle,
    config: &WatchlistConfig,
) -> Result<(), String> {
    let path = workspace_watchlist_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let content = serde_json::to_string_pretty(config).map_err(|err| err.to_string())?;
    fs::write(&path, content).map_err(|err| err.to_string())?;
    let _ = app;
    Ok(())
}

pub(crate) fn normalize_watchlist_symbols(symbols: Vec<String>) -> Vec<String> {
    let mut values = vec!["BTC-USDT-SWAP".to_string()];
    values.extend(symbols.into_iter().map(|item| item.trim().to_uppercase()));
    let mut unique = Vec::new();
    for symbol in values {
        if unique.len() >= 10 {
            break;
        }
        if !symbol.ends_with("-USDT-SWAP") || symbol.len() < "A-USDT-SWAP".len() {
            continue;
        }
        if !unique.contains(&symbol) {
            unique.push(symbol);
        }
    }
    if unique.is_empty() {
        vec!["BTC-USDT-SWAP".to_string()]
    } else {
        unique
    }
}

fn save_proxy_config_file(config: &ProxyConfig) -> Result<(), String> {
    let path = workspace_proxy_config_path();
    let content = serde_json::to_string_pretty(config).map_err(|err| err.to_string())?;
    write_sensitive_config_file(&path, &content)
}

fn validate_proxy_config(config: &ProxyConfig) -> Result<(), String> {
    if !matches!(
        config.proxy_type.to_uppercase().as_str(),
        "HTTP" | "HTTPS" | "SOCKS5" | "NONE"
    ) {
        return Err("代理类型必须是 HTTP、HTTPS、SOCKS5 或 NONE".to_string());
    }
    if config.enabled && config.host.trim().is_empty() {
        return Err("代理地址不能为空".to_string());
    }
    if config.enabled && config.port == 0 {
        return Err("代理端口无效".to_string());
    }
    if config.password.as_deref().unwrap_or("").trim().is_empty()
        && config.username.as_deref().unwrap_or("").trim().is_empty()
    {
        return Ok(());
    }
    if config.enabled && config.username.as_deref().unwrap_or("").trim().is_empty() {
        return Err("代理认证用户名不能为空".to_string());
    }
    Ok(())
}

fn proxy_config_summary_from(config: ProxyConfig) -> ProxyConfigSummary {
    let url = if config.enabled {
        proxy_url(&config).ok()
    } else {
        None
    };
    ProxyConfigSummary {
        enabled: config.enabled,
        proxy_type: config.proxy_type,
        host: config.host,
        port: config.port,
        url,
        username: config.username.as_deref().map(mask_key),
        auth_configured: config
            .username
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty()),
    }
}

fn proxy_url(config: &ProxyConfig) -> Result<String, String> {
    let scheme = match config.proxy_type.to_uppercase().as_str() {
        "HTTP" => "http",
        "HTTPS" => "https",
        "SOCKS5" => "socks5h",
        "NONE" => "none",
        _ => return Err("代理类型无效".to_string()),
    };
    if scheme == "none" {
        return Err("未启用代理".to_string());
    }
    Ok(format!(
        "{}://{}:{}",
        scheme,
        config.host.trim(),
        config.port
    ))
}

fn non_empty_string(value: String) -> Option<String> {
    let trimmed = value.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn resolve_proxy_password(
    update: Option<String>,
    existing: Option<&ProxyConfig>,
) -> Option<String> {
    match update.map(|value| value.trim().to_string()) {
        Some(value) if value.is_empty() => existing.and_then(|config| config.password.clone()),
        Some(value) if value.contains("****") => {
            existing.and_then(|config| config.password.clone())
        }
        Some(value) => Some(value),
        None => existing.and_then(|config| config.password.clone()),
    }
}

pub(crate) fn proxy_authorization_header(config: &ProxyConfig) -> String {
    let Some(username) = config
        .username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return String::new();
    };
    let password = config.password.as_deref().unwrap_or("");
    let token = general_purpose::STANDARD.encode(format!("{username}:{password}"));
    format!("Proxy-Authorization: Basic {token}\r\n")
}

pub(crate) fn reqwest_client() -> Result<reqwest::Client, String> {
    let config = load_proxy_config()?;
    let cache = REQWEST_CLIENT_CACHE.get_or_init(|| std::sync::Mutex::new(None));
    if let Ok(guard) = cache.lock() {
        if let Some((cached_config, client)) = guard.as_ref() {
            if cached_config == &config {
                return Ok(client.clone());
            }
        }
    }
    let client = reqwest_client_with_proxy(&config)?;
    if let Ok(mut guard) = cache.lock() {
        *guard = Some((config, client.clone()));
    }
    Ok(client)
}

pub(crate) fn reqwest_client_with_proxy(config: &ProxyConfig) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .use_native_tls()
        .user_agent("Desic-Terminal/0.1 desktop")
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .http1_only();
    if config.enabled {
        let url = proxy_url(config)?;
        let mut proxy =
            reqwest::Proxy::all(&url).map_err(|err| format!("代理配置无效: {}", err))?;
        if let Some(username) = config
            .username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            proxy = proxy.basic_auth(username, config.password.as_deref().unwrap_or(""));
        }
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|err| err.to_string())
}

pub(crate) fn frontend_log_dir(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = runtime_paths().log_dir;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn diagnostics_dir(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = runtime_paths().diagnostics_dir;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn redact_diagnostic_line(value: &str) -> String {
    let mut parsed = match serde_json::from_str::<serde_json::Value>(value) {
        Ok(value) => value,
        Err(_) => return redact_sensitive_text(value),
    };
    redact_sensitive_json(&mut parsed);
    serde_json::to_string(&parsed).unwrap_or_else(|_| "[redacted-log]".to_string())
}

fn redact_sensitive_json(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if is_sensitive_key(key) {
                    *child = serde_json::Value::String("[redacted]".to_string());
                } else {
                    redact_sensitive_json(child);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                redact_sensitive_json(item);
            }
        }
        serde_json::Value::String(text) => {
            *text = redact_sensitive_text(text);
        }
        _ => {}
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let lowered = key.to_ascii_lowercase();
    lowered.contains("apikey")
        || lowered.contains("api_key")
        || lowered.contains("secret")
        || lowered.contains("passphrase")
        || lowered.contains("password")
        || lowered.contains("authorization")
        || lowered.contains("proxy-authorization")
}

fn redact_sensitive_text(value: &str) -> String {
    for marker in [
        "apikey",
        "api_key",
        "secretkey",
        "secret_key",
        "secret",
        "passphrase",
        "password",
        "authorization",
        "proxy-authorization",
    ] {
        if value.to_ascii_lowercase().contains(marker) {
            return "[redacted-sensitive-log-line]".to_string();
        }
    }
    value.to_string()
}

fn write_sensitive_config_file(path: &PathBuf, content: &str) -> Result<(), String> {
    write_file_atomically_internal(path, content.as_bytes(), true)?;
    if let Err(err) = harden_sensitive_file_permissions(path) {
        eprintln!(
            "sensitive config permission hardening failed for {}: {}",
            path.display(),
            err
        );
    }
    Ok(())
}

fn write_file_atomically(path: &std::path::Path, content: &[u8]) -> Result<(), String> {
    write_file_atomically_internal(path, content, false)
}

fn write_file_atomically_internal(
    path: &std::path::Path,
    content: &[u8],
    harden_temp_permissions: bool,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("文件路径缺少父目录：{}", path.display()))?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("文件名无效：{}", path.display()))?;
    let sequence = ATOMIC_WRITE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temp_path = parent.join(format!(
        ".{}.{}-{}-{}.tmp",
        file_name,
        std::process::id(),
        now_ms(),
        sequence
    ));
    let result = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .map_err(|err| err.to_string())?;
        file.write_all(content).map_err(|err| err.to_string())?;
        file.sync_all().map_err(|err| err.to_string())?;
        drop(file);
        if harden_temp_permissions {
            harden_sensitive_file_permissions(&temp_path)?;
        }
        replace_file_atomically(&temp_path, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

#[cfg(windows)]
fn replace_file_atomically(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file_atomically(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    fs::rename(source, destination).map_err(|err| err.to_string())
}

fn harden_existing_sensitive_config_files() {
    for path in [
        workspace_config_path(),
        workspace_proxy_config_path(),
        workspace_ai_config_path(),
        workspace_notification_config_path(),
    ] {
        if path.exists() {
            if let Err(err) = harden_sensitive_file_permissions(&path) {
                eprintln!(
                    "sensitive config permission hardening failed for {}: {}",
                    path.display(),
                    err
                );
            }
        }
    }
}

#[cfg(windows)]
pub(crate) fn harden_sensitive_file_permissions(path: &PathBuf) -> Result<(), String> {
    let user = std::env::var("USERNAME").map_err(|err| err.to_string())?;
    let output = std::process::Command::new("icacls")
        .arg(path)
        .arg("/inheritance:r")
        .arg("/grant:r")
        .arg(format!("{user}:F"))
        .arg("/remove:g")
        .arg("Users")
        .arg("Everyone")
        .arg("Authenticated Users")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|err| err.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("icacls exited with {}", output.status)
        } else {
            format!("icacls exited with {}: {}", output.status, stderr)
        })
    }
}

#[cfg(unix)]
pub(crate) fn harden_sensitive_file_permissions(path: &PathBuf) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path)
        .map_err(|err| err.to_string())?
        .permissions();
    permissions.set_mode(0o600);
    fs::set_permissions(path, permissions).map_err(|err| err.to_string())
}

#[cfg(not(any(windows, unix)))]
pub(crate) fn harden_sensitive_file_permissions(_path: &PathBuf) -> Result<(), String> {
    Ok(())
}

fn ai_config_summary_from(config: AiConfig) -> AiConfigSummary {
    let provider = config
        .provider
        .clone()
        .unwrap_or_else(|| "cline-sdk".to_string());
    let configured = ai_model_is_configured(&provider, &config.api_key);
    let models = config
        .models
        .iter()
        .map(|model| AiModelConfigSummary {
            id: model.id.clone(),
            name: model.name.clone(),
            provider: model.provider.clone(),
            model: model.model.clone(),
            base_url: model.base_url.clone(),
            api_key_masked: ai_auth_summary(&model.provider, &model.api_key),
            configured: ai_model_is_configured(&model.provider, &model.api_key),
            permission_mode: normalize_ai_permission_mode(Some(&model.permission_mode)),
            reasoning_depth: normalize_ai_reasoning_depth(Some(&model.reasoning_depth)),
        })
        .collect();
    AiConfigSummary {
        provider: provider.clone(),
        model: config.model,
        base_url: config.base_url,
        api_key_masked: ai_auth_summary(&provider, &config.api_key),
        stream: true,
        configured,
        permission_mode: normalize_ai_permission_mode(Some(&config.permission_mode)),
        reasoning_depth: normalize_ai_reasoning_depth(Some(&config.reasoning_depth)),
        active_model_id: config.active_model_id,
        models,
        system_prompt: config.system_prompt,
        custom_rules: config.custom_rules,
        enabled_skills: config.enabled_skills,
        skill_definitions: merge_ai_skill_definitions(config.skill_definitions),
        open_agent: config.open_agent,
        workspace_roots: config.workspace_roots,
    }
}

fn unconfigured_ai_config_summary() -> AiConfigSummary {
    ai_config_summary_from(AiConfig {
        provider: Some("openai-compatible".to_string()),
        model: String::new(),
        base_url: String::new(),
        api_key: String::new(),
        stream: Some(true),
        permission_mode: "advisor".to_string(),
        reasoning_depth: "medium".to_string(),
        active_model_id: String::new(),
        models: Vec::new(),
        system_prompt: desic_storage_config::default_ai_system_prompt(),
        custom_rules: String::new(),
        enabled_skills: normalize_ai_enabled_skills(Vec::new()),
        skill_definitions: desic_storage_config::default_ai_skill_definitions(),
        open_agent: true,
        workspace_roots: Vec::new(),
    })
}

fn merge_ai_skill_definitions(
    items: Vec<desic_storage_config::AiSkillDefinition>,
) -> Vec<desic_storage_config::AiSkillDefinition> {
    const LEGACY_TRADING_PHILOSOPHY_FINGERPRINT: u64 = 0xfbf7_6df2_d6c8_da68;
    const LEGACY_DEFAULT_SKILL_FINGERPRINTS: [(&str, u64); 4] = [
        ("trading-philosophy", 0x28b8_35c6_2b63_9623),
        ("okx-news-intelligence", 0x5f37_0325_71e9_8b62),
        ("okx-smart-money-analysis", 0x7cbe_60eb_bc64_0880),
        // Untouched English baseline that still carried the factual constraints
        // (OI identity, contract-size invention, leverage/margin) before they
        // moved into the fixed skill. Upgrading it is safe precisely because an
        // unedited philosophy carries no user intent.
        ("trading-philosophy", 0x77f1_451b_c3b4_4a7c),
    ];
    let protected_skill_ids = [
        "desic-core-operations",
        "trading-philosophy",
        "okx-news-intelligence",
        "okx-smart-money-analysis",
    ];
    let has_legacy_renamed_trading_skill = items.iter().any(|skill| {
        skill.builtin
            && skill.id.trim() != "desic-core-operations"
            && skill.id.trim() != "trading-philosophy"
    });
    let mut merged = desic_storage_config::default_ai_skill_definitions();
    for mut item in items {
        item.id = item.id.trim().to_string();
        if item.id.is_empty() {
            continue;
        }
        if item.id == "desic-core-operations" {
            continue;
        }
        if has_legacy_renamed_trading_skill && item.builtin && item.id == "trading-philosophy" {
            continue;
        }
        if item.id == "trading-philosophy"
            && skill_text_fingerprint(&item) == LEGACY_TRADING_PHILOSOPHY_FINGERPRINT
        {
            // Upgrade only the untouched legacy default. Any user-edited text gets a different
            // fingerprint and remains authoritative for this required, customizable Skill.
            continue;
        }
        if item.builtin
            && LEGACY_DEFAULT_SKILL_FINGERPRINTS
                .iter()
                .any(|(id, fingerprint)| {
                    item.id == *id && skill_text_fingerprint(&item) == *fingerprint
                })
        {
            // Replace only an untouched Chinese baseline with the shared English default.
            // User-edited built-in Skills have a different fingerprint and stay authoritative.
            continue;
        }
        item.name = item.id.clone();
        item.builtin = protected_skill_ids.contains(&item.id.as_str());
        if let Some(existing) = merged.iter_mut().find(|skill| skill.id == item.id) {
            *existing = item;
        } else {
            merged.push(item);
        }
    }
    merged
}

fn skill_text_fingerprint(skill: &desic_storage_config::AiSkillDefinition) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for value in [&skill.description, &skill.rules, &skill.content] {
        for byte in value.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn normalize_ai_enabled_skills(items: Vec<String>) -> Vec<String> {
    let mut result = vec![
        "trading-philosophy".to_string(),
        "okx-news-intelligence".to_string(),
        "okx-smart-money-analysis".to_string(),
    ];
    for item in items {
        let id = item.trim();
        if id.is_empty()
            || id == "desic-core-operations"
            || result.iter().any(|existing| existing == id)
        {
            continue;
        }
        result.push(id.to_string());
    }
    result
}

fn build_updated_ai_models(
    update: &AiConfigUpdate,
    existing: Option<&AiConfig>,
) -> Result<Vec<AiModelConfig>, String> {
    if let Some(items) = update.models.as_ref() {
        let models = items
            .iter()
            .map(|item| {
                let existing_model = existing
                    .and_then(|config| config.models.iter().find(|model| model.id == item.id));
                AiModelConfig {
                    id: item.id.trim().to_string(),
                    name: item.name.trim().to_string(),
                    provider: item.provider.trim().to_string(),
                    model: item.model.trim().to_string(),
                    base_url: item.base_url.trim().to_string(),
                    api_key: item
                        .api_key
                        .as_deref()
                        .filter(|value| !value.trim().is_empty() && !value.contains("****"))
                        .map(str::to_string)
                        .or_else(|| existing_model.map(|model| model.api_key.clone()))
                        .unwrap_or_default(),
                    permission_mode: normalize_ai_permission_mode(
                        item.permission_mode
                            .as_deref()
                            .or_else(|| existing_model.map(|model| model.permission_mode.as_str())),
                    ),
                    reasoning_depth: normalize_ai_reasoning_depth(
                        item.reasoning_depth
                            .as_deref()
                            .or_else(|| existing_model.map(|model| model.reasoning_depth.as_str())),
                    ),
                }
            })
            .collect::<Vec<_>>();
        return Ok(models);
    }

    let mut models = existing
        .map(|config| config.models.clone())
        .unwrap_or_default();
    if models.is_empty() {
        models.push(AiModelConfig {
            id: "model-default".to_string(),
            name: if update.model.trim().is_empty() {
                "默认模型".to_string()
            } else {
                update.model.trim().to_string()
            },
            provider: update
                .provider
                .as_deref()
                .unwrap_or("openai-compatible")
                .trim()
                .to_string(),
            model: update.model.trim().to_string(),
            base_url: update.base_url.trim().to_string(),
            api_key: update
                .api_key
                .as_deref()
                .filter(|value| !value.trim().is_empty() && !value.contains("****"))
                .map(str::to_string)
                .unwrap_or_default(),
            permission_mode: normalize_ai_permission_mode(update.permission_mode.as_deref()),
            reasoning_depth: normalize_ai_reasoning_depth(update.reasoning_depth.as_deref()),
        });
        return Ok(models);
    }

    let active_id = update
        .active_model_id
        .as_deref()
        .or_else(|| existing.map(|config| config.active_model_id.as_str()))
        .unwrap_or_default();
    let active_index = models
        .iter()
        .position(|model| model.id == active_id)
        .unwrap_or(0);
    if let Some(active) = models.get_mut(active_index) {
        if let Some(provider) = update
            .provider
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            active.provider = provider.to_string();
        }
        if !update.model.trim().is_empty() {
            active.model = update.model.trim().to_string();
        }
        if !update.base_url.trim().is_empty() {
            active.base_url = update.base_url.trim().to_string();
        }
        if let Some(api_key) = update
            .api_key
            .as_deref()
            .filter(|value| !value.trim().is_empty() && !value.contains("****"))
        {
            active.api_key = api_key.to_string();
        }
        if let Some(mode) = update.permission_mode.as_deref() {
            active.permission_mode = normalize_ai_permission_mode(Some(mode));
        }
        if let Some(depth) = update.reasoning_depth.as_deref() {
            active.reasoning_depth = normalize_ai_reasoning_depth(Some(depth));
        }
    }
    Ok(models)
}

fn normalize_ai_models(mut config: AiConfig) -> AiConfig {
    if config.models.is_empty()
        && (!config.model.trim().is_empty() || !config.base_url.trim().is_empty())
    {
        config.models.push(AiModelConfig {
            id: "model-default".to_string(),
            name: if config.model.trim().is_empty() {
                "默认模型".to_string()
            } else {
                config.model.trim().to_string()
            },
            provider: config
                .provider
                .clone()
                .unwrap_or_else(|| "openai-compatible".to_string()),
            model: config.model.clone(),
            base_url: config.base_url.clone(),
            api_key: config.api_key.clone(),
            permission_mode: normalize_ai_permission_mode(Some(&config.permission_mode)),
            reasoning_depth: normalize_ai_reasoning_depth(Some(&config.reasoning_depth)),
        });
    }
    for model in &mut config.models {
        model.id = model.id.trim().to_string();
        model.name = model.name.trim().to_string();
        model.provider = model.provider.trim().to_string();
        model.model = model.model.trim().to_string();
        model.base_url = model.base_url.trim().to_string();
        model.permission_mode = normalize_ai_permission_mode(Some(&model.permission_mode));
        model.reasoning_depth = normalize_ai_reasoning_depth(Some(&model.reasoning_depth));
    }
    if !config
        .models
        .iter()
        .any(|model| model.id == config.active_model_id)
    {
        config.active_model_id = config
            .models
            .first()
            .map(|model| model.id.clone())
            .unwrap_or_default();
    }
    apply_active_ai_model(config)
}

fn ai_model_metadata_fingerprint(models: &[AiModelConfig]) -> String {
    serde_json::to_string(
        &models
            .iter()
            .map(|model| {
                json!({
                    "id": model.id,
                    "name": model.name,
                    "provider": model.provider,
                    "model": model.model,
                    "baseUrl": model.base_url,
                    "permissionMode": model.permission_mode,
                    "reasoningDepth": model.reasoning_depth,
                })
            })
            .collect::<Vec<_>>(),
    )
    .unwrap_or_default()
}

fn apply_active_ai_model(mut config: AiConfig) -> AiConfig {
    if let Some(model) = config
        .models
        .iter()
        .find(|model| model.id == config.active_model_id)
        .cloned()
    {
        config.provider = Some(model.provider);
        config.model = model.model;
        config.base_url = model.base_url;
        config.api_key = model.api_key;
        config.permission_mode = model.permission_mode;
        config.reasoning_depth = model.reasoning_depth;
    }
    config.stream = Some(true);
    config
}

pub(crate) fn select_ai_model(
    config: &AiConfig,
    selector: Option<&str>,
) -> Result<AiConfig, String> {
    let mut next = config.clone();
    let selector = selector.map(str::trim).filter(|value| !value.is_empty());
    if let Some(selector) = selector {
        let selected = next
            .models
            .iter()
            .find(|model| model.id == selector || model.model == selector || model.name == selector)
            .cloned()
            .or_else(|| {
                next.models
                    .iter()
                    .find(|model| model.id == next.active_model_id)
                    .cloned()
            })
            .or_else(|| next.models.first().cloned())
            .ok_or_else(|| "尚未配置可用的 AI 模型".to_string())?;
        next.active_model_id = selected.id;
    }
    Ok(apply_active_ai_model(next))
}

fn validate_ai_config(config: &AiConfig) -> Result<(), String> {
    if config.model.trim().is_empty()
        || config.base_url.trim().is_empty()
        || !ai_model_is_configured(
            config.provider.as_deref().unwrap_or_default(),
            &config.api_key,
        )
    {
        return Err("AI config missing model, baseUrl or apiKey".to_string());
    }
    if config.models.is_empty() {
        return Err("至少需要配置一个 AI 模型".to_string());
    }
    let mut model_ids = std::collections::HashSet::new();
    let mut model_names = std::collections::HashSet::new();
    for model in &config.models {
        if model.id.is_empty()
            || model.id.len() > 96
            || !model.id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
        {
            return Err(format!("AI 模型配置 ID 无效：{}", model.id));
        }
        if model.name.is_empty()
            || model.provider.is_empty()
            || model.model.is_empty()
            || model.base_url.is_empty()
        {
            return Err(format!("AI 模型配置不完整：{}", model.name));
        }
        if !ai_model_is_configured(&model.provider, &model.api_key) {
            return Err(format!("AI 模型配置缺少 API Key：{}", model.name));
        }
        if !model_ids.insert(model.id.clone()) {
            return Err(format!("AI 模型配置 ID 重复：{}", model.id));
        }
        if !model_names.insert(model.name.to_lowercase()) {
            return Err(format!("AI 模型配置名称重复：{}", model.name));
        }
    }
    if !model_ids.contains(&config.active_model_id) {
        return Err("当前 AI 模型配置不存在".to_string());
    }
    let mut skill_ids = std::collections::HashSet::new();
    let mut skill_directories = std::collections::HashSet::new();
    for skill in &config.skill_definitions {
        let id = skill.id.trim();
        if id.is_empty() || id.len() > 96 || sanitize_skill_dir_name(id) != id {
            return Err(format!(
                "Skill id 无效：{}。不能包含路径保留字符、控制字符或首尾空格/点",
                skill.id
            ));
        }
        if !skill_ids.insert(id.to_string()) {
            return Err(format!("Skill id 重复：{}", id));
        }
        let directory_key = id.to_lowercase();
        if !skill_directories.insert(directory_key) {
            return Err(format!("Skill id 在当前文件系统上发生目录冲突：{}", id));
        }
    }
    for skill_id in &config.enabled_skills {
        if !skill_ids.contains(skill_id.trim()) {
            return Err(format!("已启用的 Skill 不存在：{}", skill_id));
        }
    }
    for root in &config.workspace_roots {
        let path = std::path::Path::new(root);
        if root.trim().is_empty() || !path.is_absolute() {
            return Err(format!("AI 工作区路径必须是绝对路径：{}", root));
        }
    }
    Ok(())
}

fn normalize_ai_workspace_roots(items: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    items
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .filter(|item| seen.insert(item.clone()))
        .take(32)
        .collect()
}

pub(crate) fn is_unconfigured_ai_config_error(error: &str) -> bool {
    error.starts_with("AI config not found:")
        || error == "AI config missing model, baseUrl or apiKey"
        || error == "至少需要配置一个 AI 模型"
        || error.starts_with("AI 模型配置不完整：")
        || error.starts_with("AI 模型配置缺少 API Key：")
}

fn normalize_ai_permission_mode(value: Option<&str>) -> String {
    match value.unwrap_or("advisor").trim() {
        "limited_auto" => "limited_auto".to_string(),
        "copilot" | "approval" | "full" => "copilot".to_string(),
        "advisor" | "readonly" => "advisor".to_string(),
        _ => "advisor".to_string(),
    }
}

pub(crate) fn normalize_ai_reasoning_depth(value: Option<&str>) -> String {
    match value.unwrap_or("medium").trim() {
        "none" => "none".to_string(),
        "minimal" => "minimal".to_string(),
        "low" => "low".to_string(),
        "high" => "high".to_string(),
        "xhigh" => "xhigh".to_string(),
        _ => "medium".to_string(),
    }
}

pub(crate) fn save_ai_config(app: &tauri::AppHandle, config: &AiConfig) -> Result<(), String> {
    let path = workspace_ai_config_path();
    let content = serde_json::to_string_pretty(config).map_err(|err| err.to_string())?;
    write_sensitive_config_file(&path, &content)?;
    let _ = app;
    Ok(())
}

pub(crate) fn load_ai_config(app: &tauri::AppHandle) -> Result<AiConfig, String> {
    let _config_write_guard = lock_ai_config_writes()?;
    load_ai_config_locked(app)
}

/// Caller must hold `lock_ai_config_writes` for the full read/migrate operation.
pub(crate) fn load_ai_config_locked(app: &tauri::AppHandle) -> Result<AiConfig, String> {
    let path = workspace_ai_config_path();
    let content =
        fs::read_to_string(&path).map_err(|err| format!("AI config not found: {}", err))?;
    let mut config: AiConfig = serde_json::from_str(&content).map_err(|err| err.to_string())?;
    let original_permission_mode = config.permission_mode.clone();
    let original_reasoning_depth = config.reasoning_depth.clone();
    let original_system_prompt = config.system_prompt.clone();
    let original_active_model_id = config.active_model_id.clone();
    let original_models = ai_model_metadata_fingerprint(&config.models);
    let original_enabled_skills = serde_json::to_string(&config.enabled_skills).unwrap_or_default();
    let original_skill_definitions =
        serde_json::to_string(&config.skill_definitions).unwrap_or_default();
    let original_open_agent = config.open_agent;
    let original_workspace_roots = serde_json::to_string(&config.workspace_roots).unwrap_or_default();
    config.permission_mode = normalize_ai_permission_mode(Some(&config.permission_mode));
    config.reasoning_depth = normalize_ai_reasoning_depth(Some(&config.reasoning_depth));
    config.system_prompt =
        desic_storage_config::migrate_default_ai_system_prompt(config.system_prompt);
    config.enabled_skills = normalize_ai_enabled_skills(config.enabled_skills);
    config.skill_definitions = merge_ai_skill_definitions(config.skill_definitions);
    config.workspace_roots = normalize_ai_workspace_roots(config.workspace_roots);
    config = normalize_ai_models(config);
    config = apply_active_ai_model(config);
    validate_ai_config(&config)?;
    let skill_config_changed = original_enabled_skills
        != serde_json::to_string(&config.enabled_skills).unwrap_or_default()
        || original_skill_definitions
            != serde_json::to_string(&config.skill_definitions).unwrap_or_default()
        || original_open_agent != config.open_agent
        || original_workspace_roots
            != serde_json::to_string(&config.workspace_roots).unwrap_or_default();
    let model_config_changed = config.permission_mode != original_permission_mode
        || config.reasoning_depth != original_reasoning_depth
        || config.system_prompt != original_system_prompt
        || config.active_model_id != original_active_model_id
        || ai_model_metadata_fingerprint(&config.models) != original_models;
    if model_config_changed || skill_config_changed {
        save_ai_config(app, &config)?;
        sync_cline_skill_files_from_config(&config)?;
    }
    Ok(config)
}

fn workspace_config_path() -> PathBuf {
    runtime_paths().config_dir.join("accounts.local.json")
}

fn workspace_ai_config_path() -> PathBuf {
    runtime_paths().config_dir.join("ai.local.json")
}

fn workspace_watchlist_config_path() -> PathBuf {
    runtime_paths().config_dir.join("watchlist.local.json")
}

fn workspace_ui_preferences_path() -> PathBuf {
    runtime_paths().config_dir.join("ui.local.json")
}

fn load_ui_preferences_config() -> Result<UiPreferencesConfig, String> {
    let path = workspace_ui_preferences_path();
    if !path.exists() {
        return Ok(UiPreferencesConfig::default());
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let config =
        serde_json::from_str::<UiPreferencesConfig>(&content).map_err(|error| error.to_string())?;
    if !valid_ui_language_preference(&config.language) {
        return Ok(UiPreferencesConfig::default());
    }
    Ok(config)
}

fn workspace_proxy_config_path() -> PathBuf {
    runtime_paths().config_dir.join("proxy.local.json")
}

fn workspace_notification_config_path() -> PathBuf {
    runtime_paths().config_dir.join("notification.local.json")
}

pub(crate) fn load_notification_webhook() -> Result<String, String> {
    let path = workspace_notification_config_path();
    if !path.exists() {
        return Ok(String::new());
    }
    let content = fs::read_to_string(&path).map_err(|err| err.to_string())?;
    let value = serde_json::from_str::<Value>(&content).map_err(|err| err.to_string())?;
    Ok(value
        .get("feishuWebhook")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string())
}

pub(crate) fn save_notification_webhook(webhook: &str) -> Result<(), String> {
    let path = workspace_notification_config_path();
    let content = serde_json::to_string_pretty(&json!({
        "feishuWebhook": webhook,
    }))
    .map_err(|err| err.to_string())?;
    write_sensitive_config_file(&path, &content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_resource_paths_accept_only_relative_normal_components() {
        assert_eq!(
            validated_skill_resource_path("docs/actions.md").unwrap(),
            PathBuf::from("docs").join("actions.md")
        );
        assert_eq!(
            validated_skill_resource_path("  templates/ema-trend.py  ").unwrap(),
            PathBuf::from("templates").join("ema-trend.py")
        );
    }

    #[test]
    fn skill_resource_paths_reject_traversal_and_absolute_targets() {
        for candidate in [
            "",
            "   ",
            "..",
            "../SKILL.md",
            "docs/../../SKILL.md",
            "docs/./actions.md",
            "/etc/passwd",
            "docs\\actions.md",
            ".hidden",
            "docs/.hidden",
        ] {
            assert!(
                validated_skill_resource_path(candidate).is_err(),
                "expected {candidate:?} to be rejected"
            );
        }
        let long = format!("docs/{}.md", "a".repeat(200));
        assert!(validated_skill_resource_path(&long).is_err());
    }

    #[test]
    fn syncing_the_strategy_skill_bundle_writes_a_readable_layout() {
        // Exercises the real sync + read path end to end so the paths advertised
        // in SKILL.md are proven reachable, not just proven to reject traversal.
        let bundle = AiSkillBundle {
            definition: AiSkillDefinition {
                id: "systematic-strategy-authoring".to_string(),
                name: "systematic-strategy-authoring".to_string(),
                description: "Use when editing the current strategy buffer.".to_string(),
                rules: String::new(),
                content: "# Systematic strategy authoring\n\nSee `docs/actions.md`.".to_string(),
                builtin: true,
            },
            resources: vec![AiSkillResource {
                path: "docs/actions.md".to_string(),
                contents: "# Action reference\n".to_string(),
            }],
        };
        if sync_cline_runtime_scoped_skill(&bundle).is_err() {
            // The runtime skills directory is unavailable in this environment.
            return;
        }

        let skill_file = runtime_paths()
            .cline_skills_dir
            .join("systematic-strategy-authoring")
            .join("SKILL.md");
        let written = fs::read_to_string(&skill_file).expect("SKILL.md");
        // Frontmatter is generated (name/description are quoted YAML scalars);
        // the body is written verbatim beneath it.
        assert!(written.starts_with("---\n"));
        assert!(written.contains("name: \"systematic-strategy-authoring\""));
        assert!(written.contains("disabled: false"));
        assert!(written.contains("# Systematic strategy authoring"));
        assert!(!written.contains("## 规则"));

        let resource =
            read_cline_skill_resource("systematic-strategy-authoring", "docs/actions.md")
                .expect("bundled resource is readable");
        assert_eq!(resource, "# Action reference\n");
        // A path the bundle never declared must not be readable.
        assert!(read_cline_skill_resource("systematic-strategy-authoring", "docs/missing.md").is_err());
    }

    #[test]
    fn skill_resources_are_only_readable_for_application_owned_skills() {
        assert!(read_cline_skill_resource("", "docs/actions.md").is_err());
        assert!(read_cline_skill_resource("trading-philosophy", "docs/actions.md").is_err());
        assert!(read_cline_skill_resource("../../etc", "passwd").is_err());
        // A known application-owned id must still reject a traversal payload
        // before it ever touches the filesystem.
        assert!(
            read_cline_skill_resource("systematic-strategy-authoring", "../../SKILL.md").is_err()
        );
    }

    #[test]
    fn ui_locale_matching_normalizes_supported_language_families() {
        assert_eq!(match_supported_ui_locale(Some("zh-Hant-HK")), Some("zh-TW"));
        assert_eq!(match_supported_ui_locale(Some("zh_CN")), Some("zh-CN"));
        assert_eq!(match_supported_ui_locale(Some("pt-PT")), Some("pt-BR"));
        assert_eq!(match_supported_ui_locale(Some("ja")), Some("ja-JP"));
        assert_eq!(match_supported_ui_locale(Some("it-IT")), None);
    }

    #[test]
    fn ui_locale_summary_follows_system_and_falls_back_to_english() {
        let french = ui_preferences_summary_from(UiPreferencesConfig::default(), Some("fr-CA"));
        assert_eq!(french.language, "system");
        assert_eq!(french.resolved_language, "fr-FR");

        let unsupported =
            ui_preferences_summary_from(UiPreferencesConfig::default(), Some("it-IT"));
        assert_eq!(unsupported.language, "system");
        assert_eq!(unsupported.resolved_language, "en-US");

        let explicit = ui_preferences_summary_from(
            UiPreferencesConfig {
                language: "ko-KR".to_string(),
                resolved_language: Some("ko-KR".to_string()),
            },
            Some("de-DE"),
        );
        assert_eq!(explicit.resolved_language, "ko-KR");
    }

    #[test]
    fn codex_provider_route_preserves_only_allowlisted_routing_fields() {
        let route = parse_codex_provider_route(
            r#"
model_provider = "PrivateGateway"

[model_providers.PrivateGateway]
name = "Private Gateway"
base_url = "https://gateway.example.invalid/v1/"
wire_api = "responses"
requires_openai_auth = true
env_key = "OPENAI_API_KEY"
supports_websockets = false
request_max_retries = 4
stream_max_retries = 2
stream_idle_timeout_ms = 120000
http_headers = { Authorization = "Bearer MUST_NOT_LEAVE_PARSER" }
query_params = { token = "MUST_NOT_LEAVE_PARSER" }
"#,
        )
        .expect("parse provider route")
        .expect("custom route");
        assert_eq!(route.provider_id, "PrivateGateway");
        assert_eq!(route.base_url, "https://gateway.example.invalid/v1");
        assert_eq!(route.wire_api, "responses");
        assert!(route.requires_openai_auth);
        assert_eq!(route.env_key.as_deref(), Some("OPENAI_API_KEY"));
        let serialized = serde_json::to_string(&route).expect("serialize route");
        assert!(!serialized.contains("MUST_NOT_LEAVE_PARSER"));
        assert!(!serialized.contains("http_headers"));
        assert!(!serialized.contains("query_params"));
    }

    #[test]
    fn codex_provider_route_rejects_unsafe_or_unsupported_routing() {
        for config in [
            r#"
model_provider = "Unsafe.Provider"
[model_providers."Unsafe.Provider"]
base_url = "https://gateway.example.invalid/v1"
wire_api = "responses"
"#,
            r#"
model_provider = "PrivateGateway"
[model_providers.PrivateGateway]
base_url = "https://user:password@gateway.example.invalid/v1"
wire_api = "responses"
"#,
            r#"
model_provider = "PrivateGateway"
[model_providers.PrivateGateway]
base_url = "https://gateway.example.invalid/v1"
wire_api = "chat"
"#,
            r#"
model_provider = "PrivateGateway"
[model_providers.PrivateGateway]
base_url = "https://gateway.example.invalid/v1?token=must-not-pass"
wire_api = "responses"
"#,
        ] {
            assert!(parse_codex_provider_route(config).is_err());
        }
    }

    fn skill(id: &str, content: &str) -> desic_storage_config::AiSkillDefinition {
        desic_storage_config::AiSkillDefinition {
            id: id.to_string(),
            name: id.to_string(),
            description: String::new(),
            rules: String::new(),
            content: content.to_string(),
            builtin: false,
        }
    }

    fn config_with_skills(
        skill_definitions: Vec<desic_storage_config::AiSkillDefinition>,
        enabled_skills: Vec<String>,
    ) -> AiConfig {
        AiConfig {
            provider: Some("cline-sdk".to_string()),
            model: "test-model".to_string(),
            base_url: "https://example.invalid/v1".to_string(),
            api_key: "test-key".to_string(),
            stream: Some(true),
            permission_mode: "advisor".to_string(),
            reasoning_depth: "medium".to_string(),
            active_model_id: "model-test".to_string(),
            models: vec![AiModelConfig {
                id: "model-test".to_string(),
                name: "测试模型".to_string(),
                provider: "cline-sdk".to_string(),
                model: "test-model".to_string(),
                base_url: "https://example.invalid/v1".to_string(),
                api_key: "test-key".to_string(),
                permission_mode: "advisor".to_string(),
                reasoning_depth: "medium".to_string(),
            }],
            system_prompt: "test".to_string(),
            custom_rules: String::new(),
            enabled_skills,
            skill_definitions,
            open_agent: true,
            workspace_roots: Vec::new(),
        }
    }

    #[test]
    fn skill_definitions_are_unique_and_reject_path_collisions() {
        let merged =
            merge_ai_skill_definitions(vec![skill("trend", "old"), skill(" trend ", "new")]);
        let trend = merged
            .iter()
            .filter(|item| item.id == "trend")
            .collect::<Vec<_>>();
        assert_eq!(trend.len(), 1);
        assert_eq!(trend[0].content, "new");
        assert!(validate_ai_config(&config_with_skills(merged, vec!["trend".to_string()])).is_ok());

        let invalid_path = config_with_skills(
            vec![
                skill("desic-core-operations", "core"),
                skill("a/b", "invalid"),
            ],
            vec!["a/b".to_string()],
        );
        assert!(validate_ai_config(&invalid_path).is_err());

        let case_collision = config_with_skills(
            vec![
                skill("desic-core-operations", "core"),
                skill("Trend", "one"),
                skill("trend", "two"),
            ],
            vec!["Trend".to_string()],
        );
        assert!(validate_ai_config(&case_collision).is_err());
    }

    #[test]
    fn ai_model_selection_uses_stable_configuration_id() {
        let mut config = config_with_skills(
            desic_storage_config::default_ai_skill_definitions(),
            Vec::new(),
        );
        config.models.push(AiModelConfig {
            id: "model-secondary".to_string(),
            name: "次要模型".to_string(),
            provider: "openai-compatible".to_string(),
            model: "secondary-model".to_string(),
            base_url: "https://secondary.example.invalid/v1".to_string(),
            api_key: "secondary-test-key".to_string(),
            permission_mode: "copilot".to_string(),
            reasoning_depth: "high".to_string(),
        });
        let selected =
            select_ai_model(&config, Some("model-secondary")).expect("select configured model");
        assert_eq!(selected.active_model_id, "model-secondary");
        assert_eq!(selected.model, "secondary-model");
        assert_eq!(selected.permission_mode, "copilot");
        assert_eq!(selected.reasoning_depth, "high");
    }

    #[test]
    fn stale_ai_model_selection_falls_back_to_active_configuration() {
        let config = config_with_skills(
            desic_storage_config::default_ai_skill_definitions(),
            Vec::new(),
        );
        let selected =
            select_ai_model(&config, Some("model-removed")).expect("fall back to active model");
        assert_eq!(selected.active_model_id, config.active_model_id);
        assert_eq!(selected.model, config.model);
    }

    #[test]
    fn ai_connection_test_resolves_the_selected_models_saved_key() {
        let mut config = config_with_skills(
            desic_storage_config::default_ai_skill_definitions(),
            Vec::new(),
        );
        config.models.push(AiModelConfig {
            id: "model-openai".to_string(),
            name: "OpenAI".to_string(),
            provider: "openai-native".to_string(),
            model: "gpt-test-model".to_string(),
            base_url: "https://api.example.invalid/v1".to_string(),
            api_key: "placeholder-openai-key".to_string(),
            permission_mode: "advisor".to_string(),
            reasoning_depth: "medium".to_string(),
        });
        let request = AiModelConfigUpdate {
            id: "model-openai".to_string(),
            name: "OpenAI edited".to_string(),
            provider: "openai-native".to_string(),
            model: "gpt-test-model-new".to_string(),
            base_url: "https://api.example.invalid/v1".to_string(),
            api_key: None,
            permission_mode: Some("advisor".to_string()),
            reasoning_depth: Some("medium".to_string()),
        };
        let selected = resolve_ai_connection_test_model(Some(&config), &request)
            .expect("resolve selected model for connection test");
        assert_eq!(selected.id, "model-openai");
        assert_eq!(selected.name, "OpenAI edited");
        assert_eq!(selected.model, "gpt-test-model-new");
        assert_eq!(selected.api_key, "placeholder-openai-key");
        assert_eq!(config.active_model_id, "model-test");
    }

    #[test]
    fn local_cli_models_are_configured_without_copying_oauth_tokens() {
        for (provider, base_url) in [
            ("openai-codex-cli", "local://codex-cli"),
            ("claude-code", "local://claude-code"),
        ] {
            let request = AiModelConfigUpdate {
                id: format!("model-{provider}"),
                name: provider.to_string(),
                provider: provider.to_string(),
                model: "test-model".to_string(),
                base_url: base_url.to_string(),
                api_key: None,
                permission_mode: Some("advisor".to_string()),
                reasoning_depth: Some("medium".to_string()),
            };
            let selected = resolve_ai_connection_test_model(None, &request)
                .expect("local CLI model should not require copied credentials");
            assert!(selected.api_key.is_empty());
            assert!(ai_model_is_configured(
                &selected.provider,
                &selected.api_key
            ));

            let mut config = config_with_skills(
                desic_storage_config::default_ai_skill_definitions(),
                Vec::new(),
            );
            config.provider = Some(provider.to_string());
            config.model = selected.model.clone();
            config.base_url = selected.base_url.clone();
            config.api_key.clear();
            config.active_model_id = selected.id.clone();
            config.models = vec![selected];
            assert!(validate_ai_config(&config).is_ok());
            let summary = ai_config_summary_from(config);
            assert!(summary.configured);
            assert_eq!(summary.api_key_masked, "本机 CLI");
        }
    }

    #[test]
    fn remote_api_models_still_require_an_api_key() {
        assert!(!ai_model_is_configured("openai-native", ""));
        assert!(!ai_model_is_configured("gemini", ""));
        assert!(ai_model_is_configured(
            "openai-native",
            "placeholder-api-key"
        ));
    }

    #[test]
    fn ai_connection_test_uses_provider_specific_protocols_and_endpoints() {
        let model = |provider: &str, model: &str, base_url: &str| AiModelConfig {
            id: "model-probe".to_string(),
            name: "Probe".to_string(),
            provider: provider.to_string(),
            model: model.to_string(),
            base_url: base_url.to_string(),
            api_key: "placeholder-provider-key".to_string(),
            permission_mode: "advisor".to_string(),
            reasoning_depth: "medium".to_string(),
        };
        let openai = model(
            "openai-native",
            "gpt-test-model",
            "https://api.openai.com/v1",
        );
        assert_eq!(
            ai_connection_probe_protocol(&openai.provider),
            AiConnectionProbeProtocol::OpenAiResponses
        );
        assert_eq!(
            ai_connection_probe_endpoint(&openai).expect("OpenAI endpoint"),
            "https://api.openai.com/v1/responses"
        );

        let anthropic = model(
            "anthropic",
            "claude-test-model",
            "https://api.anthropic.com/v1",
        );
        assert_eq!(
            ai_connection_probe_protocol(&anthropic.provider),
            AiConnectionProbeProtocol::AnthropicMessages
        );
        assert_eq!(
            ai_connection_probe_endpoint(&anthropic).expect("Anthropic endpoint"),
            "https://api.anthropic.com/v1/messages"
        );

        let gemini = model(
            "gemini",
            "gemini-test-model",
            "https://generativelanguage.googleapis.com/v1beta",
        );
        assert_eq!(
            ai_connection_probe_protocol(&gemini.provider),
            AiConnectionProbeProtocol::GeminiGenerateContent
        );
        assert_eq!(
            ai_connection_probe_endpoint(&gemini).expect("Gemini endpoint"),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model:generateContent"
        );

        let deepseek = model(
            "deepseek",
            "deepseek-test-model",
            "https://api.deepseek.com/v1",
        );
        assert_eq!(
            ai_connection_probe_protocol(&deepseek.provider),
            AiConnectionProbeProtocol::OpenAiChat
        );
        assert_eq!(
            ai_connection_probe_endpoint(&deepseek).expect("compatible endpoint"),
            "https://api.deepseek.com/v1/chat/completions"
        );
    }

    #[test]
    fn missing_ai_config_uses_an_unconfigured_summary() {
        let summary = unconfigured_ai_config_summary();
        assert!(!summary.configured);
        assert_eq!(summary.provider, "openai-compatible");
        assert_eq!(summary.permission_mode, "advisor");
        assert_eq!(summary.api_key_masked, "****");
    }

    #[test]
    fn incomplete_ai_config_is_treated_as_unconfigured_but_corruption_is_not() {
        for error in [
            "AI config not found: missing file",
            "AI config missing model, baseUrl or apiKey",
            "至少需要配置一个 AI 模型",
            "AI 模型配置不完整：DeepSeek",
            "AI 模型配置缺少 API Key：DeepSeek",
        ] {
            assert!(
                is_unconfigured_ai_config_error(error),
                "expected unconfigured: {error}"
            );
        }
        for error in [
            "expected value at line 1 column 1",
            "AI 模型配置 ID 重复：model-a",
            "已启用的 Skill 不存在：missing-skill",
        ] {
            assert!(
                !is_unconfigured_ai_config_error(error),
                "must remain an error: {error}"
            );
        }
    }

    #[test]
    fn ai_sidecar_proxy_uses_the_application_proxy() {
        let proxy = ProxyConfig {
            enabled: true,
            proxy_type: "HTTP".to_string(),
            host: "127.0.0.1".to_string(),
            port: 7890,
            username: Some("proxy user".to_string()),
            password: Some("placeholder password".to_string()),
        };
        let url = ai_sidecar_proxy_url_from(&proxy)
            .expect("build sidecar proxy")
            .expect("enabled proxy URL");
        assert_eq!(
            url,
            "http://proxy%20user:placeholder%20password@127.0.0.1:7890/"
        );

        let disabled = ProxyConfig {
            enabled: false,
            ..proxy
        };
        assert_eq!(ai_sidecar_proxy_url_from(&disabled).unwrap(), None);
    }

    #[test]
    fn required_ai_skills_cannot_be_disabled_by_saved_config() {
        let enabled = normalize_ai_enabled_skills(vec![
            "custom-research".to_string(),
            "okx-news-intelligence".to_string(),
        ]);
        assert_eq!(
            enabled,
            vec![
                "trading-philosophy",
                "okx-news-intelligence",
                "okx-smart-money-analysis",
                "custom-research",
            ]
        );
        assert!(!enabled.iter().any(|id| id == "desic-core-operations"));
    }

    #[test]
    fn customized_required_trading_philosophy_is_preserved() {
        let mut customized = desic_storage_config::default_ai_skill_definitions()
            .into_iter()
            .find(|skill| skill.id == "trading-philosophy")
            .expect("trading philosophy");
        customized
            .content
            .push_str("\n用户自定义：优先观察亚洲时段。");

        let merged = merge_ai_skill_definitions(vec![customized]);
        let trading = merged
            .iter()
            .find(|skill| skill.id == "trading-philosophy")
            .expect("merged trading philosophy");
        assert!(trading.content.contains("用户自定义：优先观察亚洲时段。"));
        assert!(trading.builtin);
    }

    /// Verbatim English philosophy content shipped before the factual
    /// constraints moved into the fixed skill. Frozen here so the upgrade
    /// fingerprint stays verifiable.
    const STALE_ENGLISH_PHILOSOPHY_CONTENT: &str = r#"Your responsibility is to form decisions that evidence can test, risk can constrain, and changing markets can revise. Trading edge comes from behavior and asymmetric payoff that recur in a specific environment, not from confidence, a complete story, or a large number of indicators. Preserve the AI's judgment, but every important conclusion must answer: what supports it, what would prove it wrong, how much could be lost if it is wrong, and how the plan changes when evidence changes.

I. Understand the market
1. Accept that the future is unknowable. The goal is not to predict the next candle precisely, but to identify the current environment, build conditional hypotheses, and prepare for multiple paths. Price behavior is the outcome; narratives, indicators, and models are explanatory tools. When market evidence conflicts with the original view, revise the view instead of arguing with the market.
2. Identify the market regime before selecting a method. Trends, ranges, breakouts, exhaustion, event shocks, deteriorating liquidity, and mixed regimes require different logic. The regime classification itself is a falsifiable hypothesis. Select observation timeframes and analysis tools from the user's objective, holding period, volatility, liquidity, and data coverage rather than applying a fixed template.
3. Separate a view, a setup, a trigger, and a trade. Bullish or bearish is only a view. It becomes a possible plan only after location, trigger, invalidation, exit, and risk budget are defined. No trade is also a valid decision; waiting preserves capital, attention, and future optionality.

II. Build an edge
4. Edge must depend on environment and evidence. Seek combinations of price structure, location, volatility, transactions, liquidity, derivatives state, event drivers, and account constraints that have causal meaning. Multiple indicators derived from the same price series are not independent evidence. State supporting evidence, opposing evidence, unverified assumptions, and the most plausible alternative explanation.
5. A key location matters because participants may be forced to decide there and because price can reveal a real response on arrival, not because many lines were drawn. Observe how price approaches, crosses, accepts, or rejects an area, and define both the confirmation you want and the behavior you do not want. Entry location should expose an error early; do not chase a price that has moved far from the invalidation point merely to participate.
6. Direction and opportunity need not be symmetric. The AI may choose trend-following, reversal, range, breakout, event-driven, or no participation from the evidence, but must explain why the chosen logic fits the current regime and when that logic normally fails.

III. Use evidence correctly
7. Order books and recent trades are short-lived evidence. One snapshot describes only currently visible liquidity. Persistent replenishment, cancellation, aggressive flow, and price response are required before confidence increases in absorption, initiative, or spoofing interpretations. Visible orders are not direct proof of intent.
8. Funding, basis, and open interest describe leverage, pricing, and crowding; they do not directly give direction. Every new contract has both a long and a short, so an OI change alone cannot identify new longs, new shorts, covering, or stops. Combine it with price, aggressive flow, basis, funding, liquidation samples, and timing, then present only constrained interpretations.
9. News, sentiment, and Smart Money are evidence, not commands. Check source, freshness, coverage, whether the market has already priced the information, and whether price response supports the narrative. When evidence conflicts, do not trade by vote; reduce conviction, reduce risk, or wait for information that can distinguish the hypotheses.

IV. Move from judgment to execution
10. A trading plan is a conditional branch, not a prophecy. State the current judgment, trigger, acceptable entry area, logical invalidation, execution stop, targets or exit principles, evidence still requiring observation, and whether to execute now, wait, or abstain. Adapt the presentation to the user's question without hiding information that changes the decision.
11. Determine invalidation from market logic first, then derive position size from invalidation distance, contract value, trading costs, and account risk budget. Do not place a stop arbitrarily close to improve the apparent reward-to-risk ratio or widen it in an adverse direction to avoid realizing a loss. Without account, contract, or risk-budget data, do not invent a contract size.
12. Do not judge an opportunity by headline reward-to-risk alone. Consider target probability, fees, slippage, funding, liquidity, path dependency, tail risk, and capital usage. There is no universal minimum reward-to-risk ratio or per-trade risk percentage. Use Profile or user constraints and explain how the choice fits drawdown tolerance.
13. At a fixed contract size, leverage changes estimated initial margin only, not profit or loss from price movement, and leverage alone does not define account tolerance. Tolerance depends on effective exposure, fee-inclusive stop risk, one-ATR risk, remaining margin, liquidation distance, total portfolio risk, and consecutive losses. Add to a position only from new valid evidence and a recalculated total-risk assessment, never to average down or rescue an invalidated view.
14. Profits remain subordinate to evidence. Leave room for favorable movement while edge and risk structure remain intact. Reduce or exit when the hypothesis fails, the regime changes, remaining reward is consumed, or a materially better opportunity appears. Do not apply 'let profits run' mechanically.

V. Remain revisable
15. Confidence comes from evidence quality, independence, and consistency, not tone. Explicitly reduce confidence when data is stale, coverage is incomplete, samples are small, markets are abnormal, or critical evidence is missing. Do not trade when risk cannot be exited reasonably.
16. After entry, keep comparing market behavior with the original hypothesis. New evidence may justify holding, reducing, exiting, or replanning within the risk budget. Do not change standards because of sunk cost, recent profit or loss, fear of missing out, or a need to be proven right. Consecutive losses may be normal variance or evidence that the regime or edge has changed; diagnose before adjusting.

VI. Review and evolve
17. Evaluate decision quality, execution quality, and random outcome separately. A profit may result from a bad decision, and a loss may be the normal cost of a sound process. Review planned versus actual behavior, evidence changes, risk compliance, fills and slippage, available MAE/MFE, net return, and missed alternative paths.
18. Do not overfit rules to one trade. Look for patterns repeated across multiple trades in comparable environments and distinguish strategy failure, regime change, execution deviation, and normal variance. Improvements should be small, observable, and testable; retain sound principles while allowing methods to evolve with evidence."#;

    /// An untouched philosophy still holding the relocated factual constraints
    /// must be upgraded, otherwise existing installs would keep asserting them
    /// from a document the user is now free to delete.
    #[test]
    fn untouched_philosophy_baseline_upgrades_after_constraints_moved() {
        let stale = desic_storage_config::AiSkillDefinition {
            id: "trading-philosophy".to_string(),
            name: "trading-philosophy".to_string(),
            description: "Use when analyzing OKX USDT perpetual markets, direction, trade opportunities, entries and exits, position risk, or trade reviews. It provides an adaptive trading philosophy: the AI selects analysis methods from the target horizon, market regime, evidence quality, and account constraints while respecting uncertainty, evidence, asymmetric payoff, and risk-first principles.".to_string(),
            rules: "Treat trading as decision-making under uncertainty, not a prediction contest. The AI may select timeframes, indicators, structure, order flow, and intelligence evidence, but must not treat any school, indicator, parameter, reward-to-risk ratio, or risk percentage as universally correct. Explain why each method was selected, separate facts, inferences, assumptions, and conditions, actively seek disconfirming evidence, and update conclusions when evidence changes. Wait or abstain when there is no explainable edge, risk cannot be defined, execution conditions are invalid, or critical data is missing. Never promise profits or infer participant intent solely from OI, funding, one order-book snapshot, or one signal.".to_string(),
            content: STALE_ENGLISH_PHILOSOPHY_CONTENT.to_string(),
            builtin: true,
        };
        assert_eq!(skill_text_fingerprint(&stale), 0x77f1_451b_c3b4_4a7c);

        let merged = merge_ai_skill_definitions(vec![stale]);
        let trading = merged
            .iter()
            .find(|skill| skill.id == "trading-philosophy")
            .expect("merged trading philosophy");
        assert!(!trading
            .content
            .contains("cannot identify new longs, new shorts, covering, or stops"));
        assert!(!trading.content.contains("do not invent a contract size"));
        assert!(trading.builtin);
    }

    #[test]
    fn atomic_file_write_replaces_complete_content() {
        let root = std::env::temp_dir().join(format!(
            "desic-atomic-write-{}-{}",
            std::process::id(),
            ATOMIC_WRITE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("create atomic write test directory");
        let path = root.join("config.json");
        write_file_atomically(&path, b"old-content").expect("write initial content");
        write_file_atomically(&path, b"new-content").expect("replace content");
        assert_eq!(
            fs::read(&path).expect("read replaced content"),
            b"new-content"
        );
        assert_eq!(
            fs::read_dir(&root)
                .expect("read atomic write test directory")
                .count(),
            1
        );
        fs::remove_dir_all(&root).expect("remove atomic write test directory");
    }

    #[test]
    fn sensitive_local_file_preserves_credentials_with_private_permissions() {
        let root = std::env::temp_dir().join(format!(
            "desic-sensitive-config-{}-{}",
            std::process::id(),
            ATOMIC_WRITE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("create sensitive config test directory");
        let path = root.join("accounts.local.json");
        let config = AccountsConfig {
            accounts: vec![LocalAccount {
                id: "test-account".to_string(),
                name: "Test account".to_string(),
                exchange: "okx".to_string(),
                environment: "live".to_string(),
                okx_uid: "placeholder-uid".to_string(),
                okx_main_uid: "placeholder-main-uid".to_string(),
                api_key: "TEST_API_KEY_PLACEHOLDER".to_string(),
                secret_key: "TEST_SECRET_KEY_PLACEHOLDER".to_string(),
                passphrase: "TEST_PASSPHRASE_PLACEHOLDER".to_string(),
                permissions: Permissions {
                    read: true,
                    trade: false,
                    withdraw: false,
                },
            }],
        };
        let content = serde_json::to_string_pretty(&config).expect("serialize account config");
        write_sensitive_config_file(&path, &content).expect("write sensitive account config");
        let stored: AccountsConfig = serde_json::from_str(
            &fs::read_to_string(&path).expect("read sensitive account config"),
        )
        .expect("parse sensitive account config");
        assert_eq!(stored.accounts[0].api_key, "TEST_API_KEY_PLACEHOLDER");
        assert_eq!(stored.accounts[0].secret_key, "TEST_SECRET_KEY_PLACEHOLDER");
        assert_eq!(stored.accounts[0].passphrase, "TEST_PASSPHRASE_PLACEHOLDER");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path)
                .expect("read sensitive account config metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o077, 0);
        }
        fs::remove_dir_all(&root).expect("remove sensitive config test directory");
    }

    #[test]
    fn app_identifier_migration_copies_missing_files_without_overwriting_new_data() {
        let root = std::env::temp_dir().join(format!(
            "desic-terminal-identifier-migration-{}-{}",
            std::process::id(),
            ATOMIC_WRITE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let source = root.join("com.desic.tradeai");
        let destination = root.join("com.desic.terminal");
        fs::create_dir_all(source.join("nested")).expect("create legacy app directory");
        fs::create_dir_all(&destination).expect("create current app directory");
        fs::write(source.join("config.json"), b"legacy").expect("write legacy config");
        fs::write(source.join("nested").join("history.db"), b"history")
            .expect("write legacy nested file");
        fs::write(destination.join("config.json"), b"current").expect("write current config");

        migrate_legacy_app_identifier_dir(&destination).expect("migrate legacy identifier");

        assert_eq!(
            fs::read(destination.join("config.json")).unwrap(),
            b"current"
        );
        assert_eq!(
            fs::read(destination.join("nested").join("history.db")).unwrap(),
            b"history"
        );
        fs::remove_dir_all(&root).expect("remove identifier migration test directory");
    }

    #[test]
    fn skill_source_archives_cover_github_and_gitlab_urls() {
        let github = skill_source_archive_candidates("https://github.com/owner/my-skill")
            .expect("github url must be supported");
        assert_eq!(
            github,
            vec!["https://api.github.com/repos/owner/my-skill/tarball"]
        );
        let github_git = skill_source_archive_candidates("https://github.com/owner/my-skill.git")
            .expect("github .git suffix must be supported");
        assert_eq!(
            github_git,
            vec!["https://api.github.com/repos/owner/my-skill/tarball"]
        );
        let gitlab = skill_source_archive_candidates("https://gitlab.com/group/subgroup/repo.git")
            .expect("nested gitlab groups must be supported");
        assert_eq!(
            gitlab,
            vec![
                "https://gitlab.com/group/subgroup/repo/-/archive/main/repo-main.tar.gz",
                "https://gitlab.com/group/subgroup/repo/-/archive/master/repo-master.tar.gz",
            ]
        );
        let unsupported = skill_source_archive_candidates("https://bitbucket.org/owner/repo.git");
        assert!(unsupported.is_err(), "non-GitHub/GitLab hosts must be rejected");
        let ssh = skill_source_archive_candidates("git@github.com:owner/repo.git");
        assert!(ssh.is_err(), "ssh-style urls cannot be downloaded without git");
    }

    #[test]
    fn skill_source_archive_extraction_promotes_the_single_top_directory() {
        let root = std::env::temp_dir().join(format!(
            "desic-skill-archive-test-{}-{}",
            std::process::id(),
            ATOMIC_WRITE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("create archive test directory");

        let mut encoder =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        {
            let mut builder = tar::Builder::new(&mut encoder);
            let skill_md = b"---\nname: demo\ndescription: demo\n---\n";
            let guide_md = b"# guide\n\n";
            let mut header = tar::Header::new_gnu();
            header.set_size(skill_md.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, "owner-repo-abc123/SKILL.md", skill_md.as_slice())
                .expect("append SKILL.md");
            let mut header = tar::Header::new_gnu();
            header.set_size(guide_md.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, "owner-repo-abc123/docs/guide.md", guide_md.as_slice())
                .expect("append nested resource");
            builder.finish().expect("finish tar");
        }
        let bytes = encoder.finish().expect("finish gzip");

        let target = root.join("installed");
        extract_skill_archive(&bytes, &target).expect("extract archive");
        assert_eq!(
            fs::read_to_string(target.join("SKILL.md")).expect("read SKILL.md"),
            "---\nname: demo\ndescription: demo\n---\n"
        );
        assert!(target.join("docs").join("guide.md").is_file());
        fs::remove_dir_all(&root).expect("remove archive test directory");
    }

    /// Builds one raw tar entry, bypassing tar::Builder's own refusal to
    /// write `..` paths so the test can simulate a hostile archive.
    fn raw_tar_entry(name: &str, contents: &[u8]) -> Vec<u8> {
        let mut header = [0_u8; 512];
        let name_bytes = name.as_bytes();
        assert!(name_bytes.len() < 100, "test entry name must fit the ustar name field");
        header[..name_bytes.len()].copy_from_slice(name_bytes);
        let mode = format!("{:07o}\0", 0o644);
        header[100..108].copy_from_slice(mode.as_bytes());
        let size = format!("{:011o}\0", contents.len());
        header[124..136].copy_from_slice(size.as_bytes());
        header[156] = b'0'; // typeflag: regular file
        header[257..263].copy_from_slice(b"ustar\0");
        for byte in header[148..156].iter_mut() {
            *byte = b' ';
        }
        let sum: u32 = header.iter().map(|byte| u32::from(*byte)).sum();
        let checksum = format!("{:06o}\0 ", sum);
        header[148..156].copy_from_slice(checksum.as_bytes());
        let mut out = header.to_vec();
        out.extend_from_slice(contents);
        let padding = (512 - contents.len() % 512) % 512;
        out.extend(std::iter::repeat_n(0, padding));
        out
    }

    #[test]
    fn skill_source_archive_skips_parent_traversal_entries() {
        let mut raw = raw_tar_entry("repo/../escape.txt", b"evil");
        raw.extend(std::iter::repeat_n(0, 1024)); // end-of-archive blocks
        let mut encoder =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&raw).expect("gzip raw tar");
        let bytes = encoder.finish().expect("finish gzip");
        let root = std::env::temp_dir().join(format!(
            "desic-skill-archive-escape-{}-{}",
            std::process::id(),
            ATOMIC_WRITE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("create escape test directory");
        let target = root.join("installed");
        // The tar unpacker skips `..` entries instead of failing (its CVE
        // mitigation since bsdtar); the archive still extracts cleanly and
        // nothing may land outside the staging directory.
        extract_skill_archive(&bytes, &target).expect("traversal entries are skipped, not fatal");
        assert!(
            !root.join("escape.txt").exists(),
            "no file may escape the staging directory"
        );
        fs::remove_dir_all(&root).expect("remove escape test directory");
    }
}
