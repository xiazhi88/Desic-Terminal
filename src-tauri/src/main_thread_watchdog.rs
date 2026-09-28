//! 主线程卡顿诊断。
//!
//! macOS 上界面“转彩球”说明 Tauri 主线程被占住。同步命令（非 async 的 `#[tauri::command]`）就在
//! 主线程上、在 invoke 处理函数内部执行，所以：
//! - 给 invoke 处理函数计时：单次超过 200ms 的命令直接写入 boot.log（命令名 + 耗时）；
//! - 看门狗线程每 250ms 往主线程投递一次探针：超过 1 秒没被执行就记下卡顿时长，
//!   并附上卡顿前最近调用过的命令，便于定位不是由 invoke 引起的卡顿（例如事件派发、窗口操作）。
//! 只写诊断日志，不改变任何命令的行为。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const SLOW_COMMAND: Duration = Duration::from_millis(200);
const PROBE_INTERVAL: Duration = Duration::from_millis(250);
const STALL_THRESHOLD: Duration = Duration::from_secs(1);
const RECENT_LIMIT: usize = 40;

fn recent() -> &'static Mutex<VecDeque<(Instant, String)>> {
    static RECENT: OnceLock<Mutex<VecDeque<(Instant, String)>>> = OnceLock::new();
    RECENT.get_or_init(|| Mutex::new(VecDeque::with_capacity(RECENT_LIMIT)))
}

fn remember(command: &str) {
    if let Ok(mut items) = recent().lock() {
        if items.len() == RECENT_LIMIT {
            items.pop_front();
        }
        items.push_back((Instant::now(), command.to_string()));
    }
}

fn recent_summary(now: Instant) -> String {
    recent()
        .lock()
        .map(|items| {
            items
                .iter()
                .rev()
                .take(15)
                .map(|(at, name)| format!("{name}(-{}ms)", now.saturating_duration_since(*at).as_millis()))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default()
}

/// 包在 generate_handler! 外层：记录命令名，并给主线程上的执行计时。
pub(crate) fn timed_invoke<R: tauri::Runtime>(
    invoke: tauri::ipc::Invoke<R>,
    handler: &dyn Fn(tauri::ipc::Invoke<R>) -> bool,
) -> bool {
    let command = invoke.message.command().to_string();
    remember(&command);
    let started = Instant::now();
    let handled = handler(invoke);
    let elapsed = started.elapsed();
    if elapsed >= SLOW_COMMAND {
        crate::boot_log(&format!("main-thread: command {command} blocked the main thread for {}ms", elapsed.as_millis()));
    }
    handled
}

pub(crate) fn start(app: tauri::AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("main-thread-watchdog".to_string())
        .spawn(move || loop {
            std::thread::sleep(PROBE_INTERVAL);
            let served = Arc::new(AtomicBool::new(false));
            let flag = served.clone();
            let sent = Instant::now();
            if app.run_on_main_thread(move || flag.store(true, Ordering::Release)).is_err() {
                return;
            }
            let mut reported = false;
            while !served.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(50));
                if !reported && sent.elapsed() >= STALL_THRESHOLD {
                    reported = true;
                    crate::boot_log(&format!("main-thread: stall detected (>{}ms); recent commands: {}", STALL_THRESHOLD.as_millis(), recent_summary(Instant::now())));
                }
            }
            if reported {
                crate::boot_log(&format!("main-thread: stall ended after {}ms", sent.elapsed().as_millis()));
            }
        });
    if let Err(error) = spawned {
        crate::boot_log(&format!("main-thread watchdog not started: {error}"));
    }
}
