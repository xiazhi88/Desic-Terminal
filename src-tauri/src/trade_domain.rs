use super::*;
use desic_trade_domain::{
    calculate_linear_usdt_risk_budget as calculate_linear_usdt_risk_budget_impl,
    evaluate_linear_usdt_perpetual as evaluate_linear_usdt_perpetual_impl, load_trade_audit_events,
    LinearUsdtPerpetualEvaluation, LinearUsdtPerpetualEvaluationRequest, LinearUsdtRiskBudget,
    LinearUsdtRiskBudgetRequest, TradeAuditEventSummary, TradeAuditEventsRequest,
};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TradeAuditEvent {
    id: String,
    account_id: String,
    environment: String,
    exchange: String,
    inst_id: String,
    inst_type: String,
    event_type: String,
    operation: String,
    status: String,
    order_type: Option<String>,
    order_id: Option<String>,
    client_order_id: Option<String>,
    side: Option<String>,
    pos_side: Option<String>,
    td_mode: Option<String>,
    size: Option<String>,
    price: Option<String>,
    operator: String,
    strategy_id: Option<String>,
    session_id: Option<String>,
    live_confirmed: bool,
    okx_code: Option<String>,
    okx_message: Option<String>,
    error: Option<String>,
    request_json: String,
    response_json: Option<String>,
    created_at: i64,
}

#[tauri::command]
pub(crate) fn trade_audit_events(
    app: tauri::AppHandle,
    request: TradeAuditEventsRequest,
) -> Result<Vec<TradeAuditEventSummary>, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    let conn = open_database(&app)?;
    load_trade_audit_events(
        &conn,
        &account.id,
        &account.environment,
        request
            .inst_id
            .as_deref()
            .filter(|value| !value.trim().is_empty()),
        request.limit.unwrap_or(120).clamp(1, 300),
    )
}

#[tauri::command]
pub(crate) fn calculate_linear_usdt_risk_budget(
    request: LinearUsdtRiskBudgetRequest,
) -> Result<LinearUsdtRiskBudget, String> {
    calculate_linear_usdt_risk_budget_impl(&request).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn calculate_linear_usdt_perpetual(
    request: LinearUsdtPerpetualEvaluationRequest,
) -> Result<LinearUsdtPerpetualEvaluation, String> {
    evaluate_linear_usdt_perpetual_impl(&request).map_err(|error| error.to_string())
}

fn uuid_suffix() -> String {
    format!(
        "{:x}{:x}",
        std::process::id(),
        now_ms().rem_euclid(1_000_000)
    )
}

fn insert_trade_audit_event(app: &tauri::AppHandle, event: TradeAuditEvent) -> Result<(), String> {
    let conn = open_database(app)?;
    let summary = trade_audit_summary_from(&event);
    if insert_trade_audit_event_with_conn(&conn, event, false)? {
        let _ = app.emit(TRADE_AUDIT_EVENT, summary);
    }
    Ok(())
}

fn insert_trade_audit_event_with_conn(
    conn: &Connection,
    event: TradeAuditEvent,
    ignore_existing: bool,
) -> Result<bool, String> {
    let request_value = serde_json::from_str::<serde_json::Value>(&event.request_json)
        .unwrap_or_else(|_| json!({}));
    let request_payload = request_value.get("request").unwrap_or(&request_value);
    let opportunity_id = request_payload
        .get("opportunityId")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .or_else(|| {
            event
                .strategy_id
                .clone()
                .filter(|value| value.starts_with("opp"))
        });
    let agent_run_id = request_payload
        .get("agentRunId")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .or_else(|| {
            event
                .session_id
                .clone()
                .filter(|value| value.starts_with("run-") || value.starts_with("background:"))
        });
    let execution_key = request_payload
        .get("executionKey")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let verb = if ignore_existing {
        "INSERT OR IGNORE"
    } else {
        "INSERT"
    };
    let sql = format!(
        "{} INTO trade_audit_events (
          id, account_id, environment, exchange, inst_id, inst_type, event_type, operation, status,
          order_type, order_id, client_order_id, side, pos_side, td_mode, size, price, operator,
          strategy_id, session_id, opportunity_id, agent_run_id, execution_key,
          live_confirmed, okx_code, okx_message, error, request_json,
          response_json, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
          ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30)",
        verb
    );
    let affected = conn
        .execute(
            &sql,
            params![
                event.id,
                event.account_id,
                event.environment,
                event.exchange,
                event.inst_id,
                event.inst_type,
                event.event_type,
                event.operation,
                event.status,
                event.order_type,
                event.order_id,
                event.client_order_id,
                event.side,
                event.pos_side,
                event.td_mode,
                event.size,
                event.price,
                event.operator,
                event.strategy_id,
                event.session_id,
                opportunity_id,
                agent_run_id,
                execution_key,
                i64::from(event.live_confirmed),
                event.okx_code,
                event.okx_message,
                event.error,
                event.request_json,
                event.response_json,
                event.created_at,
            ],
        )
        .map_err(|err| err.to_string())?;
    Ok(affected > 0)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn audit_trade_event(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    inst_id: &str,
    event_type: &str,
    operation: &str,
    status: &str,
    order_type: Option<&str>,
    order_id: Option<&str>,
    client_order_id: Option<&str>,
    side: Option<&str>,
    pos_side: Option<&str>,
    td_mode: Option<&str>,
    size: Option<&str>,
    price: Option<&str>,
    operator: &str,
    strategy_id: Option<String>,
    session_id: Option<String>,
    live_confirmed: bool,
    okx_code: Option<&str>,
    okx_message: Option<&str>,
    error: Option<&str>,
    request_json: serde_json::Value,
    response_json: Option<serde_json::Value>,
) {
    let now = now_ms();
    let event = build_trade_audit_event(
        format!("audit-{}-{}", now, uuid_suffix()),
        now,
        account,
        inst_id,
        event_type,
        operation,
        status,
        order_type,
        order_id,
        client_order_id,
        side,
        pos_side,
        td_mode,
        size,
        price,
        operator,
        strategy_id,
        session_id,
        live_confirmed,
        okx_code,
        okx_message,
        error,
        request_json,
        response_json,
    );
    if let Err(err) = insert_trade_audit_event(app, event) {
        eprintln!("trade audit event insert failed: {}", err);
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn audit_trade_event_once(
    app: &tauri::AppHandle,
    event_id: &str,
    account: &LocalAccount,
    inst_id: &str,
    event_type: &str,
    operation: &str,
    status: &str,
    order_type: Option<&str>,
    order_id: Option<&str>,
    client_order_id: Option<&str>,
    side: Option<&str>,
    pos_side: Option<&str>,
    td_mode: Option<&str>,
    size: Option<&str>,
    price: Option<&str>,
    operator: &str,
    strategy_id: Option<String>,
    session_id: Option<String>,
    live_confirmed: bool,
    okx_code: Option<&str>,
    okx_message: Option<&str>,
    error: Option<&str>,
    request_json: serde_json::Value,
    response_json: Option<serde_json::Value>,
) -> Result<(), String> {
    if event_id.trim().is_empty() {
        return Err("幂等交易审计事件 ID 不能为空".to_string());
    }
    let event = build_trade_audit_event(
        event_id.to_string(),
        now_ms(),
        account,
        inst_id,
        event_type,
        operation,
        status,
        order_type,
        order_id,
        client_order_id,
        side,
        pos_side,
        td_mode,
        size,
        price,
        operator,
        strategy_id,
        session_id,
        live_confirmed,
        okx_code,
        okx_message,
        error,
        request_json,
        response_json,
    );
    let conn = open_database(app)?;
    let summary = trade_audit_summary_from(&event);
    if insert_trade_audit_event_with_conn(&conn, event, true)? {
        let _ = app.emit(TRADE_AUDIT_EVENT, summary);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn build_trade_audit_event(
    id: String,
    created_at: i64,
    account: &LocalAccount,
    inst_id: &str,
    event_type: &str,
    operation: &str,
    status: &str,
    order_type: Option<&str>,
    order_id: Option<&str>,
    client_order_id: Option<&str>,
    side: Option<&str>,
    pos_side: Option<&str>,
    td_mode: Option<&str>,
    size: Option<&str>,
    price: Option<&str>,
    operator: &str,
    strategy_id: Option<String>,
    session_id: Option<String>,
    live_confirmed: bool,
    okx_code: Option<&str>,
    okx_message: Option<&str>,
    error: Option<&str>,
    request_json: serde_json::Value,
    response_json: Option<serde_json::Value>,
) -> TradeAuditEvent {
    let request_json = private_exchange_value(&request_json).unwrap_or_else(|_| json!({}));
    let response_json =
        response_json.map(|value| private_exchange_value(&value).unwrap_or_else(|_| json!({})));
    TradeAuditEvent {
        id,
        account_id: account.id.clone(),
        environment: account.environment.clone(),
        exchange: account.exchange.clone(),
        inst_id: inst_id.to_string(),
        inst_type: "SWAP".to_string(),
        event_type: event_type.to_string(),
        operation: operation.to_string(),
        status: status.to_string(),
        order_type: order_type.map(str::to_string),
        order_id: order_id
            .map(str::to_string)
            .filter(|value| !value.trim().is_empty()),
        client_order_id: client_order_id
            .map(str::to_string)
            .filter(|value| !value.trim().is_empty()),
        side: side.map(str::to_string),
        pos_side: pos_side.map(str::to_string),
        td_mode: td_mode.map(str::to_string),
        size: size.map(str::to_string),
        price: price.map(str::to_string),
        operator: operator.to_string(),
        strategy_id,
        session_id,
        live_confirmed,
        okx_code: okx_code.map(str::to_string),
        okx_message: okx_message.map(str::to_string),
        error: error.map(str::to_string),
        request_json: request_json.to_string(),
        response_json: response_json.map(|value| value.to_string()),
        created_at,
    }
}

fn trade_audit_summary_from(event: &TradeAuditEvent) -> TradeAuditEventSummary {
    TradeAuditEventSummary {
        id: event.id.clone(),
        account_id: event.account_id.clone(),
        environment: event.environment.clone(),
        exchange: event.exchange.clone(),
        inst_id: event.inst_id.clone(),
        inst_type: event.inst_type.clone(),
        event_type: event.event_type.clone(),
        operation: event.operation.clone(),
        status: event.status.clone(),
        order_type: event.order_type.clone(),
        order_id: event.order_id.clone(),
        client_order_id: event.client_order_id.clone(),
        side: event.side.clone(),
        pos_side: event.pos_side.clone(),
        td_mode: event.td_mode.clone(),
        size: event.size.clone(),
        price: event.price.clone(),
        operator: event.operator.clone(),
        strategy_id: event.strategy_id.clone(),
        session_id: event.session_id.clone(),
        live_confirmed: event.live_confirmed,
        okx_code: event.okx_code.clone(),
        okx_message: event.okx_message.clone(),
        error: event.error.clone(),
        request_json: event.request_json.clone(),
        response_json: event.response_json.clone(),
        created_at: event.created_at,
    }
}

pub(crate) fn audit_fill_event_with_conn(
    conn: &Connection,
    account: &LocalAccount,
    fill: &serde_json::Value,
    source_endpoint: &str,
    operator: &str,
    strategy_id: Option<String>,
    session_id: Option<String>,
    synced_at: i64,
) -> Result<bool, String> {
    let bill_id =
        json_string(fill, "billId").unwrap_or_else(|| format!("no-bill-{}", uuid_suffix()));
    let event = TradeAuditEvent {
        id: format!("fill-{}-{}-{}", account.id, account.environment, bill_id),
        account_id: account.id.clone(),
        environment: account.environment.clone(),
        exchange: account.exchange.clone(),
        inst_id: json_string(fill, "instId").unwrap_or_default(),
        inst_type: json_string(fill, "instType").unwrap_or_else(|| "SWAP".to_string()),
        event_type: "order_fill".to_string(),
        operation: "okx_fill".to_string(),
        status: "filled".to_string(),
        order_type: None,
        order_id: json_string(fill, "ordId"),
        client_order_id: json_string(fill, "clOrdId"),
        side: json_string(fill, "side"),
        pos_side: json_string(fill, "posSide"),
        td_mode: None,
        size: json_string(fill, "fillSz"),
        price: json_string(fill, "fillPx"),
        operator: operator.to_string(),
        strategy_id,
        session_id,
        live_confirmed: normalize_environment(&account.environment) == "live",
        okx_code: None,
        okx_message: json_string(fill, "subType"),
        error: None,
        request_json: json!({
            "sourceEndpoint": source_endpoint,
            "billId": bill_id,
            "tradeId": json_string(fill, "tradeId"),
        })
        .to_string(),
        response_json: Some(private_exchange_json(fill)?),
        created_at: json_i64(fill, "ts")
            .or_else(|| json_i64(fill, "fillTime"))
            .unwrap_or(synced_at),
    };
    insert_trade_audit_event_with_conn(conn, event, true)
}

pub(crate) fn audit_position_episode_event_with_conn(
    conn: &Connection,
    account_id: &str,
    environment: &str,
    episode: &ActiveEpisodeBuild,
    fill: &EpisodeFillRow,
    event_type: &str,
    qty: f64,
    price: f64,
) -> Result<bool, String> {
    let bill_id = fill.bill_id.trim();
    let event = TradeAuditEvent {
        id: format!(
            "episode-{}-{}-{}-{}",
            account_id,
            environment,
            bill_id,
            event_type.to_ascii_lowercase()
        ),
        account_id: account_id.to_string(),
        environment: environment.to_string(),
        exchange: "okx".to_string(),
        inst_id: fill.inst_id.clone(),
        inst_type: fill.inst_type.clone(),
        event_type: "position_episode".to_string(),
        operation: format!("episode_{}", event_type.to_ascii_lowercase()),
        status: if event_type == "CLOSE" {
            "closed"
        } else {
            "updated"
        }
        .to_string(),
        order_type: None,
        order_id: fill.ord_id.clone(),
        client_order_id: None,
        side: fill.side.clone(),
        pos_side: fill
            .pos_side
            .clone()
            .or_else(|| Some(episode.episode_side.clone())),
        td_mode: None,
        size: Some(trim_float(qty)),
        price: Some(trim_float(price)),
        operator: fill.operator.clone().unwrap_or_else(|| "user".to_string()),
        strategy_id: fill.strategy_id.clone(),
        session_id: fill.session_id.clone(),
        live_confirmed: normalize_environment(environment) == "live",
        okx_code: None,
        okx_message: Some(event_type.to_string()),
        error: None,
        request_json: json!({
            "episodeId": episode.id,
            "billId": fill.bill_id,
            "tradeId": fill.trade_id,
            "positionAfter": trim_float(episode.remaining_qty),
        })
        .to_string(),
        response_json: Some(fill.raw_json.clone()),
        created_at: fill.okx_ts,
    };
    insert_trade_audit_event_with_conn(conn, event, true)
}

pub(crate) fn order_attribution(
    conn: &Connection,
    account: &LocalAccount,
    order_id: Option<&str>,
) -> Result<
    (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ),
    String,
> {
    let Some(order_id) = order_id
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        return Ok(("user".to_string(), None, None, None, None, None));
    };
    let result = conn.query_row(
        "SELECT operator, strategy_id, session_id, opportunity_id, agent_run_id, execution_key
         FROM okx_orders
         WHERE account_id = ?1
           AND environment = ?2
           AND (
             ord_id = ?3
             OR cl_ord_id = ?3
             OR (json_valid(raw_json) AND CAST(json_extract(raw_json, '$.ordId') AS TEXT) = ?3)
             OR ord_id = (
               SELECT CAST(json_extract(child.raw_json, '$.algoId') AS TEXT)
               FROM okx_orders child
               WHERE child.account_id = ?1 AND child.environment = ?2 AND child.ord_id = ?3
                 AND json_valid(child.raw_json)
               LIMIT 1
             )
           )
         ORDER BY CASE
           WHEN ord_id <> ?3 AND (
             (json_valid(raw_json) AND CAST(json_extract(raw_json, '$.ordId') AS TEXT) = ?3)
             OR ord_id = (
               SELECT CAST(json_extract(child.raw_json, '$.algoId') AS TEXT)
               FROM okx_orders child
               WHERE child.account_id = ?1 AND child.environment = ?2 AND child.ord_id = ?3
                 AND json_valid(child.raw_json)
               LIMIT 1
             )
           ) THEN 0
           WHEN opportunity_id IS NOT NULL OR agent_run_id IS NOT NULL THEN 1
           ELSE 2
         END, synced_at DESC
         LIMIT 1",
        params![account.id, account.environment, order_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        },
    );
    match result {
        Ok(value) => Ok(value),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Ok(("user".to_string(), None, None, None, None, None))
        }
        Err(err) => Err(err.to_string()),
    }
}
