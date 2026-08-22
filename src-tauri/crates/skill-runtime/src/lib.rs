//! Shared, side-effect-free contracts for Desic Skill bundles.
//!
//! The desktop application owns files, processes, and permission checks. This
//! crate deliberately only models a portable bundle and validates content that
//! may safely cross those boundaries.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub mod codex_template;

pub use codex_template::{
    preview_codex_agent_template, CodexTemplatePreview, MAX_TEMPLATE_INSTRUCTION_CHARS,
    MAX_TEMPLATE_SKILL_IDS,
};

pub const SKILL_BUNDLE_SCHEMA_VERSION: u32 = 1;
pub const MAX_SKILL_BUNDLE_FILES: usize = 256;
pub const MAX_SKILL_BUNDLE_FILE_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_SKILL_BUNDLE_TOTAL_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillBundleFile {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillBundleSource {
    #[serde(default = "default_bundle_source_kind")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subpath: Option<String>,
}

fn default_bundle_source_kind() -> String {
    "managed".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillCapabilities {
    #[serde(default)]
    pub workspace_read: bool,
    #[serde(default)]
    pub workspace_write: bool,
    #[serde(default)]
    pub network: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillEntrypoint {
    pub name: String,
    pub script: String,
    #[serde(default = "default_entrypoint_timeout_seconds")]
    pub timeout_seconds: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<serde_json::Value>,
}

fn default_entrypoint_timeout_seconds() -> u32 {
    90
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillDependencySpec {
    pub manager: String,
    pub lock_file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillRuntimeSpec {
    pub kind: String,
    #[serde(default = "default_dependency_mode")]
    pub dependency_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependencies: Option<SkillDependencySpec>,
    #[serde(default)]
    pub entrypoints: Vec<SkillEntrypoint>,
    #[serde(default)]
    pub background_safe: bool,
}

fn default_dependency_mode() -> String {
    "locked".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillRuntimeManifest {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<SkillRuntimeSpec>,
    #[serde(default)]
    pub capabilities: SkillCapabilities,
}

fn default_schema_version() -> u32 {
    SKILL_BUNDLE_SCHEMA_VERSION
}

impl Default for SkillRuntimeManifest {
    fn default() -> Self {
        Self {
            schema_version: SKILL_BUNDLE_SCHEMA_VERSION,
            runtime: None,
            capabilities: SkillCapabilities::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillBundleSummary {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub bundle_hash: String,
    #[serde(default)]
    pub files: Vec<SkillBundleFile>,
    #[serde(default)]
    pub source: SkillBundleSource,
    #[serde(default)]
    pub manifest: SkillRuntimeManifest,
}

impl SkillBundleSummary {
    pub fn legacy() -> Self {
        Self {
            schema_version: SKILL_BUNDLE_SCHEMA_VERSION,
            bundle_hash: String::new(),
            files: Vec::new(),
            source: SkillBundleSource::default(),
            manifest: SkillRuntimeManifest::default(),
        }
    }
}

pub fn parse_runtime_manifest(value: &str) -> Result<SkillRuntimeManifest, String> {
    let manifest = serde_json::from_str::<SkillRuntimeManifest>(value)
        .map_err(|error| format!("desic-skill.json 无效：{error}"))?;
    validate_runtime_manifest(&manifest)?;
    Ok(manifest)
}

pub fn validate_runtime_manifest(manifest: &SkillRuntimeManifest) -> Result<(), String> {
    if manifest.schema_version != SKILL_BUNDLE_SCHEMA_VERSION {
        return Err(format!(
            "不支持的 Skill manifest schemaVersion：{}",
            manifest.schema_version
        ));
    }
    if manifest.capabilities.workspace_write && !manifest.capabilities.workspace_read {
        return Err("workspaceWrite=true 时必须同时声明 workspaceRead=true".to_string());
    }
    let Some(runtime) = manifest.runtime.as_ref() else {
        return Ok(());
    };
    if !matches!(runtime.kind.as_str(), "node" | "python" | "shell") {
        return Err(format!("不支持的 Skill runtime：{}", runtime.kind));
    }
    if !matches!(
        runtime.dependency_mode.as_str(),
        "locked" | "allow-unlocked"
    ) {
        return Err(format!(
            "不支持的 dependencyMode：{}",
            runtime.dependency_mode
        ));
    }
    if let Some(dependencies) = runtime.dependencies.as_ref() {
        if runtime.dependency_mode != "locked" {
            return Err("可执行 Skill 的依赖必须使用 dependencyMode=locked".to_string());
        }
        validate_bundle_relative_path(&dependencies.lock_file)?;
        match runtime.kind.as_str() {
            "node" if dependencies.manager == "npm" => {
                let package_json = dependencies
                    .package_json
                    .as_deref()
                    .ok_or_else(|| "Node Skill 依赖必须声明 packageJson".to_string())?;
                let package_path = validate_bundle_relative_path(package_json)?;
                let lock_path = validate_bundle_relative_path(&dependencies.lock_file)?;
                if package_path != "package.json" || lock_path != "package-lock.json" {
                    return Err("Node Skill 当前只支持根目录的 package.json 和 package-lock.json".to_string());
                }
            }
            "python" if dependencies.manager == "pip" => {
                if dependencies.package_json.is_some() {
                    return Err("Python Skill 依赖不能声明 packageJson".to_string());
                }
            }
            _ => {
                return Err(format!(
                    "runtime {} 不支持依赖管理器 {}",
                    runtime.kind, dependencies.manager
                ));
            }
        }
    }
    if runtime.entrypoints.is_empty() {
        return Err("声明 runtime 的 Skill 至少需要一个 entrypoint".to_string());
    }
    if runtime.entrypoints.len() > 32 {
        return Err("Skill entrypoint 数量不能超过 32".to_string());
    }
    if runtime.background_safe
        && (manifest.capabilities.workspace_write || manifest.capabilities.network)
    {
        return Err(
            "backgroundSafe entrypoint 不能声明 workspaceWrite 或 network 能力".to_string(),
        );
    }
    let mut names = std::collections::HashSet::new();
    for entrypoint in &runtime.entrypoints {
        if !valid_entrypoint_name(&entrypoint.name) || !names.insert(entrypoint.name.clone()) {
            return Err(format!(
                "Skill entrypoint 名称无效或重复：{}",
                entrypoint.name
            ));
        }
        let script = validate_bundle_relative_path(&entrypoint.script)?;
        if !script.starts_with("scripts/") {
            return Err(format!(
                "Skill entrypoint {} 必须位于 scripts/ 目录",
                entrypoint.name
            ));
        }
        if !(1..=900).contains(&entrypoint.timeout_seconds) {
            return Err(format!(
                "Skill entrypoint {} 的 timeoutSeconds 必须为 1-900",
                entrypoint.name
            ));
        }
        validate_json_schema(&entrypoint.input_schema, "inputSchema")?;
        validate_json_schema(&entrypoint.output_schema, "outputSchema")?;
    }
    Ok(())
}

fn validate_json_schema(schema: &Option<serde_json::Value>, label: &str) -> Result<(), String> {
    let Some(schema) = schema else {
        return Ok(());
    };
    if !schema.is_object() {
        return Err(format!("Skill {label} 必须是 JSON object"));
    }
    let bytes = serde_json::to_vec(schema).map_err(|error| error.to_string())?;
    if bytes.len() > 16 * 1024 {
        return Err(format!("Skill {label} 不能超过 16 KiB"));
    }
    Ok(())
}

pub fn validate_bundle_relative_path(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 240 || trimmed.contains('\\') || trimmed.contains('\0')
    {
        return Err(format!("Skill bundle 路径不合法：{trimmed}"));
    }
    if trimmed.starts_with('/') || trimmed.starts_with('.') || trimmed.contains(':') {
        return Err(format!("Skill bundle 路径必须是普通相对路径：{trimmed}"));
    }
    let parts = trimmed.split('/').collect::<Vec<_>>();
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return Err(format!("Skill bundle 路径不合法：{trimmed}"));
    }
    if parts
        .iter()
        .any(|part| *part == ".git" || *part == "node_modules")
    {
        return Err(format!("Skill bundle 不接受运行时或 Git 目录：{trimmed}"));
    }
    Ok(parts.join("/"))
}

pub fn build_bundle_summary(
    mut files: Vec<SkillBundleFile>,
    source: SkillBundleSource,
    manifest: SkillRuntimeManifest,
) -> Result<SkillBundleSummary, String> {
    validate_runtime_manifest(&manifest)?;
    if files.is_empty() || files.len() > MAX_SKILL_BUNDLE_FILES {
        return Err(format!(
            "Skill bundle 文件数量必须为 1-{}",
            MAX_SKILL_BUNDLE_FILES
        ));
    }
    let mut paths = std::collections::HashSet::new();
    let mut total = 0_u64;
    for file in &mut files {
        file.path = validate_bundle_relative_path(&file.path)?;
        if file.sha256.len() != 64 || !file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(format!("Skill bundle 文件哈希无效：{}", file.path));
        }
        if !paths.insert(file.path.clone()) {
            return Err(format!("Skill bundle 文件路径重复：{}", file.path));
        }
        if file.bytes > MAX_SKILL_BUNDLE_FILE_BYTES {
            return Err(format!("Skill bundle 文件超过大小上限：{}", file.path));
        }
        total = total
            .checked_add(file.bytes)
            .ok_or_else(|| "Skill bundle 总大小溢出".to_string())?;
    }
    if total > MAX_SKILL_BUNDLE_TOTAL_BYTES {
        return Err("Skill bundle 总大小超过上限".to_string());
    }
    if let Some(dependencies) = manifest.runtime.as_ref().and_then(|runtime| runtime.dependencies.as_ref()) {
        if !paths.contains(&dependencies.lock_file) {
            return Err(format!("Skill bundle 缺少依赖锁文件：{}", dependencies.lock_file));
        }
        if let Some(package_json) = dependencies.package_json.as_ref() {
            if !paths.contains(package_json) {
                return Err(format!("Skill bundle 缺少 packageJson：{}", package_json));
            }
        }
    }
    if !paths.contains("SKILL.md") {
        return Err("Skill bundle 缺少 SKILL.md".to_string());
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let mut hash = Sha256::new();
    hash.update(format!(
        "desic.skill.bundle/v{}\n",
        SKILL_BUNDLE_SCHEMA_VERSION
    ));
    for file in &files {
        hash.update(file.path.as_bytes());
        hash.update([0]);
        hash.update(file.sha256.as_bytes());
        hash.update([0]);
        hash.update(file.bytes.to_string().as_bytes());
        hash.update([b'\n']);
    }
    Ok(SkillBundleSummary {
        schema_version: SKILL_BUNDLE_SCHEMA_VERSION,
        bundle_hash: format!("{:x}", hash.finalize()),
        files,
        source,
        manifest,
    })
}

fn valid_entrypoint_name(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    value.len() <= 64
        && first.is_ascii_lowercase()
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '-' | '_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, byte: u8) -> SkillBundleFile {
        SkillBundleFile {
            path: path.to_string(),
            sha256: format!("{:064x}", byte),
            bytes: 1,
        }
    }

    #[test]
    fn bundle_hash_is_independent_of_input_order() {
        let left = build_bundle_summary(
            vec![file("SKILL.md", 1), file("references/a.md", 2)],
            SkillBundleSource::default(),
            SkillRuntimeManifest::default(),
        )
        .expect("left bundle");
        let right = build_bundle_summary(
            vec![file("references/a.md", 2), file("SKILL.md", 1)],
            SkillBundleSource::default(),
            SkillRuntimeManifest::default(),
        )
        .expect("right bundle");
        assert_eq!(left.bundle_hash, right.bundle_hash);
        assert_eq!(left.files, right.files);
    }

    #[test]
    fn bundle_paths_reject_traversal_and_runtime_directories() {
        for path in [
            "../SKILL.md",
            "/tmp/x",
            "docs\\x.md",
            "docs/./x.md",
            "node_modules/x",
            ".git/x",
        ] {
            assert!(validate_bundle_relative_path(path).is_err(), "{path}");
        }
    }

    #[test]
    fn runtime_requires_declared_entrypoints() {
        let manifest = SkillRuntimeManifest {
            runtime: Some(SkillRuntimeSpec {
                kind: "node".to_string(),
                dependency_mode: "locked".to_string(),
                dependencies: None,
                entrypoints: Vec::new(),
                background_safe: false,
            }),
            ..SkillRuntimeManifest::default()
        };
        assert!(validate_runtime_manifest(&manifest).is_err());
    }

    #[test]
    fn runtime_manifest_rejects_raw_command_fields() {
        let manifest = r#"{
          "schemaVersion": 1,
          "runtime": {
            "kind": "node",
            "command": "node arbitrary.mjs",
            "entrypoints": [{"name":"run","script":"scripts/run.mjs"}]
          }
        }"#;
        assert!(parse_runtime_manifest(manifest).is_err());
    }

    #[test]
    fn background_safe_runtime_cannot_request_network_or_writes() {
        let manifest = r#"{
          "schemaVersion": 1,
          "capabilities": {"network": true},
          "runtime": {
            "kind": "python",
            "backgroundSafe": true,
            "entrypoints": [{"name":"normalize","script":"scripts/normalize.py"}]
          }
        }"#;
        assert!(parse_runtime_manifest(manifest).is_err());
    }

    #[test]
    fn runtime_manifest_accepts_json_input_and_output_contracts() {
        let manifest = r#"{
          "schemaVersion": 1,
          "runtime": {
            "kind": "node",
            "entrypoints": [{
              "name":"normalize",
              "script":"scripts/normalize.mjs",
              "inputSchema":{"type":"object","required":["rows"]},
              "outputSchema":{"type":"object"}
            }]
          }
        }"#;
        assert!(parse_runtime_manifest(manifest).is_ok());
    }

    #[test]
    fn executable_dependencies_require_matching_locked_manager() {
        let manifest = r#"{
          "schemaVersion": 1,
          "runtime": {
            "kind": "node",
            "dependencyMode": "allow-unlocked",
            "dependencies": {
              "manager": "npm",
              "packageJson": "package.json",
              "lockFile": "package-lock.json"
            },
            "entrypoints": [{"name":"run","script":"scripts/run.mjs"}]
          }
        }"#;
        assert!(parse_runtime_manifest(manifest).is_err());
    }

    #[test]
    fn dependency_files_must_be_part_of_the_bundle() {
        let manifest = parse_runtime_manifest(r#"{
          "schemaVersion": 1,
          "runtime": {
            "kind": "node",
            "dependencies": {
              "manager": "npm",
              "packageJson": "package.json",
              "lockFile": "package-lock.json"
            },
            "entrypoints": [{"name":"run","script":"scripts/run.mjs"}]
          }
        }"#)
        .expect("manifest");
        let error = build_bundle_summary(
            vec![file("SKILL.md", 1), file("scripts/run.mjs", 2)],
            SkillBundleSource::default(),
            manifest,
        )
        .expect_err("lock files must be present");
        assert!(error.contains("锁文件"));
    }
}
