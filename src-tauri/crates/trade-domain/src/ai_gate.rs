//! AI 自动化开仓的硬风控（「风控官」）。
//!
//! 只服务于 AI 自动化 Profile 产生的**开仓**机会；平仓、撤单、改单不经过这里，风控不能挡住止损。
//! 全部是纯函数：调用方负责把账户、行情、今日盈亏、并发数等事实读好再传进来。
//! 任何事实缺失都按「拒绝」处理（失败即关闭），而不是当作 0 放行。
//!
//! 风险与盈亏比统一用 [`crate::evaluate_linear_usdt_perpetual`] 的含费口径（与 trade_precheck 一致）。

use serde::{Deserialize, Serialize};

use crate::{calculate_linear_usdt_risk_budget, LinearUsdtDirection, LinearUsdtRiskBudgetRequest};

/// Profile 上的风控预算。数值已由调用方夹取到合法范围。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRiskLimits {
    /// 单笔止损（含双边手续费）最多占权益的百分比。
    pub risk_per_trade_pct: f64,
    /// 净盈亏比下限（目标净收益 ÷ 含费止损亏损）。
    pub min_reward_risk: f64,
    /// 今日已实现亏损达到权益的这个百分比后，停止开仓。
    pub daily_loss_limit_pct: f64,
    /// 本 Profile 同时存在的持仓 + 进行中的开仓机会上限。
    pub max_open_positions: u32,
    /// 市价开仓相对决策时价格允许的最大偏离（基点）。
    pub max_entry_drift_bps: f64,
}

/// 一条拒绝原因：`code` 给程序和审计，`message` 给模型和界面。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateReason {
    pub code: String,
    pub message: String,
}

impl GateReason {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into() }
    }

    /// `code：message`，与现有阻断原因的拼接格式一致。
    pub fn display(&self) -> String {
        format!("{}：{}", self.code, self.message)
    }
}

/// 不需要账户与行情就能判断的规则：开仓必须带止损和止盈；暂不允许计划委托开仓（它挂不了附带止损）。
pub fn ai_open_static_reasons(order_type: &str, has_stop_loss: bool, has_take_profit: bool) -> Vec<GateReason> {
    let mut reasons = Vec::new();
    if order_type.eq_ignore_ascii_case("trigger") {
        reasons.push(GateReason::new(
            "trigger_open_not_allowed",
            "AI 自动化暂不允许用计划委托开仓（计划委托无法附带止损）；请改用限价或市价开仓并附带止损",
        ));
    }
    if !has_stop_loss {
        reasons.push(GateReason::new(
            "stop_required",
            "AI 自动化开仓必须附带止损（stopLoss.triggerPx）；失效价不能代替止损",
        ));
    }
    if !has_take_profit {
        reasons.push(GateReason::new(
            "take_profit_required",
            "AI 自动化开仓必须附带止盈（takeProfit.triggerPx），否则无法校验盈亏比",
        ));
    }
    reasons
}

/// 按风险预算反推最大张数所需的合约与费率信息（字符串小数，直接交给领域函数）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiSizingInputs {
    pub entry_price: String,
    pub stop_price: String,
    pub contract_value: String,
    pub entry_fee_rate: String,
    pub exit_fee_rate: String,
    pub min_size: String,
    pub lot_size: String,
}

/// 开仓前需要的账户事实与候选的风险评估结果。`None` 表示读不到。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AiOpenGateInput {
    pub equity: Option<f64>,
    /// 含双边手续费的止损亏损占权益百分比。
    pub stop_risk_pct_of_equity: Option<f64>,
    pub net_reward_risk_ratio: Option<f64>,
    /// 今日已实现盈亏（USDT，亏损为负）。
    pub today_realized_pnl: Option<f64>,
    pub open_exposure_count: Option<u32>,
    pub sizing: Option<AiSizingInputs>,
}

/// 今日亏损熔断：读不到权益或今日盈亏时同样拒绝。
pub fn daily_loss_reason(today_realized_pnl: Option<f64>, equity: Option<f64>, limit_pct: f64) -> Option<GateReason> {
    let (Some(pnl), Some(equity)) = (today_realized_pnl.filter(|v| v.is_finite()), equity.filter(|v| v.is_finite() && *v > 0.0)) else {
        return Some(GateReason::new("equity_unavailable", "读不到账户权益或今日已实现盈亏，无法校验今日亏损上限，暂停开仓"));
    };
    let pct = pnl / equity * 100.0;
    (pct <= -limit_pct).then(|| {
        GateReason::new(
            "daily_loss_limit",
            format!("今日已实现亏损 {:.2} USDT（权益的 {:.2}%），已达到每日亏损上限 {}%，今天不再开仓；平仓不受影响", -pnl, -pct, trim(limit_pct)),
        )
    })
}

fn trim(value: f64) -> String {
    let text = format!("{value:.4}");
    let text = text.trim_end_matches('0').trim_end_matches('.');
    if text.is_empty() { "0".to_string() } else { text.to_string() }
}

/// 风险预算下最多能开多少张；`None` 表示信息不足算不出。第二个值为 true 表示连最小张数都超出预算。
pub fn max_size_within_budget(sizing: &AiSizingInputs, equity: f64, risk_pct: f64) -> Option<(String, bool)> {
    let budget = equity * risk_pct / 100.0;
    if !(budget.is_finite() && budget > 0.0) {
        return None;
    }
    let result = calculate_linear_usdt_risk_budget(&LinearUsdtRiskBudgetRequest {
        risk_budget: format!("{budget:.10}"),
        equity: Some(format!("{equity:.10}")),
        entry_price: sizing.entry_price.clone(),
        stop_price: sizing.stop_price.clone(),
        contract_value: sizing.contract_value.clone(),
        entry_fee_rate: sizing.entry_fee_rate.clone(),
        exit_fee_rate: sizing.exit_fee_rate.clone(),
        min_size: sizing.min_size.clone(),
        lot_size: sizing.lot_size.clone(),
    })
    .ok()?;
    Some((result.normalized_size, result.minimum_size_applied && result.exceeds_budget))
}

/// 开仓前的全部账户级风控（静态规则另见 [`ai_open_static_reasons`]）。
pub fn evaluate_ai_open_gate(input: &AiOpenGateInput, limits: &AiRiskLimits) -> Vec<GateReason> {
    let mut reasons = Vec::new();
    if let Some(reason) = daily_loss_reason(input.today_realized_pnl, input.equity, limits.daily_loss_limit_pct) {
        reasons.push(reason);
    }
    match input.open_exposure_count {
        Some(count) if count >= limits.max_open_positions => reasons.push(GateReason::new(
            "concurrent_limit",
            format!("本 Profile 已有 {count} 个持仓或进行中的开仓机会，达到上限 {}；先管理已有仓位", limits.max_open_positions),
        )),
        None => reasons.push(GateReason::new("exposure_unavailable", "读不到本 Profile 的持仓与挂单数量，暂停开仓")),
        _ => {}
    }
    match input.stop_risk_pct_of_equity.filter(|v| v.is_finite()) {
        Some(risk) if risk > limits.risk_per_trade_pct => {
            let sizing_hint = match (input.sizing.as_ref(), input.equity) {
                (Some(sizing), Some(equity)) => match max_size_within_budget(sizing, equity, limits.risk_per_trade_pct) {
                    Some((_, true)) => format!("账户太小：按这个止损，最小张数 {} 的风险已超过预算；不要开这一笔", sizing.min_size),
                    Some((size, false)) => format!("按这个止损最多开 {size} 张"),
                    None => "请缩小数量或收紧止损".to_string(),
                },
                _ => "请缩小数量或收紧止损".to_string(),
            };
            reasons.push(GateReason::new(
                "risk_over_budget",
                format!("止损亏损（含手续费）占权益 {}%，超过单笔风险上限 {}%；{sizing_hint}", trim(risk), trim(limits.risk_per_trade_pct)),
            ));
        }
        None => reasons.push(GateReason::new("risk_unavailable", "无法计算止损亏损占权益的比例（缺少止损、权益或合约信息），不能开仓")),
        _ => {}
    }
    match input.net_reward_risk_ratio.filter(|v| v.is_finite()) {
        Some(ratio) if ratio < limits.min_reward_risk => reasons.push(GateReason::new(
            "reward_risk_below_floor",
            format!("净盈亏比 {}（已扣手续费）低于下限 {}；调整止盈或止损", trim(ratio), trim(limits.min_reward_risk)),
        )),
        None => reasons.push(GateReason::new("reward_risk_unavailable", "无法计算净盈亏比（缺少止盈或止损），不能开仓")),
        _ => {}
    }
    reasons
}

/// 真正下单那一刻的检查输入。
#[derive(Debug, Clone, PartialEq)]
pub struct AiExecutionGuardInput {
    pub direction: LinearUsdtDirection,
    pub order_type: String,
    pub stop_price: Option<f64>,
    /// 下单前读到的最新价。
    pub last_price: Option<f64>,
    /// 做决定时的价格（机会保存的行情快照）。
    pub reference_price: Option<f64>,
    /// 机会自带的滑点上限；没有就用 Profile 的 `max_entry_drift_bps`。
    pub max_slippage_bps: Option<f64>,
    pub equity: Option<f64>,
    pub today_realized_pnl: Option<f64>,
}

/// 下单前的最后一道检查：价格是否已经越过止损、市价单是否偏离决策价太多、今日是否已触发熔断。
pub fn evaluate_ai_execution_guard(input: &AiExecutionGuardInput, limits: &AiRiskLimits) -> Vec<GateReason> {
    let mut reasons = Vec::new();
    let Some(last) = input.last_price.filter(|v| v.is_finite() && *v > 0.0) else {
        return vec![GateReason::new("price_unavailable", "下单前读不到最新价格，为安全起见不执行")];
    };
    if let Some(stop) = input.stop_price.filter(|v| v.is_finite() && *v > 0.0) {
        let crossed = match input.direction {
            LinearUsdtDirection::Long => last <= stop,
            LinearUsdtDirection::Short => last >= stop,
        };
        if crossed {
            reasons.push(GateReason::new(
                "price_through_stop",
                format!("最新价 {} 已越过止损 {}，这笔交易的前提已失效，不执行", trim(last), trim(stop)),
            ));
        }
    }
    if input.order_type.eq_ignore_ascii_case("market") {
        let limit_bps = input.max_slippage_bps.filter(|v| v.is_finite() && *v > 0.0).unwrap_or(limits.max_entry_drift_bps);
        match input.reference_price.filter(|v| v.is_finite() && *v > 0.0) {
            Some(reference) => {
                let drift_bps = (last - reference).abs() / reference * 10_000.0;
                if drift_bps > limit_bps {
                    reasons.push(GateReason::new(
                        "entry_drift_over_limit",
                        format!("最新价 {} 相对决策时价格 {} 偏离 {:.1} 个基点，超过上限 {}，不追价执行", trim(last), trim(reference), drift_bps, trim(limit_bps)),
                    ));
                }
            }
            None => reasons.push(GateReason::new("reference_price_unavailable", "找不到做决定时的价格，无法判断市价单是否追价，不执行")),
        }
    }
    if let Some(reason) = daily_loss_reason(input.today_realized_pnl, input.equity, limits.daily_loss_limit_pct) {
        reasons.push(reason);
    }
    reasons
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIMITS: AiRiskLimits = AiRiskLimits {
        risk_per_trade_pct: 1.0,
        min_reward_risk: 1.2,
        daily_loss_limit_pct: 3.0,
        max_open_positions: 2,
        max_entry_drift_bps: 30.0,
    };

    fn ok_input() -> AiOpenGateInput {
        AiOpenGateInput {
            equity: Some(1000.0),
            stop_risk_pct_of_equity: Some(0.8),
            net_reward_risk_ratio: Some(2.0),
            today_realized_pnl: Some(-5.0),
            open_exposure_count: Some(0),
            sizing: Some(AiSizingInputs {
                entry_price: "100".into(),
                stop_price: "98".into(),
                contract_value: "1".into(),
                entry_fee_rate: "0.0005".into(),
                exit_fee_rate: "0.0005".into(),
                min_size: "0.01".into(),
                lot_size: "0.01".into(),
            }),
        }
    }

    fn codes(reasons: &[GateReason]) -> Vec<&str> {
        reasons.iter().map(|reason| reason.code.as_str()).collect()
    }

    #[test]
    fn static_rules_require_stop_and_take_profit_and_forbid_trigger_opens() {
        assert!(ai_open_static_reasons("limit", true, true).is_empty());
        assert!(ai_open_static_reasons("market", true, true).is_empty());
        assert_eq!(codes(&ai_open_static_reasons("limit", false, true)), ["stop_required"]);
        assert_eq!(codes(&ai_open_static_reasons("limit", true, false)), ["take_profit_required"]);
        assert_eq!(codes(&ai_open_static_reasons("TRIGGER", true, true)), ["trigger_open_not_allowed"]);
        assert_eq!(codes(&ai_open_static_reasons("trigger", false, false)).len(), 3);
    }

    #[test]
    fn a_compliant_candidate_passes() {
        assert!(evaluate_ai_open_gate(&ok_input(), &LIMITS).is_empty());
    }

    #[test]
    fn risk_over_budget_reports_the_largest_size_that_fits() {
        let input = AiOpenGateInput { stop_risk_pct_of_equity: Some(2.5), ..ok_input() };
        let reasons = evaluate_ai_open_gate(&input, &LIMITS);
        assert_eq!(codes(&reasons), ["risk_over_budget"]);
        // 预算 10 USDT；每张风险 = 1×2 + 手续费(100×0.0005 + 98×0.0005)=2.099 → 4.76 张，按 0.01 取整到 4.76。
        assert!(reasons[0].message.contains("最多开 4.76 张"), "{}", reasons[0].message);
        // 边界：恰好等于上限放行
        assert!(evaluate_ai_open_gate(&AiOpenGateInput { stop_risk_pct_of_equity: Some(1.0), ..ok_input() }, &LIMITS).is_empty());
    }

    #[test]
    fn tiny_accounts_are_told_the_minimum_size_already_exceeds_the_budget() {
        let mut input = AiOpenGateInput { equity: Some(1.43), stop_risk_pct_of_equity: Some(150.0), today_realized_pnl: Some(0.0), ..ok_input() };
        input.sizing.as_mut().unwrap().min_size = "1".into();
        input.sizing.as_mut().unwrap().lot_size = "1".into();
        let reasons = evaluate_ai_open_gate(&input, &LIMITS);
        assert_eq!(codes(&reasons), ["risk_over_budget"]);
        assert!(reasons[0].message.contains("账户太小"), "{}", reasons[0].message);
    }

    #[test]
    fn reward_risk_floor_and_missing_values_fail_closed() {
        assert_eq!(codes(&evaluate_ai_open_gate(&AiOpenGateInput { net_reward_risk_ratio: Some(1.1), ..ok_input() }, &LIMITS)), ["reward_risk_below_floor"]);
        assert!(evaluate_ai_open_gate(&AiOpenGateInput { net_reward_risk_ratio: Some(1.2), ..ok_input() }, &LIMITS).is_empty());
        assert_eq!(codes(&evaluate_ai_open_gate(&AiOpenGateInput { net_reward_risk_ratio: None, ..ok_input() }, &LIMITS)), ["reward_risk_unavailable"]);
        assert_eq!(codes(&evaluate_ai_open_gate(&AiOpenGateInput { stop_risk_pct_of_equity: None, ..ok_input() }, &LIMITS)), ["risk_unavailable"]);
        assert_eq!(codes(&evaluate_ai_open_gate(&AiOpenGateInput { open_exposure_count: None, ..ok_input() }, &LIMITS)), ["exposure_unavailable"]);
    }

    #[test]
    fn daily_loss_breaker_blocks_and_never_treats_missing_data_as_zero() {
        assert_eq!(codes(&evaluate_ai_open_gate(&AiOpenGateInput { today_realized_pnl: Some(-30.0), ..ok_input() }, &LIMITS)), ["daily_loss_limit"]);
        assert!(evaluate_ai_open_gate(&AiOpenGateInput { today_realized_pnl: Some(-29.9), ..ok_input() }, &LIMITS).is_empty());
        assert!(evaluate_ai_open_gate(&AiOpenGateInput { today_realized_pnl: Some(120.0), ..ok_input() }, &LIMITS).is_empty());
        assert_eq!(codes(&evaluate_ai_open_gate(&AiOpenGateInput { today_realized_pnl: None, ..ok_input() }, &LIMITS)), ["equity_unavailable"]);
        assert!(codes(&evaluate_ai_open_gate(&AiOpenGateInput { equity: None, ..ok_input() }, &LIMITS)).contains(&"equity_unavailable"));
    }

    #[test]
    fn concurrency_limit_counts_positions_and_pending_opens() {
        assert!(evaluate_ai_open_gate(&AiOpenGateInput { open_exposure_count: Some(1), ..ok_input() }, &LIMITS).is_empty());
        assert_eq!(codes(&evaluate_ai_open_gate(&AiOpenGateInput { open_exposure_count: Some(2), ..ok_input() }, &LIMITS)), ["concurrent_limit"]);
    }

    fn guard(order_type: &str, direction: LinearUsdtDirection, last: Option<f64>) -> AiExecutionGuardInput {
        AiExecutionGuardInput {
            direction,
            order_type: order_type.into(),
            stop_price: Some(98.0),
            last_price: last,
            reference_price: Some(100.0),
            max_slippage_bps: None,
            equity: Some(1000.0),
            today_realized_pnl: Some(0.0),
        }
    }

    #[test]
    fn execution_guard_rejects_when_price_already_went_through_the_stop() {
        assert!(evaluate_ai_execution_guard(&guard("limit", LinearUsdtDirection::Long, Some(99.0)), &LIMITS).is_empty());
        assert_eq!(codes(&evaluate_ai_execution_guard(&guard("limit", LinearUsdtDirection::Long, Some(98.0)), &LIMITS)), ["price_through_stop"]);
        let mut short = guard("limit", LinearUsdtDirection::Short, Some(101.0));
        short.stop_price = Some(102.0);
        assert!(evaluate_ai_execution_guard(&short, &LIMITS).is_empty());
        short.last_price = Some(102.5);
        assert_eq!(codes(&evaluate_ai_execution_guard(&short, &LIMITS)), ["price_through_stop"]);
    }

    #[test]
    fn execution_guard_stops_market_orders_from_chasing() {
        // 30 bps：100 → 100.3 恰好放行，100.31 拒绝
        assert!(evaluate_ai_execution_guard(&guard("market", LinearUsdtDirection::Long, Some(100.3)), &LIMITS).is_empty());
        assert_eq!(codes(&evaluate_ai_execution_guard(&guard("market", LinearUsdtDirection::Long, Some(100.31)), &LIMITS)), ["entry_drift_over_limit"]);
        // 机会自带的滑点上限优先
        let mut tight = guard("market", LinearUsdtDirection::Long, Some(100.1));
        tight.max_slippage_bps = Some(5.0);
        assert_eq!(codes(&evaluate_ai_execution_guard(&tight, &LIMITS)), ["entry_drift_over_limit"]);
        // 限价单不检查偏离（价格由挂单本身决定）
        assert!(evaluate_ai_execution_guard(&guard("limit", LinearUsdtDirection::Long, Some(105.0)), &LIMITS).is_empty());
        let mut no_reference = guard("market", LinearUsdtDirection::Long, Some(100.0));
        no_reference.reference_price = None;
        assert_eq!(codes(&evaluate_ai_execution_guard(&no_reference, &LIMITS)), ["reference_price_unavailable"]);
    }

    #[test]
    fn execution_guard_fails_closed_without_a_price_and_rechecks_the_daily_breaker() {
        assert_eq!(codes(&evaluate_ai_execution_guard(&guard("limit", LinearUsdtDirection::Long, None), &LIMITS)), ["price_unavailable"]);
        let mut losing = guard("limit", LinearUsdtDirection::Long, Some(99.0));
        losing.today_realized_pnl = Some(-31.0);
        assert_eq!(codes(&evaluate_ai_execution_guard(&losing, &LIMITS)), ["daily_loss_limit"]);
    }

    #[test]
    fn reasons_render_with_the_existing_code_prefix_format() {
        let reason = &ai_open_static_reasons("limit", false, true)[0];
        assert!(reason.display().starts_with("stop_required："));
    }
}
