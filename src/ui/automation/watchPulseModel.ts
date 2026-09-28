/*
 * 值守心电图 —— 纯数据与格式化（无 DOM）。
 *
 * 口径与 AiAutomationPanel.tsx 保持一致：
 * - `deepState` ≡ `resolveDeepAnalysisState`（四态：deep / skipped / off / na）；
 * - `laneWake` ≡ `profileFallbackWakeAt`（min(上次 nextWakeAt, 上次活动 + scanIntervalMinutes)）。
 */
import type { AiAutomationPulseRun, AiAutomationPulseTokens } from "../../lib/ai";
import { i18n } from "../../i18n/runtime";
import type { AiAgentProfile, AiAutomationRun, AiUsageSummary } from "../../types";

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export type PulseRun = AiAutomationPulseRun;

/** 泳道只需要 Profile 的这几个字段（预览夹具与真实 Profile 都满足）。 */
export type WatchPulseProfile = Pick<AiAgentProfile, "id" | "name" | "environment" | "scanIntervalMinutes" | "dailyReviewEnabled"> & {
  triage?: { mode?: string; skipSampleRate?: number } | null;
};

export function isZh() {
  return (i18n.resolvedLanguage || i18n.language || "en-US").toLowerCase().startsWith("zh");
}

/** 与 AiAutomationPanel.tsx 的 `automationText` 相同：稳定 key + 中英默认值。 */
export function pulseText(key: string, english: string, chinese: string, values: Record<string, unknown> = {}) {
  return String(i18n.t(`automation:${key}`, { defaultValue: isZh() ? chinese : english, ...values }));
}

// ── 状态 / 触发 / 试判模式文案 ──
export function triggerLabel(value: string) {
  const labels: Record<string, [string, string, string]> = {
    manual: ["runTriggerManual", "Manual", "手动"],
    schedule: ["runTriggerSchedule", "Scheduled scan", "定时扫描"],
    wake_condition: ["runTriggerCondition", "Condition matched", "条件命中"],
    event: ["runTriggerEvent", "Event", "事件"],
    daily_market_review: ["pulseTriggerDailyReview", "Daily review", "每日复盘"]
  };
  const entry = labels[value];
  return entry ? pulseText(entry[0], entry[1], entry[2]) : value;
}

export function statusLabel(status: string) {
  const labels: Record<string, [string, string, string]> = {
    running: ["pulseStatusRunning", "Running", "运行中"],
    completed: ["pulseStatusCompleted", "Completed", "已完成"],
    failed: ["pulseStatusFailed", "Failed", "失败"],
    skipped: ["pulseStatusSkipped", "Skipped", "已跳过"],
    queued: ["pulseStatusQueued", "Queued", "排队中"],
    cancelled: ["pulseStatusCancelled", "Cancelled", "已取消"],
    canceled: ["pulseStatusCancelled", "Cancelled", "已取消"]
  };
  const entry = labels[status];
  return entry ? pulseText(entry[0], entry[1], entry[2]) : status;
}

export function triageModeLabel(mode: string | null | undefined) {
  if (mode === "shadow") return pulseText("triageModeShadowShort", "shadow", "影子");
  if (mode === "enforce") return pulseText("triageModeEnforceShort", "enforce", "强制");
  return pulseText("triageModeOffShort", "off", "关闭");
}

/** 失败与取消都画成下凹的警示三角（与列表的 `isRunAbnormal` 同口径）。 */
export function isFailedRun(run: Pick<PulseRun, "status">) {
  return run.status === "failed" || run.status === "cancelled" || run.status === "canceled";
}
export function isLiveRun(run: Pick<PulseRun, "status">) {
  return run.status === "running";
}

// ── 深度判定（≡ resolveDeepAnalysisState） ──
export type DeepState = "deep" | "skipped" | "off" | "na";
export function deepState(run: PulseRun): DeepState {
  const triage = run.triage;
  if (!triage) return "off";
  if (triage.mode === "off") return "off";
  const phase = (triage.phase ?? "").toLowerCase();
  if (triage.verdict === "escalate" || phase === "deep") return "deep";
  if (triage.verdict === "skip" || phase === "skipped" || run.status === "skipped") return "skipped";
  return "na";
}
export function isDeep(run: PulseRun) {
  const state = deepState(run);
  return state === "deep" || state === "off";
}
export function deepTokens(run: PulseRun) {
  return run.triage ? run.triage.deepTokens ?? null : run.tokenUsage?.totalTokens ?? null;
}

const DEEP_MAX_STEPS = [2e5, 4e5, 6e5, 8e5, 1e6, 1.5e6, 2e6, 3e6, 5e6];
/** 满格高度对应的深度 token：取可见数据里的最大值，向上取整到一个易读的档位。 */
export function deepMaxOf(runs: PulseRun[]) {
  let max = 0;
  for (const run of runs) {
    if (run.status !== "completed" || !isDeep(run)) continue;
    max = Math.max(max, deepTokens(run) ?? 0);
  }
  if (max <= 0) return DEEP_MAX_STEPS[0];
  return DEEP_MAX_STEPS.find((step) => step >= max) ?? max;
}

// ── 下次唤醒（≡ profileFallbackWakeAt） ──
export type LaneWake =
  | { status: "running" | "queued"; target: null; run: PulseRun }
  | { status: "waiting"; target: number; run: PulseRun }
  | { status: "none"; target: null; run: null };
export function laneWake(profile: WatchPulseProfile, runs: PulseRun[]): LaneWake {
  const active = runs.find((run) => run.status === "running" || run.status === "queued");
  if (active) return { status: active.status as "running" | "queued", target: null, run: active };
  let latest: PulseRun | null = null;
  let latestAt = -Infinity;
  for (const run of runs) {
    const at = Math.max(run.finishedAt ?? 0, run.startedAt);
    if (at > latestAt) { latestAt = at; latest = run; }
  }
  if (!latest) return { status: "none", target: null, run: null };
  const lastActivity = latest.finishedAt ?? latest.startedAt;
  const fallback = lastActivity + Math.max(1, profile.scanIntervalMinutes || 1) * MIN;
  const target = typeof latest.nextWakeAt === "number" ? Math.min(latest.nextWakeAt, fallback) : fallback;
  return { status: "waiting", target, run: latest };
}

// ── 完整运行 → 轻量脉冲（夹具、以及面板实时推送的最新运行） ──
function briefTokens(summary: AiUsageSummary | null | undefined): AiAutomationPulseTokens | null {
  const usage = summary?.usage;
  if (!usage) return null;
  const input = Number(usage.inputTokens) || 0;
  const output = Number(usage.outputTokens) || 0;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: Number(usage.cacheReadTokens) || 0,
    totalTokens: Number.isFinite(Number(usage.totalTokens)) ? Number(usage.totalTokens) : input + output
  };
}

export function pulseRunFromAutomationRun(run: AiAutomationRun): PulseRun {
  const raw = run.triage && typeof run.triage === "object" ? run.triage : null;
  let triage: PulseRun["triage"] = null;
  if (raw && Object.keys(raw).length > 0) {
    const verdictText = String(raw.verdict ?? "").toLowerCase();
    const verdict = verdictText === "skip" || verdictText === "escalate"
      ? verdictText
      : raw.escalate === true ? "escalate" : raw.escalate === false ? "skip" : null;
    const forcedBy = Array.isArray(raw.forcedBy) ? raw.forcedBy.map(String).filter(Boolean) : [];
    const triageUsage = briefTokens(raw.triageUsage);
    const deepUsage = briefTokens(raw.deepUsage);
    const mode = String(raw.mode ?? "").toLowerCase();
    triage = {
      mode: mode === "off" || mode === "shadow" || mode === "enforce" ? mode : null,
      verdict,
      phase: raw.phase ? String(raw.phase) : null,
      forced: raw.forced === true || forcedBy.length > 0,
      forcedBy,
      sampled: raw.sampled === true || String(raw.sampled).toLowerCase() === "true",
      triageTokens: triageUsage?.totalTokens ?? (Number.isFinite(Number(raw.triageTokens)) ? Number(raw.triageTokens) : null),
      deepTokens: deepUsage?.totalTokens ?? (Number.isFinite(Number(raw.deepTokens)) ? Number(raw.deepTokens) : null),
      triageUsage,
      deepUsage
    };
  }
  const experts = Array.isArray(run.experts) ? run.experts : [];
  const counts = run.actionCounts ?? {};
  return {
    id: run.id,
    profileId: run.profileId,
    triggerType: run.triggerType,
    status: run.status,
    recordKind: run.recordKind ?? "ai",
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    nextWakeAt: run.nextWakeAt ?? null,
    error: run.error ?? null,
    actionCounts: {
      opportunity: counts.opportunity ?? 0,
      wake: counts.wake ?? 0,
      trade: counts.trade ?? 0,
      notification: counts.notification ?? 0
    },
    tokenUsage: briefTokens(run.tokenUsage),
    triage,
    expertCount: experts.length,
    expertToolCalls: experts.reduce((sum, expert) => sum + (expert.toolCalls ?? 0), 0)
  };
}

/** 抽屉打开完整运行详情时，列表之外的运行需要一个占位 `AiAutomationRun`。 */
export function automationRunStub(run: PulseRun): AiAutomationRun {
  return {
    id: run.id,
    profileId: run.profileId,
    triggerType: run.triggerType,
    status: run.status,
    recordKind: run.recordKind,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    nextWakeAt: run.nextWakeAt,
    error: run.error,
    actionCounts: run.actionCounts
  };
}

// ── 格式化 ──
export const pad = (n: number) => String(n).padStart(2, "0");
export const fHMS = (t: number) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
export const fHM = (t: number) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const fMD = (t: number) => { const d = new Date(t); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
export const fStamp = (t: number, ref: number) => (sameDay(t, ref) ? "" : `${fMD(t)} `) + fHMS(t);

export function weekdayLabel(t: number) {
  const day = new Date(t).getDay();
  if (isZh()) return `周${"日一二三四五六"[day]}`;
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day];
}

export function fDur(ms: number) {
  const zh = isZh();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return zh ? `${s} 秒` : `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return zh ? `${m} 分${r ? ` ${r} 秒` : ""}` : `${m}m${r ? ` ${r}s` : ""}`;
  const h = Math.floor(m / 60);
  return zh ? `${h} 小时${m % 60 ? ` ${m % 60} 分` : ""}` : `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

export function fCount(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${h ? `${h}:${pad(m)}` : m}:${pad(r)}`;
}

export function fTok(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "--";
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K`;
  return String(Math.round(n));
}

export const fPct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "--");

/** 泳道副标题：节奏来自 Profile 的最长静默（scanIntervalMinutes）。 */
export function cadenceLabel(profile: WatchPulseProfile) {
  const minutes = Math.max(1, profile.scanIntervalMinutes || 1);
  if (profile.dailyReviewEnabled && minutes >= 1440) return pulseText("pulseCadenceDaily", "Scheduled · daily", "定时 · 每日");
  if (minutes % 1440 === 0) return pulseText("pulseCadenceDays", "Scheduled · every {{n}} d", "定时 · 每 {{n}} 天", { n: minutes / 1440 });
  if (minutes % 60 === 0) return pulseText("pulseCadenceHours", "Scheduled · every {{n}} h", "定时 · 每 {{n}} 小时", { n: minutes / 60 });
  return pulseText("pulseCadenceMinutes", "Scheduled · every {{n}} min", "定时 · 每 {{n}} 分钟", { n: minutes });
}

// ── 摘要条（可见窗口内） ──
export type PulseSummary = {
  total: number;
  completed: number;
  skipped: number;
  failed: number;
  running: number;
  triaged: number;
  deep: number;
  escalated: number;
  forced: number;
  sampled: number;
  off: number;
  triageTotal: number;
  triageCache: number;
  deepTotal: number;
  deepCache: number;
  deepPending: number;
  actions: { trade: number; opportunity: number; notification: number; wake: number };
};

export function summarize(runs: PulseRun[]): PulseSummary {
  const out: PulseSummary = {
    total: runs.length, completed: 0, skipped: 0, failed: 0, running: 0,
    triaged: 0, deep: 0, escalated: 0, forced: 0, sampled: 0, off: 0,
    triageTotal: 0, triageCache: 0, deepTotal: 0, deepCache: 0, deepPending: 0,
    actions: { trade: 0, opportunity: 0, notification: 0, wake: 0 }
  };
  for (const run of runs) {
    const state = deepState(run);
    // 每条运行只进一个桶：试判跳过的运行在库里可能是 completed，按"跳过"计。
    if (isFailedRun(run)) out.failed += 1;
    else if (run.status === "running") out.running += 1;
    else if (run.status === "skipped" || state === "skipped") out.skipped += 1;
    else if (run.status === "completed") out.completed += 1;
    if (state === "off") out.off += 1;
    if (run.triage && run.triage.mode !== "off" && state !== "na") {
      out.triaged += 1;
      if (state === "deep") {
        out.deep += 1;
        if (run.triage.verdict === "escalate") out.escalated += 1;
        else if (run.triage.forcedBy.length) out.forced += 1;
        else if (run.triage.sampled) out.sampled += 1;
      }
    }
    if (run.triage) {
      if (run.triage.triageUsage) { out.triageTotal += run.triage.triageUsage.totalTokens; out.triageCache += run.triage.triageUsage.cacheReadTokens; }
      if (run.triage.deepUsage) { out.deepTotal += run.triage.deepUsage.totalTokens; out.deepCache += run.triage.deepUsage.cacheReadTokens; }
      else if (run.status === "running") out.deepPending += 1;
    } else if (run.tokenUsage) {
      out.deepTotal += run.tokenUsage.totalTokens;
      out.deepCache += run.tokenUsage.cacheReadTokens;
    } else if (run.status === "running") {
      out.deepPending += 1;
    }
    out.actions.trade += run.actionCounts.trade || 0;
    out.actions.opportunity += run.actionCounts.opportunity || 0;
    out.actions.notification += run.actionCounts.notification || 0;
    out.actions.wake += run.actionCounts.wake || 0;
  }
  return out;
}

export const ACTION_KEYS = ["trade", "opportunity", "notification", "wake"] as const;
export type ActionKey = (typeof ACTION_KEYS)[number];
export function actionLabel(key: ActionKey) {
  if (key === "trade") return pulseText("pulseActionTrade", "Trade", "交易");
  if (key === "opportunity") return pulseText("pulseActionOpportunity", "Opportunity", "交易机会");
  if (key === "notification") return pulseText("pulseActionNotification", "Notification", "通知");
  return pulseText("pulseActionWake", "Watch plan", "观察计划");
}
