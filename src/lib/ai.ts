import type { AiChatMessage, AiConfigSummary, AiConfigUpdate, AiConnectionTestResult, AiEvent, AiLocalAuthStatus, AiModelConfigUpdate, AiPendingPrompt, AiPermissionMode, AiPromptDelivery, AiReasoningDepth, AiSession, AiSessionSnapshot, AiTokenUsageDashboard } from "../types";
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
  options?: { modelId?: string; permissionMode?: AiPermissionMode; reasoningDepth?: AiReasoningDepth; delivery?: AiPromptDelivery }
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
