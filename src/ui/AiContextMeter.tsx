import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, Database, Wrench, X } from "lucide-react";
import type { AiContextUsage } from "../types";

const DEFAULT_CONTEXT_WINDOW = 256_000;

function compact(value?: number) {
  if (!Number.isFinite(value)) return "--";
  const safe = Math.max(0, value as number);
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(safe >= 10_000_000 ? 0 : 1)}M`;
  if (safe >= 1_000) return `${(safe / 1_000).toFixed(safe >= 100_000 ? 0 : 1)}K`;
  return String(Math.round(safe));
}

export function AiContextMeter({ usage, uiText }: { usage?: AiContextUsage; uiText: (zh: string, en: string) => string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popoverId = useId();
  const usedTokens = Number.isFinite(usage?.usedTokens) ? Math.max(0, usage?.usedTokens ?? 0) : 0;
  const contextWindow = Number.isFinite(usage?.contextWindow) && (usage?.contextWindow ?? 0) > 0 ? usage?.contextWindow ?? DEFAULT_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW;
  const percentage = Math.min(100, Math.max(0, usedTokens / contextWindow * 100));
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const breakdown = usage?.breakdown;
  const rows = [
    [uiText("系统", "System"), breakdown?.systemTokens],
    [uiText("工具", "Tools"), breakdown?.toolsTokens],
    [uiText("对话", "Conversation"), breakdown?.conversationTokens]
  ] as const;
  return (
    <div className="ai-context-meter-wrap" ref={rootRef}>
      <button type="button" className="ai-context-meter-trigger" aria-expanded={open} aria-controls={popoverId} onClick={() => setOpen((value) => !value)} title={uiText("查看上下文构成", "View context composition")}>
        <span className="ai-context-meter-ring" aria-hidden="true"><i style={{ "--ai-context-progress": `${percentage ?? 0}%` } as CSSProperties} /></span>
        <span><b>{`${Math.round(percentage)}%`}</b><small>~{compact(usedTokens)} / {compact(contextWindow)}</small></span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div id={popoverId} className="ai-context-popover" role="dialog" aria-label={uiText("上下文使用", "Context usage")}>
          <header><strong>{uiText("上下文使用", "Context usage")}</strong><button type="button" onClick={() => setOpen(false)} aria-label={uiText("关闭", "Close")}><X size={13} /></button></header>
          <div className="ai-context-popover-total"><b>{`${Math.round(percentage)}%`}</b><span>~{compact(usedTokens)} / {compact(contextWindow)}</span></div>
           <div className="ai-context-popover-formula">{uiText("当前已使用 = 最近一次 Cline 模型请求的实际输入 token；进度 = 当前 token ÷ 模型上下文上限。", "Used = input tokens from the latest Cline model request; progress = used tokens ÷ model context limit.")}</div>
          <div className="ai-context-breakdown">
            {rows.map(([label, value], index) => <div key={label}><span>{index === 0 ? <Database size={13} /> : <Wrench size={13} />}{label}</span><strong>{compact(value)}</strong></div>)}
          </div>
          <small className="ai-context-popover-note">{breakdown ? uiText("分类为本地估算，不一定等于 provider 计费构成。", "Categories are local estimates and may not equal provider-billed composition.") : uiText("完成一次可测量模型调用后显示分类。", "Breakdown appears after a measurable model call.")}</small>
          <small className="ai-context-popover-source">{(usage?.contextWindowSource ?? "fallback") === "clineModelCatalog" ? uiText("容量：Cline 模型目录", "Capacity: Cline model catalog") : (usage?.contextWindowSource ?? "fallback") === "customModelConfig" ? uiText("容量：模型配置回退", "Capacity: model-config fallback") : uiText("容量：默认回退 256K", "Capacity: default fallback 256K")}</small>
          {percentage !== null && percentage >= 90 ? <small className="ai-context-popover-source">{uiText("下一次模型请求前将由 Cline 原生上下文压缩管线整理历史。", "Cline's native context pipeline will compact history before the next model request.")}</small> : null}
        </div>
      )}
    </div>
  );
}
