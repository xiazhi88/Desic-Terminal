import type { AiAgentProfile } from "../types";
import { normalizeTriage } from "../ui/TriageSettings";
import { normalizeFastlaneConfig, profileTypeOf } from "../ui/fastlane/fastlaneDefaults";

/**
 * Profile 保存的 IPC 载荷构造与自检。
 *
 * 背景（P0 真机 bug）：`ai_agent_profile_save` 的 args 由 Tauri 的 `invoke` 做 JSON 序列化；
 * 只要有一个字段带循环引用/React 节点/BigInt，整次保存就会失败，WebKit 的措辞是
 * `JSON.stringify cannot serialize cyclic structures.`（V8 是 "Converting circular structure to JSON"）。
 *
 * 两条硬约束：
 * 1. 载荷**逐字段显式构造**（不再 `...profileDraft` 整对象透传），新增字段不会悄悄把不可序列化的东西带进 IPC；
 * 2. invoke 之前先做一次**可诊断**的可序列化自检，失败时给出**键路径**，而不是把原始异常丢给用户。
 */

/** 与面板保持一致的必需技能清单（保存时始终写回，Rust 侧也会补齐）。 */
export const REQUIRED_PROFILE_SKILL_IDS = [
  "trading-philosophy",
  "okx-market-intelligence",
  "market-radar-research",
  "desic-trade-operations",
  "desic-agent-orchestration"
] as const;

export type SerializationIssue = {
  /** 出问题的键路径，例如 `profile.triage.escalate`。 */
  path: string;
  /** 机器可读的原因码。 */
  reason: "cycle" | "bigint" | "function" | "symbol" | "dom" | "react";
};

const REASON_LABEL: Record<SerializationIssue["reason"], string> = {
  cycle: "循环引用",
  bigint: "BigInt",
  function: "函数",
  symbol: "Symbol",
  dom: "DOM 节点",
  react: "React 节点"
};

export function describeSerializationIssue(issue: SerializationIssue) {
  return `${REASON_LABEL[issue.reason]}（键路径 ${issue.path}）`;
}

function isDomNode(value: object) {
  const maybe = value as { nodeType?: unknown; nodeName?: unknown };
  return typeof maybe.nodeType === "number" && typeof maybe.nodeName === "string";
}

function isReactElement(value: object) {
  const maybe = value as { $$typeof?: unknown; type?: unknown; props?: unknown };
  return typeof maybe.$$typeof === "symbol" && "props" in maybe;
}

/**
 * 深度遍历查找**第一个**不可（或不可无损）序列化的值。
 * 返回 `null` 表示可以安全 `JSON.stringify`。
 */
export function findNonSerializable(value: unknown, path = "args", seen = new WeakSet<object>()): SerializationIssue | null {
  const type = typeof value;
  if (value === null || type === "undefined" || type === "string" || type === "boolean") return null;
  if (type === "number") return Number.isFinite(value as number) ? null : null;
  if (type === "bigint") return { path, reason: "bigint" };
  if (type === "function") return { path, reason: "function" };
  if (type === "symbol") return { path, reason: "symbol" };
  if (type !== "object") return null;

  const object = value as object;
  if (seen.has(object)) return { path, reason: "cycle" };
  if (isDomNode(object)) return { path, reason: "dom" };
  if (isReactElement(object)) return { path, reason: "react" };

  seen.add(object);
  if (Array.isArray(object)) {
    for (let index = 0; index < object.length; index += 1) {
      const issue = findNonSerializable(object[index], `${path}[${index}]`, seen);
      if (issue) return issue;
    }
    return null;
  }
  for (const [key, item] of Object.entries(object as Record<string, unknown>)) {
    const issue = findNonSerializable(item, `${path}.${key}`, seen);
    if (issue) return issue;
  }
  return null;
}

/** 与 Rust `AiAgentProfileInput` 对齐的**显式字段清单**（逐个写出，不做整对象 spread）。 */
export type ProfileSaveInput = AiAgentProfile;

/**
 * 构造保存载荷。`normalized` 是已经过校验/收敛的取值（名称、符号、试判等），
 * 这里只负责**逐字段搬运**，不改变任何语义。
 */
export function buildProfileSaveInput(
  draft: AiAgentProfile,
  normalized: {
    name: string;
    symbols: string[];
    mode: AiAgentProfile["mode"];
    now: number;
  }
): ProfileSaveInput {
  const fastlaneConfig = normalizeFastlaneConfig(draft);
  const isFastlane = profileTypeOf(draft) === "fastlane";
  return {
    // —— 基础 ——
    id: draft.id,
    name: normalized.name,
    enabled: Boolean(draft.enabled),
    mode: normalized.mode,
    accountId: draft.accountId ?? null,
    environment: draft.environment,
    symbols: normalized.symbols,
    scanIntervalMinutes: Math.max(1, Math.min(1_440, Math.round(Number(draft.scanIntervalMinutes) || 30))),
    // —— 技能与模型 ——
    // 必需技能始终带上（与面板里的 withRequiredProfileSkills 同一语义，避免两处漂移）。
    skillIds: Array.from(new Set([...REQUIRED_PROFILE_SKILL_IDS, ...(draft.skillIds ?? []).map((item) => String(item ?? "").trim()).filter(Boolean)])),
    skillVersions: { ...(draft.skillVersions ?? {}) },
    skillVersionModes: { ...(draft.skillVersionModes ?? {}) },
    model: draft.model ?? null,
    reasoningDepth: draft.reasoningDepth,
    // —— 风险与节奏 ——
    historyLookbackDays: Math.max(1, Math.min(3650, Math.round(Number(draft.historyLookbackDays) || 30))),
    similarityWindowMinutes: Math.max(1, Math.min(1_440, Math.round(Number(draft.similarityWindowMinutes) || 10))),
    entryToleranceBps: Math.max(0, Math.min(1_000, Math.round(Number(draft.entryToleranceBps) || 30))),
    targetLeverage: Math.max(1, Math.min(125, Math.round(Number(draft.targetLeverage) || 20))),
    maxSingleTradeMarginPct: Math.max(1, Math.min(100, Math.round(Number(draft.maxSingleTradeMarginPct) || 30))),
    minWakeIntervalSeconds: Math.max(1, Math.min(86_400, Math.round(Number(draft.minWakeIntervalSeconds) || 60))),
    maxRunsPerHour: Math.max(1, Math.min(720, Math.round(Number(draft.maxRunsPerHour) || 12))),
    // —— 通知与复盘 ——
    feishuEnabled: Boolean(draft.feishuEnabled),
    dailyReviewEnabled: Boolean(draft.dailyReviewEnabled),
    allowedWakeConditionTypes: Array.from(new Set(draft.allowedWakeConditionTypes ?? [])),
    // —— C14 协作 / C19 试判 / C24 单 Agent ——
    collaborationEnabled: Boolean(draft.collaborationEnabled),
    triage: normalizeTriage(draft.triage),
    singleAgentMode: draft.singleAgentMode === "minimal" ? "minimal" : "standard",
    // C20.5（改写版）：勾选名单原样回传（迁移由 Rust 强制完成）。
    enabledAgentIds: [...(draft.enabledAgentIds ?? [])],
    // —— C29 快判（AI Profile 下 Rust 忽略这些字段）——
    profileType: profileTypeOf(draft),
    ...(isFastlane ? {
      fastlaneStylePreset: fastlaneConfig.stylePreset,
      fastlaneStyle: fastlaneConfig.style,
      fastlaneRiskPerTradePct: fastlaneConfig.riskPerTradePct,
      fastlaneMaxDailyLossPct: fastlaneConfig.maxDailyLossPct,
      fastlaneMaxConcurrent: fastlaneConfig.maxConcurrent,
      fastlaneMaxSlippageBps: fastlaneConfig.maxSlippageBps,
      fastlaneMaxActionsPerMinute: fastlaneConfig.maxActionsPerMinute,
      fastlaneQualityFloor: fastlaneConfig.qualityFloor,
      fastlaneEntryScoreFloor: fastlaneConfig.entryScoreFloor,
      // C29.17（2026-09-21）：降险分门槛是**独立字段**（默认 1.5，与入场门槛解耦）——
      // 必须显式搬运，否则 UI 改的值在保存时被静默丢掉（默认值又会盖回来）。
      fastlaneReduceScoreFloor: fastlaneConfig.reduceScoreFloor,
      fastlaneConfidenceFloor: fastlaneConfig.confidenceFloor,
      fastlaneEventBlackoutMinutes: fastlaneConfig.eventBlackoutMinutes,
      fastlaneTradingHours: draft.fastlaneTradingHours ?? "24h",
      fastlaneNotifyPolicy: fastlaneConfig.notifyPolicy,
      fastlaneJevModel: fastlaneConfig.jevModel,
      fastlaneJevBaseUrl: fastlaneConfig.jevBaseUrl,
      fastlaneJevTimeoutMs: fastlaneConfig.jevTimeoutMs,
      fastlaneLlmTimeoutMs: fastlaneConfig.llmTimeoutMs,
      fastlaneLlmReasoningEffort: "none"
    } : {}),
    // —— 时间戳 ——
    createdAt: draft.createdAt || normalized.now,
    updatedAt: normalized.now
  };
}

/** 保存载荷自检：返回 `null` 表示可安全序列化。 */
export function checkProfileSaveArgs(args: Record<string, unknown>): SerializationIssue | null {
  return findNonSerializable(args, "args");
}
