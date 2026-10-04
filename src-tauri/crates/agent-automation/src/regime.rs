//! 交易员模式的「行情阶段」：由代码按固定口径计算，作为简报展示与成绩单分组的统一标签。
//! 标签不交给 AI 判断，否则同一种行情会被叫成不同名字，成绩单就无法分组。

/// 日线阶段：上升（收盘 > EMA20 > EMA50）/ 下降（收盘 < EMA20 < EMA50）/ 不明（其余）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DailyRegime {
    Up,
    Down,
    Mixed,
}

impl DailyRegime {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Up => "up",
            Self::Down => "down",
            Self::Mixed => "mixed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "up" => Some(Self::Up),
            "down" => Some(Self::Down),
            "mixed" => Some(Self::Mixed),
            _ => None,
        }
    }
}

/// 标准 EMA 的最后一个值（前 `period` 个用简单均值做种子）。样本不足返回 `None`。
pub fn ema_last(values: &[f64], period: usize) -> Option<f64> {
    if period == 0 || values.len() < period || values.iter().any(|value| !value.is_finite()) {
        return None;
    }
    let k = 2.0 / (period as f64 + 1.0);
    let mut ema = values[..period].iter().sum::<f64>() / period as f64;
    for value in &values[period..] {
        ema = value * k + ema * (1.0 - k);
    }
    ema.is_finite().then_some(ema)
}

/// 按日线收盘价（时间升序，最后一根可以是当日未收盘的）判断日线阶段；少于 50 根返回 `None`（不可用）。
pub fn daily_regime(closes: &[f64]) -> Option<DailyRegime> {
    let close = *closes.last()?;
    let ema20 = ema_last(closes, 20)?;
    let ema50 = ema_last(closes, 50)?;
    Some(if close > ema20 && ema20 > ema50 {
        DailyRegime::Up
    } else if close < ema20 && ema20 < ema50 {
        DailyRegime::Down
    } else {
        DailyRegime::Mixed
    })
}

/// 最后一根相对 `bars_back` 根之前的涨跌幅（%）。样本不足返回 `None`。
pub fn change_pct(closes: &[f64], bars_back: usize) -> Option<f64> {
    let last = *closes.last()?;
    let base = *closes.get(closes.len().checked_sub(bars_back + 1)?)?;
    (base > 0.0 && last.is_finite()).then(|| (last - base) / base * 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn series(start: f64, step: f64, n: usize) -> Vec<f64> {
        (0..n).map(|index| start + step * index as f64).collect()
    }

    #[test]
    fn rising_series_is_up_and_falling_series_is_down() {
        assert_eq!(daily_regime(&series(100.0, 1.0, 80)), Some(DailyRegime::Up));
        assert_eq!(daily_regime(&series(200.0, -1.0, 80)), Some(DailyRegime::Down));
    }

    #[test]
    fn pullback_inside_an_uptrend_is_mixed_not_down() {
        // 长期上涨后最后几根回落到 EMA20 下方：EMA20 仍在 EMA50 之上 → 不明，而不是下降。
        let mut closes = series(100.0, 1.0, 80);
        for _ in 0..6 {
            let last = *closes.last().unwrap();
            closes.push(last - 4.0);
        }
        assert_eq!(daily_regime(&closes), Some(DailyRegime::Mixed));
    }

    #[test]
    fn short_history_is_unavailable() {
        assert_eq!(daily_regime(&series(100.0, 1.0, 49)), None);
        assert_eq!(daily_regime(&[]), None);
        assert_eq!(ema_last(&[1.0, f64::NAN, 3.0], 2), None);
    }

    #[test]
    fn change_pct_uses_bars_back() {
        let closes = vec![100.0, 105.0, 110.0];
        assert_eq!(change_pct(&closes, 2), Some(10.0));
        assert_eq!(change_pct(&closes, 3), None);
        assert_eq!(DailyRegime::parse("mixed"), Some(DailyRegime::Mixed));
        assert_eq!(DailyRegime::Up.as_str(), "up");
    }
}
