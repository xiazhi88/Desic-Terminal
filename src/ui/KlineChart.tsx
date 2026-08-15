import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n/runtime";
import clsx from "clsx";
import {
  AppWindow,
  BellRing,
  Braces,
  BoxSelect,
  Eraser,
  Eye,
  Layers3,
  Minus,
  MoveDiagonal2,
  Plus,
  Ruler,
  Send,
  Slash,
  Trash2,
  ChevronRight,
  TrendingDown,
  TrendingUp,
  Undo2,
  Webhook,
  X
} from "lucide-react";
import { listChartAlerts, loadChartWorkspace, saveChartWorkspace } from "../lib/okx";
import { listenOptional } from "../lib/tauri";
import { createDeferredCleanupSlot } from "../lib/deferredCleanup";
import { buildChartAlertIndicatorOptions } from "../lib/chartAlertIndicators";
import { ChartDataController, type ChartDataPatch } from "../lib/chartDataController";
import {
  INDICATOR_DEFINITIONS,
  calculateIndicator,
  createIndicatorCalculator,
  type IndicatorInstance,
  type IndicatorResult
} from "../lib/chartIndicators";
import {
  createTradingChart,
  MAIN_CHART_PANE_ID,
  type ChartCrosshairPosition,
  type ChartMarkerPoint,
  type ChartPriceLine,
  type ChartVisibleLogicalRange,
  type TradingChartHandle,
  formatShanghaiChartTimestamp
} from "./chartAdapter";
import {
  createDefaultChartScript,
  emptyChartScriptOutput,
  loadChartScripts,
  runChartScript,
  saveChartScripts,
  withSavedChartScriptVersion,
  type ChartScriptDefinition,
  type ChartScriptOrderBookPressure,
  type ChartScriptOutput,
  type ChartScriptRunState
} from "./chartScriptEngine";
import { ChartIndicatorCenter, indicatorColor } from "./ChartIndicatorCenter";
import { TerminalSelect } from "./TerminalSelect";
import { useDraggableSurface } from "./useDraggableSurface";
import {
  chartTradeVisual,
  formatChartAmount,
  resolveChartTradeAction,
} from "../lib/chartTradeSemantics";
import type { Candle, ChartFillMarker, ChartOrderLine, ChartTradeSources, ChartOrderLineEdit, ChartPositionRange, ChartRiskRewardTradeIntent, ChartSignalMarker, FundingRate, OrderBook, PositionLineTradeIntent, Ticker, Trade } from "../types";

const ChartScriptEditor = lazy(() =>
  import("./ChartScriptEditor").then((module) => ({ default: module.ChartScriptEditor }))
);

const CHART_SCRIPT_PANE_PREFIX = "pane-script-";
const DRAWING_EDIT_DRAG_THRESHOLD = 3;
const RISK_REWARD_CREATE_DRAG_THRESHOLD = 6;

export type ChartContextTradeIntent = Readonly<{
  action: "long" | "short" | "close-long" | "close-short";
  orderType: "limit" | "market";
  price: number;
  symbol: string;
}>;

type Props = {
  candles: Candle[];
  ticker: Ticker | null;
  symbol?: string;
  timeframe?: string;
  orderBook?: OrderBook | null;
  recentTrades?: Trade[];
  fundingRate?: FundingRate | null;
  orderLines?: ChartOrderLine[];
  signals?: ChartSignalMarker[];
  fills?: ChartFillMarker[];
  positionRanges?: ChartPositionRange[];
  variant?: "full" | "review";
  workspaceId?: string;
  persistWorkspace?: boolean;
  onNeedMoreHistory?: (payload: { firstTime: number }) => void;
  onChartCrosshairTime?: (time: number | null) => void;
  onChartCrosshairPosition?: (position: ChartCrosshairPosition | null) => void;
  onChartVisibleRange?: (range: { from: number; to: number } | null) => void;
  synchronizedCrosshairTime?: number | null;
  synchronizedCrosshairPosition?: ChartCrosshairPosition | null;
  followSynchronizedCrosshair?: boolean;
  synchronizedVisibleRange?: { from: number; to: number } | null;
  /** Review pages replace a bounded replay page instead of merging it with live chart history. */
  snapshotRevision?: string | number | null;
  onPriceAlert?: (payload: { price: number; direction: "above" | "below" | "cross"; last: number; source?: "manual" | "script" | "ai"; name?: string }) => void;
  onCreateChartAlert?: (payload: { id: string; symbol: string; definition: Record<string, unknown> }) => void;
  onDeletePriceAlert?: (payload: { id: string; symbol: string }) => void;
  onOrderLineEdit?: (payload: ChartOrderLineEdit) => void;
  onOrderLineCancel?: (line: ChartOrderLine) => void;
  onPositionLineTradeIntent?: (payload: PositionLineTradeIntent) => void;
  onPositionLineCloseRequest?: (payload: PositionLineTradeIntent) => void;
  onChartContextTrade?: (payload: ChartContextTradeIntent) => void;
  indicatorIds?: readonly string[];
  onIndicatorIdsChange?: (ids: readonly string[]) => void;
  toolbarPlacement?: "floating" | "external";
  externalIndicatorTrigger?: HTMLElement | null;
  externalToolbarAction?: { token: number; action: "indicators" | "alerts" | "undo" | "redo" } | null;
  externalLayerCommand?: { token: number; key: ChartLayerKey } | null;
  onLayerVisibilityChange?: (visibility: ChartLayerVisibility) => void;
  onDrawingHistoryChange?: (history: { canUndo: boolean; canRedo: boolean }) => void;
  onRiskRewardTradeIntent?: (payload: ChartRiskRewardTradeIntent) => void;
  tradeSources?: ChartTradeSources | null;
};

type HoverStats = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  indicatorValues: HoverIndicatorValue[];
};

type HoverIndicatorValue = {
  id: string;
  label: string;
  value: number;
  color: string;
};

type MeasurePoint = {
  time: number;
  index: number;
  price: number;
};

type MeasureSelection = {
  start: MeasurePoint | null;
  end: MeasurePoint | null;
};

type DrawingLine = {
  id: string;
  tool: DrawingTool;
  start: MeasurePoint;
  end: MeasurePoint;
  stop?: MeasurePoint;
  color?: string;
  lineStyle?: "solid" | "dashed" | "dotted";
  locked?: boolean;
  hidden?: boolean;
};

type DrawingTool = "trend" | "ray" | "horizontal" | "vertical" | "rect" | "long-position" | "short-position";

type DrawingOverlay = {
  id: string;
  tool: DrawingTool;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  yStop?: number;
  rectPoints?: [DrawingOverlayPoint, DrawingOverlayPoint, DrawingOverlayPoint, DrawingOverlayPoint];
  entryPrice?: number;
  targetPrice?: number;
  stopPrice?: number;
  label: string;
  selected: boolean;
  preview?: boolean;
  color?: string;
  lineStyle?: DrawingLine["lineStyle"];
  locked?: boolean;
};

type DrawingOverlayPoint = {
  x: number;
  y: number;
};

type PositionRangeOverlay = {
  id: string;
  yEntry: number;
  yCurrent: number;
  yHandle: number;
  label: string;
  tone: "positive" | "negative" | "neutral";
  range: ChartPositionRange;
};

type DrawingDrag = {
  id: string;
  handle: "start" | "end" | "body" | "top-left" | "top-right" | "bottom-left" | "bottom-right" | "top" | "right" | "bottom" | "left" | "entry" | "target" | "stop";
  origin: DrawingLine;
  snapshot: DrawingLine[];
  startPointer: { x: number; y: number };
};

type RiskRewardCreateGesture = {
  pointerId: number;
  tool: "long-position" | "short-position";
  entry: MeasurePoint;
  completeOnRelease: boolean;
  startPointer: { x: number; y: number };
};

type PriceAlert = {
  id: string;
  price: number;
  direction: "above" | "below" | "cross";
  createdAt: number;
  triggered: boolean;
  source?: "manual" | "script" | "ai";
  scriptId?: string;
  scriptAlertId?: string;
  name?: string;
};

type IndicatorAlert = {
  id: string;
  name: string;
  condition: string;
  createdAt: number;
  triggered: boolean;
  frequency: "once" | "repeat";
};

type AlertOperator = "crossingAbove" | "crossingBelow" | "crossing" | "greaterThan" | "lessThan";
type AlertExpiry = "never" | "day" | "week" | "month";

type AiChartAction = {
  id: string;
  sessionId: string;
  toolName: string;
  instId?: string | null;
  bar?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt: number;
};

type OrderLineDrag = {
  line: ChartOrderLine;
  price: number;
  y: number;
};

type FillTooltip = {
  marker: ChartFillMarker;
  x: number;
  y: number;
};

type FillMarkerOverlay = {
  marker: ChartFillMarker;
  x: number;
  y: number;
};

type PositionLineDrag = {
  range: ChartPositionRange;
  price: number;
  y: number;
  snapToMarket: boolean;
};

type GuideDrag = {
  tool: Extract<DrawingTool, "horizontal" | "vertical">;
};

type ReplayViewportTarget = {
  firstTime: number;
  range: ChartVisibleLogicalRange;
  spacing: number | null;
  expiresAt: number;
};

export type ChartLayerKey = "indicators" | "alerts" | "drawings" | "signals" | "fills" | "tools" | "priceLines";
export type ChartLayerVisibility = Record<ChartLayerKey, boolean>;

type FillSourceFilter = {
  ai: boolean;
  strategy: boolean;
  user: boolean;
  /** Empty record means "all profiles of that source are shown". */
  aiProfiles: Record<string, boolean>;
  strategyProfiles: Record<string, boolean>;
};

function fillPassesSourceFilter(marker: ChartFillMarker, filter: FillSourceFilter): boolean {
  const operator = marker.operator ?? "user";
  if (operator === "ai") {
    if (!filter.ai) return false;
    const selected = Object.keys(filter.aiProfiles);
    if (selected.length === 0) return true;
    return marker.aiProfileId != null && filter.aiProfiles[marker.aiProfileId] === true;
  }
  if (operator === "strategy") {
    if (!filter.strategy) return false;
    const selected = Object.keys(filter.strategyProfiles);
    if (selected.length === 0) return true;
    return marker.strategyId != null && filter.strategyProfiles[marker.strategyId] === true;
  }
  // user, system, and legacy fills without an operator ride the user toggle.
  return filter.user;
}

const CHART_LAYER_MENU_ITEMS: ReadonlyArray<readonly [Exclude<ChartLayerKey, "indicators">, string, string]> = [
  ["priceLines", "Price lines", "价格线"],
  ["drawings", "Drawings", "绘图"],
  ["signals", "Analysis", "分析观点"],
  ["fills", "Fills", "真实成交"],
  ["tools", "Measurement tools", "测距工具"]
];

type ScriptLineOverlay = {
  id: string;
  name: string;
  d: string;
  color: string;
  width: number;
};

type ScriptHLineOverlay = {
  id: string;
  name: string;
  y: number;
  color: string;
  width: number;
  dashed: boolean;
};

type ScriptBandOverlay = {
  id: string;
  name: string;
  points: string;
  color: string;
};

type ScriptMarkerOverlay = {
  id: string;
  x: number;
  y: number;
  text?: string;
  color: string;
  kind: "marker" | "label";
};

const DRAWING_STORAGE_PREFIX = "desictrade.chart.drawings.v1.";
const EMPTY_TRADES: Trade[] = [];
const EMPTY_ORDER_LINES: ChartOrderLine[] = [];
const EMPTY_SIGNALS: ChartSignalMarker[] = [];
const EMPTY_FILLS: ChartFillMarker[] = [];
const EMPTY_POSITION_RANGES: ChartPositionRange[] = [];

function hasOrderCancellationIdentity(line: ChartOrderLine) {
  return line.source !== "position"
    && Boolean(line.orderId || line.clientOrderId || line.algoId || line.algoClientOrderId);
}
function chartText(english: string, chinese: string) {
  const language = i18n.resolvedLanguage || i18n.language || "en-US";
  return language.toLowerCase().startsWith("zh") ? chinese : english;
}

/**
 * Resolve a timestamp only when it belongs to the currently rendered page.
 * A lower-bound search alone returns index 0 for a timestamp before the page,
 * which made replay paging frame the page as `-span..1` while the parent was
 * still handing the cursor from the previous page to the new one.
 */
function candleIndexForPage(candles: readonly Candle[], time: number | null | undefined): number | undefined {
  if (!Number.isFinite(time) || candles.length === 0) return undefined;
  const target = Number(time);
  const first = candles[0]?.time;
  const last = candles[candles.length - 1]?.time;
  if (first === undefined || last === undefined || target < first || target > last) return undefined;
  let low = 0;
  let high = candles.length - 1;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (candles[middle].time < target) low = middle + 1;
    else high = middle;
  }
  if (low > 0 && Math.abs(candles[low - 1].time - target) < Math.abs(candles[low].time - target)) return low - 1;
  return low;
}

const drawingToolbarItems = [
  { kind: "measure", english: "Measure", chinese: "测距", icon: Ruler },
  { kind: "rect", english: "Range", chinese: "区间", icon: BoxSelect },
  { kind: "long-position", english: "Long position", chinese: "多头仓位", icon: TrendingUp },
  { kind: "short-position", english: "Short position", chinese: "空头仓位", icon: TrendingDown }
] as const;

const lineToolItems = [
  { kind: "trend", english: "Trend line", chinese: "趋势线", icon: TrendingUp },
  { kind: "ray", english: "Ray", chinese: "射线", icon: Slash },
  { kind: "horizontal", english: "Horizontal line", chinese: "水平线", icon: Minus },
  { kind: "vertical", english: "Vertical line", chinese: "垂直线", icon: MoveDiagonal2 }
] as const;

const AUTO_FIT_READY_CANDLE_COUNT = 80;
/// Bars shown around the replay cursor when a new page has no prior zoom to
/// inherit. Wide enough to read structure around the cursor without rendering
/// the whole 1500-bar page as a dense wall.
const REPLAY_DEFAULT_VISIBLE_BARS = 180;
const REPLAY_MIN_VISIBLE_BARS = 40;
const REPLAY_VIEWPORT_GUARD_MS = 1_500;
const FILL_SOURCE_LIMIT = 160;
const DISPLAY_FILL_LIMIT = 100;
const EXPANDED_MARKER_MAX_VISIBLE_BARS = 48;
const EXPANDED_MARKER_MAX_VISIBLE_EVENTS = 36;
const DEFAULT_INDICATOR_INSTANCES: readonly IndicatorInstance[] = [
  { id: "builtin-ma5", definitionId: "ma", paneId: "main", visible: true, parameters: { period: 5 } },
  { id: "builtin-ma10", definitionId: "ma", paneId: "main", visible: true, parameters: { period: 10 } },
  { id: "builtin-ema21", definitionId: "ema", paneId: "main", visible: false, parameters: { period: 21 } },
  { id: "builtin-vwap", definitionId: "vwap", paneId: "main", visible: false, parameters: {} }
];

export function KlineChart({ candles, ticker, symbol = "BTC-USDT-SWAP", timeframe = "30m", orderBook = null, recentTrades = EMPTY_TRADES, fundingRate = null, orderLines = EMPTY_ORDER_LINES, signals = EMPTY_SIGNALS, fills = EMPTY_FILLS, positionRanges = EMPTY_POSITION_RANGES, variant = "full", workspaceId = "main-chart", persistWorkspace, onNeedMoreHistory, onChartCrosshairTime, onChartCrosshairPosition, onChartVisibleRange, synchronizedCrosshairTime, synchronizedCrosshairPosition, followSynchronizedCrosshair = false, synchronizedVisibleRange, snapshotRevision, onPriceAlert, onCreateChartAlert, onDeletePriceAlert, onOrderLineEdit, onOrderLineCancel, onPositionLineTradeIntent, onPositionLineCloseRequest, onChartContextTrade, onRiskRewardTradeIntent, indicatorIds, onIndicatorIdsChange, toolbarPlacement = "floating", externalIndicatorTrigger = null, externalToolbarAction = null, externalLayerCommand = null, tradeSources = null, onLayerVisibilityChange, onDrawingHistoryChange }: Props) {
  const { t } = useTranslation(["trading", "chart", "common"]);
  const localizedTradeAction = useCallback((action: ReturnType<typeof resolveChartTradeAction>) => {
    if (action === "open-long") return t("trading:long");
    if (action === "open-short") return t("trading:short");
    if (action === "close-long") return t("trading:closeLong");
    if (action === "close-short") return t("trading:closeShort");
    return t("trading:trade");
  }, [t]);
  const reviewVariant = variant === "review";
  const localizedTradeOpinion = useCallback((signal: ChartSignalMarker) => {
    const action = resolveChartTradeAction(signal);
    if (action === "open-long" || action === "close-short") return { label: t("chart:bullish"), positive: true };
    if (action === "open-short" || action === "close-long") return { label: t("chart:bearish"), positive: false };
    return { label: t("chart:opinion"), positive: true };
  }, [t]);
  const localizedFillMarker = useCallback((fill: ChartFillMarker) => {
    const actionLabel = localizedTradeAction(resolveChartTradeAction(fill));
    if (!reviewVariant) return t("chart:fillMarker", { action: actionLabel });
    const reason = String(fill.label ?? "").toLowerCase().replace(/[^a-z]/g, "");
    if (reason.includes("protectivestop")) return `${t("trading:stopLoss")} · ${actionLabel}`;
    if (reason.includes("protectivetakeprofit")) return `${t("trading:takeProfit")} · ${actionLabel}`;
    return actionLabel;
  }, [localizedTradeAction, reviewVariant, t]);
  const orderLineCancellationEnabled = !reviewVariant && Boolean(onOrderLineCancel);
  const scriptPanelDrag = useDraggableSurface<HTMLDivElement>();
  const shouldPersistWorkspace = persistWorkspace ?? !reviewVariant;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<TradingChartHandle | null>(null);
  const candleMapRef = useRef<Map<number, Candle>>(new Map());
  const candleIndexRef = useRef<Map<number, number>>(new Map());
  const measureModeRef = useRef(false);
  const drawModeRef = useRef(false);
  const drawingToolRef = useRef<DrawingTool>("trend");
  const layerMenuRef = useRef<HTMLDivElement | null>(null);
  const alertPanelRef = useRef<HTMLElement | null>(null);
  const alertTriggerRef = useRef<HTMLButtonElement | null>(null);
  const priceAlertInputRef = useRef<HTMLInputElement | null>(null);
  const scriptLineKeysRef = useRef<Set<string>>(new Set());
  const scriptPaneIdsRef = useRef<Set<string>>(new Set());
  const managedIndicatorHoverValuesRef = useRef<Map<number, HoverIndicatorValue[]>>(new Map());
  const scriptIndicatorHoverValuesRef = useRef<Map<number, HoverIndicatorValue[]>>(new Map());
  const priceAlertLinesRef = useRef<Map<string, ChartPriceLine>>(new Map());
  const orderPriceLinesRef = useRef<Map<string, ChartPriceLine>>(new Map());
  const orderPriceLineSignaturesRef = useRef<Map<string, string>>(new Map());
  const priceAlertsRef = useRef<PriceAlert[]>([]);
  const loadedAlertKeyRef = useRef<string | null>(null);
  const previousLivePriceRef = useRef<number | null>(null);
  const drawingDragFrameRef = useRef<number | null>(null);
  const drawingDragPendingPointRef = useRef<MeasurePoint | null>(null);
  const riskRewardCreateGestureRef = useRef<RiskRewardCreateGesture | null>(null);
  const onNeedMoreHistoryRef = useRef<Props["onNeedMoreHistory"]>(onNeedMoreHistory);
  /// Read by the data-render effect to frame a new replay page. Kept in a ref so
  /// moving the cursor does not re-run that effect, which rebuilds indicators.
  const replayCursorTimeRef = useRef<number | null>(null);
  const replayViewportFrameRef = useRef<number | null>(null);
  const replayViewportEpochRef = useRef(0);
  const replayViewportTargetRef = useRef<ReplayViewportTarget | null>(null);
  const reviewVariantRef = useRef(reviewVariant);
  const candlesRef = useRef(candles);
  reviewVariantRef.current = reviewVariant;
  candlesRef.current = candles;
  const onChartCrosshairTimeRef = useRef<Props["onChartCrosshairTime"]>(onChartCrosshairTime);
  const onChartCrosshairPositionRef = useRef<Props["onChartCrosshairPosition"]>(onChartCrosshairPosition);
  const onChartVisibleRangeRef = useRef<Props["onChartVisibleRange"]>(onChartVisibleRange);
  const onOrderLineEditRef = useRef<Props["onOrderLineEdit"]>(onOrderLineEdit);
  const onOrderLineCancelRef = useRef<Props["onOrderLineCancel"]>(onOrderLineCancel);
  const onPositionLineTradeIntentRef = useRef<Props["onPositionLineTradeIntent"]>(onPositionLineTradeIntent);
  const onPositionLineCloseRequestRef = useRef<Props["onPositionLineCloseRequest"]>(onPositionLineCloseRequest);
  const onChartContextTradeRef = useRef<Props["onChartContextTrade"]>(onChartContextTrade);
  const onRiskRewardTradeIntentRef = useRef<Props["onRiskRewardTradeIntent"]>(onRiskRewardTradeIntent);
  const aiChartActionHandlerRef = useRef<(action: AiChartAction) => void>(() => undefined);
  const lastHistoryRequestFirstTimeRef = useRef<number | null>(null);
  const renderedFirstTimeRef = useRef<number | null>(null);
  const dataControllerRef = useRef(new ChartDataController());
  const renderedSeriesKeyRef = useRef("");
  const reviewSnapshotRevisionRef = useRef<string | number | null>(null);
  const indicatorCalculatorsRef = useRef(new Map<string, ReturnType<typeof createIndicatorCalculator>>());
  const indicatorSeriesKeysRef = useRef(new Set<string>());
  const indicatorConfigSignatureRef = useRef("");
  const workspaceLoadEpochRef = useRef(0);
  const requestMoreHistoryIfNeeded = useCallback((range: { from: number; to: number } | null) => {
    if (!range || range.from > 30) return;
    const first = candleMapRef.current.size ? Math.min(...candleMapRef.current.keys()) : null;
    if (!first || lastHistoryRequestFirstTimeRef.current === first) return;
    lastHistoryRequestFirstTimeRef.current = first;
    onNeedMoreHistoryRef.current?.({ firstTime: first });
  }, []);
  const [indicatorInstances, setIndicatorInstances] = useState<IndicatorInstance[]>(() => DEFAULT_INDICATOR_INSTANCES.map((item) => ({ ...item, parameters: { ...item.parameters } })));
  const externalIndicatorSignatureRef = useRef<string | null>(null);
  const [unavailableIndicatorIds, setUnavailableIndicatorIds] = useState<Set<string>>(() => new Set());
  const [workspaceReady, setWorkspaceReady] = useState(!shouldPersistWorkspace);
  const [gridVisible, setGridVisible] = useState(true);
  const [autoFit, setAutoFit] = useState(() => !reviewVariant);
  const [measureMode, setMeasureMode] = useState(false);
  const [measureSelection, setMeasureSelection] = useState<MeasureSelection>({ start: null, end: null });
  const [drawMode, setDrawMode] = useState(false);
  const [drawingTool, setDrawingTool] = useState<DrawingTool>("trend");
  const [lineToolMenuOpen, setLineToolMenuOpen] = useState(false);
  const [layerMenuOpen, setLayerMenuOpen] = useState(false);
  const [alertPanelOpen, setAlertPanelOpen] = useState(false);
  const [pendingDrawPoint, setPendingDrawPoint] = useState<MeasurePoint | null>(null);
  const [previewDrawPoint, setPreviewDrawPoint] = useState<MeasurePoint | null>(null);
  const [drawingLines, setDrawingLines] = useState<DrawingLine[]>([]);
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
  const [drawingHistory, setDrawingHistory] = useState<DrawingLine[][]>([]);
  const [drawingRedoHistory, setDrawingRedoHistory] = useState<DrawingLine[][]>([]);
  const [drawingDrag, setDrawingDrag] = useState<DrawingDrag | null>(null);
  const [guideDrag, setGuideDrag] = useState<GuideDrag | null>(null);
  const [drawingMenu, setDrawingMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [alertConditionKind, setAlertConditionKind] = useState<"price" | "indicator">("price");
  const [priceAlertInput, setPriceAlertInput] = useState("");
  const [priceAlertDirection, setPriceAlertDirection] = useState<"above" | "below">("above");
  const [priceAlerts, setPriceAlerts] = useState<PriceAlert[]>([]);
  const [indicatorAlerts, setIndicatorAlerts] = useState<IndicatorAlert[]>([]);
  const [indicatorAlertInstanceId, setIndicatorAlertInstanceId] = useState("");
  const [indicatorAlertOutputKey, setIndicatorAlertOutputKey] = useState("");
  const [indicatorAlertComparison, setIndicatorAlertComparison] = useState<"value" | "price">("value");
  const [indicatorAlertOperator, setIndicatorAlertOperator] = useState<AlertOperator>("crossingAbove");
  const [indicatorAlertThreshold, setIndicatorAlertThreshold] = useState("");
  const [alertName, setAlertName] = useState("");
  const [alertFrequency, setAlertFrequency] = useState<"once" | "repeat">("once");
  const [alertCooldownSeconds, setAlertCooldownSeconds] = useState("60");
  const [alertExpiry, setAlertExpiry] = useState<AlertExpiry>("never");
  const [alertNotifyApp, setAlertNotifyApp] = useState(true);
  const [alertNotifyFeishu, setAlertNotifyFeishu] = useState(false);
  const [alertNotifyWebhook, setAlertNotifyWebhook] = useState(false);
  const [alertWebhookMethod, setAlertWebhookMethod] = useState<"GET" | "POST">("POST");
  const [alertWebhookUrl, setAlertWebhookUrl] = useState("");
  const [alertFormError, setAlertFormError] = useState("");
  const [layerVisibility, setLayerVisibility] = useState<ChartLayerVisibility>({
    indicators: true,
    alerts: true,
    drawings: true,
    signals: true,
    fills: true,
    tools: true,
    priceLines: true
  });
  const [fillSourceFilter, setFillSourceFilter] = useState<FillSourceFilter>({
    ai: true,
    strategy: true,
    user: true,
    aiProfiles: {},
    strategyProfiles: {}
  });
  // The fill-source hierarchy stays collapsed by default; each level can be
  // expanded independently while the parent checkbox keeps working.
  const [fillMenuExpanded, setFillMenuExpanded] = useState(false);
  const [aiMenuExpanded, setAiMenuExpanded] = useState(false);
  const [strategyMenuExpanded, setStrategyMenuExpanded] = useState(false);
  const [scriptPanelOpen, setScriptPanelOpen] = useState(false);
  const initialScriptsRef = useRef<ChartScriptDefinition[] | null>(null);
  if (initialScriptsRef.current === null) initialScriptsRef.current = loadChartScripts();
  const [chartScripts, setChartScripts] = useState<ChartScriptDefinition[]>(() => initialScriptsRef.current ?? []);
  const [selectedScriptId, setSelectedScriptId] = useState<string | null>(() => initialScriptsRef.current?.[0]?.id ?? null);
  const savedScriptSourcesRef = useRef<Record<string, string>>({});
  if (Object.keys(savedScriptSourcesRef.current).length === 0) {
    for (const script of initialScriptsRef.current ?? []) savedScriptSourcesRef.current[script.id] = script.source;
  }
  const [scriptRunStates, setScriptRunStates] = useState<Record<string, ChartScriptRunState>>({});
  const [coordinateVersion, setCoordinateVersion] = useState(0);
  const [hoverStats, setHoverStats] = useState<HoverStats | null>(null);
  const [draggingOrderLine, setDraggingOrderLine] = useState<OrderLineDrag | null>(null);
  const [draggingPositionLine, setDraggingPositionLine] = useState<PositionLineDrag | null>(null);
  const [fillTooltip, setFillTooltip] = useState<FillTooltip | null>(null);
  const [fillTooltipPinned, setFillTooltipPinned] = useState(false);
  const [visibleLogicalRange, setVisibleLogicalRange] = useState<ChartVisibleLogicalRange | null>(null);
  const [hoveringEditableOrderLine, setHoveringEditableOrderLine] = useState(false);
  const [hoveringPositionHandle, setHoveringPositionHandle] = useState(false);
  const [chartContextMenu, setChartContextMenu] = useState<{ x: number; y: number; price: number } | null>(null);
  const [indicatorContextMenu, setIndicatorContextMenu] = useState<{ x: number; y: number; indicatorIds: string[] } | null>(null);

  useEffect(() => { onChartCrosshairTimeRef.current = onChartCrosshairTime; }, [onChartCrosshairTime]);
  useEffect(() => { onChartCrosshairPositionRef.current = onChartCrosshairPosition; }, [onChartCrosshairPosition]);
  useEffect(() => { onChartVisibleRangeRef.current = onChartVisibleRange; }, [onChartVisibleRange]);

  const latest = candles[candles.length - 1];
  const displayStats = hoverStats ?? latest ?? null;
  const change = displayStats ? displayStats.close - displayStats.open : 0;
  const changePercent = displayStats && displayStats.open > 0 ? (change / displayStats.open) * 100 : 0;
  const lastPrice = Number(ticker?.last);
  const livePrice = Number.isFinite(lastPrice) ? lastPrice : latest?.close;
  const activePriceAlerts = priceAlerts.filter((alert) => !alert.triggered);
  const activeIndicatorAlerts = indicatorAlerts.filter((alert) => !alert.triggered);
  const indicatorAlertOptions = useMemo(
    () => buildChartAlertIndicatorOptions(indicatorInstances, chartScripts),
    [chartScripts, indicatorInstances]
  );
  const selectableIndicatorAlertOptions = useMemo(
    () => indicatorAlertOptions.filter((item) => item.outputs.length > 0),
    [indicatorAlertOptions]
  );
  const selectedIndicatorAlertOption = selectableIndicatorAlertOptions.find((item) => item.id === indicatorAlertInstanceId)
    ?? selectableIndicatorAlertOptions[0]
    ?? null;
  const selectedIndicatorAlertOutput = selectedIndicatorAlertOption?.outputs.find((item) => item.key === indicatorAlertOutputKey)
    ?? selectedIndicatorAlertOption?.outputs[0]
    ?? null;
  const webhookRequestSample = useMemo(
    () => chartAlertWebhookSample(
      alertWebhookMethod,
      alertWebhookUrl,
      symbol,
      alertName,
      alertConditionKind,
      alertConditionKind === "price"
        ? priceAlertDirection
        : indicatorAlertOperator === "crossingBelow" || indicatorAlertOperator === "lessThan" ? "below" : indicatorAlertOperator === "crossing" ? "cross" : "above"
    ),
    [alertConditionKind, alertName, alertWebhookMethod, alertWebhookUrl, indicatorAlertOperator, priceAlertDirection, symbol]
  );
  const alertLineOverlays = useMemo(() => {
    const chart = chartRef.current;
    const container = containerRef.current;
    if (!chart || !container || reviewVariant || !layerVisibility.alerts) return [];
    coordinateVersion;
    return priceAlerts
      .filter((alert) => !alert.triggered)
      .map((alert) => {
        const y = chart.priceToCoordinate(alert.price);
        if (y === null) return null;
        return { alert, y: Math.max(16, Math.min(container.clientHeight - 16, Number(y))) };
      })
      .filter((item): item is { alert: PriceAlert; y: number } => Boolean(item));
  }, [coordinateVersion, layerVisibility.alerts, priceAlerts, reviewVariant]);
  const selectedScript = chartScripts.find((script) => script.id === selectedScriptId) ?? chartScripts[0] ?? null;
  const activeScriptCount = chartScripts.filter((script) => script.enabled && !script.hidden).length;
  const scriptVisibilitySignature = chartScripts.map((script) => `${script.id}:${script.enabled ? 1 : 0}:${script.hidden ? 1 : 0}`).join("|");
  const scriptOutput = useMemo(() => mergeScriptOutputs(chartScripts, scriptRunStates), [chartScripts, scriptRunStates]);
  const replayScriptPageSignature = reviewVariant && candles.length > 0
    ? `${candles[0]?.time ?? ""}:${candles[candles.length - 1]?.time ?? ""}`
    : "";
  const orderBookPressure = useMemo(() => calculateOrderBookPressure(orderBook, recentTrades), [orderBook, recentTrades]);
  const visibleFills = useMemo(
    () => fills.filter((marker) => fillPassesSourceFilter(marker, fillSourceFilter)),
    [fillSourceFilter, fills]
  );
  const markerDisplayMode = useMemo(() => {
    if (!visibleLogicalRange || candles.length === 0) {
      return { expanded: false, visibleBarSpan: candles.length, visibleEventCount: visibleFills.length + signals.length };
    }
    const fromIndex = Math.max(0, Math.floor(visibleLogicalRange.from));
    const toIndex = Math.min(candles.length - 1, Math.ceil(visibleLogicalRange.to));
    if (fromIndex > toIndex) {
      return { expanded: false, visibleBarSpan: candles.length, visibleEventCount: visibleFills.length + signals.length };
    }
    const fromTime = candles[fromIndex]?.time ?? candles[0]?.time;
    const toTime = candles[toIndex]?.time ?? candles[candles.length - 1]?.time;
    const isVisible = (time: number) => time >= Number(fromTime) && time <= Number(toTime);
    const visibleEventCount = visibleFills.filter((fill) => isVisible(Number(fill.time))).length
      + signals.filter((signal) => isVisible(Number(signal.time))).length;
    const visibleBarSpan = Math.max(1, toIndex - fromIndex + 1);
    return {
      expanded: visibleBarSpan <= EXPANDED_MARKER_MAX_VISIBLE_BARS
        && visibleEventCount <= EXPANDED_MARKER_MAX_VISIBLE_EVENTS,
      visibleBarSpan,
      visibleEventCount
    };
  }, [candles, signals, visibleFills, visibleLogicalRange]);
  const displayFillMarkers = useMemo(() => aggregateFillMarkers(candles, visibleFills), [candles, visibleFills]);
  const signalMarkers = useMemo(
    () => buildSignalMarkers(candles, signals, localizedTradeOpinion, markerDisplayMode.expanded),
    [candles, localizedTradeOpinion, markerDisplayMode.expanded, signals]
  );
  const fillMarkers = useMemo(
    () => buildFillMarkers(displayFillMarkers, localizedFillMarker, markerDisplayMode.expanded),
    [displayFillMarkers, localizedFillMarker, markerDisplayMode.expanded]
  );
  const fillMarkerOverlays = useMemo(() => {
    const chart = chartRef.current;
    if (!chart || candles.length === 0 || displayFillMarkers.length === 0) return [];
    coordinateVersion;
    return displayFillMarkers
      .map((marker): FillMarkerOverlay | null => {
        const x = chart.timeToCoordinate(marker.time);
        const y = chart.priceToCoordinate(marker.price);
        if (x === null || y === null) return null;
        return { marker, x: Number(x), y: Number(y) };
      })
      .filter((item): item is FillMarkerOverlay => Boolean(item));
  }, [coordinateVersion, displayFillMarkers]);
  const measureStats = useMemo(() => calcMeasureStats(measureSelection.start, measureSelection.end), [measureSelection]);
  const latestCandleX = useMemo(() => {
    const chart = chartRef.current;
    if (!chart || !latest) return null;
    coordinateVersion;
    const x = chart.timeToCoordinate(latest.time);
    return x === null ? null : Number(x);
  }, [coordinateVersion, latest]);
  const positionRangeOverlays = useMemo(() => {
    const chart = chartRef.current;
    if (!chart || !layerVisibility.priceLines) return [];
    coordinateVersion;
    return positionRanges
      .map((range): PositionRangeOverlay | null => {
        const yEntry = chart.priceToCoordinate(range.entryPrice);
        const yCurrent = chart.priceToCoordinate(range.currentPrice);
        if (yEntry === null || yCurrent === null) return null;
        const pnl = Number(range.pnl);
        const isPositive = Number.isFinite(pnl) ? pnl >= 0 : range.currentPrice >= range.entryPrice;
        const pnlText = Number.isFinite(pnl) ? `${pnl >= 0 ? "+" : ""}${formatChartNumber(pnl)}U` : "--";
        const ratio = Number(range.pnlRatio);
        const ratioText = Number.isFinite(ratio) ? ` ${ratio >= 0 ? "+" : ""}${(ratio * 100).toFixed(2)}%` : "";
        return {
          id: range.id,
          yEntry: Number(yEntry),
          yCurrent: Number(yCurrent),
          yHandle: Number(yEntry),
          label: `${range.label} ${pnlText}${ratioText}`,
          tone: isPositive ? "positive" : "negative",
          range
        };
      })
      .filter((item): item is PositionRangeOverlay => Boolean(item));
  }, [coordinateVersion, layerVisibility.priceLines, positionRanges]);
  const cancellableOrderLineOverlays = useMemo(() => {
    const chart = chartRef.current;
    const container = containerRef.current;
    if (!chart || !container || !orderLineCancellationEnabled || !layerVisibility.priceLines) return [];
    coordinateVersion;
    const height = container.clientHeight;
    return orderLines
      .filter((line) => Number.isFinite(line.price) && line.price > 0 && hasOrderCancellationIdentity(line))
      .map((line) => {
        const y = chart.priceToCoordinate(line.price);
        if (y === null) return null;
        return { line, y: Math.max(24, Math.min(height - 14, Number(y))) };
      })
      .filter((item): item is { line: ChartOrderLine; y: number } => Boolean(item));
  }, [coordinateVersion, layerVisibility.priceLines, orderLineCancellationEnabled, orderLines]);
  const drawingOverlays = useMemo(() => {
    const chart = chartRef.current;
    if (!chart) return [];
    coordinateVersion;
    const overlays: DrawingOverlay[] = [];
    for (const line of drawingLines) {
      if (line.hidden) continue;
      const x1 = drawingTimeToCoordinate(chart, candles, line.start.time);
      const x2 = drawingTimeToCoordinate(chart, candles, line.end.time);
      const y1 = chart.priceToCoordinate(line.start.price);
      const y2 = chart.priceToCoordinate(line.end.price);
      const yStop = line.stop ? chart.priceToCoordinate(line.stop.price) : null;
      const rectPoints = line.tool === "rect" ? rectDrawingOverlayPoints(chart, candles, line) : undefined;
      if (x1 === null || x2 === null || y1 === null || y2 === null || (isRiskRewardTool(line.tool) && yStop === null) || (line.tool === "rect" && !rectPoints)) continue;
      overlays.push({
        id: line.id,
        tool: line.tool,
        x1: Number(x1),
        x2: Number(x2),
        y1: Number(y1),
        y2: Number(y2),
        yStop: yStop === null ? undefined : Number(yStop),
        rectPoints: rectPoints ?? undefined,
        entryPrice: line.start.price,
        targetPrice: line.end.price,
        stopPrice: line.stop?.price,
        label: drawingToolLabel(line.tool),
        selected: line.id === selectedDrawingId,
        color: line.color,
        lineStyle: line.lineStyle,
        locked: line.locked
      });
    }
    if (pendingDrawPoint && previewDrawPoint) {
      const x1 = drawingTimeToCoordinate(chart, candles, pendingDrawPoint.time);
      const x2 = drawingTimeToCoordinate(chart, candles, previewDrawPoint.time);
      const y1 = chart.priceToCoordinate(pendingDrawPoint.price);
      const y2 = chart.priceToCoordinate(previewDrawPoint.price);
      const previewStop = isRiskRewardTool(drawingTool)
        ? createRiskRewardStop(drawingTool, pendingDrawPoint, previewDrawPoint)
        : null;
      const yStop = previewStop ? chart.priceToCoordinate(previewStop.price) : null;
      const previewRect = drawingTool === "rect" ? createRectDrawing(pendingDrawPoint, previewDrawPoint, "drawing-preview") : null;
      const rectPoints = previewRect ? rectDrawingOverlayPoints(chart, candles, previewRect) : undefined;
      if (x1 !== null && x2 !== null && y1 !== null && y2 !== null && (!isRiskRewardTool(drawingTool) || yStop !== null) && (drawingTool !== "rect" || rectPoints)) {
        overlays.push({
          id: "drawing-preview",
          tool: drawingTool,
          x1: Number(x1),
          x2: Number(x2),
          y1: Number(y1),
          y2: Number(y2),
          yStop: yStop === null ? undefined : Number(yStop),
          rectPoints: rectPoints ?? undefined,
          entryPrice: pendingDrawPoint.price,
          targetPrice: previewDrawPoint.price,
          stopPrice: previewStop?.price,
          label: `${drawingToolLabel(drawingTool)} ${chartText("preview", "预览")}`,
          selected: false,
          preview: true
        });
      }
    }
    return overlays;
  }, [coordinateVersion, drawingLines, drawingTool, pendingDrawPoint, previewDrawPoint, selectedDrawingId]);
  const measureOverlay = useMemo(() => {
    const chart = chartRef.current;
    if (!chart || !measureSelection.start || !measureSelection.end) return null;
    coordinateVersion;
    const x1 = drawingTimeToCoordinate(chart, candles, measureSelection.start.time);
    const x2 = drawingTimeToCoordinate(chart, candles, measureSelection.end.time);
    const y1 = chart.priceToCoordinate(measureSelection.start.price);
    const y2 = chart.priceToCoordinate(measureSelection.end.price);
    if (x1 === null || x2 === null || y1 === null || y2 === null) return null;
    return { x1, x2, y1, y2 };
  }, [coordinateVersion, measureSelection]);
  const scriptOverlays = useMemo(() => {
    const chart = chartRef.current;
    if (!chart) return { lines: [], hlines: [], bands: [], markers: [] };
    coordinateVersion;
    return buildScriptOverlays(chart, candles, scriptOutput);
  }, [candles, coordinateVersion, scriptOutput]);

  const indicatorConfigSignature = useMemo(() => JSON.stringify(indicatorInstances), [indicatorInstances]);

  useEffect(() => {
    if (!shouldPersistWorkspace) {
      setWorkspaceReady(true);
      return;
    }
    const epoch = workspaceLoadEpochRef.current + 1;
    workspaceLoadEpochRef.current = epoch;
    setWorkspaceReady(false);
    void loadChartWorkspace(workspaceId)
      .then((workspace) => {
        if (workspaceLoadEpochRef.current !== epoch || !workspace) return;
        const persisted = parseWorkspaceIndicators(workspace.indicators);
        if (persisted.length > 0) setIndicatorInstances(persisted);
        const layers = parseWorkspaceLayers(workspace.layers);
        if (layers) setLayerVisibility({ ...layers, alerts: true });
      })
      .catch(() => undefined)
      .finally(() => {
        if (workspaceLoadEpochRef.current === epoch) setWorkspaceReady(true);
      });
  }, [shouldPersistWorkspace, workspaceId]);

  useEffect(() => {
    if (!shouldPersistWorkspace) return;
    const key = `${workspaceId}:${symbol}`;
    if (loadedAlertKeyRef.current === key) return;
    loadedAlertKeyRef.current = key;
    let cancelled = false;
    void listChartAlerts(workspaceId).then((alerts) => {
      if (cancelled || !alerts) return;
      const restored: PriceAlert[] = alerts.flatMap((alert) => {
        if (alert.status !== "active" || Array.isArray(alert.definition)) return [];
        const definition = alert.definition as Record<string, unknown>;
        const price = Number(definition.price);
        const direction = normalizeAlertDirection(definition.direction);
        if (definition.kind !== "price" || definition.instId !== symbol || !Number.isFinite(price) || price <= 0 || !direction) return [];
        return [{ id: alert.id, price, direction, createdAt: alert.createdAt, triggered: false, source: "manual" as const, name: typeof definition.name === "string" ? definition.name : undefined }];
      });
      const restoredIndicators: IndicatorAlert[] = alerts.flatMap((alert) => {
        if (alert.status !== "active" || Array.isArray(alert.definition)) return [];
        const definition = alert.definition as Record<string, unknown>;
        if (definition.kind !== "indicator" || definition.instId !== symbol) return [];
        const condition = typeof definition.conditionLabel === "string" ? definition.conditionLabel.trim() : chartText("Indicator condition", "指标条件");
        const name = typeof definition.name === "string" && definition.name.trim() ? definition.name.trim() : condition;
        return [{
          id: alert.id,
          name,
          condition,
          createdAt: alert.createdAt,
          triggered: false,
          frequency: definition.frequency === "repeat" ? "repeat" as const : "once" as const
        }];
      });
      setPriceAlerts((items) => [...restored, ...items.filter((item) => item.source !== "manual")].slice(0, 32));
      setIndicatorAlerts(restoredIndicators.slice(0, 32));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [shouldPersistWorkspace, symbol, workspaceId]);

  useEffect(() => {
    if (!shouldPersistWorkspace || !workspaceReady) return;
    const handle = window.setTimeout(() => {
      void saveChartWorkspace({
        id: workspaceId,
        name: workspaceId === "main-chart" ? chartText("Main trading chart", "主交易图") : chartText("Chart workspace", "图表工作区"),
        layout: { version: 1, panes: buildWorkspacePaneLayout(indicatorInstances) },
        indicators: { version: 1, instances: indicatorInstances },
        layers: layerVisibility
      }).catch(() => undefined);
    }, 650);
    return () => window.clearTimeout(handle);
  }, [indicatorInstances, layerVisibility, shouldPersistWorkspace, workspaceId, workspaceReady]);

  useEffect(() => {
    measureModeRef.current = measureMode;
  }, [measureMode]);

  useEffect(() => {
    drawModeRef.current = drawMode;
  }, [drawMode]);

  useEffect(() => {
    drawingToolRef.current = drawingTool;
  }, [drawingTool]);

  useEffect(() => {
    priceAlertsRef.current = priceAlerts;
  }, [priceAlerts]);

  useEffect(() => {
    if (selectableIndicatorAlertOptions.length === 0) {
      setIndicatorAlertInstanceId("");
      return;
    }
    if (!selectableIndicatorAlertOptions.some((item) => item.id === indicatorAlertInstanceId)) {
      setIndicatorAlertInstanceId(selectableIndicatorAlertOptions[0].id);
    }
  }, [indicatorAlertInstanceId, selectableIndicatorAlertOptions]);

  useEffect(() => {
    const outputs = selectedIndicatorAlertOption?.outputs ?? [];
    if (outputs.length === 0) {
      setIndicatorAlertOutputKey("");
      return;
    }
    if (!outputs.some((item) => item.key === indicatorAlertOutputKey)) {
      setIndicatorAlertOutputKey(outputs[0].key);
    }
  }, [indicatorAlertOutputKey, selectedIndicatorAlertOption]);

  useEffect(() => {
    if (!shouldPersistWorkspace) return;
    let dispose: (() => void) | undefined;
    void listenOptional<{ alertId: string; instId: string; frequency?: "once" | "repeat" }>("chart:alert-triggered", (event) => {
      if (event.instId !== symbol) return;
      if (event.frequency === "repeat") return;
      setPriceAlerts((items) => items.map((alert) => alert.id === event.alertId ? { ...alert, triggered: true } : alert));
      setIndicatorAlerts((items) => items.map((alert) => alert.id === event.alertId ? { ...alert, triggered: true } : alert));
    }).then((nextDispose) => { dispose = nextDispose ?? undefined; });
    return () => dispose?.();
  }, [shouldPersistWorkspace, symbol]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      const next = chartScripts.map((script) => {
        if (savedScriptSourcesRef.current[script.id] === script.source) return script;
        savedScriptSourcesRef.current[script.id] = script.source;
        return withSavedChartScriptVersion(script);
      });
      saveChartScripts(next);
      if (next.some((script, index) => script !== chartScripts[index])) setChartScripts(next);
    }, 650);
    return () => window.clearTimeout(handle);
  }, [chartScripts]);

  useEffect(() => {
    if (chartScripts.length === 0) return;
    let cancelled = false;
    const runnable = chartScripts.filter((script) => script.enabled && !script.hidden);
    if (runnable.length === 0) {
      return;
    }
    setScriptRunStates((states) => {
      const next = { ...states };
      for (const script of runnable) next[script.id] = { ...(next[script.id] ?? { output: emptyChartScriptOutput(), outputCount: 0 }), status: "running" };
      return next;
    });
    const handle = window.setTimeout(() => {
      for (const script of runnable) {
        void runChartScript(script, { symbol, candles, ticker, orderBook, recentTrades, fundingRate, orderBookPressure }).then((state) => {
          if (cancelled) return;
          setScriptRunStates((states) => ({ ...states, [script.id]: state }));
        });
      }
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [candles, chartScripts, fundingRate, orderBook, orderBookPressure, recentTrades, symbol, ticker]);

  useEffect(() => {
    setDrawingHistory([]);
    setSelectedDrawingId(null);
    setPendingDrawPoint(null);
    setPreviewDrawPoint(null);
    setHoverStats(null);
    setFillTooltip(null);
    setFillTooltipPinned(false);
    setMeasureSelection({ start: null, end: null });
    setAutoFit(!reviewVariant);
    previousLivePriceRef.current = null;
    setPriceAlerts([]);
    setScriptRunStates((states) => {
      const next: Record<string, ChartScriptRunState> = {};
      for (const [id, state] of Object.entries(states)) {
        next[id] = { ...state, status: "idle", output: emptyChartScriptOutput(), outputCount: 0, error: undefined, runtimeMs: undefined };
      }
      return next;
    });
    const chart = chartRef.current;
    if (chart) {
      for (const key of scriptLineKeysRef.current) {
        if (!chart.removeIndicator(key)) chart.removeLine(key);
      }
      for (const paneId of scriptPaneIdsRef.current) chart.removePane(paneId);
      for (const line of priceAlertLinesRef.current.values()) chart.removePriceLine(line);
      for (const line of orderPriceLinesRef.current.values()) chart.removePriceLine(line);
    }
    scriptLineKeysRef.current.clear();
    scriptPaneIdsRef.current.clear();
    priceAlertLinesRef.current.clear();
    orderPriceLinesRef.current.clear();
    orderPriceLineSignaturesRef.current.clear();
    lastHistoryRequestFirstTimeRef.current = null;
    // Review charts are read-only evidence views; never inherit or persist
    // drawings created on the live trading chart.
    setDrawingLines(reviewVariant ? [] : loadDrawingLines(symbol));
  }, [reviewVariant, symbol, timeframe]);

  useEffect(() => {
    if (reviewVariant) return;
    saveDrawingLines(symbol, drawingLines);
  }, [drawingLines, reviewVariant, symbol]);

  useEffect(() => {
    onNeedMoreHistoryRef.current = onNeedMoreHistory;
  }, [onNeedMoreHistory]);

  const replayCursorTime = synchronizedCrosshairPosition?.time ?? synchronizedCrosshairTime ?? null;
  replayCursorTimeRef.current = typeof replayCursorTime === "number" ? replayCursorTime : null;

  useEffect(() => {
    onOrderLineEditRef.current = onOrderLineEdit;
  }, [onOrderLineEdit]);

  useEffect(() => {
    onOrderLineCancelRef.current = onOrderLineCancel;
  }, [onOrderLineCancel]);

  useEffect(() => {
    onPositionLineTradeIntentRef.current = onPositionLineTradeIntent;
  }, [onPositionLineTradeIntent]);

  useEffect(() => {
    onPositionLineCloseRequestRef.current = onPositionLineCloseRequest;
  }, [onPositionLineCloseRequest]);

  useEffect(() => {
    onChartContextTradeRef.current = onChartContextTrade;
  }, [onChartContextTrade]);

  useEffect(() => {
    if (!chartContextMenu && !indicatorContextMenu) return;
    const closeOutsideMenu = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".chart-context-menu")) return;
      setChartContextMenu(null);
      setIndicatorContextMenu(null);
    };
    window.addEventListener("pointerdown", closeOutsideMenu, true);
    return () => window.removeEventListener("pointerdown", closeOutsideMenu, true);
  }, [chartContextMenu, indicatorContextMenu]);

  useEffect(() => {
    if (!indicatorIds) return;
    const signature = [...indicatorIds].join("|");
    if (externalIndicatorSignatureRef.current === signature) return;
    externalIndicatorSignatureRef.current = signature;
    setIndicatorInstances(indicatorIds.flatMap((definitionId, index) => {
      const definition = INDICATOR_DEFINITIONS[definitionId as keyof typeof INDICATOR_DEFINITIONS];
      if (!definition) return [];
      return [{
        id: `workspace-${workspaceId}-${definitionId}-${index}`,
        definitionId: definition.id,
        paneId: definition.pane === "main" ? "main" : `pane-workspace-${index}`,
        visible: true,
        parameters: Object.fromEntries(definition.parameters.map((parameter) => [parameter.key, parameter.defaultValue])),
      } satisfies IndicatorInstance];
    }));
  }, [indicatorIds, workspaceId]);

  const handleIndicatorInstancesChange = useCallback((next: IndicatorInstance[]) => {
    setIndicatorInstances(next);
    onIndicatorIdsChange?.(next.map((item) => item.definitionId));
  }, [onIndicatorIdsChange]);

  useEffect(() => {
    onRiskRewardTradeIntentRef.current = onRiskRewardTradeIntent;
  }, [onRiskRewardTradeIntent]);

  const commitDrawingLines = (updater: (items: DrawingLine[]) => DrawingLine[]) => {
    setDrawingLines((items) => {
      const next = updater(items);
      if (next === items) return items;
      setDrawingHistory((history) => [...history, items].slice(-30));
      setDrawingRedoHistory([]);
      return next;
    });
  };

  const undoDrawingChange = () => {
    setDrawingHistory((history) => {
      if (history.length === 0) return history;
      const previous = history[history.length - 1];
      setDrawingRedoHistory((redo) => [...redo, drawingLines].slice(-30));
      setDrawingLines(previous);
      setSelectedDrawingId(null);
      setPendingDrawPoint(null);
      return history.slice(0, -1);
    });
  };

  const redoDrawingChange = () => {
    setDrawingRedoHistory((history) => {
      if (history.length === 0) return history;
      const next = history[history.length - 1];
      setDrawingHistory((undo) => [...undo, drawingLines].slice(-30));
      setDrawingLines(next);
      setSelectedDrawingId(null);
      setPendingDrawPoint(null);
      return history.slice(0, -1);
    });
  };

  useEffect(() => {
    onLayerVisibilityChange?.(layerVisibility);
  }, [layerVisibility, onLayerVisibilityChange]);

  useEffect(() => {
    onDrawingHistoryChange?.({ canUndo: drawingHistory.length > 0, canRedo: drawingRedoHistory.length > 0 });
  }, [drawingHistory.length, drawingRedoHistory.length, onDrawingHistoryChange]);

  useEffect(() => {
    if (!externalLayerCommand) return;
    setLayerVisibility((items) => ({ ...items, [externalLayerCommand.key]: !items[externalLayerCommand.key] }));
  }, [externalLayerCommand]);

  useEffect(() => {
    if (!externalToolbarAction) return;
    if (externalToolbarAction.action === "alerts") {
      setLayerVisibility((items) => items.alerts ? items : { ...items, alerts: true });
      setAlertPanelOpen((value) => !value);
    }
    if (externalToolbarAction.action === "undo") undoDrawingChange();
    if (externalToolbarAction.action === "redo") redoDrawingChange();
  }, [externalToolbarAction]);

  const updateSelectedDrawing = (updater: (line: DrawingLine) => DrawingLine) => {
    if (!selectedDrawingId) return;
    const targetId = selectedDrawingId;
    commitDrawingLines((items) => items.map((item) => (item.id === targetId ? updater(item) : item)));
  };

  const duplicateSelectedDrawing = () => {
    if (!selectedDrawingId) return;
    const source = drawingLines.find((line) => line.id === selectedDrawingId);
    if (!source) return;
    const offset = currentBarSeconds(candles);
    const copy: DrawingLine = {
      ...source,
      id: `drawing-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      locked: false,
      hidden: false,
      start: { ...source.start, time: source.start.time + offset, price: source.start.price * 1.001 },
      end: { ...source.end, time: source.end.time + offset, price: source.end.price * 1.001 }
    };
    commitDrawingLines((items) => [...items, copy].slice(-24));
    setSelectedDrawingId(copy.id);
  };

  useEffect(() => {
    if (!containerRef.current) return;
    const activeContainer = containerRef.current;
    const chart = createTradingChart(containerRef.current, []);

    const unsubscribeCrosshair = chart.onCrosshairMove((position) => {
      onChartCrosshairTimeRef.current?.(position?.time ?? null);
      onChartCrosshairPositionRef.current?.(position);
      if (!position) {
        setHoverStats(null);
        return;
      }
      const candle = candleMapRef.current.get(position.time);
      if (!candle) return;
      setHoverStats({
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        indicatorValues: [
          ...(managedIndicatorHoverValuesRef.current.get(candle.time) ?? []),
          ...(scriptIndicatorHoverValuesRef.current.get(candle.time) ?? [])
        ]
      });
    });

    const unsubscribeRange = chart.onVisibleRangeChange((range) => {
      let effectiveRange = range;
      if (reviewVariantRef.current && range) {
        const target = replayViewportTargetRef.current;
        const now = performance.now();
        const currentCandles = candlesRef.current;
        const invalid = range.from < -0.5 || range.to > currentCandles.length - 0.5;
        if (target && now < target.expiresAt && target.firstTime === currentCandles[0]?.time && invalid) {
          effectiveRange = target.range;
          if (target.spacing !== null) chart.setBarSpacing(target.spacing);
          chart.setVisibleLogicalRange(target.range);
        } else if (target && (now >= target.expiresAt || target.firstTime !== currentCandles[0]?.time)) {
          replayViewportTargetRef.current = null;
        }
      }
      setCoordinateVersion((version) => version + 1);
      setVisibleLogicalRange(effectiveRange);
      requestMoreHistoryIfNeeded(effectiveRange);
      onChartVisibleRangeRef.current?.(effectiveRange);
    });
    const resizeObserver = new ResizeObserver(() => setCoordinateVersion((version) => version + 1));
    resizeObserver.observe(activeContainer);

    chartRef.current = chart;

    return () => {
      unsubscribeCrosshair();
      unsubscribeRange();
      resizeObserver.disconnect();
      chart.destroy();
      chartRef.current = null;
      replayViewportEpochRef.current += 1;
      replayViewportTargetRef.current = null;
      if (replayViewportFrameRef.current !== null) {
        window.cancelAnimationFrame(replayViewportFrameRef.current);
        replayViewportFrameRef.current = null;
      }
      setVisibleLogicalRange(null);
      priceAlertLinesRef.current.clear();
      orderPriceLinesRef.current.clear();
      orderPriceLineSignaturesRef.current.clear();
    };
  }, [requestMoreHistoryIfNeeded]);

  useEffect(() => {
    // `undefined` means this chart owns its crosshair. Keep ordinary trading
    // charts independent while allowing replay to explicitly pass a time/null.
    if (synchronizedCrosshairPosition === undefined && synchronizedCrosshairTime === undefined) return;
    const frame = window.requestAnimationFrame(() => {
      const chart = chartRef.current;
      if (!chart) return;
      if (synchronizedCrosshairPosition) chart.setCrosshairPosition(synchronizedCrosshairPosition);
      else chart.setCrosshairTime(synchronizedCrosshairTime ?? null);

      const cursorTime = synchronizedCrosshairPosition?.time ?? synchronizedCrosshairTime;
      if (!followSynchronizedCrosshair || cursorTime === null || cursorTime === undefined) return;
      let cursorIndex = candleIndexRef.current.get(cursorTime);
      // During a replay page swap the index map and the chart series can be one
      // render apart. Resolve the cursor directly from the current page so a
      // stale map cannot leave the viewport pinned to `-span..1`. The current
      // page is authoritative for review charts, so do not trust a matching
      // index from the previous page either.
      if (reviewVariant) cursorIndex = candleIndexForPage(candles, cursorTime);
      const range = chart.getVisibleLogicalRange();
      const pageRangeInvalid = reviewVariant && range !== null
        && (range.from < -0.5 || range.to > candles.length - 0.5);
      if (cursorIndex === undefined || !range || (!pageRangeInvalid && cursorIndex >= range.from && cursorIndex <= range.to)) return;

      const span = Math.max(16, range.to - range.from);
      const lastIndex = Math.max(0, reviewVariant ? candles.length - 1 : candleIndexRef.current.size - 1);
      let from = cursorIndex - span * 0.55;
      let to = cursorIndex + span * 0.45;
      if (from < -0.5) {
        to += -0.5 - from;
        from = -0.5;
      }
      if (to > lastIndex + 0.5) {
        from -= to - (lastIndex + 0.5);
        to = lastIndex + 0.5;
      }
      chart.setVisibleLogicalRange({ from: Math.max(-0.5, from), to });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [candles, followSynchronizedCrosshair, synchronizedCrosshairPosition, synchronizedCrosshairTime]);

  useEffect(() => {
    if (synchronizedVisibleRange) chartRef.current?.setVisibleLogicalRange(synchronizedVisibleRange);
  }, [synchronizedVisibleRange]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPendingDrawPoint(null);
        setPreviewDrawPoint(null);
        setDrawMode(false);
        setMeasureMode(false);
        setLineToolMenuOpen(false);
        setDrawingDrag(null);
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedDrawingId) {
        event.preventDefault();
        const targetId = selectedDrawingId;
        const target = drawingLines.find((item) => item.id === targetId);
        if (target?.locked) return;
        commitDrawingLines((items) => items.filter((item) => item.id !== targetId));
        setSelectedDrawingId(null);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undoDrawingChange();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawingLines, selectedDrawingId]);

  useEffect(() => {
    if (!lineToolMenuOpen) return;
    const closeMenu = () => setLineToolMenuOpen(false);
    window.addEventListener("pointerdown", closeMenu);
    return () => window.removeEventListener("pointerdown", closeMenu);
  }, [lineToolMenuOpen]);

  useEffect(() => {
    if (!layerMenuOpen) return;
    const closeMenu = (event: PointerEvent) => {
      if (!layerMenuRef.current?.contains(event.target as Node)) setLayerMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLayerMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [layerMenuOpen]);

  useEffect(() => {
    if (!alertPanelOpen) return;
    const focusFrame = window.requestAnimationFrame(() => priceAlertInputRef.current?.focus());
    const closePanel = (event: PointerEvent) => {
      const target = event.target as Node;
      const targetElement = event.target instanceof Element ? event.target : null;
      if (alertPanelRef.current?.contains(target)
        || alertTriggerRef.current?.contains(target)
        || targetElement?.closest("[data-chart-alert-trigger]")) return;
      setAlertPanelOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAlertPanelOpen(false);
    };
    window.addEventListener("pointerdown", closePanel);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("pointerdown", closePanel);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [alertPanelOpen]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const key = { symbol, timeframe };
    const seriesKey = `${symbol}\u0000${timeframe}`;
    const controller = dataControllerRef.current;
    if (renderedSeriesKeyRef.current && renderedSeriesKeyRef.current !== seriesKey) {
      controller.clear(key);
      renderedSeriesKeyRef.current = seriesKey;
      candleMapRef.current = new Map();
      candleIndexRef.current = new Map();
      chart.replaceSnapshot([], []);
      for (const indicatorKey of indicatorSeriesKeysRef.current) chart.removeIndicator(indicatorKey);
      indicatorSeriesKeysRef.current.clear();
      indicatorCalculatorsRef.current.clear();
      indicatorConfigSignatureRef.current = "";
      for (const scriptKey of scriptLineKeysRef.current) {
        if (!chart.removeIndicator(scriptKey)) chart.removeLine(scriptKey);
      }
      scriptLineKeysRef.current.clear();
      for (const paneId of scriptPaneIdsRef.current) chart.removePane(paneId);
      scriptPaneIdsRef.current.clear();
      renderedFirstTimeRef.current = null;
      setCoordinateVersion((version) => version + 1);
      return;
    }
    const reviewSnapshotChanged = reviewVariant
      && snapshotRevision !== null
      && snapshotRevision !== undefined
      && reviewSnapshotRevisionRef.current !== snapshotRevision;
    // Replay always hands over a complete, self-contained page, so it must
    // always replace. Incremental ingestion is wrong here: jumping backwards
    // produces a page whose bars are all older than the current ones, which
    // `ingestRealtime` classifies as a history "prepend" and *merges*, leaving
    // two disjoint time ranges in one series. The chart then renders the seam
    // between them — a wall of empty space with the cursor pointing at a bar
    // from the page that was replaced.
    const patch: ChartDataPatch = reviewVariant
      || (renderedSeriesKeyRef.current !== seriesKey && controller.getCandles(key).length === 0)
      ? controller.replaceSnapshot(key, candles)
      : controller.ingestRealtime(key, candles);
    if (reviewSnapshotChanged) reviewSnapshotRevisionRef.current = snapshotRevision ?? null;
    renderedSeriesKeyRef.current = seriesKey;
    const canonicalCandles = controller.getCandles(key);
    const visibleRangeBeforeUpdate = chart.getVisibleLogicalRange();
    const replayPageChanged = reviewVariant && canonicalCandles[0]?.time !== renderedFirstTimeRef.current;
    let replayTargetRange: ChartVisibleLogicalRange | null = null;
    const prependedCount = patch.type === "prepend" ? patch.candles.length : 0;
    candleMapRef.current = new Map(canonicalCandles.map((candle) => [candle.time, candle]));
    candleIndexRef.current = new Map(canonicalCandles.map((candle, index) => [candle.time, index]));
    if (canonicalCandles.length === 0) {
      chart.replaceSnapshot([], []);
      for (const key of indicatorSeriesKeysRef.current) chart.removeIndicator(key);
      indicatorSeriesKeysRef.current.clear();
      indicatorCalculatorsRef.current.clear();
      indicatorConfigSignatureRef.current = "";
      for (const key of scriptLineKeysRef.current) {
        if (!chart.removeIndicator(key)) chart.removeLine(key);
      }
      scriptLineKeysRef.current.clear();
      for (const paneId of scriptPaneIdsRef.current) chart.removePane(paneId);
      scriptPaneIdsRef.current.clear();
      renderedFirstTimeRef.current = null;
      setCoordinateVersion((version) => version + 1);
      return;
    }
    if (replayPageChanged) {
      // Every series contributes timestamps to the same logical time scale.
      // Clear all old page data before installing the new candle snapshot:
      // otherwise managed indicators (MA/KDJ) and async custom scripts briefly
      // coexist with the new candles and the library preserves that disjoint
      // time domain as an out-of-bounds logical range such as `-180..1`.
      chart.clearTemporalData();
      for (const scriptKey of scriptLineKeysRef.current) {
        if (!chart.removeIndicator(scriptKey)) chart.removeLine(scriptKey);
      }
      scriptLineKeysRef.current.clear();
      for (const paneId of scriptPaneIdsRef.current) chart.removePane(paneId);
      scriptPaneIdsRef.current.clear();
      scriptIndicatorHoverValuesRef.current = new Map();
    }
    if (patch.type === "reset" || patch.type === "prepend") {
      chart.replaceSnapshot(
        canonicalCandles.map((candle) => ({
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close
        })),
        canonicalCandles.map((candle) => ({
        time: candle.time,
        value: candle.volume,
        color: candle.close >= candle.open ? "rgba(246,70,93,0.58)" : "rgba(14,203,129,0.58)"
        }))
      );
    } else if (patch.type === "append") {
      for (const candle of patch.candles) {
        chart.appendLatest(
          { time: candle.time, open: candle.open, high: candle.high, low: candle.low, close: candle.close },
          { time: candle.time, value: candle.volume, color: candle.close >= candle.open ? "rgba(246,70,93,0.58)" : "rgba(14,203,129,0.58)" }
        );
      }
    } else if (patch.type === "updateLatest") {
      const candle = patch.candle;
      chart.updateLatest(
        { time: candle.time, open: candle.open, high: candle.high, low: candle.low, close: candle.close },
        { time: candle.time, value: candle.volume, color: candle.close >= candle.open ? "rgba(246,70,93,0.58)" : "rgba(14,203,129,0.58)" }
      );
    }
    syncManagedIndicators({
      chart,
      candles: canonicalCandles,
      patch,
      instances: indicatorInstances,
      configSignature: indicatorConfigSignature,
      calculators: indicatorCalculatorsRef.current,
      seriesKeys: indicatorSeriesKeysRef.current,
      previousConfigSignature: indicatorConfigSignatureRef,
      layersVisible: layerVisibility.indicators,
      hoverValues: managedIndicatorHoverValuesRef,
      onUnavailableChange: setUnavailableIndicatorIds
    });
    if (!reviewVariant && autoFit && patch.type !== "updateLatest") {
      chart.resetView();
      if (canonicalCandles.length >= AUTO_FIT_READY_CANDLE_COUNT) setAutoFit(false);
    } else if (replayPageChanged) {
      // A replay page swap replaces every bar, so the previous page's logical
      // range is meaningless: index 1400 of the old page is unrelated to index
      // 1400 of the new one, and any part of it past the new end renders as the
      // bars bunching against the right edge with blank space beside them.
      // Frame the window around the replay cursor instead, keeping the same
      // zoom the user had rather than snapping back to fitContent.
      // The parent updates the synchronized cursor in the same render that
      // replaces the replay page. Prefer the current prop over the ref so this
      // effect cannot frame a fresh page using the previous page's cursor.
      const cursorTime = synchronizedCrosshairPosition?.time
        ?? synchronizedCrosshairTime
        ?? replayCursorTimeRef.current;
      const lastIndex = Math.max(0, canonicalCandles.length - 1);
      // Prefer the exact bar. If the cursor time falls between bars, use the
      // nearest one rather than silently defaulting to the end of the page,
      // which would frame a window nowhere near where the user dragged.
      const cursorIndex = candleIndexForPage(canonicalCandles, cursorTime);
      // A full page replacement invalidates logical coordinates outside the
      // page. lightweight-charts can report a range such as `-1470..1` while
      // it is reconciling the old page; preserving that span makes the new
      // page render only its first two bars at the edge. Keep the user's zoom
      // only when the old range was fully inside the replacement page.
      const previousRangeIsUsable = visibleRangeBeforeUpdate
        && visibleRangeBeforeUpdate.from >= -0.5
        && visibleRangeBeforeUpdate.to <= lastIndex + 0.5;
      const previousSpan = previousRangeIsUsable
        ? visibleRangeBeforeUpdate.to - visibleRangeBeforeUpdate.from
        : 0;
      const span = Math.min(
        lastIndex + 1,
        Math.max(REPLAY_MIN_VISIBLE_BARS, previousSpan > 0 ? previousSpan : REPLAY_DEFAULT_VISIBLE_BARS)
      );
      // Pin the zoom before asking for a range. Bar spacing survives a data
      // replacement, and `maxBarSpacing: 0` lets the library keep up to half the
      // chart width per bar, so a stale large spacing renders a few enormous
      // candles jammed against the right edge no matter what range is requested.
      const chartWidth = containerRef.current?.clientWidth ?? 0;
      // Put the cursor slightly right of centre so recent history stays visible,
      // then clamp so the window never runs past either end of the page.
      // If the cursor is not available during the brief page hand-off, center
      // the bounded page instead of pinning the range to index 0. The later
      // synchronized-crosshair effect will move it to the exact cursor.
      const anchor = cursorIndex ?? Math.floor(lastIndex / 2);
      let from = anchor - span * 0.7;
      let to = from + span;
      if (from < -0.5) {
        from = -0.5;
        to = from + span;
      }
      if (to > lastIndex + 0.5) {
        to = lastIndex + 0.5;
        from = Math.max(-0.5, to - span);
      }
      const targetRange = { from, to };
      replayTargetRange = targetRange;
      replayViewportTargetRef.current = {
        firstTime: canonicalCandles[0]?.time ?? 0,
        range: targetRange,
        spacing: chartWidth > 0 ? chartWidth / span : null,
        expiresAt: performance.now() + REPLAY_VIEWPORT_GUARD_MS
      };
      const targetSpacing = chartWidth > 0 ? chartWidth / span : null;
      const viewportEpoch = replayViewportEpochRef.current + 1;
      replayViewportEpochRef.current = viewportEpoch;
      if (replayViewportFrameRef.current !== null) window.cancelAnimationFrame(replayViewportFrameRef.current);
      const applyReplayViewport = (remainingFrames: number) => {
        if (viewportEpoch !== replayViewportEpochRef.current || chartRef.current !== chart) return;
        if (targetSpacing !== null) chart.setBarSpacing(targetSpacing);
        chart.setVisibleLogicalRange(targetRange);
        const activeCursorTime = replayCursorTimeRef.current;
        if (activeCursorTime !== null) chart.setCrosshairTime(activeCursorTime);
        const appliedRange = chart.getVisibleLogicalRange();
        setVisibleLogicalRange(appliedRange);
        setCoordinateVersion((version) => version + 1);
        if (remainingFrames > 0) {
          replayViewportFrameRef.current = window.requestAnimationFrame(() => applyReplayViewport(remainingFrames - 1));
        } else {
          replayViewportFrameRef.current = null;
        }
      };
      // Series replacement triggers asynchronous time-scale reconciliation.
      // Reassert across the next two paints so that reconciliation cannot put
      // the old page's `-span..1` range back after this effect returns.
      applyReplayViewport(2);
    } else if (visibleRangeBeforeUpdate && prependedCount > 0) {
      chart.setVisibleLogicalRange({
        from: visibleRangeBeforeUpdate.from + prependedCount,
        to: visibleRangeBeforeUpdate.to + prependedCount
      });
    }
    renderedFirstTimeRef.current = canonicalCandles[0]?.time ?? null;
    const currentVisibleRange = replayTargetRange ?? chart.getVisibleLogicalRange();
    setVisibleLogicalRange(currentVisibleRange);
    requestMoreHistoryIfNeeded(currentVisibleRange);
    setCoordinateVersion((version) => version + 1);
  }, [autoFit, candles, indicatorConfigSignature, indicatorInstances, layerVisibility.indicators, requestMoreHistoryIfNeeded, reviewVariant, snapshotRevision]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const nextKeys = new Set<string>();
    const nextPaneIds = new Set<string>();
    const nextHoverValues = new Map<number, HoverIndicatorValue[]>();
    const replayFirstTime = reviewVariant ? candles[0]?.time : undefined;
    const replayLastTime = reviewVariant ? candles[candles.length - 1]?.time : undefined;
    for (const line of scriptOutput.lines) {
      const key = `custom-script:${line.id}`;
      const paneId = line.pane === "sub"
        ? line.paneId ?? `${CHART_SCRIPT_PANE_PREFIX}${line.id}`
        : MAIN_CHART_PANE_ID;
      const points = replayFirstTime !== undefined && replayLastTime !== undefined
        ? line.points.filter((point) => point.time >= replayFirstTime && point.time <= replayLastTime)
        : line.points;
      if (reviewVariant && points.length === 0) continue;
      nextKeys.add(key);
      if (line.pane === "sub") {
        nextPaneIds.add(paneId);
        chart.ensurePane({ id: paneId, height: 150 });
      }
      const isHistogram = line.kind === "histogram";
      chart.setIndicatorData({
        key,
        paneId,
        type: isHistogram ? "histogram" : "line",
        color: line.color ?? "#67e8f9",
        lineWidth: chartScriptLineWidth(line.width),
        visible: layerVisibility.indicators,
        priceLineVisible: false,
        lastValueVisible: false
      }, points.map((point) => ({
        time: point.time,
        value: point.price,
        ...(isHistogram ? { color: line.color ?? "#67e8f9" } : {})
      })));
      if (layerVisibility.indicators) {
        for (const point of points) {
          const values = nextHoverValues.get(point.time) ?? [];
          values.push({ id: key, label: line.name, value: point.price, color: line.color ?? "#67e8f9" });
          nextHoverValues.set(point.time, values);
        }
      }
    }
    for (const key of scriptLineKeysRef.current) {
      if (!nextKeys.has(key) && !chart.removeIndicator(key)) chart.removeLine(key);
    }
    scriptLineKeysRef.current = nextKeys;
    for (const paneId of scriptPaneIdsRef.current) {
      if (!nextPaneIds.has(paneId)) chart.removePane(paneId);
    }
    scriptPaneIdsRef.current = nextPaneIds;
    scriptIndicatorHoverValuesRef.current = nextHoverValues;
  }, [layerVisibility.indicators, replayScriptPageSignature, reviewVariant, scriptOutput.lines, scriptVisibilitySignature]);

  useEffect(() => {
    chartRef.current?.applyGridVisible(gridVisible);
  }, [gridVisible]);

  useEffect(() => {
    const markers = [
      ...(layerVisibility.signals ? signalMarkers : []),
      ...(layerVisibility.fills ? fillMarkers : [])
    ].sort((a, b) => a.time - b.time);
    chartRef.current?.setMarkers(markers);
  }, [fillMarkers, layerVisibility.fills, layerVisibility.signals, signalMarkers]);

  useEffect(() => {
    setPriceAlerts((items) => {
      const existing = new Map(items.map((item) => [item.id, item]));
      const desired = new Map<string, PriceAlert>();
      for (const script of chartScripts) {
        if (!script.enabled || script.hidden) continue;
        const state = scriptRunStates[script.id];
        if (state?.status !== "ready") continue;
        for (const alert of state.output.alerts) {
          if (!alert.active) continue;
          const id = `script-alert:${script.id}:${alert.id}`;
          const previous = existing.get(id);
          const direction = alert.direction === "below" || alert.direction === "cross" ? alert.direction : "above";
          desired.set(id, {
            id,
            price: alert.price,
            direction,
            createdAt: previous?.createdAt ?? Date.now(),
            triggered: previous && previous.price === alert.price && previous.direction === direction ? previous.triggered : false,
            source: "script",
            scriptId: script.id,
            scriptAlertId: alert.id,
            name: alert.name
          });
        }
      }
      const next = [
        ...items.filter((item) => item.source !== "script"),
        ...desired.values()
      ];
      return samePriceAlerts(items, next) ? items : next;
    });
  }, [chartScripts, scriptRunStates]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const existing = priceAlertLinesRef.current;
    for (const [id, line] of existing) {
      if (!layerVisibility.alerts || !priceAlerts.some((alert) => alert.id === id && !alert.triggered)) {
        chart.removePriceLine(line);
        existing.delete(id);
      }
    }
    if (!layerVisibility.alerts) return;
    for (const alert of priceAlerts) {
      if (alert.triggered || existing.has(alert.id)) continue;
      existing.set(
        alert.id,
        chart.createPriceLine({
          price: alert.price,
          color: alert.source === "script" ? "#8b5cf6" : alert.direction === "above" ? "#f6465d" : "#0ecb81",
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: false,
          title: `${alert.source === "script" ? `${chartText("Script", "脚本")} ` : ""}${chartText("Alert", "提醒")} ${formatAlertDirection(alert.direction)}${alert.name ? ` ${alert.name}` : ""}`
        })
      );
    }
  }, [layerVisibility.alerts, priceAlerts, symbol]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const existing = orderPriceLinesRef.current;
    const signatures = orderPriceLineSignaturesRef.current;
    const nextLines = orderLines.filter((line) => Number.isFinite(line.price) && line.price > 0);
    const nextIds = new Set(nextLines.map((line) => line.id));

    for (const [id, line] of existing) {
      if (!nextIds.has(id)) {
        chart.removePriceLine(line);
        existing.delete(id);
        signatures.delete(id);
      }
    }

    for (const line of nextLines) {
      const usesInteractiveLabel = orderLineCancellationEnabled && hasOrderCancellationIdentity(line);
      const signature = `${line.price}|${line.color}|${line.type}|${line.label}|${usesInteractiveLabel ? "interactive" : "native"}`;
      if (existing.has(line.id) && signatures.get(line.id) === signature) continue;
      const previous = existing.get(line.id);
      if (previous) chart.removePriceLine(previous);
      existing.set(
        line.id,
        chart.createPriceLine({
          price: line.price,
          color: line.color,
          lineWidth: chartOrderLineWidth(line.type),
          lineStyle: chartOrderLineStyle(line.type),
          axisLabelVisible: !usesInteractiveLabel,
          title: usesInteractiveLabel ? "" : line.label
        })
      );
      signatures.set(line.id, signature);
    }
  }, [orderLineCancellationEnabled, orderLines, symbol]);

  useEffect(() => {
    if (!Number.isFinite(livePrice)) return;
    const previous = previousLivePriceRef.current;
    previousLivePriceRef.current = livePrice ?? null;
    if (previous === null || livePrice === undefined) return;
    const triggered = priceAlertsRef.current.filter((alert) => {
      if (shouldPersistWorkspace && alert.source === "manual") return false;
      if (alert.triggered) return false;
      if (alert.direction === "above") return previous < alert.price && livePrice >= alert.price;
      if (alert.direction === "below") return previous > alert.price && livePrice <= alert.price;
      return (previous < alert.price && livePrice >= alert.price) || (previous > alert.price && livePrice <= alert.price);
    });
    if (triggered.length === 0) return;
    const triggeredIds = new Set(triggered.map((alert) => alert.id));
    setPriceAlerts((items) => items.map((alert) => (triggeredIds.has(alert.id) ? { ...alert, triggered: true } : alert)));
    for (const alert of triggered) {
      onPriceAlert?.({ price: alert.price, direction: alert.direction, last: livePrice, source: alert.source ?? "manual", name: alert.name });
    }
  }, [livePrice, onPriceAlert, shouldPersistWorkspace]);

  const addChartAlert = () => {
    setAlertFormError("");
    if (!alertNotifyApp && !alertNotifyFeishu && !alertNotifyWebhook) {
      setAlertFormError(chartText("Select at least one notification method", "至少选择一种提醒方式"));
      return;
    }
    if (alertNotifyWebhook) {
      const webhookError = validateChartAlertWebhook(alertWebhookUrl);
      if (webhookError) {
        setAlertFormError(webhookError);
        return;
      }
    }
    const cooldownSeconds = Math.max(0, Math.min(86_400, Math.round(Number(alertCooldownSeconds) || 0)));
    const expiresAt = chartAlertExpiresAt(alertExpiry);
    const name = alertName.trim().slice(0, 80);
    const commonDefinition = {
      cooldownSeconds,
      expiresAt,
      frequency: alertFrequency,
      notifyApp: alertNotifyApp,
      notifyFeishu: alertNotifyFeishu,
      webhook: alertNotifyWebhook ? { method: alertWebhookMethod, url: alertWebhookUrl.trim() } : null,
      name
    };
    const now = Date.now();
    const id = `chart-alert-${now}-${Math.random().toString(16).slice(2)}`;

    if (alertConditionKind === "price") {
      const price = Number(priceAlertInput);
      if (!Number.isFinite(price) || price <= 0) {
        setAlertFormError(chartText("Enter a valid trigger price", "请输入有效的触发价格"));
        return;
      }
      const alert: PriceAlert = {
        id,
        price,
        direction: priceAlertDirection,
        createdAt: now,
        triggered: false,
        source: "manual",
        name: name || undefined
      };
      const definition = {
        kind: "price",
        instId: symbol,
        price,
        direction: priceAlertDirection,
        conditionLabel: `${chartText("Last price", "最新价")} ${priceAlertDirection === "above" ? chartText("crosses above", "上破") : chartText("crosses below", "下破")} ${formatChartNumber(price)}`,
        ...commonDefinition
      };
      setPriceAlerts((items) => [alert, ...items].slice(0, 32));
      onCreateChartAlert?.({ id, symbol, definition });
      setPriceAlertInput("");
    } else {
      if (!selectedIndicatorAlertOption || !selectedIndicatorAlertOutput) {
        setAlertFormError(chartText("The selected indicators do not expose an alert data series", "指标中心的已选指标中暂无可用于提醒的数据线"));
        return;
      }
      const threshold = Number(indicatorAlertThreshold);
      if (indicatorAlertComparison === "value" && !Number.isFinite(threshold)) {
        setAlertFormError(chartText("Enter a valid indicator threshold", "请输入有效的指标阈值"));
        return;
      }
      const indicatorLabel = selectedIndicatorAlertOption.outputs.length > 1
        ? `${selectedIndicatorAlertOption.label} · ${selectedIndicatorAlertOutput.label}`
        : selectedIndicatorAlertOption.label;
      const compareLabel = indicatorAlertComparison === "price"
        ? `${chartText("Last price", "最新价")} ${alertOperatorLabel(indicatorAlertOperator)} ${indicatorLabel}`
        : `${indicatorLabel}${alertOperatorLabel(indicatorAlertOperator)}${formatChartNumber(threshold)}`;
      const left = indicatorAlertComparison === "price"
        ? { kind: "field", field: "close" }
        : selectedIndicatorAlertOutput.expression;
      const right = indicatorAlertComparison === "price"
        ? selectedIndicatorAlertOutput.expression
        : { kind: "number", value: threshold };
      const definition = {
        kind: "indicator",
        instId: symbol,
        bar: timeframe,
        operator: indicatorAlertOperator,
        left,
        right,
        leftLabel: indicatorAlertComparison === "price" ? chartText("Last price", "最新价") : indicatorLabel,
        rightLabel: indicatorAlertComparison === "price" ? indicatorLabel : formatChartNumber(threshold),
        indicatorSource: selectedIndicatorAlertOption.source,
        indicatorInstanceId: selectedIndicatorAlertOption.id,
        indicatorDefinitionId: selectedIndicatorAlertOption.instance?.definitionId ?? null,
        indicatorParameters: { ...(selectedIndicatorAlertOption.instance?.parameters ?? {}) },
        indicatorScriptId: selectedIndicatorAlertOption.scriptId ?? null,
        indicatorOutputKey: selectedIndicatorAlertOutput.key,
        indicatorLabel,
        conditionLabel: compareLabel,
        triggerOn: "bar_close",
        ...commonDefinition
      };
      setIndicatorAlerts((items) => [{
        id,
        name: name || compareLabel,
        condition: compareLabel,
        createdAt: now,
        triggered: false,
        frequency: alertFrequency
      }, ...items].slice(0, 32));
      onCreateChartAlert?.({ id, symbol, definition });
      setIndicatorAlertThreshold("");
    }
    setLayerVisibility((items) => items.alerts ? items : { ...items, alerts: true });
    setAlertName("");
  };

  const removePriceAlert = (alert: PriceAlert) => {
    setPriceAlerts((items) => items.filter((item) => item.id !== alert.id));
    if (alert.source === "manual") onDeletePriceAlert?.({ id: alert.id, symbol });
  };

  const removeIndicatorAlert = (alert: IndicatorAlert) => {
    setIndicatorAlerts((items) => items.filter((item) => item.id !== alert.id));
    onDeletePriceAlert?.({ id: alert.id, symbol });
  };

  const updateSelectedScript = (patch: Partial<ChartScriptDefinition>) => {
    if (!selectedScript) return;
    setChartScripts((items) =>
      items.map((script) => {
        if (script.id !== selectedScript.id) return script;
        const next = { ...script, ...patch, updatedAt: Date.now() };
        return next;
      })
    );
  };

  const saveSelectedScriptNow = () => {
    if (!selectedScript) return;
    setChartScripts((items) => {
      const next = items.map((script) => {
        if (script.id !== selectedScript.id) return script;
        savedScriptSourcesRef.current[script.id] = script.source;
        return withSavedChartScriptVersion(script);
      });
      saveChartScripts(next);
      return next;
    });
  };

  const runChartScriptNow = useCallback((target: ChartScriptDefinition) => {
    const script = target.enabled ? { ...target, hidden: false } : { ...target, enabled: true, hidden: false };
    setChartScripts((items) => items.map((item) => (item.id === script.id ? { ...item, enabled: true, hidden: false, updatedAt: Date.now() } : item)));
    setScriptRunStates((states) => ({
      ...states,
      [script.id]: { ...(states[script.id] ?? { output: emptyChartScriptOutput(), outputCount: 0 }), status: "running" }
    }));
    void runChartScript(script, { symbol, candles, ticker, orderBook, recentTrades, fundingRate, orderBookPressure }).then((state) => {
      setScriptRunStates((states) => ({ ...states, [script.id]: state }));
    });
  }, [candles, fundingRate, orderBook, orderBookPressure, recentTrades, symbol, ticker]);

  const runSelectedScriptNow = () => {
    if (!selectedScript) return;
    runChartScriptNow(selectedScript);
  };

  const openCustomIndicatorEditor = useCallback((scriptId?: string) => {
    setSelectedScriptId(scriptId ?? chartScripts[0]?.id ?? null);
    setScriptPanelOpen(true);
  }, [chartScripts]);

  const enableCustomIndicator = useCallback((scriptId: string) => {
    const script = chartScripts.find((item) => item.id === scriptId);
    if (script) runChartScriptNow(script);
  }, [chartScripts, runChartScriptNow]);

  const toggleCustomIndicatorVisibility = useCallback((scriptId: string) => {
    setChartScripts((items) => items.map((script) => (
      script.id === scriptId ? { ...script, enabled: true, hidden: !script.hidden, updatedAt: Date.now() } : script
    )));
  }, []);

  const removeCustomIndicatorFromChart = useCallback((scriptId: string) => {
    setChartScripts((items) => items.map((script) => (
      script.id === scriptId ? { ...script, enabled: false, hidden: true, updatedAt: Date.now() } : script
    )));
  }, []);

  const addChartScript = () => {
    const script = createDefaultChartScript();
    script.name = `${chartText("Script", "脚本")} ${chartScripts.length + 1}`;
    setChartScripts((items) => [script, ...items].slice(0, 24));
    setSelectedScriptId(script.id);
    setScriptPanelOpen(true);
  };

  const copySelectedScript = () => {
    if (!selectedScript) return;
    const now = Date.now();
    const copy: ChartScriptDefinition = {
      ...selectedScript,
      id: `script-${now}-${Math.random().toString(16).slice(2)}`,
      name: `${selectedScript.name} ${chartText("copy", "副本")}`,
      createdAt: now,
      updatedAt: now,
      versions: [{ source: selectedScript.source, savedAt: now }]
    };
    setChartScripts((items) => [copy, ...items].slice(0, 24));
    setSelectedScriptId(copy.id);
  };

  const deleteSelectedScript = () => {
    if (!selectedScript) return;
    setChartScripts((items) => {
      const next = items.filter((script) => script.id !== selectedScript.id);
      setSelectedScriptId(next[0]?.id ?? null);
      return next.length > 0 ? next : [createDefaultChartScript()];
    });
    setScriptRunStates((states) => {
      const next = { ...states };
      delete next[selectedScript.id];
      return next;
    });
  };

  const orderLineAtPointer = (clientY: number) => {
    const chart = chartRef.current;
    const container = containerRef.current;
    if (!chart || !container || !layerVisibility.priceLines) return null;
    const box = container.getBoundingClientRect();
    const y = clientY - box.top;
    let match: { line: ChartOrderLine; y: number; distance: number } | null = null;
    for (const line of orderLines) {
      if (!line.editable || !Number.isFinite(line.price) || line.price <= 0) continue;
      const lineY = chart.priceToCoordinate(line.price);
      if (lineY === null) continue;
      const distance = Math.abs(Number(lineY) - y);
      if (distance <= 8 && (!match || distance < match.distance)) {
        match = { line, y: Number(lineY), distance };
      }
    }
    return match;
  };

  const positionHandleAtPointer = (clientY: number) => {
    const container = containerRef.current;
    if (!container || !layerVisibility.priceLines) return null;
    const box = container.getBoundingClientRect();
    const y = clientY - box.top;
    let match: { range: ChartPositionRange; y: number; distance: number } | null = null;
    for (const overlay of positionRangeOverlays) {
      const distance = Math.abs(overlay.yHandle - y);
      if (distance <= 12 && (!match || distance < match.distance)) {
        match = { range: overlay.range, y: overlay.yHandle, distance };
      }
    }
    return match;
  };

  const fillMarkerAtPointer = (clientX: number, clientY: number): FillTooltip | null => {
    if (!layerVisibility.fills) return null;
    const chart = chartRef.current;
    const container = containerRef.current;
    if (!chart || !container) return null;
    const box = container.getBoundingClientRect();
    const x = clientX - box.left;
    const y = clientY - box.top;
    let match: { marker: ChartFillMarker; x: number; y: number; distance: number } | null = null;
    for (const marker of displayFillMarkers) {
      if (!Number.isFinite(marker.time) || !Number.isFinite(marker.price)) continue;
      const markerX = chart.timeToCoordinate(marker.time);
      const markerY = chart.priceToCoordinate(marker.price);
      if (markerX === null || markerY === null) continue;
      const distance = Math.hypot(Number(markerX) - x, Number(markerY) - y);
      if (distance <= 18 && (!match || distance < match.distance)) {
        match = { marker, x: Math.min(box.width - 190, Math.max(10, Number(markerX) + 12)), y: Math.min(box.height - 86, Math.max(66, Number(markerY) - 34)), distance };
      }
    }
    return match ? { marker: match.marker, x: match.x, y: match.y } : null;
  };

  const fillTooltipPosition = (x: number, y: number) => {
    const box = containerRef.current?.getBoundingClientRect();
    const maxX = Math.max(10, (box?.width ?? 220) - 190);
    const maxY = Math.max(66, (box?.height ?? 160) - 86);
    return {
      x: Math.min(maxX, Math.max(10, x + 12)),
      y: Math.min(maxY, Math.max(66, y - 34))
    };
  };

  const pointFromPointer = (clientX: number, clientY: number, snap = false): MeasurePoint | null => {
    const chart = chartRef.current;
    const container = containerRef.current;
    if (!chart || !container) return null;
    const box = container.getBoundingClientRect();
    const x = clientX - box.left;
    const y = clientY - box.top;
    const time = coordinateToDrawingTime(chart, candles, x);
    const price = chart.coordinateToPrice(y);
    if (!Number.isFinite(time) || !Number.isFinite(price) || Number(price) <= 0) return null;
    const roundedTime = snap ? nearestCandleTime(candles.map((candle) => candle.time), Number(time)) ?? Number(time) : Number(time);
    const snapped = snap ? snapPointToOhlc(roundedTime, Number(price), candleMapRef.current) : null;
    if (snapped) return snapped;
    return {
      time: roundedTime,
      index: candleIndexRef.current.get(roundedTime) ?? 0,
      price: Number(price)
    };
  };

  const completeRiskRewardDrawing = (
    tool: "long-position" | "short-position",
    entry: MeasurePoint,
    target: MeasurePoint
  ) => {
    const line = createRiskRewardDrawing(tool, entry, target);
    commitDrawingLines((items) => [...items, line].slice(-24));
    setSelectedDrawingId(line.id);
    clearActiveDrawingTool();
  };

  const createDrawingFromPoint = (point: MeasurePoint) => {
    const tool = drawingToolRef.current;
    if (tool === "horizontal" || tool === "vertical") {
      const end = tool === "horizontal" ? { ...point, time: point.time + currentBarSeconds(candles) } : { ...point, price: point.price * 1.002 };
      const line = { id: `drawing-${Date.now()}-${Math.random().toString(16).slice(2)}`, tool, start: point, end };
      commitDrawingLines((items) => [...items, line].slice(-24));
      setSelectedDrawingId(line.id);
      clearActiveDrawingTool();
      return;
    }
    if (!pendingDrawPoint) {
      setPendingDrawPoint(point);
      return;
    }
    if (isRiskRewardTool(tool)) {
      completeRiskRewardDrawing(tool, pendingDrawPoint, point);
      return;
    }
    const line = tool === "rect"
      ? createRectDrawing(pendingDrawPoint, point)
      : {
        id: `drawing-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        tool,
        start: pendingDrawPoint,
        end: point
      } satisfies DrawingLine;
    commitDrawingLines((items) => [...items, line].slice(-24));
    setSelectedDrawingId(line.id);
    clearActiveDrawingTool();
  };

  aiChartActionHandlerRef.current = (action) => {
      const payload = action.payload ?? {};
      if (action.instId && action.instId !== symbol) return;
      if (action.bar && action.bar !== timeframe) return;
      if (typeof payload.instId === "string" && payload.instId && payload.instId !== symbol) return;
      if (typeof payload.bar === "string" && payload.bar && payload.bar !== timeframe) return;
      const id = String(payload.id || action.id || `${action.toolName}-${Date.now()}`);

      if (action.toolName === "chart.createDrawing") {
        const tool = normalizeDrawingTool(payload.tool);
        const start = coerceMeasurePoint(payload.start, candles);
        if (!tool || !start) return;
        const end = coerceMeasurePoint(payload.end, candles) ?? defaultDrawingEnd(tool, start, candles);
        const baseLine = tool === "rect" ? createRectDrawing(start, end, id) : { id, tool, start, end };
        const line: DrawingLine = {
          ...baseLine,
          stop: coerceMeasurePoint(payload.stop, candles) ?? baseLine.stop,
          color: typeof payload.color === "string" ? payload.color : undefined,
          lineStyle: normalizeLineStyle(payload.lineStyle)
        };
        commitDrawingLines((items) => [...items.filter((item) => item.id !== line.id), line].slice(-24));
        setSelectedDrawingId(line.id);
        setLayerVisibility((items) => ({ ...items, drawings: true }));
        return;
      }

      if (action.toolName === "chart.updateDrawing") {
        commitDrawingLines((items) => items.map((item) => {
          if (item.id !== id) return item;
          const start = coerceMeasurePoint(payload.start, candles);
          const end = coerceMeasurePoint(payload.end, candles);
          const stop = coerceMeasurePoint(payload.stop, candles);
          const tool = normalizeDrawingTool(payload.tool);
          return {
            ...item,
            tool: tool ?? item.tool,
            start: start ?? item.start,
            end: end ?? item.end,
            stop: stop ?? item.stop,
            color: typeof payload.color === "string" ? payload.color : item.color,
            lineStyle: normalizeLineStyle(payload.lineStyle) ?? item.lineStyle,
            hidden: typeof payload.hidden === "boolean" ? payload.hidden : item.hidden,
            locked: typeof payload.locked === "boolean" ? payload.locked : item.locked
          };
        }));
        return;
      }

      if (action.toolName === "chart.deleteDrawing") {
        commitDrawingLines((items) => items.filter((item) => item.id !== id));
        if (selectedDrawingId === id) setSelectedDrawingId(null);
        return;
      }

      if (action.toolName === "alert.createPriceAlert") {
        const price = Number(payload.price);
        const direction = normalizeAlertDirection(payload.direction);
        if (!Number.isFinite(price) || price <= 0 || !direction) return;
        const alert: PriceAlert = {
          id,
          price,
          direction,
          createdAt: Date.now(),
          triggered: false,
          source: "ai",
          name: typeof payload.name === "string" ? payload.name.slice(0, 40) : undefined
        };
        setPriceAlerts((items) => [alert, ...items.filter((item) => item.id !== id)].slice(0, 32));
        setLayerVisibility((items) => ({ ...items, alerts: true }));
        return;
      }

      if (action.toolName === "alert.updatePriceAlert") {
        setPriceAlerts((items) => items.map((item) => {
          if (item.id !== id) return item;
          const price = Number(payload.price);
          const direction = normalizeAlertDirection(payload.direction);
          return {
            ...item,
            price: Number.isFinite(price) && price > 0 ? price : item.price,
            direction: direction ?? item.direction,
            name: typeof payload.name === "string" ? payload.name.slice(0, 40) : item.name,
            triggered: typeof payload.triggered === "boolean" ? payload.triggered : item.triggered
          };
        }));
        return;
      }

      if (action.toolName === "alert.deletePriceAlert") {
        setPriceAlerts((items) => items.filter((item) => item.id !== id));
        return;
      }

      if (action.toolName === "script.createOrUpdate") {
        const now = Date.now();
        setChartScripts((items) => {
          const existing = items.find((item) => item.id === id);
          const base = existing ?? createDefaultChartScript();
          const nextScript: ChartScriptDefinition = withSavedChartScriptVersion({
            ...base,
            id,
            name: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim().slice(0, 40) : base.name,
            description: typeof payload.description === "string" ? payload.description.slice(0, 160) : base.description,
            source: typeof payload.source === "string" ? payload.source : base.source,
            enabled: typeof payload.enabled === "boolean" ? payload.enabled : base.enabled,
            hidden: typeof payload.hidden === "boolean" ? payload.hidden : base.hidden,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            versions: existing?.versions?.length ? existing.versions : base.versions
          });
          savedScriptSourcesRef.current[nextScript.id] = nextScript.source;
          const next = existing ? items.map((item) => (item.id === id ? nextScript : item)) : [nextScript, ...items].slice(0, 24);
          saveChartScripts(next);
          return next;
        });
        setSelectedScriptId(id);
        if (payload.openPanel === true) setScriptPanelOpen(true);
        return;
      }

      if (action.toolName === "script.enable") {
        setChartScripts((items) => {
          const next = items.map((item) => item.id === id ? {
            ...item,
            enabled: typeof payload.enabled === "boolean" ? payload.enabled : true,
            hidden: typeof payload.hidden === "boolean" ? payload.hidden : false,
            updatedAt: Date.now()
          } : item);
          saveChartScripts(next);
          return next;
        });
        return;
      }

      if (action.toolName === "script.delete") {
        setChartScripts((items) => {
          const next = items.filter((item) => item.id !== id);
          const normalized = next.length > 0 ? next : [createDefaultChartScript()];
          saveChartScripts(normalized);
          setSelectedScriptId(normalized[0]?.id ?? null);
          return normalized;
        });
        setScriptRunStates((states) => {
          const next = { ...states };
          delete next[id];
          return next;
        });
        return;
      }

      if (action.toolName === "script.run") {
        const script = chartScripts.find((item) => item.id === id);
        if (script) runChartScriptNow(script);
      }
  };

  useEffect(() => {
    const listenerCleanup = createDeferredCleanupSlot();
    void listenOptional<AiChartAction>("ai:chart-action", (action) => {
      aiChartActionHandlerRef.current(action);
    }).then((cleanup) => listenerCleanup.settle(cleanup));
    return () => listenerCleanup.dispose();
  }, []);

  const createGuideDrawing = (tool: Extract<DrawingTool, "horizontal" | "vertical">, point: MeasurePoint) => {
    const barSeconds = currentBarSeconds(candles);
    const end = tool === "horizontal" ? { ...point, time: point.time + barSeconds } : { ...point, price: point.price * 1.002 };
    const line: DrawingLine = { id: `drawing-${Date.now()}-${Math.random().toString(16).slice(2)}`, tool, start: point, end };
    commitDrawingLines((items) => [...items, line].slice(-24));
    setSelectedDrawingId(line.id);
    clearActiveDrawingTool();
    setGuideDrag(null);
  };

  const startGuideDrag = (tool: Extract<DrawingTool, "horizontal" | "vertical">, event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setAutoFit(false);
    setGuideDrag({ tool });
    setDrawMode(false);
    setMeasureMode(false);
    setPendingDrawPoint(null);
    setPreviewDrawPoint(null);
  };

  useEffect(() => {
    if (!guideDrag) return;
    const onPointerMove = (event: PointerEvent) => {
      const point = pointFromPointer(event.clientX, event.clientY, event.shiftKey);
      if (!point) return;
      const tool = guideDrag.tool;
      setPendingDrawPoint(point);
      setPreviewDrawPoint(tool === "horizontal" ? { ...point, time: point.time + currentBarSeconds(candles) } : { ...point, price: point.price * 1.002 });
      setDrawingTool(tool);
    };
    const onPointerUp = (event: PointerEvent) => {
      const point = pointFromPointer(event.clientX, event.clientY, event.shiftKey);
      if (point) createGuideDrawing(guideDrag.tool, point);
      else {
        setGuideDrag(null);
        setPendingDrawPoint(null);
        setPreviewDrawPoint(null);
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [candles, guideDrag]);

  const startDrawingDrag = (id: string, handle: DrawingDrag["handle"], event: ReactPointerEvent<SVGElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const origin = drawingLines.find((line) => line.id === id);
    if (!origin || origin.locked) return;
    setSelectedDrawingId(id);
    setDrawingDrag({ id, handle, origin, snapshot: drawingLines, startPointer: { x: event.clientX, y: event.clientY } });
  };

  useEffect(() => {
    if (!drawingDrag) return;
    let didMove = false;
    const beginMove = (clientX: number, clientY: number) => {
      if (didMove) return true;
      const distance = Math.hypot(clientX - drawingDrag.startPointer.x, clientY - drawingDrag.startPointer.y);
      if (distance < DRAWING_EDIT_DRAG_THRESHOLD) return false;
      didMove = true;
      setDrawingHistory((history) => [...history, drawingDrag.snapshot].slice(-30));
      setDrawingRedoHistory([]);
      return true;
    };
    const applyPoint = (nextPoint: MeasurePoint) => {
      setDrawingLines((items) =>
        items.map((line) => {
          if (line.id !== drawingDrag.id || line.locked) return line;
          const origin = drawingDrag.origin;
          if (isRiskRewardTool(origin.tool)) {
            if (drawingDrag.handle === "entry" || drawingDrag.handle === "target" || drawingDrag.handle === "stop") {
              return resizeRiskRewardDrawing(origin, drawingDrag.handle, nextPoint);
            }
            if (drawingDrag.handle === "body") {
              const startPoint = pointFromPointer(drawingDrag.startPointer.x, drawingDrag.startPointer.y, false);
              if (!startPoint) return line;
              return moveRiskRewardDrawing(origin, nextPoint.time - startPoint.time, nextPoint.price - startPoint.price);
            }
          }
          if (origin.tool === "rect") {
            if (drawingDrag.handle !== "body") return resizeRectDrawing(origin, drawingDrag.handle, nextPoint);
            const startPoint = pointFromPointer(drawingDrag.startPointer.x, drawingDrag.startPointer.y, false);
            if (!startPoint) return line;
            return moveRectDrawing(origin, nextPoint.time - startPoint.time, nextPoint.price - startPoint.price);
          }
          if (drawingDrag.handle === "start") {
            if (origin.tool === "horizontal") return moveHorizontalDrawing(origin, nextPoint.price);
            if (origin.tool === "vertical") return moveVerticalDrawing(origin, nextPoint.time);
            return { ...origin, start: nextPoint };
          }
          if (drawingDrag.handle === "end") {
            if (origin.tool === "horizontal") return moveHorizontalDrawing(origin, nextPoint.price);
            if (origin.tool === "vertical") return moveVerticalDrawing(origin, nextPoint.time);
            return { ...origin, end: nextPoint };
          }
          const startPoint = pointFromPointer(drawingDrag.startPointer.x, drawingDrag.startPointer.y, false);
          if (!startPoint) return line;
          const timeDelta = nextPoint.time - startPoint.time;
          const priceDelta = nextPoint.price - startPoint.price;
          if (origin.tool === "horizontal") return moveHorizontalDrawing(origin, origin.start.price + priceDelta);
          if (origin.tool === "vertical") return moveVerticalDrawing(origin, origin.start.time + timeDelta);
          return {
            ...origin,
            start: { ...origin.start, time: origin.start.time + timeDelta, price: origin.start.price + priceDelta },
            end: { ...origin.end, time: origin.end.time + timeDelta, price: origin.end.price + priceDelta }
          };
        })
      );
    };
    const flush = () => {
      drawingDragFrameRef.current = null;
      const point = drawingDragPendingPointRef.current;
      drawingDragPendingPointRef.current = null;
      if (point) applyPoint(point);
    };
    const queuePoint = (point: MeasurePoint) => {
      drawingDragPendingPointRef.current = point;
      if (drawingDragFrameRef.current !== null) return;
      drawingDragFrameRef.current = window.requestAnimationFrame(flush);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!beginMove(event.clientX, event.clientY)) return;
      const point = pointFromPointer(event.clientX, event.clientY, event.shiftKey);
      if (point) queuePoint(point);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!beginMove(event.clientX, event.clientY)) {
        setDrawingDrag(null);
        return;
      }
      const point = pointFromPointer(event.clientX, event.clientY, event.shiftKey);
      if (point) drawingDragPendingPointRef.current = point;
      if (drawingDragFrameRef.current !== null) {
        window.cancelAnimationFrame(drawingDragFrameRef.current);
        drawingDragFrameRef.current = null;
      }
      flush();
      setDrawingDrag(null);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      if (drawingDragFrameRef.current !== null) window.cancelAnimationFrame(drawingDragFrameRef.current);
      drawingDragFrameRef.current = null;
      drawingDragPendingPointRef.current = null;
    };
  }, [candles, drawingDrag]);

  const handleChartPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    setAutoFit(false);
    setDrawingMenu(null);
    if (event.button === 0) {
      setChartContextMenu(null);
      setFillTooltip(null);
      setFillTooltipPinned(false);
    }
    if (measureMode || drawMode) {
      const point = pointFromPointer(event.clientX, event.clientY, event.shiftKey);
      if (!point) return;
      event.preventDefault();
      if (drawMode) {
        const tool = drawingToolRef.current;
        if (isRiskRewardTool(tool)) {
          const existingEntry = pendingDrawPoint;
          const entry = existingEntry ?? point;
          riskRewardCreateGestureRef.current = {
            pointerId: event.pointerId,
            tool,
            entry,
            completeOnRelease: Boolean(existingEntry),
            startPointer: { x: event.clientX, y: event.clientY }
          };
          if (!existingEntry) setPendingDrawPoint(entry);
          setPreviewDrawPoint(point);
          event.currentTarget.setPointerCapture(event.pointerId);
          return;
        }
        createDrawingFromPoint(point);
        return;
      }
      if (!measureSelection.start || measureSelection.end) {
        setMeasureSelection({ start: point, end: null });
      } else {
        setMeasureSelection({ start: measureSelection.start, end: point });
        setMeasureMode(false);
      }
      return;
    }
    const match = orderLineAtPointer(event.clientY);
    if (match) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setDraggingOrderLine({ line: match.line, price: match.line.price, y: match.y });
      return;
    }
    const positionMatch = positionHandleAtPointer(event.clientY);
    if (!positionMatch) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraggingPositionLine({ range: positionMatch.range, price: positionMatch.range.entryPrice, y: positionMatch.y, snapToMarket: event.shiftKey });
  };

  const handleChartPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (measureMode || drawMode) {
      setHoveringEditableOrderLine(false);
      setFillTooltip(null);
      setFillTooltipPinned(false);
      const riskRewardGesture = riskRewardCreateGestureRef.current;
      if (drawMode && riskRewardGesture?.pointerId === event.pointerId) {
        const point = pointFromPointer(event.clientX, event.clientY, event.shiftKey);
        if (point) setPreviewDrawPoint(point);
        return;
      }
      if (drawMode && pendingDrawPoint && !drawingDrag) {
        setPreviewDrawPoint(pointFromPointer(event.clientX, event.clientY, event.shiftKey));
      }
      return;
    }
    const chart = chartRef.current;
    const container = containerRef.current;
    if (!chart || !container) return;
    if (guideDrag) return;
    if (draggingPositionLine) {
      event.preventDefault();
      const nextPrice = event.shiftKey ? draggingPositionLine.range.currentPrice : chart.coordinateToPrice(event.clientY - container.getBoundingClientRect().top);
      const nextY = chart.priceToCoordinate(Number(nextPrice));
      if (!Number.isFinite(nextPrice) || Number(nextPrice) <= 0 || nextY === null) return;
      setDraggingPositionLine((current) => (current ? { ...current, price: Number(nextPrice), y: Number(nextY), snapToMarket: event.shiftKey } : current));
      return;
    }
    if (!draggingOrderLine) return;
    event.preventDefault();
    const box = container.getBoundingClientRect();
    const y = event.clientY - box.top;
    const price = chart.coordinateToPrice(y);
    if (!Number.isFinite(price) || Number(price) <= 0) return;
    setDraggingOrderLine((current) => (current ? { ...current, price: Number(price), y } : current));
  };

  const handleChartPointerHover = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (draggingOrderLine || draggingPositionLine || measureMode || drawMode) {
      setHoveringEditableOrderLine(false);
      setHoveringPositionHandle(false);
      setFillTooltip(null);
      setFillTooltipPinned(false);
      return;
    }
    const hasEditableOrder = Boolean(orderLineAtPointer(event.clientY));
    setHoveringEditableOrderLine(hasEditableOrder);
    setHoveringPositionHandle(!hasEditableOrder && Boolean(positionHandleAtPointer(event.clientY)));
    if (!fillTooltipPinned) {
      setFillTooltip(hasEditableOrder ? null : fillMarkerAtPointer(event.clientX, event.clientY));
    }
  };

  const finishRiskRewardCreate = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const gesture = riskRewardCreateGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return false;
    riskRewardCreateGestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (cancelled) {
      if (!gesture.completeOnRelease) setPendingDrawPoint(null);
      setPreviewDrawPoint(null);
      return true;
    }
    const point = pointFromPointer(event.clientX, event.clientY, event.shiftKey);
    const distance = Math.hypot(event.clientX - gesture.startPointer.x, event.clientY - gesture.startPointer.y);
    if (point && (gesture.completeOnRelease || distance >= RISK_REWARD_CREATE_DRAG_THRESHOLD)) {
      completeRiskRewardDrawing(gesture.tool, gesture.entry, point);
    } else if (point) {
      setPreviewDrawPoint(point);
    }
    return true;
  };

  const finishOrderLineDrag = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    if (finishRiskRewardCreate(event, cancelled)) return;
    if (!draggingOrderLine && !draggingPositionLine) return;
    event.preventDefault();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (cancelled) {
      setDraggingOrderLine(null);
      setDraggingPositionLine(null);
      return;
    }
    if (draggingPositionLine) {
      const payload = draggingPositionLine;
      setDraggingPositionLine(null);
      const intent = buildPositionLineIntent(payload.range, payload.snapToMarket ? payload.range.currentPrice : payload.price);
      if (intent) onPositionLineTradeIntentRef.current?.(intent);
      return;
    }
    if (!draggingOrderLine) return;
    const payload = draggingOrderLine;
    setDraggingOrderLine(null);
    if (Math.abs(payload.price - payload.line.price) <= Number.EPSILON) return;
    const isTriggerOrder = payload.line.editKind === "algo-trigger";
    const executesAtMarket = payload.line.orderPrice === null;
    onOrderLineEditRef.current?.({
      line: payload.line,
      price: payload.price,
      // A plan-order line represents its trigger. Keep a limit plan coherent by
      // offering the dragged price for both fields; market plans stay market.
      triggerPrice: isTriggerOrder ? payload.price : undefined,
      orderPrice: isTriggerOrder ? (executesAtMarket ? null : payload.price) : undefined
    });
  };

  const clearActiveDrawingTool = () => {
    setMeasureMode(false);
    setDrawMode(false);
    setLineToolMenuOpen(false);
    setPendingDrawPoint(null);
    setPreviewDrawPoint(null);
  };

  const activateDrawingTool = (tool: DrawingTool) => {
    setDrawingTool(tool);
    setDrawMode(true);
    setMeasureMode(false);
    setLineToolMenuOpen(false);
    setPendingDrawPoint(null);
    setPreviewDrawPoint(null);
  };

  const handleCanvasContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!measureMode && !drawMode && !pendingDrawPoint) return;
    event.preventDefault();
    clearActiveDrawingTool();
  };

  const dispatchRiskRewardTradeIntent = (line: DrawingLine, action: ChartRiskRewardTradeIntent["action"]) => {
    if (!isRiskRewardTool(line.tool) || !line.stop) return;
    onRiskRewardTradeIntentRef.current?.({
      action,
      instId: symbol,
      side: line.tool === "long-position" ? "long" : "short",
      entryPrice: line.start.price,
      takeProfitPrice: line.end.price,
      stopLossPrice: line.stop.price
    });
    setDrawingMenu(null);
  };

  return (
    <div
      className={clsx("chart-wrap", reviewVariant && "review-variant")}
      data-order-line-count={orderLines.length}
      data-editable-order-line-count={orderLines.filter((line) => line.editable).length}
      data-order-line-labels={orderLines.map((line) => line.label).join("|")}
      data-signal-marker-count={signalMarkers.length}
      data-fill-marker-count={fillMarkers.length}
      data-trade-marker-labels={[...signalMarkers, ...fillMarkers].map((marker) => marker.text).filter(Boolean).join("|")}
      data-marker-label-mode={markerDisplayMode.expanded ? "expanded" : "compact"}
      data-visible-marker-bars={markerDisplayMode.visibleBarSpan}
      data-visible-marker-events={markerDisplayMode.visibleEventCount}
      data-position-range-count={positionRangeOverlays.length}
      data-latest-candle-x={latestCandleX ?? ""}
      data-candle-count={candles.length}
      data-first-candle-time={candles[0]?.time ?? ""}
    >
      <div className="ohlc-strip">
        <div className="ohlc-summary">
          <span>{t("trading:lastPrice")} {formatChartNumber(livePrice)}</span>
          {displayStats ? (
            <>
              <span>{t("common:time")} {formatShanghaiChartTimestamp(displayStats.time, true)}</span>
              <span>{t("trading:open")} {formatChartNumber(displayStats.open)}</span>
              <span>{t("trading:high")} {formatChartNumber(displayStats.high)}</span>
              <span>{t("trading:low")} {formatChartNumber(displayStats.low)}</span>
              <span>{t("trading:close")} {formatChartNumber(displayStats.close)}</span>
              <span className={change >= 0 ? "up" : "down"}>
                {change >= 0 ? "+" : ""}
                {formatChartNumber(change)} / {changePercent.toFixed(2)}%
              </span>
              <span>{t("trading:volume")} {formatVolume(displayStats.volume)}</span>
            </>
          ) : (
            <span>{t("chart:waitingCandles")}</span>
          )}
        </div>
        {hoverStats?.indicatorValues.length ? (
          <div className="ohlc-indicator-values" aria-label={t("chart:currentCandleValues")}>
            {hoverStats.indicatorValues.map((item) => (
              <span className="ohlc-indicator-value" key={item.id} style={{ color: item.color }}>
                {item.label} {formatChartNumber(item.value)}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {!reviewVariant && toolbarPlacement === "external" && <ChartIndicatorCenter
        instances={indicatorInstances}
        onChange={handleIndicatorInstancesChange}
        unavailableIds={unavailableIndicatorIds}
        externalTrigger={externalIndicatorTrigger}
        openRequest={externalToolbarAction?.action === "indicators" ? externalToolbarAction.token : undefined}
        hideInlineControls
        customScripts={chartScripts}
        customScriptRunStates={scriptRunStates}
        onOpenCustomIndicatorEditor={openCustomIndicatorEditor}
        onEnableCustomIndicator={enableCustomIndicator}
        onToggleCustomIndicatorVisibility={toggleCustomIndicatorVisibility}
        onRemoveCustomIndicator={removeCustomIndicatorFromChart}
      />}
      {!reviewVariant && toolbarPlacement === "floating" && <div className="chart-control-bar">
        <ChartIndicatorCenter
          instances={indicatorInstances}
          onChange={handleIndicatorInstancesChange}
          unavailableIds={unavailableIndicatorIds}
          customScripts={chartScripts}
          customScriptRunStates={scriptRunStates}
          onOpenCustomIndicatorEditor={openCustomIndicatorEditor}
          onEnableCustomIndicator={enableCustomIndicator}
          onToggleCustomIndicatorVisibility={toggleCustomIndicatorVisibility}
          onRemoveCustomIndicator={removeCustomIndicatorFromChart}
        />
        <button
          type="button"
          ref={alertTriggerRef}
          data-chart-alert-trigger="true"
          className={clsx("chart-alert-trigger", alertPanelOpen && "active")}
          aria-haspopup="dialog"
          aria-expanded={alertPanelOpen}
          title={chartText("Price alerts", "价格提醒")}
          onClick={() => {
            setLayerVisibility((items) => items.alerts ? items : { ...items, alerts: true });
            setAlertPanelOpen((value) => !value);
          }}
        >
          <BellRing size={13} />
          <span>{chartText("Alerts", "提醒")}</span>
          {activePriceAlerts.length > 0 && <strong>{activePriceAlerts.length}</strong>}
        </button>
        <div className="chart-layer-menu-anchor" ref={layerMenuRef}>
          <button
            type="button"
            className={clsx("chart-layer-menu-trigger", layerMenuOpen && "active")}
            aria-haspopup="menu"
            aria-expanded={layerMenuOpen}
            onClick={() => setLayerMenuOpen((value) => !value)}
          >
            <Layers3 size={13} /> {chartText("Layers", "图层")}
          </button>
          {layerMenuOpen && (
            <div className="chart-layer-menu" role="menu" aria-label={chartText("Layer visibility", "图层显示设置")}>
              {CHART_LAYER_MENU_ITEMS.map(([key, english, chinese]) => {
                if (key === "fills") {
                  return (
                    <div className="chart-layer-group" key={key}>
                      <div className="chart-layer-row">
                        <label>
                          <input
                            type="checkbox"
                            checked={layerVisibility.fills}
                            onChange={() => setLayerVisibility((items) => ({ ...items, fills: !items.fills }))}
                          />
                          <span>{chartText(english, chinese)}</span>
                        </label>
                        <button
                          type="button"
                          className={clsx("chart-layer-expander", fillMenuExpanded && "is-expanded")}
                          aria-expanded={fillMenuExpanded}
                          aria-label={chartText("Expand fill source filter", "展开成交来源筛选")}
                          onClick={() => setFillMenuExpanded((value) => !value)}
                        >
                          <ChevronRight size={12} />
                        </button>
                      </div>
                      {layerVisibility.fills && fillMenuExpanded && (
                        <div className="chart-layer-submenu" role="group" aria-label={chartText("Fill source filter", "成交来源筛选")}>
                          <div className="chart-layer-row chart-layer-row--sub">
                            <label className="chart-layer-subitem">
                              <input
                                type="checkbox"
                                checked={fillSourceFilter.ai}
                                onChange={() => setFillSourceFilter((items) => ({ ...items, ai: !items.ai }))}
                              />
                              <span>{chartText("AI orders", "AI 下单")}</span>
                            </label>
                            <button
                              type="button"
                              className={clsx("chart-layer-expander", aiMenuExpanded && "is-expanded")}
                              aria-expanded={aiMenuExpanded}
                              aria-label={chartText("Expand AI profile filter", "展开 AI Profile 筛选")}
                              onClick={() => setAiMenuExpanded((value) => !value)}
                            >
                              <ChevronRight size={12} />
                            </button>
                          </div>
                          {fillSourceFilter.ai && aiMenuExpanded && (
                            <div className="chart-layer-submenu chart-layer-submenu--deep" role="group">
                              <label className="chart-layer-subitem">
                                <input
                                  type="checkbox"
                                  checked={Object.keys(fillSourceFilter.aiProfiles).length === 0}
                                  onChange={() => setFillSourceFilter((items) => ({ ...items, aiProfiles: {} }))}
                                />
                                <span>{chartText("All AI", "全部 AI")}</span>
                              </label>
                              {(tradeSources?.aiProfiles ?? []).map((profile) => (
                                <label className="chart-layer-subitem" key={profile.id}>
                                  <input
                                    type="checkbox"
                                    checked={fillSourceFilter.aiProfiles[profile.id] === true}
                                    onChange={() => setFillSourceFilter((items) => ({
                                      ...items,
                                      aiProfiles: { ...items.aiProfiles, [profile.id]: items.aiProfiles[profile.id] !== true }
                                    }))}
                                  />
                                  <span title={profile.id}>{profile.name}</span>
                                </label>
                              ))}
                            </div>
                          )}
                          <div className="chart-layer-row chart-layer-row--sub">
                            <label className="chart-layer-subitem">
                              <input
                                type="checkbox"
                                checked={fillSourceFilter.strategy}
                                onChange={() => setFillSourceFilter((items) => ({ ...items, strategy: !items.strategy }))}
                              />
                              <span>{chartText("Strategy orders", "策略下单")}</span>
                            </label>
                            <button
                              type="button"
                              className={clsx("chart-layer-expander", strategyMenuExpanded && "is-expanded")}
                              aria-expanded={strategyMenuExpanded}
                              aria-label={chartText("Expand strategy profile filter", "展开策略 Profile 筛选")}
                              onClick={() => setStrategyMenuExpanded((value) => !value)}
                            >
                              <ChevronRight size={12} />
                            </button>
                          </div>
                          {fillSourceFilter.strategy && strategyMenuExpanded && (
                            <div className="chart-layer-submenu chart-layer-submenu--deep" role="group">
                              <label className="chart-layer-subitem">
                                <input
                                  type="checkbox"
                                  checked={Object.keys(fillSourceFilter.strategyProfiles).length === 0}
                                  onChange={() => setFillSourceFilter((items) => ({ ...items, strategyProfiles: {} }))}
                                />
                                <span>{chartText("All strategies", "全部策略")}</span>
                              </label>
                              {(tradeSources?.strategyProfiles ?? []).map((profile) => (
                                <label className="chart-layer-subitem" key={profile.id}>
                                  <input
                                    type="checkbox"
                                    checked={fillSourceFilter.strategyProfiles[profile.id] === true}
                                    onChange={() => setFillSourceFilter((items) => ({
                                      ...items,
                                      strategyProfiles: { ...items.strategyProfiles, [profile.id]: items.strategyProfiles[profile.id] !== true }
                                    }))}
                                  />
                                  <span title={profile.id}>{profile.name}</span>
                                </label>
                              ))}
                            </div>
                          )}
                          <label className="chart-layer-subitem">
                            <input
                              type="checkbox"
                              checked={fillSourceFilter.user}
                              onChange={() => setFillSourceFilter((items) => ({ ...items, user: !items.user }))}
                            />
                            <span>{chartText("User orders", "用户下单")}</span>
                          </label>
                        </div>
                      )}
                    </div>
                  );
                }
                return (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={layerVisibility[key]}
                      onChange={() => setLayerVisibility((items) => ({ ...items, [key]: !items[key] }))}
                    />
                    <span>{chartText(english, chinese)}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
        <div className="chart-view-actions">
          <button type="button" className={clsx(gridVisible && "active")} onClick={() => setGridVisible((value) => !value)}>
            {chartText("Grid", "网格")}
          </button>
          <button type="button" disabled={drawingRedoHistory.length === 0} onClick={redoDrawingChange} title={chartText("Redo", "恢复")} aria-label={chartText("Redo", "恢复")}>
            {chartText("Redo", "恢复")}
          </button>
          <button
            type="button"
            onClick={() => {
              setAutoFit(true);
              chartRef.current?.resetView();
            }}
          >
            {chartText("Reset", "重置")}
          </button>
        </div>
      </div>}
      {!reviewVariant && <div className="chart-drawing-toolbar" aria-label={chartText("Drawing tools", "绘图工具")}>
        <div className="chart-line-tool-anchor">
          <button
            type="button"
            className={clsx(drawMode && lineToolItems.some((item) => item.kind === drawingTool) && "active")}
            title={chartText("Line tools", "线工具")}
            aria-label={chartText("Line tools", "线工具")}
            aria-expanded={lineToolMenuOpen}
            onClick={() => {
              setLineToolMenuOpen((value) => !value);
              setMeasureMode(false);
            }}
          >
            <Slash size={16} strokeWidth={1.8} />
          </button>
          {lineToolMenuOpen && (
            <div className="chart-line-tool-menu" onPointerDown={(event) => event.stopPropagation()}>
              <strong>{chartText("Lines", "线")}</strong>
              {lineToolItems.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    type="button"
                    key={item.kind}
                    className={clsx(drawMode && drawingTool === item.kind && "active")}
                    onClick={() => activateDrawingTool(item.kind)}
                  >
                    <Icon size={15} strokeWidth={1.8} />
                    <span>{chartText(item.english, item.chinese)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {drawingToolbarItems.map((item) => {
          const Icon = item.icon;
          const active = item.kind === "measure" ? measureMode : drawMode && drawingTool === item.kind;
          return (
            <button
              type="button"
              key={item.kind}
              className={clsx(active && "active")}
              title={chartText(item.english, item.chinese)}
              aria-label={chartText(item.english, item.chinese)}
              onClick={() => {
                if (item.kind === "measure") {
                  setMeasureMode((value) => !value);
                  setDrawMode(false);
                  setLineToolMenuOpen(false);
                } else {
                  if (drawMode && drawingTool === item.kind) {
                    clearActiveDrawingTool();
                    return;
                  }
                  activateDrawingTool(item.kind);
                }
                setPendingDrawPoint(null);
                setPreviewDrawPoint(null);
              }}
            >
              <Icon size={16} strokeWidth={1.8} />
            </button>
          );
        })}
        <span className="chart-drawing-toolbar-separator" />
        <button
          type="button"
          title={chartText("Undo", "撤销")}
          aria-label={chartText("Undo", "撤销")}
          disabled={drawingHistory.length === 0}
          onClick={undoDrawingChange}
        >
          <Undo2 size={16} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          title={chartText("Clear drawings", "清除绘图")}
          aria-label={chartText("Clear drawings", "清除绘图")}
          onClick={() => {
            setMeasureSelection({ start: null, end: null });
            commitDrawingLines(() => []);
            setSelectedDrawingId(null);
            setPendingDrawPoint(null);
            setPreviewDrawPoint(null);
          }}
        >
          <Trash2 size={16} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          title={chartText("Show hidden drawings", "显示隐藏绘图")}
          aria-label={chartText("Show hidden drawings", "显示隐藏绘图")}
          disabled={!drawingLines.some((line) => line.hidden)}
          onClick={() => commitDrawingLines((items) => items.map((line) => ({ ...line, hidden: false })))}
        >
          <Eye size={16} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          title={chartText("Cancel tool", "取消工具")}
          aria-label={chartText("Cancel tool", "取消工具")}
          onClick={() => {
            clearActiveDrawingTool();
            setSelectedDrawingId(null);
          }}
        >
          <Eraser size={16} strokeWidth={1.8} />
        </button>
      </div>}
      {!reviewVariant && scriptPanelOpen && (
        <div ref={scriptPanelDrag.surfaceRef} className="chart-script-panel" onPointerDown={(event) => event.stopPropagation()}>
          <div className="chart-script-panel-head" {...scriptPanelDrag.handleProps}>
            <div>
              <strong>{chartText("Chart scripts", "图表脚本")}</strong>
              <span>{chartText(`${activeScriptCount} enabled · ${scriptOutput.alerts.length} script alerts`, `${activeScriptCount} 个启用 · ${scriptOutput.alerts.length} 个脚本提醒`)}</span>
            </div>
            <button type="button" onClick={() => setScriptPanelOpen(false)}>{chartText("Close", "关闭")}</button>
          </div>
          <div className="chart-script-body">
            <div className="chart-script-list">
              <button type="button" className="chart-script-new" onClick={addChartScript}><Plus size={14} /> {chartText("New script", "新建脚本")}</button>
              {chartScripts.map((script) => {
                const state = scriptRunStates[script.id];
                const alertCount = state?.output.alerts.filter((alert) => alert.active).length ?? 0;
                return (
                  <button
                    type="button"
                    key={script.id}
                    className={clsx("chart-script-list-item", selectedScript?.id === script.id && "active", script.hidden && "muted")}
                    onClick={() => setSelectedScriptId(script.id)}
                  >
                    <span>
                      <strong data-i18n-skip="true">{script.name}</strong>
                      <em>{script.enabled ? state?.status ?? chartText("Waiting", "等待") : chartText("Disabled", "停用")} · {chartText(`${state?.outputCount ?? 0} outputs`, `${state?.outputCount ?? 0} 输出`)} · {chartText(`${alertCount} alerts`, `${alertCount} 提醒`)}</em>
                    </span>
                    <input
                      type="checkbox"
                      checked={script.enabled}
                      aria-label={chartText(`Enable ${script.name}`, `${script.name} 启用`)}
                      onChange={(event) => {
                        event.stopPropagation();
                        setChartScripts((items) => items.map((item) => (item.id === script.id ? { ...item, enabled: !item.enabled, updatedAt: Date.now() } : item)));
                      }}
                      onClick={(event) => event.stopPropagation()}
                    />
                  </button>
                );
              })}
            </div>
            {selectedScript && (
              <Suspense fallback={<div className="chart-script-editor-loading" aria-busy="true" />}>
                <ChartScriptEditor
                  script={selectedScript}
                  state={scriptRunStates[selectedScript.id]}
                  alertCount={scriptRunStates[selectedScript.id]?.output.alerts.filter((alert) => alert.active).length ?? 0}
                  onChange={updateSelectedScript}
                  onSave={saveSelectedScriptNow}
                  onRun={runSelectedScriptNow}
                  onCopy={copySelectedScript}
                  onDelete={deleteSelectedScript}
                />
              </Suspense>
            )}
          </div>
        </div>
      )}
      {!reviewVariant && alertPanelOpen && (
        <section className="chart-alert-panel" ref={alertPanelRef} role="dialog" aria-label={chartText("Alert center", "提醒中心")}>
          <header>
            <div>
              <strong><BellRing size={14} />{chartText("Alert center", "提醒中心")}</strong>
              <span>{symbol} · {chartText("Last", "最新")} {formatChartNumber(livePrice)}</span>
            </div>
            <button type="button" className="chart-alert-panel-close" title={chartText("Close", "关闭")} aria-label={chartText("Close alert center", "关闭提醒中心")} onClick={() => setAlertPanelOpen(false)}>
              <X size={14} />
            </button>
          </header>
          <form onSubmit={(event) => { event.preventDefault(); addChartAlert(); }}>
            <div className="chart-alert-kind" role="group" aria-label={chartText("Alert condition type", "提醒条件类型")}>
              <button type="button" className={alertConditionKind === "price" ? "active" : undefined} aria-pressed={alertConditionKind === "price"} onClick={() => { setAlertConditionKind("price"); setAlertFormError(""); }}>{chartText("Price", "价格")}</button>
              <button type="button" className={alertConditionKind === "indicator" ? "active" : undefined} aria-pressed={alertConditionKind === "indicator"} onClick={() => { setAlertConditionKind("indicator"); setAlertFormError(""); }}>{chartText("Indicator", "指标")}</button>
            </div>

            <label className="chart-alert-name-field">
              <span>{chartText("Alert name", "提醒名称")} <em>{chartText("Optional", "可选")}</em></span>
              <input value={alertName} maxLength={80} placeholder={chartText("Example: BTC trend confirmation", "例如：BTC 趋势确认")} onChange={(event) => setAlertName(event.target.value)} />
            </label>

            {alertConditionKind === "price" ? (
              <div className="chart-alert-condition-grid">
                <fieldset>
                  <legend>{chartText("Trigger direction", "触发方向")}</legend>
                  <div className="chart-alert-direction" role="group" aria-label={chartText("Alert trigger direction", "提醒触发方向")}>
                    <button type="button" className={priceAlertDirection === "above" ? "active" : undefined} aria-pressed={priceAlertDirection === "above"} onClick={() => setPriceAlertDirection("above")}>
                      <TrendingUp size={13} />{chartText("Crosses above", "上破")}
                    </button>
                    <button type="button" className={priceAlertDirection === "below" ? "active" : undefined} aria-pressed={priceAlertDirection === "below"} onClick={() => setPriceAlertDirection("below")}>
                      <TrendingDown size={13} />{chartText("Crosses below", "下破")}
                    </button>
                  </div>
                </fieldset>
                <label>
                  <span>{chartText("Trigger price", "触发价格")}</span>
                  <div className="chart-alert-price-input">
                    <input
                      ref={priceAlertInputRef}
                      value={priceAlertInput}
                      placeholder={livePrice ? formatChartNumber(livePrice) : chartText("Enter price", "输入价格")}
                      inputMode="decimal"
                      onChange={(event) => setPriceAlertInput(event.target.value)}
                    />
                    <button type="button" onClick={() => setPriceAlertInput(Number.isFinite(livePrice) && livePrice > 0 ? String(livePrice) : "")} disabled={!Number.isFinite(livePrice) || livePrice <= 0}>
                      {chartText("Last price", "最新价")}
                    </button>
                  </div>
                </label>
              </div>
            ) : (
              <div className="chart-alert-indicator-grid">
                <label>
                  <span>{chartText("Selected in indicator center", "指标中心已选")} <em>{chartText(`${indicatorAlertOptions.length}`, `${indicatorAlertOptions.length} 个`)}</em></span>
                  <TerminalSelect
                    ariaLabel={chartText("Indicators selected in indicator center", "指标中心已选指标")}
                    value={selectedIndicatorAlertOption?.id ?? ""}
                    disabled={selectableIndicatorAlertOptions.length === 0}
                    options={indicatorAlertOptions.length === 0
                      ? [{ value: "", label: chartText("Add an indicator in the indicator center first", "请先在指标中心添加指标") }]
                      : indicatorAlertOptions.map((item) => ({
                          value: item.id,
                          label: item.optionLabel,
                          disabled: item.outputs.length === 0,
                          data: {
                            "data-indicator-instance-id": item.source === "builtin" ? item.id : undefined,
                            "data-custom-indicator-id": item.source === "custom" ? item.id : undefined,
                          },
                        }))}
                    onChange={(value) => { setIndicatorAlertInstanceId(value); setIndicatorAlertOutputKey(""); }}
                  />
                </label>
                <label>
                  <span>{chartText("Data series", "数据线")} <em>{chartText(`${selectedIndicatorAlertOption?.outputs.length ?? 0}`, `${selectedIndicatorAlertOption?.outputs.length ?? 0} 条`)}</em></span>
                  <TerminalSelect
                    ariaLabel={chartText("Indicator data series", "指标数据线")}
                    value={selectedIndicatorAlertOutput?.key ?? ""}
                    disabled={!selectedIndicatorAlertOutput}
                    options={(selectedIndicatorAlertOption?.outputs ?? []).map((output) => ({ value: output.key, label: output.label, data: { "data-indicator-output-key": output.key } }))}
                    onChange={setIndicatorAlertOutputKey}
                  />
                </label>
                <label>
                  <span>{chartText("Compare with", "比较对象")}</span>
                  <TerminalSelect ariaLabel={chartText("Indicator comparison target", "指标比较对象")} value={indicatorAlertComparison} options={[{ value: "value", label: chartText("Fixed value", "固定数值") }, { value: "price", label: chartText("Last price", "最新价") }]} onChange={(value) => setIndicatorAlertComparison(value === "price" ? "price" : "value")} />
                </label>
                <label>
                  <span>{chartText("Condition", "条件")}</span>
                  <TerminalSelect ariaLabel={chartText("Indicator alert condition", "指标提醒条件")} value={indicatorAlertOperator} options={[{ value: "crossingAbove", label: chartText("Crosses above", "上穿") }, { value: "crossingBelow", label: chartText("Crosses below", "下穿") }, { value: "crossing", label: chartText("Crosses either way", "双向穿越") }, { value: "greaterThan", label: chartText("Greater than", "大于") }, { value: "lessThan", label: chartText("Less than", "小于") }]} onChange={(value) => setIndicatorAlertOperator(normalizeAlertOperator(value))} />
                </label>
                {indicatorAlertComparison === "value" ? (
                  <label>
                    <span>{chartText("Threshold", "阈值")}</span>
                    <input value={indicatorAlertThreshold} inputMode="decimal" placeholder={chartText("Enter a value", "输入数值")} onChange={(event) => setIndicatorAlertThreshold(event.target.value)} />
                  </label>
                ) : <p>{chartText(`Compare the last price with the indicator series after each ${timeframe} candle closes.`, `在 ${timeframe} K 线收盘后比较最新价与指标线。`)}</p>}
              </div>
            )}

            <div className="chart-alert-schedule-grid">
              <label><span>{chartText("Frequency", "频率")}</span><TerminalSelect ariaLabel={chartText("Alert frequency", "提醒频率")} value={alertFrequency} options={[{ value: "once", label: chartText("Once", "仅触发一次") }, { value: "repeat", label: chartText("Whenever condition is met", "每次满足条件") }]} onChange={(value) => setAlertFrequency(value === "repeat" ? "repeat" : "once")} /></label>
              <label><span>{chartText("Expiry", "有效期")}</span><TerminalSelect ariaLabel={chartText("Alert expiry", "提醒有效期")} value={alertExpiry} options={[{ value: "never", label: chartText("No expiry", "长期有效") }, { value: "day", label: chartText("24 hours", "24 小时") }, { value: "week", label: chartText("7 days", "7 天") }, { value: "month", label: chartText("30 days", "30 天") }]} onChange={(value) => setAlertExpiry(normalizeAlertExpiry(value))} /></label>
              {alertFrequency === "repeat" ? <label><span>{chartText("Cooldown (seconds)", "冷却（秒）")}</span><input value={alertCooldownSeconds} inputMode="numeric" onChange={(event) => setAlertCooldownSeconds(event.target.value)} /></label> : null}
            </div>

            <fieldset className="chart-alert-delivery">
              <legend>{chartText("Notification methods", "提醒方式")}</legend>
              <div>
                <label><input type="checkbox" checked={alertNotifyApp} onChange={(event) => setAlertNotifyApp(event.target.checked)} /><AppWindow size={13} /><span>{chartText("In app", "应用内")}</span></label>
                <label><input type="checkbox" checked={alertNotifyFeishu} onChange={(event) => setAlertNotifyFeishu(event.target.checked)} /><Send size={13} /><span>{chartText("Feishu", "飞书")}</span></label>
                <label><input type="checkbox" checked={alertNotifyWebhook} onChange={(event) => setAlertNotifyWebhook(event.target.checked)} /><Webhook size={13} /><span>{chartText("HTTP request", "HTTP 请求")}</span></label>
              </div>
              {alertNotifyFeishu ? <small>{chartText("Configure the bot webhook in Notification settings before using Feishu delivery.", "飞书需要先在通知设置中配置机器人 Webhook。")}</small> : null}
            </fieldset>

            {alertNotifyWebhook ? (
              <div className="chart-alert-webhook">
                <div className="chart-alert-webhook-method" role="group" aria-label={chartText("HTTP request method", "HTTP 请求方法")}>
                  <button type="button" className={alertWebhookMethod === "POST" ? "active" : undefined} aria-pressed={alertWebhookMethod === "POST"} onClick={() => setAlertWebhookMethod("POST")}>POST</button>
                  <button type="button" className={alertWebhookMethod === "GET" ? "active" : undefined} aria-pressed={alertWebhookMethod === "GET"} onClick={() => setAlertWebhookMethod("GET")}>GET</button>
                </div>
                <label><span>{chartText("Request URL", "请求地址")}</span><input value={alertWebhookUrl} maxLength={2048} placeholder="https://example.com/trading-alert" onChange={(event) => setAlertWebhookUrl(event.target.value)} /></label>
                <details>
                  <summary><Braces size={12} />{chartText("Notification request example", "通知请求样例")}</summary>
                  <pre>{webhookRequestSample}</pre>
                </details>
              </div>
            ) : null}

            {alertFormError ? <p className="chart-alert-form-error" role="alert">{alertFormError}</p> : null}
            <button className="chart-alert-create" type="submit">
              <Plus size={14} />{chartText("Create alert", "创建提醒")}
            </button>
          </form>
          <div className="chart-alert-active-list">
            <div className="chart-alert-active-heading">
              <strong>{chartText("Active alerts", "活动提醒")}</strong>
              <span>{activePriceAlerts.length + activeIndicatorAlerts.length}</span>
            </div>
            {activePriceAlerts.length === 0 && activeIndicatorAlerts.length === 0 ? (
              <p>{chartText("No active alerts", "暂无活动提醒")}</p>
            ) : (
              <>
                {activePriceAlerts.map((alert) => (
                  <div className="chart-alert-active-row" key={alert.id}>
                    <span className={clsx("chart-alert-direction-mark", `direction-${alert.direction}`)}>{formatAlertDirection(alert.direction)}</span>
                    <strong data-i18n-skip="true">{alert.name || formatChartNumber(alert.price)}<em>{formatChartNumber(alert.price)}</em></strong>
                    <small>{alert.source === "script" ? chartText("Script", "脚本") : alert.source === "ai" ? "AI" : chartText("Price", "价格")}</small>
                    <button type="button" title={chartText("Delete alert", "删除提醒")} aria-label={chartText(`Delete alert ${formatChartNumber(alert.price)}`, `删除提醒 ${formatChartNumber(alert.price)}`)} onClick={() => removePriceAlert(alert)}><Trash2 size={13} /></button>
                  </div>
                ))}
                {activeIndicatorAlerts.map((alert) => (
                  <div className="chart-alert-active-row indicator" key={alert.id}>
                    <span className="chart-alert-direction-mark direction-cross">{chartText("Indicator", "指标")}</span>
                    <strong data-i18n-skip="true">{alert.name}<em>{alert.condition}</em></strong>
                    <small>{alert.frequency === "repeat" ? chartText("Repeat", "重复") : chartText("Once", "一次")}</small>
                    <button type="button" title={chartText("Delete alert", "删除提醒")} aria-label={chartText(`Delete alert ${alert.name}`, `删除提醒 ${alert.name}`)} onClick={() => removeIndicatorAlert(alert)}><Trash2 size={13} /></button>
                  </div>
                ))}
              </>
            )}
          </div>
        </section>
      )}
      {alertLineOverlays.map(({ alert, y }) => (
        <div
          className={clsx("chart-alert-line-label", alert.source === "script" && "script", `direction-${alert.direction}`)}
          data-alert-source={alert.source ?? "manual"}
          style={{ top: y }}
          key={alert.id}
        >
          <span>{alert.source === "script" ? `${chartText("Script", "脚本")} ` : ""}{formatAlertDirection(alert.direction)} {formatChartNumber(alert.price)}</span>
          <button
            type="button"
            className="chart-alert-line-remove"
            title={chartText("Delete alert line", "删除提醒线")}
            aria-label={chartText(`Delete alert line ${formatChartNumber(alert.price)}`, `删除提醒线 ${formatChartNumber(alert.price)}`)}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => removePriceAlert(alert)}
          >
            <X size={12} />
          </button>
        </div>
      ))}
      {!reviewVariant && <div className="chart-guide-top" title={chartText("Drag down to create a horizontal line", "向下拖拽创建水平线")} onPointerDown={(event) => startGuideDrag("horizontal", event)} />}
      {!reviewVariant && <div className="chart-guide-left" title={chartText("Drag right to create a vertical line", "向右拖拽创建垂直线")} onPointerDown={(event) => startGuideDrag("vertical", event)} />}
      <div
        className={clsx(
          "chart-canvas",
          (measureMode || drawMode) && "measure-active",
          hoveringEditableOrderLine && "hover-editable-order-line",
          hoveringPositionHandle && "hover-position-handle",
          draggingOrderLine && "dragging-order-line",
          draggingPositionLine && "dragging-position-line",
          guideDrag && "guide-dragging"
        )}
        ref={containerRef}
        onWheel={() => setAutoFit(false)}
        onContextMenu={(event) => {
          if (measureMode || drawMode || pendingDrawPoint) {
            handleCanvasContextMenu(event);
            return;
          }
          if (reviewVariant || drawMode || measureMode) return;
          const chart = chartRef.current;
          const box = containerRef.current?.getBoundingClientRect();
          if (!chart || !box) return;
          const paneId = chart.paneAtCoordinate(event.clientY - box.top);
          if (paneId && paneId !== MAIN_CHART_PANE_ID) {
            event.preventDefault();
            setChartContextMenu(null);
            const matching = indicatorInstances.filter((item) => item.paneId === paneId).map((item) => item.id);
            setIndicatorContextMenu(matching.length ? {
              x: Math.min(box.width - 210, Math.max(8, event.clientX - box.left)),
              y: Math.min(box.height - 84, Math.max(8, event.clientY - box.top)),
              indicatorIds: matching,
            } : null);
            return;
          }
          const price = Number(chart.coordinateToPrice(event.clientY - box.top));
          if (!Number.isFinite(price) || price <= 0) return;
          event.preventDefault();
          setIndicatorContextMenu(null);
          setChartContextMenu({
            x: Math.min(box.width - 260, Math.max(8, event.clientX - box.left)),
            y: Math.min(box.height - 150, Math.max(8, event.clientY - box.top)),
            price,
          });
        }}
        onPointerDown={handleChartPointerDown}
        onPointerMove={(event) => {
          handleChartPointerHover(event);
          handleChartPointerMove(event);
        }}
        onPointerLeave={() => {
          setHoveringEditableOrderLine(false);
          setHoveringPositionHandle(false);
          setFillTooltip(null);
        }}
        onPointerUp={(event) => finishOrderLineDrag(event)}
        onPointerCancel={(event) => finishOrderLineDrag(event, true)}
      />
      {cancellableOrderLineOverlays.length > 0 && (
        <div className="chart-order-cancel-layer" aria-label={chartText("Chart order cancellation controls", "图表委托撤单入口")}>
          {cancellableOrderLineOverlays.map(({ line, y }) => (
            <div
              key={line.id}
              className={clsx("chart-order-cancel-label", line.tone)}
              style={{ top: y }}
            >
              <span title={line.label}>{line.label}</span>
              <button
                type="button"
                title={t("chart:cancelOrderLine", { label: line.label })}
                aria-label={t("chart:cancelOrderLine", { label: line.label })}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOrderLineCancelRef.current?.(line);
                }}
              >
                <X size={10} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
      {chartContextMenu && (
        <div className="chart-context-menu" style={{ left: chartContextMenu.x, top: chartContextMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <strong>{formatChartNumber(chartContextMenu.price)} USDT</strong>
          <button type="button" className="long" onClick={() => {
            onChartContextTradeRef.current?.({ action: "long", orderType: "limit", price: chartContextMenu.price, symbol });
            setChartContextMenu(null);
          }}>{t("chart:limitLongAt", { symbol, price: formatChartNumber(chartContextMenu.price) })}</button>
          <button type="button" className="short" onClick={() => {
            onChartContextTradeRef.current?.({ action: "short", orderType: "limit", price: chartContextMenu.price, symbol });
            setChartContextMenu(null);
          }}>{t("chart:limitShortAt", { symbol, price: formatChartNumber(chartContextMenu.price) })}</button>
          <button type="button" onClick={() => {
            onChartContextTradeRef.current?.({ action: "long", orderType: "market", price: chartContextMenu.price, symbol });
            setChartContextMenu(null);
          }}>{t("chart:marketLong")}</button>
          <button type="button" onClick={() => {
            onChartContextTradeRef.current?.({ action: "short", orderType: "market", price: chartContextMenu.price, symbol });
            setChartContextMenu(null);
          }}>{t("chart:marketShort")}</button>
          {positionRanges.some((range) => range.posSide === "long" && Number(range.size) > 0) && <>
            <button type="button" className="short" onClick={() => {
              onChartContextTradeRef.current?.({ action: "close-long", orderType: "limit", price: chartContextMenu.price, symbol });
              setChartContextMenu(null);
            }}>{t("chart:limitCloseLongAt", { price: formatChartNumber(chartContextMenu.price) })}</button>
            <button type="button" onClick={() => {
              onChartContextTradeRef.current?.({ action: "close-long", orderType: "market", price: chartContextMenu.price, symbol });
              setChartContextMenu(null);
            }}>{t("chart:marketCloseLong")}</button>
          </>}
          {positionRanges.some((range) => range.posSide === "short" && Number(range.size) > 0) && <>
            <button type="button" className="long" onClick={() => {
              onChartContextTradeRef.current?.({ action: "close-short", orderType: "limit", price: chartContextMenu.price, symbol });
              setChartContextMenu(null);
            }}>{t("chart:limitCloseShortAt", { price: formatChartNumber(chartContextMenu.price) })}</button>
            <button type="button" onClick={() => {
              onChartContextTradeRef.current?.({ action: "close-short", orderType: "market", price: chartContextMenu.price, symbol });
              setChartContextMenu(null);
            }}>{t("chart:marketCloseShort")}</button>
          </>}
          <button type="button" onClick={() => {
            const last = Number(livePrice);
            const alert: PriceAlert = {
              id: `price-alert-${Date.now()}-${Math.random().toString(16).slice(2)}`,
              price: chartContextMenu.price,
              direction: Number.isFinite(last) && chartContextMenu.price < last ? "below" : "above",
              createdAt: Date.now(),
              triggered: false,
              source: "manual",
              name: t("chart:contextAlertName", { symbol }),
            };
            setPriceAlerts((items) => [alert, ...items].slice(0, 8));
            onCreateChartAlert?.({
              id: alert.id,
              symbol,
              definition: {
                kind: "price",
                instId: symbol,
                price: alert.price,
                direction: alert.direction,
                cooldownSeconds: 60,
                frequency: "once",
                notifyApp: true,
                notifyFeishu: false,
                webhook: null,
                conditionLabel: t(alert.direction === "above" ? "chart:lastPriceAbove" : "chart:lastPriceBelow", { price: formatChartNumber(alert.price) }),
                name: alert.name ?? ""
              }
            });
            setLayerVisibility((items) => ({ ...items, alerts: true }));
            setChartContextMenu(null);
          }}>{t("chart:createAlertAt", { price: formatChartNumber(chartContextMenu.price) })}</button>
        </div>
      )}
      {indicatorContextMenu && (
        <div className="chart-context-menu chart-context-menu--indicator" style={{ left: indicatorContextMenu.x, top: indicatorContextMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <strong>{t("chart:indicatorActions")}</strong>
          {indicatorContextMenu.indicatorIds.map((id) => {
            const item = indicatorInstances.find((candidate) => candidate.id === id);
            if (!item) return null;
            const definition = INDICATOR_DEFINITIONS[item.definitionId];
            return <button type="button" key={id} onClick={() => {
              handleIndicatorInstancesChange(indicatorInstances.filter((candidate) => candidate.id !== id));
              setIndicatorContextMenu(null);
            }}>{t("chart:removeIndicator", { name: definition.name })}</button>;
          })}
        </div>
      )}
      {draggingOrderLine && (
        <div className="chart-order-drag-readout" style={{ top: Math.max(84, draggingOrderLine.y - 16) }}>
          <strong>{orderLineDragTitle(draggingOrderLine.line)}</strong>
          <span>{t("chart:newPrice", { price: formatChartNumber(draggingOrderLine.price) })}</span>
          {orderLineDragEstimate(draggingOrderLine.line, draggingOrderLine.price) && (
            <em className={Number(orderLineDragEstimate(draggingOrderLine.line, draggingOrderLine.price)?.pnl) >= 0 ? "positive" : "negative"}>
              {formatOrderLineDragEstimate(draggingOrderLine.line, draggingOrderLine.price)}
            </em>
          )}
        </div>
      )}
      {draggingPositionLine && (
        <>
          <div className="chart-position-target-line" style={{ top: draggingPositionLine.y }}>
            <span>{positionIntentLabel(draggingPositionLine.range, draggingPositionLine.price, draggingPositionLine.snapToMarket)}</span>
          </div>
          <div className="chart-order-drag-readout position-intent" style={{ top: Math.max(84, draggingPositionLine.y - 16) }}>
            <strong>{positionIntentLabel(draggingPositionLine.range, draggingPositionLine.price, draggingPositionLine.snapToMarket)}</strong>
            <span>{formatChartNumber(draggingPositionLine.price)}</span>
          </div>
        </>
      )}
      {fillTooltip && (
        <div
          className={clsx(
            "chart-fill-tooltip",
            chartTradeVisual(resolveChartTradeAction(fillTooltip.marker)).buyLike ? "buy-action" : "sell-action"
          )}
          style={{ left: fillTooltip.x, top: fillTooltip.y }}
        >
          <strong>
            {localizedTradeAction(resolveChartTradeAction(fillTooltip.marker))}
            {Number(fillTooltip.marker.groupCount) > 1 ? ` ×${fillTooltip.marker.groupCount}` : ""}
          </strong>
          {Number(fillTooltip.marker.groupCount) > 1 && (
            <span>{chartText("Aggregated executions", "合并成交")} {fillTooltip.marker.groupCount}</span>
          )}
          <span>{t("common:price")} {formatChartNumber(fillTooltip.marker.price)}</span>
          <span>{t("common:quantity")} {fillTooltip.marker.size || "--"} {t("trading:contracts")}</span>
          {fillTooltip.marker.pnl !== null && fillTooltip.marker.pnl !== undefined && String(fillTooltip.marker.pnl).trim() !== "" && (
            <span>{t("trading:pnl")} {formatChartNumber(Number(fillTooltip.marker.pnl))} USDT</span>
          )}
          <span>
            {t("common:time")} {formatShanghaiChartTimestamp(fillTooltip.marker.groupStartTime ?? fillTooltip.marker.time, true)}
          </span>
          {Number(fillTooltip.marker.groupCount) > 1
            && fillTooltip.marker.groupEndTime
            && fillTooltip.marker.groupEndTime !== fillTooltip.marker.groupStartTime && (
              <span>
                {chartText("Through", "至")} {formatShanghaiChartTimestamp(fillTooltip.marker.groupEndTime, true)}
              </span>
            )}
        </div>
      )}
      {layerVisibility.fills && fillMarkerOverlays.length > 0 && (
        <div className="chart-fill-hit-layer">
          {fillMarkerOverlays.map((item) => (
            <span
              className="chart-fill-hit-target"
              key={item.marker.id}
              data-fill-action={localizedTradeAction(resolveChartTradeAction(item.marker))}
              role="button"
              tabIndex={0}
              aria-label={chartText(
                `View ${localizedTradeAction(resolveChartTradeAction(item.marker))} execution details`,
                `查看${localizedTradeAction(resolveChartTradeAction(item.marker))}成交详情`
              )}
              style={{ left: item.x, top: item.y }}
              onPointerEnter={() => {
                const position = fillTooltipPosition(item.x, item.y);
                setFillTooltipPinned(false);
                setFillTooltip({
                  marker: item.marker,
                  ...position
                });
              }}
              onPointerLeave={() => {
                if (!fillTooltipPinned) setFillTooltip(null);
              }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setFillTooltipPinned(true);
                const position = fillTooltipPosition(item.x, item.y);
                setFillTooltip({
                  marker: item.marker,
                  ...position
                });
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setFillTooltipPinned(false);
                  setFillTooltip(null);
                  return;
                }
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                setFillTooltipPinned(true);
                setFillTooltip({ marker: item.marker, ...fillTooltipPosition(item.x, item.y) });
              }}
            />
          ))}
        </div>
      )}
      {positionRangeOverlays.length > 0 && (
        <div className="chart-position-range-layer" aria-label={chartText("Current position chart markers", "当前持仓图表标记")}>
          {positionRangeOverlays.map((range) => {
            const top = Math.min(range.yEntry, range.yCurrent);
            const height = Math.max(2, Math.abs(range.yCurrent - range.yEntry));
            return (
              <div className={clsx("chart-position-range", range.tone)} key={range.id}>
                <span className="chart-position-range-band" style={{ top, height }} />
                <span className="chart-position-range-line entry" style={{ top: range.yEntry }} />
                <span className="chart-position-range-line current" style={{ top: range.yCurrent }} />
                <span className="chart-position-drag-handle" style={{ top: range.yHandle }} title={chartText("Drag to set take profit, stop loss, or close", "拖拽快速设置止盈止损或平仓")}>
                  <b>{chartText("Trade", "交易")}</b>
                  <em>{chartText("Drag to close / set TP or SL", "拖拽平仓/止盈止损")}</em>
                </span>
                <span className="chart-position-range-label" style={{ top: Math.max(66, top + Math.min(height, 18) / 2 - 8) }}>
                  <span>{range.label}</span>
                  {onPositionLineCloseRequest && (
                    <button
                      type="button"
                      title={chartText("Quick close", "快速平仓")}
                      aria-label={chartText(`Quick close ${range.range.label}`, `快速平仓 ${range.range.label}`)}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        const intent = buildPositionLineIntent(range.range, range.range.currentPrice);
                        if (intent) onPositionLineCloseRequestRef.current?.({ ...intent, kind: "limit_close" });
                      }}
                    >
                      <X size={10} aria-hidden="true" />
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {layerVisibility.drawings && drawingOverlays.length > 0 && (
        <svg className={clsx("chart-drawing-layer", drawMode && "drawing-in-progress")}>
          {drawingOverlays.map((line) => (
            <DrawingOverlayShape
              key={line.id}
              line={line}
              onSelect={(event) => {
                event.preventDefault();
                event.stopPropagation();
                clearActiveDrawingTool();
                setSelectedDrawingId(line.id);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (drawMode || measureMode) {
                  clearActiveDrawingTool();
                  return;
                }
                clearActiveDrawingTool();
                const box = containerRef.current?.getBoundingClientRect();
                setSelectedDrawingId(line.id);
                setDrawingMenu({ id: line.id, x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) });
              }}
              onStartDrag={startDrawingDrag}
            />
          ))}
        </svg>
      )}
      {layerVisibility.indicators && (scriptOverlays.hlines.length > 0 || scriptOverlays.bands.length > 0 || scriptOverlays.markers.length > 0) && (
        <svg className="chart-script-layer" aria-hidden="true">
          {scriptOverlays.bands.map((band) => <polygon key={band.id} points={band.points} fill={band.color} />)}
          {scriptOverlays.hlines.map((line) => <line key={line.id} x1="0" x2="100%" y1={line.y} y2={line.y} stroke={line.color} strokeWidth={line.width} strokeDasharray={line.dashed ? "7 5" : undefined} />)}
          {scriptOverlays.markers.map((marker) => (
            <g key={marker.id} transform={`translate(${marker.x} ${marker.y})`} className={marker.kind === "label" ? "script-label" : "script-marker"}>
              <circle r={marker.kind === "label" ? 5 : 4} fill={marker.color} />
              {marker.text && <text x="8" y="4">{marker.text}</text>}
            </g>
          ))}
        </svg>
      )}
      {layerVisibility.tools && measureOverlay && measureStats && (
        <svg className="chart-measure-layer" aria-hidden="true">
          <line x1={measureOverlay.x1} y1={measureOverlay.y1} x2={measureOverlay.x2} y2={measureOverlay.y2} />
          <circle cx={measureOverlay.x1} cy={measureOverlay.y1} r="4" />
          <circle cx={measureOverlay.x2} cy={measureOverlay.y2} r="4" />
        </svg>
      )}
      {layerVisibility.tools && measureStats ? (
        <div className={clsx("chart-measure-readout", measureStats.delta >= 0 ? "up" : "down")}>
          <strong>{measureStats.delta >= 0 ? "+" : ""}{formatChartNumber(measureStats.delta)}</strong>
          <span>{measureStats.deltaPercent >= 0 ? "+" : ""}{measureStats.deltaPercent.toFixed(2)}%</span>
          <span>{chartText(`${measureStats.bars} bars`, `${measureStats.bars} 根`)} / {formatDuration(measureStats.seconds)}</span>
        </div>
      ) : layerVisibility.tools && selectedDrawingId ? (
        <div className="chart-measure-readout pending">{chartText("Drag to edit, Shift snaps to OHLC, Delete removes, Ctrl+Z undoes", "拖动编辑，Shift 吸附 OHLC，Delete 删除，Ctrl+Z 撤销")}</div>
      ) : layerVisibility.tools && measureMode ? (
        <div className="chart-measure-readout pending">{chartText("Select two points to measure; Shift snaps to OHLC", "点击两点测距，Shift 吸附 OHLC")}</div>
      ) : layerVisibility.tools && drawMode ? (
        <div className="chart-measure-readout pending">{pendingDrawPoint ? chartText(`Select an endpoint to finish ${drawingToolLabel(drawingTool)}`, `选择终点完成${drawingToolLabel(drawingTool)}`) : chartText(`Select a start point for ${drawingToolLabel(drawingTool)}; Shift snaps to OHLC`, `选择起点开始${drawingToolLabel(drawingTool)}，Shift 吸附 OHLC`)}</div>
      ) : null}
      {drawingMenu && selectedDrawingId && (
        <div
          className="chart-context-menu chart-drawing-menu"
          style={{ left: drawingMenu.x, top: drawingMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {(() => {
            const selected = drawingLines.find((line) => line.id === selectedDrawingId);
            if (!selected || !isRiskRewardTool(selected.tool) || !selected.stop || !onRiskRewardTradeIntentRef.current) return null;
            const sideLabel = selected.tool === "long-position" ? chartText("long", "做多") : chartText("short", "做空");
            return (
              <div className="chart-risk-reward-actions">
                <span>{chartText(`${sideLabel} plan · Entry`, `${sideLabel}计划 · 开仓`)} {formatChartNumber(selected.start.price)}</span>
                <button type="button" className={selected.tool === "long-position" ? "risk-long" : "risk-short"} onClick={() => dispatchRiskRewardTradeIntent(selected, "entry")}>
                  {chartText(`Place limit ${sideLabel} at entry`, `以开仓价限价${sideLabel}`)}
                </button>
                <button type="button" onClick={() => dispatchRiskRewardTradeIntent(selected, "bracket")}>
                  {chartText("Open with take profit and stop loss", "开仓并挂止盈止损")}
                </button>
              </div>
            );
          })()}
          <button type="button" onClick={() => { duplicateSelectedDrawing(); setDrawingMenu(null); }}>{chartText("Duplicate", "复制")}</button>
          <button type="button" onClick={() => { updateSelectedDrawing((line) => ({ ...line, locked: !line.locked })); setDrawingMenu(null); }}>
            {drawingLines.find((line) => line.id === selectedDrawingId)?.locked ? chartText("Unlock", "解锁") : chartText("Lock", "锁定")}
          </button>
          <button type="button" onClick={() => { updateSelectedDrawing((line) => ({ ...line, hidden: true })); setDrawingMenu(null); setSelectedDrawingId(null); }}>{chartText("Hide", "隐藏")}</button>
          <div className="chart-drawing-menu-swatches">
            {["#67e8f9", "#b792ff", "#f5a524", "#0ecb81", "#f6465d"].map((color) => (
              <button
                type="button"
                key={color}
                className="swatch"
                style={{ backgroundColor: color }}
                aria-label={chartText(`Color ${color}`, `颜色 ${color}`)}
                onClick={() => { updateSelectedDrawing((line) => ({ ...line, color })); setDrawingMenu(null); }}
              />
            ))}
          </div>
          <div className="chart-drawing-menu-row">
            {(["solid", "dashed", "dotted"] as const).map((style) => (
              <button type="button" key={style} onClick={() => { updateSelectedDrawing((line) => ({ ...line, lineStyle: style })); setDrawingMenu(null); }}>
                {style === "solid" ? chartText("Solid", "实线") : style === "dashed" ? chartText("Dashed", "虚线") : chartText("Dotted", "点线")}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="danger"
            disabled={Boolean(drawingLines.find((line) => line.id === selectedDrawingId)?.locked)}
            onClick={() => {
              const targetId = selectedDrawingId;
              commitDrawingLines((items) => items.filter((item) => item.id !== targetId));
              setSelectedDrawingId(null);
              setDrawingMenu(null);
            }}
          >
            {chartText("Delete", "删除")}
          </button>
        </div>
      )}
    </div>
  );
}

function syncManagedIndicators({
  chart,
  candles,
  patch,
  instances,
  configSignature,
  calculators,
  seriesKeys,
  previousConfigSignature,
  layersVisible,
  hoverValues,
  onUnavailableChange
}: {
  chart: TradingChartHandle;
  candles: readonly Candle[];
  patch: ChartDataPatch;
  instances: readonly IndicatorInstance[];
  configSignature: string;
  calculators: Map<string, ReturnType<typeof createIndicatorCalculator>>;
  seriesKeys: Set<string>;
  previousConfigSignature: { current: string };
  layersVisible: boolean;
  hoverValues: { current: Map<number, HoverIndicatorValue[]> };
  onUnavailableChange: (updater: (previous: Set<string>) => Set<string>) => void;
}) {
  const configurationChanged = previousConfigSignature.current !== configSignature;
  if (configurationChanged) {
    for (const key of seriesKeys) chart.removeIndicator(key);
    seriesKeys.clear();
    calculators.clear();
    previousConfigSignature.current = configSignature;
  }

  const nextSeriesKeys = new Set<string>();
  const desiredPaneIds = new Set<string>();
  const unavailable = new Set<string>();
  const nextHoverValues = new Map<number, HoverIndicatorValue[]>();
  for (const instance of instances) {
    const definition = INDICATOR_DEFINITIONS[instance.definitionId];
    if (definition.pane === "sub") desiredPaneIds.add(instance.paneId);
    let calculator = calculators.get(instance.id);
    if (!calculator) {
      calculator = createIndicatorCalculator(instance);
      calculators.set(instance.id, calculator);
    }
    const result: IndicatorResult = configurationChanged || patch.type === "reset" || patch.type === "prepend"
      ? calculator.reset({ candles })
      : calculator.applyPatch(toIndicatorPatch(patch));
    if (result.status === "unavailable") unavailable.add(instance.id);
    if (definition.pane === "sub") chart.ensurePane({ id: instance.paneId, height: 150 });
    if (result.status !== "ready") continue;
    result.series.forEach((output, outputIndex) => {
      const key = managedIndicatorSeriesKey(instance.id, output.key);
      nextSeriesKeys.add(key);
      const outputIsHistogram = output.key === "histogram" || (instance.definitionId === "volume-ma" && output.key === "volume");
      const config = {
        key,
        paneId: definition.pane === "main" ? "main" : instance.paneId,
        type: outputIsHistogram ? "histogram" as const : "line" as const,
        color: indicatorColor(instance.definitionId, outputIndex),
        lineWidth: instance.definitionId === "vwap" || instance.definitionId === "boll" ? 2 as const : 1 as const,
        visible: layersVisible && instance.visible,
        priceLineVisible: false,
        lastValueVisible: false
      };
      if (layersVisible && instance.visible) {
        for (const point of output.points) {
          const values = nextHoverValues.get(point.time) ?? [];
          values.push({ id: key, label: output.label, value: point.value, color: config.color });
          nextHoverValues.set(point.time, values);
        }
      }
      const canUpdateLatest = !configurationChanged
        && (patch.type === "updateLatest" || (patch.type === "append" && patch.candles.length === 1));
      const latest = output.points[output.points.length - 1];
      if (canUpdateLatest && latest) chart.updateIndicatorLatest(key, latest);
      else chart.setIndicatorData(config, output.points.map((point) => ({ ...point, ...(outputIsHistogram ? { color: config.color } : {}) })));
    });
  }
  for (const key of seriesKeys) {
    if (!nextSeriesKeys.has(key)) chart.removeIndicator(key);
  }
  seriesKeys.clear();
  for (const key of nextSeriesKeys) seriesKeys.add(key);
  for (const pane of chart.listPanes()) {
    if (pane.id !== "main" && !pane.id.startsWith(CHART_SCRIPT_PANE_PREFIX) && !desiredPaneIds.has(pane.id)) chart.removePane(pane.id);
  }
  hoverValues.current = nextHoverValues;
  onUnavailableChange((previous) => setsEqual(previous, unavailable) ? previous : unavailable);
}

function toIndicatorPatch(patch: ChartDataPatch) {
  if (patch.type === "reset") return { type: "reset" as const, candles: patch.candles };
  if (patch.type === "append") return { type: "append" as const, candles: patch.candles };
  if (patch.type === "prepend") return { type: "prepend" as const, candles: patch.candles };
  if (patch.type === "updateLatest") return { type: "updateLatest" as const, candle: patch.candle };
  return { type: "noChange" as const };
}

function managedIndicatorSeriesKey(instanceId: string, outputKey: string) {
  return `managed:${instanceId}:${outputKey}`;
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function buildWorkspacePaneLayout(instances: readonly IndicatorInstance[]) {
  const panes = new Map<string, { id: string; kind: "main" | "indicator"; indicatorIds: string[] }>();
  panes.set("main", { id: "main", kind: "main", indicatorIds: [] });
  for (const instance of instances) {
    const definition = INDICATOR_DEFINITIONS[instance.definitionId];
    const paneId = definition.pane === "main" ? "main" : instance.paneId;
    const pane = panes.get(paneId) ?? { id: paneId, kind: "indicator" as const, indicatorIds: [] };
    pane.indicatorIds.push(instance.id);
    panes.set(paneId, pane);
  }
  return [...panes.values()];
}

function parseWorkspaceIndicators(value: unknown): IndicatorInstance[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { instances?: unknown }).instances)) return [];
  const known = new Set(Object.keys(INDICATOR_DEFINITIONS));
  return (value as { instances: unknown[] }).instances.flatMap((item): IndicatorInstance[] => {
    if (!item || typeof item !== "object") return [];
    const source = item as Partial<IndicatorInstance>;
    if (typeof source.id !== "string" || typeof source.paneId !== "string" || typeof source.visible !== "boolean" || typeof source.definitionId !== "string" || !known.has(source.definitionId)) return [];
    return [{
      id: source.id,
      definitionId: source.definitionId as IndicatorInstance["definitionId"],
      paneId: source.paneId,
      visible: source.visible,
      parameters: source.parameters && typeof source.parameters === "object" ? { ...source.parameters } : {}
    }];
  });
}

function parseWorkspaceLayers(value: unknown): Record<ChartLayerKey, boolean> | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<Record<ChartLayerKey, unknown>>;
  const keys: ChartLayerKey[] = ["indicators", "alerts", "drawings", "signals", "fills", "tools"];
  if (!keys.every((key) => typeof source[key] === "boolean")) return null;
  return Object.fromEntries(keys.map((key) => [key, Boolean(source[key])])) as Record<ChartLayerKey, boolean>;
}

function calculateOrderBookPressure(orderBook: OrderBook | null, recentTrades: Trade[]): ChartScriptOrderBookPressure | null {
  if (!orderBook || orderBook.bids.length === 0 || orderBook.asks.length === 0) return null;
  const bidVolume = orderBook.bids.slice(0, 10).reduce((sum, level) => sum + positiveNumber(level.sz), 0);
  const askVolume = orderBook.asks.slice(0, 10).reduce((sum, level) => sum + positiveNumber(level.sz), 0);
  const totalDepth = bidVolume + askVolume;
  const bidPercent = totalDepth > 0 ? bidVolume / totalDepth : 0.5;
  const askPercent = totalDepth > 0 ? askVolume / totalDepth : 0.5;
  const activeWindow = recentTrades.slice(0, 48);
  const buyTrades = activeWindow.filter((trade) => trade.side === "buy").length;
  const activeBuyRatio = activeWindow.length > 0 ? buyTrades / activeWindow.length : 0.5;
  const score = clamp((bidPercent - askPercent) * 0.65 + (activeBuyRatio - 0.5) * 0.7, -1, 1);
  return {
    bidPercent,
    askPercent,
    activeBuyRatio,
    score,
    label: score > 0.12 ? chartText("Buy-side dominant", "买盘占优") : score < -0.12 ? chartText("Sell-side dominant", "卖盘占优") : chartText("Balanced", "均衡"),
    updatedAt: Math.max(orderBook.ts || 0, ...activeWindow.map((trade) => trade.ts || 0))
  };
}

function positiveNumber(value: string | number | undefined) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function samePriceAlerts(left: PriceAlert[], right: PriceAlert[]) {
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const next = right[index];
    return Boolean(next)
      && item.id === next.id
      && item.price === next.price
      && item.direction === next.direction
      && item.triggered === next.triggered
      && item.source === next.source
      && item.scriptId === next.scriptId
      && item.scriptAlertId === next.scriptAlertId
      && item.name === next.name;
  });
}

function formatAlertDirection(direction: PriceAlert["direction"]) {
  if (direction === "above") return chartText("Crosses above", "上破");
  if (direction === "below") return chartText("Crosses below", "下破");
  return chartText("Crosses", "穿越");
}

function normalizeAlertOperator(value: unknown): AlertOperator {
  if (value === "crossingBelow" || value === "crossing" || value === "greaterThan" || value === "lessThan") return value;
  return "crossingAbove";
}

function alertOperatorLabel(operator: AlertOperator) {
  if (operator === "crossingAbove") return chartText("crosses above", "上穿");
  if (operator === "crossingBelow") return chartText("crosses below", "下穿");
  if (operator === "crossing") return chartText("crosses", "穿越");
  if (operator === "greaterThan") return chartText("is greater than", "大于");
  return chartText("is less than", "小于");
}

function normalizeAlertExpiry(value: unknown): AlertExpiry {
  if (value === "day" || value === "week" || value === "month") return value;
  return "never";
}

function chartAlertExpiresAt(expiry: AlertExpiry) {
  if (expiry === "never") return null;
  const days = expiry === "day" ? 1 : expiry === "week" ? 7 : 30;
  return Date.now() + days * 86_400_000;
}

function validateChartAlertWebhook(value: string) {
  const raw = value.trim();
  if (!raw) return chartText("Enter an HTTP request URL", "请输入 HTTP 请求地址");
  if (raw.length > 2048) return chartText("The HTTP request URL cannot exceed 2048 characters", "HTTP 请求地址不能超过 2048 个字符");
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return chartText("Only http:// or https:// URLs are supported", "HTTP 请求地址只支持 http:// 或 https://");
    if (url.username || url.password) return chartText("The HTTP request URL cannot contain a username or password", "HTTP 请求地址不能包含用户名或密码");
    if (url.hash) return chartText("The HTTP request URL cannot contain a URL fragment", "HTTP 请求地址不能包含 URL fragment");
    return "";
  } catch {
    return chartText("The HTTP request URL is invalid", "HTTP 请求地址格式不正确");
  }
}

function chartAlertWebhookSample(
  method: "GET" | "POST",
  value: string,
  symbol: string,
  name: string,
  conditionKind: "price" | "indicator",
  direction: PriceAlert["direction"]
) {
  const url = value.trim() || "https://example.com/trading-alert";
  const message = conditionKind === "indicator"
    ? chartText(`${symbol}: MA 5 crossed above 65,000; current 65,012.7; reference 65,000.`, `${symbol}：MA 5 上穿 65,000，当前值 65,012.7，参考值 65,000。`)
    : chartText(`${symbol}: Last price crossed above 64,134.3; current 64,150.2; reference 64,134.3.`, `${symbol}：最新价上破 64,134.3，当前值 64,150.2，参考值 64,134.3。`);
  if (method === "GET") {
    const separator = url.includes("?") ? "&" : "?";
    return `GET ${url}${separator}event=chart.alert.triggered&alertId=chart-alert-...&name=${encodeURIComponent(name.trim() || chartText("BTC trend confirmation", "BTC 趋势确认"))}&symbol=${encodeURIComponent(symbol)}&conditionKind=${conditionKind}&direction=${direction}&message=${encodeURIComponent(message)}&value=64150.2&referenceValue=64134.3&triggeredAt=1784965800000`;
  }
  return `POST ${url}\nContent-Type: application/json\n\n${JSON.stringify({
    event: "chart.alert.triggered",
    alertId: "chart-alert-...",
    name: name.trim() || chartText("BTC trend confirmation", "BTC 趋势确认"),
    symbol,
    conditionKind,
    direction,
    message,
    value: 64150.2,
    referenceValue: 64134.3,
    triggeredAt: "2026-07-25T10:30:00.000Z"
  }, null, 2)}`;
}

function mergeScriptOutputs(scripts: ChartScriptDefinition[], states: Record<string, ChartScriptRunState>): ChartScriptOutput {
  const merged = emptyChartScriptOutput();
  for (const script of scripts) {
    if (!script.enabled || script.hidden) continue;
    const output = states[script.id]?.output;
    if (!output) continue;
    merged.lines.push(...output.lines.map((item) => ({
      ...item,
      id: `${script.id}-${item.id}`,
      paneId: item.pane === "sub" ? `${CHART_SCRIPT_PANE_PREFIX}${script.id}` : MAIN_CHART_PANE_ID
    })));
    merged.hlines.push(...output.hlines.map((item) => ({ ...item, id: `${script.id}-${item.id}` })));
    merged.bands.push(...output.bands.map((item) => ({ ...item, id: `${script.id}-${item.id}` })));
    merged.markers.push(...output.markers.map((item) => ({ ...item, id: `${script.id}-${item.id}` })));
    merged.labels.push(...output.labels.map((item) => ({ ...item, id: `${script.id}-${item.id}` })));
    merged.alerts.push(...output.alerts);
  }
  return merged;
}

function chartScriptLineWidth(value?: number): 1 | 2 | 3 | 4 {
  const width = Math.round(Number(value));
  if (width >= 4) return 4;
  if (width === 3) return 3;
  if (width === 2) return 2;
  return 1;
}

function buildScriptOverlays(chart: TradingChartHandle, candles: Candle[], output: ChartScriptOutput): {
  lines: ScriptLineOverlay[];
  hlines: ScriptHLineOverlay[];
  bands: ScriptBandOverlay[];
  markers: ScriptMarkerOverlay[];
} {
  return {
    lines: output.lines.map((line) => {
      const d = line.points
        .map((point) => scriptPointToCoordinate(chart, candles, point.time, point.price))
        .filter((point): point is { x: number; y: number } => Boolean(point))
        .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
        .join(" ");
      return d ? { id: line.id, name: line.name, d, color: line.color ?? "#f5a524", width: line.width ?? 1 } : null;
    }).filter(Boolean) as ScriptLineOverlay[],
    hlines: output.hlines.map((line) => {
      const y = chart.priceToCoordinate(line.price);
      if (y === null) return null;
      return { id: line.id, name: line.name, y: Number(y), color: line.color ?? "#b792ff", width: line.width ?? 1, dashed: line.dashed };
    }).filter(Boolean) as ScriptHLineOverlay[],
    bands: output.bands.map((band) => {
      const upper = band.upper.map((point) => scriptPointToCoordinate(chart, candles, point.time, point.price)).filter((point): point is { x: number; y: number } => Boolean(point));
      const lower = band.lower.map((point) => scriptPointToCoordinate(chart, candles, point.time, point.price)).filter((point): point is { x: number; y: number } => Boolean(point)).reverse();
      if (upper.length < 2 || lower.length < 2) return null;
      return { id: band.id, name: band.name, points: [...upper, ...lower].map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" "), color: band.color ?? "rgba(103, 232, 249, 0.12)" };
    }).filter(Boolean) as ScriptBandOverlay[],
    markers: [
      ...output.markers.map((marker) => ({ ...marker, kind: "marker" as const })),
      ...output.labels.map((marker) => ({ ...marker, kind: "label" as const }))
    ].map((marker) => {
      const point = scriptPointToCoordinate(chart, candles, marker.time, marker.price);
      if (!point) return null;
      return { id: marker.id, x: point.x, y: point.y, text: marker.text, color: marker.color ?? "#67e8f9", kind: marker.kind };
    }).filter(Boolean) as ScriptMarkerOverlay[]
  };
}

function scriptPointToCoordinate(chart: TradingChartHandle, candles: Candle[], time: number, price: number) {
  const x = drawingTimeToCoordinate(chart, candles, time);
  const y = chart.priceToCoordinate(price);
  if (x === null || y === null) return null;
  return { x: Number(x), y: Number(y) };
}

function DrawingOverlayShape({
  line,
  onSelect,
  onContextMenu,
  onStartDrag
}: {
  line: DrawingOverlay;
  onSelect: (event: ReactPointerEvent<SVGGElement>) => void;
  onContextMenu: (event: React.MouseEvent<SVGGElement>) => void;
  onStartDrag: (id: string, handle: DrawingDrag["handle"], event: ReactPointerEvent<SVGElement>) => void;
}) {
  const left = Math.min(line.x1, line.x2);
  const top = Math.min(line.y1, line.y2);
  const width = Math.abs(line.x2 - line.x1);
  const height = Math.abs(line.y2 - line.y1);
  const className = clsx(`drawing-${line.tool}`, line.selected && "selected", line.locked && "locked");
  const previewProps = line.preview ? { className: clsx(className, "preview") } : { className, onPointerDown: onSelect, onContextMenu };
  const handle = (id: string, name: DrawingDrag["handle"]) => (event: ReactPointerEvent<SVGElement>) => onStartDrag(id, name, event);
  const strokeStyle = drawingSvgStyle(line);
  const canEdit = !line.preview && !line.locked;
  if (isRiskRewardTool(line.tool) && line.yStop !== undefined && line.entryPrice && line.targetPrice && line.stopPrice) {
    const entryY = line.y1;
    const targetY = line.y2;
    const stopY = line.yStop;
    const right = Math.max(line.x1, line.x2);
    const left = Math.min(line.x1, line.x2);
    const width = Math.max(26, right - left);
    const profitTop = Math.min(entryY, targetY);
    const profitHeight = Math.max(2, Math.abs(entryY - targetY));
    const riskTop = Math.min(entryY, stopY);
    const riskHeight = Math.max(2, Math.abs(entryY - stopY));
    const sideLabel = line.tool === "long-position" ? chartText("Long", "多头") : chartText("Short", "空头");
    const reward = Math.abs(line.targetPrice - line.entryPrice);
    const risk = Math.abs(line.entryPrice - line.stopPrice);
    const ratio = risk > 0 ? reward / risk : 0;
    return (
      <g {...previewProps} className={clsx(className, "drawing-risk-reward", line.tool, line.preview && "preview")}>
        {canEdit && <rect className="drawing-hit" x={left} y={Math.min(profitTop, riskTop)} width={width} height={Math.max(4, Math.max(profitTop + profitHeight, riskTop + riskHeight) - Math.min(profitTop, riskTop))} onPointerDown={handle(line.id, "body")} />}
        <rect className="risk-reward-target-zone" x={left} y={profitTop} width={width} height={profitHeight} rx="2" />
        <rect className="risk-reward-stop-zone" x={left} y={riskTop} width={width} height={riskHeight} rx="2" />
        <line className="risk-reward-target-line" x1={left} x2={left + width} y1={targetY} y2={targetY} />
        <line className="risk-reward-entry-line" x1={left} x2={left + width} y1={entryY} y2={entryY} />
        <line className="risk-reward-stop-line" x1={left} x2={left + width} y1={stopY} y2={stopY} />
        <text className="risk-reward-label target" x={left + 7} y={Math.max(14, targetY - 7)}>{chartText("Target", "目标")} {formatChartNumber(line.targetPrice)}</text>
        <text className="risk-reward-label entry" x={left + 7} y={entryY - 7}>{sideLabel} {chartText("entry", "开仓")} {formatChartNumber(line.entryPrice)} · {chartText("R/R", "盈亏比")} {ratio.toFixed(2)}</text>
        <text className="risk-reward-label stop" x={left + 7} y={Math.min(stopY + 14, Math.max(stopY + 14, 18))}>{chartText("Stop", "止损")} {formatChartNumber(line.stopPrice)}</text>
        {canEdit && (
          <>
            <circle className="drawing-handle-hit" cx={left} cy={entryY} r="11" onPointerDown={handle(line.id, "entry")} />
            <circle className="drawing-handle-hit" cx={left + width} cy={targetY} r="11" onPointerDown={handle(line.id, "target")} />
            <circle className="drawing-handle-hit" cx={left + width} cy={stopY} r="11" onPointerDown={handle(line.id, "stop")} />
            <circle className="drawing-handle risk-entry" cx={left} cy={entryY} r="5.25" onPointerDown={handle(line.id, "entry")} />
            <circle className="drawing-handle risk-target" cx={left + width} cy={targetY} r="5.25" onPointerDown={handle(line.id, "target")} />
            <circle className="drawing-handle risk-stop" cx={left + width} cy={stopY} r="5.25" onPointerDown={handle(line.id, "stop")} />
          </>
        )}
      </g>
    );
  }
  if (line.tool === "horizontal") {
    return (
      <g {...previewProps}>
        {canEdit && <line className="drawing-hit" x1="0" y1={line.y1} x2="100%" y2={line.y1} onPointerDown={handle(line.id, "body")} />}
        <line x1="0" y1={line.y1} x2="100%" y2={line.y1} style={strokeStyle} />
        {canEdit && <circle className="drawing-handle drawing-guide-handle" cx="14" cy={line.y1} r="4" onPointerDown={handle(line.id, "body")} />}
        <text x="23" y={line.y1 - 7}>{line.label}</text>
      </g>
    );
  }
  if (line.tool === "vertical") {
    return (
      <g {...previewProps}>
        {canEdit && <line className="drawing-hit" x1={line.x1} y1="0" x2={line.x1} y2="100%" onPointerDown={handle(line.id, "body")} />}
        <line x1={line.x1} y1="0" x2={line.x1} y2="100%" style={strokeStyle} />
        {canEdit && <circle className="drawing-handle drawing-guide-handle" cx={line.x1} cy="14" r="4" onPointerDown={handle(line.id, "body")} />}
        <text x={line.x1 + 8} y="25">{line.label}</text>
      </g>
    );
  }
  if (line.tool === "rect") {
    const [topLeft, topRight, bottomRight, bottomLeft] = line.rectPoints ?? [
      { x: left, y: top },
      { x: left + width, y: top },
      { x: left + width, y: top + height },
      { x: left, y: top + height }
    ];
    const topMid = midpoint(topLeft, topRight);
    const rightMid = midpoint(topRight, bottomRight);
    const bottomMid = midpoint(bottomLeft, bottomRight);
    const leftMid = midpoint(topLeft, bottomLeft);
    const polygonPoints = [topLeft, topRight, bottomRight, bottomLeft].map((point) => `${point.x},${point.y}`).join(" ");
    const centerStart = midpoint(topLeft, bottomLeft);
    const centerEnd = midpoint(topRight, bottomRight);
    return (
      <g {...previewProps}>
        {canEdit && <polygon className="drawing-hit" points={polygonPoints} onPointerDown={handle(line.id, "body")} />}
        <polygon points={polygonPoints} style={strokeStyle} onPointerDown={canEdit ? handle(line.id, "body") : undefined} />
        <line className="drawing-rect-centerline" x1={centerStart.x} y1={centerStart.y} x2={centerEnd.x} y2={centerEnd.y} />
        {canEdit && (
          <>
            <circle className="drawing-handle" data-drawing-handle="top-left" cx={topLeft.x} cy={topLeft.y} r="4" onPointerDown={handle(line.id, "top-left")} />
            <circle className="drawing-handle" data-drawing-handle="top-right" cx={topRight.x} cy={topRight.y} r="4" onPointerDown={handle(line.id, "top-right")} />
            <circle className="drawing-handle" data-drawing-handle="bottom-left" cx={bottomLeft.x} cy={bottomLeft.y} r="4" onPointerDown={handle(line.id, "bottom-left")} />
            <circle className="drawing-handle" data-drawing-handle="bottom-right" cx={bottomRight.x} cy={bottomRight.y} r="4" onPointerDown={handle(line.id, "bottom-right")} />
            <circle className="drawing-handle edge" data-drawing-handle="top" cx={topMid.x} cy={topMid.y} r="3.5" onPointerDown={handle(line.id, "top")} />
            <circle className="drawing-handle edge" data-drawing-handle="right" cx={rightMid.x} cy={rightMid.y} r="3.5" onPointerDown={handle(line.id, "right")} />
            <circle className="drawing-handle edge" data-drawing-handle="bottom" cx={bottomMid.x} cy={bottomMid.y} r="3.5" onPointerDown={handle(line.id, "bottom")} />
            <circle className="drawing-handle edge" data-drawing-handle="left" cx={leftMid.x} cy={leftMid.y} r="3.5" onPointerDown={handle(line.id, "left")} />
          </>
        )}
        <text x={topLeft.x + 8} y={Math.max(18, topLeft.y - 8)}>{line.label}</text>
      </g>
    );
  }
  if (line.tool === "ray") {
    const dx = line.x2 - line.x1;
    const dy = line.y2 - line.y1;
    const scale = dx === 0 && dy === 0 ? 1 : 4000 / Math.max(1, Math.hypot(dx, dy));
    const x2 = line.x1 + dx * scale;
    const y2 = line.y1 + dy * scale;
    return (
      <g {...previewProps}>
        {canEdit && <line className="drawing-hit" x1={line.x1} y1={line.y1} x2={x2} y2={y2} onPointerDown={handle(line.id, "body")} />}
        <line x1={line.x1} y1={line.y1} x2={x2} y2={y2} style={strokeStyle} />
        {canEdit && <circle className="drawing-handle" cx={line.x1} cy={line.y1} r="4" onPointerDown={handle(line.id, "start")} />}
        {canEdit && <circle className="drawing-handle" cx={line.x2} cy={line.y2} r="4" onPointerDown={handle(line.id, "end")} />}
        <text x={line.x1 + 8} y={line.y1 - 7}>{line.label}</text>
      </g>
    );
  }
  return (
    <g {...previewProps}>
      {canEdit && <line className="drawing-hit" x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} onPointerDown={handle(line.id, "body")} />}
      <line x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} style={strokeStyle} />
      {canEdit && <circle className="drawing-handle" cx={line.x1} cy={line.y1} r="4" onPointerDown={handle(line.id, "start")} />}
      {canEdit && <circle className="drawing-handle" cx={line.x2} cy={line.y2} r="4" onPointerDown={handle(line.id, "end")} />}
      <text x={line.x1 + 8} y={line.y1 - 7}>{line.label}</text>
    </g>
  );
}

function drawingToolLabel(tool: DrawingTool) {
  if (tool === "long-position") return chartText("long position", "多头仓位");
  if (tool === "short-position") return chartText("short position", "空头仓位");
  if (tool === "ray") return chartText("ray", "射线");
  if (tool === "horizontal") return chartText("horizontal line", "水平线");
  if (tool === "vertical") return chartText("vertical line", "垂直线");
  if (tool === "rect") return chartText("range", "区间");
  return chartText("trend line", "趋势线");
}

function drawingSvgStyle(line: DrawingOverlay): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (line.color) {
    style.stroke = line.color;
  }
  if (line.lineStyle === "solid") {
    style.strokeDasharray = "none";
  } else if (line.lineStyle === "dotted") {
    style.strokeDasharray = "2 5";
  } else if (line.lineStyle === "dashed") {
    style.strokeDasharray = "8 5";
  }
  return style;
}

function midpoint(first: DrawingOverlayPoint, second: DrawingOverlayPoint): DrawingOverlayPoint {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function currentBarSeconds(candles: Candle[]) {
  if (candles.length < 2) return 60;
  const last = candles[candles.length - 1].time;
  const previous = candles[candles.length - 2].time;
  const diff = last - previous;
  return Number.isFinite(diff) && diff > 0 ? diff : 60;
}

function coordinateToDrawingTime(chart: TradingChartHandle, candles: Candle[], x: number) {
  const direct = chart.coordinateToTime(x);
  if (Number.isFinite(direct)) return Number(direct);
  if (candles.length === 0) return null;
  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const lastX = chart.timeToCoordinate(last.time);
  if (lastX === null || x < Number(lastX)) return null;
  const barSeconds = currentBarSeconds(candles);
  const previousX = previous ? chart.timeToCoordinate(previous.time) : null;
  const barPixels = previousX === null ? 8 : Math.max(3, Number(lastX) - Number(previousX));
  const barsAhead = Math.max(0, Math.round((x - Number(lastX)) / barPixels));
  return last.time + barsAhead * barSeconds;
}

function drawingTimeToCoordinate(chart: TradingChartHandle, candles: Candle[], time: number) {
  const direct = chart.timeToCoordinate(time);
  if (direct !== null) return Number(direct);
  if (candles.length === 0) return null;
  const last = candles[candles.length - 1];
  if (time < last.time) return null;
  const lastX = chart.timeToCoordinate(last.time);
  if (lastX === null) return null;
  const previous = candles[candles.length - 2];
  const previousX = previous ? chart.timeToCoordinate(previous.time) : null;
  const barPixels = previousX === null ? 8 : Math.max(3, Number(lastX) - Number(previousX));
  const barsAhead = (time - last.time) / currentBarSeconds(candles);
  return Number(lastX) + barsAhead * barPixels;
}

function rectDrawingOverlayPoints(
  chart: TradingChartHandle,
  candles: Candle[],
  line: DrawingLine
): DrawingOverlay["rectPoints"] | null {
  const points = rectDrawingPoints(line);
  const converted = [points.topLeft, points.topRight, points.bottomRight, points.bottomLeft].map((point) => {
    const x = drawingTimeToCoordinate(chart, candles, point.time);
    const y = chart.priceToCoordinate(point.price);
    return x === null || y === null ? null : { x: Number(x), y: Number(y) };
  });
  if (converted.some((point) => point === null)) return null;
  return converted as [DrawingOverlayPoint, DrawingOverlayPoint, DrawingOverlayPoint, DrawingOverlayPoint];
}

function snapPointToOhlc(time: number, price: number, candleMap: Map<number, Candle>): MeasurePoint | null {
  const candle = candleMap.get(time);
  if (!candle) return null;
  const candidates = [candle.open, candle.high, candle.low, candle.close];
  let best = candidates[0];
  let bestDistance = Math.abs(price - best);
  for (const value of candidates.slice(1)) {
    const distance = Math.abs(price - value);
    if (distance < bestDistance) {
      best = value;
      bestDistance = distance;
    }
  }
  return { time, index: 0, price: best };
}

function moveHorizontalDrawing(line: DrawingLine, price: number): DrawingLine {
  return {
    ...line,
    start: { ...line.start, price },
    end: { ...line.end, price }
  };
}

function moveVerticalDrawing(line: DrawingLine, time: number): DrawingLine {
  return {
    ...line,
    start: { ...line.start, time },
    end: { ...line.end, time }
  };
}

function createRectDrawing(start: MeasurePoint, opposite: MeasurePoint, id = `drawing-${Date.now()}-${Math.random().toString(16).slice(2)}`): DrawingLine {
  return {
    id,
    tool: "rect",
    start,
    end: { ...opposite, price: start.price },
    stop: { ...start, price: opposite.price }
  };
}

function rectDrawingPoints(line: DrawingLine) {
  const topLeft = line.start;
  const topRight = line.stop ? line.end : { ...line.end, price: line.start.price };
  const bottomLeft = line.stop ?? { ...line.start, price: line.end.price };
  const bottomRight = {
    ...line.end,
    time: topRight.time + bottomLeft.time - topLeft.time,
    price: topRight.price + bottomLeft.price - topLeft.price
  };
  return { topLeft, topRight, bottomRight, bottomLeft };
}

function shiftDrawingPoint(point: MeasurePoint, timeDelta: number, priceDelta: number): MeasurePoint {
  return { ...point, time: point.time + timeDelta, price: point.price + priceDelta };
}

function drawingPointMidpoint(first: MeasurePoint, second: MeasurePoint): MeasurePoint {
  return {
    time: (first.time + second.time) / 2,
    index: Math.round((first.index + second.index) / 2),
    price: (first.price + second.price) / 2
  };
}

function resizeRectDrawing(line: DrawingLine, handle: DrawingDrag["handle"], point: MeasurePoint): DrawingLine {
  const points = rectDrawingPoints(line);
  let topLeft = { ...points.topLeft };
  let topRight = { ...points.topRight };
  let bottomLeft = { ...points.bottomLeft };
  const moveFrom = (origin: MeasurePoint, targets: Array<"topLeft" | "topRight" | "bottomLeft">) => {
    const timeDelta = point.time - origin.time;
    const priceDelta = point.price - origin.price;
    if (targets.includes("topLeft")) topLeft = shiftDrawingPoint(topLeft, timeDelta, priceDelta);
    if (targets.includes("topRight")) topRight = shiftDrawingPoint(topRight, timeDelta, priceDelta);
    if (targets.includes("bottomLeft")) bottomLeft = shiftDrawingPoint(bottomLeft, timeDelta, priceDelta);
  };

  if (handle === "start" || handle === "top-left") moveFrom(points.topLeft, ["topLeft", "bottomLeft"]);
  if (handle === "end" || handle === "top-right") moveFrom(points.topRight, ["topRight"]);
  if (handle === "bottom-left") moveFrom(points.bottomLeft, ["bottomLeft"]);
  if (handle === "bottom-right") moveFrom(points.bottomRight, ["bottomLeft"]);
  if (handle === "top") moveFrom(drawingPointMidpoint(points.topLeft, points.topRight), ["topLeft", "topRight"]);
  if (handle === "bottom") moveFrom(drawingPointMidpoint(points.bottomLeft, points.bottomRight), ["bottomLeft"]);
  if (handle === "left") moveFrom(drawingPointMidpoint(points.topLeft, points.bottomLeft), ["topLeft", "bottomLeft"]);
  if (handle === "right") moveFrom(drawingPointMidpoint(points.topRight, points.bottomRight), ["topRight"]);

  return { ...line, start: topLeft, end: topRight, stop: bottomLeft };
}

function moveRectDrawing(line: DrawingLine, timeDelta: number, priceDelta: number): DrawingLine {
  const points = rectDrawingPoints(line);
  return {
    ...line,
    start: shiftDrawingPoint(points.topLeft, timeDelta, priceDelta),
    end: shiftDrawingPoint(points.topRight, timeDelta, priceDelta),
    stop: shiftDrawingPoint(points.bottomLeft, timeDelta, priceDelta)
  };
}

function isRiskRewardTool(tool: DrawingTool): tool is "long-position" | "short-position" {
  return tool === "long-position" || tool === "short-position";
}

function createRiskRewardDrawing(tool: "long-position" | "short-position", entry: MeasurePoint, target: MeasurePoint): DrawingLine {
  const normalized = normalizeRiskRewardPrices(tool, entry.price, target.price, undefined);
  const targetPoint = { ...target, price: normalized.target };
  return {
    id: `drawing-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    tool,
    start: { ...entry, price: normalized.entry },
    end: targetPoint,
    stop: { ...target, price: normalized.stop }
  };
}

function createRiskRewardStop(tool: "long-position" | "short-position", entry: MeasurePoint, target: MeasurePoint): MeasurePoint {
  const normalized = normalizeRiskRewardPrices(tool, entry.price, target.price, undefined);
  return { ...target, price: normalized.stop };
}

function resizeRiskRewardDrawing(line: DrawingLine, handle: Extract<DrawingDrag["handle"], "entry" | "target" | "stop">, point: MeasurePoint): DrawingLine {
  const draft: DrawingLine = {
    ...line,
    start: { ...line.start },
    end: { ...line.end },
    stop: line.stop ? { ...line.stop } : createRiskRewardStop(line.tool as "long-position" | "short-position", line.start, line.end)
  };
  if (handle === "entry") draft.start = point;
  if (handle === "target") {
    draft.end = point;
    const stop = draft.stop ?? createRiskRewardStop(line.tool as "long-position" | "short-position", line.start, line.end);
    draft.stop = { ...stop, time: point.time };
  }
  if (handle === "stop") {
    draft.stop = point;
    draft.end = { ...draft.end, time: point.time };
  }
  return normalizeRiskRewardDrawing(draft);
}

function moveRiskRewardDrawing(line: DrawingLine, timeDelta: number, priceDelta: number): DrawingLine {
  const stop = line.stop ?? createRiskRewardStop(line.tool as "long-position" | "short-position", line.start, line.end);
  return normalizeRiskRewardDrawing({
    ...line,
    start: { ...line.start, time: line.start.time + timeDelta, price: line.start.price + priceDelta },
    end: { ...line.end, time: line.end.time + timeDelta, price: line.end.price + priceDelta },
    stop: { ...stop, time: stop.time + timeDelta, price: stop.price + priceDelta }
  });
}

function normalizeRiskRewardDrawing(line: DrawingLine): DrawingLine {
  if (!isRiskRewardTool(line.tool)) return line;
  const normalized = normalizeRiskRewardPrices(line.tool, line.start.price, line.end.price, line.stop?.price);
  return {
    ...line,
    start: { ...line.start, price: normalized.entry },
    end: { ...line.end, price: normalized.target },
    stop: { ...(line.stop ?? line.end), time: line.end.time, price: normalized.stop }
  };
}

function normalizeRiskRewardPrices(tool: "long-position" | "short-position", entry: number, target: number, stop?: number) {
  const safeEntry = Number.isFinite(entry) && entry > 0 ? entry : 1;
  const minimumDelta = Math.max(safeEntry * 0.0001, 0.00000001);
  const proposedTarget = Number(target);
  const targetPrice = tool === "long-position"
    ? Math.max(Number.isFinite(proposedTarget) ? proposedTarget : safeEntry + minimumDelta, safeEntry + minimumDelta)
    : Math.min(Number.isFinite(proposedTarget) ? proposedTarget : safeEntry - minimumDelta, safeEntry - minimumDelta);
  const rewardDistance = Math.max(Math.abs(targetPrice - safeEntry), minimumDelta);
  const symmetricStop = tool === "long-position"
    ? safeEntry - rewardDistance
    : safeEntry + rewardDistance;
  const proposedStop = Number(stop);
  const stopPrice = tool === "long-position"
    ? Math.min(Number.isFinite(proposedStop) && proposedStop > 0 ? proposedStop : symmetricStop, safeEntry - minimumDelta)
    : Math.max(Number.isFinite(proposedStop) && proposedStop > 0 ? proposedStop : symmetricStop, safeEntry + minimumDelta);
  return { entry: safeEntry, target: targetPrice, stop: Math.max(stopPrice, minimumDelta) };
}

function drawingStorageKey(symbol: string) {
  return `${DRAWING_STORAGE_PREFIX}${symbol}`;
}

function loadDrawingLines(symbol: string): DrawingLine[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(drawingStorageKey(symbol));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DrawingLine[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidDrawingLine).slice(-24);
  } catch {
    return [];
  }
}

function saveDrawingLines(symbol: string, lines: DrawingLine[]) {
  if (typeof window === "undefined") return;
  try {
    if (lines.length === 0) {
      window.localStorage.removeItem(drawingStorageKey(symbol));
      return;
    }
    window.localStorage.setItem(drawingStorageKey(symbol), JSON.stringify(lines.slice(-24)));
  } catch {
    // Ignore storage quota or privacy-mode failures; drawings remain usable in memory.
  }
}

function isValidDrawingLine(value: unknown): value is DrawingLine {
  if (!value || typeof value !== "object") return false;
  const item = value as DrawingLine;
  if (!["trend", "ray", "horizontal", "vertical", "rect", "long-position", "short-position"].includes(item.tool)) return false;
  if (!isValidMeasurePoint(item.start) || !isValidMeasurePoint(item.end)) return false;
  return !isRiskRewardTool(item.tool) || isValidMeasurePoint(item.stop);
}

function isValidMeasurePoint(value: unknown): value is MeasurePoint {
  if (!value || typeof value !== "object") return false;
  const item = value as MeasurePoint;
  return Number.isFinite(item.time) && Number.isFinite(item.index) && Number.isFinite(item.price) && item.time > 0 && item.price > 0;
}

function normalizeDrawingTool(value: unknown): DrawingTool | null {
  if (value === "trend" || value === "ray" || value === "horizontal" || value === "vertical" || value === "rect" || value === "long-position" || value === "short-position") return value;
  return null;
}

function normalizeLineStyle(value: unknown): DrawingLine["lineStyle"] | undefined {
  if (value === "solid" || value === "dashed" || value === "dotted") return value;
  return undefined;
}

function normalizeAlertDirection(value: unknown): PriceAlert["direction"] | null {
  if (value === "above" || value === "below" || value === "cross") return value;
  return null;
}

function coerceMeasurePoint(value: unknown, candles: Candle[]): MeasurePoint | null {
  if (!value || typeof value !== "object") return null;
  if (isValidMeasurePoint(value)) return value;
  const item = value as { time?: unknown; index?: unknown; price?: unknown };
  const price = Number(item.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (Number.isFinite(Number(item.time))) {
    const time = Number(item.time);
    return { time, index: candleIndexForTime(candles, time, item.index), price };
  }
  if (Number.isFinite(Number(item.index))) {
    const index = Math.round(Number(item.index));
    const candle = candles[Math.max(0, Math.min(candles.length - 1, index))];
    if (candle) return { time: candle.time, index: candles.indexOf(candle), price };
  }
  return null;
}

function candleIndexForTime(candles: Candle[], time: number, fallbackIndex?: unknown) {
  const exact = candles.findIndex((candle) => candle.time === time);
  if (exact >= 0) return exact;
  if (Number.isFinite(Number(fallbackIndex))) return Math.max(0, Math.round(Number(fallbackIndex)));
  const nearest = nearestCandleTime(candles.map((candle) => candle.time), time);
  return nearest === null ? 0 : Math.max(0, candles.findIndex((candle) => candle.time === nearest));
}

function defaultDrawingEnd(tool: DrawingTool, start: MeasurePoint, candles: Candle[]): MeasurePoint {
  const barSeconds = currentBarSeconds(candles);
  if (tool === "vertical") return { ...start, price: start.price * 1.002 };
  if (tool === "horizontal") return { ...start, time: start.time + barSeconds, index: start.index + 1 };
  return { ...start, time: start.time + barSeconds * 8, index: start.index + 8, price: start.price * 1.002 };
}

function buildSignalMarkers(
  candles: Candle[],
  signals: ChartSignalMarker[],
  labelFor: (signal: ChartSignalMarker) => { label: string; positive: boolean },
  showLabels = true
): ChartMarkerPoint[] {
  if (candles.length === 0 || signals.length === 0) return [];
  const sortedTimes = candles.map((candle) => candle.time);
  const first = sortedTimes[0];
  const last = sortedTimes[sortedTimes.length - 1];
  const markers: ChartMarkerPoint[] = [];
  const seen = new Set<string>();
  for (const signal of signals.slice(0, 80)) {
    const time = nearestCandleTime(sortedTimes, signal.time);
    if (time === null || time < first || time > last) continue;
    const opinion = labelFor(signal);
    const key = `${signal.source}-${time}-${opinion.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    markers.push({
      id: `signal-${signal.id}`,
      time,
      position: opinion.positive ? "belowBar" : "aboveBar",
      shape: "circle",
      color: signal.source === "ai" ? "#b792ff" : "#67e8f9",
      text: showLabels ? opinion.label : undefined,
      size: signal.source === "ai" ? 0.66 : 0.62
    });
  }
  return markers.sort((a, b) => a.time - b.time).slice(-60);
}

function aggregateFillMarkers(candles: Candle[], fills: ChartFillMarker[], limit = DISPLAY_FILL_LIMIT): ChartFillMarker[] {
  if (candles.length === 0 || fills.length === 0) return [];
  const sortedTimes = candles.map((candle) => candle.time);
  const first = sortedTimes[0];
  const last = sortedTimes[sortedTimes.length - 1];
  type FillAggregate = {
    marker: ChartFillMarker;
    action: ReturnType<typeof resolveChartTradeAction>;
    time: number;
    count: number;
    quantity: number;
    quantityValid: boolean;
    pnl: number;
    pnlValid: boolean;
    weightedPrice: number;
    priceWeight: number;
    priceSum: number;
    priceCount: number;
    startTime: number;
    endTime: number;
  };
  const groups = new Map<string, FillAggregate>();
  for (const fill of fills.slice(0, FILL_SOURCE_LIMIT)) {
    const sourceTime = Number(fill.time);
    if (!Number.isFinite(sourceTime)) continue;
    const time = nearestCandleTime(sortedTimes, sourceTime);
    if (time === null || time < first || time > last) continue;
    const action = resolveChartTradeAction(fill);
    const key = `${time}:${action}`;
    const quantity = Number(fill.size);
    const price = Number(fill.price);
    const pnlText = fill.pnl === null || fill.pnl === undefined ? "" : String(fill.pnl).trim();
    const pnl = pnlText ? Number(pnlText) : Number.NaN;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (Number.isFinite(quantity) && quantity > 0) {
        existing.quantity += Math.abs(quantity);
      } else {
        existing.quantityValid = false;
      }
      if (Number.isFinite(pnl)) {
        existing.pnl += pnl;
      } else {
        existing.pnlValid = false;
      }
      if (Number.isFinite(price) && price > 0) {
        const weight = Number.isFinite(quantity) && quantity > 0 ? Math.abs(quantity) : 1;
        existing.weightedPrice += price * weight;
        existing.priceWeight += weight;
        existing.priceSum += price;
        existing.priceCount += 1;
      }
      existing.startTime = Math.min(existing.startTime, sourceTime);
      existing.endTime = Math.max(existing.endTime, sourceTime);
      continue;
    }
    groups.set(key, {
      marker: fill,
      action,
      time,
      count: 1,
      quantity: Number.isFinite(quantity) && quantity > 0 ? Math.abs(quantity) : 0,
      quantityValid: Number.isFinite(quantity) && quantity > 0,
      pnl: Number.isFinite(pnl) ? pnl : 0,
      pnlValid: Number.isFinite(pnl),
      weightedPrice: Number.isFinite(price) && price > 0 ? price * (Number.isFinite(quantity) && quantity > 0 ? Math.abs(quantity) : 1) : 0,
      priceWeight: Number.isFinite(price) && price > 0 ? (Number.isFinite(quantity) && quantity > 0 ? Math.abs(quantity) : 1) : 0,
      priceSum: Number.isFinite(price) && price > 0 ? price : 0,
      priceCount: Number.isFinite(price) && price > 0 ? 1 : 0,
      startTime: sourceTime,
      endTime: sourceTime
    });
  }
  return [...groups.values()]
    .map((group): ChartFillMarker => {
      const averagePrice = group.priceWeight > 0
        ? group.weightedPrice / group.priceWeight
        : group.priceCount > 0
          ? group.priceSum / group.priceCount
          : Number(group.marker.price);
      return {
        ...group.marker,
        id: group.count > 1 ? `group-${group.time}-${group.action}` : group.marker.id,
        time: group.time,
        price: averagePrice,
        action: group.action,
        size: group.quantityValid ? formatChartAmount(group.quantity) : group.marker.size,
        pnl: group.pnlValid ? formatChartAmount(group.pnl) : group.marker.pnl,
        groupCount: group.count > 1 ? group.count : undefined,
        groupStartTime: group.startTime,
        groupEndTime: group.endTime
      };
    })
    .sort((left, right) => left.time - right.time)
    .slice(-limit);
}

function buildFillMarkers(
  fills: ChartFillMarker[],
  labelFor: (fill: ChartFillMarker) => string,
  showLabels = false
): ChartMarkerPoint[] {
  return fills.map((fill) => {
    const action = resolveChartTradeAction(fill);
    const visual = chartTradeVisual(action);
    const count = Number(fill.groupCount) > 1 ? Number(fill.groupCount) : 0;
    const label = labelFor(fill);
    return {
      id: `fill-${fill.id}`,
      time: fill.time,
      position: visual.buyLike ? "belowBar" : "aboveBar",
      shape: visual.buyLike ? "arrowUp" : "arrowDown",
      color: visual.color,
      text: showLabels ? `${label}${count > 1 ? ` ×${count}` : ""}` : count > 1 ? `×${count}` : undefined,
      size: 0.72
    };
  });
}

function nearestCandleTime(sortedTimes: number[], target: number) {
  if (sortedTimes.length === 0) return null;
  let left = 0;
  let right = sortedTimes.length - 1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const value = sortedTimes[mid];
    if (value === target) return value;
    if (value < target) left = mid + 1;
    else right = mid - 1;
  }
  const before = sortedTimes[Math.max(0, right)];
  const after = sortedTimes[Math.min(sortedTimes.length - 1, left)];
  return Math.abs(target - before) <= Math.abs(after - target) ? before : after;
}

function chartOrderLineWidth(type: ChartOrderLine["type"]) {
  if (type === "limit" || type === "position-entry") return 1;
  return 2;
}

function chartOrderLineStyle(type: ChartOrderLine["type"]) {
  if (type === "limit") return 0;
  if (type === "position-entry") return 1;
  return 2;
}

function buildPositionLineIntent(range: ChartPositionRange, targetPrice: number): PositionLineTradeIntent | null {
  const entryPrice = Number(range.entryPrice);
  const currentPrice = Number(range.currentPrice);
  const size = String(range.size ?? "");
  if (!Number.isFinite(entryPrice) || !Number.isFinite(currentPrice) || !Number.isFinite(targetPrice) || entryPrice <= 0 || currentPrice <= 0 || targetPrice <= 0) {
    return null;
  }
  const posSide = range.posSide === "short" ? "short" : range.posSide === "net" ? "net" : "long";
  const isShort = posSide === "short" || (posSide === "net" && Number(size) < 0);
  const side: "buy" | "sell" = isShort ? "buy" : "sell";
  const snapDistance = Math.abs(targetPrice - currentPrice) / currentPrice;
  const kind: PositionLineTradeIntent["kind"] =
    snapDistance <= 0.00001
      ? "market_close"
      : isShort
        ? targetPrice <= currentPrice
          ? "limit_close"
          : targetPrice < entryPrice
            ? "trailing_profit"
            : "stop_loss"
        : targetPrice >= currentPrice
          ? "limit_close"
          : targetPrice > entryPrice
            ? "trailing_profit"
            : "stop_loss";
  const qty = Math.abs(Number(size || 0));
  const estimatedPnl = estimatePositionLinePnl(isShort ? "short" : "long", entryPrice, targetPrice, qty, range.contractValue);
  const estimatedPnlRatio = entryPrice > 0 ? (isShort ? (entryPrice - targetPrice) / entryPrice : (targetPrice - entryPrice) / entryPrice) * 100 : undefined;
  const existing = kind === "stop_loss" || kind === "trailing_profit" ? findPositionRangeAlgo(range, "sl") : undefined;
  return {
    kind,
    instId: range.instId,
    posSide,
    side,
    targetPrice,
    entryPrice,
    currentPrice,
    size,
    estimatedPnl,
    estimatedPnlRatio,
    existingAlgoId: existing?.algoId,
    existingAlgoClientOrderId: existing?.algoClientOrderId,
    existingAlgoSide: existing?.side
  };
}

function positionIntentLabel(range: ChartPositionRange, targetPrice: number, snapToMarket = false) {
  const intent = buildPositionLineIntent(range, snapToMarket ? range.currentPrice : targetPrice);
  if (!intent) return chartText("Position action", "持仓操作");
  const title = intent.kind === "market_close" ? chartText("Market close", "市价平仓") : intent.kind === "limit_close" ? chartText("Limit close", "限价平仓") : intent.kind === "take_profit" ? chartText("Take profit", "止盈") : intent.kind === "trailing_profit" ? chartText("Trailing profit", "回撤止盈") : chartText("Stop loss", "止损");
  const pnl = Number(intent.estimatedPnl);
  const pnlText = Number.isFinite(pnl) ? ` ${pnl >= 0 ? "+" : ""}${formatChartNumber(pnl)}U` : "";
  const ratio = Number(intent.estimatedPnlRatio);
  const ratioText = Number.isFinite(ratio) ? ` ${ratio >= 0 ? "+" : ""}${ratio.toFixed(2)}%` : "";
  return `${title}${pnlText}${ratioText}`;
}

function estimatePositionLinePnl(posSide: string | null | undefined, entryPrice: number, targetPrice: number, size: number, contractValue?: number) {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(targetPrice) || !Number.isFinite(size) || size <= 0) return undefined;
  const direction = posSide === "short" ? -1 : 1;
  const normalizedContractValue = Number.isFinite(contractValue) && Number(contractValue) > 0 ? Number(contractValue) : 1;
  return (targetPrice - entryPrice) * size * normalizedContractValue * direction;
}

function orderLineDragEstimate(line: ChartOrderLine, targetPrice: number) {
  const entryPrice = Number(line.estimateEntryPrice);
  const size = Number(line.estimateSize);
  const contractValue = Number(line.estimateContractValue);
  if (![entryPrice, targetPrice, size, contractValue].every(Number.isFinite) || entryPrice <= 0 || targetPrice <= 0 || size <= 0 || contractValue <= 0) return null;
  const posSide = line.posSide === "short" || (line.posSide === "net" && line.side === "buy") ? "short" : "long";
  const pnl = estimatePositionLinePnl(posSide, entryPrice, targetPrice, size, contractValue);
  if (!Number.isFinite(pnl)) return null;
  const ratio = (posSide === "short" ? (entryPrice - targetPrice) / entryPrice : (targetPrice - entryPrice) / entryPrice) * 100;
  return { pnl: Number(pnl), ratio };
}

function orderLineDragTitle(line: ChartOrderLine) {
  const type = line.type === "tp" ? chartText("Take profit", "止盈") : line.type === "sl" ? chartText("Stop loss", "止损") : line.type === "trigger" ? chartText("Trigger order", "计划委托") : chartText("Limit order", "限价委托");
  const side = line.posSide === "long" ? chartText("Long", "多仓") : line.posSide === "short" ? chartText("Short", "空仓") : line.side === "buy" ? chartText("Buy", "买入") : line.side === "sell" ? chartText("Sell", "卖出") : "";
  return `${type}${side ? ` · ${side}` : ""}${line.size ? ` · ${chartText(`${line.size} contracts`, `${line.size}张`)}` : ""}`;
}

function formatOrderLineDragEstimate(line: ChartOrderLine, targetPrice: number) {
  const estimate = orderLineDragEstimate(line, targetPrice);
  if (!estimate) return "";
  const sign = estimate.pnl >= 0 ? "+" : "";
  const ratioSign = estimate.ratio >= 0 ? "+" : "";
  return `${chartText("Estimated", "预估")} ${sign}${formatChartNumber(estimate.pnl)}U ${ratioSign}${estimate.ratio.toFixed(2)}%`;
}

function findPositionRangeAlgo(range: ChartPositionRange, side: "tp" | "sl") {
  const matches = range.existingAlgos?.filter((algo) => algo.side === side) ?? [];
  return matches[0];
}

function calcMeasureStats(start: MeasurePoint | null, end: MeasurePoint | null) {
  if (!start || !end) return null;
  const delta = end.price - start.price;
  const deltaPercent = start.price > 0 ? (delta / start.price) * 100 : 0;
  return {
    delta,
    deltaPercent,
    bars: Math.abs(end.index - start.index),
    seconds: Math.abs(end.time - start.time)
  };
}

function formatChartNumber(value?: number) {
  if (!Number.isFinite(value)) return "--";
  const numeric = Number(value);
  if (Math.abs(numeric) >= 1000) return numeric.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (Math.abs(numeric) >= 1) return numeric.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return numeric.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds)) return "--";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

function formatVolume(value?: number) {
  if (!Number.isFinite(value)) return "--";
  const numeric = Number(value);
  if (Math.abs(numeric) >= 1_000_000) return `${(numeric / 1_000_000).toFixed(2)}M`;
  if (Math.abs(numeric) >= 1_000) return `${(numeric / 1_000).toFixed(2)}K`;
  return numeric.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
