//! AI 界面指挥工具（`ui.*`）：让交互式 AI 研究会话在用户眼前切合约、周期、指标与工作区。
//!
//! 全部是显示层的可逆操作：不读写账户、订单、Profile 或策略，也不落库。本模块只做三件事：
//! 授权（与侧车 `UI_CONTROL_TOOLS` 同口径）、严格校验入参（白名单 + 拒绝未知字段）、
//! 把校验后的动作以 `ai:ui-action` 事件交给前端执行器。事件是「请求」，不是「结果」——
//! Rust 看不到界面是否真的变了，所以工具回给模型的内容只确认「已发出」。

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::Emitter;

pub(crate) const UI_ACTION_EVENT: &str = "ai:ui-action";

const WORKSPACES: &[&str] = &[
    "ai",
    "terminal",
    "radar",
    "opportunities",
    "automation",
    "intelligence",
    "systematic",
    "data",
    "config",
];
const TIMEFRAMES: &[&str] = &["1m", "3m", "5m", "15m", "30m", "1H", "2H", "4H", "6H", "12H", "1D"];
const INDICATORS: &[&str] = &[
    "ma", "ema", "vwap", "boll", "donchian", "keltner", "psar", "supertrend", "ichimoku", "rsi",
    "macd", "kdj", "atr", "adx", "stochastic", "cci", "roc", "aroon", "trix", "williams-r", "mfi",
    "cmf", "obv", "volume-ma",
];

/// 任何 `ui.` 前缀都归本模块处理：未登记的名字也在这里被拒绝，而不是落到别处。
pub(crate) fn is_ui_control_tool(canonical: &str) -> bool {
    canonical.starts_with("ui.")
}

fn is_known_tool(canonical: &str) -> bool {
    matches!(
        canonical,
        "ui.openWorkspace"
            | "ui.setInstrument"
            | "ui.setTimeframe"
            | "ui.addIndicator"
            | "ui.removeIndicator"
            | "ui.setOrderFlow"
    )
}

pub(crate) fn authorize(
    canonical: &str,
    is_main: bool,
    in_run: bool,
    strategy_session_kind: &str,
    ui_control: bool,
) -> Result<(), String> {
    if !is_known_tool(canonical) {
        return Err(format!("未知的界面指挥工具：{canonical}"));
    }
    if !is_main {
        return Err(format!("{canonical} 仅允许主 Agent 调用"));
    }
    if in_run {
        return Err(format!("{canonical} 仅用于交互式 AI 研究，后台 / 复盘 Run 一律拒绝"));
    }
    if strategy_session_kind != "trading-research" {
        return Err(format!("{canonical} 仅用于 AI 研究会话"));
    }
    // 只有语音导演会话才能指挥界面；普通 AI 研究不会自动切合约 / 周期 / 工作区。
    if !ui_control {
        return Err(format!("{canonical} 仅限语音导演会话"));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceInput {
    section: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InstrumentInput {
    #[serde(rename = "instId")]
    inst_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TimeframeInput {
    bar: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IndicatorInput {
    indicator: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OrderFlowInput {
    enabled: bool,
}

fn parse<T: for<'de> Deserialize<'de>>(input: Value) -> Result<T, String> {
    serde_json::from_value(input).map_err(|error| format!("界面指挥参数无效：{error}"))
}

fn valid_swap_inst_id(value: &str) -> bool {
    value
        .strip_suffix("-USDT-SWAP")
        .is_some_and(|base| !base.is_empty() && base.len() <= 20 && base.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()))
}

/// 校验并规整为前端事件里的 `payload`。任何不在白名单里的取值一律拒绝，不做猜测。
pub(crate) fn normalize(canonical: &str, input: Value) -> Result<Value, String> {
    match canonical {
        "ui.openWorkspace" => {
            let args: WorkspaceInput = parse(input)?;
            if !WORKSPACES.contains(&args.section.as_str()) {
                return Err(format!("未知的工作区：{}", args.section));
            }
            Ok(json!({ "section": args.section }))
        }
        "ui.setInstrument" => {
            let args: InstrumentInput = parse(input)?;
            let inst_id = args.inst_id.trim().to_ascii_uppercase();
            if !valid_swap_inst_id(&inst_id) {
                return Err("instId 必须是 OKX USDT 永续合约，例如 ETH-USDT-SWAP".to_string());
            }
            Ok(json!({ "instId": inst_id }))
        }
        "ui.setTimeframe" => {
            let args: TimeframeInput = parse(input)?;
            if !TIMEFRAMES.contains(&args.bar.as_str()) {
                return Err(format!("不支持的周期：{}", args.bar));
            }
            Ok(json!({ "bar": args.bar }))
        }
        "ui.addIndicator" | "ui.removeIndicator" => {
            let args: IndicatorInput = parse(input)?;
            if !INDICATORS.contains(&args.indicator.as_str()) {
                return Err(format!("不支持的指标：{}", args.indicator));
            }
            Ok(json!({ "indicator": args.indicator }))
        }
        "ui.setOrderFlow" => {
            let args: OrderFlowInput = parse(input)?;
            Ok(json!({ "enabled": args.enabled }))
        }
        other => Err(format!("未知的界面指挥工具：{other}")),
    }
}

pub(crate) fn execute(
    app: &tauri::AppHandle,
    canonical: &str,
    input: Value,
    session_id: &str,
    now_ms: i64,
) -> Result<Value, String> {
    let payload = normalize(canonical, input)?;
    let id = format!("ui-{now_ms}");
    app.emit(
        UI_ACTION_EVENT,
        json!({
            "id": id,
            "sessionId": session_id,
            "toolName": canonical,
            "payload": payload,
            "createdAt": now_ms,
        }),
    )
    .map_err(|error| format!("界面指令发送失败：{error}"))?;
    // 诚实回执：只说明请求已发出，不声称界面已变化（前端会再按当前可用合约 / 指标校验一遍）。
    Ok(json!({
        "requested": true,
        "toolName": canonical,
        "applied": payload,
        "note": "请求已发送到界面，用户可见并可撤销；不保证界面已经变化。"
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorize_limits_to_main_interactive_research() {
        for tool in ["ui.openWorkspace", "ui.setInstrument", "ui.setTimeframe", "ui.addIndicator", "ui.removeIndicator", "ui.setOrderFlow"] {
            assert!(authorize(tool, true, false, "trading-research", true).is_ok(), "{tool}");
            assert!(authorize(tool, false, false, "trading-research", true).is_err(), "委派角色必须被拒绝：{tool}");
            assert!(authorize(tool, true, true, "trading-research", true).is_err(), "后台/复盘 Run 必须被拒绝：{tool}");
            assert!(authorize(tool, true, false, "editor", true).is_err(), "策略编辑器会话必须被拒绝：{tool}");
            assert!(authorize(tool, true, false, "indicator", true).is_err());
            assert!(authorize(tool, true, false, "", true).is_err());
            // 普通 AI 研究会话（没有 ui_control）一律拒绝：只有语音导演可以指挥界面
            assert!(authorize(tool, true, false, "trading-research", false).is_err(), "非语音会话必须被拒绝：{tool}");
        }
    }

    #[test]
    fn unknown_ui_tools_fail_closed() {
        assert!(is_ui_control_tool("ui.placeOrder"));
        assert!(authorize("ui.placeOrder", true, false, "trading-research", true).is_err());
        assert!(authorize("ui.", true, false, "trading-research", true).is_err());
        assert!(normalize("ui.placeOrder", json!({})).is_err());
        assert!(!is_ui_control_tool("trade.placeOrder"));
        assert!(!is_ui_control_tool("chart.createDrawing"));
    }

    #[test]
    fn instrument_is_restricted_to_usdt_swaps_and_uppercased() {
        assert_eq!(normalize("ui.setInstrument", json!({"instId": " eth-usdt-swap "})).unwrap(), json!({"instId": "ETH-USDT-SWAP"}));
        for bad in ["ETH-USD-SWAP", "ETH-USDT", "ETH-USDT-SWAP; drop", "-USDT-SWAP", "", "ETH/USDT-USDT-SWAP", "AAAAAAAAAAAAAAAAAAAAA-USDT-SWAP"] {
            assert!(normalize("ui.setInstrument", json!({"instId": bad})).is_err(), "{bad}");
        }
    }

    #[test]
    fn enums_are_exact_and_extra_fields_are_rejected() {
        assert!(normalize("ui.setTimeframe", json!({"bar": "4H"})).is_ok());
        assert!(normalize("ui.setTimeframe", json!({"bar": "4h"})).is_err(), "大小写必须精确");
        assert!(normalize("ui.setTimeframe", json!({"bar": "7m"})).is_err());
        assert!(normalize("ui.addIndicator", json!({"indicator": "williams-r"})).is_ok());
        assert!(normalize("ui.addIndicator", json!({"indicator": "EMA"})).is_err());
        assert!(normalize("ui.openWorkspace", json!({"section": "radar"})).is_ok());
        assert!(normalize("ui.openWorkspace", json!({"section": "trade"})).is_err());
        assert!(normalize("ui.setOrderFlow", json!({"enabled": true})).is_ok());
        assert!(normalize("ui.setOrderFlow", json!({"enabled": "true"})).is_err(), "必须是真布尔");
        assert!(normalize("ui.setTimeframe", json!({"bar": "1H", "instId": "BTC-USDT-SWAP"})).is_err(), "未知字段拒绝");
        assert!(normalize("ui.setTimeframe", json!({})).is_err());
    }

    #[test]
    fn schemas_in_sidecar_match_rust_whitelists() {
        // 侧车 schema、前端校验与这里的白名单三处必须一致；这里读取侧车源码做字面比对。
        let source = include_str!("../../scripts/cline-sidecar.mjs");
        let list_of = |name: &str| -> Vec<String> {
            let start = source.find(&format!("export const {name} = [")).expect(name);
            let rest = &source[start..];
            let open = rest.find('[').unwrap();
            let close = rest.find(']').unwrap();
            rest[open + 1..close]
                .split(',')
                .map(|item| item.trim().trim_matches('"').to_string())
                .filter(|item| !item.is_empty())
                .collect()
        };
        assert_eq!(list_of("UI_WORKSPACE_IDS"), WORKSPACES);
        assert_eq!(list_of("UI_TIMEFRAME_IDS"), TIMEFRAMES);
        assert_eq!(list_of("UI_INDICATOR_IDS"), INDICATORS);
    }
}
