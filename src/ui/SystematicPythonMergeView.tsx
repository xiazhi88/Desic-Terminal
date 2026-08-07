import { python } from "@codemirror/lang-python";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { MergeView } from "@codemirror/merge";
import { useEffect, useRef } from "react";

type Props = Readonly<{
  left: string;
  right: string;
  leftLabel: string;
  rightLabel: string;
}>;

const readOnlyExtensions = [
  lineNumbers(),
  python(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  EditorView.theme({
    "&": { minWidth: "0", color: "#e8ebf2", backgroundColor: "#090c11", fontSize: "11px" },
    ".cm-scroller": { fontFamily: '"SFMono-Regular", "Cascadia Code", Consolas, monospace', lineHeight: "1.58" },
    ".cm-content": { padding: "10px 0 24px" },
    ".cm-line": { padding: "0 10px" },
    ".cm-lineNumbers .cm-gutterElement": { minWidth: "26px", padding: "0 7px 0 5px", fontVariantNumeric: "tabular-nums" },
    ".cm-gutters": { color: "#687184", backgroundColor: "#0c1017", borderRight: "1px solid rgba(182,194,218,0.1)" },
    ".cm-merge-a .cm-changedLine, .cm-merge-b .cm-changedLine": { backgroundColor: "rgba(179,150,255,0.08)" },
  }),
];

export function SystematicPythonMergeView({ left, right, leftLabel, rightLabel }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new MergeView({
      parent: host,
      a: {
        doc: left,
        extensions: [
          ...readOnlyExtensions,
          EditorView.contentAttributes.of({ "aria-label": leftLabel }),
        ],
      },
      b: {
        doc: right,
        extensions: [
          ...readOnlyExtensions,
          EditorView.contentAttributes.of({ "aria-label": rightLabel }),
        ],
      },
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 4, minSize: 10 },
      diffConfig: { scanLimit: 2_000, timeout: 120 },
    });
    return () => view.destroy();
  }, [left, leftLabel, right, rightLabel]);

  return <div ref={hostRef} className="systematic-python-merge-view" />;
}
