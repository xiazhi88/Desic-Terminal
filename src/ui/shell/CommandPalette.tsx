import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { Search, Sparkles } from "lucide-react";

// ⌘K 命令面板：工作区跳转、合约切换、视图操作与「问 AI」。
// v1 刻意不包含任何下单、撤单、平仓动作：交易仍然只能在下单面板与既有确认流程中完成。

export type PaletteItem = {
  id: string;
  group: string;
  label: string;
  hint?: string;
  keywords?: string;
  icon?: ReactNode;
  shortcut?: string;
  run: () => void;
};

type Props = {
  open: boolean;
  items: PaletteItem[];
  askAiLabel: (query: string) => string;
  askAiGroup: string;
  placeholder: string;
  emptyLabel: string;
  onAskAi: (query: string) => void;
  onClose: () => void;
};

// 子序列匹配打分：连续命中与词首命中加分，完全不命中返回 -1。
function score(text: string, query: string) {
  if (!query) return 0;
  const haystack = text.toLowerCase();
  const direct = haystack.indexOf(query);
  if (direct >= 0) return 100 - direct;
  let position = -1;
  let total = 0;
  for (const char of query) {
    const next = haystack.indexOf(char, position + 1);
    if (next < 0) return -1;
    total += next === position + 1 ? 3 : 1;
    position = next;
  }
  return total;
}

export function CommandPalette({ open, items, askAiLabel, askAiGroup, placeholder, emptyLabel, onAskAi, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setActive(0);
    window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => restoreFocusRef.current?.focus?.();
  }, [open]);

  const normalized = query.trim().toLowerCase();
  const results = useMemo(() => {
    // 组按首次出现的顺序排列，组内按匹配分数排序，每组标题只出现一次。
    const groupOrder = new Map<string, number>();
    for (const item of items) if (!groupOrder.has(item.group)) groupOrder.set(item.group, groupOrder.size);
    const matched = items
      .map((item) => ({ item, value: score(`${item.label} ${item.keywords ?? ""} ${item.group}`, normalized) }))
      .filter((entry) => entry.value >= 0)
      .sort((left, right) => right.value - left.value)
      .slice(0, 40)
      .sort((left, right) => (groupOrder.get(left.item.group)! - groupOrder.get(right.item.group)!) || right.value - left.value)
      .map((entry) => entry.item);
    const ask: PaletteItem[] = normalized
      ? [{ id: "ask-ai", group: askAiGroup, label: askAiLabel(query.trim()), icon: <Sparkles size={14} />, run: () => onAskAi(query.trim()) }]
      : [];
    return [...ask, ...matched];
  }, [askAiGroup, askAiLabel, items, normalized, onAskAi, query]);

  useEffect(() => {
    setActive((current) => Math.min(current, Math.max(results.length - 1, 0)));
  }, [results.length]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-palette-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const runItem = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  let lastGroup = "";
  return (
    <div className="command-palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="command-palette" role="dialog" aria-modal="true" aria-label={placeholder}>
        <label className="command-palette__search">
          <Search size={15} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            placeholder={placeholder}
            aria-controls="command-palette-results"
            aria-activedescendant={results[active] ? `command-palette-${results[active].id}` : undefined}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((current) => Math.min(current + 1, results.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((current) => Math.max(current - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                runItem(results[active]);
              } else if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
          />
          <kbd>esc</kbd>
        </label>
        <div className="command-palette__results" id="command-palette-results" role="listbox" ref={listRef}>
          {results.length === 0 ? <p className="command-palette__empty">{emptyLabel}</p> : null}
          {results.map((item, index) => {
            const heading = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.id} className="command-palette__entry">
                {heading ? <div className="command-palette__group">{heading}</div> : null}
                <button
                  type="button"
                  id={`command-palette-${item.id}`}
                  role="option"
                  aria-selected={index === active}
                  data-palette-index={index}
                  className={clsx("command-palette__item", index === active && "is-active", item.id === "ask-ai" && "is-ai")}
                  onMouseMove={() => setActive(index)}
                  onClick={() => runItem(item)}
                >
                  <span className="command-palette__icon" aria-hidden="true">{item.icon}</span>
                  <span className="command-palette__label">{item.label}</span>
                  {item.hint ? <span className="command-palette__hint">{item.hint}</span> : null}
                  {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
