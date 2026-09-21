export type CheckStatus = "pending" | "running" | "passed" | "failed";

export type StartupCheck = {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  latencyMs?: number;
};

export type ProxyConfigSummary = {
  enabled: boolean;
  proxyType: "HTTP" | "HTTPS" | "SOCKS5" | "NONE" | string;
  host: string;
  port: number;
  url?: string | null;
  username?: string | null;
  authConfigured: boolean;
};

export type ProxyConfigUpdate = {
  enabled: boolean;
  proxyType: "HTTP" | "HTTPS" | "SOCKS5" | "NONE" | string;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
};

export type ProxyTestResult = {
  ok: boolean;
  latencyMs: number;
  message: string;
  config: ProxyConfigSummary;
};

export type SensitiveConfigMigrationResult = {
  accounts: number;
  aiConfigured: boolean;
  proxyAuthConfigured: boolean;
  migratedAt: number;
};

export type WatchlistConfig = {
  symbols: string[];
};

export type SupportedLocale =
  | "zh-CN"
  | "zh-TW"
  | "en-US"
  | "ja-JP"
  | "ko-KR"
  | "de-DE"
  | "fr-FR"
  | "es-ES"
  | "pt-BR"
  | "ru-RU";

export type LanguagePreference = "system" | SupportedLocale;

export type UiPreferencesSummary = {
  language: LanguagePreference;
  resolvedLanguage: SupportedLocale;
};

export type AppUpdateRuntimeMode = "installed" | "source";

export type AppUpdateStatus =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "blocked"
  | "preparing"
  | "ready"
  | "downloading"
  | "installing"
  | "readyToRestart"
  | "failed";

export type AppUpdateState = {
  runtimeMode: AppUpdateRuntimeMode;
  status: AppUpdateStatus;
  currentVersion: string;
  latestVersion?: string | null;
  currentRevision?: string | null;
  latestRevision?: string | null;
  commitsBehind: number;
  available: boolean;
  releaseName?: string | null;
  releaseNotes?: string | null;
  releaseUrl?: string | null;
  publishedAt?: string | null;
  checkedAt?: number | null;
  blockedReason?: string | null;
  backupPath?: string | null;
  restartRequired: boolean;
};

export type AppUpdateBackup = {
  path: string;
  createdAt: number;
  encrypted: boolean;
  retainedCount: number;
};

export type OkxWsProbeResult = {
  ok: boolean;
  latencyMs: number;
  message: string;
};

export type OkxTimeState = {
  okxServerMs: number;
  localSendMs: number;
  localRecvMs: number;
  rttMs: number;
  clockOffsetMs: number;
  status: "synced" | "failed";
};

export type AccountSummary = {
  id: string;
  name: string;
  exchange: "okx";
  environment: "demo" | "live";
  apiKeyMasked: string;
  permissions: {
    read: boolean;
    trade: boolean;
    withdraw: boolean;
  };
};

export type AccountConfigDraft = {
  id?: string;
  name: string;
  apiKey?: string;
  secretKey?: string;
  passphrase?: string;
  permissions: {
    read: boolean;
    trade: boolean;
    withdraw: boolean;
  };
};

export type OkxBalance = {
  ccy: string;
  eq: string;
  availEq: string;
  availBal: string;
  cashBal: string;
  frozenBal: string;
  uTime: string;
};

export type OkxPosition = {
  instId: string;
  instType: string;
  mgnMode: string;
  posSide: string;
  pos: string;
  avgPx: string;
  markPx: string;
  upl: string;
  uplRatio: string;
  uplLastPx?: string;
  uplRatioLastPx?: string;
  lever: string;
  liqPx: string;
  imr?: string;
  margin?: string;
  mgnRatio?: string;
  notionalUsd?: string;
  adl?: string;
  ccy?: string;
  posId: string;
  cTime: string;
  uTime: string;
};

export type OkxPendingOrder = {
  instId: string;
  instType?: string;
  ordId: string;
  clOrdId: string;
  algoId?: string;
  algoClOrdId?: string;
  isAlgo?: boolean;
  side: string;
  posSide: string;
  tdMode: string;
  ordType: string;
  px: string;
  triggerPx?: string;
  triggerPxType?: string;
  ordPx?: string;
  tpTriggerPx?: string;
  tpTriggerPxType?: string;
  tpOrdPx?: string;
  slTriggerPx?: string;
  slTriggerPxType?: string;
  slOrdPx?: string;
  sz: string;
  accFillSz: string;
  avgPx: string;
  state: string;
  lever: string;
  reduceOnly: string;
  cTime: string;
  uTime: string;
};

export type PrivateAccountSnapshot = {
  accountId: string;
  environment: string;
  balances: OkxBalance[];
  positions: OkxPosition[];
  orders: OkxPendingOrder[];
  positionsComplete?: boolean;
  ordersComplete?: boolean;
  ordersError?: string | null;
  syncedAt: number;
};

export type PrivateWsStatus = {
  status: string;
  state?: "connecting" | "authenticating" | "subscribing" | "ready" | "stale" | "reconnecting" | "auth_failed" | "stopped" | string;
  accountId?: string | null;
  environment?: string | null;
  delayMs?: number | null;
  eventAt: number;
  reconnectAttempt?: number;
  lastReceivedAt?: number | null;
};

export type PublicWsStatus = {
  streamId: string;
  kind: "meta" | "books" | string;
  state: "connecting" | "ready" | "reconnecting" | "stopped" | string;
  status: string;
  symbols: string[];
  eventAt: number;
  lastReceivedAt?: number | null;
  delayMs?: number | null;
  /** Age of the newest ticker frame; never the max across meta channels. */
  tickerDelayMs?: number | null;
  /** Age of the newest trades frame, reported separately. */
  tradesDelayMs?: number | null;
  /** Frame arrival → event-loop lag: local backlog, not market data age. */
  queueLagMs?: number | null;
  reconnectAttempt: number;
};

export type PrivateHistorySyncRequest = {
  accountId?: string;
  instId?: string;
  maxPages?: number;
  force?: boolean;
  /**
   * Runs the deep-history archive pass after the interactive pass returns. Only
   * explicit user actions set it: scheduled and startup syncs keep serving the
   * stored snapshot instead of re-spending OKX's 5-requests/2s archive budget.
   */
  forceNetwork?: boolean;
};

export type PrivateHistorySyncResult = {
  accountId: string;
  environment: string;
  instId?: string | null;
  ordersFetched: number;
  ordersUpserted: number;
  archiveOrdersFetched: number;
  archiveOrdersUpserted: number;
  recentFillsFetched: number;
  recentFillsUpserted: number;
  fillsFetched: number;
  fillsUpserted: number;
  billsFetched: number;
  billsUpserted: number;
  archiveBillsFetched: number;
  archiveBillsUpserted: number;
  positionsFetched: number;
  positionsUpserted: number;
  retryEndpoints: number;
  newSyncEndpoints: number;
  backfillEndpoints: number;
  startedAt: number;
  finishedAt: number;
};

export type PrivateHistoryEndpointStatus = {
  scope: string;
  instId: string;
  status: string;
  cursor?: string | null;
  newestCursor?: string | null;
  oldestCursor?: string | null;
  attempt: number;
  fetched: number;
  upserted: number;
  lastError?: string | null;
  nextRetryAt?: number | null;
  lastStartedAt?: number | null;
  lastFinishedAt?: number | null;
  updatedAt: number;
};

export type PrivateHistoryStatusRequest = {
  accountId?: string;
  instId?: string;
};

export type PrivateHistoryStatusResponse = {
  accountId: string;
  environment: string;
  instId?: string | null;
  endpoints: PrivateHistoryEndpointStatus[];
  failed: number;
  retrying: number;
  running: number;
  updatedAt?: number | null;
};

export type PositionEpisodesRequest = {
  accountId?: string;
  instId?: string;
  limit?: number;
};

export type HistoricalOrdersRequest = {
  accountId?: string;
  instId?: string;
  limit?: number;
};

export type HistoricalFillsRequest = {
  accountId?: string;
  instId?: string;
  limit?: number;
};

export type AccountBillsRequest = {
  accountId?: string;
  instId?: string;
  limit?: number;
};

export type AccountPerformanceRequest = {
  accountId?: string;
  environment?: "demo" | "live";
  instId?: string | null;
  startTime?: number | null;
  endTime?: number | null;
};

export type AccountPerformanceCoverage = {
  hasBills: boolean;
  hasFills: boolean;
  hasEpisodes: boolean;
  billsCount: number;
  fillsCount: number;
  episodesCount: number;
  attributionComplete: boolean;
  attributionGapNetPnl: number;
  attributionGapFees: number;
  oldestPoint?: number | null;
  newestPoint?: number | null;
  warnings: string[];
};

export type AccountPerformancePoint = {
  time: number;
  equity: number;
  cumulativeReturnPct: number;
  drawdownPct: number;
};

export type AccountPerformanceTotals = {
  currentEquity: number;
  startEquity?: number | null;
  netPnl: number;
  returnPct?: number | null;
  maxDrawdownPct: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor?: number | null;
  fees: number;
  fundingFee: number;
  tradeCount: number;
  fillCount: number;
  episodeCount: number;
  winRatePct?: number | null;
};

export type AccountPerformanceAttribution = {
  operator: "ai" | "user" | "unknown" | string;
  label: string;
  netPnl: number;
  returnPct?: number | null;
  fees: number;
  tradeCount: number;
  episodeCount: number;
  winRatePct?: number | null;
};

export type AccountPerformanceSymbolBreakdown = {
  instId: string;
  netPnl: number;
  fees: number;
  tradeCount: number;
  episodeCount: number;
  winRatePct?: number | null;
};

export type PerformanceEpisodeHighlight = {
  id: string;
  instId: string;
  side: string;
  status: string;
  netPnl: number;
  returnPct?: number | null;
  openTime: number;
  closeTime?: number | null;
  durationMs?: number | null;
  maxQty: string;
  fees: number;
  fundingFee: number;
};

export type AccountPerformanceDailyPnl = {
  date: string;
  netPnl: number;
  fees: number;
  tradeCount: number;
};

export type AccountPerformanceSummary = {
  accountId: string;
  environment: string;
  startTime?: number | null;
  endTime?: number | null;
  generatedAt: number;
  coverage: AccountPerformanceCoverage;
  equityCurve: AccountPerformancePoint[];
  totals: AccountPerformanceTotals;
  attribution: AccountPerformanceAttribution[];
  symbolBreakdown: AccountPerformanceSymbolBreakdown[];
  highlights: {
    bestEpisode?: PerformanceEpisodeHighlight | null;
    worstEpisode?: PerformanceEpisodeHighlight | null;
    longestEpisode?: PerformanceEpisodeHighlight | null;
    shortestEpisode?: PerformanceEpisodeHighlight | null;
  };
  dailyPnl: AccountPerformanceDailyPnl[];
};

export type TradeAuditEventsRequest = {
  accountId?: string;
  instId?: string;
  limit?: number;
};

export type AccountBillsArchiveRequest = {
  accountId?: string;
  year: string;
  quarter: string;
  billType?: string;
  apply?: boolean;
};

export type AccountBillsArchiveImportRequest = {
  accountId?: string;
  year: string;
  quarter: string;
  billType?: string;
};

export type HistoricalOrderSummary = {
  accountId: string;
  environment: string;
  ordId: string;
  clOrdId?: string | null;
  instId: string;
  instType: string;
  side?: string | null;
  posSide?: string | null;
  tdMode?: string | null;
  ordType?: string | null;
  state?: string | null;
  px?: string | null;
  sz?: string | null;
  accFillSz?: string | null;
  avgPx?: string | null;
  pnl?: string | null;
  fee?: string | null;
  sourceEndpoint: string;
  operator: string;
  strategyId?: string | null;
  sessionId?: string | null;
  opportunityId?: string | null;
  agentRunId?: string | null;
  executionKey?: string | null;
  okxCtime?: number | null;
  okxUtime?: number | null;
  syncedAt: number;
};

export type HistoricalFillSummary = {
  accountId: string;
  environment: string;
  billId: string;
  ordId?: string | null;
  tradeId?: string | null;
  instId: string;
  instType: string;
  side?: string | null;
  posSide?: string | null;
  subType?: string | null;
  fillPx?: string | null;
  fillSz?: string | null;
  fillPnl?: string | null;
  fee?: string | null;
  feeCcy?: string | null;
  sourceEndpoint: string;
  operator: string;
  strategyId?: string | null;
  sessionId?: string | null;
  opportunityId?: string | null;
  agentRunId?: string | null;
  executionKey?: string | null;
  okxTs?: number | null;
  syncedAt: number;
  aiProfileId?: string | null;
  strategyName?: string | null;
  aiProfileName?: string | null;
};

export type AccountBillSummary = {
  accountId: string;
  environment: string;
  billId: string;
  instId?: string | null;
  instType?: string | null;
  ccy?: string | null;
  billType?: string | null;
  subType?: string | null;
  bal?: string | null;
  balChg?: string | null;
  posBal?: string | null;
  posBalChg?: string | null;
  sz?: string | null;
  px?: string | null;
  pnl?: string | null;
  fee?: string | null;
  ordId?: string | null;
  tradeId?: string | null;
  clOrdId?: string | null;
  execType?: string | null;
  mgnMode?: string | null;
  notes?: string | null;
  sourceEndpoint: string;
  okxTs?: number | null;
  syncedAt: number;
};

export type TradeAuditEventSummary = {
  id: string;
  accountId: string;
  environment: string;
  exchange: string;
  instId: string;
  instType: string;
  eventType: string;
  operation: string;
  status: string;
  orderType?: string | null;
  orderId?: string | null;
  clientOrderId?: string | null;
  side?: string | null;
  posSide?: string | null;
  tdMode?: string | null;
  size?: string | null;
  price?: string | null;
  operator: string;
  strategyId?: string | null;
  sessionId?: string | null;
  liveConfirmed: boolean;
  okxCode?: string | null;
  okxMessage?: string | null;
  error?: string | null;
  requestJson: string;
  responseJson?: string | null;
  createdAt: number;
};

export type AccountBillsArchiveStatus = {
  accountId: string;
  environment: string;
  year: string;
  quarter: string;
  billType?: string | null;
  requested: boolean;
  requestResult?: string | null;
  state?: string | null;
  fileHref?: string | null;
  okxTs?: number | null;
  updatedAt: number;
  rawJson?: string | null;
};

export type AccountBillsArchiveImportResult = {
  accountId: string;
  environment: string;
  year: string;
  quarter: string;
  billType?: string | null;
  fileHref: string;
  downloadedPath: string;
  rowsScanned: number;
  rowsUpserted: number;
  startedAt: number;
  finishedAt: number;
};

export type ClassifiedOkxError = {
  desicTerminalError?: boolean;
  /** Legacy field accepted during upgrades from desicTradeAI builds. */
  desicTradeError?: boolean;
  source?: string;
  operation?: string;
  category?: string;
  code?: string;
  message?: string;
  userMessage?: string;
  suggestion?: string;
  retryable?: boolean;
};

export type PositionEpisodeEvent = {
  id: string;
  eventType: string;
  origin: string;
  actorId?: string | null;
  strategyId?: string | null;
  ordId?: string | null;
  billId?: string | null;
  tradeId?: string | null;
  side?: string | null;
  posSide?: string | null;
  qty: string;
  price?: string | null;
  pnl?: string | null;
  fee?: string | null;
  feeCcy?: string | null;
  positionBefore?: string | null;
  positionAfter?: string | null;
  eventTime: number;
  source: string;
};

export type PositionEpisode = {
  id: string;
  accountId: string;
  environment: string;
  instType: string;
  instId: string;
  episodeSide: string;
  status: string;
  primaryOrigin: string;
  strategyId?: string | null;
  signalId?: string | null;
  tradePlanId?: string | null;
  openTime: number;
  closeTime?: number | null;
  openQty: string;
  maxQty: string;
  closedQty: string;
  remainingQty: string;
  avgOpenPx?: string | null;
  avgClosePx?: string | null;
  realizedPnl?: string | null;
  fees?: string | null;
  fundingFee?: string | null;
  liqPenalty?: string | null;
  netPnl?: string | null;
  lastTradeId?: string | null;
  lastFillTime?: number | null;
  events: PositionEpisodeEvent[];
};

export type OkxInstrumentSummary = {
  instId: string;
  instType: string;
  instFamily: string;
  baseCcy: string;
  quoteCcy: string;
  settleCcy: string;
  ctVal: string;
  ctValCcy: string;
  ctType: string;
  tickSz: string;
  lotSz: string;
  minSz: string;
  maxLmtSz: string;
  maxMktSz: string;
  lever: string;
  state: string;
  instCategory?: string;
  groupId?: string;
  listTime?: string;
  expTime?: string;
  securityName?: string;
  securityNameZhHans?: string;
  securityNameZhHant?: string;
  localizedSecurityName?: string;
  listingExchange?: string;
  securityMetadataSource?: string;
  securityLocalizationSource?: string;
  iconPath?: string | null;
  iconCached: boolean;
  updatedAt: number;
};

export type EquitySecuritySummary = {
  ticker: string;
  securityName: string;
  exchange: string;
};

export type EquitySecurityDirectory = {
  source: string;
  updatedAt: number;
  stale: boolean;
  securities: EquitySecuritySummary[];
};

export type EquitySecurityLocalization = {
  ticker: string;
  exchange: string;
  nameZhHans?: string;
  nameZhHant?: string;
  updatedAt: number;
};

export type EquitySecurityLocalizations = {
  source: string;
  localizations: EquitySecurityLocalization[];
};

export type MarketAssetsSummary = {
  cacheVersion?: number;
  instruments: OkxInstrumentSummary[];
  total: number;
  iconCached: number;
  iconFailed: number;
  iconFailedBases?: string[];
  iconRetryAfter?: number | null;
  cacheDir: string;
  updatedAt: number;
};

export type DiagnosticExportResult = {
  path: string;
  sizeBytes: number;
  createdAt: number;
};

export type ChartCsvExportResult = {
  path: string;
  sizeBytes: number;
};

export type StorageMaintenanceResult = {
  databasePath: string;
  databaseBytes: number;
  walBytes: number;
  walBytesBefore: number;
  reusableBytes: number;
  schemaVersion: number;
  rows: Record<string, number>;
  klineRanges: KlineDataRange[];
  deletedKlineSyncRuns: number;
  deletedAiMessages: number;
  deletedIntelligenceRows: Record<string, number>;
  finishedAt: number;
};

export type StorageStatusResult = {
  databasePath: string;
  databaseBytes: number;
  walBytes: number;
  reusableBytes: number;
  schemaVersion: number;
  lastMaintenanceAt?: number | null;
  rows: Record<string, number>;
  klineRanges: KlineDataRange[];
  checkedAt: number;
};

export type KlineDataRange = {
  symbol: string;
  interval: string;
  firstTime?: number | null;
  lastTime?: number | null;
  count: number;
};

export type OkxAccountConfigSummary = {
  acctLv: string;
  posMode: string;
  perm: string;
  acctStpMode: string;
  ctIsoMode: string;
  feeType: string;
  level: string;
  stgyType: string;
  liquidationGear: string;
  liquidationGearMeaning: string;
};

export type OkxTradeFeeSummary = {
  maker?: number | null;
  taker?: number | null;
  groupId?: string | null;
  level: string;
  ts: string;
};

export type OkxMaxOrderSummary = {
  maxBuy?: number | null;
  maxSell?: number | null;
  availBuy?: number | null;
  availSell?: number | null;
};

export type OkxLeverageInfo = {
  instId: string;
  mgnMode: string;
  posSide: string;
  lever: string;
};

export type OkxPositionTierSummary = {
  tier: string;
  minSz: string;
  maxSz: string;
  mmr: string;
  imr: string;
  maxLever: string;
};

export type LeverageInfoRequest = {
  accountId?: string;
  instId: string;
  mgnMode: "cross" | "isolated";
  environment: "demo" | "live";
};

export type SetLeverageRequest = LeverageInfoRequest & {
  lever: string;
  posSide?: "long" | "short" | "net";
};

export type SetLeverageResponse = {
  instId: string;
  mgnMode: string;
  requestedLever: string;
  results: OkxLeverageInfo[];
  warnings: string[];
};

export type LinearUsdtRiskBudgetRequest = {
  riskBudget: string;
  equity?: string;
  entryPrice: string;
  stopPrice: string;
  contractValue: string;
  entryFeeRate: string;
  exitFeeRate: string;
  minSize: string;
  lotSize: string;
};

export type LinearUsdtRiskBudget = {
  normalizedSize: string;
  estimatedPriceLoss: string;
  estimatedRoundTripFee: string;
  estimatedLossWithFees: string;
  pctOfEquity?: string;
  exceedsBudget: boolean;
  minimumSizeApplied: boolean;
};

export type LinearUsdtPerpetualEvaluationRequest = {
  size: string;
  entryPrice: string;
  contractValue: string;
  leverage: string;
  minSize: string;
  lotSize: string;
  equity?: string;
  availableUsdt?: string;
  maxSingleTradeMarginPct?: string;
  direction?: "long" | "short";
  stopPrice?: string;
  targetPrice?: string;
  atr?: string;
  entryFeeRate: string;
  exitFeeRate: string;
};

export type LinearUsdtPositionMetrics = {
  size: string;
  baseQuantity: string;
  notionalUsdt: string;
  effectiveExposureMultiple?: string | null;
  notionalPctOfEquity?: string | null;
  estimatedInitialMarginUsdt: string;
  marginPctOfEquity?: string | null;
  stopPrice?: string | null;
  stopDistance?: string | null;
  stopMovePct?: string | null;
  estimatedPriceLossAtStopUsdt?: string | null;
  estimatedEntryFeeUsdt: string;
  estimatedExitFeeUsdt: string;
  estimatedRoundTripFeeUsdt: string;
  estimatedStopLossWithFeesUsdt?: string | null;
  stopRiskPctOfEquity?: string | null;
  breakEvenPrice?: string | null;
  breakEvenMovePct?: string | null;
  targetPrice?: string | null;
  targetMovePct?: string | null;
  estimatedGrossProfitAtTargetUsdt?: string | null;
  estimatedExitFeeAtTargetUsdt?: string | null;
  estimatedRoundTripFeeAtTargetUsdt?: string | null;
  estimatedNetProfitAtTargetUsdt?: string | null;
  feeDragPctOfGrossProfit?: string | null;
  netRewardRiskRatio?: string | null;
  estimatedRoundTripFeePctOfInitialMargin?: string | null;
  estimatedNetTargetReturnPctOfInitialMargin?: string | null;
  estimatedNetTargetProfitPctOfEquity?: string | null;
  atr?: string | null;
  oneAtrPriceLossUsdt?: string | null;
  oneAtrRiskPctOfEquity?: string | null;
};

export type LinearUsdtPerpetualEvaluation = {
  requestedSize: string;
  direction?: "long" | "short" | null;
  costAssumptions: {
    entryFeeRate: string;
    exitFeeRate: string;
    slippageIncluded: boolean;
    fundingIncluded: boolean;
  };
  normalizedSize: string;
  sizeWasNormalized: boolean;
  candidate: LinearUsdtPositionMetrics;
  minimumOrder: LinearUsdtPositionMetrics;
  capacity: {
    equityUsdt?: string | null;
    availableUsdt?: string | null;
    maxSingleTradeMarginPct?: string | null;
    maxSingleTradeMarginUsdt?: string | null;
    maxSingleTradeNotionalUsdt?: string | null;
    maxSingleTradeSize?: string | null;
    candidateWithinAvailable?: boolean | null;
    candidateWithinProfileLimit?: boolean | null;
    minimumWithinAvailable?: boolean | null;
    minimumWithinProfileLimit?: boolean | null;
  };
};

export type InstrumentOperationKind = "cancel_orders" | "flatten_positions";

export type InstrumentOperationScope = {
  accountId?: string;
  environment: "demo" | "live";
  instId: string;
};

export type ExecuteInstrumentOperationRequest = InstrumentOperationScope & {
  operationId: string;
  previewId: string;
  confirmed: boolean;
  confirmedLive?: boolean;
};

export type InstrumentOperationQuery = InstrumentOperationScope & {
  operationId: string;
  expectedKind?: InstrumentOperationKind;
};

export type InstrumentOperationTarget = {
  key: string;
  targetType: string;
  instId: string;
  ordId?: string;
  clOrdId?: string;
  algoId?: string;
  algoClOrdId?: string;
  posId?: string;
  mgnMode?: string;
  posSide?: string;
  side?: string;
  size?: string;
  signedSize?: string;
  markPx?: string;
  lever?: string;
  orderType?: string;
  state?: string;
  accumulatedFill?: string;
};

export type InstrumentOperationCounts = {
  ordinary: number;
  trigger: number;
  trailing: number;
  conditionalOco: number;
  partiallyFilled: number;
  positions: number;
  planned: number;
  submitted: number;
  accepted: number;
  confirmed: number;
  failed: number;
  unknown: number;
  residual: number;
  filledBeforeCancel: number;
};

export type InstrumentOperationPreview = {
  previewId: string;
  operationKind: InstrumentOperationKind;
  accountId: string;
  environment: "demo" | "live";
  instId: string;
  fingerprint: string;
  counts: InstrumentOperationCounts;
  targets: InstrumentOperationTarget[];
  warnings: string[];
  createdAt: number;
  expiresAt: number;
};

export type InstrumentOperationTargetView = {
  target: InstrumentOperationTarget;
  state: string;
  executionKey?: string;
  response?: unknown;
  error?: string;
  updatedAt: number;
};

export type InstrumentOperationView = {
  operationId: string;
  previewId: string;
  operationKind: InstrumentOperationKind;
  accountId: string;
  environment: "demo" | "live";
  instId: string;
  phase: string;
  outcome?: string;
  counts: InstrumentOperationCounts;
  targets: InstrumentOperationTargetView[];
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};

export type TradeExecutionGuardsRequest = InstrumentOperationScope;

export type TradeExecutionGuard = {
  executionKey: string;
  operation: "place_order" | "amend_order" | string;
  status: "submitting" | "reconciling" | "unknown" | string;
  instId: string;
  action: string;
  size?: string;
  message: string;
  updatedAt: number;
  scopeUncertain: boolean;
  credentialMatches: boolean;
};

export type OrderSpecV2OrderType =
  | "limit"
  | "market"
  | "post_only"
  | "ioc"
  | "fok"
  | "trigger"
  | "trailing";

export type OrderSpecV2TriggerSource = "last" | "mark" | "index";

export type OrderSpecV2 = {
  version: 2;
  requestedOrderType: OrderSpecV2OrderType;
  trigger?: {
    source: OrderSpecV2TriggerSource;
    triggerPrice: string;
    execution: "market" | "limit";
    orderPrice?: string;
  };
  trailing?: {
    source: "last";
    activePx?: string;
    callbackRatio: string;
  };
};

export type PlaceOrderRequest = {
  accountId?: string;
  instId: string;
  tdMode: "cross" | "isolated";
  orderType: "limit" | "market" | "trigger";
  ticketMode: "open" | "close";
  action: "long" | "short" | "close-long" | "close-short";
  price: string;
  size: string;
  lever: string;
  environment: "demo" | "live";
  confirmedLive?: boolean;
  operator?: "user" | "ai" | "strategy" | "system";
  strategyId?: string | null;
  sessionId?: string | null;
  executionKey: string;
  algoClOrdId?: string;
  orderSpecV2?: OrderSpecV2;
  attachAlgoOrds?: Array<{
    attachAlgoClOrdId?: string;
    tpTriggerPx?: string;
    tpOrdPx?: string;
    tpTriggerPxType?: string;
    slTriggerPx?: string;
    slOrdPx?: string;
    slTriggerPxType?: string;
    sz?: string;
  }>;
};

export type PlaceOrderResponse = {
  ordId: string;
  clOrdId: string;
  sCode: string;
  sMsg: string;
  ts: string;
  side: string;
  posSide: string;
  reduceOnly: boolean;
  operator: string;
  strategyId?: string | null;
  sessionId?: string | null;
};

export type CancelOrderRequest = {
  accountId?: string;
  environment: "demo" | "live";
  instId: string;
  confirmedLive?: boolean;
  ordId?: string;
  clOrdId?: string;
  isAlgo?: boolean;
  algoId?: string;
  algoClOrdId?: string;
};

export type CancelOrderResponse = {
  ordId: string;
  clOrdId: string;
  sCode: string;
  sMsg: string;
  ts: string;
};

export type AmendOrderRequest = {
  accountId?: string;
  environment: "demo" | "live";
  instId: string;
  ordId?: string;
  clOrdId?: string;
  newSize?: string;
  newPrice?: string;
  confirmedLive?: boolean;
  executionKey: string;
};

export type PlaceAlgoOrderRequest = {
  accountId?: string;
  environment: "demo" | "live";
  instId: string;
  tdMode: "cross" | "isolated";
  posSide: "long" | "short" | "net";
  side: "buy" | "sell";
  ordType: "conditional" | "oco";
  size: string;
  tpTriggerPx?: string;
  tpOrdPx?: string;
  slTriggerPx?: string;
  slOrdPx?: string;
  confirmedLive?: boolean;
  operator?: "user" | "ai" | "system";
  strategyId?: string | null;
  sessionId?: string | null;
  executionKey: string;
};

export type AmendAlgoOrderRequest = {
  accountId?: string;
  environment: "demo" | "live";
  instId: string;
  algoId?: string;
  algoClOrdId?: string;
  newSize?: string;
  /** Trigger-order trigger price. Used with newOrdPx for `ordType=trigger`. */
  newTriggerPx?: string;
  /** Trigger-order execution price. `-1` means execute at market. */
  newOrdPx?: string;
  newTpTriggerPx?: string;
  newTpOrdPx?: string;
  newSlTriggerPx?: string;
  newSlOrdPx?: string;
  confirmedLive?: boolean;
  executionKey: string;
};

export type CancelAlgoOrderRequest = {
  accountId?: string;
  environment: "demo" | "live";
  instId: string;
  algoId?: string;
  algoClOrdId?: string;
  confirmedLive?: boolean;
};

export type ListAlgoOrdersRequest = {
  accountId?: string;
  environment: "demo" | "live";
  instId?: string;
  includeHistory?: boolean;
};

export type ClosePositionRequest = {
  accountId?: string;
  environment: "demo" | "live";
  instId: string;
  mgnMode: "cross" | "isolated";
  posSide: "long" | "short" | "net";
  confirmedLive?: boolean;
};

export type OkxAlgoOrder = {
  accountId: string;
  environment: string;
  instId: string;
  instType: string;
  algoId: string;
  algoClOrdId: string;
  ordId: string;
  clOrdId: string;
  side: string;
  posSide: string;
  tdMode: string;
  ordType: string;
  state: string;
  sz: string;
  actualSide: string;
  actualSz: string;
  triggerPx: string;
  triggerPxType: string;
  ordPx: string;
  activePx?: string;
  callbackRatio?: string;
  callbackSpread?: string;
  tpTriggerPx: string;
  tpTriggerPxType: string;
  tpOrdPx: string;
  slTriggerPx: string;
  slTriggerPxType: string;
  slOrdPx: string;
  reduceOnly: string;
  failCode: string;
  triggerTime: string;
  cTime: string;
  uTime: string;
  operator: string;
  sourceEndpoint: string;
};

export type ChartOrderLine = {
  id: string;
  instId?: string;
  type: "limit" | "trigger" | "tp" | "sl" | "position-entry" | "liquidation";
  source?: "order" | "algo" | "position";
  label: string;
  price: number;
  side?: string;
  posSide?: string;
  estimatedPnl?: number;
  estimatedPnlRatio?: number;
  estimateEntryPrice?: number;
  estimateSize?: number;
  estimateContractValue?: number;
  color: string;
  tone: "positive" | "negative" | "active" | "warning" | "neutral";
  editable?: boolean;
  editKind?: "order-price" | "algo-trigger" | "algo-tp" | "algo-sl";
  /** The trigger price for a plan order. `price` mirrors this while on chart. */
  triggerPrice?: number;
  /** The price used after a plan order triggers. `-1` means market execution. */
  orderPrice?: number | null;
  orderId?: string;
  clientOrderId?: string;
  algoId?: string;
  algoClientOrderId?: string;
  opportunityId?: string | null;
  executionKey?: string | null;
  size?: string;
};

export type ChartOrderLineEdit = {
  line: ChartOrderLine;
  price: number;
  triggerPrice?: number;
  orderPrice?: number | null;
};

export type PositionLineTradeIntent = {
  kind: "limit_close" | "take_profit" | "trailing_profit" | "stop_loss" | "market_close";
  instId: string;
  posSide: "long" | "short" | "net";
  side: "buy" | "sell";
  targetPrice: number;
  entryPrice: number;
  currentPrice: number;
  size: string;
  estimatedPnl?: number;
  estimatedPnlRatio?: number;
  existingAlgoId?: string;
  existingAlgoClientOrderId?: string;
  existingAlgoSide?: "tp" | "sl";
};

export type ChartRiskRewardTradeIntent = {
  action: "entry" | "bracket";
  instId: string;
  side: "long" | "short";
  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
};

export type ChartSignalMarker = {
  id: string;
  time: number;
  price: number;
  side?: string | null;
  posSide?: string | null;
  source: "ai" | "strategy";
  label: string;
};

export type ChartFillMarker = {
  id: string;
  time: number;
  price: number;
  /** Explicit semantic action for sources that already know open/close side. */
  action?: "open-long" | "open-short" | "close-long" | "close-short" | string | null;
  side?: string | null;
  posSide?: string | null;
  size?: string | null;
  pnl?: string | null;
  orderId?: string | null;
  opportunityId?: string | null;
  executionKey?: string | null;
  operator?: string | null;
  strategyId?: string | null;
  aiProfileId?: string | null;
  strategyName?: string | null;
  aiProfileName?: string | null;
  /** UI-only aggregation metadata; raw fills and audit records remain unchanged. */
  groupCount?: number;
  groupStartTime?: number;
  groupEndTime?: number;
  label: string;
};

export type ChartTradeSourceProfile = {
  id: string;
  name: string;
};

export type ChartTradeSources = {
  aiProfiles: ChartTradeSourceProfile[];
  strategyProfiles: ChartTradeSourceProfile[];
};

export type ChartPositionRange = {
  id: string;
  instId: string;
  entryPrice: number;
  currentPrice: number;
  contractValue?: number;
  posSide?: string | null;
  size?: string | null;
  pnl?: string | null;
  pnlRatio?: string | null;
  label: string;
  existingAlgos?: Array<{
    side: "tp" | "sl";
    algoId?: string;
    algoClientOrderId?: string;
  }>;
};

export type OkxAlgoOrderResult = {
  algoId: string;
  algoClOrdId: string;
  sCode: string;
  sMsg: string;
  ts: string;
};

export type AlgoOrdersResponse = {
  accountId: string;
  environment: string;
  orders: OkxAlgoOrder[];
  syncedAt: number;
  pendingReadComplete?: boolean;
};

export type TradePrecheckRequest = {
  accountId?: string;
  instId: string;
  tdMode: "cross" | "isolated";
  orderType: "limit" | "market" | "trigger";
  ticketMode: "open" | "close";
  action?: "long" | "short" | "close-long" | "close-short";
  price: string;
  stopPrice?: string;
  targetPrice?: string;
  atr?: string;
  size: string;
  lever: string;
  environment: "demo" | "live";
};

export type TradePrecheckResponse = {
  ok: boolean;
  blocked: boolean;
  reasons: string[];
  warnings: string[];
  notional?: number | null;
  estimatedMargin?: number | null;
  maxSingleTradeMarginPct?: number | null;
  maxSingleTradeMargin?: number | null;
  maxSingleTradeNotional?: number | null;
  maxSingleTradeSize?: string | null;
  estimatedFee?: number | null;
  usdtEquity?: number | null;
  stopPrice?: number | null;
  stopDistance?: number | null;
  estimatedStopLoss?: number | null;
  estimatedRoundTripFee?: number | null;
  estimatedStopLossWithFees?: number | null;
  stopLossPctOfUsdtEquity?: number | null;
  breakEvenPrice?: number | null;
  estimatedNetProfitAtTarget?: number | null;
  feeDragPctOfGrossProfit?: number | null;
  netRewardRiskRatio?: number | null;
  feeRateSource: string;
  perpetualEvaluation?: LinearUsdtPerpetualEvaluation | null;
  liquidationText: string;
  availableUsdt?: number | null;
  longAvailable?: number | null;
  shortAvailable?: number | null;
  normalizedPrice?: string | null;
  normalizedSize?: string | null;
  instrument?: OkxInstrumentSummary | null;
  accountConfig?: OkxAccountConfigSummary | null;
  fee?: OkxTradeFeeSummary | null;
  maxOrder?: OkxMaxOrderSummary | null;
  leverageInfo?: OkxLeverageInfo[] | null;
  positionTier?: OkxPositionTierSummary | null;
  timing?: {
    totalMs: number;
    instrumentMs: number;
    accountContextMs: number;
    limitsMs: number;
    snapshotSource: string;
    accountConfigCacheHit: boolean;
  } | null;
  source: string;
};

export type TradeOpportunityStatus =
  | "pending"
  | "approved"
  | "executing"
  | "submitted"
  | "partially_filled"
  | "executed"
  | "closed"
  | "rejected"
  | "failed"
  | "cancelled"
  | "expired"
  | "pending_blocked"
  | "recovery_blocked";

export type TradeOpportunityProtectiveOrder = {
  kind: "take_profit" | "stop_loss" | "tpsl";
  triggerPx?: string;
  orderPx?: string;
  triggerPxType?: "last" | "index" | "mark" | string;
  closeFraction?: string;
};

export type TradeOpportunityCreateRequest = {
  accountId?: string;
  environment: "demo" | "live";
  instId: string;
  tdMode: "cross" | "isolated";
  intent: "open" | "close" | "cancel" | "amend";
  exitKind?: "take_profit" | "stop_loss" | "strategy_exit" | "emergency" | string | null;
  closeFraction?: string | null;
  direction: "long" | "short";
  size?: string;
  orderType: "limit" | "market" | "trigger" | "cancel" | "amend";
  price?: string;
  orderId?: string;
  clientOrderId?: string;
  algoId?: string;
  algoClientOrderId?: string;
  newPrice?: string;
  newSize?: string;
  lever?: string;
  entryCondition?: string;
  takeProfit?: TradeOpportunityProtectiveOrder | null;
  stopLoss?: TradeOpportunityProtectiveOrder | null;
  invalidationPrice?: string;
  maxSlippageBps?: number;
  confidence?: number;
  timeHorizon?: string;
  strategyName?: string;
  evidence?: string[];
  riskNotes?: string[];
  reason: string;
  sourceSessionId?: string | null;
  originType?: "manual" | "ai" | "strategy" | "system";
  strategyKind?: "rule" | "multifactor" | "hybrid";
  strategyId?: string | null;
  strategyVersionId?: string | null;
  strategyRunId?: string | null;
  signalId?: string | null;
  factorPoolVersionId?: string | null;
  expiresAt?: number | null;
  agentProfileId?: string | null;
  agentRunId?: string | null;
  relatedOpportunityId?: string | null;
  duplicateResolution?: "reuse" | "revise" | "create_new" | string | null;
  duplicateResolutionReason?: string | null;
  confirmedLive?: boolean;
  decisionContextId?: string | null;
};

export type TradeOpportunity = TradeOpportunityCreateRequest & {
  id: string;
  status: TradeOpportunityStatus;
  ticketMode: "open" | "close" | "manage";
  action: "long" | "short" | "close-long" | "close-short" | "cancel" | "amend";
  estimatedMargin?: number | null;
  estimatedFee?: number | null;
  availableUsdt?: number | null;
  revision?: number;
  fingerprint?: string;
  executionKey?: string | null;
  marketSnapshotJson?: unknown;
  precheckJson?: unknown;
  executionResultJson?: unknown;
  orderId?: string | null;
  clientOrderId?: string | null;
  algoId?: string | null;
  algoClientOrderId?: string | null;
  error?: string | null;
  createdAt: number;
  updatedAt: number;
};

export type DecisionContext = {
  decisionContextId: string;
  capturedAt: number;
  expiresAt: number;
  snapshotAgeMs?: number;
  initialSnapshot?: unknown;
  finalSnapshot: unknown;
  changes: unknown;
  accountSnapshot: unknown;
  precheck: unknown;
  limitations: string[];
};

export type MarketRadarResearchScore = {
  instId: string;
  asOf: number;
  observations: number;
  relativeStrength30dPct: number;
  volatility20dPct: number;
  volumeRatio20d?: number | null;
  trendQuality30d: number;
  strengthScore: number;
  lowVolatilityScore: number;
  activityScore: number;
  trendQualityScore: number;
  compositeScore: number;
  rank: number;
  modelVersion: string;
};

export type MarketRadarComponentDelta = {
  composite: number;
  strength: number;
  lowVolatility: number;
  activity: number;
  trendQuality: number;
  liquidity: number;
};

export type MarketRadarRankChange = {
  instId: string;
  currentRank: number;
  rank1h?: number | null;
  rankDelta1h?: number | null;
  rank24h?: number | null;
  rankDelta24h?: number | null;
  rank7d?: number | null;
  rankDelta7d?: number | null;
  componentDelta24h?: MarketRadarComponentDelta | null;
};

export type MarketRadarAlertTrigger = {
  eventId: string;
  ruleId: string;
  ruleName: string;
  kind: "enterTop" | "rankRise" | "activityAbove" | "spreadAbove" | "newListing" | "historyReady";
  instId: string;
  currentValue: number;
  threshold: number;
  triggeredAt: number;
};

export type MarketRadarSnapshotResult = {
  snapshotAt: number;
  universeSize: number;
  changes: MarketRadarRankChange[];
  alerts: MarketRadarAlertTrigger[];
};

export type MarketRadarValidationHorizon = {
  horizonDays: number;
  observations: number;
  dates: number;
  rankIc?: number | null;
  trainingRankIc?: number | null;
  validationRankIc?: number | null;
  icStabilityDelta?: number | null;
  topQuantileReturnPct?: number | null;
  bottomQuantileReturnPct?: number | null;
  grossSpreadPct?: number | null;
  netSpreadAfterCostPct?: number | null;
  topQuantileWinRatePct?: number | null;
  topQuantileTurnoverPct?: number | null;
};

export type MarketRadarValidationRegime = {
  regime: "up" | "sideways" | "down";
  horizonDays: number;
  observations: number;
  dates: number;
  rankIc?: number | null;
  grossSpreadPct?: number | null;
};

export type MarketRadarValidationReport = {
  status: "accumulating" | "ready";
  generatedAt: number;
  lookbackDays: number;
  snapshotDates: number;
  firstSnapshotAt?: number | null;
  lastSnapshotAt?: number | null;
  modelVersions: string[];
  horizons: MarketRadarValidationHorizon[];
  regimes: MarketRadarValidationRegime[];
  limitations: string[];
};

export type MarketRadarSavedItem = {
  id: string;
  name: string;
  definitionJson: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type MarketRadarHistoryStatus = {
  state: "idle" | "running" | "completed" | "partial" | "failed";
  phase: "idle" | "preparing" | "daily" | "hourly" | "complete";
  total: number;
  completed: number;
  failed: number;
  dailyReady: number;
  hourlyReady: number;
  currentSymbol?: string | null;
  message: string;
  startedAt?: number | null;
  finishedAt?: number | null;
};

export type Ticker = {
  instId: string;
  last: string;
  lastSz: string;
  askPx: string;
  askSz: string;
  bidPx: string;
  bidSz: string;
  open24h: string;
  high24h: string;
  low24h: string;
  vol24h: string;
  volCcy24h: string;
  ts: number;
};

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  confirm: boolean;
};

export type OrderBookLevel = {
  px: string;
  sz: string;
  orders?: string;
};

export type OrderBook = {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  ts: number;
  seqId?: string;
};

export type Trade = {
  tradeId: string;
  px: string;
  sz: string;
  side: "buy" | "sell";
  ts: number;
};

export type ChartWindowRequest = {
  id?: string | null;
  symbol: string;
  timeframe: string;
  accountId?: string | null;
  environment?: "demo" | "live" | string | null;
  singlePane?: boolean;
};

export type ChartPaneState = {
  id: string;
  symbol: string;
  timeframe: string;
};

export type ChartWindowState = {
  id: string;
  label: string;
  symbol: string;
  timeframe: string;
  accountId?: string | null;
  environment?: "demo" | "live" | string | null;
  singlePane?: boolean;
  panes: ChartPaneState[];
  updatedAt: number;
};

export type ChartWindowSummary = ChartWindowState & {
  isOpen: boolean;
};

export type FundingRate = {
  instType?: string;
  instId: string;
  fundingRate: string;
  nextFundingRate?: string;
  fundingTime: number;
  nextFundingTime?: number;
  method?: string;
  ts?: number;
};

export type MarketSnapshot = {
  ticker?: Ticker | null;
  tickers: Record<string, Ticker>;
  orderbook?: OrderBook | null;
  orderbookInstId?: string | null;
  orderbooks: Record<string, OrderBook>;
  trades: Trade[];
  tradesInstId?: string | null;
  tradesByInst: Record<string, Trade[]>;
  candle?: Candle | null;
  candleInstId?: string | null;
  candleBar?: string | null;
  candles: Record<string, Candle>;
  fundingRates: Record<string, FundingRate>;
  privateSnapshot?: PrivateAccountSnapshot | null;
  privateSnapshots?: Record<string, PrivateAccountSnapshot>;
};

export type KlineSyncReport = {
  symbol: string;
  interval: string;
  status: "scanning" | "backfilling" | "complete" | "partial" | "failed" | string;
  expected: number;
  existing: number;
  missing: number;
  invalid: number;
  invalidReasons: string[];
  attempt: number;
  retryState: "none" | "pending_retry" | "permanent_gap" | string;
  retryAfter?: number | null;
  fetched: number;
  inserted: number;
  startedAt: number;
  finishedAt?: number | null;
  message: string;
  progressDetail?: string | null;
};

export type KlineSyncSummary = {
  reports: KlineSyncReport[];
};

export type AiConfigSummary = {
  provider: string;
  model: string;
  baseUrl: string;
  apiKeyMasked: string;
  stream: boolean;
  configured: boolean;
  permissionMode: AiPermissionMode | AiLegacyPermissionMode;
  reasoningDepth: AiReasoningDepth;
  activeModelId: string;
  models: AiModelConfigSummary[];
  systemPrompt: string;
  customRules: string;
  enabledSkills: string[];
  skillDefinitions: AiSkillDefinition[];
  skillRuntimeTrust: Record<string, boolean>;
  openAgent: boolean;
  workspaceRoots: string[];
};

export type AiReasoningDepth = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type AiSkillVersionMode = "latest" | "pinned";

export type AiModelConfigSummary = {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKeyMasked: string;
  configured: boolean;
  permissionMode: AiPermissionMode | AiLegacyPermissionMode;
  reasoningDepth: AiReasoningDepth;
  /** Positive fallback capacity in tokens for a model entry. */
  contextWindow?: number;
  /** Cline's exact catalog capacity remains authoritative at runtime. */
  contextWindowSource?: "catalog";
};

export type AiModelConfigUpdate = {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  permissionMode?: AiPermissionMode;
  reasoningDepth?: AiReasoningDepth;
  contextWindow?: number;
};

export type AiConnectionTestResult = {
  id: string;
  name: string;
  provider: string;
  model: string;
  contextWindow?: number;
};

export type AiLocalCliStatus = {
  id: "openai-codex-cli" | "claude-code" | string;
  name: string;
  installed: boolean;
  authenticated: boolean;
  version?: string | null;
  authMethod?: string | null;
  loginCommand: string;
};

export type AiLocalAuthStatus = {
  providers: AiLocalCliStatus[];
};

export type AiPermissionMode = "advisor" | "copilot" | "limited_auto";

export type AiLegacyPermissionMode = "readonly" | "approval" | "full";

export type AiSkillCapabilities = {
  workspaceRead?: boolean;
  workspaceWrite?: boolean;
  network?: boolean;
};

export type AiSkillEntrypoint = {
  name: string;
  script: string;
  timeoutSeconds: number;
  inputSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
};

export type AiSkillRuntimeManifest = {
  schemaVersion: number;
  runtime?: {
    kind: "node" | "python" | "shell" | string;
    dependencyMode: "locked" | "allow-unlocked" | string;
    entrypoints: AiSkillEntrypoint[];
    backgroundSafe: boolean;
  } | null;
  capabilities: AiSkillCapabilities;
};

export type AiSkillBundleFile = {
  path: string;
  sha256: string;
  bytes: number;
};

export type AiSkillBundleSummary = {
  schemaVersion: number;
  bundleHash: string;
  files: AiSkillBundleFile[];
  source: {
    kind: string;
    reference?: string | null;
    revision?: string | null;
    subpath?: string | null;
  };
  manifest: AiSkillRuntimeManifest;
};

export type AiSkillDefinition = {
  id: string;
  name: string;
  description: string;
  rules: string;
  content: string;
  builtin?: boolean;
  bundle?: AiSkillBundleSummary | null;
};

export type AiConfigUpdate = {
  provider?: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  stream?: boolean;
  permissionMode?: AiPermissionMode;
  reasoningDepth?: AiReasoningDepth;
  contextWindow?: number;
  activeModelId?: string;
  models?: AiModelConfigUpdate[];
  systemPrompt?: string;
  customRules?: string;
  enabledSkills?: string[];
  skillDefinitions?: AiSkillDefinition[];
  openAgent?: boolean;
  workspaceRoots?: string[];
};

export type AiAutomationTab =
  | "profiles"
  | "agents"
  | "runs"
  | "wake_conditions"
  | "reviews"
  | "optimization"
  | "notifications";

/**
 * Agent 库（契约 v3 C7）。库里以 `<data_dir>/workspace/.cline/agents/<id>/AGENTS.md`
 * 为唯一真相，列表由 `ai_agents_list` 扫目录返回。
 */
export type AiAgentEnvelope = "standard" | "risk";

export type AiAgentSource = "builtin" | "custom" | "ai";

/** 列表项：不返回正文（正文走 `ai_agent_read`）。字段名与 Rust `AiAgentSummary` 逐字一致。 */
export type AiAgentSummary = {
  id: string;
  name: string;
  role: string;
  envelope: AiAgentEnvelope;
  skills: string[];
  requiresAccount: boolean;
  source: AiAgentSource;
  version: number;
  updatedAt: number;
  enabledByProfiles: string[];
  missingSkills: string[];
  missingAccount: boolean;
  modified: boolean;
  /** C15：旧文件里出现过已废弃的 `scopes` 字段时为 true（只做一行灰字提示，不报错、不阻塞保存）。 */
  scopesDeprecated?: boolean;
  /**
   * C20.5：历史内置角色（已停用）。不被"全选内置"选中，但**手动勾选仍然生效**；
   * 旧勾选保留在配置里，不静默丢弃用户选择。
   */
  deprecated?: boolean;
};

/** 详情：summary 字段 + 完整 AGENTS.md 原文。 */
export type AiAgentDetail = AiAgentSummary & { content: string };

export type AiCodexTemplatePreview = {
  name: string;
  description: string;
  instructions: string;
  skillIds: string[];
  /** 方案模板类型已删除；Codex 预览命令若保留，阶段仍沿用同一枚举。 */
  phase: "primary" | "review" | "final";
  model?: string | null;
  rejectedFields: string[];
  notes: string[];
};

export type AiAgentProfile = {
  id: string;
  name: string;
  enabled: boolean;
  mode: AiPermissionMode | AiLegacyPermissionMode;
  accountId?: string | null;
  environment: "demo" | "live";
  symbols: string[];
  scanIntervalMinutes: number;
  skillIds: string[];
  skillVersions?: Record<string, number>;
  skillVersionModes?: Record<string, AiSkillVersionMode>;
  model?: string | null;
  reasoningDepth: AiReasoningDepth;
  historyLookbackDays: number;
  similarityWindowMinutes: number;
  entryToleranceBps: number;
  targetLeverage: number;
  maxSingleTradeMarginPct: number;
  minWakeIntervalSeconds: number;
  maxRunsPerHour: number;
  feishuEnabled: boolean;
  dailyReviewEnabled: boolean;
  allowedWakeConditionTypes: string[];
  /**
   * C14 协作编排总开关（载荷闸门）：false → 运行载荷 `enabledAgents` 为空（等价旧 `off`），
   * 但 `enabledAgentIds` 原样保留，重新开启即恢复；true + 空名单 = 配置不完整提示，不是关闭。
   */
  collaborationEnabled: boolean;
  /** C19：试判阶段配置（默认 enforce；`off` 等价今天的行为）。 */
  triage: AiTriageConfig;
  /** C29：Profile 类型（缺字段 = "ai"）。 */
  profileType?: AiProfileType;
  /** C29.7：快判模式字段（仅 `profileType === "fastlane"` 时读写；默认值见 C29.4）。 */
  fastlaneStylePreset?: FastlaneStylePreset;
  fastlaneStyle?: string;
  fastlaneRiskPerTradePct?: number;
  fastlaneMaxDailyLossPct?: number;
  fastlaneMaxConcurrent?: number;
  fastlaneMaxSlippageBps?: number;
  fastlaneMaxActionsPerMinute?: number;
  fastlaneQualityFloor?: number;
  /**
   * **入场分门槛**（C29 变更 B，2026-09-21）：打分臂的方向判定线
   * （`max(long_score, short_score) ≥ 本值` 且不并列 → 方向 = argmax；否则观望）。
   * 默认 **1.5（保守）**；`score` 是 0–4 分布上的**期望值**（实测集中 0.2–1.9），
   * 所以可配区间是 0.5–3.0（取 2/2.5/3 结构性打不中，实验实测 0% 给方向率）。
   */
  fastlaneEntryScoreFloor?: number;
  /**
   * **降险分门槛**（C29.17，2026-09-21）：降险臂自己的方向判定线（`reduce_score ≥ 本值` → 判降险，
   * 且**只作用于既有持仓**）。与 `fastlaneEntryScoreFloor` **各自独立可调**，
   * 默认同为 **1.5**（= C29.14"复用同一门槛"的行为 → 默认下行为零变化）；
   * `score` 是 0–4 分布上的期望值 → 可配区间同为 0.5–3.0。
   * 降险比开仓更适合放宽：它不产生新仓位、不放大暴露（宁多减一点，不少减）。
   */
  fastlaneReduceScoreFloor?: number;
  fastlaneConfidenceFloor?: number;
  fastlaneEventBlackoutMinutes?: number;
  /** C29.5「时段与事件」：交易时段（默认 24h）。契约 C29.7 未列该字段，待 B-RUST 确认命名。 */
  fastlaneTradingHours?: "24h" | "day" | "night";
  fastlaneNotifyPolicy?: FastlaneNotifyPolicy;
  fastlaneJevModel?: string;
  /** C29：Jev 服务地址（私有部署指向自建端点）；留空 = 用官方默认。 */
  fastlaneJevBaseUrl?: string;
  fastlaneJevTimeoutMs?: number;
  fastlaneLlmTimeoutMs?: number;
  /** 必须为 `"none"`（关思考）：开思考实测 8.1s 且内容为空。UI 只读展示。 */
  fastlaneLlmReasoningEffort?: string;
  /**
   * C24：单 Agent 极简模式。仅在 `collaborationEnabled === false` 时生效；
   * `minimal` = 只调工具、不输出任何正文，收尾 summary 一句话（≤160 字符）。
   */
  singleAgentMode: AiSingleAgentMode;
  /** 勾选的 Agent 库 id（顺序即勾选顺序；重复/不存在的 id 由 Rust 侧丢弃）。 */
  enabledAgentIds: string[];
  /**
   * 旧配置迁移提示（由 Rust 在 Profile 引用了**已下线 Agent** 时填充，空则不返回）。
   * UI 只读展示、不写回；仅用于一次性说明"你的勾选被改了"。
   */
  migrationNotes?: string[];
  createdAt: number;
  updatedAt: number;
};

/**
 * C29：Profile 类型。`"ai"` = 原有深入分析 Profile；`"fastlane"` = 快判模式。
 * 旧 Profile / 缺字段一律视为 `"ai"`，行为完全不变。
 */
export type AiProfileType = "ai" | "fastlane";

/** C29.4：快判风格预设。 */
export type FastlaneStylePreset = "long_pullback" | "range_both" | "breakout_follow" | "custom";

/** C29.4：通知策略（契约默认 `on_open_close`）。 */
export type FastlaneNotifyPolicy = "every_action" | "on_open_close" | "none";

/** C24：单 Agent 模式（协作关闭时生效）。 */
export type AiSingleAgentMode = "standard" | "minimal";

/** C19 试判（triage）：Profile 级配置。字段名逐字对齐契约 C19.1 的 JSON。 */
export type AiTriageMode = "off" | "shadow" | "enforce";

export type AiTriageEscalate = {
  /** 持仓 / 挂单发生变化。 */
  positionOrOrderChanged: boolean;
  /** 止损距离 ≤ 该百分比（%）即强制深度。 */
  stopDistancePct: number;
  /** 维持保证金率阈值（%）。OKX 口径「越大越安全，≤100% 即强平」，默认 150。C25④ 起比较方向固定为此口径。 */
  marginRatioPct: number;
  /** 标记位被确认 K 线突破。 */
  confirmedBreakOfFlaggedLevel: boolean;
  /** ≥N 个独立条件共振。 */
  conditionResonance: number;
  /** 重要事件。 */
  importantNews: boolean;
};

export type AiTriageConfig = {
  mode: AiTriageMode;
  maxSkips: number;
  maxSilenceMinutes: number;
  skipSampleRate: number;
  escalate: AiTriageEscalate;
};

export type AiRunTriageVerdict = "skip" | "escalate";

/** C29.7：快判运行记录六组（字段名与 Rust `fastlane_json` 一致）。 */
export type AiFastlaneRunRecord = {
  trigger?: {
    source?: "condition" | "silence" | "manual" | string;
    conditionType?: string | null;
    params?: unknown;
  } | null;
  gate?: {
    ok?: boolean;
    data?: unknown;
    anomaly?: unknown;
    conflict?: unknown;
    reasons?: string[];
    /** 这道门作用于哪条路径（`open` = 只作用于开新仓；变更 A 之后质量/置信度门恒为 `open`）。 */
    appliedTo?: string | null;
    /** 这道门被谁豁免（`risk_reduction` = Jev 判减仓/平仓，降险不受质量/置信度门约束）。 */
    bypassedFor?: string | null;
    /**
     * **C29.18 入场质量门的读数**（侧车算是唯一实现，Rust 只读透传）：三条代码判据的取数 / 阈值 /
     * 结论。`applicable: false` = 本门**不适用**（没有开仓方向 / 没给快照）——不是"门过了"。
     */
    entryQuality?: {
      applicable?: boolean;
      skipReason?: string | null;
      direction?: string | null;
      structure_ok?: boolean | null;
      stop_placeable?: boolean | null;
      rr_ok?: boolean | null;
      reasons?: string[];
      rr?: number | null;
      rr_floor?: number | null;
      stop_distance_atr?: number | null;
      stop_anchor_atr?: number | null;
      nearest_structure_atr?: number | null;
      levels_count?: number;
      stop_side_count?: number;
      target_side_count?: number;
      [key: string]: unknown;
    } | null;
  } | null;
  /**
   * 本轮动作分支的 intent 口径（侧车给）：`round` / `close`（停机平仓轮）/ `reduce`（Jev 判降险）。
   * 两种降险的动作体 `intent` 都是 `close`（Rust `action_intent` 只认那个）——
   * 靠这个字段把"用户停机命令"与"Jev 自判减仓"在记录里分开。
   */
  intent?: string | null;
  jev?: {
    action?: string;
    probabilities?: Record<string, number> | null;
    confidence?: number;
    /**
     * **观察量（C29.18，2026-09-21）**：`quality` 这一问已从 Jev 问题面删除（换问法实验证明它对
     * "该不该做"没有可用判别力），入场质量改由代码判据决定（`gate.entryQuality`）。
     * 记录里**保留**只为复盘：老记录 / 老侧车响应带它 → 照原样显示；**缺失时是 `null`**
     * （UI 显示 `--`），绝不等同于"质量 0 分"。**它不参与任何判定**，也不是不动手的理由。
     */
    quality?: number | null;
    latencyMs?: number;
    raw?: unknown;
    /**
     * **打分臂（C29 变更 B，2026-09-21）**：两个 0–4 期望分 + 判定门槛 + 判定依据。
     * `entryScoreDecision`：`direction` / `below_floor` / `tie` / `score_missing` / `legacy_action`，
     * 或**降险臂接管时的码**（C29.14）：`reduce`（本轮按降险动作，开仓臂不参与这次判定）/
     * `reduce_without_position`（该降险但无持仓）/ `reduce_position_unknown`（该降险但持仓事实缺失）。
     * 有这几个字段时 `action` 是**代码**按分数判的（不是模型的标签选择）。
     */
    longScore?: number | null;
    shortScore?: number | null;
    entryScoreFloor?: number | null;
    entryScoreDecision?: string | null;
    /**
     * **降险臂（C29.14，2026-09-21）**：第三个打分问题 `reduce_score`（0–4，问"现在该减仓/平仓
     * 有多该做"，针对现存持仓、无持仓给 0）与它的判定。
     * `reduceScoreFloor` 自 **C29.17** 起是**独立门槛**（配置字段 `fastlaneReduceScoreFloor`）：
     * **默认与 `entryScoreFloor` 同值 1.5**（默认下行为与解耦前逐字一致），但两者可分别调 ——
     * 落到记录里的是**生效值**，不再强制相等（复盘据此判断降险用的是哪条线）。
     * `reduceScoreDecision`：`reduce` / `reduce_without_position` / `reduce_position_unknown` / `below_floor`。
     * `reducePositionFact`：降险臂看到的持仓事实 `held` / `flat` / `unknown`（`unknown` = 读不到，不猜）。
     */
    reduceScore?: number | null;
    reduceScoreFloor?: number | null;
    reduceScoreDecision?: string | null;
    reducePositionFact?: string | null;
    /** 置信度门的值来源：`action_node`（旧形状）/ `none`（打分臂无 action 节点 → 该门本轮不参与）。 */
    confidenceSource?: string | null;
  } | null;
  llm?: {
    latencyMs?: number;
    /** 真实调用的模型名（Rust 已把内部 `model-…` id 解析成 provider 模型名）。 */
    model?: string | null;
    /** 尝试次数（>1 = 重试过；UI 只在重试时显示，避免噪声）。 */
    attempts?: number;
    params?: unknown;
    validation?: { ok?: boolean; reasons?: string[] } | null;
    opportunityId?: string | null;
    wakeConditions?: number;
  } | null;
  action?: {
    kind?: "watch" | "opportunity" | "trade" | "kill_switch" | string;
    opportunityId?: string | null;
    orderId?: string | null;
    reason?: string | null;
  } | null;
  timing?: {
    fetchMs?: number;
    jevMs?: number;
    llmMs?: number;
    codeMs?: number;
    totalMs?: number;
  } | null;
  tokens?: {
    jevIn?: number;
    jevOut?: number;
    llmIn?: number;
    llmOut?: number;
  } | null;
};

export type AiRunExpert = {
  id?: string;
  expertId?: string;
  /** 运行时 agent id（事件流里的 agentId）。 */
  agentId?: string;
  /** 库里的专家 id（= lane 的 id，与 agentStart.configuredAgentId 一致）。 */
  configuredAgentId?: string;
  name?: string;
  expertName?: string;
  role?: string;
  mode?: "parallel" | "serial";
  grantedScopes?: string[];
  /** 主 Agent 给它的提问全文（侧车拼装后的最终任务）。 */
  taskPrompt?: string;
  /** 专家报告全文（Markdown）。 */
  report?: string;
  toolCalls?: number;
  durationMs?: number;
  startedAt?: number;
  endedAt?: number;
  tokenUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
  /** 该专家会话没有可用 token 记账（例如老记录或未报告）。 */
  tokensUnavailable?: boolean;
};

export type AiRunTriageEvidence = {
  fact: string;
  source: string;
  at: string;
};

/** C19.3：运行记录里的试判块（未试判时整体缺省）。 */
export type AiRunTriage = {
  mode?: AiTriageMode;
  /**
   * C25①：Rust 现在发字符串；旧形状只发布尔 `escalate`。两者都读（UI 侧映射：
   * `escalate === true → "escalate"`，`false → "skip"`），避免历史 `is-true` / 恒假判断。
   */
  verdict?: AiRunTriageVerdict | string;
  escalate?: boolean;
  /** C19/C25：阶段标记（`triage` / `deep`）；C25⑤ 用它判断是否进入深度分析。 */
  phase?: string;
  reasons?: string[];
  evidence?: AiRunTriageEvidence[];
  /** 硬升级命中原因（如「止损距离 1.2%」）；非空即视为强制升级。 */
  forcedBy?: string[];
  forced?: boolean;
  /** 抽样复检：skip 判定但按 skipSampleRate 仍执行深度。 */
  sampled?: boolean;
  /** 分阶段记账：试判段 token 与深度段 token。 */
  triageTokens?: number;
  deepTokens?: number;
  triageUsage?: AiUsageSummary | null;
  deepUsage?: AiUsageSummary | null;
};

export type AiAutomationRun = {
  id: string;
  profileId: string;
  triggerType: string;
  status: string;
  /** C19：试判结果（`status: skipped` 时必然存在）。 */
  triage?: AiRunTriage | null;
  /**
   * C21.3 软审计：分析结果的排版提醒（例如「缺小节：观察条件」「事实与证据无时间戳」）。
   * **不阻断、不改写**正文 —— UI 只加一行 warn 提示，正文仍按原样渲染。
   */
  summaryFormatWarnings?: unknown[] | null;
  /** C20.6 补充：升级了但没有派专家时的解释与"未说明理由"标记。 */
  audit?: {
    selfAnalysisReason?: string | null;
    selfAnalysisUnjustified?: boolean;
  } | null;
  /** C29：运行记录类型（`"fastlane"` 时详情显示快判六组，且不显示专家相关旧区块）。 */
  recordKind?: string | null;
  /** C29.7：快判运行记录六组（`fastlane_json`）。 */
  fastlane?: AiFastlaneRunRecord | null;
  /** C24：该次运行的单 Agent 模式（`minimal` 时详情显示「极简模式」徽标）。 */
  singleAgentMode?: AiSingleAgentMode | string | null;
  /**
   * C23.2：逐专家详情（Rust 从事件流落库：`agentStart.taskPrompt` + `agentDone.result.text`）。
   * 缺字段表示老记录；UI 显示占位，不留空白。
   */
  experts?: AiRunExpert[] | null;
  /** C20.6：本轮结论引用了哪些专家事实（专家 id / 名称 + 证据要点）。 */
  usedEvidence?: unknown[] | null;
  /** C20.6：逐条回应反方意见（接受 / 反驳 + 依据；未被回应单独标出）。 */
  contrarianResolutions?: unknown[] | null;
  summary?: string | null;
  error?: string | null;
  startedAt: number;
  finishedAt?: number | null;
  nextWakeAt?: number | null;
  actionCounts?: {
    opportunity?: number;
    wake?: number;
    trade?: number;
    notification?: number;
  } | null;
  tokenUsage?: AiUsageSummary | null;
};

export type AiTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

export type AiUsageQuality = "providerReported" | "reconstructed" | "partial" | "unreported";

export type AiUsageCoverage = {
  inputOutput: boolean;
  cacheRead: boolean;
  cacheWrite: boolean;
  reasoning: boolean;
};

export type AiUsageSummary = {
  schemaVersion: number;
  provider: string;
  modelId: string;
  model: string;
  modelName: string;
  reported: boolean;
  quality: AiUsageQuality;
  coverage: AiUsageCoverage;
  agentCount: number;
  reportedAgentCount: number;
  unreportedAgentCount: number;
  usage: AiTokenUsage;
  mainUsage: AiTokenUsage;
};

export type AiTokenUsagePeriod = {
  usage: AiTokenUsage;
  coverage: AiUsageCoverage;
  turnCount: number;
  sessionCount: number;
  partialTurnCount: number;
  unreportedTurnCount: number;
};

export type AiTokenUsageByModel = {
  provider: string;
  modelId: string;
  model: string;
  modelName: string;
  today: AiTokenUsagePeriod;
  yesterday: AiTokenUsagePeriod;
  sevenDays: AiTokenUsagePeriod;
};

export type AiTokenUsageDashboard = {
  generatedAt: number;
  windowStart: number;
  today: AiTokenUsagePeriod;
  yesterday: AiTokenUsagePeriod;
  sevenDays: AiTokenUsagePeriod;
  byModel: AiTokenUsageByModel[];
};

export type AiAutomationRunStatus = Pick<
  AiAutomationRun,
  "id" | "status" | "summary" | "error" | "finishedAt" | "nextWakeAt"
>;

export type AiAutomationRunDetail = {
  run: AiAutomationRun;
  trigger: unknown;
  profileSnapshot: unknown;
  templateSnapshot?: unknown;
  skillVersions: unknown;
  assistantText?: string | null;
  reasoning?: string | null;
  toolEvents: unknown[];
  initialMarketSnapshot: unknown;
  finalDecision: unknown;
};

export type AiWakeCondition = {
  id: string;
  profileId: string;
  source: string;
  planMode: "any" | "all" | string;
  conditionType: string;
  config: unknown;
  status: string;
  expiresAt?: number | null;
  lastTriggeredAt?: number | null;
  createdAt: number;
};

export type AiAutomationReview = {
  id: string;
  episodeId: string;
  status: string;
  summary: string;
  findings: unknown;
  suggestions: unknown;
  netPnl?: string | number | null;
  createdAt: number;
  updatedAt: number;
};

export type AiDailyMarketReview = {
  id: string;
  profileId: string;
  profileName: string;
  reviewDate: string;
  status: string;
  symbols: string[];
  summary: string;
  error?: string | null;
  runId?: string | null;
  createdAt: number;
  updatedAt: number;
};

export type AiAutomationReviewDetailRequest = {
  accountId?: string;
  episodeId: string;
  bar?: string;
  candleLimit?: number;
};

export type AiAutomationReviewDetail = {
  episode: PositionEpisode;
  orders: HistoricalOrderSummary[];
  fills: HistoricalFillSummary[];
  candles: Candle[];
  bar: string;
  windowStart: number;
  windowEnd: number;
  warnings: string[];
};

export type AiOptimizationSuggestion = {
  id: string;
  reviewId?: string | null;
  title: string;
  problem: string;
  evidence: unknown;
  sampleSize: number;
  currentSkillId?: string | null;
  currentSkillVersion?: number | null;
  proposedChanges: unknown;
  baselineSkill?: AiSkillDefinition | null;
  proposedSkill?: AiSkillDefinition | null;
  benefits: unknown;
  risks: unknown;
  status: string;
  createdAt: number;
  updatedAt: number;
};

export type AiNotificationDelivery = {
  id: string;
  channel: string;
  status: string;
  title: string;
  content?: string | null;
  level?: string | null;
  profileId?: string | null;
  profileName?: string | null;
  runId?: string | null;
  relatedType?: string | null;
  relatedId?: string | null;
  error?: string | null;
  createdAt: number;
  sentAt?: number | null;
};

export type AiSkillVersion = {
  id: string;
  skillId: string;
  version: number;
  status: string;
  definition: AiSkillDefinition;
  sourceSuggestionId?: string | null;
  createdAt: number;
  publishedAt?: number | null;
};

export type FeishuConfigSummary = {
  enabled: boolean;
  configured: boolean;
  webhookMasked: string;
  eventTypes: string[];
};

export type FeishuConfigUpdate = {
  enabled: boolean;
  webhookUrl?: string;
  eventTypes: string[];
};

/** Realised result attributed to one Profile over a trailing window. Fills carry
 *  the money and reference their run, so the Profile is reached through runs. */
export type AiProfilePerformance = {
  profileId: string;
  netPnlUsdt: number;
  feesUsdt: number;
  fillCount: number;
  windowDays: number;
};

export type AiAutomationSummary = {
  masterEnabled: boolean;
  profilePerformance?: AiProfilePerformance[];
  profiles: AiAgentProfile[];
  runs: AiAutomationRun[];
  wakeConditions: AiWakeCondition[];
  reviews: AiAutomationReview[];
  dailyMarketReviews: AiDailyMarketReview[];
  optimizationSuggestions: AiOptimizationSuggestion[];
  notificationDeliveries: AiNotificationDelivery[];
  skillVersions: AiSkillVersion[];
};

export type AiAutomationOverview = Pick<
  AiAutomationSummary,
  "masterEnabled" | "profiles" | "skillVersions" | "profilePerformance"
> & {
  counts: AiAutomationCounts;
};

export type AiAutomationCounts = {
  runs: number;
  runningRuns: number;
  activeWakeConditions: number;
  reviews: number;
  pendingOptimizationSuggestions: number;
  notifications: number;
};

export type AiAutomationSection = Pick<
  AiAutomationSummary,
  "runs" | "wakeConditions" | "reviews" | "dailyMarketReviews" | "optimizationSuggestions" | "notificationDeliveries" | "skillVersions"
> & {
  section: Exclude<AiAutomationTab, "profiles" | "agents">;
};

/** i18n 目录把 "agents" 列在 automation 命名空间下。 */
export type AiAutomationSectionTab = Exclude<AiAutomationTab, "profiles" | "agents">;

export type NotificationSettingsSummary = {
  feishu: FeishuConfigSummary;
};

export type AiAutomationEvent = {
  type: "notificationError" | "runCompleted" | "runFailed" | "reviewCreated" | "suggestionCreated" | string;
  message: string;
  accountId?: string | null;
  profileId?: string | null;
  profileName?: string | null;
  instId?: string | null;
  consecutiveErrors?: number | null;
  error?: string | null;
  action?: {
    tab?: AiAutomationTab | string | null;
    id?: string | null;
    settingsTab?: string | null;
  } | null;
};

export type AiChatMessage = {
  id?: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type AiPromptDelivery = "queue" | "steer";

export type AiPendingPrompt = {
  sessionId: string;
  id: string;
  prompt: string;
  delivery: AiPromptDelivery;
  attachmentCount: number;
  localMessageId?: string;
};

export type AiContextBreakdown = {
  systemTokens: number;
  toolsTokens: number;
  conversationTokens: number;
  estimated: true;
  breakdownSource: "heuristic";
};

export type AiContextUsage = {
  usedTokens: number;
  contextWindow?: number;
  measuredAt: number;
  usedSource: "clineMessages";
  contextWindowSource?: "clineModelCatalog" | "customModelConfig" | "fallback";
  breakdown?: AiContextBreakdown;
};

export type AiSession = {
  id: string;
  title: string;
  status: string;
  origin: "user" | "automation" | "indicator" | "strategy";
  createdAt: number;
  updatedAt: number;
};

export type AiStoredMessage = {
  id: string;
  sessionId: string;
  role: "system" | "user" | "assistant" | "tool" | string;
  content: string;
  reasoning?: string | null;
  toolJson?: string | null;
  tokenUsage?: AiUsageSummary | null;
  status?: string | null;
  createdAt: number;
};

export type AiSessionSnapshot = {
  session: AiSession;
  messages: AiStoredMessage[];
};

export type AiEvent =
  | { type: "status"; sessionId: string; status: string; message: string }
  | { type: "delta"; sessionId: string; channel: "text" | "reasoning" | string; content: string; reasoningId?: string | null; reasoningSummary?: boolean | null }
  | { type: "toolCall"; sessionId: string; toolCallId?: string; name: string; arguments: unknown; allowed?: boolean; blocked?: boolean; policy?: string; agentId?: string | null; configuredAgentId?: string | null; parentAgentId?: string | null; startedAt?: number }
  | { type: "toolResult"; sessionId: string; toolCallId?: string; name: string; result: unknown; summary: string; ok: boolean; agentId?: string | null; configuredAgentId?: string | null; parentAgentId?: string | null; startedAt?: number; endedAt?: number; requestedAt?: number; executionStartedAt?: number; executionEndedAt?: number }
  | { type: "usage"; sessionId: string; usage: unknown }
  | { type: "contextUsage"; sessionId: string; usage: AiContextUsage }
  | { type: "pendingPrompts"; sessionId: string; prompts: AiPendingPrompt[] }
  | { type: "pendingPromptSubmitted"; sessionId: string; prompt: AiPendingPrompt }
  | { type: "pendingPromptError"; sessionId: string; prompt: string; promptId?: string; localMessageId?: string; delivery: AiPromptDelivery; operation?: "submit" | "list" | "update" | "delete"; message: string }
  | { type: "turnStarted"; sessionId: string; prompt?: string | null; promptId?: string; localMessageId?: string; delivery?: AiPromptDelivery; startedAt: number }
  | {
      type: "agentStart";
      sessionId: string;
      agentId: string;
      parentAgentId?: string | null;
      role?: string | null;
      title?: string | null;
      task: string;
      configuredAgentId?: string | null;
      startedAt?: number;
    }
  | { type: "agentDone"; sessionId: string; agentId: string; configuredAgentId?: string | null; status: string; result: unknown; error?: string | null; endedAt?: number }
  | { type: "agentProgressNotice"; sessionId: string; agentId: string; agentName: string; elapsedMs: number; silentMs: number; phase: string }
  /** P2：AI 生成 Agent 草稿的真流式增量（按 `requestId` 关联，不进未读、不进检查点）。 */
  | { type: "agentDraftDelta"; sessionId: string; requestId: string; delta: string; chars: number }
  | { type: "teamEvent"; sessionId: string; event: unknown }
  | {
      type: "approvalRequest";
      sessionId: string;
      approvalId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
      reason?: string | null;
    }
  | { type: "approvalResolved"; sessionId: string; approvalId: string; approved: boolean; reason?: string | null }
  | { type: "error"; sessionId: string; message: string }
  | { type: "done"; sessionId: string; finishReason?: string | null };

export type AiMarketReadRequest = {
  instId: string;
  bar?: string;
  bars?: string[];
  limit?: number;
  startTime?: number;
  endTime?: number;
  confirmedOnly?: boolean;
};

export type AiMarketScanRequest = {
  instIds?: string[];
  bars?: string[];
  limit?: number;
  sortBy?: "change" | "volume" | "fundingRate" | "orderBookPressure";
  topN?: number;
};

export type AiIndicatorRequest = {
  instId: string;
  bar: string;
  limit?: number;
  indicators?: string[];
  startTime?: number;
  endTime?: number;
};

export type AiAccountReadRequest = {
  accountId?: string;
};

export type AiHistoricalReadRequest = {
  accountId?: string;
  instId?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
  state?: string;
  side?: string;
  posSide?: string;
};

export type AiTradePrecheckRequest = {
  accountId?: string;
  environment: "demo" | "live";
  instId: string;
  tdMode: "cross" | "isolated";
  ticketMode?: "open" | "close";
  action: "long" | "short" | "close-long" | "close-short";
  orderType: "limit" | "market" | "trigger";
  price?: string;
  stopPrice?: string;
  size: string;
  lever?: string;
};

export type AiUiToolRequest = {
  id?: string;
  instId?: string;
  bar?: string;
  payload?: Record<string, unknown>;
};

export type AiChartToolRequest = AiUiToolRequest;
export type AiAlertToolRequest = AiUiToolRequest;
export type AiScriptToolRequest = AiUiToolRequest;
