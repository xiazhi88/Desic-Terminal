use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::SystematicError;

/// The only execution-resolution supported by the first systematic backtest
/// engine. Higher-resolution data must use a dedicated model rather than be
/// silently treated as minute bars.
pub const ONE_MINUTE_MS: i64 = 60_000;

/// Timeframes made available to managed Python strategies.  All higher
/// timeframes are derived from the same confirmed one-minute source so a
/// historical run and a future live adapter share the exact same boundary
/// semantics.
pub const STRATEGY_TIMEFRAMES: &[(&str, i64)] = &[
    ("1m", ONE_MINUTE_MS),
    ("3m", 3 * ONE_MINUTE_MS),
    ("5m", 5 * ONE_MINUTE_MS),
    ("15m", 15 * ONE_MINUTE_MS),
    ("30m", 30 * ONE_MINUTE_MS),
    ("1H", 60 * ONE_MINUTE_MS),
    ("2H", 2 * 60 * ONE_MINUTE_MS),
    ("4H", 4 * 60 * ONE_MINUTE_MS),
    ("6H", 6 * 60 * ONE_MINUTE_MS),
    ("12H", 12 * 60 * ONE_MINUTE_MS),
    ("1D", 24 * 60 * ONE_MINUTE_MS),
];

/// A fully closed OHLCV bar. Timestamps are Unix milliseconds and represent
/// the half-open interval `[open_time_ms, close_time_ms)`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedBar {
    pub open_time_ms: i64,
    pub close_time_ms: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

impl ClosedBar {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        open_time_ms: i64,
        close_time_ms: i64,
        open: f64,
        high: f64,
        low: f64,
        close: f64,
        volume: f64,
    ) -> Result<Self, SystematicError> {
        let bar = Self {
            open_time_ms,
            close_time_ms,
            open,
            high,
            low,
            close,
            volume,
        };
        bar.validate()?;
        Ok(bar)
    }

    pub fn validate(&self) -> Result<(), SystematicError> {
        if self.open_time_ms < 0 {
            return Err(SystematicError::invalid_argument(
                "openTimeMs",
                "must be non-negative",
            ));
        }
        if self.close_time_ms <= self.open_time_ms {
            return Err(SystematicError::invalid_argument(
                "closeTimeMs",
                "must be after openTimeMs",
            ));
        }
        for (field, value) in [
            ("open", self.open),
            ("high", self.high),
            ("low", self.low),
            ("close", self.close),
        ] {
            if !value.is_finite() || value <= 0.0 {
                return Err(SystematicError::invalid_argument(
                    field,
                    "must be finite and greater than zero",
                ));
            }
        }
        if !self.volume.is_finite() || self.volume < 0.0 {
            return Err(SystematicError::invalid_argument(
                "volume",
                "must be finite and non-negative",
            ));
        }
        if self.high < self.open.max(self.close) {
            return Err(SystematicError::data_contract(
                "high is lower than open or close",
            ));
        }
        if self.low > self.open.min(self.close) {
            return Err(SystematicError::data_contract(
                "low is higher than open or close",
            ));
        }
        if self.low > self.high {
            return Err(SystematicError::data_contract("low is higher than high"));
        }
        Ok(())
    }

    pub fn duration_ms(&self) -> i64 {
        self.close_time_ms - self.open_time_ms
    }
}

/// A point-in-time aggregate used by the managed Python protocol.  Unlike
/// [`ClosedBar`], the newest row may describe an in-progress higher-timeframe
/// bucket: it is explicitly marked `confirmed = false` and its nominal close
/// boundary may be later than the current one-minute event cutoff.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketBar {
    pub open_time_ms: i64,
    pub close_time_ms: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
    pub confirmed: bool,
}

/// Incrementally aggregates a contiguous one-minute feed into one timeframe.
/// The oldest partial bucket is intentionally discarded when the supplied
/// history starts mid-bucket: presenting it as a completed historical candle
/// would manufacture data which was never present in the local snapshot.
#[derive(Debug, Clone)]
pub struct TimeframeAggregator {
    interval_ms: i64,
    maximum_bars: usize,
    completed: VecDeque<MarketBar>,
    current: Option<MarketBar>,
    started: bool,
}

impl TimeframeAggregator {
    pub fn new(interval_ms: i64, maximum_bars: usize) -> Result<Self, SystematicError> {
        if interval_ms < ONE_MINUTE_MS || interval_ms % ONE_MINUTE_MS != 0 {
            return Err(SystematicError::invalid_argument(
                "intervalMs",
                "must be a whole number of one-minute bars",
            ));
        }
        if maximum_bars == 0 {
            return Err(SystematicError::invalid_argument(
                "maximumBars",
                "must be greater than zero",
            ));
        }
        Ok(Self {
            interval_ms,
            maximum_bars,
            completed: VecDeque::new(),
            current: None,
            started: false,
        })
    }

    /// Incorporates one closed one-minute bar and returns the aggregate that
    /// changed.  Repeated input is rejected so callers cannot accidentally
    /// count a minute's volume twice.
    pub fn push(&mut self, bar: &ClosedBar) -> Result<Option<MarketBar>, SystematicError> {
        bar.validate()?;
        if bar.duration_ms() != ONE_MINUTE_MS {
            return Err(SystematicError::data_contract(
                "timeframe aggregation requires closed one-minute bars",
            ));
        }
        let bucket_open = bar.open_time_ms / self.interval_ms * self.interval_ms;
        let bucket_close = bucket_open.saturating_add(self.interval_ms);

        // A snapshot can begin in the middle of a larger bucket. Skip only
        // that incomplete prefix and begin at the next natural UTC boundary.
        if !self.started {
            if bar.open_time_ms != bucket_open {
                return Ok(None);
            }
            self.started = true;
        }

        match self.current.as_mut() {
            None => {
                let aggregate = MarketBar {
                    open_time_ms: bucket_open,
                    close_time_ms: bucket_close,
                    open: bar.open,
                    high: bar.high,
                    low: bar.low,
                    close: bar.close,
                    volume: bar.volume,
                    confirmed: bar.close_time_ms == bucket_close,
                };
                self.current = Some(aggregate.clone());
                Ok(Some(aggregate))
            }
            Some(current) if current.open_time_ms == bucket_open => {
                if bar.open_time_ms < current.open_time_ms
                    || bar.open_time_ms >= current.close_time_ms
                    || (current.confirmed && bar.open_time_ms < current.close_time_ms)
                {
                    return Err(SystematicError::data_contract(
                        "timeframe aggregation received duplicate or out-of-order input",
                    ));
                }
                current.high = current.high.max(bar.high);
                current.low = current.low.min(bar.low);
                current.close = bar.close;
                current.volume += bar.volume;
                current.confirmed = bar.close_time_ms == current.close_time_ms;
                Ok(Some(current.clone()))
            }
            Some(current) if bucket_open > current.open_time_ms => {
                if !current.confirmed || bar.open_time_ms != current.close_time_ms {
                    return Err(SystematicError::data_contract(
                        "timeframe aggregation detected a missing one-minute bar",
                    ));
                }
                let finished = self.current.take().expect("current aggregate exists");
                self.completed.push_back(finished);
                while self.completed.len() >= self.maximum_bars {
                    self.completed.pop_front();
                }
                let aggregate = MarketBar {
                    open_time_ms: bucket_open,
                    close_time_ms: bucket_close,
                    open: bar.open,
                    high: bar.high,
                    low: bar.low,
                    close: bar.close,
                    volume: bar.volume,
                    confirmed: bar.close_time_ms == bucket_close,
                };
                self.current = Some(aggregate.clone());
                Ok(Some(aggregate))
            }
            Some(_) => Err(SystematicError::data_contract(
                "timeframe aggregation received an out-of-order one-minute bar",
            )),
        }
    }

    pub fn snapshot(&self) -> Vec<MarketBar> {
        let mut values = self.completed.iter().cloned().collect::<Vec<_>>();
        if let Some(current) = &self.current {
            values.push(current.clone());
        }
        values
    }

    pub fn latest(&self) -> Option<&MarketBar> {
        self.current.as_ref()
    }
}

/// Serializable current-time input for a managed runner. It intentionally
/// contains a copy of only the bars visible at `as_of_ms`; callers cannot
/// request or infer a future slice from this payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentDataSnapshot {
    pub inst_id: String,
    pub as_of_ms: i64,
    pub interval_ms: i64,
    pub bars: Vec<ClosedBar>,
    #[serde(default)]
    pub features: BTreeMap<String, f64>,
}

/// An immutable, current-time-only market-data view passed to strategy code.
///
/// The backing time series can contain later historical bars for efficient
/// backtests, but its private visibility boundary guarantees `bars()` exposes
/// only `0..=current_bar`. This is the no-lookahead contract used by both
/// in-process rules and the Python IPC adapter.
#[derive(Debug, Clone)]
pub struct MarketDataWindow {
    inst_id: String,
    as_of_ms: i64,
    interval_ms: i64,
    bars: Arc<[ClosedBar]>,
    visible_len: usize,
    features: BTreeMap<String, f64>,
}

impl MarketDataWindow {
    /// Creates a standalone window. Every supplied bar must already have
    /// closed at or before the provided cutoff.
    pub fn from_closed_bars(
        inst_id: impl Into<String>,
        as_of_ms: i64,
        interval_ms: i64,
        bars: Vec<ClosedBar>,
        features: BTreeMap<String, f64>,
    ) -> Result<Self, SystematicError> {
        let inst_id = normalize_inst_id(inst_id.into())?;
        validate_interval(interval_ms)?;
        if bars.is_empty() {
            return Err(SystematicError::data_contract(
                "a strategy data window requires at least one closed bar",
            ));
        }
        validate_features(&features)?;
        validate_visible_bars(&bars, bars.len(), as_of_ms, interval_ms, false)?;
        Ok(Self {
            inst_id,
            as_of_ms,
            interval_ms,
            visible_len: bars.len(),
            bars: Arc::from(bars),
            features,
        })
    }

    pub(crate) fn for_backtest(
        inst_id: &str,
        as_of_ms: i64,
        interval_ms: i64,
        bars: Arc<[ClosedBar]>,
        visible_len: usize,
    ) -> Result<Self, SystematicError> {
        let inst_id = normalize_inst_id(inst_id.to_string())?;
        validate_interval(interval_ms)?;
        // BacktestRequest validates the complete sequence once before its
        // event loop starts. Re-scanning `0..visible_len` here would turn a
        // long run into O(n^2) work, so an event only verifies the moving
        // cursor and the current cutoff in O(1).
        if visible_len == 0 || visible_len > bars.len() {
            return Err(SystematicError::data_contract(
                "visible bar count must be between one and the available bar count",
            ));
        }
        if bars[visible_len - 1].close_time_ms > as_of_ms {
            return Err(SystematicError::data_contract(format!(
                "bar ending at {} is after current cutoff {}",
                bars[visible_len - 1].close_time_ms,
                as_of_ms
            )));
        }
        Ok(Self {
            inst_id,
            as_of_ms,
            interval_ms,
            bars,
            visible_len,
            features: BTreeMap::new(),
        })
    }

    pub fn inst_id(&self) -> &str {
        &self.inst_id
    }

    pub fn as_of_ms(&self) -> i64 {
        self.as_of_ms
    }

    pub fn interval_ms(&self) -> i64 {
        self.interval_ms
    }

    pub fn bars(&self) -> &[ClosedBar] {
        &self.bars[..self.visible_len]
    }

    pub fn latest_bar(&self) -> &ClosedBar {
        // Constructors reject an empty visible window.
        &self.bars[self.visible_len - 1]
    }

    pub fn len(&self) -> usize {
        self.visible_len
    }

    pub fn is_empty(&self) -> bool {
        false
    }

    pub fn feature(&self, key: &str) -> Option<f64> {
        self.features.get(key).copied()
    }

    pub fn features(&self) -> &BTreeMap<String, f64> {
        &self.features
    }

    pub fn snapshot(&self) -> CurrentDataSnapshot {
        CurrentDataSnapshot {
            inst_id: self.inst_id.clone(),
            as_of_ms: self.as_of_ms,
            interval_ms: self.interval_ms,
            bars: self.bars().to_vec(),
            features: self.features.clone(),
        }
    }
}

fn normalize_inst_id(value: String) -> Result<String, SystematicError> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(SystematicError::invalid_argument(
            "instId",
            "must not be empty",
        ));
    }
    if value.len() > 96 {
        return Err(SystematicError::invalid_argument(
            "instId",
            "must be at most 96 bytes",
        ));
    }
    Ok(value)
}

fn validate_interval(interval_ms: i64) -> Result<(), SystematicError> {
    if interval_ms <= 0 {
        return Err(SystematicError::invalid_argument(
            "intervalMs",
            "must be greater than zero",
        ));
    }
    Ok(())
}

fn validate_features(features: &BTreeMap<String, f64>) -> Result<(), SystematicError> {
    for (key, value) in features {
        if key.trim().is_empty() {
            return Err(SystematicError::invalid_argument(
                "features",
                "feature keys must not be empty",
            ));
        }
        if !value.is_finite() {
            return Err(SystematicError::invalid_argument(
                "features",
                "feature values must be finite",
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_visible_bars(
    bars: &[ClosedBar],
    visible_len: usize,
    as_of_ms: i64,
    interval_ms: i64,
    require_continuity: bool,
) -> Result<(), SystematicError> {
    if visible_len == 0 || visible_len > bars.len() {
        return Err(SystematicError::data_contract(
            "visible bar count must be between one and the available bar count",
        ));
    }
    let visible = &bars[..visible_len];
    let mut previous: Option<&ClosedBar> = None;
    for bar in visible {
        bar.validate()?;
        if bar.close_time_ms > as_of_ms {
            return Err(SystematicError::data_contract(format!(
                "bar ending at {} is after current cutoff {}",
                bar.close_time_ms, as_of_ms
            )));
        }
        if bar.duration_ms() != interval_ms {
            return Err(SystematicError::data_contract(format!(
                "bar duration {} does not match interval {}",
                bar.duration_ms(),
                interval_ms
            )));
        }
        if let Some(previous) = previous {
            if bar.open_time_ms <= previous.open_time_ms {
                return Err(SystematicError::data_contract(
                    "bars must be strictly ordered by opening timestamp",
                ));
            }
            if require_continuity && bar.open_time_ms != previous.close_time_ms {
                return Err(SystematicError::data_contract(format!(
                    "missing or overlapping bar between {} and {}",
                    previous.close_time_ms, bar.open_time_ms
                )));
            }
        }
        previous = Some(bar);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bar(open_time_ms: i64, open: f64, high: f64, low: f64, close: f64) -> ClosedBar {
        ClosedBar::new(
            open_time_ms,
            open_time_ms + ONE_MINUTE_MS,
            open,
            high,
            low,
            close,
            10.0,
        )
        .unwrap()
    }

    #[test]
    fn rejects_lookahead_bars_in_a_standalone_window() {
        let bars = vec![bar(0, 100.0, 102.0, 99.0, 101.0)];
        let error = MarketDataWindow::from_closed_bars(
            "BTC-USDT-SWAP",
            59_999,
            ONE_MINUTE_MS,
            bars,
            BTreeMap::new(),
        )
        .unwrap_err();

        assert!(matches!(
            error,
            SystematicError::DataContractViolation { .. }
        ));
    }

    #[test]
    fn snapshot_contains_only_currently_visible_bars() {
        let all: Arc<[ClosedBar]> = Arc::from(vec![
            bar(0, 100.0, 102.0, 99.0, 101.0),
            bar(ONE_MINUTE_MS, 101.0, 103.0, 100.0, 102.0),
        ]);
        let context =
            MarketDataWindow::for_backtest("BTC-USDT-SWAP", ONE_MINUTE_MS, ONE_MINUTE_MS, all, 1)
                .unwrap();

        assert_eq!(context.bars().len(), 1);
        assert_eq!(context.snapshot().bars.len(), 1);
        assert_eq!(context.latest_bar().close, 101.0);
    }

    #[test]
    fn aggregates_partial_higher_timeframe_bars_without_future_minutes() {
        let mut aggregator = TimeframeAggregator::new(5 * ONE_MINUTE_MS, 3).unwrap();
        for (index, values) in [
            (0, (100.0, 102.0, 99.0, 101.0)),
            (1, (101.0, 105.0, 100.0, 104.0)),
            (2, (104.0, 106.0, 103.0, 105.0)),
        ] {
            aggregator
                .push(&bar(
                    index * ONE_MINUTE_MS,
                    values.0,
                    values.1,
                    values.2,
                    values.3,
                ))
                .unwrap();
        }

        let partial = aggregator.snapshot();
        assert_eq!(partial.len(), 1);
        assert_eq!(partial[0].open_time_ms, 0);
        assert_eq!(partial[0].close_time_ms, 5 * ONE_MINUTE_MS);
        assert!(!partial[0].confirmed);
        assert_eq!(partial[0].open, 100.0);
        assert_eq!(partial[0].high, 106.0);
        assert_eq!(partial[0].low, 99.0);
        assert_eq!(partial[0].close, 105.0);
        assert_eq!(partial[0].volume, 30.0);

        for (index, values) in [
            (3, (105.0, 107.0, 104.0, 106.0)),
            (4, (106.0, 108.0, 105.0, 107.0)),
        ] {
            aggregator
                .push(&bar(
                    index * ONE_MINUTE_MS,
                    values.0,
                    values.1,
                    values.2,
                    values.3,
                ))
                .unwrap();
        }

        let completed = aggregator.snapshot();
        assert_eq!(completed.len(), 1);
        assert!(completed[0].confirmed);
        assert_eq!(completed[0].close, 107.0);
        assert_eq!(completed[0].volume, 50.0);
    }

    #[test]
    fn waits_for_a_natural_boundary_when_history_starts_mid_bucket() {
        let mut aggregator = TimeframeAggregator::new(5 * ONE_MINUTE_MS, 3).unwrap();
        for index in 1..=4 {
            assert!(aggregator
                .push(&bar(index * ONE_MINUTE_MS, 100.0, 101.0, 99.0, 100.0,))
                .unwrap()
                .is_none());
        }
        let first_safe_bar = aggregator
            .push(&bar(5 * ONE_MINUTE_MS, 101.0, 103.0, 100.0, 102.0))
            .unwrap()
            .unwrap();

        assert_eq!(first_safe_bar.open_time_ms, 5 * ONE_MINUTE_MS);
        assert!(!first_safe_bar.confirmed);
        assert_eq!(aggregator.snapshot(), vec![first_safe_bar]);
    }
}
