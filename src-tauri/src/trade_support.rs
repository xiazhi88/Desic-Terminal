use super::*;

pub(crate) async fn fetch_instrument(
    app: &tauri::AppHandle,
    inst_id: &str,
) -> Result<OkxInstrument, String> {
    if let Some(instrument) = load_cached_instrument(app, inst_id)? {
        if !instrument.inst_id_code.trim().is_empty() {
            return Ok(instrument);
        }
    }
    let fetched = fetch_instrument_from_okx(inst_id).await?;
    upsert_cached_instruments(app, vec![fetched.clone()])?;
    Ok(fetched)
}

pub(crate) async fn ensure_instruments_cached(
    app: &tauri::AppHandle,
    inst_ids: Vec<String>,
) -> Result<Vec<OkxInstrument>, String> {
    let mut result = Vec::new();
    let mut missing = Vec::new();
    for inst_id in normalize_instrument_ids(inst_ids) {
        match load_cached_instrument(app, &inst_id)? {
            Some(instrument) => result.push(instrument),
            None => missing.push(inst_id),
        }
    }
    if missing.is_empty() {
        return Ok(result);
    }
    let mut fetched = Vec::new();
    for inst_id in missing {
        fetched.push(fetch_instrument_from_okx(&inst_id).await?);
    }
    upsert_cached_instruments(app, fetched.clone())?;
    result.extend(fetched);
    Ok(result)
}

fn normalize_instrument_ids(inst_ids: Vec<String>) -> Vec<String> {
    let mut result = Vec::new();
    for value in inst_ids {
        let trimmed = value.trim().to_ascii_uppercase();
        if trimmed.is_empty() {
            continue;
        }
        let inst_id = if trimmed.contains('-') {
            trimmed
        } else {
            format!("{}-USDT-SWAP", trimmed)
        };
        if !result.iter().any(|item| item == &inst_id) {
            result.push(inst_id);
        }
    }
    result
}

fn load_cached_instrument(
    app: &tauri::AppHandle,
    inst_id: &str,
) -> Result<Option<OkxInstrument>, String> {
    let Some(summary) = load_market_assets_summary(app)? else {
        return Ok(None);
    };
    let normalized = inst_id.trim().to_ascii_uppercase();
    Ok(summary
        .instruments
        .into_iter()
        .find(|item| item.inst_id.eq_ignore_ascii_case(&normalized))
        .map(instrument_from_summary))
}

async fn fetch_instrument_from_okx(inst_id: &str) -> Result<OkxInstrument, String> {
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

pub(crate) fn available_balance_value(balance: &OkxBalance) -> Option<f64> {
    parse_optional_f64(&balance.avail_eq)
        .or_else(|| parse_optional_f64(&balance.avail_bal))
        .or_else(|| parse_optional_f64(&balance.cash_bal))
}

pub(crate) fn position_available(
    positions: &[OkxPosition],
    inst_id: &str,
    side: &str,
) -> Option<f64> {
    let total = positions
        .iter()
        .filter(|position| {
            position.inst_id == inst_id && position.pos_side.eq_ignore_ascii_case(side)
        })
        .filter_map(|position| parse_optional_f64(&position.pos))
        .filter(|value| *value > 0.0)
        .sum::<f64>();
    if total > 0.0 {
        Some(total)
    } else {
        None
    }
}

pub(crate) fn leverage_info_path(inst_id: &str, mgn_mode: &str) -> String {
    format!(
        "/api/v5/account/leverage-info?instId={}&mgnMode={}",
        url_encode(inst_id),
        url_encode(mgn_mode)
    )
}

pub(crate) fn leverage_pos_sides(pos_mode: &str, requested: Option<&str>) -> Vec<Option<String>> {
    if let Some(pos_side) = requested.filter(|value| !value.trim().is_empty()) {
        return vec![Some(pos_side.trim().to_string())];
    }
    if pos_mode == "long_short_mode" {
        return vec![Some("long".to_string()), Some("short".to_string())];
    }
    vec![None]
}

pub(crate) fn leverage_rows_match(
    rows: &[OkxLeverageInfo],
    selected_lever: f64,
    pos_mode: Option<&str>,
) -> bool {
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
            .any(|row| {
                parse_optional_f64(&row.lever)
                    .is_some_and(|lever| (lever - selected_lever).abs() < 1e-8)
            })
    })
}

pub(crate) fn format_leverage_rows(rows: &[OkxLeverageInfo]) -> String {
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

pub(crate) fn select_position_tier(
    tiers: &[OkxPositionTier],
    size: f64,
) -> Option<&OkxPositionTier> {
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
            left_tier
                .partial_cmp(&right_tier)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
}

pub(crate) fn estimated_margin_candidate(notional: f64, lever: Option<f64>) -> Option<f64> {
    let lever = lever?;
    if lever > 0.0 {
        Some(notional / lever)
    } else {
        None
    }
}

pub(crate) fn instrument_allows_fractional_contracts(instrument: &OkxInstrumentSummary) -> bool {
    [&instrument.min_sz, &instrument.lot_sz]
        .into_iter()
        .filter_map(|value| parse_optional_f64(value))
        .any(|value| (value.fract()).abs() > 1e-12)
}

pub(crate) fn instrument_minimum_base_quantity(
    instrument: &OkxInstrumentSummary,
) -> Option<String> {
    if !instrument.ct_type.eq_ignore_ascii_case("linear")
        && !instrument.settle_ccy.eq_ignore_ascii_case("USDT")
    {
        return None;
    }
    let minimum_size = parse_optional_f64(&instrument.min_sz)?;
    let contract_value = parse_optional_f64(&instrument.ct_val)?;
    Some(trim_float(minimum_size * contract_value))
}

pub(crate) fn instrument_quantity_instruction(instrument: &OkxInstrumentSummary) -> String {
    if instrument_allows_fractional_contracts(instrument) {
        format!(
            "{} 张是合法最小下单量；OKX 合约张数允许小数，禁止向上取整为 1 张",
            instrument.min_sz
        )
    } else {
        format!(
            "{} 张是合法最小下单量，数量必须按 lotSz={} 对齐",
            instrument.min_sz, instrument.lot_sz
        )
    }
}

pub(crate) async fn ensure_trade_account(
    account: &LocalAccount,
    environment: &str,
) -> Result<OkxAccountConfig, String> {
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
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fractional_btc_swap() -> OkxInstrumentSummary {
        OkxInstrumentSummary {
            inst_id: "BTC-USDT-SWAP".to_string(),
            inst_id_code: "221884".to_string(),
            inst_type: "SWAP".to_string(),
            inst_family: "BTC-USDT".to_string(),
            base_ccy: String::new(),
            quote_ccy: String::new(),
            settle_ccy: "USDT".to_string(),
            ct_val: "0.01".to_string(),
            ct_val_ccy: "BTC".to_string(),
            ct_type: "linear".to_string(),
            tick_sz: "0.1".to_string(),
            lot_sz: "0.01".to_string(),
            min_sz: "0.01".to_string(),
            max_lmt_sz: "100000000".to_string(),
            max_mkt_sz: "35000".to_string(),
            lever: "100".to_string(),
            state: "live".to_string(),
            inst_category: "1".to_string(),
            group_id: "4".to_string(),
            list_time: String::new(),
            exp_time: String::new(),
            icon_path: None,
            icon_cached: false,
            updated_at: 0,
        }
    }

    #[test]
    fn fractional_contract_guidance_preserves_okx_minimum_size() {
        let instrument = fractional_btc_swap();

        assert!(instrument_allows_fractional_contracts(&instrument));
        assert_eq!(
            instrument_minimum_base_quantity(&instrument).as_deref(),
            Some("0.0001")
        );
        assert!(instrument_quantity_instruction(&instrument).contains("禁止向上取整为 1 张"));
    }

    #[test]
    fn inverse_contract_does_not_report_contract_value_as_base_quantity() {
        let mut instrument = fractional_btc_swap();
        instrument.ct_type = "inverse".to_string();
        instrument.settle_ccy = "BTC".to_string();
        instrument.ct_val_ccy = "USD".to_string();

        assert_eq!(instrument_minimum_base_quantity(&instrument), None);
    }
}
