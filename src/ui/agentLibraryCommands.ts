import type { AiAgentDetail, AiAgentEnvelope, AiAgentSource, AiAgentSummary } from "../types";
import { invokeDesktop, isTauriRuntime } from "../lib/tauri";
import { logger } from "../lib/logger";
import { extractAgentResponsibility } from "./agent-library/agentDocument";

/**
 * Agent 库命令入口（契约 v3 C3）。
 *
 * 所有 `ai_agent_*` invoke 都集中在这里：入参一律 camelCase，出参在归一化
 * （`normalizeAgentSummary` / `normalizeAgentDetail`）后才进入 UI，缺字段的旧响应
 * 只会退化成安全默认值，不会让列表或编辑器崩掉。
 */

export type AiAgentGenerateResult = {
  content: string;
  warnings: string[];
};

/**
 * AI 生成草稿的请求（P1/P2/P3）。
 *
 * `requestId` 由 UI 生成并随命令下发给 Rust：流式增量事件 `agentDraftDelta` 与
 * 取消命令 `ai_agent_generate_cancel` 都靠它关联 —— 一次生成只认自己的 requestId，
 * 上一次请求的残留增量不会串进来。
 */
export type AgentDraftRequest = {
  description: string;
  name?: string;
  model?: string;
  requestId: string;
  /** 仅预览夹具使用：把模拟增量直接推给对话框；真机走 `ai:event` 事件流。 */
  onDelta?: (delta: string, chars: number) => void;
  /** 仅预览夹具使用：让假生成器在取消后停止产出。 */
  isCancelled?: () => boolean;
};

const ENVELOPES: readonly AiAgentEnvelope[] = ["standard", "risk"];
const SOURCES: readonly AiAgentSource[] = ["builtin", "custom", "ai"];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function valueString(value: unknown, fallback = "") {
  return value == null ? fallback : String(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.map((item) => valueString(item).trim()).filter(Boolean)))
    : [];
}

export function normalizeAgentSummary(value: unknown): AiAgentSummary | null {
  const record = asRecord(value);
  const id = valueString(record.id).trim();
  const name = valueString(record.name).trim();
  if (!id || !name) return null;
  const envelope = valueString(record.envelope) as AiAgentEnvelope;
  const source = valueString(record.source) as AiAgentSource;
  return {
    id,
    name,
    role: valueString(record.role),
    envelope: ENVELOPES.includes(envelope) ? envelope : "standard",
    skills: stringList(record.skills),
    requiresAccount: Boolean(record.requiresAccount),
    source: SOURCES.includes(source) ? source : "custom",
    version: Number(record.version) || 1,
    updatedAt: Number(record.updatedAt) || 0,
    enabledByProfiles: stringList(record.enabledByProfiles),
    missingSkills: stringList(record.missingSkills),
    missingAccount: Boolean(record.missingAccount),
    modified: Boolean(record.modified),
    scopesDeprecated: Boolean(record.scopesDeprecated)
  };
}

export function normalizeAgentDetail(value: unknown): AiAgentDetail | null {
  const summary = normalizeAgentSummary(value);
  if (!summary) return null;
  return { ...summary, content: valueString(asRecord(value).content) };
}

function requireDesktop(): void {
  if (!isTauriRuntime()) throw new Error("AGENT_LIBRARY_DESKTOP_ONLY");
}

/** `ai_agents_list` → 内置 + 自定义；Rust 已按 source、name 排序。 */
export async function listAiAgents(): Promise<AiAgentSummary[]> {
  requireDesktop();
  const raw = await invokeDesktop<unknown>("ai_agents_list");
  return (Array.isArray(raw) ? raw : [])
    .map(normalizeAgentSummary)
    .filter((item): item is AiAgentSummary => Boolean(item));
}

/** `ai_agent_read` → 完整 AGENTS.md。id 不存在时返回 null。 */
export async function readAiAgent(id: string): Promise<AiAgentDetail | null> {
  requireDesktop();
  const raw = await invokeDesktop<unknown>("ai_agent_read", { id });
  return normalizeAgentDetail(raw);
}

/** `ai_agent_save`：不传 id 时以正文 frontmatter 的 id 落盘。 */
export async function saveAiAgent(input: { id?: string; content: string }): Promise<AiAgentSummary | null> {
  requireDesktop();
  const raw = await invokeDesktop<unknown>("ai_agent_save", {
    ...(input.id ? { id: input.id } : {}),
    content: input.content
  });
  return normalizeAgentSummary(raw);
}

/** `ai_agent_duplicate`：新 id `custom-<slug>-<n>`，source=custom。 */
export async function duplicateAiAgent(input: { id: string; name?: string }): Promise<AiAgentSummary | null> {
  requireDesktop();
  const raw = await invokeDesktop<unknown>("ai_agent_duplicate", {
    id: input.id,
    ...(input.name ? { name: input.name } : {})
  });
  return normalizeAgentSummary(raw);
}

/** `ai_agent_delete`：仅 custom/ai；Rust 会同步从所有 Profile 的 enabledAgentIds 剔除。 */
export async function deleteAiAgent(id: string): Promise<void> {
  requireDesktop();
  await invokeDesktop<unknown>("ai_agent_delete", { id });
}

/**
 * `ai_agent_generate`：自然语言 → AGENTS.md 草稿（不落盘）。
 *
 * C16③：草稿请求必须带上模型配置，否则侧车侧无条件失败；`model` 为模型 id，
 * 缺省由调用方回落到当前模型。
 */
export async function generateAiAgentDraft(input: AgentDraftRequest): Promise<AiAgentGenerateResult> {
  requireDesktop();
  const raw = asRecord(await invokeDesktop<unknown>("ai_agent_generate", {
    description: input.description,
    ...(input.name ? { name: input.name } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {})
  }));
  const content = valueString(raw.content);
  if (!content.trim()) throw new Error("AGENT_DRAFT_EMPTY");
  return { content, warnings: stringList(raw.warnings) };
}

/** P3：取消进行中的草稿生成（幂等：请求已完成时命令报错也按已结束处理）。 */
export async function cancelAiAgentDraft(requestId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invokeDesktop<unknown>("ai_agent_generate_cancel", { requestId });
  } catch (error) {
    // 幂等语义：请求可能已经成功/失败/被取消，不能把用户卡在 loading。
    logger.warn("ai agent draft cancel ignored", { requestId, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * 列表项没有职责字段（契约 C3 的 `AiAgentSummary` 不含 summary），
 * 一句话职责由 `ai_agent_read` 的正文里抽取。按 `id:updatedAt` 缓存，
 * 文件被改动（updatedAt 变化）后才会重新读取。
 */
const responsibilityCache = new Map<string, string>();

export async function loadAgentResponsibilityIndex(agents: AiAgentSummary[], force = false): Promise<Record<string, string>> {
  if (!isTauriRuntime()) return {};
  const pending = agents.filter((agent) => force || !responsibilityCache.has(`${agent.id}:${agent.updatedAt}`));
  await Promise.all(pending.map(async (agent) => {
    try {
      const detail = await readAiAgent(agent.id);
      responsibilityCache.set(`${agent.id}:${agent.updatedAt}`, detail ? extractAgentResponsibility(detail.content) : "");
    } catch (error) {
      logger.warn("agent responsibility read failed", { id: agent.id, error: error instanceof Error ? error.message : String(error) });
    }
  }));
  const index: Record<string, string> = {};
  for (const agent of agents) {
    index[agent.id] = responsibilityCache.get(`${agent.id}:${agent.updatedAt}`) ?? "";
  }
  return index;
}

/** Agent 库变更后失效缓存，避免选择器继续用改前的职责文案。 */
export function invalidateAgentResponsibilityCache(id?: string) {
  if (!id) {
    responsibilityCache.clear();
    return;
  }
  for (const key of Array.from(responsibilityCache.keys())) {
    if (key.startsWith(`${id}:`)) responsibilityCache.delete(key);
  }
}
