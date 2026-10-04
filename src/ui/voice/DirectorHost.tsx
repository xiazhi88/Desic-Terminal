import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { logger } from "../../lib/logger";
import { listenOptional } from "../../lib/tauri";
import { parseDirectorCommand, type DirectorAction, type DirectorCatalog } from "../../lib/voice/directorCommands";
import { runDirectorActions, type DirectorController, type DirectorStepStatus } from "../../lib/voice/directorExecutor";
import { startRecording, VoiceCaptureError, type RecorderHandle } from "../../lib/voice/recorder";
import { createVoiceStream, loadVoiceConfig, transcribeVoice, type VoiceStream } from "../../lib/voice/voiceApi";
import { askVoiceAgent, getVoiceSessionId, type VoiceAgentHandle } from "../../lib/voice/voiceAgent";
import { isLikelyNoise, stagePlanMs, workspaceForTool } from "../../lib/voice/voiceAgentModel";
import { applyCorrections, learnCorrection } from "../../lib/voice/lexicon";
import { addLexiconEntry, readLexicon } from "../../lib/voice/lexiconStore";
import type { VoicePreference } from "../../lib/voice/voicePreference";
import { DirectorBar, describeDirectorAction } from "./DirectorBar";
import { AiActionOverlay, type AiOperation } from "./AiActionOverlay";
import { IDLE_VIEW, type DirectorNotice, type DirectorView } from "./directorView";
import { parseUiActionEvent, type AiUiActionEventPayload } from "../../lib/voice/uiToolActions";
import { useHoldToTalk } from "./useHoldToTalk";
import "./director.css";

/** 录音短于这个时长视为误触，不去转写。 */
const MIN_RECORDING_MS = 500;
const MAX_RECORDING_MS = 30_000;
const NOTICE_MS = 6_000;
const UNDO_DEPTH = 10;
export const AI_UI_ACTION_EVENT = "ai:ui-action";
/** AI 改界面前先亮起提示的时间，让用户来得及看到。 */
const AI_LEAD_MS = 600;
/** 改完后提示保留的时间。 */
const AI_DONE_HOLD_MS = 3200;

type Props = {
  preference: VoicePreference;
  controller: DirectorController;
  catalog: DirectorCatalog;
  /** 提示转写服务的常见词（品种、术语）。 */
  hints: readonly string[];
  /** 命令面板、引导等占用键盘或界面的时候暂停。 */
  paused: boolean;
  /** 当前交易账户；语音指挥回答时用于读取账户相关证据。 */
  accountId?: string;
  uiText: (chinese: string, english: string) => string;
  /** 打开 AI 研究（语音指挥的完整对话记录在那里）。 */
  /** 打开 AI 研究；带 sessionId 时直接定位到这次语音会话。 */
  onOpenAiResearch: (sessionId?: string) => void;
  onOpenVoiceSettings: () => void;
};

type UndoGroup = { undo: () => void; label: string };

type ConfirmResult = "go" | "cancel" | "edit";

/** 一步动作完成后，伙伴射出像素飞向的界面位置。 */
function spotlightSelector(action: DirectorAction): string {
  switch (action.type) {
    case "workspace":
      return `[data-workspace="${action.section === "config" ? "settings" : action.section}"]`;
    case "instrument":
      return ".topbar .market-title__trigger";
    case "timeframe":
      return ".chart-toolbar .periods";
    case "orderFlow":
      return ".chart-orderflow-toggle";
    default:
      return ".chart-stage";
  }
}

/** 音量变化很频繁，放进独立存储，只让音波组件重绘，不拖累整个应用。 */
function createLevelStore() {
  let value = 0;
  const listeners = new Set<() => void>();
  let last = 0;
  return {
    get: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push: (next: number) => {
      const now = performance.now();
      if (now - last < 50) return;
      last = now;
      value = next;
      listeners.forEach((listener) => listener());
    },
    reset: () => {
      value = 0;
      listeners.forEach((listener) => listener());
    },
  };
}

export function DirectorHost({ preference, controller, catalog, hints, paused, accountId, uiText, onOpenAiResearch, onOpenVoiceSettings }: Props) {
  const [view, setView] = useState<DirectorView>(IDLE_VIEW);
  const [aiOp, setAiOp] = useState<AiOperation | null>(null);
  const aiQueueRef = useRef<Promise<void>>(Promise.resolve());
  const aiHideRef = useRef(0);
  const aiOpRef = useRef<AiOperation | null>(null);
  aiOpRef.current = aiOp;
  const levelStore = useMemo(createLevelStore, []);
  const viewRef = useRef(view);
  viewRef.current = view;
  const sessionRef = useRef(0);
  const recorderRef = useRef<RecorderHandle | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const agentRef = useRef<VoiceAgentHandle | null>(null);
  /** 本机流式识别：说话的同时逐字出字；云端识别时为 null。 */
  const streamRef = useRef<{ stream: VoiceStream; pushed: number } | null>(null);
  const confirmRef = useRef<((result: ConfirmResult) => void) | null>(null);
  const editRef = useRef<((value: string | null) => void) | null>(null);
  const noticeTimerRef = useRef(0);
  const undoStackRef = useRef<UndoGroup[]>([]);
  const spotlightIdRef = useRef(0);
  /** 组件是否仍挂载。热更新 / StrictMode 会重跑 effect 的清理，但那不是真卸载，不能因此取消进行中的会话。 */
  const aliveRef = useRef(true);
  const pointerRef = useRef({ downAt: 0, tap: false, active: false });
  const latest = useRef({ controller, catalog, hints, uiText, onOpenAiResearch, onOpenVoiceSettings, accountId, confirmMs: preference.confirmMs });
  latest.current = { controller, catalog, hints, uiText, onOpenAiResearch, onOpenVoiceSettings, accountId, confirmMs: preference.confirmMs };

  const patch = useCallback((next: Partial<DirectorView>) => setView((current) => ({ ...current, ...next })), []);
  const syncUndo = useCallback(() => patch({ canUndo: undoStackRef.current.length > 0 }), [patch]);

  const clearNoticeTimer = () => window.clearTimeout(noticeTimerRef.current);
  const showNotice = useCallback((notice: DirectorNotice, options: { keepSteps?: boolean; keepAgent?: boolean; ms?: number } = {}) => {
    clearNoticeTimer();
    setView((current) => ({
      ...current,
      phase: "notice",
      notice,
      pending: null,
      countdown: null,
      partial: null,
      steps: options.keepSteps ? current.steps : [],
      agent: options.keepAgent ? current.agent : null,
      canUndo: undoStackRef.current.length > 0,
    }));
    noticeTimerRef.current = window.setTimeout(() => setView((current) => (current.phase === "notice" ? { ...IDLE_VIEW, canUndo: current.canUndo } : current)), options.ms ?? NOTICE_MS);
  }, []);

  const goIdle = useCallback(() => {
    clearNoticeTimer();
    levelStore.reset();
    setView({ ...IDLE_VIEW, canUndo: undoStackRef.current.length > 0 });
  }, [levelStore]);

  const undoLast = useCallback(() => {
    const group = undoStackRef.current.pop();
    if (!group) {
      showNotice({ tone: "info", text: latest.current.uiText("没有可以撤销的操作", "Nothing to undo") });
      return;
    }
    group.undo();
    showNotice({ tone: "ok", text: latest.current.uiText(`已撤销：${group.label}`, `Undone: ${group.label}`) });
  }, [showNotice]);

  const runActions = useCallback(async (actions: readonly DirectorAction[], options: { label: string; transcript: string | null; source: "voice" | "ai"; announce: boolean }) => {
    const { uiText: text } = latest.current;
    const abort = new AbortController();
    abortRef.current = abort;
    if (options.announce) {
      clearNoticeTimer();
      setView((current) => ({
        ...current,
        phase: "executing",
        transcript: options.transcript,
        partial: null,
        source: options.source,
        notice: null,
        pending: null,
        countdown: null,
        steps: actions.map((action) => ({ action, status: "pending" as DirectorStepStatus })),
      }));
    }
    const result = await runDirectorActions(actions, latest.current.controller, {
      signal: abort.signal,
      onStep: (index, status) => {
        const spotlight = status === "done" ? { id: ++spotlightIdRef.current, selector: spotlightSelector(actions[index]) } : null;
        setView((current) => ({
          ...current,
          steps: options.announce ? current.steps.map((step, position) => (position === index ? { ...step, status } : step)) : current.steps,
          spotlight: spotlight ?? current.spotlight,
        }));
      },
    });
    if (abortRef.current === abort) abortRef.current = null;
    if (result.changed) {
      undoStackRef.current.push({ undo: result.undo, label: options.label });
      if (undoStackRef.current.length > UNDO_DEPTH) undoStackRef.current.shift();
    }
    if (!options.announce) {
      syncUndo();
      return result;
    }
    const cancelled = result.statuses.some((status) => status === "cancelled");
    showNotice(
      cancelled
        ? { tone: "info", undoable: result.changed, text: text("已停止，已执行的步骤可以撤销", "Stopped. Completed steps can be undone") }
        : result.changed
          ? { tone: "ok", undoable: true, text: options.source === "ai" ? text("AI 已调整界面", "AI adjusted the view") : text("已完成", "Done") }
          : { tone: "info", text: text("界面已经是这样了，没有改动", "Already like that. Nothing changed") },
      { keepSteps: true },
    );
    return result;
  }, [showNotice, syncUndo]);

  const failWith = useCallback((message: string, setup = false) => {
    showNotice({
      tone: "error",
      text: message,
      action: setup ? { label: latest.current.uiText("去设置", "Open settings"), run: () => latest.current.onOpenVoiceSettings() } : undefined,
    });
  }, [showNotice]);

  /** 说完后的停顿：给用户核对识别文字的时间。Esc 取消、Enter 立即执行、Tab 改字。 */
  const waitConfirm = useCallback((ms: number) => new Promise<ConfirmResult>((resolve) => {
    if (ms <= 0) {
      resolve("go");
      return;
    }
    const timer = window.setTimeout(() => finish("go"), ms);
    function finish(result: ConfirmResult) {
      window.clearTimeout(timer);
      if (confirmRef.current === finish) confirmRef.current = null;
      resolve(result);
    }
    confirmRef.current = finish;
  }), []);

  /** 让用户改识别文字；返回改后的文字，取消时返回 null。 */
  const waitEdit = useCallback((initial: string) => new Promise<string | null>((resolve) => {
    setView((current) => ({ ...current, phase: "editing", draft: initial, pending: null, countdown: null }));
    editRef.current = (value) => {
      editRef.current = null;
      resolve(value);
    };
  }), []);

  const askAgent = useCallback(async (text: string, session: number) => {
    const t = latest.current.uiText;
    clearNoticeTimer();
    setView((current) => ({ ...current, phase: "answering", transcript: text, partial: null, source: "ai", notice: null, pending: null, countdown: null, steps: [], agent: { text: "", tools: [], evidence: [], decision: null, sources: {}, status: "running" } }));
    let handle: VoiceAgentHandle;
    try {
      handle = await askVoiceAgent({
        text,
        accountId: latest.current.accountId,
        onUpdate: (state) => {
          if (sessionRef.current !== session) return;
          setView((current) => (current.phase === "answering" ? { ...current, agent: { text: state.text, tools: state.tools, evidence: state.evidence, decision: state.decision, sources: state.sources, status: state.status } } : current));
        },
        // 涉及专门工作区的工具才让界面跳过去；行情 / 账户读取只在气泡里回答。
        onToolCall: (name) => {
          if (sessionRef.current !== session) return;
          const section = workspaceForTool(name);
          if (section && latest.current.controller.snapshot().section !== section) latest.current.controller.setSection(section);
        },
      });
    } catch (error) {
      if (sessionRef.current !== session) return;
      failWith(error instanceof Error ? error.message : t("语音指挥暂时不可用", "Voice assistant is unavailable"), true);
      return;
    }
    if (sessionRef.current !== session) {
      void handle.stop();
      return;
    }
    agentRef.current = handle;
    const final = await handle.finished;
    if (agentRef.current === handle) agentRef.current = null;
    if (sessionRef.current !== session) return;
    if (final.status === "cancelled") {
      goIdle();
      return;
    }
    if (final.status === "failed") {
      failWith(final.error ?? t("AI 调用失败", "AI request failed"), /模型|API Key|未配置|没有可用/.test(final.error ?? ""));
      return;
    }
    // 回答越长、卡片越多，停留越久；用户随时可以点 × 关闭。
    const hasCards = final.evidence.length > 0 || final.decision !== null;
    const plan = stagePlanMs(final.evidence, final.decision);
    const ms = Math.min(hasCards ? 70_000 : 20_000, Math.max(hasCards ? 20_000 : NOTICE_MS, Math.min(final.text.length, 90) * 90 + (hasCards ? plan + 10_000 : 0)));
    showNotice(
      { tone: "ok", text: final.text || t("好的", "Done"), transcript: text, action: { label: t("在 AI 研究中查看", "Open in AI Research"), run: () => latest.current.onOpenAiResearch(handle.sessionId) } },
      { keepAgent: true, ms },
    );
  }, [failWith, goIdle, showNotice]);

  /** 解析一句话并（经过停顿后）执行。`skipPause` 用于用户刚亲手改过的文字：不需要再等一次。 */
  const processSentence = useCallback(async (text: string, heard: string | null, session: number, skipPause: boolean) => {
    const { catalog: currentCatalog, uiText: t } = latest.current;
    const parsed = parseDirectorCommand(text, currentCatalog);
    if (parsed.kind === "undo") {
      patch({ transcript: text, partial: null });
      undoLast();
      return;
    }
    if (parsed.kind === "trade-refused") {
      showNotice({ tone: "warn", transcript: text, text: t("语音不会直接下单。需要交易请在下单面板操作，或用文字向 AI 提问。", "Voice never places orders. Use the order ticket, or ask AI in text.") });
      return;
    }
    // 停顿：先展示识别文字与将要做的事，用户有机会按 Esc 阻止、按 Tab 改字。
    const pending: DirectorAction[] | "ask-ai" = parsed.kind === "actions" ? parsed.actions : "ask-ai";
    const ms = skipPause ? 0 : latest.current.confirmMs;
    if (ms > 0) {
      setView((current) => ({ ...current, phase: "confirming", transcript: text, heard, draft: null, partial: null, pending, countdown: { startedAt: performance.now(), durationMs: ms }, notice: null, steps: [], agent: null }));
      const result = await waitConfirm(ms);
      if (sessionRef.current !== session) {
        logger.warn("voice confirm abandoned: session superseded", { session, current: sessionRef.current, result, phase: viewRef.current.phase });
        // 会话被新的操作取代时，如果界面还停在这次的确认态，要主动收起，不能留一个永远不动的气泡。
        if (viewRef.current.phase === "confirming") goIdle();
        return;
      }
      logger.info("voice confirm finished", { result, pending: pending === "ask-ai" ? "ask-ai" : pending.length });
      if (result === "cancel") {
        showNotice({ tone: "info", transcript: text, text: t("已取消", "Cancelled") });
        return;
      }
      if (result === "edit") {
        const edited = await waitEdit(text);
        if (sessionRef.current !== session) return;
        if (edited === null || !edited.trim()) {
          showNotice({ tone: "info", transcript: text, text: t("已取消", "Cancelled") });
          return;
        }
        // 从「引擎听到的 → 用户改成的」学出一条纠错，下次同样的错就自动修正。
        const learned = learnCorrection(heard ?? text, edited);
        if (learned) addLexiconEntry(learned);
        patch({ learned: learned ? `${learned.from} → ${learned.to}` : null });
        await processSentence(edited.trim(), null, session, true);
        return;
      }
    }
    if (pending === "ask-ai") await askAgent(text, session);
    else await runActions(pending, { label: text, transcript: text, source: "voice", announce: true });
  }, [askAgent, goIdle, patch, runActions, showNotice, undoLast, waitConfirm, waitEdit]);

  const handleTranscript = useCallback(async (raw: string, session: number) => {
    if (sessionRef.current !== session) return;
    const { uiText: t } = latest.current;
    if (isLikelyNoise(raw)) {
      showNotice({ tone: "info", transcript: raw, text: t("没听清，请再说一遍", "Didn't catch that. Please try again") });
      return;
    }
    // 先按纠错词表修正引擎常见的误识别，再解析。
    const fixed = applyCorrections(raw, readLexicon());
    await processSentence(fixed.text, fixed.changes.length > 0 ? raw : null, session, false);
  }, [processSentence, showNotice]);

  const finish = useCallback(async (session: number) => {
    const handle = recorderRef.current;
    recorderRef.current = null;
    if (!handle || sessionRef.current !== session) return;
    const { uiText: t, hints: currentHints } = latest.current;
    const live = streamRef.current;
    streamRef.current = null;
    patch({ phase: "transcribing" });
    levelStore.reset();
    try {
      const audio = await handle.stop();
      if (sessionRef.current !== session) {
        live?.stream.cancel();
        return;
      }
      if (audio.durationMs < MIN_RECORDING_MS) {
        live?.stream.cancel();
        showNotice({ tone: "info", text: t("说话时间太短，请按住按键说完再松开", "Too short. Hold the key while you speak") });
        return;
      }
      let text: string;
      if (live) {
        if (live.pushed === 0) {
          live.stream.cancel();
          throw new Error(t("当前环境无法为本机识别采集音频，请改用云端服务", "Audio capture for local recognition is unavailable here. Use a cloud service instead"));
        }
        text = await live.stream.finish();
      } else {
        text = (await transcribeVoice({ blob: audio.blob, mime: audio.mime, wav: audio.wav, hints: currentHints })).text;
      }
      await handleTranscript(text, session);
    } catch (error) {
      if (sessionRef.current !== session) return;
      const message = error instanceof Error ? error.message : String(error);
      failWith(message, /尚未选择|尚未配置|尚未下载|尚未安装|暂不支持本机|API Key|不提供语音转写|不是 OpenAI/.test(message));
    }
  }, [failWith, handleTranscript, levelStore, patch, showNotice]);

  const begin = useCallback(async () => {
    const phase = viewRef.current.phase;
    if (phase === "arming" || phase === "listening" || phase === "transcribing" || phase === "executing" || phase === "confirming" || phase === "editing" || phase === "answering") return;
    const session = ++sessionRef.current;
    clearNoticeTimer();
    setView((current) => ({ ...IDLE_VIEW, phase: "arming", canUndo: current.canUndo }));
    let live: { stream: VoiceStream; pushed: number } | null = null;
    try {
      // 选了本机识别就走流式：边说边出字，松开后只需补最后一小段。
      const config = await loadVoiceConfig().catch(() => null);
      if (sessionRef.current !== session) return;
      if (config?.source === "local" && config.ready) {
        const entry: { stream: VoiceStream; pushed: number } = {
          stream: createVoiceStream((partial) => {
            if (sessionRef.current === session) patch({ partial });
          }),
          pushed: 0,
        };
        live = entry;
      }
      const handle = await startRecording({
        maxMs: MAX_RECORDING_MS,
        onLevel: levelStore.push,
        onAutoStop: () => void finish(session),
        onPcm16k: live
          ? (chunk) => {
              if (!live) return;
              live.pushed += 1;
              live.stream.push(chunk);
            }
          : undefined,
      });
      // 权限弹窗期间用户已经松手或按了 Esc：丢弃这次录音。
      if (sessionRef.current !== session) {
        live?.stream.cancel();
        handle.cancel();
        return;
      }
      streamRef.current = live;
      recorderRef.current = handle;
      patch({ phase: "listening" });
    } catch (error) {
      live?.stream.cancel();
      if (sessionRef.current !== session) return;
      const t = latest.current.uiText;
      if (error instanceof VoiceCaptureError && error.code === "permission-denied") {
        failWith(t("麦克风权限被拒绝。请在系统设置 → 隐私与安全性 → 麦克风中允许 Desic Terminal，然后重启应用。", "Microphone access was denied. Allow Desic Terminal under System Settings → Privacy & Security → Microphone, then restart."));
      } else if (error instanceof VoiceCaptureError && error.code === "no-device") {
        failWith(t("没有找到可用的麦克风", "No microphone found"));
      } else if (error instanceof VoiceCaptureError && error.code === "unsupported") {
        failWith(t("当前环境不支持录音", "Recording is not supported here"));
      } else {
        failWith(error instanceof Error ? error.message : t("无法开始录音", "Could not start recording"));
      }
    }
  }, [failWith, finish, levelStore, patch]);

  const end = useCallback(() => {
    const phase = viewRef.current.phase;
    if (phase === "arming") {
      // 还在等权限或麦克风：松手等于放弃这次。
      sessionRef.current += 1;
      goIdle();
      return;
    }
    if (phase === "listening") void finish(sessionRef.current);
  }, [finish, goIdle]);

  /** 强制终止当前的一切：录音、停顿确认、动作执行、语音指挥回答。 */
  const cancelAll = useCallback(() => {
    sessionRef.current += 1;
    recorderRef.current?.cancel();
    recorderRef.current = null;
    streamRef.current?.stream.cancel();
    streamRef.current = null;
    abortRef.current?.abort();
    confirmRef.current?.("cancel");
    editRef.current?.(null);
    const agent = agentRef.current;
    agentRef.current = null;
    if (agent) void agent.stop();
    goIdle();
  }, [goIdle]);

  // 在伙伴本体上按住说话；轻点 = 开始，再点一次 = 发送
  const pointerStart = useCallback(() => {
    const phase = viewRef.current.phase;
    const pointer = pointerRef.current;
    if ((phase === "listening" || phase === "arming") && pointer.tap) {
      pointer.tap = false;
      end();
      return;
    }
    if (phase !== "idle" && phase !== "notice") return;
    pointerRef.current = { downAt: performance.now(), tap: false, active: true };
    void begin();
  }, [begin, end]);
  const pointerEnd = useCallback(() => {
    const pointer = pointerRef.current;
    if (!pointer.active) return;
    pointer.active = false;
    if (performance.now() - pointer.downAt < 260) {
      pointer.tap = true;
      return;
    }
    end();
  }, [end]);
  useEffect(() => {
    window.addEventListener("pointerup", pointerEnd);
    window.addEventListener("pointercancel", pointerEnd);
    return () => {
      window.removeEventListener("pointerup", pointerEnd);
      window.removeEventListener("pointercancel", pointerEnd);
    };
  }, [pointerEnd]);

  // 按住说话
  useHoldToTalk({ code: preference.holdKey, enabled: preference.enabled, paused, onStart: begin, onEnd: end, onCancel: cancelAll });

  // Esc：任何阶段都能强制停止；Enter：在停顿确认期立即执行
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const phase = viewRef.current.phase;
      if (phase === "confirming" && (event.key === "Enter" || event.key === "Tab")) {
        event.preventDefault();
        confirmRef.current?.(event.key === "Enter" ? "go" : "edit");
        return;
      }
      if (event.key !== "Escape") return;
      if (aiOpRef.current) setAiOp(null);
      if (phase === "idle" || phase === "notice") return;
      event.preventDefault();
      // 停顿确认 / 改字：只取消这一次，由识别流程给出「已取消」的反馈。
      if (phase === "confirming") confirmRef.current?.("cancel");
      else if (phase === "editing") editRef.current?.(null);
      else if (phase === "executing") abortRef.current?.abort();
      else cancelAll();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [cancelAll]);

  // AI 通过 ui.* 工具下发的界面动作：与语音共用同一个执行器，因此同样带步骤展示和撤销。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenOptional<AiUiActionEventPayload>(AI_UI_ACTION_EVENT, (payload) => {
      // 只有语音导演会话能指挥界面；别的会话（例如 AI 研究）发来的事件一律忽略。
      if (!payload?.sessionId || payload.sessionId !== getVoiceSessionId()) return;
      const actions = parseUiActionEvent(payload, latest.current.catalog);
      if (!actions) return;
      // AI 改界面一律走全屏提示（与语音伙伴是否开启无关）：先亮起流光让用户看到「AI 在动手」，再执行，
      // 多条动作串行，避免互相打断。执行器本身仍带撤销与元素闪框。
      const text = latest.current.uiText;
      const label = actions.map((action) => describeDirectorAction(action, text)).join(" · ");
      aiQueueRef.current = aiQueueRef.current
        .then(async () => {
          window.clearTimeout(aiHideRef.current);
          setAiOp({ phase: "running", label, changed: false, canUndo: false });
          await new Promise((resolve) => window.setTimeout(resolve, AI_LEAD_MS));
          const result = await runActions(actions, { label: text("AI 的界面操作", "AI view change"), transcript: null, source: "ai", announce: false });
          setAiOp({ phase: "done", label, changed: Boolean(result?.changed), canUndo: undoStackRef.current.length > 0 });
          aiHideRef.current = window.setTimeout(() => setAiOp(null), AI_DONE_HOLD_MS);
        })
        .catch((error) => logger.warn("ai ui action failed", { error: error instanceof Error ? error.message : String(error) }));
    }).then((dispose) => {
      if (disposed) dispose?.();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [runActions]);

  // 真正卸载时才释放麦克风；热更新 / StrictMode 重跑 effect 时 aliveRef 会立刻被置回 true。
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      window.setTimeout(() => {
        if (aliveRef.current) return;
        sessionRef.current += 1;
        recorderRef.current?.cancel();
        streamRef.current?.stream.cancel();
        abortRef.current?.abort();
        clearNoticeTimer();
        window.clearTimeout(aiHideRef.current);
      }, 0);
    };
  }, []);
  useEffect(() => {
    if (!preference.enabled) cancelAll();
  }, [cancelAll, preference.enabled]);

  return (
    <>
    <AiActionOverlay operation={aiOp} uiText={uiText} onUndo={() => { undoLast(); setAiOp(null); }} onDismiss={() => setAiOp(null)} />
    <DirectorBar
      view={view}
      levelStore={levelStore}
      uiText={uiText}
      holdKey={preference.holdKey}
      enabled={preference.enabled}
      palette={preference.palette}
      side={preference.side}
      peek={preference.peek}
      paused={paused}
      onEdit={() => confirmRef.current?.("edit")}
      onSubmitEdit={(value) => editRef.current?.(value)}
      onPointerStart={pointerStart}
      onPointerEnd={pointerEnd}
      onUndo={undoLast}
      onStop={() => abortRef.current?.abort()}
      onCancel={cancelAll}
      onDismiss={goIdle}
    />
    </>
  );
}
