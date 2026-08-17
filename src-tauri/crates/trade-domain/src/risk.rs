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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinearUsdtDirection {
    Long,
    Short,
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
    pub direction: Option<LinearUsdtDirection>,
    pub stop_price: Option<String>,
    pub target_price: Option<String>,
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
    pub break_even_price: Option<String>,
    pub break_even_move_pct: Option<String>,
    pub target_price: Option<String>,
    pub target_move_pct: Option<String>,
    pub estimated_gross_profit_at_target_usdt: Option<String>,
    pub estimated_exit_fee_at_target_usdt: Option<String>,
    pub estimated_round_trip_fee_at_target_usdt: Option<String>,
    pub estimated_net_profit_at_target_usdt: Option<String>,
    pub fee_drag_pct_of_gross_profit: Option<String>,
    pub net_reward_risk_ratio: Option<String>,
    pub estimated_round_trip_fee_pct_of_initial_margin: Option<String>,
    pub estimated_net_target_return_pct_of_initial_margin: Option<String>,
    pub estimated_net_target_profit_pct_of_equity: Option<String>,
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
pub struct LinearUsdtCostAssumptions {
    pub entry_fee_rate: String,
    pub exit_fee_rate: String,
    pub slippage_included: bool,
    pub funding_included: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearUsdtPerpetualEvaluation {
    pub requested_size: String,
    pub direction: Option<LinearUsdtDirection>,
    pub cost_assumptions: LinearUsdtCostAssumptions,
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
    let target = request
        .target_price
        .as_deref()
        .map(|value| FixedDecimal::parse_positive("targetPrice", value))
        .transpose()?;
    if target.is_some() && request.direction.is_none() {
        return Err(TradeDomainError::MissingDirectionForTarget);
    }
    if let Some(direction) = request.direction {
        validate_directional_prices(direction, entry, stop, target)?;
    }
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
        request.direction,
        stop,
        target,
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
        request.direction,
        stop,
        target,
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
        direction: request.direction,
        cost_assumptions: LinearUsdtCostAssumptions {
            entry_fee_rate: entry_fee_rate.to_plain_string(),
            exit_fee_rate: exit_fee_rate.to_plain_string(),
            slippage_included: false,
            funding_included: false,
        },
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

struct TargetEconomics {
    target_move_pct: FixedDecimal,
    gross_profit: FixedDecimal,
    exit_fee: FixedDecimal,
    round_trip_fee: FixedDecimal,
    net_profit: FixedDecimal,
    fee_drag_pct: FixedDecimal,
    fee_pct_of_initial_margin: FixedDecimal,
    net_return_pct_of_initial_margin: FixedDecimal,
    net_profit_pct_of_equity: Option<FixedDecimal>,
}

#[allow(clippy::too_many_arguments)]
fn calculate_position_metrics(
    size: FixedDecimal,
    entry: FixedDecimal,
    contract_value: FixedDecimal,
    leverage: FixedDecimal,
    equity: Option<FixedDecimal>,
    direction: Option<LinearUsdtDirection>,
    stop: Option<FixedDecimal>,
    target: Option<FixedDecimal>,
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
    let break_even_values = direction
        .map(|direction| {
            let price =
                calculate_break_even_price(direction, entry, entry_fee_rate, exit_fee_rate)?;
            let move_pct = percentage_of(
                absolute_difference(entry, price, "计算盈亏平衡价格距离")?,
                entry,
                "计算盈亏平衡价格距离比例",
            )?;
            Ok::<_, TradeDomainError>((price, move_pct))
        })
        .transpose()?;
    let target_values = direction
        .zip(target)
        .map(|(direction, target)| {
            calculate_target_economics(
                direction,
                base_quantity,
                entry,
                target,
                entry_fee,
                exit_fee_rate,
                initial_margin,
                equity,
            )
        })
        .transpose()?;
    let net_reward_risk_ratio = target_values
        .as_ref()
        .zip(stop_values.as_ref())
        .map(|(target, (_, _, _, stop_loss_with_fees, _))| {
            target.net_profit.checked_div_to_scale(
                *stop_loss_with_fees,
                PERCENT_OUTPUT_SCALE,
                "计算含费净盈亏比",
            )
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
        break_even_price: break_even_values
            .as_ref()
            .map(|(price, _)| price.to_plain_string()),
        break_even_move_pct: break_even_values
            .as_ref()
            .map(|(_, move_pct)| move_pct.to_plain_string()),
        target_price: target.map(FixedDecimal::to_plain_string),
        target_move_pct: target_values
            .as_ref()
            .map(|values| values.target_move_pct.to_plain_string()),
        estimated_gross_profit_at_target_usdt: target_values
            .as_ref()
            .map(|values| values.gross_profit.to_plain_string()),
        estimated_exit_fee_at_target_usdt: target_values
            .as_ref()
            .map(|values| values.exit_fee.to_plain_string()),
        estimated_round_trip_fee_at_target_usdt: target_values
            .as_ref()
            .map(|values| values.round_trip_fee.to_plain_string()),
        estimated_net_profit_at_target_usdt: target_values
            .as_ref()
            .map(|values| values.net_profit.to_plain_string()),
        fee_drag_pct_of_gross_profit: target_values
            .as_ref()
            .map(|values| values.fee_drag_pct.to_plain_string()),
        net_reward_risk_ratio: net_reward_risk_ratio.map(FixedDecimal::to_plain_string),
        estimated_round_trip_fee_pct_of_initial_margin: target_values
            .as_ref()
            .map(|values| values.fee_pct_of_initial_margin.to_plain_string()),
        estimated_net_target_return_pct_of_initial_margin: target_values
            .as_ref()
            .map(|values| values.net_return_pct_of_initial_margin.to_plain_string()),
        estimated_net_target_profit_pct_of_equity: target_values
            .as_ref()
            .and_then(|values| values.net_profit_pct_of_equity)
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

fn validate_directional_prices(
    direction: LinearUsdtDirection,
    entry: FixedDecimal,
    stop: Option<FixedDecimal>,
    target: Option<FixedDecimal>,
) -> Result<(), TradeDomainError> {
    let direction_name = match direction {
        LinearUsdtDirection::Long => "long",
        LinearUsdtDirection::Short => "short",
    };
    if let Some(stop) = stop {
        let valid = match direction {
            LinearUsdtDirection::Long => {
                stop.checked_cmp(entry, "校验 long 止损价格")? == Ordering::Less
            }
            LinearUsdtDirection::Short => {
                stop.checked_cmp(entry, "校验 short 止损价格")? == Ordering::Greater
            }
        };
        if !valid {
            return Err(TradeDomainError::InvalidDirectionalPrice {
                field: "stopPrice",
                direction: direction_name,
            });
        }
    }
    if let Some(target) = target {
        let valid = match direction {
            LinearUsdtDirection::Long => {
                target.checked_cmp(entry, "校验 long 目标价格")? == Ordering::Greater
            }
            LinearUsdtDirection::Short => {
                target.checked_cmp(entry, "校验 short 目标价格")? == Ordering::Less
            }
        };
        if !valid {
            return Err(TradeDomainError::InvalidDirectionalPrice {
                field: "targetPrice",
                direction: direction_name,
            });
        }
    }
    Ok(())
}

fn calculate_break_even_price(
    direction: LinearUsdtDirection,
    entry: FixedDecimal,
    entry_fee_rate: FixedDecimal,
    exit_fee_rate: FixedDecimal,
) -> Result<FixedDecimal, TradeDomainError> {
    let one = FixedDecimal::parse_positive("feeBase", "1")?;
    let (numerator_rate, denominator_rate) = match direction {
        LinearUsdtDirection::Long => (
            one.checked_add(entry_fee_rate, "计算 long 盈亏平衡入场费率")?,
            one.checked_sub(exit_fee_rate, "计算 long 盈亏平衡退出费率")?,
        ),
        LinearUsdtDirection::Short => (
            one.checked_sub(entry_fee_rate, "计算 short 盈亏平衡入场费率")?,
            one.checked_add(exit_fee_rate, "计算 short 盈亏平衡退出费率")?,
        ),
    };
    entry
        .checked_mul(numerator_rate, "计算盈亏平衡价格分子")?
        .checked_div_to_scale(denominator_rate, PERCENT_OUTPUT_SCALE, "计算盈亏平衡价格")
}

#[allow(clippy::too_many_arguments)]
fn calculate_target_economics(
    direction: LinearUsdtDirection,
    base_quantity: FixedDecimal,
    entry: FixedDecimal,
    target: FixedDecimal,
    entry_fee: FixedDecimal,
    exit_fee_rate: FixedDecimal,
    initial_margin: FixedDecimal,
    equity: Option<FixedDecimal>,
) -> Result<TargetEconomics, TradeDomainError> {
    let move_distance = match direction {
        LinearUsdtDirection::Long => target.checked_sub(entry, "计算 long 目标价格距离")?,
        LinearUsdtDirection::Short => entry.checked_sub(target, "计算 short 目标价格距离")?,
    };
    let target_move_pct = percentage_of(move_distance, entry, "计算目标价格距离比例")?;
    let gross_profit = base_quantity.checked_mul(move_distance, "计算目标毛收益")?;
    let target_notional = base_quantity.checked_mul(target, "计算目标退出名义价值")?;
    let exit_fee = target_notional.checked_mul(exit_fee_rate, "计算目标退出手续费")?;
    let round_trip_fee = entry_fee.checked_add(exit_fee, "计算目标双边手续费")?;
    let net_profit = gross_profit.checked_sub(round_trip_fee, "计算目标净收益")?;
    let fee_drag_pct = percentage_of(round_trip_fee, gross_profit, "计算手续费毛收益占比")?;
    let fee_pct_of_initial_margin =
        percentage_of(round_trip_fee, initial_margin, "计算手续费初始保证金占比")?;
    let net_return_pct_of_initial_margin =
        percentage_of(net_profit, initial_margin, "计算目标净收益初始保证金占比")?;
    let net_profit_pct_of_equity = equity
        .map(|equity| percentage_of(net_profit, equity, "计算目标净收益权益占比"))
        .transpose()?;
    Ok(TargetEconomics {
        target_move_pct,
        gross_profit,
        exit_fee,
        round_trip_fee,
        net_profit,
        fee_drag_pct,
        fee_pct_of_initial_margin,
        net_return_pct_of_initial_margin,
        net_profit_pct_of_equity,
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
            direction: Some(LinearUsdtDirection::Long),
            stop_price: Some("64903.1".to_string()),
            target_price: Some("65698.1".to_string()),
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
        assert_eq!(
            at_ten.candidate.estimated_round_trip_fee_at_target_usdt,
            at_twenty.candidate.estimated_round_trip_fee_at_target_usdt
        );
        assert_eq!(
            at_ten.candidate.estimated_net_profit_at_target_usdt,
            at_twenty.candidate.estimated_net_profit_at_target_usdt
        );
        let fee_pct_at_ten = at_ten
            .candidate
            .estimated_round_trip_fee_pct_of_initial_margin
            .as_deref()
            .unwrap()
            .parse::<f64>()
            .unwrap();
        let fee_pct_at_twenty = at_twenty
            .candidate
            .estimated_round_trip_fee_pct_of_initial_margin
            .as_deref()
            .unwrap()
            .parse::<f64>()
            .unwrap();
        assert!((fee_pct_at_twenty / fee_pct_at_ten - 2.0).abs() < 1e-9);
    }

    #[test]
    fn target_economics_are_directional_and_fee_adjusted() {
        let mut long = perpetual_request("10");
        long.size = "1".to_string();
        long.entry_price = "100".to_string();
        long.contract_value = "1".to_string();
        long.min_size = "1".to_string();
        long.lot_size = "1".to_string();
        long.equity = Some("1000".to_string());
        long.stop_price = Some("95".to_string());
        long.target_price = Some("110".to_string());
        long.entry_fee_rate = "0.001".to_string();
        long.exit_fee_rate = "0.001".to_string();
        let long_result = evaluate_linear_usdt_perpetual(&long).unwrap();
        assert_eq!(long_result.cost_assumptions.entry_fee_rate, "0.001");
        assert!(!long_result.cost_assumptions.slippage_included);
        assert!(!long_result.cost_assumptions.funding_included);
        assert_eq!(
            long_result
                .candidate
                .estimated_gross_profit_at_target_usdt
                .as_deref(),
            Some("10")
        );
        assert_eq!(
            long_result
                .candidate
                .estimated_round_trip_fee_at_target_usdt
                .as_deref(),
            Some("0.21")
        );
        assert_eq!(
            long_result
                .candidate
                .estimated_net_profit_at_target_usdt
                .as_deref(),
            Some("9.79")
        );
        assert_eq!(
            long_result
                .candidate
                .fee_drag_pct_of_gross_profit
                .as_deref(),
            Some("2.1")
        );
        let net_reward_risk = long_result
            .candidate
            .net_reward_risk_ratio
            .as_deref()
            .unwrap()
            .parse::<f64>()
            .unwrap();
        assert!(net_reward_risk > 1.88 && net_reward_risk < 1.89);
        let long_break_even = long_result
            .candidate
            .break_even_price
            .as_deref()
            .unwrap()
            .parse::<f64>()
            .unwrap();
        assert!(long_break_even > 100.20 && long_break_even < 100.21);

        let mut short = long;
        short.direction = Some(LinearUsdtDirection::Short);
        short.stop_price = Some("105".to_string());
        short.target_price = Some("90".to_string());
        let short_result = evaluate_linear_usdt_perpetual(&short).unwrap();
        assert_eq!(
            short_result
                .candidate
                .estimated_net_profit_at_target_usdt
                .as_deref(),
            Some("9.81")
        );
        let short_break_even = short_result
            .candidate
            .break_even_price
            .as_deref()
            .unwrap()
            .parse::<f64>()
            .unwrap();
        assert!(short_break_even > 99.80 && short_break_even < 99.81);
    }

    #[test]
    fn close_target_can_be_directionally_correct_but_net_negative() {
        let mut request = perpetual_request("10");
        request.size = "1".to_string();
        request.entry_price = "100".to_string();
        request.contract_value = "1".to_string();
        request.min_size = "1".to_string();
        request.lot_size = "1".to_string();
        request.stop_price = Some("95".to_string());
        request.target_price = Some("100.1".to_string());
        request.entry_fee_rate = "0.001".to_string();
        request.exit_fee_rate = "0.001".to_string();
        let result = evaluate_linear_usdt_perpetual(&request).unwrap();
        assert_eq!(
            result
                .candidate
                .estimated_net_profit_at_target_usdt
                .as_deref(),
            Some("-0.1001")
        );
    }

    #[test]
    fn rejects_target_without_direction_or_on_the_wrong_side() {
        let mut request = perpetual_request("10");
        request.direction = None;
        assert_eq!(
            evaluate_linear_usdt_perpetual(&request).unwrap_err(),
            TradeDomainError::MissingDirectionForTarget
        );

        request.direction = Some(LinearUsdtDirection::Long);
        request.target_price = Some("64000".to_string());
        assert_eq!(
            evaluate_linear_usdt_perpetual(&request).unwrap_err(),
            TradeDomainError::InvalidDirectionalPrice {
                field: "targetPrice",
                direction: "long"
            }
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
