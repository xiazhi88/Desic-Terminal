//! 语音输入的 Tauri 命令：保存转写服务配置，并把一段录音发到 OpenAI 兼容的转写接口。
//!
//! 纯逻辑（multipart、校验、解析）在 `desic-voice` crate；这里只负责读写配置、取 Key、发请求。
//! 录音是隐私数据：只发到用户明确选定的服务，每次转写都不落盘、不写日志。

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use desic_voice::{
    build_multipart, build_prompt, describe_error_status, multipart_boundary, normalize_language,
    parse_transcription_response, transcription_url, TranscriptionRequest, MAX_AUDIO_BYTES,
};
use serde::{Deserialize, Serialize};

use crate::storage_config::{
    ai_provider_speaks_openai_http, load_ai_config, reqwest_client, runtime_config_root,
    select_ai_model, write_sensitive_config_file,
};

const CONFIG_FILE: &str = "voice.local.json";
const DEFAULT_MODEL: &str = "whisper-1";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(40);
const SOURCE_NONE: &str = "none";
const SOURCE_ACTIVE_MODEL: &str = "active-model";
const SOURCE_CUSTOM: &str = "custom";
const SOURCE_LOCAL: &str = "local";

static CONFIG_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct VoiceConfig {
    /// `none`（尚未选择）/ `active-model`（沿用当前 AI 模型的服务）/ `custom`（自定义地址）/ `local`（本机离线识别）。
    #[serde(default)]
    source: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    model: String,
    /// 空串表示自动识别。
    #[serde(default)]
    language: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AiEndpointSnapshot {
    provider: String,
    base_url: String,
    api_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedEndpoint {
    url: String,
    api_key: String,
    model: String,
    language: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceConfigSummary {
    source: String,
    base_url: String,
    model: String,
    language: String,
    /// 只告诉前端是否已保存，不回传 Key 本身。
    has_key: bool,
    /// 录音实际会发往的主机名，用于界面上的隐私提示；尚未配置时为空。
    upload_host: Option<String>,
    ready: bool,
    not_ready_reason: Option<String>,
    local_supported: bool,
    local_installed: bool,
    local_installing: bool,
    local_download_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceConfigUpdate {
    source: String,
    #[serde(default)]
    base_url: String,
    /// `None` 表示沿用已保存的 Key。
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    clear_key: bool,
    #[serde(default)]
    model: String,
    #[serde(default)]
    language: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceTranscribeRequest {
    audio_base64: String,
    mime: String,
    #[serde(default)]
    hints: Vec<String>,
    /// 覆盖配置里的语言；缺省沿用配置。
    #[serde(default)]
    language: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceTranscription {
    text: String,
    host: Option<String>,
}

fn config_path() -> PathBuf {
    runtime_config_root().join(CONFIG_FILE)
}

fn load_config() -> Result<VoiceConfig, String> {
    let path = config_path();
    if !path.exists() {
        return Ok(VoiceConfig::default());
    }
    let content = std::fs::read_to_string(&path).map_err(|error| format!("读取语音配置失败：{error}"))?;
    serde_json::from_str::<VoiceConfig>(&content).map_err(|_| "语音配置文件已损坏，请在设置里重新保存".to_string())
}

fn save_config(config: &VoiceConfig) -> Result<(), String> {
    let content = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    write_sensitive_config_file(&config_path(), &content)
}

fn normalize_source(value: &str) -> Result<&'static str, String> {
    match value.trim() {
        "" | SOURCE_NONE => Ok(SOURCE_NONE),
        SOURCE_ACTIVE_MODEL => Ok(SOURCE_ACTIVE_MODEL),
        SOURCE_CUSTOM => Ok(SOURCE_CUSTOM),
        SOURCE_LOCAL => Ok(SOURCE_LOCAL),
        _ => Err("未知的语音转写来源".to_string()),
    }
}

fn host_of(url: &str) -> Option<String> {
    url::Url::parse(url).ok().and_then(|parsed| parsed.host_str().map(str::to_string))
}

/// 把配置和当前 AI 模型合成一个可发请求的终点。纯函数，便于测试。
fn resolve_endpoint(config: &VoiceConfig, ai: Option<&AiEndpointSnapshot>) -> Result<ResolvedEndpoint, String> {
    let language = normalize_language(&config.language)?;
    let model = if config.model.trim().is_empty() { DEFAULT_MODEL.to_string() } else { config.model.trim().to_string() };
    match normalize_source(&config.source)? {
        SOURCE_CUSTOM => {
            let url = transcription_url(&config.base_url)?;
            if config.api_key.trim().is_empty() && !url.starts_with("http://") {
                return Err("请填写语音转写服务的 API Key".to_string());
            }
            Ok(ResolvedEndpoint { url, api_key: config.api_key.trim().to_string(), model, language })
        }
        SOURCE_ACTIVE_MODEL => {
            let ai = ai.ok_or_else(|| "尚未配置 AI 模型，无法沿用其服务做语音转写".to_string())?;
            if !ai_provider_speaks_openai_http(&ai.provider) {
                return Err("当前 AI 模型不是 OpenAI 兼容的服务（例如本机 CLI、Claude、Gemini），请在语音设置里改用自定义地址".to_string());
            }
            if ai.api_key.trim().is_empty() {
                return Err("当前 AI 模型没有 API Key，无法用于语音转写".to_string());
            }
            Ok(ResolvedEndpoint { url: transcription_url(&ai.base_url)?, api_key: ai.api_key.trim().to_string(), model, language })
        }
        SOURCE_LOCAL => Err("本机识别不使用云端服务地址".to_string()),
        _ => Err("尚未选择语音转写服务，请先在 设置 → 通用 → 语音 中配置".to_string()),
    }
}

/// 本机识别是否可用；不可用时给出可操作的原因。
fn local_readiness(supported: bool, installed: bool) -> Result<(), String> {
    if !supported {
        return Err("当前系统暂不支持本机语音识别（目前支持 macOS 与 Windows x64），请改用云端服务".to_string());
    }
    if !installed {
        return Err("本机识别引擎尚未下载，请在 设置 → 通用 → 语音 中点击下载".to_string());
    }
    Ok(())
}

fn active_ai_snapshot(app: &tauri::AppHandle) -> Option<AiEndpointSnapshot> {
    let config = load_ai_config(app).ok()?;
    let active = select_ai_model(&config, None).ok()?;
    Some(AiEndpointSnapshot {
        provider: active.provider.unwrap_or_default(),
        base_url: active.base_url,
        api_key: active.api_key,
    })
}

fn summarize(config: &VoiceConfig, ai: Option<&AiEndpointSnapshot>) -> VoiceConfigSummary {
    summarize_with_local(config, ai, crate::voice_local::is_supported(), crate::voice_local::is_installed(), crate::voice_local::is_installing(), crate::voice_local::total_download_bytes())
}

fn summarize_with_local(
    config: &VoiceConfig,
    ai: Option<&AiEndpointSnapshot>,
    local_supported: bool,
    local_installed: bool,
    local_installing: bool,
    local_download_bytes: u64,
) -> VoiceConfigSummary {
    let source = normalize_source(&config.source).unwrap_or(SOURCE_NONE).to_string();
    let is_local = source == SOURCE_LOCAL;
    let resolved = if is_local { Err(String::new()) } else { resolve_endpoint(config, ai) };
    let local_state = local_readiness(local_supported, local_installed);
    VoiceConfigSummary {
        source,
        base_url: config.base_url.clone(),
        model: if config.model.trim().is_empty() { DEFAULT_MODEL.to_string() } else { config.model.clone() },
        language: if config.language.trim().is_empty() { "auto".to_string() } else { config.language.clone() },
        has_key: !config.api_key.trim().is_empty(),
        upload_host: resolved.as_ref().ok().and_then(|endpoint| host_of(&endpoint.url)),
        ready: if is_local { local_state.is_ok() } else { resolved.is_ok() },
        not_ready_reason: if is_local { local_state.err() } else { resolved.err() },
        local_supported,
        local_installed,
        local_installing,
        local_download_bytes,
    }
}

#[tauri::command]
pub(crate) async fn voice_config_summary(app: tauri::AppHandle) -> Result<VoiceConfigSummary, String> {
    let config = load_config()?;
    Ok(summarize(&config, active_ai_snapshot(&app).as_ref()))
}

#[tauri::command]
pub(crate) async fn voice_save_config(app: tauri::AppHandle, update: VoiceConfigUpdate) -> Result<VoiceConfigSummary, String> {
    let _guard = CONFIG_WRITE_LOCK.lock().map_err(|_| "语音配置正在被其他操作占用".to_string())?;
    let mut config = load_config().unwrap_or_default();
    let source = normalize_source(&update.source)?;
    config.source = source.to_string();
    config.model = update.model.trim().to_string();
    if config.model.chars().count() > 80 || config.model.chars().any(|c| c.is_control() || c == '"') {
        return Err("语音转写模型名称不合法".to_string());
    }
    normalize_language(&update.language)?;
    config.language = if update.language.trim().eq_ignore_ascii_case("auto") { String::new() } else { update.language.trim().to_string() };
    if source == SOURCE_CUSTOM {
        // 先校验地址；非法值不落盘。
        transcription_url(&update.base_url)?;
        config.base_url = update.base_url.trim().trim_end_matches('/').to_string();
    }
    if update.clear_key {
        config.api_key.clear();
    } else if let Some(key) = update.api_key.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        if key.chars().any(|c| c.is_control() || c.is_whitespace()) {
            return Err("API Key 不能包含空白或控制字符".to_string());
        }
        config.api_key = key.to_string();
    }
    save_config(&config)?;
    Ok(summarize(&config, active_ai_snapshot(&app).as_ref()))
}

fn map_transport_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "转写请求超时，请检查网络或代理后重试".to_string()
    } else if error.is_connect() {
        "无法连接转写服务，请检查地址、网络或代理".to_string()
    } else {
        "转写请求失败，请稍后重试".to_string()
    }
}

#[tauri::command]
pub(crate) async fn voice_transcribe(app: tauri::AppHandle, request: VoiceTranscribeRequest) -> Result<VoiceTranscription, String> {
    // base64 长度先粗检，避免为一个明显超限的载荷白白解码。
    if request.audio_base64.len() > MAX_AUDIO_BYTES / 3 * 4 + 8 {
        return Err("录音过大，请缩短单次说话时间".to_string());
    }
    let audio = base64::engine::general_purpose::STANDARD
        .decode(request.audio_base64.as_bytes())
        .map_err(|_| "录音数据无法解码".to_string())?;

    let mut config = load_config()?;
    if let Some(language) = request.language.as_deref() {
        config.language = language.to_string();
    }
    if normalize_source(&config.source)? == SOURCE_LOCAL {
        local_readiness(crate::voice_local::is_supported(), crate::voice_local::is_installed())?;
        normalize_language(&config.language)?;
        let text = crate::voice_stream::recognize_wav(audio).await?;
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err("没有识别到语音内容".to_string());
        }
        // host 为空：录音没有离开本机。
        return Ok(VoiceTranscription { text, host: None });
    }
    let endpoint = resolve_endpoint(&config, active_ai_snapshot(&app).as_ref())?;
    let prompt = build_prompt(&request.hints);
    let boundary = multipart_boundary(
        SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_nanos() as u64).unwrap_or(0),
    );
    let body = build_multipart(
        &TranscriptionRequest {
            audio: &audio,
            mime: &request.mime,
            model: &endpoint.model,
            language: endpoint.language.as_deref(),
            prompt: if prompt.is_empty() { None } else { Some(prompt.as_str()) },
        },
        &boundary,
    )?;

    let client = reqwest_client()?;
    let mut builder = client
        .post(&endpoint.url)
        .timeout(REQUEST_TIMEOUT)
        .header(reqwest::header::CONTENT_TYPE, format!("multipart/form-data; boundary={boundary}"));
    if !endpoint.api_key.is_empty() {
        builder = builder.bearer_auth(&endpoint.api_key);
    }
    let response = builder.body(body).send().await.map_err(|error| map_transport_error(&error))?;
    let status = response.status();
    let text = response.text().await.map_err(|error| map_transport_error(&error))?;
    if !status.is_success() {
        return Err(describe_error_status(status.as_u16(), &text));
    }
    Ok(VoiceTranscription { text: parse_transcription_response(&text)?, host: host_of(&endpoint.url) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ai(provider: &str, base_url: &str, key: &str) -> AiEndpointSnapshot {
        AiEndpointSnapshot { provider: provider.into(), base_url: base_url.into(), api_key: key.into() }
    }

    fn config(source: &str) -> VoiceConfig {
        VoiceConfig { source: source.into(), ..VoiceConfig::default() }
    }

    #[test]
    fn unselected_source_asks_the_user_to_configure() {
        let error = resolve_endpoint(&config(""), None).unwrap_err();
        assert!(error.contains("尚未选择"));
        assert!(resolve_endpoint(&config("bogus"), None).is_err());
    }

    #[test]
    fn custom_source_needs_https_url_and_key() {
        let mut cfg = config("custom");
        assert!(resolve_endpoint(&cfg, None).is_err());
        cfg.base_url = "https://stt.example.com/v1".into();
        assert!(resolve_endpoint(&cfg, None).unwrap_err().contains("API Key"));
        cfg.api_key = "placeholder-key".into();
        let endpoint = resolve_endpoint(&cfg, None).unwrap();
        assert_eq!(endpoint.url, "https://stt.example.com/v1/audio/transcriptions");
        assert_eq!(endpoint.model, DEFAULT_MODEL);
        assert_eq!(endpoint.language, None);
        cfg.base_url = "http://stt.example.com/v1".into();
        assert!(resolve_endpoint(&cfg, None).is_err(), "非回环地址不允许明文 http");
    }

    #[test]
    fn local_self_hosted_service_may_skip_the_key() {
        let mut cfg = config("custom");
        cfg.base_url = "http://localhost:8000/v1".into();
        assert!(resolve_endpoint(&cfg, None).is_ok());
    }

    #[test]
    fn active_model_source_rejects_non_openai_providers_and_missing_keys() {
        let cfg = config("active-model");
        assert!(resolve_endpoint(&cfg, None).is_err());
        assert!(resolve_endpoint(&cfg, Some(&ai("anthropic", "https://api.anthropic.com", "k"))).is_err());
        assert!(resolve_endpoint(&cfg, Some(&ai("claude-code", "", ""))).is_err());
        assert!(resolve_endpoint(&cfg, Some(&ai("openai-native", "https://api.openai.com/v1", ""))).is_err());
        let endpoint = resolve_endpoint(&cfg, Some(&ai("openai-native", "https://api.openai.com/v1", "placeholder-key"))).unwrap();
        assert_eq!(endpoint.url, "https://api.openai.com/v1/audio/transcriptions");
    }

    #[test]
    fn language_auto_becomes_none_and_invalid_is_rejected() {
        let mut cfg = config("custom");
        cfg.base_url = "https://stt.example.com/v1".into();
        cfg.api_key = "placeholder-key".into();
        cfg.language = "zh".into();
        assert_eq!(resolve_endpoint(&cfg, None).unwrap().language.as_deref(), Some("zh"));
        cfg.language = "auto".into();
        assert_eq!(resolve_endpoint(&cfg, None).unwrap().language, None);
        cfg.language = "zh\r\nX: 1".into();
        assert!(resolve_endpoint(&cfg, None).is_err());
    }

    #[test]
    fn local_source_readiness_is_explicit_and_never_has_an_upload_host() {
        let cfg = config("local");
        assert!(resolve_endpoint(&cfg, None).is_err(), "本机识别不应解析出云端终点");
        let ready = summarize_with_local(&cfg, None, true, true, false, 100);
        assert!(ready.ready && ready.upload_host.is_none() && ready.not_ready_reason.is_none());
        let missing = summarize_with_local(&cfg, None, true, false, false, 100);
        assert!(!missing.ready && missing.not_ready_reason.as_deref().unwrap().contains("尚未下载"));
        let unsupported = summarize_with_local(&cfg, None, false, false, false, 0);
        assert!(!unsupported.ready && unsupported.not_ready_reason.as_deref().unwrap().contains("暂不支持"));
        assert_eq!(normalize_source("local").unwrap(), "local");
    }

    #[test]
    fn summary_never_exposes_the_key_and_reports_upload_host() {
        let mut cfg = config("custom");
        cfg.base_url = "https://stt.example.com/v1".into();
        cfg.api_key = "placeholder-key".into();
        let summary = summarize(&cfg, None);
        assert!(summary.has_key && summary.ready);
        assert_eq!(summary.upload_host.as_deref(), Some("stt.example.com"));
        let json = serde_json::to_string(&summary).unwrap();
        assert!(!json.contains("placeholder-key"));
        let unset = summarize(&VoiceConfig::default(), None);
        assert!(!unset.ready && unset.upload_host.is_none() && unset.not_ready_reason.is_some());
    }
}
