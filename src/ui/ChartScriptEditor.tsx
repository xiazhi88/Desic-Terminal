import { useEffect, useMemo, useRef } from "react";
import { autocompletion, closeCompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { bracketMatching, defaultHighlightStyle, foldGutter, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { lintGutter } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view";
import { Copy, Play, Save, Trash2 } from "lucide-react";
import clsx from "clsx";
import type { ChartScriptDefinition, ChartScriptRunState } from "./chartScriptEngine";
import { ChartDslEditor } from "./ChartDslEditor";

type Props = {
  script: ChartScriptDefinition;
  state?: ChartScriptRunState;
  alertCount: number;
  onChange: (patch: Partial<ChartScriptDefinition>) => void;
  onSave: () => void;
  onRun: () => void;
  onCopy: () => void;
  onDelete: () => void;
};

export function ChartScriptEditor({ script, state, alertCount, onChange, onSave, onRun, onCopy, onDelete }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(script.source);
  const callbacksRef = useRef({ onChange, onSave, onRun });
  const legacyReadOnly = script.runtime !== "dsl" || script.legacyReadOnly === true;
  callbacksRef.current = { onChange, onSave, onRun };

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
      lintGutter(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      javascript(),
      autocompletion({
        activateOnTyping: true,
        override: [chartScriptCompletionSource]
      }),
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            callbacksRef.current.onSave();
            return true;
          }
        },
        {
          key: "Mod-Enter",
          preventDefault: true,
          run: () => {
            callbacksRef.current.onRun();
            return true;
          }
        },
        {
          key: "Escape",
          run: closeCompletion
        },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap
      ]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const next = update.state.doc.toString();
        valueRef.current = next;
        callbacksRef.current.onChange({ source: next });
      }),
      chartScriptEditorTheme
    ],
    []
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: script.source,
        extensions
      })
    });
    viewRef.current = view;
    valueRef.current = script.source;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [extensions]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || script.source === valueRef.current) return;
    valueRef.current = script.source;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: script.source }
    });
  }, [script.id, script.source]);

  return (
    <div className={clsx("chart-script-editor", legacyReadOnly && "legacy-read-only")}>
      <div className="chart-script-fields">
        <label>
          <span>脚本名称</span>
          <small>显示在指标中心、图层列表和脚本历史中。</small>
          <input value={script.name} onChange={(event) => onChange({ name: event.target.value })} placeholder="例如：双均线趋势过滤" />
        </label>
        <label>
          <span>描述</span>
          <small>说明这个指标的用途、参数和适用场景。</small>
          <input value={script.description} onChange={(event) => onChange({ description: event.target.value })} placeholder="例如：用快慢 EMA 判断趋势强弱" />
        </label>
      </div>
      {legacyReadOnly && <div className={clsx("chart-script-dsl-note", "warning")}>旧版 JavaScript 源码仅供查看，不能执行。复制后请手动迁移为安全 DSL。</div>}
      {legacyReadOnly ? (
        <div className={clsx("chart-script-codemirror", "legacy-read-only")} ref={hostRef} data-testid="chart-script-codemirror" />
      ) : (
        <ChartDslEditor value={script.source} onChange={(source) => onChange({ source })} />
      )}
      <div className="chart-script-actions">
        <label>
          <input type="checkbox" checked={!script.hidden} onChange={() => onChange({ hidden: !script.hidden })} />
          显示图层
        </label>
        <label>
          <input type="checkbox" checked={script.enabled} disabled={legacyReadOnly} onChange={() => onChange({ enabled: !script.enabled })} />
          启用运行
        </label>
        <button type="button" onClick={onRun} disabled={legacyReadOnly}><Play size={13} /> 运行</button>
        <button type="button" onClick={onSave}><Save size={13} /> 保存</button>
        <button type="button" onClick={onCopy}><Copy size={13} /> 复制</button>
        <button type="button" className="danger" onClick={onDelete}><Trash2 size={13} /> 删除</button>
      </div>
      <div className="chart-script-status">
        <span className={clsx("chart-script-run-state", state?.status)}>{state?.status ?? "idle"}</span>
        <span>输出 {state?.outputCount ?? 0}</span>
        <span>提醒 {alertCount}</span>
        <span>耗时 {state?.runtimeMs ?? 0}ms</span>
        <span>版本 {script.versions.length}</span>
        <span>保存 {formatRelativeTime(script.updatedAt)}</span>
      </div>
      {state?.error && <pre className="chart-script-error">{state.error}</pre>}
    </div>
  );
}

const chartScriptEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "#f4f4f6",
    backgroundColor: "rgba(0,0,0,0.38)",
    fontSize: "12px"
  },
  ".cm-scroller": {
    fontFamily: "\"JetBrains Mono\", \"Cascadia Code\", Consolas, monospace",
    lineHeight: "1.56"
  },
  ".cm-content": {
    padding: "10px 0",
    caretColor: "#67e8f9"
  },
  ".cm-cursor": {
    borderLeftColor: "#67e8f9",
    borderLeftWidth: "2px"
  },
  ".cm-line": {
    padding: "0 12px"
  },
  ".cm-gutters": {
    color: "rgba(255,255,255,0.32)",
    backgroundColor: "rgba(255,255,255,0.025)",
    borderRight: "1px solid rgba(255,255,255,0.075)"
  },
  ".cm-activeLine": {
    backgroundColor: "rgba(139,92,246,0.11)"
  },
  ".cm-activeLineGutter": {
    color: "#efe8ff",
    backgroundColor: "rgba(139,92,246,0.16)"
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "rgba(103,232,249,0.24)"
  },
  "&.cm-focused": {
    outline: "1px solid rgba(103,232,249,0.42)"
  },
  ".cm-tooltip": {
    border: "1px solid rgba(183,146,255,0.24)",
    backgroundColor: "#101018",
    color: "#f4f4f6"
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "rgba(139,92,246,0.24)",
    color: "#fff"
  }
});

function chartScriptCompletionSource(context: CompletionContext) {
  const word = context.matchBefore(/(?:\w+\.?)*\w*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const prefix = word.text;
  const options = completionOptions.filter((item) => item.label.startsWith(prefix) || item.label.includes(prefix));
  return {
    from: word.from,
    options: options.length > 0 ? options : completionOptions.slice(0, 12),
    validFor: /(?:\w+\.?)*\w*/
  };
}

const completionOptions: Completion[] = [
  { label: "ctx", type: "variable", detail: "脚本上下文" },
  { label: "ctx.candles", type: "property", detail: "K 线数组" },
  { label: "ctx.ticker", type: "property", detail: "最新 ticker" },
  { label: "ctx.orderBook", type: "property", detail: "当前盘口" },
  { label: "ctx.recentTrades", type: "property", detail: "最近成交" },
  { label: "ctx.fundingRate", type: "property", detail: "资金费率" },
  { label: "ctx.orderBookPressure", type: "property", detail: "标准化盘口压力" },
  { label: "ctx.orderBookPressure.score", type: "property", detail: "-1 到 1，多空压力分数" },
  { label: "ta.sma", type: "function", detail: "(values, period)" },
  { label: "ta.ema", type: "function", detail: "(values, period)" },
  { label: "ta.highest", type: "function", detail: "(values, period)" },
  { label: "ta.lowest", type: "function", detail: "(values, period)" },
  { label: "plot.line", type: "function", detail: "(name, values, options)" },
  { label: "plot.hline", type: "function", detail: "(name, price, options)" },
  { label: "plot.band", type: "function", detail: "(name, upper, lower, options)" },
  { label: "plot.marker", type: "function", detail: "(name, time, price, options)" },
  { label: "plot.label", type: "function", detail: "(name, time, price, options)" },
  { label: "plot.alert", type: "function", detail: "(name, price, direction)" },
  { label: "function draw(ctx, { ta, plot })", type: "keyword", detail: "脚本入口" }
];

function formatRelativeTime(time: number) {
  const delta = Math.max(0, Date.now() - time);
  if (delta < 1_000) return "刚刚";
  if (delta < 60_000) return `${Math.round(delta / 1_000)}秒前`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}分钟前`;
  return `${Math.round(delta / 3_600_000)}小时前`;
}
