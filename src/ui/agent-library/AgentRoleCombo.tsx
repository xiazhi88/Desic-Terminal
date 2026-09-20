import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import "./AgentLibrary.css";

/**
 * 「角色」组合控件（C16 董事会要求）：可自由输入 slug，同时给出既有角色枚举建议。
 *
 * 冻结钩子：`[data-agent-role-input]`（输入框）、`[data-agent-role-option]`（每个建议项）。
 * 键盘：↑↓ 移动、Enter 选中当前建议、Esc 关闭；点击外部关闭。
 */

type AgentRoleComboProps = {
  value: string;
  suggestions: readonly string[];
  onChange: (value: string) => void;
  disabled?: boolean;
  maxLength?: number;
  ariaLabel: string;
};

export function AgentRoleCombo({
  value,
  suggestions,
  onChange,
  disabled = false,
  maxLength = 32,
  ariaLabel
}: AgentRoleComboProps) {
  const { t } = useTranslation(["automation", "common"]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const filtered = useMemo(() => {
    const normalized = value.trim().toLowerCase();
    // 当前值本身就是某个建议项时（例如默认 "custom"）显示全部建议，
    // 只有真正的"输入中"才做过滤 —— 否则点一下只能看到 1 条，不像下拉建议。
    if (!normalized || suggestions.some((role) => role.toLowerCase() === normalized)) return suggestions;
    const matches = suggestions.filter((role) => role.toLowerCase().includes(normalized));
    return matches.length > 0 ? matches : suggestions;
  }, [suggestions, value]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    setActiveIndex((current) => (current >= filtered.length ? 0 : current));
  }, [filtered.length]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (filtered.length === 0) return;
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (current + direction + filtered.length) % filtered.length);
      return;
    }
    if (event.key === "Enter" && open) {
      const target = filtered[activeIndex];
      if (!target) return;
      event.preventDefault();
      onChange(target);
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className={clsx("agent-role-combo", open && "is-open")}>
      <input
        data-agent-role-input
        value={value}
        maxLength={maxLength}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open}
        autoComplete="off"
        role="combobox"
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && filtered.length > 0 ? (
        <div className="agent-role-combo__menu" role="listbox" aria-label={t("agentRoleSuggestions")}>
          {filtered.map((role, index) => (
            <button
              type="button"
              role="option"
              aria-selected={role === value}
              className={clsx("agent-role-combo__option", index === activeIndex && "is-active", role === value && "is-selected")}
              data-agent-role-option
              data-role={role}
              key={role}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(role);
                setOpen(false);
              }}
            >
              {role}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default AgentRoleCombo;
