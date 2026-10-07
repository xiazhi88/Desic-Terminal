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
    // 交易员开仓挂单的清理记录：到期自动撤单、停用 Profile 时用户确认撤单。按委托号去重，失败的记次数。
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_trader_order_cleanup (
           ord_id TEXT PRIMARY KEY,
           opportunity_id TEXT NOT NULL,
           profile_id TEXT NOT NULL,
           inst_id TEXT NOT NULL,
           source TEXT NOT NULL,
           valid_until INTEGER,
           status TEXT NOT NULL,
           attempts INTEGER NOT NULL DEFAULT 0,
           last_error TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );",
    )
    .map_err(|err| err.to_string())?;
    // 手册库（多本手册、每本自己的版次）：建表、加列、回填、索引、种子数据。
    crate::trader_handbooks::migrate_handbook_library(conn)?;
    // 用户的临时指令、对决策的纠正。
    crate::trader_instructions::migrate_trader_instructions(conn)?;
    crate::trader_corrections::migrate_trader_corrections(conn)?;
    // 决策属于哪本手册（同 id 的形态在不同手册里是不同的打法）、决策时形态的状态（观察中的只有影子结果）。
    let _ = conn.execute("ALTER TABLE ai_trader_decisions ADD COLUMN handbook_id TEXT", []);
    let _ = conn.execute("ALTER TABLE ai_trader_decisions ADD COLUMN setup_status TEXT", []);
    conn.execute(
        "UPDATE ai_trader_decisions SET handbook_id=COALESCE(
           (SELECT h.handbook_id FROM ai_trader_handbooks h WHERE h.version=ai_trader_decisions.handbook_version), 'default')
         WHERE handbook_id IS NULL",
        [],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
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

/// 交易员运行的开仓候选形态校验：`setupId` 必须存在、属于本轮的手册、处于实盘状态，且没有被用户暂停。
/// `regime` 是本轮简报里由代码算出的日线阶段（用于匹配限定了阶段的暂停条目）。只对交易员运行的开仓调用。
pub(crate) fn trader_setup_reasons(handbook: &Handbook, setup_id: Option<&str>, regime: Option<&str>, side: &str) -> Vec<String> {
    let available = handbook.setups.iter().filter(|setup| setup.is_live()).map(|setup| setup.id.as_str()).collect::<Vec<_>>().join(", ");
    let Some(setup_id) = setup_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return vec![format!("setup_required：交易员 Profile 的开仓候选必须带 setupId（交易手册里实盘的形态之一：{available}）")];
    };
    let Some(setup) = desic_agent_automation::find_setup(handbook, setup_id) else {
        return vec![format!("setup_unknown：{setup_id} 不是交易手册里的形态（可用：{available}）")];
    };
    if !setup.is_live() {
        return vec![format!(
            "setup_observing：{setup_id} 处于「观察中」，只评估、写进 decisionLog，不能开仓（要开仓需先在交易手册里启用这个形态）"
        )];
    }
    match desic_agent_automation::paused_entry(handbook, setup_id, regime, side) {
        Some(entry) => vec![format!("setup_paused：{setup_id} 已被用户暂停（{}；要开仓需先在成绩单或交易手册里恢复）", entry.reason)],
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

/// 交易员运行的统一开仓守卫：形态（缺失 / 未知 / 观察中 / 已暂停）与用户的临时指令。经典运行或非开仓直接返回空。
/// 手册按本轮运行用的那本取最新已发布版次，所以运行中途的暂停、改观察立即生效。三处调用：
/// `market.readDecisionContext`（早拒）、提交交易机会（堵住复核后 60 秒窗口与 revise / reuse）、执行前（自动执行与手动批准）。
pub(crate) fn trader_open_guard_reasons(
    conn: &Connection,
    run_id: &str,
    inst_id: &str,
    intent: &str,
    direction: &str,
    setup_id: Option<&str>,
    now: i64,
) -> Vec<String> {
    if intent != "open" || !run_is_trader(conn, run_id) {
        return Vec::new();
    }
    let handbook_id = run_handbook_id(conn, run_id);
    let loaded = crate::trader_handbooks::load_handbook(conn, Some(&handbook_id));
    let regime = run_daily_regime(conn, run_id, inst_id);
    let mut reasons = trader_setup_reasons(&loaded.handbook, setup_id, regime.as_deref(), direction);
    reasons.extend(crate::trader_instructions::run_instruction_reasons(conn, run_id, inst_id, direction, now));
    reasons
}

/// 本轮简报审计里记的手册 id（老运行没有记录时是默认手册）。
pub(crate) fn run_handbook_id(conn: &Connection, run_id: &str) -> String {
    run_briefing_audit(conn, run_id)
        .get("handbookId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(crate::trader_handbooks::DEFAULT_HANDBOOK_ID)
        .to_string()
}

/// 本轮简报里由代码算出的某品种日线阶段（写在 `initial_market_snapshot_json.briefing.regimes`）。
pub(crate) fn run_daily_regime(conn: &Connection, run_id: &str, inst_id: &str) -> Option<String> {
    run_briefing_audit(conn, run_id)
        .pointer(&format!("/regimes/{}/daily", inst_id.replace('/', "~1")))
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

/// 本轮实际用的手册内容（审计里记的版次）；读不到时用这本手册的最新版次。
fn run_handbook_content(conn: &Connection, audit: &Value) -> (String, Handbook) {
    let handbook_id = audit
        .get("handbookId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(crate::trader_handbooks::DEFAULT_HANDBOOK_ID)
        .to_string();
    let handbook = audit
        .get("handbookVersion")
        .and_then(Value::as_i64)
        .and_then(|version| crate::trader_handbooks::handbook_at_version(conn, version))
        .unwrap_or_else(|| crate::trader_handbooks::load_handbook(conn, Some(&handbook_id)).handbook);
    (handbook_id, handbook)
}

/// 决策日志的条数规则：每个品种最多一条主决策（用实盘形态或不做），每个观察中的形态另外最多一条，合计不超过 6 条。
const MAX_DECISION_LOG_ENTRIES: usize = 6;

/// 把交易员运行的决策日志写库（在 finishRun 的同一个事务里）。每个品种最多一条主决策，观察中的形态另记；
/// 行情阶段与手册版本取本轮简报审计（代码计算），开仓机会按品种和形态从本轮持久化记录关联。
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
    let (handbook_id, handbook) = run_handbook_content(conn, &audit);
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
    for (index, raw) in log.iter().enumerate() {
        if written >= MAX_DECISION_LOG_ENTRIES {
            break;
        }
        let Ok(entry) = serde_json::from_value::<DecisionLogEntry>(raw.clone()) else {
            continue;
        };
        let inst_id = entry.inst_id.trim().to_ascii_uppercase();
        if inst_id.is_empty() {
            continue;
        }
        let setup_id = entry.setup_id.as_deref().map(str::trim).filter(|value| !value.is_empty() && *value != "none").map(str::to_string);
        let setup = setup_id.as_deref().and_then(|id| desic_agent_automation::find_setup(&handbook, id));
        let observing = setup.is_some_and(|setup| !setup.is_live());
        // 主决策按品种去重；观察中的形态按「品种 + 形态」去重。
        let key = if observing { format!("{inst_id}|{}", setup_id.as_deref().unwrap_or_default()) } else { inst_id.clone() };
        if !seen.insert(key) {
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
        // 同一个 Profile 已经有一条品种、形态、方向、入场、止损、目标都相同、还在影子结算中的决策时，这条只记录、
        // 不重复结算：否则同一个计划（比如每轮都把同一笔挂单再记一遍）会在成绩单里被算成很多次。
        let duplicate_of: Option<i64> = if settleable {
            conn.query_row(
                "SELECT created_at FROM ai_trader_decisions
                 WHERE profile_id=?1 AND inst_id=?2 AND COALESCE(setup_id,'')=COALESCE(?3,'') AND side=?4 AND shadow_status='pending'
                   AND ABS(entry-?5)<=ABS(?5)*1e-9 AND ABS(stop-?6)<=ABS(?6)*1e-9 AND ABS(target-?7)<=ABS(?7)*1e-9
                 ORDER BY created_at LIMIT 1",
                params![profile_id, inst_id, setup_id, side, entry_px, stop_px, target_px],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| err.to_string())?
        } else {
            None
        };
        let (shadow_status, shadow_note) = match (settleable, duplicate_of) {
            (true, Some(earlier)) => (
                "duplicate",
                Some(format!("与 {} 记下的同一计划相同，那条还在影子结算中，这条不重复结算", crate::ai_briefing::shanghai_label(earlier, false))),
            ),
            (true, None) => ("pending", None),
            (false, _) => (
                "skipped",
                Some((if action == "manage_position" { "持仓管理不做影子结算" } else { "没有完整的方向与价位，不做影子结算" }).to_string()),
            ),
        };
        // 观察中的条目永远不关联真实机会；其余按品种 + 形态关联（决策没写形态时只按品种）。
        let opportunity_id = if !observing && matches!(action.as_str(), "enter_now" | "limit_order") && !opportunity_ids.is_empty() {
            let placeholders = opportunity_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!(
                "SELECT id FROM trade_opportunities WHERE inst_id=? AND intent='open' AND (? IS NULL OR setup_id=?) AND id IN ({placeholders})
                 ORDER BY created_at DESC LIMIT 1"
            );
            let mut values: Vec<&dyn rusqlite::ToSql> = vec![&inst_id, &setup_id, &setup_id];
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
               against_direction,regime_mismatch,shadow_status,shadow_note,handbook_id,setup_status
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26)",
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
                shadow_status,
                shadow_note,
                handbook_id,
                setup.map(|setup| if setup.is_live() { desic_agent_automation::SETUP_STATUS_LIVE } else { desic_agent_automation::SETUP_STATUS_OBSERVING }),
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

/// 成绩单的数据：某个 Profile（或全部交易员 Profile）、某本手册（或全部手册）在 `since` 之后的决策，最新的在前。
pub(crate) fn load_decision_outcomes(
    conn: &Connection,
    profile_id: Option<&str>,
    handbook_id: Option<&str>,
    since: i64,
) -> Vec<desic_agent_automation::DecisionOutcome> {
    let sql = "SELECT d.id,d.created_at,d.inst_id,d.setup_id,d.regime_daily,d.side,d.action,d.probability,
                      d.shadow_r,d.real_r,d.against_direction,d.regime_mismatch,d.handbook_version,
                      (SELECT o.status FROM trade_opportunities o WHERE o.id=d.opportunity_id),
                      COALESCE(d.handbook_id,'default'),d.setup_status
               FROM ai_trader_decisions d
               WHERE (?1 IS NULL OR d.profile_id=?1) AND (?2 IS NULL OR COALESCE(d.handbook_id,'default')=?2) AND d.created_at>=?3
               ORDER BY d.created_at DESC LIMIT 2000";
    let mut stmt = match conn.prepare(sql) {
        Ok(stmt) => stmt,
        Err(error) => {
            crate::boot_log(&format!("trader decision outcomes query failed: {error}"));
            return Vec::new();
        }
    };
    let rows = stmt.query_map(params![profile_id, handbook_id, since], |row| {
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
            handbook_id: row.get(14)?,
            observing: row.get::<_, Option<String>>(15)?.as_deref() == Some(desic_agent_automation::SETUP_STATUS_OBSERVING),
        })
    });
    rows.map(|rows| rows.filter_map(Result::ok).collect()).unwrap_or_default()
}

/// 写进简报的成绩单（只算本轮这本手册下的决策）：本 Profile 已结算的样本少于 10 条时，
/// 改用同一本手册下所有交易员 Profile 的合计。
pub(crate) fn scorecard_brief(
    conn: &Connection,
    profile_id: &str,
    handbook: &crate::trader_handbooks::LoadedHandbook,
    current_regime: Option<&str>,
    now: i64,
    chinese: bool,
) -> String {
    let since = now - 90 * 24 * 60 * 60_000;
    let own = load_decision_outcomes(conn, Some(profile_id), Some(&handbook.id), since);
    let own_card = desic_agent_automation::build_scorecard(&own);
    let (rows, card, pooled) = if own_card.resolved < 10 {
        let all = load_decision_outcomes(conn, None, Some(&handbook.id), since);
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
    desic_agent_automation::render_scorecard_brief(&card, &recent, current_regime, pooled, &handbook.observing_setup_ids(), chinese)
}

/// 新出现的「建议暂停」分组发一次通知（同一分组只发一次，记在自动化设置里）。
pub(crate) fn notify_new_flags(app: &tauri::AppHandle, conn: &Connection, profile_ids: &[String], now: i64) {
    const KEY: &str = "trader_scorecard_flags_notified";
    let mut notified = crate::ai_automation::load_setting(conn, KEY)
        .and_then(|value| serde_json::from_value::<Vec<String>>(value).ok())
        .unwrap_or_default();
    let mut changed = false;
    for profile_id in profile_ids {
        // 只看这个 Profile 现在用的手册；观察中的形态本来就不能开仓，不发「建议暂停」。
        let handbook = crate::trader_handbooks::load_handbook(conn, Some(&crate::trader_handbooks::profile_handbook_id(conn, profile_id)));
        let observing = handbook.observing_setup_ids();
        let rows = load_decision_outcomes(conn, Some(profile_id), Some(&handbook.id), now - 90 * 24 * 60 * 60_000);
        for group in desic_agent_automation::build_scorecard(&rows)
            .groups
            .into_iter()
            .filter(|group| group.flagged && !observing.contains(&group.setup_id))
        {
            // 默认手册沿用原来的键，升级前已经提醒过的分组不再重复提醒。
            let key = if handbook.id == crate::trader_handbooks::DEFAULT_HANDBOOK_ID {
                format!("{profile_id}|{}|{}|{}", group.setup_id, group.regime, group.side)
            } else {
                format!("{profile_id}|{}|{}|{}|{}", handbook.id, group.setup_id, group.regime, group.side)
            };
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
                        "交易员成绩单：{} 在日线{}时{}已有 {} 条决策，收缩后平均 {:+.2}R，建议考虑暂停（由你决定）。",
                        group.setup_id,
                        desic_agent_automation::regime_label(&group.regime, true),
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
fn decision_rows(conn: &Connection, filter_sql: &str, values: &[&dyn rusqlite::ToSql], limit: i64) -> Vec<Value> {
    let sql = format!(
        "SELECT d.id,d.run_id,d.inst_id,d.created_at,d.setup_id,d.side,d.action,d.entry,d.stop,d.target,d.probability,d.valid_until,d.reason,
                d.regime_daily,d.regime_4h,d.against_direction,d.regime_mismatch,d.shadow_status,d.shadow_note,d.shadow_r,d.exit_kind,
                d.real_r,d.opportunity_id,d.handbook_version,COALESCE(d.handbook_id,'default'),d.setup_status,
                c.category,c.text,c.updated_at
         FROM ai_trader_decisions d
         LEFT JOIN ai_trader_corrections c ON c.decision_id=d.id AND c.deleted_at IS NULL
         WHERE {filter_sql} ORDER BY d.created_at DESC LIMIT {limit}"
    );
    let mut stmt = match conn.prepare(&sql) {
        Ok(stmt) => stmt,
        Err(error) => {
            crate::boot_log(&format!("trader decision rows query failed: {error}"));
            return Vec::new();
        }
    };
    let rows = stmt.query_map(values, |row| {
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
            "handbookId": row.get::<_, String>(24)?,
            "setupStatus": row.get::<_, Option<String>>(25)?,
            "correction": match row.get::<_, Option<String>>(26)? {
                Some(category) => json!({ "category": category, "text": row.get::<_, String>(27)?, "updatedAt": row.get::<_, i64>(28)? }),
                None => Value::Null,
            },
        }))
    });
    rows.map(|rows| rows.filter_map(Result::ok).collect()).unwrap_or_default()
}

/// 成绩单页：某个交易员 Profile（不传则全部）、某本手册（不传则全部）在 `from_ms` 之后的成绩、最近决策，
/// 以及要显示的手册（传了就是那本，否则是这个 Profile 用的那本，再否则是默认手册）。
#[tauri::command]
pub(crate) async fn ai_trader_scorecard(
    app: tauri::AppHandle,
    profile_id: Option<String>,
    handbook_id: Option<String>,
    from_ms: i64,
) -> Result<Value, String> {
    crate::blocking_work::run_blocking(move || {
        let conn = open_read_database(&app)?;
        let profile = profile_id.as_deref().map(str::trim).filter(|value| !value.is_empty());
        let handbook_filter = handbook_id.as_deref().map(str::trim).filter(|value| !value.is_empty());
        let rows = load_decision_outcomes(&conn, profile, handbook_filter, from_ms);
        let card = desic_agent_automation::build_scorecard(&rows);
        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ai_trader_decisions WHERE shadow_status='pending' AND (?1 IS NULL OR profile_id=?1)
                   AND (?2 IS NULL OR COALESCE(handbook_id,'default')=?2) AND created_at>=?3",
                params![profile, handbook_filter, from_ms],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let recent = decision_rows(
            &conn,
            "(?1 IS NULL OR d.profile_id=?1) AND (?2 IS NULL OR COALESCE(d.handbook_id,'default')=?2)",
            &[&profile, &handbook_filter],
            40,
        );
        let shown = handbook_filter
            .map(str::to_string)
            .or_else(|| profile.map(|profile| crate::trader_handbooks::profile_handbook_id(&conn, profile)));
        let handbook = crate::trader_handbooks::load_handbook(&conn, shown.as_deref());
        Ok(json!({
            "profileId": profile,
            "handbookId": handbook_filter,
            "fromMs": from_ms,
            "scorecard": card,
            "pending": pending,
            "recent": recent,
            "handbook": handbook.summary_json(),
        }))
    })
    .await
}

/// 运行详情：这次交易员运行记下的决策日志（含影子 / 真实结果）。
#[tauri::command]
pub(crate) async fn ai_trader_run_decisions(app: tauri::AppHandle, run_id: String) -> Result<Vec<Value>, String> {
    crate::blocking_work::run_blocking(move || {
        let conn = open_read_database(&app)?;
        Ok(decision_rows(&conn, "d.run_id=?1", &[&run_id], MAX_DECISION_LOG_ENTRIES as i64))
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

// ===================== 开仓挂单的有效期（只管交易员 Profile 的开仓限价单） =====================

/// 交易员没写 expiresAt 时，开仓限价单默认挂 24 小时。
pub(crate) const ENTRY_ORDER_DEFAULT_VALIDITY_MS: i64 = 24 * 60 * 60_000;
const ENTRY_ORDER_SWEEP_INTERVAL_MS: i64 = 60_000;
/// 自动撤单失败后至少隔这么久再试；试满次数后通知一次，交给用户处理。
const ENTRY_ORDER_RETRY_MS: i64 = 5 * 60_000;
const ENTRY_ORDER_MAX_ATTEMPTS: i64 = 6;
const ENTRY_ORDER_EXPIRED_REASON: &str = "交易员开仓挂单超过有效期仍未成交，按规则自动撤单";
const ENTRY_ORDER_DISABLED_REASON: &str = "停用交易员 Profile 时由用户确认撤单";

/// 交易员开仓限价单的有效期：候选里写了将来的 expiresAt 就用它，否则挂出后 24 小时。
pub(crate) fn entry_order_valid_until(explicit_expires_at: Option<i64>, now: i64) -> i64 {
    explicit_expires_at
        .filter(|value| *value > now)
        .unwrap_or(now + ENTRY_ORDER_DEFAULT_VALIDITY_MS)
}

pub(crate) fn set_entry_order_validity(conn: &Connection, opportunity_id: &str, valid_until: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE trade_opportunities SET order_valid_until=?2 WHERE id=?1 AND intent='open' AND order_type='limit'",
        params![opportunity_id, valid_until],
    )
    .map(|_| ())
    .map_err(|err| err.to_string())
}

/// 交易员 Profile 挂着的一笔开仓限价单（本地委托记录 + 对应的交易机会）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TraderEntryOrder {
    pub opportunity_id: String,
    pub profile_id: String,
    pub agent_run_id: Option<String>,
    pub account_id: Option<String>,
    pub environment: String,
    pub inst_id: String,
    pub ord_id: String,
    pub cl_ord_id: Option<String>,
    pub side: String,
    pub px: Option<f64>,
    pub sz: Option<f64>,
    pub placed_at: Option<i64>,
    pub valid_until: Option<i64>,
}

/// 只认交易员运行建的开仓限价单（带 setupId），本地记录里仍在挂着，且还没被清理过。
const ENTRY_ORDER_SELECT: &str = "SELECT o.id,o.agent_profile_id,o.agent_run_id,o.account_id,o.environment,o.inst_id,
        r.ord_id,r.cl_ord_id,r.side,CAST(r.px AS REAL),CAST(r.sz AS REAL),r.okx_ctime,o.order_valid_until
   FROM trade_opportunities o
   JOIN okx_orders r ON r.opportunity_id=o.id
  WHERE o.intent='open' AND o.order_type='limit' AND o.setup_id IS NOT NULL AND o.setup_id<>''
    AND o.agent_profile_id IS NOT NULL
    AND r.operator='ai' AND r.ord_id<>'' AND r.state IN ('live','partially_filled')
    AND NOT EXISTS (SELECT 1 FROM ai_trader_order_cleanup c WHERE c.ord_id=r.ord_id AND c.status IN ('cancelled','gone'))";

fn entry_order_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TraderEntryOrder> {
    Ok(TraderEntryOrder {
        opportunity_id: row.get(0)?,
        profile_id: row.get(1)?,
        agent_run_id: row.get(2)?,
        account_id: row.get(3)?,
        environment: row.get(4)?,
        inst_id: row.get(5)?,
        ord_id: row.get(6)?,
        cl_ord_id: row.get::<_, Option<String>>(7)?.filter(|value| !value.is_empty()),
        side: row.get(8)?,
        px: row.get(9)?,
        sz: row.get(10)?,
        placed_at: row.get(11)?,
        valid_until: row.get(12)?,
    })
}

fn query_entry_orders(conn: &Connection, sql: &str, params: impl rusqlite::Params) -> Result<Vec<TraderEntryOrder>, String> {
    let mut stmt = conn.prepare(sql).map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params, entry_order_from_row)
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string());
    rows
}

/// 已过有效期、仍完全没成交的交易员开仓挂单。撤过的、撤单失败后还在冷却或已试满次数的跳过。
pub(crate) fn expired_entry_orders(conn: &Connection, now: i64) -> Result<Vec<TraderEntryOrder>, String> {
    let sql = format!(
        "{ENTRY_ORDER_SELECT}
           AND o.order_valid_until IS NOT NULL AND o.order_valid_until<=?1
           AND r.state='live' AND COALESCE(CAST(r.acc_fill_sz AS REAL),0)=0
           AND NOT EXISTS (SELECT 1 FROM ai_trader_order_cleanup c WHERE c.ord_id=r.ord_id
                 AND (c.attempts>=?2 OR c.updated_at>?1-?3))
         ORDER BY o.order_valid_until LIMIT 20"
    );
    query_entry_orders(conn, &sql, params![now, ENTRY_ORDER_MAX_ATTEMPTS, ENTRY_ORDER_RETRY_MS])
}

/// 某个交易员 Profile 现在挂着的开仓单（停用前询问用户要不要一起撤）。
pub(crate) fn profile_entry_orders(conn: &Connection, profile_id: &str) -> Result<Vec<TraderEntryOrder>, String> {
    let sql = format!("{ENTRY_ORDER_SELECT} AND o.agent_profile_id=?1 ORDER BY r.okx_ctime");
    query_entry_orders(conn, &sql, params![profile_id])
}

/// 某个范围（Profile 为空 = 全部交易员；品种为空 = 全部品种）内挂着的交易员开仓单，只要 `sides` 方向的
/// （`buy` 开多、`sell` 开空）。新建临时指令时列给用户确认要不要一起撤。
pub(crate) fn scoped_entry_orders(conn: &Connection, profile_id: Option<&str>, inst_id: Option<&str>, sides: &[&str]) -> Result<Vec<TraderEntryOrder>, String> {
    let sql = format!("{ENTRY_ORDER_SELECT} AND (?1 IS NULL OR o.agent_profile_id=?1) AND (?2 IS NULL OR o.inst_id=?2) ORDER BY r.okx_ctime");
    Ok(query_entry_orders(conn, &sql, params![profile_id, inst_id])?
        .into_iter()
        .filter(|order| sides.contains(&order.side.as_str()))
        .collect())
}

/// 记一次清理结果，返回这笔挂单累计尝试的次数。
fn record_entry_order_cleanup(conn: &Connection, order: &TraderEntryOrder, source: &str, status: &str, error: Option<&str>, now: i64) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO ai_trader_order_cleanup (ord_id,opportunity_id,profile_id,inst_id,source,valid_until,status,attempts,last_error,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,1,?8,?9,?9)
         ON CONFLICT(ord_id) DO UPDATE SET source=excluded.source,status=excluded.status,
           attempts=ai_trader_order_cleanup.attempts+1,last_error=excluded.last_error,updated_at=excluded.updated_at",
        params![order.ord_id, order.opportunity_id, order.profile_id, order.inst_id, source, order.valid_until, status, error, now],
    )
    .map_err(|err| err.to_string())?;
    conn.query_row("SELECT attempts FROM ai_trader_order_cleanup WHERE ord_id=?1", params![order.ord_id], |row| row.get(0))
        .map_err(|err| err.to_string())
}

/// 撤单时交易所回「已成交 / 已撤 / 不存在」：这笔挂单已经不在了，不再重试。
fn order_already_closed(error: &str) -> bool {
    serde_json::from_str::<Value>(error)
        .ok()
        .and_then(|value| value.get("code").and_then(Value::as_str).map(str::to_string))
        .is_some_and(|code| matches!(code.as_str(), "51400" | "51401" | "51402"))
}

fn entry_order_text(order: &TraderEntryOrder) -> String {
    let side = if order.side == "sell" { "卖" } else { "买" };
    let number = |value: Option<f64>| value.map(|value| value.to_string()).unwrap_or_else(|| "--".to_string());
    format!("{} 限价{} {} 张 @ {}", order.inst_id, side, number(order.sz), number(order.px))
}

/// 走与界面撤单相同的链路（审计、账户互斥、WS 优先 REST 兜底）。
async fn cancel_entry_order(app: &tauri::AppHandle, order: &TraderEntryOrder, operator: &str, reason: &str) -> Result<(), String> {
    let runtime = app.state::<MarketRuntime>();
    okx_cancel_order(
        runtime,
        app.clone(),
        CancelOrderRequest {
            account_id: order.account_id.clone(),
            environment: order.environment.clone(),
            inst_id: order.inst_id.clone(),
            confirmed_live: Some(true),
            ord_id: Some(order.ord_id.clone()),
            cl_ord_id: order.cl_ord_id.clone(),
            is_algo: Some(false),
            algo_id: None,
            algo_cl_ord_id: None,
            operator: Some(operator.to_string()),
            opportunity_id: Some(order.opportunity_id.clone()),
            agent_run_id: order.agent_run_id.clone(),
            reason: Some(reason.to_string()),
        },
    )
    .await
    .map(|_| ())
}

/// 自动化节拍里每分钟最多扫一次：到期仍未成交的交易员开仓挂单由代码撤掉并通知。
/// 不受 AI 自动化总开关影响——挂单的有效期在下单时已经定好，停用的 Profile 留下的挂单同样会被清理。
pub(crate) fn spawn_entry_order_sweep(app: &tauri::AppHandle) {
    use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
    static LAST_RUN: AtomicI64 = AtomicI64::new(0);
    static RUNNING: AtomicBool = AtomicBool::new(false);
    let now = now_ms();
    if now.saturating_sub(LAST_RUN.load(Ordering::Relaxed)) < ENTRY_ORDER_SWEEP_INTERVAL_MS {
        return;
    }
    if RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    LAST_RUN.store(now, Ordering::Relaxed);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = sweep_expired_entry_orders(&app, now).await {
            crate::boot_log(&format!("trader entry order sweep failed: {error}"));
        }
        RUNNING.store(false, Ordering::Release);
    });
}

async fn sweep_expired_entry_orders(app: &tauri::AppHandle, now: i64) -> Result<(), String> {
    let worker_app = app.clone();
    let due = crate::blocking_work::run_blocking(move || {
        let conn = crate::ai_automation::open_automation_database(&worker_app)?;
        expired_entry_orders(&conn, now)
    })
    .await?;
    for order in due {
        let outcome = cancel_entry_order(app, &order, "system", ENTRY_ORDER_EXPIRED_REASON).await;
        let (status, error) = match &outcome {
            Ok(()) => ("cancelled", None),
            Err(error) if order_already_closed(error) => ("gone", None),
            Err(error) => ("failed", Some(error.clone())),
        };
        let worker_app = app.clone();
        let stored = order.clone();
        let stored_error = error.clone();
        let attempts = crate::blocking_work::run_blocking(move || {
            let conn = crate::ai_automation::open_automation_database(&worker_app)?;
            record_entry_order_cleanup(&conn, &stored, "expired", status, stored_error.as_deref(), now_ms())
        })
        .await?;
        let valid_until = order
            .valid_until
            .map(|ms| crate::ai_briefing::shanghai_label(ms, false))
            .unwrap_or_else(|| "--".to_string());
        let event = match status {
            "cancelled" => Some(json!({
                "type": "traderOrderExpired",
                "message": format!("交易员挂单到期仍未成交，已自动撤单：{}（有效至 {valid_until}）。", entry_order_text(&order)),
                "action": { "tab": "scorecard", "id": order.profile_id },
            })),
            "failed" if attempts >= ENTRY_ORDER_MAX_ATTEMPTS => Some(json!({
                "type": "traderOrderExpiryFailed",
                "message": format!(
                    "交易员挂单到期自动撤单失败（已试 {attempts} 次），请手动撤单：{}。原因：{}",
                    entry_order_text(&order),
                    error.as_deref().unwrap_or("--")
                ),
                "action": { "tab": "scorecard", "id": order.profile_id },
            })),
            _ => None,
        };
        if let Some(event) = event {
            let _ = app.emit(crate::ai_automation::AUTOMATION_EVENT, event);
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EntryOrderCancelResult {
    ord_id: String,
    inst_id: String,
    ok: bool,
    error: Option<String>,
}

/// 交易员 Profile 现在挂着的开仓单（停用前给用户看）。
#[tauri::command]
pub(crate) async fn ai_trader_entry_orders(app: tauri::AppHandle, profile_id: String) -> Result<Vec<TraderEntryOrder>, String> {
    crate::blocking_work::run_blocking(move || {
        let conn = open_read_database(&app)?;
        profile_entry_orders(&conn, &profile_id)
    })
    .await
}

/// 停用交易员 Profile 时，用户确认后撤掉它挂着的开仓单。只撤属于这个 Profile 的开仓单，其它委托号一律忽略。
#[tauri::command]
pub(crate) async fn ai_trader_cancel_entry_orders(app: tauri::AppHandle, profile_id: String, ord_ids: Vec<String>) -> Result<Vec<EntryOrderCancelResult>, String> {
    let worker_app = app.clone();
    let orders = crate::blocking_work::run_blocking(move || {
        let conn = open_read_database(&worker_app)?;
        profile_entry_orders(&conn, &profile_id)
    })
    .await?;
    cancel_selected_entry_orders(&app, orders, &ord_ids, "profile_disabled", ENTRY_ORDER_DISABLED_REASON).await
}

/// 撤掉用户勾选的那几笔（只从 `orders` 里挑，别的委托号一律忽略），逐笔记清理结果。撤单不持有数据库连接。
pub(crate) async fn cancel_selected_entry_orders(
    app: &tauri::AppHandle,
    orders: Vec<TraderEntryOrder>,
    ord_ids: &[String],
    source: &'static str,
    reason: &str,
) -> Result<Vec<EntryOrderCancelResult>, String> {
    let wanted = ord_ids.iter().cloned().collect::<std::collections::HashSet<_>>();
    let mut results = Vec::new();
    for order in orders.into_iter().filter(|order| wanted.contains(&order.ord_id)) {
        let outcome = cancel_entry_order(app, &order, "user", reason).await;
        let gone = outcome.as_ref().err().is_some_and(|error| order_already_closed(error));
        let status = if outcome.is_ok() { "cancelled" } else if gone { "gone" } else { "failed" };
        let error = outcome.err().filter(|_| !gone);
        let worker_app = app.clone();
        let stored = order.clone();
        let stored_error = error.clone();
        crate::blocking_work::run_blocking(move || {
            let conn = crate::ai_automation::open_automation_database(&worker_app)?;
            record_entry_order_cleanup(&conn, &stored, source, status, stored_error.as_deref(), now_ms())
        })
        .await?;
        results.push(EntryOrderCancelResult { ord_id: order.ord_id, inst_id: order.inst_id, ok: status != "failed", error });
    }
    Ok(results)
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
             CREATE TABLE trade_opportunities (id TEXT PRIMARY KEY, inst_id TEXT, intent TEXT, status TEXT, created_at INTEGER, setup_id TEXT);
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
        conn.execute("INSERT INTO trade_opportunities VALUES ('opp-1','BTC-USDT-SWAP','open','executed',?1,'trend_pullback')", params![t0]).unwrap();
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
        let rows = load_decision_outcomes(&conn, Some("p1"), None, 0);
        let card = desic_agent_automation::build_scorecard(&rows);
        assert_eq!((card.decisions, card.resolved, card.executed), (2, 1, 1));
        assert_eq!(card.compliance.against_n, 1);
        assert!(rows.iter().all(|row| row.handbook_id.as_deref() == Some("default")));
        let handbook = crate::trader_handbooks::load_handbook(&conn, None);
        let brief = scorecard_brief(&conn, "p1", &handbook, Some("up"), t0 + 30 * 60_000, true);
        assert!(brief.contains("已结算 1 条决策"), "{brief}");
        // 另一本手册下没有这些决策。
        assert!(load_decision_outcomes(&conn, Some("p1"), Some("handbook-other"), 0).is_empty());
    }

    #[test]
    fn decision_log_keeps_one_main_entry_per_instrument_plus_observing_setups() {
        let conn = learning_db();
        let observing = crate::trader_handbooks::set_setup_status(&conn, "default", "range_edge", "observing", 2).expect("observe");
        let t0 = 1_791_200_000_000_i64;
        conn.execute(
            "INSERT INTO ai_agent_runs VALUES ('run-2','briefing',?1)",
            params![json!({ "briefing": { "handbookId": "default", "handbookVersion": observing.version, "regimes": {} } }).to_string()],
        )
        .unwrap();
        conn.execute_batch(
            "INSERT INTO trade_opportunities VALUES ('opp-main','BTC-USDT-SWAP','open','executed',1,'trend_pullback');
             INSERT INTO trade_opportunities VALUES ('opp-newer','BTC-USDT-SWAP','open','executed',2,'breakout_retest');",
        )
        .unwrap();
        let entry = |inst: &str, setup: &str, action: &str| {
            json!({ "instId": inst, "setupId": setup, "side": "long", "action": action, "entry": 100.0, "stop": 98.0, "target": 104.0 })
        };
        let log = vec![
            entry("BTC-USDT-SWAP", "trend_pullback", "limit_order"),
            entry("BTC-USDT-SWAP", "range_edge", "limit_order"),
            entry("BTC-USDT-SWAP", "range_edge", "limit_order"),
            entry("BTC-USDT-SWAP", "none", "no_trade"),
            entry("ETH-USDT-SWAP", "none", "no_trade"),
            entry("SOL-USDT-SWAP", "none", "no_trade"),
            entry("XRP-USDT-SWAP", "none", "no_trade"),
            entry("DOGE-USDT-SWAP", "none", "no_trade"),
            entry("ADA-USDT-SWAP", "none", "no_trade"),
        ];
        let decision = json!({ "createdOpportunityIds": ["opp-main", "opp-newer"] }).to_string();
        let written = record_run_decisions(&conn, "run-2", "p1", &log, Some(&decision), t0).expect("record");
        assert_eq!(written, 6, "at most six entries");
        let (main_opp, main_status): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT opportunity_id,setup_status FROM ai_trader_decisions WHERE run_id='run-2' AND setup_id='trend_pullback'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((main_opp.as_deref(), main_status.as_deref()), (Some("opp-main"), Some("live")), "linked by setup, not just the newest");
        let observing_rows: Vec<(Option<String>, Option<String>)> = conn
            .prepare("SELECT opportunity_id,setup_status FROM ai_trader_decisions WHERE run_id='run-2' AND setup_id='range_edge'")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(observing_rows, vec![(None, Some("observing".to_string()))], "one observing entry, never linked to a real order");
        let shown = decision_rows(&conn, "d.run_id=?1", &[&"run-2"], MAX_DECISION_LOG_ENTRIES as i64);
        assert_eq!(shown.len(), 6);
        assert!(shown.iter().any(|row| row["setupStatus"] == "observing"));
        let outcomes = load_decision_outcomes(&conn, Some("p1"), Some("default"), 0);
        assert_eq!(outcomes.iter().filter(|row| row.observing).count(), 1);
    }

    #[test]
    fn the_same_plan_is_not_shadow_settled_twice_while_the_first_is_open() {
        let conn = learning_db();
        let t0 = 1_791_200_000_000_i64;
        for run in ["run-a", "run-b", "run-c", "run-d"] {
            conn.execute("INSERT INTO ai_agent_runs VALUES (?1,'briefing','{\"briefing\":{\"handbookVersion\":1}}')", params![run]).unwrap();
        }
        let plan = |action: &str| vec![json!({ "instId": "BTC-USDT-SWAP", "setupId": "trend_pullback", "side": "long", "action": action,
            "entry": 85150.0, "stop": 84670.0, "target": 86680.0 })];
        record_run_decisions(&conn, "run-a", "p1", &plan("limit_order"), None, t0).unwrap();
        record_run_decisions(&conn, "run-b", "p1", &plan("wait_condition"), None, t0 + 1_800_000).unwrap();
        // 另一个 Profile 的同一计划是另一份样本。
        record_run_decisions(&conn, "run-c", "p2", &plan("limit_order"), None, t0 + 1_800_000).unwrap();
        let status = |run: &str| conn.query_row("SELECT shadow_status,shadow_note FROM ai_trader_decisions WHERE run_id=?1", params![run], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))).unwrap();
        assert_eq!(status("run-a").0, "pending");
        let (dup, note) = status("run-b");
        assert_eq!(dup, "duplicate");
        assert!(note.unwrap().contains("不重复结算"));
        assert_eq!(status("run-c").0, "pending");
        // 第一条结束（未成交）以后，再提同一计划就是新的样本。
        conn.execute("UPDATE ai_trader_decisions SET shadow_status='unfilled' WHERE run_id='run-a'", []).unwrap();
        record_run_decisions(&conn, "run-d", "p1", &plan("limit_order"), None, t0 + 3_600_000).unwrap();
        assert_eq!(status("run-d").0, "pending");
        // 重复的那条不进成绩单的结果，只算决策数。
        let card = desic_agent_automation::build_scorecard(&load_decision_outcomes(&conn, Some("p1"), None, 0));
        assert_eq!((card.decisions, card.resolved), (3, 0));
    }

    #[test]
    fn handbook_table_seeds_once_and_drafts_never_load() {
        let conn = Connection::open_in_memory().expect("open");
        migrate_trader_learning(&conn).expect("migrate");
        migrate_trader_learning(&conn).expect("migrate twice");
        let loaded = crate::trader_handbooks::load_handbook(&conn, None);
        assert_eq!((loaded.version, loaded.revision), (1, 1));
        assert_eq!(loaded.handbook, desic_agent_automation::default_handbook());
        let mut next = loaded.handbook.clone();
        next.direction_policy = "测试".to_string();
        conn.execute(
            "INSERT INTO ai_trader_handbooks (version,status,content_json,created_at,published_at,handbook_id,revision,source)
             VALUES (2,'published',?1,2,2,'default',2,'edit')",
            params![serde_json::to_string(&next).unwrap()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ai_trader_handbooks (version,status,content_json,created_at,handbook_id,revision) VALUES (3,'draft','{}',3,'default',3)",
            [],
        )
        .unwrap();
        let loaded = crate::trader_handbooks::load_handbook(&conn, None);
        assert_eq!((loaded.version, loaded.handbook.direction_policy.as_str()), (2, "测试"), "草稿不生效");
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
    fn open_guard_only_applies_to_trader_runs_and_uses_the_runs_handbook() {
        let conn = Connection::open_in_memory().expect("open");
        migrate_trader_learning(&conn).expect("migrate");
        conn.execute_batch(
            "CREATE TABLE ai_agent_runs (id TEXT PRIMARY KEY, context_mode TEXT, initial_market_snapshot_json TEXT);
             INSERT INTO ai_agent_runs VALUES ('classic','tools',NULL);
             INSERT INTO ai_agent_runs VALUES ('trader','briefing','{\"briefing\":{\"regimes\":{\"BTC-USDT-SWAP\":{\"daily\":\"up\"}}}}');",
        )
        .unwrap();
        let guard = |run: &str, intent: &str, setup: Option<&str>| trader_open_guard_reasons(&conn, run, "BTC-USDT-SWAP", intent, "long", setup, 10);
        // 经典运行：不要求 setupId（行为不变）。
        assert!(guard("classic", "open", None).is_empty());
        assert!(guard("classic", "open", Some("whatever")).is_empty());
        // 交易员运行：开仓必须带手册形态；平仓 / 撤单不受影响。老快照没有 handbookId，用默认手册。
        assert!(guard("trader", "open", None)[0].starts_with("setup_required"));
        assert!(guard("trader", "close", None).is_empty());
        assert!(guard("trader", "open", Some("trend_pullback")).is_empty());
        assert_eq!(run_daily_regime(&conn, "trader", "BTC-USDT-SWAP").as_deref(), Some("up"));
        assert_eq!(run_daily_regime(&conn, "classic", "BTC-USDT-SWAP"), None);
        assert_eq!(run_handbook_id(&conn, "trader"), "default");
        // 复核之后、提交之前把形态改成观察中或暂停：守卫按最新版次立即拒绝。
        crate::trader_handbooks::set_setup_status(&conn, "default", "trend_pullback", "observing", 11).unwrap();
        assert!(guard("trader", "open", Some("trend_pullback"))[0].starts_with("setup_observing"));
        crate::trader_handbooks::set_setup_pause(&conn, "default", "breakout_retest", Some("up"), None, true, None, 12).unwrap();
        assert!(guard("trader", "open", Some("breakout_retest"))[0].starts_with("setup_paused"));
        // 用另一本手册的运行：只认那本手册里的形态。
        let mut custom = desic_agent_automation::default_handbook();
        custom.setups.truncate(1);
        custom.setups[0].id = "my_setup".into();
        let other = crate::trader_handbooks::create_handbook(
            &conn,
            "我的打法",
            crate::trader_handbooks::HandbookSeed::Import { handbook: custom, note: "测试".into() },
            13,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ai_agent_runs VALUES ('trader-b','briefing',?1)",
            params![json!({ "briefing": { "handbookId": other, "regimes": {} } }).to_string()],
        )
        .unwrap();
        assert!(guard("trader-b", "open", Some("my_setup")).is_empty());
        assert!(guard("trader-b", "open", Some("breakout_retest"))[0].starts_with("setup_unknown"));
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
        // 「阶段不可用」分组的暂停：只命中本轮日线阶段算不出来的情况。
        handbook.paused.push(desic_agent_automation::PausedSetup {
            setup_id: "range_edge".into(),
            regime: Some("unknown".into()),
            side: None,
            reason: "阶段不可用时别做".into(),
            paused_at: 2,
        });
        assert!(trader_setup_reasons(&handbook, Some("range_edge"), None, "long")[0].starts_with("setup_paused"));
        assert!(trader_setup_reasons(&handbook, Some("range_edge"), Some("mixed"), "long").is_empty());
        // 观察中的形态：拒绝开仓，也不出现在可用列表里。
        handbook.setups[0].status = desic_agent_automation::SETUP_STATUS_OBSERVING.into();
        let observing_id = handbook.setups[0].id.clone();
        let reasons = trader_setup_reasons(&handbook, Some(&observing_id), Some("up"), "long");
        assert!(reasons[0].starts_with("setup_observing"), "{reasons:?}");
        assert!(!trader_setup_reasons(&handbook, None, Some("up"), "long")[0].contains(&observing_id));
    }

    fn orders_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open");
        migrate_trader_learning(&conn).expect("migrate");
        conn.execute_batch(
            "CREATE TABLE trade_opportunities (id TEXT PRIMARY KEY, agent_profile_id TEXT, agent_run_id TEXT, account_id TEXT, environment TEXT,
               inst_id TEXT, intent TEXT, order_type TEXT, setup_id TEXT, status TEXT, expires_at INTEGER, order_valid_until INTEGER, created_at INTEGER);
             CREATE TABLE okx_orders (ord_id TEXT, cl_ord_id TEXT, opportunity_id TEXT, inst_id TEXT, side TEXT, ord_type TEXT, state TEXT,
               px TEXT, sz TEXT, acc_fill_sz TEXT, operator TEXT, okx_ctime INTEGER);",
        )
        .unwrap();
        conn
    }

    /// 插一笔开仓限价单：`setup` 为空表示经典 Profile 或 AI 研究（没有挂单有效期）。
    #[allow(clippy::too_many_arguments)]
    fn entry(conn: &Connection, id: &str, profile: &str, setup: Option<&str>, valid_until: Option<i64>, state: &str, filled: &str, operator: &str) {
        conn.execute(
            "INSERT INTO trade_opportunities VALUES (?1,?2,'run-1','acc','live','BTC-USDT-SWAP','open','limit',?3,'executed',NULL,?4,1000)",
            params![id, profile, setup, valid_until],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO okx_orders VALUES (?1,'',?2,'BTC-USDT-SWAP','buy','limit',?3,'84900','0.01',?4,?5,2000)",
            params![format!("ord-{id}"), id, state, filled, operator],
        )
        .unwrap();
    }

    #[test]
    fn entry_order_validity_uses_explicit_future_expiry_or_24_hours() {
        let now = 1_791_142_000_000_i64;
        assert_eq!(entry_order_valid_until(Some(now + 8 * 3_600_000), now), now + 8 * 3_600_000);
        assert_eq!(entry_order_valid_until(None, now), now + ENTRY_ORDER_DEFAULT_VALIDITY_MS);
        assert_eq!(entry_order_valid_until(Some(now - 1), now), now + ENTRY_ORDER_DEFAULT_VALIDITY_MS);
    }

    #[test]
    fn only_expired_unfilled_trader_entry_orders_are_swept() {
        let conn = orders_db();
        let now = 1_791_200_000_000_i64;
        entry(&conn, "due", "p1", Some("trend_pullback"), Some(now - 60_000), "live", "0", "ai");
        entry(&conn, "fresh", "p1", Some("trend_pullback"), Some(now + 60_000), "live", "0", "ai");
        entry(&conn, "classic", "classic", None, None, "live", "0", "ai");
        entry(&conn, "partial", "p1", Some("trend_pullback"), Some(now - 60_000), "partially_filled", "0.005", "ai");
        entry(&conn, "filled", "p1", Some("trend_pullback"), Some(now - 60_000), "filled", "0.01", "ai");
        entry(&conn, "manual", "p1", Some("trend_pullback"), Some(now - 60_000), "live", "0", "user");
        entry(&conn, "done", "p1", Some("trend_pullback"), Some(now - 60_000), "live", "0", "ai");
        entry(&conn, "cooling", "p1", Some("trend_pullback"), Some(now - 60_000), "live", "0", "ai");
        entry(&conn, "retry", "p1", Some("trend_pullback"), Some(now - 60_000), "live", "", "ai");
        entry(&conn, "exhausted", "p1", Some("trend_pullback"), Some(now - 60_000), "live", "0", "ai");
        let order = |id: &str| profile_entry_orders(&conn, "p1").unwrap().into_iter().find(|order| order.opportunity_id == id).unwrap();
        // 已撤掉的、刚失败还在冷却的、失败次数已满的都不再撤；冷却过了的失败单重试。
        record_entry_order_cleanup(&conn, &order("done"), "expired", "cancelled", None, now - 30_000).unwrap();
        record_entry_order_cleanup(&conn, &order("cooling"), "expired", "failed", Some("timeout"), now - 60_000).unwrap();
        record_entry_order_cleanup(&conn, &order("retry"), "expired", "failed", Some("timeout"), now - ENTRY_ORDER_RETRY_MS - 1).unwrap();
        let exhausted = order("exhausted");
        for _ in 0..ENTRY_ORDER_MAX_ATTEMPTS {
            record_entry_order_cleanup(&conn, &exhausted, "expired", "failed", Some("timeout"), now - ENTRY_ORDER_RETRY_MS - 1).unwrap();
        }
        let due = expired_entry_orders(&conn, now).unwrap().into_iter().map(|order| order.opportunity_id).collect::<Vec<_>>();
        assert_eq!(due, vec!["due".to_string(), "retry".to_string()]);
        let picked = expired_entry_orders(&conn, now).unwrap().remove(0);
        assert_eq!((picked.ord_id.as_str(), picked.px, picked.sz, picked.placed_at), ("ord-due", Some(84_900.0), Some(0.01), Some(2000)));
    }

    #[test]
    fn profile_entry_orders_list_only_this_trader_profiles_resting_orders() {
        let conn = orders_db();
        let now = 1_791_200_000_000_i64;
        entry(&conn, "a", "p1", Some("trend_pullback"), Some(now + 60_000), "live", "0", "ai");
        entry(&conn, "b", "p1", Some("range_edge"), Some(now - 60_000), "partially_filled", "0.005", "ai");
        entry(&conn, "gone", "p1", Some("range_edge"), Some(now - 60_000), "live", "0", "ai");
        entry(&conn, "other", "p2", Some("trend_pullback"), Some(now + 60_000), "live", "0", "ai");
        entry(&conn, "classic", "p1", None, None, "live", "0", "ai");
        let gone = profile_entry_orders(&conn, "p1").unwrap().into_iter().find(|order| order.opportunity_id == "gone").unwrap();
        assert_eq!(record_entry_order_cleanup(&conn, &gone, "profile_disabled", "gone", None, now).unwrap(), 1);
        let ids = profile_entry_orders(&conn, "p1").unwrap().into_iter().map(|order| order.opportunity_id).collect::<Vec<_>>();
        assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn cancel_errors_for_filled_or_missing_orders_are_not_retried() {
        let classified = |code: &str| json!({ "desicTerminalError": true, "code": code, "message": "x" }).to_string();
        assert!(order_already_closed(&classified("51400")));
        assert!(order_already_closed(&classified("51402")));
        assert!(!order_already_closed(&classified("50001")));
        assert!(!order_already_closed("network timeout"));
    }
}
