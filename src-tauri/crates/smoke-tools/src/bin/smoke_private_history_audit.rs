use rusqlite::{params, Connection};
use serde::Deserialize;
use std::{fs, path::PathBuf};

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

#[derive(Debug)]
struct TableStats {
    count: i64,
    min_ts: Option<i64>,
    max_ts: Option<i64>,
}

#[derive(Debug)]
struct EndpointSummary {
    total: i64,
    complete: i64,
    failed: i64,
    running: i64,
    retrying: i64,
    fetched: i64,
    upserted: i64,
    missing_scopes: Vec<String>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("[smoke] private history audit failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let account = load_account()?;
    if !account.permissions.read {
        return Err(format!(
            "account {} has read permission disabled",
            account.id
        ));
    }
    validate_account(&account)?;

    let db_path = find_desktop_database_path()
        .ok_or_else(|| "desktop sqlite database missing".to_string())?;
    let conn = Connection::open(&db_path)
        .map_err(|err| format!("open sqlite {} failed: {err}", db_path.display()))?;
    assert_required_schema(&conn)?;

    let endpoints = endpoint_summary(&conn, &account)?;
    if endpoints.total == 0 {
        return Err("sync_endpoint_states has no rows for the configured account".to_string());
    }
    if endpoints.failed > 0 || endpoints.running > 0 {
        return Err(format!(
            "private history endpoints not healthy: failed={}, running={}",
            endpoints.failed, endpoints.running
        ));
    }

    let watermark_count = scalar_i64(
        &conn,
        "SELECT COUNT(*) FROM sync_watermarks WHERE account_id=?1 AND environment=?2 AND scope='private-history'",
        params![account.id, account.environment],
    )?;
    if watermark_count == 0 {
        return Err("private-history watermark missing".to_string());
    }

    let orders = table_stats(&conn, "okx_orders", "okx_utime", &account)?;
    let fills = table_stats(&conn, "okx_fills", "okx_ts", &account)?;
    let bills = table_stats(&conn, "okx_account_bills", "okx_ts", &account)?;
    let positions = table_stats(&conn, "okx_position_history", "okx_utime", &account)?;
    let episodes = scalar_i64(
        &conn,
        "SELECT COUNT(*) FROM position_episodes WHERE account_id=?1 AND environment=?2",
        params![account.id, account.environment],
    )?;
    let episode_events = scalar_i64(
        &conn,
        "SELECT COUNT(*) FROM position_episode_events WHERE episode_id IN (
           SELECT id FROM position_episodes WHERE account_id=?1 AND environment=?2
         )",
        params![account.id, account.environment],
    )?;
    let orphan_events = scalar_i64(
        &conn,
        "SELECT COUNT(*) FROM position_episode_events e
         LEFT JOIN position_episodes p ON p.id=e.episode_id
         WHERE p.id IS NULL",
        [],
    )?;
    if orphan_events != 0 {
        return Err(format!(
            "position_episode_events contains orphan rows: {orphan_events}"
        ));
    }

    println!(
        "[smoke] private history audit ok: account={} name={} env={} db={} endpoints=[total={},complete={},retrying={},fetched={},upserted={},missingScopes={}] watermarks={} tables=[orders={},fills={},bills={},positions={}] ranges=[orders={},fills={},bills={},positions={}] episodes=[rows={},events={},orphans={}]",
        account.id,
        account.name,
        account.environment,
        db_path.display(),
        endpoints.total,
        endpoints.complete,
        endpoints.retrying,
        endpoints.fetched,
        endpoints.upserted,
        if endpoints.missing_scopes.is_empty() { "none".to_string() } else { endpoints.missing_scopes.join("|") },
        watermark_count,
        orders.count,
        fills.count,
        bills.count,
        positions.count,
        range_text(&orders),
        range_text(&fills),
        range_text(&bills),
        range_text(&positions),
        episodes,
        episode_events,
        orphan_events
    );
    Ok(())
}

fn assert_required_schema(conn: &Connection) -> Result<(), String> {
    for table in [
        "okx_orders",
        "okx_fills",
        "okx_account_bills",
        "okx_position_history",
        "sync_watermarks",
        "sync_endpoint_states",
        "position_episodes",
        "position_episode_events",
    ] {
        let exists = scalar_i64(
            conn,
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
            [table],
        )?;
        if exists == 0 {
            return Err(format!("sqlite table missing: {table}"));
        }
    }
    Ok(())
}

fn endpoint_summary(conn: &Connection, account: &LocalAccount) -> Result<EndpointSummary, String> {
    let mut summary = conn
        .query_row(
            "SELECT COUNT(*),
                SUM(CASE WHEN status='complete' THEN 1 ELSE 0 END),
                SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),
                SUM(CASE WHEN status='running' THEN 1 ELSE 0 END),
                SUM(CASE WHEN next_retry_at IS NOT NULL THEN 1 ELSE 0 END),
                COALESCE(SUM(fetched), 0),
                COALESCE(SUM(upserted), 0)
         FROM sync_endpoint_states
         WHERE account_id=?1 AND environment=?2",
            params![account.id, account.environment],
            |row| {
                Ok(EndpointSummary {
                    total: row.get(0)?,
                    complete: row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    failed: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                    running: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                    retrying: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
                    fetched: row.get(5)?,
                    upserted: row.get(6)?,
                    missing_scopes: Vec::new(),
                })
            },
        )
        .map_err(|err| format!("endpoint summary failed: {err}"))?;
    let present_scopes = endpoint_scopes(conn, account)?;
    summary.missing_scopes = [
        "orders-history",
        "orders-history-archive",
        "fills",
        "fills-history",
        "account-bills",
        "account-bills-archive",
        "positions-history",
    ]
    .into_iter()
    .filter(|scope| !present_scopes.iter().any(|item| item == scope))
    .map(str::to_string)
    .collect();
    Ok(summary)
}

fn endpoint_scopes(conn: &Connection, account: &LocalAccount) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT scope
             FROM sync_endpoint_states
             WHERE account_id=?1 AND environment=?2",
        )
        .map_err(|err| format!("endpoint scope query prepare failed: {err}"))?;
    let rows = stmt
        .query_map(params![account.id, account.environment], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|err| format!("endpoint scope query failed: {err}"))?;
    let mut scopes = Vec::new();
    for row in rows {
        scopes.push(row.map_err(|err| format!("endpoint scope row failed: {err}"))?);
    }
    Ok(scopes)
}

fn table_stats(
    conn: &Connection,
    table: &str,
    time_column: &str,
    account: &LocalAccount,
) -> Result<TableStats, String> {
    let sql = format!(
        "SELECT COUNT(*), MIN({time_column}), MAX({time_column}) FROM {table} WHERE account_id=?1 AND environment=?2"
    );
    conn.query_row(&sql, params![account.id, account.environment], |row| {
        Ok(TableStats {
            count: row.get(0)?,
            min_ts: row.get(1)?,
            max_ts: row.get(2)?,
        })
    })
    .map_err(|err| format!("table stats {table} failed: {err}"))
}

fn range_text(stats: &TableStats) -> String {
    match (stats.min_ts, stats.max_ts) {
        (Some(min), Some(max)) => format!("{min}..{max}"),
        _ => "empty".to_string(),
    }
}

fn scalar_i64<P: rusqlite::Params>(conn: &Connection, sql: &str, params: P) -> Result<i64, String> {
    conn.query_row(sql, params, |row| row.get(0))
        .map_err(|err| format!("query failed: {err}; sql={sql}"))
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
