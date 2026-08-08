use base64::{engine::general_purpose, Engine as _};
use chrono::{Datelike, SecondsFormat, TimeZone, Utc};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    error::Error as StdError,
    fs,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
        Arc, Condvar, Mutex, OnceLock,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    net::TcpStream,
    process::Command,
    sync::{mpsc, oneshot, Mutex as AsyncMutex, RwLock as AsyncRwLock, Semaphore, SemaphorePermit},
    time::{sleep, timeout, Duration},
};
use tokio_tungstenite::{client_async, tungstenite::Message, WebSocketStream};
mod ai_automation;
mod app_updater;
mod chart_alerts;
mod chart_consumers;
mod instrument_operations;
mod intelligence;
mod market_ws;
mod private_history;
mod storage_config;
mod systematic;
mod trade_commands;
mod trade_domain;
mod trade_support;
use crate::ai_automation::{
    ai_agent_profile_delete, ai_agent_profile_run_daily_review, ai_agent_profile_run_now,
    ai_agent_profile_save, ai_agent_profile_systematic_conflicts, ai_agent_scheme_delete,
    ai_agent_scheme_save, ai_automation_overview,
    ai_automation_run_detail, ai_automation_run_statuses, ai_automation_save_master_enabled,
    ai_automation_section, ai_automation_summary, ai_optimization_suggestion_update,
    ai_skill_version_discard, ai_skill_version_publish, ai_token_usage_summary,
    ai_user_wake_condition_delete, ai_user_wake_condition_save, append_ai_usage_summary_event,
    background_finish_run, notification_feishu_config_save, notification_feishu_send,
    notification_feishu_test, notification_settings_summary,
    notify_automation_run_record_persisted, optimization_suggestion_create, review_complete,
    review_read_skill_version, start_ai_automation_worker, AiAutomationRuntime,
    BackgroundFinishRunInput, BackgroundRunContext, FeishuSendInput, OptimizationSuggestionInput,
    ReviewCompleteInput, ReviewSkillVersionInput,
};
use crate::app_updater::{
    app_update_apply_source, app_update_check, app_update_prepare, app_update_restart_source,
    app_update_status, AppUpdateRuntime,
};
use crate::instrument_operations::{
    okx_active_instrument_operations, okx_execute_cancel_instrument_orders,
    okx_execute_flatten_instrument_positions, okx_instrument_operation,
    okx_preview_cancel_instrument_orders, okx_preview_flatten_instrument_positions,
};
use crate::intelligence::{
    intelligence_anomalies_query, intelligence_briefing_generate, intelligence_briefings_query,
    intelligence_calendar_query, intelligence_derivatives_crowding,
    intelligence_derivatives_funding_basis, intelligence_derivatives_liquidations,
    intelligence_derivatives_overview, intelligence_derivatives_position_tiers,
    intelligence_derivatives_positioning, intelligence_derivatives_system_risk,
    intelligence_derivatives_taker_flow, intelligence_mark_active_instrument,
    intelligence_news_detail, intelligence_news_event_detail, intelligence_news_events_query,
    intelligence_news_feed, intelligence_news_mark_read, intelligence_news_query,
    intelligence_news_read_state, intelligence_news_reaction_query, intelligence_news_sources,
    intelligence_sentiment_query, intelligence_settings_save, intelligence_settings_summary,
    intelligence_smart_query, intelligence_smart_signals_query, intelligence_smart_trader_detail,
    intelligence_smart_traders_query, intelligence_summary, intelligence_sync_now,
    intelligence_sync_status, intelligence_track_trader, start_intelligence_collector,
    IntelligenceRuntime,
};
use crate::market_ws::{
    connect_okx_ws, filter_cancelled_pending_orders, market_health_blockers,
    private_login_succeeded, private_ws_login_payload, reconcile_private_streams,
    register_market_consumer, send_private_trade_command, start_market_stream, stop_market_stream,
    unregister_market_consumer,
};
use crate::private_history::{
    okx_sync_private_history as sync_private_history_impl,
    private_history_status as private_history_status_impl,
};
use crate::storage_config::{
    ai_config_summary, ai_local_auth_status, ai_save_config, ai_sidecar_proxy_url,
    ai_test_connection, export_diagnostics, frontend_log, initialize_runtime_paths,
    load_accounts_config, load_ai_config, load_notification_webhook, load_proxy_config,
    load_watchlist_config, migrate_sensitive_config, proxy_authorization_header,
    proxy_config_summary, reqwest_client, runtime_cache_root, runtime_work_dir,
    save_accounts_config, save_notification_webhook, save_proxy_config, save_ui_preferences,
    save_watchlist_config, storage_maintenance, storage_status, test_proxy_config,
    ui_preferences_summary,
};
use crate::systematic::{
    start_systematic_worker, systematic_backtest_cancel, systematic_backtest_defaults,
    systematic_backtest_delete, systematic_backtest_detail, systematic_backtest_start, systematic_capture_universe_snapshot,
    systematic_factor_create_default, systematic_factor_evaluate, systematic_factor_save,
    systematic_overview, systematic_python_prepare_environment,
    systematic_python_run_sample, systematic_strategy_ai_cancel_session,
    systematic_strategy_ai_execute_tool, systematic_strategy_ai_send_message,
    systematic_strategy_ai_tool_respond,
    systematic_optimization_start, systematic_profile_delete, systematic_profile_save, systematic_profile_set_enabled,
    systematic_profile_signals,
    systematic_strategy_create_python, systematic_strategy_delete, systematic_strategy_save_python,
    systematic_strategy_version_detail, systematic_strategy_versions,
    SystematicRuntime,
};
use crate::trade_commands::{
    capture_trade_opportunity_market_snapshot, materialize_trade_opportunity_commit,
    okx_amend_algo_order, okx_amend_order, okx_cancel_algo_order, okx_cancel_order,
    okx_close_position, okx_close_position_with_actor, okx_list_algo_orders, okx_place_algo_order,
    okx_place_order, okx_reconcile_trade_execution_guards, okx_set_leverage,
    okx_trade_execution_guards, read_decision_context, start_trade_execution_recovery,
    trade_opportunities, trade_opportunities_clear, trade_opportunity_approve,
    trade_opportunity_auto_approve_for_run, trade_opportunity_close, trade_opportunity_create,
    trade_opportunity_delete, trade_opportunity_get, trade_opportunity_reject,
    trade_opportunity_reuse, trade_opportunity_revise, trade_precheck, AmendOrderRequest,
    ClosePositionRequest, DecisionContextRequest, TradeOpportunityCommitRequest,
    TradeOpportunityCreateRequest, TradeOpportunityMutationRequest, TradeOpportunitySummary,
};
use crate::trade_domain::{
    audit_fill_event_with_conn, audit_position_episode_event_with_conn, audit_trade_event,
    audit_trade_event_once, calculate_linear_usdt_perpetual, calculate_linear_usdt_risk_budget,
    order_attribution, trade_audit_events,
};
use crate::trade_support::{
    available_balance_value, ensure_instruments_cached, ensure_trade_account,
    estimated_margin_candidate, fetch_instrument, format_leverage_rows,
    instrument_allows_fractional_contracts, instrument_minimum_base_quantity,
    instrument_quantity_instruction, leverage_info_path, leverage_pos_sides, leverage_rows_match,
    position_available, select_position_tier,
};
use desic_private_history::{
    PrivateHistoryStatusRequest, PrivateHistoryStatusResponse, PrivateHistorySyncRequest,
    PrivateHistorySyncResult,
};
use desic_storage_config::{
    AccountSummary, AccountsConfig, LocalAccount, Permissions, ProxyConfig,
};

const REST_BASE: &str = "https://www.okx.com";
const OKX_ICON_BASE: &str = "https://static.okx.com/cdn/oksupport/asset/currency/icon";
const MARKET_ICON_DOWNLOAD_CONCURRENCY: usize = 6;
const MARKET_ASSETS_CACHE_VERSION: u32 = 3;
const PUBLIC_WS: &str = "wss://ws.okx.com:8443/ws/v5/public";
const BUSINESS_WS: &str = "wss://ws.okx.com:8443/ws/v5/business";
const PRIVATE_WS: &str = "wss://ws.okx.com:8443/ws/v5/private";
const PRIVATE_WS_DEMO: &str = "wss://wspap.okx.com:8443/ws/v5/private";
const DATABASE_SCHEMA_VERSION: i64 = 1;
const MARKET_EVENT: &str = "market:event";
const KLINE_SYNC_EVENT: &str = "kline:sync";
const TRADE_AUDIT_EVENT: &str = "trade:audit";
const AI_EVENT: &str = "ai:event";
const AI_CHART_ACTION_EVENT: &str = "ai:chart-action";
const CHART_ALERT_TRIGGERED_EVENT: &str = "chart:alert-triggered";
const ACCOUNT_POSITION_MODE_SWITCH_FAILED_EVENT: &str = "ai:automation-event";
const ACCOUNT_POSITION_MODE_SWITCH_FAILED_PREFIX: &str = "ACCOUNT_POSITION_MODE_SWITCH_FAILED:";

fn decode_exchange_marker(material: &[u8; 16]) -> String {
    const SEED: u8 = 19;
    material
        .iter()
        .enumerate()
        .map(|(index, value)| {
            value ^ SEED.rotate_left((index % 8) as u32) ^ (index as u8).wrapping_mul(17)
        })
        .map(char::from)
        .collect()
}

fn exchange_client_marker() -> String {
    decode_exchange_marker(&[
        69, 68, 11, 237, 32, 102, 236, 205, 245, 252, 213, 73, 150, 134, 75, 44,
    ])
}

fn retired_exchange_client_marker() -> String {
    decode_exchange_marker(&[
        118, 0, 90, 205, 65, 7, 145, 154, 174, 140, 208, 18, 191, 252, 110, 51,
    ])
}

fn strip_private_exchange_fields_inner(value: &mut Value, markers: &[String; 2]) {
    match value {
        Value::Array(items) => {
            for item in items {
                strip_private_exchange_fields_inner(item, markers);
            }
        }
        Value::Object(fields) => {
            fields.retain(|key, _| !key.eq_ignore_ascii_case("tag"));
            for item in fields.values_mut() {
                strip_private_exchange_fields_inner(item, markers);
            }
        }
        Value::String(text) => {
            for marker in markers {
                if text.contains(marker) {
                    *text = text.replace(marker, "");
                }
            }
        }
        _ => {}
    }
}

fn strip_private_exchange_fields(value: &mut Value) {
    let markers = [exchange_client_marker(), retired_exchange_client_marker()];
    strip_private_exchange_fields_inner(value, &markers);
}

fn private_exchange_value<T: Serialize + ?Sized>(value: &T) -> Result<Value, String> {
    let mut value = serde_json::to_value(value).map_err(|error| error.to_string())?;
    strip_private_exchange_fields(&mut value);
    Ok(value)
}

fn private_exchange_json<T: Serialize + ?Sized>(value: &T) -> Result<String, String> {
    private_exchange_value(value).map(|value| value.to_string())
}

fn scrub_private_exchange_text(text: &str) -> String {
    let markers = [exchange_client_marker(), retired_exchange_client_marker()];
    let contains_marker = markers.iter().any(|marker| text.contains(marker));
    if !contains_marker {
        return text.to_string();
    }
    match serde_json::from_str::<Value>(text) {
        Ok(mut value) => {
            strip_private_exchange_fields_inner(&mut value, &markers);
            value.to_string()
        }
        Err(_) => markers
            .iter()
            .fold(text.to_string(), |value, marker| value.replace(marker, "")),
    }
}
const CHART_INDICATOR_AI_SYSTEM_PROMPT: &str = r##"你是 desicTradeAI 指标中心里的自定义指标对话助手。
你可以和用户讨论指标想法、解释指标逻辑、询问缺少的细节，也可以在用户明确要求时创建或更新一个本地图表自定义指标。
不要调用 Skill、子 Agent、交易、账户、行情、通知、文件或 shell 类工具；不要输出任意 JavaScript。
只有在用户明确要求创建或更新指标，并且已经有足够信息时，才调用 script.createOrUpdate。没有调用工具时，正常回答用户的问题，不要声称指标已经生成或写入。
调用工具后必须等待工具返回；只有工具成功返回后，才能说明指标已写入指标库。

script.createOrUpdate 参数要求：
- name：简短中文名称，最多 40 字。
- description：说明指标用途和主要参数，最多 160 字。
- source：必须是 JSON 字符串，内容是安全指标 DSL 文档。
- enabled：通常设为 true。
- hidden：通常设为 false。
- openPanel：通常设为 true，便于用户检查。

安全指标 DSL 文档格式：
{
  "schemaVersion": 1,
  "name": "指标名",
  "parameters": [
    { "key": "length", "label": "周期", "type": "integer", "defaultValue": 20, "min": 2, "max": 240 }
  ],
  "outputs": [
    {
      "id": "line",
      "label": "显示名",
      "pane": "main",
      "kind": "line",
      "color": "#f5a524",
      "expression": { "type": "call", "name": "sma", "args": [{ "type": "field", "field": "close" }, { "type": "parameter", "key": "length" }] }
    }
  ]
}

DSL 白名单：
- 字段 field：open、high、low、close、volume、hl2、hlc3、ohlc4。
- 数字表达式 type：number、field、parameter、unary、binary、if、call。
- boolean 表达式 type：boolean、compare、logical、not。
- binary op：add、subtract、multiply、divide、modulo、power。
- compare op：greater、greaterEqual、less、lessEqual、equal、notEqual。
- logical op：and、or。
- call name：abs、min、max、sma、ema、rsi、atr、vwap、highest、lowest、stddev。
- outputs 最多 8 个；pane 只能是 main 或 sub；kind 只能是 line、histogram、area。

内置函数签名必须严格遵守：
- abs(value)、min(left, right)、max(left, right)。
- sma(source, period)、ema(source, period)、highest(source, period)、lowest(source, period)、stddev(source, period)。
- rsi(period) 只接受 1 个周期参数，默认基于 close 计算；禁止写成 rsi(close, period)。
- atr(period) 只接受 1 个周期参数；vwap() 不接受参数。
- 所有 period/lookback 参数只能是 { "type": "number", "value": <整数> }，或引用已声明且同时具有 min/max 有界范围的 integer 参数；禁止使用 field、四则运算、另一个 call 或没有 max 的参数作为回看周期。

正确 RSI 示例：
{
  "type": "call",
  "name": "rsi",
  "args": [{ "type": "parameter", "key": "rsiPeriod" }]
}

DSL 字段名必须逐字匹配：
- 条件分支必须写成 { "type": "if", "when": <boolean>, "then": <number>, "else": <number> }。
- 禁止在 if 表达式里使用 condition、thenValue、elseValue 等别名；只能使用 when、then、else。
- compare 必须写成 { "type": "compare", "op": "greater", "left": <number>, "right": <number> }。
- logical 必须写成 { "type": "logical", "op": "and", "left": <boolean>, "right": <boolean> }。
- not 必须写成 { "type": "not", "value": <boolean> }。

正确 if 示例：
{
  "type": "if",
  "when": {
    "type": "compare",
    "op": "greater",
    "left": { "type": "field", "field": "close" },
    "right": { "type": "call", "name": "sma", "args": [{ "type": "field", "field": "close" }, { "type": "parameter", "key": "length" }] }
  },
  "then": { "type": "field", "field": "close" },
  "else": { "type": "number", "value": 0 }
}

生成规则：
- source 必须是可 JSON.parse 的字符串，不要包含注释、尾逗号或 Markdown。
- 参数 key 只能使用英文字母、数字和下划线，并以字母或下划线开头。
- 输出 id 只能使用英文字母、数字、下划线和连字符。
- 生成 source 前必须自检：所有 type="if" 节点都有 when/then/else，且没有 condition 字段。
- 生成 source 前必须逐个自检 call 的参数个数和顺序，尤其是 rsi(period)、atr(period)、vwap()；所有回看周期必须是整数常量或具有 min/max 的 integer 参数。
- 用户明确指定主图或副图时遵循用户要求。用户没有指定时，必须按每个 output 的“数值尺度”判断，而不是只按指标名称判断。
- 只有输出值与交易价格同单位、同量级，并且需要叠加 K 线观察时才使用 main，例如绝对价格形式的均线、价格通道上下轨、支撑阻力价位、趋势线、摆动高低点。
- 百分比、比率、0-100 区间、-1/0/1 状态、0/1 布尔信号、价格差值、收益率、动量、成交量、波动率、零轴柱状图及其它独立数值尺度必须使用 sub，例如 RSI、MACD 类动量、ATR 数值、成交量和多空信号柱。
- 禁止把远离当前价格的零值或小数值输出放到 main。尤其禁止在 main 的条件信号中用 else={ "type": "number", "value": 0 } 形成零基线，否则主图自动缩放会把 K 线压缩到不可见；这类信号应改放 sub。
- 一个指标可以同时包含 main 和 sub 输出：价格结构输出放 main，信号强度、状态柱和振荡输出放 sub。生成前逐个检查所有 main 输出是否始终代表合理的绝对价格；无法确认时默认使用 sub。
- 图表指标只读取当前图表周期的 OHLCV；它没有 Python 策略的 `ctx`、多周期 K 线快照、持仓、成交、保证金、保护单或回测时间线。不得声称能够访问这些数据，也不得把止盈止损、开平仓、资金管理或策略调优写成指标功能。
- 用户提出策略研究需求时，只能把其中可由当前图表 OHLCV 计算的部分做成可视化研究证据，例如均线、通道、动量或条件状态；description 必须清楚表明它是图表研究用途，不能暗示已产生交易或可直接执行。多周期、持仓或历史回放需求不能用此 DSL 伪造实现。
- 指标 DSL 的 parameters 只是本地图表显示参数，不是策略的 `ctx.params`，也不是策略调优范围。不得使用策略参数、策略 API 或任何交易动作命名为可执行接口。
- 不确定用户想法时，选择稳健常用默认值并在 description 中说明。
- 用户明确要求创建或更新时才调用一次 script.createOrUpdate；工具成功返回后再用一句中文说明已生成。"##;
const MARKET_WS_MAX_BACKOFF_SECS: u64 = 15;
const OKX_ACCOUNT_CONFIG_CACHE_TTL_MS: i64 = 5 * 60_000;
const TRADE_PRECHECK_SNAPSHOT_MAX_AGE_MS: i64 = 5_000;
const OKX_PUBLIC_REST_RETRY_DELAYS_MS: [u64; 6] = [500, 1_000, 2_000, 3_000, 5_000, 8_000];
const OKX_PUBLIC_REST_RATE_LIMIT_RETRY_MS: u64 = 2_200;
const OKX_PUBLIC_REST_MAX_CONCURRENT: usize = 4;
const OKX_PUBLIC_REST_DEFAULT_MIN_INTERVAL_MS: u64 = 80;
const OKX_MARKET_CANDLES_MIN_INTERVAL_MS: u64 = 60;
const OKX_HISTORY_CANDLES_MIN_INTERVAL_MS: u64 = 120;
const AI_CANDLE_MEMORY_LIMIT: usize = 360;
const AI_CANDLE_REPAIR_WINDOW_MINUTES: i64 = 240;
const AI_CANDLE_CONFIRM_GRACE_MS: i64 = 15_000;

static OKX_PUBLIC_REST_SEMAPHORE: OnceLock<Semaphore> = OnceLock::new();
static OKX_PUBLIC_REST_LAST_REQUEST: OnceLock<AsyncMutex<Option<Instant>>> = OnceLock::new();
static OKX_MARKET_CANDLES_LAST_REQUEST: OnceLock<AsyncMutex<Option<Instant>>> = OnceLock::new();
static OKX_HISTORY_CANDLES_LAST_REQUEST: OnceLock<AsyncMutex<Option<Instant>>> = OnceLock::new();
static OKX_CLOCK_OFFSET_MS: AtomicI64 = AtomicI64::new(0);
static OKX_CLOCK_SYNC_GENERATION: AtomicU64 = AtomicU64::new(0);
static OKX_CLOCK_SYNC_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());
pub(crate) static TRADE_MUTATION_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());
static ACCOUNT_CONFIG_MUTATION_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());
static ACCOUNT_MUTATION_LEASE_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static TRADE_PLAN_EVALUATION_SEQUENCE: AtomicU64 = AtomicU64::new(1);

const ACCOUNT_MUTATION_LEASE_MS: i64 = 120_000;

#[derive(Debug, Clone)]
pub(crate) struct AccountMutationLease {
    lease_id: String,
    account_id: String,
    credential_fingerprint: String,
}
static CHART_WINDOWS: OnceLock<Mutex<HashMap<String, ChartWindowState>>> = OnceLock::new();

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChartWindowRequest {
    id: Option<String>,
    symbol: String,
    timeframe: String,
    account_id: Option<String>,
    environment: Option<String>,
    #[serde(default)]
    single_pane: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChartPaneState {
    id: String,
    symbol: String,
    timeframe: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChartWindowState {
    id: String,
    label: String,
    symbol: String,
    timeframe: String,
    account_id: Option<String>,
    environment: Option<String>,
    #[serde(default)]
    single_pane: bool,
    panes: Vec<ChartPaneState>,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChartWindowSummary {
    id: String,
    label: String,
    symbol: String,
    timeframe: String,
    account_id: Option<String>,
    environment: Option<String>,
    single_pane: bool,
    panes: Vec<ChartPaneState>,
    updated_at: i64,
    is_open: bool,
}

const CHART_WORKSPACE_JSON_MAX_BYTES: usize = 1_048_576;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChartWorkspaceInput {
    #[serde(default)]
    id: Option<String>,
    name: String,
    #[serde(default = "empty_chart_json")]
    layout: Value,
    #[serde(default = "empty_chart_json")]
    indicators: Value,
    #[serde(default = "empty_chart_json")]
    layers: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChartWorkspace {
    id: String,
    name: String,
    layout: Value,
    indicators: Value,
    layers: Value,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChartWorkspaceViewInput {
    #[serde(default)]
    id: Option<String>,
    workspace_id: String,
    sort_order: i64,
    symbol: String,
    timeframe: String,
    #[serde(default = "empty_chart_json")]
    layout: Value,
    #[serde(default = "empty_chart_json")]
    indicators: Value,
    #[serde(default = "empty_chart_json")]
    layers: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChartWorkspaceView {
    id: String,
    workspace_id: String,
    sort_order: i64,
    symbol: String,
    timeframe: String,
    layout: Value,
    indicators: Value,
    layers: Value,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChartDrawingInput {
    id: String,
    workspace_id: String,
    #[serde(default)]
    view_id: Option<String>,
    #[serde(default = "empty_chart_json")]
    drawing: Value,
    #[serde(default = "empty_chart_json")]
    layer: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChartDrawing {
    id: String,
    workspace_id: String,
    view_id: Option<String>,
    drawing: Value,
    layer: Value,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChartAlertInput {
    id: String,
    workspace_id: String,
    #[serde(default)]
    view_id: Option<String>,
    status: String,
    #[serde(default)]
    last_triggered_at: Option<i64>,
    #[serde(default = "empty_chart_json")]
    definition: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChartAlert {
    id: String,
    workspace_id: String,
    view_id: Option<String>,
    status: String,
    last_triggered_at: Option<i64>,
    definition: Value,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChartAlertEvent {
    id: String,
    alert_id: String,
    workspace_id: String,
    inst_id: String,
    condition_kind: String,
    direction: String,
    trigger_price: f64,
    last_price: f64,
    triggered_at: i64,
    delivery_status: String,
    name: String,
    message: String,
    notify_app: bool,
    frequency: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChartDslCandleInput {
    time: i64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChartDslEvaluateInput {
    expression: desic_chart_dsl::Expression,
    candles: Vec<ChartDslCandleInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChartDslEvaluateResult {
    value_type: String,
    values: Value,
    node_count: usize,
    max_lookback: usize,
}

trait AsyncReadWrite: AsyncRead + AsyncWrite {}
impl<T: AsyncRead + AsyncWrite + ?Sized> AsyncReadWrite for T {}

type BoxedIo = Box<dyn AsyncReadWrite + Unpin + Send>;
type OkxWebSocket = WebSocketStream<BoxedIo>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OkxTimeState {
    okx_server_ms: i64,
    local_send_ms: i64,
    local_recv_ms: i64,
    rtt_ms: i64,
    clock_offset_ms: i64,
    status: String,
}

#[derive(Debug, Deserialize)]
struct OkxEnvelope<T> {
    code: String,
    msg: String,
    data: Vec<T>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClassifiedOkxError {
    desic_terminal_error: bool,
    source: String,
    operation: String,
    category: String,
    code: String,
    message: String,
    user_message: String,
    suggestion: String,
    retryable: bool,
}

#[derive(Debug, Deserialize)]
struct OkxTime {
    ts: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Ticker {
    inst_id: String,
    last: String,
    last_sz: String,
    ask_px: String,
    ask_sz: String,
    bid_px: String,
    bid_sz: String,
    open24h: String,
    high24h: String,
    low24h: String,
    vol24h: String,
    vol_ccy24h: String,
    #[serde(deserialize_with = "deserialize_i64_from_string")]
    ts: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Candle {
    time: i64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: f64,
    confirm: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HistoricalCandlesPage {
    candles: Vec<Candle>,
    earliest_time: Option<i64>,
    exhausted: bool,
    source: String,
}

#[derive(Debug, Default)]
struct HistoricalLocalPage {
    candles: Vec<Candle>,
    exhausted_before_open: Option<i64>,
}

#[derive(Debug)]
struct HistoryCandlesFetch {
    candles: Vec<RawCandle>,
    exhausted: bool,
}

#[derive(Debug, Clone)]
struct RawCandle {
    open_time_ms: i64,
    open: String,
    high: String,
    low: String,
    close: String,
    volume: String,
    volume_ccy: Option<String>,
    volume_quote: Option<String>,
    confirm: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct KlineSyncReport {
    symbol: String,
    interval: String,
    status: String,
    expected: usize,
    existing: usize,
    missing: usize,
    invalid: usize,
    invalid_reasons: Vec<String>,
    attempt: usize,
    retry_state: String,
    retry_after: Option<i64>,
    fetched: usize,
    inserted: usize,
    started_at: i64,
    finished_at: Option<i64>,
    message: String,
    progress_detail: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct KlineSyncSummary {
    reports: Vec<KlineSyncReport>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KlineSyncRequest {
    symbols: Vec<String>,
    intervals: Option<Vec<String>>,
    blocking: Option<bool>,
    recent_hours: Option<i64>,
    required_days: Option<HashMap<String, i64>>,
}

#[derive(Debug, Serialize, Clone)]
struct OrderBookLevel {
    px: String,
    sz: String,
    orders: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OrderBook {
    bids: Vec<OrderBookLevel>,
    asks: Vec<OrderBookLevel>,
    ts: i64,
    seq_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Trade {
    #[serde(rename = "tradeId")]
    trade_id: String,
    px: String,
    sz: String,
    side: String,
    #[serde(deserialize_with = "deserialize_i64_from_string")]
    ts: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct FundingRate {
    #[serde(default)]
    inst_type: String,
    #[serde(default)]
    inst_id: String,
    #[serde(default)]
    funding_rate: String,
    #[serde(default)]
    next_funding_rate: String,
    #[serde(default, deserialize_with = "deserialize_i64_from_string_or_default")]
    funding_time: i64,
    #[serde(default, deserialize_with = "deserialize_i64_from_string_or_default")]
    next_funding_time: i64,
    #[serde(default)]
    method: String,
    #[serde(default, deserialize_with = "deserialize_i64_from_string_or_default")]
    ts: i64,
}

#[derive(Default)]
struct MarketStore {
    ticker: Option<Ticker>,
    tickers: HashMap<String, Ticker>,
    orderbook: Option<OrderBook>,
    orderbook_inst_id: Option<String>,
    orderbook_seq_id: Option<i64>,
    orderbooks: HashMap<String, OrderBook>,
    orderbook_seq_ids: HashMap<String, i64>,
    trades: Vec<Trade>,
    trades_inst_id: Option<String>,
    trades_by_inst: HashMap<String, Vec<Trade>>,
    candle: Option<Candle>,
    candle_inst_id: Option<String>,
    candle_bar: Option<String>,
    candles: HashMap<String, Candle>,
    recent_candles: HashMap<String, Vec<Candle>>,
    funding_rates: HashMap<String, FundingRate>,
    private_snapshot: Option<PrivateAccountSnapshot>,
    private_snapshots: HashMap<String, PrivateAccountSnapshot>,
    // OKX can race a successful cancel with an older orders-pending REST
    // response. Keep the confirmed terminal state in the runtime store until
    // the stale response window has passed.
    cancelled_pending_order_keys: HashMap<String, i64>,
}

#[derive(Debug, Default, Clone)]
struct MarketHealth {
    clock_offset_ms: Option<i64>,
    public_event_time_ms: Option<i64>,
    public_delay_ms: Option<i64>,
    public_updated_at_ms: Option<i64>,
    private_event_time_ms: Option<i64>,
    private_delay_ms: Option<i64>,
    private_updated_at_ms: Option<i64>,
}

#[derive(Debug, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct MarketSnapshot {
    ticker: Option<Ticker>,
    tickers: HashMap<String, Ticker>,
    orderbook: Option<OrderBook>,
    orderbook_inst_id: Option<String>,
    orderbooks: HashMap<String, OrderBook>,
    trades: Vec<Trade>,
    trades_inst_id: Option<String>,
    trades_by_inst: HashMap<String, Vec<Trade>>,
    candle: Option<Candle>,
    candle_inst_id: Option<String>,
    candle_bar: Option<String>,
    candles: HashMap<String, Candle>,
    funding_rates: HashMap<String, FundingRate>,
    private_snapshot: Option<PrivateAccountSnapshot>,
    private_snapshots: HashMap<String, PrivateAccountSnapshot>,
}

#[derive(Clone)]
struct MarketRuntime {
    public_tasks: Arc<Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>>,
    public_session_id: Arc<Mutex<Option<String>>>,
    market_consumers: Arc<Mutex<chart_consumers::MarketConsumerRegistry>>,
    public_controls: Arc<Mutex<HashMap<String, market_ws::PublicStreamControl>>>,
    candle_repair_locks: Arc<Mutex<HashMap<String, Arc<AsyncMutex<()>>>>>,
    private_tasks: Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
    private_account_fingerprints: Arc<Mutex<HashMap<String, String>>>,
    store: Arc<Mutex<MarketStore>>,
    health: Arc<Mutex<MarketHealth>>,
    private_trade: Arc<tokio::sync::Mutex<HashMap<String, PrivateTradeSocketHandle>>>,
    account_config_cache: Arc<Mutex<HashMap<String, CachedAccountConfig>>>,
}

impl Default for MarketRuntime {
    fn default() -> Self {
        Self {
            public_tasks: Arc::new(Mutex::new(Vec::new())),
            public_session_id: Arc::new(Mutex::new(None)),
            market_consumers: Arc::new(Mutex::new(chart_consumers::MarketConsumerRegistry::new())),
            public_controls: Arc::new(Mutex::new(HashMap::new())),
            candle_repair_locks: Arc::new(Mutex::new(HashMap::new())),
            private_tasks: Arc::new(Mutex::new(HashMap::new())),
            private_account_fingerprints: Arc::new(Mutex::new(HashMap::new())),
            store: Arc::new(Mutex::new(MarketStore::default())),
            health: Arc::new(Mutex::new(MarketHealth::default())),
            private_trade: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            account_config_cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[derive(Clone)]
struct CachedAccountConfig {
    fingerprint: String,
    config: OkxAccountConfig,
    updated_at: i64,
}

#[derive(Clone)]
struct PrivateTradeSocketHandle {
    account_id: String,
    environment: String,
    sender: mpsc::UnboundedSender<PrivateTradeCommand>,
}

struct PrivateTradeCommand {
    message_id: String,
    payload: serde_json::Value,
    ack: oneshot::Sender<Result<serde_json::Value, String>>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
enum MarketEvent {
    Status {
        status: String,
    },
    PublicStatus {
        #[serde(rename = "streamId")]
        stream_id: String,
        kind: String,
        state: String,
        status: String,
        symbols: Vec<String>,
        #[serde(rename = "eventAt")]
        event_at: i64,
        #[serde(rename = "lastReceivedAt")]
        last_received_at: Option<i64>,
        #[serde(rename = "delayMs")]
        delay_ms: Option<i64>,
        #[serde(rename = "reconnectAttempt")]
        reconnect_attempt: u32,
    },
    Ticker {
        ticker: Ticker,
    },
    RenderBatch {
        #[serde(rename = "orderBooks")]
        order_books: HashMap<String, OrderBook>,
        trades: HashMap<String, Vec<Trade>>,
    },
    Candle {
        #[serde(rename = "instId")]
        inst_id: String,
        bar: String,
        candle: Candle,
    },
    FundingRate {
        funding: FundingRate,
    },
    PrivateSnapshot {
        snapshot: PrivateAccountSnapshot,
    },
    PrivateOrder {
        #[serde(rename = "accountId")]
        account_id: String,
        environment: String,
        order: OkxPendingOrder,
    },
    PrivateStatus {
        status: String,
        state: String,
        #[serde(rename = "accountId")]
        account_id: Option<String>,
        environment: Option<String>,
        #[serde(rename = "delayMs")]
        delay_ms: Option<i64>,
        #[serde(rename = "eventAt")]
        event_at: i64,
        #[serde(rename = "reconnectAttempt")]
        reconnect_attempt: u32,
        #[serde(rename = "lastReceivedAt")]
        last_received_at: Option<i64>,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PublicMessageAction {
    Continue,
    Resubscribe(String),
}

#[derive(Default, Clone)]
struct AiRuntime {
    tasks: Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
    sidecar: Arc<tokio::sync::Mutex<Option<AiSidecarHandle>>>,
    session_sinks: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<AiEvent>>>>,
    session_cancelled: Arc<Mutex<HashMap<String, bool>>>,
}

#[derive(Clone)]
struct DatabaseRuntime {
    state: Arc<(Mutex<DatabaseStartupState>, Condvar)>,
}

enum DatabaseStartupState {
    Initializing,
    Ready,
    Failed(String),
}

impl Default for DatabaseRuntime {
    fn default() -> Self {
        Self {
            state: Arc::new((
                Mutex::new(DatabaseStartupState::Initializing),
                Condvar::new(),
            )),
        }
    }
}

impl DatabaseRuntime {
    fn wait_until_ready(&self) -> Result<(), String> {
        let (state, ready) = &*self.state;
        let mut current = state
            .lock()
            .map_err(|_| "数据库初始化状态不可用".to_string())?;
        loop {
            match &*current {
                DatabaseStartupState::Ready => return Ok(()),
                DatabaseStartupState::Failed(error) => {
                    return Err(format!("数据库初始化失败：{error}"));
                }
                DatabaseStartupState::Initializing => {
                    current = ready
                        .wait(current)
                        .map_err(|_| "数据库初始化状态不可用".to_string())?;
                }
            }
        }
    }

    fn complete(&self, result: Result<(), String>) {
        let (state, ready) = &*self.state;
        if let Ok(mut current) = state.lock() {
            *current = match result {
                Ok(()) => DatabaseStartupState::Ready,
                Err(error) => DatabaseStartupState::Failed(error),
            };
            ready.notify_all();
        }
    }
}

#[derive(Debug, Clone, Eq, Hash, PartialEq)]
struct KlineSyncKey {
    symbol: String,
    interval: String,
}

#[derive(Clone, Default)]
struct KlineSyncRuntime {
    running: Arc<AsyncMutex<HashSet<KlineSyncKey>>>,
}

impl KlineSyncRuntime {
    async fn reserve(&self, symbols: &[String], intervals: &[String]) -> HashSet<KlineSyncKey> {
        let mut running = self.running.lock().await;
        let mut reserved = HashSet::new();
        for symbol in symbols {
            for interval in intervals {
                let key = KlineSyncKey {
                    symbol: symbol.clone(),
                    interval: interval.clone(),
                };
                if running.insert(key.clone()) {
                    reserved.insert(key);
                }
            }
        }
        reserved
    }

    async fn release(&self, keys: &HashSet<KlineSyncKey>) {
        let mut running = self.running.lock().await;
        for key in keys {
            running.remove(key);
        }
    }
}

#[derive(Clone)]
struct AiSidecarHandle {
    id: String,
    sender: mpsc::UnboundedSender<AiSidecarCommand>,
    proxy_url: Option<String>,
}

struct AiSidecarCommand {
    payload: serde_json::Value,
    ack: oneshot::Sender<Result<(), String>>,
}

#[derive(Debug, PartialEq, Eq)]
struct AiSidecarRuntimePaths {
    node_binary: PathBuf,
    entry: PathBuf,
    launch_dir: PathBuf,
    work_dir: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WsProbeResult {
    ok: bool,
    latency_ms: i64,
    message: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AiSession {
    id: String,
    title: String,
    status: String,
    origin: AiSessionOrigin,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum AiSessionOrigin {
    User,
    Automation,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AiStoredMessage {
    id: String,
    session_id: String,
    role: String,
    content: String,
    reasoning: Option<String>,
    tool_json: Option<String>,
    status: Option<String>,
    created_at: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AiSessionSnapshot {
    session: AiSession,
    messages: Vec<AiStoredMessage>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AiChatMessage {
    id: Option<String>,
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiSendRequest {
    session_id: String,
    messages: Vec<AiChatMessage>,
    account_id: Option<String>,
    model_id: Option<String>,
    permission_mode: Option<String>,
    reasoning_depth: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiChartIndicatorGenerateRequest {
    session_id: String,
    prompt: String,
    #[serde(default)]
    messages: Vec<AiChatMessage>,
}

#[derive(Debug, Clone, Default)]
struct AiStreamOptions {
    model_id: Option<String>,
    permission_mode: Option<String>,
    reasoning_depth: Option<String>,
    system_prompt: Option<String>,
    custom_rules: Option<String>,
    enabled_skills: Option<Vec<String>>,
    runtime_scoped_skills: Vec<desic_storage_config::AiSkillDefinition>,
    clear_skill_definitions: bool,
    disable_skills_tool: Option<bool>,
    enable_spawn_agent: Option<bool>,
    enable_agent_teams: Option<bool>,
    stream_fallback_text: bool,
    max_iterations: Option<u16>,
    tool_allowlist: Vec<String>,
    required_tool_name: Option<String>,
    interactive_account_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiApprovalDecision {
    session_id: String,
    approval_id: String,
    approved: bool,
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiSessionLoadRequest {
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiSessionCreateRequest {
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiSessionRenameRequest {
    session_id: String,
    title: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiSessionDeleteRequest {
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RebuildPositionEpisodesRequest {
    account_id: Option<String>,
    inst_id: Option<String>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RebuildPositionEpisodesResult {
    pub account_id: String,
    pub environment: String,
    pub inst_id: Option<String>,
    pub fills_scanned: usize,
    pub episodes_built: usize,
    pub events_built: usize,
    pub incomplete_events: usize,
    pub started_at: i64,
    pub finished_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PositionEpisodesRequest {
    account_id: Option<String>,
    inst_id: Option<String>,
    limit: Option<u16>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoricalOrdersRequest {
    account_id: Option<String>,
    inst_id: Option<String>,
    limit: Option<u16>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoricalFillsRequest {
    account_id: Option<String>,
    inst_id: Option<String>,
    limit: Option<u16>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountBillsRequest {
    account_id: Option<String>,
    inst_id: Option<String>,
    limit: Option<u16>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountPerformanceRequest {
    account_id: Option<String>,
    environment: Option<String>,
    inst_id: Option<String>,
    start_time: Option<i64>,
    end_time: Option<i64>,
}

#[derive(Debug, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct AccountPerformanceCoverage {
    has_bills: bool,
    has_fills: bool,
    has_episodes: bool,
    bills_count: usize,
    fills_count: usize,
    episodes_count: usize,
    oldest_point: Option<i64>,
    newest_point: Option<i64>,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct AccountPerformancePoint {
    time: i64,
    equity: f64,
    cumulative_return_pct: f64,
    drawdown_pct: f64,
}

#[derive(Debug, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct AccountPerformanceTotals {
    current_equity: f64,
    start_equity: Option<f64>,
    net_pnl: f64,
    return_pct: Option<f64>,
    max_drawdown_pct: f64,
    gross_profit: f64,
    gross_loss: f64,
    profit_factor: Option<f64>,
    fees: f64,
    funding_fee: f64,
    trade_count: usize,
    fill_count: usize,
    episode_count: usize,
    win_rate_pct: Option<f64>,
}

#[derive(Debug, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct AccountPerformanceAttribution {
    operator: String,
    label: String,
    net_pnl: f64,
    return_pct: Option<f64>,
    fees: f64,
    trade_count: usize,
    episode_count: usize,
    win_rate_pct: Option<f64>,
}

#[derive(Debug, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct AccountPerformanceSymbolBreakdown {
    inst_id: String,
    net_pnl: f64,
    fees: f64,
    trade_count: usize,
    episode_count: usize,
    win_rate_pct: Option<f64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PerformanceEpisodeHighlight {
    id: String,
    inst_id: String,
    side: String,
    status: String,
    net_pnl: f64,
    return_pct: Option<f64>,
    open_time: i64,
    close_time: Option<i64>,
    duration_ms: Option<i64>,
    max_qty: String,
    fees: f64,
    funding_fee: f64,
}

#[derive(Debug, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct AccountPerformanceHighlights {
    best_episode: Option<PerformanceEpisodeHighlight>,
    worst_episode: Option<PerformanceEpisodeHighlight>,
    longest_episode: Option<PerformanceEpisodeHighlight>,
    shortest_episode: Option<PerformanceEpisodeHighlight>,
}

#[derive(Debug, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct AccountPerformanceDailyPnl {
    date: String,
    net_pnl: f64,
    fees: f64,
    trade_count: usize,
}

#[derive(Debug, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct AccountPerformanceSummary {
    account_id: String,
    environment: String,
    start_time: Option<i64>,
    end_time: Option<i64>,
    generated_at: i64,
    coverage: AccountPerformanceCoverage,
    equity_curve: Vec<AccountPerformancePoint>,
    totals: AccountPerformanceTotals,
    attribution: Vec<AccountPerformanceAttribution>,
    symbol_breakdown: Vec<AccountPerformanceSymbolBreakdown>,
    highlights: AccountPerformanceHighlights,
    daily_pnl: Vec<AccountPerformanceDailyPnl>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountBillsArchiveRequest {
    account_id: Option<String>,
    year: String,
    quarter: String,
    bill_type: Option<String>,
    apply: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountBillsArchiveImportRequest {
    account_id: Option<String>,
    year: String,
    quarter: String,
    bill_type: Option<String>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct HistoricalOrderSummary {
    account_id: String,
    environment: String,
    ord_id: String,
    cl_ord_id: Option<String>,
    inst_id: String,
    inst_type: String,
    side: Option<String>,
    pos_side: Option<String>,
    td_mode: Option<String>,
    ord_type: Option<String>,
    state: Option<String>,
    px: Option<String>,
    sz: Option<String>,
    acc_fill_sz: Option<String>,
    avg_px: Option<String>,
    pnl: Option<String>,
    fee: Option<String>,
    source_endpoint: String,
    operator: String,
    strategy_id: Option<String>,
    session_id: Option<String>,
    opportunity_id: Option<String>,
    agent_run_id: Option<String>,
    execution_key: Option<String>,
    okx_ctime: Option<i64>,
    okx_utime: Option<i64>,
    synced_at: i64,
}

#[derive(Debug, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct HistoricalFillSummary {
    account_id: String,
    environment: String,
    bill_id: String,
    ord_id: Option<String>,
    trade_id: Option<String>,
    inst_id: String,
    inst_type: String,
    side: Option<String>,
    pos_side: Option<String>,
    sub_type: Option<String>,
    fill_px: Option<String>,
    fill_sz: Option<String>,
    fill_pnl: Option<String>,
    fee: Option<String>,
    fee_ccy: Option<String>,
    source_endpoint: String,
    operator: String,
    strategy_id: Option<String>,
    session_id: Option<String>,
    opportunity_id: Option<String>,
    agent_run_id: Option<String>,
    execution_key: Option<String>,
    okx_ts: Option<i64>,
    synced_at: i64,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct AccountBillSummary {
    account_id: String,
    environment: String,
    bill_id: String,
    inst_id: Option<String>,
    inst_type: Option<String>,
    ccy: Option<String>,
    bill_type: Option<String>,
    sub_type: Option<String>,
    bal: Option<String>,
    bal_chg: Option<String>,
    pos_bal: Option<String>,
    pos_bal_chg: Option<String>,
    sz: Option<String>,
    px: Option<String>,
    pnl: Option<String>,
    fee: Option<String>,
    ord_id: Option<String>,
    trade_id: Option<String>,
    cl_ord_id: Option<String>,
    exec_type: Option<String>,
    mgn_mode: Option<String>,
    notes: Option<String>,
    source_endpoint: String,
    okx_ts: Option<i64>,
    synced_at: i64,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct AccountBillsArchiveStatus {
    account_id: String,
    environment: String,
    year: String,
    quarter: String,
    bill_type: Option<String>,
    requested: bool,
    request_result: Option<String>,
    state: Option<String>,
    file_href: Option<String>,
    okx_ts: Option<i64>,
    updated_at: i64,
    raw_json: Option<String>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct AccountBillsArchiveImportResult {
    account_id: String,
    environment: String,
    year: String,
    quarter: String,
    bill_type: Option<String>,
    file_href: String,
    downloaded_path: String,
    rows_scanned: usize,
    rows_upserted: usize,
    started_at: i64,
    finished_at: i64,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct PositionEpisodeSummary {
    id: String,
    account_id: String,
    environment: String,
    inst_type: String,
    inst_id: String,
    episode_side: String,
    status: String,
    primary_origin: String,
    strategy_id: Option<String>,
    signal_id: Option<String>,
    trade_plan_id: Option<String>,
    open_time: i64,
    close_time: Option<i64>,
    open_qty: String,
    max_qty: String,
    closed_qty: String,
    remaining_qty: String,
    avg_open_px: Option<String>,
    avg_close_px: Option<String>,
    realized_pnl: Option<String>,
    fees: Option<String>,
    funding_fee: Option<String>,
    liq_penalty: Option<String>,
    net_pnl: Option<String>,
    last_trade_id: Option<String>,
    last_fill_time: Option<i64>,
    events: Vec<PositionEpisodeEventSummary>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiAutomationReviewDetailRequest {
    account_id: Option<String>,
    episode_id: String,
    bar: Option<String>,
    candle_limit: Option<u16>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct AiAutomationReviewDetail {
    episode: PositionEpisodeSummary,
    orders: Vec<HistoricalOrderSummary>,
    fills: Vec<HistoricalFillSummary>,
    candles: Vec<Candle>,
    bar: String,
    window_start: i64,
    window_end: i64,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PositionEpisodeEventSummary {
    id: String,
    event_type: String,
    origin: String,
    actor_id: Option<String>,
    strategy_id: Option<String>,
    ord_id: Option<String>,
    bill_id: Option<String>,
    trade_id: Option<String>,
    side: Option<String>,
    pos_side: Option<String>,
    qty: String,
    price: Option<String>,
    pnl: Option<String>,
    fee: Option<String>,
    fee_ccy: Option<String>,
    position_before: Option<String>,
    position_after: Option<String>,
    event_time: i64,
    source: String,
}

#[derive(Debug, Clone)]
struct EpisodeFillRow {
    bill_id: String,
    ord_id: Option<String>,
    trade_id: Option<String>,
    inst_id: String,
    inst_type: String,
    side: Option<String>,
    pos_side: Option<String>,
    sub_type: Option<String>,
    fill_px: Option<String>,
    fill_sz: Option<String>,
    fill_pnl: Option<String>,
    fee: Option<String>,
    fee_ccy: Option<String>,
    operator: Option<String>,
    strategy_id: Option<String>,
    session_id: Option<String>,
    okx_ts: i64,
    raw_json: String,
}

#[derive(Debug, Clone)]
struct EpisodeBillRow {
    bill_id: String,
    inst_id: String,
    inst_type: Option<String>,
    bill_type: Option<String>,
    sub_type: Option<String>,
    bal_chg: Option<String>,
    pos_bal_chg: Option<String>,
    sz: Option<String>,
    px: Option<String>,
    pnl: Option<String>,
    fee: Option<String>,
    ccy: Option<String>,
    ord_id: Option<String>,
    trade_id: Option<String>,
    cl_ord_id: Option<String>,
    mgn_mode: Option<String>,
    notes: Option<String>,
    source_endpoint: String,
    okx_ts: i64,
    raw_json: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
enum AiEvent {
    #[serde(rename_all = "camelCase")]
    Status {
        session_id: String,
        status: String,
        message: String,
    },
    #[serde(rename_all = "camelCase")]
    Delta {
        session_id: String,
        channel: String,
        content: String,
    },
    #[serde(rename_all = "camelCase")]
    ToolCall {
        session_id: String,
        tool_call_id: Option<String>,
        name: String,
        arguments: serde_json::Value,
        allowed: bool,
        blocked: bool,
        policy: String,
        agent_id: Option<String>,
        configured_agent_id: Option<String>,
        parent_agent_id: Option<String>,
        started_at: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    ToolResult {
        session_id: String,
        tool_call_id: Option<String>,
        name: String,
        result: serde_json::Value,
        summary: String,
        ok: bool,
        agent_id: Option<String>,
        configured_agent_id: Option<String>,
        parent_agent_id: Option<String>,
        started_at: Option<i64>,
        ended_at: Option<i64>,
        requested_at: Option<i64>,
        execution_started_at: Option<i64>,
        execution_ended_at: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    Usage {
        session_id: String,
        usage: serde_json::Value,
    },
    #[serde(rename_all = "camelCase")]
    AgentStart {
        session_id: String,
        agent_id: String,
        configured_agent_id: Option<String>,
        parent_agent_id: Option<String>,
        role: Option<String>,
        title: Option<String>,
        task: String,
        started_at: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    AgentDone {
        session_id: String,
        agent_id: String,
        configured_agent_id: Option<String>,
        status: String,
        result: serde_json::Value,
        error: Option<String>,
        ended_at: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    TeamEvent {
        session_id: String,
        event: serde_json::Value,
    },
    #[serde(rename_all = "camelCase")]
    ApprovalRequest {
        session_id: String,
        approval_id: String,
        tool_call_id: String,
        tool_name: String,
        input: serde_json::Value,
        reason: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ApprovalResolved {
        session_id: String,
        approval_id: String,
        approved: bool,
        reason: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ToolExecuteRequest {
        session_id: String,
        execution_id: String,
        tool_name: String,
        input: serde_json::Value,
        agent_id: Option<String>,
        parent_agent_id: Option<String>,
        agent_role: String,
        configured_agent_id: Option<String>,
        configured_agent_scopes: Vec<String>,
        permission_mode: Option<String>,
        background_run: bool,
        review_run: bool,
        agent_run_id: Option<String>,
        agent_profile_id: Option<String>,
        review_id: Option<String>,
        episode_id: Option<String>,
        requested_at: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    Error { session_id: String, message: String },
    #[serde(rename_all = "camelCase")]
    Done {
        session_id: String,
        finish_reason: Option<String>,
    },
}

#[tauri::command]
fn market_snapshot(runtime: tauri::State<'_, MarketRuntime>) -> Result<MarketSnapshot, String> {
    let store = runtime.store.lock().map_err(|err| err.to_string())?;
    Ok(MarketSnapshot {
        ticker: store.ticker.clone(),
        tickers: store.tickers.clone(),
        orderbook: store.orderbook.clone(),
        orderbook_inst_id: store.orderbook_inst_id.clone(),
        orderbooks: store.orderbooks.clone(),
        trades: store.trades.clone(),
        trades_inst_id: store.trades_inst_id.clone(),
        trades_by_inst: store.trades_by_inst.clone(),
        candle: store.candle.clone(),
        candle_inst_id: store.candle_inst_id.clone(),
        candle_bar: store.candle_bar.clone(),
        candles: store.candles.clone(),
        funding_rates: store.funding_rates.clone(),
        private_snapshot: store.private_snapshot.clone(),
        private_snapshots: store.private_snapshots.clone(),
    })
}

#[tauri::command]
async fn okx_sync_private_history(
    app: tauri::AppHandle,
    request: PrivateHistorySyncRequest,
) -> Result<PrivateHistorySyncResult, String> {
    sync_private_history_impl(app, request).await
}

#[tauri::command]
fn private_history_status(
    app: tauri::AppHandle,
    request: PrivateHistoryStatusRequest,
) -> Result<PrivateHistoryStatusResponse, String> {
    private_history_status_impl(app, request)
}

#[tauri::command]
fn rebuild_position_episodes(
    app: tauri::AppHandle,
    request: RebuildPositionEpisodesRequest,
) -> Result<RebuildPositionEpisodesResult, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    let mut conn = open_database(&app)?;
    rebuild_position_episodes_for_account(
        &mut conn,
        &account.id,
        &account.environment,
        request.inst_id.as_deref(),
    )
}

#[tauri::command]
fn position_episodes(
    app: tauri::AppHandle,
    request: PositionEpisodesRequest,
) -> Result<Vec<PositionEpisodeSummary>, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    let conn = open_database(&app)?;
    load_position_episodes(
        &conn,
        &account.id,
        &account.environment,
        request
            .inst_id
            .as_deref()
            .filter(|value| !value.trim().is_empty()),
        request.limit.unwrap_or(50).clamp(1, 200),
    )
}

#[tauri::command]
fn ai_automation_review_detail(
    app: tauri::AppHandle,
    request: AiAutomationReviewDetailRequest,
) -> Result<AiAutomationReviewDetail, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    let conn = open_database(&app)?;
    let mut episode = load_position_episode_by_id(
        &conn,
        &account.id,
        &account.environment,
        &request.episode_id,
    )?
    .ok_or_else(|| "未找到该复盘关联的 PositionEpisode".to_string())?;
    episode.events = load_position_episode_events(&conn, &episode.id)?;

    let start_ms = episode.open_time.saturating_sub(6 * 60 * 60 * 1000);
    let event_end = episode
        .events
        .iter()
        .map(|item| item.event_time)
        .max()
        .or(episode.last_fill_time)
        .unwrap_or(episode.open_time);
    let end_ms = episode
        .close_time
        .unwrap_or(event_end)
        .max(event_end)
        .saturating_add(6 * 60 * 60 * 1000);

    let order_ids = episode
        .events
        .iter()
        .filter_map(|item| item.ord_id.as_deref())
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .collect::<HashSet<_>>();
    let bill_ids = episode
        .events
        .iter()
        .filter_map(|item| item.bill_id.as_deref())
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .collect::<HashSet<_>>();
    let trade_ids = episode
        .events
        .iter()
        .filter_map(|item| item.trade_id.as_deref())
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .collect::<HashSet<_>>();

    let orders = load_episode_orders(&conn, &episode, &order_ids, start_ms, end_ms)?;
    let fills = load_review_episode_fills(
        &conn, &episode, &order_ids, &bill_ids, &trade_ids, start_ms, end_ms,
    )?;
    let bar = request.bar.unwrap_or_else(|| "15m".to_string());
    let candle_limit = request.candle_limit.unwrap_or(260).clamp(30, 800);
    let candles = aggregate_candles_from_1m(
        &conn,
        &episode.inst_id,
        &bar,
        Some(start_ms / 1000),
        Some(end_ms / 1000),
        candle_limit,
        false,
    )?;

    let mut warnings = Vec::new();
    if orders.is_empty() {
        warnings.push("未找到该仓位关联的历史委托记录；请确认历史委托补数已完成。".to_string());
    }
    if fills.is_empty() {
        warnings.push("未找到该仓位关联的历史成交记录；请确认历史成交补数已完成。".to_string());
    }
    if candles.is_empty() {
        warnings.push("未找到该仓位时间窗口内的 K 线；请先同步该交易对 1m K 线。".to_string());
    }

    Ok(AiAutomationReviewDetail {
        episode,
        orders,
        fills,
        candles,
        bar,
        window_start: start_ms,
        window_end: end_ms,
        warnings,
    })
}

#[tauri::command]
fn historical_orders(
    app: tauri::AppHandle,
    request: HistoricalOrdersRequest,
) -> Result<Vec<HistoricalOrderSummary>, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    let conn = open_database(&app)?;
    load_historical_orders(
        &conn,
        &account.id,
        &account.environment,
        request
            .inst_id
            .as_deref()
            .filter(|value| !value.trim().is_empty()),
        request.limit.unwrap_or(80).clamp(1, 300),
    )
}

#[tauri::command]
fn historical_fills(
    app: tauri::AppHandle,
    request: HistoricalFillsRequest,
) -> Result<Vec<HistoricalFillSummary>, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    let conn = open_database(&app)?;
    load_historical_fills(
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
fn account_bills(
    app: tauri::AppHandle,
    request: AccountBillsRequest,
) -> Result<Vec<AccountBillSummary>, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    let conn = open_database(&app)?;
    load_account_bills(
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
fn account_performance_summary(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, MarketRuntime>,
    request: AccountPerformanceRequest,
) -> Result<AccountPerformanceSummary, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    let environment = request
        .environment
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&account.environment)
        .to_string();
    let inst_id = request
        .inst_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let conn = open_database(&app)?;
    account_performance_summary_impl(
        &conn,
        runtime.inner(),
        &account.id,
        &environment,
        inst_id,
        request.start_time,
        request.end_time,
    )
}

#[tauri::command]
async fn account_bills_archive_status(
    app: tauri::AppHandle,
    request: AccountBillsArchiveRequest,
) -> Result<AccountBillsArchiveStatus, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    if !account.permissions.read {
        return Err("OKX API Key 未包含 read 权限，无法申请或查询账单归档".to_string());
    }
    let (year, quarter, bill_type) = normalize_archive_quarter(
        &request.year,
        &request.quarter,
        request.bill_type.as_deref(),
    )?;
    let conn = open_database(&app)?;
    let requested = request.apply.unwrap_or(false);
    if requested {
        let mut body = json!({
            "year": year,
            "quarter": quarter,
        });
        if let Some(value) = bill_type.as_deref() {
            body["type"] = json!(value);
        }
        let envelope = okx_private_post::<serde_json::Value, _>(
            &account,
            "/api/v5/account/bills-history-archive",
            &body,
        )
        .await?;
        let row = envelope
            .data
            .into_iter()
            .next()
            .unwrap_or_else(|| json!({ "result": "false" }));
        return upsert_account_bills_archive_status(
            &conn,
            &account,
            &year,
            &quarter,
            bill_type.as_deref(),
            true,
            &row,
        );
    }

    let row =
        fetch_account_bills_archive_status_row(&account, &year, &quarter, bill_type.as_deref())
            .await?;
    upsert_account_bills_archive_status(
        &conn,
        &account,
        &year,
        &quarter,
        bill_type.as_deref(),
        false,
        &row,
    )
}

#[tauri::command]
async fn import_account_bills_archive(
    app: tauri::AppHandle,
    request: AccountBillsArchiveImportRequest,
) -> Result<AccountBillsArchiveImportResult, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    if !account.permissions.read {
        return Err("OKX API Key 未包含 read 权限，无法下载账单归档".to_string());
    }
    let (year, quarter, bill_type) = normalize_archive_quarter(
        &request.year,
        &request.quarter,
        request.bill_type.as_deref(),
    )?;
    let mut conn = open_database(&app)?;
    let started_at = now_ms();
    let cached_status =
        load_account_bills_archive_status(&conn, &account, &year, &quarter, bill_type.as_deref())?;
    let status = match cached_status.and_then(|item| item.file_href.clone().map(|_| item)) {
        Some(item) => item,
        None => {
            let row = fetch_account_bills_archive_status_row(
                &account,
                &year,
                &quarter,
                bill_type.as_deref(),
            )
            .await?;
            upsert_account_bills_archive_status(
                &conn,
                &account,
                &year,
                &quarter,
                bill_type.as_deref(),
                false,
                &row,
            )?
        }
    };
    let file_href = status
        .file_href
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "账单归档文件尚未生成，请先申请归档或稍后查询。".to_string())?;
    let (downloaded_path, bytes) = download_account_bills_archive_file(
        &app,
        &account,
        &year,
        &quarter,
        bill_type.as_deref(),
        &file_href,
    )
    .await?;
    let rows = extract_account_bill_archive_rows(&bytes)?;
    let rows_scanned = rows.len();
    let swap_rows = rows
        .into_iter()
        .filter(|row| {
            json_string(row, "instType")
                .as_deref()
                .unwrap_or_default()
                .eq_ignore_ascii_case("SWAP")
                || json_string(row, "instId")
                    .as_deref()
                    .unwrap_or_default()
                    .ends_with("-SWAP")
        })
        .collect::<Vec<_>>();
    let rows_upserted = upsert_okx_account_bills(
        &mut conn,
        &account,
        "account-bills-history-archive-file",
        &swap_rows,
    )?;
    Ok(AccountBillsArchiveImportResult {
        account_id: account.id,
        environment: account.environment,
        year,
        quarter,
        bill_type,
        file_href,
        downloaded_path: downloaded_path.to_string_lossy().to_string(),
        rows_scanned,
        rows_upserted,
        started_at,
        finished_at: now_ms(),
    })
}

#[tauri::command]
fn ai_create_session(
    app: tauri::AppHandle,
    request: AiSessionCreateRequest,
) -> Result<AiSessionSnapshot, String> {
    let conn = open_database(&app)?;
    let session = create_ai_session(&conn, request.title.unwrap_or_else(|| "新对话".to_string()))?;
    Ok(AiSessionSnapshot {
        session,
        messages: Vec::new(),
    })
}

#[tauri::command]
fn ai_load_session(
    app: tauri::AppHandle,
    request: AiSessionLoadRequest,
) -> Result<AiSessionSnapshot, String> {
    let conn = open_database(&app)?;
    let session = load_or_create_ai_session(&conn, &request.session_id)?;
    let messages = load_ai_messages(&conn, &session.id)?;
    Ok(AiSessionSnapshot { session, messages })
}

#[tauri::command]
fn ai_list_sessions(app: tauri::AppHandle) -> Result<Vec<AiSession>, String> {
    let conn = open_database(&app)?;
    list_ai_sessions(&conn)
}

#[tauri::command]
fn ai_rename_session(
    app: tauri::AppHandle,
    request: AiSessionRenameRequest,
) -> Result<AiSession, String> {
    let title = request.title.trim();
    if title.is_empty() {
        return Err("会话标题不能为空".to_string());
    }
    let conn = open_database(&app)?;
    rename_ai_session(&conn, &request.session_id, title)?;
    load_ai_session(&conn, &request.session_id)
}

#[tauri::command]
fn ai_delete_session(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, AiRuntime>,
    request: AiSessionDeleteRequest,
) -> Result<(), String> {
    if request.session_id.trim().is_empty() {
        return Err("AI session_id is required".to_string());
    }
    let _ = stop_ai_session(&runtime, &request.session_id);
    let conn = open_database(&app)?;
    delete_ai_session(&conn, &request.session_id)
}

#[tauri::command]
fn ai_send_message(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, AiRuntime>,
    request: AiSendRequest,
) -> Result<(), String> {
    if request.session_id.trim().is_empty() {
        return Err("AI session_id is required".to_string());
    }
    if request.messages.is_empty() {
        return Err("AI messages are required".to_string());
    }
    {
        let conn = open_database(&app)?;
        let title = request
            .messages
            .iter()
            .rev()
            .find(|message| message.role == "user")
            .map(|message| message.content.chars().take(28).collect::<String>())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "AI 对话".to_string());
        upsert_ai_session(&conn, &request.session_id, &title, "running")?;
        if let Some(user_message) = request
            .messages
            .iter()
            .rev()
            .find(|message| message.role == "user")
        {
            let message_id = user_message
                .id
                .clone()
                .unwrap_or_else(|| format!("u-{}", now_ms()));
            upsert_ai_message(
                &conn,
                &message_id,
                &request.session_id,
                "user",
                &user_message.content,
                None,
                None,
                Some("sent"),
            )?;
        }
    }
    stop_ai_session(&runtime, &request.session_id)?;

    let session_id = request.session_id.clone();
    let runtime_inner = runtime.inner().clone();
    let app_handle = app.clone();
    let task_session_id = session_id.clone();
    let task = tauri::async_runtime::spawn(async move {
        emit_ai(
            &app_handle,
            AiEvent::Status {
                session_id: task_session_id.clone(),
                status: "connecting".to_string(),
                message: "连接模型服务".to_string(),
            },
        );
        let options = AiStreamOptions {
            interactive_account_id: request.account_id.clone(),
            model_id: request.model_id.clone(),
            permission_mode: request.permission_mode.clone(),
            reasoning_depth: request.reasoning_depth.clone(),
            ..Default::default()
        };
        if let Err(message) = run_ai_stream(
            app_handle.clone(),
            runtime_inner.clone(),
            task_session_id.clone(),
            request.messages,
            None,
            Some(options),
        )
        .await
        {
            emit_ai(
                &app_handle,
                AiEvent::Error {
                    session_id: task_session_id.clone(),
                    message: message.clone(),
                },
            );
            if let Ok(conn) = open_database(&app_handle) {
                let _ = set_ai_session_status(&conn, &task_session_id, "failed");
                let _ = upsert_ai_message(
                    &conn,
                    &format!("a-error-{}", now_ms()),
                    &task_session_id,
                    "assistant",
                    "",
                    None,
                    None,
                    Some(&message),
                );
            }
        }
        if let Ok(mut tasks) = runtime_inner.tasks.lock() {
            tasks.remove(&task_session_id);
        }
    });
    runtime
        .tasks
        .lock()
        .map_err(|err| err.to_string())?
        .insert(session_id, task);
    Ok(())
}

#[tauri::command]
fn ai_generate_chart_indicator(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, AiRuntime>,
    request: AiChartIndicatorGenerateRequest,
) -> Result<(), String> {
    let prompt = request.prompt.trim().to_string();
    if request.session_id.trim().is_empty() {
        return Err("AI session_id is required".to_string());
    }
    if prompt.is_empty() {
        return Err("请输入指标需求".to_string());
    }
    let mut messages = request.messages;
    let has_current_user_message = messages.last().is_some_and(|message| {
        message.role == "user" && message.content.trim() == prompt
    });
    if !has_current_user_message {
        messages.push(AiChatMessage {
            id: None,
            role: "user".to_string(),
            content: prompt.clone(),
        });
    }
    let message_id = messages
        .iter()
        .rev()
        .find(|message| message.role == "user" && !message.content.trim().is_empty())
        .and_then(|message| message.id.clone())
        .unwrap_or_else(|| format!("u-{}", now_ms()));
    {
        let conn = open_database(&app)?;
        let title = format!("AI 指标 · {}", prompt.chars().take(22).collect::<String>());
        upsert_ai_session(&conn, &request.session_id, &title, "running")?;
        upsert_ai_message(
            &conn,
            &message_id,
            &request.session_id,
            "user",
            &prompt,
            None,
            None,
            Some("sent"),
        )?;
    }
    stop_ai_session(&runtime, &request.session_id)?;

    let session_id = request.session_id.clone();
    let runtime_inner = runtime.inner().clone();
    let app_handle = app.clone();
    let task_session_id = session_id.clone();
    let task = tauri::async_runtime::spawn(async move {
        emit_ai(
            &app_handle,
            AiEvent::Status {
                session_id: task_session_id.clone(),
                status: "connecting".to_string(),
                message: "连接指标助手".to_string(),
            },
        );
        let options = AiStreamOptions {
            model_id: None,
            permission_mode: Some("advisor".to_string()),
            reasoning_depth: None,
            system_prompt: Some(CHART_INDICATOR_AI_SYSTEM_PROMPT.to_string()),
            custom_rules: Some(
                "本次会话只允许使用 script.createOrUpdate。只有用户明确要求创建或更新指标且信息足够时才调用它；其他内容正常对话，不要声称已保存。"
                    .to_string(),
            ),
            enabled_skills: Some(Vec::new()),
            runtime_scoped_skills: Vec::new(),
            clear_skill_definitions: true,
            disable_skills_tool: Some(true),
            enable_spawn_agent: Some(false),
            enable_agent_teams: Some(false),
            stream_fallback_text: false,
            max_iterations: Some(8),
            tool_allowlist: vec!["script.createOrUpdate".to_string()],
            required_tool_name: None,
            interactive_account_id: None,
        };
        if let Err(message) = run_ai_stream(
            app_handle.clone(),
            runtime_inner.clone(),
            task_session_id.clone(),
            messages,
            None,
            Some(options),
        )
        .await
        {
            emit_ai(
                &app_handle,
                AiEvent::Error {
                    session_id: task_session_id.clone(),
                    message: message.clone(),
                },
            );
            if let Ok(conn) = open_database(&app_handle) {
                let _ = set_ai_session_status(&conn, &task_session_id, "failed");
                let _ = upsert_ai_message(
                    &conn,
                    &format!("a-error-{}", now_ms()),
                    &task_session_id,
                    "assistant",
                    "",
                    None,
                    None,
                    Some(&message),
                );
            }
        }
        if let Ok(mut tasks) = runtime_inner.tasks.lock() {
            tasks.remove(&task_session_id);
        }
    });
    runtime
        .tasks
        .lock()
        .map_err(|err| err.to_string())?
        .insert(session_id, task);
    Ok(())
}

#[tauri::command]
async fn ai_stop(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, AiRuntime>,
    session_id: String,
) -> Result<(), String> {
    systematic_strategy_ai_cancel_session(&app, &session_id).await;
    let _ = send_ai_sidecar_command(
        &app,
        runtime.inner(),
        json!({
            "type": "stop",
            "sessionId": session_id.clone()
        }),
    )
    .await;
    stop_ai_session(&runtime, &session_id)?;
    if let Ok(conn) = open_database(&app) {
        let _ = set_ai_session_status(&conn, &session_id, "stopped");
    }
    emit_ai(
        &app,
        AiEvent::Done {
            session_id: session_id.clone(),
            finish_reason: Some("cancelled".to_string()),
        },
    );
    clear_ai_session_runtime(runtime.inner(), &session_id);
    Ok(())
}

#[tauri::command]
async fn ai_approve_tool(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, AiRuntime>,
    decision: AiApprovalDecision,
) -> Result<(), String> {
    send_ai_sidecar_command(
        &app,
        runtime.inner(),
        json!({
            "type": "approvalDecision",
            "sessionId": decision.session_id,
            "approvalId": decision.approval_id,
            "approved": decision.approved,
            "reason": decision.reason
        }),
    )
    .await
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PrivateAccountSnapshot {
    account_id: String,
    environment: String,
    balances: Vec<OkxBalance>,
    positions: Vec<OkxPosition>,
    orders: Vec<OkxPendingOrder>,
    #[serde(default)]
    positions_complete: bool,
    #[serde(default)]
    position_seq_id: Option<i64>,
    #[serde(default)]
    orders_complete: bool,
    #[serde(default)]
    orders_error: Option<String>,
    synced_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct OkxBalanceEnvelope {
    #[serde(default)]
    details: Vec<OkxBalance>,
    #[serde(default)]
    total_eq: String,
    #[serde(default)]
    adj_eq: String,
    #[serde(default)]
    u_time: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct OkxBalance {
    #[serde(default)]
    ccy: String,
    #[serde(default)]
    eq: String,
    #[serde(default)]
    avail_eq: String,
    #[serde(default)]
    avail_bal: String,
    #[serde(default)]
    cash_bal: String,
    #[serde(default)]
    frozen_bal: String,
    #[serde(default)]
    u_time: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct OkxPosition {
    #[serde(default)]
    inst_id: String,
    #[serde(default)]
    inst_type: String,
    #[serde(default)]
    mgn_mode: String,
    #[serde(default)]
    pos_side: String,
    #[serde(default)]
    pos: String,
    #[serde(default)]
    avg_px: String,
    #[serde(default)]
    mark_px: String,
    #[serde(default)]
    upl: String,
    #[serde(default)]
    upl_ratio: String,
    #[serde(default)]
    upl_last_px: String,
    #[serde(default)]
    upl_ratio_last_px: String,
    #[serde(default)]
    lever: String,
    #[serde(default)]
    liq_px: String,
    #[serde(default)]
    imr: String,
    #[serde(default)]
    margin: String,
    #[serde(default)]
    mgn_ratio: String,
    #[serde(default)]
    notional_usd: String,
    #[serde(default)]
    adl: String,
    #[serde(default)]
    ccy: String,
    #[serde(default)]
    pos_id: String,
    #[serde(default)]
    c_time: String,
    #[serde(default)]
    u_time: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct OkxPendingOrder {
    #[serde(default)]
    inst_id: String,
    #[serde(default)]
    inst_type: String,
    #[serde(default)]
    ord_id: String,
    #[serde(default)]
    cl_ord_id: String,
    #[serde(default)]
    algo_id: String,
    #[serde(default)]
    algo_cl_ord_id: String,
    #[serde(default)]
    is_algo: bool,
    #[serde(default)]
    side: String,
    #[serde(default)]
    pos_side: String,
    #[serde(default)]
    td_mode: String,
    #[serde(default)]
    ord_type: String,
    #[serde(default)]
    px: String,
    #[serde(default)]
    trigger_px: String,
    #[serde(default)]
    trigger_px_type: String,
    #[serde(default)]
    ord_px: String,
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
    sz: String,
    #[serde(default)]
    acc_fill_sz: String,
    #[serde(default)]
    avg_px: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    lever: String,
    #[serde(default)]
    reduce_only: String,
    #[serde(default)]
    c_time: String,
    #[serde(default)]
    u_time: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct OkxAlgoPendingOrder {
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
    trigger_px: String,
    #[serde(default)]
    trigger_px_type: String,
    #[serde(default)]
    ord_px: String,
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
    sz: String,
    #[serde(default)]
    actual_sz: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    lever: String,
    #[serde(default)]
    reduce_only: String,
    #[serde(default)]
    c_time: String,
    #[serde(default)]
    u_time: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct OkxAccountConfig {
    #[serde(default)]
    uid: String,
    #[serde(default)]
    main_uid: String,
    #[serde(default)]
    acct_lv: String,
    #[serde(default)]
    acct_stp_mode: String,
    #[serde(default)]
    pos_mode: String,
    #[serde(default)]
    perm: String,
    #[serde(default)]
    ct_iso_mode: String,
    #[serde(default)]
    mgn_iso_mode: String,
    #[serde(default)]
    fee_type: String,
    #[serde(default)]
    level: String,
    #[serde(default)]
    level_tmp: String,
    #[serde(default)]
    role_type: String,
    #[serde(default)]
    stgy_type: String,
    #[serde(default)]
    liquidation_gear: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DetectedOkxAccountIdentity {
    environment: String,
    uid: String,
    main_uid: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OkxAccountConfigSummary {
    acct_lv: String,
    pos_mode: String,
    perm: String,
    acct_stp_mode: String,
    ct_iso_mode: String,
    fee_type: String,
    level: String,
    stgy_type: String,
    liquidation_gear: String,
    liquidation_gear_meaning: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct OkxFeeGroup {
    #[serde(default)]
    group_id: String,
    #[serde(default)]
    maker: String,
    #[serde(default)]
    taker: String,
    #[serde(default)]
    elp_maker: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct OkxTradeFee {
    #[serde(default)]
    inst_type: String,
    #[serde(default)]
    level: String,
    #[serde(default)]
    maker: String,
    #[serde(default)]
    taker: String,
    #[serde(default)]
    maker_u: String,
    #[serde(default)]
    taker_u: String,
    #[serde(default)]
    maker_usdc: String,
    #[serde(default)]
    taker_usdc: String,
    #[serde(default)]
    ts: String,
    #[serde(default)]
    fee_group: Vec<OkxFeeGroup>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OkxTradeFeeSummary {
    maker: Option<f64>,
    taker: Option<f64>,
    group_id: Option<String>,
    level: String,
    ts: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct OkxMaxSize {
    #[serde(default)]
    inst_id: String,
    #[serde(default)]
    ccy: String,
    #[serde(default)]
    max_buy: String,
    #[serde(default)]
    max_sell: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct OkxMaxAvailSize {
    #[serde(default)]
    inst_id: String,
    #[serde(default)]
    avail_buy: String,
    #[serde(default)]
    avail_sell: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OkxMaxOrderSummary {
    max_buy: Option<f64>,
    max_sell: Option<f64>,
    avail_buy: Option<f64>,
    avail_sell: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct OkxPositionTier {
    #[serde(default)]
    uly: String,
    #[serde(default)]
    inst_family: String,
    #[serde(default)]
    inst_id: String,
    #[serde(default)]
    tier: String,
    #[serde(default)]
    min_sz: String,
    #[serde(default)]
    max_sz: String,
    #[serde(default)]
    mmr: String,
    #[serde(default)]
    imr: String,
    #[serde(default)]
    max_lever: String,
    #[serde(default)]
    opt_mgn_factor: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OkxPositionTierSummary {
    tier: String,
    min_sz: String,
    max_sz: String,
    mmr: String,
    imr: String,
    max_lever: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct OkxLeverageInfo {
    #[serde(default)]
    inst_id: String,
    #[serde(default)]
    mgn_mode: String,
    #[serde(default)]
    pos_side: String,
    #[serde(default)]
    lever: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeverageInfoRequest {
    account_id: Option<String>,
    inst_id: String,
    mgn_mode: String,
    environment: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SetLeverageRequest {
    account_id: Option<String>,
    inst_id: String,
    mgn_mode: String,
    lever: String,
    pos_side: Option<String>,
    environment: String,
    operator: Option<String>,
    opportunity_id: Option<String>,
    opportunity_revision: Option<i64>,
    agent_run_id: Option<String>,
    reason: Option<String>,
    #[serde(skip)]
    profile_target_authorized: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetLeverageResponse {
    inst_id: String,
    mgn_mode: String,
    requested_lever: String,
    results: Vec<OkxLeverageInfo>,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetLeverageBody {
    inst_id: String,
    lever: String,
    mgn_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pos_side: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct OkxInstrument {
    #[serde(default)]
    inst_id: String,
    #[serde(default, deserialize_with = "deserialize_string_from_value_or_default")]
    inst_id_code: String,
    #[serde(default)]
    inst_type: String,
    #[serde(default)]
    inst_family: String,
    #[serde(default)]
    base_ccy: String,
    #[serde(default)]
    quote_ccy: String,
    #[serde(default)]
    settle_ccy: String,
    #[serde(default)]
    ct_val: String,
    #[serde(default)]
    ct_val_ccy: String,
    #[serde(default)]
    ct_type: String,
    #[serde(default)]
    tick_sz: String,
    #[serde(default)]
    lot_sz: String,
    #[serde(default)]
    min_sz: String,
    #[serde(default)]
    max_lmt_sz: String,
    #[serde(default)]
    max_mkt_sz: String,
    #[serde(default)]
    max_lmt_amt: String,
    #[serde(default)]
    lever: String,
    #[serde(default)]
    state: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OkxInstrumentSummary {
    inst_id: String,
    #[serde(default)]
    inst_id_code: String,
    inst_type: String,
    inst_family: String,
    base_ccy: String,
    quote_ccy: String,
    settle_ccy: String,
    ct_val: String,
    ct_val_ccy: String,
    ct_type: String,
    tick_sz: String,
    lot_sz: String,
    min_sz: String,
    max_lmt_sz: String,
    max_mkt_sz: String,
    lever: String,
    state: String,
    icon_path: Option<String>,
    icon_cached: bool,
    updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketAssetsSummary {
    #[serde(default = "default_market_assets_cache_version")]
    cache_version: u32,
    instruments: Vec<OkxInstrumentSummary>,
    total: usize,
    icon_cached: usize,
    icon_failed: usize,
    #[serde(default)]
    icon_failed_bases: Vec<String>,
    #[serde(default)]
    icon_retry_after: Option<i64>,
    cache_dir: String,
    updated_at: i64,
}

fn default_market_assets_cache_version() -> u32 {
    1
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketAssetsCacheRequest {
    instruments: Vec<OkxInstrument>,
    icons: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrivateSnapshotRequest {
    account_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrderStatusRequest {
    account_id: Option<String>,
    inst_id: String,
    ord_id: Option<String>,
    cl_ord_id: Option<String>,
    algo_id: Option<String>,
    algo_cl_ord_id: Option<String>,
    environment: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrderStatusResponse {
    account_id: String,
    environment: String,
    inst_id: String,
    ord_id: Option<String>,
    cl_ord_id: Option<String>,
    algo_id: Option<String>,
    algo_cl_ord_id: Option<String>,
    is_algo: bool,
    state: String,
    side: Option<String>,
    pos_side: Option<String>,
    td_mode: Option<String>,
    ord_type: Option<String>,
    px: Option<String>,
    sz: Option<String>,
    filled_size: Option<String>,
    avg_price: Option<String>,
    pnl: Option<String>,
    fee: Option<String>,
    fill_count: usize,
    fills: Vec<HistoricalFillSummary>,
    source: String,
    updated_at: i64,
    raw: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiMarketReadRequest {
    inst_id: String,
    depth: Option<u16>,
    limit: Option<u16>,
    bar: Option<String>,
    bars: Option<Vec<String>>,
    start_time: Option<i64>,
    end_time: Option<i64>,
    confirmed_only: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiMarketScanRequest {
    inst_ids: Option<Vec<String>>,
    bars: Option<Vec<String>>,
    limit: Option<u16>,
    sort_by: Option<String>,
    top_n: Option<u16>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiIndicatorRequest {
    inst_id: String,
    bar: String,
    limit: Option<u16>,
    start_time: Option<i64>,
    end_time: Option<i64>,
    indicators: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiHistoricalReadRequest {
    account_id: Option<String>,
    inst_id: Option<String>,
    start_time: Option<i64>,
    end_time: Option<i64>,
    limit: Option<u16>,
    state: Option<String>,
    side: Option<String>,
    pos_side: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiUiActionRequest {
    id: Option<String>,
    inst_id: Option<String>,
    bar: Option<String>,
    #[serde(flatten)]
    payload: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiJournalNoteRequest {
    title: Option<String>,
    content: String,
    tags: Option<Vec<String>>,
    metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetMarginModeRequest {
    account_id: Option<String>,
    inst_id: String,
    mgn_mode: String,
    environment: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountUpsertRequest {
    id: Option<String>,
    name: String,
    api_key: Option<String>,
    secret_key: Option<String>,
    passphrase: Option<String>,
    permissions: Option<Permissions>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountDeleteRequest {
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TradePrecheckRequest {
    account_id: Option<String>,
    inst_id: String,
    td_mode: String,
    order_type: String,
    #[serde(default)]
    ticket_mode: String,
    action: Option<String>,
    #[serde(default)]
    price: String,
    #[serde(default)]
    stop_price: Option<String>,
    #[serde(default)]
    atr: Option<String>,
    size: String,
    #[serde(default)]
    lever: String,
    environment: String,
    #[serde(default)]
    max_single_trade_margin_pct: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TradePlanEvaluationRequest {
    account_id: Option<String>,
    inst_id: String,
    #[serde(default)]
    price: Option<String>,
    #[serde(default)]
    stop_price: Option<String>,
    #[serde(default)]
    atr: Option<String>,
    #[serde(default)]
    size: Option<String>,
    #[serde(default)]
    lever: String,
    #[serde(default)]
    order_type: Option<String>,
    #[serde(default)]
    max_single_trade_margin_pct: Option<f64>,
}

#[derive(Clone)]
struct TradePlanAccountContext {
    equity: Option<String>,
    available_usdt: Option<String>,
    source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TradePrecheckResponse {
    ok: bool,
    blocked: bool,
    reasons: Vec<String>,
    warnings: Vec<String>,
    notional: Option<f64>,
    estimated_margin: Option<f64>,
    max_single_trade_margin_pct: Option<f64>,
    max_single_trade_margin: Option<f64>,
    max_single_trade_notional: Option<f64>,
    max_single_trade_size: Option<String>,
    estimated_fee: Option<f64>,
    usdt_equity: Option<f64>,
    stop_price: Option<f64>,
    stop_distance: Option<f64>,
    estimated_stop_loss: Option<f64>,
    estimated_round_trip_fee: Option<f64>,
    estimated_stop_loss_with_fees: Option<f64>,
    stop_loss_pct_of_usdt_equity: Option<f64>,
    perpetual_evaluation: Option<desic_trade_domain::LinearUsdtPerpetualEvaluation>,
    liquidation_text: String,
    available_usdt: Option<f64>,
    long_available: Option<f64>,
    short_available: Option<f64>,
    normalized_price: Option<String>,
    normalized_size: Option<String>,
    instrument: Option<OkxInstrumentSummary>,
    account_config: Option<OkxAccountConfigSummary>,
    fee: Option<OkxTradeFeeSummary>,
    max_order: Option<OkxMaxOrderSummary>,
    leverage_info: Option<Vec<OkxLeverageInfo>>,
    position_tier: Option<OkxPositionTierSummary>,
    timing: Option<TradePrecheckTiming>,
    source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TradePrecheckTiming {
    total_ms: u64,
    instrument_ms: u64,
    account_context_ms: u64,
    limits_ms: u64,
    snapshot_source: String,
    account_config_cache_hit: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaceOrderRequest {
    account_id: Option<String>,
    inst_id: String,
    td_mode: String,
    order_type: String,
    ticket_mode: String,
    action: String,
    price: String,
    size: String,
    lever: String,
    environment: String,
    confirmed_live: Option<bool>,
    operator: Option<String>,
    strategy_id: Option<String>,
    session_id: Option<String>,
    opportunity_id: Option<String>,
    opportunity_revision: Option<i64>,
    agent_run_id: Option<String>,
    execution_key: Option<String>,
    #[serde(default)]
    algo_cl_ord_id: Option<String>,
    execution_leg: Option<String>,
    reason: Option<String>,
    attach_algo_ords: Option<Vec<AttachedAlgoOrder>>,
    #[serde(default)]
    order_spec_v2: Option<OrderSpecV2>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OrderSpecV2 {
    version: u8,
    requested_order_type: String,
    #[serde(default)]
    trigger: Option<TriggerOrderSpecV2>,
    #[serde(default)]
    trailing: Option<TrailingOrderSpecV2>,
    #[serde(default)]
    attached_exits: Option<serde_json::Value>,
    #[serde(default)]
    risk: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TriggerOrderSpecV2 {
    source: String,
    trigger_price: String,
    execution: String,
    #[serde(default)]
    order_price: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TrailingOrderSpecV2 {
    source: String,
    #[serde(default, alias = "activePx")]
    activation_price: Option<String>,
    callback_ratio: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PlaceOrderResponse {
    ord_id: String,
    cl_ord_id: String,
    s_code: String,
    s_msg: String,
    ts: String,
    side: String,
    pos_side: String,
    reduce_only: bool,
    operator: String,
    strategy_id: Option<String>,
    session_id: Option<String>,
    opportunity_id: Option<String>,
    agent_run_id: Option<String>,
    execution_key: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct OkxOrderResult {
    #[serde(default)]
    ord_id: String,
    #[serde(default)]
    cl_ord_id: String,
    #[serde(default)]
    s_code: String,
    #[serde(default)]
    s_msg: String,
    #[serde(default)]
    ts: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct OkxAlgoOrderResult {
    #[serde(default)]
    algo_id: String,
    #[serde(default)]
    algo_cl_ord_id: String,
    #[serde(default)]
    s_code: String,
    #[serde(default)]
    s_msg: String,
    #[serde(default)]
    ts: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaceOrderBody {
    inst_id: String,
    td_mode: String,
    cl_ord_id: String,
    #[serde(rename = "tag")]
    client_marker: String,
    side: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pos_side: Option<String>,
    ord_type: String,
    sz: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    px: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reduce_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attach_algo_ords: Option<Vec<AttachedAlgoOrder>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AttachedAlgoOrder {
    #[serde(skip_serializing_if = "Option::is_none")]
    attach_algo_cl_ord_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tp_trigger_px: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tp_ord_px: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tp_ord_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tp_trigger_px_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sl_trigger_px: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sl_ord_px: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sl_trigger_px_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sz: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaceAlgoOrderBody {
    inst_id: String,
    td_mode: String,
    algo_cl_ord_id: String,
    #[serde(rename = "tag")]
    client_marker: String,
    side: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pos_side: Option<String>,
    ord_type: String,
    sz: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    trigger_px: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trigger_px_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    order_px: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    callback_ratio: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_px: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reduce_only: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelOrderRequest {
    account_id: Option<String>,
    environment: String,
    inst_id: String,
    ord_id: Option<String>,
    cl_ord_id: Option<String>,
    is_algo: Option<bool>,
    algo_id: Option<String>,
    algo_cl_ord_id: Option<String>,
    operator: Option<String>,
    opportunity_id: Option<String>,
    agent_run_id: Option<String>,
    reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CancelOrderBody {
    inst_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    ord_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cl_ord_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CancelAlgoOrderBody {
    inst_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    algo_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    algo_cl_ord_id: Option<String>,
}

#[tauri::command]
async fn okx_sync_time(runtime: tauri::State<'_, MarketRuntime>) -> Result<OkxTimeState, String> {
    let _guard = OKX_CLOCK_SYNC_LOCK.lock().await;
    let state = fetch_okx_time_state().await?;
    store_okx_clock_offset(state.clock_offset_ms);
    if let Ok(mut health) = runtime.health.lock() {
        health.clock_offset_ms = Some(state.clock_offset_ms);
    }
    Ok(state)
}

#[tauri::command]
async fn okx_startup_network_probe(
    runtime: tauri::State<'_, MarketRuntime>,
) -> Result<OkxTimeState, String> {
    const TIMEOUT: Duration = Duration::from_secs(4);
    let started = Instant::now();
    let _guard = timeout(TIMEOUT, OKX_CLOCK_SYNC_LOCK.lock())
        .await
        .map_err(|_| "OKX 网络检测等待时钟同步超时（4 秒）".to_string())?;
    let remaining = TIMEOUT
        .checked_sub(started.elapsed())
        .ok_or_else(|| "OKX 网络检测超时（4 秒）".to_string())?;
    let state = fetch_okx_time_state_once(remaining).await?;
    store_okx_clock_offset(state.clock_offset_ms);
    if let Ok(mut health) = runtime.health.lock() {
        health.clock_offset_ms = Some(state.clock_offset_ms);
    }
    Ok(state)
}

async fn fetch_okx_time_state() -> Result<OkxTimeState, String> {
    let local_send_ms = now_ms();
    let envelope: OkxEnvelope<OkxTime> = get_json("/api/v5/public/time").await?;
    let local_recv_ms = now_ms();
    okx_time_state_from_envelope(envelope, local_send_ms, local_recv_ms)
}

async fn fetch_okx_time_state_once(timeout_duration: Duration) -> Result<OkxTimeState, String> {
    const PATH: &str = "/api/v5/public/time";
    let local_send_ms = now_ms();
    let client = reqwest_client()?;
    let url = format!("{}{}", REST_BASE, PATH);
    let envelope = timeout(
        timeout_duration,
        get_json_once::<OkxTime>(&client, &url, PATH),
    )
    .await
    .map_err(|_| format!("OKX 网络检测超时（{} 秒）", timeout_duration.as_secs()))?
    .map_err(|error| error.message)?;
    let local_recv_ms = now_ms();
    okx_time_state_from_envelope(envelope, local_send_ms, local_recv_ms)
}

fn okx_time_state_from_envelope(
    envelope: OkxEnvelope<OkxTime>,
    local_send_ms: i64,
    local_recv_ms: i64,
) -> Result<OkxTimeState, String> {
    let first = envelope
        .data
        .first()
        .ok_or_else(|| "OKX time response missing data".to_string())?;
    let okx_server_ms = first.ts.parse::<i64>().map_err(|err| err.to_string())?;
    let rtt_ms = local_recv_ms - local_send_ms;
    let okx_now_estimated_ms = okx_server_ms + rtt_ms / 2;

    let clock_offset_ms = okx_now_estimated_ms - local_recv_ms;

    Ok(OkxTimeState {
        okx_server_ms,
        local_send_ms,
        local_recv_ms,
        rtt_ms,
        clock_offset_ms,
        status: "synced".to_string(),
    })
}

fn store_okx_clock_offset(clock_offset_ms: i64) {
    OKX_CLOCK_OFFSET_MS.store(clock_offset_ms, Ordering::Release);
    OKX_CLOCK_SYNC_GENERATION.fetch_add(1, Ordering::AcqRel);
}

async fn resync_okx_clock_if_unchanged(observed_generation: u64) -> Result<(), String> {
    let _guard = OKX_CLOCK_SYNC_LOCK.lock().await;
    if OKX_CLOCK_SYNC_GENERATION.load(Ordering::Acquire) != observed_generation {
        return Ok(());
    }
    let state = fetch_okx_time_state().await?;
    store_okx_clock_offset(state.clock_offset_ms);
    Ok(())
}

fn okx_adjusted_now_ms(local_now_ms: i64) -> i64 {
    local_now_ms.saturating_add(OKX_CLOCK_OFFSET_MS.load(Ordering::Acquire))
}

fn okx_rest_timestamp_at(local_now_ms: i64) -> Result<String, String> {
    Utc.timestamp_millis_opt(okx_adjusted_now_ms(local_now_ms))
        .single()
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or_else(|| "无法生成 OKX REST 请求时间戳".to_string())
}

fn okx_rest_timestamp() -> Result<String, String> {
    okx_rest_timestamp_at(now_ms())
}

fn okx_ws_timestamp_at(local_now_ms: i64) -> String {
    okx_adjusted_now_ms(local_now_ms)
        .div_euclid(1_000)
        .to_string()
}

fn okx_ws_timestamp() -> String {
    okx_ws_timestamp_at(now_ms())
}

#[tauri::command]
async fn okx_ticker(inst_id: String) -> Result<Ticker, String> {
    let path = format!("/api/v5/market/ticker?instId={}", inst_id);
    let envelope: OkxEnvelope<Ticker> = get_json(&path).await?;
    envelope
        .data
        .into_iter()
        .next()
        .ok_or_else(|| "OKX ticker response missing data".to_string())
}

#[tauri::command]
async fn okx_public_ws_probe() -> Result<WsProbeResult, String> {
    okx_ws_probe(
        PUBLIC_WS,
        "OKX Public WebSocket",
        json!({ "channel": "tickers", "instId": "BTC-USDT-SWAP" }),
        "tickers",
        "OKX Public WS 可达",
    )
    .await
}

#[tauri::command]
async fn okx_business_ws_probe() -> Result<WsProbeResult, String> {
    okx_ws_probe(
        BUSINESS_WS,
        "OKX Business WebSocket",
        json!({ "channel": "candle1m", "instId": "BTC-USDT-SWAP" }),
        "candle1m",
        "OKX Business WS 可达",
    )
    .await
}

#[tauri::command]
async fn okx_private_ws_probe(
    app: tauri::AppHandle,
    request: PrivateSnapshotRequest,
) -> Result<WsProbeResult, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    if !account.permissions.read {
        return Err("当前账号未开启读取权限，跳过 private WebSocket 探测".to_string());
    }
    let endpoint = if account.environment.eq_ignore_ascii_case("demo")
        || account.environment.eq_ignore_ascii_case("simulated")
    {
        PRIVATE_WS_DEMO
    } else {
        PRIVATE_WS
    };
    let started = now_ms();
    let mut socket = timeout(Duration::from_secs(10), connect_okx_ws(endpoint))
        .await
        .map_err(|_| "OKX Private WebSocket 连接超时".to_string())?
        .map_err(|err| format!("OKX Private WebSocket 不可达: {}", err))?;
    let login = private_ws_login_payload(&account)?;
    socket
        .send(Message::Text(login.to_string()))
        .await
        .map_err(|err| format!("OKX Private WebSocket 登录请求发送失败: {}", err))?;

    let mut subscribed = false;
    loop {
        let message = timeout(Duration::from_secs(10), socket.next())
            .await
            .map_err(|_| "OKX Private WebSocket 等待响应超时".to_string())?
            .ok_or_else(|| "OKX Private WebSocket 已关闭".to_string())?
            .map_err(|err| format!("OKX Private WebSocket 响应失败: {}", err))?;
        let Message::Text(text) = message else {
            continue;
        };
        if !subscribed && private_login_succeeded(&text)? {
            let subscribe = json!({
                "op": "subscribe",
                "args": [{ "channel": "balance_and_position" }]
            });
            socket
                .send(Message::Text(subscribe.to_string()))
                .await
                .map_err(|err| format!("OKX Private WebSocket 订阅失败: {}", err))?;
            subscribed = true;
            continue;
        }
        let value: serde_json::Value = serde_json::from_str(&text)
            .map_err(|err| format!("OKX Private WebSocket 响应解析失败: {}", err))?;
        if value.get("event").and_then(|event| event.as_str()) == Some("error") {
            return Err(format!(
                "OKX Private WebSocket 订阅被拒绝: {}",
                compact_response_body(&text)
            ));
        }
        let subscribed_event =
            value.get("event").and_then(|event| event.as_str()) == Some("subscribe");
        let balance_data = value
            .get("arg")
            .and_then(|arg| arg.get("channel"))
            .and_then(|channel| channel.as_str())
            == Some("balance_and_position");
        if subscribed_event || balance_data {
            let _ = socket.close(None).await;
            return Ok(WsProbeResult {
                ok: true,
                latency_ms: now_ms() - started,
                message: format!("OKX Private WS 可达：{}", account.name),
            });
        }
    }
}

async fn okx_ws_probe(
    endpoint: &str,
    label: &str,
    arg: serde_json::Value,
    expected_channel: &str,
    success_message: &str,
) -> Result<WsProbeResult, String> {
    let started = now_ms();
    let mut socket = timeout(Duration::from_secs(8), connect_okx_ws(endpoint))
        .await
        .map_err(|_| format!("{} 连接超时", label))?
        .map_err(|err| format!("{} 不可达: {}", label, err))?;
    let subscribe = json!({
        "op": "subscribe",
        "args": [arg]
    });
    socket
        .send(Message::Text(subscribe.to_string()))
        .await
        .map_err(|err| format!("{} 订阅失败: {}", label, err))?;

    loop {
        let message = timeout(Duration::from_secs(8), socket.next())
            .await
            .map_err(|_| format!("{} 等待响应超时", label))?
            .ok_or_else(|| format!("{} 已关闭", label))?
            .map_err(|err| format!("{} 响应失败: {}", label, err))?;
        let Message::Text(text) = message else {
            continue;
        };
        let value: serde_json::Value = serde_json::from_str(&text)
            .map_err(|err| format!("{} 响应解析失败: {}", label, err))?;
        if value.get("event").and_then(|item| item.as_str()) == Some("error") {
            return Err(format!(
                "{} 订阅被拒绝: {}",
                label,
                compact_response_body(&text)
            ));
        }
        let subscribed = value.get("event").and_then(|item| item.as_str()) == Some("subscribe");
        let channel_data = value
            .get("arg")
            .and_then(|arg| arg.get("channel"))
            .and_then(|item| item.as_str())
            == Some(expected_channel);
        if subscribed || channel_data {
            let _ = socket.close(None).await;
            return Ok(WsProbeResult {
                ok: true,
                latency_ms: now_ms() - started,
                message: success_message.to_string(),
            });
        }
    }
}

#[tauri::command]
async fn okx_sync_market_assets(app: tauri::AppHandle) -> Result<MarketAssetsSummary, String> {
    let updated_at = now_ms();
    let envelope: OkxEnvelope<OkxInstrument> =
        get_json("/api/v5/public/instruments?instType=SWAP").await?;
    let cache_dir = market_assets_cache_dir(&app)?;
    let icon_dir = cache_dir.join("icons");
    fs::create_dir_all(&icon_dir).map_err(|err| err.to_string())?;

    let client = reqwest_client()?;
    // Keep a missing cache from turning startup into a large burst of CDN requests.
    let semaphore = Arc::new(Semaphore::new(MARKET_ICON_DOWNLOAD_CONCURRENCY));
    let mut tasks = Vec::new();
    let mut instruments = Vec::new();

    for instrument in envelope
        .data
        .into_iter()
        .filter(|item| item.inst_type.eq_ignore_ascii_case("SWAP"))
    {
        let base = instrument_base_ccy(&instrument);
        let icon_path = if base.is_empty() {
            None
        } else {
            Some(icon_dir.join(format!("{}.png", base.to_ascii_lowercase())))
        };
        let icon_path_string = icon_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string());
        let icon_cached = icon_path.as_ref().is_some_and(|path| path.exists());
        if let Some(path) = icon_path.clone() {
            if !icon_cached {
                let permit = semaphore.clone();
                let client = client.clone();
                let base_for_task = base.to_ascii_lowercase();
                tasks.push(tauri::async_runtime::spawn(async move {
                    let _permit = permit
                        .acquire_owned()
                        .await
                        .map_err(|err| err.to_string())?;
                    download_market_icon_with_retry(&client, &base_for_task, &path)
                        .await
                        .map(|_| base_for_task.clone())
                        .map_err(|err| format!("{}: {}", base_for_task, err))
                }));
            }
        }
        instruments.push(instrument_summary_from(
            instrument,
            icon_path_string,
            icon_cached,
            updated_at,
        ));
    }

    let mut failed_bases = Vec::new();
    for task in tasks {
        match task.await {
            Ok(Ok(_base)) => {}
            Ok(Err(err)) => {
                failed_bases.push(err.split(':').next().unwrap_or("unknown").to_string())
            }
            Err(err) => failed_bases.push(format!("task-join: {}", err)),
        }
    }

    let mut refreshed = Vec::with_capacity(instruments.len());
    for mut instrument in instruments {
        if let Some(path) = instrument.icon_path.as_ref() {
            instrument.icon_cached = PathBuf::from(path).exists();
        }
        refreshed.push(instrument);
    }
    let icon_cached = refreshed.iter().filter(|item| item.icon_cached).count();
    failed_bases.sort();
    failed_bases.dedup();
    let icon_failed = failed_bases.len();
    let summary = MarketAssetsSummary {
        cache_version: MARKET_ASSETS_CACHE_VERSION,
        total: refreshed.len(),
        icon_cached,
        icon_failed,
        icon_failed_bases: failed_bases,
        icon_retry_after: if icon_failed > 0 {
            Some(updated_at + 5 * 60_000)
        } else {
            None
        },
        cache_dir: cache_dir.to_string_lossy().to_string(),
        updated_at,
        instruments: refreshed,
    };
    let index_path = cache_dir.join("swap-instruments.json");
    if let Ok(bytes) = serde_json::to_vec_pretty(&summary) {
        let _ = fs::write(index_path, bytes);
    }
    Ok(summary)
}

#[tauri::command]
fn load_market_assets_cache(app: tauri::AppHandle) -> Result<Option<MarketAssetsSummary>, String> {
    let index_path = market_assets_cache_dir(&app)?.join("swap-instruments.json");
    if !index_path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&index_path).map_err(|err| err.to_string())?;
    let mut summary: MarketAssetsSummary =
        serde_json::from_str(&content).map_err(|err| err.to_string())?;
    if summary.cache_version < MARKET_ASSETS_CACHE_VERSION {
        summary.cache_version = MARKET_ASSETS_CACHE_VERSION;
    }
    for instrument in summary.instruments.iter_mut() {
        if let Some(path) = instrument.icon_path.as_ref() {
            instrument.icon_cached = PathBuf::from(path).exists();
        }
    }
    summary.icon_cached = summary
        .instruments
        .iter()
        .filter(|item| item.icon_cached)
        .count();
    summary.icon_failed = summary.icon_failed_bases.len();
    Ok(Some(summary))
}

#[tauri::command]
async fn save_market_assets_cache(
    app: tauri::AppHandle,
    request: MarketAssetsCacheRequest,
) -> Result<MarketAssetsSummary, String> {
    let updated_at = now_ms();
    let cache_dir = market_assets_cache_dir(&app)?;
    let icon_dir = cache_dir.join("icons");
    fs::create_dir_all(&icon_dir).map_err(|err| err.to_string())?;

    let mut icon_failed = 0usize;
    for (base, data) in request.icons {
        let normalized = base.trim().to_ascii_lowercase();
        if normalized.is_empty() {
            continue;
        }
        let decoded = general_purpose::STANDARD
            .decode(data)
            .map_err(|err| format!("icon {} base64 decode failed: {}", normalized, err))?;
        let path = icon_dir.join(format!("{}.png", normalized));
        if let Err(_err) = fs::write(path, decoded) {
            icon_failed += 1;
        }
    }

    let mut instruments = Vec::new();
    for instrument in request
        .instruments
        .into_iter()
        .filter(|item| item.inst_type.eq_ignore_ascii_case("SWAP"))
    {
        let base = instrument_base_ccy(&instrument);
        let icon_path = if base.is_empty() {
            None
        } else {
            Some(
                icon_dir
                    .join(format!("{}.png", base))
                    .to_string_lossy()
                    .to_string(),
            )
        };
        let icon_cached = icon_path
            .as_ref()
            .is_some_and(|path| PathBuf::from(path).exists());
        instruments.push(instrument_summary_from(
            instrument,
            icon_path,
            icon_cached,
            updated_at,
        ));
    }

    let icon_cached = instruments.iter().filter(|item| item.icon_cached).count();
    let summary = MarketAssetsSummary {
        cache_version: MARKET_ASSETS_CACHE_VERSION,
        total: instruments.len(),
        icon_cached,
        icon_failed,
        icon_failed_bases: Vec::new(),
        icon_retry_after: if icon_failed > 0 {
            Some(updated_at + 5 * 60_000)
        } else {
            None
        },
        cache_dir: cache_dir.to_string_lossy().to_string(),
        updated_at,
        instruments,
    };
    let index_path = cache_dir.join("swap-instruments.json");
    if let Ok(bytes) = serde_json::to_vec_pretty(&summary) {
        fs::write(index_path, bytes).map_err(|err| err.to_string())?;
    }
    Ok(summary)
}

#[tauri::command]
async fn ensure_instruments_cache(
    app: tauri::AppHandle,
    inst_ids: Vec<String>,
) -> Result<MarketAssetsSummary, String> {
    ensure_instruments_cached(&app, inst_ids).await?;
    load_market_assets_cache(app)?.ok_or_else(|| "交易对资源缓存不可用".to_string())
}

#[tauri::command]
async fn okx_candles(inst_id: String, bar: String, limit: u16) -> Result<Vec<Candle>, String> {
    let path = okx_recent_candles_path(&inst_id, &bar, limit)?;
    let envelope: OkxEnvelope<Vec<String>> = get_json(&path).await?;
    let mut candles = envelope
        .data
        .into_iter()
        .filter_map(|row| normalize_candle(&row))
        .collect::<Vec<_>>();
    candles.reverse();
    Ok(candles)
}

#[tauri::command]
async fn okx_funding_rate(
    runtime: tauri::State<'_, MarketRuntime>,
    inst_id: String,
) -> Result<Option<FundingRate>, String> {
    if let Some(cached) = runtime
        .store
        .lock()
        .ok()
        .and_then(|store| store.funding_rates.get(&inst_id).cloned())
    {
        return Ok(Some(cached));
    }
    let path = format!("/api/v5/public/funding-rate?instId={}", url_encode(&inst_id));
    let envelope: OkxEnvelope<FundingRate> = get_json(&path).await?;
    let funding = envelope.data.into_iter().next();
    if let Some(value) = funding.as_ref() {
        if let Ok(mut store) = runtime.store.lock() {
            store.funding_rates.insert(inst_id, value.clone());
        }
    }
    Ok(funding)
}

fn okx_recent_candles_path(inst_id: &str, bar: &str, limit: u16) -> Result<String, String> {
    if bar_ms(bar).is_none() {
        return Err(format!("unsupported interval: {bar}"));
    }
    Ok(format!(
        "/api/v5/market/candles?instId={}&bar={}&limit={}",
        url_encode(inst_id),
        url_encode(bar),
        limit.clamp(1, 300)
    ))
}

#[tauri::command]
fn init_local_storage(app: tauri::AppHandle) -> Result<String, String> {
    let path = database_path(&app)?;
    open_database(&app)?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn market_icon_data_url(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let requested_raw = PathBuf::from(path.trim());
    let requested = if requested_raw.is_absolute() {
        requested_raw
    } else {
        runtime_work_dir().join(requested_raw)
    };
    if !requested.exists() {
        return Ok(String::new());
    }
    let mut allowed_dirs = Vec::new();
    if cfg!(debug_assertions) {
        let project_icons_dir = project_root_path()
            .join("cache")
            .join("market-assets")
            .join("icons");
        if let Ok(path) = project_icons_dir.canonicalize() {
            allowed_dirs.push(path);
        }
    }
    let app_icons_dir = market_assets_cache_dir(&app)?.join("icons");
    if let Ok(path) = app_icons_dir.canonicalize() {
        allowed_dirs.push(path);
    }
    if allowed_dirs.is_empty() {
        return Err("图标缓存目录不可用".to_string());
    }
    let icon_path = requested
        .canonicalize()
        .map_err(|err| format!("图标文件不可用: {}", err))?;
    if !allowed_dirs.iter().any(|dir| icon_path.starts_with(dir)) {
        return Err("图标路径不在本地缓存目录内".to_string());
    }
    if icon_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        != "png"
    {
        return Err("仅支持 PNG 图标缓存".to_string());
    }
    let bytes = fs::read(&icon_path).map_err(|err| format!("读取图标失败: {}", err))?;
    Ok(format!(
        "data:image/png;base64,{}",
        general_purpose::STANDARD.encode(bytes)
    ))
}

#[tauri::command]
async fn ensure_market_icon_data_url(
    app: tauri::AppHandle,
    base: String,
) -> Result<String, String> {
    let normalized = normalize_market_icon_base(&base)?;
    let icon_path = market_assets_cache_dir(&app)?
        .join("icons")
        .join(format!("{}.png", normalized));
    if !icon_path.exists() {
        let client = reqwest_client()?;
        download_market_icon_with_retry(&client, &normalized, &icon_path).await?;
    }
    mark_market_icon_cached(&app, &normalized, &icon_path)?;
    market_icon_data_url(app, icon_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn local_candles(
    app: tauri::AppHandle,
    inst_id: String,
    bar: String,
    limit: u16,
) -> Result<Vec<Candle>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_read_database(&app)?;
        aggregate_candles_from_1m(&conn, &inst_id, &bar, None, None, limit.min(1000), false)
    })
    .await
    .map_err(|error| format!("读取本地 K 线任务失败：{error}"))?
}

#[tauri::command]
async fn historical_candles_before(
    app: tauri::AppHandle,
    inst_id: String,
    bar: String,
    before_time: i64,
    limit: u16,
) -> Result<HistoricalCandlesPage, String> {
    let step = bar_ms(&bar).ok_or_else(|| format!("unsupported interval: {}", bar))?;
    let bounded_limit = limit.clamp(1, 300);
    let before_open_ms = align_open_time(before_time.saturating_mul(1000), &bar, step);
    let end_open = before_open_ms.saturating_sub(step);
    let start_open =
        end_open.saturating_sub(step.saturating_mul((bounded_limit as i64).saturating_sub(1)));

    let local = read_historical_local_page(
        app.clone(),
        inst_id.clone(),
        bar.clone(),
        start_open,
        end_open,
        bounded_limit,
    )
    .await?;
    if candles_cover_window(&local.candles, start_open, end_open, step) {
        return Ok(historical_page(local.candles, false, "local"));
    }
    if local
        .exhausted_before_open
        .is_some_and(|oldest_open| end_open < oldest_open)
    {
        return Ok(historical_page(local.candles, true, "local"));
    }

    let fetched = fetch_history_candles_page(&inst_id, &bar, start_open, end_open).await?;
    let fetched_count = fetched.candles.len();
    let fetched_exhausted = fetched.exhausted;
    let fetched_oldest = fetched
        .candles
        .iter()
        .map(|candle| candle.open_time_ms)
        .min();
    if !fetched.candles.is_empty() || fetched_exhausted {
        write_historical_page(
            app.clone(),
            inst_id.clone(),
            bar.clone(),
            fetched.candles,
            fetched_exhausted.then_some(fetched_oldest.unwrap_or(end_open.saturating_add(step))),
        )
        .await?;
    }

    let refreshed =
        read_historical_local_page(app, inst_id, bar, start_open, end_open, bounded_limit).await?;
    let source = if local.candles.is_empty() {
        if fetched_count == 0 {
            "local"
        } else {
            "history"
        }
    } else if fetched_count == 0 {
        "local"
    } else {
        "mixed"
    };
    Ok(historical_page(
        refreshed.candles,
        fetched_exhausted
            || refreshed
                .exhausted_before_open
                .is_some_and(|oldest_open| end_open < oldest_open),
        source,
    ))
}

#[tauri::command]
async fn sync_kline_integrity(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, KlineSyncRuntime>,
    request: KlineSyncRequest,
) -> Result<KlineSyncSummary, String> {
    let symbols = normalize_symbols(request.symbols);
    let intervals = normalize_intervals(request.intervals);
    let recent_hours = request
        .recent_hours
        .filter(|hours| *hours > 0)
        .map(|hours| hours.min(24 * 30));
    let required_days = normalize_required_days(request.required_days);
    let reserved = runtime.reserve(&symbols, &intervals).await;
    if reserved.is_empty() {
        return Ok(KlineSyncSummary {
            reports: Vec::new(),
        });
    }
    if request.blocking.unwrap_or(false) {
        let reports = sync_kline_set(
            app,
            symbols,
            intervals,
            recent_hours,
            required_days,
            &reserved,
        )
        .await;
        runtime.release(&reserved).await;
        return Ok(KlineSyncSummary { reports });
    }

    let app_handle = app.clone();
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn(async move {
        let _ = sync_kline_set(
            app_handle,
            symbols,
            intervals,
            recent_hours,
            required_days,
            &reserved,
        )
        .await;
        runtime.release(&reserved).await;
    });
    Ok(KlineSyncSummary {
        reports: Vec::new(),
    })
}

#[tauri::command]
fn load_local_accounts(app: tauri::AppHandle) -> Result<Vec<AccountSummary>, String> {
    Ok(load_accounts_config(&app)?
        .accounts
        .into_iter()
        .map(account_summary_from)
        .collect())
}

fn unresolved_account_execution_counts_with_conn(
    conn: &Connection,
    account_id: &str,
) -> Result<(i64, i64, i64), String> {
    let pending_trade_executions = conn
        .query_row(
            "SELECT COUNT(*) FROM trade_execution_attempts
             WHERE account_id=?1
               AND operation IN ('place_order','amend_order','place_algo_order','amend_algo_order')
               AND (
                 status IN ('submitting','reconciling','unknown','blocked')
                 OR (status='accepted' AND projection_status IN ('pending','blocked'))
               )",
            params![account_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    let pending_instrument_operations = conn
        .query_row(
            "SELECT COUNT(*) FROM instrument_operations
             WHERE account_id=?1
               AND phase IN ('submitting','reconciling','unknown')",
            params![account_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    let active_account_mutations = conn
        .query_row(
            "SELECT COUNT(*) FROM account_mutation_leases
             WHERE account_id=?1 AND lease_expires_at>?2",
            params![account_id, now_ms()],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;

    Ok((
        pending_trade_executions,
        pending_instrument_operations,
        active_account_mutations,
    ))
}

fn ensure_no_active_account_mutation_with_conn(
    conn: &Connection,
    account_id: &str,
) -> Result<(), String> {
    let active = conn
        .query_row(
            "SELECT COUNT(*) FROM account_mutation_leases
             WHERE account_id=?1 AND lease_expires_at>?2",
            params![account_id, now_ms()],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    if active == 0 {
        Ok(())
    } else {
        Err(format!(
            "账号 {account_id} 仍有 {active} 项外部写操作正在执行，禁止修改或删除账号配置"
        ))
    }
}

fn ensure_account_environment_change_allowed_with_conn(
    conn: &Connection,
    account_id: &str,
    current_environment: &str,
    detected_environment: &str,
) -> Result<(), String> {
    let current_environment = normalize_environment(current_environment);
    let detected_environment = normalize_environment(detected_environment);
    if current_environment == detected_environment {
        return Ok(());
    }

    let (pending_trade_executions, pending_instrument_operations, active_account_mutations) =
        unresolved_account_execution_counts_with_conn(conn, account_id)?;

    if pending_trade_executions == 0
        && pending_instrument_operations == 0
        && active_account_mutations == 0
    {
        return Ok(());
    }
    Err(format!(
        "账号 {account_id} 仍有未决执行（交易执行 {pending_trade_executions} 条，当前合约紧急操作 {pending_instrument_operations} 条，账号写操作 {active_account_mutations} 条），禁止将环境从 {current_environment} 自动切换为 {detected_environment}。请先完成对账或等待外部写操作结束后重试。"
    ))
}

fn ensure_account_deletion_allowed_with_conn(
    conn: &Connection,
    account_id: &str,
) -> Result<(), String> {
    let (pending_trade_executions, pending_instrument_operations, active_account_mutations) =
        unresolved_account_execution_counts_with_conn(conn, account_id)?;
    if pending_trade_executions == 0
        && pending_instrument_operations == 0
        && active_account_mutations == 0
    {
        return Ok(());
    }
    Err(format!(
        "账号 {account_id} 仍有未决执行（交易执行 {pending_trade_executions} 条，当前合约紧急操作 {pending_instrument_operations} 条，账号写操作 {active_account_mutations} 条），禁止删除账号。请先完成对账或等待外部写操作结束。"
    ))
}

fn ensure_account_identity_change_allowed_with_conn(
    conn: &Connection,
    current: &LocalAccount,
    updated: &LocalAccount,
) -> Result<(), String> {
    if account_config_cache_fingerprint(current) == account_config_cache_fingerprint(updated)
        && current.okx_uid == updated.okx_uid
        && current.okx_main_uid == updated.okx_main_uid
    {
        return Ok(());
    }
    let (pending_trade_executions, pending_instrument_operations, active_account_mutations) =
        unresolved_account_execution_counts_with_conn(conn, &current.id)?;
    if pending_trade_executions == 0
        && pending_instrument_operations == 0
        && active_account_mutations == 0
    {
        return Ok(());
    }
    Err(format!(
        "账号 {} 仍有未决执行（交易执行 {pending_trade_executions} 条，当前合约紧急操作 {pending_instrument_operations} 条，账号写操作 {active_account_mutations} 条），禁止修改环境、凭据或交易权限（包括远端身份绑定）。请先完成对账或等待外部写操作结束。",
        current.id
    ))
}

pub(crate) fn begin_account_mutation_lease(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    operation: &str,
) -> Result<AccountMutationLease, String> {
    let mut conn = open_database(app)?;
    let now = now_ms();
    let sequence = ACCOUNT_MUTATION_LEASE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let lease_id = format!("account-write-{}-{}-{}", std::process::id(), now, sequence);
    let credential_fingerprint = account_config_cache_fingerprint(account);
    let transaction = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    ensure_account_snapshot_current(app, account)?;
    transaction
        .execute(
            "DELETE FROM account_mutation_leases WHERE lease_expires_at<=?1",
            [now],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO account_mutation_leases (
               lease_id,account_id,environment,credential_fingerprint,operation,
               lease_expires_at,created_at,updated_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?7)",
            params![
                lease_id,
                account.id,
                normalize_environment(&account.environment),
                credential_fingerprint,
                operation,
                now.saturating_add(ACCOUNT_MUTATION_LEASE_MS),
                now,
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(AccountMutationLease {
        lease_id,
        account_id: account.id.clone(),
        credential_fingerprint,
    })
}

fn renew_account_mutation_lease_with_conn(
    conn: &Connection,
    lease: &AccountMutationLease,
    now: i64,
) -> Result<bool, String> {
    conn.execute(
        "UPDATE account_mutation_leases
         SET lease_expires_at=?4,updated_at=?3
         WHERE lease_id=?1 AND account_id=?2 AND credential_fingerprint=?5
           AND lease_expires_at>?3",
        params![
            lease.lease_id,
            lease.account_id,
            now,
            now.saturating_add(ACCOUNT_MUTATION_LEASE_MS),
            lease.credential_fingerprint,
        ],
    )
    .map(|changed| changed == 1)
    .map_err(|error| error.to_string())
}

pub(crate) fn renew_account_mutation_lease(
    app: &tauri::AppHandle,
    lease: &AccountMutationLease,
) -> Result<(), String> {
    let conn = open_database(app)?;
    if renew_account_mutation_lease_with_conn(&conn, lease, now_ms())? {
        Ok(())
    } else {
        Err("账号外部写操作租约已过期或丢失，已阻止继续发送请求".to_string())
    }
}

fn finish_account_mutation_lease_with_conn(
    conn: &Connection,
    lease: &AccountMutationLease,
) -> Result<bool, String> {
    conn.execute(
        "DELETE FROM account_mutation_leases
         WHERE lease_id=?1 AND account_id=?2 AND credential_fingerprint=?3",
        params![
            lease.lease_id,
            lease.account_id,
            lease.credential_fingerprint
        ],
    )
    .map(|changed| changed == 1)
    .map_err(|error| error.to_string())
}

pub(crate) fn finish_account_mutation_lease(app: &tauri::AppHandle, lease: &AccountMutationLease) {
    let result = open_database(app)
        .and_then(|conn| finish_account_mutation_lease_with_conn(&conn, lease).map(|_| ()));
    if let Err(error) = result {
        eprintln!(
            "[warn] account mutation lease cleanup failed account={} error={}",
            lease.account_id, error
        );
    }
}

fn ensure_unique_okx_api_key(
    config: &AccountsConfig,
    account: &LocalAccount,
) -> Result<(), String> {
    if let Some(existing) = config.accounts.iter().find(|item| {
        item.id != account.id
            && item.exchange.eq_ignore_ascii_case("okx")
            && !item.api_key.trim().is_empty()
            && item.api_key.trim() == account.api_key.trim()
    }) {
        return Err(format!(
            "该 OKX API Key 已由账号「{}」使用，不能创建重复账号或更换 accountId",
            existing.name
        ));
    }
    Ok(())
}

fn stored_okx_account_identity(account: &LocalAccount) -> Option<DetectedOkxAccountIdentity> {
    let uid = account.okx_uid.trim();
    if uid.is_empty() {
        return None;
    }
    Some(DetectedOkxAccountIdentity {
        environment: normalize_environment(&account.environment),
        uid: uid.to_string(),
        main_uid: account.okx_main_uid.trim().to_string(),
    })
}

fn same_okx_remote_account(
    left: &DetectedOkxAccountIdentity,
    right: &DetectedOkxAccountIdentity,
) -> bool {
    !left.uid.is_empty()
        && left.uid == right.uid
        && normalize_environment(&left.environment) == normalize_environment(&right.environment)
}

fn ensure_local_okx_account_identity_unambiguous(
    config: &AccountsConfig,
    account: &LocalAccount,
) -> Result<(), String> {
    let other_accounts = config
        .accounts
        .iter()
        .filter(|item| {
            item.id != account.id
                && item.exchange.eq_ignore_ascii_case("okx")
                && !item.api_key.trim().is_empty()
        })
        .collect::<Vec<_>>();
    if other_accounts.is_empty() {
        return Ok(());
    }
    let selected = stored_okx_account_identity(account).ok_or_else(|| {
        "当前为旧版多账号配置，尚未记录 OKX uid；请先逐个执行连接测试，已阻止创建新的交易执行"
            .to_string()
    })?;
    for existing in other_accounts {
        let identity = stored_okx_account_identity(existing).ok_or_else(|| {
            format!(
                "账号「{}」尚未记录 OKX uid；请先执行连接测试，已阻止创建新的交易执行",
                existing.name
            )
        })?;
        if same_okx_remote_account(&selected, &identity) {
            return Err(format!(
                "当前账号与「{}」绑定同一 OKX 远端账户，已阻止跨 accountId 创建交易执行",
                existing.name
            ));
        }
    }
    Ok(())
}

async fn ensure_unique_okx_remote_account(
    config: &AccountsConfig,
    account: &LocalAccount,
) -> Result<(), String> {
    let target = stored_okx_account_identity(account)
        .ok_or_else(|| "OKX 账号身份缺少 uid，已阻止保存".to_string())?;
    for existing in config.accounts.iter().filter(|item| {
        item.id != account.id
            && item.exchange.eq_ignore_ascii_case("okx")
            && !item.api_key.trim().is_empty()
    }) {
        let existing_identity = match stored_okx_account_identity(existing) {
            Some(identity) => identity,
            None => detect_okx_account_environment(existing)
                .await
                .map_err(|error| {
                    format!(
                        "无法确认已有账号「{}」的 OKX 远端身份，已阻止保存新账号：{error}",
                        existing.name
                    )
                })?,
        };
        if same_okx_remote_account(&target, &existing_identity) {
            return Err(format!(
                "该 OKX 远端账户已由账号「{}」使用，不能用第二把 API Key 创建新的 accountId",
                existing.name
            ));
        }
    }
    Ok(())
}

fn accounts_config_snapshot(config: &AccountsConfig) -> Result<String, String> {
    serde_json::to_string(config).map_err(|error| error.to_string())
}

#[tauri::command]
async fn save_local_account(
    app: tauri::AppHandle,
    request: AccountUpsertRequest,
) -> Result<Vec<AccountSummary>, String> {
    let _account_config_guard = ACCOUNT_CONFIG_MUTATION_LOCK.lock().await;
    let mut config = load_accounts_config(&app)?;
    let initial_config_snapshot = accounts_config_snapshot(&config)?;
    let requested_id = request.id.clone().filter(|value| !value.trim().is_empty());
    let existing = config
        .accounts
        .iter()
        .find(|account| Some(account.id.as_str()) == requested_id.as_deref())
        .cloned();
    let requested_api_key = request
        .api_key
        .filter(|value| !value.trim().is_empty() && !value.contains("****"));
    let requested_secret_key = request
        .secret_key
        .filter(|value| !value.trim().is_empty() && !value.contains("****"));
    let requested_passphrase = request
        .passphrase
        .filter(|value| !value.trim().is_empty() && !value.contains("****"));
    let credentials_changed = existing.is_none()
        || requested_api_key.is_some()
        || requested_secret_key.is_some()
        || requested_passphrase.is_some();
    let generated_at = now_ms();
    let mut account = LocalAccount {
        id: requested_id
            .clone()
            .unwrap_or_else(|| format!("okx-pending-{generated_at}")),
        name: if request.name.trim().is_empty() {
            existing
                .as_ref()
                .map(|account| account.name.clone())
                .unwrap_or_else(|| "OKX 账号".to_string())
        } else {
            request.name.trim().to_string()
        },
        exchange: "okx".to_string(),
        environment: existing
            .as_ref()
            .map(|account| normalize_environment(&account.environment))
            .unwrap_or_else(|| "live".to_string()),
        okx_uid: existing
            .as_ref()
            .map(|account| account.okx_uid.clone())
            .unwrap_or_default(),
        okx_main_uid: existing
            .as_ref()
            .map(|account| account.okx_main_uid.clone())
            .unwrap_or_default(),
        api_key: requested_api_key
            .or_else(|| existing.as_ref().map(|account| account.api_key.clone()))
            .unwrap_or_default(),
        secret_key: requested_secret_key
            .or_else(|| existing.as_ref().map(|account| account.secret_key.clone()))
            .unwrap_or_default(),
        passphrase: requested_passphrase
            .or_else(|| existing.as_ref().map(|account| account.passphrase.clone()))
            .unwrap_or_default(),
        permissions: request.permissions.unwrap_or_else(|| {
            existing
                .as_ref()
                .map(|account| account.permissions.clone())
                .unwrap_or(Permissions {
                    read: true,
                    trade: false,
                    withdraw: false,
                })
        }),
    };
    validate_account(&account)?;
    if credentials_changed || account.okx_uid.trim().is_empty() {
        let detected = detect_okx_account_environment(&account).await?;
        account.environment = detected.environment;
        account.okx_uid = detected.uid;
        account.okx_main_uid = detected.main_uid;
    }
    if requested_id.is_none() {
        account.id = format!("okx-{}-{generated_at}", account.environment);
    }
    let id = account.id.clone();
    if let Some(index) = config.accounts.iter().position(|item| item.id == id) {
        config.accounts[index] = account;
    } else {
        config.accounts.push(account);
    }
    let saved_account = config
        .accounts
        .iter()
        .find(|item| item.id == id)
        .ok_or_else(|| "账号保存前无法读取目标记录".to_string())?;
    ensure_unique_okx_api_key(&config, saved_account)?;
    ensure_unique_okx_remote_account(&config, saved_account).await?;

    let _trade_mutation_guard = TRADE_MUTATION_LOCK.lock().await;
    let mut conn = open_database(&app)?;
    let transaction = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let latest_config = load_accounts_config(&app)?;
    if accounts_config_snapshot(&latest_config)? != initial_config_snapshot {
        return Err("账号配置已由另一个进程修改，请重新加载后再保存".to_string());
    }
    if let Some(existing) = existing.as_ref() {
        ensure_account_environment_change_allowed_with_conn(
            &transaction,
            &existing.id,
            &existing.environment,
            &saved_account.environment,
        )?;
        ensure_account_identity_change_allowed_with_conn(&transaction, existing, saved_account)?;
    }
    save_accounts_config(&app, &config)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(config
        .accounts
        .into_iter()
        .map(account_summary_from)
        .collect())
}

#[tauri::command]
async fn delete_local_account(
    app: tauri::AppHandle,
    request: AccountDeleteRequest,
) -> Result<Vec<AccountSummary>, String> {
    let _account_config_guard = ACCOUNT_CONFIG_MUTATION_LOCK.lock().await;
    let _trade_mutation_guard = TRADE_MUTATION_LOCK.lock().await;
    let mut conn = open_database(&app)?;
    let transaction = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let mut config = load_accounts_config(&app)?;
    if config
        .accounts
        .iter()
        .any(|account| account.id == request.id)
    {
        ensure_account_deletion_allowed_with_conn(&transaction, &request.id)?;
    }
    config.accounts.retain(|account| account.id != request.id);
    save_accounts_config(&app, &config)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(config
        .accounts
        .into_iter()
        .map(account_summary_from)
        .collect())
}

#[tauri::command]
async fn test_local_account(
    app: tauri::AppHandle,
    request: AccountDeleteRequest,
) -> Result<PrivateAccountSnapshot, String> {
    let _account_config_guard = ACCOUNT_CONFIG_MUTATION_LOCK.lock().await;
    let initial_config = load_accounts_config(&app)?;
    let initial_config_snapshot = accounts_config_snapshot(&initial_config)?;
    let mut account = load_local_account_secret(&app, Some(&request.id))?;
    let detected = detect_okx_account_environment(&account).await?;
    account.environment = detected.environment.clone();
    account.okx_uid = detected.uid.clone();
    account.okx_main_uid = detected.main_uid.clone();
    ensure_unique_okx_remote_account(&initial_config, &account).await?;
    {
        let _trade_mutation_guard = TRADE_MUTATION_LOCK.lock().await;
        let mut conn = open_database(&app)?;
        let transaction = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let mut config = load_accounts_config(&app)?;
        if accounts_config_snapshot(&config)? != initial_config_snapshot {
            return Err("账号配置已由另一个进程修改，请重新测试连接".to_string());
        }
        let stored = config
            .accounts
            .iter_mut()
            .find(|item| item.id == account.id)
            .ok_or_else(|| "account not found".to_string())?;
        let environment_changed =
            normalize_environment(&stored.environment) != detected.environment;
        if environment_changed {
            ensure_account_environment_change_allowed_with_conn(
                &transaction,
                &account.id,
                &stored.environment,
                &detected.environment,
            )?;
        }
        let identity_changed =
            stored.okx_uid != detected.uid || stored.okx_main_uid != detected.main_uid;
        if identity_changed {
            ensure_no_active_account_mutation_with_conn(&transaction, &account.id)?;
        }
        if environment_changed || identity_changed {
            stored.environment = detected.environment.clone();
            stored.okx_uid = detected.uid.clone();
            stored.okx_main_uid = detected.main_uid.clone();
            save_accounts_config(&app, &config)?;
        }
        transaction.commit().map_err(|error| error.to_string())?;
    }
    let current_account = load_local_account_secret(&app, Some(&request.id))?;
    if account_config_cache_fingerprint(&current_account)
        != account_config_cache_fingerprint(&account)
    {
        return Err("账号配置在连接测试期间发生变化，请重试".to_string());
    }
    ensure_okx_long_short_mode(&app, &account).await?;
    fetch_private_account_snapshot(&account).await
}

fn detected_okx_account_identity(
    environment: &str,
    envelope: OkxEnvelope<OkxAccountConfig>,
) -> Result<DetectedOkxAccountIdentity, String> {
    let config = envelope
        .data
        .into_iter()
        .next()
        .ok_or_else(|| "OKX /account/config 响应为空，无法建立稳定账号身份".to_string())?;
    let uid = config.uid.trim();
    if uid.is_empty() {
        return Err("OKX /account/config 响应缺少 uid，无法建立稳定账号身份".to_string());
    }
    Ok(DetectedOkxAccountIdentity {
        environment: normalize_environment(environment),
        uid: uid.to_string(),
        main_uid: config.main_uid.trim().to_string(),
    })
}

async fn detect_okx_account_environment(
    account: &LocalAccount,
) -> Result<DetectedOkxAccountIdentity, String> {
    let mut live_account = account.clone();
    live_account.environment = "live".to_string();
    let live_error =
        match okx_private_get::<OkxAccountConfig>(&live_account, "/api/v5/account/config").await {
            Ok(config) => return detected_okx_account_identity("live", config),
            Err(error) => error,
        };

    let mut demo_account = account.clone();
    demo_account.environment = "demo".to_string();
    okx_private_get::<OkxAccountConfig>(&demo_account, "/api/v5/account/config")
        .await
        .and_then(|config| detected_okx_account_identity("demo", config))
        .map_err(|demo_error| {
            format!(
                "无法识别 API Key 的实盘/模拟盘环境。实盘检测：{}；模拟盘检测：{}",
                compact_response_body(&live_error),
                compact_response_body(&demo_error)
            )
        })
}

#[tauri::command]
async fn okx_private_snapshot(
    app: tauri::AppHandle,
    request: PrivateSnapshotRequest,
) -> Result<PrivateAccountSnapshot, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    let mut snapshot = fetch_private_account_snapshot(&account).await?;
    let runtime = app.state::<MarketRuntime>();
    filter_cancelled_pending_orders(runtime.inner(), &mut snapshot);
    Ok(snapshot)
}

/// Builds the strictly shaped, read-only portfolio payload supplied to one
/// Systematic Profile callback. The Python process receives this JSON only;
/// credentials, account objects, and order clients never cross the boundary.
pub(crate) async fn systematic_profile_portfolio_snapshot(
    app: tauri::AppHandle,
    account_id: &str,
    inst_id: &str,
    cutoff_at: i64,
) -> Result<serde_json::Value, String> {
    let runtime = app.state::<MarketRuntime>();
    let snapshot = if let Some(snapshot) = ai_read_memory_account_snapshot(runtime.inner(), Some(account_id))
        .filter(|value| {
            value.positions_complete
                && value.orders_complete
                && now_ms().saturating_sub(value.synced_at) <= 5_000
        })
    {
        snapshot
    } else {
        let snapshot = match okx_private_snapshot(
            app.clone(),
            PrivateSnapshotRequest {
                account_id: Some(account_id.to_string()),
            },
        )
        .await
        {
            Ok(snapshot) => snapshot,
            Err(error) => {
                mark_memory_private_snapshot_incomplete(runtime.inner(), account_id, &error);
                return Err(error);
            }
        };
        // A REST read is the recovery baseline after a private-stream gap.
        // Cache it so subsequent Profile cycles can return to the low-latency
        // stream path instead of issuing REST reads forever.
        if let Ok(mut store) = runtime.store.lock() {
            store.private_snapshot = Some(snapshot.clone());
            store.private_snapshots.insert(
                format!(
                    "{}:{}",
                    normalize_environment(&snapshot.environment),
                    snapshot.account_id
                ),
                snapshot.clone(),
            );
        }
        snapshot
    };
    if snapshot.account_id != account_id {
        return Err("策略 Profile 账户快照身份不匹配".to_string());
    }
    if !snapshot.positions_complete || !snapshot.orders_complete {
        return Err("策略 Profile 账户快照不完整，无法安全执行".to_string());
    }
    let instrument = crate::trade_support::fetch_instrument(&app, inst_id).await?;
    let contract_value = parse_optional_f64(&instrument.ct_val)
        .filter(|value| *value > 0.0)
        .unwrap_or(1.0);
    let usdt = snapshot
        .balances
        .iter()
        .find(|balance| balance.ccy.eq_ignore_ascii_case("USDT"));
    let equity = usdt
        .and_then(|balance| parse_optional_f64(&balance.eq))
        .unwrap_or(0.0)
        .max(0.0);
    let available = usdt
        .and_then(|balance| parse_optional_f64(&balance.avail_eq))
        .or_else(|| usdt.and_then(|balance| parse_optional_f64(&balance.avail_bal)))
        .unwrap_or(equity)
        .clamp(0.0, equity);
    let positions = snapshot
        .positions
        .iter()
        .filter(|position| position.inst_id == inst_id)
        .filter_map(|position| {
            let signed_quantity = parse_optional_f64(&position.pos)?;
            if signed_quantity.abs() <= f64::EPSILON {
                return None;
            }
            let side = match position.pos_side.as_str() {
                "long" => "long",
                "short" => "short",
                _ if signed_quantity > 0.0 => "long",
                _ => "short",
            };
            let entry_price = parse_optional_f64(&position.avg_px)?;
            let mark_price = parse_optional_f64(&position.mark_px)
                .filter(|price| *price > 0.0)
                .unwrap_or(entry_price);
            let leverage = parse_optional_f64(&position.lever).unwrap_or(1.0).max(1.0);
            let notional = parse_optional_f64(&position.notional_usd)
                .filter(|value| *value > 0.0)
                .unwrap_or_else(|| signed_quantity.abs() * contract_value * mark_price);
            let margin = okx_position_used_margin(position, notional, leverage)
                .unwrap_or(0.0);
            Some(json!({
                "instrumentId": inst_id,
                "side": side,
                "quantity": signed_quantity.abs(),
                "averageEntryPrice": entry_price,
                "markPrice": mark_price,
                "contractValue": contract_value,
                "notionalUsdt": notional,
                "usedMarginUsdt": margin,
                "leverage": leverage,
                "marginSafetyMultiplier": 1.0,
                "unrealizedPnlUsdt": parse_optional_f64(&position.upl).unwrap_or(0.0),
                "entryFeeUsdt": 0.0,
                "fundingCashflowUsdt": 0.0,
                "openedAtMs": position.c_time.parse::<i64>().ok().unwrap_or(cutoff_at).min(cutoff_at),
                "updatedAtMs": position.u_time.parse::<i64>().ok().unwrap_or(cutoff_at).min(cutoff_at),
            }))
        })
        .collect::<Vec<_>>();
    let used_margin = positions
        .iter()
        .filter_map(|value| value.get("usedMarginUsdt").and_then(serde_json::Value::as_f64))
        .sum::<f64>()
        .min(equity);
    let available_margin = available.min((equity - used_margin).max(0.0));
    let open_orders = snapshot
        .orders
        .iter()
        .filter_map(|order| systematic_profile_open_order(order, inst_id, cutoff_at))
        .collect::<Vec<_>>();
    let recent_fills = systematic_profile_recent_fills(
        &app,
        account_id,
        &snapshot.environment,
        inst_id,
        cutoff_at,
        contract_value,
    )?;
    Ok(json!({
        "cashUsdt": equity,
        "equityUsdt": equity,
        "usedMarginUsdt": used_margin,
        "availableMarginUsdt": available_margin,
        "positions": positions,
        "openOrders": open_orders,
        "recentFills": recent_fills,
        "trades": [],
        "ledgerMode": "replace",
    }))
}

fn systematic_profile_open_order(
    order: &OkxPendingOrder,
    inst_id: &str,
    cutoff_at: i64,
) -> Option<serde_json::Value> {
    if order.is_algo || order.inst_id != inst_id || order.ord_id.trim().is_empty() {
        return None;
    }
    let action = match (order.side.as_str(), order.pos_side.as_str()) {
        ("buy", "long") => "open_long",
        ("sell", "short") => "open_short",
        ("sell", "long") => "close_long",
        ("buy", "short") => "close_short",
        _ => return None,
    };
    let quantity = parse_optional_f64(&order.sz).filter(|value| *value > 0.0)?;
    let filled_quantity = parse_optional_f64(&order.acc_fill_sz)
        .unwrap_or(0.0)
        .clamp(0.0, quantity);
    if filled_quantity + f64::EPSILON >= quantity {
        return None;
    }
    let created_at = order
        .c_time
        .parse::<i64>()
        .ok()
        .filter(|value| *value > 0 && *value <= cutoff_at)?;
    let state = order.state.to_ascii_lowercase();
    let status = if filled_quantity > f64::EPSILON || state == "partially_filled" {
        "partially_filled"
    } else {
        "open"
    };
    let mut value = json!({
        "id": order.ord_id,
        "instrumentId": inst_id,
        "action": action,
        "quantity": quantity,
        "filledQuantity": filled_quantity,
        "status": status,
        "createdAtMs": created_at,
    });
    if let Some(price) = parse_optional_f64(&order.px).filter(|price| *price > 0.0) {
        value["price"] = json!(price);
    }
    Some(value)
}

fn systematic_profile_recent_fills(
    app: &tauri::AppHandle,
    account_id: &str,
    environment: &str,
    inst_id: &str,
    cutoff_at: i64,
    contract_value: f64,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = open_read_database(app)?;
    let mut statement = conn
        .prepare(
            "SELECT bill_id,ord_id,side,pos_side,fill_px,fill_sz,fee,COALESCE(okx_ts,synced_at)
             FROM okx_fills
             WHERE account_id=?1 AND environment=?2 AND inst_id=?3
               AND COALESCE(okx_ts,synced_at)<=?4
             ORDER BY COALESCE(okx_ts,synced_at) DESC LIMIT 200",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![account_id, environment, inst_id, cutoff_at], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, i64>(7)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let raw_rows = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut fills = raw_rows
        .into_iter()
        .filter_map(|(bill_id, order_id, side, pos_side, price, quantity, fee, filled_at)| {
            let quantity = parse_optional_f64(quantity.as_deref()?).filter(|value| *value > 0.0)?;
            let price = parse_optional_f64(price.as_deref()?).filter(|value| *value > 0.0)?;
            let action = match (
                side.as_deref().unwrap_or_default(),
                pos_side.as_deref().unwrap_or_default(),
            ) {
                ("buy", "long") => "open_long",
                ("sell", "long") => "close_long",
                ("sell", "short") => "open_short",
                ("buy", "short") => "close_short",
                _ => return None,
            };
            Some(json!({
                "id": bill_id,
                "orderId": order_id.unwrap_or_else(|| bill_id.clone()),
                "instrumentId": inst_id,
                "action": action,
                "quantity": quantity,
                "price": price,
                "notionalUsdt": quantity * contract_value * price,
                "filledAtMs": filled_at.max(1),
                "feeUsdt": parse_optional_f64(fee.as_deref().unwrap_or("")).unwrap_or(0.0).abs(),
            }))
        })
        .collect::<Vec<_>>();
    fills.reverse();
    Ok(fills)
}

const PRIVATE_PENDING_ORDER_MAX_RETRIES: usize = 3;
const PRIVATE_PENDING_ORDER_RETRY_DELAYS_MS: &[u64] = &[150, 350, 750];

async fn fetch_pending_orders_with_retry<T>(
    account: &LocalAccount,
    path: &str,
    label: &str,
) -> Result<OkxEnvelope<T>, String>
where
    T: serde::de::DeserializeOwned,
{
    let mut last_error = String::new();
    for attempt in 0..=PRIVATE_PENDING_ORDER_MAX_RETRIES {
        match okx_private_get::<T>(account, path).await {
            Ok(envelope) => return Ok(envelope),
            Err(error) => {
                last_error = error;
                if attempt < PRIVATE_PENDING_ORDER_MAX_RETRIES {
                    sleep(Duration::from_millis(
                        PRIVATE_PENDING_ORDER_RETRY_DELAYS_MS
                            .get(attempt)
                            .copied()
                            .unwrap_or(750),
                    ))
                    .await;
                }
            }
        }
    }
    Err(format!(
        "PENDING_ORDERS_SNAPSHOT_UNAVAILABLE: {} after {} retries: {}",
        label, PRIVATE_PENDING_ORDER_MAX_RETRIES, last_error
    ))
}

async fn fetch_private_account_snapshot(
    account: &LocalAccount,
) -> Result<PrivateAccountSnapshot, String> {
    if account.exchange.to_lowercase() != "okx" {
        return Err(format!("unsupported exchange {}", account.exchange));
    }
    if !account.permissions.read {
        return Err("account read permission is disabled".to_string());
    }

    let (balance, positions, orders, algo_orders, tpsl_algo_orders) = tokio::join!(
        okx_private_get::<OkxBalanceEnvelope>(&account, "/api/v5/account/balance"),
        okx_private_get::<OkxPosition>(&account, "/api/v5/account/positions?instType=SWAP"),
        fetch_pending_orders_with_retry::<OkxPendingOrder>(
            &account,
            "/api/v5/trade/orders-pending?instType=SWAP",
            "orders-pending",
        ),
        fetch_pending_orders_with_retry::<OkxAlgoPendingOrder>(
            &account,
            "/api/v5/trade/orders-algo-pending?instType=SWAP&ordType=trigger",
            "orders-algo-pending(trigger)",
        ),
        fetch_pending_orders_with_retry::<OkxAlgoPendingOrder>(
            &account,
            "/api/v5/trade/orders-algo-pending?instType=SWAP&ordType=conditional,oco",
            "orders-algo-pending(conditional,oco)",
        )
    );
    let balance = balance?;
    let positions = positions?;
    let orders = orders?;
    let algo_orders = algo_orders?;
    let tpsl_algo_orders = tpsl_algo_orders?;
    let balances = balance
        .data
        .into_iter()
        .flat_map(|item| item.details)
        .filter(|item| !item.ccy.is_empty())
        .collect::<Vec<_>>();
    let mut pending_orders = orders.data;
    pending_orders.extend(algo_orders.data.into_iter().map(pending_order_from_algo));
    pending_orders.extend(
        tpsl_algo_orders
            .data
            .into_iter()
            .map(pending_order_from_algo),
    );
    let active_positions = positions
        .data
        .into_iter()
        .filter(is_active_swap_position)
        .collect::<Vec<_>>();

    Ok(PrivateAccountSnapshot {
        account_id: account.id.clone(),
        environment: account.environment.clone(),
        balances,
        positions: active_positions,
        orders: pending_orders,
        positions_complete: true,
        position_seq_id: None,
        orders_complete: true,
        orders_error: None,
        synced_at: now_ms(),
    })
}

fn pending_order_from_algo(order: OkxAlgoPendingOrder) -> OkxPendingOrder {
    OkxPendingOrder {
        inst_id: order.inst_id,
        inst_type: order.inst_type,
        ord_id: order.algo_id.clone(),
        cl_ord_id: order.algo_cl_ord_id.clone(),
        algo_id: order.algo_id,
        algo_cl_ord_id: order.algo_cl_ord_id,
        is_algo: true,
        side: order.side,
        pos_side: order.pos_side,
        td_mode: order.td_mode,
        ord_type: if order.ord_type.is_empty() {
            "trigger".to_string()
        } else {
            order.ord_type
        },
        px: if order.trigger_px.is_empty() {
            order.ord_px.clone()
        } else {
            order.trigger_px.clone()
        },
        trigger_px: order.trigger_px,
        trigger_px_type: order.trigger_px_type,
        ord_px: order.ord_px,
        tp_trigger_px: order.tp_trigger_px,
        tp_trigger_px_type: order.tp_trigger_px_type,
        tp_ord_px: order.tp_ord_px,
        sl_trigger_px: order.sl_trigger_px,
        sl_trigger_px_type: order.sl_trigger_px_type,
        sl_ord_px: order.sl_ord_px,
        sz: order.sz,
        acc_fill_sz: order.actual_sz,
        avg_px: String::new(),
        state: order.state,
        lever: order.lever,
        reduce_only: order.reduce_only,
        c_time: order.c_time,
        u_time: order.u_time,
    }
}

fn is_active_swap_position(position: &OkxPosition) -> bool {
    (position.inst_type.is_empty() || position.inst_type.eq_ignore_ascii_case("SWAP"))
        && parse_optional_f64(&position.pos).is_some_and(|value| value.abs() > 0.0)
}

#[derive(Debug, Clone, Copy, Default)]
struct PrivatePositionSequence {
    seq_id: Option<i64>,
    prev_seq_id: Option<i64>,
}

fn private_sequence_value(value: Option<&Value>) -> Option<i64> {
    value.and_then(|item| {
        item.as_i64().or_else(|| {
            item.as_str()
                .and_then(|text| text.trim().parse::<i64>().ok())
        })
    })
}

fn private_position_sequence(value: &Value, data: &[Value]) -> PrivatePositionSequence {
    let sequence_source = data.first().unwrap_or(value);
    PrivatePositionSequence {
        seq_id: private_sequence_value(
            value
                .get("seqId")
                .or_else(|| sequence_source.get("seqId")),
        ),
        prev_seq_id: private_sequence_value(
            value
                .get("prevSeqId")
                .or_else(|| sequence_source.get("prevSeqId")),
        ),
    }
}

fn private_position_key(position: &OkxPosition) -> String {
    if !position.pos_id.trim().is_empty() {
        return format!("pos:{}", position.pos_id.trim());
    }
    let side = if position.pos_side.trim().is_empty() {
        parse_optional_f64(&position.pos)
            .filter(|value| *value != 0.0)
            .map(|value| if value > 0.0 { "long" } else { "short" })
            .unwrap_or("unknown")
    } else {
        position.pos_side.trim()
    };
    format!(
        "pair:{}:{}",
        position.inst_id.trim().to_ascii_uppercase(),
        side.to_ascii_lowercase()
    )
}

fn private_position_update_is_newer(incoming: &OkxPosition, existing: &OkxPosition) -> bool {
    match (
        incoming.u_time.trim().parse::<i64>().ok(),
        existing.u_time.trim().parse::<i64>().ok(),
    ) {
        (Some(incoming), Some(existing)) => incoming >= existing,
        _ => true,
    }
}

/// Applies one private positions event without treating its data array as a
/// complete account snapshot. REST is the only operation that establishes a
/// complete baseline; a sequence gap invalidates the baseline until REST
/// succeeds again.
fn merge_private_position_delta(
    snapshot: &mut PrivateAccountSnapshot,
    positions: &[OkxPosition],
    sequence: PrivatePositionSequence,
) {
    if !snapshot.positions_complete {
        return;
    }
    if let Some(previous) = sequence.prev_seq_id {
        if let Some(current) = snapshot.position_seq_id {
            if previous != current {
                snapshot.positions_complete = false;
                return;
            }
        }
    }
    if let Some(sequence_id) = sequence.seq_id {
        if snapshot
            .position_seq_id
            .is_some_and(|current| sequence_id <= current)
        {
            return;
        }
        snapshot.position_seq_id = Some(sequence_id);
    }
    for position in positions {
        let key = private_position_key(position);
        if is_active_swap_position(position) {
            if let Some(existing) = snapshot
                .positions
                .iter_mut()
                .find(|item| private_position_key(item) == key)
            {
                if private_position_update_is_newer(position, existing) {
                    *existing = position.clone();
                }
            } else {
                snapshot.positions.push(position.clone());
            }
        } else {
            let should_remove = snapshot
                .positions
                .iter()
                .find(|item| private_position_key(item) == key)
                .is_none_or(|existing| private_position_update_is_newer(position, existing));
            if should_remove {
                snapshot
                    .positions
                    .retain(|item| private_position_key(item) != key);
            }
        }
    }
}

fn mark_private_snapshot_complete(snapshot: &mut PrivateAccountSnapshot) {
    snapshot.positions_complete = true;
    snapshot.position_seq_id = None;
    snapshot.orders_complete = true;
    snapshot.orders_error = None;
}

#[tauri::command]
async fn okx_leverage_info(
    app: tauri::AppHandle,
    request: LeverageInfoRequest,
) -> Result<Vec<OkxLeverageInfo>, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    if normalize_environment(&account.environment) != normalize_environment(&request.environment) {
        return Err("账号环境与当前交易环境不一致".to_string());
    }
    if !account.permissions.read {
        return Err("账号缺少读取权限".to_string());
    }
    if !matches!(request.mgn_mode.as_str(), "cross" | "isolated") {
        return Err("保证金模式必须是 cross 或 isolated".to_string());
    }

    let path = leverage_info_path(&request.inst_id, &request.mgn_mode);
    let envelope = okx_private_get::<OkxLeverageInfo>(&account, &path).await?;
    Ok(envelope.data)
}

/*
#[tauri::command]
async fn okx_set_leverage(app: tauri::AppHandle, request: SetLeverageRequest) -> Result<SetLeverageResponse, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
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

    let config = okx_private_get::<OkxAccountConfig>(&account, "/api/v5/account/config")
        .await?
        .data
        .into_iter()
        .next()
        .ok_or_else(|| "OKX 账户配置为空".to_string())?;
    if !config.perm.split(',').any(|perm| perm.trim() == "trade") {
        return Err("OKX API Key 未包含 trade 权限".to_string());
    }

    let mut warnings = Vec::new();
    let pos_sides = leverage_pos_sides(config.pos_mode.as_str(), request.pos_side.as_deref());
    if config.pos_mode == "long_short_mode" && request.pos_side.is_none() {
        warnings.push("双向持仓模式已同步 long/short 两侧杠杆".to_string());
    }

    let mut results = Vec::new();
    for pos_side in pos_sides {
        let body = SetLeverageBody {
            inst_id: request.inst_id.clone(),
            lever: request.lever.clone(),
            mgn_mode: request.mgn_mode.clone(),
            pos_side: pos_side.clone(),
        };
        let envelope = match okx_private_post::<OkxLeverageInfo, _>(&account, "/api/v5/account/set-leverage", &body).await {
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
                    "user",
                    None,
                    None,
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
                "user",
                None,
                None,
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
                Some(if row.pos_side.trim().is_empty() { pos_side.as_deref().unwrap_or("net") } else { row.pos_side.as_str() }),
                Some(&request.mgn_mode),
                None,
                None,
                "user",
                None,
                None,
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
async fn okx_place_order(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, MarketRuntime>,
    request: PlaceOrderRequest,
) -> Result<PlaceOrderResponse, String> {
    if normalize_environment(&request.environment) == "live" && request.confirmed_live != Some(true) {
        return Err("实盘下单缺少二次确认标记".to_string());
    }
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    ensure_trade_account(&account, &request.environment).await?;

    let precheck = trade_precheck(
        app.clone(),
        TradePrecheckRequest {
            account_id: request.account_id.clone(),
            inst_id: request.inst_id.clone(),
            td_mode: request.td_mode.clone(),
            order_type: request.order_type.clone(),
            ticket_mode: request.ticket_mode.clone(),
            action: Some(request.action.clone()),
            price: request.price.clone(),
            size: request.size.clone(),
            lever: request.lever.clone(),
            environment: request.environment.clone(),
        },
        runtime.clone(),
    )
    .await?;
    if precheck.blocked {
        let operator = normalize_trade_operator(request.operator.as_ref());
        audit_trade_event(
            &app,
            &account,
            &request.inst_id,
            "order_submit",
            "trade_precheck",
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
            Some(&precheck.reasons.join("；")),
            json!({ "request": &request, "precheck": &precheck }),
            None,
        );
        return Err(format!("下单前风控未通过：{}", precheck.reasons.join("；")));
    }

    let config = okx_private_get::<OkxAccountConfig>(&account, "/api/v5/account/config")
        .await?
        .data
        .into_iter()
        .next()
        .ok_or_else(|| "OKX 账户配置为空".to_string())?;
    let (side, pos_side, reduce_only) = order_direction(&request.action, &config.pos_mode)?;
    let ord_type = match request.order_type.as_str() {
        "limit" => "limit",
        "market" => "market",
        "trigger" => "trigger",
        _ => return Err("委托类型无效".to_string()),
    };
    let cl_ord_id = format!("dt{}{}", now_ms(), request.action.chars().next().unwrap_or('o'));
    if ord_type == "trigger" {
        let body = PlaceAlgoOrderBody {
            inst_id: request.inst_id.clone(),
            td_mode: request.td_mode.clone(),
            algo_cl_ord_id: cl_ord_id.clone(),
            client_marker: exchange_client_marker(),
            side: side.clone(),
            pos_side,
            ord_type: "trigger".to_string(),
            sz: request.size.clone(),
            trigger_px: request.price.clone(),
            trigger_px_type: "last".to_string(),
            order_px: "-1".to_string(),
            reduce_only,
        };
        let envelope = okx_private_post::<OkxAlgoOrderResult, _>(&account, "/api/v5/trade/order-algo", &body).await?;
        let result = envelope.data.into_iter().next().ok_or_else(|| "OKX 计划委托返回为空".to_string())?;
        if result.s_code != "0" {
            audit_trade_event(
                &app,
                &account,
                &request.inst_id,
                "order_submit",
                "place_algo_order",
                "rejected",
                Some("trigger"),
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
                json!({ "request": &request, "okxBody": &body }),
                Some(json!(&result)),
            );
            return Err(classified_okx_error("okx_trade_order_algo", "计划委托", &result.s_code, &result.s_msg));
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
            Some("trigger"),
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
            json!({ "request": &request, "okxBody": &body }),
            Some(json!(&result)),
        );
        return Ok(PlaceOrderResponse {
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
        });
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
        px: if ord_type == "market" { None } else { Some(request.price.clone()) },
        reduce_only,
        attach_algo_ords: request.attach_algo_ords.clone().filter(|items| !items.is_empty()),
    };
    let ws_request_id = format!("ord{}", now_ms());
    let ws_payload = json!({
        "id": ws_request_id,
        "op": "order",
        "args": [body]
    });
    let ws_response = send_private_trade_command(runtime.inner(), &account, ws_payload).await;
    let (result, transport_hint) = match ws_response {
        Ok(value) => {
            let data = value
                .get("data")
                .and_then(|item| item.as_array())
                .and_then(|items| items.first())
                .ok_or_else(|| "OKX WS 下单返回为空".to_string())?;
            (
                serde_json::from_value::<OkxOrderResult>(data.clone()).map_err(|err| err.to_string())?,
                "ws",
            )
        }
        Err(_) => {
            let envelope = okx_private_post::<OkxOrderResult, _>(&account, "/api/v5/trade/order", &body).await?;
            (
                envelope.data.into_iter().next().ok_or_else(|| "OKX 下单返回为空".to_string())?,
                "rest_fallback",
            )
        }
    };
    if result.s_code != "0" {
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
            Some(&result.s_msg),
            json!({ "request": &request, "okxBody": &body }),
            Some(json!(&result)),
        );
        return Err(classified_okx_error("okx_trade_order", "下单", &result.s_code, &result.s_msg));
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
        json!({ "request": &request, "okxBody": &body, "transport": transport_hint }),
        Some(json!(&result)),
    );
    Ok(PlaceOrderResponse {
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
    })
}

#[tauri::command]
async fn okx_cancel_order(
    runtime: tauri::State<'_, MarketRuntime>,
    app: tauri::AppHandle,
    request: CancelOrderRequest,
) -> Result<OkxOrderResult, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    ensure_trade_account(&account, &request.environment).await?;
    if request.ord_id.as_deref().unwrap_or("").trim().is_empty()
        && request.cl_ord_id.as_deref().unwrap_or("").trim().is_empty()
        && request.algo_id.as_deref().unwrap_or("").trim().is_empty()
        && request.algo_cl_ord_id.as_deref().unwrap_or("").trim().is_empty()
    {
        return Err("撤单需要 ordId 或 clOrdId".to_string());
    }
    let cancel_target = resolve_cancel_target(&app, &account, &request)?;
    if cancel_target.is_algo {
        let body = CancelAlgoOrderBody {
            inst_id: request.inst_id.clone(),
            algo_id: cancel_target.ord_id.clone(),
            algo_cl_ord_id: cancel_target.cl_ord_id.clone(),
        };
        let cancel_bodies = vec![body];
        let envelope = okx_private_post::<OkxAlgoOrderResult, _>(&account, "/api/v5/trade/cancel-algos", &cancel_bodies).await?;
        let result = envelope.data.into_iter().next().ok_or_else(|| "OKX 撤销计划委托返回为空".to_string())?;
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
                "user",
                None,
                None,
                normalize_environment(&request.environment) == "live",
                Some(&result.s_code),
                Some(&result.s_msg),
                Some(&result.s_msg),
                json!({ "request": &request, "okxBody": &cancel_bodies }),
                Some(json!(&result)),
            );
            return Err(classified_okx_error("okx_cancel_algo_order", "撤销计划委托", &result.s_code, &result.s_msg));
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
            "user",
            None,
            None,
            normalize_environment(&request.environment) == "live",
            Some(&result.s_code),
            Some(&result.s_msg),
            None,
            json!({ "request": &request, "okxBody": &cancel_bodies }),
            Some(json!(&result)),
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
    let ws_payload = json!({
        "id": ws_request_id,
        "op": "cancel-order",
        "args": [body]
    });
    let ws_response = send_private_trade_command(runtime.inner(), &account, ws_payload).await;
    let (result, transport_hint) = match ws_response {
        Ok(value) => {
            let data = value
                .get("data")
                .and_then(|item| item.as_array())
                .and_then(|items| items.first())
                .ok_or_else(|| "OKX WS 撤单返回为空".to_string())?;
            (
                serde_json::from_value::<OkxOrderResult>(data.clone()).map_err(|err| err.to_string())?,
                "ws",
            )
        }
        Err(_) => {
            let envelope = okx_private_post::<OkxOrderResult, _>(&account, "/api/v5/trade/cancel-order", &body).await?;
            (
                envelope.data.into_iter().next().ok_or_else(|| "OKX 撤单返回为空".to_string())?,
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
            "user",
            None,
            None,
            normalize_environment(&request.environment) == "live",
            Some(&result.s_code),
            Some(&result.s_msg),
            Some(&result.s_msg),
            json!({ "request": &request, "okxBody": &body }),
            Some(json!(&result)),
        );
        return Err(classified_okx_error("okx_cancel_order", "撤单", &result.s_code, &result.s_msg));
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
        "user",
        None,
        None,
        normalize_environment(&request.environment) == "live",
        Some(&result.s_code),
        Some(&result.s_msg),
        None,
        json!({ "request": &request, "okxBody": &body, "transport": transport_hint }),
        Some(json!(&result)),
    );
    Ok(result)
}

#[tauri::command]
async fn trade_precheck(
    app: tauri::AppHandle,
    request: TradePrecheckRequest,
    runtime: tauri::State<'_, MarketRuntime>,
) -> Result<TradePrecheckResponse, String> {
    let mut reasons = Vec::new();
    let mut warnings = Vec::new();
    let mut snapshot: Option<PrivateAccountSnapshot> = None;
    let mut available_usdt = None;
    let mut long_available = None;
    let mut short_available = None;
    let mut account_config = None;
    let mut fee_summary = None;
    let mut max_order = None;
    let mut leverage_info = None;
    let mut position_tiers: Vec<OkxPositionTier> = Vec::new();
    let mut position_tier = None;

    reasons.extend(market_health_blockers(runtime.inner(), &request.environment));

    let instrument = fetch_instrument(&request.inst_id).await?;
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

    if let Some(account) = account.as_ref() {
        if account.exchange.to_lowercase() != "okx" {
            reasons.push(format!("不支持的交易所：{}", account.exchange));
        }
        if normalize_environment(&account.environment) != normalize_environment(&request.environment) {
            reasons.push("账号环境与当前交易环境不一致".to_string());
        }
        if !account.permissions.read {
            reasons.push("账号缺少读取权限".to_string());
        }
        if !account.permissions.trade {
            warnings.push("账号未开启交易权限，真实下单会被阻止".to_string());
        }
        if account.permissions.read {
            match okx_private_get::<OkxAccountConfig>(account, "/api/v5/account/config").await {
                Ok(envelope) => {
                    if let Some(config) = envelope.data.into_iter().next() {
                        if !config.perm.split(',').any(|perm| perm.trim() == "trade") {
                            reasons.push("OKX API Key 未包含 trade 权限".to_string());
                        }
                        if config.acct_lv == "1" {
                            reasons.push("当前账户为现货模式，不能交易永续合约".to_string());
                        }
                        if config.acct_lv == "4" && request.td_mode == "cross" {
                            warnings.push("组合保证金账户全仓最大可买卖数量可能无法由 OKX 计算".to_string());
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
                        });
                    }
                }
                Err(err) => warnings.push(format!("账户配置读取失败：{}", err)),
            }
            match okx_private_snapshot(
                app.clone(),
                PrivateSnapshotRequest {
                    account_id: Some(account.id.clone()),
                },
            )
            .await
            {
                Ok(data) => {
                    available_usdt = data
                        .balances
                        .iter()
                        .find(|balance| balance.ccy.eq_ignore_ascii_case("USDT"))
                        .and_then(available_balance_value);
                    long_available = position_available(&data.positions, &request.inst_id, "long");
                    short_available = position_available(&data.positions, &request.inst_id, "short");
                    snapshot = Some(data);
                }
                Err(err) => warnings.push(format!("账户快照同步失败：{}；已跳过余额/持仓本地校验，最终以 OKX 下单返回为准", err)),
            }
        }
    }

    let price = request.price.trim().parse::<f64>().ok();
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

    if !instrument.inst_family.trim().is_empty() {
        let tier_path = format!(
            "/api/v5/public/position-tiers?tdMode={}&instType=SWAP&instFamily={}",
            url_encode(&request.td_mode),
            url_encode(&instrument.inst_family)
        );
        match get_json::<OkxPositionTier>(&tier_path).await {
            Ok(envelope) => {
                position_tiers = envelope.data;
            }
            Err(err) => warnings.push(format!("仓位档位读取失败：{}", err)),
        }
    }

    if let Some(account) = account.as_ref().filter(|account| account.permissions.read) {
        let query_px = price.map(trim_float).unwrap_or_else(|| request.price.clone());
        let max_size_path = format!(
            "/api/v5/account/max-size?instId={}&tdMode={}&px={}&leverage={}",
            url_encode(&request.inst_id),
            url_encode(&request.td_mode),
            url_encode(&query_px),
            url_encode(&request.lever)
        );
        match okx_private_get::<OkxMaxSize>(account, &max_size_path).await {
            Ok(envelope) => {
                if let Some(item) = envelope.data.into_iter().next() {
                    max_order = Some(OkxMaxOrderSummary {
                        max_buy: parse_optional_f64(&item.max_buy),
                        max_sell: parse_optional_f64(&item.max_sell),
                        avail_buy: None,
                        avail_sell: None,
                    });
                }
            }
            Err(err) => warnings.push(format!("最大可开仓张数读取失败：{}", err)),
        }

        let max_avail_path = format!(
            "/api/v5/account/max-avail-size?instId={}&tdMode={}",
            url_encode(&request.inst_id),
            url_encode(&request.td_mode)
        );
        match okx_private_get::<OkxMaxAvailSize>(account, &max_avail_path).await {
            Ok(envelope) => {
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
            Err(err) => warnings.push(format!("最大可用保证金读取失败：{}", err)),
        }

        let fee_path = if instrument.inst_family.trim().is_empty() {
            "/api/v5/account/trade-fee?instType=SWAP".to_string()
        } else {
            format!(
                "/api/v5/account/trade-fee?instType=SWAP&instFamily={}",
                url_encode(&instrument.inst_family)
            )
        };
        match okx_private_get::<OkxTradeFee>(account, &fee_path).await {
            Ok(envelope) => {
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
                        group_id: grouped.map(|group| group.group_id.clone()).filter(|value| !value.is_empty()),
                        level: fee.level,
                        ts: fee.ts,
                    });
                }
            }
            Err(err) => warnings.push(format!("手续费率读取失败：{}", err)),
        }

        let lever_path = leverage_info_path(&request.inst_id, &request.td_mode);
        match okx_private_get::<OkxLeverageInfo>(account, &lever_path).await {
            Ok(envelope) => {
                if !envelope.data.is_empty() {
                    leverage_info = Some(envelope.data);
                }
            }
            Err(err) => warnings.push(format!("当前杠杆读取失败：{}", err)),
        }
    }

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
            reasons.push(format!("下单张数必须是 lotSz {} 的整数倍", trim_float(lot_size)));
        }
    }
    if request.order_type != "market" {
        if let (Some(price), Some(tick_size)) = (price, tick_size) {
            if !is_multiple_of(price, tick_size) {
                reasons.push(format!("限价价格必须是 tickSz {} 的整数倍", trim_float(tick_size)));
            }
        }
    }
    if let (Some(size), Some(max_size)) = (size, max_size) {
        if max_size > 0.0 && size > max_size {
            reasons.push(format!("下单张数超过当前委托类型上限 {}", trim_float(max_size)));
        }
    }
    if let (Some(lever), Some(max_lever)) = (lever, max_lever) {
        if max_lever > 0.0 && lever > max_lever {
            reasons.push(format!("杠杆超过合约最大杠杆 {}X", trim_float(max_lever)));
        }
    }
    if let Some(size) = size {
        if let Some(tier) = select_position_tier(&position_tiers, size) {
            if let (Some(lever), Some(tier_max_lever)) = (lever, parse_optional_f64(&tier.max_lever)) {
                if tier_max_lever > 0.0 && lever > tier_max_lever {
                    reasons.push(format!(
                        "当前张数落在仓位档位 {}，最高可用杠杆为 {}X",
                        tier.tier,
                        trim_float(tier_max_lever)
                    ));
                }
            }
            if let Some(tier_imr) = parse_optional_f64(&tier.imr) {
                if let Some(notional) = match (price, Some(size), parse_optional_f64(&instrument.ct_val)) {
                    (Some(price), Some(size), Some(ct_val))
                        if instrument.ct_type.eq_ignore_ascii_case("linear") || instrument.settle_ccy.eq_ignore_ascii_case("USDT") =>
                    {
                        Some(size * ct_val * price)
                    }
                    (_, Some(size), Some(ct_val)) if instrument.ct_type.eq_ignore_ascii_case("inverse") => Some(size * ct_val),
                    _ => None,
                } {
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
        if !leverage_rows_match(current_rows, selected_lever, account_config.as_ref().map(|config| config.pos_mode.as_str())) {
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
            Some("close-long") if long_available.unwrap_or(0.0) <= 0.0 => reasons.push("当前没有可平多仓".to_string()),
            Some("close-short") if short_available.unwrap_or(0.0) <= 0.0 => reasons.push("当前没有可平空仓".to_string()),
            _ if long_available.unwrap_or(0.0) <= 0.0 && short_available.unwrap_or(0.0) <= 0.0 => {
                reasons.push("当前没有可平持仓".to_string())
            }
            _ => {}
        }
    }

    let notional = match (price, size, parse_optional_f64(&instrument.ct_val)) {
        (Some(price), Some(size), Some(ct_val)) if instrument.ct_type.eq_ignore_ascii_case("linear") || instrument.settle_ccy.eq_ignore_ascii_case("USDT") => {
            Some(size * ct_val * price)
        }
        (_, Some(size), Some(ct_val)) if instrument.ct_type.eq_ignore_ascii_case("inverse") => {
            warnings.push("反向合约仅估算 USD 名义价值，当前产品优先支持 USDT 线性永续".to_string());
            Some(size * ct_val)
        }
        _ => None,
    };
    let estimated_margin = match (notional, lever) {
        (Some(notional), Some(lever)) if lever > 0.0 => Some(notional / lever),
        _ => None,
    };
    let fee_rate = if request.order_type == "market" {
        fee_summary.as_ref().and_then(|fee| fee.taker).map(f64::abs).unwrap_or(0.0005)
    } else {
        fee_summary.as_ref().and_then(|fee| fee.maker).map(f64::abs).unwrap_or(0.0002)
    };
    let estimated_fee = notional.map(|value| value * fee_rate);

    if request.ticket_mode == "open" {
        if let (Some(margin), Some(available)) = (estimated_margin, available_usdt) {
            if margin > available {
                reasons.push("可用余额不足".to_string());
            }
        }
    }
    if fee_summary.is_some() {
        warnings.push("手续费率来自 OKX trade-fee，最终以实际成交为准".to_string());
    } else if request.order_type != "market" {
        warnings.push("普通限价单手续费按默认 maker 费率估算，最终以 OKX 成交为准".to_string());
    } else {
        warnings.push("市价单手续费按默认 taker 费率估算，最终以 OKX 成交为准".to_string());
    }
    warnings.push("强平价等待 OKX 风险数据精算，不能本地伪造".to_string());
    if snapshot.is_none() && account.is_some() {
        warnings.push("缺少账户快照时只能完成合约规则预检".to_string());
    }

    let normalized_price = price.zip(tick_size).map(|(value, tick)| round_down_step(value, tick));
    let normalized_size = size.zip(lot_size).map(|(value, lot)| round_down_step(value, lot));
    let instrument_summary = instrument_summary_from(instrument, None, false, now_ms());

    Ok(TradePrecheckResponse {
        ok: reasons.is_empty(),
        blocked: !reasons.is_empty(),
        reasons,
        warnings,
        notional,
        estimated_margin,
        estimated_fee,
        liquidation_text: "等待风险数据".to_string(),
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
        source: "okx-public-instruments+position-tiers+account-config+private-snapshot+trade-fee+max-size+leverage-info".to_string(),
    })
}
*/

const SPLASH_WINDOW_WIDTH: f64 = 1180.0;
const SPLASH_WINDOW_HEIGHT: f64 = 580.0;
const SPLASH_WINDOW_MARGIN: f64 = 24.0;
const MAIN_WINDOW_WIDTH: f64 = 1440.0;
const MAIN_WINDOW_HEIGHT: f64 = 900.0;

#[derive(Clone, Copy)]
enum AppWindowKind {
    Splash,
    Main,
}

fn fitted_window_size(
    kind: AppWindowKind,
    work_area: Option<tauri::LogicalSize<f64>>,
) -> tauri::LogicalSize<f64> {
    let (width, height, margin) = match kind {
        AppWindowKind::Splash => (
            SPLASH_WINDOW_WIDTH,
            SPLASH_WINDOW_HEIGHT,
            SPLASH_WINDOW_MARGIN,
        ),
        AppWindowKind::Main => (MAIN_WINDOW_WIDTH, MAIN_WINDOW_HEIGHT, 0.0),
    };
    let Some(work_area) = work_area else {
        return tauri::LogicalSize { width, height };
    };
    tauri::LogicalSize {
        width: width.min((work_area.width - margin).max(1.0)),
        height: height.min((work_area.height - margin).max(1.0)),
    }
}

fn resize_window_to_work_area(
    window: &tauri::WebviewWindow,
    kind: AppWindowKind,
) -> Result<(), String> {
    let work_area = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
        .map(|monitor| {
            monitor
                .work_area()
                .size
                .to_logical::<f64>(monitor.scale_factor())
        });
    window
        .set_size(tauri::Size::Logical(fitted_window_size(kind, work_area)))
        .map_err(|error| error.to_string())?;
    window.center().map_err(|error| error.to_string())
}

#[tauri::command]
fn enter_main_window(app: tauri::AppHandle) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let _ = main.set_resizable(true);
    let _ = main.set_shadow(true);
    resize_window_to_work_area(&main, AppWindowKind::Main)?;
    main.emit("app:enter-main", json!({ "ready": true }))
        .map_err(|err| err.to_string())?;
    main.show().map_err(|err| err.to_string())?;
    main.set_focus().map_err(|err| err.to_string())?;
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
    Ok(())
}

#[tauri::command]
fn window_action(app: tauri::AppHandle, action: String) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    match action.as_str() {
        "minimize" => {
            window.minimize().map_err(|err| err.to_string())?;
            Ok(false)
        }
        "maximize" => {
            if window.is_maximized().map_err(|err| err.to_string())? {
                window.unmaximize().map_err(|err| err.to_string())?;
                Ok(false)
            } else {
                window.maximize().map_err(|err| err.to_string())?;
                Ok(true)
            }
        }
        "close" => {
            app.exit(0);
            Ok(false)
        }
        _ => Err("unknown window action".to_string()),
    }
}

fn chart_windows_store() -> &'static Mutex<HashMap<String, ChartWindowState>> {
    CHART_WINDOWS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn chart_window_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn normalize_chart_window_id(id: Option<String>) -> String {
    let sanitized = id
        .unwrap_or_default()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect::<String>();
    if sanitized.trim().is_empty() {
        format!("cw-{}", chart_window_now_ms())
    } else {
        sanitized
    }
}

fn chart_window_summary(app: &tauri::AppHandle, state: ChartWindowState) -> ChartWindowSummary {
    let is_open = app.get_webview_window(&state.label).is_some();
    ChartWindowSummary {
        id: state.id,
        label: state.label,
        symbol: state.symbol,
        timeframe: state.timeframe,
        account_id: state.account_id,
        environment: state.environment,
        single_pane: state.single_pane,
        panes: state.panes,
        updated_at: state.updated_at,
        is_open,
    }
}

fn chart_window_webview_url(id: &str) -> Result<WebviewUrl, String> {
    if id.trim().is_empty() {
        return Err("chart window id cannot be empty".to_string());
    }

    // Keep detached charts on Tauri's app URL in both development and release builds.
    // The chart id is derived from the `chart-*` window label. Keeping the app path at
    // exactly `index.html` also lets Tauri resolve the configured dev URL correctly on
    // Windows; query strings embedded in the App path can leave WebView2 at about:blank.
    Ok(WebviewUrl::App("index.html".into()))
}

#[tauri::command]
async fn open_chart_window(
    app: tauri::AppHandle,
    request: ChartWindowRequest,
) -> Result<ChartWindowSummary, String> {
    let id = normalize_chart_window_id(request.id);
    let label = format!("chart-{}", id);
    let symbol = if request.symbol.trim().is_empty() {
        "BTC-USDT-SWAP".to_string()
    } else {
        request.symbol.trim().to_uppercase()
    };
    let timeframe = if request.timeframe.trim().is_empty() {
        "30m".to_string()
    } else {
        request.timeframe.trim().to_string()
    };
    let now = chart_window_now_ms();
    let state = ChartWindowState {
        id: id.clone(),
        label: label.clone(),
        symbol: symbol.clone(),
        timeframe: timeframe.clone(),
        account_id: request.account_id.filter(|value| !value.trim().is_empty()),
        environment: request.environment.filter(|value| !value.trim().is_empty()),
        single_pane: request.single_pane,
        panes: vec![ChartPaneState {
            id: "pane-1".to_string(),
            symbol: symbol.clone(),
            timeframe: timeframe.clone(),
        }],
        updated_at: now,
    };

    {
        let mut store = chart_windows_store()
            .lock()
            .map_err(|err| err.to_string())?;
        store.insert(id.clone(), state.clone());
    }

    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.emit("chart-window:update", &state);
        let _ = app.emit("chart-window:state-changed", &state);
        return Ok(chart_window_summary(&app, state));
    }

    let window = WebviewWindowBuilder::new(&app, label.clone(), chart_window_webview_url(&id)?)
        .title(format!("{} · {} · 图表", symbol, timeframe))
        .inner_size(1200.0, 760.0)
        .min_inner_size(760.0, 520.0)
        .background_color(tauri::window::Color(5, 5, 6, 255))
        .decorations(false)
        .shadow(true)
        .resizable(true)
        .visible(true)
        .build()
        .map_err(|err| err.to_string())?;
    let _ = window.center();
    let _ = window.set_focus();
    let _ = window.emit("chart-window:update", &state);
    let _ = app.emit("chart-window:state-changed", &state);
    Ok(chart_window_summary(&app, state))
}

#[tauri::command]
fn focus_chart_window(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    let label = format!("chart-{}", normalize_chart_window_id(Some(id)));
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.show();
        let _ = window.unminimize();
        window.set_focus().map_err(|err| err.to_string())?;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
fn close_chart_window(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    let id = normalize_chart_window_id(Some(id));
    let label = format!("chart-{}", id);
    {
        let mut store = chart_windows_store()
            .lock()
            .map_err(|err| err.to_string())?;
        store.remove(&id);
    }
    if let Some(window) = app.get_webview_window(&label) {
        window.close().map_err(|err| err.to_string())?;
        let _ = app.emit(
            "chart-window:state-changed",
            json!({ "id": id, "closed": true }),
        );
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
fn list_chart_windows(app: tauri::AppHandle) -> Result<Vec<ChartWindowSummary>, String> {
    let mut store = chart_windows_store()
        .lock()
        .map_err(|err| err.to_string())?;
    store.retain(|_, state| app.get_webview_window(&state.label).is_some());
    Ok(store
        .values()
        .cloned()
        .map(|state| chart_window_summary(&app, state))
        .collect())
}

#[tauri::command]
fn update_chart_window_state(
    app: tauri::AppHandle,
    state: ChartWindowState,
) -> Result<ChartWindowSummary, String> {
    if !state.label.starts_with("chart-") {
        return Err("invalid chart window label".to_string());
    }
    let mut next = state;
    next.updated_at = chart_window_now_ms();
    {
        let mut store = chart_windows_store()
            .lock()
            .map_err(|err| err.to_string())?;
        store.insert(next.id.clone(), next.clone());
    }
    if let Some(window) = app.get_webview_window(&next.label) {
        let _ = window.emit("chart-window:update", &next);
    }
    let _ = app.emit("chart-window:state-changed", &next);
    Ok(chart_window_summary(&app, next))
}

fn empty_chart_json() -> Value {
    json!({})
}

fn chart_storage_id(value: &str, field: &str) -> Result<String, String> {
    let normalized = value.trim();
    if normalized.is_empty()
        || normalized.len() > 128
        || !normalized
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err(format!(
            "{field} must contain 1-128 letters, numbers, hyphens, or underscores"
        ));
    }
    Ok(normalized.to_string())
}

fn chart_storage_json(value: &Value, field: &str) -> Result<String, String> {
    let encoded = serde_json::to_string(value).map_err(|err| format!("invalid {field}: {err}"))?;
    if encoded.len() > CHART_WORKSPACE_JSON_MAX_BYTES {
        return Err(format!("{field} exceeds the 1 MiB workspace storage limit"));
    }
    Ok(encoded)
}

fn chart_storage_json_from_row(value: String) -> rusqlite::Result<Value> {
    serde_json::from_str(&value).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(
            value.len(),
            rusqlite::types::Type::Text,
            Box::new(err),
        )
    })
}

fn chart_workspace_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChartWorkspace> {
    Ok(ChartWorkspace {
        id: row.get(0)?,
        name: row.get(1)?,
        layout: chart_storage_json_from_row(row.get(2)?)?,
        indicators: chart_storage_json_from_row(row.get(3)?)?,
        layers: chart_storage_json_from_row(row.get(4)?)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn chart_workspace_view_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChartWorkspaceView> {
    Ok(ChartWorkspaceView {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        sort_order: row.get(2)?,
        symbol: row.get(3)?,
        timeframe: row.get(4)?,
        layout: chart_storage_json_from_row(row.get(5)?)?,
        indicators: chart_storage_json_from_row(row.get(6)?)?,
        layers: chart_storage_json_from_row(row.get(7)?)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn chart_drawing_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChartDrawing> {
    Ok(ChartDrawing {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        view_id: row.get(2)?,
        drawing: chart_storage_json_from_row(row.get(3)?)?,
        layer: chart_storage_json_from_row(row.get(4)?)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn chart_alert_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChartAlert> {
    Ok(ChartAlert {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        view_id: row.get(2)?,
        status: row.get(3)?,
        last_triggered_at: row.get(4)?,
        definition: chart_storage_json_from_row(row.get(5)?)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn chart_workspace_exists(conn: &Connection, workspace_id: &str) -> Result<(), String> {
    let exists = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM chart_workspaces WHERE id = ?1)",
            params![workspace_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| err.to_string())?;
    if exists == 0 {
        return Err("chart workspace was not found".to_string());
    }
    Ok(())
}

fn chart_workspace_view_exists(
    conn: &Connection,
    workspace_id: &str,
    view_id: &str,
) -> Result<(), String> {
    let exists = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM chart_workspace_views WHERE id = ?1 AND workspace_id = ?2)",
            params![view_id, workspace_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| err.to_string())?;
    if exists == 0 {
        return Err("chart workspace view was not found in this workspace".to_string());
    }
    Ok(())
}

#[tauri::command]
fn chart_workspaces_list(app: tauri::AppHandle) -> Result<Vec<ChartWorkspace>, String> {
    let conn = open_database(&app)?;
    let mut statement = conn
        .prepare("SELECT id, name, layout_json, indicators_json, layers_json, created_at, updated_at FROM chart_workspaces ORDER BY updated_at DESC")
        .map_err(|err| err.to_string())?;
    let rows = statement
        .query_map([], chart_workspace_from_row)
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn chart_workspace_load(
    app: tauri::AppHandle,
    id: String,
) -> Result<Option<ChartWorkspace>, String> {
    let id = chart_storage_id(&id, "workspace id")?;
    let conn = open_database(&app)?;
    conn.query_row(
        "SELECT id, name, layout_json, indicators_json, layers_json, created_at, updated_at FROM chart_workspaces WHERE id = ?1",
        params![id],
        chart_workspace_from_row,
    )
    .optional()
    .map_err(|err| err.to_string())
}

#[tauri::command]
fn chart_workspace_save(
    app: tauri::AppHandle,
    input: ChartWorkspaceInput,
) -> Result<ChartWorkspace, String> {
    let id = match input.id.as_deref() {
        Some(value) if !value.trim().is_empty() => chart_storage_id(value, "workspace id")?,
        _ => format!("workspace-{}", now_ms()),
    };
    let name = if input.name.trim().is_empty() {
        "图表工作区"
    } else {
        input.name.trim()
    };
    if name.len() > 160 {
        return Err("workspace name exceeds 160 characters".to_string());
    }
    let layout = chart_storage_json(&input.layout, "workspace layout")?;
    let indicators = chart_storage_json(&input.indicators, "workspace indicators")?;
    let layers = chart_storage_json(&input.layers, "workspace layers")?;
    let now = now_ms();
    let conn = open_database(&app)?;
    conn.execute(
        "INSERT INTO chart_workspaces (id, name, layout_json, indicators_json, layers_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, layout_json = excluded.layout_json,
           indicators_json = excluded.indicators_json, layers_json = excluded.layers_json, updated_at = excluded.updated_at",
        params![id, name, layout, indicators, layers, now],
    )
    .map_err(|err| err.to_string())?;
    chart_workspace_load(app, id)?
        .ok_or_else(|| "chart workspace save did not return a record".to_string())
}

#[tauri::command]
fn chart_workspace_delete(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    let id = chart_storage_id(&id, "workspace id")?;
    let conn = open_database(&app)?;
    let transaction = conn
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    transaction
        .execute(
            "DELETE FROM chart_drawings WHERE workspace_id = ?1",
            params![id],
        )
        .map_err(|err| err.to_string())?;
    transaction
        .execute(
            "DELETE FROM chart_alerts WHERE workspace_id = ?1",
            params![id],
        )
        .map_err(|err| err.to_string())?;
    transaction
        .execute(
            "DELETE FROM chart_workspace_views WHERE workspace_id = ?1",
            params![id],
        )
        .map_err(|err| err.to_string())?;
    let deleted = transaction
        .execute("DELETE FROM chart_workspaces WHERE id = ?1", params![id])
        .map_err(|err| err.to_string())?
        > 0;
    transaction.commit().map_err(|err| err.to_string())?;
    chart_alerts::chart_price_alert_cache_remove_workspace(&id);
    Ok(deleted)
}

#[tauri::command]
fn chart_workspace_views_list(
    app: tauri::AppHandle,
    workspace_id: String,
) -> Result<Vec<ChartWorkspaceView>, String> {
    let workspace_id = chart_storage_id(&workspace_id, "workspace id")?;
    let conn = open_database(&app)?;
    chart_workspace_exists(&conn, &workspace_id)?;
    let mut statement = conn.prepare(
        "SELECT id, workspace_id, sort_order, symbol, timeframe, layout_json, indicators_json, layers_json, created_at, updated_at
         FROM chart_workspace_views WHERE workspace_id = ?1 ORDER BY sort_order ASC, updated_at ASC",
    ).map_err(|err| err.to_string())?;
    let rows = statement
        .query_map(params![workspace_id], chart_workspace_view_from_row)
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn chart_workspace_view_save(
    app: tauri::AppHandle,
    input: ChartWorkspaceViewInput,
) -> Result<ChartWorkspaceView, String> {
    let workspace_id = chart_storage_id(&input.workspace_id, "workspace id")?;
    let id = match input.id.as_deref() {
        Some(value) if !value.trim().is_empty() => chart_storage_id(value, "workspace view id")?,
        _ => format!("view-{}", now_ms()),
    };
    let symbol = input.symbol.trim().to_uppercase();
    let timeframe = input.timeframe.trim().to_string();
    if symbol.is_empty() || timeframe.is_empty() {
        return Err("chart workspace views require a symbol and timeframe".to_string());
    }
    let layout = chart_storage_json(&input.layout, "view layout")?;
    let indicators = chart_storage_json(&input.indicators, "view indicators")?;
    let layers = chart_storage_json(&input.layers, "view layers")?;
    let now = now_ms();
    let conn = open_database(&app)?;
    chart_workspace_exists(&conn, &workspace_id)?;
    conn.execute(
        "INSERT INTO chart_workspace_views (id, workspace_id, sort_order, symbol, timeframe, layout_json, indicators_json, layers_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
         ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, sort_order = excluded.sort_order,
           symbol = excluded.symbol, timeframe = excluded.timeframe, layout_json = excluded.layout_json,
           indicators_json = excluded.indicators_json, layers_json = excluded.layers_json, updated_at = excluded.updated_at",
        params![id, workspace_id, input.sort_order, symbol, timeframe, layout, indicators, layers, now],
    ).map_err(|err| err.to_string())?;
    conn.query_row(
        "SELECT id, workspace_id, sort_order, symbol, timeframe, layout_json, indicators_json, layers_json, created_at, updated_at
         FROM chart_workspace_views WHERE id = ?1",
        params![id], chart_workspace_view_from_row,
    ).map_err(|err| err.to_string())
}

#[tauri::command]
fn chart_workspace_view_delete(
    app: tauri::AppHandle,
    workspace_id: String,
    id: String,
) -> Result<bool, String> {
    let workspace_id = chart_storage_id(&workspace_id, "workspace id")?;
    let id = chart_storage_id(&id, "workspace view id")?;
    let conn = open_database(&app)?;
    let transaction = conn
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    transaction
        .execute(
            "DELETE FROM chart_drawings WHERE workspace_id = ?1 AND view_id = ?2",
            params![workspace_id, id],
        )
        .map_err(|err| err.to_string())?;
    transaction
        .execute(
            "DELETE FROM chart_alerts WHERE workspace_id = ?1 AND view_id = ?2",
            params![workspace_id, id],
        )
        .map_err(|err| err.to_string())?;
    let deleted = transaction
        .execute(
            "DELETE FROM chart_workspace_views WHERE workspace_id = ?1 AND id = ?2",
            params![workspace_id, id],
        )
        .map_err(|err| err.to_string())?
        > 0;
    transaction.commit().map_err(|err| err.to_string())?;
    chart_alerts::chart_price_alert_cache_remove_workspace_view(&workspace_id, &id);
    Ok(deleted)
}

#[tauri::command]
fn chart_drawings_list(
    app: tauri::AppHandle,
    workspace_id: String,
    view_id: Option<String>,
) -> Result<Vec<ChartDrawing>, String> {
    let workspace_id = chart_storage_id(&workspace_id, "workspace id")?;
    let view_id = view_id
        .map(|value| chart_storage_id(&value, "workspace view id"))
        .transpose()?;
    let conn = open_database(&app)?;
    chart_workspace_exists(&conn, &workspace_id)?;
    let sql = if view_id.is_some() {
        "SELECT id, workspace_id, view_id, drawing_json, layer_json, created_at, updated_at FROM chart_drawings WHERE workspace_id = ?1 AND view_id = ?2 ORDER BY updated_at ASC"
    } else {
        "SELECT id, workspace_id, view_id, drawing_json, layer_json, created_at, updated_at FROM chart_drawings WHERE workspace_id = ?1 ORDER BY updated_at ASC"
    };
    let mut statement = conn.prepare(sql).map_err(|err| err.to_string())?;
    let rows = if let Some(view_id) = view_id {
        statement.query_map(params![workspace_id, view_id], chart_drawing_from_row)
    } else {
        statement.query_map(params![workspace_id], chart_drawing_from_row)
    }
    .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn chart_drawing_save(
    app: tauri::AppHandle,
    input: ChartDrawingInput,
) -> Result<ChartDrawing, String> {
    let id = chart_storage_id(&input.id, "drawing id")?;
    let workspace_id = chart_storage_id(&input.workspace_id, "workspace id")?;
    let view_id = input
        .view_id
        .map(|value| chart_storage_id(&value, "workspace view id"))
        .transpose()?;
    let drawing = chart_storage_json(&input.drawing, "drawing")?;
    let layer = chart_storage_json(&input.layer, "drawing layer")?;
    let now = now_ms();
    let conn = open_database(&app)?;
    chart_workspace_exists(&conn, &workspace_id)?;
    if let Some(view_id) = view_id.as_deref() {
        chart_workspace_view_exists(&conn, &workspace_id, view_id)?;
    }
    conn.execute(
        "INSERT INTO chart_drawings (id, workspace_id, view_id, drawing_json, layer_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, view_id = excluded.view_id,
           drawing_json = excluded.drawing_json, layer_json = excluded.layer_json, updated_at = excluded.updated_at",
        params![id, workspace_id, view_id, drawing, layer, now],
    ).map_err(|err| err.to_string())?;
    conn.query_row(
        "SELECT id, workspace_id, view_id, drawing_json, layer_json, created_at, updated_at FROM chart_drawings WHERE id = ?1",
        params![id], chart_drawing_from_row,
    ).map_err(|err| err.to_string())
}

#[tauri::command]
fn chart_drawing_delete(
    app: tauri::AppHandle,
    workspace_id: String,
    id: String,
) -> Result<bool, String> {
    let workspace_id = chart_storage_id(&workspace_id, "workspace id")?;
    let id = chart_storage_id(&id, "drawing id")?;
    let conn = open_database(&app)?;
    Ok(conn
        .execute(
            "DELETE FROM chart_drawings WHERE workspace_id = ?1 AND id = ?2",
            params![workspace_id, id],
        )
        .map_err(|err| err.to_string())?
        > 0)
}

#[tauri::command]
fn chart_alerts_list(
    app: tauri::AppHandle,
    workspace_id: String,
    view_id: Option<String>,
) -> Result<Vec<ChartAlert>, String> {
    let workspace_id = chart_storage_id(&workspace_id, "workspace id")?;
    let view_id = view_id
        .map(|value| chart_storage_id(&value, "workspace view id"))
        .transpose()?;
    let conn = open_database(&app)?;
    if let Err(error) = chart_workspace_exists(&conn, &workspace_id) {
        if error == "chart workspace was not found" {
            return Ok(Vec::new());
        }
        return Err(error);
    }
    let sql = if view_id.is_some() {
        "SELECT id, workspace_id, view_id, status, last_triggered_at, definition_json, created_at, updated_at FROM chart_alerts WHERE workspace_id = ?1 AND view_id = ?2 ORDER BY updated_at DESC"
    } else {
        "SELECT id, workspace_id, view_id, status, last_triggered_at, definition_json, created_at, updated_at FROM chart_alerts WHERE workspace_id = ?1 ORDER BY updated_at DESC"
    };
    let mut statement = conn.prepare(sql).map_err(|err| err.to_string())?;
    let rows = if let Some(view_id) = view_id {
        statement.query_map(params![workspace_id, view_id], chart_alert_from_row)
    } else {
        statement.query_map(params![workspace_id], chart_alert_from_row)
    }
    .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn chart_alert_save(app: tauri::AppHandle, input: ChartAlertInput) -> Result<ChartAlert, String> {
    let id = chart_storage_id(&input.id, "alert id")?;
    let workspace_id = chart_storage_id(&input.workspace_id, "workspace id")?;
    let view_id = input
        .view_id
        .map(|value| chart_storage_id(&value, "workspace view id"))
        .transpose()?;
    let status = if input.status.trim().is_empty() {
        "active"
    } else {
        input.status.trim()
    };
    if status.len() > 64 {
        return Err("alert status exceeds 64 characters".to_string());
    }
    chart_alerts::validate_chart_alert_definition(&input.definition)?;
    let definition = chart_storage_json(&input.definition, "alert definition")?;
    let now = now_ms();
    let conn = open_database(&app)?;
    // The chart saves its workspace with a short debounce. An alert may be
    // created before that write completes, so establish the workspace row
    // here instead of losing a valid user reminder.
    conn.execute(
        "INSERT OR IGNORE INTO chart_workspaces (id,name,layout_json,indicators_json,layers_json,created_at,updated_at) VALUES (?1,'图表工作区','{}','{}','{}',?2,?2)",
        params![workspace_id, now],
    ).map_err(|err| err.to_string())?;
    chart_workspace_exists(&conn, &workspace_id)?;
    if let Some(view_id) = view_id.as_deref() {
        chart_workspace_view_exists(&conn, &workspace_id, view_id)?;
    }
    conn.execute(
        "INSERT INTO chart_alerts (id, workspace_id, view_id, status, last_triggered_at, definition_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
         ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, view_id = excluded.view_id,
           status = excluded.status, last_triggered_at = excluded.last_triggered_at,
           definition_json = excluded.definition_json, updated_at = excluded.updated_at",
        params![id, workspace_id, view_id, status, input.last_triggered_at, definition, now],
    ).map_err(|err| err.to_string())?;
    let alert = conn.query_row(
        "SELECT id, workspace_id, view_id, status, last_triggered_at, definition_json, created_at, updated_at FROM chart_alerts WHERE id = ?1",
        params![id], chart_alert_from_row,
    ).map_err(|err| err.to_string())?;
    chart_alerts::chart_price_alert_cache_after_save(&alert);
    Ok(alert)
}

#[tauri::command]
fn chart_alert_delete(
    app: tauri::AppHandle,
    workspace_id: String,
    id: String,
) -> Result<bool, String> {
    let workspace_id = chart_storage_id(&workspace_id, "workspace id")?;
    let id = chart_storage_id(&id, "alert id")?;
    let conn = open_database(&app)?;
    conn.execute(
        "DELETE FROM chart_alert_events WHERE alert_id = ?1",
        params![id],
    )
    .map_err(|err| err.to_string())?;
    let deleted = conn
        .execute(
            "DELETE FROM chart_alerts WHERE workspace_id = ?1 AND id = ?2",
            params![workspace_id, id],
        )
        .map_err(|err| err.to_string())?
        > 0;
    if deleted {
        chart_alerts::chart_price_alert_cache_remove(&id);
    }
    Ok(deleted)
}

fn chart_alert_event_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChartAlertEvent> {
    Ok(ChartAlertEvent {
        id: row.get(0)?,
        alert_id: row.get(1)?,
        workspace_id: row.get(2)?,
        inst_id: row.get(3)?,
        condition_kind: row.get(4)?,
        direction: row.get(5)?,
        trigger_price: row.get(6)?,
        last_price: row.get(7)?,
        triggered_at: row.get(8)?,
        delivery_status: row.get(9)?,
        name: String::new(),
        message: String::new(),
        notify_app: true,
        frequency: "once".to_string(),
    })
}

#[tauri::command]
fn chart_alert_events_list(
    app: tauri::AppHandle,
    workspace_id: String,
    alert_id: Option<String>,
) -> Result<Vec<ChartAlertEvent>, String> {
    let workspace_id = chart_storage_id(&workspace_id, "workspace id")?;
    let alert_id = alert_id
        .map(|id| chart_storage_id(&id, "alert id"))
        .transpose()?;
    let conn = open_database(&app)?;
    let sql = if alert_id.is_some() {
        "SELECT id,alert_id,workspace_id,inst_id,condition_kind,direction,trigger_price,last_price,triggered_at,delivery_status FROM chart_alert_events WHERE workspace_id=?1 AND alert_id=?2 ORDER BY triggered_at DESC LIMIT 200"
    } else {
        "SELECT id,alert_id,workspace_id,inst_id,condition_kind,direction,trigger_price,last_price,triggered_at,delivery_status FROM chart_alert_events WHERE workspace_id=?1 ORDER BY triggered_at DESC LIMIT 200"
    };
    let mut statement = conn.prepare(sql).map_err(|error| error.to_string())?;
    let rows = if let Some(alert_id) = alert_id {
        statement.query_map(params![workspace_id, alert_id], chart_alert_event_from_row)
    } else {
        statement.query_map(params![workspace_id], chart_alert_event_from_row)
    }
    .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn chart_dsl_evaluate(input: ChartDslEvaluateInput) -> Result<ChartDslEvaluateResult, String> {
    let columns = desic_chart_dsl::OhlcvColumns {
        timestamp: input.candles.iter().map(|candle| candle.time).collect(),
        open: input.candles.iter().map(|candle| candle.open).collect(),
        high: input.candles.iter().map(|candle| candle.high).collect(),
        low: input.candles.iter().map(|candle| candle.low).collect(),
        close: input.candles.iter().map(|candle| candle.close).collect(),
        volume: input.candles.iter().map(|candle| candle.volume).collect(),
    };
    let limits = desic_chart_dsl::ResourceLimits::default();
    let validation = input
        .expression
        .validate(limits)
        .map_err(|error| error.to_string())?;
    let values = match input
        .expression
        .evaluate(&columns, limits)
        .map_err(|error| error.to_string())?
    {
        desic_chart_dsl::EvaluatedSeries::Number(values) => json!(values),
        desic_chart_dsl::EvaluatedSeries::Boolean(values) => json!(values),
    };
    let value_type = match validation.value_type {
        desic_chart_dsl::ValueType::Number => "number",
        desic_chart_dsl::ValueType::Boolean => "boolean",
    }
    .to_string();
    Ok(ChartDslEvaluateResult {
        value_type,
        values,
        node_count: validation.node_count,
        max_lookback: validation.max_lookback,
    })
}

/*
#[tauri::command]
fn start_market_stream(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, MarketRuntime>,
    inst_id: String,
    bar: String,
    watchlist: Option<Vec<String>>,
    account_id: Option<String>,
) -> Result<(), String> {
    abort_market_tasks(&runtime)?;

    let public_inst_id = inst_id.clone();
    let public_watchlist = normalize_watchlist(watchlist, &inst_id);
    let app_handle = app.clone();
    let public_runtime = runtime.inner().clone();
    let public_task = tauri::async_runtime::spawn(async move {
        run_public_ws_reconnecting(app_handle, public_runtime, public_inst_id, public_watchlist).await;
    });

    let app_handle = app.clone();
    let business_runtime = runtime.inner().clone();
    let business_task = tauri::async_runtime::spawn(async move {
        run_business_ws_reconnecting(app_handle, business_runtime, inst_id, bar).await;
    });

    let mut tasks = vec![public_task, business_task];
    match load_local_account_secret(&app, account_id.as_deref()) {
        Ok(account) if account.permissions.read => {
            let app_handle = app.clone();
            let private_runtime = runtime.inner().clone();
            tasks.push(tauri::async_runtime::spawn(async move {
                run_private_ws_reconnecting(app_handle, private_runtime, account).await;
            }));
        }
        Ok(_) => emit_private_status(&app, None, "账号未开启读取权限", None, None),
        Err(_) => emit_private_status(&app, None, "未配置账号", None, None),
    }

    *runtime.tasks.lock().map_err(|err| err.to_string())? = tasks;
    Ok(())
}

#[tauri::command]
fn stop_market_stream(runtime: tauri::State<'_, MarketRuntime>) -> Result<(), String> {
    abort_market_tasks(&runtime)
}

fn abort_market_tasks(runtime: &tauri::State<'_, MarketRuntime>) -> Result<(), String> {
    for task in runtime.tasks.lock().map_err(|err| err.to_string())?.drain(..) {
        task.abort();
    }
    Ok(())
}

async fn connect_okx_ws(url: &str) -> Result<OkxWebSocket, String> {
    let proxy = load_proxy_config()?;
    if proxy.enabled && matches!(proxy.proxy_type.to_uppercase().as_str(), "HTTP" | "HTTPS") {
        return connect_okx_ws_via_http_proxy(url, &proxy).await;
    }
    connect_okx_ws_direct(url).await
}

async fn connect_okx_ws_direct(url: &str) -> Result<OkxWebSocket, String> {
    let (host, port) = okx_ws_host_port(url)?;
    let stream = timeout(Duration::from_secs(10), TcpStream::connect(format!("{host}:{port}")))
        .await
        .map_err(|_| "WebSocket 直连超时".to_string())?
        .map_err(|err| format!("WebSocket 直连失败: {}", err))?;
    let connector = native_tls::TlsConnector::builder()
        .build()
        .map_err(|err| format!("WebSocket TLS 初始化失败: {}", err))?;
    let connector = tokio_native_tls::TlsConnector::from(connector);
    let tls = connector
        .connect(&host, stream)
        .await
        .map_err(|err| format!("WebSocket TLS 握手失败: {}", err))?;
    let (socket, _) = client_async(url, Box::new(tls) as BoxedIo)
        .await
        .map_err(|err| format!("WebSocket 握手失败: {}", err))?;
    Ok(socket)
}

async fn connect_okx_ws_via_http_proxy(url: &str, proxy: &ProxyConfig) -> Result<OkxWebSocket, String> {
    let (host, port) = okx_ws_host_port(url)?;
    let proxy_addr = format!("{}:{}", proxy.host.trim(), proxy.port);
    let mut stream = timeout(Duration::from_secs(10), TcpStream::connect(proxy_addr))
        .await
        .map_err(|_| "WebSocket 代理连接超时".to_string())?
        .map_err(|err| format!("WebSocket 代理连接失败: {}", err))?;
    let auth_header = proxy_authorization_header(proxy);
    let connect_request = format!(
        "CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\nProxy-Connection: Keep-Alive\r\n{auth_header}\r\n"
    );
    stream
        .write_all(connect_request.as_bytes())
        .await
        .map_err(|err| format!("WebSocket 代理 CONNECT 发送失败: {}", err))?;
    let mut reader = BufReader::new(stream);
    let mut first_line = String::new();
    reader
        .read_line(&mut first_line)
        .await
        .map_err(|err| format!("WebSocket 代理 CONNECT 响应失败: {}", err))?;
    if !first_line.contains(" 200 ") {
        return Err(format!("WebSocket 代理 CONNECT 失败: {}", first_line.trim()));
    }
    loop {
        let mut line = String::new();
        let read = reader
            .read_line(&mut line)
            .await
            .map_err(|err| format!("WebSocket 代理 CONNECT header 读取失败: {}", err))?;
        if read == 0 || line == "\r\n" || line == "\n" {
            break;
        }
    }
    let stream = reader.into_inner();
    let connector = native_tls::TlsConnector::builder()
        .build()
        .map_err(|err| format!("WebSocket TLS 初始化失败: {}", err))?;
    let connector = tokio_native_tls::TlsConnector::from(connector);
    let tls = connector
        .connect(&host, stream)
        .await
        .map_err(|err| format!("WebSocket TLS 握手失败: {}", err))?;
    let (socket, _) = client_async(url, Box::new(tls) as BoxedIo)
        .await
        .map_err(|err| format!("WebSocket 握手失败: {}", err))?;
    Ok(socket)
}

fn okx_ws_host_port(url: &str) -> Result<(String, u16), String> {
    let without_scheme = url
        .strip_prefix("wss://")
        .ok_or_else(|| format!("不支持的 WebSocket 地址: {}", url))?;
    let authority = without_scheme.split('/').next().unwrap_or_default();
    let mut parts = authority.split(':');
    let host = parts.next().unwrap_or_default().trim();
    if host.is_empty() {
        return Err(format!("WebSocket 地址缺少 host: {}", url));
    }
    let port = parts.next().and_then(|value| value.parse::<u16>().ok()).unwrap_or(443);
    Ok((host.to_string(), port))
}

async fn run_public_ws_reconnecting(
    app: tauri::AppHandle,
    runtime: MarketRuntime,
    inst_id: String,
    watchlist: Vec<String>,
) {
    let mut attempt: u32 = 0;
    loop {
        emit_market(
            &app,
            MarketEvent::Status {
                status: if attempt == 0 {
                    "public connecting".to_string()
                } else {
                    format!("public reconnecting #{}", attempt + 1)
                },
            },
        );
        match run_public_ws(app.clone(), runtime.clone(), inst_id.clone(), watchlist.clone()).await {
            Ok(received_data) => {
                attempt = if received_data { 0 } else { attempt.saturating_add(1) };
                let delay = market_ws_backoff(attempt);
                emit_market(
                    &app,
                    MarketEvent::Status {
                        status: format!("public closed, retry in {}s", delay.as_secs()),
                    },
                );
                tokio::time::sleep(delay).await;
            }
            Err(message) => {
                let delay = market_ws_backoff(attempt);
                emit_market(
                    &app,
                    MarketEvent::Error {
                        message: format!("public WS: {}；{}s 后重连", message, delay.as_secs()),
                    },
                );
                tokio::time::sleep(delay).await;
                attempt = attempt.saturating_add(1);
            }
        }
    }
}

async fn run_business_ws_reconnecting(app: tauri::AppHandle, runtime: MarketRuntime, inst_id: String, bar: String) {
    let mut attempt: u32 = 0;
    loop {
        emit_market(
            &app,
            MarketEvent::Status {
                status: if attempt == 0 {
                    "business connecting".to_string()
                } else {
                    format!("business reconnecting #{}", attempt + 1)
                },
            },
        );
        match run_business_ws(app.clone(), runtime.clone(), inst_id.clone(), bar.clone()).await {
            Ok(received_data) => {
                attempt = if received_data { 0 } else { attempt.saturating_add(1) };
                let delay = market_ws_backoff(attempt);
                emit_market(
                    &app,
                    MarketEvent::Status {
                        status: format!("business closed, retry in {}s", delay.as_secs()),
                    },
                );
                tokio::time::sleep(delay).await;
            }
            Err(message) => {
                let delay = market_ws_backoff(attempt);
                emit_market(
                    &app,
                    MarketEvent::Error {
                        message: format!("business WS: {}；{}s 后重连", message, delay.as_secs()),
                    },
                );
                tokio::time::sleep(delay).await;
                attempt = attempt.saturating_add(1);
            }
        }
    }
}

async fn run_private_ws_reconnecting(app: tauri::AppHandle, runtime: MarketRuntime, account: LocalAccount) {
    let mut attempt: u32 = 0;
    loop {
        emit_private_status(
            &app,
            Some(&account),
            if attempt == 0 { "private connecting".to_string() } else { format!("private reconnecting #{}", attempt + 1) },
            None,
            None,
        );
        match run_private_ws(app.clone(), runtime.clone(), account.clone()).await {
            Ok(received_data) => {
                attempt = if received_data { 0 } else { attempt.saturating_add(1) };
                let delay = market_ws_backoff(attempt);
                emit_private_status(&app, Some(&account), format!("private closed, retry in {}s", delay.as_secs()), None, None);
                tokio::time::sleep(delay).await;
            }
            Err(message) => {
                let delay = market_ws_backoff(attempt);
                emit_private_status(&app, Some(&account), format!("private WS: {}；{}s 后重连", message, delay.as_secs()), None, None);
                tokio::time::sleep(delay).await;
                attempt = attempt.saturating_add(1);
            }
        }
    }
}

fn market_ws_backoff(attempt: u32) -> Duration {
    let capped_exp = attempt.min(4);
    let seconds = (1_u64 << capped_exp).min(MARKET_WS_MAX_BACKOFF_SECS);
    Duration::from_secs(seconds)
}

async fn run_public_ws(
    app: tauri::AppHandle,
    runtime: MarketRuntime,
    inst_id: String,
    watchlist: Vec<String>,
) -> Result<bool, String> {
    let mut socket = connect_okx_ws(PUBLIC_WS).await?;
    clear_orderbook_state(&runtime);
    emit_market(&app, MarketEvent::Status { status: "public connected".to_string() });
    let mut args = watchlist
        .iter()
        .map(|symbol| json!({ "channel": "tickers", "instId": symbol }))
        .collect::<Vec<_>>();
    args.push(json!({ "channel": "books", "instId": inst_id }));
    args.push(json!({ "channel": "trades", "instId": inst_id }));
    let subscribe = json!({
        "op": "subscribe",
        "args": args
    });
    socket
        .send(Message::Text(subscribe.to_string()))
        .await
        .map_err(|err| err.to_string())?;

    let mut received_data = false;
    while let Some(message) = socket.next().await {
        let message = message.map_err(|err| err.to_string())?;
        if let Message::Text(text) = message {
            received_data = true;
            if handle_public_message(&app, &runtime, &text) == PublicMessageAction::Resubscribe {
                emit_market(&app, MarketEvent::Status { status: "public orderbook sequence gap, resubscribing".to_string() });
                return Ok(true);
            }
        }
    }
    emit_market(&app, MarketEvent::Status { status: "public closed".to_string() });
    Ok(received_data)
}

async fn run_business_ws(app: tauri::AppHandle, runtime: MarketRuntime, inst_id: String, bar: String) -> Result<bool, String> {
    let mut socket = connect_okx_ws(BUSINESS_WS).await?;
    emit_market(&app, MarketEvent::Status { status: "business connected".to_string() });
    let subscribe = json!({
        "op": "subscribe",
        "args": [{ "channel": format!("candle{}", bar), "instId": inst_id }]
    });
    socket
        .send(Message::Text(subscribe.to_string()))
        .await
        .map_err(|err| err.to_string())?;

    let mut received_data = false;
    while let Some(message) = socket.next().await {
        let message = message.map_err(|err| err.to_string())?;
        if let Message::Text(text) = message {
            received_data = true;
            handle_business_message(&app, &runtime, &text, &inst_id, &bar);
        }
    }
    emit_market(&app, MarketEvent::Status { status: "business closed".to_string() });
    Ok(received_data)
}

async fn run_private_ws(app: tauri::AppHandle, runtime: MarketRuntime, account: LocalAccount) -> Result<bool, String> {
    let endpoint = if account.environment.eq_ignore_ascii_case("demo") || account.environment.eq_ignore_ascii_case("simulated") {
        PRIVATE_WS_DEMO
    } else {
        PRIVATE_WS
    };
    let snapshot = fetch_private_account_snapshot(&account).await?;
    update_private_snapshot(&app, &runtime, snapshot);

    let mut socket = connect_okx_ws(endpoint).await?;
    emit_private_status(&app, Some(&account), "private connected", None, None);

    let login = private_ws_login_payload(&account)?;
    socket
        .send(Message::Text(login.to_string()))
        .await
        .map_err(|err| err.to_string())?;

    let mut received_data = false;
    let mut subscribed = false;
    let (command_tx, mut command_rx) = mpsc::unbounded_channel::<PrivateTradeCommand>();
    {
        let mut guard = runtime.private_trade.lock().await;
        *guard = Some(PrivateTradeSocketHandle {
            account_id: account.id.clone(),
            environment: account.environment.clone(),
            sender: command_tx,
        });
    }
    let mut pending_acks: HashMap<String, oneshot::Sender<Result<serde_json::Value, String>>> = HashMap::new();
    while let Some(message) = socket.next().await {
        while let Ok(command) = command_rx.try_recv() {
            pending_acks.insert(command.message_id.clone(), command.ack);
            socket
                .send(Message::Text(command.payload.to_string()))
                .await
                .map_err(|err| err.to_string())?;
        }
        let message = message.map_err(|err| err.to_string())?;
        if let Message::Text(text) = message {
            received_data = true;
            if !subscribed && private_login_succeeded(&text)? {
                let subscribe = json!({
                    "op": "subscribe",
                    "args": [
                        { "channel": "balance_and_position" },
                        { "channel": "account" },
                        { "channel": "positions", "instType": "SWAP" },
                        { "channel": "orders", "instType": "SWAP" }
                    ]
                });
                socket
                    .send(Message::Text(subscribe.to_string()))
                    .await
                    .map_err(|err| err.to_string())?;
                subscribed = true;
                emit_private_status(&app, Some(&account), "private subscribed", None, None);
                continue;
            }
            if handle_private_trade_response(&text, &mut pending_acks) {
                continue;
            }
            handle_private_message(&app, &runtime, &account, &text);
        }
    }
    {
        let mut guard = runtime.private_trade.lock().await;
        if guard
            .as_ref()
            .is_some_and(|handle| handle.account_id == account.id && handle.environment == account.environment)
        {
            *guard = None;
        }
    }
    for (_, ack) in pending_acks.drain() {
        let _ = ack.send(Err("private trade socket closed".to_string()));
    }
    emit_private_status(&app, Some(&account), "private closed", None, None);
    Ok(received_data)
}

fn handle_private_trade_response(
    text: &str,
    pending_acks: &mut HashMap<String, oneshot::Sender<Result<serde_json::Value, String>>>,
) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };
    let Some(op) = value.get("op").and_then(|item| item.as_str()) else {
        return false;
    };
    if !matches!(op, "order" | "batch-orders" | "cancel-order" | "batch-cancel-orders") {
        return false;
    }
    let Some(id) = value.get("id").and_then(|item| item.as_str()) else {
        return false;
    };
    if let Some(ack) = pending_acks.remove(id) {
        let code = value.get("code").and_then(|item| item.as_str()).unwrap_or("0");
        let msg = value.get("msg").and_then(|item| item.as_str()).unwrap_or_default();
        if code == "0" {
            let _ = ack.send(Ok(value));
        } else {
            let _ = ack.send(Err(format!("WS {} {} {}", op, code, msg)));
        }
        return true;
    }
    false
}

fn private_ws_login_payload(account: &LocalAccount) -> Result<serde_json::Value, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| err.to_string())?
        .as_secs()
        .to_string();
    let sign = okx_sign(&account.secret_key, &timestamp, "GET", "/users/self/verify", "")?;
    Ok(json!({
        "op": "login",
        "args": [{
            "apiKey": account.api_key,
            "passphrase": account.passphrase,
            "timestamp": timestamp,
            "sign": sign
        }]
    }))
}

fn private_login_succeeded(text: &str) -> Result<bool, String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Ok(false);
    };
    if value.get("event").and_then(|event| event.as_str()) != Some("login") {
        return Ok(false);
    }
    let code = value.get("code").and_then(|code| code.as_str()).unwrap_or_default();
    if code == "0" {
        return Ok(true);
    }
    let msg = value.get("msg").and_then(|msg| msg.as_str()).unwrap_or("登录失败");
    Err(format!("登录失败 {} {}", code, msg))
}

async fn ensure_private_trade_socket(
    runtime: &MarketRuntime,
    account: &LocalAccount,
) -> Result<mpsc::UnboundedSender<PrivateTradeCommand>, String> {
    let guard = runtime.private_trade.lock().await;
    let Some(handle) = guard.as_ref() else {
        return Err("private trade socket unavailable".to_string());
    };
    if handle.account_id != account.id || handle.environment != account.environment {
        return Err("private trade socket account mismatch".to_string());
    }
    Ok(handle.sender.clone())
}

async fn send_private_trade_command(
    runtime: &MarketRuntime,
    account: &LocalAccount,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let sender = ensure_private_trade_socket(runtime, account).await?;
    let message_id = payload
        .get("id")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "private trade command missing id".to_string())?
        .to_string();
    let (ack_tx, ack_rx) = oneshot::channel();
    sender
        .send(PrivateTradeCommand {
            message_id,
            payload,
            ack: ack_tx,
        })
        .map_err(|_| "private trade socket sender closed".to_string())?;
    timeout(Duration::from_secs(8), ack_rx)
        .await
        .map_err(|_| "private trade command timeout".to_string())?
        .map_err(|_| "private trade command ack dropped".to_string())?
}

fn handle_public_message(app: &tauri::AppHandle, runtime: &MarketRuntime, text: &str) -> PublicMessageAction {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return PublicMessageAction::Continue;
    };
    if let Some(event) = value.get("event").and_then(|event| event.as_str()) {
        if event == "error" {
            let message = value.get("msg").and_then(|msg| msg.as_str()).unwrap_or("public event error");
            emit_market(app, MarketEvent::Error { message: message.to_string() });
            return PublicMessageAction::Resubscribe;
        }
        return PublicMessageAction::Continue;
    }
    let channel = value
        .get("arg")
        .and_then(|arg| arg.get("channel"))
        .and_then(|channel| channel.as_str())
        .unwrap_or_default();
    let Some(data) = value.get("data").and_then(|data| data.as_array()) else {
        return PublicMessageAction::Continue;
    };

    match channel {
        "tickers" => {
            if let Some(raw) = data.first() {
                if let Ok(ticker) = serde_json::from_value::<Ticker>(raw.clone()) {
                    update_public_health(runtime, ticker.ts);
                    if let Ok(mut store) = runtime.store.lock() {
                        store.ticker = Some(ticker.clone());
                        store.tickers.insert(ticker.inst_id.clone(), ticker.clone());
                    }
                    emit_market(app, MarketEvent::Ticker { ticker });
                }
            }
        }
        "books" | "books5" => {
            if let Some(raw) = data.first() {
                if let Some(book) = normalize_orderbook(raw) {
                    let inst_id = value
                        .get("arg")
                        .and_then(|arg| arg.get("instId"))
                        .and_then(|item| item.as_str())
                        .map(|item| item.to_string());
                    update_public_health(runtime, book.ts);
                    if !orderbook_sequence_valid(runtime, raw, &book) {
                        clear_orderbook_state(runtime);
                        emit_market(app, MarketEvent::Error {
                            message: format!("盘口序列断裂，已重订阅 {}", book.seq_id.clone().unwrap_or_default()),
                        });
                        return PublicMessageAction::Resubscribe;
                    }
                    if let Ok(mut store) = runtime.store.lock() {
                        store.orderbook = Some(book.clone());
                        store.orderbook_inst_id = inst_id;
                        store.orderbook_seq_id = book.seq_id.as_deref().and_then(|value| value.parse::<i64>().ok());
                    }
                    emit_market(app, MarketEvent::OrderBook { book });
                }
            }
        }
        "trades" => {
            let inst_id = value
                .get("arg")
                .and_then(|arg| arg.get("instId"))
                .and_then(|item| item.as_str())
                .map(|item| item.to_string());
            for raw in data {
                if let Ok(trade) = serde_json::from_value::<Trade>(raw.clone()) {
                    update_public_health(runtime, trade.ts);
                    if let Ok(mut store) = runtime.store.lock() {
                        store.trades_inst_id = inst_id.clone();
                        store.trades.insert(0, trade.clone());
                        store.trades.truncate(200);
                    }
                    emit_market(app, MarketEvent::Trade { trade });
                }
            }
        }
        _ => {}
    }
    PublicMessageAction::Continue
}

fn handle_private_message(app: &tauri::AppHandle, runtime: &MarketRuntime, account: &LocalAccount, text: &str) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return;
    };
    if let Some(event) = value.get("event").and_then(|event| event.as_str()) {
        if event == "error" {
            let msg = value.get("msg").and_then(|msg| msg.as_str()).unwrap_or("private event error");
            emit_private_status(app, Some(account), msg, None, None);
        }
        return;
    }
    let channel = value
        .get("arg")
        .and_then(|arg| arg.get("channel"))
        .and_then(|channel| channel.as_str())
        .unwrap_or_default();
    let Some(data) = value.get("data").and_then(|data| data.as_array()) else {
        return;
    };
    let position_sequence = private_position_sequence(&value, data);
    let event_time_ms = data.iter().filter_map(private_message_timestamp).min();
    let delay_ms = event_time_ms.map(|ts| update_private_health(runtime, ts));
    let event_at = delay_ms.map(|_| current_okx_now_ms(runtime));
    emit_private_status(app, Some(account), format!("private data {}", channel), delay_ms, event_at);
    match channel {
        "account" => merge_account_update(app, runtime, data),
        "balance_and_position" => {
            merge_balance_position_update(app, runtime, data, position_sequence)
        }
        "positions" => {
            let positions = data
                .iter()
                .filter_map(|raw| serde_json::from_value::<OkxPosition>(raw.clone()).ok())
                .collect::<Vec<_>>();
            mutate_private_snapshot(app, runtime, |snapshot| {
                merge_private_position_delta(snapshot, &positions, position_sequence);
            });
        }
        "orders" => {
            let orders = data
                .iter()
                .filter_map(|raw| serde_json::from_value::<OkxPendingOrder>(raw.clone()).ok())
                .map(crate::market_ws::normalize_pending_order_identity)
                .filter(crate::market_ws::pending_order_has_identity)
                .collect::<Vec<_>>();
            mutate_private_snapshot(app, runtime, |snapshot| {
                for order in orders {
                    let state = order.state.to_lowercase();
                    if crate::market_ws::is_terminal_pending_order_state(&state) {
                        snapshot
                            .orders
                            .retain(|item| !crate::market_ws::pending_orders_match_identity(item, &order));
                    } else if let Some(existing) = snapshot
                        .orders
                        .iter_mut()
                        .find(|item| crate::market_ws::pending_orders_match_identity(item, &order))
                    {
                        *existing = order;
                    } else {
                        snapshot.orders.push(order);
                    }
                }
            });
        }
        _ => {}
    }
}

fn merge_account_update(app: &tauri::AppHandle, runtime: &MarketRuntime, data: &[serde_json::Value]) {
    mutate_private_snapshot(app, runtime, |snapshot| {
        for item in data {
            if let Some(details) = item.get("details").and_then(|value| value.as_array()) {
                for raw_balance in details {
                    if let Ok(balance) = serde_json::from_value::<OkxBalance>(raw_balance.clone()) {
                        if balance.ccy.is_empty() {
                            continue;
                        }
                        if let Some(existing) = snapshot.balances.iter_mut().find(|item| item.ccy == balance.ccy) {
                            *existing = balance;
                        } else {
                            snapshot.balances.push(balance);
                        }
                    }
                }
            }
        }
    });
}

fn merge_balance_position_update(
    app: &tauri::AppHandle,
    runtime: &MarketRuntime,
    data: &[serde_json::Value],
    sequence: PrivatePositionSequence,
) {
    mutate_private_snapshot(app, runtime, |snapshot| {
        let mut position_updates = Vec::new();
        for item in data {
            if let Some(balances) = item.get("balData").and_then(|value| value.as_array()) {
                for raw_balance in balances {
                    if let Ok(balance) = serde_json::from_value::<OkxBalance>(raw_balance.clone()) {
                        if balance.ccy.is_empty() {
                            continue;
                        }
                        if let Some(existing) = snapshot.balances.iter_mut().find(|item| item.ccy == balance.ccy) {
                            *existing = balance;
                        } else {
                            snapshot.balances.push(balance);
                        }
                    }
                }
            }
            if let Some(positions) = item.get("posData").and_then(|value| value.as_array()) {
                position_updates.extend(
                    positions
                        .iter()
                        .filter_map(|raw| serde_json::from_value::<OkxPosition>(raw.clone()).ok()),
                );
            }
        }
        merge_private_position_delta(snapshot, &position_updates, sequence);
    });
}

fn update_private_snapshot(app: &tauri::AppHandle, runtime: &MarketRuntime, mut snapshot: PrivateAccountSnapshot) {
    mark_private_snapshot_complete(&mut snapshot);
    snapshot.synced_at = now_ms();
    if let Ok(mut store) = runtime.store.lock() {
        store.private_snapshot = Some(snapshot.clone());
        store.private_snapshots.insert(
            format!(
                "{}:{}",
                normalize_environment(&snapshot.environment),
                snapshot.account_id
            ),
            snapshot.clone(),
        );
    }
    emit_market(app, MarketEvent::PrivateSnapshot { snapshot });
}

fn mutate_private_snapshot<F>(app: &tauri::AppHandle, runtime: &MarketRuntime, mutate: F)
where
    F: FnOnce(&mut PrivateAccountSnapshot),
{
    let mut updated = None;
    if let Ok(mut store) = runtime.store.lock() {
        if let Some(snapshot) = store.private_snapshot.as_mut() {
            mutate(snapshot);
            snapshot.synced_at = now_ms();
            updated = Some(snapshot.clone());
        }
        if let Some(snapshot) = updated.as_ref() {
            store.private_snapshots.insert(
                format!(
                    "{}:{}",
                    normalize_environment(&snapshot.environment),
                    snapshot.account_id
                ),
                snapshot.clone(),
            );
        }
    }
    if let Some(snapshot) = updated {
        emit_market(app, MarketEvent::PrivateSnapshot { snapshot });
    }
}

fn handle_business_message(app: &tauri::AppHandle, runtime: &MarketRuntime, text: &str, inst_id: &str, bar: &str) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return;
    };
    let expected = format!("candle{}", bar);
    let channel = value
        .get("arg")
        .and_then(|arg| arg.get("channel"))
        .and_then(|channel| channel.as_str())
        .unwrap_or_default();
    if channel != expected {
        return;
    }
    let Some(first) = value
        .get("data")
        .and_then(|data| data.as_array())
        .and_then(|items| items.first())
        .and_then(|row| row.as_array())
    else {
        return;
    };
    let row = first
        .iter()
        .map(|item| item.as_str().unwrap_or_default().to_string())
        .collect::<Vec<_>>();
    if let Some(raw_candle) = normalize_raw_candle(&row) {
        if let Ok(mut conn) = open_database(app) {
            let _ = upsert_raw_candles(&mut conn, inst_id, bar, &[raw_candle.clone()], "websocket");
        }
    }
    if let Some(candle) = normalize_candle(&row) {
        if let Ok(mut store) = runtime.store.lock() {
            store.candle = Some(candle.clone());
            store.candle_inst_id = Some(inst_id.to_string());
            store.candle_bar = Some(bar.to_string());
        }
        emit_market(app, MarketEvent::Candle { candle });
    }
}

fn normalize_orderbook(raw: &serde_json::Value) -> Option<OrderBook> {
    let bids = raw
        .get("bids")?
        .as_array()?
        .iter()
        .filter_map(normalize_level)
        .collect::<Vec<_>>();
    let asks = raw
        .get("asks")?
        .as_array()?
        .iter()
        .filter_map(normalize_level)
        .collect::<Vec<_>>();
    let ts = raw.get("ts")?.as_str()?.parse::<i64>().ok()?;
    let seq_id = raw
        .get("seqId")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    Some(OrderBook { bids, asks, ts, seq_id })
}

fn orderbook_sequence_valid(runtime: &MarketRuntime, raw: &serde_json::Value, book: &OrderBook) -> bool {
    let Some(seq_id) = book.seq_id.as_deref().and_then(|value| value.parse::<i64>().ok()) else {
        return true;
    };
    let prev_seq_id = raw
        .get("prevSeqId")
        .and_then(|value| value.as_str())
        .and_then(|value| value.parse::<i64>().ok());
    let previous = runtime.store.lock().ok().and_then(|store| store.orderbook_seq_id);
    if previous.is_none() || matches!(prev_seq_id, None | Some(-1) | Some(0)) {
        return true;
    }
    prev_seq_id == previous && seq_id >= previous.unwrap_or(seq_id)
}

fn clear_orderbook_state(runtime: &MarketRuntime) {
    if let Ok(mut store) = runtime.store.lock() {
        store.orderbook = None;
        store.orderbook_inst_id = None;
        store.orderbook_seq_id = None;
    }
}

fn normalize_level(raw: &serde_json::Value) -> Option<OrderBookLevel> {
    let values = raw.as_array()?;
    Some(OrderBookLevel {
        px: values.get(0)?.as_str()?.to_string(),
        sz: values.get(1)?.as_str()?.to_string(),
        orders: values.get(3).and_then(|value| value.as_str()).map(|value| value.to_string()),
    })
}

fn emit_market(app: &tauri::AppHandle, event: MarketEvent) {
    let _ = app.emit(MARKET_EVENT, event);
}

fn current_okx_now_ms(runtime: &MarketRuntime) -> i64 {
    let offset = runtime
        .health
        .lock()
        .ok()
        .and_then(|health| health.clock_offset_ms)
        .unwrap_or_default();
    now_ms().saturating_add(offset)
}

fn update_public_health(runtime: &MarketRuntime, event_time_ms: i64) -> i64 {
    let okx_now = current_okx_now_ms(runtime);
    let delay = okx_now.saturating_sub(event_time_ms).max(0);
    if let Ok(mut health) = runtime.health.lock() {
        health.public_event_time_ms = Some(event_time_ms);
        health.public_delay_ms = Some(delay);
        health.public_updated_at_ms = Some(now_ms());
    }
    delay
}

fn update_private_health(runtime: &MarketRuntime, event_time_ms: i64) -> i64 {
    let okx_now = current_okx_now_ms(runtime);
    let delay = okx_now.saturating_sub(event_time_ms).max(0);
    if let Ok(mut health) = runtime.health.lock() {
        health.private_event_time_ms = Some(event_time_ms);
        health.private_delay_ms = Some(delay);
        health.private_updated_at_ms = Some(now_ms());
    }
    delay
}

fn market_health_blockers(runtime: &MarketRuntime, environment: &str) -> Vec<String> {
    let _ = (runtime, environment);
    Vec::new()
}

fn emit_private_status<S: Into<String>>(
    app: &tauri::AppHandle,
    account: Option<&LocalAccount>,
    status: S,
    delay_ms: Option<i64>,
    event_at: Option<i64>,
) {
    emit_market(
        app,
        MarketEvent::PrivateStatus {
            status: status.into(),
            account_id: account.map(|item| item.id.clone()),
            environment: account.map(|item| item.environment.clone()),
            delay_ms,
            event_at: event_at.unwrap_or_else(now_ms),
        },
    );
}

fn private_message_timestamp(value: &serde_json::Value) -> Option<i64> {
    for key in ["uTime", "ts", "cTime"] {
        if let Some(ts) = value.get(key).and_then(|item| item.as_str()).and_then(|item| item.parse::<i64>().ok()) {
            return Some(ts);
        }
    }
    for nested_key in ["balData", "posData"] {
        if let Some(ts) = value
            .get(nested_key)
            .and_then(|item| item.as_array())
            .and_then(|items| items.iter().filter_map(private_message_timestamp).min())
        {
            return Some(ts);
        }
    }
    None
}

fn normalize_watchlist(watchlist: Option<Vec<String>>, active: &str) -> Vec<String> {
    let mut symbols = watchlist.unwrap_or_default();
    symbols.push(active.to_string());
    symbols.retain(|symbol| !symbol.trim().is_empty());
    symbols.sort();
    symbols.dedup();
    symbols.truncate(10);
    symbols
}
*/

fn normalize_symbols(symbols: Vec<String>) -> Vec<String> {
    let mut values = symbols
        .into_iter()
        .map(|symbol| symbol.trim().to_uppercase())
        .filter(|symbol| !symbol.is_empty())
        .collect::<Vec<_>>();
    values.sort();
    values.dedup();
    values.truncate(10);
    if values.is_empty() {
        values.push("BTC-USDT-SWAP".to_string());
    }
    values
}

fn normalize_intervals(intervals: Option<Vec<String>>) -> Vec<String> {
    let mut values = intervals.unwrap_or_else(default_kline_intervals);
    values.retain(|bar| bar_ms(bar).is_some());
    values.sort_by_key(|bar| bar_ms(bar).unwrap_or(i64::MAX));
    values.dedup();
    if values.is_empty() {
        values = default_kline_intervals();
    }
    let values = values
        .into_iter()
        .filter(|bar| bar == "1m")
        .collect::<Vec<_>>();
    if values.is_empty() {
        default_kline_intervals()
    } else {
        values
    }
}

fn default_kline_intervals() -> Vec<String> {
    vec!["1m".to_string()]
}

fn bar_ms(bar: &str) -> Option<i64> {
    match bar {
        "1m" => Some(60_000),
        "3m" => Some(3 * 60_000),
        "5m" => Some(5 * 60_000),
        "15m" => Some(15 * 60_000),
        "30m" => Some(30 * 60_000),
        "1H" => Some(60 * 60_000),
        "2H" => Some(2 * 60 * 60_000),
        "4H" => Some(4 * 60 * 60_000),
        "6H" => Some(6 * 60 * 60_000),
        "12H" => Some(12 * 60 * 60_000),
        "1D" => Some(24 * 60 * 60_000),
        _ => None,
    }
}

fn retention_days(bar: &str) -> i64 {
    match bar {
        "1m" => 365,
        "3m" => 3,
        "5m" => 7,
        "15m" => 14,
        "30m" => 30,
        "1H" => 60,
        "2H" => 120,
        "4H" | "6H" => 365,
        "12H" | "1D" => 730,
        _ => 7,
    }
}

fn normalize_required_days(required_days: Option<HashMap<String, i64>>) -> HashMap<String, i64> {
    required_days
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(bar, days)| {
            if bar_ms(&bar).is_some() && days > 0 {
                Some((bar, days.min(730)))
            } else {
                None
            }
        })
        .collect()
}

fn required_days_for_interval(required_days: &HashMap<String, i64>, interval: &str) -> i64 {
    required_days
        .get(interval)
        .copied()
        .filter(|days| *days > 0)
        .unwrap_or_else(|| retention_days(interval))
}

#[derive(Debug)]
struct KlineDatabaseScan {
    existing: Vec<i64>,
    invalid_reasons: Vec<String>,
}

async fn run_kline_database_blocking<T, F>(
    app: &tauri::AppHandle,
    operation: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut Connection) -> Result<T, String> + Send + 'static,
{
    let app = app.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = open_database(&app)?;
        operation(&mut conn)
    })
    .await
    .map_err(|error| format!("K 线数据库任务失败：{error}"))?
}

async fn run_kline_read_database_blocking<T, F>(
    app: &tauri::AppHandle,
    operation: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&Connection) -> Result<T, String> + Send + 'static,
{
    let app = app.clone();
    tokio::task::spawn_blocking(move || {
        let conn = open_read_database(&app)?;
        operation(&conn)
    })
    .await
    .map_err(|error| format!("K 线只读数据库任务失败：{error}"))?
}

async fn scan_kline_window(
    app: &tauri::AppHandle,
    symbol: &str,
    interval: &str,
    start_open: i64,
    end_open: i64,
    strict_confirm_before: i64,
) -> Result<KlineDatabaseScan, String> {
    let symbol = symbol.to_string();
    let interval = interval.to_string();
    run_kline_read_database_blocking(app, move |conn| {
        Ok(KlineDatabaseScan {
            existing: existing_open_times(conn, &symbol, &interval, start_open, end_open)?,
            invalid_reasons: existing_invalid_candle_reasons(
                conn,
                &symbol,
                &interval,
                start_open,
                end_open,
                strict_confirm_before,
            )?,
        })
    })
    .await
}

async fn write_kline_candles(
    app: &tauri::AppHandle,
    symbol: &str,
    interval: &str,
    candles: Vec<RawCandle>,
    source: &str,
) -> Result<usize, String> {
    let symbol = symbol.to_string();
    let interval = interval.to_string();
    let source = source.to_string();
    run_kline_database_blocking(app, move |conn| {
        upsert_raw_candles(conn, &symbol, &interval, &candles, &source)
    })
    .await
}

async fn confirm_kline_candles(
    app: &tauri::AppHandle,
    symbol: &str,
    interval: &str,
    open_times: Vec<i64>,
    strict_confirm_before: i64,
) -> Result<usize, String> {
    if open_times.is_empty() {
        return Ok(0);
    }
    let symbol = symbol.to_string();
    let interval = interval.to_string();
    run_kline_database_blocking(app, move |conn| {
        confirm_stale_unconfirmed_candles(
            conn,
            &symbol,
            &interval,
            &open_times,
            strict_confirm_before,
        )
    })
    .await
}

async fn persist_kline_sync_report(
    app: &tauri::AppHandle,
    mut report: KlineSyncReport,
) -> Result<KlineSyncReport, String> {
    run_kline_database_blocking(app, move |conn| {
        apply_kline_retry_state(conn, &mut report);
        insert_kline_sync_run(conn, &report)?;
        Ok(report)
    })
    .await
}

async fn sync_kline_set(
    app: tauri::AppHandle,
    symbols: Vec<String>,
    intervals: Vec<String>,
    recent_hours: Option<i64>,
    required_days: HashMap<String, i64>,
    reserved: &HashSet<KlineSyncKey>,
) -> Vec<KlineSyncReport> {
    let mut reports = Vec::new();
    for symbol in symbols {
        for interval in &intervals {
            if !reserved.contains(&KlineSyncKey {
                symbol: symbol.clone(),
                interval: interval.clone(),
            }) {
                continue;
            }
            let interval_required_days = required_days_for_interval(&required_days, interval);
            let report = match sync_one_kline_range(
                &app,
                &symbol,
                interval,
                recent_hours,
                interval_required_days,
            )
            .await
            {
                Ok(report) => report,
                Err(message) => {
                    let report = KlineSyncReport {
                        symbol: symbol.clone(),
                        interval: interval.clone(),
                        status: "failed".to_string(),
                        expected: 0,
                        existing: 0,
                        missing: 0,
                        invalid: 0,
                        invalid_reasons: Vec::new(),
                        attempt: 1,
                        retry_state: "pending_retry".to_string(),
                        retry_after: Some(now_ms() + 60_000),
                        fetched: 0,
                        inserted: 0,
                        started_at: now_ms(),
                        finished_at: Some(now_ms()),
                        message,
                        progress_detail: None,
                    };
                    persist_kline_sync_report(&app, report.clone())
                        .await
                        .unwrap_or(report)
                }
            };
            emit_kline_sync(&app, &report);
            reports.push(report);
        }
    }
    reports
}

async fn sync_one_kline_range(
    app: &tauri::AppHandle,
    symbol: &str,
    interval: &str,
    recent_hours: Option<i64>,
    required_days: i64,
) -> Result<KlineSyncReport, String> {
    let step = bar_ms(interval).ok_or_else(|| format!("unsupported interval {}", interval))?;
    let end_open = align_open_time(now_ms(), interval, step).saturating_sub(step);
    let lookback_ms = recent_hours
        .map(|hours| hours * 60 * 60_000)
        .unwrap_or_else(|| required_days.max(1) * 86_400_000);
    let start_open = align_open_time(end_open.saturating_sub(lookback_ms), interval, step);
    sync_kline_window(app, symbol, interval, start_open, end_open).await
}

/// Synchronizes one exact, closed K-line window. Historical consumers such as
/// reproducible backtests use this rather than a rolling retention window so
/// a repair touches only the bars that are actually part of the snapshot.
async fn sync_kline_window(
    app: &tauri::AppHandle,
    symbol: &str,
    interval: &str,
    start_open: i64,
    end_open: i64,
) -> Result<KlineSyncReport, String> {
    let step = bar_ms(interval).ok_or_else(|| format!("unsupported interval {}", interval))?;
    let start_open = align_open_time(start_open, interval, step);
    let end_open = align_open_time(end_open, interval, step);
    if end_open < start_open {
        return Err("K-line synchronization range must end after it starts".to_string());
    }

    let started_at = now_ms();
    let expected = expected_open_times(start_open, end_open, step);

    let mut report = KlineSyncReport {
        symbol: symbol.to_string(),
        interval: interval.to_string(),
        status: "scanning".to_string(),
        expected: expected.len(),
        existing: 0,
        missing: 0,
        invalid: 0,
        invalid_reasons: Vec::new(),
        attempt: 1,
        retry_state: "none".to_string(),
        retry_after: None,
        fetched: 0,
        inserted: 0,
        started_at,
        finished_at: None,
        message: "扫描本地 K 线完整性".to_string(),
        progress_detail: None,
    };
    emit_kline_sync(app, &report);

    let strict_confirm_before = end_open - step;
    let initial_scan = scan_kline_window(
        app,
        symbol,
        interval,
        start_open,
        end_open,
        strict_confirm_before,
    )
    .await?;
    let existing = initial_scan.existing;
    report.existing = existing.len();
    report.invalid_reasons = initial_scan.invalid_reasons;
    report.invalid = report.invalid_reasons.len();
    let missing = expected
        .iter()
        .filter(|open_time| !existing.binary_search(open_time).is_ok())
        .copied()
        .collect::<Vec<_>>();
    report.missing = missing.len();
    if missing.is_empty() {
        let mut repaired_invalid = false;
        if report.invalid > 0 {
            let invalid_open_times = invalid_reason_open_times(&report.invalid_reasons);
            if !invalid_open_times.is_empty() {
                repaired_invalid = true;
                report.status = "backfilling".to_string();
                report.message = format!(
                    "发现 {} 条异常 K 线，开始重新拉取覆盖",
                    invalid_open_times.len()
                );
                emit_kline_sync(app, &report);
                for (from, to) in missing_ranges(&invalid_open_times, step) {
                    let repair_from = from.saturating_sub(step);
                    let repair_to = to + step;
                    let raw = fetch_repair_candles(
                        app,
                        &mut report,
                        symbol,
                        interval,
                        repair_from,
                        repair_to,
                    )
                    .await?;
                    report.fetched += raw.len();
                    report.inserted += write_kline_candles(
                        app,
                        symbol,
                        interval,
                        raw,
                        "history-repair",
                    )
                    .await?;
                }
                let stale_unconfirmed =
                    stale_unconfirmed_reason_open_times(&report.invalid_reasons);
                report.inserted += confirm_kline_candles(
                    app,
                    symbol,
                    interval,
                    stale_unconfirmed,
                    strict_confirm_before,
                )
                .await?;
                let rechecked = scan_kline_window(
                    app,
                    symbol,
                    interval,
                    start_open,
                    end_open,
                    strict_confirm_before,
                )
                .await?;
                report.invalid_reasons = rechecked.invalid_reasons;
                report.invalid = report.invalid_reasons.len();
                report.message = if report.invalid == 0 {
                    "异常 K 线已重新拉取并确认".to_string()
                } else {
                    format!("异常 K 线已重新拉取，仍有 {} 条待确认", report.invalid)
                };
            }
        }
        report.status = if report.invalid == 0 {
            "complete"
        } else {
            "partial"
        }
        .to_string();
        report.finished_at = Some(now_ms());
        report.progress_detail = None;
        if !repaired_invalid {
            report.message = if report.invalid == 0 {
                "K 线完整，无需补洞".to_string()
            } else {
                format!("K 线无缺口，但发现 {} 条异常数据", report.invalid)
            };
        }
        return persist_kline_sync_report(app, report).await;
    }

    report.status = "backfilling".to_string();
    report.message = format!("发现 {} 根缺失 K 线，开始补齐", missing.len());
    emit_kline_sync(app, &report);

    for (from, to) in missing_ranges(&missing, step) {
        let raw = fetch_repair_candles(app, &mut report, symbol, interval, from, to).await?;
        for candle in &raw {
            report.invalid_reasons.extend(validate_raw_candle(
                interval,
                candle,
                step,
                Some(strict_confirm_before),
            ));
        }
        report.invalid = report.invalid_reasons.len();
        report.fetched += raw.len();
        report.inserted += write_kline_candles(app, symbol, interval, raw, "history").await?;
        report.message = format!("补齐中：已写入 {} 根", report.inserted);
        emit_kline_sync(app, &report);
    }

    let stale_unconfirmed = stale_unconfirmed_reason_open_times(&report.invalid_reasons);
    report.inserted += confirm_kline_candles(
        app,
        symbol,
        interval,
        stale_unconfirmed,
        strict_confirm_before,
    )
    .await?;

    let final_scan = scan_kline_window(
        app,
        symbol,
        interval,
        start_open,
        end_open,
        strict_confirm_before,
    )
    .await?;
    let existing_after = final_scan.existing;
    let remaining = expected
        .iter()
        .filter(|open_time| !existing_after.binary_search(open_time).is_ok())
        .count();
    report.existing = existing_after.len();
    report.missing = remaining;
    report.invalid_reasons = final_scan.invalid_reasons;
    report.invalid = report.invalid_reasons.len();
    report.progress_detail = None;
    report.status = if remaining == 0 && report.invalid == 0 {
        "complete"
    } else {
        "partial"
    }
    .to_string();
    report.finished_at = Some(now_ms());
    report.message = if remaining == 0 && report.invalid == 0 {
        "K 线补齐完成".to_string()
    } else if remaining == 0 {
        format!("K 线补齐完成，但发现 {} 条异常数据", report.invalid)
    } else {
        format!("仍有 {} 根 K 线缺失，等待下次补齐", remaining)
    };
    persist_kline_sync_report(app, report).await
}

fn kline_open_offset_ms(bar: &str, step_ms: i64) -> i64 {
    let _ = (bar, step_ms);
    0
}

fn align_open_time(value_ms: i64, bar: &str, step_ms: i64) -> i64 {
    let offset = kline_open_offset_ms(bar, step_ms);
    value_ms - (value_ms - offset).rem_euclid(step_ms)
}

fn expected_open_times(start_open: i64, end_open: i64, step: i64) -> Vec<i64> {
    let mut values = Vec::new();
    let mut cursor = start_open;
    while cursor <= end_open {
        values.push(cursor);
        cursor += step;
    }
    values
}

fn missing_ranges(missing: &[i64], step: i64) -> Vec<(i64, i64)> {
    if missing.is_empty() {
        return Vec::new();
    }
    let mut ranges = Vec::new();
    let mut start = missing[0];
    let mut prev = missing[0];
    for open_time in missing.iter().skip(1).copied() {
        if open_time == prev + step {
            prev = open_time;
        } else {
            ranges.push((start, prev));
            start = open_time;
            prev = open_time;
        }
    }
    ranges.push((start, prev));
    ranges
}

fn invalid_reason_open_times(reasons: &[String]) -> Vec<i64> {
    let mut values = reasons
        .iter()
        .filter_map(|reason| {
            reason.split_whitespace().rev().find_map(|part| {
                part.trim_matches(|ch: char| !ch.is_ascii_digit())
                    .parse::<i64>()
                    .ok()
            })
        })
        .collect::<Vec<_>>();
    values.sort_unstable();
    values.dedup();
    values
}

fn stale_unconfirmed_reason_open_times(reasons: &[String]) -> Vec<i64> {
    let mut values = reasons
        .iter()
        .filter(|reason| reason.contains("历史K线长期未确认"))
        .filter_map(|reason| {
            reason.split_whitespace().rev().find_map(|part| {
                part.trim_matches(|ch: char| !ch.is_ascii_digit())
                    .parse::<i64>()
                    .ok()
            })
        })
        .collect::<Vec<_>>();
    values.sort_unstable();
    values.dedup();
    values
}

fn confirm_stale_unconfirmed_candles(
    conn: &Connection,
    symbol: &str,
    interval: &str,
    open_times: &[i64],
    strict_confirm_before: i64,
) -> Result<usize, String> {
    let mut changed = 0usize;
    for open_time in open_times
        .iter()
        .copied()
        .filter(|open_time| *open_time < strict_confirm_before)
    {
        changed += conn
            .execute(
                "UPDATE candles
                 SET confirm = 1,
                     source = CASE WHEN source = 'websocket' THEN 'websocket-confirmed' ELSE source END,
                     updated_at = ?1
                 WHERE symbol = ?2 AND interval = ?3 AND open_time = ?4 AND confirm = 0",
                params![now_ms(), symbol, interval, open_time],
            )
            .map_err(|err| err.to_string())?;
    }
    Ok(changed)
}

fn upsert_okx_history_orders(
    conn: &mut Connection,
    account: &LocalAccount,
    source_endpoint: &str,
    rows: &[serde_json::Value],
) -> Result<usize, String> {
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let synced_at = now_ms();
    let mut count = 0;
    for row in rows {
        let stored_row = private_exchange_json(row)?;
        let Some(ord_id) = json_string(row, "ordId").filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        tx.execute(
            "INSERT INTO okx_orders (
              account_id, environment, ord_id, cl_ord_id, inst_id, inst_type, side, pos_side, td_mode, ord_type,
              state, px, sz, acc_fill_sz, avg_px, pnl, fee, source_endpoint, operator, strategy_id,
              session_id, okx_ctime, okx_utime, raw_json, synced_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, 'user', NULL, NULL, ?19, ?20, ?21, ?22)
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
              avg_px=excluded.avg_px,
              pnl=excluded.pnl,
              fee=excluded.fee,
              source_endpoint=excluded.source_endpoint,
              operator=CASE
                WHEN okx_orders.operator IS NULL OR okx_orders.operator = '' OR okx_orders.operator = 'unknown'
                THEN excluded.operator
                ELSE okx_orders.operator
              END,
              strategy_id=COALESCE(okx_orders.strategy_id, excluded.strategy_id),
              session_id=COALESCE(okx_orders.session_id, excluded.session_id),
              okx_ctime=excluded.okx_ctime,
              okx_utime=excluded.okx_utime,
              raw_json=excluded.raw_json,
              synced_at=excluded.synced_at",
            params![
                account.id,
                account.environment,
                ord_id,
                json_string(row, "clOrdId"),
                json_string(row, "instId").unwrap_or_default(),
                json_string(row, "instType").unwrap_or_default(),
                json_string(row, "side"),
                json_string(row, "posSide"),
                json_string(row, "tdMode"),
                json_string(row, "ordType"),
                json_string(row, "state"),
                json_string(row, "px"),
                json_string(row, "sz"),
                json_string(row, "accFillSz"),
                json_string(row, "avgPx"),
                json_string(row, "pnl"),
                json_string(row, "fee"),
                source_endpoint,
                json_i64(row, "cTime"),
                json_i64(row, "uTime"),
                &stored_row,
                synced_at
            ],
        )
        .map_err(|err| err.to_string())?;
        if let Some(cl_ord_id) =
            json_string(row, "clOrdId").filter(|value| !value.trim().is_empty())
        {
            tx.execute(
                "UPDATE okx_orders
                 SET state=COALESCE(NULLIF(?5, ''), state),
                     px=COALESCE(NULLIF(?6, ''), px),
                     sz=COALESCE(NULLIF(?7, ''), sz),
                     acc_fill_sz=COALESCE(NULLIF(?8, ''), acc_fill_sz),
                     avg_px=COALESCE(NULLIF(?9, ''), avg_px),
                     pnl=COALESCE(NULLIF(?10, ''), pnl),
                     fee=COALESCE(NULLIF(?11, ''), fee),
                     source_endpoint=?12,
                     okx_ctime=COALESCE(?13, okx_ctime),
                     okx_utime=COALESCE(?14, okx_utime),
                     raw_json=?15,
                     synced_at=?16
                 WHERE account_id=?1
                   AND environment=?2
                   AND cl_ord_id=?3
                   AND ord_id<>?4",
                params![
                    account.id,
                    account.environment,
                    cl_ord_id,
                    ord_id,
                    json_string(row, "state"),
                    json_string(row, "px"),
                    json_string(row, "sz"),
                    json_string(row, "accFillSz"),
                    json_string(row, "avgPx"),
                    json_string(row, "pnl"),
                    json_string(row, "fee"),
                    source_endpoint,
                    json_i64(row, "cTime"),
                    json_i64(row, "uTime"),
                    &stored_row,
                    synced_at
                ],
            )
            .map_err(|err| err.to_string())?;
        }
        if let Some(next_status) = opportunity_status_from_order_state(
            json_string(row, "state").as_deref(),
            json_string(row, "accFillSz").as_deref(),
        ) {
            let cl_ord_id = json_string(row, "clOrdId").unwrap_or_default();
            let opportunity_id = tx
                .query_row(
                    "SELECT opportunity_id FROM okx_orders
                     WHERE account_id=?1 AND environment=?2
                       AND (ord_id=?3 OR (?4<>'' AND cl_ord_id=?4))
                       AND opportunity_id IS NOT NULL
                     ORDER BY synced_at DESC LIMIT 1",
                    params![account.id, account.environment, ord_id, cl_ord_id],
                    |db_row| db_row.get::<_, String>(0),
                )
                .optional()
                .map_err(|err| err.to_string())?;
            if let Some(opportunity_id) = opportunity_id {
                let changed = tx
                    .execute(
                        "UPDATE trade_opportunities SET status=?2,error=NULL,updated_at=?3
                     WHERE id=?1 AND status IN ('executing','submitted','partially_filled')",
                        params![opportunity_id, next_status, synced_at],
                    )
                    .map_err(|err| err.to_string())?;
                if changed == 1 {
                    let _ = crate::ai_automation::record_domain_event_with_conn(
                        &tx,
                        &desic_agent_automation::DomainEvent {
                            event_type: "opportunity_state_changed".to_string(),
                            account_id: Some(account.id.clone()),
                            inst_id: json_string(row, "instId"),
                            opportunity_id: Some(opportunity_id),
                            state: Some(next_status.to_string()),
                            occurred_at: json_i64(row, "uTime").unwrap_or(synced_at),
                            ..Default::default()
                        },
                        json!({ "ordId": ord_id, "clOrdId": cl_ord_id, "source": source_endpoint }),
                    );
                }
            }
        }
        count += 1;
    }
    tx.commit().map_err(|err| err.to_string())?;
    Ok(count)
}

fn persist_private_order_updates(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    orders: &[OkxPendingOrder],
) -> Result<usize, String> {
    if orders.is_empty() {
        return Ok(0);
    }
    let rows = orders
        .iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    let mut conn = open_database(app)?;
    upsert_okx_history_orders(&mut conn, account, "private-wss", &rows)
}

fn opportunity_status_from_order_state(
    state: Option<&str>,
    accumulated_fill: Option<&str>,
) -> Option<&'static str> {
    let state = state.unwrap_or_default().trim().to_ascii_lowercase();
    let has_fill = accumulated_fill
        .and_then(|value| value.trim().parse::<f64>().ok())
        .is_some_and(|value| value > 0.0);
    match state.as_str() {
        "live" | "submitted" | "effective" => Some(if has_fill {
            "partially_filled"
        } else {
            "submitted"
        }),
        "partially_filled" | "partially-filled" => Some("partially_filled"),
        "filled" => Some("executed"),
        "canceled" | "cancelled" | "mmp_canceled" | "order_failed" => {
            Some(if has_fill { "executed" } else { "cancelled" })
        }
        _ => None,
    }
}

fn normalize_trade_operator(value: Option<&String>) -> String {
    match value
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
    {
        Some("ai") => "ai".to_string(),
        Some("strategy") => "strategy".to_string(),
        Some("system") => "system".to_string(),
        Some("user") => "user".to_string(),
        Some(_) => "user".to_string(),
        None => "user".to_string(),
    }
}

fn optional_non_empty(value: &Option<String>) -> Option<String> {
    value
        .as_ref()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

fn upsert_submitted_order(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    request: &PlaceOrderRequest,
    body: &PlaceOrderBody,
    result: &OkxOrderResult,
    side: &str,
    pos_side: &str,
    operator: &str,
) -> Result<(), String> {
    let conn = open_database(app)?;
    let ord_id = if result.ord_id.trim().is_empty() {
        result.cl_ord_id.clone()
    } else {
        result.ord_id.clone()
    };
    if ord_id.trim().is_empty() {
        return Ok(());
    }
    let now = now_ms();
    let raw_json = private_exchange_json(&json!({
        "submitRequest": {
            "instId": request.inst_id,
            "tdMode": request.td_mode,
            "orderType": request.order_type,
            "ticketMode": request.ticket_mode,
            "action": request.action,
            "price": request.price,
            "size": request.size,
            "lever": request.lever,
            "environment": request.environment,
            "operator": operator,
            "strategyId": optional_non_empty(&request.strategy_id),
            "sessionId": optional_non_empty(&request.session_id),
            "opportunityId": optional_non_empty(&request.opportunity_id),
            "agentRunId": optional_non_empty(&request.agent_run_id),
            "executionKey": optional_non_empty(&request.execution_key),
        },
        "okxBody": body,
        "okxResult": result,
    }))?;
    conn.execute(
        "INSERT INTO okx_orders (
          account_id, environment, ord_id, cl_ord_id, inst_id, inst_type, side, pos_side, td_mode, ord_type,
          state, px, sz, acc_fill_sz, avg_px, pnl, fee, source_endpoint, operator, strategy_id,
          session_id, opportunity_id, agent_run_id, execution_key, okx_ctime, okx_utime, raw_json, synced_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'SWAP', ?6, ?7, ?8, ?9, 'submitted', ?10, ?11, '0', NULL, NULL, NULL, 'local-submit', ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
        ON CONFLICT(account_id, environment, ord_id) DO UPDATE SET
          cl_ord_id=COALESCE(excluded.cl_ord_id, okx_orders.cl_ord_id),
          inst_id=excluded.inst_id,
          inst_type=excluded.inst_type,
          side=excluded.side,
          pos_side=excluded.pos_side,
          td_mode=excluded.td_mode,
          ord_type=excluded.ord_type,
          state=CASE
            WHEN okx_orders.state IS NULL OR okx_orders.state = '' OR okx_orders.state = 'submitted'
            THEN excluded.state
            ELSE okx_orders.state
          END,
          px=excluded.px,
          sz=excluded.sz,
          source_endpoint=excluded.source_endpoint,
          operator=excluded.operator,
          strategy_id=excluded.strategy_id,
          session_id=excluded.session_id,
          opportunity_id=COALESCE(excluded.opportunity_id, okx_orders.opportunity_id),
          agent_run_id=COALESCE(excluded.agent_run_id, okx_orders.agent_run_id),
          execution_key=COALESCE(excluded.execution_key, okx_orders.execution_key),
          okx_ctime=COALESCE(okx_orders.okx_ctime, excluded.okx_ctime),
          okx_utime=excluded.okx_utime,
          raw_json=excluded.raw_json,
          synced_at=excluded.synced_at",
        params![
            account.id,
            account.environment,
            ord_id,
            result.cl_ord_id,
            request.inst_id,
            side,
            pos_side,
            request.td_mode,
            body.ord_type,
            body.px.clone(),
            request.size,
            operator,
            optional_non_empty(&request.strategy_id),
            optional_non_empty(&request.session_id),
            optional_non_empty(&request.opportunity_id),
            optional_non_empty(&request.agent_run_id),
            optional_non_empty(&request.execution_key),
            result.ts.parse::<i64>().ok().unwrap_or(now),
            now,
            raw_json,
            now,
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn upsert_submitted_algo_order(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    request: &PlaceOrderRequest,
    body: &PlaceAlgoOrderBody,
    result: &OkxAlgoOrderResult,
    side: &str,
    pos_side: &str,
    operator: &str,
) -> Result<(), String> {
    let conn = open_database(app)?;
    let ord_id = if result.algo_id.trim().is_empty() {
        result.algo_cl_ord_id.clone()
    } else {
        result.algo_id.clone()
    };
    if ord_id.trim().is_empty() {
        return Ok(());
    }
    let now = now_ms();
    let raw_json = private_exchange_json(&json!({
        "submitRequest": {
            "instId": request.inst_id,
            "tdMode": request.td_mode,
            "orderType": request.order_type,
            "ticketMode": request.ticket_mode,
            "action": request.action,
            "triggerPx": request.price,
            "size": request.size,
            "lever": request.lever,
            "environment": request.environment,
            "operator": operator,
            "strategyId": optional_non_empty(&request.strategy_id),
            "sessionId": optional_non_empty(&request.session_id),
            "opportunityId": optional_non_empty(&request.opportunity_id),
            "agentRunId": optional_non_empty(&request.agent_run_id),
            "executionKey": optional_non_empty(&request.execution_key),
        },
        "okxBody": body,
        "okxResult": result,
    }))?;
    conn.execute(
        "INSERT INTO okx_orders (
          account_id, environment, ord_id, cl_ord_id, inst_id, inst_type, side, pos_side, td_mode, ord_type,
          state, px, sz, acc_fill_sz, avg_px, pnl, fee, source_endpoint, operator, strategy_id,
          session_id, opportunity_id, agent_run_id, execution_key, okx_ctime, okx_utime, raw_json, synced_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'SWAP', ?6, ?7, ?8, ?9, 'submitted', ?10, ?11, '0', NULL, NULL, NULL, 'local-algo-submit', ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
        ON CONFLICT(account_id, environment, ord_id) DO UPDATE SET
          cl_ord_id=COALESCE(excluded.cl_ord_id, okx_orders.cl_ord_id),
          inst_id=excluded.inst_id,
          inst_type=excluded.inst_type,
          side=excluded.side,
          pos_side=excluded.pos_side,
          td_mode=excluded.td_mode,
          ord_type=excluded.ord_type,
          state=CASE
            WHEN okx_orders.state IS NULL OR okx_orders.state = '' OR okx_orders.state = 'submitted'
            THEN excluded.state
            ELSE okx_orders.state
          END,
          px=excluded.px,
          sz=excluded.sz,
          source_endpoint=excluded.source_endpoint,
          operator=excluded.operator,
          strategy_id=excluded.strategy_id,
          session_id=excluded.session_id,
          opportunity_id=COALESCE(excluded.opportunity_id, okx_orders.opportunity_id),
          agent_run_id=COALESCE(excluded.agent_run_id, okx_orders.agent_run_id),
          execution_key=COALESCE(excluded.execution_key, okx_orders.execution_key),
          okx_ctime=COALESCE(okx_orders.okx_ctime, excluded.okx_ctime),
          okx_utime=excluded.okx_utime,
          raw_json=excluded.raw_json,
          synced_at=excluded.synced_at",
        params![
            account.id,
            account.environment,
            ord_id,
            result.algo_cl_ord_id,
            request.inst_id,
            side,
            pos_side,
            request.td_mode,
            body.ord_type,
            body.trigger_px.as_ref().or(body.active_px.as_ref()),
            request.size,
            operator,
            optional_non_empty(&request.strategy_id),
            optional_non_empty(&request.session_id),
            optional_non_empty(&request.opportunity_id),
            optional_non_empty(&request.agent_run_id),
            optional_non_empty(&request.execution_key),
            result.ts.parse::<i64>().ok().unwrap_or(now),
            now,
            raw_json,
            now,
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

#[derive(Debug, Default)]
struct CancelTarget {
    is_algo: bool,
    ord_id: Option<String>,
    cl_ord_id: Option<String>,
}

fn resolve_cancel_target(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    request: &CancelOrderRequest,
) -> Result<CancelTarget, String> {
    let direct_algo_id = optional_non_empty(&request.algo_id);
    let direct_algo_cl_ord_id = optional_non_empty(&request.algo_cl_ord_id);
    if request.is_algo.unwrap_or(false)
        || direct_algo_id.is_some()
        || direct_algo_cl_ord_id.is_some()
    {
        return Ok(CancelTarget {
            is_algo: true,
            ord_id: direct_algo_id.or_else(|| optional_non_empty(&request.ord_id)),
            cl_ord_id: direct_algo_cl_ord_id.or_else(|| optional_non_empty(&request.cl_ord_id)),
        });
    }

    let conn = open_database(app)?;
    let order_id =
        optional_non_empty(&request.ord_id).or_else(|| optional_non_empty(&request.cl_ord_id));
    if let Some(order_id) = order_id.as_deref() {
        let result = conn.query_row(
            "SELECT ord_type, source_endpoint, ord_id, cl_ord_id
             FROM okx_orders
             WHERE account_id = ?1 AND environment = ?2 AND inst_id = ?3 AND (ord_id = ?4 OR cl_ord_id = ?4)
             LIMIT 1",
            params![account.id, account.environment, request.inst_id, order_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        );
        if let Ok((ord_type, source_endpoint, ord_id, cl_ord_id)) = result {
            let is_algo =
                ord_type.as_deref() == Some("trigger") || source_endpoint.contains("algo");
            return Ok(CancelTarget {
                is_algo,
                ord_id: Some(ord_id),
                cl_ord_id,
            });
        }
    }

    Ok(CancelTarget {
        is_algo: false,
        ord_id: optional_non_empty(&request.ord_id),
        cl_ord_id: optional_non_empty(&request.cl_ord_id),
    })
}

fn mark_local_order_cancelled<T: Serialize>(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    ord_id: &str,
    cl_ord_id: &str,
    source_endpoint: &str,
    result: &T,
) -> Result<(), String> {
    let conn = open_database(app)?;
    let now = now_ms();
    let raw_json = private_exchange_json(result)?;
    let ord_id = ord_id.trim();
    let cl_ord_id = cl_ord_id.trim();
    if ord_id.is_empty() && cl_ord_id.is_empty() {
        return Ok(());
    }
    let affected = conn
        .execute(
            "UPDATE okx_orders
             SET state = 'canceled',
                 source_endpoint = ?1,
                 okx_utime = ?2,
                 raw_json = ?3,
                 synced_at = ?4
             WHERE account_id = ?5
               AND environment = ?6
               AND ((?7 <> '' AND ord_id = ?7) OR (?8 <> '' AND cl_ord_id = ?8))",
            params![
                source_endpoint,
                now,
                raw_json,
                now,
                account.id,
                account.environment,
                ord_id,
                cl_ord_id
            ],
        )
        .map_err(|err| err.to_string())?;
    if affected == 0 && !ord_id.is_empty() {
        conn.execute(
            "INSERT INTO okx_orders (
              account_id, environment, ord_id, cl_ord_id, inst_id, inst_type, state, source_endpoint,
              operator, raw_json, synced_at
            ) VALUES (?1, ?2, ?3, NULLIF(?4, ''), '', 'SWAP', 'canceled', ?5, 'user', ?6, ?7)
            ON CONFLICT(account_id, environment, ord_id) DO UPDATE SET
              cl_ord_id=COALESCE(excluded.cl_ord_id, okx_orders.cl_ord_id),
              state='canceled',
              source_endpoint=excluded.source_endpoint,
              raw_json=excluded.raw_json,
              synced_at=excluded.synced_at",
            params![account.id, account.environment, ord_id, cl_ord_id, source_endpoint, raw_json, now],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn upsert_okx_history_fills(
    conn: &mut Connection,
    account: &LocalAccount,
    source_endpoint: &str,
    rows: &[serde_json::Value],
) -> Result<usize, String> {
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let synced_at = now_ms();
    let mut count = 0;
    for row in rows {
        let stored_row = private_exchange_json(row)?;
        let Some(bill_id) = json_string(row, "billId").filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        let ord_id = json_string(row, "ordId");
        let attribution = order_attribution(&tx, account, ord_id.as_deref())?;
        let operator = attribution.0;
        let strategy_id = attribution.1;
        let session_id = attribution.2;
        let opportunity_id = attribution.3;
        let agent_run_id = attribution.4;
        let execution_key = attribution.5;
        tx.execute(
            "INSERT INTO okx_fills (
              account_id, environment, bill_id, ord_id, trade_id, inst_id, inst_type, side, pos_side,
              sub_type, fill_px, fill_sz, fill_pnl, fee, fee_ccy, source_endpoint, operator, strategy_id, session_id,
              opportunity_id,agent_run_id,execution_key,okx_ts,raw_json,synced_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)
            ON CONFLICT(account_id, environment, bill_id) DO UPDATE SET
              ord_id=excluded.ord_id,
              trade_id=excluded.trade_id,
              inst_id=excluded.inst_id,
              inst_type=excluded.inst_type,
              side=excluded.side,
              pos_side=excluded.pos_side,
              sub_type=excluded.sub_type,
              fill_px=excluded.fill_px,
              fill_sz=excluded.fill_sz,
              fill_pnl=excluded.fill_pnl,
              fee=excluded.fee,
              fee_ccy=excluded.fee_ccy,
              source_endpoint=excluded.source_endpoint,
              operator=CASE
                WHEN okx_fills.operator IS NULL OR okx_fills.operator = '' OR okx_fills.operator = 'unknown'
                THEN excluded.operator
                ELSE okx_fills.operator
              END,
              strategy_id=COALESCE(okx_fills.strategy_id, excluded.strategy_id),
              session_id=COALESCE(okx_fills.session_id, excluded.session_id),
              opportunity_id=COALESCE(okx_fills.opportunity_id, excluded.opportunity_id),
              agent_run_id=COALESCE(okx_fills.agent_run_id, excluded.agent_run_id),
              execution_key=COALESCE(okx_fills.execution_key, excluded.execution_key),
              okx_ts=excluded.okx_ts,
              raw_json=excluded.raw_json,
              synced_at=excluded.synced_at",
            params![
                account.id,
                account.environment,
                bill_id,
                ord_id,
                json_string(row, "tradeId"),
                json_string(row, "instId").unwrap_or_default(),
                json_string(row, "instType").unwrap_or_default(),
                json_string(row, "side"),
                json_string(row, "posSide"),
                json_string(row, "subType"),
                json_string(row, "fillPx"),
                json_string(row, "fillSz"),
                json_string(row, "fillPnl"),
                json_string(row, "fee"),
                json_string(row, "feeCcy"),
                source_endpoint,
                operator,
                strategy_id,
                session_id,
                opportunity_id,
                agent_run_id,
                execution_key,
                json_i64(row, "ts").or_else(|| json_i64(row, "fillTime")),
                stored_row,
                synced_at
            ],
        )
        .map_err(|err| err.to_string())?;
        audit_fill_event_with_conn(
            &tx,
            account,
            row,
            source_endpoint,
            &operator,
            strategy_id.clone(),
            session_id.clone(),
            synced_at,
        )?;
        count += 1;
    }
    tx.commit().map_err(|err| err.to_string())?;
    Ok(count)
}

fn upsert_okx_history_positions(
    conn: &mut Connection,
    account: &LocalAccount,
    rows: &[serde_json::Value],
) -> Result<usize, String> {
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let synced_at = now_ms();
    let mut count = 0;
    for row in rows {
        let stored_row = private_exchange_json(row)?;
        let Some(pos_id) = json_string(row, "posId").filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        let okx_utime = json_i64(row, "uTime").unwrap_or(0);
        tx.execute(
            "INSERT INTO okx_position_history (
              account_id, environment, pos_id, inst_id, inst_type, mgn_mode, pos_side, direction,
              close_type, open_avg_px, close_avg_px, open_max_pos, close_total_pos, realized_pnl,
              pnl, fee, funding_fee, liq_penalty, okx_ctime, okx_utime, raw_json, synced_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
            ON CONFLICT(account_id, environment, pos_id, okx_utime) DO UPDATE SET
              inst_id=excluded.inst_id,
              inst_type=excluded.inst_type,
              mgn_mode=excluded.mgn_mode,
              pos_side=excluded.pos_side,
              direction=excluded.direction,
              close_type=excluded.close_type,
              open_avg_px=excluded.open_avg_px,
              close_avg_px=excluded.close_avg_px,
              open_max_pos=excluded.open_max_pos,
              close_total_pos=excluded.close_total_pos,
              realized_pnl=excluded.realized_pnl,
              pnl=excluded.pnl,
              fee=excluded.fee,
              funding_fee=excluded.funding_fee,
              liq_penalty=excluded.liq_penalty,
              okx_ctime=excluded.okx_ctime,
              raw_json=excluded.raw_json,
              synced_at=excluded.synced_at",
            params![
                account.id,
                account.environment,
                pos_id,
                json_string(row, "instId").unwrap_or_default(),
                json_string(row, "instType").unwrap_or_default(),
                json_string(row, "mgnMode"),
                json_string(row, "posSide"),
                json_string(row, "direction"),
                json_string(row, "type"),
                json_string(row, "openAvgPx"),
                json_string(row, "closeAvgPx"),
                json_string(row, "openMaxPos"),
                json_string(row, "closeTotalPos"),
                json_string(row, "realizedPnl"),
                json_string(row, "pnl"),
                json_string(row, "fee"),
                json_string(row, "fundingFee"),
                json_string(row, "liqPenalty"),
                json_i64(row, "cTime"),
                okx_utime,
                stored_row,
                synced_at
            ],
        )
        .map_err(|err| err.to_string())?;
        count += 1;
    }
    tx.commit().map_err(|err| err.to_string())?;
    Ok(count)
}

fn upsert_okx_account_bills(
    conn: &mut Connection,
    account: &LocalAccount,
    source_endpoint: &str,
    rows: &[serde_json::Value],
) -> Result<usize, String> {
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let synced_at = now_ms();
    let mut count = 0;
    for row in rows {
        let stored_row = private_exchange_json(row)?;
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
                stored_row,
                synced_at
            ],
        )
        .map_err(|err| err.to_string())?;
        count += 1;
    }
    tx.commit().map_err(|err| err.to_string())?;
    Ok(count)
}

pub fn rebuild_position_episodes_for_account(
    conn: &mut Connection,
    account_id: &str,
    environment: &str,
    inst_id: Option<&str>,
) -> Result<RebuildPositionEpisodesResult, String> {
    let started_at = now_ms();
    let fills = load_episode_fills(conn, account_id, environment, inst_id)?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    if let Some(symbol) = inst_id {
        tx.execute(
            "DELETE FROM position_episode_opportunities WHERE episode_id IN (
               SELECT id FROM position_episodes WHERE account_id = ?1 AND environment = ?2 AND inst_id = ?3
             )",
            params![account_id, environment, symbol],
        )
        .map_err(|err| err.to_string())?;
        tx.execute(
            "DELETE FROM position_episode_events WHERE episode_id IN (
               SELECT id FROM position_episodes WHERE account_id = ?1 AND environment = ?2 AND inst_id = ?3
             )",
            params![account_id, environment, symbol],
        )
        .map_err(|err| err.to_string())?;
        tx.execute(
            "DELETE FROM position_episodes WHERE account_id = ?1 AND environment = ?2 AND inst_id = ?3",
            params![account_id, environment, symbol],
        )
        .map_err(|err| err.to_string())?;
    } else {
        tx.execute(
            "DELETE FROM position_episode_opportunities WHERE episode_id IN (
               SELECT id FROM position_episodes WHERE account_id = ?1 AND environment = ?2
             )",
            params![account_id, environment],
        )
        .map_err(|err| err.to_string())?;
        tx.execute(
            "DELETE FROM position_episode_events WHERE episode_id IN (
               SELECT id FROM position_episodes WHERE account_id = ?1 AND environment = ?2
             )",
            params![account_id, environment],
        )
        .map_err(|err| err.to_string())?;
        tx.execute(
            "DELETE FROM position_episodes WHERE account_id = ?1 AND environment = ?2",
            params![account_id, environment],
        )
        .map_err(|err| err.to_string())?;
    }

    let mut result = RebuildPositionEpisodesResult {
        account_id: account_id.to_string(),
        environment: environment.to_string(),
        inst_id: inst_id.map(|value| value.to_string()),
        fills_scanned: fills.len(),
        started_at,
        ..RebuildPositionEpisodesResult::default()
    };
    let mut active: HashMap<String, ActiveEpisodeBuild> = HashMap::new();
    for fill in fills {
        let Some(action) = episode_action_from_fill(&fill) else {
            result.incomplete_events += 1;
            continue;
        };
        let qty = parse_optional_f64(fill.fill_sz.as_deref().unwrap_or(""))
            .unwrap_or(0.0)
            .abs();
        if qty <= 0.0 {
            result.incomplete_events += 1;
            continue;
        }
        let price = parse_optional_f64(fill.fill_px.as_deref().unwrap_or("")).unwrap_or(0.0);
        let key = episode_key(account_id, environment, &fill.inst_id, &action.side);
        if action.opens {
            let entry = active.entry(key).or_insert_with(|| {
                ActiveEpisodeBuild::new(account_id, environment, &fill, &action.side)
            });
            let event_type = if entry.event_count == 0 {
                "OPEN"
            } else {
                "ADD"
            };
            entry.add_open(qty, price, &fill);
            insert_position_episode(&tx, entry, "open")?;
            insert_position_episode_event(&tx, entry, &fill, event_type, qty, price)?;
            entry.event_count += 1;
            result.events_built += 1;
        } else {
            let Some(entry) = active.get_mut(&key) else {
                if let Some(reversal_side) = action.reversal_side.as_deref() {
                    let reversal_key =
                        episode_key(account_id, environment, &fill.inst_id, reversal_side);
                    let reversal_entry = active.entry(reversal_key).or_insert_with(|| {
                        ActiveEpisodeBuild::new(account_id, environment, &fill, reversal_side)
                    });
                    let event_type = if reversal_entry.event_count == 0 {
                        "OPEN"
                    } else {
                        "ADD"
                    };
                    reversal_entry.add_open(qty, price, &fill);
                    insert_position_episode(&tx, reversal_entry, "open")?;
                    insert_position_episode_event(
                        &tx,
                        reversal_entry,
                        &fill,
                        event_type,
                        qty,
                        price,
                    )?;
                    reversal_entry.event_count += 1;
                    result.events_built += 1;
                    continue;
                } else {
                    result.incomplete_events += 1;
                    continue;
                }
            };
            let before = entry.remaining_qty;
            let close_qty = qty.min(before);
            let reversal_qty = (qty - close_qty).max(0.0);
            entry.add_close_allocated(
                close_qty,
                price,
                &fill,
                if qty > 0.0 { close_qty / qty } else { 1.0 },
            );
            let event_type = if entry.remaining_qty <= 1e-10 {
                "CLOSE"
            } else {
                "REDUCE"
            };
            let status = if entry.remaining_qty <= 1e-10 {
                "closed"
            } else {
                "open"
            };
            insert_position_episode(&tx, entry, status)?;
            insert_position_episode_event(&tx, entry, &fill, event_type, close_qty, price)?;
            entry.event_count += 1;
            result.events_built += 1;
            if entry.remaining_qty <= 1e-10 {
                let finished = active.remove(&key).expect("active episode just checked");
                insert_position_episode(&tx, &finished, "closed")?;
                result.episodes_built += 1;
            }
            if reversal_qty > 1e-10 {
                if let Some(reversal_side) = action.reversal_side.as_deref() {
                    let reversal_key =
                        episode_key(account_id, environment, &fill.inst_id, reversal_side);
                    let reversal_entry = active.entry(reversal_key).or_insert_with(|| {
                        ActiveEpisodeBuild::new(account_id, environment, &fill, reversal_side)
                    });
                    let reversal_event_type = if reversal_entry.event_count == 0 {
                        "OPEN"
                    } else {
                        "ADD"
                    };
                    reversal_entry.add_open_allocated(
                        reversal_qty,
                        price,
                        &fill,
                        if qty > 0.0 { reversal_qty / qty } else { 1.0 },
                    );
                    insert_position_episode(&tx, reversal_entry, "open")?;
                    insert_position_episode_event(
                        &tx,
                        reversal_entry,
                        &fill,
                        reversal_event_type,
                        reversal_qty,
                        price,
                    )?;
                    reversal_entry.event_count += 1;
                    result.events_built += 1;
                } else {
                    result.incomplete_events += 1;
                }
            }
        }
    }
    for (_, unfinished) in active {
        insert_position_episode(&tx, &unfinished, "open")?;
        result.episodes_built += 1;
    }
    let bill_events =
        attach_account_bill_events_to_episodes(&tx, account_id, environment, inst_id)?;
    result.events_built += bill_events;
    result.episodes_built +=
        reconcile_official_position_history(&tx, account_id, environment, inst_id)?;
    tx.commit().map_err(|err| err.to_string())?;
    sync_position_episode_opportunity_links(conn, account_id, environment, inst_id)?;
    let _ = crate::ai_automation::enqueue_closed_episode_reviews(
        conn,
        account_id,
        environment,
        inst_id,
    );
    result.finished_at = now_ms();
    Ok(result)
}

#[derive(Debug)]
struct OfficialPositionHistoryRow {
    pos_id: String,
    inst_id: String,
    inst_type: String,
    mgn_mode: Option<String>,
    side: String,
    open_avg_px: Option<String>,
    close_avg_px: Option<String>,
    open_max_pos: Option<String>,
    close_total_pos: Option<String>,
    realized_pnl: Option<String>,
    pnl: Option<String>,
    fee: Option<String>,
    funding_fee: Option<String>,
    liq_penalty: Option<String>,
    open_time: i64,
    close_time: i64,
}

fn reconcile_official_position_history(
    conn: &Connection,
    account_id: &str,
    environment: &str,
    inst_id: Option<&str>,
) -> Result<usize, String> {
    let official_rows =
        load_latest_official_position_history(conn, account_id, environment, inst_id)?;
    let mut inserted = 0usize;
    for official in official_rows {
        let matched_episode = conn
            .query_row(
                "SELECT id FROM position_episodes
                 WHERE account_id=?1 AND environment=?2 AND inst_id=?3 AND episode_side=?4
                   AND exchange_pos_id IS NULL
                   AND (?5 <= 0 OR ABS(open_time - ?5) <= 300000)
                   AND (?6 <= 0 OR ABS(COALESCE(close_time,last_fill_time,open_time) - ?6) <= 300000)
                 ORDER BY ABS(open_time - ?5) + ABS(COALESCE(close_time,last_fill_time,open_time) - ?6), id
                 LIMIT 1",
                params![
                    account_id,
                    environment,
                    official.inst_id,
                    official.side,
                    official.open_time,
                    official.close_time,
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|err| err.to_string())?;

        if let Some(episode_id) = matched_episode {
            conn.execute(
                "UPDATE position_episodes
                 SET exchange_pos_id=?1,
                     last_okx_pos_id=?1,
                     mgn_mode=COALESCE(NULLIF(?2,''),mgn_mode),
                     notes=COALESCE(notes,'official_position_history_matched'),
                     updated_at=?3
                 WHERE id=?4",
                params![official.pos_id, official.mgn_mode, now_ms(), episode_id],
            )
            .map_err(|err| err.to_string())?;
            continue;
        }

        let open_qty = official_quantity(&official.open_max_pos);
        let closed_qty = official_quantity(&official.close_total_pos);
        let max_qty = if open_qty == "0" {
            closed_qty.clone()
        } else {
            open_qty.clone()
        };
        let episode_id = format!(
            "pe-official-{}-{}-{}",
            account_id, environment, official.pos_id
        );
        let open_time = if official.open_time > 0 {
            official.open_time
        } else {
            official.close_time
        };
        let close_time = if official.close_time > 0 {
            official.close_time
        } else {
            open_time
        };
        let now = now_ms();
        conn.execute(
            "INSERT INTO position_episodes (
              id, account_id, environment, exchange, inst_type, inst_id, inst_family, exchange_pos_id,
              pos_mode, mgn_mode, episode_side, status, primary_origin, strategy_id, signal_id,
              trade_plan_id, opened_by_actor_id, closed_by_actor_id, open_time, close_time, open_qty,
              max_qty, closed_qty, remaining_qty, avg_open_px, avg_close_px, realized_pnl, fees,
              funding_fee, liq_penalty, net_pnl, initial_lever, final_lever, last_okx_pos_id,
              last_trade_id, last_fill_time, notes, created_at, updated_at
            ) VALUES (?1,?2,?3,'okx',?4,?5,NULL,?6,'official_history',?7,?8,'closed','exchange',NULL,
              NULL,NULL,NULL,NULL,?9,?10,?11,?12,?13,'0',?14,?15,?16,?17,?18,?19,?20,NULL,NULL,?6,
              NULL,?10,'official_position_history',?21,?21)",
            params![
                episode_id,
                account_id,
                environment,
                official.inst_type,
                official.inst_id,
                official.pos_id,
                official.mgn_mode,
                official.side,
                open_time,
                close_time,
                open_qty,
                max_qty,
                closed_qty,
                official.open_avg_px,
                official.close_avg_px,
                official.pnl,
                official.fee,
                official.funding_fee,
                official.liq_penalty,
                official.realized_pnl,
                now,
            ],
        )
        .map_err(|err| err.to_string())?;
        inserted += 1;
    }
    Ok(inserted)
}

fn load_latest_official_position_history(
    conn: &Connection,
    account_id: &str,
    environment: &str,
    inst_id: Option<&str>,
) -> Result<Vec<OfficialPositionHistoryRow>, String> {
    let mut sql = "SELECT h.pos_id,h.inst_id,h.inst_type,h.mgn_mode,h.pos_side,h.direction,
          h.open_avg_px,h.close_avg_px,h.open_max_pos,h.close_total_pos,h.realized_pnl,h.pnl,h.fee,
          h.funding_fee,h.liq_penalty,COALESCE(h.okx_ctime,0),COALESCE(h.okx_utime,0)
        FROM okx_position_history h
        WHERE h.account_id=?1 AND h.environment=?2
          AND h.okx_utime=(SELECT MAX(newer.okx_utime) FROM okx_position_history newer
            WHERE newer.account_id=h.account_id AND newer.environment=h.environment AND newer.pos_id=h.pos_id)"
        .to_string();
    if inst_id.is_some() {
        sql.push_str(" AND h.inst_id=?3");
    }
    sql.push_str(" ORDER BY h.okx_utime DESC,h.pos_id ASC");
    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let mapper = |row: &rusqlite::Row<'_>| {
        let pos_side = row.get::<_, Option<String>>(4)?;
        let direction = row.get::<_, Option<String>>(5)?;
        let side = pos_side
            .filter(|value| matches!(value.as_str(), "long" | "short"))
            .or_else(|| direction.filter(|value| matches!(value.as_str(), "long" | "short")));
        let Some(side) = side else {
            return Ok(None);
        };
        Ok(Some(OfficialPositionHistoryRow {
            pos_id: row.get(0)?,
            inst_id: row.get(1)?,
            inst_type: row.get(2)?,
            mgn_mode: row.get(3)?,
            side,
            open_avg_px: row.get(6)?,
            close_avg_px: row.get(7)?,
            open_max_pos: row.get(8)?,
            close_total_pos: row.get(9)?,
            realized_pnl: row.get(10)?,
            pnl: row.get(11)?,
            fee: row.get(12)?,
            funding_fee: row.get(13)?,
            liq_penalty: row.get(14)?,
            open_time: row.get(15)?,
            close_time: row.get(16)?,
        }))
    };
    let rows = if let Some(symbol) = inst_id {
        stmt.query_map(params![account_id, environment, symbol], mapper)
    } else {
        stmt.query_map(params![account_id, environment], mapper)
    }
    .map_err(|err| err.to_string())?;
    rows.filter_map(|row| row.transpose())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn official_quantity(value: &Option<String>) -> String {
    value
        .as_deref()
        .and_then(parse_optional_f64)
        .filter(|amount| *amount > 0.0)
        .map(trim_float)
        .unwrap_or_else(|| "0".to_string())
}

fn sync_position_episode_opportunity_links(
    conn: &Connection,
    account_id: &str,
    environment: &str,
    inst_id: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE position_episode_events AS e
         SET opportunity_id=COALESCE(
               e.opportunity_id,
               (SELECT f.opportunity_id FROM okx_fills f
                JOIN position_episodes p ON p.id=e.episode_id
                WHERE f.account_id=p.account_id AND f.environment=p.environment AND f.bill_id=e.bill_id
                  AND f.opportunity_id IS NOT NULL LIMIT 1),
               (SELECT t.id FROM trade_opportunities t WHERE t.id=e.strategy_id LIMIT 1)
             ),
             agent_run_id=COALESCE(
               e.agent_run_id,
               (SELECT f.agent_run_id FROM okx_fills f
                JOIN position_episodes p ON p.id=e.episode_id
                WHERE f.account_id=p.account_id AND f.environment=p.environment AND f.bill_id=e.bill_id
                  AND f.agent_run_id IS NOT NULL LIMIT 1)
             )
         WHERE e.episode_id IN (
           SELECT id FROM position_episodes
           WHERE account_id=?1 AND environment=?2 AND (?3 IS NULL OR inst_id=?3)
         )",
        params![account_id, environment, inst_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM position_episode_opportunities
         WHERE episode_id IN (
           SELECT id FROM position_episodes
           WHERE account_id=?1 AND environment=?2 AND (?3 IS NULL OR inst_id=?3)
         )",
        params![account_id, environment, inst_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "INSERT INTO position_episode_opportunities(
           episode_id,opportunity_id,relation_type,attributed_qty,attribution_type,agent_run_id,created_at,updated_at
         )
         SELECT e.episode_id,e.opportunity_id,'contributed',CAST(SUM(CAST(e.qty AS REAL)) AS TEXT),
                CASE WHEN (
                  SELECT COUNT(DISTINCT e2.opportunity_id)
                  FROM position_episode_events e2
                  WHERE e2.episode_id=e.episode_id AND e2.opportunity_id IS NOT NULL
                ) > 1 THEN 'mixed' ELSE 'direct' END,
                MAX(e.agent_run_id),?4,?4
         FROM position_episode_events e
         JOIN position_episodes p ON p.id=e.episode_id
         WHERE p.account_id=?1 AND p.environment=?2 AND (?3 IS NULL OR p.inst_id=?3)
           AND e.opportunity_id IS NOT NULL AND e.opportunity_id<>''
           AND EXISTS (SELECT 1 FROM trade_opportunities t WHERE t.id=e.opportunity_id)
         GROUP BY e.episode_id,e.opportunity_id",
        params![account_id, environment, inst_id, now_ms()],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

#[derive(Debug)]
struct EpisodeAction {
    side: String,
    opens: bool,
    reversal_side: Option<String>,
}

#[derive(Debug)]
struct ActiveEpisodeBuild {
    id: String,
    account_id: String,
    environment: String,
    inst_type: String,
    inst_id: String,
    episode_side: String,
    primary_origin: String,
    strategy_id: Option<String>,
    session_id: Option<String>,
    open_time: i64,
    close_time: Option<i64>,
    open_qty: f64,
    max_qty: f64,
    closed_qty: f64,
    remaining_qty: f64,
    open_notional: f64,
    close_notional: f64,
    realized_pnl: f64,
    fees: f64,
    last_trade_id: Option<String>,
    last_fill_time: i64,
    event_count: usize,
}

impl ActiveEpisodeBuild {
    fn new(account_id: &str, environment: &str, fill: &EpisodeFillRow, side: &str) -> Self {
        Self {
            id: format!(
                "pe-{}-{}-{}",
                fill.inst_id.replace('-', ""),
                side,
                fill.okx_ts
            ),
            account_id: account_id.to_string(),
            environment: environment.to_string(),
            inst_type: fill.inst_type.clone(),
            inst_id: fill.inst_id.clone(),
            episode_side: side.to_string(),
            primary_origin: fill.operator.clone().unwrap_or_else(|| "user".to_string()),
            strategy_id: fill.strategy_id.clone(),
            session_id: fill.session_id.clone(),
            open_time: fill.okx_ts,
            close_time: None,
            open_qty: 0.0,
            max_qty: 0.0,
            closed_qty: 0.0,
            remaining_qty: 0.0,
            open_notional: 0.0,
            close_notional: 0.0,
            realized_pnl: 0.0,
            fees: 0.0,
            last_trade_id: fill.trade_id.clone(),
            last_fill_time: fill.okx_ts,
            event_count: 0,
        }
    }

    fn add_open(&mut self, qty: f64, price: f64, fill: &EpisodeFillRow) {
        self.add_open_allocated(qty, price, fill, 1.0);
    }

    fn add_open_allocated(&mut self, qty: f64, price: f64, fill: &EpisodeFillRow, allocation: f64) {
        self.open_qty += qty;
        self.remaining_qty += qty;
        self.max_qty = self.max_qty.max(self.remaining_qty);
        self.open_notional += qty * price;
        self.add_common_allocated(fill, allocation);
    }

    fn add_close_allocated(
        &mut self,
        qty: f64,
        price: f64,
        fill: &EpisodeFillRow,
        allocation: f64,
    ) {
        let close_qty = qty.min(self.remaining_qty);
        self.closed_qty += close_qty;
        self.remaining_qty = (self.remaining_qty - close_qty).max(0.0);
        self.close_notional += close_qty * price;
        self.close_time = Some(fill.okx_ts);
        self.realized_pnl +=
            parse_optional_f64(fill.fill_pnl.as_deref().unwrap_or("")).unwrap_or(0.0);
        self.add_common_allocated(fill, allocation);
    }

    fn add_common_allocated(&mut self, fill: &EpisodeFillRow, allocation: f64) {
        let bounded_allocation = allocation.clamp(0.0, 1.0);
        self.fees += parse_optional_f64(fill.fee.as_deref().unwrap_or("")).unwrap_or(0.0)
            * bounded_allocation;
        self.last_trade_id = fill.trade_id.clone().or_else(|| self.last_trade_id.clone());
        self.last_fill_time = fill.okx_ts;
        let origin = fill.operator.clone().unwrap_or_else(|| "user".to_string());
        if self.primary_origin != origin {
            self.primary_origin = "mixed".to_string();
        }
    }
}

fn load_episode_fills(
    conn: &Connection,
    account_id: &str,
    environment: &str,
    inst_id: Option<&str>,
) -> Result<Vec<EpisodeFillRow>, String> {
    let mut sql = "SELECT bill_id, ord_id, trade_id, inst_id, inst_type, side, pos_side, sub_type, fill_px, fill_sz,
        fill_pnl, fee, fee_ccy, operator, strategy_id, session_id, COALESCE(okx_ts, 0), raw_json
        FROM okx_fills WHERE account_id = ?1 AND environment = ?2"
        .to_string();
    if inst_id.is_some() {
        sql.push_str(" AND inst_id = ?3");
    }
    sql.push_str(" ORDER BY COALESCE(okx_ts, 0) ASC, bill_id ASC");
    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let mapper = |row: &rusqlite::Row<'_>| {
        Ok(EpisodeFillRow {
            bill_id: row.get(0)?,
            ord_id: row.get(1)?,
            trade_id: row.get(2)?,
            inst_id: row.get(3)?,
            inst_type: row.get(4)?,
            side: row.get(5)?,
            pos_side: row.get(6)?,
            sub_type: row.get(7)?,
            fill_px: row.get(8)?,
            fill_sz: row.get(9)?,
            fill_pnl: row.get(10)?,
            fee: row.get(11)?,
            fee_ccy: row.get(12)?,
            operator: row.get(13)?,
            strategy_id: row.get(14)?,
            session_id: row.get(15)?,
            okx_ts: row.get(16)?,
            raw_json: row.get(17)?,
        })
    };
    if let Some(symbol) = inst_id {
        let rows = stmt
            .query_map(params![account_id, environment, symbol], mapper)
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())
    } else {
        let rows = stmt
            .query_map(params![account_id, environment], mapper)
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())
    }
}

fn episode_action_from_fill(fill: &EpisodeFillRow) -> Option<EpisodeAction> {
    match fill.sub_type.as_deref() {
        Some("3") | Some("206") | Some("272") | Some("326") => Some(EpisodeAction {
            side: "long".to_string(),
            opens: true,
            reversal_side: None,
        }),
        Some("4") | Some("207") | Some("273") | Some("327") => Some(EpisodeAction {
            side: "short".to_string(),
            opens: true,
            reversal_side: None,
        }),
        Some("5") | Some("208") | Some("274") | Some("328") => Some(EpisodeAction {
            side: "long".to_string(),
            opens: false,
            reversal_side: Some("short".to_string()),
        }),
        Some("6") | Some("209") | Some("275") | Some("329") => Some(EpisodeAction {
            side: "short".to_string(),
            opens: false,
            reversal_side: Some("long".to_string()),
        }),
        _ => match (fill.pos_side.as_deref(), fill.side.as_deref()) {
            (Some("long"), Some("buy")) => Some(EpisodeAction {
                side: "long".to_string(),
                opens: true,
                reversal_side: None,
            }),
            (Some("long"), Some("sell")) => Some(EpisodeAction {
                side: "long".to_string(),
                opens: false,
                reversal_side: Some("short".to_string()),
            }),
            (Some("short"), Some("sell")) => Some(EpisodeAction {
                side: "short".to_string(),
                opens: true,
                reversal_side: None,
            }),
            (Some("short"), Some("buy")) => Some(EpisodeAction {
                side: "short".to_string(),
                opens: false,
                reversal_side: Some("long".to_string()),
            }),
            (Some("net"), Some("buy")) | (None, Some("buy")) => Some(EpisodeAction {
                side: "short".to_string(),
                opens: false,
                reversal_side: Some("long".to_string()),
            }),
            (Some("net"), Some("sell")) | (None, Some("sell")) => Some(EpisodeAction {
                side: "long".to_string(),
                opens: false,
                reversal_side: Some("short".to_string()),
            }),
            _ => None,
        },
    }
}

fn episode_key(account_id: &str, environment: &str, inst_id: &str, side: &str) -> String {
    format!("{}:{}:{}:{}", account_id, environment, inst_id, side)
}

fn insert_position_episode(
    conn: &Connection,
    episode: &ActiveEpisodeBuild,
    status: &str,
) -> Result<(), String> {
    let avg_open = if episode.open_qty > 0.0 {
        Some(trim_float(episode.open_notional / episode.open_qty))
    } else {
        None
    };
    let avg_close = if episode.closed_qty > 0.0 {
        Some(trim_float(episode.close_notional / episode.closed_qty))
    } else {
        None
    };
    let now = now_ms();
    conn.execute(
        "INSERT INTO position_episodes (
          id, account_id, environment, exchange, inst_type, inst_id, inst_family, exchange_pos_id,
          pos_mode, mgn_mode, episode_side, status, primary_origin, strategy_id, signal_id,
          trade_plan_id, opened_by_actor_id, closed_by_actor_id, open_time, close_time, open_qty,
          max_qty, closed_qty, remaining_qty, avg_open_px, avg_close_px, realized_pnl, fees,
          funding_fee, liq_penalty, net_pnl, initial_lever, final_lever, last_okx_pos_id,
          last_trade_id, last_fill_time, notes, created_at, updated_at
        ) VALUES (?1, ?2, ?3, 'okx', ?4, ?5, NULL, NULL, 'long_short_mode', 'user', ?6, ?7, ?8, ?9,
          NULL, NULL, NULL, NULL, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, NULL, NULL, ?20,
          NULL, NULL, NULL, ?21, ?22, ?23, ?24, ?24)
        ON CONFLICT(id) DO UPDATE SET
          status=excluded.status,
          primary_origin=excluded.primary_origin,
          strategy_id=COALESCE(position_episodes.strategy_id, excluded.strategy_id),
          close_time=excluded.close_time,
          open_qty=excluded.open_qty,
          max_qty=excluded.max_qty,
          closed_qty=excluded.closed_qty,
          remaining_qty=excluded.remaining_qty,
          avg_open_px=excluded.avg_open_px,
          avg_close_px=excluded.avg_close_px,
          realized_pnl=excluded.realized_pnl,
          fees=excluded.fees,
          net_pnl=excluded.net_pnl,
          last_trade_id=excluded.last_trade_id,
          last_fill_time=excluded.last_fill_time,
          notes=COALESCE(position_episodes.notes, excluded.notes),
          updated_at=excluded.updated_at",
        params![
            episode.id,
            episode.account_id,
            episode.environment,
            episode.inst_type,
            episode.inst_id,
            episode.episode_side,
            status,
            episode.primary_origin,
            episode.strategy_id,
            episode.open_time,
            episode.close_time,
            trim_float(episode.open_qty),
            trim_float(episode.max_qty),
            trim_float(episode.closed_qty),
            trim_float(episode.remaining_qty),
            avg_open,
            avg_close,
            trim_float(episode.realized_pnl),
            trim_float(episode.fees),
            trim_float(episode.realized_pnl + episode.fees),
            episode.last_trade_id,
            episode.last_fill_time,
            episode
                .session_id
                .as_ref()
                .map(|value| format!("session_id={}", value)),
            now
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn insert_position_episode_event(
    conn: &Connection,
    episode: &ActiveEpisodeBuild,
    fill: &EpisodeFillRow,
    event_type: &str,
    qty: f64,
    price: f64,
) -> Result<(), String> {
    let position_before = if event_type == "OPEN" || event_type == "ADD" {
        episode.remaining_qty - qty
    } else {
        episode.remaining_qty + qty
    };
    let event_id = format!("pee-{}-{}", fill.bill_id, event_type.to_ascii_lowercase());
    let now = now_ms();
    conn.execute(
        "INSERT OR REPLACE INTO position_episode_events (
          id, episode_id, event_type, origin, actor_id, strategy_id, signal_id, trade_plan_id,
          ord_id, bill_id, trade_id, side, pos_side, qty, price, pnl, fee, fee_ccy,
          position_before, position_after, avg_px_before, avg_px_after, event_time, source, raw_ref, created_at
        ) VALUES (?1, ?2, ?3, ?4, NULL, ?5, NULL, NULL, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
          ?16, ?17, NULL, NULL, ?18, 'okx_fills', ?19, ?20)",
        params![
            event_id,
            episode.id,
            event_type,
            fill.operator.clone().unwrap_or_else(|| "user".to_string()),
            fill.strategy_id,
            fill.ord_id,
            fill.bill_id,
            fill.trade_id,
            fill.side,
            fill.pos_side,
            trim_float(qty),
            trim_float(price),
            fill.fill_pnl,
            fill.fee,
            fill.fee_ccy,
            trim_float(position_before.max(0.0)),
            trim_float(episode.remaining_qty),
            fill.okx_ts,
            fill.raw_json,
            now
        ],
    )
    .map_err(|err| err.to_string())?;
    audit_position_episode_event_with_conn(
        conn,
        &episode.account_id,
        &episode.environment,
        episode,
        fill,
        event_type,
        qty,
        price,
    )?;
    Ok(())
}

fn attach_account_bill_events_to_episodes(
    conn: &Connection,
    account_id: &str,
    environment: &str,
    inst_id: Option<&str>,
) -> Result<usize, String> {
    let bills = load_episode_bills(conn, account_id, environment, inst_id)?;
    let mut attached = 0usize;
    for bill in bills {
        let Some(event_type) = episode_event_type_from_bill(&bill) else {
            continue;
        };
        let Some(episode_id) = find_episode_for_bill(conn, account_id, environment, &bill)? else {
            continue;
        };
        insert_position_episode_bill_event(conn, &episode_id, &bill, &event_type)?;
        update_episode_bill_totals(conn, &episode_id, &bill, &event_type)?;
        attached += 1;
    }
    Ok(attached)
}

fn load_episode_bills(
    conn: &Connection,
    account_id: &str,
    environment: &str,
    inst_id: Option<&str>,
) -> Result<Vec<EpisodeBillRow>, String> {
    let mut sql =
        "SELECT bill_id, inst_id, inst_type, bill_type, sub_type, bal_chg, pos_bal_chg, sz, px,
        pnl, fee, ccy, ord_id, trade_id, cl_ord_id, mgn_mode, notes, source_endpoint,
        COALESCE(okx_ts, synced_at, 0), raw_json
        FROM okx_account_bills
        WHERE account_id = ?1 AND environment = ?2 AND COALESCE(inst_id, '') != ''"
            .to_string();
    if inst_id.is_some() {
        sql.push_str(" AND inst_id = ?3");
    }
    sql.push_str(" ORDER BY COALESCE(okx_ts, synced_at, 0) ASC, bill_id ASC");
    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let mapper = |row: &rusqlite::Row<'_>| {
        Ok(EpisodeBillRow {
            bill_id: row.get(0)?,
            inst_id: row.get(1)?,
            inst_type: row.get(2)?,
            bill_type: row.get(3)?,
            sub_type: row.get(4)?,
            bal_chg: row.get(5)?,
            pos_bal_chg: row.get(6)?,
            sz: row.get(7)?,
            px: row.get(8)?,
            pnl: row.get(9)?,
            fee: row.get(10)?,
            ccy: row.get(11)?,
            ord_id: row.get(12)?,
            trade_id: row.get(13)?,
            cl_ord_id: row.get(14)?,
            mgn_mode: row.get(15)?,
            notes: row.get(16)?,
            source_endpoint: row.get(17)?,
            okx_ts: row.get(18)?,
            raw_json: row.get(19)?,
        })
    };
    if let Some(symbol) = inst_id {
        stmt.query_map(params![account_id, environment, symbol], mapper)
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())
    } else {
        stmt.query_map(params![account_id, environment], mapper)
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())
    }
}

fn episode_event_type_from_bill(bill: &EpisodeBillRow) -> Option<String> {
    match bill.bill_type.as_deref() {
        Some("5") => Some("LIQUIDATION".to_string()),
        Some("6") => Some("MARGIN_TRANSFER".to_string()),
        Some("7") => Some("INTEREST".to_string()),
        Some("8") => Some("FUNDING_FEE".to_string()),
        Some("9") => Some("ADL".to_string()),
        _ => match bill.sub_type.as_deref() {
            Some("100") | Some("101") => Some("LIQUIDATION".to_string()),
            Some("102") => Some("DELIVERY".to_string()),
            Some("103") => Some("ADL".to_string()),
            _ => None,
        },
    }
}

fn bill_pos_side(bill: &EpisodeBillRow) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(&bill.raw_json)
        .ok()
        .and_then(|value| json_string(&value, "posSide"))
        .filter(|value| value == "long" || value == "short")
}

fn find_episode_for_bill(
    conn: &Connection,
    account_id: &str,
    environment: &str,
    bill: &EpisodeBillRow,
) -> Result<Option<String>, String> {
    let pos_side = bill_pos_side(bill);
    let mut sql = "SELECT id, episode_side, open_time, close_time, status
        FROM position_episodes
        WHERE account_id = ?1 AND environment = ?2 AND inst_id = ?3
          AND open_time <= ?4 AND (close_time IS NULL OR close_time >= ?4)"
        .to_string();
    if pos_side.is_some() {
        sql.push_str(" AND episode_side = ?5");
    }
    sql.push_str(" ORDER BY CASE WHEN close_time IS NULL THEN 1 ELSE 0 END ASC, open_time DESC");
    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let mut candidates = if let Some(side) = pos_side.as_deref() {
        stmt.query_map(
            params![account_id, environment, bill.inst_id, bill.okx_ts, side],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?
    } else {
        stmt.query_map(
            params![account_id, environment, bill.inst_id, bill.okx_ts],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?
    };
    if candidates.len() == 1 {
        return Ok(candidates.pop().map(|item| item.0));
    }
    Ok(None)
}

fn bill_amount_for_episode(bill: &EpisodeBillRow) -> Option<String> {
    bill.pnl
        .clone()
        .or_else(|| bill.fee.clone())
        .or_else(|| bill.bal_chg.clone())
        .or_else(|| bill.pos_bal_chg.clone())
}

fn insert_position_episode_bill_event(
    conn: &Connection,
    episode_id: &str,
    bill: &EpisodeBillRow,
    event_type: &str,
) -> Result<(), String> {
    let event_id = format!(
        "pee-bill-{}-{}",
        bill.bill_id,
        event_type.to_ascii_lowercase()
    );
    let amount = bill_amount_for_episode(bill);
    let now = now_ms();
    conn.execute(
        "INSERT OR REPLACE INTO position_episode_events (
          id, episode_id, event_type, origin, actor_id, strategy_id, signal_id, trade_plan_id,
          ord_id, bill_id, trade_id, side, pos_side, qty, price, pnl, fee, fee_ccy,
          position_before, position_after, avg_px_before, avg_px_after, event_time, source, raw_ref, created_at
        ) VALUES (?1, ?2, ?3, 'okx_account_bill', NULL, NULL, NULL, NULL, ?4, ?5, ?6, NULL, ?7,
          ?8, ?9, ?10, ?11, ?12, NULL, NULL, NULL, NULL, ?13, ?14, ?15, ?16)",
        params![
            event_id,
            episode_id,
            event_type,
            bill.ord_id,
            bill.bill_id,
            bill.trade_id,
            bill_pos_side(bill),
            bill.sz.clone().unwrap_or_else(|| "0".to_string()),
            bill.px,
            amount,
            bill.fee,
            bill.ccy,
            bill.okx_ts,
            bill.source_endpoint,
            json!({
                "raw": serde_json::from_str::<serde_json::Value>(&bill.raw_json).unwrap_or_else(|_| json!(bill.raw_json)),
                "instType": bill.inst_type,
                "clOrdId": bill.cl_ord_id,
                "mgnMode": bill.mgn_mode,
                "notes": bill.notes,
                "billType": bill.bill_type,
                "subType": bill.sub_type,
            })
            .to_string(),
            now
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn update_episode_bill_totals(
    conn: &Connection,
    episode_id: &str,
    bill: &EpisodeBillRow,
    event_type: &str,
) -> Result<(), String> {
    let amount =
        parse_optional_f64(bill_amount_for_episode(bill).as_deref().unwrap_or("")).unwrap_or(0.0);
    let funding_delta = if event_type == "FUNDING_FEE" {
        amount
    } else {
        0.0
    };
    let liq_delta = if event_type == "LIQUIDATION" || event_type == "ADL" {
        amount
    } else {
        0.0
    };
    if funding_delta == 0.0 && liq_delta == 0.0 {
        return Ok(());
    }
    let (realized, fees, funding, liq): (Option<String>, Option<String>, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT realized_pnl, fees, funding_fee, liq_penalty FROM position_episodes WHERE id = ?1",
            params![episode_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|err| err.to_string())?;
    let realized_value = parse_optional_f64(realized.as_deref().unwrap_or("")).unwrap_or(0.0);
    let fees_value = parse_optional_f64(fees.as_deref().unwrap_or("")).unwrap_or(0.0);
    let funding_value =
        parse_optional_f64(funding.as_deref().unwrap_or("")).unwrap_or(0.0) + funding_delta;
    let liq_value = parse_optional_f64(liq.as_deref().unwrap_or("")).unwrap_or(0.0) + liq_delta;
    let net = realized_value + fees_value + funding_value + liq_value;
    conn.execute(
        "UPDATE position_episodes
         SET funding_fee = ?2, liq_penalty = ?3, net_pnl = ?4, updated_at = ?5
         WHERE id = ?1",
        params![
            episode_id,
            trim_float(funding_value),
            trim_float(liq_value),
            trim_float(net),
            now_ms()
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn map_position_episode_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PositionEpisodeSummary> {
    Ok(PositionEpisodeSummary {
        id: row.get(0)?,
        account_id: row.get(1)?,
        environment: row.get(2)?,
        inst_type: row.get(3)?,
        inst_id: row.get(4)?,
        episode_side: row.get(5)?,
        status: row.get(6)?,
        primary_origin: row.get(7)?,
        strategy_id: row.get(8)?,
        signal_id: row.get(9)?,
        trade_plan_id: row.get(10)?,
        open_time: row.get(11)?,
        close_time: row.get(12)?,
        open_qty: row.get(13)?,
        max_qty: row.get(14)?,
        closed_qty: row.get(15)?,
        remaining_qty: row.get(16)?,
        avg_open_px: row.get(17)?,
        avg_close_px: row.get(18)?,
        realized_pnl: row.get(19)?,
        fees: row.get(20)?,
        funding_fee: row.get(21)?,
        liq_penalty: row.get(22)?,
        net_pnl: row.get(23)?,
        last_trade_id: row.get(24)?,
        last_fill_time: row.get(25)?,
        events: Vec::new(),
    })
}

fn load_position_episode_by_id(
    conn: &Connection,
    account_id: &str,
    environment: &str,
    episode_id: &str,
) -> Result<Option<PositionEpisodeSummary>, String> {
    conn.query_row(
        "SELECT id, account_id, environment, inst_type, inst_id, episode_side, status, primary_origin,
          strategy_id, signal_id, trade_plan_id, open_time, close_time, open_qty, max_qty, closed_qty,
          remaining_qty, avg_open_px, avg_close_px, realized_pnl, fees, funding_fee, liq_penalty, net_pnl, last_trade_id, last_fill_time
         FROM position_episodes
         WHERE account_id = ?1 AND environment = ?2 AND id = ?3",
        params![account_id, environment, episode_id],
        map_position_episode_row,
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn load_position_episodes(
    conn: &Connection,
    account_id: &str,
    environment: &str,
    inst_id: Option<&str>,
    limit: u16,
) -> Result<Vec<PositionEpisodeSummary>, String> {
    let mut sql = "SELECT id, account_id, environment, inst_type, inst_id, episode_side, status, primary_origin,
        strategy_id, signal_id, trade_plan_id, open_time, close_time, open_qty, max_qty, closed_qty,
        remaining_qty, avg_open_px, avg_close_px, realized_pnl, fees, funding_fee, liq_penalty, net_pnl, last_trade_id, last_fill_time
        FROM position_episodes
        WHERE account_id = ?1 AND environment = ?2"
        .to_string();
    if inst_id.is_some() {
        sql.push_str(" AND inst_id = ?3");
        sql.push_str(" ORDER BY open_time DESC LIMIT ?4");
    } else {
        sql.push_str(" ORDER BY open_time DESC LIMIT ?3");
    }
    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let limit_value = i64::from(limit);
    let rows = if let Some(symbol) = inst_id {
        stmt.query_map(
            params![account_id, environment, symbol, limit_value],
            map_position_episode_row,
        )
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?
    } else {
        stmt.query_map(
            params![account_id, environment, limit_value],
            map_position_episode_row,
        )
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?
    };
    rows.into_iter()
        .map(|mut episode| {
            episode.events = load_position_episode_events(conn, &episode.id)?;
            Ok(episode)
        })
        .collect()
}

fn load_position_episode_events(
    conn: &Connection,
    episode_id: &str,
) -> Result<Vec<PositionEpisodeEventSummary>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, event_type, origin, actor_id, strategy_id, ord_id, bill_id, trade_id, side, pos_side,
              qty, price, pnl, fee, fee_ccy, position_before, position_after, event_time, source
             FROM position_episode_events
             WHERE episode_id = ?1
             ORDER BY event_time ASC, id ASC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![episode_id], |row| {
            Ok(PositionEpisodeEventSummary {
                id: row.get(0)?,
                event_type: row.get(1)?,
                origin: row.get(2)?,
                actor_id: row.get(3)?,
                strategy_id: row.get(4)?,
                ord_id: row.get(5)?,
                bill_id: row.get(6)?,
                trade_id: row.get(7)?,
                side: row.get(8)?,
                pos_side: row.get(9)?,
                qty: row.get(10)?,
                price: row.get(11)?,
                pnl: row.get(12)?,
                fee: row.get(13)?,
                fee_ccy: row.get(14)?,
                position_before: row.get(15)?,
                position_after: row.get(16)?,
                event_time: row.get(17)?,
                source: row.get(18)?,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn load_episode_orders(
    conn: &Connection,
    episode: &PositionEpisodeSummary,
    order_ids: &HashSet<String>,
    start_ms: i64,
    end_ms: i64,
) -> Result<Vec<HistoricalOrderSummary>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT account_id, environment, ord_id, cl_ord_id, inst_id, inst_type, side, pos_side, td_mode,
              ord_type, state, px, sz, acc_fill_sz, avg_px, pnl, fee, source_endpoint, operator, strategy_id,
              session_id, opportunity_id, agent_run_id, execution_key, okx_ctime, okx_utime, synced_at
             FROM okx_orders
             WHERE account_id = ?1 AND environment = ?2 AND inst_id = ?3
               AND COALESCE(okx_utime, okx_ctime, synced_at) >= ?4
               AND COALESCE(okx_ctime, okx_utime, synced_at) <= ?5
             ORDER BY COALESCE(okx_ctime, okx_utime, synced_at) ASC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(
            params![
                episode.account_id,
                episode.environment,
                episode.inst_id,
                start_ms,
                end_ms
            ],
            |row| {
                Ok(HistoricalOrderSummary {
                    account_id: row.get(0)?,
                    environment: row.get(1)?,
                    ord_id: row.get(2)?,
                    cl_ord_id: row.get(3)?,
                    inst_id: row.get(4)?,
                    inst_type: row.get(5)?,
                    side: row.get(6)?,
                    pos_side: row.get(7)?,
                    td_mode: row.get(8)?,
                    ord_type: row.get(9)?,
                    state: row.get(10)?,
                    px: row.get(11)?,
                    sz: row.get(12)?,
                    acc_fill_sz: row.get(13)?,
                    avg_px: row.get(14)?,
                    pnl: row.get(15)?,
                    fee: row.get(16)?,
                    source_endpoint: row.get(17)?,
                    operator: row.get(18)?,
                    strategy_id: row.get(19)?,
                    session_id: row.get(20)?,
                    opportunity_id: row.get(21)?,
                    agent_run_id: row.get(22)?,
                    execution_key: row.get(23)?,
                    okx_ctime: row.get(24)?,
                    okx_utime: row.get(25)?,
                    synced_at: row.get(26)?,
                })
            },
        )
        .map_err(|err| err.to_string())?;
    let mut orders = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    if !order_ids.is_empty() {
        orders.retain(|item| order_ids.contains(&item.ord_id));
    }
    Ok(orders)
}

fn load_review_episode_fills(
    conn: &Connection,
    episode: &PositionEpisodeSummary,
    order_ids: &HashSet<String>,
    bill_ids: &HashSet<String>,
    trade_ids: &HashSet<String>,
    start_ms: i64,
    end_ms: i64,
) -> Result<Vec<HistoricalFillSummary>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT account_id, environment, bill_id, ord_id, trade_id, inst_id, inst_type, side, pos_side,
              sub_type, fill_px, fill_sz, fill_pnl, fee, fee_ccy, source_endpoint, operator, strategy_id,
              session_id, opportunity_id, agent_run_id, execution_key, okx_ts, synced_at
             FROM okx_fills
             WHERE account_id = ?1 AND environment = ?2 AND inst_id = ?3
               AND COALESCE(okx_ts, synced_at) >= ?4
               AND COALESCE(okx_ts, synced_at) <= ?5
             ORDER BY COALESCE(okx_ts, synced_at) ASC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(
            params![
                episode.account_id,
                episode.environment,
                episode.inst_id,
                start_ms,
                end_ms
            ],
            |row| {
                Ok(HistoricalFillSummary {
                    account_id: row.get(0)?,
                    environment: row.get(1)?,
                    bill_id: row.get(2)?,
                    ord_id: row.get(3)?,
                    trade_id: row.get(4)?,
                    inst_id: row.get(5)?,
                    inst_type: row.get(6)?,
                    side: row.get(7)?,
                    pos_side: row.get(8)?,
                    sub_type: row.get(9)?,
                    fill_px: row.get(10)?,
                    fill_sz: row.get(11)?,
                    fill_pnl: row.get(12)?,
                    fee: row.get(13)?,
                    fee_ccy: row.get(14)?,
                    source_endpoint: row.get(15)?,
                    operator: row.get(16)?,
                    strategy_id: row.get(17)?,
                    session_id: row.get(18)?,
                    opportunity_id: row.get(19)?,
                    agent_run_id: row.get(20)?,
                    execution_key: row.get(21)?,
                    okx_ts: row.get(22)?,
                    synced_at: row.get(23)?,
                })
            },
        )
        .map_err(|err| err.to_string())?;
    let mut fills = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    if !order_ids.is_empty() || !bill_ids.is_empty() || !trade_ids.is_empty() {
        fills.retain(|item| {
            bill_ids.contains(&item.bill_id)
                || item
                    .ord_id
                    .as_ref()
                    .is_some_and(|id| order_ids.contains(id))
                || item
                    .trade_id
                    .as_ref()
                    .is_some_and(|id| trade_ids.contains(id))
        });
    }
    Ok(fills)
}

fn load_historical_orders(
    conn: &Connection,
    account_id: &str,
    environment: &str,
    inst_id: Option<&str>,
    limit: u16,
) -> Result<Vec<HistoricalOrderSummary>, String> {
    let mut sql = "SELECT account_id, environment, ord_id, cl_ord_id, inst_id, inst_type, side, pos_side, td_mode,
        ord_type, state, px, sz, acc_fill_sz, avg_px, pnl, fee, source_endpoint, operator, strategy_id,
        session_id, opportunity_id, agent_run_id, execution_key, okx_ctime, okx_utime, synced_at
        FROM okx_orders
        WHERE account_id = ?1 AND environment = ?2"
        .to_string();
    if inst_id.is_some() {
        sql.push_str(" AND inst_id = ?3");
        sql.push_str(" ORDER BY COALESCE(okx_utime, okx_ctime, synced_at) DESC LIMIT ?4");
    } else {
        sql.push_str(" ORDER BY COALESCE(okx_utime, okx_ctime, synced_at) DESC LIMIT ?3");
    }

    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let limit_value = i64::from(limit);
    let mapper = |row: &rusqlite::Row<'_>| {
        Ok(HistoricalOrderSummary {
            account_id: row.get(0)?,
            environment: row.get(1)?,
            ord_id: row.get(2)?,
            cl_ord_id: row.get(3)?,
            inst_id: row.get(4)?,
            inst_type: row.get(5)?,
            side: row.get(6)?,
            pos_side: row.get(7)?,
            td_mode: row.get(8)?,
            ord_type: row.get(9)?,
            state: row.get(10)?,
            px: row.get(11)?,
            sz: row.get(12)?,
            acc_fill_sz: row.get(13)?,
            avg_px: row.get(14)?,
            pnl: row.get(15)?,
            fee: row.get(16)?,
            source_endpoint: row.get(17)?,
            operator: row.get(18)?,
            strategy_id: row.get(19)?,
            session_id: row.get(20)?,
            opportunity_id: row.get(21)?,
            agent_run_id: row.get(22)?,
            execution_key: row.get(23)?,
            okx_ctime: row.get(24)?,
            okx_utime: row.get(25)?,
            synced_at: row.get(26)?,
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

fn load_historical_fills(
    conn: &Connection,
    account_id: &str,
    environment: &str,
    inst_id: Option<&str>,
    limit: u16,
) -> Result<Vec<HistoricalFillSummary>, String> {
    let mut sql = "SELECT account_id, environment, bill_id, ord_id, trade_id, inst_id, inst_type, side, pos_side,
        sub_type, fill_px, fill_sz, fill_pnl, fee, fee_ccy, source_endpoint, operator, strategy_id,
        session_id, opportunity_id, agent_run_id, execution_key, okx_ts, synced_at
        FROM okx_fills
        WHERE account_id = ?1 AND environment = ?2"
        .to_string();
    if inst_id.is_some() {
        sql.push_str(" AND inst_id = ?3");
        sql.push_str(" ORDER BY COALESCE(okx_ts, synced_at) DESC LIMIT ?4");
    } else {
        sql.push_str(" ORDER BY COALESCE(okx_ts, synced_at) DESC LIMIT ?3");
    }

    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let limit_value = i64::from(limit);
    let mapper = |row: &rusqlite::Row<'_>| {
        Ok(HistoricalFillSummary {
            account_id: row.get(0)?,
            environment: row.get(1)?,
            bill_id: row.get(2)?,
            ord_id: row.get(3)?,
            trade_id: row.get(4)?,
            inst_id: row.get(5)?,
            inst_type: row.get(6)?,
            side: row.get(7)?,
            pos_side: row.get(8)?,
            sub_type: row.get(9)?,
            fill_px: row.get(10)?,
            fill_sz: row.get(11)?,
            fill_pnl: row.get(12)?,
            fee: row.get(13)?,
            fee_ccy: row.get(14)?,
            source_endpoint: row.get(15)?,
            operator: row.get(16)?,
            strategy_id: row.get(17)?,
            session_id: row.get(18)?,
            opportunity_id: row.get(19)?,
            agent_run_id: row.get(20)?,
            execution_key: row.get(21)?,
            okx_ts: row.get(22)?,
            synced_at: row.get(23)?,
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

fn load_account_bills(
    conn: &Connection,
    account_id: &str,
    environment: &str,
    inst_id: Option<&str>,
    limit: u16,
) -> Result<Vec<AccountBillSummary>, String> {
    let mut sql =
        "SELECT account_id, environment, bill_id, inst_id, inst_type, ccy, bill_type, sub_type,
        bal, bal_chg, pos_bal, pos_bal_chg, sz, px, pnl, fee, ord_id, trade_id, cl_ord_id,
        exec_type, mgn_mode, notes, source_endpoint, okx_ts, synced_at
        FROM okx_account_bills
        WHERE account_id = ?1 AND environment = ?2"
            .to_string();
    if inst_id.is_some() {
        sql.push_str(" AND inst_id = ?3");
        sql.push_str(" ORDER BY COALESCE(okx_ts, synced_at) DESC LIMIT ?4");
    } else {
        sql.push_str(" ORDER BY COALESCE(okx_ts, synced_at) DESC LIMIT ?3");
    }

    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let limit_value = i64::from(limit);
    let mapper = |row: &rusqlite::Row<'_>| {
        Ok(AccountBillSummary {
            account_id: row.get(0)?,
            environment: row.get(1)?,
            bill_id: row.get(2)?,
            inst_id: row.get(3)?,
            inst_type: row.get(4)?,
            ccy: row.get(5)?,
            bill_type: row.get(6)?,
            sub_type: row.get(7)?,
            bal: row.get(8)?,
            bal_chg: row.get(9)?,
            pos_bal: row.get(10)?,
            pos_bal_chg: row.get(11)?,
            sz: row.get(12)?,
            px: row.get(13)?,
            pnl: row.get(14)?,
            fee: row.get(15)?,
            ord_id: row.get(16)?,
            trade_id: row.get(17)?,
            cl_ord_id: row.get(18)?,
            exec_type: row.get(19)?,
            mgn_mode: row.get(20)?,
            notes: row.get(21)?,
            source_endpoint: row.get(22)?,
            okx_ts: row.get(23)?,
            synced_at: row.get(24)?,
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

#[derive(Debug, Clone)]
struct PerformanceBillRow {
    ccy: Option<String>,
    bal: Option<String>,
    time: i64,
}

#[derive(Debug, Clone)]
struct PerformanceFillRow {
    inst_id: String,
    fill_pnl: Option<String>,
    fee: Option<String>,
    operator: String,
    time: i64,
}

#[derive(Debug, Clone)]
struct PerformanceEpisodeRow {
    id: String,
    inst_id: String,
    episode_side: String,
    status: String,
    primary_origin: String,
    open_time: i64,
    close_time: Option<i64>,
    max_qty: String,
    avg_open_px: Option<String>,
    realized_pnl: Option<String>,
    fees: Option<String>,
    funding_fee: Option<String>,
    liq_penalty: Option<String>,
    net_pnl: Option<String>,
}

#[derive(Debug, Default, Clone)]
struct PerformanceBucket {
    net_pnl: f64,
    fees: f64,
    trade_count: usize,
    episode_count: usize,
    wins: usize,
    closed_samples: usize,
}

#[derive(Debug, Default, Clone)]
struct DailyPerformanceBucket {
    net_pnl: f64,
    fees: f64,
    trade_count: usize,
}

fn account_performance_summary_impl(
    conn: &Connection,
    runtime: &MarketRuntime,
    account_id: &str,
    environment: &str,
    inst_id: Option<&str>,
    start_time: Option<i64>,
    end_time: Option<i64>,
) -> Result<AccountPerformanceSummary, String> {
    let bills =
        load_performance_bills(conn, account_id, environment, inst_id, start_time, end_time)?;
    let fills =
        load_performance_fills(conn, account_id, environment, inst_id, start_time, end_time)?;
    let episodes =
        load_performance_episodes(conn, account_id, environment, inst_id, start_time, end_time)?;
    Ok(build_account_performance_summary(
        account_id,
        environment,
        inst_id,
        start_time,
        end_time,
        bills,
        fills,
        episodes,
        ai_read_memory_account_snapshot(runtime, Some(account_id)),
    ))
}

fn load_performance_bills(
    conn: &Connection,
    account_id: &str,
    environment: &str,
    inst_id: Option<&str>,
    start_time: Option<i64>,
    end_time: Option<i64>,
) -> Result<Vec<PerformanceBillRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT ccy, bal, COALESCE(okx_ts, synced_at) AS event_time
             FROM okx_account_bills
             WHERE account_id=?1 AND environment=?2
               AND (?3 IS NULL OR inst_id=?3)
               AND (?4 IS NULL OR COALESCE(okx_ts, synced_at) >= ?4)
               AND (?5 IS NULL OR COALESCE(okx_ts, synced_at) <= ?5)
             ORDER BY event_time ASC, bill_id ASC",
        )
        .map_err(|err| err.to_string())?;
    let mut rows = stmt
        .query_map(
            params![account_id, environment, inst_id, start_time, end_time],
            |row| {
                Ok(PerformanceBillRow {
                    ccy: row.get(0)?,
                    bal: row.get(1)?,
                    time: row.get(2)?,
                })
            },
        )
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    if let Some(start) = start_time {
        let carry_forward = conn
            .query_row(
                "SELECT ccy, bal, COALESCE(okx_ts, synced_at) AS event_time
                 FROM okx_account_bills
                 WHERE account_id=?1 AND environment=?2
                   AND (?3 IS NULL OR inst_id=?3)
                   AND COALESCE(okx_ts, synced_at) < ?4
                   AND (ccy IS NULL OR ccy='' OR ccy='USDT')
                 ORDER BY event_time DESC, bill_id DESC
                 LIMIT 1",
                params![account_id, environment, inst_id, start],
                |row| {
                    Ok(PerformanceBillRow {
                        ccy: row.get(0)?,
                        bal: row.get(1)?,
                        time: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(|err| err.to_string())?;
        if let Some(row) = carry_forward {
            if rows
                .first()
                .map(|item| item.time != row.time)
                .unwrap_or(true)
            {
                rows.insert(0, row);
            }
        }
    }
    Ok(rows)
}

fn load_performance_fills(
    conn: &Connection,
    account_id: &str,
    environment: &str,
    inst_id: Option<&str>,
    start_time: Option<i64>,
    end_time: Option<i64>,
) -> Result<Vec<PerformanceFillRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT inst_id, fill_pnl, fee, operator, COALESCE(okx_ts, synced_at) AS event_time
             FROM okx_fills
             WHERE account_id=?1 AND environment=?2
               AND (?3 IS NULL OR inst_id=?3)
               AND (?4 IS NULL OR COALESCE(okx_ts, synced_at) >= ?4)
               AND (?5 IS NULL OR COALESCE(okx_ts, synced_at) <= ?5)
             ORDER BY event_time ASC, bill_id ASC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(
            params![account_id, environment, inst_id, start_time, end_time],
            |row| {
                Ok(PerformanceFillRow {
                    inst_id: row.get(0)?,
                    fill_pnl: row.get(1)?,
                    fee: row.get(2)?,
                    operator: row.get(3)?,
                    time: row.get(4)?,
                })
            },
        )
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    Ok(rows)
}

fn load_performance_episodes(
    conn: &Connection,
    account_id: &str,
    environment: &str,
    inst_id: Option<&str>,
    start_time: Option<i64>,
    end_time: Option<i64>,
) -> Result<Vec<PerformanceEpisodeRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, inst_id, episode_side, status, primary_origin, open_time, close_time, max_qty,
                    avg_open_px, realized_pnl, fees, funding_fee, liq_penalty, net_pnl
             FROM position_episodes
             WHERE account_id=?1 AND environment=?2
               AND (?3 IS NULL OR inst_id=?3)
               AND (?4 IS NULL OR COALESCE(close_time, open_time) >= ?4)
               AND (?5 IS NULL OR open_time <= ?5)
             ORDER BY open_time ASC, id ASC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(
            params![account_id, environment, inst_id, start_time, end_time],
            |row| {
                Ok(PerformanceEpisodeRow {
                    id: row.get(0)?,
                    inst_id: row.get(1)?,
                    episode_side: row.get(2)?,
                    status: row.get(3)?,
                    primary_origin: row.get(4)?,
                    open_time: row.get(5)?,
                    close_time: row.get(6)?,
                    max_qty: row.get(7)?,
                    avg_open_px: row.get(8)?,
                    realized_pnl: row.get(9)?,
                    fees: row.get(10)?,
                    funding_fee: row.get(11)?,
                    liq_penalty: row.get(12)?,
                    net_pnl: row.get(13)?,
                })
            },
        )
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    Ok(rows)
}

fn build_account_performance_summary(
    account_id: &str,
    environment: &str,
    inst_id: Option<&str>,
    start_time: Option<i64>,
    end_time: Option<i64>,
    bills: Vec<PerformanceBillRow>,
    fills: Vec<PerformanceFillRow>,
    episodes: Vec<PerformanceEpisodeRow>,
    snapshot: Option<PrivateAccountSnapshot>,
) -> AccountPerformanceSummary {
    let mut warnings = Vec::new();
    if inst_id.is_some() {
        warnings.push("当前按交易对筛选，账户级余额曲线仍会优先展示可用的账户权益点。".to_string());
    }
    if bills.iter().any(|item| {
        item.ccy
            .as_deref()
            .map(|ccy| ccy != "USDT")
            .unwrap_or(false)
    }) {
        warnings.push("检测到非 USDT 账单，第一版暂不做币种换算。".to_string());
    }

    let current_equity = snapshot
        .as_ref()
        .filter(|item| item.environment == environment)
        .and_then(snapshot_equity)
        .unwrap_or(0.0);
    let mut equity_curve = build_equity_curve(&bills, current_equity, start_time, end_time);
    let equity_oldest = equity_curve.first().map(|item| item.time);
    let equity_newest = equity_curve.last().map(|item| item.time);

    let mut totals = AccountPerformanceTotals {
        current_equity: equity_curve
            .last()
            .map(|item| item.equity)
            .unwrap_or(current_equity),
        start_equity: equity_curve.first().map(|item| item.equity),
        max_drawdown_pct: equity_curve
            .iter()
            .map(|item| item.drawdown_pct)
            .fold(0.0, f64::max),
        fill_count: fills.len(),
        ..AccountPerformanceTotals::default()
    };

    let mut attribution: BTreeMap<String, PerformanceBucket> = BTreeMap::new();
    let mut symbols: BTreeMap<String, PerformanceBucket> = BTreeMap::new();
    let mut daily: BTreeMap<String, DailyPerformanceBucket> = BTreeMap::new();

    if !episodes.is_empty() {
        for episode in &episodes {
            let pnl = episode_net_pnl(episode);
            let fees = money_abs(episode.fees.as_deref());
            let funding = money_value(episode.funding_fee.as_deref());
            totals.net_pnl += pnl;
            totals.fees += fees;
            totals.funding_fee += funding;
            totals.episode_count += 1;
            totals.trade_count += 1;
            if pnl > 0.0 {
                totals.gross_profit += pnl;
            } else if pnl < 0.0 {
                totals.gross_loss += pnl.abs();
            }
            let operator = normalize_performance_operator(&episode.primary_origin);
            update_performance_bucket(attribution.entry(operator).or_default(), pnl, fees, 1, 1);
            update_performance_bucket(
                symbols.entry(episode.inst_id.clone()).or_default(),
                pnl,
                fees,
                1,
                1,
            );
            let date = performance_date(episode.close_time.unwrap_or(episode.open_time));
            let bucket = daily.entry(date).or_default();
            bucket.net_pnl += pnl;
            bucket.fees += fees;
            bucket.trade_count += 1;
        }
    } else {
        warnings.push("暂无 PositionEpisode，收益归因暂以成交记录估算。".to_string());
        for fill in &fills {
            let pnl = money_value(fill.fill_pnl.as_deref()) + money_value(fill.fee.as_deref());
            let fees = money_abs(fill.fee.as_deref());
            totals.net_pnl += pnl;
            totals.fees += fees;
            totals.trade_count += 1;
            if pnl > 0.0 {
                totals.gross_profit += pnl;
            } else if pnl < 0.0 {
                totals.gross_loss += pnl.abs();
            }
            let operator = normalize_performance_operator(&fill.operator);
            update_performance_bucket(attribution.entry(operator).or_default(), pnl, fees, 1, 0);
            update_performance_bucket(
                symbols.entry(fill.inst_id.clone()).or_default(),
                pnl,
                fees,
                1,
                0,
            );
            let bucket = daily.entry(performance_date(fill.time)).or_default();
            bucket.net_pnl += pnl;
            bucket.fees += fees;
            bucket.trade_count += 1;
        }
    }

    let wins = if !episodes.is_empty() {
        episodes
            .iter()
            .filter(|item| episode_net_pnl(item) > 0.0)
            .count()
    } else {
        fills
            .iter()
            .filter(|item| {
                money_value(item.fill_pnl.as_deref()) + money_value(item.fee.as_deref()) > 0.0
            })
            .count()
    };
    let samples = if !episodes.is_empty() {
        episodes.len()
    } else {
        fills.len()
    };
    totals.win_rate_pct = pct_ratio(wins as f64, samples as f64);
    totals.profit_factor = if totals.gross_loss > 0.0 {
        Some(totals.gross_profit / totals.gross_loss)
    } else {
        None
    };
    if let Some(start) = totals
        .start_equity
        .filter(|value| value.abs() > f64::EPSILON)
    {
        totals.return_pct = Some((totals.current_equity - start) / start * 100.0);
    } else if totals.net_pnl.abs() > f64::EPSILON
        && totals.current_equity.abs() > totals.net_pnl.abs()
    {
        let estimated_start = totals.current_equity - totals.net_pnl;
        totals.start_equity = Some(estimated_start);
        totals.return_pct = Some(totals.net_pnl / estimated_start * 100.0);
    }

    let oldest = [
        equity_oldest,
        fills.iter().map(|item| item.time).min(),
        episodes.iter().map(|item| item.open_time).min(),
    ]
    .into_iter()
    .flatten()
    .min();
    let newest = [
        equity_newest,
        fills.iter().map(|item| item.time).max(),
        episodes
            .iter()
            .map(|item| item.close_time.unwrap_or(item.open_time))
            .max(),
    ]
    .into_iter()
    .flatten()
    .max();
    if bills.is_empty() {
        warnings.push("缺少账户账单，余额曲线可能只包含当前账户快照。".to_string());
    }
    if fills.is_empty() {
        warnings.push("缺少历史成交，交易次数和手续费可能不完整。".to_string());
    }

    let start_equity = totals.start_equity;
    let mut summary = AccountPerformanceSummary {
        account_id: account_id.to_string(),
        environment: environment.to_string(),
        start_time,
        end_time,
        generated_at: now_ms(),
        coverage: AccountPerformanceCoverage {
            has_bills: !bills.is_empty(),
            has_fills: !fills.is_empty(),
            has_episodes: !episodes.is_empty(),
            bills_count: bills.len(),
            fills_count: fills.len(),
            episodes_count: episodes.len(),
            oldest_point: oldest,
            newest_point: newest,
            warnings,
        },
        equity_curve: Vec::new(),
        totals,
        attribution: attribution
            .into_iter()
            .map(|(operator, bucket)| performance_attribution(operator, bucket, start_equity))
            .collect(),
        symbol_breakdown: symbols
            .into_iter()
            .map(|(symbol, bucket)| performance_symbol_breakdown(symbol, bucket))
            .collect(),
        highlights: build_performance_highlights(&episodes),
        daily_pnl: daily
            .into_iter()
            .map(|(date, bucket)| AccountPerformanceDailyPnl {
                date,
                net_pnl: bucket.net_pnl,
                fees: bucket.fees,
                trade_count: bucket.trade_count,
            })
            .collect(),
    };
    summary.symbol_breakdown.sort_by(|a, b| {
        b.net_pnl
            .partial_cmp(&a.net_pnl)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    summary.equity_curve.append(&mut equity_curve);
    summary
}

fn build_equity_curve(
    bills: &[PerformanceBillRow],
    current_equity: f64,
    start_time: Option<i64>,
    end_time: Option<i64>,
) -> Vec<AccountPerformancePoint> {
    const EQUITY_SAMPLE_STEP_MS: i64 = 3 * 60 * 60 * 1000;
    let mut equity_rows: Vec<(i64, f64)> = bills
        .iter()
        .filter(|item| item.ccy.as_deref().map(|ccy| ccy == "USDT").unwrap_or(true))
        .filter_map(|item| {
            item.bal
                .as_deref()
                .and_then(parse_optional_f64)
                .map(|equity| (item.time, equity))
        })
        .collect();
    if current_equity > 0.0 {
        let now = now_ms();
        let within_requested_end = end_time.map(|end| now <= end).unwrap_or(true);
        if within_requested_end
            && equity_rows
                .last()
                .map(|(time, equity)| *time < now && (*equity - current_equity).abs() > 1e-8)
                .unwrap_or(true)
        {
            equity_rows.push((now, current_equity));
        }
    }
    equity_rows.sort_by_key(|item| item.0);
    equity_rows.dedup_by_key(|item| item.0);
    if equity_rows.is_empty() {
        return Vec::new();
    }
    let first_time = equity_rows.first().map(|item| item.0).unwrap_or_default();
    let last_time = equity_rows.last().map(|item| item.0).unwrap_or(first_time);
    let sample_start = start_time.unwrap_or(first_time).max(first_time);
    let sample_end = end_time.unwrap_or(last_time).max(last_time);
    let needs_window_sampling = sample_start > first_time || sample_end > last_time;
    let sampled_rows = if needs_window_sampling
        || sample_end.saturating_sub(sample_start) > EQUITY_SAMPLE_STEP_MS
    {
        sample_equity_rows(
            &equity_rows,
            sample_start,
            sample_end,
            EQUITY_SAMPLE_STEP_MS,
        )
    } else {
        equity_rows
    };
    let start = sampled_rows.first().map(|item| item.1).unwrap_or_default();
    let mut peak = start.max(0.0);
    sampled_rows
        .into_iter()
        .map(|(time, equity)| {
            peak = peak.max(equity);
            let cumulative_return_pct = if start.abs() > f64::EPSILON {
                (equity - start) / start * 100.0
            } else {
                0.0
            };
            let drawdown_pct = if peak.abs() > f64::EPSILON {
                ((peak - equity) / peak * 100.0).max(0.0)
            } else {
                0.0
            };
            AccountPerformancePoint {
                time,
                equity,
                cumulative_return_pct,
                drawdown_pct,
            }
        })
        .collect()
}

fn sample_equity_rows(
    rows: &[(i64, f64)],
    sample_start: i64,
    sample_end: i64,
    step_ms: i64,
) -> Vec<(i64, f64)> {
    if rows.is_empty() || step_ms <= 0 {
        return rows.to_vec();
    }
    let mut result = Vec::new();
    let mut row_index = 0usize;
    let mut current_equity = rows[0].1;
    let mut sample_time = sample_start;
    loop {
        while row_index + 1 < rows.len() && rows[row_index + 1].0 <= sample_time {
            row_index += 1;
            current_equity = rows[row_index].1;
        }
        if rows[row_index].0 <= sample_time {
            current_equity = rows[row_index].1;
        }
        result.push((sample_time, current_equity));
        if sample_time >= sample_end {
            break;
        }
        sample_time = (sample_time + step_ms).min(sample_end);
    }
    result.dedup_by_key(|item| item.0);
    result
}

fn snapshot_equity(snapshot: &PrivateAccountSnapshot) -> Option<f64> {
    let total = snapshot
        .balances
        .iter()
        .filter_map(|item| parse_optional_f64(&item.eq))
        .sum::<f64>();
    if total > 0.0 {
        Some(total)
    } else {
        None
    }
}

fn episode_net_pnl(episode: &PerformanceEpisodeRow) -> f64 {
    episode
        .net_pnl
        .as_deref()
        .and_then(parse_optional_f64)
        .unwrap_or_else(|| {
            money_value(episode.realized_pnl.as_deref())
                + money_value(episode.fees.as_deref())
                + money_value(episode.funding_fee.as_deref())
                + money_value(episode.liq_penalty.as_deref())
        })
}

fn money_value(value: Option<&str>) -> f64 {
    value.and_then(parse_optional_f64).unwrap_or_default()
}

fn money_abs(value: Option<&str>) -> f64 {
    money_value(value).abs()
}

fn pct_ratio(numerator: f64, denominator: f64) -> Option<f64> {
    if denominator > 0.0 {
        Some(numerator / denominator * 100.0)
    } else {
        None
    }
}

fn normalize_performance_operator(value: &str) -> String {
    match value.trim() {
        "ai" | "agent" | "automation" => "ai".to_string(),
        "user" | "manual" => "user".to_string(),
        _ => "unknown".to_string(),
    }
}

fn performance_operator_label(operator: &str) -> String {
    match operator {
        "ai" => "AI".to_string(),
        "user" => "人工".to_string(),
        _ => "外部/未归因".to_string(),
    }
}

fn update_performance_bucket(
    bucket: &mut PerformanceBucket,
    pnl: f64,
    fees: f64,
    trade_count: usize,
    episode_count: usize,
) {
    bucket.net_pnl += pnl;
    bucket.fees += fees;
    bucket.trade_count += trade_count;
    bucket.episode_count += episode_count;
    if pnl > 0.0 {
        bucket.wins += 1;
    }
    bucket.closed_samples +=
        usize::from(pnl.abs() > f64::EPSILON || episode_count > 0 || trade_count > 0);
}

fn performance_attribution(
    operator: String,
    bucket: PerformanceBucket,
    start_equity: Option<f64>,
) -> AccountPerformanceAttribution {
    AccountPerformanceAttribution {
        label: performance_operator_label(&operator),
        operator,
        net_pnl: bucket.net_pnl,
        return_pct: start_equity
            .filter(|value| value.abs() > f64::EPSILON)
            .map(|value| bucket.net_pnl / value * 100.0),
        fees: bucket.fees,
        trade_count: bucket.trade_count,
        episode_count: bucket.episode_count,
        win_rate_pct: pct_ratio(bucket.wins as f64, bucket.closed_samples as f64),
    }
}

fn performance_symbol_breakdown(
    inst_id: String,
    bucket: PerformanceBucket,
) -> AccountPerformanceSymbolBreakdown {
    AccountPerformanceSymbolBreakdown {
        inst_id,
        net_pnl: bucket.net_pnl,
        fees: bucket.fees,
        trade_count: bucket.trade_count,
        episode_count: bucket.episode_count,
        win_rate_pct: pct_ratio(bucket.wins as f64, bucket.closed_samples as f64),
    }
}

fn build_performance_highlights(
    episodes: &[PerformanceEpisodeRow],
) -> AccountPerformanceHighlights {
    let closed: Vec<&PerformanceEpisodeRow> = episodes
        .iter()
        .filter(|item| item.close_time.is_some() || item.status == "closed")
        .collect();
    AccountPerformanceHighlights {
        best_episode: closed
            .iter()
            .max_by(|a, b| {
                episode_net_pnl(a)
                    .partial_cmp(&episode_net_pnl(b))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|item| performance_highlight(item)),
        worst_episode: closed
            .iter()
            .min_by(|a, b| {
                episode_net_pnl(a)
                    .partial_cmp(&episode_net_pnl(b))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|item| performance_highlight(item)),
        longest_episode: closed
            .iter()
            .max_by_key(|item| episode_duration_ms(item).unwrap_or_default())
            .map(|item| performance_highlight(item)),
        shortest_episode: closed
            .iter()
            .filter(|item| episode_duration_ms(item).unwrap_or_default() > 0)
            .min_by_key(|item| episode_duration_ms(item).unwrap_or_default())
            .map(|item| performance_highlight(item)),
    }
}

fn performance_highlight(episode: &PerformanceEpisodeRow) -> PerformanceEpisodeHighlight {
    let pnl = episode_net_pnl(episode);
    let avg_open = money_value(episode.avg_open_px.as_deref());
    let qty = money_abs(Some(&episode.max_qty));
    let denominator = avg_open * qty;
    PerformanceEpisodeHighlight {
        id: episode.id.clone(),
        inst_id: episode.inst_id.clone(),
        side: episode.episode_side.clone(),
        status: episode.status.clone(),
        net_pnl: pnl,
        return_pct: if denominator > f64::EPSILON {
            Some(pnl / denominator * 100.0)
        } else {
            None
        },
        open_time: episode.open_time,
        close_time: episode.close_time,
        duration_ms: episode_duration_ms(episode),
        max_qty: episode.max_qty.clone(),
        fees: money_abs(episode.fees.as_deref()),
        funding_fee: money_value(episode.funding_fee.as_deref()),
    }
}

fn episode_duration_ms(episode: &PerformanceEpisodeRow) -> Option<i64> {
    episode
        .close_time
        .map(|close| (close - episode.open_time).max(0))
}

fn performance_date(time_ms: i64) -> String {
    let shanghai_ms = time_ms + 8 * 60 * 60 * 1000;
    Utc.timestamp_millis_opt(shanghai_ms)
        .single()
        .map(|time| format!("{:04}-{:02}-{:02}", time.year(), time.month(), time.day()))
        .unwrap_or_else(|| "unknown".to_string())
}

fn normalize_archive_quarter(
    year: &str,
    quarter: &str,
    bill_type: Option<&str>,
) -> Result<(String, String, Option<String>), String> {
    let year = year.trim();
    if year.len() != 4 || !year.chars().all(|ch| ch.is_ascii_digit()) {
        return Err("账单归档年份必须是 4 位数字".to_string());
    }
    let quarter = quarter.trim().to_ascii_uppercase();
    if !matches!(quarter.as_str(), "Q1" | "Q2" | "Q3" | "Q4") {
        return Err("账单归档季度必须是 Q1/Q2/Q3/Q4".to_string());
    }
    let bill_type = bill_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    Ok((year.to_string(), quarter, bill_type))
}

fn upsert_account_bills_archive_status(
    conn: &Connection,
    account: &LocalAccount,
    year: &str,
    quarter: &str,
    bill_type: Option<&str>,
    requested: bool,
    row: &serde_json::Value,
) -> Result<AccountBillsArchiveStatus, String> {
    let now = now_ms();
    let request_result = json_string(row, "result");
    let state = json_string(row, "state");
    let file_href = json_string(row, "fileHref");
    let okx_ts = json_i64(row, "ts");
    let raw_json = private_exchange_json(row)?;
    let bill_type_key = bill_type.unwrap_or("");
    conn.execute(
        "INSERT INTO okx_account_bills_archives (
          account_id, environment, year, quarter, bill_type, request_result, state, file_href, okx_ts, raw_json, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        ON CONFLICT(account_id, environment, year, quarter, bill_type) DO UPDATE SET
          request_result=COALESCE(excluded.request_result, okx_account_bills_archives.request_result),
          state=COALESCE(excluded.state, okx_account_bills_archives.state),
          file_href=COALESCE(excluded.file_href, okx_account_bills_archives.file_href),
          okx_ts=COALESCE(excluded.okx_ts, okx_account_bills_archives.okx_ts),
          raw_json=excluded.raw_json,
          updated_at=excluded.updated_at",
        params![
            account.id,
            account.environment,
            year,
            quarter,
            bill_type_key,
            request_result,
            state,
            file_href,
            okx_ts,
            raw_json,
            now
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(AccountBillsArchiveStatus {
        account_id: account.id.clone(),
        environment: account.environment.clone(),
        year: year.to_string(),
        quarter: quarter.to_string(),
        bill_type: bill_type.map(|value| value.to_string()),
        requested,
        request_result: json_string(row, "result"),
        state: json_string(row, "state"),
        file_href: json_string(row, "fileHref"),
        okx_ts,
        updated_at: now,
        raw_json: Some(raw_json),
    })
}

async fn fetch_account_bills_archive_status_row(
    account: &LocalAccount,
    year: &str,
    quarter: &str,
    bill_type: Option<&str>,
) -> Result<serde_json::Value, String> {
    let mut path = format!(
        "/api/v5/account/bills-history-archive?year={}&quarter={}",
        url_encode(year),
        url_encode(quarter)
    );
    if let Some(value) = bill_type {
        path.push_str("&type=");
        path.push_str(&url_encode(value));
    }
    let envelope = okx_private_get::<serde_json::Value>(account, &path).await?;
    Ok(envelope
        .data
        .into_iter()
        .next()
        .unwrap_or_else(|| json!({ "state": "unknown" })))
}

fn load_account_bills_archive_status(
    conn: &Connection,
    account: &LocalAccount,
    year: &str,
    quarter: &str,
    bill_type: Option<&str>,
) -> Result<Option<AccountBillsArchiveStatus>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT request_result, state, file_href, okx_ts, raw_json, updated_at
             FROM okx_account_bills_archives
             WHERE account_id = ?1 AND environment = ?2 AND year = ?3 AND quarter = ?4 AND bill_type = ?5",
        )
        .map_err(|err| err.to_string())?;
    let mut rows = stmt
        .query(params![
            account.id,
            account.environment,
            year,
            quarter,
            bill_type.unwrap_or("")
        ])
        .map_err(|err| err.to_string())?;
    let Some(row) = rows.next().map_err(|err| err.to_string())? else {
        return Ok(None);
    };
    Ok(Some(AccountBillsArchiveStatus {
        account_id: account.id.clone(),
        environment: account.environment.clone(),
        year: year.to_string(),
        quarter: quarter.to_string(),
        bill_type: bill_type.map(|value| value.to_string()),
        requested: false,
        request_result: row.get(0).map_err(|err| err.to_string())?,
        state: row.get(1).map_err(|err| err.to_string())?,
        file_href: row.get(2).map_err(|err| err.to_string())?,
        okx_ts: row.get(3).map_err(|err| err.to_string())?,
        raw_json: row.get(4).map_err(|err| err.to_string())?,
        updated_at: row.get(5).map_err(|err| err.to_string())?,
    }))
}

async fn download_account_bills_archive_file(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    year: &str,
    quarter: &str,
    bill_type: Option<&str>,
    file_href: &str,
) -> Result<(PathBuf, Vec<u8>), String> {
    let response = reqwest_client()?
        .get(file_href)
        .send()
        .await
        .map_err(|err| format!("下载账单归档失败: {}", err))?;
    if !response.status().is_success() {
        return Err(format!("下载账单归档失败: HTTP {}", response.status()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|err| format!("读取账单归档失败: {}", err))?
        .to_vec();
    let ext = if is_zip_bytes(&bytes) { "zip" } else { "csv" };
    let dir = account_bills_archive_dir(app)?;
    let safe_account = sanitize_filename(&account.id);
    let safe_type = bill_type
        .map(sanitize_filename)
        .unwrap_or_else(|| "all".to_string());
    let path = dir.join(format!(
        "{}-{}-{}-{}-{}.{}",
        safe_account,
        sanitize_filename(&account.environment),
        year,
        quarter,
        safe_type,
        ext
    ));
    fs::write(&path, &bytes).map_err(|err| format!("保存账单归档失败: {}", err))?;
    Ok((path, bytes))
}

fn extract_account_bill_archive_rows(bytes: &[u8]) -> Result<Vec<serde_json::Value>, String> {
    if is_zip_bytes(bytes) {
        let reader = Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(reader)
            .map_err(|err| format!("解析账单归档 ZIP 失败: {}", err))?;
        let mut rows = Vec::new();
        for index in 0..archive.len() {
            let mut file = archive.by_index(index).map_err(|err| err.to_string())?;
            if !file.name().to_ascii_lowercase().ends_with(".csv") {
                continue;
            }
            let mut csv_bytes = Vec::new();
            file.read_to_end(&mut csv_bytes)
                .map_err(|err| format!("读取账单归档 CSV 失败: {}", err))?;
            rows.extend(parse_account_bill_archive_csv(&csv_bytes)?);
        }
        if rows.is_empty() {
            return Err("账单归档 ZIP 中未找到可导入的 CSV 文件".to_string());
        }
        return Ok(rows);
    }
    parse_account_bill_archive_csv(bytes)
}

fn parse_account_bill_archive_csv(bytes: &[u8]) -> Result<Vec<serde_json::Value>, String> {
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(Cursor::new(bytes));
    let headers = reader
        .headers()
        .map_err(|err| format!("读取账单归档 CSV 表头失败: {}", err))?
        .clone();
    let mut rows = Vec::new();
    for record in reader.records() {
        let record = record.map_err(|err| format!("读取账单归档 CSV 行失败: {}", err))?;
        let mut map = serde_json::Map::new();
        for (index, value) in record.iter().enumerate() {
            let Some(header) = headers
                .get(index)
                .map(str::trim)
                .filter(|header| !header.is_empty())
            else {
                continue;
            };
            map.insert(header.to_string(), json!(value.trim()));
        }
        if !map.is_empty() {
            rows.push(serde_json::Value::Object(map));
        }
    }
    Ok(rows)
}

fn is_zip_bytes(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && bytes[0] == b'P' && bytes[1] == b'K' && bytes[2] == 3 && bytes[3] == 4
}

fn account_bills_archive_dir(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = runtime_cache_root().join("account-bills-archives");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn sanitize_filename(value: &str) -> String {
    let safe = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if safe.trim_matches('_').is_empty() {
        "item".to_string()
    } else {
        safe
    }
}

fn json_string(row: &serde_json::Value, key: &str) -> Option<String> {
    row.get(key).and_then(|value| {
        if let Some(text) = value.as_str() {
            Some(text.to_string())
        } else if value.is_number() || value.is_boolean() {
            Some(value.to_string())
        } else {
            None
        }
    })
}

fn json_i64(row: &serde_json::Value, key: &str) -> Option<i64> {
    let value = row.get(key)?;
    value
        .as_i64()
        .or_else(|| value.as_str()?.parse::<i64>().ok())
}

fn emit_kline_sync(app: &tauri::AppHandle, report: &KlineSyncReport) {
    let _ = app.emit(KLINE_SYNC_EVENT, report);
}

fn ai_book_level_text(level: Option<&serde_json::Value>) -> String {
    level
        .map(|item| {
            let (px, sz) = if let Some(items) = item.as_array() {
                (
                    items.first().and_then(Value::as_str),
                    items.get(1).and_then(Value::as_str),
                )
            } else {
                (
                    item.get("px").and_then(Value::as_str),
                    item.get("sz").and_then(Value::as_str),
                )
            };
            format!("{} / {}", px.unwrap_or("--"), sz.unwrap_or("--"))
        })
        .unwrap_or_else(|| "--".to_string())
}

fn ai_orderbook_snapshot_id(inst_id: &str, observed_at: i64, seq_id: Option<&str>) -> String {
    match seq_id.filter(|value| !value.trim().is_empty()) {
        Some(seq_id) => format!("{inst_id}:{seq_id}"),
        None => format!("{inst_id}:{observed_at}"),
    }
}

fn ai_book_size_sum(levels: &[serde_json::Value]) -> f64 {
    levels
        .iter()
        .filter_map(|item| item.as_array()?.get(1)?.as_str()?.parse::<f64>().ok())
        .sum()
}

fn append_ai_process_event(events: &mut Vec<serde_json::Value>, event_type: &str, content: &str) {
    if content.is_empty() {
        return;
    }
    if let Some(last) = events.last_mut().and_then(serde_json::Value::as_object_mut) {
        if last.get("type").and_then(serde_json::Value::as_str) == Some(event_type) {
            if let Some(serde_json::Value::String(existing)) = last.get_mut("content") {
                existing.push_str(content);
                return;
            }
        }
    }
    events.push(json!({ "type": event_type, "content": content }));
}

#[derive(Debug, PartialEq, Eq)]
struct AiStreamTerminalState {
    message_status: &'static str,
    session_status: &'static str,
    synthetic_finish_reason: Option<&'static str>,
}

fn ai_stream_terminal_state(
    was_cancelled: bool,
    done_emitted: bool,
    has_error: bool,
) -> AiStreamTerminalState {
    if was_cancelled {
        return AiStreamTerminalState {
            message_status: "cancelled",
            session_status: "idle",
            synthetic_finish_reason: Some("cancelled"),
        };
    }
    if has_error {
        return AiStreamTerminalState {
            message_status: "failed",
            session_status: "failed",
            synthetic_finish_reason: None,
        };
    }
    AiStreamTerminalState {
        message_status: "done",
        session_status: "idle",
        synthetic_finish_reason: (!done_emitted).then_some("completed"),
    }
}

fn is_recoverable_strategy_ai_tool_error(session_id: &str, message: &str) -> bool {
    if !session_id.starts_with("systematic-strategy-ai-") {
        return false;
    }
    let Some((count, detail)) = message
        .trim()
        .split_once(" tool call(s) failed:")
    else {
        return false;
    };
    count
        .parse::<usize>()
        .is_ok_and(|count| count > 0 && detail.trim_start().starts_with('['))
}

async fn run_ai_stream(
    app: tauri::AppHandle,
    runtime: AiRuntime,
    session_id: String,
    messages: Vec<AiChatMessage>,
    run_context: Option<BackgroundRunContext>,
    options: Option<AiStreamOptions>,
) -> Result<(), String> {
    let mut config = if run_context.is_none() {
        let _config_write_guard = crate::storage_config::lock_ai_config_writes()?;
        let config = crate::storage_config::load_ai_config_locked(&app)?;
        crate::storage_config::sync_cline_skill_files_from_config(&config)?;
        config
    } else {
        load_ai_config(&app)?
    };
    let mut active_skill_ids = config.enabled_skills.clone();
    if let Some(context) = run_context.as_ref() {
        if let Some(model) = context
            .model
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            config = crate::storage_config::select_ai_model(&config, Some(model))?;
        }
        config.permission_mode =
            desic_agent_automation::normalize_permission_mode(Some(&context.permission_mode))
                .to_string();
        config.reasoning_depth = context.reasoning_depth.clone();
        config.enabled_skills = context.enabled_skills.clone();
        active_skill_ids = context.enabled_skills.clone();
        config.skill_definitions = context.skill_definitions.clone();
        let locked_skills = context
            .skill_definitions
            .iter()
            .filter(|skill| skill.id != "desic-core-operations")
            .map(|skill| {
                let version = context.skill_versions.get(&skill.id).copied().unwrap_or(1);
                format!(
                    "### Skill: {} (锁定版本 {})\n{}\n{}",
                    skill.name,
                    version,
                    skill.rules.trim(),
                    skill.content.trim()
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        if !locked_skills.trim().is_empty() {
            config.custom_rules = format!(
                "{}\n\n本次 Agent Run 使用以下不可变 Skill 快照：\n{}",
                config.custom_rules.trim(),
                locked_skills
            )
            .trim()
            .to_string();
        }
        config.enabled_skills.clear();
    }
    if let Some(options) = options.as_ref() {
        if let Some(model_id) = options
            .model_id
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            config = crate::storage_config::select_ai_model(&config, Some(model_id))?;
        }
        if let Some(permission_mode) = options
            .permission_mode
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            config.permission_mode =
                desic_agent_automation::normalize_permission_mode(Some(permission_mode))
                    .to_string();
        }
        if let Some(reasoning_depth) = options
            .reasoning_depth
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            config.reasoning_depth =
                crate::storage_config::normalize_ai_reasoning_depth(Some(reasoning_depth));
        }
        if let Some(system_prompt) = options.system_prompt.as_ref() {
            config.system_prompt = system_prompt.clone();
        }
        if let Some(custom_rules) = options.custom_rules.as_ref() {
            config.custom_rules = custom_rules.clone();
        }
        if let Some(enabled_skills) = options.enabled_skills.as_ref() {
            config.enabled_skills = enabled_skills.clone();
            active_skill_ids = enabled_skills.clone();
        }
        if options.clear_skill_definitions {
            config.enabled_skills.clear();
            config.skill_definitions.clear();
        }
        for skill in &options.runtime_scoped_skills {
            crate::storage_config::sync_cline_runtime_scoped_skill(skill)?;
            if let Some(existing) = config
                .skill_definitions
                .iter_mut()
                .find(|item| item.id == skill.id)
            {
                *existing = skill.clone();
            } else {
                config.skill_definitions.push(skill.clone());
            }
        }
    }
    let disable_skills_tool = options
        .as_ref()
        .and_then(|value| value.disable_skills_tool)
        .unwrap_or(run_context.is_some());
    let enable_spawn_agent = if run_context.is_some() {
        false
    } else {
        options
            .as_ref()
            .and_then(|value| value.enable_spawn_agent)
            .unwrap_or(true)
    };
    let enable_agent_teams = if run_context.is_some() {
        false
    } else {
        options
            .as_ref()
            .and_then(|value| value.enable_agent_teams)
            .unwrap_or(false)
    };
    let max_iterations = options
        .as_ref()
        .and_then(|value| value.max_iterations)
        .unwrap_or(if run_context.is_some() { 30 } else { 50 });
    let tool_allowlist = options
        .as_ref()
        .map(|value| value.tool_allowlist.clone())
        .unwrap_or_default();
    let required_tool_name = options
        .as_ref()
        .and_then(|value| value.required_tool_name.as_deref())
        .filter(|value| !value.trim().is_empty())
        .map(|value| canonical_ai_tool_name(value).to_string());
    let account_context_id = if let Some(context) = run_context.as_ref() {
        context.account_id.clone()
    } else {
        options
            .as_ref()
            .and_then(|value| value.interactive_account_id.clone())
    };
    let required_tool_satisfied = Arc::new(AtomicBool::new(required_tool_name.is_none()));
    let tool_read_semaphore = Arc::new(Semaphore::new(4));
    let tool_execution_gate = Arc::new(AsyncRwLock::new(()));
    let mut assistant_text = String::new();
    let mut assistant_reasoning = String::new();
    let mut tool_events: Vec<serde_json::Value> = Vec::new();
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<AiEvent>();
    runtime
        .session_sinks
        .lock()
        .map_err(|err| err.to_string())?
        .insert(session_id.clone(), event_tx);
    if let Ok(mut cancelled) = runtime.session_cancelled.lock() {
        cancelled.remove(&session_id);
    }
    let local_cli_program = match config.provider.as_deref() {
        Some("openai-codex-cli") => Some("codex"),
        Some("claude-code") => Some("claude"),
        _ => None,
    };
    let local_cli_path = if let Some(program) = local_cli_program {
        crate::storage_config::resolve_ai_cli_executable(program)
            .await
            .map(|(path, _)| path.to_string_lossy().into_owned())
    } else {
        None
    };
    let codex_provider_route = if config.provider.as_deref() == Some("openai-codex-cli") {
        crate::storage_config::load_codex_provider_route()?
    } else {
        None
    };
    let usage_provider = config
        .provider
        .clone()
        .unwrap_or_else(|| "openai-compatible".to_string());
    let usage_model_id = if config.active_model_id.trim().is_empty() {
        config.model.clone()
    } else {
        config.active_model_id.clone()
    };
    let usage_model = config.model.clone();
    let usage_model_name = config
        .models
        .iter()
        .find(|item| item.id == config.active_model_id)
        .map(|item| item.name.clone())
        .unwrap_or_else(|| config.model.clone());
    let payload = json!({
        "type": "sendMessage",
        "sessionId": session_id,
        "config": {
            "provider": config.provider.clone().unwrap_or_else(|| "openai-compatible".to_string()),
            "model": config.model.clone(),
            "baseUrl": config.base_url.clone(),
            "apiKey": config.api_key.clone(),
            "localCliPath": local_cli_path,
            "codexProviderRoute": codex_provider_route,
            "stream": config.stream.unwrap_or(true),
            "permissionMode": config.permission_mode.clone(),
            "reasoningDepth": config.reasoning_depth.clone(),
            "agentRole": "main",
            "backgroundRun": run_context.as_ref().map(BackgroundRunContext::is_background).unwrap_or(false),
            "reviewRun": run_context.as_ref().map(BackgroundRunContext::is_review).unwrap_or(false),
            "agentRunId": run_context.as_ref().and_then(|context| context.run_id.clone()),
            "agentProfileId": run_context.as_ref().and_then(|context| context.profile_id.clone()),
            "agentProfileAccountId": run_context.as_ref().and_then(|context| context.account_id.clone()),
            "agentProfileTargetLeverage": run_context.as_ref().map(|context| context.target_leverage),
            "agentProfileMaxSingleTradeMarginPct": run_context.as_ref().map(|context| context.max_single_trade_margin_pct),
            "interactiveAccountId": account_context_id.clone(),
            "agentProfileSymbols": run_context.as_ref().map(|context| context.symbols.clone()).unwrap_or_default(),
            "skillVersions": run_context.as_ref().map(|context| context.skill_versions.clone()).unwrap_or_default(),
            "multiAgentMode": run_context
                .as_ref()
                .map(|context| context.multi_agent_mode.clone())
                .unwrap_or_else(|| desic_agent_automation::MULTI_AGENT_OFF_MODE.to_string()),
            "multiAgentMaxAgents": run_context
                .as_ref()
                .map(|context| context.multi_agent_max_agents)
                .unwrap_or(4),
            "multiAgents": run_context
                .as_ref()
                .map(|context| context.multi_agents.clone())
                .unwrap_or_default(),
            "reviewId": run_context.as_ref().and_then(|context| context.review_id.clone()),
            "episodeId": run_context.as_ref().and_then(|context| context.episode_id.clone()),
            "enableSpawnAgent": enable_spawn_agent,
            "enableAgentTeams": enable_agent_teams,
            "disableSkillsTool": disable_skills_tool,
            "streamFallbackText": options.as_ref().map(|value| value.stream_fallback_text).unwrap_or(false),
            "maxIterations": max_iterations,
            "toolAllowlist": tool_allowlist.clone(),
            "systemPrompt": config.system_prompt.clone(),
            "customRules": config.custom_rules.clone(),
            "enabledSkills": config.enabled_skills.clone(),
            "activeSkillIds": active_skill_ids.clone(),
            "skillDefinitions": config.skill_definitions.clone()
        },
        "messages": messages
            .into_iter()
            .map(|message| json!({ "id": message.id, "role": message.role, "content": message.content }))
            .collect::<Vec<_>>()
    });
    emit_ai(
        &app,
        AiEvent::Status {
            session_id: session_id.clone(),
            status: "streaming".to_string(),
            message: "ClineCore 正在生成".to_string(),
        },
    );

    send_ai_sidecar_command(&app, &runtime, payload).await?;
    let mut done_emitted = false;
    let mut error_message: Option<String> = None;
    while let Some(event) = event_rx.recv().await {
        if ai_session_cancelled(&runtime, &session_id) {
            done_emitted = true;
            break;
        }
        // Cline can report a failed tool as an intermediate agent error and
        // continue with a repair tool call in the same turn. Treating that
        // duplicate diagnostic as terminal removes the session sink before
        // the repair request arrives, leaving the next tool pending forever.
        // The authoritative failed ToolResult remains visible and persisted.
        let recoverable_strategy_tool_error = matches!(
            &event,
            AiEvent::Error { message, .. }
                if is_recoverable_strategy_ai_tool_error(&session_id, message)
        );
        match &event {
            AiEvent::Delta {
                channel, content, ..
            } => {
                if channel == "text-final" {
                    assistant_text.clone_from(content);
                } else if channel == "reasoning-final" {
                    assistant_reasoning.clone_from(content);
                } else if channel == "text-preview" || channel == "text-preview-clear" {
                    // Preview events are transient UI state. The authoritative final text
                    // arrives through AgentDoneEvent and is persisted as text-final.
                } else if channel == "reasoning" {
                    append_ai_process_event(&mut tool_events, "processReasoning", content);
                } else {
                    append_ai_process_event(&mut tool_events, "processText", content);
                }
            }
            AiEvent::ToolCall {
                tool_call_id,
                name,
                arguments,
                allowed,
                blocked,
                policy,
                agent_id,
                configured_agent_id,
                parent_agent_id,
                started_at,
                ..
            } => {
                tool_events.push(json!({
                    "type": "toolCall",
                    "toolCallId": tool_call_id,
                    "name": name,
                    "arguments": arguments,
                    "allowed": allowed,
                    "blocked": blocked,
                    "policy": policy,
                    "agentId": agent_id,
                    "configuredAgentId": configured_agent_id,
                    "parentAgentId": parent_agent_id,
                    "startedAt": started_at
                }));
            }
            AiEvent::ToolResult {
                tool_call_id,
                name,
                result,
                summary,
                ok,
                agent_id,
                configured_agent_id,
                parent_agent_id,
                started_at,
                ended_at,
                requested_at,
                execution_started_at,
                execution_ended_at,
                ..
            } => {
                tool_events.push(json!({
                    "toolCallId": tool_call_id,
                    "name": name,
                    "result": result,
                    "summary": summary,
                    "ok": ok,
                    "agentId": agent_id,
                    "configuredAgentId": configured_agent_id,
                    "parentAgentId": parent_agent_id,
                    "startedAt": started_at,
                    "endedAt": ended_at,
                    "requestedAt": requested_at,
                    "executionStartedAt": execution_started_at,
                    "executionEndedAt": execution_ended_at,
                    "type": "toolResult"
                }));
            }
            AiEvent::Usage { usage, .. } => {
                tool_events.push(json!({
                    "type": "usage",
                    "usage": usage
                }));
            }
            AiEvent::AgentStart {
                agent_id,
                configured_agent_id,
                parent_agent_id,
                role,
                title,
                task,
                started_at,
                ..
            } => {
                tool_events.push(json!({
                    "type": "agentStart",
                    "agentId": agent_id,
                    "configuredAgentId": configured_agent_id,
                    "parentAgentId": parent_agent_id,
                    "role": role,
                    "title": title,
                    "task": task,
                    "startedAt": started_at
                }));
            }
            AiEvent::AgentDone {
                agent_id,
                configured_agent_id,
                status,
                result,
                error,
                ended_at,
                ..
            } => {
                tool_events.push(json!({
                    "type": "agentDone",
                    "agentId": agent_id,
                    "configuredAgentId": configured_agent_id,
                    "status": status,
                    "result": result,
                    "error": error,
                    "endedAt": ended_at
                }));
            }
            AiEvent::TeamEvent { event, .. } => {
                tool_events.push(json!({
                    "type": "teamEvent",
                    "event": event
                }));
            }
            AiEvent::ApprovalRequest {
                approval_id,
                tool_call_id,
                tool_name,
                input,
                reason,
                ..
            } => {
                tool_events.push(json!({
                    "type": "approvalRequest",
                    "approvalId": approval_id,
                    "toolCallId": tool_call_id,
                    "toolName": tool_name,
                    "input": input,
                    "reason": reason
                }));
            }
            AiEvent::ApprovalResolved {
                approval_id,
                approved,
                reason,
                ..
            } => {
                tool_events.push(json!({
                    "type": "approvalResolved",
                    "approvalId": approval_id,
                    "approved": approved,
                    "reason": reason
                }));
            }
            AiEvent::ToolExecuteRequest {
                execution_id,
                tool_name,
                input,
                parent_agent_id,
                agent_role,
                configured_agent_id,
                configured_agent_scopes,
                agent_run_id,
                agent_profile_id,
                review_id,
                episode_id,
                requested_at,
                ..
            } => {
                let execution_context = AiToolExecutionContext {
                    session_id: session_id.clone(),
                    permission_mode: config.permission_mode.clone(),
                    tool_allowlist: tool_allowlist
                        .iter()
                        .map(|name| canonical_ai_tool_name(name).to_string())
                        .collect(),
                    parent_agent_id: parent_agent_id.clone(),
                    agent_role: agent_role.clone(),
                    configured_agent_id: configured_agent_id.clone(),
                    configured_agent_scopes: configured_agent_scopes.clone(),
                    declared_agent_run_id: agent_run_id.clone(),
                    declared_agent_profile_id: agent_profile_id.clone(),
                    declared_review_id: review_id.clone(),
                    declared_episode_id: episode_id.clone(),
                    active_skill_ids: active_skill_ids.iter().cloned().collect(),
                    account_context_id: account_context_id.clone(),
                    run_context: run_context.clone(),
                };
                let task_app = app.clone();
                let task_runtime = runtime.clone();
                let task_session_id = session_id.clone();
                let task_execution_id = execution_id.clone();
                let task_tool_name = tool_name.clone();
                let task_input = input.clone();
                let task_api_key = config.api_key.clone();
                let task_required_tool_name = required_tool_name.clone();
                let task_required_tool_satisfied = required_tool_satisfied.clone();
                let task_read_semaphore = tool_read_semaphore.clone();
                let task_execution_gate = tool_execution_gate.clone();
                let task_requested_at = requested_at.unwrap_or_else(now_ms);
                tauri::async_runtime::spawn(async move {
                    let received_at = now_ms();
                    let (result, execution_started_at, execution_ended_at) =
                        if ai_tool_allows_concurrent_execution(&task_tool_name) {
                            match task_read_semaphore.acquire_owned().await {
                                Ok(_permit) => {
                                    let _read_guard = task_execution_gate.read().await;
                                    let execution_started_at = now_ms();
                                    let result = execute_ai_tool(
                                        task_app.clone(),
                                        &task_tool_name,
                                        task_input,
                                        &execution_context,
                                    )
                                    .await;
                                    (result, execution_started_at, now_ms())
                                }
                                Err(error) => {
                                    let timestamp = now_ms();
                                    (
                                        Err(format!("AI 只读工具并发控制不可用：{error}")),
                                        timestamp,
                                        timestamp,
                                    )
                                }
                            }
                        } else {
                            let _write_guard = task_execution_gate.write().await;
                            let execution_started_at = now_ms();
                            let result = execute_ai_tool(
                                task_app.clone(),
                                &task_tool_name,
                                task_input,
                                &execution_context,
                            )
                            .await;
                            (result, execution_started_at, now_ms())
                        };
                    let timing = json!({
                        "requestedAt": task_requested_at,
                        "receivedAt": received_at,
                        "executionStartedAt": execution_started_at,
                        "executionEndedAt": execution_ended_at,
                        "queueMs": execution_started_at.saturating_sub(task_requested_at),
                        "executionMs": execution_ended_at.saturating_sub(execution_started_at)
                    });
                    let payload = match result {
                        Ok(value) => {
                            if task_required_tool_name.as_deref().is_some_and(|required| {
                                canonical_ai_tool_name(&task_tool_name) == required
                            }) {
                                task_required_tool_satisfied.store(true, Ordering::Release);
                            }
                            json!({
                                "type": "toolExecuteResult",
                                "sessionId": task_session_id,
                                "executionId": task_execution_id,
                                "ok": true,
                                "result": value,
                                "timing": timing
                            })
                        }
                        Err(message) => json!({
                            "type": "toolExecuteResult",
                            "sessionId": task_session_id,
                            "executionId": task_execution_id,
                            "ok": false,
                            "error": sanitize_secret(&message, &task_api_key),
                            "timing": timing
                        }),
                    };
                    let _ = send_ai_sidecar_command(&task_app, &task_runtime, payload).await;
                });
            }
            AiEvent::Error { message, .. } if !recoverable_strategy_tool_error => {
                error_message = Some(sanitize_secret(message, &config.api_key));
            }
            AiEvent::Error { .. } => {}
            AiEvent::Done { .. } => {
                done_emitted = true;
            }
            AiEvent::Status { .. } => {}
        }
        if !recoverable_strategy_tool_error {
            emit_ai(&app, event);
        }
        if done_emitted || error_message.is_some() {
            break;
        }
    }
    if let Ok(mut sinks) = runtime.session_sinks.lock() {
        sinks.remove(&session_id);
    }
    let was_cancelled = ai_session_cancelled(&runtime, &session_id);
    if !done_emitted && error_message.is_none() {
        error_message = Some("Cline sidecar 连接中断，未收到完成事件".to_string());
    }
    if !required_tool_satisfied.load(Ordering::Acquire) && error_message.is_none() {
        let required = required_tool_name.as_deref().unwrap_or("required tool");
        error_message = Some(format!("AI 未成功调用 {}，未生成自定义指标", required));
    }
    let terminal_state =
        ai_stream_terminal_state(was_cancelled, done_emitted, error_message.is_some());
    let final_usage = append_ai_usage_summary_event(
        &mut tool_events,
        &usage_provider,
        &usage_model_id,
        &usage_model,
        &usage_model_name,
    );
    emit_ai(
        &app,
        AiEvent::Usage {
            session_id: session_id.clone(),
            usage: serde_json::to_value(&final_usage).unwrap_or_else(|_| json!({})),
        },
    );
    let tool_json = serde_json::to_string(&tool_events)
        .map_err(|error| format!("序列化 AI 运行记录失败: {error}"))?;
    let persist_app = app.clone();
    let persist_session_id = session_id.clone();
    let persist_assistant_text = assistant_text.clone();
    let persist_reasoning =
        (!assistant_reasoning.is_empty()).then_some(assistant_reasoning.clone());
    let message_status = terminal_state.message_status;
    let session_status = terminal_state.session_status;
    let persisted_run_id = run_context
        .as_ref()
        .and_then(|context| context.run_id.clone());
    let metadata_run_id = persisted_run_id.clone();
    let persisted_usage = final_usage.clone();
    let persist_result = tokio::task::spawn_blocking(move || {
        let mut conn = open_database(&persist_app)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        upsert_ai_message(
            &tx,
            &format!("a-{}", now_ms()),
            &persist_session_id,
            "assistant",
            &persist_assistant_text,
            persist_reasoning.as_deref(),
            Some(&tool_json),
            Some(message_status),
        )?;
        if let Some(run_id) = metadata_run_id.as_deref() {
            crate::ai_automation::persist_ai_automation_run_metadata(
                &tx,
                run_id,
                &tool_json,
                &persisted_usage,
            )?;
        }
        set_ai_session_status(&tx, &persist_session_id, session_status)?;
        tx.commit().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("保存 AI 运行记录任务失败: {error}"))?;
    match persist_result {
        Ok(()) => {
            if let Some(run_id) = persisted_run_id.as_deref() {
                notify_automation_run_record_persisted(&app, run_id);
            }
        }
        Err(error) if error_message.is_none() => {
            error_message = Some(format!("保存 AI 运行记录失败: {error}"));
        }
        Err(_) => {}
    }

    if let Some(finish_reason) = terminal_state.synthetic_finish_reason {
        emit_ai(
            &app,
            AiEvent::Done {
                session_id: session_id.clone(),
                finish_reason: Some(finish_reason.to_string()),
            },
        );
    }
    if let Some(message) = error_message {
        return Err(message);
    }
    clear_ai_session_runtime(&runtime, &session_id);
    Ok(())
}

async fn ensure_ai_sidecar(
    app: &tauri::AppHandle,
    runtime: &AiRuntime,
) -> Result<AiSidecarHandle, String> {
    let mut guard = runtime.sidecar.lock().await;
    let proxy_url = ai_sidecar_proxy_url()?;
    if let Some(handle) = guard.as_ref() {
        if handle.proxy_url == proxy_url {
            return Ok(handle.clone());
        }
        *guard = None;
    }

    cleanup_legacy_desic_cline_sessions(app)?;
    let paths = cline_sidecar_runtime(app)?;
    let mut command = Command::new(paths.node_binary);
    command
        .arg("--")
        .arg(paths.entry)
        .current_dir(paths.launch_dir)
        .env("DESIC_SIDECAR_WORK_DIR", paths.work_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "NODE_USE_ENV_PROXY",
    ] {
        command.env_remove(key);
    }
    if let Some(url) = proxy_url.as_deref() {
        command
            .env("NODE_USE_ENV_PROXY", "1")
            .env("HTTP_PROXY", url)
            .env("HTTPS_PROXY", url)
            .env("NO_PROXY", "localhost,127.0.0.1,::1");
    }
    let mut child = command
        .spawn()
        .map_err(|err| format!("Cline sidecar 启动失败: {}", err))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Cline sidecar stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Cline sidecar stdout unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Cline sidecar stderr unavailable".to_string())?;
    let sidecar_id = format!("sidecar-{}-{}", now_ms(), std::process::id());
    let (command_tx, mut command_rx) = mpsc::unbounded_channel::<AiSidecarCommand>();
    let runtime_for_stdout = runtime.clone();
    let app_for_stdout = app.clone();
    let runtime_for_wait = runtime.clone();
    let app_for_wait = app.clone();
    let sidecar_id_for_wait = sidecar_id.clone();
    let stderr_tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let stderr_tail_for_reader = stderr_tail.clone();
    let stderr_tail_for_wait = stderr_tail.clone();
    let last_sidecar_error = Arc::new(Mutex::new(None::<String>));
    let last_sidecar_error_for_stdout = last_sidecar_error.clone();
    let last_sidecar_error_for_wait = last_sidecar_error.clone();

    tauri::async_runtime::spawn(async move {
        while let Some(command) = command_rx.recv().await {
            let result = async {
                let mut bytes =
                    serde_json::to_vec(&command.payload).map_err(|err| err.to_string())?;
                bytes.push(b'\n');
                stdin
                    .write_all(&bytes)
                    .await
                    .map_err(|err| format!("Cline sidecar 写入失败: {}", err))?;
                stdin
                    .flush()
                    .await
                    .map_err(|err| format!("Cline sidecar flush 失败: {}", err))
            }
            .await;
            let _ = command.ack.send(result);
        }
    });

    let stdout_reader = tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            let Some(event) = cline_event_from_value("", &value) else {
                continue;
            };
            if let AiEvent::Error { message, .. } = &event {
                if let Ok(mut last_error) = last_sidecar_error_for_stdout.lock() {
                    *last_error = Some(message.clone());
                }
            }
            let target_session_id = ai_event_session_id(&event);
            if target_session_id == "system" || target_session_id.is_empty() {
                continue;
            }
            let maybe_sink = runtime_for_stdout
                .session_sinks
                .lock()
                .ok()
                .and_then(|sinks| sinks.get(&target_session_id).cloned());
            if let Some(sink) = maybe_sink {
                let _ = sink.send(event);
            } else {
                emit_ai(&app_for_stdout, event);
            }
        }
    });

    let stderr_reader = tauri::async_runtime::spawn(async move {
        let mut stderr_lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = stderr_lines.next_line().await {
            eprintln!("cline-sidecar: {}", line);
            if let Ok(mut tail) = stderr_tail_for_reader.lock() {
                tail.push(line.chars().take(500).collect());
                if tail.len() > 20 {
                    tail.remove(0);
                }
            }
        }
    });

    tauri::async_runtime::spawn(async move {
        let exit_result = child.wait().await;
        // A fatal sidecar error is emitted on stdout immediately before Node exits.
        // Drain both pipes before reading shared error state so the version footer on
        // stderr cannot replace the actionable exception.
        let _ = stdout_reader.await;
        let _ = stderr_reader.await;
        let mut sidecar = runtime_for_wait.sidecar.lock().await;
        let is_current = sidecar
            .as_ref()
            .is_some_and(|handle| handle.id == sidecar_id_for_wait);
        if !is_current {
            return;
        }
        *sidecar = None;
        drop(sidecar);

        let stderr_detail = stderr_tail_for_wait
            .lock()
            .ok()
            .and_then(|tail| sidecar_stderr_detail(&tail));
        let reported_error = last_sidecar_error_for_wait
            .lock()
            .ok()
            .and_then(|message| message.clone())
            .filter(|message| !message.trim().is_empty());
        let exit_detail = match exit_result {
            Ok(status) => format!("退出状态 {}", status),
            Err(err) => format!("等待进程失败: {}", err),
        };
        let detail = reported_error.or(stderr_detail).map(|detail| {
            load_ai_config(&app_for_wait)
                .map(|config| sanitize_secret(&detail, &config.api_key))
                .unwrap_or(detail)
        });
        let message = match detail {
            Some(detail) => format!("Cline sidecar 已退出（{}）：{}", exit_detail, detail),
            None => format!(
                "Cline sidecar 已退出（{}），未收到错误详情或完成事件",
                exit_detail
            ),
        };
        fail_ai_sidecar_sessions(&runtime_for_wait, &message);
        emit_ai(
            &app_for_wait,
            AiEvent::Error {
                session_id: "system".to_string(),
                message,
            },
        );
    });

    let handle = AiSidecarHandle {
        id: sidecar_id,
        sender: command_tx,
        proxy_url,
    };
    *guard = Some(handle.clone());
    Ok(handle)
}

#[cfg(windows)]
fn cleanup_legacy_desic_cline_sessions(app: &tauri::AppHandle) -> Result<(), String> {
    let db_path = app
        .path()
        .home_dir()
        .map_err(|err| err.to_string())?
        .join(".cline")
        .join("data")
        .join("db")
        .join("sessions.db");
    if !db_path.exists() {
        return Ok(());
    }
    let mut conn = Connection::open(&db_path)
        .map_err(|err| format!("打开 Cline sessions.db 失败: {}", err))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|err| err.to_string())?;
    let project_root = project_root_path().to_string_lossy().to_string();
    let removed = cleanup_legacy_desic_cline_sessions_with_conn(&mut conn, &project_root)?;
    if removed > 0 {
        eprintln!(
            "cline-sidecar: cleaned {} legacy Desic Terminal session record(s)",
            removed
        );
    }
    Ok(())
}

#[cfg(not(windows))]
fn cleanup_legacy_desic_cline_sessions(_app: &tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(any(windows, test))]
fn cleanup_legacy_desic_cline_sessions_with_conn(
    conn: &mut Connection,
    project_root: &str,
) -> Result<usize, String> {
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let legacy_filter = "session_id IN (
        SELECT session_id FROM sessions
        WHERE (session_id LIKE 'background:%' OR session_id LIKE 'review:%')
          AND (cwd=?1 OR workspace_root=?1)
          AND (
            prompt LIKE '你正在执行 desicTradeAI 后台 Agent Profile。%'
            OR prompt LIKE '你是 desicTradeAI 交易复盘 Agent。%'
            OR prompt LIKE '你正在执行 Desic Terminal 后台 Agent Profile。%'
            OR prompt LIKE '你是 Desic Terminal 交易复盘 Agent。%'
          )
    )";
    tx.execute(
        &format!(
            "UPDATE schedule_executions SET session_id=NULL WHERE {}",
            legacy_filter
        ),
        params![project_root],
    )
    .map_err(|err| err.to_string())?;
    tx.execute(
        &format!("DELETE FROM subagent_spawn_queue WHERE root_session_id IN (SELECT session_id FROM sessions WHERE {})", legacy_filter),
        params![project_root],
    )
    .map_err(|err| err.to_string())?;
    tx.execute(
        &format!("UPDATE sessions SET parent_session_id=NULL WHERE parent_session_id IN (SELECT session_id FROM sessions WHERE {})", legacy_filter),
        params![project_root],
    )
    .map_err(|err| err.to_string())?;
    let removed = tx
        .execute(
            &format!("DELETE FROM sessions WHERE {}", legacy_filter),
            params![project_root],
        )
        .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(removed)
}

fn fail_ai_sidecar_sessions(runtime: &AiRuntime, message: &str) -> usize {
    let sinks = runtime
        .session_sinks
        .lock()
        .map(|sinks| {
            sinks
                .iter()
                .map(|(id, sink)| (id.clone(), sink.clone()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut notified = 0;
    for (session_id, sink) in sinks {
        if sink
            .send(AiEvent::Error {
                session_id,
                message: message.to_string(),
            })
            .is_ok()
        {
            notified += 1;
        }
    }
    notified
}

fn sidecar_stderr_detail(lines: &[String]) -> Option<String> {
    let lines = lines
        .iter()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return None;
    }
    let start = lines
        .iter()
        .position(|line| line.starts_with("node:") || line.starts_with("Error:"))
        .unwrap_or(0);
    let detail = lines[start..].join("\n");
    Some(detail.chars().take(4_000).collect())
}

#[cfg(test)]
mod ai_sidecar_disconnect_tests {
    use super::*;

    #[test]
    fn sidecar_exit_notifies_every_active_session() {
        let runtime = AiRuntime::default();
        let (first_tx, mut first_rx) = mpsc::unbounded_channel();
        let (second_tx, mut second_rx) = mpsc::unbounded_channel();
        runtime
            .session_sinks
            .lock()
            .unwrap()
            .insert("background:run-1".to_string(), first_tx);
        runtime
            .session_sinks
            .lock()
            .unwrap()
            .insert("review:review-1".to_string(), second_tx);

        assert_eq!(fail_ai_sidecar_sessions(&runtime, "sidecar stopped"), 2);
        for (expected_session, receiver) in [
            ("background:run-1", &mut first_rx),
            ("review:review-1", &mut second_rx),
        ] {
            let event = receiver.try_recv().expect("disconnect event");
            match event {
                AiEvent::Error {
                    session_id,
                    message,
                } => {
                    assert_eq!(session_id, expected_session);
                    assert_eq!(message, "sidecar stopped");
                }
                other => panic!("unexpected event: {:?}", other),
            }
        }
    }

    #[test]
    fn sidecar_stderr_detail_preserves_the_actionable_stack() {
        let detail = sidecar_stderr_detail(&[
            "".to_string(),
            "node:fs:2749".to_string(),
            "Error: EISDIR: illegal operation on a directory, lstat 'E:'".to_string(),
            "    at Object.realpathSync (node:fs:2749:25)".to_string(),
            "Node.js v22.23.1".to_string(),
        ])
        .expect("stderr detail");

        assert!(detail.starts_with("node:fs:2749"));
        assert!(detail.contains("EISDIR"));
        assert!(detail.contains("realpathSync"));
    }

    #[test]
    fn sidecar_runtime_uses_a_relative_entry_for_spaced_install_paths() {
        let paths = sidecar_runtime_paths(
            PathBuf::from("/Applications/Desic Terminal/ai-sidecar/runtime/node"),
            PathBuf::from("/Applications/Desic Terminal/ai-sidecar/sidecar.mjs"),
            PathBuf::from("/tmp/Desic Terminal workspace"),
        )
        .expect("runtime paths");

        assert_eq!(paths.entry, PathBuf::from("sidecar.mjs"));
        assert_eq!(
            paths.launch_dir,
            PathBuf::from("/Applications/Desic Terminal/ai-sidecar")
        );
        assert_eq!(
            paths.work_dir,
            PathBuf::from("/tmp/Desic Terminal workspace")
        );
    }

    #[test]
    fn legacy_desic_cline_sessions_are_removed_without_touching_other_sessions() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE sessions (
              session_id TEXT PRIMARY KEY,
              cwd TEXT NOT NULL,
              workspace_root TEXT NOT NULL,
              parent_session_id TEXT,
              prompt TEXT
            );
            CREATE TABLE schedule_executions (execution_id TEXT PRIMARY KEY, session_id TEXT);
            CREATE TABLE subagent_spawn_queue (id INTEGER PRIMARY KEY, root_session_id TEXT NOT NULL);
            INSERT INTO sessions VALUES
              ('background:run-old','G:\\desicTradeAI','G:\\desicTradeAI',NULL,'你正在执行 desicTradeAI 后台 Agent Profile。'),
              ('review:review-old','G:\\desicTradeAI','G:\\desicTradeAI',NULL,'你是 desicTradeAI 交易复盘 Agent。'),
              ('background:other-app','G:\\other','G:\\other',NULL,'其它应用'),
              ('normal-session','G:\\desicTradeAI','G:\\desicTradeAI','background:run-old','普通会话');
            INSERT INTO schedule_executions VALUES ('execution-1','background:run-old');
            INSERT INTO subagent_spawn_queue VALUES (1,'background:run-old');
            ",
        )
        .unwrap();

        assert_eq!(
            cleanup_legacy_desic_cline_sessions_with_conn(&mut conn, "G:\\desicTradeAI").unwrap(),
            2
        );
        let remaining = conn
            .prepare("SELECT session_id FROM sessions ORDER BY session_id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            remaining,
            vec![
                "background:other-app".to_string(),
                "normal-session".to_string()
            ]
        );
        assert_eq!(
            conn.query_row(
                "SELECT session_id FROM schedule_executions WHERE execution_id='execution-1'",
                [],
                |row| row.get::<_, Option<String>>(0)
            )
            .unwrap(),
            None
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM subagent_spawn_queue", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row(
                "SELECT parent_session_id FROM sessions WHERE session_id='normal-session'",
                [],
                |row| row.get::<_, Option<String>>(0)
            )
            .unwrap(),
            None
        );
    }
}

async fn send_ai_sidecar_command(
    app: &tauri::AppHandle,
    runtime: &AiRuntime,
    payload: serde_json::Value,
) -> Result<(), String> {
    let handle = ensure_ai_sidecar(app, runtime).await?;
    match send_sidecar_command(&handle, payload.clone()).await {
        Ok(()) => Ok(()),
        Err(first_error) => {
            {
                let mut guard = runtime.sidecar.lock().await;
                *guard = None;
            }
            let handle = ensure_ai_sidecar(app, runtime).await?;
            send_sidecar_command(&handle, payload)
                .await
                .map_err(|second_error| {
                    format!(
                        "Cline sidecar 重启重试失败: {}; 首次错误: {}",
                        second_error, first_error
                    )
                })
        }
    }
}

async fn send_sidecar_command(
    handle: &AiSidecarHandle,
    payload: serde_json::Value,
) -> Result<(), String> {
    let (ack_tx, ack_rx) = oneshot::channel();
    handle
        .sender
        .send(AiSidecarCommand {
            payload,
            ack: ack_tx,
        })
        .map_err(|_| "Cline sidecar command channel closed".to_string())?;
    timeout(Duration::from_secs(5), ack_rx)
        .await
        .map_err(|_| "Cline sidecar 写入超时".to_string())?
        .map_err(|_| "Cline sidecar 写入确认失败".to_string())?
}

fn ai_event_session_id(event: &AiEvent) -> String {
    match event {
        AiEvent::Status { session_id, .. }
        | AiEvent::Delta { session_id, .. }
        | AiEvent::ToolCall { session_id, .. }
        | AiEvent::ToolResult { session_id, .. }
        | AiEvent::Usage { session_id, .. }
        | AiEvent::AgentStart { session_id, .. }
        | AiEvent::AgentDone { session_id, .. }
        | AiEvent::TeamEvent { session_id, .. }
        | AiEvent::ApprovalRequest { session_id, .. }
        | AiEvent::ApprovalResolved { session_id, .. }
        | AiEvent::ToolExecuteRequest { session_id, .. }
        | AiEvent::Error { session_id, .. }
        | AiEvent::Done { session_id, .. } => session_id.clone(),
    }
}

fn project_root_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|path| path.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn sidecar_runtime_paths(
    node_binary: PathBuf,
    sidecar_path: PathBuf,
    work_dir: PathBuf,
) -> Result<AiSidecarRuntimePaths, String> {
    let launch_dir = sidecar_path
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("Cline sidecar 路径缺少父目录: {}", sidecar_path.display()))?;
    let entry = sidecar_path
        .file_name()
        .map(PathBuf::from)
        .ok_or_else(|| format!("Cline sidecar 路径缺少文件名: {}", sidecar_path.display()))?;
    Ok(AiSidecarRuntimePaths {
        node_binary,
        entry,
        launch_dir,
        work_dir,
    })
}

fn cline_sidecar_runtime(app: &tauri::AppHandle) -> Result<AiSidecarRuntimePaths, String> {
    if cfg!(debug_assertions) {
        let sidecar_root = project_root_path().join("scripts");
        let sidecar_path = sidecar_root.join("cline-sidecar.mjs");
        if !sidecar_path.exists() {
            return Err("未找到 Cline sidecar 脚本 scripts/cline-sidecar.mjs".to_string());
        }
        return sidecar_runtime_paths(PathBuf::from("node"), sidecar_path, runtime_work_dir());
    }

    let resource_dir = app.path().resource_dir().map_err(|err| err.to_string())?;
    let sidecar_root = resource_dir.join("ai-sidecar");
    let sidecar_path = sidecar_root.join("sidecar.mjs");
    let node_binary =
        sidecar_root
            .join("runtime")
            .join(if cfg!(windows) { "node.exe" } else { "node" });
    if !sidecar_path.exists() {
        return Err(format!(
            "未找到打包的 Cline sidecar: {}",
            sidecar_path.display()
        ));
    }
    if !node_binary.exists() {
        return Err(format!(
            "未找到打包的 Node.js 运行时: {}",
            node_binary.display()
        ));
    }
    sidecar_runtime_paths(node_binary, sidecar_path, runtime_work_dir())
}

fn cline_event_from_value(default_session_id: &str, value: &serde_json::Value) -> Option<AiEvent> {
    let event_type = value.get("type")?.as_str()?;
    let session_id = value
        .get("sessionId")
        .or_else(|| value.get("session_id"))
        .and_then(|item| item.as_str())
        .filter(|item| !item.is_empty() && *item != "unknown")
        .unwrap_or(default_session_id)
        .to_string();
    match event_type {
        "status" => Some(AiEvent::Status {
            session_id,
            status: value
                .get("status")
                .and_then(|item| item.as_str())
                .unwrap_or("running")
                .to_string(),
            message: value
                .get("message")
                .and_then(|item| item.as_str())
                .unwrap_or("running")
                .to_string(),
        }),
        "delta" => Some(AiEvent::Delta {
            session_id,
            channel: value
                .get("channel")
                .and_then(|item| item.as_str())
                .unwrap_or("text")
                .to_string(),
            content: value
                .get("content")
                .and_then(|item| item.as_str())
                .unwrap_or_default()
                .to_string(),
        }),
        "toolCall" | "tool_call" => {
            let name = value
                .get("name")
                .and_then(|item| item.as_str())
                .unwrap_or("tool")
                .to_string();
            let (allowed, blocked, policy) = ai_tool_policy(&name, value);
            Some(AiEvent::ToolCall {
                session_id,
                tool_call_id: value
                    .get("toolCallId")
                    .or_else(|| value.get("tool_call_id"))
                    .and_then(|item| item.as_str())
                    .map(|item| item.to_string()),
                name,
                arguments: value.get("arguments").cloned().unwrap_or_else(|| json!({})),
                allowed,
                blocked,
                policy,
                agent_id: value
                    .get("agentId")
                    .or_else(|| value.get("agent_id"))
                    .and_then(|item| item.as_str())
                    .map(|item| item.to_string()),
                configured_agent_id: value
                    .get("configuredAgentId")
                    .or_else(|| value.get("configured_agent_id"))
                    .and_then(|item| item.as_str())
                    .map(|item| item.to_string()),
                parent_agent_id: value
                    .get("parentAgentId")
                    .or_else(|| value.get("parent_agent_id"))
                    .and_then(|item| item.as_str())
                    .map(|item| item.to_string()),
                started_at: value
                    .get("startedAt")
                    .or_else(|| value.get("started_at"))
                    .and_then(|item| item.as_i64())
                    .or_else(|| Some(now_ms())),
            })
        }
        "toolResult" | "tool_result" => Some(AiEvent::ToolResult {
            session_id,
            tool_call_id: value
                .get("toolCallId")
                .or_else(|| value.get("tool_call_id"))
                .and_then(|item| item.as_str())
                .map(|item| item.to_string()),
            name: value
                .get("name")
                .and_then(|item| item.as_str())
                .unwrap_or("tool")
                .to_string(),
            result: value.get("result").cloned().unwrap_or_else(|| json!({})),
            summary: value
                .get("summary")
                .and_then(|item| item.as_str())
                .unwrap_or_default()
                .to_string(),
            ok: value
                .get("ok")
                .and_then(|item| item.as_bool())
                .unwrap_or(true),
            agent_id: value
                .get("agentId")
                .or_else(|| value.get("agent_id"))
                .and_then(|item| item.as_str())
                .map(|item| item.to_string()),
            configured_agent_id: value
                .get("configuredAgentId")
                .or_else(|| value.get("configured_agent_id"))
                .and_then(|item| item.as_str())
                .map(|item| item.to_string()),
            parent_agent_id: value
                .get("parentAgentId")
                .or_else(|| value.get("parent_agent_id"))
                .and_then(|item| item.as_str())
                .map(|item| item.to_string()),
            started_at: value
                .get("startedAt")
                .or_else(|| value.get("started_at"))
                .and_then(|item| item.as_i64()),
            ended_at: value
                .get("endedAt")
                .or_else(|| value.get("ended_at"))
                .and_then(|item| item.as_i64())
                .or_else(|| Some(now_ms())),
            requested_at: value
                .get("requestedAt")
                .or_else(|| value.get("requested_at"))
                .and_then(|item| item.as_i64()),
            execution_started_at: value
                .get("executionStartedAt")
                .or_else(|| value.get("execution_started_at"))
                .and_then(|item| item.as_i64()),
            execution_ended_at: value
                .get("executionEndedAt")
                .or_else(|| value.get("execution_ended_at"))
                .and_then(|item| item.as_i64()),
        }),
        "usage" => Some(AiEvent::Usage {
            session_id,
            usage: value.get("usage").cloned().unwrap_or_else(|| json!({})),
        }),
        "agentStart" | "agent_start" => Some(AiEvent::AgentStart {
            session_id,
            agent_id: value
                .get("agentId")
                .or_else(|| value.get("agent_id"))
                .and_then(|item| item.as_str())
                .unwrap_or("subagent")
                .to_string(),
            configured_agent_id: value
                .get("configuredAgentId")
                .or_else(|| value.get("configured_agent_id"))
                .and_then(|item| item.as_str())
                .map(|item| item.to_string()),
            parent_agent_id: value
                .get("parentAgentId")
                .or_else(|| value.get("parent_agent_id"))
                .and_then(|item| item.as_str())
                .map(|item| item.to_string()),
            role: value
                .get("role")
                .and_then(|item| item.as_str())
                .map(|item| item.to_string()),
            title: value
                .get("title")
                .and_then(|item| item.as_str())
                .map(|item| item.to_string()),
            task: value
                .get("task")
                .and_then(|item| item.as_str())
                .unwrap_or_default()
                .to_string(),
            started_at: value
                .get("startedAt")
                .or_else(|| value.get("started_at"))
                .and_then(|item| item.as_i64())
                .or_else(|| Some(now_ms())),
        }),
        "agentDone" | "agent_done" => Some(AiEvent::AgentDone {
            session_id,
            agent_id: value
                .get("agentId")
                .or_else(|| value.get("agent_id"))
                .and_then(|item| item.as_str())
                .unwrap_or("subagent")
                .to_string(),
            configured_agent_id: value
                .get("configuredAgentId")
                .or_else(|| value.get("configured_agent_id"))
                .and_then(|item| item.as_str())
                .map(|item| item.to_string()),
            status: value
                .get("status")
                .and_then(|item| item.as_str())
                .unwrap_or("done")
                .to_string(),
            result: value.get("result").cloned().unwrap_or_else(|| json!({})),
            error: value
                .get("error")
                .and_then(|item| item.as_str())
                .map(|item| item.to_string()),
            ended_at: value
                .get("endedAt")
                .or_else(|| value.get("ended_at"))
                .and_then(|item| item.as_i64())
                .or_else(|| Some(now_ms())),
        }),
        "teamEvent" | "team_event" => Some(AiEvent::TeamEvent {
            session_id,
            event: value.get("event").cloned().unwrap_or_else(|| json!({})),
        }),
        "approvalRequest" | "approval_request" => Some(AiEvent::ApprovalRequest {
            session_id,
            approval_id: value
                .get("approvalId")
                .or_else(|| value.get("approval_id"))
                .and_then(|item| item.as_str())
                .unwrap_or("approval")
                .to_string(),
            tool_call_id: value
                .get("toolCallId")
                .or_else(|| value.get("tool_call_id"))
                .and_then(|item| item.as_str())
                .unwrap_or("tool")
                .to_string(),
            tool_name: value
                .get("toolName")
                .or_else(|| value.get("tool_name"))
                .and_then(|item| item.as_str())
                .unwrap_or("tool")
                .to_string(),
            input: value.get("input").cloned().unwrap_or_else(|| json!({})),
            reason: value
                .get("reason")
                .and_then(|item| item.as_str())
                .map(|item| item.to_string()),
        }),
        "approvalResolved" | "approval_resolved" => Some(AiEvent::ApprovalResolved {
            session_id,
            approval_id: value
                .get("approvalId")
                .or_else(|| value.get("approval_id"))
                .and_then(|item| item.as_str())
                .unwrap_or("approval")
                .to_string(),
            approved: value
                .get("approved")
                .and_then(|item| item.as_bool())
                .unwrap_or(false),
            reason: value
                .get("reason")
                .and_then(|item| item.as_str())
                .map(|item| item.to_string()),
        }),
        "toolExecuteRequest" | "tool_execute_request" => Some(AiEvent::ToolExecuteRequest {
            session_id,
            execution_id: value
                .get("executionId")
                .or_else(|| value.get("execution_id"))
                .and_then(|item| item.as_str())
                .unwrap_or("execution")
                .to_string(),
            tool_name: value
                .get("toolName")
                .or_else(|| value.get("tool_name"))
                .and_then(|item| item.as_str())
                .unwrap_or("tool")
                .to_string(),
            input: value.get("input").cloned().unwrap_or_else(|| json!({})),
            agent_id: value
                .get("agentId")
                .and_then(|item| item.as_str())
                .map(str::to_string),
            parent_agent_id: value
                .get("parentAgentId")
                .and_then(|item| item.as_str())
                .map(str::to_string),
            agent_role: value
                .get("agentRole")
                .and_then(|item| item.as_str())
                .unwrap_or(
                    if value
                        .get("parentAgentId")
                        .and_then(|item| item.as_str())
                        .is_some()
                    {
                        "subagent"
                    } else {
                        "main"
                    },
                )
                .to_string(),
            configured_agent_id: value
                .get("configuredAgentId")
                .or_else(|| value.get("configured_agent_id"))
                .and_then(|item| item.as_str())
                .map(str::to_string),
            configured_agent_scopes: value
                .get("configuredAgentScopes")
                .or_else(|| value.get("configured_agent_scopes"))
                .and_then(|item| item.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            permission_mode: value
                .get("permissionMode")
                .and_then(|item| item.as_str())
                .map(str::to_string),
            background_run: value
                .get("backgroundRun")
                .and_then(|item| item.as_bool())
                .unwrap_or(false),
            review_run: value
                .get("reviewRun")
                .and_then(|item| item.as_bool())
                .unwrap_or(false),
            agent_run_id: value
                .get("agentRunId")
                .and_then(|item| item.as_str())
                .map(str::to_string),
            agent_profile_id: value
                .get("agentProfileId")
                .and_then(|item| item.as_str())
                .map(str::to_string),
            review_id: value
                .get("reviewId")
                .and_then(|item| item.as_str())
                .map(str::to_string),
            episode_id: value
                .get("episodeId")
                .and_then(|item| item.as_str())
                .map(str::to_string),
            requested_at: value
                .get("requestedAt")
                .or_else(|| value.get("requested_at"))
                .and_then(|item| item.as_i64()),
        }),
        "error" => Some(AiEvent::Error {
            session_id,
            message: value
                .get("message")
                .and_then(|item| item.as_str())
                .unwrap_or("Cline error")
                .to_string(),
        }),
        "done" => Some(AiEvent::Done {
            session_id,
            finish_reason: value
                .get("finishReason")
                .or_else(|| value.get("finish_reason"))
                .and_then(|item| item.as_str())
                .map(|item| item.to_string()),
        }),
        _ => None,
    }
}

fn ai_tool_policy(_name: &str, value: &serde_json::Value) -> (bool, bool, String) {
    let sidecar_allowed = value.get("allowed").and_then(|item| item.as_bool());
    let sidecar_blocked = value.get("blocked").and_then(|item| item.as_bool());
    let allowed = sidecar_allowed.unwrap_or(false);
    let blocked = sidecar_blocked.unwrap_or(true);
    let policy = value
        .get("policy")
        .and_then(|item| item.as_str())
        .unwrap_or(if blocked {
            "disabled:tool-policy"
        } else {
            "cline:tool-policy"
        })
        .to_string();
    (allowed && !blocked, blocked, policy)
}

#[derive(Clone)]
struct AiToolExecutionContext {
    session_id: String,
    permission_mode: String,
    tool_allowlist: HashSet<String>,
    parent_agent_id: Option<String>,
    agent_role: String,
    configured_agent_id: Option<String>,
    configured_agent_scopes: Vec<String>,
    declared_agent_run_id: Option<String>,
    declared_agent_profile_id: Option<String>,
    declared_review_id: Option<String>,
    declared_episode_id: Option<String>,
    active_skill_ids: HashSet<String>,
    account_context_id: Option<String>,
    run_context: Option<BackgroundRunContext>,
}

fn ai_tool_allows_concurrent_execution(name: &str) -> bool {
    let canonical = canonical_ai_tool_name(name);
    (canonical.starts_with("market.") && canonical != "market.readDecisionContext")
        || canonical.starts_with("account.")
        || canonical.starts_with("intelligence.")
        || canonical == "trade.evaluatePlan"
        || canonical == "trade.precheck"
        || matches!(
            canonical,
            "tradeOpportunity.list"
                | "tradeOpportunity.get"
                | "alert.listPriceAlerts"
                | "script.list"
                | "skills"
                | "strategy.readCurrentSource"
                | "strategy.testCurrentSource"
        )
}

fn profile_agent_scope_allows_tool(scope: &str, canonical: &str) -> bool {
    match scope {
        "market" => matches!(
            canonical,
            "market.readTicker"
                | "market.readInstrument"
                | "market.readOrderBook"
                | "market.readRecentTrades"
                | "market.readCandles"
                | "market.readFundingRate"
                | "market.scanWatchlist"
                | "market.readIndicators"
        ),
        "derivatives" => matches!(
            canonical,
            "market.readFundingRate"
                | "intelligence.news.listAnomalies"
                | "intelligence.smartMoney.readMarketPositioning"
                | "intelligence.smartMoney.readTakerFlow"
                | "intelligence.smartMoney.readDerivativeDecisionContext"
                | "intelligence.smartMoney.readCrowdingComparison"
                | "intelligence.smartMoney.readFundingBasis"
                | "intelligence.smartMoney.readLiquidationSamples"
                | "intelligence.smartMoney.readSystemStress"
                | "intelligence.smartMoney.readPositionChanges"
                | "intelligence.smartMoney.readConsensusDivergence"
        ),
        "intelligence" => matches!(
            canonical,
            "intelligence.news.list"
                | "intelligence.news.search"
                | "intelligence.news.readDetail"
                | "intelligence.news.listSources"
                | "intelligence.news.readCoinSentiment"
                | "intelligence.news.readCoinSentimentTrend"
                | "intelligence.news.readSentimentRanking"
                | "intelligence.news.readEconomicCalendar"
                | "intelligence.news.listEvents"
                | "intelligence.news.readEvent"
                | "intelligence.news.readMarketReaction"
                | "intelligence.news.readDailyBriefing"
                | "intelligence.smartMoney.listTradersByFilter"
                | "intelligence.smartMoney.searchTrader"
                | "intelligence.smartMoney.readPerformanceByTrader"
                | "intelligence.smartMoney.readTraderPositions"
                | "intelligence.smartMoney.readTraderPositionHistory"
                | "intelligence.smartMoney.readTraderOrderHistory"
                | "intelligence.smartMoney.readSignalOverviewByFilter"
                | "intelligence.smartMoney.readSignalOverviewByTrader"
                | "intelligence.smartMoney.readSignalTrendByFilter"
                | "intelligence.smartMoney.readSignalTrendByTrader"
        ),
        "account" => matches!(
            canonical,
            "account.readSnapshot"
                | "account.readBalances"
                | "account.readPositions"
                | "account.readOpenOrders"
                | "account.readOrderStatus"
                | "account.readRisk"
                | "trade.evaluatePlan"
                | "trade.precheck"
        ),
        "history" => matches!(
            canonical,
            "account.readHistoricalOrders"
                | "account.readHistoricalFills"
                | "account.readBills"
                | "account.readPositionEpisodes"
                | "tradeOpportunity.list"
                | "tradeOpportunity.get"
        ),
        _ => false,
    }
}

fn auto_profile_agent_scopes(agent_id: &str) -> Option<&'static [&'static str]> {
    match agent_id {
        "auto-market-structure" => Some(&["market", "derivatives"]),
        "auto-order-flow-liquidity" => Some(&["market"]),
        "auto-derivatives-positioning" => Some(&["derivatives", "market"]),
        "auto-account-risk" => Some(&["account", "history", "market"]),
        "auto-intelligence-flow" => Some(&["intelligence"]),
        "auto-smart-money" => Some(&["intelligence", "derivatives"]),
        "auto-historical-analogy" => Some(&["history", "market"]),
        "auto-contrarian-review" => Some(&["market", "derivatives", "intelligence", "history"]),
        _ => None,
    }
}

fn normalize_declared_agent_scopes(scopes: &[String]) -> Result<HashSet<String>, String> {
    let mut normalized = HashSet::new();
    for scope in scopes {
        let scope = scope.trim().to_ascii_lowercase();
        if !matches!(
            scope.as_str(),
            "market" | "derivatives" | "intelligence" | "account" | "history"
        ) {
            return Err(format!("delegated agent 声明了未知数据范围：{scope}"));
        }
        normalized.insert(scope);
    }
    if normalized.is_empty() {
        return Err("delegated background agent 缺少数据范围".to_string());
    }
    Ok(normalized)
}

fn authorize_background_delegated_agent(
    canonical: &str,
    context: &AiToolExecutionContext,
    is_main: bool,
) -> Result<(), String> {
    let Some(run) = context
        .run_context
        .as_ref()
        .filter(|run| run.is_background())
    else {
        return Ok(());
    };
    if is_main {
        return Ok(());
    }
    let configured_agent_id = context
        .configured_agent_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "delegated background agent 缺少 configuredAgentId".to_string())?;
    let declared_scopes = normalize_declared_agent_scopes(&context.configured_agent_scopes)?;
    let expected_scopes =
        match desic_agent_automation::normalize_multi_agent_mode(Some(&run.multi_agent_mode)) {
            desic_agent_automation::MULTI_AGENT_CUSTOM_MODE => run
                .multi_agents
                .iter()
                .find(|agent| agent.enabled && agent.id == configured_agent_id)
                .map(|agent| agent.scopes.iter().cloned().collect::<HashSet<_>>())
                .ok_or_else(|| {
                    format!("configuredAgentId 不属于当前 Profile 快照：{configured_agent_id}")
                })?,
            desic_agent_automation::MULTI_AGENT_AUTO_MODE => {
                auto_profile_agent_scopes(configured_agent_id)
                    .map(|scopes| scopes.iter().map(|scope| (*scope).to_string()).collect())
                    .ok_or_else(|| format!("未知的自动分配 Agent：{configured_agent_id}"))?
            }
            _ => return Err("当前后台 Profile 未启用多 Agent，拒绝 delegated agent".to_string()),
        };
    if declared_scopes != expected_scopes {
        return Err(format!(
            "delegated agent 数据范围与 Profile 快照不一致：{configured_agent_id}"
        ));
    }
    if !declared_scopes
        .iter()
        .any(|scope| profile_agent_scope_allows_tool(scope, canonical))
    {
        return Err(format!(
            "delegated agent {} 的数据范围不允许调用工具：{}",
            configured_agent_id, canonical
        ));
    }
    Ok(())
}

fn authorize_ai_tool(name: &str, context: &AiToolExecutionContext) -> Result<(), String> {
    let canonical = canonical_ai_tool_name(name);
    if !context.tool_allowlist.is_empty() && !context.tool_allowlist.contains(canonical) {
        return Err(format!("本次 AI 会话不允许调用工具：{}", canonical));
    }
    let is_main = context.agent_role == "main"
        && context.parent_agent_id.is_none()
        && context.configured_agent_id.is_none();
    authorize_background_delegated_agent(canonical, context, is_main)?;
    if context
        .run_context
        .as_ref()
        .is_some_and(|run| run.is_background() && run.account_id.is_none())
        && (canonical.starts_with("account.")
            || matches!(
                canonical,
                "trade.evaluatePlan" | "trade.precheck" | "trade.setLeverage"
            ))
    {
        return Err(format!(
            "后台 Agent Profile 未绑定账户，拒绝账户工具：{}",
            canonical
        ));
    }
    let mode = desic_agent_automation::normalize_permission_mode(Some(&context.permission_mode));
    if canonical.starts_with("intelligence.news.")
        && !context.active_skill_ids.contains("okx-news-intelligence")
    {
        return Err("未启用 okx-news-intelligence Skill，拒绝新闻情报工具".to_string());
    }
    if canonical.starts_with("intelligence.smartMoney.")
        && !context
            .active_skill_ids
            .contains("okx-smart-money-analysis")
    {
        return Err("未启用 okx-smart-money-analysis Skill，拒绝聪明钱工具".to_string());
    }
    if canonical == "market.readDecisionContext"
        && (!is_main
            || !context
                .run_context
                .as_ref()
                .is_some_and(BackgroundRunContext::is_background))
    {
        return Err("market.readDecisionContext 仅允许绑定后台 Run 的主 Agent 调用".to_string());
    }
    if matches!(canonical, "strategy.readCurrentSource" | "strategy.testCurrentSource") && !is_main {
        return Err("策略编辑器源码和受控测试仅可由主 AI 会话使用".to_string());
    }
    let is_read = matches!(
        canonical,
        "market.readTicker"
            | "market.readInstrument"
            | "market.readOrderBook"
            | "market.readRecentTrades"
            | "market.readCandles"
            | "market.readFundingRate"
            | "market.scanWatchlist"
            | "market.readIndicators"
            | "market.readDecisionContext"
            | "account.readSnapshot"
            | "account.readBalances"
            | "account.readPositions"
            | "account.readOpenOrders"
            | "account.readOrderStatus"
            | "account.readRisk"
            | "account.readHistoricalOrders"
            | "account.readHistoricalFills"
            | "account.readBills"
            | "account.readPositionEpisodes"
            | "intelligence.news.list"
            | "intelligence.news.search"
            | "intelligence.news.readDetail"
            | "intelligence.news.listSources"
            | "intelligence.news.readCoinSentiment"
            | "intelligence.news.readCoinSentimentTrend"
            | "intelligence.news.readSentimentRanking"
            | "intelligence.news.readEconomicCalendar"
            | "intelligence.news.listEvents"
            | "intelligence.news.readEvent"
            | "intelligence.news.readMarketReaction"
            | "intelligence.news.listAnomalies"
            | "intelligence.news.readDailyBriefing"
            | "intelligence.smartMoney.listTradersByFilter"
            | "intelligence.smartMoney.searchTrader"
            | "intelligence.smartMoney.readPerformanceByTrader"
            | "intelligence.smartMoney.readTraderPositions"
            | "intelligence.smartMoney.readTraderPositionHistory"
            | "intelligence.smartMoney.readTraderOrderHistory"
            | "intelligence.smartMoney.readSignalOverviewByFilter"
            | "intelligence.smartMoney.readSignalOverviewByTrader"
            | "intelligence.smartMoney.readSignalTrendByFilter"
            | "intelligence.smartMoney.readSignalTrendByTrader"
            | "intelligence.smartMoney.readMarketPositioning"
            | "intelligence.smartMoney.readTakerFlow"
            | "intelligence.smartMoney.readDerivativeDecisionContext"
            | "intelligence.smartMoney.readCrowdingComparison"
            | "intelligence.smartMoney.readFundingBasis"
            | "intelligence.smartMoney.readLiquidationSamples"
            | "intelligence.smartMoney.readSystemStress"
            | "intelligence.smartMoney.readPositionChanges"
            | "intelligence.smartMoney.readConsensusDivergence"
            | "trade.evaluatePlan"
            | "trade.precheck"
            | "tradeOpportunity.list"
            | "tradeOpportunity.get"
            | "strategy.readCurrentSource"
            | "strategy.testCurrentSource"
    );
    if is_read {
        return Ok(());
    }
    if !is_main {
        return Err(format!(
            "delegated agent 仅允许只读分析，已拒绝工具：{}",
            canonical
        ));
    }
    if matches!(
        canonical,
        "journal.createNote"
            | "chart.createDrawing"
            | "chart.updateDrawing"
            | "chart.deleteDrawing"
            | "alert.createPriceAlert"
            | "alert.updatePriceAlert"
            | "alert.deletePriceAlert"
            | "alert.listPriceAlerts"
            | "script.createOrUpdate"
            | "script.run"
            | "script.enable"
            | "script.delete"
            | "script.list"
            | "strategy.applySource"
            | "notification.feishu.send"
    ) {
        return Ok(());
    }
    if matches!(
        canonical,
        "tradeOpportunity.create"
            | "tradeOpportunity.revise"
            | "tradeOpportunity.reuse"
            | "tradeOpportunity.close"
    ) {
        if context
            .run_context
            .as_ref()
            .is_some_and(BackgroundRunContext::is_background)
            && matches!(
                canonical,
                "tradeOpportunity.revise" | "tradeOpportunity.reuse"
            )
        {
            return Err(
                "后台 Run 只允许通过 tradeOpportunity.create 提交冻结候选；复用或修订使用 duplicateResolution"
                    .to_string(),
            );
        }
        return if matches!(mode, "copilot" | "limited_auto") {
            Ok(())
        } else {
            Err("advisor 模式不能创建或修改交易机会".to_string())
        };
    }
    if canonical == "trade.setLeverage" {
        let profile_mode = context
            .run_context
            .as_ref()
            .filter(|run| run.is_background())
            .map(|run| {
                desic_agent_automation::normalize_permission_mode(Some(&run.permission_mode))
            });
        return if matches!(profile_mode, Some("copilot" | "limited_auto")) {
            Ok(())
        } else {
            Err("只有 copilot 或 limited_auto 后台 Profile 主 Agent 可以同步目标杠杆".to_string())
        };
    }
    if matches!(
        canonical,
        "trade.placeOrder"
            | "trade.cancelOrder"
            | "trade.amendOrder"
            | "trade.setLeverage"
            | "trade.setMarginMode"
            | "trade.closePosition"
    ) {
        return Err("AI 自动交易必须通过 tradeOpportunity.create 创建交易机会；后端按 Profile 权限自动批准并执行，不允许直接调用交易工具".to_string());
    }
    if canonical == "background.finishRun" {
        let Some(run) = context
            .run_context
            .as_ref()
            .filter(|run| run.is_background())
        else {
            return Err("background.finishRun 只能用于后台 Run".to_string());
        };
        if run.run_id != context.declared_agent_run_id
            || run.profile_id != context.declared_agent_profile_id
        {
            return Err("后台工具的 Run/Profile 身份不匹配".to_string());
        }
        return Ok(());
    }
    if matches!(
        canonical,
        "review.readSkillVersion" | "review.complete" | "optimizationSuggestion.create"
    ) {
        let Some(run) = context.run_context.as_ref().filter(|run| run.is_review()) else {
            return Err("复盘工具只能用于 Review Run".to_string());
        };
        if run.review_id != context.declared_review_id
            || run.episode_id != context.declared_episode_id
        {
            return Err("复盘工具的 reviewId/episodeId 不匹配".to_string());
        }
        return Ok(());
    }
    Err(format!("未知或未授权的 AI 工具：{}", canonical))
}

async fn auto_execute_trade_opportunity_for_ai(
    app: &tauri::AppHandle,
    id: &str,
    context: &AiToolExecutionContext,
    session_id: &str,
) -> Result<TradeOpportunitySummary, String> {
    let mut result = trade_opportunity_auto_approve_for_run(
        app,
        id,
        context
            .run_context
            .as_ref()
            .and_then(|run| run.run_id.as_deref())
            .or(Some(session_id)),
    )?;
    if result.status == "approved" {
        let runtime = app.state::<MarketRuntime>();
        result = trade_opportunity_approve(app.clone(), runtime, result.id.clone()).await?;
    }
    Ok(result)
}

fn emit_ai(app: &tauri::AppHandle, event: AiEvent) {
    let _ = app.emit(AI_EVENT, event);
}

fn clear_ai_session_runtime(runtime: &AiRuntime, session_id: &str) {
    if let Ok(mut sinks) = runtime.session_sinks.lock() {
        sinks.remove(session_id);
    }
    if let Ok(mut cancelled) = runtime.session_cancelled.lock() {
        cancelled.remove(session_id);
    }
    if let Ok(mut tasks) = runtime.tasks.lock() {
        tasks.remove(session_id);
    }
}

fn mark_ai_session_cancelled(runtime: &AiRuntime, session_id: &str) {
    if let Ok(mut cancelled) = runtime.session_cancelled.lock() {
        cancelled.insert(session_id.to_string(), true);
    }
}

fn ai_session_cancelled(runtime: &AiRuntime, session_id: &str) -> bool {
    runtime
        .session_cancelled
        .lock()
        .ok()
        .and_then(|cancelled| cancelled.get(session_id).copied())
        .unwrap_or(false)
}

fn stop_ai_session(runtime: &tauri::State<'_, AiRuntime>, session_id: &str) -> Result<(), String> {
    mark_ai_session_cancelled(runtime.inner(), session_id);
    if let Ok(mut sinks) = runtime.session_sinks.lock() {
        sinks.remove(session_id);
    }
    if let Some(task) = runtime
        .tasks
        .lock()
        .map_err(|err| err.to_string())?
        .remove(session_id)
    {
        task.abort();
    }
    Ok(())
}

fn inject_ai_execution_context(input: &mut serde_json::Value, context: &AiToolExecutionContext) {
    let Some(object) = input.as_object_mut() else {
        return;
    };
    object.insert("operator".to_string(), json!("ai"));
    object.insert("sessionId".to_string(), json!(context.session_id));
    if let Some(run) = context.run_context.as_ref() {
        if let Some(run_id) = run.run_id.as_ref() {
            object.insert("agentRunId".to_string(), json!(run_id));
        }
        if let Some(profile_id) = run.profile_id.as_ref() {
            object.insert("agentProfileId".to_string(), json!(profile_id));
        }
    }
}

fn enforce_background_run_scope(
    canonical_name: &str,
    input: &mut serde_json::Value,
    context: &AiToolExecutionContext,
) -> Result<(), String> {
    let Some(run) = context
        .run_context
        .as_ref()
        .filter(|run| run.is_background())
    else {
        return Ok(());
    };
    if run.account_id.is_none()
        && (canonical_name.starts_with("account.")
            || matches!(
                canonical_name,
                "trade.evaluatePlan"
                    | "trade.precheck"
                    | "trade.setLeverage"
                    | "market.readDecisionContext"
            ))
    {
        return Err(format!(
            "后台 Agent Profile 未绑定账户，拒绝账户工具：{}",
            canonical_name
        ));
    }
    let Some(object) = input.as_object_mut() else {
        return Ok(());
    };
    let account_scoped = matches!(
        canonical_name,
        "account.readSnapshot"
            | "account.readBalances"
            | "account.readPositions"
            | "account.readOpenOrders"
            | "account.readOrderStatus"
            | "account.readRisk"
            | "account.readHistoricalOrders"
            | "account.readHistoricalFills"
            | "account.readBills"
            | "account.readPositionEpisodes"
            | "trade.evaluatePlan"
            | "trade.precheck"
            | "market.readDecisionContext"
            | "tradeOpportunity.list"
            | "tradeOpportunity.create"
            | "trade.placeOrder"
            | "trade.cancelOrder"
            | "trade.amendOrder"
            | "trade.setLeverage"
            | "trade.setMarginMode"
            | "trade.closePosition"
    );
    if account_scoped {
        if let Some(expected) = run.account_id.as_deref() {
            if let Some(actual) = object
                .get("accountId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                if actual != expected {
                    return Err(format!("工具账号不在当前 Agent Profile 范围内：{actual}"));
                }
            }
            object.insert("accountId".to_string(), json!(expected));
        }
    }
    if matches!(
        canonical_name,
        "account.readHistoricalOrders"
            | "account.readHistoricalFills"
            | "account.readBills"
            | "account.readPositionEpisodes"
    ) && object.get("startTime").map(Value::is_null).unwrap_or(true)
        && run.history_lookback_days > 0
    {
        object.insert(
            "startTime".to_string(),
            json!(now_ms().saturating_sub(i64::from(run.history_lookback_days) * 86_400_000)),
        );
    }

    let environment_scoped = matches!(
        canonical_name,
        "account.readOrderStatus"
            | "trade.precheck"
            | "market.readDecisionContext"
            | "tradeOpportunity.create"
            | "trade.placeOrder"
            | "trade.cancelOrder"
            | "trade.amendOrder"
            | "trade.setLeverage"
            | "trade.setMarginMode"
            | "trade.closePosition"
    );
    if environment_scoped {
        if let Some(expected) = run.environment.as_deref() {
            if let Some(actual) = object
                .get("environment")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                if normalize_environment(actual) != normalize_environment(expected) {
                    return Err(format!("工具环境不在当前 Agent Profile 范围内：{actual}"));
                }
            }
            object.insert("environment".to_string(), json!(expected));
        }
    }

    if !run.symbols.is_empty() {
        if canonical_name == "market.scanWatchlist" {
            if let Some(requested) = object.get("instIds").and_then(Value::as_array) {
                for value in requested.iter().filter_map(Value::as_str) {
                    if !run.symbols.iter().any(|allowed| allowed == value) {
                        return Err(format!("交易品种不在当前 Agent Profile 范围内：{value}"));
                    }
                }
            }
            object.insert("instIds".to_string(), json!(run.symbols));
        }
        if let Some(inst_id) = object
            .get("instId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if !run.symbols.iter().any(|allowed| allowed == inst_id) {
                return Err(format!("交易品种不在当前 Agent Profile 范围内：{inst_id}"));
            }
        }
    }
    if matches!(
        canonical_name,
        "trade.evaluatePlan" | "trade.precheck" | "tradeOpportunity.create" | "trade.setLeverage"
    ) {
        object.insert("lever".to_string(), json!(run.target_leverage.to_string()));
        if canonical_name == "trade.setLeverage" {
            object.remove("posSide");
        }
    }
    if canonical_name == "market.readDecisionContext" {
        if let Some(candidate) = object.get_mut("candidate").and_then(Value::as_object_mut) {
            candidate.insert("lever".to_string(), json!(run.target_leverage.to_string()));
        }
    }
    if matches!(
        canonical_name,
        "trade.evaluatePlan"
            | "trade.precheck"
            | "tradeOpportunity.create"
            | "tradeOpportunity.revise"
            | "tradeOpportunity.reuse"
            | "market.readDecisionContext"
    ) {
        object.insert(
            "maxSingleTradeMarginPct".to_string(),
            json!(run.max_single_trade_margin_pct),
        );
    }
    Ok(())
}

fn ensure_ai_trade_is_demo(
    app: &tauri::AppHandle,
    canonical_name: &str,
    input: &serde_json::Value,
    context: &AiToolExecutionContext,
) -> Result<(), String> {
    if !matches!(
        canonical_name,
        "trade.placeOrder"
            | "trade.cancelOrder"
            | "trade.amendOrder"
            | "trade.setLeverage"
            | "trade.setMarginMode"
            | "trade.closePosition"
    ) {
        return Ok(());
    }
    if canonical_name == "trade.setLeverage"
        && context.run_context.as_ref().is_some_and(|run| {
            run.is_background()
                && matches!(
                    desic_agent_automation::normalize_permission_mode(Some(&run.permission_mode,)),
                    "copilot" | "limited_auto"
                )
                && input
                    .get("lever")
                    .and_then(Value::as_str)
                    .and_then(|value| value.parse::<u32>().ok())
                    == Some(run.target_leverage)
        })
    {
        return Ok(());
    }
    if input
        .get("environment")
        .and_then(Value::as_str)
        .map(normalize_environment)
        .as_deref()
        == Some("live")
    {
        return Err(
            "AI 直接交易工具不允许操作实盘；实盘自动执行必须走交易机会审批/执行链路".to_string(),
        );
    }
    let account_id = input.get("accountId").and_then(Value::as_str);
    let account = load_local_account_secret(app, account_id)?;
    if normalize_environment(&account.environment) == "live" {
        return Err(
            "AI 直接交易工具不允许操作实盘账号；实盘自动执行必须走交易机会审批/执行链路"
                .to_string(),
        );
    }
    Ok(())
}

fn ensure_opportunity_in_run_scope(
    opportunity: &serde_json::Value,
    context: &AiToolExecutionContext,
) -> Result<(), String> {
    let Some(run) = context
        .run_context
        .as_ref()
        .filter(|run| run.is_background())
    else {
        return Ok(());
    };
    if let Some(expected) = run.account_id.as_deref() {
        let actual = opportunity
            .get("accountId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if actual != expected {
            return Err("交易机会不属于当前 Agent Profile 账号".to_string());
        }
    }
    if let Some(expected) = run.environment.as_deref() {
        let actual = opportunity
            .get("environment")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if normalize_environment(actual) != normalize_environment(expected) {
            return Err("交易机会不属于当前 Agent Profile 环境".to_string());
        }
    }
    if !run.symbols.is_empty() {
        let actual = opportunity
            .get("instId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !run.symbols.iter().any(|allowed| allowed == actual) {
            return Err("交易机会不属于当前 Agent Profile 关注品种".to_string());
        }
    }
    Ok(())
}

fn ensure_ai_run_is_active_blocking(
    app: &tauri::AppHandle,
    context: &AiToolExecutionContext,
) -> Result<(), String> {
    let Some(run) = context.run_context.as_ref() else {
        return Ok(());
    };
    let conn = open_read_database(app)?;
    if (run.is_background() || run.is_review())
        && !crate::ai_automation::automation_master_enabled_with_conn(&conn)
    {
        return Err("AI 自动化总开关已关闭，拒绝继续调用工具".to_string());
    }
    if run.is_background() {
        let run_id = run
            .run_id
            .as_deref()
            .ok_or_else(|| "缺少后台 Run ID".to_string())?;
        let state = conn
            .query_row(
                "SELECT r.status,p.enabled,p.deleted_at
                 FROM ai_agent_runs r JOIN ai_agent_profiles p ON p.id=r.profile_id WHERE r.id=?1",
                [run_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)? != 0,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|err| err.to_string())?
            .ok_or_else(|| "后台 Run 不存在".to_string())?;
        if state.0 != "running" || !state.1 || state.2.is_some() {
            return Err(format!(
                "后台 Run 或 Profile 已不再运行，拒绝继续调用工具：{}",
                state.0
            ));
        }
    }
    if run.is_review() {
        let review_id = run
            .review_id
            .as_deref()
            .ok_or_else(|| "缺少复盘 ID".to_string())?;
        let status = conn
            .query_row(
                "SELECT status FROM ai_trade_reviews WHERE id=?1",
                [review_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|err| err.to_string())?
            .ok_or_else(|| "复盘 Run 不存在".to_string())?;
        if status != "running" {
            return Err(format!("复盘 Run 已不再运行，拒绝继续调用工具：{status}"));
        }
    }
    Ok(())
}

async fn ensure_ai_run_is_active(
    app: &tauri::AppHandle,
    context: &AiToolExecutionContext,
) -> Result<(), String> {
    if context.run_context.is_none() {
        return Ok(());
    }
    let app = app.clone();
    let context = context.clone();
    tauri::async_runtime::spawn_blocking(move || ensure_ai_run_is_active_blocking(&app, &context))
        .await
        .map_err(|error| format!("校验 Agent Run 状态任务失败：{error}"))?
}

fn merge_ai_tool_timing(value: &mut Value, fields: &[(&str, u128)]) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    let timing = object
        .entry("timing")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let Some(timing) = timing.as_object_mut() else {
        return;
    };
    for (name, value) in fields {
        timing.insert((*name).to_string(), json!(*value));
    }
}

async fn execute_ai_tool(
    app: tauri::AppHandle,
    tool_name: &str,
    mut input: serde_json::Value,
    context: &AiToolExecutionContext,
) -> Result<serde_json::Value, String> {
    let tool_started = Instant::now();
    let canonical_name = canonical_ai_tool_name(tool_name);
    authorize_ai_tool(canonical_name, context)?;
    let session_id = context.session_id.as_str();
    if matches!(
        canonical_name,
        "strategy.readCurrentSource" | "strategy.testCurrentSource" | "strategy.applySource"
    ) {
        ensure_ai_run_is_active(&app, context).await?;
        return systematic_strategy_ai_execute_tool(app, canonical_name, input, session_id).await;
    }
    inject_ai_execution_context(&mut input, context);
    ensure_ai_run_is_active(&app, context).await?;
    enforce_background_run_scope(canonical_name, &mut input, context)?;
    ensure_ai_trade_is_demo(&app, canonical_name, &input, context)?;
    let preflight_ms = tool_started.elapsed().as_millis();
    if canonical_name.starts_with("intelligence.") {
        if context
            .account_context_id
            .as_deref()
            .is_none_or(str::is_empty)
        {
            return Err("市场情报工具必须使用当前 UI 账户或后台 Profile 绑定账户".to_string());
        }
        let runtime = app.state::<IntelligenceRuntime>();
        return intelligence::execute_intelligence_tool(
            app.clone(),
            runtime,
            canonical_name,
            input,
            context.account_context_id.as_deref(),
        )
        .await;
    }
    match canonical_name {
        "market.readTicker" => {
            let request: AiMarketReadRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            let runtime = app.state::<MarketRuntime>();
            let ticker = ai_read_ticker(runtime.inner(), &request.inst_id).await?;
            Ok(ticker)
        }
        "market.readInstrument" => {
            let handler_started = Instant::now();
            let request: AiMarketReadRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            let instrument = fetch_instrument(&app, &request.inst_id).await?;
            let summary = instrument_summary_from(instrument, None, false, now_ms());
            let fractional_contracts_allowed = instrument_allows_fractional_contracts(&summary);
            let minimum_base_quantity = instrument_minimum_base_quantity(&summary);
            let quantity_instruction = instrument_quantity_instruction(&summary);
            let mut result = json!({
                "summary": format!(
                    "{} 合约规格：1张={} {}，数量步进 lotSz={}；{}；价格步进 tickSz={}，最大杠杆 {}X（不是账户当前杠杆），状态 {}",
                    summary.inst_id,
                    summary.ct_val,
                    summary.ct_val_ccy,
                    summary.lot_sz,
                    quantity_instruction,
                    summary.tick_sz,
                    summary.lever,
                    summary.state
                ),
                "instrument": summary.clone(),
                "unitRules": {
                    "sizeUnit": "contract",
                    "sizeField": "size",
                    "sizeMeaning": "OKX 永续合约下单数量使用张数，不是币数量。",
                    "fractionalContractsAllowed": fractional_contracts_allowed,
                    "quantityInstruction": quantity_instruction,
                    "contractValue": summary.ct_val,
                    "contractValueCurrency": summary.ct_val_ccy,
                    "quantityStep": summary.lot_sz,
                    "minimumSize": summary.min_sz,
                    "minimumBaseQuantity": minimum_base_quantity,
                    "minimumNotionalFormula": "minimumSize * contractValue * price",
                    "estimatedMarginFormula": "size * contractValue * price / currentLeverage",
                    "adverseMoveLossFormula": "size * contractValue * price * adverseMoveRatio",
                    "priceStep": summary.tick_sz,
                    "maximumLimitSize": summary.max_lmt_sz,
                    "maximumMarketSize": summary.max_mkt_sz,
                    "maximumLeverage": summary.lever,
                    "leverageMeaning": "maximumLeverage 是合约上限，不是账户当前杠杆；保证金必须使用 Profile 计划杠杆或 OKX 当前已同步杠杆。",
                    "accountAffordabilityRule": "判断余额不足、无法开仓或建议充值前，必须使用 size=minimumSize 和实际计划参数调用 trade.precheck。"
                },
                "source": "okx-public-instruments",
                "updatedAt": now_ms()
            });
            merge_ai_tool_timing(
                &mut result,
                &[
                    ("preflightMs", preflight_ms),
                    ("handlerMs", handler_started.elapsed().as_millis()),
                    ("totalMs", tool_started.elapsed().as_millis()),
                ],
            );
            Ok(result)
        }
        "market.readOrderBook" => {
            let request: AiMarketReadRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            let depth = request.depth.unwrap_or(5).clamp(1, 50);
            let runtime = app.state::<MarketRuntime>();
            ai_read_orderbook(runtime.inner(), &request.inst_id, depth).await
        }
        "market.readRecentTrades" => {
            let request: AiMarketReadRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            let limit = request.limit.unwrap_or(20).clamp(1, 100);
            let runtime = app.state::<MarketRuntime>();
            ai_read_recent_trades(runtime.inner(), &request.inst_id, limit).await
        }
        "market.readCandles" => {
            let handler_started = Instant::now();
            let request: AiMarketReadRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            let bars = normalize_ai_bars(request.bars, request.bar.as_deref());
            let limit = request.limit.unwrap_or(60).clamp(1, 300);
            let runtime = app.state::<MarketRuntime>();
            let mut result = if bars.len() == 1
                && request.start_time.is_none()
                && request.end_time.is_none()
                && !request.confirmed_only.unwrap_or(false)
            {
                ai_read_candles(&app, runtime.inner(), &request.inst_id, &bars[0], limit).await
            } else {
                ai_read_multi_candles(
                    &app,
                    runtime.inner(),
                    &request.inst_id,
                    &bars,
                    limit,
                    request.start_time,
                    request.end_time,
                    request.confirmed_only.unwrap_or(false),
                )
                .await
            }?;
            merge_ai_tool_timing(
                &mut result,
                &[
                    ("preflightMs", preflight_ms),
                    ("handlerMs", handler_started.elapsed().as_millis()),
                    ("totalMs", tool_started.elapsed().as_millis()),
                ],
            );
            Ok(result)
        }
        "market.readFundingRate" => {
            let request: AiMarketReadRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            let runtime = app.state::<MarketRuntime>();
            ai_read_funding_rate(runtime.inner(), &request.inst_id).await
        }
        "market.readDecisionContext" => {
            let request: DecisionContextRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            let runtime = app.state::<MarketRuntime>();
            read_decision_context(app.clone(), runtime, request).await
        }
        "market.scanWatchlist" => {
            let request: AiMarketScanRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            let runtime = app.state::<MarketRuntime>();
            ai_scan_watchlist(&app, runtime.inner(), request).await
        }
        "market.readIndicators" => {
            let request: AiIndicatorRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            let runtime = app.state::<MarketRuntime>();
            ai_read_indicators(&app, runtime.inner(), request).await
        }
        "account.readSnapshot" => {
            let request: PrivateSnapshotRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            if let Some(snapshot) = ai_read_memory_account_snapshot(
                app.state::<MarketRuntime>().inner(),
                request.account_id.as_deref(),
            ) {
                let age_ms = now_ms().saturating_sub(snapshot.synced_at);
                return Ok(ai_account_snapshot_tool_value(snapshot, "memory", age_ms));
            }
            let snapshot = okx_private_snapshot(app, request).await?;
            Ok(ai_account_snapshot_tool_value(
                snapshot,
                "okx-private-rest",
                0,
            ))
        }
        "account.readBalances"
        | "account.readPositions"
        | "account.readOpenOrders"
        | "account.readRisk" => {
            let request: PrivateSnapshotRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            let mut value = ai_read_account_part(app.clone(), canonical_name, request).await?;
            if canonical_name == "account.readRisk" {
                if let Some(run) = context
                    .run_context
                    .as_ref()
                    .filter(|run| run.is_background())
                {
                    add_profile_position_sizing_limit(&app, &mut value, run).await;
                }
            }
            Ok(value)
        }
        "account.readOrderStatus" => {
            let request: OrderStatusRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            ai_read_order_status(app, request).await
        }
        "account.readHistoricalOrders" => {
            let request: AiHistoricalReadRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            ai_read_historical_orders(app, request)
        }
        "account.readHistoricalFills" => {
            let request: AiHistoricalReadRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            ai_read_historical_fills(app, request)
        }
        "account.readBills" => {
            let request: AiHistoricalReadRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            ai_read_account_bills(app, request)
        }
        "account.readPositionEpisodes" => {
            let request: AiHistoricalReadRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            ai_read_position_episodes(app, request)
        }
        "journal.createNote" => {
            let request: AiJournalNoteRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            Ok(json!({
                "id": format!("journal-{}-{}", session_id, now_ms()),
                "sessionId": session_id,
                "title": request.title.unwrap_or_else(|| "AI 交易复盘记录".to_string()),
                "content": request.content,
                "tags": request.tags.unwrap_or_default(),
                "metadata": request.metadata.unwrap_or_else(|| json!({})),
                "createdAt": now_ms(),
                "scope": "ai-session"
            }))
        }
        "trade.evaluatePlan" => {
            let request: TradePlanEvaluationRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            evaluate_ai_trade_plan(&app, request).await
        }
        "trade.precheck" => {
            let mut request: TradePrecheckRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            if request.ticket_mode.trim().is_empty() {
                request.ticket_mode = if request
                    .action
                    .as_deref()
                    .unwrap_or_default()
                    .starts_with("close")
                {
                    "close"
                } else {
                    "open"
                }
                .to_string();
            }
            if request.price.trim().is_empty() {
                request.price = "0".to_string();
            }
            if request.lever.trim().is_empty() {
                request.lever = "1".to_string();
            }
            let state_app = app.clone();
            let market_runtime = state_app.state::<MarketRuntime>();
            let result = trade_precheck(app, request, market_runtime).await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        "tradeOpportunity.list" => {
            let filters = input.clone();
            let mut rows = trade_opportunities(app)?;
            if let Some(status) = filters
                .get("status")
                .and_then(|item| item.as_str())
                .filter(|item| !item.trim().is_empty())
            {
                rows.retain(|item| item.status == status);
            }
            if let Some(inst_id) = filters
                .get("instId")
                .and_then(|item| item.as_str())
                .filter(|item| !item.trim().is_empty())
            {
                rows.retain(|item| item.inst_id == inst_id);
            }
            if let Some(account_id) = filters
                .get("accountId")
                .and_then(|item| item.as_str())
                .filter(|item| !item.trim().is_empty())
            {
                rows.retain(|item| item.account_id.as_deref() == Some(account_id));
            }
            if context
                .run_context
                .as_ref()
                .is_some_and(BackgroundRunContext::is_background)
            {
                rows.retain(|item| {
                    serde_json::to_value(item).ok().is_some_and(|value| {
                        ensure_opportunity_in_run_scope(&value, context).is_ok()
                    })
                });
            }
            let limit = filters
                .get("limit")
                .and_then(|item| item.as_u64())
                .unwrap_or(100)
                .clamp(1, 200) as usize;
            rows.truncate(limit);
            serde_json::to_value(rows).map_err(|err| err.to_string())
        }
        "tradeOpportunity.get" => {
            let id = input
                .get("id")
                .and_then(|item| item.as_str())
                .filter(|item| !item.trim().is_empty())
                .ok_or_else(|| "tradeOpportunity.get 缺少 id".to_string())?;
            let result = trade_opportunity_get(app, id.to_string())?;
            let value = serde_json::to_value(result).map_err(|err| err.to_string())?;
            ensure_opportunity_in_run_scope(&value, context)?;
            Ok(value)
        }
        "tradeOpportunity.create" => {
            let mut request: TradeOpportunityCreateRequest = if context
                .run_context
                .as_ref()
                .is_some_and(BackgroundRunContext::is_background)
            {
                let commit: TradeOpportunityCommitRequest = serde_json::from_value(input)
                    .map_err(|err| format!("tradeOpportunity.create 提交参数无效：{err}"))?;
                materialize_trade_opportunity_commit(&app, commit, session_id)?
            } else {
                if let Some(object) = input.as_object_mut() {
                    object
                        .entry("sourceSessionId".to_string())
                        .or_insert_with(|| json!(session_id));
                }
                validate_trade_opportunity_input_shape(&input)?;
                serde_json::from_value(input)
                    .map_err(|err| format!("tradeOpportunity.create 参数无效：{err}"))?
            };
            if request
                .source_session_id
                .as_deref()
                .unwrap_or("")
                .trim()
                .is_empty()
            {
                request.source_session_id = Some(session_id.to_string());
            }
            let state_app = app.clone();
            let market_runtime = state_app.state::<MarketRuntime>();
            let mut result = trade_opportunity_create(app.clone(), market_runtime, request).await?;
            if desic_agent_automation::normalize_permission_mode(Some(&context.permission_mode))
                == "limited_auto"
            {
                let value = serde_json::to_value(&result).map_err(|err| err.to_string())?;
                let reused =
                    value.get("duplicateResolution").and_then(Value::as_str) == Some("reuse");
                if !reused && value.get("conflict").map(Value::is_null).unwrap_or(true) {
                    result = auto_execute_trade_opportunity_for_ai(
                        &app,
                        value.get("id").and_then(Value::as_str).unwrap_or_default(),
                        context,
                        session_id,
                    )
                    .await?;
                }
            }
            let value = serde_json::to_value(result).map_err(|err| err.to_string())?;
            ensure_opportunity_in_run_scope(&value, context)?;
            Ok(value)
        }
        "tradeOpportunity.revise" => {
            let mut request: TradeOpportunityMutationRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            if let Some(run) = context.run_context.as_ref() {
                request.agent_profile_id = run.profile_id.clone();
                request.agent_run_id = run.run_id.clone().or_else(|| Some(session_id.to_string()));
            }
            let current = trade_opportunity_get(app.clone(), request.id.clone())?;
            let current_value = serde_json::to_value(current).map_err(|err| err.to_string())?;
            ensure_opportunity_in_run_scope(&current_value, context)?;
            let state_app = app.clone();
            let market_runtime = state_app.state::<MarketRuntime>();
            let mut result = trade_opportunity_revise(app.clone(), market_runtime, request).await?;
            if desic_agent_automation::normalize_permission_mode(Some(&context.permission_mode))
                == "limited_auto"
                && result.status == "pending"
            {
                result =
                    auto_execute_trade_opportunity_for_ai(&app, &result.id, context, session_id)
                        .await?;
            }
            let value = serde_json::to_value(result).map_err(|err| err.to_string())?;
            ensure_opportunity_in_run_scope(&value, context)?;
            Ok(value)
        }
        "tradeOpportunity.reuse" => {
            let mut request: TradeOpportunityMutationRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            if let Some(run) = context.run_context.as_ref() {
                request.agent_profile_id = run.profile_id.clone();
                request.agent_run_id = run.run_id.clone().or_else(|| Some(session_id.to_string()));
            }
            let current = trade_opportunity_get(app.clone(), request.id.clone())?;
            let current_value = serde_json::to_value(current).map_err(|err| err.to_string())?;
            ensure_opportunity_in_run_scope(&current_value, context)?;
            let mut result = trade_opportunity_reuse(app.clone(), request)?;
            if desic_agent_automation::normalize_permission_mode(Some(&context.permission_mode))
                == "limited_auto"
                && result.status == "pending"
            {
                result =
                    auto_execute_trade_opportunity_for_ai(&app, &result.id, context, session_id)
                        .await?;
            }
            let value = serde_json::to_value(result).map_err(|err| err.to_string())?;
            ensure_opportunity_in_run_scope(&value, context)?;
            Ok(value)
        }
        "tradeOpportunity.close" => {
            let request: TradeOpportunityMutationRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            let current = trade_opportunity_get(app.clone(), request.id.clone())?;
            let current_value = serde_json::to_value(current).map_err(|err| err.to_string())?;
            ensure_opportunity_in_run_scope(&current_value, context)?;
            let result = trade_opportunity_close(app, request)?;
            let value = serde_json::to_value(result).map_err(|err| err.to_string())?;
            ensure_opportunity_in_run_scope(&value, context)?;
            Ok(value)
        }
        "notification.feishu.send" => {
            let request: FeishuSendInput =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            let result = notification_feishu_send(app, request).await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        "background.finishRun" => {
            let request: BackgroundFinishRunInput =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            let run = context
                .run_context
                .as_ref()
                .ok_or_else(|| "缺少后台 Run 上下文".to_string())?;
            background_finish_run(app, run, request)
        }
        "review.complete" => {
            let request: ReviewCompleteInput =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            let run = context
                .run_context
                .as_ref()
                .ok_or_else(|| "缺少复盘 Run 上下文".to_string())?;
            review_complete(app, run, request)
        }
        "review.readSkillVersion" => {
            let request: ReviewSkillVersionInput =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            let run = context
                .run_context
                .as_ref()
                .ok_or_else(|| "缺少复盘 Run 上下文".to_string())?;
            review_read_skill_version(app, run, request)
        }
        "optimizationSuggestion.create" => {
            let request: OptimizationSuggestionInput =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            let run = context
                .run_context
                .as_ref()
                .ok_or_else(|| "缺少复盘 Run 上下文".to_string())?;
            optimization_suggestion_create(app, run, request)
        }
        "chart.createDrawing"
        | "chart.updateDrawing"
        | "chart.deleteDrawing"
        | "alert.createPriceAlert"
        | "alert.updatePriceAlert"
        | "alert.deletePriceAlert"
        | "alert.listPriceAlerts"
        | "script.createOrUpdate"
        | "script.run"
        | "script.enable"
        | "script.delete"
        | "script.list" => {
            let request: AiUiActionRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            emit_ai_ui_action(&app, canonical_name, request, session_id)
        }
        "trade.placeOrder" => {
            let mut request: PlaceOrderRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            request.operator = Some("ai".to_string());
            request.session_id = Some(session_id.to_string());
            request.agent_run_id = context
                .run_context
                .as_ref()
                .and_then(|run| run.run_id.clone())
                .or_else(|| Some(session_id.to_string()));
            let state_app = app.clone();
            let market_runtime = state_app.state::<MarketRuntime>();
            let result = okx_place_order(app, market_runtime, request).await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        "trade.cancelOrder" => {
            let mut request: CancelOrderRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            request.operator = Some("ai".to_string());
            request.agent_run_id = context
                .run_context
                .as_ref()
                .and_then(|run| run.run_id.clone())
                .or_else(|| Some(session_id.to_string()));
            let state_app = app.clone();
            let market_runtime = state_app.state::<MarketRuntime>();
            let result = okx_cancel_order(market_runtime, app, request).await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        "trade.amendOrder" => {
            let mut request: AmendOrderRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            request.operator = Some("ai".to_string());
            request.agent_run_id = context
                .run_context
                .as_ref()
                .and_then(|run| run.run_id.clone())
                .or_else(|| Some(session_id.to_string()));
            let state_app = app.clone();
            let market_runtime = state_app.state::<MarketRuntime>();
            let result = okx_amend_order(app, market_runtime, request).await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        "trade.setLeverage" => {
            let mut request: SetLeverageRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            request.operator = Some("ai".to_string());
            request.profile_target_authorized = context.run_context.as_ref().is_some_and(|run| {
                run.is_background()
                    && request.lever == run.target_leverage.to_string()
                    && matches!(
                        desic_agent_automation::normalize_permission_mode(Some(
                            &run.permission_mode,
                        )),
                        "copilot" | "limited_auto"
                    )
            });
            request.agent_run_id = context
                .run_context
                .as_ref()
                .and_then(|run| run.run_id.clone())
                .or_else(|| Some(session_id.to_string()));
            let result = okx_set_leverage(app, request).await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        "trade.setMarginMode" => {
            let request: SetMarginModeRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            if !matches!(request.mgn_mode.as_str(), "cross" | "isolated") {
                return Err("保证金模式必须是 cross 或 isolated".to_string());
            }
            if !matches!(request.environment.as_str(), "demo" | "live") {
                return Err("交易环境必须是 demo 或 live".to_string());
            }
            if let Some(account_id) = request.account_id.as_deref() {
                let account = load_local_account_secret(&app, Some(account_id))?;
                if normalize_environment(&account.environment)
                    != normalize_environment(&request.environment)
                {
                    return Err("账号环境与当前交易环境不一致".to_string());
                }
            }
            Ok(json!({
                "instId": request.inst_id,
                "mgnMode": request.mgn_mode,
                "environment": request.environment,
                "applied": true,
                "exchangeCall": false,
                "message": "OKX 保证金模式由下单 tdMode 指定，已确认后续交易参数。"
            }))
        }
        "trade.closePosition" => {
            let request: ClosePositionRequest =
                serde_json::from_value(input).map_err(|err| err.to_string())?;
            let state_app = app.clone();
            let market_runtime = state_app.state::<MarketRuntime>();
            let result = okx_close_position_with_actor(
                app,
                market_runtime,
                request,
                "ai",
                Some(session_id.to_string()),
            )
            .await?;
            serde_json::to_value(result).map_err(|err| err.to_string())
        }
        _ => Err(format!("未知 AI 工具：{}", tool_name)),
    }
}

fn canonical_ai_tool_name(name: &str) -> &str {
    match name {
        "order.create" | "okx.placeOrder" => "trade.placeOrder",
        "order.cancel" | "okx.cancelOrder" => "trade.cancelOrder",
        "okx.amendOrder" => "trade.amendOrder",
        "okx.setLeverage" => "trade.setLeverage",
        "okx.setMarginMode" => "trade.setMarginMode",
        "okx.closePosition" => "trade.closePosition",
        value => value,
    }
}

fn normalize_ai_bars(bars: Option<Vec<String>>, fallback_bar: Option<&str>) -> Vec<String> {
    let values = bars.unwrap_or_else(|| vec![fallback_bar.unwrap_or("5m").to_string()]);
    let mut normalized = values
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| bar_ms(item).is_some())
        .collect::<Vec<_>>();
    normalized.sort_by_key(|bar| bar_ms(bar).unwrap_or(i64::MAX));
    normalized.dedup();
    if normalized.is_empty() {
        normalized.push("5m".to_string());
    }
    normalized.truncate(12);
    normalized
}

async fn ai_read_ticker(
    runtime: &MarketRuntime,
    inst_id: &str,
) -> Result<serde_json::Value, String> {
    if let Some(ticker) = runtime.store.lock().ok().and_then(|store| {
        store
            .tickers
            .get(inst_id)
            .cloned()
            .or_else(|| store.ticker.clone().filter(|item| item.inst_id == inst_id))
    }) {
        return Ok(ai_ticker_value(ticker, "memory"));
    }
    let path = format!("/api/v5/market/ticker?instId={}", url_encode(inst_id));
    let envelope: OkxEnvelope<Ticker> = get_json(&path).await?;
    let ticker = envelope
        .data
        .into_iter()
        .next()
        .ok_or_else(|| "ticker data empty".to_string())?;
    Ok(ai_ticker_value(ticker, "api"))
}

fn ai_ticker_value(ticker: Ticker, source: &str) -> serde_json::Value {
    let summary = format!(
        "{} 最新价 {}，买一 {}，卖一 {}，24H 高 {}，低 {}，成交额 {} USDT，来源 {}",
        ticker.inst_id,
        ticker.last,
        ticker.bid_px,
        ticker.ask_px,
        ticker.high24h,
        ticker.low24h,
        ticker.vol_ccy24h,
        source
    );
    json!({
        "source": source,
        "ageMs": now_ms().saturating_sub(ticker.ts),
        "summary": summary,
        "ticker": ticker
    })
}

async fn ai_read_orderbook(
    runtime: &MarketRuntime,
    inst_id: &str,
    depth: u16,
) -> Result<serde_json::Value, String> {
    if let Some(book) = runtime.store.lock().ok().and_then(|store| {
        store.orderbooks.get(inst_id).cloned().or_else(|| {
            if store.orderbook_inst_id.as_deref() == Some(inst_id) {
                store.orderbook.clone()
            } else {
                None
            }
        })
    }) {
        return Ok(ai_orderbook_value(inst_id, depth, book, "memory"));
    }
    let path = format!(
        "/api/v5/market/books?instId={}&sz={}",
        url_encode(inst_id),
        depth
    );
    let envelope: OkxEnvelope<serde_json::Value> = get_json(&path).await?;
    let row = envelope
        .data
        .into_iter()
        .next()
        .ok_or_else(|| "order book data empty".to_string())?;
    let bids = row
        .get("bids")
        .and_then(|item| item.as_array())
        .cloned()
        .unwrap_or_default();
    let asks = row
        .get("asks")
        .and_then(|item| item.as_array())
        .cloned()
        .unwrap_or_default();
    let bid_total = ai_book_size_sum(&bids);
    let ask_total = ai_book_size_sum(&asks);
    let observed_at = json_i64(&row, "ts").unwrap_or_else(now_ms);
    let seq_id = row.get("seqId").and_then(Value::as_str).map(str::to_string);
    let snapshot_id = ai_orderbook_snapshot_id(inst_id, observed_at, seq_id.as_deref());
    let summary = format!(
        "{} 盘口前 {} 档：买一 {}，卖一 {}，买盘量 {:.4}，卖盘量 {:.4}，观测时间 {}，快照 {}",
        inst_id,
        depth,
        ai_book_level_text(bids.first()),
        ai_book_level_text(asks.first()),
        bid_total,
        ask_total,
        observed_at,
        snapshot_id
    );
    Ok(json!({
        "source": "api",
        "summary": summary,
        "instId": inst_id,
        "depth": depth,
        "bids": bids,
        "asks": asks,
        "bidTotal": bid_total,
        "askTotal": ask_total,
        "ts": observed_at,
        "observedAt": observed_at,
        "seqId": seq_id,
        "snapshotId": snapshot_id
    }))
}

fn ai_orderbook_value(
    inst_id: &str,
    depth: u16,
    book: OrderBook,
    source: &str,
) -> serde_json::Value {
    let bids = book
        .bids
        .iter()
        .take(depth as usize)
        .cloned()
        .collect::<Vec<_>>();
    let asks = book
        .asks
        .iter()
        .take(depth as usize)
        .cloned()
        .collect::<Vec<_>>();
    let bid_json = serde_json::to_value(&bids).unwrap_or_else(|_| json!([]));
    let ask_json = serde_json::to_value(&asks).unwrap_or_else(|_| json!([]));
    let bid_levels = bid_json.as_array().cloned().unwrap_or_default();
    let ask_levels = ask_json.as_array().cloned().unwrap_or_default();
    let bid_total = bids
        .iter()
        .filter_map(|item| item.sz.parse::<f64>().ok())
        .sum::<f64>();
    let ask_total = asks
        .iter()
        .filter_map(|item| item.sz.parse::<f64>().ok())
        .sum::<f64>();
    let observed_at = book.ts;
    let snapshot_id = ai_orderbook_snapshot_id(inst_id, observed_at, book.seq_id.as_deref());
    let summary = format!(
        "{} 盘口前 {} 档：买一 {}，卖一 {}，买盘量 {:.4}，卖盘量 {:.4}，来源 {}，观测时间 {}，快照 {}",
        inst_id,
        depth,
        ai_book_level_text(bid_levels.first()),
        ai_book_level_text(ask_levels.first()),
        bid_total,
        ask_total,
        source,
        observed_at,
        snapshot_id
    );
    json!({
        "source": source,
        "ageMs": now_ms().saturating_sub(observed_at),
        "summary": summary,
        "instId": inst_id,
        "depth": depth,
        "bids": bids,
        "asks": asks,
        "bidTotal": bid_total,
        "askTotal": ask_total,
        "ts": observed_at,
        "observedAt": observed_at,
        "seqId": book.seq_id,
        "snapshotId": snapshot_id
    })
}

async fn ai_read_recent_trades(
    runtime: &MarketRuntime,
    inst_id: &str,
    limit: u16,
) -> Result<serde_json::Value, String> {
    if let Some(trades) = runtime.store.lock().ok().and_then(|store| {
        store
            .trades_by_inst
            .get(inst_id)
            .filter(|items| !items.is_empty())
            .map(|items| {
                items
                    .iter()
                    .take(limit as usize)
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .or_else(|| {
                if store.trades_inst_id.as_deref() == Some(inst_id) && !store.trades.is_empty() {
                    Some(
                        store
                            .trades
                            .iter()
                            .take(limit as usize)
                            .cloned()
                            .collect::<Vec<_>>(),
                    )
                } else {
                    None
                }
            })
    }) {
        return Ok(ai_trades_value(inst_id, trades, "memory"));
    }
    let path = format!(
        "/api/v5/market/trades?instId={}&limit={}",
        url_encode(inst_id),
        limit
    );
    let envelope: OkxEnvelope<serde_json::Value> = get_json(&path).await?;
    let buy_count = envelope
        .data
        .iter()
        .filter(|item| item.get("side").and_then(|side| side.as_str()) == Some("buy"))
        .count();
    let sell_count = envelope.data.len().saturating_sub(buy_count);
    let total_size = envelope
        .data
        .iter()
        .filter_map(|item| {
            item.get("sz")
                .and_then(|value| value.as_str())?
                .parse::<f64>()
                .ok()
        })
        .sum::<f64>();
    let latest = envelope
        .data
        .first()
        .and_then(|item| item.get("px").and_then(|value| value.as_str()))
        .unwrap_or("--");
    let summary = format!(
        "{} 最近 {} 笔成交：最新 {}，主动买 {}，主动卖 {}，合计张数 {:.4}",
        inst_id,
        envelope.data.len(),
        latest,
        buy_count,
        sell_count,
        total_size
    );
    Ok(json!({
        "summary": summary,
        "instId": inst_id,
        "trades": envelope.data,
        "buyCount": buy_count,
        "sellCount": sell_count,
        "totalSize": total_size
    }))
}

fn ai_trades_value(inst_id: &str, trades: Vec<Trade>, source: &str) -> serde_json::Value {
    let buy_count = trades.iter().filter(|item| item.side == "buy").count();
    let sell_count = trades.len().saturating_sub(buy_count);
    let total_size = trades
        .iter()
        .filter_map(|item| item.sz.parse::<f64>().ok())
        .sum::<f64>();
    let latest = trades.first().map(|item| item.px.as_str()).unwrap_or("--");
    let latest_ts = trades.first().map(|item| item.ts).unwrap_or_default();
    let summary = format!(
        "{} 最近 {} 笔成交：最新 {}，主动买 {}，主动卖 {}，合计张数 {:.4}，来源 {}",
        inst_id,
        trades.len(),
        latest,
        buy_count,
        sell_count,
        total_size,
        source
    );
    json!({
        "source": source,
        "ageMs": now_ms().saturating_sub(latest_ts),
        "summary": summary,
        "instId": inst_id,
        "trades": trades,
        "buyCount": buy_count,
        "sellCount": sell_count,
        "totalSize": total_size
    })
}

#[derive(Debug, Default, Clone)]
struct AiCandleRefreshStatus {
    attempted: bool,
    queued: bool,
    missing_before: usize,
    missing_after: usize,
    error: Option<String>,
}

impl AiCandleRefreshStatus {
    fn status(&self) -> &'static str {
        if self.error.is_some() {
            "failed"
        } else if self.queued {
            "queued"
        } else if self.missing_after > 0 {
            "incomplete"
        } else if self.attempted {
            "repaired"
        } else {
            "fresh"
        }
    }
}

fn expected_latest_confirmed_at(as_of: i64, interval_ms: i64, live: bool) -> i64 {
    if interval_ms <= 0 {
        return 0;
    }
    let effective = if live {
        as_of.saturating_sub(AI_CANDLE_CONFIRM_GRACE_MS)
    } else {
        as_of
    };
    effective
        .div_euclid(interval_ms)
        .saturating_mul(interval_ms)
}

fn recent_ai_candle_missing_open_times(
    app: &tauri::AppHandle,
    runtime: &MarketRuntime,
    inst_id: &str,
    as_of: i64,
) -> Result<Vec<i64>, String> {
    let expected_close = expected_latest_confirmed_at(as_of, 60_000, true);
    let last_expected_open = expected_close.saturating_sub(60_000);
    if last_expected_open <= 0 {
        return Ok(Vec::new());
    }
    let first_expected_open = last_expected_open
        .saturating_sub((AI_CANDLE_REPAIR_WINDOW_MINUTES - 1).saturating_mul(60_000));
    let conn = open_read_database(app)?;
    let database = local_candles_between(
        &conn,
        inst_id,
        "1m",
        first_expected_open,
        last_expected_open,
    )?;
    let memory = ai_memory_candles(runtime, inst_id, "1m");
    let merged = merge_candle_series(
        database,
        memory.iter().filter(|candle| {
            let open_time = candle.time.saturating_mul(1000);
            open_time >= first_expected_open && open_time <= last_expected_open
        }),
    );
    Ok(missing_confirmed_one_minute_open_times(
        &merged,
        first_expected_open,
        last_expected_open,
    ))
}

fn missing_confirmed_one_minute_open_times(
    candles: &[Candle],
    first_expected_open: i64,
    last_expected_open: i64,
) -> Vec<i64> {
    let confirmed = candles
        .iter()
        .filter(|candle| candle.confirm)
        .map(|candle| candle.time.saturating_mul(1000))
        .collect::<HashSet<_>>();
    let mut missing = Vec::new();
    let mut open_time = first_expected_open;
    while open_time <= last_expected_open {
        if !confirmed.contains(&open_time) {
            missing.push(open_time);
        }
        open_time = open_time.saturating_add(60_000);
    }
    missing
}

async fn ensure_recent_ai_candle_tail(
    app: &tauri::AppHandle,
    runtime: &MarketRuntime,
    inst_id: &str,
    as_of: i64,
) -> AiCandleRefreshStatus {
    let mut status = AiCandleRefreshStatus::default();
    let app_handle = app.clone();
    let runtime_handle = runtime.clone();
    let symbol = inst_id.to_string();
    let missing = match tauri::async_runtime::spawn_blocking(move || {
        recent_ai_candle_missing_open_times(&app_handle, &runtime_handle, &symbol, as_of)
    })
    .await
    {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            status.error = Some(format!("检查本地 K 线完整性失败：{error}"));
            return status;
        }
        Err(error) => {
            status.error = Some(format!("检查本地 K 线完整性任务失败：{error}"));
            return status;
        }
    };
    status.missing_before = missing.len();
    status.missing_after = missing.len();
    if missing.is_empty() {
        return status;
    }

    let repair_lock = match runtime.candle_repair_locks.lock() {
        Ok(mut locks) => locks
            .entry(inst_id.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone(),
        Err(error) => {
            status.error = Some(format!("K 线补洞锁不可用：{error}"));
            return status;
        }
    };
    let Ok(guard) = repair_lock.try_lock_owned() else {
        status.queued = true;
        return status;
    };
    status.queued = true;
    status.attempted = true;
    let app_handle = app.clone();
    let runtime_handle = runtime.clone();
    let symbol = inst_id.to_string();
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        let app_for_check = app_handle.clone();
        let runtime_for_check = runtime_handle.clone();
        let symbol_for_check = symbol.clone();
        let missing = match tauri::async_runtime::spawn_blocking(move || {
            recent_ai_candle_missing_open_times(
                &app_for_check,
                &runtime_for_check,
                &symbol_for_check,
                as_of,
            )
        })
        .await
        {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => {
                eprintln!("AI K 线补洞复检失败：{error}");
                return;
            }
            Err(error) => {
                eprintln!("AI K 线补洞复检任务失败：{error}");
                return;
            }
        };
        if missing.is_empty() {
            return;
        }
        let from_open = missing
            .first()
            .copied()
            .unwrap_or_else(|| as_of.saturating_sub(AI_CANDLE_REPAIR_WINDOW_MINUTES * 60_000));
        let to_open = align_open_time(as_of, "1m", 60_000);
        let fetched = match fetch_recent_market_candles(&symbol, "1m", from_open, to_open).await {
            Ok(value) => value,
            Err(error) => {
                eprintln!("AI K 线后台补洞失败：{error}");
                return;
            }
        };
        let result = tauri::async_runtime::spawn_blocking(move || {
            let mut conn = open_database(&app_handle)?;
            upsert_raw_candles(&mut conn, &symbol, "1m", &fetched, "ai-tail-repair")
        })
        .await;
        if let Err(error) = result.unwrap_or_else(|error| Err(error.to_string())) {
            eprintln!("AI K 线后台补洞写入失败：{error}");
        }
    });
    status
}

async fn ai_read_candles(
    app: &tauri::AppHandle,
    runtime: &MarketRuntime,
    inst_id: &str,
    bar: &str,
    limit: u16,
) -> Result<serde_json::Value, String> {
    let as_of = now_ms();
    let refresh_started = Instant::now();
    let refresh = ensure_recent_ai_candle_tail(app, runtime, inst_id, as_of).await;
    let refresh_check_ms = refresh_started.elapsed().as_millis();
    let has_memory = !ai_memory_candles(runtime, inst_id, "1m").is_empty();
    let bars = vec![bar.to_string()];
    let mut loaded =
        load_ai_candle_windows(app, runtime, inst_id, &bars, limit, None, None, false).await?;
    let candles = loaded
        .windows
        .pop()
        .map(|(_, candles)| candles)
        .unwrap_or_default();
    let mut result = ai_candles_value(
        inst_id,
        bar,
        candles,
        if has_memory {
            "database+memory:1m-derived"
        } else {
            "database:1m-derived"
        },
        as_of,
        true,
        Some(&refresh),
    );
    merge_ai_tool_timing(
        &mut result,
        &[
            ("refreshCheckMs", refresh_check_ms),
            ("databaseReadMs", loaded.database_read_ms),
            ("aggregateMs", loaded.aggregate_ms),
            ("databaseRows", loaded.database_rows as u128),
            ("memoryRows", loaded.memory_rows as u128),
            ("mergedRows", loaded.merged_rows as u128),
        ],
    );
    Ok(result)
}

async fn ai_read_multi_candles(
    app: &tauri::AppHandle,
    runtime: &MarketRuntime,
    inst_id: &str,
    bars: &[String],
    limit: u16,
    start_time: Option<i64>,
    end_time: Option<i64>,
    confirmed_only: bool,
) -> Result<serde_json::Value, String> {
    let now = now_ms();
    let live = end_time
        .map(normalize_ai_epoch_millis)
        .map(|value| value >= now.saturating_sub(120_000))
        .unwrap_or(true);
    let as_of = end_time
        .map(normalize_ai_epoch_millis)
        .unwrap_or(now)
        .min(now);
    let refresh_started = Instant::now();
    let refresh = if live {
        Some(ensure_recent_ai_candle_tail(app, runtime, inst_id, as_of).await)
    } else {
        None
    };
    let refresh_check_ms = refresh_started.elapsed().as_millis();
    let has_memory = !ai_memory_candles(runtime, inst_id, "1m").is_empty();
    let mut by_bar = serde_json::Map::new();
    let loaded = load_ai_candle_windows(
        app,
        runtime,
        inst_id,
        bars,
        limit,
        start_time,
        end_time,
        confirmed_only,
    )
    .await?;
    for (bar, candles) in loaded.windows.iter().cloned() {
        by_bar.insert(
            bar.clone(),
            ai_candles_value(
                inst_id,
                &bar,
                candles,
                if has_memory {
                    "database+memory:1m-derived"
                } else {
                    "database:1m-derived"
                },
                as_of,
                live,
                refresh.as_ref(),
            ),
        );
    }
    let mut result = json!({
        "summary": format!("{} 已读取 {} 个周期 K 线", inst_id, bars.len()),
        "instId": inst_id,
        "bars": by_bar
    });
    merge_ai_tool_timing(
        &mut result,
        &[
            ("refreshCheckMs", refresh_check_ms),
            ("databaseReadMs", loaded.database_read_ms),
            ("aggregateMs", loaded.aggregate_ms),
            ("databaseRows", loaded.database_rows as u128),
            ("memoryRows", loaded.memory_rows as u128),
            ("mergedRows", loaded.merged_rows as u128),
        ],
    );
    Ok(result)
}

#[derive(Clone)]
struct AiCandleReadWindow {
    bar: String,
    step: i64,
    start_open: i64,
    source_end_open: i64,
}

struct AiCandleLoadResult {
    windows: Vec<(String, Vec<Candle>)>,
    database_read_ms: u128,
    aggregate_ms: u128,
    database_rows: usize,
    memory_rows: usize,
    merged_rows: usize,
}

struct AiCandleWindowLoad {
    candles: Vec<Candle>,
    database_read_ms: u128,
    aggregate_ms: u128,
    database_rows: usize,
    memory_rows: usize,
    merged_rows: usize,
}

async fn load_ai_candle_windows(
    app: &tauri::AppHandle,
    runtime: &MarketRuntime,
    inst_id: &str,
    bars: &[String],
    limit: u16,
    start_time: Option<i64>,
    end_time: Option<i64>,
    confirmed_only: bool,
) -> Result<AiCandleLoadResult, String> {
    let end_value = end_time
        .map(normalize_ai_epoch_millis)
        .unwrap_or_else(now_ms);
    let mut windows = Vec::with_capacity(bars.len());
    for bar in bars {
        let step = bar_ms(bar).ok_or_else(|| format!("unsupported interval {bar}"))?;
        let mut end_open = align_open_time(end_value, bar, step);
        if confirmed_only && end_open.saturating_add(step).saturating_sub(1) > end_value {
            end_open = end_open.saturating_sub(step);
        }
        let start_open = start_time
            .map(normalize_ai_epoch_millis)
            .map(|value| align_open_time(value, bar, step))
            .unwrap_or_else(|| {
                end_open.saturating_sub((limit as i64).saturating_sub(1).saturating_mul(step))
            });
        windows.push(AiCandleReadWindow {
            bar: bar.clone(),
            step,
            start_open,
            source_end_open: if bar == "1m" {
                end_open
            } else {
                end_open.saturating_add(step).saturating_sub(60_000)
            },
        });
    }
    if windows.is_empty() {
        return Ok(AiCandleLoadResult {
            windows: Vec::new(),
            database_read_ms: 0,
            aggregate_ms: 0,
            database_rows: 0,
            memory_rows: 0,
            merged_rows: 0,
        });
    }
    let app_handle = app.clone();
    let symbol = inst_id.to_string();
    let memory_one_minute = ai_memory_candles(runtime, inst_id, "1m");
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_read_database(&app_handle)?;
        let mut loaded_windows = Vec::with_capacity(windows.len());
        let mut database_read_ms = 0;
        let mut aggregate_ms = 0;
        let mut database_rows = 0;
        let mut memory_rows = 0;
        let mut merged_rows = 0;
        for window in windows {
            let loaded = load_ai_candle_window(
                &conn,
                &symbol,
                &window,
                limit,
                confirmed_only,
                &memory_one_minute,
            )?;
            database_read_ms += loaded.database_read_ms;
            aggregate_ms += loaded.aggregate_ms;
            database_rows += loaded.database_rows;
            memory_rows += loaded.memory_rows;
            merged_rows += loaded.merged_rows;
            loaded_windows.push((window.bar, loaded.candles));
        }
        Ok(AiCandleLoadResult {
            windows: loaded_windows,
            database_read_ms,
            aggregate_ms,
            database_rows,
            memory_rows,
            merged_rows,
        })
    })
    .await
    .map_err(|error| format!("读取本地 K 线任务失败：{error}"))?
}

async fn ai_read_candles_for_range(
    app: &tauri::AppHandle,
    runtime: &MarketRuntime,
    inst_id: &str,
    bar: &str,
    limit: u16,
    start_time: Option<i64>,
    end_time: Option<i64>,
    confirmed_only: bool,
) -> Result<Vec<Candle>, String> {
    let bars = vec![bar.to_string()];
    let mut loaded = load_ai_candle_windows(
        app,
        runtime,
        inst_id,
        &bars,
        limit,
        start_time,
        end_time,
        confirmed_only,
    )
    .await?;
    Ok(loaded
        .windows
        .pop()
        .map(|(_, candles)| candles)
        .unwrap_or_default())
}

fn normalize_ai_epoch_millis(value: i64) -> i64 {
    if (-100_000_000_000..100_000_000_000).contains(&value) {
        value.saturating_mul(1000)
    } else {
        value
    }
}

fn ai_memory_candles(runtime: &MarketRuntime, inst_id: &str, bar: &str) -> Vec<Candle> {
    runtime
        .store
        .lock()
        .ok()
        .and_then(|store| {
            store
                .recent_candles
                .get(&format!("{}:{}", inst_id, bar))
                .cloned()
        })
        .unwrap_or_default()
}

fn ai_candles_value(
    inst_id: &str,
    bar: &str,
    candles: Vec<Candle>,
    source: &str,
    as_of: i64,
    live: bool,
    refresh: Option<&AiCandleRefreshStatus>,
) -> serde_json::Value {
    let now = now_ms();
    let interval_ms = bar_ms(bar).unwrap_or_default();
    let first = candles.first().map(|item| item.close).unwrap_or_default();
    let last = candles.last().map(|item| item.close).unwrap_or_default();
    let change = if first > 0.0 {
        (last - first) / first * 100.0
    } else {
        0.0
    };
    let high = candles.iter().map(|item| item.high).fold(0.0_f64, f64::max);
    let low = candles
        .iter()
        .map(|item| item.low)
        .filter(|value| *value > 0.0)
        .fold(f64::MAX, f64::min);
    let low = if low == f64::MAX { 0.0 } else { low };
    let summary = format!(
        "{} {} 最近 {} 根 K 线：收盘 {}，区间涨跌 {:.2}%，高 {}，低 {}",
        inst_id,
        bar,
        candles.len(),
        last,
        change,
        high,
        low
    );
    let ai_candles = candles
        .iter()
        .map(|item| {
            let open_time_ms = item.time.saturating_mul(1000);
            let close_time_ms = open_time_ms.saturating_add(interval_ms);
            let observed_at = if item.confirm {
                close_time_ms.min(as_of).min(now)
            } else {
                as_of.min(close_time_ms).min(now)
            };
            json!({
                "time": open_time_ms,
                "openTimeMs": open_time_ms,
                "closeTimeMs": close_time_ms,
                "observedAt": observed_at,
                "open": item.open,
                "high": item.high,
                "low": item.low,
                "close": item.close,
                "volume": item.volume,
                "confirm": item.confirm,
            })
        })
        .collect::<Vec<_>>();
    let data_at = ai_candles
        .last()
        .and_then(|item| item.get("observedAt"))
        .and_then(Value::as_i64);
    let latest_confirmed_at = candles
        .iter()
        .rev()
        .find(|item| item.confirm)
        .map(|item| item.time.saturating_mul(1000).saturating_add(interval_ms));
    let expected_latest_confirmed_at = expected_latest_confirmed_at(as_of, interval_ms, live);
    let tail_stale = expected_latest_confirmed_at > 0
        && latest_confirmed_at
            .map(|value| value < expected_latest_confirmed_at)
            .unwrap_or(true);
    let missing_recent = refresh.map(|value| value.missing_after).unwrap_or_default();
    let stale = tail_stale || missing_recent > 0;
    let stale_reason = if missing_recent > 0 {
        Some(format!("最近 1m K 线仍缺失 {} 根", missing_recent))
    } else if tail_stale {
        Some(format!(
            "最后确认 K 线时间 {} 早于当前应确认时间 {}",
            latest_confirmed_at.unwrap_or_default(),
            expected_latest_confirmed_at
        ))
    } else {
        None
    };
    json!({
        "source": source,
        "timeUnit": "unix_ms",
        "intervalMs": interval_ms,
        "dataAt": data_at,
        "ageMs": data_at.map(|value| now.saturating_sub(value)),
        "asOf": as_of,
        "latestConfirmedAt": latest_confirmed_at,
        "expectedLatestConfirmedAt": expected_latest_confirmed_at,
        "stale": stale,
        "staleReason": stale_reason,
        "refreshStatus": refresh.map(AiCandleRefreshStatus::status).unwrap_or("not-needed"),
        "refreshAttempted": refresh.map(|value| value.attempted).unwrap_or(false),
        "refreshError": refresh.and_then(|value| value.error.as_deref()),
        "missingRecent1mBeforeRefresh": refresh.map(|value| value.missing_before).unwrap_or(0),
        "missingRecent1mAfterRefresh": missing_recent,
        "summary": summary,
        "instId": inst_id,
        "bar": bar,
        "count": candles.len(),
        "firstClose": first,
        "lastClose": last,
        "changePct": change,
        "high": high,
        "low": low,
        "candles": ai_candles
    })
}

async fn ai_read_funding_rate(
    runtime: &MarketRuntime,
    inst_id: &str,
) -> Result<serde_json::Value, String> {
    if let Some(funding) = runtime
        .store
        .lock()
        .ok()
        .and_then(|store| store.funding_rates.get(inst_id).cloned())
    {
        return Ok(ai_funding_rate_value(funding, "memory"));
    }
    let path = format!("/api/v5/public/funding-rate?instId={}", url_encode(inst_id));
    let envelope: OkxEnvelope<FundingRate> = get_json(&path).await?;
    let funding = envelope
        .data
        .into_iter()
        .next()
        .ok_or_else(|| "funding rate data empty".to_string())?;
    Ok(ai_funding_rate_value(funding, "api"))
}

fn ai_funding_rate_value(funding: FundingRate, source: &str) -> serde_json::Value {
    let age_base = if funding.ts > 0 {
        funding.ts
    } else {
        funding.funding_time
    };
    let summary = format!(
        "{} 当前资金费率 {}，下一期 {}，结算时间 {}，下一次 {}，来源 {}",
        funding.inst_id,
        funding.funding_rate,
        funding.next_funding_rate,
        funding.funding_time,
        funding.next_funding_time,
        source
    );
    json!({
        "source": source,
        "ageMs": now_ms().saturating_sub(age_base),
        "summary": summary,
        "fundingRate": funding
    })
}

async fn ai_scan_watchlist(
    app: &tauri::AppHandle,
    runtime: &MarketRuntime,
    request: AiMarketScanRequest,
) -> Result<serde_json::Value, String> {
    let inst_ids = request
        .inst_ids
        .filter(|items| !items.is_empty())
        .unwrap_or_else(|| {
            load_watchlist_config(app.clone())
                .map(|config| config.symbols)
                .unwrap_or_else(|_| vec!["BTC-USDT-SWAP".to_string()])
        });
    let bars = normalize_ai_bars(request.bars, Some("5m"));
    let limit = request.limit.unwrap_or(60).clamp(2, 300);
    let mut rows = Vec::new();
    for inst_id in inst_ids.into_iter().take(50) {
        let ticker = ai_read_ticker(runtime, &inst_id)
            .await
            .unwrap_or_else(|err| json!({ "error": err }));
        let funding = ai_read_funding_rate(runtime, &inst_id).await.ok();
        let orderbook = ai_read_orderbook(runtime, &inst_id, 24).await.ok();
        let mut candle_summaries = serde_json::Map::new();
        for bar in &bars {
            let candles =
                ai_read_candles_for_range(app, runtime, &inst_id, bar, limit, None, None, false)
                    .await
                    .unwrap_or_default();
            candle_summaries.insert(bar.clone(), ai_candle_compact_summary(&candles));
        }
        rows.push(json!({
            "instId": inst_id,
            "ticker": ticker,
            "fundingRate": funding,
            "orderBookPressure": orderbook.as_ref().map(ai_orderbook_pressure_from_value),
            "candles": candle_summaries
        }));
    }
    sort_ai_scan_rows(&mut rows, request.sort_by.as_deref().unwrap_or("volume"));
    let top_n = request.top_n.unwrap_or(rows.len() as u16).clamp(1, 50) as usize;
    rows.truncate(top_n);
    Ok(json!({
        "summary": format!("已扫描 {} 个交易对", rows.len()),
        "items": rows
    }))
}

fn ai_candle_compact_summary(candles: &[Candle]) -> serde_json::Value {
    let first = candles.first().map(|item| item.close).unwrap_or_default();
    let last = candles.last().map(|item| item.close).unwrap_or_default();
    let change_pct = if first > 0.0 {
        (last - first) / first * 100.0
    } else {
        0.0
    };
    let volume = candles.iter().map(|item| item.volume).sum::<f64>();
    json!({ "count": candles.len(), "firstClose": first, "lastClose": last, "changePct": change_pct, "volume": volume })
}

fn ai_orderbook_pressure_from_value(value: &serde_json::Value) -> serde_json::Value {
    let bid_total = value
        .get("bidTotal")
        .and_then(|item| item.as_f64())
        .unwrap_or_default();
    let ask_total = value
        .get("askTotal")
        .and_then(|item| item.as_f64())
        .unwrap_or_default();
    let total = bid_total + ask_total;
    let score = if total > 0.0 {
        (bid_total - ask_total) / total * 100.0
    } else {
        0.0
    };
    json!({ "bidTotal": bid_total, "askTotal": ask_total, "score": score })
}

fn sort_ai_scan_rows(rows: &mut [serde_json::Value], sort_by: &str) {
    rows.sort_by(|a, b| {
        let av = ai_scan_sort_value(a, sort_by);
        let bv = ai_scan_sort_value(b, sort_by);
        bv.partial_cmp(&av).unwrap_or(std::cmp::Ordering::Equal)
    });
}

fn ai_scan_sort_value(row: &serde_json::Value, sort_by: &str) -> f64 {
    match sort_by {
        "change" => row
            .get("candles")
            .and_then(|bars| bars.as_object())
            .and_then(|bars| bars.values().next())
            .and_then(|item| item.get("changePct"))
            .and_then(|item| item.as_f64())
            .unwrap_or_default()
            .abs(),
        "fundingRate" => row
            .pointer("/fundingRate/fundingRate/fundingRate")
            .and_then(|item| item.as_str())
            .and_then(|item| item.parse::<f64>().ok())
            .unwrap_or_default()
            .abs(),
        "orderBookPressure" => row
            .pointer("/orderBookPressure/score")
            .and_then(|item| item.as_f64())
            .unwrap_or_default()
            .abs(),
        _ => row
            .pointer("/ticker/ticker/volCcy24h")
            .and_then(|item| item.as_str())
            .and_then(|item| item.parse::<f64>().ok())
            .unwrap_or_default(),
    }
}

async fn ai_read_indicators(
    app: &tauri::AppHandle,
    runtime: &MarketRuntime,
    request: AiIndicatorRequest,
) -> Result<serde_json::Value, String> {
    let limit = request.limit.unwrap_or(240).clamp(30, 1000);
    let bars = vec![request.bar.clone()];
    let mut loaded = load_ai_candle_windows(
        app,
        runtime,
        &request.inst_id,
        &bars,
        limit,
        request.start_time,
        request.end_time,
        true,
    )
    .await?;
    let candles = loaded
        .windows
        .pop()
        .map(|(_, candles)| candles)
        .unwrap_or_default();
    let indicator_started = Instant::now();
    let closes = candles.iter().map(|item| item.close).collect::<Vec<_>>();
    let highs = candles.iter().map(|item| item.high).collect::<Vec<_>>();
    let lows = candles.iter().map(|item| item.low).collect::<Vec<_>>();
    let volumes = candles.iter().map(|item| item.volume).collect::<Vec<_>>();
    let mut indicators = serde_json::Map::new();
    for indicator in request.indicators {
        let key = indicator.to_ascii_lowercase();
        let value = if let Some(period) = ai_indicator_period(&key, "sma", 20) {
            json!(ai_sma(&closes, period))
        } else if let Some(period) = ai_indicator_period(&key, "ema", 21) {
            json!(ai_ema(&closes, period))
        } else if let Some(period) = ai_indicator_period(&key, "rsi", 14) {
            json!(ai_rsi(&closes, period))
        } else if let Some(period) = ai_indicator_period(&key, "atr", 14) {
            json!(ai_atr(&highs, &lows, &closes, period))
        } else if let Some(period) =
            ai_indicator_period(&key, "boll", 20).or_else(|| ai_indicator_period(&key, "bb", 20))
        {
            json!(ai_boll(&closes, period, 2.0))
        } else {
            match key.as_str() {
                "macd" => json!(ai_macd(&closes)),
                "vwap" => json!(ai_vwap(&candles)),
                "volumeprofile" | "volumeprofile/light" => {
                    json!(ai_volume_profile_light(&closes, &volumes))
                }
                _ => json!({
                    "error": format!(
                        "unsupported indicator {}; supported: sma[N], ema[N], rsi[N], macd, boll[N]/bb[N], atr[N], vwap, volumeProfile, volumeProfile/light; N must be 1..500",
                        indicator
                    )
                }),
            }
        };
        indicators.insert(indicator, value);
    }
    let indicator_compute_ms = indicator_started.elapsed().as_millis();
    let mut result = json!({
        "summary": format!("{} {} 已计算 {} 项指标", request.inst_id, request.bar, indicators.len()),
        "instId": request.inst_id,
        "bar": request.bar,
        "count": candles.len(),
        "indicators": indicators
    });
    merge_ai_tool_timing(
        &mut result,
        &[
            ("databaseReadMs", loaded.database_read_ms),
            ("aggregateMs", loaded.aggregate_ms),
            ("indicatorComputeMs", indicator_compute_ms),
            ("databaseRows", loaded.database_rows as u128),
            ("memoryRows", loaded.memory_rows as u128),
            ("mergedRows", loaded.merged_rows as u128),
        ],
    );
    Ok(result)
}

fn ai_indicator_period(key: &str, prefix: &str, default_period: usize) -> Option<usize> {
    if key == prefix {
        return Some(default_period);
    }
    key.strip_prefix(prefix)?
        .parse::<usize>()
        .ok()
        .filter(|period| (1..=500).contains(period))
}

fn ai_sma(values: &[f64], period: usize) -> Vec<Option<f64>> {
    let mut out = vec![None; values.len()];
    if period == 0 {
        return out;
    }
    let mut sum = 0.0;
    for index in 0..values.len() {
        sum += values[index];
        if index >= period {
            sum -= values[index - period];
        }
        if index + 1 >= period {
            out[index] = Some(sum / period as f64);
        }
    }
    out
}

fn ai_ema(values: &[f64], period: usize) -> Vec<Option<f64>> {
    let mut out = vec![None; values.len()];
    if values.is_empty() || period == 0 {
        return out;
    }
    let multiplier = 2.0 / (period as f64 + 1.0);
    let mut ema = values[0];
    for (index, value) in values.iter().enumerate() {
        ema = if index == 0 {
            *value
        } else {
            (*value - ema) * multiplier + ema
        };
        if index + 1 >= period {
            out[index] = Some(ema);
        }
    }
    out
}

fn ai_rsi(values: &[f64], period: usize) -> Vec<Option<f64>> {
    let mut out = vec![None; values.len()];
    if values.len() <= period || period == 0 {
        return out;
    }
    let mut gains = 0.0;
    let mut losses = 0.0;
    for index in 1..=period {
        let diff = values[index] - values[index - 1];
        if diff >= 0.0 {
            gains += diff;
        } else {
            losses -= diff;
        }
    }
    let mut avg_gain = gains / period as f64;
    let mut avg_loss = losses / period as f64;
    out[period] = Some(if avg_loss == 0.0 {
        100.0
    } else {
        100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
    });
    for index in period + 1..values.len() {
        let diff = values[index] - values[index - 1];
        let gain = diff.max(0.0);
        let loss = (-diff).max(0.0);
        avg_gain = (avg_gain * (period as f64 - 1.0) + gain) / period as f64;
        avg_loss = (avg_loss * (period as f64 - 1.0) + loss) / period as f64;
        out[index] = Some(if avg_loss == 0.0 {
            100.0
        } else {
            100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
        });
    }
    out
}

fn ai_macd(values: &[f64]) -> serde_json::Value {
    let ema12 = ai_ema(values, 12);
    let ema26 = ai_ema(values, 26);
    let macd_line = ema12
        .iter()
        .zip(ema26.iter())
        .map(|(fast, slow)| fast.zip(*slow).map(|(fast, slow)| fast - slow))
        .collect::<Vec<_>>();
    let macd_values = macd_line
        .iter()
        .map(|item| item.unwrap_or_default())
        .collect::<Vec<_>>();
    let signal = ai_ema(&macd_values, 9);
    let histogram = macd_line
        .iter()
        .zip(signal.iter())
        .map(|(macd, signal)| macd.zip(*signal).map(|(macd, signal)| macd - signal))
        .collect::<Vec<_>>();
    json!({ "macd": macd_line, "signal": signal, "histogram": histogram })
}

fn ai_boll(values: &[f64], period: usize, multiplier: f64) -> serde_json::Value {
    let mid = ai_sma(values, period);
    let mut upper = vec![None; values.len()];
    let mut lower = vec![None; values.len()];
    for index in 0..values.len() {
        if index + 1 < period {
            continue;
        }
        let slice = &values[index + 1 - period..=index];
        let mean = mid[index].unwrap_or_default();
        let variance = slice
            .iter()
            .map(|value| (value - mean).powi(2))
            .sum::<f64>()
            / period as f64;
        let dev = variance.sqrt() * multiplier;
        upper[index] = Some(mean + dev);
        lower[index] = Some(mean - dev);
    }
    json!({ "middle": mid, "upper": upper, "lower": lower })
}

fn ai_atr(highs: &[f64], lows: &[f64], closes: &[f64], period: usize) -> Vec<Option<f64>> {
    let mut tr = Vec::with_capacity(highs.len());
    for index in 0..highs.len() {
        let prev_close = if index == 0 {
            closes[index]
        } else {
            closes[index - 1]
        };
        tr.push(
            (highs[index] - lows[index])
                .max((highs[index] - prev_close).abs())
                .max((lows[index] - prev_close).abs()),
        );
    }
    ai_sma(&tr, period)
}

fn ai_vwap(candles: &[Candle]) -> Vec<Option<f64>> {
    let mut out = Vec::with_capacity(candles.len());
    let mut volume_sum = 0.0;
    let mut weighted_sum = 0.0;
    for candle in candles {
        let typical = (candle.high + candle.low + candle.close) / 3.0;
        volume_sum += candle.volume;
        weighted_sum += typical * candle.volume;
        out.push(if volume_sum > 0.0 {
            Some(weighted_sum / volume_sum)
        } else {
            None
        });
    }
    out
}

fn ai_volume_profile_light(closes: &[f64], volumes: &[f64]) -> serde_json::Value {
    if closes.is_empty() {
        return json!([]);
    }
    let min = closes.iter().copied().fold(f64::MAX, f64::min);
    let max = closes.iter().copied().fold(f64::MIN, f64::max);
    let buckets = 12usize;
    let step = ((max - min) / buckets as f64).max(f64::EPSILON);
    let mut totals = vec![0.0; buckets];
    for (close, volume) in closes.iter().zip(volumes.iter()) {
        let index = (((*close - min) / step).floor() as usize).min(buckets - 1);
        totals[index] += *volume;
    }
    json!(totals
        .into_iter()
        .enumerate()
        .map(|(index, volume)| json!({ "from": min + step * index as f64, "to": min + step * (index + 1) as f64, "volume": volume }))
        .collect::<Vec<_>>())
}

async fn ai_read_account_part(
    app: tauri::AppHandle,
    tool_name: &str,
    request: PrivateSnapshotRequest,
) -> Result<serde_json::Value, String> {
    let snapshot = if let Some(snapshot) = ai_read_memory_account_snapshot(
        app.state::<MarketRuntime>().inner(),
        request.account_id.as_deref(),
    ) {
        snapshot
    } else {
        okx_private_snapshot(app, request).await?
    };
    let (usdt_equity, available_usdt, excluded_non_usdt_asset_count) =
        ai_usdt_balance_context(&snapshot);
    let value = match tool_name {
        "account.readBalances" => {
            json!({
                "accountId": snapshot.account_id,
                "environment": snapshot.environment,
                "syncedAt": snapshot.synced_at,
                "balances": snapshot.balances,
                "usdtEquity": usdt_equity,
                "availableUsdt": available_usdt,
                "balanceSemantics": {
                    "riskCurrency": "USDT",
                    "excludedNonUsdtAssetCount": excluded_non_usdt_asset_count,
                    "nonUsdtBalancesExcludedFromPerpetualRisk": true
                }
            })
        }
        "account.readPositions" => {
            json!({ "accountId": snapshot.account_id, "environment": snapshot.environment, "syncedAt": snapshot.synced_at, "positions": snapshot.positions })
        }
        "account.readOpenOrders" => {
            json!({ "accountId": snapshot.account_id, "environment": snapshot.environment, "syncedAt": snapshot.synced_at, "orders": snapshot.orders })
        }
        "account.readRisk" => ai_account_risk_value(snapshot),
        _ => json!(snapshot),
    };
    Ok(value)
}

fn ai_account_snapshot_tool_value(
    snapshot: PrivateAccountSnapshot,
    source: &str,
    age_ms: i64,
) -> serde_json::Value {
    let (usdt_equity, available_usdt, excluded_non_usdt_asset_count) =
        ai_usdt_balance_context(&snapshot);
    json!({
        "source": source,
        "ageMs": age_ms,
        "balanceSemantics": {
            "riskCurrency": "USDT",
            "usdtEquity": usdt_equity,
            "availableUsdt": available_usdt,
            "excludedNonUsdtAssetCount": excluded_non_usdt_asset_count,
            "nonUsdtBalancesExcludedFromPerpetualRisk": true
        },
        "snapshot": snapshot
    })
}

async fn ai_read_order_status(
    app: tauri::AppHandle,
    request: OrderStatusRequest,
) -> Result<serde_json::Value, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    if let Some(environment) = request.environment.as_deref() {
        if normalize_environment(&account.environment) != normalize_environment(environment) {
            return Err("账号环境与查询环境不一致".to_string());
        }
    }
    if !account.permissions.read {
        return Err("account read permission is disabled".to_string());
    }
    let inst_id = request.inst_id.trim();
    if inst_id.is_empty() {
        return Err("查询订单状态需要 instId".to_string());
    }
    let ord_id =
        optional_non_empty(&request.ord_id).or_else(|| optional_non_empty(&request.algo_id));
    let cl_ord_id = optional_non_empty(&request.cl_ord_id)
        .or_else(|| optional_non_empty(&request.algo_cl_ord_id));
    if ord_id.is_none() && cl_ord_id.is_none() {
        return Err("查询订单状态需要 ordId/clOrdId 或 algoId/algoClOrdId".to_string());
    }
    let is_algo_hint = optional_non_empty(&request.algo_id).is_some()
        || optional_non_empty(&request.algo_cl_ord_id).is_some();

    if let Some(snapshot) =
        ai_read_memory_account_snapshot(app.state::<MarketRuntime>().inner(), Some(&account.id))
    {
        if let Some(order) = snapshot.orders.iter().find(|item| {
            order_matches(
                item,
                inst_id,
                ord_id.as_deref(),
                cl_ord_id.as_deref(),
                is_algo_hint,
            )
        }) {
            let response = order_status_from_pending(&account, order.clone(), "memory_open_orders");
            return serde_json::to_value(response).map_err(|err| err.to_string());
        }
    }

    let conn = open_database(&app)?;
    if let Some(response) = load_order_status_from_local(
        &conn,
        &account,
        inst_id,
        ord_id.as_deref(),
        cl_ord_id.as_deref(),
        is_algo_hint,
    )? {
        return serde_json::to_value(response).map_err(|err| err.to_string());
    }

    if let Some(response) = fetch_order_status_from_okx(
        &app,
        &account,
        inst_id,
        ord_id.as_deref(),
        cl_ord_id.as_deref(),
        is_algo_hint,
    )
    .await?
    {
        return serde_json::to_value(response).map_err(|err| err.to_string());
    }

    Ok(json!({
        "accountId": account.id,
        "environment": account.environment,
        "instId": inst_id,
        "ordId": ord_id,
        "clOrdId": cl_ord_id,
        "isAlgo": is_algo_hint,
        "state": "unknown",
        "source": "not_found",
        "updatedAt": now_ms()
    }))
}

fn order_matches(
    order: &OkxPendingOrder,
    inst_id: &str,
    ord_id: Option<&str>,
    cl_ord_id: Option<&str>,
    is_algo_hint: bool,
) -> bool {
    if order.inst_id != inst_id {
        return false;
    }
    if is_algo_hint && !order.is_algo {
        return false;
    }
    ord_id
        .map(|value| order.ord_id == value || order.algo_id == value)
        .unwrap_or(false)
        || cl_ord_id
            .map(|value| order.cl_ord_id == value || order.algo_cl_ord_id == value)
            .unwrap_or(false)
}

fn order_status_from_pending(
    account: &LocalAccount,
    order: OkxPendingOrder,
    source: &str,
) -> OrderStatusResponse {
    OrderStatusResponse {
        account_id: account.id.clone(),
        environment: account.environment.clone(),
        inst_id: order.inst_id,
        ord_id: optional_string(order.ord_id),
        cl_ord_id: optional_string(order.cl_ord_id),
        algo_id: optional_string(order.algo_id),
        algo_cl_ord_id: optional_string(order.algo_cl_ord_id),
        is_algo: order.is_algo,
        state: if order.state.trim().is_empty() {
            "live".to_string()
        } else {
            order.state
        },
        side: optional_string(order.side),
        pos_side: optional_string(order.pos_side),
        td_mode: optional_string(order.td_mode),
        ord_type: optional_string(order.ord_type),
        px: optional_string(order.px),
        sz: optional_string(order.sz),
        filled_size: optional_string(order.acc_fill_sz),
        avg_price: optional_string(order.avg_px),
        pnl: None,
        fee: None,
        fill_count: 0,
        fills: Vec::new(),
        source: source.to_string(),
        updated_at: parse_i64(&order.u_time)
            .or_else(|| parse_i64(&order.c_time))
            .unwrap_or_else(now_ms),
        raw: None,
    }
}

fn load_order_status_from_local(
    conn: &Connection,
    account: &LocalAccount,
    inst_id: &str,
    ord_id: Option<&str>,
    cl_ord_id: Option<&str>,
    is_algo_hint: bool,
) -> Result<Option<OrderStatusResponse>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT account_id, environment, ord_id, cl_ord_id, inst_id, inst_type, side, pos_side, td_mode,
              ord_type, state, px, sz, acc_fill_sz, avg_px, pnl, fee, source_endpoint, operator, strategy_id,
              session_id, opportunity_id, agent_run_id, execution_key, okx_ctime, okx_utime, synced_at
             FROM okx_orders
             WHERE account_id=?1 AND environment=?2 AND inst_id=?3
               AND ((?4 <> '' AND ord_id=?4) OR (?5 <> '' AND cl_ord_id=?5))
             ORDER BY COALESCE(okx_utime, okx_ctime, synced_at) DESC
             LIMIT 1",
        )
        .map_err(|err| err.to_string())?;
    let ord_param = ord_id.unwrap_or("");
    let cl_ord_param = cl_ord_id.unwrap_or("");
    let order = stmt
        .query_row(
            params![
                account.id,
                account.environment,
                inst_id,
                ord_param,
                cl_ord_param
            ],
            |row| {
                Ok(HistoricalOrderSummary {
                    account_id: row.get(0)?,
                    environment: row.get(1)?,
                    ord_id: row.get(2)?,
                    cl_ord_id: row.get(3)?,
                    inst_id: row.get(4)?,
                    inst_type: row.get(5)?,
                    side: row.get(6)?,
                    pos_side: row.get(7)?,
                    td_mode: row.get(8)?,
                    ord_type: row.get(9)?,
                    state: row.get(10)?,
                    px: row.get(11)?,
                    sz: row.get(12)?,
                    acc_fill_sz: row.get(13)?,
                    avg_px: row.get(14)?,
                    pnl: row.get(15)?,
                    fee: row.get(16)?,
                    source_endpoint: row.get(17)?,
                    operator: row.get(18)?,
                    strategy_id: row.get(19)?,
                    session_id: row.get(20)?,
                    opportunity_id: row.get(21)?,
                    agent_run_id: row.get(22)?,
                    execution_key: row.get(23)?,
                    okx_ctime: row.get(24)?,
                    okx_utime: row.get(25)?,
                    synced_at: row.get(26)?,
                })
            },
        )
        .optional()
        .map_err(|err| err.to_string())?;

    let lookup_ord_id = order.as_ref().map(|item| item.ord_id.as_str()).or(ord_id);
    let fills = load_fills_for_order(conn, account, inst_id, lookup_ord_id, cl_ord_id, 50)?;
    if let Some(order) = order {
        let fill_count = fills.len();
        let raw = json!({ "order": &order });
        return Ok(Some(OrderStatusResponse {
            account_id: account.id.clone(),
            environment: account.environment.clone(),
            inst_id: order.inst_id,
            ord_id: Some(order.ord_id),
            cl_ord_id: order.cl_ord_id,
            algo_id: if is_algo_hint {
                ord_id.map(ToOwned::to_owned)
            } else {
                None
            },
            algo_cl_ord_id: if is_algo_hint {
                cl_ord_id.map(ToOwned::to_owned)
            } else {
                None
            },
            is_algo: is_algo_hint
                || order
                    .ord_type
                    .as_deref()
                    .map(|value| matches!(value, "trigger" | "conditional" | "oco"))
                    .unwrap_or(false),
            state: normalize_order_state(
                order.state.as_deref(),
                order.acc_fill_sz.as_deref(),
                order.sz.as_deref(),
            ),
            side: order.side,
            pos_side: order.pos_side,
            td_mode: order.td_mode,
            ord_type: order.ord_type,
            px: order.px,
            sz: order.sz,
            filled_size: order.acc_fill_sz,
            avg_price: order.avg_px,
            pnl: order.pnl,
            fee: order.fee,
            fill_count,
            fills,
            source: "local_orders".to_string(),
            updated_at: order
                .okx_utime
                .or(order.okx_ctime)
                .unwrap_or(order.synced_at),
            raw: Some(raw),
        }));
    }

    if !fills.is_empty() {
        let filled_size =
            sum_string_numbers(fills.iter().filter_map(|item| item.fill_sz.as_deref()));
        let fee = sum_string_numbers(fills.iter().filter_map(|item| item.fee.as_deref()));
        let pnl = sum_string_numbers(fills.iter().filter_map(|item| item.fill_pnl.as_deref()));
        let latest = fills.first().cloned();
        let fill_count = fills.len();
        return Ok(Some(OrderStatusResponse {
            account_id: account.id.clone(),
            environment: account.environment.clone(),
            inst_id: inst_id.to_string(),
            ord_id: lookup_ord_id.map(ToOwned::to_owned),
            cl_ord_id: cl_ord_id.map(ToOwned::to_owned),
            algo_id: if is_algo_hint {
                lookup_ord_id.map(ToOwned::to_owned)
            } else {
                None
            },
            algo_cl_ord_id: if is_algo_hint {
                cl_ord_id.map(ToOwned::to_owned)
            } else {
                None
            },
            is_algo: is_algo_hint,
            state: "filled".to_string(),
            side: latest.as_ref().and_then(|item| item.side.clone()),
            pos_side: latest.as_ref().and_then(|item| item.pos_side.clone()),
            td_mode: None,
            ord_type: None,
            px: None,
            sz: None,
            filled_size,
            avg_price: latest.as_ref().and_then(|item| item.fill_px.clone()),
            pnl,
            fee,
            fill_count,
            fills,
            source: "local_fills".to_string(),
            updated_at: latest.and_then(|item| item.okx_ts).unwrap_or_else(now_ms),
            raw: None,
        }));
    }
    Ok(None)
}

fn load_fills_for_order(
    conn: &Connection,
    account: &LocalAccount,
    inst_id: &str,
    ord_id: Option<&str>,
    _cl_ord_id: Option<&str>,
    limit: u16,
) -> Result<Vec<HistoricalFillSummary>, String> {
    let Some(ord_id) = ord_id.filter(|value| !value.trim().is_empty()) else {
        return Ok(Vec::new());
    };
    let mut stmt = conn
        .prepare(
            "SELECT account_id, environment, bill_id, ord_id, trade_id, inst_id, inst_type, side, pos_side,
              sub_type, fill_px, fill_sz, fill_pnl, fee, fee_ccy, source_endpoint, operator, strategy_id,
              session_id, opportunity_id, agent_run_id, execution_key, okx_ts, synced_at
             FROM okx_fills
             WHERE account_id=?1 AND environment=?2 AND inst_id=?3 AND ord_id=?4
             ORDER BY COALESCE(okx_ts, synced_at) DESC
             LIMIT ?5",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(
            params![
                account.id,
                account.environment,
                inst_id,
                ord_id,
                i64::from(limit)
            ],
            |row| {
                Ok(HistoricalFillSummary {
                    account_id: row.get(0)?,
                    environment: row.get(1)?,
                    bill_id: row.get(2)?,
                    ord_id: row.get(3)?,
                    trade_id: row.get(4)?,
                    inst_id: row.get(5)?,
                    inst_type: row.get(6)?,
                    side: row.get(7)?,
                    pos_side: row.get(8)?,
                    sub_type: row.get(9)?,
                    fill_px: row.get(10)?,
                    fill_sz: row.get(11)?,
                    fill_pnl: row.get(12)?,
                    fee: row.get(13)?,
                    fee_ccy: row.get(14)?,
                    source_endpoint: row.get(15)?,
                    operator: row.get(16)?,
                    strategy_id: row.get(17)?,
                    session_id: row.get(18)?,
                    opportunity_id: row.get(19)?,
                    agent_run_id: row.get(20)?,
                    execution_key: row.get(21)?,
                    okx_ts: row.get(22)?,
                    synced_at: row.get(23)?,
                })
            },
        )
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    Ok(rows)
}

async fn fetch_order_status_from_okx(
    _app: &tauri::AppHandle,
    account: &LocalAccount,
    inst_id: &str,
    ord_id: Option<&str>,
    cl_ord_id: Option<&str>,
    is_algo_hint: bool,
) -> Result<Option<OrderStatusResponse>, String> {
    let mut query = format!("/api/v5/trade/order?instId={}", inst_id);
    if let Some(value) = ord_id {
        query.push_str("&ordId=");
        query.push_str(value);
    }
    if let Some(value) = cl_ord_id {
        query.push_str("&clOrdId=");
        query.push_str(value);
    }
    if !is_algo_hint {
        if let Ok(envelope) = okx_private_get::<OkxPendingOrder>(account, &query).await {
            if let Some(order) = envelope.data.into_iter().next() {
                return Ok(Some(order_status_from_pending(
                    account,
                    order,
                    "okx_rest_order",
                )));
            }
        }
    }

    let mut algo_query = format!("/api/v5/trade/order-algo?instId={}", inst_id);
    if let Some(value) = ord_id {
        algo_query.push_str("&algoId=");
        algo_query.push_str(value);
    }
    if let Some(value) = cl_ord_id {
        algo_query.push_str("&algoClOrdId=");
        algo_query.push_str(value);
    }
    let envelope = okx_private_get::<OkxAlgoPendingOrder>(account, &algo_query).await;
    if let Ok(envelope) = envelope {
        if let Some(order) = envelope.data.into_iter().next() {
            let pending = pending_order_from_algo(order);
            return Ok(Some(order_status_from_pending(
                account,
                pending,
                "okx_rest_algo_order",
            )));
        }
    }
    Ok(None)
}

fn normalize_order_state(
    state: Option<&str>,
    filled_size: Option<&str>,
    size: Option<&str>,
) -> String {
    let value = state.unwrap_or("").trim();
    if !value.is_empty() {
        return value.to_string();
    }
    let filled = filled_size
        .and_then(|item| item.parse::<f64>().ok())
        .unwrap_or_default()
        .abs();
    let total = size
        .and_then(|item| item.parse::<f64>().ok())
        .unwrap_or_default()
        .abs();
    if total > 0.0 && filled >= total {
        "filled".to_string()
    } else if filled > 0.0 {
        "partially_filled".to_string()
    } else {
        "unknown".to_string()
    }
}

fn sum_string_numbers<'a>(values: impl Iterator<Item = &'a str>) -> Option<String> {
    let mut count = 0usize;
    let sum = values
        .filter_map(|value| value.parse::<f64>().ok())
        .inspect(|_| count += 1)
        .sum::<f64>();
    if count == 0 {
        None
    } else {
        Some(format_float(sum))
    }
}

fn optional_string(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn parse_i64(value: &str) -> Option<i64> {
    value.trim().parse::<i64>().ok()
}

fn format_float(value: f64) -> String {
    if !value.is_finite() {
        return "0".to_string();
    }
    let mut text = format!("{:.8}", value);
    while text.contains('.') && text.ends_with('0') {
        text.pop();
    }
    if text.ends_with('.') {
        text.pop();
    }
    text
}

fn json_value_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "布尔值",
        Value::Number(_) => "数字",
        Value::String(_) => "字符串",
        Value::Array(_) => "数组",
        Value::Object(_) => "对象",
    }
}

fn validate_optional_json_string(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<(), String> {
    let Some(value) = object.get(field) else {
        return Ok(());
    };
    if value.is_null() || value.is_string() {
        return Ok(());
    }
    Err(format!(
        "tradeOpportunity.create 参数 {field} 必须是字符串，实际为{}",
        json_value_type(value)
    ))
}

fn validate_trade_opportunity_input_shape(input: &Value) -> Result<(), String> {
    let object = input
        .as_object()
        .ok_or_else(|| "tradeOpportunity.create 参数必须是对象".to_string())?;
    for field in [
        "accountId",
        "environment",
        "instId",
        "tdMode",
        "intent",
        "direction",
        "size",
        "orderType",
        "price",
        "orderId",
        "clientOrderId",
        "algoId",
        "algoClientOrderId",
        "newPrice",
        "newSize",
        "lever",
        "entryCondition",
        "invalidationPrice",
        "timeHorizon",
        "strategyName",
        "reason",
        "sourceSessionId",
        "originType",
        "strategyKind",
        "strategyId",
        "strategyVersionId",
        "strategyRunId",
        "signalId",
        "factorPoolVersionId",
        "agentProfileId",
        "agentRunId",
        "relatedOpportunityId",
        "duplicateResolution",
        "duplicateResolutionReason",
        "decisionContextId",
    ] {
        validate_optional_json_string(object, field)?;
    }
    for field in ["evidence", "riskNotes"] {
        let Some(value) = object.get(field) else {
            continue;
        };
        if value.is_null() {
            continue;
        }
        let items = value.as_array().ok_or_else(|| {
            format!(
                "tradeOpportunity.create 参数 {field} 必须是字符串数组，实际为{}",
                json_value_type(value)
            )
        })?;
        for (index, item) in items.iter().enumerate() {
            if !item.is_string() {
                return Err(format!(
                    "tradeOpportunity.create 参数 {field}[{index}] 必须是字符串，实际为{}；evidence 和 riskNotes 必须分别作为顶层字符串数组提交",
                    json_value_type(item)
                ));
            }
        }
    }
    for field in ["takeProfit", "stopLoss"] {
        let Some(value) = object.get(field) else {
            continue;
        };
        if value.is_null() {
            continue;
        }
        let protective = value.as_object().ok_or_else(|| {
            format!(
                "tradeOpportunity.create 参数 {field} 必须是对象，实际为{}",
                json_value_type(value)
            )
        })?;
        for nested in [
            "kind",
            "triggerPx",
            "orderPx",
            "triggerPxType",
            "closeFraction",
        ] {
            validate_optional_json_string(protective, nested).map_err(|error| {
                error.replacen(
                    &format!("参数 {nested}"),
                    &format!("参数 {field}.{nested}"),
                    1,
                )
            })?;
        }
    }
    Ok(())
}

fn ai_account_risk_value(snapshot: PrivateAccountSnapshot) -> serde_json::Value {
    let (usdt_equity, available_usdt, excluded_non_usdt_asset_count) =
        ai_usdt_balance_context(&snapshot);
    let position_count = snapshot
        .positions
        .iter()
        .filter(|item| item.pos.parse::<f64>().unwrap_or_default().abs() > 0.0)
        .count();
    let notional_usd = snapshot
        .positions
        .iter()
        .filter_map(|item| item.notional_usd.parse::<f64>().ok())
        .map(f64::abs)
        .sum::<f64>();
    let upl = snapshot
        .positions
        .iter()
        .filter_map(|item| item.upl.parse::<f64>().ok())
        .sum::<f64>();
    json!({
        "accountId": snapshot.account_id,
        "environment": snapshot.environment,
        "syncedAt": snapshot.synced_at,
        "totalEq": usdt_equity,
        "usdtEquity": usdt_equity,
        "availableUsdt": available_usdt,
        "equityCurrency": "USDT",
        "excludedNonUsdtAssetCount": excluded_non_usdt_asset_count,
        "nonUsdtBalancesExcludedFromRisk": true,
        "positionCount": position_count,
        "openOrderCount": snapshot.orders.len(),
        "notionalUsd": notional_usd,
        "unrealizedPnl": upl,
        "positions": snapshot.positions
    })
}

async fn evaluate_ai_trade_plan(
    app: &tauri::AppHandle,
    request: TradePlanEvaluationRequest,
) -> Result<Value, String> {
    evaluate_ai_trade_plan_with_account(app, request, None).await
}

async fn evaluate_ai_trade_plan_with_account(
    app: &tauri::AppHandle,
    request: TradePlanEvaluationRequest,
    account_context: Option<TradePlanAccountContext>,
) -> Result<Value, String> {
    let instrument = fetch_instrument(app, &request.inst_id).await?;
    if !instrument.ct_type.eq_ignore_ascii_case("linear")
        || !instrument.settle_ccy.eq_ignore_ascii_case("USDT")
    {
        return Err("trade.evaluatePlan 当前只支持 USDT 线性永续合约".to_string());
    }
    let runtime = app.state::<MarketRuntime>();
    let explicit_price = request
        .price
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let (entry_price, price_source, price_observed_at) = if let Some(price) = explicit_price {
        (price.to_string(), "request", None)
    } else {
        let ticker = ai_read_ticker(runtime.inner(), &request.inst_id).await?;
        let ticker_value = ticker
            .get("ticker")
            .and_then(Value::as_object)
            .ok_or_else(|| "当前内存 ticker 不完整，无法评估交易计划".to_string())?;
        let price = ticker_value
            .get("last")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "当前内存 ticker 缺少最新价".to_string())?;
        let observed_at = ticker_value
            .get("ts")
            .and_then(Value::as_i64)
            .or_else(|| ticker_value.get("ts").and_then(Value::as_str)?.parse().ok());
        (price.to_string(), "memory-ticker", observed_at)
    };
    let (equity, available, snapshot_source) = if let Some(context) = account_context {
        (context.equity, context.available_usdt, context.source)
    } else {
        let snapshot =
            ai_read_memory_account_snapshot(runtime.inner(), request.account_id.as_deref());
        snapshot
            .as_ref()
            .map(|snapshot| {
                let (equity, available, _) = ai_usdt_balance_context(snapshot);
                (
                    (equity > 0.0).then(|| trim_float(equity)),
                    available.map(trim_float),
                    "private-ws-memory".to_string(),
                )
            })
            .unwrap_or((None, None, "unavailable".to_string()))
    };
    let order_type = request.order_type.as_deref().unwrap_or("limit");
    let entry_fee_rate = if order_type == "market" {
        "0.0005"
    } else {
        "0.0002"
    };
    let size = request
        .size
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&instrument.min_sz)
        .to_string();
    let leverage = if request.lever.trim().is_empty() {
        "1".to_string()
    } else {
        request.lever.clone()
    };
    let evaluation = desic_trade_domain::evaluate_linear_usdt_perpetual(
        &desic_trade_domain::LinearUsdtPerpetualEvaluationRequest {
            size,
            entry_price: entry_price.clone(),
            contract_value: instrument.ct_val.clone(),
            leverage: leverage.clone(),
            min_size: instrument.min_sz.clone(),
            lot_size: instrument.lot_sz.clone(),
            equity,
            available_usdt: available,
            max_single_trade_margin_pct: request
                .max_single_trade_margin_pct
                .filter(|value| value.is_finite() && *value > 0.0)
                .map(|value| trim_float(value.clamp(1.0, 100.0))),
            stop_price: request.stop_price.filter(|value| !value.trim().is_empty()),
            atr: request.atr.filter(|value| !value.trim().is_empty()),
            entry_fee_rate: entry_fee_rate.to_string(),
            exit_fee_rate: "0.0005".to_string(),
        },
    )
    .map_err(|error| error.to_string())?;
    Ok(json!({
        "evaluationId": format!(
            "plan-eval-{}-{}",
            now_ms(),
            TRADE_PLAN_EVALUATION_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ),
        "instId": request.inst_id,
        "price": entry_price,
        "priceSource": price_source,
        "priceObservedAt": price_observed_at,
        "accountSnapshotSource": snapshot_source,
        "leverage": leverage,
        "evaluation": evaluation,
        "semantics": {
            "size": "OKX 合约张数",
            "baseQuantity": "size × ctVal，持仓对应的基础币数量",
            "notionalUsdt": "size × ctVal × entryPrice，表示总名义敞口，不是保证金占用",
            "effectiveExposureMultiple": "名义敞口 ÷ USDT 权益；例如 0.4758X 表示标的反向波动 1% 时，忽略费用、资金费和滑点，权益约损失 0.4758%",
            "notionalPctOfEquity": "effectiveExposureMultiple × 100%，只描述名义敞口相对权益的百分比",
            "estimatedInitialMarginUsdt": "名义敞口 ÷ 杠杆，表示预估初始保证金",
            "marginPctOfEquity": "预估初始保证金 ÷ USDT 权益",
            "stopRiskPctOfEquity": "含双边手续费止损 ÷ USDT 权益",
            "oneAtrRiskPctOfEquity": "size × ctVal × ATR ÷ USDT 权益；ATR 是价格距离，不是账户亏损",
            "leverage": "固定张数下，杠杆只改变预估保证金，不改变价格盈亏"
        },
        "executionAuthority": {
            "hardBlocker": false,
            "requiresTradePrecheck": true,
            "meaning": "这是本地确定性计算，不读取 OKX 当前最大可开仓、仓位档位或实际杠杆；只有 trade.precheck 可以形成执行 blocker。"
        },
        "source": "desic-trade-domain+memory"
    }))
}

async fn add_profile_position_sizing_limit(
    app: &tauri::AppHandle,
    value: &mut serde_json::Value,
    run: &BackgroundRunContext,
) {
    let equity = value.get("usdtEquity").and_then(Value::as_f64);
    let available = value.get("availableUsdt").and_then(Value::as_f64);
    let percent = f64::from(run.max_single_trade_margin_pct.clamp(1, 100));
    let max_margin = equity
        .zip(available)
        .map(|(equity, available)| (equity.max(0.0) * percent / 100.0).min(available.max(0.0)));
    let max_notional = max_margin.map(|margin| margin * f64::from(run.target_leverage));
    let account_context = TradePlanAccountContext {
        equity: equity.filter(|value| *value > 0.0).map(trim_float),
        available_usdt: available.map(|value| trim_float(value.max(0.0))),
        source: "account.readRisk".to_string(),
    };
    let mut instrument_evaluations = Vec::new();
    for inst_id in run.symbols.iter().take(16) {
        let request = TradePlanEvaluationRequest {
            account_id: run.account_id.clone(),
            inst_id: inst_id.clone(),
            price: None,
            stop_price: None,
            atr: None,
            size: None,
            lever: run.target_leverage.to_string(),
            order_type: Some("limit".to_string()),
            max_single_trade_margin_pct: Some(f64::from(run.max_single_trade_margin_pct)),
        };
        match evaluate_ai_trade_plan_with_account(app, request, Some(account_context.clone())).await
        {
            Ok(mut evaluation) => {
                if let Some(object) = evaluation.as_object_mut() {
                    object.remove("semantics");
                    object.remove("executionAuthority");
                }
                instrument_evaluations.push(evaluation);
            }
            Err(error) => instrument_evaluations.push(json!({
                "instId": inst_id,
                "error": error
            })),
        }
    }
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "profilePositionSizing".to_string(),
            json!({
                "maxSingleTradeMarginPct": run.max_single_trade_margin_pct,
                "targetLeverage": run.target_leverage,
                "maxSingleTradeMargin": max_margin,
                "maxSingleTradeNotional": max_notional,
                "marginFormula": "min(usdtEquity * percent / 100, availableUsdt)",
                "enforcement": "trade.precheck+tradeOpportunity",
                "instrumentEvaluations": instrument_evaluations,
                "terminology": {
                    "effectiveExposureMultiple": "名义敞口 ÷ 权益，表示账户有效敞口倍数和每 1% 标的波动对应的近似权益敏感度",
                    "notionalPctOfEquity": "有效敞口倍数 × 100%，不是保证金占用、止损风险或容错结论",
                    "marginPctOfEquity": "预估初始保证金占权益",
                    "stopRiskPctOfEquity": "含费止损占权益",
                    "oneAtrRiskPctOfEquity": "一倍 ATR 对固定张数的价格盈亏占权益"
                }
            }),
        );
    }
}

fn ai_usdt_balance_context(snapshot: &PrivateAccountSnapshot) -> (f64, Option<f64>, usize) {
    let usdt_balance = snapshot
        .balances
        .iter()
        .find(|item| item.ccy.eq_ignore_ascii_case("USDT"));
    let usdt_equity = usdt_balance
        .and_then(|item| item.eq.parse::<f64>().ok())
        .unwrap_or_default();
    let available_usdt = usdt_balance.and_then(available_balance_value);
    let excluded_non_usdt_asset_count = snapshot
        .balances
        .iter()
        .filter(|item| !item.ccy.eq_ignore_ascii_case("USDT"))
        .filter(|item| {
            item.eq
                .parse::<f64>()
                .is_ok_and(|value| value.abs() > f64::EPSILON)
        })
        .count();
    (usdt_equity, available_usdt, excluded_non_usdt_asset_count)
}

fn ai_read_historical_orders(
    app: tauri::AppHandle,
    request: AiHistoricalReadRequest,
) -> Result<serde_json::Value, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    let conn = open_database(&app)?;
    let mut rows = load_historical_orders(
        &conn,
        &account.id,
        &account.environment,
        request
            .inst_id
            .as_deref()
            .filter(|value| !value.trim().is_empty()),
        request.limit.unwrap_or(300).clamp(1, 500),
    )?;
    rows.retain(|item| {
        ai_time_filter(
            item.okx_utime.or(item.okx_ctime).unwrap_or(item.synced_at),
            request.start_time,
            request.end_time,
        ) && request
            .state
            .as_deref()
            .map(|state| item.state.as_deref() == Some(state))
            .unwrap_or(true)
            && request
                .side
                .as_deref()
                .map(|side| item.side.as_deref() == Some(side))
                .unwrap_or(true)
            && request
                .pos_side
                .as_deref()
                .map(|pos_side| item.pos_side.as_deref() == Some(pos_side))
                .unwrap_or(true)
    });
    let limitations = if rows.is_empty() {
        vec!["本地同步历史在当前过滤窗口内无委托；这不等同于远端 OKX 账户从未下过委托"]
    } else {
        Vec::new()
    };
    Ok(json!({
        "summary": format!("读取历史委托 {} 条", rows.len()),
        "source": "local-private-history",
        "accountId": account.id,
        "environment": account.environment,
        "filters": {
            "instId": request.inst_id,
            "startTime": request.start_time,
            "endTime": request.end_time,
            "limit": request.limit.unwrap_or(300).clamp(1, 500)
        },
        "limitations": limitations,
        "orders": rows
    }))
}

fn ai_read_historical_fills(
    app: tauri::AppHandle,
    request: AiHistoricalReadRequest,
) -> Result<serde_json::Value, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    let conn = open_database(&app)?;
    let mut rows = load_historical_fills(
        &conn,
        &account.id,
        &account.environment,
        request
            .inst_id
            .as_deref()
            .filter(|value| !value.trim().is_empty()),
        request.limit.unwrap_or(300).clamp(1, 500),
    )?;
    rows.retain(|item| {
        ai_time_filter(
            item.okx_ts.unwrap_or(item.synced_at),
            request.start_time,
            request.end_time,
        ) && request
            .side
            .as_deref()
            .map(|side| item.side.as_deref() == Some(side))
            .unwrap_or(true)
            && request
                .pos_side
                .as_deref()
                .map(|pos_side| item.pos_side.as_deref() == Some(pos_side))
                .unwrap_or(true)
    });
    let limitations = if rows.is_empty() {
        vec!["本地同步历史在当前过滤窗口内无成交；这不等同于远端 OKX 账户从未成交"]
    } else {
        Vec::new()
    };
    Ok(json!({
        "summary": format!("读取历史成交 {} 条", rows.len()),
        "source": "local-private-history",
        "accountId": account.id,
        "environment": account.environment,
        "filters": {
            "instId": request.inst_id,
            "startTime": request.start_time,
            "endTime": request.end_time,
            "limit": request.limit.unwrap_or(300).clamp(1, 500)
        },
        "limitations": limitations,
        "fills": rows
    }))
}

fn ai_read_account_bills(
    app: tauri::AppHandle,
    request: AiHistoricalReadRequest,
) -> Result<serde_json::Value, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    let conn = open_database(&app)?;
    let mut rows = load_account_bills(
        &conn,
        &account.id,
        &account.environment,
        request
            .inst_id
            .as_deref()
            .filter(|value| !value.trim().is_empty()),
        request.limit.unwrap_or(300).clamp(1, 500),
    )?;
    rows.retain(|item| {
        ai_time_filter(
            item.okx_ts.unwrap_or(item.synced_at),
            request.start_time,
            request.end_time,
        )
    });
    Ok(json!({ "summary": format!("读取账户账单 {} 条", rows.len()), "bills": rows }))
}

fn ai_read_position_episodes(
    app: tauri::AppHandle,
    request: AiHistoricalReadRequest,
) -> Result<serde_json::Value, String> {
    let account = load_local_account_secret(&app, request.account_id.as_deref())?;
    let conn = open_database(&app)?;
    let mut rows = load_position_episodes(
        &conn,
        &account.id,
        &account.environment,
        request
            .inst_id
            .as_deref()
            .filter(|value| !value.trim().is_empty()),
        request.limit.unwrap_or(100).clamp(1, 500),
    )?;
    rows.retain(|item| ai_time_filter(item.open_time, request.start_time, request.end_time));
    let mut link_stmt = conn
        .prepare(
            "SELECT l.episode_id,l.opportunity_id,l.relation_type,l.attributed_qty,l.attribution_type,
             l.agent_run_id,t.reason,t.status
             FROM position_episode_opportunities l
             JOIN position_episodes p ON p.id=l.episode_id
             LEFT JOIN trade_opportunities t ON t.id=l.opportunity_id
             WHERE p.account_id=?1 AND p.environment=?2 AND (?3 IS NULL OR p.inst_id=?3)
             ORDER BY p.open_time DESC",
        )
        .map_err(|err| err.to_string())?;
    let links = link_stmt
        .query_map(
            params![account.id, account.environment, request.inst_id],
            |row| {
                Ok(json!({
                    "episodeId": row.get::<_, String>(0)?,
                    "opportunityId": row.get::<_, String>(1)?,
                    "relationType": row.get::<_, String>(2)?,
                    "attributedQty": row.get::<_, Option<String>>(3)?,
                    "attributionType": row.get::<_, String>(4)?,
                    "agentRunId": row.get::<_, Option<String>>(5)?,
                    "reason": row.get::<_, Option<String>>(6)?,
                    "opportunityStatus": row.get::<_, Option<String>>(7)?,
                }))
            },
        )
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    Ok(json!({
        "summary": format!("读取持仓片段 {} 条，关联交易机会 {} 条", rows.len(), links.len()),
        "episodes": rows,
        "opportunityLinks": links
    }))
}

fn ai_time_filter(value_ms: i64, start_time: Option<i64>, end_time: Option<i64>) -> bool {
    let to_millis = |value: i64| {
        if value.abs() <= 10_000_000_000 {
            value.saturating_mul(1000)
        } else {
            value
        }
    };
    let value = to_millis(value_ms);
    start_time
        .map(|start| value >= to_millis(start))
        .unwrap_or(true)
        && end_time.map(|end| value <= to_millis(end)).unwrap_or(true)
}

fn emit_ai_ui_action(
    app: &tauri::AppHandle,
    tool_name: &str,
    request: AiUiActionRequest,
    session_id: &str,
) -> Result<serde_json::Value, String> {
    let id = request
        .id
        .unwrap_or_else(|| format!("ai-ui-{}-{}", session_id, now_ms()));
    let payload = json!({
        "id": id,
        "sessionId": session_id,
        "toolName": tool_name,
        "instId": request.inst_id,
        "bar": request.bar,
        "payload": request.payload,
        "createdAt": now_ms()
    });
    app.emit(AI_CHART_ACTION_EVENT, payload.clone())
        .map_err(|err| err.to_string())?;
    Ok(json!({ "id": id, "sent": true, "event": AI_CHART_ACTION_EVENT, "toolName": tool_name }))
}

fn ai_read_memory_account_snapshot(
    runtime: &MarketRuntime,
    account_id: Option<&str>,
) -> Option<PrivateAccountSnapshot> {
    let store = runtime.store.lock().ok()?;
    if let Some(id) = normalize_account_id_option(account_id) {
        return store
            .private_snapshots
            .values()
            .find(|snapshot| snapshot.account_id == id)
            .cloned();
    }
    store.private_snapshot.clone()
}

fn mark_memory_private_snapshot_incomplete(
    runtime: &MarketRuntime,
    account_id: &str,
    error: &str,
) {
    let Ok(mut store) = runtime.store.lock() else {
        return;
    };
    let mut updated = None;
    for snapshot in store.private_snapshots.values_mut() {
        if snapshot.account_id == account_id {
            snapshot.positions_complete = false;
            snapshot.position_seq_id = None;
            snapshot.orders_complete = false;
            snapshot.orders_error = Some(error.to_string());
            snapshot.synced_at = now_ms();
            updated = Some(snapshot.clone());
            break;
        }
    }
    if let Some(snapshot) = updated {
        if store
            .private_snapshot
            .as_ref()
            .is_some_and(|current| current.account_id == account_id)
        {
            store.private_snapshot = Some(snapshot);
        }
    }
}

fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&data_dir).map_err(|err| err.to_string())?;
    Ok(data_dir.join("desic_trade_ai.sqlite3"))
}

fn open_database_connection(
    app: &tauri::AppHandle,
    initialize_journal_mode: bool,
) -> Result<Connection, String> {
    if !initialize_journal_mode {
        app.state::<DatabaseRuntime>().wait_until_ready()?;
    }
    let conn = Connection::open(database_path(app)?).map_err(|err| err.to_string())?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|err| err.to_string())?;
    if initialize_journal_mode {
        let journal_mode = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?;
        if !journal_mode.eq_ignore_ascii_case("wal") {
            conn.pragma_update(None, "journal_mode", "WAL")
                .map_err(|err| err.to_string())?;
        }
    }
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|err| err.to_string())?;
    conn.pragma_update(None, "temp_store", "MEMORY")
        .map_err(|err| err.to_string())?;
    Ok(conn)
}

fn open_database(app: &tauri::AppHandle) -> Result<Connection, String> {
    let conn = open_database_connection(app, false)?;
    let version = database_schema_version(&conn)?;
    if version != DATABASE_SCHEMA_VERSION {
        return Err(format!(
            "数据库结构尚未初始化或版本不兼容：当前 V{version}，需要 V{DATABASE_SCHEMA_VERSION}"
        ));
    }
    Ok(conn)
}

fn open_read_database(app: &tauri::AppHandle) -> Result<Connection, String> {
    app.state::<DatabaseRuntime>().wait_until_ready()?;
    let path = database_path(app)?;
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| err.to_string())?;
    conn.busy_timeout(Duration::from_secs(2))
        .map_err(|err| err.to_string())?;
    conn.pragma_update(None, "query_only", true)
        .map_err(|err| err.to_string())?;
    conn.pragma_update(None, "temp_store", "MEMORY")
        .map_err(|err| err.to_string())?;
    let version = database_schema_version(&conn)?;
    if version != DATABASE_SCHEMA_VERSION {
        return Err(format!(
            "数据库结构尚未初始化或版本不兼容：当前 V{version}，需要 V{DATABASE_SCHEMA_VERSION}"
        ));
    }
    Ok(conn)
}

fn database_schema_version(conn: &Connection) -> Result<i64, String> {
    conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .map_err(|err| err.to_string())
}

fn validate_database_v1(conn: &Connection) -> Result<(), String> {
    for table in [
        "candles",
        "trade_opportunities",
        "ai_agent_runs",
        "ai_decision_contexts",
        "intelligence_settings",
        "systematic_strategies",
        "systematic_factor_definitions",
        "systematic_paper_intents",
    ] {
        let exists = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|err| err.to_string())?;
        if !exists {
            return Err(format!("V1 数据库缺少必要表：{table}"));
        }
    }
    Ok(())
}

fn remove_database_v1_obsolete_objects(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS intelligence_raw_responses;
         DROP INDEX IF EXISTS idx_candles_query;
         DROP INDEX IF EXISTS idx_candles_integrity;",
    )
    .map_err(|err| err.to_string())
}

fn quoted_sql_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn scrub_private_exchange_storage(conn: &Connection) -> Result<(), String> {
    const MIGRATION_ID: &str = "storage-scrub-20260730";
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS local_data_migrations (
           id TEXT PRIMARY KEY,
           applied_at INTEGER NOT NULL
         );",
    )
    .map_err(|error| error.to_string())?;
    let applied = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM local_data_migrations WHERE id=?1)",
            [MIGRATION_ID],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| error.to_string())?;
    if applied {
        return Ok(());
    }

    let tables = {
        let mut statement = conn
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'local_data_migrations'",
            )
            .map_err(|error| error.to_string())?;
        let collected = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        collected
    };
    let markers = [exchange_client_marker(), retired_exchange_client_marker()];
    for table in tables {
        let quoted_table = quoted_sql_identifier(&table);
        let columns = {
            let mut statement = conn
                .prepare(&format!("PRAGMA table_info({quoted_table})"))
                .map_err(|error| error.to_string())?;
            let collected = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(1)?, row.get::<_, String>(2)?))
                })
                .map_err(|error| error.to_string())?
                .filter_map(|row| match row {
                    Ok((name, data_type))
                        if data_type.to_ascii_uppercase().contains("TEXT")
                            && name.to_ascii_lowercase().contains("json") =>
                    {
                        Some(Ok(name))
                    }
                    Ok(_) => None,
                    Err(error) => Some(Err(error)),
                })
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            collected
        };
        for column in columns {
            let quoted_column = quoted_sql_identifier(&column);
            let rows = {
                let mut statement = conn
                    .prepare(&format!(
                        "SELECT rowid,{quoted_column} FROM {quoted_table}
                         WHERE instr({quoted_column},?1)>0 OR instr({quoted_column},?2)>0"
                    ))
                    .map_err(|error| error.to_string())?;
                let collected = statement
                    .query_map(params![&markers[0], &markers[1]], |row| {
                        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                    })
                    .map_err(|error| error.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| error.to_string())?;
                collected
            };
            for (row_id, stored_value) in rows {
                let scrubbed = scrub_private_exchange_text(&stored_value);
                conn.execute(
                    &format!("UPDATE {quoted_table} SET {quoted_column}=?1 WHERE rowid=?2"),
                    params![scrubbed, row_id],
                )
                .map_err(|error| error.to_string())?;
            }
        }
    }
    conn.execute(
        "INSERT INTO local_data_migrations(id,applied_at) VALUES(?1,?2)",
        params![MIGRATION_ID, now_ms()],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn finish_database_v1_transaction(
    conn: &Connection,
    result: Result<(), String>,
) -> Result<(), String> {
    match result {
        Ok(()) => conn.execute_batch("COMMIT").map_err(|err| err.to_string()),
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn initialize_database_v1(app: &tauri::AppHandle) -> Result<(), String> {
    let conn = open_database_connection(app, true)?;
    initialize_database_v1_with_conn(&conn)
}

fn initialize_database_v1_with_conn(conn: &Connection) -> Result<(), String> {
    let version = database_schema_version(&conn)?;
    if version > DATABASE_SCHEMA_VERSION {
        return Err(format!(
            "数据库版本 V{version} 高于当前应用支持的 V{DATABASE_SCHEMA_VERSION}，拒绝降级打开"
        ));
    }
    if version == DATABASE_SCHEMA_VERSION {
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|err| err.to_string())?;
        let result = (|| {
            crate::ai_automation::migrate_ai_automation(conn)?;
            crate::systematic::migrate_systematic(conn)?;
            remove_database_v1_obsolete_objects(conn)?;
            scrub_private_exchange_storage(conn)?;
            validate_database_v1(conn)
        })();
        return finish_database_v1_transaction(conn, result);
    }
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|err| err.to_string())?;
    let result = (|| {
        migrate_database(conn)?;
        crate::ai_automation::migrate_ai_automation(conn)?;
        desic_intelligence::migrate_intelligence(conn)?;
        crate::systematic::migrate_systematic(conn)?;
        remove_database_v1_obsolete_objects(conn)?;
        scrub_private_exchange_storage(conn)?;
        validate_database_v1(conn)?;
        conn.pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION)
            .map_err(|err| err.to_string())?;
        Ok(())
    })();
    finish_database_v1_transaction(conn, result)
}

fn migrate_database(conn: &Connection) -> Result<(), String> {
    let version = database_schema_version(conn)?;
    if version == DATABASE_SCHEMA_VERSION {
        return Ok(());
    }
    if version > DATABASE_SCHEMA_VERSION {
        return Err(format!(
            "数据库版本 V{version} 高于当前应用支持的 V{DATABASE_SCHEMA_VERSION}"
        ));
    }
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS candles (
          symbol TEXT NOT NULL,
          interval TEXT NOT NULL,
          open_time INTEGER NOT NULL,
          close_time INTEGER NOT NULL,
          open TEXT NOT NULL,
          high TEXT NOT NULL,
          low TEXT NOT NULL,
          close TEXT NOT NULL,
          volume TEXT NOT NULL,
          volume_ccy TEXT,
          volume_quote TEXT,
          confirm INTEGER NOT NULL,
          source TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (symbol, interval, open_time)
        );
        CREATE TABLE IF NOT EXISTS candle_history_bounds (
          symbol TEXT NOT NULL,
          interval TEXT NOT NULL,
          oldest_open INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (symbol, interval)
        );
        CREATE TABLE IF NOT EXISTS kline_sync_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          symbol TEXT NOT NULL,
          interval TEXT NOT NULL,
          status TEXT NOT NULL,
          expected INTEGER NOT NULL,
          existing INTEGER NOT NULL,
          missing INTEGER NOT NULL,
          invalid INTEGER NOT NULL DEFAULT 0,
          invalid_reasons TEXT,
          attempt INTEGER NOT NULL DEFAULT 1,
          retry_state TEXT NOT NULL DEFAULT 'none',
          retry_after INTEGER,
          fetched INTEGER NOT NULL,
          inserted INTEGER NOT NULL,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          message TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_kline_sync_runs_cleanup
          ON kline_sync_runs(started_at);
        CREATE INDEX IF NOT EXISTS idx_kline_sync_runs_symbol
          ON kline_sync_runs(symbol, interval, started_at DESC);
        CREATE TABLE IF NOT EXISTS ai_sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_sessions_updated
          ON ai_sessions(updated_at DESC);
        CREATE TABLE IF NOT EXISTS ai_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          reasoning TEXT,
          tool_json TEXT,
          status TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_messages_session
          ON ai_messages(session_id, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_ai_messages_cleanup
          ON ai_messages(session_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS okx_orders (
          account_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          ord_id TEXT NOT NULL,
          cl_ord_id TEXT,
          inst_id TEXT NOT NULL,
          inst_type TEXT NOT NULL,
          side TEXT,
          pos_side TEXT,
          td_mode TEXT,
          ord_type TEXT,
          state TEXT,
          px TEXT,
          sz TEXT,
          acc_fill_sz TEXT,
          avg_px TEXT,
          pnl TEXT,
          fee TEXT,
          source_endpoint TEXT NOT NULL,
          operator TEXT NOT NULL DEFAULT 'unknown',
          strategy_id TEXT,
          session_id TEXT,
          opportunity_id TEXT,
          agent_run_id TEXT,
          execution_key TEXT,
          okx_ctime INTEGER,
          okx_utime INTEGER,
          raw_json TEXT NOT NULL,
          synced_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, environment, ord_id)
        );
        CREATE INDEX IF NOT EXISTS idx_okx_orders_query
          ON okx_orders(account_id, environment, inst_id, okx_ctime DESC);
        CREATE INDEX IF NOT EXISTS idx_okx_orders_state
          ON okx_orders(account_id, environment, state, okx_utime DESC);
        CREATE TABLE IF NOT EXISTS okx_fills (
          account_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          ord_id TEXT,
          trade_id TEXT,
          inst_id TEXT NOT NULL,
          inst_type TEXT NOT NULL,
          side TEXT,
          pos_side TEXT,
          sub_type TEXT,
          fill_px TEXT,
          fill_sz TEXT,
          fill_pnl TEXT,
          fee TEXT,
          fee_ccy TEXT,
          source_endpoint TEXT NOT NULL DEFAULT 'fills-history',
          operator TEXT NOT NULL DEFAULT 'unknown',
          strategy_id TEXT,
          session_id TEXT,
          opportunity_id TEXT,
          agent_run_id TEXT,
          execution_key TEXT,
          okx_ts INTEGER,
          raw_json TEXT NOT NULL,
          synced_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, environment, bill_id)
        );
        CREATE INDEX IF NOT EXISTS idx_okx_fills_query
          ON okx_fills(account_id, environment, inst_id, okx_ts DESC);
        CREATE INDEX IF NOT EXISTS idx_okx_fills_order
          ON okx_fills(account_id, environment, ord_id, okx_ts ASC);
        CREATE TABLE IF NOT EXISTS okx_account_bills (
          account_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          inst_id TEXT,
          inst_type TEXT,
          ccy TEXT,
          bill_type TEXT,
          sub_type TEXT,
          bal TEXT,
          bal_chg TEXT,
          pos_bal TEXT,
          pos_bal_chg TEXT,
          sz TEXT,
          px TEXT,
          pnl TEXT,
          fee TEXT,
          ord_id TEXT,
          trade_id TEXT,
          cl_ord_id TEXT,
          exec_type TEXT,
          mgn_mode TEXT,
          notes TEXT,
          source_endpoint TEXT NOT NULL,
          okx_ts INTEGER,
          raw_json TEXT NOT NULL,
          synced_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, environment, bill_id)
        );
        CREATE INDEX IF NOT EXISTS idx_okx_account_bills_query
          ON okx_account_bills(account_id, environment, inst_id, okx_ts DESC);
        CREATE INDEX IF NOT EXISTS idx_okx_account_bills_type
          ON okx_account_bills(account_id, environment, bill_type, sub_type, okx_ts DESC);
        CREATE TABLE IF NOT EXISTS trade_audit_events (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          exchange TEXT NOT NULL,
          inst_id TEXT NOT NULL,
          inst_type TEXT NOT NULL,
          event_type TEXT NOT NULL,
          operation TEXT NOT NULL,
          status TEXT NOT NULL,
          order_type TEXT,
          order_id TEXT,
          client_order_id TEXT,
          side TEXT,
          pos_side TEXT,
          td_mode TEXT,
          size TEXT,
          price TEXT,
          operator TEXT NOT NULL DEFAULT 'unknown',
          strategy_id TEXT,
          session_id TEXT,
          opportunity_id TEXT,
          agent_run_id TEXT,
          execution_key TEXT,
          live_confirmed INTEGER NOT NULL DEFAULT 0,
          okx_code TEXT,
          okx_message TEXT,
          error TEXT,
          request_json TEXT NOT NULL,
          response_json TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_trade_audit_events_query
          ON trade_audit_events(account_id, environment, inst_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_trade_audit_events_order
          ON trade_audit_events(account_id, environment, order_id, client_order_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_trade_audit_events_status
          ON trade_audit_events(status, event_type, created_at DESC);
        CREATE TABLE IF NOT EXISTS trade_opportunities (
          id TEXT PRIMARY KEY,
          account_id TEXT,
          environment TEXT NOT NULL,
          inst_id TEXT NOT NULL,
          td_mode TEXT NOT NULL,
          intent TEXT NOT NULL,
          direction TEXT NOT NULL,
          ticket_mode TEXT NOT NULL,
          action TEXT NOT NULL,
          order_type TEXT NOT NULL,
          price TEXT,
          size TEXT NOT NULL,
          lever TEXT,
          entry_condition TEXT,
          take_profit_json TEXT,
          stop_loss_json TEXT,
          invalidation_price TEXT,
          max_slippage_bps REAL,
          confidence REAL,
          time_horizon TEXT,
          strategy_name TEXT,
          evidence_json TEXT,
          risk_notes_json TEXT,
          reason TEXT NOT NULL,
          source_session_id TEXT,
          origin_type TEXT NOT NULL DEFAULT 'manual',
          strategy_kind TEXT,
          strategy_id TEXT,
          strategy_version_id TEXT,
          strategy_run_id TEXT,
          signal_id TEXT,
          factor_pool_version_id TEXT,
          revision INTEGER NOT NULL DEFAULT 1,
          fingerprint TEXT,
          expires_at INTEGER,
          agent_profile_id TEXT,
          agent_run_id TEXT,
          related_opportunity_id TEXT,
          duplicate_resolution TEXT,
          duplicate_resolution_reason TEXT,
          decision_context_id TEXT,
          execution_key TEXT,
          status TEXT NOT NULL,
          estimated_margin REAL,
          estimated_fee REAL,
          available_usdt REAL,
          precheck_json TEXT,
          market_snapshot_json TEXT,
          execution_result_json TEXT,
          order_id TEXT,
          client_order_id TEXT,
          algo_id TEXT,
          algo_client_order_id TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_trade_opportunities_status
          ON trade_opportunities(status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_trade_opportunities_inst
          ON trade_opportunities(environment, inst_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS ai_decision_contexts (
          id TEXT PRIMARY KEY,
          agent_run_id TEXT NOT NULL,
          agent_profile_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          inst_id TEXT NOT NULL,
          candidate_fingerprint TEXT NOT NULL,
          candidate_json TEXT NOT NULL,
          baseline_snapshot_json TEXT,
          snapshot_json TEXT NOT NULL,
          consumed_opportunity_id TEXT,
          captured_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          consumed_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_ai_decision_contexts_run
          ON ai_decision_contexts(agent_run_id, captured_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_decision_contexts_expiry
          ON ai_decision_contexts(expires_at, consumed_at);
        CREATE TABLE IF NOT EXISTS trade_execution_attempts (
          execution_key TEXT PRIMARY KEY,
          opportunity_id TEXT,
          agent_run_id TEXT,
          account_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          credential_fingerprint TEXT NOT NULL DEFAULT '',
          operation TEXT NOT NULL,
          client_order_id TEXT NOT NULL,
          order_id TEXT,
          status TEXT NOT NULL,
          request_json TEXT NOT NULL,
          response_json TEXT,
          error TEXT,
          owner_token TEXT NOT NULL DEFAULT '',
          lease_expires_at INTEGER NOT NULL DEFAULT 0,
          projection_status TEXT NOT NULL DEFAULT 'not_required',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_execution_attempts_client_order
          ON trade_execution_attempts(account_id, environment, client_order_id);
        CREATE INDEX IF NOT EXISTS idx_trade_execution_attempts_opportunity
          ON trade_execution_attempts(opportunity_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS account_mutation_leases (
          lease_id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          credential_fingerprint TEXT NOT NULL,
          operation TEXT NOT NULL,
          lease_expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_account_mutation_leases_account_expiry
          ON account_mutation_leases(account_id, lease_expires_at);
        CREATE TABLE IF NOT EXISTS trade_opportunity_resolution_events (
          id TEXT PRIMARY KEY,
          opportunity_id TEXT NOT NULL,
          related_opportunity_id TEXT,
          resolution TEXT NOT NULL,
          reason TEXT NOT NULL,
          agent_run_id TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (opportunity_id) REFERENCES trade_opportunities(id)
        );
        CREATE INDEX IF NOT EXISTS idx_trade_opportunity_resolution_events_opportunity
          ON trade_opportunity_resolution_events(opportunity_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS okx_account_bills_archives (
          account_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          year TEXT NOT NULL,
          quarter TEXT NOT NULL,
          bill_type TEXT NOT NULL DEFAULT '',
          request_result TEXT,
          state TEXT,
          file_href TEXT,
          okx_ts INTEGER,
          raw_json TEXT,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, environment, year, quarter, bill_type)
        );
        CREATE INDEX IF NOT EXISTS idx_okx_account_bills_archives_state
          ON okx_account_bills_archives(account_id, environment, state, updated_at DESC);
        CREATE TABLE IF NOT EXISTS okx_position_history (
          account_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          pos_id TEXT NOT NULL,
          inst_id TEXT NOT NULL,
          inst_type TEXT NOT NULL,
          mgn_mode TEXT,
          pos_side TEXT,
          direction TEXT,
          close_type TEXT,
          open_avg_px TEXT,
          close_avg_px TEXT,
          open_max_pos TEXT,
          close_total_pos TEXT,
          realized_pnl TEXT,
          pnl TEXT,
          fee TEXT,
          funding_fee TEXT,
          liq_penalty TEXT,
          okx_ctime INTEGER,
          okx_utime INTEGER,
          raw_json TEXT NOT NULL,
          synced_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, environment, pos_id, okx_utime)
        );
        CREATE INDEX IF NOT EXISTS idx_okx_position_history_query
          ON okx_position_history(account_id, environment, inst_id, okx_utime DESC);
        CREATE TABLE IF NOT EXISTS sync_watermarks (
          account_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          scope TEXT NOT NULL,
          inst_id TEXT NOT NULL DEFAULT '',
          last_sync_at INTEGER NOT NULL,
          summary_json TEXT,
          PRIMARY KEY (account_id, environment, scope, inst_id)
        );
        CREATE TABLE IF NOT EXISTS sync_endpoint_states (
          account_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          scope TEXT NOT NULL,
          inst_id TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL,
          cursor TEXT,
          newest_cursor TEXT,
          oldest_cursor TEXT,
          attempt INTEGER NOT NULL DEFAULT 0,
          fetched INTEGER NOT NULL DEFAULT 0,
          upserted INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          next_retry_at INTEGER,
          last_started_at INTEGER,
          last_finished_at INTEGER,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, environment, scope, inst_id)
        );
        CREATE INDEX IF NOT EXISTS idx_sync_endpoint_states_retry
          ON sync_endpoint_states(next_retry_at, updated_at);
        CREATE TABLE IF NOT EXISTS position_episodes (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          exchange TEXT NOT NULL,
          inst_type TEXT NOT NULL,
          inst_id TEXT NOT NULL,
          inst_family TEXT,
          exchange_pos_id TEXT,
          pos_mode TEXT NOT NULL,
          mgn_mode TEXT NOT NULL,
          episode_side TEXT NOT NULL,
          status TEXT NOT NULL,
          primary_origin TEXT NOT NULL,
          strategy_id TEXT,
          opportunity_id TEXT,
          agent_run_id TEXT,
          signal_id TEXT,
          trade_plan_id TEXT,
          opened_by_actor_id TEXT,
          closed_by_actor_id TEXT,
          open_time INTEGER NOT NULL,
          close_time INTEGER,
          open_qty TEXT NOT NULL,
          max_qty TEXT NOT NULL,
          closed_qty TEXT NOT NULL,
          remaining_qty TEXT NOT NULL,
          avg_open_px TEXT,
          avg_close_px TEXT,
          realized_pnl TEXT,
          fees TEXT,
          funding_fee TEXT,
          liq_penalty TEXT,
          net_pnl TEXT,
          initial_lever TEXT,
          final_lever TEXT,
          last_okx_pos_id TEXT,
          last_trade_id TEXT,
          last_fill_time INTEGER,
          notes TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_position_episodes_query
          ON position_episodes(account_id, environment, inst_id, episode_side, open_time DESC);
        CREATE INDEX IF NOT EXISTS idx_position_episodes_status
          ON position_episodes(account_id, environment, status, updated_at DESC);
        CREATE TABLE IF NOT EXISTS position_episode_events (
          id TEXT PRIMARY KEY,
          episode_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          origin TEXT NOT NULL,
          actor_id TEXT,
          strategy_id TEXT,
          signal_id TEXT,
          trade_plan_id TEXT,
          ord_id TEXT,
          bill_id TEXT,
          trade_id TEXT,
          side TEXT,
          pos_side TEXT,
          qty TEXT NOT NULL,
          price TEXT,
          pnl TEXT,
          fee TEXT,
          fee_ccy TEXT,
          position_before TEXT,
          position_after TEXT,
          avg_px_before TEXT,
          avg_px_after TEXT,
          event_time INTEGER NOT NULL,
          source TEXT NOT NULL,
          raw_ref TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (episode_id) REFERENCES position_episodes(id)
        );
        CREATE INDEX IF NOT EXISTS idx_position_episode_events_episode
          ON position_episode_events(episode_id, event_time ASC);
        CREATE INDEX IF NOT EXISTS idx_position_episode_events_fill
          ON position_episode_events(bill_id);
        CREATE TABLE IF NOT EXISTS position_episode_opportunities (
          episode_id TEXT NOT NULL,
          opportunity_id TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          attributed_qty TEXT,
          attribution_type TEXT NOT NULL,
          agent_run_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (episode_id, opportunity_id, relation_type),
          FOREIGN KEY (episode_id) REFERENCES position_episodes(id),
          FOREIGN KEY (opportunity_id) REFERENCES trade_opportunities(id)
        );
        CREATE INDEX IF NOT EXISTS idx_position_episode_opportunities_opportunity
          ON position_episode_opportunities(opportunity_id, episode_id);
        CREATE TABLE IF NOT EXISTS chart_workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          layout_json TEXT NOT NULL,
          indicators_json TEXT NOT NULL,
          layers_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chart_workspaces_updated
          ON chart_workspaces(updated_at DESC);
        CREATE TABLE IF NOT EXISTS chart_workspace_views (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          symbol TEXT NOT NULL,
          timeframe TEXT NOT NULL,
          layout_json TEXT NOT NULL,
          indicators_json TEXT NOT NULL,
          layers_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (workspace_id) REFERENCES chart_workspaces(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_chart_workspace_views_workspace
          ON chart_workspace_views(workspace_id, sort_order ASC, updated_at ASC);
        CREATE TABLE IF NOT EXISTS chart_drawings (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          view_id TEXT,
          drawing_json TEXT NOT NULL,
          layer_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (workspace_id) REFERENCES chart_workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY (view_id) REFERENCES chart_workspace_views(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_chart_drawings_workspace_view
          ON chart_drawings(workspace_id, view_id, updated_at ASC);
        CREATE TABLE IF NOT EXISTS chart_alerts (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          view_id TEXT,
          status TEXT NOT NULL,
          last_triggered_at INTEGER,
          definition_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (workspace_id) REFERENCES chart_workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY (view_id) REFERENCES chart_workspace_views(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_chart_alerts_workspace_status
          ON chart_alerts(workspace_id, status, updated_at DESC);
        CREATE TABLE IF NOT EXISTS chart_alert_events (
          id TEXT PRIMARY KEY,
          alert_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          inst_id TEXT NOT NULL,
          condition_kind TEXT NOT NULL,
          direction TEXT NOT NULL,
          trigger_price REAL NOT NULL,
          last_price REAL NOT NULL,
          triggered_at INTEGER NOT NULL,
          delivery_status TEXT NOT NULL,
          FOREIGN KEY (alert_id) REFERENCES chart_alerts(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_chart_alert_events_alert_time
          ON chart_alert_events(alert_id, triggered_at DESC);
        ",
    )
    .map_err(|err| err.to_string())?;
    let _ = conn.execute(
        "ALTER TABLE kline_sync_runs ADD COLUMN invalid INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE kline_sync_runs ADD COLUMN invalid_reasons TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE kline_sync_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE kline_sync_runs ADD COLUMN retry_state TEXT NOT NULL DEFAULT 'none'",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE kline_sync_runs ADD COLUMN retry_after INTEGER",
        [],
    );
    let _ = conn.execute("ALTER TABLE okx_orders ADD COLUMN cl_ord_id TEXT", []);
    let _ = conn.execute("ALTER TABLE okx_orders ADD COLUMN opportunity_id TEXT", []);
    let _ = conn.execute("ALTER TABLE okx_orders ADD COLUMN agent_run_id TEXT", []);
    let _ = conn.execute("ALTER TABLE okx_orders ADD COLUMN execution_key TEXT", []);
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_okx_orders_cl_ord
          ON okx_orders(account_id, environment, cl_ord_id)",
        [],
    )
    .map_err(|err| err.to_string())?;
    let _ = conn.execute(
        "ALTER TABLE okx_fills ADD COLUMN source_endpoint TEXT NOT NULL DEFAULT 'fills-history'",
        [],
    );
    let _ = conn.execute("ALTER TABLE okx_fills ADD COLUMN opportunity_id TEXT", []);
    let _ = conn.execute("ALTER TABLE okx_fills ADD COLUMN agent_run_id TEXT", []);
    let _ = conn.execute("ALTER TABLE okx_fills ADD COLUMN execution_key TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE trade_audit_events ADD COLUMN opportunity_id TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE trade_audit_events ADD COLUMN agent_run_id TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE trade_audit_events ADD COLUMN execution_key TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE trade_execution_attempts ADD COLUMN credential_fingerprint TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE trade_execution_attempts ADD COLUMN owner_token TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE trade_execution_attempts ADD COLUMN lease_expires_at INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE trade_execution_attempts ADD COLUMN projection_status TEXT NOT NULL DEFAULT 'not_required'",
        [],
    );
    conn.execute(
        "UPDATE trade_execution_attempts
         SET projection_status='pending'
         WHERE operation IN ('place_algo_order','amend_algo_order')
           AND status='accepted' AND projection_status='not_required'",
        [],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_trade_execution_attempts_guard
          ON trade_execution_attempts(account_id, environment, status, updated_at DESC)",
        [],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_trade_execution_attempts_projection
          ON trade_execution_attempts(operation, status, projection_status, updated_at ASC)",
        [],
    )
    .map_err(|err| err.to_string())?;
    let _ = conn.execute(
        "ALTER TABLE trade_opportunities ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE trade_opportunities ADD COLUMN fingerprint TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE trade_opportunities ADD COLUMN expires_at INTEGER",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE trade_opportunities ADD COLUMN agent_profile_id TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE trade_opportunities ADD COLUMN agent_run_id TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE trade_opportunities ADD COLUMN related_opportunity_id TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE trade_opportunities ADD COLUMN duplicate_resolution TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE trade_opportunities ADD COLUMN duplicate_resolution_reason TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE trade_opportunities ADD COLUMN execution_key TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE trade_opportunities ADD COLUMN market_snapshot_json TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE trade_opportunities ADD COLUMN decision_context_id TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE trade_opportunities ADD COLUMN origin_type TEXT NOT NULL DEFAULT 'manual'",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE trade_opportunities ADD COLUMN strategy_kind TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE trade_opportunities ADD COLUMN strategy_id TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE trade_opportunities ADD COLUMN strategy_version_id TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE trade_opportunities ADD COLUMN strategy_run_id TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE trade_opportunities ADD COLUMN signal_id TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE trade_opportunities ADD COLUMN factor_pool_version_id TEXT",
        [],
    );
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_decision_contexts (
           id TEXT PRIMARY KEY,
           agent_run_id TEXT NOT NULL,
           agent_profile_id TEXT NOT NULL,
           account_id TEXT NOT NULL,
           environment TEXT NOT NULL,
           inst_id TEXT NOT NULL,
           candidate_fingerprint TEXT NOT NULL,
           candidate_json TEXT NOT NULL,
           baseline_snapshot_json TEXT,
           snapshot_json TEXT NOT NULL,
           consumed_opportunity_id TEXT,
           captured_at INTEGER NOT NULL,
           expires_at INTEGER NOT NULL,
           consumed_at INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_ai_decision_contexts_run
           ON ai_decision_contexts(agent_run_id, captured_at DESC);
         CREATE INDEX IF NOT EXISTS idx_ai_decision_contexts_expiry
           ON ai_decision_contexts(expires_at, consumed_at);",
    )
    .map_err(|err| err.to_string())?;
    let _ = conn.execute(
        "ALTER TABLE position_episodes ADD COLUMN opportunity_id TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE position_episodes ADD COLUMN agent_run_id TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE position_episode_events ADD COLUMN opportunity_id TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE position_episode_events ADD COLUMN agent_run_id TEXT",
        [],
    );
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_trade_opportunities_fingerprint
          ON trade_opportunities(fingerprint, status, created_at DESC)",
        [],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_opportunities_execution_key
          ON trade_opportunities(execution_key)
          WHERE execution_key IS NOT NULL AND execution_key <> ''",
        [],
    )
    .map_err(|err| err.to_string())?;
    let _ = conn.execute(
        "ALTER TABLE sync_endpoint_states ADD COLUMN newest_cursor TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE sync_endpoint_states ADD COLUMN oldest_cursor TEXT",
        [],
    );
    let _ = conn.execute(
        "UPDATE sync_endpoint_states
         SET oldest_cursor = COALESCE(oldest_cursor, cursor)
         WHERE cursor IS NOT NULL AND (oldest_cursor IS NULL OR oldest_cursor = '')",
        [],
    );
    instrument_operations::migrate_instrument_operations(conn)?;
    Ok(())
}

fn storage_table_counts(conn: &Connection) -> Result<HashMap<String, i64>, String> {
    let table_names = [
        "candles",
        "kline_sync_runs",
        "ai_sessions",
        "ai_messages",
        "okx_orders",
        "okx_fills",
        "trade_audit_events",
        "trade_opportunities",
        "trade_opportunity_resolution_events",
        "okx_position_history",
        "sync_watermarks",
        "sync_endpoint_states",
        "position_episodes",
        "position_episode_events",
        "position_episode_opportunities",
        "intelligence_news_articles",
        "intelligence_news_contents",
        "intelligence_coin_sentiment",
        "intelligence_sentiment_rankings",
        "intelligence_economic_events",
        "intelligence_smart_traders",
        "intelligence_smart_trader_snapshots",
        "intelligence_smart_positions",
        "intelligence_smart_closed_positions",
        "intelligence_smart_orders",
        "intelligence_smart_signals",
        "intelligence_tracked_traders",
        "intelligence_sync_state",
        "intelligence_fetch_log",
    ];
    let mut rows = HashMap::new();
    for table in table_names {
        let sql = format!("SELECT COUNT(*) FROM {}", table);
        let count = conn
            .query_row(&sql, [], |row| row.get::<_, i64>(0))
            .unwrap_or_default();
        rows.insert(table.to_string(), count);
    }
    Ok(rows)
}

fn trim_ai_messages(conn: &Connection, keep_per_session: i64) -> Result<usize, String> {
    let mut stmt = conn
        .prepare("SELECT id FROM ai_sessions")
        .map_err(|err| err.to_string())?;
    let session_rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?;
    let sessions = session_rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    let mut deleted = 0usize;
    for session_id in sessions {
        deleted += conn
            .execute(
                "DELETE FROM ai_messages
                 WHERE session_id = ?1
                   AND id NOT IN (
                     SELECT id FROM ai_messages
                     WHERE session_id = ?1
                     ORDER BY created_at DESC
                     LIMIT ?2
                   )",
                params![session_id, keep_per_session],
            )
            .map_err(|err| err.to_string())?;
    }
    Ok(deleted)
}

fn create_ai_session(conn: &Connection, title: String) -> Result<AiSession, String> {
    let id = format!("session-{}", now_ms());
    upsert_ai_session(conn, &id, &title, "idle")?;
    load_ai_session(conn, &id)
}

fn load_or_create_ai_session(conn: &Connection, session_id: &str) -> Result<AiSession, String> {
    if let Ok(session) = load_ai_session(conn, session_id) {
        return Ok(session);
    }
    upsert_ai_session(conn, session_id, "AI 对话", "idle")?;
    load_ai_session(conn, session_id)
}

fn ai_session_origin(session_id: &str) -> AiSessionOrigin {
    if session_id.starts_with("background:") || session_id.starts_with("review:") {
        AiSessionOrigin::Automation
    } else {
        AiSessionOrigin::User
    }
}

fn ai_session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiSession> {
    let id = row.get::<_, String>(0)?;
    Ok(AiSession {
        origin: ai_session_origin(&id),
        id,
        title: row.get(1)?,
        status: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

fn load_ai_session(conn: &Connection, session_id: &str) -> Result<AiSession, String> {
    conn.query_row(
        "SELECT id, title, status, created_at, updated_at FROM ai_sessions WHERE id = ?1",
        params![session_id],
        ai_session_from_row,
    )
    .map_err(|err| err.to_string())
}

fn list_ai_sessions(conn: &Connection) -> Result<Vec<AiSession>, String> {
    const AUTOMATION_FILTER: &str = "WHERE id GLOB 'background:*' OR id GLOB 'review:*'";
    const USER_FILTER: &str = "WHERE NOT (id GLOB 'background:*' OR id GLOB 'review:*')";
    let mut sessions = Vec::with_capacity(60);

    for filter in [USER_FILTER, AUTOMATION_FILTER] {
        let sql = format!(
            "SELECT id, title, status, created_at, updated_at FROM ai_sessions {filter} ORDER BY updated_at DESC LIMIT 30"
        );
        let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([], ai_session_from_row)
            .map_err(|err| err.to_string())?;
        sessions.extend(
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?,
        );
    }
    sessions.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| right.created_at.cmp(&left.created_at))
    });
    Ok(sessions)
}

fn rename_ai_session(conn: &Connection, session_id: &str, title: &str) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE ai_sessions SET title = ?2, updated_at = ?3 WHERE id = ?1",
            params![session_id, title, now_ms()],
        )
        .map_err(|err| err.to_string())?;
    if changed == 0 {
        return Err("会话不存在".to_string());
    }
    Ok(())
}

fn delete_ai_session(conn: &Connection, session_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM ai_messages WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute("DELETE FROM ai_sessions WHERE id = ?1", params![session_id])
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn load_ai_messages(conn: &Connection, session_id: &str) -> Result<Vec<AiStoredMessage>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, role, content, reasoning, tool_json, status, created_at
             FROM ai_messages WHERE session_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![session_id], |row| {
            Ok(AiStoredMessage {
                id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                reasoning: row.get(4)?,
                tool_json: row.get(5)?,
                status: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn upsert_ai_session(conn: &Connection, id: &str, title: &str, status: &str) -> Result<(), String> {
    let now = now_ms();
    conn.execute(
        "INSERT INTO ai_sessions (id, title, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(id) DO UPDATE SET
           title = CASE WHEN ai_sessions.title = 'AI 对话' OR ai_sessions.title = '新对话' THEN excluded.title ELSE ai_sessions.title END,
           status = excluded.status,
           updated_at = excluded.updated_at",
        params![id, title, status, now],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn set_ai_session_status(conn: &Connection, id: &str, status: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE ai_sessions SET status = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, status, now_ms()],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn upsert_ai_message(
    conn: &Connection,
    id: &str,
    session_id: &str,
    role: &str,
    content: &str,
    reasoning: Option<&str>,
    tool_json: Option<&str>,
    status: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO ai_messages (id, session_id, role, content, reasoning, tool_json, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
           content = excluded.content,
           reasoning = excluded.reasoning,
           tool_json = excluded.tool_json,
           status = excluded.status",
        params![id, session_id, role, content, reasoning, tool_json, status, now_ms()],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn existing_open_times(
    conn: &Connection,
    symbol: &str,
    interval: &str,
    start_open: i64,
    end_open: i64,
) -> Result<Vec<i64>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT open_time
             FROM candles
             WHERE symbol = ?1 AND interval = ?2 AND open_time BETWEEN ?3 AND ?4
             ORDER BY open_time ASC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![symbol, interval, start_open, end_open], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn insert_kline_sync_run(conn: &Connection, report: &KlineSyncReport) -> Result<(), String> {
    let invalid_reasons =
        serde_json::to_string(&report.invalid_reasons).map_err(|err| err.to_string())?;
    conn.execute(
        "INSERT INTO kline_sync_runs (
          symbol, interval, status, expected, existing, missing, invalid, invalid_reasons,
          attempt, retry_state, retry_after, fetched, inserted, started_at, finished_at, message
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            report.symbol,
            report.interval,
            report.status,
            report.expected as i64,
            report.existing as i64,
            report.missing as i64,
            report.invalid as i64,
            invalid_reasons,
            report.attempt as i64,
            report.retry_state,
            report.retry_after,
            report.fetched as i64,
            report.inserted as i64,
            report.started_at,
            report.finished_at,
            report.message,
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn consecutive_kline_retry_attempt(
    conn: &Connection,
    symbol: &str,
    interval: &str,
) -> Result<usize, String> {
    let mut stmt = conn
        .prepare(
            "SELECT status, retry_state
             FROM kline_sync_runs
             WHERE symbol = ?1 AND interval = ?2
             ORDER BY id DESC
             LIMIT 20",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![symbol, interval], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| err.to_string())?;
    let mut attempts = 1usize;
    for row in rows {
        let (status, retry_state) = row.map_err(|err| err.to_string())?;
        if status == "complete" && retry_state == "none" {
            break;
        }
        if retry_state == "pending_retry"
            || retry_state == "permanent_gap"
            || status == "failed"
            || status == "partial"
        {
            attempts += 1;
        } else {
            break;
        }
    }
    Ok(attempts.min(99))
}

fn apply_kline_retry_state(conn: &Connection, report: &mut KlineSyncReport) {
    let needs_retry = report.status == "failed" || report.missing > 0 || report.invalid > 0;
    if !needs_retry {
        report.attempt = 1;
        report.retry_state = "none".to_string();
        report.retry_after = None;
        return;
    }
    let attempt =
        consecutive_kline_retry_attempt(conn, &report.symbol, &report.interval).unwrap_or(1);
    report.attempt = attempt;
    if attempt >= 5 {
        report.retry_state = "permanent_gap".to_string();
        report.retry_after = None;
        return;
    }
    let delay_minutes = 5_i64 * 2_i64.pow((attempt.saturating_sub(1)).min(5) as u32);
    report.retry_state = "pending_retry".to_string();
    report.retry_after = Some(now_ms() + delay_minutes * 60_000);
}

fn existing_invalid_candle_reasons(
    conn: &Connection,
    symbol: &str,
    interval: &str,
    start_open: i64,
    end_open: i64,
    strict_confirm_before: i64,
) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT open_time, open, high, low, close, volume, confirm
             FROM candles
             WHERE symbol = ?1 AND interval = ?2 AND open_time BETWEEN ?3 AND ?4
             ORDER BY open_time ASC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![symbol, interval, start_open, end_open], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)? == 1,
            ))
        })
        .map_err(|err| err.to_string())?;
    let step = bar_ms(interval).ok_or_else(|| format!("unsupported interval {}", interval))?;
    let mut reasons = Vec::new();
    for row in rows {
        let (open_time_ms, open, high, low, close, volume, confirm) =
            row.map_err(|err| err.to_string())?;
        let raw = RawCandle {
            open_time_ms,
            open,
            high,
            low,
            close,
            volume,
            volume_ccy: None,
            volume_quote: None,
            confirm,
        };
        reasons.extend(validate_raw_candle(
            interval,
            &raw,
            step,
            Some(strict_confirm_before),
        ));
    }
    Ok(reasons)
}

fn upsert_raw_candles(
    conn: &mut Connection,
    symbol: &str,
    interval: &str,
    candles: &[RawCandle],
    source: &str,
) -> Result<usize, String> {
    let step = bar_ms(interval).ok_or_else(|| format!("unsupported interval {}", interval))?;
    let mut inserted = 0usize;
    for chunk in candles.chunks(500) {
        let tx = conn.transaction().map_err(|err| err.to_string())?;
        let mut stmt = tx
            .prepare(
                "INSERT INTO candles (
                  symbol, interval, open_time, close_time, open, high, low, close,
                  volume, volume_ccy, volume_quote, confirm, source, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                ON CONFLICT(symbol, interval, open_time) DO UPDATE SET
                  close_time = excluded.close_time,
                  open = excluded.open,
                  high = excluded.high,
                  low = excluded.low,
                  close = excluded.close,
                  volume = excluded.volume,
                  volume_ccy = excluded.volume_ccy,
                  volume_quote = excluded.volume_quote,
                  confirm = MAX(candles.confirm, excluded.confirm),
                  source = CASE
                    WHEN candles.confirm = 1 AND excluded.confirm = 0 THEN candles.source
                    ELSE excluded.source
                  END,
                  updated_at = excluded.updated_at",
            )
            .map_err(|err| err.to_string())?;
        let updated_at = now_ms();
        for candle in chunk {
            let changed = stmt
                .execute(params![
                    symbol,
                    interval,
                    candle.open_time_ms,
                    candle.open_time_ms + step - 1,
                    candle.open,
                    candle.high,
                    candle.low,
                    candle.close,
                    candle.volume,
                    candle.volume_ccy,
                    candle.volume_quote,
                    if candle.confirm { 1 } else { 0 },
                    source,
                    updated_at,
                ])
                .map_err(|err| err.to_string())?;
            if changed > 0 {
                inserted += 1;
            }
        }
        drop(stmt);
        tx.commit().map_err(|err| err.to_string())?;
    }
    Ok(inserted)
}

fn local_candles_between(
    conn: &Connection,
    symbol: &str,
    interval: &str,
    start_open: i64,
    end_open: i64,
) -> Result<Vec<Candle>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT open_time, open, high, low, close, volume, confirm
             FROM candles
             WHERE symbol = ?1 AND interval = ?2 AND open_time >= ?3 AND open_time <= ?4
             ORDER BY open_time ASC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![symbol, interval, start_open, end_open], |row| {
            Ok(Candle {
                time: row.get::<_, i64>(0)? / 1000,
                open: row.get::<_, String>(1)?.parse::<f64>().unwrap_or_default(),
                high: row.get::<_, String>(2)?.parse::<f64>().unwrap_or_default(),
                low: row.get::<_, String>(3)?.parse::<f64>().unwrap_or_default(),
                close: row.get::<_, String>(4)?.parse::<f64>().unwrap_or_default(),
                volume: row.get::<_, String>(5)?.parse::<f64>().unwrap_or_default(),
                confirm: row.get::<_, i64>(6)? == 1,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn load_historical_exhaustion_bound(
    conn: &Connection,
    symbol: &str,
    interval: &str,
) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT oldest_open FROM candle_history_bounds WHERE symbol = ?1 AND interval = ?2",
        params![symbol, interval],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn upsert_historical_exhaustion_bound(
    conn: &Connection,
    symbol: &str,
    interval: &str,
    oldest_open: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO candle_history_bounds (symbol, interval, oldest_open, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(symbol, interval) DO UPDATE SET
           oldest_open = MIN(candle_history_bounds.oldest_open, excluded.oldest_open),
           updated_at = excluded.updated_at",
        params![symbol, interval, oldest_open, now_ms()],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn candles_cover_window(
    candles: &[Candle],
    start_open_ms: i64,
    end_open_ms: i64,
    step_ms: i64,
) -> bool {
    let expected_count =
        ((end_open_ms.saturating_sub(start_open_ms) / step_ms).saturating_add(1)) as usize;
    candles.len() == expected_count
        && candles
            .first()
            .is_some_and(|candle| candle.time.saturating_mul(1000) == start_open_ms)
        && candles
            .last()
            .is_some_and(|candle| candle.time.saturating_mul(1000) == end_open_ms)
        && candles_are_continuous(candles, step_ms)
}

fn local_historical_candles(
    conn: &Connection,
    symbol: &str,
    bar: &str,
    start_open: i64,
    end_open: i64,
    limit: u16,
) -> Result<Vec<Candle>, String> {
    let direct = local_candles_between(conn, symbol, bar, start_open, end_open)?;
    let step = bar_ms(bar).ok_or_else(|| format!("unsupported interval: {}", bar))?;
    if candles_cover_window(&direct, start_open, end_open, step) || bar == "1m" {
        return Ok(direct);
    }
    let aggregated = aggregate_candles_from_1m(
        conn,
        symbol,
        bar,
        Some(start_open / 1000),
        Some(end_open / 1000),
        limit,
        false,
    )?;
    if candles_cover_window(&aggregated, start_open, end_open, step)
        || aggregated.len() > direct.len()
    {
        Ok(aggregated)
    } else {
        Ok(direct)
    }
}

async fn read_historical_local_page(
    app: tauri::AppHandle,
    symbol: String,
    bar: String,
    start_open: i64,
    end_open: i64,
    limit: u16,
) -> Result<HistoricalLocalPage, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_read_database(&app)?;
        Ok(HistoricalLocalPage {
            candles: local_historical_candles(&conn, &symbol, &bar, start_open, end_open, limit)?,
            exhausted_before_open: load_historical_exhaustion_bound(&conn, &symbol, &bar)?,
        })
    })
    .await
    .map_err(|err| format!("历史 K 线本地读取任务失败: {}", err))?
}

async fn write_historical_page(
    app: tauri::AppHandle,
    symbol: String,
    bar: String,
    candles: Vec<RawCandle>,
    exhausted_oldest_open: Option<i64>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_database(&app)?;
        if !candles.is_empty() {
            upsert_raw_candles(&mut conn, &symbol, &bar, &candles, "history-page")?;
        }
        if let Some(oldest_open) = exhausted_oldest_open {
            upsert_historical_exhaustion_bound(&conn, &symbol, &bar, oldest_open)?;
        }
        Ok(())
    })
    .await
    .map_err(|err| format!("历史 K 线本地写入任务失败: {}", err))?
}

fn historical_page(candles: Vec<Candle>, exhausted: bool, source: &str) -> HistoricalCandlesPage {
    HistoricalCandlesPage {
        earliest_time: candles.first().map(|candle| candle.time),
        candles,
        exhausted,
        source: source.to_string(),
    }
}

fn aggregate_candles_from_1m(
    conn: &Connection,
    symbol: &str,
    bar: &str,
    start_time: Option<i64>,
    end_time: Option<i64>,
    limit: u16,
    confirmed_only: bool,
) -> Result<Vec<Candle>, String> {
    aggregate_candles_from_1m_with_overlay(
        conn,
        symbol,
        bar,
        start_time,
        end_time,
        limit,
        confirmed_only,
        &[],
    )
}

fn aggregate_candles_from_1m_with_overlay(
    conn: &Connection,
    symbol: &str,
    bar: &str,
    start_time: Option<i64>,
    end_time: Option<i64>,
    limit: u16,
    confirmed_only: bool,
    memory_one_minute: &[Candle],
) -> Result<Vec<Candle>, String> {
    let step = bar_ms(bar).ok_or_else(|| format!("unsupported interval: {}", bar))?;
    let bounded_limit = limit.clamp(1, 5000);
    let end_open = end_time
        .map(|value| align_open_time(value.saturating_mul(1000), bar, step))
        .unwrap_or_else(|| align_open_time(now_ms(), bar, step));
    let start_open = start_time
        .map(|value| align_open_time(value.saturating_mul(1000), bar, step))
        .unwrap_or_else(|| {
            let source_step: i64 = 60_000;
            if bar == "1m" {
                end_open.saturating_sub(
                    source_step.saturating_mul((bounded_limit as i64).saturating_sub(1)),
                )
            } else {
                end_open.saturating_sub(
                    step.saturating_mul(bounded_limit as i64)
                        .saturating_sub(source_step),
                )
            }
        });
    let source_end_open = if bar == "1m" {
        end_open
    } else {
        end_open.saturating_add(step).saturating_sub(60_000)
    };
    load_ai_candle_window(
        conn,
        symbol,
        &AiCandleReadWindow {
            bar: bar.to_string(),
            step,
            start_open,
            source_end_open,
        },
        bounded_limit,
        confirmed_only,
        memory_one_minute,
    )
    .map(|loaded| loaded.candles)
}

fn load_ai_candle_window(
    conn: &Connection,
    symbol: &str,
    window: &AiCandleReadWindow,
    limit: u16,
    confirmed_only: bool,
    memory_one_minute: &[Candle],
) -> Result<AiCandleWindowLoad, String> {
    let bounded_limit = limit.clamp(1, 5000) as usize;
    let memory = memory_one_minute
        .iter()
        .filter(|candle| {
            let open_time = candle.time.saturating_mul(1000);
            open_time >= window.start_open && open_time <= window.source_end_open
        })
        .collect::<Vec<_>>();
    let memory_rows = memory.len();
    let mut database_read_ms = 0;
    let mut aggregate_ms = 0;
    let mut database_rows = 0;

    let mut candles = if window.bar == "1m" {
        let started = Instant::now();
        let database = local_candles_between(
            conn,
            symbol,
            "1m",
            window.start_open,
            window.source_end_open,
        )?;
        database_read_ms += started.elapsed().as_millis();
        database_rows += database.len();
        let started = Instant::now();
        let merged = merge_candle_series(database, memory.iter().copied());
        aggregate_ms += started.elapsed().as_millis();
        merged
    } else {
        let started = Instant::now();
        let mut aggregated = local_aggregated_one_minute_candles(
            conn,
            symbol,
            window.step,
            window.start_open,
            window.source_end_open,
        )?;
        database_read_ms += started.elapsed().as_millis();
        database_rows += aggregated.len();

        if let Some(first_memory_open) = memory
            .iter()
            .map(|candle| candle.time.saturating_mul(1000))
            .min()
        {
            let overlay_start = first_memory_open
                .div_euclid(window.step)
                .saturating_mul(window.step)
                .max(window.start_open);
            let started = Instant::now();
            let database_tail =
                local_candles_between(conn, symbol, "1m", overlay_start, window.source_end_open)?;
            database_read_ms += started.elapsed().as_millis();
            database_rows += database_tail.len();

            let started = Instant::now();
            let merged_tail = merge_candle_series(
                database_tail,
                memory
                    .iter()
                    .copied()
                    .filter(|candle| candle.time.saturating_mul(1000) >= overlay_start),
            );
            let recomputed_tail =
                aggregate_one_minute_candles(&merged_tail, window.step, window.source_end_open);
            aggregated.retain(|candle| candle.time.saturating_mul(1000) < overlay_start);
            aggregated.extend(recomputed_tail);
            aggregate_ms += started.elapsed().as_millis();
        }
        aggregated
    };

    if confirmed_only {
        candles.retain(|candle| candle.confirm);
    }
    if candles.len() > bounded_limit {
        candles = candles[candles.len() - bounded_limit..].to_vec();
    }
    let merged_rows = candles.len();
    Ok(AiCandleWindowLoad {
        candles,
        database_read_ms,
        aggregate_ms,
        database_rows,
        memory_rows,
        merged_rows,
    })
}

fn local_aggregated_one_minute_candles(
    conn: &Connection,
    symbol: &str,
    target_step_ms: i64,
    start_open_ms: i64,
    source_end_open_ms: i64,
) -> Result<Vec<Candle>, String> {
    let expected_count = (target_step_ms / 60_000).max(1);
    let mut stmt = conn
        .prepare(
            "WITH grouped AS (
               SELECT
                 CAST(open_time / ?2 AS INTEGER) * ?2 AS bucket_open,
                 MIN(open_time) AS first_open,
                 MAX(open_time) AS last_open,
                 MAX(CAST(high AS REAL)) AS high_value,
                 MIN(CAST(low AS REAL)) AS low_value,
                 SUM(CAST(volume AS REAL)) AS volume_value,
                 COUNT(*) AS sample_count,
                 SUM(CASE WHEN confirm = 1 THEN 1 ELSE 0 END) AS confirmed_count
               FROM candles
               WHERE symbol = ?1 AND interval = '1m'
                 AND open_time >= ?3 AND open_time <= ?4
               GROUP BY bucket_open
             )
             SELECT
               grouped.bucket_open,
               first_row.open,
               grouped.high_value,
               grouped.low_value,
               last_row.close,
               grouped.volume_value,
               grouped.sample_count,
               grouped.first_open,
               grouped.last_open,
               grouped.confirmed_count
             FROM grouped
             JOIN candles AS first_row
               ON first_row.symbol = ?1 AND first_row.interval = '1m'
              AND first_row.open_time = grouped.first_open
             JOIN candles AS last_row
               ON last_row.symbol = ?1 AND last_row.interval = '1m'
              AND last_row.open_time = grouped.last_open
             ORDER BY grouped.bucket_open ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(
            params![symbol, target_step_ms, start_open_ms, source_end_open_ms],
            |row| {
                let bucket_open = row.get::<_, i64>(0)?;
                let sample_count = row.get::<_, i64>(6)?;
                let first_open = row.get::<_, i64>(7)?;
                let last_open = row.get::<_, i64>(8)?;
                let confirmed_count = row.get::<_, i64>(9)?;
                let complete = sample_count == expected_count
                    && first_open == bucket_open
                    && last_open == bucket_open + target_step_ms - 60_000;
                Ok(Candle {
                    time: bucket_open / 1000,
                    open: row.get::<_, String>(1)?.parse::<f64>().unwrap_or_default(),
                    high: row.get::<_, f64>(2)?,
                    low: row.get::<_, f64>(3)?,
                    close: row.get::<_, String>(4)?.parse::<f64>().unwrap_or_default(),
                    volume: row.get::<_, f64>(5)?,
                    confirm: complete && confirmed_count == sample_count,
                })
            },
        )
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn merge_candle_series<'a>(
    database: Vec<Candle>,
    memory: impl IntoIterator<Item = &'a Candle>,
) -> Vec<Candle> {
    let mut merged = database
        .into_iter()
        .map(|candle| (candle.time, candle))
        .collect::<BTreeMap<_, _>>();
    for candle in memory {
        if merged
            .get(&candle.time)
            .is_some_and(|existing| existing.confirm && !candle.confirm)
        {
            continue;
        }
        merged.insert(candle.time, candle.clone());
    }
    merged.into_values().collect()
}

fn aggregate_one_minute_candles(
    candles: &[Candle],
    target_step_ms: i64,
    end_open_ms: i64,
) -> Vec<Candle> {
    if candles.is_empty() {
        return Vec::new();
    }
    let expected_count = (target_step_ms / 60_000).max(1) as usize;
    let mut out = Vec::new();
    let mut bucket_start: Option<i64> = None;
    let mut bucket: Vec<&Candle> = Vec::new();
    for candle in candles {
        let open_ms = candle.time.saturating_mul(1000);
        let group_start = open_ms
            .div_euclid(target_step_ms)
            .saturating_mul(target_step_ms);
        if bucket_start.is_none() {
            bucket_start = Some(group_start);
        }
        if bucket_start != Some(group_start) {
            if let Some(start) = bucket_start {
                if let Some(value) =
                    aggregate_bucket(start, target_step_ms, end_open_ms, expected_count, &bucket)
                {
                    out.push(value);
                }
            }
            bucket.clear();
            bucket_start = Some(group_start);
        }
        bucket.push(candle);
    }
    if let Some(start) = bucket_start {
        if let Some(value) =
            aggregate_bucket(start, target_step_ms, end_open_ms, expected_count, &bucket)
        {
            out.push(value);
        }
    }
    out
}

fn aggregate_bucket(
    start_ms: i64,
    target_step_ms: i64,
    end_open_ms: i64,
    expected_count: usize,
    bucket: &[&Candle],
) -> Option<Candle> {
    let first = bucket.first()?;
    let last = bucket.last()?;
    let continuous = bucket
        .windows(2)
        .all(|pair| pair[1].time - pair[0].time == 60);
    let complete = bucket.len() == expected_count
        && first.time.saturating_mul(1000) == start_ms
        && last.time.saturating_mul(1000) == start_ms + target_step_ms - 60_000;
    let period_closed = start_ms + target_step_ms <= end_open_ms + target_step_ms;
    Some(Candle {
        time: start_ms / 1000,
        open: first.open,
        high: bucket
            .iter()
            .map(|item| item.high)
            .fold(f64::NEG_INFINITY, f64::max),
        low: bucket
            .iter()
            .map(|item| item.low)
            .fold(f64::INFINITY, f64::min),
        close: last.close,
        volume: bucket.iter().map(|item| item.volume).sum(),
        confirm: complete && continuous && period_closed && bucket.iter().all(|item| item.confirm),
    })
}

fn candles_are_continuous(candles: &[Candle], step_ms: i64) -> bool {
    if candles.len() < 2 {
        return true;
    }
    let expected_step_secs = step_ms / 1000;
    candles
        .windows(2)
        .all(|pair| pair[1].time - pair[0].time == expected_step_secs)
}

fn validate_raw_candle(
    interval: &str,
    candle: &RawCandle,
    step: i64,
    strict_confirm_before: Option<i64>,
) -> Vec<String> {
    let mut reasons = Vec::new();
    let offset = kline_open_offset_ms(interval, step);
    if (candle.open_time_ms - offset).rem_euclid(step) != 0 {
        reasons.push(format!(
            "{} open_time 未按周期对齐: {}",
            interval, candle.open_time_ms
        ));
    }
    let open = candle.open.parse::<f64>().ok();
    let high = candle.high.parse::<f64>().ok();
    let low = candle.low.parse::<f64>().ok();
    let close = candle.close.parse::<f64>().ok();
    let volume = candle.volume.parse::<f64>().ok();
    match (open, high, low, close) {
        (Some(open), Some(high), Some(low), Some(close)) => {
            if high < low {
                reasons.push(format!(
                    "{} high < low at {}",
                    interval, candle.open_time_ms
                ));
            }
            if high < open || high < close {
                reasons.push(format!(
                    "{} high 低于 open/close at {}",
                    interval, candle.open_time_ms
                ));
            }
            if low > open || low > close {
                reasons.push(format!(
                    "{} low 高于 open/close at {}",
                    interval, candle.open_time_ms
                ));
            }
        }
        _ => reasons.push(format!(
            "{} OHLC 非数字 at {}",
            interval, candle.open_time_ms
        )),
    }
    if !volume.is_some_and(|value| value >= 0.0) {
        reasons.push(format!(
            "{} volume 无效 at {}",
            interval, candle.open_time_ms
        ));
    }
    if !candle.confirm
        && strict_confirm_before.is_some_and(|boundary| candle.open_time_ms < boundary)
    {
        reasons.push(format!(
            "{} 历史K线长期未确认 at {}",
            interval, candle.open_time_ms
        ));
    }
    reasons
}

async fn fetch_history_candles(
    symbol: &str,
    interval: &str,
    from_open: i64,
    to_open: i64,
) -> Result<Vec<RawCandle>, String> {
    Ok(
        fetch_history_candles_page(symbol, interval, from_open, to_open)
            .await?
            .candles,
    )
}

async fn fetch_history_candles_page(
    symbol: &str,
    interval: &str,
    from_open: i64,
    to_open: i64,
) -> Result<HistoryCandlesFetch, String> {
    let mut rows: HashMap<i64, RawCandle> = HashMap::new();
    let mut after = to_open + bar_ms(interval).unwrap_or(60_000);
    let lower_bound = from_open;
    let mut exhausted = false;

    for _ in 0..160 {
        let path = format!(
            "/api/v5/market/history-candles?instId={}&bar={}&after={}&limit=300",
            url_encode(symbol),
            url_encode(interval),
            after
        );
        let envelope: OkxEnvelope<Vec<String>> = get_json(&path).await?;
        if envelope.data.is_empty() {
            exhausted = true;
            break;
        }
        let mut oldest = after;
        let mut saw_in_range = false;
        for row in envelope.data {
            if let Some(raw) = normalize_raw_candle(&row) {
                oldest = oldest.min(raw.open_time_ms);
                if raw.open_time_ms >= from_open && raw.open_time_ms <= to_open {
                    saw_in_range = true;
                    rows.insert(raw.open_time_ms, raw);
                }
            }
        }
        if oldest <= lower_bound || !saw_in_range && oldest < from_open {
            break;
        }
        after = oldest;
    }

    let mut values = rows.into_values().collect::<Vec<_>>();
    values.sort_by_key(|item| item.open_time_ms);
    Ok(HistoryCandlesFetch {
        candles: values,
        exhausted,
    })
}

async fn fetch_recent_market_candles(
    symbol: &str,
    interval: &str,
    from_open: i64,
    to_open: i64,
) -> Result<Vec<RawCandle>, String> {
    let path = format!(
        "/api/v5/market/candles?instId={}&bar={}&limit=300",
        url_encode(symbol),
        url_encode(interval)
    );
    let envelope: OkxEnvelope<Vec<String>> = get_json(&path).await?;
    let mut rows = envelope
        .data
        .into_iter()
        .filter_map(|row| normalize_raw_candle(&row))
        .filter(|raw| raw.open_time_ms >= from_open && raw.open_time_ms <= to_open)
        .collect::<Vec<_>>();
    rows.sort_by_key(|item| item.open_time_ms);
    Ok(rows)
}

async fn fetch_repair_candles(
    app: &tauri::AppHandle,
    report: &mut KlineSyncReport,
    symbol: &str,
    interval: &str,
    from_open: i64,
    to_open: i64,
) -> Result<Vec<RawCandle>, String> {
    let mut rows: HashMap<i64, RawCandle> = HashMap::new();
    if interval == "1m" {
        for raw in fetch_static_daily_candles(app, report, symbol, from_open, to_open)
            .await
            .unwrap_or_default()
        {
            rows.insert(raw.open_time_ms, raw);
        }
    }
    report.progress_detail = Some(format!(
        "正在通过 OKX REST 补齐 {} {} K线数据",
        symbol, interval
    ));
    emit_kline_sync(app, report);
    for raw in fetch_history_candles(symbol, interval, from_open, to_open).await? {
        rows.insert(raw.open_time_ms, raw);
    }
    for raw in fetch_recent_market_candles(symbol, interval, from_open, to_open).await? {
        rows.insert(raw.open_time_ms, raw);
    }
    let mut values = rows.into_values().collect::<Vec<_>>();
    values.sort_by_key(|item| item.open_time_ms);
    Ok(values)
}

async fn fetch_static_daily_candles(
    app: &tauri::AppHandle,
    report: &mut KlineSyncReport,
    symbol: &str,
    from_open: i64,
    to_open: i64,
) -> Result<Vec<RawCandle>, String> {
    let today_start = utc_day_start_ms(now_ms());
    let upper = to_open.min(today_start.saturating_sub(60_000));
    if upper < from_open {
        return Ok(Vec::new());
    }
    let client = reqwest_client()?;
    let mut rows = HashMap::new();
    let mut day = utc_day_start_ms(from_open);
    let end_day = utc_day_start_ms(upper);
    while day <= end_day {
        let day_label = utc_day_label(day);
        report.progress_detail = Some(format!("正在下载 {} {} K线数据", symbol, day_label));
        emit_kline_sync(app, report);
        match fetch_static_daily_candles_for_day(&client, symbol, day).await {
            Ok(items) => {
                for raw in items
                    .into_iter()
                    .filter(|item| item.open_time_ms >= from_open && item.open_time_ms <= upper)
                {
                    rows.insert(raw.open_time_ms, raw);
                }
            }
            Err(_) => {}
        }
        day = day.saturating_add(86_400_000);
    }
    let mut values = rows.into_values().collect::<Vec<_>>();
    values.sort_by_key(|item| item.open_time_ms);
    Ok(values)
}

async fn fetch_static_daily_candles_for_day(
    client: &reqwest::Client,
    symbol: &str,
    day_start_ms: i64,
) -> Result<Vec<RawCandle>, String> {
    let date = Utc
        .timestamp_millis_opt(day_start_ms)
        .single()
        .ok_or_else(|| format!("invalid day timestamp {}", day_start_ms))?;
    let ymd_compact = format!("{:04}{:02}{:02}", date.year(), date.month(), date.day());
    let ymd = format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day());
    let url = format!(
        "https://static.okx.com/cdn/okex/traderecords/candlesticks/daily/{}/{}-candlesticks-{}.zip?v=999",
        ymd_compact,
        url_encode(symbol),
        ymd
    );
    let bytes = client
        .get(url)
        .send()
        .await
        .map_err(|err| err.to_string())?
        .error_for_status()
        .map_err(|err| err.to_string())?
        .bytes()
        .await
        .map_err(|err| err.to_string())?;
    parse_static_candles_zip(symbol, &bytes)
}

fn parse_static_candles_zip(symbol: &str, bytes: &[u8]) -> Result<Vec<RawCandle>, String> {
    let reader = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader).map_err(|err| err.to_string())?;
    let mut rows = Vec::new();
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|err| err.to_string())?;
        if !file.name().ends_with(".csv") {
            continue;
        }
        let mut content = String::new();
        file.read_to_string(&mut content)
            .map_err(|err| err.to_string())?;
        let mut rdr = csv::Reader::from_reader(content.as_bytes());
        for record in rdr.records() {
            let record = record.map_err(|err| err.to_string())?;
            if record.get(0) != Some(symbol) {
                continue;
            }
            let open_time_ms = record.get(8).and_then(|value| value.parse::<i64>().ok());
            let Some(open_time_ms) = open_time_ms else {
                continue;
            };
            rows.push(RawCandle {
                open_time_ms,
                open: record.get(1).unwrap_or_default().to_string(),
                high: record.get(2).unwrap_or_default().to_string(),
                low: record.get(3).unwrap_or_default().to_string(),
                close: record.get(4).unwrap_or_default().to_string(),
                volume: record.get(5).unwrap_or_default().to_string(),
                volume_ccy: record.get(6).map(|value| value.to_string()),
                volume_quote: record.get(7).map(|value| value.to_string()),
                confirm: record.get(9).unwrap_or_default() == "1",
            });
        }
    }
    rows.sort_by_key(|item| item.open_time_ms);
    Ok(rows)
}

fn utc_day_start_ms(value_ms: i64) -> i64 {
    value_ms.div_euclid(86_400_000).saturating_mul(86_400_000)
}

fn utc_day_label(value_ms: i64) -> String {
    Utc.timestamp_millis_opt(value_ms)
        .single()
        .map(|date| format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day()))
        .unwrap_or_else(|| value_ms.to_string())
}

async fn get_json<T>(path: &str) -> Result<OkxEnvelope<T>, String>
where
    T: for<'de> Deserialize<'de>,
{
    let url = format!("{}{}", REST_BASE, path);
    let client = reqwest_client()?;
    let mut last_error = String::new();
    for attempt in 0..=OKX_PUBLIC_REST_RETRY_DELAYS_MS.len() {
        match get_json_once::<T>(&client, &url, path).await {
            Ok(envelope) => return Ok(envelope),
            Err(err) => {
                let retryable = err.retryable;
                let retry_delay_ms = err.retry_delay_ms;
                last_error = err.message;
                if !retryable || attempt == OKX_PUBLIC_REST_RETRY_DELAYS_MS.len() {
                    break;
                }
                sleep(Duration::from_millis(
                    retry_delay_ms.unwrap_or(OKX_PUBLIC_REST_RETRY_DELAYS_MS[attempt]),
                ))
                .await;
            }
        }
    }
    Err(last_error)
}

struct RestRequestError {
    message: String,
    retryable: bool,
    retry_delay_ms: Option<u64>,
}

async fn get_json_once<T>(
    client: &reqwest::Client,
    url: &str,
    path: &str,
) -> Result<OkxEnvelope<T>, RestRequestError>
where
    T: for<'de> Deserialize<'de>,
{
    let _permit = acquire_public_rest_slot(path)
        .await
        .map_err(|message| RestRequestError {
            retryable: true,
            retry_delay_ms: Some(OKX_PUBLIC_REST_RATE_LIMIT_RETRY_MS),
            message,
        })?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|err| RestRequestError {
            retryable: reqwest_error_retryable(&err),
            retry_delay_ms: None,
            message: classify_reqwest_error("OKX Public REST", path, &err),
        })?;
    let status = response.status();
    let body = response.text().await.map_err(|err| RestRequestError {
        retryable: reqwest_error_retryable(&err),
        retry_delay_ms: None,
        message: classify_reqwest_error("OKX Public REST body", path, &err),
    })?;
    if !status.is_success() {
        let retryable = http_status_retryable(status.as_u16());
        return Err(RestRequestError {
            retryable,
            retry_delay_ms: if status.as_u16() == 429 {
                Some(OKX_PUBLIC_REST_RATE_LIMIT_RETRY_MS)
            } else {
                None
            },
            message: format!(
                "OKX Public REST HTTP {} {}: {}",
                status.as_u16(),
                status.canonical_reason().unwrap_or(""),
                compact_response_body(&body)
            ),
        });
    }
    let envelope =
        serde_json::from_str::<OkxEnvelope<T>>(&body).map_err(|err| RestRequestError {
            retryable: false,
            retry_delay_ms: None,
            message: format!(
                "OKX Public REST 响应解析失败({}): {}；响应片段：{}",
                path,
                err,
                compact_response_body(&body)
            ),
        })?;
    if envelope.code != "0" {
        let retryable = okx_public_code_retryable(&envelope.code, &envelope.msg);
        let retry_delay_ms = if envelope.code == "50011" {
            Some(OKX_PUBLIC_REST_RATE_LIMIT_RETRY_MS)
        } else {
            None
        };
        return Err(RestRequestError {
            retryable,
            retry_delay_ms,
            message: classified_okx_error("okx_public_get", path, &envelope.code, &envelope.msg),
        });
    }
    Ok(envelope)
}

async fn acquire_public_rest_slot(path: &str) -> Result<SemaphorePermit<'static>, String> {
    let permit = OKX_PUBLIC_REST_SEMAPHORE
        .get_or_init(|| Semaphore::new(OKX_PUBLIC_REST_MAX_CONCURRENT))
        .acquire()
        .await
        .map_err(|err| format!("OKX Public REST 限速器不可用: {}", err))?;
    let (limiter, minimum_ms) = public_rest_limiter_for_path(path);
    let mut last_request = limiter.lock().await;
    if let Some(last) = *last_request {
        let elapsed = last.elapsed();
        let minimum = Duration::from_millis(minimum_ms);
        if elapsed < minimum {
            sleep(minimum - elapsed).await;
        }
    }
    *last_request = Some(Instant::now());
    Ok(permit)
}

fn public_rest_limiter_for_path(path: &str) -> (&'static AsyncMutex<Option<Instant>>, u64) {
    if path.starts_with("/api/v5/market/history-candles") {
        return (
            OKX_HISTORY_CANDLES_LAST_REQUEST.get_or_init(|| AsyncMutex::new(None)),
            OKX_HISTORY_CANDLES_MIN_INTERVAL_MS,
        );
    }
    if path.starts_with("/api/v5/market/candles") {
        return (
            OKX_MARKET_CANDLES_LAST_REQUEST.get_or_init(|| AsyncMutex::new(None)),
            OKX_MARKET_CANDLES_MIN_INTERVAL_MS,
        );
    }
    (
        OKX_PUBLIC_REST_LAST_REQUEST.get_or_init(|| AsyncMutex::new(None)),
        OKX_PUBLIC_REST_DEFAULT_MIN_INTERVAL_MS,
    )
}

fn reqwest_error_retryable(err: &reqwest::Error) -> bool {
    err.is_timeout() || err.is_connect() || err.is_request() || err.is_body() || err.is_decode()
}

fn http_status_retryable(status: u16) -> bool {
    matches!(status, 408 | 425 | 429 | 500 | 502 | 503 | 504)
}

fn okx_public_code_retryable(code: &str, message: &str) -> bool {
    let (_, _, _, retryable) = classify_okx_error(code, message);
    retryable
}

fn classify_reqwest_error(scope: &str, path: &str, err: &reqwest::Error) -> String {
    let raw = err.to_string();
    let source_chain = reqwest_source_chain(err);
    let detail = if source_chain.is_empty() {
        raw.clone()
    } else {
        format!("{raw}; cause: {source_chain}")
    };
    let lower = detail.to_ascii_lowercase();
    let category = if err.is_timeout() {
        "超时"
    } else if err.is_connect() {
        "连接失败"
    } else if lower.contains("proxy") || lower.contains("代理") {
        "代理异常"
    } else if lower.contains("dns") || lower.contains("resolve") {
        "DNS 解析失败"
    } else if lower.contains("tls") || lower.contains("certificate") || lower.contains("ssl") {
        "TLS/证书异常"
    } else if err.is_decode() {
        "响应解析失败"
    } else {
        "网络异常"
    };
    format!("{scope} {category}({path}): {detail}")
}

fn reqwest_source_chain(err: &reqwest::Error) -> String {
    let mut parts = Vec::new();
    let mut current = err.source();
    while let Some(source) = current {
        parts.push(source.to_string());
        current = source.source();
    }
    parts.join(" -> ")
}

fn compact_response_body(body: &str) -> String {
    let compact = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() > 240 {
        format!("{}...", compact.chars().take(240).collect::<String>())
    } else if compact.is_empty() {
        "<empty>".to_string()
    } else {
        compact
    }
}

fn classified_okx_error(source: &str, operation: &str, code: &str, message: &str) -> String {
    let (category, user_message, suggestion, retryable) =
        if source == "okx_intelligence_get" && code.starts_with("510") {
            (
                "intelligence_param",
                "OKX 市场情报查询参数与当前接口版本不兼容。",
                "检查该情报端点支持的时间版本、筛选字段和参数组合。",
                false,
            )
        } else {
            classify_okx_error(code, message)
        };
    let payload = ClassifiedOkxError {
        desic_terminal_error: true,
        source: source.to_string(),
        operation: operation.to_string(),
        category: category.to_string(),
        code: code.to_string(),
        message: message.to_string(),
        user_message: user_message.to_string(),
        suggestion: suggestion.to_string(),
        retryable,
    };
    serde_json::to_string(&payload)
        .unwrap_or_else(|_| format!("{} {}: {}", operation, code, message))
}

fn classify_okx_error(
    code: &str,
    message: &str,
) -> (&'static str, &'static str, &'static str, bool) {
    let lower = message.to_ascii_lowercase();
    if code == "50102" || lower.contains("timestamp request expired") {
        return (
            "time_sync",
            "OKX 请求时间戳已过期。",
            "应用会自动重新校准 OKX 服务器时间并重试；如果持续出现，请检查系统自动时间和代理延迟。",
            true,
        );
    }
    if code == "50011" {
        return (
            "rate_limit",
            "OKX 请求过于频繁。",
            "稍等几秒后重试；如果持续出现，需要降低 REST/交易请求频率。",
            true,
        );
    }
    if matches!(
        code,
        "50004" | "50013" | "50026" | "50027" | "50028" | "50040"
    ) {
        return (
            "network_or_service",
            "OKX 服务暂时不可用或响应超时。",
            "等待短时间后重试，并检查代理和 OKX 可达性。",
            true,
        );
    }
    if code.starts_with("501")
        || lower.contains("api key")
        || lower.contains("passphrase")
        || lower.contains("signature")
        || lower.contains("permission")
    {
        return (
            "auth",
            "OKX 账号认证或环境不匹配。",
            "检查 API Key、Secret、Passphrase、模拟盘/实盘环境和交易权限。",
            false,
        );
    }
    if is_insufficient_margin_error(message) {
        return (
            "risk_or_balance",
            "保证金、仓位或风控条件不满足。",
            "检查可用余额、杠杆、全仓/逐仓、当前持仓方向和可平数量。",
            false,
        );
    }
    if code.starts_with("510") {
        if lower.contains("tag") {
            return (
                "order_param",
                "当前客户端的委托来源标识与 OKX 不兼容。",
                "请更新客户端后重试；若仍失败，请携带错误码联系支持。",
                false,
            );
        }
        return (
            "order_param",
            "委托参数不符合 OKX 要求。",
            "检查合约、价格、数量、委托类型、保证金模式、持仓模式和最小下单量。",
            false,
        );
    }
    if code.starts_with("511") || lower.contains("balance") || lower.contains("margin") {
        return (
            "risk_or_balance",
            "保证金、仓位或风控条件不满足。",
            "检查可用余额、杠杆、全仓/逐仓、当前持仓方向和可平数量。",
            false,
        );
    }
    if code.starts_with("514") {
        return (
            "cancel_or_order_state",
            "订单状态不允许当前操作。",
            "刷新当前委托；订单可能已成交、已撤销或不存在。",
            false,
        );
    }
    if lower.contains("timeout") || lower.contains("temporarily") || lower.contains("try again") {
        return (
            "network_or_service",
            "OKX 响应超时或服务暂不可用。",
            "稍后重试，并检查代理、网络和 OKX 状态。",
            true,
        );
    }
    (
        "okx_unknown",
        "OKX 返回未分类错误。",
        "保留原始错误码和信息，必要时查看 OKX 文档或通知中心诊断。",
        false,
    )
}

fn is_insufficient_margin_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("insufficient")
        && (lower.contains("margin") || lower.contains("balance") || lower.contains("usdt"))
}

fn okx_private_headers(
    account: &LocalAccount,
    timestamp: &str,
    method: &str,
    path: &str,
    body: &str,
) -> Result<HeaderMap, String> {
    let sign = okx_sign(&account.secret_key, timestamp, method, path, body)?;
    let mut headers = HeaderMap::new();
    headers.insert(
        "OK-ACCESS-KEY",
        HeaderValue::from_str(&account.api_key).map_err(|err| err.to_string())?,
    );
    headers.insert(
        "OK-ACCESS-SIGN",
        HeaderValue::from_str(&sign).map_err(|err| err.to_string())?,
    );
    headers.insert(
        "OK-ACCESS-TIMESTAMP",
        HeaderValue::from_str(timestamp).map_err(|err| err.to_string())?,
    );
    headers.insert(
        "OK-ACCESS-PASSPHRASE",
        HeaderValue::from_str(&account.passphrase).map_err(|err| err.to_string())?,
    );
    if method == "POST" {
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    }
    if account.environment.eq_ignore_ascii_case("demo")
        || account.environment.eq_ignore_ascii_case("simulated")
    {
        headers.insert("x-simulated-trading", HeaderValue::from_static("1"));
    }
    Ok(headers)
}

fn okx_error_fields(body: &str) -> Option<(String, String)> {
    let value = serde_json::from_str::<serde_json::Value>(body).ok()?;
    let code = value.get("code")?.as_str()?.trim();
    if code.is_empty() || code == "0" {
        return None;
    }
    let message = value
        .get("msg")
        .and_then(|item| item.as_str())
        .unwrap_or_default()
        .to_string();
    Some((code.to_string(), message))
}

fn okx_timestamp_error(body: &str) -> bool {
    okx_error_fields(body).is_some_and(|(code, message)| {
        code == "50102"
            || message
                .to_ascii_lowercase()
                .contains("timestamp request expired")
    })
}

fn okx_private_http_error(
    source: &str,
    path: &str,
    status: reqwest::StatusCode,
    body: &str,
    account: &LocalAccount,
) -> String {
    let sanitized = sanitize_secret(
        &sanitize_secret(
            &sanitize_secret(body, &account.api_key),
            &account.secret_key,
        ),
        &account.passphrase,
    );
    if let Some((code, message)) = okx_error_fields(&sanitized) {
        return classified_okx_error(source, path, &code, &message);
    }
    format!(
        "OKX private HTTP {}: {}",
        status,
        compact_response_body(&sanitized)
    )
}

async fn resync_okx_clock_after_timestamp_error(
    source: &str,
    path: &str,
    observed_generation: u64,
) -> Result<(), String> {
    resync_okx_clock_if_unchanged(observed_generation)
        .await
        .map_err(|error| {
            classified_okx_error(
                source,
                path,
                "50102",
                &format!("Timestamp request expired; OKX time resync failed: {error}"),
            )
        })
}

async fn okx_private_get_response(
    client: &reqwest::Client,
    account: &LocalAccount,
    url: &str,
    path: &str,
) -> Result<(reqwest::StatusCode, String), String> {
    let mut last_send_error = None;
    for attempt in 0..3 {
        let timestamp = okx_rest_timestamp()?;
        let headers = okx_private_headers(account, &timestamp, "GET", path, "")?;
        match client.get(url).headers(headers).send().await {
            Ok(response) => {
                let status = response.status();
                match response.text().await {
                    Ok(body) => return Ok((status, body)),
                    Err(err) => {
                        let retryable = reqwest_error_retryable(&err);
                        last_send_error =
                            Some(classify_reqwest_error("OKX Private REST body", path, &err));
                        if !retryable || attempt == 2 {
                            break;
                        }
                    }
                }
            }
            Err(err) => {
                let retryable = reqwest_error_retryable(&err);
                last_send_error = Some(classify_reqwest_error("OKX Private REST", path, &err));
                if !retryable || attempt == 2 {
                    break;
                }
            }
        }
        sleep(Duration::from_millis(120 * (attempt + 1) as u64)).await;
    }
    Err(last_send_error.unwrap_or_else(|| format!("OKX Private REST 连接失败({path})")))
}

async fn okx_private_get<T>(account: &LocalAccount, path: &str) -> Result<OkxEnvelope<T>, String>
where
    T: for<'de> Deserialize<'de>,
{
    let url = format!("{}{}", REST_BASE, path);
    let client = reqwest_client()?;
    for timestamp_attempt in 0..=1 {
        let observed_generation = OKX_CLOCK_SYNC_GENERATION.load(Ordering::Acquire);
        let (status, body) = okx_private_get_response(&client, account, &url, path).await?;
        if timestamp_attempt == 0 && okx_timestamp_error(&body) {
            resync_okx_clock_after_timestamp_error("okx_private_get", path, observed_generation)
                .await?;
            continue;
        }
        if !status.is_success() {
            return Err(okx_private_http_error(
                "okx_private_get",
                path,
                status,
                &body,
                account,
            ));
        }
        let envelope = serde_json::from_str::<OkxEnvelope<T>>(&body)
            .map_err(|err| format!("OKX private decode failed({}): {}", path, err))?;
        if envelope.code != "0" {
            let message = sanitize_secret(&envelope.msg, &account.api_key);
            return Err(classified_okx_error(
                "okx_private_get",
                path,
                &envelope.code,
                &message,
            ));
        }
        return Ok(envelope);
    }
    unreachable!("OKX private GET timestamp retry loop must return")
}

fn account_config_cache_key(account: &LocalAccount) -> String {
    format!(
        "{}:{}",
        normalize_environment(&account.environment),
        account.id
    )
}

fn account_config_cache_fingerprint(account: &LocalAccount) -> String {
    let mut digest = Sha256::new();
    for value in [
        account.id.as_str(),
        account.environment.as_str(),
        account.api_key.as_str(),
        account.secret_key.as_str(),
        account.passphrase.as_str(),
        if account.permissions.read {
            "read=1"
        } else {
            "read=0"
        },
        if account.permissions.trade {
            "trade=1"
        } else {
            "trade=0"
        },
    ] {
        digest.update(value.as_bytes());
        digest.update([0]);
    }
    format!("{:x}", digest.finalize())
}

pub(crate) fn ensure_account_snapshot_current(
    app: &tauri::AppHandle,
    account: &LocalAccount,
) -> Result<(), String> {
    let config = load_accounts_config(app)?;
    let current = config
        .accounts
        .iter()
        .find(|item| item.id == account.id)
        .ok_or_else(|| "account not found".to_string())?;
    if account_config_cache_fingerprint(current) != account_config_cache_fingerprint(account) {
        return Err("账号配置已变化，已阻止使用旧账号快照创建新的交易执行".to_string());
    }
    ensure_local_okx_account_identity_unambiguous(&config, current)?;
    Ok(())
}

async fn cached_okx_account_config(
    runtime: &MarketRuntime,
    account: &LocalAccount,
) -> Result<(OkxAccountConfig, bool), String> {
    let key = account_config_cache_key(account);
    let fingerprint = account_config_cache_fingerprint(account);
    let now = now_ms();
    if let Ok(cache) = runtime.account_config_cache.lock() {
        if let Some(entry) = cache.get(&key) {
            if entry.fingerprint == fingerprint
                && now.saturating_sub(entry.updated_at) <= OKX_ACCOUNT_CONFIG_CACHE_TTL_MS
            {
                return Ok((entry.config.clone(), true));
            }
        }
    }
    let config = okx_private_get::<OkxAccountConfig>(account, "/api/v5/account/config")
        .await?
        .data
        .into_iter()
        .next()
        .ok_or_else(|| "OKX 账户配置为空".to_string())?;
    if let Ok(mut cache) = runtime.account_config_cache.lock() {
        cache.insert(
            key,
            CachedAccountConfig {
                fingerprint,
                config: config.clone(),
                updated_at: now_ms(),
            },
        );
    }
    Ok((config, false))
}

async fn okx_private_post<T, B>(
    account: &LocalAccount,
    path: &str,
    body: &B,
) -> Result<OkxEnvelope<T>, String>
where
    T: for<'de> Deserialize<'de>,
    B: Serialize,
{
    let url = format!("{}{}", REST_BASE, path);
    let body_text = serde_json::to_string(body).map_err(|err| err.to_string())?;
    let client = reqwest_client()?;
    for timestamp_attempt in 0..=1 {
        let observed_generation = OKX_CLOCK_SYNC_GENERATION.load(Ordering::Acquire);
        let timestamp = okx_rest_timestamp()?;
        let headers = okx_private_headers(account, &timestamp, "POST", path, &body_text)?;
        let response = client
            .post(&url)
            .headers(headers)
            .body(body_text.clone())
            .send()
            .await
            .map_err(|err| classify_reqwest_error("OKX Private REST", path, &err))?;
        let status = response.status();
        let response_body = response
            .text()
            .await
            .map_err(|err| classify_reqwest_error("OKX Private REST body", path, &err))?;
        if timestamp_attempt == 0 && okx_timestamp_error(&response_body) {
            // A 50102 response is rejected during authentication, before the write is accepted.
            resync_okx_clock_after_timestamp_error("okx_private_post", path, observed_generation)
                .await?;
            continue;
        }
        if !status.is_success() {
            return Err(okx_private_http_error(
                "okx_private_post",
                path,
                status,
                &response_body,
                account,
            ));
        }
        let envelope = serde_json::from_str::<OkxEnvelope<T>>(&response_body)
            .map_err(|err| format!("OKX private decode failed({}): {}", path, err))?;
        if envelope.code != "0" && envelope.data.is_empty() {
            let message = sanitize_secret(&envelope.msg, &account.api_key);
            return Err(classified_okx_error(
                "okx_private_post",
                path,
                &envelope.code,
                &message,
            ));
        }
        return Ok(envelope);
    }
    unreachable!("OKX private POST timestamp retry loop must return")
}

fn account_position_mode_switch_error(cause: &str) -> String {
    format!(
        "{ACCOUNT_POSITION_MODE_SWITCH_FAILED_PREFIX}账号当前为单向持仓模式，自动切换到双向持仓模式失败。请先平掉所有未平仓位并撤销未完成委托，再在 OKX 中切换为双向持仓模式；否则策略 Profile 和 AI 自动化 Profile 不可启用。原因：{cause} / The account is currently in net position mode, but the automatic switch to long/short mode failed. Close all open positions and cancel all pending orders, then switch the account to long/short mode in OKX; otherwise Strategy Profiles and AI Automation Profiles cannot be enabled. Cause: {cause}"
    )
}

fn emit_account_position_mode_switch_failed(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    cause: &str,
) {
    let message = format!(
        "账号当前为单向持仓模式，自动切换到双向持仓模式失败。请先平掉所有未平仓位并撤销未完成委托，再在 OKX 中切换为双向持仓模式，否则策略 Profile 和 AI 自动化 Profile 不可启用。"
    );
    let _ = app.emit(
        ACCOUNT_POSITION_MODE_SWITCH_FAILED_EVENT,
        json!({
            "type": "accountPositionModeSwitchFailed",
            "message": message,
            "accountId": account.id,
            "profileName": account.name,
            "error": cause,
            "action": { "tab": "settings", "settingsTab": "account" },
        }),
    );
}

fn emit_account_position_mode_required(
    app: &tauri::AppHandle,
    account: &LocalAccount,
    cause: &str,
) {
    let _ = app.emit(
        ACCOUNT_POSITION_MODE_SWITCH_FAILED_EVENT,
        json!({
            "type": "accountPositionModeRequired",
            "message": "该账号当前为单向持仓模式，策略 Profile 和 AI 自动化 Profile 无法启用。请先在 OKX 中切换为双向持仓模式。",
            "accountId": account.id,
            "profileName": account.name,
            "error": cause,
            "action": { "tab": "settings", "settingsTab": "account" },
        }),
    );
}

/// Ensures the account is in OKX hedge mode before any feature that requires
/// independent long and short positions is enabled. OKX only allows this
/// account-level change when there are no open positions or pending orders.
pub(crate) async fn ensure_okx_long_short_mode(
    app: &tauri::AppHandle,
    account: &LocalAccount,
) -> Result<(), String> {
    if account.exchange.to_lowercase() != "okx" {
        return Err("unsupported exchange".to_string());
    }
    let config = match okx_private_get::<OkxAccountConfig>(account, "/api/v5/account/config")
        .await
    {
        Ok(envelope) => envelope
            .data
            .into_iter()
            .next()
            .ok_or_else(|| "OKX 账户配置为空".to_string())?,
        Err(error) => return Err(error),
    };
    match config.pos_mode.trim() {
        "long_short_mode" => {
            if let Some(runtime) = app.try_state::<MarketRuntime>() {
                if let Ok(mut cache) = runtime.account_config_cache.lock() {
                    cache.remove(&account_config_cache_key(account));
                }
            }
            return Ok(())
        }
        "net_mode" => {}
        other => {
            let cause = format!("OKX 返回了不支持的持仓模式：{other}");
            emit_account_position_mode_switch_failed(app, account, &cause);
            return Err(account_position_mode_switch_error(&cause));
        }
    }
    if !account.permissions.trade {
        let cause = "API Key 没有交易权限，无法调用持仓模式切换接口 / the API key has no trade permission";
        emit_account_position_mode_switch_failed(app, account, cause);
        return Err(account_position_mode_switch_error(cause));
    }
    let request = json!({ "posMode": "long_short_mode" });
    if let Err(error) = okx_private_post::<Value, _>(
        account,
        "/api/v5/account/set-position-mode",
        &request,
    )
    .await
    {
        emit_account_position_mode_switch_failed(app, account, &error);
        return Err(account_position_mode_switch_error(&error));
    }
    let verified = match okx_private_get::<OkxAccountConfig>(account, "/api/v5/account/config")
        .await
    {
        Ok(envelope) => envelope
            .data
            .into_iter()
            .next()
            .ok_or_else(|| "OKX 账户配置为空".to_string())?,
        Err(error) => {
            emit_account_position_mode_switch_failed(app, account, &error);
            return Err(account_position_mode_switch_error(&error));
        }
    };
    if verified.pos_mode.trim() != "long_short_mode" {
        let cause = format!(
            "切换接口已返回，但重新读取到账户模式仍为 {} / the verified position mode is still {}",
            verified.pos_mode, verified.pos_mode
        );
        emit_account_position_mode_switch_failed(app, account, &cause);
        return Err(account_position_mode_switch_error(&cause));
    }
    if let Some(runtime) = app.try_state::<MarketRuntime>() {
        if let Ok(mut cache) = runtime.account_config_cache.lock() {
            cache.remove(&account_config_cache_key(account));
        }
    }
    Ok(())
}

/// Verifies the mode at an activation boundary without changing the account.
/// Account setup owns the automatic switch; enabling a Profile must fail
/// closed if the account has since been returned to one-way mode.
pub(crate) async fn require_okx_long_short_mode(
    app: &tauri::AppHandle,
    account: &LocalAccount,
) -> Result<(), String> {
    let config = okx_private_get::<OkxAccountConfig>(account, "/api/v5/account/config")
        .await?
        .data
        .into_iter()
        .next()
        .ok_or_else(|| "OKX 账户配置为空".to_string())?;
    if config.pos_mode.trim() == "long_short_mode" {
        if let Some(runtime) = app.try_state::<MarketRuntime>() {
            if let Ok(mut cache) = runtime.account_config_cache.lock() {
                cache.remove(&account_config_cache_key(account));
            }
        }
        return Ok(());
    }
    let cause = if config.pos_mode.trim() == "net_mode" {
        "账号仍为单向持仓模式，已阻止启用 Profile / the account is still in net position mode, so Profile activation was blocked"
    } else {
        "OKX 返回了不支持的持仓模式 / OKX returned an unsupported position mode"
    };
    emit_account_position_mode_required(app, account, cause);
    Err(account_position_mode_switch_error(cause))
}

/*
async fn fetch_instrument(inst_id: &str) -> Result<OkxInstrument, String> {
    let path = format!(
        "/api/v5/public/instruments?instType=SWAP&instId={}",
        url_encode(inst_id)
    );
    let envelope: OkxEnvelope<OkxInstrument> = get_json(&path).await?;
    envelope
        .data
        .into_iter()
        .next()
        .ok_or_else(|| format!("未找到合约规则：{}", inst_id))
}

fn available_balance_value(balance: &OkxBalance) -> Option<f64> {
    parse_optional_f64(&balance.avail_eq)
        .or_else(|| parse_optional_f64(&balance.avail_bal))
        .or_else(|| parse_optional_f64(&balance.cash_bal))
}

fn position_available(positions: &[OkxPosition], inst_id: &str, side: &str) -> Option<f64> {
    let total = positions
        .iter()
        .filter(|position| position.inst_id == inst_id && position.pos_side.eq_ignore_ascii_case(side))
        .filter_map(|position| parse_optional_f64(&position.pos))
        .filter(|value| *value > 0.0)
        .sum::<f64>();
    if total > 0.0 { Some(total) } else { None }
}

fn leverage_info_path(inst_id: &str, mgn_mode: &str) -> String {
    format!(
        "/api/v5/account/leverage-info?instId={}&mgnMode={}",
        url_encode(inst_id),
        url_encode(mgn_mode)
    )
}

fn leverage_pos_sides(pos_mode: &str, requested: Option<&str>) -> Vec<Option<String>> {
    if let Some(pos_side) = requested.filter(|value| !value.trim().is_empty()) {
        return vec![Some(pos_side.trim().to_string())];
    }
    if pos_mode == "long_short_mode" {
        return vec![Some("long".to_string()), Some("short".to_string())];
    }
    vec![None]
}

fn leverage_rows_match(rows: &[OkxLeverageInfo], selected_lever: f64, pos_mode: Option<&str>) -> bool {
    if rows.is_empty() {
        return true;
    }
    let required = if pos_mode == Some("long_short_mode") {
        vec!["long", "short"]
    } else {
        vec!["net"]
    };
    required.iter().all(|side| {
        rows.iter()
            .filter(|row| {
                if *side == "net" {
                    row.pos_side.trim().is_empty() || row.pos_side.eq_ignore_ascii_case("net")
                } else {
                    row.pos_side.eq_ignore_ascii_case(side)
                }
            })
            .any(|row| parse_optional_f64(&row.lever).is_some_and(|lever| (lever - selected_lever).abs() < 1e-8))
    })
}

fn format_leverage_rows(rows: &[OkxLeverageInfo]) -> String {
    if rows.is_empty() {
        return "--".to_string();
    }
    rows.iter()
        .map(|row| {
            let side = if row.pos_side.trim().is_empty() {
                "net"
            } else {
                row.pos_side.as_str()
            };
            format!("{} {}X", side, row.lever)
        })
        .collect::<Vec<_>>()
        .join(" / ")
}

fn select_position_tier(tiers: &[OkxPositionTier], size: f64) -> Option<&OkxPositionTier> {
    tiers
        .iter()
        .filter(|tier| {
            let min = parse_optional_f64(&tier.min_sz).unwrap_or(0.0);
            let max = parse_optional_f64(&tier.max_sz).unwrap_or(f64::MAX);
            size >= min && size <= max
        })
        .min_by(|left, right| {
            let left_tier = parse_optional_f64(&left.tier).unwrap_or(f64::MAX);
            let right_tier = parse_optional_f64(&right.tier).unwrap_or(f64::MAX);
            left_tier.partial_cmp(&right_tier).unwrap_or(std::cmp::Ordering::Equal)
        })
}

fn estimated_margin_candidate(notional: f64, lever: Option<f64>) -> Option<f64> {
    let lever = lever?;
    if lever > 0.0 { Some(notional / lever) } else { None }
}

async fn ensure_trade_account(account: &LocalAccount, environment: &str) -> Result<(), String> {
    if account.exchange.to_lowercase() != "okx" {
        return Err(format!("不支持的交易所：{}", account.exchange));
    }
    if normalize_environment(&account.environment) != normalize_environment(environment) {
        return Err("账号环境与当前交易环境不一致".to_string());
    }
    if !account.permissions.trade {
        return Err("账号未开启交易权限".to_string());
    }
    let config = okx_private_get::<OkxAccountConfig>(account, "/api/v5/account/config")
        .await?
        .data
        .into_iter()
        .next()
        .ok_or_else(|| "OKX 账户配置为空".to_string())?;
    if !config.perm.split(',').any(|perm| perm.trim() == "trade") {
        return Err("OKX API Key 未包含 trade 权限".to_string());
    }
    Ok(())
}
*/

fn order_direction(
    action: &str,
    pos_mode: &str,
) -> Result<(String, Option<String>, Option<bool>), String> {
    let (side, long_short_pos_side, close) = match action {
        "long" => ("buy", "long", false),
        "short" => ("sell", "short", false),
        "close-long" => ("sell", "long", true),
        "close-short" => ("buy", "short", true),
        _ => return Err("交易方向无效".to_string()),
    };
    if pos_mode == "long_short_mode" {
        return Ok((
            side.to_string(),
            Some(long_short_pos_side.to_string()),
            None,
        ));
    }
    Ok((
        side.to_string(),
        None,
        if close { Some(true) } else { None },
    ))
}

fn parse_optional_f64(value: &str) -> Option<f64> {
    let numeric = value.trim().parse::<f64>().ok()?;
    if numeric.is_finite() {
        Some(numeric)
    } else {
        None
    }
}

fn okx_position_used_margin(position: &OkxPosition, notional: f64, leverage: f64) -> Option<f64> {
    let positive = |value: &str| parse_optional_f64(value).filter(|number| *number > 0.0);
    // OKX reports isolated margin in `margin`, but cross positions use their initial
    // margin requirement in `imr`.
    let reported = if position.mgn_mode.eq_ignore_ascii_case("isolated") {
        positive(&position.margin).or_else(|| positive(&position.imr))
    } else {
        positive(&position.imr).or_else(|| positive(&position.margin))
    };
    reported.or_else(|| {
        let notional = (notional.is_finite() && notional > 0.0).then_some(notional)?;
        let leverage = (leverage.is_finite() && leverage > 0.0).then_some(leverage)?;
        let estimated = notional / leverage;
        estimated.is_finite().then_some(estimated).filter(|number| *number > 0.0)
    })
}

fn is_multiple_of(value: f64, step: f64) -> bool {
    if step <= 0.0 {
        return true;
    }
    let quotient = value / step;
    (quotient - quotient.round()).abs() < 1e-8
}

fn round_down_step(value: f64, step: f64) -> String {
    if step <= 0.0 {
        return trim_float(value);
    }
    trim_float((value / step).floor() * step)
}

fn trim_float(value: f64) -> String {
    if !value.is_finite() {
        return "0".to_string();
    }
    let compact = value.to_string();
    let expanded = match compact.find(|character| character == 'e' || character == 'E') {
        Some(exponent_index) => expand_scientific_float(&compact, exponent_index),
        None => compact,
    };
    // Preserve normal exchange decimals verbatim, but hide long binary tails
    // produced by arithmetic such as `0.1 + 0.2`.
    if expanded
        .split_once('.')
        .is_some_and(|(_, fraction)| fraction.len() > 15)
    {
        trim_fixed_decimal(format!("{value:.12}"))
    } else {
        expanded
    }
}

fn expand_scientific_float(compact: &str, exponent_index: usize) -> String {
    let (mantissa, exponent) = compact.split_at(exponent_index);
    let exponent = exponent[1..].parse::<i32>().unwrap_or_default();
    let (negative, mantissa) = mantissa
        .strip_prefix('-')
        .map(|value| (true, value))
        .unwrap_or((false, mantissa));
    let mut parts = mantissa.split('.');
    let integer = parts.next().unwrap_or_default();
    let fraction = parts.next().unwrap_or_default();
    if parts.next().is_some()
        || integer.is_empty()
        || !integer.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return compact.to_string();
    }
    let digits = format!("{integer}{fraction}");
    let decimal_index = integer.len() as i32 + exponent;
    let expanded = if decimal_index <= 0 {
        format!("0.{}{}", "0".repeat((-decimal_index) as usize), digits)
    } else if decimal_index as usize >= digits.len() {
        format!("{}{}", digits, "0".repeat(decimal_index as usize - digits.len()))
    } else {
        let index = decimal_index as usize;
        format!("{}.{}", &digits[..index], &digits[index..])
    };
    let expanded = trim_fixed_decimal(expanded);
    if negative && expanded != "0" {
        format!("-{expanded}")
    } else {
        expanded
    }
}

fn trim_fixed_decimal(mut text: String) -> String {
    if text.contains('.') {
        while text.ends_with('0') {
            text.pop();
        }
        if text.ends_with('.') {
            text.pop();
        }
    }
    if text.is_empty() || text == "-0" {
        "0".to_string()
    } else {
        text
    }
}

fn url_encode(value: &str) -> String {
    value.replace(' ', "%20")
}

fn deserialize_i64_from_string<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    value.parse::<i64>().map_err(serde::de::Error::custom)
}

fn deserialize_i64_from_string_or_default<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(match value {
        serde_json::Value::String(text) => text.parse::<i64>().unwrap_or_default(),
        serde_json::Value::Number(number) => number.as_i64().unwrap_or_default(),
        _ => 0,
    })
}

fn deserialize_string_from_value_or_default<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(match value {
        serde_json::Value::String(text) => text,
        serde_json::Value::Number(number) => number.to_string(),
        serde_json::Value::Bool(flag) => flag.to_string(),
        serde_json::Value::Null => String::new(),
        _ => String::new(),
    })
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

fn load_local_account_secret(
    app: &tauri::AppHandle,
    account_id: Option<&str>,
) -> Result<LocalAccount, String> {
    let parsed = load_accounts_config(app)?;
    let mut accounts = parsed
        .accounts
        .into_iter()
        .filter(|account| account.exchange.eq_ignore_ascii_case("okx"));
    if let Some(id) = normalize_account_id_option(account_id) {
        return accounts
            .find(|account| account.id == id)
            .ok_or_else(|| format!("account {} not found", id));
    }
    accounts
        .next()
        .ok_or_else(|| "no OKX account configured".to_string())
}

fn normalize_account_id_option(account_id: Option<&str>) -> Option<&str> {
    account_id
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("default"))
}

fn instrument_summary_from(
    instrument: OkxInstrument,
    icon_path: Option<String>,
    icon_cached: bool,
    updated_at: i64,
) -> OkxInstrumentSummary {
    OkxInstrumentSummary {
        inst_id: instrument.inst_id,
        inst_id_code: instrument.inst_id_code,
        inst_type: instrument.inst_type,
        inst_family: instrument.inst_family,
        base_ccy: instrument.base_ccy,
        quote_ccy: instrument.quote_ccy,
        settle_ccy: instrument.settle_ccy,
        ct_val: instrument.ct_val,
        ct_val_ccy: instrument.ct_val_ccy,
        ct_type: instrument.ct_type,
        tick_sz: instrument.tick_sz,
        lot_sz: instrument.lot_sz,
        min_sz: instrument.min_sz,
        max_lmt_sz: instrument.max_lmt_sz,
        max_mkt_sz: instrument.max_mkt_sz,
        lever: instrument.lever,
        state: instrument.state,
        icon_path,
        icon_cached,
        updated_at,
    }
}

fn instrument_from_summary(summary: OkxInstrumentSummary) -> OkxInstrument {
    OkxInstrument {
        inst_id: summary.inst_id,
        inst_id_code: summary.inst_id_code,
        inst_type: summary.inst_type,
        inst_family: summary.inst_family,
        base_ccy: summary.base_ccy,
        quote_ccy: summary.quote_ccy,
        settle_ccy: summary.settle_ccy,
        ct_val: summary.ct_val,
        ct_val_ccy: summary.ct_val_ccy,
        ct_type: summary.ct_type,
        tick_sz: summary.tick_sz,
        lot_sz: summary.lot_sz,
        min_sz: summary.min_sz,
        max_lmt_sz: summary.max_lmt_sz,
        max_mkt_sz: summary.max_mkt_sz,
        max_lmt_amt: String::new(),
        lever: summary.lever,
        state: summary.state,
    }
}

fn load_market_assets_summary(
    app: &tauri::AppHandle,
) -> Result<Option<MarketAssetsSummary>, String> {
    let index_path = market_assets_cache_dir(app)?.join("swap-instruments.json");
    if !index_path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&index_path).map_err(|err| err.to_string())?;
    let mut summary =
        serde_json::from_str::<MarketAssetsSummary>(&content).map_err(|err| err.to_string())?;
    if summary.cache_version < MARKET_ASSETS_CACHE_VERSION {
        summary.cache_version = MARKET_ASSETS_CACHE_VERSION;
    }
    Ok(Some(summary))
}

fn empty_market_assets_summary(cache_dir: &PathBuf, updated_at: i64) -> MarketAssetsSummary {
    MarketAssetsSummary {
        cache_version: MARKET_ASSETS_CACHE_VERSION,
        instruments: Vec::new(),
        total: 0,
        icon_cached: 0,
        icon_failed: 0,
        icon_failed_bases: Vec::new(),
        icon_retry_after: None,
        cache_dir: cache_dir.to_string_lossy().to_string(),
        updated_at,
    }
}

fn write_market_assets_summary(
    app: &tauri::AppHandle,
    summary: &MarketAssetsSummary,
) -> Result<(), String> {
    let index_path = market_assets_cache_dir(app)?.join("swap-instruments.json");
    let bytes = serde_json::to_vec_pretty(summary).map_err(|err| err.to_string())?;
    fs::write(index_path, bytes).map_err(|err| err.to_string())
}

fn upsert_cached_instruments(
    app: &tauri::AppHandle,
    instruments: Vec<OkxInstrument>,
) -> Result<(), String> {
    if instruments.is_empty() {
        return Ok(());
    }
    let updated_at = now_ms();
    let cache_dir = market_assets_cache_dir(app)?;
    let icon_dir = cache_dir.join("icons");
    fs::create_dir_all(&icon_dir).map_err(|err| err.to_string())?;
    let mut summary = load_market_assets_summary(app)?
        .unwrap_or_else(|| empty_market_assets_summary(&cache_dir, updated_at));
    for instrument in instruments {
        let base = instrument_base_ccy(&instrument);
        let icon_path = if base.is_empty() {
            None
        } else {
            Some(
                icon_dir
                    .join(format!("{}.png", base))
                    .to_string_lossy()
                    .to_string(),
            )
        };
        let icon_cached = icon_path
            .as_ref()
            .is_some_and(|path| PathBuf::from(path).exists());
        let item = instrument_summary_from(instrument, icon_path, icon_cached, updated_at);
        if let Some(existing) = summary
            .instruments
            .iter_mut()
            .find(|existing| existing.inst_id.eq_ignore_ascii_case(&item.inst_id))
        {
            *existing = item;
        } else {
            summary.instruments.push(item);
        }
    }
    summary
        .instruments
        .sort_by(|left, right| left.inst_id.cmp(&right.inst_id));
    summary.total = summary.instruments.len();
    summary.icon_cached = summary
        .instruments
        .iter()
        .filter(|item| item.icon_cached)
        .count();
    summary.icon_failed = summary.icon_failed_bases.len();
    summary.cache_version = MARKET_ASSETS_CACHE_VERSION;
    summary.updated_at = updated_at;
    write_market_assets_summary(app, &summary)
}

fn instrument_base_ccy(instrument: &OkxInstrument) -> String {
    if !instrument.base_ccy.trim().is_empty() {
        return instrument.base_ccy.trim().to_ascii_lowercase();
    }
    instrument
        .inst_id
        .split('-')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

fn market_assets_cache_dir(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = runtime_cache_root().join("market-assets");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn normalize_market_icon_base(base: &str) -> Result<String, String> {
    let normalized = base.trim().to_ascii_lowercase();
    if normalized.is_empty()
        || normalized.len() > 32
        || !normalized
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err("币种代码无效，无法缓存图标".to_string());
    }
    Ok(normalized)
}

fn mark_market_icon_cached(
    app: &tauri::AppHandle,
    base: &str,
    icon_path: &PathBuf,
) -> Result<(), String> {
    let Some(mut summary) = load_market_assets_summary(app)? else {
        return Ok(());
    };
    let icon_path = icon_path.to_string_lossy().to_string();
    for instrument in &mut summary.instruments {
        let instrument_base = if instrument.base_ccy.trim().is_empty() {
            instrument.inst_id.split('-').next().unwrap_or_default()
        } else {
            instrument.base_ccy.as_str()
        };
        if instrument_base.eq_ignore_ascii_case(base) {
            instrument.icon_path = Some(icon_path.clone());
            instrument.icon_cached = true;
        }
    }
    summary
        .icon_failed_bases
        .retain(|failed| !failed.eq_ignore_ascii_case(base));
    summary.icon_cached = summary
        .instruments
        .iter()
        .filter(|instrument| instrument.icon_cached)
        .count();
    summary.icon_failed = summary.icon_failed_bases.len();
    if summary.icon_failed == 0 {
        summary.icon_retry_after = None;
    }
    summary.updated_at = now_ms();
    write_market_assets_summary(app, &summary)
}

async fn download_market_icon(
    client: &reqwest::Client,
    base: &str,
    path: &PathBuf,
) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    let url = format!("{}/{}.png", OKX_ICON_BASE, base);
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(format!("icon {} HTTP {}", base, response.status()));
    }
    let bytes = response.bytes().await.map_err(|err| err.to_string())?;
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < PNG_SIGNATURE.len()
        || bytes.len() > 2 * 1024 * 1024
        || &bytes[..PNG_SIGNATURE.len()] != PNG_SIGNATURE
    {
        return Err(format!("icon {} did not return a valid PNG", base));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(path, bytes).map_err(|err| err.to_string())
}

async fn download_market_icon_with_retry(
    client: &reqwest::Client,
    base: &str,
    path: &PathBuf,
) -> Result<(), String> {
    let mut last_error = String::new();
    for delay_ms in [0_u64, 500, 1_500] {
        if delay_ms > 0 {
            sleep(Duration::from_millis(delay_ms)).await;
        }
        match download_market_icon(client, base, path).await {
            Ok(()) => return Ok(()),
            Err(err) => last_error = err,
        }
    }
    Err(last_error)
}

fn account_summary_from(account: LocalAccount) -> AccountSummary {
    AccountSummary {
        id: account.id,
        name: account.name,
        exchange: account.exchange,
        environment: account.environment,
        api_key_masked: mask_key(&account.api_key),
        permissions: account.permissions,
    }
}

fn validate_account(account: &LocalAccount) -> Result<(), String> {
    if account.api_key.trim().is_empty()
        || account.secret_key.trim().is_empty()
        || account.passphrase.trim().is_empty()
    {
        return Err("account missing apiKey, secretKey or passphrase".to_string());
    }
    if !matches!(account.environment.as_str(), "demo" | "live") {
        return Err("account environment must be demo or live".to_string());
    }
    Ok(())
}

fn normalize_environment(value: &str) -> String {
    if value.eq_ignore_ascii_case("demo") || value.eq_ignore_ascii_case("simulated") {
        "demo".to_string()
    } else {
        "live".to_string()
    }
}

fn normalize_candle(row: &[String]) -> Option<Candle> {
    Some(Candle {
        time: row.get(0)?.parse::<i64>().ok()? / 1000,
        open: row.get(1)?.parse::<f64>().ok()?,
        high: row.get(2)?.parse::<f64>().ok()?,
        low: row.get(3)?.parse::<f64>().ok()?,
        close: row.get(4)?.parse::<f64>().ok()?,
        volume: row.get(5)?.parse::<f64>().ok()?,
        confirm: row.get(8).map(|value| value == "1").unwrap_or(false),
    })
}

fn normalize_raw_candle(row: &[String]) -> Option<RawCandle> {
    Some(RawCandle {
        open_time_ms: row.get(0)?.parse::<i64>().ok()?,
        open: row.get(1)?.to_string(),
        high: row.get(2)?.to_string(),
        low: row.get(3)?.to_string(),
        close: row.get(4)?.to_string(),
        volume: row.get(5)?.to_string(),
        volume_ccy: row.get(6).cloned(),
        volume_quote: row.get(7).cloned(),
        confirm: row.get(8).map(|value| value == "1").unwrap_or(false),
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn mask_key(value: &str) -> String {
    if value.len() <= 8 {
        return "****".to_string();
    }
    format!("{}****{}", &value[..4], &value[value.len() - 4..])
}

fn sanitize_secret(value: &str, secret: &str) -> String {
    if secret.is_empty() {
        return value.to_string();
    }
    value.replace(secret, "[redacted]")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChartCsvExportResult {
    path: String,
    size_bytes: usize,
}

#[tauri::command]
async fn export_chart_csv(
    app: tauri::AppHandle,
    suggested_name: String,
    contents: String,
) -> Result<Option<ChartCsvExportResult>, String> {
    const MAX_EXPORT_BYTES: usize = 32 * 1024 * 1024;
    if contents.len() > MAX_EXPORT_BYTES {
        return Err("导出内容超过 32 MB 限制".to_string());
    }
    let safe_name = sanitize_filename(suggested_name.trim().trim_end_matches(".csv"));
    let file_name = format!(
        "{}.csv",
        if safe_name.is_empty() {
            "kline-data"
        } else {
            &safe_name
        }
    );
    tokio::task::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_title("导出 K 线数据")
            .set_file_name(file_name)
            .add_filter("CSV 表格", &["csv"])
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = match selected {
            FilePath::Path(path) => path,
            FilePath::Url(_) => return Err("当前平台返回了不支持的导出地址".to_string()),
        };
        let mut bytes = Vec::with_capacity(contents.len() + 3);
        bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
        bytes.extend_from_slice(contents.as_bytes());
        fs::write(&path, &bytes).map_err(|error| format!("保存 K 线 CSV 失败: {error}"))?;
        Ok(Some(ChartCsvExportResult {
            path: path.to_string_lossy().to_string(),
            size_bytes: bytes.len(),
        }))
    })
    .await
    .map_err(|error| format!("导出 K 线 CSV 任务失败: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(MarketRuntime::default())
        .manage(AiRuntime::default())
        .manage(DatabaseRuntime::default())
        .manage(KlineSyncRuntime::default())
        .manage(AiAutomationRuntime::default())
        .manage(IntelligenceRuntime::default())
        .manage(SystematicRuntime::default())
        .manage(AppUpdateRuntime::default())
        .setup(|app| {
            initialize_runtime_paths(app.handle()).map_err(std::io::Error::other)?;
            let splash = app
                .get_webview_window("splash")
                .ok_or_else(|| std::io::Error::other("splash window not found"))?;
            resize_window_to_work_area(&splash, AppWindowKind::Splash)
                .map_err(std::io::Error::other)?;
            splash.show().map_err(std::io::Error::other)?;
            let app_handle = app.handle().clone();
            let database_runtime = app.state::<DatabaseRuntime>().inner().clone();
            tauri::async_runtime::spawn(async move {
                let database_app = app_handle.clone();
                let result =
                    tokio::task::spawn_blocking(move || initialize_database_v1(&database_app))
                        .await
                        .map_err(|error| format!("数据库初始化任务失败：{error}"))
                        .and_then(|result| result);
                database_runtime.complete(result.clone());
                match result {
                    Ok(()) => {
                        start_trade_execution_recovery(app_handle.clone());
                        instrument_operations::start_instrument_operation_recovery(
                            app_handle.clone(),
                        );
                        start_ai_automation_worker(app_handle.clone());
                        start_intelligence_collector(
                            app_handle.clone(),
                            app_handle.state::<IntelligenceRuntime>(),
                        );
                        start_systematic_worker(
                            app_handle.clone(),
                            app_handle.state::<SystematicRuntime>(),
                        );
                    }
                    Err(error) => eprintln!("startup database initialization failed: {error}"),
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ai_config_summary,
            ai_local_auth_status,
            ai_save_config,
            ai_test_connection,
            ai_automation_summary,
            ai_automation_overview,
            ai_automation_section,
            ai_token_usage_summary,
            ai_automation_run_statuses,
            ai_automation_run_detail,
            ai_automation_save_master_enabled,
            ai_agent_profile_save,
            ai_agent_profile_systematic_conflicts,
            ai_agent_profile_delete,
            ai_agent_scheme_save,
            ai_agent_scheme_delete,
            ai_agent_profile_run_now,
            ai_agent_profile_run_daily_review,
            ai_user_wake_condition_save,
            ai_user_wake_condition_delete,
            notification_settings_summary,
            notification_feishu_config_save,
            notification_feishu_test,
            ai_optimization_suggestion_update,
            ai_skill_version_publish,
            ai_skill_version_discard,
            frontend_log,
            export_diagnostics,
            export_chart_csv,
            migrate_sensitive_config,
            proxy_config_summary,
            save_proxy_config,
            test_proxy_config,
            load_watchlist_config,
            save_watchlist_config,
            ui_preferences_summary,
            save_ui_preferences,
            app_update_status,
            app_update_check,
            app_update_prepare,
            app_update_apply_source,
            app_update_restart_source,
            ai_create_session,
            ai_load_session,
            ai_list_sessions,
            ai_rename_session,
            ai_delete_session,
            ai_send_message,
            ai_generate_chart_indicator,
            ai_approve_tool,
            ai_stop,
            intelligence_summary,
            intelligence_sync_status,
            intelligence_sync_now,
            intelligence_mark_active_instrument,
            intelligence_news_query,
            intelligence_news_detail,
            intelligence_news_sources,
            intelligence_sentiment_query,
            intelligence_calendar_query,
            intelligence_derivatives_overview,
            intelligence_derivatives_positioning,
            intelligence_derivatives_taker_flow,
            intelligence_derivatives_crowding,
            intelligence_derivatives_funding_basis,
            intelligence_derivatives_liquidations,
            intelligence_derivatives_system_risk,
            intelligence_derivatives_position_tiers,
            intelligence_news_events_query,
            intelligence_news_feed,
            intelligence_news_read_state,
            intelligence_news_mark_read,
            intelligence_news_event_detail,
            intelligence_news_reaction_query,
            intelligence_anomalies_query,
            intelligence_briefings_query,
            intelligence_briefing_generate,
            intelligence_smart_query,
            intelligence_smart_traders_query,
            intelligence_smart_trader_detail,
            intelligence_smart_signals_query,
            intelligence_settings_summary,
            intelligence_settings_save,
            intelligence_track_trader,
            systematic_overview,
            systematic_capture_universe_snapshot,
            systematic_factor_create_default,
            systematic_factor_save,
            systematic_factor_evaluate,
            systematic_python_prepare_environment,
            systematic_python_run_sample,
            systematic_strategy_create_python,
            systematic_strategy_ai_send_message,
            systematic_strategy_ai_tool_respond,
            systematic_strategy_save_python,
            systematic_strategy_versions,
            systematic_strategy_version_detail,
            systematic_backtest_defaults,
            systematic_backtest_start,
            systematic_backtest_cancel,
            systematic_backtest_delete,
            systematic_backtest_detail,
            systematic_optimization_start,
            systematic_strategy_delete,
            systematic_profile_save,
            systematic_profile_delete,
            systematic_profile_set_enabled,
            systematic_profile_signals,
            okx_sync_time,
            okx_startup_network_probe,
            okx_public_ws_probe,
            okx_business_ws_probe,
            okx_private_ws_probe,
            okx_sync_market_assets,
            load_market_assets_cache,
            save_market_assets_cache,
            ensure_instruments_cache,
            okx_ticker,
            okx_candles,
            okx_funding_rate,
            init_local_storage,
            market_icon_data_url,
            ensure_market_icon_data_url,
            storage_maintenance,
            storage_status,
            local_candles,
            historical_candles_before,
            sync_kline_integrity,
            load_local_accounts,
            save_local_account,
            delete_local_account,
            test_local_account,
            okx_private_snapshot,
            okx_sync_private_history,
            private_history_status,
            rebuild_position_episodes,
            position_episodes,
            ai_automation_review_detail,
            historical_orders,
            historical_fills,
            account_bills,
            account_performance_summary,
            trade_audit_events,
            calculate_linear_usdt_perpetual,
            calculate_linear_usdt_risk_budget,
            account_bills_archive_status,
            import_account_bills_archive,
            okx_leverage_info,
            okx_set_leverage,
            okx_place_order,
            okx_trade_execution_guards,
            okx_reconcile_trade_execution_guards,
            okx_amend_order,
            okx_place_algo_order,
            okx_amend_algo_order,
            okx_cancel_algo_order,
            okx_list_algo_orders,
            okx_close_position,
            okx_cancel_order,
            okx_preview_cancel_instrument_orders,
            okx_execute_cancel_instrument_orders,
            okx_preview_flatten_instrument_positions,
            okx_execute_flatten_instrument_positions,
            okx_instrument_operation,
            okx_active_instrument_operations,
            trade_precheck,
            trade_opportunities,
            trade_opportunity_create,
            trade_opportunity_approve,
            trade_opportunity_reject,
            trade_opportunity_delete,
            trade_opportunities_clear,
            enter_main_window,
            window_action,
            open_chart_window,
            focus_chart_window,
            close_chart_window,
            list_chart_windows,
            update_chart_window_state,
            chart_workspaces_list,
            chart_workspace_load,
            chart_workspace_save,
            chart_workspace_delete,
            chart_workspace_views_list,
            chart_workspace_view_save,
            chart_workspace_view_delete,
            chart_drawings_list,
            chart_drawing_save,
            chart_drawing_delete,
            chart_alerts_list,
            chart_alert_save,
            chart_alert_delete,
            chart_alert_events_list,
            chart_dsl_evaluate,
            start_market_stream,
            stop_market_stream,
            register_market_consumer,
            unregister_market_consumer,
            reconcile_private_streams,
            market_snapshot
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    struct TemporarySqlitePath {
        path: PathBuf,
    }

    impl TemporarySqlitePath {
        fn new(label: &str) -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("read test clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "desic-terminal-{label}-{}-{nonce}.sqlite3",
                std::process::id()
            ));
            remove_temporary_sqlite_files(&path);
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TemporarySqlitePath {
        fn drop(&mut self) {
            remove_temporary_sqlite_files(&self.path);
        }
    }

    fn remove_temporary_sqlite_files(path: &Path) {
        for suffix in ["", "-wal", "-shm"] {
            let candidate = if suffix.is_empty() {
                path.to_path_buf()
            } else {
                PathBuf::from(format!("{}{}", path.display(), suffix))
            };
            let _ = fs::remove_file(candidate);
        }
    }

    #[test]
    fn sqlite_wal_allows_chart_reads_during_kline_write_transaction() {
        let database = TemporarySqlitePath::new("wal-read-write");
        let conn = Connection::open(database.path()).expect("open temporary sqlite");
        conn.busy_timeout(std::time::Duration::from_secs(2))
            .expect("configure sqlite busy timeout");
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             CREATE TABLE candles (
               symbol TEXT NOT NULL,
               interval TEXT NOT NULL,
               open_time INTEGER NOT NULL,
               close REAL NOT NULL,
               PRIMARY KEY(symbol, interval, open_time)
             );
             INSERT INTO candles(symbol, interval, open_time, close)
             VALUES('BTC-USDT-SWAP', '1m', 0, 100.0);",
        )
        .expect("initialize WAL test database");
        drop(conn);

        let writer_ready = Arc::new(std::sync::Barrier::new(2));
        let release_writer = Arc::new(std::sync::Barrier::new(2));
        let writer_path = database.path().to_path_buf();
        let writer_ready_for_thread = writer_ready.clone();
        let release_writer_for_thread = release_writer.clone();
        let writer = std::thread::spawn(move || {
            let conn = Connection::open(writer_path).expect("open WAL writer");
            conn.busy_timeout(std::time::Duration::from_secs(2))
                .expect("configure WAL writer timeout");
            conn.execute_batch("BEGIN IMMEDIATE")
                .expect("begin WAL write transaction");
            for index in 1..=2_000_i64 {
                conn.execute(
                    "INSERT INTO candles(symbol, interval, open_time, close) VALUES(?1, '1m', ?2, ?3)",
                    params!["BTC-USDT-SWAP", index * 60_000, 100.0 + index as f64],
                )
                .expect("insert WAL write row");
            }
            writer_ready_for_thread.wait();
            release_writer_for_thread.wait();
            conn.execute_batch("COMMIT")
                .expect("commit WAL write transaction");
        });

        writer_ready.wait();
        let reader = Connection::open_with_flags(
            database.path(),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .expect("open WAL chart reader");
        reader
            .busy_timeout(std::time::Duration::from_secs(2))
            .expect("configure WAL reader timeout");
        reader
            .pragma_update(None, "query_only", true)
            .expect("configure read-only chart query");
        for _ in 0..20 {
            let visible_rows = reader
                .query_row(
                    "SELECT COUNT(*) FROM candles WHERE symbol = 'BTC-USDT-SWAP' AND interval = '1m'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("read chart snapshot during WAL write");
            assert_eq!(visible_rows, 1, "uncommitted K-line rows must stay out of the chart snapshot");
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        drop(reader);
        release_writer.wait();
        writer.join().expect("join WAL writer");

        let conn = Connection::open(database.path()).expect("reopen WAL database");
        let total_rows = conn
            .query_row("SELECT COUNT(*) FROM candles", [], |row| row.get::<_, i64>(0))
            .expect("count committed WAL rows");
        assert_eq!(total_rows, 2_001);
    }

    #[test]
    #[ignore = "downloads one year of real OKX public 1m candles into a temporary database"]
    fn real_okx_btc_usdt_swap_one_minute_year_temp_db_benchmark() {
        let database = TemporarySqlitePath::new("okx-year-benchmark");
        let mut conn = Connection::open(database.path()).expect("open benchmark sqlite");
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .expect("configure benchmark sqlite timeout");
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
            .expect("configure benchmark WAL");
        migrate_database(&conn).expect("create benchmark schema");

        let symbol = "BTC-USDT-SWAP";
        let interval = "1m";
        let step = bar_ms(interval).expect("one-minute step");
        let now = now_ms();
        // Leave the latest two UTC days out because OKX can publish the most
        // recent daily archive with an eight-hour delay.
        let day_ms = 86_400_000;
        let today_start = utc_day_start_ms(now);
        let end_open = today_start
            .saturating_sub(2 * day_ms)
            .saturating_sub(step);
        let start_open = end_open
            .saturating_sub(365 * 86_400_000)
            .saturating_add(step);
        let expected = ((end_open - start_open) / step + 1) as usize;
        let network_started = Instant::now();
        let candles = tauri::async_runtime::block_on(async {
            let client = reqwest_client()?;
            let mut rows = HashMap::new();
            // OKX labels these daily archives in UTC+8, so the next label is
            // needed to cover the final eight UTC hours of the benchmark.
            let static_end = end_open.saturating_add(day_ms);
            let mut day = utc_day_start_ms(start_open);
            let mut days = 0usize;
            while day <= static_end {
                let daily = fetch_static_daily_candles_for_day(&client, symbol, day).await?;
                for raw in daily
                    .into_iter()
                    .filter(|raw| raw.open_time_ms >= start_open && raw.open_time_ms <= end_open)
                {
                    rows.insert(raw.open_time_ms, raw);
                }
                days += 1;
                if days % 30 == 0 {
                    eprintln!("OKX benchmark fetched {days} static days");
                }
                day = day.saturating_add(86_400_000);
            }
            let mut values = rows.into_values().collect::<Vec<_>>();
            values.sort_by_key(|raw| raw.open_time_ms);
            Ok::<_, String>(values)
        })
        .unwrap_or_else(|error| panic!("fetch real OKX benchmark data: {error}"));
        let network_ms = network_started.elapsed().as_millis();

        let reader_started = Arc::new(std::sync::Barrier::new(2));
        let reader_path = database.path().to_path_buf();
        let reader_started_for_thread = reader_started.clone();
        let reader = std::thread::spawn(move || -> Result<(usize, u128), String> {
            let reader = Connection::open_with_flags(
                reader_path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|error| error.to_string())?;
            reader
                .busy_timeout(std::time::Duration::from_secs(2))
                .map_err(|error| error.to_string())?;
            reader
                .pragma_update(None, "query_only", true)
                .map_err(|error| error.to_string())?;
            reader_started_for_thread.wait();
            let started = Instant::now();
            let mut samples = 0usize;
            let mut max_query_us = 0u128;
            while started.elapsed() < std::time::Duration::from_secs(1) {
                let query_started = Instant::now();
                reader
                    .query_row(
                        "SELECT COUNT(*) FROM candles WHERE symbol = 'BTC-USDT-SWAP' AND interval = '1m'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(|error| error.to_string())?;
                max_query_us = max_query_us.max(query_started.elapsed().as_micros());
                samples += 1;
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            Ok((samples, max_query_us))
        });
        reader_started.wait();
        let write_started = Instant::now();
        let inserted = upsert_raw_candles(&mut conn, symbol, interval, &candles, "benchmark")
            .expect("write real OKX benchmark data");
        let write_ms = write_started.elapsed().as_millis();
        let (reader_samples, reader_max_query_us) = reader
            .join()
            .expect("join benchmark chart reader")
            .expect("read benchmark database during write");
        let (stored, first_open, last_open) = conn
            .query_row(
                "SELECT COUNT(*), MIN(open_time), MAX(open_time)
                 FROM candles WHERE symbol = ?1 AND interval = ?2",
                params![symbol, interval],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                },
            )
            .expect("summarize benchmark database");
        eprintln!(
            "OKX temp DB benchmark: fetched={} expected={} inserted={} stored={} first={:?} last={:?} network_ms={} write_ms={} reader_samples={} reader_max_query_us={}",
            candles.len(),
            expected,
            inserted,
            stored,
            first_open,
            last_open,
            network_ms,
            write_ms,
            reader_samples,
            reader_max_query_us,
        );
        assert_eq!(candles.len(), expected, "real OKX year data contains gaps");
        assert_eq!(stored as usize, expected);
        assert_eq!(inserted, expected);
        assert_eq!(first_open, Some(start_open));
        assert_eq!(last_open, Some(end_open));
    }

    #[test]
    fn kline_sync_runtime_reserves_each_symbol_interval_once() {
        let runtime = KlineSyncRuntime::default();
        let symbols = vec!["BTC-USDT-SWAP".to_string(), "ETH-USDT-SWAP".to_string()];
        let intervals = vec!["1m".to_string(), "5m".to_string()];

        let first = tauri::async_runtime::block_on(runtime.reserve(&symbols, &intervals));
        assert_eq!(first.len(), 4);
        assert!(tauri::async_runtime::block_on(runtime.reserve(&symbols, &intervals)).is_empty());

        tauri::async_runtime::block_on(runtime.release(&first));
        assert_eq!(
            tauri::async_runtime::block_on(runtime.reserve(&symbols, &intervals)).len(),
            4
        );
    }

    #[test]
    fn window_sizes_fit_the_available_work_area() {
        let work_area = tauri::LogicalSize {
            width: 1024.0,
            height: 728.0,
        };
        let splash = fitted_window_size(AppWindowKind::Splash, Some(work_area));
        assert_eq!(splash.width, 1000.0);
        assert_eq!(splash.height, 580.0);

        let main = fitted_window_size(AppWindowKind::Main, Some(work_area));
        assert_eq!(main.width, 1024.0);
        assert_eq!(main.height, 728.0);

        let scaled_main = fitted_window_size(
            AppWindowKind::Main,
            Some(tauri::LogicalSize {
                width: 819.0,
                height: 582.0,
            }),
        );
        assert_eq!(scaled_main.width, 819.0);
        assert_eq!(scaled_main.height, 582.0);

        let desktop = fitted_window_size(
            AppWindowKind::Main,
            Some(tauri::LogicalSize {
                width: 1920.0,
                height: 1040.0,
            }),
        );
        assert_eq!(desktop.width, MAIN_WINDOW_WIDTH);
        assert_eq!(desktop.height, MAIN_WINDOW_HEIGHT);
    }

    #[test]
    fn market_icon_base_rejects_paths_and_accepts_currency_codes() {
        assert_eq!(normalize_market_icon_base(" BTC ").as_deref(), Ok("btc"));
        assert_eq!(normalize_market_icon_base("1INCH").as_deref(), Ok("1inch"));
        assert!(normalize_market_icon_base("../btc").is_err());
        assert!(normalize_market_icon_base("btc-usdt").is_err());
        assert!(normalize_market_icon_base("").is_err());
    }

    #[test]
    fn recent_candle_fallback_supports_all_chart_intervals() {
        for bar in [
            "1m", "3m", "5m", "15m", "30m", "1H", "2H", "4H", "6H", "12H", "1D",
        ] {
            let path = okx_recent_candles_path("BTC-USDT-SWAP", bar, 300)
                .unwrap_or_else(|error| panic!("build recent {bar} candle path: {error}"));
            assert!(path.contains(&format!("bar={bar}")));
        }
        let path = okx_recent_candles_path("BTC-USDT-SWAP", "30m", 500)
            .expect("build recent 30m candle path");
        assert_eq!(
            path,
            "/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=30m&limit=300"
        );
        assert!(okx_recent_candles_path("BTC-USDT-SWAP", "2H", 0)
            .expect("build recent 2H candle path")
            .ends_with("limit=1"));
        assert!(okx_recent_candles_path("BTC-USDT-SWAP", "7m", 300).is_err());
    }

    #[test]
    fn profile_position_margin_uses_okx_field_for_margin_mode() {
        let cross = OkxPosition {
            mgn_mode: "cross".to_string(),
            imr: "0.64489".to_string(),
            margin: "8".to_string(),
            ..Default::default()
        };
        let cross_margin = okx_position_used_margin(&cross, 100.0, 10.0).expect("cross margin");
        assert!((cross_margin - 0.64489).abs() < 1e-12);

        let isolated = OkxPosition {
            mgn_mode: "isolated".to_string(),
            imr: "0.64489".to_string(),
            margin: "8".to_string(),
            ..Default::default()
        };
        let isolated_margin = okx_position_used_margin(&isolated, 100.0, 10.0).expect("isolated margin");
        assert!((isolated_margin - 8.0).abs() < 1e-12);
    }

    fn position_fixture(inst_id: &str, pos_side: &str, pos: &str, pos_id: &str, u_time: &str) -> OkxPosition {
        OkxPosition {
            inst_id: inst_id.to_string(),
            inst_type: "SWAP".to_string(),
            pos_side: pos_side.to_string(),
            pos: pos.to_string(),
            pos_id: pos_id.to_string(),
            u_time: u_time.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn private_position_events_merge_deltas_without_dropping_unrelated_positions() {
        let btc = position_fixture("BTC-USDT-SWAP", "long", "2", "btc-1", "10");
        let eth = position_fixture("ETH-USDT-SWAP", "long", "3", "eth-1", "10");
        let mut snapshot = PrivateAccountSnapshot {
            account_id: "account".to_string(),
            environment: "live".to_string(),
            balances: Vec::new(),
            positions: vec![btc.clone(), eth],
            orders: Vec::new(),
            positions_complete: true,
            position_seq_id: Some(10),
            orders_complete: true,
            orders_error: None,
            synced_at: 1,
        };
        let btc_update = position_fixture("BTC-USDT-SWAP", "long", "4", "btc-1", "11");
        merge_private_position_delta(
            &mut snapshot,
            &[btc_update],
            PrivatePositionSequence {
                seq_id: Some(11),
                prev_seq_id: Some(10),
            },
        );
        assert_eq!(snapshot.positions.len(), 2);
        assert_eq!(
            snapshot
                .positions
                .iter()
                .find(|position| position.pos_id == "btc-1")
                .and_then(|position| position.pos.parse::<f64>().ok()),
            Some(4.0)
        );
        assert!(snapshot.positions.iter().any(|position| position.pos_id == "eth-1"));
        merge_private_position_delta(
            &mut snapshot,
            &[position_fixture("BTC-USDT-SWAP", "long", "0", "btc-1", "9")],
            PrivatePositionSequence::default(),
        );
        assert!(snapshot.positions.iter().any(|position| position.pos_id == "btc-1"));
    }

    #[test]
    fn private_position_sequence_gap_invalidates_the_snapshot_baseline() {
        let mut snapshot = PrivateAccountSnapshot {
            account_id: "account".to_string(),
            environment: "live".to_string(),
            balances: Vec::new(),
            positions: vec![position_fixture("BTC-USDT-SWAP", "long", "2", "btc-1", "10")],
            orders: Vec::new(),
            positions_complete: true,
            position_seq_id: Some(10),
            orders_complete: true,
            orders_error: None,
            synced_at: 1,
        };
        merge_private_position_delta(
            &mut snapshot,
            &[position_fixture("BTC-USDT-SWAP", "long", "5", "btc-1", "12")],
            PrivatePositionSequence {
                seq_id: Some(12),
                prev_seq_id: Some(11),
            },
        );
        assert!(!snapshot.positions_complete);
        assert_eq!(snapshot.positions[0].pos, "2");
    }

    #[test]
    fn profile_position_margin_falls_back_to_notional_and_leverage() {
        let position = OkxPosition {
            mgn_mode: "cross".to_string(),
            ..Default::default()
        };
        let margin = okx_position_used_margin(&position, 100.0, 10.0).expect("estimated margin");
        assert!((margin - 10.0).abs() < 1e-12);
        assert!(okx_position_used_margin(&position, 0.0, 10.0).is_none());
    }

    #[test]
    fn ai_session_list_keeps_user_and_automation_history_independent() {
        let conn = Connection::open_in_memory().expect("open test database");
        conn.execute_batch(
            "CREATE TABLE ai_sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );",
        )
        .expect("create ai_sessions");

        conn.execute(
            "INSERT INTO ai_sessions (id,title,status,created_at,updated_at) VALUES (?1,?2,'idle',1,1)",
            params!["session-user", "用户会话"],
        )
        .expect("insert user session");
        conn.execute(
            "INSERT INTO ai_sessions (id,title,status,created_at,updated_at) VALUES (?1,?2,'idle',2,200)",
            params!["review:daily", "自动复盘"],
        )
        .expect("insert review session");
        for index in 0..35 {
            conn.execute(
                "INSERT INTO ai_sessions (id,title,status,created_at,updated_at) VALUES (?1,?2,'idle',?3,?3)",
                params![format!("background:run-{index}"), format!("自动化 {index}"), 100 + index],
            )
            .expect("insert automation session");
        }

        let sessions = list_ai_sessions(&conn).expect("list ai sessions");
        let user_sessions = sessions
            .iter()
            .filter(|session| session.origin == AiSessionOrigin::User)
            .collect::<Vec<_>>();
        let automation_sessions = sessions
            .iter()
            .filter(|session| session.origin == AiSessionOrigin::Automation)
            .collect::<Vec<_>>();

        assert_eq!(user_sessions.len(), 1);
        assert_eq!(user_sessions[0].id, "session-user");
        assert_eq!(automation_sessions.len(), 30);
        assert!(automation_sessions
            .iter()
            .any(|session| session.id == "review:daily"));
        assert!(automation_sessions
            .iter()
            .all(|session| session.id.starts_with("background:")
                || session.id.starts_with("review:")));
    }

    #[test]
    fn ai_epoch_time_accepts_milliseconds_and_legacy_seconds() {
        assert_eq!(
            normalize_ai_epoch_millis(1_784_592_000_000),
            1_784_592_000_000
        );
        assert_eq!(normalize_ai_epoch_millis(1_784_592_000), 1_784_592_000_000);
    }

    #[test]
    fn okx_timestamp_expiry_is_classified_as_retryable_time_sync_error() {
        let (category, user_message, suggestion, retryable) =
            classify_okx_error("50102", "Timestamp request expired");

        assert_eq!(category, "time_sync");
        assert!(user_message.contains("时间戳"));
        assert!(suggestion.contains("自动重新校准"));
        assert!(retryable);
    }

    #[test]
    fn okx_timestamp_expiry_is_detected_in_http_error_body_without_data() {
        let body = r#"{"msg":"Timestamp request expired","code":"50102"}"#;

        assert!(okx_timestamp_error(body));
        assert_eq!(
            okx_error_fields(body),
            Some(("50102".to_string(), "Timestamp request expired".to_string()))
        );
        assert!(!okx_timestamp_error(
            r#"{"msg":"APIKey does not match current environment","code":"50101"}"#
        ));
    }

    #[test]
    fn orderbook_summary_supports_api_arrays_and_memory_objects() {
        let api_level = json!(["65083.6", "2171.96", "0", "37"]);
        let memory_level = json!({"px":"65083.6","sz":"2171.96","orders":"37"});
        assert_eq!(ai_book_level_text(Some(&api_level)), "65083.6 / 2171.96");
        assert_eq!(ai_book_level_text(Some(&memory_level)), "65083.6 / 2171.96");
        assert_eq!(
            ai_orderbook_snapshot_id("BTC-USDT-SWAP", 123, Some("456")),
            "BTC-USDT-SWAP:456"
        );
        assert_eq!(
            ai_orderbook_snapshot_id("BTC-USDT-SWAP", 123, None),
            "BTC-USDT-SWAP:123"
        );
    }

    #[test]
    fn ai_process_deltas_are_coalesced_until_an_event_boundary() {
        let mut events = Vec::new();
        append_ai_process_event(&mut events, "processReasoning", "价格");
        append_ai_process_event(&mut events, "processReasoning", "结构");
        events.push(json!({ "type": "toolCall", "name": "market.readCandles" }));
        append_ai_process_event(&mut events, "processReasoning", "完成");

        assert_eq!(events.len(), 3);
        assert_eq!(events[0]["content"], "价格结构");
        assert_eq!(events[2]["content"], "完成");
    }

    #[test]
    fn sidecar_agent_events_preserve_configured_profile_agent_id() {
        let start = cline_event_from_value(
            "background:run-test",
            &json!({
                "type": "agentStart",
                "sessionId": "background:run-test",
                "agentId": "runtime-agent-1",
                "configuredAgentId": "market-structure",
                "task": "分析市场结构"
            }),
        )
        .expect("parse agent start");
        match start {
            AiEvent::AgentStart {
                configured_agent_id,
                ..
            } => assert_eq!(configured_agent_id.as_deref(), Some("market-structure")),
            event => panic!("unexpected event: {event:?}"),
        }

        let done = cline_event_from_value(
            "background:run-test",
            &json!({
                "type": "agentDone",
                "sessionId": "background:run-test",
                "agentId": "runtime-agent-1",
                "configuredAgentId": "market-structure",
                "status": "done"
            }),
        )
        .expect("parse agent done");
        match done {
            AiEvent::AgentDone {
                configured_agent_id,
                ..
            } => assert_eq!(configured_agent_id.as_deref(), Some("market-structure")),
            event => panic!("unexpected event: {event:?}"),
        }

        let execute = cline_event_from_value(
            "background:run-test",
            &json!({
                "type": "toolExecuteRequest",
                "sessionId": "background:run-test",
                "executionId": "execution-1",
                "toolName": "market.readTicker",
                "agentRole": "subagent",
                "parentAgentId": "runtime-main",
                "configuredAgentId": "market-structure",
                "configuredAgentScopes": ["market", "derivatives"]
            }),
        )
        .expect("parse delegated tool request");
        match execute {
            AiEvent::ToolExecuteRequest {
                configured_agent_id,
                configured_agent_scopes,
                ..
            } => {
                assert_eq!(configured_agent_id.as_deref(), Some("market-structure"));
                assert_eq!(configured_agent_scopes, vec!["market", "derivatives"]);
            }
            event => panic!("unexpected event: {event:?}"),
        }
    }

    #[test]
    fn ai_tool_concurrency_only_allows_read_only_operations() {
        for tool in [
            "market.readTicker",
            "market.readCandles",
            "account.readOpenOrders",
            "intelligence.news.list",
            "trade.precheck",
            "strategy.readCurrentSource",
            "strategy.testCurrentSource",
        ] {
            assert!(ai_tool_allows_concurrent_execution(tool), "{tool}");
        }
        for tool in [
            "market.readDecisionContext",
            "trade.setLeverage",
            "tradeOpportunity.create",
            "background.finishRun",
        ] {
            assert!(!ai_tool_allows_concurrent_execution(tool), "{tool}");
        }
    }

    #[test]
    fn ai_stream_errors_are_persisted_as_failed_without_completed_finish() {
        let failed = ai_stream_terminal_state(false, false, true);
        assert_eq!(failed.message_status, "failed");
        assert_eq!(failed.session_status, "failed");
        assert_eq!(failed.synthetic_finish_reason, None);

        let completed = ai_stream_terminal_state(false, false, false);
        assert_eq!(completed.message_status, "done");
        assert_eq!(completed.synthetic_finish_reason, Some("completed"));
    }

    #[test]
    fn strategy_tool_failures_remain_recoverable_inside_the_same_ai_turn() {
        assert!(is_recoverable_strategy_ai_tool_error(
            "systematic-strategy-ai-1785937998401-flpk4s",
            "1 tool call(s) failed: [strategy_testCurrentSource] {\"error\":\"invalid source\"}",
        ));
        assert!(!is_recoverable_strategy_ai_tool_error(
            "user-session",
            "1 tool call(s) failed: [strategy_testCurrentSource] {\"error\":\"invalid source\"}",
        ));
        assert!(!is_recoverable_strategy_ai_tool_error(
            "systematic-strategy-ai-1785937998401-flpk4s",
            "provider connection failed",
        ));
    }

    #[test]
    fn private_order_marker_error_does_not_expose_implementation_details() {
        let (category, user_message, suggestion, retryable) =
            classify_okx_error("51000", "Parameter tag error");
        assert_eq!(category, "order_param");
        assert!(user_message.contains("来源标识"));
        assert!(!suggestion.to_ascii_lowercase().contains("tag"));
        assert!(!retryable);
    }

    #[test]
    fn trim_float_preserves_a_tick_aligned_decimal_without_binary_drift() {
        assert_eq!(trim_float(64_866.6), "64866.6");
        assert_eq!(trim_float(64_927.2), "64927.2");
        assert_eq!(trim_float(0.000_000_123_456_7), "0.0000001234567");
        assert_eq!(trim_float(0.1 + 0.2), "0.3");
    }

    #[test]
    fn insufficient_margin_overrides_a_generic_510_parameter_category() {
        let (category, _, _, retryable) = classify_okx_error(
            "51008",
            "Order failed. Insufficient USDT margin in account",
        );
        assert_eq!(category, "risk_or_balance");
        assert!(!retryable);
    }

    #[test]
    fn intelligence_parameter_errors_do_not_use_order_guidance() {
        let encoded = classified_okx_error(
            "okx_intelligence_get",
            "/api/v5/journal/smartmoney/overview",
            "51000",
            "ts is not supported",
        );
        let value: Value = serde_json::from_str(&encoded).expect("classified intelligence error");
        assert_eq!(value["category"], "intelligence_param");
        assert!(value["userMessage"]
            .as_str()
            .unwrap_or_default()
            .contains("市场情报"));
        assert!(!value["suggestion"]
            .as_str()
            .unwrap_or_default()
            .contains("最小下单量"));
    }

    #[derive(Clone)]
    struct TestFill<'a> {
        bill_id: &'a str,
        side: &'a str,
        pos_side: Option<&'a str>,
        sub_type: Option<&'a str>,
        px: &'a str,
        sz: &'a str,
        pnl: &'a str,
        fee: &'a str,
        operator: &'a str,
        strategy_id: Option<&'a str>,
        session_id: Option<&'a str>,
        ts: i64,
    }

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open test sqlite");
        migrate_database(&conn).expect("migrate test sqlite");
        conn
    }

    fn sqlite_object_exists(conn: &Connection, object_type: &str, name: &str) -> bool {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type=?1 AND name=?2)",
            params![object_type, name],
            |row| row.get::<_, bool>(0),
        )
        .expect("query sqlite object")
    }

    #[test]
    fn database_v1_initialization_is_idempotent_and_removes_unused_storage() {
        let conn = Connection::open_in_memory().expect("open v1 test sqlite");
        migrate_database(&conn).expect("create legacy base schema");
        conn.execute_batch(
            "CREATE TABLE intelligence_raw_responses(id TEXT PRIMARY KEY, body TEXT);
             CREATE INDEX idx_candles_query ON candles(symbol,interval,open_time);
             CREATE INDEX idx_candles_integrity ON candles(symbol,interval,confirm,open_time);",
        )
        .expect("create legacy storage objects");

        initialize_database_v1_with_conn(&conn).expect("initialize schema v1");
        assert_eq!(
            database_schema_version(&conn).expect("read schema version"),
            DATABASE_SCHEMA_VERSION
        );
        validate_database_v1(&conn).expect("validate schema v1");
        assert!(!sqlite_object_exists(
            &conn,
            "table",
            "intelligence_raw_responses"
        ));
        assert!(!sqlite_object_exists(&conn, "index", "idx_candles_query"));
        assert!(!sqlite_object_exists(
            &conn,
            "index",
            "idx_candles_integrity"
        ));

        conn.execute_batch(
            "CREATE TABLE intelligence_raw_responses(id TEXT PRIMARY KEY, body TEXT);
             CREATE INDEX idx_candles_query ON candles(symbol,interval,open_time);",
        )
        .expect("recreate obsolete objects after v1 marker");
        initialize_database_v1_with_conn(&conn).expect("repair marked schema v1");
        assert!(!sqlite_object_exists(
            &conn,
            "table",
            "intelligence_raw_responses"
        ));
        assert!(!sqlite_object_exists(&conn, "index", "idx_candles_query"));

        conn.execute(
            "ALTER TABLE ai_optimization_suggestions DROP COLUMN proposed_skill_json",
            [],
        )
        .expect("drop additive column to simulate an older v1 database");
        initialize_database_v1_with_conn(&conn).expect("repair additive v1 schema");
        assert!(table_has_column(
            &conn,
            "ai_optimization_suggestions",
            "proposed_skill_json"
        ));

        initialize_database_v1_with_conn(&conn).expect("reopen clean schema v1");
    }

    #[test]
    fn database_storage_scrub_removes_private_order_identity_from_existing_text() {
        let conn = Connection::open_in_memory().expect("open storage scrub sqlite");
        conn.execute_batch(
            "CREATE TABLE storage_probe (
               id INTEGER PRIMARY KEY,
               raw_json TEXT NOT NULL,
               note_json TEXT NOT NULL
             );",
        )
        .expect("create storage probe");
        let current = exchange_client_marker();
        let retired = retired_exchange_client_marker();
        conn.execute(
            "INSERT INTO storage_probe(id,raw_json,note_json) VALUES(1,?1,?2)",
            params![
                json!({
                    "instId": "BTC-USDT-SWAP",
                    "tag": current,
                    "nested": { "source": retired }
                })
                .to_string(),
                format!("before-{current}-after"),
            ],
        )
        .expect("insert storage probe");

        scrub_private_exchange_storage(&conn).expect("scrub private order identity");
        scrub_private_exchange_storage(&conn).expect("repeat storage scrub");

        let (raw_json, note) = conn
            .query_row(
                "SELECT raw_json,note_json FROM storage_probe WHERE id=1",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .expect("read scrubbed storage");
        let stored: Value = serde_json::from_str(&raw_json).expect("parse scrubbed json");
        assert_eq!(stored["instId"], "BTC-USDT-SWAP");
        assert!(stored.get("tag").is_none());
        assert!(!raw_json.contains(&current));
        assert!(!raw_json.contains(&retired));
        assert_eq!(note, "before--after");
        let migration_count = conn
            .query_row("SELECT COUNT(*) FROM local_data_migrations", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count storage migrations");
        assert_eq!(migration_count, 1);
    }

    #[test]
    fn database_v1_initialization_rejects_newer_or_incomplete_schemas() {
        let newer = Connection::open_in_memory().expect("open newer schema sqlite");
        newer
            .pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION + 1)
            .expect("set newer schema version");
        let newer_error = initialize_database_v1_with_conn(&newer)
            .expect_err("newer schema must not be downgraded");
        assert!(newer_error.contains("拒绝降级"), "{newer_error}");

        let incomplete = Connection::open_in_memory().expect("open incomplete schema sqlite");
        incomplete
            .pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION)
            .expect("set incomplete schema version");
        let incomplete_error = initialize_database_v1_with_conn(&incomplete)
            .expect_err("incomplete v1 schema must be rejected");
        assert!(
            incomplete_error.contains("缺少必要表"),
            "{incomplete_error}"
        );
    }

    fn insert_account_environment_trade_guard(
        conn: &Connection,
        execution_key: &str,
        account_id: &str,
        environment: &str,
        operation: &str,
        status: &str,
    ) {
        conn.execute(
            "INSERT INTO trade_execution_attempts (
               execution_key,account_id,environment,operation,client_order_id,status,
               request_json,created_at,updated_at
             ) VALUES (?1,?2,?3,?4,?1,?5,'{}',1,1)",
            params![execution_key, account_id, environment, operation, status],
        )
        .expect("insert account environment trade guard");
    }

    fn insert_account_environment_instrument_guard(
        conn: &Connection,
        operation_id: &str,
        account_id: &str,
        environment: &str,
        phase: &str,
    ) {
        conn.execute(
            "INSERT INTO instrument_operations (
               operation_id,preview_id,operation_kind,account_id,environment,inst_id,phase,
               counts_json,request_json,created_at,updated_at
             ) VALUES (?1,?1,'cancel_orders',?2,?3,'BTC-USDT-SWAP',?4,'{}','{}',1,1)",
            params![operation_id, account_id, environment, phase],
        )
        .expect("insert account environment instrument guard");
    }

    fn account_config_test_account(id: &str, name: &str, api_key: &str) -> LocalAccount {
        LocalAccount {
            id: id.to_string(),
            name: name.to_string(),
            exchange: "okx".to_string(),
            environment: "demo".to_string(),
            okx_uid: format!("placeholder-uid-{id}"),
            okx_main_uid: format!("placeholder-main-uid-{id}"),
            api_key: api_key.to_string(),
            secret_key: "placeholder-secret".to_string(),
            passphrase: "placeholder-passphrase".to_string(),
            permissions: Permissions {
                read: true,
                trade: true,
                withdraw: false,
            },
        }
    }

    #[test]
    fn account_environment_change_blocks_pending_trade_executions_in_any_environment() {
        let conn = test_conn();
        let operations = [
            "place_order",
            "amend_order",
            "place_algo_order",
            "amend_algo_order",
        ];
        let statuses = ["submitting", "reconciling", "unknown", "blocked"];

        for (operation_index, operation) in operations.iter().enumerate() {
            for (status_index, status) in statuses.iter().enumerate() {
                conn.execute("DELETE FROM trade_execution_attempts", [])
                    .expect("clear trade guards");
                let execution_key = format!("environment-guard-{operation_index}-{status_index}");
                insert_account_environment_trade_guard(
                    &conn,
                    &execution_key,
                    "account-environment-guard",
                    "demo",
                    operation,
                    status,
                );

                let error = ensure_account_environment_change_allowed_with_conn(
                    &conn,
                    "account-environment-guard",
                    "live",
                    "demo",
                )
                .expect_err("pending trade execution must block environment change");
                assert!(
                    error.contains("交易执行 1 条"),
                    "{operation}/{status}: {error}"
                );
                assert!(error.contains("从 live 自动切换为 demo"));
            }
        }
    }

    #[test]
    fn account_environment_change_blocks_accepted_trade_projections_awaiting_recovery() {
        let conn = test_conn();
        for (operation_index, operation) in
            ["place_algo_order", "amend_algo_order"].iter().enumerate()
        {
            for (projection_index, projection_status) in ["pending", "blocked"].iter().enumerate() {
                conn.execute("DELETE FROM trade_execution_attempts", [])
                    .expect("clear accepted projection guards");
                let execution_key =
                    format!("accepted-projection-guard-{operation_index}-{projection_index}");
                insert_account_environment_trade_guard(
                    &conn,
                    &execution_key,
                    "account-environment-guard",
                    "demo",
                    operation,
                    "accepted",
                );
                conn.execute(
                    "UPDATE trade_execution_attempts SET projection_status=?2
                     WHERE execution_key=?1",
                    params![execution_key, projection_status],
                )
                .expect("mark accepted projection awaiting recovery");

                let error = ensure_account_environment_change_allowed_with_conn(
                    &conn,
                    "account-environment-guard",
                    "live",
                    "demo",
                )
                .expect_err("accepted projection awaiting recovery must block environment change");
                assert!(
                    error.contains("交易执行 1 条"),
                    "{operation}/{projection_status}: {error}"
                );
            }
        }
    }

    #[test]
    fn account_environment_change_blocks_pending_instrument_operations_in_any_environment() {
        let conn = test_conn();
        for (index, phase) in ["submitting", "reconciling", "unknown"].iter().enumerate() {
            conn.execute("DELETE FROM instrument_operations", [])
                .expect("clear instrument guards");
            insert_account_environment_instrument_guard(
                &conn,
                &format!("instrument-environment-guard-{index}"),
                "account-environment-guard",
                "demo",
                phase,
            );

            let error = ensure_account_environment_change_allowed_with_conn(
                &conn,
                "account-environment-guard",
                "live",
                "demo",
            )
            .expect_err("pending instrument operation must block environment change");
            assert!(error.contains("当前合约紧急操作 1 条"), "{phase}: {error}");
        }
    }

    #[test]
    fn account_environment_change_ignores_terminal_other_account_and_equivalent_environment_rows() {
        let conn = test_conn();
        insert_account_environment_trade_guard(
            &conn,
            "terminal-trade-environment-guard",
            "account-environment-guard",
            "demo",
            "place_order",
            "accepted",
        );
        insert_account_environment_trade_guard(
            &conn,
            "other-account-trade-environment-guard",
            "other-account",
            "demo",
            "place_order",
            "unknown",
        );
        insert_account_environment_instrument_guard(
            &conn,
            "terminal-instrument-environment-guard",
            "account-environment-guard",
            "demo",
            "completed",
        );
        insert_account_environment_instrument_guard(
            &conn,
            "other-account-instrument-environment-guard",
            "other-account",
            "demo",
            "unknown",
        );

        ensure_account_environment_change_allowed_with_conn(
            &conn,
            "account-environment-guard",
            "live",
            "demo",
        )
        .expect("terminal and other-account rows must not block environment change");
        ensure_account_environment_change_allowed_with_conn(
            &conn,
            "other-account",
            "simulated",
            "demo",
        )
        .expect("equivalent normalized environment must not be checked");
    }

    #[test]
    fn account_identity_change_blocks_credentials_and_permissions_while_execution_is_unresolved() {
        let conn = test_conn();
        let current = account_config_test_account(
            "account-identity-guard",
            "Current name",
            "placeholder-api-key-current",
        );
        insert_account_environment_trade_guard(
            &conn,
            "identity-change-trade-guard",
            &current.id,
            "demo",
            "place_order",
            "unknown",
        );

        let mut renamed = current.clone();
        renamed.name = "Renamed only".to_string();
        ensure_account_identity_change_allowed_with_conn(&conn, &current, &renamed)
            .expect("display-name-only changes do not alter the execution identity");

        let mut credentials_changed = current.clone();
        credentials_changed.api_key = "placeholder-api-key-updated".to_string();
        let credential_error =
            ensure_account_identity_change_allowed_with_conn(&conn, &current, &credentials_changed)
                .expect_err("credential changes must be blocked while an execution is unresolved");
        assert!(credential_error.contains("禁止修改环境、凭据或交易权限"));

        let mut permissions_changed = current.clone();
        permissions_changed.permissions.trade = false;
        let permission_error =
            ensure_account_identity_change_allowed_with_conn(&conn, &current, &permissions_changed)
                .expect_err(
                    "trade permission changes must be blocked while an execution is unresolved",
                );
        assert!(permission_error.contains("交易执行 1 条"));

        conn.execute("DELETE FROM trade_execution_attempts", [])
            .expect("clear identity guards");
        ensure_account_identity_change_allowed_with_conn(&conn, &current, &credentials_changed)
            .expect("identity changes are allowed after every execution reaches a terminal state");
    }

    #[test]
    fn account_mutation_lease_blocks_identity_changes_and_uses_owner_cas() {
        assert!(ACCOUNT_MUTATION_LEASE_MS > 20_000);
        let conn = test_conn();
        let current = account_config_test_account(
            "account-write-lease-guard",
            "Lease guard",
            "placeholder-api-key-current",
        );
        let credential_fingerprint = account_config_cache_fingerprint(&current);
        let lease = AccountMutationLease {
            lease_id: "account-write-lease-placeholder".to_string(),
            account_id: current.id.clone(),
            credential_fingerprint: credential_fingerprint.clone(),
        };
        let now = now_ms();
        conn.execute(
            "INSERT INTO account_mutation_leases (
               lease_id,account_id,environment,credential_fingerprint,operation,
               lease_expires_at,created_at,updated_at
             ) VALUES (?1,?2,'demo',?3,'cancel_order',?4,?5,?5)",
            params![
                lease.lease_id,
                lease.account_id,
                credential_fingerprint,
                now + ACCOUNT_MUTATION_LEASE_MS,
                now,
            ],
        )
        .expect("insert active account mutation lease");

        let mut credentials_changed = current.clone();
        credentials_changed.api_key = "placeholder-api-key-updated".to_string();
        let error =
            ensure_account_identity_change_allowed_with_conn(&conn, &current, &credentials_changed)
                .expect_err("active account mutation must block identity changes");
        assert!(error.contains("账号写操作 1 条"), "{error}");
        let deletion_error = ensure_account_deletion_allowed_with_conn(&conn, &current.id)
            .expect_err("active account mutation must block deletion");
        assert!(
            deletion_error.contains("账号写操作 1 条"),
            "{deletion_error}"
        );

        let wrong_lease = AccountMutationLease {
            lease_id: "wrong-account-write-lease".to_string(),
            ..lease.clone()
        };
        assert!(
            !renew_account_mutation_lease_with_conn(&conn, &wrong_lease, now + 1)
                .expect("wrong owner renew")
        );
        assert!(
            renew_account_mutation_lease_with_conn(&conn, &lease, now + 1)
                .expect("current owner renew")
        );
        assert!(
            !finish_account_mutation_lease_with_conn(&conn, &wrong_lease)
                .expect("wrong owner finish")
        );
        assert!(
            finish_account_mutation_lease_with_conn(&conn, &lease).expect("current owner finish")
        );

        conn.execute(
            "INSERT INTO account_mutation_leases (
               lease_id,account_id,environment,credential_fingerprint,operation,
               lease_expires_at,created_at,updated_at
             ) VALUES ('expired-account-write-lease',?1,'demo',?2,'set_leverage',0,1,1)",
            params![current.id, account_config_cache_fingerprint(&current)],
        )
        .expect("insert expired account mutation lease");
        ensure_account_identity_change_allowed_with_conn(&conn, &current, &credentials_changed)
            .expect("expired account mutation lease must not block identity changes");
    }

    #[test]
    fn account_deletion_blocks_every_unresolved_execution_family() {
        let conn = test_conn();
        insert_account_environment_trade_guard(
            &conn,
            "delete-trade-environment-guard",
            "account-delete-guard",
            "demo",
            "place_order",
            "unknown",
        );
        let error = ensure_account_deletion_allowed_with_conn(&conn, "account-delete-guard")
            .expect_err("unknown trade execution must block account deletion");
        assert!(error.contains("交易执行 1 条"), "{error}");

        conn.execute("DELETE FROM trade_execution_attempts", [])
            .expect("clear trade guards");
        insert_account_environment_trade_guard(
            &conn,
            "delete-projection-environment-guard",
            "account-delete-guard",
            "live",
            "place_algo_order",
            "accepted",
        );
        conn.execute(
            "UPDATE trade_execution_attempts SET projection_status='pending'
             WHERE execution_key='delete-projection-environment-guard'",
            [],
        )
        .expect("mark accepted projection pending");
        let error = ensure_account_deletion_allowed_with_conn(&conn, "account-delete-guard")
            .expect_err("pending accepted projection must block account deletion");
        assert!(error.contains("交易执行 1 条"), "{error}");

        conn.execute("DELETE FROM trade_execution_attempts", [])
            .expect("clear projection guards");
        insert_account_environment_instrument_guard(
            &conn,
            "delete-instrument-environment-guard",
            "account-delete-guard",
            "demo",
            "reconciling",
        );
        let error = ensure_account_deletion_allowed_with_conn(&conn, "account-delete-guard")
            .expect_err("unresolved instrument operation must block account deletion");
        assert!(error.contains("当前合约紧急操作 1 条"), "{error}");

        conn.execute("DELETE FROM instrument_operations", [])
            .expect("clear instrument guards");
        ensure_account_deletion_allowed_with_conn(&conn, "account-delete-guard")
            .expect("account without unresolved executions may be deleted");
    }

    #[test]
    fn duplicate_okx_api_key_cannot_create_a_second_account_identity() {
        let existing =
            account_config_test_account("account-existing", "Existing", "placeholder-api-key-a");
        let config = AccountsConfig {
            accounts: vec![existing.clone()],
        };
        let duplicate =
            account_config_test_account("account-duplicate", "Duplicate", "placeholder-api-key-a");
        let error = ensure_unique_okx_api_key(&config, &duplicate)
            .expect_err("same API key under another account id must be rejected");
        assert!(error.contains("不能创建重复账号"), "{error}");

        ensure_unique_okx_api_key(&config, &existing)
            .expect("updating the same account id must remain allowed");
        let distinct =
            account_config_test_account("account-distinct", "Distinct", "placeholder-api-key-b");
        ensure_unique_okx_api_key(&config, &distinct)
            .expect("a different API key may use a different account id");
    }

    #[test]
    fn okx_remote_identity_uses_environment_and_uid_instead_of_api_key_text() {
        let first = account_config_test_account(
            "account-remote-first",
            "Remote first",
            "placeholder-api-key-first",
        );
        let mut second = account_config_test_account(
            "account-remote-second",
            "Remote second",
            "placeholder-api-key-second",
        );
        second.okx_uid = first.okx_uid.clone();
        second.okx_main_uid = first.okx_main_uid.clone();

        let first_identity = stored_okx_account_identity(&first).expect("first remote identity");
        let second_identity = stored_okx_account_identity(&second).expect("second remote identity");
        assert!(same_okx_remote_account(&first_identity, &second_identity));
        let config = AccountsConfig {
            accounts: vec![first.clone()],
        };
        let error =
            tauri::async_runtime::block_on(ensure_unique_okx_remote_account(&config, &second))
                .expect_err("a second API key for the same environment and uid must be rejected");
        assert!(error.contains("第二把 API Key"), "{error}");

        second.environment = "live".to_string();
        let live_identity = stored_okx_account_identity(&second).expect("live remote identity");
        assert!(!same_okx_remote_account(&first_identity, &live_identity));
    }

    #[test]
    fn local_okx_identity_guard_blocks_ambiguous_legacy_multi_account_configs() {
        let mut legacy =
            account_config_test_account("account-legacy", "Legacy", "placeholder-api-key-legacy");
        legacy.okx_uid.clear();
        legacy.okx_main_uid.clear();

        let single_account_config = AccountsConfig {
            accounts: vec![legacy.clone()],
        };
        ensure_local_okx_account_identity_unambiguous(&single_account_config, &legacy)
            .expect("a single legacy account remains usable during migration");

        let distinct = account_config_test_account(
            "account-distinct",
            "Distinct",
            "placeholder-api-key-distinct",
        );
        let ambiguous_config = AccountsConfig {
            accounts: vec![legacy.clone(), distinct.clone()],
        };
        let error = ensure_local_okx_account_identity_unambiguous(&ambiguous_config, &legacy)
            .expect_err("a legacy selected account is ambiguous in a multi-account config");
        assert!(error.contains("旧版多账号配置"), "{error}");

        let error = ensure_local_okx_account_identity_unambiguous(&ambiguous_config, &distinct)
            .expect_err("an unresolved peer account must block new executions");
        assert!(error.contains("Legacy"), "{error}");

        let other =
            account_config_test_account("account-other", "Other", "placeholder-api-key-other");
        let distinct_config = AccountsConfig {
            accounts: vec![distinct.clone(), other.clone()],
        };
        ensure_local_okx_account_identity_unambiguous(&distinct_config, &distinct)
            .expect("different persisted OKX uids must remain independently tradable");

        let mut duplicate = other;
        duplicate.okx_uid = distinct.okx_uid.clone();
        duplicate.okx_main_uid = distinct.okx_main_uid.clone();
        let duplicate_config = AccountsConfig {
            accounts: vec![distinct.clone(), duplicate],
        };
        let error = ensure_local_okx_account_identity_unambiguous(&duplicate_config, &distinct)
            .expect_err("duplicate persisted remote identities must block execution");
        assert!(error.contains("同一 OKX 远端账户"), "{error}");
    }

    fn insert_test_fill(
        conn: &Connection,
        account_id: &str,
        environment: &str,
        inst_id: &str,
        fill: TestFill<'_>,
    ) {
        conn.execute(
            "INSERT INTO okx_fills (
              account_id, environment, bill_id, ord_id, trade_id, inst_id, inst_type, side, pos_side,
              sub_type, fill_px, fill_sz, fill_pnl, fee, fee_ccy, source_endpoint, operator, strategy_id,
              session_id, okx_ts, raw_json, synced_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'SWAP', ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'USDT',
              'test-fill', ?14, ?15, ?16, ?17, '{}', ?18)",
            params![
                account_id,
                environment,
                fill.bill_id,
                format!("ord-{}", fill.bill_id),
                format!("trade-{}", fill.bill_id),
                inst_id,
                fill.side,
                fill.pos_side,
                fill.sub_type,
                fill.px,
                fill.sz,
                fill.pnl,
                fill.fee,
                fill.operator,
                fill.strategy_id,
                fill.session_id,
                fill.ts,
                fill.ts
            ],
        )
        .expect("insert test fill");
    }

    #[test]
    fn account_performance_summary_calculates_drawdown_and_attribution() {
        let bills = vec![
            PerformanceBillRow {
                ccy: Some("USDT".to_string()),
                bal: Some("1000".to_string()),
                time: 1_000,
            },
            PerformanceBillRow {
                ccy: Some("USDT".to_string()),
                bal: Some("1100".to_string()),
                time: 2_000,
            },
            PerformanceBillRow {
                ccy: Some("USDT".to_string()),
                bal: Some("990".to_string()),
                time: 3_000,
            },
        ];
        let episodes = vec![
            PerformanceEpisodeRow {
                id: "ep-ai".to_string(),
                inst_id: "BTC-USDT-SWAP".to_string(),
                episode_side: "long".to_string(),
                status: "closed".to_string(),
                primary_origin: "ai".to_string(),
                open_time: 1_000,
                close_time: Some(2_000),
                max_qty: "1".to_string(),
                avg_open_px: Some("100".to_string()),
                realized_pnl: Some("12".to_string()),
                fees: Some("-2".to_string()),
                funding_fee: Some("-1".to_string()),
                liq_penalty: None,
                net_pnl: Some("9".to_string()),
            },
            PerformanceEpisodeRow {
                id: "ep-user".to_string(),
                inst_id: "ETH-USDT-SWAP".to_string(),
                episode_side: "short".to_string(),
                status: "closed".to_string(),
                primary_origin: "user".to_string(),
                open_time: 2_000,
                close_time: Some(5_000),
                max_qty: "2".to_string(),
                avg_open_px: Some("50".to_string()),
                realized_pnl: Some("-4".to_string()),
                fees: Some("-0.5".to_string()),
                funding_fee: Some("0".to_string()),
                liq_penalty: None,
                net_pnl: Some("-4.5".to_string()),
            },
        ];
        let summary = build_account_performance_summary(
            "acc",
            "live",
            None,
            None,
            None,
            bills,
            Vec::new(),
            episodes,
            None,
        );
        assert_eq!(summary.equity_curve.len(), 3);
        assert!((summary.totals.max_drawdown_pct - 10.0).abs() < 1e-8);
        assert!((summary.totals.fees - 2.5).abs() < 1e-8);
        assert_eq!(summary.totals.episode_count, 2);
        assert_eq!(
            summary
                .highlights
                .best_episode
                .as_ref()
                .map(|item| item.id.as_str()),
            Some("ep-ai")
        );
        let ai = summary
            .attribution
            .iter()
            .find(|item| item.operator == "ai")
            .expect("ai attribution");
        assert!((ai.net_pnl - 9.0).abs() < 1e-8);
        let user = summary
            .attribution
            .iter()
            .find(|item| item.operator == "user")
            .expect("user attribution");
        assert!((user.net_pnl + 4.5).abs() < 1e-8);
    }

    #[test]
    fn account_performance_summary_falls_back_to_fills_when_episodes_missing() {
        let fills = vec![
            PerformanceFillRow {
                inst_id: "BTC-USDT-SWAP".to_string(),
                fill_pnl: Some("10".to_string()),
                fee: Some("-0.2".to_string()),
                operator: "ai".to_string(),
                time: 1_000,
            },
            PerformanceFillRow {
                inst_id: "BTC-USDT-SWAP".to_string(),
                fill_pnl: Some("-3".to_string()),
                fee: Some("-0.1".to_string()),
                operator: "manual".to_string(),
                time: 2_000,
            },
        ];
        let summary = build_account_performance_summary(
            "acc",
            "live",
            None,
            None,
            None,
            Vec::new(),
            fills,
            Vec::new(),
            None,
        );
        assert_eq!(summary.totals.fill_count, 2);
        assert_eq!(summary.totals.trade_count, 2);
        assert!((summary.totals.fees - 0.3).abs() < 1e-8);
        assert!(summary
            .coverage
            .warnings
            .iter()
            .any(|item| item.contains("暂无 PositionEpisode")));
        let ai = summary
            .attribution
            .iter()
            .find(|item| item.operator == "ai")
            .expect("ai attribution");
        assert!((ai.net_pnl - 9.8).abs() < 1e-8);
        let user = summary
            .attribution
            .iter()
            .find(|item| item.operator == "user")
            .expect("user attribution");
        assert!((user.net_pnl + 3.1).abs() < 1e-8);
    }

    #[test]
    fn account_performance_equity_curve_samples_sparse_bills_every_three_hours() {
        let hour = 60 * 60 * 1000;
        let bills = vec![
            PerformanceBillRow {
                ccy: Some("USDT".to_string()),
                bal: Some("100".to_string()),
                time: 0,
            },
            PerformanceBillRow {
                ccy: Some("USDT".to_string()),
                bal: Some("130".to_string()),
                time: 7 * hour,
            },
        ];
        let curve = build_equity_curve(&bills, 0.0, Some(0), Some(9 * hour));
        assert_eq!(
            curve.iter().map(|item| item.time).collect::<Vec<_>>(),
            vec![0, 3 * hour, 6 * hour, 9 * hour]
        );
        assert_eq!(
            curve
                .iter()
                .map(|item| item.equity as i64)
                .collect::<Vec<_>>(),
            vec![100, 100, 100, 130]
        );
        assert!((curve.last().unwrap().cumulative_return_pct - 30.0).abs() < 1e-8);
    }

    #[test]
    fn account_performance_equity_curve_carries_previous_balance_for_empty_window() {
        let hour = 60 * 60 * 1000;
        let bills = vec![PerformanceBillRow {
            ccy: Some("USDT".to_string()),
            bal: Some("1584".to_string()),
            time: 0,
        }];
        let curve = build_equity_curve(&bills, 0.0, Some(hour), Some(4 * hour));
        assert_eq!(
            curve.iter().map(|item| item.time).collect::<Vec<_>>(),
            vec![hour, 4 * hour]
        );
        assert_eq!(
            curve
                .iter()
                .map(|item| item.equity as i64)
                .collect::<Vec<_>>(),
            vec![1584, 1584]
        );
        assert!(curve
            .iter()
            .all(|item| item.cumulative_return_pct.abs() < 1e-8));
    }

    fn event_types(conn: &Connection, episode_id: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(
                "SELECT event_type FROM position_episode_events
                 WHERE episode_id = ?1
                 ORDER BY event_time ASC, id ASC",
            )
            .expect("prepare events");
        stmt.query_map([episode_id], |row| row.get::<_, String>(0))
            .expect("query events")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect events")
    }

    #[test]
    fn market_health_blockers_only_apply_to_live_and_require_time_sync() {
        let runtime = MarketRuntime::default();
        assert!(market_health_blockers(&runtime, "demo").is_empty());
        assert!(market_health_blockers(&runtime, "live").is_empty());
    }

    #[test]
    fn market_health_blockers_use_okx_time_for_public_and_private_delay() {
        let runtime = MarketRuntime::default();
        let local_now = now_ms();
        {
            let mut health = runtime.health.lock().expect("health lock");
            health.clock_offset_ms = Some(2_000);
            health.public_event_time_ms = Some(local_now + 2_000 - 900);
            health.private_event_time_ms = Some(local_now + 2_000 - 1_200);
        }

        assert!(market_health_blockers(&runtime, "live").is_empty());

        {
            let mut health = runtime.health.lock().expect("health lock");
            health.public_event_time_ms = Some(now_ms() + 2_000 - 3_500);
            health.private_event_time_ms = Some(now_ms() + 2_000 - 4_000);
        }
        assert!(market_health_blockers(&runtime, "live").is_empty());
    }

    #[test]
    fn episode_action_maps_okx_subtypes_and_net_reversal() {
        let mut fill = EpisodeFillRow {
            bill_id: "b1".to_string(),
            ord_id: None,
            trade_id: None,
            inst_id: "BTC-USDT-SWAP".to_string(),
            inst_type: "SWAP".to_string(),
            side: Some("buy".to_string()),
            pos_side: Some("net".to_string()),
            sub_type: None,
            fill_px: Some("100".to_string()),
            fill_sz: Some("1".to_string()),
            fill_pnl: None,
            fee: None,
            fee_ccy: None,
            operator: Some("user".to_string()),
            strategy_id: None,
            session_id: None,
            okx_ts: 1,
            raw_json: "{}".to_string(),
        };
        let action = episode_action_from_fill(&fill).expect("net buy action");
        assert_eq!(action.side, "short");
        assert!(!action.opens);
        assert_eq!(action.reversal_side.as_deref(), Some("long"));

        fill.sub_type = Some("3".to_string());
        let action = episode_action_from_fill(&fill).expect("open long subtype");
        assert_eq!(action.side, "long");
        assert!(action.opens);

        fill.sub_type = Some("6".to_string());
        let action = episode_action_from_fill(&fill).expect("close short subtype");
        assert_eq!(action.side, "short");
        assert!(!action.opens);
        assert_eq!(action.reversal_side.as_deref(), Some("long"));
    }

    #[test]
    fn rebuild_position_episodes_tracks_add_reduce_close_and_mixed_origin() {
        let mut conn = test_conn();
        let account_id = "acct";
        let environment = "live";
        let inst_id = "BTC-USDT-SWAP";
        let fills = [
            TestFill {
                bill_id: "b1",
                side: "buy",
                pos_side: Some("long"),
                sub_type: None,
                px: "100",
                sz: "0.5",
                pnl: "0",
                fee: "-0.01",
                operator: "ai",
                strategy_id: Some("s1"),
                session_id: Some("chat1"),
                ts: 1,
            },
            TestFill {
                bill_id: "b2",
                side: "buy",
                pos_side: Some("long"),
                sub_type: None,
                px: "110",
                sz: "0.5",
                pnl: "0",
                fee: "-0.01",
                operator: "ai",
                strategy_id: Some("s1"),
                session_id: Some("chat1"),
                ts: 2,
            },
            TestFill {
                bill_id: "b3",
                side: "sell",
                pos_side: Some("long"),
                sub_type: None,
                px: "120",
                sz: "0.3",
                pnl: "3",
                fee: "-0.01",
                operator: "user",
                strategy_id: None,
                session_id: None,
                ts: 3,
            },
            TestFill {
                bill_id: "b4",
                side: "sell",
                pos_side: Some("long"),
                sub_type: None,
                px: "130",
                sz: "0.7",
                pnl: "14",
                fee: "-0.01",
                operator: "user",
                strategy_id: None,
                session_id: None,
                ts: 4,
            },
        ];
        for fill in fills {
            insert_test_fill(&conn, account_id, environment, inst_id, fill);
        }

        let result = rebuild_position_episodes_for_account(
            &mut conn,
            account_id,
            environment,
            Some(inst_id),
        )
        .expect("rebuild episodes");
        assert_eq!(result.fills_scanned, 4);
        assert_eq!(result.episodes_built, 1);
        assert_eq!(result.events_built, 4);
        assert_eq!(result.incomplete_events, 0);

        let episodes = load_position_episodes(&conn, account_id, environment, Some(inst_id), 10)
            .expect("load episodes");
        assert_eq!(episodes.len(), 1);
        let episode = &episodes[0];
        assert_eq!(episode.episode_side, "long");
        assert_eq!(episode.status, "closed");
        assert_eq!(episode.primary_origin, "mixed");
        assert_eq!(episode.strategy_id.as_deref(), Some("s1"));
        assert_eq!(episode.open_qty, "1");
        assert_eq!(episode.closed_qty, "1");
        assert_eq!(episode.remaining_qty, "0");
        assert_eq!(episode.avg_open_px.as_deref(), Some("105"));
        assert_eq!(episode.avg_close_px.as_deref(), Some("127"));
        assert_eq!(episode.realized_pnl.as_deref(), Some("17"));
        assert_eq!(
            event_types(&conn, &episode.id),
            vec!["OPEN", "ADD", "REDUCE", "CLOSE"]
        );
    }

    #[test]
    fn rebuild_position_episodes_splits_net_reversal_into_close_and_open() {
        let mut conn = test_conn();
        let account_id = "acct";
        let environment = "live";
        let inst_id = "ETH-USDT-SWAP";
        insert_test_fill(
            &conn,
            account_id,
            environment,
            inst_id,
            TestFill {
                bill_id: "n1",
                side: "buy",
                pos_side: Some("long"),
                sub_type: None,
                px: "100",
                sz: "0.5",
                pnl: "0",
                fee: "-0.01",
                operator: "user",
                strategy_id: None,
                session_id: None,
                ts: 1,
            },
        );
        insert_test_fill(
            &conn,
            account_id,
            environment,
            inst_id,
            TestFill {
                bill_id: "n2",
                side: "sell",
                pos_side: Some("net"),
                sub_type: None,
                px: "90",
                sz: "0.8",
                pnl: "-5",
                fee: "-0.016",
                operator: "ai",
                strategy_id: Some("shortbot"),
                session_id: Some("chat2"),
                ts: 2,
            },
        );

        let result = rebuild_position_episodes_for_account(
            &mut conn,
            account_id,
            environment,
            Some(inst_id),
        )
        .expect("rebuild reversal");
        assert_eq!(result.episodes_built, 2);
        assert_eq!(result.events_built, 3);
        assert_eq!(result.incomplete_events, 0);

        let episodes = load_position_episodes(&conn, account_id, environment, Some(inst_id), 10)
            .expect("load reversal episodes");
        let long = episodes
            .iter()
            .find(|episode| episode.episode_side == "long")
            .expect("long episode");
        let short = episodes
            .iter()
            .find(|episode| episode.episode_side == "short")
            .expect("short episode");
        assert_eq!(long.status, "closed");
        assert_eq!(long.closed_qty, "0.5");
        assert_eq!(long.remaining_qty, "0");
        assert_eq!(long.primary_origin, "mixed");
        assert_eq!(event_types(&conn, &long.id), vec!["OPEN", "CLOSE"]);
        assert_eq!(short.status, "open");
        assert_eq!(short.open_qty, "0.3");
        assert_eq!(short.remaining_qty, "0.3");
        assert_eq!(short.primary_origin, "ai");
        assert_eq!(short.strategy_id.as_deref(), Some("shortbot"));
        assert_eq!(event_types(&conn, &short.id), vec!["OPEN"]);
    }

    #[test]
    fn rebuild_position_episodes_clears_existing_opportunity_links_before_rebuild() {
        let mut conn = test_conn();
        conn.pragma_update(None, "foreign_keys", "ON")
            .expect("enable foreign keys");
        let account_id = "acct";
        let environment = "live";
        let inst_id = "BTC-USDT-SWAP";
        conn.execute(
            "INSERT INTO trade_opportunities(
              id, account_id, environment, inst_id, td_mode, intent, direction, ticket_mode,
              action, order_type, size, reason, status, created_at, updated_at
            ) VALUES ('opp-rebuild', ?1, ?2, ?3, 'cross', 'open', 'long', 'regular',
              'open_long', 'market', '1', 'test opportunity', 'executed', 1, 1)",
            params![account_id, environment, inst_id],
        )
        .expect("insert opportunity");
        insert_test_fill(
            &conn,
            account_id,
            environment,
            inst_id,
            TestFill {
                bill_id: "b1",
                side: "buy",
                pos_side: Some("long"),
                sub_type: None,
                px: "100",
                sz: "1",
                pnl: "0",
                fee: "-0.01",
                operator: "ai",
                strategy_id: Some("opp-rebuild"),
                session_id: Some("run-1"),
                ts: 1,
            },
        );
        insert_test_fill(
            &conn,
            account_id,
            environment,
            inst_id,
            TestFill {
                bill_id: "b2",
                side: "sell",
                pos_side: Some("long"),
                sub_type: None,
                px: "110",
                sz: "1",
                pnl: "10",
                fee: "-0.01",
                operator: "ai",
                strategy_id: Some("opp-rebuild"),
                session_id: Some("run-1"),
                ts: 2,
            },
        );

        rebuild_position_episodes_for_account(&mut conn, account_id, environment, Some(inst_id))
            .expect("first rebuild");
        let links_after_first = conn
            .query_row(
                "SELECT COUNT(*) FROM position_episode_opportunities",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("count opportunity links");
        assert_eq!(links_after_first, 1);

        rebuild_position_episodes_for_account(&mut conn, account_id, environment, Some(inst_id))
            .expect("second rebuild should remove old links before deleting episodes");
        let links_after_second = conn
            .query_row(
                "SELECT COUNT(*) FROM position_episode_opportunities",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("count opportunity links after second rebuild");
        assert_eq!(links_after_second, 1);
    }

    #[test]
    fn rebuild_position_episodes_includes_official_history_without_fill_details() {
        let mut conn = test_conn();
        let account_id = "acct-official";
        let environment = "live";
        let inst_id = "BTC-USDT-SWAP";
        conn.execute(
            "INSERT INTO okx_position_history (
              account_id, environment, pos_id, inst_id, inst_type, mgn_mode, pos_side, direction,
              close_type, open_avg_px, close_avg_px, open_max_pos, close_total_pos, realized_pnl,
              pnl, fee, funding_fee, liq_penalty, okx_ctime, okx_utime, raw_json, synced_at
            ) VALUES (?1, ?2, 'pos-official-1', ?3, 'SWAP', 'cross', 'long', 'long',
              '1', '64000', '64200', '0.02', '0.02', '3.2',
              '3.0', '-0.1', '0.3', '0', 1000, 2000, '{}', 3000)",
            params![account_id, environment, inst_id],
        )
        .expect("insert official position history");

        let result = rebuild_position_episodes_for_account(
            &mut conn,
            account_id,
            environment,
            Some(inst_id),
        )
        .expect("rebuild episodes from official history");
        assert_eq!(result.fills_scanned, 0);
        assert_eq!(result.episodes_built, 1);

        let episodes = load_position_episodes(&conn, account_id, environment, Some(inst_id), 10)
            .expect("load official episode");
        assert_eq!(episodes.len(), 1);
        let episode = &episodes[0];
        let (exchange_pos_id, pos_mode): (Option<String>, String) = conn
            .query_row(
                "SELECT exchange_pos_id,pos_mode FROM position_episodes WHERE id=?1",
                [&episode.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read official episode storage fields");
        assert_eq!(exchange_pos_id.as_deref(), Some("pos-official-1"));
        assert_eq!(pos_mode, "official_history");
        assert_eq!(episode.primary_origin, "exchange");
        assert_eq!(episode.status, "closed");
        assert_eq!(episode.open_qty, "0.02");
        assert_eq!(episode.closed_qty, "0.02");
        assert_eq!(episode.avg_open_px.as_deref(), Some("64000"));
        assert_eq!(episode.avg_close_px.as_deref(), Some("64200"));
        assert_eq!(episode.net_pnl.as_deref(), Some("3.2"));
        assert!(episode.events.is_empty());
    }

    #[test]
    fn rebuild_position_episodes_links_matching_official_history_without_duplication() {
        let mut conn = test_conn();
        let account_id = "acct-match";
        let environment = "live";
        let inst_id = "BTC-USDT-SWAP";
        insert_test_fill(
            &conn,
            account_id,
            environment,
            inst_id,
            TestFill {
                bill_id: "match-open",
                side: "buy",
                pos_side: Some("long"),
                sub_type: None,
                px: "64000",
                sz: "0.02",
                pnl: "0",
                fee: "-0.1",
                operator: "user",
                strategy_id: None,
                session_id: None,
                ts: 1_000,
            },
        );
        insert_test_fill(
            &conn,
            account_id,
            environment,
            inst_id,
            TestFill {
                bill_id: "match-close",
                side: "sell",
                pos_side: Some("long"),
                sub_type: None,
                px: "64200",
                sz: "0.02",
                pnl: "3",
                fee: "-0.1",
                operator: "user",
                strategy_id: None,
                session_id: None,
                ts: 2_000,
            },
        );
        conn.execute(
            "INSERT INTO okx_position_history (
              account_id, environment, pos_id, inst_id, inst_type, mgn_mode, pos_side, direction,
              close_type, open_avg_px, close_avg_px, open_max_pos, close_total_pos, realized_pnl,
              pnl, fee, funding_fee, liq_penalty, okx_ctime, okx_utime, raw_json, synced_at
            ) VALUES (?1, ?2, 'pos-match-1', ?3, 'SWAP', 'cross', 'long', 'long',
              '1', '64000', '64200', '0.02', '0.02', '2.8',
              '3.0', '-0.2', '0', '0', 1000, 2000, '{}', 3000)",
            params![account_id, environment, inst_id],
        )
        .expect("insert matching official position history");

        let result = rebuild_position_episodes_for_account(
            &mut conn,
            account_id,
            environment,
            Some(inst_id),
        )
        .expect("rebuild episodes with matching official history");
        assert_eq!(result.episodes_built, 1);

        let episodes = load_position_episodes(&conn, account_id, environment, Some(inst_id), 10)
            .expect("load matched episode");
        assert_eq!(episodes.len(), 1);
        assert_eq!(episodes[0].events.len(), 2);
        let exchange_pos_id: Option<String> = conn
            .query_row(
                "SELECT exchange_pos_id FROM position_episodes WHERE id=?1",
                [&episodes[0].id],
                |row| row.get(0),
            )
            .expect("read linked official position id");
        assert_eq!(exchange_pos_id.as_deref(), Some("pos-match-1"));
    }

    fn table_has_column(conn: &Connection, table: &str, column: &str) -> bool {
        let sql = format!("PRAGMA table_info({table})");
        let mut stmt = conn.prepare(&sql).expect("prepare table info");
        stmt.query_map([], |row| row.get::<_, String>(1))
            .expect("query table info")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect table info")
            .iter()
            .any(|value| value == column)
    }

    #[test]
    fn database_migration_adds_algo_execution_lease_columns() {
        let conn = test_conn();
        conn.execute(
            "ALTER TABLE trade_execution_attempts DROP COLUMN owner_token",
            [],
        )
        .expect("drop owner token to simulate old database");
        conn.execute(
            "ALTER TABLE trade_execution_attempts DROP COLUMN lease_expires_at",
            [],
        )
        .expect("drop lease expiry to simulate old database");
        conn.execute("DROP INDEX idx_trade_execution_attempts_projection", [])
            .expect("drop projection index before dropping its column");
        conn.execute(
            "ALTER TABLE trade_execution_attempts DROP COLUMN projection_status",
            [],
        )
        .expect("drop projection status to simulate old database");

        migrate_database(&conn).expect("migrate old execution attempt schema");

        assert!(table_has_column(
            &conn,
            "trade_execution_attempts",
            "owner_token"
        ));
        assert!(table_has_column(
            &conn,
            "trade_execution_attempts",
            "lease_expires_at"
        ));
        assert!(table_has_column(
            &conn,
            "trade_execution_attempts",
            "projection_status"
        ));
    }

    #[test]
    fn database_migration_backfills_episode_attribution_columns() {
        let conn = test_conn();
        conn.execute(
            "ALTER TABLE position_episodes DROP COLUMN opportunity_id",
            [],
        )
        .expect("drop opportunity column to simulate old database");
        conn.execute("ALTER TABLE position_episodes DROP COLUMN agent_run_id", [])
            .expect("drop run column to simulate old database");
        conn.execute(
            "ALTER TABLE position_episode_events DROP COLUMN opportunity_id",
            [],
        )
        .expect("drop event opportunity column to simulate old database");
        conn.execute(
            "ALTER TABLE position_episode_events DROP COLUMN agent_run_id",
            [],
        )
        .expect("drop event run column to simulate old database");

        migrate_database(&conn).expect("migrate old episode schema");

        assert!(table_has_column(
            &conn,
            "position_episodes",
            "opportunity_id"
        ));
        assert!(table_has_column(&conn, "position_episodes", "agent_run_id"));
        assert!(table_has_column(
            &conn,
            "position_episode_events",
            "opportunity_id"
        ));
        assert!(table_has_column(
            &conn,
            "position_episode_events",
            "agent_run_id"
        ));
    }

    #[test]
    fn automation_migration_creates_durable_run_review_and_skill_tables() {
        let conn = test_conn();
        crate::ai_automation::migrate_ai_automation(&conn).expect("migrate automation schema");
        for table in [
            "ai_agent_profiles",
            "ai_agent_runs",
            "ai_wake_conditions",
            "ai_trade_reviews",
            "ai_optimization_suggestions",
            "ai_notification_deliveries",
            "ai_domain_events",
            "ai_skill_versions",
        ] {
            let exists = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [table],
                    |row| row.get::<_, i64>(0),
                )
                .expect("query automation table");
            assert_eq!(exists, 1, "missing table {table}");
        }
        assert!(table_has_column(
            &conn,
            "ai_optimization_suggestions",
            "proposed_skill_json"
        ));
    }

    #[test]
    fn order_state_advances_opportunity_without_treating_submit_as_fill() {
        assert_eq!(
            opportunity_status_from_order_state(Some("live"), Some("0")),
            Some("submitted")
        );
        assert_eq!(
            opportunity_status_from_order_state(Some("partially_filled"), Some("0.25")),
            Some("partially_filled")
        );
        assert_eq!(
            opportunity_status_from_order_state(Some("filled"), Some("1")),
            Some("executed")
        );
        assert_eq!(
            opportunity_status_from_order_state(Some("canceled"), Some("0")),
            Some("cancelled")
        );
        assert_eq!(
            opportunity_status_from_order_state(Some("canceled"), Some("0.2")),
            Some("executed")
        );
    }

    #[test]
    fn episode_rebuild_links_explicit_opportunity_and_agent_run() {
        let mut conn = test_conn();
        let account_id = "acct-link";
        let environment = "demo";
        let inst_id = "BTC-USDT-SWAP";
        conn.execute(
            "INSERT INTO trade_opportunities(
              id,account_id,environment,inst_id,td_mode,intent,direction,ticket_mode,action,order_type,
              size,reason,status,created_at,updated_at
             ) VALUES('opp-link',?1,?2,?3,'cross','open','long','open','long','market','1',
               'test opportunity','executed',1,1)",
            params![account_id, environment, inst_id],
        )
        .expect("insert linked opportunity");
        for fill in [
            TestFill {
                bill_id: "link-open",
                side: "buy",
                pos_side: Some("long"),
                sub_type: None,
                px: "100",
                sz: "1",
                pnl: "0",
                fee: "-0.01",
                operator: "ai",
                strategy_id: Some("legacy-strategy"),
                session_id: Some("legacy-session"),
                ts: 10,
            },
            TestFill {
                bill_id: "link-close",
                side: "sell",
                pos_side: Some("long"),
                sub_type: None,
                px: "110",
                sz: "1",
                pnl: "10",
                fee: "-0.01",
                operator: "ai",
                strategy_id: Some("legacy-strategy"),
                session_id: Some("legacy-session"),
                ts: 20,
            },
        ] {
            insert_test_fill(&conn, account_id, environment, inst_id, fill);
        }
        conn.execute(
            "UPDATE okx_fills SET opportunity_id='opp-link',agent_run_id='run-link',execution_key='exec-link'
             WHERE account_id=?1 AND environment=?2",
            params![account_id, environment],
        )
        .expect("add explicit attribution");

        rebuild_position_episodes_for_account(&mut conn, account_id, environment, Some(inst_id))
            .expect("rebuild attributed episode");
        let link = conn
            .query_row(
                "SELECT opportunity_id,agent_run_id FROM position_episode_opportunities LIMIT 1",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .expect("load episode opportunity link");
        assert_eq!(link.0, "opp-link");
        assert_eq!(link.1.as_deref(), Some("run-link"));
    }

    #[test]
    fn trade_opportunity_schema_includes_source_and_execution_attribution() {
        let conn = test_conn();
        for column in [
            "origin_type",
            "strategy_kind",
            "strategy_id",
            "strategy_version_id",
            "strategy_run_id",
            "signal_id",
            "factor_pool_version_id",
            "market_snapshot_json",
            "revision",
            "fingerprint",
            "agent_profile_id",
            "agent_run_id",
            "execution_key",
        ] {
            assert!(
                table_has_column(&conn, "trade_opportunities", column),
                "missing {column}"
            );
        }
        for table in ["okx_orders", "okx_fills", "trade_audit_events"] {
            for column in ["opportunity_id", "agent_run_id", "execution_key"] {
                assert!(
                    table_has_column(&conn, table, column),
                    "missing {table}.{column}"
                );
            }
        }
    }

    #[test]
    fn database_migration_backfills_legacy_trade_opportunity_source_columns() {
        let conn = test_conn();
        let source_columns = [
            "origin_type",
            "strategy_kind",
            "strategy_id",
            "strategy_version_id",
            "strategy_run_id",
            "signal_id",
            "factor_pool_version_id",
        ];
        for column in source_columns {
            conn.execute(
                &format!("ALTER TABLE trade_opportunities DROP COLUMN {column}"),
                [],
            )
            .unwrap_or_else(|error| panic!("drop {column} to simulate legacy schema: {error}"));
        }

        migrate_database(&conn).expect("migrate legacy trade opportunity schema");

        for column in source_columns {
            assert!(
                table_has_column(&conn, "trade_opportunities", column),
                "migration did not restore {column}"
            );
        }
    }

    #[test]
    fn chart_workspace_migration_persists_structured_json() {
        let conn = test_conn();
        for table in [
            "chart_workspaces",
            "chart_workspace_views",
            "chart_drawings",
            "chart_alerts",
        ] {
            let exists = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                    params![table],
                    |row| row.get::<_, i64>(0),
                )
                .expect("query chart workspace table");
            assert_eq!(exists, 1, "missing {table}");
        }
        conn.execute(
            "INSERT INTO chart_workspaces (id, name, layout_json, indicators_json, layers_json, created_at, updated_at)
             VALUES ('workspace-test', 'Test', '{\"mode\":\"grid\"}', '[]', '{\"drawings\":true}', 1, 2)",
            [],
        )
        .expect("insert chart workspace");
        let workspace = conn
            .query_row(
                "SELECT id, name, layout_json, indicators_json, layers_json, created_at, updated_at
                 FROM chart_workspaces WHERE id = 'workspace-test'",
                [],
                chart_workspace_from_row,
            )
            .expect("read chart workspace");
        assert_eq!(workspace.layout["mode"], "grid");
        assert!(workspace.indicators.is_array());
        assert_eq!(workspace.layers["drawings"], true);
    }

    fn test_ai_tool_context(mode: &str, role: &str, delegated: bool) -> AiToolExecutionContext {
        AiToolExecutionContext {
            session_id: "test-session".to_string(),
            permission_mode: mode.to_string(),
            tool_allowlist: HashSet::new(),
            parent_agent_id: delegated.then(|| "agent-main".to_string()),
            agent_role: role.to_string(),
            configured_agent_id: None,
            configured_agent_scopes: Vec::new(),
            declared_agent_run_id: None,
            declared_agent_profile_id: None,
            declared_review_id: None,
            declared_episode_id: None,
            active_skill_ids: HashSet::new(),
            account_context_id: None,
            run_context: None,
        }
    }

    fn test_background_run_context(
        account_id: Option<&str>,
        multi_agent_mode: &str,
        multi_agents: Vec<desic_agent_automation::AiProfileSubAgent>,
    ) -> BackgroundRunContext {
        BackgroundRunContext {
            permission_mode: "advisor".to_string(),
            account_id: account_id.map(str::to_string),
            environment: Some("demo".to_string()),
            symbols: vec!["BTC-USDT-SWAP".to_string()],
            profile_id: Some("profile-test".to_string()),
            run_id: Some("run-test".to_string()),
            enabled_skills: Vec::new(),
            skill_versions: HashMap::new(),
            skill_definitions: Vec::new(),
            model: None,
            reasoning_depth: "medium".to_string(),
            history_lookback_days: 30,
            target_leverage: 20,
            max_single_trade_margin_pct: 30,
            allowed_wake_condition_types: Vec::new(),
            multi_agent_mode: multi_agent_mode.to_string(),
            multi_agent_max_agents: 4,
            multi_agents,
            review_id: None,
            episode_id: None,
        }
    }

    #[test]
    fn indicator_ids_accept_explicit_period_suffixes() {
        assert_eq!(ai_indicator_period("ema20", "ema", 21), Some(20));
        assert_eq!(ai_indicator_period("rsi14", "rsi", 14), Some(14));
        assert_eq!(ai_indicator_period("bb20", "bb", 20), Some(20));
        assert_eq!(ai_indicator_period("ema", "ema", 21), Some(21));
        assert_eq!(ai_indicator_period("ema0", "ema", 21), None);
        assert_eq!(ai_indicator_period("ema501", "ema", 21), None);
    }

    #[test]
    fn ai_candle_payload_uses_millisecond_times_and_explicit_close_state() {
        let open_time_seconds = now_ms() / 1000 - 120;
        let value = ai_candles_value(
            "BTC-USDT-SWAP",
            "1m",
            vec![Candle {
                time: open_time_seconds,
                open: 100.0,
                high: 102.0,
                low: 99.0,
                close: 101.0,
                volume: 10.0,
                confirm: true,
            }],
            "test",
            open_time_seconds * 1000 + 120_000,
            false,
            None,
        );
        let candle = &value["candles"][0];
        assert_eq!(candle["time"].as_i64(), Some(open_time_seconds * 1000));
        assert_eq!(candle["openTimeMs"], candle["time"]);
        assert_eq!(
            candle["closeTimeMs"].as_i64(),
            Some(open_time_seconds * 1000 + 60_000)
        );
        assert_eq!(candle["confirm"].as_bool(), Some(true));
        assert_eq!(value["timeUnit"].as_str(), Some("unix_ms"));
        assert_eq!(value["dataAt"], candle["observedAt"]);
    }

    #[test]
    fn memory_one_minute_candles_complete_confirmed_five_minute_bucket() {
        let conn = test_conn();
        let bucket_open_ms = 1_800_000_000_000_i64;
        let memory = (0..5)
            .map(|index| Candle {
                time: bucket_open_ms / 1000 + index * 60,
                open: 100.0 + index as f64,
                high: 101.0 + index as f64,
                low: 99.0 + index as f64,
                close: 100.5 + index as f64,
                volume: 10.0,
                confirm: true,
            })
            .collect::<Vec<_>>();
        let candles = aggregate_candles_from_1m_with_overlay(
            &conn,
            "BTC-USDT-SWAP",
            "5m",
            Some(bucket_open_ms / 1000),
            Some(bucket_open_ms / 1000),
            1,
            true,
            &memory,
        )
        .expect("aggregate memory candles");
        assert_eq!(candles.len(), 1);
        assert!(candles[0].confirm);
        assert_eq!(candles[0].time, bucket_open_ms / 1000);
        assert_eq!(candles[0].close, 104.5);
        assert_eq!(candles[0].volume, 50.0);
    }

    #[test]
    fn sqlite_one_minute_aggregation_matches_domain_aggregation() {
        let conn = test_conn();
        let bucket_open_ms = 1_800_000_000_000_i64;
        for index in 0..10_i64 {
            let open_time = bucket_open_ms + index * 60_000;
            conn.execute(
                "INSERT INTO candles(
                   symbol,interval,open_time,close_time,open,high,low,close,volume,
                   volume_ccy,volume_quote,confirm,source,updated_at
                 ) VALUES(?1,'1m',?2,?3,?4,?5,?6,?7,?8,NULL,NULL,1,'test',?2)",
                params![
                    "BTC-USDT-SWAP",
                    open_time,
                    open_time + 59_999,
                    (100.0 + index as f64).to_string(),
                    (102.0 + index as f64).to_string(),
                    (99.0 + index as f64).to_string(),
                    (101.0 + index as f64).to_string(),
                    (10.0 + index as f64).to_string(),
                ],
            )
            .expect("insert one minute candle");
        }
        let raw = local_candles_between(
            &conn,
            "BTC-USDT-SWAP",
            "1m",
            bucket_open_ms,
            bucket_open_ms + 9 * 60_000,
        )
        .expect("load raw candles");
        let expected = aggregate_one_minute_candles(&raw, 300_000, bucket_open_ms + 9 * 60_000);
        let actual = local_aggregated_one_minute_candles(
            &conn,
            "BTC-USDT-SWAP",
            300_000,
            bucket_open_ms,
            bucket_open_ms + 9 * 60_000,
        )
        .expect("aggregate candles in sqlite");
        assert_eq!(actual.len(), expected.len());
        for (actual, expected) in actual.iter().zip(expected.iter()) {
            assert_eq!(actual.time, expected.time);
            assert_eq!(actual.open, expected.open);
            assert_eq!(actual.high, expected.high);
            assert_eq!(actual.low, expected.low);
            assert_eq!(actual.close, expected.close);
            assert_eq!(actual.volume, expected.volume);
            assert_eq!(actual.confirm, expected.confirm);
        }
    }

    #[test]
    fn memory_candle_overrides_database_value_and_missing_times_are_explicit() {
        let database = vec![Candle {
            time: 1_800_000_000,
            open: 100.0,
            high: 101.0,
            low: 99.0,
            close: 100.0,
            volume: 1.0,
            confirm: false,
        }];
        let memory = Candle {
            time: 1_800_000_000,
            open: 100.0,
            high: 102.0,
            low: 99.0,
            close: 101.0,
            volume: 2.0,
            confirm: true,
        };
        let merged = merge_candle_series(database, [&memory]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].close, 101.0);
        assert!(merged[0].confirm);

        let mut late_unconfirmed = memory.clone();
        late_unconfirmed.close = 102.0;
        late_unconfirmed.confirm = false;
        let monotonic = merge_candle_series(vec![memory.clone()], [&late_unconfirmed]);
        assert_eq!(monotonic[0].close, 101.0);
        assert!(monotonic[0].confirm);

        let first_open = memory.time * 1000;
        let missing =
            missing_confirmed_one_minute_open_times(&merged, first_open, first_open + 2 * 60_000);
        assert_eq!(missing, vec![first_open + 60_000, first_open + 120_000]);
    }

    #[test]
    fn candle_payload_marks_a_lagging_confirmed_tail_stale() {
        let interval_ms = 300_000_i64;
        let expected_close = 1_800_000_300_000_i64;
        let as_of = expected_close + AI_CANDLE_CONFIRM_GRACE_MS + 1;
        let fresh = Candle {
            time: (expected_close - interval_ms) / 1000,
            open: 100.0,
            high: 102.0,
            low: 99.0,
            close: 101.0,
            volume: 10.0,
            confirm: true,
        };
        let fresh_value = ai_candles_value(
            "BTC-USDT-SWAP",
            "5m",
            vec![fresh.clone()],
            "test",
            as_of,
            true,
            None,
        );
        assert_eq!(fresh_value["expectedLatestConfirmedAt"], expected_close);
        assert_eq!(fresh_value["stale"], false);

        let mut stale = fresh;
        stale.time -= interval_ms / 1000;
        let stale_value = ai_candles_value(
            "BTC-USDT-SWAP",
            "5m",
            vec![stale],
            "test",
            as_of,
            true,
            None,
        );
        assert_eq!(stale_value["stale"], true);
        assert!(stale_value["staleReason"]
            .as_str()
            .unwrap_or_default()
            .contains("早于当前应确认时间"));
    }

    #[test]
    fn historical_time_filter_compares_seconds_and_milliseconds_consistently() {
        let record_ms = 1_784_665_752_828_i64;
        let window_start_ms = 1_781_879_499_866_i64;
        let window_end_ms = 1_784_819_817_316_i64;
        assert!(ai_time_filter(
            record_ms,
            Some(window_start_ms),
            Some(window_end_ms)
        ));
        assert!(ai_time_filter(
            record_ms / 1000,
            Some(window_start_ms),
            Some(window_end_ms / 1000)
        ));
        assert!(!ai_time_filter(record_ms, Some(record_ms + 1), None));
    }

    #[test]
    fn trade_opportunity_input_reports_the_exact_malformed_field() {
        let valid = json!({
            "environment": "demo",
            "instId": "BTC-USDT-SWAP",
            "tdMode": "cross",
            "intent": "open",
            "direction": "short",
            "size": "0.01",
            "orderType": "limit",
            "price": "65000",
            "evidence": ["结构证据"],
            "riskNotes": ["风险证据"],
            "reason": "测试"
        });
        validate_trade_opportunity_input_shape(&valid).expect("valid opportunity input");

        let mut malformed_evidence = valid.clone();
        malformed_evidence["evidence"] = json!(["结构证据", ["错误嵌套的风险数组"]]);
        let error = validate_trade_opportunity_input_shape(&malformed_evidence)
            .expect_err("nested evidence must fail closed");
        assert!(error.contains("evidence[1]"));
        assert!(error.contains("实际为数组"));

        let mut malformed_scalar = valid;
        malformed_scalar["entryCondition"] = json!(["反弹到阻力"]);
        let error = validate_trade_opportunity_input_shape(&malformed_scalar)
            .expect_err("array scalar must fail closed");
        assert!(error.contains("entryCondition"));
        assert!(error.contains("实际为数组"));
    }

    #[test]
    fn rust_ai_tool_authorization_is_default_deny_and_role_aware() {
        let advisor = test_ai_tool_context("advisor", "main", false);
        assert!(authorize_ai_tool("market.readTicker", &advisor).is_ok());
        assert!(authorize_ai_tool("tradeOpportunity.create", &advisor).is_err());
        assert!(authorize_ai_tool("future.sdk.tool", &advisor).is_err());
        let mut indicator_only = test_ai_tool_context("advisor", "main", false);
        indicator_only
            .tool_allowlist
            .insert("script.createOrUpdate".to_string());
        assert!(authorize_ai_tool("script.createOrUpdate", &indicator_only).is_ok());
        assert!(authorize_ai_tool("market.readTicker", &indicator_only).is_err());

        let copilot = test_ai_tool_context("copilot", "main", false);
        assert!(authorize_ai_tool("tradeOpportunity.create", &copilot).is_ok());
        assert!(authorize_ai_tool("trade.placeOrder", &copilot).is_err());
        assert!(authorize_ai_tool("trade.setLeverage", &copilot).is_err());

        let mut profile_copilot = test_ai_tool_context("copilot", "main", false);
        let mut profile_run = test_background_run_context(
            Some("account-profile"),
            desic_agent_automation::MULTI_AGENT_OFF_MODE,
            Vec::new(),
        );
        profile_run.permission_mode = "copilot".to_string();
        profile_copilot.run_context = Some(profile_run);
        assert!(authorize_ai_tool("trade.setLeverage", &profile_copilot).is_ok());
        assert!(authorize_ai_tool("market.readDecisionContext", &profile_copilot).is_ok());
        assert!(authorize_ai_tool("tradeOpportunity.create", &profile_copilot).is_ok());
        assert!(authorize_ai_tool("tradeOpportunity.revise", &profile_copilot).is_err());
        assert!(authorize_ai_tool("tradeOpportunity.reuse", &profile_copilot).is_err());

        let mut leverage_input = json!({
            "accountId": "account-profile",
            "environment": "demo",
            "instId": "BTC-USDT-SWAP",
            "mgnMode": "cross",
            "lever": "100",
            "posSide": "long",
            "reason": "sync target"
        });
        enforce_background_run_scope("trade.setLeverage", &mut leverage_input, &profile_copilot)
            .expect("bind profile target leverage");
        assert_eq!(
            leverage_input.get("lever").and_then(Value::as_str),
            Some("20")
        );
        assert!(leverage_input.get("posSide").is_none());

        let mut precheck_input = json!({
            "accountId": "account-profile",
            "environment": "demo",
            "instId": "BTC-USDT-SWAP"
        });
        enforce_background_run_scope("trade.precheck", &mut precheck_input, &profile_copilot)
            .expect("bind profile margin limit");
        assert_eq!(
            precheck_input
                .get("maxSingleTradeMarginPct")
                .and_then(Value::as_u64),
            Some(30)
        );

        let legacy_full = test_ai_tool_context("full", "main", false);
        assert!(authorize_ai_tool("tradeOpportunity.create", &legacy_full).is_ok());
        assert!(authorize_ai_tool("trade.placeOrder", &legacy_full).is_err());

        let limited = test_ai_tool_context("limited_auto", "main", false);
        assert!(authorize_ai_tool("tradeOpportunity.create", &limited).is_ok());
        assert!(authorize_ai_tool("trade.placeOrder", &limited).is_err());

        let subagent = test_ai_tool_context("limited_auto", "subagent", true);
        assert!(authorize_ai_tool("account.readPositions", &subagent).is_ok());
        assert!(authorize_ai_tool("tradeOpportunity.create", &subagent).is_err());
        assert!(authorize_ai_tool("notification.feishu.send", &subagent).is_err());
        assert!(authorize_ai_tool("trade.placeOrder", &subagent).is_err());
        assert!(authorize_ai_tool("trade.setLeverage", &subagent).is_err());
        assert!(authorize_ai_tool("market.readDecisionContext", &subagent).is_err());
    }

    #[test]
    fn account_tools_fail_closed_for_unbound_background_profiles() {
        let mut context = test_ai_tool_context("advisor", "main", false);
        context.account_context_id = Some("ui-current-account".to_string());
        context.run_context = Some(test_background_run_context(None, "off", Vec::new()));
        assert!(authorize_ai_tool("account.readRisk", &context).is_err());
        assert!(authorize_ai_tool("trade.precheck", &context).is_err());
        assert!(authorize_ai_tool("market.readTicker", &context).is_ok());

        let mut input = json!({ "instId": "BTC-USDT-SWAP" });
        assert!(enforce_background_run_scope("account.readRisk", &mut input, &context).is_err());
        assert!(enforce_background_run_scope("trade.precheck", &mut input, &context).is_err());
        assert_eq!(
            context.account_context_id.as_deref(),
            Some("ui-current-account")
        );
    }

    #[test]
    fn account_risk_uses_only_usdt_equity_and_excludes_dust() {
        let balance = |ccy: &str, eq: &str| OkxBalance {
            ccy: ccy.to_string(),
            eq: eq.to_string(),
            avail_eq: eq.to_string(),
            avail_bal: eq.to_string(),
            cash_bal: eq.to_string(),
            ..Default::default()
        };
        let value = ai_account_risk_value(PrivateAccountSnapshot {
            account_id: "account-test".to_string(),
            environment: "demo".to_string(),
            balances: vec![
                balance("USDT", "13.326354961220199"),
                balance("PEOPLE", "0.9775162355407337"),
                balance("NFT", "0.8253174705004115"),
            ],
            positions: Vec::new(),
            orders: Vec::new(),
            positions_complete: true,
            position_seq_id: None,
            orders_complete: true,
            orders_error: None,
            synced_at: 1,
        });
        let expected = 13.326354961220199_f64;
        assert!((value["totalEq"].as_f64().unwrap() - expected).abs() < 1e-10);
        assert!((value["usdtEquity"].as_f64().unwrap() - expected).abs() < 1e-10);
        assert_eq!(value["equityCurrency"], "USDT");
        assert_eq!(value["excludedNonUsdtAssetCount"], 2);
        assert_eq!(value["nonUsdtBalancesExcludedFromRisk"], true);
    }

    #[test]
    fn delegated_background_agents_are_bound_to_frozen_scope_allowlists() {
        let market_agent = desic_agent_automation::AiProfileSubAgent {
            id: "market".to_string(),
            name: "市场".to_string(),
            role: "market_structure".to_string(),
            responsibility: "市场结构".to_string(),
            scopes: vec!["market".to_string()],
            required: true,
            enabled: true,
        };
        let risk_agent = desic_agent_automation::AiProfileSubAgent {
            id: "risk".to_string(),
            name: "风险".to_string(),
            role: "account_risk".to_string(),
            responsibility: "账户风险".to_string(),
            scopes: vec!["account".to_string()],
            required: true,
            enabled: true,
        };
        let mut custom = test_ai_tool_context("advisor", "subagent", true);
        custom.configured_agent_id = Some("market".to_string());
        custom.configured_agent_scopes = vec!["market".to_string()];
        custom.run_context = Some(test_background_run_context(
            Some("account-test"),
            "custom",
            vec![market_agent, risk_agent],
        ));
        assert!(authorize_ai_tool("market.readTicker", &custom).is_ok());
        assert!(authorize_ai_tool("account.readRisk", &custom).is_err());

        let mut auto_risk = test_ai_tool_context("advisor", "subagent", true);
        auto_risk.configured_agent_id = Some("auto-account-risk".to_string());
        auto_risk.configured_agent_scopes = vec![
            "account".to_string(),
            "history".to_string(),
            "market".to_string(),
        ];
        auto_risk.run_context = Some(test_background_run_context(
            Some("account-test"),
            "auto",
            Vec::new(),
        ));
        assert!(authorize_ai_tool("account.readRisk", &auto_risk).is_ok());
        assert!(authorize_ai_tool("intelligence.news.list", &auto_risk).is_err());
    }

    #[test]
    fn automatic_agent_scope_contract_matches_sidecar_roster() {
        let expected = [
            ("auto-market-structure", &["market", "derivatives"][..]),
            ("auto-order-flow-liquidity", &["market"][..]),
            (
                "auto-derivatives-positioning",
                &["derivatives", "market"][..],
            ),
            ("auto-account-risk", &["account", "history", "market"][..]),
            ("auto-intelligence-flow", &["intelligence"][..]),
            ("auto-smart-money", &["intelligence", "derivatives"][..]),
            ("auto-historical-analogy", &["history", "market"][..]),
            (
                "auto-contrarian-review",
                &["market", "derivatives", "intelligence", "history"][..],
            ),
        ];
        for (id, scopes) in expected {
            assert_eq!(auto_profile_agent_scopes(id), Some(scopes), "{id}");
        }
        assert_eq!(auto_profile_agent_scopes("auto-unknown"), None);
    }

    #[test]
    fn background_scope_leaves_intelligence_account_injection_to_executor() {
        let mut context = test_ai_tool_context("advisor", "main", false);
        context.account_context_id = Some("account-profile".to_string());
        context.run_context = Some(BackgroundRunContext {
            permission_mode: "advisor".to_string(),
            account_id: Some("account-profile".to_string()),
            environment: Some("live".to_string()),
            symbols: vec!["BTC-USDT-SWAP".to_string()],
            profile_id: Some("profile-test".to_string()),
            run_id: Some("run-test".to_string()),
            enabled_skills: Vec::new(),
            skill_versions: HashMap::new(),
            skill_definitions: Vec::new(),
            model: None,
            reasoning_depth: "medium".to_string(),
            history_lookback_days: 30,
            target_leverage: 20,
            max_single_trade_margin_pct: 30,
            allowed_wake_condition_types: Vec::new(),
            multi_agent_mode: desic_agent_automation::MULTI_AGENT_OFF_MODE.to_string(),
            multi_agent_max_agents: 4,
            multi_agents: Vec::new(),
            review_id: None,
            episode_id: None,
        });

        let mut intelligence_input = json!({ "instId": "BTC-USDT-SWAP" });
        enforce_background_run_scope(
            "intelligence.smartMoney.readFundingBasis",
            &mut intelligence_input,
            &context,
        )
        .expect("scope intelligence tool");
        assert!(intelligence_input.get("accountId").is_none());

        let mut account_input = json!({});
        enforce_background_run_scope("account.readPositions", &mut account_input, &context)
            .expect("scope account tool");
        assert_eq!(
            account_input.get("accountId").and_then(Value::as_str),
            Some("account-profile")
        );
    }
}
