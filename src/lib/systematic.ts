import { invokeDesktop, invokeOptional, listenOptional } from "./tauri";

export type SystematicCoverage = "complete" | "partial" | "stale" | "unavailable" | string;

export type SystematicUniverseView = {
  snapshotId?: string | null;
  totalInstruments: number;
  eligibleInstruments: number;
  coveragePct: number;
  asOfMs?: number | null;
  coverage: SystematicCoverage;
  createdAt?: number | null;
};

export type SystematicFactorView = {
  id: string;
  factorId: string;
  instId: string;
  rank: number;
  /** Rank under the saved formula when previewing an edit; absent otherwise. */
  previousRank?: number;
  alphaScore: number;
  momentumPct: number;
  realizedVolatilityPct: number;
  volumeRatio: number;
  liquidityUsdt: number;
  coverage: SystematicCoverage;
  evidence: string;
  counterEvidence: string;
};

export type SystematicKlineBlendFactorDefinition = {
  /**
   * Discriminator for the persisted factor family. Definitions stored before
   * this tag existed decode as `klineBlend` on the Rust side, so it is optional
   * on read and always present on write.
   */
  kind?: "klineBlend";
  factorId: string;
  lookbackBars: number;
  momentumWeight: number;
  volatilityPenaltyWeight: number;
  volumeWeight: number;
};

/** Tagged union of every supported factor family. */
export type SystematicFactorDefinition = SystematicKlineBlendFactorDefinition;

export type SystematicFactorDefinitionView = {
  id: string;
  code: string;
  name: string;
  /** Advances only when the formula or code changes, not on rename. */
  version: number;
  status: "draft" | "research" | string;
  description: string;
  definition: SystematicFactorDefinition;
  kind: string;
  sourceHash: string;
  updatedAt: number;
};

/** Why an eligible instrument produced no score. */
export type SystematicFactorSkipSample = {
  instId: string;
  reason:
    | "noLocalBars"
    | "insufficientBars"
    | "seriesGap"
    | "invalidPrice"
    | "readFailed"
    | string;
  availableBars?: number;
  requiredBars?: number;
};

/**
 * Coverage accounting for one evaluation. Present so the panel can always
 * explain an empty or partial ranking instead of rendering a bare table.
 */
export type SystematicFactorCoverageDiagnostics = {
  universeTotal: number;
  universeEligible: number;
  scored: number;
  /** Share of eligible instruments that produced no score, 0 to 1. */
  droppedPct: number;
  reasonCounts: Record<string, number>;
  samples: SystematicFactorSkipSample[];
  snapshotId: string;
  snapshotAgeMs: number;
  snapshotStale: boolean;
  /** A cross-sectional z-score needs at least two scored instruments. */
  crossSectionSufficient: boolean;
  /**
   * Instruments holding enough history for a historical evaluation.
   *
   * Ranking needs one lookback; an evaluation walks a grid across months. These
   * are reported separately because a healthy ranking can sit beside an
   * evaluation that cannot produce a single valid grid point.
   */
  evaluationReady: number;
  evaluationRequiredBars: number;
  survivorshipNote: string;
};

export type SystematicFactorEvaluationView = {
  factorId: string;
  factorVersion: number;
  kind: string;
  asOfMs?: number | null;
  snapshotId?: string | null;
  factors: SystematicFactorView[];
  diagnostics?: SystematicFactorCoverageDiagnostics;
  /** Set when evaluation could not start, e.g. `noUniverseSnapshot`. */
  unavailableReason?: string;
};

/** Result of scoring an unsaved definition. Nothing was persisted. */
export type SystematicFactorPreviewView = {
  kind: string;
  asOfMs?: number | null;
  snapshotId?: string | null;
  factors: SystematicFactorView[];
  diagnostics?: SystematicFactorCoverageDiagnostics;
  unavailableReason?: string;
};

export type SystematicStrategyView = {
  id: string;
  name: string;
  kind: string;
  runtime: string;
  version: number;
  status: string;
  description: string;
  definition: Record<string, unknown>;
  sourceHash: string;
  updatedAt: number;
  lastRunAt?: number | null;
};

export type SystematicPythonStrategySaveResult = {
  strategy: SystematicStrategyView;
  createdVersion: boolean;
};

export type SystematicStrategyVersionSummary = {
  strategyId: string;
  version: number;
  name: string;
  description: string;
  sourceHash: string;
  createdAt: number;
  backtestCount: number;
  completedBacktestCount: number;
  profileCount: number;
  enabledProfileCount: number;
};

export type SystematicProtectionCapabilities = {
  hasStopLoss: boolean;
  hasTakeProfit: boolean;
  dynamic: boolean;
  unknown: boolean;
};

export type SystematicStrategyVersionsPageView = {
  items: SystematicStrategyVersionSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type SystematicStrategyVersionDetail = SystematicStrategyVersionSummary & {
  definition: Record<string, unknown>;
  protectionCapabilities: SystematicProtectionCapabilities;
};

export type SystematicPythonStrategyDefinition = {
  schemaVersion: "desic.systematic.strategy/v1" | string;
  protocol: "desic.systematic.python/v1" | string;
  entrypoint: "on_bar" | string;
  source: string;
  parameters: Record<string, unknown>;
  parameterTuning: Record<string, SystematicPythonParameterTuning>;
};

export type SystematicPythonParameterTuning = {
  min: number;
  max: number;
  step: number;
};

export type SystematicBacktestMetrics = {
  netReturnPct: number;
  maxDrawdownPct: number;
  annualizedSharpe?: number | null;
  closedTradeCount: number;
  winRate?: number | null;
  feesUsdt: number;
  fundingCashflowUsdt: number;
};

export type SystematicExecutionAssumptions = {
  entrySlippageBps: number;
  exitSlippageBps: number;
  entryFeeRate: number;
  exitFeeRate: number;
};

export type SystematicMarginAssumptions = {
  leverage: number;
  marginSafetyMultiplier: number;
};

export type SystematicPositionSizing = {
  mode: "fixedUsdt" | "equityPercent";
  perEntryBudget: number;
  sameSideTotalBudget: number;
};

export type SystematicClosedBar = {
  openTimeMs: number;
  closeTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type SystematicBacktestFill = {
  timeMs: number;
  instId: string;
  side: "buy" | "sell" | string;
  quantity: number;
  rawPrice: number;
  fillPrice: number;
  notionalUsdt: number;
  feeUsdt: number;
  marginDeltaUsdt: number;
  marginAfterUsdt: number;
  reason: string;
};

export type SystematicClosedTrade = {
  strategyId: string;
  instId: string;
  side: "long" | "short" | string;
  quantity: number;
  entryTimeMs: number;
  exitTimeMs: number;
  entryPrice: number;
  exitPrice: number;
  entryNotionalUsdt: number;
  exitNotionalUsdt: number;
  usedMarginUsdt: number;
  leverage: number;
  marginSafetyMultiplier: number;
  grossPnlUsdt: number;
  entryFeeUsdt: number;
  exitFeeUsdt: number;
  fundingCashflowUsdt: number;
  netPnlUsdt: number;
  exitReason: string;
};

export type SystematicEquityPoint = {
  timeMs: number;
  equityUsdt: number;
  realizedCashUsdt: number;
  unrealizedPnlUsdt: number;
};

export type SystematicOpenPositionSummary = {
  strategyId: string;
  instId: string;
  side: "long" | "short" | string;
  quantity: number;
  entryTimeMs: number;
  averageEntryPrice: number;
  markedPrice: number;
  contractValue: number;
  notionalUsdt: number;
  usedMarginUsdt: number;
  leverage: number;
  marginSafetyMultiplier: number;
  unrealizedPnlUsdt: number;
  entryFeeUsdt: number;
  fundingCashflowUsdt: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
};

export type SystematicReplaySnapshot = {
  timeMs: number;
  equityUsdt: number;
  cashUsdt: number;
  unrealizedPnlUsdt: number;
  usedMarginUsdt: number;
  availableMarginUsdt: number;
  fillCount: number;
  closedTradeCount: number;
  fundingPaymentCount: number;
  position?: SystematicOpenPositionSummary | null;
};

export type SystematicBacktestStatistics = {
  annualizedSharpe?: number | null;
  annualizedSortino?: number | null;
  annualizedVolatilityPct?: number | null;
  profitFactor?: number | null;
  expectancyUsdt?: number | null;
  averageWinUsdt?: number | null;
  averageLossUsdt?: number | null;
  payoffRatio?: number | null;
  averageHoldingMs?: number | null;
  exposurePct: number;
  largestWinUsdt?: number | null;
  largestLossUsdt?: number | null;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
};

export type SystematicStrategyActionEvent = {
  asOfMs: number;
  action: {
    kind: "no_action" | "open_long" | "open_short" | "close_long" | "close_short" | "set_protection" | "cancel_protection" | string;
    quantity?: number;
    reason?: string | null;
  };
};

export type SystematicBacktestReport = {
  // Detail responses are a replay projection: the current page remains exact
  // while the durable full report stays in the local backtest store.
  metrics: {
    initialEquityUsdt: number;
    finalEquityUsdt: number;
    netPnlUsdt: number;
    grossPnlUsdt: number;
    realizedGrossPnlUsdt: number;
    unrealizedPnlUsdt: number;
    feesUsdt: number;
    fundingCashflowUsdt: number;
    maxDrawdownUsdt: number;
    maxDrawdownPct: number;
    closedTradeCount: number;
    winRate?: number | null;
  };
  equityCurve: SystematicEquityPoint[];
  replaySnapshots?: SystematicReplaySnapshot[];
  statistics?: SystematicBacktestStatistics | null;
  fills: SystematicBacktestFill[];
  closedTrades: SystematicClosedTrade[];
  strategyActions?: SystematicStrategyActionEvent[];
  limitOrderFillModel?: string | null;
  /** Storage maintenance dropped this run's per-bar curve; metrics stay exact. */
  equitySeriesArchived?: boolean;
  reportHash: string;
};

export type SystematicBacktestView = {
  id: string;
  strategyId: string;
  strategyName: string;
  strategyVersion: number;
  status: string;
  progressPct: number;
  instId: string;
  dataSnapshotId: string;
  barCount: number;
  createdAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  error?: string | null;
  metrics?: SystematicBacktestMetrics | null;
  equityPreview: number[];
  timing?: SystematicBacktestTiming | null;
};

export type SystematicBacktestsPageView = {
  items: SystematicBacktestView[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type SystematicBacktestStartInput = {
  strategyId: string;
  strategyVersion?: number;
  instId: string;
  startAt?: number;
  endAt?: number;
  initialEquityUsdt?: number;
  preloadBars?: number;
  execution?: SystematicExecutionAssumptions;
  leverage?: number;
  marginSafetyMultiplier?: number;
  positionSizing?: SystematicPositionSizing;
  endOfRunPolicy?: "markToMarket" | "closeAtLastClose";
};

export type SystematicBacktestDetail = {
  run: SystematicBacktestView;
  request: SystematicBacktestStartInput;
  report?: SystematicBacktestReport | null;
  bars: SystematicClosedBar[];
  barOffset: number;
  totalBarCount: number;
  preloadBarCount: number;
  preloadStartAt?: number | null;
  evaluationStartAt?: number | null;
  evaluationEndAt?: number | null;
};

export type SystematicBacktestTiming = {
  unit: "microseconds";
  workerUs: number;
  pythonStartupUs: number;
  engineSetupUs: number;
  simulationLoopUs: number;
  strategyCallbackUs: number;
  strategyCallbackCount: number;
  reportBuildUs: number;
  pythonEventBuildUs: number;
  pythonRequestRoundTripUs: number;
  pythonActionDecodeUs: number;
  pythonActionResolutionUs: number;
  pythonInvocationCount: number;
  pythonBatchRequestCount: number;
  pythonBatchedEventCount: number;
  persistenceUs: number;
  workerAndPersistenceUs: number;
  engineOverheadUs: number;
};

export type SystematicBacktestDefaults = {
  startAt: number;
  endAt: number;
};

export type SystematicOptimizationView = {
  id: string;
  strategyId: string;
  instId: string;
  status: string;
  candidateCount: number;
  completedCount: number;
  strategyVersion?: number | null;
  candidateBudget?: number | null;
  samplingMode?: "grid" | "sampled" | string | null;
  workerCount?: number | null;
  trainEndAt: number;
  validationStartAt: number;
  validationEndAt: number;
  bestParameters?: Record<string, unknown> | null;
  bestValidationCalmar?: number | null;
  baselineValidationCalmar?: number | null;
  startedAt?: number | null;
  elapsedMs?: number | null;
  estimatedRemainingMs?: number | null;
  createdAt: number;
  finishedAt?: number | null;
  error?: string | null;
};

export type SystematicProfileView = {
  id: string;
  name: string;
  strategyId: string;
  strategyVersion: number;
  instId: string;
  accountId: string;
  environment: "demo" | "live" | string;
  enabled: boolean;
  status: string;
  leverage: number;
  marginMode: "cross" | "isolated" | string;
  positionSizing: SystematicPositionSizing;
  dailyLossLimitUsdt: number;
  cooldownSeconds: number;
  allowLong: boolean;
  allowShort: boolean;
  notifyOnSignal: boolean;
  takeProfitOrderType: "market" | "limit" | "postFillLimit" | string;
  stopLossOrderType: "market" | "limit" | string;
  protectionCapabilities: SystematicProtectionCapabilities;
  aiConflict: boolean;
  updatedAt: number;
  lastActionAt?: number | null;
  lastError?: string | null;
};

export type SystematicProfileSignalView = {
  id: string;
  profileId: string;
  profileName: string;
  instId: string;
  cutoffAt: number;
  actionKind: string;
  contracts?: number | null;
  reason: string;
  status: string;
  orderId?: string | null;
  clientOrderId?: string | null;
  error?: string | null;
  createdAt: number;
};

export type SystematicProfileSignalsPageView = {
  items: SystematicProfileSignalView[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  cooldownBlockedCount: number;
};

export type SystematicRegistryPackageView = {
  id: string;
  name: string;
  kind: string;
  author: string;
  version: string;
  verification: string;
  runtime: string;
  dataContract: string;
  summary: string;
  license: string;
  packageHash: string;
  sourceUrl: string;
  updatedAt: number;
  builtin: boolean;
};

export type SystematicPythonRuntimeView = {
  available: boolean;
  state: "ready" | "setupRequired" | "missingPython" | "missingVenvModule" | "invalidEnvironment" | string;
  reason: string;
  setupRequired: boolean;
  environmentExists: boolean;
  interpreterLabel?: string | null;
  sampleTestAvailable: boolean;
  sampleTestConfigured: boolean;
  sampleTestInterpreterLabel?: string | null;
};

export type SystematicPythonSampleTestView = {
  status: "passed" | "cancelled" | string;
  interpreterLabel?: string | null;
  elapsedMs?: number | null;
};

export type SystematicOverview = {
  universe: SystematicUniverseView;
  /**
   * Ranked factor rows are not part of the overview payload: scoring an aligned
   * universe is a full cross-sectional pass, and this command is polled while
   * runs are in flight. Use `evaluateSystematicFactor` or the preview command
   * to obtain ranked rows on demand.
   */
  activeFactorId?: string | null;
  factorDefinitions: SystematicFactorDefinitionView[];
  strategies: SystematicStrategyView[];
  backtests: SystematicBacktestView[];
  backtestsPage?: SystematicBacktestsPageView;
  optimizations: SystematicOptimizationView[];
  profiles: SystematicProfileView[];
  registryPackages: SystematicRegistryPackageView[];
  workerCapacity: number;
  pythonRuntime: SystematicPythonRuntimeView;
};

export type SystematicEvent = {
  type: string;
  runId?: string;
  profileId?: string;
  instId?: string;
  cutoffAt?: number;
  action?: string;
  status?: string;
  error?: string;
  inserted?: number;
  progressPct?: number;
  timing?: SystematicBacktestTiming;
  optimizationId?: string;
  completed?: number;
  total?: number;
  workerCount?: number;
  elapsedMs?: number;
  estimatedRemainingMs?: number | null;
  stage?: string;
  mirror?: string | null;
  /** Present on `factorSaved`, `factorDeleted`, and `factorDataSync`. */
  factorId?: string;
  /** Present on `factorEvaluationProgress`. */
  evaluationId?: string;
  /** `factorDataSync` progress counters. */
  repaired?: number;
  failed?: number;
  timestamp?: number;
};

export function loadSystematicOverview() {
  return invokeOptional<SystematicOverview>("systematic_overview");
}

export function loadSystematicBacktests(page = 1, pageSize = 20) {
  return invokeDesktop<SystematicBacktestsPageView>("systematic_backtests_page", {
    request: { page, pageSize }
  });
}

/**
 * Captures the aligned instrument universe. Pass `asOfMs` to decide eligibility
 * against a fixed reference time instead of the live clock, which keeps a
 * research reading reproducible.
 */
export function captureSystematicUniverse(asOfMs?: number) {
  return invokeDesktop<SystematicUniverseView>("systematic_capture_universe_snapshot", {
    request: { asOfMs }
  });
}

export function createDefaultSystematicFactor(name?: string) {
  return invokeDesktop<SystematicFactorDefinitionView>("systematic_factor_create_default", {
    request: { name }
  });
}

export function saveSystematicFactor(request: {
  id?: string;
  name: string;
  code: string;
  description?: string;
  definition: SystematicFactorDefinition;
  status?: "draft" | "research";
}) {
  return invokeDesktop<SystematicFactorDefinitionView>("systematic_factor_save", { request });
}

export function evaluateSystematicFactor(factorId: string) {
  return invokeDesktop<SystematicFactorEvaluationView>("systematic_factor_evaluate", {
    request: { factorId }
  });
}

/**
 * Scores a definition without saving it, so weight and formula edits can be
 * judged from the resulting ranking. Pass `factorId` when editing a stored
 * factor to receive `previousRank` for each row.
 */
export function previewSystematicFactor(request: {
  factorId?: string;
  definition: SystematicFactorDefinition;
}) {
  return invokeDesktop<SystematicFactorPreviewView>("systematic_factor_preview", { request });
}

/** Deletes a local factor. The seeded built-in factor is refused. */
export function deleteSystematicFactor(factorId: string) {
  return invokeDesktop<void>("systematic_factor_delete", { request: { factorId } });
}

/** Per-instrument outcome of a repair pass. */
export type SystematicFactorRepairResult = {
  instId: string;
  /** `repaired` (window complete), `incomplete` (holes remain), or `failed`. */
  status: "repaired" | "incomplete" | "failed" | string;
  inserted: number;
  error?: string;
};

export type SystematicFactorRepairView = {
  factorId: string;
  /** Instruments missing history before the limit was applied. */
  candidates: number;
  attempted: number;
  repaired: number;
  failed: number;
  inserted: number;
  cancelled: boolean;
  /** Days of 1m history fetched per instrument, so the UI can explain the wait. */
  daysPerInstrument: number;
  /** Instruments still needing history after this pass. */
  remaining: number;
  results: SystematicFactorRepairResult[];
};

/**
 * Downloads the local one-minute history a factor needs but does not have.
 *
 * Bounded to at most 50 instruments per pass (default 30), highest turnover
 * first, and cancellable via `cancelSystematicFactorRepair`. Progress arrives as
 * `factorDataSync` systematic events.
 */
export function repairSystematicFactorData(factorId: string, limit?: number) {
  return invokeDesktop<SystematicFactorRepairView>("systematic_factor_repair_data", {
    request: { factorId, limit }
  });
}

export function cancelSystematicFactorRepair(factorId: string) {
  return invokeDesktop<void>("systematic_factor_repair_cancel", { request: { factorId } });
}

/**
 * Accumulated point-in-time instrument registry.
 *
 * The exchange retains nothing about delisted perpetuals, so this local record
 * is the only way a later historical study can include instruments that were
 * tradable at the time but are not listed now. Excluding them is exactly the
 * survivorship bias that inflates measured factor performance.
 */
export type SystematicInstrumentRegistryView = {
  totalKnown: number;
  live: number;
  delisted: number;
  /** Rankable crypto perpetuals. */
  crypto: number;
  /** Equity, index and commodity underlyings — labelled, not discarded. */
  tradfi: number;
  /** Stablecoins and wrapped duplicates: listed but not rankable. */
  nonRankable: number;
  /** Recognised as neither; surfaced rather than assumed to be crypto. */
  unknown: number;
  /** Newly recorded on this pass. */
  added: number;
  /** Newly marked delisted on this pass. */
  newlyDelisted: number;
  updatedAt: number;
};

/** Records the currently listed perpetuals. Idempotent and additive. */
export function snapshotSystematicInstrumentRegistry() {
  return invokeDesktop<SystematicInstrumentRegistryView>(
    "systematic_instrument_registry_snapshot"
  );
}

/** Reads the registry without recording a new observation. */
export function loadSystematicInstrumentRegistry() {
  return invokeDesktop<SystematicInstrumentRegistryView>(
    "systematic_instrument_registry_summary"
  );
}

/** A measure a factor can start from. */
export type SystematicFactorSourceDescriptor = {
  id: string;
  labelEn: string;
  labelZh: string;
  detailEn: string;
  detailZh: string;
  takesWindow: boolean;
  defaultWindow: number;
};

/** A selectable operator, scope-prefixed so its meaning is unambiguous. */
export type SystematicFactorOperatorDescriptor = {
  id: string;
  /** Scope-prefixed name, e.g. `cs_rank`. */
  name: string;
  scope: "crossSection" | "timeSeries";
  takesWindow: boolean;
  takesDirection: boolean;
  labelEn: string;
  labelZh: string;
  detailEn: string;
  detailZh: string;
};

export type SystematicFactorPresetView = {
  id: string;
  labelEn: string;
  labelZh: string;
  /** Direction the published evidence supports. */
  expectedSign: "positive" | "negative" | "unknown" | string;
  expression: Record<string, unknown>;
};

/**
 * What the builder may offer.
 *
 * Published by the evaluator's own crate rather than duplicated here, so the
 * builder cannot offer an operator the evaluator would reject.
 */
export type SystematicFactorBuilderCatalogue = {
  sources: SystematicFactorSourceDescriptor[];
  operators: SystematicFactorOperatorDescriptor[];
  presets: SystematicFactorPresetView[];
  maxWindowBars: number;
  maxPipelineStages: number;
};

export function loadSystematicFactorBuilderCatalogue() {
  return invokeDesktop<SystematicFactorBuilderCatalogue>("systematic_factor_builder_catalogue");
}

/** One stage selection in the builder. */
export type SystematicFactorComposeStage = {
  op: string;
  window?: number;
  ascending?: boolean;
};

/**
 * Turns builder selections into a validated factor expression.
 *
 * The host owns this translation so the UI never assembles the syntax tree by
 * hand. Errors return the same wording the evaluator produces, so a problem
 * surfaces while editing rather than on save.
 */
export function composeSystematicFactorExpression(request: {
  sourceId: string;
  sourceWindow: number;
  stages: SystematicFactorComposeStage[];
}) {
  return invokeDesktop<Record<string, unknown>>("systematic_factor_compose_expression", {
    request
  });
}

/** How much attention a finding demands. */
export type SystematicVerdictLevel = "pass" | "caution" | "fail";

/**
 * One mechanically derived finding about an evaluation.
 *
 * Every check is decidable from numbers already computed, so a report can state
 * whether a factor works rather than leaving the reader to interpret raw metrics.
 * Findings arrive ordered worst-first.
 */
export type SystematicVerdictFinding = {
  code: string;
  level: SystematicVerdictLevel;
  detail: {
    measured?: number;
    threshold?: number;
    count?: number;
  };
};

/** Per-horizon evaluation metrics. */
export type SystematicFactorHorizonMetrics = {
  horizonMinutes: number;
  trainIc?: SystematicIcSummary;
  validationIc?: SystematicIcSummary;
  fullIc?: SystematicIcSummary;
  quantiles: SystematicQuantileStat[];
  quantileSpread?: number;
  monotonic: boolean;
  /** Per-period IC values, for the time-series chart. */
  icSeries: number[];
};

export type SystematicIcSummary = {
  /** The first number to check: its sign says whether the factor points as intended. */
  mean: number;
  stdDev: number;
  icir: number;
  /** Inflated at high frequency; display but do not gate decisions on it. */
  tStat: number;
  hitRate: number;
  periods: number;
};

export type SystematicQuantileStat = {
  bucket: number;
  meanReturn: number;
  stdDev: number;
  count: number;
  /** Shown with every mean so precision is never implied. */
  standardError: number;
  /** Thin membership makes a bucket mean an individual instrument's return. */
  minMembersPerPeriod: number;
};

export type SystematicFactorEvaluationMetrics = {
  horizons: SystematicFactorHorizonMetrics[];
  rankAutocorrelation?: number;
  topBucketTurnover?: number;
  gridPoints: number;
  skippedSparsePoints: number;
  universeSize: number;
  minCrossSection: number;
  /** Annualised fee-only drag at full turnover for this cadence. */
  annualisedCostAtFullTurnover: number;
  /** Always true today: funding is not ingested. */
  excludesFunding: boolean;
  boundaryNotes: string[];
};

export type SystematicFactorEvaluationRecordView = {
  id: string;
  factorId: string;
  factorVersion: number;
  status: "completed" | "cancelled" | "failed" | string;
  windowStartAt: number;
  windowEndAt: number;
  /** In-sample / out-of-sample boundary. */
  trainEndAt: number;
  gridMinutes: number;
  horizonsMinutes: number[];
  quantileBuckets: number;
  universeSnapshotId: string;
  universeSize: number;
  metrics?: SystematicFactorEvaluationMetrics;
  verdicts: SystematicVerdictFinding[];
  overallLevel: SystematicVerdictLevel;
  error?: string;
  createdAt: number;
};

/**
 * Runs an evaluation: does this factor's ranking precede returns?
 *
 * `gridMinutes` defaults to daily. Faster cadences multiply fee drag far more
 * quickly than they can raise gross return, so an intraday default would present
 * results that cannot survive their own trading costs.
 */
export function startSystematicFactorEvaluation(request: {
  factorId: string;
  gridMinutes?: number;
  windowDays?: number;
  horizonsMinutes?: number[];
  quantileBuckets?: number;
  universeLimit?: number;
}) {
  return invokeDesktop<SystematicFactorEvaluationRecordView>(
    "systematic_factor_evaluation_start",
    { request }
  );
}

export function cancelSystematicFactorEvaluation(evaluationId: string) {
  return invokeDesktop<void>("systematic_factor_evaluation_cancel", {
    request: { evaluationId }
  });
}

export function loadSystematicFactorEvaluations(factorId: string) {
  return invokeDesktop<SystematicFactorEvaluationRecordView[]>(
    "systematic_factor_evaluation_list",
    { request: { factorId } }
  );
}

export function runSystematicPythonSample(selectInterpreter = false) {
  return invokeDesktop<SystematicPythonSampleTestView>("systematic_python_run_sample", {
    request: { selectInterpreter }
  });
}

export function prepareSystematicPythonEnvironment() {
  return invokeDesktop<SystematicPythonRuntimeView>("systematic_python_prepare_environment");
}

export function createSystematicPythonStrategy(name?: string, template?: string) {
  return invokeDesktop<SystematicStrategyView>("systematic_strategy_create_python", {
    request: { name, template }
  });
}

export function saveSystematicPythonStrategy(request: {
  id?: string;
  name: string;
  description?: string;
  source: string;
  parameters?: Record<string, unknown>;
  parameterTuning?: Record<string, SystematicPythonParameterTuning>;
}) {
  return invokeDesktop<SystematicPythonStrategySaveResult>("systematic_strategy_save_python", { request });
}

export function loadSystematicStrategyVersions(strategyId: string, page = 1, pageSize = 20) {
  return invokeDesktop<SystematicStrategyVersionsPageView>("systematic_strategy_versions", {
    request: { strategyId, page, pageSize }
  });
}

export function loadSystematicStrategyVersionDetail(strategyId: string, version: number) {
  return invokeDesktop<SystematicStrategyVersionDetail>("systematic_strategy_version_detail", {
    request: { strategyId, version }
  });
}

export function deleteSystematicStrategy(strategyId: string) {
  return invokeDesktop<void>("systematic_strategy_delete", { request: { strategyId } });
}

export type SystematicStrategyAiEditorToolRequest = {
  requestId: string;
  sessionId: string;
  strategyId: string;
  toolName: "strategy.readDevelopmentDocs" | "strategy.readCurrentSource" | "strategy.testCurrentSource" | "strategy.applySource" | string;
  input: Record<string, unknown>;
};

export function sendSystematicStrategyAiMessage(request: {
  sessionId: string;
  strategyId: string;
  prompt: string;
  commentLanguage: "zh-CN" | "en-US";
}) {
  return invokeDesktop<void>("systematic_strategy_ai_send_message", { request });
}

export function respondToSystematicStrategyAiTool(request: {
  requestId: string;
  sessionId: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}) {
  return invokeDesktop<void>("systematic_strategy_ai_tool_respond", { response: request });
}

export function startSystematicBacktest(request: SystematicBacktestStartInput) {
  return invokeDesktop<SystematicBacktestView>("systematic_backtest_start", { request });
}

export function loadSystematicBacktestDefaults(instId: string) {
  return invokeDesktop<SystematicBacktestDefaults>("systematic_backtest_defaults", {
    request: { instId }
  });
}

export function loadSystematicBacktestDetail(request: {
  runId: string;
  offset?: number;
  limit?: number;
}) {
  return invokeDesktop<SystematicBacktestDetail>("systematic_backtest_detail", { request });
}

export function cancelSystematicBacktest(runId: string) {
  return invokeDesktop<SystematicBacktestView>("systematic_backtest_cancel", {
    request: { runId }
  });
}

export function deleteSystematicBacktest(runId: string) {
  return invokeDesktop<void>("systematic_backtest_delete", { request: { runId } });
}

export function startSystematicOptimization(request: {
  strategyId: string;
  strategyVersion?: number;
  instId: string;
  startAt?: number;
  endAt?: number;
  initialEquityUsdt?: number;
  preloadBars?: number;
  execution?: SystematicExecutionAssumptions;
  leverage?: number;
  marginSafetyMultiplier?: number;
  positionSizing?: SystematicPositionSizing;
  endOfRunPolicy?: "markToMarket" | "closeAtLastClose";
  candidateBudget?: 30 | 100 | 300;
}) {
  return invokeDesktop<SystematicOptimizationView>("systematic_optimization_start", { request });
}

export function cancelSystematicOptimization(optimizationId: string) {
  return invokeDesktop<SystematicOptimizationView>("systematic_optimization_cancel", {
    request: { optimizationId },
  });
}

export function saveSystematicProfile(request: {
  id?: string;
  name: string;
  strategyId: string;
  strategyVersion?: number;
  instId: string;
  accountId: string;
  environment: "demo" | "live";
  enabled: boolean;
  leverage: number;
  marginMode: "cross" | "isolated";
  positionSizing: SystematicPositionSizing;
  dailyLossLimitUsdt: number;
  cooldownSeconds?: number;
  allowLong: boolean;
  allowShort: boolean;
  notifyOnSignal?: boolean;
  takeProfitOrderType?: "market" | "limit" | "postFillLimit";
  stopLossOrderType?: "market" | "limit";
}) {
  return invokeDesktop<SystematicProfileView>("systematic_profile_save", { request });
}

export function deleteSystematicProfile(profileId: string) {
  return invokeDesktop<void>("systematic_profile_delete", { request: { profileId } });
}

export function setSystematicProfileEnabled(
  profileId: string,
  enabled: boolean,
  forceAiConflict = false,
  confirmedLive = false,
) {
  return invokeDesktop<SystematicProfileView>("systematic_profile_set_enabled", {
    request: { profileId, enabled, forceAiConflict, confirmedLive }
  });
}

export function loadSystematicProfileSignals(profileId?: string, page = 1, pageSize = 10) {
  return invokeDesktop<SystematicProfileSignalsPageView>("systematic_profile_signals", {
    request: { ...(profileId ? { profileId } : {}), page, pageSize }
  });
}

export function listenSystematicEvents(handler: (event: SystematicEvent) => void) {
  return listenOptional<SystematicEvent>("systematic:event", handler);
}
