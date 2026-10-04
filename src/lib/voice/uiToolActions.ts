/**
 * AI 的 `ui.*` 工具事件 → 导演动作。
 *
 * Rust 侧已经做过白名单校验；这里再按当前界面的真实目录（有哪些合约、指标）校验一遍，
 * 任何不认识的内容整条丢弃，而不是猜测。纯函数，不依赖 React / Tauri。
 */
import type { DirectorAction, DirectorCatalog, DirectorSection, DirectorTimeframe } from "./directorCommands";

export const UI_TOOL_NAMES = ["ui.openWorkspace", "ui.setInstrument", "ui.setTimeframe", "ui.addIndicator", "ui.removeIndicator", "ui.setOrderFlow"] as const;
export type UiToolName = (typeof UI_TOOL_NAMES)[number];

/** 与 directorCommands 的 DIRECTOR_TIMEFRAMES 保持一致（测试里有断言），这里不做运行时导入以便 node 直接测试。 */
export const UI_TIMEFRAMES: readonly DirectorTimeframe[] = ["1m", "3m", "5m", "15m", "30m", "1H", "2H", "4H", "6H", "12H", "1D"];

export const UI_WORKSPACES: readonly DirectorSection[] = ["ai", "terminal", "radar", "opportunities", "automation", "intelligence", "systematic", "data", "config"];

export type AiUiActionEventPayload = {
  id?: string;
  sessionId?: string;
  toolName?: string;
  payload?: Record<string, unknown> | null;
};

export function parseUiActionEvent(event: AiUiActionEventPayload | null | undefined, catalog: DirectorCatalog): DirectorAction[] | null {
  if (!event || typeof event.toolName !== "string") return null;
  const args = event.payload ?? {};
  switch (event.toolName as UiToolName) {
    case "ui.openWorkspace": {
      const section = args.section;
      return typeof section === "string" && (UI_WORKSPACES as readonly string[]).includes(section) ? [{ type: "workspace", section: section as DirectorSection }] : null;
    }
    case "ui.setInstrument": {
      const instId = typeof args.instId === "string" ? args.instId.trim().toUpperCase() : "";
      return catalog.instruments.some((item) => item.instId.toUpperCase() === instId) ? [{ type: "instrument", instId }] : null;
    }
    case "ui.setTimeframe": {
      const bar = args.bar;
      return typeof bar === "string" && (UI_TIMEFRAMES as readonly string[]).includes(bar) ? [{ type: "timeframe", bar: bar as DirectorTimeframe }] : null;
    }
    case "ui.addIndicator":
    case "ui.removeIndicator": {
      const id = typeof args.indicator === "string" ? args.indicator.trim() : "";
      if (!catalog.indicatorIds.includes(id)) return null;
      return [{ type: "indicator", op: event.toolName === "ui.addIndicator" ? "add" : "remove", id }];
    }
    case "ui.setOrderFlow":
      return typeof args.enabled === "boolean" ? [{ type: "orderFlow", enabled: args.enabled }] : null;
    default:
      return null;
  }
}
