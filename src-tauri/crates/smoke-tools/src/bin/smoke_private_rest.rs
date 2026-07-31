use base64::{engine::general_purpose, Engine as _};
use hmac::{Hmac, Mac};
use reqwest::Proxy;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::Value;
use sha2::Sha256;
use std::{
    fs,
    path::PathBuf,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const REST_BASE: &str = "https://www.okx.com";
const REST_BASE_DEMO: &str = "https://www.okx.com";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountsConfig {
    accounts: Vec<LocalAccount>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LocalAccount {
    id: String,
    #[allow(dead_code)]
    name: String,
    exchange: String,
    environment: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    secret_key: String,
    #[serde(default)]
    passphrase: String,
    permissions: Permissions,
}

#[derive(Debug, Deserialize, Clone)]
struct Permissions {
    read: bool,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ProxyConfig {
    enabled: bool,
    #[serde(default = "default_proxy_type")]
    proxy_type: String,
    #[serde(default = "default_proxy_host")]
    host: String,
    #[serde(default = "default_proxy_port")]
    port: u16,
    username: Option<String>,
    password: Option<String>,
}

fn default_proxy_type() -> String {
    "HTTP".to_string()
}

fn default_proxy_host() -> String {
    "127.0.0.1".to_string()
}

fn default_proxy_port() -> u16 {
    8881
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("[smoke] private rest failed: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let account = load_account()?;
    if !account.permissions.read {
        return Err(format!(
            "account {} has read permission disabled",
            account.id
        ));
    }
    validate_account(&account)?;
    let client = reqwest_client()?;
    let started = Instant::now();

    let checks = [
        ("balance", "/api/v5/account/balance"),
        ("positions", "/api/v5/account/positions?instType=SWAP"),
        (
            "pending-orders",
            "/api/v5/trade/orders-pending?instType=SWAP",
        ),
        (
            "algo-pending",
            "/api/v5/trade/orders-algo-pending?instType=SWAP&ordType=trigger",
        ),
        (
            "orders-history",
            "/api/v5/trade/orders-history?instType=SWAP&limit=20",
        ),
        (
            "fills-history",
            "/api/v5/trade/fills-history?instType=SWAP&limit=20",
        ),
        (
            "positions-history",
            "/api/v5/account/positions-history?instType=SWAP&limit=20",
        ),
    ];
    let mut results = Vec::new();
    for (label, path) in checks {
        let value = okx_private_get(&client, &account, path).await?;
        let count = value
            .get("data")
            .and_then(|item| item.as_array())
            .map(|items| items.len())
            .unwrap_or(0);
        results.push(format!("{label}={count}"));
    }

    let schema = inspect_local_database()?;
    println!(
        "[smoke] private rest ok: account={} env={} latencyMs={} endpoints=[{}] schema={}",
        account.id,
        account.environment,
        started.elapsed().as_millis(),
        results.join(","),
        schema
    );
    Ok(())
}

fn reqwest_client() -> Result<reqwest::Client, String> {
    let proxy = load_proxy_config().unwrap_or_default();
    let mut builder = reqwest::Client::builder()
        .use_native_tls()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("Desic-Terminal-private-rest-smoke/0.1");
    if proxy.enabled {
        let proxy_url = format!(
            "{}://{}:{}",
            proxy.proxy_type.to_lowercase(),
            proxy.host,
            proxy.port
        );
        let mut proxy_value =
            Proxy::all(&proxy_url).map_err(|err| format!("invalid proxy {proxy_url}: {err}"))?;
        if let Some(username) = proxy
            .username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            proxy_value = proxy_value.basic_auth(username, proxy.password.as_deref().unwrap_or(""));
        }
        builder = builder.proxy(proxy_value);
    }
    builder.build().map_err(|err| err.to_string())
}

async fn okx_private_get(
    client: &reqwest::Client,
    account: &LocalAccount,
    path: &str,
) -> Result<Value, String> {
    let base = if account.environment.eq_ignore_ascii_case("demo")
        || account.environment.eq_ignore_ascii_case("simulated")
    {
        REST_BASE_DEMO
    } else {
        REST_BASE
    };
    let timestamp = okx_timestamp()?;
    let sign = okx_sign(&account.secret_key, &timestamp, "GET", path, "")?;
    let mut request = client
        .get(format!("{base}{path}"))
        .header("OK-ACCESS-KEY", account.api_key.as_str())
        .header("OK-ACCESS-SIGN", sign)
        .header("OK-ACCESS-TIMESTAMP", timestamp)
        .header("OK-ACCESS-PASSPHRASE", account.passphrase.as_str())
        .header("Content-Type", "application/json");
    if account.environment.eq_ignore_ascii_case("demo")
        || account.environment.eq_ignore_ascii_case("simulated")
    {
        request = request.header("x-simulated-trading", "1");
    }
    let response = request
        .send()
        .await
        .map_err(|err| format!("GET {path} failed: {err}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("GET {path} body failed: {err}"))?;
    if !status.is_success() {
        return Err(format!("GET {path} HTTP {status}: {}", compact(&text)));
    }
    let value = serde_json::from_str::<Value>(&text)
        .map_err(|err| format!("GET {path} JSON failed: {err}: {}", compact(&text)))?;
    let code = value
        .get("code")
        .and_then(|item| item.as_str())
        .unwrap_or_default();
    if code != "0" {
        let msg = value
            .get("msg")
            .and_then(|item| item.as_str())
            .unwrap_or_default();
        return Err(format!("GET {path} OKX {code}: {msg}"));
    }
    Ok(value)
}

fn inspect_local_database() -> Result<String, String> {
    let Some(path) = find_desktop_database_path() else {
        return Ok("desktop-db=missing".to_string());
    };
    let conn = Connection::open(&path)
        .map_err(|err| format!("open sqlite {} failed: {err}", path.display()))?;
    let tables = [
        "okx_orders",
        "okx_fills",
        "okx_account_bills",
        "okx_position_history",
        "position_episodes",
        "position_episode_events",
    ];
    let mut parts = Vec::new();
    for table in tables {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |row| row.get(0),
            )
            .map_err(|err| format!("inspect table {table} failed: {err}"))?;
        if exists == 0 {
            return Err(format!("sqlite table missing: {table}"));
        }
        let count: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .map_err(|err| format!("count table {table} failed: {err}"))?;
        parts.push(format!("{table}:{count}"));
    }
    let cl_ord_id: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('okx_orders') WHERE name='cl_ord_id'",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("inspect okx_orders.cl_ord_id failed: {err}"))?;
    let cl_ord_idx: i64 = conn
        .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_okx_orders_cl_ord'", [], |row| row.get(0))
        .map_err(|err| format!("inspect idx_okx_orders_cl_ord failed: {err}"))?;
    if cl_ord_id == 0 || cl_ord_idx == 0 {
        return Err("sqlite okx_orders cl_ord_id migration is incomplete".to_string());
    }
    Ok(format!("{};clOrdMigration=ok", parts.join(",")))
}

fn find_desktop_database_path() -> Option<PathBuf> {
    desic_smoke_tools::desktop_database_path("desic_trade_ai.sqlite3")
}

fn load_account() -> Result<LocalAccount, String> {
    let path = workspace_root().join("config").join("accounts.local.json");
    let content = fs::read_to_string(&path)
        .map_err(|err| format!("read {} failed: {err}", path.display()))?;
    let config: AccountsConfig = serde_json::from_str(&content)
        .map_err(|err| format!("parse accounts config failed: {err}"))?;
    config
        .accounts
        .into_iter()
        .find(|item| item.exchange.eq_ignore_ascii_case("okx") && item.permissions.read)
        .ok_or_else(|| "no readable OKX account configured".to_string())
}

fn load_proxy_config() -> Result<ProxyConfig, String> {
    let path = workspace_root().join("config").join("proxy.local.json");
    if !path.exists() {
        return Ok(ProxyConfig::default());
    }
    let content =
        fs::read_to_string(&path).map_err(|err| format!("read proxy config failed: {err}"))?;
    let config: ProxyConfig = serde_json::from_str(&content)
        .map_err(|err| format!("parse proxy config failed: {err}"))?;
    Ok(config)
}

fn workspace_root() -> PathBuf {
    desic_smoke_tools::workspace_root()
}

fn validate_account(account: &LocalAccount) -> Result<(), String> {
    if account.api_key.trim().is_empty()
        || account.secret_key.trim().is_empty()
        || account.passphrase.trim().is_empty()
    {
        return Err(format!("account {} missing local credentials", account.id));
    }
    Ok(())
}

fn okx_timestamp() -> Result<String, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| err.to_string())?;
    Ok(format!(
        "{}.{:03}",
        duration.as_secs(),
        duration.subsec_millis()
    ))
}

fn okx_sign(
    secret: &str,
    timestamp: &str,
    method: &str,
    path: &str,
    body: &str,
) -> Result<String, String> {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|err| err.to_string())?;
    mac.update(format!("{}{}{}{}", timestamp, method.to_uppercase(), path, body).as_bytes());
    Ok(general_purpose::STANDARD.encode(mac.finalize().into_bytes()))
}

fn compact(value: &str) -> String {
    let text = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() > 240 {
        format!("{}...", text.chars().take(240).collect::<String>())
    } else {
        text
    }
}
