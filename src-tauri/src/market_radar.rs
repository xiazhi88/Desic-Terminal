use super::*;
use desic_market_radar::{
    calculate_research_metrics, score_cross_section, DailyObservation, ResearchCandidate,
};

const RADAR_DAILY_LOOKBACK_DAYS: i64 = 400;
const RADAR_HOURLY_LOOKBACK_DAYS: i64 = 90;
const RADAR_HOURLY_UNIVERSE_SIZE: usize = 100;
const RADAR_HISTORY_REFRESH_MS: i64 = 55 * 60_000;
const RADAR_HISTORY_EVENT: &str = "market-radar:history-status";
const RADAR_DIRECTORY_EVENT: &str = "market-radar:directory-updated";
const RADAR_DIRECTORY_RECONNECT_MAX_SECS: u64 = 30;

static MARKET_RADAR_DIRECTORY_RUNNING: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn market_radar_directory_stream_start(app: tauri::AppHandle) -> bool {
    if MARKET_RADAR_DIRECTORY_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return false;
    }
    tauri::async_runtime::spawn(async move {
        // The directory is low priority; let watchlist shards consume the startup connection budget.
        sleep(Duration::from_secs(2)).await;
        let mut attempt = 0_u32;
        loop {
            match run_market_radar_directory_stream(&app).await {
                Ok(()) => attempt = 0,
                Err(error) => {
                    eprintln!("market radar directory stream: {error}");
                    attempt = attempt.saturating_add(1);
                }
            }
            let delay = (1_u64 << attempt.min(5)).min(RADAR_DIRECTORY_RECONNECT_MAX_SECS);
            sleep(Duration::from_secs(delay)).await;
        }
    });
    true
}

async fn run_market_radar_directory_stream(app: &tauri::AppHandle) -> Result<(), String> {
    let mut socket = crate::market_ws::connect_okx_ws(PUBLIC_WS).await?;
    let subscribe = json!({
        "op": "subscribe",
        "args": [{ "channel": "instruments", "instType": "SWAP" }]
    });
    socket
        .send(Message::Text(subscribe.to_string()))
        .await
        .map_err(|error| error.to_string())?;
    let mut last_received = Instant::now();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
    loop {
        tokio::select! {
            message = socket.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    last_received = Instant::now();
                    if text == "pong" {
                        continue;
                    }
                    let payload: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
                    if payload.get("event").and_then(Value::as_str) == Some("error") {
                        return Err(payload.get("msg").and_then(Value::as_str).unwrap_or("OKX rejected the instruments subscription").to_string());
                    }
                    if payload.get("arg").and_then(|arg| arg.get("channel")).and_then(Value::as_str) != Some("instruments") {
                        continue;
                    }
                    let Some(data) = payload.get("data") else {
                        continue;
                    };
                    let instruments = serde_json::from_value::<Vec<OkxInstrument>>(data.clone())
                        .map_err(|error| error.to_string())?;
                    if !instruments.is_empty() {
                        apply_directory_updates(app, instruments)?;
                    }
                }
                Some(Ok(Message::Ping(payload))) => {
                    socket.send(Message::Pong(payload)).await.map_err(|error| error.to_string())?;
                }
                Some(Ok(Message::Close(frame))) => return Err(format!("OKX instruments stream closed: {frame:?}")),
                Some(Ok(_)) => {}
                Some(Err(error)) => return Err(error.to_string()),
                None => return Err("OKX instruments stream ended".to_string()),
            },
            _ = heartbeat.tick() => {
                if last_received.elapsed() >= Duration::from_secs(20) {
                    socket.send(Message::Text("ping".to_string())).await.map_err(|error| error.to_string())?;
                }
                if last_received.elapsed() >= Duration::from_secs(30) {
                    return Err("OKX instruments stream heartbeat timed out".to_string());
                }
            }
        }
    }
}

fn apply_directory_updates(
    app: &tauri::AppHandle,
    instruments: Vec<OkxInstrument>,
) -> Result<(), String> {
    let Some(mut summary) = load_market_assets_summary(app)? else {
        return Ok(());
    };
    let updated_at = now_ms();
    let previous = summary
        .instruments
        .into_iter()
        .map(|instrument| (instrument.inst_id.clone(), instrument))
        .collect::<HashMap<_, _>>();
    let full_snapshot = instruments.len() > 100;
    let mut updated = if full_snapshot {
        HashMap::new()
    } else {
        previous.clone()
    };
    for instrument in instruments {
        let cached = previous.get(&instrument.inst_id);
        let icon_path = cached.and_then(|item| item.icon_path.clone());
        let icon_cached = cached.is_some_and(|item| item.icon_cached);
        let next = instrument_summary_from(instrument, icon_path, icon_cached, updated_at);
        updated.insert(next.inst_id.clone(), next);
    }
    let mut values = updated.into_values().collect::<Vec<_>>();
    values.sort_by(|left, right| left.inst_id.cmp(&right.inst_id));
    summary.cache_version = MARKET_ASSETS_CACHE_VERSION;
    summary.total = values.len();
    summary.icon_cached = values.iter().filter(|item| item.icon_cached).count();
    summary.instruments = values;
    summary.updated_at = updated_at;
    let index_path = market_assets_cache_dir(app)?.join("swap-instruments.json");
    let bytes = serde_json::to_vec_pretty(&summary).map_err(|error| error.to_string())?;
    fs::write(index_path, bytes).map_err(|error| error.to_string())?;
    let _ = app.emit(RADAR_DIRECTORY_EVENT, summary);
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketRadarHistoryStatus {
    state: String,
    phase: String,
    total: usize,
    completed: usize,
    failed: usize,
    daily_ready: usize,
    hourly_ready: usize,
    current_symbol: Option<String>,
    message: String,
    started_at: Option<i64>,
    finished_at: Option<i64>,
}

impl Default for MarketRadarHistoryStatus {
    fn default() -> Self {
        Self {
            state: "idle".to_string(),
            phase: "idle".to_string(),
            total: 0,
            completed: 0,
            failed: 0,
            daily_ready: 0,
            hourly_ready: 0,
            current_symbol: None,
            message: "Market Radar history has not started".to_string(),
            started_at: None,
            finished_at: None,
        }
    }
}

static MARKET_RADAR_HISTORY_STATUS: OnceLock<Mutex<MarketRadarHistoryStatus>> = OnceLock::new();
static MARKET_RADAR_HISTORY_RUNNING: AtomicBool = AtomicBool::new(false);

fn history_status_store() -> &'static Mutex<MarketRadarHistoryStatus> {
    MARKET_RADAR_HISTORY_STATUS.get_or_init(|| Mutex::new(MarketRadarHistoryStatus::default()))
}

fn current_history_status() -> MarketRadarHistoryStatus {
    history_status_store()
        .lock()
        .map(|status| status.clone())
        .unwrap_or_default()
}

fn first_full_open_at_or_after(listed_at: i64, interval: &str, step: i64) -> i64 {
    let aligned = align_open_time(listed_at, interval, step);
    if aligned < listed_at {
        aligned.saturating_add(step)
    } else {
        aligned
    }
}

fn publish_history_status(app: &tauri::AppHandle, status: &MarketRadarHistoryStatus) {
    if let Ok(mut stored) = history_status_store().lock() {
        *stored = status.clone();
    }
    let _ = app.emit(RADAR_HISTORY_EVENT, status.clone());
}

#[tauri::command]
pub fn market_radar_history_status() -> MarketRadarHistoryStatus {
    current_history_status()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketRadarResearchScore {
    inst_id: String,
    as_of: i64,
    observations: usize,
    relative_strength_30d_pct: f64,
    volatility_20d_pct: f64,
    volume_ratio_20d: Option<f64>,
    trend_quality_30d: f64,
    strength_score: f64,
    low_volatility_score: f64,
    activity_score: f64,
    trend_quality_score: f64,
    composite_score: f64,
    rank: usize,
    model_version: String,
}

#[tauri::command]
pub async fn market_radar_research_scores(
    app: tauri::AppHandle,
) -> Result<Vec<MarketRadarResearchScore>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let summary = load_market_assets_summary(&app)?
            .ok_or_else(|| "Market instrument cache is unavailable".to_string())?;
        let research_symbols = summary
            .instruments
            .into_iter()
            .filter(|instrument| {
                instrument.inst_type == "SWAP"
                    && instrument.state == "live"
                    && instrument.settle_ccy == "USDT"
            })
            .map(|instrument| {
                let interval = if instrument.inst_category == "3" {
                    "1Dutc-forward"
                } else {
                    "1Dutc"
                };
                (instrument.inst_id, interval.to_string())
            })
            .collect::<Vec<_>>();
        if research_symbols.is_empty() {
            return Ok(Vec::new());
        }
        let mut placeholders = Vec::with_capacity(research_symbols.len());
        let mut bind_values =
            Vec::<rusqlite::types::Value>::with_capacity(research_symbols.len() * 2 + 1);
        for (index, (inst_id, interval)) in research_symbols.into_iter().enumerate() {
            let first = index * 2 + 1;
            placeholders.push(format!("(?{}, ?{})", first, first + 1));
            bind_values.push(rusqlite::types::Value::Text(inst_id));
            bind_values.push(rusqlite::types::Value::Text(interval));
        }
        let cutoff = now_ms().saturating_sub(450 * 86_400_000);
        let cutoff_parameter = bind_values.len() + 1;
        bind_values.push(rusqlite::types::Value::Integer(cutoff));
        let query = format!(
            "WITH research_symbols(symbol, interval) AS (VALUES {})
             SELECT candles.symbol, candles.open_time, candles.close, candles.volume_quote
             FROM research_symbols
             JOIN candles
               ON candles.symbol=research_symbols.symbol
              AND candles.interval=research_symbols.interval
             WHERE candles.confirm=1 AND candles.open_time>=?{}
             ORDER BY candles.symbol ASC, candles.open_time ASC",
            placeholders.join(","),
            cutoff_parameter,
        );
        let conn = open_database(&app)?;
        let mut stmt = conn.prepare(&query).map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(bind_values.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        let mut observations = HashMap::<String, Vec<DailyObservation>>::new();
        for row in rows {
            let (inst_id, open_time, close, volume_quote) =
                row.map_err(|error| error.to_string())?;
            let Ok(close) = close.parse::<f64>() else {
                continue;
            };
            observations
                .entry(inst_id)
                .or_default()
                .push(DailyObservation {
                    open_time,
                    close,
                    volume_quote: volume_quote.and_then(|value| value.parse::<f64>().ok()),
                });
        }
        let candidates = observations
            .into_iter()
            .filter_map(|(instrument_id, rows)| {
                calculate_research_metrics(&rows).map(|metrics| ResearchCandidate {
                    instrument_id,
                    metrics,
                })
            })
            .collect::<Vec<_>>();
        Ok::<Vec<MarketRadarResearchScore>, String>(
            score_cross_section(candidates)
                .into_iter()
                .map(|score| MarketRadarResearchScore {
                    inst_id: score.instrument_id,
                    as_of: score.metrics.as_of,
                    observations: score.metrics.observations,
                    relative_strength_30d_pct: score.metrics.relative_strength_30d * 100.0,
                    volatility_20d_pct: score.metrics.volatility_20d * 100.0,
                    volume_ratio_20d: score.metrics.volume_ratio_20d,
                    trend_quality_30d: score.metrics.trend_quality_30d * 100.0,
                    strength_score: score.strength_score,
                    low_volatility_score: score.low_volatility_score,
                    activity_score: score.activity_score,
                    trend_quality_score: score.trend_quality_score,
                    composite_score: score.composite_score,
                    rank: score.rank,
                    model_version: "daily-core-v1".to_string(),
                })
                .collect(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn market_radar_history_start(
    app: tauri::AppHandle,
) -> Result<MarketRadarHistoryStatus, String> {
    let current = current_history_status();
    if MARKET_RADAR_HISTORY_RUNNING.load(Ordering::Acquire) {
        return Ok(current);
    }
    if matches!(current.state.as_str(), "completed" | "partial")
        && current
            .finished_at
            .is_some_and(|finished_at| now_ms() - finished_at < RADAR_HISTORY_REFRESH_MS)
    {
        return Ok(current);
    }
    MARKET_RADAR_HISTORY_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "Market Radar history synchronization is already running".to_string())?;

    let started_at = now_ms();
    let initial = MarketRadarHistoryStatus {
        state: "running".to_string(),
        phase: "preparing".to_string(),
        message: "Preparing the all-market research universe".to_string(),
        started_at: Some(started_at),
        ..MarketRadarHistoryStatus::default()
    };
    publish_history_status(&app, &initial);

    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = synchronize_market_radar_history(&task_app, initial).await;
        let mut final_status = match result {
            Ok(status) => status,
            Err(error) => {
                let mut status = current_history_status();
                status.state = "failed".to_string();
                status.message = error;
                status
            }
        };
        final_status.current_symbol = None;
        final_status.finished_at = Some(now_ms());
        MARKET_RADAR_HISTORY_RUNNING.store(false, Ordering::Release);
        publish_history_status(&task_app, &final_status);
    });

    Ok(current_history_status())
}

async fn synchronize_market_radar_history(
    app: &tauri::AppHandle,
    mut status: MarketRadarHistoryStatus,
) -> Result<MarketRadarHistoryStatus, String> {
    let summary = load_market_assets_summary(app)?
        .ok_or_else(|| "Market instrument cache is unavailable".to_string())?;
    let mut instruments = summary
        .instruments
        .into_iter()
        .filter(|instrument| {
            instrument.inst_type == "SWAP"
                && instrument.state == "live"
                && instrument.settle_ccy == "USDT"
        })
        .collect::<Vec<_>>();
    if instruments.is_empty() {
        return Err("No live USDT perpetual instruments are available".to_string());
    }

    let tickers: OkxEnvelope<Ticker> = get_json("/api/v5/market/tickers?instType=SWAP").await?;
    let turnover = tickers
        .data
        .into_iter()
        .map(|ticker| {
            let value = ticker.last.parse::<f64>().unwrap_or_default()
                * ticker.vol_ccy24h.parse::<f64>().unwrap_or_default();
            (ticker.inst_id, value)
        })
        .collect::<HashMap<_, _>>();
    instruments.sort_by(|left, right| {
        turnover
            .get(&right.inst_id)
            .copied()
            .unwrap_or_default()
            .total_cmp(&turnover.get(&left.inst_id).copied().unwrap_or_default())
            .then_with(|| left.inst_id.cmp(&right.inst_id))
    });

    let hourly = instruments
        .iter()
        .take(RADAR_HOURLY_UNIVERSE_SIZE)
        .cloned()
        .collect::<Vec<_>>();
    status.total = instruments.len() + hourly.len();
    status.phase = "daily".to_string();
    status.message = format!(
        "Synchronizing daily history for {} markets",
        instruments.len()
    );
    publish_history_status(app, &status);

    let daily_step = 86_400_000;
    let daily_end = align_open_time(now_ms(), "1Dutc", daily_step).saturating_sub(daily_step);
    for instrument in &instruments {
        status.current_symbol = Some(instrument.inst_id.clone());
        let listed_at = instrument.list_time.parse::<i64>().unwrap_or_default();
        let requested_start =
            daily_end.saturating_sub((RADAR_DAILY_LOOKBACK_DAYS - 1) * daily_step);
        let start = if listed_at > 0 {
            requested_start.max(first_full_open_at_or_after(listed_at, "1Dutc", daily_step))
        } else {
            requested_start
        };
        let interval = if instrument.inst_category == "3" {
            "1Dutc-forward"
        } else {
            "1Dutc"
        };
        match sync_kline_window_quiet(app, &instrument.inst_id, interval, start, daily_end).await {
            Ok(report) if report.status == "complete" => {
                status.daily_ready += 1;
                status.completed += 1;
            }
            Ok(_) | Err(_) => {
                status.failed += 1;
                status.completed += 1;
            }
        }
        status.message = format!(
            "Daily history {}/{}; {} ready",
            status.completed,
            instruments.len(),
            status.daily_ready
        );
        publish_history_status(app, &status);
    }

    status.phase = "hourly".to_string();
    status.message = format!(
        "Synchronizing hourly history for the top {} markets",
        hourly.len()
    );
    publish_history_status(app, &status);
    let hourly_step = 60 * 60_000;
    let hourly_end = align_open_time(now_ms(), "1H", hourly_step).saturating_sub(hourly_step);
    for instrument in &hourly {
        status.current_symbol = Some(instrument.inst_id.clone());
        let listed_at = instrument.list_time.parse::<i64>().unwrap_or_default();
        let requested_start = hourly_end.saturating_sub(RADAR_HOURLY_LOOKBACK_DAYS * 86_400_000);
        let start = if listed_at > 0 {
            requested_start.max(first_full_open_at_or_after(listed_at, "1H", hourly_step))
        } else {
            requested_start
        };
        match sync_kline_window_quiet(app, &instrument.inst_id, "1H", start, hourly_end).await {
            Ok(report) if report.status == "complete" => {
                status.hourly_ready += 1;
                status.completed += 1;
            }
            Ok(_) | Err(_) => {
                status.failed += 1;
                status.completed += 1;
            }
        }
        status.message = format!(
            "Hourly history {}/{}; {} ready",
            status.completed.saturating_sub(instruments.len()),
            hourly.len(),
            status.hourly_ready
        );
        publish_history_status(app, &status);
    }

    status.state = if status.failed == 0 {
        "completed"
    } else {
        "partial"
    }
    .to_string();
    status.phase = "complete".to_string();
    status.message = if status.failed == 0 {
        format!(
            "Market Radar history is ready: {} daily and {} hourly markets",
            status.daily_ready, status.hourly_ready
        )
    } else {
        format!(
            "Market Radar history completed with {} unavailable series",
            status.failed
        )
    };
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_history_status_is_idle() {
        let status = MarketRadarHistoryStatus::default();
        assert_eq!(status.state, "idle");
        assert_eq!(status.completed, 0);
    }

    #[test]
    fn listing_time_clamps_to_first_full_research_bar() {
        let hour = 60 * 60_000;
        let aligned = 1_700_000_000_000_i64 - 1_700_000_000_000_i64.rem_euclid(hour);
        assert_eq!(first_full_open_at_or_after(aligned, "1H", hour), aligned);
        assert_eq!(
            first_full_open_at_or_after(aligned + 1, "1H", hour),
            aligned + hour
        );
    }
}
