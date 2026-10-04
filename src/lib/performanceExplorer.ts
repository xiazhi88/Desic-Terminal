/**
 * 账户绩效工作台的纯逻辑：来源 / 品种 / 时间三个维度联动筛选，以及由此得到的统计、曲线、日历。
 * 不依赖 React / Tauri，可直接用 node 测试。数据来自已平仓位（ReviewTrade）。
 */
import type { ReviewTrade, TradeSource } from "./tradeReviewModel";

export type TimeRange = readonly [number, number];
export type Filters = { sources: ReadonlySet<TradeSource>; symbols: ReadonlySet<string>; time: TimeRange | null };
export type Dimension = "source" | "symbol" | "time";

export const EMPTY_FILTERS: Filters = { sources: new Set(), symbols: new Set(), time: null };

/** 按筛选取交易；`skip` 里的维度不参与（用来算「如果不限定这一维会怎样」）。 */
export function selectTrades(trades: readonly ReviewTrade[], window: TimeRange, filters: Filters, skip: readonly Dimension[] = []): ReviewTrade[] {
  const [from, to] = window;
  return trades.filter((trade) => {
    if (trade.closeTime < from || trade.closeTime > to) return false;
    if (!skip.includes("source") && filters.sources.size > 0 && !filters.sources.has(trade.source)) return false;
    if (!skip.includes("symbol") && filters.symbols.size > 0 && !filters.symbols.has(trade.base)) return false;
    if (!skip.includes("time") && filters.time && (trade.closeTime < filters.time[0] || trade.closeTime > filters.time[1])) return false;
    return true;
  });
}

export type Stats = { count: number; net: number; winRate: number | null; profitFactor: number | null; avgHoldMs: number | null; maxDrawdown: number };

export function computeStats(trades: readonly ReviewTrade[]): Stats {
  const ordered = [...trades].sort((a, b) => a.closeTime - b.closeTime);
  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  let run = 0;
  let peak = 0;
  let drawdown = 0;
  let hold = 0;
  for (const trade of ordered) {
    if (trade.netPnl > 0) {
      wins += 1;
      grossProfit += trade.netPnl;
    } else if (trade.netPnl < 0) grossLoss -= trade.netPnl;
    run += trade.netPnl;
    peak = Math.max(peak, run);
    drawdown = Math.max(drawdown, peak - run);
    hold += trade.holdMs;
  }
  const count = ordered.length;
  return {
    count,
    net: run,
    winRate: count ? (wins / count) * 100 : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    avgHoldMs: count ? hold / count : null,
    maxDrawdown: drawdown,
  };
}

/** 把窗口等分成 `bins` 段，返回每段末尾的累计净盈亏。 */
export function cumulativeCurve(trades: readonly ReviewTrade[], window: TimeRange, bins: number): number[] {
  const [from, to] = window;
  const ordered = [...trades].sort((a, b) => a.closeTime - b.closeTime);
  const out = new Array<number>(bins).fill(0);
  let cursor = 0;
  let run = 0;
  for (let index = 0; index < bins; index += 1) {
    const end = from + ((to - from) * (index + 1)) / bins;
    while (cursor < ordered.length && ordered[cursor].closeTime <= end) run += ordered[cursor++].netPnl;
    out[index] = run;
  }
  return out;
}

export type GroupRow = { key: string; stats: Stats };

/** 某一维的每个取值各自的统计；该维自己的筛选不参与，其余维度参与（所以会交叉联动）。 */
export function groupBy(trades: readonly ReviewTrade[], window: TimeRange, filters: Filters, dimension: "source" | "symbol"): GroupRow[] {
  const pool = selectTrades(trades, window, filters, [dimension]);
  const buckets = new Map<string, ReviewTrade[]>();
  for (const trade of pool) {
    const key = dimension === "source" ? trade.source : trade.base;
    const list = buckets.get(key);
    if (list) list.push(trade);
    else buckets.set(key, [trade]);
  }
  // 已选中但在当前交叉条件下没有交易的取值也要保留，否则用户找不到取消它的地方。
  const selected = dimension === "source" ? filters.sources : filters.symbols;
  for (const key of selected) if (!buckets.has(key)) buckets.set(key, []);
  return [...buckets.entries()].map(([key, list]) => ({ key, stats: computeStats(list) }));
}

export const dayStart = (time: number) => {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

export type DayCell = { start: number; net: number | null; count: number };

/** 窗口内每天一格（本地时区）；没有交易的日子 net 为 null。 */
export function dailyCells(trades: readonly ReviewTrade[], window: TimeRange): DayCell[] {
  const byDay = new Map<number, { net: number; count: number }>();
  for (const trade of trades) {
    const key = dayStart(trade.closeTime);
    const entry = byDay.get(key) ?? { net: 0, count: 0 };
    entry.net += trade.netPnl;
    entry.count += 1;
    byDay.set(key, entry);
  }
  const cells: DayCell[] = [];
  const cursor = new Date(dayStart(window[0]));
  const last = dayStart(window[1]);
  while (cursor.getTime() <= last && cells.length < 400) {
    const entry = byDay.get(cursor.getTime());
    cells.push({ start: cursor.getTime(), net: entry ? entry.net : null, count: entry?.count ?? 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return cells;
}

export type Scope = { filtered: boolean; sources: TradeSource[]; symbols: string[]; time: TimeRange | null };

export function describeScope(filters: Filters): Scope {
  return { filtered: filters.sources.size > 0 || filters.symbols.size > 0 || filters.time !== null, sources: [...filters.sources], symbols: [...filters.symbols], time: filters.time };
}

/** 单日选择：筛选时间恰好是某一天。 */
export function isSingleDay(time: TimeRange | null): boolean {
  return time !== null && dayStart(time[0]) === time[0] && time[1] - time[0] <= 86_400_000;
}

/** 点日历：再点同一天取消，否则选中那一天。 */
export function toggleDay(current: TimeRange | null, start: number): TimeRange | null {
  if (current && isSingleDay(current) && current[0] === start) return null;
  return [start, start + 86_400_000 - 1];
}
