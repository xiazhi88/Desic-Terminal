use std::{cmp::Ordering, fmt};

use serde::{Deserialize, Serialize};

const MAX_DECIMAL_SCALE: u32 = 28;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TradeDomainError {
    InvalidDecimal {
        field: &'static str,
    },
    DecimalScaleTooLarge {
        field: &'static str,
        max_scale: u32,
    },
    MustBePositive {
        field: &'static str,
    },
    MustBeNonNegative {
        field: &'static str,
    },
    AboveMaximum {
        field: &'static str,
        maximum: &'static str,
    },
    MissingOrderField {
        order_kind: &'static str,
        field: &'static str,
    },
    UnexpectedOrderField {
        order_kind: &'static str,
        field: &'static str,
    },
    ZeroRiskPerContract,
    MissingDirectionForTarget,
    InvalidDirectionalPrice {
        field: &'static str,
        direction: &'static str,
    },
    ArithmeticOverflow {
        operation: &'static str,
    },
}

impl fmt::Display for TradeDomainError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDecimal { field } => {
                write!(formatter, "{field} 必须是普通十进制字符串")
            }
            Self::DecimalScaleTooLarge { field, max_scale } => {
                write!(formatter, "{field} 最多支持 {max_scale} 位小数")
            }
            Self::MustBePositive { field } => write!(formatter, "{field} 必须大于 0"),
            Self::MustBeNonNegative { field } => write!(formatter, "{field} 不能小于 0"),
            Self::AboveMaximum { field, maximum } => {
                write!(formatter, "{field} 不能大于 {maximum}")
            }
            Self::MissingOrderField { order_kind, field } => {
                write!(formatter, "{order_kind} 订单缺少 {field}")
            }
            Self::UnexpectedOrderField { order_kind, field } => {
                write!(formatter, "{order_kind} 订单不应包含 {field}")
            }
            Self::ZeroRiskPerContract => write!(formatter, "每张合约风险必须大于 0"),
            Self::MissingDirectionForTarget => {
                write!(formatter, "targetPrice 存在时必须提供 direction")
            }
            Self::InvalidDirectionalPrice { field, direction } => {
                write!(formatter, "{field} 不符合 {direction} 方向的价格关系")
            }
            Self::ArithmeticOverflow { operation } => {
                write!(formatter, "十进制运算超出范围：{operation}")
            }
        }
    }
}

impl std::error::Error for TradeDomainError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentDecimalRules {
    pub min_size: String,
    pub lot_size: String,
    pub tick_size: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeInputNormalizationRequest {
    pub size: String,
    pub price: Option<String>,
    pub rules: InstrumentDecimalRules,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedTradeInput {
    pub size: String,
    pub price: Option<String>,
}

pub fn normalize_decimal(raw_value: &str, field: &'static str) -> Result<String, TradeDomainError> {
    FixedDecimal::parse(field, raw_value).map(FixedDecimal::to_plain_string)
}

pub fn normalize_size(
    raw_size: &str,
    min_size: &str,
    lot_size: &str,
) -> Result<String, TradeDomainError> {
    let value = FixedDecimal::parse_positive("size", raw_size)?;
    let minimum = FixedDecimal::parse_positive("minSize", min_size)?;
    let lot = FixedDecimal::parse_positive("lotSize", lot_size)?;

    if value.checked_cmp(minimum, "比较 size 与 minSize")? == Ordering::Less {
        return Ok(minimum.to_plain_string());
    }

    let aligned = value.checked_floor_to_step(lot, "按 lotSize 对齐 size")?;
    if aligned.checked_cmp(minimum, "比较对齐后的 size 与 minSize")? == Ordering::Less {
        Ok(minimum.to_plain_string())
    } else {
        Ok(aligned.to_plain_string())
    }
}

pub fn normalize_price(raw_price: &str, tick_size: &str) -> Result<String, TradeDomainError> {
    let value = FixedDecimal::parse_positive("price", raw_price)?;
    let tick = FixedDecimal::parse_positive("tickSize", tick_size)?;
    let aligned = value.checked_floor_to_step(tick, "按 tickSize 对齐 price")?;
    if aligned.is_zero() {
        return Err(TradeDomainError::MustBePositive { field: "price" });
    }
    Ok(aligned.to_plain_string())
}

pub fn normalize_trade_input(
    request: &TradeInputNormalizationRequest,
) -> Result<NormalizedTradeInput, TradeDomainError> {
    Ok(NormalizedTradeInput {
        size: normalize_size(
            &request.size,
            &request.rules.min_size,
            &request.rules.lot_size,
        )?,
        price: request
            .price
            .as_deref()
            .map(|price| normalize_price(price, &request.rules.tick_size))
            .transpose()?,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FixedDecimal {
    coefficient: i128,
    scale: u32,
}

impl FixedDecimal {
    pub(crate) const ZERO: Self = Self {
        coefficient: 0,
        scale: 0,
    };

    pub(crate) fn parse(field: &'static str, raw: &str) -> Result<Self, TradeDomainError> {
        let value = raw.trim();
        if value.is_empty() {
            return Err(TradeDomainError::InvalidDecimal { field });
        }

        let (negative, unsigned) = match value.as_bytes()[0] {
            b'-' => (true, &value[1..]),
            b'+' => (false, &value[1..]),
            _ => (false, value),
        };
        if unsigned.is_empty() {
            return Err(TradeDomainError::InvalidDecimal { field });
        }

        let mut parts = unsigned.split('.');
        let integer = parts.next().unwrap_or_default();
        let fraction = parts.next();
        if parts.next().is_some()
            || (integer.is_empty() && fraction.map(str::is_empty).unwrap_or(true))
            || !integer.bytes().all(|byte| byte.is_ascii_digit())
            || fraction.is_some_and(|digits| !digits.bytes().all(|byte| byte.is_ascii_digit()))
        {
            return Err(TradeDomainError::InvalidDecimal { field });
        }

        let fraction = fraction.unwrap_or_default();
        if fraction.len() > MAX_DECIMAL_SCALE as usize {
            return Err(TradeDomainError::DecimalScaleTooLarge {
                field,
                max_scale: MAX_DECIMAL_SCALE,
            });
        }

        let integer = if integer.is_empty() { "0" } else { integer };
        let digits = format!("{integer}{fraction}");
        let digits = digits.trim_start_matches('0');
        let magnitude = if digits.is_empty() {
            0
        } else {
            digits
                .parse::<i128>()
                .map_err(|_| TradeDomainError::ArithmeticOverflow {
                    operation: "解析十进制数",
                })?
        };
        let coefficient = if negative {
            magnitude
                .checked_neg()
                .ok_or(TradeDomainError::ArithmeticOverflow {
                    operation: "解析十进制符号",
                })?
        } else {
            magnitude
        };
        Ok(Self::new(coefficient, fraction.len() as u32))
    }

    pub(crate) fn parse_positive(field: &'static str, raw: &str) -> Result<Self, TradeDomainError> {
        let value = Self::parse(field, raw)?;
        if value.coefficient <= 0 {
            return Err(TradeDomainError::MustBePositive { field });
        }
        Ok(value)
    }

    pub(crate) fn parse_non_negative(
        field: &'static str,
        raw: &str,
    ) -> Result<Self, TradeDomainError> {
        let value = Self::parse(field, raw)?;
        if value.coefficient < 0 {
            return Err(TradeDomainError::MustBeNonNegative { field });
        }
        Ok(value)
    }

    pub(crate) fn is_zero(self) -> bool {
        self.coefficient == 0
    }

    pub(crate) fn checked_cmp(
        self,
        other: Self,
        operation: &'static str,
    ) -> Result<Ordering, TradeDomainError> {
        let (left, right) = self.checked_align(other, operation)?;
        Ok(left.cmp(&right))
    }

    pub(crate) fn checked_add(
        self,
        other: Self,
        operation: &'static str,
    ) -> Result<Self, TradeDomainError> {
        let scale = self.scale.max(other.scale);
        let (left, right) = self.checked_align(other, operation)?;
        let coefficient = left
            .checked_add(right)
            .ok_or(TradeDomainError::ArithmeticOverflow { operation })?;
        Ok(Self::new(coefficient, scale))
    }

    pub(crate) fn checked_sub(
        self,
        other: Self,
        operation: &'static str,
    ) -> Result<Self, TradeDomainError> {
        let scale = self.scale.max(other.scale);
        let (left, right) = self.checked_align(other, operation)?;
        let coefficient = left
            .checked_sub(right)
            .ok_or(TradeDomainError::ArithmeticOverflow { operation })?;
        Ok(Self::new(coefficient, scale))
    }

    pub(crate) fn checked_mul(
        self,
        other: Self,
        operation: &'static str,
    ) -> Result<Self, TradeDomainError> {
        let coefficient = self
            .coefficient
            .checked_mul(other.coefficient)
            .ok_or(TradeDomainError::ArithmeticOverflow { operation })?;
        let scale = self
            .scale
            .checked_add(other.scale)
            .ok_or(TradeDomainError::ArithmeticOverflow { operation })?;
        Ok(Self::new(coefficient, scale))
    }

    pub(crate) fn checked_mul_integer(
        self,
        multiplier: i128,
        operation: &'static str,
    ) -> Result<Self, TradeDomainError> {
        let coefficient = self
            .coefficient
            .checked_mul(multiplier)
            .ok_or(TradeDomainError::ArithmeticOverflow { operation })?;
        Ok(Self::new(coefficient, self.scale))
    }

    pub(crate) fn checked_floor_to_step(
        self,
        step: Self,
        operation: &'static str,
    ) -> Result<Self, TradeDomainError> {
        let units = self.checked_floor_ratio(step, operation)?;
        step.checked_mul_integer(units, operation)
    }

    pub(crate) fn checked_floor_ratio(
        self,
        denominator: Self,
        operation: &'static str,
    ) -> Result<i128, TradeDomainError> {
        if self.coefficient < 0 || denominator.coefficient <= 0 {
            return Err(TradeDomainError::ArithmeticOverflow { operation });
        }
        let (numerator, denominator) = self.checked_align(denominator, operation)?;
        Ok(numerator / denominator)
    }

    pub(crate) fn checked_div_to_scale(
        self,
        denominator: Self,
        output_scale: u32,
        operation: &'static str,
    ) -> Result<Self, TradeDomainError> {
        if denominator.coefficient <= 0 {
            return Err(TradeDomainError::ArithmeticOverflow { operation });
        }
        let negative = self.coefficient < 0;
        let magnitude = Self::new(
            self.coefficient
                .checked_abs()
                .ok_or(TradeDomainError::ArithmeticOverflow { operation })?,
            self.scale,
        );
        let (numerator, denominator) = magnitude.checked_align(denominator, operation)?;
        let mut coefficient = numerator / denominator;
        let mut remainder = numerator % denominator;
        let mut produced_scale = 0;

        while produced_scale < output_scale && remainder != 0 {
            coefficient = coefficient
                .checked_mul(10)
                .ok_or(TradeDomainError::ArithmeticOverflow { operation })?;
            remainder = remainder
                .checked_mul(10)
                .ok_or(TradeDomainError::ArithmeticOverflow { operation })?;
            coefficient = coefficient
                .checked_add(remainder / denominator)
                .ok_or(TradeDomainError::ArithmeticOverflow { operation })?;
            remainder %= denominator;
            produced_scale += 1;
        }

        if negative {
            coefficient = coefficient
                .checked_neg()
                .ok_or(TradeDomainError::ArithmeticOverflow { operation })?;
        }
        Ok(Self::new(coefficient, produced_scale))
    }

    pub(crate) fn to_plain_string(self) -> String {
        if self.coefficient == 0 {
            return "0".to_string();
        }

        let negative = self.coefficient < 0;
        let digits = self.coefficient.unsigned_abs().to_string();
        let body = if self.scale == 0 {
            digits
        } else if digits.len() <= self.scale as usize {
            format!(
                "0.{}{}",
                "0".repeat(self.scale as usize - digits.len()),
                digits
            )
        } else {
            let split = digits.len() - self.scale as usize;
            format!("{}.{}", &digits[..split], &digits[split..])
        };
        if negative {
            format!("-{body}")
        } else {
            body
        }
    }

    fn new(mut coefficient: i128, mut scale: u32) -> Self {
        if coefficient == 0 {
            return Self::ZERO;
        }
        while scale > 0 && coefficient % 10 == 0 {
            coefficient /= 10;
            scale -= 1;
        }
        Self { coefficient, scale }
    }

    fn checked_align(
        self,
        other: Self,
        operation: &'static str,
    ) -> Result<(i128, i128), TradeDomainError> {
        let scale = self.scale.max(other.scale);
        Ok((
            self.checked_coefficient_at_scale(scale, operation)?,
            other.checked_coefficient_at_scale(scale, operation)?,
        ))
    }

    fn checked_coefficient_at_scale(
        self,
        scale: u32,
        operation: &'static str,
    ) -> Result<i128, TradeDomainError> {
        let factor = checked_pow10(scale - self.scale, operation)?;
        self.coefficient
            .checked_mul(factor)
            .ok_or(TradeDomainError::ArithmeticOverflow { operation })
    }
}

fn checked_pow10(exponent: u32, operation: &'static str) -> Result<i128, TradeDomainError> {
    let mut result = 1_i128;
    for _ in 0..exponent {
        result = result
            .checked_mul(10)
            .ok_or(TradeDomainError::ArithmeticOverflow { operation })?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positive_size_below_minimum_is_promoted_to_minimum() {
        assert_eq!(normalize_size("0.001", "0.01", "0.01").unwrap(), "0.01");
    }

    #[test]
    fn size_is_floored_to_lot_without_floating_point_drift() {
        assert_eq!(normalize_size("1.239", "0.01", "0.01").unwrap(), "1.23");
        assert_eq!(normalize_size("0.3", "0.1", "0.1").unwrap(), "0.3");
    }

    #[test]
    fn price_is_floored_to_tick() {
        assert_eq!(normalize_price("62000.129", "0.1").unwrap(), "62000.1");
    }

    #[test]
    fn normalization_rejects_exponents_and_non_positive_values() {
        assert_eq!(
            normalize_decimal("-0.0000000000000000000000000001", "position.pos").unwrap(),
            "-0.0000000000000000000000000001"
        );
        assert!(matches!(
            normalize_decimal("1e-2", "position.pos"),
            Err(TradeDomainError::InvalidDecimal {
                field: "position.pos"
            })
        ));
        assert!(matches!(
            normalize_size("1e-2", "0.01", "0.01"),
            Err(TradeDomainError::InvalidDecimal { field: "size" })
        ));
        assert!(matches!(
            normalize_price("0.01", "0.1"),
            Err(TradeDomainError::MustBePositive { field: "price" })
        ));
    }

    #[test]
    fn request_normalizes_size_and_optional_price() {
        let normalized = normalize_trade_input(&TradeInputNormalizationRequest {
            size: "2.999".to_string(),
            price: Some("101.29".to_string()),
            rules: InstrumentDecimalRules {
                min_size: "0.1".to_string(),
                lot_size: "0.1".to_string(),
                tick_size: "0.5".to_string(),
            },
        })
        .unwrap();

        assert_eq!(normalized.size, "2.9");
        assert_eq!(normalized.price.as_deref(), Some("101"));
    }
}
