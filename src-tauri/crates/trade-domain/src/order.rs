use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

use crate::numeric::{
    normalize_price, normalize_size, FixedDecimal, InstrumentDecimalRules, TradeDomainError,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegularExecution {
    Market,
    Limit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum TrailingCallback {
    Ratio(String),
    Spread(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum OrderSpec {
    Regular {
        execution: RegularExecution,
        price: Option<String>,
    },
    Trigger {
        trigger_price: String,
        /// `None` means market execution after the trigger fires.
        order_price: Option<String>,
    },
    Trailing {
        activation_price: Option<String>,
        callback: TrailingCallback,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderNormalizationRequest {
    pub size: String,
    pub rules: InstrumentDecimalRules,
    pub order: OrderSpec,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedOrderInput {
    pub size: String,
    pub order: OrderSpec,
}

pub fn normalize_order_spec(
    order: &OrderSpec,
    tick_size: &str,
) -> Result<OrderSpec, TradeDomainError> {
    match order {
        OrderSpec::Regular {
            execution: RegularExecution::Market,
            price,
        } => {
            if price
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            {
                return Err(TradeDomainError::UnexpectedOrderField {
                    order_kind: "regular market",
                    field: "price",
                });
            }
            Ok(OrderSpec::Regular {
                execution: RegularExecution::Market,
                price: None,
            })
        }
        OrderSpec::Regular {
            execution: RegularExecution::Limit,
            price,
        } => {
            let price = required_value(price.as_deref(), "regular limit", "price")?;
            Ok(OrderSpec::Regular {
                execution: RegularExecution::Limit,
                price: Some(normalize_price(price, tick_size)?),
            })
        }
        OrderSpec::Trigger {
            trigger_price,
            order_price,
        } => Ok(OrderSpec::Trigger {
            trigger_price: normalize_price(trigger_price, tick_size)?,
            order_price: non_empty(order_price.as_deref())
                .map(|price| normalize_price(price, tick_size))
                .transpose()?,
        }),
        OrderSpec::Trailing {
            activation_price,
            callback,
        } => {
            let activation_price = non_empty(activation_price.as_deref())
                .map(|price| normalize_price(price, tick_size))
                .transpose()?;
            let callback = match callback {
                TrailingCallback::Ratio(ratio) => {
                    let ratio = FixedDecimal::parse_positive("callbackRatio", ratio)?;
                    let maximum = FixedDecimal::parse_positive("callbackRatio", "0.05")?;
                    if ratio.checked_cmp(maximum, "校验追踪回调比例上限")? == Ordering::Greater
                    {
                        return Err(TradeDomainError::AboveMaximum {
                            field: "callbackRatio",
                            maximum: "0.05",
                        });
                    }
                    TrailingCallback::Ratio(ratio.to_plain_string())
                }
                TrailingCallback::Spread(spread) => {
                    TrailingCallback::Spread(normalize_price(spread, tick_size)?)
                }
            };
            Ok(OrderSpec::Trailing {
                activation_price,
                callback,
            })
        }
    }
}

pub fn normalize_order_input(
    request: &OrderNormalizationRequest,
) -> Result<NormalizedOrderInput, TradeDomainError> {
    Ok(NormalizedOrderInput {
        size: normalize_size(
            &request.size,
            &request.rules.min_size,
            &request.rules.lot_size,
        )?,
        order: normalize_order_spec(&request.order, &request.rules.tick_size)?,
    })
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn required_value<'a>(
    value: Option<&'a str>,
    order_kind: &'static str,
    field: &'static str,
) -> Result<&'a str, TradeDomainError> {
    non_empty(value).ok_or(TradeDomainError::MissingOrderField { order_kind, field })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules() -> InstrumentDecimalRules {
        InstrumentDecimalRules {
            min_size: "0.01".to_string(),
            lot_size: "0.01".to_string(),
            tick_size: "0.1".to_string(),
        }
    }

    #[test]
    fn regular_limit_normalizes_size_and_price() {
        let normalized = normalize_order_input(&OrderNormalizationRequest {
            size: "1.239".to_string(),
            rules: rules(),
            order: OrderSpec::Regular {
                execution: RegularExecution::Limit,
                price: Some("101.29".to_string()),
            },
        })
        .unwrap();

        assert_eq!(normalized.size, "1.23");
        assert_eq!(
            normalized.order,
            OrderSpec::Regular {
                execution: RegularExecution::Limit,
                price: Some("101.2".to_string()),
            }
        );
    }

    #[test]
    fn regular_market_rejects_a_price() {
        let error = normalize_order_spec(
            &OrderSpec::Regular {
                execution: RegularExecution::Market,
                price: Some("100".to_string()),
            },
            "0.1",
        )
        .unwrap_err();

        assert!(matches!(
            error,
            TradeDomainError::UnexpectedOrderField {
                order_kind: "regular market",
                field: "price"
            }
        ));
    }

    #[test]
    fn trigger_supports_market_or_tick_aligned_limit_execution() {
        let market = normalize_order_spec(
            &OrderSpec::Trigger {
                trigger_price: "100.19".to_string(),
                order_price: None,
            },
            "0.1",
        )
        .unwrap();
        assert_eq!(
            market,
            OrderSpec::Trigger {
                trigger_price: "100.1".to_string(),
                order_price: None,
            }
        );

        let limit = normalize_order_spec(
            &OrderSpec::Trigger {
                trigger_price: "100.19".to_string(),
                order_price: Some("99.99".to_string()),
            },
            "0.1",
        )
        .unwrap();
        assert_eq!(
            limit,
            OrderSpec::Trigger {
                trigger_price: "100.1".to_string(),
                order_price: Some("99.9".to_string()),
            }
        );
    }

    #[test]
    fn trailing_normalizes_activation_and_callback_variants() {
        let ratio = normalize_order_spec(
            &OrderSpec::Trailing {
                activation_price: Some("100.19".to_string()),
                callback: TrailingCallback::Ratio("0.0100".to_string()),
            },
            "0.1",
        )
        .unwrap();
        assert_eq!(
            ratio,
            OrderSpec::Trailing {
                activation_price: Some("100.1".to_string()),
                callback: TrailingCallback::Ratio("0.01".to_string()),
            }
        );

        let spread = normalize_order_spec(
            &OrderSpec::Trailing {
                activation_price: None,
                callback: TrailingCallback::Spread("1.29".to_string()),
            },
            "0.1",
        )
        .unwrap();
        assert_eq!(
            spread,
            OrderSpec::Trailing {
                activation_price: None,
                callback: TrailingCallback::Spread("1.2".to_string()),
            }
        );
    }

    #[test]
    fn trailing_rejects_callback_ratio_above_five_percent() {
        let error = normalize_order_spec(
            &OrderSpec::Trailing {
                activation_price: None,
                callback: TrailingCallback::Ratio("0.0500001".to_string()),
            },
            "0.1",
        )
        .unwrap_err();

        assert_eq!(
            error,
            TradeDomainError::AboveMaximum {
                field: "callbackRatio",
                maximum: "0.05",
            }
        );
    }
}
