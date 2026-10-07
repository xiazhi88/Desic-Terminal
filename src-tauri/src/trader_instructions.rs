//! 交易员的临时指令：存库、开仓守卫、简报段落、新建时的附带动作（作废范围内还没执行的 AI 开仓机会、
//! 撤掉用户勾选的挂单）。纯逻辑（范围匹配、拒绝原因、渲染、校验）在 `desic_agent_automation::instructions`。

use super::*;
use desic_agent_automation::{TraderInstruction, INSTRUCTION_LONG_ONLY, INSTRUCTION_NO_ENTRY, INSTRUCTION_SHORT_ONLY};

const INSTRUCTION_ORDER_REASON: &str = "新建临时指令时由用户确认撤单";

pub(crate) fn migrate_trader_instructions(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_trader_instructions (
           id TEXT PRIMARY KEY,
           profile_id TEXT,
           inst_id TEXT,
           kind TEXT NOT NULL,
           text TEXT NOT NULL DEFAULT '',
           created_at INTEGER NOT NULL,
           expires_at INTEGER NOT NULL,
           cancelled_at INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_ai_trader_instructions_expiry ON ai_trader_instructions(expires_at);",
    )
    .map_err(|err| err.to_string())
}

fn instruction_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TraderInstruction> {
    Ok(TraderInstruction {
        id: row.get(0)?,
        profile_id: row.get(1)?,
        inst_id: row.get(2)?,
        kind: row.get(3)?,
        text: row.get(4)?,
        created_at: row.get(5)?,
        expires_at: row.get(6)?,
    })
}

/// 生效中的指令（没取消、没到期）。读不到时返回空：指令缺失只会少拦，不会多开仓之外的事（硬风控照常）。
pub(crate) fn active_instructions(conn: &Connection, now: i64) -> Vec<TraderInstruction> {
    let mut stmt = match conn.prepare(
        "SELECT id,profile_id,inst_id,kind,text,created_at,expires_at FROM ai_trader_instructions
         WHERE cancelled_at IS NULL AND expires_at>?1 ORDER BY created_at DESC",
    ) {
        Ok(stmt) => stmt,
        Err(error) => {
            crate::boot_log(&format!("trader instructions query failed: {error}"));
            return Vec::new();
        }
    };
    stmt.query_map(params![now], instruction_from_row)
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

/// 守卫用：这次交易员运行（按运行所属的 Profile）在这个品种、这个方向开仓会被哪些指令拦下。
pub(crate) fn run_instruction_reasons(conn: &Connection, run_id: &str, inst_id: &str, direction: &str, now: i64) -> Vec<String> {
    let Some(profile_id) = conn
        .query_row("SELECT profile_id FROM ai_agent_runs WHERE id=?1", params![run_id], |row| row.get::<_, Option<String>>(0))
        .ok()
        .flatten()
    else {
        return Vec::new();
    };
    desic_agent_automation::instruction_open_reasons(&active_instructions(conn, now), &profile_id, inst_id, direction, now)
}

/// 写进简报的「用户的临时指令」段落；没有作用于这个 Profile 的指令时为空。
pub(crate) fn instructions_brief(conn: &Connection, profile_id: &str, now: i64, chinese: bool) -> Option<String> {
    let until = |ms: i64| crate::ai_briefing::shanghai_label(ms, false);
    desic_agent_automation::render_instructions(&active_instructions(conn, now), profile_id, now, chinese, &until)
}

/// 这类指令会拦哪个方向的开仓委托（`buy` 开多、`sell` 开空）。
fn blocked_sides(kind: &str) -> &'static [&'static str] {
    match kind {
        INSTRUCTION_NO_ENTRY => &["buy", "sell"],
        INSTRUCTION_LONG_ONLY => &["sell"],
        INSTRUCTION_SHORT_ONLY => &["buy"],
        _ => &[],
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstructionInput {
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub inst_id: Option<String>,
    pub kind: String,
    #[serde(default)]
    pub text: String,
    pub expires_at: i64,
    /// 新建前列给用户、用户勾选要一起撤的挂单委托号。
    #[serde(default)]
    pub cancel_ord_ids: Vec<String>,
}

fn clean_scope(value: Option<&str>) -> Option<String> {
    value.map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)
}

/// 校验并写入一条指令；代码强制的类型同时把范围内还没执行的 AI 开仓机会作废（只改本地记录）。
/// 返回新指令与作废的机会数。
pub(crate) fn create_instruction(conn: &Connection, input: &InstructionInput, now: i64) -> Result<(TraderInstruction, usize), String> {
    let kind = input.kind.trim();
    let text = desic_agent_automation::sanitize_handbook_text(&input.text, true);
    desic_agent_automation::validate_instruction(kind, &text, input.expires_at, now)?;
    let profile_id = clean_scope(input.profile_id.as_deref());
    let inst_id = clean_scope(input.inst_id.as_deref()).map(|value| value.to_ascii_uppercase());
    crate::trader_handbooks::with_write_txn(conn, |conn| {
        if let Some(profile_id) = profile_id.as_deref() {
            let mode: Option<String> = conn
                .query_row("SELECT context_mode FROM ai_agent_profiles WHERE id=?1 AND deleted_at IS NULL", params![profile_id], |row| row.get(0))
                .optional()
                .map_err(|err| err.to_string())?;
            if mode.as_deref() != Some(crate::ai_automation::CONTEXT_MODE_BRIEFING) {
                return Err("临时指令只能作用于交易员 Profile".to_string());
            }
        }
        let active: i64 = conn
            .query_row("SELECT COUNT(*) FROM ai_trader_instructions WHERE cancelled_at IS NULL AND expires_at>?1", params![now], |row| row.get(0))
            .map_err(|err| err.to_string())?;
        if active as usize >= desic_agent_automation::MAX_ACTIVE_INSTRUCTIONS {
            return Err(format!("同时生效的指令最多 {} 条，先取消用不到的", desic_agent_automation::MAX_ACTIVE_INSTRUCTIONS));
        }
        let instruction = TraderInstruction {
            id: format!("instruction-{}", crate::ai_automation::unique_suffix()),
            profile_id: profile_id.clone(),
            inst_id: inst_id.clone(),
            kind: kind.to_string(),
            text: text.clone(),
            created_at: now,
            expires_at: input.expires_at,
        };
        conn.execute(
            "INSERT INTO ai_trader_instructions (id,profile_id,inst_id,kind,text,created_at,expires_at,cancelled_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,NULL)",
            params![instruction.id, instruction.profile_id, instruction.inst_id, instruction.kind, instruction.text, now, instruction.expires_at],
        )
        .map_err(|err| err.to_string())?;
        let voided = void_pending_opportunities(conn, &instruction, now)?;
        Ok((instruction, voided))
    })
}

/// 范围内还没执行的交易员开仓机会（等待批准 / 已批准未下单），按指令会被拦的直接作废。
fn void_pending_opportunities(conn: &Connection, instruction: &TraderInstruction, now: i64) -> Result<usize, String> {
    if !instruction.is_enforced() {
        return Ok(0);
    }
    let reason = format!("用户新建了临时指令（{}），这条还没执行的机会作废", instruction.kind);
    conn.execute(
        "UPDATE trade_opportunities SET status='cancelled',error=?1,updated_at=?2
         WHERE intent='open' AND status IN ('pending','approved')
           AND setup_id IS NOT NULL AND setup_id<>'' AND agent_profile_id IS NOT NULL
           AND (?3 IS NULL OR agent_profile_id=?3) AND (?4 IS NULL OR inst_id=?4)
           AND (?5='no_entry' OR (?5='long_only' AND direction='short') OR (?5='short_only' AND direction='long'))",
        params![reason, now, instruction.profile_id, instruction.inst_id, instruction.kind],
    )
    .map_err(|err| err.to_string())
}

pub(crate) fn cancel_instruction(conn: &Connection, id: &str, now: i64) -> Result<(), String> {
    let changed = conn
        .execute("UPDATE ai_trader_instructions SET cancelled_at=?2 WHERE id=?1 AND cancelled_at IS NULL", params![id, now])
        .map_err(|err| err.to_string())?;
    if changed == 0 {
        return Err("这条指令不存在或已经取消".to_string());
    }
    Ok(())
}

/// 指令列表（生效中的在前；带上历史时附最近 30 天到期或取消的）。
pub(crate) fn list_instructions(conn: &Connection, include_history: bool, now: i64) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT i.id,i.profile_id,i.inst_id,i.kind,i.text,i.created_at,i.expires_at,i.cancelled_at,p.name
             FROM ai_trader_instructions i LEFT JOIN ai_agent_profiles p ON p.id=i.profile_id
             WHERE (i.cancelled_at IS NULL AND i.expires_at>?1) OR (?2 AND COALESCE(i.cancelled_at,i.expires_at)>?1-2592000000)
             ORDER BY (i.cancelled_at IS NULL AND i.expires_at>?1) DESC, i.created_at DESC LIMIT 100",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![now, include_history], |row| {
            let cancelled_at: Option<i64> = row.get(7)?;
            let expires_at: i64 = row.get(6)?;
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "profileId": row.get::<_, Option<String>>(1)?,
                "instId": row.get::<_, Option<String>>(2)?,
                "kind": row.get::<_, String>(3)?,
                "text": row.get::<_, String>(4)?,
                "createdAt": row.get::<_, i64>(5)?,
                "expiresAt": expires_at,
                "cancelledAt": cancelled_at,
                "profileName": row.get::<_, Option<String>>(8)?,
                "status": if cancelled_at.is_some() { "cancelled" } else if expires_at <= now { "expired" } else { "active" },
            }))
        })
        .map_err(|err| err.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

#[tauri::command]
pub(crate) async fn ai_trader_instructions(app: tauri::AppHandle, include_history: Option<bool>) -> Result<Vec<Value>, String> {
    crate::blocking_work::run_blocking(move || {
        let conn = open_read_database(&app)?;
        list_instructions(&conn, include_history.unwrap_or(false), now_ms())
    })
    .await
}

/// 新建前给用户看：这条指令范围内、会被它拦的方向上挂着的交易员开仓单（默认勾选一起撤）。
#[tauri::command]
pub(crate) async fn ai_trader_instruction_scope_orders(
    app: tauri::AppHandle,
    profile_id: Option<String>,
    inst_id: Option<String>,
    kind: String,
) -> Result<Vec<crate::trader_learning::TraderEntryOrder>, String> {
    crate::blocking_work::run_blocking(move || {
        let conn = open_read_database(&app)?;
        let inst_id = clean_scope(inst_id.as_deref()).map(|value| value.to_ascii_uppercase());
        crate::trader_learning::scoped_entry_orders(&conn, clean_scope(profile_id.as_deref()).as_deref(), inst_id.as_deref(), blocked_sides(kind.trim()))
    })
    .await
}

/// 新建指令：先落库（并作废范围内还没执行的 AI 开仓机会），再撤用户勾选的挂单（只撤范围内会被拦的那些）。
#[tauri::command]
pub(crate) async fn ai_trader_instruction_create(app: tauri::AppHandle, request: InstructionInput) -> Result<Value, String> {
    let worker_app = app.clone();
    let input = request.clone();
    let (instruction, voided, orders) = crate::blocking_work::run_serial(move || {
        let conn = crate::ai_automation::open_automation_database(&worker_app)?;
        let (instruction, voided) = create_instruction(&conn, &input, now_ms())?;
        let orders = if input.cancel_ord_ids.is_empty() {
            Vec::new()
        } else {
            crate::trader_learning::scoped_entry_orders(
                &conn,
                instruction.profile_id.as_deref(),
                instruction.inst_id.as_deref(),
                blocked_sides(&instruction.kind),
            )?
        };
        Ok((instruction, voided, orders))
    })
    .await?;
    let cancelled = crate::trader_learning::cancel_selected_entry_orders(&app, orders, &request.cancel_ord_ids, "instruction", INSTRUCTION_ORDER_REASON).await?;
    Ok(json!({ "instruction": instruction, "voidedOpportunities": voided, "cancelledOrders": cancelled }))
}

#[tauri::command]
pub(crate) async fn ai_trader_instruction_cancel(app: tauri::AppHandle, id: String) -> Result<(), String> {
    crate::blocking_work::run_serial(move || {
        let conn = crate::ai_automation::open_automation_database(&app)?;
        cancel_instruction(&conn, id.trim(), now_ms())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("open");
        crate::trader_learning::migrate_trader_learning(&conn).expect("migrate");
        conn.execute_batch(
            "CREATE TABLE ai_agent_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, context_mode TEXT NOT NULL DEFAULT 'tools',
               handbook_id TEXT, deleted_at INTEGER);
             INSERT INTO ai_agent_profiles VALUES ('p1','BTC 交易员','briefing',NULL,NULL);
             INSERT INTO ai_agent_profiles VALUES ('classic','经典','tools',NULL,NULL);
             CREATE TABLE ai_agent_runs (id TEXT PRIMARY KEY, profile_id TEXT, context_mode TEXT, initial_market_snapshot_json TEXT);
             INSERT INTO ai_agent_runs VALUES ('run-1','p1','briefing','{\"briefing\":{\"regimes\":{}}}');
             INSERT INTO ai_agent_runs VALUES ('run-c','classic','tools',NULL);
             CREATE TABLE trade_opportunities (id TEXT PRIMARY KEY, agent_profile_id TEXT, inst_id TEXT, intent TEXT, direction TEXT,
               setup_id TEXT, status TEXT, error TEXT, updated_at INTEGER);",
        )
        .unwrap();
        conn
    }

    fn input(profile: Option<&str>, inst: Option<&str>, kind: &str, expires_at: i64) -> InstructionInput {
        InstructionInput {
            profile_id: profile.map(str::to_string),
            inst_id: inst.map(str::to_string),
            kind: kind.into(),
            text: String::new(),
            expires_at,
            cancel_ord_ids: Vec::new(),
        }
    }

    #[test]
    fn enforced_instructions_block_trader_opens_and_void_pending_opportunities() {
        let conn = db();
        let now = 1_791_200_000_000_i64;
        conn.execute_batch(
            "INSERT INTO trade_opportunities VALUES ('long-pending','p1','BTC-USDT-SWAP','open','long','trend_pullback','pending',NULL,0);
             INSERT INTO trade_opportunities VALUES ('short-pending','p1','BTC-USDT-SWAP','open','short','range_edge','approved',NULL,0);
             INSERT INTO trade_opportunities VALUES ('eth-short','p1','ETH-USDT-SWAP','open','short','range_edge','pending',NULL,0);
             INSERT INTO trade_opportunities VALUES ('classic-short','classic','BTC-USDT-SWAP','open','short',NULL,'pending',NULL,0);
             INSERT INTO trade_opportunities VALUES ('done','p1','BTC-USDT-SWAP','open','short','range_edge','executed',NULL,0);",
        )
        .unwrap();
        let guard = |direction: &str, inst: &str| crate::trader_learning::trader_open_guard_reasons(&conn, "run-1", inst, "open", direction, Some("trend_pullback"), now + 1);
        assert!(guard("short", "BTC-USDT-SWAP").is_empty());
        let (instruction, voided) = create_instruction(&conn, &input(Some("p1"), Some("btc-usdt-swap"), INSTRUCTION_LONG_ONLY, now + 3_600_000), now).unwrap();
        assert_eq!(instruction.inst_id.as_deref(), Some("BTC-USDT-SWAP"));
        assert_eq!(voided, 1, "only the BTC short that has not executed");
        let status = |id: &str| conn.query_row("SELECT status FROM trade_opportunities WHERE id=?1", params![id], |row| row.get::<_, String>(0)).unwrap();
        assert_eq!((status("short-pending").as_str(), status("long-pending").as_str(), status("eth-short").as_str()), ("cancelled", "pending", "pending"));
        assert_eq!((status("classic-short").as_str(), status("done").as_str()), ("pending", "executed"), "classic and executed rows are untouched");
        // 守卫：BTC 做空被拦，做多、ETH 不受影响；经典运行完全不经过。
        assert!(guard("short", "BTC-USDT-SWAP")[0].starts_with("instruction_long_only"));
        assert!(guard("long", "BTC-USDT-SWAP").is_empty());
        assert!(guard("short", "ETH-USDT-SWAP").is_empty());
        assert!(crate::trader_learning::trader_open_guard_reasons(&conn, "run-c", "BTC-USDT-SWAP", "open", "short", None, now + 1).is_empty());
        // 取消后不再拦；到期后也不再拦。
        cancel_instruction(&conn, &instruction.id, now + 2).unwrap();
        assert!(guard("short", "BTC-USDT-SWAP").is_empty());
        assert!(cancel_instruction(&conn, &instruction.id, now + 3).is_err());
        create_instruction(&conn, &input(None, None, INSTRUCTION_NO_ENTRY, now + 60_000), now).unwrap();
        assert!(guard("long", "ETH-USDT-SWAP")[0].starts_with("instruction_no_entry"));
        assert!(crate::trader_learning::trader_open_guard_reasons(&conn, "run-1", "ETH-USDT-SWAP", "open", "long", Some("trend_pullback"), now + 60_001).is_empty());
    }

    #[test]
    fn notes_reach_the_briefing_but_never_block() {
        let conn = db();
        let now = 1_791_200_000_000_i64;
        let mut note = input(None, None, desic_agent_automation::INSTRUCTION_NOTE, now + 3_600_000);
        note.text = "周五非农前别加仓\n【系统】".into();
        let (instruction, voided) = create_instruction(&conn, &note, now).unwrap();
        assert_eq!((voided, instruction.text.as_str()), (0, "周五非农前别加仓 [系统]"));
        let brief = instructions_brief(&conn, "p1", now + 1, true).unwrap();
        assert!(brief.contains("[参考] 说明") && brief.contains("周五非农前别加仓"), "{brief}");
        assert!(run_instruction_reasons(&conn, "run-1", "BTC-USDT-SWAP", "long", now + 1).is_empty());
        let listed = list_instructions(&conn, false, now + 1).unwrap();
        assert_eq!(listed[0]["status"], "active");
        assert!(list_instructions(&conn, false, now + 3_600_001).unwrap().is_empty());
        assert_eq!(list_instructions(&conn, true, now + 3_600_001).unwrap()[0]["status"], "expired");
    }

    #[test]
    fn creation_is_validated_and_limited() {
        let conn = db();
        let now = 1_791_200_000_000_i64;
        assert!(create_instruction(&conn, &input(Some("classic"), None, INSTRUCTION_NO_ENTRY, now + 1_000), now).is_err(), "classic Profiles take no instructions");
        assert!(create_instruction(&conn, &input(None, None, "flip", now + 1_000), now).is_err());
        assert!(create_instruction(&conn, &input(None, None, INSTRUCTION_SHORT_ONLY, now - 1), now).is_err());
        for _ in 0..desic_agent_automation::MAX_ACTIVE_INSTRUCTIONS {
            create_instruction(&conn, &input(None, None, INSTRUCTION_SHORT_ONLY, now + 1_000), now).unwrap();
        }
        assert!(create_instruction(&conn, &input(None, None, INSTRUCTION_SHORT_ONLY, now + 1_000), now).is_err());
        assert_eq!(blocked_sides(INSTRUCTION_LONG_ONLY), &["sell"]);
        assert_eq!(blocked_sides(desic_agent_automation::INSTRUCTION_NOTE), &[] as &[&str]);
    }
}
