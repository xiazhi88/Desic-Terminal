// 界面外观：磷光（默认）/ 经典。作为过渡回退保留一个版本，稳定后移除经典外观。
// 外观只作用于根节点 data-visual 属性，所有样式差异都在 src/theme/phosphor.css 中按属性作用域生效。

export type VisualPreference = "phosphor" | "classic";

const STORAGE_KEY = "desic.ui.visual.v1";
const CHANGE_EVENT = "desic:visual-preference";

export function readVisualPreference(): VisualPreference {
  // 验收与冒烟测试可用 ?visual=classic|phosphor 临时指定外观，不写入偏好。
  const override = new URLSearchParams(window.location.search).get("visual");
  if (override === "classic" || override === "phosphor") return override;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "classic" ? "classic" : "phosphor";
  } catch {
    return "phosphor";
  }
}

/** 启动时尽早调用，保证首帧就是目标外观，避免闪烁。 */
export function applyVisualPreference(preference: VisualPreference = readVisualPreference()) {
  document.documentElement.dataset.visual = preference;
}

export function saveVisualPreference(preference: VisualPreference) {
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // 本地存储不可用时仍在本次会话内生效。
  }
  applyVisualPreference(preference);
  window.dispatchEvent(new CustomEvent<VisualPreference>(CHANGE_EVENT, { detail: preference }));
}

export function isPhosphorVisual() {
  return document.documentElement.dataset.visual !== "classic";
}

export function subscribeVisualPreference(listener: (preference: VisualPreference) => void) {
  const handleChange = (event: Event) => listener((event as CustomEvent<VisualPreference>).detail);
  // 多窗口：其他窗口改了外观，storage 事件同步过来。
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    const next = readVisualPreference();
    applyVisualPreference(next);
    listener(next);
  };
  window.addEventListener(CHANGE_EVENT, handleChange);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handleChange);
    window.removeEventListener("storage", handleStorage);
  };
}
