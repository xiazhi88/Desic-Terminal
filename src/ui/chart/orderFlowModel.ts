import type { Candle } from "../../types";

// 订单流的纯计算：主动买卖差（Delta / CVD）按图表周期对齐，以及价格与 CVD 的背离。
// 只做确定性计算，不做方向判断；背离只描述“价格新高 / 新低时主动成交没有同步”这一事实。

export type TakerBucket = { ts: number; buy: number; sell: number };

export type DeltaPoint = { time: number; delta: number; cvd: number };

export type Divergence = {
  kind: "bearish" | "bullish";
  /** 两个价格摆点（秒）与对应价格。 */
  fromTime: number;
  toTime: number;
  fromPrice: number;
  toPrice: number;
};

export function timeframeSeconds(timeframe: string) {
  const match = /^(\d+)([smHDW])/.exec(timeframe);
  if (!match) return null;
  const unit = ({ s: 1, m: 60, H: 3_600, D: 86_400, W: 604_800 } as Record<string, number>)[match[2]!]!;
  return Number(match[1]) * unit;
}

/** 本地主动成交数据只有 5m 与 1H：15m 及以下用 5m，更高周期用 1H 再聚合。 */
export function takerPeriodFor(barSeconds: number): { period: "5m" | "1H"; seconds: number } {
  return barSeconds <= 900 ? { period: "5m", seconds: 300 } : { period: "1H", seconds: 3600 };
}

export function parseTakerItems(items: ReadonlyArray<Record<string, unknown>>): TakerBucket[] {
  const out: TakerBucket[] = [];
  for (const item of items) {
    const ts = Number(item.ts);
    const buy = Number(item.buyVol);
    const sell = Number(item.sellVol);
    if (!Number.isFinite(ts) || !Number.isFinite(buy) || !Number.isFinite(sell)) continue;
    out.push({ ts, buy, sell });
  }
  return out.sort((left, right) => left.ts - right.ts);
}

/**
 * 按“图表周期与数据周期中较粗者”对齐：1m 图上是每 5 分钟一个点（不把 5 分钟的量摊到 1 分钟，不插值），
 * 30m 图上每根聚合 6 个 5 分钟桶。CVD 从回看窗口的第一个点开始累计。
 */
export function buildDeltaSeries(buckets: readonly TakerBucket[], barSeconds: number, periodSeconds: number, fromSeconds: number): DeltaPoint[] {
  const resolution = Math.max(barSeconds, periodSeconds);
  const grouped = new Map<number, number>();
  for (const bucket of buckets) {
    const seconds = Math.floor(bucket.ts / 1000);
    if (seconds < fromSeconds) continue;
    const slot = Math.floor(seconds / resolution) * resolution;
    grouped.set(slot, (grouped.get(slot) ?? 0) + bucket.buy - bucket.sell);
  }
  let cvd = 0;
  return [...grouped.entries()].sort((left, right) => left[0] - right[0]).map(([time, delta]) => {
    cvd += delta;
    return { time, delta, cvd };
  });
}

/**
 * 背离：在 Delta 的时间分辨率上取价格摆点（前后各 k 个点都不更高 / 更低），比较最近相邻两个摆点：
 * 价格创更高的高点而 CVD 更低 → 偏空背离（主动买没跟上）；价格创更低的低点而 CVD 更高 → 偏多背离。
 */
export function detectDivergences(candles: readonly Candle[], deltas: readonly DeltaPoint[], resolution: number, k = 3, maxGap = 40): Divergence[] {
  if (deltas.length < k * 2 + 3) return [];
  const byTime = new Map(deltas.map((point) => [point.time, point.cvd]));
  // 把 K 线聚合到同一分辨率，同时记住极值实际出现在哪根 K 线上（连线端点画在那根 K 线，而不是时段起点）。
  const bars = new Map<number, { high: number; low: number; highTime: number; lowTime: number }>();
  for (const candle of candles) {
    const slot = Math.floor(candle.time / resolution) * resolution;
    const bar = bars.get(slot);
    if (bar) {
      if (candle.high > bar.high) {
        bar.high = candle.high;
        bar.highTime = candle.time;
      }
      if (candle.low < bar.low) {
        bar.low = candle.low;
        bar.lowTime = candle.time;
      }
    } else {
      bars.set(slot, { high: candle.high, low: candle.low, highTime: candle.time, lowTime: candle.time });
    }
  }
  const series = [...bars.entries()]
    .filter(([time]) => byTime.has(time))
    .sort((left, right) => left[0] - right[0])
    .map(([time, bar]) => ({ time, ...bar, cvd: byTime.get(time)! }));
  const pivots = (key: "high" | "low") => {
    const out: number[] = [];
    for (let index = k; index < series.length - k; index += 1) {
      const value = series[index]![key];
      let pivot = true;
      for (let offset = 1; offset <= k && pivot; offset += 1) {
        const left = series[index - offset]![key];
        const right = series[index + offset]![key];
        pivot = key === "high" ? value >= left && value > right : value <= left && value < right;
      }
      if (pivot) out.push(index);
    }
    return out;
  };
  const out: Divergence[] = [];
  const highs = pivots("high");
  for (let position = 1; position < highs.length; position += 1) {
    const a = series[highs[position - 1]!]!;
    const b = series[highs[position]!]!;
    if (highs[position]! - highs[position - 1]! > maxGap) continue;
    if (b.high > a.high && b.cvd < a.cvd) out.push({ kind: "bearish", fromTime: a.highTime, toTime: b.highTime, fromPrice: a.high, toPrice: b.high });
  }
  const lows = pivots("low");
  for (let position = 1; position < lows.length; position += 1) {
    const a = series[lows[position - 1]!]!;
    const b = series[lows[position]!]!;
    if (lows[position]! - lows[position - 1]! > maxGap) continue;
    if (b.low < a.low && b.cvd > a.cvd) out.push({ kind: "bullish", fromTime: a.lowTime, toTime: b.lowTime, fromPrice: a.low, toPrice: b.low });
  }
  // 每个方向只保留最近的一次：更早的背离已被后来的价格走势覆盖，全部画出只会让标签互相重叠。
  const latest = (kind: Divergence["kind"]) => out.filter((item) => item.kind === kind).sort((left, right) => left.toTime - right.toTime).at(-1);
  return [latest("bearish"), latest("bullish")].filter((item): item is Divergence => Boolean(item)).sort((left, right) => left.toTime - right.toTime);
}

export type LiquidationMark = { time: number; price: number; size: number; side: "long" | "short" };

/** 清算记录：side=sell / posSide=long 是多头被强平（被动卖出），反之为空头被强平。 */
export function parseLiquidations(items: ReadonlyArray<Record<string, unknown>>): LiquidationMark[] {
  const out: LiquidationMark[] = [];
  for (const item of items) {
    const ts = Number(item.ts);
    const price = Number(item.bkPx);
    const size = Number(item.sz);
    const side = String(item.side ?? "").toLowerCase();
    if (!Number.isFinite(ts) || !Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size <= 0) continue;
    out.push({ time: Math.floor(ts / 1000), price, size, side: side === "sell" || side === "long" ? "long" : "short" });
  }
  return out.sort((left, right) => left.time - right.time);
}
