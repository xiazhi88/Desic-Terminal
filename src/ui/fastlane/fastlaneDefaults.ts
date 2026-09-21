import type { AiAgentProfile, AiProfileType, FastlaneNotifyPolicy, FastlaneStylePreset } from "../../types";

/**
 * 快判模式（C29）默认值与归一化。
 *
 * 默认值逐字对齐契约 C29.4 / C29.7；旧 Profile 缺字段时按这些默认值补齐（只在创建时写入，
 * 读旧 Profile 时忽略 —— 见 C29.7「旧类型忽略、默认值仅用于创建」）。
 */

export type FastlaneConfig = {
  stylePreset: FastlaneStylePreset;
  style: string;
  riskPerTradePct: number;
  maxDailyLossPct: number;
  maxConcurrent: number;
  maxSlippageBps: number;
  maxActionsPerMinute: number;
  qualityFloor: number;
  /**
   * **入场分门槛**（C29 变更 B，2026-09-21）：打分臂的方向判定线。
   * `max(long_score, short_score) ≥ 本值` 且两分不并列 → 方向 = argmax；否则观望（保守）。
   */
  entryScoreFloor: number;
  /**
   * **降险分门槛**（C29.17，2026-09-21）：降险臂自己的判定线（`reduce_score ≥ 本值` → 判降险）。
   * 与 `entryScoreFloor` **各自独立**，默认同为 **1.5**（= 解耦前"复用同一门槛"的行为，
   * 默认下行为零变化）；可配区间同为 0.5–3.0。
   */
  reduceScoreFloor: number;
  confidenceFloor: number;
  eventBlackoutMinutes: number;
  notifyPolicy: FastlaneNotifyPolicy;
  jevModel: string;
  /** Jev 服务地址；留空字符串 = 用官方默认（后端也会回落）。 */
  jevBaseUrl: string;
  jevTimeoutMs: number;
  llmTimeoutMs: number;
  /** 必须关思考（实测依据 C29.3）；UI 只读展示，不允许改成开启。 */
  llmReasoningEffort: "none";
};

export const FASTLANE_DEFAULTS: FastlaneConfig = {
  stylePreset: "long_pullback",
  style: "",
  riskPerTradePct: 0.5,
  maxDailyLossPct: 2,
  maxConcurrent: 1,
  maxSlippageBps: 5,
  maxActionsPerMinute: 1,
  /**
   * **入场质量门（几何 R:R 底线）默认 1.2** —— 名字 / clamp 区间 / 三处同源纪律沿用，
   * **语义在 C29.18（2026-09-21）变了**：从「读 Jev `quality` 分」改成「**纯代码判据的几何 R:R 底线**」。
   *
   * 依据 `artifacts/fastlane-quality-rephrase/report-20260921-081256.md`：
   * ① 门槛 1.2 落在 `quality` 自己的支撑集 [1.31, 2.19] 之外 ⇒ **这道门等于没拦**（放行 116/116）；
   * ② 三种换问法的判别力**全部低于现状**（AUC 0.466 / 0.5612 / 0.5065 vs 0.6806）⇒ 不该再问模型。
   *
   * 判据（**唯一实现 = 侧车 `scripts/cline-fastlane.mjs::fastlaneEntryQuality`**，UI 只展示）：
   * `结构可辨` ∧ `止损可放` ∧ `几何 R:R ≥ 本值`，三条各有独立原因码
   * （`structure_unclear` / `stop_not_placeable` / `rr_below_floor`）。
   *
   * **三处必须同源**：这里 / `src-tauri/src/fastlane.rs::FASTLANE_DEFAULT_QUALITY_FLOOR` /
   * `scripts/cline-fastlane.mjs::FASTLANE_DEFAULTS.qualityFloor`（有源码级防漂移断言钉死）。
   * 值夹到 **0.5–3.0**（[`FASTLANE_QUALITY_FLOOR_MIN`] / `MAX`，与 Rust `normalized()` 同区间）。
   * ⚠️ **只影响新建 Profile**：已有 Profile 落盘的 `fastlaneQualityFloor` 不会自动变。
   */
  qualityFloor: 1.2,
  /**
   * 入场分门槛默认值 **1.5**（2026-09-21 用户裁决：Jev 问题面改双打分 + 代码侧阈值）。
   *
   * 依据：`artifacts/fastlane-jev-rephrase-probe/report-20260921-070600.md`（真实调用 Jev）——
   * 同一份 byte 级相同的 state，把「该做什么？」（choice，含观望）换成两个 `score`
   * （`long_score` / `short_score`：**现在做多 / 做空这一个具体动作**有多该做）后，
   * 「给方向率」从 **0.0%** 变成阈值 1.0 时 **80.5%**（方向准确率 95.5%）、阈值 1.5 时 16.0%
   * （准确率 100%）；阈值 2/2.5/3 结构性打不中（0%）。
   * ⚠️ `score` 是 **0–4 分布上的期望值**（实测集中 0.2–1.9），不是档位 → 门槛必须落在期望值尺度上。
   *
   * **三处必须同源**：这里 / `src-tauri/src/fastlane.rs::FASTLANE_DEFAULT_ENTRY_SCORE_FLOOR` /
   * `scripts/cline-fastlane.mjs::FASTLANE_DEFAULTS.entryScoreFloor`（有防漂移断言钉死）。
   * ⚠️ **只影响新建 Profile**：已有 Profile 落盘的 `fastlaneEntryScoreFloor` 不会自动变。
   */
  entryScoreFloor: 1.5,
  /**
   * 降险分门槛默认值 **1.5**（C29.17，2026-09-21）—— 与入场分门槛**解耦**后的独立旋钮。
   *
   * 背景：C29.14 让降险臂复用 `entryScoreFloor`（记录里两个门槛恒同值，22/22 核对过），
   * 于是"想把降险放宽一点"只能连带放宽开仓。但**两类动作取向不同**：开仓要**挑**
   * （宁缺毋滥，代价是错过），降险要**快**（宁可多减一点，代价是少赚）。
   *
   * ⚠️ **默认仍是 1.5，默认下行为与解耦前逐字一致**（同一个值，只是现在可分别调）——
   * 这不是"放宽风控"，而是**把旋钮交出来**：降险只作用于**既有持仓**
   * （持仓事实不是 `held` 时一律不动手）→ 放宽降险不会产生新仓位、不放大暴露。
   *
   * **三处必须同源**：这里 / `src-tauri/src/fastlane.rs::FASTLANE_DEFAULT_REDUCE_SCORE_FLOOR` /
   * `scripts/cline-fastlane.mjs::FASTLANE_DEFAULTS.reduceScoreFloor`（有防漂移断言钉死）。
   * ⚠️ **只影响新建 Profile**：已有 Profile 落盘的 `fastlaneReduceScoreFloor` 不会自动变。
   */
  reduceScoreFloor: 1.5,
  confidenceFloor: 0.6,
  eventBlackoutMinutes: 30,
  notifyPolicy: "on_open_close",
  jevModel: "jev-latest",
  jevBaseUrl: "https://api.typesafe.ai",
  jevTimeoutMs: 1_500,
  llmTimeoutMs: 3_000,
  llmReasoningEffort: "none"
};

/** 快判模式的触发默认值（复用既有字段，创建时写入）。 */
export const FASTLANE_TRIGGER_DEFAULTS = {
  maxSilenceMinutes: 10,
  minWakeIntervalSeconds: 10,
  maxRunsPerHour: 120
} as const;

/**
 * **入场质量门（几何 R:R 底线）的可配区间**（C29.18）—— 与
 * `src-tauri/src/fastlane.rs::FASTLANE_QUALITY_FLOOR_MIN/MAX` 和侧车 `FASTLANE_QUALITY_FLOOR_MIN/MAX`
 * **三处同源**（下界 0.5 = 再低等于关掉这道门，要关就显式取 0.5；上界 3.0 = 之上结构性打不中）。
 */
export const FASTLANE_QUALITY_FLOOR_MIN = 0.5;
export const FASTLANE_QUALITY_FLOOR_MAX = 3.0;

/** 3 个风格预设：自然语言文本会直接进入参数生成 prompt。 */
export const FASTLANE_STYLE_PRESETS: FastlaneStylePreset[] = ["long_pullback", "range_both", "breakout_follow", "custom"];

export function fastlaneStylePresetText(preset: FastlaneStylePreset, language: string): string {
  const zh = language.toLowerCase().startsWith("zh");
  switch (preset) {
    case "long_pullback":
      return zh
        ? "只做多回踩：只在回踩到最近结构支撑或均线附近、且 5m K 线出现止跌确认时开多；不做空，不追高。止损放在结构位下方并留出 1.5×ATR14(1h) 的缓冲，盈亏比底线 2:1。"
        : "Long pullbacks only: go long only on a pullback into the latest structural support or moving average with 5m reversal confirmation; never short, never chase. Stop below the structure with a 1.5×ATR14(1h) buffer; minimum reward:risk 2:1.";
    case "range_both":
      return zh
        ? "双边区间：只在区间上沿做空、下沿做多，区间中部不动；破区间则等回抽确认。止损放区间外 0.3×ATR14(1h)，盈亏比底线 1.5:1。"
        : "Both sides of the range: short the upper edge and long the lower edge only, stay out of the middle; on a breakout wait for a retest. Stop 0.3×ATR14(1h) outside the range; minimum reward:risk 1.5:1.";
    case "breakout_follow":
      return zh
        ? "突破跟随：只在放量突破关键位、且回抽不破时顺势进场；缩量突破不做。止损放突破位下方 0.5×ATR14(1h)，盈亏比底线 2:1。"
        : "Breakout follow: enter only on a volume-backed break of a key level that holds on the retest; skip low-volume breaks. Stop 0.5×ATR14(1h) below the break; minimum reward:risk 2:1.";
    default:
      return "";
  }
}

function numberOr(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeFastlaneConfig(profile: Pick<AiAgentProfile,
  | "fastlaneStylePreset" | "fastlaneStyle" | "fastlaneRiskPerTradePct" | "fastlaneMaxDailyLossPct"
  | "fastlaneMaxConcurrent" | "fastlaneMaxSlippageBps" | "fastlaneMaxActionsPerMinute"
  | "fastlaneQualityFloor" | "fastlaneEntryScoreFloor" | "fastlaneReduceScoreFloor" | "fastlaneConfidenceFloor" | "fastlaneEventBlackoutMinutes"
  | "fastlaneNotifyPolicy" | "fastlaneJevModel" | "fastlaneJevBaseUrl" | "fastlaneJevTimeoutMs" | "fastlaneLlmTimeoutMs"
  | "fastlaneLlmReasoningEffort"
>): FastlaneConfig {
  const preset = profile.fastlaneStylePreset;
  const notify = profile.fastlaneNotifyPolicy;
  return {
    stylePreset: FASTLANE_STYLE_PRESETS.includes(preset as FastlaneStylePreset) && preset !== "custom"
      ? preset as FastlaneStylePreset
      : profile.fastlaneStyle?.trim() ? "custom" : FASTLANE_DEFAULTS.stylePreset,
    style: typeof profile.fastlaneStyle === "string" ? profile.fastlaneStyle : "",
    riskPerTradePct: Math.min(100, Math.max(0.05, numberOr(profile.fastlaneRiskPerTradePct, FASTLANE_DEFAULTS.riskPerTradePct))),
    maxDailyLossPct: Math.min(100, Math.max(0.1, numberOr(profile.fastlaneMaxDailyLossPct, FASTLANE_DEFAULTS.maxDailyLossPct))),
    maxConcurrent: Math.max(1, Math.round(numberOr(profile.fastlaneMaxConcurrent, FASTLANE_DEFAULTS.maxConcurrent))),
    maxSlippageBps: Math.min(500, Math.max(0, Math.round(numberOr(profile.fastlaneMaxSlippageBps, FASTLANE_DEFAULTS.maxSlippageBps)))),
    maxActionsPerMinute: Math.max(1, Math.round(numberOr(profile.fastlaneMaxActionsPerMinute, FASTLANE_DEFAULTS.maxActionsPerMinute))),
    qualityFloor: Math.min(FASTLANE_QUALITY_FLOOR_MAX, Math.max(FASTLANE_QUALITY_FLOOR_MIN, numberOr(profile.fastlaneQualityFloor, FASTLANE_DEFAULTS.qualityFloor))),
    // 入场分门槛夹到 0.5–3.0（与 Rust `FastlaneConfig::normalized()` 同一区间）：
    // 低于 0.5 等于对任何打分都放行；高于 3.0 结构性打不中（实验实测 0% 给方向率）。
    entryScoreFloor: Math.min(3, Math.max(0.5, numberOr(profile.fastlaneEntryScoreFloor, FASTLANE_DEFAULTS.entryScoreFloor))),
    // 降险分门槛（C29.17）：**同规则**夹到 0.5–3.0（与 Rust `normalized()` 同一区间、同一边界理由），
    // 与入场门槛各自独立（默认同值 1.5）。
    reduceScoreFloor: Math.min(3, Math.max(0.5, numberOr(profile.fastlaneReduceScoreFloor, FASTLANE_DEFAULTS.reduceScoreFloor))),
    confidenceFloor: Math.min(1, Math.max(0, numberOr(profile.fastlaneConfidenceFloor, FASTLANE_DEFAULTS.confidenceFloor))),
    eventBlackoutMinutes: Math.max(0, Math.round(numberOr(profile.fastlaneEventBlackoutMinutes, FASTLANE_DEFAULTS.eventBlackoutMinutes))),
    notifyPolicy: notify === "every_action" || notify === "none" ? notify : "on_open_close",
    jevModel: typeof profile.fastlaneJevModel === "string" && profile.fastlaneJevModel.trim() ? profile.fastlaneJevModel.trim() : FASTLANE_DEFAULTS.jevModel,
    // 字段缺失 → 默认官方地址；显式空串 = 用户选择"留空用默认"，原样保留（后端也会回落）。
    jevBaseUrl: typeof profile.fastlaneJevBaseUrl === "string" ? profile.fastlaneJevBaseUrl.trim() : FASTLANE_DEFAULTS.jevBaseUrl,
    jevTimeoutMs: Math.max(200, Math.round(numberOr(profile.fastlaneJevTimeoutMs, FASTLANE_DEFAULTS.jevTimeoutMs))),
    llmTimeoutMs: Math.max(500, Math.round(numberOr(profile.fastlaneLlmTimeoutMs, FASTLANE_DEFAULTS.llmTimeoutMs))),
    // 关思考是硬要求（开思考实测 8.1s 且内容为空），这里不提供改成开启的入口。
    llmReasoningEffort: "none"
  };
}

export function profileTypeOf(profile: Pick<AiAgentProfile, "profileType">): AiProfileType {
  return profile.profileType === "fastlane" ? "fastlane" : "ai";
}

/**
 * 快判运行记录的观望原因枚举（C29.7 / §10）。
 * `session_closed`：代码门判"当前不在交易时段"（`fastlaneTradingHours`）→ 当轮观望。
 * `low_entry_score` / `entry_score_tie`（2026-09-21 变更 B）：**打分臂**的两个代码判定观望码 ——
 *   分数不足 / 两分并列 → 保守观望。UI 必须按码给出文案，否则用户会误以为"是模型说观望"。
 * `reduce_without_position` / `reduce_position_unknown`（2026-09-21 C29.14）：**降险臂**的两个
 *   代码判定观望码 —— `reduce_score` 到了门槛（该降险），但没有可减的仓位：
 *   前者是**当前无持仓**（正常状态），后者是**持仓事实缺失**（读不到 positions，数据异常）。
 *   文案必须分层：否则用户会把"数据异常"读成"我没仓位"。
 * `structure_unclear` / `stop_not_placeable` / `rr_below_floor`（**2026-09-21 C29.18**）：
 *   **入场质量门**的三个代码判定观望码（纯代码判据，与 `jev.quality` 无关）——
 *   结构位不可辨 / 纪律止损放不下（过近会被扫、过远止损退化成纯 ATR 距离）/ 几何 R:R 低于底线。
 *   三条各自独立，UI 必须能一眼分清是哪一条不过。
 * `low_quality`：**保留**（老记录 / 老侧车仍可能出现），但 C29.18 起代码侧**不再产生它**
 *   （那道门不再读 `jev.quality`；`quality` 降级为记录里的观察量）。
 */
export const FASTLANE_WATCH_REASONS = [
  "data",
  "anomaly",
  "conflict",
  "low_confidence",
  "low_quality",
  "low_entry_score",
  "entry_score_tie",
  "reduce_without_position",
  "reduce_position_unknown",
  "structure_unclear",
  "stop_not_placeable",
  "rr_below_floor",
  "no_setup",
  "validation_failed",
  "budget_exhausted",
  "session_closed"
] as const;

export type FastlaneWatchReason = (typeof FASTLANE_WATCH_REASONS)[number];

export function isFastlaneWatchReason(value: unknown): value is FastlaneWatchReason {
  return typeof value === "string" && (FASTLANE_WATCH_REASONS as readonly string[]).includes(value);
}
