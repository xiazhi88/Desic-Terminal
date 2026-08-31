import { lazy, Suspense, useState, type Dispatch, type SetStateAction } from "react";
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import clsx from "clsx";
import { getAiAgentFailure } from "../lib/aiAgentTrace";
import { filterInternalAiToolEvents } from "../lib/aiToolEvents";
import { logger } from "../lib/logger";
import type { AiContextUsage, AiEvent, AiStoredMessage } from "../types";
import { formatLocalizedNumber, i18n } from "../i18n/runtime";
import { AiToolDomainIcon } from "./AiToolDomainIcon";
import { getAiToolPresentation, getAiToolDomainLabel } from "./aiToolPresentation";

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
  finishReason?: string;
  tools: AiToolRun[];
  approvals?: AiApprovalRun[];
  agents?: AiAgentRun[];
  teamEvents?: unknown[];
  timeline?: AiTimelineItem[];
  usage?: unknown;
  usageIsSessionCumulative?: boolean;
  contextUsage?: AiContextUsage;
  createdAt?: number;
  startedAt?: number;
  firstTokenAt?: number;
  completedAt?: number;
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
  messageId?: string;
  startedAt?: number;
  endedAt?: number;
  requestedAt?: number;
  executionStartedAt?: number;
  executionEndedAt?: number;
  status: "pending" | "running" | "done" | "blocked" | "failed";
};

export type AiResearchArtifact = {
  id: string;
  kind: "market" | "strategy" | "skill" | "intelligence" | "account" | "trade" | "research";
  title: string;
  summary: string;
  data: unknown;
  toolName?: string;
  facts?: Array<[string, string]>;
  sourceMessageId?: string;
  strategyId?: string;
  runId?: string;
  optimizationId?: string;
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
  | { id: string; kind: "reasoning-summary"; content: string; createdAt?: number; updatedAt?: number }
  | { id: string; kind: "tool"; toolId: string; agentId?: string | null; createdAt?: number; updatedAt?: number }
  | { id: string; kind: "agent"; agentId: string; createdAt?: number; updatedAt?: number }
  | { id: string; kind: "approval"; approvalId: string; createdAt?: number; updatedAt?: number }
  | { id: string; kind: "team"; index: number; createdAt?: number; updatedAt?: number };

type AiProcessGroup =
  | { id: string; kind: "text"; item: Extract<AiTimelineItem, { kind: "text" }> }
  | { id: string; kind: "reasoning"; item: Extract<AiTimelineItem, { kind: "reasoning" }> }
  | { id: string; kind: "reasoning-summaries"; items: Extract<AiTimelineItem, { kind: "reasoning-summary" }>[] }
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
  if (/AgentRuntimeAbortError: session_stop/i.test(message)) return processText("intentionalStop", "Stopped by user. The current run was cancelled before the provider finished.", "已由用户停止，本轮请求在模型完成前取消。");
  if (/^reconnecting(?:\.{3})?\s+\d+\/\d+/i.test(message)) return processText("providerReconnecting", "The model provider is reconnecting because of a transient network issue. The desktop retry policy is handling the turn; existing text or tool progress is not replayed automatically.", "模型服务因瞬态网络问题正在重连。桌面重试策略正在处理本轮请求；已有文本或工具进度不会自动重放，以避免重复副作用。");
  if (/^request timed out\.?$/i.test(message)) return processText("requestIdleTimeout", "The model produced no new response before the idle limit. The run stopped. Existing text or tool activity is never replayed automatically; retry the prompt when ready.", "模型在空闲限制内没有产生新响应，本次请求已停止。已有文本或工具活动不会自动重放，以避免重复操作；可在准备好后重试该提问。");
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

// —— B1 工具 IO 结构化：高频工具键值卡 + "原始"兜底 chip ——
// 数据形状来源：src/ui/ai-research/fixtures.ts 实测 + aiToolPresentation.ts PRESENTATIONS 高频工具。
// 未识别工具不进入本节，保持原有 JSON 渲染（details.ai-tool-raw），不改动任何数据流。

type AiToolIoRow = {
  key: string;
  label: string;
  value: string;
  truncated: boolean;
  full?: string;
};

const AI_TOOL_IO_VALUE_LIMIT = 72;
// B2：回退扫描总条目上限放宽到 10（覆盖"共 N 项 + 首项字段"的数组行组）。
const AI_TOOL_IO_ROW_CAP = 10;
// B2：递归扁平化深度上限——顶层为第 1 层，嵌套对象/数组首项字段为第 2 层。
const AI_TOOL_IO_DEPTH_LIMIT = 2;
const AI_TOOL_IO_NOISE_KEY = /^(content|contentSha256|sourceEventSeqs|seqId)$/i;

// 高频工具的首选字段路径（点号路径，如 strategy.id）。一条都未命中时回退到 B2 递归扁平化，保持数据真实。
// B2 形状校对（src-tauri/src/lib.rs 只读确认）：market.readTicker / readFundingRate / readInstrument
// 均返回 { source, ageMs, summary, <载荷对象> }，真实字段在载荷对象内部（此前按顶层扁平形状书写，全部落空）。
// radar.compareMarkets 返回 { snapshotAt, modelVersion, universeSize, markets: [...], readOnly, limitations }。
const AI_TOOL_IO_FIELD_PATHS: Record<string, { input?: string[]; output?: string[] }> = {
  "market.readTicker": { input: ["instId"], output: ["ticker.instId", "ticker.last", "ticker.high24h", "ticker.low24h", "ticker.volCcy24h", "ticker.askPx", "ticker.bidPx", "ticker.open24h"] },
  "market.readCandles": { input: ["instId", "bar", "limit"], output: ["instId", "bar", "latestConfirmedAt", "candles"] },
  "market.readInstrument": { input: ["instId"], output: ["instrument.instId", "instrument.state", "instrument.ctVal", "instrument.lever", "instrument.tickSz", "instrument.lotSz", "instrument.settleCcy", "instrument.instType"] },
  "market.readFundingRate": { input: ["instId"], output: ["fundingRate.instId", "fundingRate.fundingRate", "fundingRate.nextFundingRate"] },
  "market.readDecisionContext": { input: ["instId"], output: ["instId", "last", "asOf", "generatedAt"] },
  "account.readSnapshot": { input: ["instId"], output: ["instId", "totalEq", "availEq", "lever", "mgnMode", "positionCount", "orderCount"] },
  "strategy.create": { input: ["name", "description", "parameters"], output: ["strategy.id", "strategy.name", "strategy.version", "strategy.status", "createdVersion", "saved"] },
  "strategy.backtest": { input: ["strategyId", "runId", "instId", "bar", "lookback"], output: ["strategyId", "runId", "status", "metrics.totalReturn", "metrics.maxDrawdown", "metrics.winRate", "tradeCount"] },
  "strategy.optimize": { input: ["strategyId", "runId", "iterations"], output: ["strategyId", "runId", "status", "best.score", "trialCount"] },
  "chart.createIndicator": { input: ["chartId", "name", "kind"], output: ["chartId", "indicatorId", "name", "status"] },
  "trade.precheck": { input: ["instId", "side", "sz", "ordType"], output: ["instId", "side", "ok", "verdict", "reason"] },
  "trade.submit": { input: ["instId", "side", "sz", "ordType"], output: ["instId", "ordId", "clOrdId", "status", "avgPx"] },
  "radar.compareMarkets": { input: ["instIds"], output: ["universeSize", "modelVersion", "markets"] },
  "radar.readRanking": { input: ["instId", "limit"], output: ["instId", "rowCount", "updatedAt"] },
  "research.webSearch": { input: ["query", "limit"], output: ["query", "resultCount", "provider"] },
  "skill.read": { input: ["skillId"], output: ["skillId", "name", "version"] }
};

function isStructuredIoTool(tool: AiToolRun): boolean {
  const canonicalName = getAiToolPresentation(tool.name).canonicalName;
  if (AI_TOOL_IO_FIELD_PATHS[canonicalName]) return true;
  // 已知业务域前缀（对齐 aiToolPresentation.inferDomain）；system / mcp 兜底工具保持原始 JSON。
  return /^(?:market|okx|account|position|strategy|profile|chart|indicator|trade|order|radar|research|intelligence|skill|skills|agent|subagent)\./i.test(canonicalName);
}

function resolveAiToolIoPath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function humanizeToolFieldKey(key: string) {
  // 与 aiToolPresentation.humanizeToolName 同构的分词规则，不新造业务词。
  const normalized = key.replace(/\./g, " ");
  return normalized
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (value) => value.toUpperCase());
}

function aiToolIoValuePreview(value: unknown): { value: string; truncated: boolean; full?: string } | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const compact = value.trim().replace(/\s+/g, " ");
    if (!compact) return null;
    if (compact.length <= AI_TOOL_IO_VALUE_LIMIT) return { value: compact, truncated: false };
    return { value: `${compact.slice(0, AI_TOOL_IO_VALUE_LIMIT)}…`, truncated: true, full: compact };
  }
  if (typeof value === "number" || typeof value === "boolean") return { value: String(value), truncated: false };
  if (typeof value !== "object") return null;
  // 深层数据（嵌套对象/长数组）压缩截断显示 …，完整内容仍在"原始"视图。
  let compact: string;
  try {
    compact = JSON.stringify(value) ?? "";
  } catch {
    return null;
  }
  if (!compact || compact === "{}" || compact === "[]") return null;
  if (compact.length <= AI_TOOL_IO_VALUE_LIMIT) return { value: compact, truncated: false };
  return { value: `${compact.slice(0, AI_TOOL_IO_VALUE_LIMIT)}…`, truncated: true, full: compact };
}

function aiToolIoRowFrom(key: string, value: unknown): AiToolIoRow | null {
  const preview = aiToolIoValuePreview(value);
  if (!preview) return null;
  return {
    key,
    label: humanizeToolFieldKey(key),
    value: preview.value,
    truncated: preview.truncated,
    ...(preview.full ? { full: preview.full } : {})
  };
}

// —— B2 通用回退：递归扁平化 ——
// 未配置/未命中显式路径的嵌套结构工具（radar.compareMarkets、funding basis 类等）也能产出键值行，
// "暂无可固定的结构化字段"类空态只在扁平化后确实零标量时才出现。

type AiToolIoFlatEntry = {
  key: string;
  value: unknown;
};

function isAiToolIoScalar(value: unknown) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

// 对象数组的统一呈现："共 N 项"一行 + 首项标量字段（键路径如 markets[0].instId）。
// 非对象数组（标量数组等）整体回退为 JSON 预览，交由 aiToolIoValuePreview 截断。
function aiToolIoArrayEntries(value: unknown[], arrayKey: string): AiToolIoFlatEntry[] {
  const items = value.filter((item) => item !== null && typeof item === "object" && !Array.isArray(item));
  if (items.length === 0) return [{ key: arrayKey, value }];
  const entries: AiToolIoFlatEntry[] = [{
    key: arrayKey,
    value: processText("toolIoArrayCount", "{{count}} items", "共 {{count}} 项", { count: value.length })
  }];
  const first = items[0] as Record<string, unknown>;
  for (const [subKey, subValue] of Object.entries(first)) {
    if (AI_TOOL_IO_NOISE_KEY.test(subKey)) continue;
    if (isAiToolIoScalar(subValue)) entries.push({ key: `${arrayKey}[0].${subKey}`, value: subValue });
  }
  return entries;
}

// 递归扁平化对象载荷：本层标量 → 一层嵌套对象的标量字段（键路径如 btc.fundingRate）→
// 对象数组（"共 N 项" + 首项标量字段）。深度上限 AI_TOOL_IO_DEPTH_LIMIT 层、总条目上限 cap；
// 触顶置 overflow，由卡片提示"原始载荷含完整数据"。同层保持原始键序、标量优先。
function flattenAiToolIoEntries(
  source: Record<string, unknown>,
  cap: number,
  prefix = "",
  depth = 1
): { entries: AiToolIoFlatEntry[]; overflow: boolean } {
  const entries: AiToolIoFlatEntry[] = [];
  let overflow = false;
  const push = (entry: AiToolIoFlatEntry) => {
    if (entries.length >= cap) {
      overflow = true;
      return;
    }
    entries.push(entry);
  };
  const joinKey = (key: string) => (prefix ? `${prefix}.${key}` : key);
  const fields = Object.entries(source).filter(([key]) => !AI_TOOL_IO_NOISE_KEY.test(key));
  // 1) 本层标量优先。
  for (const [key, value] of fields) {
    if (isAiToolIoScalar(value)) push({ key: joinKey(key), value });
  }
  if (depth >= AI_TOOL_IO_DEPTH_LIMIT) return { entries, overflow };
  // 2) 一层嵌套对象：下沉一层取标量字段，不再继续深入。
  for (const [key, value] of fields) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const nested = flattenAiToolIoEntries(value as Record<string, unknown>, cap - entries.length, joinKey(key), depth + 1);
      entries.push(...nested.entries);
      overflow = overflow || nested.overflow;
    }
  }
  // 3) 数组：对象数组走"共 N 项 + 首项"，其余数组整体 JSON 预览。
  for (const [key, value] of fields) {
    if (!Array.isArray(value) || value.length === 0) continue;
    for (const entry of aiToolIoArrayEntries(value, joinKey(key))) push(entry);
  }
  return { entries, overflow };
}

function aiToolIoRows(tool: AiToolRun, side: "input" | "output"): { rows: AiToolIoRow[]; overflow: boolean } | null {
  const normalized = normalizeAiToolPayload(side === "input" ? tool.arguments : tool.result);
  if (normalized === null || normalized === undefined) return null;
  if (typeof normalized !== "object") {
    // 标量/纯文本载荷：以单行键值卡呈现（label 复用现有 输入/输出 文案）。
    const preview = aiToolIoValuePreview(normalized);
    if (!preview) return null;
    return {
      rows: [{
        key: side,
        label: side === "input"
          ? processText("toolInput", "Input", "输入")
          : processText("toolOutput", "Output", "输出"),
        value: preview.value,
        truncated: preview.truncated,
        ...(preview.full ? { full: preview.full } : {})
      }],
      overflow: false
    };
  }
  const record = normalized as Record<string, unknown>;
  const rows: AiToolIoRow[] = [];
  let overflow = false;
  const pushEntry = (entry: AiToolIoFlatEntry) => {
    const row = aiToolIoRowFrom(entry.key, entry.value);
    if (row) rows.push(row);
  };
  const paths = AI_TOOL_IO_FIELD_PATHS[getAiToolPresentation(tool.name).canonicalName]?.[side];
  if (paths) {
    for (const path of paths) {
      const value = resolveAiToolIoPath(record, path);
      if (value === null || value === undefined) continue;
      if (value !== null && typeof value === "object") {
        // B2：显式路径命中嵌套对象/数组时同样走通用扁平化（对象数组 = "共 N 项 + 首项字段"），不再渲染 JSON 长串。
        const flat = Array.isArray(value)
          ? { entries: aiToolIoArrayEntries(value, path), overflow: false }
          : flattenAiToolIoEntries(value as Record<string, unknown>, AI_TOOL_IO_ROW_CAP - rows.length, path);
        for (const entry of flat.entries) pushEntry(entry);
        overflow = overflow || flat.overflow;
        continue;
      }
      const row = aiToolIoRowFrom(path, value);
      if (row) rows.push(row);
    }
  }
  if (rows.length === 0) {
    // B2：显式路径缺失/未命中 → 通用递归扁平化回退（顶层标量 → 嵌套标量 → 对象数组）。
    const flat = flattenAiToolIoEntries(record, AI_TOOL_IO_ROW_CAP);
    for (const entry of flat.entries) pushEntry(entry);
    overflow = flat.overflow;
  }
  return rows.length > 0 ? { rows, overflow } : null;
}

function AiToolIoCard({ title, rows, emptyLabel, overflowHint }: { title: string; rows: AiToolIoRow[] | null; emptyLabel: string; overflowHint?: string }) {
  return (
    <div className={clsx("ai-tool-io-card", !rows && "is-empty")}>
      <span className="ai-tool-io-card-title">{title}</span>
      {rows ? (
        <>
          <dl className="ai-tool-kv">
            {rows.map((row) => (
              <div className="ai-tool-kv-item" key={row.key}>
                <dt title={row.key}>{row.label}</dt>
                <dd className={clsx(row.truncated && "is-truncated")} title={row.full} data-i18n-skip>{row.value}</dd>
              </div>
            ))}
          </dl>
          {/* B2：条目触顶提示——完整数据仍在"原始"视图，卡片不承担展开职责 */}
          {overflowHint ? <small className="ai-tool-io-note" data-i18n-skip>{overflowHint}</small> : null}
        </>
      ) : (
        <code className="ai-tool-io-empty">{emptyLabel}</code>
      )}
    </div>
  );
}

function AiToolIoSection({ tool }: { tool: AiToolRun }) {
  // 纯展示状态：默认结构化键值卡，"原始"chip 切回 JSON 视图；不改动任何数据流。
  const [showRaw, setShowRaw] = useState(false);
  const input = aiToolIoRows(tool, "input");
  const output = aiToolIoRows(tool, "output");
  const outputEmptyLabel = tool.status === "running"
    ? processText("waitingToolResult", "Waiting for tool result", "等待工具返回")
    : processText("noToolOutput", "No output data", "无输出数据");
  const payloadHint = processText("toolIoPayloadHint", "Full data is available in the raw payload", "原始载荷含完整数据");
  return (
    <section className="ai-tool-io-cards">
      <header className="ai-tool-io-cards-head">
        <span className="ai-tool-io-cards-title">{processText("toolDetails", "Details", "详情")}</span>
        <button
          type="button"
          className={clsx("ai-tool-io-toggle", showRaw && "is-raw")}
          aria-pressed={showRaw}
          onClick={() => setShowRaw((value) => !value)}
        >
          {showRaw ? processText("toolIoStructured", "Structured", "结构化") : processText("toolIoRaw", "Raw", "原始")}
        </button>
      </header>
      {showRaw ? (
        <pre className="ai-tool-io-raw">{safeJson({ arguments: normalizeAiToolPayload(tool.arguments), result: normalizeAiToolPayload(tool.result) })}</pre>
      ) : (
        <div className="ai-tool-io-cards-grid">
          <AiToolIoCard
            title={processText("toolInput", "Input", "输入")}
            rows={input?.rows ?? null}
            overflowHint={input?.overflow ? payloadHint : undefined}
            emptyLabel={processText("noToolInput", "No input parameters", "无输入参数")}
          />
          <AiToolIoCard
            title={processText("toolOutput", "Output", "输出")}
            rows={output?.rows ?? null}
            overflowHint={output?.overflow ? payloadHint : undefined}
            emptyLabel={outputEmptyLabel}
          />
        </div>
      )}
    </section>
  );
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

function toolRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toolText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function strategySourceForTool(value: unknown) {
  // strategy.create nests the persisted Python definition under strategy.definition.

  const root = toolRecord(value);
  const strategy = toolRecord(root.strategy);
  const definition = toolRecord(strategy.definition);
  const version = toolRecord(root.version);
  return toolText(root.source)
    || toolText(root.code)
    || toolText(definition.source)
    || toolText(version.source)
    || toolText(strategy.source)
    || toolText(toolRecord(root.result).source)
    || toolText(toolRecord(toolRecord(root.result).strategy).source);
}

function toolFactRows(value: unknown, limit = 7): Array<[string, string]> {
  const record = toolRecord(value);
  if (Object.keys(record).length === 0) return [];
  // B2：与工具 IO 卡共用递归扁平化——嵌套对象/对象数组也能产出可固定的标量事实
  // （如 fundingRate.fundingRate、markets[0].instId），inspector 的
  // "暂无可固定的结构化字段"只在扁平化后确实零标量时才出现。
  const flat = flattenAiToolIoEntries(record, limit);
  return flat.entries.map((entry) => [entry.key, String(entry.value)]);
}

function artifactKindForTool(tool: AiToolRun): AiResearchArtifact["kind"] {
  const name = getAiToolPresentation(tool.name).canonicalName;
  if (name.startsWith("strategy.")) return "strategy";
  if (name === "skills" || name.startsWith("skill.") || /(?:^|[._-])skill/i.test(name)) return "skill";
  if (name.startsWith("market.")) return "market";
  if (name.startsWith("intelligence.") || name.startsWith("radar.")) return "intelligence";
  if (name.startsWith("account.") || name.startsWith("position.")) return "account";
  if (name.startsWith("trade.") || name.startsWith("order.")) return "trade";
  return "research";
}

// —— B2 简单工具内联证据卡 ——
// 清单判据（宁少勿多）：market 域只读 read 工具 + 返回单对象（无对象数组/行集）+
// 核心标量字段 2-6 个 + 无副作用。K线/指标/深度/情绪/排名/智能钱/策略类等
// 复杂产物保持 artifact 行为。market.readDecisionContext 不入列：返回
// precheck + 账户 + 市场快照的复合复核载荷，属于右栏复杂产物。
const AI_INLINE_EVIDENCE_TOOLS = new Set(["market.readTicker", "market.readFundingRate", "market.readInstrument"]);

// 内联卡键值行数上限（工具名微标签 + 2-6 个键值 + 数据时间）。
const AI_INLINE_EVIDENCE_ROW_CAP = 6;
// 数据时间候选键：在载荷两层内按命中顺序取第一个正数时间戳。
const AI_INLINE_EVIDENCE_TIME_KEYS = ["ts", "fundingTime", "nextFundingTime", "dataAt", "asOf", "generatedAt", "capturedAt", "updatedAt", "snapshotAt"];

type AiInlineEvidence = {
  key: string;
  label: string;
  toolName: string;
  rows: Array<{ key: string; label: string; value: string; full?: string }>;
  time?: string;
};

function isInlineEvidenceTool(tool: AiToolRun): boolean {
  // 仅主线程工具：子 Agent 工具保留在子任务卡内，不在消息尾部重复落地。
  return tool.status === "done"
    && tool.ok !== false
    && !tool.agentId
    && AI_INLINE_EVIDENCE_TOOLS.has(getAiToolPresentation(tool.name).canonicalName);
}

// 数据时间：按候选键在两层内找第一个正数时间戳，秒/毫秒自适应（与 AiResearchInspector 同规则）。
function aiInlineEvidenceTime(record: Record<string, unknown>): string | undefined {
  const scalars: Array<[string, number]> = [];
  const collect = (key: string, value: unknown) => {
    if (AI_TOOL_IO_NOISE_KEY.test(key)) return;
    if (typeof value === "number" && value > 0) scalars.push([key, value]);
  };
  for (const [key, value] of Object.entries(record)) {
    collect(key, value);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
        collect(`${key}.${subKey}`, subValue);
      }
    }
  }
  for (const timeKey of AI_INLINE_EVIDENCE_TIME_KEYS) {
    const hit = scalars.find(([key]) => key === timeKey || key.endsWith(`.${timeKey}`));
    if (!hit) continue;
    const milliseconds = hit[1] < 10_000_000_000 ? hit[1] * 1000 : hit[1];
    if (!Number.isFinite(milliseconds)) continue;
    try {
      return new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language || "zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      }).format(new Date(milliseconds));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function aiInlineEvidenceForTool(tool: AiToolRun): AiInlineEvidence | null {
  if (!isInlineEvidenceTool(tool)) return null;
  const normalized = normalizeAiToolPayload(tool.result);
  if (normalized === null || normalized === undefined || typeof normalized !== "object" || Array.isArray(normalized)) return null;
  // 键值行复用工具 IO 卡的扁平化结果：显式路径优先（B2 已按 lib.rs 真实形状修正），缺行时通用回退兜底。
  const output = aiToolIoRows(tool, "output");
  if (!output) return null;
  const selected = output.rows.slice(0, AI_INLINE_EVIDENCE_ROW_CAP);
  if (selected.length === 0) return null;
  // 全部行共享同一层前缀（如 ticker.）时省去重复前缀；完整键路径保留在 title。
  const root = selected[0].key.split(".")[0];
  const sharedPrefix = selected.every((row) => row.key.startsWith(`${root}.`)) ? `${root}.` : null;
  const presentation = getAiToolPresentation(tool.name);
  const time = aiInlineEvidenceTime(normalized as Record<string, unknown>);
  return {
    key: tool.id,
    label: presentation.label,
    toolName: presentation.canonicalName,
    rows: selected.map((row) => ({
      key: row.key,
      label: sharedPrefix ? humanizeToolFieldKey(row.key.slice(sharedPrefix.length)) : row.label,
      value: row.value,
      ...(row.full ? { full: row.full } : {})
    })),
    ...(time ? { time } : {})
  };
}

// 消息级内联证据卡：简单工具完成后在答案之后、footer 之上直接落地结果。
export function AiInlineEvidenceCards({ message }: { message: AiUiMessage }) {
  const cards = message.tools
    .map((tool) => aiInlineEvidenceForTool(tool))
    .filter((card): card is AiInlineEvidence => Boolean(card));
  if (cards.length === 0) return null;
  const timeLabel = processText("inlineEvidenceTime", "Data time", "数据时间");
  return (
    <div className="ai-inline-evidence">
      {cards.map((card) => (
        <div className="ai-inline-evidence-card" key={card.key} aria-label={card.label}>
          <span className="ai-inline-evidence-tool" title={card.toolName}>{card.label}</span>
          <dl className="ai-inline-evidence-kv">
            {card.rows.map((row) => (
              <div className="ai-inline-evidence-item" key={row.key}>
                <dt title={row.key}>{row.label}</dt>
                <dd className={clsx(row.full && "is-truncated")} title={row.full ?? row.value} data-i18n-skip>{row.value}</dd>
              </div>
            ))}
          </dl>
          {card.time ? <span className="ai-inline-evidence-time" title={timeLabel} data-i18n-skip>{card.time}</span> : null}
        </div>
      ))}
    </div>
  );
}

export function aiResearchArtifactForTool(tool: AiToolRun, sourceMessageId?: string): AiResearchArtifact | null {
  if (tool.status === "pending" || tool.status === "running") return null;
  // B2：简单 read 工具不再产出 artifact——结果以消息内内联证据卡落地，右栏只留给复杂产物。
  // 不生成 artifact 即无 id 可被引用，removeArtifact/编号逻辑不会产生悬空引用。
  if (AI_INLINE_EVIDENCE_TOOLS.has(getAiToolPresentation(tool.name).canonicalName)) return null;
  const presentation = getAiToolPresentation(tool.name);
  const action = strategyActionForTool(tool);
  const result = toolRecord(tool.result);
  const strategy = toolRecord(result.strategy);
  const input = toolRecord(tool.arguments);
  const kind = artifactKindForTool(tool);
  const title = kind === "strategy"
    ? toolText(strategy.name) || toolText(result.strategyName) || action?.strategyId || presentation.label
    : kind === "skill"
      ? toolText(result.name) || toolText(result.skillName) || toolText(input.skillId) || toolText(input.skill) || presentation.label
      : presentation.label;
  const evidence = result.result && typeof result.result === "object" ? result.result : result;
  const facts = toolFactRows(evidence);
  return {
    id: `tool-artifact:${tool.id}`,
    kind,
    title,
    summary: tool.summary || presentation.summary,
    data: kind === "skill" ? { ...result, input } : result,
    toolName: presentation.canonicalName,
    sourceMessageId: sourceMessageId ?? tool.messageId,
    facts,
    ...(action ?? {})
  };
}

function developmentDocumentTitle(value: unknown) {
  const match = toolText(value).match(/^\s*#\s+(.+?)\s*$/m);
  return match?.[1]?.trim() || "";
}

function readableToolFactRows(tool: AiToolRun): Array<[string, string]> {
  const kind = artifactKindForTool(tool);
  const result = toolRecord(tool.result);
  const input = toolRecord(tool.arguments);
  const selected = kind === "trade" && Object.keys(result).length > 0 ? result : Object.keys(result).length > 0 ? result : input;
  if (/readDevelopmentDocs$/i.test(tool.name)) {
    const title = developmentDocumentTitle(selected.content);
    const rows: Array<[string, string]> = [
      [processText("toolDocument", "Document", "文档"), title || toolText(selected.documentationId) || processText("strategyProtocol", "Strategy development protocol", "策略开发协议")],
      [processText("toolDocumentVersion", "Document version", "文档版本"), toolText(selected.documentationVersion)],
      [processText("toolProtocol", "Protocol", "协议版本"), toolText(selected.protocolVersion)],
      [processText("toolAccess", "Access", "访问权限"), selected.readOnly === true ? processText("toolReadOnly", "Read-only", "只读") : ""]
    ];
    return rows.filter(([, value]) => Boolean(value));
  }
  const labels: Record<string, string> = {
    documentationId: processText("toolDocument", "Document", "文档"),
    documentationVersion: processText("toolDocumentVersion", "Document version", "文档版本"),
    protocolVersion: processText("toolProtocol", "Protocol", "协议版本"),
    readOnly: processText("toolAccess", "Access", "访问权限")
  };
  return toolFactRows(selected, kind === "market" ? 8 : 6)
    .filter(([key]) => !/^(content|contentSha256|sourceEventSeqs|seqId)$/i.test(key))
    .map(([key, value]) => [labels[key] ?? key, key === "readOnly" ? (value === "true" ? processText("toolReadOnly", "Read-only", "只读") : processText("toolReadWrite", "Read and write", "读写")) : value]);
}

function toolResultBrief(tool: AiToolRun) {
  const selected = toolRecord(tool.result);
  if (/readDevelopmentDocs$/i.test(tool.name)) {
    const title = developmentDocumentTitle(selected.content) || toolText(selected.documentationId) || processText("strategyProtocol", "Strategy development protocol", "策略开发协议");
    return processText("toolDocumentReady", "Loaded {{title}} for this strategy task.", "已加载「{{title}}」，供本次策略任务引用。", { title });
  }
  return tool.summary || getAiToolPresentation(tool.name).summary;
}

function strategySourceBlock(tool: AiToolRun) {
  if (!/^strategy\.create$/i.test(tool.name)) return null;
  const source = strategySourceForTool(tool.result);
  if (!source) return null;
  return <section className="ai-tool-code-preview" aria-label={processText("strategySource", "Strategy source", "策略源代码")}><header><strong>{processText("strategySource", "Strategy source", "策略源代码")}</strong><span>{source.split("\n").length} {processText("lines", "lines", "行")}</span></header><pre><code>{source}</code></pre></section>;
}

function AiToolFactRows({ tool }: { tool: AiToolRun }) {
  const rows = readableToolFactRows(tool);
  if (rows.length === 0) return null;
  return <dl className="ai-tool-facts">{rows.map(([key, value]) => <div key={`${key}:${value}`}><dt>{key}</dt><dd title={value}>{value}</dd></div>)}</dl>;
}

function AiToolDomainDetails({ tool, onOpenArtifact }: { tool: AiToolRun; onOpenArtifact?: (artifact: AiResearchArtifact) => void }) {
  const artifact = aiResearchArtifactForTool(tool);
  const kind = artifact?.kind;
  const actionLabel = kind === "strategy"
    ? processText("openStrategyTab", "Open strategy", "打开策略")
    : kind === "skill"
      ? processText("openSkillTab", "Open Skill", "打开 Skill")
      : kind === "market"
        ? processText("openMarketEvidence", "Open market evidence", "打开市场证据")
        : kind === "intelligence"
          ? processText("openIntelligenceTab", "Open intelligence", "打开情报")
          : kind === "account"
            ? processText("openAccountEvidence", "Open account evidence", "打开账户证据")
            : kind === "trade"
              ? processText("openPrecheck", "Open precheck", "打开预检")
              : processText("openResearchTab", "Open research", "打开研究资料");
  return <div className={clsx("ai-tool-domain-details", `domain-${kind ?? "research"}`)}>
    <div className="ai-tool-result-brief"><span>{tool.ok === false || tool.status === "failed" ? processText("toolResultFailed", "Tool did not complete", "工具未完成") : processText("toolResultReady", "Result ready", "结果已就绪")}</span><strong data-i18n-skip>{toolResultBrief(tool)}</strong></div>
    {/* B1：识别为高频业务域的工具用键值卡呈现 IO（结果摘要标量已并入输出卡，不再重复渲染 facts）；
        未识别工具保持原有 facts + 原始 JSON 渲染不变。 */}
    {isStructuredIoTool(tool) ? (
      <AiToolIoSection tool={tool} />
    ) : (
      <AiToolFactRows tool={tool} />
    )}
    {strategySourceBlock(tool)}
    {artifact && onOpenArtifact ? <button type="button" className="ai-tool-open-artifact" onClick={() => onOpenArtifact(artifact)}>{actionLabel}</button> : null}
    {!isStructuredIoTool(tool) ? (
      <details className="ai-tool-raw">
        <summary>{processText("rawToolPayload", "Raw payload", "原始载荷")}</summary>
        <pre>{safeJson({ arguments: normalizeAiToolPayload(tool.arguments), result: normalizeAiToolPayload(tool.result) })}</pre>
      </details>
    ) : null}
  </div>;
}

function AiToolCard({ tool, onOpenStrategy, onOpenArtifact }: { tool: AiToolRun; onOpenStrategy?: (strategyId: string, runId?: string, optimizationId?: string) => void; onOpenArtifact?: (artifact: AiResearchArtifact) => void }) {
  const strategyAction = strategyActionForTool(tool);
  const presentation = getAiToolPresentation(tool.name);
  const artifact = aiResearchArtifactForTool(tool);
  const opensMarketPanel = artifact?.kind === "market";
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
      <summary onClick={opensMarketPanel ? (event) => { event.preventDefault(); if (artifact) onOpenArtifact?.(artifact); } : undefined} className={opensMarketPanel ? "ai-tool-direct-artifact" : undefined}>
        <span className="ai-tool-title">
          <span
            className={clsx(
              "ai-tool-state-dot",
              (tool.status === "failed" || tool.ok === false || tool.blocked) && "failed",
              tool.status === "running" && "running"
            )}
            aria-hidden="true"
          />
          <AiToolDomainIcon domain={presentation.domain} /> <span>{presentation.label}</span><code title={presentation.canonicalName}>{presentation.canonicalName}</code>
        </span>
        <strong>{toolStatusLabel(tool)}</strong>
      </summary>
      <small className="ai-tool-summary" data-i18n-skip>{tool.summary || presentation.summary}</small>
      {tool.policy && <small>{tool.policy}</small>}
      {!opensMarketPanel ? <AiToolDomainDetails tool={tool} onOpenArtifact={onOpenArtifact} /> : null}
       <details className="ai-tool-io legacy">
        <summary>{processText("toolDetails", "Details", "详情")} · {getAiToolDomainLabel(presentation.domain, i18n.language)}</summary>
        <div className="ai-tool-io-grid">
          <div><small>{processText("toolInput", "Input", "输入")}</small><AiToolInputCode value={tool.arguments} /></div>
          <div><small>{processText("toolOutput", "Output", "输出")}</small><AiToolOutputCode value={tool.result} pending={tool.status === "running"} /></div>
        </div>
      </details>
      {strategyAction && onOpenStrategy ? <button type="button" className="ai-tool-open-strategy" onClick={() => onOpenStrategy(strategyAction.strategyId, strategyAction.runId, strategyAction.optimizationId)}>{processText("openStrategyLab", "Open in Strategy Lab", "在策略实验室打开")}</button> : null}
    </details>
  );
}

function AiToolTraceRow({ tool, now, onOpenStrategy, onOpenArtifact }: { tool: AiToolRun; now: number; onOpenStrategy?: (strategyId: string, runId?: string, optimizationId?: string) => void; onOpenArtifact?: (artifact: AiResearchArtifact) => void }) {
  const failed = tool.status === "failed" || tool.ok === false || tool.blocked;
  const running = tool.status === "running";
  const duration = toolDurationLabel(tool, now);
  const source = toolDataSourceLabel(tool);
  const presentation = getAiToolPresentation(tool.name);
  const artifact = aiResearchArtifactForTool(tool);
  const opensMarketPanel = artifact?.kind === "market";
  return (
    <details className={clsx("ai-tool-trace", `tool-${tool.status}`, failed && "result-failed")}>
      <summary onClick={opensMarketPanel ? (event) => { event.preventDefault(); if (artifact) onOpenArtifact?.(artifact); } : undefined} className={opensMarketPanel ? "ai-tool-direct-artifact" : undefined}>
        <span className={clsx("ai-tool-state-dot", failed && "failed", running && "running")} aria-hidden="true" />
        <AiToolDomainIcon domain={presentation.domain} size={13} />
        <span className="ai-tool-trace-action">{presentation.label}</span>
        <small className="ai-tool-summary" data-i18n-skip>{tool.summary || presentation.summary}</small>
        <strong>{toolStatusLabel(tool)}{source ? ` · ${source}` : ""}{duration ? ` · ${duration}` : ""}</strong>
      </summary>
      {strategyActionForTool(tool) && onOpenStrategy ? <button type="button" className="ai-tool-open-strategy" onClick={() => { const action = strategyActionForTool(tool); if (action) onOpenStrategy(action.strategyId, action.runId, action.optimizationId); }}>{processText("openStrategyLab", "Open in Strategy Lab", "在策略实验室打开")}</button> : null}
      {!opensMarketPanel ? <AiToolDomainDetails tool={tool} onOpenArtifact={onOpenArtifact} /> : null}
       <details className="ai-tool-panel legacy">
        <summary>{processText("toolDetails", "Details", "详情")}</summary>
        <div className="ai-tool-io-grid">
          <div><small>{processText("toolInput", "Input", "输入")}</small><AiToolInputCode value={tool.arguments} /></div>
          <div><small>{processText("toolOutput", "Output", "输出")}</small><AiToolOutputCode value={tool.result} pending={tool.status === "running"} /></div>
        </div>
      </details>
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

function AiToolGroup({ items, message, now, onOpenStrategy, onOpenArtifact }: { items: Extract<AiTimelineItem, { kind: "tool" }>[]; message: AiUiMessage; now: number; onOpenStrategy?: (strategyId: string, runId?: string, optimizationId?: string) => void; onOpenArtifact?: (artifact: AiResearchArtifact) => void }) {
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
        <span className="ai-tool-group-title"><AiToolDomainIcon domain={tools.length === 1 ? getAiToolPresentation(tools[0].name).domain : "system"} /><span>{processText("toolsRunCount", "Ran {{count}} tools", "运行了 {{count}} 个工具", { count: tools.length })}</span></span>
        <strong>{processText("toolsSucceededCount", "{{count}} succeeded", "{{count}} 成功", { count: done })}{failed ? ` · ${processText("toolsFailedCount", "{{count}} failed", "{{count}} 异常", { count: failed })}` : ""}{duration ? ` · ${duration}` : ""}</strong>
      </summary>
      <div className="ai-tool-trace-list">
        {tools.map((tool) => (
          <AiToolTraceRow tool={tool} now={now} onOpenStrategy={onOpenStrategy} onOpenArtifact={onOpenArtifact} key={`${tool.agentId ?? "main"}-${tool.id}`} />
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

export function aiArtifactsForMessage(message: AiUiMessage) {
  const tools = [...(message.tools ?? []), ...(message.agents ?? []).flatMap((agent) => agent.tools ?? [])];
  return tools.map((tool) => aiResearchArtifactForTool(tool, message.id)).filter((artifact): artifact is AiResearchArtifact => Boolean(artifact));
}

export function AiEvidenceReferences({ message, onOpenArtifact, onOpenMessage, uiText }: { message: AiUiMessage; onOpenArtifact?: (artifact: AiResearchArtifact) => void; onOpenMessage?: (messageId: string) => void; uiText: (zh: string, en: string) => string }) {
  const artifacts = aiArtifactsForMessage(message).filter((artifact) => artifact.kind !== "research");
  if (!onOpenArtifact || artifacts.length === 0) return null;
  return <div className="ai-evidence-references" aria-label={uiText("本轮引用证据", "Evidence referenced this turn")}>
    <small>{uiText("引用证据", "Evidence")}</small>
    {artifacts.slice(0, 5).map((artifact) => <button key={artifact.id} type="button" onClick={() => onOpenArtifact(artifact)} onAuxClick={(event) => { if (event.button === 1 && artifact.sourceMessageId) onOpenMessage?.(artifact.sourceMessageId); }} title={uiText(`${artifact.title} · 打开证据`, `${artifact.title} · Open evidence`)} aria-label={uiText(`打开证据：${artifact.title}`, `Open evidence: ${artifact.title}`)}><span>{artifact.title}</span></button>)}
    {message.id ? <button type="button" className="ai-evidence-anchor" onClick={() => onOpenMessage?.(message.id)} title={uiText("定位本轮回答", "Locate this answer")} aria-label={uiText("定位本轮回答", "Locate this answer")}>{uiText("定位回答", "Locate answer")}</button> : null}
  </div>;
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

export function aiReportedOutputTokens(value: unknown) {
  const normalized = normalizedUsage(value);
  return normalized?.reported && normalized.output > 0 ? normalized.output : null;
}

function formatTokenCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return formatLocalizedNumber(Math.round(value));
}

function formatMetaTokenCount(value: number) {
  if (value < 10_000) return formatLocalizedNumber(Math.round(value));
  return formatTokenCount(value);
}

// B2：输入/输出分示文案。任一缺失（未报告或为 0）时返回 null，调用方回退显示总数，
// 避免出现误导性的"输入 0 · 输出 0"。
function aiTokenSplitLabel(normalized: { reported: boolean; input: number; output: number }) {
  if (!normalized.reported || normalized.input <= 0 || normalized.output <= 0) return null;
  return processText("tokenInputOutput", "Input {{input}} · Output {{output}}", "输入 {{input}} · 输出 {{output}}", {
    input: formatTokenCount(normalized.input),
    output: formatTokenCount(normalized.output)
  });
}

export function AiTokenUsageLine({ usage, variant = "line" }: { usage: unknown; variant?: "line" | "meta" }) {
  const normalized = normalizedUsage(usage);
  if (!normalized) return null;
  const split = aiTokenSplitLabel(normalized);
  if (variant === "meta") {
    // 紧凑 footer 段：B2 起直接分示"输入 X · 输出 Y"（用户可一眼看出大头是固定上下文）；
    // 任一缺失时回退显示总数；合计/子 Agent/不完整提示等详情保留在 tooltip。
    if (!normalized.reported) return null;
    const detail = [
      ...(split ? [split] : []),
      processText("tokenTotal", "Total {{total}}", "合计 {{total}}", { total: formatMetaTokenCount(normalized.total) }),
      ...(normalized.agentCount > 0 ? [processText("subagentCount", "{{count}} subagents", "{{count}} 个子 Agent", { count: normalized.agentCount })] : []),
      ...(normalized.partial ? [normalized.unreportedAgentCount > 0
        ? processText("usagePartiallyReportedAgents", "Known usage only; {{count}} agents did not report usage", "仅显示已知用量；{{count}} 个 Agent 未报告", { count: normalized.unreportedAgentCount })
        : processText("usagePartiallyReported", "Known usage only; this turn was partially reported", "仅显示已知用量；本轮统计不完整")] : [])
    ].join(" · ");
    return (
      <span
        className={clsx("ai-meta-token", normalized.partial && "is-partial")}
        title={detail}
        aria-label={processText("tokenUsage", "Token usage for this turn", "本轮 Token 用量")}
      >
        {split ?? `${formatMetaTokenCount(normalized.total)} tok`}
      </span>
    );
  }
  return (
    <div className={clsx("ai-token-usage", !normalized.reported && "unreported")} aria-label={processText("tokenUsage", "Token usage for this turn", "本轮 Token 用量")}>
      <span>Token</span>
      {normalized.reported ? (
        <>
          {/* 向后兼容：图表中心/策略实验室沿用 strong 总数 + small 分示；分示缺失时只显示总数 */}
          <strong>{formatTokenCount(normalized.total)}</strong>
          {split ? <small>{split}</small> : null}
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

// —— B1 过程可视化：分段进度条 ——
// 数据来源：message.timeline 中 kind==="tool" 的项按时间轴顺序映射到 tool runs 的 status 字段；
// 无时间轴的历史消息回退到 message.tools + agents[].tools。
// 只用真实工具名与状态，不伪造阶段语义；不新增 interval / 订阅。

type AiProcessSegmentState = "done" | "running" | "failed" | "pending";

type AiProcessSegment = {
  id: string;
  name: string;
  label: string;
  state: AiProcessSegmentState;
};

function aiProcessSegmentState(tool: AiToolRun): AiProcessSegmentState {
  if (tool.status === "running") return "running";
  if (tool.status === "failed" || tool.status === "blocked" || tool.ok === false || tool.blocked) return "failed";
  if (tool.status === "done" || tool.ok === true) return "done";
  return "pending";
}

function aiProcessToolSegments(message: AiUiMessage): AiProcessSegment[] {
  const runs = message.timeline
    ? message.timeline
      .filter((item): item is Extract<AiTimelineItem, { kind: "tool" }> => item.kind === "tool")
      .map((item) => (item.agentId
        ? message.agents?.find((agent) => agent.id === item.agentId)?.tools?.find((entry) => entry.id === item.toolId)
        : message.tools.find((entry) => entry.id === item.toolId)))
      .filter((tool): tool is AiToolRun => Boolean(tool))
    : [...message.tools, ...(message.agents ?? []).flatMap((agent) => agent.tools ?? [])];
  return runs.map((tool) => {
    const presentation = getAiToolPresentation(tool.name);
    return {
      id: `${tool.agentId ?? "main"}-${tool.id}`,
      name: presentation.canonicalName,
      label: presentation.label,
      state: aiProcessSegmentState(tool)
    };
  });
}

// 段落悬停提示的状态词复用现有文案（已返回/运行中/失败/待审计），不新增业务词。
const AI_PROCESS_SEGMENT_STATUS: Record<AiProcessSegmentState, [string, string, string]> = {
  done: ["toolReturned", "Returned", "已返回"],
  running: ["running", "Running", "运行中"],
  failed: ["failed", "Failed", "失败"],
  pending: ["pendingAudit", "Pending audit", "待审计"]
};

function AiProcessProgressSegments({ segments }: { segments: AiProcessSegment[] }) {
  if (segments.length === 0) return null;
  return (
    <span className="ai-process-progress" aria-hidden="true">
      {segments.map((segment) => (
        <i
          className={`is-${segment.state}`}
          key={segment.id}
          title={`${segment.name} · ${processText(...AI_PROCESS_SEGMENT_STATUS[segment.state])}`}
        />
      ))}
    </span>
  );
}

export function AiProcessTimeline({ message, onApprove, now, onOpenStrategy, onOpenArtifact }: { message: AiUiMessage; onApprove: (approvalId: string, approved: boolean, reason: string) => void; now: number; onOpenStrategy?: (strategyId: string, runId?: string, optimizationId?: string) => void; onOpenArtifact?: (artifact: AiResearchArtifact) => void }) {
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
  const toolRunCount = message.tools.length + (message.agents?.reduce((count, agent) => count + (agent.tools?.length ?? 0), 0) ?? 0);
  const summaryMeta = [
    toolRunCount > 0
      ? processText("processToolCount", "{{count}} tools", "{{count}} 工具", { count: toolRunCount })
      : processCount > 0
        ? processText("processItemCount", "{{count}} items", "{{count}} 项", { count: processCount })
        : "",
    duration ?? ""
  ].filter(Boolean).join(" · ");
  // B1：分段进度条 + 流式当前工具名。全部由现有 tool runs 的 status 派生。
  const toolSegments = aiProcessToolSegments(message);
  let runningSegment: AiProcessSegment | undefined;
  for (let index = toolSegments.length - 1; index >= 0; index -= 1) {
    if (toolSegments[index].state === "running") {
      runningSegment = toolSegments[index];
      break;
    }
  }
  return (
    <details className="ai-process" open={!done || hasFailure}>
      <summary>
        <span>{done ? processText("executionProcess", "Execution process", "执行过程") : processText("processing", "Processing", "处理中")}</span>
        {runningSegment ? (
          <span
            className="ai-process-current-tool"
            data-i18n-skip
            title={processText("processCurrentTool", "Current tool: {{name}}", "当前工具：{{name}}", { name: runningSegment.name })}
          >
            {runningSegment.label}
          </span>
        ) : null}
        <strong>{summaryMeta || processText("process", "Process", "过程")}</strong>
        <AiProcessProgressSegments segments={toolSegments} />
      </summary>
      <div className="ai-process-list">
        {hasTimeline ? (
          groups.map((group) => renderProcessGroup(group, message, onApprove, now, onOpenStrategy, onOpenArtifact))
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
            {message.tools.length > 0 && <AiToolGroup items={message.tools.map((tool) => ({ id: `legacy-${tool.id}`, kind: "tool", toolId: tool.id }))} message={message} now={now} onOpenStrategy={onOpenStrategy} onOpenArtifact={onOpenArtifact} />}
            {(message.approvals ?? []).map((approval) => <AiApprovalCard approval={approval} onApprove={onApprove} key={approval.id} />)}
          </>
        )}
      </div>
    </details>
  );
}

function renderProcessGroup(group: AiProcessGroup, message: AiUiMessage, onApprove: (approvalId: string, approved: boolean, reason: string) => void, now: number, onOpenStrategy?: (strategyId: string, runId?: string, optimizationId?: string) => void, onOpenArtifact?: (artifact: AiResearchArtifact) => void) {
  if (group.kind === "tools") return <AiToolGroup items={group.items} message={message} now={now} onOpenStrategy={onOpenStrategy} onOpenArtifact={onOpenArtifact} key={group.id} />;
  if (group.kind === "reasoning-summaries") {
    return (
      <div className="ai-reasoning-summaries" role="list" key={group.id}>
        {group.items.map((item) => (
          <div className="ai-reasoning-summary" role="listitem" data-i18n-skip key={item.id}>
            <MarkdownMessage content={item.content} />
          </div>
        ))}
      </div>
    );
  }
  if (group.kind === "team") {
    return (
      <details className="ai-process-group ai-team-events" key={group.id}>
        <summary>{processText("teamTaskUpdates", "Team task updates", "团队任务更新")} <strong>{group.items.length}</strong></summary>
        <code>{safeJson(group.items.map((item) => message.teamEvents?.[item.index]).filter((item) => item !== undefined))}</code>
      </details>
    );
  }
  return renderTimelineItem(group.item, message, onApprove, now, onOpenStrategy, onOpenArtifact);
}

function renderTimelineItem(item: AiTimelineItem, message: AiUiMessage, onApprove: (approvalId: string, approved: boolean, reason: string) => void, now: number, onOpenStrategy?: (strategyId: string, runId?: string, optimizationId?: string) => void, onOpenArtifact?: (artifact: AiResearchArtifact) => void) {
  if (item.kind === "text") return <MarkdownMessage content={item.content} key={item.id} />;
  if (item.kind === "reasoning-summary") {
    return (
      <div className="ai-reasoning-summary" data-i18n-skip key={item.id}>
        <MarkdownMessage content={item.content} />
      </div>
    );
  }
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
    return tool ? <AiToolCard tool={tool} onOpenStrategy={onOpenStrategy} onOpenArtifact={onOpenArtifact} key={item.id} /> : null;
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
        const now = Date.now();
        const observedTextOrReasoning = Boolean(event.content)
          && (event.channel === "text"
            || event.channel === "text-preview"
            || event.channel === "text-final"
            || event.channel === "reasoning"
            || event.channel === "reasoning-final");
        const activeMessage = {
          ...message,
          startedAt: message.startedAt ?? message.createdAt ?? now,
          firstTokenAt: message.firstTokenAt ?? (observedTextOrReasoning ? now : undefined)
        };
        if (event.channel === "text-preview") {
          return { ...activeMessage, text: event.content, status: "生成结果" };
        }
        if (event.channel === "text-preview-clear") {
          return { ...activeMessage, text: "", status: "处理中" };
        }
        if (event.channel === "text-final") {
          return { ...activeMessage, text: event.content, status: "生成结果" };
        }
        if (event.channel === "reasoning" || event.channel === "reasoning-final") {
          const currentReasoning = activeMessage.reasoning ?? "";
          const nextReasoning = event.channel === "reasoning-final"
            ? event.content
            : currentReasoning + event.content;
          const novelReasoning = nextReasoning.startsWith(currentReasoning)
            ? nextReasoning.slice(currentReasoning.length)
            : event.content;
          if (!novelReasoning) return { ...activeMessage, reasoning: nextReasoning, status: "思考中" };
          return appendAiTimelineText(
            { ...activeMessage, reasoning: nextReasoning, status: "思考中" },
            event.reasoningSummary ? "reasoning-summary" : "reasoning",
            novelReasoning,
            event.reasoningId ?? undefined
          );
        }
        return appendAiTimelineText(
          { ...activeMessage, draftText: `${activeMessage.draftText ?? ""}${event.content}`, status: "处理中" },
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
  if (event.type === "contextUsage") {
    // Context is session-level state. Binding it to the last assistant races
    // native queued turn boundaries and can attribute it to the wrong message.
    return;
  }
  if (event.type === "turnStarted") {
    const now = event.startedAt || Date.now();
    setStatus("streaming");
    setMessages((items) => {
      const completed = updateLastAssistant(items, (message) => ({
        ...message,
        completed: true,
        completedAt: message.completedAt ?? now,
        status: undefined
      }));
      const next = [...completed];
      if (event.prompt?.trim()) {
        next.push({
          id: event.localMessageId || `u-queued-${now}`,
          role: "user",
          text: event.prompt,
          tools: [],
          approvals: [],
          createdAt: now
        });
      }
      next.push({
        id: `a-queued-${now}`,
        role: "assistant",
        text: "",
        reasoning: "",
        tools: [],
        approvals: [],
        usageIsSessionCumulative: true,
        createdAt: now,
        startedAt: now,
        status: "连接模型服务"
      });
      return next;
    });
    return;
  }
  if (event.type === "pendingPrompts" || event.type === "pendingPromptSubmitted" || event.type === "pendingPromptError") return;
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
      finishReason: event.finishReason ?? undefined,
      completedAt: message.completedAt ?? Date.now(),
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
  const failureDetail = failed
    ? (message.content.trim() || (!isFailureStatus(message.status ?? undefined) ? message.status ?? "" : ""))
    : "";
  const completed = failed || storedStatus === "interrupted" || storedStatus === "cancelled" || storedStatus === "canceled" || storedStatus === "completed" || storedStatus === "done" || storedStatus === "success" || storedStatus === "idle";
  const recovered = recoverLegacyFinalText(message.content, metadata.timeline ?? [], completed && !failed);
  metadata.timeline = recovered.timeline;
  const storedText = recovered.content;
  return {
    id: message.id,
    role: message.role === "user" ? "user" : message.role === "system" ? "system" : "assistant",
    text: failed && isGenericAiFailure(storedText) ? "" : storedText,
    reasoning: message.reasoning || undefined,
    completed,
    finishReason: completed ? storedStatus : undefined,
    tools: metadata.tools,
    approvals: metadata.approvals,
    agents: metadata.agents,
    teamEvents: metadata.teamEvents,
    timeline: metadata.timeline,
    usage: message.tokenUsage ?? metadata.usage,
    usageIsSessionCumulative: metadata.usageIsSessionCumulative,
    contextUsage: metadata.contextUsage,
    createdAt: message.createdAt,
    startedAt: metadata.startedAt ?? message.createdAt,
    firstTokenAt: metadata.firstTokenAt,
    completedAt: metadata.completedAt,
    error: failed,
    errorMessage: failed ? normalizeAiFailureMessage(failureDetail) : undefined,
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

function parseStoredAiMetadata(toolJson?: string | null): Pick<AiUiMessage, "tools" | "approvals" | "agents" | "teamEvents" | "timeline" | "usage" | "usageIsSessionCumulative" | "contextUsage" | "startedAt" | "firstTokenAt" | "completedAt"> {
  const empty: Pick<AiUiMessage, "tools" | "approvals" | "agents" | "teamEvents" | "timeline" | "usage" | "usageIsSessionCumulative" | "contextUsage" | "startedAt" | "firstTokenAt" | "completedAt"> = {
    tools: [],
    approvals: [],
    agents: [],
    teamEvents: [],
    timeline: [],
    usage: undefined,
    usageIsSessionCumulative: false,
    contextUsage: undefined,
    startedAt: undefined,
    firstTokenAt: undefined,
    completedAt: undefined
  };
  if (!toolJson) return empty;
  try {
    const parsed = JSON.parse(toolJson);
    if (!Array.isArray(parsed)) return empty;
    const visibleEvents = filterInternalAiToolEvents(parsed);
    const metadata = { ...empty };
    metadata.tools = visibleEvents.reduce<AiToolRun[]>((items, item, index) => {
      if (item?.type === "processText" || item?.type === "processReasoning" || item?.type === "processReasoningSummary") {
        const kind = item.type === "processReasoningSummary"
          ? "reasoning-summary"
          : item.type === "processReasoning"
            ? "reasoning"
            : "text";
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
      if (item?.type === "contextUsage") {
        const usage = item.usage as AiContextUsage | undefined;
        if (usage && Number.isFinite(usage.usedTokens) && usage.usedTokens >= 0
          && (usage.contextWindow === undefined || Number.isFinite(usage.contextWindow) && usage.contextWindow > 0)) {
          metadata.contextUsage = usage;
        }
        return items;
      }
      if (item?.type === "turnTiming") {
        const startedAt = Number(item.startedAt);
        const firstTokenAt = Number(item.firstTokenAt);
        const completedAt = Number(item.completedAt);
        metadata.startedAt = Number.isFinite(startedAt) && startedAt > 0 ? startedAt : metadata.startedAt;
        metadata.firstTokenAt = Number.isFinite(firstTokenAt) && firstTokenAt > 0 ? firstTokenAt : metadata.firstTokenAt;
        metadata.completedAt = Number.isFinite(completedAt) && completedAt > 0 ? completedAt : metadata.completedAt;
        return items;
      }
      if (item?.type === "usageScope") {
        metadata.usageIsSessionCumulative = item.scope === "session-cumulative";
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

export function appendAiTimelineText(
  message: AiUiMessage,
  kind: "text" | "reasoning" | "reasoning-summary",
  content: string,
  id?: string
) {
  if (!content) return message;
  return { ...message, timeline: appendTimelineText(message.timeline, kind, content, id) };
}

function appendTimelineText(
  items: AiTimelineItem[] | undefined,
  kind: "text" | "reasoning" | "reasoning-summary",
  content: string,
  id?: string
) {
  const next = [...(items ?? [])];
  const last = next.at(-1);
  const now = Date.now();
  const stableId = id ? `${kind}-${id}` : undefined;
  if (
    last
    && (last.kind === "text" || last.kind === "reasoning" || last.kind === "reasoning-summary")
    && last.kind === kind
    && (!stableId || last.id === stableId)
  ) {
    next[next.length - 1] = { ...last, content: `${last.content}${content}`, updatedAt: now };
  } else {
    next.push({ id: stableId ?? `${kind}-${now}-${next.length}`, kind, content, createdAt: now, updatedAt: now });
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
    if (item.kind === "reasoning-summary" && last?.kind === "reasoning-summaries") {
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
    } else if (item.kind === "reasoning-summary") {
      groups.push({ id: `reasoning-summaries-${item.id}`, kind: "reasoning-summaries", items: [item] });
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
  const canonicalName = getAiToolPresentation(tool.name).canonicalName;
  if (canonicalName.startsWith("market.") || canonicalName.startsWith("account.")) return processText("read", "Read", "读取");
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
