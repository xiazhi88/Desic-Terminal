//! 交易员模式的「简报」：把代码算好的行情 / 账户 / 风险预算事实渲染成一页固定格式的纯文本，
//! 直接写进后台运行的提示词，替代模型自己反复调用读数据工具。
//!
//! 这里只做渲染（纯函数、无 IO）；取数与计算在主 crate 的 `ai_briefing.rs`。
//! 约定：拿不到的数据写「不可用」，**绝不写 0**（0 会被模型读成「完全没动 / 没有」）。

/// 一个周期的结构视图（来自 1m K 线聚合）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BriefingTimeframe {
    /// `15m` / `1h` / `4h`。
    pub label: String,
    /// `up` | `down` | `range` | `unknown`；`None` = 该周期不可用。
    pub trend: Option<String>,
    pub window_high: Option<f64>,
    pub window_low: Option<f64>,
    /// 0..=1：收盘价在窗口高低之间的位置。
    pub range_pos: Option<f64>,
    pub swing_high: Option<f64>,
    pub swing_low: Option<f64>,
}

/// 「按 1×ATR(1h) 止损」的仓位参考。
#[derive(Debug, Clone, PartialEq)]
pub enum BriefingSizing {
    /// 风险预算内最多可开的张数（已按 lotSz 向下取整、≥ minSz）。
    MaxContracts { stop_distance: f64, contracts: f64 },
    /// 最小张数的止损风险已经超过单笔风险预算。
    AccountTooSmall { stop_distance: f64 },
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct BriefingSymbol {
    pub inst_id: String,
    pub last: Option<f64>,
    pub chg_5m_pct: Option<f64>,
    pub chg_1h_pct: Option<f64>,
    pub chg_24h_pct: Option<f64>,
    pub high_24h: Option<f64>,
    pub low_24h: Option<f64>,
    /// 日线阶段（`up` / `down` / `mixed`），由代码按 `regime::daily_regime` 计算；`None` = 不可用。
    pub regime_daily: Option<String>,
    pub chg_7d_pct: Option<f64>,
    pub chg_30d_pct: Option<f64>,
    pub timeframes: Vec<BriefingTimeframe>,
    pub atr_5m: Option<f64>,
    pub atr_1h: Option<f64>,
    pub atr_4h: Option<f64>,
    /// `trend` | `range` | `volatile` | `unknown`。
    pub regime: Option<String>,
    pub rsi_1h: Option<f64>,
    pub rsi_4h: Option<f64>,
    pub ema20_1h: Option<f64>,
    pub ema50_1h: Option<f64>,
    pub ema20_4h: Option<f64>,
    pub ema50_4h: Option<f64>,
    /// 1h MACD 柱（最新一根与前一根，用来看动能在放大还是收缩）。
    pub macd_hist_1h: Option<f64>,
    pub macd_hist_1h_prev: Option<f64>,
    /// 1h 布林带（20, 2）里的位置：0 = 下轨，1 = 上轨，可能超出 0..=1。
    pub boll_pos_1h: Option<f64>,
    pub spread_bps: Option<f64>,
    /// -1..=1，正数 = 买盘一档更厚。
    pub book_imbalance: Option<f64>,
    pub depth_5bps_usd: Option<f64>,
    /// 资金费率（小数，0.0001 = 0.01%）。
    pub funding_rate: Option<f64>,
    pub funding_next_label: Option<String>,
    pub oi_change_1h_pct: Option<f64>,
    pub oi_change_24h_pct: Option<f64>,
    /// 近 1 小时主动买入占比（0..=1）。
    pub taker_buy_ratio_1h: Option<f64>,
    /// 近 1 小时爆仓笔数（多头被强平, 空头被强平）。
    pub liquidations_1h: Option<(u32, u32)>,
    /// 已经格式化好的雷达一句话（没有快照时为 `None`）。
    pub radar_line: Option<String>,
    pub sizing: Option<BriefingSizing>,
    /// 合约面值文本（例如 `0.01 BTC`）与最小张数。
    pub contract_label: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct BriefingPosition {
    pub inst_id: String,
    /// `true` = 多头。
    pub long: bool,
    pub contracts: f64,
    pub entry_px: Option<f64>,
    pub mark_px: Option<f64>,
    pub upl_usdt: Option<f64>,
    pub stop_px: Option<f64>,
    pub take_profit_px: Option<f64>,
    pub liq_px: Option<f64>,
    /// 归属（本 Profile / 其他 Profile / 非 AI 自动化），已本地化；同一账户被多个 Profile 共用时用来分清是谁的。
    pub owner: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct BriefingOrder {
    pub inst_id: String,
    /// 已本地化的简短描述，例如「限价 买」「止损 卖」。
    pub kind_label: String,
    pub px: Option<f64>,
    pub contracts: Option<f64>,
    pub reduce_only: bool,
    /// 归属，同 `BriefingPosition::owner`；附挂的保护单通常没有。
    pub owner: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct BriefingAccount {
    pub equity_usdt: Option<f64>,
    pub available_usdt: Option<f64>,
    pub snapshot_age_seconds: Option<i64>,
    pub positions: Vec<BriefingPosition>,
    pub open_orders: Vec<BriefingOrder>,
    /// 挂单超过上限被省略的条数。
    pub omitted_orders: usize,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct BriefingBudget {
    pub risk_per_trade_pct: f64,
    pub risk_per_trade_usdt: Option<f64>,
    pub min_reward_risk: f64,
    pub daily_loss_limit_pct: f64,
    pub today_realized_pnl: Option<f64>,
    /// 今天还能亏多少（U）；已触发熔断时为 0。
    pub remaining_daily_loss_usdt: Option<f64>,
    pub open_exposure: Option<u32>,
    pub max_open_positions: u32,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct BriefingOpportunity {
    pub id: String,
    /// 已本地化，例如「开多 BTC-USDT-SWAP」。
    pub title: String,
    pub entry: Option<f64>,
    pub stop: Option<f64>,
    pub take_profit: Option<f64>,
    pub status: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct BriefingNote {
    /// 已格式化的时间（例如 `21:00`）。
    pub at_label: String,
    pub text: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct BriefingDoc {
    pub generated_at_label: String,
    pub account: Option<BriefingAccount>,
    pub budget: Option<BriefingBudget>,
    pub symbols: Vec<BriefingSymbol>,
    pub opportunities: Vec<BriefingOpportunity>,
    pub recent_runs: Vec<BriefingNote>,
    pub wake_conditions: Vec<String>,
    pub events: Vec<BriefingNote>,
    /// 交易员成绩单（已渲染好的几行，见 `scorecard::render_scorecard_brief`）。
    pub scorecard: Option<String>,
}

/// 简报默认的字符上限（3 个品种的完整简报约 3–4 千字符，留出余量）。
pub const BRIEFING_MAX_CHARS: usize = 6_000;

struct Text {
    zh: bool,
}

impl Text {
    fn t<'a>(&self, zh: &'a str, en: &'a str) -> &'a str {
        if self.zh {
            zh
        } else {
            en
        }
    }

    fn na(&self) -> &'static str {
        if self.zh {
            "不可用"
        } else {
            "n/a"
        }
    }

    fn px(&self, value: Option<f64>) -> String {
        value.filter(|v| v.is_finite()).map(format_price).unwrap_or_else(|| self.na().to_string())
    }

    fn pct(&self, value: Option<f64>) -> String {
        value
            .filter(|v| v.is_finite())
            .map(|v| format!("{v:+.2}%"))
            .unwrap_or_else(|| self.na().to_string())
    }

    fn usdt(&self, value: Option<f64>) -> String {
        value
            .filter(|v| v.is_finite())
            .map(|v| format!("{v:.2} U"))
            .unwrap_or_else(|| self.na().to_string())
    }

    fn signed_usdt(&self, value: Option<f64>) -> String {
        value
            .filter(|v| v.is_finite())
            .map(|v| format!("{v:+.2} U"))
            .unwrap_or_else(|| self.na().to_string())
    }

    fn num(&self, value: Option<f64>, digits: usize) -> String {
        value
            .filter(|v| v.is_finite())
            .map(|v| format!("{v:.digits$}"))
            .unwrap_or_else(|| self.na().to_string())
    }

    fn trend(&self, trend: &str) -> &'static str {
        match (trend, self.zh) {
            ("up", true) => "上升",
            ("down", true) => "下降",
            ("range", true) => "震荡",
            ("up", false) => "up",
            ("down", false) => "down",
            ("range", false) => "range",
            (_, true) => "不明",
            (_, false) => "unclear",
        }
    }

    fn regime(&self, regime: &str) -> &'static str {
        match (regime, self.zh) {
            ("trend", true) => "趋势",
            ("range", true) => "震荡",
            ("volatile", true) => "剧烈波动",
            ("trend", false) => "trending",
            ("range", false) => "ranging",
            ("volatile", false) => "volatile",
            (_, true) => "不明",
            (_, false) => "unclear",
        }
    }
}

/// 价格按量级取小数位：≥1000 一位、≥10 两位、≥1 四位，其余六位（去掉多余的尾零）。
pub fn format_price(value: f64) -> String {
    let abs = value.abs();
    let text = if abs >= 1_000.0 {
        format!("{value:.1}")
    } else if abs >= 10.0 {
        format!("{value:.2}")
    } else if abs >= 1.0 {
        format!("{value:.4}")
    } else {
        format!("{value:.6}")
    };
    if text.contains('.') {
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        text
    }
}

fn compact_usd(value: f64) -> String {
    let abs = value.abs();
    if abs >= 1e9 {
        format!("${:.2}B", value / 1e9)
    } else if abs >= 1e6 {
        format!("${:.2}M", value / 1e6)
    } else if abs >= 1e3 {
        format!("${:.1}K", value / 1e3)
    } else {
        format!("${value:.0}")
    }
}

fn format_contracts(value: f64) -> String {
    let text = format!("{value:.4}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// 相对标记价的距离（%），用于止损 / 止盈 / 强平。
fn distance_pct(level: Option<f64>, mark: Option<f64>) -> Option<f64> {
    match (level, mark) {
        (Some(level), Some(mark)) if mark > 0.0 && level.is_finite() => Some((level - mark) / mark * 100.0),
        _ => None,
    }
}

/// 一个可被整体丢弃的段落；`priority` 越大越先被丢。
struct Section {
    priority: u8,
    name: &'static str,
    body: String,
}

fn render_account(doc: &BriefingDoc, tx: &Text) -> String {
    let mut out = String::new();
    out.push_str(tx.t("## 账户与风险预算\n", "## Account and risk budget\n"));
    match doc.account.as_ref() {
        Some(account) => {
            let age = account
                .snapshot_age_seconds
                .map(|s| if tx.zh { format!("，快照 {s} 秒前") } else { format!(", snapshot {s}s old") })
                .unwrap_or_default();
            out.push_str(&format!(
                "- {} {}，{} {}{}\n",
                tx.t("权益", "Equity"),
                tx.usdt(account.equity_usdt),
                tx.t("可用", "available"),
                tx.usdt(account.available_usdt),
                age
            ));
        }
        None => out.push_str(tx.t(
            "- 账户快照不可用（开仓会被风控拒绝，直到账户数据恢复）\n",
            "- Account snapshot unavailable (opens will be rejected by the risk gate until it recovers)\n",
        )),
    }
    if let Some(budget) = doc.budget.as_ref() {
        out.push_str(&format!(
            "- {} {}；{} {}（{} {}%）\n",
            tx.t("今日已实现", "Realized today"),
            tx.signed_usdt(budget.today_realized_pnl),
            tx.t("今天还能亏", "loss left today"),
            tx.usdt(budget.remaining_daily_loss_usdt),
            tx.t("日亏线", "daily limit"),
            budget.daily_loss_limit_pct
        ));
        let exposure = budget
            .open_exposure
            .map(|count| format!("{count}/{}", budget.max_open_positions))
            .unwrap_or_else(|| tx.na().to_string());
        out.push_str(&format!(
            "- {} {}（{}%）；{} {}；{} {}\n",
            tx.t("单笔风险预算", "Risk per trade"),
            tx.usdt(budget.risk_per_trade_usdt),
            budget.risk_per_trade_pct,
            tx.t("净盈亏比下限", "min net reward/risk"),
            budget.min_reward_risk,
            tx.t("本 Profile 敞口", "Profile exposure"),
            exposure
        ));
    }
    if let Some(account) = doc.account.as_ref() {
        if account.positions.is_empty() {
            out.push_str(tx.t("- 持仓：无\n", "- Positions: none\n"));
        }
        for position in &account.positions {
            let side = if position.long { tx.t("多", "long") } else { tx.t("空", "short") };
            let level = |label: &str, px: Option<f64>| -> String {
                match px {
                    Some(px) => match distance_pct(Some(px), position.mark_px) {
                        Some(distance) => format!("{label} {}（{distance:+.2}%）", format_price(px)),
                        None => format!("{label} {}", format_price(px)),
                    },
                    None => format!("{label} {}", tx.t("未挂", "none")),
                }
            };
            out.push_str(&format!(
                "- {}{} {} {} {} {} @ {}，{} {}，{} {}；{}；{}；{}\n",
                tx.t("持仓", "Position"),
                position.owner.as_deref().map(|owner| format!("（{owner}）")).unwrap_or_default(),
                position.inst_id,
                side,
                format_contracts(position.contracts),
                tx.t("张", "contracts"),
                tx.px(position.entry_px),
                tx.t("标记", "mark"),
                tx.px(position.mark_px),
                tx.t("浮盈亏", "uPnL"),
                tx.signed_usdt(position.upl_usdt),
                level(tx.t("止损", "stop"), position.stop_px),
                level(tx.t("止盈", "take profit"), position.take_profit_px),
                level(tx.t("强平", "liquidation"), position.liq_px),
            ));
        }
        for order in &account.open_orders {
            out.push_str(&format!(
                "- {}{} {} {} {} {} @ {}{}\n",
                tx.t("挂单", "Order"),
                order.owner.as_deref().map(|owner| format!("（{owner}）")).unwrap_or_default(),
                order.inst_id,
                order.kind_label,
                order.contracts.map(format_contracts).unwrap_or_else(|| tx.na().to_string()),
                tx.t("张", "contracts"),
                tx.px(order.px),
                if order.reduce_only { tx.t("（只减仓）", " (reduce-only)") } else { "" }
            ));
        }
        if account.omitted_orders > 0 {
            out.push_str(&if tx.zh {
                format!("- 另有 {} 条挂单未列出\n", account.omitted_orders)
            } else {
                format!("- {} more orders not listed\n", account.omitted_orders)
            });
        }
    }
    out
}

fn render_symbol_core(symbol: &BriefingSymbol, tx: &Text) -> String {
    let mut out = format!("## {}\n", symbol.inst_id);
    out.push_str(&format!(
        "- {} {}；5m {}，1h {}，24h {}（24h {} {} / {} {}）\n",
        tx.t("价格", "Price"),
        tx.px(symbol.last),
        tx.pct(symbol.chg_5m_pct),
        tx.pct(symbol.chg_1h_pct),
        tx.pct(symbol.chg_24h_pct),
        tx.t("高", "high"),
        tx.px(symbol.high_24h),
        tx.t("低", "low"),
        tx.px(symbol.low_24h),
    ));
    let daily = symbol.regime_daily.as_deref().map(|value| match (value, tx.zh) {
        ("up", true) => "上升（收盘 > EMA20 > EMA50）",
        ("down", true) => "下降（收盘 < EMA20 < EMA50）",
        ("mixed", true) => "不明",
        ("up", false) => "up (close > EMA20 > EMA50)",
        ("down", false) => "down (close < EMA20 < EMA50)",
        (_, true) => "不明",
        (_, false) => "mixed",
    });
    let four_hour = symbol
        .timeframes
        .iter()
        .find(|frame| frame.label == "4h")
        .and_then(|frame| frame.trend.as_deref())
        .map(|trend| tx.trend(trend));
    out.push_str(&format!(
        "- {}：{} {}，4h {}；7 {} {}，30 {} {}\n",
        tx.t("行情阶段", "Regime"),
        tx.t("日线", "daily"),
        daily.unwrap_or(tx.na()),
        four_hour.unwrap_or(tx.na()),
        tx.t("日", "d"),
        tx.pct(symbol.chg_7d_pct),
        tx.t("日", "d"),
        tx.pct(symbol.chg_30d_pct),
    ));
    let frames = symbol
        .timeframes
        .iter()
        .map(|frame| match frame.trend.as_deref() {
            Some(trend) => {
                let position = frame
                    .range_pos
                    .map(|pos| format!("{}{:.0}%", tx.t("位于 ", "at "), pos * 100.0))
                    .unwrap_or_else(|| tx.na().to_string());
                let swings = match (frame.swing_high, frame.swing_low) {
                    (Some(high), Some(low)) => format!(
                        "，{} {} / {} {}",
                        tx.t("摆动高", "swing high"),
                        format_price(high),
                        tx.t("低", "low"),
                        format_price(low)
                    ),
                    _ => String::new(),
                };
                format!(
                    "{} {}，{} {}–{}，{}{}",
                    frame.label,
                    tx.trend(trend),
                    tx.t("区间", "range"),
                    tx.px(frame.window_low),
                    tx.px(frame.window_high),
                    position,
                    swings
                )
            }
            None => format!("{} {}", frame.label, tx.na()),
        })
        .collect::<Vec<_>>();
    out.push_str(&format!("- {}：{}\n", tx.t("结构", "Structure"), frames.join("；")));
    out.push_str(&format!(
        "- {}：ATR 5m {} / 1h {} / 4h {}；{} {}；RSI 1h {}，4h {}\n",
        tx.t("波动", "Volatility"),
        tx.px(symbol.atr_5m),
        tx.px(symbol.atr_1h),
        tx.px(symbol.atr_4h),
        tx.t("状态", "regime"),
        symbol.regime.as_deref().map(|r| tx.regime(r)).unwrap_or(tx.na()),
        tx.num(symbol.rsi_1h, 1),
        tx.num(symbol.rsi_4h, 1),
    ));
    let macd = match (symbol.macd_hist_1h, symbol.macd_hist_1h_prev) {
        (Some(now), Some(prev)) if now.is_finite() && prev.is_finite() => {
            let trend = if now.abs() >= prev.abs() { tx.t("放大", "expanding") } else { tx.t("收缩", "contracting") };
            format!("{now:+.2}（{} {prev:+.2}，{trend}）", tx.t("前一根", "prev"))
        }
        (Some(now), _) if now.is_finite() => format!("{now:+.2}"),
        _ => tx.na().to_string(),
    };
    out.push_str(&format!(
        "- {}：1h EMA20 {} / EMA50 {}，MACD {} {}，{} {}；4h EMA20 {} / EMA50 {}\n",
        tx.t("指标", "Indicators"),
        tx.px(symbol.ema20_1h),
        tx.px(symbol.ema50_1h),
        tx.t("柱", "hist"),
        macd,
        tx.t("布林位置", "Bollinger %B"),
        symbol
            .boll_pos_1h
            .filter(|v| v.is_finite())
            .map(|v| format!("{:.0}%", v * 100.0))
            .unwrap_or_else(|| tx.na().to_string()),
        tx.px(symbol.ema20_4h),
        tx.px(symbol.ema50_4h),
    ));
    match symbol.sizing.as_ref() {
        Some(BriefingSizing::MaxContracts { stop_distance, contracts }) => out.push_str(&if tx.zh {
            format!(
                "- 仓位参考：按 1×ATR(1h) 止损（距离 {}），单笔风险预算内最多 {} 张{}\n",
                format_price(*stop_distance),
                format_contracts(*contracts),
                symbol.contract_label.as_deref().map(|label| format!("（{label}）")).unwrap_or_default()
            )
        } else {
            format!(
                "- Sizing hint: with a 1×ATR(1h) stop (distance {}), at most {} contracts fit the per-trade risk budget{}\n",
                format_price(*stop_distance),
                format_contracts(*contracts),
                symbol.contract_label.as_deref().map(|label| format!(" ({label})")).unwrap_or_default()
            )
        }),
        Some(BriefingSizing::AccountTooSmall { stop_distance }) => out.push_str(&if tx.zh {
            format!(
                "- 仓位参考：按 1×ATR(1h) 止损（距离 {}），最小张数的风险已超过单笔预算——这个止损距离下开不了仓\n",
                format_price(*stop_distance)
            )
        } else {
            format!(
                "- Sizing hint: with a 1×ATR(1h) stop (distance {}), even the minimum size exceeds the per-trade risk budget — no entry fits this stop distance\n",
                format_price(*stop_distance)
            )
        }),
        None => {}
    }
    out
}

fn render_symbol_extras(symbol: &BriefingSymbol, tx: &Text) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "- {}：{} {} bp，{} {}，±5bp {} {}\n",
        tx.t("盘口", "Book"),
        tx.t("点差", "spread"),
        tx.num(symbol.spread_bps, 2),
        tx.t("一档失衡", "top imbalance"),
        symbol
            .book_imbalance
            .filter(|v| v.is_finite())
            .map(|v| format!("{v:+.2}"))
            .unwrap_or_else(|| tx.na().to_string()),
        tx.t("深度", "depth"),
        symbol
            .depth_5bps_usd
            .filter(|v| v.is_finite())
            .map(compact_usd)
            .unwrap_or_else(|| tx.na().to_string()),
    ));
    let funding = symbol
        .funding_rate
        .filter(|v| v.is_finite())
        .map(|rate| {
            let next = symbol
                .funding_next_label
                .as_deref()
                .map(|label| format!("（{}{label}）", tx.t("下次 ", "next ")))
                .unwrap_or_default();
            format!("{:+.4}%{next}", rate * 100.0)
        })
        .unwrap_or_else(|| tx.na().to_string());
    let taker = symbol
        .taker_buy_ratio_1h
        .filter(|v| v.is_finite())
        .map(|ratio| format!("{:.0}%", ratio * 100.0))
        .unwrap_or_else(|| tx.na().to_string());
    let liquidations = symbol
        .liquidations_1h
        .map(|(long, short)| {
            if tx.zh {
                format!("多 {long} 笔 / 空 {short} 笔")
            } else {
                format!("long {long} / short {short}")
            }
        })
        .unwrap_or_else(|| tx.na().to_string());
    out.push_str(&format!(
        "- {}：{} {}；{} 1h {}，24h {}；{} {}；{} {}\n",
        tx.t("衍生品", "Derivatives"),
        tx.t("资金费率", "funding"),
        funding,
        tx.t("持仓量", "OI"),
        tx.pct(symbol.oi_change_1h_pct),
        tx.pct(symbol.oi_change_24h_pct),
        tx.t("近 1h 主动买占比", "1h taker-buy share"),
        taker,
        tx.t("近 1h 爆仓", "1h liquidations"),
        liquidations,
    ));
    if let Some(radar) = symbol.radar_line.as_deref() {
        out.push_str(&format!("- {}：{radar}\n", tx.t("雷达", "Radar")));
    }
    out
}

fn render_list(title: &str, lines: &[String]) -> String {
    let mut out = format!("## {title}\n");
    for line in lines {
        out.push_str(&format!("- {line}\n"));
    }
    out
}

/// 渲染简报。超过 `max_chars` 时按优先级整段丢弃（事件 → 运行记忆 → 唤醒条件 → 后面品种的细节 → …），
/// 并在末尾写明省略了哪些段。账户与风险预算永不丢弃。
pub fn render_briefing(doc: &BriefingDoc, chinese: bool, max_chars: usize) -> String {
    let tx = Text { zh: chinese };
    let mut sections: Vec<Section> = Vec::new();
    sections.push(Section { priority: 0, name: "account", body: render_account(doc, &tx) });
    if let Some(scorecard) = doc.scorecard.as_deref().filter(|text| !text.trim().is_empty()) {
        sections.push(Section {
            priority: 1,
            name: "scorecard",
            body: format!("## {}\n{}\n", tx.t("你的成绩单", "Your scorecard"), scorecard.trim_end()),
        });
    }
    for (index, symbol) in doc.symbols.iter().enumerate() {
        sections.push(Section { priority: 1, name: "symbol", body: render_symbol_core(symbol, &tx) });
        // 第一个品种的细节比后面品种的更重要。
        sections.push(Section {
            priority: if index == 0 { 3 } else { 4 },
            name: "symbol-extras",
            body: render_symbol_extras(symbol, &tx),
        });
    }
    if !doc.opportunities.is_empty() {
        let lines = doc
            .opportunities
            .iter()
            .map(|item| {
                format!(
                    "{}：{}，{} {}，{} {}，{} {}，{} {}",
                    item.id,
                    item.title,
                    tx.t("入场", "entry"),
                    tx.px(item.entry),
                    tx.t("止损", "stop"),
                    tx.px(item.stop),
                    tx.t("止盈", "target"),
                    tx.px(item.take_profit),
                    tx.t("状态", "status"),
                    item.status
                )
            })
            .collect::<Vec<_>>();
        sections.push(Section {
            priority: 2,
            name: "opportunities",
            body: render_list(tx.t("本 Profile 进行中的机会", "This Profile's open opportunities"), &lines),
        });
    }
    if !doc.wake_conditions.is_empty() {
        sections.push(Section {
            priority: 5,
            name: "wake",
            body: render_list(tx.t("生效中的唤醒条件", "Active wake conditions"), &doc.wake_conditions),
        });
    }
    if !doc.recent_runs.is_empty() {
        let lines = doc.recent_runs.iter().map(|note| format!("{} {}", note.at_label, note.text)).collect::<Vec<_>>();
        sections.push(Section {
            priority: 6,
            name: "recent-runs",
            body: render_list(tx.t("最近几次运行的结论", "Recent run conclusions"), &lines),
        });
    }
    if !doc.events.is_empty() {
        let lines = doc.events.iter().map(|note| format!("{} {}", note.at_label, note.text)).collect::<Vec<_>>();
        sections.push(Section {
            priority: 7,
            name: "events",
            body: render_list(tx.t("6 小时内的重要事件", "Major events in the last 6 hours"), &lines),
        });
    }

    let header = if chinese {
        format!(
            "【交易员简报】生成于 {}。以下数字由代码根据本地行情与账户计算；标「不可用」的数据不要猜。\n",
            doc.generated_at_label
        )
    } else {
        format!(
            "[Trader briefing] generated at {}. Figures are computed by code from local market and account data; do not guess anything marked n/a.\n",
            doc.generated_at_label
        )
    };
    let mut dropped: Vec<&'static str> = Vec::new();
    loop {
        let total = header.chars().count() + sections.iter().map(|section| section.body.chars().count()).sum::<usize>();
        if total <= max_chars {
            break;
        }
        let Some((index, _)) = sections
            .iter()
            .enumerate()
            .filter(|(_, section)| section.priority > 0)
            .max_by_key(|(index, section)| (section.priority, *index))
        else {
            break;
        };
        let removed = sections.remove(index);
        if !dropped.contains(&removed.name) {
            dropped.push(removed.name);
        }
    }
    let mut out = header;
    for section in &sections {
        out.push_str(&section.body);
    }
    if !dropped.is_empty() {
        out.push_str(&if chinese {
            format!("（简报超长，已省略：{}）\n", dropped.join("、"))
        } else {
            format!("(Briefing too long; omitted: {})\n", dropped.join(", "))
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn btc() -> BriefingSymbol {
        BriefingSymbol {
            inst_id: "BTC-USDT-SWAP".into(),
            last: Some(84_763.3),
            chg_5m_pct: Some(0.05),
            chg_1h_pct: Some(-0.31),
            chg_24h_pct: Some(0.24),
            high_24h: Some(84_998.0),
            low_24h: Some(83_820.0),
            regime_daily: Some("up".into()),
            chg_7d_pct: Some(3.2),
            timeframes: vec![
                BriefingTimeframe {
                    label: "1h".into(),
                    trend: Some("up".into()),
                    window_high: Some(85_500.0),
                    window_low: Some(83_800.0),
                    range_pos: Some(0.56),
                    swing_high: Some(85_500.0),
                    swing_low: Some(84_100.0),
                },
                BriefingTimeframe { label: "4h".into(), ..Default::default() },
            ],
            atr_1h: Some(210.5),
            regime: Some("trend".into()),
            rsi_1h: Some(56.24),
            ema20_1h: Some(85_120.0),
            ema50_1h: Some(84_890.5),
            macd_hist_1h: Some(12.3),
            macd_hist_1h_prev: Some(18.0),
            boll_pos_1h: Some(0.82),
            sizing: Some(BriefingSizing::MaxContracts { stop_distance: 210.5, contracts: 7.0 }),
            ..Default::default()
        }
    }

    fn doc() -> BriefingDoc {
        BriefingDoc {
            generated_at_label: "2026-10-04 21:30:05 UTC+8".into(),
            account: Some(BriefingAccount {
                equity_usdt: Some(1_520.3),
                available_usdt: Some(1_210.0),
                snapshot_age_seconds: Some(3),
                positions: vec![BriefingPosition {
                    inst_id: "BTC-USDT-SWAP".into(),
                    long: true,
                    contracts: 3.0,
                    entry_px: Some(84_210.5),
                    mark_px: Some(84_760.0),
                    upl_usdt: Some(16.5),
                    stop_px: Some(83_500.0),
                    take_profit_px: None,
                    liq_px: Some(70_100.0),
                    owner: Some("本 Profile".into()),
                }],
                open_orders: vec![BriefingOrder {
                    inst_id: "BTC-USDT-SWAP".into(),
                    kind_label: "限价 买".into(),
                    px: Some(84_750.0),
                    contracts: Some(0.02),
                    reduce_only: false,
                    owner: Some("其他 Profile：经典".into()),
                }],
                omitted_orders: 0,
            }),
            budget: Some(BriefingBudget {
                risk_per_trade_pct: 1.0,
                risk_per_trade_usdt: Some(15.2),
                min_reward_risk: 1.2,
                daily_loss_limit_pct: 3.0,
                today_realized_pnl: Some(-12.4),
                remaining_daily_loss_usdt: Some(33.21),
                open_exposure: Some(1),
                max_open_positions: 2,
            }),
            symbols: vec![btc()],
            ..Default::default()
        }
    }

    #[test]
    fn renders_facts_and_marks_missing_values_instead_of_zero() {
        let text = render_briefing(&doc(), true, BRIEFING_MAX_CHARS);
        assert!(text.contains("权益 1520.30 U"), "{text}");
        assert!(text.contains("今天还能亏 33.21 U"), "{text}");
        assert!(text.contains("本 Profile 敞口 1/2"), "{text}");
        assert!(text.contains("止损 83500（-1.49%）"), "{text}");
        assert!(text.contains("止盈 未挂"), "{text}");
        assert!(text.contains("- 持仓（本 Profile） BTC-USDT-SWAP 多 3 张"), "{text}");
        assert!(text.contains("- 挂单（其他 Profile：经典） BTC-USDT-SWAP 限价 买 0.02 张 @ 84750"), "{text}");
        assert!(text.contains("1h 上升，区间 83800–85500，位于 56%"), "{text}");
        // 4h 不可用、ATR 5m 缺失、盘口缺失：写「不可用」，绝不写 0。
        assert!(text.contains("4h 不可用"), "{text}");
        assert!(text.contains("行情阶段：日线 上升（收盘 > EMA20 > EMA50），4h 不可用；7 日 +3.20%，30 日 不可用"), "{text}");
        assert!(text.contains("ATR 5m 不可用"), "{text}");
        assert!(text.contains("点差 不可用 bp"), "{text}");
        assert!(text.contains("单笔风险预算内最多 7 张"), "{text}");
        assert!(!text.contains("你的成绩单"), "没有成绩单时不出这一段");
        let mut with_card = doc();
        with_card.scorecard = Some("已结算 3 条决策".into());
        assert!(render_briefing(&with_card, true, BRIEFING_MAX_CHARS).contains("## 你的成绩单\n已结算 3 条决策"));
        assert!(text.contains("1h EMA20 85120 / EMA50 84890.5，MACD 柱 +12.30（前一根 +18.00，收缩），布林位置 82%；4h EMA20 不可用"), "{text}");
        assert!(!text.contains("5m +0.00%"));
    }

    #[test]
    fn english_rendering_uses_english_labels() {
        let text = render_briefing(&doc(), false, BRIEFING_MAX_CHARS);
        assert!(text.starts_with("[Trader briefing]"));
        assert!(text.contains("Equity 1520.30 U"), "{text}");
        assert!(text.contains("4h n/a"), "{text}");
        assert!(text.contains("take profit none"), "{text}");
    }

    #[test]
    fn missing_account_is_stated_and_account_too_small_is_explained() {
        let mut doc = doc();
        doc.account = None;
        doc.symbols[0].sizing = Some(BriefingSizing::AccountTooSmall { stop_distance: 210.5 });
        let text = render_briefing(&doc, true, BRIEFING_MAX_CHARS);
        assert!(text.contains("账户快照不可用"), "{text}");
        assert!(text.contains("这个止损距离下开不了仓"), "{text}");
    }

    #[test]
    fn over_long_briefings_drop_low_priority_sections_but_keep_the_account() {
        let mut doc = doc();
        doc.events = (0..40)
            .map(|index| BriefingNote { at_label: "20:30".into(), text: format!("事件 {index} {}", "很长的标题".repeat(10)) })
            .collect();
        doc.recent_runs = vec![BriefingNote { at_label: "21:00".into(), text: "等待".into() }];
        let full = render_briefing(&doc, true, 100_000);
        assert!(full.contains("事件 39"));
        let text = render_briefing(&doc, true, 1_500);
        assert!(text.chars().count() <= 1_500 + 40, "{}", text.chars().count());
        assert!(text.contains("账户与风险预算"));
        assert!(text.contains("## BTC-USDT-SWAP"));
        assert!(!text.contains("事件 39"));
        assert!(text.contains("已省略：events"), "{text}");
    }

    #[test]
    fn prices_use_magnitude_based_precision() {
        assert_eq!(format_price(84_763.35), "84763.4");
        assert_eq!(format_price(25.5), "25.5");
        assert_eq!(format_price(1.23456), "1.2346");
        assert_eq!(format_price(0.000123), "0.000123");
    }
}
