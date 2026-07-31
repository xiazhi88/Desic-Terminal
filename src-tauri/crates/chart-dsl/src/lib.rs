//! A deterministic, resource-bounded DSL for chart indicators.
//!
//! The crate intentionally exposes data-only AST nodes. It does not load
//! scripts, access the network/filesystem, or evaluate arbitrary code.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;

mod built_in;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ValueType {
    Number,
    Boolean,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OhlcvField {
    Timestamp,
    Open,
    High,
    Low,
    Close,
    Volume,
    Hl2,
    Hlc3,
    Ohlc4,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArithmeticOp {
    Add,
    Subtract,
    Multiply,
    Divide,
    Modulo,
    Power,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UnaryOp {
    Negate,
    Absolute,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PairwiseFunction {
    Min,
    Max,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LogicalOp {
    And,
    Or,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TechnicalFunction {
    Rsi,
    Atr,
    Vwap,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ComparisonOp {
    GreaterThan,
    GreaterOrEqual,
    LessThan,
    LessOrEqual,
    Equal,
    NotEqual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RollingFunction {
    Sma,
    Ema,
    Sum,
    Lowest,
    Highest,
    StdDev,
}

/// Serializable, typed-by-validation AST. There is intentionally no call,
/// identifier, property access, loop, import, or arbitrary code node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Expression {
    Field {
        field: OhlcvField,
    },
    Number {
        value: f64,
    },
    Boolean {
        value: bool,
    },
    Unary {
        op: UnaryOp,
        value: Box<Expression>,
    },
    Arithmetic {
        op: ArithmeticOp,
        left: Box<Expression>,
        right: Box<Expression>,
    },
    Comparison {
        op: ComparisonOp,
        left: Box<Expression>,
        right: Box<Expression>,
    },
    Pairwise {
        function: PairwiseFunction,
        left: Box<Expression>,
        right: Box<Expression>,
    },
    Logical {
        op: LogicalOp,
        left: Box<Expression>,
        right: Box<Expression>,
    },
    Not {
        value: Box<Expression>,
    },
    Conditional {
        #[serde(rename = "if")]
        condition: Box<Expression>,
        #[serde(rename = "thenValue")]
        then_value: Box<Expression>,
        #[serde(rename = "elseValue")]
        else_value: Box<Expression>,
    },
    Rolling {
        function: RollingFunction,
        input: Box<Expression>,
        window: usize,
    },
    Technical {
        function: TechnicalFunction,
        window: Option<usize>,
    },
    BuiltInIndicator {
        #[serde(rename = "definitionId")]
        definition_id: String,
        #[serde(rename = "outputKey")]
        output_key: String,
        #[serde(default)]
        parameters: BTreeMap<String, f64>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceLimits {
    pub max_bars: usize,
    pub max_nodes: usize,
    pub max_depth: usize,
    pub max_rolling_window: usize,
    pub max_operations: usize,
}

impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            max_bars: 100_000,
            max_nodes: 300,
            max_depth: 24,
            max_rolling_window: 5_000,
            max_operations: 10_000_000,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ValidationSummary {
    pub value_type: ValueType,
    pub node_count: usize,
    pub max_lookback: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OhlcvColumns {
    pub timestamp: Vec<i64>,
    pub open: Vec<f64>,
    pub high: Vec<f64>,
    pub low: Vec<f64>,
    pub close: Vec<f64>,
    pub volume: Vec<f64>,
}

impl OhlcvColumns {
    pub fn len(&self) -> usize {
        self.close.len()
    }

    pub fn is_empty(&self) -> bool {
        self.close.is_empty()
    }

    fn validate(&self, limits: ResourceLimits) -> Result<(), DslError> {
        let expected = self.len();
        for (name, length) in [
            ("timestamp", self.timestamp.len()),
            ("open", self.open.len()),
            ("high", self.high.len()),
            ("low", self.low.len()),
            ("close", self.close.len()),
            ("volume", self.volume.len()),
        ] {
            if length != expected {
                return Err(DslError::ColumnLengthMismatch {
                    field: name,
                    expected,
                    actual: length,
                });
            }
        }
        if expected > limits.max_bars {
            return Err(DslError::BarLimitExceeded {
                actual: expected,
                limit: limits.max_bars,
            });
        }
        for (name, values) in [
            ("open", &self.open),
            ("high", &self.high),
            ("low", &self.low),
            ("close", &self.close),
            ("volume", &self.volume),
        ] {
            if values.iter().any(|value| !value.is_finite()) {
                return Err(DslError::NonFiniteInput { field: name });
            }
        }
        Ok(())
    }

    fn field(&self, field: OhlcvField) -> Vec<Option<f64>> {
        match field {
            OhlcvField::Timestamp => self
                .timestamp
                .iter()
                .map(|value| Some(*value as f64))
                .collect(),
            OhlcvField::Open => self.open.iter().copied().map(Some).collect(),
            OhlcvField::High => self.high.iter().copied().map(Some).collect(),
            OhlcvField::Low => self.low.iter().copied().map(Some).collect(),
            OhlcvField::Close => self.close.iter().copied().map(Some).collect(),
            OhlcvField::Volume => self.volume.iter().copied().map(Some).collect(),
            OhlcvField::Hl2 => self
                .high
                .iter()
                .zip(&self.low)
                .map(|(high, low)| Some((high + low) / 2.0))
                .collect(),
            OhlcvField::Hlc3 => self
                .high
                .iter()
                .zip(&self.low)
                .zip(&self.close)
                .map(|((high, low), close)| Some((high + low + close) / 3.0))
                .collect(),
            OhlcvField::Ohlc4 => self
                .open
                .iter()
                .zip(&self.high)
                .zip(&self.low)
                .zip(&self.close)
                .map(|(((open, high), low), close)| Some((open + high + low + close) / 4.0))
                .collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum EvaluatedSeries {
    Number(Vec<Option<f64>>),
    Boolean(Vec<Option<bool>>),
}

impl EvaluatedSeries {
    pub fn value_type(&self) -> ValueType {
        match self {
            Self::Number(_) => ValueType::Number,
            Self::Boolean(_) => ValueType::Boolean,
        }
    }

    pub fn len(&self) -> usize {
        match self {
            Self::Number(values) => values.len(),
            Self::Boolean(values) => values.len(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DslError {
    NonFiniteLiteral,
    NonFiniteInput {
        field: &'static str,
    },
    ColumnLengthMismatch {
        field: &'static str,
        expected: usize,
        actual: usize,
    },
    BarLimitExceeded {
        actual: usize,
        limit: usize,
    },
    NodeLimitExceeded {
        actual: usize,
        limit: usize,
    },
    DepthLimitExceeded {
        actual: usize,
        limit: usize,
    },
    RollingWindowInvalid {
        window: usize,
        limit: usize,
    },
    InvalidIndicator {
        message: String,
    },
    TypeMismatch {
        expected: ValueType,
        actual: ValueType,
    },
    ConditionalBranchMismatch {
        then_type: ValueType,
        else_type: ValueType,
    },
    OperationBudgetExceeded {
        estimated: usize,
        limit: usize,
    },
}

impl fmt::Display for DslError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NonFiniteLiteral => write!(formatter, "numeric literals must be finite"),
            Self::NonFiniteInput { field } => {
                write!(formatter, "{field} contains a non-finite value")
            }
            Self::ColumnLengthMismatch {
                field,
                expected,
                actual,
            } => {
                write!(
                    formatter,
                    "{field} length {actual} does not match {expected}"
                )
            }
            Self::BarLimitExceeded { actual, limit } => {
                write!(formatter, "bar count {actual} exceeds {limit}")
            }
            Self::NodeLimitExceeded { actual, limit } => {
                write!(formatter, "AST nodes {actual} exceeds {limit}")
            }
            Self::DepthLimitExceeded { actual, limit } => {
                write!(formatter, "AST depth {actual} exceeds {limit}")
            }
            Self::RollingWindowInvalid { window, limit } => {
                write!(formatter, "rolling window {window} is outside 1..={limit}")
            }
            Self::InvalidIndicator { message } => write!(formatter, "invalid indicator: {message}"),
            Self::TypeMismatch { expected, actual } => {
                write!(formatter, "expected {expected:?}, found {actual:?}")
            }
            Self::ConditionalBranchMismatch {
                then_type,
                else_type,
            } => {
                write!(
                    formatter,
                    "conditional branches differ: {then_type:?} vs {else_type:?}"
                )
            }
            Self::OperationBudgetExceeded { estimated, limit } => {
                write!(formatter, "operation budget {estimated} exceeds {limit}")
            }
        }
    }
}

impl std::error::Error for DslError {}

impl Expression {
    pub fn validate(&self, limits: ResourceLimits) -> Result<ValidationSummary, DslError> {
        let mut state = ValidationState::default();
        let value_type = validate_expression(self, limits, 1, &mut state)?;
        Ok(ValidationSummary {
            value_type,
            node_count: state.node_count,
            max_lookback: state.max_lookback,
        })
    }

    pub fn evaluate(
        &self,
        columns: &OhlcvColumns,
        limits: ResourceLimits,
    ) -> Result<EvaluatedSeries, DslError> {
        columns.validate(limits)?;
        let validation = self.validate(limits)?;
        let estimated = estimate_operations(
            validation.node_count,
            validation.max_lookback,
            columns.len(),
        );
        if estimated > limits.max_operations {
            return Err(DslError::OperationBudgetExceeded {
                estimated,
                limit: limits.max_operations,
            });
        }
        evaluate_expression(self, columns)
    }
}

#[derive(Default)]
struct ValidationState {
    node_count: usize,
    max_lookback: usize,
}

fn validate_expression(
    expression: &Expression,
    limits: ResourceLimits,
    depth: usize,
    state: &mut ValidationState,
) -> Result<ValueType, DslError> {
    state.node_count = state.node_count.saturating_add(1);
    if state.node_count > limits.max_nodes {
        return Err(DslError::NodeLimitExceeded {
            actual: state.node_count,
            limit: limits.max_nodes,
        });
    }
    if depth > limits.max_depth {
        return Err(DslError::DepthLimitExceeded {
            actual: depth,
            limit: limits.max_depth,
        });
    }
    match expression {
        Expression::Field { .. } => Ok(ValueType::Number),
        Expression::Number { value } => value
            .is_finite()
            .then_some(ValueType::Number)
            .ok_or(DslError::NonFiniteLiteral),
        Expression::Boolean { .. } => Ok(ValueType::Boolean),
        Expression::Unary { value, .. } => {
            require_type(
                validate_expression(value, limits, depth + 1, state)?,
                ValueType::Number,
            )?;
            Ok(ValueType::Number)
        }
        Expression::Arithmetic { left, right, .. } => {
            require_type(
                validate_expression(left, limits, depth + 1, state)?,
                ValueType::Number,
            )?;
            require_type(
                validate_expression(right, limits, depth + 1, state)?,
                ValueType::Number,
            )?;
            Ok(ValueType::Number)
        }
        Expression::Comparison { left, right, .. } => {
            require_type(
                validate_expression(left, limits, depth + 1, state)?,
                ValueType::Number,
            )?;
            require_type(
                validate_expression(right, limits, depth + 1, state)?,
                ValueType::Number,
            )?;
            Ok(ValueType::Boolean)
        }
        Expression::Pairwise { left, right, .. } => {
            require_type(
                validate_expression(left, limits, depth + 1, state)?,
                ValueType::Number,
            )?;
            require_type(
                validate_expression(right, limits, depth + 1, state)?,
                ValueType::Number,
            )?;
            Ok(ValueType::Number)
        }
        Expression::Logical { left, right, .. } => {
            require_type(
                validate_expression(left, limits, depth + 1, state)?,
                ValueType::Boolean,
            )?;
            require_type(
                validate_expression(right, limits, depth + 1, state)?,
                ValueType::Boolean,
            )?;
            Ok(ValueType::Boolean)
        }
        Expression::Not { value } => {
            require_type(
                validate_expression(value, limits, depth + 1, state)?,
                ValueType::Boolean,
            )?;
            Ok(ValueType::Boolean)
        }
        Expression::Conditional {
            condition,
            then_value,
            else_value,
        } => {
            require_type(
                validate_expression(condition, limits, depth + 1, state)?,
                ValueType::Boolean,
            )?;
            let then_type = validate_expression(then_value, limits, depth + 1, state)?;
            let else_type = validate_expression(else_value, limits, depth + 1, state)?;
            if then_type != else_type {
                return Err(DslError::ConditionalBranchMismatch {
                    then_type,
                    else_type,
                });
            }
            Ok(then_type)
        }
        Expression::Rolling { input, window, .. } => {
            if *window == 0 || *window > limits.max_rolling_window {
                return Err(DslError::RollingWindowInvalid {
                    window: *window,
                    limit: limits.max_rolling_window,
                });
            }
            let lookback = if matches!(
                expression,
                Expression::Rolling {
                    function: RollingFunction::Ema,
                    ..
                }
            ) {
                500
            } else {
                *window
            };
            state.max_lookback = state.max_lookback.max(lookback);
            require_type(
                validate_expression(input, limits, depth + 1, state)?,
                ValueType::Number,
            )?;
            Ok(ValueType::Number)
        }
        Expression::Technical { function, window } => {
            let lookback = match (function, window) {
                (TechnicalFunction::Vwap, None) => 500,
                (TechnicalFunction::Rsi | TechnicalFunction::Atr, Some(window))
                    if *window > 0 && *window <= limits.max_rolling_window =>
                {
                    window.saturating_add(1)
                }
                (_, Some(window)) => {
                    return Err(DslError::RollingWindowInvalid {
                        window: *window,
                        limit: limits.max_rolling_window,
                    })
                }
                _ => {
                    return Err(DslError::InvalidIndicator {
                        message: "technical function window is missing or unexpected".to_string(),
                    })
                }
            };
            state.max_lookback = state.max_lookback.max(lookback);
            Ok(ValueType::Number)
        }
        Expression::BuiltInIndicator {
            definition_id,
            output_key,
            parameters,
        } => {
            let lookback = built_in::validate(definition_id, output_key, parameters)
                .map_err(|message| DslError::InvalidIndicator { message })?;
            if lookback > limits.max_rolling_window {
                return Err(DslError::RollingWindowInvalid {
                    window: lookback,
                    limit: limits.max_rolling_window,
                });
            }
            state.max_lookback = state.max_lookback.max(lookback);
            Ok(ValueType::Number)
        }
    }
}

fn require_type(actual: ValueType, expected: ValueType) -> Result<(), DslError> {
    if actual == expected {
        Ok(())
    } else {
        Err(DslError::TypeMismatch { expected, actual })
    }
}

fn estimate_operations(nodes: usize, lookback: usize, bars: usize) -> usize {
    let per_bar = nodes.saturating_add(lookback.max(1));
    per_bar.saturating_mul(bars)
}

fn evaluate_expression(
    expression: &Expression,
    columns: &OhlcvColumns,
) -> Result<EvaluatedSeries, DslError> {
    let len = columns.len();
    match expression {
        Expression::Field { field } => Ok(EvaluatedSeries::Number(columns.field(*field))),
        Expression::Number { value } => Ok(EvaluatedSeries::Number(vec![Some(*value); len])),
        Expression::Boolean { value } => Ok(EvaluatedSeries::Boolean(vec![Some(*value); len])),
        Expression::Unary { op, value } => {
            let values = expect_numbers(evaluate_expression(value, columns)?)?;
            Ok(EvaluatedSeries::Number(
                values
                    .into_iter()
                    .map(|value| {
                        value.and_then(|value| {
                            let result = match op {
                                UnaryOp::Negate => -value,
                                UnaryOp::Absolute => value.abs(),
                            };
                            result.is_finite().then_some(result)
                        })
                    })
                    .collect(),
            ))
        }
        Expression::Arithmetic { op, left, right } => {
            let left = expect_numbers(evaluate_expression(left, columns)?)?;
            let right = expect_numbers(evaluate_expression(right, columns)?)?;
            Ok(EvaluatedSeries::Number(
                left.into_iter()
                    .zip(right)
                    .map(|(left, right)| arithmetic(*op, left, right))
                    .collect(),
            ))
        }
        Expression::Comparison { op, left, right } => {
            let left = expect_numbers(evaluate_expression(left, columns)?)?;
            let right = expect_numbers(evaluate_expression(right, columns)?)?;
            Ok(EvaluatedSeries::Boolean(
                left.into_iter()
                    .zip(right)
                    .map(|(left, right)| comparison(*op, left, right))
                    .collect(),
            ))
        }
        Expression::Pairwise {
            function,
            left,
            right,
        } => {
            let left = expect_numbers(evaluate_expression(left, columns)?)?;
            let right = expect_numbers(evaluate_expression(right, columns)?)?;
            Ok(EvaluatedSeries::Number(
                left.into_iter()
                    .zip(right)
                    .map(|(left, right)| match (left, right) {
                        (Some(left), Some(right)) => Some(match function {
                            PairwiseFunction::Min => left.min(right),
                            PairwiseFunction::Max => left.max(right),
                        }),
                        _ => None,
                    })
                    .collect(),
            ))
        }
        Expression::Logical { op, left, right } => {
            let left = expect_booleans(evaluate_expression(left, columns)?)?;
            let right = expect_booleans(evaluate_expression(right, columns)?)?;
            Ok(EvaluatedSeries::Boolean(
                left.into_iter()
                    .zip(right)
                    .map(|(left, right)| match (left, right) {
                        (Some(false), _) if *op == LogicalOp::And => Some(false),
                        (Some(true), _) if *op == LogicalOp::Or => Some(true),
                        (Some(true), right) if *op == LogicalOp::And => right,
                        (Some(false), right) if *op == LogicalOp::Or => right,
                        (None, _) => None,
                        _ => None,
                    })
                    .collect(),
            ))
        }
        Expression::Not { value } => {
            let values = expect_booleans(evaluate_expression(value, columns)?)?;
            Ok(EvaluatedSeries::Boolean(
                values
                    .into_iter()
                    .map(|value| value.map(|value| !value))
                    .collect(),
            ))
        }
        Expression::Conditional {
            condition,
            then_value,
            else_value,
        } => {
            let condition = expect_booleans(evaluate_expression(condition, columns)?)?;
            let then_value = evaluate_expression(then_value, columns)?;
            let else_value = evaluate_expression(else_value, columns)?;
            match (then_value, else_value) {
                (EvaluatedSeries::Number(then_values), EvaluatedSeries::Number(else_values)) => {
                    Ok(EvaluatedSeries::Number(
                        condition
                            .into_iter()
                            .zip(then_values)
                            .zip(else_values)
                            .map(|((condition, yes), no)| {
                                condition.and_then(|condition| if condition { yes } else { no })
                            })
                            .collect(),
                    ))
                }
                (EvaluatedSeries::Boolean(then_values), EvaluatedSeries::Boolean(else_values)) => {
                    Ok(EvaluatedSeries::Boolean(
                        condition
                            .into_iter()
                            .zip(then_values)
                            .zip(else_values)
                            .map(|((condition, yes), no)| {
                                condition.and_then(|condition| if condition { yes } else { no })
                            })
                            .collect(),
                    ))
                }
                (then_value, else_value) => Err(DslError::ConditionalBranchMismatch {
                    then_type: then_value.value_type(),
                    else_type: else_value.value_type(),
                }),
            }
        }
        Expression::Rolling {
            function,
            input,
            window,
        } => {
            let values = expect_numbers(evaluate_expression(input, columns)?)?;
            Ok(EvaluatedSeries::Number(rolling(
                *function, &values, *window,
            )))
        }
        Expression::Technical { function, window } => {
            let values = match function {
                TechnicalFunction::Rsi => technical_rsi(columns, window.unwrap_or_default()),
                TechnicalFunction::Atr => technical_atr(columns, window.unwrap_or_default()),
                TechnicalFunction::Vwap => built_in::vwap(columns),
            };
            Ok(EvaluatedSeries::Number(values))
        }
        Expression::BuiltInIndicator {
            definition_id,
            output_key,
            parameters,
        } => Ok(EvaluatedSeries::Number(
            built_in::evaluate(definition_id, output_key, parameters, columns)
                .map_err(|message| DslError::InvalidIndicator { message })?,
        )),
    }
}

fn expect_numbers(series: EvaluatedSeries) -> Result<Vec<Option<f64>>, DslError> {
    let actual = series.value_type();
    match series {
        EvaluatedSeries::Number(values) => Ok(values),
        _ => Err(DslError::TypeMismatch {
            expected: ValueType::Number,
            actual,
        }),
    }
}

fn expect_booleans(series: EvaluatedSeries) -> Result<Vec<Option<bool>>, DslError> {
    let actual = series.value_type();
    match series {
        EvaluatedSeries::Boolean(values) => Ok(values),
        _ => Err(DslError::TypeMismatch {
            expected: ValueType::Boolean,
            actual,
        }),
    }
}

fn arithmetic(op: ArithmeticOp, left: Option<f64>, right: Option<f64>) -> Option<f64> {
    let (left, right) = (left?, right?);
    let value = match op {
        ArithmeticOp::Add => left + right,
        ArithmeticOp::Subtract => left - right,
        ArithmeticOp::Multiply => left * right,
        ArithmeticOp::Divide if right.abs() > f64::EPSILON => left / right,
        ArithmeticOp::Divide => return None,
        ArithmeticOp::Modulo if right.abs() > f64::EPSILON => left % right,
        ArithmeticOp::Modulo => return None,
        ArithmeticOp::Power => left.powf(right),
    };
    value.is_finite().then_some(value)
}

fn comparison(op: ComparisonOp, left: Option<f64>, right: Option<f64>) -> Option<bool> {
    let (left, right) = (left?, right?);
    Some(match op {
        ComparisonOp::GreaterThan => left > right,
        ComparisonOp::GreaterOrEqual => left >= right,
        ComparisonOp::LessThan => left < right,
        ComparisonOp::LessOrEqual => left <= right,
        ComparisonOp::Equal => left == right,
        ComparisonOp::NotEqual => left != right,
    })
}

fn rolling(function: RollingFunction, values: &[Option<f64>], window: usize) -> Vec<Option<f64>> {
    match function {
        RollingFunction::Ema => rolling_ema(values, window),
        _ => (0..values.len())
            .map(|index| {
                if index + 1 < window {
                    return None;
                }
                let slice = &values[index + 1 - window..=index];
                let values = slice.iter().copied().collect::<Option<Vec<_>>>()?;
                match function {
                    RollingFunction::Sma => Some(values.iter().sum::<f64>() / window as f64),
                    RollingFunction::Sum => Some(values.iter().sum()),
                    RollingFunction::Lowest => values.into_iter().reduce(f64::min),
                    RollingFunction::Highest => values.into_iter().reduce(f64::max),
                    RollingFunction::StdDev => {
                        let mean = values.iter().sum::<f64>() / window as f64;
                        Some(
                            (values
                                .iter()
                                .map(|value| (value - mean).powi(2))
                                .sum::<f64>()
                                / window as f64)
                                .sqrt(),
                        )
                    }
                    RollingFunction::Ema => unreachable!("handled above"),
                }
            })
            .collect(),
    }
}

fn rolling_ema(values: &[Option<f64>], window: usize) -> Vec<Option<f64>> {
    let alpha = 2.0 / (window as f64 + 1.0);
    let mut output = Vec::with_capacity(values.len());
    let mut previous = None;
    for (index, value) in values.iter().copied().enumerate() {
        if index + 1 < window {
            output.push(None);
            continue;
        }
        let seed = if index + 1 == window {
            values[..window]
                .iter()
                .copied()
                .collect::<Option<Vec<_>>>()
                .map(|items| items.iter().sum::<f64>() / window as f64)
        } else {
            match (previous, value) {
                (Some(previous), Some(value)) => Some(alpha * value + (1.0 - alpha) * previous),
                _ => None,
            }
        };
        previous = seed;
        output.push(seed.filter(|value| value.is_finite()));
    }
    output
}

fn technical_rsi(columns: &OhlcvColumns, window: usize) -> Vec<Option<f64>> {
    let mut output = vec![None; columns.len()];
    for index in window..columns.len() {
        let (mut gains, mut losses) = (0.0, 0.0);
        for cursor in index + 1 - window..=index {
            let change = columns.close[cursor] - columns.close[cursor - 1];
            gains += change.max(0.0);
            losses += (-change).max(0.0);
        }
        output[index] = Some(if losses == 0.0 {
            if gains == 0.0 {
                50.0
            } else {
                100.0
            }
        } else {
            100.0 - 100.0 / (1.0 + gains / losses)
        });
    }
    output
}

fn technical_atr(columns: &OhlcvColumns, window: usize) -> Vec<Option<f64>> {
    let mut output = vec![None; columns.len()];
    for index in window..columns.len() {
        let mut sum = 0.0;
        for cursor in index + 1 - window..=index {
            sum += (columns.high[cursor] - columns.low[cursor])
                .max((columns.high[cursor] - columns.close[cursor - 1]).abs())
                .max((columns.low[cursor] - columns.close[cursor - 1]).abs());
        }
        output[index] = Some(sum / window as f64);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn columns() -> OhlcvColumns {
        OhlcvColumns {
            timestamp: vec![1, 2, 3, 4, 5],
            open: vec![10.0, 11.0, 12.0, 13.0, 14.0],
            high: vec![11.0, 12.0, 13.0, 14.0, 15.0],
            low: vec![9.0, 10.0, 11.0, 12.0, 13.0],
            close: vec![10.0, 12.0, 11.0, 14.0, 15.0],
            volume: vec![1.0, 2.0, 3.0, 4.0, 5.0],
        }
    }

    fn field(field: OhlcvField) -> Expression {
        Expression::Field { field }
    }

    #[test]
    fn evaluates_typed_conditional_with_rolling_sma() {
        let expression = Expression::Conditional {
            condition: Box::new(Expression::Comparison {
                op: ComparisonOp::GreaterThan,
                left: Box::new(field(OhlcvField::Close)),
                right: Box::new(field(OhlcvField::Open)),
            }),
            then_value: Box::new(Expression::Rolling {
                function: RollingFunction::Sma,
                input: Box::new(field(OhlcvField::Close)),
                window: 2,
            }),
            else_value: Box::new(Expression::Number { value: 0.0 }),
        };
        assert_eq!(
            expression
                .validate(ResourceLimits::default())
                .unwrap()
                .value_type,
            ValueType::Number
        );
        assert_eq!(
            expression
                .evaluate(&columns(), ResourceLimits::default())
                .unwrap(),
            EvaluatedSeries::Number(vec![
                Some(0.0),
                Some(11.0),
                Some(0.0),
                Some(12.5),
                Some(14.5)
            ]),
        );
    }

    #[test]
    fn rejects_type_mismatch_and_invalid_window() {
        let arithmetic = Expression::Arithmetic {
            op: ArithmeticOp::Add,
            left: Box::new(Expression::Boolean { value: true }),
            right: Box::new(Expression::Number { value: 1.0 }),
        };
        assert!(matches!(
            arithmetic.validate(ResourceLimits::default()),
            Err(DslError::TypeMismatch { .. })
        ));
        let rolling = Expression::Rolling {
            function: RollingFunction::Sma,
            input: Box::new(field(OhlcvField::Close)),
            window: 0,
        };
        assert!(matches!(
            rolling.validate(ResourceLimits::default()),
            Err(DslError::RollingWindowInvalid { .. })
        ));
    }

    #[test]
    fn operation_budget_rejects_expensive_expression_before_evaluation() {
        let expression = Expression::Rolling {
            function: RollingFunction::StdDev,
            input: Box::new(field(OhlcvField::Close)),
            window: 5,
        };
        let limits = ResourceLimits {
            max_operations: 5,
            ..ResourceLimits::default()
        };
        assert!(matches!(
            expression.evaluate(&columns(), limits),
            Err(DslError::OperationBudgetExceeded { .. })
        ));
    }

    #[test]
    fn divide_by_zero_is_missing_not_infinite() {
        let expression = Expression::Arithmetic {
            op: ArithmeticOp::Divide,
            left: Box::new(field(OhlcvField::Close)),
            right: Box::new(Expression::Number { value: 0.0 }),
        };
        assert_eq!(
            expression
                .evaluate(&columns(), ResourceLimits::default())
                .unwrap(),
            EvaluatedSeries::Number(vec![None; 5]),
        );
    }

    #[test]
    fn rejects_non_finite_input_and_column_shape_mismatch() {
        let mut invalid = columns();
        invalid.close[1] = f64::NAN;
        assert!(matches!(
            field(OhlcvField::Close).evaluate(&invalid, ResourceLimits::default()),
            Err(DslError::NonFiniteInput { .. })
        ));
        let mut mismatch = columns();
        mismatch.volume.pop();
        assert!(matches!(
            field(OhlcvField::Volume).evaluate(&mismatch, ResourceLimits::default()),
            Err(DslError::ColumnLengthMismatch { .. })
        ));
    }

    #[test]
    fn serde_ast_is_data_only_and_round_trips() {
        let expression = Expression::Rolling {
            function: RollingFunction::Ema,
            input: Box::new(field(OhlcvField::Close)),
            window: 3,
        };
        let json = serde_json::to_string(&expression).unwrap();
        assert!(json.contains("\"kind\":\"rolling\""));
        assert_eq!(
            serde_json::from_str::<Expression>(&json).unwrap(),
            expression
        );
    }
}
