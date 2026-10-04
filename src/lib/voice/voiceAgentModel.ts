/**
 * 「语音指挥」会话的纯逻辑：把 `ai:event` 流归约成气泡里要显示的状态，
 * 并把工具调用映射到应当展示的工作区。不依赖 React / Tauri，可直接用 node 测试。
 */
import type { DirectorSection } from "./directorCommands";

export type VoiceAgentTool = { id: string; name: string; status: "running" | "done" | "failed"; /** 调用对象（合约 / 周期等），用于步骤轨迹。 */ target: string | null };

export type VoiceEvidenceStance = "bull" | "bear" | "neutral" | "constraint";
export type VoiceEvidenceItem = { id: string; claim: string; stance: VoiceEvidenceStance; weight: number; sourceRefs: string[] };
export type VoiceDecision = { outcome: "long" | "short" | "abstain" | "hold"; reason: string; instId: string | null };
/** 证据来源：某个工具结果的编号（E1…）及其一句摘要。 */
export type VoiceEvidenceSource = { ref: string; tool: string; summary: string };

export type VoiceAgentState = {
  /** 气泡里显示的回答文字。 */
  text: string;
  /** 是否收到过 text-preview / text-final；之后不再追加零散的 `text` 旁白。 */
  sawPreview: boolean;
  tools: VoiceAgentTool[];
  /** 分析时由证据账本工具记录的证据（同 id 重新记录会覆盖，位置不变）。 */
  evidence: VoiceEvidenceItem[];
  decision: VoiceDecision | null;
  sources: Record<string, VoiceEvidenceSource>;
  status: "running" | "done" | "failed" | "cancelled";
  error: string | null;
};

export const INITIAL_VOICE_AGENT_STATE: VoiceAgentState = { text: "", sawPreview: false, tools: [], evidence: [], decision: null, sources: {}, status: "running", error: null };

/** 与 AiEvent 的结构兼容的最小子集，避免这里依赖整个 types.ts。 */
export type VoiceAgentEvent =
  | { type: "delta"; channel: string; content: string }
  | { type: "toolCall"; toolCallId?: string; name: string; arguments?: unknown; policy?: string; blocked?: boolean }
  | { type: "toolResult"; toolCallId?: string; name: string; result?: unknown; summary?: string; ok: boolean }
  | { type: "error"; message: string }
  | { type: "done"; finishReason?: string | null }
  | { type: string };

function asObject(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const isLedgerName = (name: string, canonical: string) => name === canonical || name === canonical.replaceAll(".", "_");

/** 调用对象：优先合约（去掉 -USDT-SWAP），其次周期。 */
export function toolTarget(args: unknown): string | null {
  const record = asObject(args);
  const inst = str(record.instId);
  if (inst) return inst.replace(/-USDT-SWAP$/i, "");
  return str(record.bar) ?? str(record.query) ?? null;
}

export function reduceVoiceAgentEvent(state: VoiceAgentState, event: VoiceAgentEvent): VoiceAgentState {
  if (state.status !== "running") return state;
  switch (event.type) {
    case "delta": {
      const { channel, content } = event as Extract<VoiceAgentEvent, { type: "delta" }>;
      if (channel === "text-preview" || channel === "text-final") return { ...state, text: content, sawPreview: true };
      if (channel === "text-preview-clear") return { ...state, text: "" };
      // 没有预览通道时才退回逐段追加；推理文字（reasoning*）一律不显示。
      if (channel === "text" && !state.sawPreview) return { ...state, text: state.text + content };
      return state;
    }
    case "toolCall": {
      const call = event as Extract<VoiceAgentEvent, { type: "toolCall" }>;
      // 内部转发事件不是用户可见的工具调用。
      if (call.policy === "rust:tool-execute-request") return state;
      const id = call.toolCallId ?? `${call.name}-${state.tools.length}`;
      if (state.tools.some((tool) => tool.id === id)) return state;
      return { ...state, tools: [...state.tools, { id, name: call.name, status: call.blocked ? "failed" : "running", target: toolTarget(call.arguments) }] };
    }
    case "toolResult": {
      const result = event as Extract<VoiceAgentEvent, { type: "toolResult" }>;
      const id = result.toolCallId;
      let next: VoiceAgentState = {
        ...state,
        tools: state.tools.map((tool) => ((id ? tool.id === id : tool.name === result.name && tool.status === "running") ? { ...tool, status: result.ok ? "done" : "failed" } : tool)),
      };
      if (!result.ok) return next;
      const record = asObject(result.result);
      if (isLedgerName(result.name, "research.recordEvidence")) {
        const items = Array.isArray(record.items) ? record.items : [];
        const merged = [...next.evidence];
        for (const raw of items) {
          const entry = asObject(raw);
          const entryId = str(entry.id);
          const claim = str(entry.claim);
          const stance = entry.stance;
          const weight = typeof entry.weight === "number" ? entry.weight : Number(entry.weight);
          if (!entryId || !claim || !(stance === "bull" || stance === "bear" || stance === "neutral" || stance === "constraint") || !Number.isFinite(weight)) continue;
          const sourceRefs = Array.isArray(entry.sourceRefs) ? entry.sourceRefs.map(str).filter((ref): ref is string => Boolean(ref)) : [];
          const item: VoiceEvidenceItem = { id: entryId, claim, stance, weight: Math.max(0, Math.min(3, weight)), sourceRefs };
          const at = merged.findIndex((existing) => existing.id === entryId);
          if (at >= 0) merged[at] = item;
          else merged.push(item);
        }
        next = { ...next, evidence: merged };
      } else if (isLedgerName(result.name, "research.recordDecision")) {
        const outcome = record.outcome;
        const reason = str(record.reason);
        if ((outcome === "long" || outcome === "short" || outcome === "abstain" || outcome === "hold") && reason) {
          next = { ...next, decision: { outcome, reason, instId: str(record.instId) } };
        }
      } else {
        const ref = str(record.evidenceRef);
        if (ref) {
          const summary = (result.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
          next = { ...next, sources: { ...next.sources, [ref]: { ref, tool: result.name, summary } } };
        }
      }
      return next;
    }
    case "error":
      return { ...state, status: "failed", error: (event as Extract<VoiceAgentEvent, { type: "error" }>).message || "AI 调用失败" };
    case "done": {
      const reason = (event as Extract<VoiceAgentEvent, { type: "done" }>).finishReason;
      if (reason === "cancelled") return { ...state, status: "cancelled" };
      if (reason === "error") return { ...state, status: "failed", error: state.error ?? "AI 调用失败" };
      return { ...state, status: "done" };
    }
    default:
      return state;
  }
}

/** 工具的中文 / 英文简称（用于步骤轨迹）。按名字的关键部分匹配，新增工具时不需要改这里也能有合理的回退。 */
export function toolLabel(name: string): [string, string] {
  const n = name.replaceAll("_", ".");
  const rules: [RegExp, [string, string]][] = [
    [/^research\.record/, ["整理证据", "Organising evidence"]],
    [/^research\.webSearch/, ["检索资料", "Searching the web"]],
    [/^market\.readTicker/, ["读取行情", "Reading the ticker"]],
    [/^market\.readCandles/, ["读取 K 线", "Reading candles"]],
    [/^market\.readIndicators/, ["计算指标", "Computing indicators"]],
    [/^market\.readOrderBook/, ["读取盘口", "Reading the order book"]],
    [/^market\.readRecentTrades/, ["读取成交", "Reading recent trades"]],
    [/^market\.readFundingRate/, ["读取资金费率", "Reading funding"]],
    [/^market\./, ["读取行情", "Reading market data"]],
    [/^account\.readPositions/, ["读取持仓", "Reading positions"]],
    [/^account\.readOpenOrders/, ["读取挂单", "Reading open orders"]],
    [/^account\.readRisk/, ["评估账户风险", "Checking account risk"]],
    [/^account\./, ["读取账户", "Reading the account"]],
    [/^radar\.readBreadth/, ["查看市场宽度", "Checking breadth"]],
    [/^radar\./, ["查看雷达", "Checking the radar"]],
    [/^intelligence\.news/, ["查看新闻", "Checking the news"]],
    [/^intelligence\.smartMoney\.readFundingBasis/, ["查看资金费与基差", "Checking funding and basis"]],
    [/^intelligence\.smartMoney\.readLiquidation/, ["查看爆仓", "Checking liquidations"]],
    [/^intelligence\./, ["查看市场情报", "Checking intelligence"]],
    [/^strategy\./, ["处理策略", "Working on strategy"]],
    [/^trade\./, ["测算方案", "Evaluating a plan"]],
    [/^ui\./, ["调整界面", "Adjusting the view"]],
  ];
  return rules.find(([pattern]) => pattern.test(n))?.[1] ?? ["调用工具", "Using a tool"];
}

/** 分析类问题需要更深的思考；普通查询保持低延迟。 */
export function voiceReasoningDepth(transcript: string): "low" | "medium" {
  return /分析|怎么看|怎么样|该不该|要不要|能不能|值不值|是否|多头|空头|趋势|支撑|压力|风险|机会|对比|比较|原因|为什么|策略|建议|how is|should|why|analy[sz]e|compare|risk|trend|support|resistance/i.test(transcript) ? "medium" : "low";
}

/**
 * 只有「对应着专门工作区」的工具才会让界面跳转；行情 / 账户这类读取不跳，
 * 答案直接以文字出现在气泡里。`ui.*` 由界面执行器自己处理，这里不重复映射。
 */
export function workspaceForTool(name: string): DirectorSection | null {
  if (name.startsWith("radar.")) return "radar";
  if (name.startsWith("intelligence.")) return "intelligence";
  if (name.startsWith("strategy.")) return "systematic";
  if (name.startsWith("tradeOpportunity.")) return "opportunities";
  return null;
}

const NOISE_WORDS = new Set([
  "okay", "ok", "uh", "um", "hmm", "mm", "yeah", "yes", "no", "you", "thank you", "thanks", "bye", "the", "so", "and", "hello", "hi",
  "嗯", "啊", "呃", "哦", "噢", "额", "唉", "哈", "呵", "好", "好的", "谢谢", "喂", "你好",
]);

/** 静音或环境噪声时识别引擎常吐出的口头禅 / 单字，不应当交给任何人处理。 */
export function isLikelyNoise(transcript: string): boolean {
  const cleaned = transcript.normalize("NFKC").toLowerCase().replace(/[\s.,!?;:，。！？；：、"'“”‘’()（）\-_]+/g, " ").trim();
  if (!cleaned) return true;
  if (NOISE_WORDS.has(cleaned)) return true;
  const compact = cleaned.replace(/\s+/g, "");
  return /^[\p{Script=Han}]$/u.test(compact) || /^[a-z]$/.test(compact);
}

/** 语音指挥会话的附加规则：简短、优先用界面工具展示；分析类问题多步取证并记录证据卡片。 */
export const VOICE_AGENT_RULES =
  "【语音指挥会话】用户在语音入口里听和看气泡，不读长文，像当面说话一样先说结论。回答用纯文本：不要用 Markdown（不加粗、不用标题、不列清单、不用代码格式）。普通问题不超过 3 句。" +
  "分析类问题（行情怎么样、该不该做多、某币强不强、对比……）按多步取证：先用工具取 2–4 项相关证据（行情、指标、资金费率、持仓量、雷达、情报按需选择），" +
  "每取到 2 项就调用 research.recordEvidence 记录（claim 一句话、不超过 40 字的可核对事实，stance 取 bull/bear/neutral/constraint，weight 0–3，sourceRefs 只能引用本轮真实出现的 evidenceRef，总共不超过 4 条）；" +
  "最后调用 research.recordDecision（long/short/abstain/hold 加一句不超过 40 字的理由），再用不超过 2 句、总共不超过 80 字的话收尾：只说结论和下一步看什么，证据卡片里已经有的数字不要重复。" +
  "需要让用户看到某个合约、周期、指标或工作区时，直接调用 ui.* 工具展示并用一句话说明。" +
  "不要用 chart.*、alert.*、script.*、strategy.* 修改任何东西，除非用户明确要求；不要发送通知；不能下单，涉及交易就说明语音不能下单，让用户在下单面板操作。";

/** 把模型回答整理成适合气泡的纯文本：去掉 Markdown 标记，换行并成空格。 */
export function plainSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*•]|\d+[.、)])\s+/gm, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)\*(?=$|[^*\w])/g, "$1$2")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** 取开头的一两句作为「先说结论」，其余折叠；`max` 是首屏最多显示的字数。 */
export function splitLead(plain: string, max = 90): { lead: string; rest: string } {
  const sentences = plain.split(/(?<=[。！？!?；;])\s*|(?<=[.])\s+/).filter((item) => item.length > 0);
  if (sentences.length === 0) return { lead: "", rest: "" };
  let lead = sentences[0];
  let used = 1;
  while (used < sentences.length && lead.length + sentences[used].length <= max) {
    lead += sentences[used];
    used += 1;
  }
  return { lead, rest: sentences.slice(used).join("") };
}

/** 证据卡在舞台上的停留时长：字越多停得越久。 */
export function cardHoldMs(text: string): number {
  return Math.min(4200, Math.max(2200, 1500 + text.length * 70));
}

/** 整个证据编排播完需要的时间（用于决定气泡留多久）。 */
export function stagePlanMs(items: readonly { claim: string }[], decision: { reason: string } | null): number {
  return items.reduce((sum, item) => sum + cardHoldMs(item.claim), 0) + (decision ? cardHoldMs(decision.reason) : 0);
}
