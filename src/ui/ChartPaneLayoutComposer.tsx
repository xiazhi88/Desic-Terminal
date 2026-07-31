import { GripVertical, PanelLeftClose, PanelTopClose } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  defaultChartPaneLayoutSizing,
  type ChartPaneLayoutSizing,
} from "../lib/chartLayoutTemplates";
import {
  selectChartWorkspacePane,
  swapChartWorkspacePanes,
  type ChartWorkspaceDocument,
  type ChartWorkspacePane,
} from "../lib/chartWorkspace";
import "./ChartWorkspaceTemplates.css";

type ResizeAxis = "columnRatio" | "rowRatio";

export type ChartPaneLayoutComposerProps = {
  document: ChartWorkspaceDocument;
  sizing?: ChartPaneLayoutSizing;
  disabled?: boolean;
  onDocumentChange: (document: ChartWorkspaceDocument) => void;
  onSizingChange?: (sizing: ChartPaneLayoutSizing) => void;
  onDetachPane?: (paneId: string) => void;
  renderPane: (pane: ChartWorkspacePane, index: number) => ReactNode;
};

function clampRatio(value: number) {
  return Math.max(0.2, Math.min(0.8, value));
}

/**
 * Renderer-independent 1/2/4 chart pane arrangement. Drag handles exchange
 * pane content; split handles resize the visual grid and can also be operated
 * with the keyboard.
 */
export function ChartPaneLayoutComposer({
  document,
  sizing = defaultChartPaneLayoutSizing(),
  disabled = false,
  onDocumentChange,
  onSizingChange,
  onDetachPane,
  renderPane,
}: ChartPaneLayoutComposerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [draggingPaneId, setDraggingPaneId] = useState<string | null>(null);
  const [dropTargetPaneId, setDropTargetPaneId] = useState<string | null>(null);
  const pointerDragPaneIdRef = useRef<string | null>(null);
  const pointerDragStartedRef = useRef(false);
  const [resizingAxis, setResizingAxis] = useState<ResizeAxis | null>(null);
  const activePaneId = document.activePaneId;

  const gridStyle = useMemo((): CSSProperties => {
    if (document.layout === 2) {
      return document.layoutOrientation === "vertical"
        ? { gridTemplateRows: `minmax(0, ${sizing.rowRatio}fr) minmax(0, ${1 - sizing.rowRatio}fr)` }
        : { gridTemplateColumns: `minmax(0, ${sizing.columnRatio}fr) minmax(0, ${1 - sizing.columnRatio}fr)` };
    }
    if (document.layout === 3 || document.layout === 4) {
      return {
        gridTemplateColumns: `minmax(0, ${sizing.columnRatio}fr) minmax(0, ${1 - sizing.columnRatio}fr)`,
        gridTemplateRows: `minmax(0, ${sizing.rowRatio}fr) minmax(0, ${1 - sizing.rowRatio}fr)`,
      };
    }
    return {};
  }, [document.layout, document.layoutOrientation, sizing.columnRatio, sizing.rowRatio]);

  useEffect(() => {
    if (!resizingAxis) return;
    const onMove = (event: PointerEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const raw = resizingAxis === "columnRatio"
        ? (event.clientX - rect.left) / Math.max(rect.width, 1)
        : (event.clientY - rect.top) / Math.max(rect.height, 1);
      onSizingChange?.({ ...sizing, [resizingAxis]: clampRatio(raw) });
    };
    const onUp = () => setResizingAxis(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [onSizingChange, resizingAxis, sizing]);

  const beginResize = (axis: ResizeAxis) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled || !onSizingChange) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setResizingAxis(axis);
  };

  const nudgeResize = (axis: ResizeAxis, direction: -1 | 1) => {
    if (disabled || !onSizingChange) return;
    onSizingChange({ ...sizing, [axis]: clampRatio(sizing[axis] + direction * 0.025) });
  };

  const finishPointerPaneDrag = (event: PointerEvent) => {
    const sourcePaneId = pointerDragPaneIdRef.current;
    pointerDragPaneIdRef.current = null;
    const started = pointerDragStartedRef.current;
    pointerDragStartedRef.current = false;
    setDraggingPaneId(null);
    setDropTargetPaneId(null);
    if (!started || disabled || !sourcePaneId) return;
    const target = globalThis.document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-chart-pane-id]");
    const targetPaneId = target?.dataset.chartPaneId;
    if (targetPaneId && targetPaneId !== sourcePaneId) {
      onDocumentChange(swapChartWorkspacePanes(document, sourcePaneId, targetPaneId));
      return;
    }
    const bounds = containerRef.current?.getBoundingClientRect();
    const releasedOutsideWorkspace = !bounds
      || event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom;
    if (releasedOutsideWorkspace) onDetachPane?.(sourcePaneId);
  };

  const beginPointerPaneDrag = (event: ReactPointerEvent<HTMLElement>, paneId: string) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    pointerDragPaneIdRef.current = paneId;
    pointerDragStartedRef.current = false;
    const origin = { x: event.clientX, y: event.clientY };
    const onMove = (moveEvent: PointerEvent) => {
      if (!pointerDragPaneIdRef.current) return;
      if (!pointerDragStartedRef.current && Math.hypot(moveEvent.clientX - origin.x, moveEvent.clientY - origin.y) < 8) return;
      pointerDragStartedRef.current = true;
      setDraggingPaneId(paneId);
      const target = globalThis.document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest<HTMLElement>("[data-chart-pane-id]");
      const targetPaneId = target?.dataset.chartPaneId;
      setDropTargetPaneId(targetPaneId && targetPaneId !== paneId ? targetPaneId : null);
    };
    const onUp = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      globalThis.document.removeEventListener("pointerout", onDocumentLeave);
      finishPointerPaneDrag(upEvent);
    };
    const onDocumentLeave = (leaveEvent: PointerEvent) => {
      if (leaveEvent.relatedTarget !== null || !pointerDragPaneIdRef.current || !pointerDragStartedRef.current) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      globalThis.document.removeEventListener("pointerout", onDocumentLeave);
      const detachedPaneId = pointerDragPaneIdRef.current;
      pointerDragPaneIdRef.current = null;
      pointerDragStartedRef.current = false;
      setDraggingPaneId(null);
      setDropTargetPaneId(null);
      onDetachPane?.(detachedPaneId);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    globalThis.document.addEventListener("pointerout", onDocumentLeave);
  };

  return (
    <div
      ref={containerRef}
      className={`chart-pane-layout-composer layout-${document.layout}${document.layout === 2 ? ` layout-2-${document.layoutOrientation}` : ""}${draggingPaneId ? " is-dragging" : ""}`}
      style={gridStyle}
      aria-label={`${document.layout} 图布局`}
    >
      {document.panes.map((pane, index) => (
        <section
          key={pane.id}
          data-chart-pane-id={pane.id}
          className={`chart-pane-layout-composer__slot${pane.id === activePaneId ? " is-active" : ""}${draggingPaneId === pane.id ? " is-drag-source" : ""}${dropTargetPaneId === pane.id ? " is-drag-target" : ""}`}
          onMouseDown={() => onDocumentChange(selectChartWorkspacePane(document, pane.id))}
        >
          <header
            className="chart-pane-layout-composer__slot-header"
            onPointerDown={(event) => {
              if ((event.target as HTMLElement).closest("button, input, select, label")) return;
              beginPointerPaneDrag(event, pane.id);
            }}
            title="拖动整个标题栏到另一张图以交换位置"
          >
            <span className="chart-pane-layout-composer__slot-title">图表 {index + 1} <em>{pane.timeframe}</em></span>
            <div className="chart-pane-layout-composer__slot-actions" id={`chart-pane-header-actions-${pane.id}`} />
            <button
              type="button"
              className="chart-pane-layout-composer__drag-handle"
              disabled={disabled}
              onPointerDown={(event) => beginPointerPaneDrag(event, pane.id)}
              title="拖动到另一个窗格以交换图表"
              aria-label={`拖动图表 ${index + 1} 以交换位置`}
            >
              <GripVertical size={14} />
            </button>
          </header>
          <div className="chart-pane-layout-composer__content">{renderPane(pane, index)}</div>
        </section>
      ))}

      {(document.layout === 2 && document.layoutOrientation === "horizontal") || document.layout >= 3 ? (
        <button
          type="button"
          className="chart-pane-layout-composer__split chart-pane-layout-composer__split--vertical"
          disabled={disabled || !onSizingChange}
          aria-label="调整图表列宽"
          aria-valuemin={20}
          aria-valuemax={80}
          aria-valuenow={Math.round(sizing.columnRatio * 100)}
          role="separator"
          onPointerDown={beginResize("columnRatio")}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") { event.preventDefault(); nudgeResize("columnRatio", -1); }
            if (event.key === "ArrowRight") { event.preventDefault(); nudgeResize("columnRatio", 1); }
          }}
          style={{ left: `${sizing.columnRatio * 100}%` }}
          title="拖动或使用左右方向键调整列宽"
        ><PanelLeftClose size={12} /></button>
      ) : null}
      {(document.layout === 2 && document.layoutOrientation === "vertical") || document.layout >= 3 ? (
        <button
          type="button"
          className={`chart-pane-layout-composer__split chart-pane-layout-composer__split--horizontal${document.layout === 3 ? " chart-pane-layout-composer__split--right-column" : ""}`}
          disabled={disabled || !onSizingChange}
          aria-label="调整图表行高"
          aria-valuemin={20}
          aria-valuemax={80}
          aria-valuenow={Math.round(sizing.rowRatio * 100)}
          role="separator"
          onPointerDown={beginResize("rowRatio")}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") { event.preventDefault(); nudgeResize("rowRatio", -1); }
            if (event.key === "ArrowDown") { event.preventDefault(); nudgeResize("rowRatio", 1); }
          }}
          style={{
            top: `${sizing.rowRatio * 100}%`,
            ...(document.layout === 3 ? { "--chart-column-start": `${sizing.columnRatio * 100}%` } as CSSProperties : {}),
          }}
          title="拖动或使用上下方向键调整行高"
        ><PanelTopClose size={12} /></button>
      ) : null}
    </div>
  );
}
