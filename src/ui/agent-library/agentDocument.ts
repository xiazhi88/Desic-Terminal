import type { AiAgentEnvelope, AiAgentSource } from "../../types";

/**
 * AGENTS.md 文本工具（契约 v3 C2）。
 *
 * 解析只覆盖 Rust 侧渲染出的 YAML 子集（`key: value`、行内数组、引号字符串、
 * 布尔与整数），不做通用 YAML 解析：文件被用户手改坏时不抛异常，而是回退到安全默认值，
 * 真正的校验与拒绝由 Rust 单一实现负责。
 */

export const AGENT_ROLE_SUGGESTIONS = [
  // C20.1：按流程划分的新默认角色（取数 / 账户 / 分析候选）
  "data_digest",
  "account_state",
  "decision_proposal",
  "contrarian",
  "market_structure",
  "order_flow_liquidity",
  "derivatives_positioning",
  "account_risk",
  "intelligence_flow",
  "smart_money",
  "historical_analogy",
  "custom"
] as const;

/** C20.4：角色 → 输出契约（目录/勾选器上的「这个专家返回什么形态」）。 */
export type AiAgentOutputContract = "summary" | "state" | "proposal" | "rebuttal" | "generic";

export function agentOutputContract(role: string): AiAgentOutputContract {
  const normalized = String(role || "").trim().toLowerCase();
  if (normalized === "data_digest") return "summary";
  if (normalized === "account_state") return "state";
  if (normalized === "decision_proposal") return "proposal";
  if (normalized === "contrarian" || normalized === "contrarian_review") return "rebuttal";
  return "generic";
}

/** 输出契约 → i18n 键（zh/en 双份，见 resources.ts）。 */
export const AGENT_OUTPUT_I18N_KEY: Record<AiAgentOutputContract, string> = {
  summary: "agentOutputSummary",
  state: "agentOutputState",
  proposal: "agentOutputProposal",
  rebuttal: "agentOutputRebuttal",
  generic: "agentOutputGeneric"
};

export const AGENT_ENVELOPE_OPTIONS = ["standard", "risk"] as const satisfies readonly AiAgentEnvelope[];

export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;
export const AGENT_ROLE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const AGENT_MAX_CONTENT_BYTES = 200 * 1024;

export type AiAgentDraftFields = {
  id: string;
  name: string;
  role: string;
  envelope: AiAgentEnvelope;
  skills: string[];
  requiresAccount: boolean;
  source: AiAgentSource;
  version: number;
  createdAt: number;
  body: string;
};

function unquote(value: string) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineList(value: string): string[] {
  const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];
  return inner.split(",").map((item) => unquote(item)).filter(Boolean);
}

/** 拆出 frontmatter 与正文。没有合法 frontmatter 时 fields 为空对象、body 为原文。 */
export function parseAgentDocument(content: string): { fields: Record<string, unknown>; body: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) return { fields: {}, body: normalized };
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex < 0) return { fields: {}, body: normalized };
  const rawFrontmatter = normalized.slice(3, endIndex);
  const body = normalized.slice(endIndex + 4).replace(/^\n/, "");
  const fields: Record<string, unknown> = {};
  for (const line of rawFrontmatter.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (!key) continue;
    if (rawValue.startsWith("[")) {
      fields[key] = parseInlineList(rawValue);
      continue;
    }
    if (rawValue === "true" || rawValue === "false") {
      fields[key] = rawValue === "true";
      continue;
    }
    if (/^-?\d+$/.test(rawValue)) {
      fields[key] = Number(rawValue);
      continue;
    }
    fields[key] = unquote(rawValue);
  }
  return { fields, body };
}

/** 正文中某个 `## 标题` 段落的第一条有效内容；缺失时返回空串。 */
export function agentSectionText(content: string, heading: string): string {
  const { body } = parseAgentDocument(content);
  const lines = body.split("\n");
  const target = heading.replace(/^#+\s*/, "").trim();
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      if (inSection) return "";
      inSection = trimmed.replace(/^#+\s*/, "").trim() === target;
      continue;
    }
    if (!inSection || !trimmed) continue;
    return trimmed.replace(/^[-*+]\s*/, "").replace(/^职责[：:]\s*/, "").trim();
  }
  return "";
}

/**
 * 列表/选择器用的一句话职责：优先 `## 职责` 首行，其次正文第一段。
 * 只用于展示，缺失时返回空串（调用方负责回退到角色文案）。
 */
export function extractAgentResponsibility(content: string) {
  const section = agentSectionText(content, "职责");
  if (section) return section;
  const { body } = parseAgentDocument(content);
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return trimmed.replace(/^[-*+]\s*/, "");
  }
  return "";
}

function yamlValue(value: string) {
  // 冒号、星号、前导特殊字符会让裸标量解析失败，统一走双引号形式。
  if (!value) return '""';
  return /^[\s]|[:"'#*&!?{}\[\],%@`]|:$/.test(value) ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

function yamlList(values: string[]) {
  return `[${values.map((value) => yamlValue(value)).join(", ")}]`;
}

/** 新建 Agent 的五段骨架正文（与 Rust `agent.create` 的骨架口径一致）。 */
export function buildAgentSkeletonBody(fields: { name: string; role: string; responsibility: string; requiresAccount: boolean }) {
  // C15：不再有 scopes 字段；工具范围由主 Agent 点名时授予，正文只写证据偏好。
  const evidenceLine = "只用职责所需的只读证据；没有把握的数据必须标注为缺失，而不是推断。";
  return [
    "## 身份",
    `${fields.name || "本 Agent"} 是 Desic Terminal 的只读专家 Agent，角色标识 \`${fields.role || "custom"}\`。`,
    "",
    "## 职责",
    fields.responsibility.trim() || `${fields.name || "本 Agent"} 负责给出本职责范围内的事实、推断与失效条件。`,
    "",
    "## 方法与证据要求",
    `- ${evidenceLine}`,
    "- 每条结论都要带证据与时间戳（数据快照时间、窗口长度、指标口径），区分「事实」「推断」「建议」。",
    "- 不替主 Agent 做最终决策，不执行任何写操作，也不要求其他专家必须服从本报告。",
    fields.requiresAccount
      ? "- 账户类证据必须来自当前 Profile 绑定账户；未绑定账户时明确说明账户证据不可用。"
      : "- 不依赖账户数据；若需要账户结论，请在报告中标注需要账户类专家补齐。",
    "",
    "## 输出偏好",
    "- 先给结论，再给证据、失效条件与数据缺口；能充分回答就返回，不写客套话。",
    "- 报告面向主 Agent 阅读，长度以说清问题为准，不需要 JSON 包装。",
    "",
    "## 数据缺口处理",
    "- 工具失败、数据缺失或样本不足时如实说明影响范围，并给出「缺少什么才能确认」。",
    "- 不得用假设值填补缺口，也不得因为缺口而编造结论。",
    ""
  ].join("\n");
}

/** 渲染完整 AGENTS.md；frontmatter 字段顺序与契约 C2 一致。 */
export function renderAgentDocument(fields: AiAgentDraftFields) {
  const frontmatter = [
    "---",
    `id: ${yamlValue(fields.id)}`,
    `name: ${yamlValue(fields.name)}`,
    `role: ${fields.role}`,
    `envelope: ${fields.envelope}`,
    `skills: ${yamlList(fields.skills)}`,
    `requiresAccount: ${fields.requiresAccount ? "true" : "false"}`,
    `source: ${fields.source}`,
    `version: ${Math.max(1, Math.round(fields.version) || 1)}`,
    `createdAt: ${Math.max(0, Math.round(fields.createdAt))}`,
    "---",
    ""
  ].join("\n");
  return `${frontmatter}${fields.body.replace(/^\n+/, "")}`;
}

/** 由名称派生 id；CJK 等无 ASCII 字母的名称回退到时间戳后缀，保证 `^[a-z0-9][a-z0-9-]{1,47}$`。 */
export function slugifyAgentName(name: string, prefix = "custom") {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const stem = ascii && /[a-z0-9]/.test(ascii) ? ascii : `agent-${Date.now().toString(36)}`;
  const id = `${prefix}-${stem}`.slice(0, 48).replace(/-+$/, "");
  return AGENT_ID_PATTERN.test(id) ? id : `${prefix}-agent-${Date.now().toString(36)}`.slice(0, 48);
}

/** 正文非空且不超过 200KB 的前端预检（最终校验仍在 Rust）。 */
export function validateAgentDraft(content: string, id: string): string | null {
  const { fields, body } = parseAgentDocument(content);
  const declaredId = typeof fields.id === "string" ? fields.id : "";
  if (id && declaredId && declaredId !== id) return "id-mismatch";
  if (!declaredId || !AGENT_ID_PATTERN.test(declaredId)) return "id-invalid";
  const name = typeof fields.name === "string" ? fields.name.trim() : "";
  if (!name || name.length > 40) return "name-invalid";
  const role = typeof fields.role === "string" ? fields.role : "";
  if (!AGENT_ROLE_PATTERN.test(role)) return "role-invalid";
  if (!body.trim()) return "body-empty";
  if (new TextEncoder().encode(content).length > AGENT_MAX_CONTENT_BYTES) return "too-large";
  return null;
}
