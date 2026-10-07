import {
  archiveTraderHandbook,
  cancelTraderDraft,
  cancelTraderInstruction,
  draftTraderSetup,
  exportTraderHandbook,
  importTraderHandbook,
  listenAiEvents,
  loadAiConfigSummary,
  createTraderHandbook,
  createTraderInstruction,
  listTraderInstructions,
  loadTraderInstructionScopeOrders,
  listTraderHandbooks,
  loadTraderHandbook,
  loadTraderHandbookRevisions,
  publishTraderHandbook,
  renameTraderHandbook,
  rollbackTraderHandbook,
  type TraderHandbook,
  type TraderHandbookDetail,
  type TraderHandbookLibraryEntry,
  type TraderHandbookPublished,
  type TraderHandbookRevision,
  type TraderEntryOrder,
  type TraderInstructionCreated,
  type TraderInstructionInput,
  type TraderInstructionKind,
  type TraderInstructionRow,
  type TraderSetupDraft
} from "../../lib/ai";

/**
 * 交易员工作区用到的手册命令。桌面端走 Tauri 命令；预览页（浏览器里没有桌面命令）换成内存里的假实现，
 * 界面代码不区分两者。
 */
export type TraderHandbookApi = {
  list: (includeArchived: boolean) => Promise<TraderHandbookLibraryEntry[] | null>;
  detail: (handbookId: string) => Promise<TraderHandbookDetail | null>;
  revisions: (handbookId: string) => Promise<TraderHandbookRevision[] | null>;
  create: (name: string, sourceHandbookId: string | null) => Promise<TraderHandbookDetail | null>;
  rename: (handbookId: string, name: string) => Promise<TraderHandbookDetail | null>;
  archive: (handbookId: string, archived: boolean) => Promise<TraderHandbookDetail | null>;
  publish: (handbookId: string, content: TraderHandbook, baseRevision: number, note?: string | null) => Promise<TraderHandbookPublished | null>;
  rollback: (handbookId: string, toRevision: number | null, baseRevision: number) => Promise<TraderHandbookPublished | null>;
  /** 用大白话描述 → 新形态草稿（一律观察中）。`onDelta` 报告已生成的字数。 */
  draftSetup: (request: SetupDraftRequest) => Promise<TraderSetupDraft | null>;
  cancelDraft: (requestId: string) => Promise<void>;
  /** 可选的起草模型与当前模型。 */
  models: () => Promise<{ models: Array<{ id: string; name: string }>; activeModelId: string }>;
  /** 导出 / 导入（桌面端弹系统对话框）。 */
  exportHandbook: (handbookId: string) => Promise<string | null>;
  importHandbook: () => Promise<(TraderHandbookDetail & { importWarnings?: string[] }) | null>;
};

export type SetupDraftRequest = {
  description: string;
  handbookId: string | null;
  model: string | null;
  requestId: string;
  onDelta?: (chars: number) => void;
};

/** 起草请求的 id：侧车与取消命令按它关联（`^[A-Za-z0-9_-]{8,64}$`）。 */
export function newDraftRequestId(prefix = "setup-draft") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const DESKTOP_HANDBOOK_API: TraderHandbookApi = {
  list: listTraderHandbooks,
  detail: loadTraderHandbook,
  revisions: loadTraderHandbookRevisions,
  create: createTraderHandbook,
  rename: renameTraderHandbook,
  archive: archiveTraderHandbook,
  publish: publishTraderHandbook,
  rollback: rollbackTraderHandbook,
  draftSetup: async ({ onDelta, ...request }) => {
    const dispose = onDelta
      ? await listenAiEvents((event) => {
        if (event.type === "agentDraftDelta" && event.requestId === request.requestId) onDelta(event.chars);
      })
      : null;
    try {
      return await draftTraderSetup(request);
    } finally {
      dispose?.();
    }
  },
  cancelDraft: cancelTraderDraft,
  exportHandbook: exportTraderHandbook,
  importHandbook: importTraderHandbook,
  models: async () => {
    const config = await loadAiConfigSummary();
    return { models: (config?.models ?? []).map((model) => ({ id: model.id, name: model.name || model.model })), activeModelId: config?.activeModelId ?? "" };
  }
};

/** 临时指令的命令（预览页同样换成内存实现）。 */
export type TraderInstructionApi = {
  list: (includeHistory: boolean) => Promise<TraderInstructionRow[] | null>;
  scopeOrders: (profileId: string | null, instId: string | null, kind: TraderInstructionKind) => Promise<TraderEntryOrder[] | null>;
  create: (request: TraderInstructionInput) => Promise<TraderInstructionCreated | null>;
  cancel: (id: string) => Promise<void>;
};

export const DESKTOP_INSTRUCTION_API: TraderInstructionApi = {
  list: listTraderInstructions,
  scopeOrders: loadTraderInstructionScopeOrders,
  create: createTraderInstruction,
  cancel: cancelTraderInstruction
};

/** 命令失败时的错误文本（Tauri 把 Rust 的 `Err(String)` 原样抛出来）。 */
export function commandErrorText(error: unknown) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
