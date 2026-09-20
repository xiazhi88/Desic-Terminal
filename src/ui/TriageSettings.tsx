import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import type { AiTriageConfig, AiTriageEscalate, AiTriageMode } from "../types";
import { TerminalSelect } from "./TerminalSelect";

/**
 * C19 试判（triage）设置区块。
 *
 * 冻结钩子：容器 `[data-triage-settings]`、模式选择 `[data-triage-mode-select]`、
 * 六个数值输入与三个硬升级开关（见下方 data-* 属性）。
 * 数值输入带范围校验：越界时提示并在失焦时夹到合法区间（前端只做提示，权威校验在 Rust）。
 */

export const DEFAULT_AI_TRIAGE: AiTriageConfig = {
  mode: "enforce",
  maxSkips: 3,
  maxSilenceMinutes: 120,
  skipSampleRate: 0.2,
  escalate: {
    positionOrOrderChanged: true,
    stopDistancePct: 1.5,
    // OKX 口径：维持保证金率越大越安全，≤100% 即强平；150 = 离强平不足约 1.5× 缓冲。
    marginRatioPct: 150,
    confirmedBreakOfFlaggedLevel: true,
    conditionResonance: 2,
    importantNews: true
  }
};

export function createDefaultTriage(): AiTriageConfig {
  return { ...DEFAULT_AI_TRIAGE, escalate: { ...DEFAULT_AI_TRIAGE.escalate } };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberOr(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolOr(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

/** 读旧写新：缺字段一律回落到契约 C19.1 的默认值，老 Profile 不会因为没配过试判而崩。 */
export function normalizeTriage(value: unknown): AiTriageConfig {
  const record = asRecord(value);
  const escalate = asRecord(record.escalate);
  const mode = String(record.mode ?? "").trim().toLowerCase();
  return {
    mode: mode === "off" || mode === "shadow" || mode === "enforce" ? mode as AiTriageMode : DEFAULT_AI_TRIAGE.mode,
    maxSkips: Math.max(1, Math.round(numberOr(record.maxSkips, DEFAULT_AI_TRIAGE.maxSkips))),
    maxSilenceMinutes: Math.max(1, Math.round(numberOr(record.maxSilenceMinutes, DEFAULT_AI_TRIAGE.maxSilenceMinutes))),
    skipSampleRate: Math.min(1, Math.max(0, numberOr(record.skipSampleRate, DEFAULT_AI_TRIAGE.skipSampleRate))),
    escalate: {
      positionOrOrderChanged: boolOr(escalate.positionOrOrderChanged, DEFAULT_AI_TRIAGE.escalate.positionOrOrderChanged),
      stopDistancePct: Math.min(100, Math.max(0, numberOr(escalate.stopDistancePct, DEFAULT_AI_TRIAGE.escalate.stopDistancePct))),
      marginRatioPct: Math.min(100_000, Math.max(100, numberOr(escalate.marginRatioPct, DEFAULT_AI_TRIAGE.escalate.marginRatioPct))),
      confirmedBreakOfFlaggedLevel: boolOr(escalate.confirmedBreakOfFlaggedLevel, DEFAULT_AI_TRIAGE.escalate.confirmedBreakOfFlaggedLevel),
      conditionResonance: Math.max(1, Math.round(numberOr(escalate.conditionResonance, DEFAULT_AI_TRIAGE.escalate.conditionResonance))),
      importantNews: boolOr(escalate.importantNews, DEFAULT_AI_TRIAGE.escalate.importantNews)
    }
  };
}

type NumberFieldProps = {
  hook: string;
  label: string;
  help: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  disabled: boolean;
  onCommit: (value: number) => void;
};

/** 数值输入：编辑期间保留原始字符串，越界只提示，失焦时夹到合法区间。 */
function TriageNumberField({ hook, label, help, value, min, max, step, unit, disabled, onCommit }: NumberFieldProps) {
  const { t } = useTranslation(["automation", "common"]);
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value);
  const parsed = Number(shown);
  const invalid = shown.trim() === "" || !Number.isFinite(parsed) || parsed < min || parsed > max;

  return (
    <label className={clsx("automation-triage-field", invalid && "is-invalid")}>
      <span>{label}</span>
      <div>
        <input
          type="number"
          {...{ [hook]: "" }}
          value={shown}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            const raw = Number(shown);
            if (!Number.isFinite(raw)) {
              setDraft(null);
              onCommit(value);
              return;
            }
            const clamped = Math.min(max, Math.max(min, raw));
            setDraft(null);
            onCommit(clamped);
          }}
        />
        {unit ? <em>{unit}</em> : null}
      </div>
      <small className={clsx(invalid && "is-warning")}>
        {invalid
          ? t("triageRangeHint", { min, max })
          : help}
      </small>
    </label>
  );
}

type TriageSettingsProps = {
  value: AiTriageConfig;
  disabled?: boolean;
  onChange: (next: AiTriageConfig) => void;
};

export function TriageSettings({ value, disabled = false, onChange }: TriageSettingsProps) {
  const { t } = useTranslation(["automation", "common"]);
  const config = useMemo(() => normalizeTriage(value), [value]);
  const patchEscalate = (patch: Partial<AiTriageEscalate>) => {
    onChange({ ...config, escalate: { ...config.escalate, ...patch } });
  };

  const modeOptions = [
    { value: "off", label: t("triageModeOff"), description: t("triageModeOffHint") },
    { value: "shadow", label: t("triageModeShadow"), description: t("triageModeShadowHint") },
    { value: "enforce", label: t("triageModeEnforce"), description: t("triageModeEnforceHint") }
  ];

  return (
    <div className="automation-form-section automation-triage-section" data-triage-settings>
      <strong><ShieldAlert size={13} />{t("triageTitle")}</strong>
      <div className="automation-section-headline">
        <p className="automation-field-note">{t("triageIntro")}</p>
      </div>

      <label className="automation-triage-field">
        <span>{t("triageMode")}</span>
        <div data-triage-mode-select>
          <TerminalSelect
            ariaLabel={t("triageMode")}
            value={config.mode}
            disabled={disabled}
            options={modeOptions}
            onChange={(next) => onChange({ ...config, mode: next as AiTriageMode })}
          />
        </div>
        <small>{modeOptions.find((option) => option.value === config.mode)?.description ?? ""}</small>
      </label>

      {/* C25③：原"强制模式会跳过深度分析"提示已按董事会要求移除（不再劝告，只保留功能说明）。 */}

      <div className="automation-triage-grid">
        <TriageNumberField
          hook="data-triage-max-skips"
          label={t("triageMaxSkips")}
          help={t("triageMaxSkipsHint")}
          value={config.maxSkips}
          min={1}
          max={50}
          step={1}
          unit={t("triageUnitCount")}
          disabled={disabled}
          onCommit={(next) => onChange({ ...config, maxSkips: next })}
        />
        <TriageNumberField
          hook="data-triage-silence-minutes"
          label={t("triageSilence")}
          help={t("triageSilenceHint")}
          value={config.maxSilenceMinutes}
          min={1}
          max={1440}
          step={1}
          unit={t("triageUnitMinutes")}
          disabled={disabled}
          onCommit={(next) => onChange({ ...config, maxSilenceMinutes: next })}
        />
        <TriageNumberField
          hook="data-triage-sample-rate"
          label={t("triageSampleRate")}
          help={t("triageSampleRateHint")}
          value={config.skipSampleRate}
          min={0}
          max={1}
          step={0.05}
          disabled={disabled}
          onCommit={(next) => onChange({ ...config, skipSampleRate: next })}
        />
        <TriageNumberField
          hook="data-triage-stop-distance"
          label={t("triageStopDistance")}
          help={t("triageStopDistanceHint")}
          value={config.escalate.stopDistancePct}
          min={0}
          max={100}
          step={0.1}
          unit="%"
          disabled={disabled}
          onCommit={(next) => patchEscalate({ stopDistancePct: next })}
        />
        <TriageNumberField
          hook="data-triage-margin-ratio"
          label={t("triageMarginRatio")}
          help={t("triageMarginRatioHint")}
          value={config.escalate.marginRatioPct}
          min={100}
          max={100_000}
          step={10}
          unit="%"
          disabled={disabled}
          onCommit={(next) => patchEscalate({ marginRatioPct: next })}
        />
        {/* C25④：保证金率口径配置已移除 —— 后端固定按 OKX「越大越安全」处理，保存 payload 不再带该字段。 */}
        <TriageNumberField
          hook="data-triage-resonance"
          label={t("triageResonance")}
          help={t("triageResonanceHint")}
          value={config.escalate.conditionResonance}
          min={1}
          max={10}
          step={1}
          unit={t("triageUnitCount")}
          disabled={disabled}
          onCommit={(next) => patchEscalate({ conditionResonance: next })}
        />
      </div>

      <div className="automation-triage-escalate">
        <span className="automation-triage-escalate__title">{t("triageEscalateTitle")}</span>
        <label className="automation-check">
          <input
            type="checkbox"
            data-triage-escalate-position
            checked={config.escalate.positionOrOrderChanged}
            disabled={disabled}
            onChange={(event) => patchEscalate({ positionOrOrderChanged: event.target.checked })}
          />
          <span>{t("triageEscalatePosition")}</span>
        </label>
        <label className="automation-check">
          <input
            type="checkbox"
            data-triage-escalate-break
            checked={config.escalate.confirmedBreakOfFlaggedLevel}
            disabled={disabled}
            onChange={(event) => patchEscalate({ confirmedBreakOfFlaggedLevel: event.target.checked })}
          />
          <span>{t("triageEscalateBreak")}</span>
        </label>
        <label className="automation-check">
          <input
            type="checkbox"
            data-triage-escalate-news
            checked={config.escalate.importantNews}
            disabled={disabled}
            onChange={(event) => patchEscalate({ importantNews: event.target.checked })}
          />
          <span>{t("triageEscalateNews")}</span>
        </label>
      </div>
    </div>
  );
}

export default TriageSettings;
