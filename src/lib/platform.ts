export type DesktopPlatform = "macos" | "windows" | "linux";

// navigator.platform 在部分引擎中已被弃用，webkit2gtk 仍提供；与 userAgent
// 合并判断以覆盖 X11/Wayland 两种 Linux 桌面会话。
export function detectDesktopPlatform(): DesktopPlatform {
  if (typeof navigator === "undefined") return "windows";
  const platform = `${navigator.platform || ""} ${navigator.userAgent || ""}`;
  if (/Mac|iPhone|iPad|iPod/i.test(platform)) return "macos";
  if (/Linux|X11|Wayland/i.test(platform)) return "linux";
  return "windows";
}

export function applyPlatformAttribute(): DesktopPlatform {
  const platform = detectDesktopPlatform();
  document.documentElement.dataset.os = platform;
  return platform;
}
