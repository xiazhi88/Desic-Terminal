import { autocompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { bracketMatching, defaultHighlightStyle, foldGutter, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  SearchQuery,
  search,
  searchKeymap,
  setSearchQuery,
} from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type Panel,
  type ViewUpdate,
} from "@codemirror/view";
import { useEffect, useMemo, useRef } from "react";

export type SystematicPythonEditorProps = Readonly<{
  value: string;
  typingPreview?: string | null;
  ariaLabel: string;
  chinese?: boolean;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onUserEdit?: () => void;
  onSave?: () => void;
}>;

type SearchLabels = Readonly<{
  placeholder: string;
  previous: string;
  next: string;
  close: string;
  matches: (current: number, total: number) => string;
}>;

const STRATEGY_COMPLETIONS: readonly Completion[] = [
  { label: "def on_bar(ctx):", type: "keyword", apply: "def on_bar(ctx):\n    " },
  { label: "ctx.market.bars", detail: "confirmed K-line window", type: "function", apply: "ctx.market.bars(ctx.instrument_id, ctx.interval, lookback=35)" },
  { label: "ctx.indicators.ema", detail: "cached confirmed 1m EMA", type: "function", apply: "ctx.indicators.ema(ctx.instrument_id, \"1m\", 20)" },
  { label: "ctx.indicators.atr", detail: "cached confirmed 1m Wilder ATR", type: "function", apply: "ctx.indicators.atr(ctx.instrument_id, \"1m\", 14)" },
  { label: "ctx.portfolio.position", detail: "current virtual position", type: "function", apply: "ctx.portfolio.position(ctx.instrument_id, \"long\")" },
  { label: "ctx.factor_scores", detail: "cross-sectional ranking; literal factor id only", type: "function", apply: "ctx.factor_scores(\"builtin-kline-blend-v1\")" },
  { label: "ctx.no_action", detail: "no trade decision", type: "function", apply: "ctx.no_action(\"reason\")" },
  { label: "ctx.open_long", detail: "open a virtual long", type: "function", apply: "ctx.open_long(1, \"reason\")" },
  { label: "ctx.open_short", detail: "open a virtual short", type: "function", apply: "ctx.open_short(1, \"reason\")" },
  { label: "ctx.close_long", detail: "close current virtual long", type: "function", apply: "ctx.close_long(long_position.quantity, \"reason\")" },
  { label: "ctx.close_short", detail: "close current virtual short", type: "function", apply: "ctx.close_short(short_position.quantity, \"reason\")" },
  { label: "ctx.instrument_id", detail: "active contract", type: "variable" },
  { label: "ctx.interval", detail: "confirmed bar interval", type: "variable" },
  { label: "ctx.as_of_ms", detail: "current closed-bar cutoff", type: "variable" },
  { label: "long_position", detail: "long virtual position", type: "variable" },
  { label: "short_position", detail: "short virtual position", type: "variable" },
  { label: "return", type: "keyword" },
  { label: "if", type: "keyword", apply: "if " },
  { label: "elif", type: "keyword", apply: "elif " },
  { label: "else", type: "keyword", apply: "else:\n    " },
  { label: "len", type: "function" },
  { label: "sum", type: "function" },
  { label: "min", type: "function" },
  { label: "max", type: "function" },
];

function strategyCompletions(context: CompletionContext) {
  const before = context.matchBefore(/[A-Za-z0-9_.]*/);
  if (!before || (!context.explicit && before.from === before.to)) return null;
  return {
    from: before.from,
    options: STRATEGY_COMPLETIONS,
  };
}

function createSearchPanel(view: EditorView, labels: SearchLabels): Panel {
  const dom = document.createElement("div");
  dom.className = "systematic-python-search";
  dom.setAttribute("role", "search");

  const input = document.createElement("input");
  input.type = "search";
  input.name = "search";
  input.className = "cm-textfield systematic-python-search__input";
  input.placeholder = labels.placeholder;
  input.setAttribute("aria-label", labels.placeholder);
  input.setAttribute("main-field", "true");

  const count = document.createElement("span");
  count.className = "systematic-python-search__count";
  count.setAttribute("role", "status");
  count.setAttribute("aria-live", "polite");

  const createButton = (name: string, label: string, text: string, onClick: () => void) => {
    const button = document.createElement("button");
    button.type = "button";
    button.name = name;
    button.className = "systematic-python-search__button";
    button.textContent = text;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", onClick);
    return button;
  };

  const updatePanel = () => {
    const query = getSearchQuery(view.state);
    if (input.value !== query.search) input.value = query.search;

    if (!query.valid || !query.search) {
      count.textContent = "";
      previousButton.disabled = true;
      nextButton.disabled = true;
      return;
    }

    const selection = view.state.selection.main;
    let total = 0;
    let current = 0;
    const cursor = query.getCursor(view.state);
    for (let result = cursor.next(); !result.done; result = cursor.next()) {
      const match = result.value;
      total += 1;
      if (selection.from === match.from && selection.to === match.to) current = total;
    }

    count.textContent = labels.matches(current, total);
    previousButton.disabled = total === 0;
    nextButton.disabled = total === 0;
  };

  const setQueryFromInput = () => {
    const current = getSearchQuery(view.state);
    const next = new SearchQuery({
      search: input.value,
      caseSensitive: current.caseSensitive,
      literal: true,
      regexp: false,
      wholeWord: current.wholeWord,
    });
    if (!next.eq(current)) view.dispatch({ effects: setSearchQuery.of(next) });
    updatePanel();
  };

  const navigate = (command: (target: EditorView) => boolean) => {
    command(view);
    updatePanel();
    input.focus();
  };

  const previousButton = createButton("previous", labels.previous, "\u2191", () => navigate(findPrevious));
  const nextButton = createButton("next", labels.next, "\u2193", () => navigate(findNext));
  const closeButton = createButton("close", labels.close, "\u00d7", () => closeSearchPanel(view));

  input.addEventListener("input", setQueryFromInput);
  input.addEventListener("search", setQueryFromInput);
  input.addEventListener("keydown", (event) => {
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === "f") {
      event.preventDefault();
      input.select();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearchPanel(view);
      return;
    }
    if (event.key === "Enter" || event.key === "F3" || (modifier && event.key.toLowerCase() === "g")) {
      event.preventDefault();
      navigate(event.shiftKey ? findPrevious : findNext);
    }
  });

  dom.append(input, count, previousButton, nextButton, closeButton);

  return {
    dom,
    top: true,
    mount() {
      updatePanel();
      input.focus();
      input.select();
    },
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(setSearchQuery)),
      )) {
        updatePanel();
      }
    },
  };
}

/**
 * CodeMirror is intentionally limited to editing source. Saving and AI draft
 * application remain owned by the strategy workspace, preventing editor input
 * from implicitly creating or replacing a persisted strategy version.
 */
export function SystematicPythonEditor({
  value,
  typingPreview = null,
  ariaLabel,
  chinese = false,
  readOnly = false,
  onChange,
  onUserEdit,
  onSave,
}: SystematicPythonEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const typingPreviewRef = useRef<HTMLPreElement | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onUserEditRef = useRef(onUserEdit);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onUserEditRef.current = onUserEdit;
  onSaveRef.current = onSave;

  const searchLabels = useMemo<SearchLabels>(() => chinese ? {
    placeholder: "搜索策略源码",
    previous: "上一个匹配项",
    next: "下一个匹配项",
    close: "关闭搜索",
    matches: (current, total) => `${current} / ${total}`,
  } : {
    placeholder: "Find in strategy source",
    previous: "Previous match",
    next: "Next match",
    close: "Close search",
    matches: (current, total) => `${current} / ${total}`,
  }, [chinese]);

  const extensions = useMemo(
    () => [
      lineNumbers(),
      foldGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      python(),
      autocompletion({ override: [strategyCompletions], activateOnTyping: true }),
      search({
        top: true,
        createPanel: (view) => createSearchPanel(view, searchLabels),
      }),
      keymap.of([
        indentWithTab,
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            onSaveRef.current?.();
            return true;
          },
        },
        {
          key: "Ctrl-f",
          preventDefault: true,
          run: openSearchPanel,
        },
        ...searchKeymap,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorState.tabSize.of(2),
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      EditorView.contentAttributes.of({ "aria-label": ariaLabel, "aria-multiline": "true" }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const isUserEdit = update.transactions.some((transaction) =>
          transaction.isUserEvent("input") || transaction.isUserEvent("delete") || transaction.isUserEvent("undo") || transaction.isUserEvent("redo"),
        );
        if (isUserEdit) onUserEditRef.current?.();
        const next = update.state.doc.toString();
        valueRef.current = next;
        onChangeRef.current(next);
      }),
      systematicPythonEditorTheme,
    ],
    [ariaLabel, readOnly, searchLabels],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: valueRef.current, extensions }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [extensions]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === valueRef.current) return;
    valueRef.current = value;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const preview = typingPreviewRef.current;
    if (preview) preview.scrollTop = preview.scrollHeight;
  }, [typingPreview]);

  return <div className="systematic-python-editor" data-testid="systematic-python-editor">
    <div ref={hostRef} className="systematic-python-editor__host" />
    {typingPreview !== null ? <pre ref={typingPreviewRef} className="systematic-python-editor__typing-preview" aria-hidden="true">{typingPreview}</pre> : null}
  </div>;
}

const systematicPythonEditorTheme = EditorView.theme({
  "&": {
    minWidth: "0",
    minHeight: "0",
    height: "100%",
    color: "#e8ebf2",
    backgroundColor: "#090c11",
    fontSize: "12px",
  },
  ".cm-scroller": {
    fontFamily: '"SFMono-Regular", "Cascadia Code", Consolas, monospace',
    lineHeight: "1.62",
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "10px 0 32px",
    caretColor: "#c9b5ff",
  },
  ".cm-cursor": {
    borderLeftColor: "#c9b5ff",
    borderLeftWidth: "2px",
  },
  ".cm-line": { padding: "0 12px" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "28px", padding: "0 8px 0 6px", fontVariantNumeric: "tabular-nums" },
  ".cm-gutters": {
    color: "#687184",
    backgroundColor: "#0c1017",
    borderRight: "1px solid rgba(182,194,218,0.1)",
  },
  ".cm-matchingBracket": { color: "#f0eaff", backgroundColor: "rgba(179,150,255,0.16)", outline: "1px solid rgba(179,150,255,0.28)" },
  ".cm-activeLine": { backgroundColor: "rgba(179,150,255,0.07)" },
  ".cm-activeLineGutter": { color: "#dcd4f5", backgroundColor: "rgba(179,150,255,0.1)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "rgba(179,150,255,0.24)" },
  "&.cm-focused": { outline: "1px solid rgba(179,150,255,0.58)", outlineOffset: "-1px" },
  ".cm-tooltip": {
    overflow: "hidden",
    border: "1px solid rgba(182,194,218,0.2)",
    borderRadius: "4px",
    color: "#dfe4ed",
    backgroundColor: "#121722",
    boxShadow: "0 10px 24px rgba(0,0,0,0.32)",
  },
  ".cm-tooltip-autocomplete > ul > li": { padding: "4px 8px", fontFamily: '"SFMono-Regular", "Cascadia Code", Consolas, monospace' },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { color: "#f1edff", backgroundColor: "rgba(179,150,255,0.16)" },
  ".cm-completionDetail": { color: "#8791a5", fontStyle: "normal" },
  ".cm-panel.systematic-python-search": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    minHeight: "38px",
    padding: "5px 8px",
    borderBottom: "1px solid rgba(182,194,218,0.15)",
    backgroundColor: "#10151f",
    fontFamily: '"SFMono-Regular", "Cascadia Code", Consolas, monospace',
  },
  ".systematic-python-search__input": {
    flex: "1 1 180px",
    minWidth: "0",
    height: "27px",
    padding: "0 8px",
    border: "1px solid rgba(182,194,218,0.24)",
    borderRadius: "3px",
    color: "#edf0f5",
    backgroundColor: "#080b10",
    outline: "none",
    font: "inherit",
  },
  ".systematic-python-search__input:focus": {
    borderColor: "rgba(179,150,255,0.78)",
    boxShadow: "0 0 0 1px rgba(179,150,255,0.23)",
  },
  ".systematic-python-search__count": {
    flex: "0 0 48px",
    color: "#8f99ad",
    fontSize: "11px",
    textAlign: "center",
    whiteSpace: "nowrap",
  },
  ".systematic-python-search__button": {
    width: "28px",
    height: "27px",
    padding: "0",
    border: "1px solid rgba(182,194,218,0.2)",
    borderRadius: "3px",
    color: "#c6cedd",
    backgroundColor: "#151b26",
    cursor: "pointer",
    fontSize: "15px",
    lineHeight: "1",
  },
  ".systematic-python-search__button:hover:not(:disabled)": {
    color: "#f0ecff",
    borderColor: "rgba(179,150,255,0.54)",
    backgroundColor: "rgba(179,150,255,0.15)",
  },
  ".systematic-python-search__button:focus-visible": {
    outline: "1px solid rgba(179,150,255,0.82)",
    outlineOffset: "1px",
  },
  ".systematic-python-search__button:disabled": {
    opacity: "0.4",
    cursor: "not-allowed",
  },
  ".cm-searchMatch": {
    backgroundColor: "rgba(77, 206, 182, 0.27)",
    outline: "1px solid rgba(77, 206, 182, 0.36)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "rgba(179,150,255,0.48)",
    outlineColor: "rgba(204,184,255,0.92)",
  },
});
