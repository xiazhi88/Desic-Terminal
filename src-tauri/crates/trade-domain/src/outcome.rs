//! 影子记账：按 1 分钟 K 线结算一个「假设交易」——包括 AI 考虑过但没有执行的候选。
//!
//! 规则与系统化回测的保护单出场一致，并且一律取保守口径：
//! - 限价单要在有效期内触及入场价才算成交；市价单按决策时的价格成交。
//! - 同一根 K 线同时碰到止损和目标，按止损算；跳空越过止损，按开盘价成交。
//! - 成交那根 K 线里只认止损、不认目标（看不出先后顺序时不给自己记好结果）。
//! - 持仓超过最长时间，按到期那一刻的价格（到期后第一根 K 线的开盘价）结算。
//! 结果用 R（止损距离）表示，并扣除往返手续费（换算成 R）。

/// 一根 K 线（时间为开盘时刻，毫秒）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OhlcBar {
    pub t: i64,
    pub o: f64,
    pub h: f64,
    pub l: f64,
    pub c: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShadowEntry {
    Market,
    Limit,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShadowPlan {
    pub long: bool,
    pub entry_type: ShadowEntry,
    pub entry: f64,
    pub stop: f64,
    pub target: f64,
    /// 决策时刻（毫秒）：只看这之后开盘的 K 线。
    pub decided_at: i64,
    /// 限价单的有效期截止（毫秒）。
    pub valid_until: i64,
    /// 成交后最长持有时间（毫秒），到时按收盘价结算。
    pub max_hold_ms: i64,
    /// 往返手续费占名义价值的百分比（例如 0.1 = 0.1%）。
    pub round_trip_fee_pct: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShadowExit {
    Stop,
    Target,
    Timeout,
}

impl ShadowExit {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stop => "stop",
            Self::Target => "target",
            Self::Timeout => "timeout",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ShadowOutcome {
    /// K 线还不够，过一会儿再结算。
    Pending,
    /// 价位关系不成立（例如做多时止损不在入场价下方）。
    Invalid(&'static str),
    /// 限价单在有效期内没有成交。
    Unfilled,
    Closed {
        filled_at: i64,
        exit_at: i64,
        exit: ShadowExit,
        /// 扣费后的 R。
        r: f64,
        mfe_r: f64,
        mae_r: f64,
    },
}

const MINUTE_MS: i64 = 60_000;

/// 结算一个假设交易。`bars` 按时间升序；`now` 用来判断「还没到结算时间」与「已经到期」。
pub fn resolve_shadow(plan: &ShadowPlan, bars: &[OhlcBar], now: i64) -> ShadowOutcome {
    let values = [plan.entry, plan.stop, plan.target];
    if values.iter().any(|value| !value.is_finite() || *value <= 0.0) {
        return ShadowOutcome::Invalid("价位缺失或无效");
    }
    let geometry_ok = if plan.long {
        plan.stop < plan.entry && plan.entry < plan.target
    } else {
        plan.target < plan.entry && plan.entry < plan.stop
    };
    if !geometry_ok {
        return ShadowOutcome::Invalid("止损 / 入场 / 目标的方向关系不成立");
    }
    let risk = (plan.entry - plan.stop).abs();
    let fee_r = plan.round_trip_fee_pct.max(0.0) / 100.0 * plan.entry / risk;
    let sign = if plan.long { 1.0 } else { -1.0 };
    let later = bars.iter().filter(|bar| bar.t >= plan.decided_at - plan.decided_at.rem_euclid(MINUTE_MS));

    // 1) 成交
    let mut iter = later.peekable();
    let (fill_index_bar, filled_at) = match plan.entry_type {
        ShadowEntry::Market => match iter.next() {
            Some(bar) => (*bar, bar.t),
            None => return ShadowOutcome::Pending,
        },
        ShadowEntry::Limit => {
            let mut found = None;
            let mut covered_until = i64::MIN;
            for bar in iter.by_ref() {
                covered_until = bar.t + MINUTE_MS;
                if bar.t > plan.valid_until {
                    break;
                }
                let touched = if plan.long { bar.l <= plan.entry } else { bar.h >= plan.entry };
                if touched {
                    found = Some(*bar);
                    break;
                }
            }
            match found {
                Some(bar) => (bar, bar.t),
                None => {
                    // 有效期已过、且 K 线覆盖到了有效期末尾 → 确定没成交；否则还在等。
                    return if now > plan.valid_until && covered_until >= plan.valid_until {
                        ShadowOutcome::Unfilled
                    } else {
                        ShadowOutcome::Pending
                    };
                }
            }
        }
    };

    let favorable = |bar: &OhlcBar| if plan.long { bar.h - plan.entry } else { plan.entry - bar.l };
    let adverse = |bar: &OhlcBar| if plan.long { plan.entry - bar.l } else { bar.h - plan.entry };
    let stop_hit = |bar: &OhlcBar| if plan.long { bar.l <= plan.stop } else { bar.h >= plan.stop };
    let target_hit = |bar: &OhlcBar| if plan.long { bar.h >= plan.target } else { bar.l <= plan.target };
    let close = |exit_price: f64, exit_at: i64, exit: ShadowExit, mfe: f64, mae: f64| ShadowOutcome::Closed {
        filled_at,
        exit_at,
        exit,
        r: sign * (exit_price - plan.entry) / risk - fee_r,
        mfe_r: mfe.max(0.0) / risk,
        mae_r: mae.max(0.0) / risk,
    };

    // 2) 成交那根：只认止损（先后顺序未知时不认目标）。
    let mut mfe: f64 = 0.0;
    let mut mae = adverse(&fill_index_bar).max(0.0);
    if stop_hit(&fill_index_bar) {
        return close(plan.stop, fill_index_bar.t, ShadowExit::Stop, 0.0, mae);
    }
    if plan.entry_type == ShadowEntry::Market {
        mfe = favorable(&fill_index_bar).max(0.0);
    }

    // 3) 之后的每一根
    let deadline = filled_at + plan.max_hold_ms;
    let mut last_bar = fill_index_bar;
    for bar in iter {
        if bar.t <= fill_index_bar.t {
            continue;
        }
        last_bar = *bar;
        if bar.t >= deadline {
            return close(bar.o, bar.t, ShadowExit::Timeout, mfe, mae);
        }
        mfe = mfe.max(favorable(bar));
        mae = mae.max(adverse(bar));
        if stop_hit(bar) {
            let gapped = if plan.long { bar.o <= plan.stop } else { bar.o >= plan.stop };
            return close(if gapped { bar.o } else { plan.stop }, bar.t, ShadowExit::Stop, mfe, mae);
        }
        if target_hit(bar) {
            return close(plan.target, bar.t, ShadowExit::Target, mfe, mae);
        }
    }
    // K 线到头了：持有期已满就按最后一根收盘结算，否则继续等。
    if now >= deadline && last_bar.t + MINUTE_MS >= deadline {
        return close(last_bar.c, last_bar.t, ShadowExit::Timeout, mfe, mae);
    }
    ShadowOutcome::Pending
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_791_200_000_000;

    fn bar(minute: i64, o: f64, h: f64, l: f64, c: f64) -> OhlcBar {
        OhlcBar { t: T0 + minute * MINUTE_MS, o, h, l, c }
    }

    fn plan(long: bool, entry_type: ShadowEntry) -> ShadowPlan {
        ShadowPlan {
            long,
            entry_type,
            entry: 100.0,
            stop: if long { 98.0 } else { 102.0 },
            target: if long { 104.0 } else { 96.0 },
            decided_at: T0,
            valid_until: T0 + 10 * MINUTE_MS,
            max_hold_ms: 60 * MINUTE_MS,
            round_trip_fee_pct: 0.0,
        }
    }

    fn closed(outcome: ShadowOutcome) -> (ShadowExit, f64) {
        match outcome {
            ShadowOutcome::Closed { exit, r, .. } => (exit, r),
            other => panic!("expected closed, got {other:?}"),
        }
    }

    #[test]
    fn limit_fills_then_reaches_target() {
        let bars = [bar(0, 101.0, 101.5, 100.5, 101.0), bar(1, 101.0, 101.0, 99.8, 100.2), bar(2, 100.2, 104.5, 100.0, 104.0)];
        let (exit, r) = closed(resolve_shadow(&plan(true, ShadowEntry::Limit), &bars, T0 + 5 * MINUTE_MS));
        assert_eq!(exit, ShadowExit::Target);
        assert!((r - 2.0).abs() < 1e-9);
    }

    #[test]
    fn stop_wins_when_one_bar_touches_both() {
        let bars = [bar(0, 100.0, 100.2, 99.9, 100.0), bar(1, 100.0, 104.5, 97.5, 101.0)];
        let (exit, r) = closed(resolve_shadow(&plan(true, ShadowEntry::Market), &bars, T0 + 5 * MINUTE_MS));
        assert_eq!(exit, ShadowExit::Stop);
        assert!((r + 1.0).abs() < 1e-9);
    }

    #[test]
    fn gap_through_stop_fills_at_open() {
        let bars = [bar(0, 100.0, 100.5, 99.5, 100.0), bar(1, 97.0, 97.5, 96.5, 97.0)];
        let (exit, r) = closed(resolve_shadow(&plan(true, ShadowEntry::Market), &bars, T0 + 5 * MINUTE_MS));
        assert_eq!(exit, ShadowExit::Stop);
        assert!((r + 1.5).abs() < 1e-9, "{r}");
    }

    #[test]
    fn fill_bar_counts_the_stop_but_not_the_target() {
        // 成交那根同时到过 97.5（止损）和 104.5（目标）：按止损算。
        let bars = [bar(0, 101.0, 104.5, 97.5, 101.0)];
        let (exit, _) = closed(resolve_shadow(&plan(true, ShadowEntry::Limit), &bars, T0 + 5 * MINUTE_MS));
        assert_eq!(exit, ShadowExit::Stop);
    }

    #[test]
    fn unfilled_limit_only_after_expiry_with_coverage() {
        let bars = (0..12).map(|minute| bar(minute, 101.0, 101.5, 100.5, 101.0)).collect::<Vec<_>>();
        let order = plan(true, ShadowEntry::Limit);
        assert_eq!(resolve_shadow(&order, &bars[..5], T0 + 5 * MINUTE_MS), ShadowOutcome::Pending);
        assert_eq!(resolve_shadow(&order, &bars, T0 + 12 * MINUTE_MS), ShadowOutcome::Unfilled);
    }

    #[test]
    fn timeout_settles_at_market_and_short_side_signs_flip() {
        let mut short = plan(false, ShadowEntry::Market);
        short.max_hold_ms = 3 * MINUTE_MS;
        let bars = [bar(0, 100.0, 100.5, 99.5, 100.0), bar(1, 100.0, 100.5, 99.0, 99.0), bar(2, 99.0, 99.5, 98.5, 99.0), bar(3, 99.0, 99.2, 98.8, 99.0)];
        let (exit, r) = closed(resolve_shadow(&short, &bars, T0 + 10 * MINUTE_MS));
        assert_eq!(exit, ShadowExit::Timeout);
        assert!((r - 0.5).abs() < 1e-9, "{r}");
    }

    #[test]
    fn fees_reduce_r_and_bad_geometry_is_invalid() {
        let mut with_fee = plan(true, ShadowEntry::Market);
        with_fee.round_trip_fee_pct = 0.1; // 0.1% × 100 / 2 = 0.05R
        let bars = [bar(0, 100.0, 100.2, 99.9, 100.0), bar(1, 100.0, 104.5, 100.0, 104.0)];
        let (_, r) = closed(resolve_shadow(&with_fee, &bars, T0 + 5 * MINUTE_MS));
        assert!((r - 1.95).abs() < 1e-9, "{r}");
        let mut wrong = plan(true, ShadowEntry::Market);
        wrong.stop = 101.0;
        assert!(matches!(resolve_shadow(&wrong, &bars, T0), ShadowOutcome::Invalid(_)));
    }
}
