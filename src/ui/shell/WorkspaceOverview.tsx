import { useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { useMarketHotStore } from "../../lib/marketHotStore";

// ⌘. 总览：所有工作区一屏排开。除 AI 研究外的工作区在不激活时会卸载，
// 所以磁贴画的是轻量实时摘要（真实数据或如实的说明），不是缩小的真页面。

export type OverviewTile = {
  id: string;
  title: string;
  icon: ReactNode;
  status?: string;
  statusTone?: "live" | "ai" | "warn" | "muted";
  body: ReactNode;
};

type Props = {
  open: boolean;
  current: string;
  tiles: OverviewTile[];
  title: string;
  hint: string;
  onSelect: (id: string) => void;
  onClose: () => void;
};

export function WorkspaceOverview({ open, current, tiles, title, hint, onSelect, onClose }: Props) {
  const [focused, setFocused] = useState(0);
  const gridRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const index = Math.max(0, tiles.findIndex((tile) => tile.id === current));
    setFocused(index);
    window.requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>(`[data-overview-index="${index}"]`)?.focus());
    // 只在打开时定位到当前工作区，打开期间切换焦点不重置。
  }, [open]);

  if (!open) return null;
  const columns = 3;
  const move = (delta: number) => {
    const next = Math.max(0, Math.min(tiles.length - 1, focused + delta));
    setFocused(next);
    gridRef.current?.querySelector<HTMLElement>(`[data-overview-index="${next}"]`)?.focus();
  };

  return (
    <div
      className="workspace-overview"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          move(1);
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          move(-1);
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          move(columns);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          move(-columns);
        } else if (/^[1-9]$/.test(event.key) && !event.metaKey && !event.ctrlKey) {
          const tile = tiles[Number(event.key) - 1];
          if (tile) {
            event.preventDefault();
            onSelect(tile.id);
          }
        }
      }}
    >
      <header className="workspace-overview__head">
        <strong>{title}</strong>
        <span>{hint}</span>
      </header>
      <div className="workspace-overview__grid" ref={gridRef}>
        {tiles.map((tile, index) => (
          <button
            key={tile.id}
            type="button"
            data-overview-index={index}
            className={clsx("workspace-overview__tile", tile.id === current && "is-current")}
            style={{ animationDelay: `${index * 28}ms` }}
            onFocus={() => setFocused(index)}
            onClick={() => onSelect(tile.id)}
          >
            <span className="workspace-overview__tile-head">
              <span className="workspace-overview__tile-icon" aria-hidden="true">{tile.icon}</span>
              <span className="workspace-overview__tile-title">{tile.title}</span>
              {tile.status ? <span className={clsx("workspace-overview__status", tile.statusTone && `is-${tile.statusTone}`)}>{tile.status}</span> : null}
              <kbd>{index + 1}</kbd>
            </span>
            <span className="workspace-overview__tile-body">{tile.body}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** 交易磁贴：当前合约最近 K 线的收盘价折线（来自同一个行情热数据源）。 */
export function OverviewSparkline({ symbol }: { symbol: string }) {
  const candles = useMarketHotStore((state) => state.candles);
  const last = useMarketHotStore((state) => (state.ticker?.instId === symbol ? state.ticker.last : null));
  const closes = candles.slice(-80).map((candle) => candle.close).filter(Number.isFinite);
  if (closes.length < 2) return <span className="workspace-overview__muted">--</span>;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const points = closes.map((value, index) => `${(index / (closes.length - 1)) * 100},${36 - ((value - min) / span) * 32}`).join(" ");
  const up = closes.at(-1)! >= closes[0]!;
  return (
    <span className="workspace-overview__spark">
      <strong className={up ? "up" : "down"}>{last ?? closes.at(-1)!.toLocaleString("en-US")}</strong>
      <svg viewBox="0 0 100 38" preserveAspectRatio="none" aria-hidden="true">
        <polyline points={points} className={up ? "is-up" : "is-down"} />
      </svg>
    </span>
  );
}
