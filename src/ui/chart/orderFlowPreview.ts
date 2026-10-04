import type { Candle, OrderBook } from "../../types";
import { ingestOrderBookForWalls } from "../../lib/orderBookWalls";
import type { OrderFlowPreviewData } from "./OrderFlowLayer";

// 仅用于 /chart-preview?orderflow=1：由预览 K 线确定性地合成订单流数据，验证各图层的渲染。
// 桌面端的数据来自本地 1m K 线（成交分布）、情报采集的主动成交与清算、实时 400 档盘口。

/** 订单流预览专用 K 线：两段波峰（第二段更高），便于验证背离；成交量在波峰附近放大。 */
export function buildOrderFlowPreviewCandles(basePrice: number): Candle[] {
  const start = Date.UTC(2026, 6, 8, 0, 0, 0) / 1000;
  let previous = basePrice;
  return Array.from({ length: 260 }, (_, index) => {
    const target = basePrice + Math.sin((index / 110) * Math.PI * 2) * 420 + index * 1.6;
    const open = previous;
    const close = target + Math.sin(index * 1.7) * 18;
    const high = Math.max(open, close) + 14 + Math.abs(Math.sin(index * 0.9)) * 22;
    const low = Math.min(open, close) - 14 - Math.abs(Math.cos(index * 1.3)) * 22;
    previous = close;
    return { time: start + index * 60, open, high, low, close, volume: 160 + Math.abs(close - open) * 5 + Math.abs(Math.cos((index / 110) * Math.PI * 2)) * 120, confirm: true };
  });
}

export function buildOrderFlowPreview(candles: readonly Candle[]): OrderFlowPreviewData {
  const low = Math.min(...candles.map((candle) => candle.low));
  const high = Math.max(...candles.map((candle) => candle.high));
  const bucket = Math.max(1, Math.round((high - low) / 80));
  const volumes = new Map<number, [number, number]>();
  for (const candle of candles) {
    const typical = (candle.high + candle.low + candle.close) / 3;
    const index = Math.floor(typical / bucket);
    const entry = volumes.get(index) ?? [0, 0];
    entry[0] += candle.volume;
    if (candle.close >= candle.open) entry[1] += candle.volume;
    volumes.set(index, entry);
  }
  const levels = [...volumes.entries()].sort((left, right) => left[0] - right[0]).map(([index, [volume, up]]) => [index * bucket, volume, up] as [number, number, number]);
  const total = levels.reduce((sum, [, volume]) => sum + volume, 0);
  let pocIndex = 0;
  levels.forEach(([, volume], index) => {
    if (volume > levels[pocIndex]![1]) pocIndex = index;
  });
  let lowIndex = pocIndex;
  let highIndex = pocIndex;
  let covered = levels[pocIndex]?.[1] ?? 0;
  while (covered < total * 0.7 && (lowIndex > 0 || highIndex < levels.length - 1)) {
    const below = lowIndex > 0 ? levels[lowIndex - 1]![1] : -1;
    const above = highIndex < levels.length - 1 ? levels[highIndex + 1]![1] : -1;
    if (above >= below) covered += levels[++highIndex]![1];
    else covered += levels[--lowIndex]![1];
  }
  // 主动成交：5 分钟一桶，方向跟随价格；第二段上涨刻意让主动买走弱，价格新高而 CVD 不创新高，验证背离标注。
  const taker: OrderFlowPreviewData["taker"] = [];
  for (let index = 0; index + 5 <= candles.length; index += 5) {
    const slice = candles.slice(index, index + 5);
    const move = slice.at(-1)!.close - slice[0]!.open;
    const volume = slice.reduce((sum, candle) => sum + candle.volume, 0) * 6_000;
    const late = index >= 100;
    const bias = Math.max(-0.35, Math.min(0.35, late ? (move / 400) * 0.3 - 0.05 : move / 400));
    taker.push({ ts: slice[0]!.time * 1000, buy: volume * (0.5 + bias), sell: volume * (0.5 - bias) });
  }
  // `?orderflow=dense`：模拟真实的清算踩踏——500 条记录集中在几次连环爆仓里，用来验证高密度下的聚合与标注。
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("orderflow") === "dense") {
    const cascades = [38, 74, 112, 150, 196, 236];
    const dense: OrderFlowPreviewData["liquidations"] = [];
    for (let i = 0; i < 500; i += 1) {
      const cascade = cascades[i % cascades.length]!;
      const candle = candles[Math.min(candles.length - 1, cascade + ((i * 7) % 5))]!;
      const long = (Math.floor(i / cascades.length) + cascade) % 3 !== 0;
      const spread = Math.sin(i * 12.9898) * 43758.5453;
      const noise = spread - Math.floor(spread);
      dense.push({ time: candle.time + (i % 60), price: (long ? candle.low : candle.high) + (noise - 0.5) * 60, size: Math.max(1, Math.round(Math.exp(noise * 4.2) * (i % 17 === 0 ? 40 : 3))), side: long ? "long" : "short" });
    }
    dense.sort((left, right) => left.time - right.time);
    return { profile: { bucket, levels, poc: levels[pocIndex] ? levels[pocIndex]![0] + bucket / 2 : null, valueAreaHigh: levels[highIndex] ? levels[highIndex]![0] + bucket : null, valueAreaLow: levels[lowIndex] ? levels[lowIndex]![0] : null }, taker, liquidations: dense };
  }
  const liquidations = [40, 110, 190, 230, candles.length - 2].map((offset, position) => {
    const candle = candles[Math.min(candles.length - 1, offset)]!;
    return { time: candle.time, price: position % 2 === 0 ? candle.low : candle.high, size: 40 + position * 55, side: position % 2 === 0 ? "long" as const : "short" as const };
  });
  return {
    profile: {
      bucket,
      levels,
      poc: levels[pocIndex] ? levels[pocIndex]![0] + bucket / 2 : null,
      valueAreaHigh: levels[highIndex] ? levels[highIndex]![0] + bucket : null,
      valueAreaLow: levels[lowIndex] ? levels[lowIndex]![0] : null
    },
    taker,
    liquidations
  };
}

/** 合成盘口：每 500ms 一份 400 档快照，上下各挂一堵固定的大单墙。 */
export function startPreviewOrderBook(instId: string, price: () => number) {
  const walls = { bid: 0, ask: 0 };
  const push = () => {
    const mid = price();
    const tick = 0.1;
    const bestBid = Math.floor(mid / tick) * tick;
    if (!walls.bid) walls.bid = bestBid - 18;
    if (!walls.ask) walls.ask = bestBid + 24;
    const level = (px: number, index: number, wall: number) => ({
      px: px.toFixed(1),
      sz: (Math.abs(px - wall) < tick / 2 ? 2400 : 3 + ((index * 37) % 11)).toFixed(2)
    });
    const book: OrderBook = {
      bids: Array.from({ length: 400 }, (_, index) => level(bestBid - index * tick, index, walls.bid)),
      asks: Array.from({ length: 400 }, (_, index) => level(bestBid + tick + index * tick, index, walls.ask)),
      ts: Date.now()
    };
    ingestOrderBookForWalls(instId, book);
  };
  push();
  const timer = window.setInterval(push, 500);
  return () => window.clearInterval(timer);
}
