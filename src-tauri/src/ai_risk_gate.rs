//! AI 自动化「风控官」的编排层：Profile 风控设置、今日已实现盈亏、本 Profile 的持仓与挂单数量。
//!
//! 判定规则本身是纯函数，在 `desic_trade_domain::ai_gate`；这里只负责把库里的事实读出来。
//! 读不到的事实一律返回 `None`，由判定层按「拒绝」处理（失败即关闭）。

use desic_trade_domain::AiRiskLimits;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Deserializer, Serialize};

fn default_risk_per_trade_pct() -> f64 {
    1.0
}
fn default_min_reward_risk() -> f64 {
    1.2
}
fn default_daily_loss_limit_pct() -> f64 {
    3.0
}
fn default_max_open_positions() -> u32 {
    2
}
fn default_max_entry_drift_bps() -> f64 {
    30.0
}

/// Profile 上的风控预算（存于 `ai_agent_profiles.risk_json`）。缺字段 = 默认值，老快照照样能解析。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiProfileRiskSettings {
    #[serde(default = "default_risk_per_trade_pct")]
    pub risk_per_trade_pct: f64,
    #[serde(default = "default_min_reward_risk")]
    pub min_reward_risk: f64,
    #[serde(default = "default_daily_loss_limit_pct")]
    pub daily_loss_limit_pct: f64,
    #[serde(default = "default_max_open_positions")]
    pub max_open_positions: u32,
    #[serde(default = "default_max_entry_drift_bps")]
    pub max_entry_drift_bps: f64,
}

impl Default for AiProfileRiskSettings {
    fn default() -> Self {
        Self {
            risk_per_trade_pct: default_risk_per_trade_pct(),
            min_reward_risk: default_min_reward_risk(),
            daily_loss_limit_pct: default_daily_loss_limit_pct(),
            max_open_positions: default_max_open_positions(),
            max_entry_drift_bps: default_max_entry_drift_bps(),
        }
    }
}

fn clamp_or(value: f64, min: f64, max: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        fallback
    }
}

impl AiProfileRiskSettings {
    /// 夹取到合法范围；非数字回落默认值（不报错，与其它 Profile 字段一致）。
    /// 单笔风险与日亏停止线只按权益封顶（100%），不再另设 5% / 20% 的上限：额度由用户自己定。
    pub(crate) fn normalized(self) -> Self {
        Self {
            risk_per_trade_pct: clamp_or(self.risk_per_trade_pct, 0.05, 100.0, default_risk_per_trade_pct()),
            min_reward_risk: clamp_or(self.min_reward_risk, 0.5, 5.0, default_min_reward_risk()),
            daily_loss_limit_pct: clamp_or(self.daily_loss_limit_pct, 0.1, 100.0, default_daily_loss_limit_pct()),
            max_open_positions: self.max_open_positions.clamp(1, 10),
            max_entry_drift_bps: clamp_or(self.max_entry_drift_bps, 1.0, 300.0, default_max_entry_drift_bps()),
        }
    }

    pub(crate) fn limits(self) -> AiRiskLimits {
        let settings = self.normalized();
        AiRiskLimits {
            risk_per_trade_pct: settings.risk_per_trade_pct,
            min_reward_risk: settings.min_reward_risk,
            daily_loss_limit_pct: settings.daily_loss_limit_pct,
            max_open_positions: settings.max_open_positions,
            max_entry_drift_bps: settings.max_entry_drift_bps,
        }
    }
}

/// `risk` 字段缺失或为 `null` 都按默认值处理（老前端、老快照不报错）。
pub(crate) fn deserialize_risk_settings<'de, D>(deserializer: D) -> Result<AiProfileRiskSettings, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<AiProfileRiskSettings>::deserialize(deserializer)?.unwrap_or_default())
}

/// 写进后台 Run 系统提示词的硬风控说明（中 / 英）。规则由代码强制，这里只是让模型提前知道边界，少走弯路。
pub(crate) fn risk_prompt(settings: &AiProfileRiskSettings, chinese: bool) -> String {
    let s = settings.normalized();
    if chinese {
        format!(
            "硬风控（代码强制，违反会被直接拒绝，不能靠解释绕过）：开仓必须附带止损和止盈，暂不允许用计划委托开仓；单笔止损亏损（含双边手续费）≤ 权益的 {}%；净盈亏比 ≥ {}；今日已实现亏损达到权益的 {}% 后当天不再开仓；本 Profile 同时最多 {} 个持仓或进行中的开仓；市价开仓相对决策价偏离超过 {} 个基点不执行。被拒时原因里会告诉你「按这个止损最多开 N 张」，按它修正后再提交；若提示账户太小，就放弃这一笔。平仓、撤单、改单不受这些开仓规则限制。",
            s.risk_per_trade_pct, s.min_reward_risk, s.daily_loss_limit_pct, s.max_open_positions, s.max_entry_drift_bps
        )
    } else {
        format!(
            "Hard risk rules (enforced in code; violations are rejected and cannot be argued around): every open must attach a stop loss and a take profit, and trigger (plan) orders may not be used to open; the stop loss including round-trip fees must be at most {}% of equity; the net reward-to-risk ratio must be at least {}; once today's realized loss reaches {}% of equity no new positions are opened today; this Profile may hold at most {} positions or in-flight opens at once; a market open that has drifted more than {} bps from the decision price is not executed. A rejection tells you the largest size that fits the stop — resubmit with it; if it says the account is too small, drop the trade. Closing, cancelling and amending are not limited by these opening rules.",
            s.risk_per_trade_pct, s.min_reward_risk, s.daily_loss_limit_pct, s.max_open_positions, s.max_entry_drift_bps
        )
    }
}

/// 单日边界（Asia/Shanghai 自然日，毫秒）。与快判的日亏损口径一致。
pub(crate) fn shanghai_day_start_ms(now: i64) -> i64 {
    const OFFSET: i64 = 8 * 60 * 60 * 1_000;
    let local = now.saturating_add(OFFSET);
    local.saturating_sub(local.rem_euclid(86_400_000)) - OFFSET
}

/// 账户今日已实现盈亏（USDT，亏损为负）：当日平仓的 `position_episodes.realized_pnl` 求和。
/// 账户缺失或查询失败 → `None`。没有平仓记录是合法的 0。
pub(crate) fn account_realized_pnl_today(conn: &Connection, account_id: Option<&str>, now: i64) -> Option<f64> {
    let account_id = account_id.map(str::trim).filter(|value| !value.is_empty())?;
    conn.query_row(
        "SELECT COALESCE(SUM(CAST(realized_pnl AS REAL)),0) FROM position_episodes
         WHERE account_id=?1 AND status='closed' AND close_time>=?2",
        params![account_id, shanghai_day_start_ms(now)],
        |row| row.get::<_, f64>(0),
    )
    .ok()
}

/// 本 Profile 的风险敞口数：未平仓位 + 进行中的开仓机会 + 已提交但仍挂在盘口上的开仓单。
/// 部分成交时可能同时计入挂单与持仓（偏保守）。查询失败 → `None`。
pub(crate) fn profile_open_exposure_count(conn: &Connection, profile_id: &str) -> Option<u32> {
    let open_positions: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT e.id) FROM position_episodes e
             JOIN position_episode_opportunities p ON p.episode_id=e.id
             JOIN trade_opportunities o ON o.id=p.opportunity_id
             WHERE o.agent_profile_id=?1 AND e.status<>'closed'",
            params![profile_id],
            |row| row.get(0),
        )
        .ok()?;
    let pending_opens: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM trade_opportunities
             WHERE agent_profile_id=?1 AND intent='open' AND status IN
               ('pending','approved','executing','submitting','submitted','reconciling','accepted','partially_filled')",
            params![profile_id],
            |row| row.get(0),
        )
        .ok()?;
    let resting_opens: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM trade_opportunities o
             WHERE o.agent_profile_id=?1 AND o.intent='open' AND o.status='executed'
               AND EXISTS (SELECT 1 FROM okx_orders r WHERE r.opportunity_id=o.id AND r.state IN ('live','partially_filled'))",
            params![profile_id],
            |row| row.get(0),
        )
        .ok()?;
    u32::try_from(open_positions + pending_opens + resting_opens).ok()
}

/// 开仓前风控需要、但 `trade_precheck` 自己读不到的事实（来自库）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct AiGateContext {
    pub limits: AiRiskLimits,
    pub today_realized_pnl: Option<f64>,
    pub open_exposure_count: Option<u32>,
}

pub(crate) fn load_gate_context(
    conn: &Connection,
    profile_id: &str,
    account_id: Option<&str>,
    limits: AiRiskLimits,
    now: i64,
) -> AiGateContext {
    AiGateContext {
        limits,
        today_realized_pnl: account_realized_pnl_today(conn, account_id, now),
        open_exposure_count: profile_open_exposure_count(conn, profile_id),
    }
}

/// 某次 Run 冻结的 Profile 风控设置（`ai_agent_runs.profile_snapshot_json.risk`）。
/// 老快照没有这一项 → 默认值；Run 不存在 → 默认值（风控只会更严，不会因此放开）。
pub(crate) fn run_risk_limits(conn: &Connection, run_id: &str) -> AiRiskLimits {
    conn.query_row(
        "SELECT profile_snapshot_json FROM ai_agent_runs WHERE id=?1",
        params![run_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .ok()
    .flatten()
    .flatten()
    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    .and_then(|value| value.get("risk").cloned())
    .and_then(|value| serde_json::from_value::<AiProfileRiskSettings>(value).ok())
    .unwrap_or_default()
    .limits()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE position_episodes (id TEXT PRIMARY KEY, account_id TEXT, status TEXT, realized_pnl TEXT, close_time INTEGER);
             CREATE TABLE trade_opportunities (id TEXT PRIMARY KEY, agent_profile_id TEXT, intent TEXT, status TEXT);
             CREATE TABLE position_episode_opportunities (episode_id TEXT, opportunity_id TEXT);
             CREATE TABLE okx_orders (opportunity_id TEXT, state TEXT);
             CREATE TABLE ai_agent_runs (id TEXT PRIMARY KEY, profile_snapshot_json TEXT);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn settings_default_and_clamp() {
        let parsed: AiProfileRiskSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(parsed, AiProfileRiskSettings::default());
        assert_eq!(parsed.risk_per_trade_pct, 1.0);
        assert_eq!(parsed.max_open_positions, 2);
        let wild = AiProfileRiskSettings { risk_per_trade_pct: 250.0, min_reward_risk: f64::NAN, daily_loss_limit_pct: 0.0, max_open_positions: 0, max_entry_drift_bps: 9999.0 }.normalized();
        assert_eq!(wild.risk_per_trade_pct, 100.0);
        assert_eq!(wild.min_reward_risk, 1.2);
        assert_eq!(wild.daily_loss_limit_pct, 0.1);
        assert_eq!(wild.max_open_positions, 1);
        assert_eq!(wild.max_entry_drift_bps, 300.0);
        let generous = AiProfileRiskSettings { risk_per_trade_pct: 12.5, daily_loss_limit_pct: 45.0, ..AiProfileRiskSettings::default() }.normalized();
        assert_eq!(generous.risk_per_trade_pct, 12.5);
        assert_eq!(generous.daily_loss_limit_pct, 45.0);
        let capped = AiProfileRiskSettings { daily_loss_limit_pct: 180.0, ..AiProfileRiskSettings::default() }.normalized();
        assert_eq!(capped.daily_loss_limit_pct, 100.0);
    }

    #[test]
    fn today_pnl_uses_shanghai_day_and_only_closed_episodes() {
        let conn = database();
        // 2026-10-04 10:00 +08:00
        let now = 1_791_079_200_000_i64;
        let day_start = shanghai_day_start_ms(now);
        assert_eq!((now - day_start) / 3_600_000, 10);
        conn.execute_batch(&format!(
            "INSERT INTO position_episodes VALUES ('a','acc','closed','-4.5',{t1}),('b','acc','closed','1.5',{t2}),('c','acc','closed','-99',{old}),('d','acc','open','-50',NULL),('e','other','closed','-7',{t1});",
            t1 = day_start + 1000,
            t2 = now - 1000,
            old = day_start - 1000
        ))
        .unwrap();
        assert_eq!(account_realized_pnl_today(&conn, Some("acc"), now), Some(-3.0));
        assert_eq!(account_realized_pnl_today(&conn, Some("nobody"), now), Some(0.0));
        assert_eq!(account_realized_pnl_today(&conn, None, now), None);
        assert_eq!(account_realized_pnl_today(&conn, Some("  "), now), None);
    }

    #[test]
    fn exposure_counts_positions_pending_opens_and_resting_orders_of_this_profile_only() {
        let conn = database();
        conn.execute_batch(
            "INSERT INTO trade_opportunities VALUES
               ('o1','p1','open','executed'),  -- 已成交，持仓未平
               ('o2','p1','open','pending'),   -- 待审批
               ('o3','p1','open','executed'),  -- 已提交，限价单还挂着
               ('o4','p1','open','executed'),  -- 已提交，已撤
               ('o5','p1','close','pending'),  -- 平仓不算敞口
               ('o6','p2','open','pending');   -- 别的 Profile
             INSERT INTO position_episodes VALUES ('e1','acc','open',NULL,NULL),('e2','acc','closed','1',1);
             INSERT INTO position_episode_opportunities VALUES ('e1','o1'),('e2','o4');
             INSERT INTO okx_orders VALUES ('o3','live'),('o4','canceled');",
        )
        .unwrap();
        assert_eq!(profile_open_exposure_count(&conn, "p1"), Some(3));
        assert_eq!(profile_open_exposure_count(&conn, "p2"), Some(1));
        assert_eq!(profile_open_exposure_count(&conn, "none"), Some(0));
        let broken = Connection::open_in_memory().unwrap();
        assert_eq!(profile_open_exposure_count(&broken, "p1"), None, "表缺失时不能当作 0");
    }

    #[test]
    fn run_limits_come_from_the_frozen_snapshot_with_defaults_for_old_runs() {
        let conn = database();
        conn.execute_batch(
            "INSERT INTO ai_agent_runs VALUES
               ('new','{\"risk\":{\"riskPerTradePct\":0.5,\"maxOpenPositions\":1}}'),
               ('old','{\"targetLeverage\":20}'),
               ('broken','not json');",
        )
        .unwrap();
        let limits = run_risk_limits(&conn, "new");
        assert_eq!(limits.risk_per_trade_pct, 0.5);
        assert_eq!(limits.max_open_positions, 1);
        assert_eq!(limits.min_reward_risk, 1.2, "未写的字段取默认");
        assert_eq!(run_risk_limits(&conn, "old"), AiProfileRiskSettings::default().limits());
        assert_eq!(run_risk_limits(&conn, "broken"), AiProfileRiskSettings::default().limits());
        assert_eq!(run_risk_limits(&conn, "missing"), AiProfileRiskSettings::default().limits());
    }
}
