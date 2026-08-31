import "./ai-research.css";
import "./ai-research-messages.css";
import "./ai-research-inspector.css";
import "./ai-research-process.css";
import "./ai-research-welcome.css";
import { useCallback, useEffect, memo, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import {
  ArrowDown,
  Bot,
  CheckCircle2,
  Copy,
  CornerDownRight,
  Edit3,
  Focus,
  GitBranch,
  GripVertical,
  ListTodo,
  Newspaper,
  Pin,
  PinOff,
  Plus,
  Radar,
  RefreshCw,
  RotateCcw,
  Send,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  X
} from "lucide-react";
import type { AiChatMessage, AiConfigSummary, AiPendingPrompt, AiPermissionMode, AiPromptDelivery, AiReasoningDepth, AiSession, MarketAssetsSummary, Ticker } from "../../types";
import {
  approveAiTool,
  createAiSession,
  deleteAiPendingPrompt,
  deleteAiSession,
  forkAiSession,
  listenAiConfigUpdates,
  listenAiSessionTitleUpdates,
  listenAiEvents,
  listAiSessions,
  loadAiConfigSummary,
  loadAiSession,
  refreshAiPendingPrompts,
  renameAiSession,
  sendAiMessage,
  stopAiMessage,
  updateAiPendingPrompt
} from "../../lib/ai";
import { logger } from "../../lib/logger";
import { createDeferredCleanupSlot } from "../../lib/deferredCleanup";
import { isTauriRuntime } from "../../lib/tauri";
import {
  AiEvidenceReferences,
  AiInlineEvidenceCards,
  AiMessageError,
  AiTokenUsageLine,
  MarkdownMessage,
  applyAiEvent,
  localizeAiMessageStatus,
  updateLastAssistant,
  type AiResearchArtifact,
  type AiUiMessage
} from "../AiMessageProcess";
import { AiCommandPalette } from "../AiCommandPalette";
import { AiContextMeter } from "../AiContextMeter";
import { AiResearchWelcome } from "../AiResearchWelcome";
import { AiResearchInspector } from "../AiResearchInspector";
import { AI_RESEARCH_COMMANDS, expandAiSlashInput, filterAiSlashEntries, type AiSlashEntry } from "../aiResearchCommands";
import { TerminalSelect } from "../TerminalSelect";
import { useConfirmPrompt } from "../ConfirmPrompt";
import { formatDuration } from "../App";
import { AI_SKILL_OPTIONS, AiMessagePlainText, ConfirmDialog, normalizeAiPermissionMode, normalizeAiSkillDefinitions, useRendererMemoryMonitor } from "../App";
import {
  aiContextUsagePercent,
  aiEventProducesUnread,
  aiRuntimeStatusFromSession,
  cacheAiSessionView,
  canRetryAiMessage,
  contextUsageForModel,
  createAiMessageNonce,
  defaultAiContextUsage,
  extractAiTasks,
  formatAiContextUsage,
  formatAiMessageTimestamp,
  formatAiSessionMeta,
  formatAiTaskSummary,
  isAiSessionRunning,
  isVisibleAiStoredMessage,
  isValidAiContextUsage,
  latestAiContextUsage,
  isWelcomeGreetingOnlyMessages,
  loadAiSessionDraft,
  persistAiSessionDraft,
  persistPinnedAiSessionIds,
  readAiResearchColumnWidths,
  readPinnedAiSessionIds,
  reconcilePendingPromptSnapshot,
  reconcileSubmittedPendingPrompt,
  removeOnePendingPrompt,
  snapshotToUiMessages,
  previousAiUserPrompt,
  sortAiSessions,
  statusLabel,
  summarizeAiResearchMemory,
  withAiContextFallback,
  type AiSessionViewCache
} from "./shared";
import { previewAiMessages, previewAiSessions } from "./fixtures";
import { AiResearchMessageDuration, AiResearchMessageTimeline, AiThroughputMetric } from "./AiResearchMessageLeaves";

export function AiResearchWorkspace({ active = true, preview, onOpenSettings, onOpenStrategy, onOpenIntelligence, onOpenTrading, onRuntimeStateChange, accountId, accountLabel, accountEnvironment, selectedSymbol, marketAssets, marketTickers, cacheDir }: { active?: boolean; preview?: boolean; onOpenSettings?: () => void; onOpenStrategy?: (strategyId: string, runId?: string, optimizationId?: string) => void; onOpenIntelligence?: () => void; onOpenTrading?: () => void; onRuntimeStateChange?: (state: { status: string; unread: boolean }) => void; accountId?: string; accountLabel?: string; accountEnvironment?: string; selectedSymbol?: string; marketAssets?: MarketAssetsSummary | null; marketTickers?: Ticker[]; cacheDir?: string } = {}) {
  const { t, i18n } = useTranslation(["automation", "common", "settings"]);
  const forkPrompt = useConfirmPrompt();
  const uiText = useCallback((zh: string, en: string) => i18n.resolvedLanguage?.toLowerCase().startsWith("zh") ? zh : en, [i18n.resolvedLanguage]);
  const [sessionId, setSessionId] = useState(preview ? "session-preview-user" : "default-ai-session");
  const [sessionTitle, setSessionTitle] = useState(() => preview ? t("automation:previewSessionTitle") : t("automation:defaultSession"));
  const [config, setConfig] = useState<AiConfigSummary | null>(
    preview
      ? {
          provider: "cline-sdk",
          model: "deepseek-v4-flash",
          baseUrl: "https://api.deepseek.com/v1",
          apiKeyMasked: "demo-key-configured",
          configured: true,
          stream: true,
          permissionMode: "copilot",
          reasoningDepth: "medium",
          activeModelId: "preview-model",
          models: [{
            id: "preview-model",
            name: "DeepSeek 预览",
            provider: "cline-sdk",
            model: "deepseek-v4-flash",
            baseUrl: "https://api.deepseek.com/v1",
            apiKeyMasked: "demo-key-configured",
            configured: true,
            permissionMode: "copilot",
            reasoningDepth: "medium"
          }],
          systemPrompt: "",
          customRules: "",
          enabledSkills: ["trading-philosophy", "okx-market-intelligence"],
          skillDefinitions: AI_SKILL_OPTIONS,
          skillRuntimeTrust: {},
          openAgent: true,
          workspaceRoots: []
        }
      : null
  );
  const [status, setStatus] = useState(preview ? "streaming" : "idle");
  const [statusDetail, setStatusDetail] = useState("");
  const [chatModelId, setChatModelId] = useState(preview ? "preview-model" : "");
  const [chatPermissionMode, setChatPermissionMode] = useState<AiPermissionMode>(preview ? "copilot" : "advisor");
  const [chatReasoningDepth, setChatReasoningDepth] = useState<AiReasoningDepth>("medium");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<AiUiMessage[]>(() => preview ? previewAiMessages : []);
  const [contextUsage, setContextUsage] = useState<AiUiMessage["contextUsage"]>(() => latestAiContextUsage(preview ? previewAiMessages : []) ?? defaultAiContextUsage());
  const [creatingSession, setCreatingSession] = useState(false);
  const [sessions, setSessions] = useState<AiSession[]>(preview ? previewAiSessions : []);
  const [pinnedSessionIds, setPinnedSessionIds] = useState<Set<string>>(() => readPinnedAiSessionIds());
  useEffect(() => { setPinnedSessionIds((current) => new Set(Array.from(current).filter((id) => sessions.some((session) => session.id === id)))); }, [sessions]);

  const [sessionsStatus, setSessionsStatus] = useState("");
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deleteSessionId, setDeleteSessionId] = useState<string | null>(null);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [skillSelectionIndex, setSkillSelectionIndex] = useState(0);
  const [pendingPrompts, setPendingPrompts] = useState<AiPendingPrompt[]>(() => preview ? [{ sessionId: "session-preview-user", id: "pending-preview", prompt: "补充比较 BTC 与 ETH 的资金费率结构。", delivery: "queue", attachmentCount: 0 }] : []);
  const [pendingDockOpen, setPendingDockOpen] = useState(false);
  const [editingPendingId, setEditingPendingId] = useState<string | null>(null);
  const [pendingDraft, setPendingDraft] = useState("");
  const [taskDockOpen, setTaskDockOpen] = useState(false);
  const [nearBottom, setNearBottom] = useState(true);
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => new Set());
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(() => preview || window.localStorage.getItem("desic.ai-research.inspector-open") !== "false");
  const [inspectorSection, setInspectorSection] = useState<"artifacts" | "intelligence" | "radar">("artifacts");
  const [inspectorArtifact, setInspectorArtifact] = useState<AiResearchArtifact | null>(null);
  // 聚焦模式：会话级状态，不持久化；仅通过 CSS 类收起周边列，不改默认网格。
  const [focusMode, setFocusMode] = useState(false);
  const [columnWidths, setColumnWidths] = useState(() => readAiResearchColumnWidths());
  const resizeRef = useRef<{ column: "sessions" | "inspector"; pointerId: number; origin: number; startWidth: number } | null>(null);
  const messagesRef = useRef<AiUiMessage[]>(messages);
  const statusRef = useRef(status);
  const workspaceActiveRef = useRef(active);
  const sessionIdRef = useRef(sessionId);
  const sessionSwitchRequestRef = useRef(0);
  const pendingRefreshRequestRef = useRef<Map<string, number>>(new Map());
  const sessionViewCacheRef = useRef<Map<string, AiSessionViewCache>>(new Map());
  const sessionNoticeRef = useRef<Map<string, string>>(new Map());
  const slowTimeoutRef = useRef<number | null>(null);
  const copyFeedbackTimeoutRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sessionScrollRef = useRef<Map<string, number>>(new Map());
  const sessionNearBottomRef = useRef<Map<string, boolean>>(new Map());
  const nearBottomRef = useRef(true);
  const followNextMessageRef = useRef(true);
  const lastObservedMessagesRef = useRef(messages);
  const lastObservedSessionRef = useRef(sessionId);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const aiDockRenderCountRef = useRef(0);
  aiDockRenderCountRef.current += 1;
  const isStreaming = status === "connecting" || status === "running" || status === "streaming" || status === "tooling" || status === "retrying";
  const hasUnreadOutput = unreadSessionIds.has(sessionId);
  const hasAnyUnreadOutput = unreadSessionIds.size > 0;
  const chatModel = config?.models.find((model) => model.id === chatModelId) ?? config?.models[0] ?? null;
  useEffect(() => {
    setContextUsage((current) => {
      const usedTokens = current?.usedTokens ?? 0;
      const next = contextUsageForModel(chatModel, usedTokens);
      if (current?.contextWindow === next.contextWindow && current?.contextWindowSource === next.contextWindowSource) return current;
      return next;
    });
  }, [chatModel]);
  const visibleSessions = useMemo(
    () => sessions.filter((session) => session.origin === "user"),
    [sessions]
  );
  const aiTasks = useMemo(() => extractAiTasks(messages), [messages]);
  const skillOptions = useMemo(() => {
    const enabled = new Set(config?.enabledSkills ?? []);
    return normalizeAiSkillDefinitions(config?.skillDefinitions ?? AI_SKILL_OPTIONS)
      .filter((skill) => skill.id !== "desic-core-operations")
      .filter((skill) => enabled.has(skill.id))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  }, [config]);
  const slashQuery = useMemo(() => {
    // 第一个空格前是潜在命令名即开菜单（/命令 arg1 arg2 时仍按命令 token 过滤显示）。
    const match = input.match(/^\/([^\s/]*)(?:\s|$)/);
    return match?.[1]?.toLowerCase() ?? null;
  }, [input]);
  const filteredSlashEntries = useMemo(() => {
    if (slashQuery === null) return [];
    return filterAiSlashEntries(AI_RESEARCH_COMMANDS, skillOptions, slashQuery);
  }, [skillOptions, slashQuery]);
  useRendererMemoryMonitor("ai-research-workspace", () => summarizeAiResearchMemory(messages, {
    open: true,
    status,
    renderCount: aiDockRenderCountRef.current,
    sessions: sessions.length,
    sessionsOpen: true,
    inputLength: input.length
  }));

  const markSessionUnread = useCallback((targetSessionId: string, unread: boolean) => {
    setUnreadSessionIds((current) => {
      const alreadyUnread = current.has(targetSessionId);
      if (alreadyUnread === unread) return current;
      const next = new Set(current);
      if (unread) next.add(targetSessionId);
      else next.delete(targetSessionId);
      return next;
    });
  }, []);

  const togglePinnedSession = useCallback((targetSessionId: string) => {
    if (preview) return;
    setPinnedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(targetSessionId)) next.delete(targetSessionId);
      else next.add(targetSessionId);
      persistPinnedAiSessionIds(next);
      setSessions((items) => sortAiSessions(items, next));
      return next;
    });
  }, [preview]);

  const refreshSessions = useCallback(async () => {
    if (preview) return;
    try {
      const items = await listAiSessions();
      if (items) {
        const loadedIds = new Set(items.map((item) => item.id));
        setPinnedSessionIds((current) => {
          const next = new Set(Array.from(current).filter((id) => loadedIds.has(id)));
          persistPinnedAiSessionIds(next);
          return next;
        });
        setSessions(sortAiSessions(items, readPinnedAiSessionIds()));
      }
      setSessionsStatus("");
    } catch (error) {
      logger.error("ai sessions list failed", error);
      setSessionsStatus(t("automation:sessionListLoadFailed"));
    }
  }, [preview, t]);

  const invalidatePendingRefresh = useCallback((targetSessionId: string) => {
    const next = (pendingRefreshRequestRef.current.get(targetSessionId) ?? 0) + 1;
    pendingRefreshRequestRef.current.set(targetSessionId, next);
    return next;
  }, []);

  const refreshPendingPromptsForSession = useCallback(async (targetSessionId: string) => {
    if (preview) return [] as AiPendingPrompt[];
    const requestToken = invalidatePendingRefresh(targetSessionId);
    const prompts = await refreshAiPendingPrompts(targetSessionId);
    const ownedPrompts = prompts.filter((prompt) => prompt.sessionId === targetSessionId);
    if (pendingRefreshRequestRef.current.get(targetSessionId) === requestToken
      && sessionIdRef.current === targetSessionId) {
      setPendingPrompts((current) => reconcilePendingPromptSnapshot(current, ownedPrompts, targetSessionId));
    }
    return ownedPrompts;
  }, [invalidatePendingRefresh, preview]);

  const clearAiTimers = useCallback((scope: "all" | "slow" = "all") => {
    if ((scope === "all" || scope === "slow") && slowTimeoutRef.current !== null) {
      window.clearTimeout(slowTimeoutRef.current);
      slowTimeoutRef.current = null;
    }
  }, []);

  const copyAiMessage = useCallback(async (message: AiUiMessage) => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopiedMessageId(message.id);
      if (copyFeedbackTimeoutRef.current !== null) window.clearTimeout(copyFeedbackTimeoutRef.current);
      copyFeedbackTimeoutRef.current = window.setTimeout(() => {
        setCopiedMessageId(null);
        copyFeedbackTimeoutRef.current = null;
      }, 1_600);
    } catch (error) {
      setSessionsStatus(error instanceof Error ? error.message : uiText("复制失败", "Copy failed"));
    }
  }, [uiText]);

  useEffect(() => () => {
    if (copyFeedbackTimeoutRef.current !== null) window.clearTimeout(copyFeedbackTimeoutRef.current);
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    workspaceActiveRef.current = active;
  }, [active]);

  useEffect(() => {
    if (preview) return;
    window.localStorage.setItem("desic.ai-research.inspector-open", String(inspectorOpen));
  }, [inspectorOpen, preview]);

  useEffect(() => {
    if (preview) return;
    window.localStorage.setItem("desic.ai-research.columns", JSON.stringify(columnWidths));
  }, [columnWidths, preview]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const resize = resizeRef.current;
      if (!resize || event.pointerId !== resize.pointerId) return;
      const next = resize.column === "sessions"
        ? resize.startWidth + event.clientX - resize.origin
        : resize.startWidth + resize.origin - event.clientX;
      setColumnWidths((current) => ({ ...current, [resize.column]: Math.max(resize.column === "sessions" ? 210 : 300, Math.min(resize.column === "sessions" ? 420 : 720, next)) }));
    };
    const onPointerUp = (event: PointerEvent) => {
      if (resizeRef.current?.pointerId === event.pointerId) resizeRef.current = null;
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  useEffect(() => {
    onRuntimeStateChange?.({ status, unread: hasAnyUnreadOutput });
  }, [hasAnyUnreadOutput, onRuntimeStateChange, status]);

  useEffect(() => {
    if (preview) return;
    cacheAiSessionView(sessionViewCacheRef.current, sessionId, { messages, status, contextUsage });
  }, [contextUsage, messages, preview, sessionId, status]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    if (preview) return;
    persistAiSessionDraft(sessionId, input);
  }, [input, preview, sessionId]);

  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    const sessionChanged = lastObservedSessionRef.current !== sessionId;
    const messagesChanged = lastObservedMessagesRef.current !== messages;
    lastObservedSessionRef.current = sessionId;
    lastObservedMessagesRef.current = messages;
    if (sessionChanged || !messagesChanged) return;
    if (!active) {
      if (messagesChanged) markSessionUnread(sessionId, true);
      return;
    }
    const shouldFollow = nearBottomRef.current || followNextMessageRef.current;
    if (!shouldFollow) {
      if (messagesChanged) markSessionUnread(sessionId, true);
      return;
    }
    followNextMessageRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      host.scrollTop = host.scrollHeight;
      nearBottomRef.current = true;
      sessionNearBottomRef.current.set(sessionId, true);
      setNearBottom(true);
      markSessionUnread(sessionId, false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, markSessionUnread, messages, sessionId]);

  useEffect(() => {
    if (!active) return;
    const host = scrollRef.current;
    if (!host) return;
    const saved = sessionScrollRef.current.get(sessionId);
    const shouldFollow = sessionNearBottomRef.current.get(sessionId) ?? (saved === undefined);
    const frame = window.requestAnimationFrame(() => {
      host.scrollTop = shouldFollow ? host.scrollHeight : saved ?? host.scrollHeight;
      const isNearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 96;
      nearBottomRef.current = isNearBottom;
      sessionNearBottomRef.current.set(sessionId, isNearBottom);
      setNearBottom(isNearBottom);
      if (isNearBottom) markSessionUnread(sessionId, false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, markSessionUnread, sessionId]);

  useEffect(() => {
    if (preview) return;
    void loadAiConfigSummary().then((summary) => {
      setConfig(summary);
      if (summary) {
        setChatModelId(summary.activeModelId || summary.models[0]?.id || "");
        setChatPermissionMode(normalizeAiPermissionMode(summary.permissionMode));
        setChatReasoningDepth(summary.reasoningDepth ?? "medium");
      }
    });
    void listAiSessions()
      .then((snapshot) => {
        const items = sortAiSessions(snapshot ?? [], pinnedSessionIds);
        setSessions(items);
        const recent = items.find((session) => session.origin === "user");
        if (recent) return loadAiSession(recent.id);
        return createAiSession("交易助手");
      })
      .then((snapshot) => {
        if (!snapshot) return;
        setSessionId(snapshot.session.id);
        setSessionTitle(snapshot.session.title || t("automation:tradingAssistant"));
        sessionIdRef.current = snapshot.session.id;
        setStatus(aiRuntimeStatusFromSession(snapshot.session.status));
        setInput(loadAiSessionDraft(snapshot.session.id));
        setPendingPrompts([]);
        void refreshPendingPromptsForSession(snapshot.session.id).catch(() => undefined);
        const restored = snapshotToUiMessages(snapshot);
        setContextUsage(latestAiContextUsage(restored) ?? contextUsageForModel(chatModel));
        if (restored.length > 0) setMessages(restored);
        void refreshSessions();
      })
      .catch((error) => {
        logger.error("ai session load failed", error);
        setStatus("failed");
    });
    const listenerCleanup = createDeferredCleanupSlot();
    void listenAiEvents((event) => {
      const active = event.sessionId === sessionIdRef.current;
      if (event.type === "pendingPrompts" || event.type === "pendingPromptSubmitted"
        || event.type === "pendingPromptError" || event.type === "turnStarted") {
        invalidatePendingRefresh(event.sessionId);
      }
      if (event.type === "done" || event.type === "error" || event.type === "turnStarted") {
        void refreshSessions();
      }
      if (event.type === "status" || event.type === "turnStarted") {
        if (active && event.type === "status") setStatusDetail(event.status === "retrying" ? event.message : "");
        const nextSessionStatus = event.type === "status" ? event.status : "running";
        setSessions((items) => sortAiSessions(items.map((item) => item.id === event.sessionId ? { ...item, status: nextSessionStatus, updatedAt: Math.max(item.updatedAt, Date.now()) } : item), readPinnedAiSessionIds()));
      }
       if (active && event.type === "pendingPrompts") {
        setPendingPrompts((current) => reconcilePendingPromptSnapshot(current, event.prompts, event.sessionId));
      }
      if (active && event.type === "pendingPromptSubmitted") {
        setPendingPrompts((items) => reconcileSubmittedPendingPrompt(items, event.prompt));
      }
      if (active && event.type === "pendingPromptError") {
        if (event.operation === "submit") {
          setPendingPrompts((items) => removeOnePendingPrompt(items, event.prompt, event.delivery, event.promptId, event.localMessageId));
        }
        if (event.operation === "submit" && event.prompt.trim()) {
          setInput((current) => current.trim() ? current : event.prompt);
        }
        setSessionsStatus(event.message);
        if (event.operation !== "list" && !workspaceActiveRef.current) {
          markSessionUnread(event.sessionId, true);
        }
        if (event.operation !== "list") {
          void refreshPendingPromptsForSession(event.sessionId).catch(() => undefined);
        }
      }
      if (!active && event.type === "pendingPromptError" && event.operation !== "list") {
        sessionNoticeRef.current.set(event.sessionId, event.message);
        if (event.operation === "submit" && event.prompt.trim() && !loadAiSessionDraft(event.sessionId).trim()) {
          persistAiSessionDraft(event.sessionId, event.prompt);
        }
        markSessionUnread(event.sessionId, true);
      }
      if (active && event.type === "turnStarted" && event.prompt?.trim()) {
        setPendingPrompts((items) => removeOnePendingPrompt(items, event.prompt ?? "", event.delivery, event.promptId, event.localMessageId));
      }
      const existingCached = sessionViewCacheRef.current.get(event.sessionId);
      if (!active && !existingCached) {
        if (aiEventProducesUnread(event)) markSessionUnread(event.sessionId, true);
        return;
      }
      const cached = existingCached ?? {
        messages: messagesRef.current,
        status: statusRef.current,
        contextUsage: latestAiContextUsage(messagesRef.current)
      };
      let nextStatus = cached.status;
      let nextMessages = cached.messages;
      let nextContextUsage = cached.contextUsage;
      if (event.type === "contextUsage" && isValidAiContextUsage(event.usage)) nextContextUsage = withAiContextFallback(event.usage) ?? nextContextUsage;
      applyAiEvent(
        event,
        (value) => { nextStatus = value; },
        (update) => {
          nextMessages = typeof update === "function" ? update(nextMessages) : update;
        }
      );
      cacheAiSessionView(sessionViewCacheRef.current, event.sessionId, { messages: nextMessages, status: nextStatus, contextUsage: nextContextUsage });
      if (!active) {
        if (aiEventProducesUnread(event)) markSessionUnread(event.sessionId, true);
        return;
      }
      if (event.type === "status" || event.type === "delta" || event.type === "done" || event.type === "error") clearAiTimers("slow");
      setStatus(nextStatus);
      setMessages(nextMessages);
      setContextUsage(nextContextUsage);
    }).then((unlisten) => listenerCleanup.settle(unlisten));
    return () => {
      listenerCleanup.dispose();
      clearAiTimers();
    };
  }, [clearAiTimers, invalidatePendingRefresh, markSessionUnread, preview, refreshPendingPromptsForSession, refreshSessions]);

  // Tauri events are not replayed. Reconcile the durable session state as a
  // fallback so an early sidecar/command failure cannot leave the dock stuck.
  useEffect(() => {
    if (preview || !["connecting", "streaming", "tooling", "running", "retrying"].includes(status)) return;
    let disposed = false;
    let interval: number | null = null;
    const reconcile = async () => {
      const snapshot = await loadAiSession(sessionIdRef.current).catch((error) => {
        logger.debug("ai session terminal reconciliation failed", { error: error instanceof Error ? error.message : String(error) });
        return null;
      });
      if (disposed || !snapshot || snapshot.session.id !== sessionIdRef.current) return;
      const normalized = snapshot.session.status.trim().toLowerCase();
      if (!["failed", "error", "stopped", "cancelled", "canceled", "idle", "completed", "done", "success"].includes(normalized)) return;
      clearAiTimers();
      const restored = snapshotToUiMessages(snapshot);
      if (restored.length > 0) setMessages(restored);
      setStatus(["failed", "error"].includes(normalized) ? "failed" : "idle");
      void refreshSessions();
      if (interval !== null) {
        window.clearInterval(interval);
        interval = null;
      }
    };
    const start = window.setTimeout(() => {
      void reconcile();
      interval = window.setInterval(() => void reconcile(), 2_000);
    }, 2_000);
    return () => {
      disposed = true;
      window.clearTimeout(start);
      if (interval !== null) window.clearInterval(interval);
    };
  }, [clearAiTimers, preview, refreshSessions, status]);

  useEffect(() => {
    if (preview) return;
    const listenerCleanup = createDeferredCleanupSlot();
    void listenAiSessionTitleUpdates((update) => {
      if (update.sessionId === sessionIdRef.current) setSessionTitle(update.title);
      setSessions((current) => current.map((session) => session.id === update.sessionId ? { ...session, title: update.title, updatedAt: Date.now() } : session));
    }).then((unlisten) => listenerCleanup.settle(unlisten));
    return () => listenerCleanup.dispose();
  }, [preview]);

  useEffect(() => {
    if (preview) return;
    const listenerCleanup = createDeferredCleanupSlot();
    void listenAiConfigUpdates((summary) => {
      setConfig(summary);
      setChatModelId((current) => {
        const nextModelId = summary.models.some((model) => model.id === current)
          ? current
          : summary.activeModelId || summary.models[0]?.id || "";
        const selected = summary.models.find((model) => model.id === nextModelId);
        setChatPermissionMode(normalizeAiPermissionMode(selected?.permissionMode ?? summary.permissionMode));
        setChatReasoningDepth(selected?.reasoningDepth ?? summary.reasoningDepth ?? "medium");
        return nextModelId;
      });
    }).then((unlisten) => listenerCleanup.settle(unlisten));
    return () => listenerCleanup.dispose();
  }, [preview]);

  useEffect(() => {
    if (slashQuery === null || filteredSlashEntries.length === 0) {
      setSkillMenuOpen(false);
      setSkillSelectionIndex(0);
      return;
    }
    setSkillMenuOpen(true);
    setSkillSelectionIndex(0);
  }, [filteredSlashEntries.length, slashQuery]);

  // 聚焦模式 Escape 退出：仅在聚焦态挂载监听，退出即清理，不加全局常驻监听。
  useEffect(() => {
    if (!focusMode) return;
    const handleFocusModeKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFocusMode(false);
    };
    window.addEventListener("keydown", handleFocusModeKeyDown);
    return () => window.removeEventListener("keydown", handleFocusModeKeyDown);
  }, [focusMode]);

  const submit = useCallback(async (requestedDelivery?: AiPromptDelivery, requestedContent?: string) => {
    const content = requestedContent ?? input;
    const shouldClearComposer = requestedContent === undefined;
    if (!content.trim() || preview) return;
    const activeSessionId = sessionIdRef.current;
    const now = Date.now();
    const messageNonce = createAiMessageNonce();
    const delivery = isStreaming ? requestedDelivery ?? "queue" : undefined;
    const activePrompt = [...messagesRef.current].reverse().find((message) => message.role === "user")?.text;
    if (delivery && (activePrompt === content || pendingPrompts.some((item) => item.prompt === content))) {
      setSessionsStatus(uiText("相同消息正在处理或已在队列中", "This message is active or already pending"));
      return;
    }
    setSessionsStatus("");
    const userMessage: AiUiMessage = {
      id: `u-${messageNonce}`,
      role: "user",
      text: content,
      tools: [],
      approvals: [],
      createdAt: now
    };
    const sourceMessages = [...messagesRef.current, userMessage];
    const history: AiChatMessage[] = sourceMessages
      .filter((message) => message.id !== "welcome" && message.role !== "system")
      .filter((message) => message.role !== "assistant" || message.text.trim().length > 0)
      .map((message) => ({
        id: message.id,
        role: (message.role === "assistant" ? "assistant" : "user") as AiChatMessage["role"],
        content: message.text || message.reasoning || ""
      }))
      .filter((message) => message.content.trim().length > 0);

    if (!isTauriRuntime()) {
      setMessages((items) => [
        ...items,
        userMessage,
        { id: `a-${messageNonce}`, role: "assistant", text: "", tools: [], approvals: [], createdAt: now, status: "AI 只能在桌面应用内使用" }
      ]);
      if (shouldClearComposer) setInput("");
      setStatus("failed");
      return;
    }

    if (shouldClearComposer) setInput("");
    followNextMessageRef.current = true;
    if (delivery) {
      const optimisticId = `local-${messageNonce}`;
      invalidatePendingRefresh(activeSessionId);
      setPendingPrompts((items) => [...items, { sessionId: activeSessionId, id: optimisticId, prompt: content, delivery, attachmentCount: 0, localMessageId: userMessage.id }]);
      try {
        await sendAiMessage(activeSessionId, history, accountId, {
          modelId: chatModelId || undefined,
          permissionMode: chatPermissionMode,
          reasoningDepth: chatReasoningDepth,
          delivery
        });
        void refreshPendingPromptsForSession(activeSessionId).catch(() => undefined);
      } catch (error) {
        logger.error("ai pending prompt send failed", error);
        invalidatePendingRefresh(activeSessionId);
        setPendingPrompts((items) => items.filter((item) => item.sessionId !== activeSessionId || item.id !== optimisticId));
        if (sessionIdRef.current !== activeSessionId) {
          if (shouldClearComposer) persistAiSessionDraft(activeSessionId, content);
          sessionNoticeRef.current.set(activeSessionId, error instanceof Error ? error.message : uiText("消息入队失败", "Failed to queue message"));
          markSessionUnread(activeSessionId, true);
          return;
        }
        if (shouldClearComposer) setInput(content);
        setSessionsStatus(error instanceof Error ? error.message : uiText("消息入队失败", "Failed to queue message"));
        if (!workspaceActiveRef.current) markSessionUnread(activeSessionId, true);
      }
      return;
    }

    const assistantMessage: AiUiMessage = {
      id: `a-${messageNonce}`,
      role: "assistant",
      text: "",
      reasoning: "",
      tools: [],
      approvals: [],
      createdAt: now,
      startedAt: now,
      status: "连接模型服务"
    };
    const nextMessages = [...messagesRef.current, userMessage, assistantMessage];
    setMessages(nextMessages);
    setStatus("connecting");
    clearAiTimers();
    slowTimeoutRef.current = window.setTimeout(() => {
      if (!["connecting", "running", "streaming", "tooling"].includes(statusRef.current)) return;
      setMessages((items) => updateLastAssistant(items, (message) => ({
        ...message,
        status: "模型响应较慢，仍在等待..."
      })));
    }, 12_000);
    try {
      await sendAiMessage(activeSessionId, history, accountId, {
        modelId: chatModelId || undefined,
        permissionMode: chatPermissionMode,
        reasoningDepth: chatReasoningDepth
      });
      await refreshSessions();
      const snapshot = await loadAiSession(activeSessionId).catch((error) => {
        logger.warn("ai session refresh after send failed", error);
        return null;
      });
      if (snapshot && snapshot.session.id === sessionIdRef.current) {
        setSessionTitle(snapshot.session.title || t("automation:newSession"));
      }
    } catch (error) {
      logger.error("ai send failed", error);
      const errorMessage = error instanceof Error ? error.message : "发送失败";
      const cached = sessionViewCacheRef.current.get(activeSessionId);
      const failedMessages = updateLastAssistant(nextMessages, (message) => ({
        ...message,
        completed: true,
        completedAt: Date.now(),
        finishReason: "error",
        error: true,
        errorMessage,
        status: undefined
      }));
      cacheAiSessionView(sessionViewCacheRef.current, activeSessionId, {
        messages: failedMessages,
        status: "failed",
        contextUsage: cached?.contextUsage
      });
      if (sessionIdRef.current !== activeSessionId) {
        if (shouldClearComposer) persistAiSessionDraft(activeSessionId, content);
        markSessionUnread(activeSessionId, true);
        return;
      }
      clearAiTimers();
      if (shouldClearComposer) setInput((current) => current.trim() ? current : content);
      setStatus("failed");
      setMessages(failedMessages);
    }
  }, [accountId, chatModelId, chatPermissionMode, chatReasoningDepth, clearAiTimers, input, invalidatePendingRefresh, isStreaming, markSessionUnread, pendingPrompts, preview, refreshPendingPromptsForSession, refreshSessions, uiText]);

  const createNewSession = useCallback(async () => {
    if (preview || creatingSession) return;
    setCreatingSession(true);
    const createRequestId = ++sessionSwitchRequestRef.current;
    try {
      clearAiTimers();
      const snapshot = await createAiSession();
      if (!snapshot) {
        setStatus("failed");
        setSessionsStatus(t("automation:createSessionDesktopRetry"));
        setMessages([]);
        return;
      }
      if (createRequestId !== sessionSwitchRequestRef.current) {
        await refreshSessions();
        return;
      }
      setSessionId(snapshot.session.id);
      setSessionTitle(snapshot.session.title || t("automation:newSession"));
      sessionIdRef.current = snapshot.session.id;
      const restoredMessages = snapshotToUiMessages(snapshot);
      setMessages(restoredMessages);
      setContextUsage(latestAiContextUsage(restoredMessages) ?? contextUsageForModel(chatModel));
      setPendingPrompts([]);
      setEditingPendingId(null);
      setPendingDraft("");
      setPendingDockOpen(false);
       setInspectorArtifact(null);
      setInspectorArtifact(null);
      setInput("");
      setStatus("idle");
      await refreshSessions();
    } catch (error) {
      if (createRequestId !== sessionSwitchRequestRef.current) return;
      logger.error("ai create new session failed", error);
      setStatus("failed");
      setMessages((items) => [
        ...items,
        { id: `a-${Date.now()}`, role: "assistant", text: "", tools: [], status: error instanceof Error ? error.message : "新会话创建失败" }
      ]);
    } finally {
      setCreatingSession(false);
    }
  }, [clearAiTimers, creatingSession, preview, refreshSessions]);

  const switchSession = useCallback(async (targetSessionId: string) => {
    if (preview || targetSessionId === sessionIdRef.current) return;
    const switchRequestId = ++sessionSwitchRequestRef.current;
    try {
      clearAiTimers();
      const currentHost = scrollRef.current;
      if (currentHost) {
        sessionScrollRef.current.set(sessionIdRef.current, currentHost.scrollTop);
        sessionNearBottomRef.current.set(sessionIdRef.current, nearBottomRef.current);
      }
      setSessionsStatus(t("automation:loadingSession"));
      const snapshot = await loadAiSession(targetSessionId);
      if (!snapshot || switchRequestId !== sessionSwitchRequestRef.current) return;
      const cached = sessionViewCacheRef.current.get(targetSessionId);
      const restoredMessages = cached ? cached.messages : snapshotToUiMessages(snapshot);
      const restoredStatus = cached ? cached.status : aiRuntimeStatusFromSession(snapshot.session.status);
      const restoredContextUsage = cached?.contextUsage ?? latestAiContextUsage(restoredMessages) ?? contextUsageForModel(chatModel);
      setSessionId(snapshot.session.id);
      setSessionTitle(snapshot.session.title || t("automation:newSession"));
      sessionIdRef.current = snapshot.session.id;
      setStatus(restoredStatus);
      setMessages(restoredMessages);
      setContextUsage(restoredContextUsage ?? contextUsageForModel(chatModel));
      cacheAiSessionView(sessionViewCacheRef.current, targetSessionId, { messages: restoredMessages, status: restoredStatus, contextUsage: restoredContextUsage });
      setInput(loadAiSessionDraft(snapshot.session.id));
      setPendingPrompts([]);
      setEditingPendingId(null);
      setPendingDraft("");
      setPendingDockOpen(false);
       setInspectorArtifact(null);
      void refreshPendingPromptsForSession(snapshot.session.id).catch(() => undefined);
      const notice = sessionNoticeRef.current.get(snapshot.session.id) ?? "";
      sessionNoticeRef.current.delete(snapshot.session.id);
      await refreshSessions();
      if (notice && switchRequestId === sessionSwitchRequestRef.current
        && sessionIdRef.current === snapshot.session.id) {
        setSessionsStatus(notice);
      }
    } catch (error) {
      if (switchRequestId !== sessionSwitchRequestRef.current) return;
      logger.error("ai session switch failed", error);
      setSessionsStatus(error instanceof Error ? error.message : t("automation:switchSessionFailed"));
    }
  }, [clearAiTimers, preview, refreshPendingPromptsForSession, refreshSessions]);

  const startRenameSession = useCallback((session: AiSession) => {
    setRenamingSessionId(session.id);
    setRenameDraft(session.title);
  }, []);

  const commitRenameSession = useCallback(async () => {
    if (!renamingSessionId) return;
    const title = renameDraft.trim();
    if (!title) {
      setSessionsStatus(t("automation:sessionTitleRequired"));
      return;
    }
    try {
      const updated = await renameAiSession(renamingSessionId, title);
      if (updated && updated.id === sessionIdRef.current) setSessionTitle(updated.title);
      setRenamingSessionId(null);
      setRenameDraft("");
      await refreshSessions();
    } catch (error) {
      logger.error("ai session rename failed", error);
      setSessionsStatus(error instanceof Error ? error.message : t("automation:renameFailed"));
    }
  }, [refreshSessions, renameDraft, renamingSessionId]);

  const removeSession = useCallback(async (targetSessionId: string) => {
    if (preview) return;
    const deletingActiveSession = targetSessionId === sessionIdRef.current;
    const deletionRequestId = deletingActiveSession
      ? ++sessionSwitchRequestRef.current
      : sessionSwitchRequestRef.current;
    try {
      if (deletingActiveSession) {
        clearAiTimers();
        if (isStreaming) await stopAiMessage(targetSessionId).catch((error) => logger.warn("ai stop before deleting session failed", error));
      }
      await deleteAiSession(targetSessionId);
      persistAiSessionDraft(targetSessionId, "");
      sessionScrollRef.current.delete(targetSessionId);
      sessionNearBottomRef.current.delete(targetSessionId);
      sessionViewCacheRef.current.delete(targetSessionId);
      sessionNoticeRef.current.delete(targetSessionId);
      pendingRefreshRequestRef.current.delete(targetSessionId);
      markSessionUnread(targetSessionId, false);
      const nextSessions = sortAiSessions((await listAiSessions()) ?? [], readPinnedAiSessionIds());
      setSessions(nextSessions);
      if (deletingActiveSession && targetSessionId === sessionIdRef.current
        && deletionRequestId === sessionSwitchRequestRef.current) {
        const next = nextSessions.find((session) => session.origin === "user");
        const snapshot = next ? await loadAiSession(next.id) : await createAiSession();
        if (snapshot) {
          const restoredMessages = snapshotToUiMessages(snapshot);
          setSessionId(snapshot.session.id);
          setSessionTitle(snapshot.session.title || t("automation:newSession"));
          sessionIdRef.current = snapshot.session.id;
          setMessages(restoredMessages);
          setContextUsage(latestAiContextUsage(restoredMessages) ?? contextUsageForModel(chatModel));
          setStatus(aiRuntimeStatusFromSession(snapshot.session.status));
          setInput(loadAiSessionDraft(snapshot.session.id));
          setPendingPrompts([]);
          setEditingPendingId(null);
          setPendingDraft("");
          setPendingDockOpen(false);
       setInspectorArtifact(null);
          void refreshPendingPromptsForSession(snapshot.session.id).catch(() => undefined);
          if (!next) await refreshSessions();
        }
      }
      setDeleteSessionId(null);
    } catch (error) {
      logger.error("ai session delete failed", error);
      setSessionsStatus(error instanceof Error ? error.message : t("automation:deleteFailed"));
    }
  }, [clearAiTimers, isStreaming, markSessionUnread, preview, refreshPendingPromptsForSession, refreshSessions]);

  const commitPendingPrompt = useCallback(async (item: AiPendingPrompt) => {
    const nextPrompt = pendingDraft;
    const ownerSessionId = item.sessionId;
    if (!nextPrompt.trim() || preview || ownerSessionId !== sessionIdRef.current) return;
    invalidatePendingRefresh(ownerSessionId);
    setPendingPrompts((items) => items.map((candidate) => candidate.sessionId === ownerSessionId && candidate.id === item.id ? { ...candidate, prompt: nextPrompt } : candidate));
    setEditingPendingId(null);
    setPendingDraft("");
    try {
      await updateAiPendingPrompt(ownerSessionId, item.id, nextPrompt, item.delivery);
    } catch (error) {
      if (ownerSessionId !== sessionIdRef.current) return;
      setSessionsStatus(error instanceof Error ? error.message : uiText("更新队列消息失败", "Failed to update queued message"));
      void refreshPendingPromptsForSession(ownerSessionId).catch(() => undefined);
    }
  }, [invalidatePendingRefresh, pendingDraft, preview, refreshPendingPromptsForSession, uiText]);

  const removePendingPrompt = useCallback(async (item: AiPendingPrompt) => {
    const ownerSessionId = item.sessionId;
    if (preview || ownerSessionId !== sessionIdRef.current) return;
    invalidatePendingRefresh(ownerSessionId);
    setPendingPrompts((items) => items.filter((candidate) => candidate.sessionId !== ownerSessionId || candidate.id !== item.id));
    try {
      await deleteAiPendingPrompt(ownerSessionId, item.id);
    } catch (error) {
      if (ownerSessionId !== sessionIdRef.current) return;
      setSessionsStatus(error instanceof Error ? error.message : uiText("删除队列消息失败", "Failed to remove queued message"));
      void refreshPendingPromptsForSession(ownerSessionId).catch(() => undefined);
    }
  }, [invalidatePendingRefresh, preview, refreshPendingPromptsForSession, uiText]);

  const performFork = useCallback(async (
    sourceSessionId: string,
    sourceUiMessages: AiUiMessage[],
    message: AiUiMessage
  ) => {
    if (preview) return;
    try {
      if (sessionIdRef.current === sourceSessionId) {
        setSessionsStatus(uiText("正在创建分支", "Creating branch"));
      }
      const source = await loadAiSession(sourceSessionId);
      const sourceRole = message.role === "user" ? "user" : message.role === "system" ? "system" : "assistant";
      const visibleUiRoleMessages = sourceUiMessages.filter((item) => item.id !== "welcome" && item.role === message.role);
      const visibleStoredRoleMessages = (source?.messages ?? [])
        .filter(isVisibleAiStoredMessage)
        .filter((item) => item.role === sourceRole);
      const roleIndex = visibleUiRoleMessages.findIndex((item) => item.id === message.id);
      const persistedMessageId = source?.messages.some((item) => item.id === message.id)
        ? message.id
        : roleIndex >= 0
          ? visibleStoredRoleMessages[roleIndex]?.id
          : [...visibleStoredRoleMessages]
            .reverse()
            .find((item) => item.content === message.text)
            ?.id;
      if (!persistedMessageId) throw new Error(uiText("无法定位这条消息，请刷新会话后重试", "This message could not be located. Refresh the session and try again."));
      const snapshot = await forkAiSession(sourceSessionId, persistedMessageId);
      if (!snapshot) return;
      await refreshSessions();
      if (sessionIdRef.current === sourceSessionId) {
        await switchSession(snapshot.session.id);
        if (sessionIdRef.current === snapshot.session.id) {
          setSessionsStatus(uiText("已创建分支，原会话保持不变", "Branch created; the original session is unchanged"));
        }
      }
    } catch (error) {
      if (sessionIdRef.current === sourceSessionId) {
        setSessionsStatus(error instanceof Error ? error.message : uiText("创建分支失败", "Failed to create branch"));
      }
    }
  }, [preview, refreshSessions, switchSession, uiText]);

  const requestFork = useCallback((message: AiUiMessage) => {
    const sourceSessionId = sessionIdRef.current;
    const sourceUiMessages = messagesRef.current;
    forkPrompt.confirm({
      title: uiText("从此处创建分支", "Branch from this message"),
      message: uiText("将复制到这条消息为止的对话并打开新会话。原会话和已执行的工具副作用不会回滚。", "A new session will copy the conversation through this message. The original session and prior tool side effects are not rolled back."),
      confirmText: uiText("创建分支", "Create branch"),
      onConfirm: () => void performFork(sourceSessionId, sourceUiMessages, message)
    });
  }, [forkPrompt.confirm, performFork, uiText]);

  const insertResearchPrompt = useCallback((prompt: string) => {
    const content = String(prompt || "").trim();
    if (!content) return;
    setInspectorOpen(false);
    setInput(content);
    setSkillMenuOpen(false);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const openAiMessageById = useCallback((messageId: string) => {
    const host = scrollRef.current;
    const target = host?.querySelector(`[data-ai-message-id="${CSS.escape(messageId)}"]`);
    if (!(target instanceof HTMLElement)) return;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("ai-message-located");
    window.setTimeout(() => target.classList.remove("ai-message-located"), 1_600);
  }, []);

  const insertSlashEntry = useCallback((entry: AiSlashEntry) => {
    if (entry.kind === "skill") {
      setInput(`/${entry.value.id} `);
    } else {
      setInput(`${entry.value.prompt(selectedSymbol)} `);
    }
    setSkillMenuOpen(false);
    setSkillSelectionIndex(0);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [selectedSymbol]);

  const stop = useCallback(async () => {
    const targetSessionId = sessionIdRef.current;
    clearAiTimers();
    try {
      if (!preview) await stopAiMessage(targetSessionId);
      const cached = sessionViewCacheRef.current.get(targetSessionId);
      const baselineMessages = sessionIdRef.current === targetSessionId ? messagesRef.current : cached?.messages ?? [];
      const stoppedMessages = updateLastAssistant(baselineMessages, (message) => ({ ...message, status: "已停止" }));
      cacheAiSessionView(sessionViewCacheRef.current, targetSessionId, {
        messages: stoppedMessages,
        status: "stopped",
        contextUsage: cached?.contextUsage
      });
      if (sessionIdRef.current !== targetSessionId) {
        markSessionUnread(targetSessionId, true);
        return;
      }
      invalidatePendingRefresh(targetSessionId);
      setPendingPrompts([]);
      setStatus("stopped");
      setMessages(stoppedMessages);
    } catch (error) {
      const message = error instanceof Error ? error.message : uiText("停止失败", "Failed to stop");
      if (sessionIdRef.current === targetSessionId) {
        setSessionsStatus(message);
        if (!workspaceActiveRef.current) markSessionUnread(targetSessionId, true);
      } else {
        sessionNoticeRef.current.set(targetSessionId, message);
        markSessionUnread(targetSessionId, true);
      }
    }
  }, [clearAiTimers, invalidatePendingRefresh, markSessionUnread, preview, uiText]);

  const openInspectorSection = (section: "artifacts" | "intelligence" | "radar") => {
    setInspectorSection(section);
    setInspectorOpen(true);
  };

  const beginColumnResize = (column: "sessions" | "inspector", event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    resizeRef.current = { column, pointerId: event.pointerId, origin: event.clientX, startWidth: columnWidths[column] };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const showWelcomeDeck = messages.length === 0 || isWelcomeGreetingOnlyMessages(messages);
  /* composer：空态渲染进居中构图（标题/快捷建议同轴），常规态停靠底部——同一元素单点渲染，状态零复制 */
  const composerNode = (
            <div className="ai-composer-stack">
              {(aiTasks.length > 0 || pendingPrompts.length > 0) && (
                <div className="ai-composer-docks">
                  {aiTasks.length > 0 ? (
                    <section className="ai-task-dock">
                      <button type="button" onClick={() => setTaskDockOpen((value) => !value)} aria-expanded={taskDockOpen}>
                        <ListTodo size={14} />
                        <strong>{uiText("任务", "Tasks")}</strong>
                        <span>{formatAiTaskSummary(aiTasks, uiText("进行中", "active"))}</span>
                      </button>
                      {taskDockOpen ? (
                        <div>
                          {aiTasks.map((task) => <p className={task.status} key={task.id}><i />{task.content}</p>)}
                        </div>
                      ) : null}
                    </section>
                  ) : null}
                  {pendingPrompts.length > 0 ? (
                    <section className="ai-queue-dock">
                      <button type="button" onClick={() => setPendingDockOpen((value) => !value)} aria-expanded={pendingDockOpen}>
                        <CornerDownRight size={14} />
                        <strong>{uiText("待处理消息", "Queued messages")}</strong>
                        <span>{pendingPrompts.length}</span>
                      </button>
                      {pendingDockOpen ? (
                        <div>
                          {pendingPrompts.map((item) => (
                            <div className="ai-queue-item" key={item.id}>
                              {editingPendingId === item.id ? (
                                <input
                                  autoFocus
                                  value={pendingDraft}
                                  aria-label={uiText("编辑队列消息", "Edit queued message")}
                                  onChange={(event) => setPendingDraft(event.target.value)}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") void commitPendingPrompt(item);
                                    if (event.key === "Escape") setEditingPendingId(null);
                                  }}
                                />
                              ) : <p data-i18n-skip>{item.prompt}</p>}
                              <span>{item.id.startsWith("local-") ? uiText("提交中", "Submitting") : item.delivery === "steer" ? "Steer" : uiText("队列", "Queue")}</span>
                              <button
                                type="button"
                                disabled={item.id.startsWith("local-")}
                                onClick={() => {
                                  if (editingPendingId === item.id) void commitPendingPrompt(item);
                                  else {
                                    setEditingPendingId(item.id);
                                    setPendingDraft(item.prompt);
                                  }
                                }}
                                title={editingPendingId === item.id ? uiText("保存", "Save") : uiText("编辑", "Edit")}
                                aria-label={editingPendingId === item.id ? uiText("保存队列消息", "Save queued message") : uiText("编辑队列消息", "Edit queued message")}
                              >
                                {editingPendingId === item.id ? <CheckCircle2 size={12} /> : <Edit3 size={12} />}
                              </button>
                              <button
                                type="button"
                                disabled={item.id.startsWith("local-")}
                                onClick={() => editingPendingId === item.id ? setEditingPendingId(null) : void removePendingPrompt(item)}
                                title={editingPendingId === item.id ? t("common:cancel") : uiText("移除", "Remove")}
                                aria-label={editingPendingId === item.id ? t("common:cancel") : uiText("移除队列消息", "Remove queued message")}
                              >
                                {editingPendingId === item.id ? <X size={12} /> : <Trash2 size={12} />}
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </section>
                  ) : null}
                </div>
              )}
            <div className="ai-input-row">
            {skillMenuOpen && (
              <AiCommandPalette entries={filteredSlashEntries} activeIndex={skillSelectionIndex} onSelect={insertSlashEntry} uiText={uiText} />
            )}
            <div className="ai-composer">
              <div className="ai-composer-body">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (skillMenuOpen) {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setSkillSelectionIndex((index) => Math.min(index + 1, Math.max(filteredSlashEntries.length - 1, 0)));
                      return;
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setSkillSelectionIndex((index) => Math.max(index - 1, 0));
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setSkillMenuOpen(false);
                      return;
                    }
                    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && filteredSlashEntries[skillSelectionIndex]) {
                      if (/\s/.test(input)) {
                        // "/命令名 arg1 arg2"：命中参数化命令则按顺序回填占位符（不直接发送），多余 args 忽略、缺失的保留 {{param}}。
                        const expanded = expandAiSlashInput(input);
                        if (expanded) {
                          event.preventDefault();
                          setInput(expanded);
                          setSkillMenuOpen(false);
                          setSkillSelectionIndex(0);
                          window.requestAnimationFrame(() => inputRef.current?.focus());
                          return;
                        }
                        // 未命中参数化命令：非参数化命令与普通消息保持原发送行为（Enter 落到下方 submit），Tab 维持默认焦点移动。
                        if (event.key === "Tab") return;
                      } else {
                        event.preventDefault();
                        insertSlashEntry(filteredSlashEntries[skillSelectionIndex]);
                        return;
                      }
                    }
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void submit(isStreaming ? (event.metaKey || event.ctrlKey ? "steer" : "queue") : undefined);
                  }
                }}
                placeholder={uiText("询问市场、账户或研究问题", "Ask about markets, accounts, or research")}
              />
              <div className="ai-composer-controls" aria-label={uiText("发送与停止控制", "Send and stop controls")}>
                 {isStreaming ? <button type="button" className="ai-send stop" onClick={() => void stop()} title={t("automation:stop")} aria-label={t("automation:stop")}><span className="ai-send-core"><Square size={14} /></span></button> : null}
                 <button
                   type="button"
                   className={clsx("ai-send", input.trim() && "is-ready")}
                   onClick={() => void submit(isStreaming ? "queue" : undefined)}
                   disabled={!input.trim()}
                   title={isStreaming ? uiText("加入队列；Cmd/Ctrl+Enter 立即 steer", "Queue; Cmd/Ctrl+Enter steers the active turn") : t("automation:send")}
                   aria-label={isStreaming ? uiText("加入消息队列", "Queue message") : t("automation:send")}
                 >
                   <span className="ai-send-core">{isStreaming ? <CornerDownRight size={15} /> : <Send size={15} />}</span>
                 </button>
               </div>
              </div>
              <div className="ai-composer-toolbar">
                <div className="ai-composer-options">
                  <label data-i18n-skip title={t("automation:modelForThisTurn")}><Bot size={12} /><TerminalSelect ariaLabel={t("settings:aiModel")} value={chatModelId} disabled={isStreaming} options={(config?.models ?? []).map((model) => ({ value: model.id, label: model.name || model.model }))} onChange={setChatModelId} /></label>
                  <label title={t("automation:reasoningForThisTurn")}><SlidersHorizontal size={12} /><TerminalSelect ariaLabel={t("automation:reasoningDepth")} value={chatReasoningDepth} disabled={isStreaming} options={[{ value: "none", label: t("automation:reasoningNone") }, { value: "minimal", label: t("automation:reasoningMinimal") }, { value: "low", label: t("automation:reasoningLow") }, { value: "medium", label: t("automation:reasoningMedium") }, { value: "high", label: t("automation:reasoningHigh") }, { value: "xhigh", label: t("automation:reasoningXHigh") }]} onChange={(value) => setChatReasoningDepth(value as AiReasoningDepth)} /></label>
                  <label title={t("automation:permissionForThisTurn")}><ShieldCheck size={12} /><TerminalSelect ariaLabel={t("automation:aiPermission")} value={chatPermissionMode} disabled={isStreaming} options={[{ value: "advisor", label: t("settings:permissionAdvisor") }, { value: "copilot", label: t("settings:permissionCopilot") }, { value: "limited_auto", label: t("settings:permissionLimitedAutoShort") }]} onChange={(value) => setChatPermissionMode(value as AiPermissionMode)} /></label>
                </div>
                <div
                  className="ai-context-meter legacy"
                  title={contextUsage?.contextWindow
                    ? uiText("当前占用来自 Cline 消息，窗口上限来自 Cline 模型目录。", "Current usage is measured from Cline messages; the limit comes from Cline's model catalog.")
                    : contextUsage
                      ? uiText("当前占用来自 Cline 消息；模型目录没有这个模型的窗口上限。", "Current usage is measured from Cline messages; no exact window is available in Cline's model catalog.")
                      : uiText("当前模型尚未报告可测量的上下文占用。", "No measurable context usage has been reported yet.")}
                >
                  <span>{uiText("上下文", "Context")}</span>
                  <i><b style={{ width: `${aiContextUsagePercent(contextUsage)}%` }} /></i>
                  <strong data-i18n-skip>{formatAiContextUsage(contextUsage)}</strong>
                </div>
                <span data-i18n-skip className={input.trim() ? "ai-composer-context has-content" : "ai-composer-context"}>{input.trim() ? uiText(`${Math.max(1, Math.ceil(input.trim().length / 500))} 段研究上下文`, `${Math.max(1, Math.ceil(input.trim().length / 500))} research context`) : uiText("AI 研究指令", "AI research command")}</span>
                 <AiContextMeter usage={contextUsage} uiText={uiText} />

              </div>
            </div>
            </div>
            </div>
  );

  return (
    <div className="ai-dock ai-research-host" hidden={!active}>
      <section
        className={clsx("ai-panel ai-research-shell sessions-open", inspectorOpen && "inspector-open", focusMode && "ai-focus-mode")}
        style={{ "--ai-sessions-width": `${columnWidths.sessions}px`, "--ai-inspector-width": `${columnWidths.inspector}px` } as CSSProperties}
        aria-label={t("automation:aiConversation")}
      >
          <aside className="ai-session-sidebar open" aria-label={t("automation:sessionHistory")}>
            <div className="ai-session-list">
              <div className="ai-session-list-head">
                <strong>{t("automation:sessionHistory")}</strong>
                <div className="ai-session-list-head-actions">
                  <button onClick={() => void createNewSession()} disabled={preview || creatingSession} title={t("automation:newSession")} aria-label={t("automation:newSession")}>
                    <Plus size={13} />
                  </button>
                  <button onClick={() => void refreshSessions()} disabled={preview} title={t("automation:refreshSessions")} aria-label={t("automation:refreshSessions")}>
                    <RefreshCw size={13} />
                  </button>
                </div>
              </div>
              {sessionsStatus && <small>{sessionsStatus}</small>}
              <div className="ai-session-items" role="tabpanel">
                {visibleSessions.length === 0 ? (
                  <p>{t("automation:noUserSessions")}</p>
                ) : (
                  visibleSessions.map((session) => (
                    <div className={clsx("ai-session-item", session.id === sessionId && "active", unreadSessionIds.has(session.id) && "has-unread", pinnedSessionIds.has(session.id) && "pinned", isAiSessionRunning(session.status) && "running")} key={session.id}>
                      {renamingSessionId === session.id ? (
                        <input
                          value={renameDraft}
                          autoFocus
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void commitRenameSession();
                            if (event.key === "Escape") {
                              setRenamingSessionId(null);
                              setRenameDraft("");
                            }
                          }}
                          onBlur={() => void commitRenameSession()}
                        />
                      ) : (
                        <button
                          className="ai-session-main"
                          onClick={() => void switchSession(session.id)}
                          aria-label={unreadSessionIds.has(session.id)
                            ? `${session.title || t("automation:newSession")}, ${uiText("有未读输出", "unread output")}`
                            : session.title || t("automation:newSession")}
                        >
                          <span data-i18n-skip title={session.title || t("automation:newSession")}><i className="ai-session-status-dot" aria-hidden="true" />{session.title || t("automation:newSession")}</span>
                          <small>{formatAiSessionMeta(session, t)}</small>
                        </button>
                      )}
                      <div className="ai-session-actions">
                         <button onClick={() => togglePinnedSession(session.id)} title={pinnedSessionIds.has(session.id) ? uiText("取消置顶", "Unpin session") : uiText("置顶会话", "Pin session")} aria-label={pinnedSessionIds.has(session.id) ? uiText("取消置顶会话", "Unpin session") : uiText("置顶会话", "Pin session")}>
                           {pinnedSessionIds.has(session.id) ? <Pin size={13} /> : <PinOff size={13} />}
                         </button>
                        <button onClick={() => startRenameSession(session)} title={t("automation:renameSession")} aria-label={t("automation:renameSession")}>
                          <Edit3 size={13} />
                        </button>
                        <button onClick={() => setDeleteSessionId(session.id)} title={t("common:delete")} aria-label={t("common:delete")}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </aside>
          <button type="button" className="ai-column-resize ai-column-resize-sessions" aria-label={uiText("调整会话栏宽度", "Resize session column")} title={uiText("拖动调整会话栏宽度", "Drag to resize session column")} onPointerDown={(event) => beginColumnResize("sessions", event)}><GripVertical size={14} /></button>
          <div className="ai-panel-main">
            <header className="ai-panel-head">
            <div>
              <strong>{uiText("AI 研究", "AI Research")}</strong>
              <span aria-live="polite" aria-atomic="true">{config ? <>{sessionTitle} · {chatModel?.model ?? config.model} · <span className={clsx("ai-head-status", isStreaming && "is-running", status === "failed" && "is-failed")}>{statusLabel(status, t)}{status === "retrying" && statusDetail ? ` · ${statusDetail}` : ""}</span></> : t("automation:readingConfiguration")}</span>
            </div>
            <div className="ai-head-actions">
              <button className="window-button ai-new-session-center-legacy" onClick={() => void createNewSession()} disabled={preview || creatingSession} title={t("automation:newSession")} aria-label={t("automation:newSession")}>
                <Plus size={15} />
              </button>

              <button
                className="window-button"
                onClick={onOpenSettings}
                title={t("common:settings")}
                aria-label={t("common:settings")}
              >
                <Settings size={15} />
              </button>

              <button
                type="button"
                className={clsx("window-button", "ai-focus-toggle", focusMode && "active")}
                onClick={() => setFocusMode((current) => !current)}
                title={uiText("聚焦", "Focus")}
                aria-label={uiText("聚焦", "Focus")}
                aria-pressed={focusMode}
              >
                <Focus size={15} />
              </button>
            </div>
            </header>
            <nav className="ai-inspector-shortcuts" aria-label={uiText("右侧研究面板", "Right research panel")}>
               <button
                 type="button"
                 className={clsx("window-button ai-inspector-shortcut", "shortcut-artifacts", inspectorOpen && inspectorSection === "artifacts" && "active")}
                 onClick={() => openInspectorSection("artifacts")}
                 title={uiText("研究标签", "Research artifacts")}
                 aria-label={uiText("研究标签", "Research artifacts")}
                 aria-pressed={inspectorOpen && inspectorSection === "artifacts"}
               >
                 <Sparkles size={13} />
               </button>
               <button
                 type="button"
                 className={clsx("window-button ai-inspector-shortcut", "shortcut-intelligence", inspectorOpen && inspectorSection === "intelligence" && "active")}
                 onClick={() => openInspectorSection("intelligence")}
                 title={uiText("市场情报", "Market intelligence")}
                 aria-label={uiText("市场情报", "Market intelligence")}
                 aria-pressed={inspectorOpen && inspectorSection === "intelligence"}
               >
                 <Newspaper size={13} />
               </button>
               <button
                 type="button"
                 className={clsx("window-button ai-inspector-shortcut", "shortcut-radar", inspectorOpen && inspectorSection === "radar" && "active")}
                 onClick={() => openInspectorSection("radar")}
                 title={uiText("市场雷达", "Market Radar")}
                 aria-label={uiText("市场雷达", "Market Radar")}
                 aria-pressed={inspectorOpen && inspectorSection === "radar"}
               >
                 <Radar size={13} />
               </button>
             </nav>
             <div className="ai-provider">
            <span>{config?.baseUrl ?? t("automation:modelServiceDisconnected")}</span>
            <strong>{config?.configured ? config.apiKeyMasked : t("automation:notConfigured")}</strong>
            </div>
            <div
              className="ai-messages"
              ref={scrollRef}
              onScroll={(event) => {
                const host = event.currentTarget;
                const nextNearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 96;
                nearBottomRef.current = nextNearBottom;
                sessionScrollRef.current.set(sessionIdRef.current, host.scrollTop);
                sessionNearBottomRef.current.set(sessionIdRef.current, nextNearBottom);
                setNearBottom(nextNearBottom);
                if (nextNearBottom) markSessionUnread(sessionIdRef.current, false);
              }}
            >
            {messages.map((message, messageIndex) => message.id === "welcome" ? null : (
              <article
                className={clsx(
                  "ai-message",
                  message.role,
                  message.role === "assistant" && isStreaming && messageIndex === messages.length - 1 && "is-streaming",
                  message.role === "assistant" && message.error && "is-failed"
                )}
                data-ai-message-id={message.id}
                key={message.id}
              >
                <div className="ai-message-role">{message.role === "user" ? t("automation:you") : "AI"}</div>
                <AiResearchMessageTimeline
                  message={message}
                  streaming={isStreaming}
                  onApprove={(approvalId, approved, reason) => void approveAiTool(sessionIdRef.current, approvalId, approved, reason)}
                  onOpenStrategy={onOpenStrategy}
                  onOpenArtifact={(artifact) => {
                    setInspectorArtifact(artifact);
                    openInspectorSection("artifacts");
                  }}
                />
                <AiMessageError message={message} />
                {message.text && (
                  <div className={clsx("ai-answer", message.role === "assistant" && isStreaming && messageIndex === messages.length - 1 && "is-streaming")}>
                    {message.role === "assistant" && (message.tools.length > 0 || (message.agents?.length ?? 0) > 0) && <strong>{t("automation:analysisResult")}</strong>}
                    {message.role === "assistant" ? <MarkdownMessage content={message.text} /> : <AiMessagePlainText message={message} />}
                  </div>
                )}
                {/* B2：简单工具（readTicker/readFundingRate/readInstrument）完成后在 footer 上方落地内联证据卡 */}
                {message.role === "assistant" ? <AiInlineEvidenceCards message={message} /> : null}
                {message.role === "assistant" ? <AiEvidenceReferences message={message} onOpenArtifact={(artifact) => { setInspectorArtifact(artifact); openInspectorSection("artifacts"); }} onOpenMessage={openAiMessageById} uiText={uiText} /> : null}
                {(message.createdAt || message.text || message.status || (message.role === "assistant" && Boolean(message.usage))) && (
                  <footer className={clsx("ai-message-actions", "ai-message-footer", copiedMessageId === message.id && "is-copied")}>
                    <div className="ai-footer-facts">
                      {message.createdAt ? <time dateTime={new Date(message.createdAt).toISOString()}>{formatAiMessageTimestamp(message.createdAt)}</time> : null}
                      {message.role === "assistant" && message.startedAt ? <AiResearchMessageDuration startedAt={message.startedAt} completedAt={message.completedAt} completed={message.completed} streaming={isStreaming} /> : null}
                      {message.role === "assistant" && message.firstTokenAt && message.startedAt ? <span>TTFT {formatDuration(message.startedAt, message.firstTokenAt)}</span> : null}
                      {message.role === "assistant" ? <AiThroughputMetric message={message} /> : null}
                      {message.role === "assistant" && message.usage ? <AiTokenUsageLine usage={message.usage} variant="meta" /> : null}
                      {message.status ? <span className="ai-message-status">{localizeAiMessageStatus(message.status)}</span> : null}
                    </div>
                    <div className="ai-footer-tools">
                      {message.text ? (
                        <button type="button" onClick={() => void copyAiMessage(message)} title={copiedMessageId === message.id ? uiText("已复制", "Copied") : uiText("复制消息", "Copy message")} aria-label={uiText("复制消息", "Copy message")}>
                          {copiedMessageId === message.id ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                        </button>
                      ) : null}
                      {message.role === "assistant" && message.completed && message.id !== "welcome" ? (
                        <button type="button" onClick={() => requestFork(message)} title={uiText("从此处创建分支", "Branch from here")} aria-label={uiText("从此处创建分支", "Branch from here")}>
                          <GitBranch size={13} />
                        </button>
                      ) : null}
                      {canRetryAiMessage(message) && previousAiUserPrompt(messages, messageIndex) ? (
                        <button
                          type="button"
                          disabled={isStreaming}
                          onClick={() => void submit(undefined, previousAiUserPrompt(messages, messageIndex) ?? undefined)}
                          title={uiText("重试这次提问", "Retry this prompt")}
                          aria-label={uiText("重试这次提问", "Retry this prompt")}
                        >
                          <RotateCcw size={13} />
                        </button>
                      ) : null}
                    </div>
                  </footer>
                )}
              </article>
            ))}
            {/* 空会话（或仅含欢迎语）时在滚动区内渲染任务甲板；欢迎语本身不渲染，由甲板标题替代 */}
            {(messages.length === 0 || isWelcomeGreetingOnlyMessages(messages)) ? (
              <div className="ai-research-welcome-host">
                <AiResearchWelcome uiText={uiText} onSend={(prompt) => { void submit(undefined, prompt); }} />
                {composerNode}
              </div>
            ) : null}
            </div>
            {!nearBottom ? (
              <button
                type="button"
                className={clsx("ai-jump-latest", hasUnreadOutput && "has-unread")}
                onClick={() => {
                  const host = scrollRef.current;
                  if (!host) return;
                  host.scrollTo({ top: host.scrollHeight, behavior: "smooth" });
                  nearBottomRef.current = true;
                  sessionNearBottomRef.current.set(sessionIdRef.current, true);
                  setNearBottom(true);
                  markSessionUnread(sessionIdRef.current, false);
                }}
              >
                <ArrowDown size={14} />{uiText("返回底部", "Jump to latest")}
              </button>
            ) : null}
            {showWelcomeDeck ? null : composerNode}
          </div>
          {inspectorOpen ? <button type="button" className="ai-column-resize ai-column-resize-inspector" aria-label={uiText("调整研究栏宽度", "Resize research panel")} title={uiText("拖动调整研究栏宽度", "Drag to resize research panel")} onPointerDown={(event) => beginColumnResize("inspector", event)}><GripVertical size={14} /></button> : null}
          <AiResearchInspector sessionId={sessionId} artifact={inspectorArtifact} selectedSymbol={selectedSymbol} accountId={accountId} accountLabel={accountLabel} skillDefinitions={skillOptions} open={inspectorOpen} section={inspectorSection} onSectionChange={setInspectorSection} onClose={() => setInspectorOpen(false)} onOpenStrategy={onOpenStrategy} onOpenIntelligence={onOpenIntelligence} onOpenTrading={onOpenTrading} onResearchPrompt={insertResearchPrompt} onOpenMessage={openAiMessageById} marketAssets={marketAssets} marketTickers={marketTickers} cacheDir={cacheDir} uiText={uiText} />

        </section>
      {forkPrompt.element}
      {deleteSessionId && (
        <ConfirmDialog
          title={t("automation:deleteAiSession")}
          message={t("automation:deleteAiSessionWarning")}
          confirmText={t("automation:deleteSession")}
          danger
          onCancel={() => setDeleteSessionId(null)}
          onConfirm={() => void removeSession(deleteSessionId)}
        />
      )}
    </div>
  );
}

export const MemoAiResearchWorkspace = memo(AiResearchWorkspace);
