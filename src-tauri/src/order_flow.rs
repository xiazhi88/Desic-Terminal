//! 订单流模式：成交量分布（Volume Profile）。
//!
//! 由本地 1m K 线在 SQLite 内按价格桶聚合：每根 1m 的成交量记在其典型价 (H+L+C)/3 所在的桶。
//! 1m 历史由 K 线同步补齐，任何周期、任何时间段都能计算，不依赖盘口历史。
//! 返回覆盖度（实际 1m 根数 / 应有根数），本地缺 K 线时如实披露，不插值。

use serde::Serialize;

const MAX_ROWS: u32 = 240;
const MAX_RANGE_MS: i64 = 400 * 86_400_000;
const VALUE_AREA_SHARE: f64 = 0.7;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeProfile {
    inst_id: String,
    from_ms: i64,
    to_ms: i64,
    bucket: f64,
    /// `[桶下沿价格, 成交量, 其中阳线（收 ≥ 开）的成交量]`，按价格升序，只含有成交的桶。
    /// 阳 / 阴线拆分是 K 线方向口径，不是逐笔主动买卖。
    levels: Vec<(f64, f64, f64)>,
    total_volume: f64,
    /// 成交量最大的价位（桶中点）。
    poc: Option<f64>,
    /// 价值区（围绕 POC 累计 70% 成交量）的上下沿。
    value_area_high: Option<f64>,
    value_area_low: Option<f64>,
    covered_minutes: i64,
    expected_minutes: i64,
}

fn nice_step(value: f64) -> f64 {
    if !value.is_finite() || value <= 0.0 {
        return 1.0;
    }
    let exponent = value.log10().floor();
    let base = 10f64.powf(exponent);
    let fraction = value / base;
    let nice = if fraction <= 1.0 {
        1.0
    } else if fraction <= 2.0 {
        2.0
    } else if fraction <= 5.0 {
        5.0
    } else {
        10.0
    };
    nice * base
}

/// 从 POC 向两侧扩展，每次并入成交量较大的一侧，直到覆盖 70%。
fn value_area(levels: &[(f64, f64, f64)], bucket: f64, total: f64) -> (Option<f64>, Option<f64>, Option<f64>) {
    if levels.is_empty() || total <= 0.0 {
        return (None, None, None);
    }
    let poc_index = levels
        .iter()
        .enumerate()
        .max_by(|left, right| left.1 .1.total_cmp(&right.1 .1))
        .map(|(index, _)| index)
        .unwrap_or(0);
    let (mut low, mut high) = (poc_index, poc_index);
    let mut covered = levels[poc_index].1;
    while covered < total * VALUE_AREA_SHARE && (low > 0 || high + 1 < levels.len()) {
        let below = if low > 0 { levels[low - 1].1 } else { -1.0 };
        let above = if high + 1 < levels.len() { levels[high + 1].1 } else { -1.0 };
        if above >= below {
            high += 1;
            covered += above.max(0.0);
        } else {
            low -= 1;
            covered += below.max(0.0);
        }
    }
    (
        Some(levels[poc_index].0 + bucket / 2.0),
        Some(levels[high].0 + bucket),
        Some(levels[low].0),
    )
}

fn load_profile(conn: &rusqlite::Connection, inst_id: &str, from_ms: i64, to_ms: i64, rows: u32) -> Result<VolumeProfile, String> {
    let (low, high, covered): (Option<f64>, Option<f64>, i64) = conn
        .query_row(
            "SELECT MIN(CAST(low AS REAL)), MAX(CAST(high AS REAL)), COUNT(*)
             FROM candles WHERE symbol = ?1 AND interval = '1m' AND open_time >= ?2 AND open_time <= ?3",
            rusqlite::params![inst_id, from_ms, to_ms],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| error.to_string())?;
    let expected_minutes = ((to_ms - from_ms) / 60_000 + 1).max(0);
    let (Some(low), Some(high)) = (low, high) else {
        return Ok(VolumeProfile {
            inst_id: inst_id.to_string(),
            from_ms,
            to_ms,
            bucket: 0.0,
            levels: Vec::new(),
            total_volume: 0.0,
            poc: None,
            value_area_high: None,
            value_area_low: None,
            covered_minutes: 0,
            expected_minutes,
        });
    };
    let bucket = nice_step(((high - low) / rows as f64).max(high * 1e-6));
    let mut statement = conn
        .prepare_cached(
            "SELECT CAST(((CAST(high AS REAL) + CAST(low AS REAL) + CAST(close AS REAL)) / 3.0) / ?4 AS INTEGER) AS row_index,
                    SUM(CAST(volume AS REAL)),
                    SUM(CASE WHEN CAST(close AS REAL) >= CAST(open AS REAL) THEN CAST(volume AS REAL) ELSE 0 END)
             FROM candles
             WHERE symbol = ?1 AND interval = '1m' AND open_time >= ?2 AND open_time <= ?3
             GROUP BY row_index ORDER BY row_index ASC",
        )
        .map_err(|error| error.to_string())?;
    let levels = statement
        .query_map(rusqlite::params![inst_id, from_ms, to_ms, bucket], |row| {
            Ok((row.get::<_, i64>(0)? as f64 * bucket, row.get::<_, f64>(1)?, row.get::<_, f64>(2)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter(|(_, volume, _)| *volume > 0.0)
        .collect::<Vec<_>>();
    let total_volume = levels.iter().map(|(_, volume, _)| volume).sum::<f64>();
    let (poc, value_area_high, value_area_low) = value_area(&levels, bucket, total_volume);
    Ok(VolumeProfile {
        inst_id: inst_id.to_string(),
        from_ms,
        to_ms,
        bucket,
        levels,
        total_volume,
        poc,
        value_area_high,
        value_area_low,
        covered_minutes: covered,
        expected_minutes,
    })
}

#[tauri::command]
pub async fn order_flow_volume_profile(
    app: tauri::AppHandle,
    inst_id: String,
    from_ms: i64,
    to_ms: i64,
    rows: Option<u32>,
) -> Result<VolumeProfile, String> {
    if inst_id.is_empty() || inst_id.len() > 64 || !inst_id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_') {
        return Err("instId 无效".to_string());
    }
    if to_ms <= from_ms || to_ms - from_ms > MAX_RANGE_MS {
        return Err("成交量分布的时间范围无效".to_string());
    }
    let rows = rows.unwrap_or(120).clamp(20, MAX_ROWS);
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::open_read_database(&app)?;
        load_profile(&conn, &inst_id, from_ms, to_ms, rows)
    })
    .await
    .map_err(|error| format!("成交量分布计算失败: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn_with(rows: &[(i64, f64, f64, f64, f64)]) -> rusqlite::Connection {
        conn_with_open(&rows.iter().map(|&(time, high, low, close, volume)| (time, close, high, low, close, volume)).collect::<Vec<_>>())
    }

    fn conn_with_open(rows: &[(i64, f64, f64, f64, f64, f64)]) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE candles (symbol TEXT, interval TEXT, open_time INTEGER, close_time INTEGER, open TEXT, high TEXT, low TEXT, close TEXT, volume TEXT, confirm INTEGER, PRIMARY KEY(symbol, interval, open_time));",
        )
        .unwrap();
        for (time, open, high, low, close, volume) in rows {
            conn.execute(
                "INSERT INTO candles VALUES('BTC-USDT-SWAP','1m',?1,?1,?2,?3,?4,?5,?6,1)",
                rusqlite::params![time, open.to_string(), high.to_string(), low.to_string(), close.to_string(), volume.to_string()],
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn profile_buckets_typical_price_and_finds_poc_and_value_area() {
        // 价格 99→102（按字典序会比错），成交集中在 101 附近。
        let conn = conn_with(&[
            (0, 100.0, 99.0, 99.5, 1.0),
            (60_000, 101.5, 100.5, 101.0, 10.0),
            (120_000, 101.5, 100.5, 101.0, 12.0),
            (180_000, 102.0, 101.0, 101.5, 3.0),
            (240_000, 99.5, 99.0, 99.2, 1.0),
        ]);
        let profile = load_profile(&conn, "BTC-USDT-SWAP", 0, 240_000, 30).unwrap();
        assert_eq!(profile.covered_minutes, 5);
        assert_eq!(profile.expected_minutes, 5);
        assert!((profile.total_volume - 27.0).abs() < 1e-9);
        let poc = profile.poc.unwrap();
        assert!((poc - 101.0).abs() <= profile.bucket, "poc {poc} bucket {}", profile.bucket);
        assert!(profile.value_area_low.unwrap() <= poc && profile.value_area_high.unwrap() >= poc);
    }

    #[test]
    fn profile_splits_volume_by_candle_direction_with_numeric_compare() {
        // 9.5 → 10.5 为阳线（按字典序 "10.5" < "9.5" 会误判为阴线）。
        let conn = conn_with_open(&[
            (0, 9.5, 10.6, 9.4, 10.5, 4.0),
            (60_000, 10.5, 10.6, 9.4, 9.5, 6.0),
        ]);
        let profile = load_profile(&conn, "BTC-USDT-SWAP", 0, 60_000, 20).unwrap();
        let up = profile.levels.iter().map(|level| level.2).sum::<f64>();
        assert!((up - 4.0).abs() < 1e-9, "up volume {up}");
        assert!((profile.total_volume - 10.0).abs() < 1e-9);
    }

    #[test]
    fn empty_range_reports_zero_coverage() {
        let conn = conn_with(&[]);
        let profile = load_profile(&conn, "BTC-USDT-SWAP", 0, 600_000, 30).unwrap();
        assert!(profile.levels.is_empty());
        assert_eq!(profile.covered_minutes, 0);
        assert_eq!(profile.expected_minutes, 11);
    }
}
