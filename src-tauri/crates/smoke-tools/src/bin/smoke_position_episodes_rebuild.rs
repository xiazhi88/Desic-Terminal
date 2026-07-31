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

fn main() {
    if let Err(error) = run() {
        eprintln!("[smoke] position episodes rebuild failed: {error}");
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
    let mut conn = Connection::open(&db_path)
        .map_err(|err| format!("open sqlite {} failed: {err}", db_path.display()))?;
    assert_required_schema(&conn)?;

    let fills_before = scalar_i64(
        &conn,
        "SELECT COUNT(*) FROM okx_fills WHERE account_id=?1 AND environment=?2",
        params![account.id, account.environment],
    )?;
    let result = desic_terminal_lib::rebuild_position_episodes_for_account(
        &mut conn,
        &account.id,
        &account.environment,
        None,
    )?;
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
    let closed = scalar_i64(
        &conn,
        "SELECT COUNT(*) FROM position_episodes WHERE account_id=?1 AND environment=?2 AND status='closed'",
        params![account.id, account.environment],
    )?;
    let open = scalar_i64(
        &conn,
        "SELECT COUNT(*) FROM position_episodes WHERE account_id=?1 AND environment=?2 AND status='open'",
        params![account.id, account.environment],
    )?;
    let mixed = scalar_i64(
        &conn,
        "SELECT COUNT(*) FROM position_episodes WHERE account_id=?1 AND environment=?2 AND primary_origin='mixed'",
        params![account.id, account.environment],
    )?;
    let bill_events = scalar_i64(
        &conn,
        "SELECT COUNT(*) FROM position_episode_events WHERE episode_id IN (
           SELECT id FROM position_episodes WHERE account_id=?1 AND environment=?2
         ) AND source='account-bills'",
        params![account.id, account.environment],
    )?;

    if fills_before > 0 && result.fills_scanned == 0 {
        return Err(format!(
            "fills exist but rebuild scanned none: fillsBefore={fills_before}"
        ));
    }
    if result.events_built > 0 && episode_events == 0 {
        return Err(
            "rebuild reported events but no position_episode_events rows exist".to_string(),
        );
    }

    println!(
        "[smoke] position episodes rebuild ok: account={} name={} env={} db={} fillsBefore={} scanned={} episodesBuilt={} eventsBuilt={} incomplete={} rows=[episodes={},events={},closed={},open={},mixed={},billEvents={}]",
        account.id,
        account.name,
        account.environment,
        db_path.display(),
        fills_before,
        result.fills_scanned,
        result.episodes_built,
        result.events_built,
        result.incomplete_events,
        episodes,
        episode_events,
        closed,
        open,
        mixed,
        bill_events
    );
    Ok(())
}

fn assert_required_schema(conn: &Connection) -> Result<(), String> {
    for table in [
        "okx_fills",
        "okx_account_bills",
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

fn scalar_i64<P: rusqlite::Params>(conn: &Connection, sql: &str, params: P) -> Result<i64, String> {
    conn.query_row(sql, params, |row| row.get(0))
        .map_err(|err| format!("query failed: {err}; sql={sql}"))
}
