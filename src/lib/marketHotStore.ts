import { create } from "zustand";
import type { Candle, FundingRate, OrderBook, PublicWsStatus, Ticker, Trade } from "../types";

type MarketHotState = {
  ticker: Ticker | null;
  watchTickers: Record<string, Ticker>;
  candles: Candle[];
  candleSeriesKey: string | null;
  book: OrderBook | null;
  trades: Trade[];
  fundingRate: FundingRate | null;
  publicStreamStatuses: Record<string, PublicWsStatus>;
  businessLastMessageAt: number | null;
};

const initialState: MarketHotState = {
  ticker: null,
  watchTickers: {},
  candles: [],
  candleSeriesKey: null,
  book: null,
  trades: [],
  fundingRate: null,
  publicStreamStatuses: {},
  businessLastMessageAt: null
};

export const useMarketHotStore = create<MarketHotState>(() => initialState);

let pendingTicker: Ticker | null | undefined;
let pendingBook: OrderBook | null | undefined;
let pendingFundingRate: FundingRate | null | undefined;
let pendingCandle: { candle: Candle; seriesKey: string | null } | undefined;
let pendingWatchTickers: Record<string, Ticker> = {};
let pendingTrades: Trade[] = [];
let pendingPublicStatuses: Record<string, PublicWsStatus> = {};
let pendingBusinessLastMessageAt: number | undefined;
let frameId: number | null = null;
const MAX_PENDING_TRADES = 128;
const MAX_RENDERED_TRADES = 32;
export const MAX_RENDERED_CANDLES = 50_000;

function newerSnapshot<T extends { ts: number }>(current: T | null, incoming: T | null): T | null {
  if (!incoming) return current;
  if (!current) return incoming;
  return incoming.ts >= current.ts ? incoming : current;
}

function tradeKey(trade: Trade) {
  return trade.tradeId || `${trade.ts}:${trade.side}:${trade.px}:${trade.sz}`;
}

function mergeLatestTrades(first: readonly Trade[], second: readonly Trade[], limit: number) {
  const byId = new Map<string, Trade>();
  for (const trade of [...first, ...second]) {
    const key = tradeKey(trade);
    const existing = byId.get(key);
    if (!existing || trade.ts >= existing.ts) byId.set(key, trade);
  }
  return [...byId.values()].sort((left, right) => right.ts - left.ts).slice(0, limit);
}

function tickerWithLatestTrade(ticker: Ticker | null, trades: readonly Trade[]) {
  const latestTrade = trades[0];
  if (!ticker || !latestTrade || latestTrade.ts <= ticker.ts) return ticker;
  return {
    ...ticker,
    last: latestTrade.px,
    lastSz: latestTrade.sz,
    ts: latestTrade.ts
  };
}

function requestFrame(callback: () => void) {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(callback);
  }
  return setTimeout(callback, 0) as unknown as number;
}

function schedulePublish() {
  if (frameId !== null) return;
  frameId = requestFrame(flushMarketFrame);
}

export function flushMarketFrame() {
  frameId = null;
  const current = useMarketHotStore.getState();
  const next: Partial<MarketHotState> = {};
  const mergedTrades = pendingTrades.length > 0
    ? mergeLatestTrades(pendingTrades, current.trades, MAX_RENDERED_TRADES)
    : current.trades;
  const queuedTicker = pendingTicker === undefined
    ? current.ticker
    : newerSnapshot(current.ticker, pendingTicker);
  const canonicalTicker = tickerWithLatestTrade(queuedTicker, mergedTrades);
  if (canonicalTicker !== current.ticker) next.ticker = canonicalTicker;
  if (pendingBook !== undefined) next.book = newerSnapshot(current.book, pendingBook);
  if (pendingFundingRate !== undefined) next.fundingRate = pendingFundingRate;
  if (Object.keys(pendingWatchTickers).length > 0 || canonicalTicker !== current.ticker) {
    const watchTickers = { ...current.watchTickers };
    for (const [instId, ticker] of Object.entries(pendingWatchTickers)) {
      watchTickers[instId] = newerSnapshot(watchTickers[instId] ?? null, ticker) ?? ticker;
    }
    if (canonicalTicker) watchTickers[canonicalTicker.instId] = canonicalTicker;
    next.watchTickers = watchTickers;
  }
  if (pendingCandle && pendingCandle.seriesKey === current.candleSeriesKey) {
    next.candles = mergeMarketCandles(current.candles, [pendingCandle.candle]);
  }
  if (pendingTrades.length > 0) next.trades = mergedTrades;
  if (Object.keys(pendingPublicStatuses).length > 0) next.publicStreamStatuses = { ...current.publicStreamStatuses, ...pendingPublicStatuses };
  if (pendingBusinessLastMessageAt !== undefined) next.businessLastMessageAt = pendingBusinessLastMessageAt;
  pendingTicker = undefined;
  pendingBook = undefined;
  pendingFundingRate = undefined;
  pendingCandle = undefined;
  pendingWatchTickers = {};
  pendingTrades = [];
  pendingPublicStatuses = {};
  pendingBusinessLastMessageAt = undefined;
  if (Object.keys(next).length > 0) useMarketHotStore.setState(next);
}

export function queueMarketTicker(ticker: Ticker) {
  const current = pendingTicker === undefined ? useMarketHotStore.getState().ticker : pendingTicker;
  pendingTicker = newerSnapshot(current, ticker);
  schedulePublish();
}

export function queueWatchTicker(ticker: Ticker) {
  const current = pendingWatchTickers[ticker.instId] ?? useMarketHotStore.getState().watchTickers[ticker.instId] ?? null;
  pendingWatchTickers[ticker.instId] = newerSnapshot(current, ticker) ?? ticker;
  schedulePublish();
}

export function queueOrderBook(book: OrderBook) {
  const trimmed = book.bids.length > 40 || book.asks.length > 40
    ? { ...book, bids: book.bids.slice(0, 40), asks: book.asks.slice(0, 40) }
    : book;
  const current = pendingBook === undefined ? useMarketHotStore.getState().book : pendingBook;
  pendingBook = newerSnapshot(current, trimmed);
  schedulePublish();
}

export function queueTrade(trade: Trade) {
  queueTrades([trade]);
}

export function queueTrades(trades: readonly Trade[]) {
  if (trades.length === 0) return;
  pendingTrades = mergeLatestTrades(trades, pendingTrades, MAX_PENDING_TRADES);
  schedulePublish();
}

export function queueFundingRate(fundingRate: FundingRate) {
  pendingFundingRate = fundingRate;
  schedulePublish();
}

export function queueCandle(candle: Candle, seriesKey: string | null = null) {
  pendingCandle = { candle, seriesKey };
  schedulePublish();
}

export function queuePublicStreamStatus(status: PublicWsStatus) {
  pendingPublicStatuses[status.streamId] = status;
  schedulePublish();
}

export function queueBusinessMessageAt(receivedAt: number) {
  pendingBusinessLastMessageAt = receivedAt;
  schedulePublish();
}

export function resetMarketHotState() {
  pendingTicker = undefined;
  pendingBook = undefined;
  pendingFundingRate = undefined;
  pendingCandle = undefined;
  pendingWatchTickers = {};
  pendingTrades = [];
  pendingPublicStatuses = {};
  pendingBusinessLastMessageAt = undefined;
  useMarketHotStore.setState(initialState);
}

export function hydrateMarketHotState(next: Partial<MarketHotState>) {
  useMarketHotStore.setState((current) => {
    const merged = { ...current, ...next };
    if (next.ticker !== undefined) merged.ticker = newerSnapshot(current.ticker, next.ticker);
    if (next.book !== undefined) merged.book = newerSnapshot(current.book, next.book);
    if (next.trades !== undefined) merged.trades = mergeLatestTrades(next.trades, current.trades, MAX_RENDERED_TRADES);
    if (next.watchTickers !== undefined) {
      merged.watchTickers = { ...current.watchTickers };
      for (const [instId, ticker] of Object.entries(next.watchTickers)) {
        merged.watchTickers[instId] = newerSnapshot(current.watchTickers[instId] ?? null, ticker) ?? ticker;
      }
    }
    merged.ticker = tickerWithLatestTrade(merged.ticker, merged.trades);
    if (merged.ticker) merged.watchTickers = { ...merged.watchTickers, [merged.ticker.instId]: merged.ticker };
    return merged;
  });
}

export function replaceMarketCandles(candles: Candle[], seriesKey: string | null = null) {
  useMarketHotStore.setState({ candles, candleSeriesKey: seriesKey });
}

export function mergeMarketCandles(current: Candle[], incoming: Candle[]) {
  if (incoming.length === 0) return current;

  // The live stream normally delivers one candle at the end of an already
  // ordered series. Keep that path allocation-light; irregular history
  // repairs continue through the canonical merge below.
  const last = current[current.length - 1];
  if (last && incoming.length === 1) {
    const candle = incoming[0];
    if (candle.time > last.time) {
      const next = [...current, candle];
      return next.length > MAX_RENDERED_CANDLES ? next.slice(-MAX_RENDERED_CANDLES) : next;
    }
    if (candle.time === last.time) {
      if (last.confirm && !candle.confirm) return current;
      return [...current.slice(0, -1), candle];
    }
  }

  // A batch that is strictly newer than the current tail is also safe to
  // append directly. Duplicate, older, or interior candles use the full
  // merge so confirmation precedence and ordering remain unchanged.
  if (last && incoming[0].time > last.time && isStrictlyIncreasingCandleTimes(incoming)) {
    const next = [...current, ...incoming];
    return next.length > MAX_RENDERED_CANDLES ? next.slice(-MAX_RENDERED_CANDLES) : next;
  }

  const merged = new Map(current.map((item) => [item.time, item]));
  for (const candle of incoming) {
    const existing = merged.get(candle.time);
    if (existing?.confirm && !candle.confirm) continue;
    merged.set(candle.time, candle);
  }
  return [...merged.values()]
    .sort((left, right) => left.time - right.time)
    .slice(-MAX_RENDERED_CANDLES);
}

function isStrictlyIncreasingCandleTimes(candles: readonly Candle[]) {
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index].time <= candles[index - 1].time) return false;
  }
  return true;
}

export function applyLivePriceToLatestCandle(candles: Candle[], rawPrice: string | number | null | undefined): Candle[] {
  const price = Number(rawPrice);
  const latest = candles.at(-1);
  if (!latest || latest.confirm || !Number.isFinite(price) || price <= 0) return candles;
  const next = {
    ...latest,
    high: Math.max(latest.high, price),
    low: Math.min(latest.low, price),
    close: price
  };
  if (next.high === latest.high && next.low === latest.low && next.close === latest.close) return candles;
  return [...candles.slice(0, -1), next];
}

export function mergeIntoMarketCandles(incoming: Candle[], seriesKey: string | null = null) {
  useMarketHotStore.setState((current) => {
    if (seriesKey !== current.candleSeriesKey) return current;
    return { candles: mergeMarketCandles(current.candles, incoming) };
  });
}

export function getMarketHotState() {
  return useMarketHotStore.getState();
}
