use super::*;
use crate::storage_config::load_watchlist_config_file;
use desic_intelligence::{
    attach_briefing_run, create_briefing, derivatives_overview_local, item_array, load_settings,
    normalize_item, query_anomalies_local, query_briefings_local, query_calendar_local,
    query_derivatives_local, query_news_event_detail_local, query_news_events_local,
    query_news_local, query_sentiment_local, query_smart_local, rebuild_news_events,
    recompute_derivative_anomalies, refresh_news_event_reactions, refresh_news_reactions,
    run_retention, save_news_content, save_settings, set_sync_state, set_tracked_trader, summary,
    sync_states, tracked_traders, upsert_derivatives_items, upsert_generic, upsert_news, value_f64,
    value_i64, value_string, BriefingQuery, CalendarQuery, DerivativesQuery, IntelligenceQuery,
    IntelligenceResponse, IntelligenceSeriesMetadata, IntelligenceSettings, IntelligenceSummary,
    IntelligenceSyncState, NewsEventQuery, SentimentQuery, SmartMoneyQuery, DERIVATIVES_SOURCE,
    DERIVATIVES_VERSION, LINEAR_SIGNAL_LIMITATION,
};
use reqwest::header::ACCEPT_LANGUAGE;
use std::sync::{
    atomic::{AtomicI64, AtomicU64},
    LazyLock,
};

const NEWS_SEARCH_PATH: &str = "/api/v5/orbit/news-search";
const INTELLIGENCE_RETENTION_INTERVAL_MS: i64 = 24 * 60 * 60_000;
static LAST_INTELLIGENCE_RETENTION_AT: AtomicI64 = AtomicI64::new(0);
const NEWS_DETAIL_PATH: &str = "/api/v5/orbit/news-detail";
const NEWS_DOMAINS_PATH: &str = "/api/v5/orbit/news-platform";
const SENTIMENT_QUERY_PATH: &str = "/api/v5/orbit/currency-sentiment-query";
const SENTIMENT_RANKING_PATH: &str = "/api/v5/orbit/currency-sentiment-ranking";
const ECONOMIC_CALENDAR_PATH: &str = "/api/v5/public/economic-calendar";
const ECONOMIC_CALENDAR_PAGE_LIMIT: usize = 100;
const ECONOMIC_CALENDAR_MAX_ITEMS: usize = 2_000;
const SMART_LEADERBOARD_PATH: &str = "/api/v5/orbit/public/leaderboard";
const SMART_POSITION_CURRENT_PATH: &str = "/api/v5/orbit/public/position-current";
const SMART_POSITION_HISTORY_PATH: &str = "/api/v5/orbit/public/position-history";
const SMART_TRADE_RECORDS_PATH: &str = "/api/v5/orbit/public/trade-records";
const SMART_TRADER_SEARCH_PATH: &str = "/api/v5/orbit/top-trader-search";
const SMART_OVERVIEW_PATH: &str = "/api/v5/journal/smartmoney/overview";
const SMART_SIGNAL_HISTORY_PATH: &str = "/api/v5/journal/smartmoney/signal-history";
const DERIVATIVES_OI_HISTORY_PATH: &str = "/api/v5/rubik/stat/contracts/open-interest-history";
const DERIVATIVES_TAKER_FLOW_PATH: &str = "/api/v5/rubik/stat/taker-volume-contract";
const DERIVATIVES_ACCOUNT_RATIO_PATH: &str =
    "/api/v5/rubik/stat/contracts/long-short-account-ratio-contract";
const DERIVATIVES_TOP_ACCOUNT_RATIO_PATH: &str =
    "/api/v5/rubik/stat/contracts/long-short-account-ratio-contract-top-trader";
const DERIVATIVES_TOP_POSITION_RATIO_PATH: &str =
    "/api/v5/rubik/stat/contracts/long-short-position-ratio-contract-top-trader";
const FUNDING_RATE_PATH: &str = "/api/v5/public/funding-rate";
const FUNDING_RATE_HISTORY_PATH: &str = "/api/v5/public/funding-rate-history";
const PREMIUM_HISTORY_PATH: &str = "/api/v5/public/premium-history";
const MARK_PRICE_PATH: &str = "/api/v5/public/mark-price";
const INDEX_TICKERS_PATH: &str = "/api/v5/market/index-tickers";
const MARKET_TICKER_PATH: &str = "/api/v5/market/ticker";
const LIQUIDATION_ORDERS_PATH: &str = "/api/v5/public/liquidation-orders";
const INSURANCE_FUND_PATH: &str = "/api/v5/public/insurance-fund";
const PRICE_LIMIT_PATH: &str = "/api/v5/public/price-limit";
const POSITION_TIERS_PATH: &str = "/api/v5/public/position-tiers";
const INTELLIGENCE_EVENT: &str = "intelligence:event";
const MAX_TOOL_ITEMS: usize = 100;
const MAX_TOOL_TEXT: usize = 12_000;
const INTELLIGENCE_REST_MAX_ATTEMPTS: u32 = 3;
const INTELLIGENCE_REST_RETRY_BASE_MS: u64 = 250;
static FETCH_LOG_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static PUBLIC_STATS_LAST_REQUEST: LazyLock<AsyncMutex<Option<Instant>>> =
    LazyLock::new(|| AsyncMutex::new(None));
static OI_STREAM_CACHE: LazyLock<std::sync::Mutex<HashMap<String, (i64, Value)>>> =
    LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));
static FUNDING_STREAM_CACHE: LazyLock<std::sync::Mutex<HashMap<String, (i64, String)>>> =
    LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

#[derive(Clone)]
pub(crate) struct IntelligenceRuntime {
    started: Arc<AtomicBool>,
    derivatives_stream_started: Arc<AtomicBool>,
    calendar_lock: Arc<AsyncMutex<Option<Instant>>>,
    refresh_inflight: Arc<AsyncMutex<HashSet<String>>>,
    refresh_slots: Arc<Semaphore>,
    active_instruments: Arc<std::sync::Mutex<HashMap<String, (i64, u8)>>>,
}

impl Default for IntelligenceRuntime {
    fn default() -> Self {
        Self {
            started: Arc::new(AtomicBool::new(false)),
            derivatives_stream_started: Arc::new(AtomicBool::new(false)),
            calendar_lock: Arc::new(AsyncMutex::new(None)),
            refresh_inflight: Arc::new(AsyncMutex::new(HashSet::new())),
            refresh_slots: Arc::new(Semaphore::new(3)),
            active_instruments: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActiveInstrumentRequest {
    pub inst_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceDetailRequest {
    pub account_id: Option<String>,
    pub id: String,
    pub language: Option<String>,
    #[serde(default)]
    pub local_only: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrackedTraderRequest {
    pub author_id: String,
    pub nickname: Option<String>,
    pub tracked: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SmartTraderDetailRequest {
    pub account_id: Option<String>,
    pub author_id: String,
    #[serde(default = "default_true")]
    pub include_order_history: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntelligenceSyncRequest {
    pub account_id: Option<String>,
    pub scope: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BriefingGenerateRequest {
    pub profile_id: String,
}

#[derive(Debug, Deserialize)]
struct RawOkxEnvelope {
    code: String,
    #[serde(default)]
    msg: String,
    #[serde(default)]
    data: Value,
    #[serde(default, rename = "dataVersion")]
    data_version: Option<String>,
}

fn open_intelligence_database(app: &tauri::AppHandle) -> Result<Connection, String> {
    open_database(app)
}

pub(crate) fn mark_active_instruments(runtime: &IntelligenceRuntime, symbols: &[String]) {
    mark_active_instruments_with_priority(runtime, symbols, 4);
}

fn mark_active_instruments_with_priority(
    runtime: &IntelligenceRuntime,
    symbols: &[String],
    priority: u8,
) {
    let now = now_ms();
    if let Ok(mut active) = runtime.active_instruments.lock() {
        active.retain(|_, (touched_at, _)| now.saturating_sub(*touched_at) < 30 * 60_000);
        for symbol in symbols {
            let symbol = symbol.trim().to_ascii_uppercase();
            if symbol.ends_with("-SWAP") && (symbol.contains("-USDT-") || symbol.contains("-USDS-"))
            {
                active
                    .entry(symbol)
                    .and_modify(|entry| {
                        entry.0 = now;
                        entry.1 = entry.1.max(priority);
                    })
                    .or_insert((now, priority));
            }
        }
    }
}

pub(crate) fn queue_active_intelligence_refresh(
    app: tauri::AppHandle,
    runtime: IntelligenceRuntime,
) {
    tauri::async_runtime::spawn(async move {
        let _ = sync_now_impl(
            &app,
            &runtime,
            IntelligenceSyncRequest {
                account_id: None,
                scope: Some("derivativesActive".to_string()),
            },
        )
        .await;
    });
}

#[tauri::command]
pub(crate) fn intelligence_mark_active_instrument(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, IntelligenceRuntime>,
    request: ActiveInstrumentRequest,
) -> Result<Value, String> {
    let inst_id = request.inst_id.trim().to_ascii_uppercase();
    if !inst_id.ends_with("-SWAP") || (!inst_id.contains("-USDT-") && !inst_id.contains("-USDS-")) {
        return Err("活跃情报标的必须是 USDT/USDS 永续合约".to_string());
    }
    mark_active_instruments_with_priority(runtime.inner(), std::slice::from_ref(&inst_id), 2);
    queue_active_intelligence_refresh(app, runtime.inner().clone());
    Ok(json!({
        "instId": inst_id,
        "activeUntil": now_ms().saturating_add(30 * 60_000),
    }))
}

async fn run_intelligence_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| format!("市场情报后台查询失败：{error}"))?
}

fn publish_anomaly_events(conn: &Connection, inst_id: &str, since: i64) -> Result<u64, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,kind,severity,bucket_at,raw_json FROM intelligence_anomalies
             WHERE inst_id=?1 AND bucket_at>=?2 ORDER BY bucket_at ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![inst_id, since], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut published = 0_u64;
    for row in rows {
        let (id, kind, severity, occurred_at, raw) = row.map_err(|error| error.to_string())?;
        let event_type = match kind.as_str() {
            "oi_change" => "open_interest_anomaly",
            "taker_imbalance" => "taker_flow_imbalance",
            "crowding_divergence" => "crowding_divergence",
            "funding_extreme" => "funding_extreme",
            "liquidation_cluster" => "liquidation_cluster",
            _ => continue,
        };
        let payload = serde_json::from_str(&raw).unwrap_or_else(|_| json!({ "anomalyId": id }));
        if crate::ai_automation::record_domain_event_once_with_conn(
            conn,
            &id,
            &desic_agent_automation::DomainEvent {
                event_type: event_type.to_string(),
                account_id: None,
                inst_id: Some(inst_id.to_string()),
                opportunity_id: None,
                episode_id: None,
                state: Some(severity),
                occurred_at,
            },
            payload,
        )? {
            published = published.saturating_add(1);
        }
    }
    Ok(published)
}

fn publish_important_news_events(conn: &Connection, since: i64) -> Result<u64, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,coins_json,last_published_at,raw_json FROM intelligence_news_events
             WHERE last_published_at>=?1 AND (importance IN ('high','3') OR status='confirmed')",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![since], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut published = 0_u64;
    for row in rows {
        let (id, coins_raw, occurred_at, raw) = row.map_err(|error| error.to_string())?;
        let coins = serde_json::from_str::<Vec<String>>(&coins_raw).unwrap_or_default();
        let inst_id = coins
            .first()
            .map(|coin| format!("{}-USDT-SWAP", coin.to_ascii_uppercase()));
        let payload = serde_json::from_str(&raw).unwrap_or_else(|_| json!({ "eventId": id }));
        if crate::ai_automation::record_domain_event_once_with_conn(
            conn,
            &id,
            &desic_agent_automation::DomainEvent {
                event_type: "important_news_event".to_string(),
                account_id: None,
                inst_id,
                opportunity_id: None,
                episode_id: None,
                state: Some("new".to_string()),
                occurred_at,
            },
            payload,
        )? {
            published = published.saturating_add(1);
        }
    }
    Ok(published)
}

fn publish_intelligence_event_once(
    conn: &Connection,
    source_id: &str,
    event_type: &str,
    inst_id: Option<String>,
    state: &str,
    occurred_at: i64,
    payload: Value,
) -> Result<bool, String> {
    crate::ai_automation::record_domain_event_once_with_conn(
        conn,
        source_id,
        &desic_agent_automation::DomainEvent {
            event_type: event_type.to_string(),
            account_id: None,
            inst_id,
            opportunity_id: None,
            episode_id: None,
            state: Some(state.to_string()),
            occurred_at,
        },
        payload,
    )
}

fn sentiment_score(value: &Value) -> Option<f64> {
    let bullish = value_f64(value, &["bullishRatio", "positiveRatio"])?;
    let bearish = value_f64(value, &["bearishRatio", "negativeRatio"]).unwrap_or(1.0 - bullish);
    Some(bullish - bearish)
}

fn latest_local_sentiment(conn: &Connection, ccy: &str) -> Option<Value> {
    conn.query_row(
        "SELECT raw_json FROM intelligence_coin_sentiment WHERE ccy=?1 ORDER BY bucket_at DESC LIMIT 1",
        params![ccy],
        |row| row.get::<_, String>(0),
    ).optional().ok().flatten().and_then(|raw| serde_json::from_str(&raw).ok())
}

fn publish_sentiment_reversals(
    conn: &Connection,
    previous: &HashMap<String, Value>,
    items: &[Value],
    now: i64,
) -> Result<u64, String> {
    let mut latest = HashMap::<String, &Value>::new();
    for item in items {
        let Some(ccy) = value_string(item, &["ccy", "symbol", "coin"]) else {
            continue;
        };
        let replace = latest
            .get(&ccy)
            .map(|current| {
                value_i64(item, &["ts", "time", "bucketAt", "dataTime"]).unwrap_or(now)
                    > value_i64(current, &["ts", "time", "bucketAt", "dataTime"]).unwrap_or(0)
            })
            .unwrap_or(true);
        if replace {
            latest.insert(ccy, item);
        }
    }
    let mut published = 0_u64;
    for (ccy, current) in latest {
        let Some(before) = previous.get(&ccy).and_then(sentiment_score) else {
            continue;
        };
        let Some(after) = sentiment_score(current) else {
            continue;
        };
        if before.signum() == after.signum() || (after - before).abs() < 0.20 {
            continue;
        }
        let source_id = desic_intelligence::stable_id(
            "sentiment-reversal",
            &json!({"ccy": ccy, "bucket": now / 900_000}),
        );
        if publish_intelligence_event_once(
            conn,
            &source_id,
            "sentiment_reversal",
            Some(format!("{}-USDT-SWAP", ccy.to_ascii_uppercase())),
            if after > 0.0 { "bullish" } else { "bearish" },
            now,
            json!({"ccy": ccy, "previousScore": before, "currentScore": after, "record": current}),
        )? {
            published = published.saturating_add(1);
        }
    }
    Ok(published)
}

fn publish_macro_windows(conn: &Connection, items: &[Value], now: i64) -> Result<u64, String> {
    let mut published = 0_u64;
    for item in items {
        let Some(event_at) = value_i64(item, &["eventTime", "ts", "time", "date"]) else {
            continue;
        };
        let importance = value_string(item, &["importance", "level"]).unwrap_or_default();
        if event_at < now
            || event_at > now.saturating_add(30 * 60_000)
            || !matches!(importance.as_str(), "3" | "high" | "High")
        {
            continue;
        }
        let source_id = desic_intelligence::stable_id("macro-window", item);
        if publish_intelligence_event_once(
            conn,
            &source_id,
            "macro_event_window",
            None,
            "upcoming",
            event_at,
            item.clone(),
        )? {
            published = published.saturating_add(1);
        }
    }
    Ok(published)
}

fn latest_local_smart_signal(conn: &Connection, ccy: &str) -> Option<Value> {
    conn.query_row(
        "SELECT raw_json FROM intelligence_smart_signals WHERE inst_ccy=?1 ORDER BY fetched_at DESC LIMIT 1",
        params![ccy],
        |row| row.get::<_, String>(0),
    ).optional().ok().flatten().and_then(|raw| serde_json::from_str(&raw).ok())
}

fn publish_smart_money_changes(
    conn: &Connection,
    previous: &HashMap<String, Value>,
    items: &[Value],
    now: i64,
) -> Result<u64, String> {
    let mut published = 0_u64;
    for item in items {
        let Some(ccy) = value_string(item, &["instCcy", "ccy", "symbol"]) else {
            continue;
        };
        let Some(before) = previous.get(&ccy) else {
            continue;
        };
        let before_ratio = value_f64(before, &["weightedLongRatio", "longRatio"]);
        let after_ratio = value_f64(item, &["weightedLongRatio", "longRatio"]);
        let before_notional = value_f64(before, &["netNotionalUsdt", "netNotional"]);
        let after_notional = value_f64(item, &["netNotionalUsdt", "netNotional"]);
        let ratio_changed = before_ratio
            .zip(after_ratio)
            .is_some_and(|(left, right)| (right - left).abs() >= 0.10);
        let side_changed = before_notional
            .zip(after_notional)
            .is_some_and(|(left, right)| left.signum() != right.signum() && right.abs() > 0.0);
        if !ratio_changed && !side_changed {
            continue;
        }
        let source_id = desic_intelligence::stable_id(
            "smart-money-change",
            &json!({"ccy": ccy, "bucket": now / 900_000}),
        );
        if publish_intelligence_event_once(
            conn,
            &source_id,
            "smart_money_change",
            Some(format!("{}-USDT-SWAP", ccy.to_ascii_uppercase())),
            if side_changed {
                "side_changed"
            } else {
                "ratio_changed"
            },
            now,
            json!({"ccy": ccy, "previous": before, "current": item}),
        )? {
            published = published.saturating_add(1);
        }
    }
    Ok(published)
}

fn validate_intelligence_account(account: LocalAccount) -> Result<LocalAccount, String> {
    if !account.exchange.eq_ignore_ascii_case("okx") {
        return Err("市场情报只支持 OKX 账户".to_string());
    }
    if !account.environment.eq_ignore_ascii_case("live") {
        return Err("OKX 新闻与聪明钱不支持模拟盘，请选择实盘只读账户".to_string());
    }
    if !account.permissions.read {
        return Err("账户未开启读取权限，无法访问 OKX 市场情报".to_string());
    }
    if account.api_key.trim().is_empty()
        || account.secret_key.trim().is_empty()
        || account.passphrase.trim().is_empty()
    {
        return Err("账户凭据不完整，无法访问 OKX 市场情报".to_string());
    }
    Ok(account)
}

fn resolve_intelligence_account(
    accounts: &[LocalAccount],
    preferred_id: Option<&str>,
) -> Result<LocalAccount, String> {
    if let Some(preferred_id) = preferred_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let account = accounts
            .iter()
            .find(|account| account.id == preferred_id)
            .cloned()
            .ok_or_else(|| format!("account {} not found", preferred_id))?;
        return validate_intelligence_account(account);
    }

    let mut first_error = None;
    for account in accounts.iter().cloned() {
        match validate_intelligence_account(account) {
            Ok(account) => return Ok(account),
            Err(error) if first_error.is_none() => first_error = Some(error),
            Err(_) => {}
        }
    }
    Err(first_error.unwrap_or_else(|| "尚未配置可用于市场情报的 OKX 实盘只读账户".to_string()))
}

fn reconcile_intelligence_settings(
    app: &tauri::AppHandle,
    conn: &Connection,
) -> Result<IntelligenceSettings, String> {
    let mut settings = load_settings(conn)?;
    let accounts = load_accounts_config(app)?.accounts;
    let resolved = settings
        .collector_account_id
        .as_deref()
        .and_then(|account_id| {
            resolve_intelligence_account(&accounts, Some(account_id))
                .ok()
                .map(|account| account.id)
        });
    if settings.collector_account_id != resolved {
        settings.collector_account_id = resolved;
        settings = save_settings(conn, settings, now_ms())?;
    }
    Ok(settings)
}

fn intelligence_account(
    app: &tauri::AppHandle,
    requested: Option<&str>,
) -> Result<LocalAccount, String> {
    let conn = open_intelligence_database(app)?;
    let settings = reconcile_intelligence_settings(app, &conn)?;
    let accounts = load_accounts_config(app)?.accounts;
    resolve_intelligence_account(
        &accounts,
        requested
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or(settings.collector_account_id.as_deref()),
    )
}

fn query_path(base: &str, params: Vec<(&str, Option<String>)>) -> String {
    let query = params
        .into_iter()
        .filter_map(|(key, value)| {
            value
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .map(|value| format!("{}={}", url_encode(key), url_encode(&value)))
        })
        .collect::<Vec<_>>()
        .join("&");
    if query.is_empty() {
        base.to_string()
    } else {
        format!("{base}?{query}")
    }
}

fn csv_values(values: Option<&Vec<String>>) -> Option<String> {
    let values = values?
        .iter()
        .map(|value| value.trim().to_ascii_uppercase())
        .filter(|value| !value.is_empty())
        .take(50)
        .collect::<Vec<_>>();
    if values.is_empty() {
        None
    } else {
        Some(values.join(","))
    }
}

async fn intelligence_private_get(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    path: &str,
    language: Option<&str>,
) -> Result<RawOkxEnvelope, String> {
    let url = format!("{}{}", REST_BASE, path);
    let client = reqwest_client()?;
    let language = language
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let mut last_error = None;
    let mut timestamp_retry_used = false;
    for attempt in 0..INTELLIGENCE_REST_MAX_ATTEMPTS {
        let observed_generation = OKX_CLOCK_SYNC_GENERATION.load(Ordering::Acquire);
        let timestamp = okx_rest_timestamp()?;
        let mut headers = okx_private_headers(account, &timestamp, "GET", path, "")?;
        if let Some(language) = language.as_deref() {
            headers.insert(
                ACCEPT_LANGUAGE,
                HeaderValue::from_str(language).map_err(|error| error.to_string())?,
            );
        }

        let response = match client.get(&url).headers(headers).send().await {
            Ok(response) => response,
            Err(error) => {
                let retryable = reqwest_error_retryable(&error);
                let classified = classify_reqwest_error("OKX Intelligence REST", path, &error);
                if retryable && attempt + 1 < INTELLIGENCE_REST_MAX_ATTEMPTS {
                    last_error = Some(classified);
                    sleep(intelligence_rest_retry_delay(attempt)).await;
                    continue;
                }
                return Err(classified);
            }
        };
        let status = response.status();
        let text = match response.text().await {
            Ok(text) => text,
            Err(error) => {
                let retryable = reqwest_error_retryable(&error);
                let classified = classify_reqwest_error("OKX Intelligence REST", path, &error);
                if retryable && attempt + 1 < INTELLIGENCE_REST_MAX_ATTEMPTS {
                    last_error = Some(classified);
                    sleep(intelligence_rest_retry_delay(attempt)).await;
                    continue;
                }
                return Err(classified);
            }
        };
        if !timestamp_retry_used && okx_timestamp_error(&text) {
            resync_okx_clock_after_timestamp_error(
                "okx_intelligence_get",
                path,
                observed_generation,
            )
            .await?;
            timestamp_retry_used = true;
            continue;
        }
        if !status.is_success() {
            let sanitized = sanitize_secret(
                &sanitize_secret(
                    &sanitize_secret(&text, &account.api_key),
                    &account.secret_key,
                ),
                &account.passphrase,
            );
            let error = format!("OKX Intelligence HTTP {status}: {sanitized}");
            if intelligence_http_status_retryable(status.as_u16())
                && attempt + 1 < INTELLIGENCE_REST_MAX_ATTEMPTS
            {
                last_error = Some(error);
                sleep(intelligence_rest_retry_delay(attempt)).await;
                continue;
            }
            return Err(error);
        }
        let envelope = serde_json::from_str::<RawOkxEnvelope>(&text)
            .map_err(|error| format!("OKX Intelligence decode failed({path}): {error}"))?;
        if envelope.code != "0" && envelope.code != "1" {
            let error =
                classified_okx_error("okx_intelligence_get", path, &envelope.code, &envelope.msg);
            if okx_public_code_retryable(&envelope.code, &envelope.msg)
                && attempt + 1 < INTELLIGENCE_REST_MAX_ATTEMPTS
            {
                last_error = Some(error);
                sleep(intelligence_rest_retry_delay(attempt)).await;
                continue;
            }
            return Err(error);
        }
        let conn = open_intelligence_database(app)?;
        let log_id = format!(
            "intelligence-fetch-{}-{}",
            now_ms(),
            FETCH_LOG_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        let endpoint = path.split('?').next().unwrap_or(path);
        let created_at = now_ms();
        let _ = conn.execute(
            "INSERT INTO intelligence_fetch_log(id,key,account_id,endpoint,status,okx_code,response_json,created_at)
             VALUES(?1,?2,?3,?4,'success',?5,NULL,?6)",
            params![
                &log_id,
                endpoint,
                &account.id,
                endpoint,
                &envelope.code,
                created_at,
            ],
        );
        return Ok(envelope);
    }
    Err(last_error.unwrap_or_else(|| "OKX Intelligence REST 请求失败".to_string()))
}

fn intelligence_rest_retry_delay(attempt: u32) -> Duration {
    Duration::from_millis(INTELLIGENCE_REST_RETRY_BASE_MS.saturating_mul(1_u64 << attempt.min(8)))
}

fn intelligence_http_status_retryable(status: u16) -> bool {
    status == 429 || status >= 500
}

async fn intelligence_public_get(
    app: &tauri::AppHandle,
    path: &str,
) -> Result<RawOkxEnvelope, String> {
    if path.starts_with("/api/v5/rubik/") {
        let mut last_request = PUBLIC_STATS_LAST_REQUEST.lock().await;
        if let Some(last) = *last_request {
            let elapsed = last.elapsed();
            let minimum = Duration::from_millis(420);
            if elapsed < minimum {
                sleep(minimum - elapsed).await;
            }
        }
        *last_request = Some(Instant::now());
    }
    let url = format!("{}{}", REST_BASE, path);
    let mut last_error = None;
    for attempt in 0..3_u32 {
        let response = match reqwest_client()?.get(&url).send().await {
            Ok(response) => response,
            Err(error) => {
                last_error = Some(classify_reqwest_error(
                    "OKX Public Intelligence REST",
                    path,
                    &error,
                ));
                if attempt < 2 {
                    sleep(Duration::from_millis(
                        250_u64.saturating_mul(1_u64 << attempt),
                    ))
                    .await;
                    continue;
                }
                break;
            }
        };
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            last_error = Some(format!("OKX Public Intelligence HTTP {status}: {text}"));
            if status.is_server_error() && attempt < 2 {
                sleep(Duration::from_millis(
                    250_u64.saturating_mul(1_u64 << attempt),
                ))
                .await;
                continue;
            }
            break;
        }
        let envelope = serde_json::from_str::<RawOkxEnvelope>(&text)
            .map_err(|error| format!("OKX Public Intelligence decode failed({path}): {error}"))?;
        if envelope.code != "0" {
            return Err(classified_okx_error(
                "okx_public_intelligence_get",
                path,
                &envelope.code,
                &envelope.msg,
            ));
        }
        let conn = open_intelligence_database(app)?;
        let log_id = format!(
            "intelligence-public-fetch-{}-{}",
            now_ms(),
            FETCH_LOG_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        let endpoint = path.split('?').next().unwrap_or(path);
        let created_at = now_ms();
        let _ = conn.execute(
            "INSERT INTO intelligence_fetch_log(id,key,account_id,endpoint,status,okx_code,response_json,created_at)
             VALUES(?1,?2,NULL,?3,'success',?4,NULL,?5)",
            params![&log_id, endpoint, endpoint, &envelope.code, created_at],
        );
        return Ok(envelope);
    }
    Err(last_error.unwrap_or_else(|| format!("OKX Public Intelligence 请求失败：{path}")))
}

fn response_metadata_container(data: &Value) -> &Value {
    data.as_array()
        .and_then(|items| (items.len() == 1).then(|| items.first()).flatten())
        .filter(|value| value.is_object())
        .unwrap_or(data)
}

fn data_version(envelope: &RawOkxEnvelope) -> Option<String> {
    envelope.data_version.clone().or_else(|| {
        value_string(
            response_metadata_container(&envelope.data),
            &["dataVersion", "updateTime", "asOfTime", "ts"],
        )
    })
}

fn response_from_envelope(envelope: &RawOkxEnvelope, now: i64) -> IntelligenceResponse {
    let mut response = IntelligenceResponse::new(now, item_array(&envelope.data));
    response.data_version = data_version(envelope);
    if let Some(cursor) = value_string(
        response_metadata_container(&envelope.data),
        &["nextCursor", "cursor", "nextAfter"],
    ) {
        response.pagination.has_more = true;
        response.pagination.next_after = Some(cursor);
    }
    response
}

fn normalize_response(
    mut response: IntelligenceResponse,
    kind: &str,
) -> Result<IntelligenceResponse, String> {
    let original_len = response.items.len();
    response.items = response
        .items
        .iter()
        .map(|item| normalize_item(kind, item))
        .filter(|item| item.as_object().is_some_and(|map| !map.is_empty()))
        .collect();
    if original_len > 0 && response.items.len() != original_len {
        return Err(format!(
            "OKX {kind} 响应结构与 provider v{} 不兼容，provider degraded",
            desic_intelligence::PROVIDER_VERSION
        ));
    }
    Ok(response)
}

fn local_response(items: Vec<Value>, stale: bool) -> IntelligenceResponse {
    let mut response = IntelligenceResponse::new(now_ms(), items);
    response.stale = stale;
    response
}

fn derivatives_response(
    items: Vec<Value>,
    expected_points: Option<u32>,
    stale: bool,
) -> IntelligenceResponse {
    let mut response = IntelligenceResponse::new(now_ms(), items);
    response.source = DERIVATIVES_SOURCE.to_string();
    response.source_version = DERIVATIVES_VERSION.to_string();
    response.stale = stale;
    response.data_version = response
        .items
        .iter()
        .filter_map(|item| value_i64(item, &["ts", "bucketAt", "eventAt", "fundingTime"]))
        .max()
        .map(|value| value.to_string());
    response.expected_points = expected_points;
    response.coverage = expected_points
        .filter(|expected| *expected > 0)
        .map(|expected| (response.items.len() as f64 / f64::from(expected)).min(1.0));
    response
}

fn derivative_period_ms(period: &str) -> Option<i64> {
    match period {
        "5m" => Some(5 * 60_000),
        "1H" => Some(60 * 60_000),
        "4H" => Some(4 * 60 * 60_000),
        "1D" => Some(24 * 60 * 60_000),
        _ => None,
    }
}

fn derivative_item_observed_at(item: &Value, period_ms: i64, now: i64) -> Option<i64> {
    value_i64(item, &["observedAt", "sourceTs"]).or_else(|| {
        value_i64(item, &["bucketStartAt", "ts", "bucketAt"])
            .map(|value| value.saturating_add(period_ms).min(now))
    })
}

fn derivative_series_metadata(
    kind: &str,
    query: &DerivativesQuery,
    items: &[Value],
    fallback_fetched_at: i64,
) -> IntelligenceSeriesMetadata {
    let now = now_ms();
    let granularity = query.period.as_deref().unwrap_or("5m");
    let period_ms = derivative_period_ms(granularity).unwrap_or(5 * 60_000);
    let latest = items
        .iter()
        .max_by_key(|item| derivative_item_observed_at(item, period_ms, now).unwrap_or_default());
    let bucket_start_at =
        latest.and_then(|item| value_i64(item, &["bucketStartAt", "ts", "bucketAt"]));
    let bucket_end_at = latest
        .and_then(|item| value_i64(item, &["bucketEndAt"]))
        .or_else(|| bucket_start_at.map(|value| value.saturating_add(period_ms)));
    let observed_at = latest.and_then(|item| derivative_item_observed_at(item, period_ms, now));
    let fetched_at = latest
        .and_then(|item| value_i64(item, &["sourceFetchedAt", "receivedAt"]))
        .or((fallback_fetched_at > 0).then_some(fallback_fetched_at));
    let effective_age_ms = observed_at.map(|value| now.saturating_sub(value));
    let bucket_status = latest
        .and_then(|item| value_string(item, &["bucketStatus"]))
        .unwrap_or_else(|| {
            if bucket_end_at.is_some_and(|value| value > now) {
                "partial".to_string()
            } else {
                "closed".to_string()
            }
        });
    let source_mode = latest
        .and_then(|item| value_string(item, &["sourceMode"]))
        .unwrap_or_else(|| {
            if latest.is_some_and(|item| item.get("stream") == Some(&Value::Bool(true))) {
                "websocket".to_string()
            } else {
                "rest".to_string()
            }
        });
    let stale_after_ms = period_ms.saturating_mul(2);
    let stale = items.is_empty()
        || effective_age_ms.is_none_or(|value| value > stale_after_ms)
        || bucket_status == "incomplete";
    let stale_reason = if items.is_empty() {
        Some("本地没有匹配当前参数的数据".to_string())
    } else if bucket_status == "incomplete" {
        Some(format!("{granularity} 时间桶覆盖不完整"))
    } else if stale {
        Some(format!("{granularity} 序列距最近实际观测已超过两个时间桶"))
    } else {
        None
    };
    IntelligenceSeriesMetadata {
        kind: kind.to_string(),
        inst_id: Some(query.inst_id.clone()),
        granularity: Some(granularity.to_string()),
        bucket_start_at,
        bucket_end_at,
        observed_at,
        fetched_at,
        effective_age_ms,
        bucket_status,
        source_mode,
        stale,
        stale_reason,
    }
}

fn apply_derivative_response_metadata(
    response: &mut IntelligenceResponse,
    kind: &str,
    query: &DerivativesQuery,
) {
    let metadata = derivative_series_metadata(kind, query, &response.items, response.fetched_at);
    if let Some(value) = metadata.fetched_at {
        response.fetched_at = value;
    }
    response.data_at = metadata.observed_at;
    response.age_ms = metadata.effective_age_ms.unwrap_or(i64::MAX);
    response.stale = response.stale || metadata.stale;
    if response.stale_reason.is_none() {
        response.stale_reason.clone_from(&metadata.stale_reason);
    }
    response.series_metadata = vec![metadata];
}

fn merge_live_oi_snapshot(query: &DerivativesQuery, items: &mut Vec<Value>) -> Option<Value> {
    let live = OI_STREAM_CACHE
        .lock()
        .ok()
        .and_then(|cache| cache.get(&query.inst_id).map(|(_, value)| value.clone()))?;
    let observed_at = value_i64(&live, &["observedAt", "sourceTs", "receivedAt"])?;
    if query.start_time.is_some_and(|value| observed_at < value)
        || query.end_time.is_some_and(|value| observed_at > value)
    {
        return None;
    }
    let period = query.period.as_deref().unwrap_or("5m");
    let period_ms = derivative_period_ms(period)?;
    let bucket_start_at = observed_at / period_ms * period_ms;
    let bucket_end_at = bucket_start_at.saturating_add(period_ms);
    let now = now_ms();
    let mut buckets = items
        .drain(..)
        .filter_map(|value| {
            value_i64(&value, &["bucketStartAt", "ts", "bucketAt"]).map(|bucket| (bucket, value))
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    let had_local_bucket = buckets.contains_key(&bucket_start_at);
    let entry = buckets
        .entry(bucket_start_at)
        .or_insert_with(|| json!({ "instId": query.inst_id, "ts": bucket_start_at }));
    if let (Some(target), Some(source)) = (entry.as_object_mut(), live.as_object()) {
        for key in ["oi", "oiCcy", "oiUsd", "sourceTs", "receivedAt"] {
            if let Some(value) = source.get(key).filter(|value| !value.is_null()) {
                target.insert(key.to_string(), value.clone());
            }
        }
        target.insert("stream".to_string(), json!(true));
        target.insert("ts".to_string(), json!(bucket_start_at));
        target.insert("bucketStartAt".to_string(), json!(bucket_start_at));
        target.insert("bucketEndAt".to_string(), json!(bucket_end_at));
        target.insert("observedAt".to_string(), json!(observed_at));
        target.insert("sourceFetchedAt".to_string(), json!(observed_at));
        target.insert("granularity".to_string(), json!(period));
        target.insert("sourceGranularity".to_string(), json!("websocket"));
        target.insert(
            "bucketStatus".to_string(),
            json!(if bucket_end_at > now {
                "partial"
            } else {
                "closed"
            }),
        );
        target.insert(
            "sourceMode".to_string(),
            json!(if had_local_bucket {
                "rest+websocket"
            } else {
                "websocket"
            }),
        );
    }
    let limit = query.limit.unwrap_or(288) as usize;
    let mut merged = buckets.into_values().collect::<Vec<_>>();
    if merged.len() > limit {
        merged.drain(0..merged.len() - limit);
    }
    *items = merged;
    Some(live)
}

fn limit_response(mut response: IntelligenceResponse) -> IntelligenceResponse {
    if response.items.len() > MAX_TOOL_ITEMS {
        response.items.truncate(MAX_TOOL_ITEMS);
        response.truncated = true;
    }
    for item in &mut response.items {
        response.truncated |= truncate_value(item, MAX_TOOL_TEXT);
    }
    response
}

fn truncate_value(value: &mut Value, max_text: usize) -> bool {
    match value {
        Value::String(text) if text.chars().count() > max_text => {
            *text = text.chars().take(max_text).collect::<String>();
            true
        }
        Value::Array(items) => {
            let mut truncated = false;
            if items.len() > MAX_TOOL_ITEMS {
                items.truncate(MAX_TOOL_ITEMS);
                truncated = true;
            }
            for item in items {
                truncated |= truncate_value(item, max_text);
            }
            truncated
        }
        Value::Object(map) => {
            let mut truncated = false;
            for item in map.values_mut() {
                truncated |= truncate_value(item, max_text);
            }
            truncated
        }
        _ => false,
    }
}

async fn fetch_news(
    app: &tauri::AppHandle,
    query: &IntelligenceQuery,
) -> Result<IntelligenceResponse, String> {
    let account = intelligence_account(app, query.account_id.as_deref())?;
    let language = query.language.as_deref().unwrap_or("zh-CN");
    let path = query_path(
        NEWS_SEARCH_PATH,
        vec![
            (
                "sortBy",
                Some(query.sort_by.clone().unwrap_or_else(|| {
                    if query.keyword.is_some() {
                        "relevant"
                    } else {
                        "latest"
                    }
                    .to_string()
                })),
            ),
            ("keyword", query.keyword.clone()),
            ("importance", query.importance.clone()),
            ("platform", query.platform.clone()),
            ("ccyList", csv_values(query.coins.as_ref())),
            ("sentiment", query.sentiment.clone()),
            ("begin", query.start_time.map(|value| value.to_string())),
            ("end", query.end_time.map(|value| value.to_string())),
            (
                "detailLvl",
                query
                    .detail_level
                    .clone()
                    .or_else(|| Some("summary".to_string())),
            ),
            (
                "limit",
                Some(query.limit.unwrap_or(30).clamp(1, 100).to_string()),
            ),
            ("cursor", query.after.clone()),
        ],
    );
    let envelope = intelligence_private_get(app, &account, &path, Some(language)).await?;
    let now = now_ms();
    let response = normalize_response(response_from_envelope(&envelope, now), "news")?;
    let conn = open_intelligence_database(app)?;
    upsert_news(
        &conn,
        &response.items,
        language,
        response.data_version.as_deref(),
        now,
    )?;
    let _ = rebuild_news_events(&conn, now);
    let _ = refresh_news_reactions(&conn, now);
    let _ = publish_important_news_events(&conn, now.saturating_sub(6 * 60 * 60_000));
    Ok(limit_response(response))
}

#[tauri::command]
pub(crate) async fn intelligence_news_query(
    app: tauri::AppHandle,
    query: IntelligenceQuery,
) -> Result<IntelligenceResponse, String> {
    let conn = open_intelligence_database(&app)?;
    if query.local_only.unwrap_or(false) {
        return Ok(local_response(query_news_local(&conn, &query)?, false));
    }
    match fetch_news(&app, &query).await {
        Ok(response) => Ok(response),
        Err(error) => {
            let local = query_news_local(&conn, &query)?;
            if local.is_empty() {
                Err(error)
            } else {
                let mut response = local_response(local, true);
                response
                    .limitations
                    .push(format!("远端刷新失败，已返回本地历史：{error}"));
                Ok(limit_response(response))
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn intelligence_news_detail(
    app: tauri::AppHandle,
    request: IntelligenceDetailRequest,
) -> Result<IntelligenceResponse, String> {
    let id = request.id.trim();
    if id.is_empty() || id.len() > 256 {
        return Err("新闻 ID 无效".to_string());
    }
    let language = request.language.as_deref().unwrap_or("zh-CN");
    let conn = open_intelligence_database(&app)?;
    if request.local_only {
        let raw = conn
            .query_row(
                "SELECT raw_json FROM intelligence_news_contents WHERE id=?1 AND language=?2",
                params![id, language],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let items = raw
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .into_iter()
            .collect();
        return Ok(local_response(items, false));
    }
    let account = intelligence_account(&app, request.account_id.as_deref())?;
    let path = query_path(NEWS_DETAIL_PATH, vec![("id", Some(id.to_string()))]);
    let envelope = intelligence_private_get(&app, &account, &path, Some(language)).await?;
    let now = now_ms();
    let response = normalize_response(response_from_envelope(&envelope, now), "newsDetail")?;
    if let Some(item) = response.items.first() {
        save_news_content(&conn, id, language, item, now)?;
    }
    Ok(limit_response(response))
}

#[tauri::command]
pub(crate) async fn intelligence_news_sources(
    app: tauri::AppHandle,
    account_id: Option<String>,
) -> Result<IntelligenceResponse, String> {
    let account = intelligence_account(&app, account_id.as_deref())?;
    let envelope = intelligence_private_get(&app, &account, NEWS_DOMAINS_PATH, None).await?;
    Ok(limit_response(normalize_response(
        response_from_envelope(&envelope, now_ms()),
        "source",
    )?))
}

#[tauri::command]
pub(crate) async fn intelligence_sentiment_query(
    app: tauri::AppHandle,
    query: SentimentQuery,
) -> Result<IntelligenceResponse, String> {
    let conn = open_intelligence_database(&app)?;
    if query.local_only.unwrap_or(false) {
        return Ok(local_response(query_sentiment_local(&conn, &query)?, false));
    }
    let account = intelligence_account(&app, query.account_id.as_deref())?;
    let now = now_ms();
    let (path, kind, scope) = if let Some(coins) = csv_values(query.coins.as_ref()) {
        let trend_points = query.trend_points.map(|value| value.clamp(1, 500));
        (
            query_path(
                SENTIMENT_QUERY_PATH,
                vec![
                    ("ccy", Some(coins.clone())),
                    (
                        "period",
                        Some(query.period.clone().unwrap_or_else(|| {
                            if trend_points.is_some() { "1h" } else { "24h" }.to_string()
                        })),
                    ),
                    ("inclTrend", trend_points.map(|_| "true".to_string())),
                    ("limit", trend_points.map(|value| value.to_string())),
                ],
            ),
            "sentiment",
            coins,
        )
    } else {
        let period = query.period.clone().unwrap_or_else(|| "24h".to_string());
        let sort_by = query.sort_by.clone().unwrap_or_else(|| "hot".to_string());
        (
            query_path(
                SENTIMENT_RANKING_PATH,
                vec![
                    ("period", Some(period.clone())),
                    ("sortBy", Some(sort_by.clone())),
                    (
                        "limit",
                        Some(query.limit.unwrap_or(20).clamp(1, 50).to_string()),
                    ),
                ],
            ),
            "ranking",
            format!("{period}:{sort_by}"),
        )
    };
    let envelope = intelligence_private_get(&app, &account, &path, None).await?;
    let response = normalize_response(response_from_envelope(&envelope, now), kind)?;
    let previous_sentiment = if kind == "sentiment" {
        response
            .items
            .iter()
            .filter_map(|item| value_string(item, &["ccy", "symbol", "coin"]))
            .collect::<HashSet<_>>()
            .into_iter()
            .filter_map(|ccy| latest_local_sentiment(&conn, &ccy).map(|value| (ccy, value)))
            .collect::<HashMap<_, _>>()
    } else {
        HashMap::new()
    };
    upsert_generic(
        &conn,
        kind,
        &response.items,
        &scope,
        response.data_version.as_deref(),
        now,
    )?;
    if kind == "sentiment" {
        let _ = publish_sentiment_reversals(&conn, &previous_sentiment, &response.items, now);
    }
    Ok(limit_response(response))
}

#[tauri::command]
pub(crate) async fn intelligence_calendar_query(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, IntelligenceRuntime>,
    query: CalendarQuery,
) -> Result<IntelligenceResponse, String> {
    fetch_calendar(&app, runtime.inner(), query).await
}

fn calendar_page_path(query: &CalendarQuery, upper_bound: Option<i64>, limit: usize) -> String {
    query_path(
        ECONOMIC_CALENDAR_PATH,
        vec![
            ("region", query.region.clone()),
            ("importance", query.importance.clone()),
            ("before", query.start_time.map(|value| value.to_string())),
            ("after", upper_bound.map(|value| value.to_string())),
            (
                "limit",
                Some(limit.min(ECONOMIC_CALENDAR_PAGE_LIMIT).to_string()),
            ),
        ],
    )
}

async fn fetch_calendar(
    app: &tauri::AppHandle,
    runtime: &IntelligenceRuntime,
    query: CalendarQuery,
) -> Result<IntelligenceResponse, String> {
    let conn = open_intelligence_database(app)?;
    if query.local_only.unwrap_or(false) {
        return Ok(local_response(query_calendar_local(&conn, &query)?, false));
    }
    let account = intelligence_account(app, query.account_id.as_deref())?;
    let requested_limit = query
        .limit
        .unwrap_or(ECONOMIC_CALENDAR_PAGE_LIMIT as u32)
        .clamp(1, ECONOMIC_CALENDAR_MAX_ITEMS as u32) as usize;
    let mut upper_bound = query.end_time;
    let mut items = Vec::with_capacity(requested_limit.min(ECONOMIC_CALENDAR_PAGE_LIMIT * 2));
    let mut seen = HashSet::new();
    let mut fetched_at = now_ms();
    let mut response_version = None;
    let mut has_more = false;

    while items.len() < requested_limit {
        let page_limit = (requested_limit - items.len()).min(ECONOMIC_CALENDAR_PAGE_LIMIT);
        {
            let mut last = runtime.calendar_lock.lock().await;
            if let Some(last_request) = *last {
                let elapsed = last_request.elapsed();
                if elapsed < Duration::from_secs(5) {
                    sleep(Duration::from_secs(5) - elapsed).await;
                }
            }
            *last = Some(Instant::now());
        }
        let path = calendar_page_path(&query, upper_bound, page_limit);
        let envelope = intelligence_private_get(app, &account, &path, None).await?;
        let page_fetched_at = now_ms();
        let page = normalize_response(
            response_from_envelope(&envelope, page_fetched_at),
            "calendar",
        )?;
        let page_len = page.items.len();
        let next_upper_bound = page
            .items
            .iter()
            .filter_map(|item| value_i64(item, &["eventTime"]))
            .min();
        fetched_at = fetched_at.max(page.fetched_at);
        response_version = page.data_version.or(response_version);
        for item in page.items {
            let event_at = value_i64(&item, &["eventTime"]);
            if query
                .start_time
                .is_some_and(|start| event_at.is_some_and(|at| at < start))
                || query
                    .end_time
                    .is_some_and(|end| event_at.is_some_and(|at| at > end))
            {
                continue;
            }
            let key = value_string(&item, &["id"]).unwrap_or_else(|| item.to_string());
            if seen.insert(key) {
                items.push(item);
            }
        }
        if page_len < page_limit {
            break;
        }
        let Some(next_upper_bound) = next_upper_bound else {
            break;
        };
        if query
            .start_time
            .is_some_and(|start| next_upper_bound <= start)
            || upper_bound.is_some_and(|current| next_upper_bound >= current)
        {
            break;
        }
        upper_bound = Some(next_upper_bound);
        has_more = items.len() >= requested_limit;
    }

    items.sort_by_key(|item| value_i64(item, &["eventTime"]).unwrap_or(i64::MAX));
    items.truncate(requested_limit);
    let now = now_ms();
    let mut response = IntelligenceResponse::new(fetched_at, items);
    response.expected_points = Some(response.items.len().min(u32::MAX as usize) as u32);
    response.data_version = response_version;
    response.pagination.has_more = has_more;
    response.pagination.next_after = if has_more {
        upper_bound.map(|value| value.to_string())
    } else {
        None
    };
    upsert_generic(
        &conn,
        "calendar",
        &response.items,
        "calendar",
        response.data_version.as_deref(),
        now,
    )?;
    let _ = publish_macro_windows(&conn, &response.items, now);
    Ok(limit_response(response))
}

fn smart_path(
    query: &SmartMoneyQuery,
) -> Result<
    (
        &'static str,
        Vec<(&'static str, Option<String>)>,
        &'static str,
        String,
    ),
    String,
> {
    let author_ids = csv_values(query.author_ids.as_ref());
    let inst_ccy_list = csv_values(query.inst_ccy_list.as_ref());
    let common_filters = || {
        vec![
            (
                "sortType",
                Some(query.sort_type.clone().unwrap_or_else(|| "pnl".to_string())),
            ),
            (
                "period",
                Some(query.period.clone().unwrap_or_else(|| "7".to_string())),
            ),
            ("pnl", query.pnl.clone()),
            ("winRatio", query.win_ratio.clone()),
            ("maxRetreat", query.max_retreat.clone()),
            ("asset", query.asset.clone()),
            (
                "lmtNum",
                query.lmt_num.map(|value| value.clamp(1, 2_000).to_string()),
            ),
        ]
    };
    match query.operation.as_str() {
        "traders" => Ok((
            SMART_LEADERBOARD_PATH,
            vec![
                ("updateTime", query.update_time.clone()),
                (
                    "sortType",
                    Some(query.sort_type.clone().unwrap_or_else(|| "pnl".to_string())),
                ),
                (
                    "period",
                    Some(query.period.clone().unwrap_or_else(|| "90".to_string())),
                ),
                ("pnl", query.pnl.clone()),
                ("winRatio", query.win_ratio.clone()),
                ("maxRetreat", query.max_retreat.clone()),
                ("asset", query.asset.clone()),
                ("after", query.after.clone()),
                ("before", query.before.clone()),
                (
                    "limit",
                    Some(query.limit.unwrap_or(20).clamp(1, 100).to_string()),
                ),
            ],
            "trader",
            "leaderboard".to_string(),
        )),
        "performance" => Ok((
            SMART_LEADERBOARD_PATH,
            vec![
                ("authorIds", author_ids),
                (
                    "sortType",
                    Some(query.sort_type.clone().unwrap_or_else(|| "pnl".to_string())),
                ),
                (
                    "period",
                    Some(query.period.clone().unwrap_or_else(|| "90".to_string())),
                ),
            ],
            "trader_snapshot",
            query.period.clone().unwrap_or_else(|| "90".to_string()),
        )),
        "searchTrader" => Ok((
            SMART_TRADER_SEARCH_PATH,
            vec![("keyword", query.keyword.clone())],
            "trader",
            "search".to_string(),
        )),
        "positions" => Ok((
            SMART_POSITION_CURRENT_PATH,
            vec![
                ("authorId", query.author_id.clone()),
                ("instCcy", query.inst_id.clone()),
            ],
            "position",
            query.author_id.clone().unwrap_or_default(),
        )),
        "positionHistory" => Ok((
            SMART_POSITION_HISTORY_PATH,
            vec![
                ("authorId", query.author_id.clone()),
                ("instCcy", query.inst_id.clone()),
                ("after", query.after.clone()),
                ("before", query.before.clone()),
                (
                    "limit",
                    Some(query.limit.unwrap_or(50).clamp(1, 100).to_string()),
                ),
            ],
            "closed_position",
            query.author_id.clone().unwrap_or_default(),
        )),
        "orderHistory" => Ok((
            SMART_TRADE_RECORDS_PATH,
            vec![
                ("authorId", query.author_id.clone()),
                ("instCcy", query.inst_id.clone()),
                ("after", query.after.clone()),
                ("before", query.before.clone()),
                (
                    "limit",
                    Some(query.limit.unwrap_or(50).clamp(1, 100).to_string()),
                ),
            ],
            "order",
            query.author_id.clone().unwrap_or_default(),
        )),
        "signalOverviewByFilter" | "signalOverviewByTrader" => {
            if inst_ccy_list.is_some() && query.top_instruments.is_some() {
                return Err("instCcyList 与 topInstruments 不能同时提供".to_string());
            }
            let mut params = common_filters();
            params.push(("authorIds", author_ids));
            params.push(("instCcyList", inst_ccy_list));
            params.push((
                "topInstruments",
                if query.inst_ccy_list.is_some() {
                    None
                } else {
                    query
                        .top_instruments
                        .or(Some(20))
                        .map(|value| value.clamp(1, 100).to_string())
                },
            ));
            Ok((
                SMART_OVERVIEW_PATH,
                params,
                "signal",
                format!(
                    "{}:{}",
                    query.operation,
                    query.sort_type.as_deref().unwrap_or("pnl")
                ),
            ))
        }
        "signalTrendByFilter" | "signalTrendByTrader" => {
            let inst_id = query
                .inst_id
                .clone()
                .or_else(|| {
                    query.inst_ccy.as_deref().map(|currency| {
                        format!("{}-USDT-SWAP", currency.trim().to_ascii_uppercase())
                    })
                })
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "Smart Money 历史趋势必须提供 instId".to_string())?;
            let data_version = query
                .data_version
                .clone()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    "Smart Money 历史趋势必须提供 dataVersion 或可转换的 ts".to_string()
                })?;
            let mut params = common_filters();
            params.extend([
                ("authorIds", author_ids),
                ("instId", Some(inst_id)),
                ("dataVersion", Some(data_version)),
                (
                    "granularity",
                    Some(
                        query
                            .granularity
                            .clone()
                            .unwrap_or_else(|| "1h".to_string()),
                    ),
                ),
                (
                    "limit",
                    Some(query.limit.unwrap_or(24).clamp(1, 500).to_string()),
                ),
            ]);
            Ok((
                SMART_SIGNAL_HISTORY_PATH,
                params,
                "signal",
                format!(
                    "{}:{}",
                    query.operation,
                    query.sort_type.as_deref().unwrap_or("pnl")
                ),
            ))
        }
        value => Err(format!("不支持的 Smart Money 操作：{value}")),
    }
}

fn smart_data_version_from_ms(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.len() != 13 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("Smart Money ts 必须是 13 位 Unix 毫秒字符串".to_string());
    }
    let timestamp = value
        .parse::<i64>()
        .map_err(|_| "Smart Money ts 必须是 13 位 Unix 毫秒字符串".to_string())?;
    let okx_offset = chrono::FixedOffset::east_opt(8 * 60 * 60)
        .ok_or_else(|| "无法构造 OKX Smart Money UTC+8 时区".to_string())?;
    Utc.timestamp_millis_opt(timestamp)
        .single()
        .map(|date| {
            date.with_timezone(&okx_offset)
                .format("%Y%m%d%H")
                .to_string()
        })
        .ok_or_else(|| "Smart Money ts 超出支持范围".to_string())
}

fn smart_data_version_to_ms(value: &str) -> Result<i64, String> {
    let value = value.trim();
    if value.len() != 10 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("Smart Money dataVersion 必须是 yyyyMMddHH UTC+8".to_string());
    }
    let date = chrono::NaiveDate::parse_from_str(&value[..8], "%Y%m%d")
        .map_err(|_| "Smart Money dataVersion 必须是 yyyyMMddHH UTC+8".to_string())?;
    let hour = value[8..]
        .parse::<u32>()
        .map_err(|_| "Smart Money dataVersion 必须是 yyyyMMddHH UTC+8".to_string())?;
    let local = date
        .and_hms_opt(hour, 0, 0)
        .ok_or_else(|| "Smart Money dataVersion 必须是 yyyyMMddHH UTC+8".to_string())?;
    let okx_offset = chrono::FixedOffset::east_opt(8 * 60 * 60)
        .ok_or_else(|| "无法构造 OKX Smart Money UTC+8 时区".to_string())?;
    okx_offset
        .from_local_datetime(&local)
        .single()
        .map(|date| date.timestamp_millis())
        .ok_or_else(|| "Smart Money dataVersion 超出支持范围".to_string())
}

fn linear_swap_base_currency(base_ccy: &str, inst_id: &str) -> String {
    let base_ccy = base_ccy.trim();
    if base_ccy.is_empty() {
        inst_id
            .split('-')
            .next()
            .unwrap_or_default()
            .trim()
            .to_uppercase()
    } else {
        base_ccy.to_uppercase()
    }
}

fn linear_swap_currencies(app: &tauri::AppHandle) -> Result<HashSet<String>, String> {
    let summary = load_market_assets_summary(app)?
        .ok_or_else(|| "OKX SWAP 合约缓存尚未初始化，无法过滤 Smart Money 线性合约".to_string())?;
    let currencies = summary
        .instruments
        .into_iter()
        .filter(|instrument| instrument.inst_type.eq_ignore_ascii_case("SWAP"))
        .filter(|instrument| {
            instrument.settle_ccy.eq_ignore_ascii_case("USDT")
                || instrument.settle_ccy.eq_ignore_ascii_case("USDS")
        })
        .filter(|instrument| instrument.state.eq_ignore_ascii_case("live"))
        .map(|instrument| linear_swap_base_currency(&instrument.base_ccy, &instrument.inst_id))
        .filter(|currency| !currency.is_empty())
        .collect::<HashSet<_>>();
    if currencies.is_empty() {
        return Err("OKX SWAP 合约缓存中没有可用的 USDT/USDS 线性合约".to_string());
    }
    Ok(currencies)
}

fn retain_linear_signal_items(items: &mut Vec<Value>, currencies: &HashSet<String>) -> usize {
    let before = items.len();
    items.retain(|item| {
        value_string(item, &["instCcy", "ccy", "symbol"])
            .map(|currency| currencies.contains(&currency.trim().to_uppercase()))
            .unwrap_or(false)
    });
    before.saturating_sub(items.len())
}

fn purge_non_linear_signal_rows(
    conn: &Connection,
    currencies: &HashSet<String>,
) -> Result<usize, String> {
    let existing = {
        let mut stmt = conn
            .prepare("SELECT DISTINCT inst_ccy FROM intelligence_smart_signals")
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    let mut deleted = 0;
    for currency in existing {
        if !currencies.contains(&currency.trim().to_uppercase()) {
            deleted += conn
                .execute(
                    "DELETE FROM intelligence_smart_signals WHERE inst_ccy=?1",
                    params![currency],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(deleted)
}

#[tauri::command]
pub(crate) async fn intelligence_smart_query(
    app: tauri::AppHandle,
    mut query: SmartMoneyQuery,
) -> Result<IntelligenceResponse, String> {
    let conn = open_intelligence_database(&app)?;
    if query.operation.starts_with("signalTrend") {
        if query.inst_ccy.as_deref().is_none_or(str::is_empty) {
            query.inst_ccy = query.inst_id.as_deref().and_then(|inst_id| {
                inst_id
                    .split('-')
                    .next()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| value.to_ascii_uppercase())
            });
        }
        if query.inst_id.as_deref().is_none_or(str::is_empty) {
            query.inst_id = query
                .inst_ccy
                .as_deref()
                .map(|currency| format!("{}-USDT-SWAP", currency.trim().to_ascii_uppercase()));
        }
        if query.data_version.as_deref().is_none_or(str::is_empty) {
            let timestamp = query
                .ts
                .clone()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    query
                        .as_of_time
                        .clone()
                        .filter(|value| !value.trim().is_empty())
                })
                .or_else(|| {
                    query
                        .update_time
                        .clone()
                        .filter(|value| !value.trim().is_empty())
                })
                .unwrap_or_else(|| now_ms().to_string());
            query.data_version = Some(smart_data_version_from_ms(&timestamp)?);
            query.ts = Some(timestamp);
        } else if query.ts.as_deref().is_none_or(str::is_empty) {
            query.ts = Some(
                smart_data_version_to_ms(query.data_version.as_deref().unwrap_or_default())?
                    .to_string(),
            );
        }
    }
    if query.local_only.unwrap_or(false) {
        let mut response = local_response(query_smart_local(&conn, &query)?, false);
        response
            .limitations
            .push(LINEAR_SIGNAL_LIMITATION.to_string());
        return Ok(limit_response(response));
    }
    let account = intelligence_account(&app, query.account_id.as_deref())?;
    let (base, params, kind, scope) = smart_path(&query)?;
    if matches!(kind, "position" | "closed_position" | "order") && scope.trim().is_empty() {
        return Err("Smart Money 交易员查询必须提供 authorId".to_string());
    }
    let path = query_path(base, params);
    let envelope = match intelligence_private_get(&app, &account, &path, None).await {
        Ok(envelope) => envelope,
        Err(error)
            if query.operation.starts_with("signalTrend")
                && (error.contains("HTTP 5")
                    || error.to_ascii_lowercase().contains("timed out")
                    || error.to_ascii_lowercase().contains("timeout")) =>
        {
            let items = query_smart_local(&conn, &query)?;
            if items.is_empty() {
                return Err(error);
            }
            let expected = query.limit.unwrap_or(24).clamp(1, 500);
            let mut response = local_response(items, true);
            response.expected_points = Some(expected);
            response.coverage = Some((response.items.len() as f64 / f64::from(expected)).min(1.0));
            response.limitations.push(format!(
                "OKX Smart Money 历史接口暂时不可用，已回退本地同币种、同粒度快照：{error}"
            ));
            response
                .limitations
                .push(LINEAR_SIGNAL_LIMITATION.to_string());
            return Ok(limit_response(response));
        }
        Err(error) => return Err(error),
    };
    let now = now_ms();
    let mut response = normalize_response(response_from_envelope(&envelope, now), kind)?;
    if query.operation.starts_with("signal") {
        let granularity = if query.operation.starts_with("signalTrend") {
            query.granularity.as_deref().unwrap_or("1h")
        } else {
            "snapshot"
        };
        for item in &mut response.items {
            let Some(object) = item.as_object_mut() else {
                continue;
            };
            object.insert(
                "granularity".to_string(),
                Value::String(granularity.to_string()),
            );
            if let Some(data_version) = object
                .get("dataVersion")
                .and_then(Value::as_str)
                .map(str::to_string)
            {
                if response.data_version.is_none() {
                    response.data_version = Some(data_version.clone());
                }
                if !object.contains_key("bucketAt") {
                    if let Ok(bucket_at) = smart_data_version_to_ms(&data_version) {
                        object.insert("bucketAt".to_string(), Value::from(bucket_at));
                    }
                }
            }
        }
        let currencies = linear_swap_currencies(&app)?;
        let filtered = retain_linear_signal_items(&mut response.items, &currencies);
        let purged = purge_non_linear_signal_rows(&conn, &currencies)?;
        if filtered > 0 || purged > 0 {
            response.limitations.push(format!(
                "已过滤 {filtered} 条上游非 USDT/USDS 线性合约信号，并清理 {purged} 条本地旧记录。"
            ));
        }
    }
    let previous_signals = if query.operation.starts_with("signal") {
        response
            .items
            .iter()
            .filter_map(|item| value_string(item, &["instCcy", "ccy", "symbol"]))
            .collect::<HashSet<_>>()
            .into_iter()
            .filter_map(|ccy| latest_local_smart_signal(&conn, &ccy).map(|value| (ccy, value)))
            .collect::<HashMap<_, _>>()
    } else {
        HashMap::new()
    };
    upsert_generic(
        &conn,
        kind,
        &response.items,
        &scope,
        response.data_version.as_deref(),
        now,
    )?;
    if query.operation.starts_with("signal") {
        let _ = publish_smart_money_changes(&conn, &previous_signals, &response.items, now);
        response
            .limitations
            .push(LINEAR_SIGNAL_LIMITATION.to_string());
        response
            .limitations
            .push("名义价值使用交易员平均入场价计算，不是标记价。".to_string());
    }
    Ok(limit_response(response))
}

#[tauri::command]
pub(crate) async fn intelligence_smart_traders_query(
    app: tauri::AppHandle,
    mut query: SmartMoneyQuery,
) -> Result<IntelligenceResponse, String> {
    if !matches!(
        query.operation.as_str(),
        "traders" | "searchTrader" | "performance"
    ) {
        query.operation = "traders".to_string();
    }
    intelligence_smart_query(app, query).await
}

#[tauri::command]
pub(crate) async fn intelligence_smart_signals_query(
    app: tauri::AppHandle,
    mut query: SmartMoneyQuery,
) -> Result<IntelligenceResponse, String> {
    if !matches!(
        query.operation.as_str(),
        "signalOverviewByFilter"
            | "signalOverviewByTrader"
            | "signalTrendByFilter"
            | "signalTrendByTrader"
    ) {
        query.operation = "signalOverviewByFilter".to_string();
    }
    intelligence_smart_query(app, query).await
}

#[tauri::command]
pub(crate) async fn intelligence_smart_trader_detail(
    app: tauri::AppHandle,
    request: SmartTraderDetailRequest,
) -> Result<IntelligenceResponse, String> {
    let author_id = request.author_id.trim().to_string();
    if author_id.is_empty() || author_id.len() > 128 {
        return Err("交易员 ID 无效".to_string());
    }
    let performance = intelligence_smart_query(
        app.clone(),
        SmartMoneyQuery {
            account_id: request.account_id.clone(),
            operation: "performance".to_string(),
            author_ids: Some(vec![author_id.clone()]),
            period: Some("90".to_string()),
            ..Default::default()
        },
    );
    let positions = intelligence_smart_query(
        app.clone(),
        SmartMoneyQuery {
            account_id: request.account_id.clone(),
            operation: "positions".to_string(),
            author_id: Some(author_id.clone()),
            limit: Some(100),
            ..Default::default()
        },
    );
    let orders = async {
        if request.include_order_history {
            intelligence_smart_query(
                app,
                SmartMoneyQuery {
                    account_id: request.account_id,
                    operation: "orderHistory".to_string(),
                    author_id: Some(author_id),
                    limit: Some(50),
                    ..Default::default()
                },
            )
            .await
        } else {
            Ok(IntelligenceResponse::new(now_ms(), Vec::new()))
        }
    };
    let (performance, positions, orders) = tokio::try_join!(performance, positions, orders)?;
    let mut items = Vec::new();
    items.extend(performance.items);
    items.extend(positions.items);
    items.extend(orders.items);
    let mut response = IntelligenceResponse::new(now_ms(), items);
    response.stale = performance.stale || positions.stale || orders.stale;
    response.data_version = performance
        .data_version
        .or(positions.data_version)
        .or(orders.data_version);
    response.limitations = vec![
        LINEAR_SIGNAL_LIMITATION.to_string(),
        "Smart Money 名义价值按入场价而非标记价计算。".to_string(),
    ];
    Ok(limit_response(response))
}

fn derivatives_array_rows(data: &Value, kind: &str, inst_id: &str) -> Vec<Value> {
    item_array(data)
        .into_iter()
        .filter_map(|row| {
            let values = row.as_array()?;
            let ts = values
                .first()
                .and_then(|value| value.as_str())
                .and_then(|value| value.parse::<i64>().ok())?;
            match kind {
                "positioning" if values.len() >= 4 => Some(json!({
                    "instId": inst_id, "ts": ts,
                    "oi": values[1].as_str().unwrap_or_default(),
                    "oiCcy": values[2].as_str().unwrap_or_default(),
                    "oiUsd": values[3].as_str().unwrap_or_default(),
                })),
                "takerFlow" if values.len() >= 3 => {
                    let sell = values[1]
                        .as_str()
                        .and_then(|value| value.parse::<f64>().ok())
                        .unwrap_or_default();
                    let buy = values[2]
                        .as_str()
                        .and_then(|value| value.parse::<f64>().ok())
                        .unwrap_or_default();
                    Some(json!({
                        "instId": inst_id, "ts": ts, "sellVol": sell,
                        "buyVol": buy, "netVol": buy - sell,
                    }))
                }
                "ratio" if values.len() >= 2 => Some(json!({
                    "instId": inst_id, "ts": ts,
                    "ratio": values[1].as_str().unwrap_or_default(),
                })),
                "premium" if values.len() >= 2 => Some(json!({
                    "instId": inst_id, "ts": ts,
                    "premium": values[1].as_str().unwrap_or_default(),
                })),
                _ => None,
            }
        })
        .collect()
}

async fn fetch_rubik_series(
    app: &tauri::AppHandle,
    base: &str,
    query: &DerivativesQuery,
    kind: &str,
    extra: Vec<(&str, Option<String>)>,
) -> Result<Vec<Value>, String> {
    let target = query.limit.unwrap_or(288).min(1_440) as usize;
    let mut cursor_end = query.end_time;
    let mut rows = std::collections::BTreeMap::<i64, Value>::new();
    while rows.len() < target {
        let page_limit = (target - rows.len()).min(100);
        let mut params = vec![
            ("instId", Some(query.inst_id.clone())),
            ("period", query.period.clone()),
            ("begin", query.start_time.map(|value| value.to_string())),
            ("end", cursor_end.map(|value| value.to_string())),
            ("limit", Some(page_limit.to_string())),
        ];
        params.extend(extra.clone());
        let envelope = intelligence_public_get(app, &query_path(base, params)).await?;
        let raw_page = item_array(&envelope.data);
        let page = derivatives_array_rows(&envelope.data, kind, &query.inst_id);
        if !raw_page.is_empty() && page.is_empty() {
            return Err(format!(
                "OKX {kind} 响应结构与 {DERIVATIVES_VERSION} 不兼容，provider degraded"
            ));
        }
        if page.is_empty() {
            break;
        }
        let oldest = page
            .iter()
            .filter_map(|item| value_i64(item, &["ts"]))
            .min();
        let page_len = page.len();
        for item in page {
            if let Some(ts) = value_i64(&item, &["ts"]) {
                rows.insert(ts, item);
            }
        }
        let Some(oldest) = oldest else {
            break;
        };
        if page_len < page_limit || query.start_time.is_some_and(|start| oldest <= start) {
            break;
        }
        let next_end = oldest.saturating_sub(1);
        if cursor_end.is_some_and(|current| next_end >= current) {
            break;
        }
        cursor_end = Some(next_end);
    }
    Ok(rows.into_values().rev().take(target).collect())
}

fn linear_family(inst_id: &str) -> String {
    inst_id.trim_end_matches("-SWAP").to_string()
}

fn enrich_positioning_prices(conn: &Connection, inst_id: &str, items: &mut [Value]) {
    for item in items {
        let Some(ts) = value_i64(item, &["ts"]) else {
            continue;
        };
        let candle = conn
            .query_row(
                "SELECT close,COALESCE(volume_quote,volume) FROM candles
             WHERE symbol=?1 AND interval IN ('1m','5m') AND confirm=1
               AND open_time<=?2 AND open_time>=?2-300000
             ORDER BY open_time DESC, CASE interval WHEN '1m' THEN 0 ELSE 1 END LIMIT 1",
                params![inst_id, ts],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .ok()
            .flatten();
        if let (Some((price, volume)), Some(object)) = (candle, item.as_object_mut()) {
            object.insert("last".to_string(), Value::String(price));
            object.insert("volumeUsd".to_string(), Value::String(volume));
        }
    }
}

async fn fetch_derivatives_positioning(
    app: &tauri::AppHandle,
    query: &DerivativesQuery,
) -> Result<Vec<Value>, String> {
    let mut items = fetch_rubik_series(
        app,
        DERIVATIVES_OI_HISTORY_PATH,
        query,
        "positioning",
        Vec::new(),
    )
    .await?;
    let ticker_path = query_path(
        MARKET_TICKER_PATH,
        vec![("instId", Some(query.inst_id.clone()))],
    );
    if let Ok(ticker) = intelligence_public_get(app, &ticker_path).await {
        if let Some(latest) = items.first_mut().and_then(Value::as_object_mut) {
            if let Some(value) = item_array(&ticker.data).first() {
                if let Some(last) = value_string(value, &["last"]) {
                    latest.insert("last".to_string(), Value::String(last));
                }
                if let Some(volume) = value_string(value, &["volCcy24h", "vol24h"]) {
                    latest.insert("volumeUsd".to_string(), Value::String(volume));
                }
            }
        }
    }
    Ok(items)
}

async fn fetch_derivatives_taker_flow(
    app: &tauri::AppHandle,
    query: &DerivativesQuery,
) -> Result<Vec<Value>, String> {
    fetch_rubik_series(
        app,
        DERIVATIVES_TAKER_FLOW_PATH,
        query,
        "takerFlow",
        vec![("unit", Some("2".to_string()))],
    )
    .await
}

async fn fetch_derivatives_crowding(
    app: &tauri::AppHandle,
    query: &DerivativesQuery,
) -> Result<Vec<Value>, String> {
    let account = fetch_rubik_series(
        app,
        DERIVATIVES_ACCOUNT_RATIO_PATH,
        query,
        "ratio",
        Vec::new(),
    )
    .await?;
    let top_account = fetch_rubik_series(
        app,
        DERIVATIVES_TOP_ACCOUNT_RATIO_PATH,
        query,
        "ratio",
        Vec::new(),
    )
    .await?;
    let top_position = fetch_rubik_series(
        app,
        DERIVATIVES_TOP_POSITION_RATIO_PATH,
        query,
        "ratio",
        Vec::new(),
    )
    .await?;
    let mut merged = std::collections::BTreeMap::<i64, serde_json::Map<String, Value>>::new();
    for (key, items) in [
        ("accountRatio", account),
        ("topAccountRatio", top_account),
        ("topPositionRatio", top_position),
    ] {
        for item in items {
            let Some(ts) = value_i64(&item, &["ts"]) else {
                continue;
            };
            let value = value_string(&item, &["ratio"]).unwrap_or_default();
            let row = merged.entry(ts).or_insert_with(|| {
                let mut row = serde_json::Map::new();
                row.insert("instId".to_string(), Value::String(query.inst_id.clone()));
                row.insert("ts".to_string(), json!(ts));
                row
            });
            row.insert(key.to_string(), Value::String(value));
        }
    }
    Ok(merged.into_values().map(Value::Object).collect())
}

fn crowding_ratio_bias(value: Option<f64>) -> Option<&'static str> {
    let value = value.filter(|value| value.is_finite())?;
    if (value - 1.0).abs() <= f64::EPSILON {
        Some("neutral")
    } else if value > 1.0 {
        Some("long")
    } else {
        Some("short")
    }
}

fn enrich_crowding_semantics(items: &mut [Value]) {
    for item in items {
        let account_bias = crowding_ratio_bias(value_f64(item, &["accountRatio"]));
        let top_account_bias = crowding_ratio_bias(value_f64(item, &["topAccountRatio"]));
        let top_position_bias = crowding_ratio_bias(value_f64(item, &["topPositionRatio"]));
        let elite_internal_divergence = matches!(
            (top_account_bias, top_position_bias),
            (Some("long"), Some("short")) | (Some("short"), Some("long"))
        );
        if let Some(object) = item.as_object_mut() {
            object.insert("accountBias".to_string(), json!(account_bias));
            object.insert("topAccountBias".to_string(), json!(top_account_bias));
            object.insert("topPositionBias".to_string(), json!(top_position_bias));
            object.insert(
                "eliteInternalDivergence".to_string(),
                json!(elite_internal_divergence),
            );
        }
    }
}

async fn fetch_derivatives_funding_basis(
    app: &tauri::AppHandle,
    query: &DerivativesQuery,
) -> Result<Vec<Value>, String> {
    let family = linear_family(&query.inst_id);
    let current_path = query_path(
        FUNDING_RATE_PATH,
        vec![("instId", Some(query.inst_id.clone()))],
    );
    let history_path = query_path(
        FUNDING_RATE_HISTORY_PATH,
        vec![
            ("instId", Some(query.inst_id.clone())),
            (
                "limit",
                Some(query.limit.unwrap_or(100).min(100).to_string()),
            ),
        ],
    );
    let premium_path = query_path(
        PREMIUM_HISTORY_PATH,
        vec![
            ("instId", Some(query.inst_id.clone())),
            ("period", query.period.clone()),
            ("begin", query.start_time.map(|value| value.to_string())),
            ("end", query.end_time.map(|value| value.to_string())),
            ("limit", query.limit.map(|value| value.min(100).to_string())),
        ],
    );
    let mark_path = query_path(
        MARK_PRICE_PATH,
        vec![
            ("instType", Some("SWAP".to_string())),
            ("instId", Some(query.inst_id.clone())),
        ],
    );
    let index_path = query_path(INDEX_TICKERS_PATH, vec![("instId", Some(family))]);
    let (current, history, premium, mark, index) = tokio::try_join!(
        intelligence_public_get(app, &current_path),
        intelligence_public_get(app, &history_path),
        intelligence_public_get(app, &premium_path),
        intelligence_public_get(app, &mark_path),
        intelligence_public_get(app, &index_path),
    )?;
    let mut rows = item_array(&history.data)
        .into_iter()
        .map(|value| {
            json!({
                "instId": query.inst_id,
                "ts": value_i64(&value, &["fundingTime", "ts"]).unwrap_or_else(now_ms),
                "fundingRate": value_string(&value, &["fundingRate"]).unwrap_or_default(),
                "fundingTime": value_i64(&value, &["fundingTime"]),
            })
        })
        .collect::<Vec<_>>();
    let premium_rows = derivatives_array_rows(&premium.data, "premium", &query.inst_id);
    for row in &mut rows {
        let Some(ts) = value_i64(row, &["ts"]) else {
            continue;
        };
        if let Some(value) = premium_rows
            .iter()
            .min_by_key(|item| {
                value_i64(item, &["ts"])
                    .map(|item_ts| item_ts.saturating_sub(ts).abs())
                    .unwrap_or(i64::MAX)
            })
            .and_then(|item| value_string(item, &["premium"]))
        {
            if let Some(object) = row.as_object_mut() {
                object.insert("premium".to_string(), Value::String(value));
            }
        }
    }
    let current_value = item_array(&current.data)
        .into_iter()
        .next()
        .unwrap_or_else(|| json!({}));
    let mark_value = item_array(&mark.data)
        .into_iter()
        .next()
        .unwrap_or_else(|| json!({}));
    let index_value = item_array(&index.data)
        .into_iter()
        .next()
        .unwrap_or_else(|| json!({}));
    let mark_price = value_f64(&mark_value, &["markPx"]);
    let index_price = value_f64(&index_value, &["idxPx"]);
    let basis = mark_price
        .zip(index_price)
        .map(|(mark, index)| mark - index);
    if value_string(&current_value, &["fundingRate"]).is_none() {
        return Err(format!(
            "OKX funding 响应结构与 {DERIVATIVES_VERSION} 不兼容，provider degraded"
        ));
    }
    let current_row = json!({
        "instId": query.inst_id, "ts": now_ms(),
        "fundingRate": value_string(&current_value, &["fundingRate"]),
        "nextFundingRate": value_string(&current_value, &["nextFundingRate"]),
        "fundingTime": value_i64(&current_value, &["fundingTime"]),
        "nextFundingTime": value_i64(&current_value, &["nextFundingTime"]),
        "premium": premium_rows.first().and_then(|value| value_string(value, &["premium"])),
        "markPrice": mark_price, "indexPrice": index_price, "basis": basis,
    });
    rows.insert(0, current_row);
    Ok(rows)
}

async fn fetch_derivatives_liquidations(
    app: &tauri::AppHandle,
    query: &DerivativesQuery,
) -> Result<Vec<Value>, String> {
    let path = query_path(
        LIQUIDATION_ORDERS_PATH,
        vec![
            ("instType", Some("SWAP".to_string())),
            ("instFamily", Some(linear_family(&query.inst_id))),
            ("state", Some("filled".to_string())),
            (
                "limit",
                Some(query.limit.unwrap_or(100).min(100).to_string()),
            ),
        ],
    );
    let envelope = intelligence_public_get(app, &path).await?;
    let mut rows = Vec::new();
    for container in item_array(&envelope.data) {
        let details = container
            .get("details")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| vec![container.clone()]);
        for detail in details {
            let detail_inst = value_string(&detail, &["instId"])
                .or_else(|| value_string(&container, &["instId"]))
                .unwrap_or_default();
            if detail_inst == query.inst_id {
                rows.push(json!({
                    "id": desic_intelligence::stable_id("liquidation", &detail),
                    "instId": detail_inst, "side": value_string(&detail, &["side", "posSide"]),
                    "sz": value_string(&detail, &["sz"]), "bkPx": value_string(&detail, &["bkPx"]),
                    "ts": value_i64(&detail, &["ts"]).or_else(|| value_i64(&container, &["ts"]))
                }));
            }
        }
    }
    Ok(rows)
}

async fn fetch_derivatives_system_risk(
    app: &tauri::AppHandle,
    query: &DerivativesQuery,
) -> Result<Vec<Value>, String> {
    let family = linear_family(&query.inst_id);
    let insurance_path = query_path(
        INSURANCE_FUND_PATH,
        vec![
            ("instType", Some("SWAP".to_string())),
            ("instFamily", Some(family.clone())),
        ],
    );
    let limit_path = query_path(
        PRICE_LIMIT_PATH,
        vec![("instId", Some(query.inst_id.clone()))],
    );
    let (insurance, limits) = tokio::try_join!(
        intelligence_public_get(app, &insurance_path),
        intelligence_public_get(app, &limit_path)
    )?;
    let insurance_item = item_array(&insurance.data)
        .into_iter()
        .next()
        .unwrap_or_else(|| json!({}));
    let limit_item = item_array(&limits.data)
        .into_iter()
        .next()
        .unwrap_or_else(|| json!({}));
    let balance = value_string(&insurance_item, &["total", "balance"]).or_else(|| {
        insurance_item
            .get("details")
            .and_then(Value::as_array)
            .and_then(|values| values.last())
            .and_then(|value| value_string(value, &["balance", "amt"]))
    });
    if balance.is_none()
        || value_string(&limit_item, &["buyLmt", "maxBuy"]).is_none()
        || value_string(&limit_item, &["sellLmt", "minSell"]).is_none()
    {
        return Err(format!(
            "OKX system risk 响应结构与 {DERIVATIVES_VERSION} 不兼容，provider degraded"
        ));
    }
    Ok(vec![json!({
        "instId": query.inst_id, "ts": now_ms(), "insuranceBalance": balance,
        "upperLimit": value_string(&limit_item, &["buyLmt", "maxBuy"]),
        "lowerLimit": value_string(&limit_item, &["sellLmt", "minSell"]),
        "adlState": "unknown",
        "limitation": "ADL 状态仅在收到 OKX adl-warning WebSocket 事件时更新。",
    })])
}

async fn fetch_derivatives_position_tiers(
    app: &tauri::AppHandle,
    query: &DerivativesQuery,
) -> Result<Vec<Value>, String> {
    let path = query_path(
        POSITION_TIERS_PATH,
        vec![
            ("instType", Some("SWAP".to_string())),
            ("tdMode", Some("cross".to_string())),
            ("instFamily", Some(linear_family(&query.inst_id))),
        ],
    );
    let envelope = intelligence_public_get(app, &path).await?;
    let raw_items = item_array(&envelope.data);
    if raw_items.iter().any(|item| {
        value_string(item, &["tier"]).is_none() || value_string(item, &["maxSz"]).is_none()
    }) {
        return Err(format!(
            "OKX position tiers 响应结构与 {DERIVATIVES_VERSION} 不兼容，provider degraded"
        ));
    }
    Ok(raw_items.into_iter().map(|item| json!({
        "instFamily": value_string(&item, &["instFamily"]).unwrap_or_else(|| linear_family(&query.inst_id)),
        "tier": value_string(&item, &["tier"]), "minSz": value_string(&item, &["minSz"]),
        "maxSz": value_string(&item, &["maxSz"]), "mmr": value_string(&item, &["mmr"]),
        "imr": value_string(&item, &["imr"]), "maxLever": value_string(&item, &["maxLever"]),
    })).collect())
}

async fn derivatives_query_impl(
    app: tauri::AppHandle,
    kind: &str,
    query: DerivativesQuery,
) -> Result<IntelligenceResponse, String> {
    let query = query.normalize()?;
    let conn = open_intelligence_database(&app)?;
    if query.local_only.unwrap_or(false) {
        let mut items = if kind == "overview" {
            derivatives_overview_local(&conn, &query)?
        } else {
            query_derivatives_local(&conn, kind, &query)?
        };
        if kind == "positioning" {
            let _ = merge_live_oi_snapshot(&query, &mut items);
            enrich_positioning_prices(&conn, &query.inst_id, &mut items);
        }
        if kind == "crowding" {
            enrich_crowding_semantics(&mut items);
        }
        let mut response = derivatives_response(items, query.limit, false);
        if kind != "overview" {
            apply_derivative_response_metadata(&mut response, kind, &query);
        }
        if kind == "crowding" {
            response.limitations.push(
                "accountRatio/topAccountRatio 是多头账户数与空头账户数之比；topPositionRatio 是头部交易者多头持仓价值与空头持仓价值之比。"
                    .to_string(),
            );
        }
        return Ok(response);
    }
    let fetched = match kind {
        "positioning" => fetch_derivatives_positioning(&app, &query).await,
        "takerFlow" => fetch_derivatives_taker_flow(&app, &query).await,
        "crowding" => fetch_derivatives_crowding(&app, &query).await,
        "fundingBasis" => fetch_derivatives_funding_basis(&app, &query).await,
        "liquidations" => fetch_derivatives_liquidations(&app, &query).await,
        "systemRisk" => fetch_derivatives_system_risk(&app, &query).await,
        "positionTiers" => fetch_derivatives_position_tiers(&app, &query).await,
        "overview" => {
            for child in [
                "positioning",
                "takerFlow",
                "crowding",
                "fundingBasis",
                "systemRisk",
            ] {
                let _ = Box::pin(derivatives_query_impl(app.clone(), child, query.clone())).await;
            }
            return Ok(derivatives_response(
                derivatives_overview_local(&conn, &query)?,
                Some(1),
                false,
            ));
        }
        _ => return Err(format!("不支持的衍生品查询：{kind}")),
    };
    match fetched {
        Ok(mut items) => {
            if kind == "crowding" {
                enrich_crowding_semantics(&mut items);
            }
            upsert_derivatives_items(
                &conn,
                kind,
                &query.inst_id,
                query.period.as_deref().unwrap_or("5m"),
                &items,
                now_ms(),
            )?;
            let updated_at = now_ms();
            let _ = recompute_derivative_anomalies(&conn, &query.inst_id, updated_at);
            let _ = publish_anomaly_events(
                &conn,
                &query.inst_id,
                updated_at.saturating_sub(10 * 60_000),
            );
            let _ = refresh_news_reactions(&conn, updated_at);
            if kind == "systemRisk" {
                let historical_items = query_derivatives_local(&conn, kind, &query)?;
                let mut response = derivatives_response(historical_items, query.limit, false);
                apply_derivative_response_metadata(&mut response, kind, &query);
                response.limitations.push(
                    "System Stress 历史由本地快照逐步积累；远端刷新只提供当前值，不支持回补采集开始前的历史。"
                        .to_string(),
                );
                return Ok(response);
            }
            if kind == "positioning" {
                let _ = merge_live_oi_snapshot(&query, &mut items);
                enrich_positioning_prices(&conn, &query.inst_id, &mut items);
            }
            let mut response = derivatives_response(items, query.limit, false);
            apply_derivative_response_metadata(&mut response, kind, &query);
            if kind == "crowding" {
                response.limitations.push(
                    "accountRatio/topAccountRatio 是多头账户数与空头账户数之比；topPositionRatio 是头部交易者多头持仓价值与空头持仓价值之比。"
                        .to_string(),
                );
            }
            Ok(response)
        }
        Err(error) => {
            let mut items = query_derivatives_local(&conn, kind, &query)?;
            if kind == "positioning" {
                let _ = merge_live_oi_snapshot(&query, &mut items);
                enrich_positioning_prices(&conn, &query.inst_id, &mut items);
            }
            if kind == "crowding" {
                enrich_crowding_semantics(&mut items);
            }
            if items.is_empty() {
                return Err(error);
            }
            let mut response = derivatives_response(items, query.limit, true);
            apply_derivative_response_metadata(&mut response, kind, &query);
            if kind == "crowding" {
                response.limitations.push(
                    "accountRatio/topAccountRatio 是多头账户数与空头账户数之比；topPositionRatio 是头部交易者多头持仓价值与空头持仓价值之比。"
                        .to_string(),
                );
            }
            response
                .limitations
                .push(format!("远端刷新失败，已返回本地历史：{error}"));
            Ok(response)
        }
    }
}

macro_rules! derivatives_command {
    ($name:ident, $kind:literal) => {
        #[tauri::command]
        pub(crate) async fn $name(
            app: tauri::AppHandle,
            query: DerivativesQuery,
        ) -> Result<IntelligenceResponse, String> {
            derivatives_query_impl(app, $kind, query).await
        }
    };
}

derivatives_command!(intelligence_derivatives_overview, "overview");
derivatives_command!(intelligence_derivatives_positioning, "positioning");
derivatives_command!(intelligence_derivatives_taker_flow, "takerFlow");
derivatives_command!(intelligence_derivatives_crowding, "crowding");
derivatives_command!(intelligence_derivatives_funding_basis, "fundingBasis");
derivatives_command!(intelligence_derivatives_liquidations, "liquidations");
derivatives_command!(intelligence_derivatives_system_risk, "systemRisk");
derivatives_command!(intelligence_derivatives_position_tiers, "positionTiers");

async fn intelligence_derivative_decision_context(
    app: tauri::AppHandle,
    query: DerivativesQuery,
) -> Result<IntelligenceResponse, String> {
    let query = query.normalize()?;
    let wall_clock_now = now_ms();
    let decision_at = query.end_time.unwrap_or(wall_clock_now).min(wall_clock_now);
    let mut refresh_errors = Vec::new();
    if !query.local_only.unwrap_or(false) {
        for (kind, period, limit) in [
            ("positioning", "5m", 288),
            ("takerFlow", "5m", 288),
            ("positioning", "1H", 100),
            ("takerFlow", "1H", 100),
        ] {
            let refresh = DerivativesQuery {
                inst_id: query.inst_id.clone(),
                period: Some(period.to_string()),
                end_time: Some(decision_at),
                limit: Some(limit),
                local_only: Some(false),
                ..Default::default()
            };
            if let Err(error) = derivatives_query_impl(app.clone(), kind, refresh).await {
                refresh_errors.push(format!("{kind}/{period}: {error}"));
            }
        }
    }

    let mut periods = Vec::new();
    let mut series_metadata = Vec::new();
    let mut coverages = Vec::new();
    for (period, limit) in [("5m", 24), ("1H", 24), ("4H", 24)] {
        let series_query = DerivativesQuery {
            inst_id: query.inst_id.clone(),
            period: Some(period.to_string()),
            end_time: Some(decision_at),
            limit: Some(limit),
            local_only: Some(true),
            ..Default::default()
        };
        let positioning =
            derivatives_query_impl(app.clone(), "positioning", series_query.clone()).await?;
        let taker_flow = derivatives_query_impl(app.clone(), "takerFlow", series_query).await?;
        if let Some(value) = positioning.coverage {
            coverages.push(value);
        }
        if let Some(value) = taker_flow.coverage {
            coverages.push(value);
        }
        series_metadata.extend(positioning.series_metadata.clone());
        series_metadata.extend(taker_flow.series_metadata.clone());
        periods.push(json!({
            "granularity": period,
            "positioning": positioning.items,
            "takerFlow": taker_flow.items,
        }));
    }

    let fetched_at = series_metadata
        .iter()
        .filter_map(|value| value.fetched_at)
        .max()
        .unwrap_or(decision_at);
    let data_at = series_metadata
        .iter()
        .filter_map(|value| value.observed_at)
        .max();
    let stale = series_metadata.iter().any(|value| value.stale);
    let stale_reason = series_metadata
        .iter()
        .find_map(|value| value.stale_reason.clone());
    let mut response = derivatives_response(
        vec![json!({
            "instId": query.inst_id,
            "decisionAt": decision_at,
            "periods": periods,
        })],
        None,
        stale,
    );
    response.fetched_at = fetched_at;
    response.data_at = data_at;
    response.age_ms = data_at
        .map(|value| now_ms().saturating_sub(value))
        .unwrap_or(i64::MAX);
    response.stale_reason = stale_reason;
    response.series_metadata = series_metadata;
    response.coverage =
        (!coverages.is_empty()).then(|| coverages.iter().sum::<f64>() / coverages.len() as f64);
    response.data_version = Some(decision_at.to_string());
    if !refresh_errors.is_empty() {
        response.limitations.push(format!(
            "部分衍生品后台刷新失败，组合上下文已回退本地序列：{}",
            refresh_errors.join("；")
        ));
    }
    Ok(response)
}

#[tauri::command]
pub(crate) async fn intelligence_news_events_query(
    app: tauri::AppHandle,
    query: NewsEventQuery,
) -> Result<IntelligenceResponse, String> {
    run_intelligence_blocking(move || {
        let conn = open_intelligence_database(&app)?;
        Ok(local_response(
            query_news_events_local(&conn, &query)?,
            false,
        ))
    })
    .await
}

#[tauri::command]
pub(crate) async fn intelligence_news_event_detail(
    app: tauri::AppHandle,
    query: NewsEventQuery,
) -> Result<IntelligenceResponse, String> {
    let id = query
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "缺少新闻事件 ID".to_string())?
        .to_string();
    run_intelligence_blocking(move || {
        let conn = open_intelligence_database(&app)?;
        let _ = refresh_news_event_reactions(&conn, &id, now_ms());
        Ok(local_response(
            query_news_event_detail_local(&conn, &id)?,
            false,
        ))
    })
    .await
}

#[tauri::command]
pub(crate) async fn intelligence_news_reaction_query(
    app: tauri::AppHandle,
    query: NewsEventQuery,
) -> Result<IntelligenceResponse, String> {
    let id = query
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "缺少新闻事件 ID".to_string())?
        .to_string();
    run_intelligence_blocking(move || {
        let conn = open_intelligence_database(&app)?;
        let _ = refresh_news_event_reactions(&conn, &id, now_ms());
        let detail = query_news_event_detail_local(&conn, &id)?;
        let reactions = detail
            .first()
            .and_then(|value| value.get("reactions"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(local_response(reactions, false))
    })
    .await
}

#[tauri::command]
pub(crate) async fn intelligence_anomalies_query(
    app: tauri::AppHandle,
    query: DerivativesQuery,
) -> Result<IntelligenceResponse, String> {
    run_intelligence_blocking(move || {
        let conn = open_intelligence_database(&app)?;
        Ok(derivatives_response(
            query_anomalies_local(&conn, &query)?,
            query.limit,
            false,
        ))
    })
    .await
}

#[tauri::command]
pub(crate) fn intelligence_briefings_query(
    app: tauri::AppHandle,
    query: BriefingQuery,
) -> Result<IntelligenceResponse, String> {
    let conn = open_intelligence_database(&app)?;
    Ok(local_response(query_briefings_local(&conn, &query)?, false))
}

#[tauri::command]
pub(crate) fn intelligence_briefing_generate(
    app: tauri::AppHandle,
    request: BriefingGenerateRequest,
) -> Result<IntelligenceResponse, String> {
    let profile_id = request.profile_id.trim();
    if profile_id.is_empty() {
        return Err("生成市场简报必须显式选择 Agent Profile".to_string());
    }
    let shanghai = chrono::FixedOffset::east_opt(8 * 60 * 60)
        .ok_or_else(|| "无法构造 Asia/Shanghai 时区".to_string())?;
    let briefing_date = chrono::Utc::now()
        .with_timezone(&shanghai)
        .format("%Y-%m-%d")
        .to_string();
    let conn = open_intelligence_database(&app)?;
    let briefing = create_briefing(&conn, &briefing_date, Some(profile_id), now_ms())?;
    let briefing_id =
        value_string(&briefing, &["id"]).ok_or_else(|| "市场简报 ID 生成失败".to_string())?;
    let run = crate::ai_automation::queue_intelligence_briefing_run(
        &app,
        profile_id,
        &briefing_id,
        &briefing_date,
    )?;
    attach_briefing_run(&conn, &briefing_id, &run.id, now_ms())?;
    Ok(local_response(
        vec![json!({"briefing": briefing, "run": run})],
        false,
    ))
}

#[tauri::command]
pub(crate) async fn intelligence_summary(
    app: tauri::AppHandle,
) -> Result<IntelligenceSummary, String> {
    run_intelligence_blocking(move || {
        let conn = open_intelligence_database(&app)?;
        summary(&conn)
    })
    .await
}

#[tauri::command]
pub(crate) fn intelligence_sync_status(
    app: tauri::AppHandle,
) -> Result<Vec<IntelligenceSyncState>, String> {
    let conn = open_intelligence_database(&app)?;
    desic_intelligence::sync_states(&conn)
}

#[tauri::command]
pub(crate) fn intelligence_settings_summary(
    app: tauri::AppHandle,
) -> Result<IntelligenceSettings, String> {
    let conn = open_intelligence_database(&app)?;
    reconcile_intelligence_settings(&app, &conn)
}

#[tauri::command]
pub(crate) fn intelligence_settings_save(
    app: tauri::AppHandle,
    settings: IntelligenceSettings,
) -> Result<IntelligenceSettings, String> {
    if let Some(account_id) = settings.collector_account_id.as_deref() {
        let _ = validate_intelligence_account(load_local_account_secret(&app, Some(account_id))?)?;
    }
    let conn = open_intelligence_database(&app)?;
    save_settings(&conn, settings, now_ms())
}

#[tauri::command]
pub(crate) fn intelligence_track_trader(
    app: tauri::AppHandle,
    request: TrackedTraderRequest,
) -> Result<IntelligenceSummary, String> {
    let author_id = request.author_id.trim();
    if author_id.is_empty() || author_id.len() > 128 {
        return Err("交易员 ID 无效".to_string());
    }
    let conn = open_intelligence_database(&app)?;
    set_tracked_trader(
        &conn,
        author_id,
        request.nickname.as_deref().unwrap_or(""),
        request.tracked,
        now_ms(),
    )?;
    summary(&conn)
}

fn scope_interval_ms(settings: &IntelligenceSettings, scope: &str) -> i64 {
    let seconds = match scope {
        "news" => settings.news_poll_seconds as i64,
        "watchlistNews" => settings.watchlist_news_poll_seconds as i64,
        "sentiment" => settings.sentiment_poll_minutes as i64 * 60,
        "smartSignals" => settings.smart_money_poll_minutes as i64 * 60,
        "leaderboard" => settings.leaderboard_poll_minutes as i64 * 60,
        "trackedTraders" => settings.tracked_trader_poll_minutes as i64 * 60,
        "calendar" => settings.calendar_poll_hours as i64 * 3_600,
        "derivativesActive" => settings.active_derivatives_poll_seconds as i64,
        "derivativesFast" => settings.derivatives_poll_minutes as i64 * 60,
        "derivativesSlow" => settings.derivatives_slow_poll_minutes as i64 * 60,
        "derivativesRiskActive" => settings.active_derivatives_risk_poll_minutes as i64 * 60,
        "derivativesRisk" => settings.derivatives_risk_poll_minutes as i64 * 60,
        _ => 300,
    };
    seconds.saturating_mul(1_000)
}

fn due_collector_scopes(
    settings: &IntelligenceSettings,
    states: &[IntelligenceSyncState],
    now: i64,
) -> Vec<&'static str> {
    const SCOPES: [&str; 12] = [
        "derivativesActive",
        "derivativesRiskActive",
        "news",
        "watchlistNews",
        "sentiment",
        "smartSignals",
        "leaderboard",
        "trackedTraders",
        "calendar",
        "derivativesFast",
        "derivativesSlow",
        "derivativesRisk",
    ];
    SCOPES
        .into_iter()
        .filter(|scope| {
            states
                .iter()
                .find(|state| state.key == *scope)
                .map(|state| {
                    state.next_run_at.unwrap_or_else(|| {
                        state
                            .last_succeeded_at
                            .or(state.last_failed_at)
                            .unwrap_or(0)
                            .saturating_add(scope_interval_ms(settings, scope))
                    }) <= now
                })
                .unwrap_or(true)
        })
        .collect()
}

fn derivative_symbols(
    app: &tauri::AppHandle,
    settings: &IntelligenceSettings,
    fast: bool,
) -> Result<Vec<String>, String> {
    let mut symbols = std::collections::BTreeSet::new();
    if fast {
        let watchlist = load_watchlist_config_file(app)?;
        symbols.extend(
            watchlist
                .symbols
                .into_iter()
                .map(|value| value.trim().to_ascii_uppercase())
                .filter(|value| {
                    value.ends_with("-SWAP")
                        && (value.contains("-USDT-") || value.contains("-USDS-"))
                })
                .take(10),
        );
        if symbols.is_empty() {
            symbols.insert("BTC-USDT-SWAP".to_string());
        }
    } else {
        symbols.extend(settings.extra_instruments.iter().cloned().take(40));
    }
    Ok(symbols.into_iter().collect())
}

fn active_derivative_symbols(
    app: &tauri::AppHandle,
    runtime: &IntelligenceRuntime,
) -> Result<Vec<String>, String> {
    let mut symbols = HashMap::<String, u8>::new();
    let now = now_ms();
    if let Ok(mut active) = runtime.active_instruments.lock() {
        active.retain(|_, (touched_at, _)| now.saturating_sub(*touched_at) < 30 * 60_000);
        for (symbol, (_, priority)) in active.iter() {
            symbols
                .entry(symbol.clone())
                .and_modify(|value| *value = (*value).max(*priority))
                .or_insert(*priority);
        }
    }
    if let Ok(store) = app.state::<MarketRuntime>().store.lock() {
        let mut snapshots = store.private_snapshots.values().collect::<Vec<_>>();
        if let Some(snapshot) = store.private_snapshot.as_ref() {
            snapshots.push(snapshot);
        }
        for position in snapshots
            .into_iter()
            .flat_map(|snapshot| &snapshot.positions)
        {
            if position
                .pos
                .parse::<f64>()
                .ok()
                .is_some_and(|value| value.abs() > 0.0)
            {
                symbols
                    .entry(position.inst_id.trim().to_ascii_uppercase())
                    .and_modify(|value| *value = (*value).max(3))
                    .or_insert(3);
            }
        }
    }
    if let Ok(conn) = open_database(app) {
        if let Ok(mut stmt) = conn.prepare(
            "SELECT symbols_json FROM ai_agent_profiles
             WHERE enabled=1 AND deleted_at IS NULL ORDER BY updated_at DESC",
        ) {
            if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
                for raw in rows.flatten() {
                    for symbol in serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default() {
                        symbols
                            .entry(symbol.trim().to_ascii_uppercase())
                            .and_modify(|value| *value = (*value).max(1))
                            .or_insert(1);
                    }
                }
            }
        }
    }
    let mut symbols = symbols
        .into_iter()
        .filter(|(value, _)| {
            value.ends_with("-SWAP") && (value.contains("-USDT-") || value.contains("-USDS-"))
        })
        .collect::<Vec<_>>();
    symbols.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    Ok(symbols.into_iter().map(|(symbol, _)| symbol).collect())
}

async fn sync_derivative_symbols(
    app: &tauri::AppHandle,
    symbols: Vec<String>,
    period: &str,
    include_risk: bool,
) -> Result<u64, String> {
    let mut rows = 0_u64;
    let mut errors = Vec::new();
    for inst_id in symbols {
        let query = DerivativesQuery {
            inst_id: inst_id.clone(),
            period: Some(period.to_string()),
            limit: Some(100),
            ..Default::default()
        };
        let mut kinds = vec!["positioning", "takerFlow", "crowding", "fundingBasis"];
        if include_risk {
            kinds.extend(["liquidations", "systemRisk", "positionTiers"]);
        }
        for kind in kinds {
            match derivatives_query_impl(app.clone(), kind, query.clone()).await {
                Ok(response) => rows = rows.saturating_add(response.items.len() as u64),
                Err(error) => errors.push(format!("{inst_id}/{kind}: {error}")),
            }
        }
    }
    if rows == 0 && !errors.is_empty() {
        Err(errors.join("；"))
    } else {
        Ok(rows)
    }
}

async fn sync_derivative_risk_symbols(
    app: &tauri::AppHandle,
    symbols: Vec<String>,
) -> Result<u64, String> {
    let mut rows = 0_u64;
    let mut errors = Vec::new();
    for inst_id in symbols {
        let query = DerivativesQuery {
            inst_id: inst_id.clone(),
            period: Some("1H".to_string()),
            limit: Some(100),
            ..Default::default()
        };
        for kind in ["liquidations", "systemRisk", "positionTiers"] {
            match derivatives_query_impl(app.clone(), kind, query.clone()).await {
                Ok(response) => rows = rows.saturating_add(response.items.len() as u64),
                Err(error) => errors.push(format!("{inst_id}/{kind}: {error}")),
            }
        }
    }
    if rows == 0 && !errors.is_empty() {
        Err(errors.join("；"))
    } else {
        Ok(rows)
    }
}

async fn sync_scope(
    app: &tauri::AppHandle,
    runtime: &IntelligenceRuntime,
    account_id: Option<String>,
    scope: &str,
) -> Result<u64, String> {
    let conn = open_intelligence_database(app)?;
    let started = now_ms();
    set_sync_state(&conn, scope, "running", started, None, None, 0)?;
    let result: Result<u64, String> = match scope {
        "news" => fetch_news(
            app,
            &IntelligenceQuery {
                account_id,
                language: Some("zh-CN".to_string()),
                limit: Some(50),
                ..Default::default()
            },
        )
        .await
        .map(|response| response.items.len() as u64),
        "watchlistNews" => {
            let watchlist = load_watchlist_config_file(app)?;
            let coins = watchlist
                .symbols
                .iter()
                .filter_map(|symbol| symbol.split('-').next())
                .map(str::to_uppercase)
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .take(20)
                .collect::<Vec<_>>();
            if coins.is_empty() {
                Ok(0)
            } else {
                fetch_news(
                    app,
                    &IntelligenceQuery {
                        account_id,
                        coins: Some(coins),
                        language: Some("zh-CN".to_string()),
                        limit: Some(50),
                        ..Default::default()
                    },
                )
                .await
                .map(|response| response.items.len() as u64)
            }
        }
        "sentiment" => intelligence_sentiment_query(
            app.clone(),
            SentimentQuery {
                account_id,
                period: Some("24h".to_string()),
                sort_by: Some("hot".to_string()),
                limit: Some(30),
                ..Default::default()
            },
        )
        .await
        .map(|response| response.items.len() as u64),
        "trackedTraders" => {
            let traders = tracked_traders(&conn)?;
            let mut rows = 0_u64;
            for trader in traders.into_iter().take(50) {
                let Some(author_id) = value_string(&trader, &["authorId"]) else {
                    continue;
                };
                for query in [
                    SmartMoneyQuery {
                        account_id: account_id.clone(),
                        operation: "performance".to_string(),
                        author_ids: Some(vec![author_id.clone()]),
                        period: Some("90".to_string()),
                        ..Default::default()
                    },
                    SmartMoneyQuery {
                        account_id: account_id.clone(),
                        operation: "positions".to_string(),
                        author_id: Some(author_id.clone()),
                        limit: Some(100),
                        ..Default::default()
                    },
                ] {
                    rows = rows.saturating_add(
                        intelligence_smart_query(app.clone(), query)
                            .await?
                            .items
                            .len() as u64,
                    );
                }
            }
            Ok(rows)
        }
        "calendar" => fetch_calendar(
            app,
            runtime,
            CalendarQuery {
                account_id,
                start_time: Some(started - 7 * 86_400_000),
                end_time: Some(started + 35 * 86_400_000),
                limit: Some(1_000),
                ..Default::default()
            },
        )
        .await
        .map(|response| {
            u64::from(
                response
                    .expected_points
                    .unwrap_or(response.items.len().min(u32::MAX as usize) as u32),
            )
        }),
        "smartSignals" => {
            let overview = intelligence_smart_query(
                app.clone(),
                SmartMoneyQuery {
                    account_id: account_id.clone(),
                    operation: "signalOverviewByFilter".to_string(),
                    top_instruments: Some(20),
                    sort_type: Some("pnl".to_string()),
                    period: Some("7".to_string()),
                    ..Default::default()
                },
            )
            .await?;
            let mut rows = overview.items.len() as u64;
            let mut history_errors = Vec::new();
            let data_version = overview
                .data_version
                .clone()
                .filter(|value| value.len() == 10)
                .unwrap_or(smart_data_version_from_ms(&started.to_string())?);
            for inst_id in active_derivative_symbols(app, runtime)? {
                let inst_ccy = inst_id
                    .split('-')
                    .next()
                    .unwrap_or_default()
                    .to_ascii_uppercase();
                let cached = conn
                    .query_row(
                        "SELECT COUNT(*) FROM intelligence_smart_signals
                         WHERE inst_ccy=?1 AND data_version=?2 AND granularity='1h'
                           AND scope_key LIKE 'signalTrend%'",
                        params![inst_ccy, data_version],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(|error| error.to_string())?;
                if cached > 0 {
                    continue;
                }
                match intelligence_smart_query(
                    app.clone(),
                    SmartMoneyQuery {
                        account_id: account_id.clone(),
                        operation: "signalTrendByFilter".to_string(),
                        inst_id: Some(inst_id.clone()),
                        inst_ccy: Some(inst_ccy),
                        data_version: Some(data_version.clone()),
                        granularity: Some("1h".to_string()),
                        sort_type: Some("pnl".to_string()),
                        period: Some("7".to_string()),
                        limit: Some(24),
                        ..Default::default()
                    },
                )
                .await
                {
                    Ok(response) => rows = rows.saturating_add(response.items.len() as u64),
                    Err(error) => history_errors.push(format!("{inst_id}: {error}")),
                }
            }
            if history_errors.is_empty() {
                Ok(rows)
            } else {
                Err(format!(
                    "Smart Money 当前概览已更新，但小时历史补采失败：{}",
                    history_errors.join("；")
                ))
            }
        }
        "leaderboard" => intelligence_smart_query(
            app.clone(),
            SmartMoneyQuery {
                account_id,
                operation: "traders".to_string(),
                sort_type: Some("pnl".to_string()),
                period: Some("90".to_string()),
                limit: Some(30),
                ..Default::default()
            },
        )
        .await
        .map(|response| response.items.len() as u64),
        "derivativesFast" => {
            let settings = load_settings(&conn)?;
            sync_derivative_symbols(app, derivative_symbols(app, &settings, true)?, "5m", false)
                .await
        }
        "derivativesActive" => {
            sync_derivative_symbols(app, active_derivative_symbols(app, runtime)?, "5m", false)
                .await
        }
        "derivativesSlow" => {
            let settings = load_settings(&conn)?;
            let symbols = derivative_symbols(app, &settings, false)?;
            if symbols.is_empty() {
                Ok(0)
            } else {
                sync_derivative_symbols(app, symbols, "1H", false).await
            }
        }
        "derivativesRisk" => {
            let settings = load_settings(&conn)?;
            sync_derivative_risk_symbols(app, derivative_symbols(app, &settings, true)?).await
        }
        "derivativesRiskActive" => {
            sync_derivative_risk_symbols(app, active_derivative_symbols(app, runtime)?).await
        }
        _ => Err(format!("不支持的情报同步范围：{scope}")),
    };
    let finished = now_ms();
    let settings = load_settings(&conn).unwrap_or_default();
    let success_next = finished.saturating_add(scope_interval_ms(&settings, scope));
    let retry_next = finished.saturating_add(scope_interval_ms(&settings, scope).min(300_000));
    match &result {
        Ok(rows) => set_sync_state(
            &conn,
            scope,
            "success",
            finished,
            Some(success_next),
            None,
            *rows,
        )?,
        Err(error) => set_sync_state(
            &conn,
            scope,
            "failed",
            finished,
            Some(retry_next),
            Some(error),
            0,
        )?,
    }
    result
}

async fn sync_now_impl(
    app: &tauri::AppHandle,
    runtime: &IntelligenceRuntime,
    request: IntelligenceSyncRequest,
) -> Result<IntelligenceSummary, String> {
    let conn = open_intelligence_database(app)?;
    let settings = reconcile_intelligence_settings(app, &conn)?;
    let account_id = request.account_id.or(settings.collector_account_id.clone());
    let scopes = match request.scope.as_deref() {
        Some(scope) if scope != "all" => vec![scope.to_string()],
        _ => vec![
            "news".to_string(),
            "watchlistNews".to_string(),
            "sentiment".to_string(),
            "smartSignals".to_string(),
            "leaderboard".to_string(),
            "trackedTraders".to_string(),
            "calendar".to_string(),
            "derivativesActive".to_string(),
            "derivativesFast".to_string(),
            "derivativesSlow".to_string(),
            "derivativesRiskActive".to_string(),
            "derivativesRisk".to_string(),
        ],
    };
    let results = futures_util::stream::iter(scopes.into_iter().map(|scope| {
        let account_id = account_id.clone();
        async move {
            let key = format!(
                "scope:{}:{scope}",
                account_id.as_deref().unwrap_or("public")
            );
            {
                let mut inflight = runtime.refresh_inflight.lock().await;
                if !inflight.insert(key.clone()) {
                    return (scope, Ok(0_u64));
                }
            }
            let permit = runtime.refresh_slots.clone().acquire_owned().await;
            let result = match permit {
                Ok(_permit) => sync_scope(app, runtime, account_id, &scope).await,
                Err(_) => Err("市场情报采集队列已关闭".to_string()),
            };
            runtime.refresh_inflight.lock().await.remove(&key);
            (scope, result)
        }
    }))
    .buffer_unordered(3)
    .collect::<Vec<_>>()
    .await;
    let errors = results
        .into_iter()
        .filter_map(|(scope, result)| result.err().map(|error| format!("{scope}: {error}")))
        .collect::<Vec<_>>();
    let conn = open_intelligence_database(app)?;
    let retention_now = now_ms();
    let previous_retention = LAST_INTELLIGENCE_RETENTION_AT.load(Ordering::Acquire);
    if retention_now.saturating_sub(previous_retention) >= INTELLIGENCE_RETENTION_INTERVAL_MS
        && LAST_INTELLIGENCE_RETENTION_AT
            .compare_exchange(
                previous_retention,
                retention_now,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
        && run_retention(&conn, retention_now, &settings).is_err()
    {
        LAST_INTELLIGENCE_RETENTION_AT.store(previous_retention, Ordering::Release);
    }
    let result = summary(&conn)?;
    let _ = app.emit(
        INTELLIGENCE_EVENT,
        json!({
            "type": if errors.is_empty() { "syncCompleted" } else { "syncDegraded" },
            "errors": errors,
            "timestamp": now_ms(),
        }),
    );
    Ok(result)
}

#[tauri::command]
pub(crate) async fn intelligence_sync_now(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, IntelligenceRuntime>,
    request: IntelligenceSyncRequest,
) -> Result<IntelligenceSummary, String> {
    sync_now_impl(&app, runtime.inner(), request).await
}

fn maybe_queue_daily_briefing(
    app: &tauri::AppHandle,
    settings: &IntelligenceSettings,
) -> Result<(), String> {
    if !settings.briefing_enabled {
        return Ok(());
    }
    let profile_id = settings
        .briefing_profile_id
        .as_deref()
        .ok_or_else(|| "市场简报已启用但未选择 Agent Profile".to_string())?;
    let shanghai = chrono::FixedOffset::east_opt(8 * 60 * 60)
        .ok_or_else(|| "无法构造 Asia/Shanghai 时区".to_string())?;
    let local_now = chrono::Utc::now().with_timezone(&shanghai);
    use chrono::Timelike;
    if !(8..14).contains(&local_now.hour()) {
        return Ok(());
    }
    let briefing_date = local_now.format("%Y-%m-%d").to_string();
    let conn = open_intelligence_database(app)?;
    let existing = query_briefings_local(
        &conn,
        &BriefingQuery {
            profile_id: Some(profile_id.to_string()),
            briefing_date: Some(briefing_date.clone()),
            limit: Some(1),
        },
    )?;
    if let Some(item) = existing.first() {
        if value_string(item, &["status"]).as_deref() != Some("failed") {
            return Ok(());
        }
        if let Some(id) = value_string(item, &["id"]) {
            conn.execute(
                "DELETE FROM intelligence_briefings WHERE id=?1",
                params![id],
            )
            .map_err(|error| error.to_string())?;
        }
    }
    let briefing = create_briefing(&conn, &briefing_date, Some(profile_id), now_ms())?;
    let briefing_id =
        value_string(&briefing, &["id"]).ok_or_else(|| "市场简报 ID 生成失败".to_string())?;
    match crate::ai_automation::queue_intelligence_briefing_run(
        app,
        profile_id,
        &briefing_id,
        &briefing_date,
    ) {
        Ok(run) => attach_briefing_run(&conn, &briefing_id, &run.id, now_ms()),
        Err(error) => {
            let _ = conn.execute(
                "UPDATE intelligence_briefings SET status='failed',error=?2,updated_at=?3 WHERE id=?1",
                params![briefing_id, error, now_ms()],
            );
            Err(error)
        }
    }
}

fn handle_derivatives_stream_message(app: &tauri::AppHandle, text: &str) -> Result<(), String> {
    let value: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
    if value.get("event").is_some() {
        return Ok(());
    }
    let channel = value
        .pointer("/arg/channel")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let data = value.get("data").cloned().unwrap_or(Value::Null);
    let now = now_ms();
    let bucket = now / 300_000 * 300_000;
    let conn = open_intelligence_database(app)?;
    let mut changed = 0_u64;
    match channel {
        "open-interest" => {
            for item in item_array(&data) {
                let inst_id = value_string(&item, &["instId"]).unwrap_or_default();
                if inst_id.is_empty() {
                    continue;
                }
                let source_ts = value_i64(&item, &["ts"]).unwrap_or(now);
                let oi_bucket = source_ts / 300_000 * 300_000;
                let normalized = json!({
                    "instId": inst_id, "ts": oi_bucket, "sourceTs": source_ts,
                    "observedAt": source_ts, "receivedAt": now,
                    "oi": value_string(&item, &["oi"]), "oiCcy": value_string(&item, &["oiCcy"]),
                    "oiUsd": value_string(&item, &["oiUsd"]), "stream": true,
                });
                let previous = {
                    let mut cache = OI_STREAM_CACHE
                        .lock()
                        .map_err(|_| "OI stream cache poisoned".to_string())?;
                    let previous = cache
                        .get(&inst_id)
                        .filter(|(cached_bucket, _)| *cached_bucket != oi_bucket)
                        .cloned();
                    cache.insert(inst_id.clone(), (oi_bucket, normalized));
                    previous
                };
                if let Some((_, previous)) = previous {
                    changed = changed.saturating_add(upsert_derivatives_items(
                        &conn,
                        "positioning",
                        &inst_id,
                        "5m",
                        &[previous],
                        now,
                    )?);
                }
            }
        }
        "funding-rate" => {
            for item in item_array(&data) {
                let inst_id = value_string(&item, &["instId"]).unwrap_or_default();
                if inst_id.is_empty() {
                    continue;
                }
                let signature = format!(
                    "{}:{}:{}:{}",
                    value_string(&item, &["fundingRate"]).unwrap_or_default(),
                    value_string(&item, &["nextFundingRate"]).unwrap_or_default(),
                    value_i64(&item, &["fundingTime"]).unwrap_or_default(),
                    value_i64(&item, &["nextFundingTime"]).unwrap_or_default(),
                );
                let (rate_changed, bucket_changed) = {
                    let mut cache = FUNDING_STREAM_CACHE
                        .lock()
                        .map_err(|_| "funding stream cache poisoned".to_string())?;
                    let previous = cache.get(&inst_id).cloned();
                    cache.insert(inst_id.clone(), (bucket, signature.clone()));
                    (
                        previous
                            .as_ref()
                            .map(|(_, value)| value != &signature)
                            .unwrap_or(true),
                        previous
                            .as_ref()
                            .map(|(value, _)| *value != bucket)
                            .unwrap_or(true),
                    )
                };
                if !rate_changed && !bucket_changed {
                    continue;
                }
                let normalized = json!({
                    "instId": inst_id,
                    "ts": if rate_changed { value_i64(&item, &["ts"]).unwrap_or(now) } else { bucket },
                    "fundingRate": value_string(&item, &["fundingRate"]),
                    "nextFundingRate": value_string(&item, &["nextFundingRate"]),
                    "fundingTime": value_i64(&item, &["fundingTime"]),
                    "nextFundingTime": value_i64(&item, &["nextFundingTime"]), "stream": true,
                });
                changed = changed.saturating_add(upsert_derivatives_items(
                    &conn,
                    "fundingBasis",
                    &inst_id,
                    "5m",
                    &[normalized],
                    now,
                )?);
            }
        }
        "liquidation-orders" => {
            for container in item_array(&data) {
                let details = container
                    .get("details")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_else(|| vec![container.clone()]);
                for detail in details {
                    let inst_id = value_string(&detail, &["instId"])
                        .or_else(|| value_string(&container, &["instId"]))
                        .unwrap_or_default();
                    if inst_id.is_empty() {
                        continue;
                    }
                    let normalized = json!({
                        "id": desic_intelligence::stable_id("liquidation", &detail), "instId": inst_id,
                        "ts": value_i64(&detail, &["ts"]).or_else(|| value_i64(&container, &["ts"])).unwrap_or(now),
                        "side": value_string(&detail, &["side", "posSide"]), "sz": value_string(&detail, &["sz"]),
                        "bkPx": value_string(&detail, &["bkPx"]), "stream": true,
                    });
                    changed = changed.saturating_add(upsert_derivatives_items(
                        &conn,
                        "liquidations",
                        &inst_id,
                        "event",
                        &[normalized],
                        now,
                    )?);
                }
            }
        }
        "adl-warning" => {
            for item in item_array(&data) {
                let inst_id = value_string(&item, &["instId"]).unwrap_or_else(|| {
                    value
                        .pointer("/arg/instFamily")
                        .and_then(Value::as_str)
                        .map(|family| format!("{family}-SWAP"))
                        .unwrap_or_default()
                });
                if inst_id.is_empty() {
                    continue;
                }
                let normalized = json!({
                    "instId": inst_id, "ts": bucket, "adlState": "warning", "details": item, "stream": true,
                });
                changed = changed.saturating_add(upsert_derivatives_items(
                    &conn,
                    "systemRisk",
                    &inst_id,
                    "5m",
                    &[normalized],
                    now,
                )?);
            }
        }
        _ => {}
    }
    if changed > 0 {
        let _ = app.emit(
            INTELLIGENCE_EVENT,
            json!({
                "type": "derivativesStreamUpdated", "channel": channel,
                "rowsWritten": changed, "timestamp": now,
            }),
        );
    }
    Ok(())
}

async fn run_derivatives_stream(
    app: tauri::AppHandle,
    runtime: &IntelligenceRuntime,
) -> Result<(), String> {
    let settings = load_settings(&open_intelligence_database(&app)?)?;
    let mut symbols = derivative_symbols(&app, &settings, true)?;
    symbols.extend(active_derivative_symbols(&app, runtime)?);
    symbols.sort();
    symbols.dedup();
    let mut socket = connect_okx_ws(PUBLIC_WS).await?;
    let mut args = Vec::new();
    for inst_id in &symbols {
        args.push(json!({"channel": "open-interest", "instId": inst_id}));
        args.push(json!({"channel": "funding-rate", "instId": inst_id}));
        args.push(json!({"channel": "adl-warning", "instType": "SWAP", "instFamily": linear_family(inst_id)}));
    }
    args.push(json!({"channel": "liquidation-orders", "instType": "SWAP"}));
    socket
        .send(Message::Text(
            json!({"op": "subscribe", "args": args}).to_string(),
        ))
        .await
        .map_err(|error| error.to_string())?;
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(15 * 60) {
        match timeout(Duration::from_secs(45), socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                let _ = handle_derivatives_stream_message(&app, &text);
            }
            Ok(Some(Ok(Message::Ping(payload)))) => {
                socket
                    .send(Message::Pong(payload))
                    .await
                    .map_err(|error| error.to_string())?;
            }
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) => break,
            Ok(Some(Err(error))) => return Err(error.to_string()),
            Err(_) => {
                socket
                    .send(Message::Ping(Vec::new()))
                    .await
                    .map_err(|error| error.to_string())?;
            }
            _ => {}
        }
    }
    Ok(())
}

fn start_derivatives_stream(app: tauri::AppHandle, runtime: IntelligenceRuntime) {
    if runtime
        .derivatives_stream_started
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(error) = run_derivatives_stream(app.clone(), &runtime).await {
                let _ = app.emit(
                    INTELLIGENCE_EVENT,
                    json!({
                        "type": "derivativesStreamDegraded", "error": error, "timestamp": now_ms(),
                    }),
                );
            }
            sleep(Duration::from_secs(15)).await;
        }
    });
}

pub(crate) fn start_intelligence_collector(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, IntelligenceRuntime>,
) {
    if runtime.started.swap(true, Ordering::SeqCst) {
        return;
    }
    let runtime_handle = runtime.inner().clone();
    start_derivatives_stream(app.clone(), runtime_handle.clone());
    tauri::async_runtime::spawn(async move {
        let mut first_pass = true;
        loop {
            let database = open_intelligence_database(&app);
            let settings = database
                .as_ref()
                .ok()
                .and_then(|conn| reconcile_intelligence_settings(&app, conn).ok())
                .unwrap_or_default();
            if settings.enabled {
                let _ = maybe_queue_daily_briefing(&app, &settings);
                let states = database
                    .as_ref()
                    .ok()
                    .and_then(|conn| sync_states(conn).ok())
                    .unwrap_or_default();
                let mut due = due_collector_scopes(&settings, &states, now_ms())
                    .into_iter()
                    .filter(|scope| {
                        let signed_scope = matches!(
                            *scope,
                            "news"
                                | "watchlistNews"
                                | "sentiment"
                                | "smartSignals"
                                | "leaderboard"
                                | "trackedTraders"
                                | "calendar"
                        );
                        !signed_scope || settings.collector_account_id.is_some()
                    })
                    .map(str::to_string)
                    .collect::<Vec<_>>();
                if first_pass {
                    for scope in ["derivativesRiskActive", "derivativesActive"] {
                        if !due.iter().any(|value| value == scope) {
                            due.insert(0, scope.to_string());
                        }
                    }
                }
                futures_util::stream::iter(due)
                    .for_each_concurrent(3, |scope| {
                        let account_id = settings.collector_account_id.clone();
                        let app = app.clone();
                        let runtime = runtime_handle.clone();
                        async move {
                            let _ = sync_now_impl(
                                &app,
                                &runtime,
                                IntelligenceSyncRequest {
                                    account_id,
                                    scope: Some(scope),
                                },
                            )
                            .await;
                        }
                    })
                    .await;
            }
            first_pass = false;
            sleep(Duration::from_secs(30)).await;
        }
    });
}

fn validate_intelligence_tool_input(input: &Value) -> Result<(), String> {
    if let Some(map) = input.as_object() {
        for key in [
            "accountId",
            "environment",
            "apiKey",
            "secretKey",
            "passphrase",
            "cliProfile",
            "profile",
        ] {
            if map.contains_key(key) {
                return Err(format!(
                    "市场情报工具参数禁止提供 {key}，账户上下文由应用注入"
                ));
            }
        }
    }
    Ok(())
}

async fn execute_intelligence_tool_impl(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, IntelligenceRuntime>,
    name: &str,
    mut input: Value,
    forced_account_id: Option<&str>,
) -> Result<Value, String> {
    validate_intelligence_tool_input(&input)?;
    if let Some(account_id) = forced_account_id {
        if let Some(map) = input.as_object_mut() {
            map.insert(
                "accountId".to_string(),
                Value::String(account_id.to_string()),
            );
        }
    }
    let result = match name {
        "intelligence.news.list" | "intelligence.news.search" => {
            let query = serde_json::from_value::<IntelligenceQuery>(input)
                .map_err(|error| error.to_string())?;
            serde_json::to_value(intelligence_news_query(app, query).await?)
        }
        "intelligence.news.readDetail" => {
            let request = serde_json::from_value::<IntelligenceDetailRequest>(input)
                .map_err(|error| error.to_string())?;
            serde_json::to_value(intelligence_news_detail(app, request).await?)
        }
        "intelligence.news.listSources" => {
            if input
                .get("_agentLocalOnly")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                let conn = open_intelligence_database(&app)?;
                let mut stmt = conn
                    .prepare(
                        "SELECT platform,COUNT(*) FROM intelligence_news_articles
                         WHERE platform<>'' GROUP BY platform ORDER BY COUNT(*) DESC LIMIT 100",
                    )
                    .map_err(|error| error.to_string())?;
                let rows = stmt
                    .query_map([], |row| {
                        Ok(json!({
                            "platform": row.get::<_, String>(0)?,
                            "count": row.get::<_, i64>(1)?,
                        }))
                    })
                    .map_err(|error| error.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| error.to_string())?;
                return serde_json::to_value(local_response(rows, false))
                    .map_err(|error| error.to_string());
            }
            let account_id = input
                .get("accountId")
                .and_then(Value::as_str)
                .map(str::to_string);
            serde_json::to_value(intelligence_news_sources(app, account_id).await?)
        }
        "intelligence.news.readCoinSentiment"
        | "intelligence.news.readCoinSentimentTrend"
        | "intelligence.news.readSentimentRanking" => {
            let mut query = serde_json::from_value::<SentimentQuery>(input)
                .map_err(|error| error.to_string())?;
            if name == "intelligence.news.readCoinSentimentTrend" && query.trend_points.is_none() {
                query.trend_points = Some(24);
            }
            if name == "intelligence.news.readSentimentRanking" {
                query.coins = None;
            }
            serde_json::to_value(intelligence_sentiment_query(app, query).await?)
        }
        "intelligence.news.readEconomicCalendar" => {
            let query = serde_json::from_value::<CalendarQuery>(input)
                .map_err(|error| error.to_string())?;
            serde_json::to_value(intelligence_calendar_query(app, runtime, query).await?)
        }
        "intelligence.news.listEvents" => {
            let query = serde_json::from_value::<NewsEventQuery>(input)
                .map_err(|error| error.to_string())?;
            serde_json::to_value(intelligence_news_events_query(app, query).await?)
        }
        "intelligence.news.readEvent" => {
            let query = serde_json::from_value::<NewsEventQuery>(input)
                .map_err(|error| error.to_string())?;
            serde_json::to_value(intelligence_news_event_detail(app, query).await?)
        }
        "intelligence.news.readMarketReaction" => {
            let query = serde_json::from_value::<NewsEventQuery>(input)
                .map_err(|error| error.to_string())?;
            serde_json::to_value(intelligence_news_reaction_query(app, query).await?)
        }
        "intelligence.news.listAnomalies" => {
            let query = serde_json::from_value::<DerivativesQuery>(input)
                .map_err(|error| error.to_string())?;
            serde_json::to_value(intelligence_anomalies_query(app, query).await?)
        }
        "intelligence.news.readDailyBriefing" => {
            let query = serde_json::from_value::<BriefingQuery>(input)
                .map_err(|error| error.to_string())?;
            serde_json::to_value(intelligence_briefings_query(app, query)?)
        }
        "intelligence.smartMoney.readMarketPositioning"
        | "intelligence.smartMoney.readPositionChanges" => {
            let query = serde_json::from_value::<DerivativesQuery>(input)
                .map_err(|error| error.to_string())?;
            serde_json::to_value(intelligence_derivatives_positioning(app, query).await?)
        }
        "intelligence.smartMoney.readTakerFlow" => {
            let query = serde_json::from_value::<DerivativesQuery>(input)
                .map_err(|error| error.to_string())?;
            serde_json::to_value(intelligence_derivatives_taker_flow(app, query).await?)
        }
        "intelligence.smartMoney.readDerivativeDecisionContext" => {
            let query = serde_json::from_value::<DerivativesQuery>(input)
                .map_err(|error| error.to_string())?;
            serde_json::to_value(intelligence_derivative_decision_context(app, query).await?)
        }
        "intelligence.smartMoney.readCrowdingComparison"
        | "intelligence.smartMoney.readConsensusDivergence" => {
            let query = serde_json::from_value::<DerivativesQuery>(input)
                .map_err(|error| error.to_string())?;
            serde_json::to_value(intelligence_derivatives_crowding(app, query).await?)
        }
        "intelligence.smartMoney.readFundingBasis" => {
            let query = serde_json::from_value::<DerivativesQuery>(input)
                .map_err(|error| error.to_string())?;
            serde_json::to_value(intelligence_derivatives_funding_basis(app, query).await?)
        }
        "intelligence.smartMoney.readLiquidationSamples" => {
            let query = serde_json::from_value::<DerivativesQuery>(input)
                .map_err(|error| error.to_string())?;
            serde_json::to_value(intelligence_derivatives_liquidations(app, query).await?)
        }
        "intelligence.smartMoney.readSystemStress" => {
            let query = serde_json::from_value::<DerivativesQuery>(input)
                .map_err(|error| error.to_string())?;
            serde_json::to_value(intelligence_derivatives_system_risk(app, query).await?)
        }
        value if value.starts_with("intelligence.smartMoney.") => {
            let mut query = serde_json::from_value::<SmartMoneyQuery>(input)
                .map_err(|error| error.to_string())?;
            query.operation = match value {
                "intelligence.smartMoney.listTradersByFilter" => "traders",
                "intelligence.smartMoney.searchTrader" => "searchTrader",
                "intelligence.smartMoney.readPerformanceByTrader" => "performance",
                "intelligence.smartMoney.readTraderPositions" => "positions",
                "intelligence.smartMoney.readTraderPositionHistory" => "positionHistory",
                "intelligence.smartMoney.readTraderOrderHistory" => "orderHistory",
                "intelligence.smartMoney.readSignalOverviewByFilter" => "signalOverviewByFilter",
                "intelligence.smartMoney.readSignalOverviewByTrader" => "signalOverviewByTrader",
                "intelligence.smartMoney.readSignalTrendByFilter" => "signalTrendByFilter",
                "intelligence.smartMoney.readSignalTrendByTrader" => "signalTrendByTrader",
                _ => return Err(format!("未知 Smart Money 工具：{value}")),
            }
            .to_string();
            serde_json::to_value(intelligence_smart_query(app, query).await?)
        }
        _ => return Err(format!("未知情报工具：{name}")),
    }
    .map_err(|error| error.to_string())?;
    Ok(result)
}

fn intelligence_tool_scope(name: &str) -> &'static str {
    match name {
        value
            if value.starts_with("intelligence.news.readCoinSentiment")
                || value == "intelligence.news.readSentimentRanking" =>
        {
            "sentiment"
        }
        "intelligence.news.readEconomicCalendar" => "calendar",
        "intelligence.news.list"
        | "intelligence.news.search"
        | "intelligence.news.readDetail"
        | "intelligence.news.listSources" => "news",
        "intelligence.smartMoney.listTradersByFilter"
        | "intelligence.smartMoney.searchTrader"
        | "intelligence.smartMoney.readPerformanceByTrader" => "leaderboard",
        value if value.starts_with("intelligence.smartMoney.readTrader") => "trackedTraders",
        "intelligence.smartMoney.readSystemStress" => "derivativesRiskActive",
        value
            if value.starts_with("intelligence.smartMoney.readDerivative")
                || value.starts_with("intelligence.smartMoney.readMarket")
                || value.starts_with("intelligence.smartMoney.readTaker")
                || value.starts_with("intelligence.smartMoney.readCrowding")
                || value.starts_with("intelligence.smartMoney.readFunding")
                || value.starts_with("intelligence.smartMoney.readLiquidation")
                || value.starts_with("intelligence.smartMoney.readPosition")
                || value.starts_with("intelligence.smartMoney.readConsensus") =>
        {
            "derivativesActive"
        }
        value if value.starts_with("intelligence.smartMoney.") => "smartSignals",
        _ => "news",
    }
}

fn intelligence_data_at(items: &[Value]) -> Option<i64> {
    items
        .iter()
        .filter_map(|item| {
            value_i64(
                item,
                &[
                    "observedAt",
                    "ts",
                    "bucketAt",
                    "eventAt",
                    "fundingTime",
                    "publishedAt",
                    "snapshotAt",
                    "dataTime",
                    "updatedAt",
                ],
            )
        })
        .max()
}

fn decorate_agent_intelligence_response(
    app: &tauri::AppHandle,
    name: &str,
    result: &mut Value,
) -> Result<bool, String> {
    let scope = intelligence_tool_scope(name);
    let conn = open_intelligence_database(app)?;
    let settings = load_settings(&conn)?;
    let state = sync_states(&conn)?
        .into_iter()
        .find(|state| state.key == scope);
    let now = now_ms();
    let items = result
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let series_metadata = result
        .get("seriesMetadata")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let has_series_metadata = !series_metadata.is_empty();
    let series_fetched_at = series_metadata
        .iter()
        .filter_map(|value| value_i64(value, &["fetchedAt"]))
        .max();
    let series_data_at = series_metadata
        .iter()
        .filter_map(|value| value_i64(value, &["observedAt"]))
        .max();
    let fetched_at = series_fetched_at
        .or_else(|| state.as_ref().and_then(|state| state.last_succeeded_at))
        .unwrap_or(0);
    let data_at = series_data_at
        .or_else(|| intelligence_data_at(&items))
        .or((fetched_at > 0).then_some(fetched_at));
    let age_ms = data_at
        .map(|value| now.saturating_sub(value))
        .unwrap_or(i64::MAX);
    let future_data = data_at.is_some_and(|value| value > now.saturating_add(5 * 60_000));
    let stale_after = scope_interval_ms(&settings, scope).saturating_mul(2);
    let missing = items.is_empty();
    let series_stale = series_metadata
        .iter()
        .any(|value| value.get("stale") == Some(&Value::Bool(true)));
    let stale = if has_series_metadata {
        missing || future_data || series_stale
    } else {
        missing || future_data || fetched_at == 0 || now.saturating_sub(fetched_at) > stale_after
    };
    let stale_reason = if missing {
        Some("本地没有匹配当前参数的数据".to_string())
    } else if future_data {
        Some("数据观测时间位于当前时间之后超过 5 分钟，请检查上游时区或时间版本".to_string())
    } else if has_series_metadata && series_stale {
        series_metadata.iter().find_map(|value| {
            value
                .get("staleReason")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
    } else if fetched_at == 0 {
        Some("该数据源尚未完成后台采集".to_string())
    } else if stale {
        Some(format!(
            "后台数据超过预期刷新周期，已 {}ms 未成功更新",
            now.saturating_sub(fetched_at)
        ))
    } else {
        None
    };
    if let Some(object) = result.as_object_mut() {
        object.insert("fetchedAt".to_string(), json!(fetched_at));
        object.insert("dataAt".to_string(), json!(data_at));
        object.insert("ageMs".to_string(), json!(age_ms));
        object.insert("stale".to_string(), json!(stale));
        object.insert("staleReason".to_string(), json!(stale_reason));
        object.insert(
            "refreshStatus".to_string(),
            json!(state
                .as_ref()
                .map(|state| state.status.as_str())
                .unwrap_or("missing")),
        );
        object.insert("refreshQueued".to_string(), json!(false));
        if !object.contains_key("coverage") {
            object.insert(
                "coverage".to_string(),
                json!(if items.is_empty() { 0.0 } else { 1.0 }),
            );
        }
        object
            .entry("limitations".to_string())
            .or_insert_with(|| json!([]));
        if stale {
            let limitations = object
                .entry("limitations".to_string())
                .or_insert_with(|| json!([]));
            if let Some(values) = limitations.as_array_mut() {
                values.push(json!(
                    "本工具立即返回本地证据；后台刷新已独立排队，不会阻塞本轮 Agent。"
                ));
            }
        }
    }
    Ok(stale)
}

async fn queue_agent_intelligence_refresh(
    app: tauri::AppHandle,
    runtime: IntelligenceRuntime,
    name: String,
    input: Value,
    forced_account_id: Option<String>,
) -> bool {
    let key_bytes = serde_json::to_vec(&json!({
        "name": name,
        "input": input,
        "accountId": forced_account_id,
    }))
    .unwrap_or_default();
    let key = Sha256::digest(&key_bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    {
        let mut inflight = runtime.refresh_inflight.lock().await;
        if !inflight.insert(key.clone()) {
            return false;
        }
    }
    tauri::async_runtime::spawn(async move {
        let permit = runtime.refresh_slots.clone().acquire_owned().await;
        let result = if permit.is_ok() {
            let state = app.state::<IntelligenceRuntime>();
            execute_intelligence_tool_impl(
                app.clone(),
                state,
                &name,
                input,
                forced_account_id.as_deref(),
            )
            .await
        } else {
            Err("市场情报刷新队列已关闭".to_string())
        };
        if let Ok(value) = &result {
            if let Ok(conn) = open_intelligence_database(&app) {
                let finished = now_ms();
                let settings = load_settings(&conn).unwrap_or_default();
                let scope = intelligence_tool_scope(&name);
                let rows = value
                    .get("items")
                    .and_then(Value::as_array)
                    .map(|items| items.len() as u64)
                    .unwrap_or(0);
                let _ = set_sync_state(
                    &conn,
                    scope,
                    "success",
                    finished,
                    Some(finished.saturating_add(scope_interval_ms(&settings, scope))),
                    None,
                    rows,
                );
            }
        }
        let _ = app.emit(
            INTELLIGENCE_EVENT,
            json!({
                "type": if result.is_ok() { "agentRefreshCompleted" } else { "agentRefreshFailed" },
                "tool": name,
                "error": result.err(),
                "timestamp": now_ms(),
            }),
        );
        runtime.refresh_inflight.lock().await.remove(&key);
    });
    true
}

pub(crate) async fn execute_intelligence_tool(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, IntelligenceRuntime>,
    name: &str,
    mut input: Value,
    forced_account_id: Option<&str>,
) -> Result<Value, String> {
    validate_intelligence_tool_input(&input)?;
    if let Some(object) = input.as_object_mut() {
        object.remove("localOnly");
        object.insert("localOnly".to_string(), json!(true));
        object.insert("_agentLocalOnly".to_string(), json!(true));
    }
    let mut remote_input = input.clone();
    if let Some(object) = remote_input.as_object_mut() {
        object.remove("_agentLocalOnly");
        object.insert("localOnly".to_string(), json!(false));
    }
    let mut result = execute_intelligence_tool_impl(
        app.clone(),
        runtime.clone(),
        name,
        input,
        forced_account_id,
    )
    .await?;
    let needs_refresh = decorate_agent_intelligence_response(&app, name, &mut result)?;
    if needs_refresh {
        let queued = queue_agent_intelligence_refresh(
            app,
            runtime.inner().clone(),
            name.to_string(),
            remote_input,
            forced_account_id.map(str::to_string),
        )
        .await;
        if let Some(object) = result.as_object_mut() {
            object.insert("refreshQueued".to_string(), json!(queued));
            object.insert(
                "refreshStatus".to_string(),
                json!(if queued { "queued" } else { "refreshing" }),
            );
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_account(environment: &str, read: bool) -> LocalAccount {
        LocalAccount {
            id: "test-okx-account".to_string(),
            name: "Test OKX".to_string(),
            exchange: "okx".to_string(),
            environment: environment.to_string(),
            okx_uid: "placeholder-uid".to_string(),
            okx_main_uid: "placeholder-main-uid".to_string(),
            api_key: "TEST_API_KEY_PLACEHOLDER".to_string(),
            secret_key: "TEST_SECRET_PLACEHOLDER".to_string(),
            passphrase: "TEST_PASSPHRASE_PLACEHOLDER".to_string(),
            permissions: Permissions {
                read,
                trade: false,
                withdraw: false,
            },
        }
    }

    #[test]
    fn calendar_window_maps_to_reversed_okx_parameters() {
        let query = CalendarQuery {
            start_time: Some(100),
            end_time: Some(200),
            ..Default::default()
        };
        let path = calendar_page_path(&query, query.end_time, ECONOMIC_CALENDAR_PAGE_LIMIT);
        assert!(path.contains("before=100"));
        assert!(path.contains("after=200"));
        assert!(path.contains("limit=100"));

        let next_page = calendar_page_path(&query, Some(150), ECONOMIC_CALENDAR_PAGE_LIMIT);
        assert!(next_page.contains("before=100"));
        assert!(next_page.contains("after=150"));
    }

    #[test]
    fn stale_intelligence_account_is_not_silently_replaced() {
        let account = test_account("live", true);
        let error = resolve_intelligence_account(&[account], Some("removed-account"))
            .expect_err("stale account must require an explicit replacement");
        assert_eq!(error, "account removed-account not found");
    }

    #[test]
    fn intelligence_private_rest_retries_only_transient_http_statuses() {
        assert!(intelligence_http_status_retryable(429));
        assert!(intelligence_http_status_retryable(500));
        assert!(intelligence_http_status_retryable(503));
        assert!(!intelligence_http_status_retryable(400));
        assert!(!intelligence_http_status_retryable(401));
        assert!(!intelligence_http_status_retryable(403));
        assert_eq!(intelligence_rest_retry_delay(0), Duration::from_millis(250));
        assert_eq!(intelligence_rest_retry_delay(1), Duration::from_millis(500));
    }

    #[test]
    fn orbit_news_details_container_and_cursor_are_unwrapped() {
        let envelope: RawOkxEnvelope = serde_json::from_str(include_str!(
            "../crates/intelligence/tests/fixtures/news-search-v1.3.9.json"
        ))
        .expect("news fixture");
        let response = response_from_envelope(&envelope, 1);
        assert_eq!(response.items.len(), 1);
        assert!(response.pagination.has_more);
        assert_eq!(
            response.pagination.next_after.as_deref(),
            Some("FIXTURE_CURSOR")
        );
        let normalized = normalize_response(response, "news").expect("normalized response");
        assert_eq!(
            value_string(&normalized.items[0], &["id"]).as_deref(),
            Some("NEWS_FIXTURE_001")
        );
    }

    #[test]
    fn smart_overview_rejects_ambiguous_coin_selection() {
        let query = SmartMoneyQuery {
            operation: "signalOverviewByFilter".to_string(),
            inst_ccy_list: Some(vec!["BTC".to_string()]),
            top_instruments: Some(20),
            ..Default::default()
        };
        assert!(smart_path(&query).is_err());
    }

    #[test]
    fn smart_overview_omits_top_instruments_for_explicit_coins() {
        let query = SmartMoneyQuery {
            operation: "signalOverviewByFilter".to_string(),
            inst_ccy_list: Some(vec!["BTC".to_string(), "ETH".to_string()]),
            ..Default::default()
        };
        let (_, params, _, _) = smart_path(&query).expect("smart path");
        assert!(params
            .iter()
            .any(|(key, value)| *key == "instCcyList" && value.is_some()));
        assert!(params
            .iter()
            .any(|(key, value)| *key == "topInstruments" && value.is_none()));
    }

    #[test]
    fn smart_signal_filters_use_current_upstream_parameter_names() {
        let query = SmartMoneyQuery {
            operation: "signalOverviewByFilter".to_string(),
            ts: Some("1784808000000".to_string()),
            sort_type: Some("pnlRatio".to_string()),
            pnl: Some("PNL_TOP20".to_string()),
            win_ratio: Some("WR_GE_80".to_string()),
            max_retreat: Some("MR_LE_20".to_string()),
            asset: Some("AUM_TOP20".to_string()),
            ..Default::default()
        };
        let (_, params, _, _) = smart_path(&query).expect("smart overview path");
        for expected in ["sortType", "pnl", "winRatio", "maxRetreat", "asset"] {
            assert!(params
                .iter()
                .any(|(key, value)| *key == expected && value.is_some()));
        }
        assert!(!params
            .iter()
            .any(|(key, _)| matches!(*key, "ts" | "dataVersion")));
        for legacy in [
            "sortBy",
            "pnlTier",
            "winRateTier",
            "maxDrawdownTier",
            "aumTier",
        ] {
            assert!(!params.iter().any(|(key, _)| *key == legacy));
        }
    }

    #[test]
    fn smart_money_query_deserializes_legacy_filter_aliases() {
        let query: SmartMoneyQuery = serde_json::from_value(json!({
            "operation": "signalOverviewByFilter",
            "sortBy": "pnlRatio",
            "pnlTier": "PNL_TOP20",
            "winRateTier": "WR_GE_80",
            "maxDrawdownTier": "MR_LE_20",
            "aumTier": "AUM_TOP20"
        }))
        .expect("legacy smart money query");
        assert_eq!(query.sort_type.as_deref(), Some("pnlRatio"));
        assert_eq!(query.pnl.as_deref(), Some("PNL_TOP20"));
        assert_eq!(query.win_ratio.as_deref(), Some("WR_GE_80"));
        assert_eq!(query.max_retreat.as_deref(), Some("MR_LE_20"));
        assert_eq!(query.asset.as_deref(), Some("AUM_TOP20"));
    }

    #[test]
    fn smart_signal_history_sends_data_version_without_ts() {
        let query = SmartMoneyQuery {
            operation: "signalTrendByFilter".to_string(),
            inst_id: Some("BTC-USDT-SWAP".to_string()),
            ts: Some("1784808000000".to_string()),
            data_version: Some("2026072312".to_string()),
            granularity: Some("1h".to_string()),
            limit: Some(24),
            ..Default::default()
        };
        let (_, params, _, _) = smart_path(&query).expect("smart history path");
        assert!(params
            .iter()
            .any(|(key, value)| { *key == "instId" && value.as_deref() == Some("BTC-USDT-SWAP") }));
        assert!(params
            .iter()
            .any(|(key, value)| *key == "dataVersion" && value.as_deref() == Some("2026072312")));
        assert!(!params.iter().any(|(key, _)| *key == "ts"));
        assert!(!params.iter().any(|(key, _)| *key == "asOfTime"));
        assert!(!params.iter().any(|(key, _)| *key == "instCcy"));
    }

    #[test]
    fn smart_signal_timestamp_converts_to_okx_utc8_hour_data_version() {
        assert_eq!(
            smart_data_version_from_ms("1784808000000").as_deref(),
            Ok("2026072320")
        );
        assert_eq!(
            smart_data_version_to_ms("2026072320"),
            Ok(1_784_808_000_000)
        );
        assert_eq!(
            smart_data_version_from_ms("1784839719742").as_deref(),
            Ok("2026072404")
        );
        assert_eq!(
            smart_data_version_to_ms("2026072404"),
            Ok(1_784_836_800_000)
        );
    }

    #[test]
    fn crowding_semantics_distinguish_account_count_from_position_value() {
        let mut items = vec![json!({
            "accountRatio": "1.635",
            "topAccountRatio": "1.258",
            "topPositionRatio": "0.945"
        })];
        enrich_crowding_semantics(&mut items);
        assert_eq!(items[0]["accountBias"], "long");
        assert_eq!(items[0]["topAccountBias"], "long");
        assert_eq!(items[0]["topPositionBias"], "short");
        assert_eq!(items[0]["eliteInternalDivergence"], true);
    }

    #[test]
    fn smart_signals_are_restricted_to_cached_linear_currencies() {
        let mut items = vec![
            json!({ "instCcy": "BTC" }),
            json!({ "instCcy": "UNLISTED" }),
        ];
        let currencies = HashSet::from(["BTC".to_string(), "ETH".to_string()]);
        let removed = retain_linear_signal_items(&mut items, &currencies);
        assert_eq!(removed, 1);
        assert_eq!(items.len(), 1);
        assert_eq!(
            value_string(&items[0], &["instCcy"]).as_deref(),
            Some("BTC")
        );
    }

    #[test]
    fn linear_swap_currency_falls_back_to_instrument_id() {
        assert_eq!(linear_swap_base_currency("", "BTC-USDT-SWAP"), "BTC");
        assert_eq!(linear_swap_base_currency("eth", ""), "ETH");
    }

    #[test]
    fn intelligence_rejects_demo_and_missing_read_permission() {
        assert!(validate_intelligence_account(test_account("demo", true)).is_err());
        assert!(validate_intelligence_account(test_account("live", false)).is_err());
        assert!(validate_intelligence_account(test_account("live", true)).is_ok());
    }

    #[test]
    fn intelligence_tool_rejects_model_supplied_account_context() {
        assert!(validate_intelligence_tool_input(&json!({ "accountId": "forbidden" })).is_err());
        assert!(validate_intelligence_tool_input(&json!({ "instId": "BTC-USDT-SWAP" })).is_ok());
    }

    #[test]
    fn collector_uses_per_scope_next_run_time() {
        let settings = IntelligenceSettings::defaults();
        let now = 1_000_000;
        let states = vec![IntelligenceSyncState {
            key: "news".to_string(),
            status: "success".to_string(),
            last_started_at: Some(now - 1_000),
            last_succeeded_at: Some(now - 1_000),
            last_failed_at: None,
            next_run_at: Some(now + 20_000),
            error: None,
            rows_written: 1,
        }];
        let due = due_collector_scopes(&settings, &states, now);
        assert!(!due.contains(&"news"));
        assert!(due.contains(&"calendar"));
    }

    #[test]
    fn active_and_regular_derivative_scopes_keep_separate_cadence() {
        let settings = IntelligenceSettings::defaults();
        assert_eq!(scope_interval_ms(&settings, "derivativesActive"), 60_000);
        assert_eq!(scope_interval_ms(&settings, "derivativesFast"), 300_000);
        assert_eq!(
            scope_interval_ms(&settings, "derivativesRiskActive"),
            300_000
        );
        assert_eq!(scope_interval_ms(&settings, "derivativesRisk"), 3_600_000);
    }

    #[test]
    fn live_oi_is_merged_into_the_requested_output_bucket() {
        let now = now_ms();
        let inst_id = "TEST-USDT-SWAP".to_string();
        let source_bucket = now / 300_000 * 300_000;
        OI_STREAM_CACHE.lock().expect("OI cache").insert(
            inst_id.clone(),
            (
                source_bucket,
                json!({
                    "instId": inst_id,
                    "ts": source_bucket,
                    "sourceTs": now - 250,
                    "observedAt": now - 250,
                    "receivedAt": now,
                    "oi": "1234",
                    "oiCcy": "12.34",
                    "oiUsd": "800000",
                    "stream": true
                }),
            ),
        );
        let query = DerivativesQuery {
            inst_id: "TEST-USDT-SWAP".to_string(),
            period: Some("1H".to_string()),
            limit: Some(4),
            ..Default::default()
        };
        let mut items = Vec::new();
        let merged = merge_live_oi_snapshot(&query, &mut items);
        OI_STREAM_CACHE
            .lock()
            .expect("OI cache")
            .remove(&query.inst_id);

        assert!(merged.is_some());
        assert_eq!(items.len(), 1);
        assert_eq!(value_string(&items[0], &["oi"]).as_deref(), Some("1234"));
        assert_eq!(
            value_string(&items[0], &["bucketStatus"]).as_deref(),
            Some("partial")
        );
        assert_eq!(
            value_string(&items[0], &["sourceMode"]).as_deref(),
            Some("websocket")
        );
        assert_eq!(value_i64(&items[0], &["observedAt"]), Some(now - 250));
    }

    #[test]
    fn derivative_response_uses_series_specific_freshness_metadata() {
        let now = now_ms();
        let bucket_start = now / 3_600_000 * 3_600_000;
        let query = DerivativesQuery {
            inst_id: "BTC-USDT-SWAP".to_string(),
            period: Some("1H".to_string()),
            limit: Some(8),
            ..Default::default()
        };
        let mut response = derivatives_response(
            vec![json!({
                "instId": query.inst_id.clone(),
                "ts": bucket_start,
                "bucketStartAt": bucket_start,
                "bucketEndAt": bucket_start + 3_600_000,
                "observedAt": now - 1_000,
                "sourceFetchedAt": now - 500,
                "bucketStatus": "partial",
                "sourceMode": "rest+websocket"
            })],
            Some(8),
            false,
        );
        apply_derivative_response_metadata(&mut response, "positioning", &query);

        assert_eq!(response.series_metadata.len(), 1);
        assert_eq!(response.data_at, Some(now - 1_000));
        assert_eq!(response.fetched_at, now - 500);
        assert!(!response.stale);
        assert_eq!(response.series_metadata[0].bucket_status, "partial");
        assert_eq!(response.series_metadata[0].source_mode, "rest+websocket");
    }

    #[test]
    fn derivative_decision_context_uses_active_derivative_scope() {
        assert_eq!(
            intelligence_tool_scope("intelligence.smartMoney.readDerivativeDecisionContext"),
            "derivativesActive"
        );
    }

    #[test]
    fn response_marks_nested_content_truncation() {
        let response =
            IntelligenceResponse::new(1, vec![json!({ "content": "x".repeat(MAX_TOOL_TEXT + 1) })]);
        let limited = limit_response(response);
        assert!(limited.truncated);
        assert_eq!(
            limited.items[0]["content"].as_str().expect("content").len(),
            MAX_TOOL_TEXT
        );
    }
}
