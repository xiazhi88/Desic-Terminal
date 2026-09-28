import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { OrderBook } from "../../types";
import { orderBookWallsFor } from "../../lib/orderBookWalls";
import "./orderflow.css";

type UiText = (english: string, chinese: string) => string;

const HALF_BUCKETS = 64;
const IMBALANCE_BAND = 0.003;

/** 最近一次绘制的几何与分桶结果：悬停读数与点击取价都从这里查，不重新遍历盘口。 */
type ProfileFrame = {
  book: OrderBook;
  midPrice: number;
  bucket: number;
  center: number;
  asks: Float64Array;
  bids: Float64Array;
  askTotal: number;
  bidTotal: number;
  midY: number;
  rowHeight: number;
  width: number;
};

type HoverRow = { side: "ask" | "bid"; offset: number };

type HoverReadout = {
  side: "ask" | "bid";
  low: number;
  high: number;
  size: number;
  cumulative: number;
  cumulativeShare: number;
  distancePct: number;
  wallMinutes: number | null;
  wallSeconds: number | null;
  top: number;
};

function priceDigits(bucket: number) {
  if (bucket >= 1) return 1;
  return Math.min(8, Math.max(2, Math.ceil(-Math.log10(bucket)) + 1));
}

function compactSize(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString("en-US", { maximumFractionDigits: value >= 100 ? 0 : 2 });
}

function compactUsd(value: number) {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

// 镜像深度剖面：以中间价为轴，卖盘在上、买盘在下；横向为对数挂单量，实线为逐档，虚线为累计。
// 数据是当前交易对完整的 400 档快照（在盘口列表截断到 40 档之前旁路），不做插值。
// 悬停读出该档价格区间、挂单量、到中间价的累计深度与距离；点击把该档内挂单最多的价位填入下单价。
export function DepthProfile({ instId, text, contractValue, onPriceSelect }: {
  instId: string;
  text: UiText;
  /** 合约面值（ctVal）：提供时把张数换算为名义价值。 */
  contractValue?: number;
  onPriceSelect?: (price: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<ProfileFrame | null>(null);
  const hoverRef = useRef<HoverRow | null>(null);
  const scheduleRef = useRef<() => void>(() => undefined);
  const [imbalance, setImbalance] = useState<{ bid: number; ask: number } | null>(null);
  const [mid, setMid] = useState<string>("--");
  const [readout, setReadout] = useState<HoverReadout | null>(null);

  const trackerInstId = instId;

  useEffect(() => {
    let frame: number | null = null;
    const tracker = orderBookWallsFor(trackerInstId);
    const draw = () => {
      frame = null;
      const canvas = canvasRef.current;
      const book = tracker.latestBook;
      if (!canvas || !book || tracker.bucket <= 0) return;
      const bestBid = Number(book.bids[0]?.px);
      const bestAsk = Number(book.asks[0]?.px);
      if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return;
      const midPrice = (bestBid + bestAsk) / 2;
      const bucket = tracker.bucket;
      const center = Math.floor(midPrice / bucket);
      const asks = new Float64Array(HALF_BUCKETS);
      const bids = new Float64Array(HALF_BUCKETS);
      let bandBid = 0;
      let bandAsk = 0;
      let askTotal = 0;
      let bidTotal = 0;
      for (const level of book.asks) {
        const price = Number(level.px);
        const size = Number(level.sz) || 0;
        askTotal += size;
        const offset = Math.floor(price / bucket) - center;
        if (offset >= 0 && offset < HALF_BUCKETS) asks[offset]! += size;
        if (price <= midPrice * (1 + IMBALANCE_BAND)) bandAsk += size;
      }
      for (const level of book.bids) {
        const price = Number(level.px);
        const size = Number(level.sz) || 0;
        bidTotal += size;
        const offset = center - Math.floor(price / bucket);
        if (offset >= 0 && offset < HALF_BUCKETS) bids[offset]! += size;
        if (price >= midPrice * (1 - IMBALANCE_BAND)) bandBid += size;
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w = rect.width;
      const h = rect.height;
      context.clearRect(0, 0, w, h);
      const midY = h / 2;
      const rowHeight = midY / HALF_BUCKETS;
      frameRef.current = { book, midPrice, bucket, center, asks, bids, askTotal, bidTotal, midY, rowHeight, width: w };
      let maxLog = 0;
      for (let index = 0; index < HALF_BUCKETS; index += 1) maxLog = Math.max(maxLog, Math.log1p(asks[index]!), Math.log1p(bids[index]!));
      const xOf = (size: number) => (maxLog > 0 ? (Math.log1p(size) / maxLog) * (w - 8) : 0);
      const drawSide = (values: Float64Array, direction: -1 | 1, rgb: string) => {
        context.beginPath();
        context.moveTo(0, midY);
        for (let index = 0; index < HALF_BUCKETS; index += 1) {
          const y = midY + direction * (index + 0.5) * rowHeight;
          context.lineTo(xOf(values[index]!), y);
        }
        context.lineTo(0, midY + direction * midY);
        context.closePath();
        context.fillStyle = `rgba(${rgb}, 0.14)`;
        context.fill();
        context.beginPath();
        for (let index = 0; index < HALF_BUCKETS; index += 1) {
          const y = midY + direction * (index + 0.5) * rowHeight;
          if (index === 0) context.moveTo(xOf(values[index]!), y);
          else context.lineTo(xOf(values[index]!), y);
        }
        context.strokeStyle = `rgba(${rgb}, 0.9)`;
        context.lineWidth = 1;
        context.stroke();
        let total = 0;
        const cumulative = Array.from(values, (value) => (total += value));
        const maxCumulative = Math.log1p(total);
        context.beginPath();
        cumulative.forEach((value, index) => {
          const x = maxCumulative > 0 ? (Math.log1p(value) / maxCumulative) * (w - 8) : 0;
          const y = midY + direction * (index + 0.5) * rowHeight;
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        });
        context.setLineDash([3, 3]);
        context.strokeStyle = `rgba(${rgb}, 0.5)`;
        context.stroke();
        context.setLineDash([]);
      };
      drawSide(asks, -1, "246, 70, 93");
      drawSide(bids, 1, "14, 203, 129");
      context.strokeStyle = "rgba(240, 240, 248, 0.7)";
      context.beginPath();
      context.moveTo(0, midY);
      context.lineTo(w, midY);
      context.stroke();
      // 悬停档位：整档高亮 + 横贯的细线（与主图十字光标同样的中性色）。
      const hover = hoverRef.current;
      if (hover) {
        const direction = hover.side === "ask" ? -1 : 1;
        const bandTop = direction < 0 ? midY - (hover.offset + 1) * rowHeight : midY + hover.offset * rowHeight;
        context.fillStyle = "rgba(240, 240, 248, 0.08)";
        context.fillRect(0, bandTop, w, Math.max(1, rowHeight));
        const lineY = Math.round(bandTop + rowHeight / 2) + 0.5;
        context.strokeStyle = "rgba(240, 240, 248, 0.55)";
        context.setLineDash([4, 3]);
        context.beginPath();
        context.moveTo(0, lineY);
        context.lineTo(w, lineY);
        context.stroke();
        context.setLineDash([]);
      }
      setMid(midPrice.toLocaleString("en-US", { maximumFractionDigits: bucket < 1 ? 2 : 1 }));
      const bandTotal = bandBid + bandAsk;
      const bidShare = bandTotal > 0 ? Math.round((bandBid / bandTotal) * 100) : null;
      setImbalance((current) => (bidShare === null ? null : current && Math.round(current.bid * 100) === bidShare ? current : { bid: bidShare / 100, ask: 1 - bidShare / 100 }));
      if (hover) setReadout(buildReadout(hover, frameRef.current, tracker.currentWalls()));
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(draw);
    };
    scheduleRef.current = schedule;
    schedule();
    const unsubscribe = tracker.subscribe(schedule);
    return () => {
      unsubscribe();
      scheduleRef.current = () => undefined;
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [trackerInstId]);

  const rowAt = (event: ReactPointerEvent<HTMLCanvasElement>): HoverRow | null => {
    const profile = frameRef.current;
    if (!profile) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const y = event.clientY - rect.top;
    if (y < profile.midY) {
      const offset = Math.floor((profile.midY - y) / profile.rowHeight);
      return offset >= 0 && offset < HALF_BUCKETS ? { side: "ask", offset } : null;
    }
    const offset = Math.floor((y - profile.midY) / profile.rowHeight);
    return offset >= 0 && offset < HALF_BUCKETS ? { side: "bid", offset } : null;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const next = rowAt(event);
    const current = hoverRef.current;
    if (next?.side === current?.side && next?.offset === current?.offset) return;
    hoverRef.current = next;
    if (!next) setReadout(null);
    scheduleRef.current();
  };

  const onPointerLeave = () => {
    hoverRef.current = null;
    setReadout(null);
    scheduleRef.current();
  };

  const onClick = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!onPriceSelect) return;
    const row = rowAt(event);
    const profile = frameRef.current;
    if (!row || !profile) return;
    // 取该档内挂单量最大的真实价位（通常就是那堵墙的价格），而不是桶边界。
    const { low, high } = bucketRange(row, profile);
    const levels = row.side === "ask" ? profile.book.asks : profile.book.bids;
    let best: { px: string; size: number } | null = null;
    for (const level of levels) {
      const price = Number(level.px);
      const size = Number(level.sz) || 0;
      if (price >= low && price < high && (!best || size > best.size)) best = { px: level.px, size };
    }
    if (best) onPriceSelect(best.px);
  };

  const digits = frameRef.current ? priceDigits(frameRef.current.bucket) : 1;
  const formatPrice = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const wallAge = readout?.wallMinutes !== null && readout?.wallMinutes !== undefined
    ? readout.wallMinutes > 0
      ? text(`${readout.wallMinutes}m`, `${readout.wallMinutes}分`)
      : text(`${readout.wallSeconds ?? 0}s`, `${readout.wallSeconds ?? 0}秒`)
    : null;

  return (
    <div className="depth-profile" aria-label={text("Mirrored depth profile", "镜像深度剖面")}>
      <div className="depth-profile__head">
        <span>{text("Depth profile · log", "深度剖面 · 对数")}</span>
        <span>{text("Mid", "中间价")} {mid}</span>
      </div>
      <div className="depth-profile__plot">
        <canvas
          ref={canvasRef}
          className={onPriceSelect ? "is-selectable" : undefined}
          aria-hidden="true"
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
          onClick={onClick}
        />
        {readout ? (
          <div className={`depth-profile__readout is-${readout.side}`} style={{ top: readout.top }} role="status">
            <div className="depth-profile__readout-price">
              <b>{formatPrice(readout.low)}</b>
              <span>– {formatPrice(readout.high)}</span>
            </div>
            <dl>
              <dt>{text("Level", "该档")}</dt>
              <dd>
                {compactSize(readout.size)}{text(" ct", "张")}
                {contractValue && contractValue > 0 ? <small> ≈ {compactUsd(readout.size * contractValue * (readout.low + readout.high) / 2)}</small> : null}
              </dd>
              <dt>{text("To here", "累计")}</dt>
              <dd>
                {compactSize(readout.cumulative)}{text(" ct", "张")}
                <small> · {text(`${(readout.cumulativeShare * 100).toFixed(1)}% of side`, `占本侧 ${(readout.cumulativeShare * 100).toFixed(1)}%`)}</small>
              </dd>
              <dt>{text("From mid", "距中间价")}</dt>
              <dd>{readout.side === "ask" ? "+" : "−"}{Math.abs(readout.distancePct).toFixed(3)}%<small> · {Math.round(Math.abs(readout.distancePct) * 100)}bp</small></dd>
            </dl>
            {wallAge ? <div className="depth-profile__readout-wall">{readout.side === "ask" ? text("Ask wall", "卖墙") : text("Bid wall", "买墙")} · {text("up ", "已挂 ")}{wallAge}</div> : null}
            {onPriceSelect ? <div className="depth-profile__readout-hint">{text("Click to use as order price", "点击填入委托价")}</div> : null}
          </div>
        ) : null}
      </div>
      <div className="depth-profile__imbalance">
        <span>
          <em title={text("Resting bid/ask share within ±0.3% of mid", "中间价 ±0.3% 内买卖挂单量占比")}>{text("±0.3% imbalance", "±0.3% 失衡")}</em>
          {imbalance ? <span className="depth-profile__imbalance-values"><b className="is-bid">{text("Bid", "买")} {Math.round(imbalance.bid * 100)}%</b><i>·</i><b className="is-ask">{text("Ask", "卖")} {Math.round(imbalance.ask * 100)}%</b></span> : <span>--</span>}
        </span>
        <div className="depth-profile__meter" aria-hidden="true">
          <i style={{ width: `${(imbalance?.bid ?? 0.5) * 100}%` }} />
          <i style={{ width: `${(imbalance?.ask ?? 0.5) * 100}%` }} />
        </div>
      </div>
    </div>
  );
}

function bucketRange(row: HoverRow, profile: ProfileFrame) {
  const index = row.side === "ask" ? profile.center + row.offset : profile.center - row.offset;
  const low = index * profile.bucket;
  return { low, high: low + profile.bucket };
}

function buildReadout(row: HoverRow, profile: ProfileFrame | null, walls: ReadonlyArray<{ side: "bid" | "ask"; price: number; firstSeenAt: number }>): HoverReadout | null {
  if (!profile) return null;
  const { low, high } = bucketRange(row, profile);
  const values = row.side === "ask" ? profile.asks : profile.bids;
  let cumulative = 0;
  for (let index = 0; index <= row.offset; index += 1) cumulative += values[index]!;
  const sideTotal = row.side === "ask" ? profile.askTotal : profile.bidTotal;
  const edge = row.side === "ask" ? low : high;
  const distancePct = ((edge - profile.midPrice) / profile.midPrice) * 100;
  const wall = walls.find((item) => item.side === row.side && Math.abs(item.price - low) < profile.bucket / 2);
  const ageMs = wall ? Math.max(0, Date.now() - wall.firstSeenAt) : null;
  const direction = row.side === "ask" ? -1 : 1;
  const rowCenter = profile.midY + direction * (row.offset + 0.5) * profile.rowHeight;
  return {
    side: row.side,
    low,
    high,
    size: values[row.offset]!,
    cumulative,
    cumulativeShare: sideTotal > 0 ? cumulative / sideTotal : 0,
    distancePct,
    wallMinutes: ageMs === null ? null : Math.floor(ageMs / 60_000),
    wallSeconds: ageMs === null ? null : Math.floor(ageMs / 1000),
    top: rowCenter,
  };
}
