//! 用户对交易员决策的纠正：存库（每条决策最多一条，可改、可删）、写进简报，
//! 同一本手册里同一形态 30 天内攒够 3 条就生成一条手册修改建议（见 `trader_suggestions`）。
//! 纯逻辑（类别、简报段落）在 `desic_agent_automation::corrections`。

use super::*;

/// 简报里列最近 14 天、同一本手册的纠正，最多 5 条（本 Profile 的在前）。
const BRIEF_WINDOW_MS: i64 = 14 * 24 * 60 * 60_000;
const BRIEF_LIMIT: usize = 5;

pub(crate) fn migrate_trader_corrections(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_trader_corrections (
           id TEXT PRIMARY KEY,
           decision_id TEXT NOT NULL UNIQUE,
           run_id TEXT NOT NULL,
           profile_id TEXT NOT NULL,
           inst_id TEXT NOT NULL,
           setup_id TEXT,
           handbook_id TEXT NOT NULL,
           category TEXT NOT NULL,
           text TEXT NOT NULL DEFAULT '',
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           suggestion_id TEXT,
           deleted_at INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_ai_trader_corrections_setup ON ai_trader_corrections(handbook_id, setup_id, created_at);",
    )
    .map_err(|err| err.to_string())
}

/// 保存（新建或改写）一条决策的纠正；删过的重新保存会恢复。返回这条纠正所属的（手册, 形态），供生成建议用。
pub(crate) fn save_correction(conn: &Connection, decision_id: &str, category: &str, text: &str, now: i64) -> Result<(String, Option<String>), String> {
    if !desic_agent_automation::valid_correction_category(category) {
        return Err(format!("纠正类别只能是 {}", desic_agent_automation::CORRECTION_CATEGORIES.join(" / ")));
    }
    let text = desic_agent_automation::sanitize_handbook_text(text, true);
    if text.chars().count() > desic_agent_automation::MAX_CORRECTION_TEXT_CHARS {
        return Err(format!("纠正意见最多 {} 个字", desic_agent_automation::MAX_CORRECTION_TEXT_CHARS));
    }
    let (run_id, profile_id, inst_id, setup_id, handbook_id): (String, String, String, Option<String>, String) = conn
        .query_row(
            "SELECT run_id,profile_id,inst_id,setup_id,COALESCE(handbook_id,'default') FROM ai_trader_decisions WHERE id=?1",
            params![decision_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "这条决策不存在".to_string())?;
    conn.execute(
        "INSERT INTO ai_trader_corrections (id,decision_id,run_id,profile_id,inst_id,setup_id,handbook_id,category,text,created_at,updated_at,suggestion_id,deleted_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,NULL,NULL)
         ON CONFLICT(decision_id) DO UPDATE SET category=excluded.category,text=excluded.text,updated_at=excluded.updated_at,deleted_at=NULL",
        params![format!("correction-{decision_id}"), decision_id, run_id, profile_id, inst_id, setup_id, handbook_id, category, text, now],
    )
    .map_err(|err| err.to_string())?;
    Ok((handbook_id, setup_id))
}

pub(crate) fn delete_correction(conn: &Connection, decision_id: &str, now: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE ai_trader_corrections SET deleted_at=?2,updated_at=?2 WHERE decision_id=?1 AND deleted_at IS NULL",
        params![decision_id, now],
    )
    .map(|_| ())
    .map_err(|err| err.to_string())
}

/// 写进简报的「你的纠正」：最近 14 天、本轮这本手册下的纠正，本 Profile 的在前，最多 5 条。
pub(crate) fn corrections_brief(conn: &Connection, profile_id: &str, handbook_id: &str, now: i64, chinese: bool) -> Option<String> {
    let sql = "SELECT c.updated_at,c.inst_id,c.setup_id,d.side,d.action,c.category,c.text,d.shadow_r,d.real_r,c.profile_id
               FROM ai_trader_corrections c JOIN ai_trader_decisions d ON d.id=c.decision_id
               WHERE c.deleted_at IS NULL AND c.handbook_id=?1 AND c.updated_at>=?2
               ORDER BY (c.profile_id=?3) DESC, c.updated_at DESC LIMIT ?4";
    let mut stmt = match conn.prepare(sql) {
        Ok(stmt) => stmt,
        Err(error) => {
            crate::boot_log(&format!("trader corrections brief query failed: {error}"));
            return None;
        }
    };
    let notes = stmt
        .query_map(params![handbook_id, now - BRIEF_WINDOW_MS, profile_id, BRIEF_LIMIT as i64], |row| {
            Ok(desic_agent_automation::CorrectionNote {
                at_label: crate::ai_briefing::shanghai_label(row.get::<_, i64>(0)?, false),
                inst_id: row.get(1)?,
                setup_id: row.get(2)?,
                side: row.get(3)?,
                action: row.get(4)?,
                category: row.get(5)?,
                text: row.get(6)?,
                shadow_r: row.get(7)?,
                real_r: row.get(8)?,
                own_profile: row.get::<_, String>(9)? == profile_id,
            })
        })
        .map(|rows| rows.filter_map(Result::ok).collect::<Vec<_>>())
        .unwrap_or_default();
    desic_agent_automation::render_corrections(&notes, chinese)
}

/// 保存纠正。同一形态攒够数量时生成一条手册修改建议，并发出 `suggestionCreated` 事件。
#[tauri::command]
pub(crate) async fn ai_trader_correction_save(app: tauri::AppHandle, decision_id: String, category: String, text: Option<String>) -> Result<Value, String> {
    let worker_app = app.clone();
    let suggestion = crate::blocking_work::run_serial(move || {
        let conn = crate::ai_automation::open_automation_database(&worker_app)?;
        let now = now_ms();
        let (handbook_id, setup_id) = save_correction(&conn, decision_id.trim(), category.trim(), text.as_deref().unwrap_or_default(), now)?;
        Ok::<_, String>(match setup_id {
            Some(setup_id) => crate::trader_suggestions::maybe_create_handbook_suggestion(&conn, &handbook_id, &setup_id, now)?,
            None => None,
        })
    })
    .await?;
    if let Some(id) = suggestion.as_deref() {
        let _ = app.emit(
            crate::ai_automation::AUTOMATION_EVENT,
            json!({
                "type": "suggestionCreated",
                "message": "同一个形态被你纠正了多次，生成了一条交易手册修改建议",
                "action": { "tab": "optimization", "id": id },
            }),
        );
    }
    Ok(json!({ "suggestionId": suggestion }))
}

#[tauri::command]
pub(crate) async fn ai_trader_correction_delete(app: tauri::AppHandle, decision_id: String) -> Result<(), String> {
    crate::blocking_work::run_serial(move || {
        let conn = crate::ai_automation::open_automation_database(&app)?;
        delete_correction(&conn, decision_id.trim(), now_ms())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn decisions_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open");
        crate::trader_learning::migrate_trader_learning(&conn).expect("migrate");
        conn
    }

    pub(crate) fn decision(conn: &Connection, id: &str, profile: &str, setup: &str, created_at: i64) {
        conn.execute(
            "INSERT INTO ai_trader_decisions (id,run_id,profile_id,inst_id,created_at,handbook_version,setup_id,side,action,shadow_status,shadow_r,handbook_id)
             VALUES (?1,'run-1',?2,'BTC-USDT-SWAP',?3,1,?4,'short','limit_order','resolved',-1.0,'default')",
            params![id, profile, created_at, setup],
        )
        .unwrap();
    }

    #[test]
    fn corrections_upsert_soft_delete_and_reach_the_briefing() {
        let conn = decisions_db();
        let now = 1_791_200_000_000_i64;
        decision(&conn, "d1", "p1", "range_edge", now - 60_000);
        decision(&conn, "d2", "p2", "range_edge", now - 30_000);
        assert!(save_correction(&conn, "d1", "lucky", "", now).is_err());
        assert!(save_correction(&conn, "missing", "other", "", now).is_err());
        assert_eq!(save_correction(&conn, "d1", "wrong_direction", "日线上升\n别做空", now).unwrap(), ("default".into(), Some("range_edge".into())));
        save_correction(&conn, "d1", "bad_location", "位置太靠中间", now + 1).unwrap();
        save_correction(&conn, "d2", "wrong_regime", "", now + 2).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM ai_trader_corrections", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 2, "one correction per decision");
        let brief = corrections_brief(&conn, "p1", "default", now + 3, true).unwrap();
        let first = brief.lines().nth(1).unwrap();
        assert!(first.contains("位置不好：位置太靠中间") && first.contains("影子结果 -1.00R"), "{brief}");
        assert!(brief.lines().nth(2).unwrap().contains("其他交易员 Profile"), "{brief}");
        assert!(corrections_brief(&conn, "p1", "handbook-other", now + 3, true).is_none(), "other handbooks are not mixed in");
        delete_correction(&conn, "d2", now + 4).unwrap();
        assert_eq!(corrections_brief(&conn, "p1", "default", now + 5, true).unwrap().lines().count(), 2);
        // 删过的重新保存会恢复。
        save_correction(&conn, "d2", "other", "再看看", now + 6).unwrap();
        assert_eq!(corrections_brief(&conn, "p1", "default", now + 7, true).unwrap().lines().count(), 3);
        // 超过 14 天的不再写进简报。
        assert!(corrections_brief(&conn, "p1", "default", now + 15 * 24 * 60 * 60_000, true).is_none());
    }
}
