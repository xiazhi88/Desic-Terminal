import { lazy, Suspense, type Dispatch, type SetStateAction } from "react";
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import clsx from "clsx";
import { getAiAgentFailure } from "../lib/aiAgentTrace";
import { filterInternalAiToolEvents } from "../lib/aiToolEvents";
import { logger } from "../lib/logger";
import type { AiEvent, AiStoredMessage } from "../types";
import { formatLocalizedNumber, i18n } from "../i18n/runtime";

const AiMarkdown = lazy(() =>
  import("./AiMarkdown").then((module) => ({ default: module.AiMarkdown }))
);

export type AiUiMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  draftText?: string;
  reasoning?: string;
  completed?: boolean;
  tools: AiToolRun[];
  approvals?: AiApprovalRun[];
  agents?: AiAgentRun[];
  teamEvents?: unknown[];
  timeline?: AiTimelineItem[];
  usage?: unknown;
  status?: string;
  error?: boolean;
  errorMessage?: string;
};

export type AiToolRun = {
  id: string;
  name: string;
  arguments?: unknown;
  result?: unknown;
  summary?: string;
  ok?: boolean;
  allowed?: boolean;
  blocked?: boolean;
  policy?: string;
  agentId?: string | null;
  parentAgentId?: string | null;
  startedAt?: number;
  endedAt?: number;
  requestedAt?: number;
  executionStartedAt?: number;
  executionEndedAt?: number;
  status: "pending" | "running" | "done" | "blocked" | "failed";
};

export type AiApprovalRun = {
  id: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  reason?: string | null;
  status: "pending" | "approved" | "rejected" | "expired";
  resolutionReason?: string | null;
};

export type AiAgentRun = {
  id: string;
  parentId?: string | null;
  role?: string | null;
  title: string;
  task: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  result?: unknown;
  error?: string | null;
  tools?: AiToolRun[];
  startedAt?: number;
  endedAt?: number;
};

type AiTimelineItem =
  | { id: string; kind: "text"; content: string; createdAt?: number; updatedAt?: number }
  | { id: string; kind: "reasoning"; content: string; createdAt?: number; updatedAt?: number }
  | { id: string; kind: "tool"; toolId: string; agentId?: string | null; createdAt?: number; updatedAt?: number }
  | { id: string; kind: "agent"; agentId: string; createdAt?: number; updatedAt?: number }
  | { id: string; kind: "approval"; approvalId: string; createdAt?: number; updatedAt?: number }
  | { id: string; kind: "team"; index: number; createdAt?: number; updatedAt?: number };

type AiProcessGroup =
  | { id: string; kind: "text"; item: Extract<AiTimelineItem, { kind: "text" }> }
  | { id: string; kind: "reasoning"; item: Extract<AiTimelineItem, { kind: "reasoning" }> }
  | { id: string; kind: "tools"; items: Extract<AiTimelineItem, { kind: "tool" }>[] }
  | { id: string; kind: "agent"; item: Extract<AiTimelineItem, { kind: "agent" }> }
  | { id: string; kind: "approval"; item: Extract<AiTimelineItem, { kind: "approval" }> }
  | { id: string; kind: "team"; items: Extract<AiTimelineItem, { kind: "team" }>[] };

export function MarkdownMessage({ content }: { content: string }) {
  return (
    <Suspense fallback={<div className="ai-markdown" aria-busy="true" />}>
      <AiMarkdown content={content} />
    </Suspense>
  );
}

const AI_TOOL_INPUT_KEYS = ["arguments", "input", "args", "parameters", "params", "argumentsJson", "inputJson", "toolInput"];

function processText(key: string, english: string, chinese: string, values: Record<string, unknown> = {}) {
  const language = (i18n.resolvedLanguage || i18n.language || "en-US").toLowerCase();
  return String(i18n.t(`automation:${key}`, {
    defaultValue: language.startsWith("zh") ? chinese : english,
    ...values
  }));
}

function normalizeAiToolPayload(value: unknown) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function isFailureStatus(value: string | undefined) {
  return ["failed", "error"].includes(value?.trim().toLowerCase() ?? "");
}

function isGenericAiFailure(value: string | undefined) {
  return !value || /^(failed|error|生成失败|AI 运行失败|AI 模型响应失败)$/i.test(value.trim());
}

function normalizeAiFailureMessage(value: string | undefined) {
  const message = value?.trim() ?? "";
  if (isGenericAiFailure(message)) return processText("runFailed", "AI run failed", "AI 运行失败");
  if (/insufficient balance/i.test(message)) return processText("modelInsufficientBalance", "Model service balance is insufficient (Insufficient Balance)", "模型服务余额不足（Insufficient Balance）");
  return message;
}

function hasVisibleToolInput(value: unknown) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function readAiToolInput(source: Record<string, unknown>) {
  for (const key of AI_TOOL_INPUT_KEYS) {
    const value = normalizeAiToolPayload(source[key]);
    if (hasVisibleToolInput(value)) return value;
  }
  return normalizeAiToolPayload(source.arguments);
}

function stableAgentId(source: { agentId?: string | null; configuredAgentId?: string | null }) {
  return source.configuredAgentId?.trim() || source.agentId?.trim() || "";
}

function storedEventTime(
  source: Record<string, unknown>,
  key: "startedAt" | "endedAt" | "requestedAt" | "executionStartedAt" | "executionEndedAt"
) {
  const value = Number(source[key]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function AiToolInputCode({ value }: { value: unknown }) {
  const normalized = normalizeAiToolPayload(value);
  if (!hasVisibleToolInput(normalized)) {
    return <code className="empty">{processText("noToolInput", "No input parameters", "无输入参数")}</code>;
  }
  return <code>{safeJson(normalized)}</code>;
}

function AiToolOutputCode({ value, pending }: { value: unknown; pending?: boolean }) {
  const normalized = normalizeAiToolPayload(value);
  if (normalized === null || normalized === undefined) {
    return <code className="empty">{pending
      ? processText("waitingToolResult", "Waiting for tool result", "等待工具返回")
      : processText("noToolOutput", "No output data", "无输出数据")}</code>;
  }
  return <code>{safeJson(normalized)}</code>;
}

function strategyActionForTool(tool: AiToolRun) {
  if (!tool.name.startsWith("strategy.") || !tool.ok || !tool.result || typeof tool.result !== "object") return null;
  const result = tool.result as Record<string, unknown>;
  const input = tool.arguments && typeof tool.arguments === "object" ? tool.arguments as Record<string, unknown> : {};
  const strategy = result.strategy && typeof result.strategy === "object" ? result.strategy as Record<string, unknown> : null;
  const run = result.run && typeof result.run === "object" ? result.run as Record<string, unknown> : null;
  const optimization = result.optimization && typeof result.optimization === "object" ? result.optimization as Record<string, unknown> : null;
  const strategyId = String(strategy?.id ?? run?.strategyId ?? result.strategyId ?? input.strategyId ?? "").trim();
  if (!strategyId) return null;
  return {
    strategyId,
    runId: String(run?.id ?? result.runId ?? input.runId ?? "").trim() || undefined,
    optimizationId: String(optimization?.id ?? result.optimizationId ?? input.optimizationId ?? "").trim() || undefined
  };
}

function AiToolCard({ tool, onOpenStrategy }: { tool: AiToolRun; onOpenStrategy?: (strategyId: string, runId?: string, optimizationId?: string) => void }) {
  const strategyAction = strategyActionForTool(tool);
  return (
    <details
      className={clsx(
        "ai-tool",
        `tool-${tool.status}`,
        tool.blocked && "blocked",
        tool.allowed && !tool.blocked && "allowed",
        tool.ok === true && "result-ok",
        tool.ok === false && "result-failed"
      )}
    >
      <summary>
        <span>{processText("tool", "Tool", "工具")} · {tool.name}</span>
        <strong>{toolStatusLabel(tool)}</strong>
      </summary>
      {tool.summary && <small data-i18n-skip>{tool.summary}</small>}
      {tool.policy && <small>{tool.policy}</small>}
      <div className="ai-tool-io">
        <details>
          <summary>{processText("toolInput", "Input", "输入")}</summary>
          <AiToolInputCode value={tool.arguments} />
        </details>
        <details>
          <summary>{processText("toolOutput", "Output", "输出")}</summary>
          <AiToolOutputCode value={tool.result} pending={tool.status === "running"} />
        </details>
      </div>
      {strategyAction && onOpenStrategy ? <button type="button" className="ai-tool-open-strategy" onClick={() => onOpenStrategy(strategyAction.strategyId, strategyAction.runId, strategyAction.optimizationId)}>{processText("openStrategyLab", "Open in Strategy Lab", "在策略实验室打开")}</button> : null}
    </details>
  );
}

function AiToolTraceRow({ tool, now, onOpenStrategy }: { tool: AiToolRun; now: number; onOpenStrategy?: (strategyId: string, runId?: string, optimizationId?: string) => void }) {
  const Icon = tool.status === "running" ? Loader2 : tool.status === "failed" || tool.ok === false || tool.blocked ? CircleAlert : CheckCircle2;
  const duration = toolDurationLabel(tool, now);
  const source = toolDataSourceLabel(tool);
  return (
    <details className={clsx("ai-tool-trace", `tool-${tool.status}`, tool.ok === false && "result-failed")}>
      <summary>
        <Icon size={13} className={tool.status === "running" ? "spin" : undefined} />
        <span className="ai-tool-trace-action">{toolActionLabel(tool)}</span>
        <code title={tool.name}>{tool.name}</code>
        <strong>{toolStatusLabel(tool)}{source ? ` · ${source}` : ""}{duration ? ` · ${duration}` : ""}</strong>
      </summary>
      {tool.summary && <small data-i18n-skip>{tool.summary}</small>}
      {strategyActionForTool(tool) && onOpenStrategy ? <button type="button" className="ai-tool-open-strategy" onClick={() => { const action = strategyActionForTool(tool); if (action) onOpenStrategy(action.strategyId, action.runId, action.optimizationId); }}>{processText("openStrategyLab", "Open in Strategy Lab", "在策略实验室打开")}</button> : null}
      <div className="ai-tool-panel">
        <details>
          <summary>{processText("toolInput", "Input", "输入")}</summary>
          <AiToolInputCode value={tool.arguments} />
        </details>
        <details>
          <summary>{processText("toolOutput", "Output", "输出")}</summary>
          <AiToolOutputCode value={tool.result} pending={tool.status === "running"} />
        </details>
      </div>
    </details>
  );
}

function toolDataSourceLabel(tool: AiToolRun) {
  if (tool.name === "market.readDecisionContext") return processText("liveDecisionSnapshot", "Live decision snapshot", "实时决策快照");
  if (!tool.name.startsWith("intelligence.")) return "";
  const result = tool.result && typeof tool.result === "object" && !Array.isArray(tool.result)
    ? tool.result as Record<string, unknown>
    : null;
  if (result?.refreshQueued === true || result?.refreshStatus === "queued" || result?.refreshStatus === "running") {
    return processText("localReadQueued", "Local read · refresh queued", "本地读取 · 后台排队");
  }
  return processText("localRead", "Local read", "本地读取");
}

function AiToolGroup({ items, message, now, onOpenStrategy }: { items: Extract<AiTimelineItem, { kind: "tool" }>[]; message: AiUiMessage; now: number; onOpenStrategy?: (strategyId: string, runId?: string, optimizationId?: string) => void }) {
  const tools = items
    .map((item) =>
      item.agentId
        ? message.agents?.find((agent) => agent.id === item.agentId)?.tools?.find((entry) => entry.id === item.toolId)
        : message.tools.find((entry) => entry.id === item.toolId)
    )
    .filter(Boolean) as AiToolRun[];
  if (tools.length === 0) return null;
  const running = tools.some((tool) => tool.status === "running");
  const failed = tools.filter((tool) => tool.status === "failed" || tool.ok === false || tool.blocked).length;
  const done = tools.filter((tool) => tool.status === "done" || tool.ok === true).length;
  const startedAt = minDefined(tools.map((tool) => tool.startedAt));
  const endedAt = running ? now : maxDefined(tools.map((tool) => tool.endedAt));
  const duration = formatDuration(startedAt, endedAt);
  return (
    <details className="ai-process-group ai-tool-group" open={running}>
      <summary>
        <span>{processText("toolsRunCount", "Ran {{count}} tools", "运行了 {{count}} 个工具", { count: tools.length })}</span>
        <strong>{processText("toolsSucceededCount", "{{count}} succeeded", "{{count}} 成功", { count: done })}{failed ? ` · ${processText("toolsFailedCount", "{{count}} failed", "{{count}} 异常", { count: failed })}` : ""}{duration ? ` · ${duration}` : ""}</strong>
      </summary>
      <div className="ai-tool-trace-list">
        {tools.map((tool) => (
          <AiToolTraceRow tool={tool} now={now} onOpenStrategy={onOpenStrategy} key={`${tool.agentId ?? "main"}-${tool.id}`} />
        ))}
      </div>
    </details>
  );
}

function AiAgentCard({ agent, now }: { agent: AiAgentRun; now: number }) {
  const duration = formatDuration(agent.startedAt, agent.endedAt ?? (agent.status === "running" ? now : undefined));
  const failure = getAiAgentFailure(agent.result, agent.error, agent.status);
  const modelError = failure?.kind === "model";
  return (
    <details className={clsx("ai-agent-run", `agent-${agent.status}`, modelError && "agent-model-error")} open={modelError || undefined}>
      <summary>
        <span>{modelError && <CircleAlert size={14} aria-hidden="true" />}{processText("subtask", "Subtask", "子任务")} · <span data-i18n-skip>{agent.title}</span></span>
        <strong>{modelError ? processText("modelError", "Model error", "模型错误") : agentStatusLabel(agent.status)}{duration ? ` · ${duration}` : ""}</strong>
      </summary>
      {agent.task && <p data-i18n-skip>{agent.task}</p>}
      {agent.tools && agent.tools.length > 0 && (
        <div className="ai-agent-tools">
          {agent.tools.map((tool) => (
            <AiToolTraceRow tool={tool} now={now} key={tool.id} />
          ))}
        </div>
      )}
      {failure ? (
        <div className={clsx("ai-agent-error", modelError && "model-error")} role="alert">
          <CircleAlert size={16} aria-hidden="true" />
          <div>
            <strong>{modelError ? processText("modelServiceError", "Model service error", "模型服务错误") : processText("subtaskFailed", "Subtask failed", "子任务失败")}</strong>
            <p data-i18n-skip>{failure.message}</p>
          </div>
        </div>
      ) : agent.result !== undefined ? <code>{safeJson(agent.result)}</code> : null}
    </details>
  );
}

export function AiMessageError({ message }: { message: AiUiMessage }) {
  if (!message.error || !message.errorMessage) return null;
  const hasAgentFailure = message.agents?.some((agent) => getAiAgentFailure(agent.result, agent.error, agent.status));
  if (hasAgentFailure && isGenericAiFailure(message.errorMessage)) return null;
  return (
    <div className="ai-message-error" role="alert">
      <CircleAlert size={17} aria-hidden="true" />
      <div>
        <strong>{processText("runError", "AI run error", "AI 运行错误")}</strong>
        <p data-i18n-skip>{message.errorMessage}</p>
      </div>
    </div>
  );
}

function usageValue(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const parsed = Number(record[key]);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

function normalizedUsage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const summary = value as Record<string, unknown>;
  const usage = summary.usage && typeof summary.usage === "object" && !Array.isArray(summary.usage)
    ? summary.usage
    : value;
  const input = usageValue(usage, ["inputTokens", "input_tokens", "totalInputTokens", "promptTokens"]);
  const output = usageValue(usage, ["outputTokens", "output_tokens", "totalOutputTokens", "completionTokens"]);
  const total = usageValue(usage, ["totalTokens", "total_tokens"]) || input + output;
  const reported = typeof summary.reported === "boolean"
    ? summary.reported
    : input > 0 || output > 0 || total > 0;
  const quality = typeof summary.quality === "string" ? summary.quality : reported ? "reconstructed" : "unreported";
  return {
    input,
    output,
    total,
    reported,
    partial: quality === "partial",
    unreportedAgentCount: Math.max(0, Number(summary.unreportedAgentCount) || 0),
    model: typeof summary.modelName === "string" ? summary.modelName : typeof summary.model === "string" ? summary.model : "",
    agentCount: Number(summary.agentCount) || 0
  };
}

function formatTokenCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return formatLocalizedNumber(Math.round(value));
}

export function AiTokenUsageLine({ usage }: { usage: unknown }) {
  const normalized = normalizedUsage(usage);
  if (!normalized) return null;
  return (
    <div className={clsx("ai-token-usage", !normalized.reported && "unreported")} aria-label={processText("tokenUsage", "Token usage for this turn", "本轮 Token 用量")}>
      <span>Token</span>
      {normalized.reported ? (
        <>
          <strong>{formatTokenCount(normalized.total)}</strong>
          <small>{processText("tokenInputOutput", "Input {{input}} · Output {{output}}", "输入 {{input}} · 输出 {{output}}", { input: formatTokenCount(normalized.input), output: formatTokenCount(normalized.output) })}</small>
          {normalized.agentCount > 0 ? <small>{processText("subagentCount", "{{count}} subagents", "{{count}} 个子 Agent", { count: normalized.agentCount })}</small> : null}
          {normalized.partial ? (
            <small>{normalized.unreportedAgentCount > 0
              ? processText(
                "usagePartiallyReportedAgents",
                "Known usage only; {{count}} agents did not report usage",
                "仅显示已知用量；{{count}} 个 Agent 未报告",
                { count: normalized.unreportedAgentCount }
              )
              : processText("usagePartiallyReported", "Known usage only; this turn was partially reported", "仅显示已知用量；本轮统计不完整")}</small>
          ) : null}
        </>
      ) : <small>{processText("usageNotReported", "Usage was not reported by the model", "模型未报告用量")}</small>}
    </div>
  );
}

export function AiProcessTimeline({ message, onApprove, now, onOpenStrategy }: { message: AiUiMessage; onApprove: (approvalId: string, approved: boolean, reason: string) => void; now: number; onOpenStrategy?: (strategyId: string, runId?: string, optimizationId?: string) => void }) {
  const timeline = message.timeline ?? [];
  const hasTimeline = timeline.length > 0;
  const hasLegacyProcess =
    !hasTimeline &&
    (message.draftText ||
      message.reasoning ||
      message.tools.length > 0 ||
      (message.agents?.length ?? 0) > 0 ||
      (message.teamEvents?.length ?? 0) > 0 ||
      (message.approvals?.length ?? 0) > 0);
  if (!hasTimeline && !hasLegacyProcess) return null;
  const done = message.completed || (!message.status && Boolean(message.text));
  const hasFailure = Boolean(message.error) || Boolean(message.agents?.some((agent) => getAiAgentFailure(agent.result, agent.error, agent.status)));
  const groups = hasTimeline ? buildProcessGroups(timeline) : [];
  const processCount = hasTimeline ? groups.length : message.tools.length + (message.agents?.length ?? 0) + (message.teamEvents?.length ?? 0) + (message.approvals?.length ?? 0);
  const duration = hasTimeline ? timelineDuration(timeline, message.status ? now : undefined) : undefined;
  return (
    <details className="ai-process" open={!done || hasFailure}>
      <summary>
        <span>{done ? processText("processed", "Processed", "已处理") : processText("processing", "Processing", "处理中")}</span>
        <strong>{duration ?? (processCount > 0
          ? processText("processItemCount", "{{count}} items", "{{count}} 项", { count: processCount })
          : processText("process", "Process", "过程"))}</strong>
      </summary>
      <div className="ai-process-list">
        {hasTimeline ? (
          groups.map((group) => renderProcessGroup(group, message, onApprove, now, onOpenStrategy))
        ) : (
          <>
            {message.draftText && <MarkdownMessage content={message.draftText} />}
            {message.reasoning && (
              <details className="ai-reasoning">
                <summary>{processText("reasoningProcess", "Reasoning", "思考过程")}</summary>
                <p data-i18n-skip>{message.reasoning}</p>
              </details>
            )}
            {message.agents?.map((agent) => <AiAgentCard agent={agent} now={now} key={agent.id} />)}
            {message.teamEvents && message.teamEvents.length > 0 && (
              <details className="ai-team-events">
                <summary>{processText("teamTaskUpdates", "Team task updates", "团队任务更新")} <strong>{message.teamEvents.length}</strong></summary>
                <code>{safeJson(message.teamEvents)}</code>
              </details>
            )}
            {message.tools.length > 0 && <AiToolGroup items={message.tools.map((tool) => ({ id: `legacy-${tool.id}`, kind: "tool", toolId: tool.id }))} message={message} now={now} onOpenStrategy={onOpenStrategy} />}
            {(message.approvals ?? []).map((approval) => <AiApprovalCard approval={approval} onApprove={onApprove} key={approval.id} />)}
          </>
        )}
      </div>
    </details>
  );
}

function renderProcessGroup(group: AiProcessGroup, message: AiUiMessage, onApprove: (approvalId: string, approved: boolean, reason: string) => void, now: number, onOpenStrategy?: (strategyId: string, runId?: string, optimizationId?: string) => void) {
  if (group.kind === "tools") return <AiToolGroup items={group.items} message={message} now={now} onOpenStrategy={onOpenStrategy} key={group.id} />;
  if (group.kind === "team") {
    return (
      <details className="ai-process-group ai-team-events" key={group.id}>
        <summary>{processText("teamTaskUpdates", "Team task updates", "团队任务更新")} <strong>{group.items.length}</strong></summary>
        <code>{safeJson(group.items.map((item) => message.teamEvents?.[item.index]).filter((item) => item !== undefined))}</code>
      </details>
    );
  }
  return renderTimelineItem(group.item, message, onApprove, now, onOpenStrategy);
}

function renderTimelineItem(item: AiTimelineItem, message: AiUiMessage, onApprove: (approvalId: string, approved: boolean, reason: string) => void, now: number, onOpenStrategy?: (strategyId: string, runId?: string, optimizationId?: string) => void) {
  if (item.kind === "text") return <MarkdownMessage content={item.content} key={item.id} />;
  if (item.kind === "reasoning") {
    return (
      <details className="ai-reasoning" key={item.id}>
        <summary>{processText("reasoningProcess", "Reasoning", "思考过程")}</summary>
        <p data-i18n-skip>{item.content}</p>
      </details>
    );
  }
  if (item.kind === "tool") {
    const tool = item.agentId
      ? message.agents?.find((agent) => agent.id === item.agentId)?.tools?.find((entry) => entry.id === item.toolId)
      : message.tools.find((entry) => entry.id === item.toolId);
    return tool ? <AiToolCard tool={tool} onOpenStrategy={onOpenStrategy} key={item.id} /> : null;
  }
  if (item.kind === "agent") {
    const agent = message.agents?.find((entry) => entry.id === item.agentId);
    return agent ? <AiAgentCard agent={agent} now={now} key={item.id} /> : null;
  }
  if (item.kind === "approval") {
    const approval = message.approvals?.find((entry) => entry.id === item.approvalId);
    return approval ? <AiApprovalCard approval={approval} onApprove={onApprove} key={item.id} /> : null;
  }
  if (item.kind === "team") {
    const teamEvent = message.teamEvents?.[item.index];
    return teamEvent !== undefined ? (
      <details className="ai-team-events" key={item.id}>
        <summary>{processText("teamTaskUpdates", "Team task updates", "团队任务更新")} <strong>{item.index + 1}</strong></summary>
        <code>{safeJson(teamEvent)}</code>
      </details>
    ) : null;
  }
  return null;
}

function AiApprovalCard({ approval, onApprove }: { approval: AiApprovalRun; onApprove: (approvalId: string, approved: boolean, reason: string) => void }) {
  return (
    <div className={clsx("ai-approval-card", `approval-${approval.status}`)}>
      <div className="ai-approval-head">
        <span>{processText("approval", "Approval", "审批")} · {approval.toolName}</span>
        <strong>{approvalStatusLabel(approval.status)}</strong>
      </div>
      {approval.reason && <small data-i18n-skip>{approval.reason}</small>}
      <details>
        <summary>{processText("parameters", "Parameters", "参数")}</summary>
        <code>{safeJson(approval.input ?? {})}</code>
      </details>
      {approval.resolutionReason && <small data-i18n-skip>{approval.resolutionReason}</small>}
      {approval.status === "pending" && (
        <div className="ai-approval-actions">
          <button onClick={() => onApprove(approval.id, true, "用户批准执行")}>{processText("approveExecution", "Approve execution", "批准执行")}</button>
          <button onClick={() => onApprove(approval.id, false, "用户拒绝执行")}>{processText("rejectExecution", "Reject", "拒绝")}</button>
        </div>
      )}
    </div>
  );
}

export function applyAiEvent(
  event: AiEvent,
  setStatus: (value: string) => void,
  setMessages: Dispatch<SetStateAction<AiUiMessage[]>>
) {
  if (event.type === "status") {
    setStatus(event.status === "running" ? "streaming" : event.status);
    setMessages((items) => updateLastAssistant(items, (message) => {
      if (message.completed) return message;
      if (isFailureStatus(event.status)) {
        return {
          ...message,
          error: true,
          errorMessage: normalizeAiFailureMessage(event.message),
          status: undefined
        };
      }
      return { ...message, status: event.message };
    }));
    return;
  }
  if (event.type === "delta") {
    setStatus(event.channel === "tool" ? "tooling" : "streaming");
    setMessages((items) =>
      updateLastAssistant(items, (message) => {
        if (message.completed) return message;
        if (event.channel === "text-preview") {
          return { ...message, text: event.content, status: "生成结果" };
        }
        if (event.channel === "text-preview-clear") {
          return { ...message, text: "", status: "处理中" };
        }
        if (event.channel === "text-final") {
          return { ...message, text: event.content, status: "生成结果" };
        }
        if (event.channel === "reasoning" || event.channel === "reasoning-final") {
          const currentReasoning = message.reasoning ?? "";
          const nextReasoning = event.channel === "reasoning-final"
            ? event.content
            : currentReasoning + event.content;
          const novelReasoning = nextReasoning.startsWith(currentReasoning)
            ? nextReasoning.slice(currentReasoning.length)
            : event.content;
          if (!novelReasoning) return { ...message, reasoning: nextReasoning, status: "思考中" };
          return appendAiTimelineText(
            { ...message, reasoning: nextReasoning, status: "思考中" },
            "reasoning",
            novelReasoning
          );
        }
        return appendAiTimelineText(
          { ...message, draftText: `${message.draftText ?? ""}${event.content}`, status: "处理中" },
          "text",
          event.content
        );
      })
    );
    return;
  }
  if (event.type === "toolCall") {
    setStatus("tooling");
    const now = Date.now();
    const agentId = stableAgentId(event) || null;
    const eventPayload = event as unknown as Record<string, unknown>;
    const toolPatch: AiToolRun = {
      id: event.toolCallId || event.name,
      name: event.name,
      arguments: readAiToolInput(eventPayload),
      allowed: event.allowed,
      blocked: event.blocked,
      policy: event.policy,
      agentId,
      parentAgentId: event.parentAgentId ?? null,
      startedAt: event.startedAt ?? now,
      status: event.blocked ? "blocked" : "running"
    };
    setMessages((items) =>
      updateLastAssistant(items, (message) => ({
        ...message,
        tools: agentId ? message.tools : upsertToolRun(message.tools, toolPatch),
        agents: agentId ? upsertAgentToolRun(message.agents ?? [], agentId, toolPatch) : message.agents,
        timeline: appendTimeline(message.timeline, {
          id: `tool-${agentId ?? "main"}-${toolPatch.id}`,
          kind: "tool",
          toolId: toolPatch.id,
          agentId,
          createdAt: event.startedAt ?? now,
          updatedAt: event.startedAt ?? now
        }),
        status: event.blocked ? "工具已阻断" : "调用工具"
      }))
    );
    return;
  }
  if (event.type === "toolResult") {
    setStatus("tooling");
    const now = Date.now();
    const agentId = stableAgentId(event) || null;
    const toolPatch: AiToolRun = {
      id: event.toolCallId || event.name,
      name: event.name,
      result: event.result,
      summary: event.summary,
      ok: event.ok,
      agentId,
      parentAgentId: event.parentAgentId ?? null,
      startedAt: event.startedAt,
      endedAt: event.endedAt ?? now,
      requestedAt: event.requestedAt,
      executionStartedAt: event.executionStartedAt,
      executionEndedAt: event.executionEndedAt,
      status: event.ok ? "done" : "failed"
    };
    setMessages((items) =>
      updateLastAssistant(items, (message) => ({
        ...message,
        tools: agentId ? message.tools : upsertToolRun(message.tools, toolPatch),
        agents: agentId ? upsertAgentToolRun(message.agents ?? [], agentId, toolPatch) : message.agents,
        timeline: updateTimelineItem(message.timeline, `tool-${agentId ?? "main"}-${toolPatch.id}`, event.endedAt ?? now),
        status: event.ok ? "工具结果已返回" : "工具读取失败"
      }))
    );
    return;
  }
  if (event.type === "usage") {
    setMessages((items) => updateLastAssistant(items, (message) => ({ ...message, usage: event.usage })));
    return;
  }
  if (event.type === "agentStart") {
    setStatus("tooling");
    const now = Date.now();
    const agentId = stableAgentId(event) || event.agentId;
    setMessages((items) =>
      updateLastAssistant(items, (message) => ({
        ...message,
        agents: upsertAgentRun(message.agents ?? [], {
          id: agentId,
          parentId: event.parentAgentId,
          role: event.role,
          title: event.title || event.role || "子代理任务",
          task: event.task,
          startedAt: event.startedAt ?? now,
          status: "running"
        }),
        timeline: appendTimeline(message.timeline, { id: `agent-${agentId}`, kind: "agent", agentId, createdAt: event.startedAt ?? now, updatedAt: event.startedAt ?? now }),
        status: "子代理执行中"
      }))
    );
    return;
  }
  if (event.type === "agentDone") {
    setStatus("tooling");
    const now = Date.now();
    const agentId = stableAgentId(event) || event.agentId;
    setMessages((items) =>
      updateLastAssistant(items, (message) => {
        const failure = getAiAgentFailure(event.result, event.error, event.status);
        return {
          ...message,
          agents: upsertAgentRun(message.agents ?? [], {
            id: agentId,
            title: "",
            task: "",
            status: failure ? "failed" : event.status === "cancelled" ? "cancelled" : "done",
            result: event.result,
            error: event.error,
            endedAt: event.endedAt ?? now
          }),
          timeline: updateTimelineItem(message.timeline, `agent-${agentId}`, event.endedAt ?? now),
          errorMessage: failure?.kind === "model" && isGenericAiFailure(message.errorMessage)
            ? undefined
            : message.errorMessage,
          status: failure ? undefined : "子代理已完成"
        };
      })
    );
    return;
  }
  if (event.type === "teamEvent") {
    setStatus("tooling");
    setMessages((items) =>
      updateLastAssistant(items, (message) => ({
        ...message,
        teamEvents: [...(message.teamEvents ?? []), event.event],
        timeline: appendTimeline(message.timeline, {
          id: `team-${message.teamEvents?.length ?? 0}`,
          kind: "team",
          index: message.teamEvents?.length ?? 0
        }),
        status: "团队任务更新"
      }))
    );
    return;
  }
  if (event.type === "approvalRequest") {
    setStatus("tooling");
    const eventPayload = event as unknown as Record<string, unknown>;
    const approvalInput = normalizeAiToolPayload(event.input);
    setMessages((items) =>
      updateLastAssistant(items, (message) => ({
        ...message,
        approvals: upsertApprovalRun(message.approvals ?? [], {
          id: event.approvalId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: hasVisibleToolInput(approvalInput) ? approvalInput : readAiToolInput(eventPayload) ?? {},
          reason: event.reason,
          status: "pending"
        }),
        timeline: appendTimeline(message.timeline, { id: `approval-${event.approvalId}`, kind: "approval", approvalId: event.approvalId }),
        status: "等待工具审批"
      }))
    );
    return;
  }
  if (event.type === "approvalResolved") {
    setMessages((items) =>
      updateLastAssistant(items, (message) => ({
        ...message,
        approvals: upsertApprovalRun(message.approvals ?? [], {
          id: event.approvalId,
          toolCallId: event.approvalId,
          toolName: "tool",
          input: {},
          status: event.approved ? "approved" : "rejected",
          resolutionReason: event.reason
        }),
        status: event.approved ? "已批准工具执行" : "已拒绝工具执行"
      }))
    );
    return;
  }
  if (event.type === "error") {
    logger.error("ai event error", event.message);
    setStatus("failed");
    setMessages((items) => updateLastAssistant(items, (message) => ({
      ...message,
      error: true,
      errorMessage: normalizeAiFailureMessage(event.message),
      status: undefined
    })));
    return;
  }
  if (event.type === "done") {
    const failed = event.finishReason?.trim().toLowerCase() === "error";
    setStatus(failed ? "failed" : "idle");
    setMessages((items) => updateLastAssistant(items, (message) => ({
      ...message,
      completed: true,
      error: failed || message.error,
      errorMessage: failed ? message.errorMessage || "AI 模型响应失败" : message.errorMessage,
      status: undefined
    })));
  }
}

export function storedMessageToUiMessage(message: AiStoredMessage): AiUiMessage {
  const metadata = parseStoredAiMetadata(message.toolJson);
  const storedStatus = message.status?.trim().toLowerCase();
  const failed = storedStatus === "failed" || storedStatus === "error";
  const completed = failed || storedStatus === "cancelled" || storedStatus === "canceled" || storedStatus === "completed" || storedStatus === "done" || storedStatus === "success" || storedStatus === "idle";
  const recovered = recoverLegacyFinalText(message.content, metadata.timeline ?? [], completed && !failed);
  metadata.timeline = recovered.timeline;
  const storedText = recovered.content;
  return {
    id: message.id,
    role: message.role === "user" ? "user" : message.role === "system" ? "system" : "assistant",
    text: failed && isGenericAiFailure(storedText) ? "" : storedText,
    reasoning: message.reasoning || undefined,
    completed,
    tools: metadata.tools,
    approvals: metadata.approvals,
    agents: metadata.agents,
    teamEvents: metadata.teamEvents,
    timeline: metadata.timeline,
    usage: message.tokenUsage ?? metadata.usage,
    error: failed,
    errorMessage: failed ? "AI 运行失败" : undefined,
    status: completed ? undefined : message.status ?? undefined
  };
}

function recoverLegacyFinalText(content: string, timeline: AiTimelineItem[], eligible: boolean) {
  if (!eligible || content.trim() || timeline.length === 0) return { content, timeline };
  let lastBoundary = -1;
  for (let index = 0; index < timeline.length; index += 1) {
    if (timeline[index].kind !== "text" && timeline[index].kind !== "reasoning") lastBoundary = index;
  }
  const finalTextIndexes = new Set<number>();
  const finalText: string[] = [];
  for (let index = lastBoundary + 1; index < timeline.length; index += 1) {
    const item = timeline[index];
    if (item.kind !== "text") continue;
    finalTextIndexes.add(index);
    finalText.push(item.content);
  }
  if (finalText.length === 0) return { content, timeline };
  return {
    content: finalText.join(""),
    timeline: timeline.filter((_, index) => !finalTextIndexes.has(index))
  };
}

function parseStoredAiMetadata(toolJson?: string | null): Pick<AiUiMessage, "tools" | "approvals" | "agents" | "teamEvents" | "timeline" | "usage"> {
  const empty: Pick<AiUiMessage, "tools" | "approvals" | "agents" | "teamEvents" | "timeline" | "usage"> = {
    tools: [],
    approvals: [],
    agents: [],
    teamEvents: [],
    timeline: [],
    usage: undefined
  };
  if (!toolJson) return empty;
  try {
    const parsed = JSON.parse(toolJson);
    if (!Array.isArray(parsed)) return empty;
    const visibleEvents = filterInternalAiToolEvents(parsed);
    const metadata = { ...empty };
    metadata.tools = visibleEvents.reduce<AiToolRun[]>((items, item, index) => {
      if (item?.type === "processText" || item?.type === "processReasoning") {
        const kind = item.type === "processReasoning" ? "reasoning" : "text";
        const content = typeof item.content === "string" ? item.content : "";
        if (content) {
          metadata.timeline = appendTimelineText(
            metadata.timeline,
            kind,
            content,
            typeof item.id === "string" ? item.id : `${kind}-${index}`
          );
        }
        return items;
      }
      if (item?.type === "agentStart") {
        const itemPayload = item as Record<string, unknown>;
        const agentId = stableAgentId({
          agentId: typeof item.agentId === "string" ? item.agentId : null,
          configuredAgentId: typeof item.configuredAgentId === "string" ? item.configuredAgentId : null
        }) || `agent-${index}`;
        const startedAt = storedEventTime(itemPayload, "startedAt");
        metadata.agents = upsertAgentRun(metadata.agents ?? [], {
          id: agentId,
          parentId: typeof item.parentAgentId === "string" ? item.parentAgentId : null,
          role: typeof item.role === "string" ? item.role : null,
          title: typeof item.title === "string" ? item.title : typeof item.role === "string" ? item.role : "子代理任务",
          task: typeof item.task === "string" ? item.task : "",
          startedAt,
          status: "running"
        });
        metadata.timeline = appendTimeline(metadata.timeline, {
          id: `agent-${agentId}`,
          kind: "agent",
          agentId,
          createdAt: startedAt,
          updatedAt: startedAt
        });
        return items;
      }
      if (item?.type === "agentDone") {
        const itemPayload = item as Record<string, unknown>;
        const agentId = stableAgentId({
          agentId: typeof item.agentId === "string" ? item.agentId : null,
          configuredAgentId: typeof item.configuredAgentId === "string" ? item.configuredAgentId : null
        }) || `agent-${index}`;
        const endedAt = storedEventTime(itemPayload, "endedAt");
        metadata.agents = upsertAgentRun(metadata.agents ?? [], {
          id: agentId,
          title: "",
          task: "",
          status: getAiAgentFailure(item.result, item.error, item.status)
            ? "failed"
            : item.status === "cancelled"
              ? "cancelled"
              : "done",
          result: item.result,
          error: typeof item.error === "string" ? item.error : null,
          endedAt
        });
        metadata.timeline = updateTimelineItem(metadata.timeline, `agent-${agentId}`, endedAt);
        return items;
      }
      if (item?.type === "teamEvent") {
        const teamIndex = metadata.teamEvents?.length ?? 0;
        metadata.teamEvents = [...(metadata.teamEvents ?? []), item.event ?? item];
        metadata.timeline = appendTimeline(metadata.timeline, { id: `team-${teamIndex}`, kind: "team", index: teamIndex });
        return items;
      }
      if (item?.type === "usage") {
        metadata.usage = item.usage ?? item;
        return items;
      }
      if (item?.type === "usageSummary") {
        metadata.usage = item.__desicUsageSummary ?? item;
        return items;
      }
      if (item?.type === "approvalRequest") {
        const itemPayload = item as Record<string, unknown>;
        const approvalInput = normalizeAiToolPayload(item.input);
        metadata.approvals = upsertApprovalRun(metadata.approvals ?? [], {
          id: typeof item.approvalId === "string" ? item.approvalId : `approval-${index}`,
          toolCallId: typeof item.toolCallId === "string" ? item.toolCallId : "tool",
          toolName: typeof item.toolName === "string" ? item.toolName : "tool",
          input: hasVisibleToolInput(approvalInput) ? approvalInput : readAiToolInput(itemPayload) ?? {},
          reason: typeof item.reason === "string" ? item.reason : null,
          status: "pending"
        });
        metadata.timeline = appendTimeline(metadata.timeline, {
          id: `approval-${typeof item.approvalId === "string" ? item.approvalId : index}`,
          kind: "approval",
          approvalId: typeof item.approvalId === "string" ? item.approvalId : `approval-${index}`
        });
        return items;
      }
      if (item?.type === "approvalResolved") {
        metadata.approvals = upsertApprovalRun(metadata.approvals ?? [], {
          id: typeof item.approvalId === "string" ? item.approvalId : `approval-${index}`,
          toolCallId: typeof item.approvalId === "string" ? item.approvalId : "tool",
          toolName: "tool",
          input: {},
          status: item.approved === true ? "approved" : "rejected",
          resolutionReason: typeof item.reason === "string" ? item.reason : null
        });
        return items;
      }
      const name = typeof item.name === "string" ? item.name : "tool";
      const agentId = stableAgentId({
        agentId: typeof item.agentId === "string" ? item.agentId : null,
        configuredAgentId: typeof item.configuredAgentId === "string" ? item.configuredAgentId : null
      }) || null;
      const itemPayload = item as Record<string, unknown>;
      const toolPatch: AiToolRun = {
        id: typeof item.id === "string" ? item.id : typeof item.toolCallId === "string" ? item.toolCallId : `${name}-${index}`,
        name,
        arguments: readAiToolInput(itemPayload),
        result: item.result,
        summary: typeof item.summary === "string" ? item.summary : undefined,
        ok: typeof item.ok === "boolean" ? item.ok : undefined,
        allowed: typeof item.allowed === "boolean" ? item.allowed : undefined,
        blocked: typeof item.blocked === "boolean" ? item.blocked : undefined,
        policy: typeof item.policy === "string" ? item.policy : undefined,
        agentId,
        parentAgentId: typeof item.parentAgentId === "string" ? item.parentAgentId : null,
        startedAt: storedEventTime(itemPayload, "startedAt"),
        endedAt: storedEventTime(itemPayload, "endedAt"),
        requestedAt: storedEventTime(itemPayload, "requestedAt"),
        executionStartedAt: storedEventTime(itemPayload, "executionStartedAt"),
        executionEndedAt: storedEventTime(itemPayload, "executionEndedAt"),
        status:
          item.blocked === true
            ? "blocked"
            : item.type === "toolResult"
              ? item.ok === false
                ? "failed"
                : "done"
              : item.result !== undefined
                ? item.ok === false
                  ? "failed"
                  : "done"
              : "running"
      };
      if (agentId) {
        metadata.agents = upsertAgentToolRun(metadata.agents ?? [], agentId, toolPatch);
        metadata.timeline = appendTimeline(metadata.timeline, {
          id: `tool-${agentId}-${toolPatch.id}`,
          kind: "tool",
          toolId: toolPatch.id,
          agentId,
          createdAt: toolPatch.startedAt,
          updatedAt: toolPatch.endedAt ?? toolPatch.startedAt
        });
        return items;
      }
      metadata.timeline = appendTimeline(metadata.timeline, {
        id: `tool-main-${toolPatch.id}`,
        kind: "tool",
        toolId: toolPatch.id,
        agentId: null,
        createdAt: toolPatch.startedAt,
        updatedAt: toolPatch.endedAt ?? toolPatch.startedAt
      });
      return upsertToolRun(items, toolPatch);
    }, []);
    return metadata;
  } catch {
    return empty;
  }
}

function upsertToolRun(items: AiToolRun[], patch: AiToolRun) {
  const next = [...items];
  const index = next.findIndex((item) => item.id === patch.id || item.name === patch.name && item.status === "running");
  if (index >= 0) {
    next[index] = {
      ...next[index],
      ...patch,
      arguments: hasVisibleToolInput(patch.arguments) ? patch.arguments : next[index].arguments,
      result: patch.result ?? next[index].result,
      summary: patch.summary ?? next[index].summary,
      allowed: patch.allowed ?? next[index].allowed,
      blocked: patch.blocked ?? next[index].blocked,
      policy: patch.policy ?? next[index].policy,
      startedAt: patch.startedAt ?? next[index].startedAt,
      endedAt: patch.endedAt ?? next[index].endedAt
    };
    return next;
  }
  return [...next, patch];
}

function upsertApprovalRun(items: AiApprovalRun[], patch: AiApprovalRun) {
  const next = [...items];
  const index = next.findIndex((item) => item.id === patch.id);
  if (index >= 0) {
    next[index] = {
      ...next[index],
      ...patch,
      toolCallId: patch.toolCallId || next[index].toolCallId,
      toolName: patch.toolName === "tool" ? next[index].toolName : patch.toolName,
      input: Object.keys((patch.input as Record<string, unknown>) ?? {}).length > 0 ? patch.input : next[index].input,
      reason: patch.reason ?? next[index].reason,
      resolutionReason: patch.resolutionReason ?? next[index].resolutionReason
    };
    return next;
  }
  return [...next, patch];
}

function upsertAgentRun(items: AiAgentRun[], patch: AiAgentRun) {
  const next = [...items];
  const index = next.findIndex((item) => item.id === patch.id);
  if (index >= 0) {
    next[index] = {
      ...next[index],
      ...patch,
      title: patch.title || next[index].title,
      task: patch.task || next[index].task,
      startedAt: patch.startedAt ?? next[index].startedAt,
      endedAt: patch.endedAt ?? next[index].endedAt
    };
    return next;
  }
  return [...next, patch];
}

function upsertAgentToolRun(items: AiAgentRun[], agentId: string, toolPatch: AiToolRun) {
  const next = [...items];
  let index = next.findIndex((item) => item.id === agentId);
  if (index < 0) {
    next.push({
      id: agentId,
      title: "子代理任务",
      task: "",
      status: "running",
      tools: []
    });
    index = next.length - 1;
  }
  next[index] = {
    ...next[index],
    tools: upsertToolRun(next[index].tools ?? [], toolPatch)
  };
  return next;
}

function appendTimeline(items: AiTimelineItem[] | undefined, item: AiTimelineItem) {
  const next = [...(items ?? [])];
  if (next.some((entry) => entry.id === item.id)) return next;
  const now = Date.now();
  return [...next, { createdAt: now, updatedAt: now, ...item }];
}

function updateTimelineItem(items: AiTimelineItem[] | undefined, id: string, updatedAt = Date.now()) {
  if (!items?.length) return items;
  return items.map((item) => (item.id === id ? { ...item, updatedAt } : item));
}

export function appendAiTimelineText(message: AiUiMessage, kind: "text" | "reasoning", content: string) {
  if (!content) return message;
  return { ...message, timeline: appendTimelineText(message.timeline, kind, content) };
}

function appendTimelineText(
  items: AiTimelineItem[] | undefined,
  kind: "text" | "reasoning",
  content: string,
  id?: string
) {
  const next = [...(items ?? [])];
  const last = next.at(-1);
  const now = Date.now();
  if (last && (last.kind === "text" || last.kind === "reasoning") && last.kind === kind) {
    next[next.length - 1] = { ...last, content: `${last.content}${content}`, updatedAt: now };
  } else {
    next.push({ id: id ?? `${kind}-${now}-${next.length}`, kind, content, createdAt: now, updatedAt: now });
  }
  return next;
}

function buildProcessGroups(timeline: AiTimelineItem[]) {
  const groups: AiProcessGroup[] = [];
  for (const item of timeline) {
    const last = groups.at(-1);
    if (item.kind === "tool" && last?.kind === "tools") {
      last.items.push(item);
      continue;
    }
    if (item.kind === "team" && last?.kind === "team") {
      last.items.push(item);
      continue;
    }
    if (item.kind === "tool") {
      groups.push({ id: `tools-${item.id}`, kind: "tools", items: [item] });
    } else if (item.kind === "team") {
      groups.push({ id: `team-${item.id}`, kind: "team", items: [item] });
    } else if (item.kind === "text") {
      groups.push({ id: item.id, kind: "text", item });
    } else if (item.kind === "reasoning") {
      groups.push({ id: item.id, kind: "reasoning", item });
    } else if (item.kind === "agent") {
      groups.push({ id: item.id, kind: "agent", item });
    } else if (item.kind === "approval") {
      groups.push({ id: item.id, kind: "approval", item });
    }
  }
  return groups;
}

function minDefined(values: Array<number | undefined>) {
  const numbers = values.filter((value): value is number => Number.isFinite(value));
  return numbers.length ? Math.min(...numbers) : undefined;
}

function maxDefined(values: Array<number | undefined>) {
  const numbers = values.filter((value): value is number => Number.isFinite(value));
  return numbers.length ? Math.max(...numbers) : undefined;
}

function formatDuration(startedAt?: number, endedAt?: number) {
  if (!startedAt) return "";
  const end = endedAt ?? Date.now();
  const elapsed = Math.max(0, end - startedAt);
  if (elapsed < 1000) return `${elapsed}ms`;
  const seconds = Math.round(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function toolDurationLabel(tool: AiToolRun, now: number) {
  if (!tool.executionStartedAt) {
    return formatDuration(tool.startedAt, tool.endedAt ?? (tool.status === "running" ? now : undefined));
  }
  const execution = formatDuration(
    tool.executionStartedAt,
    tool.executionEndedAt ?? (tool.status === "running" ? now : undefined)
  );
  const queue = tool.requestedAt && tool.executionStartedAt - tool.requestedAt >= 1000
    ? formatDuration(tool.requestedAt, tool.executionStartedAt)
    : "";
  return [
    execution ? processText("executionDuration", "Execution {{duration}}", "执行 {{duration}}", { duration: execution }) : "",
    queue ? processText("queueDuration", "Queued {{duration}}", "排队 {{duration}}", { duration: queue }) : ""
  ].filter(Boolean).join(" · ");
}

function timelineDuration(timeline: AiTimelineItem[], fallbackEnd?: number) {
  const start = minDefined(timeline.map((item) => item.createdAt));
  const end = maxDefined(timeline.map((item) => item.updatedAt)) ?? fallbackEnd;
  return formatDuration(start, end);
}

export function updateLastAssistant(items: AiUiMessage[], patch: (message: AiUiMessage) => AiUiMessage) {
  const next = [...items];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index].role === "assistant") {
      next[index] = patch(next[index]);
      return next;
    }
  }
  next.push(patch({ id: `a-${Date.now()}`, role: "assistant", text: "", reasoning: "", tools: [], approvals: [] }));
  return next;
}

function toolStatusLabel(tool: AiToolRun) {
  if (tool.blocked || tool.status === "blocked") return processText("toolBlocked", "Blocked", "已阻断");
  if (tool.status === "failed" || tool.ok === false) return processText("failed", "Failed", "失败");
  if (tool.status === "done" || tool.ok === true) return processText("toolReturned", "Returned", "已返回");
  if (tool.allowed) return processText("running", "Running", "运行中");
  return processText("pendingAudit", "Pending audit", "待审计");
}

function toolActionLabel(tool: AiToolRun) {
  if (tool.name.startsWith("market.") || tool.name.startsWith("account.")) return processText("read", "Read", "读取");
  if (tool.name.startsWith("chart.create") || tool.name.startsWith("alert.create") || tool.name.startsWith("script.create")) return processText("create", "Create", "创建");
  if (tool.name.startsWith("chart.update") || tool.name.startsWith("alert.update") || tool.name.startsWith("script.enable")) return processText("update", "Update", "更新");
  if (tool.name.startsWith("chart.delete") || tool.name.startsWith("alert.delete") || tool.name.startsWith("script.delete")) return processText("delete", "Delete", "删除");
  if (tool.name.startsWith("trade.") || tool.name.startsWith("order.") || tool.name.startsWith("okx.")) return processText("execute", "Execute", "执行");
  return processText("run", "Run", "运行");
}

function approvalStatusLabel(status: AiApprovalRun["status"]) {
  if (status === "approved") return processText("approved", "Approved", "已批准");
  if (status === "rejected") return processText("rejected", "Rejected", "已拒绝");
  if (status === "expired") return processText("expired", "Expired", "已失效");
  return processText("pendingApproval", "Pending approval", "待批准");
}

function agentStatusLabel(status: AiAgentRun["status"]) {
  if (status === "queued") return processText("queued", "Queued", "排队中");
  if (status === "running") return processText("running", "Running", "运行中");
  if (status === "failed") return processText("failed", "Failed", "失败");
  if (status === "cancelled") return processText("cancelled", "Cancelled", "已取消");
  return processText("completed", "Completed", "已完成");
}

export function localizeAiMessageStatus(status: string) {
  const normalized = status.trim();
  const labels: Record<string, string> = {
    "生成结果": processText("responseGenerated", "Response generated", "生成结果"),
    "处理中": processText("processing", "Processing", "处理中"),
    "思考中": processText("reasoning", "Reasoning", "思考中"),
    "工具已阻断": processText("toolBlocked", "Tool blocked", "工具已阻断"),
    "调用工具": processText("callingTool", "Calling tool", "调用工具"),
    "工具结果已返回": processText("toolResultReturned", "Tool result returned", "工具结果已返回"),
    "工具读取失败": processText("toolReadFailed", "Tool read failed", "工具读取失败"),
    "子代理执行中": processText("subagentRunning", "Subagent running", "子代理执行中"),
    "子代理已完成": processText("subagentCompleted", "Subagent completed", "子代理已完成"),
    "团队任务更新": processText("teamTaskUpdates", "Team task updates", "团队任务更新"),
    "等待工具审批": processText("waitingToolApproval", "Waiting for tool approval", "等待工具审批"),
    "已批准工具执行": processText("toolExecutionApproved", "Tool execution approved", "已批准工具执行"),
    "已拒绝工具执行": processText("toolExecutionRejected", "Tool execution rejected", "已拒绝工具执行"),
    "已停止": processText("stopped", "Stopped", "已停止"),
    "生成中": processText("generating", "Generating", "生成中")
  };
  return labels[normalized] ?? normalized;
}

export function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
