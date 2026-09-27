import type { AiAgentRun, AiToolRun, AiUiMessage } from "../ui/AiMessageProcess";

// 证据账本推导：只读取 research.recordEvidence / research.recordDecision 的工具结果与
// 主 Agent 工具结果上的 evidenceRef，从不从正文推断立场。没有账本调用的回合 hasLedger=false，
// 界面据此不显示天平，只把带编号的工具结果列为「未归类」。

export type EvidenceStance = "bull" | "bear" | "neutral" | "constraint";

export type EvidenceLedgerItem = {
  id: string;
  claim: string;
  stance: EvidenceStance;
  weight: number;
  sourceRefs: string[];
  revisionNote: string | null;
  /** 同 id 被重新记录的次数（0 = 从未修订）。 */
  revisions: number;
  previousWeight: number | null;
  previousStance: EvidenceStance | null;
  recordedAt: number | null;
};

export type EvidenceWakeCondition = {
  kind: "price_above" | "price_below" | "time";
  price: number | null;
  afterMinutes: number | null;
  dueAt: number | null;
  note: string | null;
};

export type EvidenceDecision = {
  outcome: "long" | "short" | "abstain" | "hold";
  reason: string;
  instId: string | null;
  wakeConditions: EvidenceWakeCondition[];
  recordedAt: number | null;
};

export type EvidenceSource = {
  ref: string;
  tool: AiToolRun;
};

export type EvidenceLedger = {
  hasLedger: boolean;
  instId: string | null;
  items: EvidenceLedgerItem[];
  sources: Map<string, EvidenceSource>;
  /** 已返回且带编号、但没有被任何账本条目引用的工具结果（按返回顺序）。 */
  unassigned: EvidenceSource[];
  /** 账本引用了但本轮不存在的编号——模型虚构或引用了失败结果，界面如实提示。 */
  unknownRefs: string[];
  bull: number;
  bear: number;
  total: number;
  net: number;
  /** 1 - |净| / 总，总权重为 0 时为 null。越接近 1 越冲突。 */
  conflict: number | null;
  decision: EvidenceDecision | null;
};

const LEDGER_EVIDENCE_TOOL = "research.recordEvidence";
const LEDGER_DECISION_TOOL = "research.recordDecision";

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finite(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

// 工具名可能是规范形式（research.recordEvidence）或 provider 形式（research_recordEvidence）。
function toolIs(name: string, canonical: string) {
  return name === canonical || name === canonical.replaceAll(".", "_");
}

export function isLedgerTool(name: string) {
  return toolIs(name, LEDGER_EVIDENCE_TOOL) || toolIs(name, LEDGER_DECISION_TOOL);
}

export function toolResultRecord(tool: AiToolRun) {
  return asRecord(tool.result);
}

export function evidenceRefOf(tool: AiToolRun): string | null {
  if (tool.status !== "done" || isLedgerTool(tool.name)) return null;
  return text(toolResultRecord(tool).evidenceRef);
}

function readStance(value: unknown): EvidenceStance | null {
  return value === "bull" || value === "bear" || value === "neutral" || value === "constraint" ? value : null;
}

function readOutcome(value: unknown): EvidenceDecision["outcome"] | null {
  return value === "long" || value === "short" || value === "abstain" || value === "hold" ? value : null;
}

function readWakeCondition(value: unknown): EvidenceWakeCondition | null {
  const record = asRecord(value);
  const kind = record.kind;
  if (kind !== "price_above" && kind !== "price_below" && kind !== "time") return null;
  return {
    kind,
    price: finite(record.price),
    afterMinutes: finite(record.afterMinutes),
    dueAt: finite(record.dueAt),
    note: text(record.note)
  };
}

export function deriveEvidenceLedger(message: Pick<AiUiMessage, "tools">): EvidenceLedger {
  // message.tools 按工具首次调用的先后排列，账本的修订顺序即数组顺序。
  const ordered = message.tools;

  const sources = new Map<string, EvidenceSource>();
  const sourceOrder: string[] = [];
  const items = new Map<string, EvidenceLedgerItem>();
  let hasLedger = false;
  let instId: string | null = null;
  let decision: EvidenceDecision | null = null;

  for (const tool of ordered) {
    const ref = evidenceRefOf(tool);
    if (ref && !sources.has(ref)) {
      sources.set(ref, { ref, tool });
      sourceOrder.push(ref);
    }
    if (tool.status !== "done") continue;
    if (toolIs(tool.name, LEDGER_EVIDENCE_TOOL)) {
      const result = toolResultRecord(tool);
      const recorded = Array.isArray(result.items) ? result.items : [];
      if (recorded.length === 0) continue;
      hasLedger = true;
      instId = text(result.instId) ?? instId;
      const recordedAt = finite(result.recordedAt);
      for (const raw of recorded) {
        const entry = asRecord(raw);
        const id = text(entry.id);
        const claim = text(entry.claim);
        const stance = readStance(entry.stance);
        const weight = finite(entry.weight);
        if (!id || !claim || !stance || weight === null) continue;
        const sourceRefs = Array.isArray(entry.sourceRefs) ? entry.sourceRefs.map(text).filter((item): item is string => Boolean(item)) : [];
        const previous = items.get(id);
        // Map.set 对已有键保留首次插入的位置：修订只改内容，卡片不会在列里跳动。
        items.set(id, {
          id,
          claim,
          stance,
          weight: Math.max(0, Math.min(3, weight)),
          sourceRefs,
          revisionNote: text(entry.revisionNote),
          revisions: previous ? previous.revisions + 1 : 0,
          previousWeight: previous ? previous.weight : null,
          previousStance: previous ? previous.stance : null,
          recordedAt
        });
      }
    } else if (toolIs(tool.name, LEDGER_DECISION_TOOL)) {
      const result = toolResultRecord(tool);
      const outcome = readOutcome(result.outcome);
      const reason = text(result.reason);
      if (!outcome || !reason) continue;
      hasLedger = true;
      decision = {
        outcome,
        reason,
        instId: text(result.instId),
        wakeConditions: (Array.isArray(result.wakeConditions) ? result.wakeConditions : [])
          .map(readWakeCondition)
          .filter((item): item is EvidenceWakeCondition => Boolean(item)),
        recordedAt: finite(result.recordedAt)
      };
      instId = decision.instId ?? instId;
    }
  }

  const ledgerItems = [...items.values()];
  const cited = new Set(ledgerItems.flatMap((item) => item.sourceRefs));
  const unknownRefs = [...cited].filter((ref) => !sources.has(ref));
  let bull = 0;
  let bear = 0;
  for (const item of ledgerItems) {
    if (item.stance === "bull") bull += item.weight;
    if (item.stance === "bear") bear += item.weight;
  }
  const total = bull + bear;
  const net = bull - bear;
  return {
    hasLedger,
    instId,
    items: ledgerItems,
    sources,
    unassigned: sourceOrder.filter((ref) => !cited.has(ref)).map((ref) => sources.get(ref)!),
    unknownRefs,
    bull: round2(bull),
    bear: round2(bear),
    total: round2(total),
    net: round2(net),
    conflict: total > 0 ? round2(1 - Math.abs(net) / total) : null,
    decision
  };
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

export type WakeDistance = {
  /** 触发所需的相对价格变化（正 = 需要上涨）。已满足时为 0。 */
  pct: number;
  reached: boolean;
};

export function wakePriceDistance(condition: EvidenceWakeCondition, price: number | null): WakeDistance | null {
  if (condition.kind === "time" || condition.price === null || price === null || price <= 0) return null;
  const pct = (condition.price - price) / price;
  const reached = condition.kind === "price_above" ? price >= condition.price : price <= condition.price;
  return { pct: reached ? 0 : pct, reached };
}

export type OrbitExpert = {
  id: string;
  title: string;
  role: string | null;
  status: AiAgentRun["status"];
  mode: "parallel" | "serial";
  startedAt: number | null;
  endedAt: number | null;
  tokens: number | null;
  toolCount: number;
  followUps: number;
};

/** 专家 agentDone.result.usage 的总 Token；Provider 未上报时为 null（不当作 0）。 */
export function agentUsageTokens(value: unknown): number | null {
  const usage = asRecord(asRecord(value).usage);
  const total = finite(usage.totalTokens) ?? finite(usage.total_tokens);
  if (total !== null) return total;
  const input = finite(usage.inputTokens) ?? finite(usage.input_tokens) ?? finite(usage.promptTokens);
  const output = finite(usage.outputTokens) ?? finite(usage.output_tokens) ?? finite(usage.completionTokens);
  return input === null && output === null ? null : (input ?? 0) + (output ?? 0);
}

// consult_experts 的 results[].mode 决定并行 / 串行；单点 consult_expert 与 follow_up 按串行呈现。
export function deriveOrbitExperts(message: Pick<AiUiMessage, "tools" | "agents">): OrbitExpert[] {
  const modes = new Map<string, "parallel" | "serial">();
  const followUps = new Map<string, number>();
  for (const tool of message.tools) {
    if (tool.name === "consult_experts") {
      const results = toolResultRecord(tool).results;
      if (Array.isArray(results)) {
        for (const raw of results) {
          const entry = asRecord(raw);
          const mode = entry.mode === "parallel" ? "parallel" : entry.mode === "serial" ? "serial" : null;
          if (!mode) continue;
          for (const key of [text(entry.expertId), text(entry.expertName)]) if (key && !modes.has(key)) modes.set(key, mode);
        }
      }
    }
    if (tool.name === "follow_up") {
      const target = text(asRecord(tool.arguments).expertId) ?? text(asRecord(tool.arguments).expertName);
      if (target) followUps.set(target, (followUps.get(target) ?? 0) + 1);
    }
  }
  return (message.agents ?? []).map((agent) => ({
    id: agent.id,
    title: agent.title || agent.role || agent.id,
    role: agent.role ?? null,
    status: agent.status,
    mode: modes.get(agent.id) ?? modes.get(agent.title) ?? "serial",
    startedAt: agent.startedAt ?? null,
    endedAt: agent.endedAt ?? null,
    tokens: agentUsageTokens(agent.result),
    toolCount: agent.tools?.length ?? 0,
    followUps: followUps.get(agent.id) ?? followUps.get(agent.title) ?? 0
  }));
}
