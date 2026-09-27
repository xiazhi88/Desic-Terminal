import { useEffect, useRef, useState } from "react";
import { liquidityHistory } from "../../lib/liquidityHistory";
import "./liquidity.css";

type UiText = (english: string, chinese: string) => string;

const HALF_BUCKETS = 64;
const IMBALANCE_BAND = 0.003;

// 镜像深度剖面：以中间价为轴，卖盘在上、买盘在下；横向为对数挂单量，实线为逐档，虚线为累计。
// 数据是当前交易对完整的 400 档快照（在盘口列表截断到 40 档之前旁路），不做插值。
export function DepthProfile({ instId, text }: { instId: string; text: UiText }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [imbalance, setImbalance] = useState<{ bid: number; ask: number } | null>(null);
  const [mid, setMid] = useState<string>("--");

  useEffect(() => {
    let frame: number | null = null;
    const draw = () => {
      frame = null;
      const canvas = canvasRef.current;
      const book = liquidityHistory.instId === instId ? liquidityHistory.latestBook : null;
      if (!canvas || !book || liquidityHistory.bucket <= 0) return;
      const bestBid = Number(book.bids[0]?.px);
      const bestAsk = Number(book.asks[0]?.px);
      if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return;
      const midPrice = (bestBid + bestAsk) / 2;
      const bucket = liquidityHistory.bucket;
      const center = Math.floor(midPrice / bucket);
      const asks = new Float64Array(HALF_BUCKETS);
      const bids = new Float64Array(HALF_BUCKETS);
      let bandBid = 0;
      let bandAsk = 0;
      for (const level of book.asks) {
        const price = Number(level.px);
        const size = Number(level.sz) || 0;
        const offset = Math.floor(price / bucket) - center;
        if (offset >= 0 && offset < HALF_BUCKETS) asks[offset]! += size;
        if (price <= midPrice * (1 + IMBALANCE_BAND)) bandAsk += size;
      }
      for (const level of book.bids) {
        const price = Number(level.px);
        const size = Number(level.sz) || 0;
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
      setMid(midPrice.toLocaleString("en-US", { maximumFractionDigits: bucket < 1 ? 2 : 1 }));
      const bandTotal = bandBid + bandAsk;
      const bidShare = bandTotal > 0 ? Math.round((bandBid / bandTotal) * 100) : null;
      setImbalance((current) => (bidShare === null ? null : current && Math.round(current.bid * 100) === bidShare ? current : { bid: bidShare / 100, ask: 1 - bidShare / 100 }));
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(draw);
    };
    schedule();
    const unsubscribe = liquidityHistory.subscribe(schedule);
    return () => {
      unsubscribe();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [instId]);

  return (
    <div className="depth-profile" aria-label={text("Mirrored depth profile", "镜像深度剖面")}>
      <div className="depth-profile__head">
        <span>{text("Depth profile · log", "深度剖面 · 对数")}</span>
        <span>{text("Mid", "中间价")} {mid}</span>
      </div>
      <canvas ref={canvasRef} aria-hidden="true" />
      <div className="depth-profile__imbalance">
        <span>
          <em>{text("±0.3% resting imbalance", "±0.3% 挂单失衡")}</em>
          {imbalance ? <span><b className="is-bid">{text("Bid", "买")} {Math.round(imbalance.bid * 100)}%</b> · <b className="is-ask">{text("Ask", "卖")} {Math.round(imbalance.ask * 100)}%</b></span> : <span>--</span>}
        </span>
        <div className="depth-profile__meter" aria-hidden="true">
          <i style={{ width: `${(imbalance?.bid ?? 0.5) * 100}%` }} />
          <i style={{ width: `${(imbalance?.ask ?? 0.5) * 100}%` }} />
        </div>
      </div>
    </div>
  );
}
