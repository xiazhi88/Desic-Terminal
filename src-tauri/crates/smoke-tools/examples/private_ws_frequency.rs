use base64::{engine::general_purpose, Engine as _};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
    time::{interval, timeout},
};
use tokio_tungstenite::{client_async, tungstenite::Message, WebSocketStream};

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

#[derive(Debug, Default)]
struct ChannelStats {
    frames: u64,
    rows: u64,
    first_at_ms: Option<u128>,
    last_at_ms: Option<u128>,
    min_gap_ms: Option<u128>,
    max_gap_ms: Option<u128>,
    total_gap_ms: u128,
    gap_count: u64,
    stale_or_duplicate_event_ts: u64,
    last_event_ts: Option<i64>,
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
        eprintln!("[sample] private ws frequency failed: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let sample_secs = std::env::var("DESIC_PRIVATE_WS_SAMPLE_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(600);
    let progress_secs = std::env::var("DESIC_PRIVATE_WS_PROGRESS_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(30);
    let account = load_account()?;
    if !account.permissions.read {
        return Err(format!(
            "account {} has read permission disabled",
            account.id
        ));
    }
    validate_account(&account)?;

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
    wait_for_login(&mut socket).await?;

    let subscribe = json!({
        "op": "subscribe",
        "args": [
            { "channel": "account" },
            { "channel": "positions", "instType": "SWAP" },
            { "channel": "balance_and_position" },
            { "channel": "orders", "instType": "SWAP" }
        ]
    });
    socket
        .send(Message::Text(subscribe.to_string()))
        .await
        .map_err(|err| format!("send subscribe failed: {err}"))?;

    let deadline = Instant::now() + Duration::from_secs(sample_secs);
    let mut progress = interval(Duration::from_secs(progress_secs));
    let mut stats: BTreeMap<String, ChannelStats> = BTreeMap::new();
    let mut subscribe_acks = 0_u64;
    let mut other_text_frames = 0_u64;
    println!(
        "[sample] private ws frequency start: account={} name={} env={} sampleSecs={} channels=account,positions,balance_and_position,orders",
        account.id, account.name, account.environment, sample_secs
    );

    loop {
        tokio::select! {
            _ = progress.tick() => {
                print_progress(started.elapsed(), &stats, subscribe_acks, other_text_frames);
            }
            maybe_message = socket.next() => {
                let Some(message) = maybe_message else {
                    return Err("private websocket closed".to_string());
                };
                let message = message.map_err(|err| format!("private websocket error: {err}"))?;
                handle_message(message, &mut socket, started, &mut stats, &mut subscribe_acks, &mut other_text_frames).await?;
            }
        }
        if Instant::now() >= deadline {
            break;
        }
    }

    let _ = socket.close(None).await;
    println!("[sample] private ws frequency summary:");
    print_summary(&stats, subscribe_acks, other_text_frames, started.elapsed());
    Ok(())
}

async fn wait_for_login(socket: &mut WebSocketStream<BoxedIo>) -> Result<(), String> {
    loop {
        let message = timeout(Duration::from_secs(20), socket.next())
            .await
            .map_err(|_| "private websocket login timeout".to_string())?
            .ok_or_else(|| "private websocket closed before login".to_string())?
            .map_err(|err| format!("private websocket error: {err}"))?;
        let Message::Text(text) = message else {
            continue;
        };
        if private_login_succeeded(&text)? {
            return Ok(());
        }
    }
}

async fn handle_message(
    message: Message,
    socket: &mut WebSocketStream<BoxedIo>,
    started: Instant,
    stats: &mut BTreeMap<String, ChannelStats>,
    subscribe_acks: &mut u64,
    other_text_frames: &mut u64,
) -> Result<(), String> {
    match message {
        Message::Text(text) if text == "ping" => {
            socket
                .send(Message::Text("pong".to_string()))
                .await
                .map_err(|err| format!("send pong failed: {err}"))?;
        }
        Message::Text(text) => {
            let value: Value = serde_json::from_str(&text).map_err(|err| {
                format!(
                    "parse private ws frame failed: {err}; frame={}",
                    compact(&text)
                )
            })?;
            if value.get("event").and_then(|item| item.as_str()) == Some("error") {
                return Err(format!(
                    "private websocket returned error: {}",
                    compact(&text)
                ));
            }
            if value.get("event").and_then(|item| item.as_str()) == Some("subscribe") {
                *subscribe_acks += 1;
                return Ok(());
            }
            let Some(channel) = value
                .get("arg")
                .and_then(|arg| arg.get("channel"))
                .and_then(|channel| channel.as_str())
            else {
                *other_text_frames += 1;
                return Ok(());
            };
            let rows = value
                .get("data")
                .and_then(|data| data.as_array())
                .map(|data| data.len())
                .unwrap_or(0) as u64;
            let event_ts = newest_event_ts(&value);
            let elapsed_ms = started.elapsed().as_millis();
            let entry = stats.entry(channel.to_string()).or_default();
            if let Some(last_at) = entry.last_at_ms {
                let gap = elapsed_ms.saturating_sub(last_at);
                entry.min_gap_ms = Some(entry.min_gap_ms.map_or(gap, |value| value.min(gap)));
                entry.max_gap_ms = Some(entry.max_gap_ms.map_or(gap, |value| value.max(gap)));
                entry.total_gap_ms = entry.total_gap_ms.saturating_add(gap);
                entry.gap_count = entry.gap_count.saturating_add(1);
            }
            if let (Some(last), Some(current)) = (entry.last_event_ts, event_ts) {
                if current <= last {
                    entry.stale_or_duplicate_event_ts =
                        entry.stale_or_duplicate_event_ts.saturating_add(1);
                }
            }
            entry.frames = entry.frames.saturating_add(1);
            entry.rows = entry.rows.saturating_add(rows);
            entry.first_at_ms = entry.first_at_ms.or(Some(elapsed_ms));
            entry.last_at_ms = Some(elapsed_ms);
            entry.last_event_ts = event_ts.or(entry.last_event_ts);
            println!(
                "[sample] frame channel={} elapsedMs={} rows={} eventTs={}",
                channel,
                elapsed_ms,
                rows,
                event_ts
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "-".to_string())
            );
        }
        Message::Ping(payload) => {
            socket
                .send(Message::Pong(payload))
                .await
                .map_err(|err| format!("send websocket pong failed: {err}"))?;
        }
        _ => {}
    }
    Ok(())
}

fn newest_event_ts(value: &Value) -> Option<i64> {
    value
        .get("data")
        .and_then(|data| data.as_array())
        .into_iter()
        .flatten()
        .flat_map(|row| {
            ["pTime", "uTime", "ts"]
                .into_iter()
                .filter_map(|key| row.get(key).and_then(|item| item.as_str()))
        })
        .filter_map(|value| value.parse::<i64>().ok())
        .max()
}

fn print_progress(
    elapsed: Duration,
    stats: &BTreeMap<String, ChannelStats>,
    subscribe_acks: u64,
    other_text_frames: u64,
) {
    println!(
        "[sample] progress elapsedSecs={} subscribeAcks={} otherTextFrames={}",
        elapsed.as_secs(),
        subscribe_acks,
        other_text_frames
    );
    print_summary(stats, subscribe_acks, other_text_frames, elapsed);
}

fn print_summary(
    stats: &BTreeMap<String, ChannelStats>,
    subscribe_acks: u64,
    other_text_frames: u64,
    elapsed: Duration,
) {
    if stats.is_empty() {
        println!(
            "[sample] summary elapsedSecs={} subscribeAcks={} otherTextFrames={} dataFrames=0",
            elapsed.as_secs(),
            subscribe_acks,
            other_text_frames
        );
        return;
    }
    for (channel, item) in stats {
        let avg_gap_ms = if item.gap_count > 0 {
            Some(item.total_gap_ms / u128::from(item.gap_count))
        } else {
            None
        };
        println!(
            "[sample] summary channel={} frames={} rows={} firstAtMs={} lastAtMs={} minGapMs={} avgGapMs={} maxGapMs={} staleOrDuplicateEventTs={}",
            channel,
            item.frames,
            item.rows,
            item.first_at_ms.map(|value| value.to_string()).unwrap_or_else(|| "-".to_string()),
            item.last_at_ms.map(|value| value.to_string()).unwrap_or_else(|| "-".to_string()),
            item.min_gap_ms.map(|value| value.to_string()).unwrap_or_else(|| "-".to_string()),
            avg_gap_ms.map(|value| value.to_string()).unwrap_or_else(|| "-".to_string()),
            item.max_gap_ms.map(|value| value.to_string()).unwrap_or_else(|| "-".to_string()),
            item.stale_or_duplicate_event_ts
        );
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

fn private_ws_login_payload(account: &LocalAccount) -> Result<Value, String> {
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
    let Ok(value) = serde_json::from_str::<Value>(text) else {
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
    Err("private ws sample requires the configured HTTP proxy; enable config/proxy.local.json with 127.0.0.1:8881".to_string())
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
    let request = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n{auth_header}Proxy-Connection: Keep-Alive\r\n\r\n");
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
