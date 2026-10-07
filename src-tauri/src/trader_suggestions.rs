//! 由纠正生成的交易手册修改建议（优化建议里 `kind = handbook` 的那一类）。
//!
//! 同一本手册的同一形态，30 天内攒够 3 条还没被建议用过的纠正 → 生成一条建议（只记录纠正，不自动起草）；
//! 用户点「让 AI 起草修改」后按纠正改写这个形态，写出改动、预期（假设，不是保证）与风险；
//! 采用时检查基础版次仍是最新，直接替换原形态（id 与状态不变、暂停保留），发布新版次，可一键回退。
//! Skill 建议的流程完全不经过这里。

use super::*;
use desic_agent_automation::HandbookSetup;

pub(crate) const SUGGESTION_KIND_HANDBOOK: &str = "handbook";
/// 同一形态攒够这么多条纠正才生成建议。
pub(crate) const SUGGESTION_MIN_CORRECTIONS: usize = 3;
const SUGGESTION_WINDOW_MS: i64 = 30 * 24 * 60 * 60_000;
const OPEN_STATUSES_SQL: &str = "('pending_review','validating','ready')";

/// 优化建议表的新列。在 `migrate_ai_automation` 里、建议表建好之后调用。
pub(crate) fn migrate_handbook_suggestions(conn: &Connection) {
    for sql in [
        "ALTER TABLE ai_optimization_suggestions ADD COLUMN kind TEXT NOT NULL DEFAULT 'skill'",
        "ALTER TABLE ai_optimization_suggestions ADD COLUMN target_handbook_id TEXT",
        "ALTER TABLE ai_optimization_suggestions ADD COLUMN target_handbook_revision INTEGER",
        "ALTER TABLE ai_optimization_suggestions ADD COLUMN target_setup_id TEXT",
        "ALTER TABLE ai_optimization_suggestions ADD COLUMN proposed_handbook_json TEXT",
        "ALTER TABLE ai_optimization_suggestions ADD COLUMN source_json TEXT",
        "ALTER TABLE ai_optimization_suggestions ADD COLUMN draft_error TEXT",
    ] {
        let _ = conn.execute(sql, []);
    }
}

struct CorrectionRow {
    id: String,
    category: String,
    text: String,
    inst_id: String,
    side: Option<String>,
    action: String,
    shadow_r: Option<f64>,
    real_r: Option<f64>,
    updated_at: i64,
}

fn correction_rows(conn: &Connection, filter_sql: &str, values: &[&dyn rusqlite::ToSql]) -> Result<Vec<CorrectionRow>, String> {
    let sql = format!(
        "SELECT c.id,c.category,c.text,c.inst_id,d.side,d.action,d.shadow_r,d.real_r,c.updated_at
         FROM ai_trader_corrections c JOIN ai_trader_decisions d ON d.id=c.decision_id
         WHERE c.deleted_at IS NULL AND {filter_sql} ORDER BY c.updated_at"
    );
    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(values, |row| {
            Ok(CorrectionRow {
                id: row.get(0)?,
                category: row.get(1)?,
                text: row.get(2)?,
                inst_id: row.get(3)?,
                side: row.get(4)?,
                action: row.get(5)?,
                shadow_r: row.get(6)?,
                real_r: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())
}

/// 一条纠正的文字（证据列表、起草提示都用它）：时间、品种、方向、决定、类别、意见、当时的结果。
fn correction_line(row: &CorrectionRow) -> String {
    let side = match row.side.as_deref() {
        Some("long") => " 做多",
        Some("short") => " 做空",
        _ => "",
    };
    let result = match (row.real_r, row.shadow_r) {
        (Some(r), _) => format!("真实结果 {r:+.2}R"),
        (None, Some(r)) => format!("影子结果 {r:+.2}R"),
        _ => "结果未出".to_string(),
    };
    let text = if row.text.trim().is_empty() { String::new() } else { format!("：{}", row.text.trim()) };
    format!(
        "- {} {}{side} {}｜{}{text}（{result}）",
        crate::ai_briefing::shanghai_label(row.updated_at, false),
        row.inst_id,
        row.action,
        desic_agent_automation::correction_category_label(&row.category, true)
    )
}

/// 保存纠正之后调用：同一形态攒够 3 条还没被用过的纠正、且没有待处理的同类建议时，生成一条手册建议。
/// 返回新建议的 id。
pub(crate) fn maybe_create_handbook_suggestion(conn: &Connection, handbook_id: &str, setup_id: &str, now: i64) -> Result<Option<String>, String> {
    crate::trader_handbooks::with_write_txn(conn, |conn| {
        let rows = correction_rows(
            conn,
            "c.handbook_id=?1 AND c.setup_id=?2 AND c.suggestion_id IS NULL AND c.updated_at>=?3",
            &[&handbook_id, &setup_id, &(now - SUGGESTION_WINDOW_MS)],
        )?;
        if rows.len() < SUGGESTION_MIN_CORRECTIONS {
            return Ok(None);
        }
        let open: i64 = conn
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM ai_optimization_suggestions
                     WHERE kind='handbook' AND target_handbook_id=?1 AND target_setup_id=?2 AND status IN {OPEN_STATUSES_SQL}"
                ),
                params![handbook_id, setup_id],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?;
        if open > 0 {
            return Ok(None);
        }
        let loaded = crate::trader_handbooks::load_handbook(conn, Some(handbook_id));
        if loaded.id != handbook_id || loaded.revision == 0 {
            return Ok(None);
        }
        let Some(setup) = desic_agent_automation::find_setup(&loaded.handbook, setup_id) else {
            return Ok(None);
        };
        let mut counts: Vec<(String, usize)> = Vec::new();
        for row in &rows {
            let label = desic_agent_automation::correction_category_label(&row.category, true).to_string();
            match counts.iter_mut().find(|(existing, _)| *existing == label) {
                Some((_, count)) => *count += 1,
                None => counts.push((label, 1)),
            }
        }
        let summary = counts.iter().map(|(label, count)| format!("{label} {count}")).collect::<Vec<_>>().join("、");
        let id = format!("suggestion-{}", crate::ai_automation::unique_suffix());
        let title = format!("交易手册建议：「{}」近 30 天被你纠正了 {} 次", setup.name, rows.len());
        let problem = format!(
            "你对形态 {}（{}）的 {} 条纠正：{summary}。可以让 AI 按这些纠正起草修改，看过前后差异再决定是否采用；采用后会发布手册的新版次，随时可以回退。",
            setup.id,
            setup.name,
            rows.len()
        );
        let evidence = rows.iter().map(correction_line).collect::<Vec<_>>();
        conn.execute(
            "INSERT INTO ai_optimization_suggestions(
               id,review_id,title,problem,evidence_json,sample_size,current_skill_id,current_skill_version,
               proposed_changes,proposed_skill_json,benefits,risks,status,created_at,updated_at,
               kind,target_handbook_id,target_handbook_revision,target_setup_id,proposed_handbook_json,source_json,draft_error
             ) VALUES (?1,NULL,?2,?3,?4,?5,NULL,NULL,'',NULL,'','','pending_review',?6,?6,'handbook',?7,?8,?9,NULL,?10,NULL)",
            params![
                id,
                title,
                problem,
                serde_json::to_string(&evidence).map_err(|err| err.to_string())?,
                rows.len() as i64,
                now,
                handbook_id,
                loaded.revision,
                setup_id,
                json!({ "correctionIds": rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>() }).to_string(),
            ],
        )
        .map_err(|err| err.to_string())?;
        for row in &rows {
            conn.execute("UPDATE ai_trader_corrections SET suggestion_id=?2 WHERE id=?1", params![row.id, id])
                .map_err(|err| err.to_string())?;
        }
        Ok(Some(id))
    })
}

struct HandbookSuggestion {
    kind: String,
    status: String,
    handbook_id: Option<String>,
    revision: Option<i64>,
    setup_id: Option<String>,
    proposed: Option<String>,
    source: Option<String>,
}

fn load_handbook_suggestion(conn: &Connection, id: &str) -> Result<HandbookSuggestion, String> {
    conn.query_row(
        "SELECT kind,status,target_handbook_id,target_handbook_revision,target_setup_id,proposed_handbook_json,source_json
         FROM ai_optimization_suggestions WHERE id=?1",
        params![id],
        |row| {
            Ok(HandbookSuggestion {
                kind: row.get(0)?,
                status: row.get(1)?,
                handbook_id: row.get(2)?,
                revision: row.get(3)?,
                setup_id: row.get(4)?,
                proposed: row.get(5)?,
                source: row.get(6)?,
            })
        },
    )
    .optional()
    .map_err(|err| err.to_string())?
    .ok_or_else(|| "优化建议不存在".to_string())
}

/// 这条建议是不是手册建议（`ai_optimization_suggestion_update` 先按它分流）。
pub(crate) fn is_handbook_suggestion(conn: &Connection, id: &str) -> bool {
    conn.query_row("SELECT kind FROM ai_optimization_suggestions WHERE id=?1", params![id], |row| row.get::<_, String>(0))
        .ok()
        .is_some_and(|kind| kind == SUGGESTION_KIND_HANDBOOK)
}

/// 采用：基础版次仍是这本手册的最新版次时，用起草的形态替换原形态（id、状态不变，暂停保留），发布新版次。
pub(crate) fn apply_handbook_suggestion(conn: &Connection, id: &str, now: i64) -> Result<(), String> {
    crate::trader_handbooks::with_write_txn(conn, |conn| {
        let suggestion = load_handbook_suggestion(conn, id)?;
        if suggestion.kind != SUGGESTION_KIND_HANDBOOK {
            return Err("这不是交易手册建议".to_string());
        }
        match suggestion.status.as_str() {
            "applied" => return Ok(()),
            "rejected" => return Err("已拒绝的建议不能采用".to_string()),
            _ => {}
        }
        let (Some(handbook_id), Some(base), Some(setup_id)) = (suggestion.handbook_id.as_deref(), suggestion.revision, suggestion.setup_id.as_deref()) else {
            return Err("这条手册建议缺少目标手册或形态".to_string());
        };
        let proposed = suggestion
            .proposed
            .as_deref()
            .ok_or_else(|| "还没有起草修改：先让 AI 起草，看过差异再采用".to_string())?;
        let mut proposed = serde_json::from_str::<HandbookSetup>(proposed).map_err(|error| format!("起草的形态无效：{error}"))?;
        let current = crate::trader_handbooks::load_handbook(conn, Some(handbook_id));
        if current.id != handbook_id {
            return Err("目标手册读不到".to_string());
        }
        if current.revision != base {
            return Err(format!(
                "这本手册已经更新到第 {} 版，这条建议是按第 {base} 版起草的；为避免覆盖后来的修改，不能直接采用，请重新起草",
                current.revision
            ));
        }
        let mut handbook = current.handbook.clone();
        let slot = handbook
            .setups
            .iter_mut()
            .find(|setup| setup.id == setup_id)
            .ok_or_else(|| format!("手册里已经没有形态 {setup_id}"))?;
        proposed.id = slot.id.clone();
        proposed.status = slot.status.clone();
        *slot = proposed;
        let note = format!("采用手册建议：改写形态 {setup_id}");
        crate::trader_handbooks::publish_handbook_revision(conn, handbook_id, handbook, Some(base), "suggestion", Some(&note), Some(id), now)?;
        conn.execute("UPDATE ai_optimization_suggestions SET status='applied',updated_at=?2 WHERE id=?1", params![id, now])
            .map_err(|err| err.to_string())?;
        Ok(())
    })
}

/// 手册建议在列表里需要的额外信息：基础版次里的原形态、起草的新形态、起草失败的原因、用这本手册的 Profile。
pub(crate) fn handbook_suggestion_extras(conn: &Connection, id: &str) -> Value {
    let Ok(suggestion) = load_handbook_suggestion(conn, id) else {
        return Value::Null;
    };
    let handbook_id = suggestion.handbook_id.clone().unwrap_or_default();
    let baseline = suggestion.revision.and_then(|revision| {
        conn.query_row(
            "SELECT content_json FROM ai_trader_handbooks WHERE handbook_id=?1 AND COALESCE(revision,version)=?2",
            params![handbook_id, revision],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|text| serde_json::from_str::<desic_agent_automation::Handbook>(&text).ok())
        .and_then(|handbook| suggestion.setup_id.as_deref().and_then(|setup_id| desic_agent_automation::find_setup(&handbook, setup_id).cloned()))
    });
    let draft_error: Option<String> = conn
        .query_row("SELECT draft_error FROM ai_optimization_suggestions WHERE id=?1", params![id], |row| row.get(0))
        .ok()
        .flatten();
    json!({
        "handbookId": suggestion.handbook_id,
        "handbookName": crate::trader_handbooks::load_handbook(conn, Some(&handbook_id)).name,
        "handbookRevision": suggestion.revision,
        "setupId": suggestion.setup_id,
        "baselineSetup": baseline,
        "proposedSetup": suggestion.proposed.as_deref().and_then(|text| serde_json::from_str::<Value>(text).ok()),
        "draftError": draft_error,
        "usedBy": crate::trader_handbooks::handbook_users(conn, &handbook_id),
    })
}

/// 让 AI 按纠正起草修改：用这本手册当前的形态（并把基础版次更新为当前版次），结果写回建议。
#[tauri::command]
pub(crate) async fn ai_handbook_suggestion_draft(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, AiRuntime>,
    id: String,
    model: Option<String>,
    request_id: Option<String>,
) -> Result<Value, String> {
    let worker_app = app.clone();
    let suggestion_id = id.clone();
    let (setup, revision, lines) = crate::blocking_work::run_blocking(move || {
        let conn = open_read_database(&worker_app)?;
        let suggestion = load_handbook_suggestion(&conn, &suggestion_id)?;
        if suggestion.kind != SUGGESTION_KIND_HANDBOOK {
            return Err("这不是交易手册建议".to_string());
        }
        if matches!(suggestion.status.as_str(), "applied" | "rejected") {
            return Err("这条建议已经处理过了".to_string());
        }
        let handbook_id = suggestion.handbook_id.clone().ok_or_else(|| "建议缺少目标手册".to_string())?;
        let setup_id = suggestion.setup_id.clone().ok_or_else(|| "建议缺少目标形态".to_string())?;
        let loaded = crate::trader_handbooks::load_handbook(&conn, Some(&handbook_id));
        if loaded.id != handbook_id {
            return Err("目标手册读不到".to_string());
        }
        let setup = desic_agent_automation::find_setup(&loaded.handbook, &setup_id)
            .cloned()
            .ok_or_else(|| format!("手册里已经没有形态 {setup_id}"))?;
        let ids = suggestion
            .source
            .as_deref()
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
            .and_then(|value| value.get("correctionIds").cloned())
            .and_then(|value| serde_json::from_value::<Vec<String>>(value).ok())
            .unwrap_or_default();
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let values = ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect::<Vec<_>>();
        let rows = if ids.is_empty() { Vec::new() } else { correction_rows(&conn, &format!("c.id IN ({placeholders})"), &values)? };
        if rows.is_empty() {
            return Err("这条建议关联的纠正都被删掉了".to_string());
        }
        Ok((setup, loaded.revision, rows.iter().map(correction_line).collect::<Vec<_>>()))
    })
    .await?;
    let outcome = crate::trader_drafts::draft_setup_revision(&app, runtime.inner(), &setup, &lines, model.as_deref(), request_id.as_deref()).await;
    if let Err(error) = &outcome {
        if error.contains("已取消") {
            return Err(error.clone());
        }
    }
    let worker_app = app.clone();
    crate::blocking_work::run_serial(move || {
        let conn = crate::ai_automation::open_automation_database(&worker_app)?;
        let now = now_ms();
        match &outcome {
            Ok(draft) => conn.execute(
                "UPDATE ai_optimization_suggestions SET proposed_handbook_json=?2,proposed_changes=?3,benefits=?4,risks=?5,
                   target_handbook_revision=?6,draft_error=NULL,updated_at=?7 WHERE id=?1",
                params![
                    id,
                    serde_json::to_string(&draft.setup).map_err(|err| err.to_string())?,
                    draft.changes,
                    draft.benefits,
                    draft.risks,
                    revision,
                    now
                ],
            ),
            Err(error) => conn.execute(
                "UPDATE ai_optimization_suggestions SET draft_error=?2,updated_at=?3 WHERE id=?1",
                params![id, error, now],
            ),
        }
        .map_err(|err| err.to_string())?;
        let mut summary = serde_json::to_value(crate::ai_automation::load_optimization_suggestion(&conn, &id)?).map_err(|err| err.to_string())?;
        if let Ok(draft) = &outcome {
            summary["draftWarnings"] = json!(draft.warnings);
        }
        Ok(summary)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("open");
        crate::ai_automation::migrate_ai_automation(&conn).expect("migrate");
        conn
    }

    fn decision(conn: &Connection, id: &str, setup: &str, created_at: i64) {
        conn.execute(
            "INSERT INTO ai_trader_decisions (id,run_id,profile_id,inst_id,created_at,handbook_version,setup_id,side,action,shadow_status,shadow_r,handbook_id)
             VALUES (?1,'run-1','p1','BTC-USDT-SWAP',?2,1,?3,'short','limit_order','resolved',-1.0,'default')",
            params![id, created_at, setup],
        )
        .unwrap();
    }

    fn correct(conn: &Connection, id: &str, now: i64) -> Option<String> {
        let (handbook, setup) = crate::trader_corrections::save_correction(conn, id, "wrong_direction", "日线上升别做空", now).unwrap();
        maybe_create_handbook_suggestion(conn, &handbook, setup.as_deref().unwrap(), now).unwrap()
    }

    #[test]
    fn three_corrections_create_one_suggestion_and_applying_replaces_the_setup() {
        let conn = db();
        let now = 1_791_200_000_000_i64;
        for index in 0..5 {
            decision(&conn, &format!("d{index}"), "range_edge", now - 1_000 + index);
        }
        crate::trader_handbooks::set_setup_pause(&conn, "default", "range_edge", Some("up"), Some("short"), true, None, now - 500).unwrap();
        assert!(correct(&conn, "d0", now).is_none());
        assert!(correct(&conn, "d1", now + 1).is_none());
        let id = correct(&conn, "d2", now + 2).expect("third correction creates a suggestion");
        assert!(correct(&conn, "d3", now + 3).is_none(), "no second suggestion while one is open");
        let (kind, sample, status): (String, i64, String) = conn
            .query_row("SELECT kind,sample_size,status FROM ai_optimization_suggestions WHERE id=?1", params![id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap();
        assert_eq!((kind.as_str(), sample, status.as_str()), ("handbook", 3, "pending_review"));
        // 还没起草：不能采用。
        assert!(apply_handbook_suggestion(&conn, &id, now + 4).unwrap_err().contains("先让 AI 起草"));
        let current = crate::trader_handbooks::load_handbook(&conn, None);
        let mut proposed = desic_agent_automation::find_setup(&current.handbook, "range_edge").unwrap().clone();
        proposed.entry = "等 1h 收盘拒绝再入场".into();
        proposed.status = "observing".into();
        conn.execute("UPDATE ai_optimization_suggestions SET proposed_handbook_json=?2 WHERE id=?1", params![id, serde_json::to_string(&proposed).unwrap()]).unwrap();
        let extras = handbook_suggestion_extras(&conn, &id);
        assert_eq!(extras["baselineSetup"]["id"], "range_edge");
        assert_eq!(extras["proposedSetup"]["entry"], "等 1h 收盘拒绝再入场");
        apply_handbook_suggestion(&conn, &id, now + 5).unwrap();
        let after = crate::trader_handbooks::load_handbook(&conn, None);
        let setup = desic_agent_automation::find_setup(&after.handbook, "range_edge").unwrap();
        assert_eq!(setup.entry, "等 1h 收盘拒绝再入场");
        assert_eq!(setup.status, "live", "status stays as it was");
        assert_eq!(after.handbook.paused.len(), 1, "pauses stay");
        assert_eq!(after.revision, current.revision + 1);
        let source: Option<String> = conn.query_row("SELECT source_suggestion_id FROM ai_trader_handbooks WHERE version=?1", params![after.version], |row| row.get(0)).unwrap();
        assert_eq!(source.as_deref(), Some(id.as_str()));
        apply_handbook_suggestion(&conn, &id, now + 6).unwrap();
        assert_eq!(crate::trader_handbooks::load_handbook(&conn, None).revision, after.revision, "applying twice is a no-op");
        // 处理完之后，没被用过的纠正（d3）和新的纠正一起重新攒数。
        decision(&conn, "d5", "range_edge", now + 7);
        assert!(correct(&conn, "d4", now + 9).is_none());
        assert!(correct(&conn, "d5", now + 10).is_some());
    }

    #[test]
    fn a_stale_base_revision_is_refused() {
        let conn = db();
        let now = 1_791_200_000_000_i64;
        for index in 0..3 {
            decision(&conn, &format!("d{index}"), "trend_pullback", now - 1_000 + index);
        }
        let id = (0..3).filter_map(|index| correct(&conn, &format!("d{index}"), now + index)).last().unwrap();
        let current = crate::trader_handbooks::load_handbook(&conn, None);
        let proposed = desic_agent_automation::find_setup(&current.handbook, "trend_pullback").unwrap().clone();
        conn.execute("UPDATE ai_optimization_suggestions SET proposed_handbook_json=?2 WHERE id=?1", params![id, serde_json::to_string(&proposed).unwrap()]).unwrap();
        crate::trader_handbooks::set_setup_status(&conn, "default", "range_edge", "observing", now + 10).unwrap();
        assert!(apply_handbook_suggestion(&conn, &id, now + 11).unwrap_err().contains("不能直接采用"));
        assert!(is_handbook_suggestion(&conn, &id));
    }
}
