import type { AiOptimizationSuggestion, AiChatMessage, AiConfigSummary, AiConfigUpdate, AiConnectionTestResult, AiEvent, AiLocalAuthStatus, AiModelConfigUpdate, AiPendingPrompt, AiPermissionMode, AiPromptDelivery, AiReasoningDepth, AiSession, AiSessionSnapshot, AiTokenUsageDashboard } from "../types";
import { invokeDesktop, invokeOptional, listenOptional } from "./tauri";

export async function loadAiConfigSummary(): Promise<AiConfigSummary | null> {
  return invokeOptional<AiConfigSummary>("ai_config_summary");
}

export async function loadAiTokenUsageSummary(): Promise<AiTokenUsageDashboard | null> {
  return invokeOptional<AiTokenUsageDashboard>("ai_token_usage_summary");
}

/** 值守心电图用的轻量运行记录（`ai_automation_runs_in_range`）；完整内容走 `ai_automation_run_detail`。 */
export type AiAutomationPulseTokens = { inputTokens: number; outputTokens: number; cacheReadTokens: number; totalTokens: number };
export type AiAutomationPulseRun = {
  id: string;
  profileId: string;
  triggerType: string;
  status: string;
  recordKind: string;
  startedAt: number;
  finishedAt: number | null;
  nextWakeAt: number | null;
  error: string | null;
  actionCounts: { opportunity: number; wake: number; trade: number; notification: number };
  tokenUsage: AiAutomationPulseTokens | null;
  triage: {
    mode: string | null;
    verdict: string | null;
    phase: string | null;
    forced: boolean;
    forcedBy: string[];
    sampled: boolean;
    triageTokens: number | null;
    deepTokens: number | null;
    triageUsage: AiAutomationPulseTokens | null;
    deepUsage: AiAutomationPulseTokens | null;
  } | null;
  expertCount: number;
  expertToolCalls: number;
};
export type AiAutomationPulseRange = { fromMs: number; toMs: number; runs: AiAutomationPulseRun[]; truncated: boolean };

export async function loadAiAutomationRunsInRange(fromMs: number, toMs: number, profileId?: string | null): Promise<AiAutomationPulseRange | null> {
  return invokeDesktop<AiAutomationPulseRange>("ai_automation_runs_in_range", {
    fromMs: Math.floor(fromMs),
    toMs: Math.ceil(toMs),
    profileId: profileId || null
  }, { quiet: true });
}

/** 两种运行模式（经典 / 交易员）在一段时间内的对比（`ai_automation_mode_comparison`）。 */
export type AiAutomationModeComparisonRow = {
  mode: "tools" | "briefing";
  runs: number;
  failedRuns: number;
  medianInputTokens: number | null;
  medianTotalTokens: number | null;
  medianDurationMs: number | null;
  opportunitiesCreated: number;
  opportunitiesExecuted: number;
  closedTrades: number;
  netPnl: number | null;
};

export async function loadAiAutomationModeComparison(fromMs: number, toMs: number): Promise<AiAutomationModeComparisonRow[] | null> {
  return invokeDesktop<AiAutomationModeComparisonRow[]>("ai_automation_mode_comparison", {
    fromMs: Math.floor(fromMs),
    toMs: Math.ceil(toMs)
  }, { quiet: true });
}

/** 交易员 Profile 的成绩单（`ai_trader_scorecard`）。 */
export type TraderScorecardGroup = {
  /** 分组属于哪本手册（不同手册里同 id 的形态分开统计）。 */
  handbookId: string;
  setupId: string;
  regime: string;
  side: string;
  n: number;
  wins: number;
  avgR: number;
  shrunkAvgR: number;
  totalR: number;
  realN: number;
  realAvgR: number | null;
  /** 其中形态处于「观察中」时记下的条数（只有影子结果）。 */
  observingN: number;
  flagged: boolean;
};
export type TraderDecisionRow = {
  id: string;
  runId: string;
  instId: string;
  createdAt: number;
  setupId: string | null;
  side: string | null;
  action: string;
  entry: number | null;
  stop: number | null;
  target: number | null;
  probability: number | null;
  validUntil: number | null;
  reason: string | null;
  regimeDaily: string | null;
  regime4h: string | null;
  againstDirection: boolean;
  regimeMismatch: boolean;
  shadowStatus: string;
  shadowNote: string | null;
  shadowR: number | null;
  exitKind: string | null;
  realR: number | null;
  opportunityId: string | null;
  handbookVersion: number | null;
  handbookId: string;
  /** 决策时形态的状态：`live` / `observing`；没写形态时为空。 */
  setupStatus: string | null;
  /** 你对这条决策的纠正（没有时为空）。 */
  correction?: TraderCorrection | null;
};
export type TraderCorrectionCategory = "wrong_direction" | "bad_location" | "wrong_regime" | "bad_levels" | "missed_trade" | "other";
export const TRADER_CORRECTION_CATEGORIES: TraderCorrectionCategory[] = ["wrong_direction", "bad_location", "wrong_regime", "bad_levels", "missed_trade", "other"];
export type TraderCorrection = { category: TraderCorrectionCategory | string; text: string; updatedAt: number };

/** 保存对一条决策的纠正；同一形态攒够数量时返回新生成的手册建议 id。 */
export async function saveTraderCorrection(decisionId: string, category: TraderCorrectionCategory, text: string): Promise<{ suggestionId: string | null } | null> {
  return invokeDesktop<{ suggestionId: string | null }>("ai_trader_correction_save", { decisionId, category, text });
}

export async function deleteTraderCorrection(decisionId: string): Promise<void> {
  await invokeDesktop<null>("ai_trader_correction_delete", { decisionId });
}

/** AI 起草的新形态（一律「观察中」）：`notes` 是需要你确认或补充的地方，`warnings` 是解析时做过的修正。 */
export type TraderSetupDraft = { setup: TraderHandbookSetup; notes: string[]; warnings: string[] };

export async function draftTraderSetup(request: { description: string; handbookId: string | null; name?: string | null; model?: string | null; requestId: string }): Promise<TraderSetupDraft | null> {
  return invokeDesktop<TraderSetupDraft>("ai_trader_setup_draft", {
    description: request.description,
    handbookId: request.handbookId,
    name: request.name ?? null,
    model: request.model ?? null,
    requestId: request.requestId
  });
}

/** 取消正在起草的形态或手册建议（与 Agent 草稿共用取消命令）。 */
export async function cancelTraderDraft(requestId: string): Promise<void> {
  await invokeDesktop<null>("ai_agent_generate_cancel", { requestId }, { quiet: true });
}

/** 让 AI 按纠正起草手册修改建议（结果写回建议，返回更新后的建议）。 */
export async function draftHandbookSuggestion(id: string, requestId: string, model?: string | null): Promise<AiOptimizationSuggestion | null> {
  return invokeDesktop<AiOptimizationSuggestion>("ai_handbook_suggestion_draft", { id, model: model ?? null, requestId });
}
/** 形态状态：实盘可以开仓；观察中只评估、影子结算，代码拒绝它开仓。 */
export type TraderSetupStatus = "live" | "observing";
export type TraderHandbookSetup = {
  id: string;
  name: string;
  regimes: string[];
  direction: string;
  entry: string;
  stop: string;
  target: string;
  invalidation: string;
  minNetRr?: number;
  stopAtrMin?: number;
  stopAtrMax?: number;
  sizeNote?: string;
  status: TraderSetupStatus | string;
};
export type TraderHandbookRule = { id: string; text: string };
export type TraderHandbookPause = { setupId: string; regime?: string; side?: string; reason: string; pausedAt: number };
export type TraderHandbook = {
  directionPolicy: string;
  setups: TraderHandbookSetup[];
  noTradeRules: TraderHandbookRule[];
  managementRules: TraderHandbookRule[];
  paused: TraderHandbookPause[];
};
/** 某本手册的当前内容（最新已发布版次）。默认手册没改过名时 `name` 为空，界面显示「我的手册」。 */
export type TraderHandbookSnapshot = {
  id: string;
  name: string | null;
  version: number;
  revision: number;
  content: TraderHandbook;
  fallback: string | null;
};
export type TraderHandbookUser = { id: string; name: string };
export type TraderHandbookDetail = TraderHandbookSnapshot & { origin: string; archivedAt: number | null; usedBy: TraderHandbookUser[] };
export type TraderHandbookLibraryEntry = {
  id: string;
  name: string | null;
  origin: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  version: number | null;
  revision: number | null;
  setupCount: number;
  observingCount: number;
  pausedCount: number;
  usedBy: TraderHandbookUser[];
  score90d: { resolved: number; avgR: number | null; shrunkAvgR: number | null; totalR: number };
};
export type TraderHandbookRevision = {
  version: number;
  revision: number;
  source: string | null;
  note: string | null;
  createdAt: number;
  suggestionId: string | null;
  content: TraderHandbook | null;
};
export type TraderHandbookPublished = { handbookId: string; version: number; revision: number; content: TraderHandbook };
export const DEFAULT_TRADER_HANDBOOK_ID = "default";
export type TraderScorecardData = {
  profileId: string | null;
  fromMs: number;
  scorecard: {
    decisions: number;
    resolved: number;
    executed: number;
    groups: TraderScorecardGroup[];
    calibration: Array<{ lo: number; hi: number; n: number; predicted: number; realized: number }>;
    waits: { n: number; missedR: number; avoidedR: number };
    compliance: { againstN: number; againstAvgR: number | null; alignedN: number; alignedAvgR: number | null; regimeMismatchN: number };
    versions: Array<{ version: number; n: number; avgR: number }>;
  };
  pending: number;
  recent: TraderDecisionRow[];
  /** 要显示的手册：筛选了手册就是那本，否则是这个 Profile 用的那本，再否则是默认手册。 */
  handbook: TraderHandbookSnapshot;
  handbookId?: string | null;
};

export async function loadTraderScorecard(profileId: string | null, fromMs: number, handbookId?: string | null): Promise<TraderScorecardData | null> {
  return invokeDesktop<TraderScorecardData>("ai_trader_scorecard", { profileId, handbookId: handbookId || null, fromMs: Math.floor(fromMs) }, { quiet: true });
}

export async function listTraderHandbooks(includeArchived = false): Promise<TraderHandbookLibraryEntry[] | null> {
  return invokeDesktop<TraderHandbookLibraryEntry[]>("ai_trader_handbooks", { includeArchived }, { quiet: true });
}

export async function loadTraderHandbook(handbookId: string | null): Promise<TraderHandbookDetail | null> {
  return invokeDesktop<TraderHandbookDetail>("ai_trader_handbook_detail", { handbookId: handbookId || null }, { quiet: true });
}

export async function loadTraderHandbookRevisions(handbookId: string): Promise<TraderHandbookRevision[] | null> {
  return invokeDesktop<TraderHandbookRevision[]>("ai_trader_handbook_revisions", { handbookId }, { quiet: true });
}

/** 新建手册：`sourceHandbookId` 为空表示从内置模板新建，否则复制那一本。 */
export async function createTraderHandbook(name: string, sourceHandbookId: string | null): Promise<TraderHandbookDetail | null> {
  return invokeDesktop<TraderHandbookDetail>("ai_trader_handbook_create", { name, sourceHandbookId });
}

export async function renameTraderHandbook(handbookId: string, name: string): Promise<TraderHandbookDetail | null> {
  return invokeDesktop<TraderHandbookDetail>("ai_trader_handbook_rename", { handbookId, name });
}

export async function archiveTraderHandbook(handbookId: string, archived: boolean): Promise<TraderHandbookDetail | null> {
  return invokeDesktop<TraderHandbookDetail>("ai_trader_handbook_archive", { handbookId, archived });
}

/** 整本发布成新版次；`baseRevision` 是编辑器打开时的版次，对不上（别处改过）会被拒绝。 */
export async function publishTraderHandbook(handbookId: string, content: TraderHandbook, baseRevision: number, note?: string | null): Promise<TraderHandbookPublished | null> {
  return invokeDesktop<TraderHandbookPublished>("ai_trader_handbook_publish", { handbookId, content, baseRevision, note: note ?? null });
}

/** 回退到某一版次；`toRevision` 为空表示恢复成内置模板。 */
export async function rollbackTraderHandbook(handbookId: string, toRevision: number | null, baseRevision: number): Promise<TraderHandbookPublished | null> {
  return invokeDesktop<TraderHandbookPublished>("ai_trader_handbook_rollback", { handbookId, toRevision, baseRevision });
}

/** 导出这本手册（保存对话框）；返回保存路径，取消时为空。 */
export async function exportTraderHandbook(handbookId: string): Promise<string | null> {
  return invokeDesktop<string | null>("ai_trader_handbook_export", { handbookId });
}

/** 从文件导入一本手册（打开对话框，读取与校验都在后端）；所有形态设为观察中。取消时为空。 */
export async function importTraderHandbook(): Promise<(TraderHandbookDetail & { importWarnings?: string[] }) | null> {
  return invokeDesktop<TraderHandbookDetail & { importWarnings?: string[] }>("ai_trader_handbook_import");
}

export async function setTraderSetupStatus(handbookId: string, setupId: string, status: TraderSetupStatus): Promise<TraderHandbookPublished | null> {
  return invokeDesktop<TraderHandbookPublished>("ai_trader_set_setup_status", { handbookId, setupId, status });
}

export async function loadTraderRunDecisions(runId: string): Promise<TraderDecisionRow[] | null> {
  return invokeDesktop<TraderDecisionRow[]>("ai_trader_run_decisions", { runId }, { quiet: true });
}

/** 交易员 Profile 挂着的一笔开仓限价单（停用前给用户确认要不要一起撤）。 */
export type TraderEntryOrder = {
  opportunityId: string;
  profileId: string;
  instId: string;
  ordId: string;
  side: string;
  px: number | null;
  sz: number | null;
  placedAt: number | null;
  validUntil: number | null;
};

export type TraderEntryOrderCancelResult = { ordId: string; instId: string; ok: boolean; error: string | null };

export async function loadTraderEntryOrders(profileId: string): Promise<TraderEntryOrder[] | null> {
  return invokeDesktop<TraderEntryOrder[]>("ai_trader_entry_orders", { profileId }, { quiet: true });
}

export async function cancelTraderEntryOrders(profileId: string, ordIds: string[]): Promise<TraderEntryOrderCancelResult[] | null> {
  return invokeDesktop<TraderEntryOrderCancelResult[]>("ai_trader_cancel_entry_orders", { profileId, ordIds });
}

/** 用户的临时指令（`ai_trader_instructions`）。`no_entry` / `long_only` / `short_only` 由代码强制，`note` 只给 AI 参考。 */
export type TraderInstructionKind = "no_entry" | "long_only" | "short_only" | "note";
export type TraderInstructionRow = {
  id: string;
  profileId: string | null;
  instId: string | null;
  kind: TraderInstructionKind | string;
  text: string;
  createdAt: number;
  expiresAt: number;
  cancelledAt: number | null;
  profileName: string | null;
  status: "active" | "expired" | "cancelled" | string;
};
export type TraderInstructionInput = {
  profileId: string | null;
  instId: string | null;
  kind: TraderInstructionKind;
  text: string;
  expiresAt: number;
  cancelOrdIds: string[];
};
export type TraderInstructionCreated = {
  instruction: { id: string };
  voidedOpportunities: number;
  cancelledOrders: TraderEntryOrderCancelResult[];
};

export async function listTraderInstructions(includeHistory = false): Promise<TraderInstructionRow[] | null> {
  return invokeDesktop<TraderInstructionRow[]>("ai_trader_instructions", { includeHistory }, { quiet: true });
}

export async function loadTraderInstructionScopeOrders(profileId: string | null, instId: string | null, kind: TraderInstructionKind): Promise<TraderEntryOrder[] | null> {
  return invokeDesktop<TraderEntryOrder[]>("ai_trader_instruction_scope_orders", { profileId, instId, kind }, { quiet: true });
}

export async function createTraderInstruction(request: TraderInstructionInput): Promise<TraderInstructionCreated | null> {
  return invokeDesktop<TraderInstructionCreated>("ai_trader_instruction_create", { request });
}

export async function cancelTraderInstruction(id: string): Promise<void> {
  await invokeDesktop<null>("ai_trader_instruction_cancel", { id });
}

export async function setTraderSetupPause(request: { handbookId?: string | null; setupId: string; regime?: string | null; side?: string | null; paused: boolean; reason?: string | null }): Promise<TraderHandbookPublished | null> {
  return invokeDesktop<TraderHandbookPublished>("ai_trader_set_setup_pause", { handbookId: request.handbookId ?? null, ...request });
}

export async function saveAiConfig(update: AiConfigUpdate): Promise<AiConfigSummary | null> {
  const summary = await invokeOptional<AiConfigSummary>("ai_save_config", { update });
  if (summary) {
    window.dispatchEvent(new CustomEvent<AiConfigSummary>("desic:ai-config-updated", { detail: summary }));
  }
  return summary;
}

export async function loadAiLocalAuthStatus(): Promise<AiLocalAuthStatus | null> {
  return invokeOptional<AiLocalAuthStatus>("ai_local_auth_status");
}

export async function listenAiSessionTitleUpdates(handler: (update: { sessionId: string; title: string }) => void): Promise<() => void> {
  return (await listenOptional<{ sessionId: string; title: string }>("ai:session-title-updated", handler)) ?? (() => {});
}

export async function listenAiConfigUpdates(handler: (summary: AiConfigSummary) => void): Promise<() => void> {
  const handleLocalUpdate = (event: Event) => {
    const summary = (event as CustomEvent<AiConfigSummary>).detail;
    if (summary) handler(summary);
  };
  window.addEventListener("desic:ai-config-updated", handleLocalUpdate);
  const unlistenTauri = await listenOptional<AiConfigSummary>("ai:config-updated", handler);
  return () => {
    window.removeEventListener("desic:ai-config-updated", handleLocalUpdate);
    unlistenTauri?.();
  };
}

export async function testAiConnection(model: AiModelConfigUpdate): Promise<AiConnectionTestResult | null> {
  return invokeDesktop<AiConnectionTestResult>("ai_test_connection", { model });
}

export async function listAiModels(model: AiModelConfigUpdate): Promise<string[] | null> {
  return invokeDesktop<string[]>("ai_list_models", { model });
}

export async function createAiSession(title?: string): Promise<AiSessionSnapshot | null> {
  return invokeOptional<AiSessionSnapshot>("ai_create_session", { request: { title } });
}

export async function loadAiSession(sessionId: string): Promise<AiSessionSnapshot | null> {
  return invokeDesktop<AiSessionSnapshot>("ai_load_session", { request: { sessionId } });
}

export async function listAiSessions(): Promise<AiSession[] | null> {
  return invokeOptional<AiSession[]>("ai_list_sessions");
}

export async function renameAiSession(sessionId: string, title: string): Promise<AiSession | null> {
  return invokeDesktop<AiSession>("ai_rename_session", { request: { sessionId, title } });
}

export async function deleteAiSession(sessionId: string): Promise<void> {
  await invokeDesktop("ai_delete_session", { request: { sessionId } });
}

export async function sendAiMessage(
  sessionId: string,
  messages: AiChatMessage[],
  accountId?: string,
  options?: { modelId?: string; permissionMode?: AiPermissionMode; reasoningDepth?: AiReasoningDepth; delivery?: AiPromptDelivery; extraRules?: string; uiControl?: boolean }
) {
  return invokeDesktop("ai_send_message", {
    request: { sessionId, messages, accountId, ...options }
  });
}

export async function refreshAiPendingPrompts(sessionId: string): Promise<AiPendingPrompt[]> {
  return (await invokeDesktop<AiPendingPrompt[]>("ai_pending_prompts", { request: { sessionId } })) ?? [];
}

export async function updateAiPendingPrompt(sessionId: string, promptId: string, prompt: string, delivery: AiPromptDelivery) {
  return invokeDesktop("ai_update_pending_prompt", { request: { sessionId, promptId, prompt, delivery } });
}

export async function deleteAiPendingPrompt(sessionId: string, promptId: string) {
  return invokeDesktop("ai_delete_pending_prompt", { request: { sessionId, promptId } });
}

export async function forkAiSession(sessionId: string, messageId: string): Promise<AiSessionSnapshot | null> {
  return invokeDesktop<AiSessionSnapshot>("ai_fork_session", { request: { sessionId, messageId } });
}

export async function generateChartIndicatorWithAi(sessionId: string, prompt: string, messages: AiChatMessage[] = []) {
  return invokeDesktop("ai_generate_chart_indicator", {
    request: { sessionId, prompt, messages }
  });
}

export async function stopAiMessage(sessionId: string) {
  return invokeDesktop("ai_stop", { sessionId });
}

export async function approveAiTool(sessionId: string, approvalId: string, approved: boolean, reason?: string) {
  return invokeDesktop("ai_approve_tool", {
    decision: { sessionId, approvalId, approved, reason }
  });
}

export async function listenAiEvents(handler: (event: AiEvent) => void): Promise<(() => void) | null> {
  return listenOptional<AiEvent>("ai:event", handler);
}
