import type {
  AccountSummary,
  AccountConfigDraft,
  AccountBillSummary,
  AccountBillsArchiveImportRequest,
  AccountBillsArchiveImportResult,
  AccountBillsArchiveRequest,
  AccountBillsArchiveStatus,
  AccountBillsRequest,
  AccountPerformanceRequest,
  AccountPerformanceSummary,
  AiAutomationReviewDetail,
  AiAutomationReviewDetailRequest,
  AlgoOrdersResponse,
  AmendOrderRequest,
  AmendAlgoOrderRequest,
  Candle,
  CancelAlgoOrderRequest,
  HistoricalFillSummary,
  HistoricalFillsRequest,
  HistoricalOrderSummary,
  HistoricalOrdersRequest,
  ExecuteInstrumentOperationRequest,
  InstrumentOperationPreview,
  InstrumentOperationQuery,
  InstrumentOperationScope,
  InstrumentOperationView,
  ChartWindowRequest,
  ChartWindowState,
  ChartWindowSummary,
  KlineSyncReport,
  KlineSyncSummary,
  LeverageInfoRequest,
  LinearUsdtRiskBudget,
  LinearUsdtRiskBudgetRequest,
  LinearUsdtPerpetualEvaluation,
  LinearUsdtPerpetualEvaluationRequest,
  ListAlgoOrdersRequest,
  MarketAssetsSummary,
  MarketSnapshot,
  ClosePositionRequest,
  CancelOrderRequest,
  CancelOrderResponse,
  FundingRate,
  OkxLeverageInfo,
  OkxAlgoOrderResult,
  OkxPendingOrder,
  OkxWsProbeResult,
  OkxTimeState,
  OrderBook,
  PlaceAlgoOrderRequest,
  PlaceOrderRequest,
  PlaceOrderResponse,
  PrivateAccountSnapshot,
  PublicWsStatus,
  PrivateWsStatus,
  PrivateHistorySyncRequest,
  PrivateHistorySyncResult,
  PrivateHistoryStatusRequest,
  PrivateHistoryStatusResponse,
  PositionEpisode,
  PositionEpisodesRequest,
  ProxyConfigSummary,
  ProxyConfigUpdate,
  ProxyTestResult,
  SensitiveConfigMigrationResult,
  SetLeverageRequest,
  SetLeverageResponse,
  StorageMaintenanceResult,
  StorageStatusResult,
  Ticker,
  TradeAuditEventSummary,
  TradeAuditEventsRequest,
  TradeExecutionGuard,
  TradeExecutionGuardsRequest,
  TradeOpportunity,
  TradeOpportunityCreateRequest,
  TradePrecheckRequest,
  TradePrecheckResponse,
  Trade,
  WatchlistConfig
} from "../types";
import { logger } from "./logger";
import { createDeferredCleanupSlot } from "./deferredCleanup";
import { invokeDesktop, invokeOptional, isTauriRuntime, listenOptional } from "./tauri";

const REST_BASE = "https://openapi.okx.com";
const PUBLIC_WS = "wss://ws.okx.com:8443/ws/v5/public";
const BUSINESS_WS = "wss://ws.okx.com:8443/ws/v5/business";
const MIN_RENDER_ORDERBOOK_LEVELS = 24;
const OKX_KLINE_BARS = ["1m"] as const;

export type ChartWorkspaceJson = Record<string, unknown> | unknown[];

export type ChartWorkspaceInput = {
  id?: string | null;
  name: string;
  layout?: ChartWorkspaceJson;
  indicators?: ChartWorkspaceJson;
  layers?: ChartWorkspaceJson;
};

export type ChartWorkspace = Required<Omit<ChartWorkspaceInput, "id" | "layout" | "indicators" | "layers">> & {
  id: string;
  layout: ChartWorkspaceJson;
  indicators: ChartWorkspaceJson;
  layers: ChartWorkspaceJson;
  createdAt: number;
  updatedAt: number;
};

export type ChartWorkspaceViewInput = {
  id?: string | null;
  workspaceId: string;
  sortOrder: number;
  symbol: string;
  timeframe: string;
  layout?: ChartWorkspaceJson;
  indicators?: ChartWorkspaceJson;
  layers?: ChartWorkspaceJson;
};

export type ChartWorkspaceView = Required<Omit<ChartWorkspaceViewInput, "id" | "layout" | "indicators" | "layers">> & {
  id: string;
  layout: ChartWorkspaceJson;
  indicators: ChartWorkspaceJson;
  layers: ChartWorkspaceJson;
  createdAt: number;
  updatedAt: number;
};

export type ChartDrawingInput = {
  id: string;
  workspaceId: string;
  viewId?: string | null;
  drawing?: ChartWorkspaceJson;
  layer?: ChartWorkspaceJson;
};

export type ChartDrawing = Required<Omit<ChartDrawingInput, "viewId" | "drawing" | "layer">> & {
  viewId: string | null;
  drawing: ChartWorkspaceJson;
  layer: ChartWorkspaceJson;
  createdAt: number;
  updatedAt: number;
};

export type ChartAlertInput = {
  id: string;
  workspaceId: string;
  viewId?: string | null;
  status: string;
  lastTriggeredAt?: number | null;
  definition?: ChartWorkspaceJson;
};

export type ChartAlert = Required<Omit<ChartAlertInput, "viewId" | "lastTriggeredAt" | "definition">> & {
  viewId: string | null;
  lastTriggeredAt: number | null;
  definition: ChartWorkspaceJson;
  createdAt: number;
  updatedAt: number;
};

export type ChartDslExpression = Record<string, unknown>;
export type ChartDslEvaluation = {
  valueType: "number" | "boolean";
  values: Array<number | boolean | null>;
  nodeCount: number;
  maxLookback: number;
};

export type ChartAlertEvent = {
  id: string;
  alertId: string;
  workspaceId: string;
  instId: string;
  conditionKind: string;
  direction: "above" | "below" | "cross";
  triggerPrice: number;
  lastPrice: number;
  triggeredAt: number;
  deliveryStatus: string;
  name?: string;
  message?: string;
  notifyApp?: boolean;
  frequency?: "once" | "repeat";
};

export type MarketConsumerRegistration = {
  consumerId: string;
  symbols: string[];
  orderbookDepth?: number;
  includeTrades?: boolean;
  includeOrderbook?: boolean;
};

export type MarketConsumerStatus = {
  consumerId: string;
  activeConsumers: number;
  symbols: string[];
  addedSubscriptions: number;
  removedSubscriptions: number;
};

async function okxFetch<T>(path: string, signal?: AbortSignal): Promise<T> {
  const url = `${REST_BASE}${path}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`OKX HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.code !== "0") throw new Error(`OKX ${json.code}: ${json.msg ?? "unknown error"}`);
  return json as T;
}

export async function syncOkxTime(): Promise<OkxTimeState> {
  if (isTauriRuntime()) {
    const viaTauri = await invokeDesktop<OkxTimeState>("okx_sync_time");
    if (!viaTauri) throw new Error("OKX time probe returned no result");
    return viaTauri;
  }

  const localSendMs = Date.now();
  const json = await okxFetch<{ data: { ts: string }[] }>("/api/v5/public/time");
  const localRecvMs = Date.now();
  const okxServerMs = Number(json.data[0]?.ts);
  const rttMs = localRecvMs - localSendMs;
  const okxNowEstimatedMs = okxServerMs + rttMs / 2;
  return {
    okxServerMs,
    localSendMs,
    localRecvMs,
    rttMs,
    clockOffsetMs: Math.round(okxNowEstimatedMs - localRecvMs),
    status: "synced"
  };
}

export async function probeOkxStartupNetwork(): Promise<OkxTimeState> {
  const timeoutMs = 5_000;
  if (isTauriRuntime()) {
    const result = await withTimeout(
      invokeDesktop<OkxTimeState>("okx_startup_network_probe"),
      timeoutMs,
      "OKX 网络检测超时（5 秒）"
    );
    if (result) return result;
    throw new Error("OKX 网络检测服务不可用，请退出应用后重新打开");
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const localSendMs = Date.now();
    const json = await okxFetch<{ data: { ts: string }[] }>("/api/v5/public/time", controller.signal);
    const localRecvMs = Date.now();
    const okxServerMs = Number(json.data[0]?.ts);
    const rttMs = localRecvMs - localSendMs;
    return {
      okxServerMs,
      localSendMs,
      localRecvMs,
      rttMs,
      clockOffsetMs: Math.round(okxServerMs + rttMs / 2 - localRecvMs),
      status: "synced"
    };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("OKX 网络检测超时（5 秒）");
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

export async function loadAccounts(): Promise<AccountSummary[]> {
  const viaTauri = await invokeOptional<AccountSummary[]>("load_local_accounts");
  return viaTauri ?? [];
}

export async function saveAccountConfig(account: AccountConfigDraft): Promise<AccountSummary[] | null> {
  return invokeDesktop<AccountSummary[]>("save_local_account", { request: account });
}

export async function deleteAccountConfig(id: string): Promise<AccountSummary[] | null> {
  return invokeDesktop<AccountSummary[]>("delete_local_account", { request: { id } });
}

export async function testAccountConfig(id: string): Promise<PrivateAccountSnapshot | null> {
  return invokeDesktop<PrivateAccountSnapshot>("test_local_account", { request: { id } });
}

export async function testPrivateWsReachability(accountId: string): Promise<OkxWsProbeResult | null> {
  return invokeOptional<OkxWsProbeResult>("okx_private_ws_probe", { request: { accountId } });
}

export async function fetchPrivateSnapshot(accountId?: string): Promise<PrivateAccountSnapshot | null> {
  return invokeDesktop<PrivateAccountSnapshot>("okx_private_snapshot", {
    request: { accountId }
  });
}

export async function reconcilePrivateStreams(): Promise<void | null> {
  return invokeOptional<void>("reconcile_private_streams");
}

export async function syncPrivateHistory(request: PrivateHistorySyncRequest): Promise<PrivateHistorySyncResult | null> {
  return invokeDesktop<PrivateHistorySyncResult>("okx_sync_private_history", { request });
}

export async function fetchPrivateHistoryStatus(request: PrivateHistoryStatusRequest): Promise<PrivateHistoryStatusResponse | null> {
  return invokeDesktop<PrivateHistoryStatusResponse>("private_history_status", { request });
}

export async function fetchPositionEpisodes(request: PositionEpisodesRequest): Promise<PositionEpisode[] | null> {
  return invokeDesktop<PositionEpisode[]>("position_episodes", { request });
}

export async function fetchAiAutomationReviewDetail(request: AiAutomationReviewDetailRequest): Promise<AiAutomationReviewDetail | null> {
  return invokeDesktop<AiAutomationReviewDetail>("ai_automation_review_detail", { request });
}

export async function fetchHistoricalOrders(request: HistoricalOrdersRequest): Promise<HistoricalOrderSummary[] | null> {
  return invokeDesktop<HistoricalOrderSummary[]>("historical_orders", { request });
}

export async function fetchHistoricalFills(request: HistoricalFillsRequest): Promise<HistoricalFillSummary[] | null> {
  return invokeDesktop<HistoricalFillSummary[]>("historical_fills", { request });
}

export async function fetchAccountBills(request: AccountBillsRequest): Promise<AccountBillSummary[] | null> {
  return invokeDesktop<AccountBillSummary[]>("account_bills", { request });
}

export async function fetchAccountPerformanceSummary(request: AccountPerformanceRequest): Promise<AccountPerformanceSummary | null> {
  return invokeDesktop<AccountPerformanceSummary>("account_performance_summary", { request });
}

export async function fetchTradeAuditEvents(request: TradeAuditEventsRequest): Promise<TradeAuditEventSummary[] | null> {
  return invokeDesktop<TradeAuditEventSummary[]>("trade_audit_events", { request });
}

export async function fetchAccountBillsArchiveStatus(request: AccountBillsArchiveRequest): Promise<AccountBillsArchiveStatus | null> {
  return invokeDesktop<AccountBillsArchiveStatus>("account_bills_archive_status", { request });
}

export async function importAccountBillsArchive(request: AccountBillsArchiveImportRequest): Promise<AccountBillsArchiveImportResult | null> {
  return invokeDesktop<AccountBillsArchiveImportResult>("import_account_bills_archive", { request });
}

export async function requestTradePrecheck(request: TradePrecheckRequest): Promise<TradePrecheckResponse | null> {
  return invokeDesktop<TradePrecheckResponse>("trade_precheck", { request });
}

export async function createTradeOpportunity(request: TradeOpportunityCreateRequest): Promise<TradeOpportunity | null> {
  return invokeDesktop<TradeOpportunity>("trade_opportunity_create", { request });
}

export async function fetchTradeOpportunities(): Promise<TradeOpportunity[] | null> {
  return invokeDesktop<TradeOpportunity[]>("trade_opportunities");
}

export async function approveTradeOpportunity(id: string): Promise<TradeOpportunity | null> {
  return invokeDesktop<TradeOpportunity>("trade_opportunity_approve", { id });
}

export async function rejectTradeOpportunity(id: string): Promise<TradeOpportunity | null> {
  return invokeDesktop<TradeOpportunity>("trade_opportunity_reject", { id });
}

export async function deleteTradeOpportunity(id: string): Promise<number | null> {
  return invokeDesktop<number>("trade_opportunity_delete", { id });
}

export async function clearTradeOpportunities(): Promise<number | null> {
  return invokeDesktop<number>("trade_opportunities_clear");
}

export async function fetchLeverageInfo(request: LeverageInfoRequest): Promise<OkxLeverageInfo[] | null> {
  return invokeDesktop<OkxLeverageInfo[]>("okx_leverage_info", { request });
}

export async function setOkxLeverage(request: SetLeverageRequest): Promise<SetLeverageResponse | null> {
  return invokeDesktop<SetLeverageResponse>("okx_set_leverage", { request });
}

export async function calculateLinearUsdtRiskBudget(request: LinearUsdtRiskBudgetRequest): Promise<LinearUsdtRiskBudget | null> {
  return invokeDesktop<LinearUsdtRiskBudget>("calculate_linear_usdt_risk_budget", { request });
}

export async function calculateLinearUsdtPerpetual(request: LinearUsdtPerpetualEvaluationRequest): Promise<LinearUsdtPerpetualEvaluation | null> {
  return invokeDesktop<LinearUsdtPerpetualEvaluation>("calculate_linear_usdt_perpetual", { request });
}

export async function previewCancelInstrumentOrders(request: InstrumentOperationScope): Promise<InstrumentOperationPreview | null> {
  return invokeDesktop<InstrumentOperationPreview>("okx_preview_cancel_instrument_orders", { request });
}

export async function executeCancelInstrumentOrders(request: ExecuteInstrumentOperationRequest): Promise<InstrumentOperationView | null> {
  return invokeDesktop<InstrumentOperationView>("okx_execute_cancel_instrument_orders", { request });
}

export async function previewFlattenInstrumentPositions(request: InstrumentOperationScope): Promise<InstrumentOperationPreview | null> {
  return invokeDesktop<InstrumentOperationPreview>("okx_preview_flatten_instrument_positions", { request });
}

export async function executeFlattenInstrumentPositions(request: ExecuteInstrumentOperationRequest): Promise<InstrumentOperationView | null> {
  return invokeDesktop<InstrumentOperationView>("okx_execute_flatten_instrument_positions", { request });
}

export async function queryInstrumentOperation(request: InstrumentOperationQuery): Promise<InstrumentOperationView | null> {
  return invokeDesktop<InstrumentOperationView>("okx_instrument_operation", { request });
}

export async function fetchActiveInstrumentOperations(request: InstrumentOperationScope): Promise<InstrumentOperationView[] | null> {
  return invokeDesktop<InstrumentOperationView[]>("okx_active_instrument_operations", { request });
}

export async function fetchTradeExecutionGuards(request: TradeExecutionGuardsRequest): Promise<TradeExecutionGuard[] | null> {
  return invokeDesktop<TradeExecutionGuard[]>("okx_trade_execution_guards", { request });
}

export async function reconcileTradeExecutionGuards(request: TradeExecutionGuardsRequest): Promise<TradeExecutionGuard[] | null> {
  return invokeDesktop<TradeExecutionGuard[]>("okx_reconcile_trade_execution_guards", { request });
}

export async function placeOkxOrder(request: PlaceOrderRequest): Promise<PlaceOrderResponse | null> {
  return invokeDesktop<PlaceOrderResponse>("okx_place_order", { request });
}

export async function cancelOkxOrder(request: CancelOrderRequest): Promise<CancelOrderResponse | null> {
  return invokeDesktop<CancelOrderResponse>("okx_cancel_order", { request });
}

export async function amendOkxOrder(request: AmendOrderRequest): Promise<CancelOrderResponse | null> {
  return invokeDesktop<CancelOrderResponse>("okx_amend_order", { request });
}

export async function placeOkxAlgoOrder(request: PlaceAlgoOrderRequest): Promise<PlaceOrderResponse | null> {
  return invokeDesktop<PlaceOrderResponse>("okx_place_algo_order", { request });
}

export async function amendOkxAlgoOrder(request: AmendAlgoOrderRequest): Promise<OkxAlgoOrderResult | null> {
  return invokeDesktop<OkxAlgoOrderResult>("okx_amend_algo_order", { request });
}

export async function cancelOkxAlgoOrder(request: CancelAlgoOrderRequest): Promise<CancelOrderResponse | null> {
  return invokeDesktop<CancelOrderResponse>("okx_cancel_algo_order", { request });
}

export async function fetchOkxAlgoOrders(request: ListAlgoOrdersRequest): Promise<AlgoOrdersResponse | null> {
  return invokeDesktop<AlgoOrdersResponse>("okx_list_algo_orders", { request });
}

export async function closeOkxPosition(request: ClosePositionRequest): Promise<PlaceOrderResponse | null> {
  return invokeDesktop<PlaceOrderResponse>("okx_close_position", { request });
}

export async function initLocalStorage(): Promise<string | null> {
  return invokeOptional<string>("init_local_storage");
}

export async function runStorageMaintenance(): Promise<StorageMaintenanceResult | null> {
  return invokeOptional<StorageMaintenanceResult>("storage_maintenance");
}

export async function fetchStorageStatus(): Promise<StorageStatusResult | null> {
  return invokeOptional<StorageStatusResult>("storage_status");
}

export async function fetchMarketSnapshot(): Promise<MarketSnapshot | null> {
  return invokeOptional<MarketSnapshot>("market_snapshot");
}

export async function openChartWindow(request: ChartWindowRequest): Promise<ChartWindowSummary | null> {
  return invokeDesktop<ChartWindowSummary>("open_chart_window", { request });
}

export async function focusChartWindow(id: string): Promise<boolean | null> {
  return invokeOptional<boolean>("focus_chart_window", { id });
}

export async function closeChartWindow(id: string): Promise<boolean | null> {
  return invokeOptional<boolean>("close_chart_window", { id });
}

export async function listChartWindows(): Promise<ChartWindowSummary[] | null> {
  return invokeOptional<ChartWindowSummary[]>("list_chart_windows");
}

export async function updateChartWindowState(state: ChartWindowState): Promise<ChartWindowSummary | null> {
  return invokeOptional<ChartWindowSummary>("update_chart_window_state", { state });
}

export async function listChartWorkspaces(): Promise<ChartWorkspace[] | null> {
  return invokeOptional<ChartWorkspace[]>("chart_workspaces_list");
}

export async function loadChartWorkspace(id: string): Promise<ChartWorkspace | null> {
  return invokeOptional<ChartWorkspace>("chart_workspace_load", { id });
}

export async function saveChartWorkspace(input: ChartWorkspaceInput): Promise<ChartWorkspace | null> {
  return invokeOptional<ChartWorkspace>("chart_workspace_save", { input });
}

export async function deleteChartWorkspace(id: string): Promise<boolean | null> {
  return invokeOptional<boolean>("chart_workspace_delete", { id });
}

export async function listChartWorkspaceViews(workspaceId: string): Promise<ChartWorkspaceView[] | null> {
  return invokeOptional<ChartWorkspaceView[]>("chart_workspace_views_list", { workspaceId });
}

export async function saveChartWorkspaceView(input: ChartWorkspaceViewInput): Promise<ChartWorkspaceView | null> {
  return invokeOptional<ChartWorkspaceView>("chart_workspace_view_save", { input });
}

export async function deleteChartWorkspaceView(workspaceId: string, id: string): Promise<boolean | null> {
  return invokeOptional<boolean>("chart_workspace_view_delete", { workspaceId, id });
}

export async function listChartDrawings(workspaceId: string, viewId?: string | null): Promise<ChartDrawing[] | null> {
  return invokeOptional<ChartDrawing[]>("chart_drawings_list", { workspaceId, viewId });
}

export async function saveChartDrawing(input: ChartDrawingInput): Promise<ChartDrawing | null> {
  return invokeOptional<ChartDrawing>("chart_drawing_save", { input });
}

export async function deleteChartDrawing(workspaceId: string, id: string): Promise<boolean | null> {
  return invokeOptional<boolean>("chart_drawing_delete", { workspaceId, id });
}

export async function listChartAlerts(workspaceId: string, viewId?: string | null): Promise<ChartAlert[] | null> {
  return invokeOptional<ChartAlert[]>("chart_alerts_list", { workspaceId, viewId });
}

export async function saveChartAlert(input: ChartAlertInput): Promise<ChartAlert | null> {
  return invokeOptional<ChartAlert>("chart_alert_save", { input });
}

export async function deleteChartAlert(workspaceId: string, id: string): Promise<boolean | null> {
  return invokeOptional<boolean>("chart_alert_delete", { workspaceId, id });
}

export async function listChartAlertEvents(workspaceId: string, alertId?: string | null): Promise<ChartAlertEvent[] | null> {
  return invokeOptional<ChartAlertEvent[]>("chart_alert_events_list", { workspaceId, alertId });
}

export async function evaluateChartDsl(expression: ChartDslExpression, candles: Candle[]): Promise<ChartDslEvaluation | null> {
  return invokeOptional<ChartDslEvaluation>("chart_dsl_evaluate", { input: { expression, candles } });
}

export async function loadProxyConfig(): Promise<ProxyConfigSummary | null> {
  return invokeOptional<ProxyConfigSummary>("proxy_config_summary");
}

export async function saveProxyConfig(update: ProxyConfigUpdate): Promise<ProxyConfigSummary | null> {
  return invokeOptional<ProxyConfigSummary>("save_proxy_config", { update });
}

export async function testProxyConfig(update: ProxyConfigUpdate): Promise<ProxyTestResult | null> {
  return invokeOptional<ProxyTestResult>("test_proxy_config", { update });
}

export async function migrateSensitiveConfig(): Promise<SensitiveConfigMigrationResult | null> {
  return invokeOptional<SensitiveConfigMigrationResult>("migrate_sensitive_config");
}

export async function loadWatchlistConfig(): Promise<WatchlistConfig | null> {
  return invokeOptional<WatchlistConfig>("load_watchlist_config");
}

export async function saveWatchlistConfig(config: WatchlistConfig): Promise<WatchlistConfig | null> {
  return invokeOptional<WatchlistConfig>("save_watchlist_config", { config });
}

export async function testPublicWsReachability(): Promise<OkxWsProbeResult> {
  if (isTauriRuntime()) {
    const viaTauri = await invokeDesktop<OkxWsProbeResult>("okx_public_ws_probe");
    if (!viaTauri) throw new Error("OKX Public WebSocket probe returned no result");
    return viaTauri;
  }

  return testBrowserWsReachability(PUBLIC_WS, { channel: "tickers", instId: "BTC-USDT-SWAP" }, "tickers", "OKX Public WS 可达", "OKX Public WebSocket");
}

export async function testBusinessWsReachability(): Promise<OkxWsProbeResult> {
  if (isTauriRuntime()) {
    const viaTauri = await invokeDesktop<OkxWsProbeResult>("okx_business_ws_probe");
    if (!viaTauri) throw new Error("OKX Business WebSocket probe returned no result");
    return viaTauri;
  }

  return testBrowserWsReachability(BUSINESS_WS, { channel: "candle1m", instId: "BTC-USDT-SWAP" }, "candle1m", "OKX Business WS 可达", "OKX Business WebSocket");
}

function testBrowserWsReachability(
  url: string,
  arg: { channel: string; instId: string },
  expectedChannel: string,
  successMessage: string,
  label: string
): Promise<OkxWsProbeResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = window.setTimeout(() => {
      socket.close();
      reject(new Error(`${label} 探测超时`));
    }, 8000);
    const finish = (result: OkxWsProbeResult) => {
      window.clearTimeout(timer);
      socket.close();
      resolve(result);
    };
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        op: "subscribe",
        args: [arg]
      }));
    });
    socket.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(String(event.data));
        if (data.event === "error") {
          window.clearTimeout(timer);
          reject(new Error(`${label} 订阅被拒绝: ${String(event.data).slice(0, 240)}`));
          return;
        }
        if (data.event === "subscribe" || data.arg?.channel === expectedChannel) {
          finish({ ok: true, latencyMs: Date.now() - started, message: successMessage });
        }
      } catch {
        // Ignore non-JSON frames.
      }
    });
    socket.addEventListener("error", () => {
      window.clearTimeout(timer);
      reject(new Error(`${label} 不可达`));
    });
  });
}

export async function syncMarketAssets(): Promise<MarketAssetsSummary | null> {
  try {
    return await invokeDesktop<MarketAssetsSummary>("okx_sync_market_assets");
  } catch (error) {
    logger.error("rust market asset sync failed, trying web fallback", error);
    return syncMarketAssetsViaWeb();
  }
}

export async function loadMarketAssetsCache(): Promise<MarketAssetsSummary | null> {
  return invokeOptional<MarketAssetsSummary>("load_market_assets_cache");
}

export async function ensureInstrumentsCache(instIds: string[]): Promise<MarketAssetsSummary | null> {
  if (instIds.length === 0) return loadMarketAssetsCache();
  return invokeOptional<MarketAssetsSummary>("ensure_instruments_cache", { instIds });
}

async function syncMarketAssetsViaWeb(): Promise<MarketAssetsSummary | null> {
  const instruments = await okxFetch<{ data: Record<string, string>[] }>("/api/v5/public/instruments?instType=SWAP");
  const swaps = instruments.data.filter((item) => item.instType === "SWAP");
  const bases = Array.from(new Set(swaps.map((item) => (item.baseCcy || item.instId?.split("-")[0] || "").toLowerCase()).filter(Boolean)));
  const icons: Record<string, string> = {};
  await runLimited(bases, 6, async (base) => {
    try {
      const response = await fetch(`https://static.okx.com/cdn/oksupport/asset/currency/icon/${base}.png`);
      if (!response.ok) return;
      const buffer = await response.arrayBuffer();
      icons[base] = arrayBufferToBase64(buffer);
    } catch (error) {
      logger.error("market icon web download failed", error, { base });
    }
  });
  return invokeDesktop<MarketAssetsSummary>("save_market_assets_cache", {
    request: { instruments: swaps, icons }
  });
}

async function runLimited<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export async function fetchTicker(instId: string): Promise<Ticker> {
  if (isTauriRuntime()) {
    const viaTauri = await invokeDesktop<Ticker>("okx_ticker", { instId });
    if (!viaTauri) throw new Error(`OKX ticker returned no result for ${instId}`);
    return viaTauri;
  }

  const json = await okxFetch<{ data: Record<string, string>[] }>(`/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`);
  return normalizeTicker(json.data[0]);
}

export async function fetchFundingRate(instId: string): Promise<FundingRate | null> {
  if (isTauriRuntime()) {
    return await invokeDesktop<FundingRate | null>("okx_funding_rate", { instId });
  }
  const json = await okxFetch<{ data: Record<string, string>[] }>(`/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`);
  return json.data[0] ? normalizeFundingRate(json.data[0]) : null;
}

export async function fetchCandles(instId: string, bar: string, limit = 300): Promise<Candle[]> {
  const boundedLimit = Math.min(Math.max(limit, 1), 300);
  if (isTauriRuntime()) {
    let localFailure: unknown = null;
    try {
      const local = await invokeDesktop<Candle[]>("local_candles", { instId, bar, limit: boundedLimit });
      if (local && local.length > 0) return local;
    } catch (error) {
      localFailure = error;
      logger.warn("local candle read failed; requesting native market snapshot", {
        instId,
        bar,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      const snapshot = await invokeDesktop<Candle[]>("okx_candles", { instId, bar, limit: boundedLimit });
      if (snapshot && snapshot.length > 0) return snapshot;
      throw new Error(`OKX returned no ${bar} candles for ${instId}`);
    } catch (snapshotFailure) {
      const localDetail = localFailure
        ? ` Local cache: ${localFailure instanceof Error ? localFailure.message : String(localFailure)}`
        : " Local cache returned no candles.";
      throw new Error(
        `Unable to load ${bar} candles for ${instId}.${localDetail} Native market request: ${snapshotFailure instanceof Error ? snapshotFailure.message : String(snapshotFailure)}`
      );
    }
  }

  const json = await okxFetch<{ data: string[][] }>(
    `/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${encodeURIComponent(bar)}&limit=${boundedLimit}`
  );
  return json.data.map(normalizeCandle).reverse();
}

export type HistoricalCandlesSource = "local" | "history" | "mixed";

export interface HistoricalCandlesPage {
  candles: Candle[];
  earliestTime: number | null;
  exhausted: boolean;
  source: HistoricalCandlesSource;
}

export async function registerMarketConsumer(registration: MarketConsumerRegistration): Promise<MarketConsumerStatus | null> {
  return invokeOptional<MarketConsumerStatus>("register_market_consumer", { registration });
}

export async function unregisterMarketConsumer(consumerId: string): Promise<MarketConsumerStatus | null> {
  return invokeOptional<MarketConsumerStatus>("unregister_market_consumer", { consumerId });
}

export async function fetchHistoricalCandlesBefore(instId: string, bar: string, beforeTime: number, limit = 300): Promise<HistoricalCandlesPage> {
  const boundedLimit = Math.min(Math.max(limit, 1), 300);
  return await invokeDesktop<HistoricalCandlesPage>("historical_candles_before", {
    instId,
    bar,
    beforeTime,
    limit: boundedLimit
  }) ?? { candles: [], earliestTime: null, exhausted: false, source: "local" };
}

export async function syncKlineIntegrity(
  symbols: string[],
  intervals?: string[],
  blocking = false,
  recentHours?: number,
  requiredDays?: Record<string, number>
): Promise<KlineSyncSummary | null> {
  return invokeOptional<KlineSyncSummary>("sync_kline_integrity", {
    request: { symbols, intervals, blocking, recentHours, requiredDays }
  });
}

export async function listenKlineSync(handler: (report: KlineSyncReport) => void): Promise<(() => void) | null> {
  return listenOptional<KlineSyncReport>("kline:sync", handler);
}

export async function listenTradeAuditEvents(handler: (event: TradeAuditEventSummary) => void): Promise<(() => void) | null> {
  return listenOptional<TradeAuditEventSummary>("trade:audit", handler);
}

export function normalizeTicker(raw: Record<string, string>): Ticker {
  return {
    instId: raw.instId,
    last: raw.last,
    lastSz: raw.lastSz,
    askPx: raw.askPx,
    askSz: raw.askSz,
    bidPx: raw.bidPx,
    bidSz: raw.bidSz,
    open24h: raw.open24h,
    high24h: raw.high24h,
    low24h: raw.low24h,
    vol24h: raw.vol24h,
    volCcy24h: raw.volCcy24h,
    ts: Number(raw.ts)
  };
}

export function normalizeCandle(row: string[]): Candle {
  return {
    time: Math.floor(Number(row[0]) / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    confirm: row[8] === "1"
  };
}

export type MarketCallbacks = {
  onTicker?: (ticker: Ticker) => void;
  onWatchTicker?: (ticker: Ticker) => void;
  onOrderBook?: (book: OrderBook) => void;
  onTrade?: (trade: Trade) => void;
  onTrades?: (trades: Trade[]) => void;
  onCandle?: (candle: Candle) => void;
  onFundingRate?: (funding: FundingRate) => void;
  onStatus?: (status: string) => void;
  onPublicStatus?: (status: PublicWsStatus) => void;
  onPrivateSnapshot?: (snapshot: PrivateAccountSnapshot) => void;
  onPrivateOrder?: (order: OkxPendingOrder, accountId: string, environment: string) => void;
  onPrivateStatus?: (status: PrivateWsStatus) => void;
};

type TauriMarketEvent =
  | { type: "status"; status: string }
  | ({ type: "publicStatus" } & PublicWsStatus)
  | { type: "ticker"; ticker: Ticker }
  | { type: "orderBook"; instId?: string; book: OrderBook }
  | { type: "trade"; instId?: string; trade: Trade }
  | { type: "trades"; instId?: string; trades: Trade[] }
  | { type: "renderBatch"; orderBooks: Record<string, OrderBook>; trades: Record<string, Trade[]> }
  | { type: "candle"; instId?: string; bar?: string; candle: Candle }
  | { type: "fundingRate"; funding: FundingRate }
  | { type: "privateSnapshot"; snapshot: PrivateAccountSnapshot }
  | { type: "privateOrder"; accountId: string; environment: string; order: OkxPendingOrder }
  | ({ type: "privateStatus" } & PrivateWsStatus)
  | { type: "error"; message: string };

type MarketStreamErrorState = {
  firstAt: number;
  count: number;
  lastNotifiedAt: number;
};

const MARKET_STREAM_ERROR_NOTIFY_AFTER_COUNT = 5;
const MARKET_STREAM_ERROR_NOTIFY_AFTER_MS = 60_000;
const MARKET_STREAM_ERROR_NOTIFY_COOLDOWN_MS = 5 * 60_000;

function marketStreamIdFromError(message: string) {
  return message.match(/^(.+?) WS:/)?.[1]?.trim() || "market";
}

function isMarketStreamReconnectError(message: string) {
  return /\bWS:/.test(message) && /后重连|retry|reconnect/i.test(message);
}

export function connectMarketStream(
  instId: string,
  bar: string,
  callbacks: MarketCallbacks,
  watchlist: string[] = [instId]
) {
  if (isTauriRuntime()) {
    const sessionId = `market-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let closed = false;
    let browserFallback: (() => void) | null = null;
    const listenerCleanup = createDeferredCleanupSlot();
    const reconnectErrors = new Map<string, MarketStreamErrorState>();
    const startBrowserFallback = () => {
      if (closed || browserFallback) return;
      logger.info("falling back to browser OKX WebSocket", { instId, bar });
      callbacks.onStatus?.("browser websocket fallback");
      browserFallback = connectOkxPublic(instId, bar, callbacks, watchlist);
    };

    void listenOptional<TauriMarketEvent>("market:event", (event) => {
      if (closed) return;
      if (event.type === "status") callbacks.onStatus?.(event.status);
      if (event.type === "publicStatus") {
        callbacks.onPublicStatus?.(event);
        callbacks.onStatus?.(event.status);
        if (event.state === "ready") reconnectErrors.delete(event.streamId);
      }
      if (event.type === "ticker") {
        callbacks.onWatchTicker?.(event.ticker);
        if (event.ticker.instId === instId) callbacks.onTicker?.(event.ticker);
      }
      if (event.type === "orderBook" && event.instId === instId) callbacks.onOrderBook?.(event.book);
      if (event.type === "trade" && event.instId === instId) callbacks.onTrade?.(event.trade);
      if (event.type === "trades" && event.instId === instId) {
        if (callbacks.onTrades) callbacks.onTrades(event.trades);
        else for (const trade of event.trades) callbacks.onTrade?.(trade);
      }
      if (event.type === "renderBatch") {
        const book = event.orderBooks[instId];
        const trades = event.trades[instId];
        if (book) callbacks.onOrderBook?.(book);
        if (trades?.length) {
          if (callbacks.onTrades) callbacks.onTrades(trades);
          else for (const trade of trades) callbacks.onTrade?.(trade);
        }
      }
      if (event.type === "candle" && event.instId === instId && (!event.bar || event.bar === bar || event.bar === "1m")) callbacks.onCandle?.(event.candle);
      if (event.type === "fundingRate" && event.funding.instId === instId) callbacks.onFundingRate?.(event.funding);
      if (event.type === "privateSnapshot") callbacks.onPrivateSnapshot?.(event.snapshot);
      if (event.type === "privateOrder") callbacks.onPrivateOrder?.(event.order, event.accountId, event.environment);
      if (event.type === "privateStatus") callbacks.onPrivateStatus?.(event);
      if (event.type === "error") {
        if (isMarketStreamReconnectError(event.message)) {
          const streamId = marketStreamIdFromError(event.message);
          const now = Date.now();
          const state = reconnectErrors.get(streamId) ?? { firstAt: now, count: 0, lastNotifiedAt: 0 };
          state.count += 1;
          const persistent =
            state.count >= MARKET_STREAM_ERROR_NOTIFY_AFTER_COUNT ||
            now - state.firstAt >= MARKET_STREAM_ERROR_NOTIFY_AFTER_MS;
          if (persistent && now - state.lastNotifiedAt >= MARKET_STREAM_ERROR_NOTIFY_COOLDOWN_MS) {
            state.lastNotifiedAt = now;
            logger.error("market stream unavailable", event.message, { streamId, consecutiveErrors: state.count });
          } else {
            logger.warn("market stream reconnecting", { message: event.message, streamId, consecutiveErrors: state.count });
          }
          reconnectErrors.set(streamId, state);
        } else {
          logger.error("market stream error", event.message);
        }
        callbacks.onStatus?.(event.message);
      }
    }).then((cleanup) => listenerCleanup.settle(cleanup));

    void invokeDesktop<void>("start_market_stream", { instId, bar, watchlist, sessionId })
      .catch(() => startBrowserFallback());

    return () => {
      closed = true;
      listenerCleanup.dispose();
      browserFallback?.();
      void invokeOptional("stop_market_stream", { sessionId });
    };
  }

  return connectOkxPublic(instId, bar, callbacks, watchlist);
}

export function connectOkxPublic(instId: string, bar: string, callbacks: MarketCallbacks, watchlist: string[] = [instId]) {
  const publicWs = new WebSocket(PUBLIC_WS);
  const businessWs = new WebSocket(BUSINESS_WS);
  const orderbooks = new Map<string, OrderBook>();
  const resubscribeOrderBook = (symbol: string) => {
    if (publicWs.readyState !== WebSocket.OPEN) return;
    const arg = { channel: "books", instId: symbol };
    publicWs.send(JSON.stringify({ op: "unsubscribe", args: [arg] }));
    publicWs.send(JSON.stringify({ op: "subscribe", args: [arg] }));
  };

  publicWs.addEventListener("open", () => {
    callbacks.onStatus?.("public connected");
    const symbols = Array.from(new Set([...watchlist, instId])).slice(0, 10);
    publicWs.send(
      JSON.stringify({
        op: "subscribe",
        args: [
          ...symbols.map((symbol) => ({ channel: "tickers", instId: symbol })),
          ...symbols.flatMap((symbol) => [
            { channel: "books", instId: symbol },
            { channel: "funding-rate", instId: symbol },
            { channel: "trades", instId: symbol }
          ])
        ]
      })
    );
  });

  publicWs.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data);
      const channel = msg.arg?.channel;
      if (!Array.isArray(msg.data)) return;
      if (channel === "tickers") {
        const ticker = normalizeTicker(msg.data[0]);
        callbacks.onWatchTicker?.(ticker);
        if (ticker.instId === instId) callbacks.onTicker?.(ticker);
      }
      if (channel === "books") {
        const symbol = msg.arg?.instId;
        if (typeof symbol === "string") {
          const next = mergeOrderBook(orderbooks.get(symbol), normalizeOrderBook(msg.data[0]), msg.data[0], msg.action);
          if (next.invalidChecksum || next.invalidSequence) {
            orderbooks.delete(symbol);
            callbacks.onStatus?.(`${symbol} 盘口${next.invalidChecksum ? " checksum 校验失败" : "序列断裂"}，已重订阅`);
            resubscribeOrderBook(symbol);
            return;
          }
          if (next.cached) orderbooks.set(symbol, next.cached);
          if (next.render && symbol === instId) callbacks.onOrderBook?.(next.render);
        }
      }
      if (channel === "funding-rate" && msg.arg?.instId === instId) callbacks.onFundingRate?.(normalizeFundingRate(msg.data[0]));
      if (channel === "trades" && msg.arg?.instId === instId) {
        const trades = msg.data.map(normalizeTrade);
        if (callbacks.onTrades) callbacks.onTrades(trades);
        else for (const trade of trades) callbacks.onTrade?.(trade);
      }
    } catch (error) {
      logger.error("failed to parse OKX public ws message", error);
    }
  });

  businessWs.addEventListener("open", () => {
    callbacks.onStatus?.("business connected");
    const symbols = Array.from(new Set([...watchlist, instId])).slice(0, 10);
    const args = symbols.flatMap((symbol) => OKX_KLINE_BARS.map((item) => ({ channel: `candle${item}`, instId: symbol })));
    for (let index = 0; index < args.length; index += 80) {
      businessWs.send(JSON.stringify({ op: "subscribe", args: args.slice(index, index + 80) }));
    }
  });

  businessWs.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.arg?.channel !== "candle1m" || msg.arg?.instId !== instId || !Array.isArray(msg.data)) return;
      callbacks.onCandle?.(normalizeCandle(msg.data[0]));
    } catch (error) {
      logger.error("failed to parse OKX business ws message", error);
    }
  });

  publicWs.addEventListener("error", () => callbacks.onStatus?.("public error"));
  businessWs.addEventListener("error", () => callbacks.onStatus?.("business error"));
  publicWs.addEventListener("close", () => callbacks.onStatus?.("public closed"));
  businessWs.addEventListener("close", () => callbacks.onStatus?.("business closed"));

  return () => {
    publicWs.close();
    businessWs.close();
  };
}

function normalizeOrderBook(raw: Record<string, unknown>): OrderBook {
  const bids = Array.isArray(raw.bids) ? raw.bids : [];
  const asks = Array.isArray(raw.asks) ? raw.asks : [];
  return {
    bids: bids.map((level) => normalizeLevel(level as string[])),
    asks: asks.map((level) => normalizeLevel(level as string[])),
    ts: Number(raw.ts),
    seqId: rawInteger(raw, "seqId")?.toString()
  };
}

function mergeOrderBook(
  previous: OrderBook | undefined,
  update: OrderBook,
  raw: Record<string, unknown>,
  actionValue: unknown
): { cached: OrderBook | null; render: OrderBook | null; invalidChecksum?: boolean; invalidSequence?: boolean } {
  const action = typeof actionValue === "string" ? actionValue : "";
  const prevSeqId = rawInteger(raw, "prevSeqId");
  const isSnapshot = action === "snapshot" || prevSeqId === null || prevSeqId <= 0;
  if (isSnapshot) {
    const cached = trimOrderBook(update);
    if (cached.bids.length > 0 && cached.asks.length > 0 && !orderBookChecksumValid(raw, cached)) {
      return { cached: null, render: previous ?? null, invalidChecksum: true };
    }
    return {
      cached: cached.bids.length > 0 && cached.asks.length > 0 ? cached : null,
      render: cached.bids.length >= MIN_RENDER_ORDERBOOK_LEVELS && cached.asks.length >= MIN_RENDER_ORDERBOOK_LEVELS ? cached : previous ?? null
    };
  }
  if (!previous) return { cached: null, render: null };
  const previousSeqId = previous.seqId ? Number(previous.seqId) : null;
  if (!Number.isFinite(previousSeqId) || prevSeqId !== previousSeqId) {
    return { cached: null, render: previous, invalidSequence: true };
  }
  const merged = trimOrderBook({
    bids: mergeOrderBookSide(previous.bids, update.bids, true),
    asks: mergeOrderBookSide(previous.asks, update.asks, false),
    ts: update.ts,
    seqId: update.seqId
  });
  if (merged.bids.length === 0 || merged.asks.length === 0) return { cached: null, render: previous ?? null };
  if (!orderBookChecksumValid(raw, merged)) return { cached: null, render: previous ?? null, invalidChecksum: true };
  return {
    cached: merged,
    render: merged.bids.length >= MIN_RENDER_ORDERBOOK_LEVELS && merged.asks.length >= MIN_RENDER_ORDERBOOK_LEVELS ? merged : previous ?? null
  };
}

function mergeOrderBookSide(levels: OrderBook["bids"], updates: OrderBook["bids"], descending: boolean) {
  const next = [...levels];
  for (const update of updates) {
    const size = Number(update.sz);
    const index = next.findIndex((level) => level.px === update.px);
    if (!Number.isFinite(size) || size <= 0) {
      if (index >= 0) next.splice(index, 1);
    } else if (index >= 0) {
      next[index] = update;
    } else {
      next.push(update);
    }
  }
  next.sort((left, right) => descending ? Number(right.px) - Number(left.px) : Number(left.px) - Number(right.px));
  return next.slice(0, 400);
}

function trimOrderBook(book: OrderBook): OrderBook {
  return {
    ...book,
    bids: book.bids
      .filter((level) => Number(level.sz) > 0)
      .sort((left, right) => Number(right.px) - Number(left.px))
      .slice(0, 400),
    asks: book.asks
      .filter((level) => Number(level.sz) > 0)
      .sort((left, right) => Number(left.px) - Number(right.px))
      .slice(0, 400)
  };
}

function orderBookChecksumValid(raw: Record<string, unknown>, book: OrderBook) {
  const expected = rawChecksum(raw);
  if (expected === null || expected === 0) return true;
  return orderBookChecksum(book) === expected;
}

function rawChecksum(raw: Record<string, unknown>) {
  const value = raw.checksum;
  if (typeof value === "number" && Number.isInteger(value)) return value | 0;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) return parsed | 0;
  }
  return null;
}

function rawInteger(raw: Record<string, unknown>, key: string) {
  const value = raw[key];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}

function orderBookChecksum(book: OrderBook) {
  const parts: string[] = [];
  const depth = Math.min(25, Math.max(book.bids.length, book.asks.length));
  for (let index = 0; index < depth; index += 1) {
    const bid = book.bids[index];
    const ask = book.asks[index];
    if (bid) parts.push(bid.px, bid.sz);
    if (ask) parts.push(ask.px, ask.sz);
  }
  return crc32Signed(parts.join(":"));
}

let crc32Table: Int32Array | null = null;

function crc32Signed(input: string) {
  if (!crc32Table) {
    crc32Table = new Int32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crc32Table[index] = value | 0;
    }
  }
  let crc = -1;
  for (let index = 0; index < input.length; index += 1) {
    crc = (crc >>> 8) ^ crc32Table[(crc ^ input.charCodeAt(index)) & 0xff];
  }
  return (crc ^ -1) | 0;
}

function normalizeLevel(level: string[]) {
  return {
    px: level[0],
    sz: level[1],
    orders: level[3]
  };
}

function normalizeTrade(raw: Record<string, string>): Trade {
  return {
    tradeId: raw.tradeId,
    px: raw.px,
    sz: raw.sz,
    side: raw.side === "sell" ? "sell" : "buy",
    ts: Number(raw.ts)
  };
}

function normalizeFundingRate(raw: Record<string, string>): FundingRate {
  return {
    instType: raw.instType,
    instId: raw.instId,
    fundingRate: raw.fundingRate,
    nextFundingRate: raw.nextFundingRate,
    fundingTime: Number(raw.fundingTime),
    nextFundingTime: Number(raw.nextFundingTime),
    method: raw.method,
    ts: Number(raw.ts)
  };
}
