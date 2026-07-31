use base64::{engine::general_purpose, Engine as _};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use reqwest::Proxy;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;
use std::{
    fs,
    path::PathBuf,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
    time::{timeout, Duration},
};
use tokio_tungstenite::{client_async, tungstenite::Message, WebSocketStream};

const REST_BASE: &str = "https://www.okx.com";
const PRIVATE_WS: &str = "wss://ws.okx.com:8443/ws/v5/private";
const PRIVATE_WS_DEMO: &str = "wss://wspap.okx.com:8443/ws/v5/private";

trait AsyncReadWrite: AsyncRead + AsyncWrite {}
impl<T: AsyncRead + AsyncWrite + ?Sized> AsyncReadWrite for T {}
type BoxedIo = Box<dyn AsyncReadWrite + Unpin + Send>;

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
        eprintln!("[smoke] private reconcile failed: {error}");
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
    let rest_started = Instant::now();
    let rest_balance = okx_private_get(&client, &account, "/api/v5/account/balance").await?;
    let rest_positions =
        okx_private_get(&client, &account, "/api/v5/account/positions?instType=SWAP").await?;
    let rest_orders = okx_private_get(
        &client,
        &account,
        "/api/v5/trade/orders-pending?instType=SWAP",
    )
    .await?;
    let rest_algo_orders = okx_private_get(
        &client,
        &account,
        "/api/v5/trade/orders-algo-pending?instType=SWAP&ordType=trigger",
    )
    .await?;
    let rest_balance_count = rest_balance_details(&rest_balance).len();
    let rest_position_count = data_len(&rest_positions);
    let rest_order_count = data_len(&rest_orders) + data_len(&rest_algo_orders);
    if rest_balance_count == 0 {
        return Err("REST balance returned no currency details".to_string());
    }

    let endpoint = if account.environment.eq_ignore_ascii_case("demo")
        || account.environment.eq_ignore_ascii_case("simulated")
    {
        PRIVATE_WS_DEMO
    } else {
        PRIVATE_WS
    };
    let started = Instant::now();
    let mut socket = timeout(Duration::from_secs(20), connect_ws(endpoint))
        .await
        .map_err(|_| "private websocket connect timeout".to_string())??;
    let login = private_ws_login_payload(&account)?;
    socket
        .send(Message::Text(login.to_string()))
        .await
        .map_err(|err| format!("send login failed: {err}"))?;

    let mut subscribed = false;
    let mut ws = WsReconcile::default();
    loop {
        let message = timeout(Duration::from_secs(20), socket.next())
            .await
            .map_err(|_| "private websocket response timeout".to_string())?
            .ok_or_else(|| "private websocket closed".to_string())?
            .map_err(|err| format!("private websocket error: {err}"))?;
        let Message::Text(text) = message else {
            continue;
        };
        if !subscribed && private_login_succeeded(&text)? {
            let subscribe = json!({
                "op": "subscribe",
                "args": [
                    { "channel": "balance_and_position" },
                    { "channel": "account" },
                    { "channel": "positions", "instType": "SWAP" },
                    { "channel": "orders", "instType": "SWAP" }
                ]
            });
            socket
                .send(Message::Text(subscribe.to_string()))
                .await
                .map_err(|err| format!("send subscribe failed: {err}"))?;
            subscribed = true;
            continue;
        }
        let value: Value = serde_json::from_str(&text)
            .map_err(|err| format!("parse private ws frame failed: {err}"))?;
        if value.get("event").and_then(|item| item.as_str()) == Some("error") {
            return Err(format!(
                "private websocket returned error: {}",
                compact(&text)
            ));
        }
        let channel = value
            .get("arg")
            .and_then(|arg| arg.get("channel"))
            .and_then(|channel| channel.as_str())
            .unwrap_or_default()
            .to_string();
        let subscribed_event =
            value.get("event").and_then(|item| item.as_str()) == Some("subscribe");
        if subscribed_event {
            ws.subscribed.insert(channel);
        } else {
            match channel.as_str() {
                "account" => {
                    ws.account_frames += 1;
                    ws.account_currencies += account_currency_count(&value);
                    ws.event_time = ws.event_time.or_else(|| private_event_time(&value));
                }
                "balance_and_position" => {
                    ws.balance_frames += 1;
                    ws.balance_currencies += balance_position_currency_count(&value);
                    ws.event_time = ws.event_time.or_else(|| private_event_time(&value));
                }
                "positions" => {
                    ws.position_frames += 1;
                    ws.positions += data_len(&value);
                    ws.event_time = ws.event_time.or_else(|| private_event_time(&value));
                }
                "orders" => {
                    ws.order_frames += 1;
                    ws.orders += data_len(&value);
                    ws.event_time = ws.event_time.or_else(|| private_event_time(&value));
                }
                _ => {}
            }
        }
        if ws.ready() {
            let _ = socket.close(None).await;
            let delay_ms = ws.event_time.map(|ts| now_ms().saturating_sub(ts));
            println!(
                "[smoke] private reconcile ok: account={} env={} restLatencyMs={} totalLatencyMs={} rest=[balances={},positions={},orders={}] ws=[subscribed={},accountFrames={},balanceFrames={},positionFrames={},orderFrames={},accountCurrencies={},balanceCurrencies={},positions={},orders={},delayMs={}]",
                account.id,
                account.environment,
                rest_started.elapsed().as_millis(),
                started.elapsed().as_millis(),
                rest_balance_count,
                rest_position_count,
                rest_order_count,
                ws.subscribed_summary(),
                ws.account_frames,
                ws.balance_frames,
                ws.position_frames,
                ws.order_frames,
                ws.account_currencies,
                ws.balance_currencies,
                ws.positions,
                ws.orders,
                delay_ms.map(|value| value.to_string()).unwrap_or_else(|| "none".to_string())
            );
            return Ok(());
        }
    }
}

#[derive(Default)]
struct WsReconcile {
    subscribed: std::collections::BTreeSet<String>,
    account_frames: usize,
    balance_frames: usize,
    position_frames: usize,
    order_frames: usize,
    account_currencies: usize,
    balance_currencies: usize,
    positions: usize,
    orders: usize,
    event_time: Option<i64>,
}

impl WsReconcile {
    fn ready(&self) -> bool {
        self.subscribed.contains("account")
            && self.subscribed.contains("balance_and_position")
            && self.subscribed.contains("positions")
            && self.subscribed.contains("orders")
            && (self.account_currencies > 0 || self.balance_currencies > 0)
    }

    fn subscribed_summary(&self) -> String {
        self.subscribed
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join("+")
    }
}

fn load_account() -> Result<LocalAccount, String> {
    let path = workspace_config_path();
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

fn workspace_config_path() -> PathBuf {
    desic_smoke_tools::workspace_root()
        .join("config")
        .join("accounts.local.json")
}

fn workspace_proxy_config_path() -> PathBuf {
    desic_smoke_tools::workspace_root()
        .join("config")
        .join("proxy.local.json")
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

fn reqwest_client() -> Result<reqwest::Client, String> {
    let proxy = load_proxy_config().unwrap_or_default();
    let mut builder = reqwest::Client::builder()
        .use_native_tls()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("Desic-Terminal-private-reconcile-smoke/0.1");
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
    let timestamp = okx_rest_timestamp()?;
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

fn data_len(value: &Value) -> usize {
    value
        .get("data")
        .and_then(|item| item.as_array())
        .map(Vec::len)
        .unwrap_or(0)
}

fn rest_balance_details(value: &Value) -> Vec<&Value> {
    value
        .get("data")
        .and_then(|item| item.as_array())
        .map(|rows| {
            rows.iter()
                .flat_map(|row| {
                    row.get("details")
                        .and_then(|item| item.as_array())
                        .into_iter()
                        .flatten()
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn balance_position_currency_count(value: &Value) -> usize {
    value
        .get("data")
        .and_then(|item| item.as_array())
        .map(|rows| {
            rows.iter()
                .flat_map(|row| {
                    row.get("balData")
                        .and_then(|item| item.as_array())
                        .into_iter()
                        .flatten()
                })
                .count()
        })
        .unwrap_or(0)
}

fn account_currency_count(value: &Value) -> usize {
    value
        .get("data")
        .and_then(|item| item.as_array())
        .map(|rows| {
            rows.iter()
                .flat_map(|row| {
                    row.get("details")
                        .and_then(|item| item.as_array())
                        .into_iter()
                        .flatten()
                })
                .count()
        })
        .unwrap_or(0)
}

fn private_event_time(value: &Value) -> Option<i64> {
    value
        .get("data")
        .and_then(|item| item.as_array())
        .into_iter()
        .flatten()
        .filter_map(|row| {
            ["pTime", "uTime", "ts"]
                .into_iter()
                .filter_map(|key| row.get(key).and_then(|item| item.as_str()))
                .filter_map(|text| text.parse::<i64>().ok())
                .next()
        })
        .min()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn okx_rest_timestamp() -> Result<String, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| err.to_string())?;
    Ok(format!(
        "{}.{:03}",
        duration.as_secs(),
        duration.subsec_millis()
    ))
}

fn private_ws_login_payload(account: &LocalAccount) -> Result<serde_json::Value, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| err.to_string())?
        .as_secs()
        .to_string();
    let sign = okx_sign(
        &account.secret_key,
        &timestamp,
        "GET",
        "/users/self/verify",
        "",
    )?;
    Ok(json!({
        "op": "login",
        "args": [{
            "apiKey": account.api_key,
            "passphrase": account.passphrase,
            "timestamp": timestamp,
            "sign": sign
        }]
    }))
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

fn private_login_succeeded(text: &str) -> Result<bool, String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Ok(false);
    };
    if value.get("event").and_then(|event| event.as_str()) != Some("login") {
        return Ok(false);
    }
    let code = value
        .get("code")
        .and_then(|code| code.as_str())
        .unwrap_or_default();
    if code == "0" {
        return Ok(true);
    }
    let msg = value
        .get("msg")
        .and_then(|msg| msg.as_str())
        .unwrap_or("login failed");
    Err(format!("login failed {code} {msg}"))
}

async fn connect_ws(url: &str) -> Result<WebSocketStream<BoxedIo>, String> {
    let proxy = load_proxy_config().unwrap_or_default();
    if proxy.enabled && proxy.proxy_type.eq_ignore_ascii_case("HTTP") {
        return connect_ws_via_http_proxy(url, &proxy).await;
    }
    Err("private ws smoke requires the configured HTTP proxy; enable config/proxy.local.json with 127.0.0.1:8881".to_string())
}

fn load_proxy_config() -> Result<ProxyConfig, String> {
    let path = workspace_proxy_config_path();
    if !path.exists() {
        return Ok(ProxyConfig::default());
    }
    let content =
        fs::read_to_string(&path).map_err(|err| format!("read proxy config failed: {err}"))?;
    let config: ProxyConfig = serde_json::from_str(&content)
        .map_err(|err| format!("parse proxy config failed: {err}"))?;
    Ok(config)
}

async fn connect_ws_via_http_proxy(
    url: &str,
    proxy: &ProxyConfig,
) -> Result<WebSocketStream<BoxedIo>, String> {
    let (host, port, path) = parse_wss_endpoint(url)?;
    let mut stream = TcpStream::connect((proxy.host.as_str(), proxy.port))
        .await
        .map_err(|err| format!("proxy connect failed: {err}"))?;
    let auth_header = proxy_authorization_header(proxy);
    let request = format!(
        "CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n{auth_header}Proxy-Connection: Keep-Alive\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|err| err.to_string())?;
    let mut response = Vec::new();
    let mut buf = [0_u8; 1024];
    loop {
        let n = stream.read(&mut buf).await.map_err(|err| err.to_string())?;
        if n == 0 {
            return Err("proxy closed before CONNECT completed".to_string());
        }
        response.extend_from_slice(&buf[..n]);
        if response.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if response.len() > 8192 {
            return Err("proxy CONNECT response too large".to_string());
        }
    }
    let response_text = String::from_utf8_lossy(&response);
    if !response_text.starts_with("HTTP/1.1 200") && !response_text.starts_with("HTTP/1.0 200") {
        return Err(format!("proxy CONNECT failed: {}", compact(&response_text)));
    }
    let tls = tokio_native_tls::TlsConnector::from(
        native_tls::TlsConnector::new().map_err(|err| err.to_string())?,
    );
    let tls_stream = tls
        .connect(host.as_str(), stream)
        .await
        .map_err(|err| format!("proxy TLS failed: {err}"))?;
    let request_uri = format!("wss://{host}:{port}{path}");
    let (socket, _) = client_async(request_uri, Box::new(tls_stream) as BoxedIo)
        .await
        .map_err(|err| format!("websocket handshake via proxy failed: {err}"))?;
    Ok(socket)
}

fn parse_wss_endpoint(url: &str) -> Result<(String, u16, String), String> {
    let rest = url
        .strip_prefix("wss://")
        .ok_or_else(|| "only wss websocket URLs are supported".to_string())?;
    let (authority, path) = match rest.split_once('/') {
        Some((authority, path)) => (authority, format!("/{path}")),
        None => (rest, "/".to_string()),
    };
    if authority.trim().is_empty() {
        return Err("websocket host missing".to_string());
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() => {
            let parsed_port = port
                .parse::<u16>()
                .map_err(|err| format!("invalid websocket port: {err}"))?;
            (host.to_string(), parsed_port)
        }
        _ => (authority.to_string(), 443),
    };
    Ok((host, port, path))
}

fn proxy_authorization_header(config: &ProxyConfig) -> String {
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

fn compact(value: &str) -> String {
    let text = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() > 240 {
        format!("{}...", text.chars().take(240).collect::<String>())
    } else {
        text
    }
}
