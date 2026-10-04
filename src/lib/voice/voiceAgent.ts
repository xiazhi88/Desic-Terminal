/**
 * 「语音指挥」会话：把一句口述发给交互式 AI，并把流式回答交回给语音气泡。
 * 会话是一个普通的 AI 会话（标题固定为「语音指挥」），所以对话会完整记录在 AI 研究里。
 */
import { createAiSession, listenAiEvents, loadAiSession, sendAiMessage, stopAiMessage } from "../ai";
import { INITIAL_VOICE_AGENT_STATE, reduceVoiceAgentEvent, VOICE_AGENT_RULES, voiceReasoningDepth, type VoiceAgentEvent, type VoiceAgentState } from "./voiceAgentModel";

export const VOICE_SESSION_TITLE = "语音指挥";
const SESSION_KEY = "desic.voice.session.v1";
/** 让 AI 研究工作区切换到指定会话（「在 AI 研究中查看」用）。 */
export const OPEN_AI_SESSION_EVENT = "desic:open-ai-session";

let sessionPromise: Promise<string> | null = null;
let knownVoiceSessionId: string | null = null;

/** 当前语音会话 id（还没建立时为 null）。用来拒绝别的会话发来的界面指挥事件。 */
export function getVoiceSessionId(): string | null {
  return knownVoiceSessionId;
}
/** 上一轮还没结束的语音问答；新一轮开始时才需要打断它。 */
let activeRun: { stop: () => Promise<void> } | null = null;

async function createSession(): Promise<string> {
  const created = await createAiSession(VOICE_SESSION_TITLE);
  const id = created?.session.id;
  if (!id) throw new Error("无法创建语音会话，请确认 AI 模型已配置");
  try {
    window.localStorage.setItem(SESSION_KEY, id);
  } catch {
    // 本地存储不可用：本次会话内仍然可用。
  }
  return id;
}

/** 复用同一个语音会话；被用户删除后自动重建。 */
export function ensureVoiceSession(): Promise<string> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      let stored: string | null = null;
      try {
        stored = window.localStorage.getItem(SESSION_KEY);
      } catch {
        stored = null;
      }
      if (stored) {
        const snapshot = await loadAiSession(stored).catch(() => null);
        // 必须仍是「语音指挥」会话：记录的 id 若指向被改名 / 复用的普通会话，用户在 AI 研究里就找不到语音记录。
        if (snapshot?.session.id === stored && snapshot.session.title === VOICE_SESSION_TITLE) return stored;
      }
      return createSession();
    })().catch((error) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

export type VoiceAgentHandle = {
  sessionId: string;
  /** 回答结束（成功、失败或被取消）。 */
  finished: Promise<VoiceAgentState>;
  stop: () => Promise<void>;
};

export type AskVoiceAgentOptions = {
  text: string;
  accountId?: string;
  onUpdate: (state: VoiceAgentState) => void;
  /** 每次出现新的工具调用时回调（用于跳转到对应工作区）。 */
  onToolCall?: (name: string) => void;
};

/** 沙箱拒绝续用「策略 / 账户 / 权限 / 规则」已变化的旧会话时的报错。 */
function isStaleSessionError(message: string | null | undefined): boolean {
  return Boolean(message && /配置已变化|请创建新会话/.test(message));
}

async function startAttempt(options: AskVoiceAgentOptions, sessionId: string, canRetry: boolean): Promise<VoiceAgentHandle> {
  knownVoiceSessionId = sessionId;
  let state = INITIAL_VOICE_AGENT_STATE;
  let settle: (value: VoiceAgentState) => void = () => undefined;
  const finished = new Promise<VoiceAgentState>((resolve) => {
    settle = resolve;
  });
  const seenTools = new Set<string>();
  // `ai_stop` 不管会话是否在运行都会广播一个 done / cancelled。只有我们自己要求停止时才把它当作结果，
  // 否则（例如开始新一轮前顺手打断上一轮）会把刚发出的这一轮误判为已取消，气泡被静默收起。
  let stopRequested = false;
  const unlisten = await listenAiEvents((event) => {
    if (event.sessionId !== sessionId) return;
    const next = reduceVoiceAgentEvent(state, event as VoiceAgentEvent);
    if (next === state) return;
    if (next.status === "cancelled" && !stopRequested) return;
    // 会话配置变化的报错由外层换新会话重试，不让用户看到这条失败。
    if (canRetry && next.status === "failed" && isStaleSessionError(next.error)) {
      state = next;
      unlisten?.();
      if (activeRun === run) activeRun = null;
      settle(state);
      return;
    }
    for (const tool of next.tools) {
      if (!seenTools.has(tool.id)) {
        seenTools.add(tool.id);
        options.onToolCall?.(tool.name);
      }
    }
    state = next;
    options.onUpdate(state);
    if (state.status !== "running") {
      unlisten?.();
      if (activeRun === run) activeRun = null;
      settle(state);
    }
  });

  const stop = async () => {
    stopRequested = true;
    await stopAiMessage(sessionId).catch(() => undefined);
  };
  const run = { stop };
  try {
    // 上一轮语音问答还没结束时，直接打断它，避免排队。
    const previous = activeRun;
    activeRun = run;
    if (previous) await previous.stop();
    await sendAiMessage(sessionId, [{ id: `u-voice-${Date.now()}`, role: "user", content: options.text }], options.accountId, {
      permissionMode: "advisor",
      reasoningDepth: voiceReasoningDepth(options.text),
      extraRules: VOICE_AGENT_RULES,
      // 只有语音导演会话才被授予 ui.* 界面指挥工具；普通 AI 研究不会自动切合约 / 周期 / 工作区。
      uiControl: true,
    });
  } catch (error) {
    unlisten?.();
    if (activeRun === run) activeRun = null;
    state = { ...state, status: "failed", error: error instanceof Error ? error.message : String(error) };
    options.onUpdate(state);
    settle(state);
  }
  return { sessionId, finished, stop };
}

/**
 * 发送一句口述并返回流式句柄。旧语音会话的配置指纹与当前不一致（改过语音规则、切换过账户或权限）时，
 * 沙箱会拒绝续用它；这里自动换一个新的「语音指挥」会话重试一次。
 */
export async function askVoiceAgent(options: AskVoiceAgentOptions): Promise<VoiceAgentHandle> {
  let current = await startAttempt(options, await ensureVoiceSession(), true);
  const first = current;
  const finished = (async () => {
    const result = await first.finished;
    if (result.status !== "failed" || !isStaleSessionError(result.error)) return result;
    const freshId = await createSession();
    sessionPromise = Promise.resolve(freshId);
    current = await startAttempt(options, freshId, false);
    return current.finished;
  })();
  return {
    get sessionId() {
      return current.sessionId;
    },
    finished,
    stop: () => current.stop(),
  };
}
