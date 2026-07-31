use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

mod numeric;
mod order;
mod risk;
mod status;

pub use numeric::{
    normalize_decimal, normalize_price, normalize_size, normalize_trade_input,
    InstrumentDecimalRules, NormalizedTradeInput, TradeDomainError, TradeInputNormalizationRequest,
};
pub use order::{
    normalize_order_input, normalize_order_spec, NormalizedOrderInput, OrderNormalizationRequest,
    OrderSpec, RegularExecution, TrailingCallback,
};
pub use risk::{
    calculate_linear_usdt_risk_budget, evaluate_linear_usdt_perpetual,
    LinearUsdtPerpetualEvaluation, LinearUsdtPerpetualEvaluationRequest, LinearUsdtPositionMetrics,
    LinearUsdtRiskBudget, LinearUsdtRiskBudgetRequest, LinearUsdtTradeCapacity,
};
pub use status::{
    normalize_terminal_outcome, normalize_terminal_state, summarize_emergency_operation,
    summarize_emergency_operations, summarize_emergency_targets, EmergencyOperationState,
    EmergencyOperationSummary, EmergencyOperationsSummary, EmergencyStatusCounts,
    EmergencyTargetState, NormalizedTerminalState, TerminalOutcome,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeAuditEventsRequest {
    pub account_id: Option<String>,
    pub inst_id: Option<String>,
    pub limit: Option<u16>,
}

#[derive(Debug, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TradeAuditEventSummary {
    pub id: String,
    pub account_id: String,
    pub environment: String,
    pub exchange: String,
    pub inst_id: String,
    pub inst_type: String,
    pub event_type: String,
    pub operation: String,
    pub status: String,
    pub order_type: Option<String>,
    pub order_id: Option<String>,
    pub client_order_id: Option<String>,
    pub side: Option<String>,
    pub pos_side: Option<String>,
    pub td_mode: Option<String>,
    pub size: Option<String>,
    pub price: Option<String>,
    pub operator: String,
    pub strategy_id: Option<String>,
    pub session_id: Option<String>,
    pub live_confirmed: bool,
    pub okx_code: Option<String>,
    pub okx_message: Option<String>,
    pub error: Option<String>,
    pub request_json: String,
    pub response_json: Option<String>,
    pub created_at: i64,
}

pub fn load_trade_audit_events(
    conn: &Connection,
    account_id: &str,
    environment: &str,
    inst_id: Option<&str>,
    limit: u16,
) -> Result<Vec<TradeAuditEventSummary>, String> {
    let mut sql = "SELECT id, account_id, environment, exchange, inst_id, inst_type, event_type, operation, status,
        order_type, order_id, client_order_id, side, pos_side, td_mode, size, price, operator,
        strategy_id, session_id, live_confirmed, okx_code, okx_message, error, request_json,
        response_json, created_at
        FROM trade_audit_events
        WHERE account_id = ?1 AND environment = ?2"
        .to_string();
    if inst_id.is_some() {
        sql.push_str(" AND inst_id = ?3");
        sql.push_str(" ORDER BY created_at DESC LIMIT ?4");
    } else {
        sql.push_str(" ORDER BY created_at DESC LIMIT ?3");
    }

    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let limit_value = i64::from(limit);
    let mapper = |row: &rusqlite::Row<'_>| {
        let live_confirmed: i64 = row.get(20)?;
        Ok(TradeAuditEventSummary {
            id: row.get(0)?,
            account_id: row.get(1)?,
            environment: row.get(2)?,
            exchange: row.get(3)?,
            inst_id: row.get(4)?,
            inst_type: row.get(5)?,
            event_type: row.get(6)?,
            operation: row.get(7)?,
            status: row.get(8)?,
            order_type: row.get(9)?,
            order_id: row.get(10)?,
            client_order_id: row.get(11)?,
            side: row.get(12)?,
            pos_side: row.get(13)?,
            td_mode: row.get(14)?,
            size: row.get(15)?,
            price: row.get(16)?,
            operator: row.get(17)?,
            strategy_id: row.get(18)?,
            session_id: row.get(19)?,
            live_confirmed: live_confirmed != 0,
            okx_code: row.get(21)?,
            okx_message: row.get(22)?,
            error: row.get(23)?,
            request_json: row.get(24)?,
            response_json: row.get(25)?,
            created_at: row.get(26)?,
        })
    };

    if let Some(symbol) = inst_id {
        stmt.query_map(
            params![account_id, environment, symbol, limit_value],
            mapper,
        )
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
    } else {
        stmt.query_map(params![account_id, environment, limit_value], mapper)
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())
    }
}
