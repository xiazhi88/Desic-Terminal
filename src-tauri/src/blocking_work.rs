//! 阻塞工作（SQLite、配置文件、钥匙串）与 UI 主线程 / 异步运行时的隔离。
//!
//! - 同步 `#[tauri::command]` 在主线程执行：数据库等锁（最长 30 秒）会让整个窗口卡死。
//! - `#[tauri::command(async)]` 修饰的同步函数、以及异步函数里直接调用的数据库操作，跑在 tokio worker 上。
//!   worker 数等于 CPU 核数，并且与行情 / 私有 WebSocket、下单请求共用；几个慢查询就能占满全部 worker，
//!   行情推送、重连与下单随之停摆（表现为所有连接同时“最近数据 60s+”）。
//!
//! 因此命令体一律离开这两处：
//! - [`run_blocking`]：只读或彼此独立的工作，放到阻塞线程池并行执行；
//! - [`run_serial`]：配置 / 数据写入，放到唯一的写入线程按提交顺序执行，保持原先主线程串行的先后语义；
//! - [`blocking`]：异步流程中间夹带的少量同步数据库调用，就地执行但先把当前 worker 上的其它任务交给别的线程。

use std::sync::mpsc;
use std::sync::OnceLock;

type SerialJob = Box<dyn FnOnce() + Send + 'static>;

static SERIAL_WRITER: OnceLock<mpsc::Sender<SerialJob>> = OnceLock::new();

fn serial_writer() -> &'static mpsc::Sender<SerialJob> {
    SERIAL_WRITER.get_or_init(|| {
        let (sender, receiver) = mpsc::channel::<SerialJob>();
        std::thread::Builder::new()
            .name("desic-serial-writer".to_string())
            .spawn(move || {
                while let Ok(job) = receiver.recv() {
                    // 单个任务 panic 不能带走写入线程，否则后续所有写入命令永远得不到回复。
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
                }
            })
            .expect("serial writer thread");
        sender
    })
}

/// Tauri 默认的异步运行时只有 CPU 核数个 worker。命令体已移出，但仍有异步流程在中途直接做同步数据库调用；
/// 把 worker 数提高到至少 32，让偶发的阻塞不至于占满运行时。行情 / 私有连接另有专用运行时。
const ASYNC_RUNTIME_MIN_WORKERS: usize = 32;

pub(crate) fn install_async_runtime() {
    let workers = std::thread::available_parallelism()
        .map(|count| count.get() * 2)
        .unwrap_or(8)
        .max(ASYNC_RUNTIME_MIN_WORKERS);
    match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(workers)
        .thread_name("desic-async")
        .enable_all()
        .build()
    {
        Ok(runtime) => {
            // 运行时需要与进程同寿命：交给 Tauri 后不再析构。
            let runtime: &'static tokio::runtime::Runtime = Box::leak(Box::new(runtime));
            tauri::async_runtime::set(runtime.handle().clone());
        }
        Err(error) => eprintln!("custom async runtime unavailable, using tauri default: {error}"),
    }
}

/// 在阻塞线程池执行命令体。
pub(crate) async fn run_blocking<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("后台任务异常退出: {error}"))?
}

/// 在唯一的写入线程按提交顺序执行命令体。调用时立即入队（不等首次 poll），顺序即调用顺序。
pub(crate) fn run_serial<T, F>(task: F) -> impl std::future::Future<Output = Result<T, String>>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let (reply, response) = tokio::sync::oneshot::channel();
    let queued = serial_writer()
        .send(Box::new(move || {
            let _ = reply.send(task());
        }))
        .map_err(|_| "写入线程已停止".to_string());
    async move {
        queued?;
        response.await.map_err(|_| "写入任务异常退出".to_string())?
    }
}

/// 在异步流程中就地执行一段同步阻塞工作（数据库读写）。
/// 多线程运行时上改用 `block_in_place`：当前 worker 上排队的其它任务（行情、下单）会被转交给新的 worker；
/// 不在运行时内（测试、独立线程）时直接执行。
pub(crate) fn blocking<T>(work: impl FnOnce() -> T) -> T {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(work)
        }
        _ => work(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serial_jobs_run_in_submission_order_and_survive_panics() {
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).build().unwrap();
        runtime.block_on(async {
            let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let mut pending = Vec::new();
            for index in 0..20 {
                let log = log.clone();
                pending.push(run_serial(move || {
                    log.lock().unwrap().push(index);
                    Ok::<_, String>(index)
                }));
            }
            let panicked = run_serial::<(), _>(|| panic!("boom"));
            // 倒序等待：执行顺序只取决于调用（入队）顺序。
            let mut results = Vec::new();
            for job in pending.into_iter().rev() {
                results.push(job.await.unwrap());
            }
            results.reverse();
            for (index, value) in results.into_iter().enumerate() {
                assert_eq!(value, index);
            }
            assert!(panicked.await.is_err());
            assert_eq!(*log.lock().unwrap(), (0..20).collect::<Vec<_>>());
            assert_eq!(run_serial(|| Ok::<_, String>(7)).await.unwrap(), 7);
        });
    }

    #[test]
    fn blocking_runs_inline_inside_and_outside_a_runtime() {
        assert_eq!(blocking(|| 3), 3);
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).build().unwrap();
        let value = runtime.block_on(async { tokio::spawn(async { blocking(|| 5) }).await.unwrap() });
        assert_eq!(value, 5);
        let current = tokio::runtime::Builder::new_current_thread().build().unwrap();
        assert_eq!(current.block_on(async { blocking(|| 9) }), 9);
    }
}
