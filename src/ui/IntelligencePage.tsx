import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import clsx from "clsx";
import { WorkspaceFrame } from "./WorkspaceFrame";
import {
  Activity,
  BarChart3,
  BookOpen,
  CheckCheck,
  BrainCircuit,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  ExternalLink,
  Gauge,
  GitCompareArrows,
  Layers3,
  Newspaper,
  RefreshCw,
  Search,
  Settings2,
  Star,
  StarOff,
  Users,
  X
} from "lucide-react";
import type { AccountSummary, AiAgentProfile, AiAutomationOverview, MarketAssetsSummary } from "../types";
import {
  eligibleIntelligenceAccounts,
  generateBriefing,
  listenIntelligenceEvents,
  loadIntelligenceSummary,
  markActiveIntelligenceInstrument,
  queryAnomalies,
  queryBriefings,
  queryCalendar,
  queryDerivatives,
  queryNews,
  queryNewsFeed,
  queryNewsEvents,
  querySentiment,
  querySmartMoney,
  readNewsDetail,
  readNewsEvent,
  markNewsRead,
  saveIntelligenceSettings,
  syncIntelligence,
  trackSmartTrader,
  type IntelligenceRecord,
  type IntelligenceResponse,
  type IntelligenceSettings,
  type IntelligenceSummary,
  type NewsFeedPage,
  type NewsReadState
} from "../lib/intelligence";
import { logger } from "../lib/logger";
import { invokeDesktop, isTauriRuntime } from "../lib/tauri";
import { IntelligenceEvidenceChart } from "./IntelligenceEvidenceChart";
import { SymbolIcon, SymbolLabel } from "./SymbolIcon";
import { TerminalSelect } from "./TerminalSelect";
import { formatLocalizedDate, intelligenceLanguage, resolvedLocale } from "../i18n/runtime";

type IntelligenceTab = "news" | "sentiment" | "derivatives" | "smart" | "history";

type IntelligenceVisibleLoaders = {
  applySummary: (summary: IntelligenceSummary | null) => void;
  loadDerivatives: (remote?: boolean) => Promise<void>;
  loadNewsEvents: () => Promise<void>;
  loadNewsFeed: (options?: { page?: number; date?: Date; markSeen?: boolean }) => Promise<void>;
  loadNews: (localOnly?: boolean) => Promise<void>;
  loadSentiment: (localOnly?: boolean) => Promise<void>;
  loadSmart: (localOnly?: boolean) => Promise<void>;
};

type IntelligencePageProps = {
  accounts: AccountSummary[];
  marketAssets?: MarketAssetsSummary | null;
  selectedAccountId?: string | null;
  selectedSymbol?: string | null;
  relatedSymbols?: string[];
  onNewsUnreadCountChange?: (count: number) => void;
};

type TraderEvidence = {
  performance: IntelligenceRecord[];
  positions: IntelligenceRecord[];
  orders: IntelligenceRecord[];
  errors: string[];
};

const EMPTY_TRADER_EVIDENCE: TraderEvidence = {
  performance: [],
  positions: [],
  orders: [],
  errors: []
};

const TABS: Array<[IntelligenceTab, string, typeof Newspaper]> = [
  ["news", "news", Newspaper],
  ["sentiment", "sentiment", BarChart3],
  ["derivatives", "derivatives", Activity],
  ["smart", "smartMoney", Users],
  ["history", "history", Clock3]
];

function previewSummary(accountId: string): IntelligenceSummary {
  const now = Date.now();
  return {
    settings: {
      collectorAccountId: accountId,
      enabled: true,
      newsPollSeconds: 60,
      watchlistNewsPollSeconds: 300,
      sentimentPollMinutes: 5,
      smartMoneyPollMinutes: 5,
      leaderboardPollMinutes: 60,
      trackedTraderPollMinutes: 30,
      calendarPollHours: 6,
      derivativesPollMinutes: 5,
      activeDerivativesPollSeconds: 60,
      derivativesSlowPollMinutes: 60,
      activeDerivativesRiskPollMinutes: 5,
      derivativesRiskPollMinutes: 60,
      extraInstruments: [],
      briefingEnabled: false,
      briefingProfileId: null,
      articleContentRetentionDays: 180,
      fetchLogRetentionDays: 30,
      derivativesFiveMinuteRetentionDays: 180,
      derivativesHourlyRetentionDays: 730,
      liquidationRetentionDays: 180
    },
    syncStates: [{ key: "news", status: "success", lastSucceededAt: now - 42_000, nextRunAt: now + 78_000, rowsWritten: 24 }],
    counts: { news: 18420, sentiment: 8750, calendar: 1130, smartTraders: 420, smartSignals: 9600 },
    latestNews: [
      { id: "preview-news-1", title: "BTC 永续资金费率回落，现货成交保持活跃", summary: "市场风险偏好中性偏多，短周期需结合宏观事件窗口确认。", platform: "OKX News", publishTime: now - 11 * 60_000, sentiment: "bullish", importance: "high", coins: ["BTC"] },
      { id: "preview-news-2", title: "美国重要通胀数据将在晚间公布", summary: "预期波动窗口临近，杠杆仓位应关注滑点与资金费率变化。", platform: "Economic Wire", publishTime: now - 38 * 60_000, sentiment: "neutral", importance: "high", coins: ["BTC", "ETH"] },
      { id: "preview-news-3", title: "ETH 链上活跃度连续三日上升", summary: "活跃地址与稳定币流入同步改善，但尚不足以单独形成交易信号。", platform: "Crypto Brief", publishTime: now - 75 * 60_000, sentiment: "bullish", importance: "low", coins: ["ETH"] }
    ],
    sentimentRankings: [
      { id: "preview-sentiment-btc", ccy: "BTC", bullishRatio: 0.61, bearishRatio: 0.39, mentionCount: 8420, sentiment: "bullish" },
      { id: "preview-sentiment-eth", ccy: "ETH", bullishRatio: 0.54, bearishRatio: 0.46, mentionCount: 6110, sentiment: "bullish" },
      { id: "preview-sentiment-sol", ccy: "SOL", bullishRatio: 0.43, bearishRatio: 0.57, mentionCount: 2840, sentiment: "bearish" },
      { id: "preview-sentiment-xrp", ccy: "XRP", bullishRatio: 0.49, bearishRatio: 0.51, mentionCount: 1980, sentiment: "neutral" }
    ],
    economicEvents: [
      { id: "preview-event-1", eventTime: now, region: "US", event: "CPI 同比", importance: "high", previous: "2.7%", forecast: "", actual: "" },
      { id: "preview-event-2", eventTime: now + 28 * 3_600_000, region: "US", event: "初请失业金人数", importance: "medium", previous: "", forecast: "", actual: "" }
    ],
    smartTraders: [
      { authorId: "preview-trader-alpha", nickname: "Delta Alpha", pnl: "+184,200", winRate: "64.2%", maxDrawdown: "8.1%" },
      { authorId: "preview-trader-beta", nickname: "Basis Lab", pnl: "+121,740", winRate: "59.8%", maxDrawdown: "6.7%" },
      { authorId: "preview-trader-gamma", nickname: "Northstar", pnl: "+98,110", winRate: "57.1%", maxDrawdown: "11.3%" }
    ],
    smartSignals: [
      { id: "preview-signal-btc", instCcy: "BTC", weightedLongRatio: "58%", weightedShortRatio: "42%", netNotionalUsdt: "+3.8M", tradersWithPosition: 86, smartMoneyLongAvgEntry: "117,420" },
      { id: "preview-signal-eth", instCcy: "ETH", weightedLongRatio: "53%", weightedShortRatio: "47%", netNotionalUsdt: "+1.4M", tradersWithPosition: 61, smartMoneyLongAvgEntry: "3,820" },
      { id: "preview-signal-sol", instCcy: "SOL", weightedLongRatio: "39%", weightedShortRatio: "61%", netNotionalUsdt: "-0.8M", tradersWithPosition: 44, smartMoneyLongAvgEntry: "184.6" }
    ],
    trackedTraders: [{ authorId: "preview-trader-alpha", nickname: "Delta Alpha", createdAt: now - 86_400_000, updatedAt: now - 42_000 }]
  };
}

function previewNewsEvents(): IntelligenceRecord[] {
  const now = Date.now();
  return [
    {
      id: "preview-event-btc-funding",
      title: "BTC 持仓量上升，资金费率保持温和",
      summary: "价格与 OI 同步抬升，主动买入占优，但精英仓位拥挤度开始高于普通账户。",
      coins: ["BTC", "ETH", "NVDA"], sources: ["OKX News", "Market Wire"], importance: "high", sentiment: "bullish",
      status: "confirmed", firstPublishedAt: now - 76 * 60_000, lastPublishedAt: now - 18 * 60_000,
      articleCount: 3, sourceCount: 2, multiSourceConfirmed: true,
      reactionMeta: { mode: "multi_coin", requestedCoins: ["BTC", "ETH", "NVDA"], resolvedCoins: ["BTC", "ETH"], unsupportedCoins: ["NVDA"], requestedCount: 3, coveredCount: 2, truncated: false },
      articles: [
        { id: "preview-news-1", title: "BTC 永续持仓量继续上升", platform: "OKX News", publishTime: now - 76 * 60_000, summary: "OI 与价格同步上涨。" },
        { id: "preview-news-4", title: "资金费率仍处于温和区间", platform: "Market Wire", publishTime: now - 18 * 60_000, summary: "市场尚未出现极端多头融资成本。" }
      ],
      reactions: [
        { eventId: "preview-event-btc-funding", instId: "BTC-USDT-SWAP", windowMinutes: 5, status: "complete", priceReturnPct: 0.18, oiChangePct: 0.42, netTakerFlow: 3280000, liquidationSampleCount: 2 },
        { eventId: "preview-event-btc-funding", instId: "BTC-USDT-SWAP", windowMinutes: 30, status: "complete", priceReturnPct: 0.74, oiChangePct: 1.26, netTakerFlow: 12378000, liquidationSampleCount: 7 },
        { eventId: "preview-event-btc-funding", instId: "BTC-USDT-SWAP", windowMinutes: 120, status: "complete", priceReturnPct: 1.03, oiChangePct: 4.46, netTakerFlow: 21378000, liquidationSampleCount: 12 },
        { eventId: "preview-event-btc-funding", instId: "BTC-USDT-SWAP", windowMinutes: 1440, status: "pending_window" },
        { eventId: "preview-event-btc-funding", coin: "ETH", mappingType: "direct", instId: "ETH-USDT-SWAP", windowMinutes: 5, status: "complete", priceReturnPct: 0.11, oiChangePct: 0.31, netTakerFlow: 1280000, liquidationSampleCount: 1 },
        { eventId: "preview-event-btc-funding", coin: "ETH", mappingType: "direct", instId: "ETH-USDT-SWAP", windowMinutes: 30, status: "complete", priceReturnPct: 0.39, oiChangePct: 0.82, netTakerFlow: 4380000, liquidationSampleCount: 3 },
        { eventId: "preview-event-btc-funding", coin: "ETH", mappingType: "direct", instId: "ETH-USDT-SWAP", windowMinutes: 120, status: "complete", priceReturnPct: 0.72, oiChangePct: 1.78, netTakerFlow: 7380000, liquidationSampleCount: 5 },
        { eventId: "preview-event-btc-funding", coin: "ETH", mappingType: "direct", instId: "ETH-USDT-SWAP", windowMinutes: 1440, status: "pending_window" }
      ]
    },
    {
      id: "preview-event-us-cpi",
      title: "美国通胀数据公布窗口临近",
      summary: "宏观波动窗口临近，BTC 与 ETH 的短期期权和永续资金成本均需观察。",
      coins: ["BTC", "ETH"], sources: ["Economic Wire"], importance: "high", sentiment: "neutral",
      status: "developing", firstPublishedAt: now - 42 * 60_000, lastPublishedAt: now - 12 * 60_000,
      articleCount: 2, sourceCount: 1, multiSourceConfirmed: false,
      articles: [{ id: "preview-news-2", title: "美国重要通胀数据将在晚间公布", platform: "Economic Wire", publishTime: now - 42 * 60_000 }],
      reactions: []
    },
    {
      id: "preview-event-eth-network",
      title: "ETH 链上活跃度连续三日改善",
      summary: "活跃地址和稳定币流入改善，但衍生品仓位暂未形成一致确认。",
      coins: ["ETH"], sources: ["Crypto Brief"], importance: "low", sentiment: "bullish",
      status: "quiet", firstPublishedAt: now - 5 * 3_600_000, lastPublishedAt: now - 3 * 3_600_000,
      articleCount: 1, sourceCount: 1, multiSourceConfirmed: false,
      articles: [{ id: "preview-news-3", title: "ETH 链上活跃度连续三日上升", platform: "Crypto Brief", publishTime: now - 5 * 3_600_000 }],
      reactions: []
    },
    {
      id: "preview-event-market-wide",
      title: "全球风险资产波动加剧",
      summary: "该事件没有明确币种标签，使用 BTC 永续作为加密市场代理观察。",
      coins: [], sources: ["Macro Wire"], importance: "high", sentiment: "neutral",
      status: "developing", firstPublishedAt: now - 38 * 60_000, lastPublishedAt: now - 20 * 60_000,
      articleCount: 1, sourceCount: 1, multiSourceConfirmed: false,
      reactionMeta: { mode: "market_proxy", requestedCoins: [], resolvedCoins: [], unsupportedCoins: [], requestedCount: 0, coveredCount: 1, proxyInstId: "BTC-USDT-SWAP", truncated: false },
      articles: [{ id: "preview-news-market", title: "全球风险资产波动加剧", platform: "Macro Wire", publishTime: now - 38 * 60_000 }],
      reactions: [
        { eventId: "preview-event-market-wide", coin: "BTC", mappingType: "btc_market_proxy", instId: "BTC-USDT-SWAP", windowMinutes: 5, status: "complete", priceReturnPct: -0.12, oiChangePct: 0.18, netTakerFlow: -980000, liquidationSampleCount: 2 },
        { eventId: "preview-event-market-wide", coin: "BTC", mappingType: "btc_market_proxy", instId: "BTC-USDT-SWAP", windowMinutes: 30, status: "complete", priceReturnPct: -0.31, oiChangePct: 0.46, netTakerFlow: -2380000, liquidationSampleCount: 4 },
        { eventId: "preview-event-market-wide", coin: "BTC", mappingType: "btc_market_proxy", instId: "BTC-USDT-SWAP", windowMinutes: 120, status: "pending_window" },
        { eventId: "preview-event-market-wide", coin: "BTC", mappingType: "btc_market_proxy", instId: "BTC-USDT-SWAP", windowMinutes: 1440, status: "pending_window" }
      ]
    }
  ];
}

function localDayStart(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function newsDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function newsDateRange(date: Date) {
  const start = localDayStart(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { startTime: start.getTime(), endTime: end.getTime() };
}

function previewDerivatives() {
  const now = Date.now();
  const positioning: IntelligenceRecord[] = [];
  const takerFlow: IntelligenceRecord[] = [];
  const crowding: IntelligenceRecord[] = [];
  const fundingBasis: IntelligenceRecord[] = [];
  for (let index = 0; index < 72; index += 1) {
    const ts = now - (71 - index) * 20 * 60_000;
    const wave = Math.sin(index / 6) * 220 + Math.cos(index / 13) * 95;
    const last = 64_980 + index * 8.2 + wave;
    const oiUsd = 27_100_000_000 + index * 31_000_000 + Math.sin(index / 4) * 420_000_000;
    const buyVol = 620_000_000 + Math.sin(index / 2.7) * 180_000_000 + index * 1_600_000;
    const sellVol = 580_000_000 + Math.cos(index / 3.3) * 175_000_000;
    positioning.push({ instId: "BTC-USDT-SWAP", ts, last, oiUsd, oi: oiUsd / last, volumeUsd: buyVol + sellVol });
    if (index === 36) positioning.push({ instId: "BTC-USDT-SWAP", ts: ts + 250, oiUsd });
    takerFlow.push({ instId: "BTC-USDT-SWAP", ts, buyVol, sellVol, netVol: buyVol - sellVol });
    crowding.push({ instId: "BTC-USDT-SWAP", ts, accountRatio: 0.91 + Math.sin(index / 9) * 0.06, topAccountRatio: 1.08 + Math.sin(index / 8 + 0.5) * 0.08, topPositionRatio: 1.22 + Math.cos(index / 10) * 0.1 });
    fundingBasis.push({ instId: "BTC-USDT-SWAP", ts, fundingRate: 0.000063 + Math.sin(index / 8) * 0.000012, nextFundingRate: 0.000068 + Math.sin(index / 9) * 0.000014, premium: 0.00012 + Math.cos(index / 7) * 0.00005, markPrice: last + 7.8, indexPrice: last, basis: 7.8 });
  }
  return {
    positioning,
    takerFlow,
    crowding,
    fundingBasis,
    liquidations: Array.from({ length: 12 }, (_, index) => ({ id: `preview-liquidation-${index}`, instId: "BTC-USDT-SWAP", ts: now - index * 58 * 60_000, side: index % 3 ? "long" : "short", sz: 18 + index * 2, bkPx: 64_200 + index * 48 })),
    systemRisk: [{ instId: "BTC-USDT-SWAP", ts: now, insuranceBalance: 283_000_000, upperLimit: 66705, lowerLimit: 64305, adlState: "normal" }],
    anomalies: [{ id: "preview-anomaly-oi", kind: "oi_change", label: "OI 异常变化", instId: "BTC-USDT-SWAP", severity: "medium", bucketAt: now - 22 * 60_000, value: 4.46, robustZScore: 3.62, coverage: 0.98 }]
  };
}

function textField(record: IntelligenceRecord, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number") return String(value);
  }
  return "";
}

function numberField(record: IntelligenceRecord, ...keys: string[]) {
  const text = textField(record, ...keys);
  if (!text.trim()) return null;
  const percent = text.trim().endsWith("%");
  const value = Number(text.replaceAll(",", "").replace(/%$/, ""));
  return Number.isFinite(value) ? (percent ? value / 100 : value) : null;
}

function recordId(record: IntelligenceRecord, prefix: string) {
  return textField(record, "id", "newsId", "eventId", "authorId", "posId", "ordId") || `${prefix}-${JSON.stringify(record).slice(0, 80)}`;
}

function formatTime(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "--";
  const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  return formatLocalizedDate(new Date(milliseconds), {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function formatRatio(record: IntelligenceRecord, ...keys: string[]) {
  const value = numberField(record, ...keys);
  if (value === null) return "--";
  const percent = Math.abs(value) <= 1 ? value * 100 : value;
  return `${percent.toFixed(3)}%`;
}

function numericValue(value: unknown) {
  const raw = String(value ?? "").trim().replaceAll(",", "").replace("$", "");
  const match = raw.match(/^([+-]?\d+(?:\.\d+)?)\s*([KMBT])?$/i);
  const multiplier = match?.[2]
    ? ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 } as const)[match[2].toUpperCase() as "K" | "M" | "B" | "T"]
    : 1;
  const numeric = match ? Number(match[1]) * multiplier : Number.NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

function formatCompact(value: unknown, options: { signed?: boolean; currency?: boolean } = {}) {
  const numeric = numericValue(value);
  if (numeric === null) return typeof value === "string" && value.trim() ? value : "--";
  const sign = options.signed && numeric > 0 ? "+" : "";
  const formatted = new Intl.NumberFormat(resolvedLocale(), {
    notation: Math.abs(numeric) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: Math.abs(numeric) >= 100 ? 1 : 2
  }).format(numeric);
  return `${sign}${options.currency ? "$" : ""}${formatted}`;
}

function formatFixed(value: unknown, digits = 3, options: { signed?: boolean; currency?: boolean } = {}) {
  const numeric = numericValue(value);
  if (numeric === null) return "--";
  const sign = options.signed && numeric > 0 ? "+" : "";
  const formatted = new Intl.NumberFormat(resolvedLocale(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(numeric);
  return `${sign}${options.currency ? "$" : ""}${formatted}`;
}

function formatPrice(value: unknown) {
  const numeric = numericValue(value);
  if (numeric === null) return "--";
  const absolute = Math.abs(numeric);
  const digits = absolute >= 1000 ? 2 : absolute >= 1 ? 4 : absolute >= 0.01 ? 6 : 8;
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits
  }).format(numeric);
}

function sentimentLabel(value: string) {
  const normalized = value.trim().toLowerCase();
  if (["bullish", "positive"].includes(normalized)) return "偏多";
  if (["bearish", "negative"].includes(normalized)) return "偏空";
  if (["neutral", "mixed"].includes(normalized)) return "中性";
  return value || "未分类";
}

function importanceLabel(value: string) {
  if (value === "3" || value.toLowerCase() === "high") return "高";
  if (value === "2" || value.toLowerCase() === "medium") return "中";
  if (value === "1" || value.toLowerCase() === "low") return "低";
  return value || "--";
}

function sideLabel(value: string) {
  const normalized = value.toLowerCase();
  if (["long", "buy"].includes(normalized)) return "多";
  if (["short", "sell"].includes(normalized)) return "空";
  return value || "--";
}

function localizedSentimentLabel(value: string, t: TFunction) {
  if (value === "偏多") return t("intelligence:bullish");
  if (value === "偏空") return t("intelligence:bearish");
  if (value === "中性") return t("intelligence:neutral");
  if (value === "未分类") return t("intelligence:unclassified");
  return value;
}

function localizedImportanceLabel(value: string, t: TFunction) {
  if (value === "高") return t("intelligence:high");
  if (value === "中") return t("intelligence:medium");
  if (value === "低") return t("trading:low");
  return value;
}

function localizedSideLabel(value: string, t: TFunction) {
  if (value === "多") return t("intelligence:long");
  if (value === "空") return t("intelligence:short");
  return value;
}

function localizeIntelligenceStatus(value: string, t: TFunction) {
  const fixed: Record<string, string> = {
    "读取本地情报库": "loadingLocal", "本地情报库已加载": "localLoaded", "市场情报加载失败": "loadFailed",
    "市场情报仅可在桌面应用中使用": "desktopOnly",
    "请选择实盘只读账户": "selectLiveReadOnly", "正在同步 OKX 市场情报": "syncing", "市场情报同步完成": "syncCompleted",
    "市场情报同步失败": "syncFailed", "采集账户已更新": "collectorUpdated", "采集账户保存失败": "collectorSaveFailed",
    "市场情报设置已保存": "settingsSaved", "市场情报设置保存失败": "settingsSaveFailed", "新闻事件查询失败": "newsEventsFailed",
    "本地衍生品证据已加载": "localDerivativesLoaded", "衍生品远端刷新完成": "derivativesRemoteRefreshed",
    "衍生品证据加载失败": "derivativesLoadFailed", "新闻查询失败": "newsQueryFailed", "远端刷新失败，显示本地历史": "newsRemoteFailedLocal",
    "情绪与宏观本地数据已更新": "sentimentLocalUpdated", "情绪与宏观数据已刷新": "sentimentRefreshed",
    "情绪数据加载失败": "sentimentLoadFailed", "经济日历已从本地更新": "calendarLocalUpdated",
    "经济日历远端刷新完成": "calendarRemoteRefreshed", "经济日历加载失败": "calendarLoadFailed",
    "聪明钱本地数据已更新": "smartMoneyLocalUpdated", "聪明钱数据已刷新": "smartMoneyRefreshed",
    "聪明钱数据加载失败": "smartMoneyLoadFailed", "交易员证据已加载": "traderEvidenceLoaded",
    "交易员详情加载失败": "traderDetailsFailed", "历史查询失败": "historyQueryFailed",
    "请先在市场情报设置中选择每日简报 Agent Profile": "briefingProfileRequired",
    "市场简报已进入只读 Agent 队列": "briefingQueued", "市场简报生成失败": "briefingFailed"
  };
  if (fixed[value]) return t(`intelligence:${fixed[value]}`);
  const patterns: Array<[RegExp, string]> = [
    [/^新闻事件 (\d+) 个$/, "newsEventResultCount"], [/^新闻结果 (\d+) 条$/, "newsResultCount"],
    [/^本地历史 (\d+) 条$/, "localHistoryCount"], [/^衍生品证据部分可用，(\d+) 项加载失败$/, "derivativesPartiallyAvailable"]
  ];
  for (const [pattern, key] of patterns) {
    const match = value.match(pattern);
    if (match) return t(`intelligence:${key}`, { count: Number(match[1]) });
  }
  return value;
}

function recordArray(record: IntelligenceRecord | null | undefined, key: string) {
  const value = record?.[key];
  return Array.isArray(value) ? value.filter((item): item is IntelligenceRecord => Boolean(item) && typeof item === "object") : [];
}

function recordObject(record: IntelligenceRecord | null | undefined, key: string) {
  const value = record?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as IntelligenceRecord : {};
}

function NewsReactionPanel({ event, marketAssets }: { event: IntelligenceRecord; marketAssets?: MarketAssetsSummary | null }) {
  const { t } = useTranslation("intelligence");
  const [selectedInstId, setSelectedInstId] = useState("");
  const reactions = recordArray(event, "reactions");
  const meta = recordObject(event, "reactionMeta");
  const groups = useMemo(() => {
    const grouped = new Map<string, { instId: string; coin: string; mappingType: string; items: IntelligenceRecord[] }>();
    for (const reaction of reactions) {
      const instId = textField(reaction, "instId") || "BTC-USDT-SWAP";
      const current = grouped.get(instId) ?? {
        instId,
        coin: textField(reaction, "coin") || instId.split("-")[0],
        mappingType: textField(reaction, "mappingType") || (textField(meta, "mode") === "market_proxy" ? "btc_market_proxy" : "direct"),
        items: []
      };
      current.items.push(reaction);
      grouped.set(instId, current);
    }
    return [...grouped.values()].sort((left, right) => left.coin.localeCompare(right.coin));
  }, [meta, reactions]);
  const activeGroup = groups.find((group) => group.instId === selectedInstId) ?? groups[0];
  const requestedCoins = Array.isArray(meta.requestedCoins) ? meta.requestedCoins.map(String) : [];
  const unsupportedCoins = Array.isArray(meta.unsupportedCoins) ? meta.unsupportedCoins.map(String) : [];
  const requestedCount = Number(meta.requestedCount ?? requestedCoins.length);
  const coveredCount = Number(meta.coveredCount ?? groups.length);
  const marketProxy = textField(meta, "mode") === "market_proxy";
  const eventAt = numberField(event, "firstPublishedAt") ?? Date.now();

  useEffect(() => {
    setSelectedInstId("");
  }, [event.id]);

  return (
    <section className="intelligence-reaction-section">
      <header>
        <GitCompareArrows size={14} />
        <strong>{t("marketReaction")}</strong>
        <span>{marketProxy ? t("btcMarketProxy") : t("coveredCoins", { covered: coveredCount, requested: requestedCount })}</span>
      </header>
      <div className="intelligence-reaction-targets">
        <div role="tablist" aria-label={t("reactionPairs")}>
          {groups.map((group) => (
            <button
              type="button"
              role="tab"
              aria-selected={activeGroup?.instId === group.instId}
              className={activeGroup?.instId === group.instId ? "active" : undefined}
              key={group.instId}
              onClick={() => setSelectedInstId(group.instId)}
              title={group.instId}
            >
              <SymbolIcon
                base={group.coin}
                iconPath={marketAssets?.instruments.find((item) => item.instId === group.instId)?.iconPath}
                cached={marketAssets?.instruments.find((item) => item.instId === group.instId)?.iconCached}
                cacheDir={marketAssets?.cacheDir}
              />
              {group.coin}{group.mappingType === "btc_market_proxy" ? ` ${t("proxy")}` : ""}
            </button>
          ))}
        </div>
        {unsupportedCoins.length ? <span title={t("noLocalPerpetualCoverage", { coins: unsupportedCoins.join(", ") })}>{t("uncoveredCoins", { coins: unsupportedCoins.join("/") })}</span> : null}
        {Boolean(meta.truncated) ? <span>{t("firstFiveOnly")}</span> : null}
      </div>
      <div className="intelligence-reaction-grid">
        {[5, 30, 120, 1440].map((windowMinutes) => {
          const reaction = activeGroup?.items.find((item) => Number(item.windowMinutes) === windowMinutes);
          const windowMatured = Date.now() >= eventAt + windowMinutes * 60_000;
          const reactionStatus = textField(reaction ?? {}, "status");
          const isComplete = reactionStatus === "complete" && numberField(reaction ?? {}, "priceReturnPct") !== null;
          const resultLabel = isComplete ? formatPercent(numberField(reaction ?? {}, "priceReturnPct")) : windowMatured ? t("insufficientData") : t("waitingWindow");
          const detail = isComplete
            ? t("reactionDetail", { oi: formatPercent(numberField(reaction ?? {}, "oiChangePct")), flow: formatCompact(textField(reaction ?? {}, "netTakerFlow"), { signed: true }), crowding: formatRatio(reaction ?? {}, "crowdingDelta"), funding: formatRatio(reaction ?? {}, "fundingRateDelta"), basis: formatPrice(textField(reaction ?? {}, "basisDelta")), liquidations: Number(reaction?.liquidationSampleCount ?? 0) })
            : windowMatured ? t("reactionEvidenceInsufficient") : t("reactionComputedAfter", { time: formatTime(eventAt + windowMinutes * 60_000) });
          return (
            <div key={windowMinutes} title={detail}>
              <span>{windowMinutes === 1440 ? "24h" : windowMinutes === 120 ? "2h" : `${windowMinutes}m`}</span>
              <strong className={isComplete && (numberField(reaction ?? {}, "priceReturnPct") ?? 0) < 0 ? "negative" : isComplete ? "positive" : undefined}>{resultLabel}</strong>
              <small>OI {isComplete ? formatPercent(numberField(reaction ?? {}, "oiChangePct")) : "--"}</small>
              <small>{t("netFlow")} {isComplete ? formatCompact(textField(reaction ?? {}, "netTakerFlow"), { signed: true }) : "--"}</small>
              <small>{t("liquidationSamples")} {isComplete ? Number(reaction?.liquidationSampleCount ?? 0) : "--"}</small>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function latestRecord(records: IntelligenceRecord[]) {
  return records.reduce<IntelligenceRecord | null>((latest, record) => {
    const time = numberField(record, "ts", "bucketAt", "eventAt", "fundingTime") ?? 0;
    const latestTime = latest ? numberField(latest, "ts", "bucketAt", "eventAt", "fundingTime") ?? 0 : -1;
    return time >= latestTime ? record : latest;
  }, null);
}

function firstRecord(records: IntelligenceRecord[]) {
  return records.reduce<IntelligenceRecord | null>((first, record) => {
    const time = numberField(record, "ts", "bucketAt", "eventAt", "fundingTime") ?? Number.MAX_SAFE_INTEGER;
    const firstTime = first ? numberField(first, "ts", "bucketAt", "eventAt", "fundingTime") ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
    return time <= firstTime ? record : first;
  }, null);
}

function percentageChange(current: unknown, previous: unknown) {
  const currentValue = numericValue(current);
  const previousValue = numericValue(previous);
  if (currentValue === null || previousValue === null || previousValue === 0) return null;
  return (currentValue - previousValue) / previousValue * 100;
}

function formatPercent(value: number | null, digits = 2) {
  if (value === null || !Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

const CALENDAR_DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

function calendarTimestampMilliseconds(value: unknown) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
  return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
}

function calendarDayKey(value: unknown) {
  const timestamp = calendarTimestampMilliseconds(value);
  return timestamp > 0 ? CALENDAR_DAY_FORMATTER.format(new Date(timestamp)) : "";
}

function calendarDateFromKey(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return new Date();
  return new Date(year, month - 1, day, 12);
}

function weekCalendarDays(dayKey: string) {
  const anchor = calendarDateFromKey(dayKey);
  const offset = (anchor.getDay() + 6) % 7;
  const weekStart = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - offset, 12);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + index, 12);
    return { date, key: CALENDAR_DAY_FORMATTER.format(date) };
  });
}

function monthCalendarDays(anchor: Date) {
  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const offset = (monthStart.getDay() + 6) % 7;
  const gridStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1 - offset);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index);
    return {
      date,
      key: CALENDAR_DAY_FORMATTER.format(date),
      inMonth: date.getMonth() === anchor.getMonth()
    };
  });
}

function calendarEventTimestamp(record: IntelligenceRecord) {
  return calendarTimestampMilliseconds(record.eventTime ?? record.ts ?? record.time);
}

function calendarClock(value: unknown) {
  const timestamp = calendarTimestampMilliseconds(value);
  if (!timestamp) return "--:--";
  return new Intl.DateTimeFormat(resolvedLocale(), {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(timestamp));
}

function calendarImportanceScore(value: string) {
  const label = importanceLabel(value);
  return label === "高" ? 3 : label === "中" ? 2 : 1;
}

function calendarRegionFlag(value: string) {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "";
  return String.fromCodePoint(...[...code].map((character) => 127397 + character.charCodeAt(0)));
}

function previewTraderEvidence(record: IntelligenceRecord): TraderEvidence {
  return {
    performance: [record],
    positions: [
      { id: "preview-position-btc", instId: "BTC-USDT-SWAP", side: "long", size: "2.4", entryPrice: "65420.2841", lastPrice: "66186.51", leverage: "5", unrealizedPnl: "1840.2567", notionalUsd: "157008.681", positionIntensity: "0.6942" },
      { id: "preview-position-eth", instId: "ETH-USDT-SWAP", side: "short", size: "18", entryPrice: "3826.1849", lastPrice: "3791.72", leverage: "3", unrealizedPnl: "-620.4812", notionalUsd: "68868.321", positionIntensity: "0.3058" }
    ],
    orders: [
      { id: "preview-order-1", instId: "BTC-USDT-SWAP", side: "buy", size: "1.2", fillPrice: "65080", updatedAt: Date.now() - 38 * 60_000 },
      { id: "preview-order-2", instId: "ETH-USDT-SWAP", side: "sell", size: "8", fillPrice: "3841", updatedAt: Date.now() - 92 * 60_000 }
    ],
    errors: []
  };
}

function downloadRecords(name: string, records: IntelligenceRecord[], format: "json" | "csv") {
  const content = format === "json"
    ? JSON.stringify(records, null, 2)
    : (() => {
        const keys = Array.from(new Set(records.flatMap((record) => Object.keys(record))));
        const cell = (value: unknown) => `"${String(typeof value === "object" ? JSON.stringify(value) : value ?? "").replaceAll('"', '""')}"`;
        return [keys.map(cell).join(","), ...records.map((record) => keys.map((key) => cell(record[key])).join(","))].join("\n");
      })();
  const blob = new Blob([content], { type: format === "json" ? "application/json" : "text/csv" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${name}-${new Date().toISOString().slice(0, 10)}.${format}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function ResultMeta({ response }: { response: IntelligenceResponse | null }) {
  const { t } = useTranslation("intelligence");
  if (!response) return null;
  const version = /^(v|preview|local)/i.test(response.sourceVersion) ? response.sourceVersion : `v${response.sourceVersion}`;
  const age = Math.max(0, response.ageMs ?? Date.now() - (response.dataAt ?? response.fetchedAt));
  const refreshStatus = response.refreshStatus ?? "";
  const freshness = response.stale
    ? t("stale")
    : age <= 15_000
      ? t("realTime")
      : age <= 90_000
        ? t("oneMinute")
        : t("fiveMinutes");
  const refreshLabel = response.refreshQueued || refreshStatus === "queued" || refreshStatus === "running"
    ? t("refreshing")
    : refreshStatus === "failed"
      ? t("refreshFailed")
      : null;
  return (
    <div className="intelligence-result-meta">
      <span>{response.source} · {version}</span>
      <b className={response.stale ? "stale" : "fresh"}>{freshness}</b>
      <span title={t("fetchedAt", { time: formatTime(response.fetchedAt) })}>{t("dataTime", { time: formatTime(response.dataAt ?? response.fetchedAt) })}</span>
      {refreshLabel ? <b className={refreshStatus === "failed" ? "failed" : "refreshing"}>{refreshLabel}</b> : null}
      {response.dataVersion ? <span>{t("dataVersion", { version: response.dataVersion })}</span> : null}
      {response.staleReason ? <span title={response.staleReason} data-i18n-skip>{t("dataGap")}</span> : null}
      {response.truncated ? <b>{t("resultTruncated")}</b> : null}
    </div>
  );
}

export function IntelligencePage({ accounts, marketAssets, selectedAccountId, selectedSymbol, relatedSymbols = [], onNewsUnreadCountChange }: IntelligencePageProps) {
  const { t, i18n } = useTranslation(["intelligence", "common", "trading"]);
  const eligibleAccounts = useMemo(() => eligibleIntelligenceAccounts(accounts), [accounts]);
  const previewMarket = useMemo(previewDerivatives, []);
  const [tab, setTab] = useState<IntelligenceTab>("news");
  const [summary, setSummary] = useState<IntelligenceSummary | null>(null);
  const [accountId, setAccountId] = useState(() => selectedAccountId ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState("读取本地情报库");
  const [news, setNews] = useState<IntelligenceRecord[]>([]);
  const [newsMode, setNewsMode] = useState<"events" | "articles">("events");
  const [newsRelevantOnly, setNewsRelevantOnly] = useState(false);
  const [newsEvents, setNewsEvents] = useState<IntelligenceRecord[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<IntelligenceRecord | null>(null);
  const [eventDetail, setEventDetail] = useState<IntelligenceRecord | null>(null);
  const autoOpenedNewsEventRef = useRef(false);
  const [newsResponse, setNewsResponse] = useState<IntelligenceResponse | null>(null);
  const [newsFeedPage, setNewsFeedPage] = useState<NewsFeedPage | null>(null);
  const [newsReadState, setNewsReadState] = useState<NewsReadState | null>(null);
  const [newsDate, setNewsDate] = useState(() => localDayStart(new Date()));
  const [newsPage, setNewsPage] = useState(1);
  const [newsKeyword, setNewsKeyword] = useState("");
  const [newsCoin, setNewsCoin] = useState("");
  const [newsImportance, setNewsImportance] = useState<"all" | "high">("all");
  const [selectedNews, setSelectedNews] = useState<IntelligenceRecord | null>(null);
  const [newsDetail, setNewsDetail] = useState<IntelligenceRecord | null>(null);
  const [sentiment, setSentiment] = useState<IntelligenceRecord[]>([]);
  const [sentimentResponse, setSentimentResponse] = useState<IntelligenceResponse | null>(null);
  const [sentimentCoin, setSentimentCoin] = useState("BTC");
  const [calendar, setCalendar] = useState<IntelligenceRecord[]>([]);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [selectedCalendarDay, setSelectedCalendarDay] = useState(() => CALENDAR_DAY_FORMATTER.format(new Date()));
  const [hoveredCalendarDay, setHoveredCalendarDay] = useState<string | null>(null);
  const [calendarView, setCalendarView] = useState<"week" | "month">("week");
  const [calendarImportantOnly, setCalendarImportantOnly] = useState(false);
  const [calendarResponse, setCalendarResponse] = useState<IntelligenceResponse | null>(null);
  const calendarRequestIdRef = useRef(0);
  const [derivativesSymbol, setDerivativesSymbol] = useState(selectedSymbol?.endsWith("-SWAP") ? selectedSymbol : "BTC-USDT-SWAP");
  const [derivativesSearch, setDerivativesSearch] = useState(selectedSymbol?.endsWith("-SWAP") ? selectedSymbol : "BTC-USDT-SWAP");
  const [derivativesPickerOpen, setDerivativesPickerOpen] = useState(false);
  const derivativesPickerRef = useRef<HTMLDivElement | null>(null);
  const [derivativesPeriod, setDerivativesPeriod] = useState<"5m" | "1H" | "4H" | "1D">("5m");
  const [positioning, setPositioning] = useState<IntelligenceRecord[]>([]);
  const [takerFlow, setTakerFlow] = useState<IntelligenceRecord[]>([]);
  const [crowding, setCrowding] = useState<IntelligenceRecord[]>([]);
  const [fundingBasis, setFundingBasis] = useState<IntelligenceRecord[]>([]);
  const [liquidations, setLiquidations] = useState<IntelligenceRecord[]>([]);
  const [systemRisk, setSystemRisk] = useState<IntelligenceRecord[]>([]);
  const [anomalies, setAnomalies] = useState<IntelligenceRecord[]>([]);
  const [derivativesResponse, setDerivativesResponse] = useState<IntelligenceResponse | null>(null);
  const derivativesRequestIdRef = useRef(0);
  const [smartSignals, setSmartSignals] = useState<IntelligenceRecord[]>([]);
  const [smartTrend, setSmartTrend] = useState<IntelligenceRecord[]>([]);
  const [smartTraders, setSmartTraders] = useState<IntelligenceRecord[]>([]);
  const [smartResponse, setSmartResponse] = useState<IntelligenceResponse | null>(null);
  const [selectedTrader, setSelectedTrader] = useState<IntelligenceRecord | null>(null);
  const [traderEvidence, setTraderEvidence] = useState<TraderEvidence>(EMPTY_TRADER_EVIDENCE);
  const [historyKind, setHistoryKind] = useState<"news" | "events" | "sentiment" | "calendar" | "derivatives" | "anomalies" | "briefings" | "smart">("news");
  const [history, setHistory] = useState<IntelligenceRecord[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<IntelligenceSettings | null>(null);
  const [briefingProfiles, setBriefingProfiles] = useState<AiAgentProfile[]>([]);

  const applySummary = useCallback((next: IntelligenceSummary | null) => {
    if (!next) return;
    setSummary(next);
    setNews((current) => current.length > 0 ? current : next.latestNews);
    setSentiment((current) => current.length > 0 ? current : next.sentimentRankings);
    setCalendar((current) => current.length > 0 ? current : next.economicEvents);
    setSmartSignals((current) => current.length > 0 ? current : next.smartSignals);
    setSmartTrend((current) => current.length > 0 ? current : next.smartSignals);
    setSmartTraders((current) => current.length > 0 ? current : next.smartTraders);
    setAccountId((current) => current || next.settings.collectorAccountId || eligibleAccounts[0]?.id || "");
    setStatus("本地情报库已加载");
  }, [eligibleAccounts]);

  useEffect(() => {
    void loadIntelligenceSummary().then((value) => {
      applySummary(value ?? (!isTauriRuntime() && eligibleAccounts[0] ? previewSummary(eligibleAccounts[0].id) : null));
    }).catch((error) => {
      logger.error("intelligence summary load failed", error);
      setStatus(error instanceof Error ? error.message : "市场情报加载失败");
    });
  }, [applySummary]);

  useEffect(() => {
    if (selectedSymbol?.endsWith("-SWAP")) {
      setDerivativesSymbol(selectedSymbol);
      setDerivativesSearch(selectedSymbol);
    }
  }, [selectedSymbol]);

  useEffect(() => {
    if (!isTauriRuntime() || !derivativesSymbol) return;
    void markActiveIntelligenceInstrument(derivativesSymbol).catch((error) => {
      logger.warn("mark active intelligence instrument failed", error);
    });
  }, [derivativesSymbol]);

  const derivativesOptions = useMemo(() => {
    const query = derivativesSearch.trim().toUpperCase();
    const related = new Set([derivativesSymbol, ...relatedSymbols]);
    const source = marketAssets?.instruments ?? [];
    return source
      .filter((item) => item.instType === "SWAP" && item.state === "live" && ["USDT", "USDS"].includes(item.settleCcy))
      .filter((item) => !query || item.instId.includes(query) || item.baseCcy.includes(query) || item.instFamily.includes(query))
      .sort((left, right) => {
        const score = (item: MarketAssetsSummary["instruments"][number]) => {
          if (!query) return item.instId === derivativesSymbol ? 0 : related.has(item.instId) ? 1 : 2;
          if (item.instId === query || item.baseCcy === query) return 0;
          if (item.instId.startsWith(query) || item.baseCcy.startsWith(query)) return 1;
          return 2;
        };
        return score(left) - score(right) || left.baseCcy.localeCompare(right.baseCcy) || left.instId.localeCompare(right.instId);
      })
      .slice(0, 40);
  }, [derivativesSearch, derivativesSymbol, marketAssets?.instruments, relatedSymbols]);
  const selectedDerivativeInstrument = useMemo(
    () => marketAssets?.instruments.find((item) => item.instId === derivativesSymbol) ?? null,
    [derivativesSymbol, marketAssets?.instruments]
  );

  useEffect(() => {
    const closePicker = (event: PointerEvent) => {
      if (!derivativesPickerRef.current?.contains(event.target as Node)) {
        setDerivativesPickerOpen(false);
        setDerivativesSearch(derivativesSymbol);
      }
    };
    document.addEventListener("pointerdown", closePicker);
    return () => document.removeEventListener("pointerdown", closePicker);
  }, [derivativesSymbol]);

  const refreshAll = useCallback(async () => {
    if (!accountId) {
      setStatus("请选择实盘只读账户");
      return;
    }
    setBusy("sync");
    setStatus("正在同步 OKX 市场情报");
    try {
      const next = await syncIntelligence(accountId);
      applySummary(next);
      setNews(next.latestNews);
      setSentiment(next.sentimentRankings);
      setCalendar(next.economicEvents);
      setSmartSignals(next.smartSignals);
      setSmartTraders(next.smartTraders);
      setStatus("市场情报同步完成");
    } catch (error) {
      logger.error("intelligence sync failed", error);
      setStatus(error instanceof Error ? error.message : "市场情报同步失败");
    } finally {
      setBusy(null);
    }
  }, [accountId, applySummary]);

  const setCollectorAccount = useCallback(async () => {
    if (!summary || !accountId) return;
    setBusy("settings");
    try {
      const settings = await saveIntelligenceSettings({ ...summary.settings, collectorAccountId: accountId, enabled: true });
      setSummary((current) => current ? { ...current, settings } : current);
      setStatus("采集账户已更新");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "采集账户保存失败");
    } finally {
      setBusy(null);
    }
  }, [accountId, summary]);

  const openSettings = useCallback(async () => {
    if (!summary) return;
    setSettingsDraft({ ...summary.settings, extraInstruments: [...summary.settings.extraInstruments] });
    setSettingsOpen(true);
    if (!isTauriRuntime()) {
      setBriefingProfiles([]);
      return;
    }
    try {
      const automation = await invokeDesktop<AiAutomationOverview>("ai_automation_overview");
      setBriefingProfiles((automation?.profiles ?? []).filter((profile) =>
        profile.enabled
        && profile.skillIds.includes("okx-market-intelligence")
      ));
    } catch (error) {
      logger.warn("briefing profiles load failed", { error: error instanceof Error ? error.message : String(error) });
      setBriefingProfiles([]);
    }
  }, [summary]);

  const persistSettings = useCallback(async () => {
    if (!settingsDraft) return;
    setBusy("settings");
    try {
      const settings = await saveIntelligenceSettings(settingsDraft);
      setSummary((current) => current ? { ...current, settings } : current);
      setSettingsDraft(settings);
      setSettingsOpen(false);
      setStatus("市场情报设置已保存");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "市场情报设置保存失败");
    } finally {
      setBusy(null);
    }
  }, [settingsDraft]);

  const loadNewsEvents = useCallback(async () => {
    setBusy("news-events");
    try {
      if (!isTauriRuntime()) {
        const items = previewNewsEvents().filter((record) => {
          const title = textField(record, "title", "summary").toLowerCase();
          const coins = Array.isArray(record.coins) ? record.coins.map(String) : [];
          return (!newsKeyword.trim() || title.includes(newsKeyword.trim().toLowerCase()))
            && (!newsCoin.trim() || coins.includes(newsCoin.trim().toUpperCase()))
            && (newsImportance === "all" || textField(record, "importance") === "high");
        });
        setNewsEvents(items);
        setNewsResponse({ source: "preview-local", sourceVersion: "v2", fetchedAt: Date.now(), stale: false, items, pagination: { hasMore: false }, limitations: [], truncated: false, coverage: 1, expectedPoints: items.length });
        setStatus(`新闻事件 ${items.length} 个`);
        return;
      }
      const response = await queryNewsEvents({
        keyword: newsKeyword.trim() || undefined,
        coins: newsCoin.trim() ? [newsCoin.trim().toUpperCase()] : undefined,
        importance: newsImportance === "high" ? "high" : undefined,
        limit: 60
      });
      setNewsResponse(response);
      setNewsEvents(response.items);
      setStatus(`新闻事件 ${response.items.length} 个`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "新闻事件查询失败");
    } finally {
      setBusy(null);
    }
  }, [newsCoin, newsImportance, newsKeyword]);

  const openEvent = useCallback(async (record: IntelligenceRecord) => {
    setSelectedEvent(record);
    setEventDetail(record);
    if (!isTauriRuntime()) return;
    setBusy("event-detail");
    try {
      const response = await readNewsEvent(recordId(record, "event"));
      setEventDetail(response.items[0] ?? record);
    } catch (error) {
      logger.warn("news event detail failed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    if (tab !== "news" || newsMode !== "events" || selectedEvent || autoOpenedNewsEventRef.current || newsEvents.length === 0) return;
    autoOpenedNewsEventRef.current = true;
    void openEvent(newsEvents[0]);
  }, [newsEvents, newsMode, openEvent, selectedEvent, tab]);

  const loadDerivatives = useCallback(async (remote = false) => {
    const requestId = ++derivativesRequestIdRef.current;
    setBusy("derivatives");
    const now = Date.now();
    const range = derivativesPeriod === "5m" ? 24 * 3_600_000 : derivativesPeriod === "1H" ? 7 * 86_400_000 : derivativesPeriod === "4H" ? 30 * 86_400_000 : 180 * 86_400_000;
    const query = { instId: derivativesSymbol, period: derivativesPeriod, startTime: now - range, endTime: now, limit: derivativesPeriod === "5m" ? 288 : 240, localOnly: !remote } as const;
    try {
      if (!isTauriRuntime()) {
        if (requestId !== derivativesRequestIdRef.current) return;
        setPositioning(previewMarket.positioning);
        setTakerFlow(previewMarket.takerFlow);
        setCrowding(previewMarket.crowding);
        setFundingBasis(previewMarket.fundingBasis);
        setLiquidations(previewMarket.liquidations);
        setSystemRisk(previewMarket.systemRisk);
        setAnomalies(previewMarket.anomalies);
        setDerivativesResponse({ source: "okx-public-trading-data", sourceVersion: "preview-v2", fetchedAt: now, stale: false, items: previewMarket.positioning, pagination: { hasMore: false }, limitations: ["预览数据仅用于视觉和交互验收。"], truncated: false, coverage: 0.987, expectedPoints: 72 });
        setStatus("本地衍生品证据已加载");
        return;
      }
      const results = await Promise.allSettled([
        queryDerivatives("positioning", query), queryDerivatives("takerFlow", query),
        queryDerivatives("crowding", query), queryDerivatives("fundingBasis", query),
        queryDerivatives("liquidations", { ...query, period: "1H", limit: 100 }),
        queryDerivatives("systemRisk", { ...query, period: "1H", limit: 30 }),
        queryAnomalies({ ...query, limit: 50 })
      ]);
      const value = (index: number) => results[index].status === "fulfilled" ? results[index].value : null;
      if (requestId !== derivativesRequestIdRef.current) return;
      setPositioning(value(0)?.items ?? []);
      setTakerFlow(value(1)?.items ?? []);
      setCrowding(value(2)?.items ?? []);
      setFundingBasis(value(3)?.items ?? []);
      setLiquidations(value(4)?.items ?? []);
      setSystemRisk(value(5)?.items ?? []);
      setAnomalies(value(6)?.items ?? []);
      setDerivativesResponse(value(0));
      const failures = results.filter((result) => result.status === "rejected").length;
      setStatus(failures ? `衍生品证据部分可用，${failures} 项加载失败` : remote ? "衍生品远端刷新完成" : "本地衍生品证据已加载");
    } catch (error) {
      if (requestId === derivativesRequestIdRef.current) setStatus(error instanceof Error ? error.message : "衍生品证据加载失败");
    } finally {
      if (requestId === derivativesRequestIdRef.current) setBusy(null);
    }
  }, [derivativesPeriod, derivativesSymbol, previewMarket]);

  const runNewsQuery = useCallback(async (localOnly = false) => {
    setBusy("news");
    try {
      const response = await queryNews({
        accountId: accountId || undefined,
        keyword: newsKeyword.trim() || undefined,
        coins: newsCoin.trim() ? [newsCoin.trim().toUpperCase()] : undefined,
        importance: newsImportance === "high" ? "high" : undefined,
        sortBy: newsKeyword.trim() ? "relevant" : "latest",
        language: "zh-CN",
        detailLevel: "summary",
        limit: 60,
        localOnly
      });
      setNewsResponse(response);
      setNews(response.items);
      setStatus(response.stale ? "远端刷新失败，显示本地历史" : `新闻结果 ${response.items.length} 条`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "新闻查询失败");
    } finally {
      setBusy(null);
    }
  }, [accountId, newsCoin, newsImportance, newsKeyword]);

  const loadNewsFeed = useCallback(async ({
    page = newsPage,
    date = newsDate,
    markSeen = false,
    mode = newsMode
  }: { page?: number; date?: Date; markSeen?: boolean; mode?: "events" | "articles" } = {}) => {
    const range = newsDateRange(date);
    const feedMode = mode;
    setBusy("news-feed");
    try {
      if (!isTauriRuntime()) {
        const source = feedMode === "events" ? previewNewsEvents() : previewSummary(accountId || "preview").latestNews;
        const items = source
          .filter((record) => {
            const timestamp = Number(record.lastPublishedAt ?? record.publishTime ?? record.publishedAt ?? 0);
            const title = textField(record, "title", "summary", "headline").toLowerCase();
            const coins = Array.isArray(record.coins) ? record.coins.map(String) : [];
            return timestamp >= range.startTime && timestamp < range.endTime
              && (!newsKeyword.trim() || title.includes(newsKeyword.trim().toLowerCase()))
              && (!newsCoin.trim() || coins.some((value) => value.toUpperCase() === newsCoin.trim().toUpperCase()))
              && (newsImportance === "all" || textField(record, "importance") === "high");
          });
        const pageSize = 20;
        const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
        const safePage = Math.min(Math.max(1, page), totalPages);
        const nextPage: NewsFeedPage = { mode: feedMode, items: items.slice((safePage - 1) * pageSize, safePage * pageSize), page: safePage, pageSize, total: items.length, totalPages, unreadCount: 0, readState: { eventsReadAt: Date.now(), articlesReadAt: Date.now(), unreadEvents: 0, unreadArticles: 0 } };
        setNewsFeedPage(nextPage);
        setNewsReadState(nextPage.readState);
        if (feedMode === "events") setNewsEvents(nextPage.items); else setNews(nextPage.items);
        setNewsPage(safePage);
        setStatus(`${feedMode === "events" ? "新闻事件" : "新闻原文"} ${items.length} 条`);
        onNewsUnreadCountChange?.(0);
        return;
      }
      let response = await queryNewsFeed({
        mode: feedMode,
        keyword: newsKeyword.trim() || undefined,
        coins: newsCoin.trim() ? [newsCoin.trim().toUpperCase()] : undefined,
        importance: newsImportance === "all" ? undefined : "high",
        language: intelligenceLanguage(resolvedLocale()),
        ...range,
        page,
        pageSize: 20
      });
      const isCurrentUnfilteredDay = newsDateKey(date) === newsDateKey(new Date())
        && !newsKeyword.trim() && !newsCoin.trim() && newsImportance === "all" && !newsRelevantOnly;
      if (markSeen && isCurrentUnfilteredDay) {
        const readState = await markNewsRead(feedMode);
        response = { ...response, unreadCount: 0, readState, items: response.items.map((item) => ({ ...item, unread: false })) };
      }
      setNewsFeedPage(response);
      setNewsReadState(response.readState);
      setNewsPage(response.page);
      if (feedMode === "events") setNewsEvents(response.items); else setNews(response.items);
      setNewsResponse(null);
      setStatus(`${feedMode === "events" ? "新闻事件" : "新闻原文"} ${response.total} 条`);
      onNewsUnreadCountChange?.(response.readState.unreadEvents);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "新闻列表加载失败");
    } finally {
      setBusy(null);
    }
  }, [accountId, newsCoin, newsDate, newsImportance, newsKeyword, newsMode, newsPage, newsRelevantOnly, onNewsUnreadCountChange]);

  const refreshNewsFeed = useCallback(async () => {
    if (isTauriRuntime() && accountId) {
      setBusy("news-sync");
      try {
        await syncIntelligence(accountId, "news");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "新闻同步失败，继续读取本地缓存");
      } finally {
        setBusy(null);
      }
    }
    await loadNewsFeed({ page: 1, markSeen: true });
  }, [accountId, loadNewsFeed]);

  const openNews = useCallback(async (record: IntelligenceRecord) => {
    setSelectedNews(record);
    setNewsDetail(null);
    const id = recordId(record, "news");
    setBusy("detail");
    try {
      const response = await readNewsDetail(accountId || undefined, id);
      setNewsDetail(response.items[0] ?? record);
    } catch (error) {
      logger.warn("news detail failed", { error: error instanceof Error ? error.message : String(error) });
      setNewsDetail(record);
    } finally {
      setBusy(null);
    }
  }, [accountId]);

  const loadSentiment = useCallback(async (localOnly = false) => {
    setBusy("sentiment");
    try {
      const [ranking, trend] = await Promise.all([
        querySentiment({ accountId: accountId || undefined, period: "24h", sortBy: "hot", limit: 30, localOnly }),
        querySentiment({ accountId: accountId || undefined, coins: [sentimentCoin.toUpperCase()], period: "1h", trendPoints: 24, limit: 24, localOnly })
      ]);
      setSentimentResponse(trend);
      setSentiment([...trend.items, ...ranking.items]);
      setStatus(localOnly ? "情绪与宏观本地数据已更新" : "情绪与宏观数据已刷新");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "情绪数据加载失败");
    } finally {
      setBusy(null);
    }
  }, [accountId, sentimentCoin]);

  const loadCalendarMonth = useCallback(async (month: Date, localOnly = true) => {
    const requestId = ++calendarRequestIdRef.current;
    const start = new Date(month.getFullYear(), month.getMonth(), 1);
    const end = new Date(month.getFullYear(), month.getMonth() + 1, 1);
    if (!isTauriRuntime()) {
      const preview = previewSummary(eligibleAccounts[0]?.id ?? "preview").economicEvents;
      const monthly = preview.filter((record) => {
        const timestamp = calendarEventTimestamp(record);
        return timestamp >= start.getTime() && timestamp < end.getTime();
      });
      setCalendar(monthly);
      setCalendarResponse({ source: "preview-local", sourceVersion: "preview-v2", fetchedAt: Date.now(), stale: false, items: monthly, pagination: { hasMore: false }, limitations: [], truncated: false, coverage: 1, expectedPoints: monthly.length });
      return;
    }
    setBusy("calendar");
    try {
      const response = await queryCalendar({
        accountId: accountId || undefined,
        startTime: start.getTime(),
        endTime: end.getTime() - 1,
        limit: 2_000,
        localOnly
      });
      const displayedResponse = localOnly
        ? response
        : await queryCalendar({
          startTime: start.getTime(),
          endTime: end.getTime() - 1,
          limit: 2_000,
          localOnly: true
        });
      if (requestId !== calendarRequestIdRef.current) return;
      setCalendar(displayedResponse.items);
      setCalendarResponse(displayedResponse);
      setStatus(localOnly ? "经济日历已从本地更新" : "经济日历远端刷新完成");
    } catch (error) {
      if (requestId === calendarRequestIdRef.current) setStatus(error instanceof Error ? error.message : "经济日历加载失败");
    } finally {
      if (requestId === calendarRequestIdRef.current) setBusy(null);
    }
  }, [accountId, eligibleAccounts]);

  const loadSmart = useCallback(async (localOnly = false) => {
    setBusy("smart");
    try {
      const ts = String(Date.now());
      const [signals, trend, traders] = await Promise.all([
        querySmartMoney({ accountId: accountId || undefined, operation: "signalOverviewByFilter", topInstruments: 20, sortType: "pnl", period: "7", limit: 50, localOnly }),
        querySmartMoney({ accountId: accountId || undefined, operation: "signalTrendByFilter", instId: "BTC-USDT-SWAP", ts, granularity: "1h", sortType: "pnl", period: "7", limit: 24, localOnly }),
        querySmartMoney({ accountId: accountId || undefined, operation: "traders", sortType: "pnl", period: "90", limit: 40, localOnly })
      ]);
      setSmartResponse(signals);
      setSmartSignals(signals.items);
      setSmartTrend(trend.items);
      setSmartTraders(traders.items);
      setStatus(localOnly ? "聪明钱本地数据已更新" : "聪明钱数据已刷新");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "聪明钱数据加载失败");
    } finally {
      setBusy(null);
    }
  }, [accountId]);

  const intelligenceViewRef = useRef({ tab, newsMode, newsPage, newsDate });
  const intelligenceLoadersRef = useRef<IntelligenceVisibleLoaders | null>(null);
  const initialVisibleLoadRef = useRef<string | null>(null);

  useEffect(() => {
    intelligenceViewRef.current = { tab, newsMode, newsPage, newsDate };
  }, [newsDate, newsMode, newsPage, tab]);

  useEffect(() => {
    intelligenceLoadersRef.current = {
      applySummary,
      loadDerivatives,
      loadNewsEvents,
      loadNewsFeed,
      loadNews: runNewsQuery,
      loadSentiment,
      loadSmart
    };
  }, [applySummary, loadDerivatives, loadNewsEvents, loadNewsFeed, loadSentiment, loadSmart, runNewsQuery]);

  useEffect(() => {
    const viewKey = tab === "news"
      ? `${tab}:${newsMode}`
      : tab === "derivatives"
        ? `${tab}:${derivativesSymbol}:${derivativesPeriod}`
        : tab;
    if (initialVisibleLoadRef.current === viewKey) return;
    initialVisibleLoadRef.current = viewKey;
    const loaders = intelligenceLoadersRef.current;
    if (!loaders) return;
    if (tab === "derivatives") void loaders.loadDerivatives(false);
    else if (tab === "news") void loaders.loadNewsFeed({ page: 1, markSeen: true });
    else if (tab === "sentiment") void loaders.loadSentiment(true);
    else if (tab === "smart") void loaders.loadSmart(true);
  }, [derivativesPeriod, derivativesSymbol, newsMode, tab]);

  useEffect(() => {
    if (tab !== "sentiment") return;
    void loadCalendarMonth(calendarMonth, true);
  }, [calendarMonth, loadCalendarMonth, tab]);

  useEffect(() => {
    let disposed = false;
    let dispose: (() => void) | null = null;
    let summaryTimer: ReturnType<typeof setTimeout> | null = null;
    let contentTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleSummary = () => {
      if (summaryTimer) clearTimeout(summaryTimer);
      summaryTimer = setTimeout(() => {
        void loadIntelligenceSummary().then((value) => intelligenceLoadersRef.current?.applySummary(value));
      }, 250);
    };
    const scheduleVisibleContent = (eventType: string) => {
      if (contentTimer) clearTimeout(contentTimer);
      contentTimer = setTimeout(() => {
        const view = intelligenceViewRef.current;
        const loaders = intelligenceLoadersRef.current;
        if (!loaders) return;
        if (view.tab === "derivatives") {
          void loaders.loadDerivatives(false);
        } else if (eventType !== "derivativesStreamUpdated") {
          if (view.tab === "news") {
            void loaders.loadNewsFeed({ page: view.newsPage, date: view.newsDate, markSeen: false });
          } else if (view.tab === "sentiment") {
            void loaders.loadSentiment(true);
          } else if (view.tab === "smart") {
            void loaders.loadSmart(true);
          }
        }
      }, eventType === "derivativesStreamUpdated" ? 750 : 250);
    };

    void listenIntelligenceEvents((event) => {
      const eventType = textField(event, "type");
      if (eventType === "syncCompleted" || eventType === "syncDegraded") scheduleSummary();
      if (eventType === "syncCompleted" || eventType === "syncDegraded" || eventType === "derivativesStreamUpdated") {
        scheduleVisibleContent(eventType);
      }
    }).then((listener) => {
      if (disposed) listener?.();
      else dispose = listener;
    }).catch((error) => {
      logger.warn("intelligence event listener failed", { error: error instanceof Error ? error.message : String(error) });
    });
    return () => {
      disposed = true;
      dispose?.();
      if (summaryTimer) clearTimeout(summaryTimer);
      if (contentTimer) clearTimeout(contentTimer);
    };
  }, []);

  const openTrader = useCallback(async (record: IntelligenceRecord) => {
    setSelectedTrader(record);
    setTraderEvidence(EMPTY_TRADER_EVIDENCE);
    const authorId = textField(record, "authorId", "id");
    if (!authorId) return;
    if (!isTauriRuntime()) {
      setTraderEvidence(previewTraderEvidence(record));
      setStatus("交易员证据已加载");
      return;
    }
    setBusy("trader");
    const labels = [t("intelligence:performance"), t("intelligence:currentPositions"), t("intelligence:fills")];
    try {
      const results = await Promise.allSettled([
        querySmartMoney({ accountId: accountId || undefined, operation: "performance", authorIds: [authorId], sortType: "pnl", period: "90" }),
        querySmartMoney({ accountId: accountId || undefined, operation: "positions", authorId, limit: 100 }),
        querySmartMoney({ accountId: accountId || undefined, operation: "orderHistory", authorId, limit: 50 })
      ]);
      const items = results.map((result) => result.status === "fulfilled" ? result.value.items : []);
      const errors = results.flatMap((result, index) => result.status === "rejected"
        ? [`${labels[index]} ${t("common:failed")}`]
        : []);
      setTraderEvidence({ performance: items[0], positions: items[1], orders: items[2], errors });
      setStatus(errors.length > 0 ? t("intelligence:evidencePartiallyAvailable", { errors: errors.join(", ") }) : "交易员证据已加载");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "交易员详情加载失败");
    } finally {
      setBusy(null);
    }
  }, [accountId, t]);

  const toggleTrader = useCallback(async (record: IntelligenceRecord) => {
    const authorId = textField(record, "authorId", "id");
    if (!authorId) return;
    const tracked = summary?.trackedTraders.some((item) => textField(item, "authorId") === authorId) ?? false;
    const next = await trackSmartTrader(authorId, textField(record, "nickname", "nickName", "name"), !tracked);
    applySummary(next);
  }, [applySummary, summary?.trackedTraders]);

  const loadHistory = useCallback(async () => {
    setBusy("history");
    try {
      const response = historyKind === "news"
        ? await queryNews({ keyword: newsKeyword || undefined, coins: newsCoin ? [newsCoin.toUpperCase()] : undefined, limit: 100, localOnly: true })
        : historyKind === "events"
          ? await queryNewsEvents({ keyword: newsKeyword || undefined, coins: newsCoin ? [newsCoin.toUpperCase()] : undefined, limit: 100 })
          : historyKind === "sentiment"
            ? await querySentiment({ coins: sentimentCoin ? [sentimentCoin.toUpperCase()] : undefined, period: "1h", limit: 100, localOnly: true })
            : historyKind === "calendar"
              ? await queryCalendar({ startTime: Date.now() - 365 * 86_400_000, endTime: Date.now() + 365 * 86_400_000, limit: 100, localOnly: true })
              : historyKind === "derivatives"
                ? await queryDerivatives("positioning", { instId: derivativesSymbol, period: derivativesPeriod, limit: 500, localOnly: true })
                : historyKind === "anomalies"
                  ? await queryAnomalies({ instId: derivativesSymbol, period: derivativesPeriod, limit: 100, localOnly: true })
                  : historyKind === "briefings"
                    ? await queryBriefings({ limit: 100 })
                    : await querySmartMoney({ operation: "signals", limit: 100, localOnly: true });
      setHistory(response.items);
      setStatus(`本地历史 ${response.items.length} 条`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "历史查询失败");
    } finally {
      setBusy(null);
    }
  }, [derivativesPeriod, derivativesSymbol, historyKind, newsCoin, newsKeyword, sentimentCoin]);

  const runBriefing = useCallback(async () => {
    const profileId = summary?.settings.briefingProfileId?.trim();
    if (!profileId) {
      setStatus("请先在市场情报设置中选择每日简报 Agent Profile");
      return;
    }
    setBusy("briefing");
    try {
      const response = await generateBriefing(profileId);
      setHistory(response.items);
      setStatus("市场简报已进入只读 Agent 队列");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "市场简报生成失败");
    } finally {
      setBusy(null);
    }
  }, [summary?.settings.briefingProfileId]);

  const lastSync = useMemo(() => {
    const times = summary?.syncStates.map((state) => state.lastSucceededAt ?? 0) ?? [];
    return Math.max(0, ...times);
  }, [summary?.syncStates]);
  const traderPerformance = traderEvidence.performance[0] ?? selectedTrader;
  const traderEvidenceCount = traderEvidence.performance.length + traderEvidence.positions.length + traderEvidence.orders.length;
  const statusIsError = traderEvidence.errors.length > 0 || /失败|异常|不兼容|degraded|failed/i.test(status);
  const visibleCalendar = useMemo(() => calendarImportantOnly
    ? calendar.filter((record) => importanceLabel(textField(record, "importance", "level")) === "高")
    : calendar, [calendar, calendarImportantOnly]);
  const calendarCoverage = useMemo(() => ({
    total: visibleCalendar.length,
    previous: visibleCalendar.filter((record) => Boolean(textField(record, "previous", "prev", "prevInitial"))).length,
    forecast: visibleCalendar.filter((record) => Boolean(textField(record, "forecast", "consensus"))).length,
    actual: visibleCalendar.filter((record) => Boolean(textField(record, "actual"))).length
  }), [visibleCalendar]);
  const calendarByDay = useMemo(() => {
    const grouped = new Map<string, IntelligenceRecord[]>();
    for (const record of visibleCalendar) {
      const key = calendarDayKey(calendarEventTimestamp(record));
      if (!key) continue;
      grouped.set(key, [...(grouped.get(key) ?? []), record]);
    }
    for (const items of grouped.values()) items.sort((left, right) => calendarEventTimestamp(left) - calendarEventTimestamp(right));
    return grouped;
  }, [visibleCalendar]);
  const calendarDays = useMemo(() => monthCalendarDays(calendarMonth), [calendarMonth]);
  const calendarWeekDays = useMemo(() => weekCalendarDays(selectedCalendarDay), [selectedCalendarDay]);
  const calendarWeekdayLabels = useMemo(() => {
    const monday = new Date(2024, 0, 1, 12);
    const formatter = new Intl.DateTimeFormat(resolvedLocale(), { weekday: "short" });
    return Array.from({ length: 7 }, (_, index) => formatter.format(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index, 12)));
  }, [i18n.language]);
  const displayedCalendarDay = calendarView === "month" && hoveredCalendarDay ? hoveredCalendarDay : selectedCalendarDay;
  const displayedCalendarEvents = calendarByDay.get(displayedCalendarDay) ?? [];
  const calendarMonthLabel = new Intl.DateTimeFormat(resolvedLocale(), { timeZone: "Asia/Shanghai", year: "numeric", month: "long" }).format(calendarMonth);
  const displayedCalendarDateLabel = new Intl.DateTimeFormat(resolvedLocale(), { timeZone: "Asia/Shanghai", month: "long", day: "numeric", weekday: "short" }).format(calendarDateFromKey(displayedCalendarDay));
  const calendarWeekLabel = `${new Intl.DateTimeFormat(resolvedLocale(), { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" }).format(calendarWeekDays[0].date)} - ${new Intl.DateTimeFormat(resolvedLocale(), { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" }).format(calendarWeekDays[6].date)}`;
  const selectCalendarDate = useCallback((date: Date) => {
    const key = CALENDAR_DAY_FORMATTER.format(date);
    setSelectedCalendarDay(key);
    setHoveredCalendarDay(null);
    setCalendarMonth((current) => current.getFullYear() === date.getFullYear() && current.getMonth() === date.getMonth()
      ? current
      : new Date(date.getFullYear(), date.getMonth(), 1));
  }, []);
  const moveCalendarWeek = useCallback((delta: number) => {
    const current = calendarDateFromKey(selectedCalendarDay);
    selectCalendarDate(new Date(current.getFullYear(), current.getMonth(), current.getDate() + delta * 7, 12));
  }, [selectCalendarDate, selectedCalendarDay]);
  const moveCalendarMonth = useCallback((delta: number) => {
    setCalendarMonth((current) => {
      const next = new Date(current.getFullYear(), current.getMonth() + delta, 1);
      setSelectedCalendarDay(CALENDAR_DAY_FORMATTER.format(next));
      setHoveredCalendarDay(null);
      return next;
    });
  }, []);
  const goCalendarToday = useCallback(() => selectCalendarDate(new Date()), [selectCalendarDate]);
  const positionExposure = useMemo(() => {
    let long = 0;
    let short = 0;
    for (const record of traderEvidence.positions) {
      const notional = Math.abs(numericValue(textField(record, "notionalUsd", "notional")) ?? 0);
      const side = textField(record, "side", "posSide").toLowerCase();
      if (["short", "sell"].includes(side)) short += notional;
      else long += notional;
    }
    return { long, short, total: long + short };
  }, [traderEvidence.positions]);
  const selectedEventRecord = eventDetail ?? selectedEvent;
  const eventArticles = recordArray(selectedEventRecord, "articles");
  const latestPositioning = latestRecord(positioning);
  const earliestPositioning = firstRecord(positioning);
  const priceChange = percentageChange(
    latestPositioning ? textField(latestPositioning, "last", "price") : null,
    earliestPositioning ? textField(earliestPositioning, "last", "price") : null
  );
  const oiChange = percentageChange(
    latestPositioning ? textField(latestPositioning, "oiUsd", "oi") : null,
    earliestPositioning ? textField(earliestPositioning, "oiUsd", "oi") : null
  );
  const positioningState = priceChange === null || oiChange === null
    ? t("intelligence:positioningEvidenceInsufficient")
    : priceChange >= 0 && oiChange >= 0
      ? t("intelligence:positioningRising")
      : priceChange < 0 && oiChange >= 0
        ? t("intelligence:positioningFalling")
        : priceChange >= 0
          ? t("intelligence:positioningShortCovering")
          : t("intelligence:positioningLongUnwinding");
  const latestFlow = latestRecord(takerFlow);
  const latestCrowding = latestRecord(crowding);
  const latestFunding = latestRecord(fundingBasis);
  const latestRisk = latestRecord(systemRisk);
  const relevantCoins = useMemo(() => new Set(
    [derivativesSymbol, selectedSymbol ?? "", ...relatedSymbols]
      .filter(Boolean)
      .map((symbol) => symbol.split("-")[0].toUpperCase())
  ), [derivativesSymbol, relatedSymbols, selectedSymbol]);
  const todayNewsDate = localDayStart(new Date());
  const isNewsToday = newsDateKey(newsDate) === newsDateKey(todayNewsDate);
  const changeNewsDate = useCallback((offset: number) => {
    const next = new Date(newsDate);
    next.setDate(next.getDate() + offset);
    const normalized = localDayStart(next);
    if (normalized > todayNewsDate) return;
    setNewsDate(normalized);
    setNewsPage(1);
    void loadNewsFeed({ page: 1, date: normalized, markSeen: isNewsToday || offset > 0 });
  }, [isNewsToday, loadNewsFeed, newsDate, todayNewsDate]);
  const selectNewsDate = useCallback((value: string) => {
    const [year, month, day] = value.split("-").map(Number);
    if (![year, month, day].every(Number.isFinite)) return;
    const next = localDayStart(new Date(year, month - 1, day));
    if (next > todayNewsDate) return;
    setNewsDate(next);
    setNewsPage(1);
    void loadNewsFeed({ page: 1, date: next, markSeen: newsDateKey(next) === newsDateKey(todayNewsDate) });
  }, [loadNewsFeed, todayNewsDate]);
  const setNewsDisplayMode = useCallback((mode: "events" | "articles") => {
    setNewsMode(mode);
    setNewsPage(1);
    void loadNewsFeed({ page: 1, mode, markSeen: isNewsToday });
  }, [isNewsToday, loadNewsFeed]);
  const markCurrentNewsRead = useCallback(async () => {
    try {
      const readState = await markNewsRead(newsMode);
      setNewsReadState(readState);
      setNewsFeedPage((current) => current ? { ...current, unreadCount: 0, readState, items: current.items.map((item) => ({ ...item, unread: false })) } : current);
      if (newsMode === "events") setNewsEvents((items) => items.map((item) => ({ ...item, unread: false })));
      else setNews((items) => items.map((item) => ({ ...item, unread: false })));
      onNewsUnreadCountChange?.(readState.unreadEvents);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "新闻已读状态保存失败");
    }
  }, [newsMode, onNewsUnreadCountChange]);
  const visibleNewsEvents = newsRelevantOnly
    ? newsEvents.filter((record) => Array.isArray(record.coins) && record.coins.map((coin) => String(coin).toUpperCase()).some((coin) => relevantCoins.has(coin)))
    : newsEvents;
  const relevanceLabel = useCallback((record: IntelligenceRecord) => {
    const coins = Array.isArray(record.coins) ? record.coins.map((coin) => String(coin).toUpperCase()) : [];
    const currentCoin = selectedSymbol?.split("-")[0].toUpperCase();
    if (currentCoin && coins.includes(currentCoin)) return t("intelligence:currentMarket");
    return coins.some((coin) => relevantCoins.has(coin)) ? t("intelligence:positionOrWatchlist") : "";
  }, [relevantCoins, selectedSymbol, t]);
  const localizedStatus = localizeIntelligenceStatus(status, t);
  const activeResponse = tab === "news"
    ? newsResponse
    : tab === "sentiment"
      ? sentimentResponse
      : tab === "derivatives"
        ? derivativesResponse
        : tab === "smart"
          ? smartResponse
          : null;

  return (
    <WorkspaceFrame className="intelligence-page" tone="intelligence">
      <header className="intelligence-header">
        <div className="intelligence-title">
          <BrainCircuit size={18} />
          <strong>{t("intelligence:title")}</strong>
          <span className={statusIsError ? "error" : undefined} title={localizedStatus}>{statusIsError ? t("intelligence:partialLoadFailed") : localizedStatus}</span>
        </div>
        <div className="intelligence-controls">
          <TerminalSelect
            ariaLabel={t("intelligence:account")}
            value={accountId}
            options={[{ value: "", label: t("intelligence:selectReadOnlyAccount") }, ...eligibleAccounts.map((account) => ({ value: account.id, label: account.name }))]}
            preserveOptionLabels
            onChange={setAccountId}
          />
          <button type="button" onClick={() => void setCollectorAccount()} disabled={!accountId || busy === "settings"} title={t("intelligence:setCollectorAccount")}>
            <Clock3 size={14} />{t("intelligence:collectorAccount")}
          </button>
          <span className="intelligence-last-sync">{t("intelligence:lastSync")} {lastSync ? formatTime(lastSync) : "--"}</span>
          <button type="button" onClick={() => void openSettings()} disabled={!summary} title={t("intelligence:settings")} aria-label={t("intelligence:settings")}>
            <Settings2 size={14} />
          </button>
          <button className="primary-action" type="button" onClick={() => void refreshAll()} disabled={!accountId || Boolean(busy)}>
            <RefreshCw className={busy === "sync" ? "spin" : undefined} size={14} />{t("intelligence:refreshAll")}
          </button>
        </div>
      </header>

      {settingsOpen && settingsDraft ? (
        <div className="intelligence-settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
          <section className="intelligence-settings-dialog" role="dialog" aria-modal="true" aria-label={t("intelligence:settings")}>
            <div className="intelligence-detail-head"><Settings2 size={16} /><strong>{t("intelligence:settings")}</strong><button type="button" onClick={() => setSettingsOpen(false)} title={t("common:close")}><X size={15} /></button></div>
            <div className="intelligence-settings-body">
              <label className="intelligence-settings-toggle"><input type="checkbox" checked={settingsDraft.enabled} onChange={(event) => setSettingsDraft({ ...settingsDraft, enabled: event.target.checked })} /><span>{t("intelligence:enableBackgroundCollection")}</span></label>
              <div className="intelligence-settings-grid">
                <label><span>{t("intelligence:activeInstrumentSeconds")}</span><input type="number" min="30" max="300" value={settingsDraft.activeDerivativesPollSeconds} onChange={(event) => setSettingsDraft({ ...settingsDraft, activeDerivativesPollSeconds: Number(event.target.value) })} /></label>
                <label><span>{t("intelligence:watchlistMinutes")}</span><input type="number" min="1" max="60" value={settingsDraft.derivativesPollMinutes} onChange={(event) => setSettingsDraft({ ...settingsDraft, derivativesPollMinutes: Number(event.target.value) })} /></label>
                <label><span>{t("intelligence:smartMoneyMinutes")}</span><input type="number" min="5" max="120" value={settingsDraft.smartMoneyPollMinutes} onChange={(event) => setSettingsDraft({ ...settingsDraft, smartMoneyPollMinutes: Number(event.target.value) })} /></label>
                <label><span>{t("intelligence:newsSeconds")}</span><input type="number" min="30" max="600" value={settingsDraft.newsPollSeconds} onChange={(event) => setSettingsDraft({ ...settingsDraft, newsPollSeconds: Number(event.target.value) })} /></label>
                <label><span>{t("intelligence:activeSystemRiskMinutes")}</span><input type="number" min="1" max="60" value={settingsDraft.activeDerivativesRiskPollMinutes} onChange={(event) => setSettingsDraft({ ...settingsDraft, activeDerivativesRiskPollMinutes: Number(event.target.value) })} /></label>
                <label><span>{t("intelligence:standardSystemRiskMinutes")}</span><input type="number" min="15" max="1440" value={settingsDraft.derivativesRiskPollMinutes} onChange={(event) => setSettingsDraft({ ...settingsDraft, derivativesRiskPollMinutes: Number(event.target.value) })} /></label>
                <label><span>{t("intelligence:slowContractPoolMinutes")}</span><input type="number" min="15" max="1440" value={settingsDraft.derivativesSlowPollMinutes} onChange={(event) => setSettingsDraft({ ...settingsDraft, derivativesSlowPollMinutes: Number(event.target.value) })} /></label>
                <label><span>{t("intelligence:sentimentMinutes")}</span><input type="number" min="5" max="120" value={settingsDraft.sentimentPollMinutes} onChange={(event) => setSettingsDraft({ ...settingsDraft, sentimentPollMinutes: Number(event.target.value) })} /></label>
              </div>
              <label><span>{t("intelligence:slowContractPoolHelp")}</span><textarea value={settingsDraft.extraInstruments.join(", ")} onChange={(event) => setSettingsDraft({ ...settingsDraft, extraInstruments: event.target.value.split(/[,\s]+/).map((value) => value.trim().toUpperCase()).filter(Boolean).slice(0, 40) })} placeholder="ETH-USDT-SWAP, SOL-USDT-SWAP" /></label>
              <label className="intelligence-settings-toggle"><input type="checkbox" checked={settingsDraft.briefingEnabled} onChange={(event) => setSettingsDraft({ ...settingsDraft, briefingEnabled: event.target.checked })} /><span>{t("intelligence:briefingSchedule")}</span></label>
              <label><span>{t("intelligence:briefingProfile")}</span><TerminalSelect ariaLabel={t("intelligence:briefingProfile")} value={settingsDraft.briefingProfileId ?? ""} options={[{ value: "", label: t("intelligence:noSelection") }, ...briefingProfiles.map((profile) => ({ value: profile.id, label: `${profile.name} · ${profile.mode}` }))]} preserveOptionLabels onChange={(value) => setSettingsDraft({ ...settingsDraft, briefingProfileId: value || null })} /><small>{t("intelligence:briefingProfileHelp")}</small></label>
            </div>
            <div className="intelligence-settings-actions"><button type="button" onClick={() => setSettingsOpen(false)}>{t("common:cancel")}</button><button className="primary-action" type="button" onClick={() => void persistSettings()} disabled={busy === "settings"}>{t("intelligence:saveSettings")}</button></div>
          </section>
        </div>
      ) : null}

      {eligibleAccounts.length === 0 && tab !== "derivatives" ? (
        <div className="intelligence-account-warning"><BrainCircuit size={16} /><span>{t("intelligence:liveAccountWarning")}</span></div>
      ) : null}
          <nav className="intelligence-tabs" aria-label={t("intelligence:viewAria")}>
            {TABS.map(([id, labelKey, Icon]) => (
              <button key={id} className={tab === id ? "active" : undefined} type="button" onClick={() => setTab(id)}>
                <Icon size={15} />{t(`intelligence:${labelKey}`)}
                <span>{id === "news" ? (newsMode === "events" ? newsEvents.length : news.length) : id === "sentiment" ? sentiment.length + calendar.length : id === "derivatives" ? positioning.length + anomalies.length : id === "smart" ? smartSignals.length + smartTraders.length : history.length}</span>
              </button>
            ))}
          </nav>

          <div className="intelligence-context-bar" aria-label={t("intelligence:viewAria")}>
            <span className="intelligence-context-scope">
              <i aria-hidden="true" />
              <strong>{selectedSymbol || t("intelligence:wholeMarket")}</strong>
              <small>{accountId ? t("intelligence:account") : t("intelligence:loadingLocal")}</small>
            </span>
            <span className="intelligence-context-status">{localizedStatus}</span>
            <ResultMeta response={activeResponse} />
          </div>

          <section className="intelligence-content">
            {tab === "news" ? (
              <div className="intelligence-news-layout">
                <div className="intelligence-list-pane">
                  <div className="intelligence-toolbar">
                    <div className="intelligence-segmented" role="tablist" aria-label={t("intelligence:newsDisplayMode")}><button type="button" className={newsMode === "events" ? "active" : undefined} onClick={() => setNewsDisplayMode("events")}>{t("intelligence:events")}</button><button type="button" className={newsMode === "articles" ? "active" : undefined} onClick={() => setNewsDisplayMode("articles")}>{t("intelligence:original")}</button></div>
                    <div className="intelligence-news-date-nav" aria-label={t("intelligence:newsDate")}>
                      <button type="button" onClick={() => changeNewsDate(-1)} title={t("intelligence:previousDay")} aria-label={t("intelligence:previousDay")}><ChevronLeft size={14} /></button>
                      <input type="date" value={newsDateKey(newsDate)} max={newsDateKey(todayNewsDate)} onChange={(event) => selectNewsDate(event.target.value)} aria-label={t("intelligence:newsDate")} />
                      <button type="button" onClick={() => changeNewsDate(1)} disabled={isNewsToday} title={t("intelligence:nextDay")} aria-label={t("intelligence:nextDay")}><ChevronRight size={14} /></button>
                    </div>
                    <label><Search size={14} /><input value={newsKeyword} onChange={(event) => setNewsKeyword(event.target.value)} placeholder={t("intelligence:keyword")} /></label>
                    <input value={newsCoin} onChange={(event) => setNewsCoin(event.target.value.toUpperCase())} placeholder={t("intelligence:coinPlaceholder")} />
                    <TerminalSelect ariaLabel={t("intelligence:newsImportance")} value={newsImportance} options={[{ value: "all", label: t("intelligence:allNews") }, { value: "high", label: t("intelligence:importantNews") }]} onChange={(value) => setNewsImportance(value as "all" | "high")} />
                    <button type="button" className={newsRelevantOnly ? "active" : undefined} onClick={() => setNewsRelevantOnly((value) => !value)}>{t("intelligence:relevantToMe")}</button>
                    <button type="button" onClick={() => void refreshNewsFeed()} disabled={busy === "news-feed" || busy === "news-sync" || busy === "news" || busy === "news-events"}><RefreshCw className={busy === "news-feed" || busy === "news-sync" ? "spin" : undefined} size={14} />{t("intelligence:query")}</button>
                    <button type="button" onClick={() => void markCurrentNewsRead()} disabled={!newsReadState || (newsMode === "events" ? newsReadState.unreadEvents === 0 : newsReadState.unreadArticles === 0)} title={t("intelligence:markAllRead")} aria-label={t("intelligence:markAllRead")}><CheckCheck size={14} /></button>
                  </div>
                  <div className="intelligence-news-feed-meta">
                    <span>{newsFeedPage ? `${newsFeedPage.total} · ${newsFeedPage.page}/${newsFeedPage.totalPages}` : t("intelligence:loadingLocal")}</span>
                    {newsFeedPage && newsFeedPage.unreadCount > 0 ? <b>{t("intelligence:unreadNews", { count: newsFeedPage.unreadCount })}</b> : null}
                  </div>
                  <div className="intelligence-feed" data-empty={t("intelligence:noNewsForDate")}>
                    {newsMode === "events" ? visibleNewsEvents.map((record) => { const id = recordId(record, "event"); const sources = Array.isArray(record.sources) ? record.sources.map(String) : []; const coins = Array.isArray(record.coins) ? record.coins.map(String) : []; const related = relevanceLabel(record); const eventStatus = textField(record, "status"); const statusLabel = eventStatus === "confirmed" ? t("intelligence:multipleSources") : eventStatus === "developing" ? t("intelligence:singleSourceTracking") : t("intelligence:singleSourceQuiet"); const statusTitle = eventStatus === "confirmed" ? t("intelligence:multipleSourcesHelp") : eventStatus === "developing" ? t("intelligence:singleSourceTrackingHelp") : t("intelligence:singleSourceQuietHelp"); return <button type="button" className={clsx(selectedEvent && recordId(selectedEvent, "event") === id && "active", record.unread === true && "unread")} key={id} onClick={() => void openEvent(record)}><span className="intelligence-feed-time">{formatTime(record.lastPublishedAt ?? record.firstPublishedAt)}</span><span className="intelligence-feed-title"><i aria-hidden="true" /> <strong data-i18n-skip>{textField(record, "title") || t("intelligence:unnamedEvent")}</strong></span><small><span className={`intelligence-event-status status-${eventStatus}`} title={statusTitle}>{statusLabel}</span>{related ? <span className="intelligence-relevance-tag">{related}</span> : null}{coins.join(" / ") || t("intelligence:wholeMarket")} · {t("intelligence:sourceCount", { count: sources.length || Number(record.sourceCount ?? 0) })} · {t("intelligence:articleCount", { count: Number(record.articleCount ?? 0) })}</small></button>; }) : news.map((record) => { const id = recordId(record, "news"); const title = textField(record, "title", "headline", "name") || t("intelligence:unnamedNews"); return <button type="button" className={clsx(selectedNews && recordId(selectedNews, "news") === id && "active", record.unread === true && "unread")} key={id} onClick={() => void openNews(record)}><span className="intelligence-feed-time">{formatTime(record.publishTime ?? record.publishedAt ?? record.ts)}</span><span className="intelligence-feed-title"><i aria-hidden="true" /> <strong data-i18n-skip>{title}</strong></span><small data-i18n-skip>{textField(record, "platform", "source", "domain") || "OKX News"} · {localizedSentimentLabel(sentimentLabel(textField(record, "sentiment")), t)}</small></button>; })}
                  </div>
                  {newsFeedPage ? <div className="intelligence-news-pager"><button type="button" onClick={() => void loadNewsFeed({ page: newsFeedPage.page - 1, markSeen: false })} disabled={newsFeedPage.page <= 1 || busy === "news-feed"}><ChevronLeft size={14} />{t("intelligence:previousPage")}</button><span>{t("intelligence:newsPage", { page: newsFeedPage.page, total: newsFeedPage.totalPages })}</span><button type="button" onClick={() => void loadNewsFeed({ page: newsFeedPage.page + 1, markSeen: false })} disabled={newsFeedPage.page >= newsFeedPage.totalPages || busy === "news-feed"}>{t("intelligence:nextPage")}<ChevronRight size={14} /></button></div> : null}
                </div>
                <aside className="intelligence-detail-pane">
                  {newsMode === "events" && selectedEventRecord ? (
                    <>
                      <div className="intelligence-detail-head"><Layers3 size={16} /><strong>{t("intelligence:eventEvidence")}</strong><button type="button" onClick={() => { setSelectedEvent(null); setEventDetail(null); }} title={t("common:close")}><X size={15} /></button></div>
                      <h2 data-i18n-skip>{textField(selectedEventRecord, "title")}</h2>
                      <div className="intelligence-detail-facts"><span>{textField(selectedEventRecord, "status") === "confirmed" ? t("intelligence:multipleSources") : textField(selectedEventRecord, "status") === "developing" ? t("intelligence:singleSourceTracking") : t("intelligence:singleSourceQuiet")}</span><span>{formatTime(selectedEventRecord.firstPublishedAt)}</span><span>ID {recordId(selectedEventRecord, "event")}</span></div>
                      <p data-i18n-skip>{textField(selectedEventRecord, "summary") || t("intelligence:noEventSummary")}</p>
                      <NewsReactionPanel event={selectedEventRecord} marketAssets={marketAssets} />
                      <section className="intelligence-event-timeline"><header><Newspaper size={14} /><strong>{t("intelligence:sourceTimeline")}</strong><span>{t("intelligence:articleCount", { count: eventArticles.length })}</span></header>{eventArticles.length ? eventArticles.map((article) => <button type="button" key={recordId(article, "article")} onClick={() => void openNews(article)}><span>{formatTime(article.publishTime ?? article.publishedAt)}</span><strong data-i18n-skip>{textField(article, "title")}</strong><small data-i18n-skip>{textField(article, "platform", "source") || "OKX News"}</small></button>) : <p>{t("intelligence:articleEvidenceAggregating")}</p>}</section>
                    </>
                  ) : newsMode === "articles" && selectedNews ? (
                    <>
                      <div className="intelligence-detail-head"><Newspaper size={16} /><strong>{t("intelligence:newsDetail")}</strong><button type="button" onClick={() => { setSelectedNews(null); setNewsDetail(null); }} title={t("common:close")}><X size={15} /></button></div>
                      <h2 data-i18n-skip>{textField(newsDetail ?? selectedNews, "title", "headline", "name")}</h2>
                      <div className="intelligence-detail-facts"><span>{textField(newsDetail ?? selectedNews, "platform", "source") || "OKX News"}</span><span>{formatTime((newsDetail ?? selectedNews).publishTime ?? (newsDetail ?? selectedNews).publishedAt)}</span><span>ID {recordId(selectedNews, "news")}</span></div>
                      <p data-i18n-skip>{textField(newsDetail ?? selectedNews, "summary", "description", "brief") || t("intelligence:noSummary")}</p>
                      <div className="intelligence-article-body">{busy === "detail" ? t("intelligence:readingFullText") : textField(newsDetail ?? selectedNews, "content", "originalText", "body", "text") || t("intelligence:fullTextUnavailable")}</div>
                      <div className="intelligence-detail-actions">
                        {textField(selectedNews, "url", "link") ? <a href={textField(selectedNews, "url", "link")} target="_blank" rel="noreferrer"><ExternalLink size={14} />{t("common:source")}</a> : null}
                      </div>
                    </>
                  ) : <div className="intelligence-placeholder"><BookOpen size={26} /><span>{newsMode === "events" ? t("intelligence:chooseEvent") : t("intelligence:chooseNews")}</span></div>}
                </aside>
              </div>
            ) : null}

            {tab === "sentiment" ? (
              <div className="intelligence-split-view">
                <section className="intelligence-section-band">
                  <div className="intelligence-section-head"><div><BarChart3 size={16} /><strong>{t("intelligence:coinSentiment")}</strong></div><div><input value={sentimentCoin} onChange={(event) => setSentimentCoin(event.target.value.toUpperCase())} /><button type="button" onClick={() => void loadSentiment()} disabled={busy === "sentiment"}><RefreshCw size={14} />{t("common:refresh")}</button></div></div>
                  <ResultMeta response={sentimentResponse} />
                  <div className="intelligence-trend-strip" aria-label={t("intelligence:sentimentTrend", { coin: sentimentCoin })}>
                    <span>{sentimentCoin} 24h</span>
                    <div>{sentiment.slice(0, 24).map((record, index) => { const ratio = numberField(record, "bullishRatio", "longRatio", "positiveRatio") ?? 0.5; return <i key={`${recordId(record, "trend")}-${index}`} style={{ height: `${Math.max(8, Math.min(100, ratio * (ratio <= 1 ? 100 : 1)))}%` }} />; })}</div>
                    <small>{t("intelligence:bearish")}</small><small>{t("intelligence:bullish")}</small>
                  </div>
                  <div className="intelligence-sentiment-grid">
                    {sentiment.slice(0, 40).map((record, index) => {
                      const bullish = numberField(record, "bullishRatio", "longRatio", "positiveRatio") ?? 0;
                      const bearish = numberField(record, "bearishRatio", "shortRatio", "negativeRatio") ?? Math.max(0, 1 - bullish);
                      const label = sentimentLabel(textField(record, "label", "sentiment"));
                      const coin = textField(record, "ccy", "symbol", "coin") || sentimentCoin;
                      return <div key={`${recordId(record, "sentiment")}-${index}`}><SymbolLabel symbol={coin} marketAssets={marketAssets} /><span className={`sentiment-${label === "偏多" ? "up" : label === "偏空" ? "down" : "neutral"}`}>{localizedSentimentLabel(label, t)}</span><div><i style={{ width: `${Math.min(100, bullish * (bullish <= 1 ? 100 : 1))}%` }} /><b style={{ width: `${Math.min(100, bearish * (bearish <= 1 ? 100 : 1))}%` }} /></div><small>{t("intelligence:mentions", { count: formatCompact(textField(record, "mentionCount", "mentions")) })}</small></div>;
                    })}
                  </div>
                </section>
                <section className="intelligence-section-band intelligence-calendar-band">
                  <div className="intelligence-section-head intelligence-calendar-head">
                    <div><CalendarDays size={16} /><strong>{t("intelligence:economicCalendar")}</strong><span>{t(calendarImportantOnly ? "intelligence:importantEventCount" : "intelligence:eventCount", { count: calendarCoverage.total })}</span></div>
                    <div className="intelligence-calendar-controls">
                      <div className="intelligence-calendar-view-switch" role="group" aria-label={t("intelligence:calendarView")}>
                        <button type="button" className={calendarView === "week" ? "active" : undefined} aria-pressed={calendarView === "week"} onClick={() => setCalendarView("week")}>{t("intelligence:weekView")}</button>
                        <button type="button" className={calendarView === "month" ? "active" : undefined} aria-pressed={calendarView === "month"} onClick={() => setCalendarView("month")}>{t("intelligence:monthView")}</button>
                      </div>
                      <label className="intelligence-calendar-important-toggle">
                        <span>{t("intelligence:importantOnly")}</span>
                        <input type="checkbox" aria-label={t("intelligence:importantEventsOnly")} checked={calendarImportantOnly} onChange={(event) => setCalendarImportantOnly(event.target.checked)} />
                        <i aria-hidden="true" />
                      </label>
                      <button type="button" className="intelligence-calendar-refresh" title={t("intelligence:refreshCalendar")} aria-label={t("intelligence:refreshCalendar")} onClick={() => void loadCalendarMonth(calendarMonth, false)} disabled={busy === "calendar"}><RefreshCw className={busy === "calendar" ? "spin" : undefined} size={13} /></button>
                    </div>
                  </div>
                  <ResultMeta response={calendarResponse} />
                  <div className="intelligence-calendar-workbench">
                    <div className="intelligence-calendar-period-bar">
                      <button type="button" title={t(calendarView === "week" ? "intelligence:previousWeek" : "intelligence:previousMonth")} aria-label={t(calendarView === "week" ? "intelligence:previousWeek" : "intelligence:previousMonth")} onClick={() => calendarView === "week" ? moveCalendarWeek(-1) : moveCalendarMonth(-1)}><ChevronLeft size={15} /></button>
                      {calendarView === "week" ? (
                        <div className="intelligence-calendar-week-strip" aria-label={calendarWeekLabel}>
                          {calendarWeekDays.map((day, index) => {
                            const events = calendarByDay.get(day.key) ?? [];
                            const high = events.some((record) => importanceLabel(textField(record, "importance", "level")) === "高");
                            const today = day.key === CALENDAR_DAY_FORMATTER.format(new Date());
                            return (
                              <button
                                type="button"
                                className={clsx("intelligence-calendar-week-day", today && "today", selectedCalendarDay === day.key && "selected")}
                                aria-label={t("intelligence:calendarDayEvents", { date: day.key, count: events.length })}
                                aria-pressed={selectedCalendarDay === day.key}
                                key={day.key}
                                onClick={() => selectCalendarDate(day.date)}
                              >
                                <span>{calendarWeekdayLabels[index]}</span>
                                <strong>{day.date.getDate()}</strong>
                                {events.length ? <i className={high ? "high" : undefined}>{events.length}</i> : <i />}
                              </button>
                            );
                          })}
                        </div>
                      ) : <strong className="intelligence-calendar-period-title">{calendarMonthLabel}</strong>}
                      <button type="button" title={t(calendarView === "week" ? "intelligence:nextWeek" : "intelligence:nextMonth")} aria-label={t(calendarView === "week" ? "intelligence:nextWeek" : "intelligence:nextMonth")} onClick={() => calendarView === "week" ? moveCalendarWeek(1) : moveCalendarMonth(1)}><ChevronRight size={15} /></button>
                      <div className="intelligence-calendar-date-actions">
                        <button type="button" title={t("intelligence:returnToday")} onClick={goCalendarToday}><CalendarDays size={13} />{t("intelligence:today")}</button>
                        <span>{calendarView === "week" ? calendarWeekLabel : selectedCalendarDay}</span>
                      </div>
                    </div>
                    {calendarView === "month" ? (
                      <div className="intelligence-month-calendar">
                        <div className="intelligence-calendar-weekdays">{calendarWeekdayLabels.map((day) => <span key={day}>{day}</span>)}</div>
                        <div className="intelligence-calendar-days">
                          {calendarDays.map((day) => {
                            const events = calendarByDay.get(day.key) ?? [];
                            const high = events.some((record) => importanceLabel(textField(record, "importance", "level")) === "高");
                            const medium = events.some((record) => importanceLabel(textField(record, "importance", "level")) === "中");
                            const today = day.key === CALENDAR_DAY_FORMATTER.format(new Date());
                            return (
                              <button
                                type="button"
                                className={clsx("intelligence-calendar-day", !day.inMonth && "outside", today && "today", selectedCalendarDay === day.key && "selected", hoveredCalendarDay === day.key && "previewing")}
                                aria-label={t("intelligence:calendarDayEvents", { date: day.key, count: events.length })}
                                aria-pressed={selectedCalendarDay === day.key}
                                key={day.key}
                                onPointerEnter={() => setHoveredCalendarDay(day.key)}
                                onPointerLeave={() => setHoveredCalendarDay(null)}
                                onFocus={() => setHoveredCalendarDay(day.key)}
                                onBlur={() => setHoveredCalendarDay(null)}
                                onClick={() => selectCalendarDate(day.date)}
                              >
                                <span>{day.date.getDate()}</span>
                                {events.length ? <b>{events.length}</b> : null}
                                {events.length ? <i className={high ? "high" : medium ? "medium" : "low"} /> : null}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                    <section className="intelligence-calendar-agenda" aria-live="polite">
                      <header>
                        <div><strong>{displayedCalendarDateLabel}</strong><span>{t("intelligence:eventCount", { count: displayedCalendarEvents.length })}</span></div>
                        <small>{t("intelligence:calendarCoverage", calendarCoverage)}</small>
                      </header>
                      <div className="intelligence-calendar-event-table-wrap">
                        <table className="intelligence-calendar-event-table">
                          <thead><tr><th>{t("common:time")}</th><th>{t("common:data")}</th><th>{t("intelligence:importance")}</th><th>{t("intelligence:previousValue")}</th><th>{t("intelligence:forecast")}</th><th>{t("intelligence:actual")}</th></tr></thead>
                          <tbody>
                            {displayedCalendarEvents.map((record) => {
                              const id = recordId(record, "calendar");
                              const importance = importanceLabel(textField(record, "importance", "level"));
                              const score = calendarImportanceScore(textField(record, "importance", "level"));
                              const eventTime = calendarEventTimestamp(record);
                              const region = textField(record, "region", "country") || t("intelligence:global");
                              const actualPending = !textField(record, "actual") && eventTime > Date.now();
                              const actual = textField(record, "actual") || (actualPending ? t("intelligence:pendingRelease") : t("intelligence:unavailable"));
                              return (
                                <tr className={`calendar-importance-${importance === "高" ? "high" : importance === "中" ? "medium" : "low"}`} key={id}>
                                  <td><time dateTime={eventTime ? new Date(eventTime).toISOString() : undefined}>{calendarClock(eventTime)}</time></td>
                                  <td><div className="intelligence-calendar-event-name"><span aria-hidden="true">{calendarRegionFlag(region) || region.slice(0, 2).toUpperCase()}</span><div><strong data-i18n-skip>{textField(record, "event", "name", "title") || "--"}</strong><small>{region}</small></div></div></td>
                                  <td><div className="intelligence-calendar-importance-stars" aria-label={t("intelligence:importanceAria", { level: localizedImportanceLabel(importance, t) })}>{[1, 2, 3].map((level) => <Star aria-hidden="true" className={level <= score ? "active" : undefined} fill={level <= score ? "currentColor" : "none"} key={level} size={11} />)}<span>{localizedImportanceLabel(importance, t)}</span></div></td>
                                  <td>{textField(record, "previous", "prev", "prevInitial") || "--"}</td>
                                  <td>{textField(record, "forecast", "consensus") || "--"}</td>
                                  <td><strong className={actualPending ? "pending" : undefined}>{actual}</strong></td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        {displayedCalendarEvents.length === 0 ? <div className="intelligence-calendar-no-events"><CalendarDays size={20} /><span>{t("intelligence:noEvents")}</span></div> : null}
                      </div>
                    </section>
                  </div>
                </section>
              </div>
            ) : null}

            {tab === "derivatives" ? (
              <div className="intelligence-derivatives-view">
                <div className="intelligence-derivatives-toolbar">
                  <div className="intelligence-symbol-picker" ref={derivativesPickerRef}>
                    <div className={derivativesPickerOpen ? "intelligence-symbol-input active" : "intelligence-symbol-input"}>
                      <SymbolIcon
                        base={selectedDerivativeInstrument?.baseCcy ?? derivativesSymbol.split("-")[0]}
                        iconPath={selectedDerivativeInstrument?.iconPath}
                        cached={selectedDerivativeInstrument?.iconCached}
                        cacheDir={marketAssets?.cacheDir}
                      />
                      <input
                        value={derivativesSearch}
                        placeholder={t("intelligence:searchDerivativePair")}
                        aria-label={t("intelligence:searchDerivativePair")}
                        aria-expanded={derivativesPickerOpen}
                        aria-controls="intelligence-symbol-options"
                        onFocus={(event) => {
                          setDerivativesPickerOpen(true);
                          event.currentTarget.select();
                        }}
                        onClick={() => setDerivativesPickerOpen(true)}
                        onChange={(event) => {
                          setDerivativesSearch(event.target.value.toUpperCase());
                          setDerivativesPickerOpen(true);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            setDerivativesPickerOpen(false);
                            setDerivativesSearch(derivativesSymbol);
                            event.currentTarget.blur();
                          } else if (event.key === "Enter" && derivativesOptions[0]) {
                            setDerivativesSymbol(derivativesOptions[0].instId);
                            setDerivativesSearch(derivativesOptions[0].instId);
                            setDerivativesPickerOpen(false);
                          }
                        }}
                      />
                      <ChevronDown size={14} className={derivativesPickerOpen ? "open" : undefined} />
                    </div>
                    {derivativesPickerOpen ? (
                      <div className="intelligence-symbol-menu" id="intelligence-symbol-options" role="listbox" aria-label={t("intelligence:derivativePairs")}>
                        {derivativesOptions.length ? derivativesOptions.map((item) => (
                          <button
                            type="button"
                            role="option"
                            aria-selected={item.instId === derivativesSymbol}
                            className={item.instId === derivativesSymbol ? "active" : undefined}
                            key={item.instId}
                            onClick={() => {
                              setDerivativesSymbol(item.instId);
                              setDerivativesSearch(item.instId);
                              setDerivativesPickerOpen(false);
                            }}
                          >
                            <SymbolIcon base={item.baseCcy} iconPath={item.iconPath} cached={item.iconCached} cacheDir={marketAssets?.cacheDir} />
                            <strong>{item.baseCcy}</strong>
                            <span>{item.instId}</span>
                            <small>{item.settleCcy}</small>
                          </button>
                        )) : <div className="intelligence-symbol-empty">{marketAssets?.instruments?.length ? t("intelligence:noMatchingPerpetual") : t("intelligence:marketCacheUnavailable")}</div>}
                      </div>
                    ) : null}
                  </div>
                  <div className="intelligence-segmented" role="group" aria-label={t("intelligence:derivativeGranularity")}>{(["5m", "1H", "4H", "1D"] as const).map((period) => <button type="button" key={period} className={derivativesPeriod === period ? "active" : undefined} onClick={() => setDerivativesPeriod(period)}>{period}</button>)}</div>
                  <ResultMeta response={derivativesResponse} />
                  <span className="intelligence-coverage">{t("intelligence:dataCoverage")} {derivativesResponse?.coverage === undefined || derivativesResponse.coverage === null ? "--" : `${(derivativesResponse.coverage * 100).toFixed(1)}%`}</span>
                  <button type="button" onClick={() => void loadDerivatives(true)} disabled={busy === "derivatives"}><RefreshCw className={busy === "derivatives" ? "spin" : undefined} size={14} />{t("common:refresh")}</button>
                </div>
                <div className="intelligence-derivatives-grid">
                  <section className="intelligence-derivative-panel intelligence-positioning-panel">
                    <header><div><Activity size={15} /><strong>{t("intelligence:positioning")}</strong><span>{t("intelligence:positioningSubtitle")}</span></div></header>
                    <div className="intelligence-derivative-metrics"><span>{t("common:price")} <strong>{formatPrice(latestPositioning ? textField(latestPositioning, "last", "price") : "")}</strong></span><span>{t("trading:positionSize")} <strong>{formatCompact(latestPositioning ? textField(latestPositioning, "oiUsd", "oi") : "", { currency: true })}</strong></span><span>{t("intelligence:priceChange")} <strong className={(priceChange ?? 0) >= 0 ? "positive" : "negative"}>{formatPercent(priceChange)}</strong></span><span>{t("intelligence:oiChange")} <strong className={(oiChange ?? 0) >= 0 ? "positive" : "negative"}>{formatPercent(oiChange)}</strong></span><b className="intelligence-positioning-state">{positioningState}</b></div>
                    <IntelligenceEvidenceChart kind="positioning" items={positioning} height={245} ariaLabel={t("intelligence:positioningChart", { symbol: derivativesSymbol })} />
                    <footer>{t("intelligence:positioningDisclaimer")}</footer>
                  </section>
                  <section className="intelligence-derivative-panel intelligence-crowding-panel">
                    <header><div><GitCompareArrows size={15} /><strong>{t("intelligence:crowding")}</strong><span>{t("intelligence:crowdingSubtitle")}</span></div></header>
                    <IntelligenceEvidenceChart kind="crowding" items={crowding} height={245} ariaLabel={t("intelligence:crowdingChart", { symbol: derivativesSymbol })} />
                    <div className="intelligence-crowding-summary"><span>{t("intelligence:standardAccounts")} <strong>{formatRatio(latestCrowding ?? {}, "accountRatio")}</strong></span><span>{t("intelligence:topTraders")} <strong>{formatRatio(latestCrowding ?? {}, "topAccountRatio")}</strong></span><span>{t("intelligence:topPositions")} <strong>{formatRatio(latestCrowding ?? {}, "topPositionRatio")}</strong></span></div>
                  </section>
                  <section className="intelligence-derivative-panel intelligence-flow-panel">
                    <header><div><BarChart3 size={15} /><strong>{t("intelligence:takerFlow")}</strong><span>{t("intelligence:takerFlowSubtitle")}</span></div></header>
                    <IntelligenceEvidenceChart kind="takerFlow" items={takerFlow} height={205} ariaLabel={t("intelligence:takerFlowChart", { symbol: derivativesSymbol })} />
                    <div className="intelligence-flow-summary"><span>{t("intelligence:takerBuy")} <strong className="positive">{formatCompact(latestFlow ? textField(latestFlow, "buyVol") : "")}</strong></span><span>{t("intelligence:takerSell")} <strong className="negative">{formatCompact(latestFlow ? textField(latestFlow, "sellVol") : "")}</strong></span><span>{t("intelligence:netFlow")} <strong className={(numberField(latestFlow ?? {}, "netVol") ?? 0) >= 0 ? "positive" : "negative"}>{formatCompact(latestFlow ? textField(latestFlow, "netVol") : "", { signed: true })}</strong></span></div>
                  </section>
                  <section className="intelligence-derivative-panel intelligence-funding-panel">
                    <header><div><Gauge size={15} /><strong>{t("intelligence:fundingBasis")}</strong><span>{t("intelligence:fundingBasisSubtitle")}</span></div></header>
                    <IntelligenceEvidenceChart kind="fundingBasis" items={fundingBasis} height={205} ariaLabel={t("intelligence:fundingBasisChart", { symbol: derivativesSymbol })} />
                    <div className="intelligence-funding-summary"><span>{t("intelligence:forecastRate")} <strong>{formatRatio(latestFunding ?? {}, "nextFundingRate")}</strong></span><span>{t("intelligence:settlementRate")} <strong>{formatRatio(latestFunding ?? {}, "fundingRate")}</strong></span><span>{t("intelligence:premium")} <strong>{formatRatio(latestFunding ?? {}, "premium")}</strong></span><span>{t("intelligence:basis")} <strong>{formatPrice(latestFunding ? textField(latestFunding, "basis") : "")}</strong></span></div>
                  </section>
                  <section className="intelligence-derivative-panel intelligence-risk-panel">
                    <header><div><Gauge size={15} /><strong>{t("intelligence:marketStress")}</strong><span>{t("intelligence:marketStressSubtitle")}</span></div></header>
                    <div className="intelligence-risk-list"><div><span>{t("intelligence:liquidationEvents24h")}</span><strong>{liquidations.length}</strong></div><div><span>{t("intelligence:insuranceFund")}</span><strong className="positive">{formatCompact(latestRisk ? textField(latestRisk, "insuranceBalance") : "", { currency: true })}</strong></div><div><span>{t("intelligence:upperPriceLimit")}</span><strong>{formatPrice(latestRisk ? textField(latestRisk, "upperLimit") : "")}</strong></div><div><span>{t("intelligence:lowerPriceLimit")}</span><strong>{formatPrice(latestRisk ? textField(latestRisk, "lowerLimit") : "")}</strong></div><div><span>{t("intelligence:adlStatus")}</span><strong className={textField(latestRisk ?? {}, "adlState") === "normal" ? "positive" : undefined}>{textField(latestRisk ?? {}, "adlState") === "normal" ? t("intelligence:normal") : textField(latestRisk ?? {}, "adlState") || t("intelligence:noWarning")}</strong></div></div>
                    <div className="intelligence-anomaly-list"><header><strong>{t("intelligence:currentAnomalies")}</strong><span>{anomalies.length}</span></header>{anomalies.length ? anomalies.slice(0, 4).map((record) => <div key={recordId(record, "anomaly")}><span className={`severity-${textField(record, "severity")}`}>{textField(record, "severity") === "high" ? t("intelligence:high") : t("intelligence:medium")}</span><strong data-i18n-skip>{textField(record, "kind") === "oi_change" ? t("intelligence:oiAnomaly") : textField(record, "label", "kind")}</strong><small>Z {formatFixed(textField(record, "robustZScore"), 2)}</small></div>) : <p>{t("intelligence:noThresholdAnomalies")}</p>}</div>
                    <footer>{t("intelligence:liquidationDisclaimer")}</footer>
                  </section>
                </div>
              </div>
            ) : null}

            {tab === "smart" ? (
              <div className="intelligence-smart-layout">
                <section className="intelligence-section-band intelligence-signals-band">
                  <div className="intelligence-section-head"><div><BrainCircuit size={16} /><strong>{t("intelligence:smartMoneyConsensus")}</strong></div><button type="button" onClick={() => void loadSmart()} disabled={busy === "smart"}><RefreshCw size={14} />{t("common:refresh")}</button></div>
                  <ResultMeta response={smartResponse} />
                  <div className="intelligence-trend-strip intelligence-smart-trend" aria-label={t("intelligence:smartMoneyTrend")}>
                    <span>{t("intelligence:btcConsensus24h")}</span>
                    <div className="intelligence-trend-plot" style={{ gridTemplateColumns: `repeat(${Math.max(1, smartTrend.slice(0, 24).length)}, minmax(0, 1fr))` }}>{smartTrend.slice(0, 24).map((record, index) => { const ratio = numberField(record, "weightedLongRatio", "longRatio", "bullishRatio") ?? 0.5; const label = `${formatTime(record.ts ?? record.bucketAt ?? record.updateTime)} ${t("intelligence:long")} ${formatRatio(record, "weightedLongRatio", "longRatio", "bullishRatio")}`; return <button type="button" aria-label={label} title={label} key={`${recordId(record, "smart-trend")}-${index}`}><i style={{ height: `${Math.max(8, Math.min(100, ratio * (ratio <= 1 ? 100 : 1)))}%` }} /></button>; })}</div>
                    <div className="intelligence-trend-axis" style={{ gridTemplateColumns: `repeat(${Math.max(1, smartTrend.slice(0, 24).length)}, minmax(0, 1fr))` }}>{smartTrend.slice(0, 24).map((record, index) => <span key={`axis-${recordId(record, "smart-trend")}-${index}`}>{index % 6 === 0 || index === smartTrend.slice(0, 24).length - 1 ? formatTime(record.ts ?? record.bucketAt ?? record.updateTime).slice(6) : ""}</span>)}</div>
                    <small>{t("intelligence:short")}</small><small>{t("intelligence:long")}</small>
                  </div>
                  <div className="intelligence-table-wrap"><table><thead><tr><th>{t("intelligence:coin")}</th><th>{t("intelligence:longShortStructure")}</th><th>{t("intelligence:netNotionalUsdt")}</th><th>{t("intelligence:traders")}</th><th>{t("intelligence:averageEntry")}</th></tr></thead><tbody>{smartSignals.map((record) => { const id = recordId(record, "signal"); const symbol = textField(record, "instCcy", "ccy", "symbol") || "--"; const longRatio = numberField(record, "weightedLongRatio", "longRatio") ?? 0; const shortRatio = numberField(record, "weightedShortRatio", "shortRatio") ?? Math.max(0, 1 - longRatio); const netNotional = textField(record, "netNotionalUsdt", "netNotional", "capitalFlow"); return <tr key={id}><td><SymbolLabel symbol={symbol} marketAssets={marketAssets} /></td><td><div className="intelligence-ratio-cell"><span><b>{formatRatio(record, "weightedLongRatio", "longRatio")}</b><i>{formatRatio(record, "weightedShortRatio", "shortRatio")}</i></span><div><b style={{ width: `${Math.min(100, longRatio * (longRatio <= 1 ? 100 : 1))}%` }} /><i style={{ width: `${Math.min(100, shortRatio * (shortRatio <= 1 ? 100 : 1))}%` }} /></div></div></td><td className={netNotional.trim().startsWith("-") ? "negative" : "positive"}>{formatFixed(netNotional, 3, { signed: true })}</td><td>{formatCompact(textField(record, "tradersWithPosition", "traderCount"))}</td><td>{formatPrice(textField(record, "smartMoneyLongAvgEntry", "longAvgEntry"))}</td></tr>; })}</tbody></table></div>
                </section>
                <section className="intelligence-section-band intelligence-traders-band">
                  <div className="intelligence-section-head"><div><Users size={16} /><strong>{t("intelligence:traderRanking")}</strong></div><span>{t("intelligence:ninetyDaysPnl")}</span></div>
                  <div className="intelligence-trader-list-head"><span>{t("intelligence:trader")}</span><span>PnL</span><span>{t("intelligence:winRate")}</span><span>{t("intelligence:drawdown")}</span><span /></div>
                  <div className="intelligence-trader-list">{smartTraders.map((record) => { const authorId = textField(record, "authorId", "id"); const tracked = summary?.trackedTraders.some((item) => textField(item, "authorId") === authorId); return <div className={selectedTrader && textField(selectedTrader, "authorId", "id") === authorId ? "active" : undefined} key={authorId || recordId(record, "trader")}><button type="button" onClick={() => void openTrader(record)}><strong data-i18n-skip>{textField(record, "nickname", "nickName", "name") || authorId}</strong><span>{formatCompact(textField(record, "pnl", "profit"), { signed: true })}</span><span>{formatRatio(record, "winRate", "winRatio")}</span><span>{formatRatio(record, "maxDrawdown", "maxRetreat")}</span></button><button type="button" onClick={() => void toggleTrader(record)} title={tracked ? t("intelligence:unfollow") : t("intelligence:followTrader")}>{tracked ? <StarOff size={14} /> : <Star size={14} />}</button></div>; })}</div>
                </section>
                {selectedTrader ? <aside className="intelligence-detail-pane intelligence-trader-detail">
                  <div className="intelligence-detail-head"><Users size={16} /><strong data-i18n-skip>{textField(selectedTrader, "nickname", "nickName", "name") || textField(selectedTrader, "authorId")}</strong><button type="button" onClick={() => setSelectedTrader(null)} title={t("common:close")}><X size={15} /></button></div>
                  <div className="intelligence-detail-facts"><span>authorId {textField(selectedTrader, "authorId", "id")}</span><span>{busy === "trader" ? t("intelligence:readingEvidence") : t("intelligence:evidenceCount", { count: traderEvidenceCount })}</span></div>
                  {traderEvidence.errors.length > 0 ? <div className="intelligence-evidence-warning">{t("intelligence:evidenceWarning", { errors: traderEvidence.errors.join("; ") })}</div> : null}
                  <div className="intelligence-trader-metrics"><div><span>{t("intelligence:ninetyDaysPnl")}</span><strong>{formatCompact(textField(traderPerformance ?? {}, "pnl", "profit"), { signed: true })}</strong></div><div><span>{t("intelligence:winRate")}</span><strong>{formatRatio(traderPerformance ?? {}, "winRate", "winRatio")}</strong></div><div><span>{t("intelligence:maximumDrawdown")}</span><strong>{formatRatio(traderPerformance ?? {}, "maxDrawdown", "maxRetreat")}</strong></div></div>
                  <div className="intelligence-evidence-scroll">
                    <section className="intelligence-evidence-section"><header><strong>{t("intelligence:currentPositions")}</strong><span>{t("intelligence:contractCount", { count: traderEvidence.positions.length })}</span></header>{traderEvidence.positions.length > 0 ? <><div className="intelligence-position-balance"><div><span>{t("intelligence:long")} {formatCompact(positionExposure.long, { currency: true })}</span><span>{t("intelligence:short")} {formatCompact(positionExposure.short, { currency: true })}</span></div><div><b style={{ width: `${positionExposure.total > 0 ? positionExposure.long / positionExposure.total * 100 : 50}%` }} /><i style={{ width: `${positionExposure.total > 0 ? positionExposure.short / positionExposure.total * 100 : 50}%` }} /></div></div><div className="intelligence-position-list">{traderEvidence.positions.map((record, index) => { const positionSide = sideLabel(textField(record, "side", "posSide")); const notional = Math.abs(numericValue(textField(record, "notionalUsd", "notional")) ?? 0); const exposureShare = positionExposure.total > 0 ? notional / positionExposure.total * 100 : 0; const pnl = textField(record, "unrealizedPnl", "upl", "pnl"); return <article key={`${recordId(record, "position")}-${index}`}><header><SymbolLabel symbol={textField(record, "instId", "instCcy") || "--"} marketAssets={marketAssets} /><span className={positionSide === "空" ? "position-short" : "position-long"}>{localizedSideLabel(positionSide, t)}{textField(record, "leverage", "lever") ? ` · ${textField(record, "leverage", "lever")}x` : ""}</span><b className={pnl.trim().startsWith("-") ? "negative" : "positive"}>{formatFixed(pnl, 3, { signed: true })}</b></header><div className="intelligence-position-prices"><span>{t("intelligence:entry")} <strong>{formatPrice(textField(record, "entryPrice", "avgPx"))}</strong></span><i>→</i><span>{t("intelligence:currentPrice")} <strong>{formatPrice(textField(record, "lastPrice", "last"))}</strong></span></div><div className="intelligence-position-metrics"><span>{t("intelligence:position")} <strong>{formatCompact(textField(record, "size", "pos"))}</strong></span><span>{t("intelligence:notionalValue")} <strong>{formatFixed(notional, 3)}</strong></span><span>{t("intelligence:intensity")} <strong>{formatFixed(textField(record, "positionIntensity"), 3)}</strong></span></div><div className="intelligence-position-exposure" title={t("intelligence:exposureShare", { share: exposureShare.toFixed(3) })}><i className={positionSide === "空" ? "position-short" : "position-long"} style={{ width: `${Math.max(2, exposureShare)}%` }} /></div></article>; })}</div></> : <p>{t("intelligence:noPositionRecords")}</p>}</section>
                    <section className="intelligence-evidence-section"><header><strong>{t("intelligence:recentFills")}</strong><span>{traderEvidence.orders.length}</span></header>{traderEvidence.orders.length > 0 ? <div className="intelligence-table-wrap"><table><thead><tr><th>{t("trading:contract")}</th><th>{t("trading:direction")}</th><th>{t("common:quantity")}</th><th>{t("intelligence:fillPrice")}</th><th>{t("common:time")}</th></tr></thead><tbody>{traderEvidence.orders.slice(0, 20).map((record, index) => <tr key={`${recordId(record, "order")}-${index}`}><td><SymbolLabel symbol={textField(record, "instId", "instCcy") || "--"} marketAssets={marketAssets} /></td><td>{localizedSideLabel(sideLabel(textField(record, "side", "positionSide")), t)}</td><td>{formatCompact(textField(record, "fillSize", "size", "sz"))}</td><td>{formatPrice(textField(record, "fillPrice", "price", "avgPx"))}</td><td>{formatTime(record.updatedAt ?? record.fillTime ?? record.uTime)}</td></tr>)}</tbody></table></div> : <p>{t("intelligence:noFillRecords")}</p>}</section>
                  </div>
                </aside> : null}
              </div>
            ) : null}

            {tab === "history" ? (
              <div className="intelligence-history-view">
                <div className="intelligence-toolbar"><TerminalSelect ariaLabel={t("intelligence:historyType")} value={historyKind} options={[{ value: "news", label: t("intelligence:newsArticles") }, { value: "events", label: t("intelligence:newsEvents") }, { value: "sentiment", label: t("intelligence:sentimentHistory") }, { value: "calendar", label: t("intelligence:economicCalendar") }, { value: "derivatives", label: t("intelligence:derivatives") }, { value: "anomalies", label: t("intelligence:anomalies") }, { value: "briefings", label: t("intelligence:dailyBriefings") }, { value: "smart", label: t("intelligence:smartMoney") }]} onChange={(value) => setHistoryKind(value as typeof historyKind)} /><button type="button" onClick={() => void loadHistory()} disabled={busy === "history"}><Search size={14} />{t("intelligence:queryLocal")}</button>{historyKind === "briefings" ? <button type="button" onClick={() => void runBriefing()} disabled={busy === "briefing"}><BrainCircuit size={14} />{t("intelligence:generateTodayBriefing")}</button> : null}<button type="button" onClick={() => downloadRecords(`intelligence-${historyKind}`, history, "csv")} disabled={history.length === 0}><Download size={14} />CSV</button><button type="button" onClick={() => downloadRecords(`intelligence-${historyKind}`, history, "json")} disabled={history.length === 0}><Download size={14} />JSON</button></div>
                <div className="intelligence-history-summary">{Object.entries(summary?.counts ?? {}).map(([key, count]) => <span key={key}><strong>{count}</strong>{key}</span>)}</div>
                <div className="intelligence-table-wrap"><table><thead><tr><th>{t("intelligence:record")}</th><th>{t("intelligence:summary")}</th><th>{t("common:time")}</th></tr></thead><tbody>{history.map((record) => { const id = recordId(record, historyKind); const title = historyKind === "briefings" ? `${textField(record, "briefingDate") || t("intelligence:marketBriefing")} · ${textField(record, "status")}` : textField(record, "title", "event", "nickname", "instCcy", "ccy", "name") || id; const summaryText = historyKind === "briefings" ? textField(record, "content", "error") : textField(record, "summary", "description", "sentiment", "pnl", "netNotionalUsdt"); return <tr key={id} data-i18n-skip><td><strong>{title}</strong><small>{id}</small></td><td>{summaryText ? `${summaryText.slice(0, 180)}${summaryText.length > 180 ? "…" : ""}` : "--"}</td><td>{formatTime(record.updatedAt ?? record.publishTime ?? record.eventTime ?? record.ts ?? record.time)}</td></tr>; })}</tbody></table></div>
              </div>
            ) : null}
          </section>
    </WorkspaceFrame>
  );
}
