import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { AlertTriangle, Loader2, OctagonX, Plus, Trash2, X } from "lucide-react";
import type { AccountSummary, AiAgentProfile, AiPermissionMode, AiWakeCondition, FastlaneNotifyPolicy, FastlaneStylePreset } from "../../types";
import { useConfirmPrompt } from "../ConfirmPrompt";
import { useDraggableSurface } from "../useDraggableSurface";
import { TerminalSelect } from "../TerminalSelect";
import {
  FASTLANE_DEFAULTS,
  FASTLANE_QUALITY_FLOOR_MAX,
  FASTLANE_QUALITY_FLOOR_MIN,
  FASTLANE_STYLE_PRESETS,
  fastlaneStylePresetText,
  normalizeFastlaneConfig,
  type FastlaneConfig
} from "./fastlaneDefaults";
import "./fastlane.css";

/**
 * C29.5 / §9.2：快判模式**独立**配置窗口（不复用 AI Profile 配置界面）。
 *
 * 钩子：`[data-fastlane-config]`；分组
 * `[data-fastlane-group="basic|trigger|style|risk|session|notify|ops|advanced"]`；
 * 停机 `[data-fastlane-kill-switch]` + `[data-fastlane-kill-close-positions]`。
 * 默认值逐字对齐 C29.4。
 */

type FastlaneConfigDialogProps = {
  draft: AiAgentProfile;
  accounts: AccountSummary[];
  wakeConditions: AiWakeCondition[];
  models: string[];
  busy: boolean;
  onChange: (patch: Partial<AiAgentProfile>) => void;
  onAddWakeCondition: () => void;
  onDeleteWakeCondition: (item: AiWakeCondition) => void;
  onKillSwitch: (closePositions: boolean) => void;
  onSave: () => void;
  onClose: () => void;
  onDelete: () => void;
};

const PROFILE_SYMBOL_LIMIT = 3;

function groupHeading(key: string, label: string) {
  return (
    <header className="fastlane-group__head">
      <strong>{label}</strong>
      <em data-fastlane-group-key={key} className="fastlane-group__key">{key}</em>
    </header>
  );
}

function NumberField({
  label,
  help,
  value,
  min,
  max,
  step,
  unit,
  disabled,
  onChange
}: {
  label: string;
  help: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  disabled?: boolean;
  onChange: (next: number) => void;
}) {
  const clamp = (raw: number) => Math.min(max, Math.max(min, raw));
  return (
    <label className="fastlane-field">
      <span>{label}</span>
      <span className="fastlane-field__control">
        <input
          type="number"
          value={Number.isFinite(value) ? value : min}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            onChange(Number.isFinite(parsed) ? clamp(parsed) : min);
          }}
        />
        {unit ? <em>{unit}</em> : null}
      </span>
      <small>{help}</small>
    </label>
  );
}

export function FastlaneConfigDialog({
  draft,
  accounts,
  wakeConditions,
  models,
  busy,
  onChange,
  onAddWakeCondition,
  onDeleteWakeCondition,
  onKillSwitch,
  onSave,
  onClose,
  onDelete
}: FastlaneConfigDialogProps) {
  const { t } = useTranslation(["automation", "common"]);
  const confirmPrompt = useConfirmPrompt();
  const dialogDrag = useDraggableSurface<HTMLElement>();
  const [symbolQuery, setSymbolQuery] = useState("");
  const config = useMemo(() => normalizeFastlaneConfig(draft), [draft]);
  const conditions = useMemo(
    () => wakeConditions.filter((item) => item.profileId === draft.id),
    [draft.id, wakeConditions]
  );
  const [styleDraft, setStyleDraft] = useState(config.style || fastlaneStylePresetText(config.stylePreset, "zh-CN"));
  // 历史数据兜底：`advisor` 不在快判的可选项里（见下方说明），显示与保存一律按副驾驶处理。
  const [legacyAdvisorMode, setLegacyAdvisorMode] = useState(draft.mode === "advisor");
  const fastlaneMode: AiPermissionMode = draft.mode === "limited_auto" ? "limited_auto" : "copilot";
  useEffect(() => {
    if (draft.mode !== "advisor") return;
    setLegacyAdvisorMode(true);
    onChange({ mode: "copilot" });
  }, [draft.mode, onChange]);

  // 预设切换时把预设文字填进风格文本框（用户随后可自由编辑）。
  useEffect(() => {
    setStyleDraft(config.style || fastlaneStylePresetText(config.stylePreset, "zh-CN"));
  }, [config.style, config.stylePreset]);

  const patchConfig = (patch: Partial<FastlaneConfig>) => {
    const next: FastlaneConfig = { ...config, ...patch };
    onChange({
      fastlaneStylePreset: next.stylePreset,
      fastlaneStyle: next.style,
      fastlaneRiskPerTradePct: next.riskPerTradePct,
      fastlaneMaxDailyLossPct: next.maxDailyLossPct,
      fastlaneMaxConcurrent: next.maxConcurrent,
      fastlaneMaxSlippageBps: next.maxSlippageBps,
      fastlaneMaxActionsPerMinute: next.maxActionsPerMinute,
      fastlaneQualityFloor: next.qualityFloor,
      fastlaneEntryScoreFloor: next.entryScoreFloor,
      fastlaneReduceScoreFloor: next.reduceScoreFloor,
      fastlaneConfidenceFloor: next.confidenceFloor,
      fastlaneEventBlackoutMinutes: next.eventBlackoutMinutes,
      fastlaneNotifyPolicy: next.notifyPolicy,
      fastlaneJevModel: next.jevModel,
      fastlaneJevBaseUrl: next.jevBaseUrl,
      fastlaneJevTimeoutMs: next.jevTimeoutMs,
      fastlaneLlmTimeoutMs: next.llmTimeoutMs,
      fastlaneLlmReasoningEffort: "none"
    });
  };

  const group = (key: "basic" | "trigger" | "style" | "risk" | "session" | "notify" | "ops" | "advanced", title: string, body: ReactNode) => (
    <section className="fastlane-group" data-fastlane-group={key}>
      {groupHeading(key, title)}
      {body}
    </section>
  );

  return createPortal(
    <div className="modal-backdrop fastlane-config-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section
        ref={dialogDrag.surfaceRef}
        className="modal-shell fastlane-config-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("fastlaneConfigTitle")}
        data-fastlane-config
      >
        <header className="modal-head fastlane-config-modal__head" {...dialogDrag.handleProps}>
          <div>
            <strong>{t("fastlaneConfigTitle")}</strong>
            <span>{t("fastlaneConfigSubtitle")}</span>
          </div>
          <button className="window-button" type="button" onClick={onClose} title={t("common:close")} aria-label={t("common:close")}><X size={16} /></button>
        </header>

        <div className="fastlane-config-modal__body">
          {group("basic", t("fastlaneGroupBasic"), (
            <div className="fastlane-grid">
              <label className="fastlane-field"><span>{t("fastlaneName")}</span>
                <span className="fastlane-field__control"><input value={draft.name} maxLength={60} onChange={(event) => onChange({ name: event.target.value })} /></span>
              </label>
              <label className="fastlane-field"><span>{t("fastlaneAccount")}</span>
                <span className="fastlane-field__control">
                  <TerminalSelect
                    ariaLabel={t("fastlaneAccount")}
                    value={draft.accountId ?? ""}
                    options={[{ value: "", label: t("profileNoBoundAccount") }, ...accounts.map((account) => ({ value: account.id, label: `${account.name} · ${account.environment === "live" ? t("common:live") : t("common:demo")}` }))]}
                    onChange={(value) => {
                      const account = accounts.find((item) => item.id === value) ?? null;
                      onChange({ accountId: value || null, environment: account?.environment ?? draft.environment });
                    }}
                  />
                </span>
              </label>
              <label className="fastlane-field"><span>{t("fastlaneEnvironment")}</span>
                <span className="fastlane-field__control">
                  <TerminalSelect
                    ariaLabel={t("fastlaneEnvironment")}
                    value={draft.environment}
                    options={[{ value: "demo", label: t("common:demo") }, { value: "live", label: t("common:live") }]}
                    onChange={(value) => onChange({ environment: value === "live" ? "live" : "demo" })}
                  />
                </span>
              </label>
              <label className="fastlane-field"><span>{t("fastlaneMode")}</span>
                {/* 便于断言：执行模式下拉有独立钩子（避免被提示文案里的"顾问"字样干扰）。 */}
                <span className="fastlane-field__control" data-fastlane-mode-select>
                  {/* C29 收窄：快判只支持副驾驶 / 自动执行（受限）。
                      顾问模式不创建交易机会（authorize_ai_tool 对 advisor 拒绝 tradeOpportunity.create），
                      选中它只会让每一轮空转，因此这里不再提供该选项。 */}
                  <TerminalSelect
                    ariaLabel={t("fastlaneMode")}
                    value={fastlaneMode}
                    options={[
                      { value: "copilot", label: t("profileModeCopilot") },
                      { value: "limited_auto", label: t("profileModeLimitedAuto") }
                    ]}
                    onChange={(value) => onChange({ mode: value === "limited_auto" ? "limited_auto" : "copilot" })}
                  />
                </span>
                <small>{t("fastlaneModeNarrowHint")}</small>
                {/* 历史数据：老快判 Profile 若存着 advisor，明确说明已按副驾驶处理。 */}
                {legacyAdvisorMode ? (
                  <small className="fastlane-field__note is-warning" data-fastlane-mode-legacy-advisor>
                    {t("fastlaneModeLegacyAdvisor")}
                  </small>
                ) : null}
              </label>
              <div className="fastlane-field fastlane-field--wide">
                <span>{t("fastlaneSymbols")}</span>
                <div className="fastlane-symbols">
                  {draft.symbols.map((symbol) => (
                    <span className="fastlane-chip" key={symbol}>{symbol}</span>
                  ))}
                  {draft.symbols.length < PROFILE_SYMBOL_LIMIT ? (
                    <span className="fastlane-symbol-add">
                      <input
                        value={symbolQuery}
                        placeholder={t("fastlaneSymbolAdd")}
                        maxLength={24}
                        onChange={(event) => setSymbolQuery(event.target.value.toUpperCase())}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" || !symbolQuery.trim()) return;
                          event.preventDefault();
                          onChange({ symbols: Array.from(new Set([...draft.symbols, symbolQuery.trim().toUpperCase()])) });
                          setSymbolQuery("");
                        }}
                      />
                    </span>
                  ) : null}
                </div>
                <small>{t("fastlaneSymbolsHint", { count: PROFILE_SYMBOL_LIMIT })}</small>
              </div>
            </div>
          ))}

          {group("trigger", t("fastlaneGroupTrigger"), (
            <div className="fastlane-trigger">
              <div className="fastlane-trigger__list">
                <strong>{t("fastlaneWakeConditions")}</strong>
                {conditions.length === 0 ? (
                  <p className="fastlane-empty" data-fastlane-conditions-empty>{t("fastlaneWakeConditionsEmpty")}</p>
                ) : (
                  <ul data-fastlane-conditions>
                    {conditions.map((item) => (
                      <li key={item.id}>
                        <span>{item.conditionType}</span>
                        <em>{item.status}</em>
                        <button type="button" title={t("common:delete")} aria-label={t("common:delete")} onClick={() => onDeleteWakeCondition(item)}><Trash2 size={12} /></button>
                      </li>
                    ))}
                  </ul>
                )}
                <button type="button" className="fastlane-add" onClick={onAddWakeCondition}><Plus size={13} />{t("fastlaneWakeConditionsAdd")}</button>
              </div>
              <div className="fastlane-grid">
                {/* 触发字段复用既有 Profile 列（C29.7）：最长静默 = scanIntervalMinutes，最小间隔 = minWakeIntervalSeconds。 */}
                <NumberField label={t("fastlaneMaxSilence")} help={t("fastlaneMaxSilenceHint")} value={draft.scanIntervalMinutes} min={1} max={1440} step={1} unit={t("fastlaneUnitMinutes")} onChange={(next) => onChange({ scanIntervalMinutes: next })} />
                <NumberField label={t("fastlaneMinInterval")} help={t("fastlaneMinIntervalHint")} value={draft.minWakeIntervalSeconds} min={1} max={3600} step={1} unit={t("fastlaneUnitSeconds")} onChange={(next) => onChange({ minWakeIntervalSeconds: next })} />
                <NumberField label={t("fastlaneMaxRunsPerHour")} help={t("fastlaneMaxRunsPerHourHint")} value={draft.maxRunsPerHour} min={1} max={720} step={1} unit={t("fastlaneUnitTimes")} onChange={(next) => onChange({ maxRunsPerHour: next })} />
              </div>
            </div>
          ))}

          {group("style", t("fastlaneGroupStyle"), (
            <div className="fastlane-style">
              <div className="fastlane-style__presets" role="radiogroup" aria-label={t("fastlaneStylePreset")}>
                {FASTLANE_STYLE_PRESETS.filter((preset) => preset !== "custom").map((preset) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={config.stylePreset === preset}
                    className={clsx("fastlane-style__preset", config.stylePreset === preset && "active")}
                    data-fastlane-style-preset={preset}
                    key={preset}
                    onClick={() => patchConfig({ stylePreset: preset, style: fastlaneStylePresetText(preset, "zh-CN") })}
                  >
                    {t(`fastlaneStyle_${preset}`)}
                  </button>
                ))}
              </div>
              <label className="fastlane-field fastlane-field--wide">
                <span>{t("fastlaneStyleText")}</span>
                <textarea
                  rows={5}
                  value={styleDraft}
                  onChange={(event) => {
                    setStyleDraft(event.target.value);
                    patchConfig({ style: event.target.value, stylePreset: event.target.value.trim() ? "custom" : config.stylePreset });
                  }}
                />
                <small>{t("fastlaneStyleTextHint")}</small>
              </label>
            </div>
          ))}

          {group("risk", t("fastlaneGroupRisk"), (
            <div className="fastlane-grid">
              <NumberField label={t("fastlaneRiskPerTrade")} help={t("fastlaneRiskPerTradeHint")} value={config.riskPerTradePct} min={0.05} max={100} step={0.05} unit="%" onChange={(next) => patchConfig({ riskPerTradePct: next })} />
              <NumberField label={t("fastlaneMaxDailyLoss")} help={t("fastlaneMaxDailyLossHint")} value={config.maxDailyLossPct} min={0.1} max={100} step={0.1} unit="%" onChange={(next) => patchConfig({ maxDailyLossPct: next })} />
              <NumberField label={t("fastlaneMaxConcurrent")} help={t("fastlaneMaxConcurrentHint")} value={config.maxConcurrent} min={1} max={10} step={1} unit={t("fastlaneUnitCount")} onChange={(next) => patchConfig({ maxConcurrent: next })} />
              <NumberField label={t("fastlaneLeverage")} help={t("fastlaneLeverageHint")} value={draft.targetLeverage} min={1} max={125} step={1} unit="x" onChange={(next) => onChange({ targetLeverage: next })} />
              <NumberField label={t("fastlaneMaxSlippage")} help={t("fastlaneMaxSlippageHint")} value={config.maxSlippageBps} min={0} max={500} step={1} unit="bps" onChange={(next) => patchConfig({ maxSlippageBps: next })} />
              <NumberField label={t("fastlaneMaxActionsPerMinute")} help={t("fastlaneMaxActionsPerMinuteHint")} value={config.maxActionsPerMinute} min={1} max={60} step={1} unit={t("fastlaneUnitPerMinute")} onChange={(next) => patchConfig({ maxActionsPerMinute: next })} />
            </div>
          ))}

          {group("session", t("fastlaneGroupSession"), (
            <div className="fastlane-grid">
              <label className="fastlane-field"><span>{t("fastlaneTradingHours")}</span>
                <span className="fastlane-field__control">
                  <TerminalSelect
                    ariaLabel={t("fastlaneTradingHours")}
                    value={draft.fastlaneTradingHours ?? "24h"}
                    options={[{ value: "24h", label: t("fastlaneTradingHours24h") }, { value: "day", label: t("fastlaneTradingHoursDay") }, { value: "night", label: t("fastlaneTradingHoursNight") }]}
                    onChange={(value) => onChange({ fastlaneTradingHours: value === "day" || value === "night" ? value : "24h" })}
                  />
                </span>
                <small>{t("fastlaneTradingHoursHint")}</small>
              </label>
              <NumberField label={t("fastlaneEventBlackout")} help={t("fastlaneEventBlackoutHint")} value={config.eventBlackoutMinutes} min={0} max={240} step={5} unit={t("fastlaneUnitMinutes")} onChange={(next) => patchConfig({ eventBlackoutMinutes: next })} />
            </div>
          ))}

          {group("notify", t("fastlaneGroupNotify"), (
            <div className="fastlane-notify" role="radiogroup" aria-label={t("fastlaneNotifyPolicy")}>
              {([
                ["every_action", t("fastlaneNotifyEveryAction")],
                ["on_open_close", t("fastlaneNotifyOnOpenClose")],
                ["none", t("fastlaneNotifyNone")]
              ] as Array<[FastlaneNotifyPolicy, string]>).map(([value, label]) => (
                <label className="fastlane-notify__option" key={value}>
                  <input
                    type="radio"
                    name="fastlane-notify"
                    data-fastlane-notify={value}
                    checked={config.notifyPolicy === value}
                    onChange={() => patchConfig({ notifyPolicy: value })}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          ))}

          {group("ops", t("fastlaneGroupOps"), (
            <div className="fastlane-ops">
              <div className="fastlane-ops__kill">
                <button
                  type="button"
                  className="fastlane-kill"
                  data-fastlane-kill-switch
                  disabled={busy}
                  onClick={() => onKillSwitch(false)}
                >
                  <OctagonX size={14} />{t("fastlaneKillSwitch")}
                </button>
                <button
                  type="button"
                  className="fastlane-kill is-danger"
                  data-fastlane-kill-close-positions
                  disabled={busy}
                  onClick={() => confirmPrompt.confirm({
                    title: t("fastlaneKillCloseTitle"),
                    message: t("fastlaneKillCloseMessage"),
                    confirmText: t("fastlaneKillCloseConfirm"),
                    danger: true,
                    onConfirm: () => onKillSwitch(true)
                  })}
                >
                  <AlertTriangle size={14} />{t("fastlaneKillClose")}
                </button>
              </div>
              <p className="fastlane-field__note">{t("fastlaneKillHint")}</p>
            </div>
          ))}

          {group("advanced", t("fastlaneGroupAdvanced"), (
            <div className="fastlane-grid">
              <label className="fastlane-field"><span>{t("fastlaneJevModel")}</span>
                <span className="fastlane-field__control"><input value={config.jevModel} maxLength={60} onChange={(event) => patchConfig({ jevModel: event.target.value })} /></span>
              </label>
              {/* C29：私有部署的自建 Jev 端点。允许为空（空 = 用官方地址），不做 URL 强校验。 */}
              <label className="fastlane-field">
                <span>{t("fastlaneJevBaseUrl")}</span>
                <span className="fastlane-field__control">
                  <input
                    data-fastlane-jev-base-url
                    value={config.jevBaseUrl}
                    placeholder={FASTLANE_DEFAULTS.jevBaseUrl}
                    maxLength={200}
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => patchConfig({ jevBaseUrl: event.target.value })}
                  />
                </span>
                <small>{t("fastlaneJevBaseUrlHint")}</small>
              </label>
              <NumberField label={t("fastlaneJevTimeout")} help={t("fastlaneJevTimeoutHint")} value={config.jevTimeoutMs} min={200} max={10_000} step={100} unit="ms" onChange={(next) => patchConfig({ jevTimeoutMs: next })} />
              <NumberField label={t("fastlaneLlmTimeout")} help={t("fastlaneLlmTimeoutHint")} value={config.llmTimeoutMs} min={500} max={30_000} step={100} unit="ms" onChange={(next) => patchConfig({ llmTimeoutMs: next })} />
              {/* C29.18：语义改成「几何 R:R 底线」→ 输入区间同步改成 0.5–3.0（与 Rust `normalized()`
                  和 `normalizeFastlaneConfig` 三处同源；步长 0.1 便于在 1.2 / 1.6 之间取值）。 */}
              <NumberField label={t("fastlaneQualityFloor")} help={t("fastlaneQualityFloorHint")} value={config.qualityFloor} min={FASTLANE_QUALITY_FLOOR_MIN} max={FASTLANE_QUALITY_FLOOR_MAX} step={0.1} onChange={(next) => patchConfig({ qualityFloor: next })} />
              {/* C29 变更 B（2026-09-21）：打分臂的方向判定线。区间 0.5–3.0 与 Rust `normalized()` 同源。 */}
              <NumberField label={t("fastlaneEntryScoreFloor")} help={t("fastlaneEntryScoreFloorHint")} value={config.entryScoreFloor} min={0.5} max={3} step={0.1} onChange={(next) => patchConfig({ entryScoreFloor: next })} />
              {/* C29.17（2026-09-21）：降险臂**自己的**门槛（与开仓门槛并列、各自独立；默认同值 1.5）。
                  降险比开仓更适合放宽：它只作用于既有持仓，不产生新仓位、不放大暴露。 */}
              <NumberField label={t("fastlaneReduceScoreFloor")} help={t("fastlaneReduceScoreFloorHint")} value={config.reduceScoreFloor} min={0.5} max={3} step={0.1} onChange={(next) => patchConfig({ reduceScoreFloor: next })} />
              <NumberField label={t("fastlaneConfidenceFloor")} help={t("fastlaneConfidenceFloorHint")} value={config.confidenceFloor} min={0} max={1} step={0.05} onChange={(next) => patchConfig({ confidenceFloor: next })} />
              <div className="fastlane-field fastlane-field--wide">
                <span>{t("fastlaneLlmReasoning")}</span>
                {/* 只读展示：关思考是硬要求（开思考实测 8.1s 且内容为空）。 */}
                <span className="fastlane-field__readonly" data-fastlane-llm-reasoning="none">{t("fastlaneLlmReasoningNone")}</span>
                <small>{t("fastlaneLlmReasoningHint")}</small>
              </div>
              <div className="fastlane-field fastlane-field--wide">
                <span>{t("fastlaneModelBinding")}</span>
                <span className="fastlane-field__readonly" data-fastlane-model-binding>{draft.model || models[0] || "--"}</span>
                <small>{t("fastlaneModelBindingHint")}</small>
              </div>
            </div>
          ))}
        </div>

        <div className="modal-actions">
          {/* P0：必须显式调用，不能 `onClick={onSave}` —— 否则 React 会把点击事件当第一个参数传进去
              （真机 bug 现场：`args.forceSystematicConflict` 变成了 DOM Event，IPC 序列化直接失败）。 */}
          <button type="button" className="danger-action" disabled={busy} onClick={() => onDelete()}>{t("profileDelete")}</button>
          <button type="button" onClick={() => onClose()}>{t("common:cancel")}</button>
          <button type="button" className="confirm" disabled={busy || !draft.name.trim()} onClick={() => onSave()}>
            {busy ? <Loader2 size={13} className="spin" /> : null}{t("common:save")}
          </button>
        </div>
      </section>
      {confirmPrompt.element}
    </div>,
    document.body
  );
}

export default FastlaneConfigDialog;
