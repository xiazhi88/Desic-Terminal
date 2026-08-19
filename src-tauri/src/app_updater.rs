use super::*;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use aes_gcm::{
    aead::{AeadInPlace, KeyInit},
    Aes256Gcm, Nonce,
};
use rand::{rngs::OsRng, RngCore};
use semver::Version;
use serde::Deserialize;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio as StdStdio},
    sync::Mutex,
};
use tauri::{Emitter, Manager};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const APP_UPDATE_EVENT: &str = "app:update-state";
const GITHUB_LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/xiazhi88/Desic-Terminal/releases/latest";
const BACKUP_FILE_MAGIC: &[u8; 8] = b"DESICUP1";
const BACKUP_CHUNK_SIZE: usize = 1024 * 1024;
const BACKUP_RETENTION_COUNT: usize = 3;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppUpdateState {
    runtime_mode: String,
    status: String,
    current_version: String,
    latest_version: Option<String>,
    current_revision: Option<String>,
    latest_revision: Option<String>,
    commits_behind: u32,
    available: bool,
    release_name: Option<String>,
    release_notes: Option<String>,
    release_url: Option<String>,
    published_at: Option<String>,
    checked_at: Option<i64>,
    blocked_reason: Option<String>,
    backup_path: Option<String>,
    restart_required: bool,
}

impl Default for AppUpdateState {
    fn default() -> Self {
        Self {
            runtime_mode: runtime_mode().to_string(),
            status: "idle".to_string(),
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            latest_version: None,
            current_revision: None,
            latest_revision: None,
            commits_behind: 0,
            available: false,
            release_name: None,
            release_notes: None,
            release_url: None,
            published_at: None,
            checked_at: None,
            blocked_reason: None,
            backup_path: None,
            restart_required: false,
        }
    }
}

#[derive(Default)]
pub(crate) struct AppUpdateRuntime {
    state: Mutex<AppUpdateState>,
    staged_source_executable: Mutex<Option<PathBuf>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppUpdateBackup {
    path: String,
    created_at: i64,
    encrypted: bool,
    retained_count: usize,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    html_url: Option<String>,
    published_at: Option<String>,
    draft: bool,
    prerelease: bool,
}

fn runtime_mode() -> &'static str {
    if cfg!(debug_assertions) && source_repository_root().join(".git").exists() {
        "source"
    } else {
        "installed"
    }
}

fn current_version(app: &tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

fn source_repository_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn emit_state(app: &tauri::AppHandle, state: &AppUpdateState) {
    let _ = app.emit(APP_UPDATE_EVENT, state);
}

fn store_state(
    app: &tauri::AppHandle,
    runtime: &AppUpdateRuntime,
    state: AppUpdateState,
) -> Result<AppUpdateState, String> {
    *runtime
        .state
        .lock()
        .map_err(|_| "update state lock poisoned".to_string())? = state.clone();
    emit_state(app, &state);
    Ok(state)
}

fn record_update_failure(
    app: &tauri::AppHandle,
    runtime: &AppUpdateRuntime,
    error: &str,
) -> Result<AppUpdateState, String> {
    let mut failed = runtime
        .state
        .lock()
        .map_err(|_| "update state lock poisoned".to_string())?
        .clone();
    failed.runtime_mode = runtime_mode().to_string();
    failed.status = "failed".to_string();
    failed.current_version = current_version(app);
    failed.checked_at = Some(now_ms());
    failed.blocked_reason = Some(error.to_string());
    store_state(app, runtime, failed)
}

#[cfg(windows)]
fn hide_command_window(command: &mut StdCommand) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_command_window(_command: &mut StdCommand) {}

fn command_output(command: &mut StdCommand, label: &str) -> Result<String, String> {
    hide_command_window(command);
    let output = command
        .output()
        .map_err(|error| format!("{label} could not start: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!("{label} failed ({}): {detail}", output.status));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_output(root: &Path, args: &[&str], label: &str) -> Result<String, String> {
    let mut command = StdCommand::new("git");
    command.arg("-C").arg(root).args(args);
    command_output(&mut command, label)
}

fn short_revision(value: &str) -> String {
    value.chars().take(10).collect()
}

fn check_source_update_blocking(current: String) -> Result<AppUpdateState, String> {
    let root = source_repository_root();
    if !root.join(".git").exists() {
        return Err("source repository metadata is unavailable".to_string());
    }
    let branch = git_output(&root, &["branch", "--show-current"], "read git branch")?;
    let dirty = !git_output(
        &root,
        &["status", "--porcelain", "--untracked-files=normal"],
        "read git status",
    )?
    .is_empty();
    let head = git_output(&root, &["rev-parse", "HEAD"], "read current revision")?;
    git_output(
        &root,
        &["fetch", "--quiet", "origin", "main"],
        "fetch origin/main",
    )?;
    let upstream = git_output(
        &root,
        &["rev-parse", "origin/main"],
        "read origin/main revision",
    )?;
    let behind = git_output(
        &root,
        &["rev-list", "--count", "HEAD..origin/main"],
        "count incoming commits",
    )?
    .parse::<u32>()
    .unwrap_or(0);
    let mut ancestor_command = StdCommand::new("git");
    hide_command_window(&mut ancestor_command);
    let ancestor = ancestor_command
        .arg("-C")
        .arg(&root)
        .args(["merge-base", "--is-ancestor", "HEAD", "origin/main"])
        .status()
        .map_err(|error| format!("check fast-forward ancestry failed: {error}"))?
        .success();
    let blocked_reason = if behind == 0 {
        None
    } else if branch != "main" {
        Some("source update requires the main branch".to_string())
    } else if dirty {
        Some("source update requires a clean working tree".to_string())
    } else if !ancestor {
        Some("local main has diverged from origin/main".to_string())
    } else {
        None
    };
    Ok(AppUpdateState {
        runtime_mode: "source".to_string(),
        status: if blocked_reason.is_some() {
            "blocked"
        } else if behind > 0 {
            "available"
        } else {
            "current"
        }
        .to_string(),
        current_version: current.clone(),
        latest_version: Some(current),
        current_revision: Some(short_revision(&head)),
        latest_revision: Some(short_revision(&upstream)),
        commits_behind: behind,
        available: behind > 0,
        release_name: Some("origin/main".to_string()),
        release_notes: None,
        release_url: Some("https://github.com/xiazhi88/Desic-Terminal/commits/main".to_string()),
        published_at: None,
        checked_at: Some(now_ms()),
        blocked_reason,
        backup_path: None,
        restart_required: false,
    })
}

async fn check_installed_update(app: &tauri::AppHandle) -> Result<AppUpdateState, String> {
    let current = current_version(app);
    let response = crate::storage_config::reqwest_client()?
        .get(GITHUB_LATEST_RELEASE_URL)
        .header("User-Agent", "Desic-Terminal-Updater")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("update check request failed: {error}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(AppUpdateState {
            runtime_mode: "installed".to_string(),
            status: "current".to_string(),
            current_version: current,
            checked_at: Some(now_ms()),
            ..AppUpdateState::default()
        });
    }
    if !response.status().is_success() {
        return Err(format!("update check returned HTTP {}", response.status()));
    }
    let release = response
        .json::<GitHubRelease>()
        .await
        .map_err(|error| format!("update release response is invalid: {error}"))?;
    if release.draft || release.prerelease {
        return Err("latest GitHub release is not a stable release".to_string());
    }
    let latest_text = release.tag_name.trim_start_matches(['v', 'V']).to_string();
    let available = Version::parse(&latest_text)
        .ok()
        .zip(Version::parse(&current).ok())
        .is_some_and(|(latest, installed)| latest > installed);
    Ok(AppUpdateState {
        runtime_mode: "installed".to_string(),
        status: if available { "available" } else { "current" }.to_string(),
        current_version: current,
        latest_version: Some(latest_text),
        current_revision: None,
        latest_revision: None,
        commits_behind: 0,
        available,
        release_name: release.name.or(Some(release.tag_name)),
        release_notes: release.body,
        release_url: release.html_url,
        published_at: release.published_at,
        checked_at: Some(now_ms()),
        blocked_reason: None,
        backup_path: None,
        restart_required: false,
    })
}

#[tauri::command]
pub(crate) fn app_update_status(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, AppUpdateRuntime>,
) -> Result<AppUpdateState, String> {
    let mut state = runtime
        .state
        .lock()
        .map_err(|_| "update state lock poisoned".to_string())?
        .clone();
    state.current_version = current_version(&app);
    state.runtime_mode = runtime_mode().to_string();
    Ok(state)
}

#[tauri::command]
pub(crate) async fn app_update_check(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, AppUpdateRuntime>,
) -> Result<AppUpdateState, String> {
    let checking = AppUpdateState {
        runtime_mode: runtime_mode().to_string(),
        status: "checking".to_string(),
        current_version: current_version(&app),
        ..runtime
            .state
            .lock()
            .map_err(|_| "update state lock poisoned".to_string())?
            .clone()
    };
    store_state(&app, runtime.inner(), checking)?;
    let result = if runtime_mode() == "source" {
        let current = current_version(&app);
        tauri::async_runtime::spawn_blocking(move || check_source_update_blocking(current))
            .await
            .map_err(|error| format!("source update check task failed: {error}"))?
    } else {
        check_installed_update(&app).await
    };
    match result {
        Ok(state) => store_state(&app, runtime.inner(), state),
        Err(error) => {
            let _ = record_update_failure(&app, runtime.inner(), &error);
            Err(error)
        }
    }
}

fn zip_file(
    zip: &mut ZipWriter<File>,
    source: &Path,
    archive_name: &str,
    options: SimpleFileOptions,
) -> Result<(), String> {
    zip.start_file(archive_name.replace('\\', "/"), options)
        .map_err(|error| error.to_string())?;
    let mut input = File::open(source).map_err(|error| error.to_string())?;
    std::io::copy(&mut input, zip).map_err(|error| error.to_string())?;
    Ok(())
}

fn zip_directory(
    zip: &mut ZipWriter<File>,
    source: &Path,
    archive_root: &str,
    options: SimpleFileOptions,
) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let name = format!("{archive_root}/{}", entry.file_name().to_string_lossy());
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_dir() {
            zip_directory(zip, &path, &name, options)?;
        } else if file_type.is_file() {
            zip_file(zip, &path, &name, options)?;
        }
    }
    Ok(())
}

fn load_or_create_backup_key(config_root: &Path) -> Result<[u8; 32], String> {
    fs::create_dir_all(config_root).map_err(|error| error.to_string())?;
    let key_path = config_root.join(".update-backup.key");
    if key_path.exists() {
        let bytes = fs::read(&key_path).map_err(|error| error.to_string())?;
        return bytes
            .try_into()
            .map_err(|_| "update backup key has an invalid length".to_string());
    }
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&key_path)
        .map_err(|error| error.to_string())?;
    file.write_all(&key).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    crate::storage_config::harden_sensitive_file_permissions(&key_path)?;
    Ok(key)
}

fn encrypt_backup_archive(source: &Path, destination: &Path, key: &[u8; 32]) -> Result<(), String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|error| error.to_string())?;
    let mut nonce_prefix = [0u8; 8];
    OsRng.fill_bytes(&mut nonce_prefix);
    let mut input = File::open(source).map_err(|error| error.to_string())?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|error| error.to_string())?;
    output
        .write_all(BACKUP_FILE_MAGIC)
        .and_then(|_| output.write_all(&nonce_prefix))
        .map_err(|error| error.to_string())?;
    let mut counter = 0u32;
    loop {
        let mut chunk = vec![0u8; BACKUP_CHUNK_SIZE];
        let count = input.read(&mut chunk).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        chunk.truncate(count);
        let mut nonce_bytes = [0u8; 12];
        nonce_bytes[..8].copy_from_slice(&nonce_prefix);
        nonce_bytes[8..].copy_from_slice(&counter.to_be_bytes());
        let tag = cipher
            .encrypt_in_place_detached(
                Nonce::from_slice(&nonce_bytes),
                b"desic-update-backup",
                &mut chunk,
            )
            .map_err(|error| error.to_string())?;
        output
            .write_all(&(count as u32).to_be_bytes())
            .and_then(|_| output.write_all(&chunk))
            .and_then(|_| output.write_all(tag.as_slice()))
            .map_err(|error| error.to_string())?;
        counter = counter
            .checked_add(1)
            .ok_or_else(|| "update backup is too large".to_string())?;
    }
    output.sync_all().map_err(|error| error.to_string())?;
    crate::storage_config::harden_sensitive_file_permissions(&destination.to_path_buf())?;
    Ok(())
}

fn create_update_backup_blocking(app: &tauri::AppHandle) -> Result<AppUpdateBackup, String> {
    let created_at = now_ms();
    let data_root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let backup_root = data_root.join("update-backups");
    fs::create_dir_all(&backup_root).map_err(|error| error.to_string())?;
    let staging_root = backup_root.join(format!(".staging-{created_at}"));
    fs::create_dir_all(&staging_root).map_err(|error| error.to_string())?;
    let result = (|| -> Result<AppUpdateBackup, String> {
        let snapshot_db = staging_root.join("desic_trade_ai.sqlite3");
        let database = database_path(app)?;
        if database.exists() {
            let conn = Connection::open(&database).map_err(|error| error.to_string())?;
            conn.busy_timeout(Duration::from_secs(30))
                .map_err(|error| error.to_string())?;
            let escaped = snapshot_db.to_string_lossy().replace('\'', "''");
            conn.execute_batch("PRAGMA wal_checkpoint(FULL);")
                .map_err(|error| format!("database checkpoint failed: {error}"))?;
            conn.execute_batch(&format!("VACUUM INTO '{escaped}';"))
                .map_err(|error| format!("database snapshot failed: {error}"))?;
        }
        let archive_path = staging_root.join("snapshot.zip");
        let archive_file = File::create(&archive_path).map_err(|error| error.to_string())?;
        let mut zip = ZipWriter::new(archive_file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        if snapshot_db.exists() {
            zip_file(
                &mut zip,
                &snapshot_db,
                "data/desic_trade_ai.sqlite3",
                options,
            )?;
        }
        let config_root = crate::storage_config::runtime_config_root();
        for file_name in [
            "accounts.local.json",
            "proxy.local.json",
            "ai.local.json",
            "notification.local.json",
            "ui.local.json",
            "watchlist.local.json",
        ] {
            let path = config_root.join(file_name);
            if path.exists() {
                zip_file(&mut zip, &path, &format!("config/{file_name}"), options)?;
            }
        }
        let skill_root = crate::storage_config::runtime_work_dir()
            .join(".cline")
            .join("skills");
        zip_directory(&mut zip, &skill_root, "workspace/.cline/skills", options)?;
        zip.start_file("manifest.json", options)
            .map_err(|error| error.to_string())?;
        let manifest = serde_json::to_vec_pretty(&json!({
            "format": 1,
            "createdAt": created_at,
            "appVersion": current_version(app),
            "identifier": app.config().identifier,
        }))
        .map_err(|error| error.to_string())?;
        zip.write_all(&manifest)
            .map_err(|error| error.to_string())?;
        zip.finish().map_err(|error| error.to_string())?;

        let destination = backup_root.join(format!(
            "desic-terminal-{}-{created_at}.desic-update",
            current_version(app)
        ));
        let key = load_or_create_backup_key(&config_root)?;
        encrypt_backup_archive(&archive_path, &destination, &key)?;

        let mut backups = fs::read_dir(&backup_root)
            .map_err(|error| error.to_string())?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension().and_then(|value| value.to_str()) == Some("desic-update")
            })
            .collect::<Vec<_>>();
        backups.sort();
        while backups.len() > BACKUP_RETENTION_COUNT {
            let oldest = backups.remove(0);
            fs::remove_file(oldest).map_err(|error| error.to_string())?;
        }
        Ok(AppUpdateBackup {
            path: destination.to_string_lossy().to_string(),
            created_at,
            encrypted: true,
            retained_count: backups.len(),
        })
    })();
    let cleanup = fs::remove_dir_all(&staging_root);
    match (result, cleanup) {
        (Ok(backup), Ok(())) => Ok(backup),
        (Ok(_), Err(error)) => Err(format!("update backup staging cleanup failed: {error}")),
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(cleanup_error)) => Err(format!(
            "{error}; update backup staging cleanup failed: {cleanup_error}"
        )),
    }
}

#[tauri::command]
pub(crate) async fn app_update_prepare(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, AppUpdateRuntime>,
) -> Result<AppUpdateBackup, String> {
    let mut preparing = runtime
        .state
        .lock()
        .map_err(|_| "update state lock poisoned".to_string())?
        .clone();
    preparing.status = "preparing".to_string();
    store_state(&app, runtime.inner(), preparing)?;
    let worker_app = app.clone();
    let backup =
        tauri::async_runtime::spawn_blocking(move || create_update_backup_blocking(&worker_app))
            .await
            .map_err(|error| format!("update backup task failed: {error}"))
            .and_then(|result| result);
    let backup = match backup {
        Ok(backup) => backup,
        Err(error) => {
            let _ = record_update_failure(&app, runtime.inner(), &error);
            return Err(error);
        }
    };
    let mut ready = runtime
        .state
        .lock()
        .map_err(|_| "update state lock poisoned".to_string())?
        .clone();
    ready.status = "ready".to_string();
    ready.backup_path = Some(backup.path.clone());
    store_state(&app, runtime.inner(), ready)?;
    Ok(backup)
}

fn run_checked(root: &Path, program: &str, args: &[&str], label: &str) -> Result<(), String> {
    let mut command = StdCommand::new(program);
    command.current_dir(root).args(args);
    command_output(&mut command, label).map(|_| ())
}

fn build_source_update_blocking() -> Result<PathBuf, String> {
    let root = source_repository_root();
    let state = check_source_update_blocking(env!("CARGO_PKG_VERSION").to_string())?;
    if !state.available {
        return Err("origin/main has no source update to apply".to_string());
    }
    if let Some(reason) = state.blocked_reason {
        return Err(reason);
    }
    git_output(
        &root,
        &["merge", "--ff-only", "origin/main"],
        "fast-forward source checkout",
    )?;
    run_checked(&root, "npm", &["ci"], "install source dependencies")?;
    run_checked(&root, "npm", &["run", "build"], "build frontend")?;
    let target_dir = root.join("target").join("desic-update-build");
    let mut cargo = StdCommand::new("cargo");
    cargo
        .current_dir(&root)
        .env("CARGO_TARGET_DIR", &target_dir)
        .args([
            "build",
            "--manifest-path",
            "src-tauri/Cargo.toml",
            "--workspace",
        ]);
    command_output(&mut cargo, "build updated desktop application")?;
    let executable = target_dir.join("debug").join(if cfg!(windows) {
        "desic-terminal.exe"
    } else {
        "desic-terminal"
    });
    if !executable.is_file() {
        return Err(format!(
            "updated executable was not produced at {}",
            executable.display()
        ));
    }
    Ok(executable)
}

#[tauri::command]
pub(crate) async fn app_update_apply_source(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, AppUpdateRuntime>,
) -> Result<AppUpdateState, String> {
    if runtime_mode() != "source" {
        return Err("source update is unavailable for installed builds".to_string());
    }
    let backup_app = app.clone();
    let backup =
        tauri::async_runtime::spawn_blocking(move || create_update_backup_blocking(&backup_app))
            .await
            .map_err(|error| format!("source update backup task failed: {error}"))
            .and_then(|result| result);
    let backup = match backup {
        Ok(backup) => backup,
        Err(error) => {
            let _ = record_update_failure(&app, runtime.inner(), &error);
            return Err(error);
        }
    };
    let mut applying = runtime
        .state
        .lock()
        .map_err(|_| "update state lock poisoned".to_string())?
        .clone();
    applying.status = "installing".to_string();
    applying.backup_path = Some(backup.path);
    store_state(&app, runtime.inner(), applying)?;
    let executable = tauri::async_runtime::spawn_blocking(build_source_update_blocking)
        .await
        .map_err(|error| format!("source update task failed: {error}"))
        .and_then(|result| result);
    let executable = match executable {
        Ok(executable) => executable,
        Err(error) => {
            let _ = record_update_failure(&app, runtime.inner(), &error);
            return Err(error);
        }
    };
    *runtime
        .staged_source_executable
        .lock()
        .map_err(|_| "source update executable lock poisoned".to_string())? = Some(executable);
    let mut ready = runtime
        .state
        .lock()
        .map_err(|_| "update state lock poisoned".to_string())?
        .clone();
    ready.status = "readyToRestart".to_string();
    ready.available = false;
    ready.restart_required = true;
    store_state(&app, runtime.inner(), ready)
}

#[tauri::command]
pub(crate) fn app_update_restart_source(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, AppUpdateRuntime>,
) -> Result<(), String> {
    if runtime_mode() != "source" {
        return Err("source restart is unavailable for installed builds".to_string());
    }
    let staged = runtime
        .staged_source_executable
        .lock()
        .map_err(|_| "source update executable lock poisoned".to_string())?
        .take()
        .ok_or_else(|| "updated source executable is not ready".to_string())?;
    let current = std::env::current_exe().map_err(|error| error.to_string())?;
    let pid = std::process::id();
    #[cfg(windows)]
    {
        let script = format!(
            "$ErrorActionPreference='Stop'; Wait-Process -Id {pid}; Copy-Item -LiteralPath '{}' -Destination '{}' -Force; Start-Process -FilePath '{}'",
            staged.to_string_lossy().replace('\'', "''"),
            current.to_string_lossy().replace('\'', "''"),
            current.to_string_lossy().replace('\'', "''")
        );
        let mut command = StdCommand::new("powershell");
        hide_command_window(&mut command);
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(StdStdio::null())
            .stdout(StdStdio::null())
            .stderr(StdStdio::null())
            .spawn()
            .map_err(|error| format!("source restart helper failed: {error}"))?;
    }
    #[cfg(not(windows))]
    {
        let script = "while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done; cp \"$2\" \"$3\"; chmod +x \"$3\"; exec \"$3\"";
        StdCommand::new("sh")
            .args(["-c", script, "desic-update", &pid.to_string()])
            .arg(&staged)
            .arg(&current)
            .stdin(StdStdio::null())
            .stdout(StdStdio::null())
            .stderr(StdStdio::null())
            .spawn()
            .map_err(|error| format!("source restart helper failed: {error}"))?;
    }
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_revision_is_stable() {
        assert_eq!(short_revision("1234567890abcdef"), "1234567890");
    }

    #[test]
    fn installed_release_comparison_rejects_equal_versions() {
        let latest = Version::parse("0.1.0").unwrap();
        let current = Version::parse("0.1.0").unwrap();
        assert!(latest <= current);
    }
}
