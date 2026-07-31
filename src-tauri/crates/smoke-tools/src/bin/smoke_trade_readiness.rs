use base64::{engine::general_purpose, Engine as _};
use hmac::{Hmac, Mac};
use reqwest::Proxy;
use serde::Deserialize;
use serde_json::Value;
use sha2::Sha256;
use std::{
    fs,
    path::PathBuf,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const REST_BASE: &str = "https://www.okx.com";
const DEFAULT_INST_ID: &str = "BTC-USDT-SWAP";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountsConfig {
    accounts: Vec<LocalAccount>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LocalAccount {
    id: String,
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
    trade: bool,
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

#[derive(Debug)]
struct Direction {
    action: &'static str,
    side: &'static str,
    pos_side: Option<&'static str>,
    reduce_only: Option<bool>,
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
        eprintln!("[smoke] trade readiness failed: {error}");
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
    if !account.permissions.trade {
        return Err(format!(
            "account {} has local trade permission disabled",
            account.id
        ));
    }
    validate_account(&account)?;
    let client = reqwest_client()?;
    let started = Instant::now();
    let inst_id =
        std::env::var("OKX_TRADE_INST_ID").unwrap_or_else(|_| DEFAULT_INST_ID.to_string());
    let td_mode = std::env::var("OKX_TRADE_TD_MODE").unwrap_or_else(|_| "cross".to_string());
    let px = std::env::var("OKX_TRADE_PRICE").unwrap_or_else(|_| "1".to_string());
    let lever = std::env::var("OKX_TRADE_LEVER").unwrap_or_else(|_| "5".to_string());

    let config = okx_private_get(&client, &account, "/api/v5/account/config").await?;
    let config_row = first_data(&config, "account/config")?;
    let pos_mode = string_field(config_row, "posMode");
    let account_level = string_field(config_row, "acctLv");
    let account_perms = string_field(config_row, "perm");
    let has_trade_perm = account_perms.split(',').any(|item| item.trim() == "trade");

    let positions = okx_private_get(
        &client,
        &account,
        &format!(
            "/api/v5/account/positions?instType=SWAP&instId={}",
            url_encode(&inst_id)
        ),
    )
    .await?;
    let position_rows = data_array(&positions, "positions")?;
    let long_pos = position_amount(position_rows, &inst_id, "long");
    let short_pos = position_amount(position_rows, &inst_id, "short");
    let net_pos = position_amount(position_rows, &inst_id, "net");

    let leverage = okx_private_get(
        &client,
        &account,
        &format!(
            "/api/v5/account/leverage-info?instId={}&mgnMode={}",
            url_encode(&inst_id),
            url_encode(&td_mode)
        ),
    )
    .await?;
    let leverage_rows = data_array(&leverage, "leverage-info")?;

    let max_size = okx_private_get(
        &client,
        &account,
        &format!(
            "/api/v5/account/max-size?instId={}&tdMode={}&px={}&leverage={}",
            url_encode(&inst_id),
            url_encode(&td_mode),
            url_encode(&px),
            url_encode(&lever)
        ),
    )
    .await?;
    let max_row = first_data(&max_size, "max-size")?;
    let max_buy = string_field(max_row, "maxBuy");
    let max_sell = string_field(max_row, "maxSell");

    let directions = direction_matrix(&pos_mode)?;
    let close_long_available = if pos_mode == "long_short_mode" {
        long_pos > 0.0
    } else {
        net_pos > 0.0
    };
    let close_short_available = if pos_mode == "long_short_mode" {
        short_pos > 0.0
    } else {
        net_pos < 0.0
    };
    if max_buy.trim().is_empty() || max_sell.trim().is_empty() {
        return Err("max-size returned empty maxBuy/maxSell".to_string());
    }
    if directions.len() != 4 {
        return Err(format!(
            "direction matrix incomplete for posMode={pos_mode}: {}",
            directions.len()
        ));
    }

    let direction_summary = directions
        .iter()
        .map(|item| {
            format!(
                "{}:{}:{}:{}",
                item.action,
                item.side,
                item.pos_side.unwrap_or("net"),
                item.reduce_only
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "none".to_string())
            )
        })
        .collect::<Vec<_>>()
        .join(",");

    println!(
        "[smoke] trade readiness ok: account={} name={} env={} localTradePerm={} okxTradePerm={} inst={} posMode={} acctLv={} leverageRows={} maxBuy={} maxSell={} closeLongAvailable={} closeShortAvailable={} directions=[{}] latencyMs={}",
        account.id,
        account.name,
        account.environment,
        account.permissions.trade,
        has_trade_perm,
        inst_id,
        pos_mode,
        account_level,
        leverage_rows.len(),
        max_buy,
        max_sell,
        close_long_available,
        close_short_available,
        direction_summary,
        started.elapsed().as_millis()
    );
    Ok(())
}

fn direction_matrix(pos_mode: &str) -> Result<Vec<Direction>, String> {
    ["long", "short", "close-long", "close-short"]
        .into_iter()
        .map(|action| order_direction(action, pos_mode))
        .collect()
}

fn order_direction(action: &'static str, pos_mode: &str) -> Result<Direction, String> {
    let (side, long_short_pos_side, close) = match action {
        "long" => ("buy", "long", false),
        "short" => ("sell", "short", false),
        "close-long" => ("sell", "long", true),
        "close-short" => ("buy", "short", true),
        _ => return Err("invalid action".to_string()),
    };
    if pos_mode == "long_short_mode" {
        return Ok(Direction {
            action,
            side,
            pos_side: Some(long_short_pos_side),
            reduce_only: None,
        });
    }
    Ok(Direction {
        action,
        side,
        pos_side: None,
        reduce_only: if close { Some(true) } else { None },
    })
}

fn position_amount(rows: &[Value], inst_id: &str, pos_side: &str) -> f64 {
    rows.iter()
        .filter(|row| string_field(row, "instId") == inst_id)
        .filter(|row| {
            let value = string_field(row, "posSide");
            if pos_side == "net" {
                value.is_empty() || value.eq_ignore_ascii_case("net")
            } else {
                value.eq_ignore_ascii_case(pos_side)
            }
        })
        .filter_map(|row| string_field(row, "pos").parse::<f64>().ok())
        .sum()
}

fn reqwest_client() -> Result<reqwest::Client, String> {
    let proxy = load_proxy_config().unwrap_or_default();
    let mut builder = reqwest::Client::builder()
        .use_native_tls()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("Desic-Terminal-trade-readiness-smoke/0.1");
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
    let timestamp = okx_timestamp()?;
    let sign = okx_sign(&account.secret_key, &timestamp, "GET", path, "")?;
    let mut request = client
        .get(format!("{REST_BASE}{path}"))
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

fn first_data<'a>(value: &'a Value, label: &str) -> Result<&'a Value, String> {
    data_array(value, label)?
        .first()
        .ok_or_else(|| format!("{label} returned empty data"))
}

fn data_array<'a>(value: &'a Value, label: &str) -> Result<&'a Vec<Value>, String> {
    value
        .get("data")
        .and_then(|item| item.as_array())
        .ok_or_else(|| format!("{label} response missing data array"))
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|item| item.as_str())
        .unwrap_or_default()
        .to_string()
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

fn url_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

fn compact(value: &str) -> String {
    let text = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() > 240 {
        format!("{}...", text.chars().take(240).collect::<String>())
    } else {
        text
    }
}
