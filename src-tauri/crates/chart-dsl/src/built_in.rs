use super::OhlcvColumns;
use std::collections::BTreeMap;

type Series = Vec<Option<f64>>;

pub(crate) fn validate(
    definition_id: &str,
    output_key: &str,
    parameters: &BTreeMap<String, f64>,
) -> Result<usize, String> {
    if parameters.values().any(|value| !value.is_finite()) {
        return Err("indicator parameters must be finite".to_string());
    }
    let period = |key: &str, fallback: usize| integer_parameter(parameters, key, fallback);
    let lookback = match definition_id {
        "ma" | "ema" => {
            expect_output(output_key, &[definition_id])?;
            let period = period("period", 20)?;
            if definition_id == "ema" {
                500
            } else {
                period
            }
        }
        "vwap" => {
            expect_output(output_key, &["vwap"])?;
            500
        }
        "boll" => {
            expect_output(output_key, &["middle", "upper", "lower"])?;
            positive_parameter(parameters, "multiplier", 2.0)?;
            period("period", 20)?
        }
        "donchian" => {
            expect_output(output_key, &["upper", "middle", "lower"])?;
            period("period", 20)?
        }
        "keltner" => {
            expect_output(output_key, &["middle", "upper", "lower"])?;
            positive_parameter(parameters, "multiplier", 2.0)?;
            period("period", 20)?;
            period("atrPeriod", 10)?;
            500
        }
        "psar" => {
            expect_output(output_key, &["psar"])?;
            let step = positive_parameter(parameters, "step", 0.02)?;
            let max_step = positive_parameter(parameters, "maxStep", 0.2)?;
            if step > max_step {
                return Err("step must not exceed maxStep".to_string());
            }
            500
        }
        "supertrend" => {
            expect_output(output_key, &["supertrend"])?;
            positive_parameter(parameters, "multiplier", 3.0)?;
            period("period", 10)?;
            500
        }
        "ichimoku" => {
            expect_output(output_key, &["conversion", "base", "spanA", "spanB"])?;
            let conversion = period("conversionPeriod", 9)?;
            let base = period("basePeriod", 26)?;
            let span_b = period("spanBPeriod", 52)?;
            if conversion > base || base > span_b {
                return Err("ichimoku periods must be ordered".to_string());
            }
            period("spanBPeriod", 52)?
        }
        "rsi" => {
            expect_output(output_key, &["rsi"])?;
            period("period", 14)?;
            500
        }
        "macd" => {
            expect_output(output_key, &["macd", "signal", "histogram"])?;
            if period("fast", 12)? >= period("slow", 26)? {
                return Err("MACD fast must be less than slow".to_string());
            }
            period("signal", 9)?;
            500
        }
        "kdj" => {
            expect_output(output_key, &["k", "d", "j"])?;
            period("period", 9)? + period("kPeriod", 3)? + period("dPeriod", 3)?
        }
        "atr" => {
            expect_output(output_key, &["atr"])?;
            period("period", 14)?;
            500
        }
        "adx" => {
            expect_output(output_key, &["adx", "plusDi", "minusDi"])?;
            period("period", 14)?;
            500
        }
        "stochastic" => {
            expect_output(output_key, &["k", "d"])?;
            period("period", 14)? + period("kSmoothing", 3)? + period("dPeriod", 3)?
        }
        "cci" => {
            expect_output(output_key, &["cci"])?;
            period("period", 20)?
        }
        "roc" => {
            expect_output(output_key, &["roc"])?;
            period("period", 12)? + 1
        }
        "aroon" => {
            expect_output(output_key, &["up", "down"])?;
            period("period", 14)?
        }
        "trix" => {
            expect_output(output_key, &["trix", "signal"])?;
            period("period", 15)?;
            period("signal", 9)?;
            500
        }
        "williams-r" => {
            expect_output(output_key, &["williamsR"])?;
            period("period", 14)?
        }
        "mfi" => {
            expect_output(output_key, &["mfi"])?;
            period("period", 14)? + 1
        }
        "cmf" => {
            expect_output(output_key, &["cmf"])?;
            period("period", 20)?
        }
        "obv" => {
            expect_output(output_key, &["obv"])?;
            500
        }
        "volume-ma" => {
            expect_output(output_key, &["volume", "ma"])?;
            if output_key == "ma" {
                period("period", 20)?
            } else {
                1
            }
        }
        _ => return Err(format!("unsupported indicator: {definition_id}")),
    };
    Ok(lookback)
}

pub(crate) fn evaluate(
    definition_id: &str,
    output_key: &str,
    parameters: &BTreeMap<String, f64>,
    columns: &OhlcvColumns,
) -> Result<Series, String> {
    validate(definition_id, output_key, parameters)?;
    let period = |key: &str, fallback: usize| integer_parameter(parameters, key, fallback);
    let output = match definition_id {
        "ma" => sma(&columns.close, period("period", 20)?),
        "ema" => ema(&columns.close, period("period", 20)?),
        "vwap" => vwap(columns),
        "boll" => {
            let middle = sma(&columns.close, period("period", 20)?);
            let deviation = rolling_stddev(&columns.close, period("period", 20)?);
            combine(&middle, &deviation, |average, deviation| {
                let multiplier = number_parameter(parameters, "multiplier", 2.0);
                match output_key {
                    "upper" => average + deviation * multiplier,
                    "lower" => average - deviation * multiplier,
                    _ => average,
                }
            })
        }
        "donchian" => {
            let upper = rolling_extreme(&columns.high, period("period", 20)?, f64::max);
            let lower = rolling_extreme(&columns.low, period("period", 20)?, f64::min);
            match output_key {
                "upper" => upper,
                "lower" => lower,
                _ => combine(&upper, &lower, |high, low| (high + low) / 2.0),
            }
        }
        "keltner" => {
            let middle = ema(&columns.close, period("period", 20)?);
            if output_key == "middle" {
                return Ok(middle);
            }
            let range = atr(columns, period("atrPeriod", 10)?);
            combine(&middle, &range, |average, range| {
                let multiplier = number_parameter(parameters, "multiplier", 2.0);
                match output_key {
                    "upper" => average + range * multiplier,
                    "lower" => average - range * multiplier,
                    _ => average,
                }
            })
        }
        "psar" => parabolic_sar(
            columns,
            positive_parameter(parameters, "step", 0.02)?,
            positive_parameter(parameters, "maxStep", 0.2)?,
        ),
        "supertrend" => supertrend(
            columns,
            period("period", 10)?,
            number_parameter(parameters, "multiplier", 3.0),
        ),
        "ichimoku" => ichimoku(
            columns,
            output_key,
            period("conversionPeriod", 9)?,
            period("basePeriod", 26)?,
            period("spanBPeriod", 52)?,
        ),
        "rsi" => rsi(&columns.close, period("period", 14)?),
        "macd" => macd(
            &columns.close,
            output_key,
            period("fast", 12)?,
            period("slow", 26)?,
            period("signal", 9)?,
        ),
        "kdj" => stochastic_family(
            columns,
            output_key,
            period("period", 9)?,
            period("kPeriod", 3)?,
            period("dPeriod", 3)?,
            true,
        ),
        "atr" => atr(columns, period("period", 14)?),
        "adx" => adx_dmi(columns, output_key, period("period", 14)?),
        "stochastic" => stochastic_family(
            columns,
            output_key,
            period("period", 14)?,
            period("kSmoothing", 3)?,
            period("dPeriod", 3)?,
            false,
        ),
        "cci" => cci(columns, period("period", 20)?),
        "roc" => roc(&columns.close, period("period", 12)?),
        "aroon" => aroon(columns, output_key, period("period", 14)?),
        "trix" => trix(
            &columns.close,
            output_key,
            period("period", 15)?,
            period("signal", 9)?,
        ),
        "williams-r" => williams_r(columns, period("period", 14)?),
        "mfi" => mfi(columns, period("period", 14)?),
        "cmf" => cmf(columns, period("period", 20)?),
        "obv" => obv(columns),
        "volume-ma" if output_key == "volume" => columns.volume.iter().copied().map(Some).collect(),
        "volume-ma" => sma(&columns.volume, period("period", 20)?),
        _ => return Err(format!("unsupported indicator: {definition_id}")),
    };
    Ok(output)
}

fn expect_output(output: &str, allowed: &[&str]) -> Result<(), String> {
    allowed
        .contains(&output)
        .then_some(())
        .ok_or_else(|| format!("unsupported indicator output: {output}"))
}

fn integer_parameter(
    parameters: &BTreeMap<String, f64>,
    key: &str,
    fallback: usize,
) -> Result<usize, String> {
    let value = parameters.get(key).copied().unwrap_or(fallback as f64);
    if value.is_finite() && value.fract() == 0.0 && (1.0..=500.0).contains(&value) {
        Ok(value as usize)
    } else {
        Err(format!("{key} must be an integer between 1 and 500"))
    }
}

fn positive_parameter(
    parameters: &BTreeMap<String, f64>,
    key: &str,
    fallback: f64,
) -> Result<f64, String> {
    let value = parameters.get(key).copied().unwrap_or(fallback);
    if value.is_finite() && value > 0.0 {
        Ok(value)
    } else {
        Err(format!("{key} must be positive"))
    }
}

fn number_parameter(parameters: &BTreeMap<String, f64>, key: &str, fallback: f64) -> f64 {
    parameters.get(key).copied().unwrap_or(fallback)
}

fn empty(len: usize) -> Series {
    vec![None; len]
}

fn sma(values: &[f64], period: usize) -> Series {
    let mut output = empty(values.len());
    let mut sum = 0.0;
    for (index, value) in values.iter().copied().enumerate() {
        sum += value;
        if index >= period {
            sum -= values[index - period];
        }
        if index + 1 >= period {
            output[index] = Some(sum / period as f64);
        }
    }
    output
}

fn ema(values: &[f64], period: usize) -> Series {
    let mut output = empty(values.len());
    if values.len() < period {
        return output;
    }
    let mut current = values[..period].iter().sum::<f64>() / period as f64;
    output[period - 1] = Some(current);
    let multiplier = 2.0 / (period as f64 + 1.0);
    for index in period..values.len() {
        current = (values[index] - current) * multiplier + current;
        output[index] = Some(current);
    }
    output
}

fn ema_optional(values: &[Option<f64>], period: usize) -> Series {
    let compact: Vec<(usize, f64)> = values
        .iter()
        .copied()
        .enumerate()
        .filter_map(|(index, value)| value.map(|value| (index, value)))
        .collect();
    let mut output = empty(values.len());
    if compact.len() < period {
        return output;
    }
    let mut current = compact[..period]
        .iter()
        .map(|(_, value)| value)
        .sum::<f64>()
        / period as f64;
    output[compact[period - 1].0] = Some(current);
    let multiplier = 2.0 / (period as f64 + 1.0);
    for (index, value) in compact.into_iter().skip(period) {
        current = (value - current) * multiplier + current;
        output[index] = Some(current);
    }
    output
}

fn rolling_stddev(values: &[f64], period: usize) -> Series {
    let mut output = empty(values.len());
    for index in period.saturating_sub(1)..values.len() {
        let slice = &values[index + 1 - period..=index];
        let mean = slice.iter().sum::<f64>() / period as f64;
        output[index] = Some(
            (slice
                .iter()
                .map(|value| (value - mean).powi(2))
                .sum::<f64>()
                / period as f64)
                .sqrt(),
        );
    }
    output
}

fn rolling_extreme(values: &[f64], period: usize, reduce: fn(f64, f64) -> f64) -> Series {
    let mut output = empty(values.len());
    for index in period.saturating_sub(1)..values.len() {
        output[index] = values[index + 1 - period..=index]
            .iter()
            .copied()
            .reduce(reduce);
    }
    output
}

fn combine(
    left: &[Option<f64>],
    right: &[Option<f64>],
    mapper: impl Fn(f64, f64) -> f64,
) -> Series {
    left.iter()
        .zip(right)
        .map(|(left, right)| match (*left, *right) {
            (Some(left), Some(right)) => {
                Some(mapper(left, right)).filter(|value| value.is_finite())
            }
            _ => None,
        })
        .collect()
}

pub(crate) fn vwap(columns: &OhlcvColumns) -> Series {
    let mut volume = 0.0;
    let mut weighted = 0.0;
    columns
        .volume
        .iter()
        .enumerate()
        .map(|(index, current_volume)| {
            volume += current_volume;
            weighted += ((columns.high[index] + columns.low[index] + columns.close[index]) / 3.0)
                * current_volume;
            (volume > 0.0).then_some(weighted / volume)
        })
        .collect()
}

fn true_ranges(columns: &OhlcvColumns) -> Vec<f64> {
    (1..columns.len())
        .map(|index| {
            (columns.high[index] - columns.low[index])
                .max((columns.high[index] - columns.close[index - 1]).abs())
                .max((columns.low[index] - columns.close[index - 1]).abs())
        })
        .collect()
}

pub(crate) fn atr(columns: &OhlcvColumns, period: usize) -> Series {
    let mut output = empty(columns.len());
    let ranges = true_ranges(columns);
    if ranges.len() < period {
        return output;
    }
    let mut current = ranges[..period].iter().sum::<f64>() / period as f64;
    output[period] = Some(current);
    for range_index in period..ranges.len() {
        current = (current * (period as f64 - 1.0) + ranges[range_index]) / period as f64;
        output[range_index + 1] = Some(current);
    }
    output
}

fn parabolic_sar(columns: &OhlcvColumns, step: f64, max_step: f64) -> Series {
    let mut output = empty(columns.len());
    if columns.len() < 2 {
        return output;
    }
    let mut rising = columns.close[1] >= columns.close[0];
    let mut acceleration = step;
    let mut extreme = if rising {
        columns.high[0].max(columns.high[1])
    } else {
        columns.low[0].min(columns.low[1])
    };
    let mut current = if rising {
        columns.low[0].min(columns.low[1])
    } else {
        columns.high[0].max(columns.high[1])
    };
    output[1] = Some(current);
    for index in 2..columns.len() {
        current += acceleration * (extreme - current);
        current = if rising {
            current
                .min(columns.low[index - 1])
                .min(columns.low[index - 2])
        } else {
            current
                .max(columns.high[index - 1])
                .max(columns.high[index - 2])
        };
        let reversed = if rising {
            columns.low[index] < current
        } else {
            columns.high[index] > current
        };
        if reversed {
            rising = !rising;
            current = extreme;
            extreme = if rising {
                columns.high[index]
            } else {
                columns.low[index]
            };
            acceleration = step;
        } else if rising && columns.high[index] > extreme {
            extreme = columns.high[index];
            acceleration = max_step.min(acceleration + step);
        } else if !rising && columns.low[index] < extreme {
            extreme = columns.low[index];
            acceleration = max_step.min(acceleration + step);
        }
        output[index] = Some(current);
    }
    output
}

fn supertrend(columns: &OhlcvColumns, period: usize, multiplier: f64) -> Series {
    let ranges = atr(columns, period);
    let mut output = empty(columns.len());
    let (mut previous_upper, mut previous_lower, mut previous_trend, mut previous_close) =
        (f64::NAN, f64::NAN, f64::NAN, f64::NAN);
    for index in 0..columns.len() {
        let Some(range) = ranges[index] else {
            previous_close = columns.close[index];
            continue;
        };
        let midpoint = (columns.high[index] + columns.low[index]) / 2.0;
        let basic_upper = midpoint + multiplier * range;
        let basic_lower = midpoint - multiplier * range;
        let upper = if !previous_upper.is_finite()
            || basic_upper < previous_upper
            || previous_close > previous_upper
        {
            basic_upper
        } else {
            previous_upper
        };
        let lower = if !previous_lower.is_finite()
            || basic_lower > previous_lower
            || previous_close < previous_lower
        {
            basic_lower
        } else {
            previous_lower
        };
        let trend = if !previous_trend.is_finite() {
            if columns.close[index] <= upper {
                upper
            } else {
                lower
            }
        } else if previous_trend == previous_upper {
            if columns.close[index] <= upper {
                upper
            } else {
                lower
            }
        } else if columns.close[index] >= lower {
            lower
        } else {
            upper
        };
        output[index] = Some(trend);
        (
            previous_upper,
            previous_lower,
            previous_trend,
            previous_close,
        ) = (upper, lower, trend, columns.close[index]);
    }
    output
}

fn midpoint_range(columns: &OhlcvColumns, period: usize) -> Series {
    let upper = rolling_extreme(&columns.high, period, f64::max);
    let lower = rolling_extreme(&columns.low, period, f64::min);
    combine(&upper, &lower, |high, low| (high + low) / 2.0)
}

fn ichimoku(
    columns: &OhlcvColumns,
    output_key: &str,
    conversion_period: usize,
    base_period: usize,
    span_b_period: usize,
) -> Series {
    let conversion = midpoint_range(columns, conversion_period);
    let base = midpoint_range(columns, base_period);
    match output_key {
        "conversion" => conversion,
        "base" => base,
        "spanA" => combine(&conversion, &base, |left, right| (left + right) / 2.0),
        _ => midpoint_range(columns, span_b_period),
    }
}

pub(crate) fn rsi(values: &[f64], period: usize) -> Series {
    let mut output = empty(values.len());
    if values.len() <= period {
        return output;
    }
    let (mut gain, mut loss) = (0.0, 0.0);
    for index in 1..=period {
        let change = values[index] - values[index - 1];
        gain += change.max(0.0);
        loss += (-change).max(0.0);
    }
    gain /= period as f64;
    loss /= period as f64;
    output[period] = Some(relative_strength(gain, loss));
    for index in period + 1..values.len() {
        let change = values[index] - values[index - 1];
        gain = (gain * (period as f64 - 1.0) + change.max(0.0)) / period as f64;
        loss = (loss * (period as f64 - 1.0) + (-change).max(0.0)) / period as f64;
        output[index] = Some(relative_strength(gain, loss));
    }
    output
}

fn relative_strength(gain: f64, loss: f64) -> f64 {
    if loss == 0.0 {
        if gain == 0.0 {
            50.0
        } else {
            100.0
        }
    } else {
        100.0 - 100.0 / (1.0 + gain / loss)
    }
}

fn macd(
    values: &[f64],
    output_key: &str,
    fast: usize,
    slow: usize,
    signal_period: usize,
) -> Series {
    let fast_values = ema(values, fast);
    let slow_values = ema(values, slow);
    let macd_values = combine(&fast_values, &slow_values, |fast, slow| fast - slow);
    if output_key == "macd" {
        return macd_values;
    }
    let signal = ema_optional(&macd_values, signal_period);
    if output_key == "signal" {
        signal
    } else {
        combine(&macd_values, &signal, |macd, signal| macd - signal)
    }
}

fn stochastic_family(
    columns: &OhlcvColumns,
    output_key: &str,
    period: usize,
    k_period: usize,
    d_period: usize,
    include_j: bool,
) -> Series {
    let upper = rolling_extreme(&columns.high, period, f64::max);
    let lower = rolling_extreme(&columns.low, period, f64::min);
    let raw_k: Series = upper
        .iter()
        .zip(&lower)
        .enumerate()
        .map(|(index, (high, low))| match (*high, *low) {
            (Some(high), Some(low)) => Some(if high == low {
                50.0
            } else {
                ((columns.close[index] - low) / (high - low)) * 100.0
            }),
            _ => None,
        })
        .collect();
    let k = sma_optional(&raw_k, k_period);
    if output_key == "k" {
        return k;
    }
    let d = sma_optional(&k, d_period);
    if output_key == "d" || !include_j {
        return d;
    }
    combine(&k, &d, |k, d| 3.0 * k - 2.0 * d)
}

fn sma_optional(values: &[Option<f64>], period: usize) -> Series {
    let compact: Vec<(usize, f64)> = values
        .iter()
        .copied()
        .enumerate()
        .filter_map(|(index, value)| value.map(|value| (index, value)))
        .collect();
    let mut output = empty(values.len());
    if compact.len() < period {
        return output;
    }
    let mut sum = 0.0;
    for (position, (index, value)) in compact.iter().copied().enumerate() {
        sum += value;
        if position >= period {
            sum -= compact[position - period].1;
        }
        if position + 1 >= period {
            output[index] = Some(sum / period as f64);
        }
    }
    output
}

fn adx_dmi(columns: &OhlcvColumns, output_key: &str, period: usize) -> Series {
    let mut plus_di = empty(columns.len());
    let mut minus_di = empty(columns.len());
    let mut dx = empty(columns.len());
    if columns.len() <= period {
        return dx;
    }
    let records: Vec<(f64, f64, f64)> = (1..columns.len())
        .map(|index| {
            let up = columns.high[index] - columns.high[index - 1];
            let down = columns.low[index - 1] - columns.low[index];
            let tr = (columns.high[index] - columns.low[index])
                .max((columns.high[index] - columns.close[index - 1]).abs())
                .max((columns.low[index] - columns.close[index - 1]).abs());
            (
                tr,
                if up > down && up > 0.0 { up } else { 0.0 },
                if down > up && down > 0.0 { down } else { 0.0 },
            )
        })
        .collect();
    if records.len() < period {
        return dx;
    }
    let (mut smooth_tr, mut smooth_plus, mut smooth_minus) =
        records[..period].iter().fold((0.0, 0.0, 0.0), |acc, item| {
            (acc.0 + item.0, acc.1 + item.1, acc.2 + item.2)
        });
    for record_index in period - 1..records.len() {
        if record_index > period - 1 {
            let item = records[record_index];
            smooth_tr = smooth_tr - smooth_tr / period as f64 + item.0;
            smooth_plus = smooth_plus - smooth_plus / period as f64 + item.1;
            smooth_minus = smooth_minus - smooth_minus / period as f64 + item.2;
        }
        let plus = if smooth_tr > 0.0 {
            100.0 * smooth_plus / smooth_tr
        } else {
            0.0
        };
        let minus = if smooth_tr > 0.0 {
            100.0 * smooth_minus / smooth_tr
        } else {
            0.0
        };
        let index = record_index + 1;
        plus_di[index] = Some(plus);
        minus_di[index] = Some(minus);
        dx[index] = Some(if plus + minus == 0.0 {
            0.0
        } else {
            100.0 * (plus - minus).abs() / (plus + minus)
        });
    }
    if output_key == "plusDi" {
        return plus_di;
    }
    if output_key == "minusDi" {
        return minus_di;
    }
    let compact: Vec<(usize, f64)> = dx
        .iter()
        .copied()
        .enumerate()
        .filter_map(|(index, value)| value.map(|value| (index, value)))
        .collect();
    let mut adx = empty(columns.len());
    if compact.len() < period {
        return adx;
    }
    let mut current = compact[..period]
        .iter()
        .map(|(_, value)| value)
        .sum::<f64>()
        / period as f64;
    adx[compact[period - 1].0] = Some(current);
    for (index, value) in compact.into_iter().skip(period) {
        current = (current * (period as f64 - 1.0) + value) / period as f64;
        adx[index] = Some(current);
    }
    adx
}

fn cci(columns: &OhlcvColumns, period: usize) -> Series {
    let typical: Vec<f64> = (0..columns.len())
        .map(|index| (columns.high[index] + columns.low[index] + columns.close[index]) / 3.0)
        .collect();
    let mut output = empty(columns.len());
    for index in period.saturating_sub(1)..columns.len() {
        let slice = &typical[index + 1 - period..=index];
        let average = slice.iter().sum::<f64>() / period as f64;
        let deviation = slice
            .iter()
            .map(|value| (value - average).abs())
            .sum::<f64>()
            / period as f64;
        output[index] = Some(if deviation == 0.0 {
            0.0
        } else {
            (typical[index] - average) / (0.015 * deviation)
        });
    }
    output
}

fn roc(values: &[f64], period: usize) -> Series {
    let mut output = empty(values.len());
    for index in period..values.len() {
        output[index] = Some(if values[index - period] == 0.0 {
            0.0
        } else {
            ((values[index] - values[index - period]) / values[index - period]) * 100.0
        });
    }
    output
}

fn aroon(columns: &OhlcvColumns, output_key: &str, period: usize) -> Series {
    let mut output = empty(columns.len());
    for index in period.saturating_sub(1)..columns.len() {
        let (mut highest, mut lowest, mut since_high, mut since_low) =
            (f64::NEG_INFINITY, f64::INFINITY, 0, 0);
        for offset in 0..period {
            if columns.high[index - offset] >= highest {
                highest = columns.high[index - offset];
                since_high = offset;
            }
            if columns.low[index - offset] <= lowest {
                lowest = columns.low[index - offset];
                since_low = offset;
            }
        }
        let divisor = (period.saturating_sub(1)).max(1) as f64;
        let since = if output_key == "up" {
            since_high
        } else {
            since_low
        };
        output[index] = Some((divisor - since as f64) / divisor * 100.0);
    }
    output
}

fn trix(values: &[f64], output_key: &str, period: usize, signal_period: usize) -> Series {
    let first = ema(values, period);
    let second = ema_optional(&first, period);
    let third = ema_optional(&second, period);
    let mut trix_values = empty(values.len());
    let compact: Vec<(usize, f64)> = third
        .iter()
        .copied()
        .enumerate()
        .filter_map(|(index, value)| value.map(|value| (index, value)))
        .collect();
    for pair in compact.windows(2) {
        let previous = pair[0].1;
        trix_values[pair[1].0] = Some(if previous == 0.0 {
            0.0
        } else {
            (pair[1].1 - previous) / previous * 100.0
        });
    }
    if output_key == "trix" {
        trix_values
    } else {
        ema_optional(&trix_values, signal_period)
    }
}

fn williams_r(columns: &OhlcvColumns, period: usize) -> Series {
    let upper = rolling_extreme(&columns.high, period, f64::max);
    let lower = rolling_extreme(&columns.low, period, f64::min);
    upper
        .iter()
        .zip(&lower)
        .enumerate()
        .map(|(index, (high, low))| match (*high, *low) {
            (Some(high), Some(low)) => Some(if high == low {
                -50.0
            } else {
                ((high - columns.close[index]) / (high - low)) * -100.0
            }),
            _ => None,
        })
        .collect()
}

fn mfi(columns: &OhlcvColumns, period: usize) -> Series {
    let typical: Vec<f64> = (0..columns.len())
        .map(|index| (columns.high[index] + columns.low[index] + columns.close[index]) / 3.0)
        .collect();
    let mut output = empty(columns.len());
    for index in period..columns.len() {
        let (mut positive, mut negative) = (0.0, 0.0);
        for cursor in index + 1 - period..=index {
            if typical[cursor] > typical[cursor - 1] {
                positive += typical[cursor] * columns.volume[cursor];
            }
            if typical[cursor] < typical[cursor - 1] {
                negative += typical[cursor] * columns.volume[cursor];
            }
        }
        output[index] = Some(if negative == 0.0 {
            if positive == 0.0 {
                50.0
            } else {
                100.0
            }
        } else {
            100.0 - 100.0 / (1.0 + positive / negative)
        });
    }
    output
}

fn cmf(columns: &OhlcvColumns, period: usize) -> Series {
    let mut output = empty(columns.len());
    for index in period.saturating_sub(1)..columns.len() {
        let (mut flow, mut volume) = (0.0, 0.0);
        for cursor in index + 1 - period..=index {
            let range = columns.high[cursor] - columns.low[cursor];
            let multiplier = if range == 0.0 {
                0.0
            } else {
                ((columns.close[cursor] - columns.low[cursor])
                    - (columns.high[cursor] - columns.close[cursor]))
                    / range
            };
            flow += multiplier * columns.volume[cursor];
            volume += columns.volume[cursor];
        }
        output[index] = Some(if volume == 0.0 { 0.0 } else { flow / volume });
    }
    output
}

fn obv(columns: &OhlcvColumns) -> Series {
    if columns.is_empty() {
        return Vec::new();
    }
    let mut output = vec![Some(0.0); columns.len()];
    let mut current = 0.0;
    for index in 1..columns.len() {
        current += if columns.close[index] > columns.close[index - 1] {
            columns.volume[index]
        } else if columns.close[index] < columns.close[index - 1] {
            -columns.volume[index]
        } else {
            0.0
        };
        output[index] = Some(current);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn columns() -> OhlcvColumns {
        OhlcvColumns {
            timestamp: (0..80).collect(),
            open: (0..80).map(|index| 100.0 + index as f64).collect(),
            high: (0..80).map(|index| 102.0 + index as f64).collect(),
            low: (0..80).map(|index| 98.0 + index as f64).collect(),
            close: (0..80).map(|index| 100.5 + index as f64).collect(),
            volume: (0..80).map(|index| 10.0 + index as f64).collect(),
        }
    }

    #[test]
    fn selected_multi_output_indicators_evaluate_to_aligned_series() {
        let parameters = BTreeMap::from([
            ("period".to_string(), 9.0),
            ("kPeriod".to_string(), 3.0),
            ("dPeriod".to_string(), 3.0),
        ]);
        for output in ["k", "d", "j"] {
            let values = evaluate("kdj", output, &parameters, &columns()).unwrap();
            assert_eq!(values.len(), 80);
            assert!(values.iter().flatten().last().is_some());
        }
        let adx = evaluate(
            "adx",
            "adx",
            &BTreeMap::from([("period".to_string(), 14.0)]),
            &columns(),
        )
        .unwrap();
        assert!(adx.iter().flatten().last().is_some());
    }

    #[test]
    fn every_builtin_output_is_evaluable_with_default_parameters() {
        let definitions: &[(&str, &[&str])] = &[
            ("ma", &["ma"]),
            ("ema", &["ema"]),
            ("vwap", &["vwap"]),
            ("boll", &["middle", "upper", "lower"]),
            ("donchian", &["upper", "middle", "lower"]),
            ("keltner", &["middle", "upper", "lower"]),
            ("psar", &["psar"]),
            ("supertrend", &["supertrend"]),
            ("ichimoku", &["conversion", "base", "spanA", "spanB"]),
            ("rsi", &["rsi"]),
            ("macd", &["macd", "signal", "histogram"]),
            ("kdj", &["k", "d", "j"]),
            ("atr", &["atr"]),
            ("adx", &["adx", "plusDi", "minusDi"]),
            ("stochastic", &["k", "d"]),
            ("cci", &["cci"]),
            ("roc", &["roc"]),
            ("aroon", &["up", "down"]),
            ("trix", &["trix", "signal"]),
            ("williams-r", &["williamsR"]),
            ("mfi", &["mfi"]),
            ("cmf", &["cmf"]),
            ("obv", &["obv"]),
            ("volume-ma", &["volume", "ma"]),
        ];
        let columns = columns();
        for (definition, outputs) in definitions {
            for output in *outputs {
                let values = evaluate(definition, output, &BTreeMap::new(), &columns)
                    .unwrap_or_else(|error| panic!("{definition}.{output}: {error}"));
                assert_eq!(values.len(), columns.len(), "{definition}.{output}");
                assert!(
                    values.iter().flatten().last().is_some(),
                    "{definition}.{output}"
                );
            }
        }
    }
}
