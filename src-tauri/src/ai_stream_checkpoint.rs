use serde_json::Value;
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

pub(crate) const AI_STREAM_CHECKPOINT_INTERVAL_MS: u64 = 250;

/// 投递段归因（纯增量打点）：最近若干次 checkpoint 落库的时间片，按 session 归口。
///
/// 为什么要记：`persist_ai_stream_checkpoint` 是 `async fn`，调用方（turn 事件循环）
/// 会在这里 `.await` 住 —— 期间同一个 task 无法 `recv()` 下一个事件。要判定
/// 「工具分发是否被落库 `await` 顺延」，必须把落库占位时间片取下来，才能拿每个
/// 工具请求的 `[readAt, pickedAt]` 窗口去对拍。
///
/// 关闭条件：`DESIC_TOOL_DELIVERY_TRACE=0`（见 `ai_tool_delivery_trace_enabled`）。
const AI_STREAM_CHECKPOINT_TICK_CAP: usize = 4096;

type CheckpointTickLog = Mutex<VecDeque<(String, i64, i64)>>;

fn checkpoint_tick_log() -> &'static CheckpointTickLog {
    static TICKS: OnceLock<CheckpointTickLog> = OnceLock::new();
    TICKS.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn record_ai_stream_checkpoint_tick(session_id: &str, started_at: i64, ended_at: i64) {
    let Ok(mut ticks) = checkpoint_tick_log().lock() else {
        return;
    };
    if ticks.len() >= AI_STREAM_CHECKPOINT_TICK_CAP {
        ticks.pop_front();
    }
    ticks.push_back((session_id.to_string(), started_at, ended_at));
}

/// 取走该 session 的落库时间片（取走即清空：一个 turn 的收尾只 dump 一次）。
pub(super) fn take_ai_stream_checkpoint_ticks(session_id: &str) -> Vec<(i64, i64)> {
    let Ok(mut ticks) = checkpoint_tick_log().lock() else {
        return Vec::new();
    };
    let mut taken = Vec::new();
    let mut kept = VecDeque::with_capacity(ticks.len());
    while let Some((owner, started_at, ended_at)) = ticks.pop_front() {
        if owner == session_id {
            taken.push((started_at, ended_at));
        } else {
            kept.push_back((owner, started_at, ended_at));
        }
    }
    *ticks = kept;
    taken
}

pub(crate) fn persist_ai_stream_checkpoint_with_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
    message_id: &str,
    content: &str,
    reasoning: Option<&str>,
    process_json: &str,
    status: &str,
) -> Result<(), String> {
    super::upsert_ai_message(
        conn,
        message_id,
        session_id,
        "assistant",
        content,
        reasoning,
        Some(process_json),
        Some(status),
    )?;
    // 后台 Run 的心跳：检查点每 250ms 就可能落一次，这里顺手推进 `ai_agent_runs.updated_at`。
    // 僵尸运行清理（ai_automation::fail_stale_running_runs）依赖它区分"还在跑"与"进程已死"，
    // 否则只能靠 started_at 猜，会误杀长时间但健康的运行。
    if let Some(run_id) = session_id.strip_prefix("background:") {
        if !run_id.is_empty() {
            let _ = conn.execute(
                "UPDATE ai_agent_runs SET updated_at=?2 WHERE id=?1 AND status='running'",
                rusqlite::params![run_id, super::now_ms()],
            );
        }
    }
    Ok(())
}

pub(crate) async fn persist_ai_stream_checkpoint(
    app: &tauri::AppHandle,
    session_id: &str,
    message_id: &str,
    content: &str,
    reasoning: &str,
    process_events: &[Value],
    status: &str,
) -> Result<(), String> {
    let trace_enabled = super::ai_tool_delivery_trace_enabled();
    let trace_session_id = session_id.to_string();
    let trace_started_at = super::now_ms();
    let app = app.clone();
    let session_id = session_id.to_string();
    let message_id = message_id.to_string();
    let content = content.to_string();
    let reasoning = (!reasoning.is_empty()).then(|| reasoning.to_string());
    let process_json = serde_json::to_string(process_events)
        .map_err(|error| format!("序列化 AI 流式检查点失败: {error}"))?;
    let status = status.to_string();

    let result = tokio::task::spawn_blocking(move || {
        let conn = super::open_database(&app)?;
        persist_ai_stream_checkpoint_with_conn(
            &conn,
            &session_id,
            &message_id,
            &content,
            reasoning.as_deref(),
            &process_json,
            &status,
        )
    })
    .await
    .map_err(|error| format!("保存 AI 流式检查点任务失败: {error}"))?;
    // 纯打点：只记时刻，不改写库结果，也不改变调用方看到的返回值。
    if trace_enabled {
        record_ai_stream_checkpoint_tick(&trace_session_id, trace_started_at, super::now_ms());
    }
    result
}
