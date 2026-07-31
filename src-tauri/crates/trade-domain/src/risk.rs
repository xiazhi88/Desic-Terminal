use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

use crate::numeric::{FixedDecimal, TradeDomainError};

const PERCENT_OUTPUT_SCALE: u32 = 12;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearUsdtRiskBudgetRequest {
    pub risk_budget: String,
    pub equity: Option<String>,
    pub entry_price: String,
    pub stop_price: String,
    pub contract_value: String,
    pub entry_fee_rate: String,
    pub exit_fee_rate: String,
    pub min_size: String,
    pub lot_size: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearUsdtRiskBudget {
    pub normalized_size: String,
    pub estimated_price_loss: String,
    pub estimated_round_trip_fee: String,
    pub estimated_loss_with_fees: String,
    pub pct_of_equity: Option<String>,
    pub exceeds_budget: bool,
    pub minimum_size_applied: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearUsdtPerpetualEvaluationRequest {
    pub size: String,
    pub entry_price: String,
    pub contract_value: String,
    pub leverage: String,
    pub min_size: String,
    pub lot_size: String,
    pub equity: Option<String>,
    pub available_usdt: Option<String>,
    pub max_single_trade_margin_pct: Option<String>,
    pub stop_price: Option<String>,
    pub atr: Option<String>,
    pub entry_fee_rate: String,
    pub exit_fee_rate: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearUsdtPositionMetrics {
    pub size: String,
    pub base_quantity: String,
    pub notional_usdt: String,
    /// Gross notional divided by account equity. For example, 0.48 means
    /// a 1% underlying move changes equity by roughly 0.48% before costs.
    pub effective_exposure_multiple: Option<String>,
    pub notional_pct_of_equity: Option<String>,
    pub estimated_initial_margin_usdt: String,
    pub margin_pct_of_equity: Option<String>,
    pub stop_price: Option<String>,
    pub stop_distance: Option<String>,
    pub stop_move_pct: Option<String>,
    pub estimated_price_loss_at_stop_usdt: Option<String>,
    pub estimated_entry_fee_usdt: String,
    pub estimated_exit_fee_usdt: String,
    pub estimated_round_trip_fee_usdt: String,
    pub estimated_stop_loss_with_fees_usdt: Option<String>,
    pub stop_risk_pct_of_equity: Option<String>,
    pub atr: Option<String>,
    pub one_atr_price_loss_usdt: Option<String>,
    pub one_atr_risk_pct_of_equity: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearUsdtTradeCapacity {
    pub equity_usdt: Option<String>,
    pub available_usdt: Option<String>,
    pub max_single_trade_margin_pct: Option<String>,
    pub max_single_trade_margin_usdt: Option<String>,
    pub max_single_trade_notional_usdt: Option<String>,
    pub max_single_trade_size: Option<String>,
    pub candidate_within_available: Option<bool>,
    pub candidate_within_profile_limit: Option<bool>,
    pub minimum_within_available: Option<bool>,
    pub minimum_within_profile_limit: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearUsdtPerpetualEvaluation {
    pub requested_size: String,
    pub normalized_size: String,
    pub size_was_normalized: bool,
    pub candidate: LinearUsdtPositionMetrics,
    pub minimum_order: LinearUsdtPositionMetrics,
    pub capacity: LinearUsdtTradeCapacity,
}

/// Calculates the account meaning of a linear USDT perpetual position.
///
/// This is the authoritative distinction between gross notional exposure,
/// estimated initial margin and price-risk PnL. Leverage changes the margin
/// requirement for a fixed size; it does not change that size's price PnL.
pub fn evaluate_linear_usdt_perpetual(
    request: &LinearUsdtPerpetualEvaluationRequest,
) -> Result<LinearUsdtPerpetualEvaluation, TradeDomainError> {
    let requested_size = FixedDecimal::parse_positive("size", &request.size)?;
    let entry = FixedDecimal::parse_positive("entryPrice", &request.entry_price)?;
    let contract_value = FixedDecimal::parse_positive("contractValue", &request.contract_value)?;
    let leverage = FixedDecimal::parse_positive("leverage", &request.leverage)?;
    let minimum = FixedDecimal::parse_positive("minSize", &request.min_size)?;
    let lot = FixedDecimal::parse_positive("lotSize", &request.lot_size)?;
    let size = if requested_size.checked_cmp(minimum, "比较 size 与 minSize")? == Ordering::Less
    {
        minimum
    } else {
        let aligned = requested_size.checked_floor_to_step(lot, "按 lotSize 对齐 size")?;
        if aligned.checked_cmp(minimum, "比较对齐后的 size 与 minSize")? == Ordering::Less {
            minimum
        } else {
            aligned
        }
    };
    let equity = request
        .equity
        .as_deref()
        .map(|value| FixedDecimal::parse_positive("equity", value))
        .transpose()?;
    let available = request
        .available_usdt
        .as_deref()
        .map(|value| FixedDecimal::parse_non_negative("availableUsdt", value))
        .transpose()?;
    let profile_pct = request
        .max_single_trade_margin_pct
        .as_deref()
        .map(|value| parse_percentage("maxSingleTradeMarginPct", value))
        .transpose()?;
    let stop = request
        .stop_price
        .as_deref()
        .map(|value| FixedDecimal::parse_positive("stopPrice", value))
        .transpose()?;
    let atr = request
        .atr
        .as_deref()
        .map(|value| FixedDecimal::parse_non_negative("atr", value))
        .transpose()?;
    let entry_fee_rate = FixedDecimal::parse_non_negative("entryFeeRate", &request.entry_fee_rate)?;
    let exit_fee_rate = FixedDecimal::parse_non_negative("exitFeeRate", &request.exit_fee_rate)?;

    let candidate = calculate_position_metrics(
        size,
        entry,
        contract_value,
        leverage,
        equity,
        stop,
        atr,
        entry_fee_rate,
        exit_fee_rate,
    )?;
    let minimum_order = calculate_position_metrics(
        minimum,
        entry,
        contract_value,
        leverage,
        equity,
        stop,
        atr,
        entry_fee_rate,
        exit_fee_rate,
    )?;

    let max_margin = match (equity, available, profile_pct) {
        (Some(equity), Some(available), Some(percent)) => {
            let equity_limit = equity
                .checked_mul(percent, "计算 Profile 保证金上限")?
                .checked_div_to_scale(
                    FixedDecimal::parse_positive("percentBase", "100")?,
                    PERCENT_OUTPUT_SCALE,
                    "计算 Profile 保证金上限",
                )?;
            Some(min_decimal(
                equity_limit,
                available,
                "比较 Profile 与可用保证金上限",
            )?)
        }
        _ => None,
    };
    let max_notional = max_margin
        .map(|margin| margin.checked_mul(leverage, "计算 Profile 名义价值上限"))
        .transpose()?;
    let notional_per_contract = contract_value.checked_mul(entry, "计算每张合约名义价值")?;
    let max_size = max_notional
        .map(|notional| {
            notional
                .checked_div_to_scale(
                    notional_per_contract,
                    PERCENT_OUTPUT_SCALE,
                    "计算 Profile 张数上限",
                )?
                .checked_floor_to_step(lot, "按 lotSize 对齐 Profile 张数上限")
        })
        .transpose()?;

    let candidate_margin = FixedDecimal::parse_non_negative(
        "candidateMargin",
        &candidate.estimated_initial_margin_usdt,
    )?;
    let minimum_margin = FixedDecimal::parse_non_negative(
        "minimumMargin",
        &minimum_order.estimated_initial_margin_usdt,
    )?;
    let candidate_within_available = available
        .map(|limit| decimal_lte(candidate_margin, limit, "比较候选保证金与可用余额"))
        .transpose()?;
    let candidate_within_profile_limit = max_margin
        .map(|limit| decimal_lte(candidate_margin, limit, "比较候选保证金与 Profile 上限"))
        .transpose()?;
    let minimum_within_available = available
        .map(|limit| decimal_lte(minimum_margin, limit, "比较最小保证金与可用余额"))
        .transpose()?;
    let minimum_within_profile_limit = max_margin
        .map(|limit| decimal_lte(minimum_margin, limit, "比较最小保证金与 Profile 上限"))
        .transpose()?;

    Ok(LinearUsdtPerpetualEvaluation {
        requested_size: requested_size.to_plain_string(),
        normalized_size: size.to_plain_string(),
        size_was_normalized: requested_size != size,
        candidate,
        minimum_order,
        capacity: LinearUsdtTradeCapacity {
            equity_usdt: equity.map(FixedDecimal::to_plain_string),
            available_usdt: available.map(FixedDecimal::to_plain_string),
            max_single_trade_margin_pct: profile_pct.map(FixedDecimal::to_plain_string),
            max_single_trade_margin_usdt: max_margin.map(FixedDecimal::to_plain_string),
            max_single_trade_notional_usdt: max_notional.map(FixedDecimal::to_plain_string),
            max_single_trade_size: max_size.map(FixedDecimal::to_plain_string),
            candidate_within_available,
            candidate_within_profile_limit,
            minimum_within_available,
            minimum_within_profile_limit,
        },
    })
}

#[allow(clippy::too_many_arguments)]
fn calculate_position_metrics(
    size: FixedDecimal,
    entry: FixedDecimal,
    contract_value: FixedDecimal,
    leverage: FixedDecimal,
    equity: Option<FixedDecimal>,
    stop: Option<FixedDecimal>,
    atr: Option<FixedDecimal>,
    entry_fee_rate: FixedDecimal,
    exit_fee_rate: FixedDecimal,
) -> Result<LinearUsdtPositionMetrics, TradeDomainError> {
    let base_quantity = size.checked_mul(contract_value, "计算持仓币数量")?;
    let notional = base_quantity.checked_mul(entry, "计算名义价值")?;
    let initial_margin =
        notional.checked_div_to_scale(leverage, PERCENT_OUTPUT_SCALE, "计算预估初始保证金")?;
    let entry_fee = notional.checked_mul(entry_fee_rate, "计算入场手续费")?;
    let exit_price = stop.unwrap_or(entry);
    let exit_notional = base_quantity.checked_mul(exit_price, "计算退出名义价值")?;
    let exit_fee = exit_notional.checked_mul(exit_fee_rate, "计算退出手续费")?;
    let round_trip_fee = entry_fee.checked_add(exit_fee, "计算双边手续费")?;

    let stop_values = stop
        .map(|stop_price| {
            let distance = absolute_difference(entry, stop_price, "计算止损价格距离")?;
            let move_pct = percentage_of(distance, entry, "计算止损价格距离比例")?;
            let price_loss = base_quantity.checked_mul(distance, "计算止损价格亏损")?;
            let with_fees = price_loss.checked_add(round_trip_fee, "计算含手续费止损")?;
            let risk_pct = equity
                .map(|equity| percentage_of(with_fees, equity, "计算止损风险权益比例"))
                .transpose()?;
            Ok::<_, TradeDomainError>((distance, move_pct, price_loss, with_fees, risk_pct))
        })
        .transpose()?;
    let atr_values = atr
        .map(|atr| {
            let loss = base_quantity.checked_mul(atr, "计算一倍 ATR 价格亏损")?;
            let risk_pct = equity
                .map(|equity| percentage_of(loss, equity, "计算一倍 ATR 风险权益比例"))
                .transpose()?;
            Ok::<_, TradeDomainError>((atr, loss, risk_pct))
        })
        .transpose()?;

    Ok(LinearUsdtPositionMetrics {
        size: size.to_plain_string(),
        base_quantity: base_quantity.to_plain_string(),
        notional_usdt: notional.to_plain_string(),
        effective_exposure_multiple: equity
            .map(|equity| {
                notional.checked_div_to_scale(equity, PERCENT_OUTPUT_SCALE, "计算账户有效敞口倍数")
            })
            .transpose()?
            .map(FixedDecimal::to_plain_string),
        notional_pct_of_equity: equity
            .map(|equity| percentage_of(notional, equity, "计算名义价值权益比例"))
            .transpose()?
            .map(FixedDecimal::to_plain_string),
        estimated_initial_margin_usdt: initial_margin.to_plain_string(),
        margin_pct_of_equity: equity
            .map(|equity| percentage_of(initial_margin, equity, "计算保证金权益比例"))
            .transpose()?
            .map(FixedDecimal::to_plain_string),
        stop_price: stop.map(FixedDecimal::to_plain_string),
        stop_distance: stop_values
            .as_ref()
            .map(|(distance, _, _, _, _)| distance.to_plain_string()),
        stop_move_pct: stop_values
            .as_ref()
            .map(|(_, percent, _, _, _)| percent.to_plain_string()),
        estimated_price_loss_at_stop_usdt: stop_values
            .as_ref()
            .map(|(_, _, loss, _, _)| loss.to_plain_string()),
        estimated_entry_fee_usdt: entry_fee.to_plain_string(),
        estimated_exit_fee_usdt: exit_fee.to_plain_string(),
        estimated_round_trip_fee_usdt: round_trip_fee.to_plain_string(),
        estimated_stop_loss_with_fees_usdt: stop_values
            .as_ref()
            .map(|(_, _, _, loss, _)| loss.to_plain_string()),
        stop_risk_pct_of_equity: stop_values
            .as_ref()
            .and_then(|(_, _, _, _, percent)| *percent)
            .map(FixedDecimal::to_plain_string),
        atr: atr_values.as_ref().map(|(atr, _, _)| atr.to_plain_string()),
        one_atr_price_loss_usdt: atr_values
            .as_ref()
            .map(|(_, loss, _)| loss.to_plain_string()),
        one_atr_risk_pct_of_equity: atr_values
            .as_ref()
            .and_then(|(_, _, percent)| *percent)
            .map(FixedDecimal::to_plain_string),
    })
}

fn parse_percentage(field: &'static str, value: &str) -> Result<FixedDecimal, TradeDomainError> {
    let percent = FixedDecimal::parse_positive(field, value)?;
    let maximum = FixedDecimal::parse_positive("percentMaximum", "100")?;
    if percent.checked_cmp(maximum, "校验百分比上限")? == Ordering::Greater {
        return Err(TradeDomainError::AboveMaximum {
            field,
            maximum: "100",
        });
    }
    Ok(percent)
}

fn percentage_of(
    value: FixedDecimal,
    denominator: FixedDecimal,
    operation: &'static str,
) -> Result<FixedDecimal, TradeDomainError> {
    value
        .checked_mul_integer(100, operation)?
        .checked_div_to_scale(denominator, PERCENT_OUTPUT_SCALE, operation)
}

fn absolute_difference(
    left: FixedDecimal,
    right: FixedDecimal,
    operation: &'static str,
) -> Result<FixedDecimal, TradeDomainError> {
    match left.checked_cmp(right, operation)? {
        Ordering::Less => right.checked_sub(left, operation),
        _ => left.checked_sub(right, operation),
    }
}

fn min_decimal(
    left: FixedDecimal,
    right: FixedDecimal,
    operation: &'static str,
) -> Result<FixedDecimal, TradeDomainError> {
    if left.checked_cmp(right, operation)? == Ordering::Greater {
        Ok(right)
    } else {
        Ok(left)
    }
}

fn decimal_lte(
    value: FixedDecimal,
    limit: FixedDecimal,
    operation: &'static str,
) -> Result<bool, TradeDomainError> {
    Ok(value.checked_cmp(limit, operation)? != Ordering::Greater)
}

/// Reverses a USDT risk budget into linear-contract size.
///
/// The risk per contract is `ctVal * |entry-stop|` plus entry and exit fees.
/// Size is floored by `lotSize`, except a positive result below `minSize` is
/// promoted to `minSize` and reported through `minimum_size_applied`.
pub fn calculate_linear_usdt_risk_budget(
    request: &LinearUsdtRiskBudgetRequest,
) -> Result<LinearUsdtRiskBudget, TradeDomainError> {
    let budget = FixedDecimal::parse_positive("riskBudget", &request.risk_budget)?;
    let equity = request
        .equity
        .as_deref()
        .map(|value| FixedDecimal::parse_positive("equity", value))
        .transpose()?;
    let entry = FixedDecimal::parse_positive("entryPrice", &request.entry_price)?;
    let stop = FixedDecimal::parse_positive("stopPrice", &request.stop_price)?;
    let contract_value = FixedDecimal::parse_positive("contractValue", &request.contract_value)?;
    let entry_fee_rate = FixedDecimal::parse_non_negative("entryFeeRate", &request.entry_fee_rate)?;
    let exit_fee_rate = FixedDecimal::parse_non_negative("exitFeeRate", &request.exit_fee_rate)?;
    let minimum = FixedDecimal::parse_positive("minSize", &request.min_size)?;
    let lot = FixedDecimal::parse_positive("lotSize", &request.lot_size)?;

    let price_distance = match entry.checked_cmp(stop, "比较 entryPrice 与 stopPrice")? {
        Ordering::Less => stop.checked_sub(entry, "计算止损价格距离")?,
        _ => entry.checked_sub(stop, "计算止损价格距离")?,
    };
    let price_risk_per_contract = contract_value.checked_mul(price_distance, "计算每张价格风险")?;
    let entry_fee_per_contract = contract_value
        .checked_mul(entry, "计算每张入场名义价值")?
        .checked_mul(entry_fee_rate, "计算每张入场手续费")?;
    let exit_fee_per_contract = contract_value
        .checked_mul(stop, "计算每张退出名义价值")?
        .checked_mul(exit_fee_rate, "计算每张退出手续费")?;
    let round_trip_fee_per_contract =
        entry_fee_per_contract.checked_add(exit_fee_per_contract, "计算每张双边手续费")?;
    let risk_per_contract =
        price_risk_per_contract.checked_add(round_trip_fee_per_contract, "计算每张含手续费风险")?;
    if risk_per_contract.is_zero() {
        return Err(TradeDomainError::ZeroRiskPerContract);
    }

    let minimum_risk = risk_per_contract.checked_mul(minimum, "计算最小下单量风险")?;
    let (normalized_size, minimum_size_applied) = if budget
        .checked_cmp(minimum_risk, "比较风险预算与最小下单量风险")?
        == Ordering::Less
    {
        (minimum, true)
    } else {
        let risk_per_lot = risk_per_contract.checked_mul(lot, "计算每 lot 风险")?;
        let lot_count = budget.checked_floor_ratio(risk_per_lot, "按风险预算反算 lot 数")?;
        let floored_size = lot.checked_mul_integer(lot_count, "按 lot 数反算 size")?;
        if floored_size.checked_cmp(minimum, "比较反算 size 与 minSize")? == Ordering::Less {
            (minimum, true)
        } else {
            (floored_size, false)
        }
    };

    let estimated_price_loss =
        price_risk_per_contract.checked_mul(normalized_size, "计算价格止损")?;
    let estimated_round_trip_fee =
        round_trip_fee_per_contract.checked_mul(normalized_size, "计算双边手续费")?;
    let estimated_loss_with_fees =
        estimated_price_loss.checked_add(estimated_round_trip_fee, "计算含双边手续费止损")?;
    let pct_of_equity = equity
        .map(|equity| {
            estimated_loss_with_fees
                .checked_mul_integer(100, "计算权益风险百分比")?
                .checked_div_to_scale(equity, PERCENT_OUTPUT_SCALE, "计算权益风险百分比")
                .map(FixedDecimal::to_plain_string)
        })
        .transpose()?;
    let exceeds_budget = estimated_loss_with_fees.checked_cmp(budget, "比较实际风险与风险预算")?
        == Ordering::Greater;

    Ok(LinearUsdtRiskBudget {
        normalized_size: normalized_size.to_plain_string(),
        estimated_price_loss: estimated_price_loss.to_plain_string(),
        estimated_round_trip_fee: estimated_round_trip_fee.to_plain_string(),
        estimated_loss_with_fees: estimated_loss_with_fees.to_plain_string(),
        pct_of_equity,
        exceeds_budget,
        minimum_size_applied,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(risk_budget: &str) -> LinearUsdtRiskBudgetRequest {
        LinearUsdtRiskBudgetRequest {
            risk_budget: risk_budget.to_string(),
            equity: Some("1000".to_string()),
            entry_price: "100".to_string(),
            stop_price: "90".to_string(),
            contract_value: "1".to_string(),
            entry_fee_rate: "0.001".to_string(),
            exit_fee_rate: "0.001".to_string(),
            min_size: "1".to_string(),
            lot_size: "1".to_string(),
        }
    }

    #[test]
    fn reverses_budget_with_entry_and_exit_fees_before_flooring_lots() {
        let result = calculate_linear_usdt_risk_budget(&request("100")).unwrap();

        assert_eq!(result.normalized_size, "9");
        assert_eq!(result.estimated_price_loss, "90");
        assert_eq!(result.estimated_round_trip_fee, "1.71");
        assert_eq!(result.estimated_loss_with_fees, "91.71");
        assert_eq!(result.pct_of_equity.as_deref(), Some("9.171"));
        assert!(!result.exceeds_budget);
        assert!(!result.minimum_size_applied);
    }

    #[test]
    fn minimum_size_is_explicit_when_it_exceeds_the_budget() {
        let result = calculate_linear_usdt_risk_budget(&request("1")).unwrap();

        assert_eq!(result.normalized_size, "1");
        assert_eq!(result.estimated_loss_with_fees, "10.19");
        assert!(result.exceeds_budget);
        assert!(result.minimum_size_applied);
    }

    #[test]
    fn rejects_zero_risk_instead_of_dividing_by_zero() {
        let mut zero_risk = request("100");
        zero_risk.stop_price = zero_risk.entry_price.clone();
        zero_risk.entry_fee_rate = "0".to_string();
        zero_risk.exit_fee_rate = "0".to_string();

        assert_eq!(
            calculate_linear_usdt_risk_budget(&zero_risk).unwrap_err(),
            TradeDomainError::ZeroRiskPerContract
        );
    }

    #[test]
    fn supports_fractional_contract_lots_exactly() {
        let result = calculate_linear_usdt_risk_budget(&LinearUsdtRiskBudgetRequest {
            risk_budget: "0.01".to_string(),
            equity: None,
            entry_price: "50000".to_string(),
            stop_price: "49500".to_string(),
            contract_value: "0.01".to_string(),
            entry_fee_rate: "0.0002".to_string(),
            exit_fee_rate: "0.0005".to_string(),
            min_size: "0.01".to_string(),
            lot_size: "0.01".to_string(),
        })
        .unwrap();

        assert_eq!(result.normalized_size, "0.01");
        assert!(result.minimum_size_applied);
        assert!(result.exceeds_budget);
        assert_eq!(result.pct_of_equity, None);
    }

    fn perpetual_request(leverage: &str) -> LinearUsdtPerpetualEvaluationRequest {
        LinearUsdtPerpetualEvaluationRequest {
            size: "0.01".to_string(),
            entry_price: "65168.1".to_string(),
            contract_value: "0.01".to_string(),
            leverage: leverage.to_string(),
            min_size: "0.01".to_string(),
            lot_size: "0.01".to_string(),
            equity: Some("13.3263549612202".to_string()),
            available_usdt: Some("13.3263549612202".to_string()),
            max_single_trade_margin_pct: Some("30".to_string()),
            stop_price: Some("64903.1".to_string()),
            atr: Some("265".to_string()),
            entry_fee_rate: "0.0002".to_string(),
            exit_fee_rate: "0.0005".to_string(),
        }
    }

    #[test]
    fn distinguishes_notional_exposure_from_margin_for_fractional_contracts() {
        let result = evaluate_linear_usdt_perpetual(&perpetual_request("20")).unwrap();

        assert_eq!(result.candidate.base_quantity, "0.0001");
        assert_eq!(result.candidate.notional_usdt, "6.51681");
        let effective_exposure = result
            .candidate
            .effective_exposure_multiple
            .as_deref()
            .unwrap()
            .parse::<f64>()
            .unwrap();
        assert!(effective_exposure > 0.48 && effective_exposure < 0.50);
        assert_eq!(result.candidate.estimated_initial_margin_usdt, "0.3258405");
        assert!(
            result
                .candidate
                .notional_pct_of_equity
                .as_deref()
                .unwrap()
                .parse::<f64>()
                .unwrap()
                > 48.0
        );
        assert!(
            result
                .candidate
                .margin_pct_of_equity
                .as_deref()
                .unwrap()
                .parse::<f64>()
                .unwrap()
                < 2.5
        );
        assert_eq!(
            result.candidate.one_atr_price_loss_usdt.as_deref(),
            Some("0.0265")
        );
        assert!(
            result
                .candidate
                .one_atr_risk_pct_of_equity
                .as_deref()
                .unwrap()
                .parse::<f64>()
                .unwrap()
                < 0.21
        );
        assert_eq!(
            result.capacity.max_single_trade_size.as_deref(),
            Some("0.12")
        );
        assert_eq!(result.capacity.minimum_within_available, Some(true));
        assert_eq!(result.capacity.minimum_within_profile_limit, Some(true));
    }

    #[test]
    fn leverage_changes_margin_but_not_fixed_size_price_risk() {
        let at_ten = evaluate_linear_usdt_perpetual(&perpetual_request("10")).unwrap();
        let at_twenty = evaluate_linear_usdt_perpetual(&perpetual_request("20")).unwrap();

        assert_eq!(
            at_ten.candidate.notional_usdt,
            at_twenty.candidate.notional_usdt
        );
        assert_eq!(
            at_ten.candidate.estimated_price_loss_at_stop_usdt,
            at_twenty.candidate.estimated_price_loss_at_stop_usdt
        );
        assert_eq!(
            at_ten.candidate.one_atr_price_loss_usdt,
            at_twenty.candidate.one_atr_price_loss_usdt
        );
        assert_eq!(at_ten.candidate.estimated_initial_margin_usdt, "0.651681");
        assert_eq!(
            at_twenty.candidate.estimated_initial_margin_usdt,
            "0.3258405"
        );
    }

    #[test]
    fn normalizes_candidate_size_before_calculating_account_metrics() {
        let mut request = perpetual_request("20");
        request.size = "0.019".to_string();

        let result = evaluate_linear_usdt_perpetual(&request).unwrap();

        assert_eq!(result.requested_size, "0.019");
        assert_eq!(result.normalized_size, "0.01");
        assert!(result.size_was_normalized);
        assert_eq!(result.candidate.size, "0.01");
        assert_eq!(result.candidate.notional_usdt, "6.51681");
    }
}
