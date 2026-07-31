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

pub(crate) async fn okx_sync_private_history(
    app: tauri::AppHandle,
    request: PrivateHistorySyncRequest,
) -> Result<PrivateHistorySyncResult, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    if !account.permissions.read {
        return Err("OKX API Key 未包含 read 权限，无法补充历史数据".to_string());
    }
    let started_at = now_ms();
    let inst_id = request
        .inst_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_string());
    let max_pages = request.max_pages.unwrap_or(3).clamp(1, 20);
    let mut conn = open_database(&app)?;
    if !request.force.unwrap_or(false)
        && private_sync_required_endpoints_complete(
            &conn,
            &account.id,
            &account.environment,
            inst_id.as_deref(),
        )?
    {
        if let Some(previous) = load_recent_private_sync_watermark(
            &conn,
            &account.id,
            &account.environment,
            inst_id.as_deref(),
            "private-history",
            6 * 60 * 60_000,
        )? {
            // The remote snapshot is still fresh, but its local projections may have
            // been added or repaired since the last network sync.
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
    let (orders_newest, orders_oldest, orders_retried) =
        prepare_private_sync_endpoint(&conn, &account, inst_id.as_deref(), orders_endpoint.scope)?;
    let orders_sync = match fetch_private_endpoint(
        &account,
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
                &account,
                inst_id.as_deref(),
                orders_endpoint.scope,
                &error,
            );
            return Err(error);
        }
    };
    result.orders_fetched = orders_sync.fetched;
    result.orders_upserted =
        upsert_okx_history_orders(&mut conn, &account, "orders-history", &orders_sync.rows)?;
    result.retry_endpoints += usize::from(orders_sync.retried);
    result.new_sync_endpoints += usize::from(orders_sync.newer_fetched > 0);
    result.backfill_endpoints += usize::from(orders_sync.older_fetched > 0);
    mark_private_sync_endpoint_success(
        &conn,
        &account,
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
    let (archive_orders_newest, archive_orders_oldest, archive_orders_retried) =
        prepare_private_sync_endpoint(
            &conn,
            &account,
            inst_id.as_deref(),
            archive_orders_endpoint.scope,
        )?;
    let archive_orders_sync = match fetch_private_endpoint(
        &account,
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
                &account,
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
        &account,
        "orders-history-archive",
        &archive_orders_sync.rows,
    )?;
    result.retry_endpoints += usize::from(archive_orders_sync.retried);
    result.new_sync_endpoints += usize::from(archive_orders_sync.newer_fetched > 0);
    result.backfill_endpoints += usize::from(archive_orders_sync.older_fetched > 0);
    mark_private_sync_endpoint_success(
        &conn,
        &account,
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
    let (recent_fills_newest, recent_fills_oldest, recent_fills_retried) =
        prepare_private_sync_endpoint(
            &conn,
            &account,
            inst_id.as_deref(),
            recent_fills_endpoint.scope,
        )?;
    let recent_fills_sync = match fetch_private_endpoint(
        &account,
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
                &account,
                inst_id.as_deref(),
                recent_fills_endpoint.scope,
                &error,
            );
            return Err(error);
        }
    };
    result.recent_fills_fetched = recent_fills_sync.fetched;
    result.recent_fills_upserted =
        upsert_okx_history_fills(&mut conn, &account, "fills", &recent_fills_sync.rows)?;
    result.retry_endpoints += usize::from(recent_fills_sync.retried);
    result.new_sync_endpoints += usize::from(recent_fills_sync.newer_fetched > 0);
    result.backfill_endpoints += usize::from(recent_fills_sync.older_fetched > 0);
    mark_private_sync_endpoint_success(
        &conn,
        &account,
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
    let (fills_newest, fills_oldest, fills_retried) =
        prepare_private_sync_endpoint(&conn, &account, inst_id.as_deref(), fills_endpoint.scope)?;
    let fills_sync = match fetch_private_endpoint(
        &account,
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
                &account,
                inst_id.as_deref(),
                fills_endpoint.scope,
                &error,
            );
            return Err(error);
        }
    };
    result.fills_fetched = fills_sync.fetched;
    result.fills_upserted =
        upsert_okx_history_fills(&mut conn, &account, "fills-history", &fills_sync.rows)?;
    result.retry_endpoints += usize::from(fills_sync.retried);
    result.new_sync_endpoints += usize::from(fills_sync.newer_fetched > 0);
    result.backfill_endpoints += usize::from(fills_sync.older_fetched > 0);
    mark_private_sync_endpoint_success(
        &conn,
        &account,
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
    let (bills_newest, bills_oldest, bills_retried) =
        prepare_private_sync_endpoint(&conn, &account, inst_id.as_deref(), bills_endpoint.scope)?;
    let bills_sync = match fetch_private_endpoint(
        &account,
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
                &account,
                inst_id.as_deref(),
                bills_endpoint.scope,
                &error,
            );
            return Err(error);
        }
    };
    result.bills_fetched = bills_sync.fetched;
    result.bills_upserted =
        upsert_okx_account_bills(&mut conn, &account, "account-bills", &bills_sync.rows)?;
    result.retry_endpoints += usize::from(bills_sync.retried);
    result.new_sync_endpoints += usize::from(bills_sync.newer_fetched > 0);
    result.backfill_endpoints += usize::from(bills_sync.older_fetched > 0);
    mark_private_sync_endpoint_success(
        &conn,
        &account,
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
    let (archive_bills_newest, archive_bills_oldest, archive_bills_retried) =
        prepare_private_sync_endpoint(
            &conn,
            &account,
            inst_id.as_deref(),
            archive_bills_endpoint.scope,
        )?;
    let archive_bills_sync = match fetch_private_endpoint(
        &account,
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
                &account,
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
        &account,
        "account-bills-archive",
        &archive_bills_sync.rows,
    )?;
    result.retry_endpoints += usize::from(archive_bills_sync.retried);
    result.new_sync_endpoints += usize::from(archive_bills_sync.newer_fetched > 0);
    result.backfill_endpoints += usize::from(archive_bills_sync.older_fetched > 0);
    mark_private_sync_endpoint_success(
        &conn,
        &account,
        inst_id.as_deref(),
        "account-bills-archive",
        archive_bills_sync.oldest_cursor.as_deref(),
        archive_bills_sync.newest_cursor.as_deref(),
        archive_bills_sync.oldest_cursor.as_deref(),
        result.archive_bills_fetched,
        result.archive_bills_upserted,
    )?;

    let positions_endpoint = PrivateSyncEndpoint {
        endpoint: "/api/v5/account/positions-history",
        scope: "positions-history",
        cursor_field: "uTime",
        extra_query: &[("instType", "SWAP")],
    };
    let (positions_newest, positions_oldest, positions_retried) = prepare_private_sync_endpoint(
        &conn,
        &account,
        inst_id.as_deref(),
        positions_endpoint.scope,
    )?;
    let positions_sync = match fetch_private_endpoint(
        &account,
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
                &account,
                inst_id.as_deref(),
                positions_endpoint.scope,
                &error,
            );
            return Err(error);
        }
    };
    result.positions_fetched = positions_sync.fetched;
    result.positions_upserted =
        upsert_okx_history_positions(&mut conn, &account, &positions_sync.rows)?;
    result.retry_endpoints += usize::from(positions_sync.retried);
    result.new_sync_endpoints += usize::from(positions_sync.newer_fetched > 0);
    result.backfill_endpoints += usize::from(positions_sync.older_fetched > 0);
    mark_private_sync_endpoint_success(
        &conn,
        &account,
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
