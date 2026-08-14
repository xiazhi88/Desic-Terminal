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
  factorId: string;
  lookbackBars: number;
  momentumWeight: number;
  volatilityPenaltyWeight: number;
  volumeWeight: number;
};

export type SystematicFactorDefinitionView = {
  id: string;
  code: string;
  name: string;
  version: number;
  status: "draft" | "research" | string;
  description: string;
  definition: SystematicKlineBlendFactorDefinition;
  sourceHash: string;
  updatedAt: number;
};

export type SystematicFactorEvaluationView = {
  factorId: string;
  factors: SystematicFactorView[];
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
  factors: SystematicFactorView[];
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

export function captureSystematicUniverse() {
  return invokeDesktop<SystematicUniverseView>("systematic_capture_universe_snapshot");
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
  definition: SystematicKlineBlendFactorDefinition;
  status?: "draft" | "research";
}) {
  return invokeDesktop<SystematicFactorDefinitionView>("systematic_factor_save", { request });
}

export function evaluateSystematicFactor(factorId: string) {
  return invokeDesktop<SystematicFactorEvaluationView>("systematic_factor_evaluate", {
    request: { factorId }
  });
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
