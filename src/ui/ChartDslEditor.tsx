import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { bracketMatching, defaultHighlightStyle, foldGutter, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useMemo, useRef } from "react";
import { parseChartIndicatorDsl, type DslDiagnostic } from "../lib/chartIndicatorDsl";

export type ChartDslEditorProps = Readonly<{
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}>;

/**
 * JSON-only editor for the safe chart indicator DSL. Consumers own persistence
 * and publishing; this component only edits text and exposes parser diagnostics.
 */
export function ChartDslEditor({ value, onChange, readOnly = false }: ChartDslEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const parsed = useMemo(() => parseChartIndicatorDsl(value), [value]);
  const diagnostics = parsed.diagnostics;
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
      javascript(),
      keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const next = update.state.doc.toString();
        valueRef.current = next;
        onChangeRef.current(next);
      }),
      chartDslEditorTheme,
    ],
    [readOnly],
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

  return (
    <section className="chart-dsl-editor" aria-label="安全指标 DSL 编辑器">
      <div
        className="chart-dsl-editor-host"
        ref={hostRef}
        data-testid="chart-dsl-editor"
      />
      <DslDiagnostics diagnostics={diagnostics} />
    </section>
  );
}

function DslDiagnostics({ diagnostics }: Readonly<{ diagnostics: readonly DslDiagnostic[] }>) {
  if (diagnostics.length === 0) {
    return (
      <p aria-live="polite" style={{ margin: "8px 0 0", color: "#4ade80", fontSize: 12 }}>
        JSON AST 校验通过
      </p>
    );
  }
  return (
    <div aria-live="polite" role="status" style={{ marginTop: 8, display: "grid", gap: 4 }}>
      {diagnostics.map((diagnostic, index) => (
        <div
          key={`${diagnostic.path}-${diagnostic.message}-${index}`}
          style={{
            color: diagnostic.severity === "error" ? "#fb7185" : "#fbbf24",
            fontSize: 12,
            fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
          }}
        >
          <strong>{diagnostic.path || "/"}</strong> {diagnostic.message}
        </div>
      ))}
    </div>
  );
}

const chartDslEditorTheme = EditorView.theme({
  "&": {
    minHeight: "220px",
    color: "#f4f4f6",
    backgroundColor: "#08090c",
    fontSize: "12px",
  },
  ".cm-scroller": {
    fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
    lineHeight: "1.58",
  },
  ".cm-content": {
    padding: "10px 0",
    caretColor: "#67e8f9",
  },
  ".cm-cursor": {
    borderLeftColor: "#67e8f9",
    borderLeftWidth: "2px",
  },
  ".cm-line": { padding: "0 12px" },
  ".cm-gutters": {
    color: "rgba(255,255,255,0.34)",
    backgroundColor: "rgba(255,255,255,0.025)",
    borderRight: "1px solid rgba(255,255,255,0.075)",
  },
  ".cm-activeLine": { backgroundColor: "rgba(139,92,246,0.1)" },
  ".cm-activeLineGutter": { color: "#efe8ff", backgroundColor: "rgba(139,92,246,0.16)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "rgba(103,232,249,0.22)" },
  "&.cm-focused": { outline: "1px solid rgba(103,232,249,0.42)" },
});
