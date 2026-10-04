//! 本机流式语音识别：进程内调用 sherpa-onnx 的 C API（动态加载官方发布的库），
//! 说话的同时逐块出字，松开后再补一段静音取最终结果。
//!
//! 为什么不用官方自带的 websocket 服务端：它监听所有网卡且没有鉴权，首次运行还会触发系统防火墙弹窗。
//! 这里识别器只存在于本进程，不开任何端口。
//!
//! 线程模型：识别器不是线程安全的，所以由**一个专用工作线程**独占；其它线程只通过通道发命令。
//! 空闲 5 分钟后释放识别器（约 200MB 内存），下次说话再加载。

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine as _;
use desic_voice::local::{
    engine_for, parse_result_json, pcm16le_to_f32, wav_to_f32, EngineAsset, MAX_PUSH_SAMPLES, MAX_STREAM_SAMPLES,
    TAIL_PADDING_SAMPLES,
};
use libloading::Library;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

pub(crate) const PARTIAL_EVENT: &str = "voice:partial";
const IDLE_UNLOAD: Duration = Duration::from_secs(300);
const SAMPLE_RATE: i32 = 16_000;

// ───────────────────────────── FFI（与 sherpa-onnx 1.13.8 的 c-api.h 一一对应）─────────────────────────────

#[repr(C)]
struct FeatureConfig {
    sample_rate: i32,
    feature_dim: i32,
}
#[repr(C)]
struct TransducerModelConfig {
    encoder: *const c_char,
    decoder: *const c_char,
    joiner: *const c_char,
}
#[repr(C)]
struct ParaformerModelConfig {
    encoder: *const c_char,
    decoder: *const c_char,
}
#[repr(C)]
struct SingleModelConfig {
    model: *const c_char,
}
#[repr(C)]
struct OnlineModelConfig {
    transducer: TransducerModelConfig,
    paraformer: ParaformerModelConfig,
    zipformer2_ctc: SingleModelConfig,
    tokens: *const c_char,
    num_threads: i32,
    provider: *const c_char,
    debug: i32,
    model_type: *const c_char,
    modeling_unit: *const c_char,
    bpe_vocab: *const c_char,
    tokens_buf: *const c_char,
    tokens_buf_size: i32,
    nemo_ctc: SingleModelConfig,
    t_one_ctc: SingleModelConfig,
}
#[repr(C)]
struct CtcFstDecoderConfig {
    graph: *const c_char,
    max_active: i32,
}
#[repr(C)]
struct HomophoneReplacerConfig {
    dict_dir: *const c_char,
    lexicon: *const c_char,
    rule_fsts: *const c_char,
}
#[repr(C)]
struct OnlineRecognizerConfig {
    feat_config: FeatureConfig,
    model_config: OnlineModelConfig,
    decoding_method: *const c_char,
    max_active_paths: i32,
    enable_endpoint: i32,
    rule1_min_trailing_silence: f32,
    rule2_min_trailing_silence: f32,
    rule3_min_utterance_length: f32,
    hotwords_file: *const c_char,
    hotwords_score: f32,
    ctc_fst_decoder_config: CtcFstDecoderConfig,
    rule_fsts: *const c_char,
    rule_fars: *const c_char,
    blank_penalty: f32,
    hotwords_buf: *const c_char,
    hotwords_buf_size: i32,
    hr: HomophoneReplacerConfig,
}

type CreateRecognizer = unsafe extern "C" fn(*const OnlineRecognizerConfig) -> *const c_void;
type DestroyRecognizer = unsafe extern "C" fn(*const c_void);
type CreateStream = unsafe extern "C" fn(*const c_void) -> *const c_void;
type DestroyStream = unsafe extern "C" fn(*const c_void);
type AcceptWaveform = unsafe extern "C" fn(*const c_void, i32, *const f32, i32);
type IsReady = unsafe extern "C" fn(*const c_void, *const c_void) -> i32;
type Decode = unsafe extern "C" fn(*const c_void, *const c_void);
type GetResultJson = unsafe extern "C" fn(*const c_void, *const c_void) -> *const c_char;
type DestroyResultJson = unsafe extern "C" fn(*const c_char);
type InputFinished = unsafe extern "C" fn(*const c_void);

struct Api {
    create_recognizer: CreateRecognizer,
    destroy_recognizer: DestroyRecognizer,
    create_stream: CreateStream,
    destroy_stream: DestroyStream,
    accept_waveform: AcceptWaveform,
    is_ready: IsReady,
    decode: Decode,
    get_result_json: GetResultJson,
    destroy_result_json: DestroyResultJson,
    input_finished: InputFinished,
    /// 必须比函数指针活得久。
    _library: Library,
}

fn open_library(path: &Path) -> Result<Library, String> {
    #[cfg(windows)]
    {
        // Windows 默认不在 DLL 自己的目录里找它的依赖（onnxruntime.dll）；用「改变搜索路径」让同目录的依赖可被找到。
        let library = unsafe { libloading::os::windows::Library::load_with_flags(path, libloading::os::windows::LOAD_WITH_ALTERED_SEARCH_PATH) };
        library.map(Library::from).map_err(|error| format!("无法加载本机识别库：{error}"))
    }
    #[cfg(not(windows))]
    {
        unsafe { Library::new(path) }.map_err(|error| format!("无法加载本机识别库：{error}"))
    }
}

impl Api {
    fn load(path: &Path) -> Result<Api, String> {
        let library = open_library(path)?;
        macro_rules! symbol {
            ($name:literal, $ty:ty) => {{
                let found: libloading::Symbol<$ty> = unsafe { library.get(concat!($name, "\0").as_bytes()) }
                    .map_err(|error| format!("本机识别库缺少 {}：{error}", $name))?;
                *found
            }};
        }
        Ok(Api {
            create_recognizer: symbol!("SherpaOnnxCreateOnlineRecognizer", CreateRecognizer),
            destroy_recognizer: symbol!("SherpaOnnxDestroyOnlineRecognizer", DestroyRecognizer),
            create_stream: symbol!("SherpaOnnxCreateOnlineStream", CreateStream),
            destroy_stream: symbol!("SherpaOnnxDestroyOnlineStream", DestroyStream),
            accept_waveform: symbol!("SherpaOnnxOnlineStreamAcceptWaveform", AcceptWaveform),
            is_ready: symbol!("SherpaOnnxIsOnlineStreamReady", IsReady),
            decode: symbol!("SherpaOnnxDecodeOnlineStream", Decode),
            get_result_json: symbol!("SherpaOnnxGetOnlineStreamResultAsJson", GetResultJson),
            destroy_result_json: symbol!("SherpaOnnxDestroyOnlineStreamResultJson", DestroyResultJson),
            input_finished: symbol!("SherpaOnnxOnlineStreamInputFinished", InputFinished),
            _library: library,
        })
    }
}

// ───────────────────────────── 识别器与会话 ─────────────────────────────

struct Engine {
    api: Api,
    recognizer: *const c_void,
}

// 识别器只会在创建它的工作线程（或测试里的单线程）里使用。
unsafe impl Send for Engine {}

impl Engine {
    fn load(root: &Path, engine: &EngineAsset) -> Result<Engine, String> {
        let current = root.join("current");
        let api = Api::load(&current.join("engine").join(engine.library))?;
        let model = current.join("model");
        let path_c = |name: &str| -> Result<CString, String> {
            CString::new(model.join(name).to_string_lossy().as_bytes()).map_err(|_| "模型路径含有非法字符".to_string())
        };
        let encoder = path_c("encoder.int8.onnx")?;
        let decoder = path_c("decoder.onnx")?;
        let joiner = path_c("joiner.int8.onnx")?;
        let tokens = path_c("tokens.txt")?;
        let provider = CString::new("cpu").unwrap();
        let method = CString::new("greedy_search").unwrap();
        let threads = std::thread::available_parallelism().map(|count| count.get().clamp(1, 4)).unwrap_or(2) as i32;
        let null = std::ptr::null();
        let single = || SingleModelConfig { model: null };
        let config = OnlineRecognizerConfig {
            feat_config: FeatureConfig { sample_rate: SAMPLE_RATE, feature_dim: 80 },
            model_config: OnlineModelConfig {
                transducer: TransducerModelConfig { encoder: encoder.as_ptr(), decoder: decoder.as_ptr(), joiner: joiner.as_ptr() },
                paraformer: ParaformerModelConfig { encoder: null, decoder: null },
                zipformer2_ctc: single(),
                tokens: tokens.as_ptr(),
                num_threads: threads,
                provider: provider.as_ptr(),
                debug: 0,
                model_type: null,
                modeling_unit: null,
                bpe_vocab: null,
                tokens_buf: null,
                tokens_buf_size: 0,
                nemo_ctc: single(),
                t_one_ctc: single(),
            },
            decoding_method: method.as_ptr(),
            max_active_paths: 4,
            // 说话何时结束由用户松手决定，不用引擎的端点检测。
            enable_endpoint: 0,
            rule1_min_trailing_silence: 2.4,
            rule2_min_trailing_silence: 1.2,
            rule3_min_utterance_length: 20.0,
            hotwords_file: null,
            hotwords_score: 1.5,
            ctc_fst_decoder_config: CtcFstDecoderConfig { graph: null, max_active: 3000 },
            rule_fsts: null,
            rule_fars: null,
            blank_penalty: 0.0,
            hotwords_buf: null,
            hotwords_buf_size: 0,
            hr: HomophoneReplacerConfig { dict_dir: null, lexicon: null, rule_fsts: null },
        };
        let recognizer = unsafe { (api.create_recognizer)(&config) };
        if recognizer.is_null() {
            return Err("本机识别引擎初始化失败（模型文件可能已损坏，请在设置里删除后重新下载）".to_string());
        }
        Ok(Engine { api, recognizer })
    }

    fn new_session(&self) -> Result<Session, String> {
        let stream = unsafe { (self.api.create_stream)(self.recognizer) };
        if stream.is_null() {
            return Err("无法创建识别会话".to_string());
        }
        Ok(Session { stream, last_text: String::new(), fed: 0 })
    }

    fn feed(&self, session: &mut Session, samples: &[f32]) {
        if samples.is_empty() {
            return;
        }
        session.fed += samples.len();
        unsafe { (self.api.accept_waveform)(session.stream, SAMPLE_RATE, samples.as_ptr(), samples.len() as i32) };
        self.drain(session);
    }

    fn drain(&self, session: &Session) {
        // 每次最多解码若干块，避免极端情况下长时间占住线程。
        for _ in 0..64 {
            if unsafe { (self.api.is_ready)(self.recognizer, session.stream) } == 0 {
                break;
            }
            unsafe { (self.api.decode)(self.recognizer, session.stream) };
        }
    }

    fn text(&self, session: &Session) -> String {
        let raw = unsafe { (self.api.get_result_json)(self.recognizer, session.stream) };
        if raw.is_null() {
            return String::new();
        }
        let json = unsafe { CStr::from_ptr(raw) }.to_string_lossy().to_string();
        unsafe { (self.api.destroy_result_json)(raw) };
        parse_result_json(&json).unwrap_or_default()
    }

    /// 补静音、标记输入结束、解码到底，返回最终文本并销毁会话。
    fn finish(&self, mut session: Session) -> String {
        let silence = vec![0.0f32; TAIL_PADDING_SAMPLES];
        unsafe {
            (self.api.accept_waveform)(session.stream, SAMPLE_RATE, silence.as_ptr(), silence.len() as i32);
            (self.api.input_finished)(session.stream);
        }
        self.drain(&session);
        let text = self.text(&session);
        self.destroy_session(&mut session);
        text
    }

    fn destroy_session(&self, session: &mut Session) {
        if !session.stream.is_null() {
            unsafe { (self.api.destroy_stream)(session.stream) };
            session.stream = std::ptr::null();
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        if !self.recognizer.is_null() {
            unsafe { (self.api.destroy_recognizer)(self.recognizer) };
        }
    }
}

struct Session {
    stream: *const c_void,
    last_text: String,
    fed: usize,
}
unsafe impl Send for Session {}

/// 一次性识别一整段 16kHz 采样（安装自检、整段录音识别）。每次新建识别器，不依赖全局工作线程。
pub(crate) fn recognize_once(root: &Path, samples: &[f32]) -> Result<String, String> {
    let engine_asset = engine_for(std::env::consts::OS, std::env::consts::ARCH).ok_or_else(|| "当前系统暂不支持本机语音识别".to_string())?;
    let engine = Engine::load(root, &engine_asset)?;
    let mut session = engine.new_session()?;
    for chunk in samples.chunks(8000) {
        engine.feed(&mut session, chunk);
    }
    Ok(engine.finish(session))
}

// ───────────────────────────── 工作线程 ─────────────────────────────

enum Command {
    Start(Sender<Result<(), String>>),
    Push(Vec<f32>, Sender<Result<(), String>>),
    Finish(Sender<Result<String, String>>),
    Cancel,
    /// 释放识别器（重装 / 卸载前调用，避免占着模型文件）。
    Unload,
}

type PartialSink = Arc<dyn Fn(String) + Send + Sync>;

struct Worker {
    tx: Sender<Command>,
}

fn worker_loop(root: PathBuf, sink: PartialSink, rx: mpsc::Receiver<Command>) {
    let mut engine: Option<Engine> = None;
    let mut session: Option<Session> = None;
    loop {
        let command = match rx.recv_timeout(IDLE_UNLOAD) {
            Ok(command) => command,
            Err(RecvTimeoutError::Timeout) => {
                if session.is_none() {
                    engine = None;
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => return,
        };
        match command {
            Command::Start(reply) => {
                let result = (|| -> Result<(), String> {
                    if let (Some(old), Some(loaded)) = (session.as_mut(), engine.as_ref()) {
                        loaded.destroy_session(old);
                    }
                    session = None;
                    if engine.is_none() {
                        let asset = engine_for(std::env::consts::OS, std::env::consts::ARCH).ok_or_else(|| "当前系统暂不支持本机语音识别".to_string())?;
                        engine = Some(Engine::load(&root, &asset)?);
                    }
                    session = Some(engine.as_ref().unwrap().new_session()?);
                    Ok(())
                })();
                let _ = reply.send(result);
            }
            Command::Push(samples, reply) => {
                let result = match (engine.as_ref(), session.as_mut()) {
                    (Some(loaded), Some(live)) => {
                        if live.fed + samples.len() > MAX_STREAM_SAMPLES {
                            Err("录音过长，已停止识别".to_string())
                        } else {
                            loaded.feed(live, &samples);
                            let text = loaded.text(live);
                            if text != live.last_text {
                                live.last_text = text.clone();
                                sink(text);
                            }
                            Ok(())
                        }
                    }
                    _ => Err("识别会话尚未开始".to_string()),
                };
                let _ = reply.send(result);
            }
            Command::Finish(reply) => {
                let result = match (engine.as_ref(), session.take()) {
                    (Some(loaded), Some(live)) => Ok(loaded.finish(live)),
                    _ => Err("识别会话尚未开始".to_string()),
                };
                let _ = reply.send(result);
            }
            Command::Cancel => {
                if let (Some(loaded), Some(mut live)) = (engine.as_ref(), session.take()) {
                    loaded.destroy_session(&mut live);
                }
            }
            Command::Unload => {
                if let (Some(loaded), Some(mut live)) = (engine.as_ref(), session.take()) {
                    loaded.destroy_session(&mut live);
                }
                engine = None;
            }
        }
    }
}

impl Worker {
    fn spawn(root: PathBuf, sink: PartialSink) -> Worker {
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("voice-recognizer".to_string())
            .spawn(move || worker_loop(root, sink, rx))
            .expect("spawn voice recognizer thread");
        Worker { tx }
    }

    fn call<T>(&self, build: impl FnOnce(Sender<Result<T, String>>) -> Command) -> Result<T, String> {
        let (reply, response) = mpsc::channel();
        self.tx.send(build(reply)).map_err(|_| "本机识别线程已停止".to_string())?;
        response.recv().map_err(|_| "本机识别线程异常退出".to_string())?
    }

    fn start(&self) -> Result<(), String> {
        self.call(Command::Start)
    }
    fn push(&self, samples: Vec<f32>) -> Result<(), String> {
        self.call(|reply| Command::Push(samples, reply))
    }
    fn finish(&self) -> Result<String, String> {
        self.call(Command::Finish)
    }
    fn cancel(&self) {
        let _ = self.tx.send(Command::Cancel);
    }
}

static WORKER: OnceLock<Mutex<Option<Worker>>> = OnceLock::new();

/// 释放常驻的识别器（如果已加载）。
pub(crate) fn unload() {
    if let Some(slot) = WORKER.get() {
        let guard = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(worker) = guard.as_ref() {
            let _ = worker.tx.send(Command::Unload);
        }
    }
}

fn with_worker<T>(app: &tauri::AppHandle, run: impl FnOnce(&Worker) -> T) -> T {
    let slot = WORKER.get_or_init(|| Mutex::new(None));
    let mut guard = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.is_none() {
        let handle = app.clone();
        let sink: PartialSink = Arc::new(move |text| {
            let _ = handle.emit(PARTIAL_EVENT, PartialPayload { text });
        });
        *guard = Some(Worker::spawn(crate::voice_local::install_root(), sink));
    }
    run(guard.as_ref().unwrap())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PartialPayload {
    text: String,
}

// ───────────────────────────── Tauri 命令 ─────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StreamPush {
    /// 16kHz 单声道 16bit 小端 PCM 的 base64。
    pcm_base64: String,
}

fn ensure_ready() -> Result<(), String> {
    if !crate::voice_local::is_supported() {
        return Err("当前系统暂不支持本机语音识别（目前支持 macOS 与 Windows x64）".to_string());
    }
    if !crate::voice_local::is_installed() {
        return Err("本机识别引擎尚未下载，请在 设置 → 通用 → 语音 中点击下载".to_string());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn voice_stream_start(app: tauri::AppHandle) -> Result<(), String> {
    ensure_ready()?;
    crate::blocking_work::run_blocking(move || with_worker(&app, |worker| worker.start())).await
}

#[tauri::command]
pub(crate) async fn voice_stream_push(app: tauri::AppHandle, request: StreamPush) -> Result<(), String> {
    // base64 长度先粗检，避免为明显超限的载荷白白解码。
    if request.pcm_base64.len() > MAX_PUSH_SAMPLES * 2 / 3 * 4 + 8 {
        return Err("音频块过大".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(request.pcm_base64.as_bytes()).map_err(|_| "音频数据无法解码".to_string())?;
    let mut samples = pcm16le_to_f32(&bytes);
    if samples.len() > MAX_PUSH_SAMPLES {
        return Err("音频块过大".to_string());
    }
    for sample in &mut samples {
        if !sample.is_finite() {
            *sample = 0.0;
        }
    }
    crate::blocking_work::run_blocking(move || with_worker(&app, |worker| worker.push(samples))).await
}

#[tauri::command]
pub(crate) async fn voice_stream_finish(app: tauri::AppHandle) -> Result<String, String> {
    let text = crate::blocking_work::run_blocking(move || with_worker(&app, |worker| worker.finish())).await?;
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("没有识别到语音内容".to_string());
    }
    Ok(text)
}

#[tauri::command]
pub(crate) async fn voice_stream_cancel(app: tauri::AppHandle) -> Result<(), String> {
    crate::blocking_work::run_blocking(move || {
        with_worker(&app, |worker| worker.cancel());
        Ok(())
    })
    .await
}

/// 整段 WAV 的一次性识别（`voice_transcribe` 选了本机时使用）。
pub(crate) async fn recognize_wav(wav: Vec<u8>) -> Result<String, String> {
    ensure_ready()?;
    let samples = wav_to_f32(&wav).ok_or_else(|| "录音格式不符合本机识别要求（需要 16kHz 单声道 16bit WAV）".to_string())?;
    if samples.len() > MAX_STREAM_SAMPLES {
        return Err("录音过长".to_string());
    }
    let root = crate::voice_local::install_root();
    crate::blocking_work::run_blocking(move || recognize_once(&root, &samples)).await
}

#[cfg(test)]
pub(crate) struct StreamedForTest {
    pub partials: Vec<String>,
    pub final_text: String,
}

/// 测试用：把采样按 `chunk` 个一块喂给一个新的工作线程，收集中间结果与最终结果。
#[cfg(test)]
pub(crate) fn stream_for_test(root: &Path, samples: &[f32], chunk: usize) -> StreamedForTest {
    let collected = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink_store = collected.clone();
    let sink: PartialSink = Arc::new(move |text| sink_store.lock().unwrap().push(text));
    let worker = Worker::spawn(root.to_path_buf(), sink);
    worker.start().expect("start");
    for block in samples.chunks(chunk) {
        worker.push(block.to_vec()).expect("push");
    }
    let final_text = worker.finish().expect("finish").trim().to_string();
    let partials = collected.lock().unwrap().clone();
    StreamedForTest { partials, final_text }
}
