import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { useTranslation } from "react-i18next";
import { WorkspaceFrame } from "./WorkspaceFrame";
import {
  Activity,
  AlertTriangle,
  ArrowRightLeft,
  Bell,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  Clock3,
  Crosshair,
  FileDiff,
  Gauge,
  History,
  Lightbulb,
  Loader2,
  MoreHorizontal,
  Eye,
  Pencil,
  Percent,
  Play,
  Plus,
  Radio,
  RadioTower,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  WalletCards,
  Workflow,
  X
} from "lucide-react";
import clsx from "clsx";
import { useDraggableSurface } from "./useDraggableSurface";
import type {
  AccountSummary,
  AiAgentProfile,
  AiAgentScheme,
  AiAutomationCounts,
  AiAutomationEvent,
  AiAutomationOverview,
  AiAutomationReviewDetail,
  AiAutomationRunDetail,
  AiAutomationReview,
  AiAutomationRun,
  AiAutomationRunStatus,
  AiAutomationSummary,
  AiAutomationSection,
  AiAutomationTab,
  AiConfigSummary,
  AiDailyMarketReview,
  AiLegacyPermissionMode,
  AiNotificationDelivery,
  AiOptimizationSuggestion,
  AiPermissionMode,
  AiReasoningDepth,
  AiSkillDefinition,
  AiProfilePerformance,
  AiSkillVersion,
  AiWakeCondition,
  ChartFillMarker,
  MarketAssetsSummary,
  Ticker
} from "../types";
import { buildHistoricalFillMarkers } from "../lib/chartTradeSemantics";
import { AiMarkdown } from "./AiMarkdown";
import { AgentCollaborationTrace } from "./AgentCollaborationTrace";
import { KlineChart } from "./KlineChart";
import { TerminalSelect } from "./TerminalSelect";
import {
  AUTO_AGENT_LIMIT,
  CUSTOM_AGENT_LIMIT,
  createBuiltinAgentSchemes,
  createPerpetualDecisionTeam,
  ProfileCollaborationEditor,
  type AiAgentSchemeDraft
} from "./ProfileCollaborationEditor";
import { loadAiConfigSummary } from "../lib/ai";
import { filterInternalAiToolEvents } from "../lib/aiToolEvents";
import { resolveAiAutomationRunError } from "../lib/aiAgentTrace";
import { createDeferredCleanupSlot } from "../lib/deferredCleanup";
import { logger } from "../lib/logger";
import { invokeDesktop, isTauriRuntime, listenOptional } from "../lib/tauri";
import { formatLocalizedDate, formatLocalizedNumber, i18n } from "../i18n/runtime";
import { SymbolIcon, symbolBase } from "./SymbolIcon";

gsap.registerPlugin(useGSAP);

type NotificationInput = {
  kind: "success" | "info" | "warning" | "error" | "trade";
  title: string;
  message: string;
};

type SystematicProfileConflict = {
  id: string;
  name: string;
  instId: string;
};

type SystematicProfileConflictConfirmation = {
  profile: AiAgentProfile;
  conflicts: SystematicProfileConflict[];
};

type AiAutomationPanelProps = {
  accounts: AccountSummary[];
  marketAssets?: MarketAssetsSummary | null;
  /** Symbols with a live subscription. A Profile may only watch these, because
   *  anything else has no realtime candles for its tools to read. */
  watchlist?: string[];
  initialTab?: AiAutomationTab;
  focusId?: string | null;
  onNotify: (notification: NotificationInput) => void;
  onboardingActive?: boolean;
  onProfileSaved?: (profile: AiAgentProfile) => void;
};

const EMPTY_AUTOMATION_SUMMARY: AiAutomationSummary = {
  masterEnabled: false,
  agentSchemes: [],
  profiles: [],
  runs: [],
  wakeConditions: [],
  reviews: [],
  dailyMarketReviews: [],
  optimizationSuggestions: [],
  notificationDeliveries: [],
  skillVersions: []
};

const EMPTY_AUTOMATION_COUNTS: AiAutomationCounts = {
  runs: 0,
  runningRuns: 0,
  activeWakeConditions: 0,
  reviews: 0,
  pendingOptimizationSuggestions: 0,
  notifications: 0
};

let automationOverviewCache: AiAutomationOverview | null = null;
let automationConfigCache: AiConfigSummary | null = null;
const automationSectionCache = new Map<Exclude<AiAutomationTab, "profiles">, AiAutomationSection>();

const AUTOMATION_TABS: Array<{ id: AiAutomationTab; icon: typeof Bot }> = [
  { id: "profiles", icon: Bot },
  { id: "runs", icon: Activity },
  { id: "wake_conditions", icon: Radio },
  { id: "reviews", icon: ClipboardCheck },
  { id: "optimization", icon: Lightbulb },
  { id: "notifications", icon: Bell }
];

function automationTabI18nKey(id: AiAutomationTab) {
  if (id === "wake_conditions") return "automation:wakeConditions";
  if (id === "optimization") return "automation:suggestions";
  return `automation:${id}`;
}

const DEFAULT_WAKE_CONDITION_TYPES = [
  "timer",
  "price_cross",
  "price_change_pct",
  "candle_volume_ratio",
  "funding_rate_threshold",
  "orderbook_imbalance",
  "order_state_changed",
  "position_changed",
  "opportunity_state_changed",
  "episode_closed",
  "open_interest_anomaly",
  "taker_flow_imbalance",
  "crowding_divergence",
  "funding_extreme",
  "liquidation_cluster",
  "important_news_event",
  "sentiment_reversal",
  "smart_money_change",
  "macro_event_window"
] as const;

type WakeConditionType = (typeof DEFAULT_WAKE_CONDITION_TYPES)[number];
type WakePlanMode = "any" | "all";

type UserWakeConditionDraft = {
  conditionId?: string;
  profileId: string;
  planMode: WakePlanMode;
  conditionType: WakeConditionType;
  expiresAt: string;
  timerMode: "interval" | "at";
  atLocal: string;
  intervalMinutes: string;
  instId: string;
  direction: string;
  price: string;
  windowMinutes: string;
  thresholdPct: string;
  bar: string;
  lookback: string;
  ratio: string;
  rate: string;
  depth: string;
  accountId: string;
  states: string[];
  opportunityId: string;
};

const ORDER_STATE_OPTIONS = ["live", "partially_filled", "filled", "canceled", "mmp_canceled", "failed"];
const OPPORTUNITY_STATE_OPTIONS = ["pending", "approved", "rejected", "executing", "executed", "failed", "expired", "closed"];
const AUTOMATION_DISPLAY_TIME_ZONE = "Asia/Shanghai";

function automationText(
  key: string,
  english: string,
  chinese: string,
  values: Record<string, unknown> = {}
) {
  const language = (i18n.resolvedLanguage || i18n.language || "en-US").toLowerCase();
  return String(i18n.t(`automation:${key}`, {
    defaultValue: language.startsWith("zh") ? chinese : english,
    ...values
  }));
}

function isWakeConditionType(value: unknown): value is WakeConditionType {
  return typeof value === "string" && DEFAULT_WAKE_CONDITION_TYPES.includes(value as WakeConditionType);
}

function wakeConditionLabel(value: string) {
  const labels: Record<WakeConditionType, string> = {
    timer: automationText("wakeTypeTimer", "Scheduled wake-up", "定时唤醒"),
    price_cross: automationText("wakeTypePriceCross", "Price breakout", "价格突破"),
    price_change_pct: automationText("wakeTypePriceChange", "Window price change", "窗口涨跌幅"),
    candle_volume_ratio: automationText("wakeTypeVolumeRatio", "Candle volume surge", "K 线放量"),
    funding_rate_threshold: automationText("wakeTypeFundingThreshold", "Funding-rate threshold", "资金费率阈值"),
    orderbook_imbalance: automationText("wakeTypeOrderbookImbalance", "Order-book imbalance", "盘口失衡"),
    order_state_changed: automationText("wakeTypeOrderState", "Order state changed", "订单状态变化"),
    position_changed: automationText("wakeTypePositionState", "Position changed", "持仓变化"),
    opportunity_state_changed: automationText("wakeTypeOpportunityState", "Opportunity state changed", "交易机会状态变化"),
    episode_closed: automationText("wakeTypeEpisodeClosed", "Position episode closed", "持仓 Episode 结束"),
    open_interest_anomaly: automationText("wakeTypeOiAnomaly", "Open-interest anomaly", "OI 异常"),
    taker_flow_imbalance: automationText("wakeTypeTakerFlow", "Taker-flow imbalance", "主动流失衡"),
    crowding_divergence: automationText("wakeTypeCrowding", "Crowding divergence", "拥挤度分歧"),
    funding_extreme: automationText("wakeTypeFundingExtreme", "Extreme funding rate", "资金费率极端"),
    liquidation_cluster: automationText("wakeTypeLiquidationCluster", "Liquidation cluster", "爆仓样本聚集"),
    important_news_event: automationText("wakeTypeImportantNews", "Important news event", "重要新闻事件"),
    sentiment_reversal: automationText("wakeTypeSentimentReversal", "Sentiment reversal", "情绪反转"),
    smart_money_change: automationText("wakeTypeSmartMoney", "Smart Money change", "Smart Money 变化"),
    macro_event_window: automationText("wakeTypeMacroWindow", "Macro event window", "宏观事件窗口")
  };
  return isWakeConditionType(value) ? labels[value] : value;
}

function FieldLabel({ children, help }: { children: string; help: string }) {
  return (
    <span className="automation-label-with-help">
      <span>{children}</span>
      <span className="automation-field-help" role="img" aria-label={help} title={help} tabIndex={0}>
        <CircleHelp size={12} aria-hidden="true" />
      </span>
    </span>
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function valueString(value: unknown, fallback = "") {
  return value == null ? fallback : String(value);
}

function toLocalDateTimeInput(value?: number | null) {
  if (!value || !Number.isFinite(value)) return "";
  const date = new Date(value);
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function parseRequiredNumber(value: string, label: string, minimum?: number, maximum?: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(automationText("validationNumber", "{{label}} must be a valid number.", "{{label}}必须是有效数字。", { label }));
  if (minimum !== undefined && number < minimum) throw new Error(automationText("validationMinimum", "{{label}} cannot be less than {{minimum}}.", "{{label}}不能小于 {{minimum}}。", { label, minimum }));
  if (maximum !== undefined && number > maximum) throw new Error(automationText("validationMaximum", "{{label}} cannot be greater than {{maximum}}.", "{{label}}不能大于 {{maximum}}。", { label, maximum }));
  return number;
}

function createUserWakeConditionDraft(profile?: AiAgentProfile | null): UserWakeConditionDraft {
  const allowedType = profile?.allowedWakeConditionTypes.find(isWakeConditionType) ?? "timer";
  return {
    profileId: profile?.id ?? "",
    planMode: "any",
    conditionType: allowedType,
    expiresAt: "",
    timerMode: "interval",
    atLocal: "",
    intervalMinutes: String(profile?.scanIntervalMinutes ?? 15),
    instId: profile?.symbols[0] ?? "",
    direction: "up",
    price: "",
    windowMinutes: "15",
    thresholdPct: "1",
    bar: "1m",
    lookback: "20",
    ratio: "2",
    rate: "0.001",
    depth: "5",
    accountId: profile?.accountId ?? "",
    states: [],
    opportunityId: ""
  };
}

function userWakeConditionDraftFromItem(item: AiWakeCondition, profile?: AiAgentProfile | null): UserWakeConditionDraft {
  const config = asRecord(item.config);
  const conditionType = isWakeConditionType(config.type)
    ? config.type
    : isWakeConditionType(item.conditionType)
      ? item.conditionType
      : "timer";
  const states = Array.isArray(config.states) ? config.states.map(String) : [];
  return {
    ...createUserWakeConditionDraft(profile),
    conditionId: item.id,
    profileId: item.profileId,
    planMode: item.planMode === "all" ? "all" : "any",
    conditionType,
    expiresAt: toLocalDateTimeInput(item.expiresAt),
    timerMode: config.atMs != null ? "at" : "interval",
    atLocal: toLocalDateTimeInput(Number(config.atMs)),
    intervalMinutes: valueString(config.intervalMinutes, "15"),
    instId: valueString(config.instId, profile?.symbols[0] ?? ""),
    direction: valueString(config.direction, "up"),
    price: valueString(config.price),
    windowMinutes: valueString(config.windowMinutes, "15"),
    thresholdPct: valueString(config.thresholdPct, "1"),
    bar: valueString(config.bar, "1m"),
    lookback: valueString(config.lookback, "20"),
    ratio: valueString(config.ratio, "2"),
    rate: valueString(config.rate, "0.001"),
    depth: valueString(config.depth, "5"),
    accountId: valueString(config.accountId, profile?.accountId ?? ""),
    states,
    opportunityId: valueString(config.opportunityId)
  };
}

function buildWakeCondition(draft: UserWakeConditionDraft): Record<string, unknown> {
  const requiredSymbol = () => {
    if (!draft.instId) throw new Error(automationText("wakeSelectInstrument", "Select a trading instrument.", "请选择交易品种。"));
    return draft.instId;
  };
  switch (draft.conditionType) {
    case "timer":
      if (draft.timerMode === "at") {
        const atMs = new Date(draft.atLocal).getTime();
        if (!Number.isFinite(atMs)) throw new Error(automationText("wakeSelectValidTime", "Select a valid wake-up time.", "请选择有效的唤醒时间。"));
        const now = Date.now();
        if (atMs <= now || atMs > now + 366 * 24 * 60 * 60_000) throw new Error(automationText("wakeTimeWithinYear", "The wake-up time must be within the next year.", "唤醒时间必须在未来一年内。"));
        return { type: "timer", atMs };
      }
      return { type: "timer", intervalMinutes: parseRequiredNumber(draft.intervalMinutes, automationText("wakeIntervalMinutes", "Interval in minutes", "间隔分钟"), 1, 1_440) };
    case "price_cross":
      return { type: "price_cross", instId: requiredSymbol(), direction: draft.direction, price: parseRequiredNumber(draft.price, automationText("wakeTriggerPrice", "Trigger price", "触发价格"), 0.00000001) };
    case "price_change_pct":
      return {
        type: "price_change_pct",
        instId: requiredSymbol(),
        windowMinutes: parseRequiredNumber(draft.windowMinutes, automationText("wakeWindow", "Observation window", "统计窗口"), 1, 1_440),
        direction: draft.direction,
        thresholdPct: parseRequiredNumber(draft.thresholdPct, automationText("wakeChangeThreshold", "Price-change threshold", "涨跌幅阈值"), 0.000001, 1_000)
      };
    case "candle_volume_ratio":
      return {
        type: "candle_volume_ratio",
        instId: requiredSymbol(),
        bar: draft.bar,
        lookback: parseRequiredNumber(draft.lookback, automationText("wakeLookbackCandles", "Lookback candles", "回看 K 线数量"), 1, 500),
        ratio: parseRequiredNumber(draft.ratio, automationText("wakeVolumeRatio", "Volume multiplier", "成交量倍数"), 0.000001, 100)
      };
    case "funding_rate_threshold":
      return { type: "funding_rate_threshold", instId: requiredSymbol(), direction: draft.direction, rate: parseRequiredNumber(draft.rate, automationText("wakeFundingRate", "Funding rate", "资金费率"), -1, 1) };
    case "orderbook_imbalance":
      return {
        type: "orderbook_imbalance",
        instId: requiredSymbol(),
        depth: parseRequiredNumber(draft.depth, automationText("wakeOrderbookDepth", "Order-book depth", "盘口档数"), 1, 50),
        direction: draft.direction,
        ratio: parseRequiredNumber(draft.ratio, automationText("wakeOrderbookRatio", "Order-book ratio", "盘口占比"), 0.000001, 1)
      };
    case "order_state_changed":
      return {
        type: "order_state_changed",
        ...(draft.accountId ? { accountId: draft.accountId } : {}),
        ...(draft.instId ? { instId: draft.instId } : {}),
        states: draft.states
      };
    case "position_changed":
      return {
        type: "position_changed",
        ...(draft.accountId ? { accountId: draft.accountId } : {}),
        ...(draft.instId ? { instId: draft.instId } : {})
      };
    case "opportunity_state_changed":
      if (!draft.opportunityId.trim()) throw new Error(automationText("wakeOpportunityIdRequired", "Enter a trade opportunity ID within the current Profile.", "请输入当前 Profile 范围内的交易机会 ID。"));
      return {
        type: "opportunity_state_changed",
        opportunityId: draft.opportunityId.trim(),
        states: draft.states
      };
    case "episode_closed":
      return {
        type: "episode_closed",
        ...(draft.accountId ? { accountId: draft.accountId } : {}),
        ...(draft.instId ? { instId: draft.instId } : {})
      };
    case "open_interest_anomaly":
    case "taker_flow_imbalance":
    case "crowding_divergence":
    case "funding_extreme":
    case "liquidation_cluster":
    case "important_news_event":
    case "sentiment_reversal":
    case "smart_money_change":
    case "macro_event_window":
      return { type: draft.conditionType, ...(draft.instId ? { instId: draft.instId } : {}) };
  }
}

function normalizePermissionMode(mode: AiPermissionMode | AiLegacyPermissionMode | string | undefined): AiPermissionMode {
  if (mode === "advisor" || mode === "readonly") return "advisor";
  if (mode === "limited_auto") return "limited_auto";
  return "copilot";
}

function permissionModeLabel(mode: AiPermissionMode | AiLegacyPermissionMode | string | undefined) {
  switch (normalizePermissionMode(mode)) {
    case "advisor":
      return i18n.t("automation:profileModeAdvisor");
    case "limited_auto":
      return i18n.t("automation:profileModeLimitedAuto");
    default:
      return i18n.t("automation:profileModeCopilot");
  }
}

function permissionModeI18nKey(mode: AiPermissionMode | AiLegacyPermissionMode | string | undefined) {
  switch (normalizePermissionMode(mode)) {
    case "advisor":
      return "automation:profileModeAdvisor";
    case "limited_auto":
      return "automation:profileModeLimitedAuto";
    default:
      return "automation:profileModeCopilot";
  }
}

function permissionModeHintI18nKey(mode: AiPermissionMode) {
  switch (mode) {
    case "advisor":
      return "automation:profileModeHintAdvisor";
    case "limited_auto":
      return "automation:profileModeHintLimitedAuto";
    default:
      return "automation:profileModeHintCopilot";
  }
}

function normalizeSummary(value: AiAutomationSummary): AiAutomationSummary {
  const agentSchemes = (Array.isArray(value?.agentSchemes) ? value.agentSchemes : [])
    .map(normalizeAgentScheme)
    .filter((scheme): scheme is AiAgentScheme => Boolean(scheme));
  for (const builtin of createBuiltinAgentSchemes()) {
    if (!agentSchemes.some((scheme) => scheme.id === builtin.id)) agentSchemes.unshift(builtin);
  }
  return {
    masterEnabled: Boolean(value?.masterEnabled),
    agentSchemes,
    profiles: Array.isArray(value?.profiles) ? value.profiles.map(normalizeProfile) : [],
    runs: Array.isArray(value?.runs) ? value.runs : [],
    wakeConditions: Array.isArray(value?.wakeConditions) ? value.wakeConditions : [],
    reviews: Array.isArray(value?.reviews) ? value.reviews : [],
    dailyMarketReviews: Array.isArray(value?.dailyMarketReviews) ? value.dailyMarketReviews : [],
    optimizationSuggestions: Array.isArray(value?.optimizationSuggestions) ? value.optimizationSuggestions : [],
    notificationDeliveries: Array.isArray(value?.notificationDeliveries) ? value.notificationDeliveries : [],
    skillVersions: Array.isArray(value?.skillVersions) ? value.skillVersions : [],
    // Rebuilt field by field, so anything omitted here is silently dropped: the
    // Profile cards showed "--" because this list never survived normalization.
    profilePerformance: Array.isArray(value?.profilePerformance) ? value.profilePerformance : []
  };
}

function normalizeSubAgents(value: unknown, limit = CUSTOM_AGENT_LIMIT) {
  return (Array.isArray(value) ? value : [])
    .slice(0, limit)
    .map((item, index) => {
      const agent = asRecord(item);
      return {
        id: valueString(agent.id, `agent-${index + 1}`),
        name: valueString(agent.name),
        role: valueString(agent.role),
        responsibility: valueString(agent.responsibility),
        scopes: Array.isArray(agent.scopes) ? Array.from(new Set(agent.scopes.map(String).filter(Boolean))) : [],
        required: Boolean(agent.required),
        enabled: Boolean(agent.enabled)
      };
    });
}

function normalizeAgentScheme(value: unknown): AiAgentScheme | null {
  const scheme = asRecord(value);
  const id = valueString(scheme.id);
  const name = valueString(scheme.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    description: valueString(scheme.description),
    builtin: Boolean(scheme.builtin),
    agents: normalizeSubAgents(scheme.agents),
    createdAt: Number(scheme.createdAt) || 0,
    updatedAt: Number(scheme.updatedAt) || 0
  };
}

const REQUIRED_PROFILE_SKILL_IDS = [
  "desic-core-operations",
  "trading-philosophy",
  "okx-news-intelligence",
  "okx-smart-money-analysis"
] as const;
const REQUIRED_PROFILE_SKILL_ID_SET = new Set<string>(REQUIRED_PROFILE_SKILL_IDS);

function withRequiredProfileSkills(skillIds: string[] | undefined): string[] {
  return [...new Set([...REQUIRED_PROFILE_SKILL_IDS, ...(skillIds ?? []).map((skillId) => skillId.trim()).filter(Boolean)])];
}

function normalizeProfile(profile: AiAgentProfile): AiAgentProfile {
  const allowedWakeConditionTypes = Array.isArray(profile.allowedWakeConditionTypes)
    ? profile.allowedWakeConditionTypes.filter(isWakeConditionType)
    : [];
  const multiAgentMode = profile.multiAgentMode === "auto" || profile.multiAgentMode === "custom"
    ? profile.multiAgentMode
    : "off";
  const multiAgents = normalizeSubAgents(profile.multiAgents);
  const modeAgentLimit = multiAgentMode === "auto" ? AUTO_AGENT_LIMIT : CUSTOM_AGENT_LIMIT;
  return {
    ...profile,
    mode: normalizePermissionMode(profile.mode),
    symbols: Array.isArray(profile.symbols) ? profile.symbols : [],
    skillIds: withRequiredProfileSkills(Array.isArray(profile.skillIds) ? profile.skillIds : []),
    skillVersions: profile.skillVersions ?? {},
    skillVersionModes: profile.skillVersionModes ?? {},
    reasoningDepth: profile.reasoningDepth ?? "medium",
    targetLeverage: Math.max(1, Math.min(125, Math.round(Number(profile.targetLeverage) || 20))),
    maxSingleTradeMarginPct: Math.max(1, Math.min(100, Math.round(Number(profile.maxSingleTradeMarginPct) || 30))),
    dailyReviewEnabled: Boolean(profile.dailyReviewEnabled),
    allowedWakeConditionTypes: allowedWakeConditionTypes.length > 0
      ? allowedWakeConditionTypes
      : [...DEFAULT_WAKE_CONDITION_TYPES],
    multiAgentMode,
    multiAgentMaxAgents: Math.max(2, Math.min(modeAgentLimit, Number(profile.multiAgentMaxAgents) || 4)),
    multiAgentSchemeId: typeof profile.multiAgentSchemeId === "string" && profile.multiAgentSchemeId.trim()
      ? profile.multiAgentSchemeId.trim()
      : null,
    multiAgents
  };
}

function createProfile(accounts: AccountSummary[], defaultModelId: string): AiAgentProfile {
  const now = Date.now();
  const account = accounts[0];
  return {
    id: `profile-${now}`,
    name: "",
    enabled: false,
    mode: "advisor",
    accountId: account?.id ?? null,
    environment: account?.environment ?? "demo",
    symbols: ["BTC-USDT-SWAP"],
    scanIntervalMinutes: 15,
    skillIds: withRequiredProfileSkills([]),
    skillVersions: {},
    skillVersionModes: {},
    model: defaultModelId || null,
    reasoningDepth: "medium",
    historyLookbackDays: 30,
    similarityWindowMinutes: 10,
    entryToleranceBps: 30,
    targetLeverage: 20,
    maxSingleTradeMarginPct: 30,
    minWakeIntervalSeconds: 60,
    maxRunsPerHour: 12,
    feishuEnabled: false,
    dailyReviewEnabled: false,
    allowedWakeConditionTypes: [...DEFAULT_WAKE_CONDITION_TYPES],
    multiAgentMode: "off",
    multiAgentMaxAgents: 4,
    multiAgentSchemeId: null,
    multiAgents: [],
    createdAt: now,
    updatedAt: now
  };
}

function formatDateTime(value?: number | null) {
  if (!value) return "--";
  return formatLocalizedDate(value, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function formatStructured(value: unknown): string {
  if (value == null || value === "") return "--";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => formatStructured(item)).filter((item) => item !== "--").join(" · ") || "--";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function structuredPreview(value: unknown, maxLength = 220) {
  const text = formatStructured(value).replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trim()}…`;
}

function statusTone(status: string) {
  const value = String(status || "").toLowerCase();
  if (/(failed|error|rejected|blocked|expired|cancelled|canceled)/.test(value)) return "danger";
  if (/(running|pending|queued|review|validating|draft)/.test(value)) return "warning";
  if (/(success|completed|done|sent|accepted|approved|active|enabled|ready|applied|published)/.test(value)) return "success";
  return "neutral";
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    queued: automationText("statusQueued", "Queued", "排队中"),
    running: i18n.t("automation:running"),
    completed: i18n.t("automation:completed"),
    success: i18n.t("common:success"),
    failed: i18n.t("automation:failed"),
    pending: i18n.t("automation:pending"),
    pending_review: automationText("statusPendingReview", "Pending review", "待查看"),
    validating: automationText("statusValidating", "Awaiting validation", "待验证"),
    ready: automationText("statusReady", "Ready to adopt", "可采用"),
    applied: automationText("statusApplied", "Adopted", "已采用"),
    accepted: automationText("statusApplied", "Adopted", "已采用"),
    rejected: automationText("statusRejected", "Rejected", "已拒绝"),
    cancelled: automationText("statusCancelled", "Removed", "已删除"),
    draft: automationText("statusDraft", "Draft", "草稿"),
    published: automationText("statusPublished", "Published", "已发布"),
    sent: automationText("statusSent", "Sent", "已发送"),
    active: automationText("statusActive", "Active", "生效中"),
    disabled: i18n.t("common:disabled"),
    expired: automationText("statusExpired", "Expired", "已过期")
  };
  return labels[status] ?? (status || i18n.t("common:unknown"));
}

function SectionState({ icon, title, detail, action }: { icon: ReactNode; title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="automation-state">
      <span>{icon}</span>
      <strong>{title}</strong>
      <p>{detail}</p>
      {action}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <span className={clsx("automation-status", statusTone(status))}>{statusLabel(status)}</span>;
}

function Metric({ label, value, icon, tone }: { label: string; value: number; icon: ReactNode; tone?: "active" | "attention" }) {
  return (
    <div className={clsx("automation-metric", tone)}>
      <span className="automation-metric-icon">{icon}</span>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

/** Trailing window for the Profile cards. Kept in step with
 *  PROFILE_PERFORMANCE_WINDOW_DAYS in ai_automation.rs. */
const PROFILE_CARD_WINDOW_DAYS = 30;

/** Returns a Profile name that is not already taken, appending the smallest free
 *  numeric suffix. Comparison ignores case and surrounding spaces so "Profile"
 *  and "profile " are treated as the same name. `excludeId` lets a Profile keep
 *  its own name while being renamed. */
function uniqueProfileName(
  desired: string,
  existing: ReadonlyArray<{ id: string; name: string }>,
  excludeId?: string
): string {
  const base = desired.trim() || "Profile";
  const taken = new Set(
    existing
      .filter((item) => item.id !== excludeId)
      .map((item) => item.name.trim().toLowerCase())
  );
  if (!taken.has(base.toLowerCase())) return base;
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  // Practically unreachable; keeps the function total instead of looping forever.
  return `${base} ${Date.now()}`;
}

/** Signed USDT amount for a card readout. Keeps two decimals so a small
 *  automation result stays legible instead of rounding to zero. */
function formatSignedUsdtAmount(value: number): string {
  if (!Number.isFinite(value)) return "--";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${Math.abs(value).toFixed(2)} USDT`;
}

/** In-app confirmation. `window.confirm` is unavailable in the Tauri webview
 *  ("dialog.confirm not allowed"), so destructive actions use this instead of a
 *  native prompt that silently rejects. */
function AutomationConfirmDialog({
  title,
  message,
  confirmText,
  danger,
  onCancel,
  onConfirm
}: Readonly<{
  title: string;
  message: string;
  confirmText: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}>) {
  const { t } = useTranslation(["automation", "common"]);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return createPortal(
    <div className="modal-backdrop compact automation-confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="modal-shell compact automation-confirm-modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head"><div><strong>{title}</strong></div></header>
        <p className="automation-confirm-modal__message">{message}</p>
        <div className="modal-actions">
          <button type="button" ref={cancelRef} onClick={onCancel}>{t("common:cancel")}</button>
          <button type="button" className={danger ? "danger-action" : ""} onClick={onConfirm}>{confirmText}</button>
        </div>
      </section>
    </div>,
    document.body
  );
}

/** A Profile at rest. Everything the list view used to truncate is shown here in
 *  full, and the actions that do not need the editor act straight from the card. */
function ProfileCard({
  profile,
  marketAssets,
  running,
  focused,
  recentRuns,
  performance,
  busy,
  onEdit,
  onDelete,
  onToggleEnabled
}: Readonly<{
  profile: AiAgentProfile;
  marketAssets: MarketAssetsSummary | null | undefined;
  running: boolean;
  focused: boolean;
  recentRuns: { runs: number; failed: number; trades: number; lastAt: number | null } | null;
  performance: AiProfilePerformance | null;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: () => void;
}>) {
  const { t } = useTranslation(["automation", "common", "trading"]);
  const state = running ? "running" : profile.enabled ? "listening" : "stopped";
  const stateLabel = running
    ? t("automation:running")
    : profile.enabled
      ? t("automation:profileListening")
      : t("automation:stopped");
  const collaboration = profile.multiAgentMode === "off"
    ? t("automation:profileCardSingleAgent")
    : profile.multiAgentMode === "auto"
      ? t("automation:profileCollaborationAuto", { count: profile.multiAgentMaxAgents || 4 })
      : t("automation:profileCollaborationCustom", { count: profile.multiAgents.filter((agent) => agent.enabled).length });

  return (
    <article className={clsx("automation-profile-card", `is-${state}`, focused && "is-focused")} data-profile-id={profile.id}>
      <header className="automation-profile-card__head">
        <div className="automation-profile-card__identity">
          <strong title={profile.name}>{profile.name}</strong>
          <div className="automation-profile-card__tags">
            <em>{t(permissionModeI18nKey(profile.mode))}</em>
            <em className={profile.environment === "live" ? "is-live" : "is-demo"}>
              {profile.environment === "live" ? t("common:live") : t("common:demo")}
            </em>
            <em className="is-quiet">{collaboration}</em>
          </div>
        </div>
        {/* Enabling is the one setting changed often enough to belong on the card. */}
        <label className="automation-profile-card__switch" title={t("automation:profileCardEnable")}>
          <input type="checkbox" checked={profile.enabled} disabled={busy} onChange={onToggleEnabled} />
          <span />
        </label>
      </header>

      <div className="automation-profile-card__symbols">
        {profile.symbols.length === 0 ? (
          <span className="automation-profile-card__symbol is-empty">--</span>
        ) : profile.symbols.slice(0, 3).map((symbol) => {
          const asset = marketAssets?.instruments.find((item) => item.instId === symbol);
          return (
            <span className="automation-profile-card__symbol" key={symbol}>
              <SymbolIcon base={asset?.baseCcy || symbolBase(symbol)} iconPath={asset?.iconPath} cached={asset?.iconCached} cacheDir={marketAssets?.cacheDir} />
              {symbol}
            </span>
          );
        })}
        {profile.symbols.length > 3 ? <span className="automation-profile-card__symbol is-more">+{profile.symbols.length - 3}</span> : null}
      </div>

      <dl className="automation-profile-card__facts">
        <div><dt>{t("automation:profileCardLeverage")}</dt><dd>{profile.targetLeverage}X</dd></div>
        <div><dt>{t("automation:profileCardMargin")}</dt><dd>{profile.maxSingleTradeMarginPct}%</dd></div>
        <div><dt>{t("automation:profileCardInterval")}</dt><dd>{t("automation:profileCardScan", { minutes: profile.scanIntervalMinutes })}</dd></div>
      </dl>

      <div className="automation-profile-card__recent">
        <span>{t("automation:profileCardRecent")}</span>
        <span className="automation-profile-card__recent-values">
          {/* Net result leads; red is a gain and green a loss, as everywhere else. */}
          {performance && performance.fillCount > 0 ? (
            <strong className={clsx("automation-profile-card__pnl", performance.netPnlUsdt >= 0 ? "is-gain" : "is-loss")}>
              {formatSignedUsdtAmount(performance.netPnlUsdt)}
            </strong>
          ) : (
            <strong className="automation-profile-card__pnl is-muted">--</strong>
          )}
          {recentRuns && recentRuns.runs > 0 ? (
            <em>
              {t("automation:profileCardRuns", { count: recentRuns.runs })}
              {recentRuns.failed > 0 ? <b className="is-failed">{t("automation:profileCardFailed", { count: recentRuns.failed })}</b> : null}
            </em>
          ) : (
            <em className="is-muted">{t("automation:profileCardNoRuns")}</em>
          )}
        </span>
      </div>

      <footer className="automation-profile-card__actions">
        <span className={clsx("automation-profile-card__state", `is-${state}`)}><i />{stateLabel}</span>
        <div className="automation-profile-card__buttons">
          <button type="button" onClick={onEdit} title={t("automation:profileCardOpenEditor", { name: profile.name })}>
            <Pencil size={13} />{t("automation:profileCardEdit")}
          </button>
          <button type="button" className="is-danger" onClick={onDelete} disabled={busy} title={t("automation:profileDelete")}>
            <Trash2 size={13} />
          </button>
        </div>
      </footer>
    </article>
  );
}

/** Hosts the existing editor in a draggable dialog. The editor component itself
 *  is unchanged; only its container moved out of the page body. */
function ProfileEditorDialog({
  title,
  dirty,
  onClose,
  children
}: Readonly<{ title: string; dirty: boolean; onClose: () => void; children: ReactNode }>) {
  const { t } = useTranslation(["automation", "common"]);
  const dialogDrag = useDraggableSurface<HTMLElement>();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="modal-backdrop automation-profile-editor-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section ref={dialogDrag.surfaceRef} className="modal-shell automation-profile-editor-modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head automation-profile-editor-modal__head" {...dialogDrag.handleProps}>
          <div>
            <strong>{title}</strong>
            {dirty ? <span className="automation-profile-editor-modal__dirty">{t("automation:profileUnsavedTitle")}</span> : null}
          </div>
          <button className="window-button" type="button" onClick={onClose} title={t("common:close")}><X size={16} /></button>
        </header>
        <div className="automation-profile-editor-modal__body">{children}</div>
      </section>
    </div>,
    document.body
  );
}

function ProfileEditor({
  draft,
  accounts,
  marketAssets,
  watchlist,
  skills,
  skillVersions,
  models,
  agentSchemes,
  busy,
  schemeBusy,
  onChange,
  onSaveScheme,
  onDeleteScheme,
  onSave,
  onRun,
  onDailyReview,
  onDelete
}: {
  draft: AiAgentProfile;
  accounts: AccountSummary[];
  marketAssets?: MarketAssetsSummary | null;
  watchlist?: string[];
  skills: AiSkillDefinition[];
  skillVersions: AiSkillVersion[];
  models: AiConfigSummary["models"];
  agentSchemes: AiAgentScheme[];
  busy: boolean;
  schemeBusy: boolean;
  onChange: (patch: Partial<AiAgentProfile>) => void;
  onSaveScheme: (scheme: AiAgentSchemeDraft) => Promise<AiAgentScheme | null>;
  onDeleteScheme: (id: string) => Promise<boolean>;
  onSave: () => void;
  onRun: () => void;
  onDailyReview: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation(["automation", "common"]);
  const [symbolQuery, setSymbolQuery] = useState("");
  const [symbolPickerOpen, setSymbolPickerOpen] = useState(false);
  const skillIds = useMemo(() => new Set(draft.skillIds), [draft.skillIds]);
  const boundAccount = accounts.find((account) => account.id === draft.accountId) ?? null;
  const boundEnvironment = boundAccount?.environment ?? draft.environment;
  // Only watchlist symbols are offered. The market stream subscribes the
  // watchlist plus the chart's symbol, so a Profile watching anything else has
  // no realtime candles and its tools report missing data instead of trading on
  // stale numbers.
  const watchlistSymbols = useMemo(
    () => new Set((watchlist ?? []).map((item) => item.trim().toUpperCase()).filter(Boolean)),
    [watchlist]
  );
  const symbolOptions = useMemo(() => {
    const query = symbolQuery.trim().toUpperCase();
    const selected = new Set(draft.symbols);
    return (marketAssets?.instruments ?? [])
      .filter((item) => watchlistSymbols.size === 0 || watchlistSymbols.has(item.instId))
      .filter((item) => !selected.has(item.instId))
      .filter((item) => !query || item.instId.includes(query) || item.baseCcy.includes(query))
      .slice(0, 8);
  }, [draft.symbols, marketAssets?.instruments, symbolQuery, watchlistSymbols]);
  const addProfileSymbol = (symbol: string) => {
    const normalized = symbol.trim().toUpperCase();
    if (!normalized) return;
    // Typing a symbol by hand must not bypass the restriction.
    if (watchlistSymbols.size > 0 && !watchlistSymbols.has(normalized)) return;
    onChange({ symbols: Array.from(new Set([...draft.symbols, normalized])) });
    setSymbolQuery("");
    setSymbolPickerOpen(false);
  };
  const selectedSkills = useMemo(() => skills.filter((skill) => skillIds.has(skill.id)), [skillIds, skills]);
  const publishedVersions = useMemo(() => {
    const grouped = new Map<string, AiSkillVersion[]>();
    for (const version of skillVersions) {
      if (version.status !== "published") continue;
      const items = grouped.get(version.skillId) ?? [];
      items.push(version);
      grouped.set(version.skillId, items);
    }
    for (const items of grouped.values()) items.sort((a, b) => b.version - a.version);
    return grouped;
  }, [skillVersions]);
  const updateNumber = (key: keyof AiAgentProfile, value: string, minimum: number, maximum: number) => {
    const next = Number(value);
    onChange({
      [key]: Number.isFinite(next) ? Math.min(maximum, Math.max(minimum, next)) : minimum
    } as Partial<AiAgentProfile>);
  };
  const toggleSkill = (id: string, checked: boolean) => {
    if (REQUIRED_PROFILE_SKILL_ID_SET.has(id)) return;
    const next = new Set(draft.skillIds);
    if (checked) next.add(id);
    else next.delete(id);
    const nextVersions = { ...(draft.skillVersions ?? {}) };
    const nextModes = { ...(draft.skillVersionModes ?? {}) };
    if (!checked) delete nextVersions[id];
    if (!checked) delete nextModes[id];
    onChange({ skillIds: Array.from(next), skillVersions: nextVersions, skillVersionModes: nextModes });
  };
  const updateSkillVersion = (skillId: string, value: string) => {
    const next = { ...(draft.skillVersions ?? {}) };
    const nextModes = { ...(draft.skillVersionModes ?? {}) };
    if (value) {
      next[skillId] = Number(value);
      nextModes[skillId] = "pinned";
    } else {
      delete next[skillId];
      delete nextModes[skillId];
    }
    onChange({ skillVersions: next, skillVersionModes: nextModes });
  };

  return (
    <div className="automation-profile-editor">
      <div className="automation-editor-head">
        <div className="automation-editor-title">
          <span className="automation-editor-mark"><Bot size={16} /></span>
          <div>
            <strong>{draft.name || t("automation:profileUnnamed")}</strong>
            <span>{t(permissionModeHintI18nKey(normalizePermissionMode(draft.mode)))}</span>
          </div>
        </div>
        <div className="automation-editor-toolbar">
          <label className="automation-check compact">
            <input type="checkbox" checked={draft.enabled} onChange={(event) => onChange({ enabled: event.target.checked })} />
            <span>{t("common:enabled")}</span>
          </label>
          <button onClick={onRun} disabled={busy || !draft.id} title={t("automation:profileRunNow")}><Play size={14} />{t("common:run")}</button>
          <button className="automation-danger-button" onClick={onDelete} disabled={busy} title={t("automation:profileDelete")}><Trash2 size={14} />{t("common:delete")}</button>
          <button className="primary" onClick={() => onSave()} disabled={busy}><Save size={14} />{t("common:save")}</button>
        </div>
      </div>

      <div className="automation-form-section automation-basic-section">
        <strong><Bot size={13} />{t("automation:profileBasicSettings")}</strong>
        <div className="automation-form-grid">
        <label className="wide">
          <span>{t("common:name")}</span>
          <input value={draft.name} data-onboarding-focus onChange={(event) => onChange({ name: event.target.value })} />
        </label>
        <label>
          <span>{t("automation:profileMode")}</span>
          <TerminalSelect
            ariaLabel={t("automation:profileMode")}
            value={normalizePermissionMode(draft.mode)}
            options={[
              { value: "advisor", label: t("automation:profileModeAdvisor") },
              { value: "copilot", label: t("automation:profileModeCopilot") },
              { value: "limited_auto", label: t("automation:profileModeLimitedAuto") }
            ]}
            onChange={(value) => onChange({ mode: value as AiPermissionMode })}
          />
        </label>
        <label>
          <span>{t("common:account")}</span>
          <TerminalSelect
            ariaLabel={t("common:account")}
            value={draft.accountId ?? ""}
            options={[
              { value: "", label: t("automation:profileNoBoundAccount") },
              ...accounts.map((account) => ({
                value: account.id,
                label: `${account.name} · ${account.environment === "live" ? t("common:live") : t("common:demo")}`
              }))
            ]}
            onChange={(value) => {
              const selected = accounts.find((account) => account.id === value);
              onChange({ accountId: value || null, environment: selected?.environment ?? "demo" });
            }}
          />
        </label>
        <div className="automation-derived-environment">
          <span>{t("automation:profileTradingEnvironment")}</span>
          <strong className={boundAccount ? boundEnvironment : "unbound"}>
            <ShieldCheck size={13} />
            {boundAccount ? boundEnvironment === "live" ? t("common:live") : t("common:demo") : t("automation:profileNoBoundAccount")}
          </strong>
          <small>{t("automation:profileEnvironmentFollowsAccount")}</small>
        </div>
        <label>
          <FieldLabel help={t("automation:profileModelHelp")}>{t("automation:profileModel")}</FieldLabel>
          <div className="automation-model-field">
            <TerminalSelect
              ariaLabel={t("automation:profileModel")}
              value={draft.model ?? models[0]?.id ?? ""}
              options={models.length > 0
                ? models.map((item) => ({ value: item.id, label: `${item.name} · ${item.model}` }))
                : [{ value: "", label: t("automation:profileNoModels"), disabled: true }]}
              onChange={(value) => onChange({ model: value || null })}
            />
            <button type="button" onClick={() => openSettingsTab("ai")}>{t("automation:profileAddModel")}</button>
          </div>
        </label>
        <label>
          <FieldLabel help={t("automation:profileReasoningDepthHelp")}>{t("automation:profileReasoningDepth")}</FieldLabel>
          <TerminalSelect
            ariaLabel={t("automation:profileReasoningDepthAria")}
            value={draft.reasoningDepth}
            options={[
              { value: "none", label: t("automation:profileReasoningNone") },
              { value: "minimal", label: t("automation:profileReasoningMinimal") },
              { value: "low", label: t("automation:profileReasoningLow") },
              { value: "medium", label: t("automation:profileReasoningMedium") },
              { value: "high", label: t("automation:profileReasoningHigh") },
              { value: "xhigh", label: t("automation:profileReasoningXhigh") }
            ]}
            onChange={(value) => onChange({ reasoningDepth: value as AiReasoningDepth })}
          />
        </label>
        <div className="automation-symbol-field wide">
          <span>
            {t("automation:profileWatchSymbols")}
            <small>{t("automation:profileWatchSymbolsWatchlistOnly")}</small>
          </span>
          <div className="automation-symbol-chips">
            {draft.symbols.map((symbol) => {
              const asset = marketAssets?.instruments.find((item) => item.instId === symbol);
              // A Profile saved before this restriction can still hold a symbol
              // that is no longer subscribed. Flag it, because the run would
              // silently read stale candles instead of failing loudly.
              const unsubscribed = watchlistSymbols.size > 0 && !watchlistSymbols.has(symbol);
              return (
                <span
                  className={clsx("automation-symbol-chip", unsubscribed && "is-unsubscribed")}
                  key={symbol}
                  title={unsubscribed ? t("automation:profileSymbolNotInWatchlist", { symbol }) : undefined}
                >
                  <SymbolIcon base={asset?.baseCcy || symbolBase(symbol)} iconPath={asset?.iconPath} cached={asset?.iconCached} cacheDir={marketAssets?.cacheDir} />
                  <b>{symbol}</b>
                  <button type="button" title={t("automation:profileRemoveSymbol", { symbol })} aria-label={t("automation:profileRemoveSymbol", { symbol })} onClick={() => onChange({ symbols: draft.symbols.filter((item) => item !== symbol) })}><X size={11} /></button>
                </span>
              );
            })}
            <div className="automation-symbol-add" onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSymbolPickerOpen(false);
            }}>
              <Search size={13} />
              <input
                value={symbolQuery}
                placeholder={t("automation:profileAddSymbol")}
                aria-label={t("automation:profileAddWatchedSymbol")}
                aria-expanded={symbolPickerOpen}
                onFocus={() => setSymbolPickerOpen(true)}
                onChange={(event) => {
                  setSymbolQuery(event.target.value.toUpperCase());
                  setSymbolPickerOpen(true);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setSymbolPickerOpen(false);
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addProfileSymbol(symbolOptions[0]?.instId || symbolQuery);
                  }
                }}
              />
              {symbolPickerOpen && (symbolOptions.length > 0 || symbolQuery.trim()) ? (
                <div className="automation-symbol-options" role="listbox" aria-label={t("automation:profileAvailableSymbols")}>
                  {symbolOptions.map((item) => (
                    <button type="button" role="option" key={item.instId} onMouseDown={(event) => event.preventDefault()} onClick={() => addProfileSymbol(item.instId)}>
                      <SymbolIcon base={item.baseCcy} iconPath={item.iconPath} cached={item.iconCached} cacheDir={marketAssets?.cacheDir} />
                      <span><strong>{item.baseCcy}</strong><small>{item.instId}</small></span>
                    </button>
                  ))}
                  {symbolOptions.length === 0 && symbolQuery.trim() ? <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => addProfileSymbol(symbolQuery)}>{t("automation:profileAddNamedSymbol", { symbol: symbolQuery.trim().toUpperCase() })}</button> : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
        </div>
      </div>

      <ProfileCollaborationEditor
        mode={draft.multiAgentMode}
        maxAgents={draft.multiAgentMaxAgents}
        agents={draft.multiAgents}
        schemes={agentSchemes}
        selectedSchemeId={draft.multiAgentSchemeId}
        schemeBusy={schemeBusy}
        onChange={onChange}
        onSaveScheme={onSaveScheme}
        onDeleteScheme={onDeleteScheme}
      />

      <div className="automation-form-section">
        <strong><Gauge size={13} />{t("automation:profileBackgroundLimits")}</strong>
        <div className="automation-limit-grid">
          <label><FieldLabel help={t("automation:profileLimitSilenceHelp")}>{t("automation:profileLimitSilence")}</FieldLabel><input type="number" min="1" max="1440" value={draft.scanIntervalMinutes} onChange={(event) => updateNumber("scanIntervalMinutes", event.target.value, 1, 1440)} /></label>
          <label><FieldLabel help={t("automation:profileLimitHistoryHelp")}>{t("automation:profileLimitHistory")}</FieldLabel><input type="number" min="1" max="365" value={draft.historyLookbackDays} onChange={(event) => updateNumber("historyLookbackDays", event.target.value, 1, 365)} /></label>
          <label><FieldLabel help={t("automation:profileLimitSimilarityHelp")}>{t("automation:profileLimitSimilarity")}</FieldLabel><input type="number" min="1" max="1440" value={draft.similarityWindowMinutes} onChange={(event) => updateNumber("similarityWindowMinutes", event.target.value, 1, 1440)} /></label>
          <label><FieldLabel help={t("automation:profileLimitEntryToleranceHelp")}>{t("automation:profileLimitEntryTolerance")}</FieldLabel><input type="number" min="1" max="2000" value={draft.entryToleranceBps} onChange={(event) => updateNumber("entryToleranceBps", event.target.value, 1, 2000)} /></label>
          <label><FieldLabel help={t("automation:profileLimitLeverageHelp")}>{t("automation:profileLimitLeverage")}</FieldLabel><input type="number" min="1" max="125" value={draft.targetLeverage} onChange={(event) => updateNumber("targetLeverage", event.target.value, 1, 125)} /></label>
          <label><FieldLabel help={t("automation:profileLimitTradeMarginHelp")}>{t("automation:profileLimitTradeMargin")}</FieldLabel><input type="number" min="1" max="100" value={draft.maxSingleTradeMarginPct} onChange={(event) => updateNumber("maxSingleTradeMarginPct", event.target.value, 1, 100)} /></label>
          <label><FieldLabel help={t("automation:profileLimitWakeIntervalHelp")}>{t("automation:profileLimitWakeInterval")}</FieldLabel><input type="number" min="30" max="86400" value={draft.minWakeIntervalSeconds} onChange={(event) => updateNumber("minWakeIntervalSeconds", event.target.value, 30, 86400)} /></label>
          <label><FieldLabel help={t("automation:profileLimitRunsPerHourHelp")}>{t("automation:profileLimitRunsPerHour")}</FieldLabel><input type="number" min="1" max="60" value={draft.maxRunsPerHour} onChange={(event) => updateNumber("maxRunsPerHour", event.target.value, 1, 60)} /></label>
        </div>
      </div>

      <div className="automation-form-section">
        <strong><ShieldCheck size={13} />{t("automation:profileSkillsTitle")}</strong>
        <div className="automation-section-headline">
          <p className="automation-field-note">{t("automation:profileSkillsVersionNote")}</p>
          <button type="button" onClick={() => openSettingsTab("skills")}><Pencil size={13} />{t("automation:profileSkillsEdit")}</button>
        </div>
        <div className="automation-skill-grid">
          {skills.length === 0 ? (
            <span className="automation-inline-empty">{t("automation:profileSkillsEmpty")}</span>
          ) : skills.map((skill) => {
            const required = REQUIRED_PROFILE_SKILL_ID_SET.has(skill.id);
            return (
              <label
                className={clsx("automation-skill-option", skillIds.has(skill.id) && "selected", required && "required")}
                title={required ? t("automation:profileSkillsRequiredHelp") : undefined}
                key={skill.id}
              >
                <input
                  type="checkbox"
                  checked={skillIds.has(skill.id)}
                  disabled={required}
                  onChange={(event) => toggleSkill(skill.id, event.target.checked)}
                />
                <span><strong>{skill.name || skill.id}</strong><small>{skill.description || t("automation:profileSkillsFallbackDescription")}</small></span>
                <em>{required ? t("automation:profileSkillsRequired") : skill.builtin ? t("automation:profileSkillsBuiltin") : t("automation:profileSkillsCustom")}</em>
              </label>
            );
          })}
        </div>
        {selectedSkills.length > 0 ? (
          <div className="automation-skill-version-list">
            {selectedSkills.map((skill) => {
              const versions = publishedVersions.get(skill.id) ?? [];
              const pinned = draft.skillVersionModes?.[skill.id] === "pinned" ? draft.skillVersions?.[skill.id] : undefined;
              const pinnedAvailable = pinned ? versions.some((item) => item.version === pinned) : true;
              return (
                <div className="automation-skill-version-row" key={skill.id}>
                  <span><strong>{skill.name || skill.id}</strong><small>{pinned ? t("automation:profileSkillsPinnedVersion", { version: pinned }) : t("automation:profileSkillsFollowLatest")}</small></span>
                  <label>
                    <span>{t("automation:profileSkillsPublishedVersion")}</span>
                    <TerminalSelect
                      ariaLabel={t("automation:profileSkillsPublishedVersionAria", { skill: skill.name || skill.id })}
                      value={pinned ? String(pinned) : ""}
                      options={[
                        { value: "", label: t("automation:profileSkillsLatestAuto") },
                        ...(pinned && !pinnedAvailable ? [{ value: String(pinned), label: t("automation:profileSkillsUnavailableVersion", { version: pinned }), disabled: true }] : []),
                        ...versions.map((version) => ({ value: String(version.version), label: `v${version.version}` }))
                      ]}
                      onChange={(value) => updateSkillVersion(skill.id, value)}
                    />
                  </label>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="automation-form-section automation-delivery-section">
        <strong><Bell size={13} />{t("automation:profileDeliveryTitle")}</strong>
        <div className="automation-delivery-grid">
          <label className="automation-setting-row">
            <span><strong>{t("automation:profileDeliveryDailyReview")}</strong><small>{t("automation:profileDeliveryDailyReviewHelp")}</small></span>
            <input type="checkbox" checked={draft.dailyReviewEnabled} onChange={(event) => onChange({ dailyReviewEnabled: event.target.checked })} />
          </label>
          <label className="automation-setting-row">
            <span><strong>{t("automation:profileDeliveryFeishu")}</strong><small>{t("automation:profileDeliveryFeishuHelp")}</small></span>
            <input type="checkbox" checked={draft.feishuEnabled} onChange={(event) => onChange({ feishuEnabled: event.target.checked })} />
          </label>
        </div>
        <div className="automation-section-actions">
          <button type="button" onClick={onDailyReview} disabled={busy || !draft.enabled}><History size={13} />{t("automation:profileDeliveryRunReview")}</button>
          <button type="button" onClick={() => openSettingsTab("notifications")}><Bell size={13} />{t("automation:profileDeliveryNotificationSettings")}</button>
        </div>
      </div>

      {normalizePermissionMode(draft.mode) === "limited_auto" && boundEnvironment === "live" ? (
        <p className="automation-risk-note">{t("automation:profileLiveAutomationRisk")}</p>
      ) : null}

    </div>
  );
}

function SystematicProfileConflictDialog({
  confirmation,
  onCancel,
  onConfirm
}: {
  confirmation: SystematicProfileConflictConfirmation;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation(["automation", "common"]);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onCancel]);

  return createPortal(
    <div className="modal-backdrop automation-profile-conflict-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="modal-shell automation-profile-conflict-modal" role="dialog" aria-modal="true" aria-labelledby="automation-profile-conflict-title">
        <header className="modal-head">
          <div>
            <strong id="automation-profile-conflict-title">{t("automation:profileStrategyConflictTitle")}</strong>
            <span>{confirmation.profile.name}</span>
          </div>
          <button ref={closeButtonRef} className="window-button" type="button" onClick={onCancel} title={t("common:close")}><X size={16} /></button>
        </header>
        <div className="automation-profile-conflict-body">
          <span className="automation-profile-conflict-icon"><AlertTriangle size={18} /></span>
          <p>{t("automation:profileStrategyConflictDetail")}</p>
          <ul>
            {confirmation.conflicts.map((conflict) => <li key={conflict.id}><strong>{conflict.name}</strong><span>{conflict.instId}</span></li>)}
          </ul>
        </div>
        <footer className="automation-profile-conflict-actions">
          <button type="button" onClick={onCancel}>{t("common:cancel")}</button>
          <button type="button" className="danger" onClick={onConfirm}>{t("automation:profileStrategyConflictConfirm")}</button>
        </footer>
      </section>
    </div>,
    document.body
  );
}

type RunToolStep = {
  id: string;
  name: string;
  arguments: unknown;
  allowed: boolean;
  blocked: boolean;
  policy?: string;
  result?: unknown;
  resultSummary?: string;
  ok?: boolean;
};

type RunActionKind = "opportunity" | "wake" | "trade";
type ExtendedRunActionKind = RunActionKind | "notification";

const RUN_DETAIL_TRADE_TOOLS = new Set([
  "trade.placeOrder",
  "trade.cancelOrder",
  "trade.amendOrder",
  "trade.closePosition",
  "trade.setLeverage",
  "trade.setMarginMode",
  "order.create",
  "order.cancel",
  "okx.placeOrder",
  "okx.cancelOrder",
  "okx.amendOrder",
  "okx.closePosition",
  "okx.setLeverage",
  "okx.setMarginMode"
]);

const RUN_DETAIL_NOTIFICATION_TOOLS = new Set([
  "notification.feishu.send"
]);

function openSettingsTab(tab: "ai" | "skills" | "notifications") {
  window.dispatchEvent(new CustomEvent("desic:open-settings", { detail: { tab } }));
}

function openTradeOpportunity(id: string) {
  window.dispatchEvent(new CustomEvent("desic:open-trade-opportunity", { detail: { id } }));
}

const RUN_LIST_LIMIT = 50;
const RUN_TIME_FILTERS = [
  { id: "today" },
  { id: "yesterday" },
  { id: "7d" },
  { id: "30d" },
  { id: "all" }
] as const;
const RUN_KIND_FILTERS = [
  { id: "all" },
  { id: "opportunity" },
  { id: "notification" },
  { id: "abnormal" },
  { id: "manual" },
  { id: "auto" }
] as const;
type RunTimeFilter = (typeof RUN_TIME_FILTERS)[number]["id"];
type RunKindFilter = (typeof RUN_KIND_FILTERS)[number]["id"];

function shanghaiDayStart(value: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: AUTOMATION_DISPLAY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(value));
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return 0;
  return Date.UTC(year, month - 1, day) - 8 * 60 * 60_000;
}

function runTimeRange(filter: RunTimeFilter, now = Date.now()) {
  if (filter === "all") return null;
  const day = 24 * 60 * 60_000;
  const todayStart = shanghaiDayStart(now);
  if (filter === "today") return { start: todayStart, end: todayStart + day };
  if (filter === "yesterday") return { start: todayStart - day, end: todayStart };
  if (filter === "7d") return { start: todayStart - 6 * day, end: todayStart + day };
  return { start: todayStart - 29 * day, end: todayStart + day };
}

function compactRunSummary(run: AiAutomationRun) {
  if (run.error) return run.error;
  const summary = normalizeRunMarkdown(run.summary ?? "")
    .replace(/[#*_`>]/g, "")
    .split(/\n+/)
    .map((line) => line.replace(/^\s*[-•]\s*/, "").trim())
    .filter(Boolean)
    .join(" · ");
  return summary || automationText("runNoSummary", "No run summary", "暂无运行摘要");
}

function estimatedOpportunityCount(run: AiAutomationRun) {
  const text = `${run.summary ?? ""} ${run.error ?? ""}`;
  if (!text.trim()) return 0;
  if (/(没有|未|无需|不需要).{0,8}(创建|新建)?交易机会/.test(text)) return 0;
  const matches = Array.from(text.matchAll(/(\d+)\s*(?:个|条)?\s*(?:新)?交易机会/g));
  if (matches.length > 0) {
    return matches.reduce((total, match) => total + Math.max(0, Number(match[1]) || 0), 0);
  }
  return /(创建|新建|产生|保存).{0,8}交易机会/.test(text) ? 1 : 0;
}

function runActionCounts(
  run: AiAutomationRun,
  detail: AiAutomationRunDetail | undefined,
  deliveries: AiNotificationDelivery[]
) {
  const summaryCounts = run.actionCounts;
  if (detail) {
    const steps = buildRunToolSteps(detail.toolEvents);
    return {
      opportunity: Math.max(summaryCounts?.opportunity ?? 0, steps.filter((step) => runActionKind(step) === "opportunity").length),
      wake: Math.max(summaryCounts?.wake ?? 0, steps.reduce((total, step) => total + (runActionKind(step) === "wake" ? wakeConditionsFromStep(step).length : 0), 0)),
      trade: Math.max(summaryCounts?.trade ?? 0, steps.filter((step) => runActionKind(step) === "trade").length),
      notification: Math.max(summaryCounts?.notification ?? 0, steps.filter((step) => runActionKind(step) === "notification").length, deliveries.filter((item) => item.runId === run.id).length)
    };
  }
  return {
    opportunity: summaryCounts?.opportunity ?? estimatedOpportunityCount(run),
    wake: summaryCounts?.wake ?? 0,
    trade: summaryCounts?.trade ?? 0,
    notification: Math.max(summaryCounts?.notification ?? 0, deliveries.filter((item) => item.runId === run.id).length)
  };
}

function isRunAbnormal(run: AiAutomationRun) {
  return Boolean(run.error) || ["failed", "cancelled", "canceled"].includes(run.status);
}

function runMatchesKindFilter(run: AiAutomationRun, filter: RunKindFilter, counts: ReturnType<typeof runActionCounts>) {
  if (filter === "all") return true;
  if (filter === "opportunity") return counts.opportunity > 0;
  if (filter === "notification") return counts.notification > 0;
  if (filter === "abnormal") return isRunAbnormal(run);
  if (filter === "manual") return run.triggerType === "manual";
  return run.triggerType === "schedule" || run.triggerType === "wake_condition";
}

function profileUsesSkill(profile: AiAgentProfile | undefined, skillId?: string | null) {
  if (!profile || !skillId) return false;
  return profile.skillIds.includes(skillId) || Object.prototype.hasOwnProperty.call(profile.skillVersions ?? {}, skillId);
}

function formatRunTokenCount(value: number | undefined) {
  const tokens = Math.max(0, Number(value) || 0);
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 1 : 2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}K`;
  return formatLocalizedNumber(Math.round(tokens));
}

function runTokenSummary(run: AiAutomationRun) {
  const summary = run.tokenUsage;
  if (!summary) return null;
  if (!summary.reported) return automationText("runTokensNotReported", "Token usage not reported", "Token 未报告");
  return automationText("runTokenSummary", "Token {{total}} · {{input}} in / {{output}} out", "Token {{total}} · {{input}} 入 / {{output}} 出", {
    total: formatRunTokenCount(summary.usage.totalTokens),
    input: formatRunTokenCount(summary.usage.inputTokens),
    output: formatRunTokenCount(summary.usage.outputTokens)
  });
}

function runTimeFilterLabel(filter: RunTimeFilter) {
  const labels: Record<RunTimeFilter, string> = {
    today: i18n.t("common:today"),
    yesterday: i18n.t("common:yesterday"),
    "7d": automationText("runLast7Days", "Last 7 days", "最近 7 天"),
    "30d": automationText("runLast30Days", "Last 30 days", "最近 30 天"),
    all: i18n.t("common:all")
  };
  return labels[filter];
}

function runKindFilterLabel(filter: RunKindFilter) {
  const labels: Record<RunKindFilter, string> = {
    all: i18n.t("common:all"),
    opportunity: automationText("runWithOpportunity", "Has trade opportunity", "有交易机会"),
    notification: automationText("runWithNotification", "Has notification", "有通知"),
    abnormal: automationText("runAbnormal", "Abnormal", "异常"),
    manual: automationText("runManual", "Manual run", "手动运行"),
    auto: automationText("runAutomatic", "Automatic run", "自动运行")
  };
  return labels[filter];
}

function RunsView({
  items,
  profiles,
  deliveries,
  focusId,
  readDetail = readAutomationRunDetail
}: {
  items: AiAutomationRun[];
  profiles: Map<string, AiAgentProfile>;
  deliveries: AiNotificationDelivery[];
  focusId?: string | null;
  readDetail?: (id: string) => Promise<AiAutomationRunDetail | null>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(focusId ?? null);
  const [details, setDetails] = useState<Record<string, AiAutomationRunDetail>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const [timeFilter, setTimeFilter] = useState<RunTimeFilter>("today");
  const [kindFilter, setKindFilter] = useState<RunKindFilter>("all");
  const [query, setQuery] = useState("");
  const detailRequestVersionsRef = useRef<Record<string, number>>({});
  const closeRun = useCallback(() => setSelectedId(null), []);

  const loadRunDetail = useCallback(async (id: string) => {
    const requestVersion = (detailRequestVersionsRef.current[id] ?? 0) + 1;
    detailRequestVersionsRef.current[id] = requestVersion;
    setLoadingId(id);
    setDetailErrors((current) => ({ ...current, [id]: "" }));
    try {
      const detail = await readDetail(id);
      if (!detail) throw new Error(automationText("runDetailMissing", "The run detail does not exist or has been cleaned up.", "运行详情不存在或已经被清理。"));
      if (detailRequestVersionsRef.current[id] !== requestVersion) return;
      setDetails((current) => ({ ...current, [id]: detail }));
    } catch (error) {
      if (detailRequestVersionsRef.current[id] !== requestVersion) return;
      setDetailErrors((current) => ({ ...current, [id]: error instanceof Error ? error.message : String(error) }));
    } finally {
      if (detailRequestVersionsRef.current[id] === requestVersion) {
        setLoadingId((current) => current === id ? null : current);
      }
    }
  }, [readDetail]);

  const openRun = useCallback((id: string) => {
    setSelectedId(id);
    void loadRunDetail(id);
  }, [loadRunDetail]);

  useEffect(() => {
    if (focusId) void openRun(focusId);
  }, [focusId, openRun]);

  const sortedItems = useMemo(() => [...items].sort((a, b) => b.startedAt - a.startedAt), [items]);
  const runCounts = useMemo(() => new Map(sortedItems.map((run) => [run.id, runActionCounts(run, details[run.id], deliveries)])), [deliveries, details, sortedItems]);
  const filteredItems = useMemo(() => {
    const range = runTimeRange(timeFilter);
    const normalizedQuery = query.trim().toLowerCase();
    return sortedItems.filter((run) => {
      if (range && (run.startedAt < range.start || run.startedAt >= range.end)) return false;
      const counts = runCounts.get(run.id) ?? runActionCounts(run, details[run.id], deliveries);
      if (!runMatchesKindFilter(run, kindFilter, counts)) return false;
      if (normalizedQuery) {
        const profileName = profiles.get(run.profileId)?.name ?? run.profileId;
        const haystack = `${profileName} ${run.id} ${run.triggerType} ${run.status} ${run.summary ?? ""} ${run.error ?? ""}`.toLowerCase();
        if (!haystack.includes(normalizedQuery)) return false;
      }
      return true;
    });
  }, [deliveries, details, kindFilter, profiles, query, runCounts, sortedItems, timeFilter]);
  const limitedItems = filteredItems.slice(0, RUN_LIST_LIMIT);
  const stats = useMemo(() => filteredItems.reduce((acc, run) => {
    const counts = runCounts.get(run.id) ?? runActionCounts(run, details[run.id], deliveries);
    acc.total += 1;
    if (run.status === "completed") acc.success += 1;
    if (isRunAbnormal(run)) acc.abnormal += 1;
    acc.opportunities += counts.opportunity;
    acc.notifications += counts.notification;
    return acc;
  }, { total: 0, success: 0, abnormal: 0, opportunities: 0, notifications: 0 }), [deliveries, details, filteredItems, runCounts]);
  const emptyTitle = items.length === 0
    ? automationText("runEmpty", "No runs", "暂无运行记录")
    : timeFilter === "today" && kindFilter === "all" && !query.trim()
      ? automationText("runEmptyToday", "No runs today", "今天还没有运行记录")
      : automationText("runNoFilterMatches", "No runs match the current filters", "当前筛选没有命中");
  const emptyDetail = items.length === 0
    ? automationText("runEmptyDetail", "Profile wake-ups and manual runs record their status, summary, and errors here.", "Profile 被唤醒或手动运行后，会在这里记录状态、摘要与错误。")
    : timeFilter === "today" && kindFilter === "all" && !query.trim()
      ? automationText("runEmptyTodayDetail", "Run a Profile manually or wait until its maximum silence period expires.", "可手动运行 Profile，或等待最长静默时间到期。")
      : automationText("runNoFilterMatchesDetail", "Expand the time range, change the status filter, or clear the search.", "尝试扩大时间范围、切换状态筛选或清空搜索。");
  const selectedRun = items.find((item) => item.id === selectedId) ?? null;
  const selectedDetail = selectedRun ? details[selectedRun.id] : undefined;

  useEffect(() => {
    if (!selectedRun || !selectedDetail || loadingId === selectedRun.id) return;
    if (selectedDetail.run.status === selectedRun.status
      && (selectedDetail.run.finishedAt ?? null) === (selectedRun.finishedAt ?? null)) return;
    void loadRunDetail(selectedRun.id);
  }, [loadRunDetail, loadingId, selectedDetail, selectedRun]);

  return (
    <div className="automation-runs-view">
      <div className="automation-run-audit-head">
        <div className="automation-run-stat-strip">
          <div><span>{automationText("runCurrentRange", "Current range", "当前范围")}</span><strong>{stats.total}</strong><small>{i18n.t("automation:runs")}</small></div>
          <div><span>{i18n.t("common:success")}</span><strong>{stats.success}</strong><small>completed</small></div>
          <div className={stats.abnormal > 0 ? "danger" : ""}><span>{automationText("runAbnormal", "Abnormal", "异常")}</span><strong>{stats.abnormal}</strong><small>failed / cancelled</small></div>
          <div><span>{automationText("runTradeOpportunities", "Trade opportunities", "交易机会")}</span><strong>{stats.opportunities}</strong><small>{automationText("runEstimatedLoaded", "estimated / loaded", "估算 / 已载入")}</small></div>
          <div><span>{automationText("runFeishuNotifications", "Feishu notifications", "飞书通知")}</span><strong>{stats.notifications}</strong><small>{automationText("runDeliveryRecords", "delivery records", "投递记录")}</small></div>
          <div><span>{automationText("runShown", "Shown", "显示")}</span><strong>{Math.min(filteredItems.length, RUN_LIST_LIMIT)}</strong><small>/ {filteredItems.length}</small></div>
        </div>
        <div className="automation-run-filter-panel">
          <div className="automation-run-filter-row">
            <div className="automation-segmented" role="tablist" aria-label={automationText("runTimeRangeAria", "Run time range", "运行记录时间范围")}>
              {RUN_TIME_FILTERS.map((item) => (
                <button type="button" key={item.id} className={timeFilter === item.id ? "active" : ""} onClick={() => setTimeFilter(item.id)}>
                  {runTimeFilterLabel(item.id)}
                </button>
              ))}
            </div>
            <div className="automation-run-search">
              <Search size={13} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={automationText("runSearchPlaceholder", "Search Profile, summary, error, or Run ID", "搜索 Profile、摘要、错误或 Run ID")} />
            </div>
          </div>
          <div className="automation-run-filter-row secondary">
            <div className="automation-segmented compact" role="tablist" aria-label={automationText("runKindFilterAria", "Run type filter", "运行记录状态筛选")}>
              {RUN_KIND_FILTERS.map((item) => (
                <button type="button" key={item.id} className={kindFilter === item.id ? "active" : ""} onClick={() => setKindFilter(item.id)}>
                  {runKindFilterLabel(item.id)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="automation-list automation-run-list">
        {limitedItems.length === 0 ? <SectionState icon={<Activity size={22} />} title={emptyTitle} detail={emptyDetail} /> : limitedItems.map((item) => {
          const counts = runCounts.get(item.id) ?? runActionCounts(item, details[item.id], deliveries);
          const duration = item.finishedAt ? Math.max(0, item.finishedAt - item.startedAt) : null;
          const hasOpportunity = counts.opportunity > 0;
          const abnormal = isRunAbnormal(item);
          return (
          <article className={clsx("automation-list-row automation-run-row", focusId === item.id && "focused", selectedId === item.id && "selected", hasOpportunity && "has-opportunity", abnormal && "abnormal")} key={item.id}>
            <button
              type="button"
              className="automation-run-toggle"
              aria-haspopup="dialog"
              onClick={() => void openRun(item.id)}
            >
              <div className="automation-row-main">
                <div className="automation-run-title-line">
                  <span className={clsx("automation-run-state-dot", runStatusTone(item.status))} />
                  <strong>{profiles.get(item.profileId)?.name ?? item.profileId}</strong>
                  <StatusBadge status={item.status} />
                  <em>{runTriggerLabel(item.triggerType)}</em>
                </div>
                <p className={clsx("automation-run-plain-summary", abnormal && "error")} data-i18n-skip>{compactRunSummary(item)}</p>
                <div className="automation-run-action-chips">
                  <span className={counts.opportunity > 0 ? "active" : ""}>{automationText("runTradeOpportunities", "Trade opportunities", "交易机会")} {counts.opportunity}</span>
                  <span className={counts.wake > 0 ? "active" : ""}>{automationText("runWatchConditions", "Watch conditions", "观察条件")} {counts.wake}</span>
                  <span className={counts.notification > 0 ? "active" : ""}>{automationText("runFeishuNotifications", "Feishu notifications", "飞书通知")} {counts.notification}</span>
                  <span className={counts.trade > 0 ? "active" : ""}>{automationText("runTradeActions", "Trade actions", "交易动作")} {counts.trade}</span>
                </div>
              </div>
              <div className="automation-row-meta automation-run-meta">
                <span>{automationText("runStartedAt", "Started {{time}}", "开始 {{time}}", { time: formatDateTime(item.startedAt) })}</span>
                <span>{duration === null ? i18n.t("automation:running") : automationText("runDuration", "Duration {{duration}}", "耗时 {{duration}}", { duration: formatDuration(duration) })}</span>
                <span>{item.finishedAt ? automationText("runFinishedAt", "Finished {{time}}", "结束 {{time}}", { time: formatDateTime(item.finishedAt) }) : item.nextWakeAt ? automationText("runNextAt", "Next {{time}}", "下次 {{time}}", { time: formatDateTime(item.nextWakeAt) }) : automationText("runWaitingUpdate", "Waiting for update", "等待更新")}</span>
                {runTokenSummary(item) ? <span className={clsx("automation-run-token-meta", item.tokenUsage?.reported && "reported")}>{runTokenSummary(item)}</span> : null}
              </div>
              <ChevronDown className="detail-chevron" size={15} />
            </button>
          </article>
          );
        })}
      </div>
      {selectedRun ? (
        <RunDetailDialog
          run={selectedRun}
          profileName={profiles.get(selectedRun.profileId)?.name ?? selectedRun.profileId}
          detail={selectedDetail}
          loading={loadingId === selectedRun.id}
          error={detailErrors[selectedRun.id]}
          onClose={closeRun}
        />
      ) : null}
    </div>
  );
}

function readAutomationRunDetail(id: string) {
  return invokeDesktop<AiAutomationRunDetail>("ai_automation_run_detail", { id });
}

function RunDetailDialog({
  run,
  profileName,
  detail,
  loading,
  error,
  onClose
}: {
  run: AiAutomationRun;
  profileName: string;
  detail?: AiAutomationRunDetail;
  loading: boolean;
  error?: string;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogDrag = useDraggableSurface<HTMLElement>();
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return createPortal(
    <div className="modal-backdrop automation-run-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogDrag.surfaceRef} className="modal-shell automation-run-modal" role="dialog" aria-modal="true" aria-label={automationText("runDetailAria", "{{profile}} run detail", "{{profile}} 运行详情", { profile: profileName })}>
        <header className="modal-head automation-run-modal-head" {...dialogDrag.handleProps}>
          <div>
            <div><strong>{profileName}</strong><StatusBadge status={run.status} /></div>
            <span>{run.id} · {automationText("runTriggeredBy", "Triggered by {{trigger}}", "{{trigger}}触发", { trigger: runTriggerLabel(run.triggerType) })}</span>
          </div>
          <button ref={closeButtonRef} className="window-button" type="button" onClick={onClose} title={automationText("runCloseDetail", "Close run detail", "关闭运行详情")}><X size={16} /></button>
        </header>
        <div className="automation-run-modal-body">
          {loading ? (
            <div className="automation-run-detail-state"><Loader2 className="spin" size={16} />{automationText("runReadingToolRecords", "Reading tool records", "读取工具记录")}</div>
          ) : error ? (
            <div className="automation-run-detail-state error">{error}</div>
          ) : detail ? (
            <RunDetailPanel detail={detail} />
          ) : null}
        </div>
      </section>
    </div>,
    document.body
  );
}

function RunDetailPanel({ detail }: { detail: AiAutomationRunDetail }) {
  const steps = useMemo(() => buildRunToolSteps(detail.toolEvents), [detail.toolEvents]);
  const duration = detail.run.finishedAt ? Math.max(0, detail.run.finishedAt - detail.run.startedAt) : null;
  const opportunityCount = steps.filter((step) => runActionKind(step) === "opportunity").length;
  const wakeCount = steps.reduce((total, step) => total + (runActionKind(step) === "wake" ? wakeConditionsFromStep(step).length : 0), 0);
  const tradeCount = steps.filter((step) => runActionKind(step) === "trade").length;
  const notificationCount = steps.filter((step) => runActionKind(step) === "notification").length;
  const skills = isRecord(detail.skillVersions) ? Object.entries(detail.skillVersions) : [];
  const decisionTrace = useMemo(() => latestDecisionContextTrace(detail.toolEvents), [detail.toolEvents]);
  const finalDecision = isRecord(detail.finalDecision) ? detail.finalDecision : null;
  const reviewedDecisionTrace = decisionTrace && validDecisionContextResult(decisionTrace.result) ? decisionTrace : null;
  const runError = useMemo(
    () => resolveAiAutomationRunError(detail.run.error, detail.toolEvents),
    [detail.run.error, detail.toolEvents]
  );
  return (
    <div className="automation-run-detail">
      <section className={clsx("automation-run-outcome", runStatusTone(detail.run.status))}>
        <div className="automation-run-outcome-main">
          <span className="automation-run-outcome-icon">{detail.run.status === "completed" ? <CheckCircle2 size={20} /> : <Activity size={20} />}</span>
          <div>
            <span>{automationText("runOutcome", "Run outcome", "本轮运行结果")}</span>
            <strong>{runStatusTitle(detail.run.status)}</strong>
            <p>{steps.length > 0 ? automationText("runOutcomeCounts", "Created {{opportunities}} trade opportunities, {{wakes}} dynamic watch conditions, {{trades}} trade actions, and {{notifications}} Feishu notifications.", "产生 {{opportunities}} 个交易机会、{{wakes}} 条动态观察条件、{{trades}} 个交易动作、{{notifications}} 条飞书通知。", { opportunities: opportunityCount, wakes: wakeCount, trades: tradeCount, notifications: notificationCount }) : automationText("runOutcomeAnalysisOnly", "This run only analyzed and read data; it produced no key actions to execute.", "本轮只进行了分析和数据读取，没有产生需要执行的关键动作。")}</p>
          </div>
        </div>
        <div className="automation-run-outcome-metrics">
          <div><Clock3 size={14} /><span>{automationText("runMetricDuration", "Duration", "耗时")}</span><strong>{duration === null ? i18n.t("automation:running") : formatDuration(duration)}</strong></div>
          <div><RadioTower size={14} /><span>{automationText("runMetricTrigger", "Trigger", "触发")}</span><strong>{formatRunTrigger(detail.run.triggerType, detail.trigger)}</strong></div>
          <div><Activity size={14} /><span>{i18n.t("common:time")}</span><strong>{formatDateTime(detail.run.startedAt)}{detail.run.finishedAt ? ` → ${formatDateTime(detail.run.finishedAt)}` : ""}</strong></div>
          <div><Gauge size={14} /><span>Token</span><strong>{detail.run.tokenUsage?.reported ? formatRunTokenCount(detail.run.tokenUsage.usage.totalTokens) : detail.run.tokenUsage ? automationText("runNotReported", "Not reported", "未报告") : "--"}</strong></div>
        </div>
      </section>

      <div className="automation-run-context-bar">
        <span className="automation-run-id">{detail.run.id}</span>
        <div className="automation-run-skill-chips">
          <span>Skills</span>
          {skills.length > 0 ? skills.map(([name, version]) => <b key={name}>{name} · v{String(version)}</b>) : <em>{automationText("runNoPinnedVersions", "No pinned versions", "未锁定版本")}</em>}
        </div>
        {detail.run.tokenUsage ? (
          <div className="automation-run-token-breakdown">
            <span>{detail.run.tokenUsage.modelName || detail.run.tokenUsage.model}</span>
            {detail.run.tokenUsage.reported ? (
              <>
                <b>{i18n.t("common:input")} {formatRunTokenCount(detail.run.tokenUsage.usage.inputTokens)}</b>
                <b>{i18n.t("common:output")} {formatRunTokenCount(detail.run.tokenUsage.usage.outputTokens)}</b>
                {detail.run.tokenUsage.usage.cacheReadTokens > 0 ? <em>{automationText("runCacheRead", "Cache read {{tokens}}", "缓存读取 {{tokens}}", { tokens: formatRunTokenCount(detail.run.tokenUsage.usage.cacheReadTokens) })}</em> : null}
                {detail.run.tokenUsage.agentCount > 0 ? <em>{automationText("runSubAgents", "{{count}} sub-Agents", "{{count}} 个子 Agent", { count: detail.run.tokenUsage.agentCount })}</em> : null}
              </>
            ) : <em>{automationText("runNoTokenUsage", "The current model did not return Token usage", "当前模型没有返回 Token 用量")}</em>}
          </div>
        ) : null}
      </div>

      {reviewedDecisionTrace ? (
        <section className="automation-run-decision-flow" aria-label={automationText("runCandidateReview", "Trade candidate review", "交易候选复核")}>
          <header><ShieldCheck size={14} /><div><strong>{automationText("runCandidateReview", "Trade candidate review", "交易候选复核")}</strong><span>{automationText("runCandidateReviewDetail", "The Main Agent submits a candidate; the system reads a live snapshot and runs precheck.", "主 Agent 提交候选，系统读取实时快照并执行预检")}</span></div></header>
          <div>
            <span>1</span>
            <small>{automationText("runCandidate", "Trade candidate", "交易候选")}</small>
            <strong>{decisionCandidateLabel(reviewedDecisionTrace.input)}</strong>
          </div>
          <ArrowRightLeft size={14} />
          <div>
            <span>2</span>
            <small>{automationText("runRealtimeReview", "System live review", "系统实时复核")}</small>
            <strong>{decisionContextLabel(reviewedDecisionTrace.result)}</strong>
          </div>
          <ArrowRightLeft size={14} />
          <div>
            <span>3</span>
            <small>{automationText("runResult", "Run result", "本轮结果")}</small>
            <strong>{finalDecision ? finalDecisionLabel(finalDecision) : automationText("runNotSubmitted", "Not submitted", "未提交")}</strong>
          </div>
          {finalDecision && typeof finalDecision.reason === "string" ? <p>{finalDecision.reason}</p> : null}
        </section>
      ) : finalDecision ? (
        <section className={clsx("automation-run-decision-summary", `outcome-${String(finalDecision.outcome || "unknown")}`)} aria-label={automationText("runDecision", "Run decision", "本轮决策")}>
          <div className="automation-run-decision-summary-main"><span><ShieldCheck size={15} /></span><div><small>{automationText("runDecision", "Run decision", "本轮决策")}</small><strong>{finalDecisionLabel(finalDecision)}</strong></div></div>
          <div className="automation-run-decision-summary-review"><small>{automationText("runTradeReview", "Trade review", "交易复核")}</small><strong>{unreviewedDecisionLabel(decisionTrace, finalDecision)}</strong></div>
          {typeof finalDecision.reason === "string" ? <p>{finalDecision.reason}</p> : null}
        </section>
      ) : null}

      <AgentCollaborationTrace events={detail.toolEvents} runStatus={detail.run.status} />

      {detail.run.summary ? (
        <section className="automation-run-section automation-run-summary-section">
          <h3><Crosshair size={14} />{i18n.t("automation:analysisResult")}</h3>
          <div className="automation-run-summary-surface"><div className="automation-run-markdown"><AiMarkdown content={normalizeRunMarkdown(detail.run.summary)} /></div></div>
        </section>
      ) : runError ? <section className="automation-run-section automation-run-summary-section"><h3><Crosshair size={14} />{automationText("runFailureReason", "Failure reason", "失败原因")}</h3><div className="automation-run-summary-surface error" data-i18n-skip>{runError}</div></section> : null}

      <section className="automation-run-section automation-run-actions-section">
        <h3><ArrowRightLeft size={14} />{automationText("runKeyActions", "Key actions", "关键动作")} <span>{i18n.t("common:itemCount", { count: steps.length })}</span></h3>
        {steps.length === 0 ? <div className="automation-run-empty-action"><CheckCircle2 size={18} /><div><strong>{automationText("runNoExternalActions", "No external actions", "没有外部动作")}</strong><span>{automationText("runNoExternalActionsDetail", "Market reads, account queries, and indicator analysis are hidden; this run created no opportunities, dynamic watch conditions, or trades.", "行情读取、账户查询和指标分析已隐藏；本轮没有创建机会、动态观察条件或执行交易。")}</span></div></div> : (
          <div className="automation-tool-timeline">
            {steps.map((step, index) => <RunToolStepRow step={step} index={index} key={step.id} />)}
          </div>
        )}
      </section>

      {detail.reasoning ? (
        <details className="automation-run-collapsible">
          <summary>{automationText("runViewAnalysisProcess", "View analysis process", "查看分析过程")}</summary>
          <div className="automation-run-markdown reasoning"><AiMarkdown content={normalizeRunMarkdown(detail.reasoning)} /></div>
        </details>
      ) : null}
      <details className="automation-run-collapsible">
        <summary>{automationText("runConfigSnapshot", "Run configuration snapshot", "运行配置快照")}</summary>
        <pre>{JSON.stringify(detail.profileSnapshot, null, 2)}</pre>
      </details>
    </div>
  );
}

function latestDecisionContextTrace(events: unknown[]) {
  const records = filterInternalAiToolEvents(events);
  const results = new Map<string, Record<string, unknown>>();
  for (const event of records) {
    if (event.type === "toolResult" && typeof event.toolCallId === "string") results.set(event.toolCallId, event);
  }
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const event = records[index];
    if (event.type !== "toolCall" || event.name !== "market.readDecisionContext") continue;
    const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
    return {
      input: isRecord(event.arguments) ? event.arguments : {},
      result: id && isRecord(results.get(id)?.result) ? results.get(id)!.result as Record<string, unknown> : null
    };
  }
  return null;
}

function decisionCandidateLabel(input: Record<string, unknown>) {
  const candidate = isRecord(input.candidate) ? input.candidate : input;
  const action = formatTradeAction(candidate.intent, candidate.direction, candidate.action);
  return [candidate.instId || input.instId, action, candidate.size ? `${String(candidate.size)} ${i18n.t("trading:contracts")}` : null]
    .filter(Boolean)
    .join(" · ") || automationText("runCandidateParametersFormed", "Candidate parameters formed", "已形成候选参数");
}

function decisionContextLabel(result: Record<string, unknown> | null) {
  if (!result) return automationText("runReviewFailed", "Review failed or returned no result", "复核失败或未返回");
  const age = Number(result.snapshotAgeMs);
  const count = isRecord(result.changes) ? Object.keys(result.changes).length : 0;
  return automationText("runObjectiveChanges", "{{age}} · {{count}} objective changes", "{{age}} · {{count}} 项客观变化", { age: Number.isFinite(age) ? formatDuration(age) : automationText("runJustNow", "Just now", "刚刚"), count });
}

function validDecisionContextResult(result: Record<string, unknown> | null) {
  return Boolean(result && typeof result.decisionContextId === "string" && result.decisionContextId.trim());
}

function unreviewedDecisionLabel(
  trace: ReturnType<typeof latestDecisionContextTrace>,
  decision: Record<string, unknown>
) {
  if (trace) {
    const error = String(trace.result?.error || trace.result?.summary || "");
    return /size|price|参数|候选/i.test(error) ? automationText("runCandidateIncomplete", "Candidate parameters were incomplete; live review did not start", "候选参数不完整，未进入实时复核") : automationText("runRealtimeReviewIncomplete", "Live review did not complete", "实时复核未完成");
  }
  return ["wait", "abandon"].includes(String(decision.outcome || ""))
    ? automationText("runNoCandidateReviewNeeded", "No new trade candidate was formed; no review was needed", "未形成新交易候选，无需复核")
    : automationText("runNoSavedReviewTrace", "The historical record has no saved review trace", "历史记录未保存复核轨迹");
}

function finalDecisionLabel(decision: Record<string, unknown>) {
  const labels: Record<string, string> = {
    execute: automationText("runDecisionExecute", "Execute candidate", "执行候选方案"),
    revise: automationText("runDecisionRevise", "Revise and execute", "修改后执行"),
    wait: automationText("runDecisionWait", "Wait and observe", "等待观察"),
    abandon: automationText("runDecisionAbandon", "Abandon this run", "放弃本轮")
  };
  return labels[String(decision.outcome || "")] || String(decision.outcome || automationText("runSubmitted", "Submitted", "已提交"));
}

function RunToolStepRow({ step, index }: { step: RunToolStep; index: number }) {
  const kind = runActionKind(step);
  const meta = runActionMeta(kind);
  const opportunityId = kind === "opportunity" ? opportunityIdFromStep(step) : "";
  return (
    <article className={clsx("automation-tool-step", kind, step.ok === false && "failed")}>
      <div className="automation-tool-step-index">{meta.icon}</div>
      <div className="automation-tool-step-main">
        <div>
          <span className="automation-tool-kind">{meta.label} {index + 1}</span>
          <strong>{toolDisplayName(step.name)}</strong>
          <span className={step.ok === false || step.blocked ? "failed" : "success"}>{step.blocked ? automationText("runBlocked", "Blocked", "已阻断") : step.ok === false ? i18n.t("common:failed") : i18n.t("common:completed")}</span>
        </div>
        <p className="automation-tool-step-summary">{toolStepSummary(step)}</p>
        {opportunityId ? (
          <button type="button" className="automation-inline-link" onClick={() => openTradeOpportunity(opportunityId)}>
            {automationText("runOpenOpportunityDetail", "Open trade opportunity detail", "打开交易机会详情")}
          </button>
        ) : null}
        <RunActionPayload step={step} kind={kind} />
        <div className="automation-tool-step-details">
          <details><summary>{automationText("runRawArguments", "Raw arguments", "原始参数")}</summary><pre>{JSON.stringify(step.arguments ?? {}, null, 2)}</pre></details>
          {step.result !== undefined ? <details><summary>{automationText("runRawResult", "Raw result", "原始结果")}</summary><pre>{JSON.stringify(step.result, null, 2)}</pre></details> : null}
        </div>
      </div>
    </article>
  );
}

function RunActionPayload({ step, kind }: { step: RunToolStep; kind: ExtendedRunActionKind }) {
  const input = isRecord(step.arguments) ? step.arguments : {};
  if (kind === "wake") {
    const conditions = wakeConditionsFromStep(step);
    return <div className="automation-run-wake-list">{conditions.map((condition, index) => <div key={`${formatStructured(condition)}-${index}`}><RadioTower size={13} /><span>{formatWakeCondition(condition)}</span></div>)}</div>;
  }
  if (kind === "opportunity") {
    const opportunity = opportunityPayloadFromStep(step);
    return (
      <dl className="automation-run-action-facts">
        <div><dt>{automationText("runMarketAction", "Market / action", "品种 / 动作")}</dt><dd>{String(opportunity.instId || "--")} · {formatTradeAction(opportunity.intent, opportunity.direction, opportunity.action)}</dd></div>
        <div><dt>{automationText("runQuantityLeverage", "Quantity / leverage", "数量 / 杠杆")}</dt><dd>{String(opportunity.size || "--")} {i18n.t("trading:contracts")} · {opportunity.lever ? `${String(opportunity.lever)}x` : "--"}</dd></div>
        <div className="wide"><dt>{automationText("runEntryCondition", "Entry condition", "入场条件")}</dt><dd data-i18n-skip>{String(opportunity.entryCondition || opportunity.price || "--")}</dd></div>
        <div className="wide"><dt>{automationText("runDecisionReason", "Decision rationale", "决策理由")}</dt><dd data-i18n-skip>{String(opportunity.reason || "--")}</dd></div>
      </dl>
    );
  }
  if (kind === "notification") {
    return (
      <dl className="automation-run-action-facts">
        <div><dt>{automationText("runNotificationChannel", "Notification channel", "通知渠道")}</dt><dd>{automationText("runFeishu", "Feishu", "飞书")}</dd></div>
        <div><dt>{automationText("runLevel", "Level", "级别")}</dt><dd>{String(input.level || "info")}</dd></div>
        <div className="wide"><dt>{automationText("runTitle", "Title", "标题")}</dt><dd data-i18n-skip>{String(input.title || "--")}</dd></div>
        <div className="wide"><dt>{automationText("runMessageContent", "Message content", "消息内容")}</dt><dd data-i18n-skip>{String(input.content || "--")}</dd></div>
      </dl>
    );
  }
  return (
    <dl className="automation-run-action-facts">
      <div><dt>{automationText("runTradingMarket", "Trading market", "交易品种")}</dt><dd>{String(input.instId || "--")}</dd></div>
      <div><dt>{automationText("runOrderAction", "Order action", "订单动作")}</dt><dd>{toolDisplayName(step.name)}</dd></div>
      <div><dt>{automationText("runQuantityPrice", "Quantity / price", "数量 / 价格")}</dt><dd>{String(input.size || "--")} · {String(input.price || input.newPrice || i18n.t("trading:market"))}</dd></div>
      <div><dt>{automationText("runRelatedOpportunity", "Related opportunity", "关联机会")}</dt><dd>{String(input.opportunityId || automationText("runNotLinked", "Not linked", "未关联"))}</dd></div>
      <div className="wide"><dt>{automationText("runExecutionReason", "Execution reason", "执行原因")}</dt><dd data-i18n-skip>{String(input.reason || "--")}</dd></div>
    </dl>
  );
}

function buildRunToolSteps(events: unknown[]): RunToolStep[] {
  const records = filterInternalAiToolEvents(events);
  const results = new Map<string, Record<string, unknown>>();
  for (const event of records) {
    if (event.type === "toolResult" && typeof event.toolCallId === "string") results.set(event.toolCallId, event);
  }
  return records.flatMap((event, index) => {
    if (event.type !== "toolCall" || typeof event.name !== "string") return [];
    const id = typeof event.toolCallId === "string" ? event.toolCallId : `${event.name}-${index}`;
    const result = results.get(id);
    const step: RunToolStep = {
      id,
      name: event.name,
      arguments: event.arguments,
      allowed: event.allowed !== false,
      blocked: event.blocked === true,
      policy: typeof event.policy === "string" ? event.policy : undefined,
      result: result?.result,
      resultSummary: typeof result?.summary === "string" ? result.summary : undefined,
      ok: typeof result?.ok === "boolean" ? result.ok : event.blocked !== true
    };
    return isKeyRunTool(step) ? [step] : [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function opportunityPayloadFromStep(step: RunToolStep) {
  const input = isRecord(step.arguments) ? step.arguments : {};
  const result = isRecord(step.result) ? step.result : {};
  return { ...input, ...result };
}

function toolDisplayName(name: string) {
  const labels: Record<string, string> = {
    "background.finishRun": automationText("toolFinishRun", "Create the next dynamic watch plan", "创建下一轮动态观察条件"),
    "tradeOpportunity.create": automationText("toolCreateOpportunity", "Create trade opportunity", "创建交易机会"),
    "notification.feishu.send": automationText("toolSendFeishu", "Send Feishu notification", "发送飞书通知"),
    "trade.placeOrder": automationText("toolPlaceOrder", "Submit order", "提交订单"),
    "trade.cancelOrder": automationText("toolCancelOrder", "Cancel order", "撤销订单"),
    "trade.amendOrder": automationText("toolAmendOrder", "Amend order", "修改订单"),
    "trade.closePosition": i18n.t("trading:closePosition"),
    "trade.setLeverage": automationText("toolSetLeverage", "Adjust leverage", "调整杠杆"),
    "trade.setMarginMode": automationText("toolSetMarginMode", "Adjust margin mode", "调整保证金模式"),
    "order.create": automationText("toolPlaceOrder", "Submit order", "提交订单"),
    "order.cancel": automationText("toolCancelOrder", "Cancel order", "撤销订单"),
    "okx.placeOrder": automationText("toolPlaceOkxOrder", "Submit OKX order", "提交 OKX 订单"),
    "okx.cancelOrder": automationText("toolCancelOkxOrder", "Cancel OKX order", "撤销 OKX 订单"),
    "okx.amendOrder": automationText("toolAmendOkxOrder", "Amend OKX order", "修改 OKX 订单"),
    "okx.closePosition": i18n.t("trading:closePosition"),
    "okx.setLeverage": automationText("toolSetLeverage", "Adjust leverage", "调整杠杆"),
    "okx.setMarginMode": automationText("toolSetMarginMode", "Adjust margin mode", "调整保证金模式")
  };
  return labels[name] ?? name;
}

function toolStepSummary(step: RunToolStep) {
  const input = isRecord(step.arguments) ? step.arguments : {};
  const result = isRecord(step.result) ? step.result : {};
  if (step.name === "background.finishRun") {
    const plan = isRecord(input.nextWakePlan) ? input.nextWakePlan : {};
    const conditions = Array.isArray(plan.conditions) ? plan.conditions.length : 0;
    const created = Array.isArray(result.createdOpportunityIds) ? result.createdOpportunityIds.length : 0;
    const reused = Array.isArray(result.reusedOpportunityIds) ? result.reusedOpportunityIds.length : 0;
    return automationText("runSavedWatchPlan", "Saved {{conditions}} dynamic watch conditions; created {{created}} and reused {{reused}} trade opportunities.", "保存 {{conditions}} 条动态观察条件，创建 {{created}} 个、复用 {{reused}} 个交易机会。", { conditions, created, reused });
  }
  if (step.name === "tradeOpportunity.create") {
    const opportunity = opportunityPayloadFromStep(step);
    return [
      opportunity.instId,
      formatTradeAction(opportunity.intent, opportunity.direction, opportunity.action),
      opportunity.size ? `${opportunity.size} ${i18n.t("trading:contracts")}` : null,
      opportunity.reason
    ].filter(Boolean).join(" · ") || step.resultSummary || automationText("runOpportunitySubmitted", "The trade opportunity operation was submitted.", "交易机会操作已提交。");
  }
  if (step.name === "notification.feishu.send") {
    return [
      automationText("runFeishuNotification", "Feishu notification", "飞书通知"),
      input.title,
      input.level ? String(input.level).toUpperCase() : null
    ].filter(Boolean).join(" · ") || step.resultSummary || automationText("runFeishuSubmitted", "The Feishu notification was submitted.", "飞书通知已提交。");
  }
  return step.resultSummary || [input.instId, input.reason].filter(Boolean).join(" · ") || automationText("runTradeActionSubmitted", "The trade action was submitted.", "交易动作已提交。");
}

function isKeyRunTool(step: RunToolStep) {
  if (step.name === "tradeOpportunity.create") return true;
  if (step.name === "background.finishRun") return wakeConditionsFromStep(step).length > 0;
  if (RUN_DETAIL_NOTIFICATION_TOOLS.has(step.name)) return true;
  return RUN_DETAIL_TRADE_TOOLS.has(step.name);
}

function runActionKind(step: RunToolStep): ExtendedRunActionKind {
  if (step.name === "background.finishRun") return "wake";
  if (step.name === "tradeOpportunity.create") return "opportunity";
  if (RUN_DETAIL_NOTIFICATION_TOOLS.has(step.name)) return "notification";
  return "trade";
}

function runActionMeta(kind: ExtendedRunActionKind) {
  if (kind === "wake") return { label: automationText("runWatchCondition", "Watch condition", "观察条件"), icon: <RadioTower size={13} /> };
  if (kind === "opportunity") return { label: automationText("runTradeOpportunity", "Trade opportunity", "交易机会"), icon: <Crosshair size={13} /> };
  if (kind === "notification") return { label: automationText("runFeishuNotification", "Feishu notification", "飞书通知"), icon: <Bell size={13} /> };
  return { label: automationText("runTradeExecution", "Trade execution", "交易执行"), icon: <ArrowRightLeft size={13} /> };
}

function opportunityIdFromStep(step: RunToolStep) {
  const opportunity = opportunityPayloadFromStep(step);
  return String(opportunity.id || opportunity.opportunityId || "").trim();
}

function wakeConditionsFromStep(step: RunToolStep) {
  const input = isRecord(step.arguments) ? step.arguments : {};
  const plan = isRecord(input.nextWakePlan) ? input.nextWakePlan : {};
  return Array.isArray(plan.conditions) ? plan.conditions.filter(isRecord) : [];
}

function formatWakeCondition(condition: Record<string, unknown>) {
  const type = String(condition.type || "condition");
  const symbol = condition.instId ? `${String(condition.instId)} ` : "";
  if (type === "timer") {
    if (condition.intervalMinutes) return automationText("wakeEveryMinutes", "Reanalyze every {{minutes}} minutes", "每 {{minutes}} 分钟重新分析", { minutes: String(condition.intervalMinutes) });
    if (condition.atMs) return automationText("wakeReanalyzeAt", "Reanalyze at {{time}}", "在 {{time}} 重新分析", { time: formatDateTime(Number(condition.atMs)) });
  }
  if (type === "price_cross") return `${symbol}${formatThresholdDirection(condition.direction)} ${String(condition.price || "--")}`;
  if (type === "price_change_pct") return automationText("wakePriceChangeSummary", "{{symbol}}{{direction}} {{threshold}}% within {{minutes}} minutes", "{{symbol}}{{minutes}} 分钟内{{direction}} {{threshold}}%", { symbol, minutes: String(condition.windowMinutes || "--"), direction: formatThresholdDirection(condition.direction), threshold: String(condition.thresholdPct || "--") });
  if (type === "candle_volume_ratio") return automationText("wakeVolumeSummary", "{{symbol}}{{bar}} volume exceeds the {{lookback}}-candle average by {{ratio}}x", "{{symbol}}{{bar}} 成交量超过最近 {{lookback}} 根均值 {{ratio}} 倍", { symbol, bar: String(condition.bar || "--"), lookback: String(condition.lookback || "--"), ratio: String(condition.ratio || "--") });
  if (type === "funding_rate_threshold") return automationText("wakeFundingSummary", "{{symbol}}funding rate {{direction}} {{rate}}", "{{symbol}}资金费率{{direction}} {{rate}}", { symbol, direction: formatThresholdDirection(condition.direction), rate: String(condition.rate || "--") });
  if (type === "orderbook_imbalance") return automationText("wakeOrderbookSummary", "{{symbol}}{{side}} reaches {{ratio}} across the first {{depth}} levels", "{{symbol}}{{side}}前 {{depth}} 档占比达到 {{ratio}}", { symbol, side: condition.direction === "sell" ? automationText("wakeAskSide", "Ask depth", "卖盘") : automationText("wakeBidSide", "Bid depth", "买盘"), depth: String(condition.depth || "--"), ratio: String(condition.ratio || "--") });
  if ([
    "open_interest_anomaly", "taker_flow_imbalance", "crowding_divergence", "funding_extreme",
    "liquidation_cluster", "important_news_event", "sentiment_reversal", "smart_money_change", "macro_event_window"
  ].includes(type)) return `${symbol || automationText("wakeAllInstrumentsPrefix", "All instruments · ", "全品种 ")}${wakeConditionLabel(type)}`;
  return `${wakeConditionLabel(type)} · ${formatStructured(condition)}`;
}

function wakeConditionIcon(type: string, size = 15) {
  if (type === "timer") return <Clock3 size={size} />;
  if (type === "price_cross") return <Crosshair size={size} />;
  if (type === "price_change_pct") return <Activity size={size} />;
  if (type === "candle_volume_ratio") return <Gauge size={size} />;
  if (type === "funding_rate_threshold") return <Percent size={size} />;
  if (["open_interest_anomaly", "taker_flow_imbalance", "crowding_divergence", "funding_extreme", "liquidation_cluster"].includes(type)) return <Gauge size={size} />;
  if (["important_news_event", "sentiment_reversal", "smart_money_change", "macro_event_window"].includes(type)) return <Activity size={size} />;
  if (type === "position_changed" || type === "episode_closed") return <WalletCards size={size} />;
  if (type === "opportunity_state_changed") return <Lightbulb size={size} />;
  if (type === "order_state_changed") return <ClipboardCheck size={size} />;
  return <ArrowRightLeft size={size} />;
}

function nextPredictableTriggerAt(item: AiWakeCondition) {
  if (item.status !== "active" || item.conditionType !== "timer" || !isRecord(item.config)) return null;
  const atMs = Number(item.config.atMs);
  if (Number.isFinite(atMs) && atMs > 0) return item.expiresAt && atMs > item.expiresAt ? null : atMs;
  const intervalMinutes = Number(item.config.intervalMinutes);
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return null;
  const target = (item.lastTriggeredAt ?? item.createdAt) + intervalMinutes * 60_000;
  return item.expiresAt && target > item.expiresAt ? null : target;
}

function formatWakeCountdown(item: AiWakeCondition, now: number) {
  if (item.expiresAt && item.expiresAt <= now) return automationText("wakeExpired", "Expired", "已到期");
  const target = nextPredictableTriggerAt(item);
  if (target !== null) {
    return formatCountdownTo(target, now);
  }
  if (item.status !== "active") return "--";
  if (item.conditionType === "timer") return automationText("wakeNoScheduleBeforeExpiry", "No schedule before expiry", "到期前无计划");
  if (["order_state_changed", "position_changed", "opportunity_state_changed", "episode_closed"].includes(item.conditionType)) return automationText("wakeWaitingAccountEvent", "Waiting for an account event", "等待账户事件");
  if ([
    "open_interest_anomaly", "taker_flow_imbalance", "crowding_divergence", "funding_extreme",
    "liquidation_cluster", "important_news_event", "sentiment_reversal", "smart_money_change", "macro_event_window"
  ].includes(item.conditionType)) return automationText("wakeWaitingIntelligenceEvent", "Waiting for an intelligence event", "等待情报事件");
  return automationText("wakeLiveMonitoring", "Live monitoring", "实时监控");
}

function formatCountdownTo(target: number, now: number) {
  const remaining = target - now;
  if (remaining <= 0) return automationText("wakeTriggeringSoon", "Triggering soon", "即将触发");
  const totalSeconds = Math.ceil(remaining / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return automationText("wakeCountdownDays", "{{days}}d {{time}}", "{{days}}天 {{time}}", { days, time: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` });
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function profileFallbackWakeAt(profile: AiAgentProfile, runs: AiAutomationRun[]) {
  const activeRun = runs.find((run) => run.profileId === profile.id && ["queued", "running"].includes(run.status));
  if (activeRun) {
    return { profile, status: activeRun.status, target: null };
  }
  const latestRun = runs
    .filter((run) => run.profileId === profile.id)
    .sort((a, b) => Math.max(b.finishedAt ?? 0, b.startedAt) - Math.max(a.finishedAt ?? 0, a.startedAt))[0];
  if (!latestRun) {
    return { profile, status: "due", target: 0 };
  }
  const lastActivity = latestRun.finishedAt ?? latestRun.startedAt;
  const fallbackDue = lastActivity + Math.max(1, profile.scanIntervalMinutes) * 60_000;
  const target = typeof latestRun.nextWakeAt === "number" ? Math.min(latestRun.nextWakeAt, fallbackDue) : fallbackDue;
  return { profile, status: target <= Date.now() ? "due" : "waiting", target };
}

function formatFallbackWakeCountdown(entry: ReturnType<typeof profileFallbackWakeAt> | null, now: number) {
  if (!entry) return automationText("wakeNoEnabledProfile", "No enabled Profile", "无启用 Profile");
  if (entry.status === "queued") return automationText("statusQueued", "Queued", "已排队");
  if (entry.status === "running") return i18n.t("automation:running");
  if (!entry.target || entry.target <= now) return automationText("wakeTriggeringSoon", "Triggering soon", "即将触发");
  return formatCountdownTo(entry.target, now);
}

function wakeConditionTags(item: AiWakeCondition) {
  const config = isRecord(item.config) ? item.config : {};
  return [
    config.instId ? String(config.instId) : null,
    config.intervalMinutes ? automationText("wakeIntervalTag", "Every {{minutes}} min", "间隔 {{minutes}} 分钟", { minutes: String(config.intervalMinutes) }) : null,
    config.direction ? formatThresholdDirection(config.direction) : null,
    config.price ? `${String(config.price)} USDT` : null,
    config.bar ? String(config.bar) : null,
    config.accountId ? automationText("wakeAccountTag", "Account {{account}}", "账户 {{account}}", { account: String(config.accountId) }) : null
  ].filter((value): value is string => Boolean(value));
}

function formatThresholdDirection(value: unknown) {
  const labels: Record<string, string> = {
    up: automationText("directionBreaksAbove", "breaks above", "向上突破"),
    above: automationText("directionAbove", "above", "高于"),
    down: automationText("directionBreaksBelow", "breaks below", "向下跌破"),
    below: automationText("directionBelow", "below", "低于"),
    absolute: automationText("directionAbsoluteChange", "absolute change exceeds", "绝对变化超过")
  };
  return labels[String(value || "")] ?? String(value || automationText("directionReaches", "reaches", "达到"));
}

function formatTradeAction(intent: unknown, direction: unknown, action?: unknown) {
  const normalizedAction = String(action || "");
  const actionLabels: Record<string, string> = {
    long: automationText("tradeGoLong", "Go long", "做多"),
    short: automationText("tradeGoShort", "Go short", "做空"),
    "close-long": automationText("tradeCloseLong", "Close long", "平多"),
    "close-short": automationText("tradeCloseShort", "Close short", "平空")
  };
  if (actionLabels[normalizedAction]) return actionLabels[normalizedAction];

  const normalizedDirection = String(direction || "");
  if (String(intent || "") === "close") {
    if (normalizedDirection === "long") return automationText("tradeCloseLong", "Close long", "平多");
    if (normalizedDirection === "short") return automationText("tradeCloseShort", "Close short", "平空");
    return automationText("tradeClosePosition", "Close position", "平仓");
  }
  if (normalizedDirection === "long") return automationText("tradeGoLong", "Go long", "做多");
  if (normalizedDirection === "short") return automationText("tradeGoShort", "Go short", "做空");
  return normalizedDirection || "--";
}

function runTriggerLabel(value: string) {
  const labels: Record<string, string> = {
    manual: automationText("runTriggerManual", "Manual", "手动"),
    schedule: automationText("runTriggerSchedule", "Scheduled scan", "定时扫描"),
    wake_condition: automationText("runTriggerCondition", "Condition matched", "条件命中"),
    event: automationText("runTriggerEvent", "Event", "事件")
  };
  return labels[value] ?? value;
}

function formatRunTrigger(type: string, trigger: unknown) {
  const data = isRecord(trigger) ? trigger : {};
  if (type === "manual") return automationText("runManualStart", "Started manually", "用户手动启动");
  if (typeof data.dueAt === "number") return `${runTriggerLabel(type)} · ${formatDateTime(data.dueAt)}`;
  return runTriggerLabel(type);
}

function runStatusTone(status: string) {
  if (status === "completed") return "success";
  if (status === "failed" || status === "cancelled") return "danger";
  return "running";
}

function runStatusTitle(status: string) {
  const labels: Record<string, string> = {
    completed: automationText("runAnalysisCompleted", "Analysis completed", "分析已完成"),
    failed: automationText("runFailedTitle", "Run failed", "运行失败"),
    cancelled: automationText("runCancelledTitle", "Run cancelled", "运行已取消"),
    running: automationText("runAgentAnalyzing", "Agent is analyzing", "Agent 正在分析"),
    queued: automationText("runWaiting", "Waiting to run", "等待运行")
  };
  return labels[status] ?? status;
}

function normalizeRunMarkdown(value: string) {
  return value.replace(/\s+(#{1,6}\s+)/g, "\n\n$1").trim();
}

function formatDuration(milliseconds: number) {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return automationText("durationSeconds", "{{seconds}} sec", "{{seconds}} 秒", { seconds });
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder
    ? automationText("durationMinutesSeconds", "{{minutes}} min {{seconds}} sec", "{{minutes}} 分 {{seconds}} 秒", { minutes, seconds: remainder })
    : automationText("durationMinutes", "{{minutes}} min", "{{minutes}} 分钟", { minutes });
}

function WakeStateOptions({ options, selected, onChange }: { options: string[]; selected: string[]; onChange: (states: string[]) => void }) {
  const values = Array.from(new Set([...options, ...selected]));
  return (
    <div className="automation-state-options">
      {values.map((value) => (
        <label className="automation-check" key={value}>
          <input
            type="checkbox"
            checked={selected.includes(value)}
            onChange={(event) => onChange(event.target.checked ? [...selected, value] : selected.filter((item) => item !== value))}
          />
          <span>{value}</span>
        </label>
      ))}
    </div>
  );
}

function UserWakeConditionEditor({
  draft,
  profiles,
  accounts,
  allowedTypes,
  busy,
  onChange,
  onProfileChange,
  onTypeChange,
  onSave,
  onReset
}: {
  draft: UserWakeConditionDraft;
  profiles: AiAgentProfile[];
  accounts: AccountSummary[];
  allowedTypes: WakeConditionType[];
  busy: boolean;
  onChange: (patch: Partial<UserWakeConditionDraft>) => void;
  onProfileChange: (profileId: string) => void;
  onTypeChange: (conditionType: WakeConditionType) => void;
  onSave: () => void;
  onReset: () => void;
}) {
  const profile = profiles.find((item) => item.id === draft.profileId) ?? null;
  const symbols = profile?.symbols ?? [];
  const accountOptions = accounts.filter((account) => {
    if (account.id === draft.accountId) return true;
    if (profile?.accountId) return account.id === profile.accountId;
    return !profile || account.environment === profile.environment;
  });
  const showSymbol = draft.conditionType !== "timer" && draft.conditionType !== "opportunity_state_changed";
  const symbolOptional = ["order_state_changed", "position_changed", "episode_closed"].includes(draft.conditionType);
  const showAccount = ["order_state_changed", "position_changed", "episode_closed"].includes(draft.conditionType);
  const currentTypeAllowed = allowedTypes.includes(draft.conditionType);
  const currentSymbolAllowed = !draft.instId || symbols.includes(draft.instId);
  const selectableTypes = currentTypeAllowed ? allowedTypes : [draft.conditionType, ...allowedTypes];

  return (
    <section className="automation-wake-editor">
      <div className="automation-wake-editor-head">
        <div>
          <strong>{automationText("wakeLegacyConditions", "Legacy user conditions (disabled)", "旧版用户条件（已停用）")}</strong>
          <span>{automationText("wakeLegacyConditionsDetail", "User-authored market conditions are no longer part of the primary workflow. The Agent now generates the next watch plan after every run.", "用户手写行情条件已从主流程移除；当前由 Agent 每轮生成下一轮观察计划。")}</span>
        </div>
        {draft.conditionId ? <span className="automation-source-badge user">{automationText("wakeUserCondition", "User condition", "用户条件")}</span> : null}
      </div>

      <div className="automation-wake-toolbar">
        <div className="automation-wake-type-switch" role="tablist" aria-label={automationText("wakeConditionTypeAria", "Wake condition type", "唤醒条件类型")}>
          {selectableTypes.map((type) => (
            <button
              type="button"
              role="tab"
              aria-selected={draft.conditionType === type}
              className={clsx(draft.conditionType === type && "active", !allowedTypes.includes(type) && "disabled-type")}
              onClick={() => onTypeChange(type)}
              key={type}
            >
              {wakeConditionIcon(type, 14)}
              <span>{wakeConditionLabel(type)}</span>
            </button>
          ))}
        </div>
        <div className="automation-wake-toolbar-fields">
          <label>
          <span>{automationText("wakeConditionCombination", "Condition combination", "条件组合")}</span>
          <TerminalSelect
            ariaLabel={automationText("wakeConditionCombination", "Condition combination", "条件组合")}
            value={draft.planMode}
            options={[
              { value: "any", label: automationText("wakeAnyCondition", "Any condition matches", "任一条件命中") },
              { value: "all", label: automationText("wakeAllConditions", "All conditions match", "全部条件命中") }
            ]}
            onChange={(value) => onChange({ planMode: value as WakePlanMode })}
          />
          </label>
          <label>
          <span>{automationText("wakeExpiryTime", "Expiry time", "到期时间")}</span>
          <input type="datetime-local" value={draft.expiresAt} onChange={(event) => onChange({ expiresAt: event.target.value })} />
          </label>
        </div>
      </div>

      <div className="automation-wake-editor-panels">
        <section className="automation-wake-config-panel">
          <h4>{automationText("wakeConditionDetails", "Condition details", "条件详情")}</h4>
          <div className="automation-form-grid automation-condition-fields">
        {draft.conditionType === "timer" ? (
          <>
            <label>
              <span>{automationText("wakeScheduleMode", "Schedule mode", "定时方式")}</span>
              <TerminalSelect
                ariaLabel={automationText("wakeScheduleMode", "Schedule mode", "定时方式")}
                value={draft.timerMode}
                options={[
                  { value: "interval", label: automationText("wakeRepeatInterval", "Repeat on an interval", "按间隔重复") },
                  { value: "at", label: automationText("wakeSpecificTime", "Specific time", "指定时间") }
                ]}
                onChange={(value) => onChange({ timerMode: value as "interval" | "at" })}
              />
            </label>
            {draft.timerMode === "interval" ? (
              <label><span>{automationText("wakeIntervalMinutesLabel", "Interval / minutes", "间隔 / 分钟")}</span><input type="number" min="1" max="1440" step="1" value={draft.intervalMinutes} onChange={(event) => onChange({ intervalMinutes: event.target.value })} /></label>
            ) : (
              <label><span>{automationText("wakeTime", "Wake-up time", "唤醒时间")}</span><input type="datetime-local" value={draft.atLocal} onChange={(event) => onChange({ atLocal: event.target.value })} /></label>
            )}
          </>
        ) : null}

        {showAccount ? (
          <label>
            <span>{automationText("wakeAccountScope", "Account scope", "账户范围")}</span>
            <TerminalSelect
              ariaLabel={automationText("wakeAccountScope", "Account scope", "账户范围")}
              value={draft.accountId}
              options={[
                { value: "", label: automationText("wakeAllOrProfile", "All / use Profile", "全部 / 沿用 Profile") },
                ...accountOptions.map((account) => ({
                  value: account.id,
                  label: `${account.name} · ${account.environment === "live" ? automationText("environmentLive", "Live", "实盘") : automationText("environmentDemo", "Demo", "模拟盘")}`
                }))
              ]}
              onChange={(value) => onChange({ accountId: value })}
            />
          </label>
        ) : null}

        {showSymbol ? (
          <label>
            <span>{automationText("wakeInstrument", "Trading instrument", "交易品种")}</span>
            <TerminalSelect
              ariaLabel={automationText("wakeInstrument", "Trading instrument", "交易品种")}
              value={draft.instId}
              options={[
                ...(symbolOptional ? [{ value: "", label: automationText("wakeAllInstruments", "All instruments", "全部品种") }] : []),
                ...(!currentSymbolAllowed ? [{ value: draft.instId, label: automationText("wakeRemovedFromProfile", "{{symbol}} (removed from Profile)", "{{symbol}}（Profile 已移除）", { symbol: draft.instId }), disabled: true }] : []),
                ...symbols.map((symbol) => ({ value: symbol, label: symbol }))
              ]}
              onChange={(value) => onChange({ instId: value })}
            />
          </label>
        ) : null}

        {draft.conditionType === "price_cross" ? (
          <>
            <label>
              <span>{automationText("wakeBreakoutDirection", "Breakout direction", "突破方向")}</span>
              <TerminalSelect
                ariaLabel={automationText("wakeBreakoutDirection", "Breakout direction", "突破方向")}
                value={draft.direction}
                options={[
                  { value: "up", label: automationText("directionBreaksAbove", "Breaks above", "向上突破") },
                  { value: "down", label: automationText("directionBreaksBelow", "Breaks below", "向下突破") }
                ]}
                onChange={(value) => onChange({ direction: value })}
              />
            </label>
            <label><span>{automationText("wakeTriggerPrice", "Trigger price", "触发价格")}</span><input type="number" min="0" step="any" value={draft.price} onChange={(event) => onChange({ price: event.target.value })} /></label>
          </>
        ) : null}

        {draft.conditionType === "price_change_pct" ? (
          <>
            <label><span>{automationText("wakeWindowMinutes", "Observation window / minutes", "统计窗口 / 分钟")}</span><input type="number" min="1" max="1440" step="1" value={draft.windowMinutes} onChange={(event) => onChange({ windowMinutes: event.target.value })} /></label>
            <label>
              <span>{automationText("wakeChangeDirection", "Change direction", "涨跌方向")}</span>
              <TerminalSelect
                ariaLabel={automationText("wakeChangeDirection", "Change direction", "涨跌方向")}
                value={draft.direction}
                options={[
                  { value: "up", label: automationText("wakeRisesAbove", "Rises more than", "上涨超过") },
                  { value: "down", label: automationText("wakeFallsBelow", "Falls more than", "下跌超过") },
                  { value: "absolute", label: automationText("wakeAbsoluteMove", "Absolute move exceeds", "绝对波动超过") }
                ]}
                onChange={(value) => onChange({ direction: value })}
              />
            </label>
            <label><span>{automationText("wakeThresholdPercent", "Threshold / %", "阈值 / %")}</span><input type="number" min="0" max="1000" step="0.01" value={draft.thresholdPct} onChange={(event) => onChange({ thresholdPct: event.target.value })} /></label>
          </>
        ) : null}

        {draft.conditionType === "candle_volume_ratio" ? (
          <>
            <label>
              <span>{automationText("wakeCandleInterval", "Candle interval", "K 线周期")}</span>
              <TerminalSelect
                ariaLabel={automationText("wakeCandleInterval", "Candle interval", "K 线周期")}
                value={draft.bar}
                options={["1m", "3m", "5m", "15m", "30m", "1H", "2H", "4H", "6H", "12H", "1D"].map((bar) => ({ value: bar, label: bar }))}
                onChange={(value) => onChange({ bar: value })}
              />
            </label>
            <label><span>{automationText("wakeLookbackCandles", "Lookback candles", "回看 K 线数量")}</span><input type="number" min="1" max="500" step="1" value={draft.lookback} onChange={(event) => onChange({ lookback: event.target.value })} /></label>
            <label><span>{automationText("wakeVolumeRatio", "Volume multiplier", "成交量倍数")}</span><input type="number" min="0" max="100" step="0.1" value={draft.ratio} onChange={(event) => onChange({ ratio: event.target.value })} /></label>
          </>
        ) : null}

        {draft.conditionType === "funding_rate_threshold" ? (
          <>
            <label>
              <span>{automationText("wakeComparisonMode", "Comparison", "比较方式")}</span>
              <TerminalSelect
                ariaLabel={automationText("wakeComparisonMode", "Comparison", "比较方式")}
                value={draft.direction}
                options={[
                  { value: "above", label: automationText("wakeAboveThreshold", "Above threshold", "高于阈值") },
                  { value: "below", label: automationText("wakeBelowThreshold", "Below threshold", "低于阈值") },
                  { value: "absolute", label: automationText("wakeAbsoluteAbove", "Absolute value exceeds", "绝对值超过") }
                ]}
                onChange={(value) => onChange({ direction: value })}
              />
            </label>
            <label><span>{automationText("wakeFundingRate", "Funding rate", "资金费率")}</span><input type="number" min="-1" max="1" step="0.0001" value={draft.rate} onChange={(event) => onChange({ rate: event.target.value })} /></label>
          </>
        ) : null}

        {draft.conditionType === "orderbook_imbalance" ? (
          <>
            <label><span>{automationText("wakeOrderbookDepth", "Order-book depth", "盘口档数")}</span><input type="number" min="1" max="50" step="1" value={draft.depth} onChange={(event) => onChange({ depth: event.target.value })} /></label>
            <label>
              <span>{automationText("wakeImbalanceDirection", "Imbalance direction", "失衡方向")}</span>
              <TerminalSelect
                ariaLabel={automationText("wakeImbalanceDirection", "Imbalance direction", "失衡方向")}
                value={draft.direction}
                options={[
                  { value: "buy", label: automationText("wakeBidDominant", "Bid side dominant", "买盘占优") },
                  { value: "sell", label: automationText("wakeAskDominant", "Ask side dominant", "卖盘占优") }
                ]}
                onChange={(value) => onChange({ direction: value })}
              />
            </label>
            <label><span>{automationText("wakeRatioThreshold", "Ratio threshold", "占比阈值")}</span><input type="number" min="0.01" max="1" step="0.01" value={draft.ratio} onChange={(event) => onChange({ ratio: event.target.value })} /></label>
          </>
        ) : null}

        {draft.conditionType === "opportunity_state_changed" ? (
          <label className="wide"><span>{automationText("wakeOpportunityId", "Trade opportunity ID", "交易机会 ID")}</span><input value={draft.opportunityId} placeholder={automationText("wakeOpportunityIdPlaceholder", "Enter an opportunity ID from this Profile", "输入当前 Profile 范围内的机会 ID")} onChange={(event) => onChange({ opportunityId: event.target.value })} /></label>
        ) : null}

        {draft.conditionType === "order_state_changed" ? (
          <div className="wide automation-state-field"><span>{automationText("wakeOrderStatus", "Order status", "订单状态")}</span><WakeStateOptions options={ORDER_STATE_OPTIONS} selected={draft.states} onChange={(states) => onChange({ states })} /></div>
        ) : null}

        {draft.conditionType === "opportunity_state_changed" ? (
          <div className="wide automation-state-field"><span>{automationText("wakeOpportunityStatus", "Opportunity status", "机会状态")}</span><WakeStateOptions options={OPPORTUNITY_STATE_OPTIONS} selected={draft.states} onChange={(states) => onChange({ states })} /></div>
        ) : null}
          </div>
        </section>
        <section className="automation-wake-config-panel scope">
          <h4>{automationText("wakeScope", "Scope", "作用范围")}</h4>
          <div className="automation-form-grid">
            <label className="wide">
              <span>Agent Profile</span>
              <TerminalSelect
                ariaLabel="Agent Profile"
                value={draft.profileId}
                options={profiles.map((item) => ({ value: item.id, label: item.name }))}
                onChange={onProfileChange}
              />
            </label>
            <div className="wide automation-wake-scope-summary">
              <span>{automationText("wakeEnvironment", "Environment", "环境")}</span><strong>{profile?.environment === "live" ? automationText("environmentLive", "Live", "实盘") : automationText("environmentDemo", "Demo", "模拟盘")}</strong>
              <span>{automationText("wakeWatchedInstruments", "Watched instruments", "关注品种")}</span><strong>{profile?.symbols.length ? automationText("wakeInstrumentCount", "{{count}} instruments", "{{count}} 个", { count: profile.symbols.length }) : automationText("notConfigured", "Not configured", "未配置")}</strong>
              <span>{automationText("wakePermissionMode", "Permission mode", "权限模式")}</span><strong>{profile ? permissionModeLabel(profile.mode) : "--"}</strong>
            </div>
          </div>
        </section>
      </div>

      <div className="automation-editor-actions compact automation-wake-actions">
        <span />
        <span />
        <button type="button" onClick={onReset} disabled={busy}>{draft.conditionId ? automationText("wakeCancelEditing", "Cancel editing", "取消编辑") : i18n.t("common:reset")}</button>
        <button type="button" className="primary" onClick={onSave} disabled={busy || !draft.profileId || !currentTypeAllowed || !currentSymbolAllowed}><Save size={14} />{automationText("wakeSaveCondition", "Save condition", "保存条件")}</button>
      </div>
    </section>
  );
}

function WakeConditionRow({
  item,
  profile,
  now,
  busy,
  focused,
  onEdit,
  onDelete
}: {
  item: AiWakeCondition;
  profile?: AiAgentProfile;
  now: number;
  busy: boolean;
  focused: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const config = isRecord(item.config) ? item.config : {};
  const tags = wakeConditionTags(item);
  const summary = formatWakeCondition({ ...config, type: item.conditionType });
  return (
    <article className={clsx("automation-wake-rule", focused && "focused", item.status !== "active" && "historical")}>
      <div className={clsx("automation-wake-rule-icon", item.conditionType)}>{wakeConditionIcon(item.conditionType, 17)}</div>
      <div className="automation-wake-rule-main">
        <div><strong>{wakeConditionLabel(item.conditionType)}</strong><span>{summary.replace(`${wakeConditionLabel(item.conditionType)} · `, "")}</span></div>
        <div className="automation-wake-rule-tags">
          {tags.map((tag) => <span key={tag}>{tag}</span>)}
          <span>{profile?.name ?? item.profileId}</span>
          <span>{item.source === "user" ? automationText("wakeUserCondition", "User condition", "用户条件") : automationText("wakeAgentCondition", "Agent condition", "Agent 条件")}</span>
        </div>
      </div>
      <div className="automation-wake-rule-cell combination"><span>{automationText("wakeCombination", "Combination", "组合")}</span><strong>{item.planMode === "all" ? automationText("wakeAllMatched", "All matched", "全部命中") : automationText("wakeAnyMatched", "Any matched", "任一命中")}</strong></div>
      <div className="automation-wake-rule-cell status"><span>{i18n.t("common:status")}</span><StatusBadge status={item.status} /></div>
      <div className="automation-wake-rule-cell timing"><span>{automationText("wakeLastTriggeredExpiry", "Last triggered / expiry", "最近触发 / 到期")}</span><strong>{formatDateTime(item.lastTriggeredAt)}</strong><small>{item.expiresAt ? automationText("wakeExpiresAt", "Expires {{time}}", "到期 {{time}}", { time: formatDateTime(item.expiresAt) }) : automationText("wakeNoExpiry", "No expiry", "长期有效")}</small></div>
      <div className="automation-wake-rule-cell countdown"><span>{automationText("wakeNextTrigger", "Next trigger", "下次触发")}</span><strong>{formatWakeCountdown(item, now)}</strong></div>
      <div className="automation-wake-rule-menu">
        {item.source === "user" && item.status === "active" ? (
          <>
            <button type="button" onClick={onEdit} disabled={busy} title={automationText("wakeEditUserCondition", "Edit user condition", "编辑用户条件")}><Pencil size={13} /></button>
            <button type="button" onClick={onDelete} disabled={busy} title={automationText("wakeDeleteUserCondition", "Delete user condition", "删除用户条件")}><Trash2 size={13} /></button>
          </>
        ) : <MoreHorizontal size={15} />}
      </div>
      <details className="automation-wake-rule-raw">
        <summary><ChevronDown size={13} />{automationText("rawDataJson", "Raw data (JSON)", "原始数据（JSON）")}</summary>
        <pre>{JSON.stringify(item.config, null, 2)}</pre>
      </details>
    </article>
  );
}

function WakeConditionsView({
  items,
  runs,
  profiles,
  focusId,
  busy
}: {
  items: AiWakeCondition[];
  runs: AiAutomationRun[];
  profiles: Map<string, AiAgentProfile>;
  focusId?: string | null;
  busy: boolean;
}) {
  const profileItems = useMemo(() => Array.from(profiles.values()), [profiles]);
  const [showHistory, setShowHistory] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());

  useEffect(() => {
    if (!focusId) return;
    const focused = items.find((item) => item.id === focusId);
    if (focused) setShowHistory(focused.status !== "active");
  }, [focusId, items]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const agentItems = useMemo(() => items.filter((item) => item.source === "agent"), [items]);
  const activeItems = useMemo(() => agentItems.filter((item) => item.status === "active"), [agentItems]);
  const historicalItems = useMemo(() => agentItems.filter((item) => item.status !== "active"), [agentItems]);
  const visibleItems = showHistory ? historicalItems : activeItems;
  const sortedItems = useMemo(
    () => [...visibleItems].sort((a, b) => b.createdAt - a.createdAt),
    [visibleItems]
  );
  const nextScheduledItem = useMemo(() => activeItems
    .map((item) => ({ item, at: nextPredictableTriggerAt(item) }))
    .filter((entry): entry is { item: AiWakeCondition; at: number } => entry.at !== null)
    .sort((a, b) => a.at - b.at)[0], [activeItems]);
  const nextFallbackWake = useMemo(() => profileItems
    .filter((profile) => profile.enabled)
    .map((profile) => profileFallbackWakeAt(profile, runs))
    .sort((a, b) => {
      const aRank = a.status === "due" ? 0 : a.status === "queued" || a.status === "running" ? 1 : 2;
      const bRank = b.status === "due" ? 0 : b.status === "queued" || b.status === "running" ? 1 : 2;
      if (aRank !== bRank) return aRank - bRank;
      return (a.target ?? Number.MAX_SAFE_INTEGER) - (b.target ?? Number.MAX_SAFE_INTEGER);
    })[0] ?? null, [profileItems, runs]);

  if (profileItems.length === 0) {
    return <SectionState icon={<Radio size={22} />} title={automationText("wakeCreateProfileFirst", "Create an Agent Profile first", "请先创建 Agent Profile")} detail={automationText("wakeCreateProfileFirstDetail", "The Agent generates the next watch plan after every run.", "Agent 会在每轮运行结束后生成下一轮观察计划。")} />;
  }

  return (
    <div className="automation-wake-view">
      <section className="automation-wake-editor automation-observation-brief">
        <div className="automation-wake-editor-head">
          <div>
            <strong>{automationText("wakeNextAgentPlan", "Agent's next watch plan", "Agent 下一轮观察计划")}</strong>
            <span>{automationText("wakeNextAgentPlanDetail", "You only configure the Profile's maximum silence period. The Agent generates market watch conditions after each run, replacing the previous plan.", "用户只配置 Profile 的最长静默时间；行情观察条件由 Agent 每轮生成，新计划会替换旧计划。")}</span>
          </div>
        </div>
        <div className="automation-wake-scope-summary">
          <span>{automationText("wakeFallbackRule", "Fallback rule", "兜底规则")}</span>
          <strong>{automationText("wakeFallbackRuleDetail", "If the maximum silence period elapses without a run, the system automatically queues a background Agent run.", "超过最长静默时间未运行时，系统会自动排队一次后台 Agent Run。")}</strong>
        </div>
      </section>
      <div className="automation-wake-list-head">
        <div>
          <strong>{showHistory ? automationText("wakeHistoricalPlans", "Historical watch plans", "历史观察计划") : automationText("wakeCurrentPlan", "Current watch plan", "当前观察计划")}</strong>
          <span>{showHistory ? automationText("wakeHistoricalCount", "{{count}} replaced or expired records", "{{count}} 条被替换或过期记录", { count: historicalItems.length }) : automationText("wakeActiveCount", "{{count}} dynamic Agent conditions", "{{count}} 条 Agent 动态条件", { count: activeItems.length })}</span>
        </div>
        {!showHistory ? (
          <div className="automation-next-trigger">
            <Clock3 size={14} />
            <span>{nextScheduledItem ? automationText("wakeScheduledCondition", "Scheduled condition", "计划内定时条件") : `${automationText("wakeMaximumSilenceFallback", "Maximum-silence fallback", "最长静默兜底")}${nextFallbackWake ? ` · ${nextFallbackWake.profile.name}` : ""}`}</span>
            <strong>{nextScheduledItem ? formatWakeCountdown(nextScheduledItem.item, clockNow) : formatFallbackWakeCountdown(nextFallbackWake, clockNow)}</strong>
          </div>
        ) : null}
        <div className="automation-subhead-actions">
          <div className="automation-view-toggle" role="tablist" aria-label={automationText("wakePlanViewAria", "Watch plan view", "唤醒条件视图")}>
            <button type="button" role="tab" aria-selected={!showHistory} className={!showHistory ? "active" : ""} onClick={() => setShowHistory(false)}>{automationText("current", "Current", "当前")}</button>
            <button type="button" role="tab" aria-selected={showHistory} className={showHistory ? "active" : ""} onClick={() => setShowHistory(true)}><History size={12} />{i18n.t("common:history")}</button>
          </div>
        </div>
      </div>
      {sortedItems.length === 0 ? (
        <SectionState
          icon={showHistory ? <History size={22} /> : <Radio size={22} />}
          title={showHistory ? automationText("wakeNoHistory", "No historical watch plans", "暂无历史观察计划") : automationText("wakeNoActiveConditions", "No active watch conditions", "当前没有生效观察条件")}
          detail={showHistory ? automationText("wakeNoHistoryDetail", "Replaced or expired Agent conditions remain here.", "Agent 条件被替换或过期后会保留在这里。") : automationText("wakeNoActiveDetail", "Run a Profile manually or wait for its maximum silence period. The Agent will generate the next watch plan after it completes.", "手动运行一次 Profile，或等待最长静默时间到期，Agent 完成后会生成下一轮观察计划。")}
        />
      ) : (
        <div className="automation-wake-rules">
          {sortedItems.map((item) => <WakeConditionRow
            item={item}
            profile={profiles.get(item.profileId)}
            now={clockNow}
            busy={busy}
            focused={focusId === item.id}
            onEdit={() => {}}
            onDelete={() => {}}
            key={item.id}
          />)}
        </div>
      )}
    </div>
  );
}

function reviewPnlNumber(value: AiAutomationReview["netPnl"]) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace(/[^\d.+-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function ReviewsView({
  items,
  dailyItems,
  focusId
}: {
  items: AiAutomationReview[];
  dailyItems: AiDailyMarketReview[];
  focusId?: string | null;
}) {
  const focusIsDaily = Boolean(focusId && dailyItems.some((item) => item.id === focusId));
  const [mode, setMode] = useState<"daily" | "episode">(focusIsDaily || dailyItems.length > 0 ? "daily" : "episode");
  useEffect(() => {
    if (focusIsDaily) setMode("daily");
    else if (focusId && items.some((item) => item.id === focusId)) setMode("episode");
  }, [focusId, focusIsDaily, items]);
  return (
    <div className="automation-review-page">
      <div className="automation-review-mode-tabs" role="tablist" aria-label={automationText("reviewTypeAria", "Review type", "复盘类型")}>
        <button type="button" className={mode === "daily" ? "active" : ""} onClick={() => setMode("daily")}><History size={14} />{automationText("dailyMarketReviews", "Daily market reviews", "每日市场复盘")} <span>{dailyItems.length}</span></button>
        <button type="button" className={mode === "episode" ? "active" : ""} onClick={() => setMode("episode")}><ClipboardCheck size={14} />{automationText("positionTradeReviews", "Position trade reviews", "仓位交易复盘")} <span>{items.length}</span></button>
      </div>
      {mode === "daily"
        ? <DailyMarketReviewsView items={dailyItems} focusId={focusId} />
        : <EpisodeReviewsView items={items} focusId={focusId} />}
    </div>
  );
}

function resolveProfileModelId(model: string | null | undefined, config: AiConfigSummary | null) {
  const selector = String(model ?? "").trim();
  return config?.models.find((item) => item.id === selector || item.model === selector || item.name === selector)?.id
    || config?.activeModelId
    || config?.models[0]?.id
    || null;
}

function DailyMarketReviewsView({ items, focusId }: { items: AiDailyMarketReview[]; focusId?: string | null }) {
  const sorted = useMemo(() => [...items].sort((a, b) => b.reviewDate.localeCompare(a.reviewDate) || b.updatedAt - a.updatedAt), [items]);
  const [selectedId, setSelectedId] = useState<string | null>(focusId && sorted.some((item) => item.id === focusId) ? focusId : sorted[0]?.id ?? null);
  useEffect(() => {
    if (focusId && sorted.some((item) => item.id === focusId)) setSelectedId(focusId);
    else if (!selectedId || !sorted.some((item) => item.id === selectedId)) setSelectedId(sorted[0]?.id ?? null);
  }, [focusId, selectedId, sorted]);
  const selected = sorted.find((item) => item.id === selectedId) ?? sorted[0];
  if (!selected) {
    return <SectionState icon={<History size={22} />} title={automationText("dailyReviewEmpty", "No daily market reviews", "暂无每日市场复盘")} detail={automationText("dailyReviewEmptyDetail", "Enable automatic daily reviews in a Profile or run one manually. The system analyzes watched markets by UTC calendar day.", "在 Profile 中开启每天自动复盘，或点击手动执行复盘。系统会按 UTC 自然日分析关注交易对。")} />;
  }
  return (
    <div className="automation-daily-review-layout">
      <aside className="automation-daily-review-list">
        <div className="automation-subhead"><div><strong>{automationText("dailyReviews", "Daily reviews", "每日复盘")}</strong><span>{automationText("utcDate", "UTC date", "UTC 日期")}</span></div><span>{automationText("recordCount", "{{count}} records", "{{count}} 条", { count: sorted.length })}</span></div>
        <div className="automation-daily-review-items">
          {sorted.map((item) => (
            <button type="button" className={clsx(item.id === selected.id && "active")} onClick={() => setSelectedId(item.id)} key={item.id}>
              <span><strong>{item.reviewDate}</strong><StatusBadge status={item.status} /></span>
              <b data-i18n-skip>{item.profileName}</b>
              <small data-i18n-skip>{item.symbols.join(" · ")}</small>
              <em data-i18n-skip={Boolean(item.error || item.summary)}>{item.error || compactText(item.summary || automationText("reviewWaiting", "Waiting for review generation", "等待生成复盘"), 54)}</em>
            </button>
          ))}
        </div>
      </aside>
      <main className="automation-daily-review-content">
        <header>
          <div><strong>{automationText("datedMarketReview", "{{date}} market review", "{{date}} 市场复盘", { date: selected.reviewDate })}</strong><span data-i18n-skip>{selected.profileName} · UTC 00:00-24:00</span></div>
          <StatusBadge status={selected.status} />
        </header>
        {selected.error ? <div className="automation-daily-review-error"><AlertTriangle size={16} />{selected.error}</div> : null}
        <article>{selected.summary ? <AiMarkdown content={selected.summary} /> : <p>{automationText("dailyReviewSubmitted", "The review has been submitted. The full market review will appear here when it completes.", "复盘任务已提交，完成后将在这里显示完整市场回顾。")}</p>}</article>
      </main>
      <aside className="automation-daily-review-meta">
        <strong>{automationText("reviewScope", "Review scope", "复盘范围")}</strong>
        <dl>
          <div><dt>Profile</dt><dd data-i18n-skip>{selected.profileName}</dd></div>
          <div><dt>{automationText("utcDate", "UTC date", "UTC 日期")}</dt><dd>{selected.reviewDate}</dd></div>
          <div><dt>{automationText("markets", "Markets", "交易对")}</dt><dd data-i18n-skip>{selected.symbols.join(" · ")}</dd></div>
          <div><dt>{automationText("lastUpdated", "Last updated", "最近更新")}</dt><dd>{formatDateTime(selected.updatedAt)}</dd></div>
          <div><dt>Run</dt><dd>{selected.runId || "--"}</dd></div>
        </dl>
        <p>{automationText("dailyReviewReadOnly", "Daily reviews only read market and intelligence data. They do not create trade opportunities or execute trades.", "每日复盘只读取市场与情报数据，不创建交易机会，也不执行交易。")}</p>
      </aside>
    </div>
  );
}

function EpisodeReviewsView({ items, focusId }: { items: AiAutomationReview[]; focusId?: string | null }) {
  const sortedItems = useMemo(() => [...items].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)), [items]);
  const [listFilter, setListFilter] = useState<"all" | "profit" | "loss" | "ai">("all");
  const [detailTab, setDetailTab] = useState<"orders" | "decisions" | "pnl" | "suggestions">("orders");
  const filteredItems = useMemo(() => {
    return sortedItems.filter((item) => {
      const pnl = reviewPnlNumber(item.netPnl) ?? 0;
      if (listFilter === "profit") return pnl > 0;
      if (listFilter === "loss") return pnl < 0;
      if (listFilter === "ai") return reviewHasAiParticipation(item);
      return true;
    });
  }, [listFilter, sortedItems]);
  const initialSelectedId = focusId && sortedItems.some((item) => item.id === focusId) ? focusId : sortedItems[0]?.id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const [detail, setDetail] = useState<AiAutomationReviewDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  useEffect(() => {
    if (focusId && sortedItems.some((item) => item.id === focusId)) {
      setSelectedId(focusId);
      return;
    }
    if (!selectedId || !filteredItems.some((item) => item.id === selectedId)) {
      setSelectedId(filteredItems[0]?.id ?? sortedItems[0]?.id ?? null);
    }
  }, [filteredItems, focusId, selectedId, sortedItems]);
  const selected = filteredItems.find((item) => item.id === selectedId) ?? filteredItems[0] ?? sortedItems[0];
  useEffect(() => {
    if (!selected?.episodeId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    invokeDesktop<AiAutomationReviewDetail>("ai_automation_review_detail", {
      request: { episodeId: selected.episodeId, bar: "15m", candleLimit: 260 }
    })
      .then((value) => {
        if (cancelled) return;
        setDetail(value);
      })
      .catch((error) => {
        if (cancelled) return;
        setDetail(null);
        setDetailError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.episodeId]);
  if (!selected) return <SectionState icon={<ClipboardCheck size={22} />} title={automationText("positionReviewEmpty", "No automated position reviews", "暂无自动复盘")} detail={automationText("positionReviewEmptyDetail", "Evidence, findings, and improvements appear after a position episode closes and its review is generated.", "持仓 Episode 完结并生成复盘后，会显示证据、发现和改进建议。")} />;
  const completedCount = items.filter((item) => item.status === "completed").length;
  const profitCount = items.filter((item) => (reviewPnlNumber(item.netPnl) ?? 0) > 0).length;
  const lossCount = items.filter((item) => (reviewPnlNumber(item.netPnl) ?? 0) < 0).length;
  const totalPnl = items.reduce((total, item) => total + (reviewPnlNumber(item.netPnl) ?? 0), 0);
  const latestUpdate = Math.max(...items.map((item) => item.updatedAt || item.createdAt || 0));
  const selectedPnl = reviewPnlNumber(detail?.episode.netPnl ?? selected.netPnl);
  const selectedTone = selectedPnl === null ? "neutral" : selectedPnl >= 0 ? "profit" : "loss";
  return (
    <div className="automation-reviews-view">
      <div className="automation-review-hero">
        <div>
          <strong>{automationText("positionReviewHero", "AI Automation / Reviews", "AI 自动化 / 复盘")}</strong>
          <span>{automationText("positionReviewHeroDetail", "Review AI decisions, order execution, and PnL attribution by position.", "按仓位回顾 AI 决策、订单执行与盈亏归因。")}</span>
        </div>
        <div className="automation-review-stats">
          <span><b>{items.length}</b>{automationText("reviewedPositions", "Reviewed positions", "复盘仓位")}</span>
          <span className="profit"><b>{profitCount}</b>{automationText("profitable", "Profitable", "盈利")}</span>
          <span className="loss"><b>{lossCount}</b>{automationText("lossMaking", "Loss-making", "亏损")}</span>
          <span className={clsx(totalPnl >= 0 ? "profit" : "loss")}><b>{formatSignedNumber(totalPnl)} USDT</b>{automationText("netPnl", "Net PnL", "净收益")}</span>
          <span><b>{completedCount}</b>{automationText("completed", "Completed", "已完成")}</span>
          <span><b>{formatDateTime(latestUpdate)}</b>{automationText("lastUpdated", "Last updated", "最近更新")}</span>
        </div>
      </div>

      <div className="automation-review-workbench">
        <aside className="automation-review-episode-list">
          <div className="automation-review-list-head">
            <strong>{automationText("positionReviewList", "Position review list", "仓位复盘列表")}</strong>
            <div>
              {([
                ["all", automationText("all", "All", "全部")],
                ["profit", automationText("profitable", "Profitable", "盈利")],
                ["loss", automationText("lossMaking", "Loss-making", "亏损")],
                ["ai", automationText("aiParticipated", "AI involved", "AI 参与")]
              ] as const).map(([value, label]) => (
                <button
                  type="button"
                  className={clsx(listFilter === value && "active")}
                  onClick={() => setListFilter(value)}
                  key={value}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="automation-review-episode-scroll">
            {filteredItems.length === 0 ? (
              <div className="automation-review-list-empty">
                {automationText("reviewFilterEmpty", "No reviews match this filter", "当前筛选没有复盘记录")}
              </div>
            ) : filteredItems.map((item) => {
              const pnlValue = reviewPnlNumber(item.netPnl);
              const tone = pnlValue === null ? "neutral" : pnlValue >= 0 ? "profit" : "loss";
              const identity = reviewEpisodeIdentity(item);
              return (
                <button
                  type="button"
                  className={clsx("automation-review-episode-card", selected.id === item.id && "active")}
                  onClick={() => setSelectedId(item.id)}
                  key={item.id}
                >
                  <span className="automation-review-episode-symbol">{identity.instId}</span>
                  <span className="automation-review-episode-line">
                    <b className={identity.side === "short" ? "loss" : "profit"}>{identity.side === "short" ? automationText("shortSide", "Short", "空") : automationText("longSide", "Long", "多")}</b>
                    <strong className={tone}>{pnlValue === null ? "--" : `${formatSignedNumber(pnlValue)} USDT`}</strong>
                  </span>
                  <span>{reviewDurationLabel(item)}</span>
                  <em data-i18n-skip={Boolean(item.summary)}>{item.summary ? compactText(item.summary, 32) : automationText("reviewSummaryEmpty", "No review summary", "暂无复盘摘要")}</em>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="automation-review-main">
          <div className="automation-review-chart-panel">
            <div className="automation-review-panel-title">
              <div>
                <strong>{automationText("reviewReplayTitle", "Candle replay · Orders and AI decisions", "K线回放 · 订单与 AI 决策")}</strong>
                <span>{reviewEpisodeIdentity(selected, detail).instId} {reviewEpisodeIdentity(selected, detail).side === "short" ? automationText("shortSide", "Short", "空") : automationText("longSide", "Long", "多")} · {formatReviewWindow(selected, detail)}</span>
              </div>
              <StatusBadge status={selected.status} />
            </div>
            <ReviewReplayChart detail={detail} loading={detailLoading} error={detailError} />
          </div>

          <div className="automation-review-bottom-panel">
            <div className="automation-review-bottom-left">
              <div className="automation-review-mini-tabs">
                {([
                  ["orders", automationText("reviewOrders", "Order details", "订单明细")],
                  ["decisions", automationText("reviewAiDecisions", "AI decisions", "AI 决策")],
                  ["pnl", automationText("reviewPnlAttribution", "PnL attribution", "盈亏归因")],
                  ["suggestions", automationText("reviewImprovements", "Improvements", "改进建议")]
                ] as const).map(([value, label]) => (
                  <button
                    type="button"
                    className={clsx(detailTab === value && "active")}
                    onClick={() => setDetailTab(value)}
                    key={value}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <ReviewDetailTabContent tab={detailTab} item={selected} detail={detail} loading={detailLoading} error={detailError} pnl={selectedPnl} />
            </div>
            <ReviewAttribution pnl={selectedPnl} detail={detail} />
          </div>
        </section>

        <aside className="automation-review-insight-panel">
          <div className="automation-review-panel-title">
            <div>
              <strong>{automationText("reviewConclusion", "Review conclusion", "复盘结论")}</strong>
              <span>{automationText("structuredSummary", "Structured summary", "结构化摘要")}</span>
            </div>
          </div>
          <p className="automation-review-insight-summary" data-i18n-skip={Boolean(selected.summary)}>{selected.summary || automationText("reviewSummaryEmptySentence", "No review summary.", "暂无复盘摘要。")}</p>
          {detail?.warnings.length ? (
            <div className="automation-review-detail-warnings">
              {detail.warnings.map((warning) => <span key={warning}>{warning}</span>)}
            </div>
          ) : null}
          <div className="automation-review-insight-grid">
            <ReviewInsightMetric label={automationText("netPnl", "Net PnL", "净收益")} value={formatSignedFixedDecimal(detail?.episode.netPnl ?? selected.netPnl, 3)} tone={selectedTone} />
            <ReviewInsightMetric label={automationText("status", "Status", "状态")} value={statusLabel(selected.status)} />
            <ReviewInsightMetric label={automationText("maximumPosition", "Maximum position", "最大仓位")} value={detail?.episode.maxQty ? automationText("contractsValue", "{{count}} contracts", "{{count}} 张", { count: detail.episode.maxQty }) : "--"} />
            <ReviewInsightMetric label={automationText("averagePrice", "Average price", "均价")} value={formatEpisodePriceRange(detail)} />
            <ReviewInsightMetric label={automationText("fees", "Fees", "手续费")} value={formatSignedFixedDecimal(detail?.episode.fees, 3)} tone={numberTone(detail?.episode.fees)} />
            <ReviewInsightMetric label={automationText("fundingFee", "Funding fee", "资金费")} value={formatSignedFixedDecimal(detail?.episode.fundingFee, 3)} tone={numberTone(detail?.episode.fundingFee)} />
            <ReviewInsightMetric label={automationText("ordersAndFills", "Orders / fills", "订单 / 成交")} value={`${detail?.orders.length ?? 0} / ${detail?.fills.length ?? 0}`} />
            <ReviewInsightMetric label={automationText("lastUpdated", "Last updated", "最近更新")} value={formatDateTime(selected.updatedAt)} />
          </div>
          <section className="automation-review-insight-section">
            <strong>{automationText("keyFindings", "Key findings", "主要发现")}</strong>
            <p data-i18n-skip>{formatStructured(selected.findings)}</p>
          </section>
          <section className="automation-review-insight-section">
            <strong>{automationText("reviewImprovements", "Improvements", "改进建议")}</strong>
            <p data-i18n-skip>{formatStructured(selected.suggestions)}</p>
          </section>
        </aside>
      </div>
    </div>
  );
}

function reviewEpisodeIdentity(item: AiAutomationReview, detail?: AiAutomationReviewDetail | null) {
  if (detail?.episode) {
    return { instId: detail.episode.instId, side: detail.episode.episodeSide === "short" ? "short" as const : "long" as const };
  }
  const compactMatch = item.episodeId.match(/([A-Z0-9]+)USDT(?:SWAP)?/i);
  const parts = item.episodeId.split("-");
  const instIndex = parts.findIndex((part, index) => index < parts.length - 2 && parts[index + 1] === "USDT");
  const instId = compactMatch
    ? `${compactMatch[1].toUpperCase()}-USDT-SWAP`
    : instIndex >= 0
      ? `${parts[instIndex]}-USDT-${parts[instIndex + 2] || "SWAP"}`
      : (parts[1] ? parts.slice(1, 4).join("-") : item.episodeId);
  const side = /-short-|short/i.test(item.episodeId) ? "short" as const : "long" as const;
  return { instId: instId || "UNKNOWN", side };
}

function formatReviewWindow(item: AiAutomationReview, detail?: AiAutomationReviewDetail | null) {
  if (detail?.episode) {
    const start = detail.episode.openTime;
    const end = detail.episode.closeTime ?? detail.episode.lastFillTime ?? item.updatedAt;
    return `${formatDateTime(start)} → ${formatDateTime(end)}`;
  }
  return `${formatDateTime(item.createdAt)} → ${formatDateTime(item.updatedAt)}`;
}

function compactText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function formatSignedNumber(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function reviewDurationLabel(item: AiAutomationReview) {
  const delta = Math.max(0, (item.updatedAt || item.createdAt) - item.createdAt);
  if (delta < 60_000) return automationText("reviewDurationPending", "Holding duration pending sync", "持仓时间待同步");
  if (delta < 3_600_000) return automationText("reviewDurationMinutes", "Review span: {{count}} min", "复盘跨度 {{count}} 分钟", { count: Math.max(1, Math.round(delta / 60_000)) });
  if (delta < 86_400_000) return automationText("reviewDurationHours", "Review span: {{count}} hr", "复盘跨度 {{count}} 小时", { count: Math.round(delta / 3_600_000) });
  return automationText("reviewDurationDays", "Review span: {{count}} days", "复盘跨度 {{count}} 天", { count: Math.round(delta / 86_400_000) });
}

function shortEpisodeId(value: string) {
  return value.length > 22 ? `${value.slice(0, 18)}…` : value;
}

function parseNumericText(value?: string | number | null) {
  if (value === undefined || value === null) return null;
  const numeric = Number(String(value).replace(/[^\d.+-]/g, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

function numberTone(value?: string | number | null): "profit" | "loss" | "neutral" {
  const numeric = parseNumericText(value);
  if (numeric === null || numeric === 0) return "neutral";
  return numeric > 0 ? "profit" : "loss";
}

function formatEpisodePriceRange(detail?: AiAutomationReviewDetail | null) {
  if (!detail?.episode) return "--";
  const open = formatFixedDecimal(detail.episode.avgOpenPx, 3);
  const close = formatFixedDecimal(detail.episode.avgClosePx, 3);
  return `${open} / ${close}`;
}

function formatFixedDecimal(value?: string | number | null, digits = 3) {
  const numeric = parseNumericText(value);
  return numeric === null ? "--" : numeric.toFixed(digits);
}

function formatSignedFixedDecimal(value?: string | number | null, digits = 3) {
  const numeric = parseNumericText(value);
  return numeric === null ? "--" : `${numeric >= 0 ? "+" : ""}${numeric.toFixed(digits)}`;
}

function reviewHasAiParticipation(item: AiAutomationReview) {
  const text = `${item.summary ?? ""} ${JSON.stringify(item.findings ?? "")} ${JSON.stringify(item.suggestions ?? "")}`;
  return /AI|Agent|Run|机会|自动化|copilot|limited_auto/i.test(text);
}

function buildReviewTicker(symbol: string, candles: AiAutomationReviewDetail["candles"]): Ticker | null {
  const last = candles.at(-1);
  if (!last) return null;
  return {
    instId: symbol,
    last: String(last.close),
    lastSz: "",
    askPx: String(last.close),
    askSz: "",
    bidPx: String(last.close),
    bidSz: "",
    open24h: String(last.open),
    high24h: String(last.high),
    low24h: String(last.low),
    vol24h: String(last.volume),
    volCcy24h: "",
    ts: last.time * 1000
  };
}

function buildReviewFillMarkers(detail: AiAutomationReviewDetail | null, t: ReturnType<typeof useTranslation>["t"]): ChartFillMarker[] {
  if (!detail) return [];
  const symbol = detail.episode?.instId ?? detail.fills[0]?.instId;
  return symbol ? buildHistoricalFillMarkers(symbol, detail.fills, 240, t) : [];
}

function ReviewInsightMetric({ label, value, tone }: { label: string; value: ReactNode; tone?: "profit" | "loss" | "neutral" }) {
  return (
    <div className="automation-review-insight-metric">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
    </div>
  );
}

function ReviewReplayChart({
  detail,
  loading,
  error
}: {
  detail: AiAutomationReviewDetail | null;
  loading: boolean;
  error: string | null;
}) {
  const { t } = useTranslation(["automation", "trading", "chart"]);
  const chartCandles = detail?.candles ?? [];
  const symbol = detail?.episode.instId ?? "BTC-USDT-SWAP";
  const fills = useMemo(() => buildReviewFillMarkers(detail, t), [detail, t]);
  const ticker = useMemo(() => buildReviewTicker(symbol, chartCandles), [chartCandles, symbol]);
  return (
    <div className="automation-review-replay-chart" aria-label={automationText("reviewChartAria", "Position review chart", "K线复盘")}>
      <KlineChart
        candles={chartCandles}
        ticker={ticker}
        symbol={symbol}
        timeframe={detail?.bar ?? "15m"}
        fills={fills}
        variant="review"
      />
      {loading ? <div className="automation-review-chart-state">{automationText("reviewChartLoading", "Loading candles and orders for this position...", "正在读取该仓位 K线与订单...")}</div> : null}
      {error ? <div className="automation-review-chart-state danger" data-i18n-skip>{error}</div> : null}
      {!loading && !error && chartCandles.length === 0 ? <div className="automation-review-chart-state">{automationText("reviewChartEmpty", "No candles are available for this position window. Sync 1m candles first.", "暂无该仓位窗口 K线，请先同步 1m K线。")}</div> : null}
    </div>
  );
}

function eventLabel(value: string) {
  const normalized = String(value || "").toUpperCase();
  if (normalized.includes("OPEN")) return automationText("reviewEventOpen", "Open", "开仓");
  if (normalized.includes("ADD")) return automationText("reviewEventAdd", "Add", "加仓");
  if (normalized.includes("REDUCE")) return automationText("reviewEventReduce", "Reduce", "减仓");
  if (normalized.includes("CLOSE")) return automationText("reviewEventClose", "Close", "平仓");
  if (normalized.includes("FUNDING")) return automationText("fundingFee", "Funding fee", "资金费");
  if (normalized.includes("LIQ")) return automationText("reviewEventLiquidation", "Liquidation / risk", "强平 / 风险");
  return value || automationText("reviewEvent", "Event", "事件");
}

function ReviewOrderTable({ item, detail, loading, error }: { item: AiAutomationReview; detail: AiAutomationReviewDetail | null; loading: boolean; error: string | null }) {
  const rows = buildReviewOrderRows(detail);
  return (
    <div className="automation-review-order-table">
      <div className="automation-review-table-head">
        <span>{automationText("time", "Time", "时间")}</span>
        <span>{automationText("action", "Action", "动作")}</span>
        <span>{automationText("type", "Type", "类型")}</span>
        <span>{automationText("orderPrice", "Order price", "委托价")}</span>
        <span>{automationText("fillPrice", "Fill price", "成交价")}</span>
        <span>{automationText("quantity", "Quantity", "数量")}</span>
        <span>{automationText("status", "Status", "状态")}</span>
      </div>
      {loading ? (
        <div className="automation-review-table-empty"><Loader2 size={18} className="spin" /><strong>{automationText("reviewOrdersLoading", "Loading orders and fills", "正在读取订单与成交")}</strong></div>
      ) : error ? (
        <div className="automation-review-table-empty danger"><AlertText text={error} /></div>
      ) : rows.length > 0 ? (
        <div className="automation-review-table-body">
          {rows.map((row) => (
            <div className="automation-review-table-row" key={row.id}>
              <span>{formatDateTime(row.time)}</span>
              <b className={row.actionTone}>{row.action}</b>
              <span>{row.type}</span>
              <span>{row.orderPx}</span>
              <span>{row.fillPx}</span>
              <span>{row.size}</span>
              <span>{row.status}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="automation-review-table-empty">
          <ClipboardCheck size={18} />
          <strong>{automationText("reviewOrdersEmpty", "No order details for this position", "暂无该仓位订单明细")}</strong>
          <span>{automationText("reviewOrdersEmptyDetail", "No local historical orders or fills match this episode. Sync historical orders and fills, then rebuild position history.", "没有在本地历史委托 / 成交中匹配到该 Episode 的订单。请先同步历史委托、历史成交并重建历史持仓。")}</span>
          <em>Episode: {shortEpisodeId(item.episodeId)}</em>
        </div>
      )}
    </div>
  );
}

function AlertText({ text }: { text: string }) {
  return <><AlertTriangle size={18} /><strong>{automationText("reviewDetailLoadFailed", "Could not load details", "详情读取失败")}</strong><span data-i18n-skip>{text}</span></>;
}

function buildReviewOrderRows(detail: AiAutomationReviewDetail | null) {
  if (!detail) return [];
  const fillRows = detail.fills.map((fill) => ({
    id: `fill-${fill.billId}`,
    time: fill.okxTs ?? fill.syncedAt,
    action: formatFillAction(fill.side, fill.posSide),
    actionTone: fill.posSide === "short" ? "loss" : "profit",
    type: automationText("fill", "Fill", "成交"),
    orderPx: detail.orders.find((order) => order.ordId === fill.ordId)?.px ?? "--",
    fillPx: fill.fillPx ?? "--",
    size: fill.fillSz ?? "--",
    status: automationText("filled", "Filled", "已成交")
  }));
  const fillOrderIds = new Set(detail.fills.map((fill) => fill.ordId).filter(Boolean));
  const orderRows = detail.orders
    .filter((order) => !fillOrderIds.has(order.ordId))
    .map((order) => ({
      id: `order-${order.ordId}`,
      time: order.okxCtime ?? order.okxUtime ?? order.syncedAt,
      action: formatFillAction(order.side, order.posSide),
      actionTone: order.posSide === "short" ? "loss" : "profit",
      type: order.ordType ?? automationText("order", "Order", "委托"),
      orderPx: order.px ?? "--",
      fillPx: order.avgPx ?? "--",
      size: order.sz ?? "--",
      status: orderStateLabel(order.state)
    }));
  return [...fillRows, ...orderRows].sort((a, b) => a.time - b.time);
}

function formatFillAction(side?: string | null, posSide?: string | null) {
  const isShort = posSide === "short";
  if (side === "buy") return isShort ? automationText("closeShort", "Close short", "平空") : automationText("openLong", "Open long", "开多");
  if (side === "sell") return isShort ? automationText("openShort", "Open short", "开空") : automationText("closeLong", "Close long", "平多");
  return isShort ? automationText("shortSide", "Short", "空") : automationText("longSide", "Long", "多");
}

function orderStateLabel(value?: string | null) {
  const labels: Record<string, string> = {
    filled: automationText("filled", "Filled", "已成交"),
    live: automationText("working", "Working", "挂单中"),
    canceled: automationText("cancelled", "Cancelled", "已撤销"),
    partially_filled: automationText("partiallyFilled", "Partially filled", "部分成交")
  };
  return labels[value ?? ""] ?? value ?? "--";
}

function ReviewDetailTabContent({
  tab,
  item,
  detail,
  loading,
  error,
  pnl
}: {
  tab: "orders" | "decisions" | "pnl" | "suggestions";
  item: AiAutomationReview;
  detail: AiAutomationReviewDetail | null;
  loading: boolean;
  error: string | null;
  pnl: number | null;
}) {
  if (tab === "orders") return <ReviewOrderTable item={item} detail={detail} loading={loading} error={error} />;
  if (tab === "pnl") return <ReviewAttribution pnl={pnl} detail={detail} compact={false} />;
  if (tab === "suggestions") {
    return (
      <div className="automation-review-text-panel">
        <strong>{automationText("reviewImprovements", "Improvements", "改进建议")}</strong>
        <AiMarkdown content={formatStructured(item.suggestions)} />
      </div>
    );
  }
  return (
    <div className="automation-review-text-panel">
      <strong>{automationText("reviewAiDecisions", "AI decisions", "AI 决策")}</strong>
      <AiMarkdown content={[item.summary, formatStructured(item.findings)].filter(Boolean).join("\n\n")} />
      {detail?.episode.events.length ? (
        <div className="automation-review-event-strip">
          {detail.episode.events.slice(0, 8).map((event) => (
            <span key={event.id || `${event.eventType}-${event.eventTime}`}>
              <b>{eventLabel(event.eventType)}</b>
              <em>{formatDateTime(event.eventTime)}</em>
              <i>{automationText("contractsValue", "{{count}} contracts", "{{count}} 张", { count: event.qty })} {event.price ? `@ ${event.price}` : ""}</i>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ReviewAttribution({ pnl, detail, compact = true }: { pnl: number | null; detail: AiAutomationReviewDetail | null; compact?: boolean }) {
  const total = parseNumericText(detail?.episode.netPnl) ?? pnl ?? 0;
  const fees = parseNumericText(detail?.episode.fees) ?? 0;
  const funding = parseNumericText(detail?.episode.fundingFee) ?? 0;
  const realized = parseNumericText(detail?.episode.realizedPnl) ?? total - fees - funding;
  const rows = [
    { label: automationText("realizedPnl", "Realized PnL", "已实现盈亏"), value: realized },
    { label: automationText("fees", "Fees", "手续费"), value: fees },
    { label: automationText("fundingFee", "Funding fee", "资金费"), value: funding },
    { label: automationText("liquidationPenalty", "Liquidation penalty", "强平罚金"), value: parseNumericText(detail?.episode.liqPenalty) ?? 0 },
    { label: automationText("final", "Final", "最终"), value: total }
  ];
  const maxAbs = Math.max(1, ...rows.map((item) => Math.abs(item.value)));
  return (
    <div className={clsx("automation-review-attribution", !compact && "expanded")}>
      <strong>{automationText("reviewPnlAttribution", "PnL attribution", "盈亏归因")}</strong>
      {rows.map((item) => {
        const width = Math.max(4, Math.round((Math.abs(item.value) / maxAbs) * 160));
        const tone = item.value >= 0 ? "profit" : "loss";
        return (
          <div className="automation-review-waterfall-row" key={item.label}>
            <span>{item.label}</span>
            <i className={tone} style={{ width }} />
            <b className={tone}>{formatSignedNumber(item.value)} USDT</b>
          </div>
        );
      })}
    </div>
  );
}

type SkillDiffRow = {
  kind: "same" | "removed" | "added";
  oldLine?: number;
  newLine?: number;
  oldText?: string;
  newText?: string;
};

function skillDefinitionText(skill: AiSkillDefinition) {
  return [
    `id: ${skill.id}`,
    `name: ${skill.name}`,
    `builtin: ${Boolean(skill.builtin)}`,
    "",
    "## Description",
    skill.description,
    "",
    "## Rules",
    skill.rules,
    "",
    "## Content",
    skill.content
  ].join("\n");
}

function buildSkillDiffRows(base: AiSkillDefinition, candidate: AiSkillDefinition): SkillDiffRow[] {
  const oldLines = skillDefinitionText(base).split("\n");
  const newLines = skillDefinitionText(candidate).split("\n");
  if (oldLines.length * newLines.length > 2_000_000) {
    const count = Math.max(oldLines.length, newLines.length);
    return Array.from({ length: count }, (_, index) => {
      const oldText = oldLines[index];
      const newText = newLines[index];
      if (oldText === newText) return { kind: "same", oldLine: index + 1, newLine: index + 1, oldText, newText };
      if (oldText === undefined) return { kind: "added", newLine: index + 1, newText };
      if (newText === undefined) return { kind: "removed", oldLine: index + 1, oldText };
      return { kind: "removed", oldLine: index + 1, oldText, newLine: index + 1, newText };
    });
  }
  const matrix = Array.from({ length: oldLines.length + 1 }, () => new Uint32Array(newLines.length + 1));
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      matrix[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? matrix[oldIndex + 1][newIndex + 1] + 1
        : Math.max(matrix[oldIndex + 1][newIndex], matrix[oldIndex][newIndex + 1]);
    }
  }
  const rows: SkillDiffRow[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
      rows.push({ kind: "same", oldLine: oldIndex + 1, newLine: newIndex + 1, oldText: oldLines[oldIndex], newText: newLines[newIndex] });
      oldIndex += 1;
      newIndex += 1;
    } else if (newIndex >= newLines.length || (oldIndex < oldLines.length && matrix[oldIndex + 1][newIndex] >= matrix[oldIndex][newIndex + 1])) {
      rows.push({ kind: "removed", oldLine: oldIndex + 1, oldText: oldLines[oldIndex] });
      oldIndex += 1;
    } else {
      rows.push({ kind: "added", newLine: newIndex + 1, newText: newLines[newIndex] });
      newIndex += 1;
    }
  }
  return rows;
}

function SkillDiffDialog({
  item,
  baseline,
  busy,
  onClose,
  onUpdate
}: {
  item: AiOptimizationSuggestion;
  baseline: AiSkillVersion;
  busy: boolean;
  onClose: () => void;
  onUpdate: (id: string, status: string) => Promise<boolean>;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const candidate = item.proposedSkill!;
  const rows = useMemo(() => buildSkillDiffRows(baseline.definition, candidate), [baseline.definition, candidate]);
  const additions = rows.filter((row) => row.kind === "added").length;
  const removals = rows.filter((row) => row.kind === "removed").length;
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [busy, onClose]);
  const decide = async (status: "applied" | "rejected") => {
    if (await onUpdate(item.id, status)) onClose();
  };
  return createPortal(
    <div className="modal-backdrop automation-skill-diff-backdrop" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}>
      <section className="modal-shell automation-skill-diff-modal" role="dialog" aria-modal="true" aria-label={automationText("skillChangePreviewAria", "{{title}} Skill change preview", "{{title}} Skill 变更预览", { title: item.title })}>
        <header className="modal-head automation-skill-diff-head">
          <div>
            <div><FileDiff size={16} /><strong data-i18n-skip>{item.title}</strong><StatusBadge status={item.status} /></div>
            <span>{item.currentSkillId} · {automationText("baselineVersion", "Baseline v{{version}}", "基线 v{{version}}", { version: baseline.version })} · <b>+{additions}</b> / <em>-{removals}</em></span>
          </div>
          <button ref={closeButtonRef} className="window-button" type="button" onClick={onClose} disabled={busy} title={automationText("closeDiffPreview", "Close diff preview", "关闭差异预览")}><X size={16} /></button>
        </header>
        <div className="automation-skill-diff-summary">
          <section><span>{automationText("changes", "Changes", "变更")}</span><p data-i18n-skip>{formatStructured(item.proposedChanges)}</p></section>
          <section><span>{automationText("expectedBenefits", "Expected benefits", "预期收益")}</span><p data-i18n-skip>{formatStructured(item.benefits)}</p></section>
          <section><span>{automationText("risks", "Risks", "风险")}</span><p data-i18n-skip>{formatStructured(item.risks)}</p></section>
        </div>
        <div className="automation-skill-diff-table" role="table" aria-label={automationText("skillDiffAria", "Line-by-line Skill version diff", "Skill 前后版本逐行差异")}>
          <div className="automation-skill-diff-columns" role="row">
            <strong role="columnheader">{automationText("originalSkillVersion", "Original Skill · v{{version}}", "原 Skill · v{{version}}", { version: baseline.version })}</strong>
            <strong role="columnheader">{automationText("candidateSkill", "Candidate Skill", "候选 Skill")}</strong>
          </div>
          <div className="automation-skill-diff-scroll">
            {rows.map((row, index) => (
              <div className={clsx("automation-skill-diff-row", row.kind)} role="row" key={`${row.kind}-${row.oldLine ?? "x"}-${row.newLine ?? "x"}-${index}`}>
                <div className="automation-skill-diff-cell old" role="cell"><span>{row.oldLine ?? ""}</span><code>{row.oldText ?? ""}</code></div>
                <div className="automation-skill-diff-cell next" role="cell"><span>{row.newLine ?? ""}</span><code>{row.newText ?? ""}</code></div>
              </div>
            ))}
          </div>
        </div>
        <footer className="automation-skill-diff-actions">
          <span>{automationText("sampleEvidenceCount", "{{samples}} samples · {{evidence}} evidence items", "{{samples}} 个样本 · {{evidence}} 条证据", { samples: item.sampleSize, evidence: Array.isArray(item.evidence) ? item.evidence.length : 0 })}</span>
          {!["applied", "accepted", "rejected"].includes(item.status) ? (
            <div>
              <button type="button" disabled={busy} onClick={() => void decide("rejected")}><X size={14} />{automationText("reject", "Reject", "拒绝")}</button>
              <button type="button" className="primary" disabled={busy} onClick={() => void decide("applied")}>
                {busy ? <Loader2 className="spin" size={14} /> : <Check size={14} />}{automationText("adoptVersion", "Adopt this version", "采用此版本")}
              </button>
            </div>
          ) : <StatusBadge status={item.status} />}
        </footer>
      </section>
    </div>,
    document.body
  );
}

function SuggestionsView({
  items,
  skillVersions,
  focusId,
  busyId,
  onUpdate
}: {
  items: AiOptimizationSuggestion[];
  skillVersions: AiSkillVersion[];
  focusId?: string | null;
  busyId: string | null;
  onUpdate: (id: string, status: string) => Promise<boolean>;
}) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const pendingCount = items.filter((item) => ["pending", "pending_review", "validating", "ready"].includes(item.status)).length;
  const appliedCount = items.filter((item) => ["applied", "accepted"].includes(item.status)).length;
  const rejectedCount = items.filter((item) => item.status === "rejected").length;
  const legacyCount = items.filter((item) => !item.proposedSkill).length;
  const suggestionVersionMap = useMemo(() => {
    const map = new Map<string, AiSkillVersion[]>();
    for (const version of skillVersions) {
      if (!version.sourceSuggestionId) continue;
      const list = map.get(version.sourceSuggestionId) ?? [];
      list.push(version);
      map.set(version.sourceSuggestionId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (a.status === "draft" && b.status !== "draft") return -1;
        if (b.status === "draft" && a.status !== "draft") return 1;
        return b.version - a.version;
      });
    }
    return map;
  }, [skillVersions]);
  const baselineFor = (item: AiOptimizationSuggestion) => skillVersions.find((version) => (
    version.skillId === item.currentSkillId
    && version.version === item.currentSkillVersion
    && version.status === "published"
  )) ?? (item.baselineSkill && item.currentSkillId && item.currentSkillVersion ? {
    id: `baseline:${item.currentSkillId}:${item.currentSkillVersion}`,
    skillId: item.currentSkillId,
    version: item.currentSkillVersion,
    status: "published",
    definition: item.baselineSkill,
    createdAt: item.createdAt,
    publishedAt: null
  } : null);
  const previewItem = items.find((item) => item.id === previewId) ?? null;
  const previewBaseline = previewItem ? baselineFor(previewItem) : null;
  return (
    <div className="automation-optimization-view">
      <div className="automation-optimization-hero">
        <div>
          <strong>{automationText("skillChangeAudit", "Skill change audit", "Skill 变更审计")}</strong>
          <span>{automationText("skillChangeAuditDetail", "Candidate versions generated from position-review evidence", "仓位复盘证据生成的候选版本")}</span>
        </div>
        <div className="automation-optimization-stats" aria-label={automationText("suggestionStatsAria", "Optimization suggestion status", "优化建议状态统计")}>
          <span><b>{pendingCount}</b>{automationText("pendingReview", "To review", "待查看")}</span>
          <span><b>{appliedCount}</b>{automationText("adopted", "Adopted", "已采用")}</span>
          <span><b>{rejectedCount}</b>{automationText("rejected", "Rejected", "已拒绝")}</span>
          <span><b>{legacyCount}</b>{automationText("legacyFormat", "Legacy", "旧格式")}</span>
        </div>
      </div>
      {items.length === 0 ? (
        <SectionState icon={<Lightbulb size={22} />} title={automationText("suggestionsEmpty", "No optimization suggestions", "暂无优化建议")} detail={automationText("suggestionsEmptyDetail", "After enough review samples accumulate, the system proposes reviewable Skill or parameter improvements.", "复盘累积到足够样本后，系统会提出可审核的 Skill 或参数改进。")} />
      ) : (
        <div className="automation-suggestion-stack">
          {items.map((item) => {
            const relatedVersions = suggestionVersionMap.get(item.id) ?? [];
            const relatedPublished = relatedVersions.find((version) => version.status === "published") ?? null;
            const baseline = baselineFor(item);
            const canPreview = Boolean(item.proposedSkill && baseline);
            return (
            <article className={clsx("automation-suggestion-card", focusId === item.id && "focused")} key={item.id}>
              <div className="automation-suggestion-card-head">
                <div className="automation-suggestion-title">
                  <span className={clsx("automation-suggestion-led", statusTone(item.status))}><Lightbulb size={14} /></span>
                  <div>
                    <strong data-i18n-skip>{item.title}</strong>
                    <p data-i18n-skip>{structuredPreview(item.problem, 180)}</p>
                  </div>
                </div>
                <div className="automation-suggestion-badges">
                  <StatusBadge status={item.status} />
                  <span>{automationText("sampleCount", "{{count}} samples", "样本 {{count}}", { count: item.sampleSize })}</span>
                </div>
              </div>
              <div className="automation-suggestion-body">
                <section className="automation-suggestion-primary">
                  <span>{automationText("evidence", "Evidence", "证据")}</span>
                  <p data-i18n-skip>{structuredPreview(item.evidence, 320)}</p>
                </section>
                <section className="automation-suggestion-primary accent">
                  <span>{automationText("proposedChanges", "Proposed changes", "建议变更")}</span>
                  <p data-i18n-skip>{structuredPreview(item.proposedChanges, 360)}</p>
                </section>
                <div className="automation-suggestion-side">
                  <section>
                    <span>{automationText("expectedBenefits", "Expected benefits", "预期收益")}</span>
                    <p data-i18n-skip>{structuredPreview(item.benefits, 180)}</p>
                  </section>
                  <section>
                    <span>{automationText("risks", "Risks", "风险")}</span>
                    <p data-i18n-skip>{structuredPreview(item.risks, 180)}</p>
                  </section>
                </div>
              </div>
              <div className="automation-suggestion-footer">
                <div className="automation-suggestion-skill">
                  <span>{item.currentSkillId ? `${item.currentSkillId} · ${automationText("baselineVersion", "Baseline v{{version}}", "基线 v{{version}}", { version: item.currentSkillVersion ?? "?" })}` : automationText("skillNotBound", "No Skill bound", "尚未绑定 Skill")}</span>
                  {relatedPublished ? <strong>{automationText("publishedVersion", "Published v{{version}}", "已发布 v{{version}}", { version: relatedPublished.version })}</strong> : canPreview ? <em>{automationText("candidateReady", "Candidate version ready", "候选版本已就绪")}</em> : <em>{automationText("legacyCandidateMissing", "Legacy suggestion has no complete candidate Skill", "旧建议缺少完整候选 Skill")}</em>}
                </div>
                {!['applied', 'accepted', 'rejected'].includes(item.status) ? (
                  <div>
                    <button disabled={busyId === item.id} onClick={() => onUpdate(item.id, "rejected")}>{automationText("reject", "Reject", "拒绝")}</button>
                    <button className="primary" disabled={busyId === item.id || !canPreview} onClick={() => setPreviewId(item.id)} title={canPreview ? automationText("viewSkillDiff", "View the Skill version diff", "查看 Skill 前后版本差异") : automationText("candidateUnavailable", "This suggestion has no complete candidate Skill", "该建议没有可用的完整候选 Skill")}><Eye size={14} />{automationText("previewChanges", "Preview changes", "预览变更")}</button>
                  </div>
                ) : canPreview ? <button onClick={() => setPreviewId(item.id)}><Eye size={14} />{automationText("viewChanges", "View changes", "查看变更")}</button> : null}
              </div>
            </article>
          );
          })}
        </div>
      )}
      {previewItem && previewBaseline && previewItem.proposedSkill ? (
        <SkillDiffDialog
          item={previewItem}
          baseline={previewBaseline}
          busy={busyId === previewItem.id}
          onClose={() => setPreviewId(null)}
          onUpdate={onUpdate}
        />
      ) : null}
    </div>
  );
}

function SkillVersionsView({
  items,
  focusId,
  busyId,
  onPublish,
  onDiscard
}: {
  items: AiSkillVersion[];
  focusId?: string | null;
  busyId: string | null;
  onPublish: (item: AiSkillVersion) => void;
  onDiscard: (item: AiSkillVersion) => void;
}) {
  const drafts = items.filter((item) => item.status === "draft").length;
  const published = items.filter((item) => item.status === "published").length;
  const groupedItems = useMemo(() => {
    const groups = new Map<string, AiSkillVersion[]>();
    for (const item of items) {
      const list = groups.get(item.skillId) ?? [];
      list.push(item);
      groups.set(item.skillId, list);
    }
    return Array.from(groups.entries())
      .map(([skillId, versions]) => {
        const sorted = [...versions].sort((a, b) => {
          if (a.status === "draft" && b.status !== "draft") return -1;
          if (b.status === "draft" && a.status !== "draft") return 1;
          return b.version - a.version;
        });
        const draft = sorted.find((item) => item.status === "draft") ?? null;
        const latestPublished = sorted
          .filter((item) => item.status === "published")
          .sort((a, b) => b.version - a.version)[0] ?? null;
        const definition = (draft ?? latestPublished ?? sorted[0]).definition ?? ({} as AiSkillDefinition);
        return { skillId, versions: sorted, draft, latestPublished, definition };
      })
      .sort((a, b) => {
        if (a.draft && !b.draft) return -1;
        if (b.draft && !a.draft) return 1;
        return a.skillId.localeCompare(b.skillId);
      });
  }, [items]);
  return (
    <section className="automation-skill-versions">
      <div className="automation-skill-version-head">
        <div>
          <strong>{automationText("skillDraftsAndVersions", "Skill drafts and versions", "Skill 草稿与版本")}</strong>
          <span>{automationText("skillDraftsAndVersionsDetail", "Profiles only use published versions. A draft enters the execution path only after publication.", "Profile 只使用已发布版本；草稿需要发布后才会进入执行链路。")}</span>
        </div>
        <div className="automation-skill-version-summary">
          <span><b>{groupedItems.length}</b>Skill</span>
          <span><b>{drafts}</b>{automationText("drafts", "Drafts", "草稿")}</span>
          <span><b>{published}</b>{automationText("published", "Published", "已发布")}</span>
          <span><b>{items.length}</b>{automationText("versions", "Versions", "版本")}</span>
        </div>
      </div>
      {items.length === 0 ? (
        <SectionState icon={<Lightbulb size={20} />} title={automationText("skillVersionsEmpty", "No Skill versions", "暂无 Skill 版本")} detail="" />
      ) : (
        <div className="automation-skill-version-groups">
          {groupedItems.map((group) => {
            const detail = group.definition.description?.trim()
              || group.definition.rules?.trim()
              || group.definition.content?.trim().slice(0, 220)
              || group.skillId;
            const focused = group.versions.some((item) => focusId === item.id || focusId === item.sourceSuggestionId);
            return (
              <article className={clsx("automation-skill-version-card", focused && "focused")} key={group.skillId}>
                <div className="automation-skill-version-card-head">
                  <div>
                    <strong data-i18n-skip>{group.definition.name || group.skillId}</strong>
                    <span data-i18n-skip>{structuredPreview(detail, 160)}</span>
                  </div>
                  {group.draft ? (
                    <div className="automation-skill-version-actions">
                      <button disabled={busyId === group.draft.id} onClick={() => onDiscard(group.draft!)}>{automationText("discardDraft", "Discard draft", "丢弃草稿")}</button>
                      <button className="primary" disabled={busyId === group.draft.id} onClick={() => onPublish(group.draft!)}>{automationText("publishVersion", "Publish version", "发布版本")}</button>
                    </div>
                  ) : null}
                </div>
                <div className="automation-skill-version-facts">
                  <div className={clsx(group.draft && "attention")}>
                    <span>{automationText("currentDraft", "Current draft", "当前编辑草稿")}</span>
                    <strong>{group.draft ? `v${group.draft.version}` : automationText("none", "None", "无")}</strong>
                    <small>{group.draft ? automationText("createdAt", "Created {{time}}", "创建 {{time}}", { time: formatDateTime(group.draft.createdAt) }) : automationText("noPendingChanges", "No unpublished changes", "没有待发布修改")}</small>
                  </div>
                  <div>
                    <span>{automationText("latestPublished", "Latest published", "最新发布")}</span>
                    <strong>{group.latestPublished ? `v${group.latestPublished.version}` : "--"}</strong>
                    <small>{group.latestPublished?.publishedAt ? automationText("publishedAt", "Published {{time}}", "发布 {{time}}", { time: formatDateTime(group.latestPublished.publishedAt) }) : automationText("notPublished", "Not published", "尚未发布")}</small>
                  </div>
                  <div>
                    <span>{automationText("historicalVersions", "Version history", "历史版本")}</span>
                    <strong>{group.versions.length}</strong>
                    <small>{group.skillId}</small>
                  </div>
                </div>
                <div className="automation-skill-version-timeline">
                  {group.versions.map((item) => {
                    const versionFocused = focusId === item.id || focusId === item.sourceSuggestionId;
                    return (
                      <div className={clsx("automation-skill-version-row-compact", item.status, versionFocused && "focused")} key={item.id}>
                        <b>v{item.version}</b>
                        <StatusBadge status={item.status} />
                        <span>{item.sourceSuggestionId ? automationText("suggestionReference", "Suggestion {{id}}", "建议 {{id}}", { id: item.sourceSuggestionId }) : automationText("manualVersion", "Manual version", "手动版本")}</span>
                        <small>{item.publishedAt ? automationText("publishedAt", "Published {{time}}", "发布 {{time}}", { time: formatDateTime(item.publishedAt) }) : automationText("createdAt", "Created {{time}}", "创建 {{time}}", { time: formatDateTime(item.createdAt) })}</small>
                      </div>
                    );
                  })}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function NotificationsView({
  deliveries,
  profiles,
  focusId
}: {
  deliveries: AiNotificationDelivery[];
  profiles: Map<string, AiAgentProfile>;
  focusId?: string | null;
}) {
  return (
    <div className="automation-notifications-view">
      <div className="automation-subhead"><strong>{automationText("deliveryRecords", "Delivery records", "投递记录")}</strong><span>{automationText("recordCount", "{{count}} records", "{{count}} 条", { count: deliveries.length })}</span></div>
      {deliveries.length === 0 ? (
        <SectionState icon={<Bell size={22} />} title={automationText("deliveryEmpty", "No delivery records", "暂无通知记录")} detail={automationText("deliveryEmptyDetail", "Automation run, review, and error notifications appear here after delivery.", "自动化运行、复盘或错误通知发送后会显示在这里。")} />
      ) : (
        <div className="automation-list">
          {deliveries.map((item) => (
            <article className={clsx("automation-list-row", focusId === item.id && "focused")} key={item.id}>
              <div className="automation-row-main">
                <div><strong data-i18n-skip>{item.title}</strong><StatusBadge status={item.status} /></div>
                <p data-i18n-skip={Boolean(item.error || item.content)}>{item.error || item.content || automationText("channelNotification", "{{channel}} notification", "{{channel}} 通知", { channel: item.channel })}</p>
                <details className="automation-delivery-detail">
                  <summary>{automationText("viewNotificationMessage", "View notification message", "查看通知消息")}</summary>
                  <pre data-i18n-skip={Boolean(item.content || item.error)}>{item.content || item.error || automationText("notificationContentMissing", "Message content was not recorded", "未记录消息内容")}</pre>
                </details>
              </div>
              <div className="automation-row-meta">
                <span>{item.channel}</span>
                <span data-i18n-skip={Boolean(item.profileName || item.profileId)}>{item.profileName || (item.profileId ? profiles.get(item.profileId)?.name ?? item.profileId : automationText("profileNotBound", "No Profile bound", "未绑定 Profile"))}</span>
                {item.runId ? <span>Run {item.runId}</span> : null}
                <span>{automationText("createdAt", "Created {{time}}", "创建 {{time}}", { time: formatDateTime(item.createdAt) })}</span>
                <span>{automationText("sentAt", "Sent {{time}}", "发送 {{time}}", { time: formatDateTime(item.sentAt) })}</span>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function AiAutomationPanelComponent({
  accounts,
  marketAssets,
  watchlist,
  initialTab = "profiles",
  focusId,
  onNotify,
  onboardingActive = false,
  onProfileSaved
}: AiAutomationPanelProps) {
  const { t } = useTranslation(["automation", "common"]);
  const panelRef = useRef<HTMLDivElement>(null);
  const hasMountedMotionRef = useRef(false);
  const [summary, setSummary] = useState<AiAutomationSummary | null>(() => automationOverviewCache ? normalizeSummary({ ...EMPTY_AUTOMATION_SUMMARY, ...automationOverviewCache }) : null);
  const [aiConfig, setAiConfig] = useState<AiConfigSummary | null>(() => automationConfigCache);
  const [activeTab, setActiveTab] = useState<AiAutomationTab>(initialTab);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [scopeProfileId, setScopeProfileId] = useState("");
  const [profileDraft, setProfileDraft] = useState<AiAgentProfile | null>(null);
  // The editor is a dialog now: the grid is the resting state of this tab.
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  // Destructive and lossy actions route through an in-app dialog because the
  // Tauri webview rejects window.confirm.
  const [pendingConfirm, setPendingConfirm] = useState<{
    title: string;
    message: string;
    confirmText: string;
    danger?: boolean;
    onConfirm: () => void;
  } | null>(null);
  const [profileQuery, setProfileQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [sectionLoading, setSectionLoading] = useState<AiAutomationTab | null>(null);
  const [automationCounts, setAutomationCounts] = useState<AiAutomationCounts>(() => automationOverviewCache?.counts ?? EMPTY_AUTOMATION_COUNTS);
  const [loadedSections, setLoadedSections] = useState<Set<Exclude<AiAutomationTab, "profiles">>>(() => new Set(automationSectionCache.keys()));
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [systematicProfileConflict, setSystematicProfileConflict] = useState<SystematicProfileConflictConfirmation | null>(null);
  const summaryRequestIdRef = useRef(0);
  const appliedSummaryRequestIdRef = useRef(0);
  const sectionLoadPromisesRef = useRef(new Map<Exclude<AiAutomationTab, "profiles">, Promise<void>>());
  const runSectionRefreshTimerRef = useRef<number | null>(null);

  const applySummaryResponse = useCallback((requestId: number, rawSummary: AiAutomationSummary) => {
    if (requestId < appliedSummaryRequestIdRef.current) return null;
    appliedSummaryRequestIdRef.current = requestId;
    const next = normalizeSummary(rawSummary);
    setSummary(next);
    return next;
  }, []);

  const applyOverviewResponse = useCallback((requestId: number, overview: AiAutomationOverview) => {
    automationOverviewCache = overview;
    setAutomationCounts(overview.counts ?? EMPTY_AUTOMATION_COUNTS);
    return applySummaryResponse(requestId, {
      ...EMPTY_AUTOMATION_SUMMARY,
      ...(summary ?? {}),
      ...overview
    });
  }, [applySummaryResponse, summary]);

  const applySectionResponse = useCallback((section: Exclude<AiAutomationTab, "profiles">, value: AiAutomationSection) => {
    automationSectionCache.set(section, value);
    setLoadedSections((current) => {
      if (current.has(section)) return current;
      const next = new Set(current);
      next.add(section);
      return next;
    });
    setAutomationCounts((current) => {
      if (section === "runs") {
        return {
          ...current,
          runs: value.runs.length,
          runningRuns: value.runs.filter((item) => ["queued", "running"].includes(item.status)).length,
          notifications: value.notificationDeliveries.length
        };
      }
      if (section === "wake_conditions") {
        return {
          ...current,
          runs: value.runs.length,
          runningRuns: value.runs.filter((item) => ["queued", "running"].includes(item.status)).length,
          activeWakeConditions: value.wakeConditions.filter((item) => item.status === "active").length
        };
      }
      if (section === "reviews") {
        return { ...current, reviews: value.reviews.length + value.dailyMarketReviews.length };
      }
      if (section === "optimization") {
        return {
          ...current,
          pendingOptimizationSuggestions: value.optimizationSuggestions.filter((item) => ["pending", "pending_review", "validating", "ready"].includes(item.status)).length
        };
      }
      return { ...current, notifications: value.notificationDeliveries.length };
    });
    setSummary((current) => {
      if (!current) return current;
      if (section === "runs") {
        return normalizeSummary({ ...current, runs: value.runs, notificationDeliveries: value.notificationDeliveries });
      }
      if (section === "wake_conditions") {
        return normalizeSummary({ ...current, wakeConditions: value.wakeConditions, runs: value.runs });
      }
      if (section === "reviews") {
        return normalizeSummary({ ...current, reviews: value.reviews, dailyMarketReviews: value.dailyMarketReviews });
      }
      if (section === "optimization") {
        return normalizeSummary({ ...current, optimizationSuggestions: value.optimizationSuggestions, skillVersions: value.skillVersions });
      }
      return normalizeSummary({ ...current, notificationDeliveries: value.notificationDeliveries });
    });
  }, []);

  const loadSection = useCallback((section: Exclude<AiAutomationTab, "profiles">, silent = false, force = false): Promise<void> => {
    const cached = automationSectionCache.get(section);
    if (cached) applySectionResponse(section, cached);
    if (cached && !force) return Promise.resolve();
    if (!isTauriRuntime()) return Promise.resolve();
    const inFlight = sectionLoadPromisesRef.current.get(section);
    if (inFlight) return inFlight;
    if (!silent) setSectionLoading(section);
    const request = (async () => {
      const startedAt = performance.now();
      try {
        const value = await invokeDesktop<AiAutomationSection>("ai_automation_section", { section });
        if (value) applySectionResponse(section, value);
        logger.info("ai automation section loaded", { section, durationMs: Math.round(performance.now() - startedAt) });
      } catch (nextError) {
        logger.warn("ai automation section refresh failed", { section, error: nextError instanceof Error ? nextError.message : String(nextError) });
        if (!cached) setError(nextError instanceof Error ? nextError.message : String(nextError));
      } finally {
        setSectionLoading((current) => current === section ? null : current);
      }
    })();
    sectionLoadPromisesRef.current.set(section, request);
    void request.finally(() => {
      if (sectionLoadPromisesRef.current.get(section) === request) {
        sectionLoadPromisesRef.current.delete(section);
      }
    });
    return request;
  }, [applySectionResponse]);

  const refreshRunStatuses = useCallback(async (ids: string[]) => {
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    if (!isTauriRuntime() || uniqueIds.length === 0) return;
    try {
      const statuses = await invokeDesktop<AiAutomationRunStatus[]>("ai_automation_run_statuses", { ids: uniqueIds });
      if (!statuses?.length) return;
      const statusMap = new Map(statuses.map((item) => [item.id, item]));
      setSummary((current) => current ? {
        ...current,
        runs: current.runs.map((run) => {
          const status = statusMap.get(run.id);
          return status ? { ...run, ...status } : run;
        })
      } : current);
    } catch (nextError) {
      logger.warn("ai automation run status refresh failed", { error: nextError instanceof Error ? nextError.message : String(nextError) });
    }
  }, []);

  const refresh = useCallback(async (preferredProfileId?: string | null) => {
    if (!isTauriRuntime()) {
      setSummary(null);
      setLoading(false);
      setError(t("automation:workbenchDesktopOnly"));
      return;
    }
    const requestId = ++summaryRequestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const startedAt = performance.now();
      const [overview, config] = await Promise.all([
        invokeDesktop<AiAutomationOverview>("ai_automation_overview"),
        loadAiConfigSummary()
      ]);
      if (!overview) throw new Error(t("automation:workbenchEmptyOverview"));
      automationConfigCache = config;
      const next = applyOverviewResponse(requestId, overview);
      setAiConfig(config);
      if (!next) return;
      const targetId = preferredProfileId ?? selectedProfileId ?? (activeTab === "profiles" ? focusId : null);
      const selected = next.profiles.find((item) => item.id === targetId) ?? next.profiles[0] ?? null;
      setSelectedProfileId(selected?.id ?? null);
      setProfileDraft(selected ? normalizeProfile({ ...selected, model: resolveProfileModelId(selected.model, config) }) : null);
      // The Profiles grid reports each Profile's recent activity, which lives in
      // the runs section. Load it quietly alongside the overview so a card shows
      // its run count immediately instead of only after visiting the runs tab.
      if (activeTab === "profiles") await loadSection("runs", true, true);
      else await loadSection(activeTab, true, true);
      logger.info("ai automation overview loaded", { durationMs: Math.round(performance.now() - startedAt), tab: activeTab });
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      logger.error("ai automation summary failed", nextError);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [activeTab, applyOverviewResponse, focusId, loadSection, selectedProfileId, t]);

  useEffect(() => {
    void refresh();
    // The workbench is mounted on demand. It deliberately has no market subscriptions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setActiveTab(initialTab);
    if (initialTab !== "profiles") void loadSection(initialTab);
  }, [initialTab, loadSection]);

  useEffect(() => {
    const listenerCleanup = createDeferredCleanupSlot();
    void listenOptional<AiAutomationEvent>("ai:automation-event", (event) => {
      if (event.type === "runRecordUpdated") {
        automationSectionCache.delete("runs");
        if (activeTab === "runs") {
          if (runSectionRefreshTimerRef.current !== null) {
            window.clearTimeout(runSectionRefreshTimerRef.current);
          }
          runSectionRefreshTimerRef.current = window.setTimeout(() => {
            runSectionRefreshTimerRef.current = null;
            void loadSection("runs", true, true);
          }, 350);
        }
        return;
      }
      if (event.type === "reviewCreated") {
        void loadSection("reviews", true);
        return;
      }
      if (event.type === "suggestionCreated") {
        void loadSection("optimization", true);
        return;
      }
      if (event.type !== "runCompleted" && event.type !== "runFailed" && event.action?.tab !== "runs") return;
      const runId = event.action?.tab === "runs" ? event.action.id?.trim() : "";
      if (runId) {
        void refreshRunStatuses([runId]);
        return;
      }
      void loadSection("runs", true);
    }).then((dispose) => listenerCleanup.settle(dispose));
    return () => {
      if (runSectionRefreshTimerRef.current !== null) {
        window.clearTimeout(runSectionRefreshTimerRef.current);
        runSectionRefreshTimerRef.current = null;
      }
      listenerCleanup.dispose();
    };
  }, [activeTab, loadSection, refreshRunStatuses]);

  const activeRunIds = useMemo(
    () => (summary?.runs ?? [])
      .filter((item) => item.status === "queued" || item.status === "running")
      .map((item) => item.id),
    [summary?.runs]
  );
  useEffect(() => {
    if (activeTab !== "runs" || activeRunIds.length === 0 || !isTauriRuntime()) return;
    const intervalId = window.setInterval(() => void refreshRunStatuses(activeRunIds), 10_000);
    return () => window.clearInterval(intervalId);
  }, [activeRunIds, activeTab, refreshRunStatuses]);

  useEffect(() => {
    if (!scopeProfileId || !summary) return;
    if (!summary.profiles.some((profile) => profile.id === scopeProfileId)) {
      setScopeProfileId("");
    }
  }, [scopeProfileId, summary]);

  const profileMap = useMemo(() => new Map((summary?.profiles ?? []).map((item) => [item.id, item])), [summary?.profiles]);
  const skills = useMemo(() => aiConfig?.skillDefinitions ?? [], [aiConfig?.skillDefinitions]);
  const profileScopeOptions = useMemo(() => [
    { value: "", label: t("automation:workbenchAllProfiles") },
    ...(summary?.profiles ?? []).map((profile) => ({ value: profile.id, label: profile.name || profile.id }))
  ], [summary?.profiles, t]);

  const runCommand = useCallback(async (
    action: string,
    command: string,
    args: Record<string, unknown> | undefined,
    successTitle: string,
    successMessage: string,
    preferredProfileId?: string | null
  ) => {
    if (!isTauriRuntime()) {
      onNotify({ kind: "warning", title: t("common:desktopOnly"), message: t("automation:workbenchCommandDesktopOnly") });
      return false;
    }
    setBusyAction(action);
    setError(null);
    try {
      await invokeDesktop<unknown>(command, args);
      onNotify({ kind: "success", title: successTitle, message: successMessage });
      await refresh(preferredProfileId);
      return true;
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      logger.error(`ai automation command failed: ${command}`, nextError);
      setError(message);
      if (!message.includes("ACCOUNT_POSITION_MODE_SWITCH_FAILED:")) {
        onNotify({ kind: "error", title: t("automation:workbenchActionFailed", { action: successTitle }), message });
      }
      return false;
    } finally {
      setBusyAction(null);
    }
  }, [onNotify, refresh, t]);

  const saveMasterEnabled = useCallback((enabled: boolean) => {
    void runCommand(
      "master",
      "ai_automation_save_master_enabled",
      { enabled },
      enabled ? t("automation:workbenchEnabled") : t("automation:workbenchPaused"),
      enabled ? t("automation:workbenchEnabledMessage") : t("automation:workbenchPausedMessage")
    );
  }, [runCommand, t]);

  const saveAgentScheme = useCallback(async (scheme: AiAgentSchemeDraft): Promise<AiAgentScheme | null> => {
    if (!isTauriRuntime()) {
      onNotify({ kind: "warning", title: t("common:desktopOnly"), message: t("automation:collaborationSchemeSaveDesktopOnly") });
      return null;
    }
    setBusyAction("agent-scheme-save");
    setError(null);
    try {
      const raw = await invokeDesktop<AiAgentScheme>("ai_agent_scheme_save", { scheme });
      const saved = normalizeAgentScheme(raw);
      if (!saved) throw new Error(t("automation:collaborationInvalidSavedScheme"));
      setSummary((current) => current ? {
        ...current,
        agentSchemes: [...current.agentSchemes.filter((item) => item.id !== saved.id), saved]
          .sort((left, right) => Number(right.builtin) - Number(left.builtin) || right.updatedAt - left.updatedAt)
      } : current);
      onNotify({ kind: "success", title: t("automation:collaborationSchemeSaved"), message: t("automation:collaborationSchemeAgentCount", { name: saved.name, count: saved.agents.filter((agent) => agent.enabled).length }) });
      return saved;
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      logger.error("ai agent scheme save failed", nextError);
      setError(message);
      onNotify({ kind: "error", title: t("automation:collaborationSchemeSaveFailed"), message });
      return null;
    } finally {
      setBusyAction(null);
    }
  }, [onNotify, t]);

  const deleteAgentScheme = useCallback(async (id: string): Promise<boolean> => {
    if (!isTauriRuntime()) {
      onNotify({ kind: "warning", title: t("common:desktopOnly"), message: t("automation:collaborationSchemeDeleteDesktopOnly") });
      return false;
    }
    setBusyAction(`agent-scheme-delete:${id}`);
    setError(null);
    try {
      await invokeDesktop<void>("ai_agent_scheme_delete", { id });
      setSummary((current) => current ? {
        ...current,
        agentSchemes: current.agentSchemes.filter((scheme) => scheme.id !== id)
      } : current);
      setProfileDraft((current) => current?.multiAgentSchemeId === id
        ? { ...current, multiAgentSchemeId: null }
        : current);
      onNotify({ kind: "success", title: t("automation:collaborationSchemeDeleted"), message: t("automation:collaborationSchemeSnapshotRetained") });
      return true;
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      logger.error("ai agent scheme delete failed", nextError);
      setError(message);
      onNotify({ kind: "error", title: t("automation:collaborationSchemeDeleteFailed"), message });
      return false;
    } finally {
      setBusyAction(null);
    }
  }, [onNotify, t]);

  const persistProfile = useCallback((profile: AiAgentProfile, forceSystematicConflict: boolean) => {
    void runCommand(
      `profile-save:${profile.id}`,
      "ai_agent_profile_save",
      { profile, forceSystematicConflict },
      t("automation:profileSaved"),
      `${profile.name} · ${t(permissionModeI18nKey(profile.mode))}`,
      profile.id
    )
      .then((saved) => {
        if (saved) onProfileSaved?.(profile);
      });
  }, [onProfileSaved, runCommand, t]);

  const saveProfile = useCallback((forceSystematicConflict = false) => {
    if (!profileDraft) return;
    const name = profileDraft.name.trim();
    if (!name) {
      onNotify({ kind: "warning", title: t("automation:profileNotSaved"), message: t("automation:profileValidationNameRequired") });
      return;
    }
    if (!profileDraft.model) {
      onNotify({ kind: "warning", title: t("automation:profileNotSaved"), message: t("automation:profileValidationModelRequired") });
      return;
    }
    // Renaming onto an existing name is rejected rather than silently renumbered:
    // the user typed this name deliberately, so they decide how to resolve it.
    const duplicate = (summary?.profiles ?? []).find(
      (item) => item.id !== profileDraft.id && item.name.trim().toLowerCase() === name.toLowerCase()
    );
    if (duplicate) {
      onNotify({ kind: "warning", title: t("automation:profileNotSaved"), message: t("automation:profileValidationNameDuplicate", { name }) });
      return;
    }
    const multiAgents = profileDraft.multiAgents.slice(0, CUSTOM_AGENT_LIMIT).map((agent) => ({
      ...agent,
      id: agent.id.trim(),
      name: agent.name.trim(),
      role: agent.role.trim(),
      responsibility: agent.responsibility.trim(),
      scopes: Array.from(new Set(agent.scopes.map((scope) => scope.trim()).filter(Boolean)))
    }));
    const incompleteAgent = multiAgents.find((agent) => !agent.name || !agent.role || !agent.responsibility || agent.scopes.length === 0);
    if (incompleteAgent) {
      onNotify({ kind: "warning", title: t("automation:profileNotSaved"), message: t("automation:profileValidationAgentIncomplete", { name: incompleteAgent.name || t("automation:collaborationCustomAgent") }) });
      return;
    }
    const invalidAgentId = multiAgents.find((agent) => !/^[a-z][a-z0-9_-]{0,31}$/.test(agent.id));
    if (invalidAgentId) {
      onNotify({ kind: "warning", title: t("automation:profileNotSaved"), message: t("automation:profileValidationAgentIdInvalid", { name: invalidAgentId.name || t("automation:collaborationCustomAgent") }) });
      return;
    }
    if (profileDraft.multiAgentMode === "custom") {
      const enabledAgents = multiAgents.filter((agent) => agent.enabled);
      if (enabledAgents.length < 2) {
        onNotify({ kind: "warning", title: t("automation:profileNotSaved"), message: t("automation:profileValidationMinimumAgents", { count: 2 }) });
        return;
      }
      if (enabledAgents.length > profileDraft.multiAgentMaxAgents) {
        onNotify({ kind: "warning", title: t("automation:profileNotSaved"), message: t("automation:profileValidationAgentLimitExceeded", { count: enabledAgents.length, limit: profileDraft.multiAgentMaxAgents }) });
        return;
      }
      if (!profileDraft.accountId && enabledAgents.some((agent) => agent.scopes.includes("account"))) {
        onNotify({ kind: "warning", title: t("automation:profileNotSaved"), message: t("automation:profileValidationAccountScopeRequiresAccount") });
        return;
      }
    }
    const now = Date.now();
    const profile: AiAgentProfile = {
      ...profileDraft,
      name,
      mode: normalizePermissionMode(profileDraft.mode),
      targetLeverage: Math.max(1, Math.min(125, Math.round(profileDraft.targetLeverage) || 20)),
      maxSingleTradeMarginPct: Math.max(1, Math.min(100, Math.round(profileDraft.maxSingleTradeMarginPct) || 30)),
      symbols: Array.from(new Set(profileDraft.symbols.map((item) => item.trim().toUpperCase()).filter(Boolean))),
      skillIds: withRequiredProfileSkills(profileDraft.skillIds),
      skillVersions: profileDraft.skillVersions ?? {},
      skillVersionModes: profileDraft.skillVersionModes ?? {},
      reasoningDepth: profileDraft.reasoningDepth,
      allowedWakeConditionTypes: Array.from(new Set(profileDraft.allowedWakeConditionTypes)),
      multiAgentMode: profileDraft.multiAgentMode === "auto" || profileDraft.multiAgentMode === "custom" ? profileDraft.multiAgentMode : "off",
      multiAgentMaxAgents: Math.max(
        2,
        Math.min(
          profileDraft.multiAgentMode === "auto" ? AUTO_AGENT_LIMIT : CUSTOM_AGENT_LIMIT,
          Math.round(profileDraft.multiAgentMaxAgents) || 4
        )
      ),
      multiAgents,
      createdAt: profileDraft.createdAt || now,
      updatedAt: now
    };
    if (!profile.enabled || forceSystematicConflict || !isTauriRuntime()) {
      persistProfile(profile, forceSystematicConflict);
      return;
    }
    void invokeDesktop<SystematicProfileConflict[]>("ai_agent_profile_systematic_conflicts", {
      request: {
        accountId: profile.accountId,
        environment: profile.environment,
        symbols: profile.symbols
      }
    })
      .then((conflicts) => {
        if (conflicts?.length) {
          setSystematicProfileConflict({ profile, conflicts });
          return;
        }
        persistProfile(profile, false);
      })
      .catch((nextError) => {
        const message = nextError instanceof Error ? nextError.message : String(nextError);
        logger.error("strategy Profile conflict check failed", nextError);
        setError(message);
        onNotify({ kind: "error", title: t("automation:profileNotSaved"), message });
      });
  }, [onNotify, persistProfile, profileDraft, t]);

  // Enabling from a card persists just that flag; everything else is kept as
  // stored so a card toggle can never publish an unrelated half-finished edit.
  const toggleProfileEnabled = useCallback((profile: AiAgentProfile) => {
    persistProfile({ ...profile, enabled: !profile.enabled, updatedAt: Date.now() }, false);
  }, [persistProfile]);

  // Card actions operate on a given Profile rather than the open draft, so the
  // grid can act without first loading a Profile into the editor.
  const deleteProfileById = useCallback((profile: Pick<AiAgentProfile, "id" | "name">) => {
    const name = profile.name || t("automation:profileThisProfile");
    setPendingConfirm({
      title: t("automation:profileDelete"),
      message: t("automation:profileConfirmDelete", { name }),
      confirmText: t("common:delete"),
      danger: true,
      onConfirm: () => {
        void runCommand(`profile-delete:${profile.id}`, "ai_agent_profile_delete", { id: profile.id }, t("automation:profileDeleted"), profile.name || profile.id, null);
      }
    });
  }, [runCommand, t]);

  const runProfileById = useCallback((profile: Pick<AiAgentProfile, "id" | "name">) => {
    void runCommand(`profile-run:${profile.id}`, "ai_agent_profile_run_now", { id: profile.id }, t("automation:profileRunSubmitted"), t("automation:profileRunSubmittedMessage", { name: profile.name }), profile.id);
  }, [runCommand, t]);

  const deleteProfile = useCallback(() => {
    if (!profileDraft) return;
    deleteProfileById(profileDraft);
  }, [deleteProfileById, profileDraft]);

  const runProfileNow = useCallback(() => {
    if (!profileDraft) return;
    runProfileById(profileDraft);
  }, [profileDraft, runProfileById]);

  const runDailyReview = useCallback(() => {
    if (!profileDraft) return;
    void runCommand(
      `profile-daily-review:${profileDraft.id}`,
      "ai_agent_profile_run_daily_review",
      { id: profileDraft.id },
      t("automation:profileDailyReviewSubmitted"),
      t("automation:profileDailyReviewSubmittedMessage", { name: profileDraft.name }),
      profileDraft.id
    );
  }, [profileDraft, runCommand, t]);

  const handleTabClick = useCallback((id: AiAutomationTab) => {
    setActiveTab(id);
    // Opening a tab revalidates it. A cached section still renders immediately so
    // the layout stays stable, while a forced reload replaces it with current
    // data; only the uncached first load shows the loading state.
    if (id !== "profiles") void loadSection(id, Boolean(automationSectionCache.get(id)), true);
  }, [loadSection]);

  const saveUserWakeCondition = useCallback(async (draft: UserWakeConditionDraft) => {
    try {
      const profile = profileMap.get(draft.profileId);
      if (!profile) throw new Error(automationText("profileNotFound", "Agent Profile not found.", "Agent Profile 不存在。"));
      const allowedTypes = profile.allowedWakeConditionTypes.length > 0 ? profile.allowedWakeConditionTypes : DEFAULT_WAKE_CONDITION_TYPES;
      if (!allowedTypes.includes(draft.conditionType)) {
        throw new Error(automationText("wakeTypeNotAllowed", "This Profile does not allow {{type}}.", "Profile 未允许 {{type}}。", { type: wakeConditionLabel(draft.conditionType) }));
      }
      const condition = buildWakeCondition(draft);
      const conditionSymbol = typeof condition.instId === "string" ? condition.instId : "";
      const conditionAccountId = typeof condition.accountId === "string" ? condition.accountId : "";
      if (conditionSymbol && !profile.symbols.includes(conditionSymbol)) {
        throw new Error(automationText("symbolNotWatched", "{{symbol}} is not watched by this Profile.", "{{symbol}} 不在 Profile 的关注品种中。", { symbol: conditionSymbol }));
      }
      if (conditionAccountId && profile.accountId && conditionAccountId !== profile.accountId) {
        throw new Error(automationText("wakeAccountMismatch", "The wake-up condition account must match the account bound to the Profile.", "唤醒条件账户必须与 Profile 绑定账户一致。"));
      }
      const expiresAt = draft.expiresAt ? new Date(draft.expiresAt).getTime() : undefined;
      if (draft.expiresAt && !Number.isFinite(expiresAt)) throw new Error(automationText("invalidExpiration", "The expiration time is invalid.", "到期时间无效。"));
      if (expiresAt && (expiresAt <= Date.now() || expiresAt > Date.now() + 366 * 24 * 60 * 60_000)) {
        throw new Error(automationText("expirationWithinYear", "The expiration time must be within the next year.", "到期时间必须在未来一年内。"));
      }
      return await runCommand(
        `wake-save:${draft.conditionId ?? "new"}`,
        "ai_user_wake_condition_save",
        {
          profileId: draft.profileId,
          ...(draft.conditionId ? { conditionId: draft.conditionId } : {}),
          planMode: draft.planMode,
          condition,
          ...(expiresAt ? { expiresAt } : {})
        },
        automationText("wakeConditionSaved", "User wake-up condition saved", "用户唤醒条件已保存"),
        `${profile.name} · ${wakeConditionLabel(draft.conditionType)}`,
        draft.profileId
      );
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      onNotify({ kind: "warning", title: automationText("wakeConditionNotSaved", "Wake-up condition not saved", "唤醒条件未保存"), message });
      return false;
    }
  }, [onNotify, profileMap, runCommand]);

  const deleteUserWakeCondition = useCallback(async (item: AiWakeCondition) => {
    return runCommand(
      `wake-delete:${item.id}`,
      "ai_user_wake_condition_delete",
      { id: item.id },
      automationText("wakeConditionDeleted", "User wake-up condition deleted", "用户唤醒条件已删除"),
      wakeConditionLabel(item.conditionType),
      item.profileId
    );
  }, [runCommand]);

  const updateSuggestion = useCallback(async (id: string, status: string) => {
    const title = status === "rejected"
      ? automationText("suggestionRejected", "Optimization suggestion rejected", "优化建议已拒绝")
      : automationText("skillChangeAdopted", "Skill change adopted", "Skill 变更已采用");
    const message = status === "rejected"
      ? automationText("rejectedCandidateNoChange", "The candidate version will not modify any Skill.", "该候选版本不会修改任何 Skill。")
      : automationText("candidatePublished", "The candidate Skill is now active as a new published version.", "候选 Skill 已作为新的发布版本生效。");
    return runCommand(`suggestion:${id}`, "ai_optimization_suggestion_update", { id, status }, title, message );
  }, [runCommand]);

  const publishSkillVersion = useCallback((item: AiSkillVersion) => {
    setPendingConfirm({
      title: automationText("skillVersionPublish", "Publish skill version", "发布 Skill 版本"),
      message: automationText("confirmPublishSkill", "Publish {{skillId}} v{{version}}?", "确认发布 {{skillId}} v{{version}}？", { skillId: item.skillId, version: item.version }),
      confirmText: automationText("skillVersionPublishAction", "Publish", "发布"),
      onConfirm: () => {
        void runCommand(
          `skill-publish:${item.id}`,
          "ai_skill_version_publish",
          { id: item.id },
          automationText("skillVersionPublished", "Skill version published", "Skill 版本已发布"),
          `${item.skillId} · v${item.version}`
        );
      }
    });
  }, [runCommand]);

  const discardSkillVersion = useCallback((item: AiSkillVersion) => {
    setPendingConfirm({
      title: automationText("skillVersionDiscard", "Discard skill draft", "丢弃 Skill 草稿"),
      message: automationText("confirmDiscardSkill", "Discard the {{skillId}} v{{version}} draft?", "确认丢弃 {{skillId}} v{{version}} 草稿？", { skillId: item.skillId, version: item.version }),
      confirmText: automationText("skillVersionDiscardAction", "Discard", "丢弃"),
      danger: true,
      onConfirm: () => {
        void runCommand(
          `skill-discard:${item.id}`,
          "ai_skill_version_discard",
          { id: item.id },
          automationText("skillDraftDiscarded", "Skill draft discarded", "Skill 草稿已丢弃"),
          `${item.skillId} · v${item.version}`
        );
      }
    });
  }, [runCommand]);

  const selectProfile = useCallback((profile: AiAgentProfile) => {
    setSelectedProfileId(profile.id);
    setScopeProfileId(profile.id);
    setProfileDraft(normalizeProfile({ ...profile, model: resolveProfileModelId(profile.model, aiConfig) }));
    setProfileEditorOpen(true);
  }, [aiConfig?.activeModelId, aiConfig?.models]);

  // Unsaved edits are detected by comparing the draft with the stored Profile it
  // came from, normalized the same way, so no separate dirty flag can drift.
  const profileDraftDirty = useMemo(() => {
    if (!profileDraft) return false;
    const saved = (summary?.profiles ?? []).find((item) => item.id === profileDraft.id);
    // A Profile that was never saved is dirty by definition.
    if (!saved) return true;
    const baseline = normalizeProfile({ ...saved, model: resolveProfileModelId(saved.model, aiConfig) });
    return JSON.stringify(baseline) !== JSON.stringify(profileDraft);
  }, [aiConfig, profileDraft, summary?.profiles]);

  const closeProfileEditor = useCallback(() => {
    if (!profileDraftDirty) {
      setProfileEditorOpen(false);
      return;
    }
    setPendingConfirm({
      title: t("automation:profileUnsavedTitle"),
      message: t("automation:profileUnsavedDetail"),
      confirmText: t("automation:profileUnsavedDiscard"),
      danger: true,
      onConfirm: () => setProfileEditorOpen(false)
    });
  }, [profileDraftDirty, t]);

  const createNewProfile = useCallback(() => {
    const profile = createProfile(accounts, aiConfig?.activeModelId || aiConfig?.models[0]?.id || "");
    const desired = onboardingActive ? t("automation:profileOnboardingName") : t("automation:profileDefaultName");
    // Two Profiles sharing a name are indistinguishable in the grid, in run
    // records and in notifications, so the default gets the first free suffix.
    profile.name = uniqueProfileName(desired, summary?.profiles ?? []);
    setSelectedProfileId(profile.id);
    setProfileDraft(profile);
    setProfileEditorOpen(true);
  }, [accounts, aiConfig?.activeModelId, aiConfig?.models, onboardingActive, summary?.profiles, t]);

  // Trailing activity per Profile for the cards. The window must match the one the
  // backend uses for realised profit, otherwise the card mixes two periods in a
  // single row. The runs section loads lazily,
  // so an unloaded section yields an empty map and the card shows no claim at all
  // rather than a misleading "never run".
  const profileRecentRuns = useMemo(() => {
    const stats = new Map<string, { runs: number; failed: number; trades: number; lastAt: number | null }>();
    if (!loadedSections.has("runs")) return stats;
    const since = Date.now() - PROFILE_CARD_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    for (const run of summary?.runs ?? []) {
      const startedAt = Number(run.startedAt) || 0;
      if (startedAt < since) continue;
      const entry = stats.get(run.profileId) ?? { runs: 0, failed: 0, trades: 0, lastAt: null };
      entry.runs += 1;
      if (run.status === "failed") entry.failed += 1;
      // Runs record how many trade actions they took, not their P&L: realised
      // profit is attributed to fills, not to an automation run. Reporting trade
      // count keeps the card truthful instead of implying a return it cannot know.
      entry.trades += Number(run.actionCounts?.trade) || 0;
      entry.lastAt = Math.max(entry.lastAt ?? 0, startedAt) || null;
      stats.set(run.profileId, entry);
    }
    return stats;
  }, [loadedSections, summary?.runs]);

  // Realised 7-day result per Profile, supplied with the overview so the grid has
  // it on first paint. Absent means "not reported", which renders as no claim.
  const profilePerformance = useMemo(() => {
    const map = new Map<string, AiProfilePerformance>();
    for (const row of summary?.profilePerformance ?? []) map.set(row.profileId, row);
    return map;
  }, [summary?.profilePerformance]);

  const profiles = summary?.profiles ?? [];
  useEffect(() => {
    if (!onboardingActive || loading || !summary || activeTab !== "profiles" || profileDraft || profiles.length > 0) return;
    createNewProfile();
  }, [activeTab, createNewProfile, loading, onboardingActive, profileDraft, profiles.length, summary]);
  const scopeProfile = scopeProfileId ? profiles.find((profile) => profile.id === scopeProfileId) ?? null : null;
  const scopeRuns = scopeProfileId ? (summary?.runs ?? []).filter((item) => item.profileId === scopeProfileId) : (summary?.runs ?? []);
  const scopeWakeConditions = scopeProfileId ? (summary?.wakeConditions ?? []).filter((item) => item.profileId === scopeProfileId) : (summary?.wakeConditions ?? []);
  const automationNotificationDeliveries = (summary?.notificationDeliveries ?? []).filter((item) => !["systematic_profile_signal", "strategy_signal"].includes(item.relatedType ?? ""));
  const scopeNotificationDeliveries = scopeProfileId ? automationNotificationDeliveries.filter((item) => item.profileId === scopeProfileId) : automationNotificationDeliveries;
  const scopeOptimizationSuggestions = scopeProfileId && scopeProfile
    ? (summary?.optimizationSuggestions ?? []).filter((item) => profileUsesSkill(scopeProfile, item.currentSkillId))
    : (summary?.optimizationSuggestions ?? []);
  const normalizedProfileQuery = profileQuery.trim().toLowerCase();
  const filteredProfiles = normalizedProfileQuery
    ? profiles.filter((item) => [item.name, item.accountId, item.environment, ...item.symbols].some((value) => String(value ?? "").toLowerCase().includes(normalizedProfileQuery)))
    : profiles;
  const runningProfileIds = new Set((summary?.runs ?? []).filter((item) => ["queued", "running"].includes(item.status)).map((item) => item.profileId));
  const activeProfiles = profiles.filter((item) => item.enabled).length;
  const running = loadedSections.has("runs")
    ? (summary?.runs ?? []).filter((item) => ["queued", "running"].includes(item.status)).length
    : automationCounts.runningRuns;
  const pendingSuggestions = loadedSections.has("optimization")
    ? (summary?.optimizationSuggestions ?? []).filter((item) => ["pending", "pending_review", "validating", "ready"].includes(item.status)).length
    : automationCounts.pendingOptimizationSuggestions;
  const useOverviewCounts = !scopeProfileId;
  const tabCounts: Partial<Record<AiAutomationTab, number>> = {
    profiles: profiles.length,
    runs: useOverviewCounts ? automationCounts.runs : scopeRuns.length,
    wake_conditions: useOverviewCounts ? automationCounts.activeWakeConditions : scopeWakeConditions.filter((item) => item.status === "active").length,
    reviews: automationCounts.reviews,
    optimization: useOverviewCounts ? automationCounts.pendingOptimizationSuggestions : scopeOptimizationSuggestions.filter((item) => ["pending", "pending_review", "validating", "ready"].includes(item.status)).length,
    notifications: useOverviewCounts ? automationCounts.notifications : scopeNotificationDeliveries.length
  };
  const activeTabLabel = t(automationTabI18nKey(activeTab));
  const activeSectionLoaded = activeTab === "profiles" || loadedSections.has(activeTab);

  useGSAP(() => {
    if (!hasMountedMotionRef.current) {
      hasMountedMotionRef.current = true;
      return;
    }
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const content = panelRef.current?.querySelector(".automation-content-view");
    if (!content) return;
    gsap.fromTo(content, {
      autoAlpha: reduceMotion ? 1 : 0.84,
      y: reduceMotion ? 0 : 5
    }, {
      autoAlpha: 1,
      y: 0,
      duration: reduceMotion ? 0 : 0.2,
      ease: "power3.out",
      clearProps: "transform,opacity,visibility"
    });
    if (!reduceMotion) {
      const rows = content.querySelectorAll(".automation-profile-card, .automation-profile-item, .automation-list-row");
      if (rows.length > 0) {
        gsap.fromTo(rows, { autoAlpha: 0.82, y: 4 }, {
          autoAlpha: 1,
          y: 0,
          duration: 0.18,
          ease: "power2.out",
          stagger: { each: 0.025, from: "start" },
          clearProps: "transform,opacity,visibility"
        });
      }
    }
  }, { scope: panelRef, dependencies: [activeTab], revertOnUpdate: true });

  return (
    <WorkspaceFrame className="ai-automation-panel" tone="automation" ref={panelRef}>
      <header className="automation-overview">
        <label className="automation-master-toggle">
          <span className={clsx("automation-system-mark", summary?.masterEnabled && "active")}><Bot size={17} /></span>
          <span><strong>{t("automation:title")}</strong><small>{summary?.masterEnabled ? t("automation:workbenchListeningProfiles", { count: activeProfiles }) : t("automation:workbenchPausedDescription")}</small></span>
          <input
            type="checkbox"
            checked={summary?.masterEnabled ?? false}
            disabled={!summary || busyAction === "master"}
            onChange={(event) => saveMasterEnabled(event.target.checked)}
          />
          <span className="automation-toggle-track"><span /></span>
        </label>
        <div className="automation-metrics">
          <Metric label={t("automation:workbenchActiveProfiles")} value={activeProfiles} icon={<Workflow size={13} />} tone={activeProfiles > 0 ? "active" : undefined} />
          <Metric label={t("automation:running")} value={running} icon={<Activity size={13} />} tone={running > 0 ? "active" : undefined} />
          <Metric label={t("automation:workbenchPendingSuggestions")} value={pendingSuggestions} icon={<Lightbulb size={13} />} tone={pendingSuggestions > 0 ? "attention" : undefined} />
        </div>
        <button className="automation-icon-button" onClick={() => void refresh()} disabled={loading} title={t("automation:workbenchRefreshSummary")}>
          <RefreshCw className={loading ? "spin" : ""} size={16} />
        </button>
      </header>

      <nav className="automation-tabs" role="tablist" aria-label={t("automation:workbenchAria")}>
        {AUTOMATION_TABS.map(({ id, icon: Icon }) => (
          <button key={id} className={activeTab === id ? "active" : ""} role="tab" aria-selected={activeTab === id} onClick={() => handleTabClick(id)}>
            <Icon size={14} />
            <span>{t(automationTabI18nKey(id))}</span>
            <small className={clsx(tabCounts[id] ? "has-items" : undefined)}>{tabCounts[id] ?? 0}</small>
          </button>
        ))}
      </nav>

      {summary && activeTab !== "profiles" && activeTab !== "reviews" ? (
        <div className="automation-scope-bar">
          <div>
            <span>{t("automation:workbenchViewScope")}</span>
            <strong>{scopeProfile ? scopeProfile.name : t("automation:workbenchAllProfiles")}</strong>
          </div>
          <TerminalSelect
            ariaLabel={t("automation:workbenchScopeAria")}
            value={scopeProfileId}
            options={profileScopeOptions}
            onChange={setScopeProfileId}
          />
          {scopeProfileId ? (
            <button type="button" onClick={() => setScopeProfileId("")}>{t("automation:workbenchClearFilter")}</button>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="automation-error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => void refresh()} disabled={loading}>{t("common:retry")}</button>
        </div>
      ) : null}

      <section className={clsx("automation-content", activeTab === "runs" && "automation-content--runs")} data-onboarding-target={onboardingActive ? "profile" : undefined}>
        {sectionLoading === activeTab && summary ? (
          <div className={clsx("automation-section-loading", !activeSectionLoaded && "initial")} role="status" aria-live="polite">
            <Loader2 className="spin" size={15} />
            <span>{activeSectionLoaded ? t("automation:workbenchUpdatingSection", { section: activeTabLabel }) : t("automation:workbenchLoadingSection", { section: activeTabLabel })}</span>
          </div>
        ) : null}
        <div className="automation-content-view" key={activeTab}>
        {loading && !summary ? (
          <SectionState icon={<Loader2 className="spin" size={22} />} title={t("automation:workbenchReadingState")} detail={t("automation:workbenchReadingStateDetail")} />
        ) : !summary ? (
          <SectionState icon={<Bot size={22} />} title={t("automation:workbenchUnavailable")} detail={error || t("automation:workbenchNoSummary")} />
        ) : activeTab === "profiles" ? (
          <div className="automation-profiles-board">
            <div className="automation-subhead automation-profiles-board__head">
              <div><strong>{t("automation:profiles")}</strong><span>{t("common:itemCount", { count: profiles.length })}</span></div>
              <label className="automation-profile-search">
                <Search size={14} />
                <input value={profileQuery} onChange={(event) => setProfileQuery(event.target.value)} placeholder={t("automation:profileSearchPlaceholder")} />
                {profileQuery ? <button type="button" onClick={() => setProfileQuery("")} title={t("automation:profileClearSearch")}><X size={12} /></button> : null}
              </label>
              <button className="automation-create-profile" onClick={createNewProfile} title={t("automation:profileNew")}><Plus size={14} />{t("automation:profileCreate")}</button>
            </div>
            {profiles.length === 0 ? (
              <SectionState icon={<Bot size={20} />} title={t("automation:noProfiles")} detail={t("automation:profileEmptyDetail")} action={<button className="automation-empty-action" onClick={createNewProfile}><Plus size={14} />{t("automation:profileNew")}</button>} />
            ) : filteredProfiles.length === 0 ? (
              <SectionState icon={<Search size={20} />} title={t("automation:profileNoMatches")} detail={t("automation:profileNoMatchesDetail")} />
            ) : (
              <div className="automation-profile-grid">
                {filteredProfiles.map((profile) => (
                  <ProfileCard
                    key={profile.id}
                    profile={profile}
                    marketAssets={marketAssets}
                    running={runningProfileIds.has(profile.id)}
                    focused={focusId === profile.id}
                    recentRuns={profileRecentRuns.get(profile.id) ?? null}
                    performance={profilePerformance.get(profile.id) ?? null}
                    busy={Boolean(busyAction)}
                    onEdit={() => selectProfile(profile)}
                    onDelete={() => deleteProfileById(profile)}
                    onToggleEnabled={() => toggleProfileEnabled(profile)}
                  />
                ))}
              </div>
            )}
            {profileEditorOpen && profileDraft ? (
              <ProfileEditorDialog
                title={profileDraft.name || t("automation:profileUnnamed", { defaultValue: profileDraft.id })}
                dirty={profileDraftDirty}
                onClose={closeProfileEditor}
              >
                <ProfileEditor
                  draft={profileDraft}
                  accounts={accounts}
                  marketAssets={marketAssets}
                  watchlist={watchlist}
                  skills={skills}
                  skillVersions={summary.skillVersions}
                  models={aiConfig?.models ?? []}
                  agentSchemes={summary.agentSchemes}
                  busy={Boolean(busyAction)}
                  schemeBusy={Boolean(busyAction?.startsWith("agent-scheme"))}
                  onChange={(patch) => setProfileDraft((current) => current ? { ...current, ...patch } : current)}
                  onSaveScheme={saveAgentScheme}
                  onDeleteScheme={deleteAgentScheme}
                  onSave={saveProfile}
                  onRun={runProfileNow}
                  onDailyReview={runDailyReview}
                  onDelete={deleteProfile}
                />
              </ProfileEditorDialog>
            ) : null}
          </div>
        ) : activeTab === "runs" ? (
          <RunsView items={scopeRuns} profiles={profileMap} deliveries={scopeNotificationDeliveries} focusId={focusId} />
        ) : activeTab === "wake_conditions" ? (
          <WakeConditionsView
            items={scopeWakeConditions}
            runs={scopeRuns}
            profiles={scopeProfile ? new Map([[scopeProfile.id, scopeProfile]]) : profileMap}
            focusId={focusId}
            busy={Boolean(busyAction?.startsWith("wake-"))}
          />
        ) : activeTab === "reviews" ? (
          <ReviewsView items={summary.reviews} dailyItems={summary.dailyMarketReviews} focusId={focusId} />
        ) : activeTab === "optimization" ? (
          <SuggestionsView
            items={scopeOptimizationSuggestions}
            skillVersions={summary.skillVersions}
            focusId={focusId}
            busyId={busyAction?.startsWith("suggestion:") ? busyAction.slice("suggestion:".length) : null}
            onUpdate={updateSuggestion}
          />
        ) : (
          <NotificationsView deliveries={scopeNotificationDeliveries} profiles={profileMap} focusId={focusId} />
        )}
        </div>
      </section>
      {systematicProfileConflict ? (
        <SystematicProfileConflictDialog
          confirmation={systematicProfileConflict}
          onCancel={() => setSystematicProfileConflict(null)}
          onConfirm={() => {
            const pending = systematicProfileConflict;
            setSystematicProfileConflict(null);
            persistProfile(pending.profile, true);
          }}
        />
      ) : null}
      {pendingConfirm ? (
        <AutomationConfirmDialog
          title={pendingConfirm.title}
          message={pendingConfirm.message}
          confirmText={pendingConfirm.confirmText}
          danger={pendingConfirm.danger}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => {
            const pending = pendingConfirm;
            setPendingConfirm(null);
            pending.onConfirm();
          }}
        />
      ) : null}
    </WorkspaceFrame>
  );
}

export const AiAutomationPanel = memo(AiAutomationPanelComponent);

const AUTOMATION_PREVIEW_MARKET_REPORT = {
  status: "success",
  stance: "bearish",
  confidence: 72,
  timeHorizon: "4H-1D",
  evidence: [
    "BTC-USDT-SWAP 最新价 65,088.1，4H 结构维持低点下移。",
    "盘口卖方深度高于买方，短周期反弹承压。",
    "资金费率接近中性，暂未形成拥挤反转证据。"
  ],
  risks: ["清算密集区接近现价，追空存在滑点和快速反抽风险。"],
  invalidation: ["价格重新站稳 65,800 且成交量同步放大。"],
  missingData: ["15m 主动成交累积差尚未覆盖完整观察窗口。"],
  recommendation: "维持谨慎偏空观察，等待关键价位确认后再由主 Agent 决定是否建立交易机会。",
  veto: false,
  vetoReason: ""
};

const AUTOMATION_PREVIEW_RUN_DETAIL: AiAutomationRunDetail = {
  run: {
    id: "run-preview-multi-agent",
    profileId: "profile-preview-multi-agent",
    triggerType: "manual",
    status: "running",
    summary: "三个专家已并行读取市场、情报与账户证据；反方审查随后检查报告冲突，主 Agent 正在处理审查异常。",
    startedAt: Date.UTC(2026, 6, 23, 8, 30, 0),
    finishedAt: null,
    nextWakeAt: null,
    actionCounts: { opportunity: 0, wake: 0, trade: 0, notification: 0 },
    tokenUsage: {
      provider: "openai-compatible",
      modelId: "preview-model",
      model: "preview-reasoner",
      modelName: "Preview Reasoner",
      reported: true,
      agentCount: 4,
      usage: {
        inputTokens: 182450,
        outputTokens: 12380,
        cacheReadTokens: 65536,
        cacheWriteTokens: 0,
        reasoningTokens: 4200,
        totalTokens: 194830
      },
      mainUsage: {
        inputTokens: 32800,
        outputTokens: 3100,
        cacheReadTokens: 16384,
        cacheWriteTokens: 0,
        reasoningTokens: 1200,
        totalTokens: 35900
      }
    }
  },
  trigger: { type: "manual", source: "automation-preview" },
  profileSnapshot: {
    id: "profile-preview-multi-agent",
    name: "BTC 永续决策台",
    multiAgentMode: "custom",
    multiAgentMaxAgents: 4,
    symbols: ["BTC-USDT-SWAP"]
  },
  skillVersions: {
    "trading-philosophy": 3,
    "okx-news-intelligence": 2,
    "okx-smart-money-analysis": 2
  },
  assistantText: "正在汇总四路证据。",
  reasoning: "先并行建立市场结构、情报资金与账户风险证据，再由反方审查检查冲突，最后由主 Agent 单点汇总。",
  initialMarketSnapshot: null,
  finalDecision: null,
  toolEvents: [
    { type: "teamEvent", event: { type: "tasks_assigned", count: 4 } },
    { type: "agentStart", agentId: "preview-market-attempt-1", configuredAgentId: "market-structure", parentAgentId: "run-preview-multi-agent", role: "market-structure", title: "市场结构", task: "分析 K 线、盘口、资金费率和持仓量。" },
    { type: "agentDone", agentId: "preview-market-attempt-1", configuredAgentId: "market-structure", status: "failed", result: null, error: "首次连接超时，已自动重试。" },
    { type: "agentStart", agentId: "preview-market", configuredAgentId: "market-structure", parentAgentId: "run-preview-multi-agent", role: "market-structure", title: "市场结构", task: "分析 K 线、盘口、资金费率和持仓量。" },
    { type: "toolCall", toolCallId: "preview-market-ticker", name: "market.readTicker", arguments: { instId: "BTC-USDT-SWAP" }, allowed: true },
    { type: "toolResult", toolCallId: "preview-market-ticker", name: "market.readTicker", result: { last: "66420.1" }, summary: "最新行情已返回", ok: true },
    { type: "toolCall", toolCallId: "preview-market-candles", name: "market.readCandles", arguments: { instId: "BTC-USDT-SWAP", bar: "5m" }, allowed: true },
    { type: "toolResult", toolCallId: "preview-market-candles", name: "market.readCandles", result: { count: 288 }, summary: "5m K 线窗口完整", ok: true },
    {
      type: "agentDone",
      agentId: "preview-market",
      configuredAgentId: "market-structure",
      status: "done",
      result: {
        finishReason: "completed",
        iterations: 5,
        successfulTools: ["market.readTicker", "market.readCandles", "market.readFundingRate"],
        text: JSON.stringify(AUTOMATION_PREVIEW_MARKET_REPORT)
      }
    },
    { type: "agentStart", agentId: "preview-intelligence", configuredAgentId: "intelligence-flow", parentAgentId: "run-preview-multi-agent", role: "intelligence-flow", title: "情报资金", task: "核对新闻、宏观事件、Smart Money 与资金流。" },
    { type: "toolCall", toolCallId: "preview-news", agentId: "preview-intelligence", name: "intelligence.searchNews", arguments: { symbol: "BTC", limit: 20 }, allowed: true },
    { type: "toolResult", toolCallId: "preview-news", agentId: "preview-intelligence", name: "intelligence.searchNews", result: { count: 20 }, summary: "新闻证据已读取", ok: true },
    { type: "toolCall", toolCallId: "preview-smart-money", agentId: "preview-intelligence", name: "intelligence.readSmartMoney", arguments: { instId: "BTC-USDT-SWAP" }, allowed: true },
    { type: "agentStart", agentId: "preview-risk", configuredAgentId: "account-risk", parentAgentId: "run-preview-multi-agent", role: "account-risk", title: "账户风险", task: "检查仓位、保证金、挂单和最小规模预检。", startedAt: 1_784_810_010_000 },
    { type: "toolCall", toolCallId: "preview-risk-snapshot", agentId: "preview-risk", name: "account.readSnapshot", arguments: {}, allowed: true, startedAt: 1_784_810_011_000 },
    { type: "toolResult", toolCallId: "preview-risk-snapshot", agentId: "preview-risk", name: "account.readSnapshot", result: { marginRatio: "18.4" }, summary: "账户风险可控", ok: true, requestedAt: 1_784_810_011_000, executionStartedAt: 1_784_810_012_100, executionEndedAt: 1_784_810_012_250, endedAt: 1_784_810_012_250 },
    { type: "agentDone", agentId: "preview-risk", configuredAgentId: "account-risk", status: "done", result: "当前无冲突挂单，保证金余量充足。", endedAt: 1_784_810_014_000 },
    { type: "agentStart", agentId: "preview-challenger", configuredAgentId: "contrarian-review", parentAgentId: "run-preview-multi-agent", role: "contrarian", title: "反方审查", task: "读取第一阶段报告，寻找数据缺口、冲突证据和明确否决条件。" },
    { type: "toolCall", toolCallId: "preview-history", agentId: "preview-challenger", name: "history.readSimilarOpportunities", arguments: { instId: "BTC-USDT-SWAP" }, allowed: true },
    { type: "toolResult", toolCallId: "preview-history", agentId: "preview-challenger", name: "history.readSimilarOpportunities", result: null, summary: "历史样本读取超时", ok: false },
    { type: "agentDone", agentId: "preview-challenger", configuredAgentId: "contrarian-review", status: "failed", result: null, error: "历史相似机会读取超时，反方证据不完整。" },
    { type: "toolCall", toolCallId: "preview-opportunity", name: "tradeOpportunity.create", arguments: {}, allowed: true },
    {
      type: "toolResult",
      toolCallId: "preview-opportunity",
      name: "tradeOpportunity.create",
      result: {
        id: "opportunity-preview-short",
        instId: "BTC-USDT-SWAP",
        intent: "open",
        direction: "short",
        size: "0.02",
        lever: "10",
        price: "65800",
        entryCondition: "反弹至 65,800 附近且 5m 动能转弱",
        reason: "阻力区承压，等待限价入场。"
      },
      summary: "交易机会已创建",
      ok: true
    }
  ]
};

const AUTOMATION_PREVIEW_MODEL_ERROR_DETAIL: AiAutomationRunDetail = {
  ...AUTOMATION_PREVIEW_RUN_DETAIL,
  run: {
    ...AUTOMATION_PREVIEW_RUN_DETAIL.run,
    id: "run-preview-model-error",
    status: "failed",
    summary: "",
    error: "必需分析 Agent“市场结构”失败：Agent 报告不是有效 JSON",
    finishedAt: Date.UTC(2026, 6, 23, 8, 30, 1)
  },
  assistantText: "",
  reasoning: "模型服务在专家报告生成前返回计费错误。",
  toolEvents: [
    { type: "teamEvent", event: { type: "tasks_assigned", count: 1 } },
    {
      type: "agentStart",
      agentId: "preview-market-model-error",
      configuredAgentId: "market-structure",
      parentAgentId: "run-preview-model-error",
      role: "market-structure",
      title: "市场结构",
      task: "分析 K 线、盘口、资金费率和持仓量。",
      startedAt: Date.UTC(2026, 6, 23, 8, 30, 0)
    },
    {
      type: "agentDone",
      agentId: "preview-market-model-error",
      configuredAgentId: "market-structure",
      status: "failed",
      error: "Agent 报告不是有效 JSON",
      result: {
        finishReason: "error",
        iterations: 1,
        successfulTools: [],
        text: "Insufficient Balance"
      },
      endedAt: Date.UTC(2026, 6, 23, 8, 30, 1)
    }
  ]
};

const AUTOMATION_PREVIEW_SINGLE_RUN_DETAIL: AiAutomationRunDetail = {
  ...AUTOMATION_PREVIEW_RUN_DETAIL,
  run: {
    ...AUTOMATION_PREVIEW_RUN_DETAIL.run,
    id: "run-preview-single-agent",
    profileId: "profile-preview-single-agent",
    status: "completed",
    summary: "BTC-USDT-SWAP 当前临近重大宏观事件，价格结构与资金流信号相互冲突；本轮不创建新交易机会，保留已有保护单并等待下一次观察条件触发。",
    finishedAt: Date.UTC(2026, 6, 23, 8, 31, 15),
    actionCounts: { opportunity: 0, wake: 0, trade: 0, notification: 0 },
    tokenUsage: {
      ...AUTOMATION_PREVIEW_RUN_DETAIL.run.tokenUsage!,
      agentCount: 0,
      usage: {
        inputTokens: 69180,
        outputTokens: 394,
        cacheReadTokens: 69000,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 69574
      },
      mainUsage: {
        inputTokens: 69180,
        outputTokens: 394,
        cacheReadTokens: 69000,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 69574
      }
    }
  },
  trigger: { type: "scheduled", source: "automation-preview" },
  profileSnapshot: {
    id: "profile-preview-single-agent",
    name: "BTC 单 Agent 观察",
    multiAgentMode: "off",
    multiAgentMaxAgents: 0,
    symbols: ["BTC-USDT-SWAP"]
  },
  assistantText: "本轮没有形成新的可执行交易候选。",
  reasoning: "宏观事件临近且短周期证据相互冲突，维持现有风险保护，等待事件落地后再评估。",
  finalDecision: {
    outcome: "abandon",
    reason: "重大宏观事件即将公布，现有结构与资金流方向不一致；本轮不新增仓位，等待事件落地后重新评估。",
    reasonCodes: ["event_risk", "evidence_conflict"]
  },
  toolEvents: []
};

const AUTOMATION_PREVIEW_BASE_SKILL: AiSkillDefinition = {
  id: "trading-philosophy",
  name: "trading-philosophy",
  description: "永续合约决策与复盘规范。",
  rules: "区分事实、推断与建议；风险优先。",
  content: [
    "## 入场确认",
    "价格到达关键位置后，可以依据单次短周期反应形成候选。",
    "",
    "## 风险",
    "止损必须对应逻辑失效位置。"
  ].join("\n"),
  builtin: true
};

const AUTOMATION_PREVIEW_CANDIDATE_SKILL: AiSkillDefinition = {
  ...AUTOMATION_PREVIEW_BASE_SKILL,
  rules: "区分事实、推断与建议；风险优先；事件窗口内降低单次信号权重。",
  content: [
    "## 入场确认",
    "价格到达关键位置后，至少等待价格反应与成交证据形成一次独立确认。",
    "重大事件公布前 30 分钟，单次短周期反应不得单独形成候选。",
    "",
    "## 风险",
    "止损必须对应逻辑失效位置，并记录事件窗口造成的滑点风险。"
  ].join("\n")
};

const AUTOMATION_PREVIEW_OPTIMIZATION_SUGGESTION: AiOptimizationSuggestion = {
  id: "suggestion-preview-skill-diff",
  reviewId: "review-preview-btc",
  title: "收紧重大事件窗口内的入场确认",
  problem: "两次事件前交易都把单次短周期反应当作充分确认，决策证据强度与事件风险不匹配。",
  evidence: [
    "review-preview-btc：FOMC 公布前 18 分钟，仅依据一次 15m 反弹形成多头候选。",
    "review-preview-eth：CPI 公布前 24 分钟，同类单次反应随后被快速反转。"
  ],
  sampleSize: 2,
  currentSkillId: "trading-philosophy",
  currentSkillVersion: 4,
  proposedChanges: "为重大事件窗口增加独立确认要求，并明确单次短周期反应不能独立形成候选。",
  baselineSkill: AUTOMATION_PREVIEW_BASE_SKILL,
  proposedSkill: AUTOMATION_PREVIEW_CANDIDATE_SKILL,
  benefits: "减少高不确定性窗口内由单点证据触发的低质量候选。",
  risks: "确认条件更严格，可能错过事件前快速启动的行情。",
  status: "pending_review",
  createdAt: Date.now() - 120_000,
  updatedAt: Date.now() - 120_000
};

const AUTOMATION_PREVIEW_SKILL_VERSION: AiSkillVersion = {
  id: "skill-version-preview-v4",
  skillId: "trading-philosophy",
  version: 4,
  status: "published",
  definition: AUTOMATION_PREVIEW_BASE_SKILL,
  createdAt: Date.now() - 86_400_000,
  publishedAt: Date.now() - 86_400_000
};

const AUTOMATION_PREVIEW_DAILY_REVIEW: AiDailyMarketReview = {
  id: "daily-review-preview-btc",
  profileId: "profile-preview-btc",
  profileName: "BTC 日内观察",
  reviewDate: "2026-07-30",
  status: "completed",
  symbols: ["BTC-USDT-SWAP"],
  summary: "# BTC-USDT-SWAP 每日市场复盘\n\n价格在关键支撑附近震荡，等待新的成交与资金流证据。",
  runId: "run-preview-daily-review",
  createdAt: Date.now() - 3_600_000,
  updatedAt: Date.now() - 120_000
};

const AUTOMATION_PREVIEW_POSITION_REVIEW: AiAutomationReview = {
  id: "position-review-preview-btc",
  episodeId: "episode-BTC-USDT-SWAP-long-preview",
  status: "completed",
  summary: "回调做多交易复盘：入场证据基本成立，但持仓期间缺少中间评估记录。",
  findings: ["入场前完成了市场结构与账户风险检查。", "持仓期间没有保存新的复核证据。"],
  suggestions: ["在持仓超过预定周期时触发一次只读复核。"],
  netPnl: "-0.600",
  createdAt: Date.now() - 4 * 86_400_000,
  updatedAt: Date.now() - 180_000
};

export function AutomationPreview() {
  const requestedView = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("view") : null;
  const initialView = requestedView === "run" || requestedView === "single-run" || requestedView === "refresh" || requestedView === "model-error" || requestedView === "optimization" || requestedView === "reviews" ? requestedView : "config";
  const [view, setView] = useState<"config" | "run" | "single-run" | "refresh" | "model-error" | "optimization" | "reviews">(initialView);
  const singleAgentPreview = view === "single-run";
  const [previewSuggestions, setPreviewSuggestions] = useState<AiOptimizationSuggestion[]>([AUTOMATION_PREVIEW_OPTIMIZATION_SUGGESTION]);
  const [previewSchemes, setPreviewSchemes] = useState<AiAgentScheme[]>(() => createBuiltinAgentSchemes());
  const [collaboration, setCollaboration] = useState<Pick<AiAgentProfile, "multiAgentMode" | "multiAgentMaxAgents" | "multiAgentSchemeId" | "multiAgents">>(() => ({
    multiAgentMode: "custom",
    multiAgentMaxAgents: 4,
    multiAgentSchemeId: createBuiltinAgentSchemes()[0].id,
    multiAgents: createPerpetualDecisionTeam()
  }));
  const savePreviewScheme = async (draft: AiAgentSchemeDraft) => {
    const now = Date.now();
    const scheme: AiAgentScheme = {
      id: `preview-scheme-${now}`,
      name: draft.name,
      description: draft.description,
      builtin: false,
      agents: draft.agents.map((agent) => ({ ...agent, scopes: [...agent.scopes] })),
      createdAt: now,
      updatedAt: now
    };
    setPreviewSchemes((current) => [...current, scheme]);
    return scheme;
  };
  const deletePreviewScheme = async (id: string) => {
    setPreviewSchemes((current) => current.filter((scheme) => scheme.id !== id || scheme.builtin));
    return true;
  };
  const updatePreviewSuggestion = async (id: string, status: string) => {
    setPreviewSuggestions((current) => current.map((item) => item.id === id ? { ...item, status, updatedAt: Date.now() } : item));
    return true;
  };

  return (
    <main className="automation-preview-page" data-preview-view={view}>
      <div className="ai-automation-panel automation-preview-panel">
        <header className="automation-preview-head">
          <div><Workflow size={17} /><span><strong>{singleAgentPreview ? automationText("singleAgentProfile", "Single-Agent Profile", "单 Agent Profile") : automationText("multiAgentProfile", "Multi-Agent Profile", "多 Agent Profile")}</strong><small>{automationText("visualRegressionPreview", "Visual regression preview", "视觉回归预览")}</small></span></div>
          <nav role="tablist" aria-label={singleAgentPreview ? automationText("singleAgentPreviewAria", "Single-Agent preview", "单 Agent 预览视图") : automationText("multiAgentPreviewAria", "Multi-Agent preview", "多 Agent 预览视图")}>
            <button type="button" role="tab" aria-selected={view === "config"} className={view === "config" ? "active" : ""} onClick={() => setView("config")}>{automationText("configuration", "Configuration", "配置")}</button>
            <button type="button" role="tab" aria-selected={view === "run" || view === "single-run" || view === "model-error"} className={view === "run" || view === "single-run" || view === "model-error" ? "active" : ""} onClick={() => setView("run")}>{automationText("runTrace", "Run trace", "运行轨迹")}</button>
            <button type="button" role="tab" aria-selected={view === "reviews"} className={view === "reviews" ? "active" : ""} onClick={() => setView("reviews")}>{automationText("reviews", "Reviews", "复盘")}</button>
            <button type="button" role="tab" aria-selected={view === "optimization"} className={view === "optimization" ? "active" : ""} onClick={() => setView("optimization")}>{automationText("suggestions", "Optimization suggestions", "优化建议")}</button>
          </nav>
        </header>
        <section className="automation-preview-content">
          {view === "refresh" ? (
            <AutomationRunRefreshPreview />
          ) : view === "optimization" ? (
            <SuggestionsView
              items={previewSuggestions}
              skillVersions={[AUTOMATION_PREVIEW_SKILL_VERSION]}
              focusId={AUTOMATION_PREVIEW_OPTIMIZATION_SUGGESTION.id}
              busyId={null}
              onUpdate={updatePreviewSuggestion}
            />
          ) : view === "reviews" ? (
            <ReviewsView
              items={[AUTOMATION_PREVIEW_POSITION_REVIEW]}
              dailyItems={[AUTOMATION_PREVIEW_DAILY_REVIEW]}
              focusId={AUTOMATION_PREVIEW_DAILY_REVIEW.id}
            />
          ) : view === "config" ? (
            <div className="automation-profile-main automation-preview-profile-main">
              <div className="automation-profile-editor automation-preview-editor">
                <div className="automation-editor-head">
                  <div className="automation-editor-title">
                    <span className="automation-editor-mark"><Bot size={16} /></span>
                    <div data-i18n-skip><strong>BTC 永续决策台</strong><span>自定义团队 · 三路取证 · 一路反方审查</span></div>
                  </div>
                  <span className="automation-preview-readonly"><ShieldCheck size={12} />{automationText("subagentsReadOnly", "Subagents are read-only", "子 Agent 只读")}</span>
                </div>
                <ProfileCollaborationEditor
                  mode={collaboration.multiAgentMode}
                  maxAgents={collaboration.multiAgentMaxAgents}
                  agents={collaboration.multiAgents}
                  schemes={previewSchemes}
                  selectedSchemeId={collaboration.multiAgentSchemeId}
                  onChange={(patch) => setCollaboration((current) => ({ ...current, ...patch }))}
                  onSaveScheme={savePreviewScheme}
                  onDeleteScheme={deletePreviewScheme}
                />
              </div>
            </div>
          ) : (
            <div className="automation-preview-run">
              <RunDetailPanel detail={view === "model-error" ? AUTOMATION_PREVIEW_MODEL_ERROR_DETAIL : singleAgentPreview ? AUTOMATION_PREVIEW_SINGLE_RUN_DETAIL : AUTOMATION_PREVIEW_RUN_DETAIL} />
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function AutomationRunRefreshPreview() {
  const [completed, setCompleted] = useState(false);
  const completedRef = useRef(completed);
  completedRef.current = completed;
  const finishedAt = AUTOMATION_PREVIEW_RUN_DETAIL.run.startedAt + 42_000;
  const run: AiAutomationRun = completed
    ? { ...AUTOMATION_PREVIEW_RUN_DETAIL.run, status: "completed", summary: "主 Agent 已完成最终汇总。", finishedAt }
    : AUTOMATION_PREVIEW_RUN_DETAIL.run;
  const runRef = useRef(run);
  runRef.current = run;
  const readDetail = useCallback(async () => {
    const isCompleted = completedRef.current;
    if (!isCompleted) return AUTOMATION_PREVIEW_RUN_DETAIL;
    return {
      ...AUTOMATION_PREVIEW_RUN_DETAIL,
      run: { ...runRef.current, status: "completed", finishedAt },
      assistantText: "最终证据已汇总，运行完成。",
      toolEvents: [
        ...AUTOMATION_PREVIEW_RUN_DETAIL.toolEvents,
        {
          type: "agentDone",
          agentId: "preview-intelligence",
          configuredAgentId: "intelligence-flow",
          status: "done",
          result: { finishReason: "completed", successfulTools: ["intelligence.searchNews"], text: JSON.stringify(AUTOMATION_PREVIEW_MARKET_REPORT) },
          endedAt: finishedAt - 2_000
        }
      ]
    };
  }, [finishedAt]);

  useEffect(() => {
    const timerId = window.setTimeout(() => setCompleted(true), 1_200);
    return () => window.clearTimeout(timerId);
  }, []);

  const profile = normalizeProfile({
    ...createProfile([], "preview-model"),
    id: AUTOMATION_PREVIEW_RUN_DETAIL.run.profileId,
    name: "运行状态刷新测试"
  });
  return (
    <div className="automation-preview-run automation-refresh-preview">
      <RunsView
        items={[run]}
        profiles={new Map([[profile.id, profile]])}
        deliveries={[]}
        focusId={run.id}
        readDetail={readDetail}
      />
    </div>
  );
}

export default AiAutomationPanel;
