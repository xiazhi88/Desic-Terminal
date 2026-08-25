use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub const PROVIDER_SOURCE: &str = "okx-agent-trade-kit";
pub const PROVIDER_VERSION: &str = "1.3.9";
pub const PROVIDER_COMMIT: &str = "1e027b42690878c4a987e0162cebd669fdfccda5";
pub const DERIVATIVES_SOURCE: &str = "okx-public-trading-data";
pub const DERIVATIVES_VERSION: &str = "5-adapter-1";
pub const LINEAR_SIGNAL_LIMITATION: &str =
    "Smart Money 聚合信号仅覆盖 USDT/USDS 线性合约；币本位合约不会进入聚合。";
const SMART_SIGNAL_UTC8_BUCKET_MIGRATION: &str = "smart-signal-data-version-utc8-v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntelligenceSettings {
    pub collector_account_id: Option<String>,
    pub enabled: bool,
    pub news_poll_seconds: u32,
    pub watchlist_news_poll_seconds: u32,
    pub sentiment_poll_minutes: u32,
    pub smart_money_poll_minutes: u32,
    pub leaderboard_poll_minutes: u32,
    pub tracked_trader_poll_minutes: u32,
    pub calendar_poll_hours: u32,
    #[serde(default = "default_derivatives_poll_minutes")]
    pub derivatives_poll_minutes: u32,
    #[serde(default = "default_active_derivatives_poll_seconds")]
    pub active_derivatives_poll_seconds: u32,
    #[serde(default = "default_derivatives_slow_poll_minutes")]
    pub derivatives_slow_poll_minutes: u32,
    #[serde(default = "default_active_derivatives_risk_poll_minutes")]
    pub active_derivatives_risk_poll_minutes: u32,
    #[serde(default = "default_derivatives_risk_poll_minutes")]
    pub derivatives_risk_poll_minutes: u32,
    #[serde(default)]
    pub extra_instruments: Vec<String>,
    #[serde(default)]
    pub briefing_enabled: bool,
    #[serde(default)]
    pub briefing_profile_id: Option<String>,
    pub article_content_retention_days: u32,
    pub fetch_log_retention_days: u32,
    #[serde(default = "default_derivatives_five_minute_retention_days")]
    pub derivatives_five_minute_retention_days: u32,
    #[serde(default = "default_derivatives_hourly_retention_days")]
    pub derivatives_hourly_retention_days: u32,
    #[serde(default = "default_liquidation_retention_days")]
    pub liquidation_retention_days: u32,
}

fn default_derivatives_poll_minutes() -> u32 {
    5
}
fn default_active_derivatives_poll_seconds() -> u32 {
    60
}
fn default_derivatives_slow_poll_minutes() -> u32 {
    60
}
fn default_active_derivatives_risk_poll_minutes() -> u32 {
    5
}
fn default_derivatives_risk_poll_minutes() -> u32 {
    60
}
fn default_derivatives_five_minute_retention_days() -> u32 {
    180
}
fn default_derivatives_hourly_retention_days() -> u32 {
    730
}
fn default_liquidation_retention_days() -> u32 {
    180
}

impl IntelligenceSettings {
    pub fn defaults() -> Self {
        Self {
            collector_account_id: None,
            enabled: true,
            news_poll_seconds: 60,
            watchlist_news_poll_seconds: 300,
            sentiment_poll_minutes: 5,
            smart_money_poll_minutes: 5,
            leaderboard_poll_minutes: 60,
            tracked_trader_poll_minutes: 30,
            calendar_poll_hours: 6,
            derivatives_poll_minutes: default_derivatives_poll_minutes(),
            active_derivatives_poll_seconds: default_active_derivatives_poll_seconds(),
            derivatives_slow_poll_minutes: default_derivatives_slow_poll_minutes(),
            active_derivatives_risk_poll_minutes: default_active_derivatives_risk_poll_minutes(),
            derivatives_risk_poll_minutes: default_derivatives_risk_poll_minutes(),
            extra_instruments: Vec::new(),
            briefing_enabled: false,
            briefing_profile_id: None,
            article_content_retention_days: 180,
            fetch_log_retention_days: 30,
            derivatives_five_minute_retention_days: default_derivatives_five_minute_retention_days(
            ),
            derivatives_hourly_retention_days: default_derivatives_hourly_retention_days(),
            liquidation_retention_days: default_liquidation_retention_days(),
        }
    }

    pub fn normalize(mut self) -> Self {
        // Migrate the legacy defaults while preserving explicitly customized values.
        if self.news_poll_seconds == 120 {
            self.news_poll_seconds = 60;
        }
        if self.sentiment_poll_minutes == 15 {
            self.sentiment_poll_minutes = 5;
        }
        if self.smart_money_poll_minutes == 15 {
            self.smart_money_poll_minutes = 5;
        }
        self.news_poll_seconds = self.news_poll_seconds.clamp(30, 3_600);
        self.watchlist_news_poll_seconds = self.watchlist_news_poll_seconds.clamp(60, 7_200);
        self.sentiment_poll_minutes = self.sentiment_poll_minutes.clamp(5, 1_440);
        self.smart_money_poll_minutes = self.smart_money_poll_minutes.clamp(5, 1_440);
        self.leaderboard_poll_minutes = self.leaderboard_poll_minutes.clamp(15, 1_440);
        self.tracked_trader_poll_minutes = self.tracked_trader_poll_minutes.clamp(5, 1_440);
        self.calendar_poll_hours = self.calendar_poll_hours.clamp(1, 168);
        self.derivatives_poll_minutes = self.derivatives_poll_minutes.clamp(5, 1_440);
        self.active_derivatives_poll_seconds = self.active_derivatives_poll_seconds.clamp(30, 300);
        self.derivatives_slow_poll_minutes = self.derivatives_slow_poll_minutes.clamp(15, 10_080);
        self.active_derivatives_risk_poll_minutes =
            self.active_derivatives_risk_poll_minutes.clamp(1, 60);
        self.derivatives_risk_poll_minutes = self.derivatives_risk_poll_minutes.clamp(15, 1_440);
        self.extra_instruments = self
            .extra_instruments
            .into_iter()
            .map(|value| value.trim().to_ascii_uppercase())
            .filter(|value| {
                value.ends_with("-SWAP") && (value.contains("-USDT-") || value.contains("-USDS-"))
            })
            .collect::<BTreeSet<_>>()
            .into_iter()
            .take(40)
            .collect();
        self.briefing_profile_id = self
            .briefing_profile_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        self.article_content_retention_days = self.article_content_retention_days.clamp(7, 3_650);
        self.fetch_log_retention_days = self.fetch_log_retention_days.clamp(7, 365);
        self.derivatives_five_minute_retention_days =
            self.derivatives_five_minute_retention_days.clamp(30, 730);
        self.derivatives_hourly_retention_days =
            self.derivatives_hourly_retention_days.clamp(180, 3_650);
        self.liquidation_retention_days = self.liquidation_retention_days.clamp(30, 730);
        self.collector_account_id = self
            .collector_account_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        self
    }
}

impl Default for IntelligenceSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IntelligencePagination {
    pub has_more: bool,
    pub next_after: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IntelligenceSeriesMetadata {
    pub kind: String,
    pub inst_id: Option<String>,
    pub granularity: Option<String>,
    pub bucket_start_at: Option<i64>,
    pub bucket_end_at: Option<i64>,
    pub observed_at: Option<i64>,
    pub fetched_at: Option<i64>,
    pub effective_age_ms: Option<i64>,
    pub bucket_status: String,
    pub source_mode: String,
    pub stale: bool,
    pub stale_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntelligenceResponse {
    pub source: String,
    pub source_version: String,
    pub fetched_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_at: Option<i64>,
    #[serde(default)]
    pub age_ms: i64,
    pub data_version: Option<String>,
    pub stale: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale_reason: Option<String>,
    #[serde(default = "default_refresh_status")]
    pub refresh_status: String,
    #[serde(default)]
    pub refresh_queued: bool,
    pub items: Vec<Value>,
    pub pagination: IntelligencePagination,
    pub limitations: Vec<String>,
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coverage: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_points: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub series_metadata: Vec<IntelligenceSeriesMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NewsFeedQuery {
    pub mode: Option<String>,
    pub keyword: Option<String>,
    pub coins: Option<Vec<String>>,
    pub importance: Option<String>,
    pub language: Option<String>,
    pub start_time: Option<i64>,
    pub end_time: Option<i64>,
    pub page: Option<u32>,
    pub page_size: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NewsReadState {
    pub events_read_at: i64,
    pub articles_read_at: i64,
    pub unread_events: u64,
    pub unread_articles: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewsFeedPage {
    pub mode: String,
    pub items: Vec<Value>,
    pub page: u32,
    pub page_size: u16,
    pub total: u64,
    pub total_pages: u32,
    pub unread_count: u64,
    pub read_state: NewsReadState,
}

impl IntelligenceResponse {
    pub fn new(fetched_at: i64, items: Vec<Value>) -> Self {
        Self {
            source: PROVIDER_SOURCE.to_string(),
            source_version: PROVIDER_VERSION.to_string(),
            fetched_at,
            data_at: None,
            age_ms: 0,
            data_version: None,
            stale: false,
            stale_reason: None,
            refresh_status: default_refresh_status(),
            refresh_queued: false,
            items,
            pagination: IntelligencePagination::default(),
            limitations: Vec::new(),
            truncated: false,
            coverage: None,
            expected_points: None,
            series_metadata: Vec::new(),
        }
    }
}

fn default_refresh_status() -> String {
    "ready".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IntelligenceQuery {
    pub account_id: Option<String>,
    pub keyword: Option<String>,
    pub coins: Option<Vec<String>>,
    pub importance: Option<String>,
    pub platform: Option<String>,
    pub sentiment: Option<String>,
    pub sort_by: Option<String>,
    pub language: Option<String>,
    pub detail_level: Option<String>,
    pub start_time: Option<i64>,
    pub end_time: Option<i64>,
    pub after: Option<String>,
    pub limit: Option<u32>,
    pub local_only: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SentimentQuery {
    pub account_id: Option<String>,
    pub coins: Option<Vec<String>>,
    pub period: Option<String>,
    pub trend_points: Option<u32>,
    pub sort_by: Option<String>,
    pub limit: Option<u32>,
    pub local_only: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CalendarQuery {
    pub account_id: Option<String>,
    pub region: Option<String>,
    pub importance: Option<String>,
    pub start_time: Option<i64>,
    pub end_time: Option<i64>,
    pub limit: Option<u32>,
    pub local_only: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SmartMoneyQuery {
    pub account_id: Option<String>,
    #[serde(default)]
    pub operation: String,
    pub author_id: Option<String>,
    pub author_ids: Option<Vec<String>>,
    pub keyword: Option<String>,
    pub inst_id: Option<String>,
    pub inst_ccy: Option<String>,
    pub inst_ccy_list: Option<Vec<String>>,
    pub top_instruments: Option<u32>,
    pub update_time: Option<String>,
    pub ts: Option<String>,
    pub data_version: Option<String>,
    pub as_of_time: Option<String>,
    pub granularity: Option<String>,
    #[serde(alias = "sortBy")]
    pub sort_type: Option<String>,
    pub period: Option<String>,
    #[serde(alias = "minPnl", alias = "pnlTier")]
    pub pnl: Option<String>,
    #[serde(alias = "minWinRate", alias = "winRateTier")]
    pub win_ratio: Option<String>,
    #[serde(alias = "maxDrawdown", alias = "maxDrawdownTier")]
    pub max_retreat: Option<String>,
    #[serde(alias = "minAum", alias = "aumTier")]
    pub asset: Option<String>,
    pub lmt_num: Option<u32>,
    pub after: Option<String>,
    pub before: Option<String>,
    pub limit: Option<u32>,
    pub local_only: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivativesQuery {
    pub inst_id: String,
    pub period: Option<String>,
    pub start_time: Option<i64>,
    pub end_time: Option<i64>,
    pub limit: Option<u32>,
    pub local_only: Option<bool>,
}

impl Default for DerivativesQuery {
    fn default() -> Self {
        Self {
            inst_id: "BTC-USDT-SWAP".to_string(),
            period: Some("5m".to_string()),
            start_time: None,
            end_time: None,
            limit: Some(288),
            local_only: None,
        }
    }
}

impl DerivativesQuery {
    pub fn normalize(mut self) -> Result<Self, String> {
        self.inst_id = self.inst_id.trim().to_ascii_uppercase();
        if !self.inst_id.ends_with("-SWAP")
            || !(self.inst_id.contains("-USDT-") || self.inst_id.contains("-USDS-"))
        {
            return Err("衍生品情报只支持 USDT/USDS 线性永续合约".to_string());
        }
        let period = self.period.as_deref().unwrap_or("5m");
        if !matches!(period, "5m" | "1H" | "4H" | "1D") {
            return Err("period 只支持 5m、1H、4H 或 1D".to_string());
        }
        self.period = Some(period.to_string());
        self.limit = Some(self.limit.unwrap_or(288).clamp(1, 1_440));
        if self
            .start_time
            .zip(self.end_time)
            .is_some_and(|(start, end)| start > end)
        {
            return Err("startTime 不能晚于 endTime".to_string());
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NewsEventQuery {
    pub id: Option<String>,
    pub keyword: Option<String>,
    pub coins: Option<Vec<String>>,
    pub importance: Option<String>,
    pub start_time: Option<i64>,
    pub end_time: Option<i64>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BriefingQuery {
    pub profile_id: Option<String>,
    pub briefing_date: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntelligenceSyncState {
    pub key: String,
    pub status: String,
    pub last_started_at: Option<i64>,
    pub last_succeeded_at: Option<i64>,
    pub last_failed_at: Option<i64>,
    pub next_run_at: Option<i64>,
    pub error: Option<String>,
    pub rows_written: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntelligenceSummary {
    pub settings: IntelligenceSettings,
    pub sync_states: Vec<IntelligenceSyncState>,
    pub counts: HashMap<String, i64>,
    pub latest_news: Vec<Value>,
    pub sentiment_rankings: Vec<Value>,
    pub economic_events: Vec<Value>,
    pub smart_traders: Vec<Value>,
    pub smart_signals: Vec<Value>,
    pub tracked_traders: Vec<Value>,
}

pub fn migrate_intelligence(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS intelligence_settings (
          id INTEGER PRIMARY KEY CHECK(id=1),
          value_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS intelligence_migrations (
          id TEXT PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS intelligence_news_articles (
          id TEXT NOT NULL,
          language TEXT NOT NULL DEFAULT 'zh-CN',
          title TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL DEFAULT '',
          platform TEXT,
          url TEXT,
          coins_json TEXT NOT NULL DEFAULT '[]',
          sentiment TEXT,
          importance TEXT,
          published_at INTEGER,
          data_version TEXT,
          raw_json TEXT NOT NULL,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          PRIMARY KEY(id, language)
        );
        CREATE INDEX IF NOT EXISTS idx_intelligence_news_time ON intelligence_news_articles(published_at DESC,last_seen_at DESC);
        CREATE INDEX IF NOT EXISTS idx_intelligence_news_first_seen ON intelligence_news_articles(first_seen_at DESC);
        CREATE INDEX IF NOT EXISTS idx_intelligence_news_platform ON intelligence_news_articles(platform,published_at DESC);
        CREATE TABLE IF NOT EXISTS intelligence_news_contents (
          id TEXT NOT NULL,
          language TEXT NOT NULL DEFAULT 'zh-CN',
          content TEXT NOT NULL,
          raw_json TEXT NOT NULL,
          fetched_at INTEGER NOT NULL,
          PRIMARY KEY(id, language)
        );
        CREATE TABLE IF NOT EXISTS intelligence_news_read_state (
          stream TEXT PRIMARY KEY,
          last_read_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS intelligence_coin_sentiment (
          ccy TEXT NOT NULL,
          period TEXT NOT NULL,
          bucket_at INTEGER NOT NULL,
          raw_json TEXT NOT NULL,
          fetched_at INTEGER NOT NULL,
          PRIMARY KEY(ccy,period,bucket_at)
        );
        CREATE INDEX IF NOT EXISTS idx_intelligence_sentiment_time ON intelligence_coin_sentiment(bucket_at DESC);
        CREATE TABLE IF NOT EXISTS intelligence_sentiment_rankings (
          period TEXT NOT NULL,
          sort_by TEXT NOT NULL,
          ccy TEXT NOT NULL,
          snapshot_at INTEGER NOT NULL,
          rank_no INTEGER NOT NULL,
          raw_json TEXT NOT NULL,
          fetched_at INTEGER NOT NULL,
          PRIMARY KEY(period,sort_by,ccy,snapshot_at)
        );
        CREATE TABLE IF NOT EXISTS intelligence_economic_events (
          id TEXT PRIMARY KEY,
          region TEXT,
          event TEXT NOT NULL DEFAULT '',
          importance TEXT,
          event_at INTEGER,
          raw_json TEXT NOT NULL,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_intelligence_calendar_time ON intelligence_economic_events(event_at ASC);
        CREATE TABLE IF NOT EXISTS intelligence_smart_traders (
          author_id TEXT PRIMARY KEY,
          nickname TEXT NOT NULL DEFAULT '',
          raw_json TEXT NOT NULL,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS intelligence_smart_trader_snapshots (
          author_id TEXT NOT NULL,
          period TEXT NOT NULL,
          snapshot_at INTEGER NOT NULL,
          raw_json TEXT NOT NULL,
          fetched_at INTEGER NOT NULL,
          PRIMARY KEY(author_id,period,snapshot_at)
        );
        CREATE TABLE IF NOT EXISTS intelligence_smart_positions (
          author_id TEXT NOT NULL,
          position_id TEXT NOT NULL,
          snapshot_at INTEGER NOT NULL,
          raw_json TEXT NOT NULL,
          fetched_at INTEGER NOT NULL,
          PRIMARY KEY(author_id,position_id,snapshot_at)
        );
        CREATE TABLE IF NOT EXISTS intelligence_smart_closed_positions (
          author_id TEXT NOT NULL,
          position_id TEXT NOT NULL,
          raw_json TEXT NOT NULL,
          fetched_at INTEGER NOT NULL,
          PRIMARY KEY(author_id,position_id)
        );
        CREATE TABLE IF NOT EXISTS intelligence_smart_orders (
          author_id TEXT NOT NULL,
          order_id TEXT NOT NULL,
          raw_json TEXT NOT NULL,
          fetched_at INTEGER NOT NULL,
          PRIMARY KEY(author_id,order_id)
        );
        CREATE TABLE IF NOT EXISTS intelligence_smart_signals (
          scope_key TEXT NOT NULL,
          inst_ccy TEXT NOT NULL,
          bucket_at TEXT NOT NULL,
          granularity TEXT NOT NULL,
          data_version TEXT,
          raw_json TEXT NOT NULL,
          fetched_at INTEGER NOT NULL,
          PRIMARY KEY(scope_key,inst_ccy,bucket_at,granularity)
        );
        CREATE INDEX IF NOT EXISTS idx_intelligence_smart_signals_time ON intelligence_smart_signals(fetched_at DESC);
        CREATE TABLE IF NOT EXISTS intelligence_tracked_traders (
          author_id TEXT PRIMARY KEY,
          nickname TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS intelligence_sync_state (
          key TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          last_started_at INTEGER,
          last_succeeded_at INTEGER,
          last_failed_at INTEGER,
          next_run_at INTEGER,
          error TEXT,
          rows_written INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS intelligence_fetch_log (
          id TEXT PRIMARY KEY,
          key TEXT NOT NULL,
          account_id TEXT,
          endpoint TEXT NOT NULL,
          status TEXT NOT NULL,
          okx_code TEXT,
          error TEXT,
          response_json TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_intelligence_fetch_log_time ON intelligence_fetch_log(created_at DESC);
        CREATE TABLE IF NOT EXISTS intelligence_derivatives_snapshots (
          inst_id TEXT NOT NULL,
          bucket_at INTEGER NOT NULL,
          granularity TEXT NOT NULL,
          last_price REAL,
          volume_usd REAL,
          oi REAL,
          oi_ccy REAL,
          oi_usd REAL,
          raw_json TEXT NOT NULL,
          fetched_at INTEGER NOT NULL,
          PRIMARY KEY(inst_id,bucket_at,granularity)
        );
        CREATE INDEX IF NOT EXISTS idx_intelligence_derivatives_snapshots_time
          ON intelligence_derivatives_snapshots(inst_id,granularity,bucket_at DESC);
        CREATE TABLE IF NOT EXISTS intelligence_derivatives_flows (
          inst_id TEXT NOT NULL,
          bucket_at INTEGER NOT NULL,
          granularity TEXT NOT NULL,
          sell_volume REAL,
          buy_volume REAL,
          net_volume REAL,
          raw_json TEXT NOT NULL,
          fetched_at INTEGER NOT NULL,
          PRIMARY KEY(inst_id,bucket_at,granularity)
        );
        CREATE TABLE IF NOT EXISTS intelligence_derivatives_crowding (
          inst_id TEXT NOT NULL,
          bucket_at INTEGER NOT NULL,
          granularity TEXT NOT NULL,
          account_ratio REAL,
          top_account_ratio REAL,
          top_position_ratio REAL,
          raw_json TEXT NOT NULL,
          fetched_at INTEGER NOT NULL,
          PRIMARY KEY(inst_id,bucket_at,granularity)
        );
        CREATE TABLE IF NOT EXISTS intelligence_derivatives_funding (
          inst_id TEXT NOT NULL,
          bucket_at INTEGER NOT NULL,
          granularity TEXT NOT NULL,
          funding_rate REAL,
          next_funding_rate REAL,
          funding_time INTEGER,
          next_funding_time INTEGER,
          premium REAL,
          mark_price REAL,
          index_price REAL,
          basis REAL,
          raw_json TEXT NOT NULL,
          fetched_at INTEGER NOT NULL,
          PRIMARY KEY(inst_id,bucket_at,granularity)
        );
        CREATE TABLE IF NOT EXISTS intelligence_liquidation_samples (
          id TEXT PRIMARY KEY,
          inst_id TEXT NOT NULL,
          side TEXT,
          size REAL,
          bankruptcy_price REAL,
          event_at INTEGER NOT NULL,
          raw_json TEXT NOT NULL,
          fetched_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_intelligence_liquidations_time
          ON intelligence_liquidation_samples(inst_id,event_at DESC);
        CREATE TABLE IF NOT EXISTS intelligence_system_risk (
          inst_id TEXT NOT NULL,
          bucket_at INTEGER NOT NULL,
          insurance_balance REAL,
          upper_limit REAL,
          lower_limit REAL,
          adl_state TEXT,
          raw_json TEXT NOT NULL,
          fetched_at INTEGER NOT NULL,
          PRIMARY KEY(inst_id,bucket_at)
        );
        CREATE TABLE IF NOT EXISTS intelligence_position_tiers (
          inst_family TEXT NOT NULL,
          tier TEXT NOT NULL,
          min_size REAL,
          max_size REAL,
          maintenance_margin_ratio REAL,
          initial_margin_ratio REAL,
          max_leverage REAL,
          raw_json TEXT NOT NULL,
          fetched_at INTEGER NOT NULL,
          PRIMARY KEY(inst_family,tier)
        );
        CREATE TABLE IF NOT EXISTS intelligence_news_events (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          coins_json TEXT NOT NULL DEFAULT '[]',
          sources_json TEXT NOT NULL DEFAULT '[]',
          importance TEXT,
          sentiment TEXT,
          status TEXT NOT NULL,
          first_published_at INTEGER NOT NULL,
          last_published_at INTEGER NOT NULL,
          article_count INTEGER NOT NULL,
          source_count INTEGER NOT NULL,
          raw_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_intelligence_news_events_time
          ON intelligence_news_events(last_published_at DESC);
        CREATE TABLE IF NOT EXISTS intelligence_news_event_articles (
          event_id TEXT NOT NULL,
          article_id TEXT NOT NULL,
          language TEXT NOT NULL DEFAULT 'zh-CN',
          PRIMARY KEY(event_id,article_id,language)
        );
        CREATE INDEX IF NOT EXISTS idx_intelligence_news_event_articles_article
          ON intelligence_news_event_articles(article_id,language);
        CREATE TABLE IF NOT EXISTS intelligence_news_reactions (
          event_id TEXT NOT NULL,
          inst_id TEXT NOT NULL,
          window_minutes INTEGER NOT NULL,
          observed_at INTEGER NOT NULL,
          raw_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(event_id,inst_id,window_minutes)
        );
        CREATE TABLE IF NOT EXISTS intelligence_anomalies (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          inst_id TEXT NOT NULL,
          severity TEXT NOT NULL,
          bucket_at INTEGER NOT NULL,
          raw_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_intelligence_anomalies_time
          ON intelligence_anomalies(inst_id,bucket_at DESC);
        CREATE TABLE IF NOT EXISTS intelligence_briefings (
          id TEXT PRIMARY KEY,
          briefing_date TEXT NOT NULL,
          profile_id TEXT,
          run_id TEXT,
          status TEXT NOT NULL,
          content_md TEXT NOT NULL DEFAULT '',
          evidence_json TEXT NOT NULL DEFAULT '[]',
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(briefing_date,profile_id)
        );
        ",
    )
    .map_err(|error| error.to_string())?;
    let smart_signal_utc8_migrated = conn
        .query_row(
            "SELECT 1 FROM intelligence_migrations WHERE id=?1",
            params![SMART_SIGNAL_UTC8_BUCKET_MIGRATION],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .is_some();
    if !smart_signal_utc8_migrated {
        conn.execute_batch(
            "SAVEPOINT intelligence_smart_signal_utc8_fix;
             CREATE TEMP TABLE intelligence_smart_signals_utc8_fix (
               scope_key TEXT NOT NULL,
               inst_ccy TEXT NOT NULL,
               bucket_at TEXT NOT NULL,
               granularity TEXT NOT NULL,
               data_version TEXT,
               raw_json TEXT NOT NULL,
               fetched_at INTEGER NOT NULL,
               PRIMARY KEY(scope_key,inst_ccy,bucket_at,granularity)
             );
             INSERT OR REPLACE INTO intelligence_smart_signals_utc8_fix(
               scope_key,inst_ccy,bucket_at,granularity,data_version,raw_json,fetched_at
             )
             SELECT scope_key,inst_ccy,
                    CASE WHEN data_version IS NOT NULL
                                   AND length(data_version)=10
                                   AND data_version NOT GLOB '*[^0-9]*'
                                   AND CAST(bucket_at AS INTEGER) BETWEEN 1000000000000 AND 9999999999999
                         THEN CAST(CAST(bucket_at AS INTEGER)-28800000 AS TEXT)
                         ELSE bucket_at END,
                    granularity,data_version,
                    CASE WHEN data_version IS NOT NULL
                                   AND length(data_version)=10
                                   AND data_version NOT GLOB '*[^0-9]*'
                                   AND CAST(bucket_at AS INTEGER) BETWEEN 1000000000000 AND 9999999999999
                                   AND json_valid(raw_json)
                         THEN json_set(raw_json,'$.bucketAt',CAST(bucket_at AS INTEGER)-28800000)
                         ELSE raw_json END,
                    fetched_at
             FROM intelligence_smart_signals;
             DELETE FROM intelligence_smart_signals;
             INSERT INTO intelligence_smart_signals(
               scope_key,inst_ccy,bucket_at,granularity,data_version,raw_json,fetched_at
             )
             SELECT scope_key,inst_ccy,bucket_at,granularity,data_version,raw_json,fetched_at
             FROM intelligence_smart_signals_utc8_fix;
             DROP TABLE intelligence_smart_signals_utc8_fix;
             INSERT INTO intelligence_migrations(id,applied_at)
             VALUES('smart-signal-data-version-utc8-v1',CAST(strftime('%s','now') AS INTEGER)*1000);
             RELEASE SAVEPOINT intelligence_smart_signal_utc8_fix;",
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn load_settings(conn: &Connection) -> Result<IntelligenceSettings, String> {
    let raw = conn
        .query_row(
            "SELECT value_json FROM intelligence_settings WHERE id=1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    match raw {
        Some(raw) => serde_json::from_str::<IntelligenceSettings>(&raw)
            .map(IntelligenceSettings::normalize)
            .map_err(|error| error.to_string()),
        None => Ok(IntelligenceSettings::defaults()),
    }
}

pub fn save_settings(
    conn: &Connection,
    settings: IntelligenceSettings,
    now: i64,
) -> Result<IntelligenceSettings, String> {
    let normalized = settings.normalize();
    let raw = serde_json::to_string(&normalized).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO intelligence_settings(id,value_json,updated_at) VALUES(1,?1,?2)
         ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
        params![raw, now],
    )
    .map_err(|error| error.to_string())?;
    Ok(normalized)
}

pub fn item_array(data: &Value) -> Vec<Value> {
    if let Some(items) = data.as_array() {
        if items.len() == 1 {
            if let Some(container) = items.first().and_then(Value::as_object) {
                for key in [
                    "details", "posData", "data", "items", "list", "rows", "news", "events",
                    "result",
                ] {
                    if let Some(nested) = container.get(key).and_then(Value::as_array) {
                        return nested.clone();
                    }
                }
            }
        }
        return items.clone();
    }
    for key in [
        "details", "posData", "data", "items", "list", "rows", "news", "events", "result",
    ] {
        if let Some(items) = data.get(key).and_then(Value::as_array) {
            return items.clone();
        }
    }
    if data.is_null() {
        Vec::new()
    } else {
        vec![data.clone()]
    }
}

pub fn value_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        let value = value.get(*key)?;
        value
            .as_str()
            .map(str::to_string)
            .or_else(|| value.as_i64().map(|item| item.to_string()))
            .or_else(|| value.as_u64().map(|item| item.to_string()))
    })
}

pub fn value_i64(value: &Value, keys: &[&str]) -> Option<i64> {
    value_string(value, keys).and_then(|value| value.parse::<i64>().ok())
}

pub fn value_f64(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| {
        let value = value.get(*key)?;
        value.as_f64().or_else(|| {
            value
                .as_str()
                .and_then(|item| item.replace(',', "").parse::<f64>().ok())
        })
    })
}

pub fn stable_id(prefix: &str, value: &Value) -> String {
    if let Some(id) = value_string(
        value,
        &[
            "id",
            "newsId",
            "eventId",
            "calendarId",
            "authorId",
            "posId",
            "ordId",
            "uuid",
        ],
    ) {
        return id;
    }
    let encoded = serde_json::to_vec(value).unwrap_or_default();
    let digest = Sha256::digest(encoded);
    format!("{prefix}-{:x}", digest)
}

pub fn normalize_item(kind: &str, item: &Value) -> Value {
    if kind == "source" {
        if let Some(name) = item.as_str() {
            return json!({ "id": stable_id("source", item), "name": name });
        }
    }
    let mut output = serde_json::Map::new();
    let mut copy = |canonical: &str, aliases: &[&str]| {
        if let Some(value) = aliases
            .iter()
            .find_map(|key| item.get(*key))
            .filter(|value| !value.is_null())
        {
            output.insert(canonical.to_string(), value.clone());
        }
    };
    match kind {
        "news" | "newsDetail" => {
            copy("id", &["id", "newsId", "articleId"]);
            copy("title", &["title", "headline", "name"]);
            copy("summary", &["summary", "brief", "description"]);
            copy("platform", &["platform", "source", "domain"]);
            copy("platforms", &["platformList"]);
            copy("url", &["url", "link", "sourceUrl"]);
            copy("coins", &["coins", "ccyList", "currencies"]);
            copy("sentiment", &["sentiment", "sentimentLabel"]);
            copy("ccySentiments", &["ccySentiments"]);
            copy("importance", &["importance", "level"]);
            copy(
                "publishTime",
                &["publishTime", "publishedAt", "cTime", "ts", "time"],
            );
            if kind == "newsDetail" {
                copy("content", &["content", "originalText", "body", "text"]);
            }
        }
        "source" => {
            copy("id", &["id", "platformId", "domain"]);
            copy("name", &["name", "platform", "source", "domain"]);
            copy("domain", &["domain", "host"]);
            copy("language", &["language", "lang"]);
        }
        "sentiment" | "ranking" => {
            copy("id", &["id"]);
            copy("ccy", &["ccy", "symbol", "coin"]);
            copy("period", &["period"]);
            copy("bucketAt", &["bucketAt", "dataTime", "ts", "time"]);
            copy(
                "bullishRatio",
                &["bullishRatio", "longRatio", "positiveRatio"],
            );
            copy(
                "bearishRatio",
                &["bearishRatio", "shortRatio", "negativeRatio"],
            );
            copy(
                "mentionCount",
                &["mentionCount", "mentionCnt", "mentions", "count"],
            );
            copy("sentiment", &["label"]);
            copy("rank", &["rank", "rankNo"]);
        }
        "calendar" => {
            copy("id", &["id", "eventId", "calendarId"]);
            copy("event", &["event", "name", "title"]);
            copy("region", &["region", "country"]);
            copy("importance", &["importance", "level"]);
            copy("eventTime", &["eventTime", "ts", "time", "date"]);
            copy("previous", &["previous", "prev", "prevInitial"]);
            copy("forecast", &["forecast", "consensus"]);
            copy("actual", &["actual"]);
            copy("unit", &["unit"]);
        }
        "trader" | "trader_snapshot" => {
            copy("authorId", &["authorId", "id"]);
            copy("nickname", &["nickname", "nickName", "name"]);
            copy("period", &["period"]);
            copy("pnl", &["pnl", "profit"]);
            copy("pnlRatio", &["pnlRatio", "roi"]);
            copy("winRate", &["winRate", "winRatio"]);
            copy("maxDrawdown", &["maxDrawdown", "maxRetreat"]);
            copy("aum", &["aum", "asset"]);
            copy("updateTime", &["updateTime", "uTime", "ts"]);
        }
        "position" | "closed_position" => {
            copy("id", &["id", "posId", "positionId"]);
            copy("authorId", &["authorId"]);
            copy("instId", &["instId", "instrumentId"]);
            copy("instCcy", &["instCcy", "ccy", "symbol"]);
            copy("side", &["side", "posSide", "direction"]);
            copy("size", &["size", "pos", "sz"]);
            copy("entryPrice", &["entryPrice", "avgPx", "openAvgPx"]);
            copy("closePrice", &["closePrice", "closeAvgPx"]);
            copy("leverage", &["leverage", "lever"]);
            copy("pnl", &["pnl"]);
            copy("unrealizedPnl", &["unrealizedPnl", "upl"]);
            copy("pnlRatio", &["pnlRatio", "roi"]);
            copy("notionalUsd", &["notionalUsd"]);
            copy("positionIntensity", &["positionIntensity"]);
            copy("positionCcy", &["positionCcy", "posCcy"]);
            copy("quoteCcy", &["quoteCcy"]);
            copy("lastPrice", &["lastPrice", "last"]);
            copy("openTime", &["openTime", "cTime"]);
            copy("closeTime", &["closeTime", "uTime"]);
            copy("updateTime", &["updateTime", "uTime", "ts"]);
        }
        "order" => {
            copy("id", &["id", "ordId", "orderId"]);
            copy("authorId", &["authorId"]);
            copy("instId", &["instId", "instrumentId"]);
            copy("instCcy", &["instCcy", "ccy", "symbol"]);
            copy("side", &["side"]);
            copy("positionSide", &["positionSide", "posSide"]);
            copy("price", &["price", "px"]);
            copy("size", &["size", "sz"]);
            copy("fillPrice", &["fillPrice", "fillPx", "avgPx"]);
            copy("fillSize", &["fillSize", "fillSz", "accFillSz"]);
            copy("state", &["state", "status"]);
            copy("createdAt", &["createdAt", "cTime"]);
            copy("updatedAt", &["updatedAt", "uTime", "ts"]);
        }
        "signal" => {
            copy("id", &["id", "signalId"]);
            copy("instCcy", &["instCcy", "ccy", "symbol"]);
            copy(
                "bucketAt",
                &["bucketAt", "dataTime", "time", "ts", "asOfTime"],
            );
            copy("dataVersion", &["dataVersion"]);
            copy("granularity", &["granularity"]);
            copy("weightedLongRatio", &["weightedLongRatio", "longRatio"]);
            copy("weightedShortRatio", &["weightedShortRatio", "shortRatio"]);
            copy(
                "netNotionalUsdt",
                &["netNotionalUsdt", "netNotional", "capitalFlow"],
            );
            copy(
                "tradersWithPosition",
                &["tradersWithPosition", "traderCount"],
            );
            copy(
                "smartMoneyLongAvgEntry",
                &["smartMoneyLongAvgEntry", "longAvgEntry"],
            );
            copy(
                "smartMoneyShortAvgEntry",
                &["smartMoneyShortAvgEntry", "shortAvgEntry"],
            );
            copy("longNotionalUsdt", &["longNotionalUsdt", "longNotional"]);
            copy("shortNotionalUsdt", &["shortNotionalUsdt", "shortNotional"]);
            copy("longTraders", &["longTraders"]);
            copy("shortTraders", &["shortTraders"]);
            copy("tradersQualified", &["tradersQualified"]);
        }
        _ => {}
    }
    drop(copy);
    if matches!(kind, "news" | "newsDetail") {
        if !output.contains_key("platform") {
            if let Some(platform) = item
                .get("platformList")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_str)
            {
                output.insert("platform".to_string(), Value::String(platform.to_string()));
            }
        }
        if !output.contains_key("sentiment") {
            if let Some(sentiment) = item
                .get("ccySentiments")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|value| value.get("sentiment"))
                .and_then(Value::as_str)
            {
                output.insert(
                    "sentiment".to_string(),
                    Value::String(sentiment.to_string()),
                );
            }
        }
    }
    if matches!(kind, "sentiment" | "ranking") {
        if let Some(sentiment) = item.get("sentiment") {
            if let Some(label) = sentiment.as_str() {
                output.insert("sentiment".to_string(), Value::String(label.to_string()));
            } else if let Some(object) = sentiment.as_object() {
                for (canonical, upstream) in [
                    ("sentiment", "label"),
                    ("label", "label"),
                    ("bullishRatio", "bullishRatio"),
                    ("bearishRatio", "bearishRatio"),
                    ("bullishCount", "bullishCnt"),
                    ("bearishCount", "bearishCnt"),
                    ("neutralCount", "neutralCnt"),
                ] {
                    if let Some(value) = object.get(upstream) {
                        output.insert(canonical.to_string(), value.clone());
                    }
                }
            }
        }
    }
    if kind == "signal" {
        for (canonical, parent, upstream) in [
            ("longRatio", "longShortRatio", "longRatio"),
            ("shortRatio", "longShortRatio", "shortRatio"),
            ("weightedLongRatio", "longShortRatio", "weightedLongRatio"),
            ("weightedShortRatio", "longShortRatio", "weightedShortRatio"),
            ("longRatioVs1h", "longShortRatio", "longRatioVs1h"),
            ("longRatioVs24h", "longShortRatio", "longRatioVs24h"),
            ("longRatioVs7d", "longShortRatio", "longRatioVs7d"),
            ("longNotionalUsdt", "notional", "longNotionalUsdt"),
            ("shortNotionalUsdt", "notional", "shortNotionalUsdt"),
            ("netNotionalUsdt", "notional", "netNotionalUsdt"),
            ("totalNotionalUsdt", "notional", "totalNotionalUsdt"),
            ("totalNotionalVs24h", "notional", "totalNotionalVs24h"),
            (
                "smartMoneyLongAvgEntry",
                "notional",
                "smartMoneyLongAvgEntry",
            ),
            (
                "smartMoneyShortAvgEntry",
                "notional",
                "smartMoneyShortAvgEntry",
            ),
            ("avgLongWinRate", "winRate", "avgLongWinRate"),
            ("avgShortWinRate", "winRate", "avgShortWinRate"),
        ] {
            if let Some(value) = item.get(parent).and_then(|value| value.get(upstream)) {
                output.insert(canonical.to_string(), value.clone());
            }
        }
    }
    Value::Object(output)
}

pub fn upsert_news(
    conn: &Connection,
    items: &[Value],
    language: &str,
    data_version: Option<&str>,
    now: i64,
) -> Result<u64, String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    let mut written = 0_u64;
    for item in items {
        let id = stable_id("news", item);
        let title = value_string(item, &["title", "headline", "name"]).unwrap_or_default();
        let summary = value_string(item, &["summary", "brief", "description"]).unwrap_or_default();
        let platform = value_string(item, &["platform", "source", "domain"]);
        let url = value_string(item, &["url", "link", "sourceUrl"]);
        let sentiment = value_string(item, &["sentiment", "sentimentLabel"]);
        let importance = value_string(item, &["importance", "level"]);
        let published_at = value_i64(item, &["publishTime", "publishedAt", "ts", "time"]);
        let coins = item
            .get("ccyList")
            .or_else(|| item.get("coins"))
            .cloned()
            .unwrap_or_else(|| json!([]));
        tx.execute(
            "INSERT INTO intelligence_news_articles(
               id,language,title,summary,platform,url,coins_json,sentiment,importance,published_at,data_version,raw_json,first_seen_at,last_seen_at
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13)
             ON CONFLICT(id,language) DO UPDATE SET
               title=excluded.title,summary=excluded.summary,platform=excluded.platform,url=excluded.url,
               coins_json=excluded.coins_json,sentiment=excluded.sentiment,importance=excluded.importance,
               published_at=COALESCE(excluded.published_at,intelligence_news_articles.published_at),
               data_version=COALESCE(excluded.data_version,intelligence_news_articles.data_version),
               raw_json=excluded.raw_json,last_seen_at=excluded.last_seen_at",
            params![
                id,
                language,
                title,
                summary,
                platform,
                url,
                coins.to_string(),
                sentiment,
                importance,
                published_at,
                data_version,
                item.to_string(),
                now,
            ],
        )
        .map_err(|error| error.to_string())?;
        written += 1;
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(written)
}

pub fn upsert_generic(
    conn: &Connection,
    kind: &str,
    items: &[Value],
    scope: &str,
    data_version: Option<&str>,
    now: i64,
) -> Result<u64, String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    let mut written = 0_u64;
    for (index, item) in items.iter().enumerate() {
        match kind {
            "sentiment" => {
                let ccy = value_string(item, &["ccy", "symbol", "coin"])
                    .unwrap_or_else(|| scope.to_string());
                let period = value_string(item, &["period"]).unwrap_or_else(|| "24h".to_string());
                let bucket =
                    value_i64(item, &["ts", "time", "bucketAt", "dataTime"]).unwrap_or(now);
                tx.execute(
                    "INSERT INTO intelligence_coin_sentiment(ccy,period,bucket_at,raw_json,fetched_at)
                     VALUES(?1,?2,?3,?4,?5)
                     ON CONFLICT(ccy,period,bucket_at) DO UPDATE SET raw_json=excluded.raw_json,fetched_at=excluded.fetched_at",
                    params![ccy, period, bucket, item.to_string(), now],
                )
                .map_err(|error| error.to_string())?;
            }
            "ranking" => {
                let ccy = value_string(item, &["ccy", "symbol", "coin"])
                    .unwrap_or_else(|| stable_id("ccy", item));
                let mut parts = scope.split(':');
                let period = parts.next().unwrap_or("24h");
                let sort_by = parts.next().unwrap_or("hot");
                tx.execute(
                    "INSERT INTO intelligence_sentiment_rankings(period,sort_by,ccy,snapshot_at,rank_no,raw_json,fetched_at)
                     VALUES(?1,?2,?3,?4,?5,?6,?4)
                     ON CONFLICT(period,sort_by,ccy,snapshot_at) DO UPDATE SET rank_no=excluded.rank_no,raw_json=excluded.raw_json,fetched_at=excluded.fetched_at",
                    params![period, sort_by, ccy, now, index as i64 + 1, item.to_string()],
                )
                .map_err(|error| error.to_string())?;
            }
            "calendar" => {
                let id = stable_id("calendar", item);
                let event = value_string(item, &["event", "name", "title"]).unwrap_or_default();
                let region = value_string(item, &["region", "country"]);
                let importance = value_string(item, &["importance", "level"]);
                let event_at = value_i64(item, &["eventTime", "ts", "time", "date"]);
                tx.execute(
                    "INSERT INTO intelligence_economic_events(id,region,event,importance,event_at,raw_json,first_seen_at,last_seen_at)
                     VALUES(?1,?2,?3,?4,?5,?6,?7,?7)
                     ON CONFLICT(id) DO UPDATE SET region=excluded.region,event=excluded.event,importance=excluded.importance,
                       event_at=excluded.event_at,raw_json=excluded.raw_json,last_seen_at=excluded.last_seen_at",
                    params![id, region, event, importance, event_at, item.to_string(), now],
                )
                .map_err(|error| error.to_string())?;
            }
            "trader" => {
                let author_id = value_string(item, &["authorId", "id"])
                    .unwrap_or_else(|| stable_id("trader", item));
                let nickname =
                    value_string(item, &["nickname", "nickName", "name"]).unwrap_or_default();
                tx.execute(
                    "INSERT INTO intelligence_smart_traders(author_id,nickname,raw_json,first_seen_at,last_seen_at)
                     VALUES(?1,?2,?3,?4,?4)
                     ON CONFLICT(author_id) DO UPDATE SET nickname=excluded.nickname,raw_json=excluded.raw_json,last_seen_at=excluded.last_seen_at",
                    params![author_id, nickname, item.to_string(), now],
                )
                .map_err(|error| error.to_string())?;
            }
            "trader_snapshot" => {
                let author_id =
                    value_string(item, &["authorId", "id"]).unwrap_or_else(|| scope.to_string());
                tx.execute(
                    "INSERT INTO intelligence_smart_trader_snapshots(author_id,period,snapshot_at,raw_json,fetched_at)
                     VALUES(?1,?2,?3,?4,?3)
                     ON CONFLICT(author_id,period,snapshot_at) DO UPDATE SET raw_json=excluded.raw_json,fetched_at=excluded.fetched_at",
                    params![author_id, scope, now, item.to_string()],
                )
                .map_err(|error| error.to_string())?;
            }
            "position" => {
                let author_id = scope;
                let position_id = value_string(item, &["posId", "positionId", "id"])
                    .unwrap_or_else(|| stable_id("position", item));
                tx.execute(
                    "INSERT INTO intelligence_smart_positions(author_id,position_id,snapshot_at,raw_json,fetched_at)
                     VALUES(?1,?2,?3,?4,?3)",
                    params![author_id, position_id, now, item.to_string()],
                )
                .map_err(|error| error.to_string())?;
            }
            "closed_position" => {
                let id = value_string(item, &["posId", "positionId", "id"])
                    .unwrap_or_else(|| stable_id("position", item));
                tx.execute(
                    "INSERT INTO intelligence_smart_closed_positions(author_id,position_id,raw_json,fetched_at)
                     VALUES(?1,?2,?3,?4)
                     ON CONFLICT(author_id,position_id) DO UPDATE SET raw_json=excluded.raw_json,fetched_at=excluded.fetched_at",
                    params![scope, id, item.to_string(), now],
                )
                .map_err(|error| error.to_string())?;
            }
            "order" => {
                let id = value_string(item, &["ordId", "orderId", "id"])
                    .unwrap_or_else(|| stable_id("order", item));
                tx.execute(
                    "INSERT INTO intelligence_smart_orders(author_id,order_id,raw_json,fetched_at)
                     VALUES(?1,?2,?3,?4)
                     ON CONFLICT(author_id,order_id) DO UPDATE SET raw_json=excluded.raw_json,fetched_at=excluded.fetched_at",
                    params![scope, id, item.to_string(), now],
                )
                .map_err(|error| error.to_string())?;
            }
            "signal" => {
                let ccy = value_string(item, &["instCcy", "ccy", "symbol"])
                    .unwrap_or_else(|| "UNKNOWN".to_string());
                let item_data_version = value_string(item, &["dataVersion"])
                    .or_else(|| data_version.map(str::to_string));
                let bucket =
                    value_string(item, &["bucketAt", "dataTime", "time", "ts", "asOfTime"])
                        .or_else(|| item_data_version.clone())
                        .unwrap_or_else(|| now.to_string());
                let granularity =
                    value_string(item, &["granularity"]).unwrap_or_else(|| "snapshot".to_string());
                tx.execute(
                    "INSERT INTO intelligence_smart_signals(scope_key,inst_ccy,bucket_at,granularity,data_version,raw_json,fetched_at)
                     VALUES(?1,?2,?3,?4,?5,?6,?7)
                     ON CONFLICT(scope_key,inst_ccy,bucket_at,granularity) DO UPDATE SET data_version=excluded.data_version,raw_json=excluded.raw_json,fetched_at=excluded.fetched_at",
                    params![scope, ccy, bucket, granularity, item_data_version, item.to_string(), now],
                )
                .map_err(|error| error.to_string())?;
            }
            _ => return Err(format!("unsupported intelligence persistence kind: {kind}")),
        }
        written += 1;
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(written)
}

pub fn save_news_content(
    conn: &Connection,
    id: &str,
    language: &str,
    item: &Value,
    now: i64,
) -> Result<(), String> {
    let content =
        value_string(item, &["content", "originalText", "body", "text"]).unwrap_or_default();
    conn.execute(
        "INSERT INTO intelligence_news_contents(id,language,content,raw_json,fetched_at)
         VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(id,language) DO UPDATE SET content=excluded.content,raw_json=excluded.raw_json,fetched_at=excluded.fetched_at",
        params![id, language, content, item.to_string(), now],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn read_json_rows(
    conn: &Connection,
    sql: &str,
    args: &[&dyn rusqlite::ToSql],
) -> Result<Vec<Value>, String> {
    let mut stmt = conn.prepare(sql).map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(args, |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut values = Vec::new();
    for row in rows {
        let raw = row.map_err(|error| error.to_string())?;
        if let Ok(value) = serde_json::from_str(&raw) {
            values.push(value);
        }
    }
    Ok(values)
}

pub fn query_news_local(
    conn: &Connection,
    query: &IntelligenceQuery,
) -> Result<Vec<Value>, String> {
    let limit = query.limit.unwrap_or(50).clamp(1, 100) as i64;
    let keyword = query.keyword.as_deref().unwrap_or("").trim();
    let platform = query.platform.as_deref().unwrap_or("").trim();
    let coin = query
        .coins
        .as_ref()
        .and_then(|items| items.first())
        .cloned()
        .unwrap_or_default();
    read_json_rows(
        conn,
        "SELECT raw_json FROM intelligence_news_articles
         WHERE (?1='' OR title LIKE '%'||?1||'%' OR summary LIKE '%'||?1||'%')
           AND (?2='' OR platform=?2)
           AND (?3='' OR coins_json LIKE '%'||?3||'%')
           AND (?4 IS NULL OR published_at>=?4)
           AND (?5 IS NULL OR published_at<=?5)
         ORDER BY COALESCE(published_at,last_seen_at) DESC LIMIT ?6",
        &[
            &keyword,
            &platform,
            &coin,
            &query.start_time,
            &query.end_time,
            &limit,
        ],
    )
}

pub fn query_sentiment_local(
    conn: &Connection,
    query: &SentimentQuery,
) -> Result<Vec<Value>, String> {
    let limit = query.limit.unwrap_or(50).clamp(1, 500) as i64;
    let coin = query
        .coins
        .as_ref()
        .and_then(|items| items.first())
        .cloned()
        .unwrap_or_default();
    let period = query.period.as_deref().unwrap_or("");
    if coin.is_empty() {
        read_json_rows(
            conn,
            "SELECT raw_json FROM intelligence_sentiment_rankings
             WHERE (?1='' OR period=?1) ORDER BY snapshot_at DESC,rank_no ASC LIMIT ?2",
            &[&period, &limit],
        )
    } else {
        read_json_rows(
            conn,
            "SELECT raw_json FROM intelligence_coin_sentiment
             WHERE ccy=?1 AND (?2='' OR period=?2) ORDER BY bucket_at DESC LIMIT ?3",
            &[&coin, &period, &limit],
        )
    }
}

pub fn query_calendar_local(
    conn: &Connection,
    query: &CalendarQuery,
) -> Result<Vec<Value>, String> {
    let limit = query.limit.unwrap_or(100).clamp(1, 2_000) as i64;
    let region = query.region.as_deref().unwrap_or("");
    let importance = query.importance.as_deref().unwrap_or("");
    read_json_rows(
        conn,
        "SELECT raw_json FROM intelligence_economic_events
         WHERE (?1='' OR region=?1) AND (?2='' OR importance=?2)
           AND (?3 IS NULL OR event_at>=?3) AND (?4 IS NULL OR event_at<=?4)
         ORDER BY event_at ASC LIMIT ?5",
        &[
            &region,
            &importance,
            &query.start_time,
            &query.end_time,
            &limit,
        ],
    )
}

pub fn query_smart_local(conn: &Connection, query: &SmartMoneyQuery) -> Result<Vec<Value>, String> {
    let limit = query.limit.unwrap_or(50).clamp(1, 500) as i64;
    match query.operation.as_str() {
        "traders" | "searchTrader" | "performance" => read_json_rows(
            conn,
            "SELECT raw_json FROM intelligence_smart_traders ORDER BY last_seen_at DESC LIMIT ?1",
            &[&limit],
        ),
        "positions" => read_json_rows(
            conn,
            "SELECT raw_json FROM intelligence_smart_positions WHERE author_id=?1 ORDER BY snapshot_at DESC LIMIT ?2",
            &[&query.author_id.as_deref().unwrap_or(""), &limit],
        ),
        "positionHistory" => read_json_rows(
            conn,
            "SELECT raw_json FROM intelligence_smart_closed_positions WHERE author_id=?1 ORDER BY fetched_at DESC LIMIT ?2",
            &[&query.author_id.as_deref().unwrap_or(""), &limit],
        ),
        "orderHistory" => read_json_rows(
            conn,
            "SELECT raw_json FROM intelligence_smart_orders WHERE author_id=?1 ORDER BY fetched_at DESC LIMIT ?2",
            &[&query.author_id.as_deref().unwrap_or(""), &limit],
        ),
        "signalTrendByFilter" | "signalTrendByTrader" => {
            let inst_ccy = query.inst_ccy.as_deref().unwrap_or("");
            let granularity = query.granularity.as_deref().unwrap_or("1h");
            let cutoff = query
                .ts
                .as_deref()
                .or(query.as_of_time.as_deref())
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(i64::MAX);
            let mut stmt = conn
                .prepare(
                    "SELECT raw_json FROM intelligence_smart_signals
                     WHERE (?1='' OR inst_ccy=?1) AND granularity=?2
                       AND CAST(bucket_at AS INTEGER)<=?3
                     ORDER BY CAST(bucket_at AS INTEGER) DESC,fetched_at DESC LIMIT ?4",
                )
                .map_err(|error| error.to_string())?;
            let rows = stmt
                .query_map(params![inst_ccy, granularity, cutoff, limit], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|error| error.to_string())?;
            rows.map(|row| {
                row.map_err(|error| error.to_string()).and_then(|raw| {
                    serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string())
                })
            })
            .collect()
        }
        _ => read_json_rows(
            conn,
            "SELECT raw_json FROM intelligence_smart_signals
             WHERE (?1='' OR inst_ccy=?1) ORDER BY fetched_at DESC LIMIT ?2",
            &[&query.inst_ccy.as_deref().unwrap_or(""), &limit],
        ),
    }
}

pub fn upsert_derivatives_items(
    conn: &Connection,
    kind: &str,
    inst_id: &str,
    granularity: &str,
    items: &[Value],
    now: i64,
) -> Result<u64, String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    let mut changed = 0_u64;
    for item in items {
        let raw = serde_json::to_string(item).map_err(|error| error.to_string())?;
        let bucket_at = value_i64(item, &["ts", "bucketAt", "eventAt"]).unwrap_or(now);
        let rows = match kind {
            "positioning" => tx.execute(
                "INSERT INTO intelligence_derivatives_snapshots(
                   inst_id,bucket_at,granularity,last_price,volume_usd,oi,oi_ccy,oi_usd,raw_json,fetched_at
                 ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
                 ON CONFLICT(inst_id,bucket_at,granularity) DO UPDATE SET
                   last_price=COALESCE(excluded.last_price,intelligence_derivatives_snapshots.last_price),
                   volume_usd=COALESCE(excluded.volume_usd,intelligence_derivatives_snapshots.volume_usd),
                   oi=COALESCE(excluded.oi,intelligence_derivatives_snapshots.oi),
                   oi_ccy=COALESCE(excluded.oi_ccy,intelligence_derivatives_snapshots.oi_ccy),
                   oi_usd=COALESCE(excluded.oi_usd,intelligence_derivatives_snapshots.oi_usd),
                   raw_json=excluded.raw_json,fetched_at=excluded.fetched_at",
                params![
                    inst_id,
                    bucket_at,
                    granularity,
                    value_f64(item, &["last", "lastPrice", "price"]),
                    value_f64(item, &["volumeUsd", "volUsd", "volCcy24h"]),
                    value_f64(item, &["oi"]),
                    value_f64(item, &["oiCcy"]),
                    value_f64(item, &["oiUsd"]),
                    raw,
                    now,
                ],
            ),
            "takerFlow" => tx.execute(
                "INSERT INTO intelligence_derivatives_flows(
                   inst_id,bucket_at,granularity,sell_volume,buy_volume,net_volume,raw_json,fetched_at
                 ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
                 ON CONFLICT(inst_id,bucket_at,granularity) DO UPDATE SET
                   sell_volume=excluded.sell_volume,buy_volume=excluded.buy_volume,
                   net_volume=excluded.net_volume,raw_json=excluded.raw_json,fetched_at=excluded.fetched_at",
                params![
                    inst_id,
                    bucket_at,
                    granularity,
                    value_f64(item, &["sellVol", "sellVolume"]),
                    value_f64(item, &["buyVol", "buyVolume"]),
                    value_f64(item, &["netVol", "netVolume"]),
                    raw,
                    now,
                ],
            ),
            "crowding" => tx.execute(
                "INSERT INTO intelligence_derivatives_crowding(
                   inst_id,bucket_at,granularity,account_ratio,top_account_ratio,top_position_ratio,raw_json,fetched_at
                 ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
                 ON CONFLICT(inst_id,bucket_at,granularity) DO UPDATE SET
                   account_ratio=COALESCE(excluded.account_ratio,intelligence_derivatives_crowding.account_ratio),
                   top_account_ratio=COALESCE(excluded.top_account_ratio,intelligence_derivatives_crowding.top_account_ratio),
                   top_position_ratio=COALESCE(excluded.top_position_ratio,intelligence_derivatives_crowding.top_position_ratio),
                   raw_json=excluded.raw_json,fetched_at=excluded.fetched_at",
                params![
                    inst_id,
                    bucket_at,
                    granularity,
                    value_f64(item, &["accountRatio", "longShortAccountRatio"]),
                    value_f64(item, &["topAccountRatio", "topTraderAccountRatio"]),
                    value_f64(item, &["topPositionRatio", "topTraderPositionRatio"]),
                    raw,
                    now,
                ],
            ),
            "fundingBasis" => tx.execute(
                "INSERT INTO intelligence_derivatives_funding(
                   inst_id,bucket_at,granularity,funding_rate,next_funding_rate,funding_time,next_funding_time,
                   premium,mark_price,index_price,basis,raw_json,fetched_at
                 ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
                 ON CONFLICT(inst_id,bucket_at,granularity) DO UPDATE SET
                   funding_rate=COALESCE(excluded.funding_rate,intelligence_derivatives_funding.funding_rate),
                   next_funding_rate=COALESCE(excluded.next_funding_rate,intelligence_derivatives_funding.next_funding_rate),
                   funding_time=COALESCE(excluded.funding_time,intelligence_derivatives_funding.funding_time),
                   next_funding_time=COALESCE(excluded.next_funding_time,intelligence_derivatives_funding.next_funding_time),
                   premium=COALESCE(excluded.premium,intelligence_derivatives_funding.premium),
                   mark_price=COALESCE(excluded.mark_price,intelligence_derivatives_funding.mark_price),
                   index_price=COALESCE(excluded.index_price,intelligence_derivatives_funding.index_price),
                   basis=COALESCE(excluded.basis,intelligence_derivatives_funding.basis),
                   raw_json=excluded.raw_json,fetched_at=excluded.fetched_at",
                params![
                    inst_id,
                    bucket_at,
                    granularity,
                    value_f64(item, &["fundingRate"]),
                    value_f64(item, &["nextFundingRate"]),
                    value_i64(item, &["fundingTime"]),
                    value_i64(item, &["nextFundingTime"]),
                    value_f64(item, &["premium"]),
                    value_f64(item, &["markPrice"]),
                    value_f64(item, &["indexPrice"]),
                    value_f64(item, &["basis"]),
                    raw,
                    now,
                ],
            ),
            "liquidations" => {
                let id = stable_id("liquidation", item);
                tx.execute(
                    "INSERT INTO intelligence_liquidation_samples(
                       id,inst_id,side,size,bankruptcy_price,event_at,raw_json,fetched_at
                     ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
                     ON CONFLICT(id) DO UPDATE SET raw_json=excluded.raw_json,fetched_at=excluded.fetched_at",
                    params![
                        id,
                        inst_id,
                        value_string(item, &["side", "posSide"]),
                        value_f64(item, &["sz", "size"]),
                        value_f64(item, &["bkPx", "bankruptcyPrice"]),
                        bucket_at,
                        raw,
                        now,
                    ],
                )
            }
            "systemRisk" => tx.execute(
                "INSERT INTO intelligence_system_risk(
                   inst_id,bucket_at,insurance_balance,upper_limit,lower_limit,adl_state,raw_json,fetched_at
                 ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
                 ON CONFLICT(inst_id,bucket_at) DO UPDATE SET
                   insurance_balance=COALESCE(excluded.insurance_balance,intelligence_system_risk.insurance_balance),
                   upper_limit=COALESCE(excluded.upper_limit,intelligence_system_risk.upper_limit),
                   lower_limit=COALESCE(excluded.lower_limit,intelligence_system_risk.lower_limit),
                   adl_state=COALESCE(excluded.adl_state,intelligence_system_risk.adl_state),
                   raw_json=excluded.raw_json,fetched_at=excluded.fetched_at",
                params![
                    inst_id,
                    bucket_at,
                    value_f64(item, &["insuranceBalance", "balance"]),
                    value_f64(item, &["upperLimit", "buyLmt"]),
                    value_f64(item, &["lowerLimit", "sellLmt"]),
                    value_string(item, &["adlState", "state"]),
                    raw,
                    now,
                ],
            ),
            "positionTiers" => {
                let inst_family = value_string(item, &["instFamily"])
                    .unwrap_or_else(|| inst_id.trim_end_matches("-SWAP").to_string());
                let tier = value_string(item, &["tier"]).unwrap_or_else(|| "1".to_string());
                tx.execute(
                    "INSERT INTO intelligence_position_tiers(
                       inst_family,tier,min_size,max_size,maintenance_margin_ratio,initial_margin_ratio,
                       max_leverage,raw_json,fetched_at
                     ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
                     ON CONFLICT(inst_family,tier) DO UPDATE SET
                       min_size=excluded.min_size,max_size=excluded.max_size,
                       maintenance_margin_ratio=excluded.maintenance_margin_ratio,
                       initial_margin_ratio=excluded.initial_margin_ratio,max_leverage=excluded.max_leverage,
                       raw_json=excluded.raw_json,fetched_at=excluded.fetched_at",
                    params![
                        inst_family,
                        tier,
                        value_f64(item, &["minSz"]),
                        value_f64(item, &["maxSz"]),
                        value_f64(item, &["mmr"]),
                        value_f64(item, &["imr"]),
                        value_f64(item, &["maxLever"]),
                        raw,
                        now,
                    ],
                )
            }
            _ => return Err(format!("不支持的衍生品数据类型：{kind}")),
        }
        .map_err(|error| error.to_string())?;
        changed = changed.saturating_add(rows as u64);
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(changed)
}

pub fn query_derivatives_local(
    conn: &Connection,
    kind: &str,
    query: &DerivativesQuery,
) -> Result<Vec<Value>, String> {
    let query = query.clone().normalize()?;
    let limit = i64::from(query.limit.unwrap_or(288));
    let period = query.period.as_deref().unwrap_or("5m");
    let wall_clock_now = current_epoch_ms();
    let now = query.end_time.unwrap_or(wall_clock_now).min(wall_clock_now);
    let (table, time_column, period_filter) = derivative_storage(kind)?;

    if matches!(kind, "positioning" | "takerFlow") && matches!(period, "1H" | "4H") {
        let target_interval = derivative_period_ms(period).expect("validated derivative period");
        let five_minute_interval = derivative_period_ms("5m").expect("known derivative period");
        let five_minute_limit = limit
            .saturating_mul(target_interval / five_minute_interval)
            .clamp(1, 5_760);
        let five_minute_rows = read_derivative_rows(
            conn,
            table,
            time_column,
            &query.inst_id,
            Some("5m"),
            query.start_time,
            query.end_time,
            five_minute_limit,
        )?;
        let recent = aggregate_derivative_rows(
            kind,
            five_minute_rows,
            target_interval,
            five_minute_interval,
            limit as usize,
            now,
        );

        // Keep the direct hourly series as a long-history fallback. Recent buckets are
        // replaced only when the 5m-derived bucket is partial or sufficiently covered.
        let hourly_interval = derivative_period_ms("1H").expect("known derivative period");
        let hourly_limit = limit
            .saturating_mul(target_interval / hourly_interval)
            .clamp(1, 5_760);
        let hourly_rows = read_derivative_rows(
            conn,
            table,
            time_column,
            &query.inst_id,
            Some("1H"),
            query.start_time,
            query.end_time,
            hourly_limit,
        )?;
        let historical = if period == "1H" {
            decorate_derivative_rows(hourly_rows, period, "1H", now)
        } else {
            aggregate_derivative_rows(
                kind,
                hourly_rows,
                target_interval,
                hourly_interval,
                limit as usize,
                now,
            )
        };
        return Ok(merge_derivative_buckets(historical, recent, limit as usize));
    }

    let aggregate_interval: Option<i64> = match (kind, period) {
        ("systemRisk", "1H") => Some(60 * 60_000),
        (_, "4H") => Some(4 * 60 * 60_000),
        (_, "1D") => Some(24 * 60 * 60_000),
        _ => None,
    };
    let storage_period = if aggregate_interval.is_some() {
        "1H"
    } else {
        period
    };
    let read_limit = aggregate_interval
        .map(|interval| {
            let source_points_per_bucket = if kind == "systemRisk" {
                // System-risk rows are snapshots and can contain scheduled plus on-demand
                // refreshes in the same hour. Read enough raw rows before bucketing so those
                // duplicates cannot crowd older hourly evidence out of the requested window.
                (interval / (60 * 60_000)).saturating_mul(12)
            } else {
                interval / (60 * 60_000)
            };
            limit
                .saturating_mul(source_points_per_bucket)
                .clamp(1, 5_760)
        })
        .unwrap_or(limit);
    let inst_key = if kind == "positionTiers" {
        query.inst_id.trim_end_matches("-SWAP")
    } else {
        query.inst_id.as_str()
    };
    let rows = read_derivative_rows(
        conn,
        table,
        time_column,
        inst_key,
        period_filter.then_some(storage_period),
        query.start_time,
        query.end_time,
        read_limit,
    )?;
    Ok(if let Some(interval) = aggregate_interval {
        let source_interval = derivative_period_ms(storage_period).unwrap_or(interval);
        aggregate_derivative_rows(kind, rows, interval, source_interval, limit as usize, now)
    } else if period_filter {
        decorate_derivative_rows(rows, period, storage_period, now)
    } else {
        rows
    })
}

fn derivative_storage(kind: &str) -> Result<(&'static str, &'static str, bool), String> {
    match kind {
        "positioning" => Ok(("intelligence_derivatives_snapshots", "bucket_at", true)),
        "takerFlow" => Ok(("intelligence_derivatives_flows", "bucket_at", true)),
        "crowding" => Ok(("intelligence_derivatives_crowding", "bucket_at", true)),
        "fundingBasis" => Ok(("intelligence_derivatives_funding", "bucket_at", true)),
        "liquidations" => Ok(("intelligence_liquidation_samples", "event_at", false)),
        "systemRisk" => Ok(("intelligence_system_risk", "bucket_at", false)),
        "positionTiers" => Ok(("intelligence_position_tiers", "fetched_at", false)),
        _ => Err(format!("不支持的衍生品本地查询：{kind}")),
    }
}

fn derivative_period_ms(period: &str) -> Option<i64> {
    match period {
        "5m" => Some(5 * 60_000),
        "1H" => Some(60 * 60_000),
        "4H" => Some(4 * 60 * 60_000),
        "1D" => Some(24 * 60 * 60_000),
        _ => None,
    }
}

fn derivative_period_label(period_ms: i64) -> &'static str {
    match period_ms {
        300_000 => "5m",
        3_600_000 => "1H",
        14_400_000 => "4H",
        86_400_000 => "1D",
        _ => "custom",
    }
}

fn current_epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn read_derivative_rows(
    conn: &Connection,
    table: &str,
    time_column: &str,
    inst_key: &str,
    granularity: Option<&str>,
    start_time: Option<i64>,
    end_time: Option<i64>,
    limit: i64,
) -> Result<Vec<Value>, String> {
    let (identity_column, period_clause) = if table == "intelligence_position_tiers" {
        ("inst_family", "")
    } else {
        (
            "inst_id",
            if granularity.is_some() {
                " AND granularity=?2"
            } else {
                ""
            },
        )
    };
    let sql = format!(
        "SELECT raw_json,fetched_at FROM (
           SELECT raw_json,fetched_at,{time_column} FROM {table}
           WHERE {identity_column}=?1{period_clause}
             AND (?3 IS NULL OR {time_column}>=?3) AND (?4 IS NULL OR {time_column}<=?4)
           ORDER BY {time_column} DESC LIMIT ?5
         ) ORDER BY {time_column} ASC"
    );
    let granularity = granularity.unwrap_or("");
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(
            params![inst_key, granularity, start_time, end_time, limit],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .map_err(|error| error.to_string())?;
    let mut values = Vec::new();
    for row in rows {
        let (raw, fetched_at) = row.map_err(|error| error.to_string())?;
        let Ok(mut value) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if let Some(object) = value.as_object_mut() {
            object.insert("sourceFetchedAt".to_string(), json!(fetched_at));
        }
        values.push(value);
    }
    Ok(values)
}

fn decorate_derivative_rows(
    rows: Vec<Value>,
    output_period: &str,
    source_period: &str,
    now: i64,
) -> Vec<Value> {
    let Some(interval_ms) = derivative_period_ms(output_period) else {
        return rows;
    };
    let source_interval_ms = derivative_period_ms(source_period).unwrap_or(interval_ms);
    rows.into_iter()
        .map(|mut row| {
            let ts = value_i64(&row, &["ts", "bucketAt", "eventAt", "fundingTime"]).unwrap_or(now);
            decorate_derivative_bucket(
                &mut row,
                ts / interval_ms * interval_ms,
                interval_ms,
                source_interval_ms,
                1,
                now,
            );
            row
        })
        .collect()
}

fn aggregate_derivative_rows(
    kind: &str,
    rows: Vec<Value>,
    interval_ms: i64,
    source_interval_ms: i64,
    limit: usize,
    now: i64,
) -> Vec<Value> {
    let mut buckets = BTreeMap::<i64, (Value, usize, i64)>::new();
    for row in rows {
        let Some(ts) = value_i64(&row, &["ts", "bucketAt", "eventAt", "fundingTime"]) else {
            continue;
        };
        let bucket = ts / interval_ms * interval_ms;
        if kind == "takerFlow" {
            let entry = buckets.entry(bucket).or_insert_with(|| {
                (
                    json!({
                        "instId": value_string(&row, &["instId"]), "ts": bucket,
                        "sellVol": 0.0, "buyVol": 0.0, "netVol": 0.0,
                    }),
                    0,
                    ts,
                )
            });
            entry.1 = entry.1.saturating_add(1);
            entry.2 = entry.2.max(ts);
            let fetched_at = value_i64(&row, &["sourceFetchedAt"]).unwrap_or_default();
            let current_fetched = value_i64(&entry.0, &["sourceFetchedAt"]).unwrap_or_default();
            if let Some(object) = entry.0.as_object_mut() {
                for key in ["sellVol", "buyVol", "netVol"] {
                    let current = object.get(key).and_then(Value::as_f64).unwrap_or_default();
                    object.insert(
                        key.to_string(),
                        json!(current + value_f64(&row, &[key]).unwrap_or_default()),
                    );
                }
                object.insert(
                    "sourceFetchedAt".to_string(),
                    json!(current_fetched.max(fetched_at)),
                );
                if let Some(observed_at) = value_i64(&row, &["observedAt"]) {
                    let current = object
                        .get("observedAt")
                        .and_then(Value::as_i64)
                        .unwrap_or_default();
                    object.insert("observedAt".to_string(), json!(current.max(observed_at)));
                }
            }
        } else if kind == "systemRisk" {
            let entry = buckets
                .entry(bucket)
                .or_insert_with(|| (json!({ "ts": bucket }), 0, ts));
            entry.1 = entry.1.saturating_add(1);
            entry.2 = entry.2.max(ts);
            if let (Some(target), Some(source)) = (entry.0.as_object_mut(), row.as_object()) {
                for key in [
                    "instId",
                    "insuranceBalance",
                    "upperLimit",
                    "lowerLimit",
                    "limitation",
                    "details",
                    "stream",
                    "observedAt",
                    "sourceTs",
                    "receivedAt",
                ] {
                    if let Some(value) = source.get(key).filter(|value| !value.is_null()) {
                        target.insert(key.to_string(), value.clone());
                    }
                }
                let existing_warning = target
                    .get("adlState")
                    .and_then(Value::as_str)
                    .is_some_and(|state| state.eq_ignore_ascii_case("warning"));
                let incoming_state = value_string(&row, &["adlState", "state"]);
                if existing_warning
                    || incoming_state
                        .as_deref()
                        .is_some_and(|state| state.eq_ignore_ascii_case("warning"))
                {
                    target.insert("adlState".to_string(), json!("warning"));
                } else if let Some(state) = incoming_state {
                    target.insert("adlState".to_string(), json!(state));
                }
                target.insert("ts".to_string(), json!(bucket));
            }
        } else {
            let mut latest = row;
            if let Some(object) = latest.as_object_mut() {
                object.insert("ts".to_string(), json!(bucket));
            }
            let entry = buckets
                .entry(bucket)
                .or_insert_with(|| (latest.clone(), 0, ts));
            entry.1 = entry.1.saturating_add(1);
            if ts >= entry.2 {
                entry.0 = latest;
                entry.2 = ts;
            }
        }
    }
    let mut values = buckets
        .into_iter()
        .map(|(bucket, (mut value, count, latest_source_at))| {
            if let Some(object) = value.as_object_mut() {
                object.entry("observedAt".to_string()).or_insert_with(|| {
                    let observed_at = if kind == "systemRisk" {
                        latest_source_at
                    } else {
                        latest_source_at.saturating_add(source_interval_ms)
                    };
                    json!(observed_at.min(bucket.saturating_add(interval_ms)).min(now))
                });
            }
            decorate_derivative_bucket(
                &mut value,
                bucket,
                interval_ms,
                source_interval_ms,
                count,
                now,
            );
            value
        })
        .collect::<Vec<_>>();
    if values.len() > limit {
        values.drain(0..values.len() - limit);
    }
    values
}

fn decorate_derivative_bucket(
    value: &mut Value,
    bucket_start_at: i64,
    interval_ms: i64,
    source_interval_ms: i64,
    point_count: usize,
    now: i64,
) {
    let bucket_end_at = bucket_start_at.saturating_add(interval_ms);
    let observed_at = value_i64(value, &["observedAt"]).unwrap_or_else(|| {
        value_i64(value, &["sourceTs", "ts", "bucketAt"])
            .unwrap_or(bucket_start_at)
            .saturating_add(source_interval_ms)
    });
    let observed_at = observed_at.min(bucket_end_at).min(now);
    let expected_points = (interval_ms / source_interval_ms.max(1)).max(1) as usize;
    let bucket_status = if bucket_end_at > now {
        "partial"
    } else if point_count < expected_points {
        "incomplete"
    } else {
        "closed"
    };
    let source_mode = value_string(value, &["sourceMode"]).unwrap_or_else(|| {
        if value.get("stream") == Some(&Value::Bool(true)) {
            if point_count > 1 {
                "rest+websocket".to_string()
            } else {
                "websocket".to_string()
            }
        } else {
            "rest".to_string()
        }
    });
    if let Some(object) = value.as_object_mut() {
        object.insert("ts".to_string(), json!(bucket_start_at));
        object.insert("bucketStartAt".to_string(), json!(bucket_start_at));
        object.insert("bucketEndAt".to_string(), json!(bucket_end_at));
        object.insert("observedAt".to_string(), json!(observed_at));
        object.insert("bucketStatus".to_string(), json!(bucket_status));
        object.insert(
            "granularity".to_string(),
            json!(derivative_period_label(interval_ms)),
        );
        object.insert(
            "sourceGranularity".to_string(),
            json!(derivative_period_label(source_interval_ms)),
        );
        object.insert("pointCount".to_string(), json!(point_count));
        object.insert("expectedPoints".to_string(), json!(expected_points));
        object.insert("sourceMode".to_string(), json!(source_mode));
    }
}

fn merge_derivative_buckets(
    historical: Vec<Value>,
    recent: Vec<Value>,
    limit: usize,
) -> Vec<Value> {
    let mut buckets = historical
        .into_iter()
        .filter_map(|value| value_i64(&value, &["bucketStartAt", "ts"]).map(|ts| (ts, value)))
        .collect::<BTreeMap<_, _>>();
    for value in recent {
        let Some(ts) = value_i64(&value, &["bucketStartAt", "ts"]) else {
            continue;
        };
        let status = value_string(&value, &["bucketStatus"]).unwrap_or_default();
        let point_count = value_i64(&value, &["pointCount"]).unwrap_or_default();
        let expected = value_i64(&value, &["expectedPoints"]).unwrap_or(1);
        let sufficiently_covered = point_count.saturating_mul(5) >= expected.saturating_mul(4);
        if status == "partial" || sufficiently_covered || !buckets.contains_key(&ts) {
            buckets.insert(ts, value);
        }
    }
    let mut values = buckets.into_values().collect::<Vec<_>>();
    if values.len() > limit {
        values.drain(0..values.len() - limit);
    }
    values
}

pub fn derivatives_overview_local(
    conn: &Connection,
    query: &DerivativesQuery,
) -> Result<Vec<Value>, String> {
    let query = query.clone().normalize()?;
    let latest = |table: &str| -> Result<Option<Value>, String> {
        let raw = conn
            .query_row(
                &format!(
                    "SELECT raw_json FROM {table} WHERE inst_id=?1 ORDER BY bucket_at DESC LIMIT 1"
                ),
                params![query.inst_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        Ok(raw.and_then(|value| serde_json::from_str(&value).ok()))
    };
    let positioning = latest("intelligence_derivatives_snapshots")?;
    let flow = latest("intelligence_derivatives_flows")?;
    let crowding = latest("intelligence_derivatives_crowding")?;
    let funding = latest("intelligence_derivatives_funding")?;
    let risk = latest("intelligence_system_risk")?;
    Ok(vec![json!({
        "instId": query.inst_id,
        "positioning": positioning,
        "takerFlow": flow,
        "crowding": crowding,
        "fundingBasis": funding,
        "systemRisk": risk,
    })])
}

fn title_ngrams(value: &str) -> BTreeSet<String> {
    let normalized = value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<Vec<_>>();
    if normalized.len() < 2 {
        return normalized
            .into_iter()
            .map(|value| value.to_string())
            .collect();
    }
    normalized
        .windows(2)
        .map(|pair| pair.iter().collect())
        .collect()
}

fn title_similarity(left: &str, right: &str) -> f64 {
    let left = title_ngrams(left);
    let right = title_ngrams(right);
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let intersection = left.intersection(&right).count() as f64;
    let union = left.union(&right).count() as f64;
    if union == 0.0 {
        0.0
    } else {
        intersection / union
    }
}

fn json_string_set(raw: &str) -> BTreeSet<String> {
    serde_json::from_str::<Vec<String>>(raw)
        .unwrap_or_default()
        .into_iter()
        .map(|value| value.trim().to_ascii_uppercase())
        .filter(|value| !value.is_empty())
        .collect()
}

pub fn rebuild_news_events(conn: &Connection, now: i64) -> Result<u64, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,language,title,summary,platform,url,coins_json,sentiment,importance,published_time,first_seen_at,raw_json
             FROM (
               SELECT id,language,title,summary,platform,url,coins_json,sentiment,importance,
                      COALESCE(published_at,last_seen_at) AS published_time,first_seen_at,raw_json
               FROM intelligence_news_articles
               ORDER BY COALESCE(published_at,last_seen_at) DESC LIMIT 5000
             ) ORDER BY published_time ASC",
        )
        .map_err(|error| error.to_string())?;
    let articles = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?.unwrap_or_default(),
                row.get::<_, Option<String>>(8)?.unwrap_or_default(),
                row.get::<_, i64>(9)?,
                row.get::<_, i64>(10)?,
                row.get::<_, String>(11)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    #[derive(Default)]
    struct Cluster {
        id: String,
        title: String,
        summary: String,
        coins: BTreeSet<String>,
        sources: BTreeSet<String>,
        importance: String,
        sentiment: String,
        first_at: i64,
        last_at: i64,
        latest_article_first_seen_at: i64,
        articles: Vec<(String, String, Value)>,
        canonical_urls: BTreeSet<String>,
    }
    let mut clusters: Vec<Cluster> = Vec::new();
    for (
        id,
        language,
        title,
        summary,
        platform,
        url,
        coins_raw,
        sentiment,
        importance,
        published_at,
        first_seen_at,
        raw,
    ) in articles
    {
        let coins = json_string_set(&coins_raw);
        let normalized_url = url
            .split('?')
            .next()
            .unwrap_or(&url)
            .trim()
            .to_ascii_lowercase();
        let match_index = clusters.iter().position(|cluster| {
            let within_window =
                published_at.saturating_sub(cluster.last_at).abs() <= 6 * 60 * 60_000;
            let coin_overlap =
                coins.is_empty() || cluster.coins.is_empty() || !coins.is_disjoint(&cluster.coins);
            let same_url =
                !normalized_url.is_empty() && cluster.canonical_urls.contains(&normalized_url);
            within_window
                && (same_url || (coin_overlap && title_similarity(&title, &cluster.title) >= 0.72))
        });
        let article_value =
            serde_json::from_str(&raw).unwrap_or_else(|_| json!({"id": id, "title": title}));
        if let Some(index) = match_index {
            let cluster = &mut clusters[index];
            cluster.last_at = cluster.last_at.max(published_at);
            cluster.latest_article_first_seen_at =
                cluster.latest_article_first_seen_at.max(first_seen_at);
            cluster.coins.extend(coins);
            if !platform.is_empty() {
                cluster.sources.insert(platform);
            }
            if !normalized_url.is_empty() {
                cluster.canonical_urls.insert(normalized_url);
            }
            if cluster.summary.is_empty() && !summary.is_empty() {
                cluster.summary = summary;
            }
            if importance == "high" || importance == "3" {
                cluster.importance = importance;
            }
            cluster.articles.push((id, language, article_value));
        } else {
            let mut sources = BTreeSet::new();
            if !platform.is_empty() {
                sources.insert(platform);
            }
            let mut canonical_urls = BTreeSet::new();
            if !normalized_url.is_empty() {
                canonical_urls.insert(normalized_url);
            }
            clusters.push(Cluster {
                id: stable_id("news-event", &json!({"articleId": id})),
                title,
                summary,
                coins,
                sources,
                importance,
                sentiment,
                first_at: published_at,
                last_at: published_at,
                latest_article_first_seen_at: first_seen_at,
                articles: vec![(id, language, article_value)],
                canonical_urls,
            });
        }
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM intelligence_news_event_articles", [])
        .map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM intelligence_news_events", [])
        .map_err(|error| error.to_string())?;
    for cluster in &clusters {
        let coins = cluster.coins.iter().cloned().collect::<Vec<_>>();
        let sources = cluster.sources.iter().cloned().collect::<Vec<_>>();
        let status = if sources.len() >= 2 {
            "confirmed"
        } else if now.saturating_sub(cluster.last_at) <= 2 * 60 * 60_000 {
            "developing"
        } else {
            "quiet"
        };
        let event = json!({
            "id": cluster.id, "title": cluster.title, "summary": cluster.summary,
            "coins": coins, "sources": sources, "importance": cluster.importance,
            "sentiment": cluster.sentiment, "status": status,
            "firstPublishedAt": cluster.first_at, "lastPublishedAt": cluster.last_at,
            "latestArticleFirstSeenAt": cluster.latest_article_first_seen_at,
            "articleCount": cluster.articles.len(), "sourceCount": cluster.sources.len(),
            "multiSourceConfirmed": cluster.sources.len() >= 2,
        });
        tx.execute(
            "INSERT INTO intelligence_news_events(
               id,title,summary,coins_json,sources_json,importance,sentiment,status,
               first_published_at,last_published_at,article_count,source_count,raw_json,updated_at
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![
                cluster.id,
                cluster.title,
                cluster.summary,
                serde_json::to_string(&coins).map_err(|error| error.to_string())?,
                serde_json::to_string(&sources).map_err(|error| error.to_string())?,
                cluster.importance,
                cluster.sentiment,
                status,
                cluster.first_at,
                cluster.last_at,
                cluster.articles.len() as i64,
                cluster.sources.len() as i64,
                event.to_string(),
                now,
            ],
        )
        .map_err(|error| error.to_string())?;
        for (article_id, language, _) in &cluster.articles {
            tx.execute(
                "INSERT INTO intelligence_news_event_articles(event_id,article_id,language) VALUES(?1,?2,?3)",
                params![cluster.id, article_id, language],
            ).map_err(|error| error.to_string())?;
        }
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(clusters.len() as u64)
}

pub fn query_news_events_local(
    conn: &Connection,
    query: &NewsEventQuery,
) -> Result<Vec<Value>, String> {
    let keyword = query.keyword.as_deref().unwrap_or("").trim();
    let coin = query
        .coins
        .as_ref()
        .and_then(|values| values.first())
        .cloned()
        .unwrap_or_default();
    let importance = query.importance.as_deref().unwrap_or("");
    let limit = i64::from(query.limit.unwrap_or(50).clamp(1, 100));
    read_json_rows(
        conn,
        "SELECT raw_json FROM intelligence_news_events
         WHERE (?1='' OR title LIKE '%'||?1||'%' OR summary LIKE '%'||?1||'%')
           AND (?2='' OR coins_json LIKE '%'||?2||'%')
           AND (?3='' OR importance=?3)
           AND (?4 IS NULL OR last_published_at>=?4) AND (?5 IS NULL OR first_published_at<=?5)
         ORDER BY last_published_at DESC LIMIT ?6",
        &[
            &keyword,
            &coin,
            &importance,
            &query.start_time,
            &query.end_time,
            &limit,
        ],
    )
}

fn ensure_news_read_state(conn: &Connection, now: i64) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO intelligence_news_read_state(stream,last_read_at,updated_at) VALUES('events',?1,?1),('articles',?1,?1)",
        params![now],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn unread_news_counts(
    conn: &Connection,
    events_read_at: i64,
    articles_read_at: i64,
) -> Result<(u64, u64), String> {
    let unread_articles = conn
        .query_row(
            "SELECT COUNT(*) FROM intelligence_news_articles WHERE first_seen_at>?1",
            params![articles_read_at],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())? as u64;
    let unread_events = conn
        .query_row(
            "SELECT COUNT(DISTINCT e.id)
             FROM intelligence_news_events e
             JOIN intelligence_news_event_articles l ON l.event_id=e.id
             JOIN intelligence_news_articles a ON a.id=l.article_id AND a.language=l.language
             WHERE a.first_seen_at>?1",
            params![events_read_at],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())? as u64;
    Ok((unread_events, unread_articles))
}

pub fn query_news_read_state(conn: &Connection, now: i64) -> Result<NewsReadState, String> {
    ensure_news_read_state(conn, now)?;
    let events_read_at = conn
        .query_row(
            "SELECT last_read_at FROM intelligence_news_read_state WHERE stream='events'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    let articles_read_at = conn
        .query_row(
            "SELECT last_read_at FROM intelligence_news_read_state WHERE stream='articles'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    let (unread_events, unread_articles) =
        unread_news_counts(conn, events_read_at, articles_read_at)?;
    Ok(NewsReadState {
        events_read_at,
        articles_read_at,
        unread_events,
        unread_articles,
    })
}

pub fn mark_news_read(conn: &Connection, stream: &str, now: i64) -> Result<NewsReadState, String> {
    let stream = stream.trim();
    if !matches!(stream, "events" | "articles" | "all") {
        return Err("新闻阅读流无效".to_string());
    }
    ensure_news_read_state(conn, now)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    if stream == "all" || stream == "events" {
        tx.execute(
            "UPDATE intelligence_news_read_state SET last_read_at=?1,updated_at=?1 WHERE stream='events'",
            params![now],
        )
        .map_err(|error| error.to_string())?;
    }
    if stream == "all" || stream == "articles" {
        tx.execute(
            "UPDATE intelligence_news_read_state SET last_read_at=?1,updated_at=?1 WHERE stream='articles'",
            params![now],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())?;
    query_news_read_state(conn, now)
}

fn decorate_news_item(
    mut value: Value,
    id: &str,
    language: Option<&str>,
    first_seen_at: i64,
    unread: bool,
) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.insert("id".to_string(), json!(id));
        if let Some(language) = language {
            object.insert("language".to_string(), json!(language));
        }
        object.insert("firstSeenAt".to_string(), json!(first_seen_at));
        object.insert("unread".to_string(), json!(unread));
    }
    value
}

pub fn query_news_feed_local(
    conn: &Connection,
    query: &NewsFeedQuery,
    now: i64,
) -> Result<NewsFeedPage, String> {
    let mode = query
        .mode
        .as_deref()
        .unwrap_or("events")
        .trim()
        .to_ascii_lowercase();
    if !matches!(mode.as_str(), "events" | "articles") {
        return Err("新闻展示模式无效".to_string());
    }
    ensure_news_read_state(conn, now)?;
    let read_state = query_news_read_state(conn, now)?;
    let keyword = query.keyword.as_deref().unwrap_or("").trim();
    let coin = query
        .coins
        .as_ref()
        .and_then(|items| items.first())
        .map(|value| value.trim().to_ascii_uppercase())
        .unwrap_or_default();
    let importance = query.importance.as_deref().unwrap_or("").trim();
    let language = query.language.as_deref().unwrap_or("").trim();
    let start_time = query.start_time;
    let end_time = query.end_time;
    let page_size = query.page_size.unwrap_or(20).clamp(1, 100) as i64;
    let requested_page = query.page.unwrap_or(1).max(1) as i64;
    let (total, mut rows) = if mode == "events" {
        let filter = "WHERE (?1='' OR e.title LIKE '%'||?1||'%' OR e.summary LIKE '%'||?1||'%')
           AND (?2='' OR e.coins_json LIKE '%'||?2||'%')
           AND (?3='' OR e.importance=?3)
           AND (?4 IS NULL OR e.last_published_at>=?4) AND (?5 IS NULL OR e.last_published_at<?5)
           AND (?6='' OR EXISTS (SELECT 1 FROM intelligence_news_event_articles el JOIN intelligence_news_articles al ON al.id=el.article_id AND al.language=el.language WHERE el.event_id=e.id AND al.language=?6))";
        let total = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM intelligence_news_events e {filter}"),
                params![keyword, coin, importance, start_time, end_time, language],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| error.to_string())? as u64;
        let page = requested_page.min(((total as i64 + page_size - 1) / page_size).max(1));
        let offset = (page - 1) * page_size;
        let mut stmt = conn
            .prepare(&format!("SELECT e.raw_json FROM intelligence_news_events e {filter} ORDER BY e.last_published_at DESC,e.id DESC LIMIT ?7 OFFSET ?8"))
            .map_err(|error| error.to_string())?;
        let values = stmt
            .query_map(
                params![
                    keyword, coin, importance, start_time, end_time, language, page_size, offset
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        let items = values
            .into_iter()
            .filter_map(|raw| serde_json::from_str::<Value>(&raw).ok())
            .map(|value| {
                let first_seen =
                    value_i64(&value, &["latestArticleFirstSeenAt"]).unwrap_or_default();
                let unread = first_seen > read_state.events_read_at;
                let id = value_string(&value, &["id"]).unwrap_or_default();
                decorate_news_item(value, &id, None, first_seen, unread)
            })
            .collect::<Vec<_>>();
        (total, items)
    } else {
        let filter = "WHERE (?1='' OR a.title LIKE '%'||?1||'%' OR a.summary LIKE '%'||?1||'%')
           AND (?2='' OR a.coins_json LIKE '%'||?2||'%')
           AND (?3='' OR a.importance=?3)
           AND (?4 IS NULL OR COALESCE(a.published_at,a.first_seen_at)>=?4) AND (?5 IS NULL OR COALESCE(a.published_at,a.first_seen_at)<?5)
           AND (?6='' OR a.language=?6)";
        let total = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM intelligence_news_articles a {filter}"),
                params![keyword, coin, importance, start_time, end_time, language],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| error.to_string())? as u64;
        let page = requested_page.min(((total as i64 + page_size - 1) / page_size).max(1));
        let offset = (page - 1) * page_size;
        let mut stmt = conn
            .prepare(&format!("SELECT a.raw_json,a.id,a.language,a.first_seen_at FROM intelligence_news_articles a {filter} ORDER BY COALESCE(a.published_at,a.first_seen_at) DESC,a.id DESC LIMIT ?7 OFFSET ?8"))
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(
                params![
                    keyword, coin, importance, start_time, end_time, language, page_size, offset
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
            .into_iter()
            .filter_map(|(raw, id, language, first_seen)| {
                serde_json::from_str::<Value>(&raw)
                    .ok()
                    .map(|value| (value, id, language, first_seen))
            })
            .map(|(value, id, language, first_seen)| {
                decorate_news_item(
                    value,
                    &id,
                    Some(&language),
                    first_seen,
                    first_seen > read_state.articles_read_at,
                )
            })
            .collect::<Vec<_>>();
        (total, rows)
    };
    let total_pages = ((total + page_size as u64 - 1) / page_size as u64).max(1) as u32;
    let page = requested_page.min(i64::from(total_pages)) as u32;
    let unread_count = if mode == "events" {
        read_state.unread_events
    } else {
        read_state.unread_articles
    };
    Ok(NewsFeedPage {
        mode,
        items: std::mem::take(&mut rows),
        page,
        page_size: page_size as u16,
        total,
        total_pages,
        unread_count,
        read_state,
    })
}

pub fn query_news_event_detail_local(conn: &Connection, id: &str) -> Result<Vec<Value>, String> {
    let event_raw = conn
        .query_row(
            "SELECT raw_json FROM intelligence_news_events WHERE id=?1",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "未找到新闻事件".to_string())?;
    let mut event: Value = serde_json::from_str(&event_raw).map_err(|error| error.to_string())?;
    let articles = read_json_rows(
        conn,
        "SELECT a.raw_json FROM intelligence_news_articles a
         JOIN intelligence_news_event_articles l ON l.article_id=a.id AND l.language=a.language
         WHERE l.event_id=?1 ORDER BY COALESCE(a.published_at,a.last_seen_at) ASC",
        &[&id],
    )?;
    let reactions = read_json_rows(
        conn,
        "SELECT raw_json FROM intelligence_news_reactions WHERE event_id=?1 ORDER BY inst_id ASC,window_minutes ASC",
        &[&id],
    )?;
    let reaction_resolution = news_reaction_targets(conn, &event)?;
    if let Some(object) = event.as_object_mut() {
        let requested_coins = object
            .get("coins")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| value.as_str().map(|item| item.to_ascii_uppercase()))
            .collect::<BTreeSet<_>>();
        let resolved_coins = reaction_resolution.resolved_coins;
        let unsupported_coins = requested_coins
            .difference(&resolved_coins)
            .cloned()
            .collect::<Vec<_>>();
        let displayed_count = reaction_resolution.targets.len();
        let truncated_coins = reaction_resolution.truncated_coins;
        let requested_count = requested_coins.len();
        let covered_count = resolved_coins.len();
        let truncated = !truncated_coins.is_empty();
        object.insert(
            "reactionMeta".to_string(),
            json!({
                "mode": if requested_coins.is_empty() { "market_proxy" } else if requested_coins.len() > 1 { "multi_coin" } else { "single_coin" },
                "requestedCoins": requested_coins,
                "resolvedCoins": resolved_coins,
                "unsupportedCoins": unsupported_coins,
                "truncatedCoins": truncated_coins,
                "requestedCount": requested_count,
                "coveredCount": covered_count,
                "displayedCount": displayed_count,
                "proxyInstId": requested_coins.is_empty().then_some("BTC-USDT-SWAP"),
                "truncated": truncated,
            }),
        );
        object.insert("articles".to_string(), Value::Array(articles));
        object.insert("reactions".to_string(), Value::Array(reactions));
    }
    Ok(vec![event])
}

fn candle_point(
    conn: &Connection,
    inst_id: &str,
    at: i64,
) -> Result<Option<(i64, f64, f64)>, String> {
    conn.query_row(
        "SELECT open_time,close,COALESCE(volume_quote,volume) FROM candles
         WHERE symbol=?1 AND interval IN ('1m','5m') AND confirm=1
           AND open_time<=?2 AND open_time>=?2-300000
         ORDER BY open_time DESC, CASE interval WHEN '1m' THEN 0 ELSE 1 END LIMIT 1",
        params![inst_id, at],
        |row| {
            Ok((
                row.get(0)?,
                row.get::<_, String>(1)?.parse::<f64>().unwrap_or_default(),
                row.get::<_, String>(2)?.parse::<f64>().unwrap_or_default(),
            ))
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn derivative_value_before(
    conn: &Connection,
    table: &str,
    column: &str,
    inst_id: &str,
    at: i64,
) -> Result<Option<f64>, String> {
    conn.query_row(
        &format!("SELECT {column} FROM {table} WHERE inst_id=?1 AND bucket_at<=?2 AND {column} IS NOT NULL ORDER BY bucket_at DESC LIMIT 1"),
        params![inst_id, at], |row| row.get::<_, f64>(0),
    ).optional().map_err(|error| error.to_string())
}

#[derive(Debug, Clone)]
struct NewsReactionTarget {
    coin: String,
    inst_id: String,
    mapping_type: &'static str,
    latest_candle_at: i64,
    latest_volume: f64,
}

struct NewsReactionTargetResolution {
    targets: Vec<NewsReactionTarget>,
    resolved_coins: BTreeSet<String>,
    truncated_coins: Vec<String>,
}

fn reaction_instrument_candidate(
    conn: &Connection,
    coin: &str,
    quote: &str,
) -> Result<Option<NewsReactionTarget>, String> {
    let inst_id = format!("{}-{quote}-SWAP", coin.to_ascii_uppercase());
    conn.query_row(
        "SELECT open_time,CAST(COALESCE(volume_quote,volume) AS REAL) FROM candles
         WHERE symbol=?1 AND interval IN ('1m','5m') AND confirm=1
         ORDER BY open_time DESC,CASE interval WHEN '1m' THEN 0 ELSE 1 END LIMIT 1",
        params![inst_id],
        |row| {
            Ok(NewsReactionTarget {
                coin: coin.to_ascii_uppercase(),
                inst_id: inst_id.clone(),
                mapping_type: "direct",
                latest_candle_at: row.get(0)?,
                latest_volume: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn news_reaction_targets(
    conn: &Connection,
    event: &Value,
) -> Result<NewsReactionTargetResolution, String> {
    let coins = event
        .get("coins")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(|item| item.trim().to_ascii_uppercase()))
        .filter(|coin| !coin.is_empty())
        .collect::<BTreeSet<_>>();
    if coins.is_empty() {
        return Ok(NewsReactionTargetResolution {
            targets: vec![NewsReactionTarget {
                coin: "BTC".to_string(),
                inst_id: "BTC-USDT-SWAP".to_string(),
                mapping_type: "btc_market_proxy",
                latest_candle_at: i64::MAX,
                latest_volume: f64::MAX,
            }],
            resolved_coins: BTreeSet::new(),
            truncated_coins: Vec::new(),
        });
    }
    let mut targets = Vec::new();
    for coin in coins {
        let mut candidates = Vec::new();
        for quote in ["USDT", "USDS"] {
            if let Some(candidate) = reaction_instrument_candidate(conn, &coin, quote)? {
                candidates.push(candidate);
            }
        }
        if let Some(candidate) = candidates.into_iter().max_by(|left, right| {
            left.latest_candle_at
                .cmp(&right.latest_candle_at)
                .then_with(|| left.latest_volume.total_cmp(&right.latest_volume))
        }) {
            targets.push(candidate);
        }
    }
    targets.sort_by(|left, right| {
        right
            .latest_candle_at
            .cmp(&left.latest_candle_at)
            .then_with(|| right.latest_volume.total_cmp(&left.latest_volume))
            .then_with(|| left.coin.cmp(&right.coin))
    });
    let resolved_coins = targets
        .iter()
        .map(|target| target.coin.clone())
        .collect::<BTreeSet<_>>();
    let truncated_coins = targets
        .iter()
        .skip(5)
        .map(|target| target.coin.clone())
        .collect::<Vec<_>>();
    targets.truncate(5);
    Ok(NewsReactionTargetResolution {
        targets,
        resolved_coins,
        truncated_coins,
    })
}

fn refresh_news_reactions_for_event(
    conn: &Connection,
    event: &Value,
    now: i64,
) -> Result<u64, String> {
    let Some(event_id) = value_string(event, &["id"]) else {
        return Ok(0);
    };
    let event_at = value_i64(event, &["firstPublishedAt"]).unwrap_or(now);
    let targets = news_reaction_targets(conn, event)?.targets;
    let target_ids = targets
        .iter()
        .map(|target| target.inst_id.clone())
        .collect::<BTreeSet<_>>();
    let existing_ids = {
        let mut stmt = conn
            .prepare("SELECT DISTINCT inst_id FROM intelligence_news_reactions WHERE event_id=?1")
            .map_err(|error| error.to_string())?;
        let values = stmt
            .query_map(params![event_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        values
    };
    let mut changed = 0_u64;
    for existing_id in existing_ids {
        if !target_ids.contains(&existing_id) {
            changed = changed.saturating_add(
                conn.execute(
                    "DELETE FROM intelligence_news_reactions WHERE event_id=?1 AND inst_id=?2",
                    params![event_id, existing_id],
                )
                .map_err(|error| error.to_string())? as u64,
            );
        }
    }
    for target in targets {
        let coin = target.coin;
        let inst_id = target.inst_id;
        let mapping_type = target.mapping_type;
        for window_minutes in [5_i64, 30, 120, 1_440] {
            let target_at = event_at.saturating_add(window_minutes * 60_000);
            if target_at > now {
                let reaction = json!({
                    "eventId": event_id, "coin": coin, "instId": inst_id,
                    "mappingType": mapping_type, "windowMinutes": window_minutes,
                    "observedAt": target_at, "status": "pending_window", "priceReturnPct": null,
                    "volumeChangePct": null, "oiChangePct": null, "netTakerFlow": null,
                    "crowdingDelta": null, "fundingRateDelta": null, "basisDelta": null,
                    "liquidationSampleCount": null,
                });
                changed = changed.saturating_add(conn.execute(
                    "INSERT INTO intelligence_news_reactions(event_id,inst_id,window_minutes,observed_at,raw_json,updated_at)
                     VALUES(?1,?2,?3,?4,?5,?6)
                     ON CONFLICT(event_id,inst_id,window_minutes) DO UPDATE SET
                       observed_at=excluded.observed_at,raw_json=excluded.raw_json,updated_at=excluded.updated_at",
                    params![event_id, inst_id, window_minutes, target_at, reaction.to_string(), now],
                ).map_err(|error| error.to_string())? as u64);
                continue;
            }
            let baseline = candle_point(conn, &inst_id, event_at.saturating_sub(1))?;
            let target_candle = candle_point(conn, &inst_id, target_at)?;
            let (status, price_return_pct, volume_change_pct) = match (baseline, target_candle) {
                (Some((_, base_price, base_volume)), Some((_, target_price, target_volume)))
                    if base_price > 0.0 =>
                {
                    (
                        "complete",
                        Some((target_price - base_price) / base_price * 100.0),
                        (base_volume > 0.0)
                            .then_some((target_volume - base_volume) / base_volume * 100.0),
                    )
                }
                _ => ("pending_data", None, None),
            };
            let oi_before = derivative_value_before(
                conn,
                "intelligence_derivatives_snapshots",
                "oi_usd",
                &inst_id,
                event_at,
            )?;
            let oi_after = derivative_value_before(
                conn,
                "intelligence_derivatives_snapshots",
                "oi_usd",
                &inst_id,
                target_at,
            )?;
            let oi_change_pct = oi_before.zip(oi_after).and_then(|(before, after)| {
                (before != 0.0).then_some((after - before) / before * 100.0)
            });
            let net_flow: Option<f64> = conn.query_row(
                "SELECT SUM(net_volume) FROM intelligence_derivatives_flows WHERE inst_id=?1 AND bucket_at>?2 AND bucket_at<=?3",
                params![inst_id, event_at, target_at], |row| row.get(0),
            ).optional().map_err(|error| error.to_string())?.flatten();
            let liquidation_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM intelligence_liquidation_samples WHERE inst_id=?1 AND event_at>?2 AND event_at<=?3",
                params![inst_id, event_at, target_at], |row| row.get(0),
            ).map_err(|error| error.to_string())?;
            let crowding_before = derivative_value_before(
                conn,
                "intelligence_derivatives_crowding",
                "top_position_ratio",
                &inst_id,
                event_at,
            )?;
            let crowding_after = derivative_value_before(
                conn,
                "intelligence_derivatives_crowding",
                "top_position_ratio",
                &inst_id,
                target_at,
            )?;
            let funding_before = derivative_value_before(
                conn,
                "intelligence_derivatives_funding",
                "funding_rate",
                &inst_id,
                event_at,
            )?;
            let funding_after = derivative_value_before(
                conn,
                "intelligence_derivatives_funding",
                "funding_rate",
                &inst_id,
                target_at,
            )?;
            let basis_before = derivative_value_before(
                conn,
                "intelligence_derivatives_funding",
                "basis",
                &inst_id,
                event_at,
            )?;
            let basis_after = derivative_value_before(
                conn,
                "intelligence_derivatives_funding",
                "basis",
                &inst_id,
                target_at,
            )?;
            let reaction = json!({
                "eventId": event_id, "coin": coin, "instId": inst_id,
                "mappingType": mapping_type, "windowMinutes": window_minutes,
                "observedAt": target_at, "status": status, "priceReturnPct": price_return_pct,
                "volumeChangePct": volume_change_pct, "oiChangePct": oi_change_pct,
                "netTakerFlow": net_flow,
                "crowdingDelta": crowding_before.zip(crowding_after).map(|(before, after)| after - before),
                "fundingRateDelta": funding_before.zip(funding_after).map(|(before, after)| after - before),
                "basisDelta": basis_before.zip(basis_after).map(|(before, after)| after - before),
                "liquidationSampleCount": liquidation_count,
            });
            changed = changed.saturating_add(conn.execute(
                "INSERT INTO intelligence_news_reactions(event_id,inst_id,window_minutes,observed_at,raw_json,updated_at)
                 VALUES(?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(event_id,inst_id,window_minutes) DO UPDATE SET
                   observed_at=excluded.observed_at,raw_json=excluded.raw_json,updated_at=excluded.updated_at",
                params![event_id, inst_id, window_minutes, target_at, reaction.to_string(), now],
            ).map_err(|error| error.to_string())? as u64);
        }
    }
    Ok(changed)
}

pub fn refresh_news_reactions(conn: &Connection, now: i64) -> Result<u64, String> {
    let events = query_news_events_local(
        conn,
        &NewsEventQuery {
            start_time: Some(now.saturating_sub(7 * 86_400_000)),
            limit: Some(100),
            ..Default::default()
        },
    )?;
    let mut changed = 0_u64;
    for event in events {
        changed = changed.saturating_add(refresh_news_reactions_for_event(conn, &event, now)?);
    }
    Ok(changed)
}

pub fn refresh_news_event_reactions(conn: &Connection, id: &str, now: i64) -> Result<u64, String> {
    let raw = conn
        .query_row(
            "SELECT raw_json FROM intelligence_news_events WHERE id=?1",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "未找到新闻事件".to_string())?;
    let event = serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string())?;
    refresh_news_reactions_for_event(conn, &event, now)
}

fn median(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(|left, right| left.total_cmp(right));
    let middle = values.len() / 2;
    Some(if values.len() % 2 == 0 {
        (values[middle - 1] + values[middle]) / 2.0
    } else {
        values[middle]
    })
}

pub fn robust_z_score(history: &[f64], current: f64) -> Option<f64> {
    let mut values = history
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    let center = median(&mut values)?;
    let mut deviations = values
        .iter()
        .map(|value| (value - center).abs())
        .collect::<Vec<_>>();
    let mad = median(&mut deviations)?;
    if mad <= f64::EPSILON {
        return None;
    }
    Some(0.6745 * (current - center) / mad)
}

fn series_metric(
    conn: &Connection,
    table: &str,
    inst_id: &str,
    limit: i64,
) -> Result<Vec<Value>, String> {
    read_json_rows(
        conn,
        &format!("SELECT raw_json FROM {table} WHERE inst_id=?1 ORDER BY bucket_at DESC LIMIT ?2"),
        &[&inst_id, &limit],
    )
}

pub fn recompute_derivative_anomalies(
    conn: &Connection,
    inst_id: &str,
    now: i64,
) -> Result<u64, String> {
    const EXPECTED_7D_5M_POINTS: usize = 2_016;
    const MIN_COVERAGE_POINTS: usize = 1_613;
    let positioning = series_metric(conn, "intelligence_derivatives_snapshots", inst_id, 2_017)?;
    let flow = series_metric(conn, "intelligence_derivatives_flows", inst_id, 2_016)?;
    let crowding = series_metric(conn, "intelligence_derivatives_crowding", inst_id, 2_016)?;
    let funding = series_metric(conn, "intelligence_derivatives_funding", inst_id, 2_016)?;
    let mut candidates: Vec<(&str, f64, Vec<f64>, f64)> = Vec::new();
    let oi_values = positioning
        .iter()
        .filter_map(|value| value_f64(value, &["oiUsd"]))
        .collect::<Vec<_>>();
    if oi_values.len() > MIN_COVERAGE_POINTS {
        let changes = oi_values
            .windows(2)
            .filter_map(|pair| (pair[1] != 0.0).then_some((pair[0] - pair[1]) / pair[1] * 100.0))
            .collect::<Vec<_>>();
        if let Some(current) = changes.first().copied() {
            candidates.push((
                "oi_change",
                current,
                changes.iter().skip(1).copied().collect(),
                2.0,
            ));
        }
    }
    let flow_values = flow
        .iter()
        .filter_map(|value| {
            let buy = value_f64(value, &["buyVol"])?;
            let sell = value_f64(value, &["sellVol"])?;
            ((buy + sell) > 0.0).then_some((buy - sell) / (buy + sell))
        })
        .collect::<Vec<_>>();
    if flow_values.len() >= MIN_COVERAGE_POINTS {
        candidates.push((
            "taker_imbalance",
            flow_values[0],
            flow_values[1..].to_vec(),
            0.30,
        ));
    }
    let crowd_values = crowding
        .iter()
        .filter_map(|value| {
            Some(value_f64(value, &["topPositionRatio"])? - value_f64(value, &["accountRatio"])?)
        })
        .collect::<Vec<_>>();
    if crowd_values.len() >= MIN_COVERAGE_POINTS {
        candidates.push((
            "crowding_divergence",
            crowd_values[0],
            crowd_values[1..].to_vec(),
            0.25,
        ));
    }
    let funding_values = funding
        .iter()
        .filter_map(|value| value_f64(value, &["fundingRate"]))
        .collect::<Vec<_>>();
    if funding_values.len() >= MIN_COVERAGE_POINTS {
        candidates.push((
            "funding_extreme",
            funding_values[0],
            funding_values[1..].to_vec(),
            0.0003,
        ));
    }

    let bucket_now = now / 300_000 * 300_000;
    let bucket_start = bucket_now.saturating_sub((EXPECTED_7D_5M_POINTS as i64) * 300_000);
    let mut liquidation_counts = vec![0_f64; EXPECTED_7D_5M_POINTS + 1];
    let mut stmt = conn
        .prepare(
            "SELECT (event_at / 300000) * 300000 AS bucket_at,COUNT(*)
         FROM intelligence_liquidation_samples
         WHERE inst_id=?1 AND event_at>=?2 AND event_at<?3
         GROUP BY bucket_at",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(
            params![inst_id, bucket_start, bucket_now + 300_000],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (bucket_at, count) = row.map_err(|error| error.to_string())?;
        let index =
            ((bucket_at - bucket_start) / 300_000).clamp(0, EXPECTED_7D_5M_POINTS as i64) as usize;
        liquidation_counts[index] = count as f64;
    }
    let liquidation_current = *liquidation_counts.last().unwrap_or(&0.0);
    if liquidation_current >= 5.0 {
        candidates.push((
            "liquidation_cluster",
            liquidation_current,
            liquidation_counts[..EXPECTED_7D_5M_POINTS].to_vec(),
            5.0,
        ));
    }
    let mut changed = 0_u64;
    for (kind, current, history, absolute_threshold) in candidates {
        let score = robust_z_score(&history, current).or_else(|| {
            (kind == "liquidation_cluster" && current >= absolute_threshold).then_some(99.0)
        });
        let Some(score) = score else {
            continue;
        };
        if score.abs() < 3.0 || current.abs() < absolute_threshold {
            continue;
        }
        let severity = if score.abs() >= 4.5 { "high" } else { "medium" };
        let id = stable_id(
            "anomaly",
            &json!({"kind": kind, "instId": inst_id, "bucket": now / 300_000}),
        );
        let anomaly = json!({
            "id": id, "kind": kind, "instId": inst_id, "severity": severity,
            "bucketAt": now, "value": current, "robustZScore": score,
            "coverage": (history.len() as f64 / EXPECTED_7D_5M_POINTS as f64).min(1.0),
            "label": match kind {
                "oi_change" => "OI 异常变化", "taker_imbalance" => "净主动流失衡",
                "crowding_divergence" => "精英与普通账户分歧", "funding_extreme" => "资金费率极端",
                "liquidation_cluster" => "平台爆仓事件样本聚集",
                _ => kind,
            }
        });
        changed = changed.saturating_add(conn.execute(
            "INSERT INTO intelligence_anomalies(id,kind,inst_id,severity,bucket_at,raw_json,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?7)
             ON CONFLICT(id) DO UPDATE SET severity=excluded.severity,raw_json=excluded.raw_json,updated_at=excluded.updated_at",
            params![id, kind, inst_id, severity, now, anomaly.to_string(), now],
        ).map_err(|error| error.to_string())? as u64);
    }
    Ok(changed)
}

pub fn query_anomalies_local(
    conn: &Connection,
    query: &DerivativesQuery,
) -> Result<Vec<Value>, String> {
    let query = query.clone().normalize()?;
    let limit = i64::from(query.limit.unwrap_or(100).clamp(1, 500));
    read_json_rows(
        conn,
        "SELECT raw_json FROM intelligence_anomalies WHERE inst_id=?1
         AND (?2 IS NULL OR bucket_at>=?2) AND (?3 IS NULL OR bucket_at<=?3)
         ORDER BY bucket_at DESC LIMIT ?4",
        &[&query.inst_id, &query.start_time, &query.end_time, &limit],
    )
}

pub fn create_briefing(
    conn: &Connection,
    briefing_date: &str,
    profile_id: Option<&str>,
    now: i64,
) -> Result<Value, String> {
    let id = stable_id(
        "briefing",
        &json!({"date": briefing_date, "profileId": profile_id}),
    );
    conn.execute(
        "INSERT INTO intelligence_briefings(id,briefing_date,profile_id,status,created_at,updated_at)
         VALUES(?1,?2,?3,'queued',?4,?4)
         ON CONFLICT(briefing_date,profile_id) DO UPDATE SET updated_at=excluded.updated_at",
        params![id, briefing_date, profile_id, now],
    ).map_err(|error| error.to_string())?;
    Ok(
        json!({"id": id, "briefingDate": briefing_date, "profileId": profile_id, "status": "queued", "createdAt": now}),
    )
}

pub fn attach_briefing_run(
    conn: &Connection,
    id: &str,
    run_id: &str,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE intelligence_briefings SET run_id=?2,status='running',updated_at=?3 WHERE id=?1",
        params![id, run_id, now],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn complete_briefing(
    conn: &Connection,
    run_id: &str,
    content: &str,
    evidence: &Value,
    error: Option<&str>,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE intelligence_briefings SET status=?2,content_md=?3,evidence_json=?4,error=?5,updated_at=?6 WHERE run_id=?1",
        params![run_id, if error.is_some() { "failed" } else { "completed" }, content, evidence.to_string(), error, now],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn query_briefings_local(
    conn: &Connection,
    query: &BriefingQuery,
) -> Result<Vec<Value>, String> {
    let profile_id = query.profile_id.as_deref().unwrap_or("");
    let briefing_date = query.briefing_date.as_deref().unwrap_or("");
    let limit = i64::from(query.limit.unwrap_or(30).clamp(1, 100));
    let mut stmt = conn.prepare(
        "SELECT id,briefing_date,profile_id,run_id,status,content_md,evidence_json,error,created_at,updated_at
         FROM intelligence_briefings WHERE (?1='' OR profile_id=?1) AND (?2='' OR briefing_date=?2)
         ORDER BY briefing_date DESC,updated_at DESC LIMIT ?3"
    ).map_err(|error| error.to_string())?;
    let rows = stmt.query_map(params![profile_id, briefing_date, limit], |row| {
        let evidence_raw: String = row.get(6)?;
        Ok(json!({
            "id": row.get::<_, String>(0)?, "briefingDate": row.get::<_, String>(1)?,
            "profileId": row.get::<_, Option<String>>(2)?, "runId": row.get::<_, Option<String>>(3)?,
            "status": row.get::<_, String>(4)?, "content": row.get::<_, String>(5)?,
            "evidence": serde_json::from_str::<Value>(&evidence_raw).unwrap_or_else(|_| json!([])),
            "error": row.get::<_, Option<String>>(7)?, "createdAt": row.get::<_, i64>(8)?,
            "updatedAt": row.get::<_, i64>(9)?,
        }))
    }).map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn sync_states(conn: &Connection) -> Result<Vec<IntelligenceSyncState>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT key,status,last_started_at,last_succeeded_at,last_failed_at,next_run_at,error,rows_written
             FROM intelligence_sync_state ORDER BY key",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(IntelligenceSyncState {
                key: row.get(0)?,
                status: row.get(1)?,
                last_started_at: row.get(2)?,
                last_succeeded_at: row.get(3)?,
                last_failed_at: row.get(4)?,
                next_run_at: row.get(5)?,
                error: row.get(6)?,
                rows_written: row.get::<_, i64>(7)?.max(0) as u64,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn set_sync_state(
    conn: &Connection,
    key: &str,
    status: &str,
    now: i64,
    next_run_at: Option<i64>,
    error: Option<&str>,
    rows_written: u64,
) -> Result<(), String> {
    let (succeeded, failed) = match status {
        "success" | "degraded" => (Some(now), None),
        "failed" => (None, Some(now)),
        _ => (None, None),
    };
    conn.execute(
        "INSERT INTO intelligence_sync_state(
           key,status,last_started_at,last_succeeded_at,last_failed_at,next_run_at,error,rows_written
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(key) DO UPDATE SET status=excluded.status,
           last_started_at=CASE WHEN excluded.status='running' THEN excluded.last_started_at ELSE intelligence_sync_state.last_started_at END,
           last_succeeded_at=COALESCE(excluded.last_succeeded_at,intelligence_sync_state.last_succeeded_at),
           last_failed_at=COALESCE(excluded.last_failed_at,intelligence_sync_state.last_failed_at),
           next_run_at=excluded.next_run_at,error=excluded.error,rows_written=excluded.rows_written",
        params![key, status, now, succeeded, failed, next_run_at, error, rows_written as i64],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn set_tracked_trader(
    conn: &Connection,
    author_id: &str,
    nickname: &str,
    tracked: bool,
    now: i64,
) -> Result<(), String> {
    if tracked {
        conn.execute(
            "INSERT INTO intelligence_tracked_traders(author_id,nickname,created_at,updated_at)
             VALUES(?1,?2,?3,?3)
             ON CONFLICT(author_id) DO UPDATE SET nickname=excluded.nickname,updated_at=excluded.updated_at",
            params![author_id, nickname, now],
        )
        .map_err(|error| error.to_string())?;
    } else {
        conn.execute(
            "DELETE FROM intelligence_tracked_traders WHERE author_id=?1",
            params![author_id],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn tracked_traders(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare("SELECT author_id,nickname,created_at,updated_at FROM intelligence_tracked_traders ORDER BY updated_at DESC")
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(json!({
                "authorId": row.get::<_, String>(0)?,
                "nickname": row.get::<_, String>(1)?,
                "createdAt": row.get::<_, i64>(2)?,
                "updatedAt": row.get::<_, i64>(3)?,
            }))
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn summary(conn: &Connection) -> Result<IntelligenceSummary, String> {
    let tables = [
        "intelligence_news_articles",
        "intelligence_coin_sentiment",
        "intelligence_sentiment_rankings",
        "intelligence_economic_events",
        "intelligence_smart_traders",
        "intelligence_smart_positions",
        "intelligence_smart_closed_positions",
        "intelligence_smart_orders",
        "intelligence_smart_signals",
        "intelligence_derivatives_snapshots",
        "intelligence_derivatives_flows",
        "intelligence_derivatives_crowding",
        "intelligence_derivatives_funding",
        "intelligence_liquidation_samples",
        "intelligence_news_events",
        "intelligence_news_reactions",
        "intelligence_anomalies",
        "intelligence_briefings",
    ];
    let mut counts = HashMap::new();
    for table in tables {
        let count = conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|error| error.to_string())?;
        counts.insert(table.trim_start_matches("intelligence_").to_string(), count);
    }
    Ok(IntelligenceSummary {
        settings: load_settings(conn)?,
        sync_states: sync_states(conn)?,
        counts,
        latest_news: query_news_local(
            conn,
            &IntelligenceQuery {
                limit: Some(30),
                ..Default::default()
            },
        )?,
        sentiment_rankings: query_sentiment_local(
            conn,
            &SentimentQuery {
                limit: Some(20),
                ..Default::default()
            },
        )?,
        economic_events: query_calendar_local(
            conn,
            &CalendarQuery {
                limit: Some(30),
                ..Default::default()
            },
        )?,
        smart_traders: query_smart_local(
            conn,
            &SmartMoneyQuery {
                operation: "traders".to_string(),
                limit: Some(20),
                ..Default::default()
            },
        )?,
        smart_signals: query_smart_local(
            conn,
            &SmartMoneyQuery {
                operation: "signals".to_string(),
                limit: Some(30),
                ..Default::default()
            },
        )?,
        tracked_traders: tracked_traders(conn)?,
    })
}

pub fn run_retention(
    conn: &Connection,
    now: i64,
    settings: &IntelligenceSettings,
) -> Result<HashMap<String, usize>, String> {
    let day_ms = 86_400_000_i64;
    let content_before = now - i64::from(settings.article_content_retention_days) * day_ms;
    let log_before = now - i64::from(settings.fetch_log_retention_days) * day_ms;
    let five_minute_before =
        now - i64::from(settings.derivatives_five_minute_retention_days) * day_ms;
    let hourly_before = now - i64::from(settings.derivatives_hourly_retention_days) * day_ms;
    let liquidation_before = now - i64::from(settings.liquidation_retention_days) * day_ms;
    let mut deleted = HashMap::new();
    deleted.insert(
        "newsContents".to_string(),
        conn.execute(
            "DELETE FROM intelligence_news_contents WHERE fetched_at<?1",
            params![content_before],
        )
        .map_err(|error| error.to_string())?,
    );
    deleted.insert(
        "fetchLogs".to_string(),
        conn.execute(
            "DELETE FROM intelligence_fetch_log WHERE created_at<?1",
            params![log_before],
        )
        .map_err(|error| error.to_string())?,
    );
    let derivative_tables = [
        "intelligence_derivatives_snapshots",
        "intelligence_derivatives_flows",
        "intelligence_derivatives_crowding",
        "intelligence_derivatives_funding",
    ];
    for table in derivative_tables {
        let count = conn
            .execute(
                &format!(
                    "DELETE FROM {table} WHERE (granularity='5m' AND bucket_at<?1)
                 OR (granularity IN ('1H','4H') AND bucket_at<?2)"
                ),
                params![five_minute_before, hourly_before],
            )
            .map_err(|error| error.to_string())?;
        deleted.insert(table.trim_start_matches("intelligence_").to_string(), count);
    }
    deleted.insert(
        "liquidationSamples".to_string(),
        conn.execute(
            "DELETE FROM intelligence_liquidation_samples WHERE event_at<?1",
            params![liquidation_before],
        )
        .map_err(|error| error.to_string())?,
    );
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_and_news_upsert_are_idempotent() {
        let conn = Connection::open_in_memory().expect("database");
        migrate_intelligence(&conn).expect("migration");
        let item = json!({"id":"n1","title":"BTC update","publishTime":"123"});
        upsert_news(&conn, &[item.clone()], "zh-CN", None, 1000).expect("first");
        upsert_news(&conn, &[item], "zh-CN", None, 2000).expect("second");
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM intelligence_news_articles",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(count, 1);
    }

    #[test]
    fn migration_rewrites_legacy_smart_signal_buckets_from_utc_to_utc8() {
        let conn = Connection::open_in_memory().expect("database");
        conn.execute_batch(
            "CREATE TABLE intelligence_smart_signals (
               scope_key TEXT NOT NULL,
               inst_ccy TEXT NOT NULL,
               bucket_at TEXT NOT NULL,
               granularity TEXT NOT NULL,
               data_version TEXT,
               raw_json TEXT NOT NULL,
               fetched_at INTEGER NOT NULL,
               PRIMARY KEY(scope_key,inst_ccy,bucket_at,granularity)
             );
             INSERT INTO intelligence_smart_signals(
               scope_key,inst_ccy,bucket_at,granularity,data_version,raw_json,fetched_at
             ) VALUES(
               'signalOverviewByFilter:pnl','BTC','1784865600000','snapshot','2026072404',
               json_object('instCcy','BTC','dataVersion','2026072404','bucketAt',1784865600000),
               1784839624931
             );",
        )
        .expect("legacy signal table");

        migrate_intelligence(&conn).expect("timezone migration");
        let migrated = conn
            .query_row(
                "SELECT bucket_at,json_extract(raw_json,'$.bucketAt')
                 FROM intelligence_smart_signals WHERE inst_ccy='BTC'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .expect("migrated signal");
        assert_eq!(migrated.0, "1784836800000");
        assert_eq!(migrated.1, 1_784_836_800_000);

        migrate_intelligence(&conn).expect("idempotent timezone migration");
        let bucket: String = conn
            .query_row(
                "SELECT bucket_at FROM intelligence_smart_signals WHERE inst_ccy='BTC'",
                [],
                |row| row.get(0),
            )
            .expect("stable migrated bucket");
        assert_eq!(bucket, "1784836800000");
    }

    #[test]
    fn settings_are_clamped() {
        let settings = IntelligenceSettings {
            news_poll_seconds: 1,
            calendar_poll_hours: 500,
            ..IntelligenceSettings::defaults()
        }
        .normalize();
        assert_eq!(settings.news_poll_seconds, 30);
        assert_eq!(settings.calendar_poll_hours, 168);
    }

    #[test]
    fn calendar_local_query_returns_more_than_one_provider_page() {
        let conn = Connection::open_in_memory().expect("database");
        migrate_intelligence(&conn).expect("migration");
        let month_start = 1_784_041_200_000_i64;
        let events = (0..150)
            .map(|index| {
                json!({
                    "id": format!("calendar-{index}"),
                    "event": format!("Macro event {index}"),
                    "eventTime": month_start + index * 60_000,
                    "region": "United States",
                    "importance": "2"
                })
            })
            .collect::<Vec<_>>();
        upsert_generic(&conn, "calendar", &events, "calendar", None, month_start)
            .expect("calendar upsert");

        let rows = query_calendar_local(
            &conn,
            &CalendarQuery {
                start_time: Some(month_start),
                end_time: Some(month_start + 31 * 86_400_000 - 1),
                limit: Some(2_000),
                local_only: Some(true),
                ..Default::default()
            },
        )
        .expect("calendar query");

        assert_eq!(rows.len(), 150);
        assert_eq!(
            value_string(&rows[149], &["id"]).as_deref(),
            Some("calendar-149")
        );
    }

    #[test]
    fn legacy_default_cadence_migrates_without_overwriting_custom_values() {
        let legacy = IntelligenceSettings {
            news_poll_seconds: 120,
            smart_money_poll_minutes: 15,
            ..IntelligenceSettings::defaults()
        }
        .normalize();
        assert_eq!(legacy.news_poll_seconds, 60);
        assert_eq!(legacy.smart_money_poll_minutes, 5);

        let custom = IntelligenceSettings {
            news_poll_seconds: 180,
            smart_money_poll_minutes: 30,
            ..IntelligenceSettings::defaults()
        }
        .normalize();
        assert_eq!(custom.news_poll_seconds, 180);
        assert_eq!(custom.smart_money_poll_minutes, 30);
    }

    #[test]
    fn warm_local_derivatives_read_p95_stays_below_one_hundred_ms() {
        let conn = Connection::open_in_memory().expect("database");
        migrate_intelligence(&conn).expect("migration");
        let items = (0..120)
            .map(|index| {
                json!({
                    "instId": "BTC-USDT-SWAP",
                    "ts": 1_000_000 + index * 300_000,
                    "last": "65000",
                    "oi": "1000"
                })
            })
            .collect::<Vec<_>>();
        upsert_derivatives_items(
            &conn,
            "positioning",
            "BTC-USDT-SWAP",
            "5m",
            &items,
            2_000_000,
        )
        .expect("seed derivatives");
        let query = DerivativesQuery {
            inst_id: "BTC-USDT-SWAP".to_string(),
            period: Some("5m".to_string()),
            limit: Some(100),
            ..Default::default()
        };
        let mut timings = (0..100)
            .map(|_| {
                let started = std::time::Instant::now();
                let response = query_derivatives_local(&conn, "positioning", &query)
                    .expect("warm local query");
                assert!(!response.is_empty());
                started.elapsed()
            })
            .collect::<Vec<_>>();
        timings.sort();
        assert!(timings[94] < std::time::Duration::from_millis(100));
    }

    #[test]
    fn official_v139_sanitized_news_fixture_is_normalized() {
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/news-search-v1.3.9.json"))
                .expect("news fixture");
        let items = item_array(&fixture["data"]);
        assert_eq!(items.len(), 1);
        assert_eq!(
            value_string(&items[0], &["id"]).as_deref(),
            Some("NEWS_FIXTURE_001")
        );
        let normalized = normalize_item("news", &items[0]);
        assert_eq!(
            value_string(&normalized, &["platform"]).as_deref(),
            Some("FIXTURE_SOURCE")
        );
        assert_eq!(
            value_string(&normalized, &["publishTime"]).as_deref(),
            Some("1700000000000")
        );
        assert_eq!(
            value_string(&normalized, &["sentiment"]).as_deref(),
            Some("neutral")
        );
    }

    #[test]
    fn official_v139_sanitized_smart_money_fixture_is_normalized() {
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/smart-overview-v1.3.9.json"))
                .expect("smart money fixture");
        let items = item_array(&fixture["data"]);
        assert_eq!(items.len(), 1);
        let normalized = normalize_item("signal", &items[0]);
        assert_eq!(
            value_string(&normalized, &["instCcy"]).as_deref(),
            Some("BTC")
        );
        assert_eq!(
            value_string(&normalized, &["weightedLongRatio"]).as_deref(),
            Some("0.56")
        );
        assert_eq!(
            value_string(&normalized, &["netNotionalUsdt"]).as_deref(),
            Some("1000")
        );
        assert_eq!(
            value_string(&normalized, &["smartMoneyLongAvgEntry"]).as_deref(),
            Some("50000")
        );
        let versioned = normalize_item(
            "signal",
            &json!({ "ccy": "BTC", "dataVersion": "2026072312" }),
        );
        assert_eq!(
            value_string(&versioned, &["dataVersion"]).as_deref(),
            Some("2026072312")
        );
    }

    #[test]
    fn adapter_drops_unstable_upstream_fields() {
        let normalized = normalize_item(
            "news",
            &json!({
                "newsId": "n1",
                "headline": "Stable title",
                "providerInternalExperiment": "must-not-escape"
            }),
        );
        assert_eq!(value_string(&normalized, &["id"]).as_deref(), Some("n1"));
        assert_eq!(
            value_string(&normalized, &["title"]).as_deref(),
            Some("Stable title")
        );
        assert!(normalized.get("providerInternalExperiment").is_none());
    }

    #[test]
    fn live_sentiment_shape_is_flattened() {
        let normalized = normalize_item(
            "ranking",
            &json!({
                "ccy": "BTC",
                "mentionCnt": "120",
                "sentiment": {
                    "label": "bullish",
                    "bullishRatio": "0.6",
                    "bearishRatio": "0.3",
                    "neutralCnt": "12"
                }
            }),
        );
        assert_eq!(
            value_string(&normalized, &["mentionCount"]).as_deref(),
            Some("120")
        );
        assert_eq!(
            value_string(&normalized, &["sentiment"]).as_deref(),
            Some("bullish")
        );
        assert_eq!(
            value_string(&normalized, &["bullishRatio"]).as_deref(),
            Some("0.6")
        );
    }

    #[test]
    fn live_leaderboard_data_container_is_unwrapped() {
        let items = item_array(&json!({
            "data": [{ "authorId": "fixture-trader", "nickName": "Fixture" }],
            "updateTime": "1700000000000"
        }));
        assert_eq!(items.len(), 1);
        assert_eq!(
            value_string(&items[0], &["authorId"]).as_deref(),
            Some("fixture-trader")
        );
    }

    #[test]
    fn live_calendar_aliases_are_normalized() {
        let normalized = normalize_item(
            "calendar",
            &json!({
                "calendarId": "fixture-calendar",
                "event": "Fixture event",
                "date": "1700000000000",
                "prevInitial": "1.2"
            }),
        );
        assert_eq!(
            value_string(&normalized, &["id"]).as_deref(),
            Some("fixture-calendar")
        );
        assert_eq!(
            value_string(&normalized, &["previous"]).as_deref(),
            Some("1.2")
        );
    }

    #[test]
    fn live_position_container_and_fields_are_normalized() {
        let items = item_array(&json!([{
            "posData": [{
                "posId": "fixture-position",
                "instId": "BTC-USDT-SWAP",
                "posSide": "long",
                "pos": "2",
                "avgPx": "65000",
                "notionalUsd": "130000",
                "upl": "1200",
                "positionIntensity": "0.25"
            }]
        }]));
        assert_eq!(items.len(), 1);
        let normalized = normalize_item("position", &items[0]);
        assert_eq!(
            value_string(&normalized, &["id"]).as_deref(),
            Some("fixture-position")
        );
        assert_eq!(
            value_string(&normalized, &["entryPrice"]).as_deref(),
            Some("65000")
        );
        assert_eq!(
            value_string(&normalized, &["unrealizedPnl"]).as_deref(),
            Some("1200")
        );
        assert_eq!(
            value_string(&normalized, &["notionalUsd"]).as_deref(),
            Some("130000")
        );
    }

    #[test]
    fn retention_removes_only_expired_payload_rows() {
        let conn = Connection::open_in_memory().expect("database");
        migrate_intelligence(&conn).expect("migration");
        conn.execute(
            "INSERT INTO intelligence_news_contents(id,language,content,raw_json,fetched_at) VALUES('old','zh-CN','body','{}',1)",
            [],
        )
        .expect("old content");
        conn.execute(
            "INSERT INTO intelligence_news_contents(id,language,content,raw_json,fetched_at) VALUES('new','zh-CN','body','{}',?1)",
            params![200_i64 * 86_400_000],
        )
        .expect("new content");
        let deleted = run_retention(
            &conn,
            200_i64 * 86_400_000,
            &IntelligenceSettings {
                article_content_retention_days: 180,
                ..IntelligenceSettings::defaults()
            },
        )
        .expect("retention");
        assert_eq!(deleted.get("newsContents"), Some(&1));
    }

    #[test]
    fn derivatives_query_rejects_non_linear_and_invalid_time_ranges() {
        assert!(DerivativesQuery {
            inst_id: "BTC-USD-SWAP".to_string(),
            ..Default::default()
        }
        .normalize()
        .is_err());
        assert!(DerivativesQuery {
            inst_id: "BTC-USDT-SWAP".to_string(),
            start_time: Some(20),
            end_time: Some(10),
            ..Default::default()
        }
        .normalize()
        .is_err());
        let normalized = DerivativesQuery {
            inst_id: " btc-usdt-swap ".to_string(),
            limit: Some(9_999),
            ..Default::default()
        }
        .normalize()
        .expect("linear query");
        assert_eq!(normalized.inst_id, "BTC-USDT-SWAP");
        assert_eq!(normalized.limit, Some(1_440));
    }

    #[test]
    fn smart_money_query_allows_backend_injected_operation() {
        let query: SmartMoneyQuery = serde_json::from_value(json!({
            "instId": "BTC-USDT-SWAP",
            "limit": 10,
            "period": "7"
        }))
        .expect("agent tool query without internal operation");

        assert!(query.operation.is_empty());
        assert_eq!(query.inst_id.as_deref(), Some("BTC-USDT-SWAP"));
        assert_eq!(query.limit, Some(10));
        assert_eq!(query.period.as_deref(), Some("7"));
    }

    #[test]
    fn smart_money_local_trend_never_uses_current_snapshot_rows() {
        let conn = Connection::open_in_memory().expect("database");
        migrate_intelligence(&conn).expect("migration");
        conn.execute(
            "INSERT INTO intelligence_smart_signals(
               scope_key,inst_ccy,bucket_at,granularity,data_version,raw_json,fetched_at
             ) VALUES('overview','BTC','2000','snapshot',NULL,'{\"kind\":\"current\"}',2000),
                      ('history','BTC','1000','1h',NULL,'{\"kind\":\"history\"}',1000)",
            [],
        )
        .expect("insert smart signals");
        let rows = query_smart_local(
            &conn,
            &SmartMoneyQuery {
                operation: "signalTrendByFilter".to_string(),
                inst_ccy: Some("BTC".to_string()),
                ts: Some("1500".to_string()),
                granularity: Some("1h".to_string()),
                limit: Some(24),
                ..Default::default()
            },
        )
        .expect("query local trend");
        assert_eq!(rows, vec![json!({ "kind": "history" })]);
    }

    #[test]
    fn derivatives_upsert_and_query_are_idempotent() {
        let conn = Connection::open_in_memory().expect("database");
        migrate_intelligence(&conn).expect("migration");
        let first = json!({"ts": 300000, "last": "65000", "oiUsd": "1000000"});
        let second = json!({"ts": 300000, "last": "65100", "oiUsd": "1100000"});
        upsert_derivatives_items(
            &conn,
            "positioning",
            "BTC-USDT-SWAP",
            "5m",
            &[first],
            400000,
        )
        .expect("first");
        upsert_derivatives_items(
            &conn,
            "positioning",
            "BTC-USDT-SWAP",
            "5m",
            &[second],
            500000,
        )
        .expect("second");
        let rows = query_derivatives_local(
            &conn,
            "positioning",
            &DerivativesQuery {
                inst_id: "BTC-USDT-SWAP".to_string(),
                period: Some("5m".to_string()),
                ..Default::default()
            },
        )
        .expect("query");
        assert_eq!(rows.len(), 1);
        assert_eq!(value_string(&rows[0], &["last"]).as_deref(), Some("65100"));
    }

    #[test]
    fn local_derivative_query_returns_latest_rows_and_aggregates_four_hours() {
        let conn = Connection::open_in_memory().expect("database");
        migrate_intelligence(&conn).expect("migration");
        for index in 0..8_i64 {
            upsert_derivatives_items(
                &conn,
                "takerFlow",
                "BTC-USDT-SWAP",
                "1H",
                &[json!({"ts": index * 3_600_000, "sellVol": "1", "buyVol": "3", "netVol": "2"})],
                index * 3_600_000,
            )
            .expect("hourly flow");
        }
        let latest = query_derivatives_local(
            &conn,
            "takerFlow",
            &DerivativesQuery {
                inst_id: "BTC-USDT-SWAP".to_string(),
                period: Some("1H".to_string()),
                limit: Some(2),
                ..Default::default()
            },
        )
        .expect("latest rows");
        assert_eq!(latest.len(), 2);
        assert_eq!(value_i64(&latest[0], &["ts"]), Some(6 * 3_600_000));
        let aggregated = query_derivatives_local(
            &conn,
            "takerFlow",
            &DerivativesQuery {
                inst_id: "BTC-USDT-SWAP".to_string(),
                period: Some("4H".to_string()),
                limit: Some(2),
                ..Default::default()
            },
        )
        .expect("four hour rows");
        assert_eq!(aggregated.len(), 2);
        assert_eq!(value_f64(&aggregated[0], &["netVol"]), Some(8.0));
        assert_eq!(value_f64(&aggregated[1], &["netVol"]), Some(8.0));
    }

    #[test]
    fn five_minute_rows_build_current_hour_and_four_hour_partial_buckets() {
        let conn = Connection::open_in_memory().expect("database");
        migrate_intelligence(&conn).expect("migration");
        let now = current_epoch_ms();
        let five_minutes = 5 * 60_000_i64;
        let hour = 60 * 60_000_i64;
        let hour_start = now / hour * hour;
        let point_count = ((now - hour_start) / five_minutes + 1).clamp(1, 12);
        for index in 0..point_count {
            let ts = hour_start + index * five_minutes;
            upsert_derivatives_items(
                &conn,
                "positioning",
                "BTC-USDT-SWAP",
                "5m",
                &[json!({
                    "ts": ts,
                    "oi": 1_000 + index,
                    "oiUsd": 10_000 + index
                })],
                now,
            )
            .expect("5m positioning");
            upsert_derivatives_items(
                &conn,
                "takerFlow",
                "BTC-USDT-SWAP",
                "5m",
                &[json!({
                    "ts": ts,
                    "sellVol": 1,
                    "buyVol": 3,
                    "netVol": 2
                })],
                now,
            )
            .expect("5m flow");
        }

        let hourly_query = DerivativesQuery {
            inst_id: "BTC-USDT-SWAP".to_string(),
            period: Some("1H".to_string()),
            end_time: Some(now),
            limit: Some(2),
            ..Default::default()
        };
        let hourly_positioning =
            query_derivatives_local(&conn, "positioning", &hourly_query).expect("hourly OI");
        let hourly_flow =
            query_derivatives_local(&conn, "takerFlow", &hourly_query).expect("hourly flow");
        let latest_oi = hourly_positioning.last().expect("latest hourly OI");
        let latest_flow = hourly_flow.last().expect("latest hourly flow");
        assert_eq!(
            value_string(latest_oi, &["bucketStatus"]).as_deref(),
            Some("partial")
        );
        assert_eq!(
            value_string(latest_oi, &["sourceGranularity"]).as_deref(),
            Some("5m")
        );
        assert_eq!(
            value_f64(latest_oi, &["oi"]),
            Some((1_000 + point_count - 1) as f64)
        );
        let expected_observed_at = (hour_start + point_count * five_minutes).min(now);
        let latest_oi_observed_at =
            value_i64(latest_oi, &["observedAt"]).expect("hourly OI observedAt");
        assert!(latest_oi_observed_at >= expected_observed_at);
        assert!(latest_oi_observed_at <= current_epoch_ms());
        assert_eq!(value_i64(latest_flow, &["pointCount"]), Some(point_count));
        let latest_flow_observed_at =
            value_i64(latest_flow, &["observedAt"]).expect("hourly flow observedAt");
        assert!(latest_flow_observed_at >= expected_observed_at);
        assert!(latest_flow_observed_at <= current_epoch_ms());
        assert_eq!(
            value_f64(latest_flow, &["netVol"]),
            Some((point_count * 2) as f64)
        );

        let four_hour_flow = query_derivatives_local(
            &conn,
            "takerFlow",
            &DerivativesQuery {
                period: Some("4H".to_string()),
                ..hourly_query
            },
        )
        .expect("four hour flow");
        let latest_four_hour = four_hour_flow.last().expect("latest four hour flow");
        assert_eq!(
            value_string(latest_four_hour, &["bucketStatus"]).as_deref(),
            Some("partial")
        );
        assert_eq!(
            value_string(latest_four_hour, &["sourceGranularity"]).as_deref(),
            Some("5m")
        );

        let cutoff = hour_start + 7 * 60_000;
        let cutoff_rows = query_derivatives_local(
            &conn,
            "positioning",
            &DerivativesQuery {
                inst_id: "BTC-USDT-SWAP".to_string(),
                period: Some("1H".to_string()),
                end_time: Some(cutoff),
                limit: Some(2),
                ..Default::default()
            },
        )
        .expect("cutoff-aligned hourly OI");
        let cutoff_latest = cutoff_rows.last().expect("cutoff hourly OI");
        assert_eq!(
            value_string(cutoff_latest, &["bucketStatus"]).as_deref(),
            Some("partial")
        );
        assert!(value_i64(cutoff_latest, &["observedAt"]).expect("cutoff observedAt") <= cutoff);
    }

    #[test]
    fn system_risk_hourly_query_buckets_snapshot_duplicates() {
        let conn = Connection::open_in_memory().expect("database");
        migrate_intelligence(&conn).expect("migration");
        let hour = 60 * 60_000_i64;
        for (ts, balance) in [
            (10 * hour + 5 * 60_000, "100"),
            (10 * hour + 55 * 60_000, "110"),
            (11 * hour + 5 * 60_000, "120"),
        ] {
            upsert_derivatives_items(
                &conn,
                "systemRisk",
                "BTC-USDT-SWAP",
                "snapshot",
                &[json!({
                    "ts": ts,
                    "insuranceBalance": balance,
                    "upperLimit": "70000",
                    "lowerLimit": "60000",
                    "adlState": "unknown"
                })],
                ts,
            )
            .expect("system risk snapshot");
        }
        upsert_derivatives_items(
            &conn,
            "systemRisk",
            "BTC-USDT-SWAP",
            "snapshot",
            &[json!({
                "ts": 10 * hour + 30 * 60_000,
                "adlState": "warning",
                "details": { "state": "warning" }
            })],
            10 * hour + 30 * 60_000,
        )
        .expect("ADL warning snapshot");
        let rows = query_derivatives_local(
            &conn,
            "systemRisk",
            &DerivativesQuery {
                inst_id: "BTC-USDT-SWAP".to_string(),
                period: Some("1H".to_string()),
                start_time: Some(10 * hour),
                end_time: Some(12 * hour - 1),
                limit: Some(24),
                local_only: Some(true),
            },
        )
        .expect("hourly system risk");
        assert_eq!(rows.len(), 2);
        assert_eq!(value_i64(&rows[0], &["ts"]), Some(10 * hour));
        assert_eq!(value_f64(&rows[0], &["insuranceBalance"]), Some(110.0));
        assert_eq!(
            value_string(&rows[0], &["adlState"]).as_deref(),
            Some("warning")
        );
        assert_eq!(value_i64(&rows[1], &["ts"]), Some(11 * hour));
    }

    #[test]
    fn news_event_clustering_requires_similarity_and_coin_or_url_evidence() {
        let conn = Connection::open_in_memory().expect("database");
        migrate_intelligence(&conn).expect("migration");
        let articles = vec![
            json!({"id":"n1","title":"BTC funding rate falls before macro data","platform":"Wire A","url":"https://example.test/story","coins":["BTC"],"publishTime":1000000,"importance":"high"}),
            json!({"id":"n2","title":"BTC funding rate falls ahead of macro data","platform":"Wire B","url":"https://example.test/story?ref=b","coins":["BTC"],"publishTime":1000000 + 60_000,"importance":"high"}),
            json!({"id":"n3","title":"ETH staking deposits rise","platform":"Wire C","coins":["ETH"],"publishTime":1000000 + 90_000}),
        ];
        upsert_news(&conn, &articles, "zh-CN", None, 2_000_000).expect("news");
        assert_eq!(rebuild_news_events(&conn, 2_000_000).expect("events"), 2);
        let events = query_news_events_local(
            &conn,
            &NewsEventQuery {
                limit: Some(10),
                ..Default::default()
            },
        )
        .expect("event query");
        let confirmed = events
            .iter()
            .find(|event| value_i64(event, &["sourceCount"]) == Some(2))
            .expect("confirmed event");
        assert_eq!(
            value_string(confirmed, &["status"]).as_deref(),
            Some("confirmed")
        );
        assert_eq!(value_i64(confirmed, &["articleCount"]), Some(2));
    }

    #[test]
    fn news_feed_paginates_and_tracks_first_seen_unread_state() {
        let conn = Connection::open_in_memory().expect("database");
        migrate_intelligence(&conn).expect("migration");
        upsert_news(
            &conn,
            &[
                json!({"id":"old-news","title":"BTC market update","platform":"A","coins":["BTC"],"publishTime":100}),
                json!({"id":"new-news","title":"ETH market update","platform":"B","coins":["ETH"],"publishTime":200}),
            ],
            "zh-CN",
            None,
            1_000,
        )
        .expect("initial news");
        rebuild_news_events(&conn, 1_000).expect("initial events");
        query_news_read_state(&conn, 2_000).expect("initial read state");
        upsert_news(
            &conn,
            &[json!({"id":"latest-news","title":"SOL market update","platform":"C","coins":["SOL"],"publishTime":300})],
            "zh-CN",
            None,
            3_000,
        )
        .expect("latest news");
        rebuild_news_events(&conn, 3_000).expect("latest events");

        let page = query_news_feed_local(
            &conn,
            &NewsFeedQuery {
                mode: Some("articles".to_string()),
                start_time: Some(0),
                end_time: Some(1_000),
                page: Some(2),
                page_size: Some(1),
                language: Some("zh-CN".to_string()),
                ..Default::default()
            },
            4_000,
        )
        .expect("feed page");
        assert_eq!(page.total, 3);
        assert_eq!(page.total_pages, 3);
        assert_eq!(page.page, 2);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.unread_count, 1);
        assert_eq!(page.items[0].get("unread"), Some(&Value::Bool(false)));

        let read = mark_news_read(&conn, "all", 4_000).expect("mark read");
        assert_eq!(read.unread_events, 0);
        assert_eq!(read.unread_articles, 0);
    }

    #[test]
    fn news_reactions_use_one_minute_candles_and_distinguish_pending_windows() {
        let conn = Connection::open_in_memory().expect("database");
        migrate_intelligence(&conn).expect("migration");
        conn.execute_batch(
            "CREATE TABLE candles (
               symbol TEXT NOT NULL, interval TEXT NOT NULL, open_time INTEGER NOT NULL,
               close_time INTEGER NOT NULL, open TEXT NOT NULL, high TEXT NOT NULL,
               low TEXT NOT NULL, close TEXT NOT NULL, volume TEXT NOT NULL,
               volume_ccy TEXT, volume_quote TEXT, confirm INTEGER NOT NULL,
               source TEXT NOT NULL, updated_at INTEGER NOT NULL,
               PRIMARY KEY (symbol, interval, open_time)
             );",
        )
        .expect("candles table");
        upsert_news(
            &conn,
            &[json!({
                "id": "reaction-news", "title": "BTC market reaction fixture",
                "platform": "Fixture Wire", "coins": ["BTC", "ETH", "NVDA"], "publishTime": 1_000_000
            })],
            "zh-CN",
            None,
            1_000_000,
        )
        .expect("news");
        rebuild_news_events(&conn, 1_000_000).expect("events");
        for (symbol, base_price, target_price) in [
            ("BTC-USDT-SWAP", "100", "110"),
            ("ETH-USDT-SWAP", "50", "55"),
        ] {
            for (open_time, close, volume) in [
                (960_000_i64, base_price, "100"),
                (1_260_000_i64, target_price, "120"),
            ] {
                conn.execute(
                    "INSERT INTO candles(symbol,interval,open_time,close_time,open,high,low,close,volume,volume_quote,confirm,source,updated_at)
                     VALUES(?1,'1m',?2,?2+59999,?3,?3,?3,?3,?4,?4,1,'fixture',?2)",
                    params![symbol, open_time, close, volume],
                )
                .expect("candle");
            }
        }
        refresh_news_reactions(&conn, 1_400_000).expect("reactions");
        let event = query_news_events_local(
            &conn,
            &NewsEventQuery {
                limit: Some(1),
                ..Default::default()
            },
        )
        .expect("event query")
        .remove(0);
        let event_id = value_string(&event, &["id"]).expect("event id");
        let detail = query_news_event_detail_local(&conn, &event_id)
            .expect("detail")
            .remove(0);
        let reactions = detail
            .get("reactions")
            .and_then(Value::as_array)
            .expect("reaction rows");
        assert_eq!(reactions.len(), 8);
        let five_minute = reactions
            .iter()
            .find(|item| {
                value_string(item, &["instId"]).as_deref() == Some("BTC-USDT-SWAP")
                    && value_i64(item, &["windowMinutes"]) == Some(5)
            })
            .expect("BTC 5m");
        assert_eq!(
            value_string(five_minute, &["status"]).as_deref(),
            Some("complete")
        );
        assert!(
            (value_f64(five_minute, &["priceReturnPct"]).unwrap_or_default() - 10.0).abs() < 0.001
        );
        let thirty_minute = reactions
            .iter()
            .find(|item| {
                value_string(item, &["instId"]).as_deref() == Some("ETH-USDT-SWAP")
                    && value_i64(item, &["windowMinutes"]) == Some(30)
            })
            .expect("ETH 30m");
        assert_eq!(
            value_string(thirty_minute, &["status"]).as_deref(),
            Some("pending_window")
        );
        let meta = detail.get("reactionMeta").expect("reaction meta");
        assert_eq!(value_i64(meta, &["requestedCount"]), Some(3));
        assert_eq!(value_i64(meta, &["coveredCount"]), Some(2));
        assert_eq!(
            meta.get("unsupportedCoins")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_str),
            Some("NVDA")
        );
    }

    #[test]
    fn all_market_news_reaction_is_explicit_btc_proxy() {
        let conn = Connection::open_in_memory().expect("database");
        migrate_intelligence(&conn).expect("migration");
        conn.execute_batch(
            "CREATE TABLE candles (
               symbol TEXT NOT NULL, interval TEXT NOT NULL, open_time INTEGER NOT NULL,
               close_time INTEGER NOT NULL, open TEXT NOT NULL, high TEXT NOT NULL,
               low TEXT NOT NULL, close TEXT NOT NULL, volume TEXT NOT NULL,
               volume_ccy TEXT, volume_quote TEXT, confirm INTEGER NOT NULL,
               source TEXT NOT NULL, updated_at INTEGER NOT NULL,
               PRIMARY KEY (symbol, interval, open_time)
             );",
        )
        .expect("candles table");
        upsert_news(
            &conn,
            &[json!({
                "id": "market-news", "title": "Global risk assets move",
                "platform": "Fixture Wire", "publishTime": 1_000_000
            })],
            "zh-CN",
            None,
            1_000_000,
        )
        .expect("news");
        rebuild_news_events(&conn, 1_000_000).expect("events");
        for (open_time, close) in [(960_000_i64, "100"), (1_260_000_i64, "101")] {
            conn.execute(
                "INSERT INTO candles(symbol,interval,open_time,close_time,open,high,low,close,volume,volume_quote,confirm,source,updated_at)
                 VALUES('BTC-USDT-SWAP','1m',?1,?1+59999,?2,?2,?2,?2,'100','100',1,'fixture',?1)",
                params![open_time, close],
            )
            .expect("candle");
        }
        refresh_news_reactions(&conn, 1_400_000).expect("reactions");
        let event = query_news_events_local(
            &conn,
            &NewsEventQuery {
                limit: Some(1),
                ..Default::default()
            },
        )
        .expect("event query")
        .remove(0);
        let event_id = value_string(&event, &["id"]).expect("event id");
        let detail = query_news_event_detail_local(&conn, &event_id)
            .expect("detail")
            .remove(0);
        let reactions = detail
            .get("reactions")
            .and_then(Value::as_array)
            .expect("reaction rows");
        assert_eq!(
            value_string(&reactions[0], &["mappingType"]).as_deref(),
            Some("btc_market_proxy")
        );
        assert_eq!(
            value_string(detail.get("reactionMeta").expect("meta"), &["mode"]).as_deref(),
            Some("market_proxy")
        );
    }

    #[test]
    fn anomaly_detection_waits_for_eighty_percent_coverage() {
        let conn = Connection::open_in_memory().expect("database");
        migrate_intelligence(&conn).expect("migration");
        let items = (0..100)
            .map(|index| {
                json!({
                    "ts": 10_000_000 - index * 300_000,
                    "last": "65000",
                    "oiUsd": if index == 0 { "2000000" } else { "1000000" }
                })
            })
            .collect::<Vec<_>>();
        upsert_derivatives_items(
            &conn,
            "positioning",
            "BTC-USDT-SWAP",
            "5m",
            &items,
            10_000_000,
        )
        .expect("history");
        assert_eq!(
            recompute_derivative_anomalies(&conn, "BTC-USDT-SWAP", 10_000_000).expect("anomalies"),
            0
        );
    }

    #[test]
    fn derivative_retention_uses_granularity_specific_windows() {
        let conn = Connection::open_in_memory().expect("database");
        migrate_intelligence(&conn).expect("migration");
        let now = 800_i64 * 86_400_000;
        upsert_derivatives_items(
            &conn,
            "positioning",
            "BTC-USDT-SWAP",
            "5m",
            &[json!({"ts": now - 181 * 86_400_000, "oiUsd": "1"})],
            now,
        )
        .expect("old 5m");
        upsert_derivatives_items(
            &conn,
            "positioning",
            "BTC-USDT-SWAP",
            "1H",
            &[json!({"ts": now - 181 * 86_400_000 + 1, "oiUsd": "2"})],
            now,
        )
        .expect("hourly");
        let deleted =
            run_retention(&conn, now, &IntelligenceSettings::defaults()).expect("retention");
        assert_eq!(deleted.get("derivatives_snapshots"), Some(&1));
        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM intelligence_derivatives_snapshots",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(remaining, 1);
    }
}
