/**
 * 交易复盘的纯逻辑：把已平仓位整理成「交易」，检测追单，统计习惯，生成体检结论，
 * 以及对单笔交易用 K 线做 MAE / MFE 与「止损被扫」判断。
 *
 * 不依赖 React / Tauri，可直接用 node 测试。所有结论都由规则从数字得出，样本不足不下结论。
 */
import type { Candle, PositionEpisode, TradeReviewNote, TradeReviewProtection } from "../types";

export type TradeSource = "manual" | "ai" | "strategy" | "mixed" | "system" | "exchange" | "unknown";
export type UiText = (zh: string, en: string) => string;

export const MIN_SAMPLE = 5;
/** 上一笔亏损平仓后多久内又开仓，算「追单」。 */
export const REVENGE_WINDOW_MS = 30 * 60_000;

export type ReviewTrade = {
  id: string;
  instId: string;
  base: string;
  side: "long" | "short";
  source: TradeSource;
  openTime: number;
  closeTime: number;
  holdMs: number;
  leverage: number | null;
  entry: number | null;
  exit: number | null;
  netPnl: number;
  fees: number;
  fundingFee: number;
  /** 加仓次数（OPEN 之后的 ADD 事件）。 */
  adds: number;
  /** 追单：上一笔亏损平仓后 30 分钟内开仓。 */
  revenge: boolean;
  gapMs: number | null;
  tags: string[];
  note: string;
  /** undefined = 还没有匹配过；false/true = 匹配结果（估计）。 */
  hadStop?: boolean;
  stopPx?: number | null;
  tpPx?: number | null;
  stopTriggered?: boolean;
};

const num = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function mapSource(origin: string | null | undefined): TradeSource {
  switch ((origin ?? "").toLowerCase()) {
    case "user":
    case "manual":
      return "manual";
    case "ai":
    case "agent":
    case "automation":
      return "ai";
    case "strategy":
      return "strategy";
    case "mixed":
      return "mixed";
    case "system":
      return "system";
    case "exchange":
      return "exchange";
    default:
      return "unknown";
  }
}

export function sourceLabel(source: TradeSource, text: UiText): string {
  const map: Record<TradeSource, [string, string]> = {
    manual: ["手动", "Manual"],
    ai: ["AI", "AI"],
    strategy: ["策略", "Strategy"],
    mixed: ["混合", "Mixed"],
    system: ["系统", "System"],
    exchange: ["交易所记录", "Exchange"],
    unknown: ["未知", "Unknown"],
  };
  return text(...map[source]);
}

/** 只取已平仓、有平仓时间且净盈亏可知的仓位；按开仓时间升序整理，并检测追单。 */
export function buildReviewTrades(
  episodes: readonly PositionEpisode[],
  notes: readonly TradeReviewNote[] = [],
  protections: readonly TradeReviewProtection[] = [],
): ReviewTrade[] {
  const noteById = new Map(notes.map((item) => [item.episodeId, item]));
  const protectionById = new Map(protections.map((item) => [item.episodeId, item]));
  const trades: ReviewTrade[] = [];
  for (const episode of episodes) {
    if (episode.status !== "closed" || !episode.closeTime) continue;
    const netPnl = num(episode.netPnl) ?? num(episode.realizedPnl);
    if (netPnl === null) continue;
    const note = noteById.get(episode.id);
    const protection = protectionById.get(episode.id);
    trades.push({
      id: episode.id,
      instId: episode.instId,
      base: episode.instId.replace(/-USDT-SWAP$/, ""),
      side: episode.episodeSide === "short" ? "short" : "long",
      source: mapSource(episode.primaryOrigin),
      openTime: episode.openTime,
      closeTime: episode.closeTime,
      holdMs: Math.max(0, episode.closeTime - episode.openTime),
      leverage: num(episode.initialLever) ?? num(episode.finalLever),
      entry: num(episode.avgOpenPx),
      exit: num(episode.avgClosePx),
      netPnl,
      fees: Math.abs(num(episode.fees) ?? 0),
      fundingFee: num(episode.fundingFee) ?? 0,
      adds: episode.events.filter((event) => event.eventType === "ADD").length,
      revenge: false,
      gapMs: null,
      tags: note?.tags ?? [],
      note: note?.note ?? "",
      ...(protection ? { hadStop: protection.hadStop, stopPx: protection.stopPx ?? null, tpPx: protection.tpPx ?? null, stopTriggered: protection.stopTriggered } : {}),
    });
  }
  trades.sort((a, b) => a.openTime - b.openTime);
  // 追单：与「此前最近一次平仓」比较，不限合约（情绪是跨品种的）。
  for (let i = 0; i < trades.length; i += 1) {
    let previous: ReviewTrade | null = null;
    for (let j = 0; j < i; j += 1) {
      if (trades[j].closeTime <= trades[i].openTime && (!previous || trades[j].closeTime > previous.closeTime)) previous = trades[j];
    }
    if (previous) {
      const gap: number = trades[i].openTime - previous.closeTime;
      trades[i].gapMs = gap;
      trades[i].revenge = previous.netPnl < 0 && gap <= REVENGE_WINDOW_MS;
    }
  }
  return trades;
}

export const sum = (trades: readonly ReviewTrade[]) => trades.reduce((total, trade) => total + trade.netPnl, 0);
export const winRate = (trades: readonly ReviewTrade[]) => (trades.length ? trades.filter((trade) => trade.netPnl > 0).length / trades.length : 0);

// ───────────── 习惯统计 ─────────────

export type HeatCell = { n: number; pnl: number };

/** 星期（周一 = 0）× 4 小时段的盈亏。按开仓时间的本地时间归类。 */
export function buildHeatmap(trades: readonly ReviewTrade[]): HeatCell[][] {
  const cells: HeatCell[][] = Array.from({ length: 7 }, () => Array.from({ length: 6 }, () => ({ n: 0, pnl: 0 })));
  for (const trade of trades) {
    const date = new Date(trade.openTime);
    const cell = cells[(date.getDay() + 6) % 7][Math.floor(date.getHours() / 4)];
    cell.n += 1;
    cell.pnl += trade.netPnl;
  }
  return cells;
}

export type Bucket = { key: string; trades: ReviewTrade[]; winRate: number; avg: number; enough: boolean };

const bucket = (key: string, trades: ReviewTrade[]): Bucket => ({ key, trades, winRate: winRate(trades), avg: trades.length ? sum(trades) / trades.length : 0, enough: trades.length >= MIN_SAMPLE });

/** 杠杆分档：≤3x / 4–10x / >10x。杠杆未知的交易不参与。 */
export function leverageBuckets(trades: readonly ReviewTrade[]): Bucket[] {
  const known = trades.filter((trade) => trade.leverage !== null);
  return [
    bucket("≤3x", known.filter((trade) => trade.leverage! <= 3)),
    bucket("4–10x", known.filter((trade) => trade.leverage! > 3 && trade.leverage! <= 10)),
    bucket(">10x", known.filter((trade) => trade.leverage! > 10)),
  ];
}

/** 带止损 vs 没止损；止损信息没匹配过的交易不参与。 */
export function stopBuckets(trades: readonly ReviewTrade[]): { withStop: Bucket; withoutStop: Bucket; coverage: number } {
  const known = trades.filter((trade) => trade.hadStop !== undefined);
  return {
    withStop: bucket("stop", known.filter((trade) => trade.hadStop)),
    withoutStop: bucket("nostop", known.filter((trade) => !trade.hadStop)),
    coverage: trades.length ? known.length / trades.length : 0,
  };
}

export function symbolBuckets(trades: readonly ReviewTrade[]): Bucket[] {
  const groups = new Map<string, ReviewTrade[]>();
  for (const trade of trades) groups.set(trade.base, [...(groups.get(trade.base) ?? []), trade]);
  return [...groups.entries()].map(([key, list]) => bucket(key, list)).sort((a, b) => b.trades.length - a.trades.length);
}

// ───────────── 体检结论 ─────────────

export type FindingFilter = "all" | "win" | "loss" | "revenge" | "nostop" | `sym:${string}`;
export type Finding = { id: string; tone: "warn" | "ok" | "info"; title: string; desc: string; filter?: FindingFilter; count?: number };

const pct = (value: number) => `${Math.round(value * 100)}%`;
const money = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(Math.abs(value) >= 100 ? 0 : 1)}`;

/** 最多 3 条，按影响金额排序，「好消息」排在警告之后；任何一条都必须能点开看到对应交易。 */
export function deriveFindings(trades: readonly ReviewTrade[], text: UiText): Finding[] {
  const out: (Finding & { score: number })[] = [];
  const revenge = trades.filter((trade) => trade.revenge);
  const rest = trades.filter((trade) => !trade.revenge);
  if (revenge.length >= MIN_SAMPLE) {
    out.push({
      id: "revenge",
      tone: "warn",
      score: Math.abs(sum(revenge)),
      title: text(`亏损后 30 分钟内又开仓：${revenge.length} 笔，胜率 ${pct(winRate(revenge))}，合计 ${money(sum(revenge))}U`, `Re-entering within 30 min of a loss: ${revenge.length} trades, win rate ${pct(winRate(revenge))}, ${money(sum(revenge))}U in total`),
      desc: rest.length >= MIN_SAMPLE ? text(`其他交易的胜率是 ${pct(winRate(rest))}。`, `Your other trades win ${pct(winRate(rest))} of the time.`) : "",
      filter: "revenge",
      count: revenge.length,
    });
  }
  const { withStop, withoutStop, coverage } = stopBuckets(trades);
  if (coverage >= 0.5 && withoutStop.trades.length >= MIN_SAMPLE && withStop.trades.length >= MIN_SAMPLE && withoutStop.avg < withStop.avg) {
    out.push({
      id: "nostop",
      tone: "warn",
      score: Math.abs(sum(withoutStop.trades)),
      title: text(`没设止损的交易：${withoutStop.trades.length} 笔，平均每笔 ${money(withoutStop.avg)}U`, `Trades without a stop: ${withoutStop.trades.length}, ${money(withoutStop.avg)}U each on average`),
      desc: text(`设了止损的交易平均每笔 ${money(withStop.avg)}U。止损信息由条件单历史匹配得出，属于估计。`, `Trades with a stop average ${money(withStop.avg)}U. Stop info is matched from algo-order history and is an estimate.`),
      filter: "nostop",
      count: withoutStop.trades.length,
    });
  }
  const winners = trades.filter((trade) => trade.netPnl > 0);
  const losers = trades.filter((trade) => trade.netPnl < 0);
  if (winners.length >= MIN_SAMPLE && losers.length >= MIN_SAMPLE) {
    const avgWin = sum(winners) / winners.length;
    const avgLoss = Math.abs(sum(losers) / losers.length);
    const heldWin = winners.reduce((total, trade) => total + trade.holdMs, 0) / winners.length;
    const heldLoss = losers.reduce((total, trade) => total + trade.holdMs, 0) / losers.length;
    if (heldLoss > heldWin * 1.6 && avgLoss > avgWin) {
      out.push({
        id: "hold-losers",
        tone: "warn",
        score: Math.abs(sum(losers)),
        title: text(`亏损单拿得更久：平均 ${(heldLoss / 3_600_000).toFixed(1)} 小时，盈利单只有 ${(heldWin / 3_600_000).toFixed(1)} 小时`, `Losers are held longer: ${(heldLoss / 3_600_000).toFixed(1)} h vs ${(heldWin / 3_600_000).toFixed(1)} h for winners`),
        desc: text(`平均亏 ${avgLoss.toFixed(1)}U，平均赚 ${avgWin.toFixed(1)}U。`, `Average loss ${avgLoss.toFixed(1)}U, average win ${avgWin.toFixed(1)}U.`),
        filter: "loss",
        count: losers.length,
      });
    }
  }
  const best = symbolBuckets(trades).filter((item) => item.enough).sort((a, b) => b.winRate - a.winRate)[0];
  if (best && best.winRate > winRate(trades)) {
    out.push({
      id: `best-${best.key}`,
      tone: "ok",
      score: 1,
      title: text(`${best.key} 是你最稳的品种：${best.trades.length} 笔，胜率 ${pct(best.winRate)}，合计 ${money(sum(best.trades))}U`, `${best.key} is your steadiest market: ${best.trades.length} trades, win rate ${pct(best.winRate)}, ${money(sum(best.trades))}U`),
      desc: text(`全部交易的整体胜率是 ${pct(winRate(trades))}。`, `Overall win rate is ${pct(winRate(trades))}.`),
      filter: `sym:${best.key}`,
      count: best.trades.length,
    });
  }
  out.sort((a, b) => Number(a.tone === "ok") - Number(b.tone === "ok") || b.score - a.score);
  return out.slice(0, 3).map(({ score: _score, ...finding }) => finding);
}

export function matchesFilter(trade: ReviewTrade, filter: FindingFilter): boolean {
  if (filter === "all") return true;
  if (filter === "win") return trade.netPnl > 0;
  if (filter === "loss") return trade.netPnl < 0;
  if (filter === "revenge") return trade.revenge;
  if (filter === "nostop") return trade.hadStop === false;
  return trade.base === filter.slice(4);
}

// ───────────── 单笔：MAE / MFE 与点评 ─────────────

export type Excursion = {
  /** 持仓期间对你最不利的价格变动（%，≤ 0）。 */
  maePct: number;
  /** 持仓期间对你最有利的价格变动（%，≥ 0）。 */
  mfePct: number;
  /** 最终的价格变动（%，按持仓方向）。 */
  finalPct: number | null;
  /** 平仓后 4 小时内价格是否走到了你的止盈位（需要匹配到止盈价）。 */
  reachedTargetAfter: boolean | null;
  /** 样本里用到了多少根持仓期间的 K 线。 */
  bars: number;
};

/** K 线的 time 是秒；仓位时间是毫秒。 */
export function computeExcursion(trade: ReviewTrade, candles: readonly Candle[]): Excursion | null {
  if (trade.entry === null || trade.entry <= 0) return null;
  const dir = trade.side === "long" ? 1 : -1;
  const open = trade.openTime / 1000;
  const close = trade.closeTime / 1000;
  const during = candles.filter((candle) => candle.time + 1 >= open && candle.time <= close);
  if (during.length === 0) return null;
  const adverse = Math.min(...during.map((candle) => (dir > 0 ? candle.low - trade.entry! : trade.entry! - candle.high)));
  const favorable = Math.max(...during.map((candle) => (dir > 0 ? candle.high - trade.entry! : trade.entry! - candle.low)));
  let reachedTargetAfter: boolean | null = null;
  if (trade.tpPx && trade.tpPx > 0) {
    const after = candles.filter((candle) => candle.time > close && candle.time <= close + 4 * 3600);
    reachedTargetAfter = after.length === 0 ? null : after.some((candle) => (dir > 0 ? candle.high >= trade.tpPx! : candle.low <= trade.tpPx!));
  }
  return {
    maePct: Math.min(0, (adverse / trade.entry) * 100),
    mfePct: Math.max(0, (favorable / trade.entry) * 100),
    finalPct: trade.exit !== null ? (((trade.exit - trade.entry) * dir) / trade.entry) * 100 : null,
    reachedTargetAfter,
    bars: during.length,
  };
}

export type Verdict = { tone: "warn" | "info"; text: string };

export function describeTrade(trade: ReviewTrade, excursion: Excursion | null, text: UiText): Verdict[] {
  const out: Verdict[] = [];
  if (trade.revenge && trade.gapMs !== null) out.push({ tone: "warn", text: text(`这笔开在上一笔亏损平仓后 ${Math.max(1, Math.round(trade.gapMs / 60_000))} 分钟。追单整体胜率偏低，见体检结论。`, `Opened ${Math.max(1, Math.round(trade.gapMs / 60_000))} min after a losing close. Re-entries win less often overall.`) });
  if (trade.hadStop === false) out.push({ tone: "warn", text: text("没有匹配到止损单（可能是没挂，也可能条件单历史没同步到）。", "No stop-loss order was matched (none was set, or algo history is not synced).") });
  if (trade.stopTriggered && excursion?.reachedTargetAfter && trade.stopPx && trade.entry) {
    out.push({ tone: "warn", text: text(`止损被触发后，价格在 4 小时内走到了你的止盈位 ${trade.tpPx}。止损距离只有 ${(Math.abs(trade.entry - trade.stopPx) / trade.entry * 100).toFixed(2)}%，可能被正常波动扫掉。`, `After the stop triggered, price reached your target ${trade.tpPx} within 4 h. The stop was only ${(Math.abs(trade.entry - trade.stopPx) / trade.entry * 100).toFixed(2)}% away and may have been shaken out by normal noise.`) });
  }
  if (excursion) {
    if (trade.netPnl > 0 && excursion.maePct <= -0.8) out.push({ tone: "info", text: text(`持仓期间最多浮亏过 ${excursion.maePct.toFixed(2)}%，最后仍盈利。若止损更紧，这笔会被洗出去。`, `Drew down ${excursion.maePct.toFixed(2)}% at worst before ending in profit. A tighter stop would have shaken it out.`) });
    if (excursion.finalPct !== null && excursion.mfePct >= 1 && excursion.finalPct < excursion.mfePct * 0.4) {
      out.push({ tone: trade.netPnl <= 0 ? "warn" : "info", text: text(`持仓期间最多浮盈 ${excursion.mfePct.toFixed(2)}%，最终只拿到 ${excursion.finalPct.toFixed(2)}%，约 ${Math.round((1 - Math.max(0, excursion.finalPct) / excursion.mfePct) * 100)}% 的浮盈回吐了。`, `Peaked at +${excursion.mfePct.toFixed(2)}% but closed at ${excursion.finalPct.toFixed(2)}%: about ${Math.round((1 - Math.max(0, excursion.finalPct) / excursion.mfePct) * 100)}% of the open profit was given back.`) });
    }
  }
  if (out.length === 0) out.push({ tone: "info", text: text("这笔交易没有触发任何习惯类提示。", "Nothing unusual stood out in this trade.") });
  return out;
}

/** 回放用的周期：持仓越久，K 线越粗，保证窗口内根数在几百以内。 */
export function replayBar(holdMs: number): "5m" | "15m" | "1H" | "4H" {
  const hours = holdMs / 3_600_000;
  if (hours <= 3) return "5m";
  if (hours <= 12) return "15m";
  if (hours <= 120) return "1H";
  return "4H";
}
