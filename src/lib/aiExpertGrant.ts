/**
 * C15：专家点名返回 `{ ok, expertId, expertName, grantedScopes, report }`。
 *
 * 轨迹里要显示"本次授予范围"，数据来源就是工具结果 JSON——**不新增事件字段**。
 * 这里只做只读解析 + 文案，供 AI 研究（`AiMessageProcess`）与运行详情
 * （`AiAutomationPanel`）共用，避免两处各写一份判断。
 */

/** 契约 C15.2 的五个合法域。 */
export const AI_EXPERT_SCOPE_WHITELIST = ["market", "derivatives", "intelligence", "account", "history"] as const;

export type AiExpertGrant = {
  expertId: string;
  expertName: string;
  grantedScopes: string[];
  /** 全部只读（缺省不限制或显式声明五域）。 */
  allScopes: boolean;
};

type Translate = (key: string, english: string, chinese: string, values?: Record<string, unknown>) => string;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * 从工具结果里读授予范围。结果不是专家点名形状（没有 `grantedScopes` 数组）时返回 null，
 * 因此对普通工具调用完全无副作用。非法/空数组按"全部只读"处理（与 C15.2 语义一致）。
 */
export function readExpertGrant(result: unknown): AiExpertGrant | null {
  const record = asRecord(result);
  if (!Array.isArray(record.grantedScopes)) return null;
  const grantedScopes = Array.from(new Set(
    record.grantedScopes.map((item) => String(item ?? "").trim()).filter(Boolean)
  ));
  const whitelist = new Set<string>(AI_EXPERT_SCOPE_WHITELIST);
  const allScopes = grantedScopes.length === 0
    || grantedScopes.every((scope) => whitelist.has(scope)) && grantedScopes.length === AI_EXPERT_SCOPE_WHITELIST.length;
  return {
    expertId: String(record.expertId ?? ""),
    expertName: String(record.expertName ?? ""),
    grantedScopes,
    allScopes
  };
}

/** 一行轨迹文案；不是专家点名结果时返回空串。 */
export function expertGrantLabel(result: unknown, text: Translate) {
  const grant = readExpertGrant(result);
  if (!grant) return "";
  return formatGrantedScopes(grant.grantedScopes, grant.allScopes, text);
}

/**
 * 把 `{{name}}` 占位符替换掉。
 *
 * i18next 会自己插值，但运行轨迹（`AgentCollaborationTrace`）用的是中文字面量实现，
 * 不带插值器；这里统一兜一层，保证任何调用方都不会把 `{{scopes}}` 原样渲染出来。
 */
function applyValues(template: string, values?: Record<string, unknown>) {
  if (!values) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in values ? String(values[key]) : match));
}

/** 已解析出的授予范围 → 文案（运行轨迹 lane 复用同一套措辞）。 */
export function formatGrantedScopes(grantedScopes: string[], allScopes: boolean, text: Translate) {
  if (allScopes || grantedScopes.length === 0) {
    return applyValues(text("runExpertGrantAll", "All read-only tools", "全部只读"));
  }
  return applyValues(
    text("runExpertGrantScopes", "Granted scopes: {{scopes}}", "本次授予范围：{{scopes}}", { scopes: grantedScopes.join(" · ") }),
    { scopes: grantedScopes.join(" · ") }
  );
}

const ALL_SCOPE_SET = new Set<string>(AI_EXPERT_SCOPE_WHITELIST);

/**
 * 运行轨迹专用：从事件流里找主 Agent 的专家点名结果（`consult_expert` / `follow_up`），
 * 得到 `expertId → grantedScopes`。C15.3 要求显示在"专家会话那一步"，而点名结果挂在
 * 主 Agent 的工具调用上，因此这里把它关联回对应的专家 lane。
 */
export function collectExpertGrants(events: unknown[]): Map<string, { grantedScopes: string[]; allScopes: boolean }> {
  const grants = new Map<string, { grantedScopes: string[]; allScopes: boolean }>();
  const remember = (grant: ReturnType<typeof readExpertGrant>) => {
    if (!grant) return;
    for (const key of [grant.expertId, grant.expertName].map((value) => value.trim()).filter(Boolean)) {
      if (!grants.has(key)) grants.set(key, { grantedScopes: grant.grantedScopes, allScopes: grant.allScopes });
    }
  };
  for (const event of events) {
    const record = asRecord(event);
    if (String(record.type ?? "") !== "toolResult") continue;
    const result = asRecord(record.result);
    // C18.1 批量形状：{ ok, results: [{ expertId, expertName, mode, grantedScopes, report }], failures }
    if (Array.isArray(result.results)) {
      for (const item of result.results) remember(readExpertGrant(item));
      continue;
    }
    // C15 单点形状：{ ok, expertId, expertName, grantedScopes, report }
    if (Array.isArray(result.grantedScopes)) remember(readExpertGrant(result));
  }
  return grants;
}

export type AiExpertMode = "parallel" | "serial";

function readExpertMode(value: unknown): AiExpertMode | null {
  const mode = String(value ?? "").trim().toLowerCase();
  if (mode === "parallel") return "parallel";
  if (mode === "serial") return "serial";
  return null;
}

/**
 * C18.3：每位专家的执行方式（`consult_experts` 的 `results[].mode`）。
 *
 * 数据来源仍是工具结果 JSON（不新增事件字段）。注意：`consult_expert` / `follow_up`
 * 是单点咨询，结果里没有 mode——调用方应按"串行"渲染（v3 下主 Agent 一次只等一位），
 * 绝不能因为缺字段就默认标成"并行"。
 */
export function collectExpertModes(events: unknown[]): Map<string, AiExpertMode> {
  const modes = new Map<string, AiExpertMode>();
  const remember = (expertId: unknown, expertName: unknown, mode: unknown) => {
    const parsed = readExpertMode(mode);
    if (!parsed) return;
    for (const key of [String(expertId ?? "").trim(), String(expertName ?? "").trim()].filter(Boolean)) {
      if (!modes.has(key)) modes.set(key, parsed);
    }
  };
  for (const event of events) {
    const record = asRecord(event);
    if (String(record.type ?? "") !== "toolResult") continue;
    const result = asRecord(record.result);
    if (Array.isArray(result.results)) {
      for (const item of result.results) {
        const entry = asRecord(item);
        remember(entry.expertId, entry.expertName, entry.mode);
      }
      continue;
    }
    remember(result.expertId, result.expertName, result.mode);
  }
  return modes;
}

export function isGrantedAllScopes(grantedScopes: string[]) {
  return grantedScopes.length === 0 || (grantedScopes.length === ALL_SCOPE_SET.size && grantedScopes.every((scope) => ALL_SCOPE_SET.has(scope)));
}
