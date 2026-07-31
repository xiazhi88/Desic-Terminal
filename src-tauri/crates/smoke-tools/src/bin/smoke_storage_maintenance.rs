use rusqlite::{params, Connection};
use std::{collections::HashMap, fs, path::PathBuf};

fn main() {
    if let Err(error) = run() {
        eprintln!("[smoke] storage maintenance failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let db_path = find_desktop_database_path()
        .ok_or_else(|| "desktop sqlite database missing".to_string())?;
    let conn = Connection::open(&db_path)
        .map_err(|err| format!("open sqlite {} failed: {err}", db_path.display()))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|err| err.to_string())?;
    assert_storage_schema(&conn)?;

    let before_rows = storage_table_counts(&conn)?;
    let cutoff_kline = now_ms() - 30 * 24 * 60 * 60_000;
    let deleted_kline_sync_runs = conn
        .execute(
            "DELETE FROM kline_sync_runs WHERE started_at < ?1",
            params![cutoff_kline],
        )
        .map_err(|err| err.to_string())?;
    let deleted_ai_messages = trim_ai_messages(&conn, 200)?;
    conn.execute_batch(
        "
        PRAGMA wal_checkpoint(TRUNCATE);
        PRAGMA optimize;
        ",
    )
    .map_err(|err| format!("sqlite maintenance pragmas failed: {err}"))?;

    let after_rows = storage_table_counts(&conn)?;
    let database_bytes = fs::metadata(&db_path)
        .map(|meta| meta.len())
        .unwrap_or_default();
    let wal_bytes = fs::metadata(db_path.with_extension("sqlite3-wal"))
        .map(|meta| meta.len())
        .unwrap_or_default();
    if database_bytes == 0 {
        return Err(format!("database file is empty: {}", db_path.display()));
    }
    for table in [
        "candles",
        "okx_orders",
        "okx_fills",
        "sync_endpoint_states",
        "position_episodes",
    ] {
        if !after_rows.contains_key(table) {
            return Err(format!("storage row count missing for table {table}"));
        }
    }

    println!(
        "[smoke] storage maintenance ok: db={} databaseBytes={} walBytes={} deletedKlineRuns={} deletedAiMessages={} rowsBefore={} rowsAfter={}",
        db_path.display(),
        database_bytes,
        wal_bytes,
        deleted_kline_sync_runs,
        deleted_ai_messages,
        compact_counts(&before_rows),
        compact_counts(&after_rows)
    );
    Ok(())
}

fn assert_storage_schema(conn: &Connection) -> Result<(), String> {
    let schema_version = scalar_i64(conn, "PRAGMA user_version", [])?;
    if schema_version != 1 {
        return Err(format!(
            "unexpected sqlite schema version: {schema_version}"
        ));
    }
    for table in [
        "candles",
        "kline_sync_runs",
        "ai_sessions",
        "ai_messages",
        "okx_orders",
        "okx_fills",
        "okx_account_bills",
        "okx_position_history",
        "sync_endpoint_states",
        "position_episodes",
        "position_episode_events",
        "trade_audit_events",
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
    for index in [
        "idx_kline_sync_runs_cleanup",
        "idx_ai_messages_cleanup",
        "idx_okx_orders_cl_ord",
        "idx_okx_fills_query",
        "idx_sync_endpoint_states_retry",
        "idx_position_episodes_query",
        "idx_trade_audit_events_query",
        "idx_trade_audit_events_status",
    ] {
        let exists = scalar_i64(
            conn,
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
            [index],
        )?;
        if exists == 0 {
            return Err(format!("sqlite index missing: {index}"));
        }
    }
    for (object_type, name) in [
        ("table", "intelligence_raw_responses"),
        ("index", "idx_candles_query"),
        ("index", "idx_candles_integrity"),
    ] {
        let exists = scalar_i64(
            conn,
            "SELECT COUNT(*) FROM sqlite_master WHERE type=?1 AND name=?2",
            params![object_type, name],
        )?;
        if exists != 0 {
            return Err(format!("unused sqlite {object_type} still exists: {name}"));
        }
    }
    Ok(())
}

fn trim_ai_messages(conn: &Connection, keep_per_session: i64) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM ai_messages
         WHERE id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at DESC) AS rn
             FROM ai_messages
           ) WHERE rn > ?1
         )",
        [keep_per_session],
    )
    .map_err(|err| err.to_string())
}

fn storage_table_counts(conn: &Connection) -> Result<HashMap<String, i64>, String> {
    let table_names = [
        "candles",
        "kline_sync_runs",
        "ai_sessions",
        "ai_messages",
        "okx_orders",
        "okx_fills",
        "okx_account_bills",
        "okx_position_history",
        "sync_endpoint_states",
        "position_episodes",
        "position_episode_events",
        "trade_audit_events",
    ];
    let mut rows = HashMap::new();
    for table in table_names {
        rows.insert(
            table.to_string(),
            scalar_i64(conn, &format!("SELECT COUNT(*) FROM {table}"), [])?,
        );
    }
    Ok(rows)
}

fn compact_counts(rows: &HashMap<String, i64>) -> String {
    [
        "candles",
        "kline_sync_runs",
        "ai_messages",
        "okx_orders",
        "okx_fills",
        "okx_account_bills",
        "okx_position_history",
        "sync_endpoint_states",
        "position_episodes",
        "position_episode_events",
        "trade_audit_events",
    ]
    .iter()
    .map(|table| format!("{table}:{}", rows.get(*table).copied().unwrap_or_default()))
    .collect::<Vec<_>>()
    .join(",")
}

fn scalar_i64<P: rusqlite::Params>(conn: &Connection, sql: &str, params: P) -> Result<i64, String> {
    conn.query_row(sql, params, |row| row.get(0))
        .map_err(|err| format!("query failed: {err}; sql={sql}"))
}

fn find_desktop_database_path() -> Option<PathBuf> {
    desic_smoke_tools::desktop_database_path("desic_trade_ai.sqlite3")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
