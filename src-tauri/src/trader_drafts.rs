//! 交易手册的 AI 起草：用户用大白话描述打法 → 一个新形态草稿（一律「观察中」）；按用户的纠正改写已有形态。
//! 复用 Agent 草稿的侧车通道（`generateAgentDraft`，提示词随请求下发；取消走 `ai_agent_generate_cancel`），
//! 侧车不需要改动。提示词、示例与宽松解析在 `desic_agent_automation::setup_draft`。草稿不会自动写进手册。

use super::*;
use desic_agent_automation::{HandbookSetup, SetupRevisionDraft};

/// 手册里已有的形态 id 附在描述后面，提醒模型不要重名（解析时还会再保证一次）。
fn describe_with_existing(description: &str, existing: &[String]) -> String {
    if existing.is_empty() {
        description.trim().to_string()
    } else {
        format!("{}\n（手册里已有的形态 id：{}。新形态的 id 不要和它们重复。）", description.trim(), existing.join(", "))
    }
}

/// 用户描述 → 新形态草稿。返回 `{ setup, notes, warnings }`；用户在抽屉里看过、改过才会保存进手册。
#[tauri::command]
pub(crate) async fn ai_trader_setup_draft(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, AiRuntime>,
    description: String,
    handbook_id: Option<String>,
    name: Option<String>,
    model: Option<String>,
    request_id: Option<String>,
) -> Result<Value, String> {
    let description = description.trim().to_string();
    if description.is_empty() {
        return Err("先用几句话描述你的打法".to_string());
    }
    if description.chars().count() > 2_000 {
        return Err("描述最多 2000 个字".to_string());
    }
    let worker_app = app.clone();
    let existing = crate::blocking_work::run_blocking(move || {
        let conn = open_read_database(&worker_app)?;
        let loaded = crate::trader_handbooks::load_handbook(&conn, handbook_id.as_deref());
        Ok::<_, String>(loaded.handbook.setups.iter().map(|setup| setup.id.clone()).collect::<Vec<_>>())
    })
    .await?;
    let config = crate::agent_library::resolve_agent_draft_model(&crate::storage_config::load_ai_config(&app)?, model.as_deref())?;
    let request_id = crate::agent_library::resolve_agent_draft_request_id(request_id.as_deref(), format!("setup-draft-{}", crate::ai_automation::unique_suffix()));
    let name = name.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    let payload = crate::agent_library::build_draft_payload(
        &request_id,
        &describe_with_existing(&description, &existing),
        name.as_deref(),
        &config,
        desic_agent_automation::SETUP_DRAFT_SYSTEM_PROMPT,
        desic_agent_automation::SETUP_DRAFT_USER_PROMPT,
        desic_agent_automation::setup_draft_messages(),
    );
    let raw = crate::agent_library::request_sidecar_draft(&app, runtime.inner(), &request_id, payload).await?;
    let draft = desic_agent_automation::parse_setup_draft(&raw, &existing)?;
    serde_json::to_value(draft).map_err(|err| err.to_string())
}

/// 给改写形态用的描述：当前形态（JSON）+ 用户的纠正（每条附当时的结果）。
pub(crate) fn revision_description(current: &HandbookSetup, corrections: &[String]) -> Result<String, String> {
    let mut body = serde_json::to_value(current).map_err(|err| err.to_string())?;
    if let Some(object) = body.as_object_mut() {
        object.remove("id");
        object.remove("status");
    }
    Ok(format!("当前形态：\n{}\n用户的纠正（最近 30 天）：\n{}", body, corrections.join("\n")))
}

/// 按用户的纠正改写一个形态（手册修改建议的起草）。
pub(crate) async fn draft_setup_revision(
    app: &tauri::AppHandle,
    runtime: &AiRuntime,
    current: &HandbookSetup,
    corrections: &[String],
    model: Option<&str>,
    request_id: Option<&str>,
) -> Result<SetupRevisionDraft, String> {
    let config = crate::agent_library::resolve_agent_draft_model(&crate::storage_config::load_ai_config(app)?, model)?;
    let request_id = crate::agent_library::resolve_agent_draft_request_id(request_id, format!("setup-revision-{}", crate::ai_automation::unique_suffix()));
    let payload = crate::agent_library::build_draft_payload(
        &request_id,
        &revision_description(current, corrections)?,
        Some(&current.name),
        &config,
        desic_agent_automation::SETUP_REVISION_SYSTEM_PROMPT,
        desic_agent_automation::SETUP_REVISION_USER_PROMPT,
        desic_agent_automation::setup_revision_messages(),
    );
    let raw = crate::agent_library::request_sidecar_draft(app, runtime, &request_id, payload).await?;
    desic_agent_automation::parse_setup_revision(&raw, current)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_draft_payload_uses_the_handbook_prompts_and_examples() {
        let config: desic_storage_config::AiConfig = serde_json::from_value(json!({
            "provider": "openai-compatible",
            "model": "preview-model",
            "baseUrl": "http://127.0.0.1:8004/v1",
            "apiKey": "placeholder-key",
            "activeModelId": "preview",
            "models": [],
        }))
        .expect("deserialize ai config");
        let payload = crate::agent_library::build_draft_payload(
            "setup-draft-test-1",
            &describe_with_existing("突破回踩", &["trend_pullback".into()]),
            None,
            &config,
            desic_agent_automation::SETUP_DRAFT_SYSTEM_PROMPT,
            desic_agent_automation::SETUP_DRAFT_USER_PROMPT,
            desic_agent_automation::setup_draft_messages(),
        );
        assert_eq!(payload["type"], "generateAgentDraft");
        assert_eq!(payload["requestId"], "setup-draft-test-1");
        assert!(payload["description"].as_str().unwrap().contains("已有的形态 id：trend_pullback"));
        assert!(payload["prompts"]["system"].as_str().unwrap().starts_with("你是交易手册编辑助手"));
        assert_eq!(payload["prompts"]["messages"].as_array().unwrap().len(), 2, "examples are never empty, so the sidecar never falls back to Agent examples");
        assert_eq!(payload["config"]["permissionMode"], "advisor");
    }

    #[test]
    fn revision_description_hides_id_and_status() {
        let setup = desic_agent_automation::default_handbook().setups.remove(0);
        let text = revision_description(&setup, &["- 10-04 BTC｜方向错".into()]).unwrap();
        assert!(!text.contains("\"id\"") && !text.contains("\"status\""), "{text}");
        assert!(text.contains("用户的纠正（最近 30 天）：\n- 10-04 BTC｜方向错"));
    }
}
