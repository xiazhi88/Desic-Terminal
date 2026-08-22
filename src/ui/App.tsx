import { lazy, memo, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type Dispatch, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import {
  Bell,
  BookOpen,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  FilePlus2,
  FolderOpen,
  GitBranch,
  Edit3,
  ExternalLink,
  GripVertical,
  History,
  KeyRound,
  LayoutDashboard,
  Layers3,
  Loader2,
  Maximize2,
  Minus,
  Newspaper,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  Star,
  Send,
  Settings,
  ShieldCheck,
  ShieldAlert,
  SlidersHorizontal,
  Square,
  TableProperties,
  TrendingDown,
  TrendingUp,
  Wifi,
  X,
  XCircle,
  Trash2
} from "lucide-react";
import clsx from "clsx";
import type { TFunction } from "i18next";
import defaultAiConfig from "../../shared/default-ai-config.json";
import { SymbolIcon, SymbolLabel } from "./SymbolIcon";
import { useConfirmPrompt } from "./ConfirmPrompt";
import { AppUpdateBadge } from "./AppUpdateBadge";
import { useDraggableSurface } from "./useDraggableSurface";
import type {
  AccountConfigDraft,
  AccountBillSummary,
  AccountBillsArchiveStatus,
  AccountPerformanceSummary,
  AccountSummary,
  AlgoOrdersResponse,
  AiChatMessage,
  AiAutomationOverview,
  AiAutomationSummary,
  AiAutomationEvent,
  AiAutomationTab,
  AiConfigSummary,
  AiConfigUpdate,
  AiEvent,
  AiModelConfigUpdate,
  AiPermissionMode,
  AiReasoningDepth,
  AiSession,
  AiTokenUsageDashboard,
  AiSkillDefinition,
  AiSkillVersion,
  AiSessionSnapshot,
  Candle,
  ChartOrderLine,
  ChartOrderLineEdit,
  ChartPositionRange,
  ChartRiskRewardTradeIntent,
  ChartWindowState,
  ClassifiedOkxError,
  FeishuConfigSummary,
  FundingRate,
  ChartTradeSources,
  HistoricalFillSummary,
  HistoricalOrderSummary,
  InstrumentOperationKind,
  InstrumentOperationPreview,
  InstrumentOperationScope,
  InstrumentOperationView,
  KlineSyncReport,
  MarketAssetsSummary,
  NotificationSettingsSummary,
  OkxInstrumentSummary,
  OkxAlgoOrder,
  OkxLeverageInfo,
  OkxPendingOrder,
  OkxPosition,
  OkxTimeState,
  OrderSpecV2OrderType,
  OrderSpecV2TriggerSource,
  OrderBook,
  PositionEpisode,
  PrivateHistoryStatusResponse,
  PrivateAccountSnapshot,
  PrivateWsStatus,
  PublicWsStatus,
  PositionLineTradeIntent,
  ProxyConfigSummary,
  ProxyConfigUpdate,
  ProxyTestResult,
  StorageMaintenanceResult,
  StorageStatusResult,
  StartupCheck,
  Ticker,
  Trade,
  TradeAuditEventSummary,
  TradeExecutionGuard,
  TradeOpportunity,
} from "../types";
import {
  approveAiTool,
  createAiSession,
  deleteAiSession,
  listenAiConfigUpdates,
  listenAiEvents,
  loadAiTokenUsageSummary,
  listAiSessions,
  loadAiConfigSummary,
  loadAiSession,
  renameAiSession,
  saveAiConfig,
  sendAiMessage,
  stopAiMessage,
  testAiConnection
} from "../lib/ai";
import {
  connectMarketStream,
  amendOkxOrder,
  amendOkxAlgoOrder,
  cancelOkxOrder,
  cancelOkxAlgoOrder,
  deleteChartAlert,
  closeOkxPosition,
  deleteAccountConfig,
  fetchAccountBills,
  fetchAccountBillsArchiveStatus,
  fetchAccountPerformanceSummary,
  fetchCandles,
  fetchFundingRate,
  fetchMarketSnapshot,
  fetchHistoricalCandlesBefore,
  fetchChartTradeSources,
  fetchHistoricalFills,
  fetchHistoricalOrders,
  fetchActiveInstrumentOperations,
  fetchLeverageInfo,
  fetchOkxAlgoOrders,
  ensureInstrumentsCache,
  fetchPrivateHistoryStatus,
  fetchPositionEpisodes,
  fetchPrivateSnapshot,
  fetchTradeAuditEvents,
  fetchTradeExecutionGuards,
  fetchTradeOpportunities,
  fetchTicker,
  importAccountBillsArchive,
  initLocalStorage,
  loadMarketAssetsCache,
  listenKlineSync,
  listenTradeAuditEvents,
  loadWatchlistConfig,
  openChartWindow,
  loadProxyConfig,
  loadAccounts,
  migrateSensitiveConfig,
  placeOkxOrder,
  placeOkxAlgoOrder,
  previewCancelInstrumentOrders,
  previewFlattenInstrumentPositions,
  executeCancelInstrumentOrders,
  executeFlattenInstrumentPositions,
  queryInstrumentOperation,
  reconcileTradeExecutionGuards,
  approveTradeOpportunity,
  clearTradeOpportunities,
  deleteTradeOpportunity,
  rejectTradeOpportunity,
  reconcilePrivateStreams,
  runStorageMaintenance,
  fetchStorageStatus,
  saveAccountConfig,
  saveChartAlert,
  saveWatchlistConfig,
  saveProxyConfig,
  setOkxLeverage,
  probeOkxStartupNetwork,
  syncMarketAssets,
  syncKlineIntegrity,
  syncPrivateHistory,
  syncOkxTime,
  testAccountConfig,
  testBusinessWsReachability,
  testPrivateWsReachability,
  testPublicWsReachability,
  testProxyConfig
} from "../lib/okx";
import { calcChange, fmtCompact, fmtDelay, fmtPrice } from "../lib/format";
import {
  buildHistoricalFillMarkers,
  chartOrderVisual,
  chartPositionLabel,
  formatChartOrderLabel,
  formatChartPosition,
  formatChartPositionQuantity,
} from "../lib/chartTradeSemantics";
import { logger } from "../lib/logger";
import { loadNewsReadState, syncIntelligence } from "../lib/intelligence";
import { createDeferredCleanupSlot } from "../lib/deferredCleanup";
import { BoundedEventCache } from "../lib/boundedEventCache";
import { trimDevelopmentPerformanceEntries } from "../lib/performanceEntries";
import {
  applyLivePriceToLatestCandle,
  getMarketHotState,
  hydrateMarketHotState,
  mergeIntoMarketCandles,
  queueCandle,
  queueBusinessMessageAt,
  queueFundingRate,
  queueMarketTicker,
  queueOrderBook,
  queueTrades,
  queuePublicStreamStatus,
  queueTrade,
  queueWatchTicker,
  replaceMarketCandles,
  resetMarketHotState,
  useMarketHotStore
} from "../lib/marketHotStore";
import { loadNotificationSettings, saveFeishuConfig, testFeishuNotification } from "../lib/notifications";
import { classifyAlgoPendingOrderGroup, classifyAlgoTriggerPurpose, classifyOrdinaryPendingOrderGroup, isOrdinaryPendingOrder, mergePendingAlgoOrders } from "../lib/pendingOrderClassification";
import { getActiveTauriListenerCounts, invokeDesktop, invokeOptional, isTauriRuntime, listenOptional } from "../lib/tauri";
import { useTranslation } from "react-i18next";

type UiTranslation = ReturnType<typeof useTranslation>["t"];
import { LANGUAGE_OPTIONS, type LanguagePreference, type SupportedLocale } from "../i18n/locales";
import { formatLocalizedDate, formatLocalizedNumber, i18n, languagePreference, saveLanguagePreference, resolvedLocale } from "../i18n/runtime";
import { ErrorBoundary } from "./ErrorBoundary";
import { ChartDataTable } from "./ChartDataTable";
import { KlineChart, type ChartContextTradeIntent, type ChartHistoryLoadOutcome } from "./KlineChart";
import { ChartQuickTradeDialog, persistChartQuickTradeAccountConfig, type ChartQuickTradeAccountConfig } from "./ChartQuickTradeDialog";
import { SharedChartOrderLineEditDialog, SharedPositionLineTradeDialog } from "./ChartTradeDialogs";
import { ChartRiskRewardTradeDialog as SharedChartRiskRewardTradeDialog } from "./ChartRiskRewardTradeDialog";
import { amendChartOrder, cancelChartOrder, submitRiskRewardChartAction } from "../lib/chartTradeActions";
import { buildSharedChartOrderLines, buildSharedChartPositionRanges } from "../lib/chartTradeLines";
import { ChartWindowPage } from "./ChartWindowPage";
import { HelpCenter, type HelpTarget } from "./HelpCenter";
import { AiMessageError, AiProcessTimeline, AiTokenUsageLine, MarkdownMessage, applyAiEvent, localizeAiMessageStatus, safeJson, storedMessageToUiMessage, updateLastAssistant, type AiUiMessage } from "./AiMessageProcess";
import {
  AiModelIdControl,
  AiProviderGuide,
  AiProviderSetupFlow,
  aiProviderUsesLocalCli,
  findAiProviderTemplate,
  type AiProviderSetupValue,
} from "./AiProviderSetupFlow";
import { TerminalSelect } from "./TerminalSelect";
import { useModalFocus } from "./useModalFocus";
import {
  actionForTradeHotkey,
  buildOrderSpecV2,
  createTradeAlgoClientId,
  createTradeExecutionKey,
  hasVisibleTradeHotkeyBlocker,
  isEditableKeyboardTarget,
  legacyOrderType,
  type PreparedTradeOrder,
  type TradeTicketAction,
} from "./trade-ticket/model";
import {
  FirstLaunchOnboarding,
  parseFirstLaunchPreviewStep,
  useFirstLaunchOnboarding,
  type FirstLaunchStep
} from "./FirstLaunchOnboarding";

const loadAiAutomationModule = () => import("./AiAutomationPanel");
const AiAutomationPanel = lazy(() =>
  loadAiAutomationModule().then((module) => ({ default: module.AiAutomationPanel }))
);
const AutomationMultiAgentPreview = lazy(() =>
  import("./AiAutomationPanel").then((module) => ({ default: module.AutomationPreview }))
);
const TradeOpportunitiesWorkspacePage = lazy(() =>
  import("./TradeOpportunitiesPage").then((module) => ({ default: module.TradeOpportunitiesPage }))
);
const IntelligenceWorkspacePage = lazy(() =>
  import("./IntelligencePage").then((module) => ({ default: module.IntelligencePage }))
);
type SystematicResearchModule = typeof import("./SystematicResearchPage");

let systematicResearchModulePromise: Promise<SystematicResearchModule> | null = null;

const loadSystematicResearchModule = () => {
  if (systematicResearchModulePromise) return systematicResearchModulePromise;

  systematicResearchModulePromise = import("./SystematicResearchPage")
    .catch(async (error) => {
      systematicResearchModulePromise = null;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
      return import("./SystematicResearchPage").catch((retryError) => {
        systematicResearchModulePromise = null;
        throw retryError ?? error;
      });
    });
  return systematicResearchModulePromise;
};

const preloadSystematicResearchModule = () => {
  void loadSystematicResearchModule().catch((error) => {
    logger.warn("systematic research module preload failed", { error: String(error) });
  });
};

const SystematicResearchWorkspacePage = lazy(() =>
  loadSystematicResearchModule().then((module) => ({ default: module.SystematicResearchPage }))
);

const DEFAULT_SYMBOL = "BTC-USDT-SWAP";
const PRIMARY_CHART_TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m"] as const;
const SECONDARY_CHART_TIMEFRAMES = ["1H", "2H", "4H", "6H", "12H", "1D"] as const;
const NOTIFICATION_HISTORY_KEY = "desictrade.notificationHistory.v1";
const WATCHLIST_STORAGE_KEY = "desictrade.watchlist.v1";
/// Sentinel for the bottom-panel instrument filter. Not a valid instId, so it can
/// never collide with a real contract.
const ALL_INSTRUMENTS_FILTER = "__all__";
const LIVE_ACK_STORAGE_KEY = "desictrade.liveRiskAcknowledged.v2";
const CHART_WORKSPACE_LAYOUT_KEY = "desictrade.chartWorkspaceLayout.v1";

type ChartWorkspaceLayout = {
  depthWidth?: number;
  bottomHeight?: number;
};

type ChartResizeGesture = {
  axis: "width" | "height";
  pointerId: number;
  startCoordinate: number;
  originSize: number;
  minSize: number;
  maxSize: number;
  lastSize: number;
};
const DEFAULT_WATCHLIST = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP", "BNB-USDT-SWAP", "XRP-USDT-SWAP"];
const KLINE_INTEGRITY_INTERVALS = ["1m"];
const KLINE_REQUIRED_DAYS: Record<string, number> = {
  "1m": 365
};
const KLINE_STARTUP_RECENT_CHECK_HOURS = 24 * 30;
const COMPACT_TERMINAL_MEDIA_QUERY = "(max-width: 1100px)";
const KLINE_RECENT_CHECK_HOURS = 2;
const PRIVATE_WS_DELAY_WARNING_MS = 10_000;
const EMPTY_PREVIEW_ACCOUNTS: AccountSummary[] = [];
const DISPLAY_TIME_ZONE = "Asia/Shanghai";
const NOTIFICATION_SOUND_COOLDOWN_MS = 1_000;
const NOTIFICATION_SOUND_PEAK_GAIN = 0.07;

let notificationAudioContext: AudioContext | null = null;
let notificationSoundLastPlayedAt = 0;

function getNotificationAudioContext() {
  if (typeof window === "undefined") return null;
  const audioWindow = window as Window & { webkitAudioContext?: typeof AudioContext };
  const AudioContextConstructor = window.AudioContext ?? audioWindow.webkitAudioContext;
  if (!AudioContextConstructor) return null;
  if (!notificationAudioContext) {
    try {
      notificationAudioContext = new AudioContextConstructor();
    } catch {
      return null;
    }
  }
  return notificationAudioContext;
}

function unlockNotificationAudio() {
  const context = getNotificationAudioContext();
  if (context?.state === "suspended") void context.resume().catch(() => undefined);
}

function scheduleNotificationTone(context: AudioContext, frequency: number, startAt: number, duration: number, peakGain: number) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peakGain, startAt + 0.014);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.02);
}

function playNotificationSound(kind: AppNotification["kind"]) {
  if (kind !== "trade" && kind !== "error") return;
  const context = getNotificationAudioContext();
  if (!context || context.state !== "running") return;
  const now = performance.now();
  if (now - notificationSoundLastPlayedAt < NOTIFICATION_SOUND_COOLDOWN_MS) return;
  notificationSoundLastPlayedAt = now;

  // A two-note sine chime keeps trade and error feedback distinct without an alarm-like tone.
  const startAt = context.currentTime + 0.005;
  const tones = kind === "trade"
    ? [{ frequency: 659.25, offset: 0, duration: 0.12 }, { frequency: 880, offset: 0.075, duration: 0.16 }]
    : [{ frequency: 523.25, offset: 0, duration: 0.12 }, { frequency: 392, offset: 0.075, duration: 0.17 }];
  try {
    for (const tone of tones) scheduleNotificationTone(context, tone.frequency, startAt + tone.offset, tone.duration, NOTIFICATION_SOUND_PEAK_GAIN);
  } catch {
    // Audio playback must never affect notification delivery or trading flows.
  }
}

function buildTerminalPreviewCandles(symbol: string, timeframe: string): Candle[] {
  const seconds = ({ "1m": 60, "5m": 300, "15m": 900, "30m": 1_800, "1H": 3_600, "4H": 14_400, "1D": 86_400 } as Record<string, number>)[timeframe] ?? 1_800;
  const base = symbol.startsWith("ETH-") ? 3_180 : symbol.startsWith("SOL-") ? 172 : symbol.startsWith("BNB-") ? 812 : symbol.startsWith("XRP-") ? 2.84 : 64_000;
  const end = Math.floor(Date.now() / 1_000 / seconds) * seconds;
  let price = base * 0.982;
  return Array.from({ length: 320 }, (_, index) => {
    const relativeWave = Math.sin(index / 11) * 0.0018 + Math.cos(index / 29) * 0.0025 + Math.sin(index * 1.41) * 0.00035;
    const open = price;
    const close = open * (1 + relativeWave);
    const spread = base * (0.0007 + Math.abs(Math.sin(index / 7)) * 0.0005);
    price = close;
    return {
      time: end - (319 - index) * seconds,
      open,
      high: Math.max(open, close) + spread,
      low: Math.min(open, close) - spread,
      close,
      volume: 120 + Math.abs(close - open) * 7 + (index % 17) * 8,
      confirm: index < 319
    };
  });
}

function buildTerminalPreviewPrivateSnapshot(account?: AccountSummary, includePendingOrder = false): PrivateAccountSnapshot | null {
  if (!account) return null;
  const syncedAt = Date.UTC(2026, 6, 29, 12, 58, 37);
  return {
    accountId: account.id,
    environment: account.environment,
    balances: [
      { ccy: "USDT", eq: "13.21213", availEq: "10.638698", availBal: "10.638698", cashBal: "13.10349", frozenBal: "2.573432", uTime: String(syncedAt) },
      { ccy: "BTC", eq: "0.00042", availEq: "0.00042", availBal: "0.00042", cashBal: "0.00042", frozenBal: "0", uTime: String(syncedAt) }
    ],
    positions: includePendingOrder ? [{
      instId: "BTC-USDT-SWAP", instType: "SWAP", mgnMode: "cross", posSide: "long", pos: "0.04",
      avgPx: "63550", markPx: "63625", upl: "0.003", uplRatio: "0.01", lever: "20", liqPx: "61000",
      posId: "preview-btc-long", cTime: String(syncedAt - 60_000), uTime: String(syncedAt)
    }] : [],
    orders: includePendingOrder
      ? [{
          instId: "BTC-USDT-SWAP",
          instType: "SWAP",
          ordId: "preview-order-63400",
          clOrdId: "preview-client-order-63400",
          side: "sell",
          posSide: "short",
          tdMode: "cross",
          ordType: "limit",
          px: "63400",
          sz: "0.02",
          accFillSz: "0",
          avgPx: "",
          state: "live",
          lever: "20",
          reduceOnly: "false",
          cTime: String(syncedAt),
          uTime: String(syncedAt)
        }, {
          instId: "BTC-USDT-SWAP",
          instType: "SWAP",
          ordId: "preview-trigger-close-long-63100",
          clOrdId: "preview-trigger-close-long-client-63100",
          algoId: "preview-trigger-close-long-63100",
          algoClOrdId: "preview-trigger-close-long-client-63100",
          isAlgo: true,
          side: "sell",
          posSide: "long",
          tdMode: "cross",
          ordType: "trigger",
          px: "",
          triggerPx: "63100",
          triggerPxType: "last",
          ordPx: "-1",
          sz: "0.04",
          accFillSz: "0",
          avgPx: "",
          state: "live",
          lever: "20",
          reduceOnly: "false",
          cTime: String(syncedAt),
          uTime: String(syncedAt)
        }, {
          instId: "ETH-USDT-SWAP",
          instType: "SWAP",
          ordId: "preview-trigger-entry-long-1912",
          clOrdId: "preview-trigger-entry-long-client-1912",
          algoId: "preview-trigger-entry-long-1912",
          algoClOrdId: "preview-trigger-entry-long-client-1912",
          isAlgo: true,
          side: "buy",
          posSide: "long",
          tdMode: "cross",
          ordType: "trigger",
          px: "",
          triggerPx: "1912.5",
          triggerPxType: "last",
          ordPx: "-1",
          sz: "0.1",
          accFillSz: "0",
          avgPx: "",
          state: "live",
          lever: "20",
          reduceOnly: "false",
          cTime: String(syncedAt + 1),
          uTime: String(syncedAt + 1)
        }]
      : [],
    syncedAt
  };
}

type AccountEnvironmentScope = Pick<AccountSummary, "id" | "environment">;

function accountEnvironmentScopeKey(account: AccountEnvironmentScope) {
  return `${account.environment}:${account.id}`;
}
const REQUIRED_AI_SKILL_IDS = [
  "desic-core-operations",
  "trading-philosophy",
  "okx-market-intelligence",
  "desic-trade-operations"
] as const;
const REQUIRED_AI_SKILL_ID_SET = new Set<string>(REQUIRED_AI_SKILL_IDS);

function aiSkillConstraintLabel(skillId: string, t?: UiTranslation): string {
  if (skillId === "desic-core-operations") return t ? t("settings:fixedPolicy") : "固定规范";
  if (skillId === "trading-philosophy") return t ? t("settings:requiredCustomizable") : "必需 · 可定制";
  if (REQUIRED_AI_SKILL_ID_SET.has(skillId)) return t ? t("settings:required") : "必需";
  return "";
}

function withRequiredAiSkills(skills: string[] | undefined): string[] {
  const migrated = (skills ?? [])
    .filter((id) => id !== "desic-core-operations")
    .map((id) => id === "okx-news-intelligence" || id === "okx-smart-money-analysis"
      ? "okx-market-intelligence"
      : id === "desic-perpetual-risk" || id === "desic-position-management" || id === "desic-market-analysis"
        ? "desic-trade-operations"
        : id);
  return [...new Set([
    "trading-philosophy",
    "okx-market-intelligence",
    "desic-trade-operations",
    ...migrated
  ])];
}

function normalizeAiPermissionMode(mode: AiPermissionMode | string | undefined): AiPermissionMode {
  if (mode === "limited_auto") return "limited_auto";
  if (mode === "copilot" || mode === "approval" || mode === "full") return "copilot";
  return "advisor";
}

function normalizeAutomationTab(tab: string | null | undefined): AiAutomationTab {
  switch (tab) {
    case "profiles":
    case "runs":
    case "wake_conditions":
    case "reviews":
    case "optimization":
    case "notifications":
      return tab;
    default:
      return "runs";
  }
}

function normalizeAiSkillDefinitions(definitions: AiSkillDefinition[]): AiSkillDefinition[] {
  const merged = new Map<string, AiSkillDefinition>();
  for (const definition of definitions) {
    const id = definition.id === "okx-news-intelligence" || definition.id === "okx-smart-money-analysis"
      ? "okx-market-intelligence"
      : definition.id === "desic-perpetual-risk" || definition.id === "desic-position-management" || definition.id === "desic-market-analysis"
        ? "desic-trade-operations"
        : definition.id;
    const migrated = id === definition.id
      ? definition
      : { ...definition, id, name: id };
    const existing = merged.get(id);
    if (!existing) {
      merged.set(id, migrated);
      continue;
    }
    merged.set(id, {
      ...existing,
      description: `${existing.description} ${migrated.description}`.trim(),
      rules: `${existing.rules}\n\nMigrated legacy guidance:\n${migrated.rules}`.trim(),
      content: `${existing.content}\n\nMigrated legacy guidance:\n${migrated.content}`.trim()
    });
  }
  return [...merged.values()];
}

export function App() {
  const { t } = useTranslation(["common", "chart"]);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const trim = () => trimDevelopmentPerformanceEntries(performance);
    trim();
    const timer = window.setInterval(trim, 5_000);
    return () => window.clearInterval(timer);
  }, []);

  const [windowLabel, setWindowLabel] = useState<string | null>(null);
  const [bootCompleted, setBootCompleted] = useState(false);
  const [mainActivated, setMainActivated] = useState(false);
  const [marketAssets, setMarketAssets] = useState<MarketAssetsSummary | null>(null);
  const enterMain = useCallback(async (assets?: MarketAssetsSummary | null) => {
    if (assets) setMarketAssets(assets);
    try {
      await invokeOptional("enter_main_window");
    } catch (error) {
      logger.error("failed to resize main window", error);
    }
    setBootCompleted(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!isTauriRuntime()) {
      setWindowLabel("browser");
      return;
    }
    void import("@tauri-apps/api/window")
      .then((windowApi) => {
        if (cancelled) return;
        const windowApiCompat = windowApi as typeof windowApi & {
          getCurrentWebviewWindow?: () => ReturnType<typeof windowApi.getCurrentWindow>;
        };
        const currentWindow =
          typeof windowApiCompat.getCurrentWindow === "function"
            ? windowApiCompat.getCurrentWindow()
            : typeof windowApiCompat.getCurrentWebviewWindow === "function"
              ? windowApiCompat.getCurrentWebviewWindow()
              : null;
        const label = currentWindow?.label ?? "main";
        setWindowLabel(label);
        if (label === "main" && currentWindow) {
          void currentWindow.isVisible()
            .then((visible) => {
              if (!cancelled && visible) setMainActivated(true);
            })
            .catch((error) => {
              logger.warn("failed to restore visible main window", { error: String(error) });
            });
        }
      })
      .catch((error) => {
        logger.error("failed to read current window label", error);
        if (!cancelled) setWindowLabel("main");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime() || windowLabel !== "main") return;
    let cleanup: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen("app:enter-main", () => setMainActivated(true)))
      .then((unlisten) => {
        cleanup = unlisten;
      })
      .catch((error) => {
        logger.error("failed to listen enter-main event", error);
      });
    return () => {
      cleanup?.();
    };
  }, [windowLabel]);

  const hashParams = new URLSearchParams(window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash);
  const hasChartWindowId = new URLSearchParams(window.location.search).has("chartWindowId") || hashParams.has("chartWindowId");
  if (hasChartWindowId) {
    return (
      <ErrorBoundary label={t("chart:detachedChartWindow")}>
        <ChartWindowPage initialWindowLabel={windowLabel} />
      </ErrorBoundary>
    );
  }

  if (windowLabel === null) {
    return <main className="startup-boot-screen" aria-label={t("common:startupAria")}><span>Desic Terminal</span><i /></main>;
  }
  const isChartWindow =
    windowLabel.startsWith("chart-");
  if (isChartWindow) {
    return (
      <ErrorBoundary label={t("chart:detachedChartWindow")}>
        <ChartWindowPage initialWindowLabel={windowLabel} />
      </ErrorBoundary>
    );
  }
  const showStartup = windowLabel === "splash" || (windowLabel === "browser" && !bootCompleted);
  const showTerminal = windowLabel === "browser" ? bootCompleted : windowLabel === "main" && mainActivated;

  return (
    <ErrorBoundary label={t("common:application")}>
      {showStartup ? <StartupGate onEnter={enterMain} /> : showTerminal ? <TradingTerminal marketAssets={marketAssets} /> : <main className="main-window-standby" />}
    </ErrorBoundary>
  );
}

function StartupGate({ onEnter, previewFailure }: { onEnter: (assets?: MarketAssetsSummary | null) => void; previewFailure?: "okx-network" }) {
  const { t } = useTranslation(["common", "settings"]);
  const [checks, setChecks] = useState<StartupCheck[]>(() => createInitialChecks(t));
  const [timeState, setTimeState] = useState<OkxTimeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proxyOpen, setProxyOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [assetsSummary, setAssetsSummary] = useState<MarketAssetsSummary | null>(null);

  const updateCheck = useCallback((id: string, patch: Partial<StartupCheck>) => {
    setChecks((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const runChecks = useCallback(async () => {
    setChecking(true);
    setError(null);
    setChecks(createInitialChecks(t));

    try {
      updateCheck("network", { status: "running", detail: t("common:startupCheckingOkxConnectivity") });
      if (previewFailure === "okx-network") {
        throw new Error(t("common:startupOkxUnavailable"));
      }
      const synced = await probeOkxStartupNetwork();
      setTimeState(synced);
      updateCheck("network", { status: "running", detail: t("common:startupConnectingPublicWs") });
      const [wsProbe, businessProbe, ticker] = await Promise.all([
        testPublicWsReachability(),
        testBusinessWsReachability(),
        fetchTicker(DEFAULT_SYMBOL)
      ]);
      updateCheck("network", {
        status: "passed",
        detail: `${wsProbe.message} · ${businessProbe.message} · ${t("common:startupLatestPrice", { price: fmtPrice(ticker.last) })}`,
        latencyMs: Math.max(synced.rttMs, wsProbe.latencyMs, businessProbe.latencyMs)
      });

      updateCheck("config", { status: "running", detail: t("common:startupReadingAccounts") });
      const migration = await migrateSensitiveConfig();
      const localAccounts = await loadAccounts();
      updateCheck("config", {
        status: "passed",
        detail: localAccounts.length > 0
          ? t("common:startupAccountsLoaded", { count: localAccounts.length, secured: migration?.aiConfigured ? t("common:startupAiCredentialsSecured") : "" })
          : t("common:startupPublicMarketOnly")
      });

      const readableAccount = localAccounts.find((item) => item.permissions.read);
      if (readableAccount) {
        updateCheck("privateWs", { status: "running", detail: t("common:startupCheckingPrivateWs", { account: readableAccount.name }) });
        const privateProbe = await testPrivateWsReachability(readableAccount.id);
        updateCheck("privateWs", {
          status: "passed",
          detail: privateProbe?.message ?? t("common:startupPrivateWsSkipped", { account: readableAccount.name }),
          latencyMs: privateProbe?.latencyMs
        });
      } else {
        updateCheck("privateWs", {
          status: "passed",
          detail: t(localAccounts.length > 0 ? "common:startupReadPermissionSkipped" : "common:startupNoAccountPrivateWsSkipped")
        });
      }

      updateCheck("time", { status: "running", detail: t("common:startupCalculatingTimeOffset") });
      const offsetText = `${synced.clockOffsetMs >= 0 ? "+" : ""}${synced.clockOffsetMs}ms`;
      updateCheck("time", { status: "passed", detail: t("common:startupTimeOffset", { offset: offsetText }) });

      updateCheck("assets", { status: "running", detail: t("common:startupPreparingAssets") });
      const assets = await syncMarketAssets();
      if (!assets) throw new Error(t("common:startupAssetsFailed"));
      const watchConfig = await loadWatchlistConfig().catch((error) => {
        logger.error("startup watchlist config load failed", error);
        return null;
      });
      const watchSymbols = watchConfig?.symbols?.length ? watchConfig.symbols : DEFAULT_WATCHLIST;
      const cachedAssets = await ensureInstrumentsCache(watchSymbols).catch((error) => {
        logger.error("startup watchlist instrument cache failed", error, { watchSymbols });
        return assets;
      });
      setAssetsSummary(cachedAssets ?? assets);
      updateCheck("assets", {
        status: "passed",
        detail: t("common:startupAssetsLoaded", { total: (cachedAssets ?? assets).total, cached: (cachedAssets ?? assets).iconCached })
      });

      updateCheck("database", { status: "running", detail: t("common:startupInitializingStorage") });
      const databasePath = await initLocalStorage();
      updateCheck("database", { status: "passed", detail: t(databasePath ? "common:startupSqliteReady" : "common:startupBrowserSqliteSkipped") });

      updateCheck("kline", { status: "running", detail: t("common:startupCheckingCandles", { count: watchSymbols.length }) });
      if (!isTauriRuntime()) {
        updateCheck("kline", { status: "passed", detail: t("common:startupBrowserCandlesSkipped") });
      } else {
        let unlistenKline: (() => void) | null = null;
        let klineSummary: Awaited<ReturnType<typeof syncKlineIntegrity>> = null;
        try {
          unlistenKline = await listenKlineSync((report) => {
            const detail = report.progressDetail || report.message;
            updateCheck("kline", { status: "running", detail: `${report.symbol} ${report.interval}：${detail}` });
          }).catch((error) => {
            logger.error("startup kline sync listener failed", error);
            return null;
          });
          klineSummary = await syncKlineIntegrity(watchSymbols, KLINE_INTEGRITY_INTERVALS, true, KLINE_STARTUP_RECENT_CHECK_HOURS, KLINE_REQUIRED_DAYS);
        } finally {
          unlistenKline?.();
        }
        const reports = klineSummary?.reports ?? [];
        const incomplete = reports.filter((report) => report.status !== "complete" || report.missing > 0 || report.invalid > 0);
        if (reports.length === 0) {
          throw new Error(t("common:startupCandlesNoResult"));
        }
        if (incomplete.length > 0) {
          const sample = incomplete.slice(0, 3).map((report) => `${report.symbol} ${report.interval} ${report.message}`).join("；");
          throw new Error(t("common:startupCandlesIncomplete", { detail: sample }));
        }
        const inserted = reports.reduce((sum, report) => sum + report.inserted, 0);
        updateCheck("kline", {
          status: "passed",
          detail: t("common:startupCandlesVerified", { count: reports.length, inserted })
        });
        void syncKlineIntegrity(watchSymbols, KLINE_INTEGRITY_INTERVALS, false, undefined, KLINE_REQUIRED_DAYS);
      }
      return cachedAssets ?? assets;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("startup check failed", err);
      setError(message);
      setChecks((items) =>
        items.map((item) => (item.status === "running" ? { ...item, status: "failed", detail: message } : item))
      );
      return;
    } finally {
      setChecking(false);
    }
  }, [previewFailure, t, updateCheck]);

  useEffect(() => {
    void runChecks();
  }, [runChecks]);

  const allRequiredPassed = checks.every((check) => check.status === "passed");
  const progress = Math.round((checks.filter((check) => check.status === "passed").length / checks.length) * 100);
  const runningCheck = checks.find((check) => check.status === "running");
  const failedCheck = checks.find((check) => check.status === "failed");
  const failedIsOkxNetwork = failedCheck
    ? ["network", "privateWs"].includes(failedCheck.id)
      || /OKX Public REST|网络不可达|连接失败|connection refused|tunnel error|tcp connect error|代理/i.test(failedCheck.detail)
    : false;
  const loadingText = t(failedCheck ? "common:startupChecksFailed" : "common:startupStartingTerminal");
  const checkDetailText = failedCheck
    ? failedIsOkxNetwork
      ? t("common:startupOkxUnavailable")
      : t("common:startupCheckFailedDetail", { label: failedCheck.label, detail: failedCheck.detail })
    : runningCheck?.detail ?? t(allRequiredPassed ? "common:startupEnteringTerminal" : "common:startupCheckingLocalConfig");

  useEffect(() => {
    if (!allRequiredPassed) return;
    const timer = window.setTimeout(() => onEnter(assetsSummary), 650);
    return () => window.clearTimeout(timer);
  }, [allRequiredPassed, assetsSummary, onEnter]);

  return (
    <main className="startup-shell">
      <div className="startup-original">
      <section className="stage" aria-label={t("common:startupAria")}>
        <header className="chrome">
          <div className="brand" aria-label="Desic Terminal">
            <img className="brand-icon" src="/assets/brand/desic-terminal-icon.png" alt="" aria-hidden="true" />
            Desic Terminal
          </div>
          <div className="startup-head-actions">
            <button className="startup-proxy-trigger" type="button" onClick={() => setProxyOpen(true)}>
              <Settings size={14} />
              <span>{t("settings:configureProxy")}</span>
            </button>
            <div className="status-pill">
              <span className="pulse-dot" aria-hidden="true" />
              <span>{t(allRequiredPassed ? "common:startupReadyToEnter" : "common:startupDesktopBoot")}</span>
            </div>
          </div>
        </header>

        <div className="tile one"><span /><span /><span /><span /><span /><span /></div>
        <div className="tile two"><span /><span /><span /><span /><span /><span /></div>
        <div className="tile purple three"><span /><span /><span /><span /><span /><span /></div>
        <div className="tile purple four"><span /><span /><span /><span /></div>

        <section className="hero">
          <div className="copy">
            <div className="version">{t("common:startupSecureMarketSession")}</div>
            <h1>{t("common:startupHeroTitleLine1")}<br />{t("common:startupHeroTitleLine2")}</h1>
            <p className="subtitle">{t("common:startupSubtitle")}</p>
            <div className="metrics" aria-label={t("common:startupMetricsAria")}>
              <div className="metric"><strong>{timeState ? fmtDelay(timeState.rttMs) : "--"}</strong><span>{t("common:networkLatency")}</span></div>
              <div className="metric"><strong>{DEFAULT_WATCHLIST.length}</strong><span>{t("common:marketSymbols")}</span></div>
              <div className="metric"><strong>{t(allRequiredPassed ? "common:startupStateReady" : "common:startupStateLocked")}</strong><span>{t("common:riskStatus")}</span></div>
            </div>
          </div>

          <div className="visual">
            <StartupOrbitalCanvas />
            <aside className="terminal" aria-label={t("common:marketStatus")}>
              <div className="terminal-head">
                <span>{t("common:startupMarketSync")}</span>
                <span className={allRequiredPassed ? "up" : "violet"}>{t(allRequiredPassed ? "common:startupStateLive" : "common:startupStateSync")}</span>
              </div>
              <div className="ticks">
                {[DEFAULT_SYMBOL, "ETH-USDT-SWAP", "SOL-USDT-SWAP", "AI-INDEX"].map((item, index) => (
                  <div className="tick" key={item}>
                    <b>{item === "AI-INDEX" ? "AI INDEX" : item.replace("-USDT-SWAP", "/USDT")}</b>
                    <div className="spark" style={{ "--w": `${76 - index * 10}%` } as CSSProperties} />
                    <span className={index === 2 ? "down" : "up"}>{item === DEFAULT_SYMBOL && allRequiredPassed ? t("common:startupStateLive") : index === 2 ? "-0.36%" : "+1.42%"}</span>
                  </div>
                ))}
              </div>
            </aside>
          </div>
        </section>

        <section className="loading" aria-label={t("common:loadingProgress")}>
          <div className="load-label">
            <span aria-hidden="true">◌</span>
            <span>{loadingText}</span>
          </div>
          <div className="percent">{progress}%</div>
          <div className={clsx("startup-check-inline", failedCheck && "failed")}>
            <span className="startup-check-message" title={failedCheck?.detail}>{checkDetailText}</span>
            {failedCheck && (
              <div className="startup-check-actions">
                {failedIsOkxNetwork && (
                  <button type="button" onClick={() => setProxyOpen(true)}>
                    <Settings size={13} />
                    <span>{t("settings:proxy")}</span>
                  </button>
                )}
                <button type="button" onClick={() => void runChecks()} disabled={checking}>
                  <RefreshCw className={checking ? "spin" : undefined} size={13} />
                  <span>{t(checking ? "common:checking" : "common:retry")}</span>
                </button>
              </div>
            )}
          </div>
          <div className="bar"><div className="bar-fill" style={{ width: `${progress}%` }} /></div>
        </section>

        <div className="ticker" aria-hidden="true">
          <div className="ticker-track">
            <span>OKX PERP <b className="up">{t(allRequiredPassed ? "common:startupStateOnline" : "common:startupStateChecking")}</b></span>
            <span>{t("common:startupTimeSync")} <b className="violet">{timeState ? `${timeState.clockOffsetMs}MS` : t("common:startupStateWaiting")}</b></span>
            <span>{t("common:startupRiskEngine")} <b className={allRequiredPassed ? "up" : "violet"}>{t(allRequiredPassed ? "common:startupStateReady" : "common:startupStateLocked")}</b></span>
            <span>{t("common:startupDataBus")} <b className={error ? "down" : "up"}>{t(error ? "common:startupStateBlocked" : "common:startupStateOnline")}</b></span>
            <span>{t("common:startupSecureSession")} <b className="violet">{t("common:startupStateEncrypted")}</b></span>
          </div>
        </div>
      </section>
      {proxyOpen && (
        <ModalShell
          title={t("settings:startupProxy")}
          description={t("settings:startupProxyDescription")}
          compact
          className="proxy-modal startup-proxy-modal"
          onClose={() => setProxyOpen(false)}
        >
          <ProxySettingsPane
            onSaved={(summary) => {
              logger.info("startup proxy config saved", {
                enabled: summary.enabled,
                proxyType: summary.proxyType,
                host: summary.host,
                port: summary.port
              });
              setProxyOpen(false);
              void runChecks();
            }}
            onNotify={(notification) => {
              const context = { title: notification.title, message: notification.message };
              if (notification.kind === "error") logger.error("startup proxy action failed", undefined, context);
              else logger.info("startup proxy action", context);
            }}
          />
        </ModalShell>
      )}
      </div>
    </main>
  );
}

export function StartupPreview() {
  return <StartupGate onEnter={() => undefined} previewFailure="okx-network" />;
}

function useClockTick() {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setTick(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return tick;
}

function HotPriceStrip({ timeState }: { timeState: OkxTimeState | null }) {
  const { t } = useTranslation(["trading", "common"]);
  const lastRef = useRef<HTMLElement | null>(null);
  const markRef = useRef<HTMLSpanElement | null>(null);
  const changeRef = useRef<HTMLSpanElement | null>(null);
  const highRef = useRef<HTMLSpanElement | null>(null);
  const lowRef = useRef<HTMLSpanElement | null>(null);
  const volumeRef = useRef<HTMLSpanElement | null>(null);
  const detailLastRef = useRef<HTMLElement | null>(null);
  const detailChangeRef = useRef<HTMLElement | null>(null);
  const detailHighRef = useRef<HTMLElement | null>(null);
  const detailLowRef = useRef<HTMLElement | null>(null);
  const detailVolumeRef = useRef<HTMLElement | null>(null);
  const detailFundingRef = useRef<HTMLDivElement | null>(null);
  const detailFundingRateRef = useRef<HTMLElement | null>(null);
  const detailFundingCountdownRef = useRef<HTMLElement | null>(null);
  const fundingRef = useRef<HTMLSpanElement | null>(null);
  const fundingRateRef = useRef<HTMLElement | null>(null);
  const fundingCountdownRef = useRef<HTMLElement | null>(null);
  const tickerSignatureRef = useRef("");
  const fundingSignatureRef = useRef("");
  const update = useCallback(() => {
    const { ticker, fundingRate } = getMarketHotState();
    const change = calcChange(ticker?.last, ticker?.open24h);
    const tickerSignature = ticker ? [ticker.last, ticker.open24h, ticker.high24h, ticker.low24h, ticker.volCcy24h].join("|") : "";
    if (tickerSignatureRef.current !== tickerSignature) {
      tickerSignatureRef.current = tickerSignature;
      if (lastRef.current) {
        lastRef.current.textContent = fmtPrice(ticker?.last);
        lastRef.current.className = change >= 0 ? "up" : "down";
      }
      if (markRef.current) markRef.current.textContent = `${t("trading:markPrice")} ${fmtPrice(ticker?.last)}`;
      if (changeRef.current) changeRef.current.textContent = `24H ${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
      if (highRef.current) highRef.current.textContent = `${t("trading:high")} ${fmtPrice(ticker?.high24h)}`;
      if (lowRef.current) lowRef.current.textContent = `${t("trading:low")} ${fmtPrice(ticker?.low24h)}`;
      if (volumeRef.current) volumeRef.current.textContent = `${t("trading:volume")} ${fmtCompact(ticker?.volCcy24h)} USDT`;
      if (detailLastRef.current) detailLastRef.current.textContent = fmtPrice(ticker?.last);
      if (detailChangeRef.current) {
        detailChangeRef.current.textContent = `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
        detailChangeRef.current.classList.toggle("up", change >= 0);
        detailChangeRef.current.classList.toggle("down", change < 0);
      }
      if (detailHighRef.current) detailHighRef.current.textContent = fmtPrice(ticker?.high24h);
      if (detailLowRef.current) detailLowRef.current.textContent = fmtPrice(ticker?.low24h);
      if (detailVolumeRef.current) {
        const volume = Number(ticker?.volCcy24h);
        detailVolumeRef.current.textContent = Number.isFinite(volume)
          ? `${formatLocalizedNumber(volume, { maximumFractionDigits: 2 })} USDT`
          : "--";
      }
    }
    if (fundingRef.current) {
      const rate = formatFundingRatePercent(fundingRate?.fundingRate);
      const now = Date.now() + (timeState?.clockOffsetMs ?? 0);
      const fundingSignature = `${rate ?? ""}|${fundingRate?.fundingTime ?? 0}|${Math.floor(now / 1_000)}`;
      if (fundingSignatureRef.current !== fundingSignature) {
        fundingSignatureRef.current = fundingSignature;
        fundingRef.current.hidden = !rate;
        if (detailFundingRef.current) detailFundingRef.current.hidden = !rate;
        if (fundingRateRef.current) fundingRateRef.current.textContent = rate ? `${t("trading:fundingRate")} ${rate}` : "";
        if (fundingCountdownRef.current) fundingCountdownRef.current.textContent = rate ? `/ ${formatFundingCountdown(fundingRate?.fundingTime, now)}` : "";
        if (detailFundingRateRef.current) detailFundingRateRef.current.textContent = rate || "--";
        if (detailFundingCountdownRef.current) detailFundingCountdownRef.current.textContent = rate ? formatFundingCountdown(fundingRate?.fundingTime, now) : "";
      }
    }
  }, [t, timeState?.clockOffsetMs]);
  useEffect(() => {
    tickerSignatureRef.current = "";
    fundingSignatureRef.current = "";
    update();
    const unsubscribe = useMarketHotStore.subscribe(update);
    const timer = window.setInterval(update, 1_000);
    return () => { unsubscribe(); window.clearInterval(timer); };
  }, [update]);
  return (
    <div className="price-strip" tabIndex={0} aria-label={t("trading:marketData")} aria-describedby="market-price-tooltip">
      <div className="price-strip-values">
        <strong ref={lastRef}>--</strong>
        <span ref={markRef}>{t("trading:markPrice")} --</span>
        <span ref={changeRef}>24H --</span>
        <span ref={highRef}>{t("trading:high")} --</span>
        <span ref={lowRef}>{t("trading:low")} --</span>
        <span ref={volumeRef}>{t("trading:volume")} -- USDT</span>
        <span ref={fundingRef} className="funding-chip" hidden><b ref={fundingRateRef} /><em ref={fundingCountdownRef} /></span>
      </div>
      <div className="price-strip-tooltip" id="market-price-tooltip" role="tooltip">
        <div className="price-strip-tooltip-grid">
          <div className="price-strip-tooltip-cell">
            <span>{t("trading:markPrice")}</span>
            <strong ref={detailLastRef}>--</strong>
          </div>
          <div className="price-strip-tooltip-cell">
            <span>24H</span>
            <strong ref={detailChangeRef}>--</strong>
          </div>
          <div className="price-strip-tooltip-cell">
            <span>{t("trading:high")}</span>
            <strong ref={detailHighRef}>--</strong>
          </div>
          <div className="price-strip-tooltip-cell">
            <span>{t("trading:low")}</span>
            <strong ref={detailLowRef}>--</strong>
          </div>
          <div className="price-strip-tooltip-cell price-strip-tooltip-volume">
            <span>{t("trading:volume")}</span>
            <strong ref={detailVolumeRef}>--</strong>
          </div>
          <div ref={detailFundingRef} className="price-strip-tooltip-cell" hidden>
            <span>{t("trading:fundingRate")}</span>
            <strong ref={detailFundingRateRef}>--</strong>
            <small ref={detailFundingCountdownRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

type ConnectionRow = { key: string; label: string; status: string; delay?: number; state?: string; detail?: string };

function HotConnectionStatus({
  timeState,
  businessWsStatus,
  accounts,
  privateStatuses,
  expectedPublicStreams
}: {
  timeState: OkxTimeState | null;
  businessWsStatus: string;
  accounts: AccountSummary[];
  privateStatuses: Record<string, PrivateWsStatus>;
  expectedPublicStreams: number;
}) {
  const { t } = useTranslation(["trading", "common"]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const clockTick = useClockTick();
  const publicStreamStatuses = useMarketHotStore((state) => state.publicStreamStatuses);
  const businessLastMessageAt = useMarketHotStore((state) => state.businessLastMessageAt);
  const okxNow = timeState ? clockTick + timeState.clockOffsetMs : clockTick;
  const ticker = getMarketHotState().ticker;
  const dataDelay = ticker ? okxNow - ticker.ts : undefined;
  const businessDataDelay = businessLastMessageAt ? clockTick - businessLastMessageAt : undefined;
  const publicWsStatus = summarizePublicWsStatus(publicStreamStatuses, expectedPublicStreams);
  const publicRows = [...Object.values(publicStreamStatuses)]
    .sort((left, right) => publicStreamSortKey(left.streamId).localeCompare(publicStreamSortKey(right.streamId)))
    .map((status) => {
      const receivedAge = typeof status.lastReceivedAt === "number"
        ? Math.max(0, clockTick - status.lastReceivedAt)
        : 0;
      const delay = typeof status.delayMs === "number"
        ? Math.max(0, status.delayMs + receivedAge)
        : typeof status.lastReceivedAt === "number"
          ? receivedAge
          : undefined;
      return {
        key: status.streamId,
        label: formatPublicStreamLabel(status, t),
        status: formatWsStatus(status.status, t),
        delay,
        state: status.state,
        detail: status.kind === "meta"
          ? `${t("trading:tickerTradesFunding")} · ${status.symbols.join(", ")}`
          : status.symbols.join(", ")
      };
    });
  const privateRows = accounts
    .filter((item) => item.permissions.read)
    .map((item) => {
      const key = privateAccountKey(item.id, item.environment);
      const status = key ? privateStatuses[key] : undefined;
      const lastReceivedAt = status?.lastReceivedAt ?? status?.eventAt;
      return {
        key: key ?? item.id,
        label: `${item.name} · ${t(item.environment === "live" ? "common:live" : "common:demo")}`,
        status: status ? formatPrivateWsStatus(status, t) : t("common:connecting"),
        delay: lastReceivedAt ? Math.max(0, okxNow - lastReceivedAt) : undefined,
        state: status?.state
      };
    });
  useEffect(() => {
    if (!detailsOpen) return;
    const closeIfOutside = (event: PointerEvent) => {
      if (containerRef.current?.contains(event.target as Node)) return;
      setDetailsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetailsOpen(false);
    };
    document.addEventListener("pointerdown", closeIfOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeIfOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [detailsOpen]);
  return (
    <div
      ref={containerRef}
      className={clsx("status-pill connection-status", dataDelay && dataDelay > 1000 && "warn", detailsOpen && "open")}
      tabIndex={0}
      role="button"
      aria-expanded={detailsOpen}
      aria-describedby="wss-latency-tooltip"
      data-expected-public-streams={expectedPublicStreams}
      onClick={() => setDetailsOpen((open) => !open)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setDetailsOpen((open) => !open);
        }
      }}
    >
      <Wifi size={14} /><span>{fmtDelay(dataDelay)}</span><small>{formatWsStatus(publicWsStatus, t)}</small>
      <div className="connection-tooltip" id="wss-latency-tooltip" role="tooltip" onClick={(event) => event.stopPropagation()}>
        <div className="connection-tooltip-head"><strong>{t("trading:wssConnectionStatus")}</strong><span>{t("trading:recentDataMessages")}</span></div>
        {publicRows.length > 0
          ? publicRows.map((row) => <ConnectionTooltipRow key={row.key} label={row.label} status={row.status} delay={row.delay} state={row.state} detail={row.detail} />)
          : <ConnectionTooltipRow label="Public WS" status={formatWsStatus(publicWsStatus, t)} delay={dataDelay} state={publicWsStatus} />}
        <ConnectionTooltipRow label="Business WS" status={formatWsStatus(businessWsStatus, t)} delay={businessDataDelay} state={businessWsStatus} />
        {privateRows.length > 0
          ? privateRows.map((row) => <ConnectionTooltipRow key={row.key} label={`Private WS · ${row.label}`} status={row.status} delay={row.delay} state={row.state} />)
          : <ConnectionTooltipRow label="Private WS" status={t("trading:noReadableAccount")} state="stopped" />}
      </div>
    </div>
  );
}

function HotWatchQuote({ symbol }: { symbol: string }) {
  const priceRef = useRef<HTMLElement | null>(null);
  const changeRef = useRef<HTMLElement | null>(null);
  const signatureRef = useRef("");
  useEffect(() => {
    const update = () => {
      const ticker = getMarketHotState().watchTickers[symbol];
      const signature = ticker ? `${ticker.last}|${ticker.open24h}` : "";
      if (signatureRef.current === signature) return;
      signatureRef.current = signature;
      const change = calcChange(ticker?.last, ticker?.open24h);
      if (priceRef.current) priceRef.current.textContent = fmtPrice(ticker?.last);
      if (changeRef.current) {
        changeRef.current.textContent = ticker ? `${change.toFixed(2)}%` : "--";
        changeRef.current.className = change < 0 ? "down" : "up";
      }
    };
    update();
    return useMarketHotStore.subscribe(update);
  }, [symbol]);
  return <span className="symbol-quote"><strong ref={priceRef}>--</strong><em ref={changeRef}>--</em></span>;
}

type HotKlineChartProps = Omit<Parameters<typeof KlineChart>[0], "ticker" | "candles" | "orderBook" | "recentTrades" | "fundingRate" | "positionRanges"> & {
  positions: OkxPosition[];
  algoOrders: OkxAlgoOrder[];
  instrument?: OkxInstrumentSummary;
};

const EMPTY_HOT_CANDLES: Candle[] = [];

function HotKlineChart({ positions, algoOrders, instrument, ...props }: HotKlineChartProps) {
  const { t } = useTranslation(["trading", "chart"]);
  const seriesKey = `${props.symbol ?? DEFAULT_SYMBOL}\u0000${props.timeframe ?? "30m"}`;
  const candles = useMarketHotStore((state) => state.candleSeriesKey === seriesKey ? state.candles : EMPTY_HOT_CANDLES);
  const tickerLast = useMarketHotStore((state) => state.ticker?.last ?? "");
  const liveCandles = useMemo(() => applyLivePriceToLatestCandle(candles, tickerLast), [candles, tickerLast]);
  const ticker = tickerLast ? getMarketHotState().ticker : null;
  const positionRanges = useMemo(() => buildSharedChartPositionRanges(t, props.symbol ?? DEFAULT_SYMBOL, positions, ticker, algoOrders, instrument), [algoOrders, instrument, positions, props.symbol, t, ticker]);
  return <KlineChart {...props} ticker={ticker} candles={liveCandles} positionRanges={positionRanges} />;
}

function HotChartDataTable(props: Omit<Parameters<typeof ChartDataTable>[0], "candles">) {
  const seriesKey = `${props.symbol}\u0000${props.timeframe}`;
  const candles = useMarketHotStore((state) => state.candleSeriesKey === seriesKey ? state.candles : EMPTY_HOT_CANDLES);
  return <ChartDataTable {...props} candles={candles} />;
}

function HotMarketDepth({ onPriceSelect }: { onPriceSelect?: (price: string) => void }) {
  const { t } = useTranslation(["trading", "common"]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const signatureRef = useRef("");
  useEffect(() => {
    const update = () => {
      const root = rootRef.current;
      if (!root) return;
      const { book, ticker, trades } = getMarketHotState();
      const signature = `${book?.ts ?? 0}:${book?.seqId ?? ""}:${ticker?.ts ?? 0}:${ticker?.last ?? ""}:${trades.slice(0, 18).map((trade) => trade.tradeId).join(",")}`;
      if (signatureRef.current === signature) return;
      signatureRef.current = signature;
      const visibleBids = getVisibleDepthLevels(book?.bids ?? [], "bid").slice(0, 5);
      const visibleAsks = getVisibleDepthLevels(book?.asks ?? [], "ask").slice(0, 5).reverse();
      const visibleLevels = [...padDepthLevels(visibleAsks, 5), ...padDepthLevels(visibleBids, 5)];
      const maxVisibleSize = Math.max(1, ...visibleLevels.map((level) => Number(level?.sz || 0)));
      const depthRows = [...root.querySelectorAll<HTMLElement>(".orderbook .depth-row")];
      visibleLevels.forEach((level, index) => {
        const row = depthRows[index];
        if (!row) return;
        const cells = row.querySelectorAll<HTMLElement>("span");
        if (cells[0]) cells[0].textContent = formatOrderBookPrice(level?.px);
        if (cells[1]) cells[1].textContent = formatDepthSize(Number(level?.sz || 0));
        if (level?.px) row.dataset.price = level.px;
        else delete row.dataset.price;
        row.tabIndex = level ? 0 : -1;
        row.setAttribute("aria-disabled", level ? "false" : "true");
        row.setAttribute(
          "aria-label",
          level
            ? `${t("trading:fillFromOrderBook")}: ${t(index < 5 ? "trading:sell" : "trading:buy")} ${level.px}`
            : t("trading:waitingOrderBook")
        );
        row.classList.toggle("empty", !level);
        row.style.setProperty("--depth-fill", `${level ? Math.max(4, Math.min(100, (Number(level.sz) / maxVisibleSize) * 100)) : 0}%`);
      });
      const mid = root.querySelector<HTMLElement>(".mid-price");
      if (mid) {
        const value = ticker?.last
          ? formatOrderBookPrice(ticker.last)
          : trades[0]?.px
            ? formatOrderBookPrice(trades[0].px)
            : visibleBids[0]
              ? formatOrderBookPrice(visibleBids[0].px)
              : "--";
        mid.firstChild!.textContent = `${value} `;
        mid.dataset.marketPrice = value;
      }
      const bidSize = sumLevels(book?.bids ?? []);
      const askSize = sumLevels(book?.asks ?? []);
      const total = bidSize + askSize;
      const bidPercent = total > 0 ? Math.round((bidSize / total) * 100) : 50;
      const askPercent = 100 - bidPercent;
      const pressureTrades = trades.slice(0, 24);
      const buySize = pressureTrades.reduce((sum, trade) => sum + (trade.side === "buy" ? Number(trade.sz || 0) : 0), 0);
      const sellSize = pressureTrades.reduce((sum, trade) => sum + (trade.side === "sell" ? Number(trade.sz || 0) : 0), 0);
      const tradeBias = buySize + sellSize > 0 ? Math.round((buySize / (buySize + sellSize)) * 100) : 50;
      const pressureScore = Math.round((bidPercent - askPercent) * 0.62 + (tradeBias - (100 - tradeBias)) * 0.38);
      const panel = root.querySelector<HTMLElement>(".pressure-panel");
      if (panel) {
        panel.className = `pressure-panel pressure-${pressureScore >= 0 ? "bid" : "ask"}`;
        panel.style.setProperty("--pressure-score", `${pressureScore}%`);
        panel.style.setProperty("--pressure-strength", String(Math.min(100, Math.abs(pressureScore))));
        panel.style.setProperty("--trade-bias", `${tradeBias}%`);
      }
      const pressureSides = root.querySelectorAll<HTMLElement>(".pressure-side");
      if (pressureSides[0]) pressureSides[0].style.width = `${bidPercent}%`;
      if (pressureSides[1]) pressureSides[1].style.width = `${askPercent}%`;
      const pressureText = root.querySelector<HTMLElement>(".pressure-head strong");
      if (pressureText) {
        pressureText.className = bidPercent >= askPercent ? "up" : "down";
        pressureText.textContent = `${total > 0
          ? i18n.t(bidPercent >= askPercent ? "trading:bidDominant" : "trading:askDominant")
          : i18n.t("trading:waitingOrderBook")} ${pressureScore >= 0 ? "+" : ""}${pressureScore}`;
      }
      const meta = root.querySelectorAll<HTMLElement>(".pressure-meta span");
      if (meta[0]) meta[0].textContent = `${i18n.t("trading:buy")} ${bidPercent}%`;
      if (meta[1]) meta[1].textContent = `${i18n.t("trading:activeBuy")} ${tradeBias}%`;
      if (meta[2]) meta[2].textContent = `${i18n.t("trading:sell")} ${askPercent}%`;
      const tickerLeadsTrades = Boolean(ticker?.last)
        && (!trades[0] || ticker!.ts > trades[0].ts || (ticker!.ts === trades[0].ts && ticker!.last !== trades[0].px));
      const recent = tickerLeadsTrades && ticker
        ? [{ tradeId: `ticker-${ticker.ts}`, px: ticker.last, sz: ticker.lastSz, side: null, ts: ticker.ts }, ...trades].slice(0, 24)
        : trades.slice(0, 24);
      const tradeRows = root.querySelectorAll<HTMLElement>(".recent-trades .trade-row");
      tradeRows.forEach((row, index) => {
        const trade = recent[index];
        row.hidden = !trade;
        if (!trade) return;
        const cells = row.querySelectorAll<HTMLElement>("span");
        if (cells[0]) { cells[0].className = trade.side === "buy" ? "up" : trade.side === "sell" ? "down" : ""; cells[0].textContent = fmtPrice(trade.px); }
        if (cells[1]) cells[1].textContent = Number(trade.sz).toFixed(3);
        if (cells[2]) cells[2].textContent = formatTradeMs(trade.ts);
      });
    };
    update();
    return useMarketHotStore.subscribe(update);
  }, [t]);
  return (
    <div
      ref={rootRef}
      className="market-depth-live"
      onClick={(event) => {
        const row = (event.target as Element).closest<HTMLElement>(".depth-row[data-price]");
        if (row?.dataset.price) onPriceSelect?.(row.dataset.price);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const row = (event.target as Element).closest<HTMLElement>(".depth-row[data-price]");
        if (!row?.dataset.price) return;
        event.preventDefault();
        onPriceSelect?.(row.dataset.price);
      }}
    >
      <div className="orderbook">
        <div className="depth-head"><span>{t("trading:priceUsdt")}</span><span>{t("trading:quantityContracts")}</span></div>
        {Array.from({ length: 5 }, (_, index) => <DepthRow key={`a-${index}`} level={null} side="ask" />)}
        <div className="mid-price">-- <span>{t("trading:liveOrderBook")}</span></div>
        {Array.from({ length: 5 }, (_, index) => <DepthRow key={`b-${index}`} level={null} side="bid" />)}
      </div>
      <div className="pressure-panel pressure-bid">
        <div className="pressure-head"><span>{t("trading:marketPressure")}</span><strong>{t("trading:waitingOrderBook")} +0</strong></div>
        <div className="pressure-battle" aria-label={t("trading:marketPressure")}><div className="pressure-side bid" /><div className="pressure-side ask" /><div className="pressure-flow" aria-hidden="true">{Array.from({ length: 7 }, (_, index) => <i key={index} style={{ "--pulse-index": index } as CSSProperties} />)}</div><span className="pressure-midline" /><span className="pressure-balance-dot" /></div>
        <div className="pressure-trade-track" aria-label={t("trading:activeBuy")}><span className="trade-bias-fill" /></div>
        <div className="pressure-meta"><span className="up">{t("trading:buy")} 50%</span><span>{t("trading:activeBuy")} 50%</span><span className="down">{t("trading:sell")} 50%</span></div>
      </div>
      <div className="recent-trades"><h3>{t("trading:latestTrades")}</h3>{Array.from({ length: 18 }, (_, index) => <div className="trade-row" key={index} hidden><span /><span /><span /></div>)}</div>
    </div>
  );
}

function HotDepthModal({ symbol, onClose }: { symbol: string; onClose: () => void }) {
  const book = useMarketHotStore((state) => state.book);
  return <DepthModal symbol={symbol} book={book} onClose={onClose} />;
}

function HotBottomPanel(props: Omit<Parameters<typeof BottomPanel>[0], "ticker">) {
  const ticker = getMarketHotState().ticker;
  return <BottomPanel {...props} ticker={ticker} />;
}

function HotOrderTicket(props: Omit<Parameters<typeof OrderTicket>[0], "ticker" | "latencyGuard" | "bestBid" | "bestAsk"> & { timeState: OkxTimeState | null; privateEventTime: number | null; expectedPublicStreams: number }) {
  const clockTick = useClockTick();
  const tickerLast = useMarketHotStore((state) => state.ticker?.last ?? "");
  const ticker = tickerLast ? getMarketHotState().ticker : null;
  const bestBid = useMarketHotStore((state) => state.book?.bids[0]?.px ?? "");
  const bestAsk = useMarketHotStore((state) => state.book?.asks[0]?.px ?? "");
  const publicStreamStatuses = useMarketHotStore((state) => state.publicStreamStatuses);
  const { timeState, privateEventTime, expectedPublicStreams, ...ticketProps } = props;
  const okxNow = timeState ? clockTick + timeState.clockOffsetMs : clockTick;
  const publicStatus = summarizePublicWsStatus(publicStreamStatuses, expectedPublicStreams);
  const latencyGuard = buildTradeLatencyGuard({
    timeSynced: Boolean(timeState),
    publicDelayMs: ticker ? okxNow - ticker.ts : undefined,
    privateDelayMs: privateEventTime ? okxNow - privateEventTime : undefined,
    publicStatus: formatWsStatus(publicStatus),
    privateStatus: ticketProps.privateStatus
  });
  return <OrderTicket {...ticketProps} ticker={ticker} bestBid={bestBid} bestAsk={bestAsk} latencyGuard={latencyGuard} />;
}

function TradingTerminal({
  marketAssets: initialMarketAssets,
  previewAccounts = EMPTY_PREVIEW_ACCOUNTS,
  previewPendingOrder = false,
  previewMarketConsistency = false
}: {
  marketAssets: MarketAssetsSummary | null;
  previewAccounts?: AccountSummary[];
  previewPendingOrder?: boolean;
  previewMarketConsistency?: boolean;
}) {
  const { t, i18n: translation } = useTranslation(["navigation", "common", "trading", "chart", "automation", "settings", "help"]);
  const chineseUi = (translation.resolvedLanguage ?? translation.language).toLowerCase().startsWith("zh");
  const uiText = useCallback((chinese: string, english: string) => chineseUi ? chinese : english, [chineseUi]);
  const [symbol, setSymbol] = useState(DEFAULT_SYMBOL);
  const [ticketPriceFill, setTicketPriceFill] = useState<{ symbol: string; price: string; nonce: number } | null>(null);
  const [watchlist, setWatchlist] = useState<string[]>(() => loadWatchlist());
  const [marketPickerOpen, setMarketPickerOpen] = useState(false);
  const marketPickerRef = useRef<HTMLDivElement | null>(null);
  const [compactTerminalLayout, setCompactTerminalLayout] = useState(() => window.matchMedia(COMPACT_TERMINAL_MEDIA_QUERY).matches);
  const [marketAssets, setMarketAssets] = useState<MarketAssetsSummary | null>(initialMarketAssets);
  const [symbolSearch, setSymbolSearch] = useState("");
  const [bar, setBar] = useState("30m");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [marketCandleLoadError, setMarketCandleLoadError] = useState<{ symbol: string; bar: string; message: string } | null>(null);
  const [marketCandleReloadToken, setMarketCandleReloadToken] = useState(0);
  const [timeState, setTimeState] = useState<OkxTimeState | null>(null);
  const [accounts, setAccounts] = useState<AccountSummary[]>(() => previewAccounts);
  const [accountsReady, setAccountsReady] = useState(previewAccounts.length > 0);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(() => previewAccounts[0]?.id ?? null);
  const [privateSnapshot, setPrivateSnapshot] = useState<PrivateAccountSnapshot | null>(() => buildTerminalPreviewPrivateSnapshot(previewAccounts[0], previewPendingOrder));
  const [optimisticPendingOrders, setOptimisticPendingOrders] = useState<OptimisticPendingOrder[]>([]);
  const [privateStatus, setPrivateStatus] = useState("等待账号");
  const [privateEventTime, setPrivateEventTime] = useState<number | null>(null);
  const [privateSnapshots, setPrivateSnapshots] = useState<Record<string, PrivateAccountSnapshot>>(() => {
    const snapshot = buildTerminalPreviewPrivateSnapshot(previewAccounts[0], previewPendingOrder);
    const key = snapshot ? privateAccountKey(snapshot.accountId, snapshot.environment) : null;
    return snapshot && key ? { [key]: snapshot } : {};
  });
  const [privateStatuses, setPrivateStatuses] = useState<Record<string, PrivateWsStatus>>({});
  const symbolRef = useRef(symbol);
  const barRef = useRef(bar);
  const selectedAccountIdRef = useRef(selectedAccountId);
  const accountsRef = useRef(accounts);
  const privateWsStatusHandlerRef = useRef<(event: PrivateWsStatus) => void>(() => undefined);
  const triggerPrivateHistorySyncRef = useRef<(account: AccountSummary, reason: "startup" | "periodic" | "reconnect" | "fill") => void>(() => undefined);
  symbolRef.current = symbol;
  barRef.current = bar;
  selectedAccountIdRef.current = selectedAccountId;
  accountsRef.current = accounts;
  const [positionEpisodes, setPositionEpisodes] = useState<PositionEpisode[]>([]);
  const [episodesStatus, setEpisodesStatus] = useState("等待账号");
  const [historicalOrders, setHistoricalOrders] = useState<HistoricalOrderSummary[]>([]);
  const [historicalOrdersStatus, setHistoricalOrdersStatus] = useState("等待账号");
  const [historicalFills, setHistoricalFills] = useState<HistoricalFillSummary[]>([]);
  const [chartTradeSources, setChartTradeSources] = useState<ChartTradeSources | null>(null);
  const [historicalFillsStatus, setHistoricalFillsStatus] = useState("等待账号");
  const [algoOrders, setAlgoOrders] = useState<OkxAlgoOrder[]>([]);
  const [algoOrdersPendingReadComplete, setAlgoOrdersPendingReadComplete] =
    useState(false);
  const [algoOrdersStatus, setAlgoOrdersStatus] = useState("等待账号");
  const [accountBills, setAccountBills] = useState<AccountBillSummary[]>([]);
  const [accountBillsStatus, setAccountBillsStatus] = useState("等待账号");
  const [tradeAuditEvents, setTradeAuditEvents] = useState<TradeAuditEventSummary[]>([]);
  const [tradeAuditStatus, setTradeAuditStatus] = useState("等待账号");
  const [tradeOpportunities, setTradeOpportunities] = useState<TradeOpportunity[]>([]);
  const [tradeOpportunityStatus, setTradeOpportunityStatus] = useState("等待数据");
  const [selectedOpportunityId, setSelectedOpportunityId] = useState<string | null>(null);
  const [accountBillsArchiveStatus, setAccountBillsArchiveStatus] = useState<AccountBillsArchiveStatus | null>(null);
  const [accountBillsArchiveBusy, setAccountBillsArchiveBusy] = useState(false);
  const [accountBillsArchiveImporting, setAccountBillsArchiveImporting] = useState(false);
  const [privateHistoryVersion, setPrivateHistoryVersion] = useState(0);
  const [algoOrdersVersion, setAlgoOrdersVersion] = useState(0);
  const [privateHistoryStatus, setPrivateHistoryStatus] = useState<PrivateHistoryStatusResponse | null>(null);
  const [wsStatus, setWsStatus] = useState("连接中");
  const [businessWsStatus, setBusinessWsStatus] = useState("连接中");
  const [activeTab, setActiveTab] = useState("positions");
  const flattenPositionsTargetRef = useRef<HTMLDivElement | null>(null);
  const cancelOrdersTargetRef = useRef<HTMLDivElement | null>(null);
  const contentGridRef = useRef<HTMLDivElement | null>(null);
  const centerPanelRef = useRef<HTMLElement | null>(null);
  const chartResizeGestureRef = useRef<ChartResizeGesture | null>(null);
  const [mainSection, setMainSection] = useState<"terminal" | "opportunities" | "automation" | "intelligence" | "systematic" | "data" | "config">("terminal");
  const [pendingAiStrategyOpen, setPendingAiStrategyOpen] = useState<{ strategyId: string; runId?: string; optimizationId?: string } | null>(null);
  const [systematicLoading, setSystematicLoading] = useState(false);
  const [newsUnreadCount, setNewsUnreadCount] = useState(0);
  const [isMaximized, setIsMaximized] = useState(false);

  const openAiStrategy = useCallback((strategyId: string, runId?: string, optimizationId?: string) => {
    setMainSection("systematic");
    setPendingAiStrategyOpen({ strategyId, runId, optimizationId });
  }, []);

  const handleSystematicReady = useCallback(() => {
    setSystematicLoading(false);
  }, []);

  useEffect(() => {
    const media = window.matchMedia(COMPACT_TERMINAL_MEDIA_QUERY);
    const updateCompactTerminalLayout = () => setCompactTerminalLayout(media.matches);
    updateCompactTerminalLayout();
    media.addEventListener("change", updateCompactTerminalLayout);
    return () => media.removeEventListener("change", updateCompactTerminalLayout);
  }, []);

  const [klineSync, setKlineSync] = useState<Record<string, KlineSyncReport>>(
    {},
  );
  const [accountManagerOpen, setAccountManagerOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [notificationHistory, setNotificationHistory] = useState<AppNotification[]>(() => loadNotificationHistory());
  const [notificationCenterOpen, setNotificationCenterOpen] = useState(false);
  const [helpCenterOpen, setHelpCenterOpen] = useState(false);
  const helpSearchRef = useRef<HTMLInputElement | null>(null);
  const [chartPresentation, setChartPresentation] = useState<"chart" | "table">("chart");
  const [chartUtilitiesOpen, setChartUtilitiesOpen] = useState(false);
  const chartUtilitiesRef = useRef<HTMLDivElement | null>(null);
  const [pendingOrderLineEdit, setPendingOrderLineEdit] = useState<ChartOrderLineEdit | null>(null);
  const [pendingOrderLineCancel, setPendingOrderLineCancel] = useState<ChartOrderLine | null>(null);
  const [pendingPositionLineIntent, setPendingPositionLineIntent] = useState<PositionLineTradeIntent | null>(null);
  const [chartQuickTrade, setChartQuickTrade] = useState<ChartContextTradeIntent | null>(null);
  const [chartQuickTradeAccountConfig, setChartQuickTradeAccountConfig] = useState<ChartQuickTradeAccountConfig | null>(null);
  useEffect(() => {
    if (!chartUtilitiesOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !chartUtilitiesRef.current?.contains(target)) setChartUtilitiesOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setChartUtilitiesOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [chartUtilitiesOpen]);
  const handleChartTradeConfigChange = useCallback((next: ChartQuickTradeAccountConfig) => {
    persistChartQuickTradeAccountConfig(next);
    setChartQuickTradeAccountConfig((current) => current?.accountId === next.accountId && current?.environment === next.environment
      && current.symbol === next.symbol && current.marginMode === next.marginMode && current.leverage === next.leverage ? current : next);
  }, []);
  const [pendingChartRiskRewardIntent, setPendingChartRiskRewardIntent] = useState<ChartRiskRewardTradeIntent | null>(null);
  const [pendingOrderLineOverrides, setPendingOrderLineOverrides] = useState<Record<string, { price: number; expiresAt: number }>>({});
  const [liveConfirmOpen, setLiveConfirmOpen] = useState(false);
  const [pendingLiveAccountScope, setPendingLiveAccountScope] = useState<AccountEnvironmentScope | null>(null);
  const [pendingLivePreviousAccountScopeKey, setPendingLivePreviousAccountScopeKey] = useState<string | null>(null);
  const [liveRiskAcknowledged, setLiveRiskAcknowledged] = useState<Record<string, number>>(() => loadLiveRiskAcknowledgements());
  const approvedAccountScopeKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const unlock = () => unlockNotificationAudio();
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  const requestAccountSelection = useCallback((accountId: string | null) => {
    if (!accountId) {
      approvedAccountScopeKeyRef.current = null;
      setSelectedAccountId(null);
      return;
    }
    const nextAccount = accountsRef.current.find((item) => item.id === accountId);
    if (!nextAccount) return;
    const nextScopeKey = accountEnvironmentScopeKey(nextAccount);
    if (nextAccount.environment === "live" && !liveRiskAcknowledged[nextScopeKey]) {
      setPendingLivePreviousAccountScopeKey(approvedAccountScopeKeyRef.current);
      setPendingLiveAccountScope({ id: nextAccount.id, environment: nextAccount.environment });
      setLiveConfirmOpen(true);
      return;
    }
    approvedAccountScopeKeyRef.current = nextScopeKey;
    setSelectedAccountId(accountId);
  }, [liveRiskAcknowledged]);
  const [settingsActiveTab, setSettingsActiveTab] = useState<SettingsTab>("general");
  const [automationInitialTab, setAutomationInitialTab] = useState<AiAutomationTab>("profiles");
  const [automationFocusId, setAutomationFocusId] = useState<string | null>(null);
  const [depthModalOpen, setDepthModalOpen] = useState(false);
  const [proxyRevision, setProxyRevision] = useState(0);
  const klineNotificationCooldownRef = useRef<Record<string, number>>({});
  const derivedCandleRefreshRef = useRef(0);
  const marketCandleRequestSequenceRef = useRef(0);
  const historyRequestsRef = useRef(new Map<string, Promise<ChartHistoryLoadOutcome>>());
  const historyExhaustedRef = useRef(new Set<string>());
  const privateHistorySyncRef = useRef<Record<string, number>>({});
  const intelligenceBootstrapRef = useRef<Record<string, number>>({});
  const privateWsNotificationRef = useRef<Record<string, number>>({});
  const privateSnapshotNotificationRef = useRef<Record<string, number>>({});
  const privateWsHadIssueRef = useRef<Record<string, boolean>>({});
  const privateWsReconciledRef = useRef<Record<string, number>>({});
  const privateOrderEventRef = useRef(new BoundedEventCache());
  const terminalRenderCountRef = useRef(0);
  const marketEventCountersRef = useRef<Record<string, number>>({});
  const marketCandleRequestRef = useRef<{
    key: string;
    promise: Promise<Candle[]>;
    queued: boolean;
  } | null>(null);
  terminalRenderCountRef.current += 1;
  const requestMarketCandles = useCallback((nextBar: string) => {
    const key = `${symbol}\u0000${nextBar}`;
    const existing = marketCandleRequestRef.current;
    if (existing?.key === key) {
      existing.queued = true;
      return { promise: existing.promise, started: false };
    }
    const requestId = `chart-${Date.now()}-${++marketCandleRequestSequenceRef.current}`;
    const startedAt = performance.now();
    logger.info("chart candle request started", { requestId, symbol, bar: nextBar, limit: 300 });
    const promise = fetchCandles(symbol, nextBar, 300)
      .then((candles) => {
        logger.info("chart candle request completed", {
          requestId,
          symbol,
          bar: nextBar,
          limit: 300,
          rows: candles.length,
          elapsedMs: Math.round(performance.now() - startedAt),
          emptyWithoutError: candles.length === 0
        });
        return candles;
      })
      .catch((error) => {
        logger.error("chart candle request failed", error, {
          requestId,
          symbol,
          bar: nextBar,
          limit: 300,
          elapsedMs: Math.round(performance.now() - startedAt)
        });
        throw error;
      });
    marketCandleRequestRef.current = { key, promise, queued: false };
    const clearRequest = () => {
      const current = marketCandleRequestRef.current;
      if (current?.promise !== promise) return;
      const queued = current.queued;
      marketCandleRequestRef.current = null;
      if (queued) derivedCandleRefreshRef.current = 0;
    };
    void promise.then(clearRequest, clearRequest);
    return { promise, started: true };
  }, [symbol]);
  useRendererMemoryMonitor("terminal", () => {
    const hot = getMarketHotState();
    return {
    symbol,
    bar,
    renderCount: terminalRenderCountRef.current,
    marketEvents: { ...marketEventCountersRef.current },
    activeTauriListeners: getActiveTauriListenerCounts(),
    candles: hot.candles.length,
    trades: hot.trades.length,
    orderBookBids: hot.book?.bids.length ?? 0,
    orderBookAsks: hot.book?.asks.length ?? 0,
    watchlist: watchlist.length,
    watchTickers: Object.keys(hot.watchTickers).length,
    positions: privateSnapshot?.positions.length ?? 0,
    openOrders: privateSnapshot?.orders.length ?? 0,
    historicalOrders: historicalOrders.length,
    historicalFills: historicalFills.length,
    accountBills: accountBills.length,
    tradeAuditEvents: tradeAuditEvents.length,
    tradeOpportunities: tradeOpportunities.length,
    notifications: notifications.length,
    notificationHistory: notificationHistory.length,
    klineSyncKeys: Object.keys(klineSync).length
  };
  });
  const assetMap = useMemo(
    () => new Map((marketAssets?.instruments ?? []).map((item) => [item.instId, item])),
    [marketAssets]
  );
  const currentInstrument = useMemo(() => assetMap.get(symbol), [assetMap, symbol]);
  const filteredWatchOptions = useMemo(() => {
    const query = symbolSearch.trim().toUpperCase();
    return (marketAssets?.instruments ?? [])
      .filter((item) => item.instType === "SWAP" && item.state === "live" && item.settleCcy === "USDT")
      .filter((item) => !query || item.instId.includes(query) || item.baseCcy.includes(query) || item.instFamily.includes(query))
      .sort((left, right) => {
        const score = (item: MarketAssetsSummary["instruments"][number]) => {
          if (!query) return watchlist.includes(item.instId) ? 2 : 1;
          if (item.baseCcy === query || item.instId === query) return 0;
          if (item.baseCcy.startsWith(query) || item.instId.startsWith(query)) return 1;
          return 2;
        };
        return score(left) - score(right) || left.baseCcy.localeCompare(right.baseCcy);
      })
      .slice(0, 12);
  }, [marketAssets?.instruments, symbolSearch, watchlist]);
  const streamWatchlist = useMemo(() => {
    const symbols = new Set([...watchlist, symbol].filter(Boolean));
    return [...symbols];
  }, [symbol, watchlist]);
  const visiblePendingOrders = useMemo(() => {
    const now = Date.now();
    return mergeOptimisticPendingOrders(privateSnapshot?.orders ?? [], optimisticPendingOrders, now);
  }, [optimisticPendingOrders, privateSnapshot?.orders]);

  useEffect(() => {
    if (!marketPickerOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!marketPickerRef.current?.contains(event.target as Node)) setMarketPickerOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMarketPickerOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [marketPickerOpen]);
  const visiblePrivateSnapshot = useMemo(
    () => privateSnapshot ? { ...privateSnapshot, orders: visiblePendingOrders } : privateSnapshot,
    [privateSnapshot, visiblePendingOrders]
  );
  const chartOrderLines = useMemo(
    () => buildSharedChartOrderLines({ t, symbol, orders: visiblePendingOrders, algoOrders, positions: visiblePrivateSnapshot?.positions ?? [], instrument: currentInstrument, overrides: pendingOrderLineOverrides }),
    [algoOrders, currentInstrument, pendingOrderLineOverrides, symbol, t, visiblePendingOrders, visiblePrivateSnapshot?.positions]
  );
  const chartFillMarkers = useMemo(
    () => buildHistoricalFillMarkers(symbol, historicalFills, 160, t),
    [historicalFills, symbol, t]
  );
  const removeAlgoOrderLocally = useCallback((target: Pick<OkxAlgoOrder, "algoId" | "algoClOrdId" | "instId">) => {
    setAlgoOrders((items) =>
      items.filter((item) => {
        if (item.instId !== target.instId) return true;
        if (target.algoId && item.algoId === target.algoId) return false;
        if (target.algoClOrdId && item.algoClOrdId === target.algoClOrdId) return false;
        return true;
      })
    );
  }, []);
  const dismissPendingOrderLocally = useCallback((target: Pick<OkxPendingOrder, "ordId" | "clOrdId" | "algoId" | "algoClOrdId">) => {
    if (!pendingOrderKey(target)) return;
    setOptimisticPendingOrders((items) => items.filter((item) => !matchesPendingOrderTarget(item, target)));
    const withoutTarget = (snapshot: PrivateAccountSnapshot | null) => snapshot
      ? { ...snapshot, orders: snapshot.orders.filter((item) => !matchesPendingOrderTarget(item, target)), syncedAt: Date.now() }
      : snapshot;
    setPrivateSnapshot(withoutTarget);
    setPrivateSnapshots((items) => Object.fromEntries(
      Object.entries(items).map(([snapshotKey, snapshot]) => [snapshotKey, withoutTarget(snapshot)!])
    ));
  }, []);
  const normalizeChartEditPrice = useCallback(
    (price: number) => normalizeTradePriceInput(price, currentInstrument),
    [currentInstrument]
  );
  const marketAssetCacheDir = marketAssets?.cacheDir;

  const pushNotification = useCallback((notification: Omit<AppNotification, "id" | "createdAt">) => {
    playNotificationSound(notification.kind);
    const item = { ...notification, id: `n-${Date.now()}-${Math.random().toString(16).slice(2)}`, createdAt: Date.now() };
    setNotifications((items) => [item, ...items].slice(0, 6));
    setNotificationHistory((items) => persistNotificationHistory([item, ...items].slice(0, 200)));
    const timeoutMs = notification.kind === "error" ? 8000 : notification.kind === "trade" ? 6500 : 4800;
    window.setTimeout(() => setNotifications((items) => items.filter((next) => next.id !== item.id)), timeoutMs);
  }, []);

  const requestPendingOrderAmend = useCallback((order: OkxPendingOrder) => {
    const matchesOrder = (line: ChartOrderLine) => line.editKind === "order-price"
      && ((order.ordId && line.orderId === order.ordId) || (order.clOrdId && line.clientOrderId === order.clOrdId));
    const line = chartOrderLines.find(matchesOrder) ?? buildSharedChartOrderLines({ t, symbol: order.instId, orders: [order], algoOrders: [], positions: visiblePrivateSnapshot?.positions ?? [], instrument: assetMap.get(order.instId), overrides: pendingOrderLineOverrides }).find(matchesOrder);
    if (!line) {
      pushNotification({
        kind: "warning",
        title: uiText("当前委托无法改单", "Order cannot be amended"),
        message: uiText("仅支持修改仍在挂单中的普通限价委托。", "Only active ordinary limit orders can be amended.")
      });
      return;
    }
    setPendingOrderLineEdit({ line, price: line.price });
  }, [assetMap, chartOrderLines, pendingOrderLineOverrides, pushNotification, t, uiText, visiblePrivateSnapshot?.positions]);

  const previewOnboardingStep = useMemo(
    () => isTauriRuntime() ? null : parseFirstLaunchPreviewStep(new URLSearchParams(window.location.search).get("onboarding")),
    []
  );
  const navigateToOnboardingStep = useCallback((step: FirstLaunchStep) => {
    setAccountManagerOpen(false);
    setNotificationCenterOpen(false);
    if (step === "account") {
      setSettingsActiveTab("account");
      setMainSection("config");
      return;
    }
    if (step === "ai") {
      setSettingsActiveTab("ai");
      setMainSection("config");
      return;
    }
    if (step === "profile") {
      setAutomationInitialTab("profiles");
      setAutomationFocusId(null);
      setMainSection("automation");
      return;
    }
    setMainSection("terminal");
  }, []);
  const handleOnboardingFinished = useCallback(() => {
    pushNotification({
      kind: "success",
      title: uiText("首次配置已完成", "Initial setup completed"),
      message: uiText("OKX 账号、AI 模型与 Profile 已准备就绪，可以开始交易。", "Your OKX account, AI model, and Profile are ready. You can start trading.")
    });
  }, [pushNotification, uiText]);
  const firstLaunchOnboarding = useFirstLaunchOnboarding({
    autoStart: isTauriRuntime(),
    ready: accountsReady || Boolean(previewOnboardingStep),
    hasExistingAccount: accounts.length > 0,
    previewStep: previewOnboardingStep,
    onNavigate: navigateToOnboardingStep,
    onFinished: handleOnboardingFinished
  });

  useEffect(() => {
    const listenerCleanup = createDeferredCleanupSlot();
    void listenOptional<AiAutomationEvent>("ai:automation-event", (event) => {
      const systematicProfileAutoStopped = event.type === "systematicProfileAutoStopped";
      const systematicProfileProtectionWarning = event.type === "systematicProfileProtectionWarning";
      const systematicProfileRecoveryFailed = event.type === "systematicProfileExecutionRecoveryFailed";
      const opensNotificationSettings = event.action?.settingsTab === "notifications";
      const opensAccountSettings = event.action?.settingsTab === "account";
      const kind: AppNotification["kind"] = event.type === "notificationError"
        || event.type === "runFailed"
        || event.type === "accountPositionModeSwitchFailed"
        || event.type === "accountPositionModeRequired"
        || systematicProfileProtectionWarning
        || systematicProfileRecoveryFailed
        ? "error"
        : systematicProfileAutoStopped
          ? "error"
        : event.type === "runCompleted"
          ? "success"
          : "info";
      const title = event.type === "reviewCreated"
        ? uiText("新的交易复盘", "New trade review")
        : event.type === "suggestionCreated"
          ? uiText("新的优化建议", "New optimization suggestion")
          : event.type === "notificationError"
            ? uiText("自动化通知失败", "Automation notification failed")
            : event.type === "runFailed"
              ? uiText("AI 自动化异常", "AI Automation error")
              : event.type === "accountPositionModeSwitchFailed"
                ? t("automation:accountPositionModeSwitchFailedTitle")
              : event.type === "accountPositionModeRequired"
                ? t("automation:accountPositionModeRequiredTitle")
              : systematicProfileAutoStopped
                ? t("automation:systematicProfileAutoStoppedTitle")
              : systematicProfileProtectionWarning
                ? uiText("策略保护单告警", "Strategy protection warning")
              : systematicProfileRecoveryFailed
                ? uiText("策略信号恢复失败", "Strategy signal recovery failed")
              : event.type === "runCompleted"
                ? uiText("AI 自动化完成", "AI Automation completed")
                : uiText("AI 自动化通知", "AI Automation notification");
      pushNotification({
        kind,
        title,
        message: localizeAutomationEventMessage(event, t),
        action: systematicProfileAutoStopped || systematicProfileProtectionWarning || systematicProfileRecoveryFailed ? undefined : opensNotificationSettings || opensAccountSettings ? "settings" : "ai-automation",
        automationTab: systematicProfileAutoStopped || systematicProfileProtectionWarning || systematicProfileRecoveryFailed || opensNotificationSettings ? undefined : normalizeAutomationTab(event.action?.tab),
        settingsTab: opensNotificationSettings && !systematicProfileAutoStopped
          ? "notifications"
          : opensAccountSettings && !systematicProfileAutoStopped
            ? "account"
            : undefined,
        targetId: event.action?.id ?? undefined
      });
    }).then((dispose) => listenerCleanup.settle(dispose));
    return () => listenerCleanup.dispose();
  }, [pushNotification, t, uiText]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void loadNewsReadState().then((state) => setNewsUnreadCount(state.unreadEvents)).catch(() => undefined);
  }, []);

  useEffect(() => {
    const listenerCleanup = createDeferredCleanupSlot();
    void listenOptional<Record<string, unknown>>("intelligence:event", (event) => {
      if (event.type === "syncCompleted" || event.type === "syncDegraded") {
        void loadNewsReadState().then((state) => setNewsUnreadCount(state.unreadEvents)).catch(() => undefined);
      }
      if (event.type !== "syncDegraded") return;
      const errors = Array.isArray(event.errors)
        ? event.errors.filter((value): value is string => typeof value === "string").slice(0, 2)
        : [];
      pushNotification({
        kind: "error",
        title: uiText("市场情报采集异常", "Market Intelligence sync error"),
        message: errors.join(chineseUi ? "；" : "; ") || uiText(
          "采集账户失效、网络不可用或 OKX provider 响应结构发生变化，请打开市场情报检查同步状态。",
          "The collection account may be invalid, the network unavailable, or the OKX provider response changed. Open Market Intelligence to review sync status."
        )
      });
    }).then((dispose) => listenerCleanup.settle(dispose));
    return () => listenerCleanup.dispose();
  }, [chineseUi, pushNotification, uiText]);

  useEffect(() => {
    const listenerCleanup = createDeferredCleanupSlot();
    void listenOptional<{ instId: string; direction: "above" | "below" | "cross"; triggerPrice: number; lastPrice: number; conditionKind?: string; name?: string; message?: string; notifyApp?: boolean }>("chart:alert-triggered", (event) => {
      if (event.notifyApp === false) return;
      const direction = event.direction === "above"
        ? uiText("上破", "crossed above")
        : event.direction === "below"
          ? uiText("下破", "crossed below")
          : uiText("穿越", "crossed");
      const title = event.name || (event.conditionKind === "indicator"
        ? uiText("图表指标提醒", "Chart indicator alert")
        : uiText("图表价格提醒", "Chart price alert"));
      const message = event.message || (chineseUi
        ? `${event.instId} 已${direction} ${fmtPrice(event.triggerPrice)}，最新价 ${fmtPrice(event.lastPrice)}。`
        : `${event.instId} ${direction} ${fmtPrice(event.triggerPrice)}. Last price ${fmtPrice(event.lastPrice)}.`);
      pushNotification({ kind: "warning", title, message });
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification(title, { body: message, silent: false });
      }
    }).then((dispose) => listenerCleanup.settle(dispose));
    return () => listenerCleanup.dispose();
  }, [chineseUi, pushNotification, uiText]);

  useEffect(() => {
    let cancelled = false;
    if (initialMarketAssets) {
      setMarketAssets(initialMarketAssets);
    }
    const refresh = () =>
      loadMarketAssetsCache()
        .then((cachedAssets) => {
          if (!cancelled && cachedAssets?.instruments?.length) setMarketAssets(cachedAssets);
        })
        .catch((error) => logger.warn("failed to load market asset cache", { error: String(error) }));
    void refresh();
    const timer = window.setTimeout(() => void refresh(), 2500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [initialMarketAssets]);

  useEffect(() => {
    if (marketAssets?.instruments?.length) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void loadMarketAssetsCache()
        .then((cachedAssets) => {
          if (!cancelled && cachedAssets?.instruments?.length) {
            setMarketAssets(cachedAssets);
            window.clearInterval(timer);
          }
        })
      .catch((error) => logger.warn("failed to load market asset cache", { error: String(error) }));
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [marketAssets?.instruments?.length]);

  const clearNotificationHistory = useCallback(() => {
    setNotificationHistory(persistNotificationHistory([]));
    setNotifications([]);
  }, []);

  const refreshPrivateHistoryStatus = useCallback((accountItem?: AccountSummary | null) => {
    if (!accountItem || !accountItem.permissions.read) {
      setPrivateHistoryStatus(null);
      return;
    }
    void fetchPrivateHistoryStatus({ accountId: accountItem.id, instId: symbol })
      .then((status) => {
        setPrivateHistoryStatus(status);
        if (!status || status.failed === 0) return;
        const firstError = status.endpoints.find((item) => item.status === "failed" && item.lastError)?.lastError;
        pushNotification({
          kind: "warning",
          title: uiText("历史数据补数存在失败接口", "Some history backfill endpoints failed"),
          message: firstError ? firstError.slice(0, 120) : uiText(
            `失败 ${status.failed} 个接口，等待重试 ${status.retrying} 个。`,
            `${status.failed} endpoint(s) failed; ${status.retrying} waiting to retry.`
          )
        });
      })
      .catch((error) => {
        logger.warn("private history status load failed", { error: error instanceof Error ? error.message : String(error) });
      });
  }, [pushNotification, symbol, uiText]);

  useEffect(() => {
    const recentErrors = new Map<string, number>();
    return logger.subscribe((entry) => {
      if (entry.level !== "error" && entry.level !== "fatal") return;
      const key = `${entry.level}:${entry.message}:${entry.error ?? ""}`.slice(0, 300);
      const now = Date.now();
      const last = recentErrors.get(key) ?? 0;
      if (now - last < 10_000) return;
      recentErrors.set(key, now);
      const lines = entry.error?.split("\n") ?? [];
      const detail = lines[0] ?? "";
      // A bare message like "Value is null" from inside a bundled dependency is
      // not actionable on its own. Append the first frame that points at real
      // code so a report identifies where the throw came from.
      const origin = lines.slice(1).find((line) => /\.(t|j)sx?|\.mjs/.test(line))?.trim();
      const summary = detail && origin ? `${detail} @ ${origin}` : detail;
      pushNotification({
        kind: "error",
        title: entry.level === "fatal" ? uiText("前端致命异常", "Fatal frontend error") : uiText("前端代码异常", "Frontend error"),
        message: summary ? `${entry.message}${chineseUi ? "：" : ": "}${summary}` : entry.message
      });
    });
  }, [chineseUi, pushNotification, uiText]);

  useEffect(() => {
    let cancelled = false;
    void loadAiConfigSummary().then((summary) => {
      if (cancelled || !summary || summary.configured) return;
      pushNotification({
        kind: "info",
        title: uiText("未配置 AI", "AI is not configured"),
        message: uiText("点击前往 AI 配置，选择 API Key 或已登录的本机 CLI。", "Open AI settings and select an API Key or a signed-in local CLI."),
        action: "settings",
        settingsTab: "ai"
      });
    });
    return () => {
      cancelled = true;
    };
  }, [pushNotification, uiText]);

  const triggerPrivateHistorySync = useCallback((accountItem: AccountSummary, reason: "startup" | "account-saved" | "manual" | "deep" | "reconnect" | "fill" | "periodic" = "startup") => {
    if (!accountItem.permissions.read) return;
    const key = `${accountItem.id}:${accountItem.environment}`;
    const now = Date.now();
    const cooldownMs = reason === "manual" || reason === "deep" || reason === "startup" || reason === "fill" ? 0 : reason === "reconnect" ? 5 * 60_000 : 3 * 60_000;
    const last = privateHistorySyncRef.current[key] ?? 0;
    if (last < 0) {
      const inFlightStartedAt = -last;
      if (now - inFlightStartedAt < 2 * 60_000) return;
      logger.warn("private history sync watchdog released a stale in-flight lock", {
        accountId: accountItem.id,
        reason,
        inFlightStartedAt
      });
    }
    if (last > 0 && cooldownMs > 0 && now - last < cooldownMs) return;
    privateHistorySyncRef.current[key] = -now;
    const maxPages = reason === "deep" ? 12 : reason === "startup" || reason === "reconnect" || reason === "fill" || reason === "periodic" ? 2 : 3;
    void syncPrivateHistory({ accountId: accountItem.id, maxPages, force: true })
      .then((result) => {
        privateHistorySyncRef.current[key] = Date.now();
        if (!result) return;
        setPrivateHistoryVersion((version) => version + 1);
        refreshPrivateHistoryStatus(accountItem);
        logger.info("private OKX history sync completed", { reason, accountId: accountItem.id, maxPages, result });
        const summary = formatPrivateHistorySyncSummary(result);
        if (reason === "account-saved") {
          pushNotification({
            kind: "success",
            title: uiText("历史交易数据已同步", "Trade history synchronized"),
            message: summary
          });
        } else if (reason === "manual" || reason === "deep") {
          pushNotification({
            kind: "success",
            title: reason === "deep" ? uiText("深度历史补数完成", "Deep history backfill completed") : uiText("历史交易数据同步完成", "Trade history sync completed"),
            message: chineseUi ? `${summary} 页深度 ${maxPages}。` : `${summary} Page depth: ${maxPages}.`
          });
        }
      })
      .catch((error) => {
        privateHistorySyncRef.current[key] = 0;
        const message = error instanceof Error ? error.message : String(error);
        logger.error("private OKX history sync failed", error, { reason, accountId: accountItem.id });
        pushNotification({ kind: "warning", title: uiText("历史交易数据补充失败", "Trade history backfill failed"), message });
      });
  }, [chineseUi, pushNotification, refreshPrivateHistoryStatus, uiText]);

  const triggerIntelligenceBootstrap = useCallback((accountItem: AccountSummary) => {
    if (accountItem.exchange.toLowerCase() !== "okx" || accountItem.environment !== "live" || !accountItem.permissions.read) return;
    const key = `${accountItem.id}:${accountItem.environment}`;
    const lastAttempt = intelligenceBootstrapRef.current[key] ?? 0;
    if (lastAttempt < 0 || Date.now() - lastAttempt < 30_000) return;
    intelligenceBootstrapRef.current[key] = -1;
    void syncIntelligence(accountItem.id)
      .then((summary) => {
        intelligenceBootstrapRef.current[key] = Date.now();
        const failed = summary.syncStates.filter((item) => item.status === "failed");
        const degraded = summary.syncStates.filter((item) => item.status === "degraded");
        if (failed.length > 0 || degraded.length > 0) {
          pushNotification({
            kind: "warning",
            title: failed.length > 0
              ? uiText("市场情报部分同步失败", "Market intelligence partially synchronized")
              : uiText("市场情报部分降级", "Market intelligence partially degraded"),
            message: failed[0]?.error
              || degraded[0]?.error
              || uiText(`${failed.length + degraded.length} 个采集任务将在后台继续处理。`, `${failed.length + degraded.length} collection task(s) will continue in the background.`)
          });
          return;
        }
        pushNotification({
          kind: "success",
          title: uiText("市场情报已同步", "Market intelligence synchronized"),
          message: uiText(
            `新闻 ${summary.counts.news ?? 0} 条，情绪 ${summary.counts.sentiment ?? 0} 条，聪明钱信号 ${summary.counts.smartSignals ?? 0} 条。`,
            `${summary.counts.news ?? 0} news items, ${summary.counts.sentiment ?? 0} sentiment records, and ${summary.counts.smartSignals ?? 0} Smart Money signals.`
          )
        });
      })
      .catch((error) => {
        intelligenceBootstrapRef.current[key] = 0;
        const message = error instanceof Error ? error.message : String(error);
        logger.error("initial market intelligence sync failed", error, { accountId: accountItem.id });
        pushNotification({
          kind: "warning",
          title: uiText("市场情报同步失败", "Market intelligence synchronization failed"),
          message
        });
      });
  }, [pushNotification, uiText]);

  const handleAccountSaved = useCallback((accountItem: AccountSummary) => {
    triggerPrivateHistorySync(accountItem, "account-saved");
    triggerIntelligenceBootstrap(accountItem);
  }, [triggerIntelligenceBootstrap, triggerPrivateHistorySync]);

  const notifyKlineSyncIssue = useCallback((report: KlineSyncReport) => {
    if (report.status === "scanning" || report.status === "backfilling") return;
    let kind: AppNotification["kind"] = "info";
    let issue = "";
    let title = "";
    let message = "";
    const reasonText = formatKlineInvalidReasons(report.invalidReasons, chineseUi);
    const statsText = uiText(
      `缺口 ${report.missing} / 异常 ${report.invalid} / 已有 ${report.existing} / 应有 ${report.expected}`,
      `Missing ${report.missing} / invalid ${report.invalid} / present ${report.existing} / expected ${report.expected}`
    );
    if (report.retryState === "permanent_gap") {
      kind = "warning";
      issue = "permanent";
      title = report.missing > 0 ? uiText("K 线需要人工复核", "Candles require manual review") : uiText("K 线等待确认", "Candles await confirmation");
      message = chineseUi
        ? report.missing > 0
          ? `${report.symbol} ${report.interval} 连续 ${report.attempt} 次仍有缺口。${statsText}${reasonText ? `；${reasonText}` : ""}`
          : `${report.symbol} ${report.interval} 连续 ${report.attempt} 次仍有未确认历史 K 线。${statsText}${reasonText ? `；${reasonText}` : ""}`
        : `${report.symbol} ${report.interval} remains ${report.missing > 0 ? "incomplete" : "unconfirmed"} after ${report.attempt} attempts. ${statsText}${reasonText ? `; ${reasonText}` : ""}`;
    } else if (report.status === "failed") {
      kind = "error";
      issue = "failed";
      title = uiText("K 线同步失败", "Candle sync failed");
      message = `${report.symbol} ${report.interval}${chineseUi ? "：" : ": "}${report.message}${chineseUi ? "；" : "; "}${statsText}`;
    } else if (report.missing > 0) {
      kind = "warning";
      issue = "missing";
      title = uiText("发现 K 线缺口", "Candle gap detected");
      message = chineseUi
        ? `${report.symbol} ${report.interval} 仍缺 ${report.missing} 根。${statsText}${reasonText ? `；${reasonText}` : ""}`
        : `${report.symbol} ${report.interval} is missing ${report.missing} candle(s). ${statsText}${reasonText ? `; ${reasonText}` : ""}`;
    } else if (report.invalid > 0) {
      kind = "warning";
      issue = "invalid";
      title = uiText("发现异常 K 线", "Invalid candles detected");
      message = chineseUi
        ? `${report.symbol} ${report.interval} 有 ${report.invalid} 条异常数据。${statsText}${reasonText ? `；${reasonText}` : ""}`
        : `${report.symbol} ${report.interval} has ${report.invalid} invalid candle(s). ${statsText}${reasonText ? `; ${reasonText}` : ""}`;
    } else {
      return;
    }
    const key = `${report.symbol}:${report.interval}:${issue}`;
    const now = Date.now();
    const last = klineNotificationCooldownRef.current[key] ?? 0;
    if (now - last < 30 * 60_000) return;
    klineNotificationCooldownRef.current[key] = now;
    pushNotification({ kind, title, message });
  }, [chineseUi, pushNotification, uiText]);

  const notifyPrivateWsIssue = useCallback((key: string, notification: Omit<AppNotification, "id" | "createdAt">, cooldownMs = 5 * 60_000) => {
    const now = Date.now();
    const last = privateWsNotificationRef.current[key] ?? 0;
    if (now - last < cooldownMs) return;
    privateWsNotificationRef.current[key] = now;
    pushNotification(notification);
  }, [pushNotification]);

  const handlePrivateWsStatus = useCallback((event: PrivateWsStatus) => {
    const display = formatPrivateWsStatus(event);
    const statusKey = privateAccountKey(event.accountId, event.environment);
    if (statusKey) setPrivateStatuses((items) => ({ ...items, [statusKey]: event }));
    if (!event.accountId || event.accountId === selectedAccountIdRef.current) {
      setPrivateStatus(display);
      if (typeof event.delayMs === "number") setPrivateEventTime(event.eventAt - event.delayMs);
    }
    const eventAccount = accounts.find((item) => item.id === event.accountId);
    const accountLabel = eventAccount?.name ?? event.accountId ?? t("settings:defaultOkxAccount");
    const environmentLabel = t(event.environment === "live" ? "common:live" : "common:demo");
    const status = event.status.toLowerCase();
    if (statusKey && ["reconnecting", "stale", "auth_failed", "time_sync_failed"].includes(event.state ?? "")) {
      privateWsHadIssueRef.current[statusKey] = true;
    }

    if (event.state === "time_sync_failed") {
      notifyPrivateWsIssue(`time-sync:${event.accountId ?? "unknown"}`, {
        kind: "error",
        title: uiText("私有频道时间同步失败", "Private channel time sync failed"),
        message: uiText(
          `${accountLabel} · ${environmentLabel} 已重新校准时间但仍被 OKX 拒绝，请检查系统自动时间和代理延迟。`,
          `${accountLabel} · ${environmentLabel} was rejected by OKX after recalibration. Check automatic system time and proxy latency.`
        )
      }, 10 * 60_000);
    } else if (status.includes("登录失败") || status.includes("login failed") || status.includes("private ws: 登录失败")) {
      notifyPrivateWsIssue(`auth:${event.accountId ?? "unknown"}`, {
        kind: "error",
        title: uiText("私有频道认证失败", "Private channel authentication failed"),
        message: uiText(
          `${accountLabel} · ${environmentLabel} 登录 OKX private WebSocket 失败，请检查账号环境、API Key、Passphrase 与读取权限。`,
          `${accountLabel} · ${environmentLabel} could not authenticate with the OKX private WebSocket. Check the environment, API Key, Passphrase, and read permission.`
        )
      }, 10 * 60_000);
    } else if (status.includes("retry") || status.includes("reconnecting") || status.includes("closed")) {
      notifyPrivateWsIssue(`disconnect:${event.accountId ?? "unknown"}`, {
        kind: "warning",
        title: uiText("私有频道正在重连", "Private channel reconnecting"),
        message: uiText(
          `${accountLabel} · ${environmentLabel} 账户实时余额、持仓、挂单可能短暂滞后，REST 兜底仍会继续刷新。`,
          `${accountLabel} · ${environmentLabel} live balances, positions, and orders may briefly lag while the REST fallback continues refreshing.`
        )
      });
    }

    if (event.state === "ready" && statusKey && privateWsHadIssueRef.current[statusKey]) {
      privateWsHadIssueRef.current[statusKey] = false;
      pushNotification({
        kind: "info",
        title: uiText("私有频道已恢复", "Private channel restored"),
        message: uiText(
          `${accountLabel} · ${environmentLabel} 已恢复账户、持仓和订单实时同步。`,
          `${accountLabel} · ${environmentLabel} live account, position, and order sync has been restored.`
        )
      });
    }

    if (typeof event.delayMs === "number" && event.delayMs > PRIVATE_WS_DELAY_WARNING_MS) {
      notifyPrivateWsIssue(`delay:${event.accountId ?? "unknown"}`, {
        kind: "warning",
        title: uiText("私有频道延迟偏高", "Private channel latency is high"),
        message: uiText(
          `${accountLabel} private WS 推送延迟约 ${fmtDelay(event.delayMs)}，下单前请关注账户数据实时性。`,
          `${accountLabel} private WebSocket updates are delayed by about ${fmtDelay(event.delayMs)}. Verify account data freshness before trading.`
        )
      }, 2 * 60_000);
    }

    if (status.includes("subscribed") && eventAccount) {
      const key = `${eventAccount.id}:${eventAccount.environment}`;
      const now = Date.now();
      const last = privateWsReconciledRef.current[key] ?? 0;
      if (now - last > 5 * 60_000) {
        privateWsReconciledRef.current[key] = now;
        triggerPrivateHistorySync(eventAccount, "reconnect");
      }
    }
  }, [accounts, notifyPrivateWsIssue, pushNotification, t, timeState, triggerPrivateHistorySync, uiText]);
  privateWsStatusHandlerRef.current = handlePrivateWsStatus;
  triggerPrivateHistorySyncRef.current = triggerPrivateHistorySync;

  useEffect(() => {
    let cancelled = false;
    void loadWatchlistConfig()
      .then((config) => {
        if (cancelled || !config?.symbols?.length) return;
        setWatchlist(persistWatchlist(config.symbols));
      })
      .catch((error) => logger.error("failed to load watchlist config", error));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (previewAccounts.length > 0) {
      setAccounts(previewAccounts);
      setAccountsReady(true);
      setSelectedAccountId((current) => current ?? previewAccounts[0]?.id ?? null);
      const snapshot = buildTerminalPreviewPrivateSnapshot(previewAccounts[0], previewPendingOrder);
      const key = snapshot ? privateAccountKey(snapshot.accountId, snapshot.environment) : null;
      setPrivateSnapshot(snapshot);
      setPrivateSnapshots(snapshot && key ? { [key]: snapshot } : {});
      setPrivateStatus(snapshot ? "预览数据" : "等待账号");
      if (previewMarketConsistency) {
        const now = Date.now();
        const ticker: Ticker = {
          instId: "BTC-USDT-SWAP",
          last: "65123.4",
          lastSz: "0.25",
          askPx: "65123.5",
          askSz: "1.5",
          bidPx: "65123.3",
          bidSz: "2.5",
          open24h: "64000",
          high24h: "66000",
          low24h: "63000",
          vol24h: "1000",
          volCcy24h: "65000000",
          ts: now
        };
        hydrateMarketHotState({
          ticker,
          watchTickers: { "BTC-USDT-SWAP": ticker },
          book: {
            asks: Array.from({ length: 8 }, (_, index) => ({ px: String(65123.5 + index / 10), sz: String(index + 1) })),
            bids: Array.from({ length: 8 }, (_, index) => ({ px: String(65123.3 - index / 10), sz: String(index + 1) })),
            ts: now,
            seqId: "preview-consistency-book"
          },
          trades: [{ tradeId: "preview-consistency-trade", px: "65120.1", sz: "0.15", side: "buy", ts: now - 10 }]
        });
      }
      return;
    }
    resetMarketHotState();
    let cancelled = false;
    void fetchMarketSnapshot()
      .then((snapshot) => {
        if (cancelled || !snapshot) return;
        const cachedTicker = snapshot.tickers?.[symbol] ?? (snapshot.ticker?.instId === symbol ? snapshot.ticker : null);
        const cachedBook = snapshot.orderbooks?.[symbol] ?? (snapshot.orderbookInstId === symbol ? snapshot.orderbook : null);
        const cachedTrades = snapshot.tradesByInst?.[symbol] ?? (snapshot.tradesInstId === symbol ? snapshot.trades : []);
        const cachedFunding = snapshot.fundingRates?.[symbol] ?? null;
        if (snapshot.privateSnapshots) setPrivateSnapshots(snapshot.privateSnapshots);
        if (cachedTicker) {
          hydrateMarketHotState({ ticker: cachedTicker, watchTickers: { ...getMarketHotState().watchTickers, [cachedTicker.instId]: cachedTicker } });
        }
        if (cachedBook) hydrateMarketHotState({ book: { ...cachedBook, bids: cachedBook.bids.slice(0, 40), asks: cachedBook.asks.slice(0, 40) } });
        if (cachedTrades.length > 0) hydrateMarketHotState({ trades: cachedTrades.slice(0, 32) });
        if (cachedFunding) hydrateMarketHotState({ fundingRate: cachedFunding });
      })
      .catch((error) => logger.error("failed to hydrate market snapshot", error, { symbol }));
    async function loadInitial() {
      try {
        const accountList = await loadAccounts();
        if (cancelled) return;
        setAccounts(accountList);
        setSelectedAccountId((current) => current ?? accountList[0]?.id ?? null);
        setAccountsReady(true);
      } catch (error) {
        logger.error("failed to load account configuration", error);
      }
      try {
        const [timeResult, tickerResult, fundingResult] = await Promise.allSettled([
          syncOkxTime(),
          fetchTicker(symbol),
          fetchFundingRate(symbol)
        ]);
        if (cancelled) return;
        if (timeResult.status === "fulfilled") setTimeState(timeResult.value);
        if (tickerResult.status === "fulfilled") {
          const initialTicker = tickerResult.value;
          hydrateMarketHotState({ ticker: initialTicker, watchTickers: { ...getMarketHotState().watchTickers, [initialTicker.instId]: initialTicker } });
        }
        if (fundingResult.status === "fulfilled" && fundingResult.value) {
          hydrateMarketHotState({ fundingRate: fundingResult.value });
        }
        const failed = [timeResult, tickerResult, fundingResult].find((result) => result.status === "rejected");
        if (failed?.status === "rejected") {
          logger.error("failed to load part of initial market data", failed.reason, { symbol });
        }
      } catch (error) {
        logger.error("failed to load initial market data", error, { symbol });
      }
    }
    void loadInitial();
    return () => {
      cancelled = true;
    };
  }, [symbol, proxyRevision, previewAccounts, previewPendingOrder, previewMarketConsistency]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      replaceMarketCandles(buildTerminalPreviewCandles(symbol, bar), `${symbol}\u0000${bar}`);
      return;
    }
    if (previewAccounts.length > 0) return;
    let cancelled = false;
    derivedCandleRefreshRef.current = 0;
    replaceMarketCandles([], `${symbol}\u0000${bar}`);
    setMarketCandleLoadError(null);
    const request = requestMarketCandles(bar);
    void request.promise
      .then((items) => {
        if (cancelled) return;
        if (items.length === 0) {
          throw new Error(`No ${bar} candle data returned for ${symbol}`);
        }
        replaceMarketCandles(items, `${symbol}\u0000${bar}`);
        setMarketCandleLoadError(null);
      })
      .catch((error) => {
        logger.error("failed to load candles for selected interval", error, { symbol, bar });
        if (!cancelled) {
          setMarketCandleLoadError({
            symbol,
            bar,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, bar, proxyRevision, previewAccounts.length, marketCandleReloadToken, requestMarketCandles]);

  useEffect(() => {
    hydrateMarketHotState({ publicStreamStatuses: {} });
    if (previewMarketConsistency) return;
    let streamActive = true;
    const close = connectMarketStream(symbol, bar, {
      onTicker: (item) => {
        countRendererEvent(marketEventCountersRef, "ticker");
        queueMarketTicker(item);
      },
      onWatchTicker: (item) => {
        countRendererEvent(marketEventCountersRef, "watchTicker");
        queueWatchTicker(item);
      },
      onOrderBook: (item) => {
        countRendererEvent(marketEventCountersRef, "orderBook");
        queueOrderBook(item);
      },
      onTrade: (trade) => {
        countRendererEvent(marketEventCountersRef, "trade");
        queueTrade(trade);
      },
      onTrades: (trades) => {
        marketEventCountersRef.current.trade = (marketEventCountersRef.current.trade ?? 0) + trades.length;
        queueTrades(trades);
      },
      onFundingRate: (item) => {
        countRendererEvent(marketEventCountersRef, "fundingRate");
        queueFundingRate(item);
      },
      onCandle: (candle) => {
        if (symbolRef.current !== symbol) return;
        countRendererEvent(marketEventCountersRef, "candle");
        queueBusinessMessageAt(Date.now());
        const activeBar = barRef.current;
        if (activeBar === "1m") {
          queueCandle(candle, `${symbol}\u0000${activeBar}`);
          return;
        }
        const requestKey = `${symbol}\u0000${activeBar}`;
        const pendingRequest = marketCandleRequestRef.current;
        if (pendingRequest?.key === requestKey) {
          pendingRequest.queued = true;
          return;
        }
        const now = Date.now();
        if (now - derivedCandleRefreshRef.current < 2000) return;
        derivedCandleRefreshRef.current = now;
        const request = requestMarketCandles(activeBar);
        if (!request.started) return;
        void request.promise
          .then((items) => {
            if (streamActive && barRef.current === activeBar && items.length > 0) {
              mergeIntoMarketCandles(items, requestKey);
              setMarketCandleLoadError(null);
            }
          })
          .catch((error) => logger.error("failed to refresh derived candles from 1m stream", error, { symbol, bar: activeBar, candle }));
      },
      onStatus: (status) => {
        setWsStatus(status);
        if (status.startsWith("business")) setBusinessWsStatus(status);
      },
      onPublicStatus: (status) => {
        queuePublicStreamStatus(status);
      },
      onPrivateSnapshot: (snapshot) => {
        countRendererEvent(marketEventCountersRef, "privateSnapshot");
        const key = privateAccountKey(snapshot.accountId, snapshot.environment);
        if (key) setPrivateSnapshots((items) => ({ ...items, [key]: snapshot }));
        if (snapshot.accountId === selectedAccountIdRef.current) {
          setPrivateSnapshot(snapshot);
                  setPrivateStatus("实时同步");
        }
      },
      onPrivateOrder: (order, eventAccountId, eventEnvironment) => {
        countRendererEvent(marketEventCountersRef, "privateOrder");
        const key = `${eventAccountId}:${eventEnvironment}:${order.ordId || order.clOrdId || `${order.instId}-${order.uTime}-${order.state}`}`;
        const signature = `${order.state}:${order.accFillSz}:${order.avgPx}:${order.uTime}`;
        if (key && privateOrderEventRef.current.isDuplicate(key, signature)) return;
        const state = order.state.toLowerCase();
        if (isTerminalPendingOrderState(state)) {
          const orderKey = pendingOrderKey(order);
          setOptimisticPendingOrders((items) => items.filter((item) => pendingOrderKey(item) !== orderKey));
        }
        if (["filled", "partially_filled", "canceled", "cancelled", "failed"].includes(state)) {
          setPrivateHistoryVersion((version) => version + 1);
        }
        if (["filled", "partially_filled"].includes(state)) {
          const eventAccount = accountsRef.current.find((item) => item.id === eventAccountId && item.environment === eventEnvironment);
          if (eventAccount?.permissions.read) {
            triggerPrivateHistorySyncRef.current(eventAccount, "fill");
          }
          pushNotification({
            kind: "trade",
            title: `${eventAccount?.name ?? eventAccountId} · ${t(eventEnvironment === "live" ? "common:live" : "common:demo")} · ${state === "filled" ? t("trading:filled") : t("trading:partiallyFilled")}`,
            message: chineseUi
              ? `${order.instId} ${formatOrderSide(order.side, order.posSide)} 成交 ${formatAmount(order.accFillSz || order.sz)} 张，均价 ${fmtPrice(order.avgPx || order.px)}`
              : `${order.instId} filled ${formatAmount(order.accFillSz || order.sz)} contracts at an average price of ${fmtPrice(order.avgPx || order.px)}`
          });
        }
      },
      onPrivateStatus: (event) => privateWsStatusHandlerRef.current(event)
    }, streamWatchlist);
    return () => {
      streamActive = false;
      close();
    };
  }, [symbol, streamWatchlist, proxyRevision, pushNotification, previewMarketConsistency, requestMarketCandles]);

  useEffect(() => {
    if (previewAccounts.length > 0) return;
    void reconcilePrivateStreams().catch((error) => logger.error("failed to reconcile private websocket sessions", error));
  }, [accounts, previewAccounts.length, proxyRevision]);

  useEffect(() => {
    let mounted = true;
    const listenerCleanup = createDeferredCleanupSlot();
    void listenKlineSync((report) => {
      if (!mounted) return;
      setKlineSync((items) => ({ ...items, [`${report.symbol}:${report.interval}`]: report }));
      notifyKlineSyncIssue(report);
      const activeBar = barRef.current;
      const hasNewOneMinuteData = report.inserted > 0;
      const completedCleanly = report.status === "complete" && report.missing === 0 && report.invalid === 0;
      if (report.symbol === symbol && report.interval === "1m" && activeBar !== "1m" && (hasNewOneMinuteData || completedCleanly)) {
        const now = Date.now();
        if (now - derivedCandleRefreshRef.current < 750) return;
        derivedCandleRefreshRef.current = now;
        const request = requestMarketCandles(activeBar);
        void request.promise
          .then((items) => {
            if (mounted && items.length > 0) {
              mergeIntoMarketCandles(items, `${symbol}\u0000${activeBar}`);
              setMarketCandleLoadError(null);
            }
          })
          .catch((error) => logger.error("failed to refresh candles after integrity sync", error, { symbol, bar: activeBar, inserted: report.inserted, status: report.status }));
      }
    }).then((unlisten) => listenerCleanup.settle(unlisten));
    return () => {
      mounted = false;
      listenerCleanup.dispose();
    };
  }, [bar, notifyKlineSyncIssue, requestMarketCandles, symbol]);

  useEffect(() => {
    if (watchlist.length === 0) return;
    void ensureInstrumentsCache(watchlist)
      .then((summary) => {
        if (summary) setMarketAssets(summary);
      })
      .catch((error) => logger.error("failed to ensure watchlist instrument cache", error, { watchlist }));
  }, [watchlist]);

  useEffect(() => {
    const activeTimer = window.setInterval(() => {
      void syncKlineIntegrity([symbol], KLINE_INTEGRITY_INTERVALS, false, KLINE_RECENT_CHECK_HOURS, KLINE_REQUIRED_DAYS);
    }, 10 * 60_000);
    return () => window.clearInterval(activeTimer);
  }, [symbol]);

  const retryMarketCandles = useCallback(() => {
    setMarketCandleLoadError(null);
    setMarketCandleReloadToken((value) => value + 1);
    void syncKlineIntegrity([symbol], KLINE_INTEGRITY_INTERVALS, false, KLINE_RECENT_CHECK_HOURS, KLINE_REQUIRED_DAYS)
      .catch((error) => logger.error("failed to retry local candle synchronization", error, { symbol }));
  }, [symbol]);

  useEffect(() => {
    accounts.forEach((item) => triggerPrivateHistorySync(item, "startup"));
  }, [accounts, triggerPrivateHistorySync]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      accounts.forEach((item) => triggerPrivateHistorySync(item, "periodic"));
    }, 3 * 60_000);
    return () => window.clearInterval(timer);
  }, [accounts, triggerPrivateHistorySync]);

  useEffect(() => {
    const passiveTimer = window.setInterval(() => {
      const passiveSymbols = watchlist.filter((item) => item !== symbol);
      if (passiveSymbols.length > 0) {
        void syncKlineIntegrity(passiveSymbols, KLINE_INTEGRITY_INTERVALS, false, KLINE_RECENT_CHECK_HOURS, KLINE_REQUIRED_DAYS);
      }
    }, 45 * 60_000);
    return () => window.clearInterval(passiveTimer);
  }, [symbol, watchlist]);

  const historyStatusTitle = privateHistoryStatus ? formatPrivateHistoryStatus(privateHistoryStatus, chineseUi) : undefined;
  const historyStatusWarn = Boolean(privateHistoryStatus && (privateHistoryStatus.failed > 0 || privateHistoryStatus.retrying > 0));
  const historyStatusRunning = Boolean(privateHistoryStatus && privateHistoryStatus.running > 0);
  const selectedAccount = accounts.find((item) => item.id === selectedAccountId);
  const selectedAccountScopeKey = selectedAccount ? accountEnvironmentScopeKey(selectedAccount) : null;
  const account = selectedAccount
    && (selectedAccount.environment !== "live" || Boolean(liveRiskAcknowledged[selectedAccountScopeKey!]))
    ? selectedAccount
    : undefined;
  const chartTradeOpportunities = useMemo(
    () => account
      ? tradeOpportunities.filter((item) => (
          item.instId === symbol
          && (item.accountId === account.id || (!item.accountId && accounts.length === 1 && item.environment === account.environment))
        ))
      : [],
    [account, accounts.length, symbol, tradeOpportunities]
  );
  const effectiveTradeEnvironment = account?.environment ?? "demo";
  const pendingLiveAccount = pendingLiveAccountScope
    ? accounts.find((item) => accountEnvironmentScopeKey(item) === accountEnvironmentScopeKey(pendingLiveAccountScope))
    : undefined;
  const openDetachedChart = useCallback(() => {
    void openChartWindow({
      symbol,
      timeframe: bar,
      accountId: account?.id ?? null,
      environment: effectiveTradeEnvironment
    }).catch((error) => {
      logger.error("failed to open detached chart window", error, { symbol, bar });
      pushNotification({
        kind: "error",
        title: uiText("弹出图表失败", "Could not open detached chart"),
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }, [account?.id, bar, effectiveTradeEnvironment, pushNotification, symbol]);
  useEffect(() => {
    if (!account) {
      setPrivateSnapshot(null);
      setPrivateStatus("未配置账号");
      setPrivateEventTime(null);
      return;
    }
    if (!account.permissions.read) {
      setPrivateSnapshot(null);
      setPrivateStatus("未开启读取权限");
      setPrivateEventTime(null);
      return;
    }
    const key = privateAccountKey(account.id, account.environment);
    const snapshot = key ? privateSnapshots[key] : undefined;
    const status = key ? privateStatuses[key] : undefined;
    setPrivateSnapshot(snapshot ?? null);
    setPrivateStatus(status ? formatPrivateWsStatus(status) : snapshot ? "实时同步" : "连接中");
    setPrivateEventTime(status && typeof status.delayMs === "number" ? status.eventAt - status.delayMs : snapshot?.syncedAt ?? null);
  }, [account, privateSnapshots, privateStatuses]);
  const submitOrderLineEdit = useCallback((edit: ChartOrderLineEdit, confirmedLive = false) => {
    if (!account) {
      pushNotification({ kind: "warning", title: uiText("无法改单", "Order cannot be amended"), message: uiText("请先配置并选择 OKX 交易账号。", "Configure and select an OKX trading account first.") });
      return;
    }
    const line = edit.line;
    const editSymbol = line.instId || symbol;
    const normalizeEditPrice = (price: number) => normalizeTradePriceInput(price, assetMap.get(editSymbol));
    const nextPrice = normalizeEditPrice(edit.price);
    const nextTriggerPrice = line.editKind === "algo-trigger"
      ? normalizeEditPrice(edit.triggerPrice ?? edit.price)
      : "";
    const nextOrderPrice = line.editKind === "algo-trigger"
      ? edit.orderPrice === null
        ? "-1"
        : normalizeEditPrice(edit.orderPrice ?? line.orderPrice ?? 0)
      : "";
    if (!nextPrice) {
      pushNotification({ kind: "warning", title: uiText("改单价格无效", "Invalid amendment price"), message: uiText(`${editSymbol} 无法按 tickSz 规范化价格。`, `${editSymbol} could not normalize the price to tickSz.`) });
      return;
    }
    if (line.editKind === "algo-trigger" && (!nextTriggerPrice || !nextOrderPrice)) {
      pushNotification({ kind: "warning", title: uiText("计划委托价格无效", "Invalid trigger-order price"), message: uiText("请提供有效的触发价，以及市价或按 tickSz 对齐的委托价。", "Provide a valid trigger price and either market execution or an order price aligned to tickSz.") });
      return;
    }
    setPendingOrderLineOverrides((items) => ({ ...items, [line.id]: { price: Number(nextPrice), expiresAt: Date.now() + 15_000 } }));
    if (line.editKind === "order-price") {
      void amendChartOrder({ accountId: account.id, environment: effectiveTradeEnvironment, defaultInstId: editSymbol, getInstrument: (instId) => assetMap.get(instId) }, edit, confirmedLive)
        .then((result) => {
          pushNotification({ kind: "trade", title: uiText("委托改单已提交", "Order amendment submitted"), message: `${editSymbol} ${line.label} -> ${nextPrice}${chineseUi ? "，" : ", "}${result?.ordId || result?.clOrdId || uiText("等待确认", "awaiting confirmation")}` });
          setPrivateHistoryVersion((version) => version + 1);
        })
        .catch((error) => {
          setPendingOrderLineOverrides((items) => {
            const next = { ...items };
            delete next[line.id];
            return next;
          });
          logger.error("amend order line failed", error, { symbol: editSymbol, line, nextPrice });
          pushNotification({ kind: "error", title: uiText("拖拽改单失败", "Drag amendment failed"), message: formatTradeErrorMessage(error) });
        });
      return;
    }
    if (line.editKind === "algo-trigger" || line.editKind === "algo-tp" || line.editKind === "algo-sl") {
      void amendChartOrder({ accountId: account.id, environment: effectiveTradeEnvironment, defaultInstId: editSymbol, getInstrument: (instId) => assetMap.get(instId) }, edit, confirmedLive)
        .then((result) => {
          const label = line.editKind === "algo-trigger"
            ? `${uiText("触发", "Trigger")} ${nextTriggerPrice} / ${uiText("委托", "Order")} ${nextOrderPrice === "-1" ? t("trading:market") : nextOrderPrice}`
            : line.editKind === "algo-tp"
              ? `${t("trading:takeProfit")} ${nextPrice}`
              : `${t("trading:stopLoss")} ${nextPrice}`;
          pushNotification({ kind: "trade", title: uiText("策略价格已修改", "Strategy price updated"), message: `${editSymbol} ${label}${chineseUi ? "，" : ", "}${result?.algoId || result?.algoClOrdId || uiText("等待确认", "awaiting confirmation")}` });
          setAlgoOrdersVersion((version) => version + 1);
          setPrivateHistoryVersion((version) => version + 1);
        })
        .catch((error) => {
          setPendingOrderLineOverrides((items) => {
            const next = { ...items };
            delete next[line.id];
            return next;
          });
          logger.error("amend algo line failed", error, { symbol: editSymbol, line, nextPrice });
          pushNotification({ kind: "error", title: uiText("拖拽修改策略失败", "Drag strategy amendment failed"), message: formatTradeErrorMessage(error) });
        });
    }
  }, [account, assetMap, effectiveTradeEnvironment, pushNotification, symbol]);
  const submitPositionLineIntent = useCallback((intent: PositionLineTradeIntent, size: string, orderPx: string, confirmedLive = false) => {
    if (!account) {
      pushNotification({ kind: "warning", title: uiText("无法提交持仓操作", "Position action cannot be submitted"), message: uiText("请先配置并选择 OKX 交易账号。", "Configure and select an OKX trading account first.") });
      return;
    }
    const position = privateSnapshot?.positions.find((item) => item.instId === intent.instId && normalizeUiPosSide(item.posSide) === intent.posSide);
    if (!position || Math.abs(Number(position.pos)) <= 0) {
      pushNotification({ kind: "warning", title: uiText("持仓已变化", "Position changed"), message: uiText(`${intent.instId} 当前没有可操作的 ${formatPositionSide(intent.posSide)} 仓位。`, `${intent.instId} no longer has an actionable ${intent.posSide} position.`) });
      return;
    }
    const instrument = assetMap.get(intent.instId);
    const submitSize = normalizeTradeSizeInput(size, instrument, { max: Math.abs(Number(position.pos)), enforceMin: false });
    if (!submitSize || Number(submitSize) <= 0) {
      pushNotification({ kind: "warning", title: uiText("数量无效", "Invalid quantity"), message: uiText("请确认可平张数满足当前合约 lotSz/minSz。", "Ensure the closable quantity satisfies the contract lotSz and minSz.") });
      return;
    }
    if (intent.kind === "market_close") {
      void closeOkxPosition({
        accountId: account.id,
        environment: effectiveTradeEnvironment,
        instId: intent.instId,
        mgnMode: normalizeMarginMode(position.mgnMode),
        posSide: normalizeUiPosSide(position.posSide),
        confirmedLive
      })
        .then((result) => {
          pushNotification({ kind: "trade", title: uiText("市价平仓已提交", "Market close submitted"), message: `${intent.instId} ${chineseUi ? formatPositionSide(position.posSide) : position.posSide}${chineseUi ? "，" : ", "}${result?.ordId || result?.clOrdId || uiText("等待确认", "awaiting confirmation")}` });
          setPrivateHistoryVersion((version) => version + 1);
        })
        .catch((error) => {
          logger.error("position line market close failed", error, { intent });
          pushNotification({ kind: "error", title: uiText("市价平仓失败", "Market close failed"), message: formatTradeErrorMessage(error) });
        });
      return;
    }
    const targetPrice = normalizeTradePriceInput(intent.targetPrice, instrument);
    if (!targetPrice) {
      pushNotification({ kind: "warning", title: uiText("目标价无效", "Invalid target price"), message: uiText(`${intent.instId} 无法按 tickSz 规范化目标价。`, `${intent.instId} could not normalize the target price to tickSz.`) });
      return;
    }
    if (intent.kind === "limit_close") {
      void placeOkxOrder({
        accountId: account.id,
        instId: intent.instId,
        tdMode: normalizeMarginMode(position.mgnMode),
        orderType: "limit",
        ticketMode: "close",
        action: isShortPosition(position) ? "close-short" : "close-long",
        price: targetPrice,
        size: submitSize,
        lever: position.lever || "1",
        environment: effectiveTradeEnvironment,
        confirmedLive,
        operator: "user",
        executionKey: createTradeExecutionKey(account.id, effectiveTradeEnvironment, intent.instId),
        })
        .then((result) => {
          pushNotification({ kind: "trade", title: uiText("限价平仓委托已提交", "Limit close submitted"), message: `${intent.instId} ${chineseUi ? formatPositionSide(position.posSide) : position.posSide} ${submitSize} ${t("trading:contracts")} @ ${targetPrice}${chineseUi ? "，" : ", "}${result?.ordId || result?.clOrdId || uiText("等待确认", "awaiting confirmation")}` });
          setPrivateHistoryVersion((version) => version + 1);
        })
        .catch((error) => {
          logger.error("position line limit close failed", error, { intent });
          pushNotification({ kind: "error", title: uiText("限价平仓失败", "Limit close failed"), message: formatTradeErrorMessage(error) });
        });
      return;
    }
    const targetSide: "tp" | "sl" = intent.kind === "take_profit" ? "tp" : "sl";
    if (intent.existingAlgoId || intent.existingAlgoClientOrderId) {
      void amendOkxAlgoOrder({
        accountId: account.id,
        environment: effectiveTradeEnvironment,
        instId: intent.instId,
        algoId: intent.existingAlgoId,
        algoClOrdId: intent.existingAlgoClientOrderId,
        newSize: submitSize,
        newTpTriggerPx: targetSide === "tp" ? targetPrice : undefined,
        newTpOrdPx: targetSide === "tp" ? orderPx : undefined,
        newSlTriggerPx: targetSide === "sl" ? targetPrice : undefined,
        newSlOrdPx: targetSide === "sl" ? orderPx : undefined,
        confirmedLive,
        executionKey: createTradeExecutionKey(account.id, effectiveTradeEnvironment, intent.instId)
      })
        .then((result) => {
          pushNotification({ kind: "trade", title: uiText("策略单修改已提交", "Strategy-order amendment submitted"), message: `${intent.instId} ${chineseUi ? formatPositionLineIntentKind(intent.kind) : intent.kind} -> ${targetPrice}${chineseUi ? "，" : ", "}${result?.algoId || result?.algoClOrdId || uiText("等待确认", "awaiting confirmation")}` });
          setAlgoOrdersVersion((version) => version + 1);
          setPrivateHistoryVersion((version) => version + 1);
        })
        .catch((error) => {
          logger.error("position line amend algo failed", error, { intent });
          pushNotification({ kind: "error", title: uiText("修改策略单失败", "Strategy-order amendment failed"), message: formatTradeErrorMessage(error) });
        });
      return;
    }
    void placeOkxAlgoOrder({
      accountId: account.id,
      environment: effectiveTradeEnvironment,
      instId: intent.instId,
      tdMode: normalizeMarginMode(position.mgnMode),
      posSide: normalizeUiPosSide(position.posSide),
      side: intent.side,
      ordType: "conditional",
      size: submitSize,
      tpTriggerPx: targetSide === "tp" ? targetPrice : undefined,
      tpOrdPx: targetSide === "tp" ? orderPx : undefined,
      slTriggerPx: targetSide === "sl" ? targetPrice : undefined,
      slOrdPx: targetSide === "sl" ? orderPx : undefined,
      confirmedLive,
      operator: "user",
      executionKey: createTradeExecutionKey(account.id, effectiveTradeEnvironment, intent.instId)
    })
      .then((result) => {
        pushNotification({ kind: "trade", title: uiText("策略委托已提交", "Strategy order submitted"), message: `${intent.instId} ${chineseUi ? formatPositionLineIntentKind(intent.kind) : intent.kind} ${submitSize} ${t("trading:contracts")}${chineseUi ? "，" : ", "}${result?.ordId || result?.clOrdId || uiText("等待确认", "awaiting confirmation")}` });
        setAlgoOrdersVersion((version) => version + 1);
        setPrivateHistoryVersion((version) => version + 1);
      })
      .catch((error) => {
        logger.error("position line place algo failed", error, { intent });
        pushNotification({ kind: "error", title: uiText("策略委托失败", "Strategy order failed"), message: formatTradeErrorMessage(error) });
      });
  }, [account, assetMap, effectiveTradeEnvironment, privateSnapshot?.positions, pushNotification]);

  const submitChartRiskRewardIntent = useCallback((intent: ChartRiskRewardTradeIntent, size: string, tdMode: "cross" | "isolated", lever: string, confirmedLive = false) => {
    if (!account) {
      pushNotification({ kind: "warning", title: uiText("无法提交图表交易", "Chart trade cannot be submitted"), message: uiText("请先配置并选择 OKX 交易账号。", "Configure and select an OKX trading account first.") });
      return;
    }
    const instrument = assetMap.get(intent.instId);
    const normalizedSize = normalizeTradeSizeInput(size, instrument);
    const entryPrice = normalizeTradePriceInput(intent.entryPrice, instrument);
    const takeProfitPrice = normalizeTradePriceInput(intent.takeProfitPrice, instrument);
    const stopLossPrice = normalizeTradePriceInput(intent.stopLossPrice, instrument);
    if (!normalizedSize || !entryPrice || (intent.action === "bracket" && (!takeProfitPrice || !stopLossPrice))) {
      pushNotification({ kind: "warning", title: uiText("图表交易参数无效", "Invalid chart-trade parameters"), message: uiText("请确认数量满足 minSz/lotSz，开仓、止盈和止损价格满足 tickSz。", "Ensure quantity satisfies minSz/lotSz and entry, take-profit, and stop-loss prices satisfy tickSz.") });
      return;
    }
    void submitRiskRewardChartAction({ accountId: account.id, environment: effectiveTradeEnvironment, getInstrument: (instId) => assetMap.get(instId) }, intent, size, tdMode, lever, confirmedLive)
      .then((result) => {
        if (!result) return;
        pushNotification({
          kind: "trade",
          title: intent.action === "bracket" ? uiText("图表开仓与止盈止损已提交", "Chart entry with take profit and stop loss submitted") : uiText("图表限价开仓已提交", "Chart limit entry submitted"),
          message: chineseUi
            ? `${intent.instId} ${intent.side === "long" ? "做多" : "做空"} ${normalizedSize} 张 @ ${entryPrice}${intent.action === "bracket" ? `，TP ${takeProfitPrice} / SL ${stopLossPrice}` : ""}。`
            : `${intent.instId} ${intent.side} ${normalizedSize} contracts @ ${entryPrice}${intent.action === "bracket" ? `, TP ${takeProfitPrice} / SL ${stopLossPrice}` : ""}.`
        });
        setPrivateHistoryVersion((version) => version + 1);
      })
      .catch((error) => {
        logger.error("chart risk reward trade failed", error, { intent });
        pushNotification({ kind: "error", title: uiText("图表交易提交失败", "Chart trade submission failed"), message: formatTradeErrorMessage(error) });
      });
  }, [account, assetMap, effectiveTradeEnvironment, pushNotification]);
  useEffect(() => {
    if (Object.keys(pendingOrderLineOverrides).length === 0) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setPendingOrderLineOverrides((items) => {
        const next = Object.fromEntries(Object.entries(items).filter(([, item]) => item.expiresAt > now));
        return Object.keys(next).length === Object.keys(items).length ? items : next;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [pendingOrderLineOverrides]);

  useEffect(() => {
    if (optimisticPendingOrders.length === 0) return;
    const liveKeys = new Set((privateSnapshot?.orders ?? []).map(pendingOrderKey).filter(Boolean));
    const now = Date.now();
    setOptimisticPendingOrders((items) =>
      items.filter((item) => item.optimisticExpiresAt > now && !liveKeys.has(pendingOrderKey(item)) && isActivePendingOrder(item))
    );
    const timer = window.setInterval(() => {
      const current = Date.now();
      setOptimisticPendingOrders((items) => items.filter((item) => item.optimisticExpiresAt > current && isActivePendingOrder(item)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [optimisticPendingOrders.length, privateSnapshot?.orders]);

  useEffect(() => {
    const updateContext = () => {
      const now = Date.now() + (timeState?.clockOffsetMs ?? 0);
      const liveTicker = getMarketHotState().ticker;
      logger.setContext({
        view: "trading-terminal",
        symbol,
        bar,
        activeTab,
        selectedAccountId: account?.id,
        accountName: account?.name,
        accountEnvironment: account?.environment,
        tradeEnvironment: effectiveTradeEnvironment,
        publicWsStatus: formatWsStatus(wsStatus),
        privateStatus,
        publicDelayMs: liveTicker ? now - liveTicker.ts : undefined,
        privateDelayMs: privateEventTime ? now - privateEventTime : undefined
      });
    };
    updateContext();
    const timer = window.setInterval(updateContext, 5_000);
    return () => {
      window.clearInterval(timer);
      logger.clearContext();
    };
  }, [account?.environment, account?.id, account?.name, activeTab, bar, effectiveTradeEnvironment, privateEventTime, privateStatus, symbol, timeState?.clockOffsetMs, wsStatus]);
  useEffect(() => {
    if (!selectedAccount || !selectedAccountScopeKey) return;
    if (selectedAccount.environment !== "live" || liveRiskAcknowledged[selectedAccountScopeKey]) {
      approvedAccountScopeKeyRef.current = selectedAccountScopeKey;
      return;
    }
    const pendingScopeKey = pendingLiveAccountScope
      ? accountEnvironmentScopeKey(pendingLiveAccountScope)
      : null;
    if (liveConfirmOpen && pendingScopeKey === selectedAccountScopeKey) return;
    setPendingLivePreviousAccountScopeKey(approvedAccountScopeKeyRef.current);
    setPendingLiveAccountScope({ id: selectedAccount.id, environment: selectedAccount.environment });
    setLiveConfirmOpen(true);
  }, [liveConfirmOpen, liveRiskAcknowledged, pendingLiveAccountScope, selectedAccount, selectedAccountScopeKey]);

  useEffect(() => {
    refreshPrivateHistoryStatus(account);
  }, [account, refreshPrivateHistoryStatus, privateHistoryVersion]);

  useEffect(() => {
    if (!account?.permissions.read || privateHistoryStatus?.accountId !== account.id) return;
    const missingRequired = privateHistoryMissingRequiredScopes(privateHistoryStatus);
    if (missingRequired.length === 0) return;
    logger.info("private history endpoints missing, scheduling compatibility sync", {
      accountId: account.id,
      environment: account.environment,
      missingRequired
    });
    triggerPrivateHistorySync(account, "startup");
  }, [account, privateHistoryStatus, triggerPrivateHistorySync]);

  useEffect(() => {
    let mounted = true;
    const listenerCleanup = createDeferredCleanupSlot();
    void listenTradeAuditEvents((event) => {
      if (!mounted) return;
      const eventAccount = accountsRef.current.find((item) => item.id === event.accountId && item.environment === event.environment);
      const notification = tradeAuditNotification(event, eventAccount?.name, t);
      if (notification) pushNotification(notification);
      if (account && event.accountId !== account.id) return;
      if (account && event.environment !== account.environment) return;
      setTradeAuditEvents((items) => [event, ...items.filter((item) => item.id !== event.id)].slice(0, 160));
      setTradeAuditStatus("实时更新");
      setPrivateHistoryVersion((version) => version + 1);
    }).then((unlisten) => listenerCleanup.settle(unlisten));
    return () => {
      mounted = false;
      listenerCleanup.dispose();
    };
  }, [account, pushNotification, t]);

  const refreshPrivateSnapshot = useCallback(async () => {
    if (!account) {
      setPrivateSnapshot(null);
      setPrivateStatus("未配置账号");
      return;
    }
    if (!account.permissions.read) {
      setPrivateSnapshot(null);
      setPrivateStatus("未开启读取权限");
      return;
    }
    setPrivateStatus("同步中");
    const snapshot = await fetchPrivateSnapshot(account.id);
    if (snapshot) {
      const key = privateAccountKey(snapshot.accountId, snapshot.environment);
      if (key) setPrivateSnapshots((items) => ({ ...items, [key]: snapshot }));
      setPrivateSnapshot(snapshot);
      setPrivateStatus((current) => (current === "实时同步" ? current : "已同步"));
    } else {
      setPrivateStatus("仅 Tauri 可用");
    }
  }, [account]);

  const schedulePrivateSnapshotRefresh = useCallback(() => {
    for (const delay of [0, 800, 2500]) {
      window.setTimeout(() => {
        void refreshPrivateSnapshot().catch((error) => logger.warn("delayed private snapshot refresh failed", { error: String(error) }));
      }, delay);
    }
  }, [refreshPrivateSnapshot]);

  const submitOrderLineCancel = useCallback((line: ChartOrderLine) => {
    if (!account) {
      pushNotification({ kind: "warning", title: "无法撤单", message: "请先配置并选择 OKX 交易账号。" });
      return;
    }
    const isAlgo = isChartAlgoOrderLine(line);
    if (!line.orderId && !line.clientOrderId && !line.algoId && !line.algoClientOrderId) {
      pushNotification({ kind: "warning", title: "无法撤单", message: `${line.label} 缺少 OKX 委托 ID。` });
      return;
    }
    void cancelChartOrder({ accountId: account.id, environment: effectiveTradeEnvironment, defaultInstId: symbol }, line, true)
      .then((result) => {
        pushNotification({
          kind: "trade",
          title: isAlgo ? "撤销策略委托已接受" : "撤单请求已接受",
          message: `${symbol} ${result?.ordId || result?.clOrdId || line.orderId || line.clientOrderId || line.algoId || line.algoClientOrderId}`
        });
        dismissPendingOrderLocally({
          ordId: result?.ordId || line.orderId || "",
          clOrdId: result?.clOrdId || line.clientOrderId || "",
          algoId: isAlgo ? (result?.ordId || line.algoId || "") : "",
          algoClOrdId: isAlgo ? (result?.clOrdId || line.algoClientOrderId || "") : "",
        });
        if (isAlgo) setAlgoOrdersVersion((version) => version + 1);
        setPrivateHistoryVersion((version) => version + 1);
        schedulePrivateSnapshotRefresh();
      })
      .catch((error) => {
        logger.error("chart cancel order failed", error, { symbol, line });
        pushNotification({ kind: "error", title: "图表撤单失败", message: formatTradeErrorMessage(error) });
      });
  }, [account, dismissPendingOrderLocally, effectiveTradeEnvironment, pushNotification, schedulePrivateSnapshotRefresh, symbol]);
  const requestOrderLineCancel = useCallback((line: ChartOrderLine) => {
    if (!account) {
      pushNotification({ kind: "warning", title: "无法撤单", message: "请先配置并选择 OKX 交易账号。" });
      return;
    }
    if (!line.orderId && !line.clientOrderId && !line.algoId && !line.algoClientOrderId) {
      pushNotification({ kind: "warning", title: "无法撤单", message: `${line.label} 缺少 OKX 委托 ID。` });
      return;
    }
    setPendingOrderLineCancel(line);
  }, [account, pushNotification]);

  useEffect(() => {
    if (!account) {
      setPrivateSnapshot(null);
      setPrivateStatus("未配置账号");
      return;
    }
    if (!account.permissions.read) {
      setPrivateSnapshot(null);
      setPrivateStatus("未开启读取权限");
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const snapshot = await fetchPrivateSnapshot(account.id);
        if (cancelled) return;
        if (snapshot) {
          const key = privateAccountKey(snapshot.accountId, snapshot.environment);
          if (key) setPrivateSnapshots((items) => ({ ...items, [key]: snapshot }));
          setPrivateSnapshot(snapshot);
          setPrivateStatus((current) => (current === "实时同步" ? current : "已同步"));
        } else {
          setPrivateStatus("仅 Tauri 可用");
        }
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        const isTimestampExpired = message.includes("50102") || message.toLowerCase().includes("timestamp request expired");
        const isEnvironmentMismatch = message.includes("50101") || message.includes("environment");
        const isAuthenticationFailure = message.includes("401") || message.includes('"category":"auth"');
        const status = isTimestampExpired
          ? "时间同步失败"
          : isEnvironmentMismatch
            ? "环境不匹配"
            : isAuthenticationFailure
              ? "账号认证失败"
              : "同步失败";
        setPrivateStatus(status);
        logger.warn("private OKX snapshot sync failed", {
          accountId: account.id,
          category: isTimestampExpired ? "time_sync" : isEnvironmentMismatch ? "environment" : isAuthenticationFailure ? "auth" : "sync",
          message
        });
        const notificationKey = `${account.id}:${status}`;
        const now = Date.now();
        const lastNotificationAt = privateSnapshotNotificationRef.current[notificationKey] ?? 0;
        if (now - lastNotificationAt >= 60_000) {
          privateSnapshotNotificationRef.current[notificationKey] = now;
          pushNotification({
            kind: "error",
            title: isTimestampExpired
              ? t("trading:okxTimeSyncFailed")
              : isEnvironmentMismatch
                ? t("trading:accountEnvironmentMismatch")
                : t("trading:accountSyncFailed"),
            message: isTimestampExpired
              ? t("trading:okxTimeSyncFailedHelp")
              : isEnvironmentMismatch
                ? t("trading:accountEnvironmentMismatchHelp")
                : message
          });
        }
      } finally {
        if (!cancelled) timer = window.setTimeout(refresh, 15_000);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [account, pushNotification, t]);

  useEffect(() => {
    if (!account) {
      setPositionEpisodes([]);
      setEpisodesStatus("未配置账号");
      return;
    }
    if (!account.permissions.read) {
      setPositionEpisodes([]);
      setEpisodesStatus("未开启读取权限");
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        setEpisodesStatus("同步中");
        const episodes = await fetchPositionEpisodes({ accountId: account.id, limit: 200 });
        if (cancelled) return;
        if (episodes) {
          setPositionEpisodes(episodes);
          setEpisodesStatus(episodes.length > 0 ? "已同步" : "暂无历史持仓");
        } else {
          setPositionEpisodes([]);
          setEpisodesStatus("仅 Tauri 可用");
        }
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        logger.error("failed to load position episodes", error, { accountId: account.id });
        setEpisodesStatus(message);
      } finally {
        if (!cancelled) timer = window.setTimeout(refresh, 60_000);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [account, privateHistoryVersion]);

  useEffect(() => {
    if (!account) {
      setHistoricalOrders([]);
      setHistoricalOrdersStatus("未配置账号");
      return;
    }
    if (!account.permissions.read) {
      setHistoricalOrders([]);
      setHistoricalOrdersStatus("未开启读取权限");
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        setHistoricalOrdersStatus("同步中");
        const orders = await fetchHistoricalOrders({ accountId: account.id, limit: 300 });
        if (cancelled) return;
        if (orders) {
          setHistoricalOrders(orders);
          setHistoricalOrdersStatus(orders.length > 0 ? "已同步" : "暂无历史委托");
        } else {
          setHistoricalOrders([]);
          setHistoricalOrdersStatus("仅 Tauri 可用");
        }
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        logger.error("failed to load historical orders", error, { accountId: account.id });
        setHistoricalOrders([]);
        setHistoricalOrdersStatus(message);
      } finally {
        if (!cancelled) timer = window.setTimeout(refresh, 60_000);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [account, privateHistoryVersion]);

  useEffect(() => {
    if (!account) {
      setHistoricalFills([]);
      setHistoricalFillsStatus("未配置账号");
      return;
    }
    if (!account.permissions.read) {
      setHistoricalFills([]);
      setHistoricalFillsStatus("未开启读取权限");
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        setHistoricalFillsStatus("同步中");
        const fills = await fetchHistoricalFills({ accountId: account.id, limit: 300 });
        fetchChartTradeSources()
          .then((sources) => { if (!cancelled && sources) setChartTradeSources(sources); })
          .catch(() => undefined);
        if (cancelled) return;
        if (fills) {
          setHistoricalFills(fills);
          setHistoricalFillsStatus(fills.length > 0 ? "已同步" : "暂无历史成交");
        } else {
          setHistoricalFills([]);
          setHistoricalFillsStatus("仅 Tauri 可用");
        }
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        logger.error("failed to load historical fills", error, { accountId: account.id });
        setHistoricalFills([]);
        setHistoricalFillsStatus(message);
      } finally {
        if (!cancelled) timer = window.setTimeout(refresh, 60_000);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [account, privateHistoryVersion]);

  useEffect(() => {
    if (!account) {
      setAlgoOrders([]);
      setAlgoOrdersPendingReadComplete(false);
      setAlgoOrdersStatus("未配置账号");
      return;
    }
    if (!account.permissions.read) {
      setAlgoOrders([]);
      setAlgoOrdersPendingReadComplete(false);
      setAlgoOrdersStatus("未开启读取权限");
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        setAlgoOrdersStatus("同步中");
        const response = await fetchOkxAlgoOrders({
          accountId: account.id,
          environment: effectiveTradeEnvironment,
          includeHistory: true
        });
        if (cancelled) return;
        if (response) {
          setAlgoOrders(response.orders);
          setAlgoOrdersPendingReadComplete(
            response.pendingReadComplete !== false,
          );
          setAlgoOrdersStatus(
            response.orders.length > 0 ? "已同步" : "暂无策略委托",
          );
        } else {
          setAlgoOrders([]);
          setAlgoOrdersPendingReadComplete(false);
          setAlgoOrdersStatus("仅 Tauri 可用");
        }
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          "failed to load algo orders; retaining last successful snapshot",
          error,
          { accountId: account.id },
        );
        setAlgoOrdersStatus(`同步失败，保留最近数据：${message}`);
      } finally {
        if (!cancelled) timer = window.setTimeout(refresh, 15_000);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [account, effectiveTradeEnvironment, algoOrdersVersion, privateHistoryVersion]);

  useEffect(() => {
    if (!account) {
      setAccountBills([]);
      setAccountBillsStatus("未配置账号");
      return;
    }
    if (!account.permissions.read) {
      setAccountBills([]);
      setAccountBillsStatus("未开启读取权限");
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        setAccountBillsStatus("同步中");
        const bills = await fetchAccountBills({ accountId: account.id, limit: 300 });
        if (cancelled) return;
        if (bills) {
          setAccountBills(bills);
          setAccountBillsStatus(bills.length > 0 ? "已同步" : "暂无资金流水");
        } else {
          setAccountBills([]);
          setAccountBillsStatus("仅 Tauri 可用");
        }
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        logger.error("failed to load account bills", error, { accountId: account.id });
        setAccountBills([]);
        setAccountBillsStatus(message);
      } finally {
        if (!cancelled) timer = window.setTimeout(refresh, 60_000);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [account, privateHistoryVersion]);

  useEffect(() => {
    if (!account) {
      setTradeAuditEvents([]);
      setTradeAuditStatus("未配置账号");
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        setTradeAuditStatus("同步中");
        const events = await fetchTradeAuditEvents({ accountId: account.id, limit: 300 });
        if (cancelled) return;
        if (events) {
          setTradeAuditEvents(events);
          setTradeAuditStatus(events.length > 0 ? "已同步" : "暂无交易审计");
        } else {
          setTradeAuditEvents([]);
          setTradeAuditStatus("仅 Tauri 可用");
        }
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        logger.error("failed to load trade audit events", error, { accountId: account.id });
        setTradeAuditEvents([]);
        setTradeAuditStatus(message);
      } finally {
        if (!cancelled) timer = window.setTimeout(refresh, 30_000);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [account, privateHistoryVersion]);

  const refreshTradeOpportunities = useCallback(async () => {
    try {
      setTradeOpportunityStatus("同步中");
      const items = await fetchTradeOpportunities();
      if (items) {
        setTradeOpportunities(items);
        setTradeOpportunityStatus(items.length > 0 ? "已同步" : "暂无交易机会");
        setSelectedOpportunityId((current) => current ?? items[0]?.id ?? null);
      } else {
        setTradeOpportunities([]);
        setTradeOpportunityStatus("仅 Tauri 可用");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("failed to load trade opportunities", error);
      setTradeOpportunityStatus(message);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const refresh = async () => {
      await refreshTradeOpportunities();
      if (!cancelled) timer = window.setTimeout(refresh, 20_000);
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [refreshTradeOpportunities, privateHistoryVersion]);

  useEffect(() => {
    const handleOpenOpportunity = (event: Event) => {
      const id = String((event as CustomEvent<{ id?: string }>).detail?.id ?? "").trim();
      if (!id) return;
      setMainSection("opportunities");
      setSelectedOpportunityId(id);
      void refreshTradeOpportunities();
    };
    window.addEventListener("desic:open-trade-opportunity", handleOpenOpportunity);
    return () => window.removeEventListener("desic:open-trade-opportunity", handleOpenOpportunity);
  }, [refreshTradeOpportunities]);

  useEffect(() => {
    const handleOpenSettings = (event: Event) => {
      const tab = String((event as CustomEvent<{ tab?: string }>).detail?.tab ?? "");
      if (!["general", "account", "proxy", "ai", "prompt", "skills", "notifications", "storage"].includes(tab)) return;
      setSettingsActiveTab(tab as SettingsTab);
      setMainSection("config");
    };
    window.addEventListener("desic:open-settings", handleOpenSettings);
    return () => window.removeEventListener("desic:open-settings", handleOpenSettings);
  }, []);

  useEffect(() => {
    let mounted = true;
    const listenerCleanup = createDeferredCleanupSlot();
    void listenAiEvents((event) => {
      if (!mounted || event.type !== "toolResult") return;
      const toolName = event.name || "";
      if (toolName !== "tradeOpportunity.create" && toolName !== "tradeOpportunity_create") return;
      const result = event.result as Partial<TradeOpportunity> | undefined;
      void refreshTradeOpportunities();
      pushNotification({
        kind: "trade",
        title: t("automation:aiCreatedOpportunity"),
        message: result?.instId
          ? t("automation:aiCreatedOpportunityMessage", { symbol: result.instId, direction: result.direction === "short" ? t("trading:short") : t("trading:long"), size: result.size ?? "" })
          : t("automation:viewOpportunityList"),
        action: "trade-opportunities",
        targetId: result?.id
      });
    }).then((unlisten) => listenerCleanup.settle(unlisten));
    return () => {
      mounted = false;
      listenerCleanup.dispose();
    };
  }, [pushNotification, refreshTradeOpportunities, t]);

  const approveOpportunity = useCallback(async (id: string) => {
    try {
      const result = await approveTradeOpportunity(id);
      if (result) {
        setTradeOpportunities((items) => [result, ...items.filter((item) => item.id !== id)]);
        setSelectedOpportunityId(result.id);
        const optimisticOrder = optimisticPendingOrderFromOpportunity(result);
        if (optimisticOrder) {
          setOptimisticPendingOrders((items) => [optimisticOrder, ...items.filter((item) => pendingOrderKey(item) !== pendingOrderKey(optimisticOrder))]);
        }
      }
      setPrivateHistoryVersion((version) => version + 1);
      schedulePrivateSnapshotRefresh();
      pushNotification({ kind: "trade", title: "交易机会已批准", message: result ? `${result.instId} ${formatOpportunityDirection(result)} 已提交。` : id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushNotification({ kind: "error", title: "交易机会执行失败", message });
    }
  }, [pushNotification, schedulePrivateSnapshotRefresh]);

  const rejectOpportunity = useCallback(async (id: string) => {
    try {
      const result = await rejectTradeOpportunity(id);
      if (result) {
        setTradeOpportunities((items) => [result, ...items.filter((item) => item.id !== id)]);
        setSelectedOpportunityId(result.id);
      }
      pushNotification({ kind: "info", title: "交易机会已拒绝", message: id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushNotification({ kind: "error", title: "拒绝交易机会失败", message });
    }
  }, [pushNotification]);

  const deleteOpportunity = useCallback(async (id: string) => {
    try {
      const deleted = await deleteTradeOpportunity(id);
      setTradeOpportunities((items) => items.filter((item) => item.id !== id));
      setSelectedOpportunityId((current) => {
        if (current !== id) return current;
        return tradeOpportunities.find((item) => item.id !== id)?.id ?? null;
      });
      pushNotification({ kind: "info", title: "交易机会已删除", message: deleted ? id : "未找到可删除记录" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushNotification({ kind: "error", title: "删除交易机会失败", message });
    }
  }, [pushNotification, tradeOpportunities]);

  const clearOpportunities = useCallback(async () => {
    try {
      const deleted = await clearTradeOpportunities();
      setTradeOpportunities([]);
      setSelectedOpportunityId(null);
      pushNotification({ kind: "info", title: "交易机会已清空", message: `已删除 ${deleted ?? 0} 条机会记录` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushNotification({ kind: "error", title: "清空交易机会失败", message });
    }
  }, [pushNotification]);

  const symbolSyncStatus = useMemo(() => summarizeKlineSync(klineSync), [klineSync]);
  const addWatchSymbol = useCallback((raw: string) => {
    const tokens = splitWatchSymbols(raw);
    if (tokens.length === 0) {
      pushNotification({ kind: "warning", title: "无法识别交易对", message: "请输入类似 BTC、ETH 或 BTC-USDT-SWAP 的永续合约，可用逗号、空格或换行批量添加。" });
      return;
    }

    const normalized = tokens.map((token) => normalizeSwapSymbol(token, assetMap));
    const invalid = tokens.filter((_, index) => !normalized[index]);
    const known = normalized.filter(Boolean) as string[];
    const missing = marketAssets?.instruments?.length ? known.filter((item) => !assetMap.has(item)) : [];
    const candidates = Array.from(new Set(known.filter((item) => !missing.includes(item))));
    const existingSet = new Set(watchlist);
    const newSymbols: string[] = [];
    let slots = Math.max(0, 10 - watchlist.length);
    for (const item of candidates) {
      if (existingSet.has(item)) continue;
      if (slots <= 0) break;
      newSymbols.push(item);
      existingSet.add(item);
      slots -= 1;
    }

    const overflow = candidates.filter((item) => !watchlist.includes(item)).length - newSymbols.length;
    if (invalid.length > 0) {
      pushNotification({ kind: "warning", title: "部分交易对无法识别", message: invalid.slice(0, 5).join("、") });
    }
    if (missing.length > 0) {
      pushNotification({ kind: "warning", title: "部分交易对不存在", message: `${missing.slice(0, 5).join("、")} 不在 OKX SWAP 交易对资源中。` });
    }
    if (overflow > 0) {
      pushNotification({ kind: "warning", title: "自选已满", message: `观察交易对最多 10 个，已有 ${overflow} 个未添加。` });
    }
    if (candidates.length === 0 || newSymbols.length === 0) {
      const firstKnown = candidates.find((item) => watchlist.includes(item));
      if (firstKnown) setSymbol(firstKnown);
      if (!firstKnown && invalid.length === 0 && missing.length === 0) {
        pushNotification({ kind: "info", title: "自选未变化", message: "输入的交易对已经在自选列表中。" });
      }
      setSymbolSearch("");
      return;
    }

    const next = persistWatchlist([...watchlist, ...newSymbols]);
    setWatchlist(next);
    void saveWatchlistConfig({ symbols: next }).catch((error) => logger.error("failed to save watchlist config", error));
    void ensureInstrumentsCache(newSymbols)
      .then((summary) => {
        if (summary) setMarketAssets(summary);
      })
      .catch((error) => logger.error("failed to cache new watchlist instruments", error, { symbols: newSymbols }));
    const selected = newSymbols[newSymbols.length - 1];
    setSymbol(selected);
    setSymbolSearch("");
    newSymbols.forEach((item) => {
      void fetchTicker(item)
        .then((tickerItem) => queueWatchTicker(tickerItem))
        .catch((error) => logger.error("failed to fetch added symbol ticker", error, { symbol: item }));
    });
    pushNotification({
      kind: "info",
      title: newSymbols.length > 1 ? "开始批量补齐 K 线" : "开始补齐 K 线",
      message: `${newSymbols.join("、")} 已加入自选，正在检查 1m 基础 K 线完整性。`
    });
    void syncKlineIntegrity(newSymbols, KLINE_INTEGRITY_INTERVALS, false, undefined, KLINE_REQUIRED_DAYS);
  }, [assetMap, marketAssets?.instruments?.length, pushNotification, watchlist]);

  const loadMoreHistory = useCallback(({ firstTime }: { firstTime: number }): Promise<ChartHistoryLoadOutcome> => {
    const requestSymbol = symbol;
    const requestBar = bar;
    const historyKey = `${requestSymbol}\u0000${requestBar}`;
    const requestKey = `${historyKey}\u0000${firstTime}`;
    if (!Number.isFinite(firstTime) || firstTime <= 0) {
      return Promise.resolve({ status: "failed", message: "invalid history cursor" });
    }
    if (historyExhaustedRef.current.has(historyKey)) {
      return Promise.resolve({ status: "exhausted" });
    }
    const existing = historyRequestsRef.current.get(requestKey);
    if (existing) return existing;

    const request = (async (): Promise<ChartHistoryLoadOutcome> => {
      try {
        const page = await fetchHistoricalCandlesBefore(requestSymbol, requestBar, firstTime, 300);
        if (page.instId !== requestSymbol || page.bar !== requestBar) {
          const message = `历史 K 线响应身份不匹配：请求 ${requestSymbol} ${requestBar}，收到 ${page.instId} ${page.bar}`;
          logger.error(message, { requestSymbol, requestBar, responseSymbol: page.instId, responseBar: page.bar, firstTime });
          return { status: "failed", message };
        }
        logger.info("loaded earlier candles", { symbol: requestSymbol, bar: requestBar, firstTime, count: page.candles.length, exhausted: page.exhausted, source: page.source });
        if (page.candles.length > 0
          && symbolRef.current === requestSymbol
          && barRef.current === requestBar) {
          mergeIntoMarketCandles(page.candles, historyKey);
        }
        if (page.exhausted) {
          historyExhaustedRef.current.add(historyKey);
          return { status: "exhausted" };
        }
        const earliestTime = page.earliestTime ?? page.candles[0]?.time;
        if (page.candles.length > 0 && earliestTime) {
          return { status: "loaded", earliestTime };
        }
        return { status: "deferred" };
      } catch (error) {
        const message = formatTradeErrorMessage(error);
        logger.error("failed to load earlier candles", error, { symbol: requestSymbol, bar: requestBar, firstTime });
        pushNotification({
          kind: "warning",
          title: "历史 K 线加载失败",
          message: `${requestSymbol} ${requestBar} 更早历史暂未加载：${message}`
        });
        return { status: "failed", message };
      } finally {
        historyRequestsRef.current.delete(requestKey);
        setHistoryLoading(historyRequestsRef.current.size > 0);
      }
    })();
    historyRequestsRef.current.set(requestKey, request);
    setHistoryLoading(true);
    return request;
  }, [bar, pushNotification, symbol]);

  const requestAccountBillsArchive = useCallback(async (apply: boolean) => {
    if (!account) {
      pushNotification({ kind: "warning", title: "未配置账号", message: "请先配置带读取权限的 OKX 账号。" });
      return;
    }
    if (!account.permissions.read) {
      pushNotification({ kind: "warning", title: "账号无读取权限", message: "资金流水归档需要 OKX API Key 读取权限。" });
      return;
    }
    const target = previousQuarter();
    setAccountBillsArchiveBusy(true);
    try {
      const status = await fetchAccountBillsArchiveStatus({
        accountId: account.id,
        year: String(target.year),
        quarter: target.quarter,
        apply
      });
      if (status) setAccountBillsArchiveStatus(status);
      pushNotification({
        kind: status?.fileHref ? "success" : apply ? "info" : "warning",
        title: apply ? "账单归档申请已提交" : "账单归档状态已查询",
        message: formatArchiveStatusMessage(status, target.year, target.quarter)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("account bills archive status failed", error, { accountId: account.id, apply });
      pushNotification({ kind: "error", title: "账单归档处理失败", message });
    } finally {
      setAccountBillsArchiveBusy(false);
    }
  }, [account, pushNotification]);
  const importPreviousAccountBillsArchive = useCallback(async () => {
    if (!account) {
      pushNotification({ kind: "warning", title: "未配置账号", message: "请先配置带读取权限的 OKX 账号。" });
      return;
    }
    if (!account.permissions.read) {
      pushNotification({ kind: "warning", title: "账号无读取权限", message: "资金流水归档需要 OKX API Key 读取权限。" });
      return;
    }
    const target = previousQuarter();
    setAccountBillsArchiveImporting(true);
    try {
      const result = await importAccountBillsArchive({
        accountId: account.id,
        year: String(target.year),
        quarter: target.quarter
      });
      if (result) {
        setPrivateHistoryVersion((value) => value + 1);
        pushNotification({
          kind: "success",
          title: "账单归档导入完成",
          message: `${result.year} ${result.quarter} 已扫描 ${result.rowsScanned} 行，写入 ${result.rowsUpserted} 条 SWAP 资金流水。`
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("account bills archive import failed", error, { accountId: account.id });
      pushNotification({ kind: "error", title: "账单归档导入失败", message });
    } finally {
      setAccountBillsArchiveImporting(false);
    }
  }, [account, pushNotification]);
  const removeWatchSymbol = useCallback((target: string) => {
    if (target === DEFAULT_SYMBOL) {
      pushNotification({ kind: "warning", title: "默认交易对不可移除", message: `${DEFAULT_SYMBOL} 是默认观察交易对。` });
      return;
    }
    setWatchlist((items) => {
      if (!items.includes(target)) return items;
      const next = persistWatchlist(items.filter((item) => item !== target));
      void saveWatchlistConfig({ symbols: next }).catch((error) => logger.error("failed to save watchlist config", error));
      return next;
    });
    if (symbol === target) setSymbol(DEFAULT_SYMBOL);
    pushNotification({ kind: "info", title: "已移除自选", message: `${target} 已从观察列表移除，后台 ticker 订阅会随列表重建。` });
  }, [pushNotification, symbol]);
  const reorderWatchSymbol = useCallback((source: string, target: string) => {
    if (source === target) return;
    setWatchlist((items) => {
      const from = items.indexOf(source);
      const to = items.indexOf(target);
      if (from < 0 || to < 0) return items;
      const nextItems = [...items];
      const [moved] = nextItems.splice(from, 1);
      nextItems.splice(to, 0, moved);
      const next = persistWatchlist(nextItems);
      void saveWatchlistConfig({ symbols: next }).catch((error) => logger.error("failed to save reordered watchlist config", error));
      return next;
    });
  }, []);
  const handleWindowAction = useCallback(async (action: "minimize" | "maximize" | "close") => {
    const handled = await invokeOptional<boolean>("window_action", { action });
    if (handled !== null) {
      if (action === "maximize") setIsMaximized(handled);
      return;
    }
    if (!isTauriRuntime()) return;
    try {
      const windowApi = await import("@tauri-apps/api/window");
      const windowApiCompat = windowApi as typeof windowApi & {
        getCurrentWebviewWindow?: () => ReturnType<typeof windowApi.getCurrentWindow>;
      };
      const currentWindow =
        typeof windowApiCompat.getCurrentWindow === "function"
          ? windowApiCompat.getCurrentWindow()
          : typeof windowApiCompat.getCurrentWebviewWindow === "function"
            ? windowApiCompat.getCurrentWebviewWindow()
            : null;
      if (!currentWindow) return;
      if (action === "minimize") {
        await currentWindow.minimize();
        return;
      }
      if (action === "close") {
        await currentWindow.close();
        return;
      }
      const maximized = await currentWindow.isMaximized();
      if (maximized) await currentWindow.unmaximize();
      else await currentWindow.maximize();
      setIsMaximized(!maximized);
    } catch (error) {
      logger.error("window action failed", error, { action });
    }
  }, []);
  const openNotificationTarget = useCallback((notification: AppNotification) => {
    if (notification.action === "trade-opportunities") {
      setMainSection("opportunities");
      setSelectedOpportunityId(notification.targetId ?? null);
      void refreshTradeOpportunities();
    }
    if (notification.action === "ai-automation") {
      setAutomationInitialTab(notification.automationTab ?? "runs");
      setAutomationFocusId(notification.targetId ?? null);
      setMainSection("automation");
    }
    if (notification.action === "settings") {
      setSettingsActiveTab(notification.settingsTab ?? "notifications");
      setMainSection("config");
    }
    setNotificationCenterOpen(false);
  }, [refreshTradeOpportunities]);
  const openAiSettings = useCallback(() => {
    setSettingsActiveTab("ai");
    setMainSection("config");
  }, []);
  const openHelpTarget = useCallback((target: HelpTarget) => {
    setHelpCenterOpen(false);
    if (target.kind === "settings") {
      setSettingsActiveTab(target.tab);
      setMainSection("config");
      return;
    }
    if (target.kind === "notifications") {
      setNotificationCenterOpen(true);
      return;
    }
    if (target.kind === "onboarding") {
      firstLaunchOnboarding.reopen();
      return;
    }
    if (target.section === "automation") {
      setAutomationInitialTab(target.automationTab ?? "profiles");
      setAutomationFocusId(null);
    }
    setMainSection(target.section);
  }, [firstLaunchOnboarding]);
  const applyChartAdjacentSize = useCallback((axis: ChartResizeGesture["axis"], size: number) => {
    if (axis === "width") contentGridRef.current?.style.setProperty("--chart-depth-size", `${Math.round(size)}px`);
    else centerPanelRef.current?.style.setProperty("--chart-bottom-size", `${Math.round(size)}px`);
  }, []);

  const chartResizeBounds = useCallback((axis: ChartResizeGesture["axis"]) => {
    if (axis === "width") {
      const center = centerPanelRef.current?.getBoundingClientRect();
      const depth = contentGridRef.current?.querySelector<HTMLElement>(".market-depth")?.getBoundingClientRect();
      if (!center || !depth) return null;
      const configuredMin = Number.parseFloat(window.getComputedStyle(contentGridRef.current as HTMLElement).getPropertyValue("--chart-depth-min"));
      const min = Number.isFinite(configuredMin) ? configuredMin : 152;
      return {
        size: depth.width,
        min,
        max: Math.max(min, center.width + depth.width - 320)
      };
    }
    const chart = centerPanelRef.current?.querySelector<HTMLElement>(".chart-stage")?.getBoundingClientRect();
    const bottom = centerPanelRef.current?.querySelector<HTMLElement>(".bottom-panel")?.getBoundingClientRect();
    if (!chart || !bottom) return null;
    return {
      size: bottom.height,
      min: 142,
      max: Math.max(142, chart.height + bottom.height - 220)
    };
  }, []);

  const startChartResize = useCallback((axis: ChartResizeGesture["axis"], event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = chartResizeBounds(axis);
    if (!bounds) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    chartResizeGestureRef.current = {
      axis,
      pointerId: event.pointerId,
      startCoordinate: axis === "width" ? event.clientX : event.clientY,
      originSize: bounds.size,
      minSize: bounds.min,
      maxSize: bounds.max,
      lastSize: bounds.size
    };
    contentGridRef.current?.classList.add(axis === "width" ? "resizing-chart-width" : "resizing-chart-height");
  }, [chartResizeBounds]);

  const moveChartResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = chartResizeGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    const coordinate = gesture.axis === "width" ? event.clientX : event.clientY;
    const next = Math.min(gesture.maxSize, Math.max(gesture.minSize, gesture.originSize - (coordinate - gesture.startCoordinate)));
    gesture.lastSize = next;
    applyChartAdjacentSize(gesture.axis, next);
  }, [applyChartAdjacentSize]);

  const finishChartResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = chartResizeGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    chartResizeGestureRef.current = null;
    contentGridRef.current?.classList.remove("resizing-chart-width", "resizing-chart-height");
    const stored = loadChartWorkspaceLayout();
    saveChartWorkspaceLayout({
      ...stored,
      ...(gesture.axis === "width" ? { depthWidth: gesture.lastSize } : { bottomHeight: gesture.lastSize })
    });
  }, []);

  const nudgeChartResize = useCallback((axis: ChartResizeGesture["axis"], chartDelta: number) => {
    const bounds = chartResizeBounds(axis);
    if (!bounds) return;
    const next = Math.min(bounds.max, Math.max(bounds.min, bounds.size - chartDelta));
    applyChartAdjacentSize(axis, next);
    const stored = loadChartWorkspaceLayout();
    saveChartWorkspaceLayout({
      ...stored,
      ...(axis === "width" ? { depthWidth: next } : { bottomHeight: next })
    });
  }, [applyChartAdjacentSize, chartResizeBounds]);

  const resetChartResize = useCallback((axis: ChartResizeGesture["axis"]) => {
    if (axis === "width") contentGridRef.current?.style.removeProperty("--chart-depth-size");
    else centerPanelRef.current?.style.removeProperty("--chart-bottom-size");
    const stored = loadChartWorkspaceLayout();
    if (axis === "width") delete stored.depthWidth;
    else delete stored.bottomHeight;
    saveChartWorkspaceLayout(stored);
  }, []);

  useEffect(() => {
    if (mainSection !== "terminal") return;
    const frame = window.requestAnimationFrame(() => {
      const stored = loadChartWorkspaceLayout();
      if (Number.isFinite(stored.depthWidth)) {
        const bounds = chartResizeBounds("width");
        if (bounds) applyChartAdjacentSize("width", Math.min(bounds.max, Math.max(bounds.min, Number(stored.depthWidth))));
      }
      if (Number.isFinite(stored.bottomHeight)) {
        const bounds = chartResizeBounds("height");
        if (bounds) applyChartAdjacentSize("height", Math.min(bounds.max, Math.max(bounds.min, Number(stored.bottomHeight))));
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [applyChartAdjacentSize, chartResizeBounds, mainSection]);

  return (
    <main className={clsx(
      "terminal",
      firstLaunchOnboarding.open && "onboarding-active",
      mainSection === "systematic" && "systematic-active",
      mainSection === "automation" && "automation-active",
      mainSection === "intelligence" && "intelligence-active",
    )}>
      <aside className="rail">
        <AppUpdateBadge />
        {navItems.map(({ id, labelKey, Icon }, index) => {
          const label = t(labelKey);
          return (
          <button
            className={clsx(
              "rail-item",
              (id === "opportunities"
                ? mainSection === "opportunities"
                : id === "automation"
                    ? mainSection === "automation"
                  : id === "intelligence"
                    ? mainSection === "intelligence"
                  : id === "systematic"
                    ? mainSection === "systematic"
                  : id === "data"
                    ? mainSection === "data"
                  : id === "settings"
                    ? mainSection === "config"
                  : index === 0 && mainSection === "terminal") && "active"
            )}
            key={id}
            aria-label={label}
            title={label}
            data-workspace={id}
            onPointerEnter={() => {
              if (id === "automation") void loadAiAutomationModule();
              if (id === "systematic") preloadSystematicResearchModule();
            }}
            onFocus={() => {
              if (id === "automation") void loadAiAutomationModule();
              if (id === "systematic") preloadSystematicResearchModule();
            }}
            onClick={() => {
              setSystematicLoading(id === "systematic");
              if (id === "terminal") {
                setMainSection("terminal");
              }
              if (id === "opportunities") {
                setMainSection("opportunities");
                void refreshTradeOpportunities();
              }
              if (id === "automation") {
                setAutomationInitialTab("profiles");
                setAutomationFocusId(null);
                setMainSection("automation");
              }
              if (id === "intelligence") {
                setMainSection("intelligence");
              }
              if (id === "systematic") {
                setMainSection("systematic");
                void loadSystematicResearchModule().catch(() => setSystematicLoading(false));
              }
              if (id === "data") {
                setMainSection("data");
              }
              if (id === "settings") {
                setSettingsActiveTab((current) => current || "general");
                setMainSection("config");
              }
            }}
          >
            <Icon size={20} aria-hidden="true" />
            <span className="rail-item__label" aria-hidden="true">{label}</span>
            {id === "intelligence" && newsUnreadCount > 0 ? <b className="rail-unread-badge">{newsUnreadCount > 99 ? "99+" : newsUnreadCount}</b> : null}
          </button>
          );
        })}
      </aside>

      <section className="workspace">
        <header className="topbar" data-tauri-drag-region>
          {/* The market name is the entry point to the watchlist. Users reach for
              "what am I looking at" when they want to switch, so the list hangs
              off it instead of a separate control floating over the chart. */}
          <div className="market-title" ref={marketPickerRef}>
            <button
              type="button"
              className={clsx("market-title__trigger", marketPickerOpen && "is-open")}
              onClick={() => setMarketPickerOpen((open) => !open)}
              aria-expanded={marketPickerOpen}
              aria-haspopup="listbox"
              title={t("trading:openWatchlist")}
            >
              <SymbolIcon base={currentInstrument?.baseCcy || symbol.split("-")[0]} iconPath={currentInstrument?.iconPath} cached={currentInstrument?.iconCached} cacheDir={marketAssetCacheDir} />
              <strong>{symbol}</strong>
              <span>{t("common:perpetual")}</span>
              <ChevronDown size={15} className="market-title__chevron" />
            </button>
            {marketPickerOpen ? (
              <MarketPickerMenu
                symbol={symbol}
                watchlist={watchlist}
                options={filteredWatchOptions}
                query={symbolSearch}
                marketAssets={marketAssets}
                cacheDir={marketAssetCacheDir}
                onQueryChange={setSymbolSearch}
                onSelect={(next) => { setSymbol(next); setMarketPickerOpen(false); }}
                onAdd={addWatchSymbol}
                onRemove={removeWatchSymbol}
                onClose={() => setMarketPickerOpen(false)}
              />
            ) : null}
          </div>
          <HotPriceStrip timeState={timeState} />
          <div className="top-actions">
            <HotConnectionStatus timeState={timeState} businessWsStatus={businessWsStatus} accounts={accounts} privateStatuses={privateStatuses} expectedPublicStreams={expectedPublicStreamCount(streamWatchlist.length)} />
            <button className="account-button" onClick={() => setAccountManagerOpen(true)}>
              {account ? account.name : t("common:unconfiguredAccount")}
              <span>{account ? t(account.environment === "live" ? "common:live" : "common:demo") : t("common:readOnlyMarket")}</span>
              <ChevronDown size={14} />
            </button>
            <button
              className={clsx("icon-button", historyStatusWarn && "warn", historyStatusRunning && "active")}
              disabled={!account || !account.permissions.read}
              onClick={() => account && triggerPrivateHistorySync(account, "manual")}
              onContextMenu={(event) => {
                event.preventDefault();
                if (account) triggerPrivateHistorySync(account, "deep");
              }}
              title={!account
                ? uiText("请先配置账号", "Configure an account first")
                : account.permissions.read
                  ? `${historyStatusTitle ?? uiText("手动同步历史交易数据", "Sync trade history manually")}\n${uiText("右键执行深度历史补数", "Right-click to run a deep history backfill")}`
                  : uiText("当前账号没有读取权限", "The current account does not have read permission")}
            >
              <History size={17} />
            </button>
            <button
              className={clsx("icon-button notification-button", notificationCenterOpen && "active")}
              onClick={() => setNotificationCenterOpen((open) => !open)}
              title={uiText("通知中心", "Notification center")}
            >
              <Bell size={17} />
              {notificationHistory.length > 0 && <span>{notificationHistory.length > 99 ? "99+" : notificationHistory.length}</span>}
            </button>
            <button
              className={clsx("icon-button", mainSection === "config" && "active")}
              onClick={() => setMainSection("config")}
              title={t("common:settings")}
            >
              <Settings size={17} />
            </button>
            <button
              className={clsx("icon-button help-center-button", helpCenterOpen && "active")}
              onClick={() => {
                setNotificationCenterOpen(false);
                setHelpCenterOpen(true);
              }}
              title={uiText("帮助中心", "Help center")}
              aria-label={uiText("打开帮助中心", "Open help center")}
              aria-expanded={helpCenterOpen}
            >
              <CircleHelp size={17} />
              {firstLaunchOnboarding.canReopen && <span aria-hidden="true" />}
            </button>
            <div className="window-controls" aria-label={uiText("窗口控制", "Window controls")}>
              <button className="window-button" title={t("chart:minimizeWindow")} onClick={() => void handleWindowAction("minimize")}>
                <Minus size={16} strokeWidth={1.8} />
              </button>
              <button className="window-button" title={isMaximized ? t("common:restore") : uiText("最大化", "Maximize")} onClick={() => void handleWindowAction("maximize")}>
                <Maximize2 size={15} />
              </button>
              <button className="window-button close" title={t("common:close")} onClick={() => void handleWindowAction("close")}>
                <X size={16} />
              </button>
            </div>
          </div>
        </header>

        {mainSection === "opportunities" ? (
          <div className="opportunity-workspace">
            <Suspense fallback={<div className="automation-page-loading"><Loader2 className="spin" size={20} /><span>{uiText("正在加载交易机会工作台", "Loading Opportunities workspace")}</span></div>}>
              <TradeOpportunitiesWorkspacePage
                opportunities={tradeOpportunities}
                marketAssets={marketAssets}
                status={tradeOpportunityStatus}
                selectedId={selectedOpportunityId}
                onSelect={setSelectedOpportunityId}
                onRefresh={() => void refreshTradeOpportunities()}
                onApprove={(id) => void approveOpportunity(id)}
                onReject={(id) => void rejectOpportunity(id)}
                onDelete={(id) => void deleteOpportunity(id)}
                onClearAll={() => void clearOpportunities()}
              />
            </Suspense>
          </div>
        ) : mainSection === "automation" ? (
          <div className="automation-workspace">
            <Suspense fallback={<div className="automation-page-loading"><Loader2 className="spin" size={20} /><span>{t("automation:loadingWorkspace")}</span></div>}>
              <AiAutomationPanel
                accounts={accounts}
                marketAssets={marketAssets}
                watchlist={watchlist}
                initialTab={automationInitialTab}
                focusId={automationFocusId}
                onNotify={pushNotification}
                onboardingActive={firstLaunchOnboarding.open && firstLaunchOnboarding.step === "profile"}
                onProfileSaved={() => firstLaunchOnboarding.completeStep("profile")}
              />
            </Suspense>
          </div>
        ) : mainSection === "intelligence" ? (
          <div className="intelligence-workspace">
            <Suspense fallback={<div className="automation-page-loading"><Loader2 className="spin" size={20} /><span>{uiText("正在加载市场情报工作台", "Loading Market Intelligence workspace")}</span></div>}>
              <IntelligenceWorkspacePage
                accounts={accounts}
                marketAssets={marketAssets}
                selectedAccountId={account?.id ?? null}
                selectedSymbol={symbol}
                relatedSymbols={Array.from(new Set([symbol, ...watchlist, ...(visiblePrivateSnapshot?.positions ?? []).map((position) => position.instId)]))}
                onNewsUnreadCountChange={setNewsUnreadCount}
              />
            </Suspense>
          </div>
        ) : mainSection === "systematic" ? (
          <div className="systematic-research-workspace">
            <Suspense fallback={<div className="automation-page-loading"><Loader2 className="spin" size={20} /><span>{uiText("正在加载系统化研究工作台", "Loading Systematic Research workspace")}</span></div>}>
              <SystematicResearchWorkspacePage selectedSymbol={symbol} watchlist={watchlist} marketAssets={marketAssets} accounts={accounts.map((item) => ({ id: item.id, name: item.name, environment: item.environment }))} onNotify={pushNotification} onReady={handleSystematicReady} openAiStrategyRequest={pendingAiStrategyOpen} />
            </Suspense>
            {systematicLoading ? (
              <div className="systematic-research-loading" role="status" aria-live="polite">
                <div className="systematic-research-loading__dialog">
                  <Loader2 size={18} className="spin" />
                  <div>
                    <strong>{uiText("正在加载策略研究", "Loading Strategy Research")}</strong>
                    <span>{uiText("正在准备策略、回测和本地研究数据", "Preparing strategies, backtests, and local research data")}</span>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        ) : mainSection === "data" ? (
          <DataDashboardPage
            account={account ?? null}
            accounts={accounts}
            marketAssets={marketAssets}
            watchlist={watchlist}
            symbol={symbol}
            refreshRevision={`${privateHistoryVersion}:${visiblePrivateSnapshot?.syncedAt ?? 0}`}
            onOpenAccountSettings={() => {
              setSettingsActiveTab("account");
              setMainSection("config");
            }}
            onSyncHistory={() => account && triggerPrivateHistorySync(account, "manual")}
          />
        ) : mainSection === "config" ? (
          <SettingsWorkspacePage
            activeTab={settingsActiveTab}
            accounts={accounts}
            selectedAccountId={account?.id ?? null}
            watchlist={watchlist}
            marketAssets={marketAssets}
            symbolSyncStatus={symbolSyncStatus}
            onTabChange={setSettingsActiveTab}
            onSelectAccount={requestAccountSelection}
            onAccountsChange={(nextAccounts) => {
              setAccounts(nextAccounts);
              setSelectedAccountId((current) => (nextAccounts.some((item) => item.id === current) ? current : nextAccounts[0]?.id ?? null));
            }}
            onHistorySync={handleAccountSaved}
            onProxySaved={(summary) => {
              setProxyRevision((revision) => revision + 1);
              pushNotification({
                kind: "success",
                title: uiText("代理配置已生效", "Proxy configuration applied"),
                message: chineseUi
                  ? `${summary.enabled ? summary.url ?? `${summary.proxyType} ${summary.host}:${summary.port}` : "已关闭代理"}，正在重连行情并同步 OKX 时间。`
                  : `${summary.enabled ? summary.url ?? `${summary.proxyType} ${summary.host}:${summary.port}` : "Proxy disabled"}. Reconnecting market streams and synchronizing OKX time.`
              });
            }}
            onNotify={pushNotification}
            onAccountValidated={() => firstLaunchOnboarding.completeStep("account")}
            onAiValidated={() => firstLaunchOnboarding.completeStep("ai")}
          />
        ) : (
        <div className={clsx("content-grid", compactTerminalLayout && "compact-layout")} ref={contentGridRef}>

          <section className="center-panel" ref={centerPanelRef}>
            <div className="chart-toolbar">
                <div className="periods">
                  {PRIMARY_CHART_TIMEFRAMES.map((period) => (
                    <button
                      className={period === bar ? "active" : ""}
                      onClick={() => setBar(period)}
                      key={period}
                    >
                      {period}
                    </button>
                  ))}
                  {SECONDARY_CHART_TIMEFRAMES.includes(
                    bar as (typeof SECONDARY_CHART_TIMEFRAMES)[number],
                  ) ? (
                    <button
                      className="active"
                      onClick={() => setChartUtilitiesOpen(true)}
                    >
                      {bar}
                    </button>
                  ) : null}
                  <div className="chart-utilities" ref={chartUtilitiesRef}>
                    <button
                      type="button"
                      className={chartUtilitiesOpen ? "active" : ""}
                      onClick={() => setChartUtilitiesOpen((open) => !open)}
                      aria-expanded={chartUtilitiesOpen}
                      title={uiText(
                        "更多周期与视图工具",
                        "More intervals and chart tools",
                      )}
                    >
                      <SlidersHorizontal size={15} />
                      <span>{uiText("更多", "More")}</span>
                    </button>
                    {chartUtilitiesOpen ? (
                      <div
                        className="chart-timeframe-menu"
                        role="menu"
                        aria-label={uiText("更多周期", "More intervals")}
                      >
                        {SECONDARY_CHART_TIMEFRAMES.map((period) => (
                          <button
                            key={period}
                            type="button"
                            className={period === bar ? "active" : ""}
                            role="menuitem"
                            onClick={() => {
                              setBar(period);
                              setChartUtilitiesOpen(false);
                            }}
                          >
                            {period}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="chart-actions">
                  <button
                    onClick={openDetachedChart}
                    title={t("chart:detachedChartWindow")}
                  >
                    <Maximize2 size={15} /> {t("chart:popout")}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setChartPresentation((current) =>
                        current === "chart" ? "table" : "chart",
                      )
                    }
                    aria-pressed={chartPresentation === "table"}
                    title={
                      chartPresentation === "chart"
                        ? uiText(
                            "切换为 K 线、指标与交易标签数据表",
                            "Switch to the candle, indicator, and trade-label data table",
                          )
                        : uiText("返回 K 线图表", "Return to the chart")
                    }
                  >
                    <TableProperties size={15} />{" "}
                    {chartPresentation === "chart"
                      ? t("chart:tableView")
                      : t("chart:chart")}
                  </button>
                </div>
              </div>
              <div className="chart-stage">
                <div
                  className={clsx(
                    "chart-kline-presentation",
                    chartPresentation !== "chart" && "is-hidden",
                  )}
                  aria-hidden={chartPresentation !== "chart"}
                >
                  <ErrorBoundary label={t("chart:chart")}>
                    <HotKlineChart
                      tradeSources={chartTradeSources}
                      symbol={symbol}
                      timeframe={bar}
                      orderLines={chartOrderLines}
                      fills={chartFillMarkers}
                      positions={visiblePrivateSnapshot?.positions ?? []}
                      algoOrders={algoOrders}
                      instrument={currentInstrument}
                      onOrderLineEdit={(edit) =>
                        setPendingOrderLineEdit({
                          ...edit,
                          price: Number(
                            normalizeChartEditPrice(edit.price) || edit.price,
                          ),
                          triggerPrice:
                            edit.triggerPrice === undefined
                              ? undefined
                              : Number(
                                  normalizeChartEditPrice(edit.triggerPrice) ||
                                    edit.triggerPrice,
                                ),
                          orderPrice:
                            edit.orderPrice === undefined ||
                            edit.orderPrice === null
                              ? edit.orderPrice
                              : Number(
                                  normalizeChartEditPrice(edit.orderPrice) ||
                                    edit.orderPrice,
                                ),
                        })
                      }
                      onOrderLineCancel={requestOrderLineCancel}
                      onPositionLineTradeIntent={(intent) =>
                        setPendingPositionLineIntent({
                          ...intent,
                          targetPrice: Number(
                            normalizeChartEditPrice(intent.targetPrice) ||
                              intent.targetPrice,
                          ),
                        })
                      }
                      onPositionLineCloseRequest={(intent) =>
                        setPendingPositionLineIntent({
                          ...intent,
                          kind: "limit_close",
                          targetPrice: Number(
                            normalizeChartEditPrice(intent.currentPrice) ||
                              intent.currentPrice,
                          ),
                          currentPrice: Number(
                            normalizeChartEditPrice(intent.currentPrice) ||
                              intent.currentPrice,
                          ),
                        })
                      }
                      onChartContextTrade={(intent) =>
                        setChartQuickTrade({
                          ...intent,
                          price: Number(
                            normalizeChartEditPrice(intent.price) ||
                              intent.price,
                          ),
                        })
                      }
                      onRiskRewardTradeIntent={(intent) =>
                        setPendingChartRiskRewardIntent({
                          ...intent,
                          entryPrice: Number(
                            normalizeChartEditPrice(intent.entryPrice) ||
                              intent.entryPrice,
                          ),
                          takeProfitPrice: Number(
                            normalizeChartEditPrice(intent.takeProfitPrice) ||
                              intent.takeProfitPrice,
                          ),
                          stopLossPrice: Number(
                            normalizeChartEditPrice(intent.stopLossPrice) ||
                              intent.stopLossPrice,
                          ),
                        })
                      }
                      onNeedMoreHistory={loadMoreHistory}
                      onPriceAlert={({
                        price,
                        direction,
                        last,
                        source,
                        name,
                      }) =>
                        pushNotification({
                          kind: "warning",
                          title:
                            source === "script"
                              ? uiText("脚本提醒触发", "Script alert triggered")
                              : uiText("价格提醒触发", "Price alert triggered"),
                          message: chineseUi
                            ? `${name ? `${name}：` : ""}${symbol} 已${direction === "above" ? "上破" : direction === "below" ? "下破" : "穿越"} ${fmtPrice(price)}，最新价 ${fmtPrice(last)}。`
                            : `${name ? `${name}: ` : ""}${symbol} ${direction === "above" ? "crossed above" : direction === "below" ? "crossed below" : "crossed"} ${fmtPrice(price)}. Last price ${fmtPrice(last)}.`,
                        })
                      }
                      onCreateChartAlert={({ id, definition }) => {
                        void saveChartAlert({
                          id,
                          workspaceId: "main-chart",
                          status: "active",
                          definition,
                        }).catch((error) => {
                          logger.warn("failed to persist chart alert", {
                            error:
                              error instanceof Error
                                ? error.message
                                : String(error),
                            symbol,
                          });
                          pushNotification({
                            kind: "warning",
                            title: uiText(
                              "提醒仅当前会话有效",
                              "Alert is available only in this session",
                            ),
                            message: uiText(
                              "该提醒未能保存到提醒中心。",
                              "The alert could not be saved to Alert center.",
                            ),
                          });
                        });
                      }}
                      onDeletePriceAlert={({ id }) => {
                        void deleteChartAlert("main-chart", id).catch(
                          () => undefined,
                        );
                      }}
                    />
                  </ErrorBoundary>
                  {symbolSyncStatus[symbol] &&
                    symbolSyncStatus[symbol] !== "已同步" && (
                      <div className="kline-sync-badge">
                        {symbolSyncStatus[symbol]}
                      </div>
                    )}
                  {marketCandleLoadError?.symbol === symbol &&
                    marketCandleLoadError.bar === bar && (
                      <div
                        className="chart-candle-load-error"
                        role="alert"
                        title={marketCandleLoadError.message}
                      >
                        <strong>{t("chart:candleDataUnavailable")}</strong>
                        <span>{t("chart:candleDataUnavailableHint")}</span>
                        <button type="button" onClick={retryMarketCandles}>
                          <RefreshCw size={13} />
                          {t("common:retry")}
                        </button>
                      </div>
                    )}
                  {historyLoading && (
                    <div className="kline-history-badge">
                      {t("chart:loadingEarlier")}
                    </div>
                  )}
                  <div
                    className="chart-resize-handle chart-resize-handle-right"
                    role="separator"
                    aria-label={uiText("调整 K 线图宽度", "Resize chart width")}
                    aria-orientation="vertical"
                    tabIndex={0}
                    title={uiText(
                      "拖拽调整 K 线图宽度，双击恢复默认",
                      "Drag to resize chart width; double-click to restore the default",
                    )}
                    onPointerDown={(event) => startChartResize("width", event)}
                    onPointerMove={moveChartResize}
                    onPointerUp={finishChartResize}
                    onPointerCancel={finishChartResize}
                    onDoubleClick={() => resetChartResize("width")}
                    onKeyDown={(event) => {
                      if (
                        event.key !== "ArrowLeft" &&
                        event.key !== "ArrowRight"
                      )
                        return;
                      event.preventDefault();
                      nudgeChartResize(
                        "width",
                        event.key === "ArrowRight" ? 12 : -12,
                      );
                    }}
                  />
                  <div
                    className="chart-resize-handle chart-resize-handle-bottom"
                    role="separator"
                    aria-label={uiText(
                      "调整 K 线图高度",
                      "Resize chart height",
                    )}
                    aria-orientation="horizontal"
                    tabIndex={0}
                    title={uiText(
                      "拖拽调整 K 线图高度，双击恢复默认",
                      "Drag to resize chart height; double-click to restore the default",
                    )}
                    onPointerDown={(event) => startChartResize("height", event)}
                    onPointerMove={moveChartResize}
                    onPointerUp={finishChartResize}
                    onPointerCancel={finishChartResize}
                    onDoubleClick={() => resetChartResize("height")}
                    onKeyDown={(event) => {
                      if (event.key !== "ArrowUp" && event.key !== "ArrowDown")
                        return;
                      event.preventDefault();
                      nudgeChartResize(
                        "height",
                        event.key === "ArrowDown" ? 12 : -12,
                      );
                    }}
                  />
                </div>
                {chartPresentation === "table" && (
                  <HotChartDataTable
                    symbol={symbol}
                    timeframe={bar}
                    orderLines={chartOrderLines}
                    fills={chartFillMarkers}
                    opportunities={chartTradeOpportunities}
                  />
                )}
              </div>
              <HotBottomPanel
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                flattenPositionsTargetRef={flattenPositionsTargetRef}
                cancelOrdersTargetRef={cancelOrdersTargetRef}
                account={account}
                snapshot={visiblePrivateSnapshot}
                episodes={positionEpisodes}
                episodesStatus={episodesStatus}
                historicalOrders={historicalOrders}
                historicalOrdersStatus={historicalOrdersStatus}
                historicalFills={historicalFills}
                historicalFillsStatus={historicalFillsStatus}
                algoOrders={algoOrders}
                algoOrdersPendingReadComplete={algoOrdersPendingReadComplete}
                algoOrdersStatus={algoOrdersStatus}
                accountBills={accountBills}
                accountBillsStatus={accountBillsStatus}
                tradeAuditEvents={tradeAuditEvents}
                tradeAuditStatus={tradeAuditStatus}
                accountBillsArchiveStatus={accountBillsArchiveStatus}
                accountBillsArchiveBusy={accountBillsArchiveBusy}
                accountBillsArchiveImporting={accountBillsArchiveImporting}
                assetMap={assetMap}
                marketAssets={marketAssets}
                onAccountBillsArchive={requestAccountBillsArchive}
                onImportAccountBillsArchive={importPreviousAccountBillsArchive}
                privateStatus={privateStatus}
                tradeEnvironment={effectiveTradeEnvironment}
                onNotify={pushNotification}
                onRefreshAccount={refreshPrivateSnapshot}
                onRefreshAlgoOrders={() =>
                  setAlgoOrdersVersion((version) => version + 1)
                }
                onRemoveAlgoOrder={removeAlgoOrderLocally}
                onDismissPendingOrder={dismissPendingOrderLocally}
                onAmendPendingOrder={requestPendingOrderAmend}
                onSelectInstrument={setSymbol}
              />
            </section>

            <aside className="market-depth">
              <div className="depth-header">
                <strong>{t("trading:orderBook")}</strong>
                <button
                  type="button"
                  className="depth-expand"
                  onClick={() => setDepthModalOpen(true)}
                  title={uiText("展开完整盘口", "Open the full order book")}
                  aria-label={uiText(
                    "展开完整盘口",
                    "Open the full order book",
                  )}
                >
                  <Maximize2 size={14} />
                </button>
              </div>
              <HotMarketDepth
                onPriceSelect={(price) =>
                  setTicketPriceFill({ symbol, price, nonce: Date.now() })
                }
              />
            </aside>

          <aside className="ticket">
            <HotOrderTicket
              account={account}
              symbol={symbol}
              flattenPositionsTargetRef={flattenPositionsTargetRef}
              cancelOrdersTargetRef={cancelOrdersTargetRef}
              instrument={currentInstrument}
              wsStatus={wsStatus}
              snapshot={visiblePrivateSnapshot}
              privateStatus={privateStatus}
              timeState={timeState}
              privateEventTime={privateEventTime}
              expectedPublicStreams={expectedPublicStreamCount(streamWatchlist.length)}
              tradeEnvironment={effectiveTradeEnvironment}
              priceFill={ticketPriceFill}
              onNotify={pushNotification}
              onRefreshAccount={refreshPrivateSnapshot}
              onRefreshOrders={() => {
                setAlgoOrdersVersion((version) => version + 1);
                setPrivateHistoryVersion((version) => version + 1);
              }}
              onOpenAccountManager={() => setAccountManagerOpen(true)}
              onChartTradeConfigChange={handleChartTradeConfigChange}
            />
          </aside>
        </div>
        )}
      </section>
      {firstLaunchOnboarding.open && firstLaunchOnboarding.step && (
        <FirstLaunchOnboarding
          step={firstLaunchOnboarding.step}
          accountEnvironment={effectiveTradeEnvironment}
          onExit={firstLaunchOnboarding.dismiss}
          onReturnToStep={firstLaunchOnboarding.returnToStep}
          onComplete={() => firstLaunchOnboarding.completeStep("trade")}
        />
      )}
      <NotificationStack
        notifications={notifications}
        onDismiss={(id) => setNotifications((items) => items.filter((item) => item.id !== id))}
        onAction={openNotificationTarget}
      />
      {notificationCenterOpen && (
        <NotificationCenter
          notifications={notificationHistory}
          onClose={() => setNotificationCenterOpen(false)}
          onClear={clearNotificationHistory}
          onAction={openNotificationTarget}
        />
      )}
      {helpCenterOpen && (
        <ModalShell
          title={uiText("帮助中心", "Help center")}
          description={uiText("查找操作说明、错误原因和安全的处理路径。", "Find operating guidance, error explanations, and safe recovery steps.")}
          className="help-center-modal"
          initialFocusRef={helpSearchRef}
          onClose={() => setHelpCenterOpen(false)}
        >
          <HelpCenter
            searchInputRef={helpSearchRef}
            canReopenOnboarding={firstLaunchOnboarding.canReopen}
            onNavigate={openHelpTarget}
          />
        </ModalShell>
      )}
      {accountManagerOpen && (
        <AccountManagerModal
          accounts={accounts}
          selectedAccountId={account?.id ?? null}
          onSelect={requestAccountSelection}
          onClose={() => setAccountManagerOpen(false)}
          onAccountsChange={(nextAccounts) => {
            setAccounts(nextAccounts);
            setSelectedAccountId((current) => (nextAccounts.some((item) => item.id === current) ? current : nextAccounts[0]?.id ?? null));
          }}
          onNotify={pushNotification}
          onHistorySync={handleAccountSaved}
        />
      )}
      {depthModalOpen && <HotDepthModal symbol={symbol} onClose={() => setDepthModalOpen(false)} />}
      {liveConfirmOpen && (
        <ConfirmDialog
          title={uiText("切换到实盘", "Switch to live trading")}
          message={uiText(
            `实盘模式会连接真实 OKX 账户。后续每次实盘下单仍会二次确认，但行情延迟、网络异常、输入错误和高杠杆都可能造成真实资金损失。确认后将记住 ${pendingLiveAccount?.name ?? "目标账号"} 的实盘风险确认。`,
            `Live mode connects to a real OKX account. Every live order still requires confirmation, but market latency, network errors, invalid input, and high leverage can cause real financial loss. This acknowledges live-trading risk for ${pendingLiveAccount?.name ?? "the target account"}.`
          )}
          confirmText={uiText("已理解风险，进入实盘", "I understand the risk; enter live mode")}
          danger
          onCancel={() => {
            const fallbackAccount = pendingLivePreviousAccountScopeKey
              ? accounts.find((item) => accountEnvironmentScopeKey(item) === pendingLivePreviousAccountScopeKey)
              : undefined;
            const pendingScopeKey = pendingLiveAccountScope
              ? accountEnvironmentScopeKey(pendingLiveAccountScope)
              : null;
            const selectedScopeKey = accountsRef.current
              .find((item) => item.id === selectedAccountIdRef.current);
            if (selectedScopeKey && accountEnvironmentScopeKey(selectedScopeKey) === pendingScopeKey) {
              setSelectedAccountId(fallbackAccount?.id ?? null);
            }
            approvedAccountScopeKeyRef.current = fallbackAccount
              ? accountEnvironmentScopeKey(fallbackAccount)
              : null;
            setPendingLivePreviousAccountScopeKey(null);
            setPendingLiveAccountScope(null);
            setLiveConfirmOpen(false);
          }}
          onConfirm={() => {
            if (pendingLiveAccount?.environment === "live") {
              const scopeKey = accountEnvironmentScopeKey(pendingLiveAccount);
              setLiveRiskAcknowledged((items) => persistLiveRiskAcknowledgements({ ...items, [scopeKey]: Date.now() }));
              approvedAccountScopeKeyRef.current = scopeKey;
              setSelectedAccountId(pendingLiveAccount.id);
            } else {
              approvedAccountScopeKeyRef.current = null;
              setSelectedAccountId(null);
            }
            setPendingLivePreviousAccountScopeKey(null);
            setPendingLiveAccountScope(null);
            setLiveConfirmOpen(false);
            if (pendingLiveAccount) {
              pushNotification({
                kind: "warning",
                title: uiText("已进入实盘模式", "Live trading mode enabled"),
                message: uiText(`${pendingLiveAccount.name} 当前为实盘操作模式。下单仍需要二次确认。`, `${pendingLiveAccount.name} is now in live mode. Orders still require confirmation.`)
              });
            }
          }}
        />
      )}
      {pendingOrderLineEdit && (
        <SharedChartOrderLineEditDialog
          edit={pendingOrderLineEdit}
          environment={effectiveTradeEnvironment}
          position={findChartOrderLinePosition(
            visiblePrivateSnapshot?.positions ?? [],
            pendingOrderLineEdit.line.instId || symbol,
            pendingOrderLineEdit.line.side,
            pendingOrderLineEdit.line.posSide
          )}
          instrument={assetMap.get(pendingOrderLineEdit.line.instId || symbol)}
          onClose={() => setPendingOrderLineEdit(null)}
          onSubmit={(edit, confirmedLive) => {
            setPendingOrderLineEdit(null);
            submitOrderLineEdit(edit, confirmedLive);
          }}
        />
      )}
      {pendingOrderLineCancel && (
        <ConfirmDialog
          title={isChartAlgoOrderLine(pendingOrderLineCancel) ? uiText("确认撤销策略委托", "Cancel strategy order?") : uiText("确认撤销委托", "Cancel order?")}
          message={uiText(
            `${symbol} ${pendingOrderLineCancel.label}，价格 ${fmtPrice(pendingOrderLineCancel.price)}。确认后会从 OKX ${effectiveTradeEnvironment === "live" ? "实盘" : "模拟盘"}账户撤销，操作无法撤回。`,
            `${symbol} ${pendingOrderLineCancel.label}, price ${fmtPrice(pendingOrderLineCancel.price)}. This will cancel it from the OKX ${effectiveTradeEnvironment === "live" ? "live" : "demo"} account and cannot be undone.`
          )}
          confirmText={t("trading:confirmCancellation")}
          danger
          onCancel={() => setPendingOrderLineCancel(null)}
          onConfirm={() => {
            const line = pendingOrderLineCancel;
            setPendingOrderLineCancel(null);
            submitOrderLineCancel(line);
          }}
        />
      )}
      {pendingPositionLineIntent && (
        <SharedPositionLineTradeDialog
          account={account}
          intent={pendingPositionLineIntent}
          position={privateSnapshot?.positions.find((item) => item.instId === pendingPositionLineIntent.instId && normalizeUiPosSide(item.posSide) === pendingPositionLineIntent.posSide)}
          instrument={assetMap.get(pendingPositionLineIntent.instId)}
          environment={effectiveTradeEnvironment}
          onClose={() => setPendingPositionLineIntent(null)}
          onSubmit={(intent, size, orderPx, confirmedLive) => {
            setPendingPositionLineIntent(null);
            submitPositionLineIntent(intent, size, orderPx, confirmedLive);
          }}
        />
      )}
      {chartQuickTrade && (
        <ChartQuickTradeDialog
          draft={chartQuickTrade}
          accountId={account?.id}
          environment={effectiveTradeEnvironment}
          instrument={currentInstrument}
          accountSnapshot={privateSnapshot}
          accountTradeConfig={chartQuickTradeAccountConfig}
          onClose={() => setChartQuickTrade(null)}
          onSubmitted={() => {
            setChartQuickTrade(null);
            const orderType = t(chartQuickTrade.orderType === "market" ? "trading:market" : "trading:limit");
            const action = t(chartQuickTrade.action === "long"
              ? "trading:long"
              : chartQuickTrade.action === "short"
                ? "trading:short"
                : chartQuickTrade.action === "close-long"
                  ? "trading:closeLong"
                  : "trading:closeShort");
            pushNotification({
              kind: "trade",
              title: uiText("图表委托已提交", "Chart order submitted"),
              message: uiText(`${chartQuickTrade.symbol} ${orderType}${action}已提交。`, `${chartQuickTrade.symbol} ${orderType} ${action} submitted.`)
            });
            void refreshPrivateSnapshot();
          }}
        />
      )}
      {pendingChartRiskRewardIntent && (
        <SharedChartRiskRewardTradeDialog
          accountId={account?.id}
          intent={pendingChartRiskRewardIntent}
          snapshot={privateSnapshot}
          instrument={assetMap.get(pendingChartRiskRewardIntent.instId)}
          environment={effectiveTradeEnvironment}
          onClose={() => setPendingChartRiskRewardIntent(null)}
          onSubmit={async (intent, size, marginMode, lever, confirmedLive) => {
            if (!account) throw new Error(uiText("请先配置交易账号。", "Configure a trading account first."));
            await submitRiskRewardChartAction({ accountId: account.id, environment: effectiveTradeEnvironment, getInstrument: (instId) => assetMap.get(instId) }, intent, size, marginMode, lever, confirmedLive);
            setPendingChartRiskRewardIntent(null);
            void refreshPrivateSnapshot();
          }}
        />
      )}
      <MemoAiDock accountId={account?.id} onOpenSettings={openAiSettings} onOpenStrategy={openAiStrategy} />
    </main>
  );
}

function StartupOrbitalCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const activeCanvas = canvas;
    const activeCtx = ctx;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const nodes = Array.from({ length: 48 }, (_, i) => ({
      angle: (Math.PI * 2 * i) / 48,
      lane: i % 5,
      size: 1.6 + Math.random() * 2.4,
      speed: 0.002 + Math.random() * 0.003,
      phase: Math.random() * Math.PI * 2
    }));

    function resizeCanvas() {
      const rect = activeCanvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      activeCanvas.width = Math.floor(rect.width * dpr);
      activeCanvas.height = Math.floor(rect.height * dpr);
      activeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    let raf = 0;
    let visible = document.visibilityState === "visible";
    function draw(t: number) {
      if (!visible) return;
      const w = activeCanvas.clientWidth;
      const h = activeCanvas.clientHeight;
      const cx = w * 0.5;
      const cy = h * 0.46;
      const time = t * 0.001;
      activeCtx.clearRect(0, 0, w, h);
      activeCtx.save();
      activeCtx.translate(cx, cy);

      const glow = activeCtx.createRadialGradient(0, 0, 0, 0, 0, 270);
      glow.addColorStop(0, "rgba(183,146,255,.28)");
      glow.addColorStop(0.46, "rgba(84,240,255,.08)");
      glow.addColorStop(1, "rgba(0,0,0,0)");
      activeCtx.fillStyle = glow;
      activeCtx.beginPath();
      activeCtx.arc(0, 0, 300, 0, Math.PI * 2);
      activeCtx.fill();

      for (let ring = 0; ring < 5; ring += 1) {
        const rx = 112 + ring * 35;
        const ry = 42 + ring * 16;
        activeCtx.save();
        activeCtx.rotate(0.58 + ring * 0.28 + Math.sin(time * 0.4) * 0.05);
        activeCtx.strokeStyle = `rgba(255,255,255,${0.15 - ring * 0.014})`;
        activeCtx.lineWidth = ring === 2 ? 1.8 : 1;
        activeCtx.setLineDash([10 + ring * 3, 12 + ring * 2]);
        activeCtx.lineDashOffset = -time * (36 + ring * 8);
        activeCtx.beginPath();
        activeCtx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
        activeCtx.stroke();
        activeCtx.restore();
      }

      activeCtx.save();
      activeCtx.rotate(time * 0.24);
      for (let i = 0; i < 9; i += 1) {
        const a = (Math.PI * 2 * i) / 9;
        const r = 88 + Math.sin(time + i) * 6;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r * 0.42;
        activeCtx.strokeStyle = i % 2 ? "rgba(84,240,255,.26)" : "rgba(183,146,255,.32)";
        activeCtx.beginPath();
        activeCtx.moveTo(0, 0);
        activeCtx.lineTo(x, y);
        activeCtx.stroke();
      }
      activeCtx.restore();

      nodes.forEach((node, i) => {
        const a = node.angle + time * (0.45 + node.speed * 80);
        const radius = 126 + node.lane * 38 + Math.sin(time * 1.6 + node.phase) * 10;
        const z = (Math.sin(a + time * 0.8) + 1) / 2;
        const x = Math.cos(a) * radius;
        const y = Math.sin(a) * radius * (0.42 + z * 0.18);
        const alpha = 0.24 + z * 0.72;
        activeCtx.fillStyle = i % 4 === 0 ? `rgba(84,240,255,${alpha})` : `rgba(183,146,255,${alpha})`;
        activeCtx.shadowBlur = 12;
        activeCtx.shadowColor = i % 4 === 0 ? "#54f0ff" : "#b792ff";
        activeCtx.beginPath();
        activeCtx.arc(x, y, node.size + z * 2.4, 0, Math.PI * 2);
        activeCtx.fill();
      });

      activeCtx.shadowBlur = 36;
      activeCtx.shadowColor = "#b792ff";
      const core = activeCtx.createLinearGradient(-60, -60, 80, 80);
      core.addColorStop(0, "rgba(255,255,255,.95)");
      core.addColorStop(0.42, "rgba(183,146,255,.92)");
      core.addColorStop(1, "rgba(84,240,255,.7)");
      activeCtx.fillStyle = core;
      activeCtx.beginPath();
      const sides = 6;
      for (let i = 0; i < sides; i += 1) {
        const a = time * 0.55 + Math.PI / 6 + (Math.PI * 2 * i) / sides;
        const r = i % 2 ? 72 : 88;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        if (i === 0) activeCtx.moveTo(x, y);
        else activeCtx.lineTo(x, y);
      }
      activeCtx.closePath();
      activeCtx.fill();

      activeCtx.shadowBlur = 0;
      activeCtx.fillStyle = "rgba(0,0,0,.52)";
      activeCtx.font = "700 24px Inter, system-ui, sans-serif";
      activeCtx.textAlign = "center";
      activeCtx.textBaseline = "middle";
      activeCtx.fillText("DT", 0, 2);
      activeCtx.restore();
      if (!prefersReducedMotion.matches) {
        raf = window.requestAnimationFrame(draw);
      }
    }

    resizeCanvas();
    const onVisibilityChange = () => {
      visible = document.visibilityState === "visible";
      if (visible && !prefersReducedMotion.matches) raf = window.requestAnimationFrame(draw);
    };
    window.addEventListener("resize", resizeCanvas);
    document.addEventListener("visibilitychange", onVisibilityChange);
    raf = window.requestAnimationFrame(draw);
    return () => {
      window.removeEventListener("resize", resizeCanvas);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.cancelAnimationFrame(raf);
    };
  }, []);

  return <canvas id="orbital-canvas" ref={canvasRef} width={900} height={700} />;
}

type AppNotification = {
  id: string;
  kind: "success" | "info" | "warning" | "error" | "trade";
  title: string;
  message: string;
  createdAt: number;
  action?: "trade-opportunities" | "ai-automation" | "settings";
  automationTab?: AiAutomationTab;
  settingsTab?: SettingsTab;
  targetId?: string;
};

function isChineseLanguage() {
  return resolvedLocale().toLowerCase().startsWith("zh");
}

function localizeAutomationEventMessage(event: AiAutomationEvent, t: UiTranslation) {
  const message = String(event.message || "");
  if (event.type === "accountPositionModeSwitchFailed") {
    return t("automation:accountPositionModeSwitchFailedMessage", {
      account: event.profileName || event.accountId || "OKX account",
      error: event.error || message,
    });
  }
  if (event.type === "accountPositionModeRequired") {
    return t("automation:accountPositionModeRequiredMessage", {
      account: event.profileName || event.accountId || "OKX account",
      error: event.error || message,
    });
  }
  if (event.type === "systematicProfileAutoStopped") {
    return t("automation:systematicProfileAutoStoppedMessage", {
      profile: event.profileName || event.profileId || "Profile",
      count: event.consecutiveErrors || 3,
      error: event.error || message,
    });
  }
  if (event.type === "systematicProfileProtectionWarning") {
    return isChineseLanguage()
      ? `${event.profileName || event.profileId || "Profile"} 的保护单尚未确认：${event.error || message}`
      : `${event.profileName || event.profileId || "Profile"} protection is not confirmed: ${event.error || message}`;
  }
  if (event.type === "systematicProfileExecutionRecoveryFailed") {
    return isChineseLanguage()
      ? `${event.profileName || event.profileId || "Profile"} 的信号恢复失败，已标记为失败：${event.error || message}`
      : `${event.profileName || event.profileId || "Profile"} signal recovery failed and was marked failed: ${event.error || message}`;
  }
  if (event.type === "runRecordUpdated" && message === "AI 运行记录已持久化") {
    return t("automation:runRecordPersisted");
  }
  const dailyCompleted = message.match(/^(.+) 的每日市场复盘已完成$/);
  if (event.type === "runCompleted" && dailyCompleted) {
    return t("automation:dailyReviewCompletedMessage", { profile: dailyCompleted[1] });
  }
  const runCompleted = message.match(/^后台 Agent (.+) 已完成$/);
  if (event.type === "runCompleted" && runCompleted) {
    return t("automation:backgroundAgentCompletedMessage", { profile: runCompleted[1] });
  }
  const runFailed = message.match(/^后台 Agent (.+) 运行失败：(.*)$/s);
  if (event.type === "runFailed" && runFailed) {
    return t("automation:backgroundAgentFailedMessage", { profile: runFailed[1], error: runFailed[2] });
  }
  return message;
}

function localizeHistoricalTradeBase(value: string, t: UiTranslation) {
  return value
    .replace(/ 买\/多 /g, ` ${t("trading:buy")}/${t("trading:long")} `)
    .replace(/ 卖\/空 /g, ` ${t("trading:sell")}/${t("trading:short")} `)
    .replace(/ 买\/空 /g, ` ${t("trading:buy")}/${t("trading:short")} `)
    .replace(/ 卖\/多 /g, ` ${t("trading:sell")}/${t("trading:long")} `);
}

function localizeAppNotification(notification: AppNotification, t: UiTranslation) {
  const exactTitles: Record<string, string> = {
    "AI 创建了交易机会": t("automation:aiCreatedOpportunity"),
    "普通下单已提交": t("automation:ordinaryOrderSubmitted"),
    "撤单请求已提交": t("automation:cancelRequestSubmitted"),
    "杠杆设置已记录": t("automation:leverageChangeRecorded"),
    "交易风控已拦截": t("automation:tradeRiskBlocked")
  };
  let title = exactTitles[notification.title] ?? notification.title;
  let message = notification.message;
  if (message === "AI 运行记录已持久化") {
    message = t("automation:runRecordPersisted");
  } else {
    const dailyCompleted = message.match(/^(.+) 的每日市场复盘已完成$/);
    const runCompleted = message.match(/^后台 Agent (.+) 已完成$/);
    const runFailed = message.match(/^后台 Agent (.+) 运行失败：(.*)$/s);
    const opportunity = message.match(/^(.+?) (做空|做多) (.+?) 张$/);
    const audit = message.match(/^(.+)，订单 (.+)，操作员 (.+)。$/s);
    if (dailyCompleted) message = t("automation:dailyReviewCompletedMessage", { profile: dailyCompleted[1] });
    else if (runCompleted) message = t("automation:backgroundAgentCompletedMessage", { profile: runCompleted[1] });
    else if (runFailed) message = t("automation:backgroundAgentFailedMessage", { profile: runFailed[1], error: runFailed[2] });
    else if (opportunity) message = t("automation:aiCreatedOpportunityMessage", { symbol: opportunity[1], direction: opportunity[2] === "做空" ? t("trading:short") : t("trading:long"), size: opportunity[3] });
    else if (audit) message = t("automation:tradeAuditSubmittedMessage", { base: localizeHistoricalTradeBase(audit[1], t), order: audit[2], operator: audit[3] });
  }
  return { ...notification, title, message };
}

type SettingsTab = "general" | "account" | "proxy" | "ai" | "prompt" | "skills" | "notifications" | "storage";

const FEISHU_EVENT_OPTIONS = [
  ["agent_message", "Agent 主动通知"],
  ["run_completed", "后台 Run 完成"],
  ["run_failed", "后台 Run 失败"],
  ["review_completed", "交易复盘完成"],
  ["daily_review_completed", "每日复盘完成"],
  ["suggestion_created", "生成优化建议"],
  ["strategy_signal", "策略交易信号"]
] as const;

type FeishuEventType = (typeof FEISHU_EVENT_OPTIONS)[number][0];
const DEFAULT_FEISHU_EVENT_TYPES = FEISHU_EVENT_OPTIONS.map(([value]) => value);

const RAW_AI_SKILL_OPTIONS: AiSkillDefinition[] = defaultAiConfig.skillDefinitions.map((skill) => ({
  ...skill,
  content: skill.content.join("\n")
}));

const AI_SKILL_OPTIONS = normalizeAiSkillDefinitions(RAW_AI_SKILL_OPTIONS);

const PREVIEW_POSITION_EPISODE: PositionEpisode = {
  id: "preview-episode-btc-short",
  accountId: "preview-okx-demo",
  environment: "demo",
  instType: "SWAP",
  instId: "BTC-USDT-SWAP",
  episodeSide: "short",
  status: "closed",
  primaryOrigin: "ai",
  strategyId: "preview-strategy-mean-reversion-short",
  openTime: Date.UTC(2026, 6, 29, 1, 54, 39),
  closeTime: Date.UTC(2026, 6, 29, 12, 15, 26),
  openQty: "0.02",
  maxQty: "0.15",
  closedQty: "0.15",
  remainingQty: "0",
  avgOpenPx: "63976.7",
  avgClosePx: "64074.1",
  realizedPnl: "-0.14615",
  fees: "-0.06724858",
  fundingFee: "0.00080574",
  liqPenalty: "0",
  netPnl: "-0.21259284",
  lastTradeId: "preview-trade-close-0005",
  lastFillTime: Date.UTC(2026, 6, 29, 12, 15, 26),
  events: [
    {
      id: "preview-event-open",
      eventType: "OPEN",
      origin: "ai",
      strategyId: "preview-strategy-mean-reversion-short",
      ordId: "preview-order-open-0001",
      tradeId: "preview-trade-open-0001",
      side: "sell",
      posSide: "short",
      qty: "0.02",
      price: "63800",
      pnl: "0",
      fee: "-0.002552",
      feeCcy: "USDT",
      positionBefore: "0",
      positionAfter: "0.02",
      eventTime: Date.UTC(2026, 6, 29, 1, 54, 39),
      source: "preview"
    },
    {
      id: "preview-event-funding",
      eventType: "FUNDING_FEE",
      origin: "exchange",
      billId: "preview-bill-funding-0001",
      qty: "0.02",
      price: "63898.6",
      pnl: "0.00080574",
      fee: "0",
      feeCcy: "USDT",
      eventTime: Date.UTC(2026, 6, 29, 6, 0, 5),
      source: "preview"
    },
    {
      id: "preview-event-add-1",
      eventType: "ADD",
      origin: "ai",
      strategyId: "preview-strategy-mean-reversion-short",
      ordId: "preview-order-add-0002",
      tradeId: "preview-trade-add-0002",
      side: "sell",
      posSide: "short",
      qty: "0.12",
      price: "64000",
      pnl: "0",
      fee: "-0.01536",
      feeCcy: "USDT",
      positionBefore: "0.02",
      positionAfter: "0.14",
      eventTime: Date.UTC(2026, 6, 29, 8, 30, 3),
      source: "preview"
    },
    {
      id: "preview-event-add-2",
      eventType: "ADD",
      origin: "ai",
      strategyId: "preview-strategy-mean-reversion-short",
      ordId: "preview-order-add-0003",
      tradeId: "preview-trade-add-0003",
      side: "sell",
      posSide: "short",
      qty: "0.01",
      price: "64050",
      pnl: "0",
      fee: "-0.001281",
      feeCcy: "USDT",
      positionBefore: "0.14",
      positionAfter: "0.15",
      eventTime: Date.UTC(2026, 6, 29, 11, 54, 38),
      source: "preview"
    },
    {
      id: "preview-event-close",
      eventType: "CLOSE",
      origin: "ai",
      strategyId: "preview-strategy-mean-reversion-short",
      ordId: "preview-order-close-0005",
      tradeId: "preview-trade-close-0005",
      side: "buy",
      posSide: "short",
      qty: "0.15",
      price: "64074.1",
      pnl: "-0.14615",
      fee: "-0.04805558",
      feeCcy: "USDT",
      positionBefore: "0.15",
      positionAfter: "0",
      eventTime: Date.UTC(2026, 6, 29, 12, 15, 26),
      source: "preview"
    }
  ]
};

export function TerminalPreview() {
  const [assets, setAssets] = useState<MarketAssetsSummary | null>(null);
  const [episodeReviewOpen, setEpisodeReviewOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("episodeReview") === "1";
  });
  const initialPreviewAccounts = useMemo(() => {
    if (typeof window === "undefined") return EMPTY_PREVIEW_ACCOUNTS;
    const params = new URLSearchParams(window.location.search);
    if (params.get("accounts") !== "demo") return EMPTY_PREVIEW_ACCOUNTS;
    return [
      {
        id: "preview-okx-demo",
        name: "OKX 预览模拟盘",
        exchange: "okx" as const,
        environment: "demo" as const,
        apiKeyMasked: "f5d5****45f",
        permissions: { read: true, trade: true, withdraw: false }
      },
      {
        id: "preview-okx-readonly",
        name: "OKX 只读观察",
        exchange: "okx" as const,
        environment: "live" as const,
        apiKeyMasked: "read****only",
        permissions: { read: true, trade: false, withdraw: false }
      },
      {
        id: "preview-okx-research",
        name: "OKX 情报研究",
        exchange: "okx" as const,
        environment: "live" as const,
        apiKeyMasked: "research****view",
        permissions: { read: true, trade: false, withdraw: false }
      }
    ];
  }, []);
  const [previewAccounts, setPreviewAccounts] = useState<AccountSummary[]>(() => initialPreviewAccounts);
  const previewPendingOrder = useMemo(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("pendingOrder") === "1";
  }, []);
  const previewMarketConsistency = useMemo(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("marketConsistency") === "1";
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("accountEnvironmentFlip") !== "1") return;
    const flipAccountEnvironment = () => {
      setPreviewAccounts((items) => items.map((item) => item.id === "preview-okx-demo"
        ? { ...item, environment: "live" as const }
        : item));
    };
    window.addEventListener("desic:preview-account-environment-flip", flipAccountEnvironment);
    return () => window.removeEventListener("desic:preview-account-environment-flip", flipAccountEnvironment);
  }, []);
  useEffect(() => {
    let cancelled = false;
    void fetch("/cache/market-assets/swap-instruments.json")
      .then((response) => (response.ok ? response.json() : null))
      .then((value: MarketAssetsSummary | null) => {
        if (!cancelled && value?.instruments?.length) setAssets(value);
      })
      .catch((error) => logger.warn("terminal preview market assets failed", { error: String(error) }));
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <>
      <TradingTerminal
        marketAssets={assets}
        previewAccounts={previewAccounts}
        previewPendingOrder={previewPendingOrder}
        previewMarketConsistency={previewMarketConsistency}
      />
      {episodeReviewOpen && <EpisodeDetailModal episode={PREVIEW_POSITION_EPISODE} onClose={() => setEpisodeReviewOpen(false)} />}
    </>
  );
}

export function AutomationPreview() {
  return (
    <Suspense fallback={<main className="automation-preview-page"><Loader2 className="spin" size={20} /></main>}>
      <AutomationMultiAgentPreview />
    </Suspense>
  );
}

function loadNotificationHistory(): AppNotification[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(NOTIFICATION_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is AppNotification =>
        typeof item?.id === "string" &&
        typeof item?.title === "string" &&
        typeof item?.message === "string" &&
        typeof item?.createdAt === "number" &&
        ["success", "info", "warning", "error", "trade"].includes(item?.kind)
      )
      .slice(0, 200);
  } catch (error) {
    logger.warn("failed to load notification history", { error: String(error) });
    return [];
  }
}

function persistNotificationHistory(items: AppNotification[]) {
  const next = items.slice(0, 200);
  try {
    window.localStorage.setItem(NOTIFICATION_HISTORY_KEY, JSON.stringify(next));
  } catch (error) {
    logger.warn("failed to persist notification history", { error: String(error) });
  }
  return next;
}

function loadWatchlist() {
  if (typeof window === "undefined") return DEFAULT_WATCHLIST;
  try {
    const raw = window.localStorage.getItem(WATCHLIST_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) return normalizeWatchlist(parsed);
  } catch (error) {
    logger.warn("failed to load watchlist", { error: String(error) });
  }
  return DEFAULT_WATCHLIST;
}

function persistWatchlist(items: string[]) {
  const next = normalizeWatchlist(items);
  try {
    window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    logger.warn("failed to persist watchlist", { error: String(error) });
  }
  return next;
}

function loadChartWorkspaceLayout(): ChartWorkspaceLayout {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CHART_WORKSPACE_LAYOUT_KEY) || "{}") as ChartWorkspaceLayout;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveChartWorkspaceLayout(layout: ChartWorkspaceLayout) {
  if (typeof window === "undefined") return;
  try {
    if (layout.depthWidth === undefined && layout.bottomHeight === undefined) {
      window.localStorage.removeItem(CHART_WORKSPACE_LAYOUT_KEY);
    } else {
      window.localStorage.setItem(CHART_WORKSPACE_LAYOUT_KEY, JSON.stringify(layout));
    }
  } catch {
    // The current resize still applies when persistent browser storage is unavailable.
  }
}

function loadLiveRiskAcknowledgements(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LIVE_ACK_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([key, value]) => key.startsWith("live:") && typeof value === "number" && Number.isFinite(value))
    ) as Record<string, number>;
  } catch (error) {
    logger.warn("failed to load live risk acknowledgements", { error: String(error) });
    return {};
  }
}

function persistLiveRiskAcknowledgements(items: Record<string, number>) {
  try {
    window.localStorage.setItem(LIVE_ACK_STORAGE_KEY, JSON.stringify(items));
  } catch (error) {
    logger.warn("failed to persist live risk acknowledgements", { error: String(error) });
  }
  return items;
}

function normalizeWatchlist(items: string[]) {
  const normalized = items
    .map((item) => String(item || "").trim().toUpperCase())
    .filter((item) => /^[A-Z0-9]+-USDT-SWAP$/.test(item));
  const unique = Array.from(new Set(normalized));
  if (!unique.includes(DEFAULT_SYMBOL)) unique.unshift(DEFAULT_SYMBOL);
  const limited = unique.slice(0, 10);
  if (!limited.includes(DEFAULT_SYMBOL)) limited[limited.length - 1] = DEFAULT_SYMBOL;
  const next = Array.from(new Set(limited));
  return next.length ? next : [DEFAULT_SYMBOL];
}

function normalizeSwapSymbol(raw: string, assetMap: Map<string, MarketAssetsSummary["instruments"][number]>) {
  const input = raw.trim().toUpperCase();
  if (!input) return "";
  if (/^[A-Z0-9]+$/.test(input)) return `${input}-USDT-SWAP`;
  if (/^[A-Z0-9]+-USDT$/.test(input)) return `${input}-SWAP`;
  if (/^[A-Z0-9]+-USDT-SWAP$/.test(input)) return input;
  const compact = input.replace(/[^A-Z0-9]/g, "");
  const match = Array.from(assetMap.keys()).find((instId) => instId.replace(/[^A-Z0-9]/g, "") === compact);
  return match ?? "";
}

function splitWatchSymbols(raw: string) {
  return raw
    .split(/[\s,，;；、]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatNotificationTime(value: number) {
  const date = new Date(value);
  return formatLocalizedDate(date, {
    timeZone: DISPLAY_TIME_ZONE,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function NotificationStack({
  notifications,
  onDismiss,
  onAction
}: {
  notifications: AppNotification[];
  onDismiss: (id: string) => void;
  onAction?: (notification: AppNotification) => void;
}) {
  const { t } = useTranslation("common");
  if (notifications.length === 0) return null;
  const localizedNotifications = notifications.map((notification) => localizeAppNotification(notification, t));
  return (
    <div className="notification-stack" aria-live="polite">
      {localizedNotifications.map((notification) => (
        <article
          className={clsx("notification-card", notification.kind, notification.action && "clickable")}
          key={notification.id}
          onClick={() => notification.action && onAction?.(notification)}
        >
          <div className="notification-icon">
            {notification.kind === "error" || notification.kind === "warning" ? <CircleAlert size={16} /> : <CircleCheck size={16} />}
          </div>
          <div>
            <strong>{notification.title}</strong>
            <span>{notification.message}</span>
          </div>
          <button
            className="window-button"
            onClick={(event) => {
              event.stopPropagation();
              onDismiss(notification.id);
            }}
            title={t("dismissNotification")}
          >
            <X size={14} />
          </button>
        </article>
      ))}
    </div>
  );
}

function NotificationCenter({
  notifications,
  onClose,
  onClear,
  onAction
}: {
  notifications: AppNotification[];
  onClose: () => void;
  onClear: () => void;
  onAction?: (notification: AppNotification) => void;
}) {
  const { t } = useTranslation("common");
  const [filter, setFilter] = useState<AppNotification["kind"] | "all">("all");
  const [query, setQuery] = useState("");
  const localizedNotifications = useMemo(() => notifications.map((notification) => localizeAppNotification(notification, t)), [notifications, t]);
  const counts = useMemo(() => {
    const next: Record<AppNotification["kind"] | "all", number> = {
      all: notifications.length,
      trade: 0,
      error: 0,
      warning: 0,
      success: 0,
      info: 0
    };
    notifications.forEach((item) => {
      next[item.kind] += 1;
    });
    return next;
  }, [notifications]);
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return localizedNotifications.filter((item) => {
      if (filter !== "all" && item.kind !== filter) return false;
      if (!keyword) return true;
      return `${item.title} ${item.message}`.toLowerCase().includes(keyword);
    });
  }, [filter, localizedNotifications, query]);
  const filters: Array<[AppNotification["kind"] | "all", string]> = [
    ["all", t("all")],
    ["trade", t("tradeNotification")],
    ["error", t("error")],
    ["warning", t("warning")],
    ["success", t("success")],
    ["info", t("info")]
  ];
  return (
    <aside className="notification-center" aria-label={t("notificationCenter")}>
      <div className="notification-center-head">
        <div>
          <strong>{t("notificationCenter")}</strong>
          <span>{t("notificationSummary", { visible: filtered.length, total: notifications.length, type: filter === "all" ? t("allTypes") : filters.find(([value]) => value === filter)?.[1] })}</span>
        </div>
        <div className="notification-center-actions">
          {query && <button onClick={() => setQuery("")}>{t("clearSearch")}</button>}
          <button onClick={onClear} disabled={notifications.length === 0}>{t("clear")}</button>
          <button className="window-button" onClick={onClose} title={t("closeNotificationCenter")}>
            <X size={15} />
          </button>
        </div>
      </div>
      <div className="notification-search">
        <Search size={14} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("searchNotificationsPlaceholder")}
          aria-label={t("searchNotifications")}
        />
      </div>
      <div className="notification-filters">
        {filters.map(([value, label]) => (
          <button
            className={filter === value ? "active" : ""}
            onClick={() => setFilter(value)}
            key={value}
            disabled={counts[value] === 0 && value !== "all"}
          >
            <span>{label}</span>
            <b>{counts[value]}</b>
          </button>
        ))}
      </div>
      <div className="notification-center-list">
        {filtered.length === 0 ? (
          <div className="notification-empty">{t("noNotifications")}</div>
        ) : (
          filtered.map((notification) => (
            <article
              className={clsx("notification-history-item", notification.kind, notification.action && "clickable")}
              key={notification.id}
              onClick={() => notification.action && onAction?.(notification)}
            >
              <div className="notification-icon">
                {notification.kind === "error" || notification.kind === "warning" ? <CircleAlert size={15} /> : <CircleCheck size={15} />}
              </div>
              <div>
                <div className="notification-history-meta">
                  <span className={clsx("notification-kind", notification.kind)}>{notification.kind === "trade" ? t("tradeNotification") : notification.kind === "error" ? t("error") : notification.kind === "warning" ? t("warning") : notification.kind === "success" ? t("success") : t("info")}</span>
                  <time>{formatNotificationTime(notification.createdAt)}</time>
                </div>
                <strong>{notification.title}</strong>
                <p>{notification.message}</p>
              </div>
            </article>
          ))
        )}
      </div>
    </aside>
  );
}

function ModalShell({
  title,
  description,
  compact,
  className,
  children,
  initialFocusRef,
  onClose
}: {
  title: string;
  description?: string;
  compact?: boolean;
  className?: string;
  children: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const { t } = useTranslation("common");
  const drag = useDraggableSurface<HTMLElement>();
  const titleId = useId();
  const descriptionId = useId();
  useModalFocus({ containerRef: drag.surfaceRef, initialFocusRef, onClose });
  return (
    <div className={clsx("modal-backdrop", compact && "compact")}>
      <section
        ref={drag.surfaceRef}
        className={clsx("modal-shell", compact && "compact", className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        <header className="modal-head" {...drag.handleProps}>
          <div>
            <strong id={titleId}>{title}</strong>
            {description && <span id={descriptionId}>{description}</span>}
          </div>
          <button type="button" className="window-button" onClick={onClose} title={t("close")} aria-label={t("close")}>
            <X size={16} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function ProxySettingsModal({
  onClose,
  onSaved,
  onNotify
}: {
  onClose: () => void;
  onSaved: (summary: ProxyConfigSummary) => void;
  onNotify: (notification: Omit<AppNotification, "id" | "createdAt">) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <ModalShell
      title={t("proxyConfiguration")}
      description={t("proxyConfigurationDescription")}
      className="proxy-modal"
      onClose={onClose}
    >
      <ProxySettingsPane onSaved={onSaved} onNotify={onNotify} />
    </ModalShell>
  );
}

function ProxySettingsPane({
  onSaved,
  onNotify
}: {
  onSaved: (summary: ProxyConfigSummary) => void;
  onNotify: (notification: Omit<AppNotification, "id" | "createdAt">) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [draft, setDraft] = useState<ProxyConfigUpdate>({
    enabled: false,
    proxyType: "NONE",
    host: "",
    port: 0,
    username: "",
    password: ""
  });
  const [status, setStatus] = useState(() => t("settings:readingProxyConfiguration"));
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadProxyConfig()
      .then((config) => {
        if (cancelled || !config) return;
        setDraft({
          enabled: config.enabled,
          proxyType: config.enabled ? config.proxyType : "NONE",
          host: config.host || "",
          port: config.port || 0,
          username: config.username || "",
          password: config.authConfigured ? "********" : ""
        });
        setStatus(config.enabled ? t("settings:currentProxy", { proxy: config.url ?? `${config.host}:${config.port}` }) : t("settings:proxyDisabled"));
      })
      .catch((error) => {
        logger.error("load proxy config failed", error);
        setStatus(t("settings:proxyConfigurationReadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const updateDraft = useCallback((patch: Partial<ProxyConfigUpdate>) => {
    setDraft((current) => {
      const next = { ...current, ...patch };
      if (patch.proxyType === "NONE") next.enabled = false;
      if (patch.proxyType && patch.proxyType !== "NONE") next.enabled = true;
      return next;
    });
    setTestResult(null);
  }, []);

  const normalizedDraft = useMemo<ProxyConfigUpdate>(() => ({
    enabled: draft.proxyType !== "NONE" && draft.enabled,
    proxyType: draft.proxyType,
    host: draft.host.trim(),
    port: Number(draft.port) || 0,
    username: draft.username?.trim() || null,
    password: draft.password || null
  }), [draft]);

  const test = useCallback(async () => {
    setBusy(true);
    setStatus(t("settings:testingProxy"));
    try {
      const result = await testProxyConfig(normalizedDraft);
      if (result) {
        setTestResult(result);
        setStatus(`${result.message} · ${result.latencyMs}ms`);
        onNotify({ kind: result.ok ? "success" : "warning", title: t(result.ok ? "settings:proxyTestPassed" : "settings:proxyTestFailed"), message: result.message });
      } else {
        setStatus(t("settings:proxyTestDesktopOnly"));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("proxy test failed", error);
      setStatus(t("settings:proxyTestFailed"));
      onNotify({ kind: "error", title: t("settings:proxyTestFailed"), message });
    } finally {
      setBusy(false);
    }
  }, [normalizedDraft, onNotify, t]);

  const save = useCallback(async () => {
    setBusy(true);
    setStatus(t("settings:savingProxyConfiguration"));
    try {
      const summary = await saveProxyConfig(normalizedDraft);
      if (!summary) {
        setStatus(t("settings:proxySaveDesktopOnly"));
        return;
      }
      setStatus(t("settings:proxyConfigurationSaved"));
      onSaved(summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("proxy save failed", error);
      setStatus(t("settings:proxyConfigurationSaveFailed"));
      onNotify({ kind: "error", title: t("settings:proxySaveFailed"), message });
    } finally {
      setBusy(false);
    }
  }, [normalizedDraft, onNotify, onSaved, t]);

  return (
    <div className="proxy-modal-body">
      <div className="proxy-type-row" role="group" aria-label={t("settings:proxyType")}>
        {["NONE", "HTTP", "HTTPS", "SOCKS5"].map((type) => (
          <button
            type="button"
            className={draft.proxyType === type ? "active" : ""}
            onClick={() => updateDraft({ proxyType: type })}
            key={type}
          >
            {type === "NONE" ? t("settings:noProxy") : type}
          </button>
        ))}
      </div>
      <div className="proxy-form-grid">
        <label>
          <span>{t("settings:address")}</span>
          <input value={draft.host} disabled={draft.proxyType === "NONE"} onChange={(event) => updateDraft({ host: event.target.value })} />
        </label>
        <label>
          <span>{t("settings:port")}</span>
          <input value={String(draft.port)} disabled={draft.proxyType === "NONE"} inputMode="numeric" onChange={(event) => updateDraft({ port: Number(event.target.value) || 0 })} />
        </label>
        <label>
          <span>{t("settings:proxyUsername")}</span>
          <input value={draft.username ?? ""} disabled={draft.proxyType === "NONE"} onChange={(event) => updateDraft({ username: event.target.value })} />
        </label>
        <label>
          <span>{t("settings:proxyPassword")}</span>
          <input type="password" value={draft.password ?? ""} disabled={draft.proxyType === "NONE"} onChange={(event) => updateDraft({ password: event.target.value })} />
        </label>
      </div>
      <div className="proxy-status-card">
        <strong>{normalizedDraft.enabled ? `${normalizedDraft.proxyType} ${normalizedDraft.host}:${normalizedDraft.port}` : t("settings:directOkxConnection")}</strong>
        <span>{normalizedDraft.username ? t("settings:proxyAuthenticatedStatus", { username: normalizedDraft.username, status }) : status}</span>
        {testResult && <em className={testResult.ok ? "up" : "down"}>{t(testResult.ok ? "settings:reachable" : "settings:unreachable")} · {testResult.latencyMs}ms</em>}
      </div>
      <div className="modal-actions">
        <button onClick={test} disabled={busy}>{busy ? t("common:processing") : t("settings:testConnection")}</button>
        <button onClick={save} disabled={busy} className="primary-action">{t("settings:saveAndReconnect")}</button>
      </div>
    </div>
  );
}

type AiModelDraft = AiModelConfigUpdate & { apiKey: string; permissionMode: AiPermissionMode; reasoningDepth: AiReasoningDepth };

function createAiModelDraft(seed: AiProviderSetupValue): AiModelDraft {
  return {
    id: `model-${Date.now()}`,
    name: seed.name,
    provider: seed.provider,
    model: seed.model,
    baseUrl: seed.baseUrl,
    apiKey: seed.apiKey,
    permissionMode: "advisor",
    reasoningDepth: "medium"
  };
}

function AiSettingsPane({
  onNotify,
  onValidated
}: {
  onNotify: (notification: Omit<AppNotification, "id" | "createdAt">) => void;
  onValidated?: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const confirmPrompt = useConfirmPrompt();
  const [summary, setSummary] = useState<AiConfigSummary | null>(null);
  const [models, setModels] = useState<AiModelDraft[]>([]);
  const [activeModelId, setActiveModelId] = useState("");
  const [selectedModelId, setSelectedModelId] = useState("");
  const [status, setStatus] = useState(() => t("settings:readingAiConfiguration"));
  const [busy, setBusy] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);

  const applySummary = useCallback((config: AiConfigSummary) => {
    const configuredModels = config.models.map((item) => ({
      id: item.id,
      name: item.name,
      provider: item.provider,
      model: item.model,
      baseUrl: item.baseUrl,
      apiKey: "",
      permissionMode: normalizeAiPermissionMode(item.permissionMode),
      reasoningDepth: item.reasoningDepth ?? "medium"
    }));
    const nextModels = configuredModels;
    setSummary(config);
    setModels(nextModels);
    setActiveModelId(config.activeModelId || nextModels[0]?.id || "");
    setSelectedModelId((current) => nextModels.some((item) => item.id === current) ? current : config.activeModelId || nextModels[0]?.id || "");
    setStatus(config.configured ? t("settings:currentModel", { model: config.model }) : t("settings:aiNotConfigured"));
    setInitialized(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadAiConfigSummary()
      .then((config) => {
        if (cancelled) return;
        if (config) applySummary(config);
        else {
          setModels([]);
          setActiveModelId("");
          setSelectedModelId("");
          setStatus(t("settings:aiReadDesktopOnly"));
          setInitialized(true);
        }
      })
      .catch((error) => {
        logger.error("load ai config failed", error);
        setStatus(t("settings:aiConfigurationReadFailed"));
        setInitialized(true);
      });
    return () => {
      cancelled = true;
    };
  }, [applySummary, t]);

  const selectedModel = models.find((item) => item.id === selectedModelId) ?? models[0] ?? null;
  const selectedTemplate = selectedModel ? findAiProviderTemplate(selectedModel.provider) : null;
  const selectedUsesLocalCli = Boolean(selectedModel && aiProviderUsesLocalCli(selectedModel.provider));
  const selectedSavedModel = selectedModel ? summary?.models.find((item) => item.id === selectedModel.id) : null;
  const canTestSelectedModel = Boolean(
    selectedModel
    && selectedModel.name.trim()
    && selectedModel.provider.trim()
    && selectedModel.model.trim()
    && selectedModel.baseUrl.trim()
    && (selectedUsesLocalCli || selectedModel.apiKey.trim() || selectedSavedModel?.configured)
  );
  const firstSetup = initialized && !summary?.configured && models.length === 0;
  const updateSelectedModel = useCallback((patch: Partial<AiModelDraft>) => {
    setModels((current) => current.map((item) => item.id === selectedModelId ? { ...item, ...patch } : item));
  }, [selectedModelId]);

  const addModel = useCallback((seed: AiProviderSetupValue) => {
    const next = createAiModelDraft(seed);
    setModels((current) => [...current, next]);
    setSelectedModelId(next.id);
    setActiveModelId((current) => current || next.id);
    setSetupOpen(false);
  }, []);

  const removeModel = useCallback(() => {
    if (!selectedModel || models.length <= 1) return;
    const target = selectedModel;
    confirmPrompt.confirm({
      title: t("settings:deleteModelConfiguration"),
      message: t("settings:confirmDeleteModel", { name: target.name }),
      confirmText: t("common:delete"),
      danger: true,
      onConfirm: () => {
        const next = models.filter((item) => item.id !== target.id);
        setModels(next);
        setSelectedModelId(next[0]?.id ?? "");
        if (activeModelId === target.id) setActiveModelId(next[0]?.id ?? "");
      }
    });
  }, [activeModelId, confirmPrompt, models, selectedModel, t]);

  const save = useCallback(async () => {
    const active = models.find((item) => item.id === activeModelId);
    if (!active || models.length === 0) {
      onNotify({ kind: "warning", title: t("settings:aiConfigurationNotSaved"), message: t("settings:addAndSelectAiModel") });
      return;
    }
    const invalid = models.find((item) => !item.name.trim() || !item.provider.trim() || !item.model.trim() || !item.baseUrl.trim());
    if (invalid) {
      onNotify({ kind: "warning", title: t("settings:aiConfigurationNotSaved"), message: t("settings:completeModelConfiguration", { model: invalid.name || invalid.id }) });
      return;
    }
    const missingKey = models.find((item) => !aiProviderUsesLocalCli(item.provider) && !item.apiKey.trim() && !summary?.models.find((saved) => saved.id === item.id)?.configured);
    if (missingKey) {
      onNotify({ kind: "warning", title: t("settings:aiConfigurationNotSaved"), message: t("settings:enterModelApiKey", { model: missingKey.name || missingKey.id }) });
      return;
    }
    setBusy(true);
    setStatus(t("settings:saving"));
    try {
      const next = await saveAiConfig({
        provider: active.provider,
        model: active.model,
        baseUrl: active.baseUrl,
        apiKey: active.apiKey,
        stream: true,
        permissionMode: active.permissionMode,
        reasoningDepth: active.reasoningDepth,
        activeModelId,
        models: models.map((item) => ({ ...item, apiKey: item.apiKey || undefined })),
        systemPrompt: summary?.systemPrompt,
        customRules: summary?.customRules,
        enabledSkills: withRequiredAiSkills(summary?.enabledSkills),
        skillDefinitions: summary?.skillDefinitions
      });
      if (!next) {
        setStatus(t("settings:aiSaveDesktopOnly"));
        return;
      }
      applySummary(next);
      setStatus(t("settings:aiModelConfigurationSaved"));
      onNotify({ kind: "success", title: t("settings:aiModelConfigurationSaved"), message: t("settings:modelCountCurrent", { count: next.models.length, model: next.model }) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("ai config save failed", error);
      setStatus(t("settings:aiConfigurationSaveFailed"));
      onNotify({ kind: "error", title: t("settings:aiConfigurationSaveFailed"), message });
    } finally {
      setBusy(false);
    }
  }, [activeModelId, applySummary, models, onNotify, summary, t]);

  const test = useCallback(async () => {
    if (!selectedModel) return;
    setBusy(true);
    setStatus(t("settings:testingModel", { model: selectedModel.name || selectedModel.model }));
    try {
      const next = await testAiConnection({
        ...selectedModel,
        apiKey: selectedModel.apiKey.trim() || undefined
      });
      if (!next) {
        setStatus(t("settings:aiTestDesktopOnly"));
        return;
      }
      setStatus(t("settings:modelConnectionHealthy", { model: next.name }));
      onNotify({ kind: "success", title: t("settings:aiConnectionHealthy"), message: `${next.provider} · ${next.model}` });
      onValidated?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("ai connection test failed", error);
      setStatus(t("settings:aiConnectionTestFailed"));
      onNotify({ kind: "error", title: t("settings:aiConnectionTestFailed"), message });
    } finally {
      setBusy(false);
    }
  }, [onNotify, onValidated, selectedModel, t]);

  return (
    <>
      <div className="ai-settings-pane ai-model-settings-pane" data-onboarding-target="ai">
      {!firstSetup && <div className="settings-section">
        <div>
          <strong>{t("settings:aiModels")}</strong>
          <span>{status}</span>
        </div>
        <button type="button" className="primary-action" onClick={() => setSetupOpen(true)}><Plus size={14} />{t("settings:addConfiguration")}</button>
      </div>}

      {firstSetup && (
        <section className="ai-first-setup" aria-label={t("settings:firstAiModelSetup")}>
          <div className="ai-first-setup-mark"><Bot size={20} /></div>
          <div className="ai-first-setup-copy">
            <span>{t("settings:firstSetup")}</span>
            <strong>{t("settings:selectProviderAndConnect")}</strong>
            <p>{t("settings:providerTemplateHelp")}</p>
          </div>
          <div className="ai-first-setup-facts">
            <span><KeyRound size={14} />{t("settings:credentialsStayLocal")}</span>
            <span><CircleCheck size={14} />{t("settings:streamingEnabledByDefault")}</span>
            <span><SlidersHorizontal size={14} />{t("settings:modelIdFlexible")}</span>
            <button type="button" className="ai-first-setup-action" onClick={() => setSetupOpen(true)}><Plus size={13} />{t("settings:addAiConfiguration")}</button>
          </div>
        </section>
      )}

      {!firstSetup && <div className="ai-current-model-row">
        <label>
          <span>{t("settings:currentAiAssistantModel")}<small>{t("settings:currentModelScope")}</small></span>
          <TerminalSelect
            ariaLabel={t("settings:currentAiAssistantModel")}
            value={activeModelId}
            options={models.length === 0
              ? [{ value: "", label: t("settings:notConfigured") }]
              : models.map((item) => ({ value: item.id, label: `${item.name} · ${item.model || t("settings:modelNotEntered")}` }))}
            onChange={setActiveModelId}
          />
        </label>
      </div>}

      <div className={clsx("ai-model-config-layout", firstSetup && "first-setup")}>
        <aside className="ai-model-config-list" aria-label={t("settings:modelConfigurationList")}>
          {models.length === 0 ? <button type="button" onClick={() => setSetupOpen(true)}><Plus size={14} />{t("settings:addFirstModel")}</button> : models.map((item) => {
            const isActive = item.id === activeModelId;
            const saved = summary?.models.find((entry) => entry.id === item.id);
            return (
              // The row carries two distinct actions: opening the model for
              // editing, and making it the model the assistants actually use.
              // They were previously one control, so "currently used" read as a
              // status label rather than something switchable.
              <div className={clsx("ai-model-config-row", item.id === selectedModelId && "is-selected", isActive && "is-active")} key={item.id}>
                <button type="button" className="ai-model-config-row__select" onClick={() => setSelectedModelId(item.id)} aria-pressed={item.id === selectedModelId}>
                  <strong>{item.name || t("settings:unnamedModel")}</strong>
                  <span>{item.provider} · {item.model || t("settings:pendingConfiguration")}</span>
                  <em>{saved?.configured ? t("settings:configured") : aiProviderUsesLocalCli(item.provider) ? t("settings:pendingSave") : t("settings:keyNotConfigured")}</em>
                </button>
                {isActive ? (
                  <span className="ai-model-config-row__badge" title={t("settings:currentModelScope")}>
                    <CircleCheck size={11} />{t("settings:currentlyUsed")}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="ai-model-config-row__use"
                    onClick={() => setActiveModelId(item.id)}
                    title={t("settings:setAsCurrentModelHint")}
                  >
                    {t("settings:setAsCurrentModel")}
                  </button>
                )}
              </div>
            );
          })}
        </aside>

        {selectedModel ? (
          <section className="ai-model-config-editor">
            <div className="ai-model-editor-head">
              <div><strong>{firstSetup ? t("settings:modelConnection") : selectedModel.name || t("settings:unnamedModel")}</strong><span>{t("settings:credentialsLocalNotice")}</span></div>
              <button type="button" onClick={removeModel} disabled={models.length <= 1} title={t("settings:deleteModelConfiguration")}><Trash2 size={14} /></button>
            </div>
            {selectedTemplate ? <AiProviderGuide template={selectedTemplate} local={selectedUsesLocalCli} /> : null}
            <div className="settings-form-grid">
              <label><span>{t("settings:customName")}</span><input value={selectedModel.name} onChange={(event) => updateSelectedModel({ name: event.target.value })} /></label>
              <label><span>Provider</span><input value={selectedModel.provider} readOnly={Boolean(selectedTemplate)} onChange={(event) => updateSelectedModel({ provider: event.target.value })} /></label>
              <label className="wide ai-settings-model-id-field"><span>Model ID</span><AiModelIdControl key={`${selectedModel.id}-${selectedTemplate?.id ?? "custom"}`} template={selectedTemplate} value={selectedModel.model} onChange={(model) => updateSelectedModel({ model })} ariaLabel={`${selectedModel.name || t("settings:aiModel")} Model ID`} /></label>
              <label className="wide"><span>Base URL</span><input value={selectedModel.baseUrl} readOnly={selectedUsesLocalCli} onChange={(event) => updateSelectedModel({ baseUrl: event.target.value })} /></label>
              {selectedUsesLocalCli ? (
                <div className="ai-provider-local-auth wide"><CircleCheck size={16} /><div><strong>{t("settings:useLocalLogin")}</strong><span>{t("settings:localLoginHelp")}</span></div><code>{selectedModel.provider === "claude-code" ? "claude auth status" : "codex login status"}</code></div>
              ) : (
                <label className="wide"><span>API Key</span><input type="password" autoComplete="off" data-onboarding-focus value={selectedModel.apiKey} placeholder={summary?.models.find((item) => item.id === selectedModel.id)?.apiKeyMasked || t("settings:enterNewApiKey")} onChange={(event) => updateSelectedModel({ apiKey: event.target.value })} /></label>
              )}
            </div>
          </section>
        ) : null}
      </div>

      {models.length > 0 && <div className="modal-actions">
        <button onClick={test} disabled={busy || !canTestSelectedModel}>{busy ? t("common:processing") : t("settings:testSelectedModel")}</button>
        <button className="primary-action" onClick={save} disabled={busy}>{busy ? t("settings:saving") : t("settings:saveModelConfiguration")}</button>
      </div>}
      </div>
      {setupOpen ? (
        <ModalShell
          title={t("settings:addAiConfiguration")}
          description={t("settings:addAiConfigurationDescription")}
          className="ai-provider-setup-modal"
          onClose={() => setSetupOpen(false)}
        >
          <AiProviderSetupFlow
            existingNames={models.map((item) => item.name)}
            onAdd={addModel}
            onCancel={() => setSetupOpen(false)}
          />
        </ModalShell>
      ) : null}
      {confirmPrompt.element}
    </>
  );
}

function useAiConfigDraft(onNotify: (notification: Omit<AppNotification, "id" | "createdAt">) => void) {
  const { t } = useTranslation("settings");
  const [summary, setSummary] = useState<AiConfigSummary | null>(null);
  const [draft, setDraft] = useState<AiConfigUpdate & { apiKey: string; permissionMode: AiPermissionMode; stream: boolean; enabledSkills: string[]; skillDefinitions: AiSkillDefinition[]; openAgent: boolean; workspaceRoots: string[] }>({
    provider: "openai-compatible",
    model: "",
    baseUrl: "",
    apiKey: "",
    stream: true,
    permissionMode: "advisor",
    systemPrompt: "",
    customRules: "",
    enabledSkills: withRequiredAiSkills([]),
    skillDefinitions: AI_SKILL_OPTIONS,
    openAgent: true,
    workspaceRoots: []
  });
  const [status, setStatus] = useState(() => t("readingAiConfiguration"));
  const [busy, setBusy] = useState(false);

  const applySummary = useCallback((config: AiConfigSummary | null) => {
    setSummary(config);
    if (!config) return;
    setDraft((current) => ({
      ...current,
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      stream: config.stream,
      permissionMode: normalizeAiPermissionMode(config.permissionMode),
      systemPrompt: config.systemPrompt,
      customRules: config.customRules,
      enabledSkills: withRequiredAiSkills(config.enabledSkills),
      skillDefinitions: normalizeAiSkillDefinitions(config.skillDefinitions),
      openAgent: config.openAgent,
      workspaceRoots: config.workspaceRoots
    }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadAiConfigSummary()
      .then((config) => {
        if (cancelled) return;
        applySummary(config);
        setStatus(config?.configured ? t("currentModel", { model: config.model }) : t("aiNotConfigured"));
      })
      .catch((error) => {
        logger.error("load ai config failed", error);
        setStatus(t("aiConfigurationReadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [applySummary, t]);

  const save = useCallback(async (message: string) => {
    setBusy(true);
    setStatus(t("saving"));
    try {
      const next = await saveAiConfig({
        provider: draft.provider,
        model: draft.model,
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey,
        stream: draft.stream,
        permissionMode: draft.permissionMode,
        systemPrompt: draft.systemPrompt,
        customRules: draft.customRules,
        enabledSkills: withRequiredAiSkills(draft.enabledSkills),
        skillDefinitions: draft.skillDefinitions,
        openAgent: draft.openAgent,
        workspaceRoots: draft.workspaceRoots
      });
      if (!next) {
        setStatus(t("aiSaveDesktopOnly"));
        return null;
      }
      applySummary(next);
      setDraft((current) => ({ ...current, apiKey: "" }));
      setStatus(message);
      onNotify({ kind: "success", title: message, message: `${next.model} · ${permissionModeLabel(next.permissionMode, t)}` });
      return next;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("ai config save failed", error);
      setStatus(t("aiConfigurationSaveFailed"));
      onNotify({ kind: "error", title: t("aiConfigurationSaveFailed"), message: errorMessage });
      return null;
    } finally {
      setBusy(false);
    }
  }, [applySummary, draft, onNotify, t]);

  return { summary, draft, setDraft, status, setStatus, busy, setBusy, applySummary, save };
}

function PromptSettingsPane({ onNotify }: { onNotify: (notification: Omit<AppNotification, "id" | "createdAt">) => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const { draft, setDraft, status, busy, save } = useAiConfigDraft(onNotify);

  return (
    <div className="prompt-settings-pane" data-i18n-skip>
      <section className="settings-section">
        <div>
          <strong>{t("settings:globalPrompt")}</strong>
          <span>{status}</span>
        </div>
        <button className="primary-action" onClick={() => setDraft((current) => ({ ...current, systemPrompt: "" }))}>{t("common:restoreDefault")}</button>
      </section>
      <label className="settings-textarea-field">
        <span>{t("settings:systemPrompt")}</span>
        <textarea
          value={draft.systemPrompt ?? ""}
          placeholder={t("settings:systemPromptPlaceholder")}
          onChange={(event) => setDraft((current) => ({ ...current, systemPrompt: event.target.value }))}
        />
      </label>
      <label className="settings-textarea-field compact">
        <span>{t("settings:customRules")}</span>
        <textarea
          value={draft.customRules ?? ""}
          placeholder={t("settings:customRulesPlaceholder")}
          onChange={(event) => setDraft((current) => ({ ...current, customRules: event.target.value }))}
        />
      </label>
      <section className="settings-section" data-i18n-skip>
        <div>
          <strong>开放 Agent 能力</strong>
          <span>允许当前三个 AI 使用 Cline 的文件、Shell、网络、浏览器、MCP 和用户 Skill 工具。</span>
        </div>
        <label className="settings-toggle-field">
          <input
            type="checkbox"
            checked={draft.openAgent !== false}
            onChange={(event) => setDraft((current) => ({ ...current, openAgent: event.target.checked }))}
          />
          <span>{draft.openAgent !== false ? "已开启" : "已关闭"}</span>
        </label>
      </section>
      <div className="modal-actions">
        <button className="primary-action" disabled={busy} onClick={() => void save(t("settings:promptConfigurationSaved"))}>
          {busy ? t("settings:saving") : t("settings:savePrompt")}
        </button>
      </div>
    </div>
  );
}

function SkillsSettingsPane({ onNotify }: { onNotify: (notification: Omit<AppNotification, "id" | "createdAt">) => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const { summary, draft, setDraft, status, busy, save, applySummary } = useAiConfigDraft(onNotify);
  const confirmPrompt = useConfirmPrompt();
  const [skillDialogOpen, setSkillDialogOpen] = useState(false);
  const [skillDialogMode, setSkillDialogMode] = useState<"custom" | "local" | "git">("custom");
  const [customSkill, setCustomSkill] = useState({ id: "", description: "", rules: "", content: "" });
  const [skillSource, setSkillSource] = useState("");
  const [gitSource, setGitSource] = useState("");
  const [gitReference, setGitReference] = useState("");
  const [gitSubpath, setGitSubpath] = useState("");
  const [importBusy, setImportBusy] = useState<"path" | "git" | null>(null);
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const [viewedVersionId, setViewedVersionId] = useState<string>("current");
  const [automationSummary, setAutomationSummary] = useState<AiAutomationOverview | null>(null);
  const [versionStatus, setVersionStatus] = useState(() => t("settings:readingSkillVersions"));
  const [versionBusy, setVersionBusy] = useState<string | null>(null);
  const fixedSkillIds = REQUIRED_AI_SKILL_ID_SET;
  const enabled = new Set(draft.enabledSkills ?? []);
  const skills = draft.skillDefinitions?.length ? draft.skillDefinitions : AI_SKILL_OPTIONS;
  const editingSkill = skills.find((skill) => skill.id === editingSkillId) ?? skills[0] ?? null;
  const versionsBySkill = useMemo(() => {
    const grouped = new Map<string, AiSkillVersion[]>();
    for (const version of automationSummary?.skillVersions ?? []) {
      const items = grouped.get(version.skillId) ?? [];
      items.push(version);
      grouped.set(version.skillId, items);
    }
    for (const items of grouped.values()) items.sort((a, b) => b.version - a.version);
    return grouped;
  }, [automationSummary?.skillVersions]);
  const editingVersions = editingSkill ? versionsBySkill.get(editingSkill.id) ?? [] : [];
  const viewedVersion = editingVersions.find((version) => version.id === viewedVersionId) ?? null;
  const displayedSkill = viewedVersion?.definition ?? editingSkill;
  const profilesBySkill = useMemo(() => {
    const grouped = new Map<string, AiAutomationOverview["profiles"]>();
    for (const profile of automationSummary?.profiles ?? []) {
      for (const skillId of profile.skillIds ?? []) {
        const items = grouped.get(skillId) ?? [];
        items.push(profile);
        grouped.set(skillId, items);
      }
    }
    return grouped;
  }, [automationSummary?.profiles]);

  const refreshSkillVersions = useCallback(async () => {
    try {
      const summary = await invokeDesktop<AiAutomationOverview>("ai_automation_overview");
      setAutomationSummary(summary);
      setVersionStatus(summary ? t("settings:skillVersionRecordCount", { count: summary.skillVersions.length }) : t("settings:skillVersionsDesktopOnly"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("load skill versions failed", error);
      setVersionStatus(t("settings:skillVersionReadFailed"));
      onNotify({ kind: "error", title: t("settings:skillVersionReadFailed"), message });
    }
  }, [onNotify, t]);

  useEffect(() => {
    void refreshSkillVersions();
  }, [refreshSkillVersions]);

  const selectSkill = useCallback((skillId: string) => {
    setEditingSkillId(skillId);
    setViewedVersionId("current");
  }, []);

  const toggleSkill = useCallback((skillId: string, checked: boolean) => {
    if (fixedSkillIds.has(skillId)) return;
    setDraft((current) => {
      const items = new Set(current.enabledSkills ?? []);
      if (checked) items.add(skillId);
      else items.delete(skillId);
      return { ...current, enabledSkills: Array.from(items) };
    });
  }, [fixedSkillIds, setDraft]);

  const updateSkill = useCallback((skillId: string, patch: Partial<AiSkillDefinition>) => {
    setDraft((current) => ({
      ...current,
      skillDefinitions: (current.skillDefinitions ?? AI_SKILL_OPTIONS).map((skill) =>
        skill.id === skillId ? { ...skill, ...patch } : skill
      )
    }));
  }, [setDraft]);

  const setSkillRuntimeTrust = useCallback(async (skillId: string, trusted: boolean) => {
    setVersionBusy(`trust:${skillId}`);
    try {
      const next = await invokeDesktop<AiConfigSummary>("ai_skill_set_runtime_trust", { skillId, trusted });
      if (!next) throw new Error(t("settings:skillExecutionTrustUpdateFailed"));
      applySummary(next);
      onNotify({
        kind: "success",
        title: trusted ? t("settings:skillExecutionTrustGranted") : t("settings:skillExecutionTrustRevoked"),
        message: skillId
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onNotify({ kind: "error", title: t("settings:skillExecutionTrustUpdateFailed"), message });
    } finally {
      setVersionBusy(null);
    }
  }, [applySummary, onNotify, t]);

  const resetTradingPhilosophy = useCallback(() => {
    const baseline = AI_SKILL_OPTIONS.find((skill) => skill.id === "trading-philosophy");
    if (!baseline) return;
    updateSkill("trading-philosophy", {
      description: baseline.description,
      rules: baseline.rules,
      content: baseline.content
    });
  }, [updateSkill]);

  const renameSkill = useCallback((skillId: string, value: string) => {
    const nextId = value
      .trim()
      .toLowerCase()
      .replace(/[\\/:*?"<>|\s]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!nextId || nextId === skillId || fixedSkillIds.has(skillId)) return;
    if (skills.some((skill) => skill.id === nextId)) return;
    setDraft((current) => ({
      ...current,
      enabledSkills: [...new Set((current.enabledSkills ?? []).map((id) => (id === skillId ? nextId : id)))],
      skillDefinitions: (current.skillDefinitions ?? AI_SKILL_OPTIONS).map((skill) =>
        skill.id === skillId ? { ...skill, id: nextId, name: nextId } : skill
      )
    }));
    selectSkill(nextId);
  }, [fixedSkillIds, selectSkill, setDraft, skills]);

  const addSkill = useCallback(() => {
    const id = customSkill.id
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || `custom-skill-${Date.now()}`;
    if (skills.some((skill) => skill.id === id)) {
      onNotify({ kind: "error", title: "无法新增 Skill", message: "Skill ID 已存在，请使用不同的名称。" });
      return;
    }
    const skill: AiSkillDefinition = {
      id,
      name: id,
      description: customSkill.description.trim() || t("settings:newSkillDescription"),
      rules: customSkill.rules.trim() || t("settings:newSkillRules"),
      content: customSkill.content.trim() || t("settings:newSkillContent"),
      builtin: false
    };
    setDraft((current) => ({
      ...current,
      enabledSkills: [...new Set([...(current.enabledSkills ?? []), id])],
      skillDefinitions: [...(current.skillDefinitions ?? AI_SKILL_OPTIONS), skill]
    }));
    selectSkill(id);
    setCustomSkill({ id: "", description: "", rules: "", content: "" });
    setSkillDialogOpen(false);
  }, [customSkill, onNotify, selectSkill, setDraft, skills, t]);

  const removeSkill = useCallback((skillId: string) => {
    const target = skills.find((skill) => skill.id === skillId);
    if (target?.builtin || fixedSkillIds.has(skillId)) return;
    setDraft((current) => ({
      ...current,
      enabledSkills: (current.enabledSkills ?? []).filter((id) => id !== skillId),
      skillDefinitions: (current.skillDefinitions ?? []).filter((skill) => skill.id !== skillId)
    }));
    setEditingSkillId(null);
    setViewedVersionId("current");
  }, [fixedSkillIds, setDraft, skills]);

  const saveAndRefreshVersions = useCallback(async () => {
    const next = await save(t("settings:skillsConfigurationSaved"));
    if (next) await refreshSkillVersions();
  }, [refreshSkillVersions, save]);

  const importSkill = useCallback(async () => {
    if (!skillSource.trim()) return;
    setImportBusy("path");
    try {
      const next = await invokeDesktop<AiConfigSummary>("ai_skill_import", { source: skillSource.trim() });
      if (!next) throw new Error("导入后未返回 AI 配置");
      applySummary(next);
      setSkillSource("");
      const imported = next.skillDefinitions.find((skill) => !skills.some((current) => current.id === skill.id));
      if (imported) selectSkill(imported.id);
      setSkillDialogOpen(false);
      onNotify({ kind: "success", title: "Skill 导入成功", message: "已启用并同步到 Cline Skill 目录" });
      await refreshSkillVersions();
    } catch (error) {
      onNotify({ kind: "error", title: "Skill 导入失败", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setImportBusy(null);
    }
  }, [applySummary, onNotify, refreshSkillVersions, selectSkill, skillSource, skills]);

  const installSkillFromGit = useCallback(async () => {
    if (!gitSource.trim()) return;
    setImportBusy("git");
    try {
      const next = await invokeDesktop<AiConfigSummary>("ai_skill_install_git", {
        url: gitSource.trim(),
        reference: gitReference.trim() || null,
        subpath: gitSubpath.trim() || null
      });
      if (!next) throw new Error("安装后未返回 AI 配置");
      applySummary(next);
      setGitSource("");
      setGitReference("");
      setGitSubpath("");
      const imported = next.skillDefinitions.find((skill) => !skills.some((current) => current.id === skill.id));
      if (imported) selectSkill(imported.id);
      setSkillDialogOpen(false);
      onNotify({ kind: "success", title: "Git Skill 安装成功", message: "仓库已克隆、导入并启用" });
      await refreshSkillVersions();
    } catch (error) {
      onNotify({ kind: "error", title: "Git Skill 安装失败", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setImportBusy(null);
    }
  }, [applySummary, gitReference, gitSource, gitSubpath, onNotify, refreshSkillVersions, selectSkill, skills]);

  const pickSkillSource = useCallback(async (kind: "directory" | "zip") => {
    try {
      const selected = await invokeDesktop<string | null>("ai_skill_pick_source", { kind });
      if (selected) setSkillSource(selected);
    } catch (error) {
      onNotify({ kind: "error", title: "无法选择 Skill 来源", message: error instanceof Error ? error.message : String(error) });
    }
  }, [onNotify]);

  const publishVersion = useCallback(async (version: AiSkillVersion) => {
    setVersionBusy(`publish:${version.id}`);
    try {
      const published = await invokeDesktop<AiSkillVersion>("ai_skill_version_publish", { id: version.id });
      onNotify({
        kind: "success",
        title: t("settings:skillVersionPublished"),
        message: `${published?.skillId ?? version.skillId} · v${published?.version ?? version.version}`
      });
      await refreshSkillVersions();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("skill publish failed", error);
      onNotify({ kind: "error", title: t("settings:skillPublishFailed"), message });
    } finally {
      setVersionBusy(null);
    }
  }, [onNotify, refreshSkillVersions]);

  const discardVersionNow = useCallback(async (version: AiSkillVersion) => {
    setVersionBusy(`discard:${version.id}`);
    try {
      await invokeDesktop("ai_skill_version_discard", { id: version.id });
      onNotify({ kind: "success", title: t("settings:skillDraftDiscarded"), message: `${version.skillId} · v${version.version}` });
      if (viewedVersionId === version.id) setViewedVersionId("current");
      await refreshSkillVersions();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("skill discard failed", error);
      onNotify({ kind: "error", title: t("settings:skillDraftDiscardFailed"), message });
    } finally {
      setVersionBusy(null);
    }
  }, [onNotify, refreshSkillVersions, viewedVersionId]);

  // Discarding a draft is irreversible, so it is confirmed before running.
  const discardVersion = useCallback((version: AiSkillVersion) => {
    confirmPrompt.confirm({
      title: t("settings:discardSkillDraft", { defaultValue: t("common:delete") }),
      message: t("settings:confirmDiscardSkillDraft", { skill: version.skillId, version: version.version }),
      confirmText: t("common:delete"),
      danger: true,
      onConfirm: () => { void discardVersionNow(version); }
    });
  }, [confirmPrompt, discardVersionNow, t]);

  const latestPublished = editingVersions.find((version) => version.status === "published");
  const usingProfiles = editingSkill ? profilesBySkill.get(editingSkill.id) ?? [] : [];
  const readOnly = Boolean(viewedVersion);

  return (
    <div className="skills-settings-pane" data-i18n-skip>
      <section className="settings-section">
        <div>
          <strong>{t("settings:globalSkills")}</strong>
          <span>{status} · {versionStatus} · {t("settings:skillVersioningNotice")}</span>
        </div>
        <div className="skill-header-actions">
          <button type="button" onClick={() => void refreshSkillVersions()} disabled={Boolean(versionBusy)} title={t("settings:refreshVersions")}><RefreshCw size={14} /></button>
          <button className="primary-action" onClick={() => setSkillDialogOpen(true)}><Plus size={14} />新增 Skill</button>
        </div>
      </section>
      <div className="skills-editor-layout">
        <div className="skill-option-list">
          {skills.map((skill) => {
            const versions = versionsBySkill.get(skill.id) ?? [];
            const latest = versions.find((version) => version.status === "published");
            return (
              <div className={clsx("skill-option", editingSkill?.id === skill.id && "active")} key={skill.id}>
                <label>
                  <input type="checkbox" checked={fixedSkillIds.has(skill.id) || enabled.has(skill.id)} disabled={fixedSkillIds.has(skill.id)} onChange={(event) => toggleSkill(skill.id, event.target.checked)} />
                  <span>
                    <strong>{skill.id || t("settings:unnamedSkill")}{aiSkillConstraintLabel(skill.id, t) ? ` · ${aiSkillConstraintLabel(skill.id, t)}` : ""}</strong>
                    <small>{skill.description || t("settings:noDescription")}</small>
                    <em>{latest ? t("settings:latestVersion", { version: latest.version }) : t("settings:notPublished")} · {t("settings:versionCount", { count: versions.length })}{skill.bundle ? ` · Bundle ${skill.bundle.bundleHash.slice(0, 8)}` : ""}</em>
                  </span>
                </label>
                <button type="button" onClick={() => selectSkill(skill.id)}>{t("settings:view")}</button>
              </div>
            );
          })}
        </div>
        {editingSkill && displayedSkill ? (
          <section className={clsx("skill-edit-panel", readOnly && "history-view")}>
            <div className="skill-editor-version-head">
              <div>
                <strong>{displayedSkill.name || displayedSkill.id}</strong>
                <span>{readOnly ? t("settings:historicalVersionReadOnly", { version: viewedVersion?.version }) : t("settings:currentSkillContent", { version: latestPublished?.version ?? "" })}</span>
              </div>
              <label>
                <span>{t("settings:viewVersion")}</span>
                <TerminalSelect
                  ariaLabel={t("settings:viewSkillVersion")}
                  value={viewedVersionId}
                  options={[
                    { value: "current", label: t("settings:currentEditableContent") },
                    ...editingVersions.map((version) => ({ value: version.id, label: `v${version.version} · ${t(version.status === "published" ? "settings:published" : "settings:draft")}` }))
                  ]}
                  onChange={setViewedVersionId}
                />
              </label>
            </div>
            <div className="skill-version-context">
              <span>{t("settings:profilesUsingSkill", { count: usingProfiles.length })}</span>
              <small>{usingProfiles.length > 0 ? usingProfiles.map((profile) => profile.skillVersionModes?.[editingSkill.id] === "pinned" ? `${profile.name} · ${t("settings:pinnedVersion", { version: profile.skillVersions?.[editingSkill.id] })}` : `${profile.name} · ${t("settings:followLatestVersion")}`).join(", ") : t("settings:noProfileReferences")}</small>
            </div>
            {!readOnly && ["node", "python"].includes(editingSkill.bundle?.manifest.runtime?.kind ?? "") ? (
              <label className="settings-toggle-field">
                <span>{t("settings:skillExecutionTrust")}</span>
                <input
                  type="checkbox"
                  checked={Boolean(summary?.skillRuntimeTrust?.[editingSkill.id])}
                  disabled={Boolean(versionBusy)}
                  onChange={(event) => void setSkillRuntimeTrust(editingSkill.id, event.target.checked)}
                />
              </label>
            ) : null}
            <label><span>{t("common:name")}</span><input value={displayedSkill.id} disabled={readOnly || fixedSkillIds.has(editingSkill.id)} onChange={(event) => renameSkill(editingSkill.id, event.target.value)} /></label>
            <label><span>{t("common:description")}</span><input value={displayedSkill.description} disabled={readOnly || editingSkill.id === "desic-core-operations"} onChange={(event) => updateSkill(editingSkill.id, { description: event.target.value })} /></label>
            <label><span>{t("settings:rules")}</span><textarea value={displayedSkill.rules} disabled={readOnly || editingSkill.id === "desic-core-operations"} onChange={(event) => updateSkill(editingSkill.id, { rules: event.target.value })} /></label>
            <label><span>{t("settings:content")}</span><textarea value={displayedSkill.content ?? ""} disabled={readOnly || editingSkill.id === "desic-core-operations"} onChange={(event) => updateSkill(editingSkill.id, { content: event.target.value })} /></label>
            {viewedVersion?.status === "draft" ? <div className="skill-draft-actions"><button type="button" onClick={() => void publishVersion(viewedVersion)}>{t("settings:publishSkillVersion", { version: viewedVersion.version })}</button><button type="button" onClick={() => void discardVersion(viewedVersion)}>{t("settings:discardDraft")}</button></div> : null}
            {readOnly ? <button type="button" onClick={() => setViewedVersionId("current")}>{t("settings:returnToCurrentContent")}</button> : null}
            {!readOnly && editingSkill.id === "trading-philosophy" ? <button type="button" onClick={resetTradingPhilosophy}>{t("settings:restoreBuiltinTradingPhilosophy")}</button> : null}
            {!readOnly && !editingSkill.builtin && !fixedSkillIds.has(editingSkill.id) ? <button className="danger-action" onClick={() => removeSkill(editingSkill.id)}>{t("settings:deleteSkill")}</button> : null}
          </section>
        ) : null}
      </div>
      <div className="modal-actions">
        <button className="primary-action" disabled={busy || readOnly} onClick={() => void saveAndRefreshVersions()}>{busy ? t("settings:saving") : readOnly ? t("settings:historicalVersionsReadOnly") : t("settings:saveAndCreateVersion")}</button>
      </div>
      {skillDialogOpen ? (
        <ModalShell
          title="新增 Skill"
          description="选择来源后，将它添加到当前 AI 工作区。"
          compact
          className="skill-source-modal"
          onClose={() => !importBusy && setSkillDialogOpen(false)}
        >
          <div className="skill-source-modal__body">
            <div className="skill-source-tabs" role="tablist" aria-label="Skill 来源">
              <button type="button" role="tab" aria-selected={skillDialogMode === "custom"} className={clsx(skillDialogMode === "custom" && "active")} onClick={() => setSkillDialogMode("custom")}><FilePlus2 size={16} />自定义 Skill</button>
              <button type="button" role="tab" aria-selected={skillDialogMode === "local"} className={clsx(skillDialogMode === "local" && "active")} onClick={() => setSkillDialogMode("local")}><FolderOpen size={16} />本地目录 / ZIP</button>
              <button type="button" role="tab" aria-selected={skillDialogMode === "git"} className={clsx(skillDialogMode === "git" && "active")} onClick={() => setSkillDialogMode("git")}><GitBranch size={16} />Git 地址</button>
            </div>
            {skillDialogMode === "custom" ? (
              <div className="skill-source-form">
                <label><span>Skill 名称</span><input autoFocus value={customSkill.id} placeholder="例如：btc-scalping-research" onChange={(event) => setCustomSkill((current) => ({ ...current, id: event.target.value }))} /></label>
                <label><span>简短说明</span><input value={customSkill.description} placeholder="这个 Skill 在什么场景下工作？" onChange={(event) => setCustomSkill((current) => ({ ...current, description: event.target.value }))} /></label>
                <label><span>规则</span><textarea value={customSkill.rules} placeholder="给 AI 的关键约束和工作流程" onChange={(event) => setCustomSkill((current) => ({ ...current, rules: event.target.value }))} /></label>
                <label><span>内容</span><textarea value={customSkill.content} placeholder="参考资料、模板或详细指令" onChange={(event) => setCustomSkill((current) => ({ ...current, content: event.target.value }))} /></label>
              </div>
            ) : skillDialogMode === "local" ? (
              <div className="skill-source-form skill-source-form--single">
                <div className="skill-source-hint"><FolderOpen size={18} /><div><strong>导入本地 Skill</strong><span>选择包含 SKILL.md 的目录，或一个 Skill ZIP 压缩包。</span></div></div>
                <div className="skill-source-picker-actions">
                  <button type="button" onClick={() => void pickSkillSource("directory")}><FolderOpen size={15} />选择目录</button>
                  <button type="button" onClick={() => void pickSkillSource("zip")}><FilePlus2 size={15} />选择 ZIP</button>
                </div>
                <label><span>本地绝对路径</span><input autoFocus value={skillSource} placeholder="选择上方来源，或手动输入绝对路径" onChange={(event) => setSkillSource(event.target.value)} /></label>
              </div>
            ) : (
              <div className="skill-source-form skill-source-form--single">
                <div className="skill-source-hint"><GitBranch size={18} /><div><strong>从 Git 安装</strong><span>支持 HTTPS、SSH、固定 ref 和 Skill 子目录。</span></div></div>
                <label><span>Git 仓库地址</span><input autoFocus value={gitSource} placeholder="https://github.com/owner/skill.git" onChange={(event) => setGitSource(event.target.value)} /></label>
                <label><span>Ref（可选）</span><input value={gitReference} placeholder="tag、branch 或 commit" onChange={(event) => setGitReference(event.target.value)} /></label>
                <label><span>Skill 子目录（可选）</span><input value={gitSubpath} placeholder="skills/my-skill" onChange={(event) => setGitSubpath(event.target.value)} /></label>
              </div>
            )}
            <div className="modal-actions skill-source-modal__actions">
              <button type="button" onClick={() => setSkillDialogOpen(false)} disabled={Boolean(importBusy)}>取消</button>
              {skillDialogMode === "custom" ? <button type="button" className="primary-action" onClick={addSkill}>创建 Skill</button> : null}
              {skillDialogMode === "local" ? <button type="button" className="primary-action" onClick={() => void importSkill()} disabled={importBusy !== null || !skillSource.trim()}>{importBusy === "path" ? "导入中..." : "导入 Skill"}</button> : null}
              {skillDialogMode === "git" ? <button type="button" className="primary-action" onClick={() => void installSkillFromGit()} disabled={importBusy !== null || !gitSource.trim()}>{importBusy === "git" ? "安装中..." : "从 Git 安装"}</button> : null}
            </div>
          </div>
        </ModalShell>
      ) : null}
      {confirmPrompt.element}
    </div>
  );
}

function NotificationSettingsPane({ onNotify }: { onNotify: (notification: Omit<AppNotification, "id" | "createdAt">) => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const [summary, setSummary] = useState<NotificationSettingsSummary | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [eventTypes, setEventTypes] = useState<FeishuEventType[]>(DEFAULT_FEISHU_EVENT_TYPES);
  const [status, setStatus] = useState(() => t("settings:readingNotificationConfiguration"));
  const [busy, setBusy] = useState<"save" | "test" | null>(null);

  const applyFeishu = useCallback((feishu: FeishuConfigSummary) => {
    setSummary({ feishu });
    setEnabled(feishu.enabled);
    setWebhookUrl("");
    const configuredTypes = feishu.eventTypes.filter((value): value is FeishuEventType =>
      FEISHU_EVENT_OPTIONS.some(([option]) => option === value)
    );
    setEventTypes(configuredTypes.length > 0 ? configuredTypes : DEFAULT_FEISHU_EVENT_TYPES);
    setStatus(feishu.configured ? t("settings:feishuConfigured", { webhook: feishu.webhookMasked }) : t("settings:feishuNotConfigured"));
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    void loadNotificationSettings()
      .then((next) => {
        if (cancelled) return;
        if (!next) {
          setStatus(t("settings:notificationReadDesktopOnly"));
          return;
        }
        applyFeishu(next.feishu);
      })
      .catch((error) => {
        if (cancelled) return;
        logger.error("notification settings load failed", error);
        setStatus(t("settings:notificationConfigurationReadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [applyFeishu, t]);

  const toggleEventType = useCallback((eventType: FeishuEventType, checked: boolean) => {
    setEventTypes((current) => {
      const next = new Set(current);
      if (checked) next.add(eventType);
      else if (next.size > 1) next.delete(eventType);
      return DEFAULT_FEISHU_EVENT_TYPES.filter((value): value is FeishuEventType => next.has(value as FeishuEventType));
    });
  }, []);

  const save = useCallback(async () => {
    setBusy("save");
    setStatus(t("settings:savingNotificationConfiguration"));
    try {
      const next = await saveFeishuConfig({
        enabled,
        ...(webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}),
        eventTypes
      });
      if (!next) {
        setStatus(t("settings:notificationSaveDesktopOnly"));
        return;
      }
      applyFeishu(next);
      onNotify({ kind: "success", title: t("settings:notificationConfigurationSaved"), message: t(enabled ? "settings:feishuNotificationsEnabled" : "settings:feishuNotificationsDisabled") });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("notification settings save failed", error);
      setStatus(t("settings:notificationConfigurationSaveFailed"));
      onNotify({ kind: "error", title: t("settings:notificationConfigurationSaveFailed"), message });
    } finally {
      setBusy(null);
    }
  }, [applyFeishu, enabled, eventTypes, onNotify, t, webhookUrl]);

  const test = useCallback(async () => {
    setBusy("test");
    setStatus(t("settings:sendingTestNotification"));
    try {
      await testFeishuNotification();
      setStatus(summary?.feishu.configured ? t("settings:feishuConfigured", { webhook: summary.feishu.webhookMasked }) : t("settings:testNotificationSent"));
      onNotify({ kind: "success", title: t("settings:feishuTestSent"), message: t("settings:checkFeishuChat") });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("feishu notification test failed", error);
      setStatus(t("settings:feishuTestFailed"));
      onNotify({ kind: "error", title: t("settings:feishuTestFailed"), message });
    } finally {
      setBusy(null);
    }
  }, [onNotify, summary?.feishu.configured, summary?.feishu.webhookMasked, t]);

  return (
    <div className="notification-settings-pane">
      <section className="settings-section notification-channel-head">
        <div>
          <strong>{t("settings:feishuBot")}</strong>
          <span>{status}</span>
        </div>
        <label className="notification-channel-toggle">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          <span>{t("common:enabled")}</span>
        </label>
      </section>

      <div className="settings-form-grid">
        <label className="wide">
          <span>Webhook URL</span>
          <input
            type="password"
            autoComplete="off"
            value={webhookUrl}
            placeholder={summary?.feishu.webhookMasked || "https://open.feishu.cn/open-apis/bot/v2/hook/..."}
            onChange={(event) => setWebhookUrl(event.target.value)}
          />
        </label>
      </div>

      <fieldset className="notification-event-fieldset">
        <legend>{t("settings:allowedNotificationEvents")}</legend>
        <div className="notification-event-grid">
          {FEISHU_EVENT_OPTIONS.map(([value]) => {
            const checked = eventTypes.includes(value);
            const onlySelected = checked && eventTypes.length === 1;
            const label = t(`settings:feishuEvent_${value}`);
            return (
              <label className="notification-event-option" key={value} title={onlySelected ? t("settings:keepOneEventType") : label}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={onlySelected}
                  onChange={(event) => toggleEventType(value, event.target.checked)}
                />
                <span>{label}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <p className="notification-settings-note">{t("settings:webhookSecurityNotice")}</p>
      <div className="notification-settings-actions">
        <button disabled={Boolean(busy) || !summary?.feishu.configured} onClick={() => void test()}>{t("settings:testNotification")}</button>
        <button className="primary-action" disabled={Boolean(busy)} onClick={() => void save()}>{busy === "save" ? t("settings:saving") : t("settings:saveNotificationConfiguration")}</button>
      </div>
    </div>
  );
}

type PerformanceRangeKey = "today" | "yesterday" | "7d" | "30d" | "90d" | "all";
type DataDashboardView = "performance" | "ai_usage";

const performanceRangeOptions: PerformanceRangeKey[] = ["today", "yesterday", "7d", "30d", "90d", "all"];

function DataDashboardPage({
  account,
  accounts,
  marketAssets,
  watchlist,
  symbol,
  refreshRevision,
  onOpenAccountSettings,
  onSyncHistory
}: {
  account: AccountSummary | null;
  accounts: AccountSummary[];
  marketAssets: MarketAssetsSummary | null;
  watchlist: string[];
  symbol: string;
  refreshRevision: string;
  onOpenAccountSettings: () => void;
  onSyncHistory: () => void;
}) {
  const { t } = useTranslation(["common", "trading"]);
  const [dashboardView, setDashboardView] = useState<DataDashboardView>("performance");
  const [range, setRange] = useState<PerformanceRangeKey>("30d");
  const [selectedAccountId, setSelectedAccountId] = useState(account?.id ?? accounts[0]?.id ?? "");
  const [selectedSymbol, setSelectedSymbol] = useState("");
  const [summary, setSummary] = useState<AccountPerformanceSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!selectedAccountId && account?.id) setSelectedAccountId(account.id);
  }, [account?.id, selectedAccountId]);

  const accountOptions = useMemo(() => {
    const list = [...accounts];
    if (account && !list.some((item) => item.id === account.id)) list.unshift(account);
    return list;
  }, [account, accounts]);
  const selectedAccount = accountOptions.find((item) => item.id === selectedAccountId) ?? account ?? accountOptions[0] ?? null;
  const symbolOptions = useMemo(() => [...new Set([symbol, ...watchlist].filter(Boolean))], [symbol, watchlist]);
  const refresh = useCallback(async () => {
    if (!selectedAccount) {
      setSummary(null);
      return;
    }
    setLoading(true);
    setError("");
    const requestWindow = performanceRangeWindow(range);
    try {
      const result = await fetchAccountPerformanceSummary({
        accountId: selectedAccount.id,
        environment: selectedAccount.environment as "demo" | "live",
        instId: selectedSymbol || null,
        startTime: requestWindow.startTime,
        endTime: requestWindow.endTime
      });
      setSummary(result);
      if (!result) setError(t("common:performanceDesktopOnly"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("load account performance summary failed", err);
      setError(message);
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [range, selectedAccount, selectedSymbol, t]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshRevision]);

  const totals = summary?.totals;
  const attribution = summary?.attribution ?? [];
  const warnings = summary?.coverage.warnings ?? [];
  const generatedAtText = summary?.generatedAt ? formatClock(summary.generatedAt) : "--";

  if (dashboardView === "ai_usage") {
    return (
      <AiTokenUsageDashboardPage
        refreshRevision={refreshRevision}
        onViewChange={setDashboardView}
      />
    );
  }

  if (!selectedAccount) {
    return (
      <div className="data-dashboard data-dashboard-empty">
        <DataDashboardViewTabs value={dashboardView} onChange={setDashboardView} />
        <div className="data-empty-card">
          <LayoutDashboard size={34} />
          <strong>{t("common:performanceNeedsAccount")}</strong>
          <span>{t("common:performanceNeedsAccountDescription")}</span>
          <button className="primary-action" onClick={onOpenAccountSettings}>{t("common:configureAccount")}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="data-dashboard">
      {/* One toolbar carries view, scope, range, and actions. Previously these
          were four stacked bands that pushed the first number below the fold. */}
      <header className="data-toolbar">
        <DataDashboardViewTabs value={dashboardView} onChange={setDashboardView} />
        <span className="data-toolbar__divider" aria-hidden="true" />
        <div className="data-toolbar__scope">
          <TerminalSelect
            ariaLabel={t("common:selectAccount")}
            value={selectedAccountId}
            options={accountOptions.map((item) => ({
              value: item.id,
              label: `${item.name} ${t(item.environment === "live" ? "common:live" : "common:demo")}`
            }))}
            onChange={setSelectedAccountId}
            preserveOptionLabels
          />
          <TerminalSelect
            ariaLabel={t("common:selectMarket")}
            value={selectedSymbol}
            options={[{ value: "", label: t("common:allMarkets") }, ...symbolOptions.map((item) => ({ value: item, label: item }))]}
            onChange={setSelectedSymbol}
          />
        </div>
        <div className="data-range-tabs" role="tablist" aria-label={t("common:performanceTimeRange")}>
          {performanceRangeOptions.map((item) => (
            <button className={range === item ? "active" : ""} onClick={() => setRange(item)} key={item} role="tab" aria-selected={range === item}>
              {t(`common:range_${item}`)}
            </button>
          ))}
        </div>
        <div className="data-toolbar__actions">
          <button onClick={() => void refresh()} disabled={loading} title={t("common:refresh")} aria-label={t("common:refresh")}>
            <RefreshCw size={14} className={loading ? "spin" : undefined} />
          </button>
          <button onClick={onSyncHistory} title={t("common:syncHistory")} aria-label={t("common:syncHistory")}>
            <History size={14} />
          </button>
        </div>
      </header>

      {(error || warnings.length > 0) && (
        <div className={clsx("data-warning", error && "negative")}>
          <CircleAlert size={15} />
          <span>{error || `${warnings.slice(0, 2).join("; ")}${warnings.length > 2 ? ` ${t("common:moreWarnings", { count: warnings.length })}` : ""}`}</span>
        </div>
      )}

      {/* Cumulative return is the answer this page exists to give, so it leads at
          display size while the remaining five read as supporting facts. */}
      <section className="data-headline">
        <div className={clsx("data-headline__lead", `is-${toneByNumber(totals?.returnPct)}`)}>
          <span>{t("common:cumulativeReturn")}</span>
          <strong>{formatSignedPercent(totals?.returnPct)}</strong>
          <small>{t("common:netPnl", { defaultValue: t("trading:netPnl") })} {formatSignedUsdt(totals?.netPnl)}</small>
        </div>
        <div className="data-headline__support">
          <DataMetric label={t("common:currentAccountEquity")} value={formatPerformanceUsdt(totals?.currentEquity)} />
          <DataMetric label={t("common:maximumDrawdown")} value={formatPercent(totals?.maxDrawdownPct)} tone={totals?.maxDrawdownPct ? "drawdown" : "neutral"} />
          <DataMetric label={t("common:winRate")} value={formatPercent(totals?.winRatePct)} />
          <DataMetric label={t("trading:fees")} value={formatPerformanceUsdt(totals?.fees)} tone="muted" />
        </div>
      </section>

      <section className="data-main-grid">
        <div className="data-panel data-chart-panel">
          <div className="data-panel-head">
            <div>
              <strong>{t("common:accountEquityCurve")}</strong>
              <span className="data-chart-legend">
                <i className="equity" />{t("common:accountEquityLeftAxis")}
                <i className="return" />{t("common:cumulativeReturnRightAxis")}
                <i className="drawdown" />{t("common:drawdownRightAxis")}
              </span>
            </div>
            <span>{t("common:pointCount", { count: summary?.equityCurve.length ?? 0 })}</span>
          </div>
          <PerformanceEquityChart summary={summary} loading={loading} />
        </div>

        <SourcePerformanceTable summary={summary} attribution={attribution} />
      </section>

      {/* Two detail slots instead of three: the daily rhythm, and one panel that
          switches between per-market ranking and position extremes. */}
      <section className="data-secondary-grid">
        <MonthlyPnlCalendar items={summary?.dailyPnl ?? []} />
        <DetailBreakdownPanel items={summary?.symbolBreakdown ?? []} summary={summary} marketAssets={marketAssets} />
      </section>

      <footer className="data-dashboard-footer">
        <span>{t("common:dataUpdatedAt", { time: generatedAtText })}</span>
        <span>{t(selectedAccount.environment === "live" ? "common:live" : "common:demo")} · {t(`common:range_${range}`)}</span>
      </footer>
    </div>
  );
}

function DataDashboardViewTabs({ value, onChange }: { value: DataDashboardView; onChange: (value: DataDashboardView) => void }) {
  const { t } = useTranslation("common");
  return (
    <div className="data-view-tabs" role="tablist" aria-label={t("dataDashboardViews")}>
      <button type="button" role="tab" aria-selected={value === "performance"} className={value === "performance" ? "active" : ""} onClick={() => onChange("performance")}>
        <LayoutDashboard size={14} />{t("accountPerformance")}
      </button>
      <button type="button" role="tab" aria-selected={value === "ai_usage"} className={value === "ai_usage" ? "active" : ""} onClick={() => onChange("ai_usage")}>
        <Bot size={14} />{t("aiUsage")}
      </button>
    </div>
  );
}

function formatDashboardTokens(value: number | undefined) {
  const tokens = Math.max(0, Number(value) || 0);
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 1 : 2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}K`;
  return formatLocalizedNumber(Math.round(tokens));
}

function AiTokenUsageDashboardPage({
  refreshRevision,
  onViewChange
}: {
  refreshRevision: string;
  onViewChange: (value: DataDashboardView) => void;
}) {
  const { t } = useTranslation("common");
  const [summary, setSummary] = useState<AiTokenUsageDashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await loadAiTokenUsageSummary();
      setSummary(result);
      if (!result) setError(t("aiUsageDesktopOnly"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("load ai token usage summary failed", err);
      setError(message);
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshRevision]);

  const periods = [
    [t("today"), summary?.today],
    [t("yesterday"), summary?.yesterday],
    [t("range_7d"), summary?.sevenDays]
  ] as const;
  const hasTrackedUsage = (summary?.sevenDays.turnCount ?? 0) > 0;
  const partialTurnCount = summary?.sevenDays.partialTurnCount ?? 0;
  const unreportedTurnCount = summary?.sevenDays.unreportedTurnCount ?? 0;

  return (
    <div className="data-dashboard ai-usage-dashboard">
      {/* Same single-line toolbar as the performance view, so switching views
          does not restructure the page under the pointer. */}
      <header className="data-toolbar">
        <DataDashboardViewTabs value="ai_usage" onChange={onViewChange} />
        <span className="data-toolbar__divider" aria-hidden="true" />
        <span className="data-toolbar__note">{t("aiUsageDescription")}</span>
        <div className="data-toolbar__actions">
          <button type="button" onClick={() => void refresh()} disabled={loading} title={t("refresh")} aria-label={t("refresh")}>
            <RefreshCw size={14} className={loading ? "spin" : undefined} />
          </button>
        </div>
      </header>

      {error ? <div className="data-warning negative"><CircleAlert size={15} /><span>{error}</span></div> : null}
      {!error && (partialTurnCount > 0 || unreportedTurnCount > 0) ? (
        <div className="data-warning"><CircleAlert size={15} /><span>{t("tokenUsageIncomplete", { partial: partialTurnCount, unreported: unreportedTurnCount })}</span></div>
      ) : null}

      <section className="ai-usage-period-strip" aria-label={t("tokenUsageOverview")}>
        {periods.map(([label, period]) => (
          <article key={label}>
            <div><span>{label}</span><small>{t("sessionTurnCount", { sessions: period?.sessionCount ?? 0, turns: period?.turnCount ?? 0 })}</small></div>
            <strong>{formatDashboardTokens(period?.usage.totalTokens)}{(period?.partialTurnCount ?? 0) + (period?.unreportedTurnCount ?? 0) > 0 ? "+" : ""}</strong>
            <dl>
              <div><dt>{t("input")}</dt><dd>{formatDashboardTokens(period?.usage.inputTokens)}</dd></div>
              <div><dt>{t("output")}</dt><dd>{formatDashboardTokens(period?.usage.outputTokens)}</dd></div>
              <div><dt>{t("cacheReadIncluded")}</dt><dd>{period?.coverage.cacheRead ? formatDashboardTokens(period.usage.cacheReadTokens) : "--"}</dd></div>
            </dl>
          </article>
        ))}
      </section>

      <section className="data-panel ai-usage-model-panel">
        <div className="data-panel-head">
          <div><strong>{t("usageByModel")}</strong><span>{t("usageByModelDescription")}</span></div>
          <span>{t("modelCount", { count: summary?.byModel.length ?? 0 })}</span>
        </div>
        {loading && !summary ? (
          <div className="data-chart-empty"><Loader2 className="spin" size={20} />{t("calculatingAiUsage")}</div>
        ) : !hasTrackedUsage ? (
          <div className="ai-usage-empty">
            <Bot size={24} />
            <strong>{t("noTokenRecords")}</strong>
            <span>{t("noTokenRecordsDescription")}</span>
          </div>
        ) : (
          <div className="ai-usage-table-wrap">
            <table className="ai-usage-table">
              <thead><tr><th>{t("model")}</th><th>{t("today")}</th><th>{t("yesterday")}</th><th>{t("range_7d")}</th><th>{t("sevenDayInputOutput")}</th><th>{t("turns")}</th></tr></thead>
              <tbody>
                {summary?.byModel.map((item) => (
                  <tr key={`${item.provider}:${item.modelId}:${item.model}`}>
                    <td><strong>{item.modelName || item.model}</strong><small>{item.provider} · {item.model}</small></td>
                    <td>{formatDashboardTokens(item.today.usage.totalTokens)}</td>
                    <td>{formatDashboardTokens(item.yesterday.usage.totalTokens)}</td>
                    <td><strong>{formatDashboardTokens(item.sevenDays.usage.totalTokens)}{item.sevenDays.partialTurnCount + item.sevenDays.unreportedTurnCount > 0 ? "+" : ""}</strong></td>
                    <td>{formatDashboardTokens(item.sevenDays.usage.inputTokens)} / {formatDashboardTokens(item.sevenDays.usage.outputTokens)}</td>
                    <td>{item.sevenDays.turnCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <footer className="data-dashboard-footer">
        <span>{t("statisticsUpdatedAt", { time: summary?.generatedAt ? formatDateTime(summary.generatedAt) : "--" })}</span>
        <span>{summary?.windowStart ? t("statisticsWindowStart", { time: formatDateTime(summary.windowStart) }) : t("waitingFirstTokenRecord")}</span>
      </footer>
    </div>
  );
}

function DataMetric({ label, value, tone }: { label: string; value: string; tone?: CellTone }) {
  return (
    <div className="data-metric">
      <span>{label}</span>
      <strong className={clsx(tone && "cell-tone", tone)}>{value}</strong>
    </div>
  );
}

function PerformanceEquityChart({ summary, loading }: { summary: AccountPerformanceSummary | null; loading: boolean }) {
  const { t } = useTranslation("common");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const points = summary?.equityCurve ?? [];
  const width = 1280;
  const height = 370;
  const padLeft = 34;
  const padRight = 36;
  const padTop = 24;
  const padBottom = 54;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const maxEquity = Math.max(1, ...points.map((item) => item.equity));
  const pctValues = points.flatMap((item) => [item.cumulativeReturnPct, -item.drawdownPct]);
  const pctMin = Math.min(-10, ...pctValues);
  const pctMax = Math.max(10, ...pctValues);
  const pctRange = Math.max(1, pctMax - pctMin);
  const x = (index: number) => padLeft + (points.length <= 1 ? 0 : index / (points.length - 1)) * plotWidth;
  const yEquity = (value: number) => padTop + (1 - value / maxEquity) * plotHeight;
  const yPct = (value: number) => padTop + ((pctMax - value) / pctRange) * plotHeight;
  const yZero = yPct(0);
  const equityCoords = points.map((item, index) => [x(index), yEquity(item.equity)] as [number, number]);
  const returnCoords = points.map((item, index) => [x(index), yPct(item.cumulativeReturnPct)] as [number, number]);
  const drawdownCoords = points.map((item, index) => [x(index), yPct(-item.drawdownPct)] as [number, number]);
  const equityPath = smoothSvgPath(equityCoords);
  const returnPath = smoothSvgPath(returnCoords);
  const drawdownLinePath = smoothSvgPath(drawdownCoords);
  const drawdownAreaPath = points.length
    ? `M ${x(0)} ${yZero} ${drawdownLinePath.replace(/^M\s*/, "L ")} L ${x(points.length - 1)} ${yZero} Z`
    : "";
  const overviewCoords = points.map((item, index) => {
    const overviewX = padLeft + (points.length <= 1 ? 0 : index / (points.length - 1)) * plotWidth;
    const overviewY = height - 22 - (item.equity / maxEquity) * 28;
    return [overviewX, overviewY] as [number, number];
  });
  const overviewPath = smoothSvgPath(overviewCoords);
  const hover = hoverIndex !== null ? points[hoverIndex] : points.at(-1);
  const latest = points.at(-1);
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => Math.round(ratio * Math.max(points.length - 1, 0)));
  const equityTicks = [1, 0.75, 0.5, 0.25, 0].map((ratio) => maxEquity * ratio);
  const pctTicks = [pctMax, pctMax - pctRange * 0.25, pctMax - pctRange * 0.5, pctMax - pctRange * 0.75, pctMin];

  if (loading) {
    return <div className="data-chart-empty"><Loader2 className="spin" size={20} />{t("loadingAccountPerformance")}</div>;
  }
  if (!points.length) {
    return <div className="data-chart-empty">{t("accountEquityCurveEmpty")}</div>;
  }

  return (
    <div className="data-chart-wrap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={t("accountEquityCurve")}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
          setHoverIndex(Math.round(ratio * (points.length - 1)));
        }}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <defs>
          <linearGradient id="dataEquityLine" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#8b5cf6" />
            <stop offset="100%" stopColor="#a78bfa" />
          </linearGradient>
          <linearGradient id="dataReturnLine" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#38bdf8" />
            <stop offset="100%" stopColor="#67e8f9" />
          </linearGradient>
          <linearGradient id="dataDrawdownFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(248,113,113,0.02)" />
            <stop offset="100%" stopColor="rgba(248,113,113,0.34)" />
          </linearGradient>
        </defs>
        {equityTicks.map((tick, index) => (
          <g key={`equity-${index}`}>
            <line x1={padLeft} x2={width - padRight} y1={yEquity(tick)} y2={yEquity(tick)} />
            <text className="data-chart-axis left" x={padLeft - 8} y={yEquity(tick) + 4}>{formatAxisNumber(tick)}</text>
          </g>
        ))}
        {pctTicks.map((tick, index) => (
          <text className="data-chart-axis right" x={width - padRight + 8} y={yPct(tick) + 4} key={`pct-${index}`}>{tick.toFixed(0)}%</text>
        ))}
        {xTicks.map((index) => (
          <text className="data-chart-axis date" x={x(index)} y={height - 42} key={`date-${index}`}>{formatShortMonthDay(points[index]?.time)}</text>
        ))}
        <line className="data-chart-zero" x1={padLeft} x2={width - padRight} y1={yZero} y2={yZero} />
        <path className="data-drawdown-area" d={drawdownAreaPath} />
        <path className="data-drawdown-line" d={drawdownLinePath} />
        <path className="data-equity-line" d={equityPath} />
        <path className="data-return-line" d={returnPath} />
        <path className="data-overview-line" d={overviewPath} />
        <rect className="data-overview-window" x={padLeft} y={height - 48} width={plotWidth} height={30} rx={4} />
        {hover && hoverIndex !== null && (
          <>
            <line className="data-chart-cursor" x1={x(hoverIndex)} x2={x(hoverIndex)} y1={padTop} y2={height - padBottom} />
            <circle className="data-chart-dot" cx={x(hoverIndex)} cy={yEquity(hover.equity)} r={4} />
            <circle className="data-chart-dot return" cx={x(hoverIndex)} cy={yPct(hover.cumulativeReturnPct)} r={3.5} />
          </>
        )}
        {latest && (
          <>
            <text className="data-chart-badge equity" x={width - padRight + 4} y={yEquity(latest.equity)}>{formatAxisNumber(latest.equity)}</text>
            <text className="data-chart-badge return" x={width - padRight + 4} y={yPct(latest.cumulativeReturnPct)}>{formatSignedPercent(latest.cumulativeReturnPct)}</text>
            <text className="data-chart-badge drawdown" x={width - padRight + 4} y={yPct(-latest.drawdownPct)}>-{formatPercent(latest.drawdownPct)}</text>
          </>
        )}
      </svg>
      {hover && (
        <div className="data-chart-tip">
          <span>{formatDateTime(hover.time)}</span>
          <div><i className="equity" />{t("accountEquity")} <strong>{formatPerformanceUsdt(hover.equity)}</strong></div>
          <div><i className="return" />{t("cumulativeReturn")} <strong>{formatSignedPercent(hover.cumulativeReturnPct)}</strong></div>
          <div><i className="drawdown" />{t("drawdown")} <strong>-{formatPercent(hover.drawdownPct)}</strong></div>
        </div>
      )}
    </div>
  );
}

function smoothSvgPath(coords: Array<[number, number]>) {
  if (coords.length === 0) return "";
  if (coords.length === 1) return `M ${coords[0][0]} ${coords[0][1]}`;
  const smoothing = 0.18;
  const line = (pointA: [number, number], pointB: [number, number]) => {
    const lengthX = pointB[0] - pointA[0];
    const lengthY = pointB[1] - pointA[1];
    return { length: Math.hypot(lengthX, lengthY), angle: Math.atan2(lengthY, lengthX) };
  };
  const controlPoint = (current: [number, number], previous: [number, number] | undefined, next: [number, number] | undefined, reverse = false) => {
    const p = previous ?? current;
    const n = next ?? current;
    const o = line(p, n);
    const angle = o.angle + (reverse ? Math.PI : 0);
    const length = o.length * smoothing;
    return [current[0] + Math.cos(angle) * length, current[1] + Math.sin(angle) * length] as [number, number];
  };
  return coords.reduce((path, point, index, points) => {
    if (index === 0) return `M ${point[0]} ${point[1]}`;
    const cps = controlPoint(points[index - 1], points[index - 2], point);
    const cpe = controlPoint(point, points[index - 1], points[index + 1], true);
    return `${path} C ${cps[0]} ${cps[1]}, ${cpe[0]} ${cpe[1]}, ${point[0]} ${point[1]}`;
  }, "");
}

function SourcePerformanceTable({
  summary,
  attribution
}: {
  summary: AccountPerformanceSummary | null;
  attribution: AccountPerformanceSummary["attribution"];
}) {
  const { t } = useTranslation(["common", "trading"]);
  const sourceRows = [
    { label: "AI", item: attribution.find((item) => item.operator === "ai") },
    { label: t("common:manualOperator"), item: attribution.find((item) => item.operator === "user") },
    { label: t("common:unattributed"), item: attribution.find((item) => item.operator === "unknown") }
  ];
  const totalNetReturnPct = summary?.totals.startEquity && Math.abs(summary.totals.startEquity) > Number.EPSILON
    ? summary.totals.netPnl / summary.totals.startEquity * 100
    : null;
  const totalRow = summary?.totals
    ? {
        label: t("common:total"),
        netPnl: summary.totals.netPnl,
        returnPct: totalNetReturnPct,
        winRatePct: summary.totals.winRatePct,
        tradeCount: summary.totals.tradeCount,
        fees: summary.totals.fees
      }
    : null;

  return (
    <div className="data-panel data-source-panel">
      <div className="data-panel-head">
        <strong>{t("common:performanceBySource")}</strong>
        <span
          title={summary?.coverage.attributionComplete ? undefined : t("common:attributionCoveragePartialDescription")}
        >
          {summary?.coverage.attributionComplete ? t("common:attributionCoverageComplete") : t("common:attributionCoveragePartial")}
        </span>
      </div>
      <table className="data-table data-table--ranked">
        <thead>
          <tr>
            <th>{t("common:source")}</th>
            <th>{t("trading:netPnl")}</th>
            <th className="is-secondary">{t("common:winRate")}</th>
            <th className="is-secondary">{t("common:tradeCount")}</th>
          </tr>
        </thead>
        <tbody>
          {sourceRows.map(({ label, item }) => (
            <tr key={label}>
              <td>
                <span className="data-source-name">{label}</span>
                <small className={clsx("cell-tone", toneByNumber(item?.returnPct))}>{formatSignedPercent(item?.returnPct)}</small>
              </td>
              <td className={clsx("is-primary cell-tone", toneByNumber(item?.netPnl))}>{formatSignedUsdt(item?.netPnl)}</td>
              <td className="is-secondary">{formatPercent(item?.winRatePct)}</td>
              <td className="is-secondary">{(item?.tradeCount ?? 0).toLocaleString("en-US")}</td>
            </tr>
          ))}
          <tr className="total">
            <td>
              <span className="data-source-name">{t("common:total")}</span>
              <small className={clsx("cell-tone", toneByNumber(totalRow?.returnPct))}>{formatSignedPercent(totalRow?.returnPct)}</small>
            </td>
            <td className={clsx("is-primary cell-tone", toneByNumber(totalRow?.netPnl))}>{formatSignedUsdt(totalRow?.netPnl)}</td>
            <td className="is-secondary">{formatPercent(totalRow?.winRatePct)}</td>
            <td className="is-secondary">{(totalRow?.tradeCount ?? 0).toLocaleString("en-US")}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** Market ranking and position highlights are both drill-down detail, so they
 *  share one panel and one screen slot instead of competing for two. */
function DetailBreakdownPanel({
  items,
  summary,
  marketAssets
}: {
  items: AccountPerformanceSummary["symbolBreakdown"];
  summary: AccountPerformanceSummary | null;
  marketAssets: MarketAssetsSummary | null;
}) {
  const { t } = useTranslation(["common", "trading"]);
  const [view, setView] = useState<"markets" | "highlights">("markets");
  return (
    <div className="data-panel data-breakdown-panel">
      <div className="data-panel-head">
        <div className="data-breakdown-switch" role="tablist" aria-label={t("common:marketRanking")}>
          <button type="button" role="tab" aria-selected={view === "markets"} className={view === "markets" ? "active" : ""} onClick={() => setView("markets")}>
            {t("common:marketRanking")}
          </button>
          <button type="button" role="tab" aria-selected={view === "highlights"} className={view === "highlights" ? "active" : ""} onClick={() => setView("highlights")}>
            {t("common:positionHighlights")}
          </button>
        </div>
        <span>
          {view === "markets"
            ? t("common:sortedByNetPnl")
            : t("common:episodeCount", { count: summary?.coverage.episodesCount ?? 0 })}
        </span>
      </div>
      {view === "markets"
        ? <SymbolRankingBody items={items} marketAssets={marketAssets} />
        : <PositionHighlightsBody summary={summary} marketAssets={marketAssets} />}
    </div>
  );
}

function SymbolRankingBody({ items, marketAssets }: { items: AccountPerformanceSummary["symbolBreakdown"]; marketAssets: MarketAssetsSummary | null }) {
  const { t } = useTranslation(["common", "trading"]);
  return (
    <>
      {items.length > 0 ? (
        <table className="data-table data-table--ranked">
          <thead>
            <tr>
              <th>{t("trading:tradingPair")}</th>
              <th>{t("trading:netPnl")}</th>
              <th className="is-secondary">{t("common:winRate")}</th>
              <th className="is-secondary">{t("common:tradeCount")}</th>
              <th className="is-secondary">{t("trading:fees")}</th>
            </tr>
          </thead>
          <tbody>
            {items.slice(0, 6).map((item) => (
              <tr key={item.instId}>
                <td><SymbolLabel symbol={item.instId} marketAssets={marketAssets} /></td>
                <td className={clsx("is-primary cell-tone", toneByNumber(item.netPnl))}>{formatSignedUsdt(item.netPnl)}</td>
                <td className="is-secondary">{formatPercent(item.winRatePct)}</td>
                <td className="is-secondary">{item.tradeCount.toLocaleString("en-US")}</td>
                <td className="is-secondary">{formatPerformanceUsdt(item.fees)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="data-empty-inline">{t("common:marketRankingEmpty")}</div>
      )}
    </>
  );
}

/** Daily PnL month grid. Weeks with no trading activity at all are dropped so
 *  the panel does not spend most of its height on empty cells, which was the
 *  original complaint; every day that carries data is still shown in place. */
function MonthlyPnlCalendar({ items }: { items: AccountPerformanceSummary["dailyPnl"] }) {
  const { t } = useTranslation("common");
  const calendar = buildPerformanceCalendar(items);
  const max = Math.max(1, ...items.map((item) => Math.abs(item.netPnl)));
  const weekdayLabels = Array.from({ length: 7 }, (_, index) => formatLocalizedDate(new Date(2024, 0, index + 1), { weekday: "short" }));
  // Group into weeks, then keep only weeks that contain at least one traded day.
  const weeks: Array<typeof calendar.days> = [];
  for (let i = 0; i < calendar.days.length; i += 7) weeks.push(calendar.days.slice(i, i + 7));
  const activeWeeks = weeks.filter((week) => week.some((day) => day.pnl != null));
  const visibleWeeks = activeWeeks.length > 0 ? activeWeeks : weeks;

  return (
    <div className="data-panel data-calendar-panel">
      <div className="data-panel-head">
        <strong>{t("dailyPnl")} <em>(USDT)</em></strong>
        <span>{calendar.title}</span>
      </div>
      {items.length > 0 ? (
        <>
          <div className="data-calendar-weekdays">
            {weekdayLabels.map((item) => <span key={item}>{item}</span>)}
          </div>
          <div className="data-calendar-grid">
            {visibleWeeks.flat().map((day) => {
              const intensity = day.pnl == null ? 0 : Math.min(1, Math.abs(day.pnl) / max);
              return (
                <div
                  className={clsx("data-calendar-cell", !day.inMonth && "muted", day.pnl != null && (day.pnl >= 0 ? "positive" : "negative"))}
                  style={{ "--heat": String(0.12 + intensity * 0.88) } as CSSProperties}
                  title={day.pnl == null ? day.date : t("dailyPnlTooltip", { date: day.date, pnl: formatSignedUsdt(day.pnl), count: day.tradeCount })}
                  key={day.date}
                >
                  <span>{day.day}</span>
                  {day.pnl != null && <strong>{formatCalendarPnl(day.pnl)}</strong>}
                </div>
              );
            })}
          </div>
          <div className="data-calendar-legend">
            <span><i className="positive" />{t("profitPositive")}</span>
            <span><i />{t("pnlZero")}</span>
            <span><i className="negative" />{t("lossNegative")}</span>
          </div>
        </>
      ) : (
        <div className="data-empty-inline">{t("dailyPnlEmpty")}</div>
      )}
    </div>
  );
}

function PositionHighlightsBody({ summary, marketAssets }: { summary: AccountPerformanceSummary | null; marketAssets: MarketAssetsSummary | null }) {
  const { t } = useTranslation(["common", "trading"]);
  const items = [
    { label: t("common:largestProfit"), item: summary?.highlights.bestEpisode ?? null, value: summary?.highlights.bestEpisode ? formatSignedUsdt(summary.highlights.bestEpisode.netPnl) : "--" },
    { label: t("common:largestLoss"), item: summary?.highlights.worstEpisode ?? null, value: summary?.highlights.worstEpisode ? formatSignedUsdt(summary.highlights.worstEpisode.netPnl) : "--" },
    { label: t("common:longestHolding"), item: summary?.highlights.longestEpisode ?? null, value: summary?.highlights.longestEpisode ? formatDuration(summary.highlights.longestEpisode.openTime, summary.highlights.longestEpisode.closeTime ?? summary.highlights.longestEpisode.openTime) : "--" },
    { label: t("common:shortestHolding"), item: summary?.highlights.shortestEpisode ?? null, value: summary?.highlights.shortestEpisode ? formatDuration(summary.highlights.shortestEpisode.openTime, summary.highlights.shortestEpisode.closeTime ?? summary.highlights.shortestEpisode.openTime) : "--" }
  ];
  return (
    <div className="data-highlight-list">
        {items.map(({ label, item, value }) => (
          <div className="data-highlight-row" key={label}>
            <div>
              <span>{label}</span>
              <strong className={clsx(item && "cell-tone", item && toneByNumber(item.netPnl))}>{value}</strong>
            </div>
            {item ? <SymbolLabel symbol={item.instId} marketAssets={marketAssets} secondary={`${item.side === "short" ? t("trading:short") : t("trading:long")} · ${formatDateTime(item.openTime)}`} /> : <small>{t("common:noClosedPositions")}</small>}
          </div>
        ))}
    </div>
  );
}

function localDateKey(time: number) {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatAxisNumber(value?: number | null) {
  if (!Number.isFinite(value)) return "--";
  const numeric = Number(value);
  if (Math.abs(numeric) >= 1_000_000) return `${(numeric / 1_000_000).toFixed(1)}M`;
  if (Math.abs(numeric) >= 10_000) return numeric.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return numeric.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatShortMonthDay(time?: number | null) {
  if (!Number.isFinite(time)) return "";
  const date = new Date(Number(time));
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

function formatClock(time?: number | null) {
  if (!Number.isFinite(time)) return "--";
  const date = new Date(Number(time));
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function buildPerformanceCalendar(items: AccountPerformanceSummary["dailyPnl"]) {
  const byDate = new Map(items.map((item) => [item.date, item]));
  const latest = items.at(-1)?.date ?? localDateKey(Date.now());
  const [yearText, monthText] = latest.split("-");
  const year = Number(yearText) || new Date().getFullYear();
  const month = Number(monthText) || new Date().getMonth() + 1;
  const first = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const leading = (first.getDay() + 6) % 7;
  const days: Array<{ date: string; day: number; inMonth: boolean; pnl: number | null; tradeCount: number }> = [];
  for (let i = 0; i < leading; i += 1) {
    const date = new Date(year, month - 1, 1 - (leading - i));
    const key = localDateKey(date.getTime());
    const item = byDate.get(key);
    days.push({ date: key, day: date.getDate(), inMonth: false, pnl: item?.netPnl ?? null, tradeCount: item?.tradeCount ?? 0 });
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const item = byDate.get(key);
    days.push({ date: key, day, inMonth: true, pnl: item?.netPnl ?? null, tradeCount: item?.tradeCount ?? 0 });
  }
  while (days.length % 7 !== 0) {
    const date = new Date(year, month - 1, daysInMonth + (days.length % 7 === 0 ? 0 : days.length - leading - daysInMonth + 1));
    const key = localDateKey(date.getTime());
    const item = byDate.get(key);
    days.push({ date: key, day: date.getDate(), inMonth: false, pnl: item?.netPnl ?? null, tradeCount: item?.tradeCount ?? 0 });
  }
  return { title: formatLocalizedDate(new Date(year, month - 1, 1), { year: "numeric", month: "long" }), days };
}

function formatCalendarPnl(value?: number | null) {
  if (!Number.isFinite(value)) return "--";
  const numeric = Number(value);
  const sign = numeric >= 0 ? "+" : "";
  return `${sign}${numeric.toLocaleString("en-US", { maximumFractionDigits: Math.abs(numeric) >= 100 ? 0 : 2 })}`;
}

function performanceRangeWindow(key: PerformanceRangeKey) {
  const now = new Date();
  const endTime = Date.now();
  if (key === "all") return { label: "全部", startTime: null, endTime: null };
  const start = new Date(now);
  if (key === "today") {
    start.setHours(0, 0, 0, 0);
    return { label: "今天", startTime: start.getTime(), endTime };
  }
  if (key === "yesterday") {
    const end = new Date(now);
    end.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    return { label: "昨天", startTime: start.getTime(), endTime: end.getTime() - 1 };
  }
  const days = key === "7d" ? 7 : key === "90d" ? 90 : 30;
  start.setDate(start.getDate() - days);
  return { label: `最近${days}天`, startTime: start.getTime(), endTime };
}

function formatPerformanceUsdt(value?: number | null) {
  if (!Number.isFinite(value)) return "--";
  return `${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })} USDT`;
}

function formatSignedUsdt(value?: number | null) {
  if (!Number.isFinite(value)) return "--";
  const numeric = Number(value);
  return `${numeric >= 0 ? "+" : ""}${numeric.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDT`;
}

function formatPercent(value?: number | null) {
  if (!Number.isFinite(value)) return "--";
  return `${Number(value).toFixed(2)}%`;
}

function formatSignedPercent(value?: number | null) {
  if (!Number.isFinite(value)) return "--";
  const numeric = Number(value);
  return `${numeric >= 0 ? "+" : ""}${numeric.toFixed(2)}%`;
}

function OpenSourceLicensesModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("settings");
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void invokeDesktop<string>("open_source_licenses")
      .then((next) => {
        if (!active) return;
        if (next) setHtml(next);
        else setFailed(true);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => { active = false; };
  }, []);
  return (
    <ModalShell
      title={t("openSourceLicenses")}
      description={t("openSourceLicensesDescription")}
      className="licenses-modal"
      onClose={onClose}
    >
      {failed ? (
        <p className="settings-status-text">{t("licensesLoadFailed")}</p>
      ) : html === null ? (
        <p className="settings-status-text">{t("licensesLoading")}</p>
      ) : (
        <iframe className="licenses-frame" title={t("openSourceLicenses")} srcDoc={html} sandbox="allow-popups" />
      )}
    </ModalShell>
  );
}

function GeneralSettingsPane({ onNotify }: { onNotify: (notification: Omit<AppNotification, "id" | "createdAt">) => void }) {
  const { t, i18n } = useTranslation(["settings", "common"]);
  const [preference, setPreference] = useState<LanguagePreference>(() => languagePreference());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [licensesOpen, setLicensesOpen] = useState(false);
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    setPreference(languagePreference());
  }, [i18n.language]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let active = true;
    void import("@tauri-apps/api/app").then(({ getVersion }) => getVersion().then((version) => {
      if (active) setAppVersion(version);
    }).catch(() => undefined));
    return () => { active = false; };
  }, []);

  const updateLanguage = useCallback(async (next: LanguagePreference) => {
    setPreference(next);
    setBusy(true);
    setStatus("");
    try {
      await saveLanguagePreference(next);
      setStatus(t("settings:saved"));
      onNotify({ kind: "success", title: t("settings:saved"), message: t("settings:noRestart") });
    } catch (error) {
      logger.error("save language preference failed", error);
      setStatus(t("settings:saveFailed"));
      onNotify({ kind: "error", title: t("settings:saveFailed"), message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }, [onNotify, t]);

  const selected = LANGUAGE_OPTIONS.find((option) => option.value === preference) ?? LANGUAGE_OPTIONS[0];
  return (
    <div className="general-settings-pane">
      <section className="settings-section">
        <div>
          <strong>{t("settings:languageTitle")}</strong>
          <span>{t("settings:languageDescription")}</span>
        </div>
        <span className="settings-status-text">{status || t("settings:noRestart")}</span>
      </section>
      <div className="language-preference-grid" role="radiogroup" aria-label={t("common:language")}>
        {LANGUAGE_OPTIONS.map((option) => (
          <label className={clsx("language-option", preference === option.value && "active", busy && "busy")} key={option.value}>
            <input type="radio" name="desic-language" value={option.value} checked={preference === option.value} disabled={busy} onChange={() => void updateLanguage(option.value)} />
            <span className="language-option-copy"><strong>{option.value === "system" ? t("settings:followSystem") : option.nativeLabel}</strong><small>{option.value === "system" ? option.englishLabel : `${option.englishLabel} · ${option.value}`}</small></span>
            <span className="language-option-check" aria-hidden="true">{preference === option.value ? "✓" : ""}</span>
          </label>
        ))}
      </div>
      <div className="language-preference-note">
        <strong>{t("settings:effectiveLanguage")}</strong>
        <span>{selected.value === "system" ? t("settings:followSystem") : selected.nativeLabel} · {resolvedLocale()}</span>
        <small>{t("settings:fallbackNotice")}</small>
      </div>
      <section className="settings-section">
        <div>
          <strong>{t("settings:about")}</strong>
          <span>{appVersion ? `${t("settings:aboutDescription")} v${appVersion}` : t("settings:aboutDescription")}</span>
        </div>
        <button type="button" className="settings-secondary-button" onClick={() => setLicensesOpen(true)}>
          {t("settings:openSourceLicenses")}
        </button>
      </section>
      {licensesOpen ? <OpenSourceLicensesModal onClose={() => setLicensesOpen(false)} /> : null}
    </div>
  );
}

function SettingsWorkspacePage({
  activeTab,
  accounts,
  selectedAccountId,
  watchlist,
  marketAssets,
  symbolSyncStatus,
  onTabChange,
  onSelectAccount,
  onAccountsChange,
  onHistorySync,
  onProxySaved,
  onNotify,
  onAccountValidated,
  onAiValidated
}: {
  activeTab: SettingsTab;
  accounts: AccountSummary[];
  selectedAccountId: string | null;
  watchlist: string[];
  marketAssets: MarketAssetsSummary | null;
  symbolSyncStatus: Record<string, string>;
  onTabChange: (tab: SettingsTab) => void;
  onSelectAccount: (id: string | null) => void;
  onAccountsChange: (accounts: AccountSummary[]) => void;
  onHistorySync: (account: AccountSummary) => void;
  onProxySaved: (summary: ProxyConfigSummary) => void;
  onNotify: (notification: Omit<AppNotification, "id" | "createdAt">) => void;
  onAccountValidated?: () => void;
  onAiValidated?: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [maintenance, setMaintenance] = useState<StorageMaintenanceResult | null>(null);
  const [storageSnapshot, setStorageSnapshot] = useState<StorageStatusResult | null>(null);
  const [status, setStatus] = useState(() => t("settings:readingStorageStatus"));
  const [busy, setBusy] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [watchBusy, setWatchBusy] = useState(false);
  const tabItems = useMemo(() => ([
    ["general", t("settings:general"), t("settings:generalDescription")],
    ["account", t("settings:account"), t("settings:accountDescription")],
    ["proxy", t("settings:proxy"), t("settings:proxyDescription")],
    ["ai", t("settings:ai"), t("settings:aiDescription")],
    ["prompt", t("settings:prompt"), t("settings:promptDescription")],
    ["skills", t("settings:skills"), t("settings:skillsDescription")],
    ["notifications", t("settings:notifications"), t("settings:notificationsDescription")],
    ["storage", t("settings:storage"), t("settings:storageDescription")]
  ] as Array<[SettingsTab, string, string]>), [t]);
  const activeTabMeta = tabItems.find(([tab]) => tab === activeTab) ?? tabItems[0];

  const runMaintenance = useCallback(async (silent = false) => {
    setBusy(true);
    setStatus(t("settings:maintainingStorage"));
    try {
      const result = await runStorageMaintenance();
      if (!result) {
        setStatus(t("settings:storageMaintenanceDesktopOnly"));
        return;
      }
      setMaintenance(result);
      setStorageSnapshot(null);
      setStatus(t("settings:storageMaintenanceCompleted"));
      if (!silent) {
        const deletedIntelligence = Object.values(result.deletedIntelligenceRows).reduce((sum, count) => sum + count, 0);
        onNotify({
          kind: "success",
          title: t("settings:storageMaintenanceCompleted"),
          message: t("settings:storageMaintenanceSummary", {
            kline: result.deletedKlineSyncRuns,
            messages: result.deletedAiMessages,
            intelligence: deletedIntelligence
          })
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("storage maintenance failed", error);
      setStatus(t("settings:storageMaintenanceFailed"));
      onNotify({ kind: "error", title: t("settings:storageMaintenanceFailed"), message });
    } finally {
      setBusy(false);
    }
  }, [onNotify, t]);

  const loadStorageStatus = useCallback(async () => {
    setStatusBusy(true);
    try {
      const result = await fetchStorageStatus();
      if (!result) {
        setStatus(t("settings:storageReadDesktopOnly"));
        return;
      }
      setStorageSnapshot(result);
      setStatus(t("settings:databaseStatusUpdated", { version: result.schemaVersion }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("storage status failed", error);
      setStatus(t("settings:storageStatusReadFailed"));
      onNotify({ kind: "error", title: t("settings:storageReadFailed"), message });
    } finally {
      setStatusBusy(false);
    }
  }, [onNotify, t]);

  useEffect(() => {
    if (activeTab !== "storage") return;
    let mounted = true;
    let refreshTimer: number | null = null;
    const listenerCleanup = createDeferredCleanupSlot();
    void listenKlineSync((report) => {
      if (!mounted || !["complete", "partial", "failed"].includes(report.status)) return;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        if (!mounted) return;
        setMaintenance(null);
        void loadStorageStatus();
      }, 250);
    }).then((unlisten) => listenerCleanup.settle(unlisten));
    return () => {
      mounted = false;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      listenerCleanup.dispose();
    };
  }, [activeTab, loadStorageStatus]);

  useEffect(() => {
    if (activeTab !== "storage" || maintenance || storageSnapshot || statusBusy) return;
    void loadStorageStatus();
  }, [activeTab, loadStorageStatus, maintenance, statusBusy, storageSnapshot]);

  const displayedStorage = maintenance ?? storageSnapshot;

  const tableRows = useMemo(() => {
    if (!displayedStorage) return [];
    return Object.entries(displayedStorage.rows).sort(([a], [b]) => a.localeCompare(b));
  }, [displayedStorage]);
  const assetMap = useMemo(
    () => new Map((marketAssets?.instruments ?? []).map((item) => [item.instId, item])),
    [marketAssets]
  );
  const klineRangeMap = useMemo(
    () => new Map((displayedStorage?.klineRanges ?? []).map((item) => [item.symbol, item])),
    [displayedStorage?.klineRanges]
  );
  const marketAssetCacheDir = marketAssets?.cacheDir;
  const runWatchlistIntegrity = useCallback(async () => {
    setWatchBusy(true);
    setMaintenance(null);
    setStatus(t("settings:watchlistCheckStarted"));
    try {
      await syncKlineIntegrity(watchlist, KLINE_INTEGRITY_INTERVALS, false, undefined, KLINE_REQUIRED_DAYS);
      onNotify({
        kind: "info",
        title: t("settings:watchlistCheckStarted"),
        message: t("settings:watchlistCheckStartedMessage", { count: watchlist.length })
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("watchlist integrity check failed", error, { watchlist });
      onNotify({ kind: "error", title: t("settings:watchlistCheckFailed"), message });
    } finally {
      setWatchBusy(false);
    }
  }, [onNotify, t, watchlist]);

  return (
    <div className="settings-workspace">
      <header className="settings-page-head">
        <div>
          <strong>{t("settings:title")}</strong>
          <span>{t("settings:description")}</span>
        </div>
        <div className="settings-page-current">
          <span>{t("settings:currentSection")}</span>
          <strong>{activeTabMeta[1]}</strong>
          <small>{activeTabMeta[2]}</small>
        </div>
      </header>
      <div className="settings-page-layout">
        <nav className="settings-tabs settings-page-tabs" role="tablist" aria-label={t("settings:configurationCategories")}>
          {tabItems.map(([tab, label]) => (
            <button className={activeTab === tab ? "active" : ""} onClick={() => onTabChange(tab)} key={tab}>
              {label}
            </button>
          ))}
        </nav>
        <section className="settings-tab-panel settings-page-panel">
          {activeTab === "general" && <GeneralSettingsPane onNotify={onNotify} />}
          {activeTab === "account" && (
            <AccountSettingsPane
              accounts={accounts}
              selectedAccountId={selectedAccountId}
              onSelect={onSelectAccount}
              onAccountsChange={onAccountsChange}
              onNotify={onNotify}
              onHistorySync={onHistorySync}
              onValidated={onAccountValidated}
            />
          )}
          {activeTab === "proxy" && (
            <ProxySettingsPane
              onSaved={onProxySaved}
              onNotify={onNotify}
            />
          )}
          {activeTab === "ai" && <AiSettingsPane onNotify={onNotify} onValidated={onAiValidated} />}
          {activeTab === "prompt" && <PromptSettingsPane onNotify={onNotify} />}
          {activeTab === "skills" && <SkillsSettingsPane onNotify={onNotify} />}
          {activeTab === "notifications" && <NotificationSettingsPane onNotify={onNotify} />}
          {activeTab === "storage" && (
            <div className="settings-storage-pane">
              <section className="settings-section">
                <div>
                  <strong>{t("settings:localStorage")}</strong>
                  <span>{status}</span>
                  <small>{t("settings:storageMaintenanceDescription")}</small>
                </div>
                <button className="primary-action" onClick={() => void runMaintenance(false)} disabled={busy}>
                  {busy ? t("settings:maintenanceInProgress") : t("settings:runMaintenance")}
                </button>
              </section>
              <section className="settings-section watchlist-settings-section">
                <div>
                  <strong>{t("settings:watchMarkets")}</strong>
                  <span>
                    {watchlist.length}/10 · {t("settings:resources")} {marketAssets ? `${marketAssets.iconCached}/${marketAssets.total}` : t("common:notLoaded")}
                    {marketAssets?.cacheVersion ? ` · v${marketAssets.cacheVersion}` : ""}
                    {marketAssets?.iconFailed ? ` · ${t("common:failed")} ${marketAssets.iconFailed}` : ""}
                  </span>
                  <small>{t("settings:checkCandlesDescription")}</small>
                </div>
                <button className="primary-action" onClick={() => void runWatchlistIntegrity()} disabled={watchBusy || watchlist.length === 0}>
                  {watchBusy ? t("common:checking") : t("settings:checkCandles")}
                </button>
              </section>
              <div className="settings-watchlist-grid">
                {watchlist.map((item) => {
                  const asset = assetMap.get(item);
                  const base = marketBaseFromSymbol(item, asset?.baseCcy);
                  const range = klineRangeMap.get(item);
                  const rangeShort = formatKlineRangeText(range, "short");
                  const rangeFull = formatKlineRangeText(range, "full");
                  const syncStatus = symbolSyncStatus[item];
                  const displayedRange = syncStatus && syncStatus !== "已同步" ? syncStatus : rangeShort || syncStatus || t("settings:waitingForCheck");
                  return (
                    <div className="settings-watchlist-card" key={item} title={rangeFull ? `${item}\n${rangeFull}` : item}>
                      <SymbolIcon base={base} iconPath={asset?.iconPath} cached={asset?.iconCached} cacheDir={marketAssetCacheDir} />
                      <span>{base}</span>
                      <small>{displayedRange}</small>
                      {rangeFull && (
                        <div className="settings-watchlist-tip" role="tooltip">
                          <strong>{item}</strong>
                          <span>{rangeFull}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {displayedStorage && (
                <>
                  <div className="storage-summary">
                    <div>
                      <span>{t("settings:database")}</span>
                      <strong>{formatBytes(displayedStorage.databaseBytes)}</strong>
                    </div>
                    <div>
                      <span>WAL</span>
                      <strong>{formatBytes(displayedStorage.walBytes)}</strong>
                    </div>
                    <div>
                      <span>{t("settings:reusableSpace")}</span>
                      <strong>{formatBytes(displayedStorage.reusableBytes)}</strong>
                    </div>
                    <div>
                      <span>{t("settings:schemaVersion")}</span>
                      <strong>V{displayedStorage.schemaVersion}</strong>
                    </div>
                  </div>
                  <div className="storage-path" title={displayedStorage.databasePath}>{displayedStorage.databasePath}</div>
                  <div className="storage-table-list">
                    {tableRows.map(([name, count]) => (
                      <div key={name}>
                        <span>{name}</span>
                        <strong>{formatLocalizedNumber(count)}</strong>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function AccountManagerModal({
  accounts,
  selectedAccountId,
  onSelect,
  onClose,
  onAccountsChange,
  onNotify,
  onHistorySync
}: {
  accounts: AccountSummary[];
  selectedAccountId: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
  onAccountsChange: (accounts: AccountSummary[]) => void;
  onNotify: (notification: Omit<AppNotification, "id" | "createdAt">) => void;
  onHistorySync: (account: AccountSummary) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <ModalShell
      title={t("accountManagerTitle")}
      description={t("accountManagerDescription")}
      className="account-modal"
      onClose={onClose}
    >
      <AccountSettingsPane
        accounts={accounts}
        selectedAccountId={selectedAccountId}
        onSelect={onSelect}
        onAccountsChange={onAccountsChange}
        onNotify={onNotify}
        onHistorySync={onHistorySync}
      />
    </ModalShell>
  );
}

function AccountSettingsPane({
  accounts,
  selectedAccountId,
  onSelect,
  onAccountsChange,
  onNotify,
  onHistorySync,
  onValidated
}: {
  accounts: AccountSummary[];
  selectedAccountId: string | null;
  onSelect: (id: string | null) => void;
  onAccountsChange: (accounts: AccountSummary[]) => void;
  onNotify: (notification: Omit<AppNotification, "id" | "createdAt">) => void;
  onHistorySync: (account: AccountSummary) => void;
  onValidated?: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [draft, setDraft] = useState<AccountConfigDraft>(() => createAccountDraft(accounts.find((item) => item.id === selectedAccountId) ?? accounts[0]));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [guideOpen, setGuideOpen] = useState(accounts.length === 0);
  const editingExisting = Boolean(draft.id);

  const pickAccount = useCallback((account: AccountSummary) => {
    onSelect(account.id);
    setDraft(createAccountDraft(account));
    setStatus("");
  }, [onSelect]);

  const save = useCallback(async () => {
    setBusy(true);
    setStatus(t("settings:savingAccount"));
    let accountWasSaved = false;
    try {
      const next = await saveAccountConfig(draft);
      if (next) {
        onAccountsChange(next);
        const saved = next.find((item) => item.id === draft.id) ?? next[next.length - 1];
        if (saved) onSelect(saved.id);
        setDraft(createAccountDraft(saved));
        accountWasSaved = Boolean(saved);
        if (saved && isTauriRuntime()) {
          // Account creation immediately verifies and, when possible, switches OKX to hedge mode.
          await testAccountConfig(saved.id);
        }
        setStatus(saved
          ? t("settings:accountIdentifiedAndSaved", { environment: t(saved.environment === "live" ? "common:live" : "common:demo") })
          : t("settings:accountSaved"));
        onNotify({
          kind: "success",
          title: t("settings:accountIdentifiedSavedTitle"),
          message: saved
            ? t("settings:accountIdentifiedSavedMessage", { name: saved.name, environment: t(saved.environment === "live" ? "common:live" : "common:demo") })
            : t("settings:accountUpdatedMessage", { name: draft.name || t("settings:defaultOkxAccount") })
        });
        if (saved) onHistorySync(saved);
      } else {
        setStatus(t("settings:desktopSaveOnly"));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("save account failed", error);
      setStatus(accountWasSaved ? t("settings:accountSaved") : t("settings:accountSaveFailed"));
      if (!isPositionModeSwitchFailureMessage(message)) {
        onNotify({ kind: "error", title: t("settings:accountSaveFailed"), message });
      }
    } finally {
      setBusy(false);
    }
  }, [draft, onAccountsChange, onHistorySync, onNotify, onSelect, t]);

  const remove = useCallback(async () => {
    if (!draft.id || busy) return;
    setBusy(true);
    setStatus(t("settings:deletingAccount"));
    try {
      const next = await deleteAccountConfig(draft.id);
      if (next) {
        onAccountsChange(next);
        onSelect(next[0]?.id ?? null);
        setDraft(createAccountDraft(next[0]));
        setStatus(t("settings:accountDeleted"));
        onNotify({ kind: "info", title: t("settings:accountDeleted"), message: t("settings:localAccountRemoved") });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("delete account failed", error);
      setStatus(t("settings:accountDeleteFailed"));
      onNotify({ kind: "error", title: t("settings:accountDeleteFailed"), message });
    } finally {
      setBusy(false);
    }
  }, [busy, draft.id, onAccountsChange, onNotify, onSelect, t]);

  const test = useCallback(async () => {
    if (!draft.id || busy) {
      setStatus(t("settings:saveAccountFirst"));
      return;
    }
    setBusy(true);
    setStatus(t("settings:testingConnection"));
    try {
      const snapshot = await testAccountConfig(draft.id);
      if (snapshot) {
        const nextAccounts = await loadAccounts();
        const testedAccount = nextAccounts.find((item) => item.id === draft.id);
        onAccountsChange(nextAccounts);
        if (testedAccount) {
          setDraft(createAccountDraft(testedAccount));
          onHistorySync(testedAccount);
        }
        setStatus(t("settings:environmentConnectionHealthy", { environment: t(snapshot.environment === "live" ? "common:live" : "common:demo") }));
        onNotify({
          kind: "success",
          title: t("settings:accountConnectionHealthy"),
          message: t("settings:accountConnectionHealthyMessage", { environment: t(snapshot.environment === "live" ? "common:live" : "common:demo"), balances: snapshot.balances.length, positions: snapshot.positions.length })
        });
        onValidated?.();
      } else {
        setStatus(t("settings:desktopTestOnly"));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("test account failed", error);
      setStatus(t("settings:connectionTestFailed"));
      if (!isPositionModeSwitchFailureMessage(message)) {
        onNotify({ kind: "error", title: t("settings:connectionTestFailed"), message });
      }
    } finally {
      setBusy(false);
    }
  }, [busy, draft.id, onAccountsChange, onHistorySync, onNotify, onValidated, t]);

  return (
        <div className="account-modal-body">
          <section className={clsx("account-config-guide", guideOpen && "open")}>
            <button
              type="button"
              className="account-config-guide-trigger"
              aria-expanded={guideOpen}
              onClick={() => setGuideOpen((current) => !current)}
            >
              <BookOpen size={17} />
              <span><strong>{t("settings:okxApiGuide")}</strong><small>{t("settings:okxApiGuideSummary")}</small></span>
              <ChevronDown size={16} />
            </button>
            <div className="account-config-guide-reveal">
              <div className="account-config-guide-body">
                <div className="account-guide-step">
                  <b>1</b>
                  <div>
                    <strong>{t("settings:openApiManagement")}</strong>
                    <span>{t("settings:openApiManagementHelp")}</span>
                    <a href="https://www.okx.com/account/my-api" target="_blank" rel="noreferrer">{t("settings:openOkxOfficialPage")} <ExternalLink size={13} /></a>
                  </div>
                </div>
                <div className="account-guide-step">
                  <b>2</b>
                  <div>
                    <strong>{t("settings:setApiPermissions")}</strong>
                    <span>{t("settings:setApiPermissionsHelp")}</span>
                    <em className="permission-safe"><CircleCheck size={13} />{t("settings:readPermission")}</em>
                    <em className="permission-safe"><CircleCheck size={13} />{t("settings:tradePermission")}</em>
                    <em className="permission-danger"><XCircle size={13} />{t("settings:disableWithdrawals")}</em>
                  </div>
                </div>
                <div className="account-guide-step">
                  <b>3</b>
                  <div>
                    <strong>{t("settings:ipAllowlist")}</strong>
                    <span>{t("settings:ipAllowlistHelp")}</span>
                    <small>{t("settings:ipAllowlistNotice")}</small>
                  </div>
                </div>
              </div>
            </div>
          </section>
          <aside className="account-list-panel">
            {accounts.length === 0 ? (
              <div className="account-list-empty">{t("settings:noAccounts")}</div>
            ) : (
              accounts.map((account) => (
                <button
                  className={clsx("account-list-row", account.id === draft.id && "active")}
                  key={account.id}
                  onClick={() => pickAccount(account)}
                >
                  <strong>{account.name}</strong>
                  <span>{t(account.environment === "live" ? "common:live" : "common:demo")} · {account.apiKeyMasked}</span>
                </button>
              ))
            )}
            <button className="add-account-row" onClick={() => setDraft(createAccountDraft())}>
              <Plus size={15} /> {t("settings:addAccount")}
            </button>
          </aside>
          <form className="account-form" data-onboarding-target="account" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <label>
              {t("settings:accountName")}
              <input value={draft.name} onChange={(event) => setDraft((item) => ({ ...item, name: event.target.value }))} />
            </label>
            <div className="account-detected-environment">
              <span>{t("settings:tradingEnvironment")}</span>
              {editingExisting ? (
                <strong className={accounts.find((item) => item.id === draft.id)?.environment === "live" ? "live" : "demo"}>
                  <ShieldCheck size={14} />
                  {t(accounts.find((item) => item.id === draft.id)?.environment === "live" ? "common:live" : "common:demo")}
                </strong>
              ) : (
                <strong className="pending"><Loader2 size={14} />{t("settings:detectWhenSaving")}</strong>
              )}
              <small>{t("settings:environmentAutoDetectionHelp")}</small>
            </div>
            <label>
              API Key
              <input
                value={draft.apiKey ?? ""}
                data-onboarding-focus
                placeholder={editingExisting ? t("settings:keepExistingKey") : "OK-ACCESS-KEY"}
                onChange={(event) => setDraft((item) => ({ ...item, apiKey: event.target.value }))}
              />
            </label>
            <label>
              Secret Key
              <input
                type="password"
                value={draft.secretKey ?? ""}
                placeholder={editingExisting ? t("settings:keepExistingSecret") : "OK-ACCESS-SECRET"}
                onChange={(event) => setDraft((item) => ({ ...item, secretKey: event.target.value }))}
              />
            </label>
            <label>
              Passphrase
              <input
                type="password"
                value={draft.passphrase ?? ""}
                placeholder={editingExisting ? t("settings:keepExistingPassphrase") : "OK-ACCESS-PASSPHRASE"}
                onChange={(event) => setDraft((item) => ({ ...item, passphrase: event.target.value }))}
              />
            </label>
            <div className="permission-row">
              {(["read", "trade", "withdraw"] as const).map((key) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={draft.permissions[key]}
                    disabled={key === "withdraw"}
                    onChange={(event) =>
                      setDraft((item) => ({
                        ...item,
                        permissions: { ...item.permissions, [key]: event.target.checked }
                      }))
                    }
                  />
                  {t(key === "read" ? "settings:readPermission" : key === "trade" ? "settings:tradePermission" : "settings:withdrawalsDisabled")}
                </label>
              ))}
            </div>
            <div className="account-actions">
              <button type="submit" disabled={busy}>{busy ? t("common:processing") : t("settings:saveAccount")}</button>
              <button type="button" onClick={() => void test()} disabled={busy || !draft.id}>{t("settings:testConnection")}</button>
              <button type="button" className="danger-action" onClick={() => void remove()} disabled={busy || !draft.id}>{t("common:delete")}</button>
              <span>{status}</span>
            </div>
          </form>
        </div>
  );
}

/** Watchlist hung off the market name in the title bar.
 *
 *  Replaces a 272px rail plus an edge handle that floated over the chart. The
 *  chart now owns its full width, and the way to switch markets is the thing the
 *  user is already looking at. Search spans every perpetual so a market can be
 *  added without leaving the menu.
 */
function MarketPickerMenu({
  symbol,
  watchlist,
  options,
  query,
  marketAssets,
  cacheDir,
  onQueryChange,
  onSelect,
  onAdd,
  onRemove,
  onClose
}: Readonly<{
  symbol: string;
  watchlist: string[];
  options: OkxInstrumentSummary[];
  query: string;
  marketAssets: MarketAssetsSummary | null;
  cacheDir?: string;
  onQueryChange: (value: string) => void;
  onSelect: (symbol: string) => void;
  onAdd: (symbol: string) => void;
  onRemove: (symbol: string) => void;
  onClose: () => void;
}>) {
  const { t } = useTranslation(["trading", "common"]);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const searching = query.trim().length > 0;

  useEffect(() => { searchRef.current?.focus(); }, []);

  return (
    <div className="market-picker" role="dialog" aria-label={t("trading:watchlist")}>
      <div className="market-picker__search">
        <Search size={14} />
        <input
          ref={searchRef}
          value={query}
          placeholder={t("trading:searchMarkets")}
          aria-label={t("trading:searchMarkets")}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); onClose(); }
          }}
        />
        {query ? (
          <button type="button" onClick={() => onQueryChange("")} title={t("common:clear")} aria-label={t("common:clear")}>
            <X size={12} />
          </button>
        ) : null}
      </div>

      <div className="market-picker__list" role="listbox" aria-label={t("trading:watchlist")}>
        {/* Without a query the menu is the watchlist; typing searches every
            perpetual so an unlisted market can be starred straight from here. */}
        {searching ? (
          options.length > 0 ? options.map((item) => {
            const starred = watchlist.includes(item.instId);
            return (
              <div className={clsx("market-picker__row", item.instId === symbol && "is-active")} key={item.instId}>
                <button type="button" className="market-picker__pick" onClick={() => onSelect(item.instId)} role="option" aria-selected={item.instId === symbol}>
                  <SymbolIcon base={item.baseCcy} iconPath={item.iconPath} cached={item.iconCached} cacheDir={cacheDir} />
                  <span className="market-picker__ident">
                    <strong>{item.baseCcy}</strong>
                    <small>{item.instId}</small>
                  </span>
                  <HotWatchQuote symbol={item.instId} />
                </button>
                <button
                  type="button"
                  className={clsx("market-picker__star", starred && "is-on")}
                  disabled={starred ? item.instId === DEFAULT_SYMBOL : watchlist.length >= 10}
                  onClick={() => (starred ? onRemove(item.instId) : onAdd(item.instId))}
                  title={starred
                    ? (item.instId === DEFAULT_SYMBOL ? t("trading:defaultMarketLocked") : t("trading:removeFromWatchlist"))
                    : (watchlist.length >= 10 ? t("trading:watchlistFull") : t("trading:addToWatchlist"))}
                  aria-label={starred ? t("trading:removeFromWatchlist") : t("trading:addToWatchlist")}
                >
                  <Star size={13} />
                </button>
              </div>
            );
          }) : <div className="market-picker__empty">{t("trading:noMatchingMarkets")}</div>
        ) : (
          watchlist.map((item) => {
            const asset = marketAssets?.instruments.find((entry) => entry.instId === item);
            return (
              <div className={clsx("market-picker__row", item === symbol && "is-active")} key={item}>
                <button type="button" className="market-picker__pick" onClick={() => onSelect(item)} role="option" aria-selected={item === symbol}>
                  <SymbolIcon base={asset?.baseCcy || item.split("-")[0]} iconPath={asset?.iconPath} cached={asset?.iconCached} cacheDir={cacheDir} />
                  <span className="market-picker__ident">
                    <strong>{asset?.baseCcy || item.split("-")[0]}</strong>
                    <small>{item}</small>
                  </span>
                  <HotWatchQuote symbol={item} />
                </button>
                <button
                  type="button"
                  className="market-picker__star is-on"
                  disabled={item === DEFAULT_SYMBOL}
                  onClick={() => onRemove(item)}
                  title={item === DEFAULT_SYMBOL ? t("trading:defaultMarketLocked") : t("trading:removeFromWatchlist")}
                  aria-label={t("trading:removeFromWatchlist")}
                >
                  <Star size={13} />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function ConfirmDialog({
  title,
  message,
  confirmText,
  danger,
  onCancel,
  onConfirm
}: {
  title: string;
  message: string;
  confirmText: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation("common");
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  return (
    <ModalShell title={title} compact className="confirm-dialog" initialFocusRef={cancelButtonRef} onClose={onCancel}>
      <p>{message}</p>
      <div className="modal-actions">
        <button type="button" ref={cancelButtonRef} onClick={onCancel}>{t("cancel")}</button>
        <button type="button" className={danger ? "danger-action" : ""} onClick={onConfirm}>{confirmText}</button>
      </div>
    </ModalShell>
  );
}

function createAccountDraft(account?: AccountSummary): AccountConfigDraft {
  return {
    id: account?.id,
    name: account?.name ?? i18n.t("settings:defaultOkxAccount"),
    apiKey: "",
    secretKey: "",
    passphrase: "",
    permissions: {
      read: account?.permissions.read ?? true,
      trade: account?.permissions.trade ?? true,
      withdraw: false
    }
  };
}

const navItems = [
  { id: "terminal", labelKey: "navigation:trading", Icon: TrendingUp },
  { id: "opportunities", labelKey: "navigation:opportunities", Icon: ShieldAlert },
  { id: "automation", labelKey: "navigation:automation", Icon: Bot },
  { id: "intelligence", labelKey: "navigation:intelligence", Icon: Newspaper },
  { id: "systematic", labelKey: "navigation:systematic", Icon: Layers3 },
  { id: "data", labelKey: "navigation:data", Icon: LayoutDashboard },
  { id: "settings", labelKey: "navigation:settings", Icon: Settings }
] as const;

function StatusIcon({ status }: { status: StartupCheck["status"] }) {
  if (status === "running") return <Loader2 className="spin" size={18} />;
  if (status === "passed") return <CheckCircle2 className="ok" size={18} />;
  if (status === "failed") return <XCircle className="bad" size={18} />;
  return <span className="pending-dot" />;
}

function marketBaseFromSymbol(symbol: string, baseCcy?: string | null) {
  return (baseCcy || symbol.split("-")[0] || "").toUpperCase();
}

function createInitialChecks(t: TFunction): StartupCheck[] {
  const detail = t("common:startupWaitingCheck");
  return [
    { id: "network", label: "OKX Network", status: "pending", detail },
    { id: "config", label: t("common:startupLocalConfig"), status: "pending", detail },
    { id: "privateWs", label: "OKX Private WS", status: "pending", detail },
    { id: "time", label: t("common:startupServerTime"), status: "pending", detail },
    { id: "assets", label: t("common:startupMarketAssets"), status: "pending", detail },
    { id: "database", label: t("common:startupLocalStorage"), status: "pending", detail },
    { id: "kline", label: t("common:startupCandleBaseline"), status: "pending", detail }
  ];
}

function OrderBookView({ book }: { book: OrderBook | null }) {
  const { t } = useTranslation("trading");
  const fixedDepthRows = 5;
  const visibleBids = getVisibleDepthLevels(book?.bids ?? [], "bid");
  const visibleAsks = getVisibleDepthLevels(book?.asks ?? [], "ask");
  const asks = padDepthLevels(visibleAsks.slice(0, fixedDepthRows).reverse(), fixedDepthRows);
  const bids = padDepthLevels(visibleBids.slice(0, fixedDepthRows), fixedDepthRows);
  return (
    <div className="orderbook">
      <div className="depth-head"><span>{t("priceUsdt")}</span><span>{t("quantityContracts")}</span></div>
      {asks.map((level, index) => <DepthRow key={`a-${index}`} level={level} side="ask" />)}
      <div className="mid-price">{visibleBids.length ? formatOrderBookPrice(visibleBids[0]?.px) : "--"} <span>{t("liveOrderBook")}</span></div>
      {bids.map((level, index) => <DepthRow key={`b-${index}`} level={level} side="bid" />)}
    </div>
  );
}

function DepthModal({ symbol, book, onClose }: { symbol: string; book: OrderBook | null; onClose: () => void }) {
  const { t, i18n: translation } = useTranslation(["trading", "common"]);
  const chineseUi = (translation.resolvedLanguage ?? translation.language).toLowerCase().startsWith("zh");
  const depthRows = 24;
  const visibleBids = getVisibleDepthLevels(book?.bids ?? [], "bid");
  const visibleAsks = getVisibleDepthLevels(book?.asks ?? [], "ask");
  const actualDepthRows = Math.max(visibleBids.length, visibleAsks.length);
  const bids = padDepthLevels(visibleBids.slice(0, depthRows), depthRows);
  const asks = padDepthLevels(visibleAsks.slice(0, depthRows), depthRows);
  return (
    <ModalShell
      title={chineseUi ? "完整盘口" : "Full order book"}
      description={chineseUi ? `${symbol} · 买卖各 ${depthRows} 档` : `${symbol} · ${depthRows} levels per side`}
      className="depth-modal"
      onClose={onClose}
    >
      <div className="depth-modal-toolbar">
        <span>{t("trading:buy")}</span>
        <strong>{actualDepthRows
          ? chineseUi
            ? `买一 ${formatOrderBookPrice(visibleBids[0]?.px)} / 卖一 ${formatOrderBookPrice(visibleAsks[0]?.px)}`
            : `Best bid ${formatOrderBookPrice(visibleBids[0]?.px)} / best ask ${formatOrderBookPrice(visibleAsks[0]?.px)}`
          : t("trading:waitingOrderBook")}</strong>
        <span>{t("trading:sell")}</span>
      </div>
      <div className="depth-modal-book">
        <DepthSide title={t("trading:buy")} side="bid" levels={bids} />
        <DepthSide title={t("trading:sell")} side="ask" levels={asks} />
      </div>
    </ModalShell>
  );
}

function DepthSide({ title, side, levels }: { title: string; side: "ask" | "bid"; levels: Array<{ px: string; sz: string } | null> }) {
  const { t } = useTranslation("trading");
  const maxSize = Math.max(1, ...levels.map((level) => Number(level?.sz || 0)).filter(Number.isFinite));
  return (
    <div className={clsx("depth-side", side)}>
      <div className="depth-side-title">{title}</div>
      <div className="depth-modal-head"><span>{t("quantityContracts")}</span><span>{t("priceUsdt")}</span></div>
      {levels.map((level, index) => {
        const size = Number(level?.sz || 0);
        return (
          <DepthModalRow
            key={`${side}-${index}`}
            level={level}
            side={side}
            ratio={(Number.isFinite(size) ? size : 0) / maxSize}
          />
        );
      })}
    </div>
  );
}

function DepthModalRow({ level, side, ratio }: { level: { px: string; sz: string } | null; side: "ask" | "bid"; ratio: number }) {
  const size = Number(level?.sz || 0);
  const barStyle = { width: `${Math.max(2, Math.min(100, ratio * 100))}%` };
  return (
    <div className={clsx("depth-modal-row", side, !level && "empty")}>
      {level && <i style={barStyle} />}
      <span>{level ? formatDepthSize(size) : "--"}</span>
      <strong>{level ? formatOrderBookPrice(level.px) : "--"}</strong>
    </div>
  );
}

function padDepthLevels(levels: Array<{ px: string; sz: string }>, count: number) {
  return Array.from({ length: count }, (_, index) => levels[index] ?? null);
}

function getVisibleDepthLevels(levels: Array<{ px: string; sz: string }>, side: "ask" | "bid") {
  return levels
    .filter((level) => Number(level.sz) > 0)
    .sort((left, right) => side === "bid" ? Number(right.px) - Number(left.px) : Number(left.px) - Number(right.px));
}

function formatOrderBookPrice(value?: string | number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  const raw = String(value ?? "");
  const decimals = raw.includes(".") ? Math.min(8, Math.max(1, raw.split(".")[1]?.length ?? 1)) : 1;
  return numeric.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function DepthRow({ level, side }: { level: { px: string; sz: string } | null; side: "ask" | "bid" }) {
  const { t } = useTranslation("trading");
  const size = Number(level?.sz || 0);
  return (
    <div
      className={clsx("depth-row", side, !level && "empty")}
      role="button"
      tabIndex={level ? 0 : -1}
      aria-disabled={!level}
      aria-label={level ? `${t("fillFromOrderBook")}: ${t(side === "ask" ? "sell" : "buy")} ${level.px}` : t("waitingOrderBook")}
    >
      <span>{level ? formatOrderBookPrice(level.px) : "--"}</span>
      <span>{level ? formatDepthSize(size) : "--"}</span>
    </div>
  );
}

function OrderPressureView({ book, trades }: { book: OrderBook | null; trades: Trade[] }) {
  const { t } = useTranslation("trading");
  const bidSize = sumLevels(book?.bids ?? []);
  const askSize = sumLevels(book?.asks ?? []);
  const total = bidSize + askSize;
  const bidPercent = total > 0 ? Math.round((bidSize / total) * 100) : 50;
  const askPercent = 100 - bidPercent;
  const recentTrades = trades.slice(0, 24);
  const buyTradeSize = recentTrades.reduce((sum, trade) => sum + (trade.side === "buy" ? Number(trade.sz || 0) : 0), 0);
  const sellTradeSize = recentTrades.reduce((sum, trade) => sum + (trade.side === "sell" ? Number(trade.sz || 0) : 0), 0);
  const tradeTotal = buyTradeSize + sellTradeSize;
  const tradeBias = tradeTotal > 0 ? Math.round((buyTradeSize / tradeTotal) * 100) : 50;
  const depthImbalance = bidPercent - askPercent;
  const tradeImbalance = tradeBias - (100 - tradeBias);
  const pressureScore = Math.round(depthImbalance * 0.62 + tradeImbalance * 0.38);
  const pressureStrength = Math.min(100, Math.max(0, Math.abs(pressureScore)));
  const pressureTone = pressureScore >= 0 ? "bid" : "ask";
  const pressureText = total > 0
    ? t(bidPercent >= askPercent ? "bidDominant" : "askDominant")
    : t("waitingOrderBook");
  const pulseStyle = {
    "--pressure-score": `${pressureScore}%`,
    "--pressure-strength": pressureStrength,
    "--trade-bias": `${tradeBias}%`
  } as CSSProperties;

  return (
    <div className={clsx("pressure-panel", `pressure-${pressureTone}`)} style={pulseStyle}>
      <div className="pressure-head">
        <span>{t("marketPressure")}</span>
        <strong className={bidPercent >= askPercent ? "up" : "down"}>{pressureText} {pressureScore >= 0 ? "+" : ""}{pressureScore}</strong>
      </div>
      <div className="pressure-battle" aria-label={t("marketPressure")}>
        <div className="pressure-side bid" style={{ width: `${bidPercent}%` }} />
        <div className="pressure-side ask" style={{ width: `${askPercent}%` }} />
        <div className="pressure-flow" aria-hidden="true">
          {Array.from({ length: 7 }, (_, index) => <i key={index} style={{ "--pulse-index": index } as CSSProperties} />)}
        </div>
        <span className="pressure-midline" />
        <span className="pressure-balance-dot" />
      </div>
      <div className="pressure-trade-track" aria-label={t("activeBuy")}>
        <span className="trade-bias-fill" />
      </div>
      <div className="pressure-meta">
        <span className="up">{t("buy")} {bidPercent}%</span>
        <span>{t("activeBuy")} {tradeBias}%</span>
        <span className="down">{t("sell")} {askPercent}%</span>
      </div>
    </div>
  );
}

function sumLevels(levels: { sz: string }[]) {
  return levels.slice(0, 12).reduce((sum, level) => sum + Number(level.sz || 0), 0);
}

function summarizeKlineSync(reports: Record<string, KlineSyncReport>) {
  const grouped: Record<string, KlineSyncReport[]> = {};
  for (const report of Object.values(reports)) {
    grouped[report.symbol] ??= [];
    grouped[report.symbol].push(report);
  }

  return Object.fromEntries(
    Object.entries(grouped).map(([symbol, items]) => {
      if (items.some((item) => item.status === "failed")) return [symbol, "同步失败"];
      if (items.some((item) => item.retryState === "permanent_gap")) return [symbol, "待复核"];
      if (items.some((item) => item.status === "backfilling" || item.status === "scanning")) return [symbol, "K线同步中"];
      const missing = items.reduce((sum, item) => sum + item.missing, 0);
      const invalid = items.reduce((sum, item) => sum + (item.invalid ?? 0), 0);
      if (missing > 0) return [symbol, `缺口 ${missing}`];
      if (invalid > 0) return [symbol, `异常 ${invalid}`];
      if (items.length > 0 && items.every((item) => item.status === "complete")) return [symbol, "已同步"];
      return [symbol, "永续"];
    })
  ) as Record<string, string>;
}

function permissionModeLabel(mode: AiPermissionMode | string | undefined, t?: UiTranslation) {
  switch (normalizeAiPermissionMode(mode)) {
    case "copilot":
      return t ? t("settings:permissionCopilot") : "副驾驶";
    case "limited_auto":
      return t ? t("settings:permissionLimitedAuto") : "自动执行（受限）";
    default:
      return t ? t("settings:permissionAdvisor") : "顾问";
  }
}

function formatAiSessionMeta(session: AiSession, t?: UiTranslation) {
  const status = statusLabel(session.status, t);
  const updated = formatDateTime(session.updatedAt);
  return `${status} · ${updated}`;
}

function sortAiSessions(items: AiSession[]) {
  return [...items].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
}

type AiSessionHistoryTab = AiSession["origin"];

function sessionEmptyCopyKey(tab: AiSessionHistoryTab): string {
  switch (tab) {
    case "user": return "automation:noUserSessions";
    case "automation": return "automation:noAutomationSessions";
    case "indicator": return "automation:noIndicatorSessions";
    case "strategy": return "automation:noStrategySessions";
  }
}

function statusLabel(status: string, t?: UiTranslation) {
  if (status === "connecting") return t ? t("automation:connecting") : "连接中";
  if (status === "running" || status === "streaming") return t ? t("automation:generating") : "生成中";
  if (status === "tooling") return t ? t("automation:usingTools") : "工具中";
  if (status === "retrying") return "重试连接中";
  if (status === "failed") return t ? t("common:failed") : "失败";
  if (status === "stopped") return t ? t("automation:stopped") : "已停止";
  return t ? t("automation:idle") : "空闲";
}

function aiRuntimeStatusFromSession(status: string) {
  const normalized = status.trim().toLowerCase();
  if (normalized === "failed" || normalized === "error") return "failed";
  if (["connecting", "running", "streaming", "tooling", "retrying"].includes(normalized)) return normalized;
  return "idle";
}

const defaultAiMessages: AiUiMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    text: "我是交易终端 AI 助手，可以协助分析行情、解释仓位和整理交易复盘。",
    tools: [],
    approvals: []
  }
];

const previewLegacyToolMessage = storedMessageToUiMessage({
  id: "preview-history-tools",
  sessionId: "preview-history",
  role: "assistant",
  content: "",
  status: "completed",
  toolJson: JSON.stringify([
    {
      type: "processReasoningSummary",
      id: "preview-reasoning-summary-1",
      content: "**Inspecting account and market context**"
    },
    {
      type: "processReasoningSummary",
      id: "preview-reasoning-summary-2",
      content: "**Planning the risk review**"
    },
    {
      type: "processReasoning",
      content: "先读取账户和市场上下文，再核对风险限制，最后给出只读结论。"
    },
    {
      type: "toolCall",
      toolCallId: "provider-instrument-call",
      name: "market.readInstrument",
      arguments: { instId: "BTC-USDT-SWAP" },
      allowed: true,
      startedAt: 1_784_810_000_000
    },
    {
      type: "toolCall",
      toolCallId: "internal-instrument-execution",
      name: "market.readInstrument",
      arguments: { instId: "BTC-USDT-SWAP" },
      allowed: true,
      policy: "rust:tool-execute-request",
      agentId: "preview-agent"
    },
    {
      type: "toolResult",
      toolCallId: "internal-instrument-execution",
      name: "market.readInstrument",
      result: { instId: "BTC-USDT-SWAP" },
      summary: "合约规格已读取",
      ok: true
    },
    {
      type: "toolResult",
      toolCallId: "provider-instrument-call",
      name: "market.readInstrument",
      result: { instId: "BTC-USDT-SWAP" },
      summary: "合约规格已读取",
      ok: true,
      endedAt: 1_784_810_002_400
    },
    {
      type: "agentStart",
      agentId: "preview-history-market",
      configuredAgentId: "preview-history-market",
      title: "历史市场结构",
      task: "验证稳定 Agent 身份与完成状态。",
      startedAt: 1_784_810_003_000
    },
    {
      type: "agentStart",
      agentId: "runtime-preview-history-market",
      configuredAgentId: "preview-history-market",
      title: "历史市场结构",
      task: "验证稳定 Agent 身份与完成状态。",
      startedAt: 1_784_810_003_100
    },
    {
      type: "toolCall",
      toolCallId: "preview-history-ticker",
      name: "market.readTicker",
      arguments: { instId: "BTC-USDT-SWAP" },
      agentId: "runtime-preview-history-market",
      configuredAgentId: "preview-history-market",
      startedAt: 1_784_810_004_000
    },
    {
      type: "toolResult",
      toolCallId: "preview-history-ticker",
      name: "market.readTicker",
      result: { last: "65088.1" },
      summary: "最新行情已返回",
      ok: true,
      agentId: "runtime-preview-history-market",
      configuredAgentId: "preview-history-market",
      endedAt: 1_784_810_004_015
    },
    {
      type: "toolCall",
      toolCallId: "preview-history-crowding",
      name: "intelligence.smartMoney.readCrowdingComparison",
      arguments: { instId: "BTC-USDT-SWAP" },
      agentId: "runtime-preview-history-market",
      configuredAgentId: "preview-history-market",
      startedAt: 1_784_810_005_000
    },
    {
      type: "toolResult",
      toolCallId: "preview-history-crowding",
      name: "intelligence.smartMoney.readCrowdingComparison",
      result: { accountRatio: 1.08 },
      summary: "拥挤度对比已返回",
      ok: true,
      agentId: "runtime-preview-history-market",
      configuredAgentId: "preview-history-market",
      endedAt: 1_784_810_005_021
    },
    {
      type: "agentDone",
      agentId: "preview-history-market",
      configuredAgentId: "preview-history-market",
      status: "done",
      result: { finishReason: "completed" },
      endedAt: 1_784_810_008_000
    },
    {
      type: "processText",
      content: "历史工具状态已合并。"
    }
  ]),
  createdAt: 1
});

const previewModelErrorMessage = storedMessageToUiMessage({
  id: "preview-model-error",
  sessionId: "preview-history",
  role: "assistant",
  content: "",
  status: "failed",
  toolJson: JSON.stringify([
    {
      type: "agentStart",
      agentId: "preview-model-error-agent",
      configuredAgentId: "preview-model-error-agent",
      title: "账户风险",
      task: "读取账户风险并给出结构化报告。",
      startedAt: 1_784_810_010_000
    },
    {
      type: "agentDone",
      agentId: "preview-model-error-agent",
      configuredAgentId: "preview-model-error-agent",
      status: "done",
      result: {
        finishReason: "error",
        iterations: 1,
        successfulTools: [],
        text: "Insufficient Balance",
        usage: { inputTokens: 0, outputTokens: 0 }
      },
      endedAt: 1_784_810_010_625
    }
  ]),
  createdAt: 2
});

const previewAiMessages: AiUiMessage[] = [
  {
    id: "preview-user",
    role: "user",
    text: "检查 BTC 当前盘口、最近成交和 5m K 线，给出风险提示。",
    tools: [],
    approvals: []
  },
  previewLegacyToolMessage,
  previewModelErrorMessage,
  {
    id: "preview-ai",
    role: "assistant",
    text: [
      "BTC-USDT-SWAP 当前短线波动放大，盘口买卖压力接近均衡。",
      "",
      "- 先确认账户环境、杠杆、可用保证金和止损位置",
      "- 若价格跌破盘口支撑，避免追多",
      "",
      "| 项目 | 状态 |",
      "| --- | --- |",
      "| 盘口 | 接近均衡 |",
      "| 风险 | 中等偏高 |",
      "",
      "```text",
      "只读分析，不执行下单。",
      "```"
    ].join("\n"),
    reasoning: "先读取只读市场上下文，再判断盘口压力、成交主动性和 K 线连续性。交易建议必须保留风险提示，不执行下单动作。",
    tools: [
      {
        id: "preview-ticker",
        name: "market.readTicker",
        arguments: { instId: "BTC-USDT-SWAP" },
        result: { instId: "BTC-USDT-SWAP", last: "63088.0", latencyMs: 212 },
        summary: "BTC-USDT-SWAP 最新价 63,088.0，延迟 212ms",
        ok: true,
        allowed: true,
        blocked: false,
        policy: "allowed:readonly-tool",
        status: "done"
      },
      {
        id: "preview-order",
        name: "trade.placeOrder",
        arguments: { instId: "BTC-USDT-SWAP", side: "buy", sz: "0.01" },
        allowed: false,
        blocked: true,
        policy: "blocked:first-stage-tools-are-readonly",
        status: "blocked"
      }
    ],
    approvals: [
      {
        id: "approval-preview",
        toolCallId: "trade-place-preview",
        toolName: "trade.placeOrder",
        input: { instId: "BTC-USDT-SWAP", side: "buy", ordType: "limit", px: "63000", sz: "0.01" },
        reason: "交易工具需要用户批准",
        status: "pending"
      }
    ],
    agents: [
      {
        id: "preview-agent-market",
        role: "market-analyst",
        title: "行情结构分析",
        task: "读取盘口、成交与 5m K 线，输出短线风险摘要。",
        status: "done",
        result: "盘口接近平衡，短线波动扩大。"
      }
    ],
    status: "生成中"
  }
];

const previewAiSessions: AiSession[] = [
  {
    id: "session-preview-user",
    title: "BTC 盘面咨询",
    status: "idle",
    origin: "user",
    createdAt: 1_784_810_000_000,
    updatedAt: 1_784_810_060_000
  },
  {
    id: "background:preview-run",
    title: "BTC 定时扫描",
    status: "idle",
    origin: "automation",
    createdAt: 1_784_809_000_000,
    updatedAt: 1_784_810_030_000
  },
  {
    id: "review:preview-review",
    title: "自动交易复盘",
    status: "idle",
    origin: "automation",
    createdAt: 1_784_808_000_000,
    updatedAt: 1_784_809_000_000
  }
];

export function AiPreview() {
  return (
    <main className="ai-preview-page">
      <AiDock preview />
    </main>
  );
}

const AI_DOCK_POSITION_KEY = "desic-terminal.ai-dock-position.v1";
const AI_PANEL_SIZE_KEY = "desic-terminal.ai-panel-size.v1";
const AI_DOCK_SIZE = 40;
const AI_DOCK_EDGE_GAP = 12;
const AI_PANEL_MIN_WIDTH = 360;
const AI_PANEL_MIN_HEIGHT = 420;

type AiDockPosition = { x: number; y: number };
type AiPanelSize = { width: number; height: number };
type AiSessionViewCache = { messages: AiUiMessage[]; status: string };

function clampAiDockPosition(position: AiDockPosition): AiDockPosition {
  if (typeof window === "undefined") return position;
  return {
    x: Math.min(Math.max(position.x, AI_DOCK_EDGE_GAP), Math.max(AI_DOCK_EDGE_GAP, window.innerWidth - AI_DOCK_SIZE - AI_DOCK_EDGE_GAP)),
    y: Math.min(Math.max(position.y, AI_DOCK_EDGE_GAP), Math.max(AI_DOCK_EDGE_GAP, window.innerHeight - AI_DOCK_SIZE - AI_DOCK_EDGE_GAP))
  };
}

function AiDock({ preview, onOpenSettings, onOpenStrategy, accountId }: { preview?: boolean; onOpenSettings?: () => void; onOpenStrategy?: (strategyId: string, runId?: string, optimizationId?: string) => void; accountId?: string } = {}) {
  const { t } = useTranslation(["automation", "common", "settings"]);
  const [open, setOpen] = useState(Boolean(preview));
  const [dockPosition, setDockPosition] = useState<AiDockPosition | null>(null);
  const [panelSize, setPanelSize] = useState<AiPanelSize | null>(null);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [sessionId, setSessionId] = useState(preview ? "session-preview-user" : "default-ai-session");
  const [sessionTitle, setSessionTitle] = useState(() => preview ? t("automation:previewSessionTitle") : t("automation:defaultSession"));
  const [config, setConfig] = useState<AiConfigSummary | null>(
    preview
      ? {
          provider: "cline-sdk",
          model: "deepseek-v4-pro",
          baseUrl: "https://api.deepseek.com/v1",
          apiKeyMasked: "sk-****589f",
          configured: true,
          stream: true,
          permissionMode: "copilot",
          reasoningDepth: "medium",
          activeModelId: "preview-model",
          models: [{
            id: "preview-model",
            name: "DeepSeek 预览",
            provider: "cline-sdk",
            model: "deepseek-v4-pro",
            baseUrl: "https://api.deepseek.com/v1",
            apiKeyMasked: "sk-****589f",
            configured: true,
            permissionMode: "copilot",
            reasoningDepth: "medium"
          }],
          systemPrompt: "",
          customRules: "",
          enabledSkills: ["market-analysis", "risk-review"],
          skillDefinitions: AI_SKILL_OPTIONS,
          skillRuntimeTrust: {},
          openAgent: true,
          workspaceRoots: []
        }
      : null
  );
  const [status, setStatus] = useState(preview ? "streaming" : "idle");
  const [chatModelId, setChatModelId] = useState(preview ? "preview-model" : "");
  const [chatPermissionMode, setChatPermissionMode] = useState<AiPermissionMode>(preview ? "copilot" : "advisor");
  const [chatReasoningDepth, setChatReasoningDepth] = useState<AiReasoningDepth>("medium");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<AiUiMessage[]>(() => preview ? previewAiMessages : [{ ...defaultAiMessages[0], text: t("automation:assistantWelcome") }]);
  const [creatingSession, setCreatingSession] = useState(false);
  const [sessions, setSessions] = useState<AiSession[]>(preview ? previewAiSessions : []);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessionHistoryTab, setSessionHistoryTab] = useState<AiSessionHistoryTab>("user");
  const [sessionsStatus, setSessionsStatus] = useState("");
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deleteSessionId, setDeleteSessionId] = useState<string | null>(null);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [skillSelectionIndex, setSkillSelectionIndex] = useState(0);
  const [aiClockNow, setAiClockNow] = useState(() => Date.now());
  const messagesRef = useRef<AiUiMessage[]>(messages);
  const statusRef = useRef(status);
  const sessionIdRef = useRef(sessionId);
  const sessionViewCacheRef = useRef<Map<string, AiSessionViewCache>>(new Map());
  const slowTimeoutRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
    source: "float" | "panel";
  } | null>(null);
  const panelResizeRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originWidth: number;
    originHeight: number;
    horizontal: -1 | 0 | 1;
    vertical: -1 | 0 | 1;
    maxWidth: number;
    maxHeight: number;
    lastSize: AiPanelSize;
  } | null>(null);
  const suppressDockClickRef = useRef(false);
  const aiDockRenderCountRef = useRef(0);
  aiDockRenderCountRef.current += 1;
  const isStreaming = status === "connecting" || status === "running" || status === "streaming" || status === "tooling" || status === "retrying";
  const chatModel = config?.models.find((model) => model.id === chatModelId) ?? config?.models[0] ?? null;
  const visibleSessions = useMemo(
    () => sessions.filter((session) => session.origin === sessionHistoryTab),
    [sessionHistoryTab, sessions]
  );
  const skillOptions = useMemo(() => {
    const enabled = new Set(config?.enabledSkills ?? []);
    return normalizeAiSkillDefinitions(config?.skillDefinitions ?? AI_SKILL_OPTIONS)
      .filter((skill) => skill.id !== "desic-core-operations")
      .filter((skill) => enabled.has(skill.id))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  }, [config]);
  const slashQuery = useMemo(() => {
    const match = input.match(/^\/([^\s/]*)$/);
    return match?.[1]?.toLowerCase() ?? null;
  }, [input]);
  const filteredSkillOptions = useMemo(() => {
    if (slashQuery === null) return [];
    return skillOptions.filter((skill) => {
      const haystack = `${skill.id} ${skill.name} ${skill.description}`.toLowerCase();
      return haystack.includes(slashQuery);
    });
  }, [skillOptions, slashQuery]);
  useRendererMemoryMonitor("ai-dock", () => summarizeAiDockMemory(messages, {
    open,
    status,
    renderCount: aiDockRenderCountRef.current,
    sessions: sessions.length,
    sessionsOpen,
    inputLength: input.length
  }));

  const refreshSessions = useCallback(async () => {
    if (preview) return;
    try {
      const items = await listAiSessions();
      if (items) setSessions(sortAiSessions(items));
      setSessionsStatus("");
    } catch (error) {
      logger.error("ai sessions list failed", error);
      setSessionsStatus(t("automation:sessionListLoadFailed"));
    }
  }, [preview, t]);

  const clearAiTimers = useCallback((scope: "all" | "slow" = "all") => {
    if ((scope === "all" || scope === "slow") && slowTimeoutRef.current !== null) {
      window.clearTimeout(slowTimeoutRef.current);
      slowTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    if (preview) return;
    sessionViewCacheRef.current.set(sessionId, { messages, status });
  }, [messages, preview, sessionId, status]);

  useEffect(() => {
    if (!isStreaming) {
      setAiClockNow(Date.now());
      return;
    }
    setAiClockNow(Date.now());
    const timer = window.setInterval(() => setAiClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isStreaming]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    if (preview) return;
    try {
      const stored = window.localStorage.getItem(AI_DOCK_POSITION_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored) as Partial<AiDockPosition>;
      if (typeof parsed.x === "number" && typeof parsed.y === "number") {
        setDockPosition(clampAiDockPosition({ x: parsed.x, y: parsed.y }));
      }
    } catch (error) {
      logger.warn("failed to restore AI dock position", { error: error instanceof Error ? error.message : String(error) });
    }
  }, [preview]);

  useEffect(() => {
    if (preview) return;
    try {
      const stored = window.localStorage.getItem(AI_PANEL_SIZE_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored) as Partial<AiPanelSize>;
      if (typeof parsed.width === "number" && typeof parsed.height === "number") {
        setPanelSize({
          width: Math.max(AI_PANEL_MIN_WIDTH, parsed.width),
          height: Math.max(AI_PANEL_MIN_HEIGHT, parsed.height)
        });
      }
    } catch (error) {
      logger.warn("failed to restore AI panel size", { error: error instanceof Error ? error.message : String(error) });
    }
  }, [preview]);

  useEffect(() => {
    if (preview || !dockPosition) return;
    const handleResize = () => setDockPosition((current) => current ? clampAiDockPosition(current) : current);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [dockPosition, preview]);

  useEffect(() => {
    if (preview) return;
    void loadAiConfigSummary().then((summary) => {
      setConfig(summary);
      if (summary) {
        setChatModelId(summary.activeModelId || summary.models[0]?.id || "");
        setChatPermissionMode(normalizeAiPermissionMode(summary.permissionMode));
        setChatReasoningDepth(summary.reasoningDepth ?? "medium");
      }
    });
    void listAiSessions()
      .then((snapshot) => {
        const items = sortAiSessions(snapshot ?? []);
        setSessions(items);
        const recent = items.find((session) => session.origin === "user");
        if (recent) return loadAiSession(recent.id);
        return createAiSession("交易助手");
      })
      .then((snapshot) => {
        if (!snapshot) return;
        setSessionId(snapshot.session.id);
        setSessionTitle(snapshot.session.title || t("automation:tradingAssistant"));
        setSessionHistoryTab("user");
        sessionIdRef.current = snapshot.session.id;
        setStatus(aiRuntimeStatusFromSession(snapshot.session.status));
        const restored = snapshotToUiMessages(snapshot);
        if (restored.length > 0) setMessages(restored);
        void refreshSessions();
      })
      .catch((error) => {
        logger.error("ai session load failed", error);
        setStatus("failed");
    });
    const listenerCleanup = createDeferredCleanupSlot();
    void listenAiEvents((event) => {
      const active = event.sessionId === sessionIdRef.current;
      const cached = sessionViewCacheRef.current.get(event.sessionId) ?? {
        messages: active ? messagesRef.current : [],
        status: active ? statusRef.current : "idle"
      };
      let nextStatus = cached.status;
      let nextMessages = cached.messages;
      applyAiEvent(
        event,
        (value) => { nextStatus = value; },
        (update) => {
          nextMessages = typeof update === "function" ? update(nextMessages) : update;
        }
      );
      sessionViewCacheRef.current.set(event.sessionId, { messages: nextMessages, status: nextStatus });
      if (!active) return;
      if (event.type === "status" || event.type === "delta" || event.type === "done" || event.type === "error") clearAiTimers("slow");
      setStatus(nextStatus);
      setMessages(nextMessages);
    }).then((unlisten) => listenerCleanup.settle(unlisten));
    return () => {
      listenerCleanup.dispose();
      clearAiTimers();
    };
  }, [clearAiTimers, preview, refreshSessions]);

  // Tauri events are not replayed. Reconcile the durable session state as a
  // fallback so an early sidecar/command failure cannot leave the dock stuck.
  useEffect(() => {
    if (preview || !["connecting", "streaming", "tooling", "running", "retrying"].includes(status)) return;
    let disposed = false;
    let interval: number | null = null;
    const reconcile = async () => {
      const snapshot = await loadAiSession(sessionIdRef.current).catch((error) => {
        logger.debug("ai session terminal reconciliation failed", { error: error instanceof Error ? error.message : String(error) });
        return null;
      });
      if (disposed || !snapshot || snapshot.session.id !== sessionIdRef.current) return;
      const normalized = snapshot.session.status.trim().toLowerCase();
      if (!["failed", "error", "stopped", "cancelled", "canceled", "idle", "completed", "done", "success"].includes(normalized)) return;
      clearAiTimers();
      const restored = snapshotToUiMessages(snapshot);
      if (restored.length > 0) setMessages(restored);
      setStatus(["failed", "error"].includes(normalized) ? "failed" : "idle");
      void refreshSessions();
      if (interval !== null) {
        window.clearInterval(interval);
        interval = null;
      }
    };
    const start = window.setTimeout(() => {
      void reconcile();
      interval = window.setInterval(() => void reconcile(), 2_000);
    }, 2_000);
    return () => {
      disposed = true;
      window.clearTimeout(start);
      if (interval !== null) window.clearInterval(interval);
    };
  }, [clearAiTimers, preview, refreshSessions, status]);

  useEffect(() => {
    if (preview) return;
    const listenerCleanup = createDeferredCleanupSlot();
    void listenAiConfigUpdates((summary) => {
      setConfig(summary);
      setChatModelId((current) => {
        const nextModelId = summary.models.some((model) => model.id === current)
          ? current
          : summary.activeModelId || summary.models[0]?.id || "";
        const selected = summary.models.find((model) => model.id === nextModelId);
        setChatPermissionMode(normalizeAiPermissionMode(selected?.permissionMode ?? summary.permissionMode));
        setChatReasoningDepth(selected?.reasoningDepth ?? summary.reasoningDepth ?? "medium");
        return nextModelId;
      });
    }).then((unlisten) => listenerCleanup.settle(unlisten));
    return () => listenerCleanup.dispose();
  }, [preview]);

  useEffect(() => {
    if (slashQuery === null || skillOptions.length === 0 || isStreaming || preview) {
      setSkillMenuOpen(false);
      setSkillSelectionIndex(0);
      return;
    }
    setSkillMenuOpen(true);
    setSkillSelectionIndex(0);
  }, [isStreaming, preview, skillOptions.length, slashQuery]);

  const submit = useCallback(async () => {
    const content = input.trim();
    if (!content || isStreaming || preview) return;
    if (!isTauriRuntime()) {
      setMessages((items) => [
        ...items,
        { id: `u-${Date.now()}`, role: "user", text: content, tools: [], approvals: [] },
        { id: `a-${Date.now()}`, role: "assistant", text: "", tools: [], approvals: [], status: "AI 只能在桌面应用内使用" }
      ]);
      setInput("");
      setStatus("failed");
      return;
    }
    const userMessage: AiUiMessage = { id: `u-${Date.now()}`, role: "user", text: content, tools: [], approvals: [] };
    const assistantMessage: AiUiMessage = { id: `a-${Date.now()}`, role: "assistant", text: "", reasoning: "", tools: [], approvals: [], status: "连接模型服务" };
    const nextMessages = [...messagesRef.current, userMessage, assistantMessage];
    setMessages(nextMessages);
    setInput("");
    setStatus("connecting");
    const activeSessionId = sessionIdRef.current;
    clearAiTimers();
    slowTimeoutRef.current = window.setTimeout(() => {
      if (!["connecting", "running", "streaming", "tooling"].includes(statusRef.current)) return;
      setMessages((items) =>
        updateLastAssistant(items, (message) => ({
          ...message,
          status: "模型响应较慢，仍在等待..."
        }))
      );
    }, 12_000);
    const history: AiChatMessage[] = nextMessages
      .filter((message) => message.id !== "welcome" && message.role !== "system")
      .filter((message) => message.role !== "assistant" || message.text.trim().length > 0)
      .map((message) => ({
        id: message.id,
        role: (message.role === "assistant" ? "assistant" : "user") as AiChatMessage["role"],
        content: message.text || message.reasoning || ""
      }))
      .filter((message) => message.content.trim().length > 0);
    try {
      await sendAiMessage(activeSessionId, history, accountId, {
        modelId: chatModelId || undefined,
        permissionMode: chatPermissionMode,
        reasoningDepth: chatReasoningDepth
      });
      await refreshSessions();
      const snapshot = await loadAiSession(activeSessionId).catch((error) => {
        logger.warn("ai session refresh after send failed", error);
        return null;
      });
      if (snapshot && snapshot.session.id === sessionIdRef.current) {
        setSessionTitle(snapshot.session.title || t("automation:newSession"));
      }
    } catch (error) {
      clearAiTimers();
      logger.error("ai send failed", error);
      setStatus("failed");
      setMessages((items) =>
        updateLastAssistant(items, (message) => ({
          ...message,
          status: error instanceof Error ? error.message : "发送失败"
        }))
      );
    }
  }, [accountId, chatModelId, chatPermissionMode, chatReasoningDepth, clearAiTimers, input, isStreaming, preview, refreshSessions]);

  const createNewSession = useCallback(async () => {
    if (preview || creatingSession) return;
    setCreatingSession(true);
    try {
      clearAiTimers();
      const snapshot = await createAiSession();
      if (!snapshot) {
        setStatus("failed");
        setMessages([{ ...defaultAiMessages[0], text: t("automation:assistantWelcome"), status: t("automation:createSessionDesktopRetry") }]);
        return;
      }
      setSessionId(snapshot.session.id);
      setSessionTitle(snapshot.session.title || t("automation:newSession"));
      setSessionHistoryTab("user");
      sessionIdRef.current = snapshot.session.id;
      setMessages(snapshotToUiMessages(snapshot));
      setInput("");
      setStatus("idle");
      await refreshSessions();
    } catch (error) {
      logger.error("ai create new session failed", error);
      setStatus("failed");
      setMessages((items) => [
        ...items,
        { id: `a-${Date.now()}`, role: "assistant", text: "", tools: [], status: error instanceof Error ? error.message : "新会话创建失败" }
      ]);
    } finally {
      setCreatingSession(false);
    }
  }, [clearAiTimers, creatingSession, preview, refreshSessions]);

  const switchSession = useCallback(async (targetSessionId: string) => {
    if (preview || targetSessionId === sessionIdRef.current) return;
    try {
      clearAiTimers();
      setSessionsStatus(t("automation:loadingSession"));
      const snapshot = await loadAiSession(targetSessionId);
      if (!snapshot) return;
      const cached = sessionViewCacheRef.current.get(targetSessionId);
      const restoredMessages = cached ? cached.messages : snapshotToUiMessages(snapshot);
      const restoredStatus = cached ? cached.status : aiRuntimeStatusFromSession(snapshot.session.status);
      setSessionId(snapshot.session.id);
      setSessionTitle(snapshot.session.title || t("automation:newSession"));
      setSessionHistoryTab(snapshot.session.origin);
      sessionIdRef.current = snapshot.session.id;
      setStatus(restoredStatus);
      setMessages(restoredMessages);
      sessionViewCacheRef.current.set(targetSessionId, { messages: restoredMessages, status: restoredStatus });
      setInput("");
      setSessionsStatus("");
      await refreshSessions();
    } catch (error) {
      logger.error("ai session switch failed", error);
      setSessionsStatus(error instanceof Error ? error.message : t("automation:switchSessionFailed"));
    }
  }, [clearAiTimers, preview, refreshSessions]);

  const startRenameSession = useCallback((session: AiSession) => {
    setRenamingSessionId(session.id);
    setRenameDraft(session.title);
  }, []);

  const commitRenameSession = useCallback(async () => {
    if (!renamingSessionId) return;
    const title = renameDraft.trim();
    if (!title) {
      setSessionsStatus(t("automation:sessionTitleRequired"));
      return;
    }
    try {
      const updated = await renameAiSession(renamingSessionId, title);
      if (updated && updated.id === sessionIdRef.current) setSessionTitle(updated.title);
      setRenamingSessionId(null);
      setRenameDraft("");
      await refreshSessions();
    } catch (error) {
      logger.error("ai session rename failed", error);
      setSessionsStatus(error instanceof Error ? error.message : t("automation:renameFailed"));
    }
  }, [refreshSessions, renameDraft, renamingSessionId]);

  const removeSession = useCallback(async (targetSessionId: string) => {
    if (preview) return;
    try {
      if (targetSessionId === sessionIdRef.current) {
        clearAiTimers();
        if (isStreaming) await stopAiMessage(targetSessionId).catch((error) => logger.warn("ai stop before deleting session failed", error));
      }
      await deleteAiSession(targetSessionId);
      const nextSessions = sortAiSessions((await listAiSessions()) ?? []);
      setSessions(nextSessions);
      if (targetSessionId === sessionIdRef.current) {
        const deletedOrigin = sessions.find((session) => session.id === targetSessionId)?.origin ?? sessionHistoryTab;
        const next = nextSessions.find((session) => session.origin === deletedOrigin)
          ?? nextSessions.find((session) => session.origin === "user")
          ?? nextSessions[0];
        if (next) {
          const snapshot = await loadAiSession(next.id);
          if (snapshot) {
            setSessionId(snapshot.session.id);
            setSessionTitle(snapshot.session.title || t("automation:newSession"));
            setSessionHistoryTab(snapshot.session.origin);
            sessionIdRef.current = snapshot.session.id;
            setMessages(snapshotToUiMessages(snapshot));
          }
        } else {
          const snapshot = await createAiSession();
          if (snapshot) {
            setSessionId(snapshot.session.id);
            setSessionTitle(snapshot.session.title || t("automation:newSession"));
            setSessionHistoryTab("user");
            sessionIdRef.current = snapshot.session.id;
            setMessages(snapshotToUiMessages(snapshot));
            await refreshSessions();
          }
        }
        setStatus("idle");
        setInput("");
      }
      setDeleteSessionId(null);
    } catch (error) {
      logger.error("ai session delete failed", error);
      setSessionsStatus(error instanceof Error ? error.message : t("automation:deleteFailed"));
    }
  }, [clearAiTimers, isStreaming, preview, refreshSessions, sessionHistoryTab, sessions]);

  const insertSkillCommand = useCallback((skill: AiSkillDefinition) => {
    setInput(`/${skill.id} `);
    setSkillMenuOpen(false);
    setSkillSelectionIndex(0);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const stop = useCallback(async () => {
    clearAiTimers();
    if (!preview) await stopAiMessage(sessionIdRef.current);
    setStatus("stopped");
    setMessages((items) => updateLastAssistant(items, (message) => ({ ...message, status: "已停止" })));
  }, [clearAiTimers, preview]);

  const startDockDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (preview || event.button !== 0) return;
    const interactive = (event.target as HTMLElement).closest("button, input, select, textarea, a, [role='button']");
    if (interactive && interactive !== event.currentTarget) return;
    const rect = event.currentTarget.closest(".ai-dock")?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: rect.left,
      originY: rect.top,
      moved: false,
      source: event.currentTarget.classList.contains("ai-float") ? "float" : "panel"
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [preview]);

  const moveDock = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return;
    drag.moved = true;
    setDragging(true);
    setDockPosition(clampAiDockPosition({ x: drag.originX + deltaX, y: drag.originY + deltaY }));
  }, []);

  const finishDockDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setDragging(false);
    if (!drag.moved) return;
    if (drag.source === "float") suppressDockClickRef.current = true;
    const finalPosition = clampAiDockPosition({
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY
    });
    setDockPosition(finalPosition);
    try {
      window.localStorage.setItem(AI_DOCK_POSITION_KEY, JSON.stringify(finalPosition));
    } catch (error) {
      logger.warn("failed to persist AI dock position", { error: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const dockPlacement = useMemo(() => {
    if (!dockPosition || typeof window === "undefined") {
      return {
        opensLeft: true,
        opensAbove: true,
        maxWidth: typeof window === "undefined" ? 520 : Math.max(300, window.innerWidth - 24),
        maxHeight: typeof window === "undefined" ? 740 : Math.max(260, window.innerHeight - 24),
        style: undefined
      };
    }
    const opensLeft = dockPosition.x + AI_DOCK_SIZE / 2 >= window.innerWidth / 2;
    const opensAbove = dockPosition.y + AI_DOCK_SIZE / 2 >= window.innerHeight / 2;
    const panelWidth = Math.max(300, opensLeft ? dockPosition.x + AI_DOCK_SIZE - AI_DOCK_EDGE_GAP : window.innerWidth - dockPosition.x - AI_DOCK_EDGE_GAP);
    const panelHeight = Math.max(260, opensAbove ? dockPosition.y - AI_DOCK_EDGE_GAP : window.innerHeight - dockPosition.y - AI_DOCK_SIZE - AI_DOCK_EDGE_GAP);
    return {
      opensLeft,
      opensAbove,
      maxWidth: panelWidth,
      maxHeight: panelHeight,
      style: {
        left: dockPosition.x,
        top: dockPosition.y,
        right: "auto",
        bottom: "auto",
        "--ai-panel-max-width": `${panelWidth}px`,
        "--ai-panel-max-height": `${panelHeight}px`
      } as CSSProperties
    };
  }, [dockPosition]);

  const renderedPanelSize = useMemo(() => {
    if (!panelSize) return null;
    const minWidth = Math.min(sessionsOpen ? 680 : AI_PANEL_MIN_WIDTH, dockPlacement.maxWidth);
    const minHeight = Math.min(AI_PANEL_MIN_HEIGHT, dockPlacement.maxHeight);
    return {
      width: Math.min(dockPlacement.maxWidth, Math.max(minWidth, panelSize.width)),
      height: Math.min(dockPlacement.maxHeight, Math.max(minHeight, panelSize.height))
    };
  }, [dockPlacement.maxHeight, dockPlacement.maxWidth, panelSize, sessionsOpen]);

  const startPanelResize = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
    horizontal: -1 | 0 | 1,
    vertical: -1 | 0 | 1
  ) => {
    if (event.button !== 0) return;
    const panel = event.currentTarget.closest(".ai-panel");
    if (!(panel instanceof HTMLElement)) return;
    const rect = panel.getBoundingClientRect();
    const lastSize = { width: rect.width, height: rect.height };
    panelResizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originWidth: rect.width,
      originHeight: rect.height,
      horizontal,
      vertical,
      maxWidth: dockPlacement.maxWidth,
      maxHeight: dockPlacement.maxHeight,
      lastSize
    };
    setResizing(true);
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [dockPlacement.maxHeight, dockPlacement.maxWidth]);

  const movePanelResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = panelResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const width = resize.horizontal === 0
      ? resize.originWidth
      : resize.originWidth + (event.clientX - resize.startX) * resize.horizontal;
    const height = resize.vertical === 0
      ? resize.originHeight
      : resize.originHeight + (event.clientY - resize.startY) * resize.vertical;
    const next = {
      width: Math.min(resize.maxWidth, Math.max(AI_PANEL_MIN_WIDTH, width)),
      height: Math.min(resize.maxHeight, Math.max(AI_PANEL_MIN_HEIGHT, height))
    };
    resize.lastSize = next;
    setPanelSize(next);
  }, []);

  const finishPanelResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = panelResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    panelResizeRef.current = null;
    setResizing(false);
    setPanelSize(resize.lastSize);
    if (preview) return;
    try {
      window.localStorage.setItem(AI_PANEL_SIZE_KEY, JSON.stringify(resize.lastSize));
    } catch (error) {
      logger.warn("failed to persist AI panel size", { error: error instanceof Error ? error.message : String(error) });
    }
  }, [preview]);

  return (
    <div
      className={clsx(
        "ai-dock",
        open && "open",
        dragging && "dragging",
        resizing && "resizing",
        dockPlacement.opensLeft ? "panel-opens-left" : "panel-opens-right",
        dockPlacement.opensAbove ? "panel-opens-above" : "panel-opens-below"
      )}
      style={dockPlacement.style}
    >
      {open && (
        <section
          className={clsx("ai-panel", sessionsOpen && "sessions-open")}
          aria-label={t("automation:aiConversation")}
          style={renderedPanelSize ?? undefined}
        >
          <div
            className={clsx("ai-panel-resize", dockPlacement.opensLeft ? "ai-panel-resize-left" : "ai-panel-resize-right")}
            aria-hidden="true"
            onPointerDown={(event) => startPanelResize(event, dockPlacement.opensLeft ? -1 : 1, 0)}
            onPointerMove={movePanelResize}
            onPointerUp={finishPanelResize}
            onPointerCancel={finishPanelResize}
          />
          <div
            className={clsx("ai-panel-resize", dockPlacement.opensAbove ? "ai-panel-resize-top" : "ai-panel-resize-bottom")}
            aria-hidden="true"
            onPointerDown={(event) => startPanelResize(event, 0, dockPlacement.opensAbove ? -1 : 1)}
            onPointerMove={movePanelResize}
            onPointerUp={finishPanelResize}
            onPointerCancel={finishPanelResize}
          />
          <div
            className={clsx(
              "ai-panel-resize",
              "ai-panel-resize-corner",
              dockPlacement.opensLeft ? "left" : "right",
              dockPlacement.opensAbove ? "top" : "bottom"
            )}
            aria-hidden="true"
            onPointerDown={(event) => startPanelResize(
              event,
              dockPlacement.opensLeft ? -1 : 1,
              dockPlacement.opensAbove ? -1 : 1
            )}
            onPointerMove={movePanelResize}
            onPointerUp={finishPanelResize}
            onPointerCancel={finishPanelResize}
          />
          <aside className={clsx("ai-session-sidebar", sessionsOpen && "open")} aria-hidden={!sessionsOpen} inert={!sessionsOpen}>
            <div className="ai-session-list">
              <div className="ai-session-list-head">
                <strong>{t("automation:sessionHistory")}</strong>
                <div>
                  <button onClick={() => void refreshSessions()} disabled={preview} title={t("automation:refreshSessions")}>
                    {t("common:refresh")}
                  </button>
                  <button onClick={() => setSessionsOpen(false)} title={t("automation:collapseSessionList")} aria-label={t("automation:collapseSessionList")}>
                    <X size={14} />
                  </button>
                </div>
              </div>
              <div className="ai-session-tabs" role="tablist" aria-label={t("automation:sessionHistorySource")}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={sessionHistoryTab === "user"}
                  className={clsx(sessionHistoryTab === "user" && "active")}
                  onClick={() => setSessionHistoryTab("user")}
                >
                  {t("automation:userSessions")}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={sessionHistoryTab === "automation"}
                  className={clsx(sessionHistoryTab === "automation" && "active")}
                  onClick={() => setSessionHistoryTab("automation")}
                >
                  {t("automation:title")}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={sessionHistoryTab === "indicator"}
                  className={clsx(sessionHistoryTab === "indicator" && "active")}
                  onClick={() => setSessionHistoryTab("indicator")}
                >
                  {t("automation:indicatorSessions")}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={sessionHistoryTab === "strategy"}
                  className={clsx(sessionHistoryTab === "strategy" && "active")}
                  onClick={() => setSessionHistoryTab("strategy")}
                >
                  {t("automation:strategySessions")}
                </button>
              </div>
              {sessionsStatus && <small>{sessionsStatus}</small>}
              <div className="ai-session-items" role="tabpanel">
                {visibleSessions.length === 0 ? (
                  <p>{t(sessionEmptyCopyKey(sessionHistoryTab))}</p>
                ) : (
                  visibleSessions.map((session) => (
                    <div className={clsx("ai-session-item", session.id === sessionId && "active")} key={session.id}>
                      {renamingSessionId === session.id ? (
                        <input
                          value={renameDraft}
                          autoFocus
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void commitRenameSession();
                            if (event.key === "Escape") {
                              setRenamingSessionId(null);
                              setRenameDraft("");
                            }
                          }}
                          onBlur={() => void commitRenameSession()}
                        />
                      ) : (
                        <button className="ai-session-main" onClick={() => void switchSession(session.id)}>
                          <span data-i18n-skip>{session.title || t("automation:newSession")}</span>
                          <small>{formatAiSessionMeta(session, t)}</small>
                        </button>
                      )}
                      <div className="ai-session-actions">
                        <button onClick={() => startRenameSession(session)} title={t("automation:renameSession")}>
                          <Edit3 size={13} />
                        </button>
                        <button onClick={() => setDeleteSessionId(session.id)} title={t("common:delete")}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </aside>
          <div className="ai-panel-main">
            <header
              className="ai-panel-head"
              data-drag-handle="true"
              onPointerDown={startDockDrag}
              onPointerMove={moveDock}
              onPointerUp={finishDockDrag}
              onPointerCancel={finishDockDrag}
            >
            <div>
              <strong>{t("automation:tradingAssistant")}</strong>
              <span>{config ? `${chatModel?.model ?? config.model} · ${statusLabel(status, t)} · ${sessionTitle}` : t("automation:readingConfiguration")}</span>
            </div>
            <div className="ai-head-actions">
              <button className="window-button" onClick={() => void createNewSession()} disabled={preview || creatingSession} title={t("automation:newSession")}>
                <Plus size={15} />
              </button>
              <button
                className={clsx("window-button", sessionsOpen && "active")}
                onClick={() => {
                  void refreshSessions();
                  setSessionsOpen((value) => !value);
                }}
                title={t("automation:sessionList")}
                aria-expanded={sessionsOpen}
              >
                <History size={15} />
              </button>
              <button
                className="window-button"
                onClick={() => {
                  setSessionsOpen(false);
                  onOpenSettings?.();
                }}
                title={t("common:settings")}
              >
                <Settings size={15} />
              </button>
              <button className="window-button" onClick={() => !preview && setOpen(false)} title={t("automation:collapse")}>
                <X size={15} />
              </button>
            </div>
            </header>
            <div className="ai-provider">
            <span>{config?.baseUrl ?? t("automation:modelServiceDisconnected")}</span>
            <strong>{config?.configured ? config.apiKeyMasked : t("automation:notConfigured")}</strong>
            </div>
            <div className="ai-messages" ref={scrollRef}>
            {messages.map((message) => (
              <article className={clsx("ai-message", message.role)} key={message.id}>
                <div className="ai-message-role">{message.role === "user" ? t("automation:you") : "AI"}</div>
                <AiProcessTimeline
                  message={message}
                  now={aiClockNow}
                  onApprove={(approvalId, approved, reason) => void approveAiTool(sessionIdRef.current, approvalId, approved, reason)}
                  onOpenStrategy={onOpenStrategy}
                />
                <AiMessageError message={message} />
                {message.text && (
                  <div className="ai-answer">
                    {message.role === "assistant" && (message.tools.length > 0 || (message.agents?.length ?? 0) > 0) && <strong>{t("automation:analysisResult")}</strong>}
                    {message.role === "assistant" ? <MarkdownMessage content={message.text} /> : <p data-i18n-skip>{message.text}</p>}
                  </div>
                )}
                {message.role === "assistant" && message.usage ? <AiTokenUsageLine usage={message.usage} /> : null}
                {message.status && <span className="ai-message-status">{localizeAiMessageStatus(message.status)}</span>}
              </article>
            ))}
            </div>
            <div className="ai-input-row">
            {skillMenuOpen && (
              <div className="ai-skill-menu">
                <div className="ai-skill-menu-head">
                  <strong>{t("automation:selectSkill")}</strong>
                  <span>{t("automation:skillKeyboardHelp")}</span>
                </div>
                {filteredSkillOptions.length === 0 ? (
                  <p>{t("automation:noMatchingSkills")}</p>
                ) : (
                  filteredSkillOptions.map((skill, index) => (
                    <button
                      key={skill.id}
                      type="button"
                      className={clsx(index === skillSelectionIndex && "active")}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        insertSkillCommand(skill);
                      }}
                    >
                      <span>/{skill.id}</span>
                      <strong>{skill.name}</strong>
                      <small>{skill.description}</small>
                    </button>
                  ))
                )}
              </div>
            )}
            <div className="ai-composer">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (skillMenuOpen) {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setSkillSelectionIndex((index) => Math.min(index + 1, Math.max(filteredSkillOptions.length - 1, 0)));
                      return;
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setSkillSelectionIndex((index) => Math.max(index - 1, 0));
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setSkillMenuOpen(false);
                      return;
                    }
                    if (event.key === "Enter" && !event.shiftKey && filteredSkillOptions[skillSelectionIndex]) {
                      event.preventDefault();
                      insertSkillCommand(filteredSkillOptions[skillSelectionIndex]);
                      return;
                    }
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void submit();
                  }
                }}
                placeholder={t("automation:messagePlaceholder")}
              />
              <div className="ai-composer-toolbar">
                <div className="ai-composer-options">
                  <label data-i18n-skip title={t("automation:modelForThisTurn")}><Bot size={12} /><TerminalSelect ariaLabel={t("settings:aiModel")} value={chatModelId} disabled={isStreaming} options={(config?.models ?? []).map((model) => ({ value: model.id, label: model.name || model.model }))} onChange={setChatModelId} /></label>
                  <label title={t("automation:reasoningForThisTurn")}><SlidersHorizontal size={12} /><TerminalSelect ariaLabel={t("automation:reasoningDepth")} value={chatReasoningDepth} disabled={isStreaming} options={[{ value: "none", label: t("automation:reasoningNone") }, { value: "minimal", label: t("automation:reasoningMinimal") }, { value: "low", label: t("automation:reasoningLow") }, { value: "medium", label: t("automation:reasoningMedium") }, { value: "high", label: t("automation:reasoningHigh") }, { value: "xhigh", label: t("automation:reasoningXHigh") }]} onChange={(value) => setChatReasoningDepth(value as AiReasoningDepth)} /></label>
                  <label title={t("automation:permissionForThisTurn")}><ShieldCheck size={12} /><TerminalSelect ariaLabel={t("automation:aiPermission")} value={chatPermissionMode} disabled={isStreaming} options={[{ value: "advisor", label: t("settings:permissionAdvisor") }, { value: "copilot", label: t("settings:permissionCopilot") }, { value: "limited_auto", label: t("settings:permissionLimitedAutoShort") }]} onChange={(value) => setChatPermissionMode(value as AiPermissionMode)} /></label>
                </div>
                {isStreaming ? <button className="ai-send stop" onClick={() => void stop()} title={t("automation:stop")}><Square size={15} /></button> : <button className="ai-send" onClick={() => void submit()} disabled={!input.trim()} title={t("automation:send")}><Send size={15} /></button>}
              </div>
            </div>
            </div>
          </div>
        </section>
      )}
      <button
        className={clsx("ai-float", status)}
        aria-label={`${t("automation:aiAssistant")} · ${statusLabel(status, t)}`}
        title={`${t("automation:aiAssistant")} · ${statusLabel(status, t)} · ${t("automation:draggable")}`}
        onPointerDown={startDockDrag}
        onPointerMove={moveDock}
        onPointerUp={finishDockDrag}
        onPointerCancel={finishDockDrag}
        onClick={() => {
          if (suppressDockClickRef.current) {
            suppressDockClickRef.current = false;
            return;
          }
          if (!preview) setOpen((value) => !value);
        }}
      >
        <Bot size={17} />
        <span className="ai-float-status" aria-hidden="true" />
      </button>
      {deleteSessionId && (
        <ConfirmDialog
          title={t("automation:deleteAiSession")}
          message={t("automation:deleteAiSessionWarning")}
          confirmText={t("automation:deleteSession")}
          danger
          onCancel={() => setDeleteSessionId(null)}
          onConfirm={() => void removeSession(deleteSessionId)}
        />
      )}
    </div>
  );
}

const MemoAiDock = memo(AiDock);

function snapshotToUiMessages(snapshot: AiSessionSnapshot) {
  const mapped = snapshot.messages.map(storedMessageToUiMessage);
  const deduplicated = mapped.filter((message, index) => {
    const previous = mapped[index - 1];
    return !(
      message.role === "assistant"
      && message.error
      && previous?.role === "assistant"
      && previous.error
      && message.text === previous.text
      && message.errorMessage === previous.errorMessage
    );
  });
  if (deduplicated.length > 0) return deduplicated;
  return [
    {
      id: "welcome",
      role: "assistant" as const,
      text: "我是交易终端 AI 助手，可以协助分析行情、解释仓位和整理交易复盘。",
      tools: [],
      approvals: []
    }
  ];
}

function useRendererMemoryMonitor(scope: string, collect?: () => Record<string, unknown>, intervalMs = 60_000) {
  const collectRef = useRef(collect);
  const previousSampleRef = useRef<Record<string, unknown> | null>(null);
  useEffect(() => {
    collectRef.current = collect;
  }, [collect]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let tick = 0;
    const report = () => {
      const memory = readRendererMemory();
      const extra = collectRef.current?.() ?? {};
      const delta = diffRendererSample(previousSampleRef.current, extra);
      previousSampleRef.current = extra;
      logger.info("renderer memory sample", {
        scope,
        sample: tick,
        ...memory,
        ...extra,
        delta
      });
      tick += 1;
    };
    report();
    const timer = window.setInterval(report, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, scope]);
}

function countRendererEvent(ref: MutableRefObject<Record<string, number>>, key: string) {
  ref.current[key] = (ref.current[key] ?? 0) + 1;
}

function diffRendererSample(previous: Record<string, unknown> | null, current: Record<string, unknown>) {
  if (!previous) return {};
  const delta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    const oldValue = previous[key];
    if (typeof value === "number" && typeof oldValue === "number") {
      delta[key] = value - oldValue;
    } else if (isPlainNumberMap(value) && isPlainNumberMap(oldValue)) {
      const child: Record<string, number> = {};
      for (const childKey of new Set([...Object.keys(oldValue), ...Object.keys(value)])) {
        child[childKey] = (value[childKey] ?? 0) - (oldValue[childKey] ?? 0);
      }
      delta[key] = child;
    }
  }
  return delta;
}

function isPlainNumberMap(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((item) => typeof item === "number");
}

function readRendererMemory() {
  const performanceWithMemory = performance as Performance & {
    memory?: {
      usedJSHeapSize?: number;
      totalJSHeapSize?: number;
      jsHeapSizeLimit?: number;
    };
  };
  const memory = performanceWithMemory.memory;
  return {
    usedJsHeapMb: bytesToMb(memory?.usedJSHeapSize),
    totalJsHeapMb: bytesToMb(memory?.totalJSHeapSize),
    jsHeapLimitMb: bytesToMb(memory?.jsHeapSizeLimit),
    domNodes: document.getElementsByTagName("*").length
  };
}

function bytesToMb(value?: number) {
  return Number.isFinite(value) ? Math.round((Number(value) / 1024 / 1024) * 10) / 10 : undefined;
}

function summarizeAiDockMemory(messages: AiUiMessage[], extra: Record<string, unknown>) {
  let tools = 0;
  let agentTools = 0;
  let agents = 0;
  let timeline = 0;
  let approvals = 0;
  let teamEvents = 0;
  let textChars = 0;
  let reasoningChars = 0;
  let draftChars = 0;
  let toolResultChars = 0;
  for (const message of messages) {
    tools += message.tools?.length ?? 0;
    agents += message.agents?.length ?? 0;
    timeline += message.timeline?.length ?? 0;
    approvals += message.approvals?.length ?? 0;
    teamEvents += message.teamEvents?.length ?? 0;
    textChars += message.text?.length ?? 0;
    reasoningChars += message.reasoning?.length ?? 0;
    draftChars += message.draftText?.length ?? 0;
    for (const tool of message.tools ?? []) {
      toolResultChars += safeJson(tool.result)?.length ?? 0;
    }
    for (const agent of message.agents ?? []) {
      agentTools += agent.tools?.length ?? 0;
      toolResultChars += safeJson(agent.result)?.length ?? 0;
      for (const tool of agent.tools ?? []) {
        toolResultChars += safeJson(tool.result)?.length ?? 0;
      }
    }
  }
  return {
    ...extra,
    messages: messages.length,
    tools,
    agentTools,
    agents,
    timeline,
    approvals,
    teamEvents,
    textChars,
    reasoningChars,
    draftChars,
    toolResultChars
  };
}

function formatAmount(value?: string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  if (Math.abs(numeric) >= 1000) return numeric.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (Math.abs(numeric) >= 1) return numeric.toLocaleString("en-US", { maximumFractionDigits: 6 });
  return numeric.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function formatDuration(startedAt?: number, endedAt?: number) {
  if (!startedAt) return "";
  const end = endedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function formatEpisodeDuration(startedAt?: number, endedAt?: number, t?: UiTranslation) {
  if (!startedAt) return "--";
  const totalMinutes = Math.max(0, Math.round(((endedAt ?? Date.now()) - startedAt) / 60_000));
  if (totalMinutes < 60) return t ? t("trading:durationMinutes", { count: totalMinutes }) : `${totalMinutes} 分钟`;
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return t ? t("trading:durationDaysHours", { days, hours }) : `${days} 天 ${hours} 小时`;
  return minutes > 0
    ? t ? t("trading:durationHoursMinutes", { hours, minutes }) : `${hours} 小时 ${minutes} 分钟`
    : t ? t("trading:durationHours", { count: hours }) : `${hours} 小时`;
}

function formatDepthSize(value?: number) {
  if (!Number.isFinite(value)) return "--";
  const numeric = Number(value);
  if (Math.abs(numeric) >= 1000) return numeric.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (Math.abs(numeric) >= 1) return numeric.toLocaleString("en-US", { maximumFractionDigits: 3 });
  return numeric.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function formatUsdt(value?: number) {
  if (!Number.isFinite(value)) return "--";
  return `${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })} USDT`;
}

function formatNumber(value?: number | null) {
  if (!Number.isFinite(value)) return "--";
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function formatRate(value?: number | null) {
  if (!Number.isFinite(value)) return "--";
  return `${(Number(value) * 100).toFixed(4)}%`;
}

function formatAccountLevel(value?: string) {
  const map: Record<string, string> = {
    "1": "现货",
    "2": "合约",
    "3": "跨币种",
    "4": "组合保证金"
  };
  return map[value ?? ""] ?? value ?? "--";
}

function formatPositionMode(value?: string) {
  if (value === "long_short_mode") return "开平仓";
  if (value === "net_mode") return "买卖模式";
  return value || "--";
}

function formatLeverageRows(rows?: OkxLeverageInfo[] | null) {
  if (!rows?.length) return "--";
  return rows
    .map((row) => `${row.posSide || "net"} ${row.lever}X`)
    .join(" / ");
}

function dominantLeverageValue(rows?: OkxLeverageInfo[] | null) {
  const lever = rows?.find((row) => row.lever?.trim())?.lever?.trim();
  if (!lever) return null;
  const numeric = Number(lever);
  return Number.isFinite(numeric) ? String(numeric) : lever;
}

function mergeCandles(existing: Candle[], incoming: Candle[], maxItems = 5000) {
  if (incoming.length === 0) return existing;
  const map = new Map<number, Candle>();
  for (const candle of existing) map.set(candle.time, candle);
  for (const candle of incoming) map.set(candle.time, candle);
  return Array.from(map.values())
    .sort((a, b) => a.time - b.time)
    .slice(-maxItems);
}

type TradeActionSide = TradeTicketAction;

type OptimisticPendingOrder = OkxPendingOrder & {
  optimisticExpiresAt: number;
};

function pendingOrderKey(order: Pick<OkxPendingOrder, "ordId" | "clOrdId" | "algoId" | "algoClOrdId">) {
  return order.ordId || order.clOrdId || order.algoId || order.algoClOrdId || "";
}

function matchesPendingOrderTarget(
  order: Pick<OkxPendingOrder, "ordId" | "clOrdId" | "algoId" | "algoClOrdId">,
  target: Pick<OkxPendingOrder, "ordId" | "clOrdId" | "algoId" | "algoClOrdId">
) {
  const orderIds = [order.ordId, order.clOrdId, order.algoId, order.algoClOrdId].filter(Boolean);
  const targetIds = new Set([target.ordId, target.clOrdId, target.algoId, target.algoClOrdId].filter(Boolean));
  return orderIds.some((identifier) => targetIds.has(identifier));
}

function isTerminalPendingOrderState(state?: string | null) {
  return [
    "filled",
    "canceled",
    "cancelled",
    "failed",
    "rejected",
    "mmp_canceled",
    "order_failed",
    "effective",
    "triggered"
  ].includes(String(state ?? "").toLowerCase());
}

function isActivePendingOrder(order: OkxPendingOrder) {
  return !isTerminalPendingOrderState(order.state);
}

function mergeOptimisticPendingOrders(orders: OkxPendingOrder[], optimisticOrders: OptimisticPendingOrder[], now = Date.now()) {
  const existingKeys = new Set(orders.map(pendingOrderKey).filter(Boolean));
  const activeOrders = orders.filter(isActivePendingOrder);
  const optimistic = optimisticOrders.filter((order) => {
    const key = pendingOrderKey(order);
    return key && order.optimisticExpiresAt > now && !existingKeys.has(key) && isActivePendingOrder(order);
  });
  return [...activeOrders, ...optimistic];
}

function opportunityActionToOrderSide(action?: string, direction?: string) {
  const normalized = action || (direction === "short" ? "short" : "long");
  if (normalized === "short" || normalized === "close-long") return "sell";
  return "buy";
}

function opportunityActionToPosSide(action?: string, direction?: string) {
  const normalized = action || (direction === "short" ? "short" : "long");
  if (normalized === "short" || normalized === "close-short") return "short";
  return "long";
}

function optimisticPendingOrderFromOpportunity(item: TradeOpportunity | null | undefined): OptimisticPendingOrder | null {
  if (!item || item.status !== "executed" || item.orderType === "market") return null;
  if (item.intent === "cancel" || item.intent === "amend" || item.ticketMode === "manage") return null;
  const id = item.orderId || item.clientOrderId || item.algoId || item.algoClientOrderId;
  if (!id || !item.price) return null;
  const now = Date.now();
  return {
    instId: item.instId,
    instType: "SWAP",
    ordId: item.orderId ?? "",
    clOrdId: item.clientOrderId ?? "",
    algoId: item.algoId ?? undefined,
    algoClOrdId: item.algoClientOrderId ?? undefined,
    isAlgo: item.orderType === "trigger" || Boolean(item.algoId || item.algoClientOrderId),
    side: opportunityActionToOrderSide(item.action, item.direction),
    posSide: opportunityActionToPosSide(item.action, item.direction),
    tdMode: item.tdMode,
    ordType: item.orderType,
    px: item.price,
    sz: item.size ?? "",
    accFillSz: "0",
    avgPx: "",
    state: "live",
    lever: item.lever ?? "",
    reduceOnly: item.intent === "close" ? "true" : "false",
    cTime: String(now),
    uTime: String(now),
    optimisticExpiresAt: now + 45_000
  };
}

type TradePrecheck = {
  blocked: boolean;
  reasons: string[];
  notional?: number;
  estimatedMargin?: number;
  estimatedFee?: number;
  liquidationText: string;
  percentSizes: Record<number, string>;
  allowedSides: Record<TradeActionSide, boolean>;
  buttonReason: (side: TradeActionSide) => string;
};

type TradeLatencyGuard = {
  timeSynced: boolean;
  publicDelayMs?: number;
  privateDelayMs?: number;
  publicStatus: string;
  privateStatus: string;
  warnings: string[];
  liveBlockers: string[];
};

function buildTradeLatencyGuard(input: {
  timeSynced: boolean;
  publicDelayMs?: number;
  privateDelayMs?: number | null;
  publicStatus: string;
  privateStatus: string;
}): TradeLatencyGuard {
  const warnings: string[] = [];
  const liveBlockers: string[] = [];
  return {
    timeSynced: input.timeSynced,
    publicDelayMs: Number.isFinite(input.publicDelayMs) ? input.publicDelayMs : undefined,
    privateDelayMs: Number.isFinite(input.privateDelayMs) ? Number(input.privateDelayMs) : undefined,
    publicStatus: input.publicStatus,
    privateStatus: input.privateStatus,
    warnings,
    liveBlockers
  };
}

function buildTradePrecheck(input: {
  account?: AccountSummary;
  snapshot: PrivateAccountSnapshot | null;
  instrument?: OkxInstrumentSummary | null;
  symbol: string;
  ticketMode: "open" | "close";
  tradeEnvironment: "demo" | "live";
  privateStatus: string;
  latencyGuard: TradeLatencyGuard;
  price: string;
  size: string;
  leverage: string;
  orderType: OrderSpecV2OrderType;
  marginMode: "cross" | "isolated";
}): TradePrecheck {
  const usdtBalance = input.snapshot?.balances.find((balance) => balance.ccy === "USDT");
  const availableUsdt = Number(usdtBalance?.availEq || usdtBalance?.availBal || usdtBalance?.cashBal);
  const price = Number(input.price);
  const size = Number(input.size);
  const leverage = Number(input.leverage);
  const ctVal = Number(input.instrument?.ctVal);
  const contractValue = ctVal;
  const notional = price * size * contractValue;
  const estimatedMargin = Number.isFinite(notional) && Number.isFinite(leverage) && leverage > 0 ? notional / leverage : undefined;
  const feeRate = ["market", "ioc", "fok"].includes(input.orderType) ? 0.0005 : 0.0002;
  const estimatedFee = Number.isFinite(notional) ? notional * feeRate : undefined;
  const hasPreciseRiskData = false;
  const longPosition = input.snapshot?.positions.find((position) => position.instId === input.symbol && !isShortPosition(position) && Math.abs(Number(position.pos)) > 0);
  const shortPosition = input.snapshot?.positions.find((position) => position.instId === input.symbol && isShortPosition(position) && Math.abs(Number(position.pos)) > 0);
  const baseBlockers: string[] = [];
  const warnings: string[] = [];

  const requiresPrice = !["market", "trailing"].includes(input.orderType);
  const maxOrderSize = Number(input.orderType === "market" ? input.instrument?.maxMktSz : input.instrument?.maxLmtSz);
  const minSize = Number(input.instrument?.minSz);
  const lotSize = Number(input.instrument?.lotSz);
  const tickSize = Number(input.instrument?.tickSz);
  const maxLeverage = Number(input.instrument?.lever);

  if (!input.account) baseBlockers.push("未配置账号");
  if (input.account && !input.account.permissions.read) baseBlockers.push("账号未开启读取权限");
  if (input.account && !input.account.permissions.trade) baseBlockers.push("账号未开启交易权限");
  if (!input.instrument || input.instrument.instId !== input.symbol) baseBlockers.push("合约规则尚未加载");
  if (input.instrument && input.instrument.instType !== "SWAP") baseBlockers.push("当前仅支持永续合约");
  if (input.instrument && input.instrument.state !== "live") baseBlockers.push(`合约当前不可交易（${input.instrument.state || "unknown"}）`);
  if (input.instrument && (!Number.isFinite(ctVal) || ctVal <= 0)) baseBlockers.push("合约面值 ctVal 缺失或无效");
  if (requiresPrice && (!Number.isFinite(price) || price <= 0)) baseBlockers.push(input.orderType === "trigger" ? "触发价无效" : "价格无效");
  if (requiresPrice && Number.isFinite(price) && price > 0 && Number.isFinite(tickSize) && tickSize > 0 && !isTradeStepAligned(price, tickSize)) {
    baseBlockers.push(`价格须按 ${input.instrument?.tickSz} 档位输入`);
  }
  if (!Number.isFinite(size) || size <= 0) baseBlockers.push("请输入下单张数");
  if (Number.isFinite(size) && Number.isFinite(minSize) && minSize > 0 && size < minSize) baseBlockers.push(`最小下单数量为 ${input.instrument?.minSz} 张`);
  if (Number.isFinite(size) && Number.isFinite(lotSize) && lotSize > 0 && !isTradeStepAligned(size, lotSize)) baseBlockers.push(`数量须按 ${input.instrument?.lotSz} 张步进输入`);
  if (Number.isFinite(size) && Number.isFinite(maxOrderSize) && maxOrderSize > 0 && size > maxOrderSize) baseBlockers.push(`超过单笔最大 ${maxOrderSize} 张`);
  if (!Number.isFinite(leverage) || leverage <= 0) baseBlockers.push("杠杆无效");
  if (Number.isFinite(leverage) && Number.isFinite(maxLeverage) && maxLeverage > 0 && leverage > maxLeverage) baseBlockers.push(`超过合约最大 ${maxLeverage}X 杠杆`);
  if (Number(input.leverage) >= 50) warnings.push("杠杆较高，真实下单前需要后端二次确认");
  warnings.push(...input.latencyGuard.warnings);
  if (!hasPreciseRiskData) warnings.push("强平价等待后端风险数据精算");

  const baseAllowed = baseBlockers.length === 0;
  const allowedSides: Record<TradeActionSide, boolean> = {
    long: baseAllowed && input.ticketMode === "open",
    short: baseAllowed && input.ticketMode === "open",
    "close-long": baseAllowed && input.ticketMode === "close" && Boolean(longPosition),
    "close-short": baseAllowed && input.ticketMode === "close" && Boolean(shortPosition)
  };

  const percentSizes = Object.fromEntries(
    [25, 50, 75, 100].map((percent) => {
      if (input.ticketMode === "close") {
        return [percent, ""];
      }
      if (Number.isFinite(availableUsdt) && Number.isFinite(price) && price > 0 && Number.isFinite(leverage) && leverage > 0) {
        return [percent, normalizeTradeSizeInput(String((availableUsdt * leverage * (percent / 100)) / (price * contractValue)), input.instrument, { enforceMin: false })];
      }
      return [percent, ""];
    })
  ) as Record<number, string>;

  const reasons = Array.from(new Set([...baseBlockers, ...warnings]));
  return {
    blocked: baseBlockers.length > 0,
    reasons: reasons.length > 0 ? reasons : ["本地预检通过，等待后端合约规则复核"],
    notional: Number.isFinite(notional) ? notional : undefined,
    estimatedMargin,
    estimatedFee,
    liquidationText: hasPreciseRiskData ? "--" : "等待风险数据",
    percentSizes,
    allowedSides,
    buttonReason: (side) => {
      if (baseBlockers.length > 0) return baseBlockers[0];
      if (side === "close-long" && !longPosition) return "当前没有可平多仓";
      if (side === "close-short" && !shortPosition) return "当前没有可平空仓";
      return "本地预检通过，提交前需要后端风控复核";
    }
  };
}

function positionBaseCurrency(position: OkxPosition, instrument?: OkxInstrumentSummary) {
  return instrument?.baseCcy || position.instId.split("-")[0] || position.ccy || "";
}

function positionCoinAmount(position: OkxPosition, instrument?: OkxInstrumentSummary) {
  const contracts = Math.abs(Number(position.pos));
  const ctVal = Number(instrument?.ctVal);
  if (!Number.isFinite(contracts) || !Number.isFinite(ctVal) || ctVal <= 0) return undefined;
  return contracts * ctVal;
}

/** "drawdown" renders as the extreme of a loss so the palette stays red/green. */
type CellTone = "positive" | "negative" | "drawdown" | "active" | "warning" | "neutral" | "muted";

function toneByNumber(value?: string | number | null, neutralZero = true): CellTone {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "muted";
  if (numeric > 0) return "positive";
  if (numeric < 0) return "negative";
  return neutralZero ? "neutral" : "muted";
}

function toneByState(value?: string | null): CellTone {
  const state = String(value ?? "").toLowerCase();
  if (["live", "accepted", "filled", "updated", "closed", "effective"].includes(state)) return "active";
  if (["partially_filled", "partially_failed", "pending_retry", "blocked"].includes(state)) return "warning";
  if (["failed", "rejected", "canceled", "order_failed", "mmp_canceled"].includes(state)) return "negative";
  return "neutral";
}

/**
 * Colour for an order direction, matching the label it sits next to.
 *
 * The position side decides the tone, because that is the exposure the order acts
 * on: anything touching the long book is bullish-coloured and anything touching
 * the short book is bearish-coloured, whether it opens or closes. Testing `side`
 * first used to paint "close short" (a buy) as bullish, contradicting its own
 * label. Only net mode, which has no position side, falls back to buy/sell.
 */
function toneBySide(side?: string | null, posSide?: string | null): CellTone {
  const normalizedPosSide = String(posSide || "").toLowerCase();
  if (normalizedPosSide === "long") return "positive";
  if (normalizedPosSide === "short") return "negative";
  if (side === "buy") return "positive";
  if (side === "sell") return "negative";
  return "neutral";
}

function toneByFreshness(value?: number | string | null): CellTone {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "muted";
  const age = Date.now() - numeric;
  if (age < 60_000) return "active";
  if (age < 5 * 60_000) return "neutral";
  return "muted";
}

function liquidationRiskTone(position: OkxPosition, latest?: string): CellTone {
  const liq = Number(position.liqPx);
  const reference = Number(latest || position.markPx);
  if (!Number.isFinite(liq) || liq <= 0 || !Number.isFinite(reference) || reference <= 0) return "neutral";
  const distance = Math.abs(reference - liq) / reference;
  if (distance <= 0.03) return "negative";
  if (distance <= 0.08) return "warning";
  return "neutral";
}

function estimateOrderLinePnl(position: OkxPosition, price: number, size?: string, instrument?: OkxInstrumentSummary) {
  const qty = Number(size || position.pos || 0);
  const pnl = estimatePositionPnl(position, String(price), String(Math.min(Math.abs(qty), Math.abs(Number(position.pos || 0)))), instrument);
  const avg = Number(position.avgPx);
  if (!Number.isFinite(avg) || avg <= 0 || pnl === undefined) return { pnl, ratio: undefined };
  const isShort = isShortPosition(position);
  const ratio = ((isShort ? avg - price : price - avg) / avg) * 100;
  return { pnl, ratio };
}

function findChartOrderLinePosition(
  positions: OkxPosition[],
  symbol: string,
  side?: string,
  posSide?: string
) {
  const activePositions = positions.filter((position) => position.instId === symbol && Math.abs(Number(position.pos)) > 0);
  const normalizedPosSide = posSide && posSide !== "net" ? normalizeUiPosSide(posSide) : side === "buy" ? "short" : "long";
  return activePositions.find((position) => normalizeUiPosSide(position.posSide) === normalizedPosSide) ?? activePositions[0];
}

function isActiveAlgoOrder(order: OkxAlgoOrder) {
  const state = String(order.state || "").toLowerCase();
  if (
    [
      "canceled",
      "cancelled",
      "effective",
      "order_failed",
      "failed",
      "filled",
      "triggered",
    ].includes(state)
  )
    return false;
  if (order.sourceEndpoint === "orders-algo-history") return false;
  return (
    order.sourceEndpoint === "orders-algo-pending" ||
    order.sourceEndpoint === "private-snapshot" ||
    state === "live" ||
    state === "partially_effective"
  );
}

function isChartAlgoOrderLine(line: ChartOrderLine) {
  return line.source === "algo"
    || Boolean(line.algoId || line.algoClientOrderId)
    || line.editKind === "algo-trigger"
    || line.editKind === "algo-tp"
    || line.editKind === "algo-sl";
}

function buildChartOrderLines({
  symbol,
  orders,
  algoOrders,
  positions,
  instrument,
  overrides = {},
  translate
}: {
  symbol: string;
  orders: OkxPendingOrder[];
  algoOrders: OkxAlgoOrder[];
  positions: OkxPosition[];
  instrument?: OkxInstrumentSummary;
  overrides?: Record<string, { price: number; expiresAt: number }>;
  translate: UiTranslation;
}): ChartOrderLine[] {
  const lines: ChartOrderLine[] = [];
  const lineKeys = new Set<string>();
  const pendingAlgoKeys = new Set(
    algoOrders
      .filter((order) => order.instId === symbol && isActiveAlgoOrder(order))
      .flatMap((order) => [order.algoId, order.algoClOrdId])
      .filter((value): value is string => Boolean(value))
  );
  const activePositions = positions.filter((position) => position.instId === symbol && Math.abs(Number(position.pos)) > 0);
  const addLine = (input: {
    id: string;
    type: ChartOrderLine["type"];
    priceText?: string;
    triggerPriceText?: string;
    orderPriceText?: string;
    side?: string;
    posSide?: string;
    size?: string;
    orderId?: string;
    clientOrderId?: string;
    algoId?: string;
    algoClientOrderId?: string;
    fallbackLabel: string;
    source?: ChartOrderLine["source"];
  }) => {
    const lineId = input.id;
    const override = overrides[lineId];
    const price = Number(override?.price ?? input.priceText);
    if (!Number.isFinite(price) || price <= 0) return;
    const sourceKey = input.algoId || input.algoClientOrderId || input.orderId || input.clientOrderId || input.id;
    const dedupeKey = `${input.type}:${sourceKey}:${price}`;
    if (lineKeys.has(dedupeKey)) return;
    lineKeys.add(dedupeKey);
    const position = findChartOrderLinePosition(positions, symbol, input.side, input.posSide);
    const estimate = position ? estimateOrderLinePnl(position, price, input.size, instrument) : { pnl: undefined, ratio: undefined };
    const estimateSize = position
      ? Math.min(Math.abs(Number(input.size || position.pos || 0)), Math.abs(Number(position.pos || 0)))
      : undefined;
    const visual = chartOrderVisual(input.type, input);
    const tone = visual.tone;
    const color = visual.color;
    const editable =
      input.type === "limit"
        ? Boolean(input.orderId || input.clientOrderId)
        : input.type === "trigger"
          ? Boolean(input.algoId || input.algoClientOrderId)
        : input.type === "tp" || input.type === "sl"
          ? Boolean(input.algoId || input.algoClientOrderId)
          : false;
    lines.push({
      id: lineId,
      instId: symbol,
      type: input.type,
      source: input.source,
      label: formatOrderLineLabel(input.fallbackLabel, estimate.pnl, estimate.ratio),
      price,
      side: input.side,
      posSide: input.posSide,
      estimatedPnl: estimate.pnl,
      estimatedPnlRatio: estimate.ratio,
      estimateEntryPrice: Number(position?.avgPx) || undefined,
      estimateSize: estimateSize && Number.isFinite(estimateSize) ? estimateSize : undefined,
      estimateContractValue: Number(instrument?.ctVal) || undefined,
      color,
      tone,
      editable,
      editKind: editable ? (input.type === "limit" ? "order-price" : input.type === "trigger" ? "algo-trigger" : input.type === "tp" ? "algo-tp" : input.type === "sl" ? "algo-sl" : undefined) : undefined,
      triggerPrice: Number(input.triggerPriceText ?? input.priceText) || undefined,
      orderPrice: input.orderPriceText === "-1" ? null : Number(input.orderPriceText) || undefined,
      orderId: input.orderId,
      clientOrderId: input.clientOrderId,
      algoId: input.algoId,
      algoClientOrderId: input.algoClientOrderId,
      size: input.size
    });
  };
  const addPositionLine = (input: {
    id: string;
    type: Extract<ChartOrderLine["type"], "liquidation">;
    priceText?: string;
    position: OkxPosition;
    label: string;
    color: string;
    tone: ChartOrderLine["tone"];
  }) => {
    const price = Number(input.priceText);
    if (!Number.isFinite(price) || price <= 0) return;
    lines.push({
      id: input.id,
      type: input.type,
      source: "position",
      label: input.label,
      price,
      posSide: input.position.posSide,
      color: input.color,
      tone: input.tone
    });
  };

  for (const position of activePositions) {
    const sideLabel = chartPositionLabel(position.posSide, position.pos, translate);
    const positionKey = position.posId || `${position.instId}-${position.posSide}`;
    addPositionLine({
      id: `position-liq-${positionKey}`,
      type: "liquidation",
      priceText: position.liqPx,
      position,
      label: `${sideLabel} · ${translate("trading:liquidationPrice")}`,
      color: "#f59e0b",
      tone: "warning"
    });
  }

  for (const order of orders) {
    if (order.instId !== symbol) continue;
    if (!isActivePendingOrder(order)) continue;
    const id = order.ordId || order.clOrdId || order.algoId || order.algoClOrdId;
    if (!id) continue;
    const type = order.isAlgo || order.ordType === "trigger" ? "trigger" : "limit";
    if (order.ordType === "limit" || order.ordType === "trigger" || order.isAlgo) {
      addLine({
        id: `order-${id}`,
        type,
        priceText: type === "trigger" ? order.triggerPx || order.px : order.px,
        triggerPriceText: type === "trigger" ? order.triggerPx || order.px : undefined,
        orderPriceText: type === "trigger" ? order.ordPx : undefined,
        side: order.side,
        posSide: order.posSide,
        size: order.sz,
        orderId: order.ordId,
        clientOrderId: order.clOrdId,
        algoId: order.algoId,
        algoClientOrderId: order.algoClOrdId,
        fallbackLabel: formatChartOrderLabel(type, order, order.sz, translate),
        source: order.isAlgo ? "algo" : "order"
      });
    }
    const hasPendingAlgoSource = Boolean((order.algoId && pendingAlgoKeys.has(order.algoId)) || (order.algoClOrdId && pendingAlgoKeys.has(order.algoClOrdId)));
    if (!hasPendingAlgoSource) {
      addLine({
        id: `order-${id}-tp`,
        type: "tp",
        priceText: order.tpTriggerPx,
        side: order.side,
        posSide: order.posSide,
        size: order.sz,
        orderId: order.ordId,
        clientOrderId: order.clOrdId,
        algoId: order.algoId,
        algoClientOrderId: order.algoClOrdId,
        fallbackLabel: formatChartOrderLabel("tp", order, order.sz, translate),
        source: order.algoId || order.algoClOrdId ? "algo" : "order"
      });
      addLine({
        id: `order-${id}-sl`,
        type: "sl",
        priceText: order.slTriggerPx,
        side: order.side,
        posSide: order.posSide,
        size: order.sz,
        orderId: order.ordId,
        clientOrderId: order.clOrdId,
        algoId: order.algoId,
        algoClientOrderId: order.algoClOrdId,
        fallbackLabel: formatChartOrderLabel("sl", order, order.sz, translate),
        source: order.algoId || order.algoClOrdId ? "algo" : "order"
      });
    }
  }

  for (const order of algoOrders) {
    if (order.instId !== symbol || !isActiveAlgoOrder(order)) continue;
    const id = order.algoId || order.algoClOrdId || `${order.instId}-${order.cTime}`;
    addLine({
      id: `algo-${id}-tp`,
      type: "tp",
      priceText: order.tpTriggerPx,
      side: order.side,
      posSide: order.posSide,
      size: order.sz,
      algoId: order.algoId,
      algoClientOrderId: order.algoClOrdId,
      fallbackLabel: formatChartOrderLabel("tp", order, order.sz, translate),
      source: "algo"
    });
    addLine({
      id: `algo-${id}-sl`,
      type: "sl",
      priceText: order.slTriggerPx,
      side: order.side,
      posSide: order.posSide,
      size: order.sz,
      algoId: order.algoId,
      algoClientOrderId: order.algoClOrdId,
      fallbackLabel: formatChartOrderLabel("sl", order, order.sz, translate),
      source: "algo"
    });
  }

  return lines;
}

function formatOrderLineLabel(label: string, pnl?: number, ratio?: number) {
  if (!Number.isFinite(pnl) || !Number.isFinite(ratio)) return label;
  const sign = Number(pnl) >= 0 ? "+" : "";
  return `${label} ${sign}${formatAmount(trimFloat(Number(pnl)))}U ${sign}${Number(ratio).toFixed(2)}%`;
}

function buildChartPositionRanges(symbol: string, positions: OkxPosition[], ticker: Ticker | null, algoOrders: OkxAlgoOrder[], instrument: OkxInstrumentSummary | undefined, t: UiTranslation): ChartPositionRange[] {
  const pendingAlgos = algoOrders.filter((order) => order.instId === symbol && isActiveAlgoOrder(order));
  const contractValue = Number(instrument?.ctVal);
  const normalizedContractValue = Number.isFinite(contractValue) && contractValue > 0 ? contractValue : 1;
  return positions
    .filter((position) => position.instId === symbol && Math.abs(Number(position.pos)) > 0)
    .map((position) => {
      const entryPrice = Number(position.avgPx);
      const markPrice = Number(position.markPx);
      const tickerPrice = Number(ticker?.last);
      const currentPrice = Number.isFinite(markPrice) && markPrice > 0 ? markPrice : tickerPrice;
      const existingAlgos: ChartPositionRange["existingAlgos"] = [];
      for (const order of pendingAlgos) {
        if (normalizeUiPosSide(order.posSide) !== normalizeUiPosSide(position.posSide)) continue;
        if (order.tpTriggerPx) existingAlgos.push({ side: "tp", algoId: order.algoId, algoClientOrderId: order.algoClOrdId });
        if (order.slTriggerPx) existingAlgos.push({ side: "sl", algoId: order.algoId, algoClientOrderId: order.algoClOrdId });
      }
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
        label: formatChartPosition(position.posSide, position.pos, t),
        existingAlgos
      };
    })
    .filter((range) => Number.isFinite(range.entryPrice) && range.entryPrice > 0 && Number.isFinite(range.currentPrice) && range.currentPrice > 0);
}

function closablePositionSize(snapshot: PrivateAccountSnapshot | null, symbol: string, posSide: "long" | "short") {
  const position = snapshot?.positions.find((item) => item.instId === symbol && normalizeUiPosSide(item.posSide) === posSide && Math.abs(Number(item.pos)) > 0);
  const size = Math.abs(Number(position?.pos || 0));
  return Number.isFinite(size) ? size : 0;
}

function trimTradeSize(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function trimFloat(value: number) {
  if (!Number.isFinite(value)) return "";
  return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function isTradeStepAligned(value: number, step: number) {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return false;
  const units = value / step;
  return Math.abs(units - Math.round(units)) <= Math.max(1, Math.abs(units)) * Number.EPSILON * 16;
}

function decimalPlacesFromStep(stepText?: string) {
  const text = String(stepText ?? "").trim();
  if (!text.includes(".")) return 0;
  return text.replace(/0+$/, "").split(".")[1]?.length ?? 0;
}

function normalizeTradeSizeInput(value: string, instrument?: { minSz?: string; lotSz?: string } | null, options: { max?: string | number; enforceMin?: boolean } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || !instrument) return value;
  const min = Number(instrument.minSz);
  const lot = Number(instrument.lotSz);
  if (!Number.isFinite(lot) || lot <= 0) return value;
  const max = Number(options.max);
  const capped = Number.isFinite(max) && max > 0 ? Math.min(numeric, max) : numeric;
  const roundedDown = Math.floor((capped + Number.EPSILON) / lot) * lot;
  if (roundedDown <= 0) return "";
  const enforceMin = options.enforceMin !== false;
  if (enforceMin && Number.isFinite(min) && min > 0 && roundedDown < min) {
    return min > capped ? "" : formatTradeStepValue(min, instrument);
  }
  if (!enforceMin && Number.isFinite(min) && min > 0 && roundedDown < min) return "";
  return formatTradeStepValue(roundedDown, instrument);
}

function formatTradeStepValue(value: number, instrument?: { minSz?: string; lotSz?: string } | null) {
  const decimals = Math.max(decimalPlacesFromStep(instrument?.lotSz), decimalPlacesFromStep(instrument?.minSz));
  return value.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
}

function normalizeTradePriceInput(value: string | number, instrument?: { tickSz?: string } | null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  const tick = Number(instrument?.tickSz);
  if (!Number.isFinite(tick) || tick <= 0) return trimFloat(numeric);
  const rounded = Math.round((numeric + Number.EPSILON) / tick) * tick;
  const decimals = decimalPlacesFromStep(instrument?.tickSz);
  return rounded.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
}

function formatRatio(value?: string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  return `${(numeric * 100).toFixed(2)}%`;
}

function formatFundingRatePercent(value?: string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "";
  return `${(numeric * 100).toFixed(4)}%`;
}

function formatFundingCountdown(fundingTime?: number, nowMs = Date.now()) {
  const target = Number(fundingTime);
  if (!Number.isFinite(target) || target <= 0) return "--:--:--";
  const remaining = Math.max(0, target - nowMs);
  if (remaining <= 0) return "结算中";
  const totalSeconds = Math.floor(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatMs(value?: string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "--";
  return new Intl.DateTimeFormat(resolvedLocale(), { timeZone: DISPLAY_TIME_ZONE, hour12: false }).format(new Date(numeric));
}

function formatTradeMs(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "--";
  return new Intl.DateTimeFormat(resolvedLocale(), {
    timeZone: DISPLAY_TIME_ZONE,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3
  }).format(new Date(value));
}

function formatKlineInvalidReasons(reasons?: string[], chineseUi = true) {
  if (!reasons?.length) return "";
  const items = reasons.slice(0, 2).map((reason) =>
    reason.replace(/\b(\d{13})\b/g, (_, value) => formatDateTime(Number(value)))
  );
  const suffix = reasons.length > items.length
    ? chineseUi ? ` 等 ${reasons.length} 条原因` : ` and ${reasons.length - items.length} more`
    : "";
  return chineseUi ? `原因：${items.join("；")}${suffix}` : `Reasons: ${items.join("; ")}${suffix}`;
}

function formatDateTime(value?: number | string | null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "--";
  return new Intl.DateTimeFormat(resolvedLocale(), { timeZone: DISPLAY_TIME_ZONE, dateStyle: "short", timeStyle: "medium", hour12: false }).format(new Date(numeric));
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatKlineRangeText(range?: { firstTime?: number | null; lastTime?: number | null; count?: number; interval?: string } | null, mode: "short" | "full" = "full") {
  if (!range || !range.firstTime || !range.lastTime || !range.count) return "";
  const formatDate = (value: number) =>
    formatLocalizedDate(value, {
      timeZone: DISPLAY_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).replace(/\//g, "-");
  const dateRange = `${formatDate(range.firstTime)} 至 ${formatDate(range.lastTime)}`;
  if (mode === "short") return dateRange;
  return `${dateRange} · ${range.interval ?? "1m"} · ${formatLocalizedNumber(range.count)} 根`;
}

function formatPositionSide(value: string, t?: UiTranslation) {
  if (value === "long") return t ? t("trading:positionLong") : "多";
  if (value === "short") return t ? t("trading:positionShort") : "空";
  if (value === "net") return t ? t("trading:netPosition") : "净持仓";
  return value || "--";
}

function normalizeUiPosSide(value: string): "long" | "short" | "net" {
  if (value === "short") return "short";
  if (value === "net") return "net";
  return "long";
}

function isShortPosition(position: Pick<OkxPosition, "posSide" | "pos">) {
  const posSide = normalizeUiPosSide(position.posSide);
  return posSide === "short" || (posSide === "net" && Number(position.pos) < 0);
}

function normalizeMarginMode(value: string): "cross" | "isolated" {
  return value === "isolated" ? "isolated" : "cross";
}

function formatAlgoOrderType(value: string, t?: UiTranslation) {
  if (value === "oco") return t ? t("trading:ocoOrder") : "双向止盈止损";
  if (value === "conditional") return t ? t("trading:conditionalOrder") : "止盈止损";
  if (value === "trigger") return t ? t("trading:triggerOrder") : "计划委托";
  return value || "--";
}

function formatPositionLineIntentKind(value: PositionLineTradeIntent["kind"], t?: UiTranslation) {
  if (value === "limit_close") return t ? t("trading:limitClosePosition") : "限价平仓";
  if (value === "take_profit") return t ? t("trading:takeProfit") : "止盈";
  if (value === "trailing_profit") return t ? t("trading:trailingTakeProfit") : "回撤止盈";
  if (value === "stop_loss") return t ? t("trading:stopLoss") : "止损";
  return t ? t("trading:marketClosePosition") : "市价平仓";
}

function formatAlgoState(value: string, t?: UiTranslation) {
  if (value === "live") return t ? t("trading:notTriggered") : "未触发";
  if (value === "effective") return t ? t("trading:effective") : "已生效";
  if (value === "canceled") return t ? t("trading:canceled") : "已撤销";
  if (value === "order_failed") return t ? t("trading:orderFailed") : "委托失败";
  if (value === "partially_failed") return t ? t("trading:partiallyFailed") : "部分失败";
  return value || "--";
}

function formatAlgoExecPrice(value?: string, t?: UiTranslation) {
  if (!value) return "--";
  if (value === "-1") return t ? t("trading:market") : "市价";
  return fmtPrice(value);
}

function formatTriggerPriceType(value?: string, t?: UiTranslation) {
  if (value === "last") return t ? t("trading:lastPrice") : "最新价";
  if (value === "index") return t ? t("trading:indexPrice") : "指数价";
  if (value === "mark") return t ? t("trading:markPrice") : "标记价";
  return value || "--";
}

function estimatePositionPnl(position: OkxPosition, targetPrice?: string, size?: string, instrument?: OkxInstrumentSummary) {
  const avg = Number(position.avgPx || 0);
  const target = Number(targetPrice || 0);
  const qty = Number(size || 0);
  const ctVal = Number(instrument?.ctVal);
  if (!avg || !target || !qty || !Number.isFinite(ctVal) || ctVal <= 0) return undefined;
  const isShort = isShortPosition(position);
  return (isShort ? avg - target : target - avg) * qty * ctVal;
}

function defaultTpTrigger(position: OkxPosition, latest?: string) {
  const base = Number(position.avgPx || latest || 0);
  if (!base) return "";
  const isShort = isShortPosition(position);
  return trimFloat(base * (isShort ? 0.95 : 1.05));
}

function defaultSlTrigger(position: OkxPosition, latest?: string) {
  const base = Number(position.avgPx || latest || 0);
  if (!base) return "";
  const isShort = isShortPosition(position);
  return trimFloat(base * (isShort ? 1.05 : 0.95));
}

/**
 * Order direction as the intent behind it, not the raw exchange fields.
 *
 * "Sell/short" did not tell a trader whether they were entering or exiting: in
 * OKX hedge mode `side` and `posSide` together decide that. Buying the long book
 * opens a long and selling it closes one; selling the short book opens a short
 * and buying it closes one. Net mode carries no position side, so it keeps the
 * plain buy/sell wording rather than inventing an intent it cannot know.
 */
function formatOrderSide(side: string, posSide: string, t?: UiTranslation) {
  const normalizedSide = String(side || "").toLowerCase();
  const normalizedPosSide = String(posSide || "").toLowerCase();
  const label = (key: string, fallback: string) => (t ? t(`trading:${key}`) : fallback);

  if (normalizedPosSide === "long" || normalizedPosSide === "short") {
    if (normalizedPosSide === "long") {
      return normalizedSide === "buy"
        ? label("orderOpenLong", "做多")
        : label("orderCloseLong", "平多");
    }
    return normalizedSide === "sell"
      ? label("orderOpenShort", "做空")
      : label("orderCloseShort", "平空");
  }

  if (normalizedSide === "buy") return label("buy", "买");
  if (normalizedSide === "sell") return label("sell", "卖");
  return side || "--";
}

function formatOrderType(value: string, t?: UiTranslation) {
  const map: Record<string, string> = {
    limit: t ? t("trading:limit") : "限价",
    market: t ? t("trading:market") : "市价",
    trigger: t ? t("trading:triggerOrder") : "计划委托",
    cancel: t ? t("trading:cancelOrder") : "撤单",
    amend: t ? t("trading:amendOrder") : "改单",
    post_only: "Post Only",
    fok: "FOK",
    ioc: "IOC"
  };
  return map[value] ?? value ?? "--";
}

function formatOrderState(value: string, t?: UiTranslation) {
  const map: Record<string, string> = {
    live: t ? t("trading:working") : "挂单中",
    partially_filled: t ? t("trading:partiallyFilled") : "部分成交",
    filled: t ? t("trading:filled") : "已成交",
    canceled: t ? t("trading:canceled") : "已撤销",
    mmp_canceled: t ? t("trading:mmpCanceled") : "MMP 撤单"
  };
  return map[value] ?? value ?? "--";
}

function formatTradeAuditEvent(value: string, t?: UiTranslation) {
  const map: Record<string, string> = {
    order_submit: t ? t("trading:auditSubmit") : "提交",
    order_cancel: t ? t("trading:auditCancel") : "撤单",
    order_fill: t ? t("trading:auditFill") : "成交",
    position_episode: t ? t("trading:auditPosition") : "仓位",
    risk_setting: t ? t("trading:auditRiskSetting") : "风控设置"
  };
  return map[value] ?? value ?? "--";
}

function formatTradeAuditOperation(value: string, t?: UiTranslation) {
  const map: Record<string, string> = {
    trade_precheck: t ? t("trading:auditTradePrecheck") : "风控预检",
    place_order: t ? t("trading:auditPlaceOrder") : "普通下单",
    place_algo_order: t ? t("trading:triggerOrder") : "计划委托",
    cancel_order: t ? t("trading:auditCancelOrder") : "普通撤单",
    cancel_algo_order: t ? t("trading:auditCancelAlgo") : "撤销计划",
    okx_fill: t ? t("trading:auditFillReport") : "成交回报",
    episode_open: t ? t("trading:auditPositionOpen") : "仓位开仓",
    episode_add: t ? t("trading:auditPositionAdd") : "仓位加仓",
    episode_reduce: t ? t("trading:auditPositionReduce") : "仓位减仓",
    episode_close: t ? t("trading:auditPositionClose") : "仓位平仓",
    set_leverage: t ? t("trading:auditSetLeverage") : "设置杠杆"
  };
  return map[value] ?? value ?? "--";
}

function formatTradeAuditStatus(value: string, t?: UiTranslation) {
  const map: Record<string, string> = {
    accepted: t ? t("trading:accepted") : "已接受",
    rejected: t ? t("trading:rejected") : "已拒绝",
    blocked: t ? t("trading:blocked") : "已拦截",
    failed: t ? t("common:failed") : "失败",
    filled: t ? t("trading:filled") : "已成交",
    updated: t ? t("trading:updated") : "已更新",
    closed: t ? t("trading:episodeClosed") : "已完结"
  };
  return map[value] ?? value ?? "--";
}

function tradeAuditStatusClass(value: string) {
  if (["accepted", "filled", "updated", "closed"].includes(value)) return "up";
  if (value === "rejected" || value === "blocked" || value === "failed") return "down";
  return "";
}

function tradeAuditNotification(event: TradeAuditEventSummary, accountName?: string, t?: UiTranslation): Omit<AppNotification, "id" | "createdAt"> | null {
  const isFresh = Math.abs(Date.now() - event.createdAt) < 15_000;
  const status = event.status.toLowerCase();
  const operation = event.operation.toLowerCase();
  if (!isFresh || operation === "okx_fill" || event.eventType === "position_episode") return null;

  const side = formatOrderSide(event.side ?? "", event.posSide ?? "", t);
  const qty = event.size ? ` ${formatAmount(event.size)}` : "";
  const price = event.price ? ` @ ${fmtPrice(event.price)}` : "";
  const actor = formatEpisodeOrigin(event.operator || "unknown", t);
  const accountPart = accountName ? `${accountName} · ` : "";
  const symbolPart = event.instId ? `${event.instId} ` : "";
  const reason = event.okxMessage || event.error || event.okxCode || "";
  const base = `${accountPart}${symbolPart}${side}${qty}${price}`.trim();

  if (status === "blocked") {
    return {
      kind: "warning",
      title: t ? t("automation:tradeRiskBlocked") : "交易风控已拦截",
      message: reason ? `${base}${t && !isChineseLanguage() ? ": " : "："}${reason}` : t ? t("automation:tradeRiskBlockedMessage", { base }) : `${base} 未通过下单前风控。`
    };
  }
  if (status === "rejected" || status === "failed") {
    return {
      kind: "error",
      title: t ? t("automation:tradeOperationFailed", { operation: formatTradeAuditOperation(event.operation, t) }) : `${formatTradeAuditOperation(event.operation)}失败`,
      message: reason ? `${base}${!isChineseLanguage() ? ": " : "："}${reason}` : t ? t("automation:tradeOperationRejectedMessage", { base }) : `${base} 已被 OKX 或本地交易层拒绝。`
    };
  }
  if (operation === "set_leverage") {
    return {
      kind: "success",
      title: t ? t("automation:leverageChangeRecorded") : "杠杆设置已记录",
      message: t ? t("automation:leverageChangeRecordedMessage", { base: `${accountPart}${event.instId} ${event.tdMode || ""} ${event.price || event.size || ""}`.trim(), operator: actor }) : `${accountPart}${event.instId} ${event.tdMode || ""} ${event.price || event.size || ""}，操作员 ${actor}。`
    };
  }
  if (operation.includes("cancel")) {
    return {
      kind: "trade",
      title: t ? t("automation:cancelRequestSubmitted") : "撤单请求已提交",
      message: t ? t("automation:tradeAuditSubmittedMessage", { base: base || event.instId, order: event.orderId || event.clientOrderId || "--", operator: actor }) : `${base || event.instId}，订单 ${event.orderId || event.clientOrderId || "--"}，操作员 ${actor}。`
    };
  }
  if (status === "accepted") {
    return {
      kind: "trade",
      title: t ? t("automation:tradeOperationSubmitted", { operation: formatTradeAuditOperation(event.operation, t) }) : `${formatTradeAuditOperation(event.operation)}已提交`,
      message: t ? t("automation:tradeAuditSubmittedMessage", { base, order: event.orderId || event.clientOrderId || "--", operator: actor }) : `${base}，订单 ${event.orderId || event.clientOrderId || "--"}，操作员 ${actor}。`
    };
  }
  return null;
}

function compactJson(value?: string | null) {
  if (!value) return "--";
  try {
    const parsed = JSON.parse(value);
    const compact = JSON.stringify(parsed);
    return compact.length > 72 ? `${compact.slice(0, 72)}...` : compact;
  } catch {
    return value.length > 72 ? `${value.slice(0, 72)}...` : value;
  }
}

function formatFillSubType(value: string, t?: UiTranslation) {
  const map: Record<string, string> = {
    "3": t ? t("trading:openLong") : "开多",
    "4": t ? t("trading:openShort") : "开空",
    "5": t ? t("trading:closeLong") : "平多",
    "6": t ? t("trading:closeShort") : "平空",
    "100": t ? t("trading:forcedReduction") : "强减",
    "101": t ? t("trading:liquidation") : "强平",
    "102": t ? t("trading:delivery") : "交割",
    "103": "ADL"
  };
  return map[value] ?? (value || "--");
}

function formatBillType(value: string, t?: UiTranslation) {
  const map: Record<string, string> = {
    "1": t ? t("trading:transfer") : "划转",
    "2": t ? t("trading:trade") : "交易",
    "3": t ? t("trading:delivery") : "交割",
    "4": t ? t("trading:autoConvert") : "自动换币",
    "5": t ? t("trading:liquidation") : "强平",
    "6": t ? t("trading:marginTransfer") : "保证金划转",
    "7": t ? t("trading:interestDeduction") : "扣息",
    "8": t ? t("trading:fundingFee") : "资金费",
    "9": "ADL",
    "10": t ? t("trading:optionExercise") : "期权行权"
  };
  return map[value] ?? (value || "--");
}

function formatBillSubType(value: string, t?: UiTranslation) {
  const map: Record<string, string> = {
    "3": t ? t("trading:openLong") : "开多",
    "4": t ? t("trading:openShort") : "开空",
    "5": t ? t("trading:closeLong") : "平多",
    "6": t ? t("trading:closeShort") : "平空",
    "100": t ? t("trading:forcedReduceLong") : "强减平多",
    "101": t ? t("trading:forcedReduceShort") : "强减平空",
    "104": t ? t("trading:liquidateLong") : "强平平多",
    "105": t ? t("trading:liquidateShort") : "强平平空",
    "112": t ? t("trading:deliverLong") : "交割平多",
    "113": t ? t("trading:deliverShort") : "交割平空",
    "173": t ? t("trading:fundingExpense") : "资金费支出",
    "174": t ? t("trading:fundingIncome") : "资金费收入"
  };
  return map[value] ?? (value || "--");
}

function previousQuarter() {
  const now = new Date();
  let year = now.getFullYear();
  let quarterIndex = Math.floor(now.getMonth() / 3);
  if (quarterIndex === 0) {
    year -= 1;
    quarterIndex = 4;
  }
  return { year, quarter: `Q${quarterIndex}` };
}

function formatArchiveStatusInline(status: AccountBillsArchiveStatus | null, t?: UiTranslation) {
  if (!status) return t ? t("trading:quarterArchiveNotQueried") : "Quarterly archive: not queried";
  const state = status.fileHref
    ? (t ? t("trading:downloadReady") : "可下载")
    : status.state === "ongoing" || status.requestResult === "false"
      ? (t ? t("trading:generating") : "生成中")
      : status.state === "failed"
        ? (t ? t("common:failed") : "失败")
        : status.state || status.requestResult || (t ? t("common:unknown") : "未知");
  return t ? t("trading:quarterArchiveStatus", { year: status.year, quarter: status.quarter, state }) : `${status.year} ${status.quarter}：${state}`;
}

function formatArchiveStatusMessage(status: AccountBillsArchiveStatus | null, year: number, quarter: string) {
  if (!status) return `${year} ${quarter} 暂无返回结果。`;
  if (status.fileHref) return `${status.year} ${status.quarter} 归档已生成，下载链接有效期约 5.5 小时。`;
  if (status.requestResult === "false" || status.state === "ongoing") return `${status.year} ${status.quarter} 归档正在生成，OKX 文档提示通常约 2 小时后可查询。`;
  if (status.state === "failed") return `${status.year} ${status.quarter} 归档生成失败，可重新申请。`;
  return `${status.year} ${status.quarter} 状态：${status.state || status.requestResult || "未知"}`;
}

function formatWsStatus(value: string, t?: UiTranslation) {
  if (!value) return t ? t("trading:waitingConnection") : "等待连接";
  if (value.includes("partially degraded")) return t ? t("trading:partiallyDegraded") : "部分降级";
  if (value.includes("meta degraded")) return t ? t("trading:marketStreamDegraded") : "行情主链路异常";
  if (value.includes("data stale") || value.includes("数据超时")) return t ? t("trading:dataStale") : "数据超时";
  if (value.includes("resubscribing")) return t ? t("trading:resubscribing") : "重新订阅";
  if (value.includes("reconnecting")) return t ? t("trading:reconnecting") : "重连中";
  if (value.includes("retry")) return t ? t("trading:waitingReconnect") : "等待重连";
  if (value.includes("closed")) return t ? t("trading:disconnected") : "已断开";
  if (value.includes(" connected")) return t ? t("trading:liveConnection") : "实时连接";
  if (value.includes("connecting")) return t ? t("common:connecting") : "连接中";
  if (value.includes("error")) return t ? t("trading:connectionError") : "连接异常";
  return value;
}

function summarizePublicWsStatus(statuses: Record<string, PublicWsStatus>, expectedCount: number) {
  const values = Object.values(statuses);
  if (values.length === 0) return "public connecting";
  const ready = values.filter((item) => item.state === "ready").length;
  const metaReady = statuses["public-meta"]?.state === "ready";
  if (ready === expectedCount && values.length === expectedCount) return "public connected";
  if (ready === 0) return values.some((item) => item.state === "connecting" || item.state === "reconnecting")
    ? "public reconnecting"
    : "public closed";
  return metaReady ? "public partially degraded" : "public meta degraded";
}

function expectedPublicStreamCount(symbolCount: number) {
  return 1 + Math.ceil(Math.max(0, symbolCount) / 5);
}

function publicStreamSortKey(streamId: string) {
  if (streamId === "public-meta") return "0-meta";
  if (streamId.startsWith("public-books-")) return `1-${streamId}`;
  return `2-${streamId}`;
}

function formatPublicStreamLabel(status: PublicWsStatus, t?: UiTranslation) {
  if (status.kind === "meta") return t ? t("trading:marketAndTrades") : "行情 / 成交";
  const shard = status.streamId.split("-").at(-1) ?? "1";
  if (status.kind === "books") return `Books #${shard}`;
  return status.streamId;
}

function formatPrivateHistoryStatus(status: PrivateHistoryStatusResponse, chineseUi = true) {
  if (status.endpoints.length === 0) return chineseUi ? "历史交易数据尚未同步，点击开始同步" : "Trade history has not been synchronized. Click to start.";
  const missingRequired = privateHistoryMissingRequiredScopes(status);
  const summary = chineseUi
    ? status.failed > 0
      ? `失败 ${status.failed}，重试 ${status.retrying}`
      : status.running > 0
        ? `同步中 ${status.running}`
        : missingRequired.length > 0
          ? `缺少补数接口 ${missingRequired.join("、")}`
          : "历史交易数据已记录同步状态"
    : status.failed > 0
      ? `${status.failed} failed, ${status.retrying} retrying`
      : status.running > 0
        ? `${status.running} synchronizing`
        : missingRequired.length > 0
          ? `Missing backfill endpoints: ${missingRequired.join(", ")}`
          : "Trade-history sync status is recorded";
  const lines = status.endpoints.slice(0, 6).map((item) => {
    const scope = item.scope.replace("-history", "");
    const state = chineseUi
      ? item.status === "complete" ? "完成" : item.status === "failed" ? "失败" : item.status === "running" ? "同步中" : item.status
      : item.status === "complete" ? "complete" : item.status === "failed" ? "failed" : item.status === "running" ? "synchronizing" : item.status;
    const retry = item.nextRetryAt ? chineseUi ? `，重试 ${formatMs(String(item.nextRetryAt))}` : `, retry ${formatMs(String(item.nextRetryAt))}` : "";
    const error = item.lastError ? `${chineseUi ? "，" : ", "}${item.lastError.slice(0, 42)}` : "";
    return chineseUi ? `${scope}: ${state}，写入 ${item.upserted}${retry}${error}` : `${scope}: ${state}, wrote ${item.upserted}${retry}${error}`;
  });
  return [summary, ...lines].join("\n");
}

function privateHistoryMissingRequiredScopes(status: PrivateHistoryStatusResponse) {
  const required = [
    "orders-history",
    "orders-history-archive",
    "fills",
    "fills-history",
    "account-bills",
    "account-bills-archive",
    "positions-history"
  ];
  const scopes = new Set(status.endpoints.filter((item) => !item.instId).map((item) => item.scope));
  return required.filter((scope) => !scopes.has(scope));
}

function formatPrivateHistorySyncSummary(result: {
  ordersUpserted: number;
  archiveOrdersUpserted: number;
  recentFillsUpserted: number;
  fillsUpserted: number;
  billsUpserted?: number;
  archiveBillsUpserted?: number;
  positionsUpserted: number;
}) {
  const orders = result.ordersUpserted + result.archiveOrdersUpserted;
  const fills = result.recentFillsUpserted + result.fillsUpserted;
  const bills = (result.billsUpserted ?? 0) + (result.archiveBillsUpserted ?? 0);
  return `订单 ${orders}，成交 ${fills}，资金流水 ${bills}，历史持仓 ${result.positionsUpserted}。`;
}

function parseClassifiedOkxError(error: unknown): ClassifiedOkxError | null {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(raw) as ClassifiedOkxError;
    if (parsed?.desicTerminalError || parsed?.desicTradeError) return parsed;
  } catch {
    return null;
  }
  return null;
}

function formatTradeErrorMessage(error: unknown) {
  const parsed = parseClassifiedOkxError(error);
  if (!parsed) return error instanceof Error ? error.message : String(error);
  const category = formatOkxErrorCategory(parsed.category);
  const retryText = parsed.retryable ? "可稍后重试" : "请先修正后再提交";
  const parts = [
    `${category}：${parsed.userMessage || parsed.message || "OKX 返回错误"}`,
    parsed.suggestion,
    parsed.code ? `OKX ${parsed.code}${parsed.source ? ` / ${parsed.source}` : ""}` : undefined,
    retryText
  ].filter(Boolean);
  return parts.join("；");
}

function isPositionModeSwitchFailureMessage(message: string) {
  return message.includes("ACCOUNT_POSITION_MODE_SWITCH_FAILED:");
}

function formatOkxErrorCategory(value?: string) {
  const map: Record<string, string> = {
    auth: "账号认证",
    time_sync: "时间同步",
    order_param: "委托参数",
    risk_or_balance: "风控/余额",
    cancel_or_order_state: "订单状态",
    rate_limit: "频率限制",
    network_or_service: "网络/服务",
    okx_unknown: "OKX 错误"
  };
  return map[value || ""] ?? "OKX 错误";
}

function ConnectionTooltipRow({
  label,
  status,
  delay,
  state,
  detail
}: {
  label: string;
  status: string;
  delay?: number;
  state?: string;
  detail?: string;
}) {
  const normalized = `${state ?? ""} ${status}`.toLowerCase();
  const tone = normalized.includes("failed") || normalized.includes("认证失败")
    ? "error"
    : normalized.includes("reconnect") || normalized.includes("closed") || normalized.includes("stale") || normalized.includes("重连") || normalized.includes("断开") || normalized.includes("超时")
      ? "warning"
      : normalized.includes("connected") || normalized.includes("ready") || normalized.includes("实时")
        ? "healthy"
        : "muted";
  return (
    <div className="connection-tooltip-row">
      <span className={clsx("connection-state-dot", tone)} aria-hidden="true" />
      <span className="connection-tooltip-label" title={detail}>{label}</span>
      <strong>{typeof delay === "number" ? fmtDelay(delay) : "--"}</strong>
      <small>{status}</small>
    </div>
  );
}

function privateAccountKey(accountId?: string | null, environment?: string | null) {
  if (!accountId || !environment) return null;
  return `${environment.toLowerCase()}:${accountId}`;
}

function formatPrivateWsStatus(value: string | PrivateWsStatus, t?: UiTranslation) {
  const status = typeof value === "string" ? value : value.status;
  const state = typeof value === "string" ? undefined : value.state;
  if (!status) return t ? t("trading:waitingAccount") : "等待账号";
  if (state === "time_sync_failed") return t ? t("trading:timeSyncFailed") : "时间同步失败";
  if (state === "auth_failed") return t ? t("trading:accountAuthFailed") : "账号认证失败";
  if (state === "stale") return t ? t("trading:connectionTimedOut") : "连接超时";
  if (state === "reconnecting") return t ? t("trading:reconnecting") : "重连中";
  if (state === "connecting" || state === "authenticating" || state === "subscribing") return t ? t("common:connecting") : "连接中";
  if (state === "ready") {
    const delay = typeof value === "string" ? null : value.delayMs;
    return typeof delay === "number" ? (t ? t("trading:liveSyncDelay", { delay: fmtDelay(delay) }) : `实时同步 ${fmtDelay(delay)}`) : (t ? t("trading:liveSync") : "实时同步");
  }
  if (status.includes("未配置账号")) return t ? t("common:unconfiguredAccount") : "未配置账号";
  if (status.includes("未开启读取权限")) return t ? t("trading:readPermissionOff") : "读取权限关闭";
  if (status.includes("登录失败")) return t ? t("trading:accountAuthFailed") : "账号认证失败";
  if (status.includes("data")) {
    const delay = typeof value === "string" ? null : value.delayMs;
    return typeof delay === "number" ? (t ? t("trading:liveSyncDelay", { delay: fmtDelay(delay) }) : `实时同步 ${fmtDelay(delay)}`) : (t ? t("trading:liveSync") : "实时同步");
  }
  if (status.includes("subscribed") || status.includes("connected")) return t ? t("trading:liveSync") : "实时同步";
  if (status.includes("reconnecting")) return t ? t("trading:reconnecting") : "重连中";
  if (status.includes("retry")) return t ? t("trading:waitingReconnect") : "等待重连";
  if (status.includes("closed")) return t ? t("trading:disconnected") : "已断开";
  if (status.includes("connecting")) return t ? t("common:connecting") : "连接中";
  return status;
}

function formatPrivateDataStatus(value: string, t: UiTranslation) {
  const map: Record<string, string> = {
    "未配置账号": t("common:unconfiguredAccount"),
    "未开启读取权限": t("trading:readPermissionOff"),
    "同步中": t("trading:syncing"),
    "已同步": t("trading:synced"),
    "暂无历史持仓": t("trading:noPositionHistory"),
    "暂无历史委托": t("trading:noOrderHistory"),
    "暂无历史成交": t("trading:noFillHistory"),
    "暂无策略委托": t("trading:noAlgoOrders"),
    "暂无资金流水": t("trading:noFundingFlows"),
    "暂无交易审计": t("trading:noAuditEvents"),
    "仅 Tauri 可用": t("common:desktopOnly"),
    "实时更新": t("trading:liveUpdating")
  };
  return map[value] ?? value;
}

function formatEpisodeStatus(value: string, t?: UiTranslation) {
  if (value === "closed") return t ? t("trading:episodeClosed") : "已完结";
  if (value === "open") return t ? t("trading:episodeOpen") : "持仓中";
  return value || "--";
}

function formatEpisodeOrigin(value: string, t?: UiTranslation) {
  const map: Record<string, string> = {
    user: t ? t("trading:operatorUser") : "用户",
    ai: "AI",
    mixed: t ? t("trading:operatorMixed") : "混合",
    exchange: t ? t("trading:okxHistory") : "OKX 历史",
    unknown: t ? t("trading:operatorUser") : "用户"
  };
  return map[value] ?? value ?? (t ? t("trading:operatorUser") : "用户");
}

function formatEpisodeEventType(value: string, t?: UiTranslation) {
  const map: Record<string, string> = {
    OPEN: t ? t("trading:episodeEventOpen") : "开仓",
    ADD: t ? t("trading:episodeEventAdd") : "加仓",
    REDUCE: t ? t("trading:episodeEventReduce") : "减仓",
    CLOSE: t ? t("trading:episodeEventClose") : "平仓",
    FUNDING_FEE: t ? t("trading:fundingFee") : "资金费",
    LIQUIDATION: t ? t("trading:liquidation") : "强平",
    ADL: "ADL",
    MARGIN_TRANSFER: t ? t("trading:margin") : "保证金",
    INTEREST: t ? t("trading:interestDeduction") : "扣息",
    DELIVERY: t ? t("trading:delivery") : "交割"
  };
  return map[value] ?? value;
}

function summarizeEpisodeEvents(episode: PositionEpisode, t?: UiTranslation) {
  if (episode.events.length === 0) return t ? t("trading:noEvents") : "无事件";
  const counts = episode.events.reduce<Record<string, number>>((acc, event) => {
    acc[event.eventType] = (acc[event.eventType] ?? 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .map(([type, count]) => `${formatEpisodeEventType(type, t)} ${count}`)
    .join(" / ");
}

function RecentTrades({ trades }: { trades: Trade[] }) {
  return (
    <div className="recent-trades">
      <h3>最新成交</h3>
      {trades.slice(0, 18).map((trade) => (
        <div className="trade-row" key={`${trade.tradeId}-${trade.ts}`}>
          <span className={trade.side === "buy" ? "up" : "down"}>{fmtPrice(trade.px)}</span>
          <span>{Number(trade.sz).toFixed(3)}</span>
          <span>{formatTradeMs(trade.ts)}</span>
        </div>
      ))}
    </div>
  );
}

function formatTradeTicketOrderType(orderType: OrderSpecV2OrderType) {
  const labels: Record<OrderSpecV2OrderType, string> = {
    limit: "限价",
    market: "市价",
    post_only: "Post Only",
    ioc: "IOC",
    fok: "FOK",
    trigger: "计划",
    trailing: "追踪止损",
  };
  return labels[orderType];
}

function formatTradeTicketAction(action: TradeActionSide) {
  if (action === "long") return "做多";
  if (action === "short") return "做空";
  if (action === "close-long") return "平多";
  return "平空";
}

function formatPreparedOrderExecutionSummary(order: PreparedTradeOrder) {
  if (order.spec.trigger) {
    const source = order.spec.trigger.source === "mark"
      ? "标记价格"
      : order.spec.trigger.source === "index"
        ? "指数价格"
        : "最新成交价";
    const execution = order.spec.trigger.execution === "limit"
      ? `限价 ${order.spec.trigger.orderPrice ?? "--"}`
      : "市价";
    return `触发价来源 ${source}，触发价 ${order.spec.trigger.triggerPrice}，触发后 ${execution}`;
  }
  if (order.spec.trailing) {
    return `激活价 ${order.spec.trailing.activePx || "立即追踪"}，价格源 最新成交价，回调幅度 ${order.trailingCallbackPercent ?? "--"}%`;
  }
  return `价格 ${order.displayPrice}`;
}

function tradeSubmitFailureState(error: unknown): "rejected" | "unknown" {
  const classified = parseClassifiedOkxError(error);
  if (classified) {
    const confirmedRejection = classified.retryable === false
      && ["auth", "order_param", "risk_or_balance"].includes(classified.category ?? "");
    return confirmedRejection ? "rejected" : "unknown";
  }
  const message = error instanceof Error ? error.message.trim() : String(error).trim();
  const explicitLocalBlocker = [
    /^实盘下单缺少二次确认标记/,
    /^账号环境与当前交易环境不一致/,
    /^账号未开启交易权限/,
    /^OKX API Key 未包含 trade 权限/,
    /^下单前风控未通过/,
    /^不支持的 orderSpecV2\.version/,
    /^orderSpecV2\./,
    /^trailing\.callbackRatio/,
    /^(?:普通|算法|trigger|trailing)委托/,
    /^触发(?:价来源|后执行|限价委托)/,
    /^OKX move_order_stop 当前只支持/,
    /^(?:executionKey|algoClOrdId)/,
    /^委托类型无效/,
  ].some((pattern) => pattern.test(message));
  return explicitLocalBlocker ? "rejected" : "unknown";
}

type InstrumentOperationUiStage =
  | "idle"
  | "previewing"
  | "previewed"
  | "submitting"
  | "accepted"
  | "reconciling"
  | "terminal"
  | "unknown"
  | "failed";

type InstrumentOperationUiState = {
  scopeKey: string;
  stage: InstrumentOperationUiStage;
  preview?: InstrumentOperationPreview;
  operationId?: string;
  view?: InstrumentOperationView;
  message?: string;
  updatedAt: number;
};

const INSTRUMENT_OPERATION_KINDS: InstrumentOperationKind[] = ["cancel_orders", "flatten_positions"];

function createEmptyInstrumentOperationState(): Record<InstrumentOperationKind, InstrumentOperationUiState> {
  return {
    cancel_orders: { scopeKey: "", stage: "idle", updatedAt: 0 },
    flatten_positions: { scopeKey: "", stage: "idle", updatedAt: 0 },
  };
}

function formatInstrumentOperationKind(kind: InstrumentOperationKind) {
  return kind === "cancel_orders" ? "撤销当前合约全部委托" : "市价全平当前合约持仓";
}

function formatInstrumentOperationStage(state: InstrumentOperationUiState) {
  if (state.stage === "previewing") return "读取预览";
  if (state.stage === "previewed") return "等待确认";
  if (state.stage === "submitting") return "提交中";
  if (state.stage === "accepted") return "已受理";
  if (state.stage === "reconciling") return "对账中";
  if (state.stage === "unknown") return "状态不明";
  if (state.stage === "failed") return "预览失败";
  if (state.stage === "terminal") {
    if (state.view?.outcome === "succeeded") return "已完成";
    if (state.view?.outcome === "no_op") return "无需处理";
    if (state.view?.outcome === "partial") return "部分完成";
    return "已终止";
  }
  return "就绪";
}

function instrumentOperationStageFromView(view: InstrumentOperationView, executionResponse = false): InstrumentOperationUiStage {
  if (view.phase === "terminal") return "terminal";
  if (view.phase === "unknown" || view.outcome === "unknown" || view.counts.unknown > 0) return "unknown";
  if (executionResponse && view.counts.accepted > 0) return "accepted";
  if (view.phase === "reconciling") return "reconciling";
  return "submitting";
}

function instrumentOperationIsBusy(state: InstrumentOperationUiState) {
  return ["previewing", "submitting", "accepted", "reconciling"].includes(state.stage);
}

function instrumentOperationLocksTrading(state: InstrumentOperationUiState) {
  return instrumentOperationIsBusy(state) || state.stage === "unknown";
}

function instrumentOperationBlocksSameKind(state: InstrumentOperationUiState, scopeKey: string) {
  return state.scopeKey === scopeKey
    && (instrumentOperationIsBusy(state) || state.stage === "unknown");
}

function formatInstrumentOperationProgress(view?: InstrumentOperationView) {
  if (!view) return "";
  const { counts } = view;
  return `计划 ${counts.planned} · 已确认 ${counts.confirmed} · 失败 ${counts.failed} · 未知 ${counts.unknown} · 残留 ${counts.residual}`;
}

function isProvenNotSubmittedInstrumentOperationError(error: unknown) {
  const code = instrumentOperationErrorCode(error);
  if (code.startsWith("PREVIEW_") || code.startsWith("STRICT_SCOPE_") || code === "OPERATION_KIND_UNRESOLVED") return true;
  const message = error instanceof Error ? error.message : String(error);
  return [
    "账号环境与当前交易环境不一致",
    "当前账号必须同时开启读取和交易权限",
    "当前合约不能为空",
    "紧急操作缺少明确确认标记",
    "实盘紧急操作缺少二次确认标记",
    "operationId 格式无效",
  ].some((token) => message.includes(token));
}

function instrumentOperationErrorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  const raw = error instanceof Error ? error.message : String(error);
  const candidates = [raw];
  const jsonStart = raw.indexOf("{");
  if (jsonStart > 0) candidates.push(raw.slice(jsonStart));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { code?: unknown };
      if (typeof parsed.code === "string") return parsed.code;
    } catch {
      // Tauri can return a plain string for local validation errors.
    }
  }
  return "";
}

function assertInstrumentOperationPreview(
  preview: InstrumentOperationPreview,
  kind: InstrumentOperationKind,
  scope: InstrumentOperationScope,
) {
  if (preview.operationKind !== kind
    || preview.accountId !== scope.accountId
    || preview.environment !== scope.environment
    || preview.instId !== scope.instId) {
    throw new Error("紧急操作预览作用域与当前账户、环境或合约不一致");
  }
}

function assertInstrumentOperationView(
  view: InstrumentOperationView,
  kind: InstrumentOperationKind,
  scope: InstrumentOperationScope,
  operationId: string,
) {
  if (view.operationId !== operationId
    || view.operationKind !== kind
    || view.accountId !== scope.accountId
    || view.environment !== scope.environment
    || view.instId !== scope.instId) {
    throw new Error("紧急操作结果作用域与请求不一致，已停止自动处理");
  }
}

function InstrumentOperationConfirmDialog({
  preview,
  busy,
  onCancel,
  onConfirm,
}: {
  preview: InstrumentOperationPreview;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation(["trading", "common"]);
  const now = useClockTick();
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const secondsRemaining = Math.max(0, Math.ceil((preview.expiresAt - now) / 1_000));
  const expired = secondsRemaining === 0;
  const countRows = [
    [t("trading:ordinaryOrders"), preview.counts.ordinary],
    [t("trading:triggerOrder"), preview.counts.trigger],
    [t("trading:trailingStop"), preview.counts.trailing],
    [t("trading:conditionalOco"), preview.counts.conditionalOco],
    [t("trading:partiallyFilled"), preview.counts.partiallyFilled],
    [t("trading:positions"), preview.counts.positions],
  ] as const;
  const isCancel = preview.operationKind === "cancel_orders";
  const expiry = expired
    ? t("trading:previewExpired")
    : t("trading:previewExpiresIn", { count: secondsRemaining });
  return (
    <ModalShell
      title={isCancel ? t("trading:confirmCancelAllOrdersTitle") : t("trading:confirmFlattenPositionsTitle")}
      description={t("trading:operationPreviewDescription", {
        symbol: preview.instId,
        environment: t(preview.environment === "live" ? "common:live" : "common:demo"),
        expiry,
      })}
      compact
      className="instrument-operation-dialog"
      initialFocusRef={cancelButtonRef}
      onClose={onCancel}
    >
      <div className="instrument-operation-preview">
        <div className="instrument-operation-counts" aria-label={t("trading:strictPreviewCount")}>
          {countRows.map(([label, value]) => (
            <div key={label}><span>{label}</span><strong>{value}</strong></div>
          ))}
        </div>
        <div className="instrument-operation-plan" role="status">
          <span>{t("trading:plannedThisTime")}</span>
          <strong>{preview.counts.planned}</strong>
          <small>{t(isCancel ? "trading:plannedOrderUnit" : "trading:plannedPositionUnit", { count: preview.counts.planned })}</small>
        </div>
        <ul className="instrument-operation-warnings">
          {preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
        {expired && <p className="instrument-operation-expired">{t("trading:previewExpiredDetail")}</p>}
      </div>
      <div className="modal-actions">
        <button type="button" ref={cancelButtonRef} onClick={onCancel}>{t("common:cancel")}</button>
        <button type="button" className="danger-action" disabled={busy || expired} onClick={onConfirm}>
          {busy
            ? t("trading:submitting")
            : expired
              ? t("trading:previewExpired")
              : isCancel
                ? t("trading:confirmCancelAll")
                : t("trading:confirmFlattenAll")}
        </button>
      </div>
    </ModalShell>
  );
}

function InstrumentOperationTabAction({
  kind,
  symbol,
  state,
  active,
  disabled,
  onPreview,
  onRetry,
}: {
  kind: InstrumentOperationKind;
  symbol: string;
  state: InstrumentOperationUiState;
  active: boolean;
  disabled: boolean;
  onPreview: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation("trading");
  const isCancel = kind === "cancel_orders";
  const Icon = isCancel ? Trash2 : Square;
  const label = isCancel ? t("cancelAll") : t("flattenAll");
  const progress = formatInstrumentOperationProgress(state.view);
  return (
    <section className="instrument-tab-action" aria-label={isCancel ? t("openOrdersEmergency") : t("positionsEmergency")}>
      <button
        type="button"
        className={isCancel ? "cancel-orders" : "flatten-positions"}
        aria-label={isCancel ? t("cancelAllAria") : t("flattenAllAria")}
        title={t(isCancel ? "cancelAllTitle" : "flattenAllTitle", { symbol })}
        disabled={disabled}
        onClick={onPreview}
      >
        <Icon size={13} />
        <span>{label}</span>
      </button>
      {active && state.stage !== "idle" && (
        <div className="instrument-operation-state" data-stage={state.stage} role="status">
          <strong>{formatInstrumentOperationStage(state)}</strong>
          <small title={state.message || progress}>{progress || state.message || "--"}</small>
          {state.stage === "unknown" && state.operationId && (
            <button
              type="button"
              aria-label={t("reconcileOperation", { operation: isCancel ? t("cancelAllAria") : t("flattenAllAria") })}
              title={t("reconcileOperationTitle")}
              onClick={onRetry}
            >
              <RefreshCw size={12} />
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function OrderTicket({
  account,
  symbol,
  flattenPositionsTargetRef,
  cancelOrdersTargetRef,
  instrument,
  ticker,
  bestBid,
  bestAsk,
  wsStatus,
  snapshot,
  privateStatus,
  latencyGuard,
  tradeEnvironment,
  priceFill,
  onNotify,
  onRefreshAccount,
  onRefreshOrders,
  onOpenAccountManager,
  onChartTradeConfigChange
}: {
  account?: AccountSummary;
  symbol: string;
  flattenPositionsTargetRef: MutableRefObject<HTMLDivElement | null>;
  cancelOrdersTargetRef: MutableRefObject<HTMLDivElement | null>;
  instrument?: MarketAssetsSummary["instruments"][number];
  ticker: Ticker | null;
  bestBid: string;
  bestAsk: string;
  wsStatus: string;
  snapshot: PrivateAccountSnapshot | null;
  privateStatus: string;
  latencyGuard: TradeLatencyGuard;
  tradeEnvironment: "demo" | "live";
  priceFill?: { symbol: string; price: string; nonce: number } | null;
  onNotify: (notification: Omit<AppNotification, "id" | "createdAt">) => void;
  onRefreshAccount: () => Promise<void>;
  onRefreshOrders: () => void;
  onOpenAccountManager: () => void;
  onChartTradeConfigChange?: (config: ChartQuickTradeAccountConfig) => void;
}) {
  const { t } = useTranslation(["trading", "common"]);
  const [ticketMode, setTicketMode] = useState<"open" | "close">("open");
  const [marginMode, setMarginMode] = useState<"cross" | "isolated">("cross");
  const [leverage, setLeverage] = useState("20");
  const [orderType, setOrderType] = useState<OrderSpecV2OrderType>("limit");
  const [priceInput, setPriceInput] = useState("");
  const [sizeInput, setSizeInput] = useState("");
  const [triggerSource, setTriggerSource] = useState<OrderSpecV2TriggerSource>("last");
  const [triggerExecution, setTriggerExecution] = useState<"market" | "limit">("market");
  const [triggerOrderPrice, setTriggerOrderPrice] = useState("");
  const [trailingActivePrice, setTrailingActivePrice] = useState("");
  const [trailingCallbackRatio, setTrailingCallbackRatio] = useState("");
  const [attachedExitsEnabled, setAttachedExitsEnabled] = useState(false);
  const [takeProfitPrice, setTakeProfitPrice] = useState("");
  const [stopLossPrice, setStopLossPrice] = useState("");
  const [leverageInfo, setLeverageInfo] = useState<OkxLeverageInfo[]>([]);
  const [leverageStatus, setLeverageStatus] = useState(() => t("trading:waitingSync"));
  const [readingLeverage, setReadingLeverage] = useState(false);
  const [settingLeverage, setSettingLeverage] = useState(false);
  const leverageRequestSeqRef = useRef(0);
  const submitRequestSeqRef = useRef(0);
  const [submittingSide, setSubmittingSide] = useState<TradeActionSide | null>(null);
  const [confirmingOrder, setConfirmingOrder] = useState<PreparedTradeOrder | null>(null);
  const [lastOrderState, setLastOrderState] = useState<{
    scopeKey: string;
    status: "submitting" | "accepted" | "rejected" | "unknown";
    action: TradeActionSide;
    size: string;
    message: string;
    at: number;
  } | null>(null);
  const [instrumentOperations, setInstrumentOperations] = useState(createEmptyInstrumentOperationState);
  const [confirmingInstrumentOperation, setConfirmingInstrumentOperation] = useState<InstrumentOperationPreview | null>(null);
  const instrumentOperationSeqRef = useRef<Record<InstrumentOperationKind, number>>({ cancel_orders: 0, flatten_positions: 0 });
  const [instrumentOperationRestoreStatus, setInstrumentOperationRestoreStatus] = useState<"loading" | "ready" | "error">("loading");
  const [instrumentOperationPortalsReady, setInstrumentOperationPortalsReady] = useState(false);
  const instrumentOperationRestoreSeqRef = useRef(0);
  const [tradeExecutionGuards, setTradeExecutionGuards] = useState<TradeExecutionGuard[]>([]);
  const [tradeExecutionGuardStatus, setTradeExecutionGuardStatus] = useState<"loading" | "ready" | "error">("loading");
  const tradeExecutionGuardSeqRef = useRef(0);
  const [closePercentSide, setClosePercentSide] = useState<Extract<TradeActionSide, "close-long" | "close-short">>("close-long");
  const ticketRootRef = useRef<HTMLDivElement | null>(null);
  const priceInputRef = useRef<HTMLInputElement | null>(null);
  const sizeInputRef = useRef<HTMLInputElement | null>(null);
  const confirmationReturnFocusRef = useRef<HTMLElement | null>(null);
  const ticketFieldId = useId();
  const leverageFieldId = `${ticketFieldId}-leverage`;
  const orderTypeFieldId = `${ticketFieldId}-order-type`;
  const priceFieldId = `${ticketFieldId}-price`;
  const priceHelpId = `${ticketFieldId}-price-help`;
  const sizeFieldId = `${ticketFieldId}-size`;
  const sizeHelpId = `${ticketFieldId}-size-help`;
  const triggerSourceFieldId = `${ticketFieldId}-trigger-source`;
  const triggerOrderPriceFieldId = `${ticketFieldId}-trigger-order-price`;
  const trailingCallbackFieldId = `${ticketFieldId}-trailing-callback`;
  const attachedExitsFieldId = `${ticketFieldId}-attached-exits`;
  const takeProfitFieldId = `${ticketFieldId}-take-profit`;
  const stopLossFieldId = `${ticketFieldId}-stop-loss`;
  const takeProfitEnabled = attachedExitsEnabled && takeProfitPrice.trim().length > 0;
  const stopLossEnabled = attachedExitsEnabled && stopLossPrice.trim().length > 0;
  const usdtBalance = snapshot?.balances.find((balance) => balance.ccy === "USDT");
  const tradeScopeKey = `${account?.id ?? "none"}:${tradeEnvironment}:${symbol}`;
  const currentInstrumentOperations = INSTRUMENT_OPERATION_KINDS.map((kind) => instrumentOperations[kind])
    .filter((state) => state.scopeKey === tradeScopeKey);
  const instrumentOperationBusy = currentInstrumentOperations.some(instrumentOperationIsBusy);
  const instrumentOperationLocksOrderEntry = instrumentOperationRestoreStatus !== "ready"
    || currentInstrumentOperations.some(instrumentOperationLocksTrading);
  const tradeExecutionGuardBlocksOpen = tradeExecutionGuardStatus !== "ready" || tradeExecutionGuards.length > 0;
  const refreshTradeExecutionGuards = useCallback(async (showLoading = false) => {
    const requestSeq = ++tradeExecutionGuardSeqRef.current;
    if (!account || !isTauriRuntime()) {
      setTradeExecutionGuards([]);
      setTradeExecutionGuardStatus("ready");
      return;
    }
    if (showLoading) setTradeExecutionGuardStatus("loading");
    try {
      const guards = await fetchTradeExecutionGuards({
        accountId: account.id,
        environment: tradeEnvironment,
        instId: symbol,
      });
      if (requestSeq !== tradeExecutionGuardSeqRef.current) return;
      if (!guards) throw new Error("未决交易执行查询未返回结果");
      setTradeExecutionGuards(guards);
      setTradeExecutionGuardStatus("ready");
    } catch (error) {
      if (requestSeq !== tradeExecutionGuardSeqRef.current) return;
      logger.error("restore unresolved trade executions failed", error, { tradeScopeKey });
      setTradeExecutionGuards([]);
      setTradeExecutionGuardStatus("error");
    }
  }, [account, symbol, tradeEnvironment, tradeScopeKey]);
  const reconcileCurrentTradeExecutionGuards = useCallback(async () => {
    const requestSeq = ++tradeExecutionGuardSeqRef.current;
    if (!account) return;
    setTradeExecutionGuardStatus("loading");
    try {
      const guards = await reconcileTradeExecutionGuards({
        accountId: account.id,
        environment: tradeEnvironment,
        instId: symbol,
      });
      if (requestSeq !== tradeExecutionGuardSeqRef.current) return;
      if (!guards) throw new Error("未决交易执行对账未返回结果");
      setTradeExecutionGuards(guards);
      setTradeExecutionGuardStatus("ready");
      onNotify({
        kind: guards.length === 0 ? "success" : "warning",
        title: guards.length === 0 ? "未决委托已完成对账" : "仍有委托状态不明",
        message: guards.length === 0
          ? `${symbol} 当前没有未完成的交易执行。`
          : guards.map((guard) => `${guard.executionKey}(${guard.status})`).join("；"),
      });
    } catch (error) {
      if (requestSeq !== tradeExecutionGuardSeqRef.current) return;
      const message = formatTradeErrorMessage(error);
      logger.error("reconcile unresolved trade executions failed", error, { tradeScopeKey });
      setTradeExecutionGuardStatus("error");
      onNotify({ kind: "error", title: "未决委托对账失败", message });
    }
  }, [account, onNotify, symbol, tradeEnvironment, tradeScopeKey]);
  useEffect(() => {
    setInstrumentOperationPortalsReady(true);
  }, []);
  useEffect(() => {
    onChartTradeConfigChange?.({
      accountId: account?.id ?? null,
      environment: tradeEnvironment,
      symbol,
      marginMode,
      leverage,
    });
  }, [account?.id, leverage, marginMode, onChartTradeConfigChange, symbol, tradeEnvironment]);
  useEffect(() => {
    submitRequestSeqRef.current += 1;
    tradeExecutionGuardSeqRef.current += 1;
    instrumentOperationSeqRef.current.cancel_orders += 1;
    instrumentOperationSeqRef.current.flatten_positions += 1;
    instrumentOperationRestoreSeqRef.current += 1;
    setPriceInput("");
    setSizeInput("");
    setTriggerOrderPrice("");
    setTrailingActivePrice("");
    setTrailingCallbackRatio("");
    setAttachedExitsEnabled(false);
    setTakeProfitPrice("");
    setStopLossPrice("");
    setConfirmingOrder(null);
    setConfirmingInstrumentOperation(null);
    setSubmittingSide(null);
    setInstrumentOperations(createEmptyInstrumentOperationState());
    setInstrumentOperationRestoreStatus(account ? "loading" : "ready");
    setTradeExecutionGuards([]);
    setTradeExecutionGuardStatus(account ? "loading" : "ready");
  }, [t, tradeScopeKey]);
  useEffect(() => {
    void refreshTradeExecutionGuards(true);
  }, [refreshTradeExecutionGuards]);
  useEffect(() => {
    if (tradeExecutionGuardStatus !== "ready" || tradeExecutionGuards.length === 0) return;
    const timer = window.setInterval(() => void refreshTradeExecutionGuards(), 3_000);
    return () => window.clearInterval(timer);
  }, [refreshTradeExecutionGuards, tradeExecutionGuardStatus, tradeExecutionGuards.length]);
  useEffect(() => () => {
    tradeExecutionGuardSeqRef.current += 1;
    instrumentOperationSeqRef.current.cancel_orders += 1;
    instrumentOperationSeqRef.current.flatten_positions += 1;
    instrumentOperationRestoreSeqRef.current += 1;
  }, []);
  useEffect(() => {
    if (priceInput || ticker?.instId !== symbol || !ticker.last) return;
    setPriceInput(ticker.last);
  }, [priceInput, symbol, ticker?.instId, ticker?.last]);
  useEffect(() => {
    if (!priceFill || priceFill.symbol !== symbol || orderType === "market") return;
    const normalizedPrice = normalizeTradePriceInput(priceFill.price, instrument);
    if (!normalizedPrice) return;
    if (orderType === "trailing") setTrailingActivePrice(normalizedPrice);
    else setPriceInput(normalizedPrice);
  }, [instrument, orderType, priceFill, symbol]);
  const effectiveOrderPrice = orderType === "market"
    ? ticker?.last ?? ""
    : orderType === "trailing"
      ? trailingActivePrice || ticker?.last || ""
      : priceInput;
  const orderEntryPrice = orderType === "trigger" && triggerExecution === "limit"
    ? triggerOrderPrice
    : effectiveOrderPrice;
  const effectiveSizeInput = sizeInput;
  const precheck = useMemo(
    () =>
      buildTradePrecheck({
        account,
        snapshot,
        instrument,
        symbol,
        ticketMode,
        tradeEnvironment,
        privateStatus,
        latencyGuard,
        price: effectiveOrderPrice,
        size: effectiveSizeInput,
        leverage,
        orderType,
        marginMode
      }),
    [account, effectiveOrderPrice, effectiveSizeInput, instrument, latencyGuard, leverage, marginMode, orderType, privateStatus, snapshot, symbol, ticketMode, tradeEnvironment]
  );
  const advancedBlockers = useMemo(() => {
    const blockers: string[] = [];
    const tickSize = Number(instrument?.tickSz);
    const validTickPrice = (value: string) => Number.isFinite(Number(value))
      && Number(value) > 0
      && (!Number.isFinite(tickSize) || tickSize <= 0 || isTradeStepAligned(Number(value), tickSize));
    if (orderType === "trigger" && triggerExecution === "limit" && !validTickPrice(triggerOrderPrice)) {
      blockers.push("触发后的限价价格无效或不符合 tickSz");
    }
    if (orderType === "trailing") {
      const callbackRatio = Number(trailingCallbackRatio);
      if (!Number.isFinite(callbackRatio) || callbackRatio <= 0 || callbackRatio > 5) blockers.push("回调幅度须大于 0% 且不超过 5%");
      if (trailingActivePrice && !validTickPrice(trailingActivePrice)) blockers.push("激活价格无效或不符合 tickSz");
    }
    if (attachedExitsEnabled && !takeProfitEnabled && !stopLossEnabled) {
      blockers.push("请至少填写止盈或止损价格");
    }
    if (attachedExitsEnabled && (ticketMode !== "open" || orderType === "trigger" || orderType === "trailing")) {
      blockers.push("当前仅支持普通开仓委托随单附加止盈止损");
    }
    if (takeProfitEnabled && !validTickPrice(takeProfitPrice)) blockers.push("止盈触发价无效或不符合 tickSz");
    if (stopLossEnabled && !validTickPrice(stopLossPrice)) blockers.push("实际止损触发价无效或不符合 tickSz");
    return blockers;
  }, [attachedExitsEnabled, instrument?.tickSz, orderType, stopLossEnabled, stopLossPrice, takeProfitEnabled, takeProfitPrice, ticketMode, trailingActivePrice, trailingCallbackRatio, triggerExecution, triggerOrderPrice]);
  useEffect(() => {
    const requestSeq = ++leverageRequestSeqRef.current;
    if (!account) {
      setLeverageInfo([]);
      setLeverageStatus(t("common:unconfiguredAccount"));
      setReadingLeverage(false);
      setSettingLeverage(false);
      return;
    }
    let cancelled = false;
    setReadingLeverage(true);
    setSettingLeverage(false);
    setLeverageStatus(t("trading:readingOkxLeverage"));
    void fetchLeverageInfo({
      accountId: account.id,
      instId: symbol,
      mgnMode: marginMode,
      environment: tradeEnvironment
    })
      .then((rows) => {
        if (cancelled || requestSeq !== leverageRequestSeqRef.current) return;
        setLeverageInfo(rows ?? []);
        const actualLever = dominantLeverageValue(rows);
        if (actualLever) setLeverage(actualLever);
        setLeverageStatus(t(rows?.length ? "trading:okxLeverageLoaded" : "trading:noLeverageReturned"));
      })
      .catch((error) => {
        if (cancelled || requestSeq !== leverageRequestSeqRef.current) return;
        logger.error("fetch leverage info failed", error);
        setLeverageInfo([]);
        setLeverageStatus(t("trading:leverageReadFailed"));
      })
      .finally(() => {
        if (!cancelled && requestSeq === leverageRequestSeqRef.current) setReadingLeverage(false);
      });
    return () => {
      cancelled = true;
    };
  }, [account, marginMode, symbol, t, tradeEnvironment]);

  const syncLeverage = useCallback((nextLeverage: string, previousLeverage: string) => {
    if (!account) {
      setLeverage(previousLeverage);
      setLeverageStatus(t("common:unconfiguredAccount"));
      onNotify({
        kind: "warning",
        title: "杠杆未同步",
        message: "请先配置 OKX 账号。"
      });
      return;
    }
    const requestSeq = ++leverageRequestSeqRef.current;
    setReadingLeverage(false);
    setSettingLeverage(true);
    setLeverageStatus(t("trading:syncingOkxLeverage"));
    void setOkxLeverage({
      accountId: account.id,
      instId: symbol,
      mgnMode: marginMode,
      lever: nextLeverage,
      environment: tradeEnvironment
    })
      .then((result) => {
        if (requestSeq !== leverageRequestSeqRef.current) return;
        setLeverageInfo(result?.results ?? []);
        setLeverageStatus(result?.warnings?.[0] ?? t("trading:okxLeverageSynced"));
        onNotify({
          kind: "success",
          title: "杠杆已同步",
          message: `${symbol} ${marginMode === "cross" ? "全仓" : "逐仓"} ${nextLeverage}X 已提交到 OKX。`
        });
      })
      .catch(async (error) => {
        if (requestSeq !== leverageRequestSeqRef.current) return;
        logger.error("set leverage failed", error);
        let actualRows: OkxLeverageInfo[] = [];
        try {
          actualRows = await fetchLeverageInfo({
            accountId: account.id,
            instId: symbol,
            mgnMode: marginMode,
            environment: tradeEnvironment
          }) ?? [];
        } catch (refreshError) {
          logger.error("refresh leverage after failed set failed", refreshError);
        }
        if (requestSeq !== leverageRequestSeqRef.current) return;
        setLeverageInfo(actualRows);
        const actualLever = dominantLeverageValue(actualRows) ?? previousLeverage;
        setLeverage(actualLever);
        setLeverageStatus(actualRows.length
          ? t("trading:leverageSyncFailedRestoredOkx", { leverage: actualLever })
          : t("trading:leverageSyncFailedRestoredPrevious"));
        onNotify({
          kind: "error",
          title: "杠杆同步失败",
          message: `${symbol} 未能设置为 ${nextLeverage}X；${actualRows.length ? `已恢复显示为 OKX 当前 ${actualLever}X。` : "已恢复为原值。"}${formatTradeErrorMessage(error)}`
        });
      })
      .finally(() => {
        if (requestSeq === leverageRequestSeqRef.current) setSettingLeverage(false);
      });
  }, [account, marginMode, onNotify, symbol, t, tradeEnvironment]);

  const riskBlocked = precheck.blocked || advancedBlockers.length > 0;
  const leverageOptions = useMemo(() => {
    const maxLeverage = Math.max(1, Math.floor(Number(instrument?.lever) || 50));
    const values = [1, 2, 3, 5, 10, 20, 50, 75, 100, 125]
      .filter((value) => value <= maxLeverage)
      .map(String);
    for (const value of [leverage, ...leverageInfo.map((row) => String(Number(row.lever)))]) {
      if (Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= maxLeverage && !values.includes(value)) values.push(value);
    }
    return values.sort((left, right) => Number(left) - Number(right));
  }, [instrument?.lever, leverage, leverageInfo]);
  const longClosable = closablePositionSize(snapshot, symbol, "long");
  const shortClosable = closablePositionSize(snapshot, symbol, "short");
  const availableUsdt = Number(usdtBalance?.availEq || usdtBalance?.availBal || usdtBalance?.cashBal);
  const tradePrice = Number(orderEntryPrice || effectiveOrderPrice);
  const tradeSize = Number(effectiveSizeInput);
  const tradeLever = Number(leverage);
  const contractValue = Number(instrument?.ctVal);
  const localEstimatedMargin = Number.isFinite(tradePrice) && Number.isFinite(tradeSize) && Number.isFinite(tradeLever) && tradePrice > 0 && tradeSize > 0 && tradeLever > 0
    ? (tradePrice * tradeSize * contractValue) / tradeLever
    : undefined;
  const estimatedMargin = localEstimatedMargin;
  const rawMaxOpenSize = Number.isFinite(availableUsdt) && Number.isFinite(tradePrice) && Number.isFinite(tradeLever) && Number.isFinite(contractValue) && availableUsdt > 0 && tradePrice > 0 && tradeLever > 0 && contractValue > 0
    ? (availableUsdt * tradeLever) / (tradePrice * contractValue)
    : undefined;
  const maxOpenSize = rawMaxOpenSize !== undefined
    ? normalizeTradeSizeInput(String(rawMaxOpenSize), instrument, { enforceMin: false })
    : "";
  useEffect(() => {
    if (ticketMode !== "close") return;
    if (closePercentSide === "close-long" && longClosable > 0) return;
    if (closePercentSide === "close-short" && shortClosable > 0) return;
    if (longClosable > 0) {
      setClosePercentSide("close-long");
      return;
    }
    if (shortClosable > 0) {
      setClosePercentSide("close-short");
    }
  }, [closePercentSide, longClosable, shortClosable, ticketMode]);
  const closeSizeForSide = useCallback((side: TradeActionSide) => {
    if (side === "close-long") return longClosable;
    if (side === "close-short") return shortClosable;
    return undefined;
  }, [longClosable, shortClosable]);
  const sizeForPercent = useCallback((percent: number) => {
    if (ticketMode === "close") {
      const base = closeSizeForSide(closePercentSide);
      if (!Number.isFinite(base) || !base || base <= 0) return "";
      return normalizeTradeSizeInput(String((base * percent) / 100), instrument, { max: base, enforceMin: false });
    }
    return normalizeTradeSizeInput(precheck.percentSizes[percent] ?? "", instrument, { max: maxOpenSize });
  }, [closePercentSide, closeSizeForSide, instrument, maxOpenSize, precheck.percentSizes, ticketMode]);
  const tradeActions =
    ticketMode === "open"
      ? [
          { label: "做多", hint: "买入开多", className: "long", side: "long" as TradeActionSide, icon: TrendingUp },
          { label: "做空", hint: "卖出开空", className: "short", side: "short" as TradeActionSide, icon: TrendingDown }
        ]
      : [
          { label: "平多", hint: `可平 ${trimTradeSize(longClosable)} 张`, className: "close-long", side: "close-long" as TradeActionSide, icon: TrendingDown },
          { label: "平空", hint: `可平 ${trimTradeSize(shortClosable)} 张`, className: "close-short", side: "close-short" as TradeActionSide, icon: TrendingUp }
        ];
  const switchTicketMode = useCallback((nextMode: "open" | "close") => {
    if (nextMode === ticketMode) return;
    setTicketMode(nextMode);
    setSizeInput("");
    setAttachedExitsEnabled(false);
    setTakeProfitPrice("");
    setStopLossPrice("");
    setConfirmingOrder(null);
  }, [ticketMode]);
  const selectOrderType = useCallback((nextOrderType: OrderSpecV2OrderType) => {
    setOrderType(nextOrderType);
    setConfirmingOrder(null);
    if (nextOrderType === "trigger" || nextOrderType === "trailing") {
      setAttachedExitsEnabled(false);
      setTakeProfitPrice("");
      setStopLossPrice("");
    }
  }, []);
  const cancelConfirmation = useCallback(() => {
    setConfirmingOrder(null);
    const returnTarget = confirmationReturnFocusRef.current;
    confirmationReturnFocusRef.current = null;
    requestAnimationFrame(() => returnTarget?.focus());
  }, []);
  const prepareOrder = useCallback((side: TradeActionSide): { order?: PreparedTradeOrder; reason?: string } => {
    if (!account) return { reason: "未配置账号" };
    if (riskBlocked) return { reason: advancedBlockers[0] ?? precheck.reasons[0] ?? precheck.buttonReason(side) };
    if (!precheck.allowedSides[side]) return { reason: precheck.buttonReason(side) };
    if ((ticketMode === "open" && !["long", "short"].includes(side)) || (ticketMode === "close" && !["close-long", "close-short"].includes(side))) {
      return { reason: "下单方向与当前开平仓模式不一致" };
    }
    const normalizedSize = normalizeTradeSizeInput(effectiveSizeInput, instrument, { enforceMin: ticketMode === "open" });
    if (!normalizedSize || Number(normalizedSize) <= 0) return { reason: "下单数量不符合当前合约规则" };
    const closeMaxSize = ticketMode === "close" ? closeSizeForSide(side) : undefined;
    if (closeMaxSize !== undefined && Number(normalizedSize) > closeMaxSize) return { reason: `超过可平数量 ${trimTradeSize(closeMaxSize)} 张` };
    if (ticketMode === "open" && maxOpenSize && Number(normalizedSize) > Number(maxOpenSize)) {
      return { reason: t("trading:maxOpenExceededEstimated", { size: maxOpenSize }) };
    }

    const marketPrice = ticker?.instId === symbol ? ticker.last : "";
    const priceForOrder = orderType === "market"
      ? marketPrice
      : orderType === "trailing"
        ? trailingActivePrice ? normalizeTradePriceInput(trailingActivePrice, instrument) : ""
        : normalizeTradePriceInput(priceInput, instrument);
    if (!["market", "trailing"].includes(orderType) && !priceForOrder) return { reason: orderType === "trigger" ? "触发价不符合当前合约档位" : "价格不符合当前合约档位" };
    if (orderType === "market" && (!Number.isFinite(Number(priceForOrder)) || Number(priceForOrder) <= 0)) return { reason: "最新成交价不可用，暂不能冻结市价委托" };

    const estimatedEntryPrice = Number(orderEntryPrice || marketPrice || priceForOrder);
    const normalizedTakeProfit = takeProfitEnabled ? normalizeTradePriceInput(takeProfitPrice, instrument) : "";
    const normalizedStopLoss = stopLossEnabled ? normalizeTradePriceInput(stopLossPrice, instrument) : "";
    if (takeProfitEnabled) {
      if (side === "long" && Number(normalizedTakeProfit) <= estimatedEntryPrice) return { reason: "做多止盈价必须高于入场价" };
      if (side === "short" && Number(normalizedTakeProfit) >= estimatedEntryPrice) return { reason: "做空止盈价必须低于入场价" };
    }
    if (stopLossEnabled) {
      if (side === "long" && Number(normalizedStopLoss) >= estimatedEntryPrice) return { reason: "做多实际止损价必须低于入场价" };
      if (side === "short" && Number(normalizedStopLoss) <= estimatedEntryPrice) return { reason: "做空实际止损价必须高于入场价" };
    }

    const executionKey = createTradeExecutionKey(account.id, tradeEnvironment, symbol);
    const spec = buildOrderSpecV2({
      orderType,
      price: String(priceForOrder),
      triggerSource,
      triggerExecution,
      triggerOrderPrice: triggerExecution === "limit" ? normalizeTradePriceInput(triggerOrderPrice, instrument) : "",
      trailingActivePrice: priceForOrder,
      trailingCallbackRatio,
    });
    if (spec.trigger) Object.freeze(spec.trigger);
    if (spec.trailing) Object.freeze(spec.trailing);
    Object.freeze(spec);
    const attachAlgoOrds = takeProfitEnabled || stopLossEnabled ? [{
      attachAlgoClOrdId: createTradeAlgoClientId("a"),
      ...(normalizedTakeProfit ? { tpTriggerPx: normalizedTakeProfit, tpOrdPx: "-1", tpTriggerPxType: "last" } : {}),
      ...(normalizedStopLoss ? { slTriggerPx: normalizedStopLoss, slOrdPx: "-1", slTriggerPxType: "last" } : {}),
      sz: normalizedSize,
    }] : undefined;
    attachAlgoOrds?.forEach((item) => Object.freeze(item));
    if (attachAlgoOrds) Object.freeze(attachAlgoOrds);
    const request = Object.freeze({
      accountId: account.id,
      instId: symbol,
      tdMode: marginMode,
      orderType: legacyOrderType(orderType),
      ticketMode,
      action: side,
      price: String(priceForOrder),
      size: normalizedSize,
      lever: leverage,
      environment: tradeEnvironment,
      confirmedLive: tradeEnvironment === "live",
      operator: "user" as const,
      executionKey,
      algoClOrdId: orderType === "trigger" || orderType === "trailing" ? createTradeAlgoClientId("m") : undefined,
      orderSpecV2: spec,
      attachAlgoOrds,
    });
    const numericPrice = estimatedEntryPrice;
    const numericSize = Number(normalizedSize);
    const notional = numericPrice * numericSize * contractValue;
    return {
      order: Object.freeze({
        executionKey,
        request,
        spec,
        action: side,
        displayPrice: orderType === "market"
          ? `市价（参考 ${priceForOrder}）`
          : orderType === "trailing"
            ? priceForOrder ? `激活价 ${priceForOrder}` : "立即追踪"
            : String(priceForOrder),
        displaySize: normalizedSize,
        notional: Number.isFinite(notional) ? notional : undefined,
        estimatedMargin: Number.isFinite(notional) && tradeLever > 0 ? notional / tradeLever : undefined,
        estimatedFee: Number.isFinite(notional) ? notional * (["market", "ioc", "fok"].includes(orderType) ? 0.0005 : 0.0002) : undefined,
        takeProfitPrice: normalizedTakeProfit || undefined,
        stopLossPrice: normalizedStopLoss || undefined,
        trailingCallbackPercent: orderType === "trailing" ? trailingCallbackRatio : undefined,
        createdAt: Date.now(),
      }),
    };
  }, [account, advancedBlockers, closeSizeForSide, contractValue, effectiveSizeInput, instrument, leverage, marginMode, maxOpenSize, orderEntryPrice, orderType, precheck, priceInput, riskBlocked, stopLossEnabled, stopLossPrice, symbol, t, takeProfitEnabled, takeProfitPrice, ticketMode, ticker?.instId, ticker?.last, tradeEnvironment, tradeLever, trailingActivePrice, trailingCallbackRatio, triggerExecution, triggerOrderPrice, triggerSource]);

  const submitPreparedOrder = useCallback((prepared: PreparedTradeOrder) => {
    if (submittingSide) return;
    const submitSeq = ++submitRequestSeqRef.current;
    setSubmittingSide(prepared.action);
    setLastOrderState({
      scopeKey: `${prepared.request.accountId ?? "none"}:${prepared.request.environment}:${prepared.request.instId}`,
      status: "submitting",
      action: prepared.action,
      size: prepared.displaySize,
      message: "正在等待 OKX 接受委托",
      at: Date.now(),
    });
    void placeOkxOrder(prepared.request)
      .then((result) => {
        const orderId = result?.ordId || result?.clOrdId;
        const nextStatus = result && orderId ? "accepted" : "unknown";
        const message = orderId ? `${formatTradeTicketOrderType(prepared.spec.requestedOrderType)}委托 ${orderId}` : "请求已发送，但未取得可确认的订单编号";
        setLastOrderState({
          scopeKey: `${prepared.request.accountId ?? "none"}:${prepared.request.environment}:${prepared.request.instId}`,
          status: nextStatus,
          action: prepared.action,
          size: prepared.displaySize,
          message,
          at: Date.now(),
        });
        onNotify({
          kind: nextStatus === "accepted" ? "trade" : "warning",
          title: nextStatus === "accepted" ? `${prepared.request.environment === "live" ? "实盘" : "模拟盘"}委托已受理` : "委托状态待确认",
          message: `${prepared.request.instId} ${formatTradeTicketAction(prepared.action)} ${prepared.displaySize} 张，${message}`,
        });
        if (nextStatus === "accepted") void onRefreshAccount();
        void refreshTradeExecutionGuards();
      })
      .catch((error) => {
        logger.error("place prepared order failed", error, { executionKey: prepared.executionKey });
        const status = tradeSubmitFailureState(error);
        const message = formatTradeErrorMessage(error);
        setLastOrderState({
          scopeKey: `${prepared.request.accountId ?? "none"}:${prepared.request.environment}:${prepared.request.instId}`,
          status,
          action: prepared.action,
          size: prepared.displaySize,
          message,
          at: Date.now(),
        });
        onNotify({
          kind: status === "unknown" ? "warning" : "error",
          title: status === "unknown" ? "委托状态不明" : "委托提交失败",
          message,
        });
        void refreshTradeExecutionGuards();
      })
      .finally(() => {
        if (submitSeq === submitRequestSeqRef.current) setSubmittingSide(null);
      });
  }, [onNotify, onRefreshAccount, refreshTradeExecutionGuards, submittingSide]);

  const refreshAfterInstrumentOperation = async () => {
    try {
      onRefreshOrders();
    } catch (error) {
      logger.warn("refresh order views after instrument operation failed", { error: formatTradeErrorMessage(error), symbol });
    }
    try {
      await onRefreshAccount();
    } catch (error) {
      logger.warn("refresh account after instrument operation failed", { error: formatTradeErrorMessage(error), symbol });
    }
  };

  const publishInstrumentOperationFinal = async (
    kind: InstrumentOperationKind,
    scopeKey: string,
    view: InstrumentOperationView,
  ) => {
    const stage = instrumentOperationStageFromView(view);
    setInstrumentOperations((current) => ({
      ...current,
      [kind]: {
        ...current[kind],
        scopeKey,
        stage,
        view,
        message: view.error,
        updatedAt: Date.now(),
      },
    }));
    await refreshAfterInstrumentOperation();
    const progress = formatInstrumentOperationProgress(view);
    if (stage === "unknown") {
      onNotify({
        kind: "warning",
        title: `${formatInstrumentOperationKind(kind)}状态不明`,
        message: `${progress}${view.error ? `；${view.error}` : "；请先核对当前委托与持仓，勿重复执行"}`,
      });
      return;
    }
    const outcome = view.outcome ?? "failed";
    const notificationKind = outcome === "succeeded" || outcome === "no_op" ? "success" : outcome === "partial" ? "warning" : "error";
    onNotify({
      kind: notificationKind,
      title: `${formatInstrumentOperationKind(kind)}${outcome === "succeeded" ? "已完成" : outcome === "no_op" ? "无需处理" : outcome === "partial" ? "部分完成" : "失败"}`,
      message: `${progress}${view.counts.filledBeforeCancel > 0 ? ` · 撤销前成交 ${view.counts.filledBeforeCancel}` : ""}${view.error ? `；${view.error}` : ""}`,
    });
  };

  const publishInstrumentOperationUnknown = async (
    kind: InstrumentOperationKind,
    scopeKey: string,
    operationId: string,
    message: string,
  ) => {
    setInstrumentOperations((current) => ({
      ...current,
      [kind]: {
        ...current[kind],
        scopeKey,
        operationId,
        stage: "unknown",
        message,
        updatedAt: Date.now(),
      },
    }));
    await refreshAfterInstrumentOperation();
    onNotify({
      kind: "warning",
      title: `${formatInstrumentOperationKind(kind)}状态不明`,
      message: `${message}；操作编号 ${operationId}。请重新核对，勿重复执行。`,
    });
  };

  const pollInstrumentOperation = async (
    kind: InstrumentOperationKind,
    scope: InstrumentOperationScope,
    scopeKey: string,
    operationId: string,
    requestSeq: number,
    initialError?: string,
  ) => {
    let lastError = initialError ?? "";
    for (let attempt = 0; attempt < 18; attempt += 1) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, attempt === 0 ? 350 : 1_000));
      if (requestSeq !== instrumentOperationSeqRef.current[kind]) return;
      try {
        const view = await queryInstrumentOperation({
          operationId,
          accountId: scope.accountId,
          environment: scope.environment,
          instId: scope.instId,
          expectedKind: kind,
        });
        if (!view) throw new Error("紧急操作查询未返回结果");
        assertInstrumentOperationView(view, kind, scope, operationId);
        if (requestSeq !== instrumentOperationSeqRef.current[kind]) return;
        const stage = instrumentOperationStageFromView(view);
        setInstrumentOperations((current) => ({
          ...current,
          [kind]: {
            ...current[kind],
            scopeKey,
            operationId,
            stage,
            view,
            message: view.error,
            updatedAt: Date.now(),
          },
        }));
        if (stage === "terminal" || stage === "unknown") {
          await publishInstrumentOperationFinal(kind, scopeKey, view);
          return;
        }
      } catch (error) {
        if (requestSeq !== instrumentOperationSeqRef.current[kind]) return;
        lastError = formatTradeErrorMessage(error);
        const code = instrumentOperationErrorCode(error);
        if (code === "OPERATION_SCOPE_MISMATCH"
          || code === "OPERATION_CREDENTIAL_MISMATCH"
          || lastError.includes("结果作用域与请求不一致")) {
          await publishInstrumentOperationUnknown(kind, scopeKey, operationId, lastError);
          return;
        }
      }
    }
    if (requestSeq !== instrumentOperationSeqRef.current[kind]) return;
    await publishInstrumentOperationUnknown(
      kind,
      scopeKey,
      operationId,
      lastError || "多次严格查询后仍无法确认最终状态",
    );
  };

  useEffect(() => {
    const restoreSeq = ++instrumentOperationRestoreSeqRef.current;
    if (!account || !isTauriRuntime()) {
      setInstrumentOperationRestoreStatus("ready");
      return;
    }
    const scope: InstrumentOperationScope = {
      accountId: account.id,
      environment: tradeEnvironment,
      instId: symbol,
    };
    setInstrumentOperationRestoreStatus("loading");
    void fetchActiveInstrumentOperations(scope)
      .then((views) => {
        if (restoreSeq !== instrumentOperationRestoreSeqRef.current) return;
        if (!views) throw new Error("未决紧急操作查询未返回结果");
        const latestByKind = new Map<InstrumentOperationKind, InstrumentOperationView>();
        for (const view of views) {
          assertInstrumentOperationView(view, view.operationKind, scope, view.operationId);
          const current = latestByKind.get(view.operationKind);
          if (!current || view.updatedAt >= current.updatedAt) latestByKind.set(view.operationKind, view);
        }
        const polls = Array.from(latestByKind, ([kind, view]) => ({
          kind,
          view,
          requestSeq: ++instrumentOperationSeqRef.current[kind],
        }));
        setInstrumentOperations(() => {
          const next = createEmptyInstrumentOperationState();
          for (const { kind, view } of polls) {
            next[kind] = {
              scopeKey: tradeScopeKey,
              stage: instrumentOperationStageFromView(view),
              operationId: view.operationId,
              view,
              message: view.error ?? "已恢复未完成的紧急操作，正在严格对账",
              updatedAt: Date.now(),
            };
          }
          return next;
        });
        setInstrumentOperationRestoreStatus("ready");
        for (const { kind, view, requestSeq } of polls) {
          void pollInstrumentOperation(kind, scope, tradeScopeKey, view.operationId, requestSeq);
        }
      })
      .catch((error) => {
        if (restoreSeq !== instrumentOperationRestoreSeqRef.current) return;
        logger.error("restore unresolved instrument operations failed", error, { tradeScopeKey });
        setInstrumentOperationRestoreStatus("error");
      });
  }, [account, symbol, tradeEnvironment, tradeScopeKey]);

  const requestInstrumentOperationPreview = (kind: InstrumentOperationKind) => {
    if (!account) {
      onNotify({ kind: "warning", title: "紧急操作不可用", message: "请先配置 OKX 账号。" });
      return;
    }
    if (!account.permissions.read || !account.permissions.trade) {
      onNotify({ kind: "warning", title: "紧急操作不可用", message: "当前账号必须同时开启读取和交易权限。" });
      return;
    }
    if (instrumentOperationRestoreStatus !== "ready"
      || instrumentOperationBusy
      || instrumentOperationBlocksSameKind(instrumentOperations[kind], tradeScopeKey)
      || submittingSide
      || confirmingOrder
      || confirmingInstrumentOperation) return;
    const scope: InstrumentOperationScope = { accountId: account.id, environment: tradeEnvironment, instId: symbol };
    const scopeKey = `${account.id}:${tradeEnvironment}:${symbol}`;
    const requestSeq = ++instrumentOperationSeqRef.current[kind];
    setInstrumentOperations((current) => ({
      ...current,
      [kind]: { scopeKey, stage: "previewing", message: "正在严格读取当前合约状态", updatedAt: Date.now() },
    }));
    const previewRequest = kind === "cancel_orders" ? previewCancelInstrumentOrders : previewFlattenInstrumentPositions;
    void previewRequest(scope)
      .then((preview) => {
        if (!preview) throw new Error("紧急操作预览未返回结果");
        assertInstrumentOperationPreview(preview, kind, scope);
        if (requestSeq !== instrumentOperationSeqRef.current[kind]) return;
        setInstrumentOperations((current) => ({
          ...current,
          [kind]: { scopeKey, stage: "previewed", preview, message: "严格预览已生成", updatedAt: Date.now() },
        }));
        setConfirmingInstrumentOperation(preview);
      })
      .catch((error) => {
        if (requestSeq !== instrumentOperationSeqRef.current[kind]) return;
        const message = formatTradeErrorMessage(error);
        setInstrumentOperations((current) => ({
          ...current,
          [kind]: { scopeKey, stage: "failed", message, updatedAt: Date.now() },
        }));
        onNotify({ kind: "error", title: `${formatInstrumentOperationKind(kind)}预览失败`, message });
      });
  };

  const executeInstrumentOperation = (preview: InstrumentOperationPreview) => {
    const kind = preview.operationKind;
    const scope: InstrumentOperationScope = {
      accountId: preview.accountId,
      environment: preview.environment,
      instId: preview.instId,
    };
    const scopeKey = `${preview.accountId}:${preview.environment}:${preview.instId}`;
    if (scopeKey !== tradeScopeKey || preview.expiresAt <= Date.now()) {
      setConfirmingInstrumentOperation(null);
      setInstrumentOperations((current) => ({
        ...current,
        [kind]: { ...current[kind], scopeKey, stage: "failed", message: "预览已过期或作用域已变化，请重新预览", updatedAt: Date.now() },
      }));
      onNotify({ kind: "warning", title: "紧急操作未提交", message: "预览已过期或账户、环境、合约已变化，请重新预览。" });
      return;
    }
    let operationId: string;
    try {
      operationId = crypto.randomUUID();
    } catch (error) {
      const message = `无法生成稳定操作编号：${formatTradeErrorMessage(error)}`;
      setConfirmingInstrumentOperation(null);
      setInstrumentOperations((current) => ({
        ...current,
        [kind]: { ...current[kind], scopeKey, stage: "failed", message, updatedAt: Date.now() },
      }));
      onNotify({ kind: "error", title: "紧急操作未提交", message });
      return;
    }
    const requestSeq = ++instrumentOperationSeqRef.current[kind];
    setConfirmingInstrumentOperation(null);
    setInstrumentOperations((current) => ({
      ...current,
      [kind]: {
        scopeKey,
        stage: "submitting",
        preview,
        operationId,
        message: "已冻结预览，正在提交",
        updatedAt: Date.now(),
      },
    }));
    const executeRequest = kind === "cancel_orders" ? executeCancelInstrumentOrders : executeFlattenInstrumentPositions;
    void executeRequest({
      operationId,
      previewId: preview.previewId,
      accountId: scope.accountId,
      environment: scope.environment,
      instId: scope.instId,
      confirmed: true,
      confirmedLive: scope.environment === "live" ? true : undefined,
    })
      .then((view) => {
        if (!view) throw new Error("紧急操作执行未返回结果");
        assertInstrumentOperationView(view, kind, scope, operationId);
        if (requestSeq !== instrumentOperationSeqRef.current[kind]) return;
        const stage = instrumentOperationStageFromView(view, true);
        setInstrumentOperations((current) => ({
          ...current,
          [kind]: { scopeKey, stage, preview, operationId, view, message: view.error, updatedAt: Date.now() },
        }));
        if (stage === "terminal" || stage === "unknown") {
          void publishInstrumentOperationFinal(kind, scopeKey, view);
          return;
        }
        void pollInstrumentOperation(kind, scope, scopeKey, operationId, requestSeq);
      })
      .catch((error) => {
        if (requestSeq !== instrumentOperationSeqRef.current[kind]) return;
        const message = formatTradeErrorMessage(error);
        if (isProvenNotSubmittedInstrumentOperationError(error)) {
          setInstrumentOperations((current) => ({
            ...current,
            [kind]: { scopeKey, stage: "failed", preview, operationId, message, updatedAt: Date.now() },
          }));
          onNotify({ kind: "error", title: `${formatInstrumentOperationKind(kind)}未提交`, message });
          return;
        }
        setInstrumentOperations((current) => ({
          ...current,
          [kind]: { scopeKey, stage: "reconciling", preview, operationId, message: `执行响应不明确，正在按操作编号查询：${message}`, updatedAt: Date.now() },
        }));
        void pollInstrumentOperation(kind, scope, scopeKey, operationId, requestSeq, message);
      });
  };

  const retryInstrumentOperationReconciliation = (kind: InstrumentOperationKind) => {
    const state = instrumentOperations[kind];
    if (!account || state.scopeKey !== tradeScopeKey || !state.operationId) return;
    const scope: InstrumentOperationScope = { accountId: account.id, environment: tradeEnvironment, instId: symbol };
    const requestSeq = ++instrumentOperationSeqRef.current[kind];
    setInstrumentOperations((current) => ({
      ...current,
      [kind]: { ...current[kind], stage: "reconciling", message: "正在重新执行严格只读对账", updatedAt: Date.now() },
    }));
    void pollInstrumentOperation(kind, scope, tradeScopeKey, state.operationId, requestSeq);
  };

  const requestSubmitOrder = useCallback((side: TradeActionSide) => {
    if (submittingSide
      || confirmingOrder
      || confirmingInstrumentOperation
      || (ticketMode === "open" && (instrumentOperationLocksOrderEntry || tradeExecutionGuardBlocksOpen))) return;
    const prepared = prepareOrder(side);
    if (!prepared.order) {
      onNotify({
        kind: "warning",
        title: tradeEnvironment === "live" ? "实盘下单已阻断" : "委托暂不可提交",
        message: prepared.reason ?? "下单参数无效",
      });
      return;
    }
    if (latencyGuard.warnings.length > 0) {
      onNotify({
        kind: "warning",
        title: tradeEnvironment === "live" ? "实盘下单延迟风险" : "模拟盘下单延迟提示",
        message: latencyGuard.warnings.join("；")
      });
    }
    if (tradeEnvironment === "live") {
      confirmationReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setConfirmingOrder(prepared.order);
      return;
    }
    submitPreparedOrder(prepared.order);
  }, [confirmingInstrumentOperation, confirmingOrder, instrumentOperationLocksOrderEntry, latencyGuard.warnings, onNotify, prepareOrder, submitPreparedOrder, submittingSide, ticketMode, tradeEnvironment, tradeExecutionGuardBlocksOpen]);

  const unresolvedOrder = tradeExecutionGuardBlocksOpen;
  const tradeActionStates = tradeActions.map((action) => {
    const closeMax = closeSizeForSide(action.side);
    const entryPrice = Number(orderEntryPrice || effectiveOrderPrice);
    const directionalReason = takeProfitEnabled && action.side === "long" && Number(takeProfitPrice) <= entryPrice
          ? "做多止盈价必须高于入场价"
          : takeProfitEnabled && action.side === "short" && Number(takeProfitPrice) >= entryPrice
            ? "做空止盈价必须低于入场价"
            : stopLossEnabled && action.side === "long" && Number(stopLossPrice) >= entryPrice
              ? "做多实际止损价必须低于入场价"
              : stopLossEnabled && action.side === "short" && Number(stopLossPrice) <= entryPrice
                ? "做空实际止损价必须高于入场价"
                : "";
    const disabledReason = submittingSide !== null
      ? "正在提交委托"
      : confirmingOrder
        ? "请先处理实盘确认"
        : confirmingInstrumentOperation
          ? "请先处理紧急操作确认"
          : ticketMode === "open" && instrumentOperationLocksOrderEntry
            ? instrumentOperationRestoreStatus === "loading"
              ? "正在恢复当前合约的未决紧急操作"
              : instrumentOperationRestoreStatus === "error"
                ? "未决紧急操作恢复失败，已阻止新开仓"
                : currentInstrumentOperations.some((state) => state.stage === "unknown")
              ? "紧急操作状态不明，请先重新核对当前委托与持仓"
              : "当前合约紧急操作正在执行"
        : ticketMode === "open" && (readingLeverage || settingLeverage)
          ? readingLeverage ? "正在读取 OKX 杠杆" : "正在同步 OKX 杠杆"
          : ticketMode === "open" && unresolvedOrder
            ? tradeExecutionGuardStatus === "loading"
              ? "正在恢复当前合约的未决交易执行"
              : tradeExecutionGuardStatus === "error"
                ? "未决交易执行恢复失败，已阻止新开仓"
                : "存在未完成对账的委托，请先在挂单或审计记录中核对"
            : riskBlocked
              ? advancedBlockers[0] ?? precheck.reasons[0] ?? precheck.buttonReason(action.side)
              : directionalReason
                ? directionalReason
              : !precheck.allowedSides[action.side]
                ? precheck.buttonReason(action.side)
                : closeMax !== undefined && Number(effectiveSizeInput) > closeMax
                  ? `超过可平数量 ${trimTradeSize(closeMax)} 张`
                  : ticketMode === "open" && maxOpenSize && Number(effectiveSizeInput) > Number(maxOpenSize)
                    ? t("trading:maxOpenExceeded", { size: maxOpenSize })
                    : "";
    return { ...action, disabledReason, disabled: Boolean(disabledReason) };
  });
  const tradeBlockerText = Array.from(
    new Set(tradeActionStates.map((action) => action.disabledReason).filter(Boolean))
  ).join(" · ");
  const priceFieldError = orderType === "market" ? "" : [...advancedBlockers, ...precheck.reasons].find((reason) => /价格|触发价|档位|激活/.test(reason)) ?? "";
  const sizeFieldError = precheck.reasons.find((reason) => /张数|数量|最小下单|单笔最大|步进/.test(reason)) ?? "";

  useEffect(() => {
    const handleTicketHotkey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || document.visibilityState !== "visible" || !document.hasFocus()) return;
      if (event.code === "Escape" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && confirmingOrder) {
        event.preventDefault();
        event.stopPropagation();
        cancelConfirmation();
        return;
      }
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || confirmingOrder || hasVisibleTradeHotkeyBlocker()) return;
      const target = event.target;
      if (isEditableKeyboardTarget(target)) return;

      let handled = true;
      if (event.code === "KeyO") switchTicketMode("open");
      else if (event.code === "KeyC") switchTicketMode("close");
      else if (event.code === "KeyL") selectOrderType("limit");
      else if (event.code === "KeyM") selectOrderType("market");
      else if (event.code === "KeyT") selectOrderType("trigger");
      else if (event.code === "KeyP") priceInputRef.current?.focus();
      else if (event.code === "KeyQ") sizeInputRef.current?.focus();
      else if (["Digit1", "Digit2", "Digit3", "Digit4"].includes(event.code)) {
        const percent = ({ Digit1: 25, Digit2: 50, Digit3: 75, Digit4: 100 } as const)[event.code as "Digit1" | "Digit2" | "Digit3" | "Digit4"];
        setSizeInput(sizeForPercent(percent));
      } else {
        const action = actionForTradeHotkey(event.code, ticketMode);
        if (action) {
          const state = tradeActionStates.find((item) => item.side === action);
          if (!state?.disabled) requestSubmitOrder(action);
        } else {
          handled = false;
        }
      }
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", handleTicketHotkey);
    return () => window.removeEventListener("keydown", handleTicketHotkey);
  }, [cancelConfirmation, confirmingOrder, requestSubmitOrder, selectOrderType, sizeForPercent, switchTicketMode, ticketMode, tradeActionStates]);

  return (
    <div ref={ticketRootRef} className="ticket-shell" data-onboarding-target="trade">
      <div className="ticket-tabs">
        <button type="button" aria-pressed={ticketMode === "open"} className={ticketMode === "open" ? "active" : ""} onClick={() => switchTicketMode("open")}>{t("trading:openPosition")}</button>
        <button type="button" aria-pressed={ticketMode === "close"} className={ticketMode === "close" ? "active" : ""} onClick={() => switchTicketMode("close")}>{t("trading:closePosition")}</button>
      </div>
      {!account && (
        <div className="empty-account">
          <ShieldAlert size={20} />
          <div className="empty-account-copy">
            <strong>{t("common:unconfiguredAccount")}</strong>
            <span>{t("trading:marketWithoutAccount")}</span>
          </div>
          <button type="button" onClick={onOpenAccountManager}>{t("trading:addAccount")}</button>
        </div>
      )}
      {account && (!account.permissions.read || !account.permissions.trade) && (
        <div className="account-permission-note">
          <ShieldAlert size={16} />
          <span>
            {!account.permissions.read
              ? t("trading:readPermissionRequired")
              : t("trading:tradePermissionRequired")}
          </span>
          <button type="button" onClick={onOpenAccountManager}>{t("trading:adjustPermissions")}</button>
        </div>
      )}
      <div className="ticket-form">
        <section className="ticket-section ticket-section--risk">
        <div className="ticket-control-grid">
          <div className="ticket-field">
            <label>{t("trading:marginMode")}</label>
            <div className="segmented">
              <button type="button" aria-pressed={marginMode === "cross"} className={marginMode === "cross" ? "active" : ""} onClick={() => setMarginMode("cross")}>{t("trading:cross")}</button>
              <button type="button" aria-pressed={marginMode === "isolated"} className={marginMode === "isolated" ? "active" : ""} onClick={() => setMarginMode("isolated")}>{t("trading:isolated")}</button>
            </div>
          </div>
          <div className="ticket-field">
            <label htmlFor={leverageFieldId}>{t("trading:leverage")}</label>
            <div className="leverage-control">
              <TerminalSelect
                id={leverageFieldId}
                ariaLabel={t("trading:leverage")}
                value={leverage}
                disabled={!account || readingLeverage || settingLeverage}
                invalid={precheck.reasons.some((reason) => reason.includes("杠杆"))}
                ariaDescribedBy={account ? `${ticketFieldId}-leverage-status` : undefined}
                options={leverageOptions.map((optionValue) => ({ value: optionValue, label: `${optionValue}X` }))}
                onChange={(nextLeverage) => {
                  const previousLeverage = leverage;
                  if (nextLeverage === previousLeverage) return;
                  setLeverage(nextLeverage);
                  syncLeverage(nextLeverage, previousLeverage);
                }}
              />
            </div>
          </div>
        </div>
        {account && (
          <div id={`${ticketFieldId}-leverage-status`} className="leverage-status">
            <span>{leverageStatus}</span>
            <strong>{formatLeverageRows(leverageInfo)}</strong>
          </div>
        )}
        </section>
        <section className="ticket-section ticket-section--execution">
        <label htmlFor={orderTypeFieldId}>{t("trading:orderType")}</label>
        <TerminalSelect
          id={orderTypeFieldId}
          ariaLabel={t("trading:orderType")}
          value={orderType}
          options={[
            { value: "limit", label: t("trading:limitOrder") },
            { value: "market", label: t("trading:marketOrder") },
            { value: "post_only", label: "Post Only" },
            { value: "ioc", label: "IOC" },
            { value: "fok", label: "FOK" },
            { value: "trigger", label: t("trading:triggerOrder") },
            { value: "trailing", label: t("trading:trailingStop") }
          ]}
          onChange={(value) => selectOrderType(value as OrderSpecV2OrderType)}
        />
        <label htmlFor={priceFieldId}>{t(orderType === "trigger" ? "trading:triggerPriceUsdt" : orderType === "trailing" ? "trading:activationPriceUsdtOptional" : "trading:priceUsdt")}</label>
        <div className="ticket-price-control">
          <input
            id={priceFieldId}
            ref={priceInputRef}
            data-trade-hotkey-input="price"
            value={orderType === "market" ? t("trading:market") : orderType === "trailing" ? trailingActivePrice : priceInput}
            readOnly={orderType === "market"}
            aria-invalid={Boolean(priceFieldError) || undefined}
            aria-describedby={priceHelpId}
            onChange={(event) => orderType === "trailing" ? setTrailingActivePrice(event.target.value) : setPriceInput(event.target.value)}
            onBlur={() => {
              if (orderType === "market") return;
              if (orderType === "trailing") setTrailingActivePrice((value) => value ? normalizeTradePriceInput(value, instrument) : "");
              else setPriceInput((value) => normalizeTradePriceInput(value, instrument));
            }}
          />
          {orderType !== "market" && (
            <div className="bbo-price-actions" aria-label={t("trading:fillFromOrderBook")}>
              <button type="button" disabled={!bestBid} onClick={() => orderType === "trailing" ? setTrailingActivePrice(normalizeTradePriceInput(bestBid, instrument)) : setPriceInput(normalizeTradePriceInput(bestBid, instrument))}>{t("trading:bestBid")}</button>
              <button type="button" disabled={!bestAsk} onClick={() => orderType === "trailing" ? setTrailingActivePrice(normalizeTradePriceInput(bestAsk, instrument)) : setPriceInput(normalizeTradePriceInput(bestAsk, instrument))}>{t("trading:bestAsk")}</button>
            </div>
          )}
        </div>
        <span id={priceHelpId} className={clsx("ticket-field-help", priceFieldError && "error")}>{priceFieldError || (instrument ? t("trading:priceTick", { value: instrument.tickSz }) : t("trading:waitingContractRules"))}</span>
        {orderType === "trigger" && (
          <div className="ticket-advanced-fields">
            <div className="ticket-field">
              <label htmlFor={triggerSourceFieldId}>触发价来源</label>
              <TerminalSelect
                id={triggerSourceFieldId}
                ariaLabel="触发价来源"
                value={triggerSource}
                options={[
                  { value: "last", label: "最新成交价" },
                  { value: "mark", label: "标记价格" },
                  { value: "index", label: "指数价格" }
                ]}
                onChange={(value) => setTriggerSource(value as OrderSpecV2TriggerSource)}
              />
            </div>
            <div className="ticket-field">
              <span id={`${ticketFieldId}-trigger-execution-label`} className="ticket-field-label">触发后执行</span>
              <div className="segmented" role="group" aria-labelledby={`${ticketFieldId}-trigger-execution-label`}>
                <button type="button" className={triggerExecution === "market" ? "active" : ""} aria-pressed={triggerExecution === "market"} onClick={() => setTriggerExecution("market")}>市价</button>
                <button type="button" className={triggerExecution === "limit" ? "active" : ""} aria-pressed={triggerExecution === "limit"} onClick={() => setTriggerExecution("limit")}>限价</button>
              </div>
            </div>
            {triggerExecution === "limit" && (
              <div className="ticket-field ticket-field-wide">
                <label htmlFor={triggerOrderPriceFieldId}>触发后限价(USDT)</label>
                <input
                  id={triggerOrderPriceFieldId}
                  value={triggerOrderPrice}
                  aria-invalid={advancedBlockers.some((reason) => reason.includes("触发后的限价")) || undefined}
                  aria-describedby={`${triggerOrderPriceFieldId}-help`}
                  onChange={(event) => setTriggerOrderPrice(event.target.value)}
                  onBlur={() => setTriggerOrderPrice((value) => normalizeTradePriceInput(value, instrument))}
                />
                <span id={`${triggerOrderPriceFieldId}-help`} className="ticket-field-help">触发后按该限价挂单</span>
              </div>
            )}
          </div>
        )}
        {orderType === "trailing" && (
          <div className="ticket-field">
            <label htmlFor={trailingCallbackFieldId}>回调幅度(%)</label>
            <input
              id={trailingCallbackFieldId}
              value={trailingCallbackRatio}
              placeholder="0.1 - 5"
              aria-invalid={advancedBlockers.some((reason) => reason.includes("回调幅度")) || undefined}
              aria-describedby={`${trailingCallbackFieldId}-help`}
              onChange={(event) => setTrailingCallbackRatio(event.target.value)}
            />
            <span id={`${trailingCallbackFieldId}-help`} className="ticket-field-help">价格回撤该比例时触发；价格源固定为最新成交价</span>
          </div>
        )}
        </section>
        <section className="ticket-section ticket-section--sizing">
        <label htmlFor={sizeFieldId}>{t("trading:quantityContracts")}</label>
        {ticketMode === "close" && (
          <div className="close-size-summary">
            <button type="button" className={closePercentSide === "close-long" ? "active" : ""} disabled={longClosable <= 0} onClick={() => { setClosePercentSide("close-long"); setSizeInput(""); }}>
              {t("trading:closableLong", { quantity: trimTradeSize(longClosable) || "0" })}
            </button>
            <button type="button" className={closePercentSide === "close-short" ? "active" : ""} disabled={shortClosable <= 0} onClick={() => { setClosePercentSide("close-short"); setSizeInput(""); }}>
              {t("trading:closableShort", { quantity: trimTradeSize(shortClosable) || "0" })}
            </button>
          </div>
        )}
        <input
          id={sizeFieldId}
          ref={sizeInputRef}
          data-trade-hotkey-input="size"
          value={effectiveSizeInput}
          aria-invalid={Boolean(sizeFieldError) || undefined}
          aria-describedby={sizeHelpId}
          data-onboarding-focus
          placeholder={instrument ? t("trading:sizeMinStepCompact", { min: instrument.minSz, step: instrument.lotSz }) : t("trading:enterOkxContractQuantity")}
          onChange={(event) => setSizeInput(event.target.value)}
          onBlur={() => setSizeInput((value) => normalizeTradeSizeInput(value, instrument, ticketMode === "open" ? { max: maxOpenSize } : {}))}
        />
        <span id={sizeHelpId} className={clsx("ticket-field-help", sizeFieldError && "error")}>{sizeFieldError || (instrument ? t("trading:sizeMinStep", { min: instrument.minSz, step: instrument.lotSz }) : t("trading:waitingContractRules"))}</span>
        <div className="percent-row">
          {[25, 50, 75, 100].map((percent) => (
            <button
              type="button"
              key={percent}
              className={sizeInput && sizeInput === sizeForPercent(percent) ? "active" : ""}
              onClick={() => setSizeInput(sizeForPercent(percent))}
            >
              {percent}%
            </button>
          ))}
        </div>
        {ticketMode === "open" && !["trigger", "trailing"].includes(orderType) && (
          <div className="attached-exits-panel">
            <div className="attached-exits-toggle">
              <input
                id={attachedExitsFieldId}
                type="checkbox"
                checked={attachedExitsEnabled}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  setAttachedExitsEnabled(enabled);
                  if (!enabled) {
                    setTakeProfitPrice("");
                    setStopLossPrice("");
                  }
                }}
              />
              <label htmlFor={attachedExitsFieldId}>{t("trading:takeProfitStopLoss")}</label>
              <span>{t("trading:marketAfterTrigger")}</span>
            </div>
            {attachedExitsEnabled && (
              <div className="attached-exits-fields">
                <label className="attached-exit-field" htmlFor={takeProfitFieldId}>
                  <span>{t("trading:takeProfitTrigger")}</span>
                  <input
                    id={takeProfitFieldId}
                    inputMode="decimal"
                    value={takeProfitPrice}
                    aria-invalid={takeProfitEnabled && advancedBlockers.some((reason) => reason.includes("止盈")) || undefined}
                    onChange={(event) => setTakeProfitPrice(event.target.value)}
                    onBlur={() => setTakeProfitPrice((value) => value ? normalizeTradePriceInput(value, instrument) : "")}
                    placeholder={t("trading:optional")}
                  />
                </label>
                <label className="attached-exit-field" htmlFor={stopLossFieldId}>
                  <span>{t("trading:stopLossPrice")}</span>
                  <input
                    id={stopLossFieldId}
                    inputMode="decimal"
                    value={stopLossPrice}
                    aria-invalid={stopLossEnabled && advancedBlockers.some((reason) => reason.includes("实际止损")) || undefined}
                    onChange={(event) => setStopLossPrice(event.target.value)}
                    onBlur={() => setStopLossPrice((value) => value ? normalizeTradePriceInput(value, instrument) : "")}
                    placeholder={t("trading:optional")}
                  />
                </label>
              </div>
            )}
          </div>
        )}
        {account && ticketMode === "open" && (
          <div className="order-estimates">
            <span>{t("trading:availableBalance")} <b>{Number.isFinite(availableUsdt) ? formatUsdt(availableUsdt) : "--"}</b></span>
            <span>{t("trading:estimatedMargin")} <b>{estimatedMargin === undefined ? "--" : formatUsdt(estimatedMargin)}</b></span>
            <span>{t("trading:maxOpen")} <b>{maxOpenSize || "--"} {t("trading:contracts")}</b></span>
          </div>
        )}
        </section>
        <div className="trade-submit-zone">
          {lastOrderState?.scopeKey === tradeScopeKey && (
            <div className={clsx("trade-last-order", lastOrderState.status)} role="status">
              <span>{lastOrderState.status === "submitting" ? "提交中" : lastOrderState.status === "accepted" ? "已受理" : lastOrderState.status === "unknown" ? "状态不明" : "已拒绝"}</span>
              <strong>{formatTradeTicketAction(lastOrderState.action)} {lastOrderState.size} 张</strong>
              <small>{lastOrderState.message}</small>
            </div>
          )}
          {(tradeExecutionGuards.length > 0 || tradeExecutionGuardStatus === "error") && (
            <div className="trade-execution-guard" role="status">
              <span>未决执行</span>
              <strong>{tradeExecutionGuards.length > 0 ? `${tradeExecutionGuards.length} 项` : "读取失败"}</strong>
              <small title={tradeExecutionGuards[0]?.message}>
                {tradeExecutionGuards[0]
                  ? `${tradeExecutionGuards[0].action} · ${tradeExecutionGuards[0].status} · ${tradeExecutionGuards[0].message}`
                  : "无法确认当前合约是否存在未完成交易执行"}
              </small>
              <button
                type="button"
                aria-label="重新对账未决交易执行"
                title="按稳定客户端订单 ID 重新执行只读对账"
                disabled={tradeExecutionGuardStatus === "loading"}
                onClick={() => void reconcileCurrentTradeExecutionGuards()}
              >
                <RefreshCw size={12} />
              </button>
            </div>
          )}
          {tradeBlockerText && (
            <div className="trade-submit-state" role="status">
              <CircleAlert size={12} />
              <span>{tradeBlockerText}</span>
            </div>
          )}
          <div className="trade-buttons">
            {tradeActionStates.map((action) => {
              const ActionIcon = action.icon;
              return (
                <button
                  type="button"
                  className={action.className}
                  disabled={action.disabled}
                  title={action.disabledReason || t("trading:submitOrder")}
                  onClick={() => requestSubmitOrder(action.side)}
                  key={action.side}
                >
                  <span className="trade-label"><ActionIcon size={15} />{submittingSide === action.side ? t("trading:submitting") : t(action.side === "long" ? "trading:long" : action.side === "short" ? "trading:short" : action.side === "close-long" ? "trading:closeLong" : "trading:closeShort")}</span>
                  <span className="trade-hint">{t(tradeEnvironment === "live" ? "common:live" : "common:demo")} · {t(action.side === "long" ? "trading:buyOpenLong" : action.side === "short" ? "trading:sellOpenShort" : action.side === "close-long" ? "trading:sellCloseLong" : "trading:buyCloseShort")}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      {instrumentOperationPortalsReady && flattenPositionsTargetRef.current && createPortal(
        <InstrumentOperationTabAction
          kind="flatten_positions"
          symbol={symbol}
          state={instrumentOperations.flatten_positions}
          active={instrumentOperations.flatten_positions.scopeKey === tradeScopeKey}
          disabled={!account || !account.permissions.read || !account.permissions.trade || submittingSide !== null || Boolean(confirmingOrder) || Boolean(confirmingInstrumentOperation) || instrumentOperationRestoreStatus !== "ready" || instrumentOperationBusy || instrumentOperationBlocksSameKind(instrumentOperations.flatten_positions, tradeScopeKey)}
          onPreview={() => requestInstrumentOperationPreview("flatten_positions")}
          onRetry={() => retryInstrumentOperationReconciliation("flatten_positions")}
        />,
        flattenPositionsTargetRef.current,
      )}
      {instrumentOperationPortalsReady && cancelOrdersTargetRef.current && createPortal(
        <InstrumentOperationTabAction
          kind="cancel_orders"
          symbol={symbol}
          state={instrumentOperations.cancel_orders}
          active={instrumentOperations.cancel_orders.scopeKey === tradeScopeKey}
          disabled={!account || !account.permissions.read || !account.permissions.trade || submittingSide !== null || Boolean(confirmingOrder) || Boolean(confirmingInstrumentOperation) || instrumentOperationRestoreStatus !== "ready" || instrumentOperationBusy || instrumentOperationBlocksSameKind(instrumentOperations.cancel_orders, tradeScopeKey)}
          onPreview={() => requestInstrumentOperationPreview("cancel_orders")}
          onRetry={() => retryInstrumentOperationReconciliation("cancel_orders")}
        />,
        cancelOrdersTargetRef.current,
      )}
      {confirmingOrder && (
        <ConfirmDialog
          title="确认实盘下单"
          message={`${confirmingOrder.request.instId} ${formatTradeTicketAction(confirmingOrder.action)}，${formatTradeTicketOrderType(confirmingOrder.spec.requestedOrderType)}，数量 ${confirmingOrder.displaySize} 张，${formatPreparedOrderExecutionSummary(confirmingOrder)}，杠杆 ${confirmingOrder.request.lever}X，${confirmingOrder.request.tdMode === "cross" ? "全仓" : "逐仓"}${confirmingOrder.takeProfitPrice ? `。随单止盈 ${confirmingOrder.takeProfitPrice}` : ""}${confirmingOrder.stopLossPrice ? `。随单止损 ${confirmingOrder.stopLossPrice}` : ""}。确认后将按此冻结快照提交到 OKX 实盘账户。`}
          confirmText={t("trading:confirmLiveSubmit")}
          danger
          onCancel={cancelConfirmation}
          onConfirm={() => {
            const prepared = confirmingOrder;
            cancelConfirmation();
            submitPreparedOrder(prepared);
          }}
        />
      )}
      {confirmingInstrumentOperation && (
        <InstrumentOperationConfirmDialog
          preview={confirmingInstrumentOperation}
          busy={instrumentOperationBusy}
          onCancel={() => setConfirmingInstrumentOperation(null)}
          onConfirm={() => executeInstrumentOperation(confirmingInstrumentOperation)}
        />
      )}
    </div>
  );
}

function formatOpportunityDirection(item: Pick<TradeOpportunity, "direction" | "intent">) {
  if (item.intent === "close") return item.direction === "short" ? "平空" : "平多";
  return item.direction === "short" ? "做空" : "做多";
}

type PendingOrdersView = "limitMarket" | "advancedLimit" | "takeProfitStopLoss" | "trailing" | "planned" | "other";

function BottomPanel({
  activeTab,
  setActiveTab,
  flattenPositionsTargetRef,
  cancelOrdersTargetRef,
  account,
  snapshot,
  episodes,
  episodesStatus,
  historicalOrders,
  historicalOrdersStatus,
  historicalFills,
  historicalFillsStatus,
  algoOrders,
  algoOrdersPendingReadComplete,
  algoOrdersStatus,
  accountBills,
  accountBillsStatus,
  tradeAuditEvents,
  tradeAuditStatus,
  accountBillsArchiveStatus,
  accountBillsArchiveBusy,
  accountBillsArchiveImporting,
  assetMap,
  marketAssets,
  onAccountBillsArchive,
  onImportAccountBillsArchive,
  privateStatus,
  tradeEnvironment,
  ticker,
  onNotify,
  onRefreshAccount,
  onRefreshAlgoOrders,
  onRemoveAlgoOrder,
  onDismissPendingOrder,
  onAmendPendingOrder,
  onSelectInstrument
}: {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  flattenPositionsTargetRef: MutableRefObject<HTMLDivElement | null>;
  cancelOrdersTargetRef: MutableRefObject<HTMLDivElement | null>;
  account?: AccountSummary;
  snapshot: PrivateAccountSnapshot | null;
  episodes: PositionEpisode[];
  episodesStatus: string;
  historicalOrders: HistoricalOrderSummary[];
  historicalOrdersStatus: string;
  historicalFills: HistoricalFillSummary[];
  historicalFillsStatus: string;
  algoOrders: OkxAlgoOrder[];
  algoOrdersPendingReadComplete: boolean;
  algoOrdersStatus: string;
  accountBills: AccountBillSummary[];
  accountBillsStatus: string;
  tradeAuditEvents: TradeAuditEventSummary[];
  tradeAuditStatus: string;
  accountBillsArchiveStatus: AccountBillsArchiveStatus | null;
  accountBillsArchiveBusy: boolean;
  accountBillsArchiveImporting: boolean;
  assetMap: Map<string, OkxInstrumentSummary>;
  marketAssets: MarketAssetsSummary | null;
  onAccountBillsArchive: (apply: boolean) => Promise<void>;
  onImportAccountBillsArchive: () => Promise<void>;
  privateStatus: string;
  tradeEnvironment: "demo" | "live";
  ticker: Ticker | null;
  onNotify: (notification: Omit<AppNotification, "id" | "createdAt">) => void;
  onRefreshAccount: () => Promise<void>;
  onRefreshAlgoOrders: () => void;
  onRemoveAlgoOrder: (order: Pick<OkxAlgoOrder, "algoId" | "algoClOrdId" | "instId">) => void;
  onDismissPendingOrder: (order: Pick<OkxPendingOrder, "ordId" | "clOrdId" | "algoId" | "algoClOrdId">) => void;
  onAmendPendingOrder: (order: OkxPendingOrder) => void;
  onSelectInstrument: (instId: string) => void;
}) {
  const { t } = useTranslation(["trading", "common"]);
  const [selectedEpisode, setSelectedEpisode] = useState<PositionEpisode | null>(null);
  const [positionDialog, setPositionDialog] = useState<{ type: "close" | "tpsl"; position: OkxPosition } | null>(null);
  const [marketClosePosition, setMarketClosePosition] = useState<OkxPosition | null>(null);
  const [amendingAlgo, setAmendingAlgo] = useState<OkxAlgoOrder | null>(null);
  const [confirmCancelAlgo, setConfirmCancelAlgo] = useState<OkxAlgoOrder | null>(null);
  const [ordersView, setOrdersView] = useState<PendingOrdersView>("limitMarket");
  const selectInstrument = useCallback((instId: string) => {
    const normalized = instId.trim().toUpperCase();
    if (!normalized.endsWith("-SWAP")) return;
    onSelectInstrument(normalized);
  }, [onSelectInstrument]);
  const symbolSelectLabel = useCallback(
    (instId: string) => t("trading:switchToContract", { symbol: instId }),
    [t],
  );
  const [historicalOrdersView, setHistoricalOrdersView] = useState<PendingOrdersView>("limitMarket");
  // These tabs read the whole account, matching positions and open orders. The
  // filter narrows what is already loaded, so switching it never refetches.
  const [instrumentFilter, setInstrumentFilter] = useState(ALL_INSTRUMENTS_FILTER);
  const activePositions = snapshot?.positions.filter((position) => Math.abs(Number(position.pos)) > 0) ?? [];
  const filterInstruments = useCallback(
    <T extends { instId?: string | null }>(items: T[]) =>
      instrumentFilter === ALL_INSTRUMENTS_FILTER
        ? items
        : items.filter((item) => item.instId === instrumentFilter),
    [instrumentFilter]
  );
  const algoOrdersReadIsAuthoritative =
    algoOrdersPendingReadComplete &&
    (algoOrdersStatus === "已同步" || algoOrdersStatus === "暂无策略委托");
  const mergedAlgoOrders = useMemo(() => {
    const snapshotOrders = snapshot?.orders ?? [];
    if (!algoOrdersReadIsAuthoritative) {
      return mergePendingAlgoOrders(
        algoOrders,
        snapshotOrders,
        account?.id ?? "",
        tradeEnvironment,
      );
    }
    // A successful pending-order read is authoritative for current algo orders.
    // Keep only a very recent local projection while OKX propagates a new submit.
    const recentCutoff = Date.now() - 15_000;
    const recentSnapshotOrders = snapshotOrders.filter((order) => {
      if (!order.isAlgo && !order.algoId && !order.algoClOrdId) return false;
      const timestamp = Number(order.uTime || order.cTime);
      return Number.isFinite(timestamp) && timestamp >= recentCutoff;
    });
    return mergePendingAlgoOrders(
      algoOrders,
      recentSnapshotOrders,
      account?.id ?? "",
      tradeEnvironment,
    );
  }, [
    account?.id,
    algoOrders,
    algoOrdersReadIsAuthoritative,
    snapshot?.orders,
    tradeEnvironment,
  ]);
  const filteredHistoricalFills = useMemo(
    () => filterInstruments(historicalFills),
    [filterInstruments, historicalFills],
  );
  const filteredEpisodes = useMemo(
    () => filterInstruments(episodes),
    [episodes, filterInstruments],
  );
  const filteredAccountBills = useMemo(
    () => filterInstruments(accountBills),
    [accountBills, filterInstruments],
  );
  const filteredTradeAuditEvents = useMemo(
    () => filterInstruments(tradeAuditEvents),
    [filterInstruments, tradeAuditEvents],
  );
  // Every instrument present in the loaded data, so the filter can only offer
  // choices that actually match something.
  const filterOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const list of [
      mergedAlgoOrders as { instId?: string | null }[],
      snapshot?.orders ?? [],
      historicalOrders,
      historicalFills,
      episodes,
      accountBills,
      tradeAuditEvents
    ]) {
      for (const item of list) {
        const instId = item.instId?.trim();
        if (instId) seen.add(instId);
      }
    }
    return [
      { value: ALL_INSTRUMENTS_FILTER, label: t("trading:allContracts") },
      ...Array.from(seen)
        .sort((left, right) => left.localeCompare(right))
        .map((instId) => ({ value: instId, label: instId }))
    ];
  }, [accountBills, episodes, historicalFills, historicalOrders, mergedAlgoOrders, snapshot?.orders, t, tradeAuditEvents]);
  // A filter pinned to an instrument that has dropped out of the data would show
  // an empty table with no way back, so fall back to showing everything.
  useEffect(() => {
    if (
      instrumentFilter !== ALL_INSTRUMENTS_FILTER
      && !filterOptions.some((option) => option.value === instrumentFilter)
    ) {
      setInstrumentFilter(ALL_INSTRUMENTS_FILTER);
    }
  }, [filterOptions, instrumentFilter]);
  const instrumentFilterTabs = new Set(["orders", "history", "fills", "episodes", "bills", "audit"]);
  const pendingAlgoOrders = mergedAlgoOrders.filter(isActiveAlgoOrder);
  const normalOrders = snapshot?.orders.filter(isOrdinaryPendingOrder) ?? [];
  const limitMarketOrders = normalOrders.filter((order) => classifyOrdinaryPendingOrderGroup(order.ordType) === "limitMarket");
  const advancedLimitOrders = normalOrders.filter((order) => classifyOrdinaryPendingOrderGroup(order.ordType) === "advancedLimit");
  const takeProfitStopLossOrders = pendingAlgoOrders.filter((order) => classifyAlgoPendingOrderGroup(order.ordType) === "takeProfitStopLoss");
  const trailingOrders = pendingAlgoOrders.filter((order) => classifyAlgoPendingOrderGroup(order.ordType) === "trailing");
  const plannedOrders = pendingAlgoOrders.filter((order) => classifyAlgoPendingOrderGroup(order.ordType) === "planned");
  const otherStrategyOrders = pendingAlgoOrders.filter((order) => classifyAlgoPendingOrderGroup(order.ordType) === "other");
  const pendingOrderTabs: Array<{ id: PendingOrdersView; label: string; count: number }> = [
    { id: "limitMarket", label: t("trading:limitMarketOrders"), count: limitMarketOrders.length },
    { id: "advancedLimit", label: t("trading:advancedLimitOrders"), count: advancedLimitOrders.length },
    { id: "takeProfitStopLoss", label: t("trading:takeProfitStopLossOrders"), count: takeProfitStopLossOrders.length },
    { id: "trailing", label: t("trading:trailingStopOrders"), count: trailingOrders.length },
    { id: "planned", label: t("trading:plannedOrders"), count: plannedOrders.length },
    ...(otherStrategyOrders.length > 0 ? [{ id: "other" as const, label: t("trading:otherStrategyOrders"), count: otherStrategyOrders.length }] : [])
  ];
  const selectedNormalOrders = ordersView === "limitMarket" ? limitMarketOrders : ordersView === "advancedLimit" ? advancedLimitOrders : [];
  const selectedAlgoOrders = ordersView === "takeProfitStopLoss"
    ? takeProfitStopLossOrders
    : ordersView === "trailing"
      ? trailingOrders
      : ordersView === "planned"
        ? plannedOrders
        : ordersView === "other" ? otherStrategyOrders : [];
  // Tab badges keep counting the whole account so the instrument filter cannot
  // hide orders that exist on another contract.
  const filteredSelectedNormalOrders = filterInstruments(selectedNormalOrders);
  const filteredSelectedAlgoOrders = filterInstruments(selectedAlgoOrders);

  const historicalAlgoOrders = algoOrders.filter((order) => order.sourceEndpoint === "orders-algo-history");
  const historicalLimitMarketOrders = historicalOrders.filter((order) => classifyOrdinaryPendingOrderGroup(order.ordType) === "limitMarket");
  const historicalAdvancedLimitOrders = historicalOrders.filter((order) => classifyOrdinaryPendingOrderGroup(order.ordType) === "advancedLimit");
  const historicalTakeProfitStopLossOrders = historicalAlgoOrders.filter((order) => classifyAlgoPendingOrderGroup(order.ordType) === "takeProfitStopLoss");
  const historicalTrailingOrders = historicalAlgoOrders.filter((order) => classifyAlgoPendingOrderGroup(order.ordType) === "trailing");
  const historicalPlannedOrders = historicalAlgoOrders.filter((order) => classifyAlgoPendingOrderGroup(order.ordType) === "planned");
  const historicalOtherStrategyOrders = historicalAlgoOrders.filter((order) => classifyAlgoPendingOrderGroup(order.ordType) === "other");
  const historicalOrderTabs: Array<{ id: PendingOrdersView; label: string; count: number }> = [
    { id: "limitMarket", label: t("trading:limitMarketOrders"), count: historicalLimitMarketOrders.length },
    { id: "advancedLimit", label: t("trading:advancedLimitOrders"), count: historicalAdvancedLimitOrders.length },
    { id: "takeProfitStopLoss", label: t("trading:takeProfitStopLossOrders"), count: historicalTakeProfitStopLossOrders.length },
    { id: "trailing", label: t("trading:trailingStopOrders"), count: historicalTrailingOrders.length },
    { id: "planned", label: t("trading:plannedOrders"), count: historicalPlannedOrders.length },
    ...(historicalOtherStrategyOrders.length > 0 ? [{ id: "other" as const, label: t("trading:otherStrategyOrders"), count: historicalOtherStrategyOrders.length }] : [])
  ];
  const selectedHistoricalOrders = historicalOrdersView === "limitMarket"
    ? historicalLimitMarketOrders
    : historicalOrdersView === "advancedLimit" ? historicalAdvancedLimitOrders : [];
  const selectedHistoricalAlgoOrders = historicalOrdersView === "takeProfitStopLoss"
    ? historicalTakeProfitStopLossOrders
    : historicalOrdersView === "trailing"
      ? historicalTrailingOrders
      : historicalOrdersView === "planned"
        ? historicalPlannedOrders
        : historicalOrdersView === "other" ? historicalOtherStrategyOrders : [];
  const filteredSelectedHistoricalOrders = filterInstruments(selectedHistoricalOrders);
  const filteredSelectedHistoricalAlgoOrders = filterInstruments(selectedHistoricalAlgoOrders);
  const tabs = [
    ["positions", `${t("trading:positions")}(${activePositions.length})`],
    ["orders", `${t("trading:openOrders")}(${normalOrders.length + pendingAlgoOrders.length})`],
    ["history", t("trading:historicalOrders")],
    ["fills", t("trading:historicalFills")],
    ["episodes", t("trading:historicalPositions")],
    ["bills", t("trading:bills")],
    ["audit", t("trading:audit")],
    ["funds", `${t("trading:balance")}(${snapshot?.balances.length ?? 0})`]
  ];
  const isEmpty = !account || !snapshot;
  return (
    <div className="bottom-panel">
      <div className="bottom-toolbar">
        <div className="bottom-tabs">
          {tabs.map(([id, label]) => <button className={id === activeTab ? "active" : ""} onClick={() => setActiveTab(id)} key={id}>{label}</button>)}
        </div>
        <div className="bottom-tab-actions">
          {instrumentFilterTabs.has(activeTab) && filterOptions.length > 1 && (
            <label className="bottom-instrument-filter">
              <span>{t("trading:contract")}</span>
              <TerminalSelect
                ariaLabel={t("trading:filterByContract")}
                value={instrumentFilter}
                options={filterOptions}
                onChange={setInstrumentFilter}
                preserveOptionLabels
              />
            </label>
          )}
          <div className="bottom-action-slot" ref={flattenPositionsTargetRef} hidden={activeTab !== "positions"} />
          <div className="bottom-action-slot" ref={cancelOrdersTargetRef} hidden={activeTab !== "orders"} />
        </div>
      </div>
      <div className="positions-table">
        {activeTab === "positions" && (
          <>
            <div className="table-head positions"><span>{t("trading:contract")}</span><span>{t("trading:direction")}</span><span>{t("trading:contracts")}</span><span>{t("trading:positionSize")}</span><span>{t("trading:entryMark")}</span><span>{t("trading:pnlAmount")}</span><span>{t("trading:marginUsed")}</span><span>{t("trading:liquidationPrice")}</span><span>{t("trading:leverage")}</span><span>{t("common:actions")}</span></div>
            {activePositions.map((position) => {
              const instrument = assetMap.get(position.instId);
              const coinAmount = positionCoinAmount(position, instrument);
              const baseCcy = positionBaseCurrency(position, instrument);
              const margin = position.imr || position.margin;
              return (
                <div className="table-row positions" key={`${position.instId}-${position.posSide}-${position.posId || position.uTime}`}>
                  <SymbolLabel symbol={position.instId} marketAssets={marketAssets} secondary={position.mgnMode || "cross"} onSelect={selectInstrument} selectLabel={symbolSelectLabel(position.instId)} />
                  <span className={clsx("cell-tone", toneBySide(undefined, position.posSide))}>{formatPositionSide(position.posSide, t)}</span>
                  <span>{formatAmount(position.pos)}<small>{t("trading:contracts")}</small></span>
                  <span>{coinAmount === undefined ? "--" : formatAmount(String(coinAmount))}<small>{baseCcy}</small></span>
                  <span>{fmtPrice(position.avgPx)}<small>{t("trading:markAbbreviation")} {fmtPrice(position.markPx)}</small></span>
                  <span className={clsx("cell-tone", toneByNumber(position.upl))}>
                    {formatAmount(position.upl)}
                    <small>{formatRatio(position.uplRatio)}</small>
                  </span>
                  <span>{formatAmount(margin)}<small>{position.mgnMode || "--"}</small></span>
                  <span className={clsx("cell-tone", liquidationRiskTone(position, ticker?.last))}>{fmtPrice(position.liqPx)}</span>
                  <span><b className="risk-badge">{formatAmount(position.lever)}x</b></span>
                  <span className="position-actions">
                    <button type="button" onClick={() => setPositionDialog({ type: "tpsl", position })}>{t("trading:takeProfitStopLoss")}</button>
                    <button type="button" onClick={() => setPositionDialog({ type: "close", position })}>{t("trading:closePosition")}</button>
                    <button type="button" className="danger" onClick={() => setMarketClosePosition(position)}>{t("trading:marketCloseAll")}</button>
                  </span>
                </div>
              );
            })}
            {isEmpty && <div className="empty-row">{account ? t("trading:accountDataStatus", { status: formatPrivateWsStatus(privateStatus, t) }) : t("trading:noAccountPositions")}</div>}
            {snapshot && activePositions.length === 0 && <div className="empty-row">{t("trading:noPositions")}</div>}
          </>
        )}
        {activeTab === "orders" && (
          <>
            <div className="sub-tabs order-type-tabs" role="tablist" aria-label={t("trading:openOrderTypes")}>
              {pendingOrderTabs.map((tab) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={ordersView === tab.id}
                  className={ordersView === tab.id ? "active" : ""}
                  onClick={() => setOrdersView(tab.id)}
                  key={tab.id}
                >
                  {tab.label}{tab.count > 0 ? `(${tab.count})` : ""}
                </button>
              ))}
            </div>
            {(ordersView === "limitMarket" || ordersView === "advancedLimit") && (
              <>
                <div className="table-head orders"><span>{t("trading:contract")}</span><span>{t("trading:direction")}</span><span>{t("trading:typeAndId")}</span><span>{t("trading:triggerAndOrderPrice")}</span><span>{t("common:quantity")}</span><span>{t("trading:filledQuantity")}</span><span>{t("trading:statusAndTime")}</span></div>
                {filteredSelectedNormalOrders.map((order) => {
                  const triggerPx = order.isAlgo ? (order.triggerPx || order.px) : "";
                  const orderPx = order.isAlgo ? (order.ordPx || "") : (order.ordPx || order.px);
                  const triggerDisplay = triggerPx ? fmtPrice(triggerPx) : "--";
                  const orderDisplay = orderPx ? formatAlgoExecPrice(orderPx, t) : "--";
                  return (
                    <div className="table-row orders" key={order.ordId || order.clOrdId || order.algoId || order.algoClOrdId}>
                      <SymbolLabel symbol={order.instId} marketAssets={marketAssets} secondary={order.tdMode} onSelect={selectInstrument} selectLabel={symbolSelectLabel(order.instId)} />
                      <span className={clsx("cell-tone", toneBySide(order.side, order.posSide))}>{formatOrderSide(order.side, order.posSide, t)}</span>
                      <span>
                        {formatOrderType(order.ordType, t)}
                        <small className="order-id" title={order.isAlgo ? order.algoId || order.algoClOrdId || "--" : order.ordId || order.clOrdId || "--"}>
                          {order.isAlgo ? `${t("trading:planned")} · ${order.algoId || order.algoClOrdId || "--"}` : order.ordId || order.clOrdId || "--"}
                        </small>
                      </span>
                      <span className="order-trigger-price">
                        <b>{triggerDisplay}</b>
                        <em>/</em>
                        <b>{orderDisplay}</b>
                        <small>{order.isAlgo ? formatTriggerPriceType(order.triggerPxType, t) : t("trading:triggerAndOrder")}</small>
                      </span>
                      <span>{formatAmount(order.sz)}<small>{order.lever ? `${order.lever}x` : "--"}</small></span>
                      <span>{formatAmount(order.accFillSz)}<small>{order.avgPx ? `${t("trading:averageAbbreviation")} ${fmtPrice(order.avgPx)}` : "--"}</small></span>
                      <span className="order-state-cell">
                        <span className="order-state-main">
                          <b className={clsx("status-pill", toneByState(order.state || "live"))}>{order.isAlgo ? formatAlgoState(order.state || "live", t) : formatOrderState(order.state || "live", t)}</b>
                          {!order.isAlgo && order.ordType === "limit" && Number(orderPx) > 0 && (
                            <button
                              type="button"
                              className="table-action icon-only"
                              title={t("trading:modifyOrderPrice")}
                              aria-label={t("trading:modifyOrderPrice")}
                              onClick={() => onAmendPendingOrder(order)}
                            >
                              <Edit3 size={13} />
                            </button>
                          )}
                          <button
                            type="button"
                            className="table-action"
                            onClick={() => {
                              if (!account) return;
                              void cancelOkxOrder({
                                accountId: account.id,
                                environment: tradeEnvironment,
                                instId: order.instId,
                                ordId: order.ordId,
                                clOrdId: order.clOrdId,
                                isAlgo: order.isAlgo,
                                algoId: order.algoId,
                                algoClOrdId: order.algoClOrdId
                              })
                                .then((result) => {
                                  onNotify({
                                    kind: "trade",
                                    title: order.isAlgo ? "撤销计划委托已接受" : "撤单请求已接受",
                                    message: `${order.instId} ${result?.ordId || result?.clOrdId || order.algoId || order.ordId}`
                                  });
                                  onDismissPendingOrder({
                                    ordId: result?.ordId || order.ordId,
                                    clOrdId: result?.clOrdId || order.clOrdId,
                                    algoId: order.isAlgo ? (result?.ordId || order.algoId) : "",
                                    algoClOrdId: order.isAlgo ? (result?.clOrdId || order.algoClOrdId) : "",
                                  });
                                  void onRefreshAccount();
                                })
                                .catch((error) => {
                                  logger.error("cancel order failed", error);
                                  onNotify({
                                    kind: "error",
                                    title: "撤单失败",
                                    message: formatTradeErrorMessage(error)
                                  });
                                });
                            }}
                          >
                            {t("trading:cancelOrder")}
                          </button>
                        </span>
                        <small>{formatDateTime(order.uTime || order.cTime)}</small>
                      </span>
                    </div>
                  );
                })}
                {isEmpty && <div className="empty-row">{account ? t("trading:accountDataStatus", { status: formatPrivateWsStatus(privateStatus, t) }) : t("trading:noAccountOpenOrders")}</div>}
                {snapshot && filteredSelectedNormalOrders.length === 0 && <div className="empty-row">{t("trading:noOrdersInCategory", { type: pendingOrderTabs.find((tab) => tab.id === ordersView)?.label ?? t("trading:openOrders") })}</div>}
              </>
            )}
            {(ordersView === "takeProfitStopLoss" || ordersView === "trailing" || ordersView === "planned" || ordersView === "other") && (
              <>
                <div className="table-head algo-orders">
                  <span>{t("trading:contract")}</span><span>{t("trading:direction")}</span><span>{t("common:type")}</span><span>{t("common:quantity")}</span><span>{ordersView === "takeProfitStopLoss" ? t("trading:takeProfit") : ordersView === "trailing" ? t("trading:activationPrice") : ordersView === "planned" ? `${t("trading:triggerPrice")} / ${t("trading:takeProfit")}` : t("trading:triggerPrice")}</span><span>{ordersView === "takeProfitStopLoss" ? t("trading:stopLoss") : ordersView === "trailing" ? t("trading:callbackRange") : ordersView === "planned" ? `${t("trading:orderPriceAfterTrigger")} / ${t("trading:stopLoss")}` : t("trading:orderPriceAfterTrigger")}</span><span>{t("common:status")}</span><span>{t("trading:operator")}</span><span>{t("common:time")}</span><span>{t("common:actions")}</span>
                </div>
                {filteredSelectedAlgoOrders.map((order) => {
                  const algoGroup = classifyAlgoPendingOrderGroup(order.ordType);
                  const isTakeProfitStopLoss = algoGroup === "takeProfitStopLoss";
                  const isTrailingOrder = algoGroup === "trailing";
                  const isPlannedOrder = algoGroup === "planned";
                  const triggerPurpose = isPlannedOrder ? classifyAlgoTriggerPurpose(order, snapshot?.positions ?? []) : null;
                  const triggerExecution = formatAlgoExecPrice(order.ordPx, t);
                  const trailingCallback = order.callbackRatio
                    ? `${order.callbackRatio}%`
                    : order.callbackSpread ? fmtPrice(order.callbackSpread) : "--";
                  const trailingCallbackLabel = order.callbackRatio ? t("trading:callbackRatio") : order.callbackSpread ? t("trading:callbackSpread") : "--";
                  const primaryPrice = isTakeProfitStopLoss
                    ? order.tpTriggerPx
                    : isPlannedOrder
                      ? triggerPurpose === "stopLoss" ? "" : order.triggerPx
                      : isTrailingOrder ? order.activePx || order.triggerPx : order.triggerPx || order.tpTriggerPx;
                  const secondaryPrice = isTakeProfitStopLoss
                    ? order.slTriggerPx
                    : isPlannedOrder
                      ? triggerPurpose === "entry" ? order.ordPx : triggerPurpose === "stopLoss" ? order.triggerPx : ""
                      : isTrailingOrder ? "" : order.ordPx || order.slTriggerPx;
                  const primaryDetail = isTakeProfitStopLoss
                    ? `${t("trading:orderAbbreviation")} ${formatAlgoExecPrice(order.tpOrdPx, t)}`
                    : !isPlannedOrder
                      ? isTrailingOrder ? t("trading:activationPrice") : formatTriggerPriceType(order.triggerPxType, t)
                      : triggerPurpose === "entry"
                        ? formatTriggerPriceType(order.triggerPxType, t)
                        : triggerPurpose === "takeProfit"
                          ? `${t("trading:takeProfit")} · ${t("trading:orderAbbreviation")} ${triggerExecution}`
                          : triggerPurpose === "close"
                            ? `${t("trading:closePosition")} · ${t("trading:orderAbbreviation")} ${triggerExecution}`
                            : "--";
                  const secondaryDetail = isTakeProfitStopLoss
                    ? `${t("trading:orderAbbreviation")} ${formatAlgoExecPrice(order.slOrdPx, t)}`
                    : !isPlannedOrder
                      ? isTrailingOrder ? trailingCallbackLabel : t("trading:orderPriceAfterTrigger")
                      : triggerPurpose === "entry"
                        ? t("trading:orderPriceAfterTrigger")
                        : triggerPurpose === "stopLoss"
                          ? `${t("trading:stopLoss")} · ${t("trading:orderAbbreviation")} ${triggerExecution}`
                          : "--";
                  const primaryTone = isTakeProfitStopLoss || triggerPurpose === "takeProfit"
                    ? (primaryPrice ? "positive" : "muted")
                    : triggerPurpose === "entry" || !isPlannedOrder ? toneBySide(order.side, order.posSide) : "muted";
                  const secondaryTone = isTakeProfitStopLoss || triggerPurpose === "stopLoss"
                    ? (secondaryPrice ? "negative" : "muted")
                    : "muted";
                  return (
                  <div className="table-row algo-orders" data-order-group={algoGroup} data-trigger-purpose={triggerPurpose ?? undefined} key={order.algoId || order.algoClOrdId || `${order.instId}-${order.cTime}`}>
                    <SymbolLabel symbol={order.instId} marketAssets={marketAssets} secondary={order.tdMode || "--"} onSelect={selectInstrument} selectLabel={symbolSelectLabel(order.instId)} />
                    <span className={clsx("cell-tone", toneBySide(order.side, order.posSide))}>{formatOrderSide(order.side, order.posSide, t)}</span>
                    <span>{formatAlgoOrderType(order.ordType, t)}<small>{t("trading:notTriggered")}</small></span>
                    <span>{formatAmount(order.sz)}<small>{t("trading:filledAbbreviation")} {formatAmount(order.actualSz)}</small></span>
                    <span className={clsx("cell-tone", primaryTone)}>{primaryPrice ? fmtPrice(primaryPrice) : "--"}<small>{primaryDetail}</small></span>
                    <span className={clsx("cell-tone", secondaryTone)}>{isTrailingOrder ? trailingCallback : !secondaryPrice ? "--" : isTakeProfitStopLoss || (isPlannedOrder && triggerPurpose === "stopLoss") ? fmtPrice(secondaryPrice) : formatAlgoExecPrice(secondaryPrice, t)}<small>{secondaryDetail}</small></span>
                    <span><b className={clsx("status-pill", toneByState(order.state))}>{formatAlgoState(order.state, t)}</b><small>{order.actualSide || order.failCode || "--"}</small></span>
                    <span>{formatEpisodeOrigin(order.operator || "user", t)}<small>{order.algoId || order.algoClOrdId}</small></span>
                    <span>{formatDateTime(order.uTime || order.cTime)}</span>
                    <span className="position-actions">
                      {["trigger", "conditional", "oco"].includes(order.ordType.toLowerCase()) && <button type="button" onClick={() => setAmendingAlgo(order)}>{t("common:edit")}</button>}
                      <button
                        type="button"
                        className="danger"
                        onClick={() => {
                          if (!account) return;
                          const run = (confirmedLive = false) => {
                            void cancelOkxAlgoOrder({
                              accountId: account.id,
                              environment: tradeEnvironment,
                              instId: order.instId,
                              algoId: order.algoId,
                              algoClOrdId: order.algoClOrdId,
                              confirmedLive
                            })
                              .then((result) => {
                                onNotify({ kind: "trade", title: "撤销策略单已接受", message: `${order.instId} ${result?.ordId || result?.clOrdId || order.algoId}` });
                                onRefreshAlgoOrders();
                                void onRefreshAccount();
                              })
                              .catch((error) => {
                                logger.error("cancel algo order failed", error);
                                onNotify({ kind: "error", title: "撤销策略单失败", message: formatTradeErrorMessage(error) });
                              });
                          };
                          if (tradeEnvironment === "live") setConfirmCancelAlgo(order);
                          else run(false);
                        }}
                      >
                        {t("trading:cancelOrder")}
                      </button>
                    </span>
                  </div>
                  );
                })}
                {!account && <div className="empty-row">{t("trading:noAccountOpenOrders")}</div>}
                {account && filteredSelectedAlgoOrders.length === 0 && <div className="empty-row">{t("trading:noOrdersInCategory", { type: pendingOrderTabs.find((tab) => tab.id === ordersView)?.label ?? t("trading:algoOrders") })} {t("trading:algoOrdersStatus", { status: formatPrivateDataStatus(algoOrdersStatus, t) })}</div>}
              </>
            )}
          </>
        )}
        {activeTab === "funds" && (
          <>
            <div className="table-head funds"><span>{t("trading:currency")}</span><span>{t("trading:equity")}</span><span>{t("trading:availableEquity")}</span><span>{t("trading:availableBalance")}</span><span>{t("trading:cashBalance")}</span><span>{t("trading:frozen")}</span><span>{t("trading:updatedAt")}</span></div>
            {snapshot?.balances.map((balance) => (
              <div className="table-row funds" key={balance.ccy}>
                <SymbolLabel symbol={balance.ccy} marketAssets={marketAssets} />
                <span>{formatAmount(balance.eq)}</span>
                <span>{formatAmount(balance.availEq)}</span>
                <span>{formatAmount(balance.availBal)}</span>
                <span>{formatAmount(balance.cashBal)}</span>
                <span>{formatAmount(balance.frozenBal)}</span>
                <span>{formatMs(balance.uTime || String(snapshot.syncedAt))}</span>
              </div>
            ))}
            {isEmpty && <div className="empty-row">{account ? t("trading:accountDataStatus", { status: formatPrivateWsStatus(privateStatus, t) }) : t("trading:noAccountBalances")}</div>}
            {snapshot && snapshot.balances.length === 0 && <div className="empty-row">{t("trading:noBalances")}</div>}
          </>
        )}
        {activeTab === "history" && (
          <>
            <div className="sub-tabs order-type-tabs" role="tablist" aria-label={t("trading:historicalOrderTypes")}>
              {historicalOrderTabs.map((tab) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={historicalOrdersView === tab.id}
                  className={historicalOrdersView === tab.id ? "active" : ""}
                  onClick={() => setHistoricalOrdersView(tab.id)}
                  key={tab.id}
                >
                  {tab.label}{tab.count > 0 ? `(${tab.count})` : ""}
                </button>
              ))}
            </div>
            {(historicalOrdersView === "limitMarket" || historicalOrdersView === "advancedLimit") && (
              <>
                <div className="table-head historical-orders">
                  <span>{t("trading:contract")}</span><span>{t("trading:direction")}</span><span>{t("common:type")}</span><span>{t("common:price")}</span><span>{t("common:quantity")}</span><span>{t("common:status")}</span><span>{t("trading:pnlAndFee")}</span><span>{t("trading:operator")}</span><span>{t("common:time")}</span>
                </div>
                {filteredSelectedHistoricalOrders.map((order) => (
                  <div className="table-row historical-orders" key={order.ordId || order.clOrdId || `${order.instId}-${order.syncedAt}`}>
                    <SymbolLabel symbol={order.instId} marketAssets={marketAssets} secondary={order.sourceEndpoint} onSelect={selectInstrument} selectLabel={symbolSelectLabel(order.instId)} />
                    <span className={clsx("cell-tone", toneBySide(order.side, order.posSide))}>{formatOrderSide(order.side ?? "", order.posSide ?? "", t)}</span>
                    <span>{formatOrderType(order.ordType ?? "", t)}<small>{order.tdMode || "--"}</small></span>
                    <span>{fmtPrice(order.px ?? undefined)}<small>{t("trading:averageAbbreviation")} {fmtPrice(order.avgPx ?? undefined)}</small></span>
                    <span>{formatAmount(order.sz ?? undefined)}<small>{t("trading:filledAbbreviation")} {formatAmount(order.accFillSz ?? undefined)}</small></span>
                    <span><b className={clsx("status-pill", toneByState(order.state))}>{formatOrderState(order.state ?? "", t)}</b></span>
                    <span className={clsx("cell-tone", toneByNumber(order.pnl))}>
                      {formatAmount(order.pnl ?? undefined)}
                      <small>{t("trading:feeAbbreviation")} {formatAmount(order.fee ?? undefined)}</small>
                    </span>
                    <span>{formatEpisodeOrigin(order.operator || "unknown", t)}<small>{order.strategyId || order.sessionId || "--"}</small></span>
                    <span>{formatDateTime(order.okxUtime ?? order.okxCtime ?? order.syncedAt)}</span>
                  </div>
                ))}
                {!account && <div className="empty-row">{t("trading:noAccountOrderHistory")}</div>}
                {account && filteredSelectedHistoricalOrders.length === 0 && <div className="empty-row">{t("trading:noOrdersInCategory", { type: historicalOrderTabs.find((tab) => tab.id === historicalOrdersView)?.label ?? t("trading:historicalOrders") })} {t("trading:historySyncStatus", { type: t("trading:historicalOrders"), status: formatPrivateDataStatus(historicalOrdersStatus, t) })}</div>}
              </>
            )}
            {(historicalOrdersView === "takeProfitStopLoss" || historicalOrdersView === "trailing" || historicalOrdersView === "planned" || historicalOrdersView === "other") && (
              <>
                <div className="table-head historical-orders">
                  <span>{t("trading:contract")}</span><span>{t("trading:direction")}</span><span>{t("common:type")}</span><span>{historicalOrdersView === "takeProfitStopLoss" ? t("trading:takeProfit") : historicalOrdersView === "trailing" ? t("trading:activationPrice") : t("trading:triggerPrice")}</span><span>{historicalOrdersView === "takeProfitStopLoss" ? t("trading:stopLoss") : historicalOrdersView === "trailing" ? t("trading:callbackRange") : t("trading:orderPriceAfterTrigger")}</span><span>{t("common:quantity")}</span><span>{t("common:status")}</span><span>{t("trading:operator")}</span><span>{t("common:time")}</span>
                </div>
                {filteredSelectedHistoricalAlgoOrders.map((order) => {
                  const group = classifyAlgoPendingOrderGroup(order.ordType);
                  const primaryPrice = group === "takeProfitStopLoss" ? order.tpTriggerPx : group === "trailing" ? order.activePx || order.triggerPx : order.triggerPx || order.tpTriggerPx;
                  const secondaryPrice = group === "takeProfitStopLoss" ? order.slTriggerPx : order.ordPx || order.slTriggerPx;
                  const primaryExecution = group === "takeProfitStopLoss" ? order.tpOrdPx : "";
                  const secondaryExecution = group === "takeProfitStopLoss" ? order.slOrdPx : "";
                  const trailingCallback = order.callbackRatio
                    ? `${order.callbackRatio}%`
                    : order.callbackSpread ? fmtPrice(order.callbackSpread) : "--";
                  const trailingCallbackLabel = order.callbackRatio ? t("trading:callbackRatio") : order.callbackSpread ? t("trading:callbackSpread") : "--";
                  return (
                    <div className="table-row historical-orders" data-order-group={group} key={order.algoId || order.algoClOrdId || `${order.instId}-${order.uTime}`}>
                      <SymbolLabel symbol={order.instId} marketAssets={marketAssets} secondary={order.sourceEndpoint} onSelect={selectInstrument} selectLabel={symbolSelectLabel(order.instId)} />
                      <span className={clsx("cell-tone", toneBySide(order.side, order.posSide))}>{formatOrderSide(order.side, order.posSide, t)}</span>
                      <span>{formatAlgoOrderType(order.ordType, t)}<small>{order.tdMode || "--"}</small></span>
                      <span>{fmtPrice(primaryPrice)}<small>{primaryExecution ? `${t("trading:orderAbbreviation")} ${formatAlgoExecPrice(primaryExecution, t)}` : group === "trailing" ? t("trading:activationPrice") : formatTriggerPriceType(order.triggerPxType, t)}</small></span>
                      <span>{group === "trailing" ? trailingCallback : group === "takeProfitStopLoss" ? fmtPrice(secondaryPrice) : formatAlgoExecPrice(secondaryPrice, t)}<small>{secondaryExecution ? `${t("trading:orderAbbreviation")} ${formatAlgoExecPrice(secondaryExecution, t)}` : group === "trailing" ? trailingCallbackLabel : group === "planned" ? t("trading:orderPriceAfterTrigger") : "--"}</small></span>
                      <span>{formatAmount(order.sz)}<small>{t("trading:filledAbbreviation")} {formatAmount(order.actualSz)}</small></span>
                      <span><b className={clsx("status-pill", toneByState(order.state))}>{formatAlgoState(order.state, t)}</b><small>{order.failCode || order.actualSide || "--"}</small></span>
                      <span>{formatEpisodeOrigin(order.operator || "unknown", t)}<small>{order.algoId || order.algoClOrdId || "--"}</small></span>
                      <span>{formatDateTime(order.uTime || order.triggerTime || order.cTime)}</span>
                    </div>
                  );
                })}
                {!account && <div className="empty-row">{t("trading:noAccountOrderHistory")}</div>}
                {account && filteredSelectedHistoricalAlgoOrders.length === 0 && <div className="empty-row">{t("trading:noOrdersInCategory", { type: historicalOrderTabs.find((tab) => tab.id === historicalOrdersView)?.label ?? t("trading:historicalOrders") })} {t("trading:algoOrdersStatus", { status: formatPrivateDataStatus(algoOrdersStatus, t) })}</div>}
              </>
            )}
          </>
        )}
        {activeTab === "fills" && (
          <>
            <div className="table-head historical-fills">
              <span>{t("trading:contract")}</span><span>{t("trading:direction")}</span><span>{t("trading:fillPrice")}</span><span>{t("trading:fillQuantity")}</span><span>{t("trading:fillPnl")}</span><span>{t("trading:fee")}</span><span>{t("trading:operator")}</span><span>{t("trading:orderAndFill")}</span><span>{t("common:time")}</span>
            </div>
            {filteredHistoricalFills.map((fill) => (
              <div className="table-row historical-fills" key={fill.billId || `${fill.instId}-${fill.tradeId}-${fill.syncedAt}`}>
                <SymbolLabel symbol={fill.instId} marketAssets={marketAssets} secondary={fill.sourceEndpoint} onSelect={selectInstrument} selectLabel={symbolSelectLabel(fill.instId)} />
                <span className={clsx("cell-tone", toneBySide(fill.side, fill.posSide))}>
                  {formatOrderSide(fill.side ?? "", fill.posSide ?? "", t)}
                  <small>{formatFillSubType(fill.subType ?? "", t)}</small>
                </span>
                <span>{fmtPrice(fill.fillPx ?? undefined)}</span>
                <span>{formatAmount(fill.fillSz ?? undefined)}</span>
                <span className={clsx("cell-tone", toneByNumber(fill.fillPnl))}>{formatAmount(fill.fillPnl ?? undefined)}</span>
                <span>{formatAmount(fill.fee ?? undefined)}<small>{fill.feeCcy || "--"}</small></span>
                <span>{formatEpisodeOrigin(fill.operator || "unknown", t)}<small>{fill.strategyId || fill.sessionId || "--"}</small></span>
                <span>{fill.ordId || "--"}<small>{fill.tradeId || fill.billId}</small></span>
                <span>{formatDateTime(fill.okxTs ?? fill.syncedAt)}</span>
              </div>
            ))}
            {!account && <div className="empty-row">{t("trading:noAccountFillHistory")}</div>}
            {account && filteredHistoricalFills.length === 0 && <div className="empty-row">{t("trading:historySyncStatus", { type: t("trading:historicalFills"), status: formatPrivateDataStatus(historicalFillsStatus, t) })}</div>}
          </>
        )}
        {activeTab === "bills" && (
          <>
            <div className="account-bills-toolbar">
              <span>{formatArchiveStatusInline(accountBillsArchiveStatus, t)}</span>
              <button type="button" className="table-action" disabled={accountBillsArchiveBusy || !account} onClick={() => void onAccountBillsArchive(false)}>
                {accountBillsArchiveBusy ? t("trading:querying") : t("trading:queryPreviousQuarterArchive")}
              </button>
              <button type="button" className="table-action" disabled={accountBillsArchiveBusy || !account} onClick={() => void onAccountBillsArchive(true)}>
                {accountBillsArchiveBusy ? t("trading:requesting") : t("trading:requestPreviousQuarterArchive")}
              </button>
              <button
                type="button"
                className="table-action"
                disabled={accountBillsArchiveBusy || accountBillsArchiveImporting || !account || !accountBillsArchiveStatus?.fileHref}
                onClick={() => void onImportAccountBillsArchive()}
              >
                {accountBillsArchiveImporting ? t("trading:importing") : t("trading:importArchive")}
              </button>
            </div>
            <div className="table-head account-bills">
              <span>{t("trading:contract")}</span><span>{t("common:type")}</span><span>{t("trading:currency")}</span><span>{t("trading:balanceChange")}</span><span>{t("trading:balance")}</span><span>{t("trading:pnlAndFee")}</span><span>{t("trading:quantityAndPrice")}</span><span>{t("trading:orderAndFill")}</span><span>{t("common:time")}</span>
            </div>
            {filteredAccountBills.map((bill) => (
              <div className="table-row account-bills" key={bill.billId}>
                {bill.instId ? <SymbolLabel symbol={bill.instId} marketAssets={marketAssets} secondary={bill.sourceEndpoint} onSelect={selectInstrument} selectLabel={symbolSelectLabel(bill.instId)} /> : <span>--<small>{bill.sourceEndpoint}</small></span>}
                <span>{formatBillType(bill.billType ?? "", t)}<small>{formatBillSubType(bill.subType ?? "", t)}</small></span>
                <span>{bill.ccy || "--"}<small>{bill.mgnMode || "--"}</small></span>
                <span className={clsx("cell-tone", toneByNumber(bill.balChg))}>{formatAmount(bill.balChg ?? undefined)}<small>{t("trading:positionAbbreviation")} {formatAmount(bill.posBalChg ?? undefined)}</small></span>
                <span>{formatAmount(bill.bal ?? undefined)}<small>{t("trading:positionAbbreviation")} {formatAmount(bill.posBal ?? undefined)}</small></span>
                <span className={clsx("cell-tone", toneByNumber(bill.pnl))}>{formatAmount(bill.pnl ?? undefined)}<small>{t("trading:feeAbbreviation")} {formatAmount(bill.fee ?? undefined)}</small></span>
                <span>{formatAmount(bill.sz ?? undefined)}<small>@ {fmtPrice(bill.px ?? undefined)}</small></span>
                <span>{bill.ordId || bill.clOrdId || "--"}<small>{bill.tradeId || bill.billId}</small></span>
                <span>{formatDateTime(bill.okxTs ?? bill.syncedAt)}</span>
              </div>
            ))}
            {!account && <div className="empty-row">{t("trading:noAccountBills")}</div>}
            {account && filteredAccountBills.length === 0 && <div className="empty-row">{t("trading:historySyncStatus", { type: t("trading:bills"), status: formatPrivateDataStatus(accountBillsStatus, t) })}</div>}
          </>
        )}
        {activeTab === "audit" && (
          <>
            <div className="table-head trade-audit">
              <span>{t("common:time")}</span><span>{t("trading:events")}</span><span>{t("trading:contract")}</span><span>{t("trading:direction")}</span><span>{t("trading:quantityAndPrice")}</span><span>{t("trading:order")}</span><span>{t("common:status")}</span><span>{t("trading:operator")}</span><span>{t("trading:okxAndError")}</span>
            </div>
            {filteredTradeAuditEvents.map((event) => (
              <div className="table-row trade-audit" key={event.id} title={event.error || event.okxMessage || event.id}>
                <span>{formatDateTime(event.createdAt)}<small>{event.liveConfirmed ? t("trading:liveConfirmed") : t(event.environment === "live" ? "common:live" : "common:demo")}</small></span>
                <span>{formatTradeAuditOperation(event.operation, t)}<small>{formatTradeAuditEvent(event.eventType, t)}</small></span>
                <SymbolLabel symbol={event.instId} marketAssets={marketAssets} secondary={formatOrderType(event.orderType ?? "", t) || event.instType} onSelect={selectInstrument} selectLabel={symbolSelectLabel(event.instId)} />
                <span className={clsx("cell-tone", toneBySide(event.side, event.posSide))}>{formatOrderSide(event.side ?? "", event.posSide ?? "", t)}<small>{event.tdMode || "--"}</small></span>
                <span>{formatAmount(event.size ?? undefined)}<small>@ {fmtPrice(event.price ?? undefined)}</small></span>
                <span>{event.orderId || "--"}<small>{event.clientOrderId || "--"}</small></span>
                <span><b className={clsx("status-pill", toneByState(event.status))}>{formatTradeAuditStatus(event.status, t)}</b><small>{event.okxCode || "--"}</small></span>
                <span>{formatEpisodeOrigin(event.operator || "unknown", t)}<small>{event.strategyId || event.sessionId || "--"}</small></span>
                <span>{event.okxMessage || event.error || "--"}<small>{compactJson(event.responseJson || event.requestJson)}</small></span>
              </div>
            ))}
            {!account && <div className="empty-row">{t("trading:noAccountAudit")}</div>}
            {account && filteredTradeAuditEvents.length === 0 && <div className="empty-row">{t("trading:auditStatus", { status: formatPrivateDataStatus(tradeAuditStatus, t) })}</div>}
          </>
        )}
        {activeTab === "episodes" && (
          <>
            <div className="table-head episodes">
              <span>{t("trading:contract")}</span><span>{t("trading:direction")}</span><span>{t("common:status")}</span><span>{t("trading:openTime")}</span><span>{t("trading:closeTime")}</span><span>{t("trading:averagePrice")}</span><span>{t("common:quantity")}</span><span>{t("trading:netPnl")}</span><span>{t("common:source")}</span>
            </div>
            {filteredEpisodes.map((episode) => (
              <div className="episode-row" key={episode.id}>
                <div className="table-row episodes">
                  <SymbolLabel
                    symbol={episode.instId}
                    marketAssets={marketAssets}
                    secondary={episode.id}
                    onSelect={selectInstrument}
                    selectLabel={symbolSelectLabel(episode.instId)}
                  />
                  <span
                    className={clsx(
                      "cell-tone",
                      toneBySide(undefined, episode.episodeSide),
                    )}
                  >
                    {formatPositionSide(episode.episodeSide, t)}
                  </span>
                  <span><b className={clsx("status-pill", toneByState(episode.status))}>{formatEpisodeStatus(episode.status, t)}</b></span>
                  <span>{formatDateTime(episode.openTime)}</span>
                  <span>{formatDateTime(episode.closeTime)}</span>
                  <span>{fmtPrice(episode.avgOpenPx ?? undefined)}<small>{fmtPrice(episode.avgClosePx ?? undefined)}</small></span>
                  <span>{formatAmount(episode.closedQty)}<small>{t("trading:remaining")} {formatAmount(episode.remainingQty)}</small></span>
                  <span className={clsx("cell-tone", toneByNumber(episode.netPnl ?? episode.realizedPnl))}>{formatAmount(episode.netPnl ?? episode.realizedPnl ?? "--")}</span>
                  <span>
                    {formatEpisodeOrigin(episode.primaryOrigin, t)}
                    <small>{episode.events.length > 0 ? t("trading:eventCount", { count: episode.events.length }) : t("trading:okxSummaryRecord")}</small>
                    <button type="button" className="table-action episode-detail-action" onClick={() => setSelectedEpisode(episode)}>{t("common:details")}</button>
                  </span>
                </div>
                {(episode.events.length > 0 || episode.lastTradeId) && (
                  <div className="episode-events">
                    {episode.events.slice(-5).map((event) => {
                      const action = formatEpisodeEventType(event.eventType, t);
                      const quantity = formatAmount(event.qty);
                      const price = fmtPrice(event.price ?? undefined);
                      const time = formatDateTime(event.eventTime);
                      return (
                        <span
                          className={clsx("episode-event", event.eventType.toLowerCase())}
                          key={event.id}
                          title={`${action} ${quantity} @ ${price} · ${time}`}
                        >
                          <strong>{action}</strong>
                          <b>{quantity}</b>
                          <em>@ {price}</em>
                          <small>{time}</small>
                        </span>
                      );
                    })}
                    {episode.lastTradeId && <span className="episode-trade-id" title={episode.lastTradeId}>{t("trading:recentFillId", { id: episode.lastTradeId })}</span>}
                  </div>
                )}
              </div>
            ))}
            {!account && <div className="empty-row">{t("trading:noAccountPositionHistory")}</div>}
            {account && filteredEpisodes.length === 0 && <div className="empty-row">{t("trading:historySyncStatus", { type: t("trading:historicalPositions"), status: formatPrivateDataStatus(episodesStatus, t) })}</div>}
          </>
        )}
      </div>
      {positionDialog?.type === "close" && (
        <PositionCloseDialog
          account={account}
          position={positionDialog.position}
          instrument={assetMap.get(positionDialog.position.instId)}
          ticker={ticker}
          tradeEnvironment={tradeEnvironment}
          onClose={() => setPositionDialog(null)}
          onNotify={onNotify}
          onDone={() => {
            setPositionDialog(null);
            void onRefreshAccount();
          }}
        />
      )}
      {positionDialog?.type === "tpsl" && (
        <PositionTpSlDialog
          account={account}
          position={positionDialog.position}
          instrument={assetMap.get(positionDialog.position.instId)}
          ticker={ticker}
          tradeEnvironment={tradeEnvironment}
          onClose={() => setPositionDialog(null)}
          onNotify={onNotify}
          onDone={() => {
            setPositionDialog(null);
            onRefreshAlgoOrders();
            void onRefreshAccount();
          }}
        />
      )}
      {amendingAlgo && (
        <AlgoAmendDialog
          account={account}
          order={amendingAlgo}
          position={findChartOrderLinePosition(snapshot?.positions ?? [], amendingAlgo.instId, amendingAlgo.side, amendingAlgo.posSide)}
          instrument={assetMap.get(amendingAlgo.instId)}
          tradeEnvironment={tradeEnvironment}
          onClose={() => setAmendingAlgo(null)}
          onNotify={onNotify}
          onDone={() => {
            setAmendingAlgo(null);
            onRefreshAlgoOrders();
            void onRefreshAccount();
          }}
        />
      )}
      {marketClosePosition && account && (
        <ConfirmDialog
          title={t("trading:confirmMarketCloseAllTitle")}
          message={t("trading:marketClosePositionConfirmation", {
            symbol: marketClosePosition.instId,
            side: formatPositionSide(marketClosePosition.posSide, t),
            size: formatAmount(marketClosePosition.pos),
            environment: tradeEnvironment === "live" ? t("common:live") : t("common:demo"),
          })}
          confirmText={t("trading:confirmFlattenAll")}
          danger
          onCancel={() => setMarketClosePosition(null)}
          onConfirm={() => {
            const target = marketClosePosition;
            setMarketClosePosition(null);
            void closeOkxPosition({
              accountId: account.id,
              environment: tradeEnvironment,
              instId: target.instId,
              mgnMode: normalizeMarginMode(target.mgnMode),
              posSide: normalizeUiPosSide(target.posSide),
              confirmedLive: tradeEnvironment === "live"
            })
              .then((result) => {
                onNotify({ kind: "trade", title: t("trading:marketCloseSubmitted"), message: `${target.instId} ${result?.ordId || result?.clOrdId || ""}` });
                void onRefreshAccount();
              })
              .catch((error) => {
                logger.error("close position failed", error);
                onNotify({ kind: "error", title: t("trading:marketCloseFailed"), message: formatTradeErrorMessage(error) });
              });
          }}
        />
      )}
      {confirmCancelAlgo && account && (
        <ConfirmDialog
          title={t("trading:confirmCancelLiveStrategyOrderTitle")}
          message={t("trading:cancelLiveStrategyOrderConfirmation", {
            symbol: confirmCancelAlgo.instId,
            type: formatAlgoOrderType(confirmCancelAlgo.ordType, t),
            id: confirmCancelAlgo.algoId || confirmCancelAlgo.algoClOrdId,
          })}
          confirmText={t("trading:confirmCancellation")}
          danger
          onCancel={() => setConfirmCancelAlgo(null)}
          onConfirm={() => {
            const order = confirmCancelAlgo;
            setConfirmCancelAlgo(null);
            void cancelOkxAlgoOrder({
              accountId: account.id,
              environment: tradeEnvironment,
              instId: order.instId,
              algoId: order.algoId,
              algoClOrdId: order.algoClOrdId,
              confirmedLive: true
            })
              .then((result) => {
                onNotify({ kind: "trade", title: t("trading:strategyOrderCancellationAccepted"), message: `${order.instId} ${result?.ordId || result?.clOrdId || order.algoId}` });
                onRemoveAlgoOrder(order);
                onRefreshAlgoOrders();
                void onRefreshAccount();
              })
              .catch((error) => {
                logger.error("cancel algo order failed", error);
                onNotify({ kind: "error", title: t("trading:strategyOrderCancellationFailed"), message: formatTradeErrorMessage(error) });
              });
          }}
        />
      )}
      {selectedEpisode && <EpisodeDetailModal episode={selectedEpisode} onClose={() => setSelectedEpisode(null)} />}
    </div>
  );
}

function PositionCloseDialog({
  account,
  position,
  instrument,
  ticker,
  tradeEnvironment,
  onClose,
  onNotify,
  onDone
}: {
  account?: AccountSummary;
  position: OkxPosition;
  instrument?: OkxInstrumentSummary;
  ticker: Ticker | null;
  tradeEnvironment: "demo" | "live";
  onClose: () => void;
  onNotify: (notification: Omit<AppNotification, "id" | "createdAt">) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation(["trading", "common"]);
  const maxSize = Math.abs(Number(position.pos || 0));
  const [orderType, setOrderType] = useState<"limit" | "market">("limit");
  const [price, setPrice] = useState(ticker?.last || position.markPx || position.avgPx || "");
  const [size, setSize] = useState(normalizeTradeSizeInput(String(maxSize), instrument, { max: maxSize, enforceMin: false }));
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const latest = ticker?.last || position.markPx;
  const pnl = estimatePositionPnl(position, orderType === "market" ? latest : price, size, instrument);
  const submit = (confirmedLive = false) => {
    if (!account || submitting) return;
    const normalized = normalizeTradeSizeInput(size, instrument, { max: maxSize });
    setSize(normalized);
    setSubmitting(true);
    void placeOkxOrder({
      accountId: account.id,
      instId: position.instId,
      tdMode: normalizeMarginMode(position.mgnMode),
      orderType,
      ticketMode: "close",
      action: isShortPosition(position) ? "close-short" : "close-long",
      price: orderType === "market" ? latest || position.markPx || position.avgPx || "0" : price,
      size: normalized,
      lever: position.lever || "1",
      environment: tradeEnvironment,
      confirmedLive,
      operator: "user",
      executionKey: createTradeExecutionKey(account.id, tradeEnvironment, position.instId),
    })
      .then((result) => {
        onNotify({ kind: "trade", title: t("trading:closeOrderSubmitted"), message: t("trading:submittedOrderMessage", { symbol: position.instId, size: normalized, id: result?.ordId || result?.clOrdId || "" }) });
        onDone();
      })
      .catch((error) => {
        logger.error("close order failed", error);
        onNotify({ kind: "error", title: t("trading:closeOrderFailed"), message: formatTradeErrorMessage(error) });
      })
      .finally(() => setSubmitting(false));
  };
  return (
    <ModalShell title={t("trading:closePosition")} description={`${position.instId} · ${formatPositionSide(position.posSide, t)}`} className="trade-action-modal" onClose={onClose}>
      <PositionInfoGrid position={position} instrument={instrument} latest={latest} estimatedPnl={pnl} size={size} />
      <div className="ticket-form modal-trade-form">
        <label>{t("trading:orderType")}</label>
        <div className="segmented">
          <button type="button" className={orderType === "limit" ? "active" : ""} onClick={() => setOrderType("limit")}>{t("trading:limit")}</button>
          <button type="button" className={orderType === "market" ? "active" : ""} onClick={() => setOrderType("market")}>{t("trading:market")}</button>
        </div>
        <label>{t("trading:priceUsdt")}</label>
        <div className="inline-input-action">
          <input value={orderType === "market" ? t("trading:market") : price} readOnly={orderType === "market"} onChange={(event) => setPrice(event.target.value)} />
          <button type="button" onClick={() => latest && setPrice(latest)}>{t("trading:lastPrice")}</button>
        </div>
        <QuantitySlider value={size} max={maxSize} instrument={instrument} onChange={setSize} />
        <button
          type="button"
          className="modal-submit danger"
          disabled={!account || submitting || !Number(size)}
          onClick={() => (tradeEnvironment === "live" ? setConfirming(true) : submit(false))}
        >
          {submitting ? t("trading:submitting") : t("trading:submitClosePosition")}
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          title={t("trading:confirmLiveCloseTitle")}
          message={t("trading:liveCloseConfirmation", { symbol: position.instId, side: formatPositionSide(position.posSide, t), size, price: orderType === "market" ? t("trading:market") : price })}
          confirmText={t("trading:confirmSubmit")}
          danger
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            submit(true);
          }}
        />
      )}
    </ModalShell>
  );
}

function PositionTpSlDialog({
  account,
  position,
  instrument,
  ticker,
  tradeEnvironment,
  onClose,
  onNotify,
  onDone
}: {
  account?: AccountSummary;
  position: OkxPosition;
  instrument?: OkxInstrumentSummary;
  ticker: Ticker | null;
  tradeEnvironment: "demo" | "live";
  onClose: () => void;
  onNotify: (notification: Omit<AppNotification, "id" | "createdAt">) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation(["trading", "common"]);
  const maxSize = Math.abs(Number(position.pos || 0));
  const latest = ticker?.last || position.markPx;
  const [size, setSize] = useState(normalizeTradeSizeInput(String(maxSize), instrument, { max: maxSize, enforceMin: false }));
  const [tpTrigger, setTpTrigger] = useState(defaultTpTrigger(position, latest));
  const [tpOrd, setTpOrd] = useState("-1");
  const [slTrigger, setSlTrigger] = useState("");
  const [slOrd, setSlOrd] = useState("-1");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submitSize = normalizeTradeSizeInput(size, instrument, { max: maxSize });
  const isShort = isShortPosition(position);
  const side = isShort ? "buy" : "sell";
  const hasTp = tpTrigger.trim() !== "" && tpOrd.trim() !== "";
  const hasSl = slTrigger.trim() !== "" && slOrd.trim() !== "";
  const algoType = hasTp && hasSl ? "oco" : "conditional";
  const tpPnl = hasTp ? estimatePositionPnl(position, tpTrigger, submitSize, instrument) : undefined;
  const slPnl = hasSl ? estimatePositionPnl(position, slTrigger, submitSize, instrument) : undefined;
  const applyPercent = (percent: number, target: "tp" | "sl") => {
    const base = Number(latest || position.markPx || position.avgPx || 0);
    if (!base) return;
    const sign = target === "tp" ? (isShort ? -1 : 1) : isShort ? 1 : -1;
    const next = base * (1 + sign * (percent / 100));
    if (target === "tp") setTpTrigger(trimFloat(next));
    else setSlTrigger(trimFloat(next));
  };
  const submit = (confirmedLive = false) => {
    if (!account || submitting) return;
    setSubmitting(true);
    void placeOkxAlgoOrder({
      accountId: account.id,
      environment: tradeEnvironment,
      instId: position.instId,
      tdMode: normalizeMarginMode(position.mgnMode),
      posSide: normalizeUiPosSide(position.posSide),
      side,
      ordType: algoType,
      size: submitSize,
      tpTriggerPx: hasTp ? tpTrigger : undefined,
      tpOrdPx: hasTp ? tpOrd : undefined,
      slTriggerPx: hasSl ? slTrigger : undefined,
      slOrdPx: hasSl ? slOrd : undefined,
      confirmedLive,
      operator: "user",
      executionKey: createTradeExecutionKey(account.id, tradeEnvironment, position.instId)
    })
      .then((result) => {
        onNotify({ kind: "trade", title: t("trading:strategyOrderSubmitted"), message: t("trading:strategyOrderSubmittedMessage", { symbol: position.instId, type: formatAlgoOrderType(algoType, t), size: submitSize, id: result?.ordId || result?.clOrdId || "" }) });
        onDone();
      })
      .catch((error) => {
        logger.error("place algo order failed", error);
        onNotify({ kind: "error", title: t("trading:strategyOrderFailed"), message: formatTradeErrorMessage(error) });
      })
      .finally(() => setSubmitting(false));
  };
  return (
    <ModalShell title={t("trading:takeProfitStopLoss")} description={`${position.instId} · ${formatPositionSide(position.posSide, t)}`} className="trade-action-modal" onClose={onClose}>
      <PositionInfoGrid position={position} instrument={instrument} latest={latest} size={submitSize} />
      <div className="ticket-form modal-trade-form">
        <AlgoPriceBlock kind="takeProfit" trigger={tpTrigger} orderPx={tpOrd} estimatedPnl={tpPnl} onTrigger={setTpTrigger} onOrderPx={setTpOrd} onPercent={(percent) => applyPercent(percent, "tp")} />
        <AlgoPriceBlock kind="stopLoss" trigger={slTrigger} orderPx={slOrd} estimatedPnl={slPnl} onTrigger={setSlTrigger} onOrderPx={setSlOrd} onPercent={(percent) => applyPercent(percent, "sl")} />
        <QuantitySlider value={size} max={maxSize} instrument={instrument} onChange={setSize} />
        <button
          type="button"
          className="modal-submit"
          disabled={!account || submitting || !Number(submitSize) || (!hasTp && !hasSl)}
          onClick={() => (tradeEnvironment === "live" ? setConfirming(true) : submit(false))}
        >
          {submitting ? t("trading:submitting") : t("trading:submitStrategyOrder")}
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          title={t("trading:confirmLiveStrategyOrderTitle")}
          message={t("trading:liveStrategyOrderConfirmation", { symbol: position.instId, type: formatAlgoOrderType(algoType, t), size: submitSize })}
          confirmText={t("trading:confirmSubmit")}
          danger
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            submit(true);
          }}
        />
      )}
    </ModalShell>
  );
}

function ChartRiskRewardTradeDialog({
  account,
  intent,
  snapshot,
  instrument,
  tradeEnvironment,
  onClose,
  onSubmit
}: {
  account?: AccountSummary;
  intent: ChartRiskRewardTradeIntent;
  snapshot: PrivateAccountSnapshot | null;
  instrument?: OkxInstrumentSummary;
  tradeEnvironment: "demo" | "live";
  onClose: () => void;
  onSubmit: (intent: ChartRiskRewardTradeIntent, size: string, marginMode: "cross" | "isolated", lever: string, confirmedLive: boolean) => void;
}) {
  const { t } = useTranslation(["trading", "common"]);
  const [marginMode, setMarginMode] = useState<"cross" | "isolated">("cross");
  const [lever, setLever] = useState("20");
  const [size, setSize] = useState(() => normalizeTradeSizeInput(instrument?.minSz ?? "", instrument));
  const [confirming, setConfirming] = useState(false);
  const availableUsdt = Number(snapshot?.balances.find((item) => item.ccy === "USDT")?.availEq || snapshot?.balances.find((item) => item.ccy === "USDT")?.availBal || 0);
  const contractValue = Number(instrument?.ctVal);
  const rawMaxSize = availableUsdt > 0 && intent.entryPrice > 0 && Number(lever) > 0 && contractValue > 0
    ? (availableUsdt * Number(lever)) / (intent.entryPrice * contractValue)
    : 0;
  const maxSize = Number(normalizeTradeSizeInput(String(rawMaxSize), instrument, { enforceMin: false })) || 0;
  const normalizedSize = normalizeTradeSizeInput(size, instrument, { max: maxSize || undefined });
  const isLong = intent.side === "long";
  const isBracket = intent.action === "bracket";
  const reward = Math.abs(intent.takeProfitPrice - intent.entryPrice);
  const risk = Math.abs(intent.entryPrice - intent.stopLossPrice);
  const ratio = risk > 0 ? reward / risk : 0;
  const submit = (confirmedLive = false) => onSubmit(intent, normalizedSize, marginMode, lever, confirmedLive);
  return (
    <ModalShell
      title={isBracket ? t("trading:chartOpenWithProtection") : t("trading:chartLimitOpen")}
      description={t("trading:chartTradeDescription", { symbol: intent.instId, side: isLong ? t("trading:long") : t("trading:short"), price: fmtPrice(intent.entryPrice) })}
      className="trade-action-modal chart-risk-reward-dialog"
      onClose={onClose}
    >
      <div className="position-line-summary chart-risk-reward-summary">
        <span>{t("trading:entryPrice")} <b>{fmtPrice(intent.entryPrice)}</b></span>
        <span>{t("trading:targetPrice")} <b className="estimate-positive">{fmtPrice(intent.takeProfitPrice)}</b></span>
        <span>{t("trading:stopLoss")} <b className="estimate-negative">{fmtPrice(intent.stopLossPrice)}</b></span>
        <span>{t("trading:riskRewardRatio")} <b>{ratio.toFixed(2)}</b></span>
      </div>
      <div className="ticket-form modal-trade-form">
        <label>{t("trading:marginMode")}</label>
        <div className="segmented-row">
          <button type="button" className={clsx(marginMode === "cross" && "active")} onClick={() => setMarginMode("cross")}>{t("trading:cross")}</button>
          <button type="button" className={clsx(marginMode === "isolated" && "active")} onClick={() => setMarginMode("isolated")}>{t("trading:isolated")}</button>
        </div>
        <label>{t("trading:leverage")}</label>
        <input inputMode="decimal" value={lever} onChange={(event) => setLever(event.target.value.replace(/[^0-9.]/g, ""))} />
        <QuantitySlider value={size} max={maxSize} instrument={instrument} onChange={setSize} />
        <div className="order-estimates">
          <span>{t("trading:availableBalance")} <b>{Number.isFinite(availableUsdt) ? formatUsdt(availableUsdt) : "--"}</b></span>
          <span>{t("trading:maxOpen")} <b>{maxSize > 0 ? trimTradeSize(maxSize) : "--"} {t("trading:contracts")}</b></span>
          {isBracket && <span>{t("trading:attachedProtection")} <b>TP / SL</b></span>}
        </div>
        <button
          type="button"
          className={clsx("modal-submit", tradeEnvironment === "live" && "danger")}
          disabled={!account || !normalizedSize || Number(normalizedSize) <= 0 || !Number(lever)}
          onClick={() => (tradeEnvironment === "live" ? setConfirming(true) : submit(false))}
        >
          {tradeEnvironment === "live" ? t("trading:confirmLiveSubmit") : isBracket ? t("trading:submitOpenWithProtection") : t("trading:submitLimitOpen")}
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          title={t("trading:confirmLiveChartTradeTitle")}
          message={isBracket
            ? t("trading:liveChartBracketConfirmation", { symbol: intent.instId, side: isLong ? t("trading:long") : t("trading:short"), size: normalizedSize, entry: fmtPrice(intent.entryPrice), takeProfit: fmtPrice(intent.takeProfitPrice), stopLoss: fmtPrice(intent.stopLossPrice) })
            : t("trading:liveChartTradeConfirmation", { symbol: intent.instId, side: isLong ? t("trading:long") : t("trading:short"), size: normalizedSize, entry: fmtPrice(intent.entryPrice) })}
          confirmText={t("trading:confirmSubmit")}
          danger
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            submit(true);
          }}
        />
      )}
    </ModalShell>
  );
}

function ChartOrderLineEditDialog({
  edit,
  environment,
  position,
  instrument,
  onClose,
  onSubmit
}: {
  edit: ChartOrderLineEdit;
  environment: "demo" | "live";
  position?: OkxPosition;
  instrument?: OkxInstrumentSummary;
  onClose: () => void;
  onSubmit: (edit: ChartOrderLineEdit, confirmedLive: boolean) => void;
}) {
  const { t } = useTranslation(["trading", "common"]);
  const isTriggerOrder = edit.line.editKind === "algo-trigger";
  const [price, setPrice] = useState(String(edit.price));
  const [triggerPrice, setTriggerPrice] = useState(String(edit.triggerPrice ?? edit.line.triggerPrice ?? edit.price));
  const initialOrderPrice = edit.orderPrice ?? edit.line.orderPrice;
  const [orderPrice, setOrderPrice] = useState(initialOrderPrice === null ? "-1" : initialOrderPrice ? String(initialOrderPrice) : "");
  const [confirming, setConfirming] = useState(false);
  const executionAtMarket = orderPrice === "-1";
  const validTrigger = Number(triggerPrice) > 0;
  const validOrder = executionAtMarket || Number(orderPrice) > 0;
  const submitEdit: ChartOrderLineEdit = isTriggerOrder
    ? { ...edit, price: Number(triggerPrice), triggerPrice: Number(triggerPrice), orderPrice: executionAtMarket ? null : Number(orderPrice) }
    : { ...edit, price: Number(price) };
  const canSubmit = isTriggerOrder ? validTrigger && validOrder : Number(price) > 0;
  const previewPrice = Number(isTriggerOrder ? triggerPrice : price);
  const previewEstimate = position && Number.isFinite(previewPrice) && previewPrice > 0
    ? estimateOrderLinePnl(position, previewPrice, edit.line.size, instrument)
    : { pnl: undefined, ratio: undefined };
  const hasPreviewEstimate = Number.isFinite(previewEstimate.pnl) && Number.isFinite(previewEstimate.ratio);
  const submit = (confirmedLive = false) => onSubmit(submitEdit, confirmedLive);
  const title = isTriggerOrder ? t("trading:modifyTriggerOrder") : t("trading:modifyOrderPrice");
  return (
    <ModalShell
      title={title}
      description={`${edit.line.label} · ${environment === "live" ? t("trading:liveAccount") : t("trading:demoAccount")}`}
      className="trade-action-modal chart-order-edit-modal"
      onClose={onClose}
    >
      <div className="position-line-summary chart-order-edit-summary">
        <span>{t("trading:originalPrice")} <b>{fmtPrice(edit.line.price)}</b></span>
        <span>{t("trading:modifiedPrice")} <b className="highlight-value">{previewPrice > 0 ? fmtPrice(previewPrice) : "--"}</b></span>
        <span>{t("trading:estimatedPnl")} <b className={clsx(hasPreviewEstimate ? Number(previewEstimate.pnl) >= 0 ? "estimate-positive" : "estimate-negative" : "cell-tone muted")}>{hasPreviewEstimate ? `${Number(previewEstimate.pnl) >= 0 ? "+" : ""}${formatAmount(trimFloat(Number(previewEstimate.pnl)))} USDT` : "--"}</b></span>
        <span>{t("trading:returnRate")} <b className={clsx(hasPreviewEstimate ? Number(previewEstimate.ratio) >= 0 ? "estimate-positive" : "estimate-negative" : "cell-tone muted")}>{hasPreviewEstimate ? `${Number(previewEstimate.ratio) >= 0 ? "+" : ""}${Number(previewEstimate.ratio).toFixed(2)}%` : "--"}</b></span>
      </div>
      <div className="ticket-form modal-trade-form">
        {isTriggerOrder ? (
          <>
            <label>{t("trading:triggerPrice")}</label>
            <input value={triggerPrice} inputMode="decimal" onChange={(event) => setTriggerPrice(event.target.value)} autoFocus />
            <label>{t("trading:orderPriceAfterTrigger")}</label>
            <div className="segmented-row" role="group" aria-label={t("trading:triggerOrderExecutionMode")}>
              <button type="button" className={clsx(executionAtMarket && "active")} onClick={() => setOrderPrice("-1")}>{t("trading:market")}</button>
              <button type="button" className={clsx(!executionAtMarket && "active")} onClick={() => setOrderPrice((current) => current === "-1" ? triggerPrice : current)}>{t("trading:limit")}</button>
            </div>
            {!executionAtMarket && <input value={orderPrice} inputMode="decimal" placeholder={t("trading:enterOrderPrice")} onChange={(event) => setOrderPrice(event.target.value)} />}
          </>
        ) : (
          <>
            <label>{t("trading:targetPrice")}</label>
            <input value={price} inputMode="decimal" onChange={(event) => setPrice(event.target.value)} autoFocus />
          </>
        )}
        <button
          type="button"
          className={clsx("modal-submit", environment === "live" && "danger")}
          disabled={!canSubmit}
          onClick={() => (environment === "live" ? setConfirming(true) : submit(false))}
        >
          {environment === "live" ? t("trading:confirmLiveModification") : t("trading:confirmModification")}
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          title={t("trading:confirmModifyLiveOrderTitle")}
          message={isTriggerOrder
            ? t("trading:triggerOrderModificationConfirmation", { label: edit.line.label, triggerPrice, execution: executionAtMarket ? t("trading:executeAtMarket") : t("trading:executeAtLimit", { price: orderPrice }) })
            : t("trading:orderPriceModificationConfirmation", { label: edit.line.label, originalPrice: fmtPrice(edit.line.price), price })}
          confirmText={t("trading:confirmAmendOrder")}
          danger
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            submit(true);
          }}
        />
      )}
    </ModalShell>
  );
}

function PositionLineTradeDialog({
  account,
  intent,
  position,
  instrument,
  tradeEnvironment,
  onClose,
  onSubmit
}: {
  account?: AccountSummary;
  intent: PositionLineTradeIntent;
  position?: OkxPosition;
  instrument?: OkxInstrumentSummary;
  tradeEnvironment: "demo" | "live";
  onClose: () => void;
  onSubmit: (intent: PositionLineTradeIntent, size: string, orderPx: string, confirmedLive: boolean) => void;
}) {
  const { t } = useTranslation(["trading", "common"]);
  const maxSize = Math.abs(Number(position?.pos || intent.size || 0));
  const [size, setSize] = useState(normalizeTradeSizeInput(String(maxSize), instrument, { max: maxSize, enforceMin: false }));
  const supportsQuickClose = intent.kind === "limit_close" || intent.kind === "market_close";
  const [closeMode, setCloseMode] = useState<"limit" | "market">(intent.kind === "market_close" ? "market" : "limit");
  const [orderPxMode, setOrderPxMode] = useState<"market" | "limit">("market");
  const [orderPx, setOrderPx] = useState(normalizeTradePriceInput(intent.targetPrice, instrument));
  const [confirming, setConfirming] = useState(false);
  const submitSize = normalizeTradeSizeInput(size, instrument, { max: maxSize, enforceMin: false });
  const executionIntent: PositionLineTradeIntent = supportsQuickClose
    ? { ...intent, kind: closeMode === "market" ? "market_close" : "limit_close" }
    : intent;
  const isLimitClose = executionIntent.kind === "limit_close";
  const submitOrderPx = executionIntent.kind === "market_close" ? "-1" : isLimitClose ? normalizeTradePriceInput(intent.targetPrice, instrument) : orderPxMode === "market" ? "-1" : normalizeTradePriceInput(orderPx, instrument);
  const estimatedPnl = position ? estimatePositionPnl(position, String(intent.targetPrice), submitSize, instrument) : intent.estimatedPnl;
  const hasEstimatedPnl = Number.isFinite(Number(estimatedPnl));
  const pnlRatio = Number(intent.estimatedPnlRatio);
  const submit = (confirmedLive = false) => onSubmit(executionIntent, submitSize, submitOrderPx || "-1", confirmedLive);
  const title = formatPositionLineIntentKind(executionIntent.kind, t);
  const existingText = isLimitClose
    ? t("trading:submitLimitCloseAtCurrentPrice")
    : executionIntent.kind === "market_close"
      ? t("trading:submitMarketCloseAll")
      : intent.existingAlgoId || intent.existingAlgoClientOrderId
        ? t("trading:modifyExistingStrategyOrder")
        : t("trading:createStrategyOrder");
  return (
    <ModalShell title={t("trading:dragPositionLineTitle", { action: title })} description={`${intent.instId} · ${formatPositionSide(intent.posSide, t)} · ${existingText}`} className="trade-action-modal position-line-trade-modal" onClose={onClose}>
      <div className="position-line-summary">
        <span>{t("trading:averageEntryPrice")} <b>{fmtPrice(intent.entryPrice)}</b></span>
        <span>{t("trading:currentPrice")} <b className="highlight-value">{fmtPrice(intent.currentPrice)}</b></span>
        <span>{t("trading:targetPrice")} <b className={clsx("cell-tone", toneByNumber(String(estimatedPnl ?? "")))}>{fmtPrice(intent.targetPrice)}</b></span>
        <span>{t("trading:estimatedPnl")} <b className={clsx(hasEstimatedPnl ? Number(estimatedPnl) >= 0 ? "estimate-positive" : "estimate-negative" : "cell-tone muted")}>{hasEstimatedPnl ? `${formatAmount(trimFloat(Number(estimatedPnl)))} USDT` : "--"}</b></span>
        <span>{t("trading:returnRate")} <b className={clsx(Number(pnlRatio) >= 0 ? "estimate-positive" : "estimate-negative")}>{Number.isFinite(pnlRatio) ? `${pnlRatio >= 0 ? "+" : ""}${pnlRatio.toFixed(2)}%` : "--"}</b></span>
        <span>{t("trading:direction")} <b>{formatOrderSide(intent.side, intent.posSide, t)}</b></span>
      </div>
      <div className="ticket-form modal-trade-form">
        <QuantitySlider value={size} max={maxSize} instrument={instrument} onChange={setSize} />
        {supportsQuickClose && (
          <>
            <label>{t("trading:positionCloseMode")}</label>
            <div className="segmented-row" role="group" aria-label={t("trading:positionCloseMode")}>
              <button type="button" className={clsx(closeMode === "limit" && "active")} onClick={() => setCloseMode("limit")}>{t("trading:limitAtCurrentPrice")}</button>
              <button type="button" className={clsx(closeMode === "market" && "active")} onClick={() => setCloseMode("market")}>{t("trading:market")}</button>
            </div>
          </>
        )}
        {isLimitClose && (
          <>
            <label>{t("trading:limitClosePriceAtCurrent")}</label>
            <input value={fmtPrice(intent.targetPrice)} readOnly />
          </>
        )}
        {executionIntent.kind !== "market_close" && !isLimitClose && (
          <>
            <label>{t("trading:strategyOrderPrice")}</label>
            <div className="segmented-row">
              <button type="button" className={clsx(orderPxMode === "market" && "active")} onClick={() => setOrderPxMode("market")}>{t("trading:market")}</button>
              <button type="button" className={clsx(orderPxMode === "limit" && "active")} onClick={() => setOrderPxMode("limit")}>{t("trading:limit")}</button>
            </div>
            {orderPxMode === "limit" && <input value={orderPx} onChange={(event) => setOrderPx(event.target.value)} />}
          </>
        )}
        <button
          type="button"
          className={clsx("modal-submit", tradeEnvironment === "live" && "danger")}
          disabled={!account || !Number(submitSize) || (executionIntent.kind !== "market_close" && !submitOrderPx)}
          onClick={() => (tradeEnvironment === "live" ? setConfirming(true) : submit(false))}
        >
          {tradeEnvironment === "live" ? t("trading:confirmLiveOperation") : existingText}
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          title={t("trading:confirmLiveActionTitle", { action: title })}
          message={t("trading:livePositionLineConfirmation", { symbol: intent.instId, side: formatPositionSide(intent.posSide, t), size: submitSize, price: fmtPrice(intent.targetPrice) })}
          confirmText={t("trading:confirmSubmit")}
          danger
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            submit(true);
          }}
        />
      )}
    </ModalShell>
  );
}

function AlgoAmendDialog({
  account,
  order,
  position,
  instrument,
  tradeEnvironment,
  onClose,
  onNotify,
  onDone
}: {
  account?: AccountSummary;
  order: OkxAlgoOrder;
  position?: OkxPosition;
  instrument?: OkxInstrumentSummary;
  tradeEnvironment: "demo" | "live";
  onClose: () => void;
  onNotify: (notification: Omit<AppNotification, "id" | "createdAt">) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation(["trading", "common"]);
  const isTriggerOrder = order.ordType === "trigger";
  const [size, setSize] = useState(order.sz || "");
  const [triggerPrice, setTriggerPrice] = useState(order.triggerPx || "");
  const [triggerOrderMode, setTriggerOrderMode] = useState<"market" | "limit">(order.ordPx === "-1" || !order.ordPx ? "market" : "limit");
  const [triggerOrderPrice, setTriggerOrderPrice] = useState(order.ordPx === "-1" ? "" : order.ordPx || "");
  const [tpTrigger, setTpTrigger] = useState(order.tpTriggerPx || "");
  const [tpOrd, setTpOrd] = useState(order.tpOrdPx || "");
  const [slTrigger, setSlTrigger] = useState(order.slTriggerPx || "");
  const [slOrd, setSlOrd] = useState(order.slOrdPx || "");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const tpPnl = position && Number(tpTrigger) > 0 ? estimateOrderLinePnl(position, Number(tpTrigger), size, instrument).pnl : undefined;
  const slPnl = position && Number(slTrigger) > 0 ? estimateOrderLinePnl(position, Number(slTrigger), size, instrument).pnl : undefined;
  const submit = (confirmedLive = false) => {
    if (!account || submitting) return;
    setSubmitting(true);
    void amendOkxAlgoOrder({
      accountId: account.id,
      environment: tradeEnvironment,
      instId: order.instId,
      algoId: order.algoId,
      algoClOrdId: order.algoClOrdId,
      newSize: size,
      newTriggerPx: isTriggerOrder ? triggerPrice : undefined,
      newOrdPx: isTriggerOrder ? (triggerOrderMode === "market" ? "-1" : triggerOrderPrice) : undefined,
      newTpTriggerPx: isTriggerOrder ? undefined : tpTrigger,
      newTpOrdPx: isTriggerOrder ? undefined : tpOrd,
      newSlTriggerPx: isTriggerOrder ? undefined : slTrigger,
      newSlOrdPx: isTriggerOrder ? undefined : slOrd,
      confirmedLive,
      executionKey: createTradeExecutionKey(account.id, tradeEnvironment, order.instId)
    })
      .then((result) => {
        onNotify({ kind: "trade", title: t("trading:strategyOrderModificationSubmitted"), message: `${order.instId} ${result?.algoId || result?.algoClOrdId || order.algoId}` });
        onDone();
      })
      .catch((error) => {
        logger.error("amend algo order failed", error);
        onNotify({ kind: "error", title: t("trading:strategyOrderModificationFailed"), message: formatTradeErrorMessage(error) });
      })
      .finally(() => setSubmitting(false));
  };
  return (
    <ModalShell title={t("trading:modifyStrategyOrder")} description={`${order.instId} · ${formatAlgoOrderType(order.ordType, t)}`} className="trade-action-modal" onClose={onClose}>
      <div className="ticket-form modal-trade-form">
        <label>{t("trading:quantityContracts")}</label>
        <input value={size} onChange={(event) => setSize(event.target.value)} />
        {isTriggerOrder ? (
          <>
            <label>{t("trading:triggerPrice")}</label>
            <input value={triggerPrice} onChange={(event) => setTriggerPrice(event.target.value)} />
            <label>{t("trading:triggerOrderExecutionMode")}</label>
            <div className="segmented-row" role="group" aria-label={t("trading:triggerOrderExecutionMode")}>
              <button type="button" className={clsx(triggerOrderMode === "market" && "active")} onClick={() => setTriggerOrderMode("market")}>{t("trading:market")}</button>
              <button type="button" className={clsx(triggerOrderMode === "limit" && "active")} onClick={() => setTriggerOrderMode("limit")}>{t("trading:limit")}</button>
            </div>
            {triggerOrderMode === "limit" && (
              <>
                <label>{t("trading:orderPriceAfterTrigger")}</label>
                <input value={triggerOrderPrice} onChange={(event) => setTriggerOrderPrice(event.target.value)} />
              </>
            )}
          </>
        ) : (
          <>
            <AlgoPriceBlock kind="takeProfit" trigger={tpTrigger} orderPx={tpOrd} estimatedPnl={tpPnl} onTrigger={setTpTrigger} onOrderPx={setTpOrd} />
            <AlgoPriceBlock kind="stopLoss" trigger={slTrigger} orderPx={slOrd} estimatedPnl={slPnl} onTrigger={setSlTrigger} onOrderPx={setSlOrd} />
          </>
        )}
        <button type="button" className="modal-submit" disabled={!account || submitting || !Number(size) || (isTriggerOrder && (!Number(triggerPrice) || (triggerOrderMode === "limit" && !Number(triggerOrderPrice))))} onClick={() => (tradeEnvironment === "live" ? setConfirming(true) : submit(false))}>
          {submitting ? t("trading:submitting") : t("trading:submitChanges")}
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          title={t("trading:confirmModifyLiveStrategyOrderTitle")}
          message={`${order.instId} ${order.algoId || order.algoClOrdId}`}
          confirmText={t("trading:confirmModification")}
          danger
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            submit(true);
          }}
        />
      )}
    </ModalShell>
  );
}

function PositionInfoGrid({ position, instrument, latest, estimatedPnl, size }: { position: OkxPosition; instrument?: OkxInstrumentSummary; latest?: string; estimatedPnl?: number; size: string }) {
  const { t } = useTranslation("trading");
  const coinAmount = positionCoinAmount({ ...position, pos: size }, instrument);
  const hasEstimatedPnl = Number.isFinite(Number(estimatedPnl));
  return (
    <div className="position-info-grid">
      <span>{t("lastPrice")} <b className="highlight-value">{fmtPrice(latest)}</b></span>
      <span>{t("averageEntryPrice")} <b>{fmtPrice(position.avgPx)}</b></span>
      <span>{t("estimatedLiquidationPrice")} <b className="estimate-negative">{fmtPrice(position.liqPx)}</b></span>
      <span>{t("positionContracts")} <b className="highlight-value">{formatAmount(position.pos)}</b></span>
      <span>{t("positionSize")} <b>{coinAmount === undefined ? "--" : formatAmount(String(coinAmount))} {positionBaseCurrency(position, instrument)}</b></span>
      {hasEstimatedPnl && <span>{t("estimatedPnl")} <b className={clsx(Number(estimatedPnl) >= 0 ? "estimate-positive" : "estimate-negative")}>{formatAmount(trimFloat(Number(estimatedPnl)))}</b></span>}
    </div>
  );
}

function QuantitySlider({ value, max, instrument, onChange }: { value: string; max: number; instrument?: OkxInstrumentSummary; onChange: (value: string) => void }) {
  const { t } = useTranslation("trading");
  const percent = max > 0 ? Math.min(100, Math.max(0, (Number(value || 0) / max) * 100)) : 0;
  const setByPercent = (nextPercent: number) => onChange(normalizeTradeSizeInput(String((max * nextPercent) / 100), instrument, { max, enforceMin: false }));
  return (
    <>
      <label>{t("quantityContracts")}</label>
      <input value={value} onChange={(event) => onChange(event.target.value)} onBlur={() => onChange(normalizeTradeSizeInput(value, instrument, { max }))} />
      <input className="quantity-range" type="range" min="0" max="100" step="1" value={percent} onChange={(event) => setByPercent(Number(event.target.value))} />
      <div className="percent-row">
        {[25, 50, 75, 100].map((item) => <button type="button" key={item} onClick={() => setByPercent(item)}>{item}%</button>)}
      </div>
    </>
  );
}

function AlgoPriceBlock({
  kind,
  trigger,
  orderPx,
  estimatedPnl,
  onTrigger,
  onOrderPx,
  onPercent
}: {
  kind: "takeProfit" | "stopLoss";
  trigger: string;
  orderPx: string;
  estimatedPnl?: number;
  onTrigger: (value: string) => void;
  onOrderPx: (value: string) => void;
  onPercent?: (percent: number) => void;
}) {
  const { t } = useTranslation("trading");
  const title = kind === "takeProfit" ? t("takeProfit") : t("stopLoss");
  return (
    <div className="algo-price-block">
      <label>{t("algoTriggerPriceLabel", { type: title })}</label>
      <input value={trigger} onChange={(event) => onTrigger(event.target.value)} />
      {onPercent && <div className="percent-row">{[0, 5, 10].map((item) => <button type="button" key={item} onClick={() => onPercent(item)}>{item}%</button>)}</div>}
      <label>{t("algoOrderPriceLabel", { type: title })}</label>
      <div className="inline-input-action">
        <input value={orderPx === "-1" ? t("market") : orderPx} readOnly={orderPx === "-1"} onChange={(event) => onOrderPx(event.target.value)} />
        <button type="button" onClick={() => onOrderPx("-1")}>{t("market")}</button>
        {orderPx === "-1" && <button type="button" onClick={() => onOrderPx(trigger)}>{t("limit")}</button>}
      </div>
      <div className="algo-pnl-preview">
        <span>{t("algoEstimatedPnlLabel", { type: title })}</span>
        <b className={clsx(!Number.isFinite(estimatedPnl) ? "cell-tone muted" : Number(estimatedPnl) >= 0 ? "estimate-positive" : "estimate-negative")}>
          {!Number.isFinite(estimatedPnl) ? "--" : `${Number(estimatedPnl) >= 0 ? "+" : ""}${formatAmount(trimFloat(Number(estimatedPnl)))} USDT`}
        </b>
      </div>
    </div>
  );
}

function EpisodeDetailModal({ episode, onClose }: { episode: PositionEpisode; onClose: () => void }) {
  const { t } = useTranslation(["trading", "common"]);
  const eventStats = summarizeEpisodeEvents(episode, t);
  const netPnl = episode.netPnl ?? episode.realizedPnl;
  const sideTone = toneBySide(undefined, episode.episodeSide);
  const netTone = toneByNumber(netPnl);
  return (
    <ModalShell
      title={t("trading:positionReviewTitle", { symbol: episode.instId })}
      description={`${formatPositionSide(episode.episodeSide, t)} · ${formatEpisodeStatus(episode.status, t)} · ${formatEpisodeOrigin(episode.primaryOrigin, t)}`}
      className="episode-detail-modal"
      onClose={onClose}
    >
      <div className="episode-detail-body">
        <section className="episode-outcome" aria-label={t("trading:positionOutcomeSummary")}>
          <div className={clsx("episode-result-primary", netTone)}>
            <span>{t("trading:netPnl")}</span>
            <strong className={clsx("cell-tone", netTone)}>{formatAmount(netPnl ?? "--")}</strong>
            <div className="episode-context-line">
              <span className={clsx("cell-tone", sideTone)}><i />{formatPositionSide(episode.episodeSide, t)}</span>
              <span><i />{formatEpisodeStatus(episode.status, t)}</span>
              <span><i />{formatEpisodeOrigin(episode.primaryOrigin, t)}</span>
            </div>
          </div>

          <div className="episode-price-path">
            <div>
              <span>{t("trading:averageOpenPrice")}</span>
              <strong>{fmtPrice(episode.avgOpenPx ?? undefined)}</strong>
              <small>{formatDateTime(episode.openTime)}</small>
            </div>
            <div className="episode-price-path-connector" aria-label={t("trading:holdingDuration", { duration: formatEpisodeDuration(episode.openTime, episode.closeTime ?? undefined, t) })}>
              <span>{formatEpisodeDuration(episode.openTime, episode.closeTime ?? undefined, t)}</span>
              <i />
            </div>
            <div>
              <span>{t("trading:averageClosePrice")}</span>
              <strong>{fmtPrice(episode.avgClosePx ?? undefined)}</strong>
              <small>{formatDateTime(episode.closeTime)}</small>
            </div>
          </div>

          <div className="episode-key-metrics">
            <div><span>{t("trading:maximumQuantity")}</span><strong>{formatAmount(episode.maxQty)}</strong></div>
            <div><span>{t("trading:remainingQuantity")}</span><strong>{formatAmount(episode.remainingQty)}</strong></div>
            <div><span>{t("trading:realizedPnl")}</span><strong className={clsx("cell-tone", toneByNumber(episode.realizedPnl))}>{formatAmount(episode.realizedPnl ?? "--")}</strong></div>
            <div><span>{t("trading:fees")}</span><strong className="episode-cost-value">{formatAmount(episode.fees ?? "--")}</strong></div>
            <div><span>{t("trading:fundingFee")}</span><strong className={clsx("cell-tone", toneByNumber(episode.fundingFee))}>{formatAmount(episode.fundingFee ?? "--")}</strong></div>
            <div><span>{t("trading:liquidationAdl")}</span><strong className={clsx("cell-tone", toneByNumber(episode.liqPenalty))}>{formatAmount(episode.liqPenalty ?? "--")}</strong></div>
          </div>
        </section>

        <section className="episode-review-strip">
          <div>
            <span>{t("trading:eventStatistics")}</span>
            <strong title={eventStats}>{eventStats}</strong>
          </div>
          <div>
            <span>{t("trading:strategy")}</span>
            <strong title={episode.strategyId || t("trading:notLinked")}>{episode.strategyId || t("trading:notLinked")}</strong>
          </div>
          <div>
            <span>{t("trading:lastFill")}</span>
            <strong title={episode.lastTradeId || "--"}>{episode.lastTradeId || "--"}</strong>
          </div>
          <div>
            <span>{t("trading:updatedAt")}</span>
            <strong>{formatDateTime(episode.lastFillTime)}</strong>
          </div>
        </section>

        <section className="episode-event-timeline" aria-labelledby="episode-event-heading">
          <header className="episode-timeline-head">
            <div>
              <History size={14} />
              <strong id="episode-event-heading">{t("trading:eventTimeline")}</strong>
            </div>
            <span>{t("trading:eventTimelineSummary", { count: episode.events.length })}</span>
          </header>
          <div className="episode-event-list">
            {episode.events.map((event) => (
              <article className={clsx("episode-event-card", event.eventType.toLowerCase())} key={event.id}>
                <header>
                  <div><i /><strong>{formatEpisodeEventType(event.eventType, t)}</strong></div>
                  <time>{formatDateTime(event.eventTime)}</time>
                </header>
                <div className="episode-event-grid">
                  <span><small>{t("common:quantity")}</small><b>{formatAmount(event.qty)}</b></span>
                  <span><small>{t("common:price")}</small><b>{fmtPrice(event.price ?? undefined)}</b></span>
                  <span><small>{t("trading:positionAbbreviation")}</small><b>{formatAmount(event.positionBefore ?? "--")} → {formatAmount(event.positionAfter ?? "--")}</b></span>
                  <span><small>{t("trading:pnl")}</small><b className={clsx("cell-tone", toneByNumber(event.pnl))}>{formatAmount(event.pnl ?? "--")}</b></span>
                  <span><small>{t("trading:fees")}</small><b className="episode-cost-value">{formatAmount(event.fee ?? "--")} {event.feeCcy ?? ""}</b></span>
                  <span><small>{t("common:source")}</small><b>{formatEpisodeOrigin(event.origin, t)}</b></span>
                </div>
                <footer>
                  <span title={event.ordId || t("trading:noOrderId")}><small>{t("trading:order")}</small>{event.ordId || t("trading:noOrderId")}</span>
                  <span title={event.tradeId || t("trading:noFillId")}><small>{t("trading:fill")}</small>{event.tradeId || t("trading:noFillId")}</span>
                  {event.strategyId && <span title={event.strategyId}><small>{t("trading:strategy")}</small>{event.strategyId}</span>}
                </footer>
              </article>
            ))}
            {episode.events.length === 0 && <div className="empty-row">{t("trading:noEpisodeEvents")}</div>}
          </div>
        </section>
      </div>
    </ModalShell>
  );
}
