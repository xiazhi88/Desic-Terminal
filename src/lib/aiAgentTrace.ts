import { filterInternalAiToolEvents } from "./aiToolEvents";

export type AiAgentTraceStatus = "running" | "done" | "failed" | "cancelled";

export type AiAgentTraceTool = {
  id: string;
  name: string;
  status: "running" | "done" | "failed" | "blocked";
  summary?: string;
  reportedOnly?: boolean;
  startedAt?: number;
  endedAt?: number;
  requestedAt?: number;
  executionStartedAt?: number;
  executionEndedAt?: number;
};

export type AiAgentReport = {
  status: string;
  stance: string;
  confidence?: number;
  timeHorizon: string;
  evidence: string[];
  risks: string[];
  invalidation: string[];
  missingData: string[];
  recommendation: string;
  veto: boolean;
  vetoReason: string;
};

export type AiAgentResultSummary = {
  finishReason: string;
  iterations?: number;
  successfulTools: string[];
  report?: AiAgentReport;
  text: string;
};

export type AiAgentFailure = {
  kind: "model" | "agent";
  message: string;
};

export type AiAgentTraceItem = {
  id: string;
  parentId?: string | null;
  role?: string | null;
  title: string;
  task: string;
  status: AiAgentTraceStatus;
  result?: unknown;
  error?: string | null;
  failure?: AiAgentFailure | null;
  startedAt?: number;
  endedAt?: number;
  tools: AiAgentTraceTool[];
};

export type AiAgentCollaborationTrace = {
  agents: AiAgentTraceItem[];
  teamEvents: unknown[];
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringValue(item)).filter(Boolean);
}

function parseJsonRecord(value: string) {
  const text = value.trim();
  if (!text) return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (!fenced) return null;
    try {
      return asRecord(JSON.parse(fenced));
    } catch {
      return null;
    }
  }
}

export function parseAiAgentResult(value: unknown): AiAgentResultSummary {
  const root = asRecord(value);
  const directText = typeof value === "string" ? value.trim() : "";
  const text = stringValue(root?.text) || directText;
  const reportRecord = asRecord(root?.report)
    || parseJsonRecord(text)
    || (root && (root.status !== undefined || root.evidence !== undefined) ? root : null);
  const confidence = Number(reportRecord?.confidence);
  const iterations = Number(root?.iterations);
  const hasReport = Boolean(reportRecord && (
    reportRecord.status !== undefined
    || reportRecord.evidence !== undefined
    || reportRecord.recommendation !== undefined
  ));
  return {
    finishReason: stringValue(root?.finishReason),
    iterations: Number.isFinite(iterations) && iterations >= 0 ? iterations : undefined,
    successfulTools: stringList(root?.successfulTools),
    report: hasReport && reportRecord ? {
      status: stringValue(reportRecord.status),
      stance: stringValue(reportRecord.stance),
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(100, confidence)) : undefined,
      timeHorizon: stringValue(reportRecord.timeHorizon),
      evidence: stringList(reportRecord.evidence),
      risks: stringList(reportRecord.risks),
      invalidation: stringList(reportRecord.invalidation ?? reportRecord.invalidationConditions),
      missingData: stringList(reportRecord.missingData ?? reportRecord.dataGaps),
      recommendation: stringValue(reportRecord.recommendation),
      veto: reportRecord.veto === true,
      vetoReason: stringValue(reportRecord.vetoReason)
    } : undefined,
    text: hasReport ? "" : text
  };
}

function readableModelError(value: string) {
  const message = value.trim();
  if (!message || /^(error|failed)$/i.test(message)) return "模型服务未返回可用结果";
  if (/insufficient balance/i.test(message)) return "模型服务余额不足（Insufficient Balance）";
  return message;
}

export function getAiAgentFailure(
  result: unknown,
  error?: unknown,
  status?: unknown
): AiAgentFailure | null {
  const parsed = parseAiAgentResult(result);
  const finishReason = parsed.finishReason.toLowerCase();
  const explicitError = stringValue(error);
  if (finishReason === "error") {
    return {
      kind: "model",
      message: readableModelError(parsed.text || explicitError)
    };
  }
  if (explicitError) return { kind: "agent", message: explicitError };
  if (["failed", "error", "blocked"].includes(stringValue(status).toLowerCase())) {
    return { kind: "agent", message: "子任务未能完成" };
  }
  return null;
}

function normalizeAgentStatus(value: unknown, hasError: boolean): AiAgentTraceStatus {
  if (hasError) return "failed";
  const status = stringValue(value).toLowerCase();
  if (["failed", "error", "blocked"].includes(status)) return "failed";
  if (["cancelled", "canceled", "stopped"].includes(status)) return "cancelled";
  if (["done", "completed", "success", "finished"].includes(status)) return "done";
  return "running";
}

function ensureAgent(
  agents: Map<string, AiAgentTraceItem>,
  order: string[],
  id: string,
  event?: UnknownRecord
) {
  const current = agents.get(id);
  if (current) return current;
  const role = stringValue(event?.role) || null;
  const agent: AiAgentTraceItem = {
    id,
    parentId: stringValue(event?.parentAgentId) || null,
    role,
    title: stringValue(event?.title) || role || "分析 Agent",
    task: stringValue(event?.task),
    status: "running",
    startedAt: numberValue(event?.startedAt),
    tools: []
  };
  agents.set(id, agent);
  order.push(id);
  return agent;
}

function toolEventId(
  event: UnknownRecord,
  index: number,
  runtimeAgentId: string,
  agent: AiAgentTraceItem
) {
  const explicitId = stringValue(event.toolCallId);
  const name = stringValue(event.name) || "未知工具";
  const runtimePrefix = runtimeAgentId || agent.id;
  if (explicitId) return `${runtimePrefix}:${explicitId}`;
  if (stringValue(event.type) === "toolResult") {
    const running = agent.tools.find((item) => item.name === name && item.status === "running" && item.id.startsWith(`${runtimePrefix}:`));
    if (running) return running.id;
  }
  return `${runtimePrefix}:${name}:${index}`;
}

/**
 * Builds one stable lifecycle row per delegated Agent and tool call. Historical
 * runs can contain partial events, so missing starts/results are synthesized.
 */
export function buildAiAgentTrace(events: unknown[]): AiAgentCollaborationTrace {
  const agents = new Map<string, AiAgentTraceItem>();
  const runtimeAgentIds = new Map<string, string>();
  const order: string[] = [];
  const teamEvents: unknown[] = [];

  filterInternalAiToolEvents(events).forEach((event, index) => {
    const type = stringValue(event.type);

    if (type === "teamEvent" || type === "team_event") {
      teamEvents.push(event.event ?? event);
      return;
    }

    const runtimeAgentId = stringValue(event.agentId ?? event.subAgentId);
    const configuredAgentId = stringValue(event.configuredAgentId ?? event.configured_agent_id);
    if (runtimeAgentId && configuredAgentId) runtimeAgentIds.set(runtimeAgentId, configuredAgentId);
    const agentId = configuredAgentId || runtimeAgentIds.get(runtimeAgentId) || runtimeAgentId;
    if (type === "agentStart" || type === "agent_start") {
      if (!agentId) return;
      const agent = ensureAgent(agents, order, agentId, event);
      agent.parentId = stringValue(event.parentAgentId) || agent.parentId;
      agent.role = stringValue(event.role) || agent.role;
      agent.title = stringValue(event.title) || agent.title;
      agent.task = stringValue(event.task) || agent.task;
      agent.startedAt = numberValue(event.startedAt) ?? agent.startedAt;
      agent.status = "running";
      agent.error = null;
      agent.failure = null;
      agent.result = undefined;
      return;
    }

    if (type === "agentDone" || type === "agent_done") {
      if (!agentId) return;
      const agent = ensureAgent(agents, order, agentId, event);
      agent.result = event.result;
      agent.endedAt = numberValue(event.endedAt);
      const failure = getAiAgentFailure(event.result, event.error, event.status);
      agent.failure = failure;
      agent.error = failure?.message || null;
      agent.status = failure ? "failed" : normalizeAgentStatus(event.status, false);
      for (const name of parseAiAgentResult(event.result).successfulTools) {
        if (agent.tools.some((tool) => tool.name === name && tool.status === "done")) continue;
        agent.tools.push({
          id: `${agent.id}:reported:${name}`,
          name,
          status: "done",
          summary: "报告记录的成功调用",
          reportedOnly: true
        });
      }
      return;
    }

    if ((type !== "toolCall" && type !== "toolResult") || !agentId) return;
    const agent = ensureAgent(agents, order, agentId, event);
    const id = toolEventId(event, index, runtimeAgentId, agent);
    let tool = agent.tools.find((item) => item.id === id);
    if (!tool) {
      tool = {
        id,
        name: stringValue(event.name) || "未知工具",
        status: "running",
        startedAt: numberValue(event.startedAt)
      };
      agent.tools.push(tool);
    }

    if (type === "toolCall") {
      tool.name = stringValue(event.name) || tool.name;
      tool.status = event.blocked === true ? "blocked" : "running";
      tool.startedAt = numberValue(event.startedAt) ?? tool.startedAt;
      return;
    }

    tool.name = stringValue(event.name) || tool.name;
    tool.summary = stringValue(event.summary) || tool.summary;
    tool.status = event.ok === false ? "failed" : "done";
    tool.startedAt = numberValue(event.startedAt) ?? tool.startedAt;
    tool.endedAt = numberValue(event.endedAt);
    tool.requestedAt = numberValue(event.requestedAt);
    tool.executionStartedAt = numberValue(event.executionStartedAt);
    tool.executionEndedAt = numberValue(event.executionEndedAt);
  });

  return {
    agents: order.map((id) => agents.get(id)).filter((item): item is AiAgentTraceItem => Boolean(item)),
    teamEvents
  };
}

const AGENT_REPORT_VALIDATION_ERROR = /Agent (?:报告不是有效 JSON|报告字段不完整或类型无效|未返回可用报告)/;

/**
 * Repairs historical run summaries that persisted a report-validation error
 * even though the underlying Agent result was a model-provider failure.
 */
export function resolveAiAutomationRunError(error: unknown, events: unknown[]) {
  const message = stringValue(error);
  if (!message || !AGENT_REPORT_VALIDATION_ERROR.test(message)) return message;

  const trace = buildAiAgentTrace(events);
  const matchingAgent = trace.agents.find((agent) => (
    agent.failure?.kind === "model" && message.includes(agent.title)
  )) || trace.agents.find((agent) => agent.failure?.kind === "model");
  if (!matchingAgent?.failure) return message;

  const rawProviderMessage = parseAiAgentResult(matchingAgent.result).text.trim();
  const replacement = rawProviderMessage && !/^(error|failed)$/i.test(rawProviderMessage)
    ? rawProviderMessage
    : matchingAgent.failure.message;
  return message.replace(AGENT_REPORT_VALIDATION_ERROR, replacement);
}
