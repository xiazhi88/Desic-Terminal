//! 交易复盘：用户给每笔已平仓位打的标签 / 笔记，以及「这笔仓位有没有挂止损」的匹配。
//!
//! 笔记存在独立的表里，**不放进 `position_episodes.notes`**：仓位记录会在同步后被整体删除重建，
//! 笔记必须用 (账户, 环境, 仓位 id) 做键并且不受重建影响。仓位 id 是稳定的
//! （`pe-{inst}-{side}-{首笔成交时间}` 或 `pe-official-…`）。

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_TAGS: usize = 8;
const MAX_TAG_CHARS: usize = 12;
const MAX_NOTE_CHARS: usize = 2000;
const MAX_EPISODES_PER_QUERY: usize = 300;
/// 止损可能在开仓前后一小段时间内挂上；窗口两端各放宽一点。
const PROTECTION_LEAD_MS: i64 = 2 * 60_000;
const PROTECTION_TAIL_MS: i64 = 60_000;

pub(crate) fn migrate_trade_review(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS trade_review_notes (
           account_id TEXT NOT NULL,
           environment TEXT NOT NULL,
           episode_id TEXT NOT NULL,
           tags_json TEXT NOT NULL DEFAULT '[]',
           note TEXT NOT NULL DEFAULT '',
           updated_at INTEGER NOT NULL,
           PRIMARY KEY (account_id, environment, episode_id)
         );",
    )
    .map_err(|error| format!("创建交易复盘笔记表失败：{error}"))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TradeReviewNote {
    pub episode_id: String,
    pub tags: Vec<String>,
    pub note: String,
    pub updated_at: i64,
}

fn clean_tags(tags: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for raw in tags {
        let tag: String = raw.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string();
        if tag.is_empty() {
            continue;
        }
        if tag.chars().count() > MAX_TAG_CHARS {
            return Err(format!("标签不能超过 {MAX_TAG_CHARS} 个字：{tag}"));
        }
        if !out.iter().any(|existing| existing.eq_ignore_ascii_case(&tag)) {
            out.push(tag);
        }
    }
    if out.len() > MAX_TAGS {
        return Err(format!("每笔最多 {MAX_TAGS} 个标签"));
    }
    Ok(out)
}

pub(crate) fn list_notes(conn: &Connection, account_id: &str, environment: &str) -> Result<Vec<TradeReviewNote>, String> {
    let mut stmt = conn
        .prepare("SELECT episode_id, tags_json, note, updated_at FROM trade_review_notes WHERE account_id = ?1 AND environment = ?2")
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![account_id, environment], |row| {
            let tags_json: String = row.get(1)?;
            Ok(TradeReviewNote {
                episode_id: row.get(0)?,
                tags: serde_json::from_str::<Vec<String>>(&tags_json).unwrap_or_default(),
                note: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

/// 保存一笔的标签与笔记；标签和笔记都为空时删除这一行。返回保存后的内容（已清洗），删除时返回 `None`。
pub(crate) fn save_note(
    conn: &Connection,
    account_id: &str,
    environment: &str,
    episode_id: &str,
    tags: &[String],
    note: &str,
    now_ms: i64,
) -> Result<Option<TradeReviewNote>, String> {
    let episode_id = episode_id.trim();
    if episode_id.is_empty() || episode_id.chars().count() > 160 || episode_id.chars().any(|c| c.is_control()) {
        return Err("仓位 id 不合法".to_string());
    }
    let tags = clean_tags(tags)?;
    let note: String = note.chars().filter(|c| !c.is_control() || matches!(c, '\n' | '\t')).collect::<String>().trim().to_string();
    if note.chars().count() > MAX_NOTE_CHARS {
        return Err(format!("笔记不能超过 {MAX_NOTE_CHARS} 个字"));
    }
    if tags.is_empty() && note.is_empty() {
        conn.execute(
            "DELETE FROM trade_review_notes WHERE account_id = ?1 AND environment = ?2 AND episode_id = ?3",
            params![account_id, environment, episode_id],
        )
        .map_err(|error| error.to_string())?;
        return Ok(None);
    }
    let tags_json = serde_json::to_string(&tags).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO trade_review_notes (account_id, environment, episode_id, tags_json, note, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(account_id, environment, episode_id)
         DO UPDATE SET tags_json = excluded.tags_json, note = excluded.note, updated_at = excluded.updated_at",
        params![account_id, environment, episode_id, tags_json, note, now_ms],
    )
    .map_err(|error| error.to_string())?;
    Ok(Some(TradeReviewNote { episode_id: episode_id.to_string(), tags, note, updated_at: now_ms }))
}

// ───────────────────────────── 止损匹配 ─────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EpisodeProbe {
    pub episode_id: String,
    pub inst_id: String,
    /// `long` / `short`
    pub side: String,
    pub open_time: i64,
    pub close_time: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Protection {
    pub episode_id: String,
    pub had_stop: bool,
    pub stop_px: Option<f64>,
    pub tp_px: Option<f64>,
    /// 止损单是否真的被触发（状态为 effective）。
    pub stop_triggered: bool,
}

fn positive_price(value: Option<&Value>) -> Option<f64> {
    let parsed = match value? {
        Value::String(text) => text.trim().parse::<f64>().ok()?,
        Value::Number(number) => number.as_f64()?,
        _ => return None,
    };
    (parsed.is_finite() && parsed > 0.0).then_some(parsed)
}

/// 平仓方向：多头靠 `sell` 平，空头靠 `buy` 平。
fn closing_side(episode_side: &str) -> &'static str {
    if episode_side == "short" { "buy" } else { "sell" }
}

/// 在条件单（algo）历史里找出覆盖这笔仓位的止损 / 止盈。这是**匹配启发式**：
/// 同合约、平仓方向一致、挂单时间落在仓位生命期（前后略放宽）内，且带有止损触发价。
/// 取该窗口内最晚挂上的一个作为「止损价」。找不到不等于没挂过（可能没同步到历史），界面应标成估计。
pub(crate) fn protection_for(conn: &Connection, account_id: &str, environment: &str, probes: &[EpisodeProbe]) -> Result<Vec<Protection>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT side, state, okx_ctime, raw_json FROM okx_orders
             WHERE account_id = ?1 AND environment = ?2 AND inst_id = ?3
               AND source_endpoint LIKE '%algo%'
               AND okx_ctime BETWEEN ?4 AND ?5
             ORDER BY okx_ctime ASC",
        )
        .map_err(|error| error.to_string())?;
    let mut out = Vec::with_capacity(probes.len().min(MAX_EPISODES_PER_QUERY));
    for probe in probes.iter().take(MAX_EPISODES_PER_QUERY) {
        let from = probe.open_time - PROTECTION_LEAD_MS;
        let to = probe.close_time.unwrap_or(i64::MAX / 2).saturating_add(PROTECTION_TAIL_MS);
        let wanted = closing_side(&probe.side);
        let rows = stmt
            .query_map(params![account_id, environment, probe.inst_id, from, to], |row| {
                Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(3)?))
            })
            .map_err(|error| error.to_string())?;
        let mut result = Protection { episode_id: probe.episode_id.clone(), had_stop: false, stop_px: None, tp_px: None, stop_triggered: false };
        for row in rows {
            let (side, state, raw) = row.map_err(|error| error.to_string())?;
            if side.as_deref().is_some_and(|value| !value.is_empty() && value != wanted) {
                continue;
            }
            if state.as_deref() == Some("order_failed") {
                continue;
            }
            let Ok(json) = serde_json::from_str::<Value>(&raw) else { continue };
            if let Some(stop) = positive_price(json.get("slTriggerPx")) {
                result.had_stop = true;
                result.stop_px = Some(stop);
                result.stop_triggered = state.as_deref() == Some("effective");
            }
            if let Some(tp) = positive_price(json.get("tpTriggerPx")) {
                result.tp_px = Some(tp);
            }
        }
        out.push(result);
    }
    Ok(out)
}

// ───────────────────────────── Tauri 命令 ─────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotesRequest {
    account_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveNoteRequest {
    account_id: Option<String>,
    episode_id: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    note: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProtectionRequest {
    account_id: Option<String>,
    episodes: Vec<EpisodeProbe>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as i64).unwrap_or(0)
}

#[tauri::command]
pub(crate) async fn trade_review_notes(app: tauri::AppHandle, request: NotesRequest) -> Result<Vec<TradeReviewNote>, String> {
    crate::blocking_work::run_blocking(move || {
        let account = crate::load_local_account_secret(&app, request.account_id.as_deref())?;
        let conn = crate::open_database(&app)?;
        list_notes(&conn, &account.id, &account.environment)
    })
    .await
}

#[tauri::command]
pub(crate) async fn trade_review_note_save(app: tauri::AppHandle, request: SaveNoteRequest) -> Result<Option<TradeReviewNote>, String> {
    crate::blocking_work::run_serial(move || {
        let account = crate::load_local_account_secret(&app, request.account_id.as_deref())?;
        let conn = crate::open_database(&app)?;
        save_note(&conn, &account.id, &account.environment, &request.episode_id, &request.tags, &request.note, now_ms())
    })
    .await
}

#[tauri::command]
pub(crate) async fn trade_review_protection(app: tauri::AppHandle, request: ProtectionRequest) -> Result<Vec<Protection>, String> {
    crate::blocking_work::run_blocking(move || {
        let account = crate::load_local_account_secret(&app, request.account_id.as_deref())?;
        let conn = crate::open_database(&app)?;
        protection_for(&conn, &account.id, &account.environment, &request.episodes)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate_trade_review(&conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE okx_orders (account_id TEXT, environment TEXT, ord_id TEXT, inst_id TEXT, side TEXT, state TEXT,
               source_endpoint TEXT, okx_ctime INTEGER, raw_json TEXT);",
        )
        .unwrap();
        conn
    }

    fn algo(conn: &Connection, id: &str, inst: &str, side: &str, state: &str, ctime: i64, raw: &str) {
        conn.execute(
            "INSERT INTO okx_orders VALUES ('a','demo',?1,?2,?3,?4,'orders-algo-history',?5,?6)",
            params![id, inst, side, state, ctime, raw],
        )
        .unwrap();
    }

    fn probe(side: &str, open: i64, close: Option<i64>) -> EpisodeProbe {
        EpisodeProbe { episode_id: "e1".into(), inst_id: "BTC-USDT-SWAP".into(), side: side.into(), open_time: open, close_time: close }
    }

    #[test]
    fn notes_roundtrip_dedupe_and_delete_when_empty() {
        let c = conn();
        let saved = save_note(&c, "a", "demo", "pe-1", &["突破".into(), " 追单 ".into(), "突破".into(), "".into()], "  当时没等回踩  ", 10).unwrap().unwrap();
        assert_eq!(saved.tags, vec!["突破", "追单"]);
        assert_eq!(saved.note, "当时没等回踩");
        assert_eq!(list_notes(&c, "a", "demo").unwrap().len(), 1);
        assert!(list_notes(&c, "a", "live").unwrap().is_empty(), "环境隔离");
        assert!(list_notes(&c, "b", "demo").unwrap().is_empty(), "账户隔离");
        // 覆盖
        save_note(&c, "a", "demo", "pe-1", &["回踩".into()], "", 20).unwrap();
        let again = list_notes(&c, "a", "demo").unwrap();
        assert_eq!((again[0].tags.clone(), again[0].updated_at), (vec!["回踩".to_string()], 20));
        // 都为空 → 删除
        assert!(save_note(&c, "a", "demo", "pe-1", &[], "  ", 30).unwrap().is_none());
        assert!(list_notes(&c, "a", "demo").unwrap().is_empty());
    }

    #[test]
    fn notes_reject_bad_input() {
        let c = conn();
        assert!(save_note(&c, "a", "demo", "", &["x".into()], "", 1).is_err());
        assert!(save_note(&c, "a", "demo", "pe\n1", &["x".into()], "", 1).is_err());
        assert!(save_note(&c, "a", "demo", "pe-1", &["这个标签实在是太长了超过十二个字".into()], "", 1).is_err());
        let many: Vec<String> = (0..9).map(|i| format!("t{i}")).collect();
        assert!(save_note(&c, "a", "demo", "pe-1", &many, "", 1).is_err());
        assert!(save_note(&c, "a", "demo", "pe-1", &["ok".into()], &"字".repeat(2001), 1).is_err());
        // 控制字符被清掉而不是报错
        let saved = save_note(&c, "a", "demo", "pe-1", &["a\u{0007}b".into()], "x\u{0000}y", 1).unwrap().unwrap();
        assert_eq!(saved.tags, vec!["ab"]);
        assert_eq!(saved.note, "xy");
    }

    #[test]
    fn protection_matches_closing_side_window_and_prices() {
        let c = conn();
        // 多头的止损是 sell 方向，开仓后 30 秒挂上
        algo(&c, "s1", "BTC-USDT-SWAP", "sell", "effective", 1_030_000, r#"{"slTriggerPx":"59000","tpTriggerPx":"63000"}"#);
        // 方向不对（buy）不算多头的保护
        algo(&c, "s2", "BTC-USDT-SWAP", "buy", "live", 1_040_000, r#"{"slTriggerPx":"70000"}"#);
        // 别的合约
        algo(&c, "s3", "ETH-USDT-SWAP", "sell", "live", 1_050_000, r#"{"slTriggerPx":"1"}"#);
        // 时间窗之外
        algo(&c, "s4", "BTC-USDT-SWAP", "sell", "live", 9_000_000, r#"{"slTriggerPx":"50000"}"#);
        // 失败的单不算
        algo(&c, "s5", "BTC-USDT-SWAP", "sell", "order_failed", 1_060_000, r#"{"slTriggerPx":"58000"}"#);
        let result = protection_for(&c, "a", "demo", &[probe("long", 1_000_000, Some(2_000_000))]).unwrap();
        assert_eq!(result.len(), 1);
        assert!(result[0].had_stop);
        assert_eq!(result[0].stop_px, Some(59_000.0));
        assert_eq!(result[0].tp_px, Some(63_000.0));
        assert!(result[0].stop_triggered);
        // 空头只认 buy 方向
        let short = protection_for(&c, "a", "demo", &[probe("short", 1_000_000, Some(2_000_000))]).unwrap();
        assert_eq!(short[0].stop_px, Some(70_000.0));
        assert!(!short[0].stop_triggered);
    }

    #[test]
    fn protection_absent_is_reported_as_no_stop_and_open_positions_are_supported() {
        let c = conn();
        algo(&c, "s1", "BTC-USDT-SWAP", "sell", "live", 1_000_000, r#"{"ordType":"conditional","slTriggerPx":"","tpTriggerPx":"0"}"#);
        algo(&c, "s2", "BTC-USDT-SWAP", "sell", "live", 1_001_000, "not json");
        let result = protection_for(&c, "a", "demo", &[probe("long", 1_000_000, None)]).unwrap();
        assert!(!result[0].had_stop && result[0].stop_px.is_none() && result[0].tp_px.is_none(), "空价 / 0 / 坏 JSON 都不算止损");
        assert!(protection_for(&c, "a", "demo", &[]).unwrap().is_empty());
    }
}
