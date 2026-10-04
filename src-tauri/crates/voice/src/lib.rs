//! 语音输入的纯逻辑：转写请求的构造、校验与响应解析。
//!
//! 这里不做任何网络或文件 IO，也不接触凭据；主 crate 的 `voice` 模块负责读配置、
//! 取 Key 和发请求。

use serde::Deserialize;

/// 单次录音上传上限。30 秒 webm/opus 约 250KB，留足余量但拒绝异常大的载荷。
pub const MAX_AUDIO_BYTES: usize = 3 * 1024 * 1024;
const MAX_PROMPT_CHARS: usize = 600;
const MAX_HINTS: usize = 60;
const MAX_HINT_CHARS: usize = 24;

/// 把浏览器 MediaRecorder 给出的 MIME 映射成上传用的扩展名与规范 MIME。
/// 只放行转写接口通用支持的音频容器，其余一律拒绝。
pub fn audio_format_for_mime(mime: &str) -> Option<(&'static str, &'static str)> {
    let base = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    match base.as_str() {
        "audio/webm" => Some(("webm", "audio/webm")),
        "audio/ogg" => Some(("ogg", "audio/ogg")),
        "audio/mp4" | "audio/x-m4a" | "audio/m4a" | "audio/aac" => Some(("m4a", "audio/mp4")),
        "audio/mpeg" | "audio/mp3" => Some(("mp3", "audio/mpeg")),
        "audio/wav" | "audio/x-wav" | "audio/wave" => Some(("wav", "audio/wav")),
        _ => None,
    }
}

/// 语言只接受 `zh` / `en` / `zh-CN` 这类短代码；`auto` 和空串表示让服务自行判断。
pub fn normalize_language(input: &str) -> Result<Option<String>, String> {
    let value = input.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("auto") {
        return Ok(None);
    }
    let valid = value.len() <= 8
        && value.chars().all(|c| c.is_ascii_alphabetic() || c == '-')
        && value.chars().next().is_some_and(|c| c.is_ascii_alphabetic());
    if !valid {
        return Err("语言代码格式不正确，请使用 zh、en 这类短代码，或留空自动识别".to_string());
    }
    Ok(Some(value.to_string()))
}

/// 规范化转写服务地址并拼出 `/audio/transcriptions`。
/// 录音属于隐私数据：只允许 https，本机回环地址（自建服务）允许 http。
pub fn transcription_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("尚未配置语音转写服务地址".to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    let loopback = ["http://localhost", "http://127.0.0.1", "http://[::1]"]
        .iter()
        .any(|prefix| {
            lower.strip_prefix(prefix).is_some_and(|rest| {
                rest.is_empty() || rest.starts_with(':') || rest.starts_with('/')
            })
        });
    if !lower.starts_with("https://") && !loopback {
        return Err("语音转写服务地址必须使用 https（本机自建服务可用 http://localhost）".to_string());
    }
    if trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) || trimmed.contains('?') || trimmed.contains('#') {
        return Err("语音转写服务地址不能包含空白、查询参数或片段".to_string());
    }
    if lower.ends_with("/audio/transcriptions") {
        return Ok(trimmed.to_string());
    }
    Ok(format!("{trimmed}/audio/transcriptions"))
}

/// 用品种和术语生成转写提示，帮助识别 ETH、止损这类词；限定长度并去重。
pub fn build_prompt(hints: &[String]) -> String {
    let mut seen = std::collections::BTreeSet::new();
    let mut parts: Vec<String> = Vec::new();
    for hint in hints.iter().take(MAX_HINTS * 2) {
        let cleaned: String = hint
            .chars()
            .filter(|c| !c.is_control())
            .take(MAX_HINT_CHARS)
            .collect::<String>()
            .trim()
            .to_string();
        if cleaned.is_empty() || !seen.insert(cleaned.to_ascii_lowercase()) {
            continue;
        }
        parts.push(cleaned);
        if parts.len() >= MAX_HINTS {
            break;
        }
    }
    if parts.is_empty() {
        return String::new();
    }
    let mut prompt = format!("加密货币永续合约交易指令。常见词：{}。", parts.join("、"));
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        prompt = prompt.chars().take(MAX_PROMPT_CHARS).collect();
    }
    prompt
}

pub struct TranscriptionRequest<'a> {
    pub audio: &'a [u8],
    pub mime: &'a str,
    pub model: &'a str,
    pub language: Option<&'a str>,
    pub prompt: Option<&'a str>,
}

/// 与 OpenAI `/audio/transcriptions` 兼容的 multipart/form-data 请求体。
pub fn build_multipart(request: &TranscriptionRequest<'_>, boundary: &str) -> Result<Vec<u8>, String> {
    if request.audio.is_empty() {
        return Err("录音为空".to_string());
    }
    if request.audio.len() > MAX_AUDIO_BYTES {
        return Err("录音过大，请缩短单次说话时间".to_string());
    }
    let (extension, canonical_mime) =
        audio_format_for_mime(request.mime).ok_or_else(|| format!("不支持的录音格式：{}", request.mime))?;
    if boundary.is_empty() || boundary.len() > 70 || !boundary.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("multipart 边界不合法".to_string());
    }
    let model = request.model.trim();
    if model.is_empty() || model.chars().any(|c| c.is_control() || c == '"') {
        return Err("语音转写模型名称不合法".to_string());
    }

    let mut body: Vec<u8> = Vec::with_capacity(request.audio.len() + 512);
    let mut text_field = |name: &str, value: &str| {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes());
        body.extend_from_slice(value.as_bytes());
        body.extend_from_slice(b"\r\n");
    };
    text_field("model", model);
    text_field("response_format", "json");
    text_field("temperature", "0");
    if let Some(language) = request.language.filter(|value| !value.is_empty()) {
        text_field("language", language);
    }
    if let Some(prompt) = request.prompt.filter(|value| !value.is_empty()) {
        text_field("prompt", prompt);
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"voice.{extension}\"\r\nContent-Type: {canonical_mime}\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(request.audio);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    Ok(body)
}

pub fn multipart_boundary(seed: u64) -> String {
    format!("----desic-voice-{seed:016x}")
}

#[derive(Deserialize)]
struct TranscriptionResponse {
    text: Option<String>,
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: Option<ErrorBody>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ErrorBody {
    Detail { message: Option<String> },
    Plain(String),
}

pub fn parse_transcription_response(body: &str) -> Result<String, String> {
    let parsed: TranscriptionResponse = serde_json::from_str(body).map_err(|_| "转写服务返回了无法解析的内容".to_string())?;
    let text = parsed.text.unwrap_or_default();
    let text = text.trim();
    if text.is_empty() {
        return Err("没有识别到语音内容".to_string());
    }
    Ok(text.to_string())
}

/// 从错误响应里取一句可读的原因；不回显整段响应体，避免把服务端的长文本或回显内容带进日志。
pub fn describe_error_status(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<ErrorEnvelope>(body)
        .ok()
        .and_then(|envelope| envelope.error)
        .and_then(|error| match error {
            ErrorBody::Detail { message } => message,
            ErrorBody::Plain(message) => Some(message),
        })
        .map(|message| message.chars().filter(|c| !c.is_control()).take(120).collect::<String>());
    let hint = match status {
        401 | 403 => "API Key 无效或没有权限",
        404 => "该服务不提供语音转写接口，请换一个支持 /audio/transcriptions 的服务",
        413 => "录音过大",
        429 => "请求过于频繁或额度不足",
        500..=599 => "转写服务暂时不可用",
        _ => "转写请求失败",
    };
    match detail {
        Some(detail) if !detail.trim().is_empty() => format!("{hint}（HTTP {status}：{detail}）"),
        _ => format!("{hint}（HTTP {status}）"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_is_mapped_and_unknown_is_rejected() {
        assert_eq!(audio_format_for_mime("audio/webm;codecs=opus"), Some(("webm", "audio/webm")));
        assert_eq!(audio_format_for_mime("audio/mp4"), Some(("m4a", "audio/mp4")));
        assert_eq!(audio_format_for_mime(" AUDIO/WAV "), Some(("wav", "audio/wav")));
        assert_eq!(audio_format_for_mime("video/webm"), None);
        assert_eq!(audio_format_for_mime("application/octet-stream"), None);
    }

    #[test]
    fn language_is_validated() {
        assert_eq!(normalize_language("").unwrap(), None);
        assert_eq!(normalize_language("AUTO").unwrap(), None);
        assert_eq!(normalize_language(" zh ").unwrap().as_deref(), Some("zh"));
        assert_eq!(normalize_language("zh-CN").unwrap().as_deref(), Some("zh-CN"));
        assert!(normalize_language("zh\r\nX-Evil: 1").is_err());
        assert!(normalize_language("123").is_err());
        assert!(normalize_language("abcdefghij").is_err());
    }

    #[test]
    fn url_requires_https_except_loopback() {
        assert_eq!(transcription_url("https://api.openai.com/v1/").unwrap(), "https://api.openai.com/v1/audio/transcriptions");
        assert_eq!(transcription_url("https://x.example/v1/audio/transcriptions").unwrap(), "https://x.example/v1/audio/transcriptions");
        assert_eq!(transcription_url("http://localhost:8000/v1").unwrap(), "http://localhost:8000/v1/audio/transcriptions");
        assert_eq!(transcription_url("http://127.0.0.1:9000").unwrap(), "http://127.0.0.1:9000/audio/transcriptions");
        assert!(transcription_url("http://api.example.com/v1").is_err());
        assert!(transcription_url("http://localhost.evil.com/v1").is_err());
        assert!(transcription_url("http://127.0.0.1.evil.com").is_err());
        assert!(transcription_url("").is_err());
        assert!(transcription_url("https://x.example/v1?key=1").is_err());
        assert!(transcription_url("https://x.example/v 1").is_err());
    }

    #[test]
    fn prompt_is_bounded_and_deduplicated() {
        assert_eq!(build_prompt(&[]), "");
        let prompt = build_prompt(&["ETH".into(), "eth".into(), " 止损 ".into(), "".into()]);
        assert_eq!(prompt, "加密货币永续合约交易指令。常见词：ETH、止损。");
        let many: Vec<String> = (0..500).map(|i| format!("coin{i}")).collect();
        assert!(build_prompt(&many).chars().count() <= MAX_PROMPT_CHARS);
    }

    #[test]
    fn multipart_contains_fields_and_audio() {
        let audio = [1u8, 2, 3, 4];
        let body = build_multipart(
            &TranscriptionRequest { audio: &audio, mime: "audio/webm;codecs=opus", model: "whisper-1", language: Some("zh"), prompt: Some("提示") },
            "----desic-voice-test",
        )
        .unwrap();
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("name=\"model\"\r\n\r\nwhisper-1"));
        assert!(text.contains("name=\"language\"\r\n\r\nzh"));
        assert!(text.contains("name=\"prompt\"\r\n\r\n提示"));
        assert!(text.contains("filename=\"voice.webm\"\r\nContent-Type: audio/webm"));
        assert!(text.ends_with("\r\n------desic-voice-test--\r\n"));
        assert!(body.windows(4).any(|window| window == audio));
    }

    #[test]
    fn multipart_rejects_bad_input() {
        let ok = TranscriptionRequest { audio: &[1], mime: "audio/webm", model: "m", language: None, prompt: None };
        assert!(build_multipart(&ok, "b").is_ok());
        assert!(build_multipart(&TranscriptionRequest { audio: &[], ..ok }, "b").is_err());
        assert!(build_multipart(&TranscriptionRequest { mime: "text/plain", audio: &[1], model: "m", language: None, prompt: None }, "b").is_err());
        assert!(build_multipart(&TranscriptionRequest { model: "a\"b", audio: &[1], mime: "audio/webm", language: None, prompt: None }, "b").is_err());
        assert!(build_multipart(&ok, "bad boundary").is_err());
        let big = vec![0u8; MAX_AUDIO_BYTES + 1];
        assert!(build_multipart(&TranscriptionRequest { audio: &big, mime: "audio/webm", model: "m", language: None, prompt: None }, "b").is_err());
    }

    #[test]
    fn response_parsing() {
        assert_eq!(parse_transcription_response("{\"text\":\" 切到 SOL \"}").unwrap(), "切到 SOL");
        assert!(parse_transcription_response("{\"text\":\"  \"}").is_err());
        assert!(parse_transcription_response("not json").is_err());
    }

    #[test]
    fn error_description_is_short_and_actionable() {
        let message = describe_error_status(404, "{\"error\":{\"message\":\"Not Found\"}}");
        assert!(message.contains("不提供语音转写接口"));
        assert!(message.contains("HTTP 404"));
        let plain = describe_error_status(401, "{\"error\":\"bad key\"}");
        assert!(plain.contains("API Key"));
        let noisy = describe_error_status(500, &"x".repeat(5000));
        assert!(noisy.chars().count() < 120);
    }
}

// ───────────────────────── 本机离线识别（sherpa-onnx + x-asr 流式模型）─────────────────────────
//
// 引擎与模型都是用户点击后按需下载的第三方文件：只从下面写死的官方发布地址下载，
// 并用写死的 sha256 校验，校验不过不解压、不运行。这里只放纯数据与纯逻辑，IO 在主 crate。

pub mod local {
    pub const ENGINE_VERSION: &str = "1.13.8";
    pub const MODEL_NAME: &str = "x-asr-480ms-streaming-zipformer-transducer-zh-en-int8-2026-06-05";
    /// 安装标记：版本与哈希都对得上才算已安装，升级资源表后旧安装自动判为未安装。
    pub const INSTALL_ID: &str = "sherpa-onnx-1.13.8-capi+x-asr-480ms-zh-en-int8-2026-06-05";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Asset {
        pub url: &'static str,
        pub sha256: &'static str,
        pub size: u64,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct EngineAsset {
        pub asset: Asset,
        /// 压缩包内的顶层目录名。
        pub top_dir: &'static str,
        /// 需要解出的文件（相对顶层目录），其余一律忽略。
        pub files: &'static [&'static str],
        /// sherpa-onnx 的 C API 动态库（相对安装目录）。onnxruntime 与它在同一目录。
        pub library: &'static str,
    }

    /// 流式中英双语 Zipformer（480ms 块）。同一份识别器既用于边说边出字，也用于一次性识别整段录音。
    pub const MODEL: Asset = Asset {
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-int8-2026-06-05.tar.bz2",
        sha256: "14919f03b74d9001fc8f2689c2ab1ea42c436db269e8c809144492f41612bfff",
        size: 134_369_642,
    };
    pub const MODEL_TOP_DIR: &str = "sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-int8-2026-06-05";
    pub const MODEL_FILES: &[&str] = &["encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt"];

    const MAC_ARM64: EngineAsset = EngineAsset {
        asset: Asset {
            url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-osx-arm64-shared.tar.bz2",
            sha256: "b10e5c7e2c30ea03de9c442655d14860d9edc475c6251d58a8f5f06e913a1d56",
            size: 20_314_448,
        },
        top_dir: "sherpa-onnx-v1.13.8-osx-arm64-shared",
        files: &["lib/libsherpa-onnx-c-api.dylib", "lib/libonnxruntime.dylib"],
        library: "lib/libsherpa-onnx-c-api.dylib",
    };
    const MAC_X64: EngineAsset = EngineAsset {
        asset: Asset {
            url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-osx-x64-shared.tar.bz2",
            sha256: "54aad64acee9d2d596535a6080d6f22602a720af5460e1d50461b1e1b06bee40",
            size: 22_846_038,
        },
        top_dir: "sherpa-onnx-v1.13.8-osx-x64-shared",
        files: &["lib/libsherpa-onnx-c-api.dylib", "lib/libonnxruntime.dylib"],
        library: "lib/libsherpa-onnx-c-api.dylib",
    };
    const WIN_X64: EngineAsset = EngineAsset {
        asset: Asset {
            url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-win-x64-shared-MT-Release.tar.bz2",
            sha256: "6dffdc715a4465b989446a6105265d2cb345e7101591a17d35534b6758f6e8df",
            size: 24_805_859,
        },
        top_dir: "sherpa-onnx-v1.13.8-win-x64-shared-MT-Release",
        files: &["lib/sherpa-onnx-c-api.dll", "lib/onnxruntime.dll", "lib/onnxruntime_providers_shared.dll"],
        library: "lib/sherpa-onnx-c-api.dll",
    };

    /// 当前平台的引擎资源；Linux 等暂不支持返回 `None`。
    pub fn engine_for(os: &str, arch: &str) -> Option<EngineAsset> {
        match (os, arch) {
            ("macos", "aarch64") => Some(MAC_ARM64),
            ("macos", "x86_64") => Some(MAC_X64),
            ("windows", "x86_64") => Some(WIN_X64),
            _ => None,
        }
    }

    pub fn total_download_bytes(engine: &EngineAsset) -> u64 {
        engine.asset.size + MODEL.size
    }

    /// 把压缩包里的条目路径映射成要解出的相对路径。
    /// 只认「顶层目录/白名单文件」这一种形态：绝对路径、`..`、反斜杠、符号链接式的
    /// 多余层级、白名单之外的任何文件一律返回 `None`，由调用方忽略。
    pub fn wanted_entry(top_dir: &str, files: &[&str], entry_path: &str) -> Option<String> {
        if entry_path.is_empty() || entry_path.starts_with('/') || entry_path.contains('\\') || entry_path.contains('\0') {
            return None;
        }
        let normalized = entry_path.strip_prefix("./").unwrap_or(entry_path);
        let mut parts = normalized.split('/');
        if parts.next()? != top_dir {
            return None;
        }
        let rest: Vec<&str> = parts.collect();
        if rest.is_empty() || rest.iter().any(|part| part.is_empty() || *part == "." || *part == "..") {
            return None;
        }
        let relative = rest.join("/");
        files.contains(&relative.as_str()).then_some(relative)
    }

    /// 解析识别器返回的 JSON 结果，取识别文本；不是 JSON 或没有 `text` 字段返回 `None`。
    /// 去掉可能出现的 `<|zh|>` 这类控制标记，保留正文。
    pub fn parse_result_json(output: &str) -> Option<String> {
        let value: serde_json::Value = serde_json::from_str(output.trim()).ok()?;
        let text = value.get("text")?.as_str()?;
        Some(strip_control_tags(text).trim().to_string())
    }

    fn strip_control_tags(text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(start) = rest.find("<|") {
            out.push_str(&rest[..start]);
            match rest[start..].find("|>") {
                Some(end) => rest = &rest[start + end + 2..],
                None => {
                    rest = "";
                    break;
                }
            }
        }
        out.push_str(rest);
        out
    }

    /// 16kHz 单声道 16bit WAV 的粗校验。
    pub fn is_pcm16_mono_16k_wav(bytes: &[u8]) -> bool {
        bytes.len() > 44
            && &bytes[0..4] == b"RIFF"
            && &bytes[8..12] == b"WAVE"
            && &bytes[12..16] == b"fmt "
            && u16::from_le_bytes([bytes[20], bytes[21]]) == 1
            && u16::from_le_bytes([bytes[22], bytes[23]]) == 1
            && u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]) == 16_000
            && u16::from_le_bytes([bytes[34], bytes[35]]) == 16
    }

    /// 取出 WAV 的 16bit 采样（小端）并转成 [-1, 1] 浮点；只接受 `is_pcm16_mono_16k_wav` 通过的数据。
    pub fn wav_to_f32(bytes: &[u8]) -> Option<Vec<f32>> {
        if !is_pcm16_mono_16k_wav(bytes) {
            return None;
        }
        Some(pcm16le_to_f32(&bytes[44..]))
    }

    /// 16bit 小端 PCM → 浮点；末尾落单的半个采样忽略。
    pub fn pcm16le_to_f32(bytes: &[u8]) -> Vec<f32> {
        bytes.chunks_exact(2).map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32768.0).collect()
    }

    /// 单次推送的最大采样数（约 10 秒），拒绝异常大的载荷。
    pub const MAX_PUSH_SAMPLES: usize = 16_000 * 10;
    /// 流式识别整段上限（与录音上限一致，留出余量）。
    pub const MAX_STREAM_SAMPLES: usize = 16_000 * 40;
    /// 结束前补的静音，让流式模型把最后一个块吐完。
    pub const TAIL_PADDING_SAMPLES: usize = 16_000 * 3 / 2;

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn engine_table_covers_supported_platforms_only() {
            assert!(engine_for("macos", "aarch64").is_some());
            assert!(engine_for("macos", "x86_64").is_some());
            assert!(engine_for("windows", "x86_64").is_some());
            assert!(engine_for("linux", "x86_64").is_none());
            assert!(engine_for("windows", "aarch64").is_none());
        }

        #[test]
        fn every_asset_is_pinned_to_the_official_release_with_a_full_sha256() {
            for (os, arch) in [("macos", "aarch64"), ("macos", "x86_64"), ("windows", "x86_64")] {
                let engine = engine_for(os, arch).unwrap();
                for asset in [engine.asset, MODEL] {
                    assert!(asset.url.starts_with("https://github.com/k2-fsa/sherpa-onnx/releases/download/"), "{}", asset.url);
                    assert_eq!(asset.sha256.len(), 64);
                    assert!(asset.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
                    assert!(asset.size > 1_000_000);
                }
                assert!(engine.files.contains(&engine.library), "库文件必须在解出清单里");
                assert!(engine.files.iter().any(|file| file.contains("onnxruntime")), "必须带 onnxruntime");
                assert!(engine.asset.url.contains(ENGINE_VERSION));
            }
            assert!(MODEL.url.contains("x-asr-480ms"));
            assert!(INSTALL_ID.contains(ENGINE_VERSION));
            for required in ["encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt"] {
                assert!(MODEL_FILES.contains(&required), "{required}");
            }
        }

        #[test]
        fn entry_whitelist_rejects_everything_unexpected() {
            let top = "pkg";
            let files = ["lib/tool", "lib/libx.dylib"];
            assert_eq!(wanted_entry(top, &files, "pkg/lib/tool").as_deref(), Some("lib/tool"));
            assert_eq!(wanted_entry(top, &files, "./pkg/lib/libx.dylib").as_deref(), Some("lib/libx.dylib"));
            for bad in [
                "pkg/lib/other",
                "pkg/lib/tool/extra",
                "other/lib/tool",
                "/pkg/lib/tool",
                "pkg/../lib/tool",
                "pkg/lib/../lib/tool",
                "pkg//lib/tool",
                "pkg\\lib\\tool",
                "pkg",
                "pkg/",
                "",
                "../pkg/lib/tool",
                "pkg/lib/tool\0",
            ] {
                assert_eq!(wanted_entry(top, &files, bad), None, "{bad:?}");
            }
        }

        #[test]
        fn result_json_is_parsed_and_tags_stripped() {
            assert_eq!(parse_result_json("{\"text\": \" 切换到 SOL \", \"tokens\": []}").as_deref(), Some("切换到 SOL"));
            assert_eq!(parse_result_json("{\"text\": \"<|zh|>你好\"}").as_deref(), Some("你好"));
            assert_eq!(parse_result_json("{\"text\": \"\"}").as_deref(), Some(""));
            assert_eq!(parse_result_json("not json"), None);
            assert_eq!(parse_result_json("{\"other\": 1}"), None);
            assert_eq!(strip_control_tags("a<|x|>b<|y"), "ab");
        }

        fn wav_header() -> Vec<u8> {
            let mut wav = vec![0u8; 44];
            wav[0..4].copy_from_slice(b"RIFF");
            wav[8..12].copy_from_slice(b"WAVE");
            wav[12..16].copy_from_slice(b"fmt ");
            wav[20..22].copy_from_slice(&1u16.to_le_bytes());
            wav[22..24].copy_from_slice(&1u16.to_le_bytes());
            wav[24..28].copy_from_slice(&16_000u32.to_le_bytes());
            wav[34..36].copy_from_slice(&16u16.to_le_bytes());
            wav
        }

        #[test]
        fn wav_format_check_and_sample_extraction() {
            let mut wav = wav_header();
            wav.extend_from_slice(&0i16.to_le_bytes());
            wav.extend_from_slice(&16384i16.to_le_bytes());
            wav.extend_from_slice(&(-32768i16).to_le_bytes());
            assert!(is_pcm16_mono_16k_wav(&wav));
            assert_eq!(wav_to_f32(&wav).unwrap(), vec![0.0, 0.5, -1.0]);
            let mut stereo = wav.clone();
            stereo[22..24].copy_from_slice(&2u16.to_le_bytes());
            assert!(!is_pcm16_mono_16k_wav(&stereo));
            assert!(wav_to_f32(&stereo).is_none());
            let mut rate = wav.clone();
            rate[24..28].copy_from_slice(&48_000u32.to_le_bytes());
            assert!(!is_pcm16_mono_16k_wav(&rate));
            assert!(!is_pcm16_mono_16k_wav(&wav[..20]));
            assert!(!is_pcm16_mono_16k_wav(b"not a wav file at all, definitely not riff data......."));
        }

        #[test]
        fn pcm_conversion_ignores_a_dangling_byte() {
            assert_eq!(pcm16le_to_f32(&[0x00, 0x40, 0x01]), vec![0.5]);
            assert!(pcm16le_to_f32(&[]).is_empty());
            assert!(MAX_PUSH_SAMPLES < MAX_STREAM_SAMPLES);
        }
    }
}
