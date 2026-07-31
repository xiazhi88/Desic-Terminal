use std::path::{Path, PathBuf};

pub fn workspace_root() -> PathBuf {
    if let Ok(value) = std::env::var("DESIC_WORKSPACE_ROOT") {
        let path = PathBuf::from(value);
        if path.join("package.json").is_file() {
            return path;
        }
    }
    let mut current = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    loop {
        if current.join("package.json").is_file() {
            return current;
        }
        if !current.pop() {
            return Path::new(".").to_path_buf();
        }
    }
}

pub fn desktop_database_path(file_name: &str) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    if let Some(app_data) = std::env::var_os("APPDATA").map(PathBuf::from) {
        for identifier in ["com.desic.terminal", "com.desic.tradeai"] {
            let path = app_data.join(identifier).join(file_name);
            if path.exists() {
                return Some(path);
            }
        }
    }

    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for identifier in ["com.desic.terminal", "com.desic.tradeai"] {
            let path = home
                .join("Library")
                .join("Application Support")
                .join(identifier)
                .join(file_name);
            if path.exists() {
                return Some(path);
            }
        }
    }

    let local = workspace_root().join(file_name);
    local.exists().then_some(local)
}
