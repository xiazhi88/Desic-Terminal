use super::*;
use desic_trade_domain::{
    normalize_decimal, summarize_emergency_targets, EmergencyTargetState, TerminalOutcome,
};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

const OPERATION_EVENT: &str = "trade:instrument-operation";
const PREVIEW_TTL_MS: i64 = 10_000;
const ORDINARY_CANCEL_BATCH_SIZE: usize = 20;
const ALGO_CANCEL_BATCH_SIZE: usize = 10;
const STRICT_FETCH_LIMIT: usize = 100;
static OPERATION_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstrumentOperationScope {
    account_id: Option<String>,
    environment: String,
    inst_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecuteInstrumentOperationRequest {
    operation_id: String,
    preview_id: String,
    account_id: Option<String>,
    environment: String,
    inst_id: String,
    confirmed: bool,
    confirmed_live: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstrumentOperationQuery {
    operation_id: String,
    account_id: Option<String>,
    environment: String,
    inst_id: String,
    #[serde(default)]
    expected_kind: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct InstrumentOperationTarget {
    key: String,
    target_type: String,
    inst_id: String,
    ord_id: Option<String>,
    cl_ord_id: Option<String>,
    algo_id: Option<String>,
    algo_cl_ord_id: Option<String>,
    pos_id: Option<String>,
    mgn_mode: Option<String>,
    pos_side: Option<String>,
    side: Option<String>,
    size: Option<String>,
    signed_size: Option<String>,
    mark_px: Option<String>,
    lever: Option<String>,
    order_type: Option<String>,
    state: Option<String>,
    accumulated_fill: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstrumentOperationCounts {
    ordinary: usize,
    trigger: usize,
    trailing: usize,
    conditional_oco: usize,
    partially_filled: usize,
    positions: usize,
    planned: usize,
    submitted: usize,
    accepted: usize,
    confirmed: usize,
    failed: usize,
    unknown: usize,
    residual: usize,
    filled_before_cancel: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstrumentOperationPreview {
    preview_id: String,
    operation_kind: String,
    account_id: String,
    environment: String,
    inst_id: String,
    fingerprint: String,
    counts: InstrumentOperationCounts,
    targets: Vec<InstrumentOperationTarget>,
    warnings: Vec<String>,
    created_at: i64,
    expires_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstrumentOperationTargetView {
    target: InstrumentOperationTarget,
    state: String,
    execution_key: Option<String>,
    response: Option<serde_json::Value>,
    error: Option<String>,
    updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstrumentOperationView {
    operation_id: String,
    preview_id: String,
    operation_kind: String,
    account_id: String,
    environment: String,
    inst_id: String,
    phase: String,
    outcome: Option<String>,
    counts: InstrumentOperationCounts,
    targets: Vec<InstrumentOperationTargetView>,
    error: Option<String>,
    created_at: i64,
    updated_at: i64,
    completed_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct StoredPreview {
    preview_id: String,
    operation_kind: String,
    account_id: String,
    environment: String,
    inst_id: String,
    credential_fingerprint: String,
    fingerprint: String,
    targets: Vec<InstrumentOperationTarget>,
    expires_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchCancelOrderBody {
    inst_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    ord_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cl_ord_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchCancelAlgoBody {
    inst_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    algo_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    algo_cl_ord_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EmergencyClosePositionBody {
    inst_id: String,
    mgn_mode: String,
    pos_side: String,
    auto_cxl: bool,
    cl_ord_id: String,
    #[serde(rename = "tag")]
    client_marker: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct EmergencyClosePositionResult {
    #[serde(default)]
    inst_id: String,
    #[serde(default)]
    pos_side: String,
    #[serde(default)]
    cl_ord_id: String,
    #[serde(default, rename = "tag", skip_serializing)]
    client_marker: String,
}

pub(crate) fn migrate_instrument_operations(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS instrument_operation_previews (
           preview_id TEXT PRIMARY KEY,
           operation_kind TEXT NOT NULL,
           account_id TEXT NOT NULL,
           environment TEXT NOT NULL,
           inst_id TEXT NOT NULL,
           credential_fingerprint TEXT NOT NULL DEFAULT '',
           fingerprint TEXT NOT NULL,
           targets_json TEXT NOT NULL,
           counts_json TEXT NOT NULL,
           warnings_json TEXT NOT NULL,
           consumed_by_operation_id TEXT,
           created_at INTEGER NOT NULL,
           expires_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_instrument_operation_previews_expiry
           ON instrument_operation_previews(expires_at);
         CREATE TABLE IF NOT EXISTS instrument_operations (
           operation_id TEXT PRIMARY KEY,
           preview_id TEXT NOT NULL,
           operation_kind TEXT NOT NULL,
           account_id TEXT NOT NULL,
           environment TEXT NOT NULL,
           inst_id TEXT NOT NULL,
           credential_fingerprint TEXT NOT NULL DEFAULT '',
           phase TEXT NOT NULL,
           outcome TEXT,
           counts_json TEXT NOT NULL,
           request_json TEXT NOT NULL,
           result_json TEXT,
           error TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           completed_at INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_instrument_operations_scope
           ON instrument_operations(account_id, environment, inst_id, updated_at DESC);
         CREATE INDEX IF NOT EXISTS idx_instrument_operations_recovery
           ON instrument_operations(phase, updated_at);
         CREATE TABLE IF NOT EXISTS instrument_operation_targets (
           operation_id TEXT NOT NULL,
           target_key TEXT NOT NULL,
           target_kind TEXT NOT NULL,
           state TEXT NOT NULL,
           target_json TEXT NOT NULL,
           execution_key TEXT,
           response_json TEXT,
           error TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           PRIMARY KEY (operation_id, target_key),
           FOREIGN KEY (operation_id) REFERENCES instrument_operations(operation_id)
         );
         CREATE INDEX IF NOT EXISTS idx_instrument_operation_targets_state
           ON instrument_operation_targets(operation_id, state);",
    )
    .map_err(|error| error.to_string())?;
    let _ = conn.execute(
        "ALTER TABLE instrument_operation_previews ADD COLUMN consumed_by_operation_id TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE instrument_operation_previews ADD COLUMN credential_fingerprint TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE instrument_operations ADD COLUMN credential_fingerprint TEXT NOT NULL DEFAULT ''",
        [],
    );
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_instrument_operation_previews_consumed
           ON instrument_operation_previews(consumed_by_operation_id);",
    )
    .map_err(|error| error.to_string())
}

fn operation_id(prefix: &str) -> String {
    let sequence = OPERATION_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed);
    format!("{prefix}-{}-{sequence}", now_ms())
}

fn validate_scope(account: &LocalAccount, scope: &InstrumentOperationScope) -> Result<(), String> {
    if account.exchange.to_ascii_lowercase() != "okx" {
        return Err("当前仅支持 OKX 紧急操作".to_string());
    }
    if normalize_environment(&account.environment) != normalize_environment(&scope.environment) {
        return Err("账号环境与当前交易环境不一致".to_string());
    }
    if !account.permissions.read || !account.permissions.trade {
        return Err("当前账号必须同时开启读取和交易权限".to_string());
    }
    if scope.inst_id.trim().is_empty() {
        return Err("当前合约不能为空".to_string());
    }
    Ok(())
}

fn stored_credential_matches(stored_fingerprint: &str, account: &LocalAccount) -> bool {
    !stored_fingerprint.trim().is_empty()
        && stored_fingerprint == account_config_cache_fingerprint(account)
}

fn validate_execute_confirmation(
    account: &LocalAccount,
    request: &ExecuteInstrumentOperationRequest,
) -> Result<(), String> {
    if !request.confirmed {
        return Err("紧急操作缺少明确确认标记".to_string());
    }
    if normalize_environment(&account.environment) == "live" && request.confirmed_live != Some(true)
    {
        return Err("实盘紧急操作缺少二次确认标记".to_string());
    }
    let operation_id = request.operation_id.trim();
    if operation_id.is_empty()
        || operation_id.len() > 128
        || !operation_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':')
        })
    {
        return Err("operationId 格式无效".to_string());
    }
    Ok(())
}

fn is_terminal_order_state(state: &str) -> bool {
    matches!(
        state.trim().to_ascii_lowercase().as_str(),
        "filled"
            | "canceled"
            | "cancelled"
            | "failed"
            | "rejected"
            | "mmp_canceled"
            | "order_failed"
    )
}

fn is_partially_filled(state: &str, accumulated_fill: &str) -> bool {
    state.eq_ignore_ascii_case("partially_filled")
        || parse_optional_f64(accumulated_fill).is_some_and(|value| value.abs() > 0.0)
}

fn fingerprint_targets(
    operation_kind: &str,
    account_id: &str,
    environment: &str,
    inst_id: &str,
    targets: &[InstrumentOperationTarget],
) -> Result<String, String> {
    let mut canonical = targets.to_vec();
    canonical.sort_by(|left, right| left.key.cmp(&right.key));
    let canonical = canonical
        .into_iter()
        .map(|target| {
            if target.target_type == "position" {
                Ok(json!({
                    "key": target.key,
                    "targetType": target.target_type,
                    "instId": target.inst_id,
                    "posId": target.pos_id,
                    "mgnMode": target.mgn_mode,
                    "posSide": target.pos_side,
                    "side": target.side,
                    "size": target.size,
                    "signedSize": target.signed_size,
                }))
            } else {
                serde_json::to_value(target).map_err(|error| error.to_string())
            }
        })
        .collect::<Result<Vec<_>, String>>()?;
    let payload = serde_json::to_vec(&json!({
        "operationKind": operation_kind,
        "accountId": account_id,
        "environment": normalize_environment(environment),
        "instId": inst_id,
        "targets": canonical,
    }))
    .map_err(|error| error.to_string())?;
    let digest = Sha256::digest(payload);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn ordinary_target(order: OkxPendingOrder) -> Result<Option<InstrumentOperationTarget>, String> {
    if is_terminal_order_state(&order.state) {
        return Ok(None);
    }
    let identity = optional_string(order.ord_id.clone())
        .or_else(|| optional_string(order.cl_ord_id.clone()))
        .ok_or_else(|| {
            coded_operation_error(
                "STRICT_ORDER_IDENTITY_MISSING",
                "OKX 活动普通委托缺少 ordId 和 clOrdId，无法构造可验证撤单目标；未发送任何交易请求",
            )
        })?;
    Ok(Some(InstrumentOperationTarget {
        key: format!("ordinary:{identity}"),
        target_type: "ordinary_order".to_string(),
        inst_id: order.inst_id,
        ord_id: optional_string(order.ord_id),
        cl_ord_id: optional_string(order.cl_ord_id),
        pos_side: optional_string(order.pos_side),
        side: optional_string(order.side),
        size: optional_string(order.sz),
        order_type: optional_string(order.ord_type),
        state: optional_string(order.state),
        accumulated_fill: optional_string(order.acc_fill_sz),
        ..Default::default()
    }))
}

fn algo_target(order: OkxAlgoPendingOrder) -> Result<Option<InstrumentOperationTarget>, String> {
    if is_terminal_order_state(&order.state) {
        return Ok(None);
    }
    let identity = optional_string(order.algo_id.clone())
        .or_else(|| optional_string(order.algo_cl_ord_id.clone()))
        .ok_or_else(|| {
            coded_operation_error(
                "STRICT_ORDER_IDENTITY_MISSING",
                "OKX 活动策略委托缺少 algoId 和 algoClOrdId，无法构造可验证撤单目标；未发送任何交易请求",
            )
        })?;
    Ok(Some(InstrumentOperationTarget {
        key: format!("algo:{identity}"),
        target_type: "algo_order".to_string(),
        inst_id: order.inst_id,
        ord_id: optional_string(order.ord_id),
        cl_ord_id: optional_string(order.cl_ord_id),
        algo_id: optional_string(order.algo_id),
        algo_cl_ord_id: optional_string(order.algo_cl_ord_id),
        pos_side: optional_string(order.pos_side),
        side: optional_string(order.side),
        size: optional_string(order.sz),
        order_type: optional_string(order.ord_type),
        state: optional_string(order.state),
        accumulated_fill: optional_string(order.actual_sz),
        ..Default::default()
    }))
}

fn validate_cancel_response_scope(
    inst_id: &str,
    ordinary: &[OkxPendingOrder],
    algo_groups: &[&[OkxAlgoPendingOrder]],
) -> Result<(), String> {
    let ordinary_mismatch = ordinary.iter().any(|order| order.inst_id != inst_id);
    let algo_mismatch = algo_groups
        .iter()
        .flat_map(|orders| orders.iter())
        .any(|order| order.inst_id != inst_id);
    if ordinary_mismatch || algo_mismatch {
        return Err(coded_operation_error(
            "STRICT_SCOPE_MISMATCH",
            "OKX 严格委托快照混入其它合约，无法证明操作边界；未发送任何交易请求",
        ));
    }
    Ok(())
}

fn validate_strict_cancel_fetch_counts(counts: [usize; 4]) -> Result<(), String> {
    if counts.into_iter().any(|count| count >= STRICT_FETCH_LIMIT) {
        return Err(coded_operation_error(
            "STRICT_SCOPE_TOO_LARGE",
            "当前合约至少有一类活动委托达到严格读取上限，无法证明预览完整；未发送任何交易请求",
        ));
    }
    Ok(())
}

async fn strict_cancel_targets(
    account: &LocalAccount,
    inst_id: &str,
) -> Result<(Vec<InstrumentOperationTarget>, InstrumentOperationCounts), String> {
    let encoded = url_encode(inst_id);
    let ordinary_path = format!(
        "/api/v5/trade/orders-pending?instType=SWAP&instId={encoded}&limit={STRICT_FETCH_LIMIT}"
    );
    let trigger_path = format!(
        "/api/v5/trade/orders-algo-pending?instType=SWAP&ordType=trigger&instId={encoded}&limit={STRICT_FETCH_LIMIT}"
    );
    let conditional_path = format!(
        "/api/v5/trade/orders-algo-pending?instType=SWAP&ordType=conditional,oco&instId={encoded}&limit={STRICT_FETCH_LIMIT}"
    );
    let trailing_path = format!(
        "/api/v5/trade/orders-algo-pending?instType=SWAP&ordType=move_order_stop&instId={encoded}&limit={STRICT_FETCH_LIMIT}"
    );
    let (ordinary, trigger, conditional, trailing) = tokio::join!(
        okx_private_get::<OkxPendingOrder>(account, &ordinary_path),
        okx_private_get::<OkxAlgoPendingOrder>(account, &trigger_path),
        okx_private_get::<OkxAlgoPendingOrder>(account, &conditional_path),
        okx_private_get::<OkxAlgoPendingOrder>(account, &trailing_path),
    );
    let ordinary = ordinary.map_err(|error| format!("严格读取普通委托失败：{error}"))?;
    let trigger = trigger.map_err(|error| format!("严格读取计划委托失败：{error}"))?;
    let conditional = conditional.map_err(|error| format!("严格读取止盈止损委托失败：{error}"))?;
    let trailing = trailing.map_err(|error| format!("严格读取移动止损委托失败：{error}"))?;
    validate_strict_cancel_fetch_counts([
        ordinary.data.len(),
        trigger.data.len(),
        conditional.data.len(),
        trailing.data.len(),
    ])?;
    validate_cancel_response_scope(
        inst_id,
        &ordinary.data,
        &[&trigger.data, &conditional.data, &trailing.data],
    )?;

    let mut counts = InstrumentOperationCounts::default();
    let mut targets = Vec::new();
    let mut seen = HashSet::new();
    for order in ordinary.data {
        if let Some(target) = ordinary_target(order)? {
            counts.ordinary += 1;
            if is_partially_filled(
                target.state.as_deref().unwrap_or_default(),
                target.accumulated_fill.as_deref().unwrap_or_default(),
            ) {
                counts.partially_filled += 1;
            }
            if !seen.insert(target.key.clone()) {
                return Err(coded_operation_error(
                    "STRICT_ORDER_IDENTITY_DUPLICATE",
                    "OKX 严格普通委托快照包含重复目标标识，无法证明预览完整；未发送任何交易请求",
                ));
            }
            targets.push(target);
        }
    }
    for order in trigger.data {
        if let Some(target) = algo_target(order)? {
            counts.trigger += 1;
            if !seen.insert(target.key.clone()) {
                return Err(coded_operation_error(
                    "STRICT_ORDER_IDENTITY_DUPLICATE",
                    "OKX 严格策略委托快照包含重复目标标识，无法证明预览完整；未发送任何交易请求",
                ));
            }
            targets.push(target);
        }
    }
    for order in conditional.data {
        if let Some(target) = algo_target(order)? {
            counts.conditional_oco += 1;
            if !seen.insert(target.key.clone()) {
                return Err(coded_operation_error(
                    "STRICT_ORDER_IDENTITY_DUPLICATE",
                    "OKX 严格策略委托快照包含重复目标标识，无法证明预览完整；未发送任何交易请求",
                ));
            }
            targets.push(target);
        }
    }
    for order in trailing.data {
        if let Some(target) = algo_target(order)? {
            counts.trailing += 1;
            if !seen.insert(target.key.clone()) {
                return Err(coded_operation_error(
                    "STRICT_ORDER_IDENTITY_DUPLICATE",
                    "OKX 严格策略委托快照包含重复目标标识，无法证明预览完整；未发送任何交易请求",
                ));
            }
            targets.push(target);
        }
    }
    targets.sort_by(|left, right| left.key.cmp(&right.key));
    counts.planned = targets.len();
    Ok((targets, counts))
}

fn flatten_preview_counts_and_warnings(
    position_count: usize,
    order_counts: Result<InstrumentOperationCounts, String>,
) -> (InstrumentOperationCounts, Vec<String>) {
    let mut warnings = vec![
        "只市价全平当前合约持仓，不撤销任何委托；残留委托之后成交可能重新形成仓位。".to_string(),
    ];
    let counts = match order_counts {
        Ok(order_counts) => InstrumentOperationCounts {
            ordinary: order_counts.ordinary,
            trigger: order_counts.trigger,
            trailing: order_counts.trailing,
            conditional_oco: order_counts.conditional_oco,
            positions: position_count,
            planned: position_count,
            ..Default::default()
        },
        Err(error) => {
            warnings.push(format!(
                "活动委托数量未知：委托提示读取或严格校验失败，但不阻断仅基于持仓的全平；详情：{error}"
            ));
            InstrumentOperationCounts {
                positions: position_count,
                planned: position_count,
                ..Default::default()
            }
        }
    };
    (counts, warnings)
}

fn position_target(position: OkxPosition) -> Result<Option<InstrumentOperationTarget>, String> {
    let signed_size = normalize_decimal(&position.pos, "position.pos").map_err(|error| {
        coded_operation_error(
            "STRICT_POSITION_INVALID",
            format!("OKX 持仓数量无法按精确十进制解析：{error}；未发送任何交易请求"),
        )
    })?;
    let mgn_mode = position.mgn_mode.trim().to_ascii_lowercase();
    if !matches!(mgn_mode.as_str(), "cross" | "isolated") {
        return Err(coded_operation_error(
            "STRICT_POSITION_INVALID",
            "OKX 持仓缺少有效 mgnMode（cross/isolated）；未发送任何交易请求",
        ));
    }
    let pos_side = position.pos_side.trim().to_ascii_lowercase();
    if !matches!(pos_side.as_str(), "net" | "long" | "short") {
        return Err(coded_operation_error(
            "STRICT_POSITION_INVALID",
            "OKX 持仓缺少有效 posSide（net/long/short）；未发送任何交易请求",
        ));
    }
    if signed_size == "0" {
        return Ok(None);
    }
    let negative = signed_size.starts_with('-');
    if pos_side != "net" && negative {
        return Err(coded_operation_error(
            "STRICT_POSITION_INVALID",
            "OKX long/short 持仓返回负数 pos，无法可靠推导平仓方向；未发送任何交易请求",
        ));
    }
    let size = signed_size
        .strip_prefix('-')
        .unwrap_or(&signed_size)
        .to_string();
    let identity = optional_string(position.pos_id.clone())
        .unwrap_or_else(|| format!("{mgn_mode}:{pos_side}"));
    let side = match pos_side.as_str() {
        "long" => "sell",
        "short" => "buy",
        _ if negative => "buy",
        _ => "sell",
    };
    Ok(Some(InstrumentOperationTarget {
        key: format!("position:{identity}"),
        target_type: "position".to_string(),
        inst_id: position.inst_id,
        pos_id: optional_string(position.pos_id),
        mgn_mode: Some(mgn_mode),
        pos_side: Some(pos_side),
        side: Some(side.to_string()),
        size: Some(size),
        signed_size: Some(signed_size),
        mark_px: optional_string(position.mark_px),
        lever: optional_string(position.lever),
        state: Some("open".to_string()),
        ..Default::default()
    }))
}

async fn strict_position_targets(
    account: &LocalAccount,
    inst_id: &str,
) -> Result<Vec<InstrumentOperationTarget>, String> {
    let path = format!(
        "/api/v5/account/positions?instType=SWAP&instId={}",
        url_encode(inst_id)
    );
    let envelope = okx_private_get::<OkxPosition>(account, &path)
        .await
        .map_err(|error| format!("严格读取当前合约持仓失败：{error}"))?;
    if envelope
        .data
        .iter()
        .any(|position| position.inst_id != inst_id)
    {
        return Err(coded_operation_error(
            "STRICT_SCOPE_MISMATCH",
            "OKX 严格持仓快照混入其它合约，无法证明操作边界；未发送任何交易请求",
        ));
    }
    let mut targets = Vec::new();
    let mut seen = HashSet::new();
    for position in envelope.data {
        if let Some(target) = position_target(position)? {
            if !seen.insert(target.key.clone()) {
                return Err(coded_operation_error(
                    "STRICT_POSITION_IDENTITY_DUPLICATE",
                    "OKX 严格持仓快照包含重复目标标识，无法证明预览完整；未发送任何交易请求",
                ));
            }
            targets.push(target);
        }
    }
    targets.sort_by(|left, right| left.key.cmp(&right.key));
    Ok(targets)
}

fn save_preview(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    preview: &InstrumentOperationPreview,
) -> Result<(), String> {
    let conn = open_database(app)?;
    conn.execute(
        "INSERT INTO instrument_operation_previews (
           preview_id,operation_kind,account_id,environment,inst_id,credential_fingerprint,
           fingerprint,targets_json,counts_json,warnings_json,created_at,expires_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![
            preview.preview_id,
            preview.operation_kind,
            preview.account_id,
            preview.environment,
            preview.inst_id,
            account_config_cache_fingerprint(account),
            preview.fingerprint,
            serde_json::to_string(&preview.targets).map_err(|error| error.to_string())?,
            serde_json::to_string(&preview.counts).map_err(|error| error.to_string())?,
            serde_json::to_string(&preview.warnings).map_err(|error| error.to_string())?,
            preview.created_at,
            preview.expires_at,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn audit_operation_preview(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    preview: &InstrumentOperationPreview,
) {
    crate::trade_domain::audit_trade_event(
        app,
        account,
        &preview.inst_id,
        "instrument_emergency_preview",
        &format!("preview_{}", preview.operation_kind),
        "previewed",
        None,
        None,
        Some(&preview.preview_id),
        None,
        None,
        None,
        None,
        None,
        "user",
        None,
        None,
        normalize_environment(&preview.environment) == "live",
        None,
        None,
        None,
        json!({
            "previewId": preview.preview_id,
            "operationKind": preview.operation_kind,
            "accountId": preview.account_id,
            "environment": preview.environment,
            "instId": preview.inst_id,
        }),
        Some(json!({
            "fingerprint": preview.fingerprint,
            "counts": preview.counts,
            "expiresAt": preview.expires_at,
        })),
    );
}

#[tauri::command]
pub(crate) async fn okx_preview_cancel_instrument_orders(
    app: tauri::AppHandle,
    request: InstrumentOperationScope,
) -> Result<InstrumentOperationPreview, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    validate_scope(&account, &request)?;
    let inst_id = request.inst_id.trim().to_ascii_uppercase();
    let (targets, counts) = strict_cancel_targets(&account, &inst_id).await?;
    let created_at = now_ms();
    let fingerprint = fingerprint_targets(
        "cancel_orders",
        &account.id,
        &account.environment,
        &inst_id,
        &targets,
    )?;
    let preview = InstrumentOperationPreview {
        preview_id: operation_id("cancel-preview"),
        operation_kind: "cancel_orders".to_string(),
        account_id: account.id.clone(),
        environment: account.environment.clone(),
        inst_id,
        fingerprint,
        counts,
        targets,
        warnings: vec!["只撤销当前合约委托，不会平仓；撤销确认前仍可能成交。".to_string()],
        created_at,
        expires_at: created_at + PREVIEW_TTL_MS,
    };
    save_preview(&app, &account, &preview)?;
    audit_operation_preview(&app, &account, &preview);
    Ok(preview)
}

#[tauri::command]
pub(crate) async fn okx_preview_flatten_instrument_positions(
    app: tauri::AppHandle,
    request: InstrumentOperationScope,
) -> Result<InstrumentOperationPreview, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    validate_scope(&account, &request)?;
    let inst_id = request.inst_id.trim().to_ascii_uppercase();
    let positions = strict_position_targets(&account, &inst_id).await?;
    let order_counts = strict_cancel_targets(&account, &inst_id)
        .await
        .map(|(_, counts)| counts);
    let created_at = now_ms();
    let fingerprint = fingerprint_targets(
        "flatten_positions",
        &account.id,
        &account.environment,
        &inst_id,
        &positions,
    )?;
    let (counts, warnings) = flatten_preview_counts_and_warnings(positions.len(), order_counts);
    let preview = InstrumentOperationPreview {
        preview_id: operation_id("flatten-preview"),
        operation_kind: "flatten_positions".to_string(),
        account_id: account.id.clone(),
        environment: account.environment.clone(),
        inst_id,
        fingerprint,
        counts,
        targets: positions,
        warnings,
        created_at,
        expires_at: created_at + PREVIEW_TTL_MS,
    };
    save_preview(&app, &account, &preview)?;
    audit_operation_preview(&app, &account, &preview);
    Ok(preview)
}

fn coded_operation_error(code: &str, message: impl Into<String>) -> String {
    json!({
        "code": code,
        "message": message.into(),
    })
    .to_string()
}

fn load_stored_preview(app: &tauri::AppHandle, preview_id: &str) -> Result<StoredPreview, String> {
    let conn = open_database(app)?;
    let row = conn
        .query_row(
            "SELECT preview_id,operation_kind,account_id,environment,inst_id,
                    credential_fingerprint,fingerprint,targets_json,expires_at
             FROM instrument_operation_previews WHERE preview_id=?1",
            [preview_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, i64>(8)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| coded_operation_error("PREVIEW_NOT_FOUND", "紧急操作预览不存在"))?;
    Ok(StoredPreview {
        preview_id: row.0,
        operation_kind: row.1,
        account_id: row.2,
        environment: row.3,
        inst_id: row.4,
        credential_fingerprint: row.5,
        fingerprint: row.6,
        targets: serde_json::from_str(&row.7).map_err(|error| error.to_string())?,
        expires_at: row.8,
    })
}

fn load_operation_view_with_conn(
    conn: &Connection,
    operation_id: &str,
) -> Result<Option<InstrumentOperationView>, String> {
    let row = conn
        .query_row(
            "SELECT operation_id,preview_id,operation_kind,account_id,environment,inst_id,phase,
                    outcome,counts_json,error,created_at,updated_at,completed_at
             FROM instrument_operations WHERE operation_id=?1",
            [operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, Option<i64>>(12)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(row) = row else {
        return Ok(None);
    };

    let mut statement = conn
        .prepare(
            "SELECT target_json,state,execution_key,response_json,error,updated_at
             FROM instrument_operation_targets WHERE operation_id=?1 ORDER BY target_key ASC",
        )
        .map_err(|error| error.to_string())?;
    let stored_targets = statement
        .query_map([operation_id], |target_row| {
            Ok((
                target_row.get::<_, String>(0)?,
                target_row.get::<_, String>(1)?,
                target_row.get::<_, Option<String>>(2)?,
                target_row.get::<_, Option<String>>(3)?,
                target_row.get::<_, Option<String>>(4)?,
                target_row.get::<_, i64>(5)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let targets = stored_targets
        .into_iter()
        .map(|target| {
            Ok(InstrumentOperationTargetView {
                target: serde_json::from_str(&target.0).map_err(|error| error.to_string())?,
                state: target.1,
                execution_key: target.2,
                response: target
                    .3
                    .as_deref()
                    .map(serde_json::from_str)
                    .transpose()
                    .map_err(|error| error.to_string())?,
                error: target.4,
                updated_at: target.5,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(Some(InstrumentOperationView {
        operation_id: row.0,
        preview_id: row.1,
        operation_kind: row.2,
        account_id: row.3,
        environment: row.4,
        inst_id: row.5,
        phase: row.6,
        outcome: row.7,
        counts: serde_json::from_str(&row.8).map_err(|error| error.to_string())?,
        targets,
        error: row.9,
        created_at: row.10,
        updated_at: row.11,
        completed_at: row.12,
    }))
}

fn load_operation_view(
    app: &tauri::AppHandle,
    operation_id: &str,
) -> Result<Option<InstrumentOperationView>, String> {
    let conn = open_database(app)?;
    load_operation_view_with_conn(&conn, operation_id)
}

fn validate_operation_credential(
    app: &tauri::AppHandle,
    operation_id: &str,
    account: &LocalAccount,
) -> Result<(), String> {
    let conn = open_database(app)?;
    let fingerprint = conn
        .query_row(
            "SELECT credential_fingerprint FROM instrument_operations WHERE operation_id=?1",
            [operation_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| coded_operation_error("OPERATION_NOT_FOUND", "紧急操作不存在"))?;
    if !stored_credential_matches(&fingerprint, account) {
        return Err(coded_operation_error(
            "OPERATION_CREDENTIAL_MISMATCH",
            "紧急操作绑定的账号凭据已变化或旧记录未绑定凭据，禁止使用当前凭据自动对账",
        ));
    }
    Ok(())
}

fn persist_operation_before_submit(
    app: &tauri::AppHandle,
    request: &ExecuteInstrumentOperationRequest,
    preview: &StoredPreview,
) -> Result<(InstrumentOperationView, bool), String> {
    let mut conn = open_database(app)?;
    let transaction = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let current_account = load_local_account_secret(app, Some(&preview.account_id))?;
    if normalize_environment(&current_account.environment)
        != normalize_environment(&preview.environment)
        || !stored_credential_matches(&preview.credential_fingerprint, &current_account)
    {
        return Err(coded_operation_error(
            "OPERATION_CREDENTIAL_MISMATCH",
            "账号配置已变化，已阻止使用旧预览创建紧急操作",
        ));
    }
    ensure_account_snapshot_current(app, &current_account).map_err(|error| {
        coded_operation_error(
            "OPERATION_ACCOUNT_IDENTITY_AMBIGUOUS",
            &format!("紧急操作账号身份校验失败：{error}"),
        )
    })?;
    if let Some(conflicting_operation_id) = active_operation_kind_conflict_with_conn(
        &transaction,
        &preview.account_id,
        &preview.environment,
        &preview.inst_id,
        &preview.operation_kind,
        &request.operation_id,
    )? {
        return Err(coded_operation_error(
            "OPERATION_KIND_UNRESOLVED",
            format!("同类型紧急操作 {conflicting_operation_id} 尚未完成对账，已阻止重复执行"),
        ));
    }
    let now = now_ms();
    let claimed = transaction
        .execute(
            "UPDATE instrument_operation_previews
             SET consumed_by_operation_id=?1
             WHERE preview_id=?2
               AND (consumed_by_operation_id IS NULL OR consumed_by_operation_id=?1)",
            params![request.operation_id, preview.preview_id],
        )
        .map_err(|error| error.to_string())?;
    if claimed != 1 {
        return Err(coded_operation_error(
            "PREVIEW_ALREADY_CONSUMED",
            "紧急操作预览已由另一个 operationId 消费，已阻止重复执行",
        ));
    }
    let mut counts = InstrumentOperationCounts {
        planned: preview.targets.len(),
        ..Default::default()
    };
    for target in &preview.targets {
        match target.target_type.as_str() {
            "ordinary_order" => counts.ordinary += 1,
            "algo_order" if target.order_type.as_deref() == Some("trigger") => counts.trigger += 1,
            "algo_order" if target.order_type.as_deref() == Some("move_order_stop") => {
                counts.trailing += 1
            }
            "algo_order" => counts.conditional_oco += 1,
            "position" => counts.positions += 1,
            _ => {}
        }
        if is_partially_filled(
            target.state.as_deref().unwrap_or_default(),
            target.accumulated_fill.as_deref().unwrap_or_default(),
        ) {
            counts.partially_filled += 1;
        }
    }
    // Even an empty preview remains provisional until a final strict scope scan succeeds.
    let phase = "submitting";
    let outcome: Option<&str> = None;
    let inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO instrument_operations (
               operation_id,preview_id,operation_kind,account_id,environment,inst_id,
               credential_fingerprint,phase,outcome,counts_json,request_json,
               created_at,updated_at,completed_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12,?13)",
            params![
                request.operation_id,
                preview.preview_id,
                preview.operation_kind,
                preview.account_id,
                preview.environment,
                preview.inst_id,
                preview.credential_fingerprint,
                phase,
                outcome,
                serde_json::to_string(&counts).map_err(|error| error.to_string())?,
                serde_json::to_string(request).map_err(|error| error.to_string())?,
                now,
                Option::<i64>::None,
            ],
        )
        .map_err(|error| error.to_string())?;
    if inserted == 1 {
        for target in &preview.targets {
            transaction
                .execute(
                    "INSERT INTO instrument_operation_targets (
                       operation_id,target_key,target_kind,state,target_json,created_at,updated_at
                     ) VALUES (?1,?2,?3,'planned',?4,?5,?5)",
                    params![
                        request.operation_id,
                        target.key,
                        target.target_type,
                        serde_json::to_string(target).map_err(|error| error.to_string())?,
                        now,
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    let view = load_operation_view_with_conn(&conn, &request.operation_id)?
        .ok_or_else(|| "紧急操作持久化后无法读取".to_string())?;
    Ok((view, inserted == 1))
}

fn set_target_state<T: Serialize>(
    app: &tauri::AppHandle,
    operation_id: &str,
    target_key: &str,
    state: &str,
    execution_key: Option<&str>,
    response: Option<&T>,
    error: Option<&str>,
) -> Result<(), String> {
    let conn = open_database(app)?;
    let response_json = response.map(private_exchange_json).transpose()?;
    conn.execute(
        "UPDATE instrument_operation_targets
         SET state=?3,execution_key=COALESCE(?4,execution_key),
             response_json=COALESCE(?5,response_json),error=?6,updated_at=?7
         WHERE operation_id=?1 AND target_key=?2
           AND state NOT IN (
             'confirmed','flat','already_terminal','filled_before_cancel',
             'rejected','residual','still_live'
           )",
        params![
            operation_id,
            target_key,
            state,
            execution_key,
            response_json,
            error,
            now_ms(),
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn upsert_residual_targets_with_conn(
    conn: &mut Connection,
    operation_id: &str,
    targets: &[InstrumentOperationTarget],
    error: &str,
) -> Result<(), String> {
    let transaction = conn
        .transaction()
        .map_err(|db_error| db_error.to_string())?;
    let now = now_ms();
    for target in targets {
        transaction
            .execute(
                "INSERT INTO instrument_operation_targets (
                   operation_id,target_key,target_kind,state,target_json,error,created_at,updated_at
                 ) VALUES (?1,?2,?3,'residual',?4,?5,?6,?6)
                 ON CONFLICT(operation_id,target_key) DO UPDATE SET
                   target_kind=excluded.target_kind,
                   state='residual',
                   target_json=excluded.target_json,
                   error=excluded.error,
                   updated_at=excluded.updated_at",
                params![
                    operation_id,
                    target.key,
                    target.target_type,
                    serde_json::to_string(target).map_err(|json_error| json_error.to_string())?,
                    error,
                    now,
                ],
            )
            .map_err(|db_error| db_error.to_string())?;
    }
    transaction
        .commit()
        .map_err(|db_error| db_error.to_string())
}

fn upsert_residual_targets(
    app: &tauri::AppHandle,
    operation_id: &str,
    targets: &[InstrumentOperationTarget],
    error: &str,
) -> Result<(), String> {
    if targets.is_empty() {
        return Ok(());
    }
    let mut conn = open_database(app)?;
    upsert_residual_targets_with_conn(&mut conn, operation_id, targets, error)
}

fn audit_operation_view(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    view: &InstrumentOperationView,
    status: &str,
) {
    crate::trade_domain::audit_trade_event(
        app,
        account,
        &view.inst_id,
        "instrument_emergency",
        &view.operation_kind,
        status,
        None,
        None,
        Some(&view.operation_id),
        None,
        None,
        None,
        None,
        None,
        "user",
        None,
        None,
        normalize_environment(&view.environment) == "live",
        None,
        None,
        view.error.as_deref(),
        json!({
            "operationId": view.operation_id,
            "previewId": view.preview_id,
            "operationKind": view.operation_kind,
            "accountId": view.account_id,
            "environment": view.environment,
            "instId": view.inst_id,
        }),
        Some(json!({
            "phase": view.phase,
            "outcome": view.outcome,
            "counts": view.counts,
        })),
    );
}

fn audit_operation_view_if_account_available(
    app: &tauri::AppHandle,
    view: &InstrumentOperationView,
    status: &str,
) {
    if let Ok(account) = load_local_account_secret(app, Some(&view.account_id)) {
        audit_operation_view(app, &account, view, status);
    }
}

fn operation_audit_status(view: &InstrumentOperationView) -> Option<&'static str> {
    match (view.phase.as_str(), view.outcome.as_deref()) {
        ("terminal", Some("succeeded")) => Some("succeeded"),
        ("terminal", Some("no_op")) => Some("no_op"),
        ("terminal", Some("partial")) => Some("partial"),
        ("terminal", Some("failed")) => Some("failed"),
        ("unknown", _) => Some("unknown"),
        _ => None,
    }
}

fn summarize_operation_targets(
    mut counts: InstrumentOperationCounts,
    targets: &[InstrumentOperationTargetView],
    now: i64,
) -> (
    InstrumentOperationCounts,
    &'static str,
    Option<&'static str>,
    Option<i64>,
) {
    counts.planned = targets.len();
    counts.submitted = 0;
    counts.accepted = 0;
    counts.confirmed = 0;
    counts.failed = 0;
    counts.unknown = 0;
    counts.residual = 0;
    counts.filled_before_cancel = 0;
    let mut active = 0usize;
    let mut terminal_targets = Vec::with_capacity(targets.len());
    for target in targets {
        if target.state != "planned" {
            counts.submitted += 1;
        }
        let (status, terminal) = match target.state.as_str() {
            "accepted" | "reconciling" => {
                counts.accepted += 1;
                active += 1;
                (TerminalOutcome::Unknown, false)
            }
            "confirmed" | "flat" | "already_terminal" => {
                counts.accepted += 1;
                counts.confirmed += 1;
                (TerminalOutcome::Succeeded, true)
            }
            "filled_before_cancel" => {
                counts.accepted += 1;
                counts.failed += 1;
                counts.filled_before_cancel += 1;
                (TerminalOutcome::Failed, true)
            }
            "rejected" => {
                counts.failed += 1;
                (TerminalOutcome::Failed, true)
            }
            "unknown" => (TerminalOutcome::Unknown, false),
            "residual" | "still_live" => {
                counts.failed += 1;
                counts.residual += 1;
                (TerminalOutcome::Failed, true)
            }
            "submitting" | "planned" => {
                active += 1;
                (TerminalOutcome::Unknown, false)
            }
            _ => {
                active += 1;
                (TerminalOutcome::Unknown, false)
            }
        };
        if status == TerminalOutcome::Unknown && target.state == "unknown" {
            counts.unknown += 1;
        }
        terminal_targets.push(EmergencyTargetState {
            target_id: target.target.key.clone(),
            status,
            terminal,
        });
    }

    let terminal_outcome = summarize_emergency_targets(&terminal_targets);
    let (phase, outcome, completed_at) = if active > 0 {
        ("reconciling", None, None)
    } else {
        match terminal_outcome {
            TerminalOutcome::NoOp => ("terminal", Some("no_op"), Some(now)),
            TerminalOutcome::Succeeded => ("terminal", Some("succeeded"), Some(now)),
            TerminalOutcome::Partial => ("terminal", Some("partial"), Some(now)),
            TerminalOutcome::Failed => ("terminal", Some("failed"), Some(now)),
            TerminalOutcome::Unknown => ("unknown", Some("unknown"), None),
        }
    };
    (counts, phase, outcome, completed_at)
}

fn refresh_operation_summary(
    app: &tauri::AppHandle,
    operation_id: &str,
) -> Result<InstrumentOperationView, String> {
    let conn = open_database(app)?;
    let mut view = load_operation_view_with_conn(&conn, operation_id)?
        .ok_or_else(|| "紧急操作不存在".to_string())?;
    let (counts, phase, outcome, completed_at) =
        summarize_operation_targets(view.counts.clone(), &view.targets, now_ms());
    let audit_transition = view.phase != phase || view.outcome.as_deref() != outcome;
    conn.execute(
        "UPDATE instrument_operations
         SET phase=?2,outcome=?3,counts_json=?4,updated_at=?5,
             completed_at=COALESCE(?6,completed_at),
             error=CASE WHEN ?2 IN ('terminal','reconciling') THEN NULL ELSE error END
         WHERE operation_id=?1",
        params![
            operation_id,
            phase,
            outcome,
            serde_json::to_string(&counts).map_err(|error| error.to_string())?,
            now_ms(),
            completed_at,
        ],
    )
    .map_err(|error| error.to_string())?;
    view = load_operation_view_with_conn(&conn, operation_id)?
        .ok_or_else(|| "紧急操作更新后无法读取".to_string())?;
    if audit_transition {
        if let Some(status) = operation_audit_status(&view) {
            audit_operation_view_if_account_available(app, &view, status);
        }
    }
    let _ = app.emit(OPERATION_EVENT, &view);
    Ok(view)
}

fn validate_existing_operation(
    view: InstrumentOperationView,
    request: &ExecuteInstrumentOperationRequest,
    resolved_account_id: &str,
    expected_kind: &str,
) -> Result<InstrumentOperationView, String> {
    if view.operation_kind != expected_kind
        || view.preview_id != request.preview_id
        || view.account_id != resolved_account_id
        || normalize_environment(&view.environment) != normalize_environment(&request.environment)
        || view.inst_id != request.inst_id.trim().to_ascii_uppercase()
    {
        return Err(coded_operation_error(
            "OPERATION_ID_CONFLICT",
            "operationId 已被其它账号、环境、合约或操作类型占用",
        ));
    }
    Ok(view)
}

async fn validate_preview_for_execute(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    request: &ExecuteInstrumentOperationRequest,
    expected_kind: &str,
) -> Result<StoredPreview, String> {
    let preview = load_stored_preview(app, request.preview_id.trim())?;
    let inst_id = request.inst_id.trim().to_ascii_uppercase();
    if preview.operation_kind != expected_kind
        || preview.account_id != account.id
        || normalize_environment(&preview.environment)
            != normalize_environment(&account.environment)
        || preview.inst_id != inst_id
    {
        return Err(coded_operation_error(
            "PREVIEW_SCOPE_MISMATCH",
            "预览与当前账号、环境、合约或操作类型不一致",
        ));
    }
    if !stored_credential_matches(&preview.credential_fingerprint, account) {
        return Err(coded_operation_error(
            "PREVIEW_CREDENTIAL_MISMATCH",
            "预览绑定的账号凭据已变化或旧预览未绑定凭据；未发送任何交易请求，请重新预览",
        ));
    }
    if now_ms() > preview.expires_at {
        return Err(coded_operation_error(
            "PREVIEW_EXPIRED",
            "紧急操作预览已超过 10 秒，请重新确认最新状态",
        ));
    }
    let current_targets = if expected_kind == "cancel_orders" {
        strict_cancel_targets(account, &inst_id).await?.0
    } else {
        strict_position_targets(account, &inst_id).await?
    };
    let current_fingerprint = fingerprint_targets(
        expected_kind,
        &account.id,
        &account.environment,
        &inst_id,
        &current_targets,
    )?;
    if current_fingerprint != preview.fingerprint {
        return Err(coded_operation_error(
            "PREVIEW_STALE",
            "委托或持仓在确认期间发生变化，未发送任何交易请求；请重新预览并确认",
        ));
    }
    Ok(preview)
}

fn prepare_interrupted_operation(
    app: &tauri::AppHandle,
    operation_id: &str,
) -> Result<InstrumentOperationView, String> {
    let mut conn = open_database(app)?;
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    let now = now_ms();
    transaction
        .execute(
            "UPDATE instrument_operation_targets
             SET state='rejected',error='执行中断前尚未开始提交；恢复流程不会自动重发交易请求',updated_at=?2
             WHERE operation_id=?1 AND state='planned'",
            params![operation_id, now],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE instrument_operation_targets
             SET state='unknown',error='交易请求提交期间中断，必须通过交易所状态对账',updated_at=?2
             WHERE operation_id=?1 AND state='submitting'",
            params![operation_id, now],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE instrument_operations
             SET phase='unknown',outcome='unknown',error='执行中断后正在执行只读对账',updated_at=?2
             WHERE operation_id=?1 AND phase='submitting'",
            params![operation_id, now],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    let view = load_operation_view(app, operation_id)?
        .ok_or_else(|| "紧急操作中断状态落库后无法读取".to_string())?;
    // Do not derive a terminal summary before the mandatory final full-scope scan.
    let _ = app.emit(OPERATION_EVENT, &view);
    Ok(view)
}

fn record_interrupted_submission(
    app: &tauri::AppHandle,
    operation_id: &str,
    submit_error: &str,
) -> Result<InstrumentOperationView, String> {
    let _ = prepare_interrupted_operation(app, operation_id)?;
    let conn = open_database(app)?;
    conn.execute(
        "UPDATE instrument_operations SET error=?2,updated_at=?3 WHERE operation_id=?1",
        params![
            operation_id,
            format!("紧急操作提交中断，后续只允许对账：{submit_error}"),
            now_ms(),
        ],
    )
    .map_err(|error| error.to_string())?;
    load_operation_view_with_conn(&conn, operation_id)?
        .ok_or_else(|| "紧急操作提交中断后无法读取".to_string())
}

fn mark_operation_recovery_error(
    app: &tauri::AppHandle,
    operation_id: &str,
    error: &str,
) -> Result<InstrumentOperationView, String> {
    let conn = open_database(app)?;
    let affected = conn
        .execute(
            "UPDATE instrument_operations
         SET phase='unknown',outcome='unknown',error=?2,updated_at=?3
         WHERE operation_id=?1 AND phase <> 'terminal'
           AND (phase <> 'unknown' OR COALESCE(error,'') <> ?2)",
            params![operation_id, error, now_ms()],
        )
        .map_err(|db_error| db_error.to_string())?;
    let view = load_operation_view_with_conn(&conn, operation_id)?
        .ok_or_else(|| coded_operation_error("OPERATION_NOT_FOUND", "紧急操作不存在"))?;
    if affected > 0 {
        audit_operation_view_if_account_available(app, &view, "unknown");
    }
    Ok(view)
}

async fn reconcile_saved_operation(
    app: &tauri::AppHandle,
    view: &InstrumentOperationView,
) -> Result<InstrumentOperationView, String> {
    let account = load_local_account_secret(app, Some(&view.account_id))?;
    if account.exchange.to_ascii_lowercase() != "okx"
        || !account.permissions.read
        || normalize_environment(&account.environment) != normalize_environment(&view.environment)
    {
        return Err("恢复对账账号不可读，或账号环境与操作记录不一致".to_string());
    }
    validate_operation_credential(app, &view.operation_id, &account)?;
    match view.operation_kind.as_str() {
        "cancel_orders" => reconcile_cancel_operation(app, &account, &view.operation_id).await,
        "flatten_positions" => reconcile_flatten_operation(app, &account, &view.operation_id).await,
        _ => Err("未知紧急操作类型，恢复流程已停止".to_string()),
    }
}

async fn recover_instrument_operations(app: &tauri::AppHandle) -> Result<(), String> {
    let operation_ids = {
        let conn = open_database(app)?;
        let mut statement = conn
            .prepare(
                "SELECT operation_id FROM instrument_operations
                 WHERE phase IN ('submitting','reconciling','unknown')
                 ORDER BY created_at ASC",
            )
            .map_err(|error| error.to_string())?;
        let operation_ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        operation_ids
    };

    for operation_id in operation_ids {
        let _operation_guard = TRADE_MUTATION_LOCK.lock().await;
        let view = prepare_interrupted_operation(app, &operation_id)?;
        if view.phase == "terminal" {
            continue;
        }
        if let Err(error) = reconcile_saved_operation(app, &view).await {
            let _ = mark_operation_recovery_error(app, &operation_id, &error);
        }
    }
    Ok(())
}

pub(crate) fn start_instrument_operation_recovery(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _ = recover_instrument_operations(&app).await;
    });
}

fn validate_operation_query_scope(
    view: &InstrumentOperationView,
    resolved_account_id: &str,
    resolved_environment: &str,
    request: &InstrumentOperationQuery,
) -> Result<(), String> {
    let expected_kind = request
        .expected_kind
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if view.account_id != resolved_account_id
        || normalize_environment(&view.environment) != normalize_environment(&request.environment)
        || normalize_environment(resolved_environment)
            != normalize_environment(&request.environment)
        || view.inst_id != request.inst_id.trim().to_ascii_uppercase()
        || expected_kind.is_some_and(|kind| view.operation_kind != kind)
    {
        return Err(coded_operation_error(
            "OPERATION_SCOPE_MISMATCH",
            "紧急操作查询与当前账号、环境、合约或预期操作类型不一致",
        ));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn okx_instrument_operation(
    app: tauri::AppHandle,
    request: InstrumentOperationQuery,
) -> Result<InstrumentOperationView, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    let view = load_operation_view(&app, request.operation_id.trim())?
        .ok_or_else(|| coded_operation_error("OPERATION_NOT_FOUND", "紧急操作不存在"))?;
    validate_operation_query_scope(&view, &account.id, &account.environment, &request)?;
    validate_operation_credential(&app, &view.operation_id, &account)?;
    if view.phase == "terminal" {
        return Ok(view);
    }
    let _operation_guard = TRADE_MUTATION_LOCK.lock().await;
    let view = load_operation_view(&app, request.operation_id.trim())?
        .ok_or_else(|| coded_operation_error("OPERATION_NOT_FOUND", "紧急操作不存在"))?;
    validate_operation_query_scope(&view, &account.id, &account.environment, &request)?;
    let view = if view.phase == "submitting" {
        prepare_interrupted_operation(&app, &view.operation_id)?
    } else {
        view
    };
    if view.phase == "terminal" {
        return Ok(view);
    }
    match reconcile_saved_operation(&app, &view).await {
        Ok(reconciled) => Ok(reconciled),
        Err(error) => mark_operation_recovery_error(&app, &view.operation_id, &error),
    }
}

pub(crate) fn unresolved_instrument_operations_for_scope(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    inst_id: &str,
) -> Result<Vec<InstrumentOperationView>, String> {
    let inst_id = inst_id.trim().to_ascii_uppercase();
    if inst_id.is_empty() {
        return Err("交易品种不能为空".to_string());
    }
    let conn = open_database(app)?;
    let mut statement = conn
        .prepare(
            "SELECT operation_id FROM instrument_operations
             WHERE account_id=?1 AND environment=?2 AND inst_id=?3
               AND phase IN ('submitting','reconciling','unknown')
             ORDER BY updated_at ASC",
        )
        .map_err(|error| error.to_string())?;
    let operation_ids = statement
        .query_map(params![account.id, account.environment, inst_id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    operation_ids
        .into_iter()
        .map(|operation_id| {
            load_operation_view_with_conn(&conn, &operation_id)?
                .ok_or_else(|| "活动紧急操作索引与记录不一致".to_string())
        })
        .collect()
}

pub(crate) fn has_unresolved_instrument_operations_for_scope_with_conn(
    conn: &Connection,
    account: &LocalAccount,
    inst_id: &str,
) -> Result<bool, String> {
    let inst_id = inst_id.trim().to_ascii_uppercase();
    if inst_id.is_empty() {
        return Err("交易品种不能为空".to_string());
    }
    conn.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM instrument_operations
           WHERE account_id=?1
             AND CASE WHEN lower(environment) IN ('demo','simulated') THEN 'demo' ELSE 'live' END=?2
             AND inst_id=?3 AND phase IN ('submitting','reconciling','unknown')
         )",
        params![
            account.id,
            normalize_environment(&account.environment),
            inst_id
        ],
        |row| row.get::<_, bool>(0),
    )
    .map_err(|error| error.to_string())
}

fn ensure_no_other_unresolved_operation_kind(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    inst_id: &str,
    operation_kind: &str,
    operation_id: &str,
) -> Result<(), String> {
    let conflict = unresolved_instrument_operations_for_scope(app, account, inst_id)?
        .into_iter()
        .find(|view| view.operation_kind == operation_kind && view.operation_id != operation_id);
    if let Some(view) = conflict {
        return Err(coded_operation_error(
            "OPERATION_KIND_UNRESOLVED",
            format!(
                "同类型紧急操作 {} 尚未完成对账，已阻止重复执行",
                view.operation_id
            ),
        ));
    }
    Ok(())
}

fn active_operation_kind_conflict_with_conn(
    conn: &Connection,
    account_id: &str,
    environment: &str,
    inst_id: &str,
    operation_kind: &str,
    operation_id: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT operation_id FROM instrument_operations
         WHERE account_id=?1
           AND CASE WHEN lower(environment) IN ('demo','simulated') THEN 'demo' ELSE 'live' END=?2
           AND inst_id=?3 AND operation_kind=?4
           AND operation_id<>?5 AND phase IN ('submitting','reconciling','unknown')
         ORDER BY created_at ASC LIMIT 1",
        params![
            account_id,
            normalize_environment(environment),
            inst_id.trim().to_ascii_uppercase(),
            operation_kind,
            operation_id,
        ],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn okx_active_instrument_operations(
    app: tauri::AppHandle,
    request: InstrumentOperationScope,
) -> Result<Vec<InstrumentOperationView>, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    validate_scope(&account, &request)?;
    unresolved_instrument_operations_for_scope(&app, &account, &request.inst_id)
}

fn confirmed_missing_order_error(error: &str) -> bool {
    let parsed = serde_json::from_str::<serde_json::Value>(error).ok();
    let code = parsed
        .as_ref()
        .and_then(|value| value.get("code"))
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let message = parsed
        .as_ref()
        .and_then(|value| value.get("message"))
        .and_then(|value| value.as_str())
        .unwrap_or(error)
        .to_ascii_lowercase();
    code == "51603"
        || message.contains("order does not exist")
        || message.contains("order not found")
        || message.contains("订单不存在")
}

fn ordinary_result_for_target<'a>(
    data: &'a [OkxOrderResult],
    target: &InstrumentOperationTarget,
) -> Option<&'a OkxOrderResult> {
    let mut matches = data
        .iter()
        .filter(|result| ordinary_result_matches_target(result, target));
    let result = matches.next()?;
    matches.next().is_none().then_some(result)
}

fn algo_result_for_target<'a>(
    data: &'a [OkxAlgoOrderResult],
    target: &InstrumentOperationTarget,
) -> Option<&'a OkxAlgoOrderResult> {
    let mut matches = data
        .iter()
        .filter(|result| algo_result_matches_target(result, target));
    let result = matches.next()?;
    matches.next().is_none().then_some(result)
}

fn ordinary_result_matches_target(
    result: &OkxOrderResult,
    target: &InstrumentOperationTarget,
) -> bool {
    let mut has_identity = false;
    if let Some(expected) = target.ord_id.as_deref() {
        has_identity = true;
        if result.ord_id.trim() != expected {
            return false;
        }
    }
    if let Some(expected) = target.cl_ord_id.as_deref() {
        has_identity = true;
        if result.cl_ord_id.trim() != expected {
            return false;
        }
    }
    has_identity
}

fn algo_result_matches_target(
    result: &OkxAlgoOrderResult,
    target: &InstrumentOperationTarget,
) -> bool {
    let mut has_identity = false;
    if let Some(expected) = target.algo_id.as_deref() {
        has_identity = true;
        if result.algo_id.trim() != expected {
            return false;
        }
    }
    if let Some(expected) = target.algo_cl_ord_id.as_deref() {
        has_identity = true;
        if result.algo_cl_ord_id.trim() != expected {
            return false;
        }
    }
    has_identity
}

fn ordinary_batch_response_is_exact(
    data: &[OkxOrderResult],
    targets: &[InstrumentOperationTarget],
) -> bool {
    data.len() == targets.len()
        && targets
            .iter()
            .all(|target| ordinary_result_for_target(data, target).is_some())
        && data.iter().all(|result| {
            targets
                .iter()
                .filter(|target| ordinary_result_matches_target(result, target))
                .count()
                == 1
        })
}

fn algo_batch_response_is_exact(
    data: &[OkxAlgoOrderResult],
    targets: &[InstrumentOperationTarget],
) -> bool {
    data.len() == targets.len()
        && targets
            .iter()
            .all(|target| algo_result_for_target(data, target).is_some())
        && data.iter().all(|result| {
            targets
                .iter()
                .filter(|target| algo_result_matches_target(result, target))
                .count()
                == 1
        })
}

fn ordinary_pending_order_matches_target(
    order: &OkxPendingOrder,
    target: &InstrumentOperationTarget,
) -> bool {
    if order.inst_id != target.inst_id {
        return false;
    }
    let mut has_identity = false;
    if let Some(expected) = target.ord_id.as_deref() {
        has_identity = true;
        if order.ord_id.trim() != expected {
            return false;
        }
    }
    if let Some(expected) = target.cl_ord_id.as_deref() {
        has_identity = true;
        if order.cl_ord_id.trim() != expected {
            return false;
        }
    }
    has_identity
}

fn algo_pending_order_matches_target(
    order: &OkxAlgoPendingOrder,
    target: &InstrumentOperationTarget,
) -> bool {
    if order.inst_id != target.inst_id {
        return false;
    }
    let mut has_identity = false;
    if let Some(expected) = target.algo_id.as_deref() {
        has_identity = true;
        if order.algo_id.trim() != expected {
            return false;
        }
    }
    if let Some(expected) = target.algo_cl_ord_id.as_deref() {
        has_identity = true;
        if order.algo_cl_ord_id.trim() != expected {
            return false;
        }
    }
    has_identity
}

fn ordinary_pending_order_for_target<'a>(
    data: &'a [OkxPendingOrder],
    target: &InstrumentOperationTarget,
) -> Option<&'a OkxPendingOrder> {
    let mut matches = data
        .iter()
        .filter(|order| ordinary_pending_order_matches_target(order, target));
    let order = matches.next()?;
    matches.next().is_none().then_some(order)
}

fn algo_pending_order_for_target<'a>(
    data: &'a [OkxAlgoPendingOrder],
    target: &InstrumentOperationTarget,
) -> Option<&'a OkxAlgoPendingOrder> {
    let mut matches = data
        .iter()
        .filter(|order| algo_pending_order_matches_target(order, target));
    let order = matches.next()?;
    matches.next().is_none().then_some(order)
}

async fn submit_ordinary_cancel_batches(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    operation_id: &str,
    targets: &[InstrumentOperationTarget],
) -> Result<(), String> {
    for chunk in targets.chunks(ORDINARY_CANCEL_BATCH_SIZE) {
        let bodies = chunk
            .iter()
            .map(|target| BatchCancelOrderBody {
                inst_id: target.inst_id.clone(),
                ord_id: target.ord_id.clone(),
                cl_ord_id: target.cl_ord_id.clone(),
            })
            .collect::<Vec<_>>();
        for target in chunk {
            set_target_state::<serde_json::Value>(
                app,
                operation_id,
                &target.key,
                "submitting",
                None,
                None,
                None,
            )?;
        }
        match okx_private_post::<OkxOrderResult, _>(
            account,
            "/api/v5/trade/cancel-batch-orders",
            &bodies,
        )
        .await
        {
            Ok(envelope) => {
                if !ordinary_batch_response_is_exact(&envelope.data, chunk) {
                    for target in chunk {
                        set_target_state::<serde_json::Value>(
                            app,
                            operation_id,
                            &target.key,
                            "unknown",
                            None,
                            None,
                            Some("OKX 批量撤单响应未与请求目标形成严格一一身份匹配，必须只读对账"),
                        )?;
                    }
                    continue;
                }
                for target in chunk {
                    let Some(result) = ordinary_result_for_target(&envelope.data, target) else {
                        set_target_state::<serde_json::Value>(
                            app,
                            operation_id,
                            &target.key,
                            "unknown",
                            None,
                            None,
                            Some("OKX 批量撤单响应缺少对应目标"),
                        )?;
                        continue;
                    };
                    let state = if result.s_code == "0" {
                        "reconciling"
                    } else {
                        "rejected"
                    };
                    set_target_state(
                        app,
                        operation_id,
                        &target.key,
                        state,
                        None,
                        Some(result),
                        (result.s_code != "0").then_some(result.s_msg.as_str()),
                    )?;
                }
            }
            Err(error) => {
                for target in chunk {
                    set_target_state::<serde_json::Value>(
                        app,
                        operation_id,
                        &target.key,
                        "unknown",
                        None,
                        None,
                        Some(&error),
                    )?;
                }
            }
        }
    }
    Ok(())
}

async fn submit_algo_cancel_batches(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    operation_id: &str,
    targets: &[InstrumentOperationTarget],
) -> Result<(), String> {
    for chunk in targets.chunks(ALGO_CANCEL_BATCH_SIZE) {
        let bodies = chunk
            .iter()
            .map(|target| BatchCancelAlgoBody {
                inst_id: target.inst_id.clone(),
                algo_id: target.algo_id.clone(),
                algo_cl_ord_id: target.algo_cl_ord_id.clone(),
            })
            .collect::<Vec<_>>();
        for target in chunk {
            set_target_state::<serde_json::Value>(
                app,
                operation_id,
                &target.key,
                "submitting",
                None,
                None,
                None,
            )?;
        }
        match okx_private_post::<OkxAlgoOrderResult, _>(
            account,
            "/api/v5/trade/cancel-algos",
            &bodies,
        )
        .await
        {
            Ok(envelope) => {
                if !algo_batch_response_is_exact(&envelope.data, chunk) {
                    for target in chunk {
                        set_target_state::<serde_json::Value>(
                            app,
                            operation_id,
                            &target.key,
                            "unknown",
                            None,
                            None,
                            Some(
                                "OKX 批量撤销策略单响应未与请求目标形成严格一一身份匹配，必须只读对账",
                            ),
                        )?;
                    }
                    continue;
                }
                for target in chunk {
                    let Some(result) = algo_result_for_target(&envelope.data, target) else {
                        set_target_state::<serde_json::Value>(
                            app,
                            operation_id,
                            &target.key,
                            "unknown",
                            None,
                            None,
                            Some("OKX 批量撤销策略单响应缺少对应目标"),
                        )?;
                        continue;
                    };
                    let state = if result.s_code == "0" {
                        "reconciling"
                    } else {
                        "rejected"
                    };
                    set_target_state(
                        app,
                        operation_id,
                        &target.key,
                        state,
                        None,
                        Some(result),
                        (result.s_code != "0").then_some(result.s_msg.as_str()),
                    )?;
                }
            }
            Err(error) => {
                for target in chunk {
                    set_target_state::<serde_json::Value>(
                        app,
                        operation_id,
                        &target.key,
                        "unknown",
                        None,
                        None,
                        Some(&error),
                    )?;
                }
            }
        }
    }
    Ok(())
}

async fn reconcile_cancel_target(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    operation_id: &str,
    target: &InstrumentOperationTargetView,
    final_attempt: bool,
) -> Result<(), String> {
    if !matches!(
        target.state.as_str(),
        "accepted" | "reconciling" | "unknown"
    ) {
        return Ok(());
    }
    let is_algo = target.target.target_type == "algo_order";
    let mut path = if is_algo {
        format!(
            "/api/v5/trade/order-algo?instId={}",
            url_encode(&target.target.inst_id)
        )
    } else {
        format!(
            "/api/v5/trade/order?instId={}",
            url_encode(&target.target.inst_id)
        )
    };
    if let Some(value) = if is_algo {
        target.target.algo_id.as_deref()
    } else {
        target.target.ord_id.as_deref()
    } {
        path.push_str(if is_algo { "&algoId=" } else { "&ordId=" });
        path.push_str(&url_encode(value));
    } else if let Some(value) = if is_algo {
        target.target.algo_cl_ord_id.as_deref()
    } else {
        target.target.cl_ord_id.as_deref()
    } {
        path.push_str(if is_algo {
            "&algoClOrdId="
        } else {
            "&clOrdId="
        });
        path.push_str(&url_encode(value));
    }

    if is_algo {
        match okx_private_get::<OkxAlgoPendingOrder>(account, &path).await {
            Ok(envelope) => {
                if let Some(order) =
                    algo_pending_order_for_target(&envelope.data, &target.target).cloned()
                {
                    let state = order.state.to_ascii_lowercase();
                    let next =
                        if matches!(state.as_str(), "canceled" | "cancelled" | "order_failed") {
                            "confirmed"
                        } else if state == "effective" {
                            "filled_before_cancel"
                        } else if final_attempt {
                            "still_live"
                        } else {
                            "reconciling"
                        };
                    set_target_state(
                        app,
                        operation_id,
                        &target.target.key,
                        next,
                        target.execution_key.as_deref(),
                        Some(&order),
                        (next == "still_live").then_some("策略单仍处于活动状态"),
                    )?;
                } else if final_attempt {
                    set_target_state::<serde_json::Value>(
                        app,
                        operation_id,
                        &target.target.key,
                        "unknown",
                        target.execution_key.as_deref(),
                        None,
                        Some("策略单查询未返回唯一且作用域、全部身份均匹配的目标，无法确认终态"),
                    )?;
                }
            }
            Err(error) if confirmed_missing_order_error(&error) => {
                set_target_state::<serde_json::Value>(
                    app,
                    operation_id,
                    &target.target.key,
                    "confirmed",
                    target.execution_key.as_deref(),
                    None,
                    None,
                )?;
            }
            Err(error) if final_attempt => {
                set_target_state::<serde_json::Value>(
                    app,
                    operation_id,
                    &target.target.key,
                    "unknown",
                    target.execution_key.as_deref(),
                    None,
                    Some(&error),
                )?;
            }
            Err(_) => {}
        }
    } else {
        match okx_private_get::<OkxPendingOrder>(account, &path).await {
            Ok(envelope) => {
                if let Some(order) =
                    ordinary_pending_order_for_target(&envelope.data, &target.target).cloned()
                {
                    let state = order.state.to_ascii_lowercase();
                    let next = if matches!(
                        state.as_str(),
                        "canceled" | "cancelled" | "failed" | "rejected" | "mmp_canceled"
                    ) {
                        "confirmed"
                    } else if state == "filled" {
                        "filled_before_cancel"
                    } else if final_attempt {
                        "still_live"
                    } else {
                        "reconciling"
                    };
                    set_target_state(
                        app,
                        operation_id,
                        &target.target.key,
                        next,
                        target.execution_key.as_deref(),
                        Some(&order),
                        (next == "still_live").then_some("普通委托仍处于活动状态"),
                    )?;
                } else if final_attempt {
                    set_target_state::<serde_json::Value>(
                        app,
                        operation_id,
                        &target.target.key,
                        "unknown",
                        target.execution_key.as_deref(),
                        None,
                        Some("普通委托查询未返回唯一且作用域、全部身份均匹配的目标，无法确认终态"),
                    )?;
                }
            }
            Err(error) if confirmed_missing_order_error(&error) => {
                set_target_state::<serde_json::Value>(
                    app,
                    operation_id,
                    &target.target.key,
                    "confirmed",
                    target.execution_key.as_deref(),
                    None,
                    None,
                )?;
            }
            Err(error) if final_attempt => {
                set_target_state::<serde_json::Value>(
                    app,
                    operation_id,
                    &target.target.key,
                    "unknown",
                    target.execution_key.as_deref(),
                    None,
                    Some(&error),
                )?;
            }
            Err(_) => {}
        }
    }
    Ok(())
}

async fn reconcile_cancel_operation(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    operation_id: &str,
) -> Result<InstrumentOperationView, String> {
    let initial_view =
        load_operation_view(app, operation_id)?.ok_or_else(|| "紧急撤单操作不存在".to_string())?;
    if !initial_view.targets.is_empty() {
        for (index, delay_ms) in [200_u64, 500, 1_000].into_iter().enumerate() {
            sleep(Duration::from_millis(delay_ms)).await;
            let view = load_operation_view(app, operation_id)?
                .ok_or_else(|| "紧急撤单操作不存在".to_string())?;
            let final_attempt = index == 2;
            for target in &view.targets {
                reconcile_cancel_target(app, account, operation_id, target, final_attempt).await?;
            }
        }
    }
    let view =
        load_operation_view(app, operation_id)?.ok_or_else(|| "紧急撤单操作不存在".to_string())?;
    let active_targets = match strict_cancel_targets(account, &view.inst_id).await {
        Ok((targets, _)) => targets,
        Err(error) => {
            return mark_operation_recovery_error(
                app,
                operation_id,
                &format!("最终严格重扫当前合约活动委托失败：{error}"),
            );
        }
    };
    upsert_residual_targets(
        app,
        operation_id,
        &active_targets,
        "最终严格重扫仍发现当前合约活动委托（包括操作期间新增委托）",
    )?;
    refresh_operation_summary(app, operation_id)
}

#[tauri::command]
pub(crate) async fn okx_execute_cancel_instrument_orders(
    app: tauri::AppHandle,
    request: ExecuteInstrumentOperationRequest,
) -> Result<InstrumentOperationView, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    let scope = InstrumentOperationScope {
        account_id: Some(account.id.clone()),
        environment: request.environment.clone(),
        inst_id: request.inst_id.clone(),
    };
    validate_scope(&account, &scope)?;
    validate_execute_confirmation(&account, &request)?;
    let _operation_guard = TRADE_MUTATION_LOCK.lock().await;
    if let Some(existing) = load_operation_view(&app, request.operation_id.trim())? {
        validate_operation_credential(&app, &existing.operation_id, &account)?;
        return validate_existing_operation(existing, &request, &account.id, "cancel_orders");
    }
    ensure_no_other_unresolved_operation_kind(
        &app,
        &account,
        &request.inst_id,
        "cancel_orders",
        request.operation_id.trim(),
    )?;
    ensure_trade_account(&account, &request.environment).await?;
    let preview = validate_preview_for_execute(&app, &account, &request, "cancel_orders").await?;
    let (initial, inserted) = persist_operation_before_submit(&app, &request, &preview)?;
    if !inserted {
        return validate_existing_operation(initial, &request, &account.id, "cancel_orders");
    }
    audit_operation_view(&app, &account, &initial, "submitting");
    let ordinary = preview
        .targets
        .iter()
        .filter(|target| target.target_type == "ordinary_order")
        .cloned()
        .collect::<Vec<_>>();
    let algo = preview
        .targets
        .iter()
        .filter(|target| target.target_type == "algo_order")
        .cloned()
        .collect::<Vec<_>>();
    if let Err(error) =
        submit_ordinary_cancel_batches(&app, &account, &request.operation_id, &ordinary).await
    {
        let recovery = record_interrupted_submission(&app, &request.operation_id, &error);
        return Err(match recovery {
            Ok(_) => error,
            Err(recovery_error) => format!("{error}；提交中断状态落库失败：{recovery_error}"),
        });
    }
    if let Err(error) =
        submit_algo_cancel_batches(&app, &account, &request.operation_id, &algo).await
    {
        let recovery = record_interrupted_submission(&app, &request.operation_id, &error);
        return Err(match recovery {
            Ok(_) => error,
            Err(recovery_error) => format!("{error}；提交中断状态落库失败：{recovery_error}"),
        });
    }
    reconcile_cancel_operation(&app, &account, &request.operation_id).await
}

fn stable_operation_client_order_id(execution_key: &str) -> String {
    let digest = Sha256::digest(execution_key.as_bytes());
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("dt{}", hex.get(..28).unwrap_or(&hex))
}

fn validate_close_position_response_scope(
    body: &EmergencyClosePositionBody,
    response: &EmergencyClosePositionResult,
) -> Result<(), String> {
    let matches_if_present = |actual: &str, expected: &str| actual.is_empty() || actual == expected;
    if response.cl_ord_id != body.cl_ord_id
        || !matches_if_present(&response.inst_id, &body.inst_id)
        || !matches_if_present(&response.pos_side, &body.pos_side)
        || !matches_if_present(&response.client_marker, &body.client_marker)
    {
        return Err("OKX 全平接口响应作用域与请求不一致，结果无法确认".to_string());
    }
    Ok(())
}

async fn fallback_close_position(
    account: &LocalAccount,
    target: &InstrumentOperationTarget,
    execution_key: &str,
) -> Result<EmergencyClosePositionResult, String> {
    let mgn_mode = target
        .mgn_mode
        .clone()
        .ok_or_else(|| "紧急全平目标缺少 mgnMode，已阻止 fallback 请求".to_string())?;
    let pos_side = target
        .pos_side
        .clone()
        .ok_or_else(|| "紧急全平目标缺少 posSide，已阻止 fallback 请求".to_string())?;
    let body = EmergencyClosePositionBody {
        inst_id: target.inst_id.clone(),
        mgn_mode,
        pos_side,
        auto_cxl: false,
        cl_ord_id: stable_operation_client_order_id(execution_key),
        client_marker: exchange_client_marker(),
    };
    let envelope = okx_private_post::<EmergencyClosePositionResult, _>(
        account,
        "/api/v5/trade/close-position",
        &body,
    )
    .await?;
    let response = envelope
        .data
        .into_iter()
        .next()
        .ok_or_else(|| "OKX 全平接口返回为空，结果无法确认".to_string())?;
    validate_close_position_response_scope(&body, &response)?;
    Ok(response)
}

async fn submit_flatten_targets(
    app: &tauri::AppHandle,
    runtime: tauri::State<'_, MarketRuntime>,
    account: &LocalAccount,
    request: &ExecuteInstrumentOperationRequest,
    targets: &[InstrumentOperationTarget],
) -> Result<(), String> {
    for target in targets {
        let mgn_mode = target
            .mgn_mode
            .clone()
            .ok_or_else(|| "紧急全平目标缺少 mgnMode，已阻止下单".to_string())?;
        let size = target
            .size
            .clone()
            .ok_or_else(|| "紧急全平目标缺少精确持仓数量，已阻止下单".to_string())?;
        let action = match target.side.as_deref() {
            Some("buy") => "close-short",
            Some("sell") => "close-long",
            _ => return Err("紧急全平目标缺少有效平仓方向，已阻止下单".to_string()),
        };
        let execution_key = format!(
            "instrument-op:{}:flatten:{}",
            request.operation_id, target.key
        );
        set_target_state::<serde_json::Value>(
            app,
            &request.operation_id,
            &target.key,
            "submitting",
            Some(&execution_key),
            None,
            None,
        )?;
        let place_request = PlaceOrderRequest {
            account_id: Some(account.id.clone()),
            inst_id: target.inst_id.clone(),
            td_mode: mgn_mode,
            order_type: "market".to_string(),
            ticket_mode: "close".to_string(),
            action: action.to_string(),
            price: target.mark_px.clone().unwrap_or_else(|| "0".to_string()),
            size,
            lever: target.lever.clone().unwrap_or_else(|| "1".to_string()),
            environment: account.environment.clone(),
            confirmed_live: request.confirmed_live,
            operator: Some("user".to_string()),
            strategy_id: None,
            session_id: None,
            opportunity_id: None,
            opportunity_revision: None,
            agent_run_id: None,
            execution_key: Some(execution_key.clone()),
            algo_cl_ord_id: None,
            execution_leg: Some(target.key.clone()),
            reason: Some("用户确认市价全平当前合约".to_string()),
            attach_algo_ords: None,
            order_spec_v2: None,
        };
        match crate::trade_commands::okx_place_order(app.clone(), runtime.clone(), place_request)
            .await
        {
            Ok(response) => {
                set_target_state(
                    app,
                    &request.operation_id,
                    &target.key,
                    "reconciling",
                    Some(&execution_key),
                    Some(&response),
                    None,
                )?;
            }
            Err(error) if crate::trade_commands::should_fallback_close_position(&error) => {
                let fallback_lease = crate::trade_commands::claim_fallback_close_execution(
                    app,
                    account,
                    &execution_key,
                )?;
                match fallback_close_position(account, target, &execution_key).await {
                    Ok(response) => {
                        crate::trade_commands::finish_fallback_close_execution(
                            app,
                            &fallback_lease,
                            &response,
                        )?;
                        set_target_state(
                            app,
                            &request.operation_id,
                            &target.key,
                            "reconciling",
                            Some(&execution_key),
                            Some(&response),
                            None,
                        )?;
                    }
                    Err(fallback_error) => {
                        crate::trade_commands::finish_fallback_close_execution_unknown(
                            app,
                            &fallback_lease,
                            &fallback_error,
                        )?;
                        set_target_state::<serde_json::Value>(
                            app,
                            &request.operation_id,
                            &target.key,
                            "unknown",
                            Some(&execution_key),
                            None,
                            Some(&format!(
                                "reduce-only 平仓被明确拒绝，autoCxl=false 全平结果不明确：{fallback_error}"
                            )),
                        )?;
                    }
                }
            }
            Err(error) => {
                set_target_state::<serde_json::Value>(
                    app,
                    &request.operation_id,
                    &target.key,
                    "unknown",
                    Some(&execution_key),
                    None,
                    Some(&error),
                )?;
            }
        }
    }
    Ok(())
}

async fn reconcile_flatten_operation(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    operation_id: &str,
) -> Result<InstrumentOperationView, String> {
    let initial_view =
        load_operation_view(app, operation_id)?.ok_or_else(|| "紧急全平操作不存在".to_string())?;
    let delays: &[u64] = if initial_view.targets.is_empty() {
        &[0]
    } else {
        &[250, 750, 1_500]
    };
    for (index, delay_ms) in delays.iter().copied().enumerate() {
        sleep(Duration::from_millis(delay_ms)).await;
        let view = load_operation_view(app, operation_id)?
            .ok_or_else(|| "紧急全平操作不存在".to_string())?;
        let current = strict_position_targets(account, &view.inst_id).await;
        let current = match current {
            Ok(value) => value,
            Err(error) if index + 1 == delays.len() => {
                return mark_operation_recovery_error(
                    app,
                    operation_id,
                    &format!("最终严格重扫当前合约持仓失败：{error}"),
                );
            }
            Err(_) => continue,
        };
        let current_keys = current
            .iter()
            .map(|target| target.key.as_str())
            .collect::<HashSet<_>>();
        let final_attempt = index + 1 == delays.len();
        for target in &view.targets {
            if !matches!(
                target.state.as_str(),
                "accepted" | "reconciling" | "unknown" | "submitting"
            ) {
                continue;
            }
            if !current_keys.contains(target.target.key.as_str()) {
                set_target_state::<serde_json::Value>(
                    app,
                    operation_id,
                    &target.target.key,
                    "flat",
                    target.execution_key.as_deref(),
                    None,
                    None,
                )?;
            }
        }
        if final_attempt {
            upsert_residual_targets(
                app,
                operation_id,
                &current,
                "最终严格重扫仍发现当前合约持仓（包括操作期间新增仓位）",
            )?;
            return refresh_operation_summary(app, operation_id);
        }
    }
    refresh_operation_summary(app, operation_id)
}

#[tauri::command]
pub(crate) async fn okx_execute_flatten_instrument_positions(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, MarketRuntime>,
    request: ExecuteInstrumentOperationRequest,
) -> Result<InstrumentOperationView, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    let scope = InstrumentOperationScope {
        account_id: Some(account.id.clone()),
        environment: request.environment.clone(),
        inst_id: request.inst_id.clone(),
    };
    validate_scope(&account, &scope)?;
    validate_execute_confirmation(&account, &request)?;
    let _operation_guard = TRADE_MUTATION_LOCK.lock().await;
    if let Some(existing) = load_operation_view(&app, request.operation_id.trim())? {
        validate_operation_credential(&app, &existing.operation_id, &account)?;
        return validate_existing_operation(existing, &request, &account.id, "flatten_positions");
    }
    ensure_no_other_unresolved_operation_kind(
        &app,
        &account,
        &request.inst_id,
        "flatten_positions",
        request.operation_id.trim(),
    )?;
    ensure_trade_account(&account, &request.environment).await?;
    let preview =
        validate_preview_for_execute(&app, &account, &request, "flatten_positions").await?;
    let (initial, inserted) = persist_operation_before_submit(&app, &request, &preview)?;
    if !inserted {
        return validate_existing_operation(initial, &request, &account.id, "flatten_positions");
    }
    audit_operation_view(&app, &account, &initial, "submitting");
    if let Err(error) =
        submit_flatten_targets(&app, runtime, &account, &request, &preview.targets).await
    {
        let recovery = record_interrupted_submission(&app, &request.operation_id, &error);
        return Err(match recovery {
            Ok(_) => error,
            Err(recovery_error) => format!("{error}；提交中断状态落库失败：{recovery_error}"),
        });
    }
    reconcile_flatten_operation(&app, &account, &request.operation_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn demo_account_for_fingerprint() -> LocalAccount {
        LocalAccount {
            id: "account-demo".to_string(),
            name: "Demo".to_string(),
            exchange: "okx".to_string(),
            environment: "demo".to_string(),
            okx_uid: "placeholder-uid".to_string(),
            okx_main_uid: "placeholder-main-uid".to_string(),
            api_key: "placeholder-api-key".to_string(),
            secret_key: "placeholder-secret-key".to_string(),
            passphrase: "placeholder-passphrase".to_string(),
            permissions: Permissions {
                read: true,
                trade: true,
                withdraw: false,
            },
        }
    }

    #[test]
    fn operation_credentials_reject_blank_or_rotated_fingerprints() {
        let account = demo_account_for_fingerprint();
        let fingerprint = account_config_cache_fingerprint(&account);
        assert!(stored_credential_matches(&fingerprint, &account));
        assert!(!stored_credential_matches("", &account));

        let mut rotated = account.clone();
        rotated.passphrase = "placeholder-rotated-passphrase".to_string();
        assert!(!stored_credential_matches(&fingerprint, &rotated));
    }

    #[test]
    fn active_operation_kind_scope_is_rechecked_inside_the_write_transaction() {
        let mut conn = Connection::open_in_memory().expect("open operation scope database");
        migrate_instrument_operations(&conn).expect("migrate operation scope database");
        let transaction = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .expect("begin operation scope claim");
        transaction
            .execute(
                "INSERT INTO instrument_operations (
                   operation_id,preview_id,operation_kind,account_id,environment,inst_id,
                   credential_fingerprint,phase,counts_json,request_json,created_at,updated_at
                 ) VALUES ('operation-active','preview-active','cancel_orders','account-demo','demo',
                           'BTC-USDT-SWAP','placeholder-fingerprint','submitting','{}','{}',1,1)",
                [],
            )
            .expect("insert active operation");

        assert_eq!(
            active_operation_kind_conflict_with_conn(
                &transaction,
                "account-demo",
                "demo",
                "BTC-USDT-SWAP",
                "cancel_orders",
                "operation-competing",
            )
            .expect("query competing operation")
            .as_deref(),
            Some("operation-active")
        );
        assert!(active_operation_kind_conflict_with_conn(
            &transaction,
            "account-demo",
            "demo",
            "BTC-USDT-SWAP",
            "flatten_positions",
            "operation-other-channel",
        )
        .expect("query independent risk-reduction channel")
        .is_none());
        assert!(active_operation_kind_conflict_with_conn(
            &transaction,
            "account-demo",
            "demo",
            "BTC-USDT-SWAP",
            "cancel_orders",
            "operation-active",
        )
        .expect("query idempotent operation id")
        .is_none());

        transaction
            .execute(
                "UPDATE instrument_operations SET phase='terminal' WHERE operation_id='operation-active'",
                [],
            )
            .expect("finish active operation");
        assert!(active_operation_kind_conflict_with_conn(
            &transaction,
            "account-demo",
            "demo",
            "BTC-USDT-SWAP",
            "cancel_orders",
            "operation-next",
        )
        .expect("query terminal operation scope")
        .is_none());
        transaction.commit().expect("commit operation scope test");
    }

    fn position_target_for_fingerprint(mark_px: &str, lever: &str) -> InstrumentOperationTarget {
        InstrumentOperationTarget {
            key: "position:pos-1".to_string(),
            target_type: "position".to_string(),
            inst_id: "BTC-USDT-SWAP".to_string(),
            pos_id: Some("pos-1".to_string()),
            mgn_mode: Some("cross".to_string()),
            pos_side: Some("long".to_string()),
            side: Some("sell".to_string()),
            size: Some("2".to_string()),
            signed_size: Some("2".to_string()),
            mark_px: Some(mark_px.to_string()),
            lever: Some(lever.to_string()),
            ..Default::default()
        }
    }

    fn target_view(state: &str) -> InstrumentOperationTargetView {
        InstrumentOperationTargetView {
            target: InstrumentOperationTarget::default(),
            state: state.to_string(),
            execution_key: None,
            response: None,
            error: None,
            updated_at: 1,
        }
    }

    fn operation_view(preview_id: &str, account_id: &str) -> InstrumentOperationView {
        InstrumentOperationView {
            operation_id: "op-1".to_string(),
            preview_id: preview_id.to_string(),
            operation_kind: "cancel_orders".to_string(),
            account_id: account_id.to_string(),
            environment: "demo".to_string(),
            inst_id: "BTC-USDT-SWAP".to_string(),
            phase: "submitting".to_string(),
            outcome: None,
            counts: InstrumentOperationCounts::default(),
            targets: vec![],
            error: None,
            created_at: 1,
            updated_at: 1,
            completed_at: None,
        }
    }

    fn execute_request(preview_id: &str) -> ExecuteInstrumentOperationRequest {
        ExecuteInstrumentOperationRequest {
            operation_id: "op-1".to_string(),
            preview_id: preview_id.to_string(),
            account_id: None,
            environment: "demo".to_string(),
            inst_id: "BTC-USDT-SWAP".to_string(),
            confirmed: true,
            confirmed_live: None,
        }
    }

    fn query_request(inst_id: &str) -> InstrumentOperationQuery {
        InstrumentOperationQuery {
            operation_id: "op-1".to_string(),
            account_id: None,
            environment: "demo".to_string(),
            inst_id: inst_id.to_string(),
            expected_kind: Some("cancel_orders".to_string()),
        }
    }

    #[test]
    fn flatten_fingerprint_ignores_mark_price_and_leverage() {
        let first = fingerprint_targets(
            "flatten_positions",
            "account-1",
            "demo",
            "BTC-USDT-SWAP",
            &[position_target_for_fingerprint("65000", "10")],
        )
        .unwrap();
        let second = fingerprint_targets(
            "flatten_positions",
            "account-1",
            "demo",
            "BTC-USDT-SWAP",
            &[position_target_for_fingerprint("65123.4", "20")],
        )
        .unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn filled_before_cancel_is_failed_and_unknown_prevents_partial_terminal() {
        let (counts, phase, outcome, completed_at) = summarize_operation_targets(
            InstrumentOperationCounts::default(),
            &[
                target_view("confirmed"),
                target_view("filled_before_cancel"),
            ],
            100,
        );
        assert_eq!(counts.confirmed, 1);
        assert_eq!(counts.failed, 1);
        assert_eq!(counts.filled_before_cancel, 1);
        assert_eq!(phase, "terminal");
        assert_eq!(outcome, Some("partial"));
        assert_eq!(completed_at, Some(100));

        let (_, phase, outcome, completed_at) = summarize_operation_targets(
            InstrumentOperationCounts::default(),
            &[target_view("confirmed"), target_view("unknown")],
            100,
        );
        assert_eq!(phase, "unknown");
        assert_eq!(outcome, Some("unknown"));
        assert_eq!(completed_at, None);

        let (_, phase, outcome, completed_at) = summarize_operation_targets(
            InstrumentOperationCounts::default(),
            &[target_view("confirmed"), target_view("reconciling")],
            100,
        );
        assert_eq!(phase, "reconciling");
        assert_eq!(outcome, None);
        assert_eq!(completed_at, None);
    }

    #[test]
    fn existing_operation_requires_resolved_account_and_preview_scope() {
        let request = execute_request("preview-1");
        assert!(validate_existing_operation(
            operation_view("preview-1", "account-1"),
            &request,
            "account-1",
            "cancel_orders",
        )
        .is_ok());
        assert!(validate_existing_operation(
            operation_view("preview-1", "account-2"),
            &request,
            "account-1",
            "cancel_orders",
        )
        .is_err());
        assert!(validate_existing_operation(
            operation_view("preview-2", "account-1"),
            &request,
            "account-1",
            "cancel_orders",
        )
        .is_err());
    }

    #[test]
    fn operation_query_is_bound_before_return_or_reconciliation() {
        let view = operation_view("preview-1", "account-1");
        assert!(validate_operation_query_scope(
            &view,
            "account-1",
            "demo",
            &query_request("BTC-USDT-SWAP"),
        )
        .is_ok());
        assert!(validate_operation_query_scope(
            &view,
            "account-2",
            "demo",
            &query_request("BTC-USDT-SWAP"),
        )
        .is_err());
        assert!(validate_operation_query_scope(
            &view,
            "account-1",
            "demo",
            &query_request("ETH-USDT-SWAP"),
        )
        .is_err());
    }

    #[test]
    fn cancel_scope_rejects_cross_instrument_rows() {
        let ordinary = vec![OkxPendingOrder {
            inst_id: "ETH-USDT-SWAP".to_string(),
            ..Default::default()
        }];
        assert!(validate_cancel_response_scope("BTC-USDT-SWAP", &ordinary, &[]).is_err());

        let algo = vec![OkxAlgoPendingOrder {
            inst_id: "ETH-USDT-SWAP".to_string(),
            ..Default::default()
        }];
        assert!(validate_cancel_response_scope("BTC-USDT-SWAP", &[], &[&algo]).is_err());
    }

    #[test]
    fn strict_snapshots_reject_active_orders_without_cancel_identity() {
        assert!(ordinary_target(OkxPendingOrder {
            inst_id: "BTC-USDT-SWAP".to_string(),
            state: "live".to_string(),
            ..Default::default()
        })
        .is_err());
        assert!(algo_target(OkxAlgoPendingOrder {
            inst_id: "BTC-USDT-SWAP".to_string(),
            state: "live".to_string(),
            ..Default::default()
        })
        .is_err());
        assert!(ordinary_target(OkxPendingOrder {
            inst_id: "BTC-USDT-SWAP".to_string(),
            state: "filled".to_string(),
            ..Default::default()
        })
        .unwrap()
        .is_none());
    }

    #[test]
    fn flatten_preview_keeps_valid_positions_when_order_read_fails() {
        let positions = [position_target_for_fingerprint("65000", "10")];
        let (counts, warnings) = flatten_preview_counts_and_warnings(
            positions.len(),
            Err("严格读取普通委托失败：temporary read error".to_string()),
        );

        assert_eq!(counts.positions, 1);
        assert_eq!(counts.planned, 1);
        assert_eq!(counts.ordinary, 0);
        assert_eq!(counts.trigger, 0);
        assert!(warnings.iter().any(|warning| warning.contains("数量未知")));
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("不阻断仅基于持仓的全平")));
    }

    #[test]
    fn flatten_preview_treats_cancel_fetch_limit_as_advisory_but_cancel_stays_strict() {
        assert!(validate_strict_cancel_fetch_counts([STRICT_FETCH_LIMIT - 1, 0, 0, 0]).is_ok());
        let strict_limit = validate_strict_cancel_fetch_counts([STRICT_FETCH_LIMIT, 0, 0, 0]);
        assert!(strict_limit.is_err());

        let positions = [position_target_for_fingerprint("65000", "10")];
        let (counts, warnings) = flatten_preview_counts_and_warnings(
            positions.len(),
            strict_limit.map(|_| InstrumentOperationCounts::default()),
        );
        assert_eq!(counts.positions, 1);
        assert_eq!(counts.planned, 1);
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("STRICT_SCOPE_TOO_LARGE")));
    }

    #[test]
    fn strict_position_target_preserves_exact_decimal_and_requires_metadata() {
        let target = position_target(OkxPosition {
            inst_id: "BTC-USDT-SWAP".to_string(),
            mgn_mode: "cross".to_string(),
            pos_side: "net".to_string(),
            pos: "-0.0000000000000000000000000001".to_string(),
            pos_id: "position-1".to_string(),
            ..Default::default()
        })
        .unwrap()
        .unwrap();
        assert_eq!(
            target.signed_size.as_deref(),
            Some("-0.0000000000000000000000000001")
        );
        assert_eq!(
            target.size.as_deref(),
            Some("0.0000000000000000000000000001")
        );
        assert_eq!(target.side.as_deref(), Some("buy"));

        for invalid in [
            OkxPosition {
                pos: "not-a-decimal".to_string(),
                mgn_mode: "cross".to_string(),
                pos_side: "net".to_string(),
                ..Default::default()
            },
            OkxPosition {
                pos: "1".to_string(),
                pos_side: "net".to_string(),
                ..Default::default()
            },
            OkxPosition {
                pos: "1".to_string(),
                mgn_mode: "cross".to_string(),
                ..Default::default()
            },
            OkxPosition {
                pos: "-1".to_string(),
                mgn_mode: "cross".to_string(),
                pos_side: "long".to_string(),
                ..Default::default()
            },
        ] {
            assert!(position_target(invalid).is_err());
        }
    }

    #[test]
    fn cancel_batch_results_match_exact_identity_even_when_reordered() {
        let ordinary_target = InstrumentOperationTarget {
            ord_id: Some("ord-1".to_string()),
            cl_ord_id: Some("client-1".to_string()),
            ..Default::default()
        };
        let ordinary_results = vec![
            OkxOrderResult {
                ord_id: "ord-2".to_string(),
                cl_ord_id: "client-2".to_string(),
                ..Default::default()
            },
            OkxOrderResult {
                ord_id: "ord-1".to_string(),
                cl_ord_id: "client-1".to_string(),
                ..Default::default()
            },
        ];
        assert_eq!(
            ordinary_result_for_target(&ordinary_results, &ordinary_target)
                .map(|result| result.ord_id.as_str()),
            Some("ord-1")
        );
        assert!(ordinary_batch_response_is_exact(
            &ordinary_results,
            &[
                InstrumentOperationTarget {
                    ord_id: Some("ord-1".to_string()),
                    cl_ord_id: Some("client-1".to_string()),
                    ..Default::default()
                },
                InstrumentOperationTarget {
                    ord_id: Some("ord-2".to_string()),
                    cl_ord_id: Some("client-2".to_string()),
                    ..Default::default()
                },
            ],
        ));
        assert!(ordinary_result_for_target(
            &ordinary_results,
            &InstrumentOperationTarget {
                ord_id: Some("ord-1".to_string()),
                cl_ord_id: Some("wrong-client".to_string()),
                ..Default::default()
            },
        )
        .is_none());
        assert!(ordinary_result_for_target(
            &ordinary_results,
            &InstrumentOperationTarget {
                ord_id: Some("ord-missing".to_string()),
                ..Default::default()
            },
        )
        .is_none());

        let algo_target = InstrumentOperationTarget {
            algo_id: Some("algo-1".to_string()),
            algo_cl_ord_id: Some("algo-client-1".to_string()),
            ..Default::default()
        };
        let algo_results = vec![
            OkxAlgoOrderResult {
                algo_id: "algo-2".to_string(),
                algo_cl_ord_id: "algo-client-2".to_string(),
                ..Default::default()
            },
            OkxAlgoOrderResult {
                algo_id: "algo-1".to_string(),
                algo_cl_ord_id: "algo-client-1".to_string(),
                ..Default::default()
            },
        ];
        assert_eq!(
            algo_result_for_target(&algo_results, &algo_target)
                .map(|result| result.algo_id.as_str()),
            Some("algo-1")
        );
        assert!(algo_batch_response_is_exact(
            &algo_results,
            &[
                InstrumentOperationTarget {
                    algo_id: Some("algo-1".to_string()),
                    algo_cl_ord_id: Some("algo-client-1".to_string()),
                    ..Default::default()
                },
                InstrumentOperationTarget {
                    algo_id: Some("algo-2".to_string()),
                    algo_cl_ord_id: Some("algo-client-2".to_string()),
                    ..Default::default()
                },
            ],
        ));
        assert!(algo_result_for_target(
            &algo_results,
            &InstrumentOperationTarget {
                algo_id: Some("algo-1".to_string()),
                algo_cl_ord_id: Some("wrong-client".to_string()),
                ..Default::default()
            },
        )
        .is_none());
        assert!(algo_result_for_target(
            &algo_results,
            &InstrumentOperationTarget {
                algo_id: Some("algo-missing".to_string()),
                ..Default::default()
            },
        )
        .is_none());
    }

    #[test]
    fn cancel_get_reconciliation_selects_unique_full_scope_identity() {
        let target = InstrumentOperationTarget {
            inst_id: "BTC-USDT-SWAP".to_string(),
            ord_id: Some("ord-1".to_string()),
            cl_ord_id: Some("client-1".to_string()),
            algo_id: Some("algo-1".to_string()),
            algo_cl_ord_id: Some("algo-client-1".to_string()),
            ..Default::default()
        };
        let ordinary = vec![
            OkxPendingOrder {
                inst_id: "ETH-USDT-SWAP".to_string(),
                ord_id: "ord-1".to_string(),
                cl_ord_id: "client-1".to_string(),
                ..Default::default()
            },
            OkxPendingOrder {
                inst_id: target.inst_id.clone(),
                ord_id: "ord-1".to_string(),
                cl_ord_id: "client-1".to_string(),
                ..Default::default()
            },
        ];
        assert_eq!(
            ordinary_pending_order_for_target(&ordinary, &target)
                .map(|order| order.inst_id.as_str()),
            Some("BTC-USDT-SWAP")
        );

        let algo = vec![
            OkxAlgoPendingOrder {
                inst_id: target.inst_id.clone(),
                algo_id: "algo-1".to_string(),
                algo_cl_ord_id: "wrong-client".to_string(),
                ..Default::default()
            },
            OkxAlgoPendingOrder {
                inst_id: target.inst_id.clone(),
                algo_id: "algo-1".to_string(),
                algo_cl_ord_id: "algo-client-1".to_string(),
                ..Default::default()
            },
        ];
        assert_eq!(
            algo_pending_order_for_target(&algo, &target)
                .map(|order| order.algo_cl_ord_id.as_str()),
            Some("algo-client-1")
        );
    }

    #[test]
    fn final_scope_scan_inserts_new_residual_and_overrides_unknown_target() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE instrument_operation_targets (
               operation_id TEXT NOT NULL,
               target_key TEXT NOT NULL,
               target_kind TEXT NOT NULL,
               state TEXT NOT NULL,
               target_json TEXT NOT NULL,
               execution_key TEXT,
               response_json TEXT,
               error TEXT,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL,
               PRIMARY KEY (operation_id, target_key)
             );",
        )
        .unwrap();
        let original = position_target_for_fingerprint("65000", "10");
        conn.execute(
            "INSERT INTO instrument_operation_targets (
               operation_id,target_key,target_kind,state,target_json,created_at,updated_at
             ) VALUES ('op-1',?1,'position','unknown',?2,1,1)",
            params![original.key, serde_json::to_string(&original).unwrap()],
        )
        .unwrap();
        let mut new_position = position_target_for_fingerprint("65001", "10");
        new_position.key = "position:pos-2".to_string();
        new_position.pos_id = Some("pos-2".to_string());

        upsert_residual_targets_with_conn(
            &mut conn,
            "op-1",
            &[original, new_position],
            "strict final scan residual",
        )
        .unwrap();
        let states = conn
            .prepare(
                "SELECT target_key,state,error FROM instrument_operation_targets
                 WHERE operation_id='op-1' ORDER BY target_key",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(states.len(), 2);
        assert!(states
            .iter()
            .all(|(_, state, error)| state == "residual" && error == "strict final scan residual"));
    }

    #[test]
    fn close_position_response_requires_stable_client_id_and_rejects_scope_mismatches() {
        let body = EmergencyClosePositionBody {
            inst_id: "BTC-USDT-SWAP".to_string(),
            mgn_mode: "cross".to_string(),
            pos_side: "long".to_string(),
            auto_cxl: false,
            cl_ord_id: "client-close-1".to_string(),
            client_marker: exchange_client_marker(),
        };
        let marker = exchange_client_marker();
        let wire_body = serde_json::to_value(&body).expect("serialize emergency close body");
        assert_eq!(
            wire_body.get("tag").and_then(Value::as_str),
            Some(marker.as_str())
        );
        assert!(wire_body.get("clientMarker").is_none());
        assert!(validate_close_position_response_scope(
            &body,
            &EmergencyClosePositionResult::default(),
        )
        .is_err());
        assert!(validate_close_position_response_scope(
            &body,
            &EmergencyClosePositionResult {
                inst_id: body.inst_id.clone(),
                pos_side: body.pos_side.clone(),
                cl_ord_id: body.cl_ord_id.clone(),
                client_marker: body.client_marker.clone(),
            },
        )
        .is_ok());
        let public_response = serde_json::to_value(EmergencyClosePositionResult {
            client_marker: marker,
            ..Default::default()
        })
        .expect("serialize emergency close response");
        assert!(public_response.get("tag").is_none());

        for mismatch in [
            EmergencyClosePositionResult {
                inst_id: "ETH-USDT-SWAP".to_string(),
                cl_ord_id: body.cl_ord_id.clone(),
                ..Default::default()
            },
            EmergencyClosePositionResult {
                pos_side: "short".to_string(),
                cl_ord_id: body.cl_ord_id.clone(),
                ..Default::default()
            },
            EmergencyClosePositionResult {
                cl_ord_id: "another-client-id".to_string(),
                ..Default::default()
            },
            EmergencyClosePositionResult {
                client_marker: "different-client-marker".to_string(),
                cl_ord_id: body.cl_ord_id.clone(),
                ..Default::default()
            },
        ] {
            assert!(validate_close_position_response_scope(&body, &mismatch).is_err());
        }
    }
}
