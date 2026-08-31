import type { AiConfigSummary, AiEvent, AiPendingPrompt, AiPromptDelivery, AiSession, AiSessionSnapshot } from "../../types";
import { safeJson, storedMessageToUiMessage, type AiUiMessage } from "../AiMessageProcess";
import { logger } from "../../lib/logger";
import { formatDateTime, type UiTranslation } from "../App";

// Helpers, constants, and types exclusive to the AI research workspace,
// extracted verbatim from App.tsx.

export function formatAiSessionMeta(session: AiSession, t?: UiTranslation) {
  const status = statusLabel(session.status, t);
  const updated = formatDateTime(session.updatedAt);
  return `${status} · ${updated}`;
}

export function sortAiSessions(items: AiSession[], pinnedIds: ReadonlySet<string> = new Set()) {
  return [...items].sort((a, b) => {
    const pinnedDelta = Number(pinnedIds.has(b.id)) - Number(pinnedIds.has(a.id));
    if (pinnedDelta !== 0) return pinnedDelta;
    const updatedDelta = (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt);
    return updatedDelta || a.id.localeCompare(b.id);
  });
}

export function isAiSessionRunning(status: string) {
  return ["connecting", "running", "streaming", "tooling", "retrying"].includes(status.trim().toLowerCase());
}

export function statusLabel(status: string, t?: UiTranslation) {
  if (status === "connecting") return t ? t("automation:connecting") : "连接中";
  if (status === "running" || status === "streaming") return t ? t("automation:generating") : "生成中";
  if (status === "tooling") return t ? t("automation:usingTools") : "工具中";
  if (status === "retrying") return "重试连接中";
  if (status === "failed") return t ? t("common:failed") : "失败";
  if (status === "stopped") return t ? t("automation:stopped") : "已停止";
  return t ? t("automation:idle") : "空闲";
}

export function aiRuntimeStatusFromSession(status: string) {
  const normalized = status.trim().toLowerCase();
  if (normalized === "failed" || normalized === "error") return "failed";
  if (["connecting", "running", "streaming", "tooling", "retrying"].includes(normalized)) return normalized;
  return "idle";
}

export const AI_SESSION_DRAFTS_KEY = "desic-terminal.ai-session-drafts.v1";
export const AI_PINNED_SESSIONS_KEY = "desic-terminal.ai-research.pinned-sessions.v1";

export type AiSessionViewCache = { messages: AiUiMessage[]; status: string; contextUsage?: AiUiMessage["contextUsage"] };

export function createAiMessageNonce() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function cacheAiSessionView(cache: Map<string, AiSessionViewCache>, sessionId: string, view: AiSessionViewCache) {
  cache.delete(sessionId);
  cache.set(sessionId, view);
  while (cache.size > 12) {
    const oldestSessionId = cache.keys().next().value;
    if (typeof oldestSessionId !== "string") break;
    cache.delete(oldestSessionId);
  }
}

export type AiResearchColumnWidths = { sessions: number; inspector: number };

export function readAiResearchColumnWidths(): AiResearchColumnWidths {
  try {
    const parsed = JSON.parse(window.localStorage.getItem("desic.ai-research.columns") || "{}") as Partial<AiResearchColumnWidths>;
    return {
      sessions: Number.isFinite(parsed.sessions) ? Math.max(210, Math.min(420, Number(parsed.sessions))) : 252,
      inspector: Number.isFinite(parsed.inspector) ? Math.max(300, Math.min(720, Number(parsed.inspector))) : 380
    };
  } catch {
    return { sessions: 252, inspector: 380 };
  }
}

export type AiResearchTask = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
};

export function normalizeAiResearchTask(item: unknown, index: number): AiResearchTask | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const content = String(record.content ?? record.title ?? record.task ?? "").trim();
  if (!content) return null;
  const rawStatus = String(record.status ?? "pending").trim().toLowerCase();
  const status: AiResearchTask["status"] = rawStatus === "completed" || rawStatus === "done" || rawStatus === "success"
    ? "completed"
    : rawStatus === "in_progress" || rawStatus === "running" || rawStatus === "active"
      ? "in_progress"
      : rawStatus === "blocked" || rawStatus === "failed"
        ? "blocked"
        : "pending";
  return { id: String(record.id ?? `task-${index}`), content, status };
}

export function tasksFromUnknown(value: unknown): AiResearchTask[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const source = Array.isArray(record.todos) ? record.todos : Array.isArray(record.tasks) ? record.tasks : [];
  return source.map(normalizeAiResearchTask).filter((item): item is AiResearchTask => Boolean(item));
}

export function extractAiTasks(messages: AiUiMessage[]): AiResearchTask[] {
  let latest: AiResearchTask[] = [];
  for (const message of messages) {
    for (const tool of message.tools ?? []) {
      const fromArguments = tasksFromUnknown(tool.arguments);
      const fromResult = tasksFromUnknown(tool.result);
      if (fromArguments.length > 0) latest = fromArguments;
      if (fromResult.length > 0) latest = fromResult;
    }
    for (const agent of message.agents ?? []) {
      for (const tool of agent.tools ?? []) {
        const fromArguments = tasksFromUnknown(tool.arguments);
        const fromResult = tasksFromUnknown(tool.result);
        if (fromArguments.length > 0) latest = fromArguments;
        if (fromResult.length > 0) latest = fromResult;
      }
    }
  }
  return latest;
}

export function formatAiTaskSummary(tasks: AiResearchTask[], activeLabel: string) {
  const completed = tasks.filter((task) => task.status === "completed").length;
  const running = tasks.filter((task) => task.status === "in_progress").length;
  return `${completed}/${tasks.length}${running ? ` · ${running} ${activeLabel}` : ""}`;
}

export function reconcilePendingPromptSnapshot(
  current: AiPendingPrompt[],
  snapshot: AiPendingPrompt[],
  sessionId: string
) {
  const ownedSnapshot = snapshot.filter((prompt) => prompt.sessionId === sessionId);
  const unresolvedOptimistic = current.filter((prompt) =>
    prompt.sessionId === sessionId
    && prompt.id.startsWith("local-")
    && !ownedSnapshot.some((nativePrompt) =>
      (prompt.localMessageId && nativePrompt.localMessageId === prompt.localMessageId)
      || (nativePrompt.prompt === prompt.prompt && nativePrompt.delivery === prompt.delivery)
    )
  );
  return [...ownedSnapshot, ...unresolvedOptimistic];
}

export function reconcileSubmittedPendingPrompt(items: AiPendingPrompt[], submitted: AiPendingPrompt) {
  const byId = items.findIndex((item) => item.sessionId === submitted.sessionId && item.id === submitted.id);
  if (byId >= 0) return items.map((item, index) => index === byId ? submitted : item);
  const byLocalMessage = submitted.localMessageId
    ? items.findIndex((item) => item.sessionId === submitted.sessionId && item.localMessageId === submitted.localMessageId)
    : -1;
  if (byLocalMessage >= 0) return items.map((item, index) => index === byLocalMessage ? submitted : item);
  const optimistic = items.findIndex((item) =>
    item.sessionId === submitted.sessionId
    && item.id.startsWith("local-")
    && item.prompt === submitted.prompt
    && item.delivery === submitted.delivery
  );
  if (optimistic < 0) return [...items, submitted];
  return items.map((item, index) => index === optimistic ? submitted : item);
}

export function removeOnePendingPrompt(
  items: AiPendingPrompt[],
  prompt: string,
  delivery?: AiPromptDelivery,
  promptId?: string,
  localMessageId?: string
) {
  let index = localMessageId ? items.findIndex((item) => item.localMessageId === localMessageId) : -1;
  if (index < 0) index = promptId ? items.findIndex((item) => item.id === promptId) : -1;
  if (index < 0) {
    index = items.findIndex((item) =>
      item.prompt === prompt && (!delivery || item.delivery === delivery)
    );
  }
  if (index < 0) index = items.findIndex((item) => item.prompt === prompt);
  return index < 0 ? items : items.filter((_, itemIndex) => itemIndex !== index);
}

export function canRetryAiMessage(message: AiUiMessage) {
  if (message.role !== "assistant" || message.id === "welcome") return false;
  const status = `${message.status ?? ""} ${message.finishReason ?? ""} ${message.error ?? ""}`.toLowerCase();
  return Boolean(message.error) || /(failed|error|cancelled|stopped|失败|错误|中断|已停止)/.test(status);
}

export function previousAiUserPrompt(messages: AiUiMessage[], messageIndex: number) {
  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user" && messages[index].text.trim()) return messages[index].text;
  }
  return null;
}

export function formatAiMessageTimestamp(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

export function aiEventProducesUnread(event: AiEvent) {
  return [
    "delta",
    "reasoningSnapshot",
    "toolCall",
    "toolResult",
    "approvalRequest",
    "approvalResolved",
    "turnStarted",
    "agentStart",
    "agentDone",
    "teamEvent",
    "done",
    "error"
  ].includes(event.type);
}

export const DEFAULT_AI_CONTEXT_WINDOW = 256_000;

export function defaultAiContextUsage(usedTokens = 0): NonNullable<AiUiMessage["contextUsage"]> {
  return {
    usedTokens,
    contextWindow: DEFAULT_AI_CONTEXT_WINDOW,
    measuredAt: Date.now(),
    usedSource: "clineMessages",
    contextWindowSource: "fallback"
  };
}

export function contextUsageForModel(model: AiConfigSummary["models"][number] | null | undefined, usedTokens = 0) {
  const configured = Number.isFinite(model?.contextWindow) && Number(model?.contextWindow) > 0 ? Number(model?.contextWindow) : DEFAULT_AI_CONTEXT_WINDOW;
  return {
    ...defaultAiContextUsage(usedTokens),
    contextWindow: configured,
    contextWindowSource: configured === DEFAULT_AI_CONTEXT_WINDOW && !model?.contextWindow ? "fallback" as const : "customModelConfig" as const
  };
}

export function withAiContextFallback(usage?: AiUiMessage["contextUsage"]): AiUiMessage["contextUsage"] | undefined {
  if (!usage || !Number.isFinite(usage.usedTokens) || usage.usedTokens < 0) return undefined;
  const contextWindow = Number.isFinite(usage.contextWindow) && usage.contextWindow && usage.contextWindow > 0
    ? usage.contextWindow
    : DEFAULT_AI_CONTEXT_WINDOW;
  return {
    ...usage,
    contextWindow,
    contextWindowSource: usage.contextWindowSource ?? "fallback"
  };
}

export function latestAiContextUsage(messages: AiUiMessage[]) {
  return withAiContextFallback([...messages].reverse().find((message) => isValidAiContextUsage(message.contextUsage))?.contextUsage);
}

export function isValidAiContextUsage(usage?: AiUiMessage["contextUsage"]) {
  return Boolean(usage
    && Number.isFinite(usage.usedTokens)
    && usage.usedTokens >= 0
    && (usage.contextWindow === undefined || Number.isFinite(usage.contextWindow) && usage.contextWindow > 0));
}

export function aiContextUsagePercent(usage?: AiUiMessage["contextUsage"]) {
  if (!usage?.contextWindow) return 0;
  return Math.min(100, Math.max(0, (usage.usedTokens / usage.contextWindow) * 100));
}

export function formatAiContextUsage(usage?: AiUiMessage["contextUsage"]) {
  if (!usage) return "--";
  return `${formatCompactTokenCount(usage.usedTokens)} / ${usage.contextWindow ? formatCompactTokenCount(usage.contextWindow) : "--"}`;
}

export function formatCompactTokenCount(value: number) {
  if (!Number.isFinite(value)) return "--";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return Math.max(0, Math.round(value)).toString();
}

export function readPinnedAiSessionIds() {
  if (typeof window === "undefined") return new Set<string>();
  try {
    const value = JSON.parse(window.localStorage.getItem(AI_PINNED_SESSIONS_KEY) || "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 100) : []);
  } catch {
    return new Set<string>();
  }
}

export function persistPinnedAiSessionIds(ids: ReadonlySet<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AI_PINNED_SESSIONS_KEY, JSON.stringify(Array.from(ids).slice(0, 100)));
  } catch {
    // Local UI preference should never block a session action.
  }
}

export function loadAiSessionDraft(sessionId: string) {
  if (typeof window === "undefined" || !sessionId) return "";
  try {
    const stored = JSON.parse(window.localStorage.getItem(AI_SESSION_DRAFTS_KEY) || "{}") as Record<string, unknown>;
    return typeof stored[sessionId] === "string" ? stored[sessionId] : "";
  } catch {
    return "";
  }
}

export function persistAiSessionDraft(sessionId: string, draft: string) {
  if (typeof window === "undefined" || !sessionId) return;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(AI_SESSION_DRAFTS_KEY) || "{}") as Record<string, unknown>;
    const entries = Object.entries(parsed)
      .filter(([key, value]) => key !== sessionId && typeof value === "string")
      .slice(-29);
    const next = Object.fromEntries(entries);
    if (draft) next[sessionId] = draft;
    else delete next[sessionId];
    window.localStorage.setItem(AI_SESSION_DRAFTS_KEY, JSON.stringify(next));
  } catch (error) {
    logger.warn("failed to persist AI session draft", { error: error instanceof Error ? error.message : String(error) });
  }
}

export function isVisibleAiStoredMessage(message: AiSessionSnapshot["messages"][number]) {
  return !["queued", "steering", "superseded"].includes(message.status?.trim().toLowerCase() ?? "");
}

// 新会话兜底欢迎语；工作区用它识别"仅含欢迎语"的空会话，以展示任务甲板与快捷建议
export const AI_WELCOME_GREETING_TEXT = "我是交易终端 AI 助手，可以协助分析行情、解释仓位和整理交易复盘。";

export function isWelcomeGreetingOnlyMessages(messages: AiUiMessage[]) {
  return messages.length === 1
    && messages[0].role === "assistant"
    && messages[0].text === AI_WELCOME_GREETING_TEXT;
}

export function snapshotToUiMessages(snapshot: AiSessionSnapshot) {
  const mapped = snapshot.messages
    .filter(isVisibleAiStoredMessage)
    .map(storedMessageToUiMessage);
  const deduplicated = mapped.filter((message, index) => {
    const previous = mapped[index - 1];
    return !(
      message.role === "assistant"
      && message.error
      && previous?.role === "assistant"
      && previous.error
      && message.text === previous.text
      && message.errorMessage === previous.errorMessage
    );
  });
  if (deduplicated.length > 0) return deduplicated;
  return [
    {
      id: "welcome",
      role: "assistant" as const,
      text: AI_WELCOME_GREETING_TEXT,
      tools: [],
      approvals: []
    }
  ];
}

export function summarizeAiResearchMemory(messages: AiUiMessage[], extra: Record<string, unknown>) {
  let tools = 0;
  let agentTools = 0;
  let agents = 0;
  let timeline = 0;
  let approvals = 0;
  let teamEvents = 0;
  let textChars = 0;
  let reasoningChars = 0;
  let draftChars = 0;
  let toolResultChars = 0;
  for (const message of messages) {
    tools += message.tools?.length ?? 0;
    agents += message.agents?.length ?? 0;
    timeline += message.timeline?.length ?? 0;
    approvals += message.approvals?.length ?? 0;
    teamEvents += message.teamEvents?.length ?? 0;
    textChars += message.text?.length ?? 0;
    reasoningChars += message.reasoning?.length ?? 0;
    draftChars += message.draftText?.length ?? 0;
    for (const tool of message.tools ?? []) {
      toolResultChars += safeJson(tool.result)?.length ?? 0;
    }
    for (const agent of message.agents ?? []) {
      agentTools += agent.tools?.length ?? 0;
      toolResultChars += safeJson(agent.result)?.length ?? 0;
      for (const tool of agent.tools ?? []) {
        toolResultChars += safeJson(tool.result)?.length ?? 0;
      }
    }
  }
  return {
    ...extra,
    messages: messages.length,
    tools,
    agentTools,
    agents,
    timeline,
    approvals,
    teamEvents,
    textChars,
    reasoningChars,
    draftChars,
    toolResultChars
  };
}
