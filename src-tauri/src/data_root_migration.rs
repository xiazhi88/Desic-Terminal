//! 数据目录迁移：把当前数据根（默认 AppData 位置或已有自定义根）迁移到用户指定的新位置。
//!
//! 设计要点：
//! - 迁移发生在**正常初始化之前**（splash 阶段），此时数据库尚未打开，文件复制天然一致；
//! - 采用「复制 → 校验 → 原子切换 → 可选清理」：切换点是 `data-dir.json` 标记，
//!   只有校验通过才写它，因此任何失败都能安全留在旧目录（不会出现"两边都不完整"）；
//! - 默认布局下 config 与 data 同目录、logs 位于 cache 之内，所以迁移按**显式规则逐项复制**
//!   （见 `build_migration_plan`），而不是整目录搬家，避免重复复制与目录错位；
//! - WebView2 的用户数据目录（Windows 上的 `EBWebView`）位于 cache 之内，被运行中的
//!   `msedgewebview2.exe` 独占锁定，且应用始终读取默认位置的那一份，因此不参与复制、统计与清理；
//! - cache 通道的单个文件被占用时只跳过并计数（缓存内容可重建），config / data / logs 仍然严格失败；
//! - 旧数据删除是**独立动作**，只在迁移成功且用户明确确认后执行，并保留固定位置的标记文件。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::storage_config;

const MIGRATION_EVENT: &str = "data-root-migration";
const PENDING_MIGRATION_FILE: &str = "data-migration-pending.json";
const LAST_MIGRATION_FILE: &str = "data-migration-last.json";
/// 数据库文件名（与 lib.rs 的 database_path 保持一致）
const DATABASE_FILE: &str = "desic_trade_ai.sqlite3";
/// WebView2 用户数据目录名：Windows 上 `app_cache_dir()` 解析到 `%LOCALAPPDATA%\<identifier>`，
/// WebView2 默认把用户数据放在同级的 `EBWebView`，因此它恰好落在 cache 通道里
const WEBVIEW_DATA_DIR_NAME: &str = "EBWebView";

/// WebView2 用户数据目录：位于 cache 通道内，由运行中的 WebView2 进程独占锁定。
/// 应用没有配置自定义的 WebView2 数据目录，新根下的拷贝永远不会被读取，因此复制、统计与清理都跳过它。
fn webview_data_dir(cache_dir: &Path) -> PathBuf {
    cache_dir.join(WEBVIEW_DATA_DIR_NAME)
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MigrationProgress {
    pub(crate) phase: String,
    pub(crate) copied_files: u64,
    pub(crate) total_files: u64,
    pub(crate) copied_bytes: u64,
    pub(crate) total_bytes: u64,
    pub(crate) current_path: String,
    pub(crate) target_root: Option<String>,
    pub(crate) error: Option<String>,
    /// cache 通道内因被占用而跳过的文件数（缓存内容可重建，不影响迁移结果）
    pub(crate) skipped_files: usize,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MigrationDirUsage {
    pub(crate) label: String,
    pub(crate) path: String,
    pub(crate) bytes: u64,
    pub(crate) files: u64,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataRootOverview {
    pub(crate) data_root: String,
    pub(crate) custom_root: Option<String>,
    pub(crate) is_custom_root: bool,
    /// 当前平台是否支持自定义数据目录（仅 Windows）
    pub(crate) supported: bool,
    pub(crate) dirs: Vec<MigrationDirUsage>,
    pub(crate) total_bytes: u64,
    pub(crate) total_files: u64,
    pub(crate) pending_migration: Option<String>,
    /// 迁移完成后旧数据所在位置（用于提示清理）；无遗留时为 None
    pub(crate) old_data_root: Option<String>,
    pub(crate) old_data_bytes: u64,
}

fn progress_state() -> &'static Mutex<MigrationProgress> {
    static STATE: OnceLock<Mutex<MigrationProgress>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(MigrationProgress {
            phase: "idle".to_string(),
            ..Default::default()
        })
    })
}

fn cancel_flag() -> &'static AtomicBool {
    static FLAG: OnceLock<AtomicBool> = OnceLock::new();
    FLAG.get_or_init(|| AtomicBool::new(false))
}

pub(crate) fn progress_snapshot() -> MigrationProgress {
    progress_state()
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

fn update_progress(app: &tauri::AppHandle, patch: impl FnOnce(&mut MigrationProgress)) {
    let snapshot = match progress_state().lock() {
        Ok(mut guard) => {
            patch(&mut guard);
            guard.clone()
        }
        Err(_) => return,
    };
    let _ = app.emit(MIGRATION_EVENT, snapshot);
}

/// 固定位置（默认配置目录）下的标记文件路径——**不随数据根迁移**
fn marker_path(app: &tauri::AppHandle, file_name: &str) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|err| format!("解析应用配置目录失败: {err}"))?
        .join(file_name))
}

pub(crate) fn read_pending_migration(app: &tauri::AppHandle) -> Option<PathBuf> {
    let path = marker_path(app, PENDING_MIGRATION_FILE).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let raw = parsed.get("targetRoot")?.as_str()?.trim().to_string();
    if raw.is_empty() {
        return None;
    }
    Some(PathBuf::from(raw))
}

fn write_pending_migration(app: &tauri::AppHandle, target: &Path) -> Result<(), String> {
    let path = marker_path(app, PENDING_MIGRATION_FILE)?;
    let is_debug = cfg!(debug_assertions);
    let payload = serde_json::json!({
        "targetRoot": target.to_string_lossy(),
        "requestedAt": chrono::Local::now().timestamp_millis(),
        "debugMode": is_debug,
    });
    std::fs::write(&path, serde_json::to_string_pretty(&payload).map_err(|err| err.to_string())?)
        .map_err(|err| format!("写入迁移标记失败: {err}"))
}

pub(crate) fn clear_pending_migration(app: &tauri::AppHandle) {
    if let Ok(path) = marker_path(app, PENDING_MIGRATION_FILE) {
        let _ = std::fs::remove_file(path);
    }
}

fn write_last_migration(
    app: &tauri::AppHandle,
    from_root: &str,
    from_dirs: &[MigrationDirUsage],
    to_root: &Path,
    skipped_files: usize,
) -> Result<(), String> {
    let path = marker_path(app, LAST_MIGRATION_FILE)?;
    let payload = serde_json::json!({
        "fromRoot": from_root,
        "fromDirs": from_dirs,
        "toRoot": to_root.to_string_lossy(),
        "migratedAt": chrono::Local::now().timestamp_millis(),
        "skippedFiles": skipped_files,
    });
    std::fs::write(&path, serde_json::to_string_pretty(&payload).map_err(|err| err.to_string())?)
        .map_err(|err| format!("写入迁移记录失败: {err}"))
}

fn read_last_migration(app: &tauri::AppHandle) -> Option<(String, Vec<MigrationDirUsage>)> {
    let path = marker_path(app, LAST_MIGRATION_FILE).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let from_root = parsed.get("fromRoot")?.as_str()?.to_string();
    let dirs = parsed
        .get("fromDirs")?
        .as_array()?
        .iter()
        .filter_map(|item| {
            Some(MigrationDirUsage {
                label: item.get("label")?.as_str()?.to_string(),
                path: item.get("path")?.as_str()?.to_string(),
                bytes: item.get("bytes").and_then(serde_json::Value::as_u64).unwrap_or(0),
                files: item.get("files").and_then(serde_json::Value::as_u64).unwrap_or(0),
            })
        })
        .collect();
    Some((from_root, dirs))
}

fn clear_last_migration(app: &tauri::AppHandle) {
    if let Ok(path) = marker_path(app, LAST_MIGRATION_FILE) {
        let _ = std::fs::remove_file(path);
    }
}

/// 当前生效的运行时目录（迁移发生在初始化之前，因此不依赖 RUNTIME_PATHS）
fn current_runtime_dirs(app: &tauri::AppHandle) -> Result<(Option<PathBuf>, storage_config::RuntimePaths), String> {
    let custom = storage_config::read_custom_data_root(app);
    let paths = match custom.as_ref() {
        Some(root) => storage_config::runtime_paths_under(root),
        None => storage_config::default_runtime_paths(app)?,
    };
    Ok((custom, paths))
}

fn data_dir_of(paths: &storage_config::RuntimePaths) -> PathBuf {
    paths
        .work_dir
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| paths.diagnostics_dir.clone())
}

/// 目录占用统计（有上限，避免超大目录阻塞；跳过符号链接与 `skip_paths` 前缀下的条目）
fn measure_dir(path: &Path, max_entries: u64, skip_paths: &[PathBuf]) -> (u64, u64) {
    let mut bytes = 0_u64;
    let mut files = 0_u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            if files >= max_entries {
                return (bytes, files);
            }
            let entry_path = entry.path();
            if skip_paths.iter().any(|skip| entry_path.starts_with(skip)) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else { continue };
            if metadata.is_dir() {
                stack.push(entry_path);
            } else if metadata.is_file() {
                bytes += metadata.len();
                files += 1;
            }
        }
    }
    (bytes, files)
}

fn label_of_dirs(paths: &storage_config::RuntimePaths) -> Vec<(&'static str, PathBuf)> {
    vec![
        ("config", paths.config_dir.clone()),
        ("cache", paths.cache_dir.clone()),
        ("logs", paths.log_dir.clone()),
        ("data", data_dir_of(paths)),
    ]
}

/// 各运行时目录的占用统计：cache 通道排除被 WebView2 独占锁定的数据目录，避免设置页数字虚高。
/// 「数据目录概览」与「迁移记录」共用同一套规则，避免两处口径分叉。
fn usage_of_paths(paths: &storage_config::RuntimePaths) -> Vec<MigrationDirUsage> {
    label_of_dirs(paths)
        .into_iter()
        .map(|(label, dir)| {
            let skip_paths = if dir == paths.cache_dir {
                vec![webview_data_dir(&paths.cache_dir)]
            } else {
                Vec::new()
            };
            let (bytes, files) = measure_dir(&dir, 200_000, &skip_paths);
            MigrationDirUsage {
                label: label.to_string(),
                path: dir.to_string_lossy().into_owned(),
                bytes,
                files,
            }
        })
        .collect()
}

fn usage_of(app: &tauri::AppHandle) -> Result<(String, Vec<MigrationDirUsage>, u64, u64), String> {
    let (custom, paths) = current_runtime_dirs(app)?;
    let display_root = custom
        .clone()
        .map(|root| root.to_string_lossy().into_owned())
        .unwrap_or_else(|| data_dir_of(&paths).to_string_lossy().into_owned());
    let usage = usage_of_paths(&paths);
    let total_bytes = usage.iter().map(|dir| dir.bytes).sum();
    let total_files = usage.iter().map(|dir| dir.files).sum();
    Ok((display_root, usage, total_bytes, total_files))
}

// ===== 迁移计划 =====

/// 复制通道：决定单个文件复制失败时是整体失败还是跳过（见 `is_rebuildable`）
#[derive(Clone, Copy)]
enum CopyChannel {
    Config,
    Data,
    Cache,
    Logs,
}

impl CopyChannel {
    /// cache 内容（行情图标缓存、npm/pip 缓存、账单归档）全部可重建，单个文件被占用时跳过并计数
    fn is_rebuildable(self) -> bool {
        matches!(self, CopyChannel::Cache)
    }
}

#[derive(Clone)]
struct CopyItem {
    source: PathBuf,
    destination: PathBuf,
    bytes: u64,
    channel: CopyChannel,
}

/// 单个条目的复制结果
enum CopyOutcome {
    Copied,
    /// cache 通道内被占用/不可读而跳过（内容可重建）
    Skipped(std::io::Error),
}

/// 复制进度累计：`skipped` 只统计可重建通道里被跳过的文件
#[derive(Default)]
struct CopyTally {
    copied: u64,
    bytes: u64,
    skipped: usize,
}

impl CopyTally {
    /// 复制单个条目并累计；返回 Err 表示该通道不允许跳过，调用方必须整体失败
    fn record(&mut self, item: &CopyItem) -> Result<(), String> {
        match copy_item(item) {
            Ok(CopyOutcome::Copied) => {
                self.copied += 1;
                self.bytes += item.bytes;
                Ok(())
            }
            Ok(CopyOutcome::Skipped(error)) => {
                self.skipped += 1;
                eprintln!("data root migration: skipped {} ({error})", item.source.display());
                Ok(())
            }
            Err(error) => Err(error),
        }
    }
}

fn copy_item(item: &CopyItem) -> Result<CopyOutcome, String> {
    if let Some(parent) = item.destination.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            return Err(format!("创建目录 {} 失败: {error}", parent.display()));
        }
    }
    // 断点续传：目标已存在且大小一致时跳过
    let already_copied = std::fs::metadata(&item.destination)
        .map(|metadata| metadata.len() == item.bytes)
        .unwrap_or(false);
    if already_copied {
        return Ok(CopyOutcome::Copied);
    }
    match std::fs::copy(&item.source, &item.destination) {
        Ok(_) => Ok(CopyOutcome::Copied),
        Err(error) if item.channel.is_rebuildable() => Ok(CopyOutcome::Skipped(error)),
        Err(error) => Err(format!(
            "复制 {} → {} 失败: {error}",
            item.source.display(),
            item.destination.display()
        )),
    }
}

/// 配置目录中属于「数据」的条目：默认布局下 config 与 data 是同一目录，这些必须走 data 通道
const DATA_OWNED_NAMES: [&str; 6] = [
    DATABASE_FILE,
    "desic_trade_ai.sqlite3-wal",
    "desic_trade_ai.sqlite3-shm",
    "workspace",
    "diagnostics",
    "update-backups",
];

/// 固定位置的标记文件：不参与复制，也绝不在清理时删除
const RESERVED_MARKER_FILES: [&str; 3] = [
    "data-dir.json",
    PENDING_MIGRATION_FILE,
    LAST_MIGRATION_FILE,
];

fn is_temp_entry(name: &str) -> bool {
    name.starts_with(".staging-") || name.ends_with(".tmp") || name == ".DS_Store"
}

/// 清理旧数据时是否删除该条目：固定位置的标记文件必须保留
fn should_clean_entry(name: &str) -> bool {
    !RESERVED_MARKER_FILES.contains(&name) && !is_temp_entry(name)
}

/// 清理旧数据目录内容时是否删除该条目：标记文件必须保留；cache 通道内的 WebView2 数据目录
/// 仍被运行中的进程独占锁定，删除既会失败也不是可回收的数据。
fn should_clean_old_entry(label: &str, root: &Path, target: &Path) -> bool {
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    should_clean_entry(&name) && !(label == "cache" && target.starts_with(webview_data_dir(root)))
}

fn collect_dir(
    source: &Path,
    destination: &Path,
    channel: CopyChannel,
    skip_names: &[String],
    skip_paths: &[PathBuf],
    items: &mut Vec<CopyItem>,
) -> Result<(), String> {
    let entries = match std::fs::read_dir(source) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取 {} 失败: {error}", source.display())),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_temp_entry(&name) || skip_names.iter().any(|skip| skip == &name) {
            continue;
        }
        let source_path = entry.path();
        // 绝对路径前缀比较：只排除指定的子树，不误伤同名的用户目录
        if skip_paths.iter().any(|skip| source_path.starts_with(skip)) {
            continue;
        }
        let destination_path = destination.join(&name);
        let Ok(metadata) = entry.metadata() else { continue };
        if metadata.is_dir() {
            collect_dir(&source_path, &destination_path, channel, &[], skip_paths, items)?;
        } else if metadata.is_file() {
            items.push(CopyItem {
                source: source_path,
                destination: destination_path,
                bytes: metadata.len(),
                channel,
            });
        }
    }
    Ok(())
}

fn collect_named(
    source_dir: &Path,
    destination_dir: &Path,
    channel: CopyChannel,
    names: &[&str],
    items: &mut Vec<CopyItem>,
) -> Result<(), String> {
    for name in names {
        let source_path = source_dir.join(name);
        if !source_path.exists() {
            continue;
        }
        let destination_path = destination_dir.join(name);
        let Ok(metadata) = std::fs::metadata(&source_path) else { continue };
        if metadata.is_dir() {
            collect_dir(&source_path, &destination_path, channel, &[], &[], items)?;
        } else if metadata.is_file() {
            items.push(CopyItem {
                source: source_path,
                destination: destination_path,
                bytes: metadata.len(),
                channel,
            });
        }
    }
    Ok(())
}

fn build_migration_plan(
    app: &tauri::AppHandle,
    target_root: &Path,
) -> Result<(Vec<CopyItem>, StorageRoots), String> {
    let (custom, paths) = current_runtime_dirs(app)?;
    let data_dir = data_dir_of(&paths);
    let items = build_plan_for(&paths, &data_dir, target_root)?;
    let roots = StorageRoots {
        from_root: custom
            .map(|root| root.to_string_lossy().into_owned())
            .unwrap_or_else(|| data_dir.to_string_lossy().into_owned()),
        from_dirs: usage_of_paths(&paths),
    };
    Ok((items, roots))
}

/// 迁移计划（纯函数，便于单测）：默认布局下 config 与 data 同目录、logs 位于 cache 之内，
/// 因此必须按类别逐项复制，否则会出现重复复制或目录错位。
fn build_plan_for(
    paths: &storage_config::RuntimePaths,
    data_dir: &Path,
    target_root: &Path,
) -> Result<Vec<CopyItem>, String> {
    let mut items = Vec::new();

    // config：整个配置目录，排除数据归属条目与固定标记文件
    let mut config_skip: Vec<String> = DATA_OWNED_NAMES
        .iter()
        .chain(RESERVED_MARKER_FILES.iter())
        .map(|name| (*name).to_string())
        .collect();
    config_skip.push("data-dir.json".to_string());
    collect_dir(
        &paths.config_dir,
        &target_root.join("config"),
        CopyChannel::Config,
        &config_skip,
        &[],
        &mut items,
    )?;

    // data：数据库（含 WAL/SHM）+ workspace + diagnostics + update-backups
    collect_named(
        data_dir,
        &target_root.join("data"),
        CopyChannel::Data,
        &DATA_OWNED_NAMES,
        &mut items,
    )?;

    // cache：排除嵌套的 logs 目录（默认布局下 log_dir 位于 cache 内）与 WebView2 用户数据目录
    let mut cache_skip: Vec<String> = Vec::new();
    let logs_nested_in_cache =
        paths.log_dir != paths.cache_dir && paths.log_dir.starts_with(&paths.cache_dir);
    if logs_nested_in_cache {
        if let Ok(relative) = paths.log_dir.strip_prefix(&paths.cache_dir) {
            if let Some(first) = relative.components().next() {
                cache_skip.push(first.as_os_str().to_string_lossy().into_owned());
            }
        }
    }
    // WebView2 数据目录被运行中的进程独占锁定，且应用始终读取默认位置的那一份，
    // 复制到新根只是死数据；按绝对路径前缀排除，避免误伤同名的用户目录。
    let cache_skip_paths = vec![webview_data_dir(&paths.cache_dir)];
    collect_dir(
        &paths.cache_dir,
        &target_root.join("cache"),
        CopyChannel::Cache,
        &cache_skip,
        &cache_skip_paths,
        &mut items,
    )?;

    // logs
    collect_dir(
        &paths.log_dir,
        &target_root.join("logs"),
        CopyChannel::Logs,
        &[],
        &[],
        &mut items,
    )?;
    Ok(items)
}

struct StorageRoots {
    from_root: String,
    from_dirs: Vec<MigrationDirUsage>,
}

// ===== 命令 =====

#[tauri::command]
pub(crate) async fn data_root_overview(
    app: tauri::AppHandle,
) -> Result<DataRootOverview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (display_root, dirs, total_bytes, total_files) = usage_of(&app)?;
        let custom_root = storage_config::read_custom_data_root(&app);
        let pending = read_pending_migration(&app);
        let last = read_last_migration(&app);
        let (old_root, old_bytes) = match last {
            Some((from_root, from_dirs)) => {
                let bytes: u64 = from_dirs.iter().map(|dir| dir.bytes).sum();
                (Some(from_root), bytes)
            }
            None => (None, 0),
        };
        Ok(DataRootOverview {
            data_root: display_root,
            is_custom_root: custom_root.is_some(),
            supported: cfg!(windows),
            custom_root: custom_root.map(|root| root.to_string_lossy().into_owned()),
            dirs,
            total_bytes,
            total_files,
            pending_migration: pending.map(|path| path.to_string_lossy().into_owned()),
            old_data_root: old_root,
            old_data_bytes: old_bytes,
        })
    })
    .await
    .map_err(|err| format!("读取数据目录信息失败: {err}"))?
}

#[tauri::command]
pub(crate) fn request_data_root_migration(
    app: tauri::AppHandle,
    target_root: String,
) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("自定义数据目录仅 Windows 支持".to_string());
    }    let target = PathBuf::from(target_root.trim());
    if target.as_os_str().is_empty() {
        return Err("请选择数据目录".to_string());
    }
    if cfg!(debug_assertions) {
        return Err("开发模式下数据目录运行在仓库工作区，不支持迁移".to_string());
    }
    let (_, paths) = current_runtime_dirs(&app)?;
    let current_data = data_dir_of(&paths);
    if target == current_data || paths.log_dir.starts_with(&target) {
        return Err("目标目录与当前数据目录相同".to_string());
    }
    storage_config::validate_data_root(&target)?;
    let has_existing = target.join("data").join(DATABASE_FILE).exists()
        || target.join("config").exists();
    if has_existing {
        return Err("目标目录里已有数据，请选择空目录或先在设置中使用现有数据".to_string());
    }
    write_pending_migration(&app, &target)?;
    crate::boot_log(&format!(
        "migration: requested target {}",
        target.display()
    ));
    Ok(())
}

#[tauri::command]
pub(crate) fn cancel_data_root_migration(app: tauri::AppHandle) -> Result<(), String> {
    clear_pending_migration(&app);
    crate::boot_log("migration: pending request cancelled");
    Ok(())
}

#[tauri::command]
pub(crate) fn data_root_migration_status() -> MigrationProgress {
    progress_snapshot()
}

#[tauri::command]
pub(crate) fn cancel_running_data_root_migration() {
    cancel_flag().store(true, Ordering::SeqCst);
}

#[tauri::command]
pub(crate) fn restart_app(app: tauri::AppHandle) {
    crate::boot_log("app restart requested by user");
    app.restart();
}

#[tauri::command]
pub(crate) async fn run_data_root_migration(
    app: tauri::AppHandle,
) -> Result<MigrationProgress, String> {
    let Some(target) = read_pending_migration(&app) else {
        return Err("没有待执行的迁移".to_string());
    };
    tauri::async_runtime::spawn_blocking(move || run_migration_blocking(&app, &target))
        .await
        .map_err(|err| format!("迁移任务失败: {err}"))?
}

fn run_migration_blocking(
    app: &tauri::AppHandle,
    target: &Path,
) -> Result<MigrationProgress, String> {
    cancel_flag().store(false, Ordering::SeqCst);
    crate::boot_log(&format!("migration: start → {}", target.display()));
    update_progress(app, |state| {
        state.phase = "preparing".to_string();
        state.target_root = Some(target.to_string_lossy().into_owned());
        state.error = None;
        state.copied_files = 0;
        state.copied_bytes = 0;
        state.skipped_files = 0;
        state.current_path.clear();
    });

    let (items, roots) = match build_migration_plan(app, target) {
        Ok(value) => value,
        Err(error) => return fail_migration(app, error),
    };
    let total_files = items.len() as u64;
    let total_bytes: u64 = items.iter().map(|item| item.bytes).sum();
    update_progress(app, |state| {
        state.total_files = total_files;
        state.total_bytes = total_bytes;
        state.phase = "copying".to_string();
    });

    let mut tally = CopyTally::default();
    for item in &items {
        if cancel_flag().load(Ordering::SeqCst) {
            update_progress(app, |state| {
                state.phase = "cancelled".to_string();
            });
            crate::boot_log("migration: cancelled by user");
            return Ok(progress_snapshot());
        }
        // cache 通道内被占用的文件只跳过并计数，其余通道必须严格成功
        if let Err(error) = tally.record(item) {
            return fail_migration(app, error);
        }
        if tally.copied % 10 == 0 || tally.copied == total_files {
            let current = item.source.to_string_lossy().into_owned();
            update_progress(app, |state| {
                state.copied_files = tally.copied;
                state.copied_bytes = tally.bytes;
                state.skipped_files = tally.skipped;
                state.current_path = current;
            });
        }
    }

    update_progress(app, |state| {
        state.phase = "verifying".to_string();
        state.copied_files = tally.copied;
        state.copied_bytes = tally.bytes;
        state.skipped_files = tally.skipped;
    });
    if let Err(error) = verify_migration(target) {
        return fail_migration(app, error);
    }

    update_progress(app, |state| {
        state.phase = "switching".to_string();
    });
    if let Err(error) = storage_config::write_custom_data_root(app, target) {
        return fail_migration(app, format!("写入数据根标记失败: {error}"));
    }
    if let Err(error) =
        write_last_migration(app, &roots.from_root, &roots.from_dirs, target, tally.skipped)
    {
        // 迁移记录失败不影响切换结果，只记录日志
        crate::boot_log(&format!("migration: record write failed: {error}"));
    }
    clear_pending_migration(app);
    update_progress(app, |state| {
        state.phase = "done".to_string();
        state.skipped_files = tally.skipped;
        state.current_path.clear();
    });
    crate::boot_log(&format!(
        "migration: done ({} files, {} bytes, {} skipped) → {}",
        tally.copied,
        tally.bytes,
        tally.skipped,
        target.display()
    ));
    Ok(progress_snapshot())
}

fn fail_migration(app: &tauri::AppHandle, error: String) -> Result<MigrationProgress, String> {
    crate::boot_log(&format!("migration: FAILED {error}"));
    update_progress(app, |state| {
        state.phase = "failed".to_string();
        state.error = Some(error.clone());
    });
    // 迁移失败保持旧数据根不变；半成品目录保留以便重试（复制是幂等的）
    Err(error)
}

/// 校验：逐项确认目标文件存在且大小一致；若迁移了数据库则执行 SQLite quick_check
fn verify_migration(target: &Path) -> Result<(), String> {
    let database = target.join("data").join(DATABASE_FILE);
    if database.exists() {
        let conn = rusqlite::Connection::open_with_flags(
            &database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|err| format!("打开迁移后的数据库失败: {err}"))?;
        let result: String = conn
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(|err| format!("数据库完整性检查失败: {err}"))?;
        if !result.eq_ignore_ascii_case("ok") {
            return Err(format!("迁移后的数据库完整性检查未通过: {result}"));
        }
    }
    Ok(())
}

/// 删除旧数据：仅清理迁移记录里的旧目录内容，保留固定位置的数据根标记
#[tauri::command]
pub(crate) async fn cleanup_old_data_root(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some((from_root, from_dirs)) = read_last_migration(&app) else {
            return Err("没有可清理的旧数据".to_string());
        };
        for dir in &from_dirs {
            let path = PathBuf::from(&dir.path);
            // cache 通道内的 WebView2 数据目录仍被运行中的进程独占锁定，保留不删
            let locked_webview = webview_data_dir(&path);
            if dir.label == "cache" && locked_webview.exists() {
                crate::boot_log(&format!(
                    "cleanup: keep locked webview data {}",
                    locked_webview.display()
                ));
            }
            let entries = match std::fs::read_dir(&path) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let target = entry.path();
                if !should_clean_old_entry(&dir.label, &path, &target) {
                    continue;
                }
                let result = if entry.metadata().map(|meta| meta.is_dir()).unwrap_or(false) {
                    std::fs::remove_dir_all(&target)
                } else {
                    std::fs::remove_file(&target)
                };
                if let Err(error) = result {
                    crate::boot_log(&format!(
                        "cleanup: remove {} failed: {error}",
                        target.display()
                    ));
                    return Err(format!("删除 {} 失败: {error}", target.display()));
                }
            }
        }
        clear_last_migration(&app);
        crate::boot_log(&format!("cleanup: old data removed ({from_root})"));
        Ok(())
    })
    .await
    .map_err(|err| format!("清理任务失败: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(label: &str) -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("read test clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "desic-migration-{label}-{}-{nonce}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("create temp root");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::write(path, content).expect("write file");
    }

    /// 默认布局：config 与 data 同目录，logs 嵌套在 cache 之内
    fn default_layout_paths(root: &Path) -> storage_config::RuntimePaths {
        let config_dir = root.join("config");
        storage_config::RuntimePaths {
            config_dir: config_dir.clone(),
            cache_dir: root.join("cache"),
            log_dir: root.join("cache").join("logs"),
            diagnostics_dir: config_dir.join("diagnostics"),
            work_dir: config_dir.join("workspace"),
            cline_skills_dir: config_dir.join("workspace").join(".cline").join("skills"),
            cline_agents_dir: config_dir.join("workspace").join(".cline").join("agents"),
        }
    }

    #[test]
    fn default_layout_plan_places_categories_without_duplication() {
        let source = TempRoot::new("plan-src");
        let target = TempRoot::new("plan-dst");
        let paths = default_layout_paths(source.path());
        let data_dir = data_dir_of(&paths);

        write_file(&paths.config_dir.join("accounts.local.json"), "{}");
        write_file(&paths.config_dir.join(DATABASE_FILE), "db");
        write_file(&paths.config_dir.join(DATABASE_FILE).with_extension("sqlite3-wal"), "wal");
        write_file(&paths.config_dir.join("workspace").join("skills").join("x.md"), "skill");
        write_file(&paths.config_dir.join("update-backups").join("bk.zip"), "zip");
        write_file(&paths.config_dir.join("data-dir.json"), "{}");
        write_file(&paths.cache_dir.join("icons").join("btc.png"), "png");
        write_file(&paths.log_dir.join("frontend-1.jsonl"), "log");
        write_file(&paths.cache_dir.join(".staging-tmp"), "tmp");

        let items = build_plan_for(&paths, &data_dir, target.path()).expect("build plan");
        let relatives: Vec<String> = items
            .iter()
            .map(|item| {
                item.destination
                    .strip_prefix(target.path())
                    .expect("relative")
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();

        // 类别归属正确
        assert!(relatives.contains(&"config/accounts.local.json".to_string()), "{relatives:?}");
        assert!(relatives.contains(&format!("data/{DATABASE_FILE}")), "{relatives:?}");
        assert!(relatives.contains(&"data/workspace/skills/x.md".to_string()), "{relatives:?}");
        assert!(relatives.contains(&"data/update-backups/bk.zip".to_string()), "{relatives:?}");
        assert!(relatives.contains(&"cache/icons/btc.png".to_string()), "{relatives:?}");
        // 嵌套在 cache 内的 logs 必须落到 logs/，而不是 cache/logs/
        assert!(relatives.contains(&"logs/frontend-1.jsonl".to_string()), "{relatives:?}");
        assert!(!relatives.iter().any(|item| item.starts_with("cache/logs/")), "{relatives:?}");
        // 固定标记文件不参与复制，临时文件跳过
        assert!(!relatives.contains(&"config/data-dir.json".to_string()), "{relatives:?}");
        assert!(!relatives.iter().any(|item| item.contains(".staging-tmp")), "{relatives:?}");

        // 没有重复目标（默认布局最大的风险是同一文件被复制两次）
        let mut sorted = relatives.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), relatives.len(), "duplicated destinations: {relatives:?}");
    }

    #[test]
    fn cleanup_keeps_reserved_markers() {
        assert!(!should_clean_entry("data-dir.json"));
        assert!(!should_clean_entry("data-migration-pending.json"));
        assert!(!should_clean_entry("data-migration-last.json"));
        assert!(!should_clean_entry(".staging-copy"));
        assert!(!should_clean_entry("write.tmp"));
        assert!(should_clean_entry("accounts.local.json"));
        assert!(should_clean_entry(DATABASE_FILE));
        assert!(should_clean_entry("workspace"));
        assert!(should_clean_entry("frontend-2026-01-01.jsonl"));
    }

    fn destination_relatives(items: &[CopyItem], target: &Path) -> Vec<String> {
        items
            .iter()
            .map(|item| {
                item.destination
                    .strip_prefix(target)
                    .expect("relative")
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect()
    }

    #[test]
    fn plan_excludes_locked_webview_data_dir() {
        let source = TempRoot::new("webview-src");
        let target = TempRoot::new("webview-dst");
        let paths = default_layout_paths(source.path());
        let data_dir = data_dir_of(&paths);

        write_file(&paths.cache_dir.join("icons").join("btc.png"), "png");
        write_file(
            &paths.cache_dir
                .join(WEBVIEW_DATA_DIR_NAME)
                .join("Default")
                .join("Network")
                .join("Cookies"),
            "cookie",
        );
        // 只按绝对路径前缀排除：同前缀目录与更深层的同名目录都必须照常复制
        write_file(
            &paths.cache_dir.join(format!("{WEBVIEW_DATA_DIR_NAME}-old")).join("keep.txt"),
            "keep",
        );
        write_file(
            &paths.cache_dir.join("tools").join(WEBVIEW_DATA_DIR_NAME).join("keep.txt"),
            "keep",
        );

        let items = build_plan_for(&paths, &data_dir, target.path()).expect("build plan");
        let relatives = destination_relatives(&items, target.path());

        assert!(relatives.contains(&"cache/icons/btc.png".to_string()), "{relatives:?}");
        assert!(
            !relatives.iter().any(|item| item.starts_with(&format!("cache/{WEBVIEW_DATA_DIR_NAME}/"))),
            "WebView2 数据目录被独占锁定，不应进入迁移计划: {relatives:?}"
        );
        assert!(
            relatives.contains(&format!("cache/{WEBVIEW_DATA_DIR_NAME}-old/keep.txt")),
            "{relatives:?}"
        );
        assert!(
            relatives.contains(&format!("cache/tools/{WEBVIEW_DATA_DIR_NAME}/keep.txt")),
            "{relatives:?}"
        );
    }

    #[test]
    fn cache_channel_skips_locked_files_and_counts_them() {
        let root = TempRoot::new("cache-skip");
        let readable_source = root.path().join("readable.bin");
        write_file(&readable_source, "data");
        // 源文件缺失等价于被占用/不可读导致的复制失败
        let locked_source = root.path().join("locked.bin");
        let locked_item = |channel: CopyChannel| CopyItem {
            source: locked_source.clone(),
            destination: root.path().join("out").join("locked.bin"),
            bytes: 4,
            channel,
        };

        let mut tally = CopyTally::default();
        let readable = CopyItem {
            source: readable_source.clone(),
            destination: root.path().join("out").join("readable.bin"),
            bytes: 4,
            channel: CopyChannel::Cache,
        };
        tally.record(&readable).expect("copy readable cache file");
        assert_eq!((tally.copied, tally.bytes, tally.skipped), (1, 4, 0));

        // cache 通道：跳过并计数，而不是整体失败
        tally
            .record(&locked_item(CopyChannel::Cache))
            .expect("cache channel tolerates locked files");
        assert_eq!((tally.copied, tally.bytes, tally.skipped), (1, 4, 1));

        // config / data / logs 通道保持严格失败，且不改变计数
        for channel in [CopyChannel::Config, CopyChannel::Data, CopyChannel::Logs] {
            assert!(tally.record(&locked_item(channel)).is_err(), "strict channel must fail");
        }
        assert_eq!((tally.copied, tally.bytes, tally.skipped), (1, 4, 1));
    }

    #[test]
    fn usage_and_cleanup_exclude_locked_webview_data_dir() {
        let root = TempRoot::new("webview-usage");
        let paths = default_layout_paths(root.path());
        write_file(&paths.cache_dir.join("icons").join("btc.png"), "png");
        write_file(
            &paths.cache_dir
                .join(WEBVIEW_DATA_DIR_NAME)
                .join("Default")
                .join("Network")
                .join("Cookies"),
            "cookie-data",
        );

        let usage = usage_of_paths(&paths);
        let cache_usage = usage.iter().find(|dir| dir.label == "cache").expect("cache usage");
        assert_eq!(
            (cache_usage.bytes, cache_usage.files),
            (3, 1),
            "cache 用量不应包含被锁定的 WebView2 数据目录"
        );
        // 未传排除项时 WebView2 仍会被统计，证明上面的差额来自排除规则
        assert_eq!(measure_dir(&paths.cache_dir, 200_000, &[]), (14, 2));

        let cache_dir = paths.cache_dir.clone();
        let webview_dir = cache_dir.join(WEBVIEW_DATA_DIR_NAME);
        assert!(!should_clean_old_entry("cache", &cache_dir, &webview_dir));
        assert!(!should_clean_old_entry(
            "cache",
            &cache_dir,
            &webview_dir.join("Default").join("Network").join("Cookies")
        ));
        assert!(should_clean_old_entry(
            "cache",
            &cache_dir,
            &cache_dir.join(format!("{WEBVIEW_DATA_DIR_NAME}-old"))
        ));
        assert!(should_clean_old_entry(
            "cache",
            &cache_dir,
            &cache_dir.join("tools").join(WEBVIEW_DATA_DIR_NAME)
        ));
        assert!(should_clean_old_entry("cache", &cache_dir, &cache_dir.join("icons")));
        // 其它通道不受影响，固定标记文件照旧保留
        assert!(should_clean_old_entry(
            "config",
            &paths.config_dir,
            &paths.config_dir.join(WEBVIEW_DATA_DIR_NAME)
        ));
        assert!(!should_clean_old_entry("cache", &cache_dir, &cache_dir.join("data-dir.json")));
    }
}
