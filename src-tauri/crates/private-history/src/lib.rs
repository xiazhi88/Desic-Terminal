use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateHistorySyncRequest {
    pub account_id: Option<String>,
    pub inst_id: Option<String>,
    pub max_pages: Option<u8>,
    pub force: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrivateHistorySyncResult {
    #[serde(default)]
    pub account_id: String,
    #[serde(default)]
    pub environment: String,
    #[serde(default)]
    pub inst_id: Option<String>,
    #[serde(default)]
    pub orders_fetched: usize,
    #[serde(default)]
    pub orders_upserted: usize,
    #[serde(default)]
    pub archive_orders_fetched: usize,
    #[serde(default)]
    pub archive_orders_upserted: usize,
    #[serde(default)]
    pub recent_fills_fetched: usize,
    #[serde(default)]
    pub recent_fills_upserted: usize,
    #[serde(default)]
    pub fills_fetched: usize,
    #[serde(default)]
    pub fills_upserted: usize,
    #[serde(default)]
    pub bills_fetched: usize,
    #[serde(default)]
    pub bills_upserted: usize,
    #[serde(default)]
    pub archive_bills_fetched: usize,
    #[serde(default)]
    pub archive_bills_upserted: usize,
    #[serde(default)]
    pub positions_fetched: usize,
    #[serde(default)]
    pub positions_upserted: usize,
    #[serde(default)]
    pub retry_endpoints: usize,
    #[serde(default)]
    pub new_sync_endpoints: usize,
    #[serde(default)]
    pub backfill_endpoints: usize,
    #[serde(default)]
    pub started_at: i64,
    #[serde(default)]
    pub finished_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateHistoryStatusRequest {
    pub account_id: Option<String>,
    pub inst_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateHistoryEndpointStatus {
    pub scope: String,
    pub inst_id: String,
    pub status: String,
    pub cursor: Option<String>,
    pub newest_cursor: Option<String>,
    pub oldest_cursor: Option<String>,
    pub attempt: i64,
    pub fetched: i64,
    pub upserted: i64,
    pub last_error: Option<String>,
    pub next_retry_at: Option<i64>,
    pub last_started_at: Option<i64>,
    pub last_finished_at: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateHistoryStatusResponse {
    pub account_id: String,
    pub environment: String,
    pub inst_id: Option<String>,
    pub endpoints: Vec<PrivateHistoryEndpointStatus>,
    pub failed: usize,
    pub retrying: usize,
    pub running: usize,
    pub updated_at: Option<i64>,
}

pub fn map_private_history_endpoint_status(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<PrivateHistoryEndpointStatus> {
    Ok(PrivateHistoryEndpointStatus {
        scope: row.get(0)?,
        inst_id: row.get(1)?,
        status: row.get(2)?,
        cursor: row.get(3)?,
        newest_cursor: row.get(4)?,
        oldest_cursor: row.get(5)?,
        attempt: row.get(6)?,
        fetched: row.get(7)?,
        upserted: row.get(8)?,
        last_error: row.get(9)?,
        next_retry_at: row.get(10)?,
        last_started_at: row.get(11)?,
        last_finished_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}
