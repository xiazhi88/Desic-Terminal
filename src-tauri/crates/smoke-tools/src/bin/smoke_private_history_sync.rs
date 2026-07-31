use base64::{engine::general_purpose, Engine as _};
use hmac::{Hmac, Mac};
use reqwest::Proxy;
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::Value;
use sha2::Sha256;
use std::{
    fs,
    path::PathBuf,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const REST_BASE: &str = "https://www.okx.com";

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

#[derive(Debug)]
struct EndpointResult {
    scope: &'static str,
    fetched: usize,
    upserted: usize,
    newest_cursor: Option<String>,
    oldest_cursor: Option<String>,
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
        eprintln!("[smoke] private history sync failed: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let started = Instant::now();
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

    let client = reqwest_client()?;
    let account_bills = sync_bills_endpoint(
        &client,
        &mut conn,
        &account,
        "account-bills",
        "/api/v5/account/bills",
    )
    .await?;
    let archive_bills = sync_bills_endpoint(
        &client,
        &mut conn,
        &account,
        "account-bills-archive",
        "/api/v5/account/bills-archive",
    )
    .await?;

    let rows_after = scalar_i64(
        &conn,
        "SELECT COUNT(*) FROM okx_account_bills WHERE account_id=?1 AND environment=?2",
        params![account.id, account.environment],
    )?;

    println!(
        "[smoke] private history sync ok: account={} name={} env={} db={} latencyMs={} endpoints=[{} fetched={} upserted={} newest={:?} oldest={:?};{} fetched={} upserted={} newest={:?} oldest={:?}] accountBillsRows={}",
        account.id,
        account.name,
        account.environment,
        db_path.display(),
        started.elapsed().as_millis(),
        account_bills.scope,
        account_bills.fetched,
        account_bills.upserted,
        account_bills.newest_cursor,
        account_bills.oldest_cursor,
        archive_bills.scope,
        archive_bills.fetched,
        archive_bills.upserted,
        archive_bills.newest_cursor,
        archive_bills.oldest_cursor,
        rows_after
    );
    Ok(())
}

async fn sync_bills_endpoint(
    client: &reqwest::Client,
    conn: &mut Connection,
    account: &LocalAccount,
    scope: &'static str,
    endpoint: &str,
) -> Result<EndpointResult, String> {
    mark_endpoint_started(conn, account, scope)?;
    let path = format!("{endpoint}?instType=SWAP&limit=100");
    let value = okx_private_get(client, account, &path).await?;
    let rows = value
        .get("data")
        .and_then(|item| item.as_array())
        .cloned()
        .unwrap_or_default();
    let newest_cursor = rows
        .first()
        .and_then(|row| json_string(row, "billId"))
        .filter(|value| !value.trim().is_empty());
    let oldest_cursor = rows
        .last()
        .and_then(|row| json_string(row, "billId"))
        .filter(|value| !value.trim().is_empty());
    let upserted = upsert_account_bills(conn, account, scope, &rows)?;
    mark_endpoint_complete(
        conn,
        account,
        scope,
        oldest_cursor.as_deref(),
        newest_cursor.as_deref(),
        oldest_cursor.as_deref(),
        rows.len(),
        upserted,
    )?;
    Ok(EndpointResult {
        scope,
        fetched: rows.len(),
        upserted,
        newest_cursor,
        oldest_cursor,
    })
}

fn upsert_account_bills(
    conn: &mut Connection,
    account: &LocalAccount,
    source_endpoint: &str,
    rows: &[Value],
) -> Result<usize, String> {
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let synced_at = now_ms()?;
    let mut count = 0;
    for row in rows {
        let Some(bill_id) = json_string(row, "billId").filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        tx.execute(
            "INSERT INTO okx_account_bills (
              account_id, environment, bill_id, inst_id, inst_type, ccy, bill_type, sub_type,
              bal, bal_chg, pos_bal, pos_bal_chg, sz, px, pnl, fee, ord_id, trade_id, cl_ord_id,
              exec_type, mgn_mode, notes, source_endpoint, okx_ts, raw_json, synced_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)
            ON CONFLICT(account_id, environment, bill_id) DO UPDATE SET
              inst_id=excluded.inst_id,
              inst_type=excluded.inst_type,
              ccy=excluded.ccy,
              bill_type=excluded.bill_type,
              sub_type=excluded.sub_type,
              bal=excluded.bal,
              bal_chg=excluded.bal_chg,
              pos_bal=excluded.pos_bal,
              pos_bal_chg=excluded.pos_bal_chg,
              sz=excluded.sz,
              px=excluded.px,
              pnl=excluded.pnl,
              fee=excluded.fee,
              ord_id=excluded.ord_id,
              trade_id=excluded.trade_id,
              cl_ord_id=excluded.cl_ord_id,
              exec_type=excluded.exec_type,
              mgn_mode=excluded.mgn_mode,
              notes=excluded.notes,
              source_endpoint=excluded.source_endpoint,
              okx_ts=excluded.okx_ts,
              raw_json=excluded.raw_json,
              synced_at=excluded.synced_at",
            params![
                account.id,
                account.environment,
                bill_id,
                json_string(row, "instId"),
                json_string(row, "instType"),
                json_string(row, "ccy"),
                json_string(row, "type"),
                json_string(row, "subType"),
                json_string(row, "bal"),
                json_string(row, "balChg"),
                json_string(row, "posBal"),
                json_string(row, "posBalChg"),
                json_string(row, "sz"),
                json_string(row, "px"),
                json_string(row, "pnl"),
                json_string(row, "fee"),
                json_string(row, "ordId"),
                json_string(row, "tradeId"),
                json_string(row, "clOrdId"),
                json_string(row, "execType"),
                json_string(row, "mgnMode"),
                json_string(row, "notes"),
                source_endpoint,
                json_i64(row, "ts").or_else(|| json_i64(row, "fillTime")),
                row.to_string(),
                synced_at
            ],
        )
        .map_err(|err| err.to_string())?;
        count += 1;
    }
    tx.commit().map_err(|err| err.to_string())?;
    Ok(count)
}

fn mark_endpoint_started(
    conn: &Connection,
    account: &LocalAccount,
    scope: &str,
) -> Result<(), String> {
    let now = now_ms()?;
    conn.execute(
        "INSERT INTO sync_endpoint_states (
          account_id, environment, scope, inst_id, status, attempt, last_started_at, updated_at
        ) VALUES (?1, ?2, ?3, '', 'running', 1, ?4, ?4)
        ON CONFLICT(account_id, environment, scope, inst_id) DO UPDATE SET
          status='running',
          attempt=attempt + 1,
          last_started_at=excluded.last_started_at,
          updated_at=excluded.updated_at",
        params![account.id, account.environment, scope, now],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn mark_endpoint_complete(
    conn: &Connection,
    account: &LocalAccount,
    scope: &str,
    cursor: Option<&str>,
    newest_cursor: Option<&str>,
    oldest_cursor: Option<&str>,
    fetched: usize,
    upserted: usize,
) -> Result<(), String> {
    let now = now_ms()?;
    conn.execute(
        "INSERT INTO sync_endpoint_states (
          account_id, environment, scope, inst_id, status, cursor, newest_cursor, oldest_cursor, attempt, fetched, upserted,
          last_error, next_retry_at, last_finished_at, updated_at
        ) VALUES (?1, ?2, ?3, '', 'complete', ?4, ?5, ?6, 0, ?7, ?8, NULL, NULL, ?9, ?9)
        ON CONFLICT(account_id, environment, scope, inst_id) DO UPDATE SET
          status='complete',
          cursor=COALESCE(excluded.cursor, sync_endpoint_states.cursor),
          newest_cursor=COALESCE(excluded.newest_cursor, sync_endpoint_states.newest_cursor),
          oldest_cursor=COALESCE(excluded.oldest_cursor, sync_endpoint_states.oldest_cursor),
          attempt=0,
          fetched=excluded.fetched,
          upserted=excluded.upserted,
          last_error=NULL,
          next_retry_at=NULL,
          last_finished_at=excluded.last_finished_at,
          updated_at=excluded.updated_at",
        params![account.id, account.environment, scope, cursor, newest_cursor, oldest_cursor, fetched, upserted, now],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn reqwest_client() -> Result<reqwest::Client, String> {
    let proxy = load_proxy_config().unwrap_or_default();
    let mut builder = reqwest::Client::builder()
        .use_native_tls()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("Desic-Terminal-private-history-sync-smoke/0.1");
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

fn assert_required_schema(conn: &Connection) -> Result<(), String> {
    for table in ["okx_account_bills", "sync_endpoint_states"] {
        let exists = scalar_i64(
            conn,
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
            [table],
        )?;
        if exists == 0 {
            return Err(format!("sqlite table missing: {table}"));
        }
    }
    for column in ["newest_cursor", "oldest_cursor"] {
        let exists = scalar_i64(
            conn,
            "SELECT COUNT(*) FROM pragma_table_info('sync_endpoint_states') WHERE name=?1",
            [column],
        )?;
        if exists == 0 {
            return Err(format!("sync_endpoint_states column missing: {column}"));
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

fn json_string(row: &Value, key: &str) -> Option<String> {
    row.get(key).and_then(|value| match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    })
}

fn json_i64(row: &Value, key: &str) -> Option<i64> {
    row.get(key).and_then(|value| match value {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.parse::<i64>().ok(),
        _ => None,
    })
}

fn scalar_i64<P: rusqlite::Params>(conn: &Connection, sql: &str, params: P) -> Result<i64, String> {
    conn.query_row(sql, params, |row| row.get(0))
        .map_err(|err| format!("query failed: {err}; sql={sql}"))
}

fn now_ms() -> Result<i64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| err.to_string())?;
    Ok(duration.as_millis() as i64)
}

fn compact(value: &str) -> String {
    let text = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() > 240 {
        format!("{}...", text.chars().take(240).collect::<String>())
    } else {
        text
    }
}
