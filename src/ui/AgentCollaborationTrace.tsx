import { useMemo, type ReactNode } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  CircleDashed,
  Clock3,
  Gauge,
  ListChecks,
  Loader2,
  Network,
  ShieldAlert,
  ShieldCheck,
  Target,
  UsersRound
} from "lucide-react";
import clsx from "clsx";
import {
  buildAiAgentTrace,
  parseAiAgentResult,
  type AiAgentReport,
  type AiAgentTraceItem,
  type AiAgentTraceTool
} from "../lib/aiAgentTrace";

type AgentCollaborationTraceProps = {
  events: unknown[];
  runStatus: string;
};

function statusLabel(status: AiAgentTraceItem["status"]) {
  if (status === "done") return "已返回";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  return "运行中";
}

function toolStatusLabel(status: AiAgentTraceTool["status"]) {
  if (status === "done") return "完成";
  if (status === "failed") return "失败";
  if (status === "blocked") return "已阻止";
  return "运行中";
}

function StatusIcon({ status }: { status: AiAgentTraceItem["status"] }) {
  if (status === "running") return <Loader2 className="spin" size={13} />;
  if (status === "done") return <CheckCircle2 size={13} />;
  if (status === "failed") return <AlertTriangle size={13} />;
  return <CircleDashed size={13} />;
}

function ToolStatusIcon({ status }: { status: AiAgentTraceTool["status"] }) {
  if (status === "running") return <Loader2 className="spin" size={11} />;
  if (status === "done") return <CheckCircle2 size={11} />;
  if (status === "failed" || status === "blocked") return <AlertTriangle size={11} />;
  return <CircleDashed size={11} />;
}

function formatValue(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function formatElapsed(startedAt?: number, endedAt?: number) {
  if (!startedAt) return "";
  const elapsed = Math.max(0, (endedAt ?? Date.now()) - startedAt);
  if (elapsed < 1000) return `${elapsed}ms`;
  const seconds = Math.round(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function formatToolElapsed(tool: AiAgentTraceTool) {
  if (!tool.executionStartedAt) return formatElapsed(tool.startedAt, tool.endedAt);
  const execution = formatElapsed(tool.executionStartedAt, tool.executionEndedAt);
  const queue = tool.requestedAt && tool.executionStartedAt - tool.requestedAt >= 1000
    ? formatElapsed(tool.requestedAt, tool.executionStartedAt)
    : "";
  return [execution ? `执行 ${execution}` : "", queue ? `排队 ${queue}` : ""]
    .filter(Boolean)
    .join(" · ");
}

function reportStatusLabel(status: string) {
  if (status === "success") return "证据完整";
  if (status === "partial") return "证据不完整";
  if (status === "blocked") return "无法完成";
  return status || "未声明";
}

function stanceLabel(stance: string) {
  if (stance === "bullish") return "偏多";
  if (stance === "bearish") return "偏空";
  if (stance === "neutral") return "中性";
  if (stance === "risk") return "风险";
  return stance || "未声明";
}

function finishReasonLabel(reason: string) {
  if (reason === "completed") return "正常完成";
  if (reason === "max_iterations") return "达到轮次上限";
  if (reason === "cancelled" || reason === "canceled") return "已取消";
  if (reason === "error") return "运行错误";
  return reason;
}

function reportTone(value: string) {
  if (value === "success") return "success";
  if (value === "bullish") return "positive";
  if (["bearish"].includes(value)) return "negative";
  if (["partial", "blocked", "risk"].includes(value)) return "warning";
  return "neutral";
}

function ReportList({
  title,
  items,
  icon,
  tone = "neutral",
  defaultOpen = false
}: {
  title: string;
  items: string[];
  icon: ReactNode;
  tone?: "neutral" | "warning" | "negative";
  defaultOpen?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <details className={clsx("automation-agent-report-list", `tone-${tone}`)} open={defaultOpen}>
      <summary>{icon}<strong>{title}</strong><span>{items.length}</span></summary>
      <ul>{items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}</ul>
    </details>
  );
}

function StructuredAgentReport({ report, result }: { report: AiAgentReport; result: unknown }) {
  const summary = parseAiAgentResult(result);
  const statusTone = reportTone(report.status);
  const stanceTone = reportTone(report.stance);
  return (
    <div className="automation-agent-report">
      <div className="automation-agent-report-facts">
        <span data-tone={statusTone}><i />报告状态<strong>{reportStatusLabel(report.status)}</strong></span>
        <span data-tone={stanceTone}><Target size={12} />倾向<strong>{stanceLabel(report.stance)}</strong></span>
        {report.confidence !== undefined ? (
          <span className="confidence"><Gauge size={12} />置信度<strong>{report.confidence}%</strong><i><b style={{ width: `${report.confidence}%` }} /></i></span>
        ) : null}
        {report.timeHorizon ? <span><Clock3 size={12} />观察周期<strong>{report.timeHorizon}</strong></span> : null}
        {summary.iterations !== undefined ? <span><CircleDashed size={12} />推理轮次<strong>{summary.iterations}</strong></span> : null}
        {summary.finishReason ? <span><CheckCircle2 size={12} />结束原因<strong>{finishReasonLabel(summary.finishReason)}</strong></span> : null}
      </div>

      {report.recommendation ? (
        <section className="automation-agent-report-conclusion">
          <span>结论</span>
          <p>{report.recommendation}</p>
        </section>
      ) : null}

      {report.veto ? (
        <section className="automation-agent-report-veto">
          <ShieldAlert size={14} />
          <span><strong>提出风险否决</strong><small>{report.vetoReason || "未说明否决原因"}</small></span>
        </section>
      ) : null}

      <div className="automation-agent-report-groups">
        <ReportList title="关键证据" items={report.evidence} icon={<ListChecks size={12} />} defaultOpen />
        <ReportList title="主要风险" items={report.risks} icon={<AlertTriangle size={12} />} tone="warning" defaultOpen />
        <ReportList title="失效条件" items={report.invalidation} icon={<Target size={12} />} tone="negative" />
        <ReportList title="数据缺口" items={report.missingData} icon={<CircleDashed size={12} />} tone="warning" />
      </div>

      <details className="automation-agent-report-raw">
        <summary>查看原始数据</summary>
        <pre>{formatValue(result)}</pre>
      </details>
    </div>
  );
}

function AgentResult({ result }: { result: unknown }) {
  const summary = parseAiAgentResult(result);
  if (summary.report) return <StructuredAgentReport report={summary.report} result={result} />;
  if (summary.text) return <p className="automation-agent-result-text">{summary.text}</p>;
  return (
    <details className="automation-agent-report-raw">
      <summary>查看原始数据</summary>
      <pre>{formatValue(result)}</pre>
    </details>
  );
}

function AgentLane({ agent, index }: { agent: AiAgentTraceItem; index: number }) {
  const agentDuration = formatElapsed(agent.startedAt, agent.endedAt);
  const failureMessage = agent.failure?.message || agent.error;
  const failureLabel = agent.failure?.kind === "model"
    ? "模型服务错误"
    : /报告|JSON|字段|校验/.test(failureMessage || "")
      ? "未通过校验"
      : "Agent 失败";
  return (
    <details className={clsx("automation-agent-trace-lane", `status-${agent.status}`)}>
      <summary>
        <span className="automation-agent-trace-index">{index + 1}</span>
        <span className="automation-agent-node"><UsersRound size={12} /></span>
        <span className="automation-agent-trace-copy">
          <strong>{agent.title || agent.role || `Agent ${index + 1}`}</strong>
          <small>{agent.task || agent.role || "委派分析任务"}</small>
        </span>
        <span className="automation-agent-trace-meta">{agent.tools.length} 工具</span>
        <span className="automation-agent-trace-status"><StatusIcon status={agent.status} />{statusLabel(agent.status)}{agentDuration ? ` · ${agentDuration}` : ""}</span>
      </summary>
      <div className="automation-agent-trace-detail">
        {agent.tools.length > 0 ? (
          <div className="automation-agent-trace-tools">
            {agent.tools.map((tool) => (
              <div className={clsx("automation-agent-trace-tool", `status-${tool.status}`)} key={tool.id}>
                <ToolStatusIcon status={tool.status} />
                <code>{tool.name}</code>
                <span>{tool.summary || toolStatusLabel(tool.status)}</span>
                {formatToolElapsed(tool) ? <time>{formatToolElapsed(tool)}</time> : null}
              </div>
            ))}
          </div>
        ) : <span className="automation-agent-trace-empty">本任务未调用工具</span>}
        {failureMessage ? <p className="automation-agent-trace-error"><AlertTriangle size={12} />{failureLabel}：{failureMessage}</p> : null}
        {agent.result !== undefined && agent.result !== null ? (
          <details className="automation-agent-result">
            <summary>{agent.failure?.kind === "model" ? "原始响应" : "分析报告"}</summary>
            <AgentResult result={agent.result} />
          </details>
        ) : null}
      </div>
    </details>
  );
}

function coordinatorStatus(runStatus: string) {
  if (runStatus === "completed") return "已汇总";
  if (["failed", "cancelled", "canceled"].includes(runStatus)) return "未完成";
  return "处理中";
}

export function AgentCollaborationTrace({ events, runStatus }: AgentCollaborationTraceProps) {
  const trace = useMemo(() => buildAiAgentTrace(events), [events]);
  if (trace.agents.length === 0 && trace.teamEvents.length === 0) return null;

  const done = trace.agents.filter((agent) => agent.status === "done").length;
  const abnormal = trace.agents.filter((agent) => agent.status === "failed" || agent.status === "cancelled").length;
  const reviewAgents = trace.agents.filter((agent) => agent.role === "contrarian" || /反方|审查|contrarian|challenger/i.test(`${agent.title} ${agent.role || ""}`));
  const primaryAgents = trace.agents.filter((agent) => !reviewAgents.includes(agent));

  return (
    <section className="automation-run-section automation-agent-trace-section">
      <h3><Network size={14} />协作轨迹 <span>{trace.agents.length} Agent · {done} 已返回{abnormal ? ` · ${abnormal} 异常` : ""}</span></h3>
      <div className="automation-agent-trace-flow">
        <div className="automation-agent-trace-stage stage-lead">
          <span className="automation-agent-node lead"><Bot size={14} /></span>
          <span><strong>任务分配</strong><small>主 Agent</small></span>
          <CheckCircle2 size={12} />
        </div>

        <div className="automation-agent-trace-lanes">
          <div className="automation-agent-trace-phase">
            <span>第一阶段</span><strong>并行取证</strong><em>{primaryAgents.length} Agent</em>
          </div>
          {primaryAgents.map((agent, index) => <AgentLane agent={agent} index={index} key={agent.id} />)}
          {reviewAgents.length > 0 ? (
            <>
              <div className="automation-agent-trace-phase review">
                <span>第二阶段</span><strong>反方审查</strong><em>{reviewAgents.length} Agent</em>
              </div>
              {reviewAgents.map((agent, index) => <AgentLane agent={agent} index={primaryAgents.length + index} key={agent.id} />)}
            </>
          ) : null}
        </div>

        <div className={clsx("automation-agent-trace-stage stage-merge", `status-${runStatus}`)}>
          <span className="automation-agent-node lead"><ShieldCheck size={14} /></span>
          <span><strong>证据汇总</strong><small>主 Agent</small></span>
          <em>{coordinatorStatus(runStatus)}</em>
        </div>
      </div>
      {trace.teamEvents.length > 0 ? (
        <details className="automation-team-event-raw">
          <summary>协调事件 · {trace.teamEvents.length}</summary>
          <pre>{formatValue(trace.teamEvents)}</pre>
        </details>
      ) : null}
    </section>
  );
}

export default AgentCollaborationTrace;
