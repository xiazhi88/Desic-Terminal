import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { BellRing, ExternalLink, Layers3, Loader2, Redo2, SlidersHorizontal, Undo2, X } from "lucide-react";
import type {
  Candle,
  AccountSummary,
  ChartOrderLine,
  ChartTradeSources,
  ChartOrderLineEdit,
  ChartPositionRange,
  FundingRate,
  HistoricalFillSummary,
  MarketAssetsSummary,
  OkxAlgoOrder,
  OkxInstrumentSummary,
  OkxPendingOrder,
  OkxPosition,
  OrderBook,
  PrivateAccountSnapshot,
  PositionLineTradeIntent,
  Ticker,
  Trade
} from "../types";
import {
  deleteChartAlert,
  fetchCandles,
  fetchChartTradeSources,
  fetchFundingRate,
  fetchHistoricalCandlesBefore,
  fetchHistoricalFills,
  fetchMarketSnapshot,
  fetchOkxAlgoOrders,
  fetchPrivateSnapshot,
  fetchTicker,
  openChartWindow,
  saveChartAlert,
} from "../lib/okx";
import { logger } from "../lib/logger";
import { listenOptional } from "../lib/tauri";
import { subscribeMarketEvents } from "../lib/marketEventBus";
import { i18n } from "../i18n/runtime";
import { createChartIndicatorTemplate, loadChartIndicatorTemplates, saveChartIndicatorTemplates, type ChartIndicatorTemplate } from "../lib/chartIndicatorTemplates";
import { DEFAULT_CHART_LAYER_VISIBILITY, KlineChart, type ChartContextTradeIntent, type ChartHistoryLoadOutcome } from "./KlineChart";
import { ChartQuickTradeDialog } from "./ChartQuickTradeDialog";
import { ChartRiskRewardTradeDialog } from "./ChartRiskRewardTradeDialog";
import { SharedChartOrderCancelDialog, SharedChartOrderLineEditDialog, SharedPositionLineTradeDialog } from "./ChartTradeDialogs";
import { TerminalSelect } from "./TerminalSelect";
import type { ChartCrosshairPosition } from "./chartAdapter";
import type { ChartLayerKey, ChartLayerVisibility } from "./KlineChart";
import { amendChartOrder, cancelChartOrder, submitPositionChartAction, submitRiskRewardChartAction } from "../lib/chartTradeActions";
import { buildSharedChartOrderLines, buildSharedChartPositionRanges } from "../lib/chartTradeLines";
import {
  buildHistoricalFillMarkers,
  chartOrderVisual,
  formatChartOrderLabel,
  chartPositionLabel,
  formatChartPosition,
  normalizeChartPosSide as normalizePosSide,
} from "../lib/chartTradeSemantics";

const EMPTY_CANDLES: Candle[] = [];
const EMPTY_TRADES: Trade[] = [];
const EMPTY_FILLS: HistoricalFillSummary[] = [];
const EMPTY_ORDERS: OkxAlgoOrder[] = [];
const EMPTY_POSITIONS: OkxPosition[] = [];
const EMPTY_PENDING_ORDERS: OkxPendingOrder[] = [];

export type DetachedChartPaneProps = {
  paneId: string;
  workspaceId?: string;
  symbol: string;
  timeframe: string;
  accountId?: string | null;
  account?: AccountSummary | null;
  environment?: "demo" | "live";
  readOnly?: boolean;
  marketAssets: MarketAssetsSummary | null;
  onSymbolChange?: (symbol: string) => void;
  onTimeframeChange?: (timeframe: string) => void;
  onStatusChange?: (status: string) => void;
  onTickerChange?: (ticker: Ticker | null) => void;
  onCrosshairTime?: (time: number | null) => void;
  onCrosshairPosition?: (position: ChartCrosshairPosition | null) => void;
  onVisibleRange?: (range: { from: number; to: number } | null) => void;
  synchronizedCrosshairTime?: number | null;
  synchronizedCrosshairPosition?: ChartCrosshairPosition | null;
  synchronizedVisibleRange?: { from: number; to: number } | null;
  indicatorIds?: readonly string[];
  onIndicatorIdsChange?: (ids: readonly string[]) => void;
  onClosePane?: () => void;
};

const LAYER_LABELS: readonly [ChartLayerKey, string, string][] = [
  ["indicators", "Indicators", "指标"],
  ["priceLines", "Price lines", "价格线"],
  ["drawings", "Drawings", "绘图"],
  ["signals", "Analysis", "分析观点"],
  ["fills", "Fills", "真实成交"],
  ["tools", "Tools", "工具"],
];

function paneText(english: string, chinese: string) {
  const language = i18n.resolvedLanguage || i18n.language || "en-US";
  return language.toLowerCase().startsWith("zh") ? chinese : english;
}

function isShortPosition(position: Pick<OkxPosition, "posSide" | "pos">) {
  const posSide = normalizePosSide(position.posSide, position.pos);
  return posSide === "short" || (posSide === "net" && Number(position.pos) < 0);
}

function isActivePendingOrder(order: OkxPendingOrder) {
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
  ].includes(String(order.state).toLowerCase());
}

function isActiveAlgoOrder(order: OkxAlgoOrder) {
  const state = String(order.state ?? "").toLowerCase();
  return !["canceled", "cancelled", "effective", "order_failed", "failed", "filled", "triggered"].includes(state)
    && (order.sourceEndpoint === "orders-algo-pending" || state === "live" || state === "partially_effective");
}

function mergeCandles(current: Candle[], incoming: Candle[]) {
  if (incoming.length === 0) return current;
  const byTime = new Map<number, Candle>();
  for (const candle of [...current, ...incoming]) {
    const time = Number(candle.time);
    if (!Number.isFinite(time) || !Number.isFinite(candle.open) || !Number.isFinite(candle.high)
      || !Number.isFinite(candle.low) || !Number.isFinite(candle.close) || !Number.isFinite(candle.volume)) continue;
    byTime.set(Math.floor(time), { ...candle, time: Math.floor(time) });
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

function buildOrderLinesLegacy(t: TFunction, symbol: string, orders: OkxPendingOrder[], algoOrders: OkxAlgoOrder[], positions: OkxPosition[]): ChartOrderLine[] {
  const lines: ChartOrderLine[] = [];
  const add = (line: ChartOrderLine) => {
    if (Number.isFinite(line.price) && line.price > 0) lines.push(line);
  };

  for (const position of positions) {
    if (position.instId !== symbol || Math.abs(Number(position.pos)) <= 0) continue;
    const positionId = position.posId || `${position.instId}-${position.posSide}`;
    add({
      id: `detached-position-liq-${positionId}`,
      type: "liquidation",
      source: "position",
      label: `${chartPositionLabel(position.posSide, position.pos, t)} · ${t("trading:liquidationPrice")}`,
      price: Number(position.liqPx),
      posSide: position.posSide,
      color: "#f59e0b",
      tone: "warning"
    });
  }

  for (const order of orders) {
    if (order.instId !== symbol || !isActivePendingOrder(order)) continue;
    const id = order.ordId || order.clOrdId || `${order.instId}-${order.cTime}`;
    const type: ChartOrderLine["type"] = order.isAlgo || order.ordType === "trigger" ? "trigger" : "limit";
    const visual = chartOrderVisual(type, order);
    add({
      id: `detached-order-${id}`,
      type,
      source: order.isAlgo ? "algo" : "order",
      label: formatChartOrderLabel(type, order, order.sz, t),
      price: Number(order.triggerPx || order.px || order.ordPx),
      side: order.side,
      posSide: order.posSide,
      color: visual.color,
      tone: visual.tone,
      orderId: order.ordId,
      clientOrderId: order.clOrdId,
      algoId: order.algoId,
      algoClientOrderId: order.algoClOrdId,
      size: order.sz,
      editable: type === "limit" || (type === "trigger" && Boolean(order.algoId || order.algoClOrdId)),
      editKind: type === "limit" ? "order-price" : type === "trigger" ? "algo-trigger" : undefined,
      triggerPrice: type === "trigger" ? Number(order.triggerPx || order.px) || undefined : undefined,
      orderPrice: type === "trigger" ? order.ordPx === "-1" ? null : Number(order.ordPx) || undefined : undefined,
    });
  }

  for (const order of algoOrders) {
    if (order.instId !== symbol || !isActiveAlgoOrder(order)) continue;
    const id = order.algoId || order.algoClOrdId || `${order.instId}-${order.cTime}`;
    const shared = {
      source: "algo" as const,
      side: order.side,
      posSide: order.posSide,
      algoId: order.algoId,
      algoClientOrderId: order.algoClOrdId,
      size: order.sz
    };
    const tpVisual = chartOrderVisual("tp", order);
    const slVisual = chartOrderVisual("sl", order);
    add({ id: `detached-algo-${id}-tp`, type: "tp", label: formatChartOrderLabel("tp", order, order.sz, t), price: Number(order.tpTriggerPx), color: tpVisual.color, tone: tpVisual.tone, editable: true, editKind: "algo-tp", ...shared });
    add({ id: `detached-algo-${id}-sl`, type: "sl", label: formatChartOrderLabel("sl", order, order.sz, t), price: Number(order.slTriggerPx), color: slVisual.color, tone: slVisual.tone, editable: true, editKind: "algo-sl", ...shared });
  }
  return lines;
}

function buildPositionRangesLegacy(t: TFunction, symbol: string, positions: OkxPosition[], ticker: Ticker | null, algoOrders: OkxAlgoOrder[], instrument?: OkxInstrumentSummary): ChartPositionRange[] {
  const pendingAlgos = algoOrders.filter((order) => order.instId === symbol && isActiveAlgoOrder(order));
  const contractValue = Number(instrument?.ctVal);
  const normalizedContractValue = Number.isFinite(contractValue) && contractValue > 0 ? contractValue : 1;
  return positions
    .filter((position) => position.instId === symbol && Math.abs(Number(position.pos)) > 0)
    .map((position) => {
      const existingAlgos: ChartPositionRange["existingAlgos"] = [];
      const closeSide = isShortPosition(position) ? "buy" : "sell";
      for (const order of pendingAlgos) {
        if (normalizePosSide(order.posSide) !== normalizePosSide(position.posSide)) continue;
        if (String(order.side).toLowerCase() !== closeSide) continue;
        if (order.tpTriggerPx) existingAlgos.push({ side: "tp", algoId: order.algoId, algoClientOrderId: order.algoClOrdId });
        if (order.slTriggerPx) existingAlgos.push({ side: "sl", algoId: order.algoId, algoClientOrderId: order.algoClOrdId });
      }
      return {
        id: `detached-position-range-${position.posId || position.instId}-${position.posSide}`,
        instId: position.instId,
        entryPrice: Number(position.avgPx),
        currentPrice: Number(position.markPx) > 0 ? Number(position.markPx) : Number(ticker?.last),
        contractValue: normalizedContractValue,
        posSide: position.posSide,
        size: position.pos,
        pnl: position.upl,
        pnlRatio: position.uplRatioLastPx || position.uplRatio,
        label: formatChartPosition(position.posSide, position.pos, t),
        existingAlgos
      };
    })
    .filter((range) => Number.isFinite(range.entryPrice) && range.entryPrice > 0 && Number.isFinite(range.currentPrice) && range.currentPrice > 0);
}

export function DetachedChartPane({
  paneId,
  workspaceId,
  symbol,
  timeframe,
  accountId = null,
  account = null,
  environment = "demo",
  readOnly = false,
  marketAssets,
  onSymbolChange,
  onTimeframeChange,
  onStatusChange,
  onTickerChange,
  onCrosshairTime,
  onCrosshairPosition,
  onVisibleRange,
  synchronizedCrosshairTime,
  synchronizedCrosshairPosition,
  synchronizedVisibleRange,
  indicatorIds,
  onIndicatorIdsChange,
  onClosePane,
}: DetachedChartPaneProps) {
  const { t } = useTranslation(["trading", "chart", "common"]);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listenOptional<{ resolvedLanguage?: string }>("ui:locale-changed", (event) => {
      if (event.resolvedLanguage && event.resolvedLanguage !== i18n.language) void i18n.changeLanguage(event.resolvedLanguage);
    }).then((cleanup) => { unlisten = cleanup; });
    return () => unlisten?.();
  }, []);
  const persistenceWorkspaceId = workspaceId ?? `detached-pane-${paneId}`;
  const [candles, setCandles] = useState<Candle[]>(EMPTY_CANDLES);
  const [ticker, setTicker] = useState<Ticker | null>(null);
  const [orderBook, setOrderBook] = useState<OrderBook | null>(null);
  const [trades, setTrades] = useState<Trade[]>(EMPTY_TRADES);
  const [fundingRate, setFundingRate] = useState<FundingRate | null>(null);
  const [privateSnapshot, setPrivateSnapshot] = useState<PrivateAccountSnapshot | null>(null);
  const [algoOrders, setAlgoOrders] = useState<OkxAlgoOrder[]>(EMPTY_ORDERS);
  const [fills, setFills] = useState<HistoricalFillSummary[]>(EMPTY_FILLS);
  const [tradeSources, setTradeSources] = useState<ChartTradeSources | null>(null);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [status, setStatus] = useState(() => paneText("Initializing chart", "初始化图表"));
  const [tradeDraft, setTradeDraft] = useState<ChartContextTradeIntent | null>(null);
  const [orderEdit, setOrderEdit] = useState<ChartOrderLineEdit | null>(null);
  const [orderCancel, setOrderCancel] = useState<ChartOrderLine | null>(null);
  const [positionIntent, setPositionIntent] = useState<PositionLineTradeIntent | null>(null);
  const [riskRewardIntent, setRiskRewardIntent] = useState<import("../types").ChartRiskRewardTradeIntent | null>(null);
  const [toolbarAction, setToolbarAction] = useState<{ token: number; action: "indicators" | "alerts" | "undo" | "redo" } | null>(null);
  const [layerCommand, setLayerCommand] = useState<{ token: number; key: ChartLayerKey } | null>(null);
  const [layerVisibility, setLayerVisibility] = useState<ChartLayerVisibility>(DEFAULT_CHART_LAYER_VISIBILITY);
  const [layerMenuOpen, setLayerMenuOpen] = useState(false);
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [indicatorTemplates, setIndicatorTemplates] = useState<ChartIndicatorTemplate[]>(loadChartIndicatorTemplates);
  const [headerActions, setHeaderActions] = useState<HTMLElement | null>(null);
  const [drawingHistoryState, setDrawingHistoryState] = useState({ canUndo: false, canRedo: false });
  const indicatorTriggerRef = useRef<HTMLButtonElement | null>(null);
  const requestVersionRef = useRef(0);
  const seriesEpochRef = useRef(0);
  const historyLoadingRef = useRef(false);
  const exhaustedHistoryRef = useRef(new Set<string>());
  const aggregateRefreshRef = useRef(false);
  const onStatusChangeRef = useRef(onStatusChange);

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  const setPaneStatus = useCallback((nextStatus: string) => {
    setStatus(nextStatus);
    onStatusChangeRef.current?.(nextStatus);
  }, []);

  useEffect(() => {
    onTickerChange?.(ticker);
  }, [onTickerChange, ticker]);

  const instrument = useMemo(
    () => marketAssets?.instruments.find((item) => item.instId === symbol),
    [marketAssets, symbol]
  );

  const loadStaticData = useCallback(async () => {
    const version = ++requestVersionRef.current;
    setLoading(true);
    setPaneStatus(paneText("Loading chart data", "加载图表数据"));
    try {
      const [snapshot, nextCandles, nextTicker, nextFunding, accountSnapshot, nextFills, algos, nextTradeSources] = await Promise.all([
        fetchMarketSnapshot(),
        fetchCandles(symbol, timeframe, 300),
        fetchTicker(symbol),
        fetchFundingRate(symbol),
        accountId ? fetchPrivateSnapshot(accountId) : Promise.resolve(null),
        accountId ? fetchHistoricalFills({ accountId, instId: symbol, limit: 240 }) : Promise.resolve(null),
        accountId ? fetchOkxAlgoOrders({ accountId, environment, instId: symbol, includeHistory: false }) : Promise.resolve(null),
        accountId ? fetchChartTradeSources() : Promise.resolve(null)
      ]);
      if (version !== requestVersionRef.current) return;
      const cachedTicker = snapshot?.tickers?.[symbol] ?? (snapshot?.ticker?.instId === symbol ? snapshot.ticker : null);
      const cachedOrderBook = snapshot?.orderbooks?.[symbol] ?? (snapshot?.orderbookInstId === symbol ? snapshot.orderbook : null);
      const cachedTrades = snapshot?.tradesByInst?.[symbol] ?? (snapshot?.tradesInstId === symbol ? snapshot.trades : EMPTY_TRADES);
      setCandles((current) => mergeCandles(current, nextCandles));
      setTicker(nextTicker ?? cachedTicker ?? null);
      setOrderBook(cachedOrderBook ?? null);
      setTrades(cachedTrades.slice(0, 80));
      setFundingRate(nextFunding ?? snapshot?.fundingRates?.[symbol] ?? null);
      setPrivateSnapshot(accountSnapshot ?? snapshot?.privateSnapshot ?? null);
      setFills(nextFills ?? EMPTY_FILLS);
      setTradeSources(nextTradeSources);
      setAlgoOrders(algos?.orders ?? EMPTY_ORDERS);
      setPaneStatus(paneText("Live monitoring", "实时监听中"));
    } catch (error) {
      if (version !== requestVersionRef.current) return;
      logger.error("failed to load detached chart pane data", error, { paneId, symbol, timeframe });
      setPaneStatus(paneText("Load failed; existing data retained", "加载失败，保留现有数据"));
    } finally {
      if (version === requestVersionRef.current) setLoading(false);
    }
  }, [accountId, environment, paneId, setPaneStatus, symbol, timeframe]);

  useEffect(() => {
    seriesEpochRef.current += 1;
    requestVersionRef.current += 1;
    historyLoadingRef.current = false;
    aggregateRefreshRef.current = false;
    setCandles(EMPTY_CANDLES);
    setTrades(EMPTY_TRADES);
    setOrderBook(null);
    void loadStaticData();
  }, [loadStaticData, symbol, timeframe]);

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | null = null;
    unlisten = subscribeMarketEvents((event) => {
      if (!mounted) return;
      if (event.type === "ticker" && event.ticker.instId === symbol) setTicker(event.ticker);
      if (event.type === "orderBook" && event.instId === symbol) setOrderBook(event.book);
      if (event.type === "trade" && event.instId === symbol) setTrades((current) => [event.trade, ...current].slice(0, 80));
      if (event.type === "fundingRate" && event.funding.instId === symbol) setFundingRate(event.funding);
      if (event.type === "candle" && event.instId === symbol && (!event.bar || event.bar === timeframe || event.bar === "1m")) {
        if (timeframe === "1m" || event.bar === timeframe) {
          setCandles((current) => mergeCandles(current, [event.candle]));
        } else if (!aggregateRefreshRef.current) {
          aggregateRefreshRef.current = true;
          void fetchCandles(symbol, timeframe, 300)
            .then((nextCandles) => mounted && setCandles((current) => mergeCandles(current, nextCandles)))
            .catch((error) => logger.error("failed to refresh detached aggregate candles", error, { paneId, symbol, timeframe }))
            .finally(() => { aggregateRefreshRef.current = false; });
        }
      }
      if (event.type === "privateSnapshot" && (!accountId || event.snapshot.accountId === accountId)) setPrivateSnapshot(event.snapshot);
      if (event.type === "privateOrder" && event.order.instId === symbol && (!accountId || event.accountId === accountId) && event.environment === environment) {
        setPrivateSnapshot((current) => {
          if (!current || current.accountId !== event.accountId) return current;
          const identity = event.order.ordId || event.order.clOrdId;
          const orders = current.orders.filter((order) => (order.ordId || order.clOrdId) !== identity);
          return { ...current, orders: isActivePendingOrder(event.order) ? [event.order, ...orders] : orders, syncedAt: Date.now() };
        });
      }
    });
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, [accountId, environment, paneId, symbol, timeframe]);

  const loadMoreHistory = useCallback(async ({ firstTime }: { firstTime: number }): Promise<ChartHistoryLoadOutcome> => {
    const key = `${symbol}\u0000${timeframe}`;
    if (!Number.isFinite(firstTime) || firstTime <= 0) return { status: "failed", message: "invalid history cursor" };
    if (exhaustedHistoryRef.current.has(key)) return { status: "exhausted" };
    if (historyLoadingRef.current) return { status: "deferred" };
    const seriesEpoch = seriesEpochRef.current;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    try {
      const page = await fetchHistoricalCandlesBefore(symbol, timeframe, firstTime, 300);
      if (seriesEpoch !== seriesEpochRef.current) return { status: "deferred" };
      if (page.instId !== symbol || page.bar !== timeframe) {
        const message = `历史 K 线响应身份不匹配：请求 ${symbol} ${timeframe}，收到 ${page.instId} ${page.bar}`;
        logger.error(message, { paneId, symbol, timeframe, responseSymbol: page.instId, responseBar: page.bar, firstTime });
        return { status: "failed", message };
      }
      if (page.candles.length > 0) setCandles((current) => mergeCandles(page.candles, current));
      if (page.exhausted) {
        exhaustedHistoryRef.current.add(key);
        return { status: "exhausted" };
      }
      const earliestTime = page.earliestTime ?? page.candles[0]?.time;
      return page.candles.length > 0 && earliestTime
        ? { status: "loaded", earliestTime }
        : { status: "deferred" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("failed to load detached pane history", error, { paneId, symbol, timeframe, firstTime });
      return { status: "failed", message };
    } finally {
      if (seriesEpoch === seriesEpochRef.current) {
        historyLoadingRef.current = false;
        setHistoryLoading(false);
      }
    }
  }, [paneId, symbol, timeframe]);

  const orderLines = useMemo(
    () => buildSharedChartOrderLines({ t, symbol, orders: privateSnapshot?.orders ?? EMPTY_PENDING_ORDERS, algoOrders, positions: privateSnapshot?.positions ?? EMPTY_POSITIONS, instrument }),
    [algoOrders, instrument, privateSnapshot?.orders, privateSnapshot?.positions, symbol, t]
  );
  const fillMarkers = useMemo(() => buildHistoricalFillMarkers(symbol, fills, 240, t), [fills, symbol, t]);
  const positionRanges = useMemo(
    () => buildSharedChartPositionRanges(t, symbol, privateSnapshot?.positions ?? EMPTY_POSITIONS, ticker, algoOrders, instrument),
    [algoOrders, instrument, privateSnapshot?.positions, symbol, t, ticker]
  );
  const popOutPane = useCallback(() => {
    void openChartWindow({ symbol, timeframe, accountId, environment, singlePane: true });
  }, [accountId, environment, symbol, timeframe]);
  const requestToolbarAction = useCallback((action: "indicators" | "alerts" | "undo" | "redo") => {
    setToolbarAction({ token: Date.now(), action });
  }, []);
  const toggleLayer = useCallback((key: ChartLayerKey) => {
    setLayerCommand({ token: Date.now(), key });
  }, []);
  const saveIndicatorTemplate = useCallback(() => {
    const template = createChartIndicatorTemplate(templateName, indicatorIds ?? []);
    if (!template) return;
    setIndicatorTemplates((items) => {
      const next = [template, ...items].slice(0, 30);
      saveChartIndicatorTemplates(next);
      return next;
    });
    setTemplateName("");
  }, [indicatorIds, templateName]);
  const deleteIndicatorTemplate = useCallback((id: string) => {
    setIndicatorTemplates((items) => {
      const next = items.filter((item) => item.id !== id);
      saveChartIndicatorTemplates(next);
      return next;
    });
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setHeaderActions(document.getElementById(`chart-pane-header-actions-${paneId}`)));
    return () => window.cancelAnimationFrame(frame);
  }, [paneId]);

  useEffect(() => {
    if (!templateMenuOpen && !layerMenuOpen) return;
    const closeMenus = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".detached-chart-pane-header-menus, .detached-chart-pane-dropdown")) return;
      setTemplateMenuOpen(false);
      setLayerMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeMenus, true);
    return () => window.removeEventListener("pointerdown", closeMenus, true);
  }, [layerMenuOpen, templateMenuOpen]);

  const paneHeaderMenus = headerActions ? createPortal(
    <div className="detached-chart-pane-header-menus" onPointerDown={(event) => event.stopPropagation()}>
      <div className="detached-chart-pane-menu-group">
        <button type="button" ref={indicatorTriggerRef} className="detached-chart-pane-menu" onClick={() => { setTemplateMenuOpen(false); setLayerMenuOpen(false); requestToolbarAction("indicators"); }} title={paneText("Manage indicators", "管理指标")}><SlidersHorizontal size={13} /> {paneText("Indicators", "指标")}</button>
        <button type="button" data-chart-alert-trigger="true" className="detached-chart-pane-menu" onClick={() => { setTemplateMenuOpen(false); setLayerMenuOpen(false); requestToolbarAction("alerts"); }} title={paneText("Price alerts", "价格提醒")}><BellRing size={13} /> {paneText("Alerts", "提醒")}</button>
        <button type="button" className={templateMenuOpen ? "detached-chart-pane-menu is-active" : "detached-chart-pane-menu"} onClick={() => { setTemplateMenuOpen((open) => !open); setLayerMenuOpen(false); }} title={paneText("Indicator templates", "指标模板")}>{paneText("Templates", "模板")}</button>
        {templateMenuOpen && <div className="detached-chart-pane-dropdown detached-chart-pane-template-menu" onPointerDown={(event) => event.stopPropagation()}>
          <strong>{paneText("Indicator templates", "指标模板")}</strong><div className="detached-chart-pane-template-save"><input value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder={paneText("Template name", "模板名称")} maxLength={48} /><button type="button" onClick={saveIndicatorTemplate} disabled={!templateName.trim()}>{paneText("Save current", "保存当前")}</button></div>
          {indicatorTemplates.length === 0 ? <p>{paneText("No indicator templates saved", "尚未保存指标模板")}</p> : indicatorTemplates.map((template) => <div key={template.id} className="detached-chart-pane-template-row"><button type="button" onClick={() => { onIndicatorIdsChange?.(template.indicatorIds); setTemplateMenuOpen(false); }}><span data-i18n-skip="true">{template.name}</span><small>{paneText(`${template.indicatorIds.length} indicators`, `${template.indicatorIds.length} 个指标`)}</small></button><button type="button" aria-label={paneText(`Delete ${template.name}`, `删除 ${template.name}`)} title={paneText("Delete template", "删除模板")} onClick={() => deleteIndicatorTemplate(template.id)}>×</button></div>)}
        </div>}
      </div>
      <div className="detached-chart-pane-menu-group">
        <button type="button" className={layerMenuOpen ? "detached-chart-pane-menu is-active" : "detached-chart-pane-menu"} onClick={() => { setLayerMenuOpen((open) => !open); setTemplateMenuOpen(false); }} title={paneText("Visible layers", "可视图层")}><Layers3 size={13} /> {paneText("Layers", "图层")}</button>
        {layerMenuOpen && <div className="detached-chart-pane-dropdown detached-chart-pane-layer-menu" onPointerDown={(event) => event.stopPropagation()}><strong>{paneText("Visible layers", "可视图层")}</strong>{LAYER_LABELS.map(([key, english, chinese]) => <label key={key}><input type="checkbox" checked={layerVisibility[key]} onChange={() => toggleLayer(key)} />{paneText(english, chinese)}</label>)}</div>}
      </div>
      <button type="button" className="detached-chart-pane-icon-menu" disabled={!drawingHistoryState.canUndo} onClick={() => requestToolbarAction("undo")} title={paneText("Undo drawing", "撤销绘图")}><Undo2 size={13} /></button>
      <button type="button" className="detached-chart-pane-icon-menu" disabled={!drawingHistoryState.canRedo} onClick={() => requestToolbarAction("redo")} title={paneText("Redo drawing", "恢复绘图")}><Redo2 size={13} /></button>
      <button type="button" className="detached-chart-pane-popout" onClick={popOutPane} title={paneText("Pop this chart out into a separate window", "将此图表弹出为独立窗口")} aria-label={paneText(`Pop out ${symbol} ${timeframe} chart`, `弹出 ${symbol} ${timeframe} 图表`)}><ExternalLink size={13} /></button>
      {onClosePane && <button type="button" className="detached-chart-pane-icon-menu detached-chart-pane-close" onClick={onClosePane} title={paneText("Close this chart", "关闭此图表")} aria-label={paneText("Close this chart", "关闭此图表")}><X size={13} /></button>}
    </div>,
    headerActions,
  ) : null;

  return (
    <section className="detached-chart-pane" data-pane-id={paneId} data-readonly={readOnly ? "true" : "false"}>
      {paneHeaderMenus}
      <div className="detached-chart-pane-toolbar">
        <label>
          {paneText("Market", "交易对")}
          <TerminalSelect
            ariaLabel={paneText("Chart pane market", "图表窗格交易对")}
            value={symbol}
            menuMinWidth={220}
            options={(marketAssets?.instruments ?? []).slice(0, 240).map((item) => ({ value: item.instId, label: item.instId }))}
            onChange={(value) => onSymbolChange?.(value)}
          />
        </label>
        <label>
          {paneText("Timeframe", "周期")}
          <TerminalSelect
            ariaLabel={paneText("Chart pane timeframe", "图表窗格周期")}
            value={timeframe}
            menuMinWidth={104}
            options={["1m", "3m", "5m", "15m", "30m", "1H", "2H", "4H", "6H", "12H", "1D"].map((period) => ({ value: period, label: period }))}
            onChange={(value) => onTimeframeChange?.(value)}
          />
        </label>
        <span className="detached-chart-pane-status">{status}</span>
        <span>{paneText("Orders", "委托")} {orderLines.length}</span>
        <span>{paneText("Fills", "成交")} {fillMarkers.length}</span>
        <span>{paneText("Positions", "持仓")} {positionRanges.length}</span>
      </div>
      <div className="detached-chart-pane-chart">
        {(loading || historyLoading) && <div className="detached-chart-pane-loading"><Loader2 size={16} className="spin" />{historyLoading ? paneText("Loading earlier candles...", "加载更早 K 线...") : paneText("Loading chart data...", "加载图表数据...")}</div>}
        <KlineChart
          key={`${paneId}\u0000${symbol}\u0000${timeframe}`}
          candles={candles}
          ticker={ticker}
          symbol={symbol}
          timeframe={timeframe}
          workspaceId={workspaceId ?? `detached-pane-${paneId}`}
          persistWorkspace={false}
          orderBook={orderBook}
          recentTrades={trades}
          fundingRate={fundingRate}
          orderLines={orderLines}
          fills={fillMarkers}
          tradeSources={tradeSources}
          positionRanges={positionRanges}
          onNeedMoreHistory={loadMoreHistory}
          onChartCrosshairTime={onCrosshairTime}
          onChartCrosshairPosition={onCrosshairPosition}
          onChartVisibleRange={onVisibleRange}
          synchronizedCrosshairTime={synchronizedCrosshairTime}
          synchronizedCrosshairPosition={synchronizedCrosshairPosition}
          synchronizedVisibleRange={synchronizedVisibleRange}
          onChartContextTrade={(payload) => !readOnly && setTradeDraft(payload)}
          onCreateChartAlert={({ id, definition }) => {
            if (readOnly) return;
            void saveChartAlert({
              id,
              workspaceId: persistenceWorkspaceId,
              status: "active",
              definition,
            }).catch((error) => logger.warn("failed to persist detached chart alert", { paneId, error: error instanceof Error ? error.message : String(error) }));
          }}
          onDeletePriceAlert={({ id }) => { void deleteChartAlert(persistenceWorkspaceId, id).catch(() => undefined); }}
          onOrderLineEdit={(edit) => !readOnly && setOrderEdit(edit)}
          onOrderLineCancel={(line) => {
            if (!readOnly && accountId) setOrderCancel(line);
          }}
          onPositionLineTradeIntent={(intent) => !readOnly && setPositionIntent(intent)}
          onPositionLineCloseRequest={(intent) => !readOnly && setPositionIntent({ ...intent, kind: "limit_close", targetPrice: intent.currentPrice })}
          onRiskRewardTradeIntent={(intent) => !readOnly && setRiskRewardIntent(intent)}
          indicatorIds={indicatorIds}
          onIndicatorIdsChange={onIndicatorIdsChange}
          toolbarPlacement="external"
          externalIndicatorTrigger={indicatorTriggerRef.current}
          externalToolbarAction={toolbarAction}
          externalLayerCommand={layerCommand}
          onLayerVisibilityChange={setLayerVisibility}
          onDrawingHistoryChange={setDrawingHistoryState}
        />
      </div>
      {tradeDraft && <ChartQuickTradeDialog draft={tradeDraft} accountId={accountId} environment={environment} instrument={instrument} accountSnapshot={privateSnapshot} onClose={() => setTradeDraft(null)} onSubmitted={() => { setTradeDraft(null); void loadStaticData(); }} />}
      {orderEdit && <SharedChartOrderLineEditDialog edit={orderEdit} environment={environment} instrument={instrument} onClose={() => setOrderEdit(null)} onSubmit={async (edit, confirmedLive) => {
        if (!accountId) throw new Error(t("trading:noTradingAccountSelected"));
        await amendChartOrder({ accountId, account, environment, defaultInstId: symbol, getInstrument: () => instrument }, edit, confirmedLive);
        setOrderEdit(null);
        void loadStaticData();
      }} />}
      {orderCancel && <SharedChartOrderCancelDialog line={orderCancel} environment={environment} onClose={() => setOrderCancel(null)} onSubmit={async (_confirmedLive) => {
        if (!accountId) throw new Error(t("trading:noTradingAccountSelected"));
        const line = orderCancel;
        await cancelChartOrder({ accountId, account, environment, defaultInstId: symbol }, line, _confirmedLive);
        setOrderCancel(null);
        void loadStaticData();
      }} />}
      {positionIntent && <SharedPositionLineTradeDialog account={account} intent={positionIntent} environment={environment} position={privateSnapshot?.positions.find((item) => item.instId === positionIntent.instId && normalizePosSide(item.posSide) === positionIntent.posSide)} instrument={instrument} onClose={() => setPositionIntent(null)} onSubmit={async (intent, size, _orderPx, confirmedLive) => {
        if (!accountId) throw new Error(t("trading:noTradingAccountSelected"));
        await submitPositionChartAction({ accountId, account, environment, snapshot: privateSnapshot, getInstrument: () => instrument }, intent, size, _orderPx, confirmedLive);
        setPositionIntent(null);
        void loadStaticData();
      }} />}
      {riskRewardIntent && accountId && <ChartRiskRewardTradeDialog intent={riskRewardIntent} snapshot={privateSnapshot} instrument={instrument} environment={environment} onClose={() => setRiskRewardIntent(null)} onSubmit={async (intent, size, marginMode, lever, confirmedLive) => {
        await submitRiskRewardChartAction({ accountId, account, environment, getInstrument: () => instrument }, intent, size, marginMode, lever, confirmedLive);
        setRiskRewardIntent(null);
        void loadStaticData();
      }} />}
    </section>
  );
}
