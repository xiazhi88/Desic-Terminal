import { useMemo } from "react";
import type { Candle } from "../../types";
import type { ReviewTrade, UiText } from "../../lib/tradeReviewModel";

/**
 * 单笔复盘的 K 线：真实的本地 K 线 + 开仓 / 平仓标记 + 止损 / 止盈线 + 平仓后 4 小时的走势。
 * 纯 SVG，K 线的 time 是秒，仓位时间是毫秒。
 */
export function TradeReviewChart({ trade, candles, width, uiText }: { trade: ReviewTrade; candles: readonly Candle[]; width: number; uiText: UiText }) {
  const height = 270;
  const padL = 8;
  const padR = 84;
  const padT = 14;
  const padB = 22;

  // 止损 / 止盈来自条件单历史的启发式匹配；离开仓价过远的多半是匹配错了，不让它把 K 线压扁。
  const sane = (price: number | null | undefined) =>
    typeof price === "number" && price > 0 && trade.entry !== null && Math.abs(price - trade.entry) / trade.entry <= 0.25 ? price : null;
  const stopPx = sane(trade.stopPx);
  const tpPx = sane(trade.tpPx);

  const model = useMemo(() => {
    if (candles.length < 2 || width < 200) return null;
    const open = trade.openTime / 1000;
    const close = trade.closeTime / 1000;
    const hold = Math.max(60, close - open);
    const from = open - Math.max(1800, hold * 0.4);
    const to = close + 4 * 3600;
    const view = candles.filter((candle) => candle.time >= from && candle.time <= to);
    if (view.length < 2) return null;
    const step = Math.max(60, Math.min(...view.slice(1).map((candle, index) => candle.time - view[index].time).filter((gap) => gap > 0)));
    const levels = [trade.entry, trade.exit, stopPx, tpPx].filter((value): value is number => typeof value === "number" && value > 0);
    const lo = Math.min(...view.map((candle) => candle.low), ...levels);
    const hi = Math.max(...view.map((candle) => candle.high), ...levels);
    const margin = (hi - lo) * 0.06 || hi * 0.002;
    const plotW = width - padL - padR;
    const t0 = view[0].time;
    const t1 = view[view.length - 1].time + step;
    const x = (time: number) => padL + ((time - t0) / Math.max(1, t1 - t0)) * plotW;
    const y = (price: number) => padT + (1 - (price - (lo - margin)) / (hi - lo + 2 * margin)) * (height - padT - padB);
    return { view, step, x, y, open, close, plotW, cw: Math.max(1.5, (plotW * step) / Math.max(1, t1 - t0)) };
  }, [candles, trade, width, stopPx, tpPx]);

  if (!model) {
    return <div className="tr-chart-empty">{uiText("这笔交易附近没有可用的本地 K 线（超过保留期，或还没同步）。", "No local candles around this trade (older than retention, or not synced yet).")}</div>;
  }
  const { view, x, y, open, close, cw } = model;
  const fmt = (price: number) => (price >= 1000 ? price.toFixed(1) : price >= 10 ? price.toFixed(2) : price.toFixed(4));
  const dir = trade.side === "long" ? 1 : -1;
  const line = (price: number | null | undefined, color: string, label: string, dashed: boolean) =>
    typeof price === "number" && price > 0 ? (
      <g key={label}>
        <line x1={padL} x2={width - padR} y1={y(price)} y2={y(price)} stroke={color} strokeDasharray={dashed ? "4 3" : undefined} opacity={0.85} />
        <text x={width - padR + 6} y={y(price) + 3.5} fill={color} fontSize="10.5">{label} {fmt(price)}</text>
      </g>
    ) : null;
  const postX = x(close);

  return (
    <svg className="tr-chart" width={width} height={height} role="img" aria-label={uiText("单笔交易 K 线回放", "Trade replay chart")}>
      <rect x={postX} y={padT} width={Math.max(0, width - padR - postX)} height={height - padT - padB} fill="rgba(149,92,255,.07)" />
      <text x={postX + 6} y={padT + 11} fill="#8a7bc0" fontSize="10">{uiText("平仓后 4 小时", "4 h after exit")}</text>
      {line(stopPx, "#f5a524", uiText("止损", "SL"), true)}
      {line(tpPx, "#7edba9", uiText("止盈", "TP"), true)}
      {line(trade.entry, "#aab1c0", uiText("开仓", "Entry"), false)}
      {view.map((candle) => {
        const up = candle.close >= candle.open;
        const color = up ? "var(--up)" : "var(--down)";
        const cx = x(candle.time) + cw / 2;
        const after = candle.time > close;
        return (
          <g key={candle.time} opacity={after ? 0.55 : 1}>
            <line x1={cx} x2={cx} y1={y(candle.high)} y2={y(candle.low)} stroke={color} />
            <rect x={cx - cw * 0.34} y={Math.min(y(candle.open), y(candle.close))} width={Math.max(1, cw * 0.68)} height={Math.max(1, Math.abs(y(candle.open) - y(candle.close)))} fill={color} />
          </g>
        );
      })}
      {[open, close].map((time, index) => (
        <line key={index} x1={x(time)} x2={x(time)} y1={padT} y2={height - padB} stroke="rgba(174,186,210,.3)" strokeDasharray="2 3" />
      ))}
      {trade.entry !== null && (
        <g>
          <path d={`M${x(open)} ${y(trade.entry) + (dir > 0 ? 8 : -8)} l-5 ${dir > 0 ? 8 : -8} h10 z`} fill="#f5f7fb" />
          <text x={x(open)} y={y(trade.entry) + (dir > 0 ? 28 : -14)} textAnchor="middle" fill="#f5f7fb" fontSize="10">{uiText("开", "In")}</text>
        </g>
      )}
      {trade.exit !== null && (
        <g>
          <path d={`M${x(close)} ${y(trade.exit) + (dir > 0 ? -8 : 8)} l-5 ${dir > 0 ? -8 : 8} h10 z`} fill="#f5f7fb" />
          <text x={x(close)} y={y(trade.exit) + (dir > 0 ? -22 : 28)} textAnchor="middle" fill="#f5f7fb" fontSize="10">{uiText("平", "Out")}</text>
        </g>
      )}
    </svg>
  );
}
