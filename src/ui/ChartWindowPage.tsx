import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Activity, Copy, Loader2, Maximize2, Minus, RefreshCw, X } from "lucide-react";
import clsx from "clsx";
import type {
  Candle,
  ChartOrderLine,
  ChartTradeSources,
  ChartPositionRange,
  ChartWindowState,
  FundingRate,
  HistoricalFillSummary,
  MarketAssetsSummary,
  OkxAlgoOrder,
  OkxInstrumentSummary,
  OkxPendingOrder,
  OkxPosition,
  OrderBook,
  PrivateAccountSnapshot,
  Ticker,
  Trade
} from "../types";
import {
  fetchCandles,
  fetchFundingRate,
  fetchChartTradeSources,
  fetchHistoricalCandlesBefore,
  fetchHistoricalFills,
  fetchMarketSnapshot,
  fetchOkxAlgoOrders,
  fetchPrivateSnapshot,
  fetchTicker,
  listChartWindows,
  loadAccounts,
  loadMarketAssetsCache,
  openChartWindow,
  registerMarketConsumer,
  unregisterMarketConsumer,
  updateChartWindowState
} from "../lib/okx";
import { fmtPrice } from "../lib/format";
import { invokeOptional, isTauriRuntime, listenOptional } from "../lib/tauri";
import { logger } from "../lib/logger";
import { KlineChart, type ChartHistoryLoadOutcome } from "./KlineChart";
import { i18n } from "../i18n/runtime";
import { ChartWindowWorkspacePage } from "./ChartWindowWorkspacePage";
import { TerminalSelect } from "./TerminalSelect";
import {
  buildHistoricalFillMarkers,
  chartOrderVisual,
  formatChartAmount,
  normalizeChartPosSide,
  resolveChartTradeAction,
} from "../lib/chartTradeSemantics";

const DEFAULT_SYMBOL = "BTC-USDT-SWAP";
const DEFAULT_TIMEFRAME = "30m";
const PERIODS = ["1m", "3m", "5m", "15m", "30m", "1H", "2H", "4H", "6H", "12H", "1D"];

type TauriMarketEvent =
  | { type: "ticker"; ticker: Ticker }
  | { type: "orderBook"; instId?: string; book: OrderBook }
  | { type: "trade"; instId?: string; trade: Trade }
  | { type: "trades"; instId?: string; trades: Trade[] }
  | { type: "renderBatch"; orderBooks: Record<string, OrderBook>; trades: Record<string, Trade[]> }
  | { type: "candle"; instId?: string; bar?: string; candle: Candle }
  | { type: "fundingRate"; funding: FundingRate }
  | { type: "privateSnapshot"; snapshot: PrivateAccountSnapshot }
  | { type: "privateOrder"; accountId: string; environment: string; order: OkxPendingOrder }
  | { type: "status"; status: string }
  | { type: "publicStatus"; status: string }
  | { type: "privateStatus"; status: string }
  | { type: "error"; message: string };

function getWindowIdFromUrlOrLabel(label?: string | null) {
  const url = new URL(window.location.href);
  const queryId = url.searchParams.get("chartWindowId") || url.searchParams.get("windowId");
  if (queryId) return queryId;
  const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const hashId = hashParams.get("chartWindowId") || hashParams.get("windowId");
  if (hashId) return hashId;
  if (label?.startsWith("chart-")) return label.slice("chart-".length);
  return "";
}

function isActivePendingOrder(order: OkxPendingOrder) {
  const state = String(order.state || "").toLowerCase();
  return ![
    "filled",
    "canceled",
    "cancelled",
    "failed",
    "rejected",
    "mmp_canceled",
    "order_failed",
    "effective",
    "triggered"
  ].includes(state);
}

function isActiveAlgoOrder(order: OkxAlgoOrder) {
  const state = String(order.state || "").toLowerCase();
  if (["canceled", "cancelled", "effective", "order_failed", "failed", "filled", "triggered"].includes(state)) return false;
  return order.sourceEndpoint === "orders-algo-pending" || state === "live" || state === "partially_effective";
}

function localizedTradeAction(t: TFunction, input: Parameters<typeof resolveChartTradeAction>[0]) {
  const action = resolveChartTradeAction(input);
  if (action === "open-long") return t("trading:openLong");
  if (action === "open-short") return t("trading:openShort");
  if (action === "close-long") return t("trading:closeLong");
  if (action === "close-short") return t("trading:closeShort");
  return t("trading:trade");
}

function localizedQuantity(t: TFunction, value?: string | number | null, absolute = false) {
  const numeric = Number(value);
  const amount = formatChartAmount(absolute && Number.isFinite(numeric) ? Math.abs(numeric) : value);
  return amount ? t("chart:contractQuantity", { size: amount }) : "";
}

function localizedPosition(t: TFunction, posSide?: string | null, size?: string | number | null) {
  const normalized = normalizeChartPosSide(posSide, size);
  const label = normalized === "long"
    ? t("trading:positionLong")
    : normalized === "short"
      ? t("trading:positionShort")
      : t("trading:netPosition");
  return [label, localizedQuantity(t, size, true)].filter(Boolean).join(" ");
}

function localizedOrderLabel(
  t: TFunction,
  type: ChartOrderLine["type"],
  input: Parameters<typeof resolveChartTradeAction>[0],
  size?: string | number | null,
) {
  const prefix = type === "trigger"
    ? t("trading:triggerOrder")
    : type === "tp"
      ? t("trading:takeProfit")
      : type === "sl"
        ? t("trading:stopLoss")
        : t("trading:limit");
  const action = localizedTradeAction(t, { ...input, closePosition: type === "tp" || type === "sl" });
  return [prefix, action, localizedQuantity(t, size)].filter(Boolean).join(" · ");
}

function buildDetachedOrderLines(t: TFunction, symbol: string, orders: OkxPendingOrder[], algoOrders: OkxAlgoOrder[], positions: OkxPosition[]): ChartOrderLine[] {
  const lines: ChartOrderLine[] = [];
  const addLine = (line: Omit<ChartOrderLine, "editable" | "editKind">) => {
    if (!Number.isFinite(line.price) || line.price <= 0) return;
    lines.push({ ...line, editable: false });
  };
  for (const position of positions) {
    if (position.instId !== symbol || Math.abs(Number(position.pos)) <= 0) continue;
    const id = position.posId || `${position.instId}-${position.posSide}`;
    const entryPrice = Number(position.avgPx);
    const liqPrice = Number(position.liqPx);
    const positionLabel = localizedPosition(t, position.posSide, position.pos);
    const entryVisual = chartOrderVisual("position-entry", { posSide: position.posSide });
    if (Number.isFinite(entryPrice) && entryPrice > 0) {
      addLine({
        id: `position-entry-${id}`,
        type: "position-entry",
        source: "position",
        label: `${positionLabel} · ${t("trading:averageEntryPrice")}`,
        price: entryPrice,
        posSide: position.posSide,
        color: entryVisual.color,
        tone: entryVisual.tone
      });
    }
    if (Number.isFinite(liqPrice) && liqPrice > 0) {
      addLine({
        id: `position-liq-${id}`,
        type: "liquidation",
        source: "position",
        label: `${positionLabel} · ${t("trading:liquidationPrice")}`,
        price: liqPrice,
        posSide: position.posSide,
        color: "#f59e0b",
        tone: "warning"
      });
    }
  }
  for (const order of orders) {
    if (order.instId !== symbol || !isActivePendingOrder(order)) continue;
    const id = order.ordId || order.clOrdId || `${order.instId}-${order.cTime}`;
    const type: ChartOrderLine["type"] = order.isAlgo || order.ordType === "trigger" ? "trigger" : "limit";
    const price = Number(order.triggerPx || order.px || order.ordPx);
    const visual = chartOrderVisual(type, order);
    addLine({
      id: `order-${id}`,
      type,
      source: order.isAlgo ? "algo" : "order",
      label: localizedOrderLabel(t, type, order, order.sz),
      price,
      side: order.side,
      posSide: order.posSide,
      color: visual.color,
      tone: visual.tone,
      orderId: order.ordId,
      clientOrderId: order.clOrdId,
      algoId: order.algoId,
      algoClientOrderId: order.algoClOrdId,
      size: order.sz
    });
    if (order.tpTriggerPx) {
      const tpVisual = chartOrderVisual("tp", order);
      addLine({
        id: `order-${id}-tp`,
        type: "tp",
        source: order.algoId || order.algoClOrdId ? "algo" : "order",
        label: localizedOrderLabel(t, "tp", order, order.sz),
        price: Number(order.tpTriggerPx),
        side: order.side,
        posSide: order.posSide,
        color: tpVisual.color,
        tone: tpVisual.tone,
        orderId: order.ordId,
        clientOrderId: order.clOrdId,
        algoId: order.algoId,
        algoClientOrderId: order.algoClOrdId,
        size: order.sz
      });
    }
    if (order.slTriggerPx) {
      const slVisual = chartOrderVisual("sl", order);
      addLine({
        id: `order-${id}-sl`,
        type: "sl",
        source: order.algoId || order.algoClOrdId ? "algo" : "order",
        label: localizedOrderLabel(t, "sl", order, order.sz),
        price: Number(order.slTriggerPx),
        side: order.side,
        posSide: order.posSide,
        color: slVisual.color,
        tone: slVisual.tone,
        orderId: order.ordId,
        clientOrderId: order.clOrdId,
        algoId: order.algoId,
        algoClientOrderId: order.algoClOrdId,
        size: order.sz
      });
    }
  }
  for (const order of algoOrders) {
    if (order.instId !== symbol || !isActiveAlgoOrder(order)) continue;
    const id = order.algoId || order.algoClOrdId || `${order.instId}-${order.cTime}`;
    if (order.tpTriggerPx) {
      const tpVisual = chartOrderVisual("tp", order);
      addLine({
        id: `algo-${id}-tp`,
        type: "tp",
        source: "algo",
        label: localizedOrderLabel(t, "tp", order, order.sz),
        price: Number(order.tpTriggerPx),
        side: order.side,
        posSide: order.posSide,
        color: tpVisual.color,
        tone: tpVisual.tone,
        algoId: order.algoId,
        algoClientOrderId: order.algoClOrdId,
        size: order.sz
      });
    }
    if (order.slTriggerPx) {
      const slVisual = chartOrderVisual("sl", order);
      addLine({
        id: `algo-${id}-sl`,
        type: "sl",
        source: "algo",
        label: localizedOrderLabel(t, "sl", order, order.sz),
        price: Number(order.slTriggerPx),
        side: order.side,
        posSide: order.posSide,
        color: slVisual.color,
        tone: slVisual.tone,
        algoId: order.algoId,
        algoClientOrderId: order.algoClOrdId,
        size: order.sz
      });
    }
  }
  return lines;
}

function buildDetachedPositionRanges(t: TFunction, symbol: string, positions: OkxPosition[], ticker: Ticker | null, instrument?: OkxInstrumentSummary): ChartPositionRange[] {
  const contractValue = Number(instrument?.ctVal);
  const normalizedContractValue = Number.isFinite(contractValue) && contractValue > 0 ? contractValue : 1;
  return positions
    .filter((position) => position.instId === symbol && Math.abs(Number(position.pos)) > 0)
    .map((position) => {
      const entryPrice = Number(position.avgPx);
      const markPrice = Number(position.markPx);
      const tickerPrice = Number(ticker?.last);
      const currentPrice = Number.isFinite(markPrice) && markPrice > 0 ? markPrice : tickerPrice;
      return {
        id: `position-range-${position.posId || position.instId}-${position.posSide}`,
        instId: position.instId,
        entryPrice,
        currentPrice,
        contractValue: normalizedContractValue,
        posSide: position.posSide,
        size: position.pos,
        pnl: position.upl,
        pnlRatio: position.uplRatioLastPx || position.uplRatio,
        label: localizedPosition(t, position.posSide, position.pos)
      };
    })
    .filter((range) => Number.isFinite(range.entryPrice) && range.entryPrice > 0 && Number.isFinite(range.currentPrice) && range.currentPrice > 0);
}

function mergeCandles(current: Candle[], incoming: Candle[]) {
  if (incoming.length === 0) return current;
  if (current.length === 0) return [...incoming].sort((a, b) => a.time - b.time);
  if (incoming.length === 1) {
    const next = incoming[0];
    const last = current[current.length - 1];
    if (next.time > last.time) return [...current, next];
    if (next.time === last.time) return [...current.slice(0, -1), next];
  }
  const sortedIncoming = [...incoming].sort((a, b) => a.time - b.time);
  if (sortedIncoming[sortedIncoming.length - 1].time < current[0].time) {
    return [...sortedIncoming, ...current];
  }
  const map = new Map<number, Candle>();
  for (const item of current) map.set(item.time, item);
  for (const item of sortedIncoming) map.set(item.time, item);
  return [...map.values()].sort((a, b) => a.time - b.time);
}

function mergeRecentTrades(current: Trade[], incoming: readonly Trade[]) {
  const byId = new Map<string, Trade>();
  for (const trade of incoming) byId.set(trade.tradeId, trade);
  for (const trade of current) {
    if (!byId.has(trade.tradeId)) byId.set(trade.tradeId, trade);
  }
  return [...byId.values()].sort((left, right) => right.ts - left.ts).slice(0, 80);
}

function LegacySingleChartWindowPage({ initialWindowLabel }: { initialWindowLabel?: string | null }) {
  const { t } = useTranslation(["chart", "trading", "common"]);
  const windowId = useMemo(() => getWindowIdFromUrlOrLabel(initialWindowLabel), [initialWindowLabel]);
  const [state, setState] = useState<ChartWindowState | null>(null);
  const [symbol, setSymbol] = useState(DEFAULT_SYMBOL);
  const [timeframe, setTimeframe] = useState(DEFAULT_TIMEFRAME);
  const [marketAssets, setMarketAssets] = useState<MarketAssetsSummary | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [ticker, setTicker] = useState<Ticker | null>(null);
  const [orderBook, setOrderBook] = useState<OrderBook | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [fundingRate, setFundingRate] = useState<FundingRate | null>(null);
  const [privateSnapshot, setPrivateSnapshot] = useState<PrivateAccountSnapshot | null>(null);
  const [algoOrders, setAlgoOrders] = useState<OkxAlgoOrder[]>([]);
  const [fills, setFills] = useState<HistoricalFillSummary[]>([]);
  const [tradeSources, setTradeSources] = useState<ChartTradeSources | null>(null);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [status, setStatus] = useState<"initializing" | "loading" | "live" | "failed">("initializing");
  const [stateInitialized, setStateInitialized] = useState(false);
  const accountIdRef = useRef<string | null>(null);
  const environmentRef = useRef<"demo" | "live">("demo");
  const historyLoadingRef = useRef(false);
  const historyExhaustedRef = useRef(new Set<string>());
  const historySeriesEpochRef = useRef(0);
  const aggregateRefreshRef = useRef(false);
  const candleSeriesKeyRef = useRef("");

  useEffect(() => {
    let cancelled = false;
    async function loadState() {
      try {
        const [windows, assets, accounts] = await Promise.all([
          listChartWindows(),
          loadMarketAssetsCache(),
          loadAccounts()
        ]);
        if (cancelled) return;
        const matched = windows?.find((item) => item.id === windowId || item.label === `chart-${windowId}`) ?? null;
        const account = matched?.accountId
          ? accounts.find((item) => item.id === matched.accountId)
          : accounts[0] ?? null;
        accountIdRef.current = matched?.accountId ?? account?.id ?? null;
        environmentRef.current = (matched?.environment === "live" || matched?.environment === "demo"
          ? matched.environment
          : account?.environment === "live"
            ? "live"
            : "demo");
        setMarketAssets(assets);
        if (matched) {
          setState(matched);
          setSymbol(matched.symbol || DEFAULT_SYMBOL);
          setTimeframe(matched.timeframe || DEFAULT_TIMEFRAME);
        }
      } catch (error) {
        logger.error("failed to initialize chart window", error);
      } finally {
        if (!cancelled) setStateInitialized(true);
      }
    }
    void loadState();
    return () => {
      cancelled = true;
    };
  }, [windowId]);

  const instrument = useMemo(
    () => marketAssets?.instruments.find((item) => item.instId === symbol),
    [marketAssets, symbol]
  );

  const loadStaticData = useCallback(async () => {
    if (!stateInitialized) return;
    const seriesKey = `${symbol}:${timeframe}`;
    if (candleSeriesKeyRef.current !== seriesKey) {
      candleSeriesKeyRef.current = seriesKey;
      setCandles([]);
    }
    setLoading(true);
    setStatus("loading");
    try {
      const [snapshot, nextCandles, nextTicker, nextFunding, accountSnapshot, nextFills, algos, nextTradeSources] = await Promise.all([
        fetchMarketSnapshot(),
        fetchCandles(symbol, timeframe, 300),
        fetchTicker(symbol),
        fetchFundingRate(symbol),
        accountIdRef.current ? fetchPrivateSnapshot(accountIdRef.current) : Promise.resolve(null),
        accountIdRef.current ? fetchHistoricalFills({ accountId: accountIdRef.current, instId: symbol, limit: 240 }) : Promise.resolve(null),
        accountIdRef.current
          ? fetchOkxAlgoOrders({ accountId: accountIdRef.current, environment: environmentRef.current, instId: symbol, includeHistory: false })
          : Promise.resolve(null),
        accountIdRef.current ? fetchChartTradeSources() : Promise.resolve(null)
      ]);
      const cachedTicker = snapshot?.tickers?.[symbol] ?? (snapshot?.ticker?.instId === symbol ? snapshot.ticker : null);
      const cachedBook = snapshot?.orderbooks?.[symbol] ?? (snapshot?.orderbookInstId === symbol ? snapshot.orderbook : null);
      const cachedTrades = snapshot?.tradesByInst?.[symbol] ?? (snapshot?.tradesInstId === symbol ? snapshot.trades : []);
      const cachedFunding = snapshot?.fundingRates?.[symbol] ?? null;
      setCandles((current) => mergeCandles(current, nextCandles));
      setTicker(nextTicker ?? cachedTicker ?? null);
      setOrderBook(cachedBook ?? null);
      setTrades(cachedTrades?.slice(0, 80) ?? []);
      setFundingRate(nextFunding ?? cachedFunding ?? null);
      setPrivateSnapshot(accountSnapshot ?? snapshot?.privateSnapshot ?? null);
      setFills(nextFills ?? []);
      setTradeSources(nextTradeSources);
      setAlgoOrders(algos?.orders ?? []);
      setStatus("live");
    } catch (error) {
      logger.error("failed to load detached chart data", error, { symbol, timeframe });
      setStatus("failed");
    } finally {
      setLoading(false);
    }
  }, [stateInitialized, symbol, timeframe]);

  useEffect(() => {
    void loadStaticData();
  }, [loadStaticData]);

  useEffect(() => {
    if (!stateInitialized || !isTauriRuntime()) return;
    const consumerId = `chart-window:${windowId || "default"}`;
    void registerMarketConsumer({
      consumerId,
      symbols: [symbol],
      orderbookDepth: 400,
      includeTrades: true,
      includeOrderbook: true
    }).catch((error) => logger.error("failed to register detached chart market consumer", error, { consumerId, symbol }));
    return () => {
      void unregisterMarketConsumer(consumerId).catch((error) => logger.error("failed to release detached chart market consumer", error, { consumerId }));
    };
  }, [stateInitialized, symbol, windowId]);

  useEffect(() => {
    if (!state) return;
    const next: ChartWindowState = {
      ...state,
      symbol,
      timeframe,
      panes: [{ id: "pane-1", symbol, timeframe }],
      updatedAt: Date.now()
    };
    setState(next);
    void updateChartWindowState(next).catch((error) => logger.error("failed to update chart window state", error));
  // state intentionally omitted to avoid feedback loops after local symbol/timeframe changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, timeframe]);

  useEffect(() => {
    let mounted = true;
    let cleanup: (() => void) | null = null;
    void listenOptional<TauriMarketEvent>("market:event", (event) => {
      if (!mounted) return;
      if (event.type === "ticker" && event.ticker.instId === symbol) setTicker(event.ticker);
      if (event.type === "orderBook" && event.instId === symbol) setOrderBook(event.book);
      if (event.type === "trade" && event.instId === symbol) setTrades((items) => mergeRecentTrades(items, [event.trade]));
      if (event.type === "trades" && event.instId === symbol) setTrades((items) => mergeRecentTrades(items, event.trades));
      if (event.type === "renderBatch") {
        const book = event.orderBooks[symbol];
        const trades = event.trades[symbol];
        if (book) setOrderBook(book);
        if (trades?.length) setTrades((items) => mergeRecentTrades(items, trades));
      }
      if (event.type === "fundingRate" && event.funding.instId === symbol) setFundingRate(event.funding);
      if (event.type === "candle" && event.instId === symbol && (!event.bar || event.bar === timeframe || event.bar === "1m")) {
        if (timeframe === "1m" || event.bar === timeframe) {
          setCandles((items) => mergeCandles(items, [event.candle]));
        } else if (!aggregateRefreshRef.current) {
          aggregateRefreshRef.current = true;
          void fetchCandles(symbol, timeframe, 300)
            .then((items) => {
              if (mounted && items.length > 0) {
                setCandles((current) => mergeCandles(current, items));
              }
            })
            .catch((error) => {
              logger.error("failed to refresh detached aggregated candles", error, { symbol, timeframe });
            })
            .finally(() => {
              aggregateRefreshRef.current = false;
            });
        }
      }
      if (event.type === "privateSnapshot") setPrivateSnapshot(event.snapshot);
      if (event.type === "privateOrder" && event.order.instId === symbol) {
        setPrivateSnapshot((snapshot) => {
          if (!snapshot || snapshot.accountId !== event.accountId || snapshot.environment !== event.environment) return snapshot;
          const key = event.order.ordId || event.order.clOrdId;
          const orders = snapshot.orders.filter((item) => (item.ordId || item.clOrdId) !== key);
          return { ...snapshot, orders: isActivePendingOrder(event.order) ? [event.order, ...orders] : orders, syncedAt: Date.now() };
        });
      }
    }).then((unlisten) => {
      cleanup = unlisten;
    });
    return () => {
      mounted = false;
      cleanup?.();
    };
  }, [symbol, timeframe]);

  useEffect(() => {
    historySeriesEpochRef.current += 1;
    historyLoadingRef.current = false;
    setHistoryLoading(false);
  }, [symbol, timeframe]);

  const loadMoreHistory = useCallback(async ({ firstTime }: { firstTime: number }): Promise<ChartHistoryLoadOutcome> => {
    const historyKey = `${symbol}\u0000${timeframe}`;
    if (!Number.isFinite(firstTime) || firstTime <= 0) return { status: "failed", message: "invalid history cursor" };
    if (historyExhaustedRef.current.has(historyKey)) return { status: "exhausted" };
    if (historyLoadingRef.current) return { status: "deferred" };
    const seriesEpoch = historySeriesEpochRef.current;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    try {
      const page = await fetchHistoricalCandlesBefore(symbol, timeframe, firstTime, 300);
      if (seriesEpoch !== historySeriesEpochRef.current) return { status: "deferred" };
      if (page.candles.length > 0) {
        setCandles((items) => mergeCandles(page.candles, items));
        logger.info("loaded earlier detached chart candles", { symbol, timeframe, firstTime, count: page.candles.length, exhausted: page.exhausted, source: page.source });
      }
      if (page.exhausted) {
        historyExhaustedRef.current.add(historyKey);
        return { status: "exhausted" };
      }
      const earliestTime = page.earliestTime ?? page.candles[0]?.time;
      return page.candles.length > 0 && earliestTime
        ? { status: "loaded", earliestTime }
        : { status: "deferred" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("failed to load earlier detached chart candles", error, { symbol, timeframe, firstTime });
      return { status: "failed", message };
    } finally {
      if (seriesEpoch === historySeriesEpochRef.current) {
        historyLoadingRef.current = false;
        setHistoryLoading(false);
      }
    }
  }, [symbol, timeframe]);

  const orderLines = useMemo(
    () => buildDetachedOrderLines(t, symbol, privateSnapshot?.orders ?? [], algoOrders, privateSnapshot?.positions ?? []),
    [algoOrders, privateSnapshot?.orders, privateSnapshot?.positions, symbol, t]
  );
  const fillMarkers = useMemo(() => buildHistoricalFillMarkers(symbol, fills).map((marker) => ({
    ...marker,
    label: [
      localizedTradeAction(t, marker),
      localizedQuantity(t, marker.size),
      marker.pnl && Number(marker.pnl) !== 0 ? `${Number(marker.pnl) > 0 ? "+" : ""}${formatChartAmount(marker.pnl)}U` : ""
    ].filter(Boolean).join(" ")
  })), [fills, symbol, t]);
  const positionRanges = useMemo(
    () => buildDetachedPositionRanges(t, symbol, privateSnapshot?.positions ?? [], ticker, instrument),
    [instrument, privateSnapshot?.positions, symbol, t, ticker]
  );

  const openDuplicate = useCallback(() => {
    void openChartWindow({
      symbol,
      timeframe,
      accountId: accountIdRef.current,
      environment: environmentRef.current
    });
  }, [symbol, timeframe]);

  const toggleMaximize = useCallback(() => {
    if (!isTauriRuntime()) return;
    void import("@tauri-apps/api/window").then((windowApi) => {
      const current = windowApi.getCurrentWindow();
      void current.toggleMaximize();
    });
  }, []);

  const minimizeWindow = useCallback(() => {
    if (!isTauriRuntime()) return;
    void import("@tauri-apps/api/window").then((windowApi) => {
      void windowApi.getCurrentWindow().minimize();
    });
  }, []);

  const closeWindow = useCallback(() => {
    if (!isTauriRuntime()) return;
    void import("@tauri-apps/api/window").then((windowApi) => {
      void windowApi.getCurrentWindow().close();
    });
  }, []);

  const startWindowDrag = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, select, input")) return;
    if (!isTauriRuntime()) return;
    void import("@tauri-apps/api/window").then((windowApi) => {
      void windowApi.getCurrentWindow().startDragging().catch((error) => {
        logger.error("failed to drag detached chart window", error);
      });
    });
  }, []);

  const statusLabel = status === "initializing"
    ? t("chart:windowStatusInitializing")
    : status === "loading"
      ? t("chart:windowStatusLoading")
      : status === "live"
        ? t("chart:windowStatusLive")
        : t("chart:windowStatusFailed");

  return (
    <div className="chart-window-page">
      <header className="chart-window-header" data-tauri-drag-region onMouseDown={startWindowDrag}>
        <div className="chart-window-app-mark" data-tauri-drag-region>
          <Activity size={17} />
        </div>
        <div className="chart-window-title" data-tauri-drag-region>
          <div data-tauri-drag-region>
            <strong>{symbol}</strong>
            <span className="chart-window-readonly">{t("chart:readOnly")}</span>
          </div>
          <span data-tauri-drag-region>{timeframe} · {t("chart:perpetualChart")}</span>
        </div>
        <div className="chart-window-market" data-tauri-drag-region>
          <strong className={Number(ticker?.last) >= Number(ticker?.open24h) ? "up" : "down"}>{fmtPrice(ticker?.last)}</strong>
          <span>{t("trading:fundingRate")} {fundingRate ? `${(Number(fundingRate.fundingRate) * 100).toFixed(4)}%` : "--"}</span>
          <span className="chart-window-live-state"><i />{statusLabel}</span>
        </div>
        <div className="chart-window-controls">
          <button onClick={minimizeWindow} title={t("chart:minimizeWindow")}><Minus size={16} /></button>
          <button onClick={toggleMaximize} title={t("chart:toggleMaximizeWindow")}><Maximize2 size={15} /></button>
          <button className="danger" onClick={closeWindow} title={t("common:close")}><X size={16} /></button>
        </div>
      </header>

      <div className="chart-window-toolbar">
        <label>
          {t("trading:tradingPair")}
          <TerminalSelect
            ariaLabel={t("chart:windowTradingPairAria")}
            value={symbol}
            menuMinWidth={220}
            options={(marketAssets?.instruments ?? [{ instId: DEFAULT_SYMBOL } as OkxInstrumentSummary]).slice(0, 240).map((item) => ({ value: item.instId, label: item.instId }))}
            onChange={setSymbol}
          />
        </label>
        <div className="chart-window-periods">
          {PERIODS.map((period) => (
            <button key={period} className={clsx(period === timeframe && "active")} onClick={() => setTimeframe(period)}>
              {period}
            </button>
          ))}
        </div>
        <div className="chart-window-flags">
          <div className="chart-window-utilities">
            <button onClick={loadStaticData} title={t("chart:refreshData")}><RefreshCw size={14} /></button>
            <button onClick={openDuplicate} title={t("chart:duplicateWindow")}><Copy size={14} /></button>
          </div>
          <span>{t("chart:orderCount", { count: orderLines.length })}</span>
          <span>{t("chart:fillCount", { count: fillMarkers.length })}</span>
          <span>{t("chart:positionCount", { count: positionRanges.length })}</span>
        </div>
      </div>

      <main className="chart-window-main">
        {(loading || historyLoading) && (
          <div className="chart-window-loading">
            <Loader2 size={18} className="spin" />
            {historyLoading ? t("chart:loadingEarlier") : t("chart:loadingChartData")}
          </div>
        )}
        <KlineChart
          candles={candles}
          ticker={ticker}
          symbol={symbol}
          timeframe={timeframe}
          workspaceId={`detached-chart-${windowId || "default"}`}
          orderBook={orderBook}
          recentTrades={trades}
          fundingRate={fundingRate}
          orderLines={orderLines}
          fills={fillMarkers}
          tradeSources={tradeSources}
          positionRanges={positionRanges}
          onNeedMoreHistory={loadMoreHistory}
        />
      </main>
    </div>
  );
}

export function ChartWindowPage({ initialWindowLabel }: { initialWindowLabel?: string | null }) {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listenOptional<{ resolvedLanguage?: string }>("ui:locale-changed", (event) => {
      if (event.resolvedLanguage && event.resolvedLanguage !== i18n.language) void i18n.changeLanguage(event.resolvedLanguage);
    }).then((cleanup) => { unlisten = cleanup; });
    return () => unlisten?.();
  }, []);
  return <ChartWindowWorkspacePage initialWindowLabel={initialWindowLabel} />;
}
