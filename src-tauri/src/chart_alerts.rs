use super::*;

const MAX_INDICATOR_ALERT_LOOKBACK: usize = 500;

#[derive(Clone)]
struct ActivePriceAlert {
    id: String,
    workspace_id: String,
    view_id: Option<String>,
    last_triggered_at: Option<i64>,
    updated_at: i64,
    definition: Value,
    inst_id: String,
    trigger_price: f64,
    direction: String,
    cooldown_ms: i64,
    expires_at: Option<i64>,
}

#[derive(Default)]
struct ActivePriceAlertCache {
    initialized: bool,
    by_instrument: HashMap<String, Vec<ActivePriceAlert>>,
    last_prices: HashMap<String, f64>,
}

impl ActivePriceAlertCache {
    fn replace_all(&mut self, alerts: Vec<ActivePriceAlert>) {
        self.by_instrument.clear();
        self.last_prices.clear();
        for alert in alerts {
            self.by_instrument
                .entry(alert.inst_id.clone())
                .or_default()
                .push(alert);
        }
        self.initialized = true;
    }

    fn upsert(&mut self, alert: ActivePriceAlert) {
        self.remove_alert(&alert.id);
        self.by_instrument
            .entry(alert.inst_id.clone())
            .or_default()
            .push(alert);
    }

    fn remove_alert(&mut self, alert_id: &str) {
        self.remove_matching(|alert| alert.id == alert_id);
    }

    fn remove_workspace(&mut self, workspace_id: &str) {
        self.remove_matching(|alert| alert.workspace_id == workspace_id);
    }

    fn remove_workspace_view(&mut self, workspace_id: &str, view_id: &str) {
        self.remove_matching(|alert| {
            alert.workspace_id == workspace_id
                && alert
                    .view_id
                    .as_deref()
                    .is_some_and(|candidate| candidate == view_id)
        });
    }

    fn remove_matching(&mut self, mut matches: impl FnMut(&ActivePriceAlert) -> bool) {
        let mut removed_ids = Vec::new();
        self.by_instrument.retain(|_, alerts| {
            alerts.retain(|alert| {
                if matches(alert) {
                    removed_ids.push(alert.id.clone());
                    false
                } else {
                    true
                }
            });
            !alerts.is_empty()
        });
        for alert_id in removed_ids {
            self.last_prices.remove(&alert_id);
        }
    }

    fn observations_for_ticker(
        &mut self,
        inst_id: &str,
        current: f64,
    ) -> Vec<(ActivePriceAlert, Option<f64>)> {
        let alerts = self.by_instrument.get(inst_id).cloned().unwrap_or_default();
        alerts
            .into_iter()
            .map(|alert| {
                let previous = self.last_prices.insert(alert.id.clone(), current);
                (alert, previous)
            })
            .collect()
    }

    fn mark_triggered(&mut self, alert_id: &str, frequency: &str, now: i64) {
        if frequency == "once" {
            self.remove_alert(alert_id);
            return;
        }
        for alerts in self.by_instrument.values_mut() {
            if let Some(alert) = alerts.iter_mut().find(|alert| alert.id == alert_id) {
                alert.last_triggered_at = Some(now);
                alert.updated_at = now;
                return;
            }
        }
    }
}

static ACTIVE_PRICE_ALERT_CACHE: std::sync::OnceLock<std::sync::Mutex<ActivePriceAlertCache>> =
    std::sync::OnceLock::new();

fn active_price_alert_cache() -> &'static std::sync::Mutex<ActivePriceAlertCache> {
    ACTIVE_PRICE_ALERT_CACHE.get_or_init(|| std::sync::Mutex::new(ActivePriceAlertCache::default()))
}

#[derive(Clone)]
struct ChartAlertDelivery {
    notify_app: bool,
    notify_feishu: bool,
    webhook: Option<(String, String)>,
    frequency: String,
    name: String,
    condition_label: String,
}

struct IndicatorAlertDefinition {
    inst_id: String,
    bar: String,
    operator: String,
    left: desic_chart_dsl::Expression,
    right: desic_chart_dsl::Expression,
    max_lookback: usize,
    cooldown_ms: i64,
    expires_at: Option<i64>,
}

pub(super) fn validate_chart_alert_definition(definition: &Value) -> Result<(), String> {
    let object = definition
        .as_object()
        .ok_or_else(|| "提醒定义必须是 JSON 对象".to_string())?;
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("price");
    match kind {
        "price" => {
            chart_alert_definition_price(definition)
                .ok_or_else(|| "价格提醒定义无效".to_string())?;
        }
        "indicator" => {
            parse_indicator_alert_definition(definition)
                .ok_or_else(|| "指标提醒定义无效或超出计算限制".to_string())?;
        }
        _ => return Err("提醒条件类型不受支持".to_string()),
    }
    let delivery = chart_alert_delivery(definition)?;
    if !delivery.notify_app && !delivery.notify_feishu && delivery.webhook.is_none() {
        return Err("至少选择一种提醒方式".to_string());
    }
    Ok(())
}

fn chart_alert_delivery(definition: &Value) -> Result<ChartAlertDelivery, String> {
    let object = definition
        .as_object()
        .ok_or_else(|| "提醒定义必须是 JSON 对象".to_string())?;
    let notify_app = object
        .get("notifyApp")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let notify_feishu = object
        .get("notifyFeishu")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let webhook = match object.get("webhook") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let webhook = value
                .as_object()
                .ok_or_else(|| "HTTP 提醒配置无效".to_string())?;
            let method = webhook
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or("POST")
                .trim()
                .to_uppercase();
            let url = webhook
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            validate_chart_alert_webhook(&method, &url)?;
            Some((method, url))
        }
    };
    let frequency = match object.get("frequency").and_then(Value::as_str) {
        Some("repeat") => "repeat",
        _ => "once",
    }
    .to_string();
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .chars()
        .take(80)
        .collect();
    let condition_label = object
        .get("conditionLabel")
        .and_then(Value::as_str)
        .unwrap_or("提醒条件已满足")
        .trim()
        .chars()
        .take(160)
        .collect();
    Ok(ChartAlertDelivery {
        notify_app,
        notify_feishu,
        webhook,
        frequency,
        name,
        condition_label,
    })
}

fn validate_chart_alert_webhook(method: &str, value: &str) -> Result<(), String> {
    if !matches!(method, "GET" | "POST") {
        return Err("HTTP 提醒只支持 GET 或 POST".to_string());
    }
    if value.is_empty() || value.len() > 2048 {
        return Err("HTTP 提醒地址为空或过长".to_string());
    }
    let url = reqwest::Url::parse(value).map_err(|_| "HTTP 提醒地址格式不正确".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("HTTP 提醒地址只支持不含凭据和 fragment 的 http/https URL".to_string());
    }
    Ok(())
}

fn parse_indicator_alert_definition(definition: &Value) -> Option<IndicatorAlertDefinition> {
    let object = definition.as_object()?;
    if object.get("kind").and_then(Value::as_str)? != "indicator"
        || object
            .get("triggerOn")
            .and_then(Value::as_str)
            .unwrap_or("bar_close")
            != "bar_close"
    {
        return None;
    }
    let inst_id = object
        .get("instId")
        .or_else(|| object.get("symbol"))
        .and_then(Value::as_str)?
        .trim()
        .to_uppercase();
    let bar = object
        .get("bar")
        .and_then(Value::as_str)
        .unwrap_or("30m")
        .trim()
        .to_string();
    if inst_id.is_empty() || bar_ms(&bar).is_none() {
        return None;
    }
    let operator = object
        .get("operator")
        .and_then(Value::as_str)
        .unwrap_or("crossingAbove")
        .to_string();
    if !matches!(
        operator.as_str(),
        "crossingAbove" | "crossingBelow" | "crossing" | "greaterThan" | "lessThan"
    ) {
        return None;
    }
    let left: desic_chart_dsl::Expression =
        serde_json::from_value(object.get("left")?.clone()).ok()?;
    let right: desic_chart_dsl::Expression =
        serde_json::from_value(object.get("right")?.clone()).ok()?;
    let limits = desic_chart_dsl::ResourceLimits::default();
    let left_validation = left.validate(limits).ok()?;
    let right_validation = right.validate(limits).ok()?;
    if left_validation.value_type != desic_chart_dsl::ValueType::Number
        || right_validation.value_type != desic_chart_dsl::ValueType::Number
    {
        return None;
    }
    let max_lookback = left_validation
        .max_lookback
        .max(right_validation.max_lookback);
    if max_lookback > MAX_INDICATOR_ALERT_LOOKBACK {
        return None;
    }
    Some(IndicatorAlertDefinition {
        inst_id,
        bar,
        operator,
        left,
        right,
        max_lookback,
        cooldown_ms: chart_alert_cooldown_ms(object),
        expires_at: object.get("expiresAt").and_then(Value::as_i64),
    })
}

fn chart_alert_cooldown_ms(object: &serde_json::Map<String, Value>) -> i64 {
    object
        .get("cooldownSeconds")
        .and_then(Value::as_i64)
        .unwrap_or(60)
        .clamp(0, 86_400)
        .saturating_mul(1_000)
}

fn chart_alert_definition_price(
    definition: &Value,
) -> Option<(String, f64, String, i64, Option<i64>)> {
    let object = definition.as_object()?;
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("price");
    if kind != "price" {
        return None;
    }
    let inst_id = object
        .get("instId")
        .or_else(|| object.get("symbol"))
        .and_then(Value::as_str)?
        .trim()
        .to_uppercase();
    let trigger_price = object.get("price").and_then(Value::as_f64)?;
    let direction = object
        .get("direction")
        .and_then(Value::as_str)
        .unwrap_or("cross")
        .to_string();
    if inst_id.is_empty()
        || !trigger_price.is_finite()
        || trigger_price <= 0.0
        || !matches!(direction.as_str(), "above" | "below" | "cross")
    {
        return None;
    }
    Some((
        inst_id,
        trigger_price,
        direction,
        chart_alert_cooldown_ms(object),
        object.get("expiresAt").and_then(Value::as_i64),
    ))
}

fn chart_price_alert_matches(direction: &str, previous: f64, current: f64, target: f64) -> bool {
    match direction {
        "above" => previous < target && current >= target,
        "below" => previous > target && current <= target,
        "cross" => {
            (previous < target && current >= target) || (previous > target && current <= target)
        }
        _ => false,
    }
}

fn active_price_alert_from_parts(
    id: String,
    workspace_id: String,
    view_id: Option<String>,
    last_triggered_at: Option<i64>,
    updated_at: i64,
    definition: Value,
) -> Option<ActivePriceAlert> {
    let (inst_id, trigger_price, direction, cooldown_ms, expires_at) =
        chart_alert_definition_price(&definition)?;
    Some(ActivePriceAlert {
        id,
        workspace_id,
        view_id,
        last_triggered_at,
        updated_at,
        definition,
        inst_id,
        trigger_price,
        direction,
        cooldown_ms,
        expires_at,
    })
}

fn load_active_price_alerts(conn: &Connection) -> rusqlite::Result<Vec<ActivePriceAlert>> {
    let mut statement = conn.prepare(
        "SELECT id,workspace_id,view_id,last_triggered_at,updated_at,definition_json \
         FROM chart_alerts WHERE status='active'",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<i64>>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;
    let mut alerts = Vec::new();
    for row in rows {
        let (id, workspace_id, view_id, last_triggered_at, updated_at, raw_definition) = row?;
        let definition = match serde_json::from_str(&raw_definition) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if let Some(alert) = active_price_alert_from_parts(
            id,
            workspace_id,
            view_id,
            last_triggered_at,
            updated_at,
            definition,
        ) {
            alerts.push(alert);
        }
    }
    Ok(alerts)
}

fn cached_price_alert_observations(
    app: &tauri::AppHandle,
    inst_id: &str,
    current: f64,
) -> Result<Vec<(ActivePriceAlert, Option<f64>)>, String> {
    let mut cache = active_price_alert_cache()
        .lock()
        .map_err(|_| "chart price alert cache lock is unavailable".to_string())?;
    if !cache.initialized {
        let conn = open_database(app)?;
        let alerts = load_active_price_alerts(&conn).map_err(|error| error.to_string())?;
        cache.replace_all(alerts);
    }
    Ok(cache.observations_for_ticker(inst_id, current))
}

pub(super) fn chart_price_alert_cache_after_save(alert: &ChartAlert) {
    let cached = if alert.status == "active" {
        active_price_alert_from_parts(
            alert.id.clone(),
            alert.workspace_id.clone(),
            alert.view_id.clone(),
            alert.last_triggered_at,
            alert.updated_at,
            alert.definition.clone(),
        )
    } else {
        None
    };
    if let Ok(mut cache) = active_price_alert_cache().lock() {
        if !cache.initialized {
            return;
        }
        if let Some(alert) = cached {
            cache.upsert(alert);
        } else {
            cache.remove_alert(&alert.id);
        }
    }
}

pub(super) fn chart_price_alert_cache_remove(alert_id: &str) {
    if let Ok(mut cache) = active_price_alert_cache().lock() {
        if cache.initialized {
            cache.remove_alert(alert_id);
        }
    }
}

pub(super) fn chart_price_alert_cache_remove_workspace(workspace_id: &str) {
    if let Ok(mut cache) = active_price_alert_cache().lock() {
        if cache.initialized {
            cache.remove_workspace(workspace_id);
        }
    }
}

pub(super) fn chart_price_alert_cache_remove_workspace_view(workspace_id: &str, view_id: &str) {
    if let Ok(mut cache) = active_price_alert_cache().lock() {
        if cache.initialized {
            cache.remove_workspace_view(workspace_id, view_id);
        }
    }
}

fn chart_price_alert_cache_mark_triggered(alert_id: &str, frequency: &str, now: i64) {
    if let Ok(mut cache) = active_price_alert_cache().lock() {
        if cache.initialized {
            cache.mark_triggered(alert_id, frequency, now);
        }
    }
}

fn expire_chart_price_alert(
    conn: &Connection,
    alert_id: &str,
    expected_updated_at: i64,
    now: i64,
) -> bool {
    conn.execute(
        "UPDATE chart_alerts SET status='expired', updated_at=?2 \
         WHERE id=?1 AND status='active' AND updated_at=?3",
        params![alert_id, now, expected_updated_at],
    )
    .ok()
        == Some(1)
}

pub(super) fn process_chart_price_alerts(app: &tauri::AppHandle, ticker: &Ticker) {
    let current = ticker
        .last
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value > 0.0);
    let Some(current) = current else {
        return;
    };
    let observations = match cached_price_alert_observations(app, &ticker.inst_id, current) {
        Ok(observations) => observations,
        Err(_) => return,
    };
    if observations.is_empty() {
        return;
    }
    let now = now_ms();
    let mut conn = None;
    for (alert, previous) in observations {
        if alert.expires_at.is_some_and(|expires_at| expires_at <= now) {
            if conn.is_none() {
                conn = open_database(app).ok();
            }
            let Some(conn) = conn.as_ref() else {
                return;
            };
            if expire_chart_price_alert(conn, &alert.id, alert.updated_at, now) {
                chart_price_alert_cache_remove(&alert.id);
            }
            continue;
        }
        let Some(previous) = previous else {
            continue;
        };
        if alert
            .last_triggered_at
            .is_some_and(|last| now.saturating_sub(last) < alert.cooldown_ms)
            || !chart_price_alert_matches(&alert.direction, previous, current, alert.trigger_price)
        {
            continue;
        }
        if conn.is_none() {
            conn = open_database(app).ok();
        }
        let Some(conn) = conn.as_ref() else {
            return;
        };
        trigger_chart_alert(
            app,
            conn,
            alert.id,
            alert.workspace_id,
            alert.inst_id,
            "price",
            &alert.direction,
            alert.trigger_price,
            current,
            &alert.definition,
            Some(alert.updated_at),
            now,
        );
    }
}

fn evaluate_number_expression(
    expression: &desic_chart_dsl::Expression,
    candles: &[Candle],
) -> Option<Vec<Option<f64>>> {
    let columns = desic_chart_dsl::OhlcvColumns {
        timestamp: candles.iter().map(|candle| candle.time).collect(),
        open: candles.iter().map(|candle| candle.open).collect(),
        high: candles.iter().map(|candle| candle.high).collect(),
        low: candles.iter().map(|candle| candle.low).collect(),
        close: candles.iter().map(|candle| candle.close).collect(),
        volume: candles.iter().map(|candle| candle.volume).collect(),
    };
    match expression
        .evaluate(&columns, desic_chart_dsl::ResourceLimits::default())
        .ok()?
    {
        desic_chart_dsl::EvaluatedSeries::Number(values) => Some(values),
        desic_chart_dsl::EvaluatedSeries::Boolean(_) => None,
    }
}

fn last_two_pairs(left: &[Option<f64>], right: &[Option<f64>]) -> Option<[(f64, f64); 2]> {
    let current_index = left.len().min(right.len()).checked_sub(1)?;
    let (Some(current_left), Some(current_right)) = (left[current_index], right[current_index])
    else {
        return None;
    };
    if !current_left.is_finite() || !current_right.is_finite() {
        return None;
    }
    for index in (0..current_index).rev() {
        let (Some(previous_left), Some(previous_right)) = (left[index], right[index]) else {
            continue;
        };
        if previous_left.is_finite() && previous_right.is_finite() {
            return Some([
                (previous_left, previous_right),
                (current_left, current_right),
            ]);
        }
    }
    None
}

fn source_candle_closes_bar(source_candle: &Candle, bar: &str) -> bool {
    let Some(step_ms) = bar_ms(bar) else {
        return false;
    };
    source_candle
        .time
        .saturating_mul(1_000)
        .saturating_add(60_000)
        .rem_euclid(step_ms)
        == 0
}

fn indicator_alert_matches(operator: &str, previous: (f64, f64), current: (f64, f64)) -> bool {
    match operator {
        "crossingAbove" | "greaterThan" => previous.0 <= previous.1 && current.0 > current.1,
        "crossingBelow" | "lessThan" => previous.0 >= previous.1 && current.0 < current.1,
        "crossing" => {
            (previous.0 <= previous.1 && current.0 > current.1)
                || (previous.0 >= previous.1 && current.0 < current.1)
        }
        _ => false,
    }
}

pub(super) fn process_chart_indicator_alerts(
    app: &tauri::AppHandle,
    inst_id: &str,
    source_candle: &Candle,
) {
    if !source_candle.confirm {
        return;
    }
    let now = now_ms();
    let conn = match open_database(app).and_then(|conn| Ok(conn)) {
        Ok(conn) => conn,
        Err(_) => return,
    };
    let rows = match conn
        .prepare("SELECT id,workspace_id,last_triggered_at,definition_json FROM chart_alerts WHERE status='active'")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()
        }) {
        Ok(rows) => rows,
        Err(_) => return,
    };
    let mut candle_cache: HashMap<(String, u16), Vec<Candle>> = HashMap::new();
    for (alert_id, workspace_id, last_triggered_at, raw_definition) in rows {
        let definition: Value = match serde_json::from_str(&raw_definition) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let Some(parsed) = parse_indicator_alert_definition(&definition) else {
            continue;
        };
        if parsed.inst_id != inst_id {
            continue;
        }
        if !source_candle_closes_bar(source_candle, &parsed.bar) {
            continue;
        }
        if parsed
            .expires_at
            .is_some_and(|expires_at| expires_at <= now)
        {
            let _ = conn.execute(
                "UPDATE chart_alerts SET status='expired', updated_at=?2 WHERE id=?1",
                params![alert_id, now],
            );
            continue;
        }
        if last_triggered_at.is_some_and(|last| now.saturating_sub(last) < parsed.cooldown_ms) {
            continue;
        }
        let limit = parsed
            .max_lookback
            .saturating_add(2)
            .max(32)
            .min(MAX_INDICATOR_ALERT_LOOKBACK + 2) as u16;
        let cache_key = (parsed.bar.clone(), limit);
        if !candle_cache.contains_key(&cache_key) {
            let candles = match aggregate_candles_from_1m(
                &conn,
                inst_id,
                &parsed.bar,
                None,
                None,
                limit,
                true,
            ) {
                Ok(candles) => candles,
                Err(_) => continue,
            };
            candle_cache.insert(cache_key.clone(), candles);
        }
        let Some(candles) = candle_cache.get(&cache_key) else {
            continue;
        };
        let Some(left) = evaluate_number_expression(&parsed.left, candles) else {
            continue;
        };
        let Some(right) = evaluate_number_expression(&parsed.right, candles) else {
            continue;
        };
        let Some([previous, current]) = last_two_pairs(&left, &right) else {
            continue;
        };
        if !indicator_alert_matches(&parsed.operator, previous, current) {
            continue;
        }
        let direction = if parsed.operator == "crossingBelow" || parsed.operator == "lessThan" {
            "below"
        } else if parsed.operator == "crossing" {
            "cross"
        } else {
            "above"
        };
        trigger_chart_alert(
            app,
            &conn,
            alert_id,
            workspace_id,
            parsed.inst_id,
            "indicator",
            direction,
            current.1,
            current.0,
            &definition,
            None,
            now,
        );
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn trigger_chart_alert(
    app: &tauri::AppHandle,
    conn: &Connection,
    alert_id: String,
    workspace_id: String,
    inst_id: String,
    condition_kind: &str,
    direction: &str,
    reference_value: f64,
    current_value: f64,
    definition: &Value,
    expected_updated_at: Option<i64>,
    now: i64,
) {
    let delivery = match chart_alert_delivery(definition) {
        Ok(value) => value,
        Err(_) => return,
    };
    let next_status = if delivery.frequency == "once" {
        "expired"
    } else {
        "active"
    };
    if conn
        .execute(
            "UPDATE chart_alerts SET status=?2,last_triggered_at=?3,updated_at=?3 \
             WHERE id=?1 AND status='active' AND (?4 IS NULL OR updated_at=?4)",
            params![alert_id, next_status, now, expected_updated_at],
        )
        .ok()
        != Some(1)
    {
        return;
    }
    if condition_kind == "price" {
        chart_price_alert_cache_mark_triggered(&alert_id, &delivery.frequency, now);
    }
    let title = if delivery.name.is_empty() {
        if condition_kind == "indicator" {
            format!("图表指标提醒 · {}", inst_id)
        } else {
            format!("图表价格提醒 · {}", inst_id)
        }
    } else {
        delivery.name.clone()
    };
    let message = format!(
        "{}：{}，当前值 {}，参考值 {}。",
        inst_id, delivery.condition_label, current_value, reference_value
    );
    let mut channels = Vec::new();
    if delivery.notify_app {
        channels.push("app");
    }
    if delivery.notify_feishu {
        channels.push("feishu");
    }
    if let Some((method, _)) = delivery.webhook.as_ref() {
        channels.push(if method == "GET" { "get" } else { "post" });
    }
    let event = ChartAlertEvent {
        id: format!("chart-alert-event-{}-{}", now, alert_id),
        alert_id: alert_id.clone(),
        workspace_id,
        inst_id: inst_id.clone(),
        condition_kind: condition_kind.to_string(),
        direction: direction.to_string(),
        trigger_price: reference_value,
        last_price: current_value,
        triggered_at: now,
        delivery_status: if channels.is_empty() {
            "none".to_string()
        } else {
            channels.join("+")
        },
        name: title.clone(),
        message: message.clone(),
        notify_app: delivery.notify_app,
        frequency: delivery.frequency.clone(),
    };
    let _ = conn.execute(
        "INSERT OR REPLACE INTO chart_alert_events (id,alert_id,workspace_id,inst_id,condition_kind,direction,trigger_price,last_price,triggered_at,delivery_status) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![event.id, event.alert_id, event.workspace_id, event.inst_id, event.condition_kind, event.direction, event.trigger_price, event.last_price, event.triggered_at, event.delivery_status],
    );
    let _ = app.emit(CHART_ALERT_TRIGGERED_EVENT, &event);
    if delivery.notify_feishu {
        ai_automation::spawn_chart_alert_feishu(
            app,
            title.clone(),
            message.clone(),
            event.id.clone(),
        );
    }
    if let Some((method, url)) = delivery.webhook {
        spawn_chart_alert_webhook(method, url, event, title, message);
    }
}

fn spawn_chart_alert_webhook(
    method: String,
    url: String,
    event: ChartAlertEvent,
    title: String,
    message: String,
) {
    tauri::async_runtime::spawn(async move {
        let client = match reqwest_client() {
            Ok(client) => client,
            Err(error) => {
                eprintln!("[chart-alert] HTTP client unavailable: {error}");
                return;
            }
        };
        let request = if method == "GET" {
            client.get(&url).query(&[
                ("event", "chart.alert.triggered".to_string()),
                ("alertId", event.alert_id.clone()),
                ("name", title.clone()),
                ("symbol", event.inst_id.clone()),
                ("conditionKind", event.condition_kind.clone()),
                ("direction", event.direction.clone()),
                ("message", message.clone()),
                ("value", event.last_price.to_string()),
                ("referenceValue", event.trigger_price.to_string()),
                ("triggeredAt", event.triggered_at.to_string()),
            ])
        } else {
            client.post(&url).json(&json!({
                "event": "chart.alert.triggered",
                "alertId": event.alert_id,
                "name": title,
                "symbol": event.inst_id,
                "conditionKind": event.condition_kind,
                "direction": event.direction,
                "message": message,
                "value": event.last_price,
                "referenceValue": event.trigger_price,
                "triggeredAt": Utc.timestamp_millis_opt(event.triggered_at).single().map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true)),
            }))
        };
        match request.send().await {
            Ok(response) if response.status().is_success() => {}
            Ok(response) => eprintln!(
                "[chart-alert] HTTP delivery returned status {}",
                response.status()
            ),
            Err(error) => eprintln!(
                "[chart-alert] HTTP delivery failed (timeout={}, connect={})",
                error.is_timeout(),
                error.is_connect()
            ),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cached_price_alert(
        id: &str,
        view_id: Option<&str>,
        trigger_price: f64,
        updated_at: i64,
    ) -> ActivePriceAlert {
        active_price_alert_from_parts(
            id.to_string(),
            "workspace-test".to_string(),
            view_id.map(str::to_string),
            None,
            updated_at,
            json!({
                "kind": "price",
                "instId": "BTC-USDT-SWAP",
                "price": trigger_price,
                "direction": "above",
                "notifyApp": true,
            }),
        )
        .expect("valid test price alert")
    }

    #[test]
    fn price_alert_crossing_is_edge_triggered() {
        assert!(chart_price_alert_matches("above", 99.0, 100.0, 100.0));
        assert!(!chart_price_alert_matches("above", 100.0, 101.0, 100.0));
        assert!(chart_price_alert_matches("below", 101.0, 100.0, 100.0));
        assert!(chart_price_alert_matches("cross", 101.0, 99.0, 100.0));
    }

    #[test]
    fn price_cache_updates_definition_and_resets_the_price_baseline() {
        let mut cache = ActivePriceAlertCache::default();
        cache.replace_all(vec![cached_price_alert(
            "price-alert-a",
            Some("view-a"),
            100.0,
            1,
        )]);

        let first_observation = cache.observations_for_ticker("BTC-USDT-SWAP", 99.0);
        assert_eq!(first_observation.len(), 1);
        assert_eq!(first_observation[0].1, None);

        cache.upsert(cached_price_alert(
            "price-alert-a",
            Some("view-a"),
            110.0,
            2,
        ));
        let updated_observation = cache.observations_for_ticker("BTC-USDT-SWAP", 105.0);
        assert_eq!(updated_observation.len(), 1);
        assert_eq!(updated_observation[0].0.trigger_price, 110.0);
        assert_eq!(updated_observation[0].1, None);
    }

    #[test]
    fn price_cache_removes_deleted_views_and_once_alerts() {
        let mut cache = ActivePriceAlertCache::default();
        cache.replace_all(vec![
            cached_price_alert("price-alert-view", Some("view-a"), 100.0, 1),
            cached_price_alert("price-alert-global", None, 100.0, 1),
        ]);

        cache.remove_workspace_view("workspace-test", "view-a");
        let remaining = cache.observations_for_ticker("BTC-USDT-SWAP", 99.0);
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].0.id, "price-alert-global");

        cache.mark_triggered("price-alert-global", "once", 2);
        assert!(cache
            .observations_for_ticker("BTC-USDT-SWAP", 101.0)
            .is_empty());
    }

    #[test]
    fn active_price_cache_hydration_ignores_inactive_and_non_price_rows() {
        let conn = Connection::open_in_memory().expect("in-memory chart alert database");
        conn.execute_batch(
            "CREATE TABLE chart_alerts (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                view_id TEXT,
                status TEXT NOT NULL,
                last_triggered_at INTEGER,
                definition_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );",
        )
        .expect("create chart alerts table");
        let price_definition = serde_json::to_string(&json!({
            "kind": "price",
            "instId": "BTC-USDT-SWAP",
            "price": 100.0,
            "direction": "cross",
            "notifyApp": true,
        }))
        .expect("serialize price definition");
        let indicator_definition = serde_json::to_string(&json!({
            "kind": "indicator",
            "instId": "BTC-USDT-SWAP"
        }))
        .expect("serialize indicator definition");
        for (id, status, definition) in [
            ("active-price", "active", price_definition.as_str()),
            ("paused-price", "paused", price_definition.as_str()),
            ("active-indicator", "active", indicator_definition.as_str()),
        ] {
            conn.execute(
                "INSERT INTO chart_alerts (id,workspace_id,view_id,status,last_triggered_at,definition_json,updated_at)
                 VALUES (?1,'workspace-test',NULL,?2,NULL,?3,1)",
                params![id, status, definition],
            )
            .expect("insert test chart alert");
        }

        let alerts = load_active_price_alerts(&conn).expect("hydrate active price alerts");
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].id, "active-price");
    }

    #[test]
    fn price_alert_expiry_rejects_a_stale_cache_revision() {
        let conn = Connection::open_in_memory().expect("in-memory chart alert database");
        conn.execute_batch(
            "CREATE TABLE chart_alerts (
                id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            INSERT INTO chart_alerts (id,status,updated_at) VALUES ('price-alert-a','active',10);",
        )
        .expect("create test alert");

        assert!(!expire_chart_price_alert(&conn, "price-alert-a", 9, 20));
        assert!(expire_chart_price_alert(&conn, "price-alert-a", 10, 20));
        let status: String = conn
            .query_row(
                "SELECT status FROM chart_alerts WHERE id='price-alert-a'",
                [],
                |row| row.get(0),
            )
            .expect("read alert status");
        assert_eq!(status, "expired");
    }

    #[test]
    fn indicator_crossing_is_edge_triggered() {
        assert!(indicator_alert_matches(
            "crossingAbove",
            (9.0, 10.0),
            (11.0, 10.0)
        ));
        assert!(!indicator_alert_matches(
            "crossingAbove",
            (11.0, 10.0),
            (12.0, 10.0)
        ));
        assert!(indicator_alert_matches(
            "crossing",
            (11.0, 10.0),
            (9.0, 10.0)
        ));
    }

    #[test]
    fn indicator_pairs_require_a_current_value() {
        assert_eq!(
            last_two_pairs(
                &[Some(9.0), Some(11.0), None],
                &[Some(10.0), Some(10.0), Some(10.0)]
            ),
            None
        );
        assert_eq!(
            last_two_pairs(
                &[Some(9.0), None, Some(11.0)],
                &[Some(10.0), None, Some(10.0)]
            ),
            Some([(9.0, 10.0), (11.0, 10.0)])
        );
    }

    #[test]
    fn indicator_alerts_only_evaluate_when_the_target_bar_closes() {
        let minute = Candle {
            time: 120,
            open: 1.0,
            high: 1.0,
            low: 1.0,
            close: 1.0,
            volume: 1.0,
            confirm: true,
        };
        assert!(source_candle_closes_bar(&minute, "1m"));
        assert!(!source_candle_closes_bar(&minute, "5m"));
        assert!(source_candle_closes_bar(
            &Candle {
                time: 240,
                ..minute
            },
            "5m"
        ));
    }

    #[test]
    fn selected_indicator_and_custom_dsl_outputs_are_valid_alert_operands() {
        let selected = json!({
            "kind": "indicator",
            "instId": "BTC-USDT-SWAP",
            "bar": "30m",
            "operator": "crossingAbove",
            "triggerOn": "bar_close",
            "left": {
                "kind": "builtInIndicator",
                "definitionId": "adx",
                "outputKey": "plusDi",
                "parameters": { "period": 14 }
            },
            "right": { "kind": "number", "value": 25 },
            "notifyApp": true
        });
        let parsed =
            parse_indicator_alert_definition(&selected).expect("selected indicator should parse");
        assert!(parsed.max_lookback >= 15);

        let custom = json!({
            "kind": "indicator",
            "instId": "BTC-USDT-SWAP",
            "bar": "30m",
            "operator": "crossingAbove",
            "triggerOn": "bar_close",
            "left": {
                "kind": "conditional",
                "if": {
                    "kind": "comparison",
                    "op": "greaterThan",
                    "left": { "kind": "field", "field": "close" },
                    "right": { "kind": "rolling", "function": "sma", "input": { "kind": "field", "field": "close" }, "window": 20 }
                },
                "thenValue": { "kind": "technical", "function": "rsi", "window": 14 },
                "elseValue": { "kind": "technical", "function": "vwap", "window": null }
            },
            "right": { "kind": "number", "value": 50 },
            "notifyApp": true
        });
        assert!(parse_indicator_alert_definition(&custom).is_some());
    }

    #[test]
    fn webhook_validation_rejects_credentials_and_unsupported_methods() {
        assert!(validate_chart_alert_webhook("PATCH", "https://example.com/alert").is_err());
        assert!(
            validate_chart_alert_webhook("POST", "https://user:pass@example.com/alert").is_err()
        );
        assert!(validate_chart_alert_webhook("GET", "https://example.com/alert").is_ok());
    }
}
