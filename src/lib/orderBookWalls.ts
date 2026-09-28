import type { OrderBook } from "../types";

// 当前盘口跟踪（订单流模式用）：每个合约只保留最新的完整 400 档快照，并识别“当前大单墙”。
// 不保存盘口历史——墙只描述此刻的事实；“已挂多久”从本次运行首次观察到开始计，不外推。

const RECHECK_MS = 1000;
/** 墙：该价格桶挂单量 ≥ 本侧中位数 × 8，且占本侧可见总量 ≥ 2.5%。 */
const WALL_MEDIAN_MULTIPLE = 8;
const WALL_MIN_SHARE = 0.025;
/** 墙消失超过这个时长才移除（避免挂单刷新时闪烁）。 */
const WALL_GRACE_MS = 5000;
const WALLS_PER_SIDE = 3;

export type OrderBookWall = {
  side: "bid" | "ask";
  /** 桶下沿价格。 */
  price: number;
  size: number;
  firstSeenAt: number;
  lastSeenAt: number;
};

function niceStep(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return Number((nice * base).toPrecision(6));
}

class OrderBookWallTracker {
  instId: string | null = null;
  latestBook: OrderBook | null = null;
  /** 价格桶宽：跳价与中间价 1.5bp 取大，取整到 1/2/5 × 10^n。 */
  bucket = 0;
  walls = new Map<string, OrderBookWall>();
  private checkedAt = 0;
  private listeners = new Set<() => void>();

  hasListeners() {
    return this.listeners.size > 0;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  ingest(instId: string, book: OrderBook) {
    if (instId !== this.instId) {
      this.instId = instId;
      this.walls.clear();
      this.bucket = 0;
      this.checkedAt = 0;
    }
    this.latestBook = book;
    const now = Date.now();
    if (now - this.checkedAt >= RECHECK_MS) {
      this.checkedAt = now;
      this.detect(book, now);
    }
    for (const listener of this.listeners) listener();
  }

  currentWalls(): OrderBookWall[] {
    return [...this.walls.values()];
  }

  private detect(book: OrderBook, now: number) {
    const bestBid = Number(book.bids[0]?.px);
    const bestAsk = Number(book.asks[0]?.px);
    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return;
    if (this.bucket <= 0) {
      const tick = Math.max(0, bestAsk - bestBid) || bestBid * 1e-5;
      this.bucket = niceStep(Math.max(tick, ((bestBid + bestAsk) / 2) * 1.5e-5));
    }
    const seen = new Set<string>();
    for (const side of ["bid", "ask"] as const) {
      const levels = side === "bid" ? book.bids : book.asks;
      const buckets = new Map<number, number>();
      for (const level of levels) {
        const price = Number(level.px);
        const size = Number(level.sz);
        if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue;
        const index = Math.floor(price / this.bucket);
        buckets.set(index, (buckets.get(index) ?? 0) + size);
      }
      const sizes = [...buckets.values()].sort((left, right) => left - right);
      if (sizes.length < 8) continue;
      const total = sizes.reduce((sum, value) => sum + value, 0);
      const threshold = Math.max(sizes[Math.floor(sizes.length / 2)]! * WALL_MEDIAN_MULTIPLE, total * WALL_MIN_SHARE);
      const candidates = [...buckets.entries()].filter(([, size]) => size >= threshold).sort((left, right) => right[1] - left[1]).slice(0, WALLS_PER_SIDE);
      for (const [index, size] of candidates) {
        const key = `${side}:${index}`;
        seen.add(key);
        const existing = this.walls.get(key);
        if (existing) {
          existing.size = size;
          existing.lastSeenAt = now;
        } else {
          this.walls.set(key, { side, price: index * this.bucket, size, firstSeenAt: now, lastSeenAt: now });
        }
      }
    }
    for (const [key, wall] of this.walls) {
      if (!seen.has(key) && now - wall.lastSeenAt > WALL_GRACE_MS) this.walls.delete(key);
    }
  }
}

// 每个合约一个追踪器：同一窗口里可能同时有多个不同合约的图表（弹出图表多格），共用一个会互相清空。
const MAX_TRACKERS = 8;
const trackers = new Map<string, OrderBookWallTracker>();

export function orderBookWallsFor(instId: string): OrderBookWallTracker {
  const existing = trackers.get(instId);
  if (existing) {
    // 维持最近使用顺序，淘汰时先淘汰最久未用的。
    trackers.delete(instId);
    trackers.set(instId, existing);
    return existing;
  }
  const tracker = new OrderBookWallTracker();
  tracker.instId = instId;
  trackers.set(instId, tracker);
  for (const [key, candidate] of trackers) {
    if (trackers.size <= MAX_TRACKERS) break;
    if (candidate !== tracker && !candidate.hasListeners()) trackers.delete(key);
  }
  return tracker;
}

export function ingestOrderBookForWalls(instId: string, book: OrderBook) {
  orderBookWallsFor(instId).ingest(instId, book);
}
