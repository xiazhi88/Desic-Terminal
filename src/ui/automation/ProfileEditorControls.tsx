import { useState, type CSSProperties } from "react";
import clsx from "clsx";
import { Minus, Plus } from "lucide-react";
import { scalePosition, scaleValueAt, stepValue, type NiceScale } from "../../lib/profileEditorScales";

/** Profile 配置页用的小控件：开关、分段选择、数字框、拖动条、快选、步进器、问号提示。样式见 profile-editor.css。 */

type DataAttributes = { [key: `data-${string}`]: string | undefined };

function formatNumber(value: number) {
  return Number.isFinite(value) ? String(Number(value.toFixed(4))) : "";
}

/** 拇指宽 14px：刻度与填充都对齐拇指中心。 */
function thumbOffset(fraction: number) {
  return `calc(7px + ${fraction} * (100% - 14px))`;
}

export function EditorToggle({
  checked,
  disabled,
  ariaLabel,
  onChange,
  ...data
}: { checked: boolean; disabled?: boolean; ariaLabel: string; onChange: (checked: boolean) => void } & DataAttributes) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={clsx("pfe-toggle", checked && "is-on")}
      onClick={() => onChange(!checked)}
      {...data}
    />
  );
}

export function EditorSegmented<T extends string>({
  value,
  options,
  ariaLabel,
  disabled,
  onChange
}: {
  value: T;
  options: Array<{ value: T; label: string; title?: string; danger?: boolean }>;
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div className="pfe-segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          type="button"
          role="radio"
          key={option.value}
          aria-checked={option.value === value}
          title={option.title}
          disabled={disabled}
          className={clsx(option.value === value && "is-active", option.danger && "is-danger")}
          onClick={() => onChange(option.value)}
          data-value={option.value}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 数字框：输入过程中只在合法范围内实时提交（换算随之更新）；失焦或回车时把越界值夹回范围，
 * 非数字恢复原值。这样输入「6」想写「60」时不会被立刻夹成下限。
 */
export function NumberField({
  value,
  min,
  max,
  step,
  integer,
  unit,
  ariaLabel,
  disabled,
  className,
  onChange
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  integer?: boolean;
  unit?: string;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  onChange: (value: number) => void;
}) {
  // 正在输入时显示草稿文字；不在输入时直接显示当前值（外部改动立即可见，不经过 effect）。
  const [draftText, setDraftText] = useState<string | null>(null);
  const commit = (raw: string, final: boolean) => {
    const parsed = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(parsed)) return;
    const next = integer ? Math.round(parsed) : parsed;
    if (next >= min && next <= max) {
      if (next !== value) onChange(next);
      return;
    }
    if (final) {
      const clamped = Math.min(max, Math.max(min, next));
      if (clamped !== value) onChange(clamped);
    }
  };
  return (
    <span className={clsx("pfe-number", disabled && "is-disabled", className)}>
      <input
        type="number"
        inputMode="decimal"
        value={draftText ?? formatNumber(value)}
        min={min}
        max={max}
        step={step ?? (integer ? 1 : "any")}
        aria-label={ariaLabel}
        disabled={disabled}
        onFocus={() => setDraftText(formatNumber(value))}
        onChange={(event) => {
          setDraftText(event.target.value);
          commit(event.target.value, false);
        }}
        onBlur={(event) => {
          commit(event.target.value, true);
          setDraftText(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      {unit ? <span>{unit}</span> : null}
    </span>
  );
}

/** 拖动条：按常用值一档一档走（拖动时吸附）；刻度下方的数字点一下直接选中。 */
export function ScaleSlider({
  value,
  scale,
  format,
  ariaLabel,
  disabled,
  onChange
}: {
  value: number;
  scale: NiceScale;
  format: (value: number) => string;
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const last = Math.max(1, scale.values.length - 1);
  const position = scalePosition(scale.values, value);
  const pick = (next: number) => {
    if (Math.abs(next - value) > 1e-9) onChange(next);
  };
  return (
    <div className={clsx("pfe-slider", disabled && "is-disabled")} style={{ "--pfe-fill": thumbOffset(position / last) } as CSSProperties}>
      <input
        type="range"
        min={0}
        max={last}
        step="any"
        value={position}
        aria-label={ariaLabel}
        aria-valuetext={format(value)}
        disabled={disabled}
        onChange={(event) => pick(scaleValueAt(scale.values, Number(event.target.value)))}
        onKeyDown={(event) => {
          const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 0;
          if (direction !== 0) {
            event.preventDefault();
            pick(stepValue(scale.values, value, direction));
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            pick(event.key === "Home" ? scale.values[0] : scale.values[scale.values.length - 1]);
          }
        }}
      />
      <div className="pfe-slider__ticks">
        {scale.ticks.map((tick) => (
          <button
            type="button"
            key={tick}
            tabIndex={-1}
            disabled={disabled}
            className={clsx(Math.abs(tick - value) < 1e-9 && "is-active")}
            style={{ left: thumbOffset(scale.values.indexOf(tick) / last) }}
            onClick={() => pick(tick)}
            data-scale-tick={tick}
          >
            {format(tick)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 快选按钮（离散参数：杠杆、同时持仓）。 */
export function PresetButtons({
  value,
  values,
  format,
  ariaLabel,
  disabled,
  onChange
}: {
  value: number;
  values: readonly number[];
  format: (value: number) => string;
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="pfe-presets" role="group" aria-label={ariaLabel}>
      {values.map((item) => {
        const active = Math.abs(item - value) < 1e-9;
        return (
          <button type="button" key={item} aria-pressed={active} disabled={disabled} className={clsx(active && "is-active")} onClick={() => onChange(item)} data-preset={item}>
            {format(item)}
          </button>
        );
      })}
    </div>
  );
}

/** 步进器：− / + 按常用值一档一档走，中间可以直接输入。 */
export function StepperField({
  value,
  values,
  min,
  max,
  unit,
  ariaLabel,
  disabled,
  onChange
}: {
  value: number;
  values: readonly number[];
  min: number;
  max: number;
  unit?: string;
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const step = (direction: 1 | -1) => {
    const next = Math.min(max, Math.max(min, stepValue(values, value, direction)));
    if (next !== value) onChange(next);
  };
  return (
    <span className={clsx("pfe-stepper", disabled && "is-disabled")}>
      <button type="button" aria-label={`${ariaLabel} −`} disabled={disabled || value <= min} onClick={() => step(-1)}><Minus size={12} /></button>
      <NumberField value={value} min={min} max={max} integer unit={unit} ariaLabel={ariaLabel} disabled={disabled} onChange={onChange} />
      <button type="button" aria-label={`${ariaLabel} +`} disabled={disabled || value >= max} onClick={() => step(1)}><Plus size={12} /></button>
    </span>
  );
}

/** 问号提示：说明文字不常驻，悬停或键盘聚焦时才显示。 */
export function HelpTip({ text }: { text: string }) {
  return (
    <span className="pfe-help" role="img" tabIndex={0} aria-label={text} data-tip={text}>
      ?
    </span>
  );
}
