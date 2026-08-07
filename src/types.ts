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
  reconnectAttempt: number;
};

export type PrivateHistorySyncRequest = {
  accountId?: string;
  instId?: string;
  maxPages?: number;
  force?: boolean;
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
  iconPath?: string | null;
  iconCached: boolean;
  updatedAt: number;
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
  stopPrice?: string;
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
  atr?: string | null;
  oneAtrPriceLossUsdt?: string | null;
  oneAtrRiskPctOfEquity?: string | null;
};

export type LinearUsdtPerpetualEvaluation = {
  requestedSize: string;
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
  /** UI-only aggregation metadata; raw fills and audit records remain unchanged. */
  groupCount?: number;
  groupStartTime?: number;
  groupEndTime?: number;
  label: string;
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
};

export type AiConnectionTestResult = {
  id: string;
  name: string;
  provider: string;
  model: string;
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

export type AiSkillDefinition = {
  id: string;
  name: string;
  description: string;
  rules: string;
  content: string;
  builtin?: boolean;
};

export type AiConfigUpdate = {
  provider?: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  stream?: boolean;
  permissionMode?: AiPermissionMode;
  reasoningDepth?: AiReasoningDepth;
  activeModelId?: string;
  models?: AiModelConfigUpdate[];
  systemPrompt?: string;
  customRules?: string;
  enabledSkills?: string[];
  skillDefinitions?: AiSkillDefinition[];
};

export type AiAutomationTab =
  | "profiles"
  | "runs"
  | "wake_conditions"
  | "reviews"
  | "optimization"
  | "notifications";

export type AiProfileSubAgent = {
  id: string;
  name: string;
  role: string;
  responsibility: string;
  scopes: string[];
  required: boolean;
  enabled: boolean;
};

export type AiAgentScheme = {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  agents: AiProfileSubAgent[];
  createdAt: number;
  updatedAt: number;
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
  multiAgentMode: "off" | "auto" | "custom";
  multiAgentMaxAgents: number;
  multiAgentSchemeId?: string | null;
  multiAgents: AiProfileSubAgent[];
  createdAt: number;
  updatedAt: number;
};

export type AiAutomationRun = {
  id: string;
  profileId: string;
  triggerType: string;
  status: string;
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

export type AiUsageSummary = {
  provider: string;
  modelId: string;
  model: string;
  modelName: string;
  reported: boolean;
  agentCount: number;
  usage: AiTokenUsage;
  mainUsage: AiTokenUsage;
};

export type AiTokenUsagePeriod = {
  usage: AiTokenUsage;
  turnCount: number;
  sessionCount: number;
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
  trackedFrom?: number | null;
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

export type AiAutomationSummary = {
  masterEnabled: boolean;
  agentSchemes: AiAgentScheme[];
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
  "masterEnabled" | "agentSchemes" | "profiles" | "skillVersions"
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
  section: Exclude<AiAutomationTab, "profiles">;
};

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

export type AiSession = {
  id: string;
  title: string;
  status: string;
  origin: "user" | "automation";
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
  status?: string | null;
  createdAt: number;
};

export type AiSessionSnapshot = {
  session: AiSession;
  messages: AiStoredMessage[];
};

export type AiEvent =
  | { type: "status"; sessionId: string; status: string; message: string }
  | { type: "delta"; sessionId: string; channel: "text" | "reasoning" | string; content: string }
  | { type: "toolCall"; sessionId: string; toolCallId?: string; name: string; arguments: unknown; allowed?: boolean; blocked?: boolean; policy?: string; agentId?: string | null; configuredAgentId?: string | null; parentAgentId?: string | null; startedAt?: number }
  | { type: "toolResult"; sessionId: string; toolCallId?: string; name: string; result: unknown; summary: string; ok: boolean; agentId?: string | null; configuredAgentId?: string | null; parentAgentId?: string | null; startedAt?: number; endedAt?: number; requestedAt?: number; executionStartedAt?: number; executionEndedAt?: number }
  | { type: "usage"; sessionId: string; usage: unknown }
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
