import { logger } from "./logger";

// 前端线程卡顿诊断：WebKit（Tauri WebView）不支持 longtask API，这里用定时器漂移测量事件循环延迟。
// 超过 1 秒的卡顿写入前端日志（带当前工作区），与 Rust 侧主线程看门狗配合定位卡顿来源。
const INTERVAL_MS = 500;
const STALL_MS = 1000;

let installed = false;

export function installStallMonitor() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  let expected = performance.now() + INTERVAL_MS;
  window.setInterval(() => {
    const now = performance.now();
    const lag = now - expected;
    expected = now + INTERVAL_MS;
    // 窗口在后台时浏览器会节流定时器，不算卡顿。
    if (lag < STALL_MS || document.hidden) return;
    const workspace = document.querySelector(".rail-item.active")?.getAttribute("data-workspace") ?? "unknown";
    logger.warn("ui thread stall", { lagMs: Math.round(lag), workspace });
  }, INTERVAL_MS);
}
