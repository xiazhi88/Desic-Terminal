import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowRightLeft,
  Bot,
  ChevronRight,
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
import { useTranslation } from "react-i18next";
import { formatGrantedScopes } from "../lib/aiExpertGrant";
import { AiMarkdown } from "./AiMarkdown";
import { useDraggableSurface } from "./useDraggableSurface";
import {
  buildAiAgentTrace,
  parseAiAgentResult,
  type AiAgentReport,
  type AiAgentTraceItem,
  type AiAgentTraceTool
} from "../lib/aiAgentTrace";
import type { AiRunExpert } from "../types";

type AgentCollaborationTraceProps = {
  events: unknown[];
  runStatus: string;
  /** C23.2：Rust 落库的逐专家详情（`run.experts`）；缺字段按老记录处理。 */
  experts?: unknown;
};

/** C23.2：逐专家详情的宽松读取（缺字段/类型不符一律忽略，由 UI 显示占位）。 */
function asRecordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function readRunExperts(value: unknown): AiRunExpert[] {
  return (Array.isArray(value) ? value : [])
    .map((item) => {
      const record = asRecordValue(item);
      const tokenRecord = asRecordValue(record.tokenUsage);
      const numberOrNull = (source: unknown) => {
        const parsed = Number(source);
        return Number.isFinite(parsed) ? parsed : undefined;
      };
      return {
        // Rust 保证这些键始终存在（缺内容时是空字符串）；这里仍做类型兜底，兼容旧快照。
        id: typeof record.id === "string" ? record.id : undefined,
        expertId: stringOrUndefined(record.expertId),
        configuredAgentId: stringOrUndefined(record.configuredAgentId),
        agentId: stringOrUndefined(record.agentId),
        name: stringOrUndefined(record.name),
        expertName: stringOrUndefined(record.expertName),
        role: stringOrUndefined(record.role),
        mode: record.mode === "parallel" || record.mode === "serial" ? record.mode : undefined,
        grantedScopes: Array.isArray(record.grantedScopes) ? record.grantedScopes.map((scoped) => String(scoped)) : undefined,
        taskPrompt: typeof record.taskPrompt === "string" ? record.taskPrompt : undefined,
        report: typeof record.report === "string" ? record.report : undefined,
        toolCalls: numberOrNull(record.toolCalls),
        durationMs: numberOrNull(record.durationMs),
        startedAt: numberOrNull(record.startedAt),
        endedAt: numberOrNull(record.endedAt),
        tokenUsage: Object.keys(tokenRecord).length > 0 ? {
          inputTokens: numberOrNull(tokenRecord.inputTokens),
          outputTokens: numberOrNull(tokenRecord.outputTokens),
          totalTokens: numberOrNull(tokenRecord.totalTokens)
        } : null,
        tokensUnavailable: record.tokensUnavailable === true
      };
    });
}

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

/**
 * C23.2：逐专家详情弹层。
 *
 * 数据来源：`run.experts[i]`（Rust 落库的 `taskPrompt` / `report` / `tokenUsage` / `durationMs` / `toolCalls`）
 * 叠加 lane 上已有的执行方式、授予范围与工具行。缺字段一律显示「该运行未记录此字段（老记录）」。
 */
function AgentDetailDialog({
  agent,
  expert,
  overlapMs,
  onClose
}: {
  agent: AiAgentTraceItem;
  expert: AiRunExpert | null;
  overlapMs: number;
  onClose: () => void;
}) {
  const { t } = useTranslation(["automation", "common"]);
  const dialogDrag = useDraggableSurface<HTMLElement>();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const missing = t("agentDetailMissing");
  const mode = expert?.mode ?? agent.mode;
  const grantedScopes = expert?.grantedScopes ?? agent.grantedScopes;
  const allScopes = expert?.grantedScopes ? expert.grantedScopes.length >= 5 : agent.grantedAllScopes === true;
  const taskPrompt = expert?.taskPrompt?.trim() || agent.taskPrompt?.trim() || "";
  const report = expert?.report?.trim() || (typeof agent.result === "string" ? agent.result.trim() : "");
  const durationMs = expert?.durationMs ?? (agent.startedAt ? (agent.endedAt ?? Date.now()) - agent.startedAt : undefined);
  const toolCalls = expert?.toolCalls ?? agent.tools.length;
  const tokens = expert?.tokenUsage ?? null;
  const tokensUnavailable = expert?.tokensUnavailable === true || (!tokens && expert !== null);

  return createPortal(
    <div
      className="modal-backdrop automation-agent-detail-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        ref={dialogDrag.surfaceRef}
        className="modal-shell automation-agent-detail"
        role="dialog"
        aria-modal="true"
        aria-label={`${t("agentDetailTitle")} · ${agent.title || agent.id}`}
        data-agent-detail
        data-agent-id={agent.id}
      >
        <header className="modal-head automation-agent-detail__head" {...dialogDrag.handleProps}>
          <div>
            <strong>{agent.title || agent.role || agent.id}</strong>
            <span>
              {(expert?.role || agent.role) ? <em className="automation-agent-detail__role">{expert?.role || agent.role}</em> : null}
              <em className={`automation-agent-trace-mode is-${mode}`}>{mode === "parallel" ? "并行" : "串行"}</em>
            </span>
          </div>
          <button ref={closeRef} className="window-button" type="button" onClick={onClose} title={t("common:close")} aria-label={t("common:close")}>✕</button>
        </header>
        <div className="automation-agent-detail__body">
          <dl className="automation-agent-detail__usage" data-agent-detail-usage>
            <div>
              <dt>{t("agentDetailMode")}</dt>
              <dd data-agent-detail-mode>{mode === "parallel" ? "并行" : "串行"}{overlapMs > 0 ? ` · 与上一位重叠 ${Math.round(overlapMs / 1000)}s` : ""}</dd>
            </div>
            <div>
              <dt>{t("agentDetailScopes")}</dt>
              <dd data-agent-detail-scopes>
                {grantedScopes && grantedScopes.length > 0
                  ? formatGrantedScopes(grantedScopes, allScopes, (_key, _en, zh) => zh)
                  : missing}
              </dd>
            </div>
            <div>
              <dt>{t("agentDetailDuration")}</dt>
              <dd data-agent-detail-duration>{durationMs !== undefined ? formatElapsed(agent.startedAt ?? Date.now() - durationMs, agent.startedAt ? (agent.startedAt + durationMs) : Date.now()) : missing}</dd>
            </div>
            <div>
              <dt>{t("agentDetailTokens")}</dt>
              <dd data-agent-detail-tokens>
                {tokens && (tokens.inputTokens !== undefined || tokens.outputTokens !== undefined)
                  ? `${formatTokenCount(tokens.inputTokens)} / ${formatTokenCount(tokens.outputTokens)}`
                  : tokensUnavailable ? "未报告" : missing}
              </dd>
            </div>
            <div>
              <dt>{t("agentDetailTools")}</dt>
              <dd data-agent-detail-tools>{toolCalls !== undefined ? String(toolCalls) : missing}</dd>
            </div>
          </dl>

          <div className="automation-agent-detail__block">
            <strong>{t("agentDetailTask")}</strong>
            {/* C23.2：证据原文逐字呈现 —— `data-i18n-skip` 豁免 legacy i18n bridge 的改写。
                缺内容时占位仍挂在同一钩子上，断言不必区分两种分支。 */}
            {taskPrompt
              ? <pre className="automation-agent-detail__task" data-agent-detail-task data-i18n-skip>{taskPrompt}</pre>
              : <pre className="automation-agent-detail__task is-missing" data-agent-detail-task data-agent-detail-task-missing data-i18n-skip>{missing}</pre>}
          </div>

          <div className="automation-agent-detail__block">
            <strong>{t("agentDetailReport")}</strong>
            {/* 同上：报告是证据原文，必须逐字呈现，不能被 i18n bridge 改写。 */}
            <div className="automation-agent-detail__report" data-agent-detail-report data-i18n-skip>
              {report ? <AiMarkdown content={report} /> : <p className="automation-agent-detail__missing">{missing}</p>}
            </div>
          </div>
        </div>
      </section>
    </div>,
    document.body
  );
}

function AgentLane({ agent, index, overlapMs = 0, onOpen }: { agent: AiAgentTraceItem; index: number; overlapMs?: number; onOpen?: () => void }) {
  const { t } = useTranslation(["automation", "common"]);
  const agentDuration = formatElapsed(agent.startedAt, agent.endedAt);
  const windowLabel = laneWindowLabel(agent);
  const failureMessage = agent.failure?.message || agent.error;
  const failureLabel = agent.failure?.kind === "model"
    ? "模型服务错误"
    : /报告|JSON|字段|校验/.test(failureMessage || "")
      ? "未通过校验"
      : "Agent 失败";
  return (
    <details
      className={clsx("automation-agent-trace-lane", `status-${agent.status}`, `mode-${agent.mode}`)}
      data-agent-lane
      data-agent-mode={agent.mode}
      data-agent-id={agent.id}
      /* 原始时间戳：供 smoke 直接断言"并行专家时间区间重叠、串行专家不重叠"。 */
      data-agent-start={agent.startedAt ?? undefined}
      data-agent-end={agent.endedAt ?? undefined}
    >
      <summary>
        <span className="automation-agent-trace-index">{index + 1}</span>
        <span className="automation-agent-node"><UsersRound size={12} /></span>
        <span className="automation-agent-trace-copy">
          <strong>{agent.title || agent.role || `Agent ${index + 1}`}</strong>
          <small>{agent.task || agent.role || "委派分析任务"}</small>
        </span>
        {/* 元信息组：占 summary 的第 4 列（auto），内部横向排列，避免撑坏既有 5 列栅格。 */}
        <span className="automation-agent-trace-metas">
          {/* C18.3：执行方式（来自 consult_experts 的 results[].mode；单点咨询按串行呈现）。 */}
          <span
            className={clsx("automation-agent-trace-mode", `is-${agent.mode}`)}
            data-agent-lane-mode
            title={agent.mode === "parallel" ? "与同批次专家并发执行" : "与其它专家不重叠（等待前序批次结束）"}
          >
            {agent.mode === "parallel" ? <ArrowRightLeft size={10} /> : <ChevronRight size={10} />}
            {agent.mode === "parallel" ? "并行" : "串行"}
          </span>
          <span className="automation-agent-trace-meta">{agent.tools.length} 工具</span>
          {/* C15.3：专家会话那一步显示本次授予范围（缺省全量时显示"全部只读"）。 */}
          {agent.grantedScopes ? (
            <span className="automation-agent-trace-meta" data-agent-granted-scopes>
              {formatGrantedScopes(agent.grantedScopes, agent.grantedAllScopes === true, (_key, _en, zh) => zh)}
            </span>
          ) : null}
          {/* C18.3：真实起止时刻 + 与更早专家的一段时间重叠，避免纵向排列被读成"两波"。 */}
          {onOpen ? (
          <button
            type="button"
            className="automation-agent-trace-open"
            data-agent-lane-open
            data-agent-id={agent.id}
            title={t("agentDetailOpen")}
            onClick={(event) => {
              // summary 的默认行为是展开/收起；这里只打开详情，不改变展开状态。
              event.preventDefault();
              event.stopPropagation();
              onOpen();
            }}
          >
            {t("agentDetailOpen")}
          </button>
        ) : null}
        {windowLabel ? (
            <span className="automation-agent-trace-window" data-agent-lane-window>
              {windowLabel}
              {/* 措辞与 smoke 断言一致（`/与上一位重叠 \d+s/`）：与更早的某位专家时间区间重叠。 */}
              {overlapMs > 0 ? ` · 与上一位重叠 ${Math.round(overlapMs / 1000)}s` : ""}
            </span>
          ) : null}
        </span>
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

/** C18.3：lane 头部显示真实起止时刻，避免"按顺序纵向排列"被读成两波编排。 */
function formatClock(value?: number) {
  if (!value) return "";
  const date = new Date(value);
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function laneWindowLabel(agent: AiAgentTraceItem) {
  const start = formatClock(agent.startedAt);
  const end = formatClock(agent.endedAt);
  if (!start) return "";
  return end ? `${start}–${end}` : `${start}–进行中`;
}

/** 与"上一条已结束时间"重叠的毫秒数：>0 说明这一位和前面某位确实同时在场。 */
function overlapWithPrevious(agents: AiAgentTraceItem[], index: number) {
  const current = agents[index];
  if (!current?.startedAt) return 0;
  const currentEnd = current.endedAt ?? Date.now();
  let overlap = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    const previous = agents[cursor];
    if (!previous?.startedAt) continue;
    const previousEnd = previous.endedAt ?? Date.now();
    overlap = Math.max(overlap, Math.min(currentEnd, previousEnd) - Math.max(current.startedAt, previous.startedAt));
  }
  return Math.max(0, overlap);
}

/** token 展示：万级用 K/M，与运行详情既有口径一致。 */
function formatTokenCount(value: number | undefined) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return "0";
  if (parsed >= 1_000_000) return `${(parsed / 1_000_000).toFixed(parsed >= 10_000_000 ? 0 : 1)}M`;
  if (parsed >= 1_000) return `${(parsed / 1_000).toFixed(parsed >= 100_000 ? 0 : 1)}K`;
  return String(Math.round(parsed));
}

function coordinatorStatus(runStatus: string) {
  if (runStatus === "completed") return "已汇总";
  if (["failed", "cancelled", "canceled"].includes(runStatus)) return "未完成";
  return "处理中";
}

export function AgentCollaborationTrace({ events, runStatus, experts }: AgentCollaborationTraceProps) {
  const trace = useMemo(() => buildAiAgentTrace(events), [events]);
  const runExperts = useMemo(() => readRunExperts(experts), [experts]);
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  // lane 的 id 来自事件的 `configuredAgentId`（库 id）；Rust 侧同样以它为主键，
  // 因此匹配顺序：configuredAgentId → expertId → agentId → 名称。
  const findExpert = useCallback((agent: AiAgentTraceItem) => runExperts.find((item) => (
    item.configuredAgentId === agent.id || item.expertId === agent.id || item.agentId === agent.id || item.id === agent.id
    || (!!agent.title && (item.name === agent.title || item.expertName === agent.title))
    || (!!agent.role && item.role === agent.role)
  )) ?? null, [runExperts]);
  const openAgent = openAgentId ? trace.agents.find((agent) => agent.id === openAgentId) ?? null : null;
  if (trace.agents.length === 0 && trace.teamEvents.length === 0) return null;

  const done = trace.agents.filter((agent) => agent.status === "done").length;
  const abnormal = trace.agents.filter((agent) => agent.status === "failed" || agent.status === "cancelled").length;
  // C18.3：v3 只有"按需点名"一种编排 —— 不再有第二阶段/反方审查波次，
  // 专家按点名顺序排列，执行方式与时间重叠由 lane 上的 mode / 时刻如实呈现。
  const dispatchAgents = trace.agents;
  const parallelCount = dispatchAgents.filter((agent) => agent.mode === "parallel").length;
  const serialCount = dispatchAgents.length - parallelCount;

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
          {/* 没有专家时不渲染空阶段（C18.3）。 */}
          {dispatchAgents.length > 0 ? (
            <div className="automation-agent-trace-phase" data-agent-phase data-phase-kind="dispatch">
              <span>专家取证</span>
              <strong>按需点名</strong>
              <em>{dispatchAgents.length} Agent{parallelCount > 0 ? ` · ${parallelCount} 并行` : ""}{serialCount > 0 ? ` · ${serialCount} 串行` : ""}</em>
            </div>
          ) : null}
          {dispatchAgents.map((agent, index) => (
            <AgentLane
              agent={agent}
              index={index}
              overlapMs={overlapWithPrevious(dispatchAgents, index)}
              onOpen={() => setOpenAgentId(agent.id)}
              key={agent.id}
            />
          ))}
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
      {openAgent ? (
        <AgentDetailDialog
          agent={openAgent}
          expert={findExpert(openAgent)}
          overlapMs={overlapWithPrevious(dispatchAgents, dispatchAgents.indexOf(openAgent))}
          onClose={() => setOpenAgentId(null)}
        />
      ) : null}
    </section>
  );
}

export default AgentCollaborationTrace;
