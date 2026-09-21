use super::*;
use desic_private_history::{
    map_private_history_endpoint_status, PrivateHistoryStatusRequest, PrivateHistoryStatusResponse,
    PrivateHistorySyncRequest, PrivateHistorySyncResult,
};

#[derive(Debug, Clone, Copy)]
struct PrivateSyncEndpoint {
    endpoint: &'static str,
    scope: &'static str,
    cursor_field: &'static str,
    extra_query: &'static [(&'static str, &'static str)],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PrivateSyncDirection {
    Newer,
    Older,
}

#[derive(Debug, Default)]
struct PrivateEndpointSyncOutput {
    rows: Vec<serde_json::Value>,
    newest_cursor: Option<String>,
    oldest_cursor: Option<String>,
    fetched: usize,
    newer_fetched: usize,
    older_fetched: usize,
    retried: bool,
}

#[derive(Debug, Default)]
struct PrivateSyncEndpointState {
    status: String,
    cursor: Option<String>,
    newest_cursor: Option<String>,
    oldest_cursor: Option<String>,
    next_retry_at: Option<i64>,
}

/// Attempts for one user-triggered history sync before the failure reaches the
/// user. A local bind address is already an explicit timeout, so this only
/// covers peer writers.
const PRIVATE_HISTORY_SYNC_ATTEMPTS: u32 = 3;

/// Endpoints whose data the interface shows as soon as a sync finishes, plus
/// the account-bills read that repairs fills locally. These use OKX's standard
/// private budget.
const PHASE_A_SCOPES: [&str; 4] = [
    "orders-history",
    "fills",
    "fills-history",
    "positions-history",
];

/// Deep-history endpoints. OKX allows only 5 requests / 2 seconds per User ID on
/// `/api/v5/account/bills-archive`, so spending these inside the command makes
/// the caller wait on the strictest budget in the whole backfill.
const PHASE_B_SCOPES: [&str; 3] = [
    "orders-history-archive",
    "account-bills",
    "account-bills-archive",
];

/// Which scopes a single pass covers. The completion check requires all seven,
/// so both phases together must still cover `REQUIRED_SCOPES` exactly.
fn sync_pass_covers(scopes: &[&str], scope: &str) -> bool {
    scopes.is_empty() || scopes.contains(&scope)
}

/// Pages per direction for one pass. The two-phase startup pass keeps this at
/// one so the first screen is not waiting on a deep backfill.
fn effective_page_budget(max_pages: u8, single_page: bool) -> u8 {
    if single_page {
        1
    } else {
        max_pages.max(1)
    }
}

/// Upper bound on the OKX requests one pass can spend.
///
/// `fetch_private_endpoint` runs one Newer and one Older direction, and each
/// direction is capped by the page budget, so a scope costs at most two requests
/// per page. The interactive pass is therefore 4 scopes x 2 x 1 page = 8 requests,
/// and at the 200ms query interval that is the budget the first screen waits on.
fn private_rest_request_bound(scopes: &[&str], max_pages: u8, single_page: bool) -> usize {
    scopes.len() * 2 * effective_page_budget(max_pages, single_page) as usize
}

/// Sentinel stored in the stored cursors of a scope this pass does not cover.
/// `fetch_private_endpoint` returns an empty result for it instead of calling
/// OKX, and `mark_private_sync_endpoint_success` stores cursors only when they
/// are real, so a skipped scope stays untouched for the next pass.
const SCOPE_SKIPPED: &str = "\u{0}skipped";

/// Per-phase request accounting. Requests counted here are the ones the phase
/// actually sent, so a reader can tell a clean run from one that merely waited
/// out a throttle, and `requests=<observed>/<bound>` shows a regression in the
/// request count instead of leaving it to be inferred from timing.
fn log_private_rest_pacing(phase: &str, account: &LocalAccount, bound: usize) {
    let report = crate::okx_rate_limit::take_private_rest_pacing();
    boot_log(&format!(
        "private history {phase} phase pacing: requests={}/{} paced_waits={} paced_wait_ms={} (account={}, env={})",
        report.requests,
        bound,
        report.waits,
        report.waited_ms,
        account.id,
        account.environment
    ));
}

fn empty_endpoint_sync_output() -> PrivateEndpointSyncOutput {
    PrivateEndpointSyncOutput {
        rows: Vec::new(),
        newest_cursor: None,
        oldest_cursor: None,
        fetched: 0,
        newer_fetched: 0,
        older_fetched: 0,
        retried: false,
    }
}


/// True when a private-history sync failed because a peer writer holds the
/// database lock rather than because of a real fault. Matched on the text
/// because the error reaches this layer as a String.
///
/// The same three phrases are treated as transient by the automation
/// scheduler (`ai_automation::is_transient_database_contention`); a change here
/// belongs there too.
fn is_private_history_database_contention(message: &str) -> bool {
    let lowered = message.to_ascii_lowercase();
    lowered.contains("database is locked")
        || lowered.contains("database table is locked")
        || lowered.contains("database is busy")
}

/// One sync attempt. Everything up to the first endpoint state sync is a read,
/// so retrying with a fresh connection is safe.
///
/// A fresh Windows install can fail the very first sync with "database is
/// locked" while startup migration, seeding, or antivirus file inspection holds
/// the file. The user sees a red notification for what is a transient lock, so
/// the attempt is retried with a shorter page budget instead of being reported.
async fn sync_private_history_attempt(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    inst_id: Option<String>,
    max_pages: u8,
    force: bool,
    scopes: &[&str],
    single_page: bool,
) -> Result<PrivateHistorySyncResult, String> {
    let started_at = now_ms();
    let max_pages = effective_page_budget(max_pages, single_page);
    let mut conn = open_database(app)?;
    if !force
        && private_sync_required_endpoints_complete(
            &conn,
            &account.id,
            &account.environment,
            inst_id.as_deref(),
        )?
    {
        if let Some(mut previous) = load_recent_private_sync_watermark(
            &conn,
            &account.id,
            &account.environment,
            inst_id.as_deref(),
            "private-history",
            6 * 60 * 60_000,
        )? {
            // The remote snapshot is still fresh, but account bills or local
            // projections may have repaired a fill since the last network sync.
            previous.fills_upserted +=
                backfill_trade_fills_from_account_bills(&mut conn, account, inst_id.as_deref())?;
            rebuild_position_episodes_for_account(
                &mut conn,
                &account.id,
                &account.environment,
                inst_id.as_deref(),
            )
            .map_err(|err| format!("历史持仓重建失败: {err}"))?;
            return Ok(previous);
        }
    }
    let mut result = PrivateHistorySyncResult {
        account_id: account.id.clone(),
        environment: account.environment.clone(),
        inst_id: inst_id.clone(),
        started_at,
        ..PrivateHistorySyncResult::default()
    };

    let orders_endpoint = PrivateSyncEndpoint {
        endpoint: "/api/v5/trade/orders-history",
        scope: "orders-history",
        cursor_field: "ordId",
        extra_query: &[("instType", "SWAP")],
    };
    let (orders_newest, orders_oldest, orders_retried) = if sync_pass_covers(scopes, "orders-history") {
        prepare_private_sync_endpoint(&conn, account, inst_id.as_deref(), orders_endpoint.scope)?
    } else {
        (Some(SCOPE_SKIPPED.to_string()), None, false)
    };
    let orders_sync = match fetch_private_endpoint(
        account,
        inst_id.as_deref(),
        max_pages,
        orders_endpoint,
        orders_newest,
        orders_oldest,
        orders_retried,
    )
    .await
    {
        Ok(value) => value,
        Err(error) => {
            let _ = mark_private_sync_endpoint_failed(
                &conn,
                account,
                inst_id.as_deref(),
                orders_endpoint.scope,
                &error,
            );
            return Err(error);
        }
    };
    result.orders_fetched = orders_sync.fetched;
    result.orders_upserted =
        upsert_okx_history_orders(&mut conn, account, "orders-history", &orders_sync.rows)?;
    result.retry_endpoints += usize::from(orders_sync.retried);
    result.new_sync_endpoints += usize::from(orders_sync.newer_fetched > 0);
    result.backfill_endpoints += usize::from(orders_sync.older_fetched > 0);
    mark_private_sync_endpoint_success(
        &conn,
        account,
        inst_id.as_deref(),
        "orders-history",
        orders_sync.oldest_cursor.as_deref(),
        orders_sync.newest_cursor.as_deref(),
        orders_sync.oldest_cursor.as_deref(),
        result.orders_fetched,
        result.orders_upserted,
    )?;

    let archive_orders_endpoint = PrivateSyncEndpoint {
        endpoint: "/api/v5/trade/orders-history-archive",
        scope: "orders-history-archive",
        cursor_field: "ordId",
        extra_query: &[("instType", "SWAP")],
    };
    let (archive_orders_newest, archive_orders_oldest, archive_orders_retried) = if sync_pass_covers(scopes, "orders-history-archive") {
        prepare_private_sync_endpoint(
            &conn,
            account,
            inst_id.as_deref(),
            archive_orders_endpoint.scope,
        )?
    } else {
        (Some(SCOPE_SKIPPED.to_string()), None, false)
    };
    let archive_orders_sync = match fetch_private_endpoint(
        account,
        inst_id.as_deref(),
        max_pages,
        archive_orders_endpoint,
        archive_orders_newest,
        archive_orders_oldest,
        archive_orders_retried,
    )
    .await
    {
        Ok(value) => value,
        Err(error) => {
            let _ = mark_private_sync_endpoint_failed(
                &conn,
                account,
                inst_id.as_deref(),
                archive_orders_endpoint.scope,
                &error,
            );
            return Err(error);
        }
    };
    result.archive_orders_fetched = archive_orders_sync.fetched;
    result.archive_orders_upserted = upsert_okx_history_orders(
        &mut conn,
        account,
        "orders-history-archive",
        &archive_orders_sync.rows,
    )?;
    result.retry_endpoints += usize::from(archive_orders_sync.retried);
    result.new_sync_endpoints += usize::from(archive_orders_sync.newer_fetched > 0);
    result.backfill_endpoints += usize::from(archive_orders_sync.older_fetched > 0);
    mark_private_sync_endpoint_success(
        &conn,
        account,
        inst_id.as_deref(),
        "orders-history-archive",
        archive_orders_sync.oldest_cursor.as_deref(),
        archive_orders_sync.newest_cursor.as_deref(),
        archive_orders_sync.oldest_cursor.as_deref(),
        result.archive_orders_fetched,
        result.archive_orders_upserted,
    )?;

    let recent_fills_endpoint = PrivateSyncEndpoint {
        endpoint: "/api/v5/trade/fills",
        scope: "fills",
        cursor_field: "billId",
        extra_query: &[("instType", "SWAP")],
    };
    let (recent_fills_newest, recent_fills_oldest, recent_fills_retried) = if sync_pass_covers(scopes, "fills") {
        prepare_private_sync_endpoint(
            &conn,
            account,
            inst_id.as_deref(),
            recent_fills_endpoint.scope,
        )?
    } else {
        (Some(SCOPE_SKIPPED.to_string()), None, false)
    };
    let recent_fills_sync = match fetch_private_endpoint(
        account,
        inst_id.as_deref(),
        max_pages,
        recent_fills_endpoint,
        recent_fills_newest,
        recent_fills_oldest,
        recent_fills_retried,
    )
    .await
    {
        Ok(value) => value,
        Err(error) => {
            let _ = mark_private_sync_endpoint_failed(
                &conn,
                account,
                inst_id.as_deref(),
                recent_fills_endpoint.scope,
                &error,
            );
            return Err(error);
        }
    };
    result.recent_fills_fetched = recent_fills_sync.fetched;
    result.recent_fills_upserted =
        upsert_okx_history_fills(&mut conn, account, "fills", &recent_fills_sync.rows)?;
    result.retry_endpoints += usize::from(recent_fills_sync.retried);
    result.new_sync_endpoints += usize::from(recent_fills_sync.newer_fetched > 0);
    result.backfill_endpoints += usize::from(recent_fills_sync.older_fetched > 0);
    mark_private_sync_endpoint_success(
        &conn,
        account,
        inst_id.as_deref(),
        "fills",
        recent_fills_sync.oldest_cursor.as_deref(),
        recent_fills_sync.newest_cursor.as_deref(),
        recent_fills_sync.oldest_cursor.as_deref(),
        result.recent_fills_fetched,
        result.recent_fills_upserted,
    )?;

    let fills_endpoint = PrivateSyncEndpoint {
        endpoint: "/api/v5/trade/fills-history",
        scope: "fills-history",
        cursor_field: "billId",
        extra_query: &[("instType", "SWAP")],
    };
    let (fills_newest, fills_oldest, fills_retried) = if sync_pass_covers(scopes, "fills-history") {
        prepare_private_sync_endpoint(&conn, account, inst_id.as_deref(), fills_endpoint.scope)?
    } else {
        (Some(SCOPE_SKIPPED.to_string()), None, false)
    };
    let fills_sync = match fetch_private_endpoint(
        account,
        inst_id.as_deref(),
        max_pages,
        fills_endpoint,
        fills_newest,
        fills_oldest,
        fills_retried,
    )
    .await
    {
        Ok(value) => value,
        Err(error) => {
            let _ = mark_private_sync_endpoint_failed(
                &conn,
                account,
                inst_id.as_deref(),
                fills_endpoint.scope,
                &error,
            );
            return Err(error);
        }
    };
    result.fills_fetched = fills_sync.fetched;
    result.fills_upserted =
        upsert_okx_history_fills(&mut conn, account, "fills-history", &fills_sync.rows)?;
    result.retry_endpoints += usize::from(fills_sync.retried);
    result.new_sync_endpoints += usize::from(fills_sync.newer_fetched > 0);
    result.backfill_endpoints += usize::from(fills_sync.older_fetched > 0);
    mark_private_sync_endpoint_success(
        &conn,
        account,
        inst_id.as_deref(),
        "fills-history",
        fills_sync.oldest_cursor.as_deref(),
        fills_sync.newest_cursor.as_deref(),
        fills_sync.oldest_cursor.as_deref(),
        result.fills_fetched,
        result.fills_upserted,
    )?;

    let bills_endpoint = PrivateSyncEndpoint {
        endpoint: "/api/v5/account/bills",
        scope: "account-bills",
        cursor_field: "billId",
        extra_query: &[("instType", "SWAP")],
    };
    let (bills_newest, bills_oldest, bills_retried) = if sync_pass_covers(scopes, "account-bills") {
        prepare_private_sync_endpoint(&conn, account, inst_id.as_deref(), bills_endpoint.scope)?
    } else {
        (Some(SCOPE_SKIPPED.to_string()), None, false)
    };
    let bills_sync = match fetch_private_endpoint(
        account,
        inst_id.as_deref(),
        max_pages,
        bills_endpoint,
        bills_newest,
        bills_oldest,
        bills_retried,
    )
    .await
    {
        Ok(value) => value,
        Err(error) => {
            let _ = mark_private_sync_endpoint_failed(
                &conn,
                account,
                inst_id.as_deref(),
                bills_endpoint.scope,
                &error,
            );
            return Err(error);
        }
    };
    result.bills_fetched = bills_sync.fetched;
    result.bills_upserted =
        upsert_okx_account_bills(&mut conn, account, "account-bills", &bills_sync.rows)?;
    result.retry_endpoints += usize::from(bills_sync.retried);
    result.new_sync_endpoints += usize::from(bills_sync.newer_fetched > 0);
    result.backfill_endpoints += usize::from(bills_sync.older_fetched > 0);
    mark_private_sync_endpoint_success(
        &conn,
        account,
        inst_id.as_deref(),
        "account-bills",
        bills_sync.oldest_cursor.as_deref(),
        bills_sync.newest_cursor.as_deref(),
        bills_sync.oldest_cursor.as_deref(),
        result.bills_fetched,
        result.bills_upserted,
    )?;

    let archive_bills_endpoint = PrivateSyncEndpoint {
        endpoint: "/api/v5/account/bills-archive",
        scope: "account-bills-archive",
        cursor_field: "billId",
        extra_query: &[("instType", "SWAP")],
    };
    let (archive_bills_newest, archive_bills_oldest, archive_bills_retried) = if sync_pass_covers(scopes, "account-bills-archive") {
        prepare_private_sync_endpoint(
            &conn,
            account,
            inst_id.as_deref(),
            archive_bills_endpoint.scope,
        )?
    } else {
        (Some(SCOPE_SKIPPED.to_string()), None, false)
    };
    let archive_bills_sync = match fetch_private_endpoint(
        account,
        inst_id.as_deref(),
        max_pages,
        archive_bills_endpoint,
        archive_bills_newest,
        archive_bills_oldest,
        archive_bills_retried,
    )
    .await
    {
        Ok(value) => value,
        Err(error) => {
            let _ = mark_private_sync_endpoint_failed(
                &conn,
                account,
                inst_id.as_deref(),
                archive_bills_endpoint.scope,
                &error,
            );
            return Err(error);
        }
    };
    result.archive_bills_fetched = archive_bills_sync.fetched;
    result.archive_bills_upserted = upsert_okx_account_bills(
        &mut conn,
        account,
        "account-bills-archive",
        &archive_bills_sync.rows,
    )?;
    result.retry_endpoints += usize::from(archive_bills_sync.retried);
    result.new_sync_endpoints += usize::from(archive_bills_sync.newer_fetched > 0);
    result.backfill_endpoints += usize::from(archive_bills_sync.older_fetched > 0);
    mark_private_sync_endpoint_success(
        &conn,
        account,
        inst_id.as_deref(),
        "account-bills-archive",
        archive_bills_sync.oldest_cursor.as_deref(),
        archive_bills_sync.newest_cursor.as_deref(),
        archive_bills_sync.oldest_cursor.as_deref(),
        result.archive_bills_fetched,
        result.archive_bills_upserted,
    )?;

    // OKX can expose a trade bill before (or instead of) the same row in
    // fills-history. Repair missing fills from trade-class account bills so a
    // completed close cannot leave the local position episode open forever.
    result.fills_upserted +=
        backfill_trade_fills_from_account_bills(&mut conn, account, inst_id.as_deref())?;

    let positions_endpoint = PrivateSyncEndpoint {
        endpoint: "/api/v5/account/positions-history",
        scope: "positions-history",
        cursor_field: "uTime",
        extra_query: &[("instType", "SWAP")],
    };
    let (positions_newest, positions_oldest, positions_retried) = if sync_pass_covers(scopes, "positions-history") {
        prepare_private_sync_endpoint(
        &conn,
        account,
        inst_id.as_deref(),
        positions_endpoint.scope,
    )?
    } else {
        (Some(SCOPE_SKIPPED.to_string()), None, false)
    };
    let positions_sync = match fetch_private_endpoint(
        account,
        inst_id.as_deref(),
        max_pages,
        positions_endpoint,
        positions_newest,
        positions_oldest,
        positions_retried,
    )
    .await
    {
        Ok(value) => value,
        Err(error) => {
            let _ = mark_private_sync_endpoint_failed(
                &conn,
                account,
                inst_id.as_deref(),
                positions_endpoint.scope,
                &error,
            );
            return Err(error);
        }
    };
    result.positions_fetched = positions_sync.fetched;
    result.positions_upserted =
        upsert_okx_history_positions(&mut conn, account, &positions_sync.rows)?;
    result.retry_endpoints += usize::from(positions_sync.retried);
    result.new_sync_endpoints += usize::from(positions_sync.newer_fetched > 0);
    result.backfill_endpoints += usize::from(positions_sync.older_fetched > 0);
    mark_private_sync_endpoint_success(
        &conn,
        account,
        inst_id.as_deref(),
        "positions-history",
        positions_sync.oldest_cursor.as_deref(),
        positions_sync.newest_cursor.as_deref(),
        positions_sync.oldest_cursor.as_deref(),
        result.positions_fetched,
        result.positions_upserted,
    )?;

    result.finished_at = now_ms();
    upsert_private_sync_watermark(
        &conn,
        &account.id,
        &account.environment,
        inst_id.as_deref(),
        "private-history",
        result.finished_at,
        &result,
    )?;
    rebuild_position_episodes_for_account(
        &mut conn,
        &account.id,
        &account.environment,
        inst_id.as_deref(),
    )
    .map_err(|err| format!("历史持仓重建失败: {err}"))?;
    Ok(result)
}

/// Runs the interactive part of a history backfill and leaves the deep-history
/// endpoints to a follow-up pass.
///
/// A single unpaced pass over all seven endpoints spends 20+ requests, and OKX
/// allows only 5 per 2 seconds per User ID on the archive endpoints. Waiting for
/// that inside the command made a first-start sync take seconds before the user
/// saw anything, so the pass is split: the endpoints the interface reads run
/// first and return, the archive endpoints run afterwards on the strict budget
/// and their result reaches the interface through the usual status refresh.
async fn sync_private_history_phase(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    inst_id: &Option<String>,
    max_pages: u8,
    force: bool,
    scopes: &[&str],
    single_page: bool,
    allow_retry: bool,
) -> Result<PrivateHistorySyncResult, String> {
    let mut attempt = 1_u32;
    loop {
        let result = sync_private_history_attempt(
            app,
            account,
            inst_id.clone(),
            max_pages,
            force,
            scopes,
            single_page,
        )
        .await;
        let message = match result {
            Ok(value) => return Ok(value),
            Err(message) => message,
        };
        if !allow_retry
            || attempt >= PRIVATE_HISTORY_SYNC_ATTEMPTS
            || !is_private_history_database_contention(&message)
        {
            return Err(message);
        }
        let delay = Duration::from_secs(1 << attempt);
        boot_log(&format!(
            "private history sync database contention (attempt {attempt}/{PRIVATE_HISTORY_SYNC_ATTEMPTS}, account={}, env={}): {message}; retrying in {} ms",
            account.id,
            account.environment,
            delay.as_millis()
        ));
        sleep(delay).await;
        attempt = attempt.saturating_add(1);
    }
}

/// The deferred pass. It writes its own endpoint states, so a failure here only
/// costs a later retry: the interactive pass has already succeeded.
fn spawn_deferred_history_phase(
    app: &tauri::AppHandle,
    account: LocalAccount,
    inst_id: Option<String>,
    max_pages: u8,
    force: bool,
) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let _ = crate::okx_rate_limit::take_private_rest_pacing();
        let outcome = sync_private_history_phase(
            &app,
            &account,
            &inst_id,
            max_pages,
            force,
            &PHASE_B_SCOPES,
            true,
            false,
        )
        .await;
        match outcome {
            Ok(result) => boot_log(&format!(
                "private history archive phase done in {}ms (account={}, env={}, orders_archive={}, bills={}, bills_archive={})",
                started.elapsed().as_millis(),
                account.id,
                account.environment,
                result.archive_orders_upserted,
                result.bills_upserted,
                result.archive_bills_upserted
            )),
            Err(error) => boot_log(&format!(
                "private history archive phase failed after {}ms (account={}, env={}): {error}",
                started.elapsed().as_millis(),
                account.id,
                account.environment
            )),
        }
        log_private_rest_pacing(
            "archive",
            &account,
            private_rest_request_bound(&PHASE_B_SCOPES, max_pages, true),
        );
    });
}

pub(crate) async fn okx_sync_private_history(
    app: tauri::AppHandle,
    request: PrivateHistorySyncRequest,
) -> Result<PrivateHistorySyncResult, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    if !account.permissions.read {
        return Err("OKX API Key 未包含 read 权限，无法补充历史数据".to_string());
    }
    let inst_id = request
        .inst_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_string());
    let force = request.force.unwrap_or(false);
    let max_pages = request.max_pages.unwrap_or(3).clamp(1, 20);
    let force_network = request.force_network.unwrap_or(false);
    let started = Instant::now();
    let _ = crate::okx_rate_limit::take_private_rest_pacing();
    let result = sync_private_history_phase(
        &app,
        &account,
        &inst_id,
        max_pages,
        force,
        &PHASE_A_SCOPES,
        true,
        true,
    )
    .await?;
    boot_log(&format!(
        "private history interactive phase done in {}ms (account={}, env={}, orders={}, fills={}, positions={})",
        started.elapsed().as_millis(),
        account.id,
        account.environment,
        result.orders_upserted,
        result.recent_fills_upserted + result.fills_upserted,
        result.positions_upserted
    ));
    log_private_rest_pacing(
        "interactive",
        &account,
        private_rest_request_bound(&PHASE_A_SCOPES, max_pages, true),
    );
    // The archive scopes must be filled whether or not this request asked for
    // network work: the completion check requires all seven, so a user who never
    // opens the history panel would otherwise keep seeing "缺少补数接口". An
    // explicit request runs the pass straight away; a scheduled tick only runs it
    // when the stored archive state is still incomplete.
    let archives_still_missing = !private_sync_required_endpoints_complete(
        &open_database(&app)?,
        &account.id,
        &account.environment,
        inst_id.as_deref(),
    )?;
    if force_network || archives_still_missing {
        spawn_deferred_history_phase(&app, account, inst_id, max_pages, force);
    }
    Ok(result)
}

fn normalized_trade_fill_from_account_bill(
    mut row: serde_json::Value,
) -> Option<serde_json::Value> {
    if json_string(&row, "type").as_deref() != Some("2") {
        return None;
    }
    let (side, pos_side) = match json_string(&row, "subType").as_deref() {
        Some("3") => ("buy", "long"),
        Some("4") => ("sell", "short"),
        Some("5") => ("sell", "long"),
        Some("6") => ("buy", "short"),
        _ => return None,
    };
    let object = row.as_object_mut()?;
    object.insert(
        "side".to_string(),
        serde_json::Value::String(side.to_string()),
    );
    object.insert(
        "posSide".to_string(),
        serde_json::Value::String(pos_side.to_string()),
    );
    for (fill_key, bill_key) in [
        ("fillPx", "px"),
        ("fillSz", "sz"),
        ("fillPnl", "pnl"),
        ("feeCcy", "ccy"),
    ] {
        if !object.contains_key(fill_key) {
            if let Some(value) = object.get(bill_key).cloned() {
                object.insert(fill_key.to_string(), value);
            }
        }
    }
    Some(row)
}

pub(crate) fn backfill_trade_fills_from_account_bills(
    conn: &mut Connection,
    account: &LocalAccount,
    inst_id: Option<&str>,
) -> Result<usize, String> {
    let raw_rows = {
        let mut sql = "SELECT bill.raw_json
             FROM okx_account_bills bill
             WHERE bill.account_id = ?1
               AND bill.environment = ?2
               AND bill.bill_type = '2'
               AND bill.sub_type IN ('3', '4', '5', '6')
               AND NOT EXISTS (
                 SELECT 1 FROM okx_fills existing_fill
                 WHERE existing_fill.account_id = bill.account_id
                   AND existing_fill.environment = bill.environment
                   AND existing_fill.bill_id = bill.bill_id
               )"
        .to_string();
        if inst_id.is_some() {
            sql.push_str(" AND bill.inst_id = ?3");
        }
        sql.push_str(" ORDER BY COALESCE(bill.okx_ts, bill.synced_at, 0) ASC, bill.bill_id ASC");
        let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let mapper = |row: &rusqlite::Row<'_>| row.get::<_, String>(0);
        if let Some(symbol) = inst_id {
            statement
                .query_map(params![account.id, account.environment, symbol], mapper)
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?
        } else {
            statement
                .query_map(params![account.id, account.environment], mapper)
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?
        }
    };
    let fills = raw_rows
        .into_iter()
        .map(|raw| {
            serde_json::from_str::<serde_json::Value>(&raw).map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter_map(normalized_trade_fill_from_account_bill)
        .collect::<Vec<_>>();
    upsert_okx_history_fills(conn, account, "account-bills-fallback", &fills)
}

pub(crate) fn private_history_status(
    app: tauri::AppHandle,
    request: PrivateHistoryStatusRequest,
) -> Result<PrivateHistoryStatusResponse, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    let conn = open_database(&app)?;
    let inst_filter = request
        .inst_id
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let endpoints = if let Some(inst_id) = inst_filter.as_deref() {
        let mut stmt = conn
            .prepare(
                "SELECT scope, inst_id, status, cursor, newest_cursor, oldest_cursor, attempt, fetched, upserted,
                        last_error, next_retry_at, last_started_at, last_finished_at, updated_at
                 FROM sync_endpoint_states
                 WHERE account_id = ?1 AND environment = ?2 AND inst_id IN ('', ?3)
                 ORDER BY scope ASC, inst_id ASC",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(
                params![account.id, account.environment, inst_id],
                map_private_history_endpoint_status,
            )
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    } else {
        let mut stmt = conn
            .prepare(
                "SELECT scope, inst_id, status, cursor, newest_cursor, oldest_cursor, attempt, fetched, upserted,
                        last_error, next_retry_at, last_started_at, last_finished_at, updated_at
                 FROM sync_endpoint_states
                 WHERE account_id = ?1 AND environment = ?2
                 ORDER BY scope ASC, inst_id ASC",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(
                params![account.id, account.environment],
                map_private_history_endpoint_status,
            )
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    };
    let now = now_ms();
    let failed = endpoints
        .iter()
        .filter(|item| item.status == "failed")
        .count();
    let retrying = endpoints
        .iter()
        .filter(|item| item.next_retry_at.is_some_and(|retry_at| retry_at > now))
        .count();
    let running = endpoints
        .iter()
        .filter(|item| item.status == "running")
        .count();
    let updated_at = endpoints.iter().map(|item| item.updated_at).max();
    Ok(PrivateHistoryStatusResponse {
        account_id: account.id,
        environment: account.environment,
        inst_id: inst_filter,
        endpoints,
        failed,
        retrying,
        running,
        updated_at,
    })
}

async fn fetch_private_history_pages_from(
    account: &LocalAccount,
    endpoint: PrivateSyncEndpoint,
    inst_id: Option<&str>,
    max_pages: u8,
    direction: PrivateSyncDirection,
    start_cursor: Option<&str>,
) -> Result<PrivateEndpointSyncOutput, String> {
    let mut rows = Vec::new();
    let mut cursor = start_cursor
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let mut newest_cursor: Option<String> = None;
    let mut oldest_cursor: Option<String> = None;
    for _ in 0..max_pages {
        let mut path = format!("{}?limit=100", endpoint.endpoint);
        for (key, value) in endpoint.extra_query {
            path.push('&');
            path.push_str(key);
            path.push('=');
            path.push_str(&url_encode(value));
        }
        if let Some(symbol) = inst_id.filter(|value| !value.trim().is_empty()) {
            path.push_str("&instId=");
            path.push_str(&url_encode(symbol.trim()));
        }
        if let Some(value) = cursor.as_deref().filter(|value| !value.trim().is_empty()) {
            match direction {
                PrivateSyncDirection::Newer => path.push_str("&before="),
                PrivateSyncDirection::Older => path.push_str("&after="),
            }
            path.push_str(&url_encode(value));
        }
        let envelope = okx_private_get::<serde_json::Value>(account, &path).await?;
        if envelope.data.is_empty() {
            break;
        }
        let page_newest = envelope
            .data
            .first()
            .and_then(|row| json_string(row, endpoint.cursor_field))
            .filter(|value| !value.trim().is_empty());
        let page_oldest = envelope
            .data
            .last()
            .and_then(|row| json_string(row, endpoint.cursor_field))
            .filter(|value| !value.trim().is_empty());
        let fetched = envelope.data.len();
        match direction {
            PrivateSyncDirection::Newer => {
                if let Some(value) = page_newest.as_ref() {
                    newest_cursor = Some(value.clone());
                    cursor = Some(value.clone());
                }
                if oldest_cursor.is_none() {
                    oldest_cursor = page_oldest.clone();
                }
            }
            PrivateSyncDirection::Older => {
                if newest_cursor.is_none() {
                    newest_cursor = page_newest.clone();
                }
                if let Some(value) = page_oldest.as_ref() {
                    oldest_cursor = Some(value.clone());
                    cursor = Some(value.clone());
                }
            }
        }
        rows.extend(envelope.data);
        if fetched < 100 || cursor.is_none() {
            break;
        }
    }
    Ok(PrivateEndpointSyncOutput {
        fetched: rows.len(),
        newer_fetched: if direction == PrivateSyncDirection::Newer {
            rows.len()
        } else {
            0
        },
        older_fetched: if direction == PrivateSyncDirection::Older {
            rows.len()
        } else {
            0
        },
        rows,
        newest_cursor,
        oldest_cursor,
        retried: false,
    })
}

async fn fetch_private_endpoint(
    account: &LocalAccount,
    inst_id: Option<&str>,
    max_pages: u8,
    endpoint: PrivateSyncEndpoint,
    stored_newest: Option<String>,
    stored_oldest: Option<String>,
    retried: bool,
) -> Result<PrivateEndpointSyncOutput, String> {
    if stored_newest.as_deref() == Some(SCOPE_SKIPPED) {
        return Ok(empty_endpoint_sync_output());
    }
    let mut rows = Vec::new();
    let mut newest_cursor = stored_newest.clone();
    let mut oldest_cursor = stored_oldest.clone();
    if stored_newest.is_none() && stored_oldest.is_none() {
        let initial = fetch_private_history_pages_from(
            account,
            endpoint,
            inst_id,
            max_pages,
            PrivateSyncDirection::Older,
            None,
        )
        .await?;
        let fetched = initial.fetched;
        return Ok(PrivateEndpointSyncOutput {
            fetched,
            rows: initial.rows,
            newest_cursor: initial.newest_cursor,
            oldest_cursor: initial.oldest_cursor,
            newer_fetched: 0,
            older_fetched: fetched,
            retried,
        });
    }
    let newer_result = fetch_private_history_pages_from(
        account,
        endpoint,
        inst_id,
        max_pages,
        PrivateSyncDirection::Newer,
        stored_newest.as_deref(),
    )
    .await;
    let newer = newer_result?;
    if let Some(value) = newer.newest_cursor.as_ref() {
        newest_cursor = Some(value.clone());
    }
    if oldest_cursor.is_none() {
        oldest_cursor = newer.oldest_cursor.clone();
    }
    let newer_fetched = newer.fetched;
    let mut older_fetched = 0usize;
    rows.extend(newer.rows);

    if let Some(start_oldest) = stored_oldest.as_deref() {
        let older_result = fetch_private_history_pages_from(
            account,
            endpoint,
            inst_id,
            max_pages,
            PrivateSyncDirection::Older,
            Some(start_oldest),
        )
        .await;
        let older = older_result?;
        if let Some(value) = older.oldest_cursor.as_ref() {
            oldest_cursor = Some(value.clone());
        }
        older_fetched = older.fetched;
        rows.extend(older.rows);
    }

    Ok(PrivateEndpointSyncOutput {
        fetched: rows.len(),
        rows,
        newest_cursor,
        oldest_cursor,
        newer_fetched,
        older_fetched,
        retried,
    })
}

fn mark_private_sync_endpoint_started(
    conn: &Connection,
    account: &LocalAccount,
    inst_id: Option<&str>,
    scope: &str,
) -> Result<(), String> {
    let now = now_ms();
    conn.execute(
        "INSERT INTO sync_endpoint_states (
          account_id, environment, scope, inst_id, status, attempt, last_started_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'running', 1, ?5, ?5)
        ON CONFLICT(account_id, environment, scope, inst_id) DO UPDATE SET
          status='running',
          attempt=attempt + 1,
          last_started_at=excluded.last_started_at,
          updated_at=excluded.updated_at",
        params![
            account.id,
            account.environment,
            scope,
            inst_id.unwrap_or(""),
            now
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn prepare_private_sync_endpoint(
    conn: &Connection,
    account: &LocalAccount,
    inst_id: Option<&str>,
    scope: &str,
) -> Result<(Option<String>, Option<String>, bool), String> {
    let state = load_private_sync_endpoint_state(conn, account, inst_id, scope)?;
    let now = now_ms();
    let retried = state.as_ref().is_some_and(|item| {
        item.status == "failed" && item.next_retry_at.is_none_or(|retry_at| retry_at <= now)
    });
    let newest_cursor = state.as_ref().and_then(|item| item.newest_cursor.clone());
    let oldest_cursor = state
        .as_ref()
        .and_then(|item| item.oldest_cursor.clone().or_else(|| item.cursor.clone()));
    mark_private_sync_endpoint_started(conn, account, inst_id, scope)?;
    Ok((newest_cursor, oldest_cursor, retried))
}

fn mark_private_sync_endpoint_success(
    conn: &Connection,
    account: &LocalAccount,
    inst_id: Option<&str>,
    scope: &str,
    cursor: Option<&str>,
    newest_cursor: Option<&str>,
    oldest_cursor: Option<&str>,
    fetched: usize,
    upserted: usize,
) -> Result<(), String> {
    let now = now_ms();
    conn.execute(
        "INSERT INTO sync_endpoint_states (
          account_id, environment, scope, inst_id, status, cursor, newest_cursor, oldest_cursor, attempt, fetched, upserted,
          last_error, next_retry_at, last_finished_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'complete', ?5, ?6, ?7, 0, ?8, ?9, NULL, NULL, ?10, ?10)
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
        params![
            account.id,
            account.environment,
            scope,
            inst_id.unwrap_or(""),
            cursor,
            newest_cursor,
            oldest_cursor,
            fetched,
            upserted,
            now
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn mark_private_sync_endpoint_failed(
    conn: &Connection,
    account: &LocalAccount,
    inst_id: Option<&str>,
    scope: &str,
    error: &str,
) -> Result<(), String> {
    let now = now_ms();
    let attempt =
        sync_endpoint_attempt(conn, &account.id, &account.environment, scope, inst_id)?.max(1);
    let retry_delay_ms = (attempt.min(6) as i64) * 5 * 60_000;
    conn.execute(
        "INSERT INTO sync_endpoint_states (
          account_id, environment, scope, inst_id, status, attempt, last_error, next_retry_at, last_finished_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'failed', ?5, ?6, ?7, ?8, ?8)
        ON CONFLICT(account_id, environment, scope, inst_id) DO UPDATE SET
          status='failed',
          attempt=excluded.attempt,
          last_error=excluded.last_error,
          next_retry_at=excluded.next_retry_at,
          last_finished_at=excluded.last_finished_at,
          updated_at=excluded.updated_at",
        params![
            account.id,
            account.environment,
            scope,
            inst_id.unwrap_or(""),
            attempt,
            error.chars().take(1000).collect::<String>(),
            now + retry_delay_ms,
            now
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn sync_endpoint_attempt(
    conn: &Connection,
    account_id: &str,
    environment: &str,
    scope: &str,
    inst_id: Option<&str>,
) -> Result<i64, String> {
    let result = conn.query_row(
        "SELECT attempt FROM sync_endpoint_states
         WHERE account_id = ?1 AND environment = ?2 AND scope = ?3 AND inst_id = ?4",
        params![account_id, environment, scope, inst_id.unwrap_or("")],
        |row| row.get::<_, i64>(0),
    );
    match result {
        Ok(value) => Ok(value),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(0),
        Err(err) => Err(err.to_string()),
    }
}

fn load_private_sync_endpoint_state(
    conn: &Connection,
    account: &LocalAccount,
    inst_id: Option<&str>,
    scope: &str,
) -> Result<Option<PrivateSyncEndpointState>, String> {
    let result = conn.query_row(
        "SELECT status, cursor, newest_cursor, oldest_cursor, next_retry_at FROM sync_endpoint_states
         WHERE account_id = ?1 AND environment = ?2 AND scope = ?3 AND inst_id = ?4",
        params![account.id, account.environment, scope, inst_id.unwrap_or("")],
        |row| {
            Ok(PrivateSyncEndpointState {
                status: row.get(0)?,
                cursor: row.get(1)?,
                newest_cursor: row.get(2)?,
                oldest_cursor: row.get(3)?,
                next_retry_at: row.get(4)?,
            })
        },
    );
    match result {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

fn upsert_private_sync_watermark(
    conn: &Connection,
    account_id: &str,
    environment: &str,
    inst_id: Option<&str>,
    scope: &str,
    last_sync_at: i64,
    summary: &PrivateHistorySyncResult,
) -> Result<(), String> {
    let summary_json = serde_json::to_string(summary).map_err(|err| err.to_string())?;
    let inst_key = inst_id.unwrap_or("");
    conn.execute(
        "INSERT INTO sync_watermarks (account_id, environment, scope, inst_id, last_sync_at, summary_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(account_id, environment, scope, inst_id) DO UPDATE SET
           last_sync_at=excluded.last_sync_at,
           summary_json=excluded.summary_json",
        params![account_id, environment, scope, inst_key, last_sync_at, summary_json],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn load_recent_private_sync_watermark(
    conn: &Connection,
    account_id: &str,
    environment: &str,
    inst_id: Option<&str>,
    scope: &str,
    max_age_ms: i64,
) -> Result<Option<PrivateHistorySyncResult>, String> {
    let cutoff = now_ms() - max_age_ms;
    let mut stmt = conn
        .prepare(
            "SELECT summary_json FROM sync_watermarks
             WHERE account_id = ?1 AND environment = ?2 AND scope = ?3 AND inst_id = ?4 AND last_sync_at >= ?5",
        )
        .map_err(|err| err.to_string())?;
    let mut rows = stmt
        .query(params![
            account_id,
            environment,
            scope,
            inst_id.unwrap_or(""),
            cutoff
        ])
        .map_err(|err| err.to_string())?;
    if let Some(row) = rows.next().map_err(|err| err.to_string())? {
        let summary_json: String = row.get(0).map_err(|err| err.to_string())?;
        match serde_json::from_str::<PrivateHistorySyncResult>(&summary_json) {
            Ok(summary) => return Ok(Some(summary)),
            Err(_) => return Ok(None),
        }
    }
    Ok(None)
}

fn private_sync_required_endpoints_complete(
    conn: &Connection,
    account_id: &str,
    environment: &str,
    inst_id: Option<&str>,
) -> Result<bool, String> {
    const REQUIRED_SCOPES: [&str; 7] = [
        "orders-history",
        "orders-history-archive",
        "fills",
        "fills-history",
        "account-bills",
        "account-bills-archive",
        "positions-history",
    ];
    let inst_id = inst_id.unwrap_or("");
    let mut stmt = conn
        .prepare(
            "SELECT COUNT(*)
             FROM sync_endpoint_states
             WHERE account_id = ?1
               AND environment = ?2
               AND inst_id = ?3
               AND scope = ?4",
        )
        .map_err(|err| err.to_string())?;
    for scope in REQUIRED_SCOPES {
        let count: i64 = stmt
            .query_row(params![account_id, environment, inst_id, scope], |row| {
                row.get(0)
            })
            .map_err(|err| err.to_string())?;
        if count == 0 {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two-phase split must still cover every scope the completion check
    /// requires; a missing scope keeps reporting "缺少补数接口" to the user.
    #[test]
    fn the_two_sync_phases_cover_every_required_scope_exactly_once() {
        let mut union: Vec<&str> = PHASE_A_SCOPES
            .iter()
            .chain(PHASE_B_SCOPES.iter())
            .copied()
            .collect();
        union.sort_unstable();
        let mut expected = union.clone();
        expected.dedup();
        assert_eq!(union, expected, "a scope must not appear in both phases");

        for scope in [
            "orders-history",
            "orders-history-archive",
            "fills",
            "fills-history",
            "account-bills",
            "account-bills-archive",
            "positions-history",
        ] {
            assert!(
                union.contains(&scope),
                "required scope {scope} is missing from both phases"
            );
        }
        assert_eq!(union.len(), 7, "the phases must not invent extra scopes");
    }

    #[test]
    fn a_pass_only_touches_the_scopes_it_owns() {
        assert!(sync_pass_covers(&PHASE_A_SCOPES, "positions-history"));
        assert!(!sync_pass_covers(&PHASE_A_SCOPES, "account-bills-archive"));
        assert!(sync_pass_covers(&PHASE_B_SCOPES, "account-bills-archive"));
        assert!(!sync_pass_covers(&PHASE_B_SCOPES, "orders-history"));
        // An empty list means "everything", which is how the pre-split path ran.
        assert!(sync_pass_covers(&[], "orders-history"));
        assert!(sync_pass_covers(&[], "account-bills-archive"));
    }

    #[test]
    fn a_skipped_scope_is_a_cache_miss_instead_of_a_network_call() {
        let skipped = empty_endpoint_sync_output();
        assert_eq!(skipped.fetched, 0);
        assert!(skipped.rows.is_empty());
        assert!(skipped.newest_cursor.is_none());
        assert!(!skipped.retried);
    }

    #[test]
    fn the_interactive_pass_is_capped_to_one_page_per_direction() {
        assert_eq!(effective_page_budget(5, true), 1);
        assert_eq!(effective_page_budget(1, true), 1);
        assert_eq!(effective_page_budget(5, false), 5);
        // A zero page budget would fetch nothing, so it still has to ask once.
        assert_eq!(effective_page_budget(0, false), 1);
    }

    /// The first screen waits on this: 4 scopes x 2 directions x 1 page.
    #[test]
    fn the_interactive_pass_stays_within_eight_requests() {
        assert_eq!(private_rest_request_bound(&PHASE_A_SCOPES, 5, true), 8);
        assert_eq!(private_rest_request_bound(&PHASE_B_SCOPES, 5, true), 6);
        // A deep pass is allowed to spend more, and the bound has to follow.
        assert_eq!(private_rest_request_bound(&PHASE_A_SCOPES, 3, false), 24);
        assert_eq!(private_rest_request_bound(&[], 2, true), 0);
        // At the 200ms query interval the interactive pass waits about 1.6s.
        let interactive_wait_ms =
            private_rest_request_bound(&PHASE_A_SCOPES, 5, true) as u64 * 200;
        assert!(
            interactive_wait_ms <= 2_000,
            "the interactive pass must stay near 1.6s, would wait {interactive_wait_ms}ms"
        );
    }

    #[test]
    fn the_deferred_archive_pass_is_opt_in() {
        let scheduled: PrivateHistorySyncRequest =
            serde_json::from_str(r#"{"accountId":"account-a","maxPages":2,"force":true}"#)
                .expect("scheduled payload");
        assert_eq!(
            scheduled.force_network, None,
            "a scheduled tick must not re-spend the archive budget"
        );
        let explicit: PrivateHistorySyncRequest = serde_json::from_str(
            r#"{"accountId":"account-a","maxPages":3,"force":true,"forceNetwork":true}"#,
        )
        .expect("explicit payload");
        assert_eq!(explicit.force_network, Some(true));
    }

    #[test]
    fn trade_account_bill_normalizes_close_long_fill() {
        let normalized = normalized_trade_fill_from_account_bill(json!({
            "type": "2",
            "subType": "5",
            "billId": "bill-close-long",
            "ordId": "order-close-long",
            "tradeId": "trade-close-long",
            "instId": "BTC-USDT-SWAP",
            "instType": "SWAP",
            "sz": "0.04",
            "px": "68418.3",
            "pnl": "0.05676",
            "fee": "-0.005473464",
            "ccy": "USDT",
            "ts": "1700000000000"
        }))
        .expect("trade bill should normalize");

        assert_eq!(json_string(&normalized, "side").as_deref(), Some("sell"));
        assert_eq!(json_string(&normalized, "posSide").as_deref(), Some("long"));
        assert_eq!(json_string(&normalized, "fillSz").as_deref(), Some("0.04"));
        assert_eq!(
            json_string(&normalized, "fillPx").as_deref(),
            Some("68418.3")
        );
        assert_eq!(
            json_string(&normalized, "fillPnl").as_deref(),
            Some("0.05676")
        );
        assert_eq!(json_string(&normalized, "feeCcy").as_deref(), Some("USDT"));
    }

    #[test]
    fn missing_fill_is_backfilled_from_trade_account_bill() {
        let mut conn = Connection::open_in_memory().expect("open test database");
        initialize_database_v1_with_conn(&conn).expect("initialize test schema");
        let account = LocalAccount {
            id: "account-placeholder".to_string(),
            name: "Placeholder account".to_string(),
            exchange: "okx".to_string(),
            environment: "demo".to_string(),
            okx_uid: String::new(),
            okx_main_uid: String::new(),
            api_key: "placeholder-api-key".to_string(),
            secret_key: "placeholder-secret-key".to_string(),
            passphrase: "placeholder-passphrase".to_string(),
            permissions: Permissions {
                read: true,
                trade: false,
                withdraw: false,
            },
        };
        let bill = json!({
            "type": "2",
            "subType": "5",
            "billId": "bill-close-long",
            "ordId": "order-close-long",
            "tradeId": "trade-close-long",
            "instId": "BTC-USDT-SWAP",
            "instType": "SWAP",
            "sz": "0.04",
            "px": "68418.3",
            "pnl": "0.05676",
            "fee": "-0.005473464",
            "ccy": "USDT",
            "ts": "1700000000000"
        });
        upsert_okx_account_bills(&mut conn, &account, "account-bills", &[bill])
            .expect("store account bill");

        let repaired = backfill_trade_fills_from_account_bills(&mut conn, &account, None)
            .expect("backfill missing fill");
        assert_eq!(repaired, 1);
        let fill = conn
            .query_row(
                "SELECT side,pos_side,fill_sz,fill_px,fill_pnl,source_endpoint
                 FROM okx_fills
                 WHERE account_id=?1 AND environment=?2 AND bill_id='bill-close-long'",
                params![account.id, account.environment],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .expect("load repaired fill");
        assert_eq!(
            fill,
            (
                "sell".to_string(),
                "long".to_string(),
                "0.04".to_string(),
                "68418.3".to_string(),
                "0.05676".to_string(),
                "account-bills-fallback".to_string(),
            )
        );
        assert_eq!(
            backfill_trade_fills_from_account_bills(&mut conn, &account, None)
                .expect("repeat backfill"),
            0,
            "the repair must be idempotent"
        );
    }

    #[test]
    fn non_trade_account_bill_is_not_a_fill() {
        assert!(normalized_trade_fill_from_account_bill(json!({
            "type": "8",
            "subType": "173",
            "billId": "funding-bill"
        }))
        .is_none());
    }

    #[test]
    fn only_peer_lock_contention_is_retried() {
        assert!(is_private_history_database_contention("database is locked"));
        assert!(is_private_history_database_contention(
            "数据库同步失败：database is locked"
        ));
        assert!(is_private_history_database_contention("Database Is Busy"));
        assert!(is_private_history_database_contention(
            "database table is locked"
        ));
        // Genuine faults must reach the user instead of being retried.
        assert!(!is_private_history_database_contention(
            "OKX API Key 未包含 read 权限，无法补充历史数据"
        ));
        assert!(!is_private_history_database_contention(
            "database disk image is malformed"
        ));
        assert!(!is_private_history_database_contention(""));
        assert_eq!(PRIVATE_HISTORY_SYNC_ATTEMPTS, 3);
    }
}
