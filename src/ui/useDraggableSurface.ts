import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

const EDGE_GAP = 8;
const INTERACTIVE_SELECTOR = "button, input, select, textarea, a, [role='button'], [contenteditable='true']";

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  rect: DOMRect;
};

function clampSurfaceOffset(rect: DOMRect, originX: number, originY: number, deltaX: number, deltaY: number) {
  const minLeft = Math.min(EDGE_GAP, window.innerWidth - rect.width - EDGE_GAP);
  const maxLeft = Math.max(EDGE_GAP, window.innerWidth - rect.width - EDGE_GAP);
  const minTop = Math.min(EDGE_GAP, window.innerHeight - rect.height - EDGE_GAP);
  const maxTop = Math.max(EDGE_GAP, window.innerHeight - rect.height - EDGE_GAP);
  const left = Math.min(Math.max(rect.left + deltaX, minLeft), maxLeft);
  const top = Math.min(Math.max(rect.top + deltaY, minTop), maxTop);
  return {
    x: originX + left - rect.left,
    y: originY + top - rect.top
  };
}

export function useDraggableSurface<T extends HTMLElement>() {
  const surfaceRef = useRef<T | null>(null);
  const offsetRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<DragState | null>(null);

  const applyOffset = useCallback((x: number, y: number) => {
    const surface = surfaceRef.current;
    if (!surface) return;
    offsetRef.current = { x, y };
    surface.style.translate = `${Math.round(x)}px ${Math.round(y)}px`;
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest(INTERACTIVE_SELECTOR)) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offsetRef.current.x,
      originY: offsetRef.current.y,
      rect: surface.getBoundingClientRect()
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    surface.dataset.dragging = "true";
    event.preventDefault();
  }, []);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = clampSurfaceOffset(
      drag.rect,
      drag.originX,
      drag.originY,
      event.clientX - drag.startX,
      event.clientY - drag.startY
    );
    applyOffset(next.x, next.y);
  }, [applyOffset]);

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    surfaceRef.current?.removeAttribute("data-dragging");
  }, []);

  useEffect(() => {
    const clampToViewport = () => {
      const surface = surfaceRef.current;
      if (!surface) return;
      const rect = surface.getBoundingClientRect();
      const next = clampSurfaceOffset(rect, offsetRef.current.x, offsetRef.current.y, 0, 0);
      applyOffset(next.x, next.y);
    };
    window.addEventListener("resize", clampToViewport);
    return () => window.removeEventListener("resize", clampToViewport);
  }, [applyOffset]);

  return {
    surfaceRef,
    handleProps: {
      "data-drag-handle": "true",
      onPointerDown,
      onPointerMove,
      onPointerUp: finishDrag,
      onPointerCancel: finishDrag
    }
  } as const;
}
