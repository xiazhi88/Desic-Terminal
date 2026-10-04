//! 本机离线语音识别：按需下载 sherpa-onnx 的 C 库与 x-asr 流式模型，校验后解压；识别由 `voice_stream` 在进程内完成。
//!
//! 安全边界（加载下载来的第三方动态库）：
//! - 只从 `desic_voice::local` 里写死的官方发布地址下载，且必须通过写死的 sha256 校验才会解压；
//! - 解压只认白名单里的固定文件，任何其它路径（含 `..`、绝对路径、符号链接）都被忽略；
//! - 安装完成后真实加载一次库与模型并对静音做识别自检，失败就回滚到旧版本；
//! - 识别全程在进程内，不开任何端口，音频不落盘，也不记录识别内容。

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use bzip2::read::BzDecoder;
use desic_voice::local::{self, engine_for, wanted_entry, Asset, EngineAsset, INSTALL_ID, MODEL, MODEL_FILES, MODEL_TOP_DIR};
use sha2::{Digest, Sha256};
use tauri::Emitter;

pub(crate) const PROGRESS_EVENT: &str = "voice:local-progress";
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60 * 30);
const MARKER_FILE: &str = "installed.json";
static INSTALLING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

fn platform_engine() -> Option<EngineAsset> {
    engine_for(std::env::consts::OS, std::env::consts::ARCH)
}

pub(crate) fn install_root() -> PathBuf {
    crate::storage_config::runtime_cache_root().join("voice-local")
}

fn current_dir(root: &Path) -> PathBuf {
    root.join("current")
}

/// 引擎与模型文件齐全、且安装标记与当前资源表一致才算已安装。
pub(crate) fn is_installed_at(root: &Path) -> bool {
    let Some(engine) = platform_engine() else { return false };
    let current = current_dir(root);
    let marker_ok = fs::read_to_string(current.join(MARKER_FILE))
        .map(|content| content.trim() == INSTALL_ID)
        .unwrap_or(false);
    marker_ok
        && current.join("engine").join(engine.library).is_file()
        && MODEL_FILES.iter().all(|file| current.join("model").join(file).is_file())
}

pub(crate) fn is_installed() -> bool {
    is_installed_at(&install_root())
}

pub(crate) fn is_supported() -> bool {
    platform_engine().is_some()
}

pub(crate) fn is_installing() -> bool {
    INSTALLING.load(Ordering::SeqCst)
}

pub(crate) fn total_download_bytes() -> u64 {
    platform_engine().map(|engine| local::total_download_bytes(&engine)).unwrap_or(0)
}

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress<'a> {
    phase: &'a str,
    received_bytes: u64,
    total_bytes: u64,
}

// ───────────────────────────── 下载 ─────────────────────────────

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 流式下载并校验：边写边算 sha256；大小超出预期、校验不符、被取消都会删除半成品。
pub(crate) async fn download_verified(
    client: &reqwest::Client,
    asset: &Asset,
    url: &str,
    dest: &Path,
    mut on_progress: impl FnMut(u64),
) -> Result<(), String> {
    let part = dest.with_extension("part");
    let result = async {
        let mut response = client
            .get(url)
            .timeout(DOWNLOAD_TIMEOUT)
            .send()
            .await
            .map_err(|error| download_error(&error))?;
        if !response.status().is_success() {
            return Err(format!("下载失败：服务器返回 HTTP {}", response.status().as_u16()));
        }
        let mut file = File::create(&part).map_err(|error| format!("无法写入下载文件：{error}"))?;
        let mut hasher = Sha256::new();
        let mut received: u64 = 0;
        // 允许略大于预期（压缩包尾部填充），但绝不无限接收。
        let limit = asset.size.saturating_add(1_048_576);
        while let Some(chunk) = response.chunk().await.map_err(|error| download_error(&error))? {
            if CANCEL.load(Ordering::SeqCst) {
                return Err("已取消下载".to_string());
            }
            received += chunk.len() as u64;
            if received > limit {
                return Err("下载内容比预期大，已中止".to_string());
            }
            hasher.update(&chunk);
            file.write_all(&chunk).map_err(|error| format!("写入下载文件失败：{error}"))?;
            on_progress(received);
        }
        file.flush().map_err(|error| error.to_string())?;
        drop(file);
        if received != asset.size {
            return Err(format!("下载不完整：收到 {received} 字节，应为 {}", asset.size));
        }
        if hex(&hasher.finalize()) != asset.sha256 {
            return Err("校验失败：下载内容与官方发布的哈希不一致，已丢弃".to_string());
        }
        fs::rename(&part, dest).map_err(|error| format!("保存下载文件失败：{error}"))
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_file(&part);
    }
    result
}

fn download_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "下载超时，请检查网络或代理后重试".to_string()
    } else if error.is_connect() {
        "无法连接下载服务器（github.com），请检查网络或代理".to_string()
    } else {
        "下载中断，请重试".to_string()
    }
}

// ───────────────────────────── 解压 ─────────────────────────────

/// 只解出白名单里的固定文件；缺任何一个都算失败。返回解出的文件数。
pub(crate) fn extract_selected(archive: &Path, top_dir: &str, files: &[&str], dest_root: &Path) -> Result<usize, String> {
    let reader = File::open(archive).map_err(|error| format!("无法打开压缩包：{error}"))?;
    let mut tar = tar::Archive::new(BzDecoder::new(reader));
    let mut extracted: Vec<String> = Vec::new();
    for entry in tar.entries().map_err(|error| format!("压缩包损坏：{error}"))? {
        let mut entry = entry.map_err(|error| format!("压缩包损坏：{error}"))?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = match entry.path() {
            Ok(path) => path.to_string_lossy().to_string(),
            Err(_) => continue,
        };
        let Some(relative) = wanted_entry(top_dir, files, &path) else { continue };
        if extracted.contains(&relative) {
            continue;
        }
        let target = dest_root.join(&relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("无法创建目录：{error}"))?;
        }
        let mut out = File::create(&target).map_err(|error| format!("无法写入 {relative}：{error}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|error| format!("解压 {relative} 失败：{error}"))?;
        extracted.push(relative);
    }
    if extracted.len() != files.len() {
        let missing: Vec<&str> = files.iter().copied().filter(|file| !extracted.iter().any(|done| done == file)).collect();
        return Err(format!("压缩包缺少必要文件：{}", missing.join("、")));
    }
    Ok(extracted.len())
}

/// 16kHz 静音采样，用于安装后的自检。
fn silence_samples(millis: u32) -> Vec<f32> {
    vec![0.0; 16 * millis as usize]
}

// ───────────────────────────── 安装 ─────────────────────────────

/// 资源来源。生产环境永远是写死的官方地址；测试里可替换 URL，但哈希与大小仍按传入资源校验。
pub(crate) struct InstallPlan {
    pub engine: EngineAsset,
    pub engine_url: String,
    pub model: Asset,
    pub model_url: String,
}

pub(crate) fn default_plan() -> Result<InstallPlan, String> {
    let engine = platform_engine().ok_or_else(|| "当前系统暂不支持本机语音识别（目前支持 macOS 与 Windows x64）".to_string())?;
    Ok(InstallPlan { engine_url: engine.asset.url.to_string(), engine, model: MODEL, model_url: MODEL.url.to_string() })
}

pub(crate) async fn install_at(
    root: &Path,
    client: &reqwest::Client,
    plan: &InstallPlan,
    mut report: impl FnMut(&str, u64, u64),
) -> Result<(), String> {
    let total = plan.engine.asset.size + plan.model.size;
    let staging = root.join("staging");
    let downloads = root.join("download");
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_dir_all(&downloads);
    fs::create_dir_all(&staging).map_err(|error| format!("无法创建安装目录：{error}"))?;
    fs::create_dir_all(&downloads).map_err(|error| format!("无法创建下载目录：{error}"))?;

    let result: Result<(), String> = async {
        let engine_archive = downloads.join("engine.tar.bz2");
        let model_archive = downloads.join("model.tar.bz2");
        download_verified(client, &plan.engine.asset, &plan.engine_url, &engine_archive, |received| report("downloading-engine", received, total)).await?;
        let base = plan.engine.asset.size;
        download_verified(client, &plan.model, &plan.model_url, &model_archive, |received| report("downloading-model", base + received, total)).await?;

        report("extracting", total, total);
        let engine_dir = staging.join("engine");
        let model_dir = staging.join("model");
        let engine = plan.engine;
        let (engine_archive_c, model_archive_c, engine_dir_c, model_dir_c) = (engine_archive.clone(), model_archive.clone(), engine_dir.clone(), model_dir.clone());
        crate::blocking_work::run_blocking(move || {
            extract_selected(&engine_archive_c, engine.top_dir, engine.files, &engine_dir_c)?;
            extract_selected(&model_archive_c, MODEL_TOP_DIR, MODEL_FILES, &model_dir_c).map(|_| ())
        })
        .await?;
        fs::write(staging.join(MARKER_FILE), INSTALL_ID).map_err(|error| format!("无法写入安装标记：{error}"))?;

        // 换入正式目录，再用静音做一次真实识别自检；加载不起来就回滚。
        let current = current_dir(root);
        let previous = root.join("previous");
        let _ = fs::remove_dir_all(&previous);
        if current.exists() {
            fs::rename(&current, &previous).map_err(|error| format!("无法替换旧版本：{error}"))?;
        }
        if let Err(error) = fs::rename(&staging, &current) {
            if previous.exists() {
                let _ = fs::rename(&previous, &current);
            }
            return Err(format!("无法启用新版本：{error}"));
        }
        report("verifying", total, total);
        // 自检：加载识别库与模型，对静音做一次真实识别；任何一步失败都回滚。
        let check_root = root.to_path_buf();
        let check = crate::blocking_work::run_blocking(move || crate::voice_stream::recognize_once(&check_root, &silence_samples(600))).await;
        match check {
            Ok(_) => {
                let _ = fs::remove_dir_all(&previous);
                Ok(())
            }
            Err(error) => {
                let _ = fs::remove_dir_all(&current);
                if previous.exists() {
                    let _ = fs::rename(&previous, &current);
                }
                Err(format!("引擎安装后自检未通过：{error}"))
            }
        }
    }
    .await;
    let _ = fs::remove_dir_all(&downloads);
    let _ = fs::remove_dir_all(&staging);
    result
}

pub(crate) fn remove_at(root: &Path) -> Result<(), String> {
    for name in ["current", "previous", "staging", "download"] {
        let path = root.join(name);
        if path.exists() {
            fs::remove_dir_all(&path).map_err(|error| format!("无法删除 {name}：{error}"))?;
        }
    }
    Ok(())
}

// ───────────────────────────── Tauri 命令 ─────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalStatus {
    supported: bool,
    installed: bool,
    installing: bool,
    total_download_bytes: u64,
    install_id: &'static str,
}

pub(crate) fn status() -> LocalStatus {
    LocalStatus {
        supported: is_supported(),
        installed: is_installed(),
        installing: is_installing(),
        total_download_bytes: total_download_bytes(),
        install_id: INSTALL_ID,
    }
}

#[tauri::command]
pub(crate) async fn voice_local_status() -> Result<LocalStatus, String> {
    Ok(status())
}

#[tauri::command]
pub(crate) async fn voice_local_install(app: tauri::AppHandle) -> Result<LocalStatus, String> {
    let plan = default_plan()?;
    // 旧识别器仍占着文件时无法替换（Windows 上尤其如此），先释放。
    crate::voice_stream::unload();
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("本机识别引擎正在安装中".to_string());
    }
    CANCEL.store(false, Ordering::SeqCst);
    let client = crate::storage_config::reqwest_client();
    let root = install_root();
    let result = match client {
        Ok(client) => {
            let mut last_emit = Instant::now() - Duration::from_secs(1);
            let emitter = app.clone();
            install_at(&root, &client, &plan, move |phase, received, total| {
                // 下载进度每 200ms 发一次，阶段切换立即发。
                if phase.starts_with("downloading") && last_emit.elapsed() < Duration::from_millis(200) {
                    return;
                }
                last_emit = Instant::now();
                let _ = emitter.emit(PROGRESS_EVENT, Progress { phase, received_bytes: received, total_bytes: total });
            })
            .await
        }
        Err(error) => Err(error),
    };
    INSTALLING.store(false, Ordering::SeqCst);
    let phase = match &result {
        Ok(()) => "done",
        Err(message) if message.contains("已取消") => "cancelled",
        Err(_) => "failed",
    };
    let _ = app.emit(PROGRESS_EVENT, Progress { phase, received_bytes: 0, total_bytes: 0 });
    result?;
    Ok(status())
}

#[tauri::command]
pub(crate) async fn voice_local_cancel() -> Result<(), String> {
    CANCEL.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub(crate) async fn voice_local_remove() -> Result<LocalStatus, String> {
    if is_installing() {
        return Err("正在安装中，请先取消".to_string());
    }
    crate::voice_stream::unload();
    remove_at(&install_root())?;
    Ok(status())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("desic-voice-test-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 造一个 tar.bz2；`raw_names` 里的条目路径原样写入头部（可含 `..` 等恶意路径）。
    fn build_archive(path: &Path, entries: &[(&str, &[u8])]) {
        let mut tar_bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_bytes);
            for (name, data) in entries {
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_mode(0o644);
                header.set_entry_type(tar::EntryType::Regular);
                let bytes = name.as_bytes();
                header.as_old_mut().name[..bytes.len()].copy_from_slice(bytes);
                header.set_cksum();
                builder.append(&header, *data).unwrap();
            }
            builder.finish().unwrap();
        }
        let mut encoder = bzip2::write::BzEncoder::new(File::create(path).unwrap(), bzip2::Compression::fast());
        encoder.write_all(&tar_bytes).unwrap();
        encoder.finish().unwrap();
    }

    #[test]
    fn extract_takes_only_whitelisted_files_and_ignores_traversal() {
        let dir = temp_dir("extract");
        let archive = dir.join("a.tar.bz2");
        build_archive(
            &archive,
            &[
                ("pkg/bin/tool", b"binary"),
                ("pkg/lib/lib.dylib", b"library"),
                ("pkg/bin/unrelated", b"nope"),
                ("pkg/../escape.txt", b"evil"),
                ("../outside.txt", b"evil"),
                ("/abs.txt", b"evil"),
                ("other/bin/tool", b"wrong top"),
            ],
        );
        let dest = dir.join("out");
        let count = extract_selected(&archive, "pkg", &["bin/tool", "lib/lib.dylib"], &dest).unwrap();
        assert_eq!(count, 2);
        assert_eq!(fs::read(dest.join("bin/tool")).unwrap(), b"binary");
        assert_eq!(fs::read(dest.join("lib/lib.dylib")).unwrap(), b"library");
        assert!(!dest.join("bin/unrelated").exists());
        assert!(!dir.join("escape.txt").exists() && !dir.join("outside.txt").exists() && !dest.join("escape.txt").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_fails_when_a_required_file_is_missing() {
        let dir = temp_dir("missing");
        let archive = dir.join("a.tar.bz2");
        build_archive(&archive, &[("pkg/bin/tool", b"binary")]);
        let error = extract_selected(&archive, "pkg", &["bin/tool", "lib/lib.dylib"], &dir.join("out")).unwrap_err();
        assert!(error.contains("lib/lib.dylib"), "{error}");
        let corrupt = dir.join("bad.tar.bz2");
        fs::write(&corrupt, b"this is not a bzip2 archive").unwrap();
        assert!(extract_selected(&corrupt, "pkg", &["bin/tool"], &dir.join("out2")).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    /// 起一个只服务固定字节的本机 HTTP 服务，返回 URL。
    fn serve_bytes(body: Vec<u8>) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        format!("http://127.0.0.1:{port}/asset.tar.bz2")
    }

    fn asset_for(body: &[u8]) -> Asset {
        let hash = hex(&Sha256::digest(body));
        // Asset 的字段是 &'static str；测试里泄漏一份哈希字符串即可。
        Asset { url: "unused", sha256: Box::leak(hash.into_boxed_str()), size: body.len() as u64 }
    }

    #[tokio::test]
    async fn download_accepts_matching_hash_and_reports_progress() {
        let dir = temp_dir("dl-ok");
        let body = vec![7u8; 300_000];
        let url = serve_bytes(body.clone());
        let mut last = 0;
        download_verified(&reqwest::Client::new(), &asset_for(&body), &url, &dir.join("a.bin"), |received| last = received).await.unwrap();
        assert_eq!(last, body.len() as u64);
        assert_eq!(fs::read(dir.join("a.bin")).unwrap(), body);
        assert!(!dir.join("a.part").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn download_rejects_wrong_hash_wrong_size_and_leaves_nothing_behind() {
        let dir = temp_dir("dl-bad");
        let body = vec![1u8; 10_000];
        let url = serve_bytes(body.clone());
        let mut wrong_hash = asset_for(&body);
        wrong_hash.sha256 = "0000000000000000000000000000000000000000000000000000000000000000";
        let error = download_verified(&reqwest::Client::new(), &wrong_hash, &url, &dir.join("a.bin"), |_| {}).await.unwrap_err();
        assert!(error.contains("校验失败"), "{error}");
        assert!(!dir.join("a.bin").exists() && !dir.join("a.part").exists());

        let url = serve_bytes(body.clone());
        let mut short = asset_for(&body);
        short.size = body.len() as u64 + 5_000;
        let error = download_verified(&reqwest::Client::new(), &short, &url, &dir.join("b.bin"), |_| {}).await.unwrap_err();
        assert!(error.contains("不完整"), "{error}");
        assert!(!dir.join("b.bin").exists() && !dir.join("b.part").exists());

        let url = serve_bytes(vec![1u8; 3_000_000]);
        let mut tiny = asset_for(&body);
        tiny.size = 100;
        let error = download_verified(&reqwest::Client::new(), &tiny, &url, &dir.join("c.bin"), |_| {}).await.unwrap_err();
        assert!(error.contains("比预期大"), "{error}");
        assert!(!dir.join("c.part").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn not_installed_without_marker_or_files() {
        let dir = temp_dir("status");
        assert!(!is_installed_at(&dir));
        fs::create_dir_all(dir.join("current")).unwrap();
        fs::write(dir.join("current").join(MARKER_FILE), "old-install-id").unwrap();
        assert!(!is_installed_at(&dir), "标记与当前资源表不一致不能算已安装");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn silence_samples_have_the_requested_length() {
        assert_eq!(silence_samples(600).len(), 16 * 600);
        assert!(silence_samples(600).iter().all(|sample| *sample == 0.0));
    }

    /// 真实资源的端到端：从本机 HTTP 服务（内容是官方发布文件）完整走一遍
    /// 下载 → 校验 → 解压 → 加载 → 自检 → 整段识别 → 流式识别 → 卸载。需要手动准备，所以默认忽略：
    ///   DESIC_VOICE_LOCAL_TEST_BASE=http://127.0.0.1:8765  （目录里放着官方的两个 tar.bz2）
    ///   DESIC_VOICE_LOCAL_TEST_WAV=/path/to/16k-mono.wav
    #[tokio::test]
    #[ignore]
    async fn real_assets_install_and_recognise() {
        let base = std::env::var("DESIC_VOICE_LOCAL_TEST_BASE").expect("DESIC_VOICE_LOCAL_TEST_BASE");
        let wav_path = std::env::var("DESIC_VOICE_LOCAL_TEST_WAV").expect("DESIC_VOICE_LOCAL_TEST_WAV");
        let mut plan = default_plan().unwrap();
        let engine_name = plan.engine.asset.url.rsplit('/').next().unwrap().to_string();
        let model_name = plan.model.url.rsplit('/').next().unwrap().to_string();
        plan.engine_url = format!("{base}/{engine_name}");
        plan.model_url = format!("{base}/{model_name}");

        let root = temp_dir("real-install");
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let mut phases: Vec<String> = Vec::new();
        install_at(&root, &client, &plan, |phase, _, _| {
            if phases.last().map(String::as_str) != Some(phase) {
                phases.push(phase.to_string());
            }
        })
        .await
        .expect("install");
        println!("phases: {phases:?}");
        assert_eq!(phases, ["downloading-engine", "downloading-model", "extracting", "verifying"]);
        assert!(is_installed_at(&root));
        assert!(!root.join("staging").exists() && !root.join("download").exists() && !root.join("previous").exists());

        // 整段识别
        let wav = fs::read(&wav_path).unwrap();
        let samples = desic_voice::local::wav_to_f32(&wav).expect("16k mono wav");
        let started = Instant::now();
        let text = crate::voice_stream::recognize_once(&root, &samples).expect("recognize");
        println!("one-shot in {:?}: {text:?}", started.elapsed());
        assert!(!text.is_empty());

        // 流式：按 160ms 一块喂入，中间结果应当逐步变长，最终结果与整段识别一致
        let streamed = crate::voice_stream::stream_for_test(&root, &samples, 2560);
        println!("partials: {:?}", streamed.partials);
        println!("final   : {:?}", streamed.final_text);
        assert!(streamed.partials.len() >= 2, "流式应当产生多次中间结果");
        assert!(streamed.partials.windows(2).all(|pair| pair[0] != pair[1]), "只在文本变化时才应推送");
        assert_eq!(streamed.final_text, text, "流式最终结果应与整段识别一致");

        remove_at(&root).unwrap();
        assert!(!is_installed_at(&root));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn recognition_refuses_when_not_installed() {
        let dir = temp_dir("recognize");
        let error = crate::voice_stream::recognize_once(&dir, &silence_samples(100)).unwrap_err();
        assert!(!error.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
