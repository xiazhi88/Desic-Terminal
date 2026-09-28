import { parseMarketCandles } from "../../lib/aiCandleSeries";
import { parseToolPayload } from "../../lib/aiEvidenceLedger";
import type { AiToolRun } from "../AiMessageProcess";

// 证据卡迷你图（84×34）与详情大图共用的绘制函数，移植自证据天平原型。
// 只画工具真实返回的数据：拿不到可画的序列时返回 false，卡片不显示图。

export const EVB_COLORS = {
  rise: "#ff4d6a",
  fall: "#19d99a",
  ai: "#9a63ff",
  aiHi: "#c3a5ff",
  live: "#5fd4e0",
  warn: "#f3b23c",
  ink: "#f4f4fa",
  ink2: "#b9bacb",
  ink3: "#7e8096",
  ink4: "#53556a",
  bg: "#05060b",
  s1: "#0a0b12",
  s2: "#10111a"
};

// 卖 / 空 = 红，买 / 多 = 绿（与盘口、下单按钮一致）；K 线红涨绿跌。
const ASK = EVB_COLORS.rise;
const BID = EVB_COLORS.fall;
const NUM_FONT = "ui-monospace, SFMono-Regular, Menlo, monospace";

export function alpha(hex: string, value: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${value})`;
}

export function prepCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  return context;
}

function record(value: unknown): Record<string, unknown> {
  const parsed = parseToolPayload(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function num(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.replaceAll(",", "")) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function fmt(value: number, digits = 1) {
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

type Draw = (context: CanvasRenderingContext2D, width: number, height: number, big: boolean) => void;

function levelsOf(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 400).map((level) => {
    if (Array.isArray(level)) return [num(level[0]) ?? 0, num(level[1]) ?? 0] as [number, number];
    const item = record(level);
    return [num(item.px ?? item.price) ?? 0, num(item.sz ?? item.size) ?? 0] as [number, number];
  }).filter(([price, size]) => price > 0 && size > 0);
}

function candlesViz(tool: AiToolRun): Draw | null {
  const { candles } = parseMarketCandles(parseToolPayload(tool.result));
  const series = candles.slice(-60);
  if (series.length < 3) return null;
  return (context, width, height, big) => {
    const pad = big ? 22 : 1;
    let low = Infinity;
    let high = -Infinity;
    for (const candle of series) {
      low = Math.min(low, candle.low);
      high = Math.max(high, candle.high);
    }
    const span = high - low || high * 0.01 || 1;
    low -= span * 0.04;
    high += span * 0.04;
    const cw = (width - pad * 2) / series.length;
    const x = (index: number) => pad + index * cw + cw / 2;
    const y = (value: number) => pad + (1 - (value - low) / (high - low)) * (height - pad * 2);
    series.forEach((candle, index) => {
      const color = candle.close >= candle.open ? EVB_COLORS.rise : EVB_COLORS.fall;
      context.strokeStyle = alpha(color, 0.9);
      context.fillStyle = alpha(color, 0.9);
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x(index), y(candle.high));
      context.lineTo(x(index), y(candle.low));
      context.stroke();
      const bw = Math.max(0.8, cw * (big ? 0.62 : 0.55));
      context.fillRect(x(index) - bw / 2, y(Math.max(candle.open, candle.close)), bw, Math.max(0.8, Math.abs(y(candle.open) - y(candle.close))));
    });
    const last = series.at(-1)!;
    context.strokeStyle = EVB_COLORS.ink;
    context.lineWidth = big ? 1.2 : 1;
    context.beginPath();
    context.arc(x(series.length - 1), y(last.close), big ? 4 : 2, 0, Math.PI * 2);
    context.stroke();
    if (big) {
      const maxIndex = series.findIndex((candle) => candle.high === Math.max(...series.map((item) => item.high)));
      const minIndex = series.findIndex((candle) => candle.low === Math.min(...series.map((item) => item.low)));
      context.font = `11.5px ${NUM_FONT}`;
      context.fillStyle = EVB_COLORS.ink2;
      context.textAlign = "left";
      context.fillText(fmt(series[maxIndex]!.high), Math.min(x(maxIndex) + 6, width - 70), y(series[maxIndex]!.high) + 4);
      context.fillText(fmt(series[minIndex]!.low), Math.min(x(minIndex) + 6, width - 70), y(series[minIndex]!.low) + 12);
      context.textAlign = "right";
      context.fillStyle = EVB_COLORS.ink;
      const change = ((last.close - series[0]!.open) / series[0]!.open) * 100;
      context.fillText(`${fmt(last.close)} · ${change >= 0 ? "+" : ""}${change.toFixed(2)}%`, x(series.length - 1), y(last.close) - 12);
    }
  };
}

function depthViz(tool: AiToolRun): Draw | null {
  const result = record(tool.result);
  const book = record(result.book ?? result.orderBook ?? result);
  const bids = levelsOf(book.bids);
  const asks = levelsOf(book.asks);
  const bidTotal = bids.reduce((sum, [, size]) => sum + size, 0);
  const askTotal = asks.reduce((sum, [, size]) => sum + size, 0);
  if (bidTotal + askTotal <= 0) return null;
  const share = bidTotal / (bidTotal + askTotal);
  return (context, width, height, big) => {
    const y = big ? height / 2 - 10 : height / 2 - 3;
    const bh = big ? 20 : 6;
    const pad = big ? 24 : 0;
    const w = width - pad * 2;
    context.fillStyle = alpha(BID, 0.75);
    context.fillRect(pad, y, w * share - 1, bh);
    context.fillStyle = alpha(ASK, 0.75);
    context.fillRect(pad + w * share + 1, y, w * (1 - share) - 1, bh);
    context.fillStyle = EVB_COLORS.ink;
    context.fillRect(pad + w / 2 - 0.5, y - 4, 1, bh + 8);
    if (big) {
      context.font = `12px ${NUM_FONT}`;
      context.fillStyle = EVB_COLORS.ink2;
      context.textAlign = "left";
      context.fillText(`买 ${Math.round(share * 100)}% · ${fmt(bidTotal, 2)}`, pad, y + bh + 22);
      context.textAlign = "right";
      context.fillText(`卖 ${Math.round((1 - share) * 100)}% · ${fmt(askTotal, 2)}`, width - pad, y + bh + 22);
      context.textAlign = "center";
      context.fillStyle = EVB_COLORS.ink3;
      context.fillText("50%", width / 2, y - 10);
    }
  };
}

function ticksViz(tool: AiToolRun): Draw | null {
  const result = record(tool.result);
  const trades = (Array.isArray(result.trades) ? result.trades : Array.isArray(result.data) ? result.data : Array.isArray(result.items) ? result.items : []).slice(0, 50).map(record);
  if (trades.length < 3) return null;
  const sizes = trades.map((trade) => num(trade.sz ?? trade.size) ?? 0);
  const max = Math.max(...sizes, 1e-9);
  const buys = trades.filter((trade) => trade.side === "buy").length;
  const ordered = trades.slice().reverse();
  const orderedSizes = sizes.slice().reverse();
  return (context, width, height, big) => {
    const pad = big ? 20 : 0;
    const w = width - pad * 2;
    const bw = w / ordered.length;
    const base = big ? height - 30 : height - 2;
    const maxH = big ? height - 60 : height - 4;
    ordered.forEach((trade, index) => {
      context.fillStyle = trade.side === "buy" ? BID : alpha(ASK, 0.85);
      const bh = Math.max(2, (0.25 + Math.sqrt(orderedSizes[index]! / max) * 0.75) * maxH);
      context.fillRect(pad + index * bw + (big ? 1 : 0.25), base - bh, Math.max(1, bw - (big ? 2 : 0.6)), bh);
    });
    if (big) {
      context.font = `12px ${NUM_FONT}`;
      context.fillStyle = EVB_COLORS.ink3;
      context.textAlign = "left";
      context.fillText("较早", pad, height - 10);
      context.textAlign = "right";
      context.fillText("最新", width - pad, height - 10);
      context.textAlign = "center";
      context.fillStyle = EVB_COLORS.ink2;
      context.fillText(`主动卖 ${trades.length - buys} · 主动买 ${buys}`, width / 2, height - 10);
    }
  };
}

// 数值序列：指标、资金流等返回的数组里取第一条可画的数值列。
function numericSeries(value: unknown, depth = 0): number[] | null {
  if (depth > 3) return null;
  if (Array.isArray(value)) {
    const direct = value.map((item) => num(item)).filter((item): item is number => item !== null);
    if (direct.length >= 6 && direct.length === value.length) return direct;
    if (value.length >= 6 && value.every((item) => item && typeof item === "object")) {
      const sample = record(value[0]);
      const key = ["value", "close", "netFlow", "net", "ratio", "longShortRatio", "oi", "oiUsd", "buyVol"].find((candidate) => num(sample[candidate]) !== null);
      if (key) return value.map((item) => num(record(item)[key]) ?? 0);
    }
    return null;
  }
  const source = record(value);
  for (const key of ["values", "series", "points", "items", "data", "result"]) {
    const found = numericSeries(source[key], depth + 1);
    if (found) return found;
  }
  for (const entry of Object.values(source)) {
    const found = numericSeries(entry, depth + 1);
    if (found) return found;
  }
  return null;
}

function flowViz(tool: AiToolRun): Draw | null {
  const result = record(tool.result);
  const rows = (Array.isArray(result.items) ? result.items : Array.isArray(result.data) ? result.data : []).map(record);
  const flows = rows.map((row) => {
    const buy = num(row.buyVol);
    const sell = num(row.sellVol);
    return buy !== null && sell !== null ? buy - sell : num(row.netFlow ?? row.net);
  }).filter((value): value is number => value !== null).slice(-16);
  if (flows.length < 4) return null;
  const scale = Math.max(...flows.map(Math.abs), 1e-9);
  return (context, width, height, big) => {
    const pad = big ? 24 : 1;
    const gap = big ? 5 : 1.2;
    const bw = (width - pad * 2 - gap * (flows.length - 1)) / flows.length;
    const mid = height * (big ? 0.62 : 0.66);
    const sc = (big ? height * 0.5 : height * 0.55) / scale;
    flows.forEach((value, index) => {
      context.fillStyle = value >= 0 ? alpha(BID, 0.8) : alpha(ASK, 0.8);
      const bh = Math.abs(value) * sc;
      context.fillRect(pad + index * (bw + gap), value >= 0 ? mid - bh : mid, bw, bh);
    });
    let acc = 0;
    const cumulative = flows.map((value) => (acc += value));
    const cmax = Math.max(...cumulative.map(Math.abs), 1e-9);
    context.strokeStyle = EVB_COLORS.ink;
    context.lineWidth = big ? 1.5 : 1;
    context.beginPath();
    cumulative.forEach((value, index) => context.lineTo(pad + index * (bw + gap) + bw / 2, mid - (value / cmax) * (mid - (big ? 20 : 2))));
    context.stroke();
    if (big) {
      context.font = `12px ${NUM_FONT}`;
      context.textAlign = "right";
      context.fillStyle = EVB_COLORS.ink;
      context.fillText(`累计 ${acc >= 0 ? "+" : ""}${fmt(acc, 0)}`, width - pad, 14);
    }
  };
}

function lineViz(tool: AiToolRun): Draw | null {
  const values = numericSeries(tool.result)?.slice(-60);
  if (!values || values.length < 6) return null;
  return (context, width, height, big) => {
    const pad = big ? 22 : 2;
    const low = Math.min(...values);
    const high = Math.max(...values);
    const span = high - low || Math.abs(high) || 1;
    const x = (index: number) => pad + (index / (values.length - 1)) * (width - pad * 2);
    const y = (value: number) => pad + (1 - (value - low) / span) * (height - pad * 2);
    context.strokeStyle = EVB_COLORS.ink;
    context.lineWidth = big ? 1.5 : 1.1;
    context.beginPath();
    values.forEach((value, index) => context.lineTo(x(index), y(value)));
    context.stroke();
    context.fillStyle = EVB_COLORS.ink;
    context.beginPath();
    context.arc(x(values.length - 1), y(values.at(-1)!), big ? 3 : 1.8, 0, Math.PI * 2);
    context.fill();
    if (big) {
      context.font = `11.5px ${NUM_FONT}`;
      context.textAlign = "right";
      context.fillText(fmt(values.at(-1)!, 2), width - pad, y(values.at(-1)!) - 10);
    }
  };
}

function rankViz(tool: AiToolRun): Draw | null {
  const result = record(tool.result);
  const rows = (Array.isArray(result.items) ? result.items : Array.isArray(result.rows) ? result.rows : Array.isArray(result.ranking) ? result.ranking : []).map(record);
  const scores = rows.slice(0, 10).map((row) => num(row.compositeScore ?? row.score ?? row.composite)).filter((value): value is number => value !== null);
  if (scores.length < 3) return null;
  const focus = Math.max(0, rows.findIndex((row) => String(row.instId ?? "").startsWith(String(record(tool.arguments).instId ?? "\u0000"))));
  const low = Math.min(...scores) - 5;
  const high = Math.max(...scores);
  return (context, width, height, big) => {
    const pad = big ? 26 : 1;
    const gap = big ? 8 : 2;
    const bw = (width - pad * 2 - gap * (scores.length - 1)) / scores.length;
    const base = big ? height - 30 : height - 1;
    const maxH = big ? height - 58 : height - 3;
    scores.forEach((score, index) => {
      const bh = ((score - low) / (high - low || 1)) * maxH;
      context.fillStyle = index === focus ? EVB_COLORS.ink : alpha(EVB_COLORS.ink3, 0.45);
      context.fillRect(pad + index * (bw + gap), base - bh, bw, bh);
      if (big) {
        context.font = `11px ${NUM_FONT}`;
        context.textAlign = "center";
        context.fillStyle = index === focus ? EVB_COLORS.ink : EVB_COLORS.ink4;
        context.fillText(`#${index + 1}`, pad + index * (bw + gap) + bw / 2, height - 12);
        context.fillText(String(Math.round(score)), pad + index * (bw + gap) + bw / 2, base - bh - 6);
      }
    });
  };
}

// 多空比类：在 1.0 两侧的刻度上标出比值。
function ratioViz(tool: AiToolRun): Draw | null {
  const result = record(tool.result);
  const series = numericSeries(result);
  const direct = num(result.topPositionRatio ?? result.longShortRatio ?? result.accountRatio ?? result.ratio);
  const ratio = direct ?? (series ? series.at(-1)! : null);
  if (ratio === null || ratio <= 0 || ratio > 10) return null;
  return (context, width, height, big) => {
    const pad = big ? 36 : 4;
    const y = big ? height / 2 : height / 2 + 2;
    const low = Math.min(0.5, ratio - 0.1);
    const high = Math.max(1.5, ratio + 0.1);
    const x = (value: number) => pad + ((value - low) / (high - low)) * (width - pad * 2);
    context.fillStyle = alpha(ASK, 0.22);
    context.fillRect(pad, y - 2, x(1) - pad, 4);
    context.fillStyle = alpha(BID, 0.22);
    context.fillRect(x(1), y - 2, width - pad - x(1), 4);
    context.fillStyle = EVB_COLORS.ink3;
    context.fillRect(x(1) - 0.5, y - (big ? 12 : 7), 1, big ? 24 : 14);
    const mx = x(ratio);
    context.fillStyle = ratio >= 1 ? BID : ASK;
    context.beginPath();
    context.moveTo(mx, y - 3);
    context.lineTo(mx - (big ? 6 : 4), y - (big ? 12 : 9));
    context.lineTo(mx + (big ? 6 : 4), y - (big ? 12 : 9));
    context.closePath();
    context.fill();
    context.fillRect(mx - 0.75, y - 3, 1.5, 6);
    if (big) {
      context.font = `12px ${NUM_FONT}`;
      context.textAlign = "center";
      context.fillStyle = EVB_COLORS.ink;
      context.fillText(ratio.toFixed(2), mx, y - 20);
      context.fillStyle = EVB_COLORS.ink3;
      context.fillText("1.00", x(1), y + 26);
    }
  };
}

// 同一份结果只构建一次绘制函数（流式输出期间卡片会反复渲染）。
const drawerCache = new Map<unknown, { name: string; draw: Draw | null }>();

export function evidenceDrawer(tool: AiToolRun | undefined): Draw | null {
  if (!tool || tool.status !== "done") return null;
  const cached = drawerCache.get(tool.result);
  if (cached && cached.name === tool.name) return cached.draw;
  const draw = buildDrawer(tool);
  drawerCache.set(tool.result, { name: tool.name, draw });
  if (drawerCache.size > 256) drawerCache.delete(drawerCache.keys().next().value);
  return draw;
}

function buildDrawer(tool: AiToolRun): Draw | null {
  const name = tool.name;
  if (name === "market.readCandles") return candlesViz(tool);
  if (name === "market.readOrderBook") return depthViz(tool);
  if (name === "market.readTrades" || name === "market.readRecentTrades") return ticksViz(tool);
  if (name.includes("TakerFlow") || name.includes("takerFlow")) return flowViz(tool) ?? lineViz(tool);
  if (name.startsWith("radar.")) return rankViz(tool) ?? lineViz(tool);
  if (name.includes("Crowding") || name.includes("ConsensusDivergence") || name.includes("smartMoney")) return ratioViz(tool) ?? lineViz(tool);
  if (name.startsWith("market.") || name.startsWith("intelligence.")) return lineViz(tool);
  return null;
}
