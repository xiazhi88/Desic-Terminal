use serde_json::Value;

pub(crate) const AI_STREAM_CHECKPOINT_INTERVAL_MS: u64 = 250;

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
    )
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
    let app = app.clone();
    let session_id = session_id.to_string();
    let message_id = message_id.to_string();
    let content = content.to_string();
    let reasoning = (!reasoning.is_empty()).then(|| reasoning.to_string());
    let process_json = serde_json::to_string(process_events)
        .map_err(|error| format!("序列化 AI 流式检查点失败: {error}"))?;
    let status = status.to_string();

    tokio::task::spawn_blocking(move || {
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
    .map_err(|error| format!("保存 AI 流式检查点任务失败: {error}"))?
}
