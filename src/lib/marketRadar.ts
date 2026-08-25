import type { MarketRadarResearchScore, OkxInstrumentSummary, Ticker } from "../types";

export type MarketRadarRow = {
  instrument: OkxInstrumentSummary;
  ticker: Ticker;
  last: number;
  change24hPct: number;
  amplitude24hPct: number;
  turnover24h: number;
  spreadBps: number | null;
  strengthScore: number;
  activityScore: number;
  liquidityScore: number;
  snapshotScore: number;
  research: MarketRadarResearchScore | null;
  compositeScore: number;
  rank: number;
};

function finiteNumber(value: string | number | null | undefined): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percentileMap(values: number[], higherIsBetter = true): Map<number, number> {
  const sorted = [...values].sort((left, right) => left - right);
  const result = new Map<number, number>();
  if (sorted.length <= 1) {
    if (sorted.length === 1) result.set(sorted[0], 0.5);
    return result;
  }

  let cursor = 0;
  while (cursor < sorted.length) {
    let end = cursor + 1;
    while (end < sorted.length && sorted[end] === sorted[cursor]) end += 1;
    const averageIndex = (cursor + end - 1) / 2;
    const percentile = averageIndex / (sorted.length - 1);
    result.set(sorted[cursor], higherIsBetter ? percentile : 1 - percentile);
    cursor = end;
  }
  return result;
}

export function buildMarketRadarRows(
  instruments: OkxInstrumentSummary[],
  tickers: Ticker[],
  researchScores: MarketRadarResearchScore[] = []
): MarketRadarRow[] {
  const tickerMap = new Map(tickers.map((ticker) => [ticker.instId, ticker]));
  const researchMap = new Map(researchScores.map((score) => [score.instId, score]));
  const raw = instruments
    .filter((instrument) => instrument.instType === "SWAP" && instrument.state === "live" && instrument.settleCcy === "USDT")
    .flatMap((instrument) => {
      const ticker = tickerMap.get(instrument.instId);
      if (!ticker) return [];
      const last = finiteNumber(ticker.last);
      const open24h = finiteNumber(ticker.open24h);
      const high24h = finiteNumber(ticker.high24h);
      const low24h = finiteNumber(ticker.low24h);
      const volumeCcy24h = finiteNumber(ticker.volCcy24h);
      const bid = finiteNumber(ticker.bidPx);
      const ask = finiteNumber(ticker.askPx);
      if (last == null || last <= 0 || open24h == null || open24h <= 0 || volumeCcy24h == null) return [];

      const midpoint = bid != null && ask != null && bid > 0 && ask >= bid ? (bid + ask) / 2 : null;
      return [{
        instrument,
        ticker,
        last,
        change24hPct: ((last / open24h) - 1) * 100,
        amplitude24hPct: high24h != null && low24h != null ? ((high24h - low24h) / open24h) * 100 : 0,
        turnover24h: Math.max(0, volumeCcy24h * last),
        spreadBps: midpoint != null && midpoint > 0 ? ((ask! - bid!) / midpoint) * 10_000 : null,
      }];
    });

  const strengthPercentiles = percentileMap(raw.map((row) => row.change24hPct));
  const activityPercentiles = percentileMap(raw.map((row) => Math.log1p(row.turnover24h)));
  const spreadValues = raw.flatMap((row) => row.spreadBps == null ? [] : [row.spreadBps]);
  const liquidityPercentiles = percentileMap(spreadValues, false);

  return raw
    .map((row) => {
      const strengthScore = (strengthPercentiles.get(row.change24hPct) ?? 0.5) * 100;
      const activityScore = (activityPercentiles.get(Math.log1p(row.turnover24h)) ?? 0.5) * 100;
      const liquidityScore = row.spreadBps == null ? 50 : (liquidityPercentiles.get(row.spreadBps) ?? 0.5) * 100;
      const snapshotScore = strengthScore * 0.4 + activityScore * 0.35 + liquidityScore * 0.25;
      const research = researchMap.get(row.instrument.instId) ?? null;
      return {
        ...row,
        strengthScore,
        activityScore,
        liquidityScore,
        snapshotScore,
        research,
        compositeScore: research ? research.compositeScore * 0.7 + snapshotScore * 0.3 : snapshotScore,
        rank: 0,
      };
    })
    .sort((left, right) => right.compositeScore - left.compositeScore || right.turnover24h - left.turnover24h)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

export type RadarFilterDefinition = {
  version: 1;
  category?: "1" | "3" | "4" | "5" | "6";
  minTurnover24h?: number;
  maxSpreadBps?: number;
  minCompositeScore?: number;
  minTrendQualityScore?: number;
  maxVolatility20dPct?: number;
  listedWithinDays?: number;
  historyReady?: boolean;
  watchlistOnly?: boolean;
};

export type NaturalRadarFilterResult = {
  definition: RadarFilterDefinition;
  recognized: string[];
  unsupported: string[];
};

export type MarketBreadthGroup = {
  category: string;
  count: number;
  advancing: number;
  declining: number;
  advancePct: number;
  positiveTrendPct: number;
  historyCoveragePct: number;
  medianChange24hPct: number;
  medianCompositeScore: number;
  strengthRank: number;
  turnover24h: number;
};

export function applyRadarFilter(
  rows: MarketRadarRow[],
  definition: RadarFilterDefinition,
  watchlist: string[] = [],
  now = Date.now()
): MarketRadarRow[] {
  const watched = new Set(watchlist);
  return rows.filter((row) => {
    if (definition.category && row.instrument.instCategory !== definition.category) return false;
    if (definition.minTurnover24h != null && row.turnover24h < definition.minTurnover24h) return false;
    if (definition.maxSpreadBps != null && (row.spreadBps == null || row.spreadBps > definition.maxSpreadBps)) return false;
    if (definition.minCompositeScore != null && row.compositeScore < definition.minCompositeScore) return false;
    if (definition.minTrendQualityScore != null && (row.research?.trendQualityScore ?? -1) < definition.minTrendQualityScore) return false;
    if (definition.maxVolatility20dPct != null && (row.research?.volatility20dPct ?? Number.POSITIVE_INFINITY) > definition.maxVolatility20dPct) return false;
    if (definition.historyReady === true && !row.research) return false;
    if (definition.watchlistOnly && !watched.has(row.instrument.instId)) return false;
    if (definition.listedWithinDays != null) {
      const listedAt = Number(row.instrument.listTime || 0);
      if (!(listedAt > 0) || now - listedAt > definition.listedWithinDays * 24 * 60 * 60_000) return false;
    }
    return true;
  });
}

export function parseNaturalRadarFilter(input: string): NaturalRadarFilterResult {
  const source = input.trim();
  const normalized = source.toLowerCase();
  const definition: RadarFilterDefinition = { version: 1 };
  const recognized: string[] = [];
  const consumed: Array<[number, number]> = [];
  const capture = (regex: RegExp, apply: (match: RegExpExecArray) => string) => {
    const match = regex.exec(normalized);
    if (!match) return;
    recognized.push(apply(match));
    consumed.push([match.index, match.index + match[0].length]);
  };

  const categories: Array<[RegExp, RadarFilterDefinition["category"], string]> = [
    [/(?:股票|stock(?:s)?)/i, "3", "category=stock"],
    [/(?:加密|crypto)/i, "1", "category=crypto"],
    [/(?:商品|commodity)/i, "4", "category=commodity"],
    [/(?:外汇|forex|\bfx\b)/i, "5", "category=fx"],
    [/(?:债券|bond)/i, "6", "category=bond"],
  ];
  for (const [regex, category, label] of categories) {
    const match = regex.exec(normalized);
    if (!match) continue;
    definition.category = category;
    recognized.push(label);
    consumed.push([match.index, match.index + match[0].length]);
    break;
  }

  capture(/(?:成交额|turnover)[^\d]{0,12}(?:>|≥|大于|至少|above|over|min(?:imum)?)?\s*([\d.]+)\s*(亿|万|m|k|b)?/i, (match) => {
    definition.minTurnover24h = scaledNumber(match[1], match[2]);
    return `turnover>=${definition.minTurnover24h}`;
  });
  capture(/(?:点差|spread)[^\d]{0,12}(?:<|≤|小于|不超过|below|max(?:imum)?)?\s*([\d.]+)\s*(?:bp|bps)?/i, (match) => {
    definition.maxSpreadBps = Number(match[1]);
    return `spread<=${definition.maxSpreadBps}bp`;
  });
  capture(/(?:综合(?:评分)?|composite|score)[^\d]{0,12}(?:>|≥|大于|至少|above|min(?:imum)?)?\s*([\d.]+)/i, (match) => {
    definition.minCompositeScore = Number(match[1]);
    return `composite>=${definition.minCompositeScore}`;
  });
  capture(/(?:趋势稳定性|trend(?: quality| stability)?)[^\d]{0,12}(?:>|≥|大于|至少|above|min(?:imum)?)?\s*([\d.]+)/i, (match) => {
    definition.minTrendQualityScore = Number(match[1]);
    return `trend>=${definition.minTrendQualityScore}`;
  });
  capture(/(?:波动率|volatility)[^\d]{0,12}(?:<|≤|小于|不超过|below|max(?:imum)?)?\s*([\d.]+)\s*%?/i, (match) => {
    definition.maxVolatility20dPct = Number(match[1]);
    return `volatility<=${definition.maxVolatility20dPct}%`;
  });
  capture(/(?:最近|近|within(?: the last)?)\s*([\d.]+)\s*(?:天|日|days?)[^，,。.]*(?:新|上线|listed)?/i, (match) => {
    definition.listedWithinDays = Number(match[1]);
    return `listedWithin=${definition.listedWithinDays}d`;
  });
  capture(/(?:历史(?:完整|就绪|可用)|history ready|with history)/i, () => {
    definition.historyReady = true;
    return "historyReady=true";
  });
  capture(/(?:仅?自选|watchlist only|in watchlist)/i, () => {
    definition.watchlistOnly = true;
    return "watchlistOnly=true";
  });

  for (const key of ["minTurnover24h", "maxSpreadBps", "minCompositeScore", "minTrendQualityScore", "maxVolatility20dPct", "listedWithinDays"] as const) {
    const value = definition[key];
    if (value != null && (!Number.isFinite(value) || value < 0)) delete definition[key];
  }
  const unsupported = source
    ? source.split(/[，,。;；]+/).map((part) => part.trim()).filter((part) => {
      const start = source.indexOf(part);
      const end = start + part.length;
      return part && !consumed.some(([left, right]) => left < end && right > start);
    })
    : [];
  return { definition, recognized, unsupported };
}

export function buildMarketBreadth(rows: MarketRadarRow[]): MarketBreadthGroup[] {
  const groups = new Map<string, MarketRadarRow[]>();
  groups.set("all", rows);
  for (const row of rows) {
    const category = row.instrument.instCategory || "other";
    const current = groups.get(category) ?? [];
    current.push(row);
    groups.set(category, current);
  }
  const breadth = [...groups.entries()].map(([category, group]) => {
    const advancing = group.filter((row) => row.change24hPct > 0).length;
    const declining = group.filter((row) => row.change24hPct < 0).length;
    const withHistory = group.filter((row) => row.research);
    return {
      category,
      count: group.length,
      advancing,
      declining,
      advancePct: ratio(advancing, group.length),
      positiveTrendPct: ratio(withHistory.filter((row) => (row.research?.relativeStrength30dPct ?? 0) > 0).length, withHistory.length),
      historyCoveragePct: ratio(withHistory.length, group.length),
      medianChange24hPct: median(group.map((row) => row.change24hPct)),
      medianCompositeScore: median(group.map((row) => row.compositeScore)),
      strengthRank: 0,
      turnover24h: group.reduce((sum, row) => sum + row.turnover24h, 0),
    };
  });
  const ranked = breadth.filter((group) => group.category !== "all").sort((left, right) => right.medianCompositeScore - left.medianCompositeScore);
  ranked.forEach((group, index) => { group.strengthRank = index + 1; });
  const all = breadth.find((group) => group.category === "all");
  return all ? [all, ...ranked] : ranked;
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator * 100 : 0;
}

function median(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function scaledNumber(value: string, suffix?: string) {
  const parsed = Number(value);
  const unit = suffix?.toLowerCase();
  if (unit === "亿") return parsed * 100_000_000;
  if (unit === "万") return parsed * 10_000;
  if (unit === "b") return parsed * 1_000_000_000;
  if (unit === "m") return parsed * 1_000_000;
  if (unit === "k") return parsed * 1_000;
  return parsed;
}

export function mergeTickerSnapshot(previous: Ticker[], incoming: Ticker[]): Ticker[] {
  const merged = new Map(previous.map((ticker) => [ticker.instId, ticker]));
  for (const ticker of incoming) {
    const current = merged.get(ticker.instId);
    if (!current || ticker.ts >= current.ts) merged.set(ticker.instId, ticker);
  }
  return [...merged.values()];
}
