import type { Candle, OrderBook, Trade } from "../../types";
import { ingestLiquidityBook, ingestLiquidityTrades } from "../../lib/liquidityHistory";

// 仅用于 /chart-preview?liquidity=1：确定性的合成盘口与成交，验证流动性模式的渲染与事件判定。
// 真实墙在价格穿越时被成交吃掉，假墙在价格靠近时撤出，冰山被吃后补单。

const TICK = 0.5;
const LEVELS = 160;
const WARM_SECONDS = 7200;

type Wall = { price: number; side: "bid" | "ask"; size: number; kind: "real" | "spoof" | "iceberg"; refills: number };

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(random: () => number) {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export type LiquidityPreviewFeed = {
  /** 回填完成后的 1m K 线（同步生成，首帧即可使用）。 */
  candles: Candle[];
  start: (onCandles: (candles: Candle[]) => void) => () => void;
};

export function createLiquidityPreviewFeed(instId: string, basePrice: number): LiquidityPreviewFeed {
  const random = rng(20260927);
  let price = basePrice;
  let drift = 0;
  let tradeSeq = 0;
  const walls: Wall[] = [];
  const candles: Candle[] = [];
  let sec = Math.floor(Date.now() / 1000) - WARM_SECONDS;

  const spawnWall = () => {
    const side: "bid" | "ask" = random() < 0.5 ? "bid" : "ask";
    const distance = 18 + random() * 60;
    const raw = side === "bid" ? price - distance : price + distance;
    const kindRoll = random();
    walls.push({
      price: Math.round(raw / TICK) * TICK,
      side,
      size: 900 + random() * 2600,
      kind: kindRoll < 0.55 ? "real" : kindRoll < 0.85 ? "spoof" : "iceberg",
      refills: 0
    });
  };

  const step = () => {
    if (sec % 30 === 0) drift = gauss(random) * 0.9;
    if (walls.length < 5 && random() < 0.05) spawnWall();
    const previous = price;
    price += drift * 0.35 + gauss(random) * 2.4;
    const trades: Trade[] = [];
    const tradeCount = 2 + Math.floor(random() * 6);
    for (let index = 0; index < tradeCount; index += 1) {
      const buy = random() < 0.5 + Math.sign(price - previous) * 0.18;
      trades.push({
        tradeId: `pv-${(tradeSeq += 1)}`,
        px: (price + (buy ? TICK / 2 : -TICK / 2)).toFixed(1),
        sz: (Math.exp(gauss(random) * 0.9) * 6).toFixed(2),
        side: buy ? "buy" : "sell",
        ts: sec * 1000 + Math.floor(random() * 999)
      });
    }
    for (let index = walls.length - 1; index >= 0; index -= 1) {
      const wall = walls[index]!;
      const crossed = wall.side === "bid" ? price <= wall.price : price >= wall.price;
      const near = Math.abs(price - wall.price) < 8;
      if (wall.kind === "spoof" && near) {
        walls.splice(index, 1);
        continue;
      }
      if (crossed) {
        const chunk = Math.min(wall.size, 350 + random() * 500);
        trades.push({ tradeId: `pv-${(tradeSeq += 1)}`, px: wall.price.toFixed(1), sz: chunk.toFixed(2), side: wall.side === "bid" ? "sell" : "buy", ts: sec * 1000 + 500 });
        wall.size -= chunk;
        price = wall.side === "bid" ? Math.min(price, wall.price) : Math.max(price, wall.price);
        if (wall.size <= 1) {
          if (wall.kind === "iceberg" && wall.refills < 2) {
            wall.size = 700 + random() * 900;
            wall.refills += 1;
          } else {
            walls.splice(index, 1);
          }
        }
      }
    }
    const bestBid = Math.floor(price / TICK) * TICK;
    const bestAsk = bestBid + TICK;
    const level = (px: number, distance: number) => {
      const round = Math.abs(px % 10) < TICK / 2 ? 3 : 1;
      const size = (14 * Math.exp(-distance / 90) + 2) * (0.4 + random() * 1.2) * round;
      return size;
    };
    const bids = Array.from({ length: LEVELS }, (_, index) => {
      const px = bestBid - index * TICK;
      return { px, sz: level(px, index) };
    });
    const asks = Array.from({ length: LEVELS }, (_, index) => {
      const px = bestAsk + index * TICK;
      return { px, sz: level(px, index) };
    });
    for (const wall of walls) {
      const book = wall.side === "bid" ? bids : asks;
      const offset = Math.round(Math.abs(wall.price - (wall.side === "bid" ? bestBid : bestAsk)) / TICK);
      const target = book[offset];
      if (target) target.sz += wall.size;
    }
    const book: OrderBook = {
      bids: bids.map((item) => ({ px: item.px.toFixed(1), sz: item.sz.toFixed(2) })),
      asks: asks.map((item) => ({ px: item.px.toFixed(1), sz: item.sz.toFixed(2) })),
      ts: sec * 1000 + 999
    };
    ingestLiquidityTrades(instId, trades);
    ingestLiquidityBook(instId, book);
    const minute = Math.floor(sec / 60) * 60;
    const volume = trades.reduce((sum, trade) => sum + Number(trade.sz), 0);
    const last = candles.at(-1);
    if (!last || last.time !== minute) {
      candles.push({ time: minute, open: previous, high: Math.max(previous, price), low: Math.min(previous, price), close: price, volume, confirm: false });
      if (last) last.confirm = true;
    } else {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
      last.volume += volume;
    }
    sec += 1;
  };

  const now = Math.floor(Date.now() / 1000);
  while (sec < now) step();
  return {
    candles: candles.map((item) => ({ ...item })),
    start(onCandles) {
      let ticks = 0;
      const timer = window.setInterval(() => {
        ticks += 1;
        // 每 250ms 推进 1 秒模拟时间：比真实时间快 4 倍，便于观察事件。
        step();
        if (ticks % 2 === 0) onCandles(candles.map((item) => ({ ...item })));
      }, 250);
      return () => window.clearInterval(timer);
    }
  };
}
