import clsx from "clsx";
import { Check, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import "./TerminalSelect.css";

export type TerminalSelectOption = Readonly<{
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  data?: Readonly<Record<`data-${string}`, string | undefined>>;
}>;

type TerminalSelectPosition = Readonly<{
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: "top" | "bottom";
}>;

export type TerminalSelectProps = Readonly<{
  value: string;
  options: readonly TerminalSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  id?: string;
  name?: string;
  className?: string;
  triggerClassName?: string;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  ariaDescribedBy?: string;
  menuMinWidth?: number;
  maxMenuHeight?: number;
  preserveOptionLabels?: boolean;
}>;

const VIEWPORT_GAP = 8;
const MENU_GAP = 4;
const DEFAULT_MENU_MAX_HEIGHT = 280;
const DEFAULT_MENU_MIN_WIDTH = 176;
const TYPEAHEAD_RESET_MS = 650;

function normalizeSearchText(value: string) {
  return value.trim().toLocaleLowerCase();
}

export function TerminalSelect({
  value,
  options,
  onChange,
  ariaLabel,
  id,
  name,
  className,
  triggerClassName,
  placeholder,
  disabled = false,
  invalid = false,
  ariaDescribedBy,
  menuMinWidth = DEFAULT_MENU_MIN_WIDTH,
  maxMenuHeight = DEFAULT_MENU_MAX_HEIGHT,
  preserveOptionLabels = false,
}: TerminalSelectProps) {
  const { t } = useTranslation("common");
  const resolvedPlaceholder = placeholder ?? t("selectOption");
  const generatedId = useId();
  const listboxId = `${generatedId}-listbox`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const typeaheadRef = useRef("");
  const typeaheadTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<TerminalSelectPosition | null>(null);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null;
  const enabledIndices = useMemo(
    () => options.reduce<number[]>((indices, option, index) => {
      if (!option.disabled) indices.push(index);
      return indices;
    }, []),
    [options],
  );
  const isDisabled = disabled || enabledIndices.length === 0;

  const resetTypeahead = useCallback(() => {
    typeaheadRef.current = "";
    if (typeaheadTimerRef.current !== null) {
      window.clearTimeout(typeaheadTimerRef.current);
      typeaheadTimerRef.current = null;
    }
  }, []);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const estimatedHeight = Math.min(maxMenuHeight, Math.max(40, options.length * 34 + 8));
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_GAP - MENU_GAP;
    const spaceAbove = rect.top - VIEWPORT_GAP - MENU_GAP;
    const placement = spaceBelow < Math.min(160, estimatedHeight) && spaceAbove > spaceBelow ? "top" : "bottom";
    const availableHeight = Math.max(40, placement === "top" ? spaceAbove : spaceBelow);
    const resolvedMaxHeight = Math.min(maxMenuHeight, availableHeight);
    const width = Math.min(
      Math.max(rect.width, menuMinWidth),
      window.innerWidth - VIEWPORT_GAP * 2,
    );
    const left = Math.min(
      Math.max(VIEWPORT_GAP, rect.left),
      window.innerWidth - width - VIEWPORT_GAP,
    );
    const top = placement === "top"
      ? Math.max(VIEWPORT_GAP, rect.top - MENU_GAP - Math.min(estimatedHeight, resolvedMaxHeight))
      : rect.bottom + MENU_GAP;

    setPosition({ top, left, width, maxHeight: resolvedMaxHeight, placement });
  }, [maxMenuHeight, menuMinWidth, options.length]);

  const openMenu = useCallback((preferredIndex?: number) => {
    if (isDisabled) return;
    const initialIndex = preferredIndex
      ?? (selectedIndex >= 0 && !options[selectedIndex]?.disabled ? selectedIndex : enabledIndices[0])
      ?? -1;
    setActiveIndex(initialIndex);
    updatePosition();
    setOpen(true);
  }, [enabledIndices, isDisabled, options, selectedIndex, updatePosition]);

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    setPosition(null);
    resetTypeahead();
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, [resetTypeahead]);

  const selectIndex = useCallback((index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    closeMenu(true);
  }, [closeMenu, onChange, options]);

  const moveActive = useCallback((direction: 1 | -1) => {
    if (enabledIndices.length === 0) return;
    const currentPosition = enabledIndices.indexOf(activeIndex);
    const nextPosition = currentPosition < 0
      ? (direction === 1 ? 0 : enabledIndices.length - 1)
      : (currentPosition + direction + enabledIndices.length) % enabledIndices.length;
    setActiveIndex(enabledIndices[nextPosition]);
  }, [activeIndex, enabledIndices]);

  const moveByTypeahead = useCallback((character: string) => {
    if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current);
    typeaheadRef.current += normalizeSearchText(character);
    typeaheadTimerRef.current = window.setTimeout(resetTypeahead, TYPEAHEAD_RESET_MS);

    const query = typeaheadRef.current;
    const currentPosition = enabledIndices.indexOf(activeIndex);
    const orderedIndices = [
      ...enabledIndices.slice(currentPosition + 1),
      ...enabledIndices.slice(0, currentPosition + 1),
    ];
    const match = orderedIndices.find((index) => normalizeSearchText(options[index]?.label ?? "").startsWith(query));
    if (match === undefined) return;
    if (!open) openMenu(match);
    else setActiveIndex(match);
  }, [activeIndex, enabledIndices, open, openMenu, options, resetTypeahead]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (isDisabled) return;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) openMenu();
      else moveActive(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const nextIndex = event.key === "Home" ? enabledIndices[0] : enabledIndices[enabledIndices.length - 1];
      if (!open) openMenu(nextIndex);
      else setActiveIndex(nextIndex ?? -1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) openMenu();
      else selectIndex(activeIndex);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (event.key === "Tab" && open) {
      closeMenu();
      return;
    }
    if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      moveByTypeahead(event.key);
    }
  }, [activeIndex, closeMenu, enabledIndices, isDisabled, moveActive, moveByTypeahead, open, openMenu, selectIndex]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const handleViewportChange = () => updatePosition();
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [closeMenu, open, updatePosition]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-terminal-select-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  useEffect(() => {
    if (isDisabled && open) closeMenu();
  }, [closeMenu, isDisabled, open]);

  useEffect(() => () => resetTypeahead(), [resetTypeahead]);

  return (
    <div
      className={clsx("terminal-select", open && "open", isDisabled && "disabled", invalid && "invalid", className)}
      data-terminal-select={ariaLabel}
    >
      {name ? <input type="hidden" name={name} value={value} /> : null}
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={clsx("terminal-select-trigger", triggerClassName)}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={ariaDescribedBy}
        disabled={isDisabled}
        data-value={value}
        title={preserveOptionLabels ? undefined : (selectedOption?.label ?? value) || resolvedPlaceholder}
        onClick={() => open ? closeMenu() : openMenu()}
        onKeyDown={handleKeyDown}
      >
        <span className={clsx("terminal-select-value", !selectedOption && !value && "placeholder")} data-i18n-skip={preserveOptionLabels ? "" : undefined}>{(selectedOption?.label ?? value) || resolvedPlaceholder}</span>
        <ChevronDown className="terminal-select-chevron" size={14} aria-hidden="true" />
      </button>
      {open && position && typeof document !== "undefined" ? createPortal(
        <div
          ref={menuRef}
          id={listboxId}
          className="terminal-select-menu"
          role="listbox"
          aria-label={t("optionsFor", { label: ariaLabel })}
          data-placement={position.placement}
          data-terminal-select-menu="true"
          style={{ top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {options.map((option, index) => (
            <button
              {...option.data}
              id={`${listboxId}-option-${index}`}
              key={`${option.value}-${index}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              disabled={option.disabled}
              data-terminal-select-index={index}
              data-value={option.value}
              className={clsx(
                "terminal-select-option",
                index === activeIndex && "active",
                option.value === value && "selected",
              )}
              title={preserveOptionLabels ? undefined : option.label}
              onMouseMove={() => {
                if (!option.disabled) setActiveIndex(index);
              }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectIndex(index)}
            >
              <span data-i18n-skip={preserveOptionLabels ? "" : undefined}>
                <strong>{option.label}</strong>
                {option.description ? <small>{option.description}</small> : null}
              </span>
              {option.value === value ? <Check size={13} aria-hidden="true" /> : null}
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
