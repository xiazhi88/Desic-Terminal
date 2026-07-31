use serde::Deserialize;
use std::{fs, path::PathBuf};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountsConfig {
    accounts: Vec<LocalAccount>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalAccount {
    id: String,
    name: String,
    environment: String,
    api_key: String,
    secret_key: String,
    passphrase: String,
    permissions: AccountPermissions,
}

#[derive(Debug, Deserialize)]
struct AccountPermissions {
    read: bool,
    trade: bool,
    withdraw: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProxyConfig {
    enabled: bool,
    proxy_type: String,
    host: String,
    port: u16,
    #[serde(rename = "username")]
    _username: Option<String>,
    password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiConfig {
    provider: String,
    model: String,
    base_url: String,
    api_key: String,
    stream: bool,
    #[serde(default)]
    system_prompt: String,
    #[serde(default)]
    custom_rules: String,
    #[serde(default)]
    enabled_skills: Vec<String>,
}

fn workspace_root() -> PathBuf {
    desic_smoke_tools::workspace_root()
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &PathBuf) -> Result<T, String> {
    let content = fs::read_to_string(path)
        .map_err(|err| format!("read {} failed: {}", path.display(), err))?;
    serde_json::from_str::<T>(&content)
        .map_err(|err| format!("parse {} failed: {}", path.display(), err))
}

fn read_raw(path: &PathBuf) -> Result<String, String> {
    fs::read_to_string(path).map_err(|err| format!("read {} failed: {}", path.display(), err))
}

#[cfg(unix)]
fn assert_private_file(path: &PathBuf) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(path)
        .map_err(|err| format!("read {} metadata failed: {}", path.display(), err))?
        .permissions()
        .mode();
    if mode & 0o077 != 0 {
        return Err(format!(
            "sensitive config permissions are too broad for {}: {:o}",
            path.display(),
            mode & 0o777
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn assert_private_file(_path: &PathBuf) -> Result<(), String> {
    Ok(())
}

fn main() -> Result<(), String> {
    let root = workspace_root();
    let accounts_path = root.join("config").join("accounts.local.json");
    let proxy_path = root.join("config").join("proxy.local.json");
    let ai_path = root.join("config").join("ai.local.json");

    let accounts_raw = read_raw(&accounts_path)?;
    let accounts: AccountsConfig =
        serde_json::from_str(&accounts_raw).map_err(|err| err.to_string())?;
    if accounts.accounts.is_empty() {
        return Err("accounts.local.json has no configured account metadata".to_string());
    }
    let default_account = accounts
        .accounts
        .iter()
        .find(|item| item.id == "okx-default-live")
        .unwrap_or(&accounts.accounts[0]);
    let account_secret_count = [
        default_account.api_key.as_str(),
        default_account.secret_key.as_str(),
        default_account.passphrase.as_str(),
    ]
    .into_iter()
    .filter(|value| !value.trim().is_empty())
    .count();
    if account_secret_count != 0 && account_secret_count != 3 {
        return Err("account local credentials are only partially configured".to_string());
    }
    if default_account.environment.trim().is_empty() || default_account.permissions.withdraw {
        return Err(format!(
            "default account metadata is unexpected: env={} read={} trade={} withdraw={}",
            default_account.environment,
            default_account.permissions.read,
            default_account.permissions.trade,
            default_account.permissions.withdraw
        ));
    }

    assert_private_file(&accounts_path)?;

    let proxy: ProxyConfig = read_json(&proxy_path)?;
    if !matches!(
        proxy.proxy_type.to_uppercase().as_str(),
        "HTTP" | "HTTPS" | "SOCKS5" | "NONE"
    ) || (proxy.enabled && (proxy.host.trim().is_empty() || proxy.port == 0))
    {
        return Err(format!(
            "default proxy mismatch: enabled={} type={} host={} port={}",
            proxy.enabled, proxy.proxy_type, proxy.host, proxy.port
        ));
    }
    assert_private_file(&proxy_path)?;

    let ai: AiConfig = read_json(&ai_path)?;
    if ai.provider.trim().is_empty()
        || ai.model.trim().is_empty()
        || ai.base_url.trim().is_empty()
        || !ai.stream
    {
        return Err(format!(
            "AI config metadata mismatch: provider={} model={} baseUrl={} stream={}",
            ai.provider, ai.model, ai.base_url, ai.stream
        ));
    }
    if !ai.system_prompt.trim().is_empty() && ai.system_prompt.contains("sk-") {
        return Err("AI system prompt should not contain API-key-like text".to_string());
    }
    if ai.enabled_skills.iter().any(|item| item.trim().is_empty()) {
        return Err("AI enabled skills contains empty item".to_string());
    }
    if ai.custom_rules.contains("sk-") {
        return Err("AI custom rules should not contain API-key-like text".to_string());
    }
    assert_private_file(&ai_path)?;

    println!(
        "[smoke] local config security ok: accounts={} defaultAccount={}({}) accountCredentialsConfigured={} proxy={}://{}:{} proxyAuth={} ai={}@{} aiConfigured={} privateFiles=ok",
        accounts.accounts.len(),
        default_account.name,
        default_account.environment,
        account_secret_count == 3,
        proxy.proxy_type,
        proxy.host,
        proxy.port,
        proxy.password.as_deref().is_some_and(|value| !value.trim().is_empty()),
        ai.model,
        ai.base_url,
        !ai.api_key.trim().is_empty()
    );
    Ok(())
}
