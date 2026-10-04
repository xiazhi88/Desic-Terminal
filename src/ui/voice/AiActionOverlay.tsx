import clsx from "clsx";

export type AiOperation = { phase: "running" | "done"; label: string; changed: boolean; canUndo: boolean };

type Props = {
  operation: AiOperation | null;
  uiText: (zh: string, en: string) => string;
  onUndo: () => void;
  onDismiss: () => void;
};

/**
 * AI 通过 ui.* 工具改界面时的全屏提示：边缘流光 + 暗角把注意力拉到「AI 正在操作」，顶部一枚胶囊说明在做什么。
 * 与语音伙伴是否开启无关；整层不拦截鼠标，只有胶囊上的按钮可点。
 */
export function AiActionOverlay({ operation, uiText, onUndo, onDismiss }: Props) {
  const active = operation !== null;
  const running = operation?.phase === "running";
  return (
    <div className={clsx("ai-glow", active && "is-on", running && "is-running")} aria-hidden={!active}>
      <div className="ai-glow-vignette" />
      <div className="ai-glow-edge" />
      <div className="ai-glow-pill" role="status" aria-live="polite">
        <span className={clsx("ai-glow-dot", !running && "is-done")} aria-hidden="true" />
        <span className="ai-glow-text">
          <b>{running ? uiText("AI 正在操作界面", "AI is adjusting the view") : operation?.changed ? uiText("AI 已调整界面", "AI adjusted the view") : uiText("界面已经是这样了", "Already like that")}</b>
          <small>{operation?.label}</small>
        </span>
        {!running && operation?.changed && operation.canUndo && (
          <button type="button" className="ai-glow-btn" onClick={onUndo}>{uiText("撤销", "Undo")}</button>
        )}
        {!running && (
          <button type="button" className="ai-glow-x" onClick={onDismiss} aria-label={uiText("关闭", "Dismiss")}>×</button>
        )}
      </div>
    </div>
  );
}
