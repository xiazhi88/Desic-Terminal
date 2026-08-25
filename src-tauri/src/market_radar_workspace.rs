use super::*;
use desic_market_radar::{evaluate_validation, ValidationObservation, ValidationStats};

const RADAR_SNAPSHOT_INTERVAL_MS: i64 = 60 * 60_000;
const RADAR_SNAPSHOT_RETENTION_MS: i64 = 90 * 24 * 60 * 60_000;
const RADAR_MAX_UNIVERSE_SIZE: usize = 1_000;
const RADAR_MAX_SAVED_DEFINITION_BYTES: usize = 16 * 1_024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketRadarSnapshotRowInput {
    inst_id: String,
    category: Option<String>,
    list_time: Option<i64>,
    rank: usize,
    composite_score: f64,
    strength_score: f64,
    low_volatility_score: f64,
    activity_score: f64,
    raw_activity_score: f64,
    trend_quality_score: f64,
    raw_trend_quality_score: Option<f64>,
    volatility_20d_pct: Option<f64>,
    liquidity_score: f64,
    change_24h_pct: f64,
    turnover_24h: f64,
    last_price: f64,
    spread_bps: Option<f64>,
    history_ready: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketRadarSnapshotInput {
    fetched_at: i64,
    model_version: String,
    rows: Vec<MarketRadarSnapshotRowInput>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketRadarComponentDelta {
    composite: f64,
    strength: f64,
    low_volatility: f64,
    activity: f64,
    trend_quality: f64,
    liquidity: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketRadarRankChange {
    inst_id: String,
    current_rank: usize,
    rank_1h: Option<usize>,
    rank_delta_1h: Option<i64>,
    rank_24h: Option<usize>,
    rank_delta_24h: Option<i64>,
    rank_7d: Option<usize>,
    rank_delta_7d: Option<i64>,
    component_delta_24h: Option<MarketRadarComponentDelta>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketRadarSnapshotResult {
    snapshot_at: i64,
    universe_size: usize,
    changes: Vec<MarketRadarRankChange>,
    alerts: Vec<MarketRadarAlertTrigger>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketRadarAlertTrigger {
    event_id: String,
    rule_id: String,
    rule_name: String,
    kind: String,
    inst_id: String,
    current_value: f64,
    threshold: f64,
    triggered_at: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketRadarAlertDefinition {
    version: u32,
    kind: String,
    threshold: Option<f64>,
    cooldown_minutes: Option<i64>,
    daily_limit: Option<usize>,
    #[serde(default)]
    inst_ids: Vec<String>,
}

#[derive(Clone, Debug)]
struct StoredRadarRow {
    rank: usize,
    composite_score: f64,
    strength_score: f64,
    low_volatility_score: f64,
    activity_score: f64,
    raw_activity_score: f64,
    trend_quality_score: f64,
    liquidity_score: f64,
    spread_bps: Option<f64>,
    history_ready: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketRadarSavedItemInput {
    id: String,
    name: String,
    definition_json: String,
    enabled: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketRadarSavedItem {
    id: String,
    name: String,
    definition_json: String,
    enabled: bool,
    created_at: i64,
    updated_at: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketRadarValidationRequest {
    lookback_days: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketRadarValidationHorizon {
    horizon_days: i64,
    observations: usize,
    dates: usize,
    rank_ic: Option<f64>,
    training_rank_ic: Option<f64>,
    validation_rank_ic: Option<f64>,
    ic_stability_delta: Option<f64>,
    top_quantile_return_pct: Option<f64>,
    bottom_quantile_return_pct: Option<f64>,
    gross_spread_pct: Option<f64>,
    net_spread_after_cost_pct: Option<f64>,
    top_quantile_win_rate_pct: Option<f64>,
    top_quantile_turnover_pct: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketRadarValidationRegime {
    regime: String,
    horizon_days: i64,
    observations: usize,
    dates: usize,
    rank_ic: Option<f64>,
    gross_spread_pct: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketRadarValidationReport {
    status: String,
    generated_at: i64,
    lookback_days: i64,
    snapshot_dates: usize,
    first_snapshot_at: Option<i64>,
    last_snapshot_at: Option<i64>,
    model_versions: Vec<String>,
    horizons: Vec<MarketRadarValidationHorizon>,
    regimes: Vec<MarketRadarValidationRegime>,
    limitations: Vec<String>,
}

#[derive(Clone, Debug)]
struct ValidationSnapshotRow {
    snapshot_at: i64,
    inst_id: String,
    rank: usize,
    score: f64,
    category: Option<String>,
    last_price: f64,
    spread_bps: Option<f64>,
}

pub(crate) fn migrate_market_radar_workspace(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS market_radar_snapshots (
           snapshot_at INTEGER PRIMARY KEY,
           model_version TEXT NOT NULL,
           universe_size INTEGER NOT NULL,
           created_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS market_radar_snapshot_rows (
           snapshot_at INTEGER NOT NULL,
           inst_id TEXT NOT NULL,
           category TEXT,
           list_time INTEGER,
           rank INTEGER NOT NULL,
           composite_score REAL NOT NULL,
           strength_score REAL NOT NULL,
           low_volatility_score REAL NOT NULL,
           activity_score REAL NOT NULL,
           raw_activity_score REAL NOT NULL DEFAULT 50,
           trend_quality_score REAL NOT NULL,
           raw_trend_quality_score REAL,
           volatility_20d_pct REAL,
           liquidity_score REAL NOT NULL,
           change_24h_pct REAL NOT NULL,
           turnover_24h REAL NOT NULL,
           last_price REAL NOT NULL DEFAULT 0,
           spread_bps REAL,
           history_ready INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY(snapshot_at, inst_id)
         );
         CREATE INDEX IF NOT EXISTS idx_market_radar_snapshot_rows_instrument
           ON market_radar_snapshot_rows(inst_id, snapshot_at DESC);
         CREATE TABLE IF NOT EXISTS market_radar_saved_filters (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           definition_json TEXT NOT NULL,
           enabled INTEGER NOT NULL DEFAULT 1,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_market_radar_saved_filters_updated
           ON market_radar_saved_filters(updated_at DESC);
         CREATE TABLE IF NOT EXISTS market_radar_alert_rules (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           definition_json TEXT NOT NULL,
           enabled INTEGER NOT NULL DEFAULT 1,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_market_radar_alert_rules_updated
           ON market_radar_alert_rules(updated_at DESC);
         CREATE TABLE IF NOT EXISTS market_radar_alert_events (
           id TEXT PRIMARY KEY,
           rule_id TEXT NOT NULL,
           inst_id TEXT,
           dedupe_key TEXT NOT NULL UNIQUE,
           payload_json TEXT NOT NULL,
           triggered_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_market_radar_alert_events_rule
           ON market_radar_alert_events(rule_id, triggered_at DESC);",
    )
    .map_err(|error| error.to_string())?;
    let _ = conn.execute(
        "ALTER TABLE market_radar_snapshot_rows ADD COLUMN history_ready INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE market_radar_snapshot_rows ADD COLUMN last_price REAL NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE market_radar_snapshot_rows ADD COLUMN raw_activity_score REAL NOT NULL DEFAULT 50",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE market_radar_snapshot_rows ADD COLUMN raw_trend_quality_score REAL",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE market_radar_snapshot_rows ADD COLUMN volatility_20d_pct REAL",
        [],
    );
    Ok(())
}

#[tauri::command]
pub fn market_radar_record_snapshot(
    app: tauri::AppHandle,
    input: MarketRadarSnapshotInput,
) -> Result<MarketRadarSnapshotResult, String> {
    let mut conn = open_database(&app)?;
    record_snapshot_with_conn(&mut conn, input)
}

fn record_snapshot_with_conn(
    conn: &mut Connection,
    input: MarketRadarSnapshotInput,
) -> Result<MarketRadarSnapshotResult, String> {
    validate_snapshot_input(&input)?;
    let snapshot_at =
        input.fetched_at.div_euclid(RADAR_SNAPSHOT_INTERVAL_MS) * RADAR_SNAPSHOT_INTERVAL_MS;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    tx.execute(
        "INSERT INTO market_radar_snapshots(snapshot_at,model_version,universe_size,created_at)
         VALUES(?1,?2,?3,?4)
         ON CONFLICT(snapshot_at) DO UPDATE SET
           model_version=excluded.model_version,
           universe_size=excluded.universe_size,
           created_at=excluded.created_at",
        params![
            snapshot_at,
            input.model_version,
            input.rows.len() as i64,
            now_ms()
        ],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM market_radar_snapshot_rows WHERE snapshot_at=?1",
        [snapshot_at],
    )
    .map_err(|error| error.to_string())?;
    {
        let mut statement = tx
            .prepare_cached(
                "INSERT INTO market_radar_snapshot_rows(
                   snapshot_at,inst_id,category,list_time,rank,composite_score,
                   strength_score,low_volatility_score,activity_score,raw_activity_score,trend_quality_score,
                   raw_trend_quality_score,volatility_20d_pct,liquidity_score,change_24h_pct,turnover_24h,
                   last_price,spread_bps,history_ready
                 ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
            )
            .map_err(|error| error.to_string())?;
        for row in &input.rows {
            statement
                .execute(params![
                    snapshot_at,
                    row.inst_id,
                    row.category,
                    row.list_time,
                    row.rank as i64,
                    row.composite_score,
                    row.strength_score,
                    row.low_volatility_score,
                    row.activity_score,
                    row.raw_activity_score,
                    row.trend_quality_score,
                    row.raw_trend_quality_score,
                    row.volatility_20d_pct,
                    row.liquidity_score,
                    row.change_24h_pct,
                    row.turnover_24h,
                    row.last_price,
                    row.spread_bps,
                    i64::from(row.history_ready),
                ])
                .map_err(|error| error.to_string())?;
        }
    }
    let retention_start = snapshot_at.saturating_sub(RADAR_SNAPSHOT_RETENTION_MS);
    tx.execute(
        "DELETE FROM market_radar_snapshot_rows WHERE snapshot_at < ?1",
        [retention_start],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM market_radar_snapshots WHERE snapshot_at < ?1",
        [retention_start],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;

    snapshot_changes(conn, snapshot_at, &input.rows)
}

fn snapshot_changes(
    conn: &Connection,
    snapshot_at: i64,
    current: &[MarketRadarSnapshotRowInput],
) -> Result<MarketRadarSnapshotResult, String> {
    let one_hour = load_snapshot_near(conn, snapshot_at - RADAR_SNAPSHOT_INTERVAL_MS, 20 * 60_000)?;
    let one_day = load_snapshot_near(conn, snapshot_at - 24 * 60 * 60_000, 3 * 60 * 60_000)?;
    let seven_days =
        load_snapshot_near(conn, snapshot_at - 7 * 24 * 60 * 60_000, 12 * 60 * 60_000)?;
    let alerts = evaluate_alert_rules(conn, snapshot_at, current, &one_hour)?;
    let changes = current
        .iter()
        .map(|row| {
            let hour = one_hour.get(&row.inst_id);
            let day = one_day.get(&row.inst_id);
            let week = seven_days.get(&row.inst_id);
            MarketRadarRankChange {
                inst_id: row.inst_id.clone(),
                current_rank: row.rank,
                rank_1h: hour.map(|stored| stored.rank),
                rank_delta_1h: hour.map(|stored| stored.rank as i64 - row.rank as i64),
                rank_24h: day.map(|stored| stored.rank),
                rank_delta_24h: day.map(|stored| stored.rank as i64 - row.rank as i64),
                rank_7d: week.map(|stored| stored.rank),
                rank_delta_7d: week.map(|stored| stored.rank as i64 - row.rank as i64),
                component_delta_24h: day.map(|stored| MarketRadarComponentDelta {
                    composite: row.composite_score - stored.composite_score,
                    strength: row.strength_score - stored.strength_score,
                    low_volatility: row.low_volatility_score - stored.low_volatility_score,
                    activity: row.activity_score - stored.activity_score,
                    trend_quality: row.trend_quality_score - stored.trend_quality_score,
                    liquidity: row.liquidity_score - stored.liquidity_score,
                }),
            }
        })
        .collect();
    Ok(MarketRadarSnapshotResult {
        snapshot_at,
        universe_size: current.len(),
        changes,
        alerts,
    })
}

fn evaluate_alert_rules(
    conn: &Connection,
    snapshot_at: i64,
    current: &[MarketRadarSnapshotRowInput],
    previous: &HashMap<String, StoredRadarRow>,
) -> Result<Vec<MarketRadarAlertTrigger>, String> {
    const GLOBAL_DAILY_LIMIT: usize = 20;
    let rules = list_saved_items(conn, "market_radar_alert_rules")?;
    if rules.is_empty() {
        return Ok(Vec::new());
    }
    let day_start = snapshot_at.div_euclid(24 * 60 * 60_000) * 24 * 60 * 60_000;
    let mut global_count = conn
        .query_row(
            "SELECT COUNT(*) FROM market_radar_alert_events WHERE triggered_at>=?1",
            [day_start],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?
        .max(0) as usize;
    let mut triggers = Vec::new();
    for rule in rules.into_iter().filter(|rule| rule.enabled) {
        if global_count >= GLOBAL_DAILY_LIMIT {
            break;
        }
        let Ok(definition) =
            serde_json::from_str::<MarketRadarAlertDefinition>(&rule.definition_json)
        else {
            continue;
        };
        if validate_alert_definition(&definition).is_err() {
            continue;
        }
        let daily_limit = definition.daily_limit.unwrap_or(5).clamp(1, 10);
        let mut rule_count = conn
            .query_row(
                "SELECT COUNT(*) FROM market_radar_alert_events WHERE rule_id=?1 AND triggered_at>=?2",
                params![rule.id, day_start],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| error.to_string())?
            .max(0) as usize;
        for row in current {
            if global_count >= GLOBAL_DAILY_LIMIT || rule_count >= daily_limit {
                break;
            }
            if !definition.inst_ids.is_empty() && !definition.inst_ids.contains(&row.inst_id) {
                continue;
            }
            let prior = previous.get(&row.inst_id);
            if definition.kind == "newListing" && previous.is_empty() {
                continue;
            }
            let Some((current_value, threshold, crossed)) =
                alert_condition(&definition, row, prior, snapshot_at)
            else {
                continue;
            };
            if !crossed {
                continue;
            }
            let cooldown_start = snapshot_at.saturating_sub(
                definition
                    .cooldown_minutes
                    .unwrap_or(360)
                    .clamp(30, 7 * 24 * 60)
                    * 60_000,
            );
            let recently_triggered = conn
                .query_row(
                    "SELECT EXISTS(
                       SELECT 1 FROM market_radar_alert_events
                       WHERE rule_id=?1 AND inst_id=?2 AND triggered_at>=?3
                     )",
                    params![rule.id, row.inst_id, cooldown_start],
                    |query| query.get::<_, bool>(0),
                )
                .map_err(|error| error.to_string())?;
            if recently_triggered {
                continue;
            }
            let dedupe_key = format!(
                "{}:{}:{}:{}",
                rule.id, row.inst_id, definition.kind, snapshot_at
            );
            let event_id = radar_event_id(&dedupe_key);
            let trigger = MarketRadarAlertTrigger {
                event_id: event_id.clone(),
                rule_id: rule.id.clone(),
                rule_name: rule.name.clone(),
                kind: definition.kind.clone(),
                inst_id: row.inst_id.clone(),
                current_value,
                threshold,
                triggered_at: snapshot_at,
            };
            let payload_json =
                serde_json::to_string(&trigger).map_err(|error| error.to_string())?;
            let inserted = conn
                .execute(
                    "INSERT OR IGNORE INTO market_radar_alert_events(
                       id,rule_id,inst_id,dedupe_key,payload_json,triggered_at
                     ) VALUES(?1,?2,?3,?4,?5,?6)",
                    params![
                        event_id,
                        rule.id,
                        row.inst_id,
                        dedupe_key,
                        payload_json,
                        snapshot_at
                    ],
                )
                .map_err(|error| error.to_string())?;
            if inserted > 0 {
                triggers.push(trigger);
                rule_count += 1;
                global_count += 1;
            }
        }
    }
    conn.execute(
        "DELETE FROM market_radar_alert_events WHERE triggered_at<?1",
        [snapshot_at.saturating_sub(RADAR_SNAPSHOT_RETENTION_MS)],
    )
    .map_err(|error| error.to_string())?;
    Ok(triggers)
}

fn alert_condition(
    definition: &MarketRadarAlertDefinition,
    row: &MarketRadarSnapshotRowInput,
    prior: Option<&StoredRadarRow>,
    snapshot_at: i64,
) -> Option<(f64, f64, bool)> {
    match definition.kind.as_str() {
        "enterTop" => {
            let threshold = definition.threshold.unwrap_or(20.0).clamp(1.0, 500.0);
            Some((
                row.rank as f64,
                threshold,
                prior.is_some_and(|old| old.rank as f64 > threshold)
                    && row.rank as f64 <= threshold,
            ))
        }
        "rankRise" => {
            let threshold = definition.threshold.unwrap_or(20.0).clamp(1.0, 500.0);
            let change = prior.map_or(0.0, |old| old.rank as f64 - row.rank as f64);
            Some((change, threshold, prior.is_some() && change >= threshold))
        }
        "activityAbove" => {
            let threshold = definition.threshold.unwrap_or(80.0).clamp(0.0, 100.0);
            Some((
                row.raw_activity_score,
                threshold,
                prior.is_some_and(|old| old.raw_activity_score < threshold)
                    && row.raw_activity_score >= threshold,
            ))
        }
        "spreadAbove" => {
            let threshold = definition.threshold.unwrap_or(10.0).clamp(0.0, 10_000.0);
            let current = row.spread_bps?;
            Some((
                current,
                threshold,
                prior
                    .and_then(|old| old.spread_bps)
                    .is_some_and(|old| old < threshold)
                    && current >= threshold,
            ))
        }
        "newListing" => {
            let threshold = definition.threshold.unwrap_or(7.0).clamp(0.0, 365.0);
            let listed_at = row.list_time?;
            let age_days = snapshot_at.saturating_sub(listed_at) as f64 / (24.0 * 60.0 * 60_000.0);
            Some((
                age_days,
                threshold,
                prior.is_none() && age_days >= 0.0 && age_days <= threshold,
            ))
        }
        "historyReady" => Some((
            if row.history_ready { 1.0 } else { 0.0 },
            1.0,
            row.history_ready && prior.is_some_and(|old| !old.history_ready),
        )),
        _ => None,
    }
}

fn radar_event_id(dedupe_key: &str) -> String {
    let digest = Sha256::digest(dedupe_key.as_bytes());
    format!(
        "radar-{}",
        digest[..12]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn validate_alert_definition(definition: &MarketRadarAlertDefinition) -> Result<(), String> {
    if definition.version != 1
        || !matches!(
            definition.kind.as_str(),
            "enterTop"
                | "rankRise"
                | "activityAbove"
                | "spreadAbove"
                | "newListing"
                | "historyReady"
        )
        || definition
            .threshold
            .is_some_and(|value| !value.is_finite() || value < 0.0)
        || definition
            .cooldown_minutes
            .is_some_and(|value| !(30..=10_080).contains(&value))
        || definition
            .daily_limit
            .is_some_and(|value| !(1..=10).contains(&value))
        || definition.inst_ids.len() > 100
        || definition
            .inst_ids
            .iter()
            .any(|value| !valid_instrument_id(value))
    {
        return Err("Market Radar alert definition is invalid".to_string());
    }
    Ok(())
}

fn load_snapshot_near(
    conn: &Connection,
    target: i64,
    tolerance: i64,
) -> Result<HashMap<String, StoredRadarRow>, String> {
    let snapshot_at = conn
        .query_row(
            "SELECT snapshot_at FROM market_radar_snapshots
             WHERE snapshot_at BETWEEN ?1 AND ?2
             ORDER BY ABS(snapshot_at-?3) ASC LIMIT 1",
            params![target - tolerance, target + tolerance, target],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(snapshot_at) = snapshot_at else {
        return Ok(HashMap::new());
    };
    let mut statement = conn
        .prepare(
            "SELECT inst_id,rank,composite_score,strength_score,low_volatility_score,
                    activity_score,raw_activity_score,trend_quality_score,liquidity_score,spread_bps,history_ready
             FROM market_radar_snapshot_rows WHERE snapshot_at=?1",
        )
        .map_err(|error| error.to_string())?;
    let result = statement
        .query_map([snapshot_at], |row| {
            Ok((
                row.get::<_, String>(0)?,
                StoredRadarRow {
                    rank: row.get::<_, i64>(1)?.max(0) as usize,
                    composite_score: row.get(2)?,
                    strength_score: row.get(3)?,
                    low_volatility_score: row.get(4)?,
                    activity_score: row.get(5)?,
                    raw_activity_score: row.get(6)?,
                    trend_quality_score: row.get(7)?,
                    liquidity_score: row.get(8)?,
                    spread_bps: row.get(9)?,
                    history_ready: row.get::<_, i64>(10)? != 0,
                },
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(|error| error.to_string());
    result
}

fn validate_snapshot_input(input: &MarketRadarSnapshotInput) -> Result<(), String> {
    if input.fetched_at <= 0 || input.fetched_at > now_ms() + 5 * 60_000 {
        return Err("Market Radar snapshot time is invalid".to_string());
    }
    if input.model_version.trim().is_empty() || input.model_version.len() > 80 {
        return Err("Market Radar model version is invalid".to_string());
    }
    if input.rows.is_empty() || input.rows.len() > RADAR_MAX_UNIVERSE_SIZE {
        return Err("Market Radar snapshot universe size is invalid".to_string());
    }
    let mut instruments = HashSet::new();
    for row in &input.rows {
        if !valid_instrument_id(&row.inst_id) || !instruments.insert(row.inst_id.clone()) {
            return Err(
                "Market Radar snapshot contains an invalid or duplicate instrument".to_string(),
            );
        }
        if row.rank == 0 || row.rank > input.rows.len() {
            return Err("Market Radar snapshot contains an invalid rank".to_string());
        }
        for value in [
            row.composite_score,
            row.strength_score,
            row.low_volatility_score,
            row.activity_score,
            row.raw_activity_score,
            row.trend_quality_score,
            row.liquidity_score,
        ] {
            if !value.is_finite() || !(0.0..=100.0).contains(&value) {
                return Err("Market Radar snapshot contains an invalid score".to_string());
            }
        }
        if row
            .raw_trend_quality_score
            .is_some_and(|value| !value.is_finite() || !(0.0..=100.0).contains(&value))
            || row
                .volatility_20d_pct
                .is_some_and(|value| !value.is_finite() || value < 0.0)
            || !row.change_24h_pct.is_finite()
            || !row.turnover_24h.is_finite()
            || row.turnover_24h < 0.0
            || !row.last_price.is_finite()
            || row.last_price <= 0.0
            || row
                .spread_bps
                .is_some_and(|value| !value.is_finite() || value < 0.0)
        {
            return Err("Market Radar snapshot contains invalid market metrics".to_string());
        }
    }
    Ok(())
}

fn valid_instrument_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

#[tauri::command]
pub async fn market_radar_validation_report(
    app: tauri::AppHandle,
    request: MarketRadarValidationRequest,
) -> Result<MarketRadarValidationReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        build_validation_report(&open_read_database(&app)?, request.lookback_days)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn build_validation_report(
    conn: &Connection,
    requested_lookback_days: Option<i64>,
) -> Result<MarketRadarValidationReport, String> {
    let generated_at = now_ms();
    let lookback_days = requested_lookback_days.unwrap_or(90).clamp(20, 90);
    let cutoff = generated_at.saturating_sub(lookback_days * 24 * 60 * 60_000);
    let mut statement = conn
        .prepare(
            "WITH daily(snapshot_at) AS (
               SELECT MAX(snapshot_at) FROM market_radar_snapshots
               WHERE snapshot_at>=?1 GROUP BY snapshot_at / 86400000
             )
             SELECT rows.snapshot_at,rows.inst_id,rows.rank,rows.composite_score,
                    rows.category,rows.last_price,rows.spread_bps
             FROM daily JOIN market_radar_snapshot_rows rows USING(snapshot_at)
             WHERE rows.last_price>0
             ORDER BY rows.snapshot_at ASC,rows.rank ASC",
        )
        .map_err(|error| error.to_string())?;
    let snapshot_rows = statement
        .query_map([cutoff], |row| {
            Ok(ValidationSnapshotRow {
                snapshot_at: row.get(0)?,
                inst_id: row.get(1)?,
                rank: row.get::<_, i64>(2)?.max(0) as usize,
                score: row.get(3)?,
                category: row.get(4)?,
                last_price: row.get(5)?,
                spread_bps: row.get(6)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let snapshot_dates = snapshot_rows
        .iter()
        .map(|row| row.snapshot_at)
        .collect::<HashSet<_>>();
    let first_snapshot_at = snapshot_dates.iter().min().copied();
    let last_snapshot_at = snapshot_dates.iter().max().copied();
    let model_versions = load_validation_model_versions(conn, cutoff)?;
    if snapshot_rows.is_empty() {
        return Ok(MarketRadarValidationReport {
            status: "accumulating".to_string(),
            generated_at,
            lookback_days,
            snapshot_dates: 0,
            first_snapshot_at: None,
            last_snapshot_at: None,
            model_versions,
            horizons: [1, 5, 20]
                .into_iter()
                .map(|days| validation_horizon(days, ValidationStats::default()))
                .collect(),
            regimes: Vec::new(),
            limitations: validation_limitations(),
        });
    }

    let mut instruments = HashMap::<String, String>::new();
    for row in &snapshot_rows {
        instruments.entry(row.inst_id.clone()).or_insert_with(|| {
            if row.category.as_deref() == Some("3") {
                "1Dutc-forward".to_string()
            } else {
                "1Dutc".to_string()
            }
        });
    }
    let candles = load_validation_candles(
        conn,
        &instruments,
        first_snapshot_at
            .unwrap_or(cutoff)
            .saturating_sub(24 * 60 * 60_000),
    )?;
    let mut observations_by_horizon = HashMap::<i64, Vec<ValidationObservation>>::new();
    let mut benchmark_by_horizon = HashMap::<i64, HashMap<i64, f64>>::new();
    for horizon_days in [1, 5, 20] {
        for row in &snapshot_rows {
            let Some(close) = forward_close(
                candles
                    .get(&row.inst_id)
                    .map(Vec::as_slice)
                    .unwrap_or_default(),
                row.snapshot_at,
                horizon_days,
            ) else {
                continue;
            };
            let forward_return = close / row.last_price - 1.0;
            if !forward_return.is_finite() {
                continue;
            }
            observations_by_horizon
                .entry(horizon_days)
                .or_default()
                .push(ValidationObservation {
                    snapshot_at: row.snapshot_at,
                    instrument_id: row.inst_id.clone(),
                    rank: row.rank,
                    score: row.score,
                    forward_return,
                    spread_bps: row.spread_bps,
                });
            if row.inst_id == "BTC-USDT-SWAP" {
                benchmark_by_horizon
                    .entry(horizon_days)
                    .or_default()
                    .insert(row.snapshot_at, forward_return);
            }
        }
    }
    let horizons = [1, 5, 20]
        .into_iter()
        .map(|days| {
            validation_horizon(
                days,
                evaluate_validation(
                    observations_by_horizon
                        .get(&days)
                        .map(Vec::as_slice)
                        .unwrap_or_default(),
                ),
            )
        })
        .collect::<Vec<_>>();
    let regimes = build_validation_regimes(
        observations_by_horizon
            .get(&5)
            .map(Vec::as_slice)
            .unwrap_or_default(),
        benchmark_by_horizon.get(&5),
    );
    let completed_dates = horizons.iter().map(|row| row.dates).max().unwrap_or(0);
    Ok(MarketRadarValidationReport {
        status: if completed_dates >= 5 {
            "ready"
        } else {
            "accumulating"
        }
        .to_string(),
        generated_at,
        lookback_days,
        snapshot_dates: snapshot_dates.len(),
        first_snapshot_at,
        last_snapshot_at,
        model_versions,
        horizons,
        regimes,
        limitations: validation_limitations(),
    })
}

fn load_validation_model_versions(conn: &Connection, cutoff: i64) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare(
            "SELECT DISTINCT model_version FROM market_radar_snapshots
             WHERE snapshot_at>=?1 ORDER BY model_version ASC",
        )
        .map_err(|error| error.to_string())?;
    let result = statement
        .query_map([cutoff], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string());
    result
}

fn load_validation_candles(
    conn: &Connection,
    instruments: &HashMap<String, String>,
    cutoff: i64,
) -> Result<HashMap<String, Vec<(i64, f64)>>, String> {
    if instruments.is_empty() {
        return Ok(HashMap::new());
    }
    let mut pairs = instruments.iter().collect::<Vec<_>>();
    pairs.sort_by(|left, right| left.0.cmp(right.0));
    let mut placeholders = Vec::with_capacity(pairs.len());
    let mut values = Vec::<rusqlite::types::Value>::with_capacity(pairs.len() * 2 + 1);
    for (index, (inst_id, interval)) in pairs.into_iter().enumerate() {
        let parameter = index * 2 + 1;
        placeholders.push(format!("(?{parameter},?{})", parameter + 1));
        values.push(rusqlite::types::Value::Text(inst_id.clone()));
        values.push(rusqlite::types::Value::Text(interval.clone()));
    }
    let cutoff_parameter = values.len() + 1;
    values.push(rusqlite::types::Value::Integer(cutoff));
    let sql = format!(
        "WITH instruments(symbol,interval) AS (VALUES {})
         SELECT candles.symbol,candles.open_time,candles.close
         FROM instruments JOIN candles
           ON candles.symbol=instruments.symbol AND candles.interval=instruments.interval
         WHERE candles.confirm=1 AND candles.open_time>=?{}
         ORDER BY candles.symbol ASC,candles.open_time ASC",
        placeholders.join(","),
        cutoff_parameter,
    );
    let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(values.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut candles = HashMap::<String, Vec<(i64, f64)>>::new();
    for row in rows {
        let (inst_id, open_time, close) = row.map_err(|error| error.to_string())?;
        let Ok(close) = close.parse::<f64>() else {
            continue;
        };
        if close.is_finite() && close > 0.0 {
            candles.entry(inst_id).or_default().push((open_time, close));
        }
    }
    Ok(candles)
}

fn forward_close(candles: &[(i64, f64)], snapshot_at: i64, horizon_days: i64) -> Option<f64> {
    let target_close_at = snapshot_at.saturating_add(horizon_days * 24 * 60 * 60_000);
    let index = candles.partition_point(|(open_time, _)| {
        open_time.saturating_add(24 * 60 * 60_000) < target_close_at
    });
    candles.get(index).map(|(_, close)| *close)
}

fn validation_horizon(days: i64, stats: ValidationStats) -> MarketRadarValidationHorizon {
    let percent = |value: Option<f64>| value.map(|number| number * 100.0);
    MarketRadarValidationHorizon {
        horizon_days: days,
        observations: stats.observations,
        dates: stats.dates,
        rank_ic: stats.rank_ic,
        training_rank_ic: stats.training_rank_ic,
        validation_rank_ic: stats.validation_rank_ic,
        ic_stability_delta: stats
            .validation_rank_ic
            .zip(stats.training_rank_ic)
            .map(|(validation, training)| validation - training),
        top_quantile_return_pct: percent(stats.top_quantile_return),
        bottom_quantile_return_pct: percent(stats.bottom_quantile_return),
        gross_spread_pct: percent(stats.gross_spread),
        net_spread_after_cost_pct: percent(stats.net_spread_after_cost),
        top_quantile_win_rate_pct: percent(stats.top_quantile_win_rate),
        top_quantile_turnover_pct: percent(stats.top_quantile_turnover),
    }
}

fn build_validation_regimes(
    observations: &[ValidationObservation],
    benchmarks: Option<&HashMap<i64, f64>>,
) -> Vec<MarketRadarValidationRegime> {
    let Some(benchmarks) = benchmarks else {
        return Vec::new();
    };
    [("up", 0), ("sideways", 1), ("down", 2)]
        .into_iter()
        .map(|(regime, code)| {
            let rows = observations
                .iter()
                .filter(|row| {
                    benchmarks
                        .get(&row.snapshot_at)
                        .is_some_and(|value| match code {
                            0 => *value > 0.02,
                            2 => *value < -0.02,
                            _ => (-0.02..=0.02).contains(value),
                        })
                })
                .cloned()
                .collect::<Vec<_>>();
            let stats = evaluate_validation(&rows);
            MarketRadarValidationRegime {
                regime: regime.to_string(),
                horizon_days: 5,
                observations: stats.observations,
                dates: stats.dates,
                rank_ic: stats.rank_ic,
                gross_spread_pct: stats.gross_spread.map(|value| value * 100.0),
            }
        })
        .collect()
}

fn validation_limitations() -> Vec<String> {
    vec![
        "Only point-in-time universes saved by Market Radar snapshots are evaluated".to_string(),
        "Forward returns use confirmed daily candles after the saved snapshot time".to_string(),
        "The net spread subtracts the saved top and bottom spread proxy; it is not an execution simulation".to_string(),
        "Results are research diagnostics, not profit forecasts or trading signals".to_string(),
    ]
}

#[tauri::command]
pub fn market_radar_saved_filters(
    app: tauri::AppHandle,
) -> Result<Vec<MarketRadarSavedItem>, String> {
    list_saved_items(&open_read_database(&app)?, "market_radar_saved_filters")
}

#[tauri::command]
pub fn market_radar_save_filter(
    app: tauri::AppHandle,
    input: MarketRadarSavedItemInput,
) -> Result<MarketRadarSavedItem, String> {
    save_item(&open_database(&app)?, "market_radar_saved_filters", input)
}

#[tauri::command]
pub fn market_radar_delete_filter(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    delete_item(&open_database(&app)?, "market_radar_saved_filters", &id)
}

#[tauri::command]
pub fn market_radar_alert_rules(
    app: tauri::AppHandle,
) -> Result<Vec<MarketRadarSavedItem>, String> {
    list_saved_items(&open_read_database(&app)?, "market_radar_alert_rules")
}

#[tauri::command]
pub fn market_radar_save_alert_rule(
    app: tauri::AppHandle,
    input: MarketRadarSavedItemInput,
) -> Result<MarketRadarSavedItem, String> {
    let definition: MarketRadarAlertDefinition = serde_json::from_str(&input.definition_json)
        .map_err(|_| "Market Radar alert definition must be JSON".to_string())?;
    validate_alert_definition(&definition)?;
    save_item(&open_database(&app)?, "market_radar_alert_rules", input)
}

#[tauri::command]
pub fn market_radar_delete_alert_rule(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    delete_item(&open_database(&app)?, "market_radar_alert_rules", &id)
}

fn list_saved_items(conn: &Connection, table: &str) -> Result<Vec<MarketRadarSavedItem>, String> {
    let sql = format!(
        "SELECT id,name,definition_json,enabled,created_at,updated_at FROM {table} ORDER BY updated_at DESC"
    );
    let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let result = statement
        .query_map([], |row| {
            Ok(MarketRadarSavedItem {
                id: row.get(0)?,
                name: row.get(1)?,
                definition_json: row.get(2)?,
                enabled: row.get::<_, i64>(3)? != 0,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string());
    result
}

fn save_item(
    conn: &Connection,
    table: &str,
    input: MarketRadarSavedItemInput,
) -> Result<MarketRadarSavedItem, String> {
    validate_saved_item(&input)?;
    let now = now_ms();
    let created_at = conn
        .query_row(
            &format!("SELECT created_at FROM {table} WHERE id=?1"),
            [&input.id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or(now);
    let enabled = input.enabled.unwrap_or(true);
    conn.execute(
        &format!(
            "INSERT INTO {table}(id,name,definition_json,enabled,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6)
             ON CONFLICT(id) DO UPDATE SET
               name=excluded.name,definition_json=excluded.definition_json,
               enabled=excluded.enabled,updated_at=excluded.updated_at"
        ),
        params![
            input.id,
            input.name,
            input.definition_json,
            i64::from(enabled),
            created_at,
            now
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(MarketRadarSavedItem {
        id: input.id,
        name: input.name,
        definition_json: input.definition_json,
        enabled,
        created_at,
        updated_at: now,
    })
}

fn delete_item(conn: &Connection, table: &str, id: &str) -> Result<bool, String> {
    if !valid_saved_id(id) {
        return Err("Market Radar saved item id is invalid".to_string());
    }
    conn.execute(&format!("DELETE FROM {table} WHERE id=?1"), [id])
        .map(|changed| changed > 0)
        .map_err(|error| error.to_string())
}

fn validate_saved_item(input: &MarketRadarSavedItemInput) -> Result<(), String> {
    if !valid_saved_id(&input.id) {
        return Err("Market Radar saved item id is invalid".to_string());
    }
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 64 || name.chars().any(char::is_control) {
        return Err("Market Radar saved item name is invalid".to_string());
    }
    if input.definition_json.len() > RADAR_MAX_SAVED_DEFINITION_BYTES {
        return Err("Market Radar saved item definition is too large".to_string());
    }
    let value: Value = serde_json::from_str(&input.definition_json)
        .map_err(|_| "Market Radar saved item definition must be JSON".to_string())?;
    if !value.is_object() {
        return Err("Market Radar saved item definition must be an object".to_string());
    }
    Ok(())
}

fn valid_saved_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiRadarRankingRequest {
    ranking_basis: Option<String>,
    category: Option<String>,
    saved_filter_id: Option<String>,
    as_of: Option<i64>,
    limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiRadarInstrumentRequest {
    inst_id: String,
    as_of: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiRadarCompareRequest {
    inst_ids: Vec<String>,
    as_of: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiRadarHistoryRequest {
    inst_id: String,
    lookback_days: Option<i64>,
    limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiRadarValidationToolRequest {
    lookback_days: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AiRadarFilterDefinition {
    version: u32,
    category: Option<String>,
    min_turnover_24h: Option<f64>,
    max_spread_bps: Option<f64>,
    min_composite_score: Option<f64>,
    min_trend_quality_score: Option<f64>,
    max_volatility_20d_pct: Option<f64>,
    listed_within_days: Option<f64>,
    history_ready: Option<bool>,
    watchlist_only: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiRadarSnapshotRow {
    inst_id: String,
    category: Option<String>,
    category_name: &'static str,
    list_time: Option<i64>,
    global_rank: usize,
    scope_rank: Option<usize>,
    composite_score: f64,
    component_contributions: MarketRadarComponentDelta,
    raw_activity_score: f64,
    raw_trend_quality_score: Option<f64>,
    volatility_20d_pct: Option<f64>,
    change_24h_pct: f64,
    turnover_24h: f64,
    last_price: f64,
    spread_bps: Option<f64>,
    history_ready: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiRadarSnapshotMeta {
    snapshot_at: i64,
    model_version: String,
    universe_size: usize,
}

pub(crate) async fn execute_market_radar_ai_tool(
    app: tauri::AppHandle,
    tool_name: &str,
    input: Value,
) -> Result<Value, String> {
    let tool_name = tool_name.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_read_database(&app)?;
        execute_market_radar_ai_tool_with_conn(&conn, &tool_name, input)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn execute_market_radar_ai_tool_with_conn(
    conn: &Connection,
    tool_name: &str,
    input: Value,
) -> Result<Value, String> {
    match tool_name {
        "radar.readRanking" => {
            let request = serde_json::from_value::<AiRadarRankingRequest>(input)
                .map_err(|error| format!("radar.readRanking 参数无效：{error}"))?;
            ai_radar_read_ranking(conn, request)
        }
        "radar.readInstrumentEvidence" => {
            let request = serde_json::from_value::<AiRadarInstrumentRequest>(input)
                .map_err(|error| format!("radar.readInstrumentEvidence 参数无效：{error}"))?;
            ai_radar_read_instrument(conn, request)
        }
        "radar.compareMarkets" => {
            let request = serde_json::from_value::<AiRadarCompareRequest>(input)
                .map_err(|error| format!("radar.compareMarkets 参数无效：{error}"))?;
            ai_radar_compare(conn, request)
        }
        "radar.readBreadth" => {
            ensure_empty_ai_tool_input(&input, "radar.readBreadth")?;
            ai_radar_read_breadth(conn)
        }
        "radar.readRankHistory" => {
            let request = serde_json::from_value::<AiRadarHistoryRequest>(input)
                .map_err(|error| format!("radar.readRankHistory 参数无效：{error}"))?;
            ai_radar_read_rank_history(conn, request)
        }
        "radar.readValidationReport" => {
            let request = serde_json::from_value::<AiRadarValidationToolRequest>(input)
                .map_err(|error| format!("radar.readValidationReport 参数无效：{error}"))?;
            if request
                .lookback_days
                .is_some_and(|value| !(20..=90).contains(&value))
            {
                return Err(
                    "radar.readValidationReport lookbackDays 必须在 20 至 90 之间".to_string(),
                );
            }
            let mut report =
                serde_json::to_value(build_validation_report(conn, request.lookback_days)?)
                    .map_err(|error| error.to_string())?;
            report["readOnly"] = json!(true);
            Ok(report)
        }
        "radar.listSavedFilters" => {
            ensure_empty_ai_tool_input(&input, "radar.listSavedFilters")?;
            let filters = list_saved_items(conn, "market_radar_saved_filters")?
                .into_iter()
                .map(|item| {
                    Ok(json!({
                        "id": item.id,
                        "name": item.name,
                        "definition": serde_json::from_str::<Value>(&item.definition_json)
                            .map_err(|error| error.to_string())?,
                        "enabled": item.enabled,
                        "createdAt": item.created_at,
                        "updatedAt": item.updated_at,
                    }))
                })
                .collect::<Result<Vec<_>, String>>()?;
            Ok(json!({
                "generatedAt": now_ms(),
                "source": "market_radar_saved_filters",
                "filters": filters,
                "count": filters.len(),
                "readOnly": true,
                "limitations": radar_ai_limitations(),
            }))
        }
        _ => Err(format!("未知 Market Radar AI 工具：{tool_name}")),
    }
}

fn ensure_empty_ai_tool_input(input: &Value, tool_name: &str) -> Result<(), String> {
    if input.as_object().is_none_or(serde_json::Map::is_empty) {
        Ok(())
    } else {
        Err(format!("{tool_name} 不接受参数"))
    }
}

fn latest_radar_snapshot(
    conn: &Connection,
    as_of: Option<i64>,
) -> Result<Option<AiRadarSnapshotMeta>, String> {
    let as_of = as_of.filter(|value| *value != 0).unwrap_or_else(now_ms);
    if as_of < 0 || as_of > now_ms() + 5 * 60_000 {
        return Err("Market Radar asOf 必须是有效的 Unix 毫秒时间".to_string());
    }
    conn.query_row(
        "SELECT snapshot_at,model_version,universe_size FROM market_radar_snapshots
         WHERE snapshot_at<=?1 ORDER BY snapshot_at DESC LIMIT 1",
        [as_of],
        |row| {
            Ok(AiRadarSnapshotMeta {
                snapshot_at: row.get(0)?,
                model_version: row.get(1)?,
                universe_size: row.get::<_, i64>(2)?.max(0) as usize,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn load_ai_radar_rows(
    conn: &Connection,
    snapshot_at: i64,
) -> Result<Vec<AiRadarSnapshotRow>, String> {
    let mut statement = conn
        .prepare(
            "SELECT inst_id,category,list_time,rank,composite_score,strength_score,
                    low_volatility_score,activity_score,raw_activity_score,trend_quality_score,
                    liquidity_score,change_24h_pct,turnover_24h,last_price,spread_bps,history_ready,
                    raw_trend_quality_score,volatility_20d_pct
             FROM market_radar_snapshot_rows WHERE snapshot_at=?1 ORDER BY rank ASC",
        )
        .map_err(|error| error.to_string())?;
    let result = statement
        .query_map([snapshot_at], |row| {
            let category = row.get::<_, Option<String>>(1)?;
            Ok(AiRadarSnapshotRow {
                inst_id: row.get(0)?,
                category_name: radar_category_name(category.as_deref()),
                category,
                list_time: row.get(2)?,
                global_rank: row.get::<_, i64>(3)?.max(0) as usize,
                scope_rank: None,
                composite_score: row.get(4)?,
                component_contributions: MarketRadarComponentDelta {
                    composite: row.get(4)?,
                    strength: row.get(5)?,
                    low_volatility: row.get(6)?,
                    activity: row.get(7)?,
                    trend_quality: row.get(9)?,
                    liquidity: row.get(10)?,
                },
                raw_activity_score: row.get(8)?,
                raw_trend_quality_score: row.get(16)?,
                volatility_20d_pct: row.get(17)?,
                change_24h_pct: row.get(11)?,
                turnover_24h: row.get(12)?,
                last_price: row.get(13)?,
                spread_bps: row.get(14)?,
                history_ready: row.get::<_, i64>(15)? != 0,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string());
    result
}

fn ai_radar_read_ranking(
    conn: &Connection,
    request: AiRadarRankingRequest,
) -> Result<Value, String> {
    let basis = request.ranking_basis.as_deref().unwrap_or("composite");
    if !matches!(
        basis,
        "composite"
            | "change24h"
            | "turnover24h"
            | "activity"
            | "liquidityContribution"
            | "lowVolatilityContribution"
            | "trendQualityContribution"
            | "spreadBpsAsc"
    ) {
        return Err(format!("不支持的 Market Radar 排名口径：{basis}"));
    }
    let category = normalize_radar_category(request.category.as_deref())?;
    let limit = request.limit.unwrap_or(20);
    if !(1..=100).contains(&limit) {
        return Err("radar.readRanking limit 必须在 1 至 100 之间".to_string());
    }
    let Some(meta) = latest_radar_snapshot(conn, request.as_of)? else {
        return Ok(radar_ai_empty("ranking", "尚无 Market Radar 小时快照"));
    };
    let saved_filter = load_ai_radar_filter(conn, request.saved_filter_id.as_deref())?;
    let applied_saved_filter_id = saved_filter.as_ref().and_then(|_| {
        request
            .saved_filter_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    });
    let snapshot_rows = load_ai_radar_rows(conn, meta.snapshot_at)?;
    if let Some(filter) = saved_filter.as_ref() {
        if filter.min_trend_quality_score.is_some()
            && !snapshot_rows
                .iter()
                .any(|row| row.raw_trend_quality_score.is_some())
        {
            return Err("所选旧快照未保存原始趋势稳定性，无法精确复现筛选方案".to_string());
        }
        if filter.max_volatility_20d_pct.is_some()
            && !snapshot_rows
                .iter()
                .any(|row| row.volatility_20d_pct.is_some())
        {
            return Err("所选旧快照未保存 20 日波动率，无法精确复现筛选方案".to_string());
        }
    }
    let mut rows = snapshot_rows
        .into_iter()
        .filter(|row| {
            category
                .as_deref()
                .is_none_or(|value| row.category.as_deref() == Some(value))
        })
        .filter(|row| ai_radar_filter_matches(row, saved_filter.as_ref(), meta.snapshot_at))
        .collect::<Vec<_>>();
    sort_ai_radar_rows(&mut rows, basis);
    for (index, row) in rows.iter_mut().enumerate() {
        row.scope_rank = Some(index + 1);
    }
    let matched_size = rows.len();
    rows.truncate(limit);
    Ok(json!({
        "snapshotAt": meta.snapshot_at,
        "modelVersion": meta.model_version,
        "universeSize": meta.universe_size,
        "matchedSize": matched_size,
        "rankingBasis": basis,
        "category": category,
        "savedFilterId": applied_saved_filter_id,
        "rows": rows,
        "readOnly": true,
        "limitations": radar_ai_limitations(),
    }))
}

fn ai_radar_read_instrument(
    conn: &Connection,
    request: AiRadarInstrumentRequest,
) -> Result<Value, String> {
    if !valid_instrument_id(&request.inst_id) {
        return Err("Market Radar instId 无效".to_string());
    }
    let Some(meta) = latest_radar_snapshot(conn, request.as_of)? else {
        return Ok(radar_ai_empty(
            "instrumentEvidence",
            "尚无 Market Radar 小时快照",
        ));
    };
    let row = load_ai_radar_rows(conn, meta.snapshot_at)?
        .into_iter()
        .find(|row| row.inst_id == request.inst_id);
    let Some(row) = row else {
        return Ok(json!({
            "snapshotAt": meta.snapshot_at,
            "instId": request.inst_id,
            "found": false,
            "limitations": radar_ai_limitations(),
        }));
    };
    let changes = ai_radar_rank_changes(conn, meta.snapshot_at, &row);
    Ok(json!({
        "snapshotAt": meta.snapshot_at,
        "modelVersion": meta.model_version,
        "universeSize": meta.universe_size,
        "found": true,
        "evidence": row,
        "rankChanges": changes,
        "readOnly": true,
        "limitations": radar_ai_limitations(),
    }))
}

fn ai_radar_compare(conn: &Connection, request: AiRadarCompareRequest) -> Result<Value, String> {
    if !(2..=4).contains(&request.inst_ids.len())
        || request
            .inst_ids
            .iter()
            .any(|value| !valid_instrument_id(value))
        || request.inst_ids.iter().collect::<HashSet<_>>().len() != request.inst_ids.len()
    {
        return Err("radar.compareMarkets 需要 2 至 4 个不重复的有效 instId".to_string());
    }
    let Some(meta) = latest_radar_snapshot(conn, request.as_of)? else {
        return Ok(radar_ai_empty("comparison", "尚无 Market Radar 小时快照"));
    };
    let by_id = load_ai_radar_rows(conn, meta.snapshot_at)?
        .into_iter()
        .map(|row| (row.inst_id.clone(), row))
        .collect::<HashMap<_, _>>();
    let rows = request
        .inst_ids
        .iter()
        .map(|inst_id| {
            by_id.get(inst_id).map_or_else(
                || json!({ "instId": inst_id, "found": false }),
                |row| {
                    json!({
                        "instId": inst_id,
                        "found": true,
                        "evidence": row,
                        "rankChanges": ai_radar_rank_changes(conn, meta.snapshot_at, row),
                    })
                },
            )
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "snapshotAt": meta.snapshot_at,
        "modelVersion": meta.model_version,
        "universeSize": meta.universe_size,
        "markets": rows,
        "readOnly": true,
        "limitations": radar_ai_limitations(),
    }))
}

fn ai_radar_read_breadth(conn: &Connection) -> Result<Value, String> {
    let Some(meta) = latest_radar_snapshot(conn, None)? else {
        return Ok(radar_ai_empty("breadth", "尚无 Market Radar 小时快照"));
    };
    let rows = load_ai_radar_rows(conn, meta.snapshot_at)?;
    let mut grouped = HashMap::<String, Vec<&AiRadarSnapshotRow>>::new();
    grouped.insert("all".to_string(), rows.iter().collect());
    for row in &rows {
        grouped
            .entry(row.category.clone().unwrap_or_else(|| "other".to_string()))
            .or_default()
            .push(row);
    }
    let mut groups = grouped
        .into_iter()
        .map(|(category, rows)| {
            let count = rows.len();
            let advancing = rows.iter().filter(|row| row.change_24h_pct > 0.0).count();
            let declining = rows.iter().filter(|row| row.change_24h_pct < 0.0).count();
            let history_ready = rows.iter().filter(|row| row.history_ready).count();
            json!({
                "categoryName": if category == "all" { "all" } else { radar_category_name(Some(&category)) },
                "category": category,
                "count": count,
                "advancing": advancing,
                "declining": declining,
                "advancePct": radar_ratio(advancing, count),
                "historyCoveragePct": radar_ratio(history_ready, count),
                "medianChange24hPct": radar_median(rows.iter().map(|row| row.change_24h_pct)),
                "medianCompositeScore": radar_median(rows.iter().map(|row| row.composite_score)),
                "turnover24h": rows.iter().map(|row| row.turnover_24h).sum::<f64>(),
            })
        })
        .collect::<Vec<_>>();
    groups.sort_by(|left, right| {
        let left_all = left.get("category").and_then(Value::as_str) == Some("all");
        let right_all = right.get("category").and_then(Value::as_str) == Some("all");
        right_all.cmp(&left_all).then_with(|| {
            right
                .get("medianCompositeScore")
                .and_then(Value::as_f64)
                .unwrap_or_default()
                .total_cmp(
                    &left
                        .get("medianCompositeScore")
                        .and_then(Value::as_f64)
                        .unwrap_or_default(),
                )
        })
    });
    let mut category_rank = 0usize;
    for group in &mut groups {
        if group.get("category").and_then(Value::as_str) != Some("all") {
            category_rank += 1;
            group["strengthRank"] = json!(category_rank);
        }
    }
    Ok(json!({
        "snapshotAt": meta.snapshot_at,
        "modelVersion": meta.model_version,
        "universeSize": meta.universe_size,
        "groups": groups,
        "readOnly": true,
        "limitations": radar_ai_limitations(),
    }))
}

fn ai_radar_read_rank_history(
    conn: &Connection,
    request: AiRadarHistoryRequest,
) -> Result<Value, String> {
    if !valid_instrument_id(&request.inst_id) {
        return Err("Market Radar instId 无效".to_string());
    }
    let lookback_days = request.lookback_days.unwrap_or(30);
    let limit = request.limit.unwrap_or(100);
    if !(1..=90).contains(&lookback_days) || !(1..=200).contains(&limit) {
        return Err(
            "radar.readRankHistory lookbackDays 必须为 1 至 90，limit 必须为 1 至 200".to_string(),
        );
    }
    let cutoff = now_ms().saturating_sub(lookback_days * 24 * 60 * 60_000);
    let mut statement = conn
        .prepare(
            "SELECT rows.snapshot_at,snapshots.model_version,snapshots.universe_size,
                    rows.rank,rows.composite_score,rows.strength_score,rows.low_volatility_score,
                    rows.activity_score,rows.trend_quality_score,rows.liquidity_score,
                    rows.change_24h_pct,rows.turnover_24h,rows.spread_bps
             FROM market_radar_snapshot_rows rows
             JOIN market_radar_snapshots snapshots USING(snapshot_at)
             WHERE rows.inst_id=?1 AND rows.snapshot_at>=?2
             ORDER BY rows.snapshot_at DESC LIMIT ?3",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![request.inst_id, cutoff, limit as i64], |row| {
            Ok(json!({
                "snapshotAt": row.get::<_, i64>(0)?,
                "modelVersion": row.get::<_, String>(1)?,
                "universeSize": row.get::<_, i64>(2)?.max(0) as usize,
                "globalRank": row.get::<_, i64>(3)?.max(0) as usize,
                "compositeScore": row.get::<_, f64>(4)?,
                "componentContributions": {
                    "strength": row.get::<_, f64>(5)?,
                    "lowVolatility": row.get::<_, f64>(6)?,
                    "activity": row.get::<_, f64>(7)?,
                    "trendQuality": row.get::<_, f64>(8)?,
                    "liquidity": row.get::<_, f64>(9)?,
                },
                "change24hPct": row.get::<_, f64>(10)?,
                "turnover24h": row.get::<_, f64>(11)?,
                "spreadBps": row.get::<_, Option<f64>>(12)?,
            }))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(json!({
        "instId": request.inst_id,
        "lookbackDays": lookback_days,
        "count": rows.len(),
        "rows": rows,
        "order": "snapshotAtDescending",
        "readOnly": true,
        "limitations": radar_ai_limitations(),
    }))
}

fn load_ai_radar_filter(
    conn: &Connection,
    id: Option<&str>,
) -> Result<Option<AiRadarFilterDefinition>, String> {
    let Some(id) = id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if id == ".invalid?" {
        return Ok(None);
    }
    if !valid_saved_id(id) {
        return Err("Market Radar savedFilterId 无效".to_string());
    }
    let definition = conn
        .query_row(
            "SELECT definition_json FROM market_radar_saved_filters WHERE id=?1 AND enabled=1",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(definition) = definition else {
        if matches!(
            id.to_ascii_lowercase().as_str(),
            "all" | "all-markets" | "all_markets"
        ) {
            return Ok(None);
        }
        return Err(format!(
            "未找到已启用的 Market Radar 筛选方案：{id}；全市场查询请省略 savedFilterId，命名筛选请先调用 radar.listSavedFilters"
        ));
    };
    let filter = serde_json::from_str::<AiRadarFilterDefinition>(&definition)
        .map_err(|error| format!("Market Radar 筛选方案无法解析：{error}"))?;
    if filter.version != 1 {
        return Err("Market Radar 筛选方案版本不受支持".to_string());
    }
    if filter
        .category
        .as_deref()
        .is_some_and(|value| !matches!(value, "1" | "3" | "4" | "5" | "6"))
    {
        return Err("Market Radar 筛选方案包含无效类别".to_string());
    }
    if [
        filter.min_turnover_24h,
        filter.max_spread_bps,
        filter.listed_within_days,
        filter.max_volatility_20d_pct,
    ]
    .into_iter()
    .flatten()
    .any(|value| !value.is_finite() || value < 0.0)
        || [filter.min_composite_score, filter.min_trend_quality_score]
            .into_iter()
            .flatten()
            .any(|value| !value.is_finite() || !(0.0..=100.0).contains(&value))
    {
        return Err("Market Radar 筛选方案包含无效数值".to_string());
    }
    if filter.watchlist_only == Some(true) {
        return Err("AI 工具无法复现依赖前端自选列表的筛选方案".to_string());
    }
    Ok(Some(filter))
}

fn ai_radar_filter_matches(
    row: &AiRadarSnapshotRow,
    filter: Option<&AiRadarFilterDefinition>,
    snapshot_at: i64,
) -> bool {
    let Some(filter) = filter else {
        return true;
    };
    if filter
        .category
        .as_deref()
        .is_some_and(|category| row.category.as_deref() != Some(category))
        || filter
            .min_turnover_24h
            .is_some_and(|value| row.turnover_24h < value)
        || filter
            .max_spread_bps
            .is_some_and(|value| row.spread_bps.is_none_or(|spread| spread > value))
        || filter
            .min_composite_score
            .is_some_and(|value| row.composite_score < value)
        || filter.min_trend_quality_score.is_some_and(|value| {
            row.raw_trend_quality_score
                .is_none_or(|score| score < value)
        })
        || filter.max_volatility_20d_pct.is_some_and(|value| {
            row.volatility_20d_pct
                .is_none_or(|volatility| volatility > value)
        })
        || filter.history_ready == Some(true) && !row.history_ready
    {
        return false;
    }
    if let Some(days) = filter.listed_within_days {
        let Some(list_time) = row.list_time else {
            return false;
        };
        if snapshot_at.saturating_sub(list_time) as f64 > days * 24.0 * 60.0 * 60_000.0 {
            return false;
        }
    }
    true
}

fn normalize_radar_category(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "all")
    else {
        return Ok(None);
    };
    let normalized = match value.to_ascii_lowercase().as_str() {
        "1" | "crypto" => "1",
        "3" | "stock" => "3",
        "4" | "commodity" => "4",
        "5" | "fx" | "forex" => "5",
        "6" | "bond" => "6",
        _ => return Err(format!("不支持的 Market Radar 类别：{value}")),
    };
    Ok(Some(normalized.to_string()))
}

fn radar_category_name(category: Option<&str>) -> &'static str {
    match category {
        Some("1") => "crypto",
        Some("3") => "stock",
        Some("4") => "commodity",
        Some("5") => "fx",
        Some("6") => "bond",
        _ => "other",
    }
}

fn sort_ai_radar_rows(rows: &mut [AiRadarSnapshotRow], basis: &str) {
    rows.sort_by(|left, right| {
        let order = match basis {
            "change24h" => right.change_24h_pct.total_cmp(&left.change_24h_pct),
            "turnover24h" => right.turnover_24h.total_cmp(&left.turnover_24h),
            "activity" => right.raw_activity_score.total_cmp(&left.raw_activity_score),
            "liquidityContribution" => right
                .component_contributions
                .liquidity
                .total_cmp(&left.component_contributions.liquidity),
            "lowVolatilityContribution" => right
                .component_contributions
                .low_volatility
                .total_cmp(&left.component_contributions.low_volatility),
            "trendQualityContribution" => right
                .component_contributions
                .trend_quality
                .total_cmp(&left.component_contributions.trend_quality),
            "spreadBpsAsc" => left
                .spread_bps
                .unwrap_or(f64::INFINITY)
                .total_cmp(&right.spread_bps.unwrap_or(f64::INFINITY)),
            _ => right.composite_score.total_cmp(&left.composite_score),
        };
        order.then_with(|| left.inst_id.cmp(&right.inst_id))
    });
}

fn ai_radar_rank_changes(conn: &Connection, snapshot_at: i64, row: &AiRadarSnapshotRow) -> Value {
    let change = |target: i64, tolerance: i64| {
        load_snapshot_near(conn, target, tolerance)
            .ok()
            .and_then(|rows| {
                rows.get(&row.inst_id)
                    .map(|prior| prior.rank as i64 - row.global_rank as i64)
            })
    };
    json!({
        "rankDelta1h": change(snapshot_at - RADAR_SNAPSHOT_INTERVAL_MS, 20 * 60_000),
        "rankDelta24h": change(snapshot_at - 24 * 60 * 60_000, 3 * 60 * 60_000),
        "rankDelta7d": change(snapshot_at - 7 * 24 * 60 * 60_000, 12 * 60 * 60_000),
        "positiveMeansImprovement": true,
    })
}

fn radar_ratio(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        0.0
    } else {
        numerator as f64 / denominator as f64 * 100.0
    }
}

fn radar_median(values: impl Iterator<Item = f64>) -> f64 {
    let mut values = values.filter(|value| value.is_finite()).collect::<Vec<_>>();
    values.sort_by(f64::total_cmp);
    if values.is_empty() {
        return 0.0;
    }
    let middle = values.len() / 2;
    if values.len() % 2 == 0 {
        (values[middle - 1] + values[middle]) / 2.0
    } else {
        values[middle]
    }
}

fn radar_ai_limitations() -> Vec<&'static str> {
    vec![
        "Market Radar ranks are cross-sectional research priority, not trading signals or profit forecasts",
        "Hourly snapshots are low-frequency evidence and may lag live market changes",
        "Component fields are weighted contributions to the saved composite score",
        "No radar AI tool can create alerts, change filters, place orders, or modify trading state",
    ]
}

fn radar_ai_empty(kind: &str, message: &str) -> Value {
    json!({
        "kind": kind,
        "status": "unavailable",
        "message": message,
        "rows": [],
        "readOnly": true,
        "limitations": radar_ai_limitations(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(inst_id: &str, rank: usize, score: f64) -> MarketRadarSnapshotRowInput {
        MarketRadarSnapshotRowInput {
            inst_id: inst_id.to_string(),
            category: Some("1".to_string()),
            list_time: Some(1_700_000_000_000),
            rank,
            composite_score: score,
            strength_score: score,
            low_volatility_score: score,
            activity_score: score,
            raw_activity_score: score,
            trend_quality_score: score,
            raw_trend_quality_score: Some(score),
            volatility_20d_pct: Some(2.0),
            liquidity_score: score,
            change_24h_pct: 1.0,
            turnover_24h: 1_000_000.0,
            last_price: 100.0,
            spread_bps: Some(1.0),
            history_ready: true,
        }
    }

    fn input(at: i64, rows: Vec<MarketRadarSnapshotRowInput>) -> MarketRadarSnapshotInput {
        MarketRadarSnapshotInput {
            fetched_at: at,
            model_version: "market-radar-v1".to_string(),
            rows,
        }
    }

    #[test]
    fn ai_radar_breadth_accepts_empty_input_and_rejects_unknown_fields() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_market_radar_workspace(&conn).unwrap();

        let result = execute_market_radar_ai_tool_with_conn(&conn, "radar.readBreadth", json!({}))
            .expect("empty breadth input should be accepted");
        assert_eq!(result.get("readOnly").and_then(Value::as_bool), Some(true));

        let error = execute_market_radar_ai_tool_with_conn(
            &conn,
            "radar.readBreadth",
            json!({ "unexpected": true }),
        )
        .expect_err("unknown breadth fields must remain default-deny");
        assert!(error.contains("不接受参数"));
    }

    #[test]
    fn snapshot_rank_deltas_are_positive_for_improvement() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate_market_radar_workspace(&conn).unwrap();
        let hour = RADAR_SNAPSHOT_INTERVAL_MS;
        let base = now_ms().div_euclid(hour) * hour - 24 * hour;
        record_snapshot_with_conn(
            &mut conn,
            input(
                base,
                vec![row("AAA-USDT-SWAP", 2, 40.0), row("BBB-USDT-SWAP", 1, 60.0)],
            ),
        )
        .unwrap();
        let result = record_snapshot_with_conn(
            &mut conn,
            input(
                base + 24 * hour,
                vec![row("AAA-USDT-SWAP", 1, 70.0), row("BBB-USDT-SWAP", 2, 30.0)],
            ),
        )
        .unwrap();
        let improved = result
            .changes
            .iter()
            .find(|row| row.inst_id.starts_with("AAA"))
            .unwrap();
        assert_eq!(improved.rank_delta_24h, Some(1));
        assert_eq!(
            improved
                .component_delta_24h
                .as_ref()
                .map(|delta| delta.composite),
            Some(30.0)
        );
    }

    #[test]
    fn same_hour_snapshot_is_replaced_not_duplicated() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate_market_radar_workspace(&conn).unwrap();
        let hour = RADAR_SNAPSHOT_INTERVAL_MS;
        let base = now_ms().div_euclid(hour) * hour;
        record_snapshot_with_conn(&mut conn, input(base, vec![row("AAA-USDT-SWAP", 1, 40.0)]))
            .unwrap();
        record_snapshot_with_conn(
            &mut conn,
            input(base + 30_000, vec![row("BBB-USDT-SWAP", 1, 50.0)]),
        )
        .unwrap();
        let count = conn
            .query_row(
                "SELECT COUNT(*) FROM market_radar_snapshot_rows",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        let symbol = conn
            .query_row(
                "SELECT inst_id FROM market_radar_snapshot_rows",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert_eq!(symbol, "BBB-USDT-SWAP");
    }

    #[test]
    fn alert_rule_triggers_once_on_top_rank_transition() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate_market_radar_workspace(&conn).unwrap();
        save_item(
            &conn,
            "market_radar_alert_rules",
            MarketRadarSavedItemInput {
                id: "alert-top".to_string(),
                name: "Top market".to_string(),
                definition_json: r#"{"version":1,"kind":"enterTop","threshold":1,"cooldownMinutes":360,"dailyLimit":5,"instIds":[]}"#.to_string(),
                enabled: Some(true),
            },
        )
        .unwrap();
        let hour = RADAR_SNAPSHOT_INTERVAL_MS;
        let base = now_ms().div_euclid(hour) * hour - hour;
        record_snapshot_with_conn(
            &mut conn,
            input(
                base,
                vec![row("AAA-USDT-SWAP", 2, 40.0), row("BBB-USDT-SWAP", 1, 60.0)],
            ),
        )
        .unwrap();
        let result = record_snapshot_with_conn(
            &mut conn,
            input(
                base + hour,
                vec![row("AAA-USDT-SWAP", 1, 70.0), row("BBB-USDT-SWAP", 2, 30.0)],
            ),
        )
        .unwrap();
        assert_eq!(result.alerts.len(), 1);
        assert_eq!(result.alerts[0].inst_id, "AAA-USDT-SWAP");
        let repeated = record_snapshot_with_conn(
            &mut conn,
            input(
                base + hour + 30_000,
                vec![row("AAA-USDT-SWAP", 1, 70.0), row("BBB-USDT-SWAP", 2, 30.0)],
            ),
        )
        .unwrap();
        assert!(repeated.alerts.is_empty());
    }

    #[test]
    fn new_listing_alert_does_not_fire_on_the_first_baseline_snapshot() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate_market_radar_workspace(&conn).unwrap();
        save_item(
            &conn,
            "market_radar_alert_rules",
            MarketRadarSavedItemInput {
                id: "alert-new".to_string(),
                name: "New listings".to_string(),
                definition_json: r#"{"version":1,"kind":"newListing","threshold":7,"cooldownMinutes":360,"dailyLimit":5,"instIds":[]}"#.to_string(),
                enabled: Some(true),
            },
        )
        .unwrap();
        let base = now_ms().div_euclid(RADAR_SNAPSHOT_INTERVAL_MS) * RADAR_SNAPSHOT_INTERVAL_MS;
        let mut new_market = row("NEW-USDT-SWAP", 1, 50.0);
        new_market.list_time = Some(base - 60_000);
        let result = record_snapshot_with_conn(&mut conn, input(base, vec![new_market])).unwrap();
        assert!(result.alerts.is_empty());
    }

    #[test]
    fn forward_close_never_uses_a_candle_completed_before_the_horizon() {
        let day = 24 * 60 * 60_000;
        let snapshot_at = 10 * day + 12 * 60 * 60_000;
        let candles = vec![(10 * day, 100.0), (11 * day, 105.0), (12 * day, 110.0)];
        assert_eq!(forward_close(&candles, snapshot_at, 1), Some(105.0));
    }

    #[test]
    fn ai_radar_ranking_keeps_global_and_scoped_rank_distinct() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate_market_radar_workspace(&conn).unwrap();
        let snapshot_at =
            now_ms().div_euclid(RADAR_SNAPSHOT_INTERVAL_MS) * RADAR_SNAPSHOT_INTERVAL_MS;
        let crypto = row("BTC-USDT-SWAP", 1, 90.0);
        let mut stock_a = row("AAPL-USDT-SWAP", 2, 80.0);
        stock_a.category = Some("3".to_string());
        stock_a.turnover_24h = 2_000_000.0;
        let mut stock_b = row("MSFT-USDT-SWAP", 3, 70.0);
        stock_b.category = Some("3".to_string());
        stock_b.turnover_24h = 5_000_000.0;
        record_snapshot_with_conn(
            &mut conn,
            input(snapshot_at, vec![crypto, stock_a, stock_b]),
        )
        .unwrap();

        let result = execute_market_radar_ai_tool_with_conn(
            &conn,
            "radar.readRanking",
            json!({ "category": "stock", "rankingBasis": "turnover24h", "limit": 2 }),
        )
        .unwrap();
        assert_eq!(result["matchedSize"], 2);
        assert_eq!(result["rows"][0]["instId"], "MSFT-USDT-SWAP");
        assert_eq!(result["rows"][0]["globalRank"], 3);
        assert_eq!(result["rows"][0]["scopeRank"], 1);
        assert_eq!(result["readOnly"], true);
        assert!(result["limitations"]
            .as_array()
            .is_some_and(|items| !items.is_empty()));

        let latest_all_markets = execute_market_radar_ai_tool_with_conn(
            &conn,
            "radar.readRanking",
            json!({
                "asOf": 0,
                "category": "crypto",
                "limit": 10,
                "rankingBasis": "composite",
                "savedFilterId": "all-markets"
            }),
        )
        .expect("safe latest/all-market placeholders should normalize");
        assert_eq!(latest_all_markets["matchedSize"], 1);
        assert_eq!(latest_all_markets["rows"][0]["instId"], "BTC-USDT-SWAP");
        assert_eq!(latest_all_markets["savedFilterId"], Value::Null);

        let provider_omission = execute_market_radar_ai_tool_with_conn(
            &conn,
            "radar.readRanking",
            json!({
                "asOf": 0,
                "category": "all",
                "limit": 15,
                "rankingBasis": "composite",
                "savedFilterId": ".invalid?"
            }),
        )
        .expect("known provider omission sentinel should normalize");
        assert_eq!(provider_omission["matchedSize"], 3);
        assert_eq!(provider_omission["savedFilterId"], Value::Null);
        assert!(execute_market_radar_ai_tool_with_conn(
            &conn,
            "radar.readRanking",
            json!({ "savedFilterId": "bad?" }),
        )
        .unwrap_err()
        .contains("savedFilterId 无效"));

        assert!(execute_market_radar_ai_tool_with_conn(
            &conn,
            "radar.readRanking",
            json!({ "limit": 101 }),
        )
        .unwrap_err()
        .contains("1 至 100"));
    }

    #[test]
    fn ai_radar_saved_filter_is_read_only_and_rejects_ui_watchlist_dependency() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate_market_radar_workspace(&conn).unwrap();
        let snapshot_at =
            now_ms().div_euclid(RADAR_SNAPSHOT_INTERVAL_MS) * RADAR_SNAPSHOT_INTERVAL_MS;
        record_snapshot_with_conn(
            &mut conn,
            input(snapshot_at, vec![row("BTC-USDT-SWAP", 1, 90.0)]),
        )
        .unwrap();
        save_item(
            &conn,
            "market_radar_saved_filters",
            MarketRadarSavedItemInput {
                id: "watchlist-filter".to_string(),
                name: "Watchlist".to_string(),
                definition_json: r#"{"version":1,"watchlistOnly":true}"#.to_string(),
                enabled: Some(true),
            },
        )
        .unwrap();
        save_item(
            &conn,
            "market_radar_saved_filters",
            MarketRadarSavedItemInput {
                id: "quality-filter".to_string(),
                name: "Quality".to_string(),
                definition_json:
                    r#"{"version":1,"minTrendQualityScore":80,"maxVolatility20dPct":2.5}"#
                        .to_string(),
                enabled: Some(true),
            },
        )
        .unwrap();
        let listed =
            execute_market_radar_ai_tool_with_conn(&conn, "radar.listSavedFilters", json!({}))
                .unwrap();
        assert_eq!(listed["count"], 2);
        let reproduced = execute_market_radar_ai_tool_with_conn(
            &conn,
            "radar.readRanking",
            json!({ "savedFilterId": "quality-filter" }),
        )
        .unwrap();
        assert_eq!(reproduced["matchedSize"], 1);
        assert!(execute_market_radar_ai_tool_with_conn(
            &conn,
            "radar.readRanking",
            json!({ "savedFilterId": "watchlist-filter" }),
        )
        .unwrap_err()
        .contains("自选列表"));
        assert!(
            execute_market_radar_ai_tool_with_conn(&conn, "radar.createAlert", json!({}),).is_err()
        );
    }

    #[test]
    fn saved_filter_round_trip_is_persistent_and_deterministic() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_market_radar_workspace(&conn).unwrap();
        let saved = save_item(
            &conn,
            "market_radar_saved_filters",
            MarketRadarSavedItemInput {
                id: "filter-liquid".to_string(),
                name: "Liquid markets".to_string(),
                definition_json: r#"{"version":1,"minTurnover24h":5000000}"#.to_string(),
                enabled: Some(true),
            },
        )
        .unwrap();
        assert_eq!(saved.name, "Liquid markets");
        let listed = list_saved_items(&conn, "market_radar_saved_filters").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(
            listed[0].definition_json,
            r#"{"version":1,"minTurnover24h":5000000}"#
        );
        assert!(delete_item(&conn, "market_radar_saved_filters", "filter-liquid").unwrap());
        assert!(list_saved_items(&conn, "market_radar_saved_filters")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn saved_item_validation_rejects_unstructured_or_unsafe_values() {
        let valid = MarketRadarSavedItemInput {
            id: "filter-1".to_string(),
            name: "Liquid stocks".to_string(),
            definition_json: "{\"category\":\"3\"}".to_string(),
            enabled: Some(true),
        };
        assert!(validate_saved_item(&valid).is_ok());
        assert!(validate_saved_item(&MarketRadarSavedItemInput {
            id: "../filter".to_string(),
            ..valid.clone()
        })
        .is_err());
        assert!(validate_saved_item(&MarketRadarSavedItemInput {
            definition_json: "[]".to_string(),
            ..valid
        })
        .is_err());
    }
}
