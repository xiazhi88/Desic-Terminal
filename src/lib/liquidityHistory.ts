import type { OrderBook, Trade } from "../types";

// 流动性历史采集器：只采集当前交易对。
// - 盘口：每秒一列，按固定价格桶累计挂单量，对数量化为 0-255；每列记录自己的桶起点，
//   价格漂移时不需要重建历史。流中断的秒数写空列，画面上如实留黑，不补造。
// - 成交：独立环形缓冲，用于成交气泡与“挂单是否被成交消耗”的判定。
// - 大单墙事件只描述事实：持续一段时间的大额挂单消失时，按期间该价位的真实成交量
//   区分“成交消耗”与“撤出”，从不标注支撑 / 阻力。

export const LIQUIDITY_WINDOW_SECONDS = 7200;
export const LIQUIDITY_ROWS = 512;
const TRADE_CAPACITY = 40_000;
const MAX_EVENTS = 80;
const WALL_MIN_SECONDS = 20;
const WALL_MEDIAN_MULTIPLE = 8;
/** 墙体至少占本列可见挂单总量的比例，过滤贴近中间价的常规厚档。 */
const WALL_MIN_SHARE = 0.025;
const WALL_GONE_RATIO = 0.35;
const EATEN_TRADE_SHARE = 0.4;

export type LiquidityEventKind = "eaten" | "pulled";

export type LiquidityEvent = {
  id: number;
  kind: LiquidityEventKind;
  side: "bid" | "ask";
  price: number;
  /** 墙最后一次出现时的挂单量（张）。 */
  size: number;
  /** 期间在该价位成交的量（张）。 */
  tradedSize: number;
  firstSeenSec: number;
  timeSec: number;
  /** 本地检测时刻（ms），只用于动效时长。 */
  detectedAt: number;
};

type WallTrack = {
  abs: number;
  side: "bid" | "ask";
  firstSec: number;
  lastSec: number;
  peak: number;
  last: number;
};

export type LiquiditySnapshot = {
  instId: string;
  bucket: number;
  scale: number;
  columns: number;
  rows: number;
  values: Uint8Array;
  origins: Float32Array;
  headIndex: number;
  headSec: number;
  filled: number;
  version: number;
};

class LiquidityHistory {
  instId: string | null = null;
  bucket = 0;
  scale = 0;
  readonly columns = LIQUIDITY_WINDOW_SECONDS;
  readonly rows = LIQUIDITY_ROWS;
  values = new Uint8Array(this.columns * this.rows);
  origins = new Float32Array(this.columns);
  headIndex = -1;
  headSec = 0;
  filled = 0;
  version = 0;
  latestBook: OrderBook | null = null;
  tradeTime = new Float64Array(TRADE_CAPACITY);
  tradePrice = new Float64Array(TRADE_CAPACITY);
  tradeSize = new Float64Array(TRADE_CAPACITY);
  tradeBuy = new Uint8Array(TRADE_CAPACITY);
  tradeHead = 0;
  tradeCount = 0;
  recentTradeIds = new Set<string>();
  recentTradeOrder: string[] = [];
  walls = new Map<number, WallTrack>();
  events: LiquidityEvent[] = [];
  eventSeq = 0;
  listeners = new Set<() => void>();
  private rawColumn = new Float64Array(LIQUIDITY_ROWS);

  reset(instId: string) {
    this.instId = instId;
    this.bucket = 0;
    this.scale = 0;
    this.values.fill(0);
    this.origins.fill(0);
    this.headIndex = -1;
    this.headSec = 0;
    this.filled = 0;
    this.latestBook = null;
    this.tradeHead = 0;
    this.tradeCount = 0;
    this.recentTradeIds.clear();
    this.recentTradeOrder = [];
    this.walls.clear();
    this.events = [];
    this.version += 1;
    this.notify();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  ingestBook(instId: string, book: OrderBook) {
    if (instId !== this.instId) this.reset(instId);
    this.latestBook = book;
    const sec = Math.floor((book.ts || Date.now()) / 1000);
    if (this.headIndex < 0) {
      if (!this.initializeScale(book)) return;
      this.writeColumn(sec, book);
      this.notify();
      return;
    }
    if (sec <= this.headSec) return;
    const gap = Math.min(sec - this.headSec - 1, this.columns);
    for (let offset = 0; offset < gap; offset += 1) this.writeEmptyColumn();
    this.writeColumn(sec, book);
    this.notify();
  }

  ingestTrades(instId: string, trades: readonly Trade[]) {
    if (instId !== this.instId) this.reset(instId);
    let added = false;
    for (const trade of trades) {
      const id = trade.tradeId || `${trade.ts}:${trade.side}:${trade.px}:${trade.sz}`;
      if (this.recentTradeIds.has(id)) continue;
      const price = Number(trade.px);
      const size = Number(trade.sz);
      if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue;
      this.recentTradeIds.add(id);
      this.recentTradeOrder.push(id);
      if (this.recentTradeOrder.length > 4096) this.recentTradeIds.delete(this.recentTradeOrder.shift()!);
      const index = this.tradeHead;
      this.tradeTime[index] = trade.ts / 1000;
      this.tradePrice[index] = price;
      this.tradeSize[index] = size;
      this.tradeBuy[index] = trade.side === "buy" ? 1 : 0;
      this.tradeHead = (this.tradeHead + 1) % TRADE_CAPACITY;
      this.tradeCount = Math.min(this.tradeCount + 1, TRADE_CAPACITY);
      added = true;
    }
    if (added) {
      this.version += 1;
      this.notify();
    }
  }

  // 桶宽：盘口价差步长与盘口覆盖范围 / 300 取大，并取整到 1/2/5 × 10^n。
  private initializeScale(book: OrderBook) {
    const prices = [...book.bids, ...book.asks].map((level) => Number(level.px)).filter(Number.isFinite).sort((a, b) => a - b);
    if (prices.length < 4) return false;
    let tick = Infinity;
    for (let index = 1; index < prices.length; index += 1) {
      const diff = prices[index]! - prices[index - 1]!;
      if (diff > 0 && diff < tick) tick = diff;
    }
    const span = prices.at(-1)! - prices[0]!;
    this.bucket = niceStep(Math.max(Number.isFinite(tick) ? tick : span / 300, span / 300));
    let max = 0;
    for (const level of [...book.bids, ...book.asks]) max = Math.max(max, Number(level.sz) || 0);
    // 量化刻度按首列最大挂单的 6 倍定标，之后固定：同一会话内的颜色可比。
    this.scale = 255 / Math.log1p(Math.max(max, 1) * 6);
    return true;
  }

  private advanceHead() {
    this.headIndex = (this.headIndex + 1) % this.columns;
    this.filled = Math.min(this.filled + 1, this.columns);
  }

  private writeEmptyColumn() {
    this.advanceHead();
    this.headSec += 1;
    this.values.fill(0, this.headIndex * this.rows, (this.headIndex + 1) * this.rows);
    this.origins[this.headIndex] = this.origins[(this.headIndex - 1 + this.columns) % this.columns]!;
  }

  private writeColumn(sec: number, book: OrderBook) {
    const bestBid = Number(book.bids[0]?.px);
    const bestAsk = Number(book.asks[0]?.px);
    const mid = Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? (bestBid + bestAsk) / 2 : Number.isFinite(bestBid) ? bestBid : bestAsk;
    if (!Number.isFinite(mid)) return;
    this.advanceHead();
    this.headSec = sec;
    const origin = Math.floor(mid / this.bucket) - this.rows / 2;
    this.origins[this.headIndex] = origin;
    const raw = this.rawColumn;
    raw.fill(0);
    for (const level of book.bids) accumulate(raw, level, this.bucket, origin, this.rows);
    for (const level of book.asks) accumulate(raw, level, this.bucket, origin, this.rows);
    const base = this.headIndex * this.rows;
    for (let row = 0; row < this.rows; row += 1) {
      const size = raw[row]!;
      this.values[base + row] = size > 0 ? Math.min(255, Math.max(1, Math.round(Math.log1p(size) * this.scale))) : 0;
    }
    const lowestBid = Number(book.bids.at(-1)?.px);
    const highestAsk = Number(book.asks.at(-1)?.px);
    this.trackWalls(sec, origin, raw, bestBid, bestAsk, lowestBid, highestAsk);
    this.version += 1;
  }

  private trackWalls(sec: number, origin: number, raw: Float64Array, bestBid: number, bestAsk: number, lowestBid: number, highestAsk: number) {
    const sizes: number[] = [];
    let total = 0;
    for (const value of raw) {
      if (value <= 0) continue;
      sizes.push(value);
      total += value;
    }
    if (sizes.length < 12) return;
    sizes.sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)]!;
    const threshold = Math.max(median * WALL_MEDIAN_MULTIPLE, total * WALL_MIN_SHARE);
    const seen = new Set<number>();
    for (let row = 0; row < this.rows; row += 1) {
      const size = raw[row]!;
      if (size < threshold) continue;
      const abs = origin + row;
      const price = abs * this.bucket;
      const side: "bid" | "ask" = price <= bestBid ? "bid" : "ask";
      const existing = this.walls.get(abs);
      if (existing) {
        existing.lastSec = sec;
        existing.last = size;
        existing.peak = Math.max(existing.peak, size);
      } else {
        this.walls.set(abs, { abs, side, firstSec: sec, lastSec: sec, peak: size, last: size });
      }
      seen.add(abs);
    }
    for (const [abs, wall] of this.walls) {
      if (seen.has(abs)) continue;
      const row = abs - origin;
      const current = row >= 0 && row < this.rows ? raw[row]! : 0;
      if (current > wall.peak * WALL_GONE_RATIO) {
        wall.lastSec = sec;
        wall.last = current;
        continue;
      }
      this.walls.delete(abs);
      if (wall.lastSec - wall.firstSec < WALL_MIN_SECONDS) continue;
      const price = abs * this.bucket;
      // 价格走远后该价位滑出 400 档快照：只是看不到了，不是撤单，也不是成交。
      const outOfRange = wall.side === "bid" ? !(price >= lowestBid) : !(price <= highestAsk);
      if (outOfRange) continue;
      const traded = this.tradedAt(price, wall.lastSec - 1, sec + 1);
      const removed = Math.max(wall.last - current, 0);
      const reached = wall.side === "bid" ? bestBid <= price + this.bucket : bestAsk >= price;
      this.pushEvent({
        kind: reached && traded >= removed * EATEN_TRADE_SHARE ? "eaten" : "pulled",
        side: wall.side,
        price,
        size: wall.last,
        tradedSize: traded,
        firstSeenSec: wall.firstSec,
        timeSec: sec
      });
    }
  }

  private pushEvent(event: Omit<LiquidityEvent, "id" | "detectedAt">) {
    this.eventSeq += 1;
    this.events.push({ ...event, id: this.eventSeq, detectedAt: performance.now() });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  /** [fromSec, toSec] 内成交价落在该价格桶里的总量（张）。 */
  tradedAt(price: number, fromSec: number, toSec: number) {
    const low = Math.floor(price / this.bucket) * this.bucket;
    const high = low + this.bucket;
    let total = 0;
    this.forEachTrade(fromSec, toSec, (_time, tradePrice, size) => {
      if (tradePrice >= low && tradePrice < high) total += size;
    });
    return total;
  }

  forEachTrade(fromSec: number, toSec: number, visit: (time: number, price: number, size: number, buy: boolean) => void) {
    for (let offset = 1; offset <= this.tradeCount; offset += 1) {
      const index = (this.tradeHead - offset + TRADE_CAPACITY) % TRADE_CAPACITY;
      const time = this.tradeTime[index]!;
      if (time < fromSec) break;
      if (time > toSec) continue;
      visit(time, this.tradePrice[index]!, this.tradeSize[index]!, this.tradeBuy[index] === 1);
    }
  }

  /** 最近 lookback 列的量化分布分位（0-1），供热力图自动色阶。 */
  levels(lookback = 300): { floor: number; ceil: number } | null {
    if (this.headIndex < 0) return null;
    const histogram = new Uint32Array(256);
    let count = 0;
    const span = Math.min(lookback, this.filled);
    for (let age = 0; age < span; age += 1) {
      const base = ((this.headIndex - age + this.columns) % this.columns) * this.rows;
      for (let row = 0; row < this.rows; row += 1) {
        const value = this.values[base + row]!;
        if (value === 0) continue;
        histogram[value]! += 1;
        count += 1;
      }
    }
    if (count < 50) return null;
    const quantile = (share: number) => {
      const target = count * share;
      let seen = 0;
      for (let value = 1; value < 256; value += 1) {
        seen += histogram[value]!;
        if (seen >= target) return value / 255;
      }
      return 1;
    };
    const floor = quantile(0.3);
    return { floor, ceil: Math.max(quantile(0.995), floor + 0.05) };
  }

  /** 某秒某价格的挂单量（由量化值反解，近似）。 */
  restingAt(sec: number, price: number): number | null {
    if (this.headIndex < 0 || this.bucket <= 0) return null;
    const age = this.headSec - Math.floor(sec);
    if (age < 0 || age >= this.filled) return null;
    const index = (this.headIndex - age + this.columns) % this.columns;
    const row = Math.floor(price / this.bucket) - this.origins[index]!;
    if (row < 0 || row >= this.rows) return null;
    const value = this.values[index * this.rows + row]!;
    return value === 0 ? 0 : Math.expm1(value / this.scale);
  }

  snapshot(): LiquiditySnapshot | null {
    if (!this.instId || this.headIndex < 0) return null;
    return {
      instId: this.instId,
      bucket: this.bucket,
      scale: this.scale,
      columns: this.columns,
      rows: this.rows,
      values: this.values,
      origins: this.origins,
      headIndex: this.headIndex,
      headSec: this.headSec,
      filled: this.filled,
      version: this.version
    };
  }
}

function accumulate(raw: Float64Array, level: { px: string; sz: string }, bucket: number, origin: number, rows: number) {
  const price = Number(level.px);
  const size = Number(level.sz);
  if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) return;
  const row = Math.floor(price / bucket) - origin;
  if (row >= 0 && row < rows) raw[row]! += size;
}

export function niceStep(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return Number((nice * base).toPrecision(6));
}

export const liquidityHistory = new LiquidityHistory();

export function ingestLiquidityBook(instId: string, book: OrderBook) {
  liquidityHistory.ingestBook(instId, book);
}

export function ingestLiquidityTrades(instId: string, trades: readonly Trade[]) {
  liquidityHistory.ingestTrades(instId, trades);
}
