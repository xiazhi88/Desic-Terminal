use super::*;

struct AccountMutationLeaseGuard<'a> {
    app: &'a tauri::AppHandle,
    lease: AccountMutationLease,
}

impl<'a> AccountMutationLeaseGuard<'a> {
    fn begin(
        app: &'a tauri::AppHandle,
        account: &LocalAccount,
        operation: &str,
    ) -> Result<Self, String> {
        Ok(Self {
            app,
            lease: begin_account_mutation_lease(app, account, operation)?,
        })
    }

    fn renew(&self) -> Result<(), String> {
        renew_account_mutation_lease(self.app, &self.lease)
    }
}

impl Drop for AccountMutationLeaseGuard<'_> {
    fn drop(&mut self) {
        finish_account_mutation_lease(self.app, &self.lease);
    }
}

fn is_algo_order_type(order_type: &str) -> bool {
    matches!(order_type, "trigger" | "move_order_stop")
}

fn validate_trailing_callback_ratio(value: &str) -> Result<(), String> {
    let callback = value
        .trim()
        .parse::<f64>()
        .map_err(|_| "trailing.callbackRatio 无效".to_string())?;
    if !callback.is_finite() || callback <= 0.0 || callback > 0.05 {
        return Err(
            "trailing.callbackRatio 必须使用原始比例，且满足 0 < ratio <= 0.05".to_string(),
        );
    }
    Ok(())
}

fn apply_order_spec_v2(request: &mut PlaceOrderRequest) -> Result<(), String> {
    let Some(spec) = request.order_spec_v2.clone() else {
        if request.order_type == "trailing" {
            request.order_type = "move_order_stop".to_string();
        }
        if is_algo_order_type(&request.order_type)
            && request
                .attach_algo_ords
                .as_ref()
                .is_some_and(|items| !items.is_empty())
        {
            return Err("算法委托暂不支持附加止盈止损，已阻止静默忽略".to_string());
        }
        return Ok(());
    };
    if spec.version != 2 {
        return Err(format!("不支持的 orderSpecV2.version：{}", spec.version));
    }
    if spec.attached_exits.is_some() && request.attach_algo_ords.as_ref().is_none_or(Vec::is_empty)
    {
        return Err(
            "orderSpecV2.attachedExits 尚未编译为 attachAlgoOrds，已阻止静默忽略".to_string(),
        );
    }
    if spec.risk.is_some() {
        return Err(
            "orderSpecV2.risk 必须先由风险定额预检解析为明确 size，已阻止静默忽略".to_string(),
        );
    }
    match spec.requested_order_type.as_str() {
        "limit" | "market" | "post_only" | "ioc" | "fok" => {
            if spec.trigger.is_some() || spec.trailing.is_some() {
                return Err("普通委托不能同时包含 trigger/trailing 参数".to_string());
            }
            request.order_type = spec.requested_order_type;
        }
        "trigger" => {
            let trigger = spec
                .trigger
                .as_ref()
                .ok_or_else(|| "trigger 委托缺少 orderSpecV2.trigger".to_string())?;
            if spec.trailing.is_some() {
                return Err("trigger 委托不能同时包含 trailing 参数".to_string());
            }
            if request
                .attach_algo_ords
                .as_ref()
                .is_some_and(|items| !items.is_empty())
            {
                return Err("trigger 委托暂不支持附加止盈止损，已阻止静默忽略".to_string());
            }
            if !matches!(trigger.source.as_str(), "last" | "mark" | "index") {
                return Err("触发价来源必须是 last、mark 或 index".to_string());
            }
            if !matches!(trigger.execution.as_str(), "market" | "limit") {
                return Err("触发后执行类型必须是 market 或 limit".to_string());
            }
            if trigger.execution == "limit"
                && trigger
                    .order_price
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .is_none()
            {
                return Err("触发限价委托缺少 orderSpecV2.trigger.orderPrice".to_string());
            }
            request.order_type = "trigger".to_string();
            request.price = trigger.trigger_price.clone();
        }
        "trailing" | "move_order_stop" => {
            let trailing = spec
                .trailing
                .as_ref()
                .ok_or_else(|| "trailing 委托缺少 orderSpecV2.trailing".to_string())?;
            if spec.trigger.is_some() {
                return Err("trailing 委托不能同时包含 trigger 参数".to_string());
            }
            if request
                .attach_algo_ords
                .as_ref()
                .is_some_and(|items| !items.is_empty())
            {
                return Err("trailing 委托暂不支持附加止盈止损，已阻止静默忽略".to_string());
            }
            if trailing.source != "last" {
                return Err("OKX move_order_stop 当前只支持 last 价格源".to_string());
            }
            validate_trailing_callback_ratio(&trailing.callback_ratio)?;
            request.order_type = "move_order_stop".to_string();
            request.price = trailing.activation_price.clone().unwrap_or_default();
        }
        _ => return Err("orderSpecV2.requestedOrderType 无效".to_string()),
    }
    Ok(())
}

fn bind_manual_order_identity(
    account: &LocalAccount,
    request: &mut PlaceOrderRequest,
) -> Result<(), String> {
    request.execution_key = optional_non_empty(&request.execution_key);
    if request
        .execution_key
        .as_deref()
        .is_some_and(|value| value.len() > 256)
    {
        return Err("executionKey 不能超过 256 个字符".to_string());
    }
    request.algo_cl_ord_id = optional_non_empty(&request.algo_cl_ord_id);
    let Some(algo_cl_ord_id) = request.algo_cl_ord_id.as_deref() else {
        return Ok(());
    };
    if !is_algo_order_type(&request.order_type) {
        return Err("algoClOrdId 仅适用于 trigger 或 trailing 委托".to_string());
    }
    if algo_cl_ord_id.len() > 32
        || !algo_cl_ord_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err("algoClOrdId 必须是最多 32 位 ASCII 字母或数字".to_string());
    }
    if request.execution_key.is_none() {
        request.execution_key = Some(format!(
            "manual-algo:{}:{}:{}",
            account.id, request.inst_id, algo_cl_ord_id
        ));
    }
    Ok(())
}

/// Narrow adapter for Systematic Profile execution. Python never receives this
/// interface; it returns a validated high-level action which is translated
/// here into the same audited order pipeline used by the terminal.
#[derive(Debug, Clone)]
pub(crate) struct SystematicProfileOrderRequest {
    pub profile_id: String,
    pub profile_generation: u64,
    pub account_id: String,
    pub environment: String,
    pub inst_id: String,
    pub margin_mode: String,
    pub leverage: f64,
    pub action: String,
    pub order_type: String,
    pub limit_price: Option<f64>,
    pub quantity: f64,
    pub reason: String,
    pub execution_key: String,
    pub stop_loss: Option<f64>,
    pub take_profit: Option<f64>,
    pub stop_loss_order_type: String,
    pub take_profit_order_type: String,
    pub take_profit_client_order_id: Option<String>,
    pub take_profit_closed_quantity: Option<f64>,
    pub take_profit_current_filled_quantity: Option<f64>,
}

#[derive(Debug, Clone)]
pub(crate) struct SystematicProfileOrderResponse {
    pub order_id: String,
    pub client_order_id: String,
    pub protection_client_order_id: Option<String>,
    pub protection_status: Option<String>,
    pub filled_quantity: Option<f64>,
    pub protection_error: Option<String>,
    pub post_fill_take_profit_client_order_id: Option<String>,
    pub post_fill_take_profit_closed_quantity: Option<f64>,
    pub post_fill_take_profit_current_filled_quantity: Option<f64>,
}

fn normalize_systematic_price(value: f64, tick_size: &str, field: &str) -> Result<f64, String> {
    if !value.is_finite() || value <= 0.0 {
        return Err(format!("策略 Profile {field} 必须是正数"));
    }
    let raw = trim_float(value);
    let normalized = desic_trade_domain::normalize_price(&raw, tick_size).map_err(|error| {
        format!(
            "策略 Profile {field} 无法按 tickSz {} 对齐：{}",
            tick_size.trim(),
            error
        )
    })?;
    normalized.parse::<f64>().map_err(|error| {
        format!(
            "策略 Profile {field} 归一化结果无效：{} ({error})",
            normalized
        )
    })
}

fn normalize_optional_systematic_price(
    value: Option<f64>,
    tick_size: &str,
    field: &str,
) -> Result<Option<f64>, String> {
    value
        .map(|value| normalize_systematic_price(value, tick_size, field))
        .transpose()
}

async fn normalize_systematic_profile_prices(
    app: &tauri::AppHandle,
    request: &mut SystematicProfileOrderRequest,
) -> Result<(), String> {
    if request.limit_price.is_none() && request.stop_loss.is_none() && request.take_profit.is_none()
    {
        return Ok(());
    }
    let instrument = fetch_instrument(app, &request.inst_id).await?;
    let tick_size = instrument.tick_sz.trim();
    if tick_size.is_empty() {
        return Err(format!(
            "策略 Profile {} 缺少有效 tickSz，无法规范化价格",
            request.inst_id
        ));
    }
    request.limit_price =
        normalize_optional_systematic_price(request.limit_price, tick_size, "开仓限价")?;
    request.stop_loss =
        normalize_optional_systematic_price(request.stop_loss, tick_size, "止损价")?;
    request.take_profit =
        normalize_optional_systematic_price(request.take_profit, tick_size, "止盈价")?;
    Ok(())
}

const SYSTEMATIC_PROFILE_PROTECTION_RETRY_DELAYS_MS: &[u64] = &[0, 150, 350, 750, 1_250, 2_000];

async fn reconcile_systematic_profile_protection_order(
    account: &LocalAccount,
    inst_id: &str,
    client_order_id: &str,
    is_algo: bool,
) -> Result<Option<OkxPendingOrder>, String> {
    let mut last_error = None;
    let mut confirmed_response = false;
    for delay_ms in SYSTEMATIC_PROFILE_PROTECTION_RETRY_DELAYS_MS {
        if *delay_ms > 0 {
            sleep(Duration::from_millis(*delay_ms)).await;
        }
        match reconcile_order_by_client_id(account, inst_id, client_order_id, is_algo).await {
            Ok(Some(order)) => return Ok(Some(order)),
            Ok(None) => confirmed_response = true,
            Err(error) => last_error = Some(error),
        }
    }
    if confirmed_response {
        Ok(None)
    } else {
        Err(last_error.unwrap_or_else(|| "保护单对账未返回结果".to_string()))
    }
}

pub(crate) async fn systematic_profile_sync_leverage(
    app: tauri::AppHandle,
    account_id: &str,
    environment: &str,
    inst_id: &str,
    margin_mode: &str,
    leverage: f64,
    profile_id: &str,
) -> Result<bool, String> {
    let account = load_local_account_secret(&app, Some(account_id))?;
    ensure_account_snapshot_current(&app, &account)?;
    if normalize_environment(&account.environment) != normalize_environment(environment) {
        return Err("策略 Profile 账号环境已变化，已阻止调整杠杆".to_string());
    }
    if !matches!(margin_mode, "cross" | "isolated") {
        return Err("策略 Profile 保证金模式无效".to_string());
    }
    if !leverage.is_finite() || !(1.0..=50.0).contains(&leverage) {
        return Err("策略 Profile 杠杆必须在 1x 到 50x 之间".to_string());
    }
    let current =
        okx_private_get::<OkxLeverageInfo>(&account, &leverage_info_path(inst_id, margin_mode))
            .await
            .map(|response| response.data)
            .unwrap_or_default();
    let already_matched = !current.is_empty()
        && current.iter().all(|row| {
            row.mgn_mode == margin_mode
                && row
                    .lever
                    .parse::<f64>()
                    .map(|value| (value - leverage).abs() <= 1e-10)
                    .unwrap_or(false)
        });
    if already_matched {
        return Ok(false);
    }
    okx_set_leverage(
        app,
        SetLeverageRequest {
            account_id: Some(account_id.to_string()),
            inst_id: inst_id.to_string(),
            mgn_mode: margin_mode.to_string(),
            lever: trim_float(leverage),
            pos_side: None,
            environment: environment.to_string(),
            operator: Some("strategy".to_string()),
            opportunity_id: None,
            opportunity_revision: None,
            agent_run_id: None,
            reason: Some(format!("Systematic Profile {profile_id} target leverage")),
            profile_target_authorized: false,
        },
    )
    .await?;
    Ok(true)
}

pub(crate) async fn systematic_profile_place_order(
    app: tauri::AppHandle,
    mut request: SystematicProfileOrderRequest,
) -> Result<SystematicProfileOrderResponse, String> {
    if !request.quantity.is_finite() || request.quantity <= 0.0 {
        return Err("策略 Profile 返回的合约张数无效".to_string());
    }
    let action = request.action.trim().to_string();
    if !matches!(
        action.as_str(),
        "long" | "short" | "close-long" | "close-short"
    ) {
        return Err("策略 Profile 返回了不支持的交易动作".to_string());
    }
    let open_action = matches!(action.as_str(), "long" | "short");
    let stop_loss_order_type = request.stop_loss_order_type.trim().to_ascii_lowercase();
    let take_profit_order_type = request.take_profit_order_type.trim().to_ascii_lowercase();
    if !matches!(stop_loss_order_type.as_str(), "market" | "limit")
        || !matches!(
            take_profit_order_type.as_str(),
            "market" | "limit" | "post_fill_limit"
        )
    {
        return Err(
            "策略 Profile 的止盈止损执行方式无效 / Profile protection execution type is invalid"
                .to_string(),
        );
    }
    let order_type = request.order_type.trim().to_ascii_lowercase();
    if !matches!(order_type.as_str(), "market" | "limit") {
        return Err("策略 Profile 返回了不支持的订单类型".to_string());
    }
    match order_type.as_str() {
        "market" if request.limit_price.is_none() => {}
        "market" => return Err("市价单不能附带限价".to_string()),
        "limit"
            if request
                .limit_price
                .filter(|price| price.is_finite() && *price > 0.0)
                .is_none() =>
        {
            return Err("限价单必须提供有效限价".to_string());
        }
        "limit" => {}
        _ => unreachable!(),
    }
    if !open_action && (request.stop_loss.is_some() || request.take_profit.is_some()) {
        return Err("平仓动作不能附带新的止盈止损".to_string());
    }
    ensure_systematic_profile_submission_current(&app, &request)?;
    normalize_systematic_profile_prices(&app, &mut request).await?;
    let limit_price = if order_type == "limit" {
        request.limit_price
    } else {
        None
    };
    let protection_client_order_id = (open_action
        && (request.stop_loss.is_some() || request.take_profit.is_some()))
    .then(|| stable_client_order_id(&format!("{}:protection", request.execution_key)));
    let attach_take_profit = request.take_profit.is_some()
        && matches!(take_profit_order_type.as_str(), "market" | "limit");
    let attach_stop_loss = request.stop_loss.is_some();
    let attach_algo_ords = if attach_take_profit || attach_stop_loss {
        let attach_key = protection_client_order_id
            .clone()
            .ok_or_else(|| "保护单缺少稳定客户端订单 ID".to_string())?;
        Some(vec![AttachedAlgoOrder {
            attach_algo_cl_ord_id: Some(attach_key),
            tp_trigger_px: attach_take_profit
                .then(|| request.take_profit)
                .flatten()
                .map(trim_float),
            tp_ord_px: attach_take_profit
                .then(|| request.take_profit)
                .flatten()
                .map(|price| {
                    if take_profit_order_type == "limit" {
                        trim_float(price)
                    } else {
                        "-1".to_string()
                    }
                }),
            tp_ord_kind: (attach_take_profit && take_profit_order_type == "limit")
                .then(|| "limit".to_string()),
            tp_trigger_px_type: attach_take_profit.then(|| "last".to_string()),
            sl_trigger_px: request.stop_loss.map(trim_float),
            sl_ord_px: request.stop_loss.map(|price| {
                if stop_loss_order_type == "limit" {
                    trim_float(price)
                } else {
                    "-1".to_string()
                }
            }),
            sl_trigger_px_type: request.stop_loss.map(|_| "last".to_string()),
            sz: None,
        }])
    } else {
        None
    };
    let state_app = app.clone();
    let runtime = state_app.state::<MarketRuntime>();
    let response = okx_place_order(
        app.clone(),
        runtime,
        PlaceOrderRequest {
            account_id: Some(request.account_id.clone()),
            inst_id: request.inst_id.clone(),
            td_mode: request.margin_mode.clone(),
            order_type,
            ticket_mode: if open_action { "open" } else { "close" }.to_string(),
            action,
            price: limit_price.map(trim_float).unwrap_or_default(),
            size: trim_float(request.quantity),
            lever: trim_float(request.leverage),
            environment: request.environment.clone(),
            confirmed_live: Some(true),
            operator: Some("strategy".to_string()),
            strategy_id: Some(request.profile_id.clone()),
            session_id: None,
            opportunity_id: None,
            opportunity_revision: None,
            agent_run_id: None,
            execution_key: Some(request.execution_key.clone()),
            algo_cl_ord_id: None,
            execution_leg: Some("primary".to_string()),
            reason: Some(request.reason.clone()),
            attach_algo_ords,
            order_spec_v2: None,
        },
    )
    .await?;
    let protection = if open_action && protection_client_order_id.is_some() {
        reconcile_systematic_profile_protection(
            &app,
            &request,
            &response.ord_id,
            protection_client_order_id.as_deref().unwrap_or_default(),
        )
        .await
    } else {
        ProtectionReconcileResult::default()
    };
    Ok(SystematicProfileOrderResponse {
        order_id: response.ord_id,
        client_order_id: response.cl_ord_id,
        protection_client_order_id,
        protection_status: protection.status,
        filled_quantity: protection.filled_quantity,
        protection_error: protection.error,
        post_fill_take_profit_client_order_id: protection.post_fill_take_profit_client_order_id,
        post_fill_take_profit_closed_quantity: protection.post_fill_take_profit_closed_quantity,
        post_fill_take_profit_current_filled_quantity: protection
            .post_fill_take_profit_current_filled_quantity,
    })
}

#[derive(Debug, Default)]
pub(crate) struct ProtectionReconcileResult {
    pub(crate) status: Option<String>,
    pub(crate) filled_quantity: Option<f64>,
    pub(crate) error: Option<String>,
    pub(crate) post_fill_take_profit_client_order_id: Option<String>,
    pub(crate) post_fill_take_profit_closed_quantity: Option<f64>,
    pub(crate) post_fill_take_profit_current_filled_quantity: Option<f64>,
}

pub(crate) async fn reconcile_systematic_profile_protection(
    app: &tauri::AppHandle,
    request: &SystematicProfileOrderRequest,
    primary_order_id: &str,
    protection_client_order_id: &str,
) -> ProtectionReconcileResult {
    let account = match load_local_account_secret(app, Some(&request.account_id)) {
        Ok(account) => account,
        Err(error) => {
            return ProtectionReconcileResult {
                status: Some("unconfirmed".to_string()),
                error: Some(format!("读取保护对账账号失败：{error}")),
                ..Default::default()
            }
        }
    };
    let primary = match reconcile_order_by_client_id_with_retry(
        &account,
        &request.inst_id,
        &stable_client_order_id(&request.execution_key),
        false,
    )
    .await
    {
        Ok(Some(order)) => order,
        Ok(None) => {
            return ProtectionReconcileResult {
                status: Some("unconfirmed".to_string()),
                error: Some(format!(
                    "主订单 {} 尚未能通过 OKX 对账确认",
                    primary_order_id
                )),
                ..Default::default()
            }
        }
        Err(error) => {
            return ProtectionReconcileResult {
                status: Some("unconfirmed".to_string()),
                error: Some(format!("保护对账暂不可用：{error}")),
                ..Default::default()
            }
        }
    };
    let filled_quantity = primary
        .acc_fill_sz
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value > 0.0);
    let Some(filled_quantity) = filled_quantity else {
        return ProtectionReconcileResult {
            status: Some("pending_fill".to_string()),
            filled_quantity: Some(0.0),
            ..Default::default()
        };
    };
    let mut normalized_request = request.clone();
    if normalized_request.stop_loss.is_some() || normalized_request.take_profit.is_some() {
        if let Err(error) = normalize_systematic_profile_prices(app, &mut normalized_request).await
        {
            return ProtectionReconcileResult {
                status: Some("warning".to_string()),
                filled_quantity: Some(filled_quantity),
                error: Some(format!("保护价格规范化失败：{error}")),
                ..Default::default()
            };
        }
    }
    let request = &normalized_request;
    let take_profit_order_type = request.take_profit_order_type.trim().to_ascii_lowercase();
    let attached_protection_requested = request.stop_loss.is_some()
        || (request.take_profit.is_some() && take_profit_order_type != "post_fill_limit");
    let post_fill_take_profit_requested =
        request.take_profit.is_some() && take_profit_order_type == "post_fill_limit";
    let mut statuses = Vec::new();
    let mut errors = Vec::new();
    let mut attached_can_fallback = attached_protection_requested;

    if attached_protection_requested {
        match reconcile_systematic_profile_protection_order(
            &account,
            &request.inst_id,
            protection_client_order_id,
            true,
        )
        .await
        {
            Ok(Some(order))
                if !order.algo_id.trim().is_empty()
                    && !matches!(
                        order.state.trim().to_ascii_lowercase().as_str(),
                        "failed" | "canceled" | "cancelled"
                    ) =>
            {
                let protected_size = order
                    .sz
                    .trim()
                    .parse::<f64>()
                    .ok()
                    .or_else(|| order.acc_fill_sz.trim().parse::<f64>().ok())
                    .filter(|value| value.is_finite() && *value > 0.0);
                // A protection order without an exchange-reported size is not
                // evidence that the partial fill is actually covered.
                if protected_size.is_some_and(|value| value + f64::EPSILON >= filled_quantity) {
                    statuses.push("attached");
                    attached_can_fallback = false;
                }
            }
            Ok(Some(_)) | Ok(None) => {}
            Err(error) => {
                attached_can_fallback = false;
                errors.push(format!("附加保护单尚未能通过 OKX 对账确认：{error}"));
            }
        }
        if attached_can_fallback {
            match ensure_systematic_profile_submission_current(app, request) {
                Err(error) => errors.push(error),
                Ok(()) => match place_systematic_profile_fallback_protection(
                    app,
                    request,
                    filled_quantity,
                )
                .await
                {
                    Ok(_) => statuses.push("fallback_submitted"),
                    Err(error) => {
                        errors.push(format!("附加保护未生效，独立保护单补挂失败：{error}"))
                    }
                },
            }
        }
    }

    let mut post_fill_take_profit_client_order_id = None;
    let mut post_fill_take_profit_closed_quantity = request
        .take_profit_closed_quantity
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or(0.0);
    let mut post_fill_take_profit_current_filled_quantity = request
        .take_profit_current_filled_quantity
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or(0.0);
    if post_fill_take_profit_requested {
        match ensure_systematic_profile_submission_current(app, request) {
            Err(error) => errors.push(error),
            Ok(()) => match place_systematic_profile_post_fill_take_profit(
                app,
                request,
                filled_quantity,
                post_fill_take_profit_closed_quantity,
                post_fill_take_profit_current_filled_quantity,
            )
            .await
            {
                Ok(result) => {
                    post_fill_take_profit_client_order_id = Some(result.client_order_id);
                    post_fill_take_profit_closed_quantity = result.closed_quantity;
                    post_fill_take_profit_current_filled_quantity = result.current_filled_quantity;
                    statuses.push("post_fill_limit_submitted");
                }
                Err(error) => errors.push(format!("成交后止盈限价单提交失败：{error}")),
            },
        }
    }

    let status = if !errors.is_empty() {
        Some("warning".to_string())
    } else if statuses.len() > 1 {
        Some("attached_and_post_fill_limit".to_string())
    } else {
        statuses.first().map(|value| (*value).to_string())
    };
    ProtectionReconcileResult {
        status,
        filled_quantity: Some(filled_quantity),
        error: (!errors.is_empty()).then(|| errors.join("；")),
        post_fill_take_profit_client_order_id,
        post_fill_take_profit_closed_quantity: post_fill_take_profit_requested
            .then_some(post_fill_take_profit_closed_quantity),
        post_fill_take_profit_current_filled_quantity: post_fill_take_profit_requested
            .then_some(post_fill_take_profit_current_filled_quantity),
    }
}

#[derive(Debug, Default)]
struct PostFillTakeProfitOrderResult {
    client_order_id: String,
    closed_quantity: f64,
    current_filled_quantity: f64,
}

async fn place_systematic_profile_post_fill_take_profit(
    app: &tauri::AppHandle,
    request: &SystematicProfileOrderRequest,
    filled_quantity: f64,
    previously_closed_quantity: f64,
    previously_current_filled_quantity: f64,
) -> Result<PostFillTakeProfitOrderResult, String> {
    let take_profit = request
        .take_profit
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| "成交后止盈限价单缺少有效止盈价".to_string())?;
    let base_execution_key = format!("{}:take-profit-resting", request.execution_key);
    let mut client_order_id = request
        .take_profit_client_order_id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| stable_client_order_id(&base_execution_key));
    let mut execution_key = if client_order_id == stable_client_order_id(&base_execution_key) {
        base_execution_key.clone()
    } else {
        format!("{base_execution_key}:retry:{client_order_id}")
    };
    let mut prior_closed_quantity =
        (previously_closed_quantity - previously_current_filled_quantity).max(0.0);
    let mut submit_quantity = (filled_quantity - prior_closed_quantity).max(0.0);

    for _ in 0..4 {
        let account = load_local_account_secret(app, Some(&request.account_id))?;
        if let Some(existing) = reconcile_order_by_client_id_with_retry(
            &account,
            &request.inst_id,
            &client_order_id,
            false,
        )
        .await?
        {
            let state = existing.state.trim().to_ascii_lowercase();
            let order_size = existing
                .sz
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite() && *value > 0.0)
                .unwrap_or(0.0);
            let order_filled = existing
                .acc_fill_sz
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite() && *value >= 0.0)
                .unwrap_or(0.0);
            let total_closed = (prior_closed_quantity + order_filled).min(filled_quantity);
            let terminal = matches!(
                state.as_str(),
                "filled" | "canceled" | "cancelled" | "failed" | "mmp_canceled"
            );
            if terminal {
                prior_closed_quantity = total_closed;
                submit_quantity = (filled_quantity - prior_closed_quantity).max(0.0);
                if submit_quantity <= f64::EPSILON {
                    return Ok(PostFillTakeProfitOrderResult {
                        client_order_id,
                        closed_quantity: total_closed,
                        current_filled_quantity: order_filled,
                    });
                }
                let next_execution_key = format!("{base_execution_key}:retry:{client_order_id}");
                client_order_id = stable_client_order_id(&next_execution_key);
                execution_key = next_execution_key;
                continue;
            }
            if order_size + f64::EPSILON < submit_quantity {
                let runtime_app = app.clone();
                let runtime = runtime_app.state::<MarketRuntime>();
                okx_amend_order(
                    app.clone(),
                    runtime,
                    AmendOrderRequest {
                        account_id: Some(request.account_id.clone()),
                        environment: request.environment.clone(),
                        inst_id: request.inst_id.clone(),
                        ord_id: (!existing.ord_id.trim().is_empty()).then_some(existing.ord_id),
                        cl_ord_id: (!existing.cl_ord_id.trim().is_empty())
                            .then_some(existing.cl_ord_id),
                        new_size: Some(trim_float(submit_quantity)),
                        new_price: None,
                        confirmed_live: Some(true),
                        operator: Some("strategy".to_string()),
                        opportunity_id: None,
                        opportunity_revision: None,
                        agent_run_id: None,
                        execution_key: Some(format!(
                            "{execution_key}:amend:{}",
                            trim_float(submit_quantity)
                        )),
                        execution_leg: Some("protection".to_string()),
                        reason: Some("成交后补足止盈限价单".to_string()),
                    },
                )
                .await?;
            }
            return Ok(PostFillTakeProfitOrderResult {
                client_order_id,
                closed_quantity: total_closed,
                current_filled_quantity: order_filled,
            });
        }

        if submit_quantity <= f64::EPSILON {
            return Ok(PostFillTakeProfitOrderResult {
                client_order_id,
                closed_quantity: prior_closed_quantity,
                current_filled_quantity: 0.0,
            });
        }
        let action = match request.action.as_str() {
            "long" => "close-long",
            "short" => "close-short",
            _ => return Err("只有开仓动作可以挂成交后止盈限价单".to_string()),
        };
        let runtime_app = app.clone();
        let runtime = runtime_app.state::<MarketRuntime>();
        let response = okx_place_order(
            app.clone(),
            runtime,
            PlaceOrderRequest {
                account_id: Some(request.account_id.clone()),
                inst_id: request.inst_id.clone(),
                td_mode: request.margin_mode.clone(),
                order_type: "limit".to_string(),
                ticket_mode: "close".to_string(),
                action: action.to_string(),
                price: trim_float(take_profit),
                size: trim_float(submit_quantity),
                lever: trim_float(request.leverage),
                environment: request.environment.clone(),
                confirmed_live: Some(true),
                operator: Some("strategy".to_string()),
                strategy_id: Some(request.profile_id.clone()),
                session_id: None,
                opportunity_id: None,
                opportunity_revision: None,
                agent_run_id: None,
                execution_key: Some(execution_key),
                algo_cl_ord_id: None,
                execution_leg: Some("protection".to_string()),
                reason: Some("成交后立即挂止盈限价单".to_string()),
                attach_algo_ords: None,
                order_spec_v2: None,
            },
        )
        .await?;
        return Ok(PostFillTakeProfitOrderResult {
            client_order_id: response.cl_ord_id,
            closed_quantity: prior_closed_quantity,
            current_filled_quantity: 0.0,
        });
    }
    Err("成交后止盈限价单重试次数超限".to_string())
}

async fn place_systematic_profile_fallback_protection(
    app: &tauri::AppHandle,
    request: &SystematicProfileOrderRequest,
    filled_quantity: f64,
) -> Result<(), String> {
    let (side, pos_side) = match request.action.as_str() {
        "long" => ("sell", "long"),
        "short" => ("buy", "short"),
        _ => return Err("只有开仓动作可以补挂保护单".to_string()),
    };
    let execution_key = format!("{}:fallback-protection", request.execution_key);
    let attach_take_profit = request.take_profit.is_some()
        && !request
            .take_profit_order_type
            .trim()
            .eq_ignore_ascii_case("post_fill_limit");
    let account = load_local_account_secret(app, Some(&request.account_id))?;
    let fallback_client_order_id = stable_client_order_id(&execution_key);
    if let Some(existing) = reconcile_order_by_client_id_with_retry(
        &account,
        &request.inst_id,
        &fallback_client_order_id,
        true,
    )
    .await?
    {
        let state = existing.state.trim().to_ascii_lowercase();
        if !matches!(state.as_str(), "failed" | "canceled" | "cancelled") {
            let existing_size = existing
                .sz
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite() && *value > 0.0)
                .unwrap_or(0.0);
            if existing_size + f64::EPSILON >= filled_quantity {
                return Ok(());
            }
            okx_amend_algo_order(
                app.clone(),
                AmendAlgoOrderRequest {
                    account_id: Some(request.account_id.clone()),
                    environment: request.environment.clone(),
                    inst_id: request.inst_id.clone(),
                    algo_id: (!existing.algo_id.trim().is_empty()).then_some(existing.algo_id),
                    algo_cl_ord_id: (!existing.algo_cl_ord_id.trim().is_empty())
                        .then_some(existing.algo_cl_ord_id),
                    new_size: Some(trim_float(filled_quantity)),
                    new_trigger_px: None,
                    new_ord_px: None,
                    new_tp_trigger_px: None,
                    new_tp_ord_px: None,
                    new_sl_trigger_px: None,
                    new_sl_ord_px: None,
                    confirmed_live: Some(true),
                    execution_key: Some(format!(
                        "{}:amend:{}",
                        execution_key,
                        trim_float(filled_quantity)
                    )),
                },
            )
            .await
            .map(|_| ())?;
            return Ok(());
        }
    }
    okx_place_algo_order(
        app.clone(),
        PlaceAlgoOrderRequest {
            account_id: Some(request.account_id.clone()),
            environment: request.environment.clone(),
            inst_id: request.inst_id.clone(),
            td_mode: request.margin_mode.clone(),
            pos_side: pos_side.to_string(),
            side: side.to_string(),
            ord_type: "conditional".to_string(),
            size: trim_float(filled_quantity),
            tp_trigger_px: attach_take_profit
                .then(|| request.take_profit)
                .flatten()
                .map(trim_float),
            tp_ord_px: attach_take_profit
                .then(|| request.take_profit)
                .flatten()
                .map(|price| {
                    if request
                        .take_profit_order_type
                        .trim()
                        .eq_ignore_ascii_case("limit")
                    {
                        trim_float(price)
                    } else {
                        "-1".to_string()
                    }
                }),
            sl_trigger_px: request.stop_loss.map(trim_float),
            sl_ord_px: request.stop_loss.map(|price| {
                if request
                    .stop_loss_order_type
                    .trim()
                    .eq_ignore_ascii_case("limit")
                {
                    trim_float(price)
                } else {
                    "-1".to_string()
                }
            }),
            confirmed_live: Some(true),
            operator: Some("strategy".to_string()),
            strategy_id: Some(request.profile_id.clone()),
            session_id: None,
            execution_key: Some(execution_key),
        },
    )
    .await
    .map(|_| ())
}

fn ensure_systematic_profile_submission_current(
    app: &tauri::AppHandle,
    request: &SystematicProfileOrderRequest,
) -> Result<(), String> {
    let runtime = app
        .try_state::<crate::systematic::SystematicRuntime>()
        .ok_or_else(|| "策略 Profile 运行时不可用，已阻止提交".to_string())?;
    if !runtime.live_profile_generation_is_current(&request.profile_id, request.profile_generation)
    {
        return Err(
            "策略 Profile 已停用，已在提交前阻断本轮动作 / Profile was stopped before submission"
                .to_string(),
        );
    }
    let conn = open_database(app)?;
    let enabled: i64 = conn
        .query_row(
            "SELECT enabled FROM systematic_profiles WHERE id=?1",
            [&request.profile_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "策略 Profile 不存在，已阻止提交".to_string())?;
    if enabled == 0 {
        return Err(
            "策略 Profile 已停用，已在提交前阻断本轮动作 / Profile was stopped before submission"
                .to_string(),
        );
    }
    Ok(())
}

/// Cancels one normal order after the Profile layer has verified that the
/// order belongs to that exact Profile. Python never reaches this function.
pub(crate) async fn systematic_profile_cancel_order(
    app: tauri::AppHandle,
    account_id: &str,
    environment: &str,
    inst_id: &str,
    order_id: &str,
    reason: &str,
) -> Result<(), String> {
    let runtime_app = app.clone();
    let runtime = runtime_app.state::<MarketRuntime>();
    okx_cancel_order(
        runtime,
        app,
        CancelOrderRequest {
            account_id: Some(account_id.to_string()),
            environment: environment.to_string(),
            inst_id: inst_id.to_string(),
            confirmed_live: Some(true),
            ord_id: Some(order_id.to_string()),
            cl_ord_id: None,
            is_algo: Some(false),
            algo_id: None,
            algo_cl_ord_id: None,
            operator: Some("strategy".to_string()),
            opportunity_id: None,
            agent_run_id: None,
            reason: Some(reason.to_string()),
        },
    )
    .await
    .map(|_| ())
}

/// Cancels a normal Profile-owned order by its stable client order ID.
/// Missing or already-terminal orders are treated as successfully cancelled;
/// an order that remains active after a failed cancel is surfaced to the caller.
pub(crate) async fn systematic_profile_cancel_order_by_client_id(
    app: tauri::AppHandle,
    account_id: &str,
    environment: &str,
    inst_id: &str,
    client_order_id: &str,
    reason: &str,
) -> Result<(), String> {
    let client_order_id = client_order_id.trim();
    if client_order_id.is_empty() {
        return Err("策略 Profile 撤销普通委托缺少 clOrdId".to_string());
    }
    let account = load_local_account_secret(&app, Some(account_id))?;
    ensure_account_snapshot_current(&app, &account)?;
    if normalize_environment(&account.environment) != normalize_environment(environment) {
        return Err("策略 Profile 账号环境已变化，无法撤销普通委托".to_string());
    }
    let order =
        reconcile_order_by_client_id_with_retry(&account, inst_id, client_order_id, false).await?;
    let Some(order) = order else {
        return Ok(());
    };
    let state = order.state.trim().to_ascii_lowercase();
    if matches!(
        state.as_str(),
        "filled" | "canceled" | "cancelled" | "failed" | "mmp_canceled"
    ) {
        return Ok(());
    }
    let runtime_app = app.clone();
    let runtime = runtime_app.state::<MarketRuntime>();
    match okx_cancel_order(
        runtime,
        app.clone(),
        CancelOrderRequest {
            account_id: Some(account_id.to_string()),
            environment: environment.to_string(),
            inst_id: inst_id.to_string(),
            confirmed_live: Some(true),
            ord_id: (!order.ord_id.trim().is_empty()).then_some(order.ord_id.clone()),
            cl_ord_id: (!order.cl_ord_id.trim().is_empty())
                .then_some(order.cl_ord_id.clone())
                .or_else(|| Some(client_order_id.to_string())),
            is_algo: Some(false),
            algo_id: None,
            algo_cl_ord_id: None,
            operator: Some("strategy".to_string()),
            opportunity_id: None,
            agent_run_id: None,
            reason: Some(reason.to_string()),
        },
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(error) => {
            match reconcile_order_by_client_id_with_retry(&account, inst_id, client_order_id, false)
                .await?
            {
                Some(order)
                    if matches!(
                        order.state.trim().to_ascii_lowercase().as_str(),
                        "filled" | "canceled" | "cancelled" | "failed" | "mmp_canceled"
                    ) =>
                {
                    Ok(())
                }
                None => Ok(()),
                Some(_) => Err(error),
            }
        }
    }
}

#[tauri::command]
pub async fn okx_set_leverage(
    app: tauri::AppHandle,
    request: SetLeverageRequest,
) -> Result<SetLeverageResponse, String> {
    let _trade_mutation_guard = TRADE_MUTATION_LOCK.lock().await;
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    ensure_account_snapshot_current(&app, &account)?;
    if normalize_environment(&account.environment) != normalize_environment(&request.environment) {
        return Err("账号环境与当前交易环境不一致".to_string());
    }
    if !account.permissions.trade {
        return Err("账号未开启交易权限，不能设置杠杆".to_string());
    }
    if !matches!(request.mgn_mode.as_str(), "cross" | "isolated") {
        return Err("保证金模式必须是 cross 或 isolated".to_string());
    }
    let lever_value = request
        .lever
        .trim()
        .parse::<f64>()
        .map_err(|_| "杠杆无效".to_string())?;
    if !lever_value.is_finite() || lever_value <= 0.0 {
        return Err("杠杆无效".to_string());
    }
    let operator = normalize_trade_operator(request.operator.as_ref());
    if operator == "ai" && request.reason.as_deref().unwrap_or("").trim().is_empty() {
        return Err("AI 调整杠杆必须提供 reason".to_string());
    }
    let current_rows = if operator == "ai" {
        let rows = okx_private_get::<OkxLeverageInfo>(
            &account,
            &leverage_info_path(&request.inst_id, &request.mgn_mode),
        )
        .await
        .map(|value| value.data)
        .unwrap_or_default();
        let increases_risk = rows.is_empty()
            || rows.iter().any(|row| {
                row.lever
                    .parse::<f64>()
                    .map(|current| lever_value > current + 1e-10)
                    .unwrap_or(true)
            });
        if increases_risk && !request.profile_target_authorized {
            let opportunity = validate_ai_risk_increase_opportunity(
                &app,
                &account,
                &request.environment,
                &request.inst_id,
                request.opportunity_id.as_deref(),
                request.opportunity_revision,
                request.agent_run_id.as_deref(),
            )?;
            let approved_lever = opportunity
                .lever
                .as_deref()
                .and_then(|value| value.parse::<f64>().ok())
                .unwrap_or(1.0);
            if lever_value > approved_lever + 1e-10 {
                return Err("请求杠杆超过交易机会批准杠杆".to_string());
            }
        }
        rows
    } else {
        Vec::new()
    };
    let strategy_id = optional_non_empty(&request.opportunity_id);
    let session_id = optional_non_empty(&request.agent_run_id);

    let config = okx_private_get::<OkxAccountConfig>(&account, "/api/v5/account/config")
        .await?
        .data
        .into_iter()
        .next()
        .ok_or_else(|| "OKX 账户配置为空".to_string())?;
    if !config.perm.split(',').any(|perm| perm.trim() == "trade") {
        return Err("OKX API Key 未包含 trade 权限".to_string());
    }

    if request.profile_target_authorized
        && !current_rows.is_empty()
        && leverage_rows_match(&current_rows, lever_value, Some(config.pos_mode.as_str()))
    {
        return Ok(SetLeverageResponse {
            inst_id: request.inst_id,
            mgn_mode: request.mgn_mode,
            requested_lever: request.lever,
            results: current_rows,
            warnings: vec!["当前杠杆已是 Profile 目标值，未重复写入 OKX".to_string()],
        });
    }

    let mut warnings = Vec::new();
    let pos_sides = leverage_pos_sides(config.pos_mode.as_str(), request.pos_side.as_deref());
    if config.pos_mode == "long_short_mode" && request.pos_side.is_none() {
        warnings.push("双向持仓模式已同步 long/short 两侧杠杆".to_string());
    }

    let account_mutation_lease = AccountMutationLeaseGuard::begin(&app, &account, "set_leverage")?;
    let mut results = Vec::new();
    for pos_side in pos_sides {
        let body = SetLeverageBody {
            inst_id: request.inst_id.clone(),
            lever: request.lever.clone(),
            mgn_mode: request.mgn_mode.clone(),
            pos_side: pos_side.clone(),
        };
        account_mutation_lease.renew()?;
        let envelope = match okx_private_post::<OkxLeverageInfo, _>(
            &account,
            "/api/v5/account/set-leverage",
            &body,
        )
        .await
        {
            Ok(value) => value,
            Err(err) => {
                audit_trade_event(
                    &app,
                    &account,
                    &request.inst_id,
                    "risk_setting",
                    "set_leverage",
                    "failed",
                    None,
                    None,
                    None,
                    None,
                    pos_side.as_deref(),
                    Some(&request.mgn_mode),
                    None,
                    None,
                    &operator,
                    strategy_id.clone(),
                    session_id.clone(),
                    normalize_environment(&request.environment) == "live",
                    None,
                    None,
                    Some(&err),
                    json!({ "request": &request, "okxBody": &body }),
                    None,
                );
                return Err(err);
            }
        };
        let rows = envelope.data;
        if rows.is_empty() {
            audit_trade_event(
                &app,
                &account,
                &request.inst_id,
                "risk_setting",
                "set_leverage",
                "accepted",
                None,
                None,
                None,
                None,
                pos_side.as_deref(),
                Some(&request.mgn_mode),
                None,
                None,
                &operator,
                strategy_id.clone(),
                session_id.clone(),
                normalize_environment(&request.environment) == "live",
                None,
                Some("OKX set-leverage returned no data"),
                None,
                json!({ "request": &request, "okxBody": &body }),
                Some(json!({ "data": [] })),
            );
        }
        for row in rows {
            audit_trade_event(
                &app,
                &account,
                &request.inst_id,
                "risk_setting",
                "set_leverage",
                "accepted",
                None,
                None,
                None,
                None,
                Some(if row.pos_side.trim().is_empty() {
                    pos_side.as_deref().unwrap_or("net")
                } else {
                    row.pos_side.as_str()
                }),
                Some(&request.mgn_mode),
                None,
                None,
                &operator,
                strategy_id.clone(),
                session_id.clone(),
                normalize_environment(&request.environment) == "live",
                None,
                Some(&format!("lever={}", row.lever)),
                None,
                json!({ "request": &request, "okxBody": &body }),
                Some(json!(&row)),
            );
            results.push(row);
        }
    }

    Ok(SetLeverageResponse {
        inst_id: request.inst_id,
        mgn_mode: request.mgn_mode,
        requested_lever: request.lever,
        results,
        warnings,
    })
}

#[tauri::command]
pub async fn okx_place_order(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, MarketRuntime>,
    mut request: PlaceOrderRequest,
) -> Result<PlaceOrderResponse, String> {
    let submit_started = Instant::now();
    apply_order_spec_v2(&mut request)?;
    if normalize_environment(&request.environment) == "live" && request.confirmed_live != Some(true)
    {
        return Err("实盘下单缺少二次确认标记".to_string());
    }
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    bind_ai_place_order_to_opportunity(&app, &account, &mut request)?;
    bind_manual_order_identity(&account, &mut request)?;
    let account_ready_ms = submit_started.elapsed().as_millis() as i64;
    let instrument = fetch_instrument(&app, &request.inst_id).await?;
    let instrument_ready_ms = submit_started.elapsed().as_millis() as i64;
    let (config, account_config_cache_hit) =
        cached_okx_account_config(runtime.inner(), &account).await?;
    let account_config_ready_ms = submit_started.elapsed().as_millis() as i64;
    let mut final_blockers = final_order_blockers(&account, &request, &instrument);
    final_blockers.extend(final_account_config_blockers(&config));
    if config.pos_mode == "net_mode"
        && normalize_trade_operator(request.operator.as_ref()) != "user"
    {
        final_blockers.push(
            "自动化交易要求 OKX 账号使用双向持仓模式；请先在 OKX 中切换为 long_short_mode / Automated trading requires OKX long/short position mode; switch the account to long_short_mode first".to_string(),
        );
    }
    let _trade_mutation_guard = if request.ticket_mode == "open" {
        let guard = TRADE_MUTATION_LOCK.lock().await;
        let unresolved = unresolved_trade_execution_guards_for_scope(
            &app,
            &account,
            &request.inst_id,
            request.execution_key.as_deref(),
        )?;
        if !unresolved.is_empty() {
            let keys = unresolved
                .iter()
                .map(|item| format!("{}({})", item.execution_key, item.status))
                .collect::<Vec<_>>()
                .join(", ");
            final_blockers.push(format!(
                "当前账号与品种存在未完成对账的交易执行，已阻止新开仓：{keys}"
            ));
        }
        let unresolved_operations =
            crate::instrument_operations::unresolved_instrument_operations_for_scope(
                &app,
                &account,
                &request.inst_id,
            )?;
        if !unresolved_operations.is_empty() {
            final_blockers.push(format!(
                "当前账号与品种存在 {} 项未终态紧急操作，已阻止新开仓",
                unresolved_operations.len()
            ));
        }
        Some(guard)
    } else {
        None
    };
    if let Err(blocked_error) = ensure_final_order_blockers(&final_blockers) {
        let operator = normalize_trade_operator(request.operator.as_ref());
        audit_trade_event(
            &app,
            &account,
            &request.inst_id,
            "order_submit",
            "final_order_check",
            "blocked",
            Some(&request.order_type),
            None,
            None,
            None,
            None,
            Some(&request.td_mode),
            Some(&request.size),
            Some(&request.price),
            &operator,
            optional_non_empty(&request.strategy_id),
            optional_non_empty(&request.session_id),
            request.confirmed_live == Some(true),
            None,
            None,
            Some(&final_blockers.join("；")),
            json!({
                "request": &request,
                "instrument": instrument_summary_from(instrument.clone(), None, false, now_ms()),
                "latencyMs": {
                    "accountReady": account_ready_ms,
                    "instrumentReady": instrument_ready_ms,
                    "accountConfigReady": account_config_ready_ms,
                    "accountConfigCacheHit": account_config_cache_hit,
                    "total": submit_started.elapsed().as_millis() as i64
                }
            }),
            None,
        );
        return Err(blocked_error);
    }

    let (side, pos_side, reduce_only) = order_direction(&request.action, &config.pos_mode)?;
    let ord_type = match request.order_type.as_str() {
        "limit" => "limit",
        "market" => "market",
        "post_only" => "post_only",
        "ioc" => "ioc",
        "fok" => "fok",
        "trigger" => "trigger",
        "move_order_stop" => "move_order_stop",
        _ => return Err("委托类型无效".to_string()),
    };
    let generated_client_order_id = request
        .execution_key
        .as_deref()
        .map(stable_client_order_id)
        .unwrap_or_else(|| {
            format!(
                "dt{}{}",
                now_ms(),
                request.action.chars().next().unwrap_or('o')
            )
        });
    let cl_ord_id = if matches!(ord_type, "trigger" | "move_order_stop") {
        request
            .algo_cl_ord_id
            .clone()
            .unwrap_or(generated_client_order_id)
    } else {
        generated_client_order_id
    };
    if matches!(ord_type, "trigger" | "move_order_stop") {
        let trigger = request
            .order_spec_v2
            .as_ref()
            .and_then(|spec| spec.trigger.as_ref());
        let trailing = request
            .order_spec_v2
            .as_ref()
            .and_then(|spec| spec.trailing.as_ref());
        let body = PlaceAlgoOrderBody {
            inst_id: request.inst_id.clone(),
            td_mode: request.td_mode.clone(),
            algo_cl_ord_id: cl_ord_id.clone(),
            client_marker: exchange_client_marker(),
            side: side.clone(),
            pos_side,
            ord_type: ord_type.to_string(),
            sz: request.size.clone(),
            trigger_px: if ord_type == "trigger" {
                Some(request.price.clone())
            } else {
                None
            },
            trigger_px_type: if ord_type == "trigger" {
                Some(
                    trigger
                        .map(|value| value.source.clone())
                        .unwrap_or_else(|| "last".to_string()),
                )
            } else {
                None
            },
            order_px: if ord_type == "trigger" {
                Some(match trigger {
                    Some(value) if value.execution == "limit" => {
                        value.order_price.clone().unwrap_or_default()
                    }
                    _ => "-1".to_string(),
                })
            } else {
                None
            },
            callback_ratio: trailing.map(|value| value.callback_ratio.clone()),
            active_px: trailing.and_then(|value| optional_non_empty(&value.activation_price)),
            reduce_only,
        };
        let reservation = reserve_trade_execution(&app, &account, &request, &cl_ord_id)?;
        let execution_lease = match reservation {
            ExecutionReservation::New(lease) => lease,
            ExecutionReservation::Existing(response) => {
                complete_ai_opportunity_order(&app, &request, &response, true)?;
                return Ok(response);
            }
            ExecutionReservation::Reconcile(lease) => {
                match reconcile_order_by_client_id_with_retry(
                    &account,
                    &request.inst_id,
                    &cl_ord_id,
                    true,
                )
                .await
                {
                    Ok(Some(order)) => {
                        let result = OkxAlgoOrderResult {
                            algo_id: order.algo_id.clone(),
                            algo_cl_ord_id: order.algo_cl_ord_id.clone(),
                            s_code: "0".to_string(),
                            s_msg: "通过 algoClOrdId 对账确认订单已存在，未重复提交".to_string(),
                            ts: reconciliation_timestamp(&order),
                        };
                        let response_pos_side = fallback_pos_side(&order, body.pos_side.as_deref());
                        let operator = normalize_trade_operator(request.operator.as_ref());
                        upsert_submitted_algo_order(
                            &app,
                            &account,
                            &request,
                            &body,
                            &result,
                            fallback_order_side(&order, &side),
                            &response_pos_side,
                            &operator,
                        )?;
                        let response = reconciled_place_order_response(
                            &request,
                            &order,
                            &side,
                            body.pos_side.as_deref(),
                            body.reduce_only,
                            true,
                        );
                        finish_trade_execution(
                            &app,
                            &lease,
                            "accepted",
                            Some(&response.ord_id),
                            Some(&response),
                            None,
                        )?;
                        complete_ai_opportunity_order(&app, &request, &response, true)?;
                        return Ok(response);
                    }
                    Ok(None) => resume_trade_execution_after_reconciliation(&app, &lease)?,
                    Err(err) => {
                        finish_trade_execution(&app, &lease, "unknown", None, None, Some(&err))?;
                        return Err(format!(
                            "无法确认上次计划委托是否已提交，已阻止重复下单：{err}"
                        ));
                    }
                }
                lease
            }
        };
        claim_ai_opportunity_for_order(&app, &request)?;
        let rest_submit_started = Instant::now();
        let envelope = match okx_private_post::<OkxAlgoOrderResult, _>(
            &account,
            "/api/v5/trade/order-algo",
            &body,
        )
        .await
        {
            Ok(value) => value,
            Err(err) => {
                finish_trade_execution(&app, &execution_lease, "unknown", None, None, Some(&err))?;
                return Err(err);
            }
        };
        let rest_submit_ms = rest_submit_started.elapsed().as_millis() as i64;
        let result = envelope
            .data
            .into_iter()
            .next()
            .ok_or_else(|| "OKX 计划委托返回为空".to_string())?;
        if result.s_code != "0" {
            if is_duplicate_client_order_error(&result.s_code, &result.s_msg) {
                let error = format!(
                    "OKX 返回重复 algoClOrdId，订单结果需要按稳定 ID 对账：{}",
                    result.s_msg
                );
                finish_trade_execution(
                    &app,
                    &execution_lease,
                    "unknown",
                    None,
                    None,
                    Some(&error),
                )?;
                return Err(error);
            }
            finish_trade_execution(
                &app,
                &execution_lease,
                "rejected",
                optional_string(Some(result.algo_id.clone())).as_deref(),
                None,
                Some(&result.s_msg),
            )?;
            audit_trade_event(
                &app,
                &account,
                &request.inst_id,
                "order_submit",
                "place_algo_order",
                "rejected",
                Some(ord_type),
                Some(result.algo_id.as_str()),
                Some(result.algo_cl_ord_id.as_str()),
                Some(&side),
                body.pos_side.as_deref(),
                Some(&request.td_mode),
                Some(&request.size),
                Some(&request.price),
                normalize_trade_operator(request.operator.as_ref()).as_str(),
                optional_non_empty(&request.strategy_id),
                optional_non_empty(&request.session_id),
                request.confirmed_live == Some(true),
                Some(&result.s_code),
                Some(&result.s_msg),
                Some(&result.s_msg),
                json!({
                    "request": &request,
                    "okxBody": &body,
                    "transport": "rest_order_algo",
                    "latencyMs": {
                        "accountReady": account_ready_ms,
                        "instrumentReady": instrument_ready_ms,
                        "accountConfigReady": account_config_ready_ms,
                        "accountConfigCacheHit": account_config_cache_hit,
                        "restSubmit": rest_submit_ms,
                        "total": submit_started.elapsed().as_millis() as i64
                    }
                }),
                Some(json!(&result)),
            );
            fail_ai_opportunity_order(&app, &request, &result.s_msg);
            return Err(classified_okx_error(
                "okx_trade_order_algo",
                "计划委托",
                &result.s_code,
                &result.s_msg,
            ));
        }
        if let Err(error) = validate_algo_order_result_identity(&result, &cl_ord_id) {
            finish_trade_execution(&app, &execution_lease, "unknown", None, None, Some(&error))?;
            return Err(format!("{error}，已转入对账且禁止重复下单"));
        }
        let response_pos_side = body.pos_side.clone().unwrap_or_else(|| "net".to_string());
        let response_reduce_only = body.reduce_only.unwrap_or(false);
        let operator = normalize_trade_operator(request.operator.as_ref());
        upsert_submitted_algo_order(
            &app,
            &account,
            &request,
            &body,
            &result,
            &side,
            &response_pos_side,
            &operator,
        )?;
        audit_trade_event(
            &app,
            &account,
            &request.inst_id,
            "order_submit",
            "place_algo_order",
            "accepted",
            Some(ord_type),
            Some(&result.algo_id),
            Some(&result.algo_cl_ord_id),
            Some(&side),
            Some(&response_pos_side),
            Some(&request.td_mode),
            Some(&request.size),
            Some(&request.price),
            &operator,
            optional_non_empty(&request.strategy_id),
            optional_non_empty(&request.session_id),
            request.confirmed_live == Some(true),
            Some(&result.s_code),
            Some(&result.s_msg),
            None,
            json!({
                "request": &request,
                "okxBody": &body,
                "transport": "rest_order_algo",
                "latencyMs": {
                    "accountReady": account_ready_ms,
                    "instrumentReady": instrument_ready_ms,
                    "accountConfigReady": account_config_ready_ms,
                    "accountConfigCacheHit": account_config_cache_hit,
                    "restSubmit": rest_submit_ms,
                    "total": submit_started.elapsed().as_millis() as i64
                }
            }),
            Some(json!(&result)),
        );
        eprintln!(
            "trade_latency order_submit inst={} env={} transport=rest_order_algo cacheHit={} accountReadyMs={} instrumentReadyMs={} accountConfigReadyMs={} restSubmitMs={} totalMs={}",
            request.inst_id,
            account.environment,
            account_config_cache_hit,
            account_ready_ms,
            instrument_ready_ms,
            account_config_ready_ms,
            rest_submit_ms,
            submit_started.elapsed().as_millis()
        );
        let response = PlaceOrderResponse {
            ord_id: result.algo_id,
            cl_ord_id: result.algo_cl_ord_id,
            s_code: result.s_code,
            s_msg: result.s_msg,
            ts: result.ts,
            side,
            pos_side: response_pos_side,
            reduce_only: response_reduce_only,
            operator,
            strategy_id: optional_non_empty(&request.strategy_id),
            session_id: optional_non_empty(&request.session_id),
            opportunity_id: optional_non_empty(&request.opportunity_id),
            agent_run_id: optional_non_empty(&request.agent_run_id),
            execution_key: optional_non_empty(&request.execution_key),
        };
        finish_trade_execution(
            &app,
            &execution_lease,
            "accepted",
            optional_string(Some(response.ord_id.clone())).as_deref(),
            Some(&response),
            None,
        )?;
        complete_ai_opportunity_order(&app, &request, &response, true)?;
        return Ok(response);
    }
    let body = PlaceOrderBody {
        inst_id: request.inst_id.clone(),
        td_mode: request.td_mode.clone(),
        cl_ord_id: cl_ord_id.clone(),
        client_marker: exchange_client_marker(),
        side: side.clone(),
        pos_side,
        ord_type: ord_type.to_string(),
        sz: request.size.clone(),
        px: if ord_type == "market" {
            None
        } else {
            Some(request.price.clone())
        },
        reduce_only,
        attach_algo_ords: request
            .attach_algo_ords
            .clone()
            .filter(|items| !items.is_empty()),
    };
    let reservation = reserve_trade_execution(&app, &account, &request, &cl_ord_id)?;
    let execution_lease = match reservation {
        ExecutionReservation::New(lease) => lease,
        ExecutionReservation::Existing(response) => {
            complete_ai_opportunity_order(&app, &request, &response, false)?;
            return Ok(response);
        }
        ExecutionReservation::Reconcile(lease) => {
            match reconcile_order_by_client_id_with_retry(
                &account,
                &request.inst_id,
                &cl_ord_id,
                false,
            )
            .await
            {
                Ok(Some(order)) => {
                    let result = OkxOrderResult {
                        ord_id: order.ord_id.clone(),
                        cl_ord_id: order.cl_ord_id.clone(),
                        s_code: "0".to_string(),
                        s_msg: "通过 clOrdId 对账确认订单已存在，未重复提交".to_string(),
                        ts: reconciliation_timestamp(&order),
                    };
                    let response_pos_side = fallback_pos_side(&order, body.pos_side.as_deref());
                    let operator = normalize_trade_operator(request.operator.as_ref());
                    upsert_submitted_order(
                        &app,
                        &account,
                        &request,
                        &body,
                        &result,
                        fallback_order_side(&order, &side),
                        &response_pos_side,
                        &operator,
                    )?;
                    let response = reconciled_place_order_response(
                        &request,
                        &order,
                        &side,
                        body.pos_side.as_deref(),
                        body.reduce_only,
                        false,
                    );
                    finish_trade_execution(
                        &app,
                        &lease,
                        "accepted",
                        Some(&response.ord_id),
                        Some(&response),
                        None,
                    )?;
                    complete_ai_opportunity_order(&app, &request, &response, false)?;
                    return Ok(response);
                }
                Ok(None) => resume_trade_execution_after_reconciliation(&app, &lease)?,
                Err(err) => {
                    finish_trade_execution(&app, &lease, "unknown", None, None, Some(&err))?;
                    return Err(format!("无法确认上次委托是否已提交，已阻止重复下单：{err}"));
                }
            }
            lease
        }
    };
    claim_ai_opportunity_for_order(&app, &request)?;
    let ws_request_id = format!("ord{}", now_ms());
    let ws_body = okx_ws_trade_body(&body, &instrument, "下单")?;
    let ws_payload = json!({
        "id": ws_request_id,
        "op": "order",
        "args": [ws_body]
    });
    let before_ws_ms = submit_started.elapsed().as_millis() as i64;
    let ws_started = Instant::now();
    let ws_response = send_private_trade_command(runtime.inner(), &account, ws_payload).await;
    let ws_roundtrip_ms = ws_started.elapsed().as_millis() as i64;
    let mut ws_error: Option<String> = None;
    let mut fallback_reconcile_ms: Option<i64> = None;
    let mut fallback_rest_submit_ms: Option<i64> = None;
    let (result, transport_hint) = match ws_response {
        Ok(value) => {
            let data = value
                .get("data")
                .and_then(|item| item.as_array())
                .and_then(|items| items.first())
                .ok_or_else(|| "OKX WS 下单返回为空".to_string())?;
            (
                serde_json::from_value::<OkxOrderResult>(data.clone())
                    .map_err(|err| err.to_string())?,
                "ws",
            )
        }
        Err(ws_err) => {
            ws_error = Some(ws_err.clone());
            let reconcile_started = Instant::now();
            let reconcile_result = reconcile_order_by_client_id_with_retry(
                &account,
                &request.inst_id,
                &cl_ord_id,
                false,
            )
            .await;
            fallback_reconcile_ms = Some(reconcile_started.elapsed().as_millis() as i64);
            match reconcile_result {
                Ok(Some(order)) => {
                    let result = OkxOrderResult {
                        ord_id: order.ord_id.clone(),
                        cl_ord_id: order.cl_ord_id.clone(),
                        s_code: "0".to_string(),
                        s_msg: "WS 响应不明确，已通过 clOrdId 对账确认订单存在".to_string(),
                        ts: reconciliation_timestamp(&order),
                    };
                    let response_pos_side = fallback_pos_side(&order, body.pos_side.as_deref());
                    let operator = normalize_trade_operator(request.operator.as_ref());
                    upsert_submitted_order(
                        &app,
                        &account,
                        &request,
                        &body,
                        &result,
                        fallback_order_side(&order, &side),
                        &response_pos_side,
                        &operator,
                    )?;
                    let response = reconciled_place_order_response(
                        &request,
                        &order,
                        &side,
                        body.pos_side.as_deref(),
                        body.reduce_only,
                        false,
                    );
                    finish_trade_execution(
                        &app,
                        &execution_lease,
                        "accepted",
                        Some(&response.ord_id),
                        Some(&response),
                        None,
                    )?;
                    audit_trade_event(
                        &app,
                        &account,
                        &request.inst_id,
                        "order_submit",
                        "place_order",
                        "accepted",
                        Some(ord_type),
                        Some(&response.ord_id),
                        Some(&response.cl_ord_id),
                        Some(&response.side),
                        Some(&response_pos_side),
                        Some(&request.td_mode),
                        Some(&request.size),
                        body.px.as_deref(),
                        &operator,
                        optional_non_empty(&request.strategy_id),
                        optional_non_empty(&request.session_id),
                        request.confirmed_live == Some(true),
                        Some(&result.s_code),
                        Some(&result.s_msg),
                        None,
                        json!({
                            "request": &request,
                            "okxBody": &body,
                            "transport": "ws_reconciled",
                            "wsError": ws_error,
                            "latencyMs": {
                                "accountReady": account_ready_ms,
                                "instrumentReady": instrument_ready_ms,
                                "accountConfigReady": account_config_ready_ms,
                                "accountConfigCacheHit": account_config_cache_hit,
                                "beforeWs": before_ws_ms,
                                "wsRoundtrip": ws_roundtrip_ms,
                                "fallbackReconcile": fallback_reconcile_ms,
                                "total": submit_started.elapsed().as_millis() as i64
                            }
                        }),
                        Some(json!(&result)),
                    );
                    eprintln!(
                        "trade_latency order_submit inst={} env={} transport=ws_reconciled cacheHit={} accountReadyMs={} instrumentReadyMs={} accountConfigReadyMs={} beforeWsMs={} wsRoundtripMs={} fallbackReconcileMs={} totalMs={} wsError={}",
                        request.inst_id,
                        account.environment,
                        account_config_cache_hit,
                        account_ready_ms,
                        instrument_ready_ms,
                        account_config_ready_ms,
                        before_ws_ms,
                        ws_roundtrip_ms,
                        fallback_reconcile_ms.unwrap_or_default(),
                        submit_started.elapsed().as_millis(),
                        ws_error.as_deref().unwrap_or("")
                    );
                    complete_ai_opportunity_order(&app, &request, &response, false)?;
                    return Ok(response);
                }
                Ok(None) => {}
                Err(reconcile_err) => {
                    let error =
                        format!("WS 下单结果不明确且 OKX 对账失败：{ws_err}；{reconcile_err}");
                    finish_trade_execution(
                        &app,
                        &execution_lease,
                        "unknown",
                        None,
                        None,
                        Some(&error),
                    )?;
                    return Err(error);
                }
            }
            let rest_submit_started = Instant::now();
            let envelope = match okx_private_post::<OkxOrderResult, _>(
                &account,
                "/api/v5/trade/order",
                &body,
            )
            .await
            {
                Ok(value) => {
                    fallback_rest_submit_ms =
                        Some(rest_submit_started.elapsed().as_millis() as i64);
                    value
                }
                Err(err) => {
                    fallback_rest_submit_ms =
                        Some(rest_submit_started.elapsed().as_millis() as i64);
                    eprintln!(
                        "trade_latency order_submit inst={} env={} transport=rest_fallback_error cacheHit={} accountReadyMs={} instrumentReadyMs={} accountConfigReadyMs={} beforeWsMs={} wsRoundtripMs={} fallbackReconcileMs={} restSubmitMs={} totalMs={} wsError={} restError={}",
                        request.inst_id,
                        account.environment,
                        account_config_cache_hit,
                        account_ready_ms,
                        instrument_ready_ms,
                        account_config_ready_ms,
                        before_ws_ms,
                        ws_roundtrip_ms,
                        fallback_reconcile_ms.unwrap_or_default(),
                        fallback_rest_submit_ms.unwrap_or_default(),
                        submit_started.elapsed().as_millis(),
                        ws_error.as_deref().unwrap_or(""),
                        err
                    );
                    finish_trade_execution(
                        &app,
                        &execution_lease,
                        "unknown",
                        None,
                        None,
                        Some(&err),
                    )?;
                    return Err(err);
                }
            };
            (
                envelope
                    .data
                    .into_iter()
                    .next()
                    .ok_or_else(|| "OKX 下单返回为空".to_string())?,
                "rest_fallback",
            )
        }
    };
    if result.s_code != "0" {
        if is_duplicate_client_order_error(&result.s_code, &result.s_msg) {
            let error = format!(
                "OKX 返回重复 clOrdId，订单结果需要按稳定 ID 对账：{}",
                result.s_msg
            );
            finish_trade_execution(&app, &execution_lease, "unknown", None, None, Some(&error))?;
            return Err(error);
        }
        let classified_error = classified_order_rejection_with_required_margin(
            &request,
            &instrument,
            "okx_trade_order",
            "下单",
            &result.s_code,
            &result.s_msg,
        );
        finish_trade_execution(
            &app,
            &execution_lease,
            "rejected",
            optional_string(Some(result.ord_id.clone())).as_deref(),
            None,
            Some(&classified_error),
        )?;
        audit_trade_event(
            &app,
            &account,
            &request.inst_id,
            "order_submit",
            "place_order",
            "rejected",
            Some(ord_type),
            Some(result.ord_id.as_str()),
            Some(result.cl_ord_id.as_str()),
            Some(&side),
            body.pos_side.as_deref(),
            Some(&request.td_mode),
            Some(&request.size),
            body.px.as_deref(),
            normalize_trade_operator(request.operator.as_ref()).as_str(),
            optional_non_empty(&request.strategy_id),
            optional_non_empty(&request.session_id),
            request.confirmed_live == Some(true),
            Some(&result.s_code),
            Some(&result.s_msg),
            Some(&classified_error),
            json!({
                "request": &request,
                "okxBody": &body,
                "transport": transport_hint,
                "wsError": ws_error,
                "latencyMs": {
                    "accountReady": account_ready_ms,
                    "instrumentReady": instrument_ready_ms,
                    "accountConfigReady": account_config_ready_ms,
                    "accountConfigCacheHit": account_config_cache_hit,
                    "beforeWs": before_ws_ms,
                    "wsRoundtrip": ws_roundtrip_ms,
                    "fallbackReconcile": fallback_reconcile_ms,
                    "restSubmit": fallback_rest_submit_ms,
                    "total": submit_started.elapsed().as_millis() as i64
                }
            }),
            Some(json!(&result)),
        );
        fail_ai_opportunity_order(&app, &request, &result.s_msg);
        return Err(classified_error);
    }
    if let Err(error) = validate_order_result_identity(&result, &cl_ord_id) {
        finish_trade_execution(&app, &execution_lease, "unknown", None, None, Some(&error))?;
        return Err(format!("{error}，已转入对账且禁止重复下单"));
    }
    let response_pos_side = body.pos_side.clone().unwrap_or_else(|| "net".to_string());
    let response_reduce_only = body.reduce_only.unwrap_or(false);
    let operator = normalize_trade_operator(request.operator.as_ref());
    upsert_submitted_order(
        &app,
        &account,
        &request,
        &body,
        &result,
        &side,
        &response_pos_side,
        &operator,
    )?;
    audit_trade_event(
        &app,
        &account,
        &request.inst_id,
        "order_submit",
        "place_order",
        "accepted",
        Some(ord_type),
        Some(&result.ord_id),
        Some(&result.cl_ord_id),
        Some(&side),
        Some(&response_pos_side),
        Some(&request.td_mode),
        Some(&request.size),
        body.px.as_deref(),
        &operator,
        optional_non_empty(&request.strategy_id),
        optional_non_empty(&request.session_id),
        request.confirmed_live == Some(true),
        Some(&result.s_code),
        Some(&result.s_msg),
        None,
        json!({
            "request": &request,
            "okxBody": &body,
            "transport": transport_hint,
            "wsError": ws_error,
            "latencyMs": {
                "accountReady": account_ready_ms,
                "instrumentReady": instrument_ready_ms,
                "accountConfigReady": account_config_ready_ms,
                "accountConfigCacheHit": account_config_cache_hit,
                "beforeWs": before_ws_ms,
                "wsRoundtrip": ws_roundtrip_ms,
                "fallbackReconcile": fallback_reconcile_ms,
                "restSubmit": fallback_rest_submit_ms,
                "total": submit_started.elapsed().as_millis() as i64
            }
        }),
        Some(json!(&result)),
    );
    eprintln!(
        "trade_latency order_submit inst={} env={} transport={} cacheHit={} accountReadyMs={} instrumentReadyMs={} accountConfigReadyMs={} beforeWsMs={} wsRoundtripMs={} fallbackReconcileMs={} restSubmitMs={} totalMs={} wsError={}",
        request.inst_id,
        account.environment,
        transport_hint,
        account_config_cache_hit,
        account_ready_ms,
        instrument_ready_ms,
        account_config_ready_ms,
        before_ws_ms,
        ws_roundtrip_ms,
        fallback_reconcile_ms.unwrap_or_default(),
        fallback_rest_submit_ms.unwrap_or_default(),
        submit_started.elapsed().as_millis(),
        ws_error.as_deref().unwrap_or("")
    );
    let response = PlaceOrderResponse {
        ord_id: result.ord_id,
        cl_ord_id: result.cl_ord_id,
        s_code: result.s_code,
        s_msg: result.s_msg,
        ts: result.ts,
        side,
        pos_side: response_pos_side,
        reduce_only: response_reduce_only,
        operator,
        strategy_id: optional_non_empty(&request.strategy_id),
        session_id: optional_non_empty(&request.session_id),
        opportunity_id: optional_non_empty(&request.opportunity_id),
        agent_run_id: optional_non_empty(&request.agent_run_id),
        execution_key: optional_non_empty(&request.execution_key),
    };
    finish_trade_execution(
        &app,
        &execution_lease,
        "accepted",
        optional_string(Some(response.ord_id.clone())).as_deref(),
        Some(&response),
        None,
    )?;
    complete_ai_opportunity_order(&app, &request, &response, false)?;
    Ok(response)
}

fn bind_ai_place_order_to_opportunity(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    request: &mut PlaceOrderRequest,
) -> Result<(), String> {
    let operator = normalize_trade_operator(request.operator.as_ref());
    if operator != "ai" {
        return Ok(());
    }
    request.agent_run_id = optional_non_empty(&request.agent_run_id)
        .or_else(|| optional_non_empty(&request.session_id));
    if request
        .opportunity_id
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        request.opportunity_id =
            optional_non_empty(&request.strategy_id).filter(|value| value.starts_with("opp"));
    }
    let increases_risk = !request.ticket_mode.eq_ignore_ascii_case("close")
        && !request.action.to_ascii_lowercase().starts_with("close-");
    let Some(opportunity_id) = optional_non_empty(&request.opportunity_id) else {
        if increases_risk {
            return Err("AI 风险增加下单必须绑定已批准的 opportunityId".to_string());
        }
        if request.reason.as_deref().unwrap_or("").trim().is_empty() {
            return Err("AI 风险降低下单必须提供 reason".to_string());
        }
        let run_id = request
            .agent_run_id
            .as_deref()
            .or(request.session_id.as_deref())
            .unwrap_or("interactive");
        request.execution_leg = Some("primary".to_string());
        request.execution_key = Some(format!(
            "agent:{}:place_order:{}:{}:primary",
            run_id, request.inst_id, request.action
        ));
        return Ok(());
    };

    let conn = open_database(app)?;
    let opportunity = load_trade_opportunity(&conn, &opportunity_id)?;
    if opportunity
        .expires_at
        .is_some_and(|expires_at| expires_at <= now_ms())
    {
        return Err("绑定的交易机会已过期".to_string());
    }
    if request
        .opportunity_revision
        .is_some_and(|revision| revision != opportunity.revision)
    {
        return Err(format!(
            "交易机会版本已变化：请求 revision={}，当前 revision={}",
            request.opportunity_revision.unwrap_or_default(),
            opportunity.revision
        ));
    }
    if let (Some(expected_run), Some(actual_run)) = (
        optional_string(opportunity.agent_run_id.clone()),
        optional_non_empty(&request.agent_run_id),
    ) {
        if expected_run != actual_run {
            return Err("交易机会与当前 Agent Run 不匹配".to_string());
        }
    }
    if increases_risk && !matches!(opportunity.status.as_str(), "approved" | "executing") {
        return Err(format!(
            "AI 风险增加下单要求交易机会已批准，当前状态：{}",
            opportunity.status
        ));
    }
    if opportunity.environment != request.environment
        || opportunity.inst_id != request.inst_id
        || opportunity.action != request.action
        || opportunity.td_mode != request.td_mode
        || opportunity.account_id.as_deref() != Some(account.id.as_str())
    {
        return Err("下单参数与绑定交易机会不一致".to_string());
    }
    if increases_risk {
        let size_matches = normalize_fingerprint_number(&opportunity.size)
            == normalize_fingerprint_number(&request.size);
        let lever_matches = opportunity
            .lever
            .as_deref()
            .map(normalize_fingerprint_number)
            .unwrap_or_else(|| "1".to_string())
            == normalize_fingerprint_number(&request.lever);
        let order_type_matches = opportunity.order_type == request.order_type;
        let price_matches = request.order_type == "market"
            || opportunity
                .price
                .as_deref()
                .map(normalize_fingerprint_number)
                .unwrap_or_default()
                == normalize_fingerprint_number(&request.price);
        if !size_matches || !lever_matches || !order_type_matches || !price_matches {
            return Err("风险增加下单的数量、杠杆、订单类型或价格与交易机会不一致".to_string());
        }
    }
    request.strategy_id = Some(opportunity_id.clone());
    request.opportunity_id = Some(opportunity_id);
    request.opportunity_revision = Some(opportunity.revision);
    request.agent_run_id = request
        .agent_run_id
        .clone()
        .or(opportunity.agent_run_id.clone());
    request.reason =
        optional_non_empty(&request.reason).or_else(|| Some(opportunity.reason.clone()));
    request.execution_leg = Some("primary".to_string());
    request.execution_key = Some(trade_opportunity_execution_key(&opportunity));
    Ok(())
}

fn okx_ws_trade_body<T: Serialize>(
    body: &T,
    instrument: &OkxInstrument,
    operation_label: &str,
) -> Result<serde_json::Value, String> {
    let inst_id_code = instrument.inst_id_code.trim();
    if inst_id_code.is_empty() {
        return Err(format!(
            "OKX WS {}缺少 instIdCode，请刷新交易对资源后重试：{}",
            operation_label, instrument.inst_id
        ));
    }
    let mut value = serde_json::to_value(body).map_err(|err| err.to_string())?;
    let Some(object) = value.as_object_mut() else {
        return Err(format!("OKX WS {}请求体格式无效", operation_label));
    };
    let inst_id_code_value = inst_id_code
        .parse::<i64>()
        .map(serde_json::Value::from)
        .unwrap_or_else(|_| serde_json::Value::String(inst_id_code.to_string()));
    object.insert("instIdCode".to_string(), inst_id_code_value);
    Ok(value)
}

async fn ensure_trade_account_cached(
    runtime: &MarketRuntime,
    account: &LocalAccount,
    environment: &str,
) -> Result<bool, String> {
    if account.exchange.to_lowercase() != "okx" {
        return Err(format!("不支持的交易所：{}", account.exchange));
    }
    if normalize_environment(&account.environment) != normalize_environment(environment) {
        return Err("账号环境与当前交易环境不一致".to_string());
    }
    if !account.permissions.trade {
        return Err("账号未开启交易权限".to_string());
    }
    let (config, cache_hit) = cached_okx_account_config(runtime, account).await?;
    if !config.perm.split(',').any(|perm| perm.trim() == "trade") {
        return Err("OKX API Key 未包含 trade 权限".to_string());
    }
    Ok(cache_hit)
}

fn claim_ai_opportunity_for_order(
    app: &tauri::AppHandle,
    request: &PlaceOrderRequest,
) -> Result<(), String> {
    if normalize_trade_operator(request.operator.as_ref()) != "ai" {
        return Ok(());
    }
    let Some(opportunity_id) = optional_non_empty(&request.opportunity_id) else {
        return Ok(());
    };
    let execution_key = optional_non_empty(&request.execution_key)
        .ok_or_else(|| "绑定交易机会的 AI 下单缺少稳定 executionKey".to_string())?;
    let revision = request
        .opportunity_revision
        .ok_or_else(|| "绑定交易机会的 AI 下单缺少 opportunityRevision".to_string())?;
    let conn = open_database(app)?;
    let changed = conn
        .execute(
            "UPDATE trade_opportunities
             SET status='executing',execution_key=?3,updated_at=?4
             WHERE id=?1 AND revision=?2 AND status='approved'
               AND (expires_at IS NULL OR expires_at>?4)",
            params![opportunity_id, revision, execution_key, now_ms()],
        )
        .map_err(|err| err.to_string())?;
    if changed == 1 {
        return Ok(());
    }
    let current = load_trade_opportunity(&conn, &opportunity_id)?;
    if current.revision == revision
        && current.execution_key.as_deref() == Some(execution_key.as_str())
        && matches!(
            current.status.as_str(),
            "executing" | "submitted" | "partially_filled" | "executed"
        )
    {
        return Ok(());
    }
    Err(format!(
        "交易机会已被其他执行路径认领或状态不允许下单：{}",
        current.status
    ))
}

fn complete_ai_opportunity_order(
    app: &tauri::AppHandle,
    request: &PlaceOrderRequest,
    response: &PlaceOrderResponse,
    is_algo: bool,
) -> Result<(), String> {
    if normalize_trade_operator(request.operator.as_ref()) != "ai" {
        return Ok(());
    }
    let (Some(opportunity_id), Some(execution_key)) = (
        optional_non_empty(&request.opportunity_id),
        optional_non_empty(&request.execution_key),
    ) else {
        return Ok(());
    };
    let conn = open_database(app)?;
    conn.execute(
        "UPDATE trade_opportunities
         SET status='submitted',execution_result_json=?3,
             order_id=CASE WHEN ?4=0 THEN ?5 ELSE order_id END,
             client_order_id=CASE WHEN ?4=0 THEN ?6 ELSE client_order_id END,
             algo_id=CASE WHEN ?4=1 THEN ?5 ELSE algo_id END,
             algo_client_order_id=CASE WHEN ?4=1 THEN ?6 ELSE algo_client_order_id END,
             error=NULL,updated_at=?7
         WHERE id=?1 AND execution_key=?2 AND status IN ('executing','submitted')",
        params![
            opportunity_id,
            execution_key,
            serde_json::to_string(response).map_err(|err| err.to_string())?,
            if is_algo { 1 } else { 0 },
            response.ord_id,
            response.cl_ord_id,
            now_ms(),
        ],
    )
    .map_err(|err| err.to_string())?;
    let final_order_state = request.account_id.as_deref().and_then(|account_id| {
        conn.query_row(
            "SELECT state,acc_fill_sz FROM okx_orders
             WHERE account_id=?1 AND environment=?2
               AND (ord_id=?3 OR (?4<>'' AND cl_ord_id=?4))
             ORDER BY synced_at DESC LIMIT 1",
            params![
                account_id,
                request.environment,
                response.ord_id,
                response.cl_ord_id
            ],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()
        .ok()
        .flatten()
    });
    if let Some((state, accumulated_fill)) = final_order_state {
        if let Some(next_status) =
            opportunity_status_from_order_state(state.as_deref(), accumulated_fill.as_deref())
        {
            let changed = conn
                .execute(
                    "UPDATE trade_opportunities SET status=?3,updated_at=?4
                     WHERE id=?1 AND execution_key=?2 AND status IN ('executing','submitted','partially_filled')",
                    params![opportunity_id, execution_key, next_status, now_ms()],
                )
                .map_err(|err| err.to_string())?;
            if changed == 1 {
                let _ = crate::ai_automation::record_domain_event_with_conn(
                    &conn,
                    &desic_agent_automation::DomainEvent {
                        event_type: "opportunity_state_changed".to_string(),
                        account_id: optional_non_empty(&request.account_id),
                        inst_id: Some(request.inst_id.clone()),
                        opportunity_id: Some(opportunity_id),
                        state: Some(next_status.to_string()),
                        occurred_at: now_ms(),
                        ..Default::default()
                    },
                    json!({ "ordId": response.ord_id, "clOrdId": response.cl_ord_id, "source": "local-submit-final-state" }),
                );
            }
        }
    }
    Ok(())
}

fn fail_ai_opportunity_order(app: &tauri::AppHandle, request: &PlaceOrderRequest, error: &str) {
    if normalize_trade_operator(request.operator.as_ref()) != "ai" {
        return;
    }
    let (Some(opportunity_id), Some(execution_key)) = (
        optional_non_empty(&request.opportunity_id),
        optional_non_empty(&request.execution_key),
    ) else {
        return;
    };
    let Ok(conn) = open_database(app) else {
        return;
    };
    let _ = conn.execute(
        "UPDATE trade_opportunities SET status='failed',error=?3,updated_at=?4
         WHERE id=?1 AND execution_key=?2 AND status='executing'",
        params![opportunity_id, execution_key, error, now_ms()],
    );
}

fn validate_ai_risk_increase_opportunity(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    environment: &str,
    inst_id: &str,
    opportunity_id: Option<&str>,
    opportunity_revision: Option<i64>,
    agent_run_id: Option<&str>,
) -> Result<TradeOpportunitySummary, String> {
    let opportunity_id = opportunity_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "AI 风险增加操作必须提供 opportunityId".to_string())?;
    let conn = open_database(app)?;
    let opportunity = load_trade_opportunity(&conn, opportunity_id)?;
    if opportunity
        .expires_at
        .is_some_and(|expires_at| expires_at <= now_ms())
    {
        return Err("绑定的交易机会已过期".to_string());
    }
    if !matches!(opportunity.status.as_str(), "approved" | "executing") {
        return Err(format!(
            "风险增加操作要求交易机会已批准，当前状态：{}",
            opportunity.status
        ));
    }
    if opportunity_revision.is_some_and(|revision| revision != opportunity.revision) {
        return Err(format!(
            "交易机会版本已变化，当前 revision={}",
            opportunity.revision
        ));
    }
    if opportunity.environment != environment
        || opportunity.inst_id != inst_id
        || opportunity.account_id.as_deref() != Some(account.id.as_str())
    {
        return Err("风险增加操作与绑定交易机会的账号、环境或交易品种不一致".to_string());
    }
    if let (Some(expected), Some(actual)) = (
        optional_string(opportunity.agent_run_id.clone()),
        agent_run_id
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    ) {
        if expected != actual {
            return Err("交易机会与当前 Agent Run 不匹配".to_string());
        }
    }
    Ok(opportunity)
}

fn stable_client_order_id(execution_key: &str) -> String {
    let digest = sha256_hex(execution_key.as_bytes());
    format!("dt{}", digest.get(..28).unwrap_or(&digest))
}

fn validate_order_identity_fields(
    order_id: &str,
    client_order_id: &str,
    expected_client_order_id: &str,
    kind: &str,
) -> Result<(), String> {
    if order_id.trim().is_empty() {
        return Err(format!("OKX {kind}成功响应缺少可对账订单 ID"));
    }
    if client_order_id.trim() != expected_client_order_id.trim() {
        return Err(format!(
            "OKX {kind}成功响应的客户端订单 ID 与本次稳定 ID 不一致"
        ));
    }
    Ok(())
}

fn validate_order_result_identity(
    result: &OkxOrderResult,
    expected_client_order_id: &str,
) -> Result<(), String> {
    validate_order_identity_fields(
        &result.ord_id,
        &result.cl_ord_id,
        expected_client_order_id,
        "普通委托",
    )
}

fn validate_algo_order_result_identity(
    result: &OkxAlgoOrderResult,
    expected_client_order_id: &str,
) -> Result<(), String> {
    validate_order_identity_fields(
        &result.algo_id,
        &result.algo_cl_ord_id,
        expected_client_order_id,
        "计划委托",
    )
}

fn validate_place_order_response_identity(
    response: &PlaceOrderResponse,
    expected_client_order_id: &str,
    is_algo: bool,
) -> Result<(), String> {
    validate_order_identity_fields(
        &response.ord_id,
        &response.cl_ord_id,
        expected_client_order_id,
        if is_algo {
            "计划委托"
        } else {
            "普通委托"
        },
    )
}

enum ExecutionReservation<T> {
    New(NormalExecutionLease),
    Existing(T),
    Reconcile(NormalExecutionLease),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NormalExecutionLease {
    execution_key: String,
    operation: String,
    owner_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AlgoExecutionLease {
    execution_key: String,
    operation: String,
    owner_token: String,
}

enum AlgoExecutionReservation<T> {
    New(AlgoExecutionLease),
    Existing(T),
    Reconcile(AlgoExecutionLease),
}

const ALGO_EXECUTION_LEASE_MS: i64 = 120_000;
const ALGO_EXECUTION_RESCAN_MAX_DELAY_MS: i64 = 120_000;
const ALGO_EXECUTION_LEASE_LOST: &str = "ALGO_EXECUTION_LEASE_LOST";
const ALGO_EXECUTION_PROJECTION_PENDING: &str = "ALGO_EXECUTION_PROJECTION_PENDING";
const NORMAL_EXECUTION_LEASE_MS: i64 = 240_000;
const NORMAL_EXECUTION_LEASE_LOST: &str = "NORMAL_EXECUTION_LEASE_LOST";
static ALGO_EXECUTION_OWNER_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static NORMAL_EXECUTION_OWNER_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn new_normal_execution_owner_token(execution_key: &str, operation: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let sequence = NORMAL_EXECUTION_OWNER_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let material = format!(
        "{}:{nanos}:{sequence}:{operation}:{execution_key}",
        std::process::id()
    );
    format!("normal-{}", &sha256_hex(material.as_bytes())[..32])
}

fn new_algo_execution_owner_token(execution_key: &str, operation: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let sequence = ALGO_EXECUTION_OWNER_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let material = format!(
        "{}:{nanos}:{sequence}:{operation}:{execution_key}",
        std::process::id()
    );
    format!("algo-{}", &sha256_hex(material.as_bytes())[..32])
}

fn execution_credential_matches(stored_fingerprint: &str, account: &LocalAccount) -> bool {
    !stored_fingerprint.trim().is_empty()
        && stored_fingerprint == account_config_cache_fingerprint(account)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeExecutionGuardsRequest {
    account_id: Option<String>,
    environment: String,
    inst_id: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TradeExecutionGuard {
    execution_key: String,
    operation: String,
    status: String,
    inst_id: String,
    action: String,
    size: Option<String>,
    message: String,
    updated_at: i64,
    scope_uncertain: bool,
    credential_matches: bool,
}

const UNRESOLVED_TRADE_EXECUTION_GUARDS_SQL: &str =
    "SELECT execution_key,operation,status,request_json,error,updated_at,credential_fingerprint
     FROM trade_execution_attempts
     WHERE account_id=?1
       AND CASE WHEN lower(environment) IN ('demo','simulated') THEN 'demo' ELSE 'live' END=?2
       AND operation IN ('place_order','amend_order','place_algo_order','amend_algo_order')
       AND (
         status IN ('submitting','reconciling','unknown','blocked')
         OR (status='accepted' AND projection_status IN ('pending','blocked'))
       )
     ORDER BY updated_at DESC";

const PENDING_ALGO_EXECUTION_ROWS_SQL: &str =
    "SELECT execution_key,account_id,environment,credential_fingerprint,
            client_order_id,request_json
     FROM trade_execution_attempts
     WHERE operation=?1 AND status IN ('submitting','reconciling','unknown')
     ORDER BY created_at ASC";

pub(crate) fn unresolved_trade_execution_guards_for_scope(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    inst_id: &str,
    excluding_execution_key: Option<&str>,
) -> Result<Vec<TradeExecutionGuard>, String> {
    let conn = open_database(app)?;
    unresolved_trade_execution_guards_for_scope_with_conn(
        &conn,
        account,
        inst_id,
        excluding_execution_key,
    )
}

fn unresolved_trade_execution_guards_for_scope_with_conn(
    conn: &Connection,
    account: &LocalAccount,
    inst_id: &str,
    excluding_execution_key: Option<&str>,
) -> Result<Vec<TradeExecutionGuard>, String> {
    let target_inst_id = inst_id.trim();
    if target_inst_id.is_empty() {
        return Err("交易品种不能为空".to_string());
    }
    let mut stmt = conn
        .prepare(UNRESOLVED_TRADE_EXECUTION_GUARDS_SQL)
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(
            params![account.id, normalize_environment(&account.environment)],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                ))
            },
        )
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    let mut guards = Vec::new();
    for (
        execution_key,
        operation,
        status,
        request_json,
        error,
        updated_at,
        credential_fingerprint,
    ) in rows
    {
        if excluding_execution_key.is_some_and(|excluded| excluded == execution_key) {
            continue;
        }
        let request = serde_json::from_str::<serde_json::Value>(&request_json).ok();
        let stored_inst_id = request
            .as_ref()
            .and_then(|value| value.get("instId"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let scope_uncertain = stored_inst_id.is_none();
        if stored_inst_id.is_some_and(|value| !value.eq_ignore_ascii_case(target_inst_id)) {
            continue;
        }
        let action = request
            .as_ref()
            .and_then(|value| value.get("action"))
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(
                if matches!(operation.as_str(), "amend_order" | "amend_algo_order") {
                    "amend"
                } else {
                    "unknown"
                },
            )
            .to_string();
        let size = request
            .as_ref()
            .and_then(|value| value.get("size").or_else(|| value.get("newSize")))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let credential_matches = execution_credential_matches(&credential_fingerprint, account);
        let mut message = error.unwrap_or_else(|| "执行结果尚未完成对账".to_string());
        if scope_uncertain {
            message = format!("执行快照无法确认交易品种；{message}");
        }
        if !credential_matches {
            message = format!("账号凭据已变化或旧记录未绑定凭据；{message}");
        }
        guards.push(TradeExecutionGuard {
            execution_key,
            operation,
            status,
            inst_id: stored_inst_id.unwrap_or(target_inst_id).to_string(),
            action,
            size,
            message,
            updated_at,
            scope_uncertain,
            credential_matches,
        });
    }
    Ok(guards)
}

fn ensure_risk_increase_scope_available_with_conn(
    conn: &Connection,
    account: &LocalAccount,
    inst_id: &str,
    excluding_execution_key: Option<&str>,
    operation_label: &str,
) -> Result<(), String> {
    let unresolved = unresolved_trade_execution_guards_for_scope_with_conn(
        conn,
        account,
        inst_id,
        excluding_execution_key,
    )?;
    if !unresolved.is_empty() {
        let keys = unresolved
            .iter()
            .map(|item| format!("{}({})", item.execution_key, item.status))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "当前账号与品种存在未完成对账的交易执行，已阻止{operation_label}：{keys}"
        ));
    }
    if crate::instrument_operations::has_unresolved_instrument_operations_for_scope_with_conn(
        conn, account, inst_id,
    )? {
        return Err(format!(
            "当前账号与品种存在未终态紧急操作，已阻止{operation_label}"
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn okx_trade_execution_guards(
    app: tauri::AppHandle,
    request: TradeExecutionGuardsRequest,
) -> Result<Vec<TradeExecutionGuard>, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    if normalize_environment(&account.environment) != normalize_environment(&request.environment) {
        return Err("账号环境与当前交易环境不一致".to_string());
    }
    unresolved_trade_execution_guards_for_scope(&app, &account, &request.inst_id, None)
}

#[tauri::command]
pub async fn okx_reconcile_trade_execution_guards(
    app: tauri::AppHandle,
    request: TradeExecutionGuardsRequest,
) -> Result<Vec<TradeExecutionGuard>, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    if normalize_environment(&account.environment) != normalize_environment(&request.environment) {
        return Err("账号环境与当前交易环境不一致".to_string());
    }
    let _trade_mutation_guard = TRADE_MUTATION_LOCK.lock().await;
    recover_pending_trade_executions(&app).await?;
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    unresolved_trade_execution_guards_for_scope(&app, &account, &request.inst_id, None)
}

fn execution_request_signature_matches(
    stored_request_json: &str,
    request: &PlaceOrderRequest,
) -> Result<bool, String> {
    let stored_request = serde_json::from_str::<serde_json::Value>(stored_request_json)
        .map_err(|err| format!("executionKey 的历史请求快照损坏：{err}"))?;
    let current_request = serde_json::to_value(request).map_err(|err| err.to_string())?;
    Ok(stored_request == current_request)
}

fn reserve_trade_execution(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    request: &PlaceOrderRequest,
    client_order_id: &str,
) -> Result<ExecutionReservation<PlaceOrderResponse>, String> {
    let Some(execution_key) = optional_non_empty(&request.execution_key) else {
        return Err("下单缺少稳定 executionKey，无法建立跨进程执行租约".to_string());
    };
    let mut conn = open_database(app)?;
    let now = now_ms();
    let operation = "place_order";
    let owner_token = new_normal_execution_owner_token(&execution_key, operation);
    let lease_expires_at = now.saturating_add(NORMAL_EXECUTION_LEASE_MS);
    let transaction = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|err| err.to_string())?;
    ensure_account_snapshot_current(app, account)?;
    if request.ticket_mode == "open" {
        ensure_risk_increase_scope_available_with_conn(
            &transaction,
            account,
            &request.inst_id,
            Some(&execution_key),
            "新开仓",
        )?;
    }
    let inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO trade_execution_attempts (
              execution_key, opportunity_id, agent_run_id, account_id, environment,
              credential_fingerprint, operation, client_order_id, status, request_json,
              owner_token, lease_expires_at, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'place_order', ?7, 'submitting', ?8, ?9, ?10, ?11, ?11)",
            params![
                execution_key,
                optional_non_empty(&request.opportunity_id),
                optional_non_empty(&request.agent_run_id),
                account.id,
                account.environment,
                account_config_cache_fingerprint(account),
                client_order_id,
                serde_json::to_string(request).map_err(|err| err.to_string())?,
                owner_token,
                lease_expires_at,
                now,
            ],
        )
        .map_err(|err| err.to_string())?;
    if inserted == 1 {
        transaction.commit().map_err(|err| err.to_string())?;
        return Ok(ExecutionReservation::New(NormalExecutionLease {
            execution_key,
            operation: operation.to_string(),
            owner_token,
        }));
    }
    let (
        operation,
        stored_account_id,
        stored_environment,
        stored_credential_fingerprint,
        stored_client_order_id,
        stored_request_json,
        status,
        response_json,
        error,
        _updated_at,
        stored_lease_expires_at,
    ) = transaction
        .query_row(
            "SELECT operation, account_id, environment, credential_fingerprint, client_order_id,
                    request_json, status, response_json, error, updated_at, lease_expires_at
             FROM trade_execution_attempts
             WHERE execution_key = ?1",
            [execution_key.as_str()],
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
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, i64>(10)?,
                ))
            },
        )
        .map_err(|err| err.to_string())?;
    if !execution_credential_matches(&stored_credential_fingerprint, account) {
        return Err(
            "executionKey 绑定的账号凭据已变化或旧记录未绑定凭据，已阻止提交与自动对账".to_string(),
        );
    }
    let request_signature_matches =
        execution_request_signature_matches(&stored_request_json, request)?;
    if operation != "place_order"
        || stored_account_id != account.id
        || normalize_environment(&stored_environment) != normalize_environment(&account.environment)
        || stored_client_order_id != client_order_id
        || !request_signature_matches
    {
        return Err("executionKey 已被其他交易动作占用，已阻止提交".to_string());
    }
    if status == "accepted" {
        let response = response_json
            .as_deref()
            .ok_or_else(|| "幂等执行已完成但缺少响应快照".to_string())
            .and_then(|value| {
                serde_json::from_str::<PlaceOrderResponse>(value).map_err(|err| err.to_string())
            })?;
        validate_place_order_response_identity(
            &response,
            client_order_id,
            is_algo_order_type(&request.order_type),
        )?;
        transaction.commit().map_err(|err| err.to_string())?;
        return Ok(ExecutionReservation::Existing(response));
    }
    if status == "confirmed_missing" {
        let resumed = transaction
            .execute(
                "UPDATE trade_execution_attempts SET status='submitting',agent_run_id=?2,request_json=?3,
                 owner_token=?4,lease_expires_at=?5,error=NULL,updated_at=?6
                 WHERE execution_key=?1 AND operation='place_order' AND status='confirmed_missing'",
                params![
                    execution_key,
                    optional_non_empty(&request.agent_run_id),
                    serde_json::to_string(request).map_err(|err| err.to_string())?,
                    owner_token,
                    lease_expires_at,
                    now,
                ],
            )
            .map_err(|err| err.to_string())?;
        if resumed == 1 {
            transaction.commit().map_err(|err| err.to_string())?;
            return Ok(ExecutionReservation::New(NormalExecutionLease {
                execution_key,
                operation: operation.to_string(),
                owner_token,
            }));
        }
    }
    if matches!(status.as_str(), "submitting" | "reconciling" | "unknown")
        && stored_lease_expires_at <= now
    {
        let claimed = transaction
            .execute(
                "UPDATE trade_execution_attempts
                 SET status='reconciling',owner_token=?2,lease_expires_at=?3,error=NULL,updated_at=?4
                 WHERE execution_key=?1 AND operation='place_order'
                   AND status IN ('submitting','reconciling','unknown') AND lease_expires_at<=?4",
                params![execution_key, owner_token, lease_expires_at, now],
            )
            .map_err(|err| err.to_string())?;
        if claimed == 1 {
            transaction.commit().map_err(|err| err.to_string())?;
            return Ok(ExecutionReservation::Reconcile(NormalExecutionLease {
                execution_key,
                operation: operation.to_string(),
                owner_token,
            }));
        }
    }
    Err(format!(
        "相同 executionKey 已存在，已阻止重复下单：status={}{}",
        status,
        error
            .map(|value| format!("，error={value}"))
            .unwrap_or_default()
    ))
}

pub(crate) async fn recover_pending_trade_executions(
    app: &tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let algo_projection_before = repair_pending_algo_execution_projections(app)?;
    let attempts = {
        let conn = open_database(app)?;
        let mut stmt = conn
            .prepare(
                "SELECT e.execution_key,e.account_id,e.environment,e.credential_fingerprint,
                        e.client_order_id,e.request_json,e.status,e.response_json,e.opportunity_id
                 FROM trade_execution_attempts e
                 LEFT JOIN trade_opportunities o ON o.id=e.opportunity_id
                 WHERE e.operation='place_order' AND (
                   e.status IN ('submitting','reconciling','unknown')
                   OR (e.status='accepted' AND o.status='executing')
                 )
                 ORDER BY e.created_at ASC",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                ))
            })
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        rows
    };

    let mut recovered = 0_u32;
    let mut confirmed_missing = 0_u32;
    let mut unknown = 0_u32;
    let mut deferred = 0_u32;
    for (
        execution_key,
        account_id,
        environment,
        credential_fingerprint,
        client_order_id,
        request_json,
        status,
        response_json,
        opportunity_id,
    ) in attempts
    {
        if status == "accepted" {
            let request = match serde_json::from_str::<PlaceOrderRequest>(&request_json) {
                Ok(request) => request,
                Err(err) => {
                    let conn = open_database(app)?;
                    conn.execute(
                        "UPDATE trade_execution_attempts
                         SET status='blocked',error=?2,updated_at=?3
                         WHERE execution_key=?1 AND operation='place_order' AND status='accepted'",
                        params![
                            execution_key,
                            format!("accepted 执行请求快照损坏，禁止自动恢复：{err}"),
                            now_ms(),
                        ],
                    )
                    .map_err(|db_err| db_err.to_string())?;
                    unknown = unknown.saturating_add(1);
                    continue;
                }
            };
            match response_json
                .as_deref()
                .ok_or_else(|| "accepted 执行记录缺少 response_json".to_string())
                .and_then(|value| {
                    serde_json::from_str::<PlaceOrderResponse>(value).map_err(|err| err.to_string())
                })
                .and_then(|response| {
                    validate_place_order_response_identity(
                        &response,
                        &client_order_id,
                        is_algo_order_type(&request.order_type),
                    )?;
                    Ok(response)
                }) {
                Ok(response) => {
                    complete_ai_opportunity_order(
                        app,
                        &request,
                        &response,
                        is_algo_order_type(&request.order_type),
                    )?;
                    recovered = recovered.saturating_add(1);
                }
                Err(err) => {
                    let conn = open_database(app)?;
                    conn.execute(
                        "UPDATE trade_execution_attempts
                         SET status='blocked',error=?2,updated_at=?3
                         WHERE execution_key=?1 AND operation='place_order' AND status='accepted'",
                        params![
                            execution_key,
                            format!("accepted 执行响应损坏，禁止自动恢复：{err}"),
                            now_ms(),
                        ],
                    )
                    .map_err(|db_err| db_err.to_string())?;
                    unknown = unknown.saturating_add(1);
                }
            }
            continue;
        }
        let Some(lease) = claim_pending_normal_execution(app, &execution_key, "place_order")?
        else {
            deferred = deferred.saturating_add(1);
            continue;
        };
        let request = match serde_json::from_str::<PlaceOrderRequest>(&request_json) {
            Ok(request) => request,
            Err(err) => {
                finish_trade_execution(
                    app,
                    &lease,
                    "blocked",
                    None,
                    None,
                    Some(&format!("无法解析崩溃恢复请求：{err}")),
                )?;
                let conn = open_database(app)?;
                if let Some(opportunity_id) = opportunity_id.as_deref() {
                    conn.execute(
                        "UPDATE trade_opportunities SET status='recovery_blocked',error=?2,updated_at=?3
                         WHERE id=?1 AND status='executing'",
                        params![opportunity_id, format!("执行快照损坏，禁止自动重试：{err}"), now_ms()],
                    )
                    .map_err(|db_err| db_err.to_string())?;
                }
                unknown = unknown.saturating_add(1);
                continue;
            }
        };
        let account = match load_local_account_secret(app, Some(&account_id)) {
            Ok(account)
                if normalize_environment(&account.environment)
                    == normalize_environment(&environment) =>
            {
                account
            }
            Ok(_) => {
                finish_trade_execution(
                    app,
                    &lease,
                    "unknown",
                    None,
                    None,
                    Some("账号环境已变化，无法安全对账"),
                )?;
                unknown = unknown.saturating_add(1);
                continue;
            }
            Err(err) => {
                finish_trade_execution(
                    app,
                    &lease,
                    "unknown",
                    None,
                    None,
                    Some(&format!("无法读取账号凭据进行对账：{err}")),
                )?;
                unknown = unknown.saturating_add(1);
                continue;
            }
        };
        if !execution_credential_matches(&credential_fingerprint, &account) {
            finish_trade_execution(
                app,
                &lease,
                "unknown",
                None,
                None,
                Some("账号凭据已变化或旧执行记录未绑定凭据，禁止使用当前凭据自动对账"),
            )?;
            unknown = unknown.saturating_add(1);
            continue;
        }
        let is_algo = is_algo_order_type(&request.order_type);
        match reconcile_order_by_client_id_with_retry(
            &account,
            &request.inst_id,
            &client_order_id,
            is_algo,
        )
        .await
        {
            Ok(Some(order)) => {
                let (fallback_side, fallback_pos_side, fallback_reduce_only) =
                    recovery_action_defaults(&request.action);
                let response = reconciled_place_order_response(
                    &request,
                    &order,
                    fallback_side,
                    fallback_pos_side,
                    Some(fallback_reduce_only),
                    is_algo,
                );
                upsert_recovered_execution_order(
                    app, &account, &request, &order, &response, is_algo,
                )?;
                finish_trade_execution(
                    app,
                    &lease,
                    "accepted",
                    Some(&response.ord_id),
                    Some(&response),
                    None,
                )?;
                complete_ai_opportunity_order(app, &request, &response, is_algo)?;
                if let Some(next_status) = opportunity_status_from_order_state(
                    Some(order.state.as_str()),
                    Some(order.acc_fill_sz.as_str()),
                ) {
                    let conn = open_database(app)?;
                    conn.execute(
                        "UPDATE trade_opportunities SET status=?3,updated_at=?4
                         WHERE id=?1 AND execution_key=?2 AND status IN ('executing','submitted','partially_filled')",
                        params![
                            optional_non_empty(&request.opportunity_id),
                            execution_key,
                            next_status,
                            now_ms(),
                        ],
                    )
                    .map_err(|err| err.to_string())?;
                }
                recovered = recovered.saturating_add(1);
            }
            Ok(None) => {
                let now = now_ms();
                finish_trade_execution(
                    app,
                    &lease,
                    "confirmed_missing",
                    None,
                    None,
                    Some("重启后通过 clOrdId 对账确认 OKX 不存在该订单"),
                )?;
                let conn = open_database(app)?;
                conn.execute(
                    "UPDATE trade_opportunities SET
                       status=CASE WHEN expires_at IS NOT NULL AND expires_at<=?3 THEN 'expired' ELSE 'approved' END,
                       execution_key=NULL,error='重启对账确认原订单未提交，可由后续 Run 重新决策',updated_at=?3
                     WHERE id=?1 AND execution_key=?2 AND status='executing'",
                    params![optional_non_empty(&request.opportunity_id), execution_key, now],
                )
                .map_err(|err| err.to_string())?;
                confirmed_missing = confirmed_missing.saturating_add(1);
            }
            Err(err) => {
                finish_trade_execution(
                    app,
                    &lease,
                    "unknown",
                    None,
                    None,
                    Some(&format!("重启对账仍不明确：{err}")),
                )?;
                unknown = unknown.saturating_add(1);
            }
        }
    }
    let amend_recovery = recover_pending_amend_executions(app).await?;
    let algo_place_recovery = recover_pending_place_algo_executions(app).await?;
    let algo_amend_recovery = recover_pending_amend_algo_executions(app).await?;
    let algo_projection_after = repair_pending_algo_execution_projections(app)?;
    let normal_retry_after_ms = next_pending_normal_recovery_delay_ms(app)?;
    let algo_retry_after_ms = next_pending_algo_recovery_delay_ms(app)?;
    let retry_after_ms = [normal_retry_after_ms, algo_retry_after_ms]
        .into_iter()
        .flatten()
        .min();
    Ok(json!({
        "recovered": recovered,
        "confirmedMissing": confirmed_missing,
        "unknown": unknown,
        "deferred": deferred,
        "amend": amend_recovery,
        "algoPlace": algo_place_recovery,
        "algoAmend": algo_amend_recovery,
        "algoProjectionBefore": algo_projection_before,
        "algoProjectionAfter": algo_projection_after,
        "algoRetryAfterMs": algo_retry_after_ms,
        "normalRetryAfterMs": normal_retry_after_ms,
        "retryAfterMs": retry_after_ms
    }))
}

pub(crate) fn start_trade_execution_recovery(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let recovery = {
                let _trade_mutation_guard = TRADE_MUTATION_LOCK.lock().await;
                recover_pending_trade_executions(&app).await
            };
            let summary = match recovery {
                Ok(summary) => summary,
                Err(error) => {
                    eprintln!("trade execution recovery failed: {error}");
                    break;
                }
            };
            let Some(retry_after_ms) = summary
                .get("retryAfterMs")
                .and_then(serde_json::Value::as_i64)
            else {
                break;
            };
            sleep(Duration::from_millis(
                retry_after_ms.clamp(50, ALGO_EXECUTION_RESCAN_MAX_DELAY_MS) as u64,
            ))
            .await;
        }
    });
}

async fn recover_pending_amend_executions(
    app: &tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let attempts = {
        let conn = open_database(app)?;
        let mut stmt = conn
            .prepare(
                "SELECT execution_key,account_id,environment,credential_fingerprint,request_json
                 FROM trade_execution_attempts
                 WHERE operation='amend_order' AND status IN ('submitting','reconciling','unknown')
                 ORDER BY created_at ASC",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        rows
    };
    let mut accepted = 0_u32;
    let mut rejected = 0_u32;
    let mut unknown = 0_u32;
    let mut deferred = 0_u32;
    for (execution_key, account_id, environment, credential_fingerprint, request_json) in attempts {
        let Some(lease) = claim_pending_normal_execution(app, &execution_key, "amend_order")?
        else {
            deferred = deferred.saturating_add(1);
            continue;
        };
        let request = match serde_json::from_str::<AmendOrderRequest>(&request_json) {
            Ok(request) => request,
            Err(err) => {
                finish_amend_execution(
                    app,
                    &lease,
                    "blocked",
                    None,
                    Some(&format!("无法解析崩溃恢复改单请求：{err}")),
                )?;
                unknown = unknown.saturating_add(1);
                continue;
            }
        };
        let account = match load_local_account_secret(app, Some(&account_id)) {
            Ok(account)
                if normalize_environment(&account.environment)
                    == normalize_environment(&environment) =>
            {
                account
            }
            Ok(_) => {
                finish_amend_execution(
                    app,
                    &lease,
                    "unknown",
                    None,
                    Some("改单账号环境已变化，无法安全对账"),
                )?;
                unknown = unknown.saturating_add(1);
                continue;
            }
            Err(err) => {
                finish_amend_execution(
                    app,
                    &lease,
                    "unknown",
                    None,
                    Some(&format!("无法读取改单账号凭据进行对账：{err}")),
                )?;
                unknown = unknown.saturating_add(1);
                continue;
            }
        };
        if !execution_credential_matches(&credential_fingerprint, &account) {
            finish_amend_execution(
                app,
                &lease,
                "unknown",
                None,
                Some("改单账号凭据已变化或旧执行记录未绑定凭据，禁止使用当前凭据自动对账"),
            )?;
            unknown = unknown.saturating_add(1);
            continue;
        }
        match reconcile_amend_order_with_retry(&account, &request).await {
            Ok(Some(order)) if amend_matches_order(&request, &order) => {
                let result = reconciled_amend_result(&order, "重启后对账确认改单已经生效");
                finish_amend_execution(app, &lease, "accepted", Some(&result), None)?;
                accepted = accepted.saturating_add(1);
            }
            Ok(Some(_)) => {
                finish_amend_execution(
                    app,
                    &lease,
                    "confirmed_not_applied",
                    None,
                    Some("多次对账确认当前订单参数不匹配；不自动重放旧改单，允许 Agent 重新决策后显式重提"),
                )?;
                rejected = rejected.saturating_add(1);
            }
            Ok(None) => {
                finish_amend_execution(
                    app,
                    &lease,
                    "rejected",
                    None,
                    Some("重启后确认原订单已不存在，旧改单不再执行"),
                )?;
                rejected = rejected.saturating_add(1);
            }
            Err(err) => {
                finish_amend_execution(
                    app,
                    &lease,
                    "unknown",
                    None,
                    Some(&format!("重启后仍无法确认改单是否生效：{err}")),
                )?;
                unknown = unknown.saturating_add(1);
            }
        }
    }
    Ok(json!({
        "accepted": accepted,
        "rejected": rejected,
        "unknown": unknown,
        "deferred": deferred
    }))
}

fn pending_algo_execution_rows(
    app: &tauri::AppHandle,
    operation: &str,
) -> Result<Vec<(String, String, String, String, String, String)>, String> {
    let conn = open_database(app)?;
    let mut stmt = conn
        .prepare(PENDING_ALGO_EXECUTION_ROWS_SQL)
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![operation], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    Ok(rows)
}

fn recovery_algo_account(
    app: &tauri::AppHandle,
    account_id: &str,
    environment: &str,
    credential_fingerprint: &str,
) -> Result<LocalAccount, String> {
    let account = load_local_account_secret(app, Some(account_id))?;
    if normalize_environment(&account.environment) != normalize_environment(environment) {
        return Err("策略交易账号环境已变化，无法安全对账".to_string());
    }
    if !execution_credential_matches(credential_fingerprint, &account) {
        return Err(
            "策略交易账号凭据已变化或旧执行记录未绑定凭据，禁止使用当前凭据自动对账".to_string(),
        );
    }
    Ok(account)
}

fn claim_pending_algo_execution(
    app: &tauri::AppHandle,
    execution_key: &str,
    operation: &str,
) -> Result<Option<AlgoExecutionLease>, String> {
    let conn = open_database(app)?;
    let owner_token = new_algo_execution_owner_token(execution_key, operation);
    if !claim_algo_execution_lease_with_conn(
        &conn,
        execution_key,
        operation,
        &owner_token,
        now_ms(),
    )? {
        return Ok(None);
    }
    Ok(Some(AlgoExecutionLease {
        execution_key: execution_key.to_string(),
        operation: operation.to_string(),
        owner_token,
    }))
}

fn next_pending_algo_recovery_delay_ms(app: &tauri::AppHandle) -> Result<Option<i64>, String> {
    let conn = open_database(app)?;
    let pending_projection_count = conn
        .query_row(
            "SELECT COUNT(*) FROM trade_execution_attempts
             WHERE operation IN ('place_algo_order','amend_algo_order')
               AND status='accepted' AND projection_status='pending'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| err.to_string())?;
    if pending_projection_count > 0 {
        return Ok(Some(30_000));
    }
    let earliest = conn
        .query_row(
            "SELECT MIN(lease_expires_at)
             FROM trade_execution_attempts
             WHERE operation IN ('place_algo_order','amend_algo_order')
               AND status IN ('submitting','reconciling','unknown')",
            [],
            |row| row.get::<_, Option<i64>>(0),
        )
        .map_err(|err| err.to_string())?;
    let Some(earliest) = earliest else {
        return Ok(None);
    };
    Ok(Some(
        earliest
            .saturating_sub(now_ms())
            .saturating_add(25)
            .clamp(50, ALGO_EXECUTION_RESCAN_MAX_DELAY_MS),
    ))
}

fn repair_pending_algo_execution_projections(
    app: &tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let rows = {
        let conn = open_database(app)?;
        let mut stmt = conn
            .prepare(
                "SELECT execution_key,operation,request_json,response_json
                 FROM trade_execution_attempts
                 WHERE operation IN ('place_algo_order','amend_algo_order')
                   AND status='accepted' AND projection_status='pending'
                 ORDER BY updated_at ASC",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        rows
    };
    let mut completed = 0_u32;
    let mut failed = 0_u32;
    let mut last_error = None;
    for (execution_key, operation, request_json, response_json) in rows {
        let result = match operation.as_str() {
            "place_algo_order" => (|| {
                let request = serde_json::from_str::<PlaceAlgoOrderRequest>(&request_json)
                    .map_err(|err| (true, format!("策略委托投影请求无法解析：{err}")))?;
                if optional_non_empty(&request.execution_key).as_deref()
                    != Some(execution_key.as_str())
                {
                    return Err((true, "策略委托投影 executionKey 绑定不一致".to_string()));
                }
                let response = response_json
                    .as_deref()
                    .ok_or_else(|| (true, "策略委托投影缺少 accepted 响应".to_string()))
                    .and_then(|value| {
                        serde_json::from_str::<PlaceOrderResponse>(value)
                            .map_err(|err| (true, format!("策略委托 accepted 响应无法解析：{err}")))
                    })?;
                validate_persisted_place_algo_response(
                    &response,
                    &stable_client_order_id(&execution_key),
                    &execution_key,
                )
                .map_err(|err| (true, err))?;
                project_place_algo_accepted(app, &request, &response).map_err(|err| (false, err))
            })(),
            "amend_algo_order" => (|| {
                let request = serde_json::from_str::<AmendAlgoOrderRequest>(&request_json)
                    .map_err(|err| (true, format!("策略改单投影请求无法解析：{err}")))?;
                if optional_non_empty(&request.execution_key).as_deref()
                    != Some(execution_key.as_str())
                {
                    return Err((true, "策略改单投影 executionKey 绑定不一致".to_string()));
                }
                let response = response_json
                    .as_deref()
                    .ok_or_else(|| (true, "策略改单投影缺少 accepted 响应".to_string()))
                    .and_then(|value| {
                        serde_json::from_str::<OkxAlgoOrderResult>(value)
                            .map_err(|err| (true, format!("策略改单 accepted 响应无法解析：{err}")))
                    })?;
                validate_amend_algo_result_identity(&request, &response)
                    .map_err(|err| (true, err))?;
                project_amend_algo_accepted(app, &request, &response).map_err(|err| (false, err))
            })(),
            _ => Err((true, "不支持的策略执行投影 operation".to_string())),
        };
        match result {
            Ok(()) => completed = completed.saturating_add(1),
            Err((blocked, err)) => {
                mark_algo_projection_failure(app, &execution_key, &operation, blocked, &err)?;
                failed = failed.saturating_add(1);
                last_error = Some(err);
            }
        }
    }
    Ok(json!({
        "completed": completed,
        "failed": failed,
        "lastError": last_error
    }))
}

fn mark_algo_projection_failure(
    app: &tauri::AppHandle,
    execution_key: &str,
    operation: &str,
    blocked: bool,
    error: &str,
) -> Result<(), String> {
    let conn = open_database(app)?;
    conn.execute(
        "UPDATE trade_execution_attempts
         SET projection_status=CASE WHEN ?3 THEN 'blocked' ELSE 'pending' END,
             error=?4,updated_at=?5
         WHERE execution_key=?1 AND operation=?2
           AND status='accepted' AND projection_status='pending'",
        params![execution_key, operation, blocked, error, now_ms()],
    )
    .map(|_| ())
    .map_err(|err| err.to_string())
}

async fn recover_pending_place_algo_executions(
    app: &tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let rows = pending_algo_execution_rows(app, "place_algo_order")?;
    let mut accepted = 0_u32;
    let mut confirmed_missing = 0_u32;
    let mut unknown = 0_u32;
    let mut deferred = 0_u32;
    for (
        execution_key,
        account_id,
        environment,
        credential_fingerprint,
        client_order_id,
        request_json,
    ) in rows
    {
        let Some(lease) = claim_pending_algo_execution(app, &execution_key, "place_algo_order")?
        else {
            deferred = deferred.saturating_add(1);
            continue;
        };
        let request = match serde_json::from_str::<PlaceAlgoOrderRequest>(&request_json) {
            Ok(request) => request,
            Err(err) => {
                match finish_algo_execution::<PlaceOrderResponse, PlaceOrderResponse, _>(
                    app,
                    &lease,
                    "blocked",
                    None,
                    None,
                    Some(&format!("无法解析崩溃恢复策略委托请求：{err}")),
                    |persisted| {
                        validate_persisted_place_algo_response(
                            persisted,
                            &client_order_id,
                            &execution_key,
                        )
                    },
                ) {
                    Ok(AlgoExecutionCas::Accepted(_)) => accepted = accepted.saturating_add(1),
                    _ => unknown = unknown.saturating_add(1),
                }
                continue;
            }
        };
        if optional_non_empty(&request.execution_key).as_deref() != Some(execution_key.as_str())
            || stable_client_order_id(&execution_key) != client_order_id
        {
            match finish_algo_execution::<PlaceOrderResponse, PlaceOrderResponse, _>(
                app,
                &lease,
                "blocked",
                None,
                None,
                Some("策略委托恢复记录的 executionKey 与稳定 algoClOrdId 绑定不一致"),
                |persisted| {
                    validate_persisted_place_algo_response(
                        persisted,
                        &client_order_id,
                        &execution_key,
                    )
                },
            ) {
                Ok(AlgoExecutionCas::Accepted(_)) => accepted = accepted.saturating_add(1),
                _ => unknown = unknown.saturating_add(1),
            }
            continue;
        }
        let account =
            match recovery_algo_account(app, &account_id, &environment, &credential_fingerprint) {
                Ok(account) => account,
                Err(err) => {
                    match finish_algo_execution::<PlaceOrderResponse, PlaceOrderResponse, _>(
                        app,
                        &lease,
                        "blocked",
                        None,
                        None,
                        Some(&err),
                        |persisted| {
                            validate_persisted_place_algo_response(
                                persisted,
                                &client_order_id,
                                &execution_key,
                            )
                        },
                    ) {
                        Ok(AlgoExecutionCas::Accepted(_)) => accepted = accepted.saturating_add(1),
                        _ => unknown = unknown.saturating_add(1),
                    }
                    continue;
                }
            };
        match resolve_place_algo_execution(
            app,
            &account,
            &request,
            &client_order_id,
            &lease,
            "重启后通过 OKX order-algo 对账确认策略委托存在",
        )
        .await
        {
            Ok(_) => accepted = accepted.saturating_add(1),
            Err(err) if err.contains("确认未找到") => {
                confirmed_missing = confirmed_missing.saturating_add(1)
            }
            Err(_) => unknown = unknown.saturating_add(1),
        }
    }
    Ok(json!({
        "accepted": accepted,
        "confirmedMissing": confirmed_missing,
        "unknown": unknown,
        "deferred": deferred
    }))
}

async fn recover_pending_amend_algo_executions(
    app: &tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let rows = pending_algo_execution_rows(app, "amend_algo_order")?;
    let mut accepted = 0_u32;
    let mut rejected = 0_u32;
    let mut unknown = 0_u32;
    let mut deferred = 0_u32;
    for (
        execution_key,
        account_id,
        environment,
        credential_fingerprint,
        client_order_id,
        request_json,
    ) in rows
    {
        let Some(lease) = claim_pending_algo_execution(app, &execution_key, "amend_algo_order")?
        else {
            deferred = deferred.saturating_add(1);
            continue;
        };
        let request = match serde_json::from_str::<AmendAlgoOrderRequest>(&request_json) {
            Ok(request) => request,
            Err(err) => {
                let validation_error = "策略改单请求快照损坏，无法严格验证 accepted 响应";
                match finish_algo_execution::<OkxAlgoOrderResult, OkxAlgoOrderResult, _>(
                    app,
                    &lease,
                    "blocked",
                    None,
                    None,
                    Some(&format!("无法解析崩溃恢复策略改单请求：{err}")),
                    |_| Err(validation_error.to_string()),
                ) {
                    Ok(AlgoExecutionCas::Accepted(_)) => accepted = accepted.saturating_add(1),
                    _ => unknown = unknown.saturating_add(1),
                }
                continue;
            }
        };
        if optional_non_empty(&request.execution_key).as_deref() != Some(execution_key.as_str())
            || stable_client_order_id(&execution_key) != client_order_id
        {
            match finish_algo_execution::<OkxAlgoOrderResult, OkxAlgoOrderResult, _>(
                app,
                &lease,
                "blocked",
                None,
                None,
                Some("策略改单恢复记录的 executionKey 与预留身份绑定不一致"),
                |persisted| validate_amend_algo_result_identity(&request, persisted),
            ) {
                Ok(AlgoExecutionCas::Accepted(_)) => accepted = accepted.saturating_add(1),
                _ => unknown = unknown.saturating_add(1),
            }
            continue;
        }
        let account =
            match recovery_algo_account(app, &account_id, &environment, &credential_fingerprint) {
                Ok(account) => account,
                Err(err) => {
                    match finish_algo_execution::<OkxAlgoOrderResult, OkxAlgoOrderResult, _>(
                        app,
                        &lease,
                        "blocked",
                        None,
                        None,
                        Some(&err),
                        |persisted| validate_amend_algo_result_identity(&request, persisted),
                    ) {
                        Ok(AlgoExecutionCas::Accepted(_)) => accepted = accepted.saturating_add(1),
                        _ => unknown = unknown.saturating_add(1),
                    }
                    continue;
                }
            };
        match resolve_amend_algo_execution(
            app,
            &account,
            &request,
            &lease,
            "重启后通过 OKX order-algo 对账确认策略改单生效",
        )
        .await
        {
            Ok(_) => accepted = accepted.saturating_add(1),
            Err(err) if err.contains("目标策略单已不存在") => {
                rejected = rejected.saturating_add(1)
            }
            Err(_) => unknown = unknown.saturating_add(1),
        }
    }
    Ok(json!({
        "accepted": accepted,
        "rejected": rejected,
        "unknown": unknown,
        "deferred": deferred
    }))
}

async fn reconcile_amend_order_with_retry(
    account: &LocalAccount,
    request: &AmendOrderRequest,
) -> Result<Option<OkxPendingOrder>, String> {
    let mut last_order = None;
    for delay_ms in [0_u64, 250, 750] {
        if delay_ms > 0 {
            sleep(Duration::from_millis(delay_ms)).await;
        }
        match reconcile_order(
            account,
            &request.inst_id,
            request.ord_id.as_deref(),
            request.cl_ord_id.as_deref(),
            false,
        )
        .await
        {
            Ok(Some(order)) if amend_matches_order(request, &order) => return Ok(Some(order)),
            Ok(Some(order)) => last_order = Some(order),
            Ok(None) => {}
            Err(err) => return Err(err),
        }
    }
    Ok(last_order)
}

fn recovery_action_defaults(action: &str) -> (&'static str, Option<&'static str>, bool) {
    match action.to_ascii_lowercase().as_str() {
        "long" => ("buy", Some("long"), false),
        "short" => ("sell", Some("short"), false),
        "close-long" => ("sell", Some("long"), true),
        "close-short" => ("buy", Some("short"), true),
        _ => ("buy", Some("net"), false),
    }
}

fn recovered_order_type<'a>(
    requested_order_type: &'a str,
    remote_order_type: &'a str,
    is_algo: bool,
) -> &'a str {
    if is_algo || remote_order_type.trim().is_empty() {
        requested_order_type
    } else {
        remote_order_type
    }
}

fn upsert_recovered_execution_order(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    request: &PlaceOrderRequest,
    order: &OkxPendingOrder,
    response: &PlaceOrderResponse,
    is_algo: bool,
) -> Result<(), String> {
    let conn = open_database(app)?;
    let now = now_ms();
    let state = if order.state.trim().is_empty() {
        "submitted"
    } else {
        order.state.as_str()
    };
    conn.execute(
        "INSERT INTO okx_orders(
          account_id,environment,ord_id,cl_ord_id,inst_id,inst_type,side,pos_side,td_mode,ord_type,
          state,px,sz,acc_fill_sz,avg_px,source_endpoint,operator,strategy_id,session_id,
          opportunity_id,agent_run_id,execution_key,okx_ctime,okx_utime,raw_json,synced_at
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,'startup-reconcile',?16,?17,?18,?19,?20,?21,?22,?23,?24,?25)
         ON CONFLICT(account_id,environment,ord_id) DO UPDATE SET
           cl_ord_id=COALESCE(excluded.cl_ord_id,okx_orders.cl_ord_id),state=excluded.state,
           acc_fill_sz=excluded.acc_fill_sz,avg_px=excluded.avg_px,source_endpoint=excluded.source_endpoint,
           operator=excluded.operator,strategy_id=COALESCE(excluded.strategy_id,okx_orders.strategy_id),
           session_id=COALESCE(excluded.session_id,okx_orders.session_id),
           opportunity_id=COALESCE(excluded.opportunity_id,okx_orders.opportunity_id),
           agent_run_id=COALESCE(excluded.agent_run_id,okx_orders.agent_run_id),
           execution_key=COALESCE(excluded.execution_key,okx_orders.execution_key),
           okx_utime=COALESCE(excluded.okx_utime,okx_orders.okx_utime),raw_json=excluded.raw_json,synced_at=excluded.synced_at",
        params![
            account.id,
            account.environment,
            response.ord_id,
            optional_string(Some(response.cl_ord_id.clone())),
            request.inst_id,
            if order.inst_type.trim().is_empty() { "SWAP" } else { order.inst_type.as_str() },
            response.side,
            response.pos_side,
            if order.td_mode.trim().is_empty() { request.td_mode.as_str() } else { order.td_mode.as_str() },
            recovered_order_type(&request.order_type, &order.ord_type, is_algo),
            state,
            optional_string(Some(order.px.clone())),
            optional_string(Some(order.sz.clone())).or_else(|| Some(request.size.clone())),
            optional_string(Some(order.acc_fill_sz.clone())).or_else(|| Some("0".to_string())),
            optional_string(Some(order.avg_px.clone())),
            response.operator,
            response.strategy_id,
            response.session_id,
            response.opportunity_id,
            response.agent_run_id,
            response.execution_key,
            order.c_time.parse::<i64>().ok(),
            order.u_time.parse::<i64>().ok(),
            serde_json::to_string(order).map_err(|err| err.to_string())?,
            now,
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn claim_pending_normal_execution(
    app: &tauri::AppHandle,
    execution_key: &str,
    operation: &str,
) -> Result<Option<NormalExecutionLease>, String> {
    let conn = open_database(app)?;
    let now = now_ms();
    let owner_token = new_normal_execution_owner_token(execution_key, operation);
    if !claim_normal_execution_lease_with_conn(&conn, execution_key, operation, &owner_token, now)?
    {
        return Ok(None);
    }
    Ok(Some(NormalExecutionLease {
        execution_key: execution_key.to_string(),
        operation: operation.to_string(),
        owner_token,
    }))
}

fn claim_normal_execution_lease_with_conn(
    conn: &Connection,
    execution_key: &str,
    operation: &str,
    owner_token: &str,
    now: i64,
) -> Result<bool, String> {
    conn.execute(
        "UPDATE trade_execution_attempts
         SET status='reconciling',owner_token=?3,lease_expires_at=?5,error=NULL,updated_at=?4
         WHERE execution_key=?1 AND operation=?2
           AND status IN ('submitting','reconciling','unknown')
           AND lease_expires_at<=?4",
        params![
            execution_key,
            operation,
            owner_token,
            now,
            now.saturating_add(NORMAL_EXECUTION_LEASE_MS),
        ],
    )
    .map(|changed| changed == 1)
    .map_err(|err| err.to_string())
}

fn claim_normal_execution_retry_from_status(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    execution_key: &str,
    operation: &str,
    expected_status: &str,
) -> Result<NormalExecutionLease, String> {
    let mut conn = open_database(app)?;
    let transaction = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|err| err.to_string())?;
    ensure_account_snapshot_current(app, account)?;
    let now = now_ms();
    let owner_token = new_normal_execution_owner_token(execution_key, operation);
    let changed = claim_normal_execution_retry_from_status_with_conn(
        &transaction,
        account,
        execution_key,
        operation,
        expected_status,
        &owner_token,
        now,
    )?;
    if !changed {
        return Err(format!(
            "{NORMAL_EXECUTION_LEASE_LOST}: 无法从 {expected_status} 原子认领后续执行"
        ));
    }
    transaction.commit().map_err(|err| err.to_string())?;
    Ok(NormalExecutionLease {
        execution_key: execution_key.to_string(),
        operation: operation.to_string(),
        owner_token,
    })
}

fn claim_normal_execution_retry_from_status_with_conn(
    conn: &Connection,
    account: &LocalAccount,
    execution_key: &str,
    operation: &str,
    expected_status: &str,
    owner_token: &str,
    now: i64,
) -> Result<bool, String> {
    conn.execute(
        "UPDATE trade_execution_attempts
         SET status='submitting',owner_token=?7,lease_expires_at=?8,error=NULL,updated_at=?9
         WHERE execution_key=?1 AND operation=?2 AND status=?3
           AND account_id=?4 AND environment=?5 AND credential_fingerprint=?6",
        params![
            execution_key,
            operation,
            expected_status,
            account.id,
            account.environment,
            account_config_cache_fingerprint(account),
            owner_token,
            now.saturating_add(NORMAL_EXECUTION_LEASE_MS),
            now,
        ],
    )
    .map(|changed| changed == 1)
    .map_err(|err| err.to_string())
}

fn next_pending_normal_recovery_delay_ms(app: &tauri::AppHandle) -> Result<Option<i64>, String> {
    let conn = open_database(app)?;
    let earliest = conn
        .query_row(
            "SELECT MIN(lease_expires_at)
             FROM trade_execution_attempts
             WHERE operation IN ('place_order','amend_order')
               AND status IN ('submitting','reconciling','unknown')",
            [],
            |row| row.get::<_, Option<i64>>(0),
        )
        .map_err(|err| err.to_string())?;
    Ok(earliest.map(|value| {
        value
            .saturating_sub(now_ms())
            .saturating_add(25)
            .clamp(50, ALGO_EXECUTION_RESCAN_MAX_DELAY_MS)
    }))
}

fn resume_trade_execution_after_reconciliation(
    app: &tauri::AppHandle,
    lease: &NormalExecutionLease,
) -> Result<(), String> {
    let conn = open_database(app)?;
    let now = now_ms();
    let changed = conn
        .execute(
            "UPDATE trade_execution_attempts
             SET status='submitting',lease_expires_at=?5,error=NULL,updated_at=?4
             WHERE execution_key=?1 AND operation=?2 AND owner_token=?3
               AND status='reconciling' AND lease_expires_at>?4",
            params![
                lease.execution_key,
                lease.operation,
                lease.owner_token,
                now,
                now.saturating_add(NORMAL_EXECUTION_LEASE_MS),
            ],
        )
        .map_err(|err| err.to_string())?;
    if changed != 1 {
        return Err(format!(
            "{NORMAL_EXECUTION_LEASE_LOST}: 订单对账租约已失效，已阻止重复提交"
        ));
    }
    Ok(())
}

fn finish_normal_execution(
    app: &tauri::AppHandle,
    lease: &NormalExecutionLease,
    status: &str,
    order_id: Option<&str>,
    response_json: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    if !matches!(
        status,
        "accepted"
            | "rejected"
            | "confirmed_missing"
            | "confirmed_not_applied"
            | "fallback_accepted"
            | "blocked"
            | "unknown"
    ) {
        return Err(format!("不支持的普通交易执行状态：{status}"));
    }
    let conn = open_database(app)?;
    let now = now_ms();
    if !cas_finish_normal_execution_with_conn(
        &conn,
        lease,
        status,
        order_id,
        response_json,
        error,
        now,
    )? {
        return Err(format!(
            "{NORMAL_EXECUTION_LEASE_LOST}: 普通交易执行状态写入被其他 owner 拒绝"
        ));
    }
    Ok(())
}

fn cas_finish_normal_execution_with_conn(
    conn: &Connection,
    lease: &NormalExecutionLease,
    status: &str,
    order_id: Option<&str>,
    response_json: Option<&str>,
    error: Option<&str>,
    now: i64,
) -> Result<bool, String> {
    let remains_owned = status == "unknown";
    conn.execute(
        "UPDATE trade_execution_attempts
         SET status=?4,order_id=COALESCE(?5,order_id),
             response_json=COALESCE(?6,response_json),error=?7,updated_at=?8,
             owner_token=CASE WHEN ?9 THEN owner_token ELSE '' END,
             lease_expires_at=CASE WHEN ?9 THEN ?10 ELSE 0 END
         WHERE execution_key=?1 AND operation=?2 AND owner_token=?3
           AND status IN ('submitting','reconciling','unknown')
           AND lease_expires_at>?8",
        params![
            lease.execution_key,
            lease.operation,
            lease.owner_token,
            status,
            order_id,
            response_json,
            error,
            now,
            remains_owned,
            now.saturating_add(NORMAL_EXECUTION_LEASE_MS),
        ],
    )
    .map(|changed| changed == 1)
    .map_err(|err| err.to_string())
}

async fn reconcile_order_by_client_id(
    account: &LocalAccount,
    inst_id: &str,
    client_order_id: &str,
    is_algo: bool,
) -> Result<Option<OkxPendingOrder>, String> {
    reconcile_order(account, inst_id, None, Some(client_order_id), is_algo).await
}

async fn reconcile_order_by_client_id_with_retry(
    account: &LocalAccount,
    inst_id: &str,
    client_order_id: &str,
    is_algo: bool,
) -> Result<Option<OkxPendingOrder>, String> {
    for attempt in 0..3_u64 {
        match reconcile_order_by_client_id(account, inst_id, client_order_id, is_algo).await? {
            Some(order) => return Ok(Some(order)),
            None if attempt < 2 => sleep(Duration::from_millis(150 * (attempt + 1))).await,
            None => return Ok(None),
        }
    }
    Ok(None)
}

#[derive(Debug, Clone)]
pub(crate) struct SystematicProfileReconciledOrder {
    pub order_id: String,
    pub state: String,
    pub filled_quantity: f64,
}

pub(crate) fn systematic_profile_client_order_id(execution_key: &str) -> String {
    stable_client_order_id(execution_key)
}

pub(crate) async fn reconcile_systematic_profile_execution(
    app: &tauri::AppHandle,
    account_id: &str,
    environment: &str,
    inst_id: &str,
    client_order_id: &str,
) -> Result<Option<SystematicProfileReconciledOrder>, String> {
    let account = load_local_account_secret(app, Some(account_id))?;
    if normalize_environment(&account.environment) != normalize_environment(environment) {
        return Err("策略 Profile 账号环境已变化，无法安全恢复信号".to_string());
    }
    let stored_fingerprint: Option<String> = open_database(app)?
        .query_row(
            "SELECT credential_fingerprint FROM trade_execution_attempts
             WHERE operation='place_order' AND client_order_id=?1
             ORDER BY updated_at DESC LIMIT 1",
            [client_order_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(fingerprint) = stored_fingerprint.filter(|value| !value.trim().is_empty()) {
        if fingerprint != account_config_cache_fingerprint(&account) {
            return Err("策略执行记录绑定的账号凭据已变化，禁止自动恢复".to_string());
        }
    }
    let Some(order) =
        reconcile_order_by_client_id_with_retry(&account, inst_id, client_order_id, false).await?
    else {
        return Ok(None);
    };
    let filled_quantity = order
        .acc_fill_sz
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
        .unwrap_or(0.0);
    Ok(Some(SystematicProfileReconciledOrder {
        order_id: order.ord_id,
        state: order.state,
        filled_quantity,
    }))
}

fn is_duplicate_client_order_error(code: &str, message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    matches!(code, "51016" | "51503")
        || ((lower.contains("clordid")
            || lower.contains("client order id")
            || lower.contains("client-order-id"))
            && (lower.contains("duplicate")
                || lower.contains("already")
                || lower.contains("repeat")))
}

async fn reconcile_order(
    account: &LocalAccount,
    inst_id: &str,
    order_id: Option<&str>,
    client_order_id: Option<&str>,
    is_algo: bool,
) -> Result<Option<OkxPendingOrder>, String> {
    let mut path = if is_algo {
        format!("/api/v5/trade/order-algo?instId={inst_id}")
    } else {
        format!("/api/v5/trade/order?instId={inst_id}")
    };
    if let Some(value) = order_id.map(str::trim).filter(|value| !value.is_empty()) {
        path.push_str(if is_algo { "&algoId=" } else { "&ordId=" });
        path.push_str(value);
    }
    if let Some(value) = client_order_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        path.push_str(if is_algo {
            "&algoClOrdId="
        } else {
            "&clOrdId="
        });
        path.push_str(value);
    }
    if is_algo {
        match okx_private_get::<OkxAlgoPendingOrder>(account, &path).await {
            Ok(envelope) => {
                let order = envelope
                    .data
                    .into_iter()
                    .next()
                    .map(pending_order_from_algo)
                    .ok_or_else(|| {
                        "OKX_ORDER_LOOKUP_EMPTY_UNCONFIRMED: 查询成功但没有返回订单数据".to_string()
                    })?;
                validate_reconciled_order_identity(
                    &order,
                    inst_id,
                    order_id,
                    client_order_id,
                    true,
                )?;
                Ok(Some(order))
            }
            Err(err) if is_confirmed_missing_order_error(&err) => Ok(None),
            Err(err) => Err(err),
        }
    } else {
        match okx_private_get::<OkxPendingOrder>(account, &path).await {
            Ok(envelope) => {
                let order = envelope.data.into_iter().next().ok_or_else(|| {
                    "OKX_ORDER_LOOKUP_EMPTY_UNCONFIRMED: 查询成功但没有返回订单数据".to_string()
                })?;
                validate_reconciled_order_identity(
                    &order,
                    inst_id,
                    order_id,
                    client_order_id,
                    false,
                )?;
                Ok(Some(order))
            }
            Err(err) if is_confirmed_missing_order_error(&err) => Ok(None),
            Err(err) => Err(err),
        }
    }
}

fn validate_reconciled_order_identity(
    order: &OkxPendingOrder,
    expected_inst_id: &str,
    expected_order_id: Option<&str>,
    expected_client_order_id: Option<&str>,
    is_algo: bool,
) -> Result<(), String> {
    if order.inst_id.trim().is_empty()
        || !order.inst_id.eq_ignore_ascii_case(expected_inst_id.trim())
    {
        return Err("OKX_ORDER_LOOKUP_IDENTITY_MISMATCH: 返回订单的交易品种不匹配".to_string());
    }
    let actual_order_id = if is_algo {
        order.algo_id.as_str()
    } else {
        order.ord_id.as_str()
    };
    let actual_client_order_id = if is_algo {
        order.algo_cl_ord_id.as_str()
    } else {
        order.cl_ord_id.as_str()
    };
    if actual_order_id.trim().is_empty() {
        return Err("OKX_ORDER_LOOKUP_IDENTITY_MISMATCH: 返回订单缺少订单 ID".to_string());
    }
    if let Some(expected) = expected_order_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if actual_order_id.trim() != expected {
            return Err("OKX_ORDER_LOOKUP_IDENTITY_MISMATCH: 返回订单 ID 不匹配".to_string());
        }
    }
    if let Some(expected) = expected_client_order_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if actual_client_order_id.trim() != expected {
            return Err("OKX_ORDER_LOOKUP_IDENTITY_MISMATCH: 返回客户端订单 ID 不匹配".to_string());
        }
    }
    Ok(())
}

fn is_confirmed_missing_order_error(error: &str) -> bool {
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

fn fallback_order_side<'a>(order: &'a OkxPendingOrder, fallback: &'a str) -> &'a str {
    if order.side.trim().is_empty() {
        fallback
    } else {
        order.side.as_str()
    }
}

fn fallback_pos_side(order: &OkxPendingOrder, fallback: Option<&str>) -> String {
    if order.pos_side.trim().is_empty() {
        fallback.unwrap_or("net").to_string()
    } else {
        order.pos_side.clone()
    }
}

fn reconciliation_timestamp(order: &OkxPendingOrder) -> String {
    optional_string(Some(order.u_time.clone()))
        .or_else(|| optional_string(Some(order.c_time.clone())))
        .unwrap_or_else(|| now_ms().to_string())
}

fn reconciled_place_order_response(
    request: &PlaceOrderRequest,
    order: &OkxPendingOrder,
    fallback_side_value: &str,
    fallback_pos_side_value: Option<&str>,
    fallback_reduce_only: Option<bool>,
    is_algo: bool,
) -> PlaceOrderResponse {
    let ord_id = if is_algo {
        optional_string(Some(order.algo_id.clone())).unwrap_or_else(|| order.ord_id.clone())
    } else {
        order.ord_id.clone()
    };
    let cl_ord_id = if is_algo {
        optional_string(Some(order.algo_cl_ord_id.clone()))
            .unwrap_or_else(|| order.cl_ord_id.clone())
    } else {
        order.cl_ord_id.clone()
    };
    PlaceOrderResponse {
        ord_id,
        cl_ord_id,
        s_code: "0".to_string(),
        s_msg: "已通过 OKX 对账确认原请求存在，未重复提交".to_string(),
        ts: reconciliation_timestamp(order),
        side: fallback_order_side(order, fallback_side_value).to_string(),
        pos_side: fallback_pos_side(order, fallback_pos_side_value),
        reduce_only: match order.reduce_only.trim().to_ascii_lowercase().as_str() {
            "true" | "1" => true,
            "false" | "0" => false,
            _ => fallback_reduce_only.unwrap_or(false),
        },
        operator: normalize_trade_operator(request.operator.as_ref()),
        strategy_id: optional_non_empty(&request.strategy_id),
        session_id: optional_non_empty(&request.session_id),
        opportunity_id: optional_non_empty(&request.opportunity_id),
        agent_run_id: optional_non_empty(&request.agent_run_id),
        execution_key: optional_non_empty(&request.execution_key),
    }
}

fn finish_trade_execution(
    app: &tauri::AppHandle,
    lease: &NormalExecutionLease,
    status: &str,
    order_id: Option<&str>,
    response: Option<&PlaceOrderResponse>,
    error: Option<&str>,
) -> Result<(), String> {
    let response_json = response
        .map(serde_json::to_string)
        .transpose()
        .map_err(|err| err.to_string())?;
    finish_normal_execution(
        app,
        lease,
        status,
        order_id,
        response_json.as_deref(),
        error,
    )
}

fn canonical_decimal_text(raw: &str) -> Option<String> {
    let value = raw.trim().strip_prefix('+').unwrap_or(raw.trim());
    if value.is_empty() || value.starts_with('-') {
        return None;
    }
    let mut parts = value.split('.');
    let integer = parts.next()?;
    let fraction = parts.next().unwrap_or_default();
    if parts.next().is_some()
        || integer.is_empty()
        || !integer.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let integer = integer.trim_start_matches('0');
    let integer = if integer.is_empty() { "0" } else { integer };
    let fraction = fraction.trim_end_matches('0');
    Some(if fraction.is_empty() {
        integer.to_string()
    } else {
        format!("{integer}.{fraction}")
    })
}

fn decimal_matches_normalized(raw: &str, normalized: &str) -> bool {
    canonical_decimal_text(raw).as_deref() == Some(normalized)
}

fn exact_order_decimal_blockers(
    request: &PlaceOrderRequest,
    instrument: &OkxInstrument,
) -> Vec<String> {
    use desic_trade_domain::{
        normalize_order_input, normalize_price, InstrumentDecimalRules, OrderNormalizationRequest,
        OrderSpec, RegularExecution, TrailingCallback,
    };

    let mut reasons = Vec::new();
    if let Err(error) = normalize_price(&instrument.tick_sz, &instrument.tick_sz) {
        reasons.push(format!("合约 tickSz 缺失或无效：{error}"));
        return reasons;
    }
    let order = match request.order_type.as_str() {
        "market" => OrderSpec::Regular {
            execution: RegularExecution::Market,
            price: None,
        },
        "limit" | "post_only" | "ioc" | "fok" => OrderSpec::Regular {
            execution: RegularExecution::Limit,
            price: Some(request.price.clone()),
        },
        "trigger" => {
            let order_price = request
                .order_spec_v2
                .as_ref()
                .and_then(|spec| spec.trigger.as_ref())
                .filter(|trigger| trigger.execution == "limit")
                .and_then(|trigger| trigger.order_price.clone());
            OrderSpec::Trigger {
                trigger_price: request.price.clone(),
                order_price,
            }
        }
        "move_order_stop" => {
            let Some(trailing) = request
                .order_spec_v2
                .as_ref()
                .and_then(|spec| spec.trailing.as_ref())
            else {
                reasons.push("移动止损缺少 orderSpecV2.trailing".to_string());
                return reasons;
            };
            OrderSpec::Trailing {
                activation_price: trailing.activation_price.clone(),
                callback: TrailingCallback::Ratio(trailing.callback_ratio.clone()),
            }
        }
        _ => return reasons,
    };
    let domain_request = OrderNormalizationRequest {
        size: request.size.clone(),
        rules: InstrumentDecimalRules {
            min_size: instrument.min_sz.clone(),
            lot_size: instrument.lot_sz.clone(),
            tick_size: instrument.tick_sz.clone(),
        },
        order,
    };
    let normalized = match normalize_order_input(&domain_request) {
        Ok(value) => value,
        Err(error) => {
            reasons.push(format!("合约精确数值校验失败：{error}"));
            return reasons;
        }
    };
    if !decimal_matches_normalized(&request.size, &normalized.size) {
        reasons.push(format!(
            "下单张数必须不低于 minSz {} 且按 lotSz {} 对齐；精确可用值为 {}",
            instrument.min_sz, instrument.lot_sz, normalized.size
        ));
    }
    match (&domain_request.order, &normalized.order) {
        (
            OrderSpec::Regular {
                execution: RegularExecution::Limit,
                price: Some(raw),
            },
            OrderSpec::Regular {
                price: Some(aligned),
                ..
            },
        ) if !decimal_matches_normalized(raw, aligned) => reasons.push(format!(
            "委托价格必须按 tickSz {} 对齐；精确可用值为 {}",
            instrument.tick_sz, aligned
        )),
        (
            OrderSpec::Trigger {
                trigger_price,
                order_price,
            },
            OrderSpec::Trigger {
                trigger_price: aligned_trigger,
                order_price: aligned_order,
            },
        ) => {
            if !decimal_matches_normalized(trigger_price, aligned_trigger) {
                reasons.push(format!(
                    "触发价格必须按 tickSz {} 对齐；精确可用值为 {}",
                    instrument.tick_sz, aligned_trigger
                ));
            }
            if let (Some(raw), Some(aligned)) = (order_price, aligned_order) {
                if !decimal_matches_normalized(raw, aligned) {
                    reasons.push(format!(
                        "触发后的限价价格必须按 tickSz {} 对齐；精确可用值为 {}",
                        instrument.tick_sz, aligned
                    ));
                }
            }
        }
        (
            OrderSpec::Trailing {
                activation_price: Some(raw),
                ..
            },
            OrderSpec::Trailing {
                activation_price: Some(aligned),
                ..
            },
        ) if !decimal_matches_normalized(raw, aligned) => reasons.push(format!(
            "移动止损激活价格必须按 tickSz {} 对齐；精确可用值为 {}",
            instrument.tick_sz, aligned
        )),
        _ => {}
    }
    reasons
}

fn classified_order_rejection_with_required_margin(
    request: &PlaceOrderRequest,
    instrument: &OkxInstrument,
    source: &str,
    operation: &str,
    code: &str,
    message: &str,
) -> String {
    let classified = classified_okx_error(source, operation, code, message);
    if request.ticket_mode != "open" || !is_insufficient_margin_error(message) {
        return classified;
    }
    let Some(required_margin) = estimated_open_margin_usdt(request, instrument) else {
        return classified;
    };
    let required_text = format!("需要保证金：{} USDT", trim_float(required_margin));
    let Ok(mut payload) = serde_json::from_str::<Value>(&classified) else {
        return classified;
    };
    let Some(object) = payload.as_object_mut() else {
        return classified;
    };
    for field in ["userMessage", "suggestion"] {
        let existing = object
            .get(field)
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !existing.contains("需要保证金：") {
            let value = if existing.is_empty() {
                required_text.clone()
            } else {
                format!("{existing}；{required_text}")
            };
            object.insert(field.to_string(), Value::String(value));
        }
    }
    serde_json::to_string(&payload).unwrap_or(classified)
}

fn estimated_open_margin_usdt(
    request: &PlaceOrderRequest,
    instrument: &OkxInstrument,
) -> Option<f64> {
    if !instrument.ct_type.eq_ignore_ascii_case("linear")
        || !instrument.settle_ccy.eq_ignore_ascii_case("USDT")
    {
        return None;
    }
    let evaluation = desic_trade_domain::evaluate_linear_usdt_perpetual(
        &desic_trade_domain::LinearUsdtPerpetualEvaluationRequest {
            size: request.size.clone(),
            entry_price: request.price.clone(),
            contract_value: instrument.ct_val.clone(),
            leverage: request.lever.clone(),
            min_size: instrument.min_sz.clone(),
            lot_size: instrument.lot_sz.clone(),
            equity: None,
            available_usdt: None,
            max_single_trade_margin_pct: None,
            direction: None,
            stop_price: None,
            target_price: None,
            atr: None,
            entry_fee_rate: "0".to_string(),
            exit_fee_rate: "0".to_string(),
        },
    )
    .ok()?;
    parse_optional_f64(&evaluation.candidate.estimated_initial_margin_usdt)
}

fn ensure_final_order_blockers(blockers: &[String]) -> Result<(), String> {
    if blockers.is_empty() {
        Ok(())
    } else {
        Err(format!("下单前风控未通过：{}", blockers.join("；")))
    }
}

fn final_account_config_blockers(config: &OkxAccountConfig) -> Vec<String> {
    let mut reasons = Vec::new();
    if !config.perm.split(',').any(|perm| perm.trim() == "trade") {
        reasons.push("OKX API Key 未包含 trade 权限".to_string());
    }
    if config.acct_lv == "1" {
        reasons.push("当前账户为现货模式，不能交易永续合约".to_string());
    }
    if !matches!(config.pos_mode.as_str(), "net_mode" | "long_short_mode") {
        reasons.push("OKX 持仓模式缺失或无效".to_string());
    }
    reasons
}

fn final_order_blockers(
    account: &LocalAccount,
    request: &PlaceOrderRequest,
    instrument: &OkxInstrument,
) -> Vec<String> {
    let mut reasons = Vec::new();
    if account.exchange.to_lowercase() != "okx" {
        reasons.push(format!("不支持的交易所：{}", account.exchange));
    }
    if normalize_environment(&account.environment) != normalize_environment(&request.environment) {
        reasons.push("账号环境与当前交易环境不一致".to_string());
    }
    if !account.permissions.trade {
        reasons.push("账号未开启交易权限".to_string());
    }
    if !instrument.inst_type.eq_ignore_ascii_case("SWAP") {
        reasons.push("当前只支持 OKX 永续合约 SWAP".to_string());
    }
    if !instrument.state.is_empty() && !instrument.state.eq_ignore_ascii_case("live") {
        reasons.push(format!("合约当前不可交易：{}", instrument.state));
    }
    if request.td_mode != "cross" && request.td_mode != "isolated" {
        reasons.push("保证金模式必须是 cross 或 isolated".to_string());
    }
    if ![
        "limit",
        "market",
        "post_only",
        "ioc",
        "fok",
        "trigger",
        "move_order_stop",
    ]
    .contains(&request.order_type.as_str())
    {
        reasons.push("委托类型无效".to_string());
    }
    if !["open", "close"].contains(&request.ticket_mode.as_str()) {
        reasons.push("交易模式必须是开仓或平仓".to_string());
    }
    if !matches!(
        (request.ticket_mode.as_str(), request.action.as_str()),
        ("open", "long" | "short") | ("close", "close-long" | "close-short")
    ) {
        reasons.push("交易模式与下单方向不一致".to_string());
    }
    if optional_non_empty(&request.execution_key).is_none() {
        reasons.push("下单缺少稳定 executionKey，无法提供幂等与崩溃恢复保护".to_string());
    }
    if request.ticket_mode == "close"
        && request
            .attach_algo_ords
            .as_ref()
            .is_some_and(|orders| !orders.is_empty())
    {
        reasons.push("平仓委托不能附加新的止盈止损".to_string());
    }
    let price = request.price.trim().parse::<f64>().ok();
    let size = request.size.trim().parse::<f64>().ok();
    let lever = request.lever.trim().parse::<f64>().ok();
    let needs_primary_price = matches!(
        request.order_type.as_str(),
        "limit" | "post_only" | "ioc" | "fok" | "trigger"
    );
    if needs_primary_price && !matches!(price, Some(value) if value > 0.0) {
        reasons.push("价格无效".to_string());
    }
    if !matches!(size, Some(value) if value > 0.0) {
        reasons.push("请输入下单张数".to_string());
    }
    if !matches!(lever, Some(value) if value > 0.0) {
        reasons.push("杠杆无效".to_string());
    }
    reasons.extend(exact_order_decimal_blockers(request, instrument));
    let ct_val = parse_optional_f64(&instrument.ct_val);
    let max_lever = parse_optional_f64(&instrument.lever);
    let max_size = if request.order_type == "market" {
        parse_optional_f64(&instrument.max_mkt_sz)
    } else {
        parse_optional_f64(&instrument.max_lmt_sz)
    };
    if !matches!(ct_val, Some(value) if value > 0.0) {
        reasons.push("合约 ctVal 缺失或无效".to_string());
    }
    if !matches!(max_lever, Some(value) if value > 0.0) {
        reasons.push("合约最大杠杆 lever 缺失或无效".to_string());
    }
    if !matches!(max_size, Some(value) if value > 0.0) {
        reasons.push(if request.order_type == "market" {
            "合约最大市价张数 maxMktSz 缺失或无效".to_string()
        } else {
            "合约最大限价张数 maxLmtSz 缺失或无效".to_string()
        });
    }
    if let (Some(size), Some(max_size)) = (size, max_size) {
        if max_size > 0.0 && size > max_size {
            reasons.push(format!(
                "下单张数超过当前委托类型上限 {}",
                trim_float(max_size)
            ));
        }
    }
    if let (Some(lever), Some(max_lever)) = (lever, max_lever) {
        if max_lever > 0.0 && lever > max_lever {
            reasons.push(format!("杠杆超过合约最大杠杆 {}X", trim_float(max_lever)));
        }
    }
    reasons
}

#[tauri::command]
pub async fn okx_cancel_order(
    runtime: tauri::State<'_, MarketRuntime>,
    app: tauri::AppHandle,
    request: CancelOrderRequest,
) -> Result<OkxOrderResult, String> {
    let cancel_started = Instant::now();
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    ensure_account_snapshot_current(&app, &account)?;
    let account_ready_ms = cancel_started.elapsed().as_millis() as i64;
    let account_config_cache_hit =
        ensure_trade_account_cached(runtime.inner(), &account, &request.environment).await?;
    let account_checked_ms = cancel_started.elapsed().as_millis() as i64;
    let operator = normalize_trade_operator(request.operator.as_ref());
    if operator == "ai" && request.reason.as_deref().unwrap_or("").trim().is_empty() {
        return Err("AI 撤单必须提供 reason".to_string());
    }
    let strategy_id = optional_non_empty(&request.opportunity_id);
    let session_id = optional_non_empty(&request.agent_run_id);
    if request.ord_id.as_deref().unwrap_or("").trim().is_empty()
        && request.cl_ord_id.as_deref().unwrap_or("").trim().is_empty()
        && request.algo_id.as_deref().unwrap_or("").trim().is_empty()
        && request
            .algo_cl_ord_id
            .as_deref()
            .unwrap_or("")
            .trim()
            .is_empty()
    {
        return Err("撤单需要 ordId 或 clOrdId".to_string());
    }
    let cancel_target = resolve_cancel_target(&app, &account, &request)?;
    let target_resolved_ms = cancel_started.elapsed().as_millis() as i64;
    if cancel_target.is_algo {
        let body = CancelAlgoOrderBody {
            inst_id: request.inst_id.clone(),
            algo_id: cancel_target.ord_id.clone(),
            algo_cl_ord_id: cancel_target.cl_ord_id.clone(),
        };
        let cancel_bodies = vec![body];
        let account_mutation_lease =
            AccountMutationLeaseGuard::begin(&app, &account, "cancel_algo_order")?;
        account_mutation_lease.renew()?;
        let rest_submit_started = Instant::now();
        let envelope = okx_private_post::<OkxAlgoOrderResult, _>(
            &account,
            "/api/v5/trade/cancel-algos",
            &cancel_bodies,
        )
        .await?;
        let rest_submit_ms = rest_submit_started.elapsed().as_millis() as i64;
        let result = envelope
            .data
            .into_iter()
            .next()
            .ok_or_else(|| "OKX 撤销计划委托返回为空".to_string())?;
        if result.s_code != "0" {
            audit_trade_event(
                &app,
                &account,
                &request.inst_id,
                "order_cancel",
                "cancel_algo_order",
                "rejected",
                Some("trigger"),
                Some(&result.algo_id),
                Some(&result.algo_cl_ord_id),
                None,
                None,
                None,
                None,
                None,
                &operator,
                strategy_id.clone(),
                session_id.clone(),
                normalize_environment(&request.environment) == "live",
                Some(&result.s_code),
                Some(&result.s_msg),
                Some(&result.s_msg),
                json!({
                    "request": &request,
                    "okxBody": &cancel_bodies,
                    "transport": "rest_cancel_algo",
                    "latencyMs": {
                        "accountConfigCacheHit": account_config_cache_hit,
                        "accountReady": account_ready_ms,
                        "accountChecked": account_checked_ms,
                        "targetResolved": target_resolved_ms,
                        "restSubmit": rest_submit_ms,
                        "total": cancel_started.elapsed().as_millis() as i64
                    }
                }),
                Some(json!(&result)),
            );
            return Err(classified_okx_error(
                "okx_cancel_algo_order",
                "撤销计划委托",
                &result.s_code,
                &result.s_msg,
            ));
        }
        mark_local_order_cancelled(
            &app,
            &account,
            result.algo_id.as_str(),
            result.algo_cl_ord_id.as_str(),
            "local-algo-cancel",
            &result,
        )?;
        crate::market_ws::remove_pending_order_from_snapshot(
            &app,
            runtime.inner(),
            &account,
            result.algo_id.as_str(),
            result.algo_cl_ord_id.as_str(),
            true,
        );
        audit_trade_event(
            &app,
            &account,
            &request.inst_id,
            "order_cancel",
            "cancel_algo_order",
            "accepted",
            Some("trigger"),
            Some(&result.algo_id),
            Some(&result.algo_cl_ord_id),
            None,
            None,
            None,
            None,
            None,
            &operator,
            strategy_id.clone(),
            session_id.clone(),
            normalize_environment(&request.environment) == "live",
            Some(&result.s_code),
            Some(&result.s_msg),
            None,
            json!({
                "request": &request,
                "okxBody": &cancel_bodies,
                "transport": "rest_cancel_algo",
                "latencyMs": {
                    "accountConfigCacheHit": account_config_cache_hit,
                    "accountReady": account_ready_ms,
                    "accountChecked": account_checked_ms,
                    "targetResolved": target_resolved_ms,
                    "restSubmit": rest_submit_ms,
                    "total": cancel_started.elapsed().as_millis() as i64
                }
            }),
            Some(json!(&result)),
        );
        eprintln!(
            "trade_latency order_cancel inst={} env={} transport=rest_cancel_algo cacheHit={} accountReadyMs={} accountCheckedMs={} targetResolvedMs={} restSubmitMs={} totalMs={}",
            request.inst_id,
            account.environment,
            account_config_cache_hit,
            account_ready_ms,
            account_checked_ms,
            target_resolved_ms,
            rest_submit_ms,
            cancel_started.elapsed().as_millis()
        );
        return Ok(OkxOrderResult {
            ord_id: result.algo_id,
            cl_ord_id: result.algo_cl_ord_id,
            s_code: result.s_code,
            s_msg: result.s_msg,
            ts: result.ts,
        });
    }
    let body = CancelOrderBody {
        inst_id: request.inst_id.clone(),
        ord_id: cancel_target.ord_id,
        cl_ord_id: cancel_target.cl_ord_id,
    };
    let ws_request_id = format!("cxl{}", now_ms());
    let instrument = fetch_instrument(&app, &request.inst_id).await?;
    let instrument_ready_ms = cancel_started.elapsed().as_millis() as i64;
    let ws_body = okx_ws_trade_body(&body, &instrument, "撤单")?;
    let ws_payload = json!({
        "id": ws_request_id,
        "op": "cancel-order",
        "args": [ws_body]
    });
    let account_mutation_lease = AccountMutationLeaseGuard::begin(&app, &account, "cancel_order")?;
    account_mutation_lease.renew()?;
    let before_ws_ms = cancel_started.elapsed().as_millis() as i64;
    let ws_started = Instant::now();
    let ws_response = send_private_trade_command(runtime.inner(), &account, ws_payload).await;
    let ws_roundtrip_ms = ws_started.elapsed().as_millis() as i64;
    let mut ws_error: Option<String> = None;
    let mut fallback_rest_submit_ms: Option<i64> = None;
    let (result, transport_hint) = match ws_response {
        Ok(value) => {
            let data = value
                .get("data")
                .and_then(|item| item.as_array())
                .and_then(|items| items.first())
                .ok_or_else(|| "OKX WS 撤单返回为空".to_string())?;
            (
                serde_json::from_value::<OkxOrderResult>(data.clone())
                    .map_err(|err| err.to_string())?,
                "ws",
            )
        }
        Err(error) => {
            ws_error = Some(error);
            account_mutation_lease.renew()?;
            let rest_submit_started = Instant::now();
            let envelope = okx_private_post::<OkxOrderResult, _>(
                &account,
                "/api/v5/trade/cancel-order",
                &body,
            )
            .await?;
            fallback_rest_submit_ms = Some(rest_submit_started.elapsed().as_millis() as i64);
            (
                envelope
                    .data
                    .into_iter()
                    .next()
                    .ok_or_else(|| "OKX 撤单返回为空".to_string())?,
                "rest_fallback",
            )
        }
    };
    if result.s_code != "0" {
        audit_trade_event(
            &app,
            &account,
            &request.inst_id,
            "order_cancel",
            "cancel_order",
            "rejected",
            None,
            Some(&result.ord_id),
            Some(&result.cl_ord_id),
            None,
            None,
            None,
            None,
            None,
            &operator,
            strategy_id.clone(),
            session_id.clone(),
            normalize_environment(&request.environment) == "live",
            Some(&result.s_code),
            Some(&result.s_msg),
            Some(&result.s_msg),
            json!({
                "request": &request,
                "okxBody": &body,
                "transport": transport_hint,
                "wsError": ws_error,
                "latencyMs": {
                    "accountConfigCacheHit": account_config_cache_hit,
                    "accountReady": account_ready_ms,
                    "accountChecked": account_checked_ms,
                    "targetResolved": target_resolved_ms,
                    "instrumentReady": instrument_ready_ms,
                    "beforeWs": before_ws_ms,
                    "wsRoundtrip": ws_roundtrip_ms,
                    "restSubmit": fallback_rest_submit_ms,
                    "total": cancel_started.elapsed().as_millis() as i64
                }
            }),
            Some(json!(&result)),
        );
        return Err(classified_okx_error(
            "okx_cancel_order",
            "撤单",
            &result.s_code,
            &result.s_msg,
        ));
    }
    mark_local_order_cancelled(
        &app,
        &account,
        result.ord_id.as_str(),
        result.cl_ord_id.as_str(),
        "local-cancel",
        &result,
    )?;
    crate::market_ws::remove_pending_order_from_snapshot(
        &app,
        runtime.inner(),
        &account,
        result.ord_id.as_str(),
        result.cl_ord_id.as_str(),
        false,
    );
    audit_trade_event(
        &app,
        &account,
        &request.inst_id,
        "order_cancel",
        "cancel_order",
        "accepted",
        None,
        Some(&result.ord_id),
        Some(&result.cl_ord_id),
        None,
        None,
        None,
        None,
        None,
        &operator,
        strategy_id,
        session_id,
        normalize_environment(&request.environment) == "live",
        Some(&result.s_code),
        Some(&result.s_msg),
        None,
        json!({
            "request": &request,
            "okxBody": &body,
            "transport": transport_hint,
            "wsError": ws_error,
            "latencyMs": {
                "accountConfigCacheHit": account_config_cache_hit,
                "accountReady": account_ready_ms,
                "accountChecked": account_checked_ms,
                "targetResolved": target_resolved_ms,
                "instrumentReady": instrument_ready_ms,
                "beforeWs": before_ws_ms,
                "wsRoundtrip": ws_roundtrip_ms,
                "restSubmit": fallback_rest_submit_ms,
                "total": cancel_started.elapsed().as_millis() as i64
            }
        }),
        Some(json!(&result)),
    );
    eprintln!(
        "trade_latency order_cancel inst={} env={} transport={} cacheHit={} accountReadyMs={} accountCheckedMs={} targetResolvedMs={} instrumentReadyMs={} beforeWsMs={} wsRoundtripMs={} restSubmitMs={} totalMs={} wsError={}",
        request.inst_id,
        account.environment,
        transport_hint,
        account_config_cache_hit,
        account_ready_ms,
        account_checked_ms,
        target_resolved_ms,
        instrument_ready_ms,
        before_ws_ms,
        ws_roundtrip_ms,
        fallback_rest_submit_ms.unwrap_or_default(),
        cancel_started.elapsed().as_millis(),
        ws_error.as_deref().unwrap_or("")
    );
    Ok(result)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AmendOrderRequest {
    account_id: Option<String>,
    environment: String,
    inst_id: String,
    ord_id: Option<String>,
    cl_ord_id: Option<String>,
    new_size: Option<String>,
    new_price: Option<String>,
    confirmed_live: Option<bool>,
    pub(crate) operator: Option<String>,
    opportunity_id: Option<String>,
    opportunity_revision: Option<i64>,
    pub(crate) agent_run_id: Option<String>,
    execution_key: Option<String>,
    execution_leg: Option<String>,
    reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AmendOrderBody {
    inst_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    ord_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cl_ord_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_sz: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_px: Option<String>,
}

#[tauri::command]
pub async fn okx_amend_order(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, MarketRuntime>,
    mut request: AmendOrderRequest,
) -> Result<OkxOrderResult, String> {
    if normalize_environment(&request.environment) == "live" && request.confirmed_live != Some(true)
    {
        return Err("实盘改单缺少二次确认标记".to_string());
    }
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    ensure_account_snapshot_current(&app, &account)?;
    ensure_trade_account(&account, &request.environment).await?;
    let operator = normalize_trade_operator(request.operator.as_ref());
    if operator == "ai" && request.reason.as_deref().unwrap_or("").trim().is_empty() {
        return Err("AI 改单必须提供 reason".to_string());
    }
    if request.ord_id.as_deref().unwrap_or("").trim().is_empty()
        && request.cl_ord_id.as_deref().unwrap_or("").trim().is_empty()
    {
        return Err("改单需要 ordId 或 clOrdId".to_string());
    }
    if request.new_size.as_deref().unwrap_or("").trim().is_empty()
        && request.new_price.as_deref().unwrap_or("").trim().is_empty()
    {
        return Err("改单需要新数量或新价格".to_string());
    }
    let increases_risk = amend_increases_risk(&app, &account, &request)?;
    if operator == "ai" && increases_risk {
        let opportunity = validate_ai_risk_increase_opportunity(
            &app,
            &account,
            &request.environment,
            &request.inst_id,
            request.opportunity_id.as_deref(),
            request.opportunity_revision,
            request.agent_run_id.as_deref(),
        )?;
        if let (Some(new_size), Ok(max_size)) = (
            request
                .new_size
                .as_deref()
                .and_then(|value| value.parse::<f64>().ok()),
            opportunity.size.parse::<f64>(),
        ) {
            if new_size > max_size + 1e-10 {
                return Err("改单后的数量超过交易机会批准数量".to_string());
            }
        }
        request.execution_leg = Some("primary".to_string());
        request.execution_key = Some(format!(
            "opportunity:{}:revision:{}:amend:{}:size:{}:price:{}",
            opportunity.id,
            opportunity.revision,
            request
                .ord_id
                .as_deref()
                .or(request.cl_ord_id.as_deref())
                .unwrap_or("order"),
            request
                .new_size
                .as_deref()
                .map(normalize_fingerprint_number)
                .unwrap_or_else(|| "unchanged".to_string()),
            request
                .new_price
                .as_deref()
                .map(normalize_fingerprint_number)
                .unwrap_or_else(|| "unchanged".to_string())
        ));
    } else if operator == "ai" {
        let run_id = request.agent_run_id.as_deref().unwrap_or("interactive");
        request.execution_leg = Some("primary".to_string());
        request.execution_key = Some(format!(
            "agent:{}:amend:{}:{}:{}",
            run_id,
            request
                .ord_id
                .as_deref()
                .or(request.cl_ord_id.as_deref())
                .unwrap_or("order"),
            request.new_size.as_deref().unwrap_or("unchanged"),
            request.new_price.as_deref().unwrap_or("unchanged")
        ));
    }
    if optional_non_empty(&request.execution_key).is_none() {
        return Err("改单缺少稳定 executionKey，无法提供幂等与崩溃恢复保护".to_string());
    }
    let body = AmendOrderBody {
        inst_id: request.inst_id.clone(),
        ord_id: request
            .ord_id
            .clone()
            .filter(|value| !value.trim().is_empty()),
        cl_ord_id: request
            .cl_ord_id
            .clone()
            .filter(|value| !value.trim().is_empty()),
        new_sz: request
            .new_size
            .clone()
            .filter(|value| !value.trim().is_empty()),
        new_px: request
            .new_price
            .clone()
            .filter(|value| !value.trim().is_empty()),
    };
    let instrument = fetch_instrument(&app, &request.inst_id).await?;
    let _trade_mutation_guard = if increases_risk {
        let guard = TRADE_MUTATION_LOCK.lock().await;
        let unresolved = unresolved_trade_execution_guards_for_scope(
            &app,
            &account,
            &request.inst_id,
            request.execution_key.as_deref(),
        )?;
        if !unresolved.is_empty() {
            return Err("当前账号与品种存在未完成对账的交易执行，已阻止增加风险的改单".to_string());
        }
        if !crate::instrument_operations::unresolved_instrument_operations_for_scope(
            &app,
            &account,
            &request.inst_id,
        )?
        .is_empty()
        {
            return Err("当前账号与品种存在未终态紧急操作，已阻止增加风险的改单".to_string());
        }
        Some(guard)
    } else {
        None
    };
    let reservation = reserve_amend_execution(&app, &account, &request, increases_risk)?;
    let execution_lease = match reservation {
        ExecutionReservation::New(lease) => lease,
        ExecutionReservation::Existing(response) => return Ok(response),
        ExecutionReservation::Reconcile(lease) => {
            match reconcile_order(
                &account,
                &request.inst_id,
                request.ord_id.as_deref(),
                request.cl_ord_id.as_deref(),
                false,
            )
            .await
            {
                Ok(Some(order)) if amend_matches_order(&request, &order) => {
                    let result =
                        reconciled_amend_result(&order, "已通过 OKX 对账确认改单生效，未重复提交");
                    finish_amend_execution(&app, &lease, "accepted", Some(&result), None)?;
                    return Ok(result);
                }
                Ok(Some(_)) => {
                    resume_trade_execution_after_reconciliation(&app, &lease)?;
                }
                Ok(None) => {
                    let error = "原订单已不存在，无法安全重试改单".to_string();
                    finish_amend_execution(&app, &lease, "rejected", None, Some(&error))?;
                    return Err(error);
                }
                Err(err) => {
                    finish_amend_execution(&app, &lease, "unknown", None, Some(&err))?;
                    return Err(format!("无法确认上次改单是否生效，已阻止重复提交：{err}"));
                }
            }
            lease
        }
    };
    let ws_request_id = format!("amd{}", now_ms());
    let ws_body = okx_ws_trade_body(&body, &instrument, "改单")?;
    let ws_payload = json!({
        "id": ws_request_id,
        "op": "amend-order",
        "args": [ws_body]
    });
    let ws_response = send_private_trade_command(runtime.inner(), &account, ws_payload).await;
    let (result, transport_hint) = match ws_response {
        Ok(value) => {
            let data = value
                .get("data")
                .and_then(|item| item.as_array())
                .and_then(|items| items.first())
                .ok_or_else(|| "OKX WS 改单返回为空".to_string())?;
            (
                serde_json::from_value::<OkxOrderResult>(data.clone())
                    .map_err(|err| err.to_string())?,
                "ws",
            )
        }
        Err(ws_err) => {
            match reconcile_order(
                &account,
                &request.inst_id,
                request.ord_id.as_deref(),
                request.cl_ord_id.as_deref(),
                false,
            )
            .await
            {
                Ok(Some(order)) if amend_matches_order(&request, &order) => {
                    let result = reconciled_amend_result(
                        &order,
                        "WS 响应不明确，已通过 OKX 对账确认改单生效",
                    );
                    finish_amend_execution(
                        &app,
                        &execution_lease,
                        "accepted",
                        Some(&result),
                        None,
                    )?;
                    return Ok(result);
                }
                Ok(Some(_)) => {}
                Ok(None) => {
                    let error = format!("WS 改单结果不明确，且对账确认原订单已不存在：{ws_err}");
                    finish_amend_execution(&app, &execution_lease, "rejected", None, Some(&error))?;
                    return Err(error);
                }
                Err(reconcile_err) => {
                    let error =
                        format!("WS 改单结果不明确且 OKX 对账失败：{ws_err}；{reconcile_err}");
                    finish_amend_execution(&app, &execution_lease, "unknown", None, Some(&error))?;
                    return Err(error);
                }
            }
            let envelope = match okx_private_post::<OkxOrderResult, _>(
                &account,
                "/api/v5/trade/amend-order",
                &body,
            )
            .await
            {
                Ok(value) => value,
                Err(err) => {
                    finish_amend_execution(&app, &execution_lease, "unknown", None, Some(&err))?;
                    return Err(err);
                }
            };
            (
                envelope
                    .data
                    .into_iter()
                    .next()
                    .ok_or_else(|| "OKX 改单返回为空".to_string())?,
                "rest_fallback",
            )
        }
    };
    if result.s_code != "0" {
        finish_amend_execution(
            &app,
            &execution_lease,
            "rejected",
            Some(&result),
            Some(&result.s_msg),
        )?;
        audit_trade_event(
            &app,
            &account,
            &request.inst_id,
            "order_amend",
            "amend_order",
            "rejected",
            Some("limit"),
            Some(&result.ord_id),
            Some(&result.cl_ord_id),
            None,
            None,
            None,
            request.new_size.as_deref(),
            request.new_price.as_deref(),
            &operator,
            optional_non_empty(&request.opportunity_id),
            optional_non_empty(&request.agent_run_id),
            request.confirmed_live == Some(true),
            Some(&result.s_code),
            Some(&result.s_msg),
            Some(&result.s_msg),
            json!({ "request": &request, "okxBody": &body, "transport": transport_hint }),
            Some(json!(&result)),
        );
        return Err(classified_okx_error(
            "okx_amend_order",
            "改单",
            &result.s_code,
            &result.s_msg,
        ));
    }
    audit_trade_event(
        &app,
        &account,
        &request.inst_id,
        "order_amend",
        "amend_order",
        "accepted",
        Some("limit"),
        Some(&result.ord_id),
        Some(&result.cl_ord_id),
        None,
        None,
        None,
        request.new_size.as_deref(),
        request.new_price.as_deref(),
        &operator,
        optional_non_empty(&request.opportunity_id),
        optional_non_empty(&request.agent_run_id),
        request.confirmed_live == Some(true),
        Some(&result.s_code),
        Some(&result.s_msg),
        None,
        json!({ "request": &request, "okxBody": &body, "transport": transport_hint }),
        Some(json!(&result)),
    );
    finish_amend_execution(&app, &execution_lease, "accepted", Some(&result), None)?;
    Ok(result)
}

fn amend_increases_risk(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    request: &AmendOrderRequest,
) -> Result<bool, String> {
    let Some(new_size) = request
        .new_size
        .as_deref()
        .and_then(|value| value.trim().parse::<f64>().ok())
    else {
        return Ok(false);
    };
    let conn = open_database(app)?;
    let current_size = conn
        .query_row(
            "SELECT sz FROM okx_orders
             WHERE account_id=?1 AND environment=?2 AND inst_id=?3
               AND ((?4 IS NOT NULL AND ord_id=?4) OR (?5 IS NOT NULL AND cl_ord_id=?5))
             ORDER BY okx_utime DESC LIMIT 1",
            params![
                account.id,
                account.environment,
                request.inst_id,
                optional_non_empty(&request.ord_id),
                optional_non_empty(&request.cl_ord_id),
            ],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .flatten()
        .and_then(|value| value.parse::<f64>().ok());
    Ok(current_size
        .map(|current| new_size > current + 1e-10)
        .unwrap_or(true))
}

fn reserve_amend_execution(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    request: &AmendOrderRequest,
    increases_risk: bool,
) -> Result<ExecutionReservation<OkxOrderResult>, String> {
    let Some(execution_key) = optional_non_empty(&request.execution_key) else {
        return Err("改单缺少稳定 executionKey，无法建立跨进程执行租约".to_string());
    };
    let mut conn = open_database(app)?;
    let now = now_ms();
    let operation = "amend_order";
    let owner_token = new_normal_execution_owner_token(&execution_key, operation);
    let lease_expires_at = now.saturating_add(NORMAL_EXECUTION_LEASE_MS);
    let client_order_id = stable_client_order_id(&execution_key);
    let transaction = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|err| err.to_string())?;
    ensure_account_snapshot_current(app, account)?;
    if increases_risk {
        ensure_risk_increase_scope_available_with_conn(
            &transaction,
            account,
            &request.inst_id,
            Some(&execution_key),
            "增加风险的改单",
        )?;
    }
    let inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO trade_execution_attempts(
              execution_key,opportunity_id,agent_run_id,account_id,environment,
              credential_fingerprint,operation,client_order_id,status,request_json,
              owner_token,lease_expires_at,created_at,updated_at
            ) VALUES(?1,?2,?3,?4,?5,?6,'amend_order',?7,'submitting',?8,?9,?10,?11,?11)",
            params![
                execution_key,
                optional_non_empty(&request.opportunity_id),
                optional_non_empty(&request.agent_run_id),
                account.id,
                account.environment,
                account_config_cache_fingerprint(account),
                client_order_id,
                serde_json::to_string(request).map_err(|err| err.to_string())?,
                owner_token,
                lease_expires_at,
                now,
            ],
        )
        .map_err(|err| err.to_string())?;
    if inserted == 1 {
        transaction.commit().map_err(|err| err.to_string())?;
        return Ok(ExecutionReservation::New(NormalExecutionLease {
            execution_key,
            operation: operation.to_string(),
            owner_token,
        }));
    }
    let (stored_operation, stored_account_id, stored_environment, stored_credential_fingerprint, stored_request_json, status, response_json, error, stored_lease_expires_at) = transaction
        .query_row(
            "SELECT operation,account_id,environment,credential_fingerprint,request_json,status,response_json,error,lease_expires_at
             FROM trade_execution_attempts WHERE execution_key=?1",
            params![execution_key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, i64>(8)?,
                ))
            },
        )
        .map_err(|err| err.to_string())?;
    if !execution_credential_matches(&stored_credential_fingerprint, account) {
        return Err(
            "改单 executionKey 绑定的账号凭据已变化或旧记录未绑定凭据，已阻止提交与自动对账"
                .to_string(),
        );
    }
    if stored_operation != "amend_order"
        || stored_account_id != account.id
        || normalize_environment(&stored_environment) != normalize_environment(&account.environment)
    {
        return Err("executionKey 已被其他交易动作占用，已阻止改单".to_string());
    }
    let stored_request = serde_json::from_str::<AmendOrderRequest>(&stored_request_json)
        .map_err(|err| format!("改单幂等记录无法解析：{err}"))?;
    if amend_request_signature(&stored_request) != amend_request_signature(request) {
        return Err("相同 executionKey 对应的改单参数不一致，已阻止错误复用".to_string());
    }
    if status == "accepted" {
        let response = response_json
            .as_deref()
            .ok_or_else(|| "改单幂等记录缺少响应".to_string())
            .and_then(|value| serde_json::from_str(value).map_err(|err| err.to_string()))
            .map(ExecutionReservation::Existing)?;
        transaction.commit().map_err(|err| err.to_string())?;
        return Ok(response);
    }
    if status == "confirmed_not_applied" {
        let resumed = transaction
            .execute(
                "UPDATE trade_execution_attempts SET status='submitting',agent_run_id=?2,request_json=?3,
                 owner_token=?4,lease_expires_at=?5,error=NULL,updated_at=?6
                 WHERE execution_key=?1 AND operation='amend_order' AND status='confirmed_not_applied'",
                params![
                    execution_key,
                    optional_non_empty(&request.agent_run_id),
                    serde_json::to_string(request).map_err(|err| err.to_string())?,
                    owner_token,
                    lease_expires_at,
                    now,
                ],
            )
            .map_err(|err| err.to_string())?;
        if resumed == 1 {
            transaction.commit().map_err(|err| err.to_string())?;
            return Ok(ExecutionReservation::New(NormalExecutionLease {
                execution_key,
                operation: operation.to_string(),
                owner_token,
            }));
        }
    }
    if matches!(status.as_str(), "submitting" | "reconciling" | "unknown")
        && stored_lease_expires_at <= now
    {
        let claimed = transaction
            .execute(
                "UPDATE trade_execution_attempts
                 SET status='reconciling',owner_token=?2,lease_expires_at=?3,error=NULL,updated_at=?4
                 WHERE execution_key=?1 AND operation='amend_order'
                   AND status IN ('submitting','reconciling','unknown') AND lease_expires_at<=?4",
                params![execution_key, owner_token, lease_expires_at, now],
            )
            .map_err(|err| err.to_string())?;
        if claimed == 1 {
            transaction.commit().map_err(|err| err.to_string())?;
            return Ok(ExecutionReservation::Reconcile(NormalExecutionLease {
                execution_key,
                operation: operation.to_string(),
                owner_token,
            }));
        }
    }
    Err(format!(
        "相同改单 executionKey 已存在，已阻止重复提交：status={}{}",
        status,
        error
            .map(|value| format!("，error={value}"))
            .unwrap_or_default()
    ))
}

fn amend_matches_order(request: &AmendOrderRequest, order: &OkxPendingOrder) -> bool {
    let size_matches = request
        .new_size
        .as_deref()
        .map(|value| normalize_fingerprint_number(value) == normalize_fingerprint_number(&order.sz))
        .unwrap_or(true);
    let price_matches = request
        .new_price
        .as_deref()
        .map(|value| normalize_fingerprint_number(value) == normalize_fingerprint_number(&order.px))
        .unwrap_or(true);
    size_matches && price_matches
}

fn amend_request_signature(request: &AmendOrderRequest) -> String {
    json!({
        "accountId": optional_non_empty(&request.account_id),
        "environment": normalize_environment(&request.environment),
        "instId": request.inst_id,
        "ordId": optional_non_empty(&request.ord_id),
        "clOrdId": optional_non_empty(&request.cl_ord_id),
        "newSize": request.new_size.as_deref().map(normalize_fingerprint_number),
        "newPrice": request.new_price.as_deref().map(normalize_fingerprint_number),
        "opportunityId": optional_non_empty(&request.opportunity_id),
        "opportunityRevision": request.opportunity_revision,
        "agentRunId": optional_non_empty(&request.agent_run_id),
    })
    .to_string()
}

fn reconciled_amend_result(order: &OkxPendingOrder, message: &str) -> OkxOrderResult {
    OkxOrderResult {
        ord_id: order.ord_id.clone(),
        cl_ord_id: order.cl_ord_id.clone(),
        s_code: "0".to_string(),
        s_msg: message.to_string(),
        ts: reconciliation_timestamp(order),
    }
}

fn finish_amend_execution(
    app: &tauri::AppHandle,
    lease: &NormalExecutionLease,
    status: &str,
    response: Option<&OkxOrderResult>,
    error: Option<&str>,
) -> Result<(), String> {
    let response_json = response
        .map(serde_json::to_string)
        .transpose()
        .map_err(|err| err.to_string())?;
    finish_normal_execution(app, lease, status, None, response_json.as_deref(), error)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlaceAlgoOrderRequest {
    account_id: Option<String>,
    environment: String,
    inst_id: String,
    td_mode: String,
    pos_side: String,
    side: String,
    ord_type: String,
    size: String,
    tp_trigger_px: Option<String>,
    tp_ord_px: Option<String>,
    sl_trigger_px: Option<String>,
    sl_ord_px: Option<String>,
    confirmed_live: Option<bool>,
    operator: Option<String>,
    strategy_id: Option<String>,
    session_id: Option<String>,
    #[serde(default)]
    execution_key: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AmendAlgoOrderRequest {
    account_id: Option<String>,
    environment: String,
    inst_id: String,
    algo_id: Option<String>,
    algo_cl_ord_id: Option<String>,
    new_size: Option<String>,
    new_trigger_px: Option<String>,
    new_ord_px: Option<String>,
    new_tp_trigger_px: Option<String>,
    new_tp_ord_px: Option<String>,
    new_sl_trigger_px: Option<String>,
    new_sl_ord_px: Option<String>,
    confirmed_live: Option<bool>,
    #[serde(default)]
    execution_key: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CancelAlgoOrderRequest {
    account_id: Option<String>,
    environment: String,
    inst_id: String,
    algo_id: Option<String>,
    algo_cl_ord_id: Option<String>,
    confirmed_live: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ListAlgoOrdersRequest {
    account_id: Option<String>,
    environment: String,
    inst_id: Option<String>,
    include_history: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClosePositionRequest {
    account_id: Option<String>,
    environment: String,
    inst_id: String,
    mgn_mode: String,
    pos_side: String,
    confirmed_live: Option<bool>,
    operator: Option<String>,
    opportunity_id: Option<String>,
    agent_run_id: Option<String>,
    reason: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PlaceTpSlAlgoBody {
    inst_id: String,
    td_mode: String,
    algo_cl_ord_id: String,
    #[serde(rename = "tag")]
    client_marker: String,
    side: String,
    pos_side: String,
    ord_type: String,
    sz: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tp_trigger_px: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tp_trigger_px_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tp_ord_px: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tp_ord_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sl_trigger_px: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sl_trigger_px_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sl_ord_px: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reduce_only: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AmendAlgoOrderBody {
    inst_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    algo_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    algo_cl_ord_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_sz: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_trigger_px: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_ord_px: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_tp_trigger_px: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_tp_ord_px: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_tp_trigger_px_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_sl_trigger_px: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_sl_ord_px: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_sl_trigger_px_type: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClosePositionBody {
    inst_id: String,
    mgn_mode: String,
    pos_side: String,
    auto_cxl: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    cl_ord_id: Option<String>,
    #[serde(rename = "tag")]
    client_marker: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct OkxClosePositionResult {
    #[serde(default)]
    inst_id: String,
    #[serde(default)]
    pos_side: String,
    #[serde(default)]
    cl_ord_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AlgoOrderSummary {
    #[serde(default)]
    account_id: String,
    #[serde(default)]
    environment: String,
    #[serde(default)]
    inst_id: String,
    #[serde(default)]
    inst_type: String,
    #[serde(default)]
    algo_id: String,
    #[serde(default)]
    algo_cl_ord_id: String,
    #[serde(default)]
    ord_id: String,
    #[serde(default)]
    cl_ord_id: String,
    #[serde(default)]
    side: String,
    #[serde(default)]
    pos_side: String,
    #[serde(default)]
    td_mode: String,
    #[serde(default)]
    ord_type: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    sz: String,
    #[serde(default)]
    actual_side: String,
    #[serde(default)]
    actual_sz: String,
    #[serde(default)]
    trigger_px: String,
    #[serde(default)]
    trigger_px_type: String,
    #[serde(default)]
    ord_px: String,
    #[serde(default)]
    active_px: String,
    #[serde(default)]
    callback_ratio: String,
    #[serde(default)]
    callback_spread: String,
    #[serde(default)]
    tp_trigger_px: String,
    #[serde(default)]
    tp_trigger_px_type: String,
    #[serde(default)]
    tp_ord_px: String,
    #[serde(default)]
    sl_trigger_px: String,
    #[serde(default)]
    sl_trigger_px_type: String,
    #[serde(default)]
    sl_ord_px: String,
    #[serde(default)]
    reduce_only: String,
    #[serde(default)]
    fail_code: String,
    #[serde(default)]
    trigger_time: String,
    #[serde(default)]
    c_time: String,
    #[serde(default)]
    u_time: String,
    #[serde(default)]
    operator: String,
    #[serde(default)]
    source_endpoint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlgoOrdersResponse {
    account_id: String,
    environment: String,
    orders: Vec<AlgoOrderSummary>,
    synced_at: i64,
}

fn normalized_algo_number(value: &Option<String>) -> Option<String> {
    optional_non_empty(value).map(|value| normalize_fingerprint_number(&value))
}

fn place_algo_request_signature(request: &PlaceAlgoOrderRequest) -> String {
    let canonical = json!({
        "accountId": optional_non_empty(&request.account_id),
        "environment": normalize_environment(&request.environment),
        "instId": request.inst_id.trim().to_ascii_uppercase(),
        "tdMode": request.td_mode.trim().to_ascii_lowercase(),
        "posSide": request.pos_side.trim().to_ascii_lowercase(),
        "side": request.side.trim().to_ascii_lowercase(),
        "ordType": request.ord_type.trim().to_ascii_lowercase(),
        "size": normalize_fingerprint_number(&request.size),
        "tpTriggerPx": normalized_algo_number(&request.tp_trigger_px),
        "tpOrdPx": normalized_algo_number(&request.tp_ord_px),
        "slTriggerPx": normalized_algo_number(&request.sl_trigger_px),
        "slOrdPx": normalized_algo_number(&request.sl_ord_px),
        "confirmedLive": request.confirmed_live == Some(true),
        "operator": optional_non_empty(&request.operator),
        "strategyId": optional_non_empty(&request.strategy_id),
        "sessionId": optional_non_empty(&request.session_id),
    });
    sha256_hex(canonical.to_string().as_bytes())
}

fn amend_algo_request_signature(request: &AmendAlgoOrderRequest) -> String {
    let canonical = json!({
        "accountId": optional_non_empty(&request.account_id),
        "environment": normalize_environment(&request.environment),
        "instId": request.inst_id.trim().to_ascii_uppercase(),
        "algoId": optional_non_empty(&request.algo_id),
        "algoClOrdId": optional_non_empty(&request.algo_cl_ord_id),
        "newSize": normalized_algo_number(&request.new_size),
        "newTriggerPx": normalized_algo_number(&request.new_trigger_px),
        "newOrdPx": normalized_algo_number(&request.new_ord_px),
        "newTpTriggerPx": normalized_algo_number(&request.new_tp_trigger_px),
        "newTpOrdPx": normalized_algo_number(&request.new_tp_ord_px),
        "newSlTriggerPx": normalized_algo_number(&request.new_sl_trigger_px),
        "newSlOrdPx": normalized_algo_number(&request.new_sl_ord_px),
        "confirmedLive": request.confirmed_live == Some(true),
    });
    sha256_hex(canonical.to_string().as_bytes())
}

fn place_algo_body(request: &PlaceAlgoOrderRequest, algo_cl_ord_id: &str) -> PlaceTpSlAlgoBody {
    PlaceTpSlAlgoBody {
        inst_id: request.inst_id.clone(),
        td_mode: request.td_mode.clone(),
        algo_cl_ord_id: algo_cl_ord_id.to_string(),
        client_marker: exchange_client_marker(),
        side: request.side.clone(),
        pos_side: request.pos_side.clone(),
        ord_type: request.ord_type.clone(),
        sz: request.size.clone(),
        tp_trigger_px: optional_non_empty(&request.tp_trigger_px),
        tp_trigger_px_type: optional_non_empty(&request.tp_trigger_px).map(|_| "last".to_string()),
        tp_ord_px: optional_non_empty(&request.tp_ord_px),
        tp_ord_kind: optional_non_empty(&request.tp_ord_px)
            .filter(|value| value != "-1")
            .map(|_| "limit".to_string()),
        sl_trigger_px: optional_non_empty(&request.sl_trigger_px),
        sl_trigger_px_type: optional_non_empty(&request.sl_trigger_px).map(|_| "last".to_string()),
        sl_ord_px: optional_non_empty(&request.sl_ord_px),
        reduce_only: request.pos_side.eq_ignore_ascii_case("net").then_some(true),
    }
}

fn amend_algo_body(request: &AmendAlgoOrderRequest) -> AmendAlgoOrderBody {
    AmendAlgoOrderBody {
        inst_id: request.inst_id.clone(),
        algo_id: optional_non_empty(&request.algo_id),
        algo_cl_ord_id: optional_non_empty(&request.algo_cl_ord_id),
        new_sz: optional_non_empty(&request.new_size),
        new_trigger_px: optional_non_empty(&request.new_trigger_px),
        new_ord_px: optional_non_empty(&request.new_ord_px),
        new_tp_trigger_px: optional_non_empty(&request.new_tp_trigger_px),
        new_tp_ord_px: optional_non_empty(&request.new_tp_ord_px),
        new_tp_trigger_px_type: optional_non_empty(&request.new_tp_trigger_px)
            .map(|_| "last".to_string()),
        new_sl_trigger_px: optional_non_empty(&request.new_sl_trigger_px),
        new_sl_ord_px: optional_non_empty(&request.new_sl_ord_px),
        new_sl_trigger_px_type: optional_non_empty(&request.new_sl_trigger_px)
            .map(|_| "last".to_string()),
    }
}

fn reserve_algo_execution<T, F, V>(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    execution_key: &str,
    operation: &str,
    client_order_id: &str,
    request_json: &str,
    request_signature: &str,
    stored_signature: F,
    validate_existing: V,
) -> Result<AlgoExecutionReservation<T>, String>
where
    T: serde::de::DeserializeOwned,
    F: Fn(&str) -> Result<String, String>,
    V: Fn(&T) -> Result<(), String>,
{
    let mut conn = open_database(app)?;
    let now = now_ms();
    let owner_token = new_algo_execution_owner_token(execution_key, operation);
    let lease_expires_at = now.saturating_add(ALGO_EXECUTION_LEASE_MS);
    let transaction = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|err| err.to_string())?;
    ensure_account_snapshot_current(app, account)?;
    let inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO trade_execution_attempts(
              execution_key,account_id,environment,credential_fingerprint,operation,
              client_order_id,status,request_json,owner_token,lease_expires_at,created_at,updated_at
             ) VALUES(?1,?2,?3,?4,?5,?6,'submitting',?7,?8,?9,?10,?10)",
            params![
                execution_key,
                account.id,
                account.environment,
                account_config_cache_fingerprint(account),
                operation,
                client_order_id,
                request_json,
                owner_token,
                lease_expires_at,
                now,
            ],
        )
        .map_err(|err| err.to_string())?;
    transaction.commit().map_err(|err| err.to_string())?;
    if inserted == 1 {
        return Ok(AlgoExecutionReservation::New(AlgoExecutionLease {
            execution_key: execution_key.to_string(),
            operation: operation.to_string(),
            owner_token,
        }));
    }

    let row = conn.query_row(
        "SELECT operation,account_id,environment,credential_fingerprint,client_order_id,
                request_json,status,response_json,error,lease_expires_at
         FROM trade_execution_attempts WHERE execution_key=?1",
        params![execution_key],
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
                row.get::<_, Option<String>>(8)?,
                row.get::<_, i64>(9)?,
            ))
        },
    );
    let (
        stored_operation,
        stored_account_id,
        stored_environment,
        stored_credential_fingerprint,
        stored_client_order_id,
        stored_request_json,
        status,
        response_json,
        error,
        lease_expires_at,
    ) = row.map_err(|err| {
        format!("稳定客户端订单 ID 已被其他 executionKey 占用，已阻止策略交易：{err}")
    })?;
    if stored_operation != operation
        || stored_account_id != account.id
        || normalize_environment(&stored_environment) != normalize_environment(&account.environment)
        || stored_client_order_id != client_order_id
    {
        return Err("executionKey 已被其他交易动作或身份占用，已阻止策略交易".to_string());
    }
    if !execution_credential_matches(&stored_credential_fingerprint, account) {
        return Err(
            "策略交易 executionKey 绑定的账号凭据已变化或旧记录未绑定凭据，已阻止提交与自动对账"
                .to_string(),
        );
    }
    if stored_signature(&stored_request_json)? != request_signature {
        return Err("相同 executionKey 对应的策略交易参数不一致，已阻止错误复用".to_string());
    }
    if status == "accepted" {
        let response = response_json
            .as_deref()
            .ok_or_else(|| "策略交易幂等记录缺少响应快照".to_string())
            .and_then(|value| serde_json::from_str::<T>(value).map_err(|err| err.to_string()))?;
        validate_existing(&response)?;
        return Ok(AlgoExecutionReservation::Existing(response));
    }

    if matches!(status.as_str(), "submitting" | "reconciling" | "unknown") {
        if lease_expires_at <= now
            && claim_algo_execution_lease_with_conn(
                &conn,
                execution_key,
                operation,
                &owner_token,
                now,
            )?
        {
            return Ok(AlgoExecutionReservation::Reconcile(AlgoExecutionLease {
                execution_key: execution_key.to_string(),
                operation: operation.to_string(),
                owner_token,
            }));
        }
        if let Some(response) = load_persisted_accepted_algo_response(
            &conn,
            execution_key,
            operation,
            &validate_existing,
        )? {
            return Ok(AlgoExecutionReservation::Existing(response));
        }
        return Err(format!(
            "{ALGO_EXECUTION_LEASE_LOST}: 相同策略交易 executionKey 正由其他执行者处理"
        ));
    }
    Err(format!(
        "相同策略交易 executionKey 已存在，已阻止重复提交：status={}{}",
        status,
        error
            .map(|value| format!("，error={value}"))
            .unwrap_or_default()
    ))
}

enum AlgoExecutionCas<T> {
    Updated,
    Accepted(T),
}

fn load_persisted_accepted_algo_response<T, V>(
    conn: &Connection,
    execution_key: &str,
    operation: &str,
    validate_existing: &V,
) -> Result<Option<T>, String>
where
    T: serde::de::DeserializeOwned,
    V: Fn(&T) -> Result<(), String>,
{
    let row = conn
        .query_row(
            "SELECT operation,status,response_json
             FROM trade_execution_attempts WHERE execution_key=?1",
            params![execution_key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let Some((stored_operation, status, response_json)) = row else {
        return Ok(None);
    };
    if stored_operation != operation || status != "accepted" {
        return Ok(None);
    }
    let response_json = response_json
        .ok_or_else(|| format!("{ALGO_EXECUTION_LEASE_LOST}: accepted 策略执行记录缺少响应快照"))?;
    let response = serde_json::from_str::<T>(&response_json).map_err(|err| {
        format!("{ALGO_EXECUTION_LEASE_LOST}: accepted 策略执行响应无法解析：{err}")
    })?;
    validate_existing(&response).map_err(|err| {
        format!("{ALGO_EXECUTION_LEASE_LOST}: accepted 策略执行响应身份校验失败：{err}")
    })?;
    Ok(Some(response))
}

fn claim_algo_execution_lease_with_conn(
    conn: &Connection,
    execution_key: &str,
    operation: &str,
    owner_token: &str,
    now: i64,
) -> Result<bool, String> {
    conn.execute(
        "UPDATE trade_execution_attempts
         SET status='reconciling',owner_token=?3,lease_expires_at=?5,error=NULL,updated_at=?4
         WHERE execution_key=?1 AND operation=?2
           AND status IN ('submitting','reconciling','unknown')
           AND lease_expires_at<=?4",
        params![
            execution_key,
            operation,
            owner_token,
            now,
            now.saturating_add(ALGO_EXECUTION_LEASE_MS),
        ],
    )
    .map(|changed| changed == 1)
    .map_err(|err| err.to_string())
}

fn renew_algo_execution_lease_with_conn(
    conn: &Connection,
    lease: &AlgoExecutionLease,
    now: i64,
) -> Result<bool, String> {
    conn.execute(
        "UPDATE trade_execution_attempts
         SET status='reconciling',lease_expires_at=?5,error=NULL,updated_at=?4
         WHERE execution_key=?1 AND operation=?2 AND owner_token=?3
           AND status IN ('submitting','reconciling','unknown')
           AND lease_expires_at>?4",
        params![
            lease.execution_key,
            lease.operation,
            lease.owner_token,
            now,
            now.saturating_add(ALGO_EXECUTION_LEASE_MS),
        ],
    )
    .map(|changed| changed == 1)
    .map_err(|err| err.to_string())
}

fn cas_finish_algo_execution_with_conn(
    conn: &Connection,
    lease: &AlgoExecutionLease,
    status: &str,
    order_id: Option<&str>,
    response_json: Option<&str>,
    error: Option<&str>,
    now: i64,
) -> Result<bool, String> {
    if !matches!(
        status,
        "accepted" | "rejected" | "confirmed_missing" | "blocked" | "unknown"
    ) {
        return Err(format!("不支持的策略执行状态：{status}"));
    }
    let remains_owned = status == "unknown";
    conn.execute(
        "UPDATE trade_execution_attempts
         SET status=?4,order_id=COALESCE(?5,order_id),
             response_json=COALESCE(?6,response_json),error=?7,updated_at=?8,
             owner_token=CASE WHEN ?9 THEN owner_token ELSE '' END,
             lease_expires_at=CASE WHEN ?9 THEN ?10 ELSE 0 END,
             projection_status=CASE
               WHEN ?4='accepted' THEN 'pending'
               WHEN ?4='unknown' THEN projection_status
               ELSE 'not_required'
             END
         WHERE execution_key=?1 AND operation=?2 AND owner_token=?3
           AND status IN ('submitting','reconciling','unknown')
           AND lease_expires_at>?8",
        params![
            lease.execution_key,
            lease.operation,
            lease.owner_token,
            status,
            order_id,
            response_json,
            error,
            now,
            remains_owned,
            now.saturating_add(ALGO_EXECUTION_LEASE_MS),
        ],
    )
    .map(|changed| changed == 1)
    .map_err(|err| err.to_string())
}

fn renew_algo_execution_lease<T, V>(
    app: &tauri::AppHandle,
    lease: &AlgoExecutionLease,
    validate_existing: V,
) -> Result<AlgoExecutionCas<T>, String>
where
    T: serde::de::DeserializeOwned,
    V: Fn(&T) -> Result<(), String>,
{
    let conn = open_database(app)?;
    if renew_algo_execution_lease_with_conn(&conn, lease, now_ms())? {
        return Ok(AlgoExecutionCas::Updated);
    }
    if let Some(response) = load_persisted_accepted_algo_response(
        &conn,
        &lease.execution_key,
        &lease.operation,
        &validate_existing,
    )? {
        return Ok(AlgoExecutionCas::Accepted(response));
    }
    Err(format!(
        "{ALGO_EXECUTION_LEASE_LOST}: 策略执行租约已过期或被其他执行者接管"
    ))
}

fn finish_algo_execution<W, T, V>(
    app: &tauri::AppHandle,
    lease: &AlgoExecutionLease,
    status: &str,
    order_id: Option<&str>,
    response: Option<&W>,
    error: Option<&str>,
    validate_existing: V,
) -> Result<AlgoExecutionCas<T>, String>
where
    W: Serialize,
    T: serde::de::DeserializeOwned,
    V: Fn(&T) -> Result<(), String>,
{
    let conn = open_database(app)?;
    let response_json = response
        .map(serde_json::to_string)
        .transpose()
        .map_err(|err| err.to_string())?;
    if cas_finish_algo_execution_with_conn(
        &conn,
        lease,
        status,
        order_id,
        response_json.as_deref(),
        error,
        now_ms(),
    )? {
        return Ok(AlgoExecutionCas::Updated);
    }
    if let Some(response) = load_persisted_accepted_algo_response(
        &conn,
        &lease.execution_key,
        &lease.operation,
        &validate_existing,
    )? {
        return Ok(AlgoExecutionCas::Accepted(response));
    }
    Err(format!(
        "{ALGO_EXECUTION_LEASE_LOST}: 策略执行状态写入被拒绝"
    ))
}

fn validate_amend_algo_result_identity(
    request: &AmendAlgoOrderRequest,
    result: &OkxAlgoOrderResult,
) -> Result<(), String> {
    if result.s_code != "0" {
        return Err("OKX 修改策略单 accepted 响应的 sCode 不是 0".to_string());
    }
    if result.algo_id.trim().is_empty() {
        return Err("OKX 修改策略单成功响应缺少 algoId".to_string());
    }
    if let Some(expected) = optional_non_empty(&request.algo_id) {
        if result.algo_id.trim() != expected {
            return Err("OKX 修改策略单成功响应的 algoId 与目标不一致".to_string());
        }
    }
    if let Some(expected) = optional_non_empty(&request.algo_cl_ord_id) {
        if result.algo_cl_ord_id.trim() != expected {
            return Err("OKX 修改策略单成功响应的 algoClOrdId 与目标不一致".to_string());
        }
    }
    Ok(())
}

fn validate_persisted_place_algo_response(
    response: &PlaceOrderResponse,
    expected_client_order_id: &str,
    execution_key: &str,
) -> Result<(), String> {
    if response.s_code != "0" {
        return Err("策略委托 accepted 响应的 sCode 不是 0".to_string());
    }
    validate_place_order_response_identity(response, expected_client_order_id, true)?;
    if response.execution_key.as_deref() != Some(execution_key) {
        return Err("策略委托幂等响应的 executionKey 不匹配".to_string());
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct AlgoProjectionRecord {
    account_id: String,
    environment: String,
    projection_status: String,
}

fn load_algo_projection_record(
    app: &tauri::AppHandle,
    execution_key: &str,
    operation: &str,
) -> Result<AlgoProjectionRecord, String> {
    let conn = open_database(app)?;
    conn.query_row(
        "SELECT account_id,environment,status,projection_status
         FROM trade_execution_attempts WHERE execution_key=?1 AND operation=?2",
        params![execution_key, operation],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        },
    )
    .map_err(|err| err.to_string())
    .and_then(|(account_id, environment, status, projection_status)| {
        if status != "accepted" {
            return Err(format!(
                "策略执行尚未 accepted，不能完成本地投影：status={status}"
            ));
        }
        if !matches!(projection_status.as_str(), "pending" | "complete") {
            return Err(format!("策略执行投影状态无效：{projection_status}"));
        }
        Ok(AlgoProjectionRecord {
            account_id,
            environment,
            projection_status,
        })
    })
}

fn projection_account(record: &AlgoProjectionRecord) -> LocalAccount {
    LocalAccount {
        id: record.account_id.clone(),
        name: "Projection recovery".to_string(),
        exchange: "okx".to_string(),
        environment: record.environment.clone(),
        okx_uid: String::new(),
        okx_main_uid: String::new(),
        api_key: String::new(),
        secret_key: String::new(),
        passphrase: String::new(),
        permissions: Permissions {
            read: false,
            trade: false,
            withdraw: false,
        },
    }
}

fn algo_projection_audit_id(execution_key: &str, operation: &str) -> String {
    let identity = format!("projection:{operation}:{execution_key}");
    format!("audit-algo-{}", stable_client_order_id(&identity))
}

fn complete_algo_projection_with_conn(
    conn: &Connection,
    execution_key: &str,
    operation: &str,
    now: i64,
) -> Result<bool, String> {
    conn.execute(
        "UPDATE trade_execution_attempts
         SET projection_status='complete',error=NULL,updated_at=?3
         WHERE execution_key=?1 AND operation=?2
           AND status='accepted' AND projection_status='pending'",
        params![execution_key, operation, now],
    )
    .map(|changed| changed == 1)
    .map_err(|err| err.to_string())
}

fn complete_algo_projection(
    app: &tauri::AppHandle,
    execution_key: &str,
    operation: &str,
) -> Result<(), String> {
    let conn = open_database(app)?;
    if complete_algo_projection_with_conn(&conn, execution_key, operation, now_ms())? {
        return Ok(());
    }
    let status = conn
        .query_row(
            "SELECT projection_status FROM trade_execution_attempts
             WHERE execution_key=?1 AND operation=?2 AND status='accepted'",
            params![execution_key, operation],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    if status.as_deref() == Some("complete") {
        Ok(())
    } else {
        Err("accepted 策略执行的投影完成状态写入失败".to_string())
    }
}

fn project_place_algo_accepted(
    app: &tauri::AppHandle,
    request: &PlaceAlgoOrderRequest,
    response: &PlaceOrderResponse,
) -> Result<(), String> {
    let execution_key = optional_non_empty(&request.execution_key)
        .ok_or_else(|| "策略委托投影缺少 executionKey".to_string())?;
    let client_order_id = stable_client_order_id(&execution_key);
    validate_persisted_place_algo_response(response, &client_order_id, &execution_key)?;
    let record = load_algo_projection_record(app, &execution_key, "place_algo_order")?;
    if record.projection_status == "complete" {
        return Ok(());
    }
    let account = projection_account(&record);
    let body = place_algo_body(request, &client_order_id);
    let result = OkxAlgoOrderResult {
        algo_id: response.ord_id.clone(),
        algo_cl_ord_id: response.cl_ord_id.clone(),
        s_code: response.s_code.clone(),
        s_msg: response.s_msg.clone(),
        ts: response.ts.clone(),
    };
    upsert_submitted_tpsl_algo_order(app, &account, request, &body, &result, &response.operator)?;
    audit_trade_event_once(
        app,
        &algo_projection_audit_id(&execution_key, "place_algo_order"),
        &account,
        &request.inst_id,
        "order_submit",
        "place_tpsl_algo",
        "accepted",
        Some(&request.ord_type),
        Some(&response.ord_id),
        Some(&response.cl_ord_id),
        Some(&request.side),
        Some(&request.pos_side),
        Some(&request.td_mode),
        Some(&request.size),
        body.tp_trigger_px
            .as_deref()
            .or(body.sl_trigger_px.as_deref()),
        &response.operator,
        optional_non_empty(&request.strategy_id),
        optional_non_empty(&request.session_id),
        request.confirmed_live == Some(true),
        Some(&response.s_code),
        Some(&response.s_msg),
        None,
        json!({ "request": request, "okxBody": &body }),
        Some(json!(&result)),
    )?;
    complete_algo_projection(app, &execution_key, "place_algo_order")
}

fn project_amend_algo_accepted(
    app: &tauri::AppHandle,
    request: &AmendAlgoOrderRequest,
    result: &OkxAlgoOrderResult,
) -> Result<(), String> {
    let execution_key = optional_non_empty(&request.execution_key)
        .ok_or_else(|| "策略改单投影缺少 executionKey".to_string())?;
    validate_amend_algo_result_identity(request, result)?;
    let record = load_algo_projection_record(app, &execution_key, "amend_algo_order")?;
    if record.projection_status == "complete" {
        return Ok(());
    }
    let account = projection_account(&record);
    let body = amend_algo_body(request);
    audit_trade_event_once(
        app,
        &algo_projection_audit_id(&execution_key, "amend_algo_order"),
        &account,
        &request.inst_id,
        "order_amend",
        "amend_algo_order",
        "accepted",
        Some("conditional"),
        Some(&result.algo_id),
        Some(&result.algo_cl_ord_id),
        None,
        None,
        None,
        request.new_size.as_deref(),
        request
            .new_trigger_px
            .as_deref()
            .or(request.new_ord_px.as_deref())
            .or(request
                .new_tp_trigger_px
                .as_deref()
                .or(request.new_sl_trigger_px.as_deref())),
        "user",
        None,
        None,
        request.confirmed_live == Some(true),
        Some(&result.s_code),
        Some(&result.s_msg),
        None,
        json!({ "request": request, "okxBody": &body }),
        Some(json!(result)),
    )?;
    complete_algo_projection(app, &execution_key, "amend_algo_order")
}

fn projected_place_algo_response(
    app: &tauri::AppHandle,
    request: &PlaceAlgoOrderRequest,
    response: PlaceOrderResponse,
) -> Result<PlaceOrderResponse, String> {
    if let Err(err) = project_place_algo_accepted(app, request, &response) {
        let message = format!(
            "{ALGO_EXECUTION_PROJECTION_PENDING}: OKX 已 accepted，但本地订单投影或审计尚未完成，启动恢复将重试：{err}"
        );
        if let Some(execution_key) = optional_non_empty(&request.execution_key) {
            let _ = mark_algo_projection_failure(
                app,
                &execution_key,
                "place_algo_order",
                false,
                &message,
            );
        }
        eprintln!("{message}");
    }
    Ok(response)
}

fn projected_amend_algo_result(
    app: &tauri::AppHandle,
    request: &AmendAlgoOrderRequest,
    result: OkxAlgoOrderResult,
) -> Result<OkxAlgoOrderResult, String> {
    if let Err(err) = project_amend_algo_accepted(app, request, &result) {
        let message = format!(
            "{ALGO_EXECUTION_PROJECTION_PENDING}: OKX 策略改单已 accepted，但本地审计尚未完成，启动恢复将重试：{err}"
        );
        if let Some(execution_key) = optional_non_empty(&request.execution_key) {
            let _ = mark_algo_projection_failure(
                app,
                &execution_key,
                "amend_algo_order",
                false,
                &message,
            );
        }
        eprintln!("{message}");
    }
    Ok(result)
}

fn required_algo_number_matches(expected: &str, actual: &str) -> bool {
    normalize_fingerprint_number(expected) == normalize_fingerprint_number(actual)
}

fn exact_optional_algo_number_matches(expected: &Option<String>, actual: &str) -> bool {
    match optional_non_empty(expected) {
        Some(expected) => required_algo_number_matches(&expected, actual),
        None => actual.trim().is_empty(),
    }
}

fn requested_algo_number_matches(expected: &Option<String>, actual: &str) -> bool {
    optional_non_empty(expected)
        .map(|expected| required_algo_number_matches(&expected, actual))
        .unwrap_or(true)
}

fn place_algo_matches_order(
    request: &PlaceAlgoOrderRequest,
    order: &OkxPendingOrder,
    expected_client_order_id: &str,
) -> bool {
    order.inst_id.eq_ignore_ascii_case(request.inst_id.trim())
        && !order.algo_id.trim().is_empty()
        && order.algo_cl_ord_id.trim() == expected_client_order_id
        && order.side.eq_ignore_ascii_case(request.side.trim())
        && order.pos_side.eq_ignore_ascii_case(request.pos_side.trim())
        && order.td_mode.eq_ignore_ascii_case(request.td_mode.trim())
        && order.ord_type.eq_ignore_ascii_case(request.ord_type.trim())
        && required_algo_number_matches(&request.size, &order.sz)
        && exact_optional_algo_number_matches(&request.tp_trigger_px, &order.tp_trigger_px)
        && exact_optional_algo_number_matches(&request.tp_ord_px, &order.tp_ord_px)
        && exact_optional_algo_number_matches(&request.sl_trigger_px, &order.sl_trigger_px)
        && exact_optional_algo_number_matches(&request.sl_ord_px, &order.sl_ord_px)
        && optional_non_empty(&request.tp_trigger_px)
            .is_none_or(|_| order.tp_trigger_px_type.eq_ignore_ascii_case("last"))
        && optional_non_empty(&request.sl_trigger_px)
            .is_none_or(|_| order.sl_trigger_px_type.eq_ignore_ascii_case("last"))
        && (!request.pos_side.eq_ignore_ascii_case("net")
            || matches!(
                order.reduce_only.trim().to_ascii_lowercase().as_str(),
                "true" | "1"
            ))
}

fn amend_algo_matches_order(request: &AmendAlgoOrderRequest, order: &OkxPendingOrder) -> bool {
    order.inst_id.eq_ignore_ascii_case(request.inst_id.trim())
        && optional_non_empty(&request.algo_id)
            .is_none_or(|expected| order.algo_id.trim() == expected)
        && optional_non_empty(&request.algo_cl_ord_id)
            .is_none_or(|expected| order.algo_cl_ord_id.trim() == expected)
        && requested_algo_number_matches(&request.new_size, &order.sz)
        && requested_algo_number_matches(&request.new_trigger_px, &order.trigger_px)
        && requested_algo_number_matches(&request.new_ord_px, &order.ord_px)
        && requested_algo_number_matches(&request.new_tp_trigger_px, &order.tp_trigger_px)
        && requested_algo_number_matches(&request.new_tp_ord_px, &order.tp_ord_px)
        && requested_algo_number_matches(&request.new_sl_trigger_px, &order.sl_trigger_px)
        && requested_algo_number_matches(&request.new_sl_ord_px, &order.sl_ord_px)
        && optional_non_empty(&request.new_tp_trigger_px)
            .is_none_or(|_| order.tp_trigger_px_type.eq_ignore_ascii_case("last"))
        && optional_non_empty(&request.new_sl_trigger_px)
            .is_none_or(|_| order.sl_trigger_px_type.eq_ignore_ascii_case("last"))
}

enum AlgoOrderReconcile<T> {
    Order(Option<OkxPendingOrder>),
    Accepted(T),
}

async fn reconcile_place_algo_with_retry(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    request: &PlaceAlgoOrderRequest,
    client_order_id: &str,
    lease: &AlgoExecutionLease,
) -> Result<AlgoOrderReconcile<PlaceOrderResponse>, String> {
    let mut mismatch_seen = false;
    for delay_ms in [0_u64, 250, 750] {
        if delay_ms > 0 {
            sleep(Duration::from_millis(delay_ms)).await;
        }
        match renew_algo_execution_lease(app, lease, |response| {
            validate_persisted_place_algo_response(response, client_order_id, &lease.execution_key)
        })? {
            AlgoExecutionCas::Updated => {}
            AlgoExecutionCas::Accepted(response) => {
                return Ok(AlgoOrderReconcile::Accepted(response));
            }
        }
        match reconcile_order(account, &request.inst_id, None, Some(client_order_id), true).await? {
            Some(order) if place_algo_matches_order(request, &order, client_order_id) => {
                return Ok(AlgoOrderReconcile::Order(Some(order)));
            }
            Some(_) => mismatch_seen = true,
            None => {}
        }
    }
    if mismatch_seen {
        Err("OKX_ORDER_LOOKUP_REQUEST_MISMATCH: 策略单身份存在但请求字段不匹配".to_string())
    } else {
        Ok(AlgoOrderReconcile::Order(None))
    }
}

async fn reconcile_amend_algo_with_retry(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    request: &AmendAlgoOrderRequest,
    lease: &AlgoExecutionLease,
) -> Result<AlgoOrderReconcile<OkxAlgoOrderResult>, String> {
    let mut mismatch_seen = false;
    for delay_ms in [0_u64, 250, 750] {
        if delay_ms > 0 {
            sleep(Duration::from_millis(delay_ms)).await;
        }
        match renew_algo_execution_lease(app, lease, |result| {
            validate_amend_algo_result_identity(request, result)
        })? {
            AlgoExecutionCas::Updated => {}
            AlgoExecutionCas::Accepted(result) => {
                return Ok(AlgoOrderReconcile::Accepted(result));
            }
        }
        match reconcile_order(
            account,
            &request.inst_id,
            request.algo_id.as_deref(),
            request.algo_cl_ord_id.as_deref(),
            true,
        )
        .await?
        {
            Some(order) if amend_algo_matches_order(request, &order) => {
                return Ok(AlgoOrderReconcile::Order(Some(order)));
            }
            Some(_) => mismatch_seen = true,
            None => {}
        }
    }
    if mismatch_seen {
        Err("OKX_ORDER_LOOKUP_REQUEST_MISMATCH: 策略改单目标存在但请求字段不匹配".to_string())
    } else {
        Ok(AlgoOrderReconcile::Order(None))
    }
}

fn reconciled_place_algo_response(
    request: &PlaceAlgoOrderRequest,
    order: &OkxPendingOrder,
    execution_key: &str,
    message: &str,
) -> PlaceOrderResponse {
    PlaceOrderResponse {
        ord_id: order.algo_id.clone(),
        cl_ord_id: order.algo_cl_ord_id.clone(),
        s_code: "0".to_string(),
        s_msg: message.to_string(),
        ts: reconciliation_timestamp(order),
        side: request.side.clone(),
        pos_side: request.pos_side.clone(),
        reduce_only: true,
        operator: normalize_trade_operator(request.operator.as_ref()),
        strategy_id: optional_non_empty(&request.strategy_id),
        session_id: optional_non_empty(&request.session_id),
        opportunity_id: None,
        agent_run_id: None,
        execution_key: Some(execution_key.to_string()),
    }
}

fn reconciled_amend_algo_result(order: &OkxPendingOrder, message: &str) -> OkxAlgoOrderResult {
    OkxAlgoOrderResult {
        algo_id: order.algo_id.clone(),
        algo_cl_ord_id: order.algo_cl_ord_id.clone(),
        s_code: "0".to_string(),
        s_msg: message.to_string(),
        ts: reconciliation_timestamp(order),
    }
}

async fn resolve_place_algo_execution(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    request: &PlaceAlgoOrderRequest,
    client_order_id: &str,
    lease: &AlgoExecutionLease,
    accepted_message: &str,
) -> Result<PlaceOrderResponse, String> {
    match reconcile_place_algo_with_retry(app, account, request, client_order_id, lease).await {
        Ok(AlgoOrderReconcile::Accepted(response)) => {
            projected_place_algo_response(app, request, response)
        }
        Ok(AlgoOrderReconcile::Order(Some(order))) => {
            let response = reconciled_place_algo_response(
                request,
                &order,
                &lease.execution_key,
                accepted_message,
            );
            match finish_algo_execution(
                app,
                lease,
                "accepted",
                Some(&response.ord_id),
                Some(&response),
                None,
                |persisted| {
                    validate_persisted_place_algo_response(
                        persisted,
                        client_order_id,
                        &lease.execution_key,
                    )
                },
            )? {
                AlgoExecutionCas::Updated => projected_place_algo_response(app, request, response),
                AlgoExecutionCas::Accepted(persisted) => {
                    projected_place_algo_response(app, request, persisted)
                }
            }
        }
        Ok(AlgoOrderReconcile::Order(None)) => {
            let error =
                "通过 OKX order-algo 严格对账确认未找到该策略单；旧 executionKey 不会自动重放";
            match finish_algo_execution::<PlaceOrderResponse, PlaceOrderResponse, _>(
                app,
                lease,
                "confirmed_missing",
                None,
                None,
                Some(error),
                |persisted| {
                    validate_persisted_place_algo_response(
                        persisted,
                        client_order_id,
                        &lease.execution_key,
                    )
                },
            )? {
                AlgoExecutionCas::Updated => Err(error.to_string()),
                AlgoExecutionCas::Accepted(persisted) => {
                    projected_place_algo_response(app, request, persisted)
                }
            }
        }
        Err(err) if err.contains(ALGO_EXECUTION_LEASE_LOST) => Err(err),
        Err(err) => {
            match finish_algo_execution::<PlaceOrderResponse, PlaceOrderResponse, _>(
                app,
                lease,
                "unknown",
                None,
                None,
                Some(&format!("策略单对账结果仍不明确：{err}")),
                |persisted| {
                    validate_persisted_place_algo_response(
                        persisted,
                        client_order_id,
                        &lease.execution_key,
                    )
                },
            )? {
                AlgoExecutionCas::Updated => {
                    Err(format!("策略单提交结果不明确，已保留待对账状态：{err}"))
                }
                AlgoExecutionCas::Accepted(persisted) => {
                    projected_place_algo_response(app, request, persisted)
                }
            }
        }
    }
}

async fn resolve_amend_algo_execution(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    request: &AmendAlgoOrderRequest,
    lease: &AlgoExecutionLease,
    accepted_message: &str,
) -> Result<OkxAlgoOrderResult, String> {
    match reconcile_amend_algo_with_retry(app, account, request, lease).await {
        Ok(AlgoOrderReconcile::Accepted(result)) => {
            projected_amend_algo_result(app, request, result)
        }
        Ok(AlgoOrderReconcile::Order(Some(order))) => {
            let result = reconciled_amend_algo_result(&order, accepted_message);
            match finish_algo_execution(
                app,
                lease,
                "accepted",
                Some(&result.algo_id),
                Some(&result),
                None,
                |persisted| validate_amend_algo_result_identity(request, persisted),
            )? {
                AlgoExecutionCas::Updated => projected_amend_algo_result(app, request, result),
                AlgoExecutionCas::Accepted(persisted) => {
                    projected_amend_algo_result(app, request, persisted)
                }
            }
        }
        Ok(AlgoOrderReconcile::Order(None)) => {
            let error = "通过 OKX order-algo 严格对账确认目标策略单已不存在；旧改单不会自动重放";
            match finish_algo_execution::<OkxAlgoOrderResult, OkxAlgoOrderResult, _>(
                app,
                lease,
                "rejected",
                None,
                None,
                Some(error),
                |persisted| validate_amend_algo_result_identity(request, persisted),
            )? {
                AlgoExecutionCas::Updated => Err(error.to_string()),
                AlgoExecutionCas::Accepted(persisted) => {
                    projected_amend_algo_result(app, request, persisted)
                }
            }
        }
        Err(err) if err.contains(ALGO_EXECUTION_LEASE_LOST) => Err(err),
        Err(err) => {
            match finish_algo_execution::<OkxAlgoOrderResult, OkxAlgoOrderResult, _>(
                app,
                lease,
                "unknown",
                None,
                None,
                Some(&format!("策略改单对账结果仍不明确：{err}")),
                |persisted| validate_amend_algo_result_identity(request, persisted),
            )? {
                AlgoExecutionCas::Updated => {
                    Err(format!("策略改单结果不明确，已保留待对账状态：{err}"))
                }
                AlgoExecutionCas::Accepted(persisted) => {
                    projected_amend_algo_result(app, request, persisted)
                }
            }
        }
    }
}

#[tauri::command]
pub async fn okx_place_algo_order(
    app: tauri::AppHandle,
    request: PlaceAlgoOrderRequest,
) -> Result<PlaceOrderResponse, String> {
    let projection_request = request.clone();
    let response = okx_place_algo_order_inner(app.clone(), request).await?;
    projected_place_algo_response(&app, &projection_request, response)
}

async fn okx_place_algo_order_inner(
    app: tauri::AppHandle,
    request: PlaceAlgoOrderRequest,
) -> Result<PlaceOrderResponse, String> {
    let execution_key = optional_non_empty(&request.execution_key)
        .ok_or_else(|| "策略委托缺少稳定 executionKey，无法提供幂等与崩溃恢复保护".to_string())?;
    if normalize_environment(&request.environment) == "live" && request.confirmed_live != Some(true)
    {
        return Err("实盘策略委托缺少二次确认标记".to_string());
    }
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    let account_config = ensure_trade_account(&account, &request.environment).await?;
    let instrument = fetch_instrument(&app, &request.inst_id).await?;
    validate_algo_request(&request, &instrument, &account_config.pos_mode)?;

    let operator = normalize_trade_operator(request.operator.as_ref());
    if account_config.pos_mode == "net_mode" && operator != "user" {
        return Err("自动化策略委托要求 OKX 账号使用双向持仓模式；请先在 OKX 中切换为 long_short_mode / Automated strategy orders require OKX long/short position mode; switch the account to long_short_mode first".to_string());
    }
    let algo_cl_ord_id = stable_client_order_id(&execution_key);
    let body = place_algo_body(&request, &algo_cl_ord_id);
    let request_json = serde_json::to_string(&request).map_err(|err| err.to_string())?;
    let request_signature = place_algo_request_signature(&request);
    let reservation = reserve_algo_execution::<PlaceOrderResponse, _, _>(
        &app,
        &account,
        &execution_key,
        "place_algo_order",
        &algo_cl_ord_id,
        &request_json,
        &request_signature,
        |stored| {
            serde_json::from_str::<PlaceAlgoOrderRequest>(stored)
                .map(|request| place_algo_request_signature(&request))
                .map_err(|err| format!("策略委托幂等记录无法解析：{err}"))
        },
        |response| {
            validate_persisted_place_algo_response(response, &algo_cl_ord_id, &execution_key)
        },
    )?;
    let lease = match reservation {
        AlgoExecutionReservation::New(lease) => lease,
        AlgoExecutionReservation::Existing(response) => return Ok(response),
        AlgoExecutionReservation::Reconcile(lease) => {
            return resolve_place_algo_execution(
                &app,
                &account,
                &request,
                &algo_cl_ord_id,
                &lease,
                "已通过 OKX order-algo 对账确认策略委托存在，未重复提交",
            )
            .await;
        }
    };

    let envelope = match okx_private_post::<OkxAlgoOrderResult, _>(
        &account,
        "/api/v5/trade/order-algo",
        &body,
    )
    .await
    {
        Ok(envelope) => envelope,
        Err(err) => {
            match finish_algo_execution::<PlaceOrderResponse, PlaceOrderResponse, _>(
                &app,
                &lease,
                "unknown",
                None,
                None,
                Some(&format!("策略委托 transport 结果不明确：{err}")),
                |persisted| {
                    validate_persisted_place_algo_response(
                        persisted,
                        &algo_cl_ord_id,
                        &execution_key,
                    )
                },
            )? {
                AlgoExecutionCas::Updated => {
                    return resolve_place_algo_execution(
                        &app,
                        &account,
                        &request,
                        &algo_cl_ord_id,
                        &lease,
                        "策略委托 transport 异常后通过 OKX 对账确认已受理",
                    )
                    .await;
                }
                AlgoExecutionCas::Accepted(persisted) => return Ok(persisted),
            }
        }
    };
    let Some(result) = envelope.data.into_iter().next() else {
        match finish_algo_execution::<PlaceOrderResponse, PlaceOrderResponse, _>(
            &app,
            &lease,
            "unknown",
            None,
            None,
            Some("OKX 策略委托返回为空，提交结果不明确"),
            |persisted| {
                validate_persisted_place_algo_response(persisted, &algo_cl_ord_id, &execution_key)
            },
        )? {
            AlgoExecutionCas::Updated => {
                return resolve_place_algo_execution(
                    &app,
                    &account,
                    &request,
                    &algo_cl_ord_id,
                    &lease,
                    "策略委托空响应后通过 OKX 对账确认已受理",
                )
                .await;
            }
            AlgoExecutionCas::Accepted(persisted) => return Ok(persisted),
        }
    };
    if result.s_code != "0" {
        if is_duplicate_client_order_error(&result.s_code, &result.s_msg) {
            let error = format!(
                "OKX 返回重复 algoClOrdId，策略委托结果需要按稳定 ID 对账：{}",
                result.s_msg
            );
            match finish_algo_execution::<PlaceOrderResponse, PlaceOrderResponse, _>(
                &app,
                &lease,
                "unknown",
                (!result.algo_id.trim().is_empty()).then_some(result.algo_id.as_str()),
                None,
                Some(&error),
                |persisted| {
                    validate_persisted_place_algo_response(
                        persisted,
                        &algo_cl_ord_id,
                        &execution_key,
                    )
                },
            )? {
                AlgoExecutionCas::Updated => {
                    return resolve_place_algo_execution(
                        &app,
                        &account,
                        &request,
                        &algo_cl_ord_id,
                        &lease,
                        "策略委托重复 algoClOrdId 响应后通过 OKX 对账确认已受理",
                    )
                    .await;
                }
                AlgoExecutionCas::Accepted(persisted) => return Ok(persisted),
            }
        }
        match finish_algo_execution(
            &app,
            &lease,
            "rejected",
            (!result.algo_id.trim().is_empty()).then_some(result.algo_id.as_str()),
            Some(&result),
            Some(&result.s_msg),
            |persisted| {
                validate_persisted_place_algo_response(persisted, &algo_cl_ord_id, &execution_key)
            },
        )? {
            AlgoExecutionCas::Updated => {
                audit_trade_event(
                    &app,
                    &account,
                    &request.inst_id,
                    "order_submit",
                    "place_tpsl_algo",
                    "rejected",
                    Some(&request.ord_type),
                    Some(&result.algo_id),
                    Some(&result.algo_cl_ord_id),
                    Some(&request.side),
                    Some(&request.pos_side),
                    Some(&request.td_mode),
                    Some(&request.size),
                    body.tp_trigger_px
                        .as_deref()
                        .or(body.sl_trigger_px.as_deref()),
                    &operator,
                    optional_non_empty(&request.strategy_id),
                    optional_non_empty(&request.session_id),
                    request.confirmed_live == Some(true),
                    Some(&result.s_code),
                    Some(&result.s_msg),
                    Some(&result.s_msg),
                    json!({ "request": &request, "okxBody": &body }),
                    Some(json!(&result)),
                );
                return Err(classified_okx_error(
                    "okx_place_algo_order",
                    "策略委托",
                    &result.s_code,
                    &result.s_msg,
                ));
            }
            AlgoExecutionCas::Accepted(persisted) => return Ok(persisted),
        }
    }
    if let Err(err) = validate_algo_order_result_identity(&result, &algo_cl_ord_id) {
        match finish_algo_execution(
            &app,
            &lease,
            "unknown",
            (!result.algo_id.trim().is_empty()).then_some(result.algo_id.as_str()),
            Some(&result),
            Some(&err),
            |persisted| {
                validate_persisted_place_algo_response(persisted, &algo_cl_ord_id, &execution_key)
            },
        )? {
            AlgoExecutionCas::Updated => {
                return resolve_place_algo_execution(
                    &app,
                    &account,
                    &request,
                    &algo_cl_ord_id,
                    &lease,
                    "策略委托身份错配响应后通过 OKX 对账确认已受理",
                )
                .await;
            }
            AlgoExecutionCas::Accepted(persisted) => return Ok(persisted),
        }
    }
    let response = PlaceOrderResponse {
        ord_id: result.algo_id.clone(),
        cl_ord_id: result.algo_cl_ord_id.clone(),
        s_code: result.s_code.clone(),
        s_msg: result.s_msg.clone(),
        ts: result.ts.clone(),
        side: request.side.clone(),
        pos_side: request.pos_side.clone(),
        reduce_only: true,
        operator: operator.clone(),
        strategy_id: optional_non_empty(&request.strategy_id),
        session_id: optional_non_empty(&request.session_id),
        opportunity_id: None,
        agent_run_id: None,
        execution_key: Some(execution_key.clone()),
    };
    match finish_algo_execution(
        &app,
        &lease,
        "accepted",
        Some(&response.ord_id),
        Some(&response),
        None,
        |persisted| {
            validate_persisted_place_algo_response(persisted, &algo_cl_ord_id, &execution_key)
        },
    )? {
        AlgoExecutionCas::Updated => {}
        AlgoExecutionCas::Accepted(persisted) => return Ok(persisted),
    }
    Ok(response)
}

#[tauri::command]
pub async fn okx_amend_algo_order(
    app: tauri::AppHandle,
    request: AmendAlgoOrderRequest,
) -> Result<OkxAlgoOrderResult, String> {
    let projection_request = request.clone();
    let result = okx_amend_algo_order_inner(app.clone(), request).await?;
    projected_amend_algo_result(&app, &projection_request, result)
}

async fn okx_amend_algo_order_inner(
    app: tauri::AppHandle,
    request: AmendAlgoOrderRequest,
) -> Result<OkxAlgoOrderResult, String> {
    let execution_key = optional_non_empty(&request.execution_key)
        .ok_or_else(|| "修改策略单缺少稳定 executionKey，无法提供幂等与崩溃恢复保护".to_string())?;
    if normalize_environment(&request.environment) == "live" && request.confirmed_live != Some(true)
    {
        return Err("实盘修改策略单缺少二次确认标记".to_string());
    }
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    ensure_account_snapshot_current(&app, &account)?;
    ensure_trade_account(&account, &request.environment).await?;
    if optional_non_empty(&request.algo_id).is_none()
        && optional_non_empty(&request.algo_cl_ord_id).is_none()
    {
        return Err("修改策略单需要 algoId 或 algoClOrdId".to_string());
    }
    if [
        &request.new_size,
        &request.new_trigger_px,
        &request.new_ord_px,
        &request.new_tp_trigger_px,
        &request.new_tp_ord_px,
        &request.new_sl_trigger_px,
        &request.new_sl_ord_px,
    ]
    .iter()
    .all(|value| optional_non_empty(value).is_none())
    {
        return Err("修改策略单至少需要一个新参数".to_string());
    }
    let body = amend_algo_body(&request);
    let reservation_client_id = stable_client_order_id(&execution_key);
    let request_json = serde_json::to_string(&request).map_err(|err| err.to_string())?;
    let request_signature = amend_algo_request_signature(&request);
    let reservation = reserve_algo_execution::<OkxAlgoOrderResult, _, _>(
        &app,
        &account,
        &execution_key,
        "amend_algo_order",
        &reservation_client_id,
        &request_json,
        &request_signature,
        |stored| {
            serde_json::from_str::<AmendAlgoOrderRequest>(stored)
                .map(|request| amend_algo_request_signature(&request))
                .map_err(|err| format!("策略改单幂等记录无法解析：{err}"))
        },
        |result| validate_amend_algo_result_identity(&request, result),
    )?;
    let lease = match reservation {
        AlgoExecutionReservation::New(lease) => lease,
        AlgoExecutionReservation::Existing(result) => return Ok(result),
        AlgoExecutionReservation::Reconcile(lease) => {
            return resolve_amend_algo_execution(
                &app,
                &account,
                &request,
                &lease,
                "已通过 OKX order-algo 对账确认策略改单生效，未重复提交",
            )
            .await;
        }
    };
    let envelope = match okx_private_post::<OkxAlgoOrderResult, _>(
        &account,
        "/api/v5/trade/amend-algos",
        &body,
    )
    .await
    {
        Ok(envelope) => envelope,
        Err(err) => {
            match finish_algo_execution::<OkxAlgoOrderResult, OkxAlgoOrderResult, _>(
                &app,
                &lease,
                "unknown",
                None,
                None,
                Some(&format!("策略改单 transport 结果不明确：{err}")),
                |persisted| validate_amend_algo_result_identity(&request, persisted),
            )? {
                AlgoExecutionCas::Updated => {
                    return resolve_amend_algo_execution(
                        &app,
                        &account,
                        &request,
                        &lease,
                        "策略改单 transport 异常后通过 OKX 对账确认已生效",
                    )
                    .await;
                }
                AlgoExecutionCas::Accepted(persisted) => return Ok(persisted),
            }
        }
    };
    let Some(result) = envelope.data.into_iter().next() else {
        match finish_algo_execution::<OkxAlgoOrderResult, OkxAlgoOrderResult, _>(
            &app,
            &lease,
            "unknown",
            None,
            None,
            Some("OKX 修改策略单返回为空，改单结果不明确"),
            |persisted| validate_amend_algo_result_identity(&request, persisted),
        )? {
            AlgoExecutionCas::Updated => {
                return resolve_amend_algo_execution(
                    &app,
                    &account,
                    &request,
                    &lease,
                    "策略改单空响应后通过 OKX 对账确认已生效",
                )
                .await;
            }
            AlgoExecutionCas::Accepted(persisted) => return Ok(persisted),
        }
    };
    if result.s_code != "0" {
        match finish_algo_execution(
            &app,
            &lease,
            "rejected",
            (!result.algo_id.trim().is_empty()).then_some(result.algo_id.as_str()),
            Some(&result),
            Some(&result.s_msg),
            |persisted| validate_amend_algo_result_identity(&request, persisted),
        )? {
            AlgoExecutionCas::Updated => {
                return Err(classified_okx_error(
                    "okx_amend_algo_order",
                    "修改策略单",
                    &result.s_code,
                    &result.s_msg,
                ));
            }
            AlgoExecutionCas::Accepted(persisted) => return Ok(persisted),
        }
    }
    if let Err(err) = validate_amend_algo_result_identity(&request, &result) {
        match finish_algo_execution(
            &app,
            &lease,
            "unknown",
            (!result.algo_id.trim().is_empty()).then_some(result.algo_id.as_str()),
            Some(&result),
            Some(&err),
            |persisted| validate_amend_algo_result_identity(&request, persisted),
        )? {
            AlgoExecutionCas::Updated => {
                return resolve_amend_algo_execution(
                    &app,
                    &account,
                    &request,
                    &lease,
                    "策略改单身份错配响应后通过 OKX 对账确认已生效",
                )
                .await;
            }
            AlgoExecutionCas::Accepted(persisted) => return Ok(persisted),
        }
    }
    match finish_algo_execution(
        &app,
        &lease,
        "accepted",
        Some(&result.algo_id),
        Some(&result),
        None,
        |persisted| validate_amend_algo_result_identity(&request, persisted),
    )? {
        AlgoExecutionCas::Updated => {}
        AlgoExecutionCas::Accepted(persisted) => return Ok(persisted),
    }
    Ok(result)
}

#[tauri::command]
pub async fn okx_cancel_algo_order(
    app: tauri::AppHandle,
    request: CancelAlgoOrderRequest,
) -> Result<OkxOrderResult, String> {
    if normalize_environment(&request.environment) == "live" && request.confirmed_live != Some(true)
    {
        return Err("实盘撤销策略单缺少二次确认标记".to_string());
    }
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    ensure_account_snapshot_current(&app, &account)?;
    ensure_trade_account(&account, &request.environment).await?;
    if optional_non_empty(&request.algo_id).is_none()
        && optional_non_empty(&request.algo_cl_ord_id).is_none()
    {
        return Err("撤销策略单需要 algoId 或 algoClOrdId".to_string());
    }
    let body = CancelAlgoOrderBody {
        inst_id: request.inst_id.clone(),
        algo_id: optional_non_empty(&request.algo_id),
        algo_cl_ord_id: optional_non_empty(&request.algo_cl_ord_id),
    };
    let cancel_bodies = vec![body];
    let account_mutation_lease =
        AccountMutationLeaseGuard::begin(&app, &account, "cancel_algo_order")?;
    account_mutation_lease.renew()?;
    let envelope = okx_private_post::<OkxAlgoOrderResult, _>(
        &account,
        "/api/v5/trade/cancel-algos",
        &cancel_bodies,
    )
    .await?;
    let result = envelope
        .data
        .into_iter()
        .next()
        .ok_or_else(|| "OKX 撤销策略单返回为空".to_string())?;
    if result.s_code != "0" {
        return Err(classified_okx_error(
            "okx_cancel_algo_order",
            "撤销策略单",
            &result.s_code,
            &result.s_msg,
        ));
    }
    mark_local_order_cancelled(
        &app,
        &account,
        &result.algo_id,
        &result.algo_cl_ord_id,
        "local-algo-cancel",
        &result,
    )?;
    Ok(OkxOrderResult {
        ord_id: result.algo_id,
        cl_ord_id: result.algo_cl_ord_id,
        s_code: result.s_code,
        s_msg: result.s_msg,
        ts: result.ts,
    })
}

const ALGO_ORDER_TYPE_GROUPS: [&str; 4] = [
    "conditional,oco",
    "trigger",
    "move_order_stop",
    "iceberg,twap",
];
const OPTIONAL_ALGO_ORDER_TYPE_GROUPS: [&str; 2] = ["move_order_stop", "iceberg,twap"];

#[tauri::command]
pub async fn okx_list_algo_orders(
    app: tauri::AppHandle,
    request: ListAlgoOrdersRequest,
) -> Result<AlgoOrdersResponse, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    ensure_trade_account(&account, &request.environment).await?;
    let mut orders = Vec::new();
    for order_types in ALGO_ORDER_TYPE_GROUPS {
        let path = format!("/api/v5/trade/orders-algo-pending?instType=SWAP&ordType={order_types}");
        let pending = match okx_private_get::<AlgoOrderSummary>(&account, &path).await {
            Ok(pending) => pending,
            Err(error) if OPTIONAL_ALGO_ORDER_TYPE_GROUPS.contains(&order_types) => {
                eprintln!(
                    "okx_optional_algo_order_group_read_failed account={} ord_types={} error={error}",
                    account.id, order_types
                );
                continue;
            }
            Err(error) => return Err(error),
        };
        orders.extend(
            pending
                .data
                .into_iter()
                .map(|item| decorate_algo_order(item, &account, "orders-algo-pending")),
        );
    }
    if request.include_history.unwrap_or(false) {
        for order_types in ALGO_ORDER_TYPE_GROUPS {
            for state in ["effective", "canceled", "order_failed"] {
                let path = format!(
                    "/api/v5/trade/orders-algo-history?instType=SWAP&ordType={order_types}&state={state}"
                );
                if let Ok(envelope) = okx_private_get::<AlgoOrderSummary>(&account, &path).await {
                    orders.extend(
                        envelope
                            .data
                            .into_iter()
                            .map(|item| decorate_algo_order(item, &account, "orders-algo-history")),
                    );
                }
            }
        }
    }
    if let Some(inst_id) = optional_non_empty(&request.inst_id) {
        orders.retain(|order| order.inst_id == inst_id);
    }
    // Caching the summaries locally is a side effect: the orders above already
    // came from the exchange and are what the caller asked for. A busy write lock
    // (a long backtest holds one) used to fail the whole command with "database
    // is locked" and blank the algo order panel, even though the fresh data was
    // in hand. Downgrade the cache write to a warning and still return it.
    if let Err(error) = upsert_algo_order_summaries(&app, &account, &orders) {
        eprintln!(
            "okx_algo_order_cache_write_failed account={} error={error}",
            account.id
        );
    }
    Ok(AlgoOrdersResponse {
        account_id: account.id,
        environment: account.environment,
        orders,
        synced_at: now_ms(),
    })
}

#[tauri::command]
pub async fn okx_close_position(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, MarketRuntime>,
    request: ClosePositionRequest,
) -> Result<PlaceOrderResponse, String> {
    okx_close_position_with_actor(app, runtime, request, "user", None).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClosePositionFallbackError {
    #[serde(alias = "desicTradeError")]
    desic_terminal_error: bool,
    source: String,
    category: String,
    code: String,
    message: String,
    retryable: bool,
}

#[derive(Debug, PartialEq, Eq)]
struct ConfirmedClosePositionRejection {
    code: String,
    message: String,
}

fn validate_close_position_environment(
    account_environment: &str,
    request_environment: &str,
    confirmed_live: Option<bool>,
) -> Result<String, String> {
    let actual = normalize_environment(account_environment);
    let requested = normalize_environment(request_environment);
    if actual != requested {
        return Err("账号环境与当前交易环境不一致".to_string());
    }
    if actual == "live" && confirmed_live != Some(true) {
        return Err("实盘市价全平缺少二次确认标记".to_string());
    }
    Ok(actual)
}

fn close_position_action(pos_side: &str, signed_size: f64) -> &'static str {
    let pos_side = normalize_position_side(pos_side);
    if pos_side == "short" || (pos_side == "net" && signed_size < 0.0) {
        "close-short"
    } else {
        "close-long"
    }
}

fn confirmed_close_position_rejection(error: &str) -> Option<ConfirmedClosePositionRejection> {
    let parsed = serde_json::from_str::<ClosePositionFallbackError>(error).ok()?;
    if !parsed.desic_terminal_error
        || parsed.source != "okx_trade_order"
        || parsed.retryable
        || parsed.code.is_empty()
        || parsed.code == "0"
        || is_duplicate_client_order_error(&parsed.code, &parsed.message)
        || !matches!(parsed.category.as_str(), "order_param" | "risk_or_balance")
    {
        return None;
    }
    Some(ConfirmedClosePositionRejection {
        code: parsed.code,
        message: parsed.message,
    })
}

pub(crate) fn should_fallback_close_position(error: &str) -> bool {
    confirmed_close_position_rejection(error).is_some()
}

pub(crate) fn claim_fallback_close_execution(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    execution_key: &str,
) -> Result<NormalExecutionLease, String> {
    claim_normal_execution_retry_from_status(app, account, execution_key, "place_order", "rejected")
}

pub(crate) fn finish_fallback_close_execution<T: Serialize>(
    app: &tauri::AppHandle,
    lease: &NormalExecutionLease,
    response: &T,
) -> Result<(), String> {
    let response_json = serde_json::to_string(response).map_err(|error| error.to_string())?;
    finish_normal_execution(
        app,
        lease,
        "fallback_accepted",
        None,
        Some(&response_json),
        None,
    )
}

pub(crate) fn finish_fallback_close_execution_unknown(
    app: &tauri::AppHandle,
    lease: &NormalExecutionLease,
    error: &str,
) -> Result<(), String> {
    finish_normal_execution(app, lease, "unknown", None, None, Some(error))
}

fn close_position_execution_key(
    account_id: &str,
    request: &ClosePositionRequest,
    operator: &str,
    session_id: Option<&str>,
    action: &str,
) -> String {
    if let Some(opportunity_id) = optional_non_empty(&request.opportunity_id) {
        return format!("opportunity:{opportunity_id}:close-position");
    }
    if operator.trim() == "ai" {
        let run_id = request
            .agent_run_id
            .as_deref()
            .or(session_id)
            .unwrap_or("interactive");
        return format!(
            "agent:{run_id}:place_order:{}:{action}:primary",
            request.inst_id
        );
    }
    format!(
        "user-close-position:{account_id}:{}:{}:{}",
        request.inst_id,
        normalize_position_side(&request.pos_side),
        now_ms()
    )
}

fn complete_ai_close_position_fallback(
    app: &tauri::AppHandle,
    operator: &str,
    opportunity_id: Option<&str>,
    execution_key: &str,
    response: &PlaceOrderResponse,
) {
    if operator.trim() != "ai" {
        return;
    }
    let Some(opportunity_id) = opportunity_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    let Ok(conn) = open_database(app) else {
        return;
    };
    let _ = conn.execute(
        "UPDATE trade_opportunities
         SET status='submitted',execution_result_json=?3,client_order_id=?4,error=NULL,updated_at=?5
         WHERE id=?1 AND execution_key=?2 AND status IN ('failed','executing','submitted')",
        params![
            opportunity_id,
            execution_key,
            serde_json::to_string(response).ok(),
            optional_string(Some(response.cl_ord_id.clone())),
            now_ms(),
        ],
    );
}

pub async fn okx_close_position_with_actor(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, MarketRuntime>,
    request: ClosePositionRequest,
    operator: &str,
    session_id: Option<String>,
) -> Result<PlaceOrderResponse, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    let actual_environment = validate_close_position_environment(
        &account.environment,
        &request.environment,
        request.confirmed_live,
    )?;
    if operator == "ai" && request.reason.as_deref().unwrap_or("").trim().is_empty() {
        return Err("AI 平仓必须提供 reason".to_string());
    }
    if !account.permissions.trade {
        return Err("账号未开启交易权限".to_string());
    }
    let snapshot = okx_private_snapshot(
        app.clone(),
        PrivateSnapshotRequest {
            account_id: Some(account.id.clone()),
        },
    )
    .await?;
    let position = snapshot
        .positions
        .into_iter()
        .find(|pos| {
            pos.inst_id == request.inst_id
                && normalize_position_side(&pos.pos_side)
                    == normalize_position_side(&request.pos_side)
        })
        .ok_or_else(|| "未找到可全平持仓".to_string())?;
    let position_side = normalize_position_side(&position.pos_side);
    let signed_size = parse_optional_f64(&position.pos).unwrap_or(0.0);
    let size = signed_size.abs();
    if size <= 0.0 {
        return Err("当前持仓数量为 0，不能全平".to_string());
    }
    let action = close_position_action(&position_side, signed_size);
    let execution_key = close_position_execution_key(
        &account.id,
        &request,
        operator,
        session_id.as_deref(),
        action,
    );
    let fallback_client_order_id = stable_client_order_id(&execution_key);
    let ordinary = PlaceOrderRequest {
        account_id: Some(account.id.clone()),
        inst_id: request.inst_id.clone(),
        td_mode: request.mgn_mode.clone(),
        order_type: "market".to_string(),
        ticket_mode: "close".to_string(),
        action: action.to_string(),
        price: if position.mark_px.trim().is_empty() {
            "0".to_string()
        } else {
            position.mark_px.clone()
        },
        size: trim_float(size),
        lever: if position.lever.trim().is_empty() {
            "1".to_string()
        } else {
            position.lever.clone()
        },
        environment: actual_environment.clone(),
        confirmed_live: request.confirmed_live,
        operator: Some(operator.to_string()),
        strategy_id: request.opportunity_id.clone(),
        session_id: session_id.clone(),
        opportunity_id: request.opportunity_id.clone(),
        opportunity_revision: None,
        agent_run_id: request.agent_run_id.clone().or_else(|| session_id.clone()),
        execution_key: Some(execution_key.clone()),
        algo_cl_ord_id: None,
        reason: request.reason.clone(),
        execution_leg: Some("close-position".to_string()),
        attach_algo_ords: None,
        order_spec_v2: None,
    };
    match okx_place_order(app.clone(), runtime, ordinary).await {
        Ok(result) => Ok(result),
        Err(first_err) => {
            let rejection = confirmed_close_position_rejection(&first_err).ok_or_else(|| {
                format!(
                    "普通 reduce-only 平仓失败，结果未确认或不满足安全降级条件；已阻止调用全平接口：{first_err}"
                )
            })?;
            let body = ClosePositionBody {
                inst_id: request.inst_id.clone(),
                mgn_mode: request.mgn_mode.clone(),
                pos_side: position_side.clone(),
                auto_cxl: false,
                cl_ord_id: Some(fallback_client_order_id.clone()),
                client_marker: exchange_client_marker(),
            };
            let fallback_lease = claim_normal_execution_retry_from_status(
                &app,
                &account,
                &execution_key,
                "place_order",
                "rejected",
            )?;
            let envelope = match okx_private_post::<OkxClosePositionResult, _>(
                &account,
                "/api/v5/trade/close-position",
                &body,
            )
            .await
            {
                Ok(value) => value,
                Err(error) => {
                    finish_trade_execution(
                        &app,
                        &fallback_lease,
                        "unknown",
                        None,
                        None,
                        Some(&error),
                    )?;
                    return Err(format!(
                        "普通 reduce-only 平仓已被 OKX 明确拒绝，但全平接口结果不明确；已阻止再次提交：{error}"
                    ));
                }
            };
            if envelope.code != "0" {
                let error = classified_okx_error(
                    "okx_trade_close_position",
                    "市价全平",
                    &envelope.code,
                    &envelope.msg,
                );
                finish_trade_execution(&app, &fallback_lease, "unknown", None, None, Some(&error))?;
                return Err(error);
            }
            let Some(result) = envelope.data.into_iter().next() else {
                let error = "OKX 市价全平返回为空，结果无法确认".to_string();
                finish_trade_execution(&app, &fallback_lease, "unknown", None, None, Some(&error))?;
                return Err(error);
            };
            let response = PlaceOrderResponse {
                ord_id: String::new(),
                cl_ord_id: optional_string(Some(result.cl_ord_id.clone()))
                    .unwrap_or(fallback_client_order_id),
                s_code: "0".to_string(),
                s_msg: format!(
                    "普通 reduce-only 平仓被 OKX 明确拒绝（{}），已由全平接口接收",
                    rejection.code
                ),
                ts: now_ms().to_string(),
                side: if action == "close-short" {
                    "buy".to_string()
                } else {
                    "sell".to_string()
                },
                pos_side: position_side,
                reduce_only: true,
                operator: operator.to_string(),
                strategy_id: request.opportunity_id.clone(),
                session_id: session_id.clone(),
                opportunity_id: request.opportunity_id.clone(),
                agent_run_id: request.agent_run_id.clone().or(session_id),
                execution_key: Some(execution_key.clone()),
            };
            finish_trade_execution(
                &app,
                &fallback_lease,
                "accepted",
                None,
                Some(&response),
                None,
            )?;
            complete_ai_close_position_fallback(
                &app,
                operator,
                request.opportunity_id.as_deref(),
                &execution_key,
                &response,
            );
            audit_trade_event(
                &app,
                &account,
                &request.inst_id,
                "order_submit",
                "close_position_fallback",
                "accepted",
                Some("market"),
                None,
                Some(&response.cl_ord_id),
                Some(&response.side),
                Some(&response.pos_side),
                Some(&request.mgn_mode),
                Some(&trim_float(size)),
                None,
                operator,
                request.opportunity_id.clone(),
                response.session_id.clone(),
                actual_environment == "live",
                Some("0"),
                Some(&response.s_msg),
                None,
                json!({
                    "request": &request,
                    "okxBody": &body,
                    "ordinaryOrderRejection": {
                        "code": rejection.code,
                        "message": rejection.message,
                    },
                }),
                Some(json!(&result)),
            );
            Ok(response)
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TradeOpportunityProtectiveOrder {
    kind: String,
    trigger_px: Option<String>,
    order_px: Option<String>,
    trigger_px_type: Option<String>,
    close_fraction: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TradeOpportunityCreateRequest {
    account_id: Option<String>,
    environment: String,
    inst_id: String,
    td_mode: String,
    intent: String,
    exit_kind: Option<String>,
    close_fraction: Option<String>,
    direction: String,
    #[serde(default)]
    size: String,
    order_type: String,
    price: Option<String>,
    order_id: Option<String>,
    client_order_id: Option<String>,
    algo_id: Option<String>,
    algo_client_order_id: Option<String>,
    new_price: Option<String>,
    new_size: Option<String>,
    lever: Option<String>,
    entry_condition: Option<String>,
    take_profit: Option<TradeOpportunityProtectiveOrder>,
    stop_loss: Option<TradeOpportunityProtectiveOrder>,
    invalidation_price: Option<String>,
    max_slippage_bps: Option<f64>,
    confidence: Option<f64>,
    time_horizon: Option<String>,
    strategy_name: Option<String>,
    evidence: Option<Vec<String>>,
    risk_notes: Option<Vec<String>>,
    reason: String,
    pub source_session_id: Option<String>,
    origin_type: Option<String>,
    strategy_kind: Option<String>,
    strategy_id: Option<String>,
    strategy_version_id: Option<String>,
    strategy_run_id: Option<String>,
    signal_id: Option<String>,
    factor_pool_version_id: Option<String>,
    pub expires_at: Option<i64>,
    pub agent_profile_id: Option<String>,
    pub agent_run_id: Option<String>,
    pub related_opportunity_id: Option<String>,
    pub duplicate_resolution: Option<String>,
    pub duplicate_resolution_reason: Option<String>,
    pub decision_context_id: Option<String>,
    #[serde(default, skip_serializing)]
    max_single_trade_margin_pct: Option<f64>,
    confirmed_live: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DecisionContextRequest {
    account_id: Option<String>,
    environment: String,
    inst_id: String,
    candidate: TradeOpportunityCreateRequest,
    pub agent_profile_id: Option<String>,
    pub agent_run_id: Option<String>,
    #[serde(default)]
    max_single_trade_margin_pct: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeOpportunityCommitRequest {
    decision_context_id: String,
    related_opportunity_id: Option<String>,
    duplicate_resolution: Option<String>,
    duplicate_resolution_reason: Option<String>,
    agent_profile_id: Option<String>,
    agent_run_id: Option<String>,
    #[serde(default)]
    max_single_trade_margin_pct: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TradeOpportunityConflict {
    kind: String,
    reason: String,
    existing_opportunity_id: String,
    existing_revision: i64,
    existing_fingerprint: String,
    existing_status: String,
    existing_expires_at: Option<i64>,
    requested_fingerprint: String,
    allowed_resolutions: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TradeOpportunitySummary {
    pub id: String,
    pub account_id: Option<String>,
    environment: String,
    pub inst_id: String,
    td_mode: String,
    intent: String,
    exit_kind: Option<String>,
    close_fraction: Option<String>,
    direction: String,
    ticket_mode: String,
    action: String,
    order_type: String,
    price: Option<String>,
    size: String,
    lever: Option<String>,
    entry_condition: Option<String>,
    take_profit: Option<TradeOpportunityProtectiveOrder>,
    stop_loss: Option<TradeOpportunityProtectiveOrder>,
    invalidation_price: Option<String>,
    max_slippage_bps: Option<f64>,
    confidence: Option<f64>,
    time_horizon: Option<String>,
    strategy_name: Option<String>,
    evidence: Vec<String>,
    risk_notes: Vec<String>,
    reason: String,
    source_session_id: Option<String>,
    origin_type: String,
    strategy_kind: Option<String>,
    strategy_id: Option<String>,
    strategy_version_id: Option<String>,
    strategy_run_id: Option<String>,
    signal_id: Option<String>,
    factor_pool_version_id: Option<String>,
    revision: i64,
    fingerprint: String,
    expires_at: Option<i64>,
    agent_profile_id: Option<String>,
    agent_run_id: Option<String>,
    related_opportunity_id: Option<String>,
    duplicate_resolution: Option<String>,
    duplicate_resolution_reason: Option<String>,
    decision_context_id: Option<String>,
    execution_key: Option<String>,
    pub status: String,
    estimated_margin: Option<f64>,
    estimated_fee: Option<f64>,
    available_usdt: Option<f64>,
    market_snapshot_json: Option<serde_json::Value>,
    precheck_json: Option<serde_json::Value>,
    execution_result_json: Option<serde_json::Value>,
    order_id: Option<String>,
    client_order_id: Option<String>,
    algo_id: Option<String>,
    algo_client_order_id: Option<String>,
    error: Option<String>,
    created_at: i64,
    updated_at: i64,
    #[serde(skip_deserializing)]
    conflict: Option<TradeOpportunityConflict>,
}

fn new_decision_context_id(now: i64, fingerprint: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos())
        .unwrap_or_default();
    format!(
        "decision-{now}-{nanos}-{}",
        &fingerprint[..fingerprint.len().min(12)]
    )
}

const DECISION_CONTEXT_TTL_MS: i64 = 60_000;

fn snapshot_number(value: &Value, pointer: &str) -> Option<f64> {
    value.pointer(pointer).and_then(|value| {
        value
            .as_f64()
            .or_else(|| value.as_str()?.parse::<f64>().ok())
    })
}

fn market_snapshot_delta(baseline: Option<&Value>, latest: &Value) -> Value {
    let baseline_price = baseline.and_then(|value| snapshot_number(value, "/ticker/last"));
    let latest_price = snapshot_number(latest, "/ticker/last");
    let absolute = baseline_price
        .zip(latest_price)
        .map(|(start, end)| end - start);
    let percent = baseline_price
        .zip(latest_price)
        .filter(|(start, _)| start.abs() > f64::EPSILON)
        .map(|(start, end)| (end - start) / start * 100.0);
    json!({
        "elapsedMs": baseline
            .and_then(|value| value.get("capturedAt"))
            .and_then(Value::as_i64)
            .map(|captured| now_ms().saturating_sub(captured)),
        "lastPrice": { "before": baseline_price, "after": latest_price, "absolute": absolute, "percent": percent },
        "bidPrice": {
            "before": baseline.and_then(|value| snapshot_number(value, "/ticker/bidPx")),
            "after": snapshot_number(latest, "/ticker/bidPx")
        },
        "askPrice": {
            "before": baseline.and_then(|value| snapshot_number(value, "/ticker/askPx")),
            "after": snapshot_number(latest, "/ticker/askPx")
        },
        "orderbookTs": {
            "before": baseline.and_then(|value| value.pointer("/orderbook/ts")).cloned(),
            "after": latest.pointer("/orderbook/ts").cloned()
        },
        "latestTradeTs": {
            "before": baseline.and_then(|value| value.pointer("/recentTrades/0/ts")).cloned(),
            "after": latest.pointer("/recentTrades/0/ts").cloned()
        }
    })
}

fn compact_decision_market_snapshot(snapshot: Option<&Value>) -> Value {
    let Some(snapshot) = snapshot else {
        return Value::Null;
    };
    let mut orderbook = snapshot.get("orderbook").cloned().unwrap_or(Value::Null);
    if let Some(object) = orderbook.as_object_mut() {
        for key in ["bids", "asks"] {
            if let Some(levels) = object.get_mut(key).and_then(Value::as_array_mut) {
                levels.truncate(5);
            }
        }
    }
    let recent_trades = snapshot
        .get("recentTrades")
        .and_then(Value::as_array)
        .map(|items| items.iter().take(12).cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let buy_count = recent_trades
        .iter()
        .filter(|item| item.get("side").and_then(Value::as_str) == Some("buy"))
        .count();
    let sell_count = recent_trades
        .iter()
        .filter(|item| item.get("side").and_then(Value::as_str) == Some("sell"))
        .count();
    let total_size = recent_trades
        .iter()
        .filter_map(|item| snapshot_number(item, "/sz"))
        .sum::<f64>();
    let latest_trade_ts = recent_trades
        .first()
        .and_then(|item| item.get("ts"))
        .cloned();
    json!({
        "capturedAt": snapshot.get("capturedAt"),
        "source": snapshot.get("source"),
        "instId": snapshot.get("instId"),
        "ticker": snapshot.get("ticker"),
        "orderbook": orderbook,
        "recentTrades": recent_trades,
        "tradeFlow": {
            "sampleSize": buy_count + sell_count,
            "buyCount": buy_count,
            "sellCount": sell_count,
            "totalSize": total_size,
            "latestTradeTs": latest_trade_ts
        },
        "candles": snapshot.get("candles"),
        "fundingRate": snapshot.get("fundingRate")
    })
}

fn compact_decision_account_snapshot(
    snapshot: Option<&PrivateAccountSnapshot>,
    inst_id: &str,
) -> Value {
    let Some(snapshot) = snapshot else {
        return Value::Null;
    };
    let balances = snapshot
        .balances
        .iter()
        .filter(|balance| {
            balance.ccy.eq_ignore_ascii_case("USDT")
                || balance.eq.parse::<f64>().unwrap_or_default().abs() > f64::EPSILON
                || balance.avail_eq.parse::<f64>().unwrap_or_default().abs() > f64::EPSILON
        })
        .map(|balance| {
            json!({
                "ccy": balance.ccy,
                "eq": balance.eq,
                "availEq": balance.avail_eq,
                "availBal": balance.avail_bal,
                "frozenBal": balance.frozen_bal,
                "uTime": balance.u_time
            })
        })
        .collect::<Vec<_>>();
    let positions = snapshot
        .positions
        .iter()
        .filter(|position| position.pos.parse::<f64>().unwrap_or_default().abs() > f64::EPSILON)
        .map(|position| {
            json!({
                "instId": position.inst_id,
                "mgnMode": position.mgn_mode,
                "posSide": position.pos_side,
                "pos": position.pos,
                "avgPx": position.avg_px,
                "markPx": position.mark_px,
                "upl": position.upl,
                "lever": position.lever,
                "liqPx": position.liq_px,
                "margin": position.margin,
                "notionalUsd": position.notional_usd,
                "uTime": position.u_time
            })
        })
        .collect::<Vec<_>>();
    let instrument_orders = snapshot
        .orders
        .iter()
        .filter(|order| order.inst_id == inst_id)
        .take(30)
        .map(|order| {
            json!({
                "instId": order.inst_id,
                "ordId": order.ord_id,
                "algoId": order.algo_id,
                "isAlgo": order.is_algo,
                "side": order.side,
                "posSide": order.pos_side,
                "tdMode": order.td_mode,
                "ordType": order.ord_type,
                "px": order.px,
                "triggerPx": order.trigger_px,
                "sz": order.sz,
                "accFillSz": order.acc_fill_sz,
                "state": order.state,
                "reduceOnly": order.reduce_only,
                "uTime": order.u_time
            })
        })
        .collect::<Vec<_>>();
    json!({
        "accountId": snapshot.account_id,
        "environment": snapshot.environment,
        "syncedAt": snapshot.synced_at,
        "balances": balances,
        "positions": positions,
        "instrumentOrders": instrument_orders,
        "openPositionCount": snapshot.positions.len(),
        "openOrderCount": snapshot.orders.len(),
        "instrumentOrderCount": snapshot.orders.iter().filter(|order| order.inst_id == inst_id).count()
    })
}

pub(crate) async fn read_decision_context(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, MarketRuntime>,
    mut request: DecisionContextRequest,
) -> Result<Value, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    if normalize_environment(&account.environment) != normalize_environment(&request.environment) {
        return Err("最终复核账号环境与请求环境不一致".to_string());
    }
    let run_id = optional_string(request.agent_run_id.clone())
        .ok_or_else(|| "market.readDecisionContext 只能用于后台 Agent Run".to_string())?;
    let profile_id = optional_string(request.agent_profile_id.clone())
        .ok_or_else(|| "market.readDecisionContext 缺少 Agent Profile".to_string())?;
    request.inst_id = request.inst_id.trim().to_ascii_uppercase();
    request.account_id = Some(account.id.clone());
    request.candidate.account_id = Some(account.id.clone());
    request.candidate.environment = request.environment.clone();
    request.candidate.inst_id = request.inst_id.clone();
    request.candidate.agent_profile_id = Some(profile_id.clone());
    request.candidate.agent_run_id = Some(run_id.clone());
    request.candidate.decision_context_id = None;
    validate_trade_opportunity_request(&request.candidate)?;
    let fingerprint = trade_opportunity_fingerprint(&request.candidate)?;
    let captured_at = now_ms();
    let expires_at = captured_at.saturating_add(DECISION_CONTEXT_TTL_MS);
    let latest_snapshot =
        capture_trade_opportunity_market_snapshot(runtime.inner(), &request.inst_id);
    let conn = open_database(&app)?;
    let baseline_root = conn
        .query_row(
            "SELECT initial_market_snapshot_json FROM ai_agent_runs
             WHERE id=?1 AND profile_id=?2 AND status='running'",
            params![run_id, profile_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let baseline_snapshot = baseline_root
        .as_ref()
        .and_then(|value| value.get("symbols"))
        .and_then(|value| value.get(&request.inst_id))
        .cloned();
    let baseline_captured_at = baseline_root
        .as_ref()
        .and_then(|value| value.get("capturedAt"))
        .and_then(Value::as_i64);
    let account_snapshot = ai_read_memory_account_snapshot(runtime.inner(), Some(&account.id));
    let is_order_management = matches!(request.candidate.intent.as_str(), "cancel" | "amend");
    let precheck = if is_order_management {
        json!({
            "ok": true,
            "blocked": false,
            "source": "order_management_decision_context",
            "warnings": ["撤单或改单最终复核不新增保证金，执行时仍校验订单状态。"]
        })
    } else {
        let action = match (
            request.candidate.intent.as_str(),
            request.candidate.direction.as_str(),
        ) {
            ("open", "long") => "long",
            ("open", "short") => "short",
            ("close", "long") => "close-long",
            ("close", "short") => "close-short",
            _ => return Err("候选方案方向无效".to_string()),
        };
        let stop_price = request
            .candidate
            .stop_loss
            .as_ref()
            .and_then(|order| order.trigger_px.clone())
            .or_else(|| request.candidate.invalidation_price.clone());
        serde_json::to_value(
            trade_precheck(
                app.clone(),
                TradePrecheckRequest {
                    account_id: Some(account.id.clone()),
                    inst_id: request.inst_id.clone(),
                    td_mode: request.candidate.td_mode.clone(),
                    order_type: request.candidate.order_type.clone(),
                    ticket_mode: if request.candidate.intent == "close" {
                        "close"
                    } else {
                        "open"
                    }
                    .to_string(),
                    action: Some(action.to_string()),
                    price: request.candidate.price.clone().unwrap_or_default(),
                    stop_price,
                    target_price: request
                        .candidate
                        .take_profit
                        .as_ref()
                        .and_then(|order| order.trigger_px.clone()),
                    atr: None,
                    size: request.candidate.size.clone(),
                    lever: request
                        .candidate
                        .lever
                        .clone()
                        .unwrap_or_else(|| "1".to_string()),
                    environment: request.environment.clone(),
                    max_single_trade_margin_pct: request.max_single_trade_margin_pct,
                },
                runtime.clone(),
            )
            .await?,
        )
        .map_err(|error| error.to_string())?
    };
    let context_id = new_decision_context_id(captured_at, &fingerprint);
    let mut baseline_for_delta = baseline_snapshot.clone();
    if let (Some(snapshot), Some(captured_at)) = (baseline_for_delta.as_mut(), baseline_captured_at)
    {
        if let Some(object) = snapshot.as_object_mut() {
            object.insert("capturedAt".to_string(), json!(captured_at));
        }
    }
    let delta = market_snapshot_delta(baseline_for_delta.as_ref(), &latest_snapshot);
    let limitations = if baseline_root.is_some() {
        Vec::<String>::new()
    } else {
        vec!["本轮开始快照不可用，已返回最终实时快照但无法计算完整起止差异。".to_string()]
    };
    let stored_snapshot = json!({
        "decisionContextId": context_id,
        "agentRunId": run_id,
        "agentProfileId": profile_id,
        "accountId": account.id,
        "environment": request.environment,
        "instId": request.inst_id,
        "candidateFingerprint": fingerprint,
        "capturedAt": captured_at,
        "expiresAt": expires_at,
        "ttlMs": DECISION_CONTEXT_TTL_MS,
        "source": "fresh-wss-memory-and-local-account",
        "baselineSnapshot": baseline_snapshot,
        "marketSnapshot": latest_snapshot,
        "marketDelta": delta,
        "accountSnapshot": account_snapshot,
        "precheck": precheck,
        "limitations": limitations
    });
    let response = json!({
        "decisionContextId": context_id,
        "agentRunId": run_id,
        "agentProfileId": profile_id,
        "accountId": account.id,
        "environment": request.environment,
        "instId": request.inst_id,
        "candidateFingerprint": fingerprint,
        "capturedAt": captured_at,
        "expiresAt": expires_at,
        "ttlMs": DECISION_CONTEXT_TTL_MS,
        "source": "fresh-wss-memory-and-local-account",
        "snapshotAgeMs": 0,
        "initialSnapshot": compact_decision_market_snapshot(baseline_snapshot.as_ref()),
        "finalSnapshot": compact_decision_market_snapshot(Some(&latest_snapshot)),
        "changes": delta,
        "accountSnapshot": compact_decision_account_snapshot(account_snapshot.as_ref(), &request.inst_id),
        "precheck": precheck,
        "limitations": limitations
    });
    conn.execute(
        "INSERT INTO ai_decision_contexts(
           id,agent_run_id,agent_profile_id,account_id,environment,inst_id,
           candidate_fingerprint,candidate_json,baseline_snapshot_json,snapshot_json,
           captured_at,expires_at
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![
            context_id,
            run_id,
            profile_id,
            account.id,
            normalize_environment(&account.environment),
            request.candidate.inst_id,
            fingerprint,
            serde_json::to_string(&request.candidate).map_err(|error| error.to_string())?,
            baseline_snapshot.map(|value| value.to_string()),
            stored_snapshot.to_string(),
            captured_at,
            expires_at,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(response)
}

fn automation_opportunity_requires_decision_context(
    request: &TradeOpportunityCreateRequest,
) -> bool {
    optional_string(request.agent_run_id.clone()).is_some()
        && optional_string(request.agent_profile_id.clone()).is_some()
}

fn validate_decision_context(
    conn: &Connection,
    request: &TradeOpportunityCreateRequest,
    fingerprint: &str,
    now: i64,
) -> Result<Option<String>, String> {
    if !automation_opportunity_requires_decision_context(request) {
        return Ok(None);
    }
    let requested_context_id = request
        .decision_context_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let requested_exists = requested_context_id
        .map(|context_id| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM ai_decision_contexts WHERE id=?1)",
                params![context_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| error.to_string())
        })
        .transpose()?
        .unwrap_or(false);
    let context_id = if requested_exists {
        requested_context_id.unwrap_or_default().to_string()
    } else {
        conn.query_row(
            "SELECT id FROM ai_decision_contexts
             WHERE agent_run_id=?1 AND agent_profile_id=?2
               AND account_id=?3 AND environment=?4 AND inst_id=?5
               AND candidate_fingerprint=?6
             ORDER BY expires_at DESC LIMIT 1",
            params![
                request.agent_run_id.as_deref().unwrap_or_default(),
                request.agent_profile_id.as_deref().unwrap_or_default(),
                request.account_id.as_deref().unwrap_or_default(),
                normalize_environment(&request.environment),
                request.inst_id,
                fingerprint,
            ],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| {
            if requested_context_id.is_some() {
                "decision_context_not_found：未找到与当前候选参数匹配的最终复核快照，请重新读取"
                    .to_string()
            } else {
                "自动化交易机会必须先调用 market.readDecisionContext".to_string()
            }
        })?
    };
    let row = conn
        .query_row(
            "SELECT agent_run_id,agent_profile_id,account_id,environment,inst_id,
                    candidate_fingerprint,expires_at,consumed_opportunity_id,snapshot_json
             FROM ai_decision_contexts WHERE id=?1",
            params![context_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "decision_context_not_found：请重新读取最终复核快照".to_string())?;
    if row.6 <= now {
        return Err(format!(
            "decision_context_expired：最终复核快照已超过 {} 秒，请重新读取",
            DECISION_CONTEXT_TTL_MS / 1_000
        ));
    }
    if row.7.is_some() {
        return Err("decision_context_consumed：该最终复核快照已被使用，请重新读取".to_string());
    }
    if row.0 != request.agent_run_id.as_deref().unwrap_or_default()
        || row.1 != request.agent_profile_id.as_deref().unwrap_or_default()
        || row.2 != request.account_id.as_deref().unwrap_or_default()
        || normalize_environment(&row.3) != normalize_environment(&request.environment)
        || row.4 != request.inst_id
    {
        return Err(
            "decision_context_scope_mismatch：最终复核快照不属于当前 Run、账号、环境或标的"
                .to_string(),
        );
    }
    if row.5 != fingerprint {
        return Err(
            "decision_context_candidate_mismatch：候选参数已变化，请使用修改后的方案重新复核"
                .to_string(),
        );
    }
    if serde_json::from_str::<Value>(&row.8)
        .ok()
        .and_then(|value| value.pointer("/precheck/blocked").and_then(Value::as_bool))
        == Some(true)
    {
        return Err("最终复核预检已阻断，不能创建或复用交易机会".to_string());
    }
    Ok(Some(context_id))
}

fn consume_decision_context(
    conn: &Connection,
    context_id: Option<&str>,
    opportunity_id: &str,
    now: i64,
) -> Result<(), String> {
    let Some(context_id) = context_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let changed = conn
        .execute(
            "UPDATE ai_decision_contexts
             SET consumed_opportunity_id=?2,consumed_at=?3
             WHERE id=?1 AND consumed_at IS NULL AND expires_at>?3",
            params![context_id, opportunity_id, now],
        )
        .map_err(|error| error.to_string())?;
    if changed != 1 {
        return Err("decision_context_expired：最终复核快照已失效或已被使用".to_string());
    }
    Ok(())
}

fn validate_opportunity_decision_context_for_auto_execution(
    conn: &Connection,
    opportunity: &TradeOpportunitySummary,
) -> Result<(), String> {
    let Some(run_id) = opportunity.agent_run_id.as_deref() else {
        return Ok(());
    };
    let context_id = opportunity
        .decision_context_id
        .as_deref()
        .ok_or_else(|| "自动执行缺少最终复核 decisionContextId".to_string())?;
    let valid = conn
        .query_row(
            "SELECT COUNT(*) FROM ai_decision_contexts
             WHERE id=?1 AND agent_run_id=?2 AND inst_id=?3
               AND consumed_opportunity_id=?4 AND consumed_at IS NOT NULL",
            params![context_id, run_id, opportunity.inst_id, opportunity.id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    if valid != 1 {
        return Err(
            "decision_context_expired：自动执行前最终复核快照已失效，请重新分析".to_string(),
        );
    }
    Ok(())
}

fn validate_reuse_decision_context(
    conn: &Connection,
    opportunity: &TradeOpportunitySummary,
    request: &TradeOpportunityMutationRequest,
) -> Result<(), String> {
    let Some(run_id) = request.agent_run_id.as_deref() else {
        return Ok(());
    };
    let context_id = request
        .decision_context_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "自动化复用交易机会前必须重新调用 market.readDecisionContext".to_string())?;
    let valid = conn
        .query_row(
            "SELECT snapshot_json FROM ai_decision_contexts
             WHERE id=?1 AND agent_run_id=?2 AND agent_profile_id=?3
               AND account_id=?4 AND environment=?5 AND inst_id=?6
               AND candidate_fingerprint=?7 AND expires_at>?8 AND consumed_at IS NULL",
            params![
                context_id,
                run_id,
                request.agent_profile_id.as_deref().unwrap_or_default(),
                opportunity.account_id.as_deref().unwrap_or_default(),
                normalize_environment(&opportunity.environment),
                opportunity.inst_id,
                opportunity.fingerprint,
                now_ms(),
            ],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(snapshot_json) = valid else {
        return Err(
            "decision_context_expired：复用参数或范围不匹配，请重新读取最终复核快照".to_string(),
        );
    };
    let snapshot = serde_json::from_str::<Value>(&snapshot_json)
        .map_err(|error| format!("最终复核快照无效：{error}"))?;
    if snapshot
        .pointer("/precheck/blocked")
        .and_then(Value::as_bool)
        .unwrap_or(true)
    {
        return Err("最终复核预检已阻断，不能复用交易机会".to_string());
    }
    Ok(())
}

pub(crate) fn materialize_trade_opportunity_commit(
    app: &tauri::AppHandle,
    commit: TradeOpportunityCommitRequest,
    source_session_id: &str,
) -> Result<TradeOpportunityCreateRequest, String> {
    let conn = open_database(app)?;
    materialize_trade_opportunity_commit_with_conn(&conn, commit, source_session_id, now_ms())
}

fn materialize_trade_opportunity_commit_with_conn(
    conn: &Connection,
    commit: TradeOpportunityCommitRequest,
    source_session_id: &str,
    now: i64,
) -> Result<TradeOpportunityCreateRequest, String> {
    let duplicate_resolution =
        normalize_duplicate_resolution(commit.duplicate_resolution.as_deref())?;
    if duplicate_resolution.is_some()
        && commit
            .duplicate_resolution_reason
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
    {
        return Err("处理重复交易机会时必须提供 duplicateResolutionReason".to_string());
    }
    if matches!(duplicate_resolution.as_deref(), Some("reuse" | "revise"))
        && commit
            .related_opportunity_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
    {
        return Err("复用或修订交易机会时必须提供 conflict.existingOpportunityId".to_string());
    }
    let context_id = commit.decision_context_id.trim();
    let run_id = commit
        .agent_run_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "后台交易机会提交缺少 Agent Run".to_string())?;
    let profile_id = commit
        .agent_profile_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "后台交易机会提交缺少 Agent Profile".to_string())?;
    if context_id.is_empty() {
        return Err("decision_context_required：请先读取最终复核".to_string());
    }

    let row = conn
        .query_row(
            "SELECT agent_run_id,agent_profile_id,expires_at,consumed_at,candidate_json
             FROM ai_decision_contexts WHERE id=?1",
            params![context_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "decision_context_not_found：最终复核不存在，请重新读取".to_string())?;
    if row.0 != run_id || row.1 != profile_id {
        return Err(
            "decision_context_scope_mismatch：最终复核不属于当前 Run 或 Profile".to_string(),
        );
    }
    if row.2 <= now {
        return Err("decision_context_expired：最终复核已经过期，请重新读取".to_string());
    }
    if row.3.is_some() {
        return Err("decision_context_consumed：最终复核已经提交，请重新读取".to_string());
    }

    let mut request = serde_json::from_str::<TradeOpportunityCreateRequest>(&row.4)
        .map_err(|error| format!("最终复核保存的候选无效：{error}"))?;
    request.decision_context_id = Some(context_id.to_string());
    request.agent_run_id = Some(run_id.to_string());
    request.agent_profile_id = Some(profile_id.to_string());
    request.related_opportunity_id = commit.related_opportunity_id;
    request.duplicate_resolution = duplicate_resolution;
    request.duplicate_resolution_reason = commit.duplicate_resolution_reason;
    request.max_single_trade_margin_pct = commit.max_single_trade_margin_pct;
    request.source_session_id = Some(source_session_id.to_string());
    Ok(request)
}

fn commit_reuse_resolution(
    conn: &mut Connection,
    request: &TradeOpportunityCreateRequest,
    target_id: &str,
    requested_fingerprint: &str,
    reason: &str,
    now: i64,
) -> Result<TradeOpportunitySummary, String> {
    if request
        .related_opportunity_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some_and(|related_id| related_id != target_id)
    {
        return Err(
            "duplicate_reuse_target_mismatch：复用目标与检测到的重复机会不一致".to_string(),
        );
    }

    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let existing = load_trade_opportunity(&tx, target_id)?;
    if existing.fingerprint != requested_fingerprint || existing.fingerprint.is_empty() {
        return Err(
            "duplicate_reuse_candidate_mismatch：相似机会参数不同；请读取原机会并按原参数重新调用 market.readDecisionContext"
                .to_string(),
        );
    }
    if existing
        .expires_at
        .is_some_and(|expires_at| expires_at <= now)
    {
        return Err("原交易机会已过期，不能复用".to_string());
    }
    if !matches!(
        existing.status.as_str(),
        "pending"
            | "approved"
            | "executing"
            | "submitted"
            | "partially_filled"
            | "pending_blocked"
            | "recovery_blocked"
    ) {
        return Err(format!("当前交易机会状态不能复用：{}", existing.status));
    }
    if automation_opportunity_requires_decision_context(request) {
        consume_decision_context(
            &tx,
            request.decision_context_id.as_deref(),
            &existing.id,
            now,
        )?;
    }
    persist_opportunity_resolution(
        &tx,
        &existing.id,
        Some(&existing.id),
        "reuse",
        reason,
        request.agent_run_id.as_deref(),
    )?;
    tx.commit().map_err(|error| error.to_string())?;

    let mut existing = load_trade_opportunity(conn, target_id)?;
    existing.duplicate_resolution = Some("reuse".to_string());
    existing.duplicate_resolution_reason = Some(reason.to_string());
    existing.conflict = None;
    Ok(existing)
}

#[tauri::command]
pub async fn trade_opportunity_create(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, MarketRuntime>,
    mut request: TradeOpportunityCreateRequest,
) -> Result<TradeOpportunitySummary, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    if normalize_environment(&account.environment) != normalize_environment(&request.environment) {
        return Err("交易机会账号环境与请求环境不一致".to_string());
    }
    request.account_id = Some(account.id);
    if request.intent == "amend" {
        if optional_string(request.price.clone()).is_none() {
            request.price = optional_string(request.new_price.clone());
        }
        if request.size.trim().is_empty() {
            request.size = optional_string(request.new_size.clone()).unwrap_or_default();
        }
    }
    validate_trade_opportunity_request(&request)?;
    let now = now_ms();
    let fingerprint = trade_opportunity_fingerprint(&request)?;
    let resolution = normalize_duplicate_resolution(request.duplicate_resolution.as_deref())?;
    if resolution.as_deref() == Some("create_new")
        && request
            .duplicate_resolution_reason
            .as_deref()
            .unwrap_or("")
            .trim()
            .is_empty()
    {
        return Err("明确创建相似新机会时必须提供 duplicateResolutionReason".to_string());
    }
    let mut conn = open_database(&app)?;
    request.decision_context_id = validate_decision_context(&conn, &request, &fingerprint, now)?;
    expire_trade_opportunities(&conn, now)?;

    let detected = find_similar_trade_opportunity(&conn, &request, &fingerprint, now)?;
    if let Some(mut existing) = detected.clone() {
        let conflict = trade_opportunity_conflict(&existing, &fingerprint);
        match resolution.as_deref() {
            None => {
                existing.conflict = Some(conflict);
                return Ok(existing);
            }
            Some("reuse") => {
                let reason = request
                    .duplicate_resolution_reason
                    .as_deref()
                    .unwrap_or("复用相似有效机会");
                return commit_reuse_resolution(
                    &mut conn,
                    &request,
                    &existing.id,
                    &fingerprint,
                    reason,
                    now,
                );
            }
            Some("revise") | Some("create_new") => {}
            Some(_) => unreachable!(),
        }
    }

    if resolution.as_deref() == Some("reuse") {
        if let Some(related_id) = optional_string(request.related_opportunity_id.clone()) {
            let reason = request
                .duplicate_resolution_reason
                .as_deref()
                .unwrap_or("复用指定交易机会");
            return commit_reuse_resolution(
                &mut conn,
                &request,
                &related_id,
                &fingerprint,
                reason,
                now,
            );
        }
        return Err(
            "duplicate_reuse_target_required：复用交易机会必须提供 relatedOpportunityId"
                .to_string(),
        );
    }

    let related = match optional_string(request.related_opportunity_id.clone()) {
        Some(related_id) => Some(load_trade_opportunity(&conn, &related_id)?),
        None => detected,
    };
    let revision = if resolution.as_deref() == Some("revise") {
        related
            .as_ref()
            .map(|item| item.revision.saturating_add(1))
            .unwrap_or(1)
    } else {
        1
    };
    let related_opportunity_id = related.as_ref().map(|item| item.id.clone());
    drop(conn);

    let opportunity = build_trade_opportunity(
        app.clone(),
        runtime,
        request.clone(),
        "pending",
        revision,
        fingerprint.clone(),
        related_opportunity_id,
        resolution.clone(),
    )
    .await?;
    let mut conn = open_database(&app)?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|err| err.to_string())?;
    let commit_now = now_ms();
    expire_trade_opportunities(&tx, commit_now)?;
    if let Some(mut concurrent) =
        find_similar_trade_opportunity(&tx, &request, &fingerprint, commit_now)?
    {
        match resolution.as_deref() {
            None => {
                concurrent.conflict = Some(trade_opportunity_conflict(&concurrent, &fingerprint));
                return Ok(concurrent);
            }
            Some("reuse") => {
                let reason = request
                    .duplicate_resolution_reason
                    .as_deref()
                    .unwrap_or("并发检查命中相似机会，复用原机会");
                persist_opportunity_resolution(
                    &tx,
                    &concurrent.id,
                    Some(&concurrent.id),
                    "reuse",
                    reason,
                    request.agent_run_id.as_deref(),
                )?;
                tx.commit().map_err(|err| err.to_string())?;
                concurrent.duplicate_resolution = Some("reuse".to_string());
                concurrent.duplicate_resolution_reason = Some(reason.to_string());
                return Ok(concurrent);
            }
            Some("revise") | Some("create_new") => {}
            Some(_) => unreachable!(),
        }
    }
    if resolution.as_deref() == Some("revise") {
        let related_id = opportunity
            .related_opportunity_id
            .as_deref()
            .ok_or_else(|| "修订交易机会必须关联原机会".to_string())?;
        let current = load_trade_opportunity(&tx, related_id)?;
        if matches!(current.status.as_str(), "executing" | "executed") {
            return Err("已进入执行流程的交易机会不能修订".to_string());
        }
        if !matches!(
            current.status.as_str(),
            "pending" | "approved" | "pending_blocked"
        ) {
            return Err(format!("原交易机会状态不能修订：{}", current.status));
        }
    }
    save_trade_opportunity(&tx, &opportunity)?;
    if automation_opportunity_requires_decision_context(&request) {
        consume_decision_context(
            &tx,
            request.decision_context_id.as_deref(),
            &opportunity.id,
            commit_now,
        )?;
    }
    if resolution.as_deref() == Some("revise") {
        let related_id = opportunity
            .related_opportunity_id
            .as_deref()
            .unwrap_or_default();
        let reason = opportunity
            .duplicate_resolution_reason
            .as_deref()
            .unwrap_or("创建新修订");
        tx.execute(
            "UPDATE trade_opportunities SET status='superseded',error=?2,updated_at=?3
             WHERE id=?1 AND status IN ('pending','approved','pending_blocked')",
            params![related_id, reason, commit_now],
        )
        .map_err(|err| err.to_string())?;
        persist_opportunity_resolution(
            &tx,
            &opportunity.id,
            Some(related_id),
            "revise",
            reason,
            opportunity.agent_run_id.as_deref(),
        )?;
    } else if resolution.as_deref() == Some("create_new") {
        persist_opportunity_resolution(
            &tx,
            &opportunity.id,
            opportunity.related_opportunity_id.as_deref(),
            "create_new",
            opportunity
                .duplicate_resolution_reason
                .as_deref()
                .unwrap_or("明确创建新机会"),
            opportunity.agent_run_id.as_deref(),
        )?;
    }
    tx.commit().map_err(|err| err.to_string())?;
    Ok(opportunity)
}

fn persist_opportunity_resolution(
    conn: &Connection,
    opportunity_id: &str,
    related_opportunity_id: Option<&str>,
    resolution: &str,
    reason: &str,
    agent_run_id: Option<&str>,
) -> Result<(), String> {
    let now = now_ms();
    conn.execute(
        "INSERT INTO trade_opportunity_resolution_events(
          id,opportunity_id,related_opportunity_id,resolution,reason,agent_run_id,created_at
         ) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![
            format!(
                "opp-resolution-{}-{}",
                now,
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|duration| duration.subsec_nanos())
                    .unwrap_or_default()
            ),
            opportunity_id,
            related_opportunity_id,
            resolution,
            reason,
            agent_run_id,
            now,
        ],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "UPDATE trade_opportunities
         SET duplicate_resolution=?2,duplicate_resolution_reason=?3,updated_at=?4 WHERE id=?1",
        params![opportunity_id, resolution, reason, now],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn normalize_duplicate_resolution(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if matches!(value, "reuse" | "revise" | "create_new") {
        Ok(Some(value.to_string()))
    } else {
        Err("duplicateResolution 必须是 reuse、revise 或 create_new".to_string())
    }
}

#[tauri::command]
pub fn trade_opportunities(app: tauri::AppHandle) -> Result<Vec<TradeOpportunitySummary>, String> {
    let conn = open_database(&app)?;
    list_trade_opportunities(&conn)
}

#[tauri::command]
pub fn trade_opportunity_delete(app: tauri::AppHandle, id: String) -> Result<usize, String> {
    let mut conn = open_database(&app)?;
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("交易机会 ID 不能为空".to_string());
    }
    load_trade_opportunity(&conn, &id)?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    detach_trade_opportunity_references(&tx, Some(&id))?;
    let deleted = tx
        .execute("DELETE FROM trade_opportunities WHERE id=?1", params![id])
        .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(deleted)
}

#[tauri::command]
pub fn trade_opportunities_clear(app: tauri::AppHandle) -> Result<usize, String> {
    let mut conn = open_database(&app)?;
    let total: usize = conn
        .query_row("SELECT COUNT(*) FROM trade_opportunities", [], |row| {
            row.get(0)
        })
        .map_err(|err| err.to_string())?;
    if total == 0 {
        return Ok(0);
    }
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    detach_trade_opportunity_references(&tx, None)?;
    tx.execute("DELETE FROM trade_opportunities", [])
        .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(total)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeOpportunityMutationRequest {
    pub id: String,
    pub reason: Option<String>,
    #[serde(default)]
    pub agent_profile_id: Option<String>,
    #[serde(default)]
    pub agent_run_id: Option<String>,
    #[serde(default)]
    pub decision_context_id: Option<String>,
    #[serde(default)]
    pub overrides: serde_json::Value,
    #[serde(default)]
    max_single_trade_margin_pct: Option<f64>,
}

pub fn trade_opportunity_get(
    app: tauri::AppHandle,
    id: String,
) -> Result<TradeOpportunitySummary, String> {
    let conn = open_database(&app)?;
    load_trade_opportunity(&conn, &id)
}

pub fn trade_opportunity_reuse(
    app: tauri::AppHandle,
    request: TradeOpportunityMutationRequest,
) -> Result<TradeOpportunitySummary, String> {
    let conn = open_database(&app)?;
    let mut opportunity = load_trade_opportunity(&conn, &request.id)?;
    if opportunity
        .expires_at
        .is_some_and(|expires_at| expires_at <= now_ms())
    {
        return Err("原交易机会已过期，不能复用".to_string());
    }
    if !matches!(
        opportunity.status.as_str(),
        "pending" | "approved" | "executing" | "pending_blocked"
    ) {
        return Err(format!("当前交易机会状态不能复用：{}", opportunity.status));
    }
    validate_reuse_decision_context(&conn, &opportunity, &request)?;
    let reason = request
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("主 Agent 复用原交易机会");
    conn.execute(
        "UPDATE trade_opportunities SET
           agent_profile_id=COALESCE(?2,agent_profile_id),
           agent_run_id=COALESCE(?3,agent_run_id),decision_context_id=COALESCE(?4,decision_context_id),updated_at=?5
         WHERE id=?1",
        params![
            request.id,
            request.agent_profile_id,
            request.agent_run_id,
            request.decision_context_id,
            now_ms()
        ],
    )
    .map_err(|err| err.to_string())?;
    persist_opportunity_resolution(
        &conn,
        &opportunity.id,
        Some(&opportunity.id),
        "reuse",
        reason,
        request
            .agent_run_id
            .as_deref()
            .or(opportunity.agent_run_id.as_deref()),
    )?;
    if request.agent_run_id.is_some() {
        consume_decision_context(
            &conn,
            request.decision_context_id.as_deref(),
            &opportunity.id,
            now_ms(),
        )?;
    }
    opportunity = load_trade_opportunity(&conn, &request.id)?;
    opportunity.conflict = None;
    Ok(opportunity)
}

pub async fn trade_opportunity_revise(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, MarketRuntime>,
    request: TradeOpportunityMutationRequest,
) -> Result<TradeOpportunitySummary, String> {
    let existing = trade_opportunity_get(app.clone(), request.id.clone())?;
    if matches!(existing.status.as_str(), "executing" | "executed") {
        return Err("已进入执行流程的交易机会不能修订".to_string());
    }
    let mut value = serde_json::to_value(&existing).map_err(|err| err.to_string())?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "交易机会数据无效".to_string())?;
    if let Some(overrides) = request.overrides.as_object() {
        const ALLOWED_REVISION_FIELDS: &[&str] = &[
            "tdMode",
            "orderType",
            "exitKind",
            "closeFraction",
            "price",
            "size",
            "lever",
            "entryCondition",
            "takeProfit",
            "stopLoss",
            "invalidationPrice",
            "maxSlippageBps",
            "confidence",
            "timeHorizon",
            "strategyName",
            "evidence",
            "riskNotes",
            "expiresAt",
        ];
        for (key, value) in overrides {
            if !ALLOWED_REVISION_FIELDS.contains(&key.as_str()) {
                return Err(format!("交易机会修订不允许覆盖字段：{}", key));
            }
            object.insert(key.clone(), value.clone());
        }
    }
    if let Some(profile_id) = optional_string(request.agent_profile_id.clone()) {
        object.insert("agentProfileId".to_string(), json!(profile_id));
    }
    if let Some(run_id) = optional_string(request.agent_run_id.clone()) {
        object.insert("agentRunId".to_string(), json!(run_id));
    }
    if let Some(context_id) = optional_string(request.decision_context_id.clone()) {
        object.insert("decisionContextId".to_string(), json!(context_id));
    } else if request.agent_run_id.is_some() {
        object.remove("decisionContextId");
    }
    object.insert(
        "maxSingleTradeMarginPct".to_string(),
        json!(request.max_single_trade_margin_pct),
    );
    object.insert("relatedOpportunityId".to_string(), json!(request.id));
    object.insert("duplicateResolution".to_string(), json!("revise"));
    object.insert(
        "duplicateResolutionReason".to_string(),
        json!(request
            .reason
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("主 Agent 创建修订")),
    );
    object.insert(
        "reason".to_string(),
        json!(request
            .reason
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| existing.reason.clone())),
    );
    let create_request: TradeOpportunityCreateRequest =
        serde_json::from_value(value).map_err(|err| format!("修订参数无效：{}", err))?;
    trade_opportunity_create(app, runtime, create_request).await
}

pub fn trade_opportunity_close(
    app: tauri::AppHandle,
    request: TradeOpportunityMutationRequest,
) -> Result<TradeOpportunitySummary, String> {
    let conn = open_database(&app)?;
    let current = load_trade_opportunity(&conn, &request.id)?;
    if matches!(current.status.as_str(), "executing" | "executed") {
        return Err("已进入执行流程的交易机会不能直接关闭，请先处理对应订单".to_string());
    }
    let reason = request
        .reason
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "由主 Agent 关闭".to_string());
    conn.execute(
        "UPDATE trade_opportunities SET status='cancelled',error=?2,updated_at=?3 WHERE id=?1",
        params![request.id, reason, now_ms()],
    )
    .map_err(|err| err.to_string())?;
    load_trade_opportunity(&conn, &request.id)
}

pub fn trade_opportunity_auto_approve_for_run(
    app: &tauri::AppHandle,
    id: &str,
    agent_run_id: Option<&str>,
) -> Result<TradeOpportunitySummary, String> {
    let conn = open_database(app)?;
    let current = load_trade_opportunity(&conn, id)?;
    if current.conflict.is_some() {
        return Ok(current);
    }
    if current.status == "pending_blocked" {
        return Err("交易预检查已阻断，不能自动批准".to_string());
    }
    validate_opportunity_decision_context_for_auto_execution(&conn, &current)?;
    let changed = conn
        .execute(
            "UPDATE trade_opportunities SET status='approved',updated_at=?3
             WHERE id=?1 AND status='pending'
               AND (?2 IS NULL OR agent_run_id=?2 OR source_session_id=?2)",
            params![id, agent_run_id, now_ms()],
        )
        .map_err(|err| err.to_string())?;
    if changed == 0 && current.status != "approved" {
        return Err("交易机会的 Agent Run 归属不匹配，不能自动批准".to_string());
    }
    load_trade_opportunity(&conn, id)
}

#[tauri::command]
pub async fn trade_opportunity_approve(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, MarketRuntime>,
    id: String,
) -> Result<TradeOpportunitySummary, String> {
    execute_trade_opportunity(app, runtime, id, true).await
}

#[tauri::command]
pub fn trade_opportunity_reject(
    app: tauri::AppHandle,
    id: String,
) -> Result<TradeOpportunitySummary, String> {
    let conn = open_database(&app)?;
    update_trade_opportunity_status(&conn, &id, "rejected", None, None, None, None, None)?;
    load_trade_opportunity(&conn, &id)
}

async fn build_trade_opportunity(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, MarketRuntime>,
    request: TradeOpportunityCreateRequest,
    initial_status: &str,
    revision: i64,
    fingerprint: String,
    related_opportunity_id: Option<String>,
    duplicate_resolution: Option<String>,
) -> Result<TradeOpportunitySummary, String> {
    let is_order_management = matches!(request.intent.as_str(), "cancel" | "amend");
    let ticket_mode = if is_order_management {
        "manage"
    } else if request.intent == "close" {
        "close"
    } else {
        "open"
    }
    .to_string();
    let action = if is_order_management {
        request.intent.clone()
    } else {
        match (request.intent.as_str(), request.direction.as_str()) {
            ("open", "long") => "long",
            ("open", "short") => "short",
            ("close", "long") => "close-long",
            ("close", "short") => "close-short",
            _ => return Err("交易方向无效".to_string()),
        }
        .to_string()
    };
    let lever = request
        .lever
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "1".to_string());
    let market_snapshot_json = Some(capture_trade_opportunity_market_snapshot(
        &runtime,
        &request.inst_id,
    ));
    let precheck = if is_order_management {
        TradePrecheckResponse {
            ok: true,
            blocked: false,
            reasons: vec![],
            warnings: vec!["订单管理型机会：执行时复用撤单/改单链路，不预占新增保证金".to_string()],
            notional: None,
            estimated_margin: None,
            max_single_trade_margin_pct: None,
            max_single_trade_margin: None,
            max_single_trade_notional: None,
            max_single_trade_size: None,
            estimated_fee: None,
            usdt_equity: None,
            stop_price: None,
            stop_distance: None,
            estimated_stop_loss: None,
            estimated_round_trip_fee: None,
            estimated_stop_loss_with_fees: None,
            stop_loss_pct_of_usdt_equity: None,
            break_even_price: None,
            estimated_net_profit_at_target: None,
            fee_drag_pct_of_gross_profit: None,
            net_reward_risk_ratio: None,
            fee_rate_source: "not-applicable".to_string(),
            perpetual_evaluation: None,
            liquidation_text: String::new(),
            available_usdt: None,
            long_available: None,
            short_available: None,
            normalized_price: None,
            normalized_size: None,
            instrument: None,
            account_config: None,
            fee: None,
            max_order: None,
            leverage_info: None,
            position_tier: None,
            timing: None,
            source: "order_management_opportunity".to_string(),
        }
    } else {
        let price = request.price.clone().unwrap_or_default();
        let stop_price = request
            .stop_loss
            .as_ref()
            .and_then(|order| order.trigger_px.clone())
            .or_else(|| request.invalidation_price.clone());
        let precheck_request = TradePrecheckRequest {
            account_id: request.account_id.clone(),
            inst_id: request.inst_id.clone(),
            td_mode: request.td_mode.clone(),
            order_type: request.order_type.clone(),
            ticket_mode: ticket_mode.clone(),
            action: Some(action.clone()),
            price,
            stop_price,
            target_price: request
                .take_profit
                .as_ref()
                .and_then(|order| order.trigger_px.clone()),
            atr: None,
            size: request.size.clone(),
            lever: lever.clone(),
            environment: request.environment.clone(),
            max_single_trade_margin_pct: request.max_single_trade_margin_pct,
        };
        trade_precheck(app.clone(), precheck_request, runtime).await?
    };
    let status = if precheck.blocked {
        "pending_blocked"
    } else {
        initial_status
    }
    .to_string();
    let now = now_ms();
    let origin_type = optional_string(request.origin_type.clone()).unwrap_or_else(|| {
        if request.strategy_id.is_some() {
            "strategy".to_string()
        } else if request.source_session_id.is_some() {
            "ai".to_string()
        } else {
            "manual".to_string()
        }
    });
    let expires_at = request
        .expires_at
        .or_else(|| Some(now.saturating_add(15 * 60_000)));
    Ok(TradeOpportunitySummary {
        id: new_trade_opportunity_id(now, &fingerprint),
        account_id: request.account_id,
        environment: request.environment,
        inst_id: request.inst_id,
        td_mode: request.td_mode,
        intent: request.intent,
        exit_kind: optional_string(request.exit_kind),
        close_fraction: optional_string(request.close_fraction),
        direction: request.direction,
        ticket_mode,
        action,
        order_type: request.order_type,
        price: optional_string(request.price),
        size: request.size,
        lever: Some(lever),
        entry_condition: optional_string(request.entry_condition),
        take_profit: request.take_profit,
        stop_loss: request.stop_loss,
        invalidation_price: optional_string(request.invalidation_price),
        max_slippage_bps: request.max_slippage_bps,
        confidence: request.confidence,
        time_horizon: optional_string(request.time_horizon),
        strategy_name: optional_string(request.strategy_name),
        evidence: request.evidence.unwrap_or_default(),
        risk_notes: request.risk_notes.unwrap_or_default(),
        reason: request.reason,
        source_session_id: request.source_session_id,
        origin_type,
        strategy_kind: optional_string(request.strategy_kind),
        strategy_id: optional_string(request.strategy_id),
        strategy_version_id: optional_string(request.strategy_version_id),
        strategy_run_id: optional_string(request.strategy_run_id),
        signal_id: optional_string(request.signal_id),
        factor_pool_version_id: optional_string(request.factor_pool_version_id),
        revision,
        fingerprint,
        expires_at,
        agent_profile_id: optional_string(request.agent_profile_id),
        agent_run_id: optional_string(request.agent_run_id),
        related_opportunity_id,
        duplicate_resolution,
        duplicate_resolution_reason: optional_string(request.duplicate_resolution_reason),
        decision_context_id: optional_string(request.decision_context_id),
        execution_key: None,
        status,
        estimated_margin: precheck.estimated_margin,
        estimated_fee: precheck.estimated_fee,
        available_usdt: precheck.available_usdt,
        market_snapshot_json,
        precheck_json: Some(json!(&precheck)),
        execution_result_json: None,
        order_id: optional_string(request.order_id),
        client_order_id: optional_string(request.client_order_id),
        algo_id: optional_string(request.algo_id),
        algo_client_order_id: optional_string(request.algo_client_order_id),
        error: if precheck.blocked {
            Some(precheck.reasons.join("；"))
        } else {
            None
        },
        created_at: now,
        updated_at: now,
        conflict: None,
    })
}

pub(crate) fn capture_trade_opportunity_market_snapshot(
    runtime: &MarketRuntime,
    inst_id: &str,
) -> serde_json::Value {
    let store = runtime
        .store
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let ticker = store.tickers.get(inst_id).cloned().or_else(|| {
        store
            .ticker
            .as_ref()
            .filter(|item| item.inst_id == inst_id)
            .cloned()
    });
    let orderbook = store
        .orderbooks
        .get(inst_id)
        .cloned()
        .or_else(|| {
            (store.orderbook_inst_id.as_deref() == Some(inst_id))
                .then(|| store.orderbook.clone())
                .flatten()
        })
        .map(|mut book| {
            // 机会复盘只需要盘口形态，限制档数避免单条记录无限膨胀。
            book.bids.truncate(20);
            book.asks.truncate(20);
            book
        });
    let mut recent_trades = store
        .trades_by_inst
        .get(inst_id)
        .cloned()
        .or_else(|| {
            (store.trades_inst_id.as_deref() == Some(inst_id)).then(|| store.trades.clone())
        })
        .unwrap_or_default();
    if recent_trades.len() > 50 {
        recent_trades = recent_trades.split_off(recent_trades.len() - 50);
    }
    let candles = store
        .candles
        .iter()
        .filter_map(|(key, candle)| {
            key.strip_prefix(&format!("{}:", inst_id))
                .map(|bar| (bar.to_string(), candle.clone()))
        })
        .collect::<HashMap<_, _>>();
    let funding_rate = store.funding_rates.get(inst_id).cloned();
    json!({
        "capturedAt": now_ms(),
        "source": "wss_memory",
        "instId": inst_id,
        "ticker": ticker,
        "orderbook": orderbook,
        "recentTrades": recent_trades,
        "candles": candles,
        "fundingRate": funding_rate
    })
}

async fn execute_trade_opportunity(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, MarketRuntime>,
    id: String,
    confirmed_live: bool,
) -> Result<TradeOpportunitySummary, String> {
    let conn = open_database(&app)?;
    let mut opportunity = load_trade_opportunity(&conn, &id)?;
    if opportunity.status == "executed" {
        return Ok(opportunity);
    }
    if opportunity
        .expires_at
        .is_some_and(|expires_at| expires_at <= now_ms())
    {
        update_trade_opportunity_status(&conn, &id, "expired", None, None, None, None, None)?;
        return Err("交易机会已过期，需要重新分析并创建新修订".to_string());
    }
    if matches!(
        opportunity.status.as_str(),
        "pending_blocked" | "failed" | "rejected" | "cancelled" | "expired"
    ) {
        return Err(format!("当前交易机会状态不能执行：{}", opportunity.status));
    }
    let execution_key = opportunity
        .execution_key
        .clone()
        .unwrap_or_else(|| trade_opportunity_execution_key(&opportunity));
    let affected = conn
        .execute(
            "UPDATE trade_opportunities
             SET status = 'executing', execution_key = ?2, updated_at = ?3
             WHERE id = ?1
               AND status IN ('pending', 'approved')
               AND (expires_at IS NULL OR expires_at > ?3)",
            params![id, execution_key, now_ms()],
        )
        .map_err(|err| err.to_string())?;
    if affected != 1 {
        let current = load_trade_opportunity(&conn, &id)?;
        if current.status == "executed" {
            return Ok(current);
        }
        return Err(format!(
            "交易机会状态已变化，不能重复执行：{}",
            current.status
        ));
    }
    opportunity.status = "executing".to_string();
    opportunity.execution_key = Some(execution_key.clone());
    drop(conn);

    let operator = match opportunity.origin_type.as_str() {
        "strategy" => "strategy",
        "ai" => "ai",
        "system" => "system",
        _ => "user",
    };
    let attribution_strategy_id = opportunity
        .strategy_id
        .clone()
        .or_else(|| Some(opportunity.id.clone()));
    let attribution_session_id = opportunity
        .source_session_id
        .clone()
        .or_else(|| opportunity.strategy_run_id.clone());
    let mut execution = Vec::<serde_json::Value>::new();
    let main_result = if opportunity.intent == "cancel" {
        let cancel_request = CancelOrderRequest {
            account_id: opportunity.account_id.clone(),
            environment: opportunity.environment.clone(),
            inst_id: opportunity.inst_id.clone(),
            confirmed_live: Some(true),
            ord_id: opportunity.order_id.clone(),
            cl_ord_id: opportunity.client_order_id.clone(),
            is_algo: Some(
                opportunity.algo_id.is_some() || opportunity.algo_client_order_id.is_some(),
            ),
            algo_id: opportunity.algo_id.clone(),
            algo_cl_ord_id: opportunity.algo_client_order_id.clone(),
            operator: Some(operator.to_string()),
            opportunity_id: Some(opportunity.id.clone()),
            agent_run_id: opportunity
                .agent_run_id
                .clone()
                .or_else(|| opportunity.source_session_id.clone()),
            reason: Some(opportunity.reason.clone()),
        };
        okx_cancel_order(runtime.clone(), app.clone(), cancel_request)
            .await
            .map(|result| PlaceOrderResponse {
                ord_id: result.ord_id,
                cl_ord_id: result.cl_ord_id,
                s_code: result.s_code,
                s_msg: result.s_msg,
                ts: result.ts,
                side: "cancel".to_string(),
                pos_side: opportunity.direction.clone(),
                reduce_only: false,
                operator: operator.to_string(),
                strategy_id: attribution_strategy_id.clone(),
                session_id: attribution_session_id.clone(),
                opportunity_id: Some(opportunity.id.clone()),
                agent_run_id: opportunity
                    .agent_run_id
                    .clone()
                    .or_else(|| opportunity.source_session_id.clone()),
                execution_key: Some(execution_key.clone()),
            })
    } else if opportunity.intent == "amend" {
        let amend_request = AmendOrderRequest {
            account_id: opportunity.account_id.clone(),
            environment: opportunity.environment.clone(),
            inst_id: opportunity.inst_id.clone(),
            ord_id: opportunity.order_id.clone(),
            cl_ord_id: opportunity.client_order_id.clone(),
            new_size: optional_string(Some(opportunity.size.clone())),
            new_price: opportunity.price.clone(),
            confirmed_live: Some(confirmed_live),
            operator: Some(operator.to_string()),
            opportunity_id: Some(opportunity.id.clone()),
            opportunity_revision: Some(opportunity.revision),
            agent_run_id: opportunity
                .agent_run_id
                .clone()
                .or_else(|| opportunity.source_session_id.clone()),
            execution_key: Some(execution_key.clone()),
            execution_leg: Some("primary".to_string()),
            reason: Some(opportunity.reason.clone()),
        };
        okx_amend_order(app.clone(), runtime.clone(), amend_request)
            .await
            .map(|result| PlaceOrderResponse {
                ord_id: result.ord_id,
                cl_ord_id: result.cl_ord_id,
                s_code: result.s_code,
                s_msg: result.s_msg,
                ts: result.ts,
                side: "amend".to_string(),
                pos_side: opportunity.direction.clone(),
                reduce_only: false,
                operator: operator.to_string(),
                strategy_id: attribution_strategy_id.clone(),
                session_id: attribution_session_id.clone(),
                opportunity_id: Some(opportunity.id.clone()),
                agent_run_id: opportunity
                    .agent_run_id
                    .clone()
                    .or_else(|| opportunity.source_session_id.clone()),
                execution_key: Some(execution_key.clone()),
            })
    } else if opportunity.intent == "close"
        && opportunity.order_type == "market"
        && opportunity.size.trim().is_empty()
    {
        let close_request = ClosePositionRequest {
            account_id: opportunity.account_id.clone(),
            environment: opportunity.environment.clone(),
            inst_id: opportunity.inst_id.clone(),
            mgn_mode: opportunity.td_mode.clone(),
            pos_side: opportunity.direction.clone(),
            confirmed_live: Some(confirmed_live),
            operator: Some("ai".to_string()),
            opportunity_id: Some(opportunity.id.clone()),
            agent_run_id: opportunity
                .agent_run_id
                .clone()
                .or_else(|| opportunity.source_session_id.clone()),
            reason: Some(opportunity.reason.clone()),
        };
        okx_close_position_with_actor(
            app.clone(),
            runtime.clone(),
            close_request,
            operator,
            attribution_session_id.clone(),
        )
        .await
    } else {
        let order_request = PlaceOrderRequest {
            account_id: opportunity.account_id.clone(),
            inst_id: opportunity.inst_id.clone(),
            td_mode: opportunity.td_mode.clone(),
            order_type: opportunity.order_type.clone(),
            ticket_mode: opportunity.ticket_mode.clone(),
            action: opportunity.action.clone(),
            price: opportunity.price.clone().unwrap_or_default(),
            size: opportunity.size.clone(),
            lever: opportunity.lever.clone().unwrap_or_else(|| "1".to_string()),
            environment: opportunity.environment.clone(),
            confirmed_live: Some(confirmed_live),
            operator: Some(operator.to_string()),
            strategy_id: attribution_strategy_id.clone(),
            session_id: attribution_session_id,
            opportunity_id: Some(opportunity.id.clone()),
            opportunity_revision: Some(opportunity.revision),
            agent_run_id: opportunity
                .agent_run_id
                .clone()
                .or_else(|| opportunity.source_session_id.clone()),
            execution_key: Some(execution_key.clone()),
            algo_cl_ord_id: opportunity.algo_client_order_id.clone(),
            execution_leg: Some("primary".to_string()),
            reason: Some(opportunity.reason.clone()),
            attach_algo_ords: attached_algo_orders(&opportunity),
            order_spec_v2: None,
        };
        okx_place_order(app.clone(), runtime.clone(), order_request).await
    };

    match main_result {
        Ok(result) => {
            execution.push(json!({ "kind": "primary", "result": result }));
            if opportunity.intent == "cancel"
                && (opportunity.algo_id.is_some() || opportunity.algo_client_order_id.is_some())
            {
                opportunity.algo_id = optional_string(Some(result.ord_id.clone()));
                opportunity.algo_client_order_id = optional_string(Some(result.cl_ord_id.clone()));
            } else {
                opportunity.order_id = optional_string(Some(result.ord_id.clone()));
                opportunity.client_order_id = optional_string(Some(result.cl_ord_id.clone()));
            }
            if let Some(attached) = attached_algo_orders(&opportunity) {
                execution.push(json!({ "kind": "protective", "mode": "attachedAlgoOrds", "attachedAlgoOrds": attached }));
            }
            let conn = open_database(&app)?;
            update_trade_opportunity_status(
                &conn,
                &id,
                "executed",
                Some(json!(execution)),
                opportunity.order_id.as_deref(),
                opportunity.client_order_id.as_deref(),
                opportunity.algo_id.as_deref(),
                opportunity.algo_client_order_id.as_deref(),
            )?;
            load_trade_opportunity(&conn, &id)
        }
        Err(err) => {
            let conn = open_database(&app)?;
            update_trade_opportunity_status(
                &conn,
                &id,
                "failed",
                Some(json!({ "error": err })),
                None,
                None,
                None,
                None,
            )?;
            conn.execute(
                "UPDATE trade_opportunities SET error = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, err, now_ms()],
            )
            .map_err(|error| error.to_string())?;
            load_trade_opportunity(&conn, &id)
        }
    }
}

fn attached_algo_orders(opportunity: &TradeOpportunitySummary) -> Option<Vec<AttachedAlgoOrder>> {
    let has_tp = opportunity
        .take_profit
        .as_ref()
        .and_then(|item| optional_string(item.trigger_px.clone()))
        .is_some();
    let has_sl = opportunity
        .stop_loss
        .as_ref()
        .and_then(|item| optional_string(item.trigger_px.clone()))
        .is_some();
    if !has_tp && !has_sl {
        return None;
    }
    Some(vec![AttachedAlgoOrder {
        attach_algo_cl_ord_id: Some(format!(
            "dtatt{}{}",
            now_ms(),
            if has_tp && has_sl {
                "o"
            } else if has_tp {
                "t"
            } else {
                "s"
            }
        )),
        tp_trigger_px: opportunity
            .take_profit
            .as_ref()
            .and_then(|item| optional_string(item.trigger_px.clone())),
        tp_ord_px: opportunity
            .take_profit
            .as_ref()
            .and_then(|item| optional_string(item.order_px.clone()))
            .or_else(|| has_tp.then(|| "-1".to_string())),
        tp_ord_kind: None,
        tp_trigger_px_type: has_tp.then(|| {
            opportunity
                .take_profit
                .as_ref()
                .and_then(|item| optional_string(item.trigger_px_type.clone()))
                .unwrap_or_else(|| "last".to_string())
        }),
        sl_trigger_px: opportunity
            .stop_loss
            .as_ref()
            .and_then(|item| optional_string(item.trigger_px.clone())),
        sl_ord_px: opportunity
            .stop_loss
            .as_ref()
            .and_then(|item| optional_string(item.order_px.clone()))
            .or_else(|| has_sl.then(|| "-1".to_string())),
        sl_trigger_px_type: has_sl.then(|| {
            opportunity
                .stop_loss
                .as_ref()
                .and_then(|item| optional_string(item.trigger_px_type.clone()))
                .unwrap_or_else(|| "last".to_string())
        }),
        sz: Some(opportunity.size.clone()),
    }])
}

fn validate_trade_opportunity_request(
    request: &TradeOpportunityCreateRequest,
) -> Result<(), String> {
    let mut reasons = Vec::new();
    let is_order_management = matches!(request.intent.as_str(), "cancel" | "amend");
    if !matches!(request.environment.as_str(), "demo" | "live") {
        reasons.push("交易环境必须是 demo 或 live".to_string());
    }
    if !matches!(request.td_mode.as_str(), "cross" | "isolated") {
        reasons.push("保证金模式必须是 cross 或 isolated".to_string());
    }
    if !matches!(
        request.intent.as_str(),
        "open" | "close" | "cancel" | "amend"
    ) {
        reasons.push("intent 必须是 open、close、cancel 或 amend".to_string());
    }
    let exit_kind = optional_string(request.exit_kind.clone());
    if let Some(kind) = exit_kind.as_deref() {
        if !matches!(
            kind,
            "take_profit" | "stop_loss" | "strategy_exit" | "emergency"
        ) {
            reasons.push(
                "exitKind 必须是 take_profit、stop_loss、strategy_exit 或 emergency".to_string(),
            );
        }
    }
    if request.intent == "close" && exit_kind.is_none() {
        reasons
            .push("平仓机会必须提供 exitKind，用于区分止盈、止损、策略退出和紧急退出".to_string());
    }
    if request.intent != "close" && exit_kind.is_some() {
        reasons.push("exitKind 只能用于 intent=close".to_string());
    }
    if let Some(close_fraction) = optional_string(request.close_fraction.clone()) {
        let valid_fraction = close_fraction
            .parse::<f64>()
            .ok()
            .is_some_and(|value| value.is_finite() && value > 0.0 && value <= 1.0);
        if request.intent != "close" {
            reasons.push("closeFraction 只能用于 intent=close".to_string());
        } else if !valid_fraction {
            reasons.push("closeFraction 必须是大于 0 且不超过 1 的小数".to_string());
        }
    }
    if !is_order_management && !matches!(request.direction.as_str(), "long" | "short") {
        reasons.push("direction 必须是 long 或 short".to_string());
    }
    if !matches!(
        request.order_type.as_str(),
        "limit" | "market" | "trigger" | "cancel" | "amend"
    ) {
        reasons.push("orderType 必须是 limit、market、trigger、cancel 或 amend".to_string());
    }
    if request.inst_id.trim().is_empty() {
        reasons.push("instId 不能为空".to_string());
    }
    if request.reason.trim().is_empty() {
        reasons.push("reason 不能为空".to_string());
    }
    if is_order_management {
        let has_target = optional_string(request.order_id.clone()).is_some()
            || optional_string(request.client_order_id.clone()).is_some()
            || optional_string(request.algo_id.clone()).is_some()
            || optional_string(request.algo_client_order_id.clone()).is_some();
        if !has_target {
            reasons.push(
                "订单管理型机会必须提供 orderId、clientOrderId、algoId 或 algoClientOrderId"
                    .to_string(),
            );
        }
        if request.intent == "amend"
            && optional_string(request.price.clone()).is_none()
            && optional_string(Some(request.size.clone())).is_none()
        {
            reasons.push("改单机会必须提供 newPrice/price 或 newSize/size".to_string());
        }
    } else {
        if request
            .size
            .trim()
            .parse::<f64>()
            .map(|value| value <= 0.0)
            .unwrap_or(true)
        {
            reasons.push("size 必须是大于 0 的张数".to_string());
        }
        if request.order_type != "market" && optional_string(request.price.clone()).is_none() {
            reasons.push("限价或触发委托必须提供 price".to_string());
        }

        let has_take_profit = request
            .take_profit
            .as_ref()
            .and_then(|order| optional_string(order.trigger_px.clone()))
            .is_some();
        let has_stop_loss = request
            .stop_loss
            .as_ref()
            .and_then(|order| optional_string(order.trigger_px.clone()))
            .is_some();
        let has_attached_protection = has_take_profit || has_stop_loss;
        if request.intent == "close" {
            match (exit_kind.as_deref(), request.order_type.as_str()) {
                (Some("take_profit"), "trigger") => reasons.push(
                    "止盈平仓不能使用 trigger；请使用 limit，或目标已达到时使用 market".to_string(),
                ),
                (Some("stop_loss"), "limit") => reasons.push(
                    "止损平仓不能使用 limit；请使用 trigger，或立即退出时使用 market".to_string(),
                ),
                (Some("emergency"), "limit" | "trigger") => {
                    reasons.push("紧急退出必须使用 market".to_string())
                }
                _ => {}
            }
        }
        if request.intent == "close" && has_attached_protection {
            reasons.push(
                "平仓机会的限价或触发价就是退出条件，不能同时填写 takeProfit 或 stopLoss；请将保护价作为 price，并清空附加保护字段"
                    .to_string(),
            );
        } else if request.order_type == "trigger" && has_attached_protection {
            reasons.push(
                "计划委托暂不支持附加止盈止损；开仓计划请在成交后单独创建保护单，平仓计划请将退出价填写为 price"
                    .to_string(),
            );
        }
    }
    if request.expires_at.is_some_and(|value| value <= now_ms()) {
        reasons.push("expiresAt 必须晚于当前时间".to_string());
    }
    if reasons.is_empty() {
        Ok(())
    } else {
        Err(reasons.join("；"))
    }
}

fn trade_opportunity_fingerprint(
    request: &TradeOpportunityCreateRequest,
) -> Result<String, String> {
    let normalized = json!({
        "accountId": optional_string(request.account_id.clone()).unwrap_or_default(),
        "environment": request.environment.trim().to_ascii_lowercase(),
        "instId": request.inst_id.trim().to_ascii_uppercase(),
        "tdMode": request.td_mode.trim().to_ascii_lowercase(),
        "intent": request.intent.trim().to_ascii_lowercase(),
        "exitKind": request.exit_kind.as_deref().map(|value| value.trim().to_ascii_lowercase()).unwrap_or_default(),
        "closeFraction": request.close_fraction.as_deref().map(normalize_fingerprint_number).unwrap_or_default(),
        "direction": request.direction.trim().to_ascii_lowercase(),
        "size": normalize_fingerprint_number(&request.size),
        "orderType": request.order_type.trim().to_ascii_lowercase(),
        "price": request.price.as_deref().map(normalize_fingerprint_number).unwrap_or_default(),
        "orderId": optional_string(request.order_id.clone()).unwrap_or_default(),
        "clientOrderId": optional_string(request.client_order_id.clone()).unwrap_or_default(),
        "algoId": optional_string(request.algo_id.clone()).unwrap_or_default(),
        "algoClientOrderId": optional_string(request.algo_client_order_id.clone()).unwrap_or_default(),
        "newPrice": request.new_price.as_deref().map(normalize_fingerprint_number).unwrap_or_default(),
        "newSize": request.new_size.as_deref().map(normalize_fingerprint_number).unwrap_or_default(),
        "lever": request.lever.as_deref().map(normalize_fingerprint_number).unwrap_or_else(|| "1".to_string()),
        "entryCondition": optional_string(request.entry_condition.clone()).unwrap_or_default(),
        "strategyName": optional_string(request.strategy_name.clone())
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default(),
        "takeProfit": request.take_profit,
        "stopLoss": request.stop_loss,
        "invalidationPrice": request.invalidation_price.as_deref().map(normalize_fingerprint_number).unwrap_or_default(),
        "maxSlippageBps": request.max_slippage_bps,
    });
    let bytes = serde_json::to_vec(&normalized).map_err(|err| err.to_string())?;
    Ok(sha256_hex(&bytes))
}

fn normalize_fingerprint_number(value: &str) -> String {
    value
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
        .map(trim_float)
        .unwrap_or_else(|| value.trim().to_string())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn new_trade_opportunity_id(now: i64, fingerprint: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos())
        .unwrap_or_default();
    let suffix = fingerprint.get(..8).unwrap_or(fingerprint);
    format!("opp{now}{nanos:09}{suffix}")
}

fn expire_trade_opportunities(conn: &Connection, now: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE trade_opportunities
         SET status = 'expired', updated_at = ?1
         WHERE expires_at IS NOT NULL
           AND expires_at <= ?1
           AND status IN ('pending', 'approved', 'pending_blocked')",
        [now],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn same_active_close_exit(
    intent: &str,
    existing_exit_kind: Option<&str>,
    existing_size: &str,
    requested_exit_kind: Option<&str>,
    requested_size: &str,
) -> bool {
    intent == "close"
        && existing_exit_kind.is_some()
        && existing_exit_kind == requested_exit_kind
        && normalize_fingerprint_number(existing_size)
            == normalize_fingerprint_number(requested_size)
}

fn find_similar_trade_opportunity(
    conn: &Connection,
    request: &TradeOpportunityCreateRequest,
    fingerprint: &str,
    now: i64,
) -> Result<Option<TradeOpportunitySummary>, String> {
    let (window_minutes, entry_tolerance_bps) =
        similarity_settings(conn, request.agent_profile_id.as_deref());
    let cutoff = now.saturating_sub(i64::from(window_minutes) * 60_000);
    let mut stmt = conn
        .prepare(
        "SELECT * FROM trade_opportunities
         WHERE COALESCE(account_id, '') = ?1
           AND environment = ?2
           AND inst_id = ?3
           AND intent = ?4
           AND direction = ?5
           AND status IN ('pending', 'approved', 'executing', 'submitted', 'partially_filled', 'pending_blocked', 'recovery_blocked')
           AND (expires_at IS NULL OR expires_at > ?6)
           AND (status IN ('approved','executing','submitted','partially_filled','recovery_blocked') OR created_at >= ?7)
         ORDER BY CASE WHEN fingerprint = ?8 THEN 0 ELSE 1 END, created_at DESC
         LIMIT 50",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(
            params![
                optional_string(request.account_id.clone()).unwrap_or_default(),
                request.environment,
                request.inst_id,
                request.intent,
                request.direction,
                now,
                cutoff,
                fingerprint,
            ],
            trade_opportunity_from_row,
        )
        .map_err(|err| err.to_string())?;
    for row in rows {
        let candidate = row.map_err(|err| err.to_string())?;
        if let (Some(existing_strategy), Some(requested_strategy)) = (
            optional_string(candidate.strategy_name.clone()),
            optional_string(request.strategy_name.clone()),
        ) {
            if !existing_strategy.eq_ignore_ascii_case(&requested_strategy) {
                continue;
            }
        }
        if candidate.fingerprint == fingerprint {
            return Ok(Some(candidate));
        }
        if same_active_close_exit(
            request.intent.as_str(),
            candidate.exit_kind.as_deref(),
            &candidate.size,
            request.exit_kind.as_deref(),
            &request.size,
        ) {
            return Ok(Some(candidate));
        }
        if candidate.order_type != request.order_type {
            continue;
        }
        if let (Some(existing_price), Some(requested_price)) = (
            candidate
                .price
                .as_deref()
                .and_then(|value| value.parse::<f64>().ok()),
            request
                .price
                .as_deref()
                .and_then(|value| value.parse::<f64>().ok()),
        ) {
            if existing_price <= 0.0 || requested_price <= 0.0 {
                continue;
            }
            let distance_bps =
                ((existing_price - requested_price).abs() / existing_price) * 10_000.0;
            if distance_bps > f64::from(entry_tolerance_bps) {
                continue;
            }
        } else if candidate.order_type != "market" {
            continue;
        }
        return Ok(Some(candidate));
    }
    Ok(None)
}

fn similarity_settings(conn: &Connection, profile_id: Option<&str>) -> (u32, u32) {
    let Some(profile_id) = profile_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return (10, 30);
    };
    conn.query_row(
        "SELECT similarity_window_minutes,entry_tolerance_bps
         FROM ai_agent_profiles WHERE id=?1 AND deleted_at IS NULL",
        params![profile_id],
        |row| {
            Ok((
                row.get::<_, i64>(0)?.clamp(1, 1_440) as u32,
                row.get::<_, i64>(1)?.clamp(1, 2_000) as u32,
            ))
        },
    )
    .unwrap_or((10, 30))
}

fn trade_opportunity_conflict(
    existing: &TradeOpportunitySummary,
    requested_fingerprint: &str,
) -> TradeOpportunityConflict {
    let exact = existing.fingerprint == requested_fingerprint && !existing.fingerprint.is_empty();
    TradeOpportunityConflict {
        kind: if exact { "exact" } else { "similar" }.to_string(),
        reason: if exact {
            "存在参数完全相同且仍有效的交易机会".to_string()
        } else {
            "同一账户、环境、交易对和方向已有仍有效的交易机会".to_string()
        },
        existing_opportunity_id: existing.id.clone(),
        existing_revision: existing.revision,
        existing_fingerprint: existing.fingerprint.clone(),
        existing_status: existing.status.clone(),
        existing_expires_at: existing.expires_at,
        requested_fingerprint: requested_fingerprint.to_string(),
        allowed_resolutions: vec![
            "reuse".to_string(),
            "revise".to_string(),
            "create_new".to_string(),
        ],
    }
}

fn trade_opportunity_execution_key(opportunity: &TradeOpportunitySummary) -> String {
    format!(
        "opportunity:{}:revision:{}:{}:primary",
        opportunity.id, opportunity.revision, opportunity.action
    )
}

fn save_trade_opportunity(conn: &Connection, item: &TradeOpportunitySummary) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO trade_opportunities (
          id, account_id, environment, inst_id, td_mode, intent, direction, ticket_mode, action, order_type,
          price, size, lever, entry_condition, take_profit_json, stop_loss_json, invalidation_price,
          max_slippage_bps, confidence, time_horizon, strategy_name, evidence_json, risk_notes_json,
          reason, source_session_id, origin_type, strategy_kind, strategy_id, strategy_version_id,
          strategy_run_id, signal_id, factor_pool_version_id, revision, fingerprint, expires_at, agent_profile_id, agent_run_id,
          related_opportunity_id, duplicate_resolution, duplicate_resolution_reason, decision_context_id, execution_key, status, estimated_margin, estimated_fee, available_usdt, precheck_json,
          market_snapshot_json, execution_result_json, order_id, client_order_id, algo_id, algo_client_order_id, error, created_at, updated_at, exit_kind, close_fraction
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40, ?41, ?42, ?43, ?44, ?45, ?46, ?47, ?48, ?49, ?50, ?51, ?52, ?53, ?54, ?55, ?56, ?57, ?58)",
        params![
            item.id,
            item.account_id,
            item.environment,
            item.inst_id,
            item.td_mode,
            item.intent,
            item.direction,
            item.ticket_mode,
            item.action,
            item.order_type,
            item.price,
            item.size,
            item.lever,
            item.entry_condition,
            serde_json::to_string(&item.take_profit).map_err(|err| err.to_string())?,
            serde_json::to_string(&item.stop_loss).map_err(|err| err.to_string())?,
            item.invalidation_price,
            item.max_slippage_bps,
            item.confidence,
            item.time_horizon,
            item.strategy_name,
            serde_json::to_string(&item.evidence).map_err(|err| err.to_string())?,
            serde_json::to_string(&item.risk_notes).map_err(|err| err.to_string())?,
            item.reason,
            item.source_session_id,
            item.origin_type,
            item.strategy_kind,
            item.strategy_id,
            item.strategy_version_id,
            item.strategy_run_id,
            item.signal_id,
            item.factor_pool_version_id,
            item.revision,
            item.fingerprint,
            item.expires_at,
            item.agent_profile_id,
            item.agent_run_id,
            item.related_opportunity_id,
            item.duplicate_resolution,
            item.duplicate_resolution_reason,
            item.decision_context_id,
            item.execution_key,
            item.status,
            item.estimated_margin,
            item.estimated_fee,
            item.available_usdt,
            item.precheck_json.as_ref().map(|value| value.to_string()),
            item.market_snapshot_json.as_ref().map(|value| value.to_string()),
            item.execution_result_json.as_ref().map(|value| value.to_string()),
            item.order_id,
            item.client_order_id,
            item.algo_id,
            item.algo_client_order_id,
            item.error,
            item.created_at,
            item.updated_at,
            item.exit_kind,
            item.close_fraction,
        ],
    )
    .map_err(|err| err.to_string())?;
    let _ = crate::ai_automation::record_domain_event_with_conn(
        conn,
        &desic_agent_automation::DomainEvent {
            event_type: "opportunity_state_changed".to_string(),
            account_id: item.account_id.clone(),
            inst_id: Some(item.inst_id.clone()),
            opportunity_id: Some(item.id.clone()),
            state: Some(item.status.clone()),
            occurred_at: item.updated_at,
            ..Default::default()
        },
        json!({ "revision": item.revision, "relatedOpportunityId": item.related_opportunity_id }),
    );
    Ok(())
}

fn list_trade_opportunities(conn: &Connection) -> Result<Vec<TradeOpportunitySummary>, String> {
    let mut stmt = conn
        .prepare("SELECT * FROM trade_opportunities ORDER BY created_at DESC LIMIT 200")
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], trade_opportunity_from_row)
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn detach_trade_opportunity_references(conn: &Connection, id: Option<&str>) -> Result<(), String> {
    match id {
        Some(id) => {
            conn.execute(
                "DELETE FROM trade_opportunity_resolution_events WHERE opportunity_id=?1 OR related_opportunity_id=?1",
                params![id],
            )
            .map_err(|err| err.to_string())?;
            conn.execute(
                "DELETE FROM position_episode_opportunities WHERE opportunity_id=?1",
                params![id],
            )
            .map_err(|err| err.to_string())?;
            for sql in [
                "UPDATE okx_orders SET opportunity_id=NULL WHERE opportunity_id=?1",
                "UPDATE okx_fills SET opportunity_id=NULL WHERE opportunity_id=?1",
                "UPDATE trade_audit_events SET opportunity_id=NULL WHERE opportunity_id=?1",
                "UPDATE trade_execution_attempts SET opportunity_id=NULL WHERE opportunity_id=?1",
                "UPDATE position_episodes SET opportunity_id=NULL WHERE opportunity_id=?1",
                "UPDATE position_episode_events SET opportunity_id=NULL WHERE opportunity_id=?1",
                "UPDATE trade_opportunities SET related_opportunity_id=NULL WHERE related_opportunity_id=?1",
            ] {
                conn.execute(sql, params![id]).map_err(|err| err.to_string())?;
            }
        }
        None => {
            conn.execute("DELETE FROM trade_opportunity_resolution_events", [])
                .map_err(|err| err.to_string())?;
            conn.execute("DELETE FROM position_episode_opportunities", [])
                .map_err(|err| err.to_string())?;
            for sql in [
                "UPDATE okx_orders SET opportunity_id=NULL",
                "UPDATE okx_fills SET opportunity_id=NULL",
                "UPDATE trade_audit_events SET opportunity_id=NULL",
                "UPDATE trade_execution_attempts SET opportunity_id=NULL",
                "UPDATE position_episodes SET opportunity_id=NULL",
                "UPDATE position_episode_events SET opportunity_id=NULL",
                "UPDATE trade_opportunities SET related_opportunity_id=NULL",
            ] {
                conn.execute(sql, []).map_err(|err| err.to_string())?;
            }
        }
    }
    Ok(())
}

fn load_trade_opportunity(conn: &Connection, id: &str) -> Result<TradeOpportunitySummary, String> {
    conn.query_row(
        "SELECT * FROM trade_opportunities WHERE id = ?1",
        params![id],
        trade_opportunity_from_row,
    )
    .map_err(|err| err.to_string())
}

fn update_trade_opportunity_status(
    conn: &Connection,
    id: &str,
    status: &str,
    execution_result: Option<serde_json::Value>,
    order_id: Option<&str>,
    client_order_id: Option<&str>,
    algo_id: Option<&str>,
    algo_client_order_id: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE trade_opportunities
         SET status = ?2,
             execution_result_json = COALESCE(?3, execution_result_json),
             order_id = COALESCE(?4, order_id),
             client_order_id = COALESCE(?5, client_order_id),
             algo_id = COALESCE(?6, algo_id),
             algo_client_order_id = COALESCE(?7, algo_client_order_id),
             updated_at = ?8
         WHERE id = ?1",
        params![
            id,
            status,
            execution_result.map(|value| value.to_string()),
            order_id,
            client_order_id,
            algo_id,
            algo_client_order_id,
            now_ms()
        ],
    )
    .map_err(|err| err.to_string())?;
    if let Ok((account_id, inst_id)) = conn.query_row(
        "SELECT account_id,inst_id FROM trade_opportunities WHERE id=?1",
        params![id],
        |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
    ) {
        let _ = crate::ai_automation::record_domain_event_with_conn(
            conn,
            &desic_agent_automation::DomainEvent {
                event_type: "opportunity_state_changed".to_string(),
                account_id,
                inst_id: Some(inst_id),
                opportunity_id: Some(id.to_string()),
                state: Some(status.to_string()),
                occurred_at: now_ms(),
                ..Default::default()
            },
            json!({}),
        );
    }
    Ok(())
}

fn trade_opportunity_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<TradeOpportunitySummary> {
    let take_profit_json: Option<String> = row.get("take_profit_json")?;
    let stop_loss_json: Option<String> = row.get("stop_loss_json")?;
    let evidence_json: Option<String> = row.get("evidence_json")?;
    let risk_notes_json: Option<String> = row.get("risk_notes_json")?;
    let precheck_json: Option<String> = row.get("precheck_json")?;
    let market_snapshot_json: Option<String> = row.get("market_snapshot_json")?;
    let execution_result_json: Option<String> = row.get("execution_result_json")?;
    Ok(TradeOpportunitySummary {
        id: row.get("id")?,
        account_id: row.get("account_id")?,
        environment: row.get("environment")?,
        inst_id: row.get("inst_id")?,
        td_mode: row.get("td_mode")?,
        intent: row.get("intent")?,
        exit_kind: row.get("exit_kind")?,
        close_fraction: row.get("close_fraction")?,
        direction: row.get("direction")?,
        ticket_mode: row.get("ticket_mode")?,
        action: row.get("action")?,
        order_type: row.get("order_type")?,
        price: row.get("price")?,
        size: row.get("size")?,
        lever: row.get("lever")?,
        entry_condition: row.get("entry_condition")?,
        take_profit: take_profit_json
            .and_then(|value| serde_json::from_str(&value).ok())
            .flatten(),
        stop_loss: stop_loss_json
            .and_then(|value| serde_json::from_str(&value).ok())
            .flatten(),
        invalidation_price: row.get("invalidation_price")?,
        max_slippage_bps: row.get("max_slippage_bps")?,
        confidence: row.get("confidence")?,
        time_horizon: row.get("time_horizon")?,
        strategy_name: row.get("strategy_name")?,
        evidence: evidence_json
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or_default(),
        risk_notes: risk_notes_json
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or_default(),
        reason: row.get("reason")?,
        source_session_id: row.get("source_session_id")?,
        origin_type: row.get("origin_type")?,
        strategy_kind: row.get("strategy_kind")?,
        strategy_id: row.get("strategy_id")?,
        strategy_version_id: row.get("strategy_version_id")?,
        strategy_run_id: row.get("strategy_run_id")?,
        signal_id: row.get("signal_id")?,
        factor_pool_version_id: row.get("factor_pool_version_id")?,
        revision: row.get("revision")?,
        fingerprint: row
            .get::<_, Option<String>>("fingerprint")?
            .unwrap_or_default(),
        expires_at: row.get("expires_at")?,
        agent_profile_id: row.get("agent_profile_id")?,
        agent_run_id: row.get("agent_run_id")?,
        related_opportunity_id: row.get("related_opportunity_id")?,
        duplicate_resolution: row.get("duplicate_resolution")?,
        duplicate_resolution_reason: row.get("duplicate_resolution_reason")?,
        decision_context_id: row.get("decision_context_id")?,
        execution_key: row.get("execution_key")?,
        status: row.get("status")?,
        estimated_margin: row.get("estimated_margin")?,
        estimated_fee: row.get("estimated_fee")?,
        available_usdt: row.get("available_usdt")?,
        market_snapshot_json: market_snapshot_json
            .and_then(|value| serde_json::from_str(&value).ok()),
        precheck_json: precheck_json.and_then(|value| serde_json::from_str(&value).ok()),
        execution_result_json: execution_result_json
            .and_then(|value| serde_json::from_str(&value).ok()),
        order_id: row.get("order_id")?,
        client_order_id: row.get("client_order_id")?,
        algo_id: row.get("algo_id")?,
        algo_client_order_id: row.get("algo_client_order_id")?,
        error: row.get("error")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        conflict: None,
    })
}

fn optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|item| {
        let trimmed = item.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn validate_algo_request(
    request: &PlaceAlgoOrderRequest,
    instrument: &OkxInstrument,
    pos_mode: &str,
) -> Result<(), String> {
    let mut reasons = Vec::new();
    if !instrument.inst_type.eq_ignore_ascii_case("SWAP") {
        reasons.push("当前只支持 OKX 永续合约 SWAP".to_string());
    }
    if !matches!(request.td_mode.as_str(), "cross" | "isolated") {
        reasons.push("保证金模式必须是 cross 或 isolated".to_string());
    }
    if !matches!(request.ord_type.as_str(), "conditional" | "oco") {
        reasons.push("策略类型必须是 conditional 或 oco".to_string());
    }
    if !matches!(request.side.as_str(), "buy" | "sell") {
        reasons.push("策略方向必须是 buy 或 sell".to_string());
    }
    if !matches!(request.pos_side.as_str(), "long" | "short" | "net") {
        reasons.push("持仓方向必须是 long、short 或 net".to_string());
    }
    match pos_mode {
        "net_mode" => {
            if request.pos_side != "net" {
                reasons.push("单向持仓模式的保护性策略单必须使用 posSide=net".to_string());
            }
        }
        "long_short_mode" => {
            if !matches!(
                (request.side.as_str(), request.pos_side.as_str()),
                ("sell", "long") | ("buy", "short")
            ) {
                reasons.push(
                    "双向持仓模式的保护性策略单只允许 sell+long 平多或 buy+short 平空".to_string(),
                );
            }
        }
        _ => reasons.push("OKX 账户持仓模式无效，已阻止提交保护性策略单".to_string()),
    }
    let has_tp = optional_non_empty(&request.tp_trigger_px).is_some()
        || optional_non_empty(&request.tp_ord_px).is_some();
    let has_sl = optional_non_empty(&request.sl_trigger_px).is_some()
        || optional_non_empty(&request.sl_ord_px).is_some();
    if !has_tp && !has_sl {
        reasons.push("至少需要设置止盈或止损".to_string());
    }
    if has_tp
        && (optional_non_empty(&request.tp_trigger_px).is_none()
            || optional_non_empty(&request.tp_ord_px).is_none())
    {
        reasons.push("止盈需要同时填写触发价和委托价".to_string());
    }
    if has_sl
        && (optional_non_empty(&request.sl_trigger_px).is_none()
            || optional_non_empty(&request.sl_ord_px).is_none())
    {
        reasons.push("止损需要同时填写触发价和委托价".to_string());
    }
    if request.ord_type == "oco" && (!has_tp || !has_sl) {
        reasons.push("双向止盈止损需要同时填写止盈和止损".to_string());
    }
    let size = request.size.trim().parse::<f64>().ok();
    let min_size = parse_optional_f64(&instrument.min_sz);
    let lot_size = parse_optional_f64(&instrument.lot_sz);
    if !matches!(size, Some(value) if value > 0.0) {
        reasons.push("请输入策略委托张数".to_string());
    }
    if let (Some(size), Some(min_size)) = (size, min_size) {
        if size < min_size {
            reasons.push(format!("策略委托张数低于最小值 {}", trim_float(min_size)));
        }
    }
    if let (Some(size), Some(lot_size)) = (size, lot_size) {
        if !is_multiple_of(size, lot_size) {
            reasons.push(format!(
                "策略委托张数必须是 lotSz {} 的整数倍",
                trim_float(lot_size)
            ));
        }
    }
    if reasons.is_empty() {
        Ok(())
    } else {
        Err(format!("策略委托校验未通过：{}", reasons.join("；")))
    }
}

fn normalize_position_side(value: &str) -> String {
    match value {
        "short" => "short".to_string(),
        "net" => "net".to_string(),
        _ => "long".to_string(),
    }
}

fn parse_optional_i64_local(value: &str) -> Option<i64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed.parse::<i64>().ok()
}

fn decorate_algo_order(
    mut order: AlgoOrderSummary,
    account: &LocalAccount,
    source_endpoint: &str,
) -> AlgoOrderSummary {
    order.account_id = account.id.clone();
    order.environment = account.environment.clone();
    order.operator = if order.operator.trim().is_empty() {
        "user".to_string()
    } else {
        order.operator
    };
    order.source_endpoint = source_endpoint.to_string();
    order
}

fn upsert_submitted_tpsl_algo_order(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    request: &PlaceAlgoOrderRequest,
    body: &PlaceTpSlAlgoBody,
    result: &OkxAlgoOrderResult,
    operator: &str,
) -> Result<(), String> {
    let conn = open_database(app)?;
    insert_missing_submitted_tpsl_algo_order_with_conn(
        &conn, account, request, body, result, operator,
    )
}

fn insert_missing_submitted_tpsl_algo_order_with_conn(
    conn: &Connection,
    account: &LocalAccount,
    request: &PlaceAlgoOrderRequest,
    body: &PlaceTpSlAlgoBody,
    result: &OkxAlgoOrderResult,
    operator: &str,
) -> Result<(), String> {
    let ord_id = if result.algo_id.trim().is_empty() {
        result.algo_cl_ord_id.clone()
    } else {
        result.algo_id.clone()
    };
    if ord_id.trim().is_empty() {
        return Ok(());
    }
    let now = now_ms();
    let raw_json = private_exchange_json(
        &json!({ "submitRequest": request, "okxBody": body, "okxResult": result }),
    )?;
    conn.execute(
        "INSERT INTO okx_orders (
          account_id, environment, ord_id, cl_ord_id, inst_id, inst_type, side, pos_side, td_mode, ord_type,
          state, px, sz, acc_fill_sz, avg_px, pnl, fee, source_endpoint, operator, strategy_id,
          session_id, okx_ctime, okx_utime, raw_json, synced_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'SWAP', ?6, ?7, ?8, ?9, 'submitted', ?10, ?11, '0', NULL, NULL, NULL, 'local-algo-submit', ?12, ?13, ?14, ?15, ?16, ?17, ?18)
        ON CONFLICT(account_id, environment, ord_id) DO NOTHING",
        params![
            account.id,
            account.environment,
            ord_id,
            result.algo_cl_ord_id,
            request.inst_id,
            request.side,
            request.pos_side,
            request.td_mode,
            request.ord_type,
            body.tp_trigger_px.as_deref().or(body.sl_trigger_px.as_deref()).unwrap_or(""),
            request.size,
            operator,
            optional_non_empty(&request.strategy_id),
            optional_non_empty(&request.session_id),
            result.ts.parse::<i64>().ok().unwrap_or(now),
            now,
            raw_json,
            now,
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn upsert_algo_order_summaries(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    orders: &[AlgoOrderSummary],
) -> Result<(), String> {
    let conn = open_database(app)?;
    for order in orders {
        let ord_id = if !order.algo_id.trim().is_empty() {
            order.algo_id.clone()
        } else {
            order.algo_cl_ord_id.clone()
        };
        if ord_id.trim().is_empty() {
            continue;
        }
        conn.execute(
            "INSERT INTO okx_orders (
              account_id, environment, ord_id, cl_ord_id, inst_id, inst_type, side, pos_side, td_mode, ord_type,
              state, px, sz, acc_fill_sz, avg_px, pnl, fee, source_endpoint, operator, strategy_id,
              session_id, okx_ctime, okx_utime, raw_json, synced_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL, NULL, NULL, ?15, 'user', NULL, NULL, ?16, ?17, ?18, ?19)
            ON CONFLICT(account_id, environment, ord_id) DO UPDATE SET
              cl_ord_id=COALESCE(excluded.cl_ord_id, okx_orders.cl_ord_id),
              inst_id=excluded.inst_id,
              inst_type=excluded.inst_type,
              side=excluded.side,
              pos_side=excluded.pos_side,
              td_mode=excluded.td_mode,
              ord_type=excluded.ord_type,
              state=excluded.state,
              px=excluded.px,
              sz=excluded.sz,
              acc_fill_sz=excluded.acc_fill_sz,
              source_endpoint=excluded.source_endpoint,
              okx_ctime=COALESCE(okx_orders.okx_ctime, excluded.okx_ctime),
              okx_utime=excluded.okx_utime,
              raw_json=excluded.raw_json,
              synced_at=excluded.synced_at",
            params![
                account.id,
                account.environment,
                ord_id,
                order.algo_cl_ord_id,
                order.inst_id,
                if order.inst_type.trim().is_empty() { "SWAP" } else { &order.inst_type },
                order.side,
                order.pos_side,
                order.td_mode,
                order.ord_type,
                order.state,
                if !order.trigger_px.trim().is_empty() {
                    &order.trigger_px
                } else if !order.tp_trigger_px.trim().is_empty() {
                    &order.tp_trigger_px
                } else {
                    &order.sl_trigger_px
                },
                order.sz,
                order.actual_sz,
                order.source_endpoint,
                parse_optional_i64_local(&order.c_time).unwrap_or_else(now_ms),
                parse_optional_i64_local(&order.u_time).unwrap_or_else(now_ms),
                serde_json::to_string(order).unwrap_or_default(),
                now_ms(),
            ],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod idempotency_tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::Barrier;

    #[test]
    fn algo_order_queries_cover_every_supported_tab_category() {
        let order_types = ALGO_ORDER_TYPE_GROUPS
            .iter()
            .flat_map(|group| group.split(','))
            .collect::<HashSet<_>>();
        assert_eq!(
            order_types,
            HashSet::from([
                "conditional",
                "oco",
                "trigger",
                "move_order_stop",
                "iceberg",
                "twap",
            ])
        );
        assert!(!OPTIONAL_ALGO_ORDER_TYPE_GROUPS.contains(&"conditional,oco"));
        assert!(!OPTIONAL_ALGO_ORDER_TYPE_GROUPS.contains(&"trigger"));
        assert!(OPTIONAL_ALGO_ORDER_TYPE_GROUPS.contains(&"move_order_stop"));
        assert!(OPTIONAL_ALGO_ORDER_TYPE_GROUPS.contains(&"iceberg,twap"));
    }

    #[test]
    fn algo_order_summary_preserves_trigger_and_trailing_prices() {
        let order = serde_json::from_value::<AlgoOrderSummary>(json!({
            "algoId": "algo-trigger-1",
            "instId": "BTC-USDT-SWAP",
            "ordType": "trigger",
            "triggerPx": "65000",
            "triggerPxType": "last",
            "ordPx": "-1"
        }))
        .expect("parse trigger algo order");
        assert_eq!(order.trigger_px, "65000");
        assert_eq!(order.trigger_px_type, "last");
        assert_eq!(order.ord_px, "-1");

        let trailing = serde_json::from_value::<AlgoOrderSummary>(json!({
            "algoId": "algo-trailing-1",
            "instId": "BTC-USDT-SWAP",
            "ordType": "move_order_stop",
            "activePx": "64000",
            "callbackRatio": "1.5",
            "callbackSpread": ""
        }))
        .expect("parse trailing algo order");
        assert_eq!(trailing.active_px, "64000");
        assert_eq!(trailing.callback_ratio, "1.5");
        assert!(trailing.callback_spread.is_empty());
    }

    fn place_request(order_type: &str) -> PlaceOrderRequest {
        PlaceOrderRequest {
            account_id: Some("account-demo".to_string()),
            inst_id: "BTC-USDT-SWAP".to_string(),
            td_mode: "cross".to_string(),
            order_type: order_type.to_string(),
            ticket_mode: "open".to_string(),
            action: "long".to_string(),
            price: "65000".to_string(),
            size: "1".to_string(),
            lever: "10".to_string(),
            environment: "demo".to_string(),
            confirmed_live: None,
            operator: Some("user".to_string()),
            strategy_id: None,
            session_id: None,
            opportunity_id: None,
            opportunity_revision: None,
            agent_run_id: None,
            execution_key: Some("manual-order-1".to_string()),
            algo_cl_ord_id: None,
            execution_leg: None,
            reason: Some("test".to_string()),
            attach_algo_ords: None,
            order_spec_v2: None,
        }
    }

    fn place_algo_request() -> PlaceAlgoOrderRequest {
        PlaceAlgoOrderRequest {
            account_id: Some("account-demo".to_string()),
            environment: "demo".to_string(),
            inst_id: "BTC-USDT-SWAP".to_string(),
            td_mode: "cross".to_string(),
            pos_side: "long".to_string(),
            side: "sell".to_string(),
            ord_type: "conditional".to_string(),
            size: "2".to_string(),
            tp_trigger_px: Some("66000".to_string()),
            tp_ord_px: Some("-1".to_string()),
            sl_trigger_px: None,
            sl_ord_px: None,
            confirmed_live: None,
            operator: Some("user".to_string()),
            strategy_id: Some("strategy-placeholder".to_string()),
            session_id: Some("session-placeholder".to_string()),
            execution_key: Some("algo-place-key-1".to_string()),
        }
    }

    #[test]
    fn limit_take_profit_is_encoded_as_a_limit_tp_order() {
        let mut request = place_algo_request();
        request.tp_ord_px = Some("66000".to_string());
        let body = place_algo_body(&request, "algo-client-limit-tp");
        assert_eq!(body.tp_ord_kind.as_deref(), Some("limit"));
        assert_eq!(body.tp_ord_px.as_deref(), Some("66000"));
    }

    fn amend_algo_request() -> AmendAlgoOrderRequest {
        AmendAlgoOrderRequest {
            account_id: Some("account-demo".to_string()),
            environment: "demo".to_string(),
            inst_id: "BTC-USDT-SWAP".to_string(),
            algo_id: Some("algo-placeholder".to_string()),
            algo_cl_ord_id: Some("dtStableAlgoClientId".to_string()),
            new_size: Some("2".to_string()),
            new_trigger_px: None,
            new_ord_px: None,
            new_tp_trigger_px: Some("66500".to_string()),
            new_tp_ord_px: Some("-1".to_string()),
            new_sl_trigger_px: None,
            new_sl_ord_px: None,
            confirmed_live: None,
            execution_key: Some("algo-amend-key-1".to_string()),
        }
    }

    fn enabled_demo_account() -> LocalAccount {
        LocalAccount {
            id: "account-demo".to_string(),
            name: "Demo".to_string(),
            exchange: "okx".to_string(),
            environment: "demo".to_string(),
            okx_uid: "placeholder-uid".to_string(),
            okx_main_uid: "placeholder-main-uid".to_string(),
            api_key: String::new(),
            secret_key: String::new(),
            passphrase: String::new(),
            permissions: Permissions {
                read: true,
                trade: true,
                withdraw: false,
            },
        }
    }

    fn valid_swap_instrument() -> OkxInstrument {
        OkxInstrument {
            inst_id: "BTC-USDT-SWAP".to_string(),
            inst_type: "SWAP".to_string(),
            ct_val: "0.01".to_string(),
            tick_sz: "0.1".to_string(),
            lot_sz: "1".to_string(),
            min_sz: "1".to_string(),
            max_lmt_sz: "1000".to_string(),
            max_mkt_sz: "500".to_string(),
            lever: "125".to_string(),
            state: "live".to_string(),
            ..Default::default()
        }
    }

    fn decision_context_request() -> TradeOpportunityCreateRequest {
        TradeOpportunityCreateRequest {
            account_id: Some("account-demo".to_string()),
            environment: "demo".to_string(),
            inst_id: "BTC-USDT-SWAP".to_string(),
            td_mode: "cross".to_string(),
            intent: "open".to_string(),
            exit_kind: None,
            close_fraction: None,
            direction: "long".to_string(),
            size: "0.01".to_string(),
            order_type: "limit".to_string(),
            price: Some("65000".to_string()),
            order_id: None,
            client_order_id: None,
            algo_id: None,
            algo_client_order_id: None,
            new_price: None,
            new_size: None,
            lever: Some("20".to_string()),
            entry_condition: None,
            take_profit: None,
            stop_loss: None,
            invalidation_price: Some("64500".to_string()),
            max_slippage_bps: Some(10.0),
            confidence: Some(0.7),
            time_horizon: Some("intraday".to_string()),
            strategy_name: Some("test".to_string()),
            evidence: Some(vec!["test evidence".to_string()]),
            risk_notes: Some(vec![]),
            reason: "test candidate".to_string(),
            source_session_id: None,
            origin_type: Some("ai".to_string()),
            strategy_kind: None,
            strategy_id: None,
            strategy_version_id: None,
            strategy_run_id: None,
            signal_id: None,
            factor_pool_version_id: None,
            expires_at: None,
            agent_profile_id: Some("profile-1".to_string()),
            agent_run_id: Some("run-1".to_string()),
            related_opportunity_id: None,
            duplicate_resolution: None,
            duplicate_resolution_reason: None,
            decision_context_id: Some("decision-1".to_string()),
            max_single_trade_margin_pct: Some(30.0),
            confirmed_live: None,
        }
    }

    #[test]
    fn trigger_candidates_reject_inline_protective_exit_before_context() {
        let mut close_trigger = decision_context_request();
        close_trigger.intent = "close".to_string();
        close_trigger.exit_kind = Some("stop_loss".to_string());
        close_trigger.direction = "short".to_string();
        close_trigger.order_type = "trigger".to_string();
        close_trigger.price = Some("64078".to_string());
        close_trigger.stop_loss = Some(TradeOpportunityProtectiveOrder {
            kind: "stop_loss".to_string(),
            trigger_px: Some("64078".to_string()),
            order_px: None,
            trigger_px_type: Some("last".to_string()),
            close_fraction: Some("1".to_string()),
        });

        let close_error = validate_trade_opportunity_request(&close_trigger)
            .expect_err("close trigger with an attached stop loss must be rejected");
        assert!(close_error.contains("平仓机会的限价或触发价就是退出条件"));

        close_trigger.stop_loss = None;
        validate_trade_opportunity_request(&close_trigger)
            .expect("close trigger without an attached exit is valid");

        let mut open_trigger = decision_context_request();
        open_trigger.order_type = "trigger".to_string();
        open_trigger.take_profit = Some(TradeOpportunityProtectiveOrder {
            kind: "take_profit".to_string(),
            trigger_px: Some("66000".to_string()),
            order_px: None,
            trigger_px_type: Some("last".to_string()),
            close_fraction: Some("1".to_string()),
        });
        let open_error = validate_trade_opportunity_request(&open_trigger)
            .expect_err("trigger open with an attached take profit must be rejected");
        assert!(open_error.contains("计划委托暂不支持附加止盈止损"));
    }

    #[test]
    fn close_exit_kind_separates_take_profit_from_stop_loss() {
        let mut take_profit = decision_context_request();
        take_profit.intent = "close".to_string();
        take_profit.exit_kind = Some("take_profit".to_string());
        take_profit.order_type = "limit".to_string();
        take_profit.price = Some("66000".to_string());
        take_profit.close_fraction = Some("0.4".to_string());
        validate_trade_opportunity_request(&take_profit)
            .expect("limit close with take-profit exit kind is valid");

        let mut stop_loss = take_profit.clone();
        stop_loss.exit_kind = Some("stop_loss".to_string());
        stop_loss.order_type = "trigger".to_string();
        stop_loss.price = Some("64000".to_string());
        validate_trade_opportunity_request(&stop_loss)
            .expect("trigger close with stop-loss exit kind is valid");
        assert_ne!(
            trade_opportunity_fingerprint(&take_profit).expect("take-profit fingerprint"),
            trade_opportunity_fingerprint(&stop_loss).expect("stop-loss fingerprint")
        );
        assert!(same_active_close_exit(
            "close",
            Some("take_profit"),
            "0.100",
            Some("take_profit"),
            "0.1"
        ));
        assert!(!same_active_close_exit(
            "close",
            Some("take_profit"),
            "0.100",
            Some("take_profit"),
            "0.05"
        ));

        let mut reached_target = take_profit.clone();
        reached_target.order_type = "market".to_string();
        reached_target.price = None;
        validate_trade_opportunity_request(&reached_target)
            .expect("market close with take-profit exit kind is valid when target is reached");

        let mut missing_kind = take_profit.clone();
        missing_kind.exit_kind = None;
        let missing_error = validate_trade_opportunity_request(&missing_kind)
            .expect_err("close without exit kind is invalid");
        assert!(missing_error.contains("必须提供 exitKind"));

        let mut mismatched_kind = take_profit;
        mismatched_kind.exit_kind = Some("stop_loss".to_string());
        let mismatch_error = validate_trade_opportunity_request(&mismatched_kind)
            .expect_err("stop loss cannot use a limit close");
        assert!(mismatch_error.contains("止损平仓不能使用 limit"));
    }

    #[test]
    fn profile_size_limit_combines_domain_capacity_with_exchange_caps() {
        assert_eq!(
            profile_single_trade_size_limit(
                Some(60.0),
                Some(60_000.0),
                Some(0.01),
                Some(0.01),
                Some(100.0),
                Some(50.0),
            )
            .as_deref(),
            Some("0.1")
        );
        assert_eq!(
            profile_single_trade_size_limit(
                Some(60.0),
                Some(60_000.0),
                Some(0.01),
                Some(0.01),
                Some(100.0),
                Some(0.05),
            )
            .as_deref(),
            Some("0.05")
        );
    }

    fn decision_context_database() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory decision context db");
        conn.execute_batch(
            "CREATE TABLE ai_decision_contexts (
               id TEXT PRIMARY KEY,agent_run_id TEXT NOT NULL,agent_profile_id TEXT NOT NULL,
               account_id TEXT NOT NULL,environment TEXT NOT NULL,inst_id TEXT NOT NULL,
               candidate_fingerprint TEXT NOT NULL,expires_at INTEGER NOT NULL,
               snapshot_json TEXT NOT NULL DEFAULT '{}',
               consumed_opportunity_id TEXT,consumed_at INTEGER
             );",
        )
        .expect("decision context schema");
        conn
    }

    fn algo_lease_test_schema(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE trade_execution_attempts (
               execution_key TEXT PRIMARY KEY,
               account_id TEXT NOT NULL DEFAULT '',
               environment TEXT NOT NULL DEFAULT '',
               credential_fingerprint TEXT NOT NULL DEFAULT '',
               operation TEXT NOT NULL,
               status TEXT NOT NULL,
               owner_token TEXT NOT NULL DEFAULT '',
               lease_expires_at INTEGER NOT NULL DEFAULT 0,
               projection_status TEXT NOT NULL DEFAULT 'not_required',
               order_id TEXT,
               response_json TEXT,
               error TEXT,
               updated_at INTEGER NOT NULL
             );",
        )
        .expect("create algo lease test schema");
    }

    fn insert_algo_lease_test_row(
        conn: &Connection,
        execution_key: &str,
        owner_token: &str,
        lease_expires_at: i64,
    ) {
        conn.execute(
            "INSERT INTO trade_execution_attempts(
               execution_key,operation,status,owner_token,lease_expires_at,updated_at
             ) VALUES(?1,'place_algo_order','reconciling',?2,?3,0)",
            params![execution_key, owner_token, lease_expires_at],
        )
        .expect("insert algo lease test row");
    }

    fn insert_normal_lease_test_row(
        conn: &Connection,
        execution_key: &str,
        owner_token: &str,
        lease_expires_at: i64,
    ) {
        conn.execute(
            "INSERT INTO trade_execution_attempts(
               execution_key,operation,status,owner_token,lease_expires_at,updated_at
             ) VALUES(?1,'place_order','submitting',?2,?3,0)",
            params![execution_key, owner_token, lease_expires_at],
        )
        .expect("insert normal lease test row");
    }

    #[test]
    fn decision_context_is_bound_to_exact_candidate_and_single_use() {
        let conn = decision_context_database();
        let request = decision_context_request();
        let fingerprint = trade_opportunity_fingerprint(&request).expect("fingerprint");
        conn.execute(
            "INSERT INTO ai_decision_contexts VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'{}',NULL,NULL)",
            params![
                "decision-1",
                "run-1",
                "profile-1",
                "account-demo",
                "demo",
                "BTC-USDT-SWAP",
                fingerprint,
                50_000_i64,
            ],
        )
        .expect("insert context");
        validate_decision_context(&conn, &request, &fingerprint, 20_000).expect("valid context");

        let mut blocked_request = request.clone();
        blocked_request.decision_context_id = Some("decision-blocked".to_string());
        conn.execute(
            "INSERT INTO ai_decision_contexts VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL,NULL)",
            params![
                "decision-blocked",
                "run-1",
                "profile-1",
                "account-demo",
                "demo",
                "BTC-USDT-SWAP",
                fingerprint,
                50_000_i64,
                json!({ "precheck": { "blocked": true } }).to_string(),
            ],
        )
        .expect("insert blocked context");
        assert!(
            validate_decision_context(&conn, &blocked_request, &fingerprint, 20_000)
                .unwrap_err()
                .contains("预检已阻断")
        );

        let mut changed = request.clone();
        changed.price = Some("65001".to_string());
        let changed_fingerprint =
            trade_opportunity_fingerprint(&changed).expect("changed fingerprint");
        assert!(
            validate_decision_context(&conn, &changed, &changed_fingerprint, 20_000)
                .unwrap_err()
                .contains("candidate_mismatch")
        );

        consume_decision_context(&conn, Some("decision-1"), "opp-1", 20_000).expect("consume once");
        assert!(consume_decision_context(&conn, Some("decision-1"), "opp-2", 20_001).is_err());
    }

    #[test]
    fn decision_context_recovers_model_rewritten_id_only_for_exact_candidate_scope() {
        let conn = decision_context_database();
        let mut request = decision_context_request();
        let fingerprint = trade_opportunity_fingerprint(&request).expect("fingerprint");
        conn.execute(
            "INSERT INTO ai_decision_contexts VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'{}',NULL,NULL)",
            params![
                "decision-full-generated-id",
                "run-1",
                "profile-1",
                "account-demo",
                "demo",
                "BTC-USDT-SWAP",
                fingerprint,
                80_000_i64,
            ],
        )
        .expect("insert context");

        request.decision_context_id = Some("dctx-model-rewritten".to_string());
        assert_eq!(
            validate_decision_context(&conn, &request, &fingerprint, 20_000)
                .expect("recover exact context")
                .as_deref(),
            Some("decision-full-generated-id")
        );

        request.price = Some("65001".to_string());
        let changed_fingerprint =
            trade_opportunity_fingerprint(&request).expect("changed fingerprint");
        assert!(
            validate_decision_context(&conn, &request, &changed_fingerprint, 20_000)
                .unwrap_err()
                .contains("decision_context_not_found")
        );
    }

    #[test]
    fn background_commit_materializes_the_frozen_candidate_from_storage() {
        let conn = Connection::open_in_memory().expect("in-memory commit db");
        conn.execute_batch(
            "CREATE TABLE ai_decision_contexts (
               id TEXT PRIMARY KEY,
               agent_run_id TEXT NOT NULL,
               agent_profile_id TEXT NOT NULL,
               expires_at INTEGER NOT NULL,
               consumed_at INTEGER,
               candidate_json TEXT NOT NULL
             );",
        )
        .expect("create commit context schema");
        let mut frozen = decision_context_request();
        frozen.decision_context_id = None;
        frozen.strategy_name = Some("frozen-strategy".to_string());
        frozen.reason = "frozen reason".to_string();
        conn.execute(
            "INSERT INTO ai_decision_contexts(
               id,agent_run_id,agent_profile_id,expires_at,consumed_at,candidate_json
             ) VALUES(?1,'run-1','profile-1',50000,NULL,?2)",
            params![
                "decision-authoritative",
                serde_json::to_string(&frozen).expect("serialize frozen candidate")
            ],
        )
        .expect("insert frozen candidate");

        let materialized = materialize_trade_opportunity_commit_with_conn(
            &conn,
            TradeOpportunityCommitRequest {
                decision_context_id: "decision-authoritative".to_string(),
                related_opportunity_id: Some("opp-existing".to_string()),
                duplicate_resolution: Some("revise".to_string()),
                duplicate_resolution_reason: Some("replace duplicate".to_string()),
                agent_profile_id: Some("profile-1".to_string()),
                agent_run_id: Some("run-1".to_string()),
                max_single_trade_margin_pct: Some(30.0),
            },
            "background:run-1",
            20_000,
        )
        .expect("materialize exact frozen candidate");

        assert_eq!(materialized.price.as_deref(), Some("65000"));
        assert_eq!(
            materialized.strategy_name.as_deref(),
            Some("frozen-strategy")
        );
        assert_eq!(materialized.reason, "frozen reason");
        assert_eq!(
            materialized.decision_context_id.as_deref(),
            Some("decision-authoritative")
        );
        assert_eq!(
            materialized.source_session_id.as_deref(),
            Some("background:run-1")
        );
        assert_eq!(
            materialized.related_opportunity_id.as_deref(),
            Some("opp-existing")
        );
        assert_eq!(materialized.duplicate_resolution.as_deref(), Some("revise"));

        let missing_target = materialize_trade_opportunity_commit_with_conn(
            &conn,
            TradeOpportunityCommitRequest {
                decision_context_id: "decision-authoritative".to_string(),
                related_opportunity_id: None,
                duplicate_resolution: Some("reuse".to_string()),
                duplicate_resolution_reason: Some("reuse exact candidate".to_string()),
                agent_profile_id: Some("profile-1".to_string()),
                agent_run_id: Some("run-1".to_string()),
                max_single_trade_margin_pct: Some(30.0),
            },
            "background:run-1",
            20_000,
        )
        .expect_err("reuse must identify the existing opportunity");
        assert!(missing_target.contains("conflict.existingOpportunityId"));

        let missing_reason = materialize_trade_opportunity_commit_with_conn(
            &conn,
            TradeOpportunityCommitRequest {
                decision_context_id: "decision-authoritative".to_string(),
                related_opportunity_id: Some("opp-existing".to_string()),
                duplicate_resolution: Some("revise".to_string()),
                duplicate_resolution_reason: None,
                agent_profile_id: Some("profile-1".to_string()),
                agent_run_id: Some("run-1".to_string()),
                max_single_trade_margin_pct: Some(30.0),
            },
            "background:run-1",
            20_000,
        )
        .expect_err("duplicate resolution must explain its reason");
        assert!(missing_reason.contains("duplicateResolutionReason"));
    }

    #[test]
    fn background_reuse_requires_an_exact_candidate_and_consumes_context_atomically() {
        let mut conn = decision_context_database();
        conn.execute_batch(
            "CREATE TABLE trade_opportunities (
               id TEXT PRIMARY KEY,account_id TEXT,environment TEXT NOT NULL,inst_id TEXT NOT NULL,
               td_mode TEXT NOT NULL,intent TEXT NOT NULL,exit_kind TEXT,close_fraction TEXT,direction TEXT NOT NULL,ticket_mode TEXT NOT NULL,
               action TEXT NOT NULL,order_type TEXT NOT NULL,price TEXT,size TEXT NOT NULL,lever TEXT,
               entry_condition TEXT,take_profit_json TEXT,stop_loss_json TEXT,invalidation_price TEXT,
               max_slippage_bps REAL,confidence REAL,time_horizon TEXT,strategy_name TEXT,evidence_json TEXT,
               risk_notes_json TEXT,reason TEXT NOT NULL,source_session_id TEXT,origin_type TEXT NOT NULL,
               strategy_kind TEXT,strategy_id TEXT,strategy_version_id TEXT,strategy_run_id TEXT,signal_id TEXT,
               factor_pool_version_id TEXT,revision INTEGER NOT NULL,fingerprint TEXT,expires_at INTEGER,
               agent_profile_id TEXT,agent_run_id TEXT,related_opportunity_id TEXT,duplicate_resolution TEXT,
               duplicate_resolution_reason TEXT,decision_context_id TEXT,execution_key TEXT,status TEXT NOT NULL,
               estimated_margin REAL,estimated_fee REAL,available_usdt REAL,precheck_json TEXT,
               market_snapshot_json TEXT,execution_result_json TEXT,order_id TEXT,client_order_id TEXT,
               algo_id TEXT,algo_client_order_id TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
             );
             CREATE TABLE trade_opportunity_resolution_events (
               id TEXT PRIMARY KEY,opportunity_id TEXT NOT NULL,related_opportunity_id TEXT,
               resolution TEXT NOT NULL,reason TEXT NOT NULL,agent_run_id TEXT,created_at INTEGER NOT NULL
             );",
        )
        .expect("create reuse tables");
        let mut request = decision_context_request();
        request.related_opportunity_id = Some("opp-existing".to_string());
        request.duplicate_resolution = Some("reuse".to_string());
        request.duplicate_resolution_reason = Some("reuse exact candidate".to_string());
        let fingerprint = trade_opportunity_fingerprint(&request).expect("fingerprint");
        conn.execute(
            "INSERT INTO ai_decision_contexts VALUES(
               'decision-1','run-1','profile-1','account-demo','demo','BTC-USDT-SWAP',?1,50000,'{}',NULL,NULL
             )",
            params![fingerprint],
        )
        .expect("insert decision context");
        conn.execute(
            "INSERT INTO trade_opportunities(
               id,account_id,environment,inst_id,td_mode,intent,direction,ticket_mode,action,order_type,
               price,size,lever,reason,origin_type,revision,fingerprint,expires_at,agent_profile_id,
               agent_run_id,status,created_at,updated_at
             ) VALUES(
               'opp-existing','account-demo','demo','BTC-USDT-SWAP','cross','open','short','open_short',
               'place_order','limit','65000','0.01','20','existing','ai',1,?1,60000,
               'profile-1','run-old','pending',1,1
             )",
            params![fingerprint],
        )
        .expect("insert existing opportunity");

        let mismatch = commit_reuse_resolution(
            &mut conn,
            &request,
            "opp-existing",
            "different-fingerprint",
            "invalid similar reuse",
            20_000,
        )
        .expect_err("similar candidate must not be reused");
        assert!(mismatch.contains("duplicate_reuse_candidate_mismatch"));

        let reused = commit_reuse_resolution(
            &mut conn,
            &request,
            "opp-existing",
            &fingerprint,
            "reuse exact candidate",
            20_000,
        )
        .expect("commit exact reuse");
        assert_eq!(reused.id, "opp-existing");
        assert_eq!(reused.duplicate_resolution.as_deref(), Some("reuse"));
        assert!(reused.conflict.is_none());
        save_trade_opportunity(&conn, &reused)
            .expect("persist opportunity with structured exit columns");
        let persisted =
            load_trade_opportunity(&conn, "opp-existing").expect("reload persisted opportunity");
        assert_eq!(persisted.id, reused.id);
        assert_eq!(
            conn.query_row(
                "SELECT consumed_opportunity_id FROM ai_decision_contexts WHERE id='decision-1'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("consumed context"),
            "opp-existing"
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM trade_opportunity_resolution_events
                 WHERE opportunity_id='opp-existing' AND resolution='reuse' AND agent_run_id='run-1'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("reuse event"),
            1
        );
    }

    #[test]
    fn decision_context_recovery_keeps_expiration_enforced() {
        let conn = decision_context_database();
        let mut request = decision_context_request();
        let fingerprint = trade_opportunity_fingerprint(&request).expect("fingerprint");
        conn.execute(
            "INSERT INTO ai_decision_contexts VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'{}',NULL,NULL)",
            params![
                "decision-expired",
                "run-1",
                "profile-1",
                "account-demo",
                "demo",
                "BTC-USDT-SWAP",
                fingerprint,
                30_000_i64,
            ],
        )
        .expect("insert context");
        request.decision_context_id = Some("decision-truncated".to_string());

        assert!(
            validate_decision_context(&conn, &request, &fingerprint, 30_000)
                .unwrap_err()
                .contains("decision_context_expired")
        );
    }

    #[test]
    fn compact_decision_market_snapshot_bounds_orderbook_and_trade_samples() {
        let levels = (0..20)
            .map(|index| json!([format!("{}", 65_000 + index), "1", "0", "1"]))
            .collect::<Vec<_>>();
        let trades = (0..30)
            .map(|index| {
                json!({
                    "side": if index % 2 == 0 { "buy" } else { "sell" },
                    "sz": "2",
                    "ts": 1_800_000_000_000_i64 + index
                })
            })
            .collect::<Vec<_>>();
        let snapshot = json!({
            "capturedAt": 1_800_000_000_000_i64,
            "source": "wss_memory",
            "instId": "BTC-USDT-SWAP",
            "ticker": { "last": "65000" },
            "orderbook": { "bids": levels, "asks": levels },
            "recentTrades": trades,
            "candles": {},
            "fundingRate": null
        });

        let compact = compact_decision_market_snapshot(Some(&snapshot));

        assert_eq!(compact["orderbook"]["bids"].as_array().unwrap().len(), 5);
        assert_eq!(compact["orderbook"]["asks"].as_array().unwrap().len(), 5);
        assert_eq!(compact["recentTrades"].as_array().unwrap().len(), 12);
        assert_eq!(compact["tradeFlow"]["buyCount"], 6);
        assert_eq!(compact["tradeFlow"]["sellCount"], 6);
        assert_eq!(compact["tradeFlow"]["totalSize"], 24.0);
    }

    #[test]
    fn decision_context_rejects_a_context_at_its_expiration_boundary() {
        let conn = decision_context_database();
        let request = decision_context_request();
        let fingerprint = trade_opportunity_fingerprint(&request).expect("fingerprint");
        conn.execute(
            "INSERT INTO ai_decision_contexts VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'{}',NULL,NULL)",
            params![
                "decision-1",
                "run-1",
                "profile-1",
                "account-demo",
                "demo",
                "BTC-USDT-SWAP",
                fingerprint,
                30_000_i64,
            ],
        )
        .expect("insert context");
        assert!(
            validate_decision_context(&conn, &request, &fingerprint, 30_000)
                .unwrap_err()
                .contains("decision_context_expired")
        );
    }

    #[test]
    fn private_order_identity_is_stable_and_api_compatible() {
        let first = exchange_client_marker();
        let second = exchange_client_marker();
        assert_eq!(first, second);
        assert_ne!(first, retired_exchange_client_marker());
        assert!(!first.is_empty());
        assert!(first.len() <= 16);
        assert!(first.chars().all(|value| value.is_ascii_alphanumeric()));
    }

    fn assert_private_order_wire_identity<T: Serialize>(body: &T) {
        let marker = exchange_client_marker();
        let value = serde_json::to_value(body).expect("serialize private order body");
        assert_eq!(
            value.get("tag").and_then(Value::as_str),
            Some(marker.as_str())
        );
        assert!(value.get("clientMarker").is_none());

        let stored = private_exchange_value(&value).expect("sanitize private order body");
        assert!(stored.get("tag").is_none());
        assert!(!stored.to_string().contains(&marker));
    }

    #[test]
    fn every_order_creation_body_carries_private_wire_identity() {
        assert_private_order_wire_identity(&PlaceOrderBody {
            inst_id: "BTC-USDT-SWAP".to_string(),
            td_mode: "cross".to_string(),
            cl_ord_id: "client-order-1".to_string(),
            client_marker: exchange_client_marker(),
            side: "buy".to_string(),
            pos_side: Some("long".to_string()),
            ord_type: "limit".to_string(),
            sz: "1".to_string(),
            px: Some("60000".to_string()),
            reduce_only: None,
            attach_algo_ords: None,
        });
        assert_private_order_wire_identity(&PlaceAlgoOrderBody {
            inst_id: "BTC-USDT-SWAP".to_string(),
            td_mode: "cross".to_string(),
            algo_cl_ord_id: "client-algo-1".to_string(),
            client_marker: exchange_client_marker(),
            side: "buy".to_string(),
            pos_side: Some("long".to_string()),
            ord_type: "trigger".to_string(),
            sz: "1".to_string(),
            trigger_px: Some("60000".to_string()),
            trigger_px_type: Some("mark".to_string()),
            order_px: Some("-1".to_string()),
            callback_ratio: None,
            active_px: None,
            reduce_only: None,
        });
        assert_private_order_wire_identity(&PlaceTpSlAlgoBody {
            inst_id: "BTC-USDT-SWAP".to_string(),
            td_mode: "cross".to_string(),
            algo_cl_ord_id: "client-protection-1".to_string(),
            client_marker: exchange_client_marker(),
            side: "sell".to_string(),
            pos_side: "long".to_string(),
            ord_type: "oco".to_string(),
            sz: "1".to_string(),
            tp_trigger_px: Some("65000".to_string()),
            tp_trigger_px_type: Some("mark".to_string()),
            tp_ord_px: Some("-1".to_string()),
            tp_ord_kind: None,
            sl_trigger_px: Some("58000".to_string()),
            sl_trigger_px_type: Some("mark".to_string()),
            sl_ord_px: Some("-1".to_string()),
            reduce_only: None,
        });
        assert_private_order_wire_identity(&ClosePositionBody {
            inst_id: "BTC-USDT-SWAP".to_string(),
            mgn_mode: "cross".to_string(),
            pos_side: "long".to_string(),
            auto_cxl: false,
            cl_ord_id: Some("client-close-1".to_string()),
            client_marker: exchange_client_marker(),
        });
    }

    #[test]
    fn stable_client_order_id_is_deterministic_and_okx_sized() {
        let key = "opportunity:opp-123:revision:7:place_order:primary";
        let first = stable_client_order_id(key);
        let second = stable_client_order_id(key);
        assert_eq!(first, second);
        assert!(first.starts_with("dt"));
        assert!(first.len() <= 32);
        assert_ne!(
            first,
            stable_client_order_id("opportunity:opp-123:revision:8:place_order:primary")
        );
    }

    #[test]
    fn strategy_place_uses_execution_key_derived_algo_client_id() {
        let request = place_algo_request();
        let execution_key = request.execution_key.as_deref().unwrap();
        let client_id = stable_client_order_id(execution_key);
        let body = place_algo_body(&request, &client_id);

        assert_eq!(body.algo_cl_ord_id, stable_client_order_id(execution_key));
        assert!(body.algo_cl_ord_id.len() <= 32);
        assert_ne!(
            body.algo_cl_ord_id,
            stable_client_order_id("algo-place-key-2")
        );
        let hedge_json = serde_json::to_value(&body).expect("serialize hedge protection body");
        assert!(hedge_json.get("reduceOnly").is_none());

        let mut net_request = request;
        net_request.pos_side = "net".to_string();
        let net_body = place_algo_body(&net_request, &client_id);
        let net_json = serde_json::to_value(&net_body).expect("serialize net protection body");
        assert_eq!(net_json.get("reduceOnly"), Some(&json!(true)));
    }

    #[test]
    fn protective_algo_orders_fail_closed_for_opening_direction_pairs() {
        let instrument = valid_swap_instrument();
        let mut request = place_algo_request();

        assert!(validate_algo_request(&request, &instrument, "long_short_mode").is_ok());
        request.side = "buy".to_string();
        assert!(validate_algo_request(&request, &instrument, "long_short_mode").is_err());

        request.pos_side = "short".to_string();
        assert!(validate_algo_request(&request, &instrument, "long_short_mode").is_ok());
        request.side = "sell".to_string();
        assert!(validate_algo_request(&request, &instrument, "long_short_mode").is_err());

        request.pos_side = "net".to_string();
        request.side = "buy".to_string();
        assert!(validate_algo_request(&request, &instrument, "net_mode").is_ok());
        request.pos_side = "long".to_string();
        assert!(validate_algo_request(&request, &instrument, "net_mode").is_err());
        assert!(validate_algo_request(&request, &instrument, "unknown_mode").is_err());
    }

    #[test]
    fn strategy_duplicate_client_id_responses_require_reconciliation() {
        assert!(is_duplicate_client_order_error(
            "51503",
            "Duplicate client order ID"
        ));
        assert!(is_duplicate_client_order_error(
            "51016",
            "Client order ID already exists"
        ));
        assert!(!is_duplicate_client_order_error(
            "51008",
            "Insufficient balance"
        ));
    }

    #[test]
    fn strategy_execution_lease_is_long_enough_for_strict_get_retries() {
        assert!(ALGO_EXECUTION_LEASE_MS >= 90_000);
        assert!(NORMAL_EXECUTION_LEASE_MS >= 180_000);
    }

    #[test]
    fn normal_execution_recovery_waits_for_expiry_and_rejects_stale_owner_writes() {
        let conn = Connection::open_in_memory().expect("open normal lease test database");
        algo_lease_test_schema(&conn);
        insert_normal_lease_test_row(
            &conn,
            "normal-lease-placeholder",
            "normal-owner-active",
            10_000,
        );

        assert!(!claim_normal_execution_lease_with_conn(
            &conn,
            "normal-lease-placeholder",
            "place_order",
            "normal-owner-recovery",
            9_999,
        )
        .expect("fresh normal lease claim"));
        assert!(claim_normal_execution_lease_with_conn(
            &conn,
            "normal-lease-placeholder",
            "place_order",
            "normal-owner-recovery",
            10_000,
        )
        .expect("expired normal lease claim"));

        let active_lease = NormalExecutionLease {
            execution_key: "normal-lease-placeholder".to_string(),
            operation: "place_order".to_string(),
            owner_token: "normal-owner-active".to_string(),
        };
        let recovery_lease = NormalExecutionLease {
            owner_token: "normal-owner-recovery".to_string(),
            ..active_lease.clone()
        };
        assert!(!cas_finish_normal_execution_with_conn(
            &conn,
            &active_lease,
            "accepted",
            Some("normal-order-stale"),
            Some("{}"),
            None,
            10_001,
        )
        .expect("stale normal owner finish"));
        assert!(cas_finish_normal_execution_with_conn(
            &conn,
            &recovery_lease,
            "unknown",
            None,
            None,
            Some("reconciliation remains ambiguous"),
            10_001,
        )
        .expect("recovery owner unknown finish"));

        let retained_expiry = 10_001 + NORMAL_EXECUTION_LEASE_MS;
        assert!(!claim_normal_execution_lease_with_conn(
            &conn,
            "normal-lease-placeholder",
            "place_order",
            "normal-owner-next",
            retained_expiry - 1,
        )
        .expect("retained unknown lease claim"));
        assert!(claim_normal_execution_lease_with_conn(
            &conn,
            "normal-lease-placeholder",
            "place_order",
            "normal-owner-next",
            retained_expiry,
        )
        .expect("expired unknown lease claim"));

        let next_lease = NormalExecutionLease {
            owner_token: "normal-owner-next".to_string(),
            ..recovery_lease.clone()
        };
        assert!(!cas_finish_normal_execution_with_conn(
            &conn,
            &recovery_lease,
            "accepted",
            Some("normal-order-old-recovery"),
            Some("{}"),
            None,
            retained_expiry + 1,
        )
        .expect("superseded recovery finish"));
        assert!(cas_finish_normal_execution_with_conn(
            &conn,
            &next_lease,
            "accepted",
            Some("normal-order-winner"),
            Some("{}"),
            None,
            retained_expiry + 1,
        )
        .expect("current recovery finish"));

        let (status, order_id, owner_token, lease_expires_at) = conn
            .query_row(
                "SELECT status,order_id,owner_token,lease_expires_at
                 FROM trade_execution_attempts WHERE execution_key='normal-lease-placeholder'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .expect("read normal lease terminal row");
        assert_eq!(status, "accepted");
        assert_eq!(order_id.as_deref(), Some("normal-order-winner"));
        assert!(owner_token.is_empty());
        assert_eq!(lease_expires_at, 0);
    }

    #[test]
    fn close_fallback_reclaims_rejected_attempt_and_finishes_with_owner_cas() {
        let conn = Connection::open_in_memory().expect("open fallback lease test database");
        algo_lease_test_schema(&conn);
        let account = enabled_demo_account();
        let execution_key = "instrument-flatten-fallback-placeholder";
        insert_normal_lease_test_row(&conn, execution_key, "", 0);
        conn.execute(
            "UPDATE trade_execution_attempts
             SET status='rejected',account_id=?2,environment=?3,credential_fingerprint=?4
             WHERE execution_key=?1",
            params![
                execution_key,
                account.id,
                account.environment,
                account_config_cache_fingerprint(&account),
            ],
        )
        .expect("prepare rejected close attempt");

        assert!(claim_normal_execution_retry_from_status_with_conn(
            &conn,
            &account,
            execution_key,
            "place_order",
            "rejected",
            "fallback-owner-winner",
            20_000,
        )
        .expect("claim rejected close attempt"));
        assert!(!claim_normal_execution_retry_from_status_with_conn(
            &conn,
            &account,
            execution_key,
            "place_order",
            "rejected",
            "fallback-owner-loser",
            20_000,
        )
        .expect("reject second fallback owner"));

        let loser = NormalExecutionLease {
            execution_key: execution_key.to_string(),
            operation: "place_order".to_string(),
            owner_token: "fallback-owner-loser".to_string(),
        };
        let winner = NormalExecutionLease {
            owner_token: "fallback-owner-winner".to_string(),
            ..loser.clone()
        };
        assert!(!cas_finish_normal_execution_with_conn(
            &conn,
            &loser,
            "fallback_accepted",
            None,
            Some("{\"clOrdId\":\"placeholder\"}"),
            None,
            20_001,
        )
        .expect("losing fallback owner finish"));
        assert!(cas_finish_normal_execution_with_conn(
            &conn,
            &winner,
            "fallback_accepted",
            None,
            Some("{\"clOrdId\":\"placeholder\"}"),
            None,
            20_001,
        )
        .expect("winning fallback owner finish"));

        let (status, owner_token, lease_expires_at) = conn
            .query_row(
                "SELECT status,owner_token,lease_expires_at
                 FROM trade_execution_attempts WHERE execution_key=?1",
                [execution_key],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .expect("read fallback terminal attempt");
        assert_eq!(status, "fallback_accepted");
        assert!(owner_token.is_empty());
        assert_eq!(lease_expires_at, 0);
    }

    #[test]
    fn fresh_algo_lease_cannot_be_stolen_and_expired_lease_uses_owner_cas() {
        let conn = Connection::open_in_memory().expect("open lease test database");
        algo_lease_test_schema(&conn);
        insert_algo_lease_test_row(&conn, "lease-cas-placeholder", "owner-old", 10_000);

        assert!(!claim_algo_execution_lease_with_conn(
            &conn,
            "lease-cas-placeholder",
            "place_algo_order",
            "owner-new",
            9_999,
        )
        .expect("fresh lease claim"));
        assert!(claim_algo_execution_lease_with_conn(
            &conn,
            "lease-cas-placeholder",
            "place_algo_order",
            "owner-new",
            10_000,
        )
        .expect("expired lease claim"));

        let old_lease = AlgoExecutionLease {
            execution_key: "lease-cas-placeholder".to_string(),
            operation: "place_algo_order".to_string(),
            owner_token: "owner-old".to_string(),
        };
        let new_lease = AlgoExecutionLease {
            owner_token: "owner-new".to_string(),
            ..old_lease.clone()
        };
        assert!(!cas_finish_algo_execution_with_conn(
            &conn,
            &old_lease,
            "accepted",
            Some("order-old-placeholder"),
            Some("{}"),
            None,
            10_001,
        )
        .expect("old owner cas"));
        assert!(cas_finish_algo_execution_with_conn(
            &conn,
            &new_lease,
            "accepted",
            Some("order-new-placeholder"),
            Some("{}"),
            None,
            10_001,
        )
        .expect("new owner cas"));
        assert!(!cas_finish_algo_execution_with_conn(
            &conn,
            &new_lease,
            "unknown",
            None,
            None,
            Some("late write"),
            10_002,
        )
        .expect("terminal state cas"));

        let (status, order_id, owner_token, lease_expires_at) = conn
            .query_row(
                "SELECT status,order_id,owner_token,lease_expires_at
                 FROM trade_execution_attempts WHERE execution_key='lease-cas-placeholder'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .expect("read terminal lease row");
        assert_eq!(status, "accepted");
        assert_eq!(order_id.as_deref(), Some("order-new-placeholder"));
        assert!(owner_token.is_empty());
        assert_eq!(lease_expires_at, 0);
    }

    #[test]
    fn expired_algo_lease_has_exactly_one_sqlite_claim_winner() {
        let unique = ALGO_EXECUTION_OWNER_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "desic-algo-lease-test-{}-{unique}.sqlite3",
            std::process::id()
        ));
        {
            let conn = Connection::open(&path).expect("open shared lease test database");
            algo_lease_test_schema(&conn);
            insert_algo_lease_test_row(&conn, "lease-race-placeholder", "owner-crashed", 0);
        }

        let barrier = Arc::new(Barrier::new(2));
        let handles = ["owner-race-a", "owner-race-b"].map(|owner| {
            let path = path.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                let conn = Connection::open(path).expect("open competing lease database");
                conn.busy_timeout(Duration::from_secs(2))
                    .expect("configure sqlite busy timeout");
                barrier.wait();
                claim_algo_execution_lease_with_conn(
                    &conn,
                    "lease-race-placeholder",
                    "place_algo_order",
                    owner,
                    1_000,
                )
                .expect("competing lease claim")
            })
        });
        let winners = handles
            .into_iter()
            .map(|handle| handle.join().expect("join lease claimant"))
            .filter(|claimed| *claimed)
            .count();
        assert_eq!(winners, 1);

        let conn = Connection::open(&path).expect("reopen lease database");
        let (owner_token, lease_expires_at) = conn
            .query_row(
                "SELECT owner_token,lease_expires_at FROM trade_execution_attempts
                 WHERE execution_key='lease-race-placeholder'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .expect("read lease race winner");
        assert!(matches!(
            owner_token.as_str(),
            "owner-race-a" | "owner-race-b"
        ));
        assert_eq!(lease_expires_at, 1_000 + ALGO_EXECUTION_LEASE_MS);
        drop(conn);
        std::fs::remove_file(path).expect("remove lease race database");
    }

    #[test]
    fn risk_increase_scope_check_and_insert_have_one_cross_process_winner() {
        let unique = NORMAL_EXECUTION_OWNER_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "desic-risk-scope-test-{}-{unique}.sqlite3",
            std::process::id()
        ));
        {
            let conn = Connection::open(&path).expect("open risk scope test database");
            migrate_database(&conn).expect("migrate risk scope test database");
        }

        let barrier = Arc::new(Barrier::new(2));
        let handles = ["scope-owner-a", "scope-owner-b"].map(|execution_key| {
            let path = path.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                let mut conn = Connection::open(path).expect("open competing scope database");
                conn.busy_timeout(Duration::from_secs(2))
                    .expect("configure scope busy timeout");
                let account = enabled_demo_account();
                barrier.wait();
                let transaction = conn
                    .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                    .expect("begin competing risk scope transaction");
                if ensure_risk_increase_scope_available_with_conn(
                    &transaction,
                    &account,
                    "BTC-USDT-SWAP",
                    Some(execution_key),
                    "测试开仓",
                )
                .is_err()
                {
                    return false;
                }
                transaction
                    .execute(
                        "INSERT INTO trade_execution_attempts (
                           execution_key,account_id,environment,credential_fingerprint,operation,
                           client_order_id,status,request_json,owner_token,lease_expires_at,
                           created_at,updated_at
                         ) VALUES (?1,?2,'demo',?3,'place_order',?1,'submitting',?4,?1,10000,1,1)",
                        params![
                            execution_key,
                            account.id,
                            account_config_cache_fingerprint(&account),
                            json!({ "instId": "BTC-USDT-SWAP", "ticketMode": "open" }).to_string(),
                        ],
                    )
                    .expect("insert risk scope winner");
                transaction.commit().expect("commit risk scope winner");
                true
            })
        });
        let winners = handles
            .into_iter()
            .map(|handle| handle.join().expect("join risk scope claimant"))
            .filter(|won| *won)
            .count();
        assert_eq!(winners, 1);

        std::fs::remove_file(path).expect("remove risk scope test database");
    }

    #[test]
    fn lease_loss_only_returns_strictly_validated_accepted_response() {
        let conn = Connection::open_in_memory().expect("open accepted response database");
        algo_lease_test_schema(&conn);
        insert_algo_lease_test_row(&conn, "accepted-read-placeholder", "owner-winner", 10_000);
        let client_order_id = stable_client_order_id("accepted-read-placeholder");
        let response = PlaceOrderResponse {
            ord_id: "algo-accepted-placeholder".to_string(),
            cl_ord_id: client_order_id.clone(),
            s_code: "0".to_string(),
            s_msg: "accepted".to_string(),
            ts: "1".to_string(),
            side: "sell".to_string(),
            pos_side: "long".to_string(),
            reduce_only: true,
            operator: "user".to_string(),
            strategy_id: None,
            session_id: None,
            opportunity_id: None,
            agent_run_id: None,
            execution_key: Some("accepted-read-placeholder".to_string()),
        };
        conn.execute(
            "UPDATE trade_execution_attempts
             SET status='accepted',response_json=?2,owner_token='',lease_expires_at=0
             WHERE execution_key=?1",
            params![
                "accepted-read-placeholder",
                serde_json::to_string(&response).expect("serialize accepted response"),
            ],
        )
        .expect("persist accepted response");

        let accepted = load_persisted_accepted_algo_response(
            &conn,
            "accepted-read-placeholder",
            "place_algo_order",
            &|persisted| {
                validate_persisted_place_algo_response(
                    persisted,
                    &client_order_id,
                    "accepted-read-placeholder",
                )
            },
        )
        .expect("strict accepted read")
        .expect("accepted response exists");
        assert_eq!(accepted.ord_id, "algo-accepted-placeholder");

        let error = load_persisted_accepted_algo_response::<PlaceOrderResponse, _>(
            &conn,
            "accepted-read-placeholder",
            "place_algo_order",
            &|persisted| {
                validate_persisted_place_algo_response(
                    persisted,
                    "dtWrongClientPlaceholder",
                    "accepted-read-placeholder",
                )
            },
        )
        .expect_err("mismatched accepted identity must fail closed");
        assert!(error.contains(ALGO_EXECUTION_LEASE_LOST));

        let mut rejected_response = response;
        rejected_response.s_code = "51008".to_string();
        conn.execute(
            "UPDATE trade_execution_attempts SET response_json=?2 WHERE execution_key=?1",
            params![
                "accepted-read-placeholder",
                serde_json::to_string(&rejected_response)
                    .expect("serialize rejected accepted response"),
            ],
        )
        .expect("persist invalid accepted response");
        let error = load_persisted_accepted_algo_response::<PlaceOrderResponse, _>(
            &conn,
            "accepted-read-placeholder",
            "place_algo_order",
            &|persisted| {
                validate_persisted_place_algo_response(
                    persisted,
                    &client_order_id,
                    "accepted-read-placeholder",
                )
            },
        )
        .expect_err("nonzero accepted sCode must fail closed");
        assert!(error.contains(ALGO_EXECUTION_LEASE_LOST));
    }

    #[test]
    fn accepted_algo_projection_does_not_regress_synced_order_state() {
        let conn = Connection::open_in_memory().expect("open projection test database");
        conn.execute_batch(
            "CREATE TABLE okx_orders (
               account_id TEXT NOT NULL,environment TEXT NOT NULL,ord_id TEXT NOT NULL,
               cl_ord_id TEXT,inst_id TEXT,inst_type TEXT,side TEXT,pos_side TEXT,td_mode TEXT,
               ord_type TEXT,state TEXT,px TEXT,sz TEXT,acc_fill_sz TEXT,avg_px TEXT,pnl TEXT,
               fee TEXT,source_endpoint TEXT,operator TEXT,strategy_id TEXT,session_id TEXT,
               okx_ctime INTEGER,okx_utime INTEGER,raw_json TEXT,synced_at INTEGER,
               PRIMARY KEY(account_id,environment,ord_id)
             );",
        )
        .expect("create projection order schema");
        conn.execute(
            "INSERT INTO okx_orders(
               account_id,environment,ord_id,state,source_endpoint,raw_json,synced_at
             ) VALUES('account-demo','demo','algo-projection-placeholder','filled',
                      'orders-history','remote-filled-snapshot',200)",
            [],
        )
        .expect("insert synced filled order");

        let request = place_algo_request();
        let client_order_id = stable_client_order_id(request.execution_key.as_deref().unwrap());
        let body = place_algo_body(&request, &client_order_id);
        let result = OkxAlgoOrderResult {
            algo_id: "algo-projection-placeholder".to_string(),
            algo_cl_ord_id: client_order_id,
            s_code: "0".to_string(),
            ts: "100".to_string(),
            ..Default::default()
        };
        insert_missing_submitted_tpsl_algo_order_with_conn(
            &conn,
            &enabled_demo_account(),
            &request,
            &body,
            &result,
            "user",
        )
        .expect("repeat accepted projection");

        let (state, source_endpoint, raw_json, synced_at) = conn
            .query_row(
                "SELECT state,source_endpoint,raw_json,synced_at FROM okx_orders
                 WHERE account_id='account-demo' AND environment='demo'
                   AND ord_id='algo-projection-placeholder'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .expect("read projected order");
        assert_eq!(state, "filled");
        assert_eq!(source_endpoint, "orders-history");
        assert_eq!(raw_json, "remote-filled-snapshot");
        assert_eq!(synced_at, 200);
    }

    #[test]
    fn blocked_algo_executions_remain_in_unresolved_guard_but_not_recovery_statuses() {
        assert!(UNRESOLVED_TRADE_EXECUTION_GUARDS_SQL.contains("'place_algo_order'"));
        assert!(UNRESOLVED_TRADE_EXECUTION_GUARDS_SQL.contains("'amend_algo_order'"));
        assert!(UNRESOLVED_TRADE_EXECUTION_GUARDS_SQL.contains("'blocked'"));
        assert!(!PENDING_ALGO_EXECUTION_ROWS_SQL.contains("'blocked'"));
    }

    #[test]
    fn strategy_success_responses_require_exact_remote_identity() {
        let expected_client_id = stable_client_order_id("algo-place-key-1");
        let mut place_result = OkxAlgoOrderResult {
            algo_id: "algo-placeholder".to_string(),
            algo_cl_ord_id: expected_client_id.clone(),
            s_code: "0".to_string(),
            ..Default::default()
        };
        assert!(validate_algo_order_result_identity(&place_result, &expected_client_id).is_ok());
        place_result.algo_cl_ord_id = "dtWrongClientId".to_string();
        assert!(validate_algo_order_result_identity(&place_result, &expected_client_id).is_err());
        place_result.algo_cl_ord_id = expected_client_id;
        place_result.algo_id.clear();
        assert!(
            validate_algo_order_result_identity(&place_result, &place_result.algo_cl_ord_id)
                .is_err()
        );

        let amend_request = amend_algo_request();
        let mut amend_result = OkxAlgoOrderResult {
            algo_id: amend_request.algo_id.clone().unwrap(),
            algo_cl_ord_id: amend_request.algo_cl_ord_id.clone().unwrap(),
            s_code: "0".to_string(),
            ..Default::default()
        };
        assert!(validate_amend_algo_result_identity(&amend_request, &amend_result).is_ok());
        amend_result.algo_id = "different-algo".to_string();
        assert!(validate_amend_algo_result_identity(&amend_request, &amend_result).is_err());
    }

    #[test]
    fn strategy_request_signatures_normalize_numbers_and_reject_changes() {
        let request = place_algo_request();
        let signature = place_algo_request_signature(&request);
        let mut equivalent = request.clone();
        equivalent.size = "2.000".to_string();
        equivalent.tp_trigger_px = Some("66000.0".to_string());
        assert_eq!(signature, place_algo_request_signature(&equivalent));
        equivalent.tp_trigger_px = Some("66001".to_string());
        assert_ne!(signature, place_algo_request_signature(&equivalent));

        let amend = amend_algo_request();
        let amend_signature = amend_algo_request_signature(&amend);
        let mut changed = amend.clone();
        changed.new_size = Some("3".to_string());
        assert_ne!(amend_signature, amend_algo_request_signature(&changed));
        changed = amend.clone();
        changed.algo_id = Some("different-target".to_string());
        assert_ne!(amend_signature, amend_algo_request_signature(&changed));
        changed = amend.clone();
        changed.new_trigger_px = Some("64000".to_string());
        assert_ne!(amend_signature, amend_algo_request_signature(&changed));
    }

    #[test]
    fn strategy_reconciliation_requires_all_requested_fields() {
        let place = place_algo_request();
        let client_id = stable_client_order_id(place.execution_key.as_deref().unwrap());
        let mut order = OkxPendingOrder {
            inst_id: place.inst_id.clone(),
            algo_id: "algo-placeholder".to_string(),
            algo_cl_ord_id: client_id.clone(),
            side: place.side.clone(),
            pos_side: place.pos_side.clone(),
            td_mode: place.td_mode.clone(),
            ord_type: place.ord_type.clone(),
            sz: "2.000".to_string(),
            tp_trigger_px: "66000.0".to_string(),
            tp_trigger_px_type: "last".to_string(),
            tp_ord_px: "-1".to_string(),
            reduce_only: String::new(),
            ..Default::default()
        };
        assert!(place_algo_matches_order(&place, &order, &client_id));
        order.tp_trigger_px = "65999".to_string();
        assert!(!place_algo_matches_order(&place, &order, &client_id));

        let mut net_place = place.clone();
        net_place.pos_side = "net".to_string();
        order.pos_side = "net".to_string();
        order.tp_trigger_px = "66000".to_string();
        assert!(!place_algo_matches_order(&net_place, &order, &client_id));
        order.reduce_only = "true".to_string();
        assert!(place_algo_matches_order(&net_place, &order, &client_id));

        let amend = amend_algo_request();
        order.inst_id = amend.inst_id.clone();
        order.algo_id = amend.algo_id.clone().unwrap();
        order.algo_cl_ord_id = amend.algo_cl_ord_id.clone().unwrap();
        order.sz = "2.0".to_string();
        order.tp_trigger_px = "66500.000".to_string();
        order.tp_trigger_px_type = "last".to_string();
        assert!(amend_algo_matches_order(&amend, &order));
        order.tp_ord_px = "66000".to_string();
        assert!(!amend_algo_matches_order(&amend, &order));

        let mut trigger_amend = amend;
        trigger_amend.new_tp_trigger_px = None;
        trigger_amend.new_tp_ord_px = None;
        trigger_amend.new_trigger_px = Some("64000".to_string());
        trigger_amend.new_ord_px = Some("-1".to_string());
        order.tp_ord_px = "-1".to_string();
        order.trigger_px = "64000.0".to_string();
        order.ord_px = "-1".to_string();
        assert!(amend_algo_matches_order(&trigger_amend, &order));
        order.ord_px = "63999".to_string();
        assert!(!amend_algo_matches_order(&trigger_amend, &order));
    }

    #[test]
    fn strategy_reconciliation_rebuilds_idempotent_accepted_responses() {
        let request = place_algo_request();
        let execution_key = request.execution_key.as_deref().unwrap();
        let client_id = stable_client_order_id(execution_key);
        let order = OkxPendingOrder {
            inst_id: request.inst_id.clone(),
            algo_id: "algo-placeholder".to_string(),
            algo_cl_ord_id: client_id.clone(),
            u_time: "123".to_string(),
            ..Default::default()
        };
        let response = reconciled_place_algo_response(&request, &order, execution_key, "recovered");
        assert_eq!(response.execution_key.as_deref(), Some(execution_key));
        assert_eq!(response.ord_id, "algo-placeholder");
        assert_eq!(response.cl_ord_id, client_id);
        assert_eq!(response.s_code, "0");

        let amend_result = reconciled_amend_algo_result(&order, "recovered");
        assert_eq!(amend_result.algo_id, "algo-placeholder");
        assert_eq!(amend_result.s_code, "0");
    }

    #[test]
    fn credential_fingerprint_rejects_blank_or_rotated_credentials() {
        let account = enabled_demo_account();
        let fingerprint = account_config_cache_fingerprint(&account);
        assert!(execution_credential_matches(&fingerprint, &account));
        assert!(!execution_credential_matches("", &account));

        let mut rotated = account.clone();
        rotated.api_key = "placeholder-rotated-key".to_string();
        assert!(!execution_credential_matches(&fingerprint, &rotated));
    }

    #[test]
    fn successful_order_identity_requires_matching_client_and_remote_ids() {
        let expected = "dtStableClientOrderId";
        let valid = OkxOrderResult {
            ord_id: "placeholder-order-id".to_string(),
            cl_ord_id: expected.to_string(),
            s_code: "0".to_string(),
            s_msg: String::new(),
            ts: "1".to_string(),
        };
        assert!(validate_order_result_identity(&valid, expected).is_ok());

        let mut missing_order_id = valid.clone();
        missing_order_id.ord_id.clear();
        assert!(validate_order_result_identity(&missing_order_id, expected).is_err());

        let mut wrong_client_id = valid;
        wrong_client_id.cl_ord_id = "dtOtherClientOrderId".to_string();
        assert!(validate_order_result_identity(&wrong_client_id, expected).is_err());
    }

    #[test]
    fn reconciliation_requires_exact_instrument_and_requested_identity() {
        let order = OkxPendingOrder {
            inst_id: "BTC-USDT-SWAP".to_string(),
            ord_id: "placeholder-order-id".to_string(),
            cl_ord_id: "dtStableClientOrderId".to_string(),
            ..Default::default()
        };
        assert!(validate_reconciled_order_identity(
            &order,
            "BTC-USDT-SWAP",
            None,
            Some("dtStableClientOrderId"),
            false,
        )
        .is_ok());
        assert!(validate_reconciled_order_identity(
            &order,
            "ETH-USDT-SWAP",
            None,
            Some("dtStableClientOrderId"),
            false,
        )
        .is_err());
        assert!(validate_reconciled_order_identity(
            &order,
            "BTC-USDT-SWAP",
            None,
            Some("dtOtherClientOrderId"),
            false,
        )
        .is_err());
    }

    #[test]
    fn execution_request_signature_rejects_parameter_changes() {
        let request = place_request("limit");
        let stored = serde_json::to_string(&request).unwrap();
        assert!(execution_request_signature_matches(&stored, &request).unwrap());

        let mut changed = serde_json::to_value(&request).unwrap();
        changed["size"] = json!("2");
        assert!(!execution_request_signature_matches(&changed.to_string(), &request).unwrap());
    }

    #[test]
    fn move_order_stop_is_algo_and_preserves_recovery_order_type() {
        assert!(is_algo_order_type("trigger"));
        assert!(is_algo_order_type("move_order_stop"));
        assert!(!is_algo_order_type("limit"));
        assert_eq!(
            recovered_order_type("move_order_stop", "trigger", true),
            "move_order_stop"
        );
    }

    #[test]
    fn trailing_callback_ratio_rejects_values_above_five_percent() {
        assert!(validate_trailing_callback_ratio("0.001").is_ok());
        assert!(validate_trailing_callback_ratio("0.05").is_ok());
        assert!(validate_trailing_callback_ratio("0.0500001").is_err());
        assert!(validate_trailing_callback_ratio("0").is_err());
    }

    #[test]
    fn hard_final_precheck_propagates_every_blocker() {
        let blockers = vec!["size 无效".to_string(), "tickSz 缺失".to_string()];
        let error = ensure_final_order_blockers(&blockers).unwrap_err();
        assert!(error.contains("size 无效"));
        assert!(error.contains("tickSz 缺失"));
        assert!(ensure_final_order_blockers(&[]).is_ok());
    }

    #[test]
    fn systematic_strategy_prices_are_normalized_to_instrument_tick_size() {
        assert_eq!(
            normalize_systematic_price(65_763.072, "0.1", "止盈价").unwrap(),
            65_763.0
        );
        assert_eq!(
            normalize_systematic_price(101.26, "0.25", "止盈价").unwrap(),
            101.25
        );
        assert!(normalize_systematic_price(0.05, "0.1", "止盈价").is_err());
    }

    #[test]
    fn hard_final_precheck_requires_exchange_trade_permission_and_derivatives_mode() {
        let valid = OkxAccountConfig {
            acct_lv: "2".to_string(),
            pos_mode: "net_mode".to_string(),
            perm: "read_only,trade".to_string(),
            ..Default::default()
        };
        assert!(final_account_config_blockers(&valid).is_empty());

        let without_trade = OkxAccountConfig {
            perm: "read_only".to_string(),
            ..valid.clone()
        };
        assert!(final_account_config_blockers(&without_trade)
            .iter()
            .any(|reason| reason.contains("trade 权限")));

        let spot_only = OkxAccountConfig {
            acct_lv: "1".to_string(),
            ..valid.clone()
        };
        assert!(final_account_config_blockers(&spot_only)
            .iter()
            .any(|reason| reason.contains("现货模式")));

        let unknown_position_mode = OkxAccountConfig {
            pos_mode: String::new(),
            ..valid
        };
        assert!(final_account_config_blockers(&unknown_position_mode)
            .iter()
            .any(|reason| reason.contains("持仓模式")));
    }

    #[test]
    fn hard_final_precheck_requires_positive_contract_risk_metadata() {
        let account = enabled_demo_account();
        let limit_request = place_request("limit");
        let valid = valid_swap_instrument();
        assert!(final_order_blockers(&account, &limit_request, &valid).is_empty());

        for (field, expected) in [
            ("ct_val", "ctVal"),
            ("lever", "lever"),
            ("max_lmt_sz", "maxLmtSz"),
        ] {
            for invalid in ["", "0", "-1", "not-a-number"] {
                let mut instrument = valid.clone();
                match field {
                    "ct_val" => instrument.ct_val = invalid.to_string(),
                    "lever" => instrument.lever = invalid.to_string(),
                    "max_lmt_sz" => instrument.max_lmt_sz = invalid.to_string(),
                    _ => unreachable!(),
                }
                assert!(
                    final_order_blockers(&account, &limit_request, &instrument)
                        .iter()
                        .any(|reason| reason.contains(expected)),
                    "{field}={invalid:?} must fail closed"
                );
            }
        }

        let market_request = place_request("market");
        for invalid in ["", "0", "-1", "not-a-number"] {
            let mut instrument = valid.clone();
            instrument.max_mkt_sz = invalid.to_string();
            assert!(
                final_order_blockers(&account, &market_request, &instrument)
                    .iter()
                    .any(|reason| reason.contains("maxMktSz")),
                "maxMktSz={invalid:?} must fail closed"
            );
        }
    }

    #[test]
    fn hard_final_precheck_binds_ticket_mode_to_action_and_exits() {
        let account = enabled_demo_account();
        let instrument = valid_swap_instrument();

        let mut forged_close = place_request("limit");
        forged_close.ticket_mode = "close".to_string();
        forged_close.action = "long".to_string();
        assert!(final_order_blockers(&account, &forged_close, &instrument)
            .iter()
            .any(|reason| reason.contains("交易模式与下单方向不一致")));

        let mut close_with_exit = place_request("limit");
        close_with_exit.ticket_mode = "close".to_string();
        close_with_exit.action = "close-long".to_string();
        close_with_exit.attach_algo_ords = Some(vec![AttachedAlgoOrder {
            attach_algo_cl_ord_id: Some("placeholderAttachedExit".to_string()),
            tp_trigger_px: Some("66000".to_string()),
            tp_ord_px: Some("-1".to_string()),
            tp_ord_kind: None,
            tp_trigger_px_type: Some("last".to_string()),
            sl_trigger_px: None,
            sl_ord_px: None,
            sl_trigger_px_type: None,
            sz: Some("1".to_string()),
        }]);
        assert!(
            final_order_blockers(&account, &close_with_exit, &instrument)
                .iter()
                .any(|reason| reason.contains("平仓委托不能附加"))
        );
    }

    #[test]
    fn hard_final_precheck_requires_stable_execution_key() {
        let account = enabled_demo_account();
        let instrument = valid_swap_instrument();
        let mut request = place_request("limit");
        request.execution_key = None;
        assert!(final_order_blockers(&account, &request, &instrument)
            .iter()
            .any(|reason| reason.contains("executionKey")));
    }

    #[test]
    fn advanced_order_spec_maps_to_hard_final_order_fields() {
        let mut post_only = place_request("limit");
        post_only.order_spec_v2 = Some(OrderSpecV2 {
            version: 2,
            requested_order_type: "post_only".to_string(),
            trigger: None,
            trailing: None,
            attached_exits: None,
            risk: None,
        });
        apply_order_spec_v2(&mut post_only).unwrap();
        assert_eq!(post_only.order_type, "post_only");

        let mut trigger = place_request("limit");
        trigger.order_spec_v2 = Some(OrderSpecV2 {
            version: 2,
            requested_order_type: "trigger".to_string(),
            trigger: Some(TriggerOrderSpecV2 {
                source: "mark".to_string(),
                trigger_price: "64000".to_string(),
                execution: "limit".to_string(),
                order_price: Some("63900".to_string()),
            }),
            trailing: None,
            attached_exits: None,
            risk: None,
        });
        apply_order_spec_v2(&mut trigger).unwrap();
        assert_eq!(trigger.order_type, "trigger");
        assert_eq!(trigger.price, "64000");

        let mut trailing = place_request("limit");
        trailing.order_spec_v2 = Some(OrderSpecV2 {
            version: 2,
            requested_order_type: "trailing".to_string(),
            trigger: None,
            trailing: Some(TrailingOrderSpecV2 {
                source: "last".to_string(),
                activation_price: Some("63000".to_string()),
                callback_ratio: "0.001".to_string(),
            }),
            attached_exits: None,
            risk: None,
        });
        apply_order_spec_v2(&mut trailing).unwrap();
        assert_eq!(trailing.order_type, "move_order_stop");
        assert_eq!(trailing.price, "63000");
    }

    #[test]
    fn missing_order_detection_is_conservative() {
        assert!(is_confirmed_missing_order_error(
            r#"{"desicTerminalError":true,"code":"51603","message":"Order does not exist"}"#
        ));
        assert!(!is_confirmed_missing_order_error(
            r#"{"desicTerminalError":true,"code":"50004","message":"Gateway timeout"}"#
        ));
        assert!(!is_confirmed_missing_order_error(
            "network connection reset"
        ));
    }

    #[test]
    fn close_position_environment_uses_the_actual_account_environment() {
        assert_eq!(
            validate_close_position_environment("demo", "simulated", None).as_deref(),
            Ok("demo")
        );
        assert_eq!(
            validate_close_position_environment("live", "live", Some(true)).as_deref(),
            Ok("live")
        );
        assert_eq!(
            validate_close_position_environment("live", "demo", Some(true)).unwrap_err(),
            "账号环境与当前交易环境不一致"
        );
        assert_eq!(
            validate_close_position_environment("live", "live", None).unwrap_err(),
            "实盘市价全平缺少二次确认标记"
        );
    }

    #[test]
    fn close_position_direction_uses_signed_net_position_size() {
        assert_eq!(close_position_action("long", 2.0), "close-long");
        assert_eq!(close_position_action("short", 2.0), "close-short");
        assert_eq!(close_position_action("net", 2.0), "close-long");
        assert_eq!(close_position_action("net", -2.0), "close-short");

        let (short_side, short_pos_side, short_reduce_only) =
            order_direction(close_position_action("net", -2.0), "net_mode").unwrap();
        assert_eq!(short_side, "buy");
        assert_eq!(short_pos_side, None);
        assert_eq!(short_reduce_only, Some(true));

        let (long_side, long_pos_side, long_reduce_only) =
            order_direction(close_position_action("net", 2.0), "net_mode").unwrap();
        assert_eq!(long_side, "sell");
        assert_eq!(long_pos_side, None);
        assert_eq!(long_reduce_only, Some(true));
    }

    #[test]
    fn close_position_fallback_only_accepts_confirmed_non_retryable_order_rejections() {
        let parameter_rejection = classified_okx_error(
            "okx_trade_order",
            "下单",
            "51008",
            "Order placement failed due to invalid position size",
        );
        assert_eq!(
            confirmed_close_position_rejection(&parameter_rejection),
            Some(ConfirmedClosePositionRejection {
                code: "51008".to_string(),
                message: "Order placement failed due to invalid position size".to_string(),
            })
        );

        let balance_rejection = classified_okx_error(
            "okx_trade_order",
            "下单",
            "51131",
            "Insufficient available position",
        );
        assert!(confirmed_close_position_rejection(&balance_rejection).is_some());

        let service_error =
            classified_okx_error("okx_trade_order", "下单", "50004", "Gateway timeout");
        assert!(confirmed_close_position_rejection(&service_error).is_none());

        let auth_error =
            classified_okx_error("okx_trade_order", "下单", "50113", "Invalid signature");
        assert!(confirmed_close_position_rejection(&auth_error).is_none());

        let wrong_source = classified_okx_error(
            "okx_private_post",
            "/api/v5/trade/order",
            "51008",
            "Order placement failed",
        );
        assert!(confirmed_close_position_rejection(&wrong_source).is_none());
        assert!(confirmed_close_position_rejection("network connection reset").is_none());
        assert!(confirmed_close_position_rejection(
            "OKX 返回重复 clOrdId，订单结果需要按稳定 ID 对账"
        )
        .is_none());
    }

    #[test]
    fn margin_rejection_records_the_estimated_required_usdt_margin() {
        let mut request = place_request("limit");
        request.price = "64866.6".to_string();
        let mut instrument = valid_swap_instrument();
        instrument.ct_type = "linear".to_string();
        instrument.settle_ccy = "USDT".to_string();

        let encoded = classified_order_rejection_with_required_margin(
            &request,
            &instrument,
            "okx_trade_order",
            "下单",
            "51008",
            "Order failed. Insufficient USDT margin in account",
        );
        let payload: Value = serde_json::from_str(&encoded).expect("classified margin error");
        assert_eq!(payload["category"], "risk_or_balance");
        assert!(payload["userMessage"]
            .as_str()
            .unwrap_or_default()
            .contains("需要保证金："));
        assert!(payload["suggestion"]
            .as_str()
            .unwrap_or_default()
            .contains("USDT"));
    }

    #[test]
    fn exact_decimal_precheck_accepts_float_backed_tick_price() {
        let mut request = place_request("limit");
        request.price = trim_float(64_866.6);
        let instrument = valid_swap_instrument();
        assert!(exact_order_decimal_blockers(&request, &instrument).is_empty());
    }

    #[test]
    fn amend_reconciliation_requires_every_requested_field_to_match() {
        let mut order = OkxPendingOrder {
            sz: "2.000".to_string(),
            px: "65000.0".to_string(),
            ..Default::default()
        };
        let request = AmendOrderRequest {
            account_id: None,
            environment: "demo".to_string(),
            inst_id: "BTC-USDT-SWAP".to_string(),
            ord_id: Some("ord-1".to_string()),
            cl_ord_id: None,
            new_size: Some("2".to_string()),
            new_price: Some("65000".to_string()),
            confirmed_live: None,
            operator: Some("ai".to_string()),
            opportunity_id: Some("opp-1".to_string()),
            opportunity_revision: Some(1),
            agent_run_id: Some("run-1".to_string()),
            execution_key: Some("key-1".to_string()),
            execution_leg: Some("primary".to_string()),
            reason: Some("test".to_string()),
        };
        assert!(amend_matches_order(&request, &order));
        order.px = "64999".to_string();
        assert!(!amend_matches_order(&request, &order));
    }
}

#[tauri::command]
pub async fn trade_precheck(
    app: tauri::AppHandle,
    request: TradePrecheckRequest,
    runtime: tauri::State<'_, MarketRuntime>,
) -> Result<TradePrecheckResponse, String> {
    let total_started = Instant::now();
    let mut reasons = Vec::new();
    let mut warnings = Vec::new();
    let mut snapshot: Option<PrivateAccountSnapshot> = None;
    let mut available_usdt = None;
    let mut usdt_equity = None;
    let mut long_available = None;
    let mut short_available = None;
    let mut account_config = None;
    let mut fee_summary = None;
    let mut max_order = None;
    let mut leverage_info = None;
    let mut position_tiers: Vec<OkxPositionTier> = Vec::new();
    let mut position_tier = None;
    let mut snapshot_source = "unavailable".to_string();
    let mut account_config_cache_hit = false;

    reasons.extend(market_health_blockers(
        runtime.inner(),
        &request.environment,
    ));

    let instrument_started = Instant::now();
    let instrument = fetch_instrument(&app, &request.inst_id).await?;
    let instrument_ms = instrument_started.elapsed().as_millis() as u64;
    if !instrument.inst_type.eq_ignore_ascii_case("SWAP") {
        reasons.push("当前只支持 OKX 永续合约 SWAP".to_string());
    }
    if !instrument.state.is_empty() && !instrument.state.eq_ignore_ascii_case("live") {
        reasons.push(format!("合约当前不可交易：{}", instrument.state));
    }

    let account = match load_local_account_secret(&app, request.account_id.as_deref()) {
        Ok(account) => Some(account),
        Err(err) => {
            reasons.push(if err.contains("no OKX account") {
                "未配置 OKX 账号".to_string()
            } else {
                err
            });
            None
        }
    };

    let account_context_started = Instant::now();
    if let Some(account) = account.as_ref() {
        if account.exchange.to_lowercase() != "okx" {
            reasons.push(format!("不支持的交易所：{}", account.exchange));
        }
        if normalize_environment(&account.environment)
            != normalize_environment(&request.environment)
        {
            reasons.push("账号环境与当前交易环境不一致".to_string());
        }
        if !account.permissions.read {
            reasons.push("账号缺少读取权限".to_string());
        }
        if !account.permissions.trade {
            warnings.push("账号未开启交易权限，真实下单会被阻止".to_string());
        }
        if account.permissions.read {
            let memory_snapshot =
                ai_read_memory_account_snapshot(runtime.inner(), Some(&account.id)).filter(
                    |snapshot| {
                        normalize_environment(&snapshot.environment)
                            == normalize_environment(&account.environment)
                            && now_ms().saturating_sub(snapshot.synced_at)
                                <= TRADE_PRECHECK_SNAPSHOT_MAX_AGE_MS
                    },
                );
            let snapshot_is_memory = memory_snapshot.is_some();
            let (config_result, snapshot_result) =
                tokio::join!(cached_okx_account_config(runtime.inner(), account), async {
                    match memory_snapshot {
                        Some(snapshot) => Ok(snapshot),
                        None => fetch_private_account_snapshot(account).await,
                    }
                });
            match config_result {
                Ok((config, cache_hit)) => {
                    account_config_cache_hit = cache_hit;
                    if !config.perm.split(',').any(|perm| perm.trim() == "trade") {
                        reasons.push("OKX API Key 未包含 trade 权限".to_string());
                    }
                    if config.acct_lv == "1" {
                        reasons.push("当前账户为现货模式，不能交易永续合约".to_string());
                    }
                    if config.acct_lv == "4" && request.td_mode == "cross" {
                        warnings.push(
                            "组合保证金账户全仓最大可买卖数量可能无法由 OKX 计算".to_string(),
                        );
                    }
                    account_config = Some(OkxAccountConfigSummary {
                        acct_lv: config.acct_lv,
                        pos_mode: config.pos_mode,
                        perm: config.perm,
                        acct_stp_mode: config.acct_stp_mode,
                        ct_iso_mode: config.ct_iso_mode,
                        fee_type: config.fee_type,
                        level: config.level,
                        stgy_type: config.stgy_type,
                        liquidation_gear: config.liquidation_gear,
                        liquidation_gear_meaning:
                            "强平风险提醒的维持保证金率档位，不是强平价或强平计算状态".to_string(),
                    });
                }
                Err(err) => warnings.push(format!("账户配置读取失败：{}", err)),
            }
            match snapshot_result {
                Ok(data) => {
                    snapshot_source = if snapshot_is_memory {
                        "private-ws-memory"
                    } else {
                        "okx-private-rest"
                    }
                    .to_string();
                    let usdt_balance = data
                        .balances
                        .iter()
                        .find(|balance| balance.ccy.eq_ignore_ascii_case("USDT"));
                    available_usdt = usdt_balance.and_then(available_balance_value);
                    usdt_equity = usdt_balance.and_then(|balance| parse_optional_f64(&balance.eq));
                    long_available = position_available(&data.positions, &request.inst_id, "long");
                    short_available =
                        position_available(&data.positions, &request.inst_id, "short");
                    snapshot = Some(data);
                }
                Err(err) => warnings.push(format!(
                    "账户快照同步失败：{}；已跳过余额/持仓本地校验，最终以 OKX 下单返回为准",
                    err
                )),
            }
        }
    }
    let account_context_ms = account_context_started.elapsed().as_millis() as u64;

    let price = request.price.trim().parse::<f64>().ok();
    let stop_price = request
        .stop_price
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<f64>().ok());
    let size = request.size.trim().parse::<f64>().ok();
    let lever = request.lever.trim().parse::<f64>().ok();
    let min_size = parse_optional_f64(&instrument.min_sz);
    let lot_size = parse_optional_f64(&instrument.lot_sz);
    let tick_size = parse_optional_f64(&instrument.tick_sz);
    let max_lever = parse_optional_f64(&instrument.lever);
    let max_size = if request.order_type == "market" {
        parse_optional_f64(&instrument.max_mkt_sz)
    } else {
        parse_optional_f64(&instrument.max_lmt_sz)
    };

    let limits_started = Instant::now();
    let tier_path = if instrument.inst_family.trim().is_empty() {
        None
    } else {
        Some(format!(
            "/api/v5/public/position-tiers?tdMode={}&instType=SWAP&instFamily={}",
            url_encode(&request.td_mode),
            url_encode(&instrument.inst_family)
        ))
    };
    let query_px = price
        .map(trim_float)
        .unwrap_or_else(|| request.price.clone());
    let max_size_path = format!(
        "/api/v5/account/max-size?instId={}&tdMode={}&px={}&leverage={}",
        url_encode(&request.inst_id),
        url_encode(&request.td_mode),
        url_encode(&query_px),
        url_encode(&request.lever)
    );
    let max_avail_path = format!(
        "/api/v5/account/max-avail-size?instId={}&tdMode={}",
        url_encode(&request.inst_id),
        url_encode(&request.td_mode)
    );
    let fee_path = if instrument.inst_family.trim().is_empty() {
        "/api/v5/account/trade-fee?instType=SWAP".to_string()
    } else {
        format!(
            "/api/v5/account/trade-fee?instType=SWAP&instFamily={}",
            url_encode(&instrument.inst_family)
        )
    };
    let lever_path = leverage_info_path(&request.inst_id, &request.td_mode);
    let readable_account = account.as_ref().filter(|account| account.permissions.read);
    let (tiers_result, max_size_result, max_avail_result, fee_result, leverage_result) = tokio::join!(
        async {
            match tier_path.as_deref() {
                Some(path) => get_json::<OkxPositionTier>(path)
                    .await
                    .map(|envelope| Some(envelope.data)),
                None => Ok(None),
            }
        },
        async {
            match readable_account {
                Some(account) => okx_private_get::<OkxMaxSize>(account, &max_size_path)
                    .await
                    .map(Some),
                None => Ok(None),
            }
        },
        async {
            match readable_account {
                Some(account) => okx_private_get::<OkxMaxAvailSize>(account, &max_avail_path)
                    .await
                    .map(Some),
                None => Ok(None),
            }
        },
        async {
            match readable_account {
                Some(account) => okx_private_get::<OkxTradeFee>(account, &fee_path)
                    .await
                    .map(Some),
                None => Ok(None),
            }
        },
        async {
            match readable_account {
                Some(account) => okx_private_get::<OkxLeverageInfo>(account, &lever_path)
                    .await
                    .map(Some),
                None => Ok(None),
            }
        }
    );
    match tiers_result {
        Ok(Some(rows)) => position_tiers = rows,
        Ok(None) => {}
        Err(err) => warnings.push(format!("仓位档位读取失败：{}", err)),
    }
    match max_size_result {
        Ok(Some(envelope)) => {
            if let Some(item) = envelope.data.into_iter().next() {
                max_order = Some(OkxMaxOrderSummary {
                    max_buy: parse_optional_f64(&item.max_buy),
                    max_sell: parse_optional_f64(&item.max_sell),
                    avail_buy: None,
                    avail_sell: None,
                });
            }
        }
        Ok(None) => {}
        Err(err) => warnings.push(format!("最大可开仓张数读取失败：{}", err)),
    }
    match max_avail_result {
        Ok(Some(envelope)) => {
            if let Some(item) = envelope.data.into_iter().next() {
                match max_order.as_mut() {
                    Some(summary) => {
                        summary.avail_buy = parse_optional_f64(&item.avail_buy);
                        summary.avail_sell = parse_optional_f64(&item.avail_sell);
                    }
                    None => {
                        max_order = Some(OkxMaxOrderSummary {
                            max_buy: None,
                            max_sell: None,
                            avail_buy: parse_optional_f64(&item.avail_buy),
                            avail_sell: parse_optional_f64(&item.avail_sell),
                        });
                    }
                }
            }
        }
        Ok(None) => {}
        Err(err) => warnings.push(format!("最大可用保证金读取失败：{}", err)),
    }
    match fee_result {
        Ok(Some(envelope)) => {
            if let Some(fee) = envelope.data.into_iter().next() {
                let grouped = fee.fee_group.first();
                let maker = grouped
                    .and_then(|group| parse_optional_f64(&group.maker))
                    .or_else(|| parse_optional_f64(&fee.maker_u))
                    .or_else(|| parse_optional_f64(&fee.maker));
                let taker = grouped
                    .and_then(|group| parse_optional_f64(&group.taker))
                    .or_else(|| parse_optional_f64(&fee.taker_u))
                    .or_else(|| parse_optional_f64(&fee.taker));
                fee_summary = Some(OkxTradeFeeSummary {
                    maker,
                    taker,
                    group_id: grouped
                        .map(|group| group.group_id.clone())
                        .filter(|value| !value.is_empty()),
                    level: fee.level,
                    ts: fee.ts,
                });
            }
        }
        Ok(None) => {}
        Err(err) => warnings.push(format!("手续费率读取失败：{}", err)),
    }
    match leverage_result {
        Ok(Some(envelope)) if !envelope.data.is_empty() => {
            leverage_info = Some(envelope.data);
        }
        Ok(_) => {}
        Err(err) => warnings.push(format!("当前杠杆读取失败：{}", err)),
    }
    let limits_ms = limits_started.elapsed().as_millis() as u64;

    if request.td_mode != "cross" && request.td_mode != "isolated" {
        reasons.push("保证金模式必须是 cross 或 isolated".to_string());
    }
    if !["limit", "market", "trigger"].contains(&request.order_type.as_str()) {
        reasons.push("委托类型无效".to_string());
    }
    if !["open", "close"].contains(&request.ticket_mode.as_str()) {
        reasons.push("交易模式必须是开仓或平仓".to_string());
    }
    if !matches!(price, Some(value) if value > 0.0) {
        reasons.push("价格无效".to_string());
    }
    if request
        .stop_price
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
        && !matches!(stop_price, Some(value) if value > 0.0)
    {
        reasons.push("止损价格无效".to_string());
    }
    if let (Some(entry), Some(stop), Some(action)) = (price, stop_price, request.action.as_deref())
    {
        if (action == "long" && stop >= entry) || (action == "short" && stop <= entry) {
            reasons.push("止损价格方向与开仓方向不一致".to_string());
        }
    }
    if !matches!(size, Some(value) if value > 0.0) {
        reasons.push("请输入下单张数".to_string());
    }
    if !matches!(lever, Some(value) if value > 0.0) {
        reasons.push("杠杆无效".to_string());
    }
    if let (Some(size), Some(min_size)) = (size, min_size) {
        if size < min_size {
            reasons.push(format!("下单张数低于最小值 {}", trim_float(min_size)));
        }
    }
    if let (Some(size), Some(lot_size)) = (size, lot_size) {
        if !is_multiple_of(size, lot_size) {
            reasons.push(format!(
                "下单张数必须是 lotSz {} 的整数倍",
                trim_float(lot_size)
            ));
        }
    }
    if request.order_type != "market" {
        if let (Some(price), Some(tick_size)) = (price, tick_size) {
            if !is_multiple_of(price, tick_size) {
                reasons.push(format!(
                    "限价价格必须是 tickSz {} 的整数倍",
                    trim_float(tick_size)
                ));
            }
        }
    }
    if let (Some(stop), Some(tick_size)) = (stop_price, tick_size) {
        if !is_multiple_of(stop, tick_size) {
            reasons.push(format!(
                "止损价格必须按 tickSz {} 对齐",
                trim_float(tick_size)
            ));
        }
    }
    if let (Some(size), Some(max_size)) = (size, max_size) {
        if max_size > 0.0 && size > max_size {
            reasons.push(format!(
                "下单张数超过当前委托类型上限 {}",
                trim_float(max_size)
            ));
        }
    }
    if let (Some(lever), Some(max_lever)) = (lever, max_lever) {
        if max_lever > 0.0 && lever > max_lever {
            reasons.push(format!("杠杆超过合约最大杠杆 {}X", trim_float(max_lever)));
        }
    }
    if let Some(size) = size {
        if let Some(tier) = select_position_tier(&position_tiers, size) {
            if let (Some(lever), Some(tier_max_lever)) =
                (lever, parse_optional_f64(&tier.max_lever))
            {
                if tier_max_lever > 0.0 && lever > tier_max_lever {
                    reasons.push(format!(
                        "当前张数落在仓位档位 {}，最高可用杠杆为 {}X",
                        tier.tier,
                        trim_float(tier_max_lever)
                    ));
                }
            }
            if let Some(tier_imr) = parse_optional_f64(&tier.imr) {
                if let Some(notional) =
                    match (price, Some(size), parse_optional_f64(&instrument.ct_val)) {
                        (Some(price), Some(size), Some(ct_val))
                            if instrument.ct_type.eq_ignore_ascii_case("linear")
                                || instrument.settle_ccy.eq_ignore_ascii_case("USDT") =>
                        {
                            Some(size * ct_val * price)
                        }
                        (_, Some(size), Some(ct_val))
                            if instrument.ct_type.eq_ignore_ascii_case("inverse") =>
                        {
                            Some(size * ct_val)
                        }
                        _ => None,
                    }
                {
                    let tier_margin = notional * tier_imr;
                    if let Some(estimated) = estimated_margin_candidate(notional, lever) {
                        if estimated < tier_margin {
                            warnings.push(format!(
                                "档位 {} 最低初始保证金约 {}，当前杠杆估算保证金低于档位要求",
                                tier.tier,
                                trim_float(tier_margin)
                            ));
                        }
                    }
                }
            }
            position_tier = Some(OkxPositionTierSummary {
                tier: tier.tier.clone(),
                min_sz: tier.min_sz.clone(),
                max_sz: tier.max_sz.clone(),
                mmr: tier.mmr.clone(),
                imr: tier.imr.clone(),
                max_lever: tier.max_lever.clone(),
            });
        }
    }
    if let (Some(selected_lever), Some(current_rows)) = (lever, leverage_info.as_ref()) {
        if !leverage_rows_match(
            current_rows,
            selected_lever,
            account_config
                .as_ref()
                .map(|config| config.pos_mode.as_str()),
        ) {
            let current = format_leverage_rows(current_rows);
            reasons.push(format!(
                "OKX 当前杠杆未同步：{}，请先同步到 {}X",
                current,
                trim_float(selected_lever)
            ));
        }
    }
    if request.ticket_mode == "open" {
        if let (Some(size), Some(max_order)) = (size, max_order.as_ref()) {
            let max_direction = match request.action.as_deref() {
                Some("short") => max_order.max_sell,
                _ => max_order.max_buy,
            };
            if let Some(limit) = max_direction {
                if size > limit {
                    reasons.push(format!("超过 OKX 当前最大可开仓张数 {}", trim_float(limit)));
                }
            }
        }
    }

    if request.ticket_mode == "close" {
        match request.action.as_deref() {
            Some("close-long") if long_available.unwrap_or(0.0) <= 0.0 => {
                reasons.push("当前没有可平多仓".to_string())
            }
            Some("close-short") if short_available.unwrap_or(0.0) <= 0.0 => {
                reasons.push("当前没有可平空仓".to_string())
            }
            _ if long_available.unwrap_or(0.0) <= 0.0 && short_available.unwrap_or(0.0) <= 0.0 => {
                reasons.push("当前没有可平持仓".to_string())
            }
            _ => {}
        }
    }

    let max_single_trade_margin_pct = request
        .max_single_trade_margin_pct
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value.clamp(1.0, 100.0));
    let taker_entry = matches!(request.order_type.as_str(), "market" | "trigger");
    let actual_entry_fee_rate =
        fee_summary
            .as_ref()
            .and_then(|fee| if taker_entry { fee.taker } else { fee.maker });
    let actual_exit_fee_rate = fee_summary.as_ref().and_then(|fee| fee.taker);
    let fee_rate = actual_entry_fee_rate
        .map(f64::abs)
        .unwrap_or(if taker_entry { 0.0005 } else { 0.0002 });
    let exit_fee_rate = actual_exit_fee_rate.map(f64::abs).unwrap_or(0.0005);
    let fee_rate_source = match (actual_entry_fee_rate, actual_exit_fee_rate) {
        (Some(_), Some(_)) => "okx-trade-fee",
        (None, None) => "conservative-default",
        _ => "okx-trade-fee+fallback",
    };
    let is_linear_usdt = instrument.ct_type.eq_ignore_ascii_case("linear")
        && instrument.settle_ccy.eq_ignore_ascii_case("USDT");
    let perpetual_evaluation = if is_linear_usdt {
        let evaluation_request = desic_trade_domain::LinearUsdtPerpetualEvaluationRequest {
            size: request.size.clone(),
            entry_price: request.price.clone(),
            contract_value: instrument.ct_val.clone(),
            leverage: request.lever.clone(),
            min_size: instrument.min_sz.clone(),
            lot_size: instrument.lot_sz.clone(),
            equity: usdt_equity.map(trim_float),
            available_usdt: available_usdt.map(trim_float),
            max_single_trade_margin_pct: max_single_trade_margin_pct.map(trim_float),
            direction: match request.action.as_deref() {
                Some("long") => Some(desic_trade_domain::LinearUsdtDirection::Long),
                Some("short") => Some(desic_trade_domain::LinearUsdtDirection::Short),
                _ => None,
            },
            stop_price: request
                .stop_price
                .as_ref()
                .filter(|value| !value.trim().is_empty())
                .cloned(),
            target_price: request
                .target_price
                .as_ref()
                .filter(|value| !value.trim().is_empty())
                .cloned(),
            atr: request
                .atr
                .as_ref()
                .filter(|value| !value.trim().is_empty())
                .cloned(),
            entry_fee_rate: trim_float(fee_rate),
            exit_fee_rate: trim_float(exit_fee_rate),
        };
        match desic_trade_domain::evaluate_linear_usdt_perpetual(&evaluation_request) {
            Ok(evaluation) => Some(evaluation),
            Err(error) => {
                reasons.push(format!("永续合约风险评估失败：{error}"));
                None
            }
        }
    } else {
        if instrument.ct_type.eq_ignore_ascii_case("inverse") {
            warnings
                .push("反向合约仅估算 USD 名义价值，当前产品优先支持 USDT 线性永续".to_string());
        }
        None
    };
    let metric_number = |value: Option<&String>| value.and_then(|value| parse_optional_f64(value));
    let notional = perpetual_evaluation
        .as_ref()
        .and_then(|evaluation| parse_optional_f64(&evaluation.candidate.notional_usdt))
        .or_else(|| match (size, parse_optional_f64(&instrument.ct_val)) {
            (Some(size), Some(ct_val)) if instrument.ct_type.eq_ignore_ascii_case("inverse") => {
                Some(size * ct_val)
            }
            _ => None,
        });
    let estimated_margin = perpetual_evaluation.as_ref().and_then(|evaluation| {
        parse_optional_f64(&evaluation.candidate.estimated_initial_margin_usdt)
    });
    let max_single_trade_margin = perpetual_evaluation.as_ref().and_then(|evaluation| {
        metric_number(evaluation.capacity.max_single_trade_margin_usdt.as_ref())
    });
    let max_single_trade_notional = perpetual_evaluation.as_ref().and_then(|evaluation| {
        metric_number(evaluation.capacity.max_single_trade_notional_usdt.as_ref())
    });
    let directional_okx_limit =
        max_order
            .as_ref()
            .and_then(|summary| match request.action.as_deref() {
                Some("short") => summary.max_sell,
                _ => summary.max_buy,
            });
    let max_single_trade_size = if instrument.ct_type.eq_ignore_ascii_case("linear")
        || instrument.settle_ccy.eq_ignore_ascii_case("USDT")
    {
        profile_single_trade_size_limit(
            max_single_trade_notional,
            price,
            parse_optional_f64(&instrument.ct_val),
            lot_size,
            max_size,
            directional_okx_limit,
        )
    } else {
        None
    };
    let estimated_fee = perpetual_evaluation
        .as_ref()
        .and_then(|evaluation| parse_optional_f64(&evaluation.candidate.estimated_entry_fee_usdt));
    let estimated_round_trip_fee = perpetual_evaluation.as_ref().and_then(|evaluation| {
        parse_optional_f64(&evaluation.candidate.estimated_round_trip_fee_usdt)
    });
    let stop_distance = perpetual_evaluation
        .as_ref()
        .and_then(|evaluation| metric_number(evaluation.candidate.stop_distance.as_ref()));
    let estimated_stop_loss = perpetual_evaluation.as_ref().and_then(|evaluation| {
        metric_number(
            evaluation
                .candidate
                .estimated_price_loss_at_stop_usdt
                .as_ref(),
        )
    });
    let estimated_stop_loss_with_fees = perpetual_evaluation.as_ref().and_then(|evaluation| {
        metric_number(
            evaluation
                .candidate
                .estimated_stop_loss_with_fees_usdt
                .as_ref(),
        )
    });
    let stop_loss_pct_of_usdt_equity = perpetual_evaluation.as_ref().and_then(|evaluation| {
        metric_number(evaluation.candidate.stop_risk_pct_of_equity.as_ref())
    });
    let break_even_price = perpetual_evaluation
        .as_ref()
        .and_then(|evaluation| metric_number(evaluation.candidate.break_even_price.as_ref()));
    let estimated_net_profit_at_target = perpetual_evaluation.as_ref().and_then(|evaluation| {
        metric_number(
            evaluation
                .candidate
                .estimated_net_profit_at_target_usdt
                .as_ref(),
        )
    });
    let fee_drag_pct_of_gross_profit = perpetual_evaluation.as_ref().and_then(|evaluation| {
        metric_number(evaluation.candidate.fee_drag_pct_of_gross_profit.as_ref())
    });
    let net_reward_risk_ratio = perpetual_evaluation
        .as_ref()
        .and_then(|evaluation| metric_number(evaluation.candidate.net_reward_risk_ratio.as_ref()));

    if request.ticket_mode == "open" {
        if perpetual_evaluation
            .as_ref()
            .and_then(|evaluation| evaluation.capacity.candidate_within_available)
            == Some(false)
        {
            reasons.push(format!(
                "可用 USDT 保证金不足；需要保证金：{} USDT",
                estimated_margin
                    .map(trim_float)
                    .unwrap_or_else(|| "--".to_string())
            ));
        }
        if max_single_trade_margin_pct.is_some() {
            match perpetual_evaluation
                .as_ref()
                .and_then(|evaluation| evaluation.capacity.candidate_within_profile_limit)
            {
                Some(false) => {
                    reasons.push(format!(
                        "预计保证金 {} USDT 超过 Profile 最大单笔开仓上限 {} USDT",
                        estimated_margin
                            .map(trim_float)
                            .unwrap_or_else(|| "--".to_string()),
                        max_single_trade_margin
                            .map(trim_float)
                            .unwrap_or_else(|| "--".to_string())
                    ));
                }
                None => reasons.push(
                    "无法读取 USDT 权益或可用余额，不能校验 Profile 最大单笔开仓占比".to_string(),
                ),
                _ => {}
            }
        }
    }
    if fee_rate_source == "okx-trade-fee" {
        warnings.push("手续费率来自 OKX trade-fee，最终以实际成交为准".to_string());
    } else if !taker_entry {
        warnings.push("普通限价单手续费按默认 maker 费率估算，最终以 OKX 成交为准".to_string());
    } else {
        warnings.push("市价或触发单手续费按默认 taker 费率估算，最终以 OKX 成交为准".to_string());
    }
    if stop_price.is_some() {
        warnings
            .push("止损风险估算包含双边手续费，不包含滑点和资金费；最终以实际成交为准".to_string());
    }
    if request.target_price.is_some() {
        warnings.push("目标净收益已扣除入场与目标退出手续费，但不包含滑点和资金费".to_string());
    }
    warnings.push(
        "liquidationGear 是强平风险提醒档位，不是强平价；空仓时没有可读取的 OKX liqPx".to_string(),
    );
    if snapshot.is_none() && account.is_some() {
        warnings.push("缺少账户快照时只能完成合约规则预检".to_string());
    }

    let normalized_price = price
        .zip(tick_size)
        .map(|(value, tick)| round_down_step(value, tick));
    let normalized_size = size
        .zip(lot_size)
        .map(|(value, lot)| round_down_step(value, lot));
    let instrument_summary = instrument_summary_from(instrument, None, false, now_ms());

    let timing = TradePrecheckTiming {
        total_ms: total_started.elapsed().as_millis() as u64,
        instrument_ms,
        account_context_ms,
        limits_ms,
        snapshot_source,
        account_config_cache_hit,
    };

    Ok(TradePrecheckResponse {
        ok: reasons.is_empty(),
        blocked: !reasons.is_empty(),
        reasons,
        warnings,
        notional,
        estimated_margin,
        max_single_trade_margin_pct,
        max_single_trade_margin,
        max_single_trade_notional,
        max_single_trade_size,
        estimated_fee,
        usdt_equity,
        stop_price,
        stop_distance,
        estimated_stop_loss,
        estimated_round_trip_fee,
        estimated_stop_loss_with_fees,
        stop_loss_pct_of_usdt_equity,
        break_even_price,
        estimated_net_profit_at_target,
        fee_drag_pct_of_gross_profit,
        net_reward_risk_ratio,
        fee_rate_source: fee_rate_source.to_string(),
        perpetual_evaluation,
        liquidation_text: "空仓时没有 OKX liqPx；开仓后以 OKX 实时风险数据为准".to_string(),
        available_usdt,
        long_available,
        short_available,
        normalized_price,
        normalized_size,
        instrument: Some(instrument_summary),
        account_config,
        fee: fee_summary,
        max_order,
        leverage_info,
        position_tier,
        timing: Some(timing),
        source: "cached-instrument+account-config-cache+fresh-private-snapshot+parallel-position-tiers+trade-fee+max-size+leverage-info".to_string(),
    })
}

fn profile_single_trade_size_limit(
    max_notional: Option<f64>,
    price: Option<f64>,
    contract_value: Option<f64>,
    lot_size: Option<f64>,
    instrument_limit: Option<f64>,
    okx_limit: Option<f64>,
) -> Option<String> {
    let (Some(max_notional), Some(price), Some(contract_value)) =
        (max_notional, price, contract_value)
    else {
        return None;
    };
    if !max_notional.is_finite()
        || !price.is_finite()
        || !contract_value.is_finite()
        || max_notional < 0.0
        || price <= 0.0
        || contract_value <= 0.0
    {
        return None;
    }
    let mut size_limit = max_notional / (price * contract_value);
    for limit in [instrument_limit, okx_limit]
        .into_iter()
        .flatten()
        .filter(|value| value.is_finite() && *value > 0.0)
    {
        size_limit = size_limit.min(limit);
    }
    let aligned = lot_size
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|lot| (size_limit / lot).floor() * lot)
        .unwrap_or(size_limit)
        .max(0.0);
    Some(trim_float(aligned))
}
