//! 交易员 Profile 的学习闭环编排（只作用于交易员 Profile，经典 AI Profile 不经过这里）。
//!
//! 阶段 A：交易手册的存储与版本、交易员运行的技能载荷（固定规范替换 + 技能过滤）、开仓形态标签校验。
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
