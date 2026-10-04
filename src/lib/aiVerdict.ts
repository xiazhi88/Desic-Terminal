/**
 * AI 研究回答顶部「结论卡」的数据：只从本轮真实的工具调用里取——
 * `tradeOpportunity.create`（入场 / 止损 / 止盈 / 张数 / 杠杆 / 有效期 / 把握度 / 机会编号）与
 * `research.recordDecision`（倾向与理由）。没有这两类调用的普通问答不出结论卡，也不凭正文猜数字。
 * 不依赖 React，可直接用 node 测试。
 */
export type VerdictTool = { name: string; arguments?: unknown; result?: unknown; status?: string; ok?: boolean; blocked?: boolean };

export type VerdictOutcome = "long" | "short" | "abstain" | "hold";

export type Verdict = {
  outcome: VerdictOutcome;
  instId: string | null;
  /** 一句话：优先用机会名，否则取决策理由的第一句。 */
  headline: string;
  entry: number | null;
  stop: number | null;
  target: number | null;
  /** 毛盈亏比（不含手续费与滑点），由入场 / 止损 / 止盈算出。 */
  rewardRisk: number | null;
  size: number | null;
  leverage: number | null;
  expiresAt: number | null;
  /** 0–1。 */
  confidence: number | null;
  opportunityId: string | null;
  /** 机会是否已保存为待审批（有 id 即认为已保存）。 */
  hasOpportunity: boolean;
};

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

const num = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const trigger = (value: unknown): number | null => num(record(value)?.triggerPx);

/** 取第一句（到句号 / 分号 / 换行）；过长时优先在最后一个逗号 / 顿号处断开，没有再硬截断，避免停在括号或单词中间。 */
export function firstSentence(text: string, max = 96): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const match = clean.match(/^.*?[。！？；;!?]/);
  const sentence = (match ? match[0] : clean).replace(/[；;]$/, "");
  if (sentence.length <= max) return sentence;
  const head = sentence.slice(0, max - 1);
  // 括号没闭合就继续往前退到括号之前，避免 "(crypto 82.9% …" 这种半截。
  const open = Math.max(head.lastIndexOf("("), head.lastIndexOf("（"));
  const close = Math.max(head.lastIndexOf(")"), head.lastIndexOf("）"));
  const safe = open > close ? head.slice(0, open) : head;
  const cut = Math.max(safe.lastIndexOf("，"), safe.lastIndexOf(","), safe.lastIndexOf("、"));
  const base = cut >= max * 0.45 ? safe.slice(0, cut) : safe;
  return `${base.trimEnd()}…`;
}

const succeeded = (tool: VerdictTool) => tool.ok !== false && tool.status !== "failed" && tool.status !== "blocked" && !tool.blocked && tool.result !== undefined;

export function buildVerdict(tools: readonly VerdictTool[]): Verdict | null {
  let opportunity: VerdictTool | null = null;
  let decision: VerdictTool | null = null;
  for (const tool of tools) {
    if (!succeeded(tool)) continue;
    if (tool.name === "tradeOpportunity.create") opportunity = tool;
    else if (tool.name === "research.recordDecision") decision = tool;
  }
  if (!opportunity && !decision) return null;

  const args = record(opportunity?.arguments) ?? {};
  const out = record(opportunity?.result) ?? {};
  const decisionOut = record(decision?.result) ?? record(decision?.arguments) ?? {};

  const direction = String(args.direction ?? out.direction ?? out.action ?? "").toLowerCase();
  const decided = String(decisionOut.outcome ?? "").toLowerCase();
  const outcome: VerdictOutcome =
    decided === "long" || decided === "short" || decided === "abstain" || decided === "hold"
      ? decided
      : direction === "long" || direction === "short"
        ? direction
        : "abstain";

  const entry = num(args.price) ?? num(out.price) ?? num(out.entryPrice);
  const stop = trigger(args.stopLoss) ?? trigger(out.stopLoss) ?? num(args.invalidationPrice);
  const target = trigger(args.takeProfit) ?? trigger(out.takeProfit);
  let rewardRisk: number | null = null;
  if (entry !== null && stop !== null && target !== null) {
    const risk = Math.abs(entry - stop);
    const reward = Math.abs(target - entry);
    if (risk > 0) rewardRisk = reward / risk;
  }
  const reason = typeof decisionOut.reason === "string" ? decisionOut.reason : typeof args.reason === "string" ? args.reason : "";
  const name = typeof args.strategyName === "string" ? args.strategyName.trim() : "";
  const id = typeof out.id === "string" && out.id ? out.id : null;
  const confidence = num(args.confidence) ?? num(out.confidence);

  return {
    outcome,
    instId: (typeof decisionOut.instId === "string" && decisionOut.instId) || (typeof args.instId === "string" && args.instId) || (typeof out.instId === "string" && out.instId) || null,
    headline: name || firstSentence(reason),
    entry,
    stop,
    target,
    rewardRisk,
    size: num(args.size) ?? num(out.size),
    leverage: num(args.lever) ?? num(out.lever),
    expiresAt: num(args.expiresAt) ?? num(out.expiresAt),
    confidence: confidence === null ? null : Math.max(0, Math.min(1, confidence)),
    opportunityId: id,
    hasOpportunity: id !== null,
  };
}

export type ConfidenceLabel = "high" | "mid" | "low";
export const confidenceLabel = (value: number): ConfidenceLabel => (value >= 0.7 ? "high" : value >= 0.45 ? "mid" : "low");
