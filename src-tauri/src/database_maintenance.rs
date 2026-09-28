//! 后台 WAL 检查点。
//!
//! 数据库是 WAL 模式：写入先追加到 `-wal` 文件，靠检查点回写主库。SQLite 只在提交时做 PASSIVE
//! 自动检查点，一旦始终有读事件在进行（行情同步、AI 会话、回测读写交替），检查点追不上，
//! WAL 会涨到数百 MB，所有读取都要在更大的 WAL 索引里查页，偶发的长检查点还会拖慢写入。
//! 这里定期在独立线程上做检查点：PASSIVE 从不阻塞读写；只有 WAL 已全部回写且文件仍然偏大时，
//! 才尝试 TRUNCATE 收缩文件，并用极短的 busy_timeout，遇到读事件立即放弃、下次再试。

use std::time::Duration;

const INTERVAL: Duration = Duration::from_secs(180);
const FIRST_DELAY: Duration = Duration::from_secs(60);
/// 约 64 MB（4 KB 页）：WAL 帧数超过它且已全部回写时才收缩文件。
const TRUNCATE_FRAMES: i64 = 16_384;

pub(crate) fn start_wal_checkpoint_worker(app: tauri::AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("sqlite-wal-checkpoint".to_string())
        .spawn(move || {
            std::thread::sleep(FIRST_DELAY);
            loop {
                if let Err(error) = checkpoint_once(&app) {
                    eprintln!("wal checkpoint skipped: {error}");
                }
                std::thread::sleep(INTERVAL);
            }
        });
    if let Err(error) = spawned {
        eprintln!("wal checkpoint worker not started: {error}");
    }
}

fn checkpoint_once(app: &tauri::AppHandle) -> Result<(), String> {
    let conn = crate::open_database(app)?;
    conn.busy_timeout(Duration::from_millis(50)).map_err(|error| error.to_string())?;
    let started = std::time::Instant::now();
    let (busy, log_frames, checkpointed) = wal_checkpoint(&conn, "PASSIVE")?;
    let elapsed = started.elapsed();
    if elapsed >= Duration::from_millis(500) {
        // 与主线程看门狗的卡顿记录对照：确认检查点本身是否造成磁盘压力。
        crate::boot_log(&format!("wal checkpoint: passive pass took {}ms (log={log_frames} checkpointed={checkpointed})", elapsed.as_millis()));
    }
    if busy == 0 && log_frames > TRUNCATE_FRAMES && checkpointed >= log_frames {
        match wal_checkpoint(&conn, "TRUNCATE") {
            Ok((0, _, _)) => crate::boot_log(&format!("wal checkpoint: truncated {log_frames} frames")),
            Ok(_) => {}
            Err(error) => eprintln!("wal truncate deferred: {error}"),
        }
    } else if log_frames > TRUNCATE_FRAMES {
        eprintln!("wal checkpoint passive: busy={busy} log={log_frames} checkpointed={checkpointed}");
    }
    Ok(())
}

fn wal_checkpoint(conn: &rusqlite::Connection, mode: &str) -> Result<(i64, i64, i64), String> {
    conn.query_row(&format!("PRAGMA wal_checkpoint({mode})"), [], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))
    })
    .map_err(|error| error.to_string())
}
