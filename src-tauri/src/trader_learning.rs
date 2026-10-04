//! 交易员 Profile 的学习闭环编排（只作用于交易员 Profile，经典 AI Profile 不经过这里）。
//!
//! 阶段 A：交易手册的存储与版本、交易员运行的技能载荷（固定规范替换 + 技能过滤）、开仓形态标签校验。
//! 阶段 B：决策日志落库、影子记账（按 1m K 线结算每条决策，包括没执行的候选）、真实结果关联、成绩单。
//! 纯逻辑在 `desic_agent_automation`（手册、规范、行情阶段）；这里只做存库与编排。

use super::*;
use desic_agent_automation::{Handbook, TRADER_CORE_NAME, TRADER_CORE_RULES};

/// 交易员运行里不再下发的技能：交易哲学被手册取代；情报 / 雷达对应的工具在交易员模式不可用；
/// 交易员模式不点名专家，不需要调度规范。
pub(crate) const TRADER_EXCLUDED_SKILLS: [&str; 4] = [
    "trading-philosophy",
    "okx-market-intelligence",
    "market-radar-research",
    "desic-agent-orchestration",
];

pub(crate) fn migrate_trader_learning(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_trader_handbooks (
           version INTEGER PRIMARY KEY,
           status TEXT NOT NULL,
           content_json TEXT NOT NULL,
           parent_version INTEGER,
           source_suggestion_id TEXT,
           note TEXT,
           created_at INTEGER NOT NULL,
           published_at INTEGER
         );",
    )
    .map_err(|err| err.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_trader_decisions (
           id TEXT PRIMARY KEY,
           run_id TEXT NOT NULL,
           profile_id TEXT NOT NULL,
           inst_id TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           handbook_version INTEGER,
           regime_daily TEXT,
           regime_4h TEXT,
           volatility TEXT,
           setup_id TEXT,
           side TEXT,
           action TEXT NOT NULL,
           entry REAL,
           stop REAL,
           target REAL,
           probability REAL,
           valid_until INTEGER,
           reason TEXT,
           considered INTEGER NOT NULL DEFAULT 0,
           opportunity_id TEXT,
           against_direction INTEGER NOT NULL DEFAULT 0,
           regime_mismatch INTEGER NOT NULL DEFAULT 0,
           shadow_status TEXT NOT NULL,
           shadow_note TEXT,
           shadow_r REAL,
           shadow_mfe_r REAL,
           shadow_mae_r REAL,
           exit_kind TEXT,
           filled_at INTEGER,
           resolved_at INTEGER,
           real_episode_id TEXT,
           real_r REAL
         );
         CREATE INDEX IF NOT EXISTS idx_ai_trader_decisions_profile ON ai_trader_decisions(profile_id, created_at);
         CREATE INDEX IF NOT EXISTS idx_ai_trader_decisions_pending ON ai_trader_decisions(shadow_status, created_at);
         CREATE INDEX IF NOT EXISTS idx_ai_trader_decisions_run ON ai_trader_decisions(run_id);",
    )
    .map_err(|err| err.to_string())?;
    let existing: i64 = conn
        .query_row("SELECT COUNT(*) FROM ai_trader_handbooks", [], |row| row.get(0))
        .map_err(|err| err.to_string())?;
    if existing == 0 {
        let now = now_ms();
        conn.execute(
            "INSERT INTO ai_trader_handbooks (version,status,content_json,parent_version,source_suggestion_id,note,created_at,published_at)
             VALUES (1,'published',?1,NULL,NULL,'内置 v1',?2,?2)",
            params![
                serde_json::to_string(&desic_agent_automation::default_handbook()).map_err(|err| err.to_string())?,
                now
            ],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

/// 当前生效的手册（最新已发布版本）。库里读不到或内容损坏时退回内置 v1，保证交易员运行不因手册缺失而失败。
pub(crate) fn current_handbook(conn: &Connection) -> (i64, Handbook) {
    conn.query_row(
        "SELECT version,content_json FROM ai_trader_handbooks WHERE status='published' ORDER BY version DESC LIMIT 1",
        [],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
    )
    .ok()
    .and_then(|(version, content)| {
        serde_json::from_str::<Handbook>(&content)
            .ok()
            .filter(|handbook| desic_agent_automation::validate_handbook(handbook).is_ok())
            .map(|handbook| (version, handbook))
    })
    .unwrap_or_else(|| (1, desic_agent_automation::default_handbook()))
}

/// 交易员运行的技能载荷：替换固定规范正文、去掉不适用的技能。只在交易员分支调用；经典运行不经过这里。
pub(crate) fn apply_trader_skills(
    definitions: &mut Vec<desic_storage_config::AiSkillDefinition>,
    enabled_skills: &mut Vec<String>,
    decision_log: bool,
) {
    definitions.retain(|definition| !TRADER_EXCLUDED_SKILLS.contains(&definition.id.as_str()));
    enabled_skills.retain(|id| !TRADER_EXCLUDED_SKILLS.contains(&id.as_str()));
    for definition in definitions.iter_mut() {
        if definition.id == "desic-core-operations" {
            definition.name = TRADER_CORE_NAME.to_string();
            definition.rules = TRADER_CORE_RULES.to_string();
            definition.content = desic_agent_automation::trader_core_operations(decision_log);
        }
    }
}

/// 交易员运行的开仓候选形态校验：`setupId` 必须存在、属于当前手册，且没有被用户暂停。
/// `regime` 是本轮简报里由代码算出的日线阶段（用于匹配限定了阶段的暂停条目）。只对交易员运行的开仓调用。
pub(crate) fn trader_setup_reasons(handbook: &Handbook, setup_id: Option<&str>, regime: Option<&str>, side: &str) -> Vec<String> {
    let available = handbook.setups.iter().map(|setup| setup.id.as_str()).collect::<Vec<_>>().join(", ");
    let Some(setup_id) = setup_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return vec![format!("setup_required：交易员 Profile 的开仓候选必须带 setupId（交易手册形态之一：{available}）")];
    };
    if desic_agent_automation::find_setup(handbook, setup_id).is_none() {
        return vec![format!("setup_unknown：{setup_id} 不是交易手册里的形态（可用：{available}）")];
    }
    match desic_agent_automation::paused_entry(handbook, setup_id, regime, side) {
        Some(entry) => vec![format!("setup_paused：{setup_id} 已被用户暂停（{}）", entry.reason)],
        None => Vec::new(),
    }
}

/// 这次运行是不是交易员 Profile 的运行（入队时冻结的 `ai_agent_runs.context_mode`）。读不到按经典处理。
pub(crate) fn run_is_trader(conn: &Connection, run_id: &str) -> bool {
    conn.query_row("SELECT context_mode FROM ai_agent_runs WHERE id=?1", params![run_id], |row| row.get::<_, Option<String>>(0))
        .ok()
        .flatten()
        .is_some_and(|mode| mode == crate::ai_automation::CONTEXT_MODE_BRIEFING)
}

/// 交易员运行的开仓候选形态校验（读库版）：经典运行或非开仓直接返回空。
pub(crate) fn trader_open_setup_reasons(conn: &Connection, run_id: &str, inst_id: &str, intent: &str, direction: &str, setup_id: Option<&str>) -> Vec<String> {
    if intent != "open" || !run_is_trader(conn, run_id) {
        return Vec::new();
    }
    let (_, handbook) = current_handbook(conn);
    let regime = run_daily_regime(conn, run_id, inst_id);
    trader_setup_reasons(&handbook, setup_id, regime.as_deref(), direction)
}

/// 本轮简报里由代码算出的某品种日线阶段（写在 `initial_market_snapshot_json.briefing.regimes`）。
pub(crate) fn run_daily_regime(conn: &Connection, run_id: &str, inst_id: &str) -> Option<String> {
    let snapshot: String = conn
        .query_row(
            "SELECT initial_market_snapshot_json FROM ai_agent_runs WHERE id=?1",
            params![run_id],
            |row| row.get(0),
        )
        .ok()?;
    serde_json::from_str::<Value>(&snapshot)
        .ok()?
        .pointer(&format!("/briefing/regimes/{}/daily", inst_id.replace('/', "~1")))
        .and_then(Value::as_str)
        .map(str::to_string)
}

// ===================== 阶段 B：决策日志、影子记账、成绩单 =====================

/// 往返手续费（占名义价值 %）：按常见吃单费率估算，影子与真实结果用同一口径换算成 R。
const ROUND_TRIP_FEE_PCT: f64 = 0.1;
/// 限价候选缺省有效期与最长持有时间。
const DEFAULT_VALID_MS: i64 = 24 * 60 * 60_000;
const MAX_VALID_MS: i64 = 7 * 24 * 60 * 60_000;
const MAX_HOLD_MS: i64 = 72 * 60 * 60_000;

fn decision_log_pushback_value() -> Value {
    json!({
        "ok": false,
        "errorCode": "decision_log_required",
        "retryable": true,
        "runEnded": false,
        "pushbackCount": 1,
        "maxPushbacks": 1,
        "warning": "交易员运行收尾必须带 decisionLog：每个评估过的品种一条（setupId、side、action、entry / stop / target、probability、validUntil、reason）；不做时也记下考虑过的最佳候选。本次收尾未落库、运行未结束；这条软校验只会打回一次。",
        "message": "Trader runs must include decisionLog in background.finishRun: one entry per evaluated instrument (setupId, side, action, entry/stop/target, probability, validUntil, reason); for no-trade decisions record the best candidate you considered. Nothing was persisted and the run is still open; this soft check pushes back only once.",
        "nextStep": "call background.finishRun again with decisionLog",
    })
}

/// 交易员运行缺 `decisionLog` 时打回一次（之后照常收尾，缺失如实记为没有日志）。锁中毒时放行。
pub(crate) fn decision_log_pushback(gate: &std::sync::Arc<Mutex<crate::ai_automation::FinishGateState>>, log: &[Value]) -> Option<Value> {
    if !log.is_empty() {
        return None;
    }
    let mut state = gate.lock().ok()?;
    if state.decision_log_pushbacks >= 1 {
        return None;
    }
    state.decision_log_pushbacks += 1;
    Some(decision_log_pushback_value())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecisionLogEntry {
    inst_id: String,
    #[serde(default)]
    setup_id: Option<String>,
    #[serde(default)]
    side: Option<String>,
    action: String,
    #[serde(default)]
    entry: Option<f64>,
    #[serde(default)]
    stop: Option<f64>,
    #[serde(default)]
    target: Option<f64>,
    #[serde(default)]
    probability: Option<f64>,
    #[serde(default)]
    valid_until: Option<i64>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    considered: Option<bool>,
}

fn finite(value: Option<f64>) -> Option<f64> {
    value.filter(|item| item.is_finite() && *item > 0.0)
}

/// 本轮初始快照里的简报审计（行情阶段、手册版本）。
fn run_briefing_audit(conn: &Connection, run_id: &str) -> Value {
    conn.query_row(
        "SELECT initial_market_snapshot_json FROM ai_agent_runs WHERE id=?1",
        params![run_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
    .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    .and_then(|value| value.get("briefing").cloned())
    .unwrap_or(Value::Null)
}

fn handbook_version_content(conn: &Connection, version: Option<i64>) -> Handbook {
    version
        .and_then(|version| {
            conn.query_row(
                "SELECT content_json FROM ai_trader_handbooks WHERE version=?1",
                params![version],
                |row| row.get::<_, String>(0),
            )
            .ok()
        })
        .and_then(|text| serde_json::from_str::<Handbook>(&text).ok())
        .unwrap_or_else(|| current_handbook(conn).1)
}

/// 把交易员运行的决策日志写库（在 finishRun 的同一个事务里）。每个品种最多一条；
/// 行情阶段与手册版本取本轮简报审计（代码计算），开仓机会从本轮持久化记录关联。
pub(crate) fn record_run_decisions(
    conn: &Connection,
    run_id: &str,
    profile_id: &str,
    log: &[Value],
    final_decision_json: Option<&str>,
    now: i64,
) -> Result<usize, String> {
    let audit = run_briefing_audit(conn, run_id);
    let handbook_version = audit.get("handbookVersion").and_then(Value::as_i64);
    let handbook = handbook_version_content(conn, handbook_version);
    let decision = final_decision_json.and_then(|text| serde_json::from_str::<Value>(text).ok()).unwrap_or(Value::Null);
    let opportunity_ids = ["createdOpportunityIds", "reusedOpportunityIds"]
        .iter()
        .filter_map(|key| decision.get(*key).and_then(Value::as_array))
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<Vec<_>>();
    let mut seen = std::collections::HashSet::new();
    let mut written = 0;
    for (index, raw) in log.iter().take(3).enumerate() {
        let Ok(entry) = serde_json::from_value::<DecisionLogEntry>(raw.clone()) else {
            continue;
        };
        let inst_id = entry.inst_id.trim().to_ascii_uppercase();
        if inst_id.is_empty() || !seen.insert(inst_id.clone()) {
            continue;
        }
        let regimes = audit.pointer(&format!("/regimes/{}", inst_id.replace('/', "~1"))).cloned().unwrap_or(Value::Null);
        let regime_daily = regimes.get("daily").and_then(Value::as_str).map(str::to_string);
        let (entry_px, stop_px, target_px) = (finite(entry.entry), finite(entry.stop), finite(entry.target));
        let side = match entry.side.as_deref().map(str::trim) {
            Some("long") => Some("long"),
            Some("short") => Some("short"),
            _ => match (entry_px, stop_px) {
                (Some(entry_px), Some(stop_px)) if stop_px < entry_px => Some("long"),
                (Some(entry_px), Some(stop_px)) if stop_px > entry_px => Some("short"),
                _ => None,
            },
        };
        let setup_id = entry.setup_id.as_deref().map(str::trim).filter(|value| !value.is_empty() && *value != "none").map(str::to_string);
        let setup = setup_id.as_deref().and_then(|id| desic_agent_automation::find_setup(&handbook, id));
        let action = entry.action.trim().to_ascii_lowercase();
        // 方向纪律只评估新的开仓决定；管理已有持仓（可能是更早开的仓）不计入。
        let (against, mismatch) = match side.filter(|_| action != "manage_position") {
            Some(side) => desic_agent_automation::direction_policy_flags(
                setup,
                regime_daily.as_deref().and_then(desic_agent_automation::DailyRegime::parse),
                side == "long",
            ),
            None => (false, false),
        };
        // 影子结算：有完整价位、且不是纯持仓管理的决策都结算（包括「不做 / 等条件」时考虑过的候选）。
        let settleable = action != "manage_position" && side.is_some() && entry_px.is_some() && stop_px.is_some() && target_px.is_some();
        let opportunity_id = if matches!(action.as_str(), "enter_now" | "limit_order") && !opportunity_ids.is_empty() {
            let placeholders = opportunity_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!("SELECT id FROM trade_opportunities WHERE inst_id=? AND intent='open' AND id IN ({placeholders}) ORDER BY created_at DESC LIMIT 1");
            let mut values: Vec<&dyn rusqlite::ToSql> = vec![&inst_id];
            for id in &opportunity_ids {
                values.push(id);
            }
            conn.query_row(&sql, values.as_slice(), |row| row.get::<_, String>(0)).ok()
        } else {
            None
        };
        let valid_until = entry
            .valid_until
            .filter(|value| *value > now)
            .map(|value| value.min(now + MAX_VALID_MS))
            .unwrap_or(now + DEFAULT_VALID_MS);
        conn.execute(
            "INSERT OR REPLACE INTO ai_trader_decisions (
               id,run_id,profile_id,inst_id,created_at,handbook_version,regime_daily,regime_4h,volatility,
               setup_id,side,action,entry,stop,target,probability,valid_until,reason,considered,opportunity_id,
               against_direction,regime_mismatch,shadow_status,shadow_note
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)",
            params![
                format!("decision:{run_id}:{index}"),
                run_id,
                profile_id,
                inst_id,
                now,
                handbook_version,
                regime_daily,
                regimes.get("h4").and_then(Value::as_str),
                regimes.get("volatility").and_then(Value::as_str),
                setup_id,
                side,
                action,
                entry_px,
                stop_px,
                target_px,
                entry.probability.filter(|value| value.is_finite()).map(|value| value.clamp(0.0, 1.0)),
                valid_until,
                entry.reason.map(|text| text.chars().take(300).collect::<String>()),
                i64::from(entry.considered.unwrap_or(settleable)),
                opportunity_id,
                i64::from(against),
                i64::from(mismatch),
                if settleable { "pending" } else { "skipped" },
                (!settleable).then_some(if action == "manage_position" { "持仓管理不做影子结算" } else { "没有完整的方向与价位，不做影子结算" }),
            ],
        )
        .map_err(|err| err.to_string())?;
        written += 1;
    }
    Ok(written)
}

fn shadow_plan(row: &PendingDecision) -> Option<desic_trade_domain::ShadowPlan> {
    Some(desic_trade_domain::ShadowPlan {
        long: row.side.as_deref()? == "long",
        entry_type: if row.action == "enter_now" { desic_trade_domain::ShadowEntry::Market } else { desic_trade_domain::ShadowEntry::Limit },
        entry: row.entry?,
        stop: row.stop?,
        target: row.target?,
        decided_at: row.created_at,
        valid_until: row.valid_until.unwrap_or(row.created_at + DEFAULT_VALID_MS),
        max_hold_ms: MAX_HOLD_MS,
        round_trip_fee_pct: ROUND_TRIP_FEE_PCT,
    })
}

struct PendingDecision {
    id: String,
    inst_id: String,
    created_at: i64,
    side: Option<String>,
    action: String,
    entry: Option<f64>,
    stop: Option<f64>,
    target: Option<f64>,
    valid_until: Option<i64>,
}

#[derive(Debug, Default)]
pub(crate) struct ResolveReport {
    pub resolved: usize,
    pub pending: usize,
    pub real_linked: usize,
    /// 本地 1m K 线缺数据、需要补的品种。
    pub missing_candles: Vec<String>,
    pub touched_profiles: Vec<String>,
}

/// 结算到期的影子决策，并把已平仓的真实结果关联回来。每次最多处理 `limit` 条。
pub(crate) fn resolve_pending_decisions(conn: &Connection, now: i64, limit: usize) -> Result<ResolveReport, String> {
    let mut report = ResolveReport::default();
    let pending = {
        let mut stmt = conn
            .prepare(
                "SELECT id,inst_id,created_at,side,action,entry,stop,target,valid_until,profile_id FROM ai_trader_decisions
                 WHERE shadow_status='pending' AND created_at<=?1 ORDER BY created_at ASC LIMIT ?2",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![now - 2 * 60_000, limit as i64], |row| {
                Ok((
                    PendingDecision {
                        id: row.get(0)?,
                        inst_id: row.get(1)?,
                        created_at: row.get(2)?,
                        side: row.get(3)?,
                        action: row.get(4)?,
                        entry: row.get(5)?,
                        stop: row.get(6)?,
                        target: row.get(7)?,
                        valid_until: row.get(8)?,
                    },
                    row.get::<_, String>(9)?,
                ))
            })
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())?
    };
    for (decision, profile_id) in pending {
        let Some(plan) = shadow_plan(&decision) else {
            conn.execute("UPDATE ai_trader_decisions SET shadow_status='invalid',shadow_note='缺少方向或价位',resolved_at=?2 WHERE id=?1", params![decision.id, now])
                .map_err(|err| err.to_string())?;
            continue;
        };
        let window_end = now.min(plan.valid_until + MAX_HOLD_MS + 60_000);
        let bars = local_candles_between(conn, &decision.inst_id, "1m", decision.created_at - 60_000, window_end)?
            .into_iter()
            .map(|candle| desic_trade_domain::OhlcBar { t: candle.time * 1000, o: candle.open, h: candle.high, l: candle.low, c: candle.close })
            .collect::<Vec<_>>();
        let outcome = desic_trade_domain::resolve_shadow(&plan, &bars, now);
        let update = |status: &str, note: Option<&str>, r: Option<f64>, mfe: Option<f64>, mae: Option<f64>, exit: Option<&str>, filled: Option<i64>| {
            conn.execute(
                "UPDATE ai_trader_decisions SET shadow_status=?2,shadow_note=?3,shadow_r=?4,shadow_mfe_r=?5,shadow_mae_r=?6,exit_kind=?7,filled_at=?8,resolved_at=?9 WHERE id=?1",
                params![decision.id, status, note, r, mfe, mae, exit, filled, now],
            )
            .map_err(|err| err.to_string())
        };
        match outcome {
            desic_trade_domain::ShadowOutcome::Pending => {
                report.pending += 1;
                // 决策 10 分钟后本地还没有之后的 K 线：多半是没在采集这个品种，请求补数。
                let latest = bars.last().map(|bar| bar.t).unwrap_or(i64::MIN);
                if now - decision.created_at > 10 * 60_000 && latest < now - 10 * 60_000 && !report.missing_candles.contains(&decision.inst_id) {
                    report.missing_candles.push(decision.inst_id.clone());
                }
                continue;
            }
            desic_trade_domain::ShadowOutcome::Invalid(reason) => update("invalid", Some(reason), None, None, None, None, None)?,
            desic_trade_domain::ShadowOutcome::Unfilled => update("unfilled", Some("有效期内没有触及入场价"), None, None, None, None, None)?,
            desic_trade_domain::ShadowOutcome::Closed { filled_at, exit, r, mfe_r, mae_r, .. } => {
                update("resolved", None, Some(r), Some(mfe_r), Some(mae_r), Some(exit.as_str()), Some(filled_at))?
            }
        };
        report.resolved += 1;
        if !report.touched_profiles.contains(&profile_id) {
            report.touched_profiles.push(profile_id);
        }
    }
    report.real_linked = link_real_results(conn, limit)?;
    Ok(report)
}

fn text_number(value: Option<String>) -> Option<f64> {
    value.and_then(|text| text.trim().parse::<f64>().ok()).filter(|value| value.is_finite() && *value > 0.0)
}

/// 已执行的决策：仓位平掉后，按实际开 / 平均价换算成 R（与影子同一口径，扣同样的手续费估算）。
fn link_real_results(conn: &Connection, limit: usize) -> Result<usize, String> {
    let rows = {
        let mut stmt = conn
            .prepare(
                "SELECT d.id,d.side,d.entry,d.stop,e.id,e.avg_open_px,e.avg_close_px FROM ai_trader_decisions d
                 JOIN position_episode_opportunities p ON p.opportunity_id=d.opportunity_id
                 JOIN position_episodes e ON e.id=p.episode_id
                 WHERE d.opportunity_id IS NOT NULL AND d.real_r IS NULL AND e.status='closed'
                 LIMIT ?1",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![limit as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<f64>>(2)?,
                    row.get::<_, Option<f64>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            })
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())?
    };
    let mut linked = 0;
    for (id, side, entry, stop, episode_id, open_px, close_px) in rows {
        let (Some(entry), Some(stop), Some(open_px), Some(close_px)) = (entry, stop, text_number(open_px), text_number(close_px)) else {
            continue;
        };
        let risk = (entry - stop).abs();
        if risk <= 0.0 {
            continue;
        }
        let sign = if side.as_deref() == Some("short") { -1.0 } else { 1.0 };
        let r = sign * (close_px - open_px) / risk - ROUND_TRIP_FEE_PCT / 100.0 * open_px / risk;
        conn.execute("UPDATE ai_trader_decisions SET real_episode_id=?2,real_r=?3 WHERE id=?1", params![id, episode_id, r])
            .map_err(|err| err.to_string())?;
        linked += 1;
    }
    Ok(linked)
}

/// 成绩单的数据：某个 Profile（或全部交易员 Profile）在 `since` 之后的决策，最新的在前。
pub(crate) fn load_decision_outcomes(conn: &Connection, profile_id: Option<&str>, since: i64) -> Vec<desic_agent_automation::DecisionOutcome> {
    let sql = "SELECT d.id,d.created_at,d.inst_id,d.setup_id,d.regime_daily,d.side,d.action,d.probability,
                      d.shadow_r,d.real_r,d.against_direction,d.regime_mismatch,d.handbook_version,
                      (SELECT o.status FROM trade_opportunities o WHERE o.id=d.opportunity_id)
               FROM ai_trader_decisions d
               WHERE (?1 IS NULL OR d.profile_id=?1) AND d.created_at>=?2
               ORDER BY d.created_at DESC LIMIT 2000";
    let Ok(mut stmt) = conn.prepare(sql) else {
        return Vec::new();
    };
    let rows = stmt.query_map(params![profile_id, since], |row| {
        Ok(desic_agent_automation::DecisionOutcome {
            id: row.get(0)?,
            created_at: row.get(1)?,
            inst_id: row.get(2)?,
            setup_id: row.get(3)?,
            regime_daily: row.get(4)?,
            side: row.get(5)?,
            action: row.get(6)?,
            probability: row.get(7)?,
            shadow_r: row.get(8)?,
            real_r: row.get(9)?,
            against_direction: row.get::<_, i64>(10)? != 0,
            regime_mismatch: row.get::<_, i64>(11)? != 0,
            handbook_version: row.get(12)?,
            executed: row.get::<_, Option<String>>(13)?.as_deref() == Some("executed"),
        })
    });
    rows.map(|rows| rows.filter_map(Result::ok).collect()).unwrap_or_default()
}

/// 写进简报的成绩单：本 Profile 已结算的样本少于 10 条时改用所有交易员 Profile 的合计。
pub(crate) fn scorecard_brief(conn: &Connection, profile_id: &str, current_regime: Option<&str>, now: i64, chinese: bool) -> String {
    let since = now - 90 * 24 * 60 * 60_000;
    let own = load_decision_outcomes(conn, Some(profile_id), since);
    let own_card = desic_agent_automation::build_scorecard(&own);
    let (rows, card, pooled) = if own_card.resolved < 10 {
        let all = load_decision_outcomes(conn, None, since);
        let card = desic_agent_automation::build_scorecard(&all);
        if card.resolved > own_card.resolved {
            (all, card, true)
        } else {
            (own, own_card, false)
        }
    } else {
        (own, own_card, false)
    };
    let recent = rows.iter().filter(|row| row.effective_r().is_some()).take(5).cloned().collect::<Vec<_>>();
    desic_agent_automation::render_scorecard_brief(&card, &recent, current_regime, pooled, chinese)
}

/// 新出现的「建议暂停」分组发一次通知（同一分组只发一次，记在自动化设置里）。
pub(crate) fn notify_new_flags(app: &tauri::AppHandle, conn: &Connection, profile_ids: &[String], now: i64) {
    const KEY: &str = "trader_scorecard_flags_notified";
    let mut notified = crate::ai_automation::load_setting(conn, KEY)
        .and_then(|value| serde_json::from_value::<Vec<String>>(value).ok())
        .unwrap_or_default();
    let mut changed = false;
    for profile_id in profile_ids {
        let rows = load_decision_outcomes(conn, Some(profile_id), now - 90 * 24 * 60 * 60_000);
        for group in desic_agent_automation::build_scorecard(&rows).groups.into_iter().filter(|group| group.flagged) {
            let key = format!("{profile_id}|{}|{}|{}", group.setup_id, group.regime, group.side);
            if notified.contains(&key) {
                continue;
            }
            notified.push(key);
            changed = true;
            let _ = app.emit(
                crate::ai_automation::AUTOMATION_EVENT,
                json!({
                    "type": "scorecardWarning",
                    "message": format!(
                        "交易员成绩单：{} 在 {} 时{}已有 {} 条决策，收缩后平均 {:+.2}R，建议考虑暂停（由你决定）。",
                        group.setup_id,
                        group.regime,
                        if group.side == "long" { "做多" } else { "做空" },
                        group.n,
                        group.shrunk_avg_r
                    ),
                    "action": { "tab": "scorecard", "id": profile_id },
                }),
            );
        }
    }
    if changed {
        let _ = crate::ai_automation::set_setting(conn, KEY, json!(notified));
    }
}

/// 界面展示用的一条决策（成绩单页的最近决策、运行详情里的决策日志）。
fn decision_rows(conn: &Connection, filter_sql: &str, value: &dyn rusqlite::ToSql, limit: i64) -> Vec<Value> {
    let sql = format!(
        "SELECT id,run_id,inst_id,created_at,setup_id,side,action,entry,stop,target,probability,valid_until,reason,
                regime_daily,regime_4h,against_direction,regime_mismatch,shadow_status,shadow_note,shadow_r,exit_kind,
                real_r,opportunity_id,handbook_version
         FROM ai_trader_decisions WHERE {filter_sql} ORDER BY created_at DESC LIMIT {limit}"
    );
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return Vec::new();
    };
    let rows = stmt.query_map([value], |row| {
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "runId": row.get::<_, String>(1)?,
            "instId": row.get::<_, String>(2)?,
            "createdAt": row.get::<_, i64>(3)?,
            "setupId": row.get::<_, Option<String>>(4)?,
            "side": row.get::<_, Option<String>>(5)?,
            "action": row.get::<_, String>(6)?,
            "entry": row.get::<_, Option<f64>>(7)?,
            "stop": row.get::<_, Option<f64>>(8)?,
            "target": row.get::<_, Option<f64>>(9)?,
            "probability": row.get::<_, Option<f64>>(10)?,
            "validUntil": row.get::<_, Option<i64>>(11)?,
            "reason": row.get::<_, Option<String>>(12)?,
            "regimeDaily": row.get::<_, Option<String>>(13)?,
            "regime4h": row.get::<_, Option<String>>(14)?,
            "againstDirection": row.get::<_, i64>(15)? != 0,
            "regimeMismatch": row.get::<_, i64>(16)? != 0,
            "shadowStatus": row.get::<_, String>(17)?,
            "shadowNote": row.get::<_, Option<String>>(18)?,
            "shadowR": row.get::<_, Option<f64>>(19)?,
            "exitKind": row.get::<_, Option<String>>(20)?,
            "realR": row.get::<_, Option<f64>>(21)?,
            "opportunityId": row.get::<_, Option<String>>(22)?,
            "handbookVersion": row.get::<_, Option<i64>>(23)?,
        }))
    });
    rows.map(|rows| rows.filter_map(Result::ok).collect()).unwrap_or_default()
}

/// 成绩单页：某个交易员 Profile（不传则全部）在 `from_ms` 之后的成绩、最近决策与当前手册。
#[tauri::command]
pub(crate) async fn ai_trader_scorecard(app: tauri::AppHandle, profile_id: Option<String>, from_ms: i64) -> Result<Value, String> {
    crate::blocking_work::run_blocking(move || {
        let conn = open_read_database(&app)?;
        let profile = profile_id.as_deref().map(str::trim).filter(|value| !value.is_empty());
        let rows = load_decision_outcomes(&conn, profile, from_ms);
        let card = desic_agent_automation::build_scorecard(&rows);
        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ai_trader_decisions WHERE shadow_status='pending' AND (?1 IS NULL OR profile_id=?1) AND created_at>=?2",
                params![profile, from_ms],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let recent = match profile {
            Some(profile) => decision_rows(&conn, "profile_id=?1", &profile, 40),
            None => decision_rows(&conn, "?1=?1", &1_i64, 40),
        };
        let (version, handbook) = current_handbook(&conn);
        Ok(json!({
            "profileId": profile,
            "fromMs": from_ms,
            "scorecard": card,
            "pending": pending,
            "recent": recent,
            "handbook": { "version": version, "content": handbook },
        }))
    })
    .await
}

/// 运行详情：这次交易员运行记下的决策日志（含影子 / 真实结果）。
#[tauri::command]
pub(crate) async fn ai_trader_run_decisions(app: tauri::AppHandle, run_id: String) -> Result<Vec<Value>, String> {
    crate::blocking_work::run_blocking(move || {
        let conn = open_read_database(&app)?;
        Ok(decision_rows(&conn, "run_id=?1", &run_id, 10))
    })
    .await
}

/// 用户手动暂停 / 恢复某个形态（可限定日线阶段与方向）：生成新的手册版本。暂停期间这个形态的开仓由后端拒绝。
pub(crate) fn set_setup_pause(
    conn: &Connection,
    setup_id: &str,
    regime: Option<&str>,
    side: Option<&str>,
    paused: bool,
    reason: Option<&str>,
    now: i64,
) -> Result<(i64, Handbook), String> {
    let (version, mut handbook) = current_handbook(conn);
    if desic_agent_automation::find_setup(&handbook, setup_id).is_none() {
        return Err(format!("交易手册里没有形态 {setup_id}"));
    }
    let regime = regime.map(str::trim).filter(|value| !value.is_empty()).map(str::to_string);
    let side = side.map(str::trim).filter(|value| !value.is_empty()).map(str::to_string);
    let same_scope = |entry: &desic_agent_automation::PausedSetup| entry.setup_id == setup_id && entry.regime == regime && entry.side == side;
    if paused {
        if !handbook.paused.iter().any(same_scope) {
            handbook.paused.push(desic_agent_automation::PausedSetup {
                setup_id: setup_id.to_string(),
                regime: regime.clone(),
                side: side.clone(),
                reason: reason.map(str::trim).filter(|value| !value.is_empty()).unwrap_or("用户手动暂停").chars().take(200).collect(),
                paused_at: now,
            });
        }
    } else {
        handbook.paused.retain(|entry| !same_scope(entry));
    }
    desic_agent_automation::validate_handbook(&handbook)?;
    let next = version + 1;
    let note = format!("{}{}", if paused { "手动暂停 " } else { "手动恢复 " }, setup_id);
    conn.execute(
        "INSERT INTO ai_trader_handbooks (version,status,content_json,parent_version,source_suggestion_id,note,created_at,published_at)
         VALUES (?1,'published',?2,?3,NULL,?4,?5,?5)",
        params![next, serde_json::to_string(&handbook).map_err(|err| err.to_string())?, version, note, now],
    )
    .map_err(|err| err.to_string())?;
    Ok((next, handbook))
}

#[tauri::command]
pub(crate) async fn ai_trader_set_setup_pause(
    app: tauri::AppHandle,
    setup_id: String,
    regime: Option<String>,
    side: Option<String>,
    paused: bool,
    reason: Option<String>,
) -> Result<Value, String> {
    crate::blocking_work::run_blocking(move || {
        let conn = crate::ai_automation::open_automation_database(&app)?;
        let (version, handbook) = set_setup_pause(&conn, setup_id.trim(), regime.as_deref(), side.as_deref(), paused, reason.as_deref(), now_ms())?;
        Ok(json!({ "version": version, "content": handbook }))
    })
    .await
}

/// worker 节拍里调用：每 5 分钟结算一批影子决策、关联真实结果、补缺失的 K 线、发新的「建议暂停」提醒。
pub(crate) fn spawn_shadow_settlement(app: &tauri::AppHandle) {
    static LAST_RUN: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
    let now = now_ms();
    let last = LAST_RUN.load(std::sync::atomic::Ordering::Relaxed);
    if now.saturating_sub(last) < 5 * 60_000 {
        return;
    }
    LAST_RUN.store(now, std::sync::atomic::Ordering::Relaxed);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let worker_app = app.clone();
        let report = crate::blocking_work::run_blocking(move || {
            let conn = crate::ai_automation::open_automation_database(&worker_app)?;
            let report = resolve_pending_decisions(&conn, now, 50)?;
            if !report.touched_profiles.is_empty() {
                notify_new_flags(&worker_app, &conn, &report.touched_profiles, now);
            }
            Ok::<_, String>(report)
        })
        .await;
        match report {
            Ok(report) => {
                for inst_id in report.missing_candles {
                    crate::ai_briefing::request_history_backfill(&app, &inst_id, now);
                }
            }
            Err(error) => crate::boot_log(&format!("trader shadow settlement failed: {error}")),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(id: &str) -> desic_storage_config::AiSkillDefinition {
        desic_storage_config::AiSkillDefinition {
            id: id.to_string(),
            name: id.to_string(),
            description: String::new(),
            rules: "classic rules".to_string(),
            content: "classic content".to_string(),
            builtin: true,
            bundle: None,
        }
    }

    /// 阶段 B 测试用的最小库：手册 / 决策表 + 运行、机会、仓位、K 线。
    fn learning_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open");
        migrate_trader_learning(&conn).expect("migrate");
        conn.execute_batch(
            "CREATE TABLE ai_agent_runs (id TEXT PRIMARY KEY, context_mode TEXT, initial_market_snapshot_json TEXT);
             CREATE TABLE trade_opportunities (id TEXT PRIMARY KEY, inst_id TEXT, intent TEXT, status TEXT, created_at INTEGER);
             CREATE TABLE position_episodes (id TEXT PRIMARY KEY, status TEXT, avg_open_px TEXT, avg_close_px TEXT);
             CREATE TABLE position_episode_opportunities (episode_id TEXT, opportunity_id TEXT);
             CREATE TABLE candles (symbol TEXT, interval TEXT, open_time INTEGER, close_time INTEGER, open TEXT, high TEXT, low TEXT, close TEXT,
               volume TEXT, volume_ccy TEXT, volume_quote TEXT, confirm INTEGER, source TEXT, updated_at INTEGER);
             CREATE TABLE ai_automation_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ai_agent_runs VALUES ('run-1','briefing',?1)",
            params![json!({ "briefing": { "handbookVersion": 1, "regimes": { "BTC-USDT-SWAP": { "daily": "up", "h4": "up", "volatility": "trend" } } } }).to_string()],
        )
        .unwrap();
        conn
    }

    fn candle(conn: &Connection, minute: i64, t0: i64, o: f64, h: f64, l: f64, c: f64) {
        conn.execute(
            "INSERT INTO candles VALUES ('BTC-USDT-SWAP','1m',?1,?2,?3,?4,?5,?6,'1','1','1',1,'test',0)",
            params![t0 + minute * 60_000, t0 + minute * 60_000 + 59_999, o.to_string(), h.to_string(), l.to_string(), c.to_string()],
        )
        .unwrap();
    }

    #[test]
    fn missing_decision_log_is_pushed_back_once() {
        let gate = std::sync::Arc::new(Mutex::new(crate::ai_automation::FinishGateState::default()));
        assert!(decision_log_pushback(&gate, &[]).is_some());
        assert!(decision_log_pushback(&gate, &[]).is_none(), "只打回一次");
        let fresh = std::sync::Arc::new(Mutex::new(crate::ai_automation::FinishGateState::default()));
        assert!(decision_log_pushback(&fresh, &[json!({"instId": "BTC-USDT-SWAP", "action": "no_trade"})]).is_none());
    }

    #[test]
    fn decisions_are_recorded_settled_and_linked_to_real_results() {
        let conn = learning_db();
        let t0 = 1_791_200_000_000_i64;
        conn.execute("INSERT INTO trade_opportunities VALUES ('opp-1','BTC-USDT-SWAP','open','executed',?1)", params![t0]).unwrap();
        let log = vec![
            json!({ "instId": "BTC-USDT-SWAP", "setupId": "trend_pullback", "side": "short", "action": "limit_order",
                    "entry": 100.0, "stop": 102.0, "target": 96.0, "probability": 0.6, "reason": "逆势试空" }),
            json!({ "instId": "BTC-USDT-SWAP", "action": "no_trade" }),
            json!({ "instId": "ETH-USDT-SWAP", "setupId": "none", "side": "short", "action": "manage_position",
                    "entry": 1900.0, "stop": 1950.0, "target": 1800.0 }),
        ];
        let decision = json!({ "createdOpportunityIds": ["opp-1"] }).to_string();
        let written = record_run_decisions(&conn, "run-1", "p1", &log, Some(&decision), t0).expect("record");
        assert_eq!(written, 2, "同一品种只记第一条");
        let (status, against, regime, opportunity): (String, i64, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT shadow_status,against_direction,regime_daily,opportunity_id FROM ai_trader_decisions WHERE inst_id='BTC-USDT-SWAP'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!((status.as_str(), against, regime.as_deref(), opportunity.as_deref()), ("pending", 1, Some("up"), Some("opp-1")), "日线上升时做空记为违反方向纪律");
        let (eth_status, eth_note, eth_against): (String, String, i64) = conn
            .query_row("SELECT shadow_status,shadow_note,against_direction FROM ai_trader_decisions WHERE inst_id='ETH-USDT-SWAP'", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap();
        assert_eq!((eth_status.as_str(), eth_note.as_str()), ("skipped", "持仓管理不做影子结算"));
        assert_eq!(eth_against, 0, "管理已有持仓不计入方向纪律");

        // 影子结算：限价 100 在第 1 分钟成交，第 3 分钟碰到目标 96。
        candle(&conn, 0, t0, 99.5, 99.8, 99.2, 99.6);
        candle(&conn, 1, t0, 99.6, 100.4, 99.5, 100.1);
        candle(&conn, 2, t0, 100.1, 100.3, 98.0, 98.2);
        candle(&conn, 3, t0, 98.2, 98.4, 95.8, 96.1);
        let report = resolve_pending_decisions(&conn, t0 + 10 * 60_000, 50).expect("resolve");
        assert_eq!(report.resolved, 1);
        let (shadow_r, exit): (f64, String) = conn
            .query_row("SELECT shadow_r,exit_kind FROM ai_trader_decisions WHERE inst_id='BTC-USDT-SWAP'", [], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap();
        assert_eq!(exit, "target");
        assert!((shadow_r - (2.0 - 0.05)).abs() < 1e-9, "{shadow_r}");

        // 真实结果：仓位平掉后按实际开 / 平均价换算 R。
        conn.execute_batch(
            "INSERT INTO position_episodes VALUES ('ep-1','closed','100','98');
             INSERT INTO position_episode_opportunities VALUES ('ep-1','opp-1');",
        )
        .unwrap();
        let report = resolve_pending_decisions(&conn, t0 + 20 * 60_000, 50).expect("link");
        assert_eq!(report.real_linked, 1);
        let real_r: f64 = conn.query_row("SELECT real_r FROM ai_trader_decisions WHERE inst_id='BTC-USDT-SWAP'", [], |row| row.get(0)).unwrap();
        assert!((real_r - (1.0 - 0.05)).abs() < 1e-9, "{real_r}");

        // 成绩单：真实结果优先；违反方向纪律的统计出现在合规里。
        let rows = load_decision_outcomes(&conn, Some("p1"), 0);
        let card = desic_agent_automation::build_scorecard(&rows);
        assert_eq!((card.decisions, card.resolved, card.executed), (2, 1, 1));
        assert_eq!(card.compliance.against_n, 1);
        let brief = scorecard_brief(&conn, "p1", Some("up"), t0 + 30 * 60_000, true);
        assert!(brief.contains("已结算 1 条决策"), "{brief}");
    }

    #[test]
    fn manual_pause_publishes_a_new_handbook_version_and_blocks_that_scope() {
        let conn = learning_db();
        let (version, handbook) = set_setup_pause(&conn, "range_edge", Some("mixed"), Some("short"), true, Some("连续亏损"), 5).expect("pause");
        assert_eq!(version, 2);
        assert_eq!(current_handbook(&conn).0, 2);
        assert!(trader_setup_reasons(&handbook, Some("range_edge"), Some("mixed"), "short")[0].starts_with("setup_paused"));
        assert!(trader_setup_reasons(&handbook, Some("range_edge"), Some("mixed"), "long").is_empty());
        let (version, handbook) = set_setup_pause(&conn, "range_edge", Some("mixed"), Some("short"), false, None, 6).expect("resume");
        assert_eq!(version, 3);
        assert!(handbook.paused.is_empty());
        assert!(set_setup_pause(&conn, "yolo", None, None, true, None, 7).is_err());
    }

    #[test]
    fn handbook_table_seeds_v1_once_and_loads_latest_published() {
        let conn = Connection::open_in_memory().expect("open");
        migrate_trader_learning(&conn).expect("migrate");
        migrate_trader_learning(&conn).expect("migrate twice");
        let (version, handbook) = current_handbook(&conn);
        assert_eq!(version, 1);
        assert_eq!(handbook, desic_agent_automation::default_handbook());
        let mut next = handbook.clone();
        next.direction_policy = "测试".to_string();
        conn.execute(
            "INSERT INTO ai_trader_handbooks (version,status,content_json,created_at,published_at) VALUES (2,'published',?1,2,2)",
            params![serde_json::to_string(&next).unwrap()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ai_trader_handbooks (version,status,content_json,created_at) VALUES (3,'draft','{}',3)",
            [],
        )
        .unwrap();
        let (version, loaded) = current_handbook(&conn);
        assert_eq!((version, loaded.direction_policy.as_str()), (2, "测试"), "草稿不生效");
    }

    #[test]
    fn trader_skill_payload_swaps_core_spec_and_drops_classic_skills() {
        let mut definitions = ["desic-core-operations", "trading-philosophy", "okx-market-intelligence", "market-radar-research", "desic-agent-orchestration", "desic-trade-operations", "my-own-skill"]
            .into_iter()
            .map(skill)
            .collect::<Vec<_>>();
        let mut enabled = vec!["trading-philosophy".to_string(), "desic-trade-operations".to_string(), "my-own-skill".to_string()];
        apply_trader_skills(&mut definitions, &mut enabled, false);
        let ids = definitions.iter().map(|definition| definition.id.as_str()).collect::<Vec<_>>();
        assert_eq!(ids, vec!["desic-core-operations", "desic-trade-operations", "my-own-skill"]);
        assert_eq!(enabled, vec!["desic-trade-operations".to_string(), "my-own-skill".to_string()]);
        let core = &definitions[0];
        assert_eq!(core.name, TRADER_CORE_NAME);
        assert!(core.content.contains("setupId") && !core.content.contains("classic content"));
        assert_eq!(definitions[1].content, "classic content", "其它技能原样保留");
    }

    #[test]
    fn open_setup_check_only_applies_to_trader_runs() {
        let conn = Connection::open_in_memory().expect("open");
        migrate_trader_learning(&conn).expect("migrate");
        conn.execute_batch(
            "CREATE TABLE ai_agent_runs (id TEXT PRIMARY KEY, context_mode TEXT, initial_market_snapshot_json TEXT);
             INSERT INTO ai_agent_runs VALUES ('classic','tools',NULL);
             INSERT INTO ai_agent_runs VALUES ('trader','briefing','{\"briefing\":{\"regimes\":{\"BTC-USDT-SWAP\":{\"daily\":\"up\"}}}}');",
        )
        .unwrap();
        // 经典运行：不要求 setupId（行为不变）。
        assert!(trader_open_setup_reasons(&conn, "classic", "BTC-USDT-SWAP", "open", "long", None).is_empty());
        // 交易员运行：开仓必须带手册形态；平仓 / 撤单不受影响。
        assert!(trader_open_setup_reasons(&conn, "trader", "BTC-USDT-SWAP", "open", "long", None)[0].starts_with("setup_required"));
        assert!(trader_open_setup_reasons(&conn, "trader", "BTC-USDT-SWAP", "close", "long", None).is_empty());
        assert!(trader_open_setup_reasons(&conn, "trader", "BTC-USDT-SWAP", "open", "long", Some("trend_pullback")).is_empty());
        assert_eq!(run_daily_regime(&conn, "trader", "BTC-USDT-SWAP").as_deref(), Some("up"));
        assert_eq!(run_daily_regime(&conn, "classic", "BTC-USDT-SWAP"), None);
    }

    #[test]
    fn setup_validation_requires_a_known_unpaused_handbook_setup() {
        let mut handbook = desic_agent_automation::default_handbook();
        assert!(trader_setup_reasons(&handbook, None, Some("up"), "long")[0].starts_with("setup_required"));
        assert!(trader_setup_reasons(&handbook, Some("  "), Some("up"), "long")[0].starts_with("setup_required"));
        assert!(trader_setup_reasons(&handbook, Some("yolo"), Some("up"), "long")[0].starts_with("setup_unknown"));
        assert!(trader_setup_reasons(&handbook, Some("trend_pullback"), Some("up"), "long").is_empty());
        // 方向纪律是软规则：逆势形态不拦（由成绩单统计），只有用户手动暂停的才拦。
        assert!(trader_setup_reasons(&handbook, Some("trend_pullback"), Some("up"), "short").is_empty());
        handbook.paused.push(desic_agent_automation::PausedSetup {
            setup_id: "trend_pullback".into(),
            regime: Some("up".into()),
            side: None,
            reason: "手动暂停".into(),
            paused_at: 1,
        });
        assert!(trader_setup_reasons(&handbook, Some("trend_pullback"), Some("up"), "long")[0].starts_with("setup_paused"));
        assert!(trader_setup_reasons(&handbook, Some("trend_pullback"), Some("down"), "short").is_empty());
    }
}
