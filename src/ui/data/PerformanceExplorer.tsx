import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import clsx from "clsx";
import { fetchPositionEpisodes } from "../../lib/okx";
import { logger } from "../../lib/logger";
import { buildReviewTrades, sourceLabel, type ReviewTrade, type TradeSource } from "../../lib/tradeReviewModel";
import {
  computeStats,
  cumulativeCurve,
  dailyCells,
  EMPTY_FILTERS,
  groupBy,
  isSingleDay,
  selectTrades,
  toggleDay,
  type Filters,
  type GroupRow,
  type TimeRange,
} from "../../lib/performanceExplorer";
import { fmtNumber, fmtSigned, formatDuration, tone, useElementWidth, useUiText, type UiText } from "./format";
import "./performance-explorer.css";

type Props = {
  account: { id: string; environment: string } | null;
  startTime: number | null;
  endTime: number | null;
  /** 工具栏选中的合约（空 = 全部）。 */
  symbol: string;
  refreshRevision: string;
  /** 打开单笔完整复盘（K 线、标签、笔记）。 */
  onOpenReview: (tradeId: string) => void;
};

const BINS = 110;
const EPISODE_LIMIT = 200;
const DAY = 86_400_000;
const LIST_CAP = 8;

// ───────────── 动画补间 ─────────────

const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function useTween(target: number, ms = 600): number {
  const [value, setValue] = useState(target);
  const valueRef = useRef(target);
  useEffect(() => {
    if (prefersReducedMotion() || valueRef.current === target) {
      valueRef.current = target;
      setValue(target);
      return;
    }
    const from = valueRef.current;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / ms);
      const next = from + (target - from) * (1 - Math.pow(1 - k, 3));
      valueRef.current = next;
      setValue(next);
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return value;
}

function useTweenArray(target: readonly number[], ms = 520): number[] {
  const [value, setValue] = useState<number[]>(() => [...target]);
  const valueRef = useRef<number[]>([...target]);
  useEffect(() => {
    const from = valueRef.current.length === target.length ? valueRef.current : [...target];
    if (prefersReducedMotion()) {
      valueRef.current = [...target];
      setValue([...target]);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      const next = target.map((v, i) => from[i] + (v - from[i]) * e);
      valueRef.current = next;
      setValue(next);
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return value;
}

function TweenNumber({ value, format }: { value: number; format: (v: number) => string }) {
  return <>{format(useTween(value, 520))}</>;
}

// ───────────── 小工具 ─────────────

const pad = (n: number) => String(n).padStart(2, "0");
const dayLabel = (t: number, uiText: UiText) => {
  const d = new Date(t);
  return uiText(`${d.getMonth() + 1}月${d.getDate()}日`, `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
};
const clockLabel = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const priceLabel = (v: number | null) => (v === null ? "--" : v >= 100 ? fmtNumber(v, 1) : fmtNumber(v, 4));
const signedClass = (v: number) => (v < 0 ? "is-neg" : v > 0 ? "is-pos" : "is-flat");

// ───────────── 主图 ─────────────

const CHART_H = 250;
const PAD = { l: 4, r: 4, t: 22, b: 26 };

type ChartProps = {
  window: TimeRange;
  mine: readonly number[];
  whole: readonly number[] | null;
  drawdown: boolean;
  time: TimeRange | null;
  onBrush: (range: TimeRange | null) => void;
  uiText: UiText;
};

function EquityChart({ window: span, mine, whole, drawdown, time, onBrush, uiText }: ChartProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const drag = useRef<{ x0: number; moved: boolean } | null>(null);
  const [note, setNote] = useState("");

  const geometry = useMemo(() => {
    const peak: number[] = [];
    let high = 0;
    for (const v of mine) {
      high = Math.max(high, v);
      peak.push(high);
    }
    const values = [0, ...mine, ...(whole ?? []), ...(drawdown ? peak : [])];
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    const margin = (hi - lo) * 0.12 || 10;
    lo -= margin;
    hi += margin;
    const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (CHART_H - PAD.t - PAD.b);
    return { lo, hi, ys: mine.map(y), wholeYs: (whole ?? mine).map(y), peakYs: peak.map(y), y0: y(0) };
  }, [mine, whole, drawdown]);

  const ys = useTweenArray(geometry.ys);
  const wholeYs = useTweenArray(geometry.wholeYs);
  const peakYs = useTweenArray(geometry.peakYs);
  const y0 = useTween(geometry.y0, 520);

  const plotW = Math.max(10, width - PAD.l - PAD.r);
  const xAt = (i: number) => PAD.l + ((i + 0.5) / BINS) * plotW;
  const xOfTime = (t: number) => PAD.l + ((t - span[0]) / Math.max(1, span[1] - span[0])) * plotW;
  const timeAt = (px: number) => span[0] + ((px - PAD.l) / plotW) * (span[1] - span[0]);
  const path = (arr: readonly number[]) => arr.map((v, i) => `${i ? "L" : "M"}${xAt(i).toFixed(1)} ${v.toFixed(1)}`).join(" ");

  if (width < 40) return <div className="pe-chart" ref={ref} style={{ height: CHART_H }} />;

  const net = mine[mine.length - 1] ?? 0;
  const color = net < 0 ? "var(--pe-loss)" : "var(--pe-gain)";
  const area = `${path(ys)} L${xAt(BINS - 1)} ${y0} L${xAt(0)} ${y0} Z`;
  const ddArea = drawdown ? `${path(peakYs)} ${ys.map((_, i) => `L${xAt(BINS - 1 - i).toFixed(1)} ${ys[BINS - 1 - i].toFixed(1)}`).join(" ")} Z` : "";
  const sel = time ? [xOfTime(Math.max(time[0], span[0])), xOfTime(Math.min(time[1], span[1]))] : null;
  const gridValues = [0, 1, 2, 3].map((k) => geometry.lo + ((geometry.hi - geometry.lo) * (k + 0.5)) / 4);
  const ticks = [0, 1, 2, 3, 4, 5].map((k) => span[0] + ((span[1] - span[0]) * k) / 5);

  const relX = (event: ReactPointerEvent<SVGSVGElement>) => event.clientX - event.currentTarget.getBoundingClientRect().left;
  const indexAt = (px: number) => Math.max(0, Math.min(BINS - 1, Math.round(((px - PAD.l) / plotW) * BINS - 0.5)));

  return (
    <div className="pe-chart" ref={ref} style={{ height: CHART_H }}>
      <div className="pe-readout">
        {note ||
          (hover !== null && (
            <>
              <b>{dayLabel(span[0] + ((hover + 1) / BINS) * (span[1] - span[0]), uiText)}</b>
              {"　"}
              {uiText("累计", "Cumulative")} <span className={signedClass(mine[hover])}>{fmtSigned(mine[hover])}</span> USDT
              {whole && <span className="pe-faint">{"　"}{uiText("整体", "All")} {fmtSigned(whole[hover])}</span>}
            </>
          ))}
      </div>
      <svg
        width={width}
        height={CHART_H}
        role="img"
        aria-label={uiText("累计净盈亏曲线，可拖动选择时间段", "Cumulative net PnL; drag to select a period")}
        onPointerDown={(event) => {
          drag.current = { x0: relX(event), moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const px = relX(event);
          const d = drag.current;
          if (d) {
            if (Math.abs(px - d.x0) > 4) d.moved = true;
            if (d.moved) {
              const a = Math.max(span[0], timeAt(Math.min(d.x0, px)));
              const b = Math.min(span[1], timeAt(Math.max(d.x0, px)));
              onBrush([a, b]);
              setNote(uiText(`${dayLabel(a, uiText)} → ${dayLabel(b, uiText)}　松开即可只看这一段`, `${dayLabel(a, uiText)} → ${dayLabel(b, uiText)}  release to focus`));
            }
            return;
          }
          setHover(indexAt(px));
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          setNote("");
          if (d && !d.moved) onBrush(null);
        }}
        onPointerLeave={() => {
          if (!drag.current) setHover(null);
        }}
      >
        <defs>
          <linearGradient id="pe-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.2" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {gridValues.map((v, k) => {
          const yy = PAD.t + (1 - (v - geometry.lo) / (geometry.hi - geometry.lo)) * (CHART_H - PAD.t - PAD.b);
          return (
            <g key={k}>
              <line className="pe-grid" x1={PAD.l} x2={width - PAD.r} y1={yy} y2={yy} />
              <text className="pe-axis" x={PAD.l + 2} y={yy - 5}>{fmtSigned(v, 0)}</text>
            </g>
          );
        })}
        {ticks.map((t, k) => (
          <text key={k} className="pe-axis" x={PAD.l + (plotW * k) / 5} y={CHART_H - 6} textAnchor={k === 0 ? "start" : k === 5 ? "end" : "middle"}>
            {pad(new Date(t).getMonth() + 1)}-{pad(new Date(t).getDate())}
          </text>
        ))}
        <line className="pe-zero" x1={PAD.l} x2={width - PAD.r} y1={y0} y2={y0} />
        {drawdown && <path d={ddArea} className="pe-dd" />}
        {whole && <path d={path(wholeYs)} className="pe-whole" />}
        <path d={area} fill="url(#pe-fill)" />
        <path d={path(ys)} className="pe-line" style={{ stroke: color }} />
        <circle cx={xAt(BINS - 1)} cy={ys[BINS - 1]} r="4" fill={color} />
        {sel && (
          <g>
            <rect className="pe-veil" x={PAD.l} y={PAD.t - 8} width={Math.max(0, sel[0] - PAD.l)} height={CHART_H - PAD.t - PAD.b + 8} />
            <rect className="pe-veil" x={sel[1]} y={PAD.t - 8} width={Math.max(0, width - PAD.r - sel[1])} height={CHART_H - PAD.t - PAD.b + 8} />
            <line className="pe-edge" x1={sel[0]} x2={sel[0]} y1={PAD.t - 8} y2={CHART_H - PAD.b} />
            <line className="pe-edge" x1={sel[1]} x2={sel[1]} y1={PAD.t - 8} y2={CHART_H - PAD.b} />
          </g>
        )}
        {hover !== null && !drag.current && (
          <g pointerEvents="none">
            <line className="pe-cross" x1={xAt(hover)} x2={xAt(hover)} y1={PAD.t - 8} y2={CHART_H - PAD.b} />
            <circle cx={xAt(hover)} cy={ys[hover]} r="4.5" className="pe-hover-dot" style={{ stroke: color }} />
          </g>
        )}
      </svg>
    </div>
  );
}

// ───────────── 来源 / 品种面板 ─────────────

function BarRows({ rows, selected, onToggle, label, uiText }: { rows: GroupRow[]; selected: ReadonlySet<string>; onToggle: (key: string) => void; label: (key: string) => string; uiText: UiText }) {
  const max = Math.max(1e-9, ...rows.map((row) => Math.abs(row.stats.net)));
  return (
    <div className="pe-rows">
      {rows.map(({ key, stats }) => {
        const on = selected.has(key);
        const w = (Math.abs(stats.net) / max) * 50;
        return (
          <button key={key} type="button" className={clsx("pe-row", on && "is-on", selected.size > 0 && !on && "is-dim")} onClick={() => onToggle(key)} aria-pressed={on}>
            <span className="pe-row-name">{label(key)}</span>
            <span className="pe-diverge" aria-hidden="true">
              <i className={signedClass(stats.net)} style={{ width: `${w}%`, left: `${stats.net >= 0 ? 50 : 50 - w}%` }} />
            </span>
            <strong className={signedClass(stats.net)}><TweenNumber value={stats.net} format={(v) => fmtSigned(v, 0)} /></strong>
            <small>{stats.count ? uiText(`${stats.count} 笔 · 胜率 ${Math.round(stats.winRate ?? 0)}%`, `${stats.count} · ${Math.round(stats.winRate ?? 0)}% win`) : uiText("没有交易", "No trades")}</small>
          </button>
        );
      })}
    </div>
  );
}

// ───────────── 日历 ─────────────

function Calendar({ trades, window: span, time, onPick, uiText }: { trades: readonly ReviewTrade[]; window: TimeRange; time: TimeRange | null; onPick: (start: number) => void; uiText: UiText }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ start: number; net: number | null } | null>(null);
  const cells = useMemo(() => dailyCells(trades, span), [trades, span]);
  const offset = cells.length ? (new Date(cells[0].start).getDay() + 6) % 7 : 0;
  const cols = Math.max(1, Math.ceil((cells.length + offset) / 7));
  const size = Math.max(10, Math.min(28, Math.floor((Math.max(width, 120) - 5 * (cols - 1)) / cols)));
  const maxAbs = Math.max(1e-9, ...cells.map((cell) => Math.abs(cell.net ?? 0)));
  const winDays = cells.filter((cell) => (cell.net ?? 0) > 0).length;
  const traded = cells.filter((cell) => cell.net !== null).length;
  const single = isSingleDay(time) ? time![0] : null;

  return (
    <div className="pe-cal" ref={ref}>
      <div className="pe-cal-note">{traded ? uiText(`${winDays}/${traded} 天盈利`, `${winDays}/${traded} winning days`) : ""}</div>
      <div className="pe-heat" style={{ gridTemplateColumns: `repeat(${cols}, ${size}px)`, gridTemplateRows: `repeat(7, ${size}px)` }}>
        {Array.from({ length: offset }, (_, i) => <span key={`o${i}`} />)}
        {cells.map((cell) => {
          const inSel = !time || (cell.start + DAY > time[0] && cell.start <= time[1]);
          return (
            <i
              key={cell.start}
              className={clsx(cell.net !== null && (cell.net < 0 ? "is-neg" : "is-pos"), !inSel && "is-off", single === cell.start && "is-on")}
              style={cell.net === null ? undefined : ({ "--a": (0.14 + (Math.abs(cell.net) / maxAbs) * 0.62).toFixed(2) } as React.CSSProperties)}
              onMouseEnter={() => setHover({ start: cell.start, net: cell.net })}
              onMouseLeave={() => setHover(null)}
              onClick={() => onPick(cell.start)}
            />
          );
        })}
      </div>
      <div className="pe-cal-read">
        {hover ? (
          <>
            <b>{dayLabel(hover.start, uiText)}</b>
            {"　"}
            {hover.net === null ? uiText("没有交易", "No trades") : <>{hover.net >= 0 ? uiText("赚了", "Made") : uiText("亏了", "Lost")} <span className={signedClass(hover.net)}>{fmtSigned(hover.net, 1)}</span></>}
          </>
        ) : (
          uiText("把鼠标放在某一天上，点一下只看那天", "Hover a day; click to focus on it")
        )}
      </div>
    </div>
  );
}

// ───────────── 明细 ─────────────

type SortKey = "new" | "win" | "lose";

function TradeList({ trades, onOpenReview, uiText }: { trades: readonly ReviewTrade[]; onOpenReview: (id: string) => void; uiText: UiText }) {
  const [sort, setSort] = useState<SortKey>("new");
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const sorted = useMemo(() => {
    const list = [...trades];
    list.sort(sort === "new" ? (a, b) => b.closeTime - a.closeTime : sort === "win" ? (a, b) => b.netPnl - a.netPnl : (a, b) => a.netPnl - b.netPnl);
    return list;
  }, [trades, sort]);
  const shown = all ? sorted : sorted.slice(0, LIST_CAP);
  const sorts: [SortKey, string][] = [["new", uiText("最新", "Latest")], ["win", uiText("最赚", "Best")], ["lose", uiText("最亏", "Worst")]];

  return (
    <section className="pe-list">
      <header>
        <h3>{uiText("交易明细", "Trades")}<span>{uiText(`${trades.length} 笔`, `${trades.length}`)}</span></h3>
        <div className="pe-seg" role="tablist">
          {sorts.map(([key, text]) => <button key={key} type="button" role="tab" aria-selected={sort === key} className={sort === key ? "is-on" : undefined} onClick={() => setSort(key)}>{text}</button>)}
        </div>
      </header>
      {shown.length === 0 ? (
        <div className="pe-empty">{uiText("这个组合下没有交易。试试摘掉一个筛选。", "No trades for this combination. Try removing a filter.")}</div>
      ) : (
        <div className="pe-table">
          {shown.map((trade) => (
            <div key={trade.id} className={clsx("pe-tr", open === trade.id && "is-open")}>
              <button type="button" className="pe-tr-main" onClick={() => setOpen(open === trade.id ? null : trade.id)} aria-expanded={open === trade.id}>
                <span>{clockLabel(trade.closeTime)}</span>
                <b>{trade.base}</b>
                <span className="pe-side">{trade.side === "long" ? uiText("多", "L") : uiText("空", "S")}</span>
                <span>{sourceLabel(trade.source, uiText)}</span>
                <span>{formatDuration(trade.holdMs, uiText)}</span>
                <strong className={signedClass(trade.netPnl)}>{fmtSigned(trade.netPnl, 1)}</strong>
              </button>
              {open === trade.id && (
                <div className="pe-detail">
                  <span>{uiText("开仓", "Entry")} {priceLabel(trade.entry)} → {uiText("平仓", "Exit")} {priceLabel(trade.exit)}</span>
                  <span>{uiText("杠杆", "Leverage")} {trade.leverage ? `${trade.leverage}x` : "--"}</span>
                  {trade.adds > 0 && <span>{uiText(`加仓 ${trade.adds} 次`, `${trade.adds} adds`)}</span>}
                  <span>{uiText("手续费", "Fees")} {fmtNumber(trade.fees)}</span>
                  <span>{uiText("资金费", "Funding")} {fmtSigned(trade.fundingFee)}</span>
                  <button type="button" className="pe-link" onClick={() => onOpenReview(trade.id)}>{uiText("在复盘里看 K 线、记标签 →", "Replay candles, tag it →")}</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {sorted.length > LIST_CAP && <button type="button" className="pe-more" onClick={() => setAll(!all)}>{all ? uiText("收起", "Collapse") : uiText(`显示全部 ${sorted.length} 笔`, `Show all ${sorted.length}`)}</button>}
    </section>
  );
}

// ───────────── 入口 ─────────────

const SOURCE_ORDER: TradeSource[] = ["manual", "ai", "strategy", "mixed", "system", "exchange", "unknown"];

export function PerformanceExplorer({ account, startTime, endTime, symbol, refreshRevision, onOpenReview }: Props) {
  const uiText = useUiText();
  const accountId = account?.id ?? "";
  const [trades, setTrades] = useState<ReviewTrade[] | null>(null);
  const [episodeCount, setEpisodeCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [showWhole, setShowWhole] = useState(true);
  const [drawdown, setDrawdown] = useState(false);
  const [loadedAt, setLoadedAt] = useState(() => Date.now());

  useEffect(() => {
    if (!accountId) return;
    let active = true;
    setLoading(true);
    setError("");
    void fetchPositionEpisodes({ accountId, limit: EPISODE_LIMIT })
      .then((list) => {
        if (!active) return;
        setEpisodeCount((list ?? []).length);
        setTrades(buildReviewTrades(list ?? []));
        setLoadedAt(Date.now());
      })
      .catch((reason) => {
        logger.error("load performance explorer failed", reason);
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [accountId, refreshRevision]);

  // 工具栏的合约、时间范围换了，面板内的筛选一并清空，避免带着旧条件看新范围。
  useEffect(() => setFilters(EMPTY_FILTERS), [startTime, endTime, symbol, accountId]);

  const pool = useMemo(() => (trades ?? []).filter((trade) => !symbol || trade.instId === symbol), [trades, symbol]);
  const window = useMemo<TimeRange>(() => {
    const end = endTime ?? loadedAt;
    const earliest = pool.reduce((min, trade) => Math.min(min, trade.closeTime), Infinity);
    const start = startTime ?? (Number.isFinite(earliest) ? earliest : end - 30 * DAY);
    return [start, Math.max(end, start + DAY)];
  }, [startTime, endTime, pool, loadedAt]);

  const filtered = filters.sources.size > 0 || filters.symbols.size > 0 || filters.time !== null;
  const view = useMemo(() => selectTrades(pool, window, filters), [pool, window, filters]);
  const overall = useMemo(() => selectTrades(pool, window, filters, ["source", "symbol", "time"]), [pool, window, filters]);
  const heatTrades = useMemo(() => selectTrades(pool, window, filters, ["time"]), [pool, window, filters]);
  const stats = useMemo(() => computeStats(view), [view]);
  const overallStats = useMemo(() => computeStats(overall), [overall]);
  const mine = useMemo(() => cumulativeCurve(selectTrades(pool, window, filters, ["time"]), window, BINS), [pool, window, filters]);
  const whole = useMemo(() => (filtered && showWhole ? cumulativeCurve(overall, window, BINS) : null), [filtered, showWhole, overall, window]);

  // 来源 / 品种行的顺序按「未筛选时的笔数」固定，筛选时只变长度不乱序。
  const sourceRows = useMemo(() => {
    const rows = groupBy(pool, window, filters, "source");
    return rows.sort((a, b) => SOURCE_ORDER.indexOf(a.key as TradeSource) - SOURCE_ORDER.indexOf(b.key as TradeSource));
  }, [pool, window, filters]);
  const symbolOrder = useMemo(() => {
    const counts = new Map<string, number>();
    for (const trade of selectTrades(pool, window, EMPTY_FILTERS)) counts.set(trade.base, (counts.get(trade.base) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  }, [pool, window]);
  const symbolRows = useMemo(() => {
    const rows = groupBy(pool, window, filters, "symbol");
    const rank = (key: string) => { const i = symbolOrder.indexOf(key); return i < 0 ? 999 : i; };
    return rows.sort((a, b) => rank(a.key) - rank(b.key)).slice(0, 10);
  }, [pool, window, filters, symbolOrder]);

  const toggle = <K extends "sources" | "symbols">(field: K, key: string) =>
    setFilters((current) => {
      const next = new Set(current[field] as ReadonlySet<string>);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...current, [field]: next } as Filters;
    });

  useEffect(() => {
    if (!filtered) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) setFilters(EMPTY_FILTERS);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [filtered]);

  const net = stats.net;
  const truncated = episodeCount >= EPISODE_LIMIT && trades !== null && trades.length > 0 && Math.min(...trades.map((t) => t.closeTime)) > window[0];

  // 一句话：范围 + 笔数 + 盈亏 + 胜率；有筛选时和整体对照
  const scope: string[] = [];
  scope.push(filters.time ? `${dayLabel(filters.time[0], uiText)}${isSingleDay(filters.time) ? "" : ` → ${dayLabel(filters.time[1], uiText)}`}` : uiText(`这 ${Math.max(1, Math.round((window[1] - window[0]) / DAY))} 天`, `Last ${Math.max(1, Math.round((window[1] - window[0]) / DAY))} d`));
  for (const key of filters.sources) scope.push(sourceLabel(key as TradeSource, uiText));
  for (const key of filters.symbols) scope.push(key);
  const compare = filtered ? uiText(`整体账户同期 ${fmtSigned(overallStats.net, 0)}。`, `Whole account over the same range: ${fmtSigned(overallStats.net, 0)}.`) : "";

  if (!accountId) return <div className="pe pe-state">{uiText("先选择一个账户", "Select an account first")}</div>;
  if (error) return <div className="pe pe-state">{error}</div>;
  if (trades === null) return <div className="pe pe-state">{loading ? uiText("正在读取交易…", "Loading trades…") : ""}</div>;
  if (pool.length === 0) return <div className="pe pe-state">{uiText("还没有已平仓的交易。同步历史后这里会出现你的战绩。", "No closed trades yet. They appear after a history sync.")}</div>;

  const metrics: [string, string][] = [
    [uiText("交易笔数", "Trades"), fmtNumber(stats.count, 0)],
    [uiText("胜率", "Win rate"), stats.winRate === null ? "--" : `${Math.round(stats.winRate)}%`],
    [uiText("盈亏比", "Profit factor"), stats.profitFactor === null ? "--" : stats.profitFactor.toFixed(2)],
    [uiText("平均持仓", "Avg hold"), stats.avgHoldMs === null ? "--" : formatDuration(stats.avgHoldMs, uiText)],
    [uiText("最大回撤", "Max drawdown"), stats.maxDrawdown < 0.5 ? "0" : `−${fmtNumber(stats.maxDrawdown, 0)}`],
  ];

  return (
    <div className={clsx("pe", `is-${tone(net)}`)}>
      <div className="pe-bar">
        <div className="pe-pills">
          {[...filters.sources].map((key) => <span key={`s${key}`} className="pe-pill">{uiText("来源", "Source")} <b>{sourceLabel(key, uiText)}</b><button type="button" aria-label={uiText("摘掉", "Remove")} onClick={() => toggle("sources", key)}>×</button></span>)}
          {[...filters.symbols].map((key) => <span key={`y${key}`} className="pe-pill">{uiText("品种", "Instrument")} <b>{key}</b><button type="button" aria-label={uiText("摘掉", "Remove")} onClick={() => toggle("symbols", key)}>×</button></span>)}
          {filters.time && <span className="pe-pill">{uiText("时间", "Time")} <b>{dayLabel(filters.time[0], uiText)}{isSingleDay(filters.time) ? "" : ` → ${dayLabel(filters.time[1], uiText)}`}</b><button type="button" aria-label={uiText("摘掉", "Remove")} onClick={() => setFilters((c) => ({ ...c, time: null }))}>×</button></span>}
        </div>
        {filtered ? <button type="button" className="pe-clear" onClick={() => setFilters(EMPTY_FILTERS)}>{uiText("清除筛选 · Esc", "Clear · Esc")}</button> : <span className="pe-tip">{uiText("点下面的来源、品种、日期，或在曲线上拖一段", "Click a source, instrument or day below — or drag on the curve")}</span>}
      </div>

      <section className="pe-hero">
        <div className="pe-num"><TweenNumber value={net} format={(v) => fmtSigned(v, 0)} /><small>USDT</small></div>
        <p className="pe-say">
          {stats.count ? (
            <>
              {scope.join(" · ")}：{uiText(`${stats.count} 笔交易，${net >= 0 ? "赚了" : "亏了"} `, `${stats.count} trades, ${net >= 0 ? "made " : "lost "}`)}
              <em className={signedClass(net)}>{fmtSigned(net, 0)} USDT</em>
              {uiText(`，胜率 ${Math.round(stats.winRate ?? 0)}%。`, `, ${Math.round(stats.winRate ?? 0)}% win rate.`)}
            </>
          ) : (
            <>{scope.join(" · ")}：{uiText("没有交易。", "no trades.")}</>
          )}
          <span>{stats.count ? compare : uiText("试试摘掉一个筛选。", "Try removing a filter.")}</span>
        </p>
      </section>

      <dl className="pe-metrics">
        {metrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>

      <section className="pe-chart-wrap">
        <div className="pe-tools">
          {filtered && <button type="button" className={clsx("pe-tog", showWhole && "is-on")} aria-pressed={showWhole} onClick={() => setShowWhole(!showWhole)}>{uiText("对照整体", "Compare to all")}</button>}
          <button type="button" className={clsx("pe-tog", drawdown && "is-on")} aria-pressed={drawdown} onClick={() => setDrawdown(!drawdown)}>{uiText("回撤", "Drawdown")}</button>
        </div>
        <EquityChart
          window={window}
          mine={mine}
          whole={whole}
          drawdown={drawdown}
          time={filters.time}
          uiText={uiText}
          onBrush={(range) => setFilters((current) => (current.time === null && range === null ? current : { ...current, time: range }))}
        />
      </section>

      <section className="pe-panels">
        <div>
          <h3>{uiText("来源", "Source")}<span>{uiText("点一下只看它", "Click to focus")}</span></h3>
          <BarRows rows={sourceRows} selected={filters.sources} onToggle={(key) => toggle("sources", key)} label={(key) => sourceLabel(key as TradeSource, uiText)} uiText={uiText} />
        </div>
        <div>
          <h3>{uiText("品种", "Instrument")}<span>{uiText("可多选", "Multi-select")}</span></h3>
          <BarRows rows={symbolRows} selected={filters.symbols} onToggle={(key) => toggle("symbols", key)} label={(key) => key} uiText={uiText} />
        </div>
        <div>
          <h3>{uiText("日历", "Calendar")}</h3>
          <Calendar trades={heatTrades} window={window} time={filters.time} onPick={(start) => setFilters((c) => ({ ...c, time: toggleDay(c.time, start) }))} uiText={uiText} />
        </div>
      </section>

      <TradeList trades={view} onOpenReview={onOpenReview} uiText={uiText} />
      {truncated && <p className="pe-foot">{uiText(`只读取了最近 ${EPISODE_LIMIT} 笔已平仓位，更早的没有计入。把范围缩小一点可以看到完整数据。`, `Only the latest ${EPISODE_LIMIT} closed positions are loaded; older ones are not counted. Narrow the range for a complete view.`)}</p>}
    </div>
  );
}
