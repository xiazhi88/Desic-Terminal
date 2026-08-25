use crate::storage_config::{
    resolve_active_skill_entrypoint, runtime_cache_root, ResolvedSkillEntrypoint,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};
use tauri::Manager;
use tokio::{
    io::AsyncWriteExt,
    process::Command,
    time::{timeout, Duration},
};

const MAX_SKILL_RUN_INPUT_BYTES: usize = 64 * 1024;
const MAX_SKILL_RUN_OUTPUT_BYTES: usize = 256 * 1024;
const SETUP_TIMEOUT_SECONDS: u64 = 300;

static SKILL_ENVIRONMENT_SETUP_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AiSkillRunRequest {
    pub skill_id: String,
    pub entrypoint: String,
    pub input: Value,
}

pub(crate) async fn run_active_skill_entrypoint(
    app: &tauri::AppHandle,
    active_skill_ids: &HashSet<String>,
    request: AiSkillRunRequest,
) -> Result<Value, String> {
    if !request.input.is_object() {
        return Err("skill.run 的 input 必须是 JSON object".to_string());
    }
    let resolved = resolve_active_skill_entrypoint(
        app,
        &request.skill_id,
        &request.entrypoint,
        active_skill_ids,
    )?;
    validate_json_contract(&resolved.entrypoint.input_schema, &request.input, "input")?;
    let input = serde_json::to_vec(&request.input).map_err(|error| error.to_string())?;
    if input.len() > MAX_SKILL_RUN_INPUT_BYTES {
        return Err("skill.run 输入超过 64 KiB 上限".to_string());
    }
    let environment = prepare_skill_environment(app, &resolved).await?;
    let started_at = crate::now_ms();
    let output =
        execute_declared_entrypoint(app, &resolved, environment.as_deref(), &input).await?;
    if output.stdout.len() > MAX_SKILL_RUN_OUTPUT_BYTES
        || output.stderr.len() > MAX_SKILL_RUN_OUTPUT_BYTES
    {
        return Err("Skill 脚本输出超过 256 KiB 上限".to_string());
    }
    if !output.status.success() {
        return Err(format!(
            "Skill 脚本执行失败（退出码 {:?}）：{}",
            output.status.code(),
            bounded_diagnostic(&output.stderr)
        ));
    }
    let stdout = std::str::from_utf8(&output.stdout)
        .map_err(|_| "Skill 脚本 stdout 必须是 UTF-8 JSON".to_string())?;
    let value = serde_json::from_str::<Value>(stdout.trim())
        .map_err(|error| format!("Skill 脚本 stdout 不是有效 JSON：{}", error))?;
    validate_json_contract(&resolved.entrypoint.output_schema, &value, "output")?;
    Ok(json!({
        "skillId": resolved.skill_id,
        "entrypoint": resolved.entrypoint.name,
        "bundleHash": resolved.bundle_hash,
        "capabilities": resolved.capabilities,
        "output": value,
        "startedAt": started_at,
        "finishedAt": crate::now_ms(),
    }))
}

async fn prepare_skill_environment(
    app: &tauri::AppHandle,
    resolved: &ResolvedSkillEntrypoint,
) -> Result<Option<PathBuf>, String> {
    let Some(dependencies) = resolved.runtime.dependencies.as_ref() else {
        return Ok(None);
    };
    let lock_path = resolved.bundle_root.join(&dependencies.lock_file);
    let lock_bytes = fs::read(&lock_path)
        .map_err(|_| format!("Skill 依赖锁文件不可读：{}", dependencies.lock_file))?;
    let lock_hash = sha256(&lock_bytes);
    let runtime_id = runtime_identity(app, &resolved.runtime.kind)?;
    let environment = runtime_cache_root()
        .join("skill-runtimes")
        .join(sanitize_path_component(&resolved.skill_id))
        .join(format!(
            "{}-{}-{}",
            resolved.bundle_hash, runtime_id, lock_hash
        ));
    if environment_ready(&environment, resolved, &lock_hash)? {
        return Ok(Some(environment));
    }

    let _setup_guard = SKILL_ENVIRONMENT_SETUP_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    if environment_ready(&environment, resolved, &lock_hash)? {
        return Ok(Some(environment));
    }
    if environment.exists() {
        fs::remove_dir_all(&environment).map_err(|error| error.to_string())?;
    }
    let parent = environment
        .parent()
        .ok_or_else(|| "Skill 环境路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let staging = parent.join(format!(
        ".{}-{}.staging",
        environment
            .file_name()
            .and_then(|item| item.to_str())
            .unwrap_or("runtime"),
        crate::now_ms()
    ));
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
    let setup = match resolved.runtime.kind.as_str() {
        "node" => setup_node_environment(app, resolved, &staging, &lock_hash).await,
        "python" => setup_python_environment(app, resolved, &staging, &lock_hash).await,
        _ => Err("不支持的 Skill runtime".to_string()),
    };
    if let Err(error) = setup {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    write_environment_manifest(&staging, resolved, &lock_hash)?;
    if let Err(error) = fs::rename(&staging, &environment) {
        let _ = fs::remove_dir_all(&staging);
        if !environment_ready(&environment, resolved, &lock_hash)? {
            return Err(format!("固化 Skill 依赖环境失败：{}", error));
        }
    }
    Ok(Some(environment))
}

async fn setup_node_environment(
    app: &tauri::AppHandle,
    resolved: &ResolvedSkillEntrypoint,
    staging: &Path,
    lock_hash: &str,
) -> Result<(), String> {
    let dependencies = resolved
        .runtime
        .dependencies
        .as_ref()
        .ok_or_else(|| "Node Skill 缺少依赖声明".to_string())?;
    if dependencies.manager != "npm" {
        return Err("Node Skill 只支持 npm 依赖管理器".to_string());
    }
    if dependencies.package_json.as_deref() != Some("package.json")
        || dependencies.lock_file != "package-lock.json"
    {
        return Err("Node Skill 只支持根目录 package.json/package-lock.json".to_string());
    }
    let snapshot_root = staging.join("bundle");
    materialize_verified_bundle_snapshot(resolved, &snapshot_root)?;
    let (node, npm_cli) = bundled_node_and_npm(app)?;
    let mut command = Command::new(node);
    command
        .arg(npm_cli)
        .arg("ci")
        .arg("--ignore-scripts")
        .arg("--omit=dev")
        .arg("--no-audit")
        .arg("--no-fund")
        .arg("--prefix")
        .arg(&snapshot_root);
    apply_clean_environment(&mut command, &snapshot_root, "node");
    command.env(
        "NPM_CONFIG_CACHE",
        runtime_cache_root().join("skill-npm-cache"),
    );
    command.env("NPM_CONFIG_USERCONFIG", null_device());
    command.env("NPM_CONFIG_PACKAGE_LOCK", "true");
    let output = run_command(command, b"", SETUP_TIMEOUT_SECONDS).await?;
    if !output.status.success() {
        return Err(format!(
            "npm ci 失败（lock {}）：{}",
            &lock_hash[..12],
            bounded_diagnostic(&output.stderr)
        ));
    }
    Ok(())
}

async fn setup_python_environment(
    app: &tauri::AppHandle,
    resolved: &ResolvedSkillEntrypoint,
    staging: &Path,
    lock_hash: &str,
) -> Result<(), String> {
    let dependencies = resolved
        .runtime
        .dependencies
        .as_ref()
        .ok_or_else(|| "Python Skill 缺少依赖声明".to_string())?;
    if dependencies.manager != "pip" {
        return Err("Python Skill 只支持 pip 依赖管理器".to_string());
    }
    let lock_source = resolved.bundle_root.join(&dependencies.lock_file);
    let lock_text = fs::read_to_string(&lock_source)
        .map_err(|_| "Python Skill 锁文件必须是 UTF-8 文本".to_string())?;
    if !requirements_are_hash_complete(&lock_text) {
        return Err("Python Skill 锁文件中的每个依赖必须提供 --hash=sha256".to_string());
    }
    let python = bundled_python(app)?;
    let venv = staging.join("venv");
    let mut create = Command::new(&python);
    create.arg("-m").arg("venv").arg(&venv);
    apply_clean_environment(&mut create, staging, "python");
    let output = run_command(create, b"", SETUP_TIMEOUT_SECONDS).await?;
    if !output.status.success() {
        return Err(format!(
            "创建 Python Skill venv 失败：{}",
            bounded_diagnostic(&output.stderr)
        ));
    }
    let venv_python = venv_python_path(&venv);
    let mut install = Command::new(&venv_python);
    install
        .arg("-I")
        .arg("-m")
        .arg("pip")
        .arg("install")
        .arg("--require-virtualenv")
        .arg("--require-hashes")
        .arg("--no-input")
        .arg("--disable-pip-version-check")
        .arg("--no-deps")
        .arg("-r")
        .arg(&lock_source);
    apply_clean_environment(&mut install, staging, "python");
    install.env(
        "PIP_CACHE_DIR",
        runtime_cache_root().join("skill-pip-cache"),
    );
    let output = run_command(install, b"", SETUP_TIMEOUT_SECONDS).await?;
    if !output.status.success() {
        return Err(format!(
            "pip install 失败（lock {}）：{}",
            &lock_hash[..12],
            bounded_diagnostic(&output.stderr)
        ));
    }
    Ok(())
}

async fn execute_declared_entrypoint(
    app: &tauri::AppHandle,
    resolved: &ResolvedSkillEntrypoint,
    environment: Option<&Path>,
    input: &[u8],
) -> Result<std::process::Output, String> {
    let (mut command, execution_root) = match resolved.runtime.kind.as_str() {
        "node" => {
            let (node, _) = bundled_node_and_npm(app)?;
            let script = environment
                .map(|environment| environment.join("bundle").join(&resolved.entrypoint.script))
                .unwrap_or_else(|| resolved.script_path.clone());
            let mut command = Command::new(node);
            command.arg("--no-addons").arg(script);
            let root = environment
                .map(|environment| environment.join("bundle"))
                .unwrap_or_else(|| resolved.bundle_root.clone());
            (command, root)
        }
        "python" => {
            let python = environment
                .map(|environment| venv_python_path(&environment.join("venv")))
                .unwrap_or(bundled_python(app)?);
            let mut command = Command::new(python);
            command.arg("-I").arg("-u").arg(&resolved.script_path);
            (command, resolved.bundle_root.clone())
        }
        _ => return Err("不支持的 Skill runtime".to_string()),
    };
    apply_clean_environment(&mut command, &execution_root, &resolved.runtime.kind);
    run_command(
        command,
        input,
        u64::from(resolved.entrypoint.timeout_seconds),
    )
    .await
}

fn runtime_identity(app: &tauri::AppHandle, kind: &str) -> Result<String, String> {
    match kind {
        "node" => {
            bundled_node_and_npm(app).map(|(node, _)| format!("node-{}", file_identity(&node)))
        }
        "python" => bundled_python(app).map(|python| format!("python-{}", file_identity(&python))),
        _ => Err("不支持的 Skill runtime".to_string()),
    }
}

fn file_identity(path: &Path) -> String {
    fs::metadata(path)
        .ok()
        .map(|metadata| {
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|time| time.as_secs())
                .unwrap_or_default();
            format!("{}-{}", metadata.len(), modified)
        })
        .unwrap_or_else(|| "unknown".to_string())
}

fn bundled_node_and_npm(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let root = sidecar_runtime_root(app)?;
    let node = root.join(if cfg!(windows) { "node.exe" } else { "node" });
    let npm_cli = root.join("npm").join("bin").join("npm-cli.js");
    if !node.is_file() || !npm_cli.is_file() {
        return Err("受控 Node/npm runtime 不可用，请重新准备应用资源".to_string());
    }
    Ok((node, npm_cli))
}

fn bundled_python(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("systematic-python")
    } else {
        app.path()
            .resource_dir()
            .map_err(|error| error.to_string())?
            .join("systematic-python")
    };
    let manifest = fs::read_to_string(root.join("runtime-manifest.json"))
        .map_err(|_| "受控 Python runtime 不可用，请重新准备应用资源".to_string())?;
    let relative = serde_json::from_str::<Value>(&manifest)
        .ok()
        .and_then(|value| {
            value
                .get("pythonRelativePath")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .ok_or_else(|| "受控 Python runtime manifest 无效".to_string())?;
    let python = root.join(relative);
    if !python.is_file() {
        return Err("受控 Python interpreter 不可用".to_string());
    }
    Ok(python)
}

fn sidecar_runtime_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("ai-sidecar")
            .join("runtime"));
    }
    Ok(app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("ai-sidecar")
        .join("runtime"))
}

fn materialize_verified_bundle_snapshot(
    resolved: &ResolvedSkillEntrypoint,
    destination_root: &Path,
) -> Result<(), String> {
    for file in &resolved.files {
        let relative = desic_skill_runtime::validate_bundle_relative_path(&file.path)?;
        let source = resolved
            .bundle_root
            .join(&relative)
            .canonicalize()
            .map_err(|_| format!("Skill bundle 文件不存在：{}", file.path))?;
        if !source.starts_with(&resolved.bundle_root) || !source.is_file() {
            return Err("Skill bundle 文件不在受信任存储目录中".to_string());
        }
        let bytes = fs::read(&source).map_err(|error| error.to_string())?;
        if bytes.len() as u64 != file.bytes || sha256(&bytes) != file.sha256.to_ascii_lowercase() {
            return Err(format!("Skill bundle 文件哈希不匹配：{}", file.path));
        }
        let destination = destination_root.join(relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(destination, bytes).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn environment_ready(
    path: &Path,
    resolved: &ResolvedSkillEntrypoint,
    lock_hash: &str,
) -> Result<bool, String> {
    let manifest = path.join("desic-skill-environment.json");
    if !path.is_dir() || !manifest.is_file() {
        return Ok(false);
    }
    let value = fs::read_to_string(manifest).map_err(|error| error.to_string())?;
    let value =
        serde_json::from_str::<Value>(&value).map_err(|_| "Skill 环境元数据无效".to_string())?;
    if value.get("bundleHash").and_then(Value::as_str) != Some(resolved.bundle_hash.as_str())
        || value.get("lockHash").and_then(Value::as_str) != Some(lock_hash)
    {
        return Ok(false);
    }
    if resolved.runtime.kind != "node" {
        return Ok(true);
    }
    for file in &resolved.files {
        let relative = desic_skill_runtime::validate_bundle_relative_path(&file.path)?;
        let snapshot = path.join("bundle").join(relative);
        let bytes = match fs::read(snapshot) {
            Ok(bytes) => bytes,
            Err(_) => return Ok(false),
        };
        if bytes.len() as u64 != file.bytes || sha256(&bytes) != file.sha256.to_ascii_lowercase() {
            return Ok(false);
        }
    }
    Ok(true)
}

fn write_environment_manifest(
    staging: &Path,
    resolved: &ResolvedSkillEntrypoint,
    lock_hash: &str,
) -> Result<(), String> {
    let value = json!({
        "schemaVersion": 1,
        "bundleHash": resolved.bundle_hash,
        "lockHash": lock_hash,
        "runtime": resolved.runtime.kind,
        "createdAt": crate::now_ms(),
    });
    fs::write(
        staging.join("desic-skill-environment.json"),
        serde_json::to_vec_pretty(&value).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn apply_clean_environment(command: &mut Command, home: &Path, runtime_kind: &str) {
    command.env_clear();
    command.current_dir(home);
    command.env("HOME", home);
    command.env("PATH", "");
    command.env("NO_PROXY", "");
    command.env("HTTP_PROXY", "");
    command.env("HTTPS_PROXY", "");
    command.env("ALL_PROXY", "");
    command.env("PYTHONHOME", "");
    command.env("PYTHONPATH", "");
    command.env("PYTHONNOUSERSITE", "1");
    if runtime_kind == "node" {
        command.env("NODE_OPTIONS", "--no-addons");
    }
    crate::hide_ai_sidecar_command_window(command);
}

async fn run_command(
    mut command: Command,
    input: &[u8],
    timeout_seconds: u64,
) -> Result<std::process::Output, String> {
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 Skill runtime 失败：{}", error))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(input)
            .await
            .map_err(|error| format!("写入 Skill 输入失败：{}", error))?;
    }
    match timeout(
        Duration::from_secs(timeout_seconds),
        child.wait_with_output(),
    )
    .await
    {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(error)) => Err(format!("等待 Skill runtime 失败：{}", error)),
        Err(_) => Err(format!("Skill runtime 超时（{} 秒）", timeout_seconds)),
    }
}

fn validate_json_contract(
    schema: &Option<Value>,
    value: &Value,
    label: &str,
) -> Result<(), String> {
    let Some(schema) = schema else {
        return Ok(());
    };
    validate_json_schema_value(schema, value, label)
}

fn validate_json_schema_value(schema: &Value, value: &Value, path: &str) -> Result<(), String> {
    if let Some(kind) = schema.get("type").and_then(Value::as_str) {
        let matches = match kind {
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "boolean" => value.is_boolean(),
            "number" => value.is_number(),
            "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
            _ => return Err(format!("Skill schema 使用不支持的 type：{}", kind)),
        };
        if !matches {
            return Err(format!("Skill {} 不满足 schema type {}", path, kind));
        }
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        if !values.iter().any(|candidate| candidate == value) {
            return Err(format!("Skill {} 不在 schema enum 中", path));
        }
    }
    if let Some(object) = value.as_object() {
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            for key in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(key) {
                    return Err(format!("Skill {} 缺少必填字段 {}", path, key));
                }
            }
        }
        let properties = schema.get("properties").and_then(Value::as_object);
        if schema.get("additionalProperties").and_then(Value::as_bool) == Some(false) {
            for key in object.keys() {
                if !properties.is_some_and(|properties| properties.contains_key(key)) {
                    return Err(format!("Skill {} 包含 schema 未声明字段 {}", path, key));
                }
            }
        }
        if let Some(properties) = properties {
            for (key, property_schema) in properties {
                if let Some(item) = object.get(key) {
                    validate_json_schema_value(
                        property_schema,
                        item,
                        &format!("{}.{}", path, key),
                    )?;
                }
            }
        }
    }
    if let (Some(items), Some(values)) = (schema.get("items"), value.as_array()) {
        for (index, item) in values.iter().enumerate() {
            validate_json_schema_value(items, item, &format!("{}[{}]", path, index))?;
        }
    }
    Ok(())
}

fn requirements_are_hash_complete(contents: &str) -> bool {
    contents.lines().all(|line| {
        let line = line.trim();
        line.is_empty()
            || line.starts_with('#')
            || line.starts_with("--")
            || line.contains("--hash=sha256:")
    })
}

fn sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn sanitize_path_component(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn bounded_diagnostic(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim()
        .chars()
        .take(2_000)
        .collect::<String>()
}

fn null_device() -> &'static str {
    if cfg!(windows) {
        "NUL"
    } else {
        "/dev/null"
    }
}

fn venv_python_path(venv: &Path) -> PathBuf {
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declared_json_contract_rejects_unknown_and_missing_input_fields() {
        let schema = serde_json::json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["rows"],
            "properties": { "rows": { "type": "array" } }
        });
        assert!(validate_json_contract(
            &Some(schema.clone()),
            &serde_json::json!({"rows": []}),
            "input"
        )
        .is_ok());
        assert!(
            validate_json_contract(&Some(schema.clone()), &serde_json::json!({}), "input").is_err()
        );
        assert!(validate_json_contract(
            &Some(schema),
            &serde_json::json!({"rows": [], "other": true}),
            "input"
        )
        .is_err());
    }

    #[test]
    fn python_requirements_must_be_hash_complete() {
        assert!(requirements_are_hash_complete(
            "requests==2.32.0 --hash=sha256:abc"
        ));
        assert!(!requirements_are_hash_complete("requests==2.32.0"));
    }
}
