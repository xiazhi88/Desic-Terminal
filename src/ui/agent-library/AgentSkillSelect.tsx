import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { Check, Plus, Search, X } from "lucide-react";
import type { AiSkillDefinition } from "../../types";
import "./AgentLibrary.css";

/**
 * 「依赖 Skills」多选下拉（C16 董事会要求）。
 *
 * 只允许从**已配置的 Skill**里选（比手打 id 更安全）：选项来自
 * `ai_config_summary.skillDefinitions`。未激活（不在 `enabledSkillIds` 里）的 Skill
 * 只做标记提示，**不阻断保存** —— 与 `agentMissingSkills` 的既有语义一致。
 *
 * 冻结钩子：`[data-agent-skills-select]`（根）、`[data-agent-skill-option][data-skill-id]`、
 * `[data-agent-skill-chip][data-skill-id]`。
 */

type AgentSkillSelectProps = {
  skills: AiSkillDefinition[];
  /** 当前已激活（会注入给专家会话）的 Skill id；仅用于标记，不参与过滤。 */
  enabledSkillIds: string[];
  value: string[];
  onChange: (nextIds: string[]) => void;
  disabled?: boolean;
};

export function AgentSkillSelect({
  skills,
  enabledSkillIds,
  value,
  onChange,
  disabled = false
}: AgentSkillSelectProps) {
  const { t } = useTranslation(["automation", "common"]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const enabledSet = useMemo(() => new Set(enabledSkillIds), [enabledSkillIds]);
  const byId = useMemo(() => new Map(skills.map((skill) => [skill.id, skill])), [skills]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return skills;
    return skills.filter((skill) => [skill.id, skill.name, skill.description]
      .some((item) => String(item ?? "").toLowerCase().includes(normalized)));
  }, [query, skills]);

  // 点击外部关闭（含 Esc 关闭后的焦点回落）。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    const timer = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    setActiveIndex((current) => (current >= filtered.length ? Math.max(0, filtered.length - 1) : current));
  }, [filtered.length]);

  const toggleSkill = (id: string) => {
    onChange(value.includes(id) ? value.filter((item) => item !== id) : [...value, id]);
  };

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (filtered.length === 0) return;
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (current + direction + filtered.length) % filtered.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const target = filtered[activeIndex] ?? filtered[0];
      if (target) toggleSkill(target.id);
    }
  };

  return (
    <div
      ref={rootRef}
      className={clsx("agent-skill-select", open && "is-open", disabled && "is-disabled")}
      data-agent-skills-select
      data-agent-skills-count={value.length}
    >
      <div className="agent-skill-select__chips">
        {value.map((id) => {
          const skill = byId.get(id);
          const label = skill?.name || id;
          const inactive = !enabledSet.has(id);
          return (
            <span className="agent-chip agent-skill-select__chip" data-agent-skill-chip data-skill-id={id} key={id}>
              <span title={skill ? `${id} · ${skill.description}` : id}>{label}</span>
              {inactive ? <i className="agent-skill-select__inactive" title={t("agentMissingSkillsHint")}>{t("agentSkillsInactive")}</i> : null}
              <button
                type="button"
                className="agent-skill-select__remove"
                data-skill-id={id}
                aria-label={t("agentSkillsRemove", { name: label })}
                disabled={disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleSkill(id);
                }}
              >
                <X size={10} />
              </button>
            </span>
          );
        })}
        <button
          type="button"
          className="agent-skill-select__trigger"
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={disabled || skills.length === 0}
          onClick={(event) => {
            event.stopPropagation();
            setOpen((current) => !current);
          }}
        >
          <Plus size={11} />
          {skills.length === 0 ? t("agentSkillsEmpty") : t("agentSkillsAdd")}
        </button>
      </div>

      {open ? (
        <div className="agent-skill-select__menu" onKeyDown={onSearchKeyDown}>
          <label className="agent-skill-select__search">
            <Search size={12} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder={t("agentSkillsSearch")}
              aria-label={t("agentSkillsSearch")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="agent-skill-select__options" role="listbox" aria-multiselectable="true" aria-label={t("agentSkills")}>
            {filtered.length === 0 ? (
              <p className="agent-skill-select__empty">{t("agentSkillsEmpty")}</p>
            ) : filtered.map((skill, index) => {
              const selected = value.includes(skill.id);
              const inactive = !enabledSet.has(skill.id);
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={clsx("agent-skill-select__option", selected && "is-selected", index === activeIndex && "is-active")}
                  data-agent-skill-option
                  data-skill-id={skill.id}
                  key={skill.id}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleSkill(skill.id);
                  }}
                >
                  <span className="agent-skill-select__check" aria-hidden="true">{selected ? <Check size={11} /> : null}</span>
                  <span className="agent-skill-select__option-copy">
                    <strong>{skill.name || skill.id}</strong>
                    <small>{skill.id}{skill.description ? ` · ${skill.description}` : ""}</small>
                  </span>
                  {inactive ? <em className="agent-chip is-warn">{t("agentSkillsInactive")}</em> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default AgentSkillSelect;
