use super::*;
use crate::chart_alerts::process_chart_indicator_alerts;
use crate::chart_consumers::{
    MarketChannel, MarketConsumerRegistry, MarketConsumerRequest, MarketSubscriptionDiff,
};
use std::collections::BTreeSet;

const OKX_KLINE_BARS: &[&str] = &["1m"];
const MIN_RENDER_ORDERBOOK_LEVELS: usize = 24;
const PUBLIC_SHARD_SIZE: usize = 5;
const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const PUBLIC_SHARD_CONNECT_STAGGER_MS: u64 = 300;
const PUBLIC_RENDER_INTERVAL_MS: u64 = 50;
const PUBLIC_RENDER_MAX_DELAY_MS: i64 = 10_000;
const PUBLIC_STALE_RECONNECT_DELAY_MS: i64 = 15_000;
const PUBLIC_STALE_RECONNECT_MESSAGE_COUNT: u8 = 3;
const PUBLIC_RENDER_MAX_TRADES_PER_SYMBOL: usize = 64;
const PUBLIC_META_TICKER_STALE_MS: i64 = 20_000;
const PUBLIC_META_BOOK_FRESH_MS: i64 = 5_000;
const BUSINESS_DATA_STALE_AFTER: Duration = Duration::from_secs(20);
const WS_DATA_RECOVERY_GRACE: Duration = Duration::from_secs(10);
const CANCELLED_PENDING_ORDER_TOMBSTONE_TTL_MS: i64 = 120_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PublicStreamKind {
    Meta,
    Books,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DataRecoveryAction {
    None,
    Resubscribe,
    Reconnect,
}

#[derive(Default)]
struct PublicRenderBuffer {
    books: HashMap<String, OrderBook>,
    trades: HashMap<String, Vec<Trade>>,
}

impl PublicRenderBuffer {
    fn queue_book(&mut self, inst_id: String, book: OrderBook) {
        if !inst_id.is_empty() {
            self.books.insert(inst_id, book);
        }
    }

    fn queue_trade(&mut self, inst_id: &str, trade: Trade) {
        if inst_id.is_empty() {
            return;
        }
        let trades = self.trades.entry(inst_id.to_string()).or_default();
        trades.push(trade);
        if trades.len() > PUBLIC_RENDER_MAX_TRADES_PER_SYMBOL {
            trades.drain(..trades.len() - PUBLIC_RENDER_MAX_TRADES_PER_SYMBOL);
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum PublicStreamCommand {
    RefreshSubscriptions,
}

#[derive(Clone)]
pub struct PublicStreamControl {
    symbols: Arc<Mutex<Vec<String>>>,
    sender: mpsc::UnboundedSender<PublicStreamCommand>,
}

impl PublicStreamControl {
    fn new(symbols: Vec<String>) -> (Self, mpsc::UnboundedReceiver<PublicStreamCommand>) {
        let (sender, receiver) = mpsc::unbounded_channel();
        (
            Self {
                symbols: Arc::new(Mutex::new(symbols)),
                sender,
            },
            receiver,
        )
    }

    fn symbols(&self) -> Vec<String> {
        self.symbols
            .lock()
            .map(|items| items.clone())
            .unwrap_or_default()
    }

    fn replace_symbols(&self, symbols: Vec<String>) -> Result<(), String> {
        *self.symbols.lock().map_err(|error| error.to_string())? = symbols;
        self.sender
            .send(PublicStreamCommand::RefreshSubscriptions)
            .map_err(|_| "market stream control channel closed".to_string())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketConsumerRegistration {
    pub consumer_id: String,
    #[serde(default)]
    pub symbols: Vec<String>,
    #[serde(default = "default_market_consumer_orderbook_depth")]
    pub orderbook_depth: u16,
    #[serde(default = "default_market_consumer_true")]
    pub include_trades: bool,
    #[serde(default = "default_market_consumer_true")]
    pub include_orderbook: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketConsumerStatus {
    pub consumer_id: String,
    pub active_consumers: usize,
    pub symbols: Vec<String>,
    pub added_subscriptions: usize,
    pub removed_subscriptions: usize,
}

fn default_market_consumer_orderbook_depth() -> u16 {
    400
}

fn default_market_consumer_true() -> bool {
    true
}

impl PublicStreamKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Meta => "meta",
            Self::Books => "books",
        }
    }
}

#[tauri::command]
pub fn start_market_stream(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, MarketRuntime>,
    inst_id: String,
    _bar: String,
    watchlist: Option<Vec<String>>,
    session_id: Option<String>,
) -> Result<(), String> {
    let consumer_id = normalize_market_consumer_id(session_id.as_deref(), "main-market")?;
    let public_watchlist = normalize_watchlist(watchlist, &inst_id);
    let diff = runtime
        .market_consumers
        .lock()
        .map_err(|err| err.to_string())?
        .add_or_update(
            &consumer_id,
            chart_market_consumer_request(public_watchlist, 400, true, true),
        )
        .map_err(|err| err.to_string())?;
    reconcile_public_market_consumers(&app, runtime.inner(), diff)?;
    *runtime
        .public_session_id
        .lock()
        .map_err(|err| err.to_string())? = Some(consumer_id);
    Ok(())
}

#[tauri::command]
pub fn register_market_consumer(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, MarketRuntime>,
    registration: MarketConsumerRegistration,
) -> Result<MarketConsumerStatus, String> {
    let consumer_id =
        normalize_market_consumer_id(Some(&registration.consumer_id), "chart-consumer")?;
    let request = chart_market_consumer_request(
        registration.symbols,
        registration.orderbook_depth,
        registration.include_trades,
        registration.include_orderbook,
    );
    let mut consumers = runtime
        .market_consumers
        .lock()
        .map_err(|err| err.to_string())?;
    let diff = consumers
        .add_or_update(&consumer_id, request)
        .map_err(|err| err.to_string())?;
    let active_consumers = consumers.consumer_count();
    let symbols = market_consumer_symbols(&consumers);
    drop(consumers);
    reconcile_public_market_consumers(&app, runtime.inner(), diff.clone())?;
    Ok(MarketConsumerStatus {
        consumer_id,
        active_consumers,
        symbols,
        added_subscriptions: diff.subscribe.len(),
        removed_subscriptions: diff.unsubscribe.len(),
    })
}

#[tauri::command]
pub fn unregister_market_consumer(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, MarketRuntime>,
    consumer_id: String,
) -> Result<MarketConsumerStatus, String> {
    let consumer_id = normalize_market_consumer_id(Some(&consumer_id), "chart-consumer")?;
    let mut consumers = runtime
        .market_consumers
        .lock()
        .map_err(|err| err.to_string())?;
    let diff = consumers.remove(&consumer_id);
    let active_consumers = consumers.consumer_count();
    let symbols = market_consumer_symbols(&consumers);
    drop(consumers);
    reconcile_public_market_consumers(&app, runtime.inner(), diff.clone())?;
    Ok(MarketConsumerStatus {
        consumer_id,
        active_consumers,
        symbols,
        added_subscriptions: diff.subscribe.len(),
        removed_subscriptions: diff.unsubscribe.len(),
    })
}

fn chart_market_consumer_request(
    symbols: Vec<String>,
    orderbook_depth: u16,
    include_trades: bool,
    include_orderbook: bool,
) -> MarketConsumerRequest {
    let mut channels = vec![
        MarketChannel::Ticker,
        MarketChannel::FundingRate,
        MarketChannel::candles("1m"),
    ];
    if include_trades {
        channels.push(MarketChannel::Trades);
    }
    if include_orderbook {
        channels.push(MarketChannel::order_book(orderbook_depth.clamp(1, 5_000)));
    }
    MarketConsumerRequest::new(symbols, channels)
}

fn normalize_market_consumer_id(value: Option<&str>, fallback: &str) -> Result<String, String> {
    let normalized = value.unwrap_or(fallback).trim();
    if normalized.is_empty() || normalized.len() > 160 {
        return Err("invalid market consumer id".to_string());
    }
    Ok(normalized.to_string())
}

fn market_consumer_symbols(consumers: &MarketConsumerRegistry) -> Vec<String> {
    consumers
        .reference_counts()
        .keys()
        .map(|subscription| subscription.symbol.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn reconcile_public_market_consumers(
    app: &tauri::AppHandle,
    runtime: &MarketRuntime,
    diff: MarketSubscriptionDiff,
) -> Result<(), String> {
    if diff.is_noop() {
        return Ok(());
    }
    let symbols = diff
        .reference_counts
        .keys()
        .map(|subscription| subscription.symbol.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if update_public_subscriptions_in_place(runtime, &symbols)? {
        return Ok(());
    }
    restart_public_market_tasks(app.clone(), runtime.clone(), symbols)
}

/// Applies a subscription delta without reconnecting healthy sockets whenever
/// the existing shard count can still represent the new symbol set.
fn update_public_subscriptions_in_place(
    runtime: &MarketRuntime,
    symbols: &[String],
) -> Result<bool, String> {
    if symbols.is_empty() {
        return Ok(false);
    }
    let plan = public_stream_plan(symbols);
    let controls = runtime
        .public_controls
        .lock()
        .map_err(|error| error.to_string())?;
    if controls.is_empty()
        || !controls.contains_key("business-candles")
        || controls.len() != plan.len() + 1
    {
        return Ok(false);
    }
    for (stream_id, _, stream_symbols) in &plan {
        let Some(control) = controls.get(stream_id) else {
            return Ok(false);
        };
        if control.replace_symbols(stream_symbols.clone()).is_err() {
            return Ok(false);
        }
    }
    let Some(candle_control) = controls.get("business-candles") else {
        return Ok(false);
    };
    if candle_control.replace_symbols(symbols.to_vec()).is_err() {
        return Ok(false);
    }
    Ok(true)
}

fn restart_public_market_tasks(
    app: tauri::AppHandle,
    runtime: MarketRuntime,
    public_watchlist: Vec<String>,
) -> Result<(), String> {
    abort_public_market_tasks(&runtime)?;
    runtime
        .public_controls
        .lock()
        .map_err(|err| err.to_string())?
        .clear();
    if public_watchlist.is_empty() {
        return Ok(());
    }
    let app_handle = app.clone();
    let business_runtime = runtime.clone();
    let business_watchlist = public_watchlist.clone();
    let (business_control, business_commands) =
        PublicStreamControl::new(business_watchlist.clone());
    runtime
        .public_controls
        .lock()
        .map_err(|err| err.to_string())?
        .insert("business-candles".to_string(), business_control.clone());
    let business_task = tauri::async_runtime::spawn(async move {
        run_business_ws_reconnecting(
            app_handle,
            business_runtime,
            business_watchlist,
            business_control,
            business_commands,
        )
        .await;
    });

    let mut tasks = vec![business_task];
    for (connect_index, (stream_id, kind, symbols)) in public_stream_plan(&public_watchlist)
        .into_iter()
        .enumerate()
    {
        let app_handle = app.clone();
        let shard_runtime = runtime.clone();
        let (control, commands) = PublicStreamControl::new(symbols.clone());
        runtime
            .public_controls
            .lock()
            .map_err(|err| err.to_string())?
            .insert(stream_id.clone(), control.clone());
        tasks.push(tauri::async_runtime::spawn(async move {
            if connect_index > 0 {
                tokio::time::sleep(Duration::from_millis(
                    connect_index as u64 * PUBLIC_SHARD_CONNECT_STAGGER_MS,
                ))
                .await;
            }
            run_public_ws_reconnecting(
                app_handle,
                shard_runtime,
                stream_id,
                kind,
                symbols,
                control,
                commands,
            )
            .await;
        }));
    }
    *runtime.public_tasks.lock().map_err(|err| err.to_string())? = tasks;
    Ok(())
}

fn public_stream_plan(symbols: &[String]) -> Vec<(String, PublicStreamKind, Vec<String>)> {
    let mut plan = vec![(
        "public-meta".to_string(),
        PublicStreamKind::Meta,
        symbols.to_vec(),
    )];
    for (index, chunk) in symbols.chunks(PUBLIC_SHARD_SIZE).enumerate() {
        let shard = index + 1;
        plan.push((
            format!("public-books-{shard}"),
            PublicStreamKind::Books,
            chunk.to_vec(),
        ));
    }
    plan
}

#[tauri::command]
pub fn stop_market_stream(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, MarketRuntime>,
    session_id: Option<String>,
) -> Result<(), String> {
    let requested = normalize_market_consumer_id(session_id.as_deref(), "main-market")?;
    let diff = runtime
        .market_consumers
        .lock()
        .map_err(|err| err.to_string())?
        .remove(&requested);
    if runtime
        .public_session_id
        .lock()
        .map_err(|err| err.to_string())?
        .as_deref()
        == Some(requested.as_str())
    {
        *runtime
            .public_session_id
            .lock()
            .map_err(|err| err.to_string())? = None;
    }
    reconcile_public_market_consumers(&app, runtime.inner(), diff)
}

fn abort_public_market_tasks(runtime: &MarketRuntime) -> Result<(), String> {
    for task in runtime
        .public_tasks
        .lock()
        .map_err(|err| err.to_string())?
        .drain(..)
    {
        task.abort();
    }
    runtime
        .public_controls
        .lock()
        .map_err(|err| err.to_string())?
        .clear();
    Ok(())
}

#[tauri::command]
pub async fn reconcile_private_streams(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, MarketRuntime>,
) -> Result<(), String> {
    let desired = load_accounts_config(&app)?
        .accounts
        .into_iter()
        .filter(|account| account.exchange.eq_ignore_ascii_case("okx") && account.permissions.read)
        .map(|account| {
            (
                private_account_key(&account.id, &account.environment),
                account,
            )
        })
        .collect::<HashMap<_, _>>();

    let mut stopped_keys = Vec::new();
    {
        let fingerprints = runtime
            .private_account_fingerprints
            .lock()
            .map_err(|err| err.to_string())?;
        let mut tasks = runtime
            .private_tasks
            .lock()
            .map_err(|err| err.to_string())?;
        let existing_keys = tasks.keys().cloned().collect::<Vec<_>>();
        for key in existing_keys {
            let unchanged = desired.get(&key).is_some_and(|account| {
                fingerprints.get(&key) == Some(&private_account_fingerprint(account))
            });
            if !unchanged {
                if let Some(task) = tasks.remove(&key) {
                    task.abort();
                }
                stopped_keys.push(key);
            }
        }
    }

    if !stopped_keys.is_empty() {
        let mut trade = runtime.private_trade.lock().await;
        let mut store = runtime.store.lock().map_err(|err| err.to_string())?;
        for key in &stopped_keys {
            trade.remove(key);
            store.private_snapshots.remove(key);
        }
    }

    let mut started = Vec::new();
    {
        let tasks = runtime
            .private_tasks
            .lock()
            .map_err(|err| err.to_string())?;
        for (key, account) in desired {
            if !tasks.contains_key(&key) {
                let fingerprint = private_account_fingerprint(&account);
                started.push((key, fingerprint, account));
            }
        }
    }
    for (key, fingerprint, account) in started {
        let app_handle = app.clone();
        let private_runtime = runtime.inner().clone();
        let task = tauri::async_runtime::spawn(async move {
            run_private_ws_reconnecting(app_handle, private_runtime, account).await;
        });
        runtime
            .private_tasks
            .lock()
            .map_err(|err| err.to_string())?
            .insert(key.clone(), task);
        runtime
            .private_account_fingerprints
            .lock()
            .map_err(|err| err.to_string())?
            .insert(key.clone(), fingerprint);
    }

    let desired_keys = load_accounts_config(&app)?
        .accounts
        .into_iter()
        .filter(|account| account.exchange.eq_ignore_ascii_case("okx") && account.permissions.read)
        .map(|account| private_account_key(&account.id, &account.environment))
        .collect::<std::collections::HashSet<_>>();
    runtime
        .private_account_fingerprints
        .lock()
        .map_err(|err| err.to_string())?
        .retain(|key, _| desired_keys.contains(key));
    Ok(())
}

fn private_account_key(account_id: &str, environment: &str) -> String {
    format!("{}:{}", normalize_environment(environment), account_id)
}

fn private_account_fingerprint(account: &LocalAccount) -> String {
    let mut digest = Sha256::new();
    for value in [
        account.id.as_str(),
        account.environment.as_str(),
        account.api_key.as_str(),
        account.secret_key.as_str(),
        account.passphrase.as_str(),
        if account.permissions.read { "1" } else { "0" },
    ] {
        digest.update(value.as_bytes());
        digest.update([0]);
    }
    format!("{:x}", digest.finalize())
}

pub(crate) async fn connect_okx_ws(url: &str) -> Result<OkxWebSocket, String> {
    let proxy = load_proxy_config()?;
    if proxy.enabled && matches!(proxy.proxy_type.to_uppercase().as_str(), "HTTP" | "HTTPS") {
        return connect_okx_ws_via_http_proxy(url, &proxy).await;
    }
    connect_okx_ws_direct(url).await
}

async fn connect_okx_ws_direct(url: &str) -> Result<OkxWebSocket, String> {
    let (host, port) = okx_ws_host_port(url)?;
    let stream = timeout(
        WS_CONNECT_TIMEOUT,
        TcpStream::connect(format!("{host}:{port}")),
    )
    .await
    .map_err(|_| "WebSocket 直连超时".to_string())?
    .map_err(|err| format!("WebSocket 直连失败: {}", err))?;
    let connector = native_tls::TlsConnector::builder()
        .build()
        .map_err(|err| format!("WebSocket TLS 初始化失败: {}", err))?;
    let connector = tokio_native_tls::TlsConnector::from(connector);
    let tls = timeout(WS_CONNECT_TIMEOUT, connector.connect(&host, stream))
        .await
        .map_err(|_| "WebSocket TLS 握手超时".to_string())?
        .map_err(|err| format!("WebSocket TLS 握手失败: {}", err))?;
    let (socket, _) = timeout(
        WS_CONNECT_TIMEOUT,
        client_async(url, Box::new(tls) as BoxedIo),
    )
    .await
    .map_err(|_| "WebSocket 握手超时".to_string())?
    .map_err(|err| format!("WebSocket 握手失败: {}", err))?;
    Ok(socket)
}

async fn connect_okx_ws_via_http_proxy(
    url: &str,
    proxy: &ProxyConfig,
) -> Result<OkxWebSocket, String> {
    let (host, port) = okx_ws_host_port(url)?;
    let proxy_addr = format!("{}:{}", proxy.host.trim(), proxy.port);
    let mut stream = timeout(WS_CONNECT_TIMEOUT, TcpStream::connect(proxy_addr))
        .await
        .map_err(|_| "WebSocket 代理连接超时".to_string())?
        .map_err(|err| format!("WebSocket 代理连接失败: {}", err))?;
    let auth_header = proxy_authorization_header(proxy);
    let connect_request = format!(
        "CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\nProxy-Connection: Keep-Alive\r\n{auth_header}\r\n"
    );
    timeout(
        WS_CONNECT_TIMEOUT,
        stream.write_all(connect_request.as_bytes()),
    )
    .await
    .map_err(|_| "WebSocket 代理 CONNECT 发送超时".to_string())?
    .map_err(|err| format!("WebSocket 代理 CONNECT 发送失败: {}", err))?;
    let mut reader = BufReader::new(stream);
    let mut first_line = String::new();
    timeout(WS_CONNECT_TIMEOUT, reader.read_line(&mut first_line))
        .await
        .map_err(|_| "WebSocket 代理 CONNECT 响应超时".to_string())?
        .map_err(|err| format!("WebSocket 代理 CONNECT 响应失败: {}", err))?;
    if !first_line.contains(" 200 ") {
        return Err(format!(
            "WebSocket 代理 CONNECT 失败: {}",
            first_line.trim()
        ));
    }
    loop {
        let mut line = String::new();
        let read = timeout(WS_CONNECT_TIMEOUT, reader.read_line(&mut line))
            .await
            .map_err(|_| "WebSocket 代理 CONNECT header 读取超时".to_string())?
            .map_err(|err| format!("WebSocket 代理 CONNECT header 读取失败: {}", err))?;
        if read == 0 || line == "\r\n" || line == "\n" {
            break;
        }
    }
    let stream = reader.into_inner();
    let connector = native_tls::TlsConnector::builder()
        .build()
        .map_err(|err| format!("WebSocket TLS 初始化失败: {}", err))?;
    let connector = tokio_native_tls::TlsConnector::from(connector);
    let tls = timeout(WS_CONNECT_TIMEOUT, connector.connect(&host, stream))
        .await
        .map_err(|_| "WebSocket TLS 握手超时".to_string())?
        .map_err(|err| format!("WebSocket TLS 握手失败: {}", err))?;
    let (socket, _) = timeout(
        WS_CONNECT_TIMEOUT,
        client_async(url, Box::new(tls) as BoxedIo),
    )
    .await
    .map_err(|_| "WebSocket 握手超时".to_string())?
    .map_err(|err| format!("WebSocket 握手失败: {}", err))?;
    Ok(socket)
}

fn okx_ws_host_port(url: &str) -> Result<(String, u16), String> {
    let without_scheme = url
        .strip_prefix("wss://")
        .ok_or_else(|| format!("不支持的 WebSocket 地址: {}", url))?;
    let authority = without_scheme.split('/').next().unwrap_or_default();
    let mut parts = authority.split(':');
    let host = parts.next().unwrap_or_default().trim();
    if host.is_empty() {
        return Err(format!("WebSocket 地址缺少 host: {}", url));
    }
    let port = parts
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(443);
    Ok((host.to_string(), port))
}

async fn run_public_ws_reconnecting(
    app: tauri::AppHandle,
    runtime: MarketRuntime,
    stream_id: String,
    kind: PublicStreamKind,
    _symbols: Vec<String>,
    control: PublicStreamControl,
    mut commands: mpsc::UnboundedReceiver<PublicStreamCommand>,
) {
    let mut attempt: u32 = 0;
    loop {
        let symbols = control.symbols();
        emit_public_status(
            &app,
            &stream_id,
            kind,
            &symbols,
            if attempt == 0 {
                "connecting"
            } else {
                "reconnecting"
            },
            if attempt == 0 {
                format!("{} connecting", stream_id)
            } else {
                format!("{} reconnecting #{}", stream_id, attempt + 1)
            },
            attempt,
            None,
            None,
        );
        match run_public_ws(
            app.clone(),
            runtime.clone(),
            &stream_id,
            kind,
            symbols.clone(),
            &control,
            &mut commands,
        )
        .await
        {
            Ok(received_data) => {
                attempt = if received_data {
                    0
                } else {
                    attempt.saturating_add(1)
                };
                let delay = market_ws_backoff(attempt);
                emit_public_status(
                    &app,
                    &stream_id,
                    kind,
                    &symbols,
                    "reconnecting",
                    format!("{} closed, retry in {}s", stream_id, delay.as_secs()),
                    attempt,
                    None,
                    None,
                );
                tokio::time::sleep(delay).await;
            }
            Err(message) => {
                let delay = market_ws_backoff(attempt);
                emit_market(
                    &app,
                    MarketEvent::Error {
                        message: format!(
                            "{} WS: {}；{}s 后重连",
                            stream_id,
                            message,
                            delay.as_secs()
                        ),
                    },
                );
                emit_public_status(
                    &app,
                    &stream_id,
                    kind,
                    &symbols,
                    "reconnecting",
                    format!("{} error", stream_id),
                    attempt,
                    None,
                    None,
                );
                tokio::time::sleep(delay).await;
                attempt = attempt.saturating_add(1);
            }
        }
    }
}

async fn run_business_ws_reconnecting(
    app: tauri::AppHandle,
    runtime: MarketRuntime,
    _watchlist: Vec<String>,
    control: PublicStreamControl,
    mut commands: mpsc::UnboundedReceiver<PublicStreamCommand>,
) {
    let mut attempt: u32 = 0;
    loop {
        let watchlist = control.symbols();
        emit_market(
            &app,
            MarketEvent::Status {
                status: if attempt == 0 {
                    "business connecting".to_string()
                } else {
                    format!("business reconnecting #{}", attempt + 1)
                },
            },
        );
        match run_business_ws(
            app.clone(),
            runtime.clone(),
            watchlist.clone(),
            &control,
            &mut commands,
        )
        .await
        {
            Ok(received_data) => {
                attempt = if received_data {
                    0
                } else {
                    attempt.saturating_add(1)
                };
                let delay = market_ws_backoff(attempt);
                emit_market(
                    &app,
                    MarketEvent::Status {
                        status: format!("business closed, retry in {}s", delay.as_secs()),
                    },
                );
                tokio::time::sleep(delay).await;
            }
            Err(message) => {
                let delay = market_ws_backoff(attempt);
                emit_market(
                    &app,
                    MarketEvent::Error {
                        message: format!("business WS: {}；{}s 后重连", message, delay.as_secs()),
                    },
                );
                tokio::time::sleep(delay).await;
                attempt = attempt.saturating_add(1);
            }
        }
    }
}

async fn run_private_ws_reconnecting(
    app: tauri::AppHandle,
    runtime: MarketRuntime,
    account: LocalAccount,
) {
    let mut attempt: u32 = 0;
    let mut timestamp_retry_used = false;
    loop {
        emit_private_connection_status(
            &app,
            Some(&account),
            if attempt == 0 {
                "private connecting".to_string()
            } else {
                format!("private reconnecting #{}", attempt + 1)
            },
            if attempt == 0 {
                "connecting"
            } else {
                "reconnecting"
            },
            None,
            None,
            attempt,
            None,
        );
        match run_private_ws(app.clone(), runtime.clone(), account.clone()).await {
            Ok(received_data) => {
                timestamp_retry_used = false;
                attempt = if received_data {
                    0
                } else {
                    attempt.saturating_add(1)
                };
                let delay = market_ws_backoff(attempt);
                emit_private_connection_status(
                    &app,
                    Some(&account),
                    format!("private closed, retry in {}s", delay.as_secs()),
                    "reconnecting",
                    None,
                    None,
                    attempt,
                    None,
                );
                tokio::time::sleep(delay).await;
            }
            Err(message) => {
                if message.contains("50102") {
                    if timestamp_retry_used {
                        emit_private_connection_status(
                            &app,
                            Some(&account),
                            message,
                            "time_sync_failed",
                            None,
                            None,
                            attempt,
                            None,
                        );
                        break;
                    }
                    let observed_generation = OKX_CLOCK_SYNC_GENERATION.load(Ordering::Acquire);
                    match resync_okx_clock_after_timestamp_error(
                        "okx_private_ws_login",
                        "/users/self/verify",
                        observed_generation,
                    )
                    .await
                    {
                        Ok(()) => {
                            timestamp_retry_used = true;
                            emit_private_connection_status(
                                &app,
                                Some(&account),
                                "private WS 时间已重新校准，正在重连",
                                "reconnecting",
                                None,
                                None,
                                attempt,
                                None,
                            );
                            continue;
                        }
                        Err(error) => {
                            emit_private_connection_status(
                                &app,
                                Some(&account),
                                error,
                                "time_sync_failed",
                                None,
                                None,
                                attempt,
                                None,
                            );
                            break;
                        }
                    }
                }
                if message.starts_with("登录失败") {
                    emit_private_connection_status(
                        &app,
                        Some(&account),
                        message,
                        "auth_failed",
                        None,
                        None,
                        attempt,
                        None,
                    );
                    break;
                }
                let delay = market_ws_backoff(attempt);
                emit_private_connection_status(
                    &app,
                    Some(&account),
                    format!("private WS: {}；{}s 后重连", message, delay.as_secs()),
                    "reconnecting",
                    None,
                    None,
                    attempt,
                    None,
                );
                tokio::time::sleep(delay).await;
                attempt = attempt.saturating_add(1);
            }
        }
    }
}

fn market_ws_backoff(attempt: u32) -> Duration {
    let capped_exp = attempt.min(5);
    let base_ms = ((1_u64 << capped_exp).min(MARKET_WS_MAX_BACKOFF_SECS) * 1_000) as i64;
    let jitter_seed = now_ms().unsigned_abs() % 401;
    let jitter_percent = jitter_seed as i64 - 200;
    Duration::from_millis((base_ms + base_ms * jitter_percent / 1_000).max(250) as u64)
}

async fn run_public_ws(
    app: tauri::AppHandle,
    runtime: MarketRuntime,
    stream_id: &str,
    kind: PublicStreamKind,
    symbols: Vec<String>,
    control: &PublicStreamControl,
    commands: &mut mpsc::UnboundedReceiver<PublicStreamCommand>,
) -> Result<bool, String> {
    let mut symbols = symbols;
    let mut socket = connect_okx_ws(stream_endpoint(kind)).await?;
    if kind == PublicStreamKind::Books {
        for symbol in &symbols {
            clear_orderbook_state(&runtime, Some(symbol));
        }
    }
    emit_public_status(
        &app,
        stream_id,
        kind,
        &symbols,
        "ready",
        format!("{} connected", stream_id),
        0,
        Some(now_ms()),
        None,
    );
    let args = public_subscription_args(kind, &symbols);
    for chunk in args.chunks(80) {
        let subscribe = json!({
            "op": "subscribe",
            "args": chunk
        });
        socket
            .send(Message::Text(subscribe.to_string()))
            .await
            .map_err(|err| err.to_string())?;
    }

    let mut received_data = false;
    let connection_started = Instant::now();
    let mut last_received = Instant::now();
    let mut last_status_emit = Instant::now();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
    let mut render_tick = tokio::time::interval(Duration::from_millis(PUBLIC_RENDER_INTERVAL_MS));
    render_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut render_buffer = PublicRenderBuffer::default();
    let mut stale_data_messages = 0_u8;
    let mut last_data_received_at = now_ms();
    let mut data_recovery_started: Option<Instant> = None;
    loop {
        tokio::select! {
            message = socket.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    last_received = Instant::now();
                    if text != "pong" {
                        let delay_ms = public_message_delay_ms(&runtime, &text);
                        if let Some(message) = websocket_event_error(&text) {
                            return Err(message);
                        }
                        let has_payload = public_message_has_payload(&text);
                        if kind == PublicStreamKind::Books
                            && has_payload
                            && delay_ms.is_some_and(|delay| delay > PUBLIC_STALE_RECONNECT_DELAY_MS)
                        {
                            stale_data_messages = stale_data_messages.saturating_add(1);
                            if stale_data_messages >= PUBLIC_STALE_RECONNECT_MESSAGE_COUNT {
                                return Err(format!(
                                    "{} WS: 收到的数据已积压 {}ms，正在重连并丢弃陈旧帧",
                                    stream_id,
                                    delay_ms.unwrap_or_default()
                                ));
                            }
                        } else if has_payload && delay_ms.is_some() {
                            stale_data_messages = 0;
                        }
                        if let PublicMessageAction::Resubscribe(symbol) = handle_public_message(&app, &runtime, &text, &mut render_buffer) {
                            emit_market(&app, MarketEvent::Status { status: format!("{} {} resubscribing", stream_id, symbol) });
                            let arg = json!({ "channel": "books", "instId": symbol });
                            socket.send(Message::Text(json!({ "op": "unsubscribe", "args": [&arg] }).to_string())).await.map_err(|err| err.to_string())?;
                            clear_orderbook_state(&runtime, arg.get("instId").and_then(|item| item.as_str()));
                            socket.send(Message::Text(json!({ "op": "subscribe", "args": [arg] }).to_string())).await.map_err(|err| err.to_string())?;
                        }
                        let mut recovered_from_stale = false;
                        if has_payload {
                            received_data = true;
                            last_data_received_at = now_ms();
                            if kind == PublicStreamKind::Meta
                                && stale_public_meta_symbols(&runtime, &symbols).is_empty()
                            {
                                recovered_from_stale = data_recovery_started.take().is_some();
                            }
                        }
                        if has_payload
                            && (recovered_from_stale
                                || last_status_emit.elapsed() >= Duration::from_secs(1))
                        {
                            emit_public_status(&app, stream_id, kind, &symbols, "ready", format!("{} connected", stream_id), 0, Some(last_data_received_at), delay_ms);
                            last_status_emit = Instant::now();
                        }
                    }
                }
                Some(Ok(Message::Ping(payload))) => socket.send(Message::Pong(payload)).await.map_err(|err| err.to_string())?,
                Some(Ok(Message::Pong(_))) => last_received = Instant::now(),
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(err)) => return Err(err.to_string()),
            },
            _ = render_tick.tick() => flush_public_render_buffer(&app, &mut render_buffer),
            _ = heartbeat.tick() => {
                let idle = last_received.elapsed();
                if idle >= Duration::from_secs(35) {
                    return Err(format!("{} heartbeat timeout", stream_id));
                }
                if idle >= Duration::from_secs(20) {
                    socket.send(Message::Text("ping".to_string())).await.map_err(|err| err.to_string())?;
                }
                if kind == PublicStreamKind::Meta {
                    let stale_symbols = stale_public_meta_symbols(&runtime, &symbols);
                    if stale_symbols.is_empty() {
                        data_recovery_started = None;
                    } else {
                        match data_recovery_action(
                            connection_started.elapsed(),
                            data_recovery_started.map(|started| started.elapsed()),
                            Duration::from_millis(PUBLIC_META_TICKER_STALE_MS as u64),
                        ) {
                            DataRecoveryAction::None => {}
                            DataRecoveryAction::Resubscribe => {
                                let stale_delay_ms =
                                    public_ticker_max_delay_ms(&runtime, &stale_symbols);
                                emit_public_status(
                                    &app,
                                    stream_id,
                                    kind,
                                    &symbols,
                                    "stale",
                                    format!("{} ticker data stale, resubscribing", stream_id),
                                    0,
                                    Some(last_data_received_at),
                                    stale_delay_ms,
                                );
                                resubscribe_public_symbols(&mut socket, kind, &stale_symbols).await?;
                                data_recovery_started = Some(Instant::now());
                            }
                            DataRecoveryAction::Reconnect => {
                                return Err(format!(
                                    "{} ticker 数据重订阅后仍超时：{}",
                                    stream_id,
                                    stale_symbols.join(", ")
                                ));
                            }
                        }
                    }
                }
            },
            command = commands.recv() => {
                match command {
                    Some(PublicStreamCommand::RefreshSubscriptions) => {
                        let desired = control.symbols();
                        apply_public_subscription_delta(&mut socket, kind, &symbols, &desired).await?;
                        symbols = desired;
                        emit_public_status(&app, stream_id, kind, &symbols, "ready", format!("{} subscriptions updated", stream_id), 0, Some(last_data_received_at), None);
                    }
                    None => return Ok(received_data),
                }
            }
        }
    }
    emit_public_status(
        &app,
        stream_id,
        kind,
        &symbols,
        "stopped",
        format!("{} closed", stream_id),
        0,
        None,
        None,
    );
    Ok(received_data)
}

fn stream_endpoint(_kind: PublicStreamKind) -> &'static str {
    PUBLIC_WS
}

fn public_subscription_args(kind: PublicStreamKind, symbols: &[String]) -> Vec<serde_json::Value> {
    let mut args = Vec::new();
    for symbol in symbols {
        match kind {
            PublicStreamKind::Meta => {
                args.push(json!({ "channel": "tickers", "instId": symbol }));
                args.push(json!({ "channel": "funding-rate", "instId": symbol }));
                args.push(json!({ "channel": "trades", "instId": symbol }));
            }
            PublicStreamKind::Books => args.push(json!({ "channel": "books", "instId": symbol })),
        }
    }
    args
}

fn business_candle_subscription_args(symbols: &[String]) -> Vec<serde_json::Value> {
    symbols
        .iter()
        .flat_map(|symbol| {
            OKX_KLINE_BARS
                .iter()
                .map(move |bar| json!({ "channel": format!("candle{}", bar), "instId": symbol }))
        })
        .collect()
}

fn data_recovery_action(
    data_idle: Duration,
    recovery_elapsed: Option<Duration>,
    stale_after: Duration,
) -> DataRecoveryAction {
    if data_idle < stale_after {
        return DataRecoveryAction::None;
    }
    match recovery_elapsed {
        None => DataRecoveryAction::Resubscribe,
        Some(elapsed) if elapsed >= WS_DATA_RECOVERY_GRACE => DataRecoveryAction::Reconnect,
        Some(_) => DataRecoveryAction::None,
    }
}

fn public_message_has_payload(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|value| value.get("data").and_then(|data| data.as_array()).cloned())
        .is_some_and(|data| !data.is_empty())
}

fn business_message_has_candle_payload(text: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };
    let is_candle = value
        .get("arg")
        .and_then(|arg| arg.get("channel"))
        .and_then(|channel| channel.as_str())
        .is_some_and(|channel| channel.starts_with("candle"));
    is_candle
        && value
            .get("data")
            .and_then(|data| data.as_array())
            .is_some_and(|data| !data.is_empty())
}

fn public_meta_symbol_is_stale(
    okx_now: i64,
    ticker_time: Option<i64>,
    orderbook_time: Option<i64>,
) -> bool {
    let book_is_fresh = orderbook_time.is_some_and(|timestamp| {
        timestamp > 0 && okx_now.saturating_sub(timestamp).max(0) <= PUBLIC_META_BOOK_FRESH_MS
    });
    let ticker_is_stale = ticker_time.is_none_or(|timestamp| {
        timestamp <= 0 || okx_now.saturating_sub(timestamp).max(0) > PUBLIC_META_TICKER_STALE_MS
    });
    book_is_fresh && ticker_is_stale
}

fn stale_public_meta_symbols(runtime: &MarketRuntime, symbols: &[String]) -> Vec<String> {
    let okx_now = current_okx_now_ms(runtime);
    let Ok(store) = runtime.store.lock() else {
        return Vec::new();
    };
    symbols
        .iter()
        .filter(|symbol| {
            public_meta_symbol_is_stale(
                okx_now,
                store.tickers.get(*symbol).map(|ticker| ticker.ts),
                store.orderbooks.get(*symbol).map(|book| book.ts),
            )
        })
        .cloned()
        .collect()
}

fn public_ticker_max_delay_ms(runtime: &MarketRuntime, symbols: &[String]) -> Option<i64> {
    let okx_now = current_okx_now_ms(runtime);
    let store = runtime.store.lock().ok()?;
    symbols
        .iter()
        .filter_map(|symbol| store.tickers.get(symbol))
        .map(|ticker| okx_now.saturating_sub(ticker.ts).max(0))
        .max()
}

async fn resubscribe_public_symbols(
    socket: &mut OkxWebSocket,
    kind: PublicStreamKind,
    symbols: &[String],
) -> Result<(), String> {
    let args = public_subscription_args(kind, symbols);
    send_subscription_operation(socket, "unsubscribe", args.clone()).await?;
    send_subscription_operation(socket, "subscribe", args).await
}

async fn resubscribe_business_symbols(
    socket: &mut OkxWebSocket,
    symbols: &[String],
) -> Result<(), String> {
    let args = business_candle_subscription_args(symbols);
    send_subscription_operation(socket, "unsubscribe", args.clone()).await?;
    send_subscription_operation(socket, "subscribe", args).await
}

async fn send_subscription_operation(
    socket: &mut OkxWebSocket,
    operation: &str,
    args: Vec<serde_json::Value>,
) -> Result<(), String> {
    for chunk in args.chunks(80) {
        socket
            .send(Message::Text(
                json!({ "op": operation, "args": chunk }).to_string(),
            ))
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

async fn apply_public_subscription_delta(
    socket: &mut OkxWebSocket,
    kind: PublicStreamKind,
    current: &[String],
    desired: &[String],
) -> Result<(), String> {
    let current_set = current.iter().cloned().collect::<BTreeSet<_>>();
    let desired_set = desired.iter().cloned().collect::<BTreeSet<_>>();
    let removed = current_set
        .difference(&desired_set)
        .cloned()
        .collect::<Vec<_>>();
    let added = desired_set
        .difference(&current_set)
        .cloned()
        .collect::<Vec<_>>();
    if !removed.is_empty() {
        send_subscription_operation(
            socket,
            "unsubscribe",
            public_subscription_args(kind, &removed),
        )
        .await?;
    }
    if !added.is_empty() {
        send_subscription_operation(socket, "subscribe", public_subscription_args(kind, &added))
            .await?;
    }
    Ok(())
}

async fn apply_business_subscription_delta(
    socket: &mut OkxWebSocket,
    current: &[String],
    desired: &[String],
) -> Result<(), String> {
    let current_set = current.iter().cloned().collect::<BTreeSet<_>>();
    let desired_set = desired.iter().cloned().collect::<BTreeSet<_>>();
    let removed = current_set
        .difference(&desired_set)
        .cloned()
        .collect::<Vec<_>>();
    let added = desired_set
        .difference(&current_set)
        .cloned()
        .collect::<Vec<_>>();
    if !removed.is_empty() {
        send_subscription_operation(
            socket,
            "unsubscribe",
            business_candle_subscription_args(&removed),
        )
        .await?;
    }
    if !added.is_empty() {
        send_subscription_operation(
            socket,
            "subscribe",
            business_candle_subscription_args(&added),
        )
        .await?;
    }
    Ok(())
}

async fn run_business_ws(
    app: tauri::AppHandle,
    runtime: MarketRuntime,
    watchlist: Vec<String>,
    control: &PublicStreamControl,
    commands: &mut mpsc::UnboundedReceiver<PublicStreamCommand>,
) -> Result<bool, String> {
    let mut watchlist = watchlist;
    let mut socket = connect_okx_ws(BUSINESS_WS).await?;
    emit_market(
        &app,
        MarketEvent::Status {
            status: "business connected".to_string(),
        },
    );
    let args = business_candle_subscription_args(&watchlist);
    for chunk in args.chunks(80) {
        let subscribe = json!({
            "op": "subscribe",
            "args": chunk
        });
        socket
            .send(Message::Text(subscribe.to_string()))
            .await
            .map_err(|err| err.to_string())?;
    }

    let mut received_data = false;
    let mut last_received = Instant::now();
    let mut last_data_received = Instant::now();
    let mut data_recovery_started: Option<Instant> = None;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
    loop {
        tokio::select! {
            message = socket.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    last_received = Instant::now();
                    if text != "pong" {
                        if let Some(message) = websocket_event_error(&text) { return Err(message); }
                        let has_candle_payload = business_message_has_candle_payload(&text);
                        handle_business_message(&app, &runtime, &text);
                        if has_candle_payload {
                            received_data = true;
                            last_data_received = Instant::now();
                            if data_recovery_started.take().is_some() {
                                emit_market(&app, MarketEvent::Status { status: "business connected".to_string() });
                            }
                        }
                    }
                }
                Some(Ok(Message::Ping(payload))) => socket.send(Message::Pong(payload)).await.map_err(|err| err.to_string())?,
                Some(Ok(Message::Pong(_))) => last_received = Instant::now(),
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(err)) => return Err(err.to_string()),
            },
            _ = heartbeat.tick() => {
                let idle = last_received.elapsed();
                if idle >= Duration::from_secs(35) {
                    return Err("business WS heartbeat timeout".to_string());
                }
                if idle >= Duration::from_secs(20) {
                    socket.send(Message::Text("ping".to_string())).await.map_err(|err| err.to_string())?;
                }
                match data_recovery_action(
                    last_data_received.elapsed(),
                    data_recovery_started.map(|started| started.elapsed()),
                    BUSINESS_DATA_STALE_AFTER,
                ) {
                    DataRecoveryAction::None => {}
                    DataRecoveryAction::Resubscribe => {
                        emit_market(
                            &app,
                            MarketEvent::Status {
                                status: "business data stale, resubscribing".to_string(),
                            },
                        );
                        resubscribe_business_symbols(&mut socket, &watchlist).await?;
                        data_recovery_started = Some(Instant::now());
                    }
                    DataRecoveryAction::Reconnect => {
                        return Err("business K 线数据重订阅后仍超时".to_string());
                    }
                }
            },
            command = commands.recv() => {
                match command {
                    Some(PublicStreamCommand::RefreshSubscriptions) => {
                        let desired = control.symbols();
                        apply_business_subscription_delta(&mut socket, &watchlist, &desired).await?;
                        watchlist = desired;
                        emit_market(&app, MarketEvent::Status { status: "business candle subscriptions updated".to_string() });
                    }
                    None => return Ok(received_data),
                }
            }
        }
    }
    emit_market(
        &app,
        MarketEvent::Status {
            status: "business closed".to_string(),
        },
    );
    Ok(received_data)
}

async fn run_private_ws(
    app: tauri::AppHandle,
    runtime: MarketRuntime,
    account: LocalAccount,
) -> Result<bool, String> {
    let endpoint = if account.environment.eq_ignore_ascii_case("demo")
        || account.environment.eq_ignore_ascii_case("simulated")
    {
        PRIVATE_WS_DEMO
    } else {
        PRIVATE_WS
    };
    {
        let warm_runtime = runtime.clone();
        let warm_account = account.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = cached_okx_account_config(&warm_runtime, &warm_account).await {
                eprintln!(
                    "account config warmup failed account={} env={}: {}",
                    warm_account.id, warm_account.environment, error
                );
            }
        });
    }
    {
        let snapshot_app = app.clone();
        let snapshot_runtime = runtime.clone();
        let snapshot_account = account.clone();
        tauri::async_runtime::spawn(async move {
            match fetch_private_account_snapshot(&snapshot_account).await {
                Ok(snapshot) => update_private_snapshot(&snapshot_app, &snapshot_runtime, snapshot),
                Err(error) => eprintln!(
                    "private snapshot refresh failed account={} env={}: {}",
                    snapshot_account.id, snapshot_account.environment, error
                ),
            }
        });
    }

    let mut socket = connect_okx_ws(endpoint).await?;
    emit_private_connection_status(
        &app,
        Some(&account),
        "private connected",
        "authenticating",
        None,
        None,
        0,
        Some(now_ms()),
    );

    let login = private_ws_login_payload(&account)?;
    socket
        .send(Message::Text(login.to_string()))
        .await
        .map_err(|err| err.to_string())?;

    let mut received_data = false;
    let mut subscribed = false;
    let (command_tx, mut command_rx) = mpsc::unbounded_channel::<PrivateTradeCommand>();
    let session_key = private_account_key(&account.id, &account.environment);
    let mut ready = false;
    let mut pending_acks: HashMap<String, oneshot::Sender<Result<serde_json::Value, String>>> =
        HashMap::new();
    let mut last_received = Instant::now();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
    let session_result = loop {
        tokio::select! {
            message = socket.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    last_received = Instant::now();
                    if text == "pong" { continue; }
                    received_data = true;
                    match private_login_succeeded(&text) {
                        Ok(true) if !subscribed => {
                            let subscribe = json!({
                                "op": "subscribe",
                                "args": [
                                    { "channel": "balance_and_position" },
                                    { "channel": "account" },
                                    { "channel": "positions", "instType": "SWAP" },
                                    { "channel": "orders", "instType": "SWAP" }
                                ]
                            });
                            if let Err(err) = socket.send(Message::Text(subscribe.to_string())).await {
                                break Err(err.to_string());
                            }
                            subscribed = true;
                            emit_private_connection_status(&app, Some(&account), "private subscribing", "subscribing", None, None, 0, Some(now_ms()));
                            continue;
                        }
                        Err(err) => break Err(err),
                        _ => {}
                    }
                    if subscribed && !ready && private_subscription_succeeded(&text) {
                        runtime.private_trade.lock().await.insert(session_key.clone(), PrivateTradeSocketHandle {
                            account_id: account.id.clone(),
                            environment: account.environment.clone(),
                            sender: command_tx.clone(),
                        });
                        ready = true;
                        emit_private_connection_status(&app, Some(&account), "private subscribed", "ready", None, None, 0, Some(now_ms()));
                        continue;
                    }
                    if let Some(message) = websocket_event_error(&text) {
                        break Err(message);
                    }
                    if handle_private_trade_response(&text, &mut pending_acks) { continue; }
                    handle_private_message(&app, &runtime, &account, &text);
                }
                Some(Ok(Message::Ping(payload))) => {
                    if let Err(err) = socket.send(Message::Pong(payload)).await { break Err(err.to_string()); }
                }
                Some(Ok(Message::Pong(_))) => last_received = Instant::now(),
                Some(Ok(Message::Close(_))) | None => break Ok(received_data),
                Some(Ok(_)) => {}
                Some(Err(err)) => break Err(err.to_string()),
            },
            command = command_rx.recv() => match command {
                Some(command) => {
                    pending_acks.insert(command.message_id.clone(), command.ack);
                    if let Err(err) = socket.send(Message::Text(command.payload.to_string())).await {
                        break Err(err.to_string());
                    }
                }
                None => break Ok(received_data),
            },
            _ = heartbeat.tick() => {
                let idle = last_received.elapsed();
                if idle >= Duration::from_secs(35) { break Err("private WS heartbeat timeout".to_string()); }
                if idle >= Duration::from_secs(20) {
                    if let Err(err) = socket.send(Message::Text("ping".to_string())).await { break Err(err.to_string()); }
                }
            }
        }
    };
    {
        let mut guard = runtime.private_trade.lock().await;
        if guard.get(&session_key).is_some_and(|handle| {
            handle.account_id == account.id && handle.environment == account.environment
        }) {
            guard.remove(&session_key);
        }
    }
    for (_, ack) in pending_acks.drain() {
        let _ = ack.send(Err("private trade socket closed".to_string()));
    }
    emit_private_connection_status(
        &app,
        Some(&account),
        "private closed",
        "stopped",
        None,
        None,
        0,
        Some(now_ms()),
    );
    session_result
}

fn handle_private_trade_response(
    text: &str,
    pending_acks: &mut HashMap<String, oneshot::Sender<Result<serde_json::Value, String>>>,
) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };
    let Some(op) = value.get("op").and_then(|item| item.as_str()) else {
        return false;
    };
    if !matches!(
        op,
        "order"
            | "batch-orders"
            | "cancel-order"
            | "batch-cancel-orders"
            | "amend-order"
            | "batch-amend-orders"
    ) {
        return false;
    }
    let Some(id) = value.get("id").and_then(|item| item.as_str()) else {
        return false;
    };
    if let Some(ack) = pending_acks.remove(id) {
        let code = value
            .get("code")
            .and_then(|item| item.as_str())
            .unwrap_or("0");
        let msg = value
            .get("msg")
            .and_then(|item| item.as_str())
            .unwrap_or_default();
        if code == "0" {
            let _ = ack.send(Ok(value));
        } else {
            let _ = ack.send(Err(format_private_trade_ws_error(op, code, msg, &value)));
        }
        return true;
    }
    false
}

fn format_private_trade_ws_error(
    op: &str,
    code: &str,
    msg: &str,
    value: &serde_json::Value,
) -> String {
    let details = value
        .get("data")
        .and_then(|data| data.as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let s_code = item
                .get("sCode")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let s_msg = item
                .get("sMsg")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let ord_id = item
                .get("ordId")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let cl_ord_id = item
                .get("clOrdId")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            if s_code.is_empty() && s_msg.is_empty() {
                return None;
            }
            Some(format!(
                "sCode={} sMsg={} ordId={} clOrdId={}",
                s_code, s_msg, ord_id, cl_ord_id
            ))
        })
        .collect::<Vec<_>>();
    if details.is_empty() {
        format!("WS {} {} {}", op, code, msg).trim().to_string()
    } else if msg.trim().is_empty() {
        format!("WS {} {} {}", op, code, details.join("; "))
    } else {
        format!("WS {} {} {} {}", op, code, msg, details.join("; "))
    }
}

pub(crate) fn private_ws_login_payload(
    account: &LocalAccount,
) -> Result<serde_json::Value, String> {
    let timestamp = okx_ws_timestamp();
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

pub(crate) fn private_login_succeeded(text: &str) -> Result<bool, String> {
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
        .unwrap_or("登录失败");
    Err(format!("登录失败 {} {}", code, msg))
}

fn private_subscription_succeeded(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .is_some_and(|value| {
            value.get("event").and_then(|event| event.as_str()) == Some("subscribe")
        })
}

fn websocket_event_error(text: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(text).ok()?;
    if value.get("event").and_then(|event| event.as_str()) != Some("error") {
        return None;
    }
    let code = value
        .get("code")
        .and_then(|item| item.as_str())
        .unwrap_or_default();
    let message = value
        .get("msg")
        .and_then(|item| item.as_str())
        .unwrap_or("WebSocket event error");
    Some(format!("{} {}", code, message).trim().to_string())
}

pub async fn ensure_private_trade_socket(
    runtime: &MarketRuntime,
    account: &LocalAccount,
) -> Result<mpsc::UnboundedSender<PrivateTradeCommand>, String> {
    let guard = runtime.private_trade.lock().await;
    let key = private_account_key(&account.id, &account.environment);
    let Some(handle) = guard.get(&key) else {
        return Err("private trade socket unavailable".to_string());
    };
    if handle.account_id != account.id || handle.environment != account.environment {
        return Err("private trade socket account mismatch".to_string());
    }
    Ok(handle.sender.clone())
}

pub async fn send_private_trade_command(
    runtime: &MarketRuntime,
    account: &LocalAccount,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let sender = ensure_private_trade_socket(runtime, account).await?;
    let message_id = payload
        .get("id")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "private trade command missing id".to_string())?
        .to_string();
    let (ack_tx, ack_rx) = oneshot::channel();
    sender
        .send(PrivateTradeCommand {
            message_id,
            payload,
            ack: ack_tx,
        })
        .map_err(|_| "private trade socket sender closed".to_string())?;
    timeout(Duration::from_secs(8), ack_rx)
        .await
        .map_err(|_| "private trade command timeout".to_string())?
        .map_err(|_| "private trade command ack dropped".to_string())?
}

fn handle_public_message(
    app: &tauri::AppHandle,
    runtime: &MarketRuntime,
    text: &str,
    render_buffer: &mut PublicRenderBuffer,
) -> PublicMessageAction {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return PublicMessageAction::Continue;
    };
    if let Some(event) = value.get("event").and_then(|event| event.as_str()) {
        if event == "error" {
            let message = value
                .get("msg")
                .and_then(|msg| msg.as_str())
                .unwrap_or("public event error");
            emit_market(
                app,
                MarketEvent::Error {
                    message: message.to_string(),
                },
            );
            return PublicMessageAction::Continue;
        }
        return PublicMessageAction::Continue;
    }
    let channel = value
        .get("arg")
        .and_then(|arg| arg.get("channel"))
        .and_then(|channel| channel.as_str())
        .unwrap_or_default();
    let arg_inst_id = value
        .get("arg")
        .and_then(|arg| arg.get("instId"))
        .and_then(|item| item.as_str())
        .map(|item| item.to_string());
    let Some(data) = value.get("data").and_then(|data| data.as_array()) else {
        return PublicMessageAction::Continue;
    };

    match channel {
        "tickers" => {
            if let Some(raw) = data.first() {
                if let Ok(ticker) = serde_json::from_value::<Ticker>(raw.clone()) {
                    update_public_health(runtime, ticker.ts);
                    if let Ok(mut store) = runtime.store.lock() {
                        store.ticker = Some(ticker.clone());
                        store.tickers.insert(ticker.inst_id.clone(), ticker.clone());
                    }
                    process_chart_price_alerts(app, &ticker);
                    emit_market(app, MarketEvent::Ticker { ticker });
                }
            }
        }
        "books" | "books5" => {
            if let Some(raw) = data.first() {
                if let Some(book) = normalize_orderbook(raw) {
                    let inst_id = arg_inst_id
                        .clone()
                        .or_else(|| {
                            raw.get("instId")
                                .and_then(|item| item.as_str())
                                .map(|item| item.to_string())
                        })
                        .unwrap_or_default();
                    let action = value.get("action").and_then(|item| item.as_str());
                    update_public_health(runtime, book.ts);
                    if !orderbook_sequence_valid(runtime, &inst_id, raw, &book) {
                        clear_orderbook_state(runtime, Some(&inst_id));
                        emit_market(
                            app,
                            MarketEvent::Error {
                                message: format!(
                                    "{} 盘口序列断裂，已重订阅 {}",
                                    inst_id,
                                    book.seq_id.clone().unwrap_or_default()
                                ),
                            },
                        );
                        return PublicMessageAction::Resubscribe(inst_id);
                    }
                    match merge_and_cache_orderbook(runtime, &inst_id, raw, action, &book) {
                        Ok(Some(render_book)) => {
                            if public_render_event_is_fresh(runtime, render_book.ts) {
                                render_buffer.queue_book(inst_id, render_book);
                            }
                        }
                        Ok(None) => {}
                        Err(message) => {
                            clear_orderbook_state(runtime, Some(&inst_id));
                            emit_market(app, MarketEvent::Error { message });
                            return PublicMessageAction::Resubscribe(inst_id);
                        }
                    }
                }
            }
        }
        "trades" | "trades-all" => {
            let inst_id = arg_inst_id.clone().unwrap_or_default();
            for raw in data {
                if let Ok(trade) = serde_json::from_value::<Trade>(raw.clone()) {
                    update_public_health(runtime, trade.ts);
                    cache_trade(runtime, &inst_id, &trade);
                    if public_render_event_is_fresh(runtime, trade.ts) {
                        render_buffer.queue_trade(&inst_id, trade);
                    }
                }
            }
        }
        "funding-rate" => {
            if let Some(raw) = data.first() {
                if let Ok(funding) = serde_json::from_value::<FundingRate>(raw.clone()) {
                    let inst_id = if funding.inst_id.is_empty() {
                        arg_inst_id.clone().unwrap_or_default()
                    } else {
                        funding.inst_id.clone()
                    };
                    if !inst_id.is_empty() {
                        cache_funding_rate(runtime, &inst_id, &funding);
                    }
                    emit_market(app, MarketEvent::FundingRate { funding });
                }
            }
        }
        _ => {}
    }
    PublicMessageAction::Continue
}

fn public_render_event_is_fresh(runtime: &MarketRuntime, event_time_ms: i64) -> bool {
    current_okx_now_ms(runtime)
        .saturating_sub(event_time_ms)
        .max(0)
        <= PUBLIC_RENDER_MAX_DELAY_MS
}

fn flush_public_render_buffer(app: &tauri::AppHandle, buffer: &mut PublicRenderBuffer) {
    let order_books = std::mem::take(&mut buffer.books);
    let trades = std::mem::take(&mut buffer.trades);
    if !order_books.is_empty() || !trades.is_empty() {
        emit_market(
            app,
            MarketEvent::RenderBatch {
                order_books,
                trades,
            },
        );
    }
}

fn handle_private_message(
    app: &tauri::AppHandle,
    runtime: &MarketRuntime,
    account: &LocalAccount,
    text: &str,
) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return;
    };
    if let Some(event) = value.get("event").and_then(|event| event.as_str()) {
        if event == "error" {
            let msg = value
                .get("msg")
                .and_then(|msg| msg.as_str())
                .unwrap_or("private event error");
            emit_private_status(app, Some(account), msg, None, None);
        }
        return;
    }
    let channel = value
        .get("arg")
        .and_then(|arg| arg.get("channel"))
        .and_then(|channel| channel.as_str())
        .unwrap_or_default();
    let Some(data) = value.get("data").and_then(|data| data.as_array()) else {
        return;
    };
    let event_time_ms = data
        .iter()
        .filter_map(|item| private_message_timestamp(channel, item))
        .max()
        .filter(|ts| private_event_timestamp_is_recent(runtime, *ts));
    let delay_ms = event_time_ms.map(|ts| update_private_health(runtime, ts));
    let event_at = delay_ms.map(|_| current_okx_now_ms(runtime));
    emit_private_status(
        app,
        Some(account),
        format!("private data {}", channel),
        delay_ms,
        event_at,
    );
    match channel {
        "account" => merge_account_update(app, runtime, account, data),
        "balance_and_position" => merge_balance_position_update(app, runtime, account, data),
        "positions" => {
            let positions = data
                .iter()
                .filter_map(|raw| serde_json::from_value::<OkxPosition>(raw.clone()).ok())
                .filter(is_active_swap_position)
                .collect::<Vec<_>>();
            if !positions.is_empty() || !data.is_empty() {
                mutate_private_snapshot(app, runtime, account, |snapshot| {
                    snapshot.positions = positions;
                });
            }
        }
        "orders" => {
            let orders = data
                .iter()
                .filter_map(|raw| serde_json::from_value::<OkxPendingOrder>(raw.clone()).ok())
                .filter(|order| {
                    let state = order.state.to_ascii_lowercase();
                    is_terminal_pending_order_state(&state)
                        || !pending_order_is_cancelled(runtime, account, order)
                })
                .collect::<Vec<_>>();
            if let Err(error) = persist_private_order_updates(app, account, &orders) {
                emit_private_status(
                    app,
                    Some(account),
                    format!("private orders persist failed: {}", error),
                    None,
                    Some(now_ms()),
                );
            }
            for order in &orders {
                if !order.ord_id.is_empty() || !order.cl_ord_id.is_empty() {
                    emit_market(
                        app,
                        MarketEvent::PrivateOrder {
                            account_id: account.id.clone(),
                            environment: account.environment.clone(),
                            order: order.clone(),
                        },
                    );
                }
                let _ = crate::ai_automation::record_domain_event(
                    app,
                    &desic_agent_automation::DomainEvent {
                        event_type: "order_state_changed".to_string(),
                        account_id: Some(account.id.clone()),
                        inst_id: Some(order.inst_id.clone()),
                        state: Some(if order.state.trim().is_empty() {
                            "live".to_string()
                        } else {
                            order.state.clone()
                        }),
                        occurred_at: order
                            .u_time
                            .parse::<i64>()
                            .or_else(|_| order.c_time.parse::<i64>())
                            .unwrap_or_else(|_| now_ms()),
                        ..Default::default()
                    },
                    json!({
                        "ordId": order.ord_id,
                        "clOrdId": order.cl_ord_id,
                        "source": "private_wss"
                    }),
                );
            }
            mutate_private_snapshot(app, runtime, account, |snapshot| {
                for order in orders {
                    if order.ord_id.is_empty() {
                        continue;
                    }
                    let state = order.state.to_lowercase();
                    if matches!(
                        state.as_str(),
                        "filled" | "canceled" | "cancelled" | "failed"
                    ) {
                        snapshot.orders.retain(|item| item.ord_id != order.ord_id);
                    } else if let Some(existing) = snapshot
                        .orders
                        .iter_mut()
                        .find(|item| item.ord_id == order.ord_id)
                    {
                        *existing = order;
                    } else {
                        snapshot.orders.push(order);
                    }
                }
            });
        }
        _ => {}
    }
}

fn merge_account_update(
    app: &tauri::AppHandle,
    runtime: &MarketRuntime,
    account: &LocalAccount,
    data: &[serde_json::Value],
) {
    mutate_private_snapshot(app, runtime, account, |snapshot| {
        for item in data {
            if let Some(details) = item.get("details").and_then(|value| value.as_array()) {
                for raw_balance in details {
                    if let Ok(balance) = serde_json::from_value::<OkxBalance>(raw_balance.clone()) {
                        if balance.ccy.is_empty() {
                            continue;
                        }
                        if let Some(existing) = snapshot
                            .balances
                            .iter_mut()
                            .find(|item| item.ccy == balance.ccy)
                        {
                            *existing = balance;
                        } else {
                            snapshot.balances.push(balance);
                        }
                    }
                }
            }
        }
    });
}

fn merge_balance_position_update(
    app: &tauri::AppHandle,
    runtime: &MarketRuntime,
    account: &LocalAccount,
    data: &[serde_json::Value],
) {
    mutate_private_snapshot(app, runtime, account, |snapshot| {
        for item in data {
            if let Some(balances) = item.get("balData").and_then(|value| value.as_array()) {
                for raw_balance in balances {
                    if let Ok(balance) = serde_json::from_value::<OkxBalance>(raw_balance.clone()) {
                        if balance.ccy.is_empty() {
                            continue;
                        }
                        if let Some(existing) = snapshot
                            .balances
                            .iter_mut()
                            .find(|item| item.ccy == balance.ccy)
                        {
                            *existing = balance;
                        } else {
                            snapshot.balances.push(balance);
                        }
                    }
                }
            }
            if let Some(positions) = item.get("posData").and_then(|value| value.as_array()) {
                let mut next_positions = Vec::new();
                for raw_position in positions {
                    if let Ok(position) =
                        serde_json::from_value::<OkxPosition>(raw_position.clone())
                    {
                        if is_active_swap_position(&position) {
                            next_positions.push(position);
                        }
                    }
                }
                if !next_positions.is_empty() || !positions.is_empty() {
                    snapshot.positions = next_positions;
                }
            }
        }
    });
}

fn update_private_snapshot(
    app: &tauri::AppHandle,
    runtime: &MarketRuntime,
    mut snapshot: PrivateAccountSnapshot,
) {
    filter_cancelled_pending_orders(runtime, &mut snapshot);
    snapshot.synced_at = now_ms();
    if let Ok(mut store) = runtime.store.lock() {
        store.private_snapshot = Some(snapshot.clone());
        store.private_snapshots.insert(
            private_account_key(&snapshot.account_id, &snapshot.environment),
            snapshot.clone(),
        );
    }
    emit_market(app, MarketEvent::PrivateSnapshot { snapshot });
}

fn cancelled_pending_order_key(
    account_id: &str,
    environment: &str,
    kind: &str,
    identifier: &str,
) -> Option<String> {
    let identifier = identifier.trim();
    (!identifier.is_empty()).then(|| {
        format!(
            "{}\u{1f}{}:{}",
            private_account_key(account_id, environment),
            kind,
            identifier
        )
    })
}

fn pending_order_keys(account_id: &str, environment: &str, order: &OkxPendingOrder) -> Vec<String> {
    [
        ("order", order.ord_id.as_str()),
        ("client", order.cl_ord_id.as_str()),
        ("algo", order.algo_id.as_str()),
        ("algo-client", order.algo_cl_ord_id.as_str()),
    ]
    .into_iter()
    .filter_map(|(kind, identifier)| {
        cancelled_pending_order_key(account_id, environment, kind, identifier)
    })
    .collect()
}

fn cancel_target_keys(
    account: &LocalAccount,
    ord_id: &str,
    cl_ord_id: &str,
    is_algo: bool,
) -> Vec<String> {
    let kinds = if is_algo {
        [("algo", ord_id), ("algo-client", cl_ord_id)]
    } else {
        [("order", ord_id), ("client", cl_ord_id)]
    };
    kinds
        .into_iter()
        .filter_map(|(kind, identifier)| {
            cancelled_pending_order_key(&account.id, &account.environment, kind, identifier)
        })
        .collect()
}

fn prune_cancelled_pending_order_keys(store: &mut MarketStore, now: i64) {
    store
        .cancelled_pending_order_keys
        .retain(|_, expires_at| *expires_at > now);
}

fn is_terminal_pending_order_state(state: &str) -> bool {
    matches!(state, "filled" | "canceled" | "cancelled" | "failed")
}

fn pending_order_is_cancelled(
    runtime: &MarketRuntime,
    account: &LocalAccount,
    order: &OkxPendingOrder,
) -> bool {
    let Ok(mut store) = runtime.store.lock() else {
        return false;
    };
    prune_cancelled_pending_order_keys(&mut store, now_ms());
    pending_order_keys(&account.id, &account.environment, order)
        .iter()
        .any(|key| store.cancelled_pending_order_keys.contains_key(key))
}

/// Filters an incoming private snapshot against cancellations that were already
/// accepted by OKX. This keeps REST refreshes, private WSS events, the main
/// chart, and detached charts on the same authoritative order state.
pub(crate) fn filter_cancelled_pending_orders(
    runtime: &MarketRuntime,
    snapshot: &mut PrivateAccountSnapshot,
) {
    let Ok(mut store) = runtime.store.lock() else {
        return;
    };
    let now = now_ms();
    prune_cancelled_pending_order_keys(&mut store, now);
    let account_id = snapshot.account_id.clone();
    let environment = snapshot.environment.clone();
    snapshot.orders.retain(|order| {
        !pending_order_keys(&account_id, &environment, order)
            .iter()
            .any(|key| store.cancelled_pending_order_keys.contains_key(key))
    });
}

fn mutate_private_snapshot<F>(
    app: &tauri::AppHandle,
    runtime: &MarketRuntime,
    account: &LocalAccount,
    mutate: F,
) where
    F: FnOnce(&mut PrivateAccountSnapshot),
{
    let mut updated = None;
    if let Ok(mut store) = runtime.store.lock() {
        let key = private_account_key(&account.id, &account.environment);
        if let Some(snapshot) = store.private_snapshots.get_mut(&key) {
            mutate(snapshot);
            snapshot.synced_at = now_ms();
            updated = Some(snapshot.clone());
        }
        if let Some(snapshot) = updated.as_ref() {
            store.private_snapshot = Some(snapshot.clone());
        }
    }
    if let Some(snapshot) = updated {
        emit_market(app, MarketEvent::PrivateSnapshot { snapshot });
    }
}

/// A successful cancel response is authoritative for the local terminal. Remove
/// the target before the next REST poll so an older `orders-pending` response
/// cannot temporarily bring a cancelled order back into the UI.
pub(crate) fn remove_pending_order_from_snapshot(
    app: &tauri::AppHandle,
    runtime: &MarketRuntime,
    account: &LocalAccount,
    ord_id: &str,
    cl_ord_id: &str,
    is_algo: bool,
) {
    let ord_id = ord_id.trim();
    let cl_ord_id = cl_ord_id.trim();
    if ord_id.is_empty() && cl_ord_id.is_empty() {
        return;
    }
    if let Ok(mut store) = runtime.store.lock() {
        let expires_at = now_ms().saturating_add(CANCELLED_PENDING_ORDER_TOMBSTONE_TTL_MS);
        prune_cancelled_pending_order_keys(&mut store, now_ms());
        for key in cancel_target_keys(account, ord_id, cl_ord_id, is_algo) {
            store.cancelled_pending_order_keys.insert(key, expires_at);
        }
    }
    mutate_private_snapshot(app, runtime, account, |snapshot| {
        snapshot.orders.retain(|order| {
            let same_id = (!ord_id.is_empty()
                && if is_algo {
                    order.algo_id.trim() == ord_id
                } else {
                    order.ord_id.trim() == ord_id
                })
                || (!cl_ord_id.is_empty()
                    && if is_algo {
                        order.algo_cl_ord_id.trim() == cl_ord_id
                    } else {
                        order.cl_ord_id.trim() == cl_ord_id
                    });
            !same_id
        });
    });
}

fn handle_business_message(app: &tauri::AppHandle, runtime: &MarketRuntime, text: &str) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return;
    };
    let channel = value
        .get("arg")
        .and_then(|arg| arg.get("channel"))
        .and_then(|channel| channel.as_str())
        .unwrap_or_default();
    let Some(bar) = channel.strip_prefix("candle") else {
        return;
    };
    if !OKX_KLINE_BARS.contains(&bar) {
        return;
    }
    let Some(inst_id) = value
        .get("arg")
        .and_then(|arg| arg.get("instId"))
        .and_then(|item| item.as_str())
    else {
        return;
    };
    let Some(first) = value
        .get("data")
        .and_then(|data| data.as_array())
        .and_then(|items| items.first())
        .and_then(|row| row.as_array())
    else {
        return;
    };
    let row = first
        .iter()
        .map(|item| item.as_str().unwrap_or_default().to_string())
        .collect::<Vec<_>>();
    if let Some(raw_candle) = normalize_raw_candle(&row) {
        if let Ok(mut conn) = open_database(app) {
            let _ = upsert_raw_candles(&mut conn, inst_id, bar, &[raw_candle.clone()], "websocket");
        }
    }
    if let Some(candle) = normalize_candle(&row) {
        cache_candle(runtime, inst_id, bar, &candle);
        if candle.confirm {
            let alert_app = app.clone();
            let alert_inst_id = inst_id.to_string();
            let alert_candle = candle.clone();
            tauri::async_runtime::spawn_blocking(move || {
                process_chart_indicator_alerts(&alert_app, &alert_inst_id, &alert_candle);
            });
        }
        emit_market(
            app,
            MarketEvent::Candle {
                inst_id: inst_id.to_string(),
                bar: bar.to_string(),
                candle,
            },
        );
    }
}

fn cache_orderbook(runtime: &MarketRuntime, inst_id: &str, book: &OrderBook) {
    if let Ok(mut store) = runtime.store.lock() {
        if !inst_id.is_empty() {
            store.orderbooks.insert(inst_id.to_string(), book.clone());
            if let Some(seq_id) = book
                .seq_id
                .as_deref()
                .and_then(|value| value.parse::<i64>().ok())
            {
                store.orderbook_seq_ids.insert(inst_id.to_string(), seq_id);
            }
        }
        store.orderbook = Some(book.clone());
        store.orderbook_inst_id = if inst_id.is_empty() {
            None
        } else {
            Some(inst_id.to_string())
        };
        store.orderbook_seq_id = book
            .seq_id
            .as_deref()
            .and_then(|value| value.parse::<i64>().ok());
    }
}

fn merge_and_cache_orderbook(
    runtime: &MarketRuntime,
    inst_id: &str,
    raw: &serde_json::Value,
    action: Option<&str>,
    update: &OrderBook,
) -> Result<Option<OrderBook>, String> {
    let is_snapshot = action == Some("snapshot")
        || raw
            .get("prevSeqId")
            .and_then(json_i64)
            .map_or(true, |value| value <= 0);
    let previous = runtime.store.lock().ok().and_then(|store| {
        if inst_id.is_empty() {
            store.orderbook.clone()
        } else {
            store.orderbooks.get(inst_id).cloned()
        }
    });
    let merged = if is_snapshot {
        trim_orderbook(update.clone())
    } else if let Some(previous_book) = previous.clone() {
        merge_orderbook_update(previous_book, update)
    } else {
        return Ok(None);
    };
    if merged.bids.is_empty() || merged.asks.is_empty() {
        return Ok(None);
    }
    if !orderbook_checksum_valid(raw, &merged) {
        return Err(format!(
            "{} 盘口 checksum 校验失败，已重订阅 {}",
            inst_id,
            update.seq_id.clone().unwrap_or_default()
        ));
    }
    cache_orderbook(runtime, inst_id, &merged);
    if merged.bids.len() < MIN_RENDER_ORDERBOOK_LEVELS
        || merged.asks.len() < MIN_RENDER_ORDERBOOK_LEVELS
    {
        return Ok(previous);
    }
    Ok(Some(merged))
}

fn merge_orderbook_update(mut previous: OrderBook, update: &OrderBook) -> OrderBook {
    previous.bids = merge_orderbook_side(previous.bids, &update.bids, true);
    previous.asks = merge_orderbook_side(previous.asks, &update.asks, false);
    previous.ts = update.ts;
    previous.seq_id = update.seq_id.clone();
    trim_orderbook(previous)
}

fn merge_orderbook_side(
    mut levels: Vec<OrderBookLevel>,
    updates: &[OrderBookLevel],
    descending: bool,
) -> Vec<OrderBookLevel> {
    for update in updates {
        let size = update.sz.parse::<f64>().unwrap_or(0.0);
        if size <= 0.0 {
            levels.retain(|level| level.px != update.px);
        } else if let Some(level) = levels.iter_mut().find(|level| level.px == update.px) {
            *level = update.clone();
        } else {
            levels.push(update.clone());
        }
    }
    levels.sort_by(|left, right| {
        let left_px = left.px.parse::<f64>().unwrap_or(0.0);
        let right_px = right.px.parse::<f64>().unwrap_or(0.0);
        if descending {
            right_px
                .partial_cmp(&left_px)
                .unwrap_or(std::cmp::Ordering::Equal)
        } else {
            left_px
                .partial_cmp(&right_px)
                .unwrap_or(std::cmp::Ordering::Equal)
        }
    });
    levels.truncate(400);
    levels
}

fn trim_orderbook(mut book: OrderBook) -> OrderBook {
    book.bids
        .retain(|level| level.sz.parse::<f64>().unwrap_or(0.0) > 0.0);
    book.asks
        .retain(|level| level.sz.parse::<f64>().unwrap_or(0.0) > 0.0);
    book.bids.sort_by(|left, right| {
        let left_px = left.px.parse::<f64>().unwrap_or(0.0);
        let right_px = right.px.parse::<f64>().unwrap_or(0.0);
        right_px
            .partial_cmp(&left_px)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    book.asks.sort_by(|left, right| {
        let left_px = left.px.parse::<f64>().unwrap_or(0.0);
        let right_px = right.px.parse::<f64>().unwrap_or(0.0);
        left_px
            .partial_cmp(&right_px)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    book.bids.truncate(400);
    book.asks.truncate(400);
    book
}

fn orderbook_checksum_valid(raw: &serde_json::Value, book: &OrderBook) -> bool {
    let Some(expected) = raw_checksum(raw) else {
        return true;
    };
    if expected == 0 {
        return true;
    }
    orderbook_checksum(book) == expected
}

fn raw_checksum(raw: &serde_json::Value) -> Option<i32> {
    raw.get("checksum").and_then(|value| {
        value
            .as_i64()
            .and_then(|item| i32::try_from(item).ok())
            .or_else(|| value.as_str().and_then(|item| item.parse::<i32>().ok()))
    })
}

fn orderbook_checksum(book: &OrderBook) -> i32 {
    let mut parts = Vec::new();
    let depth = book.bids.len().max(book.asks.len()).min(25);
    for index in 0..depth {
        if let Some(level) = book.bids.get(index) {
            parts.push(level.px.as_str());
            parts.push(level.sz.as_str());
        }
        if let Some(level) = book.asks.get(index) {
            parts.push(level.px.as_str());
            parts.push(level.sz.as_str());
        }
    }
    crc32fast::hash(parts.join(":").as_bytes()) as i32
}

fn cache_trade(runtime: &MarketRuntime, inst_id: &str, trade: &Trade) {
    if let Ok(mut store) = runtime.store.lock() {
        if !inst_id.is_empty() {
            let bucket = store.trades_by_inst.entry(inst_id.to_string()).or_default();
            bucket.insert(0, trade.clone());
            bucket.truncate(200);
        }
        store.trades_inst_id = if inst_id.is_empty() {
            None
        } else {
            Some(inst_id.to_string())
        };
        store.trades.insert(0, trade.clone());
        store.trades.truncate(200);
    }
}

fn cache_candle(runtime: &MarketRuntime, inst_id: &str, bar: &str, candle: &Candle) {
    if let Ok(mut store) = runtime.store.lock() {
        let key = format!("{}:{}", inst_id, bar);
        let cached = store
            .candles
            .get(&key)
            .filter(|existing| existing.time == candle.time && existing.confirm && !candle.confirm)
            .cloned()
            .unwrap_or_else(|| candle.clone());
        store.candle = Some(cached.clone());
        store.candle_inst_id = Some(inst_id.to_string());
        store.candle_bar = Some(bar.to_string());
        store.candles.insert(key.clone(), cached.clone());
        let recent = store.recent_candles.entry(key).or_default();
        match recent.binary_search_by_key(&candle.time, |item| item.time) {
            Ok(index) => recent[index] = cached,
            Err(index) => recent.insert(index, cached),
        }
        if recent.len() > AI_CANDLE_MEMORY_LIMIT {
            recent.drain(..recent.len() - AI_CANDLE_MEMORY_LIMIT);
        }
    }
}

fn cache_funding_rate(runtime: &MarketRuntime, inst_id: &str, funding: &FundingRate) {
    if let Ok(mut store) = runtime.store.lock() {
        store
            .funding_rates
            .insert(inst_id.to_string(), funding.clone());
    }
}

fn normalize_orderbook(raw: &serde_json::Value) -> Option<OrderBook> {
    let bids = raw
        .get("bids")?
        .as_array()?
        .iter()
        .filter_map(normalize_level)
        .collect::<Vec<_>>();
    let asks = raw
        .get("asks")?
        .as_array()?
        .iter()
        .filter_map(normalize_level)
        .collect::<Vec<_>>();
    let ts = raw.get("ts")?.as_str()?.parse::<i64>().ok()?;
    let seq_id = raw
        .get("seqId")
        .and_then(json_i64)
        .map(|value| value.to_string());
    Some(OrderBook {
        bids,
        asks,
        ts,
        seq_id,
    })
}

fn orderbook_sequence_valid(
    runtime: &MarketRuntime,
    inst_id: &str,
    raw: &serde_json::Value,
    book: &OrderBook,
) -> bool {
    if book
        .seq_id
        .as_deref()
        .and_then(|value| value.parse::<i64>().ok())
        .is_none()
    {
        return true;
    }
    let prev_seq_id = raw.get("prevSeqId").and_then(json_i64);
    let previous = runtime.store.lock().ok().and_then(|store| {
        if inst_id.is_empty() {
            store.orderbook_seq_id
        } else {
            store.orderbook_seq_ids.get(inst_id).copied()
        }
    });
    if previous.is_none() || matches!(prev_seq_id, None | Some(-1) | Some(0)) {
        return true;
    }
    prev_seq_id == previous
}

fn json_i64(value: &serde_json::Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|item| item.parse::<i64>().ok()))
}

fn clear_orderbook_state(runtime: &MarketRuntime, inst_id: Option<&str>) {
    if let Ok(mut store) = runtime.store.lock() {
        if let Some(inst_id) = inst_id {
            store.orderbooks.remove(inst_id);
            store.orderbook_seq_ids.remove(inst_id);
            if store.orderbook_inst_id.as_deref() == Some(inst_id) {
                store.orderbook = None;
                store.orderbook_inst_id = None;
                store.orderbook_seq_id = None;
            }
        } else {
            store.orderbook = None;
            store.orderbook_inst_id = None;
            store.orderbook_seq_id = None;
            store.orderbooks.clear();
            store.orderbook_seq_ids.clear();
        }
    }
}

fn normalize_level(raw: &serde_json::Value) -> Option<OrderBookLevel> {
    let values = raw.as_array()?;
    Some(OrderBookLevel {
        px: values.get(0)?.as_str()?.to_string(),
        sz: values.get(1)?.as_str()?.to_string(),
        orders: values
            .get(3)
            .and_then(|value| value.as_str())
            .map(|value| value.to_string()),
    })
}

fn emit_market(app: &tauri::AppHandle, event: MarketEvent) {
    let _ = app.emit(MARKET_EVENT, event);
}

fn current_okx_now_ms(runtime: &MarketRuntime) -> i64 {
    let offset = if OKX_CLOCK_SYNC_GENERATION.load(Ordering::Acquire) > 0 {
        OKX_CLOCK_OFFSET_MS.load(Ordering::Acquire)
    } else {
        runtime
            .health
            .lock()
            .ok()
            .and_then(|health| health.clock_offset_ms)
            .unwrap_or_default()
    };
    now_ms().saturating_add(offset)
}

fn update_public_health(runtime: &MarketRuntime, event_time_ms: i64) -> i64 {
    let okx_now = current_okx_now_ms(runtime);
    let delay = okx_now.saturating_sub(event_time_ms).max(0);
    if let Ok(mut health) = runtime.health.lock() {
        health.public_event_time_ms = Some(event_time_ms);
        health.public_delay_ms = Some(delay);
        health.public_updated_at_ms = Some(now_ms());
    }
    delay
}

fn update_private_health(runtime: &MarketRuntime, event_time_ms: i64) -> i64 {
    let okx_now = current_okx_now_ms(runtime);
    let delay = okx_now.saturating_sub(event_time_ms).max(0);
    if let Ok(mut health) = runtime.health.lock() {
        health.private_event_time_ms = Some(event_time_ms);
        health.private_delay_ms = Some(delay);
        health.private_updated_at_ms = Some(now_ms());
    }
    delay
}

pub fn market_health_blockers(runtime: &MarketRuntime, environment: &str) -> Vec<String> {
    let _ = (runtime, environment);
    Vec::new()
}

fn emit_public_status<S: Into<String>>(
    app: &tauri::AppHandle,
    stream_id: &str,
    kind: PublicStreamKind,
    symbols: &[String],
    state: &str,
    status: S,
    reconnect_attempt: u32,
    last_received_at: Option<i64>,
    delay_ms: Option<i64>,
) {
    emit_market(
        app,
        MarketEvent::PublicStatus {
            stream_id: stream_id.to_string(),
            kind: kind.as_str().to_string(),
            state: state.to_string(),
            status: status.into(),
            symbols: symbols.to_vec(),
            event_at: now_ms(),
            last_received_at,
            delay_ms,
            reconnect_attempt,
        },
    );
}

pub fn emit_private_status<S: Into<String>>(
    app: &tauri::AppHandle,
    account: Option<&LocalAccount>,
    status: S,
    delay_ms: Option<i64>,
    event_at: Option<i64>,
) {
    let status = status.into();
    let state = private_state_from_status(&status);
    emit_private_connection_status(app, account, status, state, delay_ms, event_at, 0, event_at);
}

fn private_state_from_status(status: &str) -> &'static str {
    if status.contains("auth") || status.contains("登录失败") {
        "auth_failed"
    } else if status.contains("reconnect") || status.contains("retry") {
        "reconnecting"
    } else if status.contains("subscribed") || status.contains("data") {
        "ready"
    } else if status.contains("connected") {
        "authenticating"
    } else if status.contains("connecting") {
        "connecting"
    } else if status.contains("stale") {
        "stale"
    } else {
        "stopped"
    }
}

fn emit_private_connection_status<S: Into<String>>(
    app: &tauri::AppHandle,
    account: Option<&LocalAccount>,
    status: S,
    state: &str,
    delay_ms: Option<i64>,
    event_at: Option<i64>,
    reconnect_attempt: u32,
    last_received_at: Option<i64>,
) {
    emit_market(
        app,
        MarketEvent::PrivateStatus {
            status: status.into(),
            state: state.to_string(),
            account_id: account.map(|item| item.id.clone()),
            environment: account.map(|item| item.environment.clone()),
            delay_ms,
            event_at: event_at.unwrap_or_else(now_ms),
            reconnect_attempt,
            last_received_at,
        },
    );
}

fn private_message_timestamp(channel: &str, value: &serde_json::Value) -> Option<i64> {
    let timestamp_keys: &[&str] = if channel == "balance_and_position" {
        &["pTime", "ts", "uTime"]
    } else {
        &["uTime", "ts", "pTime"]
    };
    for key in timestamp_keys {
        if let Some(ts) = value.get(*key).and_then(|item| {
            item.as_str()
                .and_then(|text| text.parse::<i64>().ok())
                .or_else(|| item.as_i64())
        }) {
            return Some(ts);
        }
    }
    for nested_key in ["balData", "posData"] {
        if let Some(ts) = value
            .get(nested_key)
            .and_then(|item| item.as_array())
            .and_then(|items| {
                items
                    .iter()
                    .filter_map(|item| private_message_timestamp(channel, item))
                    .max()
            })
        {
            return Some(ts);
        }
    }
    None
}

fn private_event_timestamp_is_recent(runtime: &MarketRuntime, event_time_ms: i64) -> bool {
    let okx_now = current_okx_now_ms(runtime);
    event_time_ms >= okx_now.saturating_sub(5 * 60_000)
        && event_time_ms <= okx_now.saturating_add(60_000)
}

fn public_message_delay_ms(runtime: &MarketRuntime, text: &str) -> Option<i64> {
    let value = serde_json::from_str::<serde_json::Value>(text).ok()?;
    let timestamp = value
        .get("data")
        .and_then(|data| data.as_array())?
        .iter()
        .filter_map(public_message_timestamp)
        .max()?;
    Some(current_okx_now_ms(runtime).saturating_sub(timestamp).max(0))
}

fn public_message_timestamp(value: &serde_json::Value) -> Option<i64> {
    value.get("ts").and_then(|item| {
        item.as_str()
            .and_then(|text| text.parse::<i64>().ok())
            .or_else(|| item.as_i64())
    })
}

fn normalize_watchlist(watchlist: Option<Vec<String>>, active: &str) -> Vec<String> {
    let mut symbols = watchlist.unwrap_or_default();
    symbols.push(active.to_string());
    symbols.retain(|symbol| !symbol.trim().is_empty());
    symbols.sort();
    symbols.dedup();
    symbols
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_account(id: &str, environment: &str, api_key: &str) -> LocalAccount {
        LocalAccount {
            id: id.to_string(),
            name: id.to_string(),
            exchange: "okx".to_string(),
            environment: environment.to_string(),
            okx_uid: format!("placeholder-uid-{id}"),
            okx_main_uid: format!("placeholder-main-uid-{id}"),
            api_key: api_key.to_string(),
            secret_key: "TEST_SECRET_PLACEHOLDER".to_string(),
            passphrase: "TEST_PASSPHRASE_PLACEHOLDER".to_string(),
            permissions: Permissions {
                read: true,
                trade: true,
                withdraw: false,
            },
        }
    }

    #[test]
    fn private_account_keys_and_fingerprints_are_isolated() {
        let demo = test_account("account-a", "demo", "TEST_API_KEY_A");
        let live = test_account("account-a", "live", "TEST_API_KEY_A");
        let changed = test_account("account-a", "demo", "TEST_API_KEY_B");

        assert_ne!(
            private_account_key(&demo.id, &demo.environment),
            private_account_key(&live.id, &live.environment)
        );
        assert_ne!(
            private_account_fingerprint(&demo),
            private_account_fingerprint(&changed)
        );
        assert_eq!(
            private_account_fingerprint(&demo),
            private_account_fingerprint(&demo)
        );
    }

    #[test]
    fn cancelled_order_tombstone_filters_late_private_snapshots() {
        let runtime = MarketRuntime::default();
        let account = test_account("account-a", "demo", "TEST_API_KEY_A");
        let mut snapshot = PrivateAccountSnapshot {
            account_id: account.id.clone(),
            environment: account.environment.clone(),
            balances: Vec::new(),
            positions: Vec::new(),
            orders: vec![OkxPendingOrder {
                inst_id: "BTC-USDT-SWAP".to_string(),
                ord_id: "ordinary-order-1".to_string(),
                cl_ord_id: "client-order-1".to_string(),
                state: "live".to_string(),
                ..Default::default()
            }],
            synced_at: now_ms(),
        };
        let expires_at = now_ms().saturating_add(CANCELLED_PENDING_ORDER_TOMBSTONE_TTL_MS);
        let mut store = runtime.store.lock().expect("market store");
        for key in cancel_target_keys(&account, "ordinary-order-1", "client-order-1", false) {
            store.cancelled_pending_order_keys.insert(key, expires_at);
        }
        drop(store);

        filter_cancelled_pending_orders(&runtime, &mut snapshot);

        assert!(snapshot.orders.is_empty());
    }

    #[test]
    fn websocket_backoff_is_jittered_and_bounded() {
        for attempt in 0..20 {
            let delay = market_ws_backoff(attempt);
            assert!(delay >= Duration::from_millis(250));
            assert!(delay <= Duration::from_secs(MARKET_WS_MAX_BACKOFF_SECS + 3));
        }
    }

    #[test]
    fn data_recovery_resubscribes_before_reconnecting() {
        assert_eq!(
            data_recovery_action(Duration::from_secs(19), None, BUSINESS_DATA_STALE_AFTER,),
            DataRecoveryAction::None
        );
        assert_eq!(
            data_recovery_action(Duration::from_secs(20), None, BUSINESS_DATA_STALE_AFTER,),
            DataRecoveryAction::Resubscribe
        );
        assert_eq!(
            data_recovery_action(
                Duration::from_secs(30),
                Some(Duration::from_secs(9)),
                BUSINESS_DATA_STALE_AFTER,
            ),
            DataRecoveryAction::None
        );
        assert_eq!(
            data_recovery_action(
                Duration::from_secs(30),
                Some(WS_DATA_RECOVERY_GRACE),
                BUSINESS_DATA_STALE_AFTER,
            ),
            DataRecoveryAction::Reconnect
        );
    }

    #[test]
    fn meta_recovery_requires_a_fresh_book_and_stale_ticker() {
        let now = 100_000;
        assert!(public_meta_symbol_is_stale(
            now,
            Some(now - PUBLIC_META_TICKER_STALE_MS - 1),
            Some(now - PUBLIC_META_BOOK_FRESH_MS)
        ));
        assert!(public_meta_symbol_is_stale(
            now,
            None,
            Some(now - PUBLIC_META_BOOK_FRESH_MS)
        ));
        assert!(!public_meta_symbol_is_stale(
            now,
            Some(now - PUBLIC_META_TICKER_STALE_MS),
            Some(now - PUBLIC_META_BOOK_FRESH_MS)
        ));
        assert!(!public_meta_symbol_is_stale(
            now,
            Some(now - PUBLIC_META_TICKER_STALE_MS - 1),
            Some(now - PUBLIC_META_BOOK_FRESH_MS - 1)
        ));
    }

    #[test]
    fn websocket_liveness_only_counts_nonempty_business_payloads() {
        assert!(!public_message_has_payload("pong"));
        assert!(!public_message_has_payload(
            r#"{"event":"subscribe","arg":{"channel":"tickers"}}"#
        ));
        assert!(public_message_has_payload(
            r#"{"arg":{"channel":"tickers"},"data":[{"ts":"1000"}]}"#
        ));
        assert!(!business_message_has_candle_payload(
            r#"{"arg":{"channel":"tickers"},"data":[{"ts":"1000"}]}"#
        ));
        assert!(business_message_has_candle_payload(
            r#"{"arg":{"channel":"candle1m"},"data":[["1000"]]}"#
        ));
    }

    #[test]
    fn market_stream_plan_keeps_meta_shared_and_shards_books() {
        let symbols = (0..10)
            .map(|index| format!("COIN{index}-USDT-SWAP"))
            .collect::<Vec<_>>();
        let plan = public_stream_plan(&symbols);

        assert_eq!(plan.len(), 3);
        assert_eq!(plan[0].0, "public-meta");
        assert_eq!(plan[0].2.len(), 10);
        assert_eq!(
            plan.iter()
                .filter(|(_, kind, _)| *kind == PublicStreamKind::Books)
                .count(),
            2
        );
        assert!(plan
            .iter()
            .skip(1)
            .all(|(_, _, shard)| shard.len() <= PUBLIC_SHARD_SIZE));
    }

    #[test]
    fn public_stream_kinds_subscribe_only_their_owned_channels() {
        let symbols = vec!["BTC-USDT-SWAP".to_string(), "ETH-USDT-SWAP".to_string()];
        let meta = public_subscription_args(PublicStreamKind::Meta, &symbols);
        let books = public_subscription_args(PublicStreamKind::Books, &symbols);

        assert_eq!(meta.len(), 6);
        assert!(meta.iter().all(|arg| matches!(
            arg.get("channel").and_then(|item| item.as_str()),
            Some("tickers" | "funding-rate" | "trades")
        )));
        assert!(books
            .iter()
            .all(|arg| arg.get("channel").and_then(|item| item.as_str()) == Some("books")));
        assert_eq!(stream_endpoint(PublicStreamKind::Meta), PUBLIC_WS);
        assert_eq!(stream_endpoint(PublicStreamKind::Books), PUBLIC_WS);
    }

    #[test]
    fn private_delay_uses_push_time_and_ignores_historical_creation_time() {
        let balance = json!({
            "pTime": "2000000",
            "balData": [{ "uTime": "1900000", "cTime": "1000" }],
            "posData": [{ "uTime": "1800000", "cTime": "2000" }]
        });
        assert_eq!(
            private_message_timestamp("balance_and_position", &balance),
            Some(2_000_000)
        );

        let positions = vec![
            json!({ "uTime": "1900000", "cTime": "1000" }),
            json!({ "uTime": "1950000", "cTime": "2000" }),
        ];
        assert_eq!(
            positions
                .iter()
                .filter_map(|item| private_message_timestamp("positions", item))
                .max(),
            Some(1_950_000)
        );
        assert_eq!(
            private_message_timestamp("positions", &json!({ "cTime": "1000" })),
            None
        );
    }

    #[test]
    fn public_trade_timestamp_deserializes_from_okx_string() {
        let trade = serde_json::from_value::<Trade>(json!({
            "tradeId": "123",
            "px": "65000.1",
            "sz": "0.01",
            "side": "buy",
            "ts": "1784567000123"
        }))
        .expect("OKX trade payload");

        assert_eq!(trade.ts, 1_784_567_000_123);
    }

    #[tokio::test]
    async fn private_trade_socket_routes_by_account_and_environment() {
        let runtime = MarketRuntime::default();
        let demo = test_account("account-a", "demo", "TEST_API_KEY_A");
        let live = test_account("account-b", "live", "TEST_API_KEY_B");
        let (demo_tx, _demo_rx) = mpsc::unbounded_channel();
        let (live_tx, _live_rx) = mpsc::unbounded_channel();
        runtime.private_trade.lock().await.insert(
            private_account_key(&demo.id, &demo.environment),
            PrivateTradeSocketHandle {
                account_id: demo.id.clone(),
                environment: demo.environment.clone(),
                sender: demo_tx,
            },
        );
        runtime.private_trade.lock().await.insert(
            private_account_key(&live.id, &live.environment),
            PrivateTradeSocketHandle {
                account_id: live.id.clone(),
                environment: live.environment.clone(),
                sender: live_tx,
            },
        );

        assert!(ensure_private_trade_socket(&runtime, &demo).await.is_ok());
        assert!(ensure_private_trade_socket(&runtime, &live).await.is_ok());
        let missing = test_account("missing", "demo", "TEST_API_KEY_MISSING");
        assert!(ensure_private_trade_socket(&runtime, &missing)
            .await
            .is_err());
    }

    #[test]
    fn market_store_keeps_hot_data_per_symbol() {
        let runtime = MarketRuntime::default();
        let btc_book = OrderBook {
            bids: vec![OrderBookLevel {
                px: "100".to_string(),
                sz: "1".to_string(),
                orders: Some("1".to_string()),
            }],
            asks: vec![OrderBookLevel {
                px: "101".to_string(),
                sz: "2".to_string(),
                orders: Some("1".to_string()),
            }],
            ts: 1_000,
            seq_id: Some("10".to_string()),
        };
        let eth_book = OrderBook {
            bids: vec![OrderBookLevel {
                px: "200".to_string(),
                sz: "3".to_string(),
                orders: Some("1".to_string()),
            }],
            asks: vec![OrderBookLevel {
                px: "201".to_string(),
                sz: "4".to_string(),
                orders: Some("1".to_string()),
            }],
            ts: 2_000,
            seq_id: Some("20".to_string()),
        };
        cache_orderbook(&runtime, "BTC-USDT-SWAP", &btc_book);
        cache_orderbook(&runtime, "ETH-USDT-SWAP", &eth_book);

        for index in 0..205 {
            cache_trade(
                &runtime,
                "BTC-USDT-SWAP",
                &Trade {
                    trade_id: format!("t{index}"),
                    px: "100".to_string(),
                    sz: "1".to_string(),
                    side: "buy".to_string(),
                    ts: index,
                },
            );
        }
        cache_trade(
            &runtime,
            "ETH-USDT-SWAP",
            &Trade {
                trade_id: "eth".to_string(),
                px: "200".to_string(),
                sz: "1".to_string(),
                side: "sell".to_string(),
                ts: 300,
            },
        );
        cache_candle(
            &runtime,
            "ETH-USDT-SWAP",
            "5m",
            &Candle {
                time: 100,
                open: 1.0,
                high: 2.0,
                low: 0.5,
                close: 1.5,
                volume: 10.0,
                confirm: false,
            },
        );
        cache_candle(
            &runtime,
            "ETH-USDT-SWAP",
            "5m",
            &Candle {
                time: 100,
                open: 1.0,
                high: 2.1,
                low: 0.5,
                close: 1.6,
                volume: 11.0,
                confirm: true,
            },
        );
        cache_candle(
            &runtime,
            "ETH-USDT-SWAP",
            "5m",
            &Candle {
                time: 100,
                open: 1.0,
                high: 2.2,
                low: 0.5,
                close: 1.7,
                volume: 12.0,
                confirm: false,
            },
        );
        for index in 0..AI_CANDLE_MEMORY_LIMIT + 5 {
            cache_candle(
                &runtime,
                "BTC-USDT-SWAP",
                "1m",
                &Candle {
                    time: index as i64 * 60,
                    open: 100.0,
                    high: 101.0,
                    low: 99.0,
                    close: 100.0,
                    volume: 1.0,
                    confirm: true,
                },
            );
        }
        cache_funding_rate(
            &runtime,
            "BTC-USDT-SWAP",
            &FundingRate {
                inst_type: "SWAP".to_string(),
                inst_id: "BTC-USDT-SWAP".to_string(),
                funding_rate: "0.0001".to_string(),
                next_funding_rate: "0.0002".to_string(),
                funding_time: 1_000,
                next_funding_time: 2_000,
                method: "current_period".to_string(),
                ts: 900,
            },
        );

        let store = runtime.store.lock().expect("store lock");
        assert_eq!(
            store
                .orderbooks
                .get("BTC-USDT-SWAP")
                .and_then(|item| item.seq_id.as_deref()),
            Some("10")
        );
        assert_eq!(
            store
                .orderbooks
                .get("ETH-USDT-SWAP")
                .and_then(|item| item.seq_id.as_deref()),
            Some("20")
        );
        assert_eq!(
            store.trades_by_inst.get("BTC-USDT-SWAP").map(Vec::len),
            Some(200)
        );
        assert_eq!(
            store.trades_by_inst.get("ETH-USDT-SWAP").map(Vec::len),
            Some(1)
        );
        assert!(store.candles.contains_key("ETH-USDT-SWAP:5m"));
        let recent = store
            .recent_candles
            .get("ETH-USDT-SWAP:5m")
            .expect("recent candles");
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].close, 1.6);
        assert!(recent[0].confirm);
        let bounded = store
            .recent_candles
            .get("BTC-USDT-SWAP:1m")
            .expect("bounded recent candles");
        assert_eq!(bounded.len(), AI_CANDLE_MEMORY_LIMIT);
        assert_eq!(bounded.first().map(|item| item.time), Some(5 * 60));
        assert_eq!(
            store
                .funding_rates
                .get("BTC-USDT-SWAP")
                .map(|item| item.funding_rate.as_str()),
            Some("0.0001")
        );
    }

    #[test]
    fn public_render_buffer_keeps_latest_book_and_bounds_trades() {
        let mut buffer = PublicRenderBuffer::default();
        for index in 0..2 {
            buffer.queue_book(
                "BTC-USDT-SWAP".to_string(),
                OrderBook {
                    bids: Vec::new(),
                    asks: Vec::new(),
                    ts: index,
                    seq_id: Some(index.to_string()),
                },
            );
        }
        for index in 0..100 {
            buffer.queue_trade(
                "BTC-USDT-SWAP",
                Trade {
                    trade_id: format!("t{index}"),
                    px: "100".to_string(),
                    sz: "1".to_string(),
                    side: "buy".to_string(),
                    ts: index,
                },
            );
        }

        assert_eq!(
            buffer
                .books
                .get("BTC-USDT-SWAP")
                .and_then(|book| book.seq_id.as_deref()),
            Some("1")
        );
        let trades = buffer.trades.get("BTC-USDT-SWAP").expect("trade batch");
        assert_eq!(trades.len(), PUBLIC_RENDER_MAX_TRADES_PER_SYMBOL);
        assert_eq!(
            trades.first().map(|trade| trade.trade_id.as_str()),
            Some("t36")
        );
        assert_eq!(
            trades.last().map(|trade| trade.trade_id.as_str()),
            Some("t99")
        );
    }
}
