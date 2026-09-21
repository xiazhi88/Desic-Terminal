import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { AlertTriangle, ArrowRightLeft, Brain, Clock3, Gauge, RadioTower, ShieldCheck, Zap } from "lucide-react";
import type { AiFastlaneRunRecord } from "../../types";
import { isFastlaneWatchReason, type FastlaneWatchReason } from "./fastlaneDefaults";
import { useViewText, wakeConditionsOf } from "../wakeConditionView";
import "./fastlane.css";

/**
 * C29.5 / §10：快判模式的运行记录六组。
 *
 * 钩子：`[data-run-fastlane]` +
 * `[data-run-fastlane-trigger]` / `-gate` / `-jev` / `-llm` / `-action` / `-timing`。
 * 观望原因按枚举渲染文案（`data` / `anomaly` / `conflict` / `low_confidence` / `no_setup` /
 * `validation_failed` / `budget_exhausted` / 打分臂与降险臂的代码码 /
 * **C29.18** 入场质量门三码 `structure_unclear` / `stop_not_placeable` / `rr_below_floor`）。
 * `low_quality` 保留（老记录）但代码侧不再产生它；`jev.quality` 只是**观察量**（缺失显示 `--`）。
 */

function readRecord(value: unknown): AiFastlaneRunRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as AiFastlaneRunRecord;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function formatMs(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return "--";
  if (parsed < 1000) return `${Math.round(parsed)}ms`;
  return `${(parsed / 1000).toFixed(2)}s`;
}

function formatPercent(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${(parsed * 100).toFixed(1)}%` : "--";
}

function formatJson(value: unknown) {
  if (value === undefined || value === null || value === "") return "--";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 一行事实（参数网格用）：嵌套对象压成单行 JSON，避免把卡片撑成日志。 */
function inlineValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "--";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function FastlaneRunRecord({ value }: { value: unknown }) {
  const { t } = useTranslation(["automation", "common"]);
  const text = useViewText();
  const record = useMemo(() => readRecord(value), [value]);

  const probabilities = useMemo(() => {
    const raw = record?.jev?.probabilities;
    if (!raw || typeof raw !== "object") return [] as Array<[string, number]>;
    return Object.entries(raw).map(([key, item]) => [key, Number(item)] as [string, number]);
  }, [record]);

  if (!record) {
    return (
      <section className="fastlane-run" data-run-fastlane>
        <p className="fastlane-empty">{t("fastlaneRunMissing")}</p>
      </section>
    );
  }

  const trigger = record.trigger ?? {};
  const gate = record.gate ?? {};
  const jev = record.jev ?? {};
  const llm = record.llm ?? {};
  const action = record.action ?? {};
  const timing = record.timing ?? {};
  const tokens = record.tokens ?? {};
  const validation = llm.validation ?? {};
  const watchReason = action.kind === "watch" && isFastlaneWatchReason(action.reason) ? action.reason as FastlaneWatchReason : null;
  /**
   * **打分臂（C29 变更 B，2026-09-21）**：Jev 给的是 `long_score` / `short_score`（0–4 期望分），
   * 方向/观望由**代码**按 `entry_score_floor` 判（`max ≥ 门槛` 且不并列 → argmax）。
   * 这里把两个分数、门槛与判定依据摊开 —— 观望时用户必须一眼看出"是分数不够"，
   * 而不是"模型说观望"（判定码走 `fastlaneWatchReason_low_entry_score` / `_entry_score_tie` 文案）。
   */
  /**
   * **入场质量门（C29.18，2026-09-21）**：结构可辨 / 止损可放 / 几何 R:R 达线 —— 三条**代码**判据
   * （侧车算，Rust 只读透传）。`applicable === false` = 本门**不适用**（没有开仓方向 / 没给快照），
   * 与"门过了"是两件事，必须分开显示；不过时按码渲染文案，一眼看清是哪一条。
   */
  const entryQuality = gate.entryQuality ?? null;
  const entryQualityApplicable = entryQuality?.applicable === true;
  const entryQualityCheck = (value: unknown) => (value === true ? "ok" : value === false ? "fail" : "na");
  const entryQualityReasons = Array.isArray(entryQuality?.reasons)
    ? entryQuality.reasons.filter((item): item is FastlaneWatchReason => isFastlaneWatchReason(item))
    : [];
  const entryQualityVerdictLabel = (value: unknown) => (value === true
    ? t("fastlaneRunEntryQualityOk")
    : value === false
      ? t("fastlaneRunEntryQualityFail")
      : t("fastlaneRunEntryQualityNa"));
  const entryQualityChipClass = (value: unknown) => clsx("fastlane-chip", value === true ? "is-ok" : value === false ? "is-warn" : "is-muted");
  const entryQualityNumber = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "--");
  const scoreDecision = typeof jev.entryScoreDecision === "string" ? jev.entryScoreDecision : null;
  const scoreArm = Number.isFinite(Number(jev.longScore)) && Number.isFinite(Number(jev.shortScore));
  const scoreText = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "--");
  /**
   * **降险臂（C29.14，2026-09-21）**：`reduce_score` 到了门槛就该降险；没有可减的仓位时
   * **代码**判观望，两种成因各有自己的码（无持仓 / 持仓事实缺失）—— 后者是数据异常，
   * 必须与"我本来就没仓位"分开显示，否则用户会误读。
   */
  const reduceScoreValue = jev.reduceScore;
  const reduceArm = Number.isFinite(Number(reduceScoreValue));
  const reduceDecision = typeof jev.reduceScoreDecision === "string" ? jev.reduceScoreDecision : null;
  const reducePositionFact = typeof jev.reducePositionFact === "string" ? jev.reducePositionFact : null;
  const scoreDecisionLabel = scoreDecision === "direction"
    ? t("fastlaneRunEntryScoreDirection")
    : scoreDecision === "below_floor"
      ? t("fastlaneRunEntryScoreBelowFloor")
      : scoreDecision === "tie"
        ? t("fastlaneRunEntryScoreTie")
        : scoreDecision === "score_missing"
          ? t("fastlaneRunEntryScoreMissing")
          : scoreDecision === "legacy_action"
            ? t("fastlaneRunEntryScoreLegacy")
            : scoreDecision === "reduce"
              ? t("fastlaneRunEntryScoreReduce")
              : scoreDecision === "reduce_without_position"
                ? t("fastlaneRunEntryScoreReduceNoPosition")
                : scoreDecision === "reduce_position_unknown"
                  ? t("fastlaneRunEntryScoreReducePositionUnknown")
                  : null;
  const reducePositionFactLabel = reducePositionFact === "held"
    ? t("fastlaneRunReducePositionHeld")
    : reducePositionFact === "flat"
      ? t("fastlaneRunReducePositionFlat")
      : reducePositionFact === "unknown"
        ? t("fastlaneRunReducePositionUnknown")
        : null;

  // 参数调用的产物（真机形状：`{summary, reason, nextWakePlan, …}`，动作分支还带交易参数）。
  const llmParams = asRecord(llm.params);
  const llmSummary = typeof llmParams.summary === "string" ? llmParams.summary : "";
  const llmReason = typeof llmParams.reason === "string" ? llmParams.reason : "";
  const planConditions = wakeConditionsOf(llmParams.nextWakePlan);
  const tradeParams = useMemo(
    () => Object.entries(llmParams).filter(([key]) => !["summary", "reason", "nextWakePlan"].includes(key)),
    [llmParams]
  );
  // 写库条数（Rust 侧真值）与计划条数的差 —— "计划 3 条、写库 2 条"必须看得见。
  const writtenWakes = typeof llm.wakeConditions === "number" ? llm.wakeConditions : null;
  const partialWakes = writtenWakes !== null && writtenWakes !== planConditions.length;
  // 空清单的两种成因必须说清：① 参数调用根本没跑（代码门拦下 / 无 llm 段）；
  // ② 跑了但没写下（或写了被拒）—— 后者在 `validation.reasons` 里有原因。
  const wakesIdle = planConditions.length === 0
    && (writtenWakes ?? 0) === 0
    && (validation.reasons ?? []).length === 0;

  const triggerSource = trigger.source === "condition"
    ? t("fastlaneTriggerCondition")
    : trigger.source === "silence"
      ? t("fastlaneTriggerSilence")
      : trigger.source === "manual"
        ? t("fastlaneTriggerManual")
        : String(trigger.source ?? "--");

  const actionLabel = action.kind === "opportunity"
    ? t("fastlaneActionOpportunity")
    : action.kind === "trade"
      ? t("fastlaneActionTrade")
      : action.kind === "kill_switch"
        ? t("fastlaneActionKillSwitch")
        : t("fastlaneActionWatch");

  return (
    <section className="fastlane-run" data-run-fastlane>
      <header className="fastlane-run__head">
        <strong><Zap size={13} />{t("fastlaneRunTitle")}</strong>
        <em className="fastlane-chip">{t("fastlaneRunTotal", { total: formatMs(timing.totalMs) })}</em>
      </header>

      <div className="fastlane-run__grid">
        <div className="fastlane-run__card" data-run-fastlane-trigger>
          <span className="fastlane-run__label"><Gauge size={12} />{t("fastlaneRunTrigger")}</span>
          <strong data-run-fastlane-trigger-source={trigger.source ?? "unknown"}>{triggerSource}</strong>
          {trigger.conditionType ? (
            <small data-run-fastlane-trigger-condition>{trigger.conditionType}</small>
          ) : null}
          {trigger.params ? <pre data-run-fastlane-trigger-params>{formatJson(trigger.params)}</pre> : null}
        </div>

        <div className={clsx("fastlane-run__card", gate.ok === false && "is-blocked")} data-run-fastlane-gate data-fastlane-gate-ok={gate.ok === false ? "false" : "true"}>
          <span className="fastlane-run__label"><ShieldCheck size={12} />{t("fastlaneRunGate")}</span>
          <strong>{gate.ok === false ? t("fastlaneRunGateBlocked") : t("fastlaneRunGatePassed")}</strong>
          {/* 变更 A（2026-09-21）：质量/置信度门只作用于**开新仓**；降险（Jev 判减仓/平仓）不受它约束。
              门没过却放行时**必须看得见**：`ok` 保持 false，另用 chip 说明"被降险豁免"与作用域，
              而不是把 `ok` 改成 true（那是伪造"门过了"）。 */}
          {gate.bypassedFor === "risk_reduction" ? (
            <em className="fastlane-chip is-warn" data-fastlane-gate-bypassed="risk_reduction">{t("fastlaneRunGateBypassed")}</em>
          ) : null}
          {gate.appliedTo === "open" ? (
            <small data-fastlane-gate-applied-to={String(gate.appliedTo)}>{t("fastlaneRunGateAppliedTo")}</small>
          ) : null}
          <ul>
            {gate.data !== undefined ? <li>{t("fastlaneRunGateData")}: {formatJson(gate.data)}</li> : null}
            {gate.anomaly !== undefined ? <li>{t("fastlaneRunGateAnomaly")}: {formatJson(gate.anomaly)}</li> : null}
            {gate.conflict !== undefined ? <li>{t("fastlaneRunGateConflict")}: {formatJson(gate.conflict)}</li> : null}
            {/* 原因码按枚举渲染文案（C29.18 起包含入场质量门三码）；不在枚举里的原样显示
                （例如 `risk_reduction_gate_bypass` 这种标注位）。 */}
            {(gate.reasons ?? []).map((reason) => (
              <li key={reason} data-fastlane-gate-reason={reason}>
                {isFastlaneWatchReason(reason) ? t(`fastlaneWatchReason_${reason}`) : reason}
              </li>
            ))}
          </ul>
          {/* **入场质量门（C29.18）**：三条代码判据的结论 + 取数（结构位距离 / 止损距离 / 几何 R:R 与门槛）。
              Rust 只读透传，UI 不重算。`不适用`（没有开仓方向 / 没给快照）与"门过了"分开显示。 */}
          {entryQuality ? (
            <div
              className="fastlane-run__chips"
              data-run-fastlane-entry-quality
              data-fastlane-entry-quality-applicable={entryQualityApplicable ? "true" : "false"}
              data-fastlane-entry-quality-structure={entryQualityCheck(entryQuality.structure_ok)}
              data-fastlane-entry-quality-stop={entryQualityCheck(entryQuality.stop_placeable)}
              data-fastlane-entry-quality-rr={entryQualityCheck(entryQuality.rr_ok)}
            >
              {entryQualityApplicable ? (
                <>
                  <em className={entryQualityChipClass(entryQuality.structure_ok)} data-fastlane-entry-quality-structure-chip>
                    {t("fastlaneRunEntryQualityStructure")} {entryQualityVerdictLabel(entryQuality.structure_ok)}
                  </em>
                  <em className={entryQualityChipClass(entryQuality.stop_placeable)} data-fastlane-entry-quality-stop-chip>
                    {t("fastlaneRunEntryQualityStop")} {entryQualityVerdictLabel(entryQuality.stop_placeable)}
                  </em>
                  <em className={entryQualityChipClass(entryQuality.rr_ok)} data-fastlane-entry-quality-rr-chip>
                    {t("fastlaneRunEntryQualityRr")} {entryQualityVerdictLabel(entryQuality.rr_ok)}
                  </em>
                  <em className="fastlane-chip is-muted" data-fastlane-entry-quality-floor>
                    {t("fastlaneRunEntryQualityFloor")} {entryQualityNumber(entryQuality.rr_floor)}
                  </em>
                  <em className="fastlane-chip is-muted" data-fastlane-entry-quality-readings>
                    {t("fastlaneRunEntryQualityReadings", {
                      structure: entryQualityNumber(entryQuality.nearest_structure_atr),
                      stop: entryQualityNumber(entryQuality.stop_distance_atr),
                      rr: entryQualityNumber(entryQuality.rr)
                    })}
                  </em>
                </>
              ) : (
                <em className="fastlane-chip is-muted" data-fastlane-entry-quality-skip>
                  {t("fastlaneRunEntryQualityNotApplicable")}
                </em>
              )}
            </div>
          ) : null}
        </div>

        <div className="fastlane-run__card" data-run-fastlane-jev data-fastlane-jev-action={jev.action ?? "unknown"}>
          <span className="fastlane-run__label"><Brain size={12} />{t("fastlaneRunJev")}</span>
          <strong>{jev.action ?? "--"}</strong>
          {/* 记录里区分两种降险：`close` = 停机平仓轮（用户命令），`reduce` = Jev 自判减仓
              （两者的动作体 intent 都是 `close`，只有这个字段能把它们分开）。 */}
          {record.intent ? (
            <small data-run-fastlane-intent={record.intent}>{t("fastlaneRunIntent")}: {record.intent}</small>
          ) : null}
          <dl>
            <div>
              <dt>{t("fastlaneRunJevConfidence")}</dt>
              {/* 打分臂没有 action 节点 → 记录里的 `confidence` 是缺省占位 0（不是"模型给了 0 置信度"）：
                  这里显式显示 `--`，与下方的"置信度门不适用"说明一致（不许把占位值渲染成真实读数）。 */}
              <dd>{jev.confidenceSource === "none" ? "--" : formatPercent(jev.confidence)}</dd>
            </div>
            {/* **观察量（C29.18）**：`quality` 这一问已从 Jev 问题面删除；老记录 / 老响应带它时照原样
                显示，缺失（`null` / 缺键）显示 `--` —— 绝不显示成 "0"（那是把"没这一问"读成"0 分"）。 */}
            <div>
              <dt>{t("fastlaneRunJevQuality")}</dt>
              <dd data-run-fastlane-jev-quality={jev.quality === null || jev.quality === undefined ? "missing" : "observed"}>
                {jev.quality === null || jev.quality === undefined ? "--" : String(jev.quality)}
              </dd>
            </div>
            <div><dt>{t("fastlaneRunJevLatency")}</dt><dd>{formatMs(jev.latencyMs)}</dd></div>
          </dl>
          {/* 打分臂（C29 变更 B）：分数 / 门槛 / 判定依据 + 置信度门的参与状态，全部可见。 */}
          {scoreArm ? (
            <div className="fastlane-run__chips" data-run-fastlane-entry-score
              data-fastlane-entry-score-decision={scoreDecision ?? "unknown"}
              data-fastlane-entry-score-arm="true">
              <em className="fastlane-chip is-muted" data-fastlane-long-score>{t("fastlaneRunLongScore")} {scoreText(jev.longScore)}</em>
              <em className="fastlane-chip is-muted" data-fastlane-short-score>{t("fastlaneRunShortScore")} {scoreText(jev.shortScore)}</em>
              <em className="fastlane-chip is-muted" data-fastlane-entry-score-floor>{t("fastlaneRunEntryScoreFloor")} {scoreText(jev.entryScoreFloor)}</em>
              {scoreDecisionLabel ? (
                <em
                  className={clsx("fastlane-chip", (scoreDecision === "below_floor" || scoreDecision === "tie") ? "is-warn" : (scoreDecision === "direction" ? "is-ok" : "is-muted"))}
                  data-fastlane-entry-score-verdict={scoreDecision ?? "unknown"}
                >
                  {scoreDecisionLabel}
                </em>
              ) : null}
            </div>
          ) : null}
          {/* 降险臂（C29.14）：降险分 + **降险自己的门槛** + 降险口径 + 看到的持仓事实。
              C29.17 起降险门槛是独立字段（默认与入场门槛同值 1.5）；`?? entryScoreFloor` 只为
              兼容**解耦前**的老记录（那时两者同值，回落结果与当时一致）。
              判定为降险时这张 chip 是 is-warn（本轮会动仓位）；被仓位挡住时同样是 is-warn
              （"该降险却没得减"必须看得见，而不是静默变成普通观望）。 */}
          {reduceArm ? (
            <div className="fastlane-run__chips" data-run-fastlane-reduce-score
              data-fastlane-reduce-score-decision={reduceDecision ?? "unknown"}
              data-fastlane-reduce-position-fact={reducePositionFact ?? "unknown"}>
              <em className="fastlane-chip is-muted" data-fastlane-reduce-score-value>{t("fastlaneRunReduceScore")} {scoreText(reduceScoreValue)}</em>
              <em className="fastlane-chip is-muted" data-fastlane-reduce-score-floor>{t("fastlaneRunReduceScoreFloor")} {scoreText(jev.reduceScoreFloor ?? jev.entryScoreFloor)}</em>
              {reduceDecision ? (
                <em
                  className={clsx("fastlane-chip", reduceDecision === "below_floor" ? "is-muted" : "is-warn")}
                  data-fastlane-reduce-score-verdict={reduceDecision}
                >
                  {reduceDecision === "reduce"
                    ? t("fastlaneRunEntryScoreReduce")
                    : reduceDecision === "reduce_without_position"
                      ? t("fastlaneRunEntryScoreReduceNoPosition")
                      : reduceDecision === "reduce_position_unknown"
                        ? t("fastlaneRunEntryScoreReducePositionUnknown")
                        : reduceDecision === "below_floor"
                          ? t("fastlaneRunEntryScoreBelowFloor")
                          : reduceDecision}
                </em>
              ) : null}
              {reducePositionFactLabel ? (
                <em className="fastlane-chip is-muted" data-fastlane-reduce-position-fact-chip>{reducePositionFactLabel}</em>
              ) : null}
            </div>
          ) : null}
          {/* 置信度门的**值来源**：打分臂没有 action 节点 → 这道门本轮不参与。
              不许静默：这里显式说明，避免读成"门过了"。 */}
          {jev.confidenceSource === "none" ? (
            <small data-fastlane-confidence-source="none">{t("fastlaneRunConfidenceNotApplicable")}</small>
          ) : null}
          {probabilities.length > 0 ? (
            <ul className="fastlane-run__probabilities" data-run-fastlane-jev-probabilities>
              {probabilities.map(([key, item]) => (
                <li key={key}><span>{key}</span><em>{Number.isFinite(item) ? formatPercent(item) : String(item)}</em></li>
              ))}
            </ul>
          ) : null}
        </div>

        {/* C29：二态（Rust `validate_round` 不会自动改参数，因此不存在"已修正"这一态）。
            C29.8（可视化）：不再把 `params` 整段 JSON 摊在卡片里 —— 结论引文 + 状态 chips +
            参数网格 + 折叠的原始输出；`reasons` 仍是诊断字段（拒绝原因 / 部分接受的丢弃说明）。 */}
        <div className="fastlane-run__card" data-run-fastlane-llm data-fastlane-llm-validation={validation.ok === false ? "rejected" : "ok"}>
          <span className="fastlane-run__label"><ArrowRightLeft size={12} />{t("fastlaneRunLlm")}</span>
          <strong>{formatMs(llm.latencyMs)}</strong>
          <div className="fastlane-run__chips" data-run-fastlane-llm-chips>
            <em className={clsx("fastlane-chip", validation.ok === false ? "is-bad" : "is-ok")} data-fastlane-llm-validation-chip={validation.ok === false ? "rejected" : "ok"}>
              {validation.ok === false ? t("fastlaneRunLlmRejected") : t("fastlaneRunLlmPassed")}
            </em>
            {llmReason ? <em className="fastlane-chip is-muted" data-run-fastlane-llm-reason-chip>{llmReason}</em> : null}
            {llm.model ? <em className="fastlane-chip is-muted" data-run-fastlane-llm-model>{llm.model}</em> : null}
            {llm.attempts !== undefined && llm.attempts > 1 ? (
              <em className="fastlane-chip is-warn" data-run-fastlane-llm-attempts>{t("fastlaneRunLlmAttempts")} {String(llm.attempts)}</em>
            ) : null}
          </div>
          {llmSummary ? (
            <blockquote className="fastlane-run__quote" data-run-fastlane-llm-summary>{llmSummary}</blockquote>
          ) : null}
          <dl>
            <div>
              <dt>{t("fastlaneRunLlmWakeConditions")}</dt>
              <dd data-run-fastlane-llm-wake-conditions>
                {writtenWakes !== null ? t("fastlaneRunWakeWritten", { written: writtenWakes, planned: planConditions.length }) : "--"}
              </dd>
            </div>
          </dl>
          {/* `reasons` 是**诊断字段**（C29 裁决）：拒绝时说明哪条硬约束没过；**部分接受**时说明
              哪几条附加的观察条件被丢弃（`validation.ok` 保持 true —— 动作本身已过代码门，
              丢弃的是附加条件，不该让"运行 completed"显示成"LLM 拒绝"）。
              它不是"第三态"的判据 —— 状态只由 `validation.ok` 决定（ok | rejected）。 */}
          {validation.reasons && validation.reasons.length > 0 ? (
            <ul data-run-fastlane-llm-reasons>{validation.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          ) : null}
          {tradeParams.length > 0 ? (
            <dl className="fastlane-run__facts" data-run-fastlane-llm-facts>
              {tradeParams.map(([key, item]) => (
                <div key={key}><dt>{key}</dt><dd>{inlineValue(item)}</dd></div>
              ))}
            </dl>
          ) : null}
          {llm.params ? (
            <details className="fastlane-run__fold" data-run-fastlane-llm-raw>
              <summary>{t("fastlaneRunLlmRaw")}</summary>
              <pre>{formatJson(llm.params)}</pre>
            </details>
          ) : null}
        </div>

        <div className={clsx("fastlane-run__card", `is-action-${action.kind ?? "watch"}`)} data-run-fastlane-action data-fastlane-action-kind={action.kind ?? "watch"}>
          <span className="fastlane-run__label"><AlertTriangle size={12} />{t("fastlaneRunAction")}</span>
          <strong>{actionLabel}</strong>
          {action.opportunityId ? <small data-run-fastlane-opportunity>{action.opportunityId}</small> : null}
          {action.orderId ? <small data-run-fastlane-order>{action.orderId}</small> : null}
          {watchReason ? <p data-run-fastlane-watch-reason={watchReason}>{t(`fastlaneWatchReason_${watchReason}`)}</p> : action.reason ? <p data-run-fastlane-watch-reason-raw>{action.reason}</p> : null}
          {/* C29.8：**条件清单只出现在「关键动作」区**（旧模式的位置），这里只报口径，
              否则同一份清单在一个弹窗里出现两次，用户要在两处之间对照。 */}
          <div className="fastlane-run__wake" data-run-fastlane-action-wakes data-fastlane-action-wake-count={planConditions.length}>
            <span className="fastlane-run__label">
              <RadioTower size={12} />{t("fastlaneRunActionWakes")}
              {planConditions.length > 0 ? <em className="fastlane-run__wake-count">{planConditions.length}</em> : null}
            </span>
            <p className="fastlane-run__wake-hint" data-run-fastlane-wake-summary>
              {planConditions.length === 0
                ? (wakesIdle ? t("fastlaneRunWakeIdle") : t("fastlaneRunWakeNone"))
                : t("fastlaneRunWakeWritten", { written: writtenWakes ?? 0, planned: planConditions.length })}
            </p>
            {partialWakes ? (
              <p className="fastlane-run__wake-warn" data-run-fastlane-wake-partial>
                {t("fastlaneRunWakePartial", { planned: planConditions.length, written: writtenWakes })}
              </p>
            ) : null}
          </div>
        </div>

        <div className="fastlane-run__card" data-run-fastlane-timing>
          <span className="fastlane-run__label"><Clock3 size={12} />{t("fastlaneRunTiming")}</span>
          <dl>
            <div><dt>{t("fastlaneRunFetch")}</dt><dd data-fastlane-timing-fetch>{formatMs(timing.fetchMs)}</dd></div>
            <div><dt>{t("fastlaneRunJevStep")}</dt><dd data-fastlane-timing-jev>{formatMs(timing.jevMs)}</dd></div>
            <div><dt>{t("fastlaneRunLlmStep")}</dt><dd data-fastlane-timing-llm>{formatMs(timing.llmMs)}</dd></div>
            <div><dt>{t("fastlaneRunCodeStep")}</dt><dd data-fastlane-timing-code>{formatMs(timing.codeMs)}</dd></div>
            <div><dt>{t("fastlaneRunTotal")}</dt><dd data-fastlane-timing-total>{formatMs(timing.totalMs)}</dd></div>
          </dl>
          <small className="fastlane-run__tokens" data-run-fastlane-tokens>
            {t("fastlaneRunTokens", { jevIn: tokens.jevIn ?? 0, jevOut: tokens.jevOut ?? 0, llmIn: tokens.llmIn ?? 0, llmOut: tokens.llmOut ?? 0 })}
          </small>
        </div>
      </div>
    </section>
  );
}

export default FastlaneRunRecord;
