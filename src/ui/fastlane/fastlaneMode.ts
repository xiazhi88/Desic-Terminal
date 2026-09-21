/**
 * C29.19 快判模式**产品面总开关**（UI 侧）—— **本版本未开放**。
 *
 * 与 Rust 侧 `src-tauri/src/fastlane.rs::FASTLANE_MODE_ENABLED` **同值、必须一起翻**：
 * 本版本（`false`）只发布"改版后的原有 AI Profile 模式（协作编排 C20–C28）"，
 * 快判模式留到下一个版本；**代码本体一行未删**（`src/ui/fastlane/*` 的组件全部保留，
 * 只是不再渲染）。
 *
 * 值为 `false` 时 UI 的**全部**后果（唯一判断入口 = 本常量，见 `fastlaneUiEnabled()`）：
 *   ① "新建 Profile"选择器只显示**原有 AI Profile 卡片**（快判卡片不渲染）；
 *   ② 快判配置窗口（`FastlaneConfigDialog`）的入口撤下（新建卡片 + 编辑历史快判 Profile 都不打开它）；
 *   ③ 运行记录里的快判卡片（`FastlaneRunRecord` / 快判关键动作）不渲染；
 *   ④ 开发预览页 `?view=fastlane-config` / `?view=fastlane-run` 的**路由保留**（下个版本仍用），
 *      但内容同样按开关渲染 —— 预览页也会在开关关闭时显示"撤下"形态。
 *
 * **下个版本开放**：把本常量与 Rust 侧常量同时改成 `true` 即可（无其它改动）。
 */
export const FASTLANE_MODE_ENABLED = false;

/** 唯一判断入口：是否渲染快判模式的任何入口/卡片。 */
export function fastlaneUiEnabled(): boolean {
  return FASTLANE_MODE_ENABLED;
}
