import type { AccountSummary } from "../types";
import { invokeDesktop, invokeOptional, listenOptional } from "./tauri";

export type IntelligenceRecord = Record<string, unknown>;

export type IntelligenceSettings = {
  collectorAccountId?: string | null;
  enabled: boolean;
  newsPollSeconds: number;
  watchlistNewsPollSeconds: number;
  sentimentPollMinutes: number;
  smartMoneyPollMinutes: number;
  leaderboardPollMinutes: number;
  trackedTraderPollMinutes: number;
  calendarPollHours: number;
  derivativesPollMinutes: number;
  activeDerivativesPollSeconds: number;
  derivativesSlowPollMinutes: number;
  activeDerivativesRiskPollMinutes: number;
  derivativesRiskPollMinutes: number;
  extraInstruments: string[];
  briefingEnabled: boolean;
  briefingProfileId?: string | null;
  articleContentRetentionDays: number;
  fetchLogRetentionDays: number;
  derivativesFiveMinuteRetentionDays: number;
  derivativesHourlyRetentionDays: number;
  liquidationRetentionDays: number;
};

export type IntelligenceSyncState = {
  key: string;
  status: string;
  lastStartedAt?: number | null;
  lastSucceededAt?: number | null;
  lastFailedAt?: number | null;
  nextRunAt?: number | null;
  error?: string | null;
  rowsWritten: number;
};

export type IntelligenceResponse = {
  source: string;
  sourceVersion: string;
  fetchedAt: number;
  dataAt?: number | null;
  ageMs?: number;
  dataVersion?: string | null;
  stale: boolean;
  staleReason?: string | null;
  refreshStatus?: string;
  refreshQueued?: boolean;
  items: IntelligenceRecord[];
  pagination: { hasMore: boolean; nextAfter?: string | null };
  limitations: string[];
  truncated: boolean;
  coverage?: number | null;
  expectedPoints?: number | null;
  seriesMetadata?: Array<{
    kind: string;
    instId?: string | null;
    granularity?: string | null;
    bucketStartAt?: number | null;
    bucketEndAt?: number | null;
    observedAt?: number | null;
    fetchedAt?: number | null;
    effectiveAgeMs?: number | null;
    bucketStatus: "partial" | "closed" | "incomplete" | string;
    sourceMode: string;
    stale: boolean;
    staleReason?: string | null;
  }>;
};

export type IntelligenceSummary = {
  settings: IntelligenceSettings;
  syncStates: IntelligenceSyncState[];
  counts: Record<string, number>;
  latestNews: IntelligenceRecord[];
  sentimentRankings: IntelligenceRecord[];
  economicEvents: IntelligenceRecord[];
  smartTraders: IntelligenceRecord[];
  smartSignals: IntelligenceRecord[];
  trackedTraders: IntelligenceRecord[];
};

export type NewsQuery = {
  accountId?: string;
  keyword?: string;
  coins?: string[];
  importance?: "high" | "low";
  platform?: string;
  sentiment?: "bullish" | "bearish" | "neutral";
  sortBy?: "latest" | "relevant";
  language?: "zh-CN" | "en-US";
  detailLevel?: "brief" | "summary" | "full";
  startTime?: number;
  endTime?: number;
  after?: string;
  limit?: number;
  localOnly?: boolean;
};

export type SentimentQuery = {
  accountId?: string;
  coins?: string[];
  period?: "1h" | "4h" | "24h";
  trendPoints?: number;
  sortBy?: "hot" | "bullish" | "bearish";
  limit?: number;
  localOnly?: boolean;
};

export type CalendarQuery = {
  accountId?: string;
  region?: string;
  importance?: "1" | "2" | "3";
  startTime?: number;
  endTime?: number;
  limit?: number;
  localOnly?: boolean;
};

export type SmartMoneyQuery = {
  accountId?: string;
  operation: string;
  authorId?: string;
  authorIds?: string[];
  keyword?: string;
  instId?: string;
  instCcy?: string;
  instCcyList?: string[];
  topInstruments?: number;
  updateTime?: string;
  ts?: string;
  dataVersion?: string;
  granularity?: "1h" | "1d";
  sortType?: "pnl" | "pnlRatio";
  period?: "3" | "7" | "30" | "90";
  pnl?: string;
  winRatio?: string;
  maxRetreat?: string;
  asset?: string;
  lmtNum?: number;
  after?: string;
  before?: string;
  limit?: number;
  localOnly?: boolean;
};

export type DerivativesQuery = {
  instId: string;
  period?: "5m" | "1H" | "4H" | "1D";
  startTime?: number;
  endTime?: number;
  limit?: number;
  localOnly?: boolean;
};

export type NewsEventQuery = {
  id?: string;
  keyword?: string;
  coins?: string[];
  importance?: "high" | "low" | "1" | "2" | "3";
  startTime?: number;
  endTime?: number;
  limit?: number;
};

export type BriefingQuery = {
  profileId?: string;
  briefingDate?: string;
  limit?: number;
};

export type DerivativesView =
  | "overview"
  | "positioning"
  | "takerFlow"
  | "crowding"
  | "fundingBasis"
  | "liquidations"
  | "systemRisk"
  | "positionTiers";

export function eligibleIntelligenceAccounts(accounts: AccountSummary[]) {
  return accounts.filter((account) => account.exchange.toLowerCase() === "okx" && account.environment === "live" && account.permissions.read);
}

export async function loadIntelligenceSummary() {
  return invokeOptional<IntelligenceSummary>("intelligence_summary");
}

async function requireDesktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const result = await invokeDesktop<T>(command, args);
  if (result === null) throw new Error("市场情报仅可在桌面应用中使用");
  return result;
}

export async function syncIntelligence(accountId?: string, scope = "all") {
  return requireDesktop<IntelligenceSummary>("intelligence_sync_now", { request: { accountId, scope } });
}

export async function markActiveIntelligenceInstrument(instId: string) {
  return requireDesktop<{ instId: string; activeUntil: number }>("intelligence_mark_active_instrument", {
    request: { instId }
  });
}

export async function queryNews(query: NewsQuery) {
  return requireDesktop<IntelligenceResponse>("intelligence_news_query", { query });
}

export async function readNewsDetail(accountId: string | undefined, id: string, localOnly = false) {
  const { intelligenceLanguage, resolvedLocale } = await import("../i18n/runtime");
  return requireDesktop<IntelligenceResponse>("intelligence_news_detail", {
    request: { accountId, id, language: intelligenceLanguage(resolvedLocale()), localOnly }
  });
}

export async function querySentiment(query: SentimentQuery) {
  return requireDesktop<IntelligenceResponse>("intelligence_sentiment_query", { query });
}

export async function queryCalendar(query: CalendarQuery) {
  return requireDesktop<IntelligenceResponse>("intelligence_calendar_query", { query });
}

export async function querySmartMoney(query: SmartMoneyQuery) {
  return requireDesktop<IntelligenceResponse>("intelligence_smart_query", { query });
}

const DERIVATIVES_COMMANDS: Record<DerivativesView, string> = {
  overview: "intelligence_derivatives_overview",
  positioning: "intelligence_derivatives_positioning",
  takerFlow: "intelligence_derivatives_taker_flow",
  crowding: "intelligence_derivatives_crowding",
  fundingBasis: "intelligence_derivatives_funding_basis",
  liquidations: "intelligence_derivatives_liquidations",
  systemRisk: "intelligence_derivatives_system_risk",
  positionTiers: "intelligence_derivatives_position_tiers"
};

export async function queryDerivatives(view: DerivativesView, query: DerivativesQuery) {
  return requireDesktop<IntelligenceResponse>(DERIVATIVES_COMMANDS[view], { query });
}

export async function queryNewsEvents(query: NewsEventQuery = {}) {
  return requireDesktop<IntelligenceResponse>("intelligence_news_events_query", { query });
}

export async function readNewsEvent(id: string) {
  return requireDesktop<IntelligenceResponse>("intelligence_news_event_detail", { query: { id } });
}

export async function readNewsReaction(id: string) {
  return requireDesktop<IntelligenceResponse>("intelligence_news_reaction_query", { query: { id } });
}

export async function queryAnomalies(query: DerivativesQuery) {
  return requireDesktop<IntelligenceResponse>("intelligence_anomalies_query", { query });
}

export async function queryBriefings(query: BriefingQuery = {}) {
  return requireDesktop<IntelligenceResponse>("intelligence_briefings_query", { query });
}

export async function generateBriefing(profileId: string) {
  return requireDesktop<IntelligenceResponse>("intelligence_briefing_generate", { request: { profileId } });
}

export async function saveIntelligenceSettings(settings: IntelligenceSettings) {
  return requireDesktop<IntelligenceSettings>("intelligence_settings_save", { settings });
}

export async function trackSmartTrader(authorId: string, nickname: string, tracked: boolean) {
  return requireDesktop<IntelligenceSummary>("intelligence_track_trader", {
    request: { authorId, nickname, tracked }
  });
}

export async function listenIntelligenceEvents(handler: (event: IntelligenceRecord) => void) {
  return listenOptional<IntelligenceRecord>("intelligence:event", handler);
}
