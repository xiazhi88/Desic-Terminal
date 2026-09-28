/*
 * replayTheaterModel.ts — 回放剧场的纯数据模型（无 DOM / IO）。
 * 移植自 viz/prototypes/replay-theater.html 的第 1 节。
 *
 * 数据来源全部是 SystematicBacktestDetail 的分页投影：
 *   - closedTrades / fills：最后一页携带完整前缀（backend 按页末时间截断），
 *   - equityCurve：当前页逐根精确 + 全区间按桶保留 min/max 的上下文点，
 *   - replaySnapshots：只在持仓状态变化处记录，每页带一条 carry-in，
 *   - strategyActions：只含当前页窗口。
 * 报告里没有 action ↔ fill ↔ trade 的 ID，关联全部按时间推断（与原型同口径）。
 */
import type {
  SystematicBacktestDetail,
  SystematicBacktestFill,
  SystematicClosedBar,
  SystematicClosedTrade,
  SystematicEquityPoint,
  SystematicReplaySnapshot,
  SystematicStrategyActionEvent,
} from "../../lib/systematic";

export const ONE_MINUTE_MS = 60_000;
/** Pages are requested at the backend maximum so a month is ~9 round trips. */
export const THEATER_PAGE_BARS = 5_000;

const ENTRY_REASONS = new Set(["targetIncrease", "targetFlipEntry", "limitEntry", "target_increase", "target_flip_entry", "limit_entry"]);
const ENGINE_REASONS = new Set([
  "protectiveStop", "protectiveTakeProfit", "endOfRunClose", "marginExhaustion",
  "protective_stop", "protective_take_profit", "end_of_run_close", "margin_exhaustion",
]);

export const isEntryReason = (reason: string) => ENTRY_REASONS.has(reason);
export const isEngineReason = (reason: string) => ENGINE_REASONS.has(reason);

/** Continuous bar coordinate: bar `i` (global, preload first) occupies [i, i + 1]. */
export type TheaterTimeline = {
  t0: number;
  stepMs: number;
  preloadBars: number;
  evalBars: number;
  totalBars: number;
  evalStartMs: number;
};

export function buildTimeline(detail: SystematicBacktestDetail): TheaterTimeline {
  const bars = detail.bars;
  let stepMs = ONE_MINUTE_MS;
  if (bars.length >= 2) {
    const diff = bars[1]!.openTimeMs - bars[0]!.openTimeMs;
    if (Number.isFinite(diff) && diff > 0) stepMs = diff;
  }
  const evalStartMs = detail.evaluationStartAt
    ?? (bars[0] ? bars[0].openTimeMs - detail.barOffset * stepMs : 0);
  const preloadBars = Math.max(0, detail.preloadBarCount || 0);
  const evalBars = Math.max(0, detail.totalBarCount || 0);
  return {
    t0: evalStartMs - preloadBars * stepMs,
    stepMs,
    preloadBars,
    evalBars,
    totalBars: preloadBars + evalBars,
    evalStartMs,
  };
}

export const uOfT = (tl: TheaterTimeline, t: number) => (t - tl.t0) / tl.stepMs;
export const tOfU = (tl: TheaterTimeline, u: number) => tl.t0 + u * tl.stepMs;

// ─────────────────────────────────────────────────────────────
// K 线存储：按全局 K 线下标的定长数组，页到达时写入
// ─────────────────────────────────────────────────────────────
export class TheaterBarStore {
  readonly open: Float64Array;
  readonly high: Float64Array;
  readonly low: Float64Array;
  readonly close: Float64Array;
  readonly loaded: Uint8Array;
  loadedCount = 0;

  constructor(readonly tl: TheaterTimeline) {
    const n = Math.max(1, tl.totalBars);
    this.open = new Float64Array(n);
    this.high = new Float64Array(n);
    this.low = new Float64Array(n);
    this.close = new Float64Array(n);
    this.loaded = new Uint8Array(n);
  }

  /** Writes one detail page. `barOffset` counts evaluation bars. */
  addPage(bars: readonly SystematicClosedBar[]) {
    for (const bar of bars) {
      const i = Math.round(uOfT(this.tl, bar.openTimeMs));
      if (i < 0 || i >= this.tl.totalBars) continue;
      if (!this.loaded[i]) this.loadedCount += 1;
      this.open[i] = bar.open;
      this.high[i] = bar.high;
      this.low[i] = bar.low;
      this.close[i] = bar.close;
      this.loaded[i] = 1;
    }
  }

  has(i: number) {
    return i >= 0 && i < this.tl.totalBars && this.loaded[i] === 1;
  }
}

// ─────────────────────────────────────────────────────────────
// 覆盖区间：哪些评估 K 线区间的快照 / 动作已读取
// ─────────────────────────────────────────────────────────────
export class CoverageSet {
  private ranges: Array<[number, number]> = [];

  add(a: number, b: number) {
    if (!(b > a)) return;
    const next: Array<[number, number]> = [];
    let lo = a;
    let hi = b;
    for (const [x, y] of this.ranges) {
      if (y < lo || x > hi) next.push([x, y]);
      else { lo = Math.min(lo, x); hi = Math.max(hi, y); }
    }
    next.push([lo, hi]);
    next.sort((l, r) => l[0] - r[0]);
    this.ranges = next;
  }

  covers(a: number, b: number) {
    return this.ranges.some(([x, y]) => x <= a && y >= b);
  }

  contains(u: number) {
    return this.ranges.some(([x, y]) => u >= x && u <= y);
  }

  list(): ReadonlyArray<readonly [number, number]> {
    return this.ranges;
  }

  coveredLength() {
    return this.ranges.reduce((sum, [x, y]) => sum + (y - x), 0);
  }
}

// ─────────────────────────────────────────────────────────────
// 持仓回合：closedTrades 按 (entryTimeMs, side) 聚合——一次分批平仓会产生多条 closedTrade
// ─────────────────────────────────────────────────────────────
export type TheaterClose = SystematicClosedTrade & { idx: number };
export type TheaterSegment = { u0: number; u1: number; frac: number };
export type TheaterRound = {
  id: number;
  key: string;
  side: string;
  entryTimeMs: number;
  entryPrice: number;
  closes: TheaterClose[];
  qty0: number;
  exitTimeMs: number;
  exitAvg: number;
  net: number;
  gross: number;
  fees: number;
  funding: number;
  margin: number;
  lastReason: string;
  partials: number;
  u0: number;
  u1: number;
  fills: SystematicBacktestFill[];
  segs: TheaterSegment[];
};

export function groupRounds(
  closedTrades: readonly SystematicClosedTrade[],
  fills: readonly SystematicBacktestFill[],
  tl: TheaterTimeline,
): TheaterRound[] {
  const map = new Map<string, TheaterRound>();
  const rounds: TheaterRound[] = [];
  closedTrades.forEach((trade, idx) => {
    const key = `${trade.entryTimeMs}:${trade.side}`;
    let round = map.get(key);
    if (!round) {
      round = {
        id: 0, key, side: trade.side, entryTimeMs: trade.entryTimeMs, entryPrice: trade.entryPrice,
        closes: [], qty0: 0, exitTimeMs: trade.exitTimeMs, exitAvg: 0, net: 0, gross: 0, fees: 0, funding: 0,
        margin: 0, lastReason: trade.exitReason, partials: 0, u0: 0, u1: 0, fills: [], segs: [],
      };
      map.set(key, round);
      rounds.push(round);
    }
    round.closes.push({ ...trade, idx });
  });
  rounds.sort((a, b) => a.entryTimeMs - b.entryTimeMs || a.side.localeCompare(b.side));
  // Fills are sorted by time in the ledger; a bounded window scan per round.
  const sortedFills = fills.slice().sort((a, b) => a.timeMs - b.timeMs);
  rounds.forEach((round, index) => {
    round.closes.sort((a, b) => a.exitTimeMs - b.exitTimeMs || a.idx - b.idx);
    const sum = (pick: (close: TheaterClose) => number) => round.closes.reduce((acc, close) => acc + pick(close), 0);
    round.id = index + 1;
    round.qty0 = sum((close) => close.quantity);
    const last = round.closes[round.closes.length - 1]!;
    round.exitTimeMs = last.exitTimeMs;
    round.exitAvg = round.qty0 > 0 ? sum((close) => close.quantity * close.exitPrice) / round.qty0 : last.exitPrice;
    round.net = sum((close) => close.netPnlUsdt);
    round.gross = sum((close) => close.grossPnlUsdt);
    round.fees = sum((close) => close.entryFeeUsdt + close.exitFeeUsdt);
    round.funding = sum((close) => close.fundingCashflowUsdt);
    round.margin = sum((close) => close.usedMarginUsdt);
    round.lastReason = last.exitReason;
    round.partials = round.closes.length - 1;
    round.u0 = uOfT(tl, round.entryTimeMs);
    round.u1 = uOfT(tl, round.exitTimeMs);
    // 成交只能按时间关联：开仓类成交只在开仓时刻（或回合内同向加仓）计入，
    // 平仓类成交在 (开仓, 平仓] 内计入；反手时同一时刻的平/开分属两个回合。
    const openSide = round.side === "short" ? "sell" : "buy";
    round.fills = sortedFills.filter((fill) => {
      if (fill.timeMs < round.entryTimeMs || fill.timeMs > round.exitTimeMs) return false;
      if (isEntryReason(fill.reason)) {
        if (fill.side !== openSide) return false;
        return fill.timeMs === round.entryTimeMs || fill.timeMs < round.exitTimeMs;
      }
      return fill.timeMs !== round.entryTimeMs;
    });
    let remaining = round.qty0;
    let start = round.entryTimeMs;
    round.segs = round.closes.map((close) => {
      const seg = { u0: uOfT(tl, start), u1: uOfT(tl, close.exitTimeMs), frac: round.qty0 > 0 ? remaining / round.qty0 : 1 };
      remaining -= close.quantity;
      start = close.exitTimeMs;
      return seg;
    });
  });
  return rounds;
}

export function roundActions(round: TheaterRound, actions: readonly SystematicStrategyActionEvent[]) {
  return actions.filter((event) => event.asOfMs >= round.entryTimeMs
    && event.asOfMs <= round.exitTimeMs
    && event.action.kind !== "no_action");
}

export type TheaterActionGroup = {
  kind: string;
  first: SystematicStrategyActionEvent;
  lastA: SystematicStrategyActionEvent;
  items: SystematicStrategyActionEvent[];
};

/** 连续的 set_protection（追踪止损）合并成一条。 */
export function groupActions(actions: readonly SystematicStrategyActionEvent[]): TheaterActionGroup[] {
  const out: TheaterActionGroup[] = [];
  for (const event of actions) {
    const last = out[out.length - 1];
    if (last && event.action.kind === "set_protection" && last.kind === "set_protection") {
      last.items.push(event);
      last.lastA = event;
    } else {
      out.push({ kind: event.action.kind, first: event, lastA: event, items: [event] });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 权益 / 高水位 / 水下回撤：由 equityCurve 直接推导
// ─────────────────────────────────────────────────────────────
export type EquitySeries = {
  u: Float64Array;
  timeMs: Float64Array;
  equity: Float64Array;
  hwm: Float64Array;
  dd: Float64Array;
  minIdx: number;
  count: number;
  points: SystematicEquityPoint[];
};

export function mergeEquityPoints(store: Map<number, SystematicEquityPoint>, points: readonly SystematicEquityPoint[]) {
  let changed = false;
  for (const point of points) {
    if (!Number.isFinite(point.timeMs) || !Number.isFinite(point.equityUsdt)) continue;
    const prev = store.get(point.timeMs);
    if (!prev || prev.equityUsdt !== point.equityUsdt) changed = true;
    store.set(point.timeMs, point);
  }
  return changed;
}

export function buildEquitySeries(store: ReadonlyMap<number, SystematicEquityPoint>, initial: number, tl: TheaterTimeline): EquitySeries {
  const points = [...store.values()].sort((a, b) => a.timeMs - b.timeMs);
  const count = points.length;
  const series: EquitySeries = {
    u: new Float64Array(count), timeMs: new Float64Array(count), equity: new Float64Array(count),
    hwm: new Float64Array(count), dd: new Float64Array(count), minIdx: -1, count, points,
  };
  let high = initial;
  points.forEach((point, k) => {
    high = Math.max(high, point.equityUsdt);
    series.u[k] = uOfT(tl, point.timeMs);
    series.timeMs[k] = point.timeMs;
    series.equity[k] = point.equityUsdt;
    series.hwm[k] = high;
    series.dd[k] = high > 0 ? point.equityUsdt / high - 1 : 0;
    if (series.minIdx < 0 || series.dd[k]! < series.dd[series.minIdx]!) series.minIdx = k;
  });
  return series;
}

/** Last index with u <= target, or -1. */
export function seriesIndexAtOrBefore(series: EquitySeries, u: number) {
  let lo = 0;
  let hi = series.count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series.u[mid]! <= u + 1e-9) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

// ─────────────────────────────────────────────────────────────
// 快照：只在状态变化处记录，按时间取「不晚于」的最近一条
// ─────────────────────────────────────────────────────────────
export function mergeSnapshots(current: readonly SystematicReplaySnapshot[], incoming: readonly SystematicReplaySnapshot[]) {
  if (!incoming.length) return current;
  const byTime = new Map<number, SystematicReplaySnapshot>();
  for (const snapshot of current) byTime.set(snapshot.timeMs, snapshot);
  for (const snapshot of incoming) if (Number.isFinite(snapshot.timeMs)) byTime.set(snapshot.timeMs, snapshot);
  return [...byTime.values()].sort((a, b) => a.timeMs - b.timeMs);
}

export function snapshotIndexAtOrBefore(snapshots: readonly SystematicReplaySnapshot[], timeMs: number) {
  let lo = 0;
  let hi = snapshots.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (snapshots[mid]!.timeMs <= timeMs) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

export function mergeActions(current: readonly SystematicStrategyActionEvent[], incoming: readonly SystematicStrategyActionEvent[]) {
  if (!incoming.length) return current;
  const key = (event: SystematicStrategyActionEvent) => `${event.asOfMs}|${event.action.kind}|${event.action.quantity ?? ""}|${event.action.reason ?? ""}`;
  const seen = new Map<string, SystematicStrategyActionEvent>();
  for (const event of current) seen.set(key(event), event);
  for (const event of incoming) if (event.action.kind !== "no_action") seen.set(key(event), event);
  return [...seen.values()].sort((a, b) => a.asOfMs - b.asOfMs);
}

// ─────────────────────────────────────────────────────────────
// 回放事件：策略动作（带 reason）+ 无对应动作的引擎成交（保护止损 / 期末平仓）
// ─────────────────────────────────────────────────────────────
export type TheaterEvent =
  | { u: number; type: "action"; action: SystematicStrategyActionEvent }
  | { u: number; type: "engine"; fill: SystematicBacktestFill; trade: SystematicClosedTrade | null };

export function buildEvents(
  actions: readonly SystematicStrategyActionEvent[],
  fills: readonly SystematicBacktestFill[],
  closedTrades: readonly SystematicClosedTrade[],
  tl: TheaterTimeline,
): TheaterEvent[] {
  const events: TheaterEvent[] = [];
  for (const action of actions) {
    if (action.action.kind !== "no_action") events.push({ u: uOfT(tl, action.asOfMs), type: "action", action });
  }
  for (const fill of fills) {
    if (!isEngineReason(fill.reason)) continue;
    const trade = closedTrades.find((item) => item.exitTimeMs === fill.timeMs && item.exitReason === fill.reason) ?? null;
    events.push({ u: uOfT(tl, fill.timeMs), type: "engine", fill, trade });
  }
  events.sort((a, b) => a.u - b.u);
  return events;
}

// ─────────────────────────────────────────────────────────────
// 推算指标：报告未提供，前端按公开口径计算并在界面上标注「推算」
// ─────────────────────────────────────────────────────────────
export type CalmarEstimate = { calmar: number | null; annualReturn: number; days: number };

/** 年化收益（单利，按评估天数）÷ 最大回撤。 */
export function estimateCalmar(netPnl: number, initialEquity: number, maxDrawdownPct: number, tl: TheaterTimeline): CalmarEstimate | null {
  const days = (tl.evalBars * tl.stepMs) / 86_400_000;
  if (!(initialEquity > 0) || !(days > 0)) return null;
  const ret = netPnl / initialEquity;
  const annualReturn = ret * (365 / days);
  const calmar = maxDrawdownPct > 0 ? annualReturn / (maxDrawdownPct / 100) : null;
  return { calmar, annualReturn, days };
}

export function maxAbsNet(rounds: readonly TheaterRound[]) {
  let max = 0;
  for (const round of rounds) max = Math.max(max, Math.abs(round.net));
  return max || 1;
}

export function pageOfEvalBar(evalBar: number) {
  return Math.max(0, Math.floor(evalBar / THEATER_PAGE_BARS));
}
