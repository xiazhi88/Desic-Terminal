//! 交易员模式（Profile `context_mode = "briefing"`）：运行开始前由代码把关注品种、账户与风险预算
//! 整理成一页简报写进提示词，AI 只做判断，不再自己反复调用读数据工具。
//!
//! 这里只负责取数与计算（复用快判的纯函数与既有读取函数）；渲染在
//! `desic_agent_automation::render_briefing`。所有读取都有总时限，拿不到的块标「不可用」，不阻塞运行。

use super::*;
use crate::ai_automation::AiAgentProfileSummary;
use desic_agent_automation::{
    BriefingAccount, BriefingBudget, BriefingDoc, BriefingNote, BriefingOpportunity, BriefingOrder,
    BriefingPosition, BriefingSizing, BriefingSymbol, BriefingTimeframe,
};
use std::future::Future;
use std::time::Duration;

/// 交易员模式下允许的工具：决策 / 下单链路 + 少量深挖读取 + 读 Profile 技能。
/// 列表外的读数据工具（机会全量列表、情报、雷达、账户风险等）由简报替代；专家调度不在列表里。
/// sidecar 与 Rust `authorize_ai_tool` 用同一份名单拦截。
pub(crate) const BRIEFING_TOOL_ALLOWLIST: &[&str] = &[
    "background.finishRun",
    "market.readDecisionContext",
    "trade.precheck",
    "trade.evaluatePlan",
    "trade.setLeverage",
    "tradeOpportunity.create",
    "tradeOpportunity.revise",
    "tradeOpportunity.reuse",
    "tradeOpportunity.close",
    "market.readTicker",
    "market.readCandles",
    "market.readOrderBook",
    "market.readIndicators",
    "market.readInstrument",
    "account.readOrderStatus",
    "notification.feishu.send",
    "skills",
    "skill.readResource",
];

/// 整份简报的取数时限：超时的块标「不可用」。
const BRIEFING_DEADLINE_MS: i64 = 8_000;
const BRIEFING_MAX_SYMBOLS: usize = 3;
const BRIEFING_MAX_ORDERS: usize = 10;
/// 本 Profile 的「记忆」只看最近 24 小时。
const BRIEFING_MEMORY_WINDOW_MS: i64 = 24 * 60 * 60_000;
/// 简报不用实盘手续费（那要再请求一次接口），按常见吃单费率估算仓位参考；真正的风控在下单链路按实际费率复核。
const BRIEFING_ASSUMED_TAKER_FEE: &str = "0.0005";

pub(crate) struct ProfileBriefing {
    pub text: String,
    /// 写进 `audit_json.briefing`：字符数、耗时、缺失的块。
    pub audit: Value,
}

async fn within<T>(deadline: i64, future: impl Future<Output = T>) -> Option<T> {
    let remaining = deadline.saturating_sub(now_ms());
    if remaining <= 0 {
        return None;
    }
    tokio::time::timeout(Duration::from_millis(remaining as u64), future).await.ok()
}

fn number(text: &str) -> Option<f64> {
    text.trim().parse::<f64>().ok().filter(|value| value.is_finite())
}

fn value_number(value: &Value, key: &str) -> Option<f64> {
    let item = value.get(key)?;
    item.as_f64()
        .or_else(|| item.as_str().and_then(number))
        .filter(|value| value.is_finite())
}

fn shanghai_label(ms: i64, with_date: bool) -> String {
    let offset = chrono::FixedOffset::east_opt(8 * 60 * 60).expect("UTC+8 offset");
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|time| {
            time.with_timezone(&offset)
                .format(if with_date { "%Y-%m-%d %H:%M:%S UTC+8" } else { "%m-%d %H:%M" })
                .to_string()
        })
        .unwrap_or_default()
}

/// 库里能读到的部分（同步读完再进入异步取数，不让连接跨 await）。
#[derive(Default)]
struct DbFacts {
    today_realized_pnl: Option<f64>,
    open_exposure: Option<u32>,
    opportunities: Vec<BriefingOpportunity>,
    recent_runs: Vec<BriefingNote>,
    wake_conditions: Vec<String>,
    events: Vec<BriefingNote>,
    per_symbol: HashMap<String, SymbolDbFacts>,
    owners: Owners,
}

/// 账户里挂单 / 持仓的归属（同一账户可能被多个 Profile 共用）：委托号 → Profile、(品种, 方向) 的未平仓位 → Profile。
#[derive(Default)]
struct Owners {
    /// 委托号 → (所属 Profile, 下单方 `ai` / `user`)。
    orders: HashMap<String, (Option<String>, Option<String>)>,
    positions: HashMap<(String, String), String>,
    names: HashMap<String, String>,
}

impl Owners {
    fn label(&self, owner: Option<&String>, current_profile: &str, chinese: bool) -> String {
        self.label_with_operator(owner, None, current_profile, chinese)
    }

    fn label_with_operator(&self, owner: Option<&String>, operator: Option<&str>, current_profile: &str, chinese: bool) -> String {
        match owner {
            Some(profile_id) if profile_id == current_profile => (if chinese { "本 Profile" } else { "this Profile" }).to_string(),
            Some(profile_id) => {
                let name = self.names.get(profile_id).cloned().unwrap_or_else(|| profile_id.clone());
                if chinese { format!("其他 Profile：{name}") } else { format!("another Profile: {name}") }
            }
            None if operator == Some("ai") => (if chinese { "AI 研究" } else { "AI Research" }).to_string(),
            None => (if chinese { "手动或其他来源" } else { "manual or other source" }).to_string(),
        }
    }

    /// 挂单的归属；附挂的只减仓保护单对不上 Profile 时不单独标（它跟着持仓走）。
    fn order_label(&self, ord_id: &str, algo_id: &str, reduce_only: bool, current_profile: &str, chinese: bool) -> Option<String> {
        let found = self.orders.get(ord_id).or_else(|| self.orders.get(algo_id));
        match found {
            Some((Some(profile_id), _)) => Some(self.label(Some(profile_id), current_profile, chinese)),
            _ if reduce_only => None,
            Some((None, operator)) => Some(self.label_with_operator(None, operator.as_deref(), current_profile, chinese)),
            None => Some(self.label(None, current_profile, chinese)),
        }
    }
}

fn read_owners(conn: &Connection, now: i64) -> Owners {
    let mut owners = Owners::default();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT order_id,algo_id,agent_profile_id FROM trade_opportunities
         WHERE agent_profile_id IS NOT NULL AND created_at>=?1 AND (order_id IS NOT NULL OR algo_id IS NOT NULL)",
    ) {
        if let Ok(rows) = stmt.query_map(params![now - 30 * DAY_MS], |row| {
            Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?))
        }) {
            for (order_id, algo_id, profile_id) in rows.filter_map(Result::ok) {
                for id in [order_id, algo_id].into_iter().flatten().filter(|id| !id.is_empty()) {
                    owners.orders.insert(id, (Some(profile_id.clone()), Some("ai".to_string())));
                }
            }
        }
    }
    // 本地委托记录里的下单方与机会关联（AI 研究里创建的机会没有 Profile，下单方是 ai）。
    if let Ok(mut stmt) = conn.prepare(
        "SELECT r.ord_id,o.agent_profile_id,r.operator FROM okx_orders r
         LEFT JOIN trade_opportunities o ON o.id=r.opportunity_id
         WHERE r.state IN ('live','partially_filled')",
    ) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<String>>(2)?))
        }) {
            for (ord_id, profile_id, operator) in rows.filter_map(Result::ok) {
                let entry = owners.orders.entry(ord_id).or_insert((None, None));
                if entry.0.is_none() {
                    entry.0 = profile_id;
                }
                if entry.1.is_none() {
                    entry.1 = operator;
                }
            }
        }
    }
    if let Ok(mut stmt) = conn.prepare(
        "SELECT e.inst_id,e.episode_side,o.agent_profile_id FROM position_episodes e
         JOIN position_episode_opportunities p ON p.episode_id=e.id
         JOIN trade_opportunities o ON o.id=p.opportunity_id
         WHERE e.status<>'closed' AND o.agent_profile_id IS NOT NULL",
    ) {
        if let Ok(rows) = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))) {
            for (inst_id, side, profile_id) in rows.filter_map(Result::ok) {
                owners.positions.entry((inst_id, side)).or_insert(profile_id);
            }
        }
    }
    if let Ok(mut stmt) = conn.prepare("SELECT id,name FROM ai_agent_profiles") {
        if let Ok(rows) = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))) {
            owners.names.extend(rows.filter_map(Result::ok));
        }
    }
    owners
}

#[derive(Default, Clone)]
struct SymbolDbFacts {
    oi_change_1h_pct: Option<f64>,
    oi_change_24h_pct: Option<f64>,
    taker_buy_ratio_1h: Option<f64>,
    liquidations_1h: Option<(u32, u32)>,
    radar_line: Option<String>,
}

fn read_db_facts(app: &tauri::AppHandle, profile: &AiAgentProfileSummary, symbols: &[String], now: i64, chinese: bool) -> DbFacts {
    let Ok(conn) = crate::ai_automation::open_automation_database(app) else {
        return DbFacts::default();
    };
    let mut facts = DbFacts {
        today_realized_pnl: crate::ai_risk_gate::account_realized_pnl_today(&conn, profile.account_id.as_deref(), now),
        open_exposure: crate::ai_risk_gate::profile_open_exposure_count(&conn, &profile.id),
        ..DbFacts::default()
    };
    facts.opportunities = read_recent_opportunities(&conn, &profile.id, now, chinese);
    facts.owners = read_owners(&conn, now);
    facts.recent_runs = read_recent_runs(&conn, &profile.id);
    facts.wake_conditions = read_wake_conditions(&conn, &profile.id, chinese);
    facts.events = read_relevant_events(&conn, symbols, now);
    for inst_id in symbols {
        facts.per_symbol.insert(inst_id.clone(), read_symbol_db_facts(&conn, inst_id, now, chinese));
    }
    facts
}

/// 6 小时内的重要事件，只留与关注币种相关、或至少两个来源报道的宏观 / 行业新闻（单一来源的无关新闻不进简报）。
fn read_relevant_events(conn: &Connection, symbols: &[String], now: i64) -> Vec<BriefingNote> {
    let bases = symbols
        .iter()
        .filter_map(|inst_id| inst_id.split('-').next())
        .map(str::to_ascii_uppercase)
        .collect::<Vec<_>>();
    let Ok(mut stmt) = conn.prepare(
        "SELECT title,coins_json,source_count,last_published_at FROM intelligence_news_events
         WHERE last_published_at>=?1 AND importance IN ('high','3')
         ORDER BY last_published_at DESC LIMIT 50",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map(params![now.saturating_sub(6 * 60 * 60_000)], |row| {
        Ok((
            row.get::<_, Option<String>>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<i64>>(2)?,
            row.get::<_, Option<i64>>(3)?,
        ))
    });
    let Ok(rows) = rows else {
        return Vec::new();
    };
    rows.filter_map(Result::ok)
        .filter_map(|(title, coins, sources, at)| {
            let title = title.filter(|title| !title.trim().is_empty())?;
            let coins = coins
                .and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
                .unwrap_or_default()
                .into_iter()
                .map(|coin| coin.to_ascii_uppercase())
                .collect::<Vec<_>>();
            let relevant = if coins.is_empty() {
                sources.unwrap_or(0) >= 2
            } else {
                coins.iter().any(|coin| bases.contains(coin))
            };
            relevant.then(|| BriefingNote { at_label: shanghai_label(at.unwrap_or(now), false), text: title })
        })
        .take(3)
        .collect()
}

fn read_recent_opportunities(conn: &Connection, profile_id: &str, now: i64, chinese: bool) -> Vec<BriefingOpportunity> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT o.id,o.intent,o.direction,o.inst_id,o.price,o.stop_loss_json,o.take_profit_json,o.status,
                (SELECT r.state FROM okx_orders r WHERE r.opportunity_id=o.id ORDER BY r.rowid DESC LIMIT 1)
         FROM trade_opportunities o
         WHERE o.agent_profile_id=?1 AND o.created_at>=?2
         ORDER BY o.created_at DESC LIMIT 5",
    ) else {
        return Vec::new();
    };
    let trigger = |raw: Option<String>| -> Option<f64> {
        raw.and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| value_number(&value, "triggerPx"))
    };
    let rows = stmt.query_map(params![profile_id, now.saturating_sub(BRIEFING_MEMORY_WINDOW_MS)], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, String>(7)?,
            row.get::<_, Option<String>>(8)?,
        ))
    });
    let Ok(rows) = rows else {
        return Vec::new();
    };
    rows.filter_map(Result::ok)
        .map(|(id, intent, direction, inst_id, price, stop, take_profit, status, order_state)| {
            let action = match (intent.as_str(), direction.as_deref(), chinese) {
                ("open", Some("long"), true) => "开多",
                ("open", Some("short"), true) => "开空",
                ("close", _, true) => "平仓",
                ("cancel", _, true) => "撤单",
                ("open", Some("long"), false) => "open long",
                ("open", Some("short"), false) => "open short",
                ("close", _, false) => "close",
                ("cancel", _, false) => "cancel",
                (_, _, _) => intent.as_str(),
            };
            let status = match order_state {
                Some(state) if !state.is_empty() => format!("{status} / {} {state}", if chinese { "委托" } else { "order" }),
                _ => status,
            };
            BriefingOpportunity {
                id,
                title: format!("{action} {inst_id}"),
                entry: price.as_deref().and_then(number),
                stop: trigger(stop),
                take_profit: trigger(take_profit),
                status,
            }
        })
        .collect()
}

fn read_recent_runs(conn: &Connection, profile_id: &str) -> Vec<BriefingNote> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT started_at,final_decision_json,summary FROM ai_agent_runs
         WHERE profile_id=?1 AND status='completed' AND final_decision_json IS NOT NULL
         ORDER BY started_at DESC LIMIT 3",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map(params![profile_id], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<String>>(2)?))
    });
    let Ok(rows) = rows else {
        return Vec::new();
    };
    rows.filter_map(Result::ok)
        .filter_map(|(at, decision, summary)| {
            let decision = decision.and_then(|text| serde_json::from_str::<Value>(&text).ok())?;
            let outcome = decision.get("outcome").and_then(Value::as_str).unwrap_or("?").to_string();
            let reason = decision
                .get("reason")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or(summary)
                .unwrap_or_default();
            let reason = reason.split_whitespace().collect::<Vec<_>>().join(" ");
            let reason: String = reason.chars().take(120).collect();
            Some(BriefingNote { at_label: shanghai_label(at, false), text: format!("{outcome}：{reason}") })
        })
        .collect()
}

fn read_wake_conditions(conn: &Connection, profile_id: &str, chinese: bool) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT source,condition_type,config_json FROM ai_wake_conditions
         WHERE profile_id=?1 AND status='active' ORDER BY created_at DESC LIMIT 5",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map(params![profile_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?))
    });
    let Ok(rows) = rows else {
        return Vec::new();
    };
    rows.filter_map(Result::ok)
        .map(|(source, condition_type, config)| {
            let config = config.and_then(|text| serde_json::from_str::<Value>(&text).ok()).unwrap_or(Value::Null);
            let inst_id = config.get("instId").and_then(Value::as_str).unwrap_or("");
            let pick = |zh: &str, en: &str| if chinese { zh.to_string() } else { en.to_string() };
            let detail = match condition_type.as_str() {
                "price_cross" => format!(
                    "{inst_id} {} {}",
                    match (config.get("direction").and_then(Value::as_str), chinese) {
                        (Some("up"), true) => "价格上穿",
                        (Some("down"), true) => "价格下穿",
                        (Some("up"), false) => "price crosses above",
                        (Some("down"), false) => "price crosses below",
                        _ => "",
                    },
                    value_number(&config, "price").map(desic_agent_automation::format_price).unwrap_or_default()
                ),
                "order_state_changed" => format!("{} {inst_id}", pick("委托状态变化", "order state changes")),
                "position_changed" => format!("{} {inst_id}", pick("持仓变化", "position changes")),
                "opportunity_state_changed" => format!(
                    "{} {}",
                    pick("机会状态变化", "opportunity state changes"),
                    config.get("opportunityId").and_then(Value::as_str).unwrap_or(inst_id)
                ),
                "timer" => match (config.get("atMs").and_then(Value::as_i64), config.get("intervalMinutes").and_then(Value::as_i64)) {
                    (Some(at), _) => format!("{} {}", pick("定时", "at"), shanghai_label(at, false)),
                    (None, Some(minutes)) => if chinese { format!("每 {minutes} 分钟") } else { format!("every {minutes} min") },
                    _ => pick("定时", "timer"),
                },
                other => {
                    // 未专门格式化的类型：去掉账户 ID 再展示参数。
                    let mut config = config.clone();
                    if let Some(object) = config.as_object_mut() {
                        object.remove("accountId");
                        object.remove("type");
                    }
                    let mut text = format!("{other} {config}");
                    text.truncate(120);
                    text
                }
            };
            let source = match (source.as_str(), chinese) {
                ("user", true) => "用户设置",
                ("agent", true) => "AI 设置",
                ("user", false) => "set by user",
                (_, false) => "set by AI",
                (_, true) => "AI 设置",
            };
            format!("{}（{source}）", detail.trim())
        })
        .collect()
}

fn read_symbol_db_facts(conn: &Connection, inst_id: &str, now: i64, chinese: bool) -> SymbolDbFacts {
    let oi_at = |at: i64| -> Option<f64> {
        conn.query_row(
            "SELECT oi_usd FROM intelligence_derivatives_snapshots
             WHERE inst_id=?1 AND granularity='5m' AND bucket_at<=?2 ORDER BY bucket_at DESC LIMIT 1",
            params![inst_id, at],
            |row| row.get::<_, Option<f64>>(0),
        )
        .ok()
        .flatten()
        .filter(|value| value.is_finite() && *value > 0.0)
    };
    // 本地衍生品数据超过 30 分钟没更新就当不可用，不拿旧数算「变化」。
    let latest_fresh = conn
        .query_row(
            "SELECT MAX(bucket_at) FROM intelligence_derivatives_snapshots WHERE inst_id=?1 AND granularity='5m'",
            params![inst_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .ok()
        .flatten()
        .filter(|at| now.saturating_sub(*at) <= 30 * 60_000);
    let change = |from: Option<f64>, to: Option<f64>| match (from, to) {
        (Some(from), Some(to)) => Some((to - from) / from * 100.0),
        _ => None,
    };
    let (oi_change_1h_pct, oi_change_24h_pct) = match latest_fresh {
        Some(latest) => {
            let current = oi_at(latest);
            (change(oi_at(latest - 60 * 60_000), current), change(oi_at(latest - 24 * 60 * 60_000), current))
        }
        None => (None, None),
    };
    let taker_buy_ratio_1h = conn
        .query_row(
            "SELECT SUM(buy_volume),SUM(sell_volume),MAX(bucket_at) FROM intelligence_derivatives_flows
             WHERE inst_id=?1 AND granularity='5m' AND bucket_at>?2",
            params![inst_id, now.saturating_sub(60 * 60_000)],
            |row| Ok((row.get::<_, Option<f64>>(0)?, row.get::<_, Option<f64>>(1)?)),
        )
        .ok()
        .and_then(|(buy, sell)| match (buy, sell) {
            (Some(buy), Some(sell)) if buy + sell > 0.0 => Some(buy / (buy + sell)),
            _ => None,
        });
    // 爆仓只数笔数（`side=sell` 是多头被强平）：样本的数量单位不统一，不换算金额。
    // 库里一小时内没有任何样本时无法区分「没有爆仓」与「没在采集」，按不可用处理。
    let liquidations_1h = conn
        .query_row(
            "SELECT SUM(CASE WHEN side='sell' THEN 1 ELSE 0 END),SUM(CASE WHEN side='buy' THEN 1 ELSE 0 END),COUNT(*)
             FROM intelligence_liquidation_samples WHERE inst_id=?1 AND event_at>?2",
            params![inst_id, now.saturating_sub(60 * 60_000)],
            |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?, row.get::<_, i64>(2)?)),
        )
        .ok()
        .filter(|(_, _, count)| *count > 0)
        .map(|(long, short, _)| (long.unwrap_or(0) as u32, short.unwrap_or(0) as u32));
    let radar_line = crate::market_radar_workspace::radar_rank_for_briefing(conn, inst_id).map(|(rank, universe, score, at)| {
        if chinese {
            format!("第 {rank} 名 / 共 {universe}，综合分 {score:.1}（{} 的小时快照）", shanghai_label(at, false))
        } else {
            format!("rank {rank} of {universe}, composite {score:.1} (hourly snapshot {})", shanghai_label(at, false))
        }
    });
    SymbolDbFacts { oi_change_1h_pct, oi_change_24h_pct, taker_buy_ratio_1h, liquidations_1h, radar_line }
}

async fn read_account_snapshot(app: &tauri::AppHandle, market: &MarketRuntime, account_id: Option<&str>) -> Option<PrivateAccountSnapshot> {
    if let Some(snapshot) = ai_read_fresh_memory_account_snapshot(market, account_id) {
        return Some(snapshot);
    }
    let account_id = account_id?;
    okx_private_snapshot(app.clone(), PrivateSnapshotRequest { account_id: Some(account_id.to_string()) })
        .await
        .ok()
}

fn account_block(snapshot: &PrivateAccountSnapshot, now: i64, chinese: bool, owners: &Owners, profile_id: &str) -> BriefingAccount {
    let usdt = snapshot.balances.iter().find(|balance| balance.ccy.eq_ignore_ascii_case("USDT"));
    let protection = |inst_id: &str, long: bool| -> (Option<f64>, Option<f64>) {
        let mut stop = None;
        let mut take_profit = None;
        for order in snapshot.orders.iter().filter(|order| order.is_algo && order.inst_id == inst_id) {
            let protects_long = match order.pos_side.as_str() {
                "long" => true,
                "short" => false,
                _ => order.side == "sell",
            };
            if protects_long != long {
                continue;
            }
            stop = stop.or_else(|| number(&order.sl_trigger_px));
            take_profit = take_profit.or_else(|| number(&order.tp_trigger_px));
        }
        (stop, take_profit)
    };
    let positions = snapshot
        .positions
        .iter()
        .filter_map(|position| {
            let size = number(&position.pos).filter(|value| *value != 0.0)?;
            let long = match position.pos_side.as_str() {
                "long" => true,
                "short" => false,
                _ => size > 0.0,
            };
            let (stop_px, take_profit_px) = protection(&position.inst_id, long);
            Some(BriefingPosition {
                inst_id: position.inst_id.clone(),
                long,
                contracts: size.abs(),
                entry_px: number(&position.avg_px),
                mark_px: number(&position.mark_px),
                upl_usdt: number(&position.upl),
                stop_px,
                take_profit_px,
                liq_px: number(&position.liq_px).filter(|value| *value > 0.0),
                owner: Some(owners.label(
                    owners.positions.get(&(position.inst_id.clone(), if long { "long" } else { "short" }.to_string())),
                    profile_id,
                    chinese,
                )),
            })
        })
        .collect::<Vec<_>>();
    let order_kind = |order: &OkxPendingOrder| -> String {
        let side = match (order.side.as_str(), chinese) {
            ("buy", true) => "买",
            ("sell", true) => "卖",
            (other, _) => other,
        };
        let kind = if number(&order.sl_trigger_px).is_some() && number(&order.tp_trigger_px).is_some() {
            if chinese { "止盈止损" } else { "TP/SL" }
        } else if number(&order.sl_trigger_px).is_some() {
            if chinese { "止损" } else { "stop" }
        } else if number(&order.tp_trigger_px).is_some() {
            if chinese { "止盈" } else { "take profit" }
        } else if order.is_algo {
            if chinese { "计划" } else { "trigger" }
        } else if order.ord_type == "market" {
            if chinese { "市价" } else { "market" }
        } else if chinese {
            "限价"
        } else {
            "limit"
        };
        format!("{kind} {side}")
    };
    let orders = snapshot
        .orders
        .iter()
        .map(|order| BriefingOrder {
            inst_id: order.inst_id.clone(),
            kind_label: order_kind(order),
            px: number(&order.px)
                .or_else(|| number(&order.trigger_px))
                .or_else(|| number(&order.sl_trigger_px))
                .or_else(|| number(&order.tp_trigger_px)),
            contracts: number(&order.sz),
            reduce_only: order.reduce_only == "true",
            owner: owners.order_label(&order.ord_id, &order.algo_id, order.reduce_only == "true", profile_id, chinese),
        })
        .collect::<Vec<_>>();
    let omitted_orders = orders.len().saturating_sub(BRIEFING_MAX_ORDERS);
    BriefingAccount {
        equity_usdt: usdt.and_then(|balance| number(&balance.eq)),
        available_usdt: usdt.and_then(|balance| number(&balance.avail_eq).or_else(|| number(&balance.avail_bal))),
        snapshot_age_seconds: (snapshot.synced_at > 0).then(|| now.saturating_sub(snapshot.synced_at).max(0) / 1_000),
        positions,
        open_orders: orders.into_iter().take(BRIEFING_MAX_ORDERS).collect(),
        omitted_orders,
    }
}

/// 盘口档位统一成快判盘口函数认的 `[[价格, 币数量], …]`：内存盘口是 `{px, sz, orders}` 字符串对象，
/// REST 是 `["px", "sz", …]` 字符串数组；永续的 `sz` 是张数，必须乘面值，否则深度金额会差几个数量级。
/// 面值未知时返回 `None`（盘口三项标不可用，不拿张数冒充币数）。
fn book_levels_in_coin(book: &Value, ct_val: Option<f64>) -> Option<Value> {
    let ct_val = ct_val?;
    let side = |key: &str| -> Option<Vec<Value>> {
        let levels = book.get(key)?.as_array()?;
        Some(
            levels
                .iter()
                .filter_map(|level| {
                    let (px, sz) = match level {
                        Value::Array(items) => (items.first()?, items.get(1)?),
                        Value::Object(_) => (level.get("px")?, level.get("sz")?),
                        _ => return None,
                    };
                    let parse = |value: &Value| value.as_f64().or_else(|| value.as_str().and_then(number));
                    Some(json!([parse(px)?, parse(sz)? * ct_val]))
                })
                .collect(),
        )
    };
    let bids = side("bids")?;
    let asks = side("asks")?;
    (!bids.is_empty() && !asks.is_empty()).then(|| json!({ "bids": bids, "asks": asks }))
}

/// 1h / 4h / 1D 的本地聚合序列（按 UTC 对齐，最后一根可能是未收盘的当期）。
#[derive(Default)]
struct HigherTimeframes {
    h1: Vec<crate::fastlane::Bar>,
    h4: Vec<crate::fastlane::Bar>,
    d1: Vec<crate::fastlane::Bar>,
}

const HOUR_MS: i64 = 60 * 60_000;
const DAY_MS: i64 = 24 * HOUR_MS;

async fn read_higher_timeframes(app: &tauri::AppHandle, inst_id: &str, now: i64) -> HigherTimeframes {
    let app = app.clone();
    let inst_id = inst_id.to_string();
    crate::blocking_work::run_blocking(move || {
        let conn = open_read_database(&app)?;
        let read = |step_ms: i64, span_ms: i64| -> Vec<crate::fastlane::Bar> {
            local_candles_aggregated(&conn, &inst_id, step_ms, now - span_ms, now)
                .map(|(candles, _)| {
                    candles
                        .into_iter()
                        .map(|candle| crate::fastlane::Bar {
                            t: candle.time * 1000,
                            o: candle.open,
                            h: candle.high,
                            l: candle.low,
                            c: candle.close,
                            v: candle.volume,
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        Ok::<_, String>(HigherTimeframes { h1: read(HOUR_MS, 10 * DAY_MS), h4: read(4 * HOUR_MS, 30 * DAY_MS), d1: read(DAY_MS, 200 * DAY_MS) })
    })
    .await
    .unwrap_or_default()
}

/// 本地历史不够算日线阶段 / 4h EMA50 时，后台静默补最近 30 天的 1m K 线（不阻塞本轮；同一品种 6 小时内只补一次）。
pub(crate) fn request_history_backfill(app: &tauri::AppHandle, inst_id: &str, now: i64) {
    static LAST_REQUEST: std::sync::OnceLock<Mutex<HashMap<String, i64>>> = std::sync::OnceLock::new();
    let requests = LAST_REQUEST.get_or_init(|| Mutex::new(HashMap::new()));
    {
        let Ok(mut requests) = requests.lock() else { return };
        if requests.get(inst_id).is_some_and(|at| now.saturating_sub(*at) < 6 * HOUR_MS) {
            return;
        }
        requests.insert(inst_id.to_string(), now);
    }
    let app = app.clone();
    let inst_id = inst_id.to_string();
    tauri::async_runtime::spawn(async move {
        let end = now - now.rem_euclid(60_000);
        if let Err(error) = sync_kline_window_quiet(&app, &inst_id, "1m", end - 30 * DAY_MS, end).await {
            crate::boot_log(&format!("trader briefing history backfill failed inst={inst_id}: {error}"));
        }
    });
}

fn last_value(series: Vec<Option<f64>>) -> Option<f64> {
    series.into_iter().last().flatten().filter(|value| value.is_finite())
}

/// 单个品种的行情部分（价格、结构、波动、RSI、盘口、资金费率、仓位参考）。
async fn symbol_block(
    app: &tauri::AppHandle,
    market: &MarketRuntime,
    inst_id: &str,
    db: SymbolDbFacts,
    equity: Option<f64>,
    risk_pct: f64,
    deadline: i64,
    chinese: bool,
    missing: &mut Vec<String>,
) -> BriefingSymbol {
    let now = now_ms();
    let mut block = BriefingSymbol {
        inst_id: inst_id.to_string(),
        oi_change_1h_pct: db.oi_change_1h_pct,
        oi_change_24h_pct: db.oi_change_24h_pct,
        taker_buy_ratio_1h: db.taker_buy_ratio_1h,
        liquidations_1h: db.liquidations_1h,
        radar_line: db.radar_line,
        ..BriefingSymbol::default()
    };
    // 合约规格先取：盘口深度要用面值把「张」换算成币，仓位参考也要用。
    let instrument = match within(deadline, crate::trade_support::fetch_instrument(app, inst_id)).await {
        Some(Ok(instrument)) => Some(instrument),
        _ => {
            missing.push(format!("{inst_id}:instrument"));
            None
        }
    };
    let ct_val = instrument.as_ref().and_then(|instrument| number(&instrument.ct_val)).filter(|value| *value > 0.0);
    let bars = match within(deadline, crate::ai_automation::read_fastlane_candle_values(app, market, inst_id, now)).await {
        Some(values) => crate::fastlane::bars_from_values(&values),
        None => Vec::new(),
    };
    if bars.is_empty() {
        missing.push(format!("{inst_id}:candles"));
    }
    match within(deadline, ai_read_ticker(market, inst_id)).await {
        Some(Ok(ticker)) => match crate::fastlane::normalize_ticker_block(&ticker, &bars) {
            Some((price, _)) => {
                block.last = value_number(&price, "last");
                block.chg_5m_pct = value_number(&price, "chg5mPct");
                block.chg_1h_pct = value_number(&price, "chg1hPct");
                block.chg_24h_pct = value_number(&price, "chg24hPct");
                block.high_24h = value_number(&price, "high24h");
                block.low_24h = value_number(&price, "low24h");
            }
            None => missing.push(format!("{inst_id}:ticker")),
        },
        _ => missing.push(format!("{inst_id}:ticker")),
    }
    // 15m 结构与 5m ATR 用最近的 1m K 线；1h / 4h / 1D 改用本地 1m 按 UTC 对齐聚合的长窗口
    //（1m 窗口拼接只覆盖约 3.5 天，4h EMA50 与日线阶段会一直不可用）。口径与快判一致：
    // 15m 60 根、1h 48 根、4h 24 根做结构；ATR14。
    let higher = within(deadline, read_higher_timeframes(app, inst_id, now)).await.unwrap_or_default();
    if higher.h4.len() < 50 || higher.d1.len() < 50 {
        missing.push(format!("{inst_id}:history"));
        request_history_backfill(app, inst_id, now);
    }
    let view = |series: &[crate::fastlane::Bar], lookback: usize| -> crate::fastlane::StateTimeframe {
        crate::fastlane::structure_view(series, lookback).unwrap_or_else(crate::fastlane::StateTimeframe::unavailable)
    };
    let structure = crate::fastlane::StateStructure {
        tf_15m: view(&crate::fastlane::aggregate_bars(&bars, 15), 60),
        tf_1h: view(&higher.h1, 48),
        tf_4h: view(&higher.h4, 24),
    };
    block.timeframes = [("15m", &structure.tf_15m), ("1h", &structure.tf_1h), ("4h", &structure.tf_4h)]
        .into_iter()
        .map(|(label, view)| BriefingTimeframe {
            label: label.to_string(),
            trend: view.is_available().then(|| view.trend.clone()),
            window_high: view.window_high,
            window_low: view.window_low,
            range_pos: view.range_pos,
            swing_high: view.last_swing_high,
            swing_low: view.last_swing_low,
        })
        .collect();
    block.atr_5m = crate::fastlane::atr14(&crate::fastlane::aggregate_bars(&bars, 5));
    block.atr_1h = crate::fastlane::atr14(&higher.h1);
    block.atr_4h = crate::fastlane::atr14(&higher.h4);
    // `volatility_regime` 按 60 分钟聚合传入的序列；传 1h 序列时聚合是恒等变换。
    let regime = crate::fastlane::volatility_regime(&structure, &higher.h1);
    block.regime = (regime != "unknown").then_some(regime);
    let closes_of = |series: &[crate::fastlane::Bar]| series.iter().map(|bar| bar.c).collect::<Vec<_>>();
    let (closes_1h, closes_4h, closes_1d) = (closes_of(&higher.h1), closes_of(&higher.h4), closes_of(&higher.d1));
    block.rsi_1h = last_value(ai_rsi(&closes_1h, 14));
    block.rsi_4h = last_value(ai_rsi(&closes_4h, 14));
    block.ema20_1h = last_value(ai_ema(&closes_1h, 20));
    block.ema50_1h = last_value(ai_ema(&closes_1h, 50));
    block.ema20_4h = last_value(ai_ema(&closes_4h, 20));
    block.ema50_4h = last_value(ai_ema(&closes_4h, 50));
    block.regime_daily = desic_agent_automation::daily_regime(&closes_1d).map(|regime| regime.as_str().to_string());
    block.chg_7d_pct = desic_agent_automation::change_pct(&closes_1d, 7);
    block.chg_30d_pct = desic_agent_automation::change_pct(&closes_1d, 30);
    let series = |value: &Value, key: &str| -> Vec<Option<f64>> {
        value
            .get(key)
            .and_then(Value::as_array)
            .map(|items| items.iter().map(Value::as_f64).collect())
            .unwrap_or_default()
    };
    let histogram = series(&ai_macd(&closes_1h), "histogram");
    block.macd_hist_1h = histogram.last().copied().flatten();
    block.macd_hist_1h_prev = histogram.len().checked_sub(2).and_then(|index| histogram[index]);
    let boll = ai_boll(&closes_1h, 20, 2.0);
    block.boll_pos_1h = match (series(&boll, "upper").last().copied().flatten(), series(&boll, "lower").last().copied().flatten(), closes_1h.last()) {
        (Some(upper), Some(lower), Some(close)) if upper > lower => Some((close - lower) / (upper - lower)),
        _ => None,
    };
    match within(deadline, ai_read_orderbook(market, inst_id, crate::ai_automation::FASTLANE_ORDERBOOK_DEPTH)).await {
        // 主动买卖比在简报里改用本地 1h 口径（见 `read_symbol_db_facts`），这里只取盘口三项；
        // 传入占位值只是为了让快判的盘口函数给出结果，它不会被使用。
        Some(Ok(book)) => match book_levels_in_coin(&book, ct_val).and_then(|book| crate::fastlane::micro_from_orderbook(&book, Some(0.0))) {
            Some(micro) => {
                block.spread_bps = micro.spread_bps;
                block.book_imbalance = micro.bid_ask_imbalance;
                block.depth_5bps_usd = micro.depth_5bps_usd;
            }
            None => missing.push(format!("{inst_id}:orderbook")),
        },
        _ => missing.push(format!("{inst_id}:orderbook")),
    }
    match within(deadline, ai_read_funding_rate(market, inst_id)).await {
        Some(Ok(funding)) => match crate::fastlane::normalize_derivatives_block(&funding, now) {
            Some((derivatives, _)) => {
                block.funding_rate = value_number(&derivatives, "fundingRate");
                block.funding_next_label = derivatives
                    .get("fundingNextMs")
                    .and_then(Value::as_i64)
                    .filter(|at| *at > now)
                    .map(|at| shanghai_label(at, false));
            }
            None => missing.push(format!("{inst_id}:funding")),
        },
        _ => missing.push(format!("{inst_id}:funding")),
    }
    // 仓位参考：按 1×ATR(1h) 止损，单笔风险预算内最多几张（与风控官同一个计算）。
    if let (Some(last), Some(atr_1h), Some(equity)) = (block.last, block.atr_1h, equity) {
        if let Some(instrument) = instrument.as_ref() {
            let stop = last - atr_1h;
            if stop > 0.0 {
                let sizing = desic_trade_domain::AiSizingInputs {
                    entry_price: format!("{last}"),
                    stop_price: format!("{stop}"),
                    contract_value: instrument.ct_val.clone(),
                    entry_fee_rate: BRIEFING_ASSUMED_TAKER_FEE.to_string(),
                    exit_fee_rate: BRIEFING_ASSUMED_TAKER_FEE.to_string(),
                    min_size: instrument.min_sz.clone(),
                    lot_size: instrument.lot_sz.clone(),
                };
                block.sizing = desic_trade_domain::max_size_within_budget(&sizing, equity, risk_pct).map(|(size, too_small)| {
                    if too_small {
                        BriefingSizing::AccountTooSmall { stop_distance: atr_1h }
                    } else {
                        BriefingSizing::MaxContracts { stop_distance: atr_1h, contracts: number(&size).unwrap_or(0.0) }
                    }
                });
                block.contract_label = Some(if chinese {
                    format!("每张 {} {}，最小 {} 张", instrument.ct_val, instrument.ct_val_ccy, instrument.min_sz)
                } else {
                    format!("{} {} per contract, min {}", instrument.ct_val, instrument.ct_val_ccy, instrument.min_sz)
                });
            }
        }
    }
    block
}

/// 生成交易员简报。任何一块拿不到都不会报错，只在简报里标「不可用」并记进审计。
pub(crate) async fn build_profile_briefing(app: &tauri::AppHandle, profile: &AiAgentProfileSummary, chinese: bool) -> ProfileBriefing {
    let started = now_ms();
    let deadline = started + BRIEFING_DEADLINE_MS;
    let market = app.state::<MarketRuntime>().inner().clone();
    let symbols = profile.symbols.iter().take(BRIEFING_MAX_SYMBOLS).cloned().collect::<Vec<_>>();
    let mut missing: Vec<String> = Vec::new();

    let db = read_db_facts(app, profile, &symbols, started, chinese);
    let account = match within(deadline, read_account_snapshot(app, &market, profile.account_id.as_deref())).await.flatten() {
        Some(snapshot) => Some(account_block(&snapshot, now_ms(), chinese, &db.owners, &profile.id)),
        None => {
            missing.push("account".to_string());
            None
        }
    };
    let equity = account.as_ref().and_then(|account| account.equity_usdt);
    let limits = profile.risk.limits();
    let budget = BriefingBudget {
        risk_per_trade_pct: limits.risk_per_trade_pct,
        risk_per_trade_usdt: equity.map(|equity| equity * limits.risk_per_trade_pct / 100.0),
        min_reward_risk: limits.min_reward_risk,
        daily_loss_limit_pct: limits.daily_loss_limit_pct,
        today_realized_pnl: db.today_realized_pnl,
        // 熔断条件是「今日已实现 ≤ −权益×日亏线」，所以还能亏 = 权益×日亏线 + 今日已实现。
        remaining_daily_loss_usdt: match (equity, db.today_realized_pnl) {
            (Some(equity), Some(pnl)) => Some((equity * limits.daily_loss_limit_pct / 100.0 + pnl).max(0.0)),
            _ => None,
        },
        open_exposure: db.open_exposure,
        max_open_positions: limits.max_open_positions,
    };
    let mut symbol_blocks = Vec::new();
    for inst_id in &symbols {
        let facts = db.per_symbol.get(inst_id).cloned().unwrap_or_default();
        symbol_blocks.push(
            symbol_block(app, &market, inst_id, facts, equity, limits.risk_per_trade_pct, deadline, chinese, &mut missing).await,
        );
    }
    // 成绩单（交易员决策的历史结果）：按第一个关注品种当前的日线阶段挑相关分组。
    let current_regime = symbol_blocks.first().and_then(|symbol| symbol.regime_daily.clone());
    let scorecard = crate::ai_automation::open_automation_database(app)
        .ok()
        .map(|conn| crate::trader_learning::scorecard_brief(&conn, &profile.id, current_regime.as_deref(), now_ms(), chinese));
    let doc = BriefingDoc {
        generated_at_label: shanghai_label(started, true),
        account,
        budget: Some(budget),
        symbols: symbol_blocks,
        opportunities: db.opportunities,
        recent_runs: db.recent_runs,
        wake_conditions: db.wake_conditions,
        events: db.events,
        scorecard,
    };
    // 行情阶段标签（代码计算）随审计存档：决策日志与开仓形态校验都按它分组 / 匹配。
    let regimes = doc
        .symbols
        .iter()
        .map(|symbol| {
            let four_hour = symbol.timeframes.iter().find(|frame| frame.label == "4h").and_then(|frame| frame.trend.clone());
            (symbol.inst_id.clone(), json!({ "daily": symbol.regime_daily, "h4": four_hour, "volatility": symbol.regime }))
        })
        .collect::<serde_json::Map<String, Value>>();
    let text = desic_agent_automation::render_briefing(&doc, chinese, desic_agent_automation::BRIEFING_MAX_CHARS);
    let build_ms = now_ms().saturating_sub(started);
    ProfileBriefing {
        audit: json!({
            "chars": text.chars().count(),
            "buildMs": build_ms,
            "missing": missing,
            "timedOut": now_ms() >= deadline,
            "regimes": regimes,
        }),
        text,
    }
}

/// Profile 配置页「按当前账户换算」需要的事实：绑定账户的权益 / 可用 / 今日已实现，以及每个关注品种的价格、
/// 合约面值、最小张数、张数步长与 1h ATR。具体张数、金额由前端按正在编辑的参数实时计算（`src/lib/riskPreview.ts`）。
#[tauri::command]
pub(crate) async fn ai_profile_risk_facts(app: tauri::AppHandle, account_id: Option<String>, symbols: Vec<String>) -> Result<Value, String> {
    let now = now_ms();
    let market = app.state::<MarketRuntime>().inner().clone();
    let account_id = account_id.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    let (account, account_error) = match account_id.as_deref() {
        None => (None, None),
        Some(account_id) => match read_account_snapshot(&app, &market, Some(account_id)).await {
            Some(snapshot) => (Some(snapshot), None),
            None => (None, Some("读不到账户快照（账户未连接或 API 不可用）".to_string())),
        },
    };
    let usdt = account
        .as_ref()
        .and_then(|snapshot| snapshot.balances.iter().find(|balance| balance.ccy.eq_ignore_ascii_case("USDT")).cloned());
    let today_realized_pnl = match account_id.as_deref() {
        Some(account_id) => {
            let app = app.clone();
            let account_id = account_id.to_string();
            crate::blocking_work::run_blocking(move || {
                let conn = open_read_database(&app)?;
                Ok::<_, String>(crate::ai_risk_gate::account_realized_pnl_today(&conn, Some(&account_id), now))
            })
            .await
            .ok()
            .flatten()
        }
        None => None,
    };
    let mut rows = Vec::new();
    for inst_id in symbols.iter().map(|value| value.trim().to_ascii_uppercase()).filter(|value| !value.is_empty()).take(BRIEFING_MAX_SYMBOLS) {
        let instrument = crate::trade_support::fetch_instrument(&app, &inst_id).await.ok();
        let last = match ai_read_ticker(&market, &inst_id).await {
            Ok(ticker) => crate::fastlane::normalize_ticker_block(&ticker, &[]).and_then(|(price, _)| value_number(&price, "last")),
            Err(_) => None,
        };
        let atr_1h = {
            let app = app.clone();
            let inst = inst_id.clone();
            crate::blocking_work::run_blocking(move || {
                let conn = open_read_database(&app)?;
                let bars = local_candles_aggregated(&conn, &inst, HOUR_MS, now - 3 * DAY_MS, now)
                    .map(|(candles, _)| {
                        candles
                            .into_iter()
                            .map(|candle| crate::fastlane::Bar { t: candle.time * 1000, o: candle.open, h: candle.high, l: candle.low, c: candle.close, v: candle.volume })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                Ok::<_, String>(crate::fastlane::atr14(&bars))
            })
            .await
            .ok()
            .flatten()
        };
        rows.push(json!({
            "instId": inst_id,
            "last": last,
            "ctVal": instrument.as_ref().and_then(|item| number(&item.ct_val)),
            "ctValCcy": instrument.as_ref().map(|item| item.ct_val_ccy.clone()),
            "minSz": instrument.as_ref().and_then(|item| number(&item.min_sz)),
            "lotSz": instrument.as_ref().and_then(|item| number(&item.lot_sz)),
            "atr1h": atr_1h,
        }));
    }
    Ok(json!({
        "accountId": account_id,
        "accountError": account_error,
        "equityUsdt": usdt.as_ref().and_then(|balance| number(&balance.eq)),
        "availableUsdt": usdt.as_ref().and_then(|balance| number(&balance.avail_eq).or_else(|| number(&balance.avail_bal))),
        "snapshotAgeSeconds": account.as_ref().map(|snapshot| now.saturating_sub(snapshot.synced_at).max(0) / 1000),
        "todayRealizedPnl": today_realized_pnl,
        "assumedTakerFeePct": 0.05,
        "symbols": rows,
    }))
}

/// 「两种模式对比」的一行：按模式汇总所选时间范围内的运行与交易结果。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModeComparisonRow {
    pub mode: String,
    pub runs: u32,
    pub failed_runs: u32,
    pub median_input_tokens: Option<u64>,
    pub median_total_tokens: Option<u64>,
    pub median_duration_ms: Option<i64>,
    pub opportunities_created: u32,
    pub opportunities_executed: u32,
    pub closed_trades: u32,
    /// 已平仓交易的净盈亏合计（含手续费与资金费）；没有已平仓交易时为 `None`。
    pub net_pnl: Option<f64>,
}

fn median<T: Copy + Ord>(values: &mut [T]) -> Option<T> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    Some(values[values.len() / 2])
}

/// 按模式汇总 `[from_ms, to_ms]` 内开始的 AI 运行（不含快判）。逐 Profile 走 `(profile_id, started_at)` 索引，
/// 不整表扫描（运行表的快照列很大）。
pub(crate) fn mode_comparison(conn: &Connection, from_ms: i64, to_ms: i64) -> Result<Vec<ModeComparisonRow>, String> {
    if to_ms < from_ms {
        return Err("时间范围无效：结束时间早于开始时间".to_string());
    }
    let profile_ids = {
        let mut stmt = conn.prepare("SELECT DISTINCT profile_id FROM ai_agent_runs").map_err(|err| err.to_string())?;
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        ids
    };
    let mut stmt = conn
        .prepare(
            "SELECT id,context_mode,status,token_usage_json,started_at,finished_at FROM ai_agent_runs
             WHERE profile_id=?1 AND started_at>=?2 AND started_at<=?3 AND record_kind<>'fastlane'",
        )
        .map_err(|err| err.to_string())?;
    struct RunFact {
        mode: String,
        failed: bool,
        input_tokens: Option<u64>,
        total_tokens: Option<u64>,
        duration_ms: Option<i64>,
    }
    let mut runs: HashMap<String, RunFact> = HashMap::new();
    for profile_id in &profile_ids {
        let rows = stmt
            .query_map(params![profile_id, from_ms, to_ms], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                ))
            })
            .map_err(|err| err.to_string())?;
        for row in rows {
            let (id, mode, status, usage, started_at, finished_at) = row.map_err(|err| err.to_string())?;
            let usage = usage.and_then(|text| serde_json::from_str::<Value>(&text).ok());
            let tokens = |key: &str| {
                usage
                    .as_ref()
                    .and_then(|value| value.pointer(&format!("/usage/{key}")))
                    .and_then(Value::as_u64)
                    .filter(|value| *value > 0)
            };
            runs.insert(
                id,
                RunFact {
                    mode: crate::ai_automation::normalize_context_mode(mode.as_deref().unwrap_or_default()),
                    failed: status == "failed",
                    input_tokens: tokens("inputTokens"),
                    total_tokens: tokens("totalTokens"),
                    duration_ms: finished_at
                        .filter(|_| status == "completed")
                        .map(|finished| finished.saturating_sub(started_at))
                        .filter(|value| *value >= 0),
                },
            );
        }
    }
    let mut opportunities: HashMap<String, (u32, u32)> = HashMap::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT agent_run_id,status FROM trade_opportunities
                 WHERE agent_run_id IS NOT NULL AND created_at>=?1",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![from_ms], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|err| err.to_string())?;
        for row in rows {
            let (run_id, status) = row.map_err(|err| err.to_string())?;
            if let Some(run) = runs.get(&run_id) {
                let entry = opportunities.entry(run.mode.clone()).or_default();
                entry.0 += 1;
                if status == "executed" {
                    entry.1 += 1;
                }
            }
        }
    }
    let mut closed: HashMap<String, (u32, f64)> = HashMap::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT e.id,o.agent_run_id,CAST(e.net_pnl AS REAL) FROM position_episodes e
                 JOIN position_episode_opportunities p ON p.episode_id=e.id
                 JOIN trade_opportunities o ON o.id=p.opportunity_id
                 WHERE e.status='closed' AND o.intent='open' AND o.agent_run_id IS NOT NULL AND o.created_at>=?1",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![from_ms], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<f64>>(2)?))
            })
            .map_err(|err| err.to_string())?;
        let mut seen = HashSet::new();
        for row in rows {
            let (episode_id, run_id, net_pnl) = row.map_err(|err| err.to_string())?;
            let Some(run) = runs.get(&run_id) else { continue };
            if !seen.insert(episode_id) {
                continue;
            }
            let entry = closed.entry(run.mode.clone()).or_default();
            entry.0 += 1;
            entry.1 += net_pnl.unwrap_or(0.0);
        }
    }
    let mut result = Vec::new();
    for mode in [crate::ai_automation::CONTEXT_MODE_TOOLS, crate::ai_automation::CONTEXT_MODE_BRIEFING] {
        let facts = runs.values().filter(|run| run.mode == mode).collect::<Vec<_>>();
        if facts.is_empty() {
            continue;
        }
        let mut inputs = facts.iter().filter_map(|run| run.input_tokens).collect::<Vec<_>>();
        let mut totals = facts.iter().filter_map(|run| run.total_tokens).collect::<Vec<_>>();
        let mut durations = facts.iter().filter_map(|run| run.duration_ms).collect::<Vec<_>>();
        let (created, executed) = opportunities.get(mode).copied().unwrap_or_default();
        let (closed_trades, net_pnl) = closed.get(mode).copied().unwrap_or_default();
        result.push(ModeComparisonRow {
            mode: mode.to_string(),
            runs: facts.len() as u32,
            failed_runs: facts.iter().filter(|run| run.failed).count() as u32,
            median_input_tokens: median(&mut inputs),
            median_total_tokens: median(&mut totals),
            median_duration_ms: median(&mut durations),
            opportunities_created: created,
            opportunities_executed: executed,
            closed_trades,
            net_pnl: (closed_trades > 0).then_some(net_pnl),
        });
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn ai_automation_mode_comparison(
    app: tauri::AppHandle,
    from_ms: i64,
    to_ms: i64,
) -> Result<Vec<ModeComparisonRow>, String> {
    crate::blocking_work::run_blocking(move || {
        let conn = open_read_database(&app)?;
        mode_comparison(&conn, from_ms, to_ms)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_names_are_real_tools_and_heavy_reads_are_excluded() {
        // 名单里的每个名字都必须是侧车 / 工具策略里真实存在的工具名，否则白名单会把模型需要的工具静默挡掉。
        let sidecar = include_str!("../../scripts/cline-sidecar.mjs");
        let policy = include_str!("../../scripts/cline-tool-policy.mjs");
        for name in BRIEFING_TOOL_ALLOWLIST {
            let quoted = format!("\"{name}\"");
            assert!(sidecar.contains(&quoted) || policy.contains(&quoted), "{name} 不是已知工具");
        }
        for excluded in [
            "tradeOpportunity.list",
            "account.readRisk",
            "account.readPositions",
            "account.readOpenOrders",
            "intelligence.smartMoney.readDerivativeDecisionContext",
            "intelligence.news.list",
            "radar.readRanking",
            "background.reportTriage",
            "agent.list",
            "tradeOpportunity.get",
        ] {
            assert!(!BRIEFING_TOOL_ALLOWLIST.contains(&excluded), "{excluded} 不应在交易员模式白名单里");
        }
        assert!(BRIEFING_TOOL_ALLOWLIST.contains(&"background.finishRun"), "必须能结束本轮");
    }

    fn intelligence_tables() -> Connection {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch(
            "CREATE TABLE intelligence_derivatives_snapshots (inst_id TEXT, bucket_at INTEGER, granularity TEXT, oi_usd REAL);
             CREATE TABLE intelligence_derivatives_flows (inst_id TEXT, bucket_at INTEGER, granularity TEXT, buy_volume REAL, sell_volume REAL);
             CREATE TABLE intelligence_liquidation_samples (inst_id TEXT, side TEXT, event_at INTEGER);",
        )
        .expect("schema");
        conn
    }

    #[test]
    fn symbol_db_facts_compute_changes_from_fresh_data_only() {
        let conn = intelligence_tables();
        let now = 1_791_200_000_000_i64;
        let hour = 60 * 60_000;
        for (at, oi) in [(now - 26 * hour, 900.0), (now - 24 * hour - 5 * 60_000, 1_000.0), (now - hour - 5 * 60_000, 1_100.0), (now - 5 * 60_000, 1_210.0)] {
            conn.execute(
                "INSERT INTO intelligence_derivatives_snapshots VALUES ('BTC-USDT-SWAP',?1,'5m',?2)",
                params![at, oi],
            )
            .unwrap();
        }
        conn.execute("INSERT INTO intelligence_derivatives_flows VALUES ('BTC-USDT-SWAP',?1,'5m',600,400)", params![now - 10 * 60_000]).unwrap();
        conn.execute("INSERT INTO intelligence_derivatives_flows VALUES ('BTC-USDT-SWAP',?1,'5m',999,1)", params![now - 2 * hour]).unwrap();
        let facts = read_symbol_db_facts(&conn, "BTC-USDT-SWAP", now, true);
        assert!((facts.oi_change_1h_pct.unwrap() - 10.0).abs() < 1e-9, "{:?}", facts.oi_change_1h_pct);
        assert!((facts.oi_change_24h_pct.unwrap() - 21.0).abs() < 1e-9, "{:?}", facts.oi_change_24h_pct);
        assert!((facts.taker_buy_ratio_1h.unwrap() - 0.6).abs() < 1e-9, "只算最近 1 小时");
        // 一小时内没有爆仓样本：无法区分「没有」与「没采集」，按不可用。
        assert_eq!(facts.liquidations_1h, None);
        conn.execute("INSERT INTO intelligence_liquidation_samples VALUES ('BTC-USDT-SWAP','sell',?1)", params![now - 60_000]).unwrap();
        conn.execute("INSERT INTO intelligence_liquidation_samples VALUES ('BTC-USDT-SWAP','sell',?1)", params![now - 120_000]).unwrap();
        conn.execute("INSERT INTO intelligence_liquidation_samples VALUES ('BTC-USDT-SWAP','buy',?1)", params![now - 180_000]).unwrap();
        assert_eq!(read_symbol_db_facts(&conn, "BTC-USDT-SWAP", now, true).liquidations_1h, Some((2, 1)));
        // 本地衍生品数据超过 30 分钟没更新：不拿旧数算变化。
        let stale = read_symbol_db_facts(&conn, "BTC-USDT-SWAP", now + 2 * hour, true);
        assert_eq!(stale.oi_change_1h_pct, None);
        assert_eq!(stale.oi_change_24h_pct, None);
        assert_eq!(stale.taker_buy_ratio_1h, None);
        // 雷达表不存在时不报错，只是没有这一行。
        assert_eq!(stale.radar_line, None);
    }

    #[test]
    fn profile_memory_lists_recent_opportunities_and_wake_conditions_compactly() {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch(
            "CREATE TABLE trade_opportunities (id TEXT, intent TEXT, direction TEXT, inst_id TEXT, price TEXT,
               stop_loss_json TEXT, take_profit_json TEXT, status TEXT, agent_profile_id TEXT, created_at INTEGER);
             CREATE TABLE okx_orders (opportunity_id TEXT, state TEXT);
             CREATE TABLE ai_wake_conditions (profile_id TEXT, source TEXT, condition_type TEXT, config_json TEXT, status TEXT, created_at INTEGER);",
        )
        .unwrap();
        let now = 1_791_200_000_000_i64;
        conn.execute(
            "INSERT INTO trade_opportunities VALUES ('opp1','open','long','BTC-USDT-SWAP','84750',
               '{\"kind\":\"stop_loss\",\"triggerPx\":\"84450\"}','{\"kind\":\"take_profit\",\"triggerPx\":\"85300\"}','executed','p1',?1)",
            params![now - 60_000],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO trade_opportunities VALUES ('old','open','long','BTC-USDT-SWAP','80000',NULL,NULL,'executed','p1',?1)",
            params![now - 2 * BRIEFING_MEMORY_WINDOW_MS],
        )
        .unwrap();
        conn.execute("INSERT INTO trade_opportunities VALUES ('other','open','short','ETH-USDT-SWAP','1',NULL,NULL,'pending','p2',?1)", params![now]).unwrap();
        conn.execute("INSERT INTO okx_orders VALUES ('opp1','live')", []).unwrap();
        let items = read_recent_opportunities(&conn, "p1", now, true);
        assert_eq!(items.len(), 1, "只看本 Profile 最近 24 小时");
        assert_eq!(items[0].title, "开多 BTC-USDT-SWAP");
        assert_eq!(items[0].stop, Some(84_450.0));
        assert_eq!(items[0].take_profit, Some(85_300.0));
        assert_eq!(items[0].status, "executed / 委托 live");

        conn.execute(
            "INSERT INTO ai_wake_conditions VALUES ('p1','user','price_cross','{\"instId\":\"BTC-USDT-SWAP\",\"direction\":\"down\",\"price\":84504}','active',1)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO ai_wake_conditions VALUES ('p1','agent','timer','{\"intervalMinutes\":30}','cancelled',2)", []).unwrap();
        let wakes = read_wake_conditions(&conn, "p1", true);
        assert_eq!(wakes, vec!["BTC-USDT-SWAP 价格下穿 84504（用户设置）".to_string()]);
        conn.execute(
            "INSERT INTO ai_wake_conditions VALUES ('p1','agent','order_state_changed','{\"accountId\":\"acc-1\",\"instId\":\"BTC-USDT-SWAP\",\"type\":\"order_state_changed\"}','active',3)",
            [],
        )
        .unwrap();
        let wakes = read_wake_conditions(&conn, "p1", true);
        assert_eq!(wakes[0], "委托状态变化 BTC-USDT-SWAP（AI 设置）");
        assert!(wakes.iter().all(|line| !line.contains("acc-1")), "不把账户 ID 写进简报");
    }

    #[test]
    fn mode_comparison_splits_runs_tokens_and_closed_trades_by_mode() {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch(
            "CREATE TABLE ai_agent_runs (id TEXT, profile_id TEXT, context_mode TEXT, status TEXT, token_usage_json TEXT,
               started_at INTEGER, finished_at INTEGER, record_kind TEXT);
             CREATE TABLE trade_opportunities (id TEXT, agent_run_id TEXT, status TEXT, intent TEXT, created_at INTEGER);
             CREATE TABLE position_episodes (id TEXT, status TEXT, net_pnl TEXT);
             CREATE TABLE position_episode_opportunities (episode_id TEXT, opportunity_id TEXT);",
        )
        .unwrap();
        let usage = |input: u64| format!("{{\"usage\":{{\"inputTokens\":{input},\"totalTokens\":{}}}}}", input + 100);
        for (id, mode, status, input, start, finish) in [
            ("r1", "tools", "completed", 2_000_000, 1_000, 241_000),
            ("r2", "tools", "failed", 1_000_000, 2_000, 3_000),
            ("r3", "briefing", "completed", 200_000, 3_000, 43_000),
            ("r4", "briefing", "completed", 100_000, 4_000, 24_000),
            ("r5", "briefing", "completed", 300_000, 5_000, 65_000),
        ] {
            conn.execute(
                "INSERT INTO ai_agent_runs VALUES (?1,'p1',?2,?3,?4,?5,?6,'ai')",
                params![id, mode, status, usage(input), start, finish],
            )
            .unwrap();
        }
        conn.execute("INSERT INTO ai_agent_runs VALUES ('old','p1','briefing','completed',NULL,1,2,'ai')", []).unwrap();
        conn.execute("INSERT INTO ai_agent_runs VALUES ('fl','p1','tools','completed',NULL,6000,7000,'fastlane')", []).unwrap();
        conn.execute_batch(
            "INSERT INTO trade_opportunities VALUES ('o1','r3','executed','open',3500),('o2','r4','failed','open',4500),('o3','r1','executed','open',1500);
             INSERT INTO position_episodes VALUES ('e1','closed','-1.5'),('e2','closed','2.0'),('e3','open','9.0');
             INSERT INTO position_episode_opportunities VALUES ('e1','o3'),('e2','o1'),('e3','o1');",
        )
        .unwrap();
        let rows = mode_comparison(&conn, 1_000, 10_000).expect("comparison");
        assert_eq!(rows.len(), 2);
        let tools = &rows[0];
        assert_eq!((tools.mode.as_str(), tools.runs, tools.failed_runs), ("tools", 2, 1));
        assert_eq!(tools.median_duration_ms, Some(240_000), "失败的运行不计耗时");
        assert_eq!((tools.opportunities_created, tools.opportunities_executed, tools.closed_trades), (1, 1, 1));
        assert_eq!(tools.net_pnl, Some(-1.5));
        let briefing = &rows[1];
        assert_eq!((briefing.mode.as_str(), briefing.runs), ("briefing", 3), "范围外与快判运行不计入");
        assert_eq!(briefing.median_input_tokens, Some(200_000));
        assert_eq!(briefing.median_duration_ms, Some(40_000));
        assert_eq!((briefing.opportunities_created, briefing.opportunities_executed), (2, 1));
        assert_eq!((briefing.closed_trades, briefing.net_pnl), (1, Some(2.0)), "未平仓的不计入");
    }

    #[test]
    fn order_and_position_owners_are_labelled() {
        let mut owners = Owners::default();
        owners.names.insert("classic".into(), "经典".into());
        owners.orders.insert("o-classic".into(), (Some("classic".into()), Some("ai".into())));
        owners.orders.insert("o-mine".into(), (Some("trader".into()), Some("ai".into())));
        owners.orders.insert("o-research".into(), (None, Some("ai".into())));
        owners.orders.insert("o-manual".into(), (None, Some("user".into())));
        assert_eq!(owners.order_label("o-mine", "", false, "trader", true).as_deref(), Some("本 Profile"));
        assert_eq!(owners.order_label("o-classic", "", false, "trader", true).as_deref(), Some("其他 Profile：经典"));
        assert_eq!(owners.order_label("o-research", "", false, "trader", true).as_deref(), Some("AI 研究"));
        assert_eq!(owners.order_label("o-manual", "", false, "trader", true).as_deref(), Some("手动或其他来源"));
        assert_eq!(owners.order_label("unknown", "", false, "trader", true).as_deref(), Some("手动或其他来源"));
        // 附挂的只减仓保护单对不上 Profile 时不标（跟着持仓走）；对得上就照常标。
        assert_eq!(owners.order_label("o-manual", "", true, "trader", true), None);
        assert_eq!(owners.order_label("x", "o-mine", true, "trader", true).as_deref(), Some("本 Profile"));
    }

    #[test]
    fn book_levels_accept_memory_objects_and_rest_arrays_and_convert_contracts_to_coin() {
        let memory = json!({
            "bids": [{"px": "85000", "sz": "100", "orders": "3"}],
            "asks": [{"px": "85001", "sz": "50", "orders": "1"}]
        });
        let book = book_levels_in_coin(&memory, Some(0.01)).expect("memory book");
        assert_eq!(book["bids"][0], json!([85000.0, 1.0]));
        assert_eq!(book["asks"][0], json!([85001.0, 0.5]));
        let micro = crate::fastlane::micro_from_orderbook(&book, Some(0.0)).expect("micro");
        // 深度金额 = (1 + 0.5) BTC × 价格，而不是把 150 张当成 150 BTC。
        assert!((micro.depth_5bps_usd.unwrap() - (85_000.0 + 0.5 * 85_001.0)).abs() < 1e-6);
        let rest = json!({ "bids": [["85000", "100", "0", "3"]], "asks": [["85001", "50", "0", "1"]] });
        assert_eq!(book_levels_in_coin(&rest, Some(0.01)).unwrap()["bids"][0], json!([85000.0, 1.0]));
        assert!(book_levels_in_coin(&memory, None).is_none(), "面值未知时不拿张数冒充币数");
    }

    #[test]
    fn events_keep_symbol_related_or_multi_source_news_only() {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch(
            "CREATE TABLE intelligence_news_events (title TEXT, coins_json TEXT, source_count INTEGER, importance TEXT, last_published_at INTEGER);",
        )
        .unwrap();
        let now = 1_791_200_000_000_i64;
        for (title, coins, sources, importance, ago_min) in [
            ("Open-source model released", "[]", 0, "high", 10),
            ("Trader says alts will run", "[]", 1, "high", 20),
            ("US CPI hotter than expected", "[]", 3, "high", 30),
            ("BTC ETF outflows", "[\"BTC\"]", 1, "high", 40),
            ("SOL network upgrade", "[\"SOL\"]", 4, "high", 50),
            ("BTC minor note", "[\"BTC\"]", 1, "medium", 60),
            ("Old BTC news", "[\"BTC\"]", 5, "high", 400),
        ] {
            conn.execute(
                "INSERT INTO intelligence_news_events VALUES (?1,?2,?3,?4,?5)",
                params![title, coins, sources, importance, now - ago_min * 60_000],
            )
            .unwrap();
        }
        let titles = read_relevant_events(&conn, &["BTC-USDT-SWAP".to_string()], now)
            .into_iter()
            .map(|note| note.text)
            .collect::<Vec<_>>();
        assert_eq!(titles, vec!["US CPI hotter than expected".to_string(), "BTC ETF outflows".to_string()]);
    }
}
