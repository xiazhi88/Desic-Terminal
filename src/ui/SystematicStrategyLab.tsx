import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BookOpen,
  BrainCircuit,
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CirclePause,
  Code2,
  FilePlus2,
  GitCompareArrows,
  History,
  LoaderCircle,
  Play,
  RefreshCw,
  Save,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  StepForward,
  Trash2,
  Square,
  WalletCards,
  X
} from "lucide-react";
import {
  createDefaultSystematicPythonStrategy,
  deleteSystematicBacktest,
  deleteSystematicStrategy,
  deleteSystematicProfile,
  loadSystematicStrategyVersionDetail,
  loadSystematicStrategyVersions,
  loadSystematicProfileSignals,
  listenSystematicEvents,
  saveSystematicProfile,
  startSystematicOptimization,
  setSystematicProfileEnabled,
  loadSystematicBacktestDefaults,
  loadSystematicBacktestDetail,
  prepareSystematicPythonEnvironment,
  respondToSystematicStrategyAiTool,
  saveSystematicPythonStrategy,
  sendSystematicStrategyAiMessage,
  startSystematicBacktest,
  type SystematicBacktestDetail,
  type SystematicEquityPoint,
  type SystematicBacktestFill,
  type SystematicBacktestStatistics,
  type SystematicBacktestView,
  type SystematicClosedBar,
  type SystematicClosedTrade,
  type SystematicExecutionAssumptions,
  type SystematicOverview,
  type SystematicPythonRuntimeView,
  type SystematicPythonParameterTuning,
  type SystematicPythonStrategyDefinition,
  type SystematicReplaySnapshot,
  type SystematicProfileSignalsPageView,
  type SystematicProtectionCapabilities,
  type SystematicStrategyVersionDetail,
  type SystematicStrategyVersionsPageView,
  type SystematicStrategyAiEditorToolRequest,
  type SystematicStrategyView
} from "../lib/systematic";
import { listenAiEvents, stopAiMessage } from "../lib/ai";
import { listenOptional } from "../lib/tauri";
import { formatLocalizedDate, formatLocalizedNumber } from "../i18n/runtime";
import { AiMessageError, AiProcessTimeline, AiTokenUsageLine, MarkdownMessage, applyAiEvent, type AiUiMessage } from "./AiMessageProcess";
import { KlineChart } from "./KlineChart";
import { SystematicEquityChart } from "./SystematicEquityChart";
import { SystematicPythonEditor } from "./SystematicPythonEditor";
import { SystematicPythonMergeView } from "./SystematicPythonMergeView";
import { TerminalSelect } from "./TerminalSelect";
import { SymbolIcon, symbolBase } from "./SymbolIcon";
import { useMarketHotStore } from "../lib/marketHotStore";
import type { AiEvent, Candle, ChartFillMarker, MarketAssetsSummary, OkxInstrumentSummary } from "../types";
import "./SystematicStrategyLab.css";

type Notify = (notification: {
  kind: "success" | "warning" | "error" | "info";
  title: string;
  message: string;
}) => void;

type Props = Readonly<{
  overview: SystematicOverview | null;
  selectedSymbol: string;
  watchlist: string[];
  marketAssets: MarketAssetsSummary | null;
  accounts: Array<{ id: string; name: string; environment: string }>;
  desktop: boolean;
  chinese: boolean;
  refresh: () => Promise<void>;
  onNotify: Notify;
}>;

type Tab = "strategy" | "backtest" | "review" | "profiles" | "signals";

type PythonDraft = {
  id?: string;
  name: string;
  description: string;
  source: string;
  parameters: string;
  parameterTuning: string;
};

type ProfileDraft = {
  id?: string;
  name: string;
  strategyId: string;
  strategyVersion: string;
  instId: string;
  accountId: string;
  enabled: boolean;
  leverage: string;
  marginMode: "cross" | "isolated";
  positionSizingMode: "fixedUsdt" | "equityPercent";
  perEntryBudget: string;
  sameSideTotalBudget: string;
  dailyLoss: string;
  cooldown: string;
  allowLong: boolean;
  allowShort: boolean;
  notifyOnSignal: boolean;
  takeProfitOrderType: "market" | "limit" | "postFillLimit";
  stopLossOrderType: "market" | "limit";
};

type SystematicConfirmation =
  | { kind: "strategy"; item: SystematicStrategyView }
  | { kind: "backtest"; item: SystematicBacktestView };

type StrategyAiStatus = "idle" | "connecting" | "streaming" | "tooling" | "typing" | "failed";

type StrategyGuideTab = "lifecycle" | "context" | "actions" | "examples";

type ReplayFillMarkerCandidate = {
  fillIndex: number;
  marker: ChartFillMarker;
};

const EMPTY_PYTHON_DRAFT: PythonDraft = {
  name: "",
  description: "",
  source: "",
  parameters: "{}",
  parameterTuning: "{}"
};

const REPLAY_PAGE_BAR_LIMIT = 1_500;
const REPLAY_PAGE_LOAD_DELAY_MS = 80;
// Keep AI source writes visible without letting a long editor animation hold
// the AI tool bridge open indefinitely.
const AI_SOURCE_TYPEWRITER_MIN_DURATION_MS = 450;
const AI_SOURCE_TYPEWRITER_MAX_DURATION_MS = 6_000;
const AI_SOURCE_TYPEWRITER_MAX_RENDER_STEPS = 120;
const AI_SOURCE_TYPEWRITER_FALLBACK_GRACE_MS = 1_000;
const EMPTY_PROFILE_SIGNAL_PAGE: SystematicProfileSignalsPageView = {
  items: [],
  page: 1,
  pageSize: 10,
  total: 0,
  totalPages: 1,
  cooldownBlockedCount: 0,
};

export function SystematicStrategyLab({ overview, selectedSymbol, watchlist, marketAssets, accounts, desktop, chinese, refresh, onNotify }: Props) {
  const [tab, setTab] = useState<Tab>("strategy");
  const [selectedStrategyId, setSelectedStrategyId] = useState("");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [profileToOpenId, setProfileToOpenId] = useState("");
  const [draft, setDraft] = useState<PythonDraft>(EMPTY_PYTHON_DRAFT);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [startingBacktest, setStartingBacktest] = useState(false);
  const [startingOptimization, setStartingOptimization] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<SystematicConfirmation | null>(null);
  const [detail, setDetail] = useState<SystematicBacktestDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [replayIndex, setReplayIndex] = useState(0);
  const [replayAbsoluteIndex, setReplayAbsoluteIndex] = useState(0);
  const [loadingReplayPage, setLoadingReplayPage] = useState(false);
  const [initialEquity, setInitialEquity] = useState("10000");
  const [preloadBars, setPreloadBars] = useState("60");
  const [entrySlippage, setEntrySlippage] = useState("2");
  const [exitSlippage, setExitSlippage] = useState("2");
  const [entryFee, setEntryFee] = useState("0.05");
  const [exitFee, setExitFee] = useState("0.05");
  const [leverage, setLeverage] = useState("10");
  const [marginSafetyMultiplier, setMarginSafetyMultiplier] = useState("1");
  const [backtestPositionSizingMode, setBacktestPositionSizingMode] = useState<"fixedUsdt" | "equityPercent">("equityPercent");
  const [backtestPerEntryBudget, setBacktestPerEntryBudget] = useState("5");
  const [backtestSameSideTotalBudget, setBacktestSameSideTotalBudget] = useState("20");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [backtestEndLimitAt, setBacktestEndLimitAt] = useState("");
  const [backtestSymbol, setBacktestSymbol] = useState(selectedSymbol);
  const [backtestStrategyVersion, setBacktestStrategyVersion] = useState<number | null>(null);
  const [endPolicy, setEndPolicy] = useState<"markToMarket" | "closeAtLastClose">("markToMarket");
  const [runtimePreparation, setRuntimePreparation] = useState<SystematicPythonRuntimeView | null>(null);
  const [preparingPython, setPreparingPython] = useState(false);
  const pythonPreparationAttemptedRef = useRef(false);
  const backtestDefaultRangeSymbolRef = useRef<string | null>(null);
  const replayPageRequestRef = useRef(0);
  const replayPageTimerRef = useRef<number | null>(null);
  const replayRangeDraggingRef = useRef(false);

  const text = copy(chinese);
  const strategies = useMemo(
    () => (overview?.strategies ?? []).filter((strategy) => strategy.kind === "python"),
    [overview?.strategies],
  );
  const runs = overview?.backtests ?? [];
  const pythonRuntime = runtimePreparation ?? overview?.pythonRuntime;
  const selectedStrategy = useMemo(
    () => strategies.find((strategy) => strategy.id === selectedStrategyId) ?? strategies[0] ?? null,
    [selectedStrategyId, strategies]
  );
  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null,
    [runs, selectedRunId]
  );
  const selectedPython = selectedStrategy?.kind === "python" ? selectedStrategy : null;
  const bestRunsByStrategy = useMemo(() => {
    const best = new Map<string, SystematicBacktestView>();
    for (const run of runs) {
      if (run.status !== "completed" || !run.metrics) continue;
      const current = best.get(run.strategyId);
      if (!current || (current.metrics?.netReturnPct ?? Number.NEGATIVE_INFINITY) < run.metrics.netReturnPct) {
        best.set(run.strategyId, run);
      }
    }
    return best;
  }, [runs]);

  const refreshPythonEnvironment = useCallback(() => {
    pythonPreparationAttemptedRef.current = false;
    setRuntimePreparation(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!desktop || !pythonRuntime?.setupRequired || pythonPreparationAttemptedRef.current) return;
    pythonPreparationAttemptedRef.current = true;
    let active = true;
    setPreparingPython(true);
    void prepareSystematicPythonEnvironment().then(async (next) => {
      if (!active) return;
      if (next) setRuntimePreparation(next);
      if (next?.available) await refresh();
    }).catch((error) => {
      if (!active) return;
      setRuntimePreparation({
        available: false,
        state: "invalidEnvironment",
        reason: messageOf(error),
        setupRequired: false,
        environmentExists: Boolean(pythonRuntime.environmentExists),
        sampleTestAvailable: false,
        sampleTestConfigured: false,
      });
    }).finally(() => {
      if (active) setPreparingPython(false);
    });
    return () => { active = false; };
  }, [desktop, pythonRuntime?.environmentExists, pythonRuntime?.setupRequired, refresh]);

  useEffect(() => {
    if (!selectedStrategyId && strategies[0]) setSelectedStrategyId(strategies[0].id);
    if (selectedStrategyId && !strategies.some((strategy) => strategy.id === selectedStrategyId)) {
      setSelectedStrategyId(strategies[0]?.id ?? "");
    }
  }, [selectedStrategyId, strategies]);

  useEffect(() => {
    if (!selectedRunId && runs[0]) setSelectedRunId(runs[0].id);
    if (selectedRunId && !runs.some((run) => run.id === selectedRunId)) {
      setSelectedRunId(runs[0]?.id ?? "");
    }
  }, [runs, selectedRunId]);

  useEffect(() => {
    if (!selectedPython) {
      setDraft(EMPTY_PYTHON_DRAFT);
      return;
    }
    const definition = pythonDefinition(selectedPython);
    setDraft({
      id: selectedPython.id,
      name: selectedPython.name,
      description: selectedPython.description,
      source: definition?.source ?? "",
      parameters: JSON.stringify(definition?.parameters ?? {}, null, 2),
      parameterTuning: JSON.stringify(
        definition?.parameterTuning ?? defaultParameterTuning(definition?.parameters ?? {}),
        null,
        2,
      )
    });
  }, [selectedPython?.id, selectedPython?.sourceHash, selectedPython?.updatedAt]);

  useEffect(() => {
    if (!desktop || !backtestSymbol || backtestDefaultRangeSymbolRef.current === backtestSymbol) return;
    let active = true;
    void loadSystematicBacktestDefaults(backtestSymbol).then((defaults) => {
      if (!active || !defaults) return;
      backtestDefaultRangeSymbolRef.current = backtestSymbol;
      setStartAt(toDateTimeLocal(defaults.startAt));
      const safeEndAt = toDateTimeLocal(defaults.endAt);
      setEndAt(safeEndAt);
      setBacktestEndLimitAt(safeEndAt);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [backtestSymbol, desktop]);
  useEffect(() => {
    if (!watchlist.includes(backtestSymbol)) setBacktestSymbol(watchlist[0] ?? selectedSymbol);
  }, [backtestSymbol, selectedSymbol, watchlist]);

  useEffect(() => {
    replayPageRequestRef.current += 1;
    if (replayPageTimerRef.current !== null) {
      window.clearTimeout(replayPageTimerRef.current);
      replayPageTimerRef.current = null;
    }
    setLoadingReplayPage(false);
    if (!desktop || !selectedRun?.id) {
      setDetail(null);
      setReplayIndex(0);
      setReplayAbsoluteIndex(0);
      return;
    }
    let active = true;
    // A run is first readable while queued, before its report has been
    // persisted. Reload when its lifecycle reaches a terminal state so the
    // replay uses the completed report rather than that initial empty detail.
    setDetail(null);
    setReplayIndex(0);
    setReplayAbsoluteIndex(0);
    setLoadingDetail(true);
    void loadSystematicBacktestDetail({ runId: selectedRun.id }).then((next) => {
      if (!active) return;
      setDetail(next ?? null);
      const initialReplayIndex = next?.bars.length ?? 0;
      setReplayIndex(initialReplayIndex);
      setReplayAbsoluteIndex(next ? next.barOffset + initialReplayIndex : 0);
    }).catch((error) => {
      if (!active) return;
      setDetail(null);
      onNotify({ kind: "error", title: text.resultLoadFailed, message: messageOf(error) });
    }).finally(() => {
      if (active) setLoadingDetail(false);
    });
    return () => { active = false; };
  }, [desktop, onNotify, selectedRun?.finishedAt, selectedRun?.id, selectedRun?.status, text.resultLoadFailed]);

  useEffect(() => () => {
    replayPageRequestRef.current += 1;
    if (replayPageTimerRef.current !== null) {
      window.clearTimeout(replayPageTimerRef.current);
      replayPageTimerRef.current = null;
    }
  }, []);

  const chooseStrategy = useCallback((strategy: SystematicStrategyView) => {
    setSelectedStrategyId(strategy.id);
    setTab("strategy");
  }, []);

  const openBacktest = useCallback((run: SystematicBacktestView) => {
    setSelectedRunId(run.id);
    setTab("review");
  }, []);

  const applyOptimization = useCallback((parameters: Record<string, unknown>) => {
    if (!selectedPython) return;
    setDraft((current) => ({ ...current, parameters: JSON.stringify(parameters, null, 2) }));
    setTab("strategy");
    onNotify({ kind: "info", title: text.optimizationApplied, message: text.optimizationAppliedDetail });
  }, [onNotify, selectedPython, text]);

  const deleteStrategy = useCallback(async (strategy: SystematicStrategyView) => {
    if (!desktop) return;
    setDeletingId(strategy.id);
    try {
      await deleteSystematicStrategy(strategy.id);
      await refresh();
      onNotify({ kind: "success", title: text.strategyDeleted, message: strategy.name });
    } catch (error) {
      onNotify({ kind: "error", title: text.strategyDeleteFailed, message: messageOf(error) });
    } finally { setDeletingId(null); }
  }, [desktop, onNotify, refresh, text]);

  const deleteBacktest = useCallback(async (run: SystematicBacktestView) => {
    if (!desktop) return;
    setDeletingId(run.id);
    try {
      await deleteSystematicBacktest(run.id);
      await refresh();
      onNotify({ kind: "success", title: text.backtestDeleted, message: run.strategyName });
    } catch (error) {
      onNotify({ kind: "error", title: text.backtestDeleteFailed, message: messageOf(error) });
    } finally { setDeletingId(null); }
  }, [desktop, onNotify, refresh, text]);

  const confirmDelete = useCallback(() => {
    const action = confirmation;
    setConfirmation(null);
    if (!action) return;
    if (action.kind === "strategy") void deleteStrategy(action.item);
    else void deleteBacktest(action.item);
  }, [confirmation, deleteBacktest, deleteStrategy]);

  const createPython = useCallback(async () => {
    if (!desktop) {
      onNotify({ kind: "info", title: text.desktopOnly, message: text.desktopOnlyDetail });
      return;
    }
    setCreating(true);
    try {
      const created = await createDefaultSystematicPythonStrategy(nextAvailableStrategyName(strategies, text.defaultStrategyName));
      if (!created) throw new Error(text.desktopOnlyDetail);
      await refresh();
      setSelectedStrategyId(created.id);
      setTab("strategy");
      onNotify({ kind: "success", title: text.strategyCreated, message: text.strategyCreatedDetail });
    } catch (error) {
      onNotify({ kind: "error", title: text.strategyCreateFailed, message: messageOf(error) });
    } finally {
      setCreating(false);
    }
  }, [desktop, onNotify, refresh, strategies, text]);

  const savePython = useCallback(async () => {
    if (!desktop || !selectedPython) return;
    if (hasStrategyNameConflict(strategies, draft.name, selectedPython.id)) {
      onNotify({ kind: "warning", title: text.strategyNameInUse, message: text.strategyNameInUseDetail });
      return;
    }
    let parameters: Record<string, unknown>;
    let parameterTuning: Record<string, SystematicPythonParameterTuning>;
    try {
      const parsed: unknown = JSON.parse(draft.parameters || "{}");
      if (!isRecord(parsed)) throw new Error(text.parametersObject);
      parameters = parsed;
      const parsedTuning: unknown = JSON.parse(draft.parameterTuning || "{}");
      if (!isParameterTuningRecord(parsedTuning)) throw new Error(text.parameterTuningObject);
      parameterTuning = parsedTuning;
    } catch (error) {
      onNotify({ kind: "error", title: text.invalidParameters, message: messageOf(error) });
      return;
    }
    setSaving(true);
    try {
      const result = await saveSystematicPythonStrategy({
        id: selectedPython.id,
        name: draft.name,
        description: draft.description,
        source: draft.source,
        parameters,
        parameterTuning
      });
      if (!result) throw new Error(text.desktopOnlyDetail);
      await refresh();
      setSelectedStrategyId(result.strategy.id);
      onNotify({
        kind: result.createdVersion ? "success" : "info",
        title: result.createdVersion ? text.strategySaved : text.strategyUnchanged,
        message: result.createdVersion ? text.strategySavedDetail : text.strategyUnchangedDetail,
      });
    } catch (error) {
      onNotify({ kind: "error", title: text.strategySaveFailed, message: messageOf(error) });
    } finally {
      setSaving(false);
    }
  }, [desktop, draft, onNotify, refresh, selectedPython, strategies, text]);

  const startBacktest = useCallback(async () => {
    if (!desktop) {
      onNotify({ kind: "info", title: text.desktopOnly, message: text.desktopOnlyDetail });
      return;
    }
    if (!selectedStrategy) {
      onNotify({ kind: "warning", title: text.noStrategy, message: text.noStrategyDetail });
      return;
    }
    if (selectedStrategy.kind === "python" && !pythonRuntime?.available) {
      onNotify({ kind: "warning", title: text.runtimeUnavailable, message: pythonRuntime?.reason || text.runtimeUnavailableDetail });
      return;
    }
    const execution = parseExecution({ entrySlippage, exitSlippage, entryFee, exitFee });
    const equity = numberInput(initialEquity);
    const preload = integerInput(preloadBars);
    const selectedLeverage = numberInput(leverage);
    const selectedMarginSafetyMultiplier = numberInput(marginSafetyMultiplier);
    const perEntryBudget = numberInput(backtestPerEntryBudget);
    const sameSideTotalBudget = numberInput(backtestSameSideTotalBudget);
    const start = dateTimeInput(startAt);
    const end = dateTimeInput(endAt);
    const latestAllowedEnd = dateTimeInput(backtestEndLimitAt);
    if (!execution || !equity || !preload
      || !selectedLeverage || selectedLeverage < 1 || selectedLeverage > 50
      || !selectedMarginSafetyMultiplier || selectedMarginSafetyMultiplier < 1 || selectedMarginSafetyMultiplier > 20
      || !perEntryBudget || !sameSideTotalBudget || perEntryBudget > sameSideTotalBudget
      || (backtestPositionSizingMode === "equityPercent" && sameSideTotalBudget > 100)
      || (startAt && !start) || (endAt && !end) || (end !== null && latestAllowedEnd !== null && end > latestAllowedEnd)) {
      onNotify({ kind: "warning", title: text.invalidBacktest, message: end !== null && latestAllowedEnd !== null && end > latestAllowedEnd ? text.backtestEndDelay : text.invalidBacktestDetail });
      return;
    }
    setStartingBacktest(true);
    try {
      const run = await startSystematicBacktest({
        strategyId: selectedStrategy.id,
        strategyVersion: backtestStrategyVersion ?? selectedStrategy.version,
        instId: backtestSymbol,
        startAt: start ?? undefined,
        endAt: end ?? undefined,
        initialEquityUsdt: equity,
        preloadBars: preload,
        execution,
        leverage: selectedLeverage,
        marginSafetyMultiplier: selectedMarginSafetyMultiplier,
        positionSizing: { mode: backtestPositionSizingMode, perEntryBudget, sameSideTotalBudget },
        endOfRunPolicy: endPolicy
      });
      if (!run) throw new Error(text.desktopOnlyDetail);
      await refresh();
      setSelectedRunId(run.id);
      setTab("review");
      onNotify({ kind: "info", title: text.backtestQueued, message: `${backtestSymbol} · ${formatLocalizedNumber(run.barCount)} × 1m` });
    } catch (error) {
      onNotify({ kind: "error", title: text.backtestFailed, message: backtestErrorMessage(error, text) });
    } finally {
      setStartingBacktest(false);
    }
  }, [backtestEndLimitAt, backtestPositionSizingMode, backtestPerEntryBudget, backtestSameSideTotalBudget, backtestStrategyVersion, backtestSymbol, desktop, endAt, endPolicy, entryFee, entrySlippage, exitFee, exitSlippage, initialEquity, leverage, marginSafetyMultiplier, onNotify, preloadBars, pythonRuntime?.available, pythonRuntime?.reason, refresh, selectedStrategy, startAt, text]);

  const startOptimization = useCallback(async () => {
    if (!desktop || !selectedPython || !pythonRuntime?.available) { onNotify({ kind: "warning", title: text.optimizeUnavailable, message: text.pythonBacktestGuard }); return; }
    const execution = parseExecution({ entrySlippage, exitSlippage, entryFee, exitFee }); const equity = numberInput(initialEquity); const preload = integerInput(preloadBars); const selectedLeverage = numberInput(leverage); const safety = numberInput(marginSafetyMultiplier); const perEntryBudget = numberInput(backtestPerEntryBudget); const sameSideTotalBudget = numberInput(backtestSameSideTotalBudget); const start = dateTimeInput(startAt); const end = dateTimeInput(endAt); const latestAllowedEnd = dateTimeInput(backtestEndLimitAt);
    if (!execution || !equity || !preload || !selectedLeverage || !safety || !perEntryBudget || !sameSideTotalBudget || perEntryBudget > sameSideTotalBudget || (backtestPositionSizingMode === "equityPercent" && sameSideTotalBudget > 100) || (startAt && !start) || (endAt && !end) || (end !== null && latestAllowedEnd !== null && end > latestAllowedEnd)) { onNotify({ kind: "warning", title: text.invalidBacktest, message: end !== null && latestAllowedEnd !== null && end > latestAllowedEnd ? text.backtestEndDelay : text.invalidBacktestDetail }); return; }
    setStartingOptimization(true);
    try {
      const optimization = await startSystematicOptimization({ strategyId: selectedPython.id, instId: backtestSymbol, startAt: start ?? undefined, endAt: end ?? undefined, initialEquityUsdt: equity, preloadBars: preload, execution, leverage: selectedLeverage, marginSafetyMultiplier: safety, positionSizing: { mode: backtestPositionSizingMode, perEntryBudget, sameSideTotalBudget }, endOfRunPolicy: endPolicy });
      if (!optimization) throw new Error(text.desktopOnlyDetail); await refresh(); onNotify({ kind: "info", title: text.optimizationQueued, message: `${optimization.candidateCount} · ${backtestSymbol}` });
    } catch (error) { onNotify({ kind: "error", title: text.optimizationFailed, message: backtestErrorMessage(error, text) }); } finally { setStartingOptimization(false); }
  }, [backtestEndLimitAt, backtestPositionSizingMode, backtestPerEntryBudget, backtestSameSideTotalBudget, backtestSymbol, desktop, endAt, endPolicy, entryFee, entrySlippage, exitFee, exitSlippage, initialEquity, leverage, marginSafetyMultiplier, onNotify, preloadBars, pythonRuntime?.available, refresh, selectedPython, startAt, text]);

  const loadReplayPage = useCallback(async (requestedIndex: number) => {
    if (!desktop || !selectedRun?.id || !detail || detail.totalBarCount <= 0 || detail.bars.length === 0) return;
    const totalBarCount = detail.totalBarCount;
    const targetIndex = Math.min(
      totalBarCount,
      Math.max(1, Number.isFinite(requestedIndex) ? Math.round(requestedIndex) : detail.barOffset + replayIndex),
    );
    const activeStart = detail.barOffset + 1;
    const activeEnd = detail.barOffset + detail.bars.length;
    if (targetIndex >= activeStart && targetIndex <= activeEnd) {
      setReplayIndex(targetIndex - detail.barOffset);
      setReplayAbsoluteIndex(targetIndex);
      return;
    }

    const limit = Math.min(REPLAY_PAGE_BAR_LIMIT, totalBarCount);
    const maxOffset = Math.max(0, totalBarCount - limit);
    const offset = Math.min(
      maxOffset,
      Math.max(0, targetIndex - 1 - Math.floor(limit / 2)),
    );
    const requestId = replayPageRequestRef.current + 1;
    replayPageRequestRef.current = requestId;
    setLoadingReplayPage(true);
    try {
      const next = await loadSystematicBacktestDetail({
        runId: selectedRun.id,
        offset,
        limit,
      });
      if (requestId !== replayPageRequestRef.current) return;
      if (!next || next.bars.length === 0) throw new Error(text.resultUnavailableDetail);
      const localIndex = Math.min(
        next.bars.length,
        Math.max(1, targetIndex - next.barOffset),
      );
      setDetail(next);
      setReplayIndex(localIndex);
      setReplayAbsoluteIndex(next.barOffset + localIndex);
    } catch (error) {
      if (requestId !== replayPageRequestRef.current) return;
      setReplayAbsoluteIndex(detail.barOffset + replayIndex);
      onNotify({ kind: "error", title: text.resultLoadFailed, message: messageOf(error) });
    } finally {
      if (requestId === replayPageRequestRef.current) setLoadingReplayPage(false);
    }
  }, [desktop, detail, onNotify, replayIndex, selectedRun?.id, text.resultLoadFailed, text.resultUnavailableDetail]);

  const moveReplayCursor = useCallback((requestedIndex: number, immediate = false) => {
    if (!detail || detail.totalBarCount <= 0 || detail.bars.length === 0) return;
    const targetIndex = Math.min(
      detail.totalBarCount,
      Math.max(1, Number.isFinite(requestedIndex) ? Math.round(requestedIndex) : detail.barOffset + replayIndex),
    );
    setReplayAbsoluteIndex(targetIndex);
    const activeStart = detail.barOffset + 1;
    const activeEnd = detail.barOffset + detail.bars.length;
    if (targetIndex >= activeStart && targetIndex <= activeEnd) {
      if (replayPageTimerRef.current !== null) {
        window.clearTimeout(replayPageTimerRef.current);
        replayPageTimerRef.current = null;
      }
      setReplayIndex(targetIndex - detail.barOffset);
      return;
    }

    if (!immediate && replayRangeDraggingRef.current) return;
    if (replayPageTimerRef.current !== null) window.clearTimeout(replayPageTimerRef.current);
    const load = () => {
      replayPageTimerRef.current = null;
      void loadReplayPage(targetIndex);
    };
    if (immediate) load();
    else replayPageTimerRef.current = window.setTimeout(load, REPLAY_PAGE_LOAD_DELAY_MS);
  }, [detail, loadReplayPage, replayIndex]);

  const setReplayRangeDragging = useCallback((dragging: boolean) => {
    replayRangeDraggingRef.current = dragging;
    if (dragging && replayPageTimerRef.current !== null) {
      window.clearTimeout(replayPageTimerRef.current);
      replayPageTimerRef.current = null;
    }
  }, []);

  const replayBars = useMemo(() => {
    const bars = detail?.bars ?? [];
    return bars.map(toCandle);
  }, [detail?.bars]);
  const replayCursorBar = useMemo(() => {
    const bar = detail?.bars[replayIndex - 1];
    return bar ? toCandle(bar) : null;
  }, [detail?.bars, replayIndex]);
  const replayBoundaryTimeMs = detail?.bars[replayIndex - 1]?.closeTimeMs ?? 0;
  const replaySnapshotsByTime = useMemo(
    () => indexReplayPointsByTime(detail?.report?.replaySnapshots ?? []),
    [detail?.report?.replaySnapshots],
  );
  const replayEquityByTime = useMemo(
    () => indexReplayPointsByTime(detail?.report?.equityCurve ?? []),
    [detail?.report?.equityCurve],
  );
  const hasRecordedReplaySnapshots = replaySnapshotsByTime.size > 0;
  const replaySnapshot = useMemo(
    () => replaySnapshotAt(detail, replayIndex, replaySnapshotsByTime, replayEquityByTime),
    [detail, replayEquityByTime, replayIndex, replaySnapshotsByTime],
  );
  const replayFillFeePrefix = useMemo(() => {
    const fills = detail?.report?.fills ?? [];
    const prefix = new Float64Array(fills.length + 1);
    for (let index = 0; index < fills.length; index += 1) {
      prefix[index + 1] = prefix[index] + (fills[index]?.feeUsdt ?? 0);
    }
    return prefix;
  }, [detail?.report?.fills]);
  const replayFillCount = useMemo(() => {
    const fills = detail?.report?.fills ?? [];
    if (hasRecordedReplaySnapshots && replaySnapshot) {
      return Math.min(replaySnapshot.fillCount, fills.length);
    }
    return fills.filter((fill) => isVisibleAtLegacyReplayBoundary(fill, replayBoundaryTimeMs)).length;
  }, [detail?.report?.fills, hasRecordedReplaySnapshots, replayBoundaryTimeMs, replaySnapshot]);
  const replayFillCandidates = useMemo<ReplayFillMarkerCandidate[]>(() => {
    const firstBar = detail?.bars[0];
    const lastBar = detail?.bars.at(-1);
    if (!firstBar || !lastBar) return [];
    return (detail?.report?.fills ?? []).flatMap((fill, fillIndex) => {
      if (fill.timeMs < firstBar.openTimeMs || fill.timeMs > lastBar.closeTimeMs) return [];
      return [{
        fillIndex,
        marker: {
          id: `systematic-${fill.timeMs}-${fillIndex}`,
          time: Math.floor(fill.timeMs / 1_000),
          price: fill.fillPrice,
          action: replayFillAction(fill),
          side: fill.side,
          size: String(fill.quantity),
          strategyId: detail?.run.strategyId,
          operator: "strategy",
          label: fill.reason
        }
      }];
    });
  }, [detail?.bars, detail?.report?.fills, detail?.run.strategyId]);
  const replayFills = useMemo<ChartFillMarker[]>(() => {
    if (hasRecordedReplaySnapshots) {
      return replayFillCandidates
        .filter((candidate) => candidate.fillIndex < replayFillCount)
        .map((candidate) => candidate.marker);
    }
    return (detail?.report?.fills ?? [])
      .filter((fill) => isVisibleAtLegacyReplayBoundary(fill, replayBoundaryTimeMs))
      .map((fill, index) => ({
        id: `systematic-${fill.timeMs}-${index}`,
        time: Math.floor(fill.timeMs / 1_000),
        price: fill.fillPrice,
        action: replayFillAction(fill),
        side: fill.side,
        size: String(fill.quantity),
        strategyId: detail?.run.strategyId,
        operator: "strategy",
        label: fill.reason
      }));
  }, [detail?.report?.fills, detail?.run.strategyId, hasRecordedReplaySnapshots, replayBoundaryTimeMs, replayFillCandidates, replayFillCount]);
  const replayClosedTradeCount = useMemo(() => {
    const trades = detail?.report?.closedTrades ?? [];
    if (hasRecordedReplaySnapshots && replaySnapshot) {
      return Math.min(replaySnapshot.closedTradeCount, trades.length);
    }
    return trades.filter((trade) => isVisibleAtLegacyReplayBoundary(trade, replayBoundaryTimeMs, trade.exitReason)).length;
  }, [detail?.report?.closedTrades, hasRecordedReplaySnapshots, replayBoundaryTimeMs, replaySnapshot]);
  const replayFees = replayFillFeePrefix[replayFillCount] ?? 0;
  return (
    <section className="systematic-strategy-lab" aria-label={text.title}>
      <header className="systematic-strategy-lab__header">
        <div className="systematic-strategy-lab__identity">
          <span className="systematic-strategy-lab__mark"><Activity size={16} /></span>
          <div>
            <strong>{text.title}</strong>
            <span>{selectedSymbol} · {text.confirmedBars}</span>
          </div>
        </div>
        <div className="systematic-strategy-lab__statusline">
          <RuntimeState runtime={pythonRuntime} preparing={preparingPython} text={text} />
          <button className="systematic-lab__icon-button" type="button" onClick={refreshPythonEnvironment} title={text.refresh} aria-label={text.refresh}>
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      <nav className="systematic-strategy-lab__tabs" aria-label={text.workflow}>
        <TabButton active={tab === "strategy"} icon={<Code2 size={14} />} label={text.strategy} onClick={() => setTab("strategy")} />
        <TabButton active={tab === "backtest"} icon={<WalletCards size={14} />} label={text.backtest} onClick={() => setTab("backtest")} />
        <TabButton active={tab === "review"} icon={<BarChart3 size={14} />} label={text.review} count={runs.length} onClick={() => setTab("review")} />
        <TabButton active={tab === "profiles"} icon={<Bot size={14} />} label={text.profiles} count={overview?.profiles.length} onClick={() => setTab("profiles")} />
        <TabButton active={tab === "signals"} icon={<History size={14} />} label={text.profileSignals} onClick={() => setTab("signals")} />
      </nav>

      <div className="systematic-strategy-lab__body">
        {tab === "strategy" ? (
          <StrategyView
            text={text}
            strategies={strategies}
            selectedStrategy={selectedStrategy}
            selectedPython={selectedPython}
            draft={draft}
            pythonRuntime={pythonRuntime}
            preparingPython={preparingPython}
            creating={creating}
            saving={saving}
            desktop={desktop}
            chinese={chinese}
            onChoose={chooseStrategy}
            onCreate={() => void createPython()}
            onDelete={(strategy) => setConfirmation({ kind: "strategy", item: strategy })}
            deletingId={deletingId}
            onSave={() => void savePython()}
            onDraftChange={setDraft}
            onNotify={onNotify}
            onRetryPythonEnvironment={refreshPythonEnvironment}
            bestRunsByStrategy={bestRunsByStrategy}
            onOpenBacktest={openBacktest}
            onUseVersionForBacktest={(version) => {
              setBacktestStrategyVersion(version);
              setTab("backtest");
            }}
          />
        ) : null}
        {tab === "backtest" ? (
          <BacktestView
            text={text}
            strategies={strategies}
            selectedStrategy={selectedStrategy}
            strategyVersion={backtestStrategyVersion ?? selectedStrategy?.version ?? null}
            selectedSymbol={backtestSymbol}
            watchlist={watchlist}
            pythonRuntime={pythonRuntime}
            preparingPython={preparingPython}
            initialEquity={initialEquity}
            preloadBars={preloadBars}
            entrySlippage={entrySlippage}
            exitSlippage={exitSlippage}
            entryFee={entryFee}
            exitFee={exitFee}
            leverage={leverage}
            marginSafetyMultiplier={marginSafetyMultiplier}
            positionSizingMode={backtestPositionSizingMode}
            perEntryBudget={backtestPerEntryBudget}
            sameSideTotalBudget={backtestSameSideTotalBudget}
            startAt={startAt}
            endAt={endAt}
            maximumEndAt={backtestEndLimitAt}
            endPolicy={endPolicy}
            starting={startingBacktest}
            optimizing={startingOptimization}
            onChoose={(id) => { setSelectedStrategyId(id); setBacktestStrategyVersion(null); }}
            onSymbolChange={setBacktestSymbol}
            onInitialEquity={setInitialEquity}
            onPreloadBars={setPreloadBars}
            onEntrySlippage={setEntrySlippage}
            onExitSlippage={setExitSlippage}
            onEntryFee={setEntryFee}
            onExitFee={setExitFee}
            onLeverage={setLeverage}
            onMarginSafetyMultiplier={setMarginSafetyMultiplier}
            onPositionSizingMode={setBacktestPositionSizingMode}
            onPerEntryBudget={setBacktestPerEntryBudget}
            onSameSideTotalBudget={setBacktestSameSideTotalBudget}
            onStartAt={setStartAt}
            onEndAt={setEndAt}
            onEndPolicy={setEndPolicy}
            onRun={() => void startBacktest()}
            onOptimize={() => void startOptimization()}
            onRetryPythonEnvironment={refreshPythonEnvironment}
            optimizations={overview?.optimizations ?? []}
            onApplyOptimization={applyOptimization}
          />
        ) : null}
        {tab === "review" ? (
          <ReviewView
            text={text}
            runs={runs}
            selectedRun={selectedRun}
            detail={detail}
            loading={loadingDetail}
            replayIndex={replayIndex}
            replayAbsoluteIndex={replayAbsoluteIndex}
            replayPageLoading={loadingReplayPage}
            replayBars={replayBars}
            replayCursorBar={replayCursorBar}
            replayFills={replayFills}
            replayFillLedger={detail?.report?.fills ?? []}
            replayFillCount={replayFillCount}
            replaySnapshot={replaySnapshot}
            replayClosedTradeLedger={detail?.report?.closedTrades ?? []}
            replayClosedTradeCount={replayClosedTradeCount}
            replayFees={replayFees}
            onChoose={setSelectedRunId}
            onReplayIndex={moveReplayCursor}
            onReplayRangeDragging={setReplayRangeDragging}
            onDelete={(run) => setConfirmation({ kind: "backtest", item: run })}
            deletingId={deletingId}
          />
        ) : null}
        {tab === "profiles" ? (
          <ProfilesView text={text} profiles={overview?.profiles ?? []} strategies={strategies.filter((item) => item.kind === "python")} watchlist={watchlist} instruments={marketAssets?.instruments ?? []} accounts={accounts} desktop={desktop} refresh={refresh} onNotify={onNotify} requestedProfileId={profileToOpenId} onRequestedProfileHandled={() => setProfileToOpenId("")} />
        ) : null}
        {tab === "signals" ? (
          <ProfileSignalsView text={text} profiles={overview?.profiles ?? []} desktop={desktop} refresh={refresh} chinese={chinese} onOpenProfile={(profileId) => { setProfileToOpenId(profileId); setTab("profiles"); }} />
        ) : null}
      </div>
      {confirmation ? <SystematicConfirmDialog
        title={confirmation.kind === "strategy" ? text.deleteStrategy : text.deleteBacktest}
        detail={(confirmation.kind === "strategy" ? text.deleteStrategyConfirm : text.deleteBacktestConfirm)
          .replace("{name}", confirmation.kind === "strategy" ? confirmation.item.name : confirmation.item.strategyName)}
        cancelText={text.cancel}
        confirmText={text.confirmDelete}
        onCancel={() => setConfirmation(null)}
        onConfirm={confirmDelete}
      /> : null}
    </section>
  );
}

function StrategyView({
  text,
  strategies,
  selectedStrategy,
  selectedPython,
  draft,
  pythonRuntime,
  preparingPython,
  creating,
  saving,
  desktop,
  chinese,
  onChoose,
  onCreate,
  onDelete,
  deletingId,
  onSave,
  onDraftChange,
  onNotify,
  onRetryPythonEnvironment,
  bestRunsByStrategy,
  onOpenBacktest,
  onUseVersionForBacktest,
}: Readonly<{
  text: Copy;
  strategies: SystematicStrategyView[];
  selectedStrategy: SystematicStrategyView | null;
  selectedPython: SystematicStrategyView | null;
  draft: PythonDraft;
  pythonRuntime?: SystematicPythonRuntimeView | null;
  preparingPython: boolean;
  creating: boolean;
  saving: boolean;
  desktop: boolean;
  chinese: boolean;
  onChoose: (strategy: SystematicStrategyView) => void;
  onCreate: () => void;
  onDelete: (strategy: SystematicStrategyView) => void;
  deletingId: string | null;
  onSave: () => void;
  onDraftChange: (next: PythonDraft) => void;
  onNotify: Notify;
  onRetryPythonEnvironment: () => void;
  bestRunsByStrategy: ReadonlyMap<string, SystematicBacktestView>;
  onOpenBacktest: (run: SystematicBacktestView) => void;
  onUseVersionForBacktest: (version: number) => void;
}>) {
  const runtimeAvailable = Boolean(pythonRuntime?.available);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [documentationOpen, setDocumentationOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [comparison, setComparison] = useState<StrategyVersionComparison | null>(null);
  const [strategyQuery, setStrategyQuery] = useState("");
  const [aiTypingPreview, setAiTypingPreview] = useState<string | null>(null);
  const editorUserEditRef = useRef<() => void>(() => undefined);
  const documentationTriggerRef = useRef<HTMLButtonElement | null>(null);
  const documentationCloseRef = useRef<HTMLButtonElement | null>(null);
  const bindEditorUserEdit = useCallback((handler: (() => void) | null) => {
    editorUserEditRef.current = handler ?? (() => undefined);
  }, []);
  const visibleStrategies = useMemo(() => {
    const query = strategyQuery.trim().toLocaleLowerCase();
    if (!query) return strategies;
    return strategies.filter((strategy) => [strategy.name, strategy.description, strategy.kind]
      .filter(Boolean)
      .some((value) => value.toLocaleLowerCase().includes(query)));
  }, [strategies, strategyQuery]);
  const closeDocumentation = useCallback(() => {
    setDocumentationOpen(false);
    window.requestAnimationFrame(() => documentationTriggerRef.current?.focus());
  }, []);
  useEffect(() => {
    if (!documentationOpen) return;
    documentationCloseRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDocumentation();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [closeDocumentation, documentationOpen]);
  useEffect(() => {
    setComparison(null);
    setVersionsOpen(false);
    setAiTypingPreview(null);
  }, [selectedPython?.id]);
  return (
    <div className={clsx(
      "systematic-lab-strategy-view",
      aiOpen && selectedPython && "is-ai-open",
      documentationOpen && selectedPython && "is-docs-open",
      versionsOpen && selectedPython && "is-versions-open",
    )}>
      <aside className="systematic-lab-strategy-list">
        <div className="systematic-lab__pane-head systematic-lab-strategy-list__head">
          <span>{text.myStrategies}</span>
          <div>
            <span className="systematic-lab__count">{strategies.length}</span>
            <button className="systematic-lab__icon-button" type="button" onClick={onCreate} disabled={!desktop || creating} title={text.newStrategy} aria-label={text.newStrategy}>
              {creating ? <LoaderCircle size={14} className="is-spinning" /> : <FilePlus2 size={14} />}
            </button>
          </div>
        </div>
        <label className="systematic-lab-strategy-list__search">
          <Search size={13} aria-hidden="true" />
          <input
            value={strategyQuery}
            type="search"
            placeholder={text.searchStrategies}
            aria-label={text.searchStrategies}
            onChange={(event) => setStrategyQuery(event.target.value)}
          />
        </label>
        <div className="systematic-lab-strategy-list__scroll">
          {visibleStrategies.map((strategy) => {
            const bestRun = bestRunsByStrategy.get(strategy.id);
            return <div
              key={strategy.id}
              className={clsx("systematic-lab-strategy-row", selectedStrategy?.id === strategy.id && "is-selected")}
            >
              <button type="button" className="systematic-lab-strategy-row__select" onClick={() => {
                if (aiOpen && strategy.id !== selectedStrategy?.id) setAiOpen(false);
                if (documentationOpen && strategy.id !== selectedStrategy?.id) setDocumentationOpen(false);
                onChoose(strategy);
              }}>
                <span className="systematic-lab-strategy-row__kind python">
                  <Code2 size={13} />
                </span>
                <span className="systematic-lab-strategy-row__content">
                  <strong>{strategy.name}</strong>
                  <span className="systematic-lab-strategy-row__details">
                    <small className="systematic-lab-strategy-row__meta">{text.python} · v{strategy.version}</small>
                    <small className="systematic-lab-strategy-row__updated" title={formatFullDateTime(strategy.updatedAt)}>{formatFullDateTime(strategy.updatedAt)}</small>
                  </span>
                  {bestRun?.metrics ? <em className={clsx("systematic-lab-strategy-row__best", bestRun.metrics.netReturnPct >= 0 ? "positive" : "negative")}>{text.bestBacktest} {formatPercent(bestRun.metrics.netReturnPct)} · {text.backtestDays.replace("{days}", formatBacktestDays(bestRun.barCount))}</em> : null}
                </span>
              </button>
              <button className="systematic-lab__row-delete" type="button" title={text.deleteStrategy} aria-label={text.deleteStrategy} onClick={() => onDelete(strategy)} disabled={deletingId === strategy.id}>
                {deletingId === strategy.id ? <LoaderCircle size={13} className="is-spinning" /> : <Trash2 size={13} />}
              </button>
            </div>;
          })}
          {strategies.length === 0 ? <EmptyState icon={<Code2 size={18} />} title={text.noStrategies} detail={text.noStrategiesDetail} /> : null}
          {strategies.length > 0 && visibleStrategies.length === 0 ? <EmptyState icon={<Search size={18} />} title={text.noStrategyMatches} detail={text.searchStrategies} /> : null}
        </div>
      </aside>

      <main className="systematic-lab-code-surface">
        {selectedPython ? (
          <>
            <div className="systematic-lab-code-surface__head">
              <div>
                <span className="systematic-lab__eyebrow">{text.pythonStrategy}</span>
                <strong>{selectedPython.name}</strong>
              </div>
              <div className="systematic-lab__head-actions">
                {!runtimeAvailable ? <span className="systematic-lab__status is-guarded"><ShieldCheck size={12} />{text.runtimeGuarded}</span> : null}
                <button
                  className={clsx("systematic-lab__guide-button", versionsOpen && "is-active")}
                  type="button"
                  onClick={() => {
                    setVersionsOpen((open) => {
                      const next = !open;
                      if (next) { setAiOpen(false); setDocumentationOpen(false); }
                      return next;
                    });
                  }}
                  title={text.versionHistory}
                  aria-label={text.versionHistory}
                  aria-expanded={versionsOpen}
                  aria-controls="systematic-strategy-versions"
                >
                  <GitCompareArrows size={15} />
                </button>
                <button
                  className="systematic-lab__guide-button"
                  ref={documentationTriggerRef}
                  type="button"
                  onClick={() => setDocumentationOpen((open) => {
                    const next = !open;
                    if (next) { setAiOpen(false); setVersionsOpen(false); }
                    return next;
                  })}
                  title={text.developmentDocumentation}
                  aria-label={text.developmentDocumentation}
                  aria-expanded={documentationOpen}
                  aria-controls="systematic-strategy-documentation"
                >
                  <BookOpen size={15} />
                </button>
                <button
                  className="systematic-lab__ai-button"
                  type="button"
                  onClick={() => setAiOpen((open) => {
                    const next = !open;
                    if (next) { setDocumentationOpen(false); setVersionsOpen(false); }
                    return next;
                  })}
                  disabled={!desktop}
                  title={text.aiAssistant}
                  aria-label={text.aiAssistant}
                  aria-pressed={aiOpen}
                >
                  <BrainCircuit size={14} />
                  AI
                </button>
                <span className="systematic-lab__head-action-divider" aria-hidden="true" />
                <button className="systematic-lab__command-button is-primary systematic-lab__save-button" type="button" onClick={onSave} disabled={!desktop || saving || aiBusy}>
                  {saving ? <LoaderCircle size={13} className="is-spinning" /> : <Save size={13} />}
                  {text.save}
                </button>
              </div>
            </div>
            <div className="systematic-lab-code-surface__metadata">
              <label>
                <span>{text.name}</span>
                <input value={draft.name} onChange={(event) => onDraftChange({ ...draft, name: event.target.value })} />
              </label>
              <label>
                <span>{text.description}</span>
                <input value={draft.description} onChange={(event) => onDraftChange({ ...draft, description: event.target.value })} />
              </label>
            </div>
            {!runtimeAvailable ? <PythonEnvironmentNotice runtime={pythonRuntime} preparing={preparingPython} text={text} onRetry={onRetryPythonEnvironment} /> : null}
            {comparison ? (
              <StrategyVersionComparisonView
                text={text}
                comparison={comparison}
                onClose={() => setComparison(null)}
              />
            ) : <><div className="systematic-lab-code-surface__workspace-bar" aria-label={text.source}>
              <span className="systematic-lab-code-surface__file-tab">
                <Code2 size={12} />
                <strong>strategy.py</strong>
                <small>{text.python} · v{selectedPython.version}</small>
              </span>
              <span className="systematic-lab-code-surface__workspace-context"><i />{text.confirmedBars}</span>
            </div>
            <div className="systematic-lab-code-surface__editor-wrap">
              <div className="systematic-lab-code-surface__label">
                <span><Code2 size={13} /> {text.source}</span>
                <small>strategy.py</small>
              </div>
              <SystematicPythonEditor
                value={draft.source}
                typingPreview={aiTypingPreview}
                ariaLabel={text.source}
                chinese={chinese}
                onChange={(source) => onDraftChange({ ...draft, source })}
                onUserEdit={() => editorUserEditRef.current()}
                onSave={onSave}
              />
            </div></>}
          </>
        ) : (
          <EmptyState icon={<Code2 size={20} />} title={text.noStrategy} detail={text.noStrategyDetail} />
        )}
      </main>

      {documentationOpen && selectedPython ? (
        <StrategyDevelopmentGuide
          chinese={chinese}
          text={text}
          closeButtonRef={documentationCloseRef}
          onClose={closeDocumentation}
        />
      ) : aiOpen && selectedPython ? (
        <StrategyAiPanel
          key={selectedPython.id}
          text={text}
          draft={draft}
          strategy={selectedPython}
          chinese={chinese}
          desktop={desktop}
          onDraftChange={onDraftChange}
          onNotify={onNotify}
          onBusyChange={setAiBusy}
          onBindEditorUserEdit={bindEditorUserEdit}
          onSourceTypingPreviewChange={setAiTypingPreview}
          onClose={() => {
            setAiTypingPreview(null);
            setAiOpen(false);
          }}
        />
      ) : versionsOpen && selectedPython ? (
        <StrategyVersionHistory
          text={text}
          strategy={selectedPython}
          draft={draft}
          desktop={desktop}
          onClose={() => setVersionsOpen(false)}
          onLoadDraft={(next) => {
            setComparison(null);
            onDraftChange(next);
          }}
          onCompare={setComparison}
          onUseForBacktest={onUseVersionForBacktest}
          onNotify={onNotify}
        />
      ) : selectedPython ? (
        <aside className="systematic-lab-strategy-inspector">
          <div className="systematic-lab__pane-head"><span>{text.strategyParameters}</span></div>
          <div className="systematic-lab-strategy-inspector__params">
            <VisualParameterEditor text={text} value={draft.parameters} onChange={(parameters) => onDraftChange({ ...draft, parameters })} />
            <ParameterTuningEditor
              text={text}
              parameters={draft.parameters}
              parameterTuning={draft.parameterTuning}
              onChange={(parameterTuning) => onDraftChange({ ...draft, parameterTuning })}
            />
            {bestRunsByStrategy.get(selectedPython.id) ? <button className="systematic-lab__command-button systematic-lab-strategy-inspector__backtest-link" type="button" onClick={() => onOpenBacktest(bestRunsByStrategy.get(selectedPython.id)!)}><BarChart3 size={13} />{text.openBestBacktest}</button> : null}
          </div>
        </aside>
      ) : null}
    </div>
  );
}

type StrategyComparisonSource = {
  label: string;
  source: string;
  parameters: string;
  parameterTuning: string;
};

type StrategyVersionComparison = {
  left: StrategyComparisonSource;
  right: StrategyComparisonSource;
};

function StrategyVersionHistory({ text, strategy, draft, desktop, onClose, onLoadDraft, onCompare, onUseForBacktest, onNotify }: Readonly<{
  text: Copy;
  strategy: SystematicStrategyView;
  draft: PythonDraft;
  desktop: boolean;
  onClose: () => void;
  onLoadDraft: (draft: PythonDraft) => void;
  onCompare: (comparison: StrategyVersionComparison) => void;
  onUseForBacktest: (version: number) => void;
  onNotify: Notify;
}>) {
  const [page, setPage] = useState<SystematicStrategyVersionsPageView | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [selected, setSelected] = useState<SystematicStrategyVersionDetail | null>(null);
  const [baseline, setBaseline] = useState<SystematicStrategyVersionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const refreshPage = useCallback(async (nextPage = pageNumber) => {
    if (!desktop) return;
    setLoading(true);
    try {
      const next = await loadSystematicStrategyVersions(strategy.id, nextPage);
      if (next) setPage(next);
    } catch (error) {
      onNotify({ kind: "error", title: text.versionHistory, message: messageOf(error) });
    } finally {
      setLoading(false);
    }
  }, [desktop, onNotify, pageNumber, strategy.id, text.versionHistory]);

  useEffect(() => {
    setPage(null);
    setPageNumber(1);
    setSelected(null);
    setBaseline(null);
  }, [strategy.id]);
  useEffect(() => { void refreshPage(pageNumber); }, [pageNumber, refreshPage]);

  const inspect = async (version: number) => {
    if (!desktop) return;
    setLoadingDetail(true);
    try {
      const detail = await loadSystematicStrategyVersionDetail(strategy.id, version);
      if (detail) setSelected(detail);
    } catch (error) {
      onNotify({ kind: "error", title: text.versionHistory, message: messageOf(error) });
    } finally {
      setLoadingDetail(false);
    }
  };
  const selectedSource = selected ? versionComparisonSource(selected, text.versionLabel.replace("{version}", `v${selected.version}`)) : null;
  const baselineSource = baseline ? versionComparisonSource(baseline, text.versionLabel.replace("{version}", `v${baseline.version}`)) : null;
  const canCompareSelected = Boolean(baseline && selected && baseline.version !== selected.version);

  return <aside className="systematic-lab-strategy-versions" id="systematic-strategy-versions" aria-label={text.versionHistory}>
    <header className="systematic-lab-strategy-versions__head">
      <div>
        <span className="systematic-lab__eyebrow">PYTHON</span>
        <strong><GitCompareArrows size={14} />{text.versionHistory}</strong>
      </div>
      <button className="systematic-lab__icon-button" type="button" onClick={onClose} title={text.closeVersionHistory} aria-label={text.closeVersionHistory}><X size={14} /></button>
    </header>
    <div className="systematic-lab-strategy-versions__body">
      <div className="systematic-lab-strategy-versions__summary">
        <span>{text.versionHistoryHint}</span>
        {baseline ? <small>{text.compareBaseline.replace("{version}", `v${baseline.version}`)}</small> : null}
      </div>
      <div className="systematic-lab-strategy-versions__list">
        {page?.items.map((item) => <button
          type="button"
          key={item.version}
          className={clsx("systematic-lab-strategy-version-row", selected?.version === item.version && "is-selected", baseline?.version === item.version && "is-baseline")}
          onClick={() => void inspect(item.version)}
        >
          <span><strong>v{item.version}</strong>{item.version === strategy.version ? <em>{text.latestVersion}</em> : null}</span>
          <small>{formatFullDateTime(item.createdAt)}</small>
          <span className="systematic-lab-strategy-version-row__usage">{text.versionUsage.replace("{backtests}", String(item.completedBacktestCount)).replace("{profiles}", String(item.profileCount))}</span>
        </button>)}
        {!loading && page?.items.length === 0 ? <EmptyState icon={<History size={18} />} title={text.noVersions} detail={text.noVersionsDetail} /> : null}
        {loading ? <div className="systematic-lab-strategy-versions__loading"><LoaderCircle size={15} className="is-spinning" />{text.loading}</div> : null}
      </div>
      <footer className="systematic-lab-strategy-versions__pagination">
        <small>{page ? `${page.total} · ${page.page}/${Math.max(1, page.totalPages)}` : "--"}</small>
        <span>
          <button className="systematic-lab__icon-button" type="button" disabled={!page || pageNumber <= 1 || loading} onClick={() => setPageNumber((value) => Math.max(1, value - 1))} title={text.previousPage} aria-label={text.previousPage}><ChevronLeft size={14} /></button>
          <button className="systematic-lab__icon-button" type="button" disabled={!page || pageNumber >= page.totalPages || loading} onClick={() => setPageNumber((value) => value + 1)} title={text.nextPage} aria-label={text.nextPage}><ChevronRight size={14} /></button>
        </span>
      </footer>
      <section className="systematic-lab-strategy-versions__detail">
        {selected && selectedSource ? <>
          <div className="systematic-lab-strategy-versions__detail-head"><strong>{text.versionLabel.replace("{version}", `v${selected.version}`)}</strong>{loadingDetail ? <LoaderCircle size={13} className="is-spinning" /> : null}</div>
          <p>{selected.description || text.noDescription}</p>
          <dl>
            <div><dt>{text.versionBacktests}</dt><dd>{selected.completedBacktestCount} / {selected.backtestCount}</dd></div>
            <div><dt>{text.versionProfiles}</dt><dd>{selected.enabledProfileCount} / {selected.profileCount}</dd></div>
            <div><dt>{text.versionHash}</dt><dd title={selected.sourceHash}>{selected.sourceHash.slice(0, 12)}</dd></div>
          </dl>
          <div className="systematic-lab-strategy-versions__actions">
            <button className="systematic-lab__command-button" type="button" onClick={() => setBaseline(selected)}>{text.setCompareBaseline}</button>
            <button className="systematic-lab__command-button" type="button" disabled={!canCompareSelected || !baselineSource} onClick={() => {
              if (baselineSource && selectedSource) onCompare({ left: baselineSource, right: selectedSource });
            }}><GitCompareArrows size={13} />{text.compareVersions}</button>
            <button className="systematic-lab__command-button" type="button" onClick={() => onCompare({ left: selectedSource, right: draftComparisonSource(draft, text.currentDraft) })}><GitCompareArrows size={13} />{text.compareDraft}</button>
            <button className="systematic-lab__command-button" type="button" onClick={() => {
              onLoadDraft(pythonDraftFromVersion(selected, strategy.id));
              onNotify({ kind: "info", title: text.versionLoadedToDraft, message: text.versionLoadedToDraftDetail.replace("{version}", `v${selected.version}`) });
            }}>{text.loadVersionToDraft}</button>
            <button className="systematic-lab__command-button is-primary" type="button" onClick={() => onUseForBacktest(selected.version)}><Play size={13} />{text.backtestThisVersion}</button>
          </div>
        </> : <div className="systematic-lab-strategy-versions__empty"><History size={16} /><span>{text.selectVersion}</span></div>}
      </section>
    </div>
  </aside>;
}

function StrategyVersionComparisonView({ text, comparison, onClose }: Readonly<{
  text: Copy;
  comparison: StrategyVersionComparison;
  onClose: () => void;
}>) {
  const [section, setSection] = useState<"source" | "parameters" | "tuning">("source");
  const values = section === "source"
    ? { left: comparison.left.source, right: comparison.right.source }
    : section === "parameters"
      ? { left: comparison.left.parameters, right: comparison.right.parameters }
      : { left: comparison.left.parameterTuning, right: comparison.right.parameterTuning };
  return <div className="systematic-lab-strategy-compare">
    <header>
      <div><span className="systematic-lab__eyebrow">COMPARE</span><strong>{comparison.left.label} <GitCompareArrows size={14} /> {comparison.right.label}</strong></div>
      <button className="systematic-lab__icon-button" type="button" onClick={onClose} title={text.closeComparison} aria-label={text.closeComparison}><X size={14} /></button>
    </header>
    <nav aria-label={text.compareSections}>
      {(["source", "parameters", "tuning"] as const).map((item) => <button type="button" className={clsx(item === section && "is-active")} key={item} onClick={() => setSection(item)}>{item === "source" ? text.source : item === "parameters" ? text.parameters : text.parameterTuning}</button>)}
    </nav>
    <div className="systematic-lab-strategy-compare__labels"><span>{comparison.left.label}</span><span>{comparison.right.label}</span></div>
    <SystematicPythonMergeView left={values.left} right={values.right} leftLabel={comparison.left.label} rightLabel={comparison.right.label} />
  </div>;
}

function ParameterTuningEditor({
  text,
  parameters,
  parameterTuning,
  onChange,
}: Readonly<{
  text: Copy;
  parameters: string;
  parameterTuning: string;
  onChange: (value: string) => void;
}>) {
  const parameterValues = parseJsonRecord(parameters);
  const tuningValues = parseParameterTuning(parameterTuning);
  const numericParameters = parameterValues
    ? Object.entries(parameterValues).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
    : [];
  const fieldLabels = { min: text.tuningMin, max: text.tuningMax, step: text.tuningStep };
  const updateTuning = (name: string, field: keyof SystematicPythonParameterTuning, rawValue: string) => {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return;
    const existing = tuningValues?.[name] ?? defaultTuningForNumber(parameterValues?.[name] as number);
    const next = {
      ...(tuningValues ?? {}),
      [name]: { ...existing, [field]: value }
    };
    onChange(JSON.stringify(next, null, 2));
  };

  return (
    <section className="systematic-lab-parameter-tuning" aria-label={text.parameterTuning}>
      <div className="systematic-lab-parameter-tuning__head">
        <span>{text.parameterTuning}</span>
        <small>{text.parameterTuningHint}</small>
      </div>
      {!parameterValues ? <small className="systematic-lab-parameter-tuning__empty">{text.parameterTuningUnavailable}</small> : null}
      {parameterValues && numericParameters.length === 0 ? <small className="systematic-lab-parameter-tuning__empty">{text.noNumericParameters}</small> : null}
      {parameterValues && numericParameters.length > 0 ? (
        <div className="systematic-lab-parameter-tuning__table">
          {numericParameters.map(([name, value]) => {
            const tuning = tuningValues?.[name] ?? defaultTuningForNumber(value);
            const tuningKey = `${name}:${tuning.min}:${tuning.max}:${tuning.step}`;
            return (
              <div className="systematic-lab-parameter-tuning__row" key={name}>
                <strong title={name}>{name}</strong>
                <span>{formatLocalizedNumber(value, { maximumFractionDigits: 6 })}</span>
                {(["min", "max", "step"] as const).map((field) => (
                  <label key={`${tuningKey}:${field}`}>
                    <span>{fieldLabels[field]}</span>
                    <input
                      type="number"
                      step="any"
                      defaultValue={tuning[field]}
                      aria-label={`${name} ${fieldLabels[field]}`}
                      onBlur={(event) => updateTuning(name, field, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                    />
                  </label>
                ))}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function VisualParameterEditor({ text, value, onChange }: Readonly<{ text: Copy; value: string; onChange: (value: string) => void }>) {
  const parameters = parseJsonRecord(value);
  const entries = parameters ? Object.entries(parameters).filter(([, item]) => ["string", "number", "boolean"].includes(typeof item)) : [];
  const update = (key: string, next: unknown) => onChange(JSON.stringify({ ...(parameters ?? {}), [key]: next }, null, 2));
  return (
    <section className="systematic-lab-parameters" aria-label={text.strategyParameters}>
      <span>{text.parameters}</span>
      {!parameters ? <small className="systematic-lab-parameter-tuning__empty">{text.parameterTuningUnavailable}</small> : null}
      {parameters ? <div className="systematic-lab-visual-parameters">
        {entries.map(([key, item]) => <label key={key}>
          <span title={key}>{key}</span>
          {typeof item === "boolean" ? <input type="checkbox" checked={item} onChange={(event) => update(key, event.target.checked)} /> : (
            <input type={typeof item === "number" ? "number" : "text"} step="any" value={String(item)} onChange={(event) => update(key, typeof item === "number" ? Number(event.target.value) : event.target.value)} />
          )}
        </label>)}
        {entries.length === 0 ? <small className="systematic-lab-parameter-tuning__empty">{text.noVisualParameters}</small> : null}
      </div> : null}
    </section>
  );
}

function StrategyDevelopmentGuide({
  chinese,
  text,
  closeButtonRef,
  onClose,
}: Readonly<{
  chinese: boolean;
  text: Copy;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}>) {
  const [activeTab, setActiveTab] = useState<StrategyGuideTab>("lifecycle");
  const guide = strategyGuideCopy(chinese);
  const tabs: ReadonlyArray<{ id: StrategyGuideTab; label: string }> = [
    { id: "lifecycle", label: guide.lifecycleTab },
    { id: "context", label: guide.contextTab },
    { id: "actions", label: guide.actionsTab },
    { id: "examples", label: guide.examplesTab },
  ];

  return (
    <aside className="systematic-lab-strategy-docs" id="systematic-strategy-documentation" role="region" aria-labelledby="systematic-strategy-documentation-title">
      <header className="systematic-lab-strategy-docs__head">
        <div>
          <span className="systematic-lab__eyebrow">{text.developmentDocumentation}</span>
          <strong id="systematic-strategy-documentation-title"><BookOpen size={14} /> {text.documentationTitle}</strong>
        </div>
        <button ref={closeButtonRef} className="systematic-lab__icon-button" type="button" onClick={onClose} title={text.closeDocumentation} aria-label={text.closeDocumentation}><X size={14} /></button>
      </header>
      <div className="systematic-lab-strategy-docs__reader">
        <nav className="systematic-lab-strategy-docs__tabs" role="tablist" aria-label={text.documentationTitle}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={clsx(activeTab === tab.id && "is-active")}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <div className="systematic-lab-strategy-docs__content" role="tabpanel" aria-label={tabs.find((tab) => tab.id === activeTab)?.label}>
        {activeTab === "lifecycle" ? (
          <>
            <p className="systematic-lab-strategy-docs__intro">{guide.lifecycleIntro}</p>
            <StrategyGuideApiCard
              guide={guide}
              signature="def on_bar(ctx)"
              summary={guide.onBarSummary}
              parameters={<><code>ctx</code>{guide.onBarParameters}</>}
              returns={<><code>Decision</code>{guide.onBarReturns}</>}
              notes={guide.onBarNotes}
            />
            <StrategyGuideApiCard
              guide={guide}
              signature="def on_start(ctx)"
              summary={guide.onStartSummary}
              parameters={<><code>ctx</code>{guide.onStartParameters}</>}
              returns={<><code>ctx.no_action(...)</code>{guide.onStartReturns}</>}
              notes={guide.onStartNotes}
            />
            <StrategyGuideApiCard
              guide={guide}
              signature={guide.helperSignature}
              summary={guide.helperSummary}
              parameters={guide.helperParameters}
              returns={guide.helperReturns}
              notes={guide.helperNotes}
            />
            <div className="systematic-lab-strategy-docs__callout">
              <strong>{guide.timingTitle}</strong>
              <p>{guide.timingDetail}</p>
            </div>
          </>
        ) : null}

        {activeTab === "context" ? (
          <>
            <p className="systematic-lab-strategy-docs__intro">{guide.contextIntro}</p>
            <StrategyGuideApiCard
              guide={guide}
              signature="ctx.market.bars(instrument_id, interval, lookback=None)"
              summary={guide.marketBarsSummary}
              parameters={<><code>instrument_id</code>{guide.marketBarsInstrument}<br /><code>interval</code>{guide.marketBarsInterval}<br /><code>lookback</code>{guide.marketBarsLookback}</>}
              returns={<><code>tuple[Bar, ...]</code>{guide.marketBarsReturns}</>}
              notes={guide.marketBarsNotes}
            />
            <StrategyGuideFieldList title={guide.barFieldsTitle} fields={guide.barFields} />
            <StrategyGuideApiCard
              guide={guide}
              signature="ctx.params[key] / ctx.params.get(key, default)"
              summary={guide.paramsSummary}
              parameters={<><code>key</code>{guide.paramsKey}<br /><code>default</code>{guide.paramsDefault}</>}
              returns={guide.paramsReturns}
              notes={guide.paramsNotes}
            />
            <StrategyGuideFieldList title={guide.contextFieldsTitle} fields={guide.contextFields} />
            <StrategyGuideApiCard
              guide={guide}
              signature="ctx.portfolio.position(instrument_id, side)"
              summary={guide.positionSummary}
              parameters={<><code>instrument_id</code>{guide.positionInstrument}<br /><code>side</code>{guide.positionSide}</>}
              returns={<><code>Position | None</code>{guide.positionReturns}</>}
              notes={guide.positionNotes}
            />
            <StrategyGuideApiCard
              guide={guide}
              signature="ctx.portfolio.positions_for(instrument_id)"
              summary={guide.positionsForSummary}
              parameters={<><code>instrument_id</code>{guide.positionInstrument}</>}
              returns={<><code>tuple[Position, ...]</code>{guide.positionsForReturns}</>}
              notes={guide.positionsForNotes}
            />
            <StrategyGuideFieldList title={guide.portfolioFieldsTitle} fields={guide.portfolioFields} />
            <StrategyGuideFieldList title={guide.positionFieldsTitle} fields={guide.positionFields} />
            <StrategyGuideFieldList title={guide.ledgerFieldsTitle} fields={guide.ledgerFields} />
          </>
        ) : null}

        {activeTab === "actions" ? (
          <>
            <p className="systematic-lab-strategy-docs__intro">{guide.actionsIntro}</p>
            <StrategyGuideApiCard
              guide={guide}
              signature="ctx.no_action(reason=None)"
              summary={guide.noActionSummary}
              parameters={<><code>reason</code>{guide.noActionParameters}</>}
              returns={<><code>NoAction</code>{guide.actionReturns}</>}
              notes={guide.noActionNotes}
            />
            <StrategyGuideApiCard
              guide={guide}
              signature="ctx.open_long(reason, protection=None, execution=None, metadata=None)"
              summary={guide.openLongSummary}
              parameters={guide.openParameters}
              returns={<><code>Action</code>{guide.actionReturns}</>}
              notes={guide.openNotes}
            />
            <StrategyGuideApiCard
              guide={guide}
              signature="ctx.open_short(reason, protection=None, execution=None, metadata=None)"
              summary={guide.openShortSummary}
              parameters={guide.openParameters}
              returns={<><code>Action</code>{guide.actionReturns}</>}
              notes={guide.openNotes}
            />
            <StrategyGuideApiCard
              guide={guide}
              signature="ctx.close_long(reason, execution=None, metadata=None)"
              summary={guide.closeLongSummary}
              parameters={guide.closeParameters}
              returns={<><code>Action</code>{guide.actionReturns}</>}
              notes={guide.closeNotes}
            />
            <StrategyGuideApiCard
              guide={guide}
              signature="ctx.close_short(reason, execution=None, metadata=None)"
              summary={guide.closeShortSummary}
              parameters={guide.closeParameters}
              returns={<><code>Action</code>{guide.actionReturns}</>}
              notes={guide.closeNotes}
            />
            <StrategyGuideApiCard
              guide={guide}
              signature="ctx.set_protection(reason, stop_loss_price=..., take_profit_price=..., metadata=None)"
              summary={guide.setProtectionSummary}
              parameters={guide.setProtectionParameters}
              returns={<><code>Action</code>{guide.actionReturns}</>}
              notes={guide.setProtectionNotes}
            />
            <StrategyGuideApiCard
              guide={guide}
              signature="ctx.cancel_protection(reason, metadata=None)"
              summary={guide.cancelProtectionSummary}
              parameters={guide.cancelProtectionParameters}
              returns={<><code>Action</code>{guide.actionReturns}</>}
              notes={guide.cancelProtectionNotes}
            />
            <StrategyGuideApiCard
              guide={guide}
              signature="ctx.market_order() / ctx.limit_order(limit_price)"
              summary={guide.executionSummary}
              parameters={guide.executionParameters}
              returns={<><code>Execution</code>{guide.executionReturns}</>}
              notes={guide.executionNotes}
            />
            <StrategyGuideApiCard
              guide={guide}
              signature="ctx.cancel_order(order_id, reason, metadata=None)"
              summary={guide.cancelOrderSummary}
              parameters={guide.cancelOrderParameters}
              returns={<><code>Action</code>{guide.actionReturns}</>}
              notes={guide.cancelOrderNotes}
            />
            <div className="systematic-lab-strategy-docs__callout">
              <strong>{guide.protectionTitle}</strong>
              <p>{guide.protectionDetail}</p>
            </div>
          </>
        ) : null}

        {activeTab === "examples" ? (
          <>
            <p className="systematic-lab-strategy-docs__intro">{guide.examplesIntro}</p>
            <StrategyGuideCodeExample title={guide.exampleCrossTitle} detail={guide.exampleCrossDetail} code={guide.exampleCrossCode} />
            <StrategyGuideCodeExample title={guide.exampleMultiTimeframeTitle} detail={guide.exampleMultiTimeframeDetail} code={guide.exampleMultiTimeframeCode} />
            <StrategyGuideCodeExample title={guide.exampleProtectionTitle} detail={guide.exampleProtectionDetail} code={guide.exampleProtectionCode} />
          </>
        ) : null}
        </div>
      </div>
    </aside>
  );
}

function StrategyGuideApiCard({
  guide,
  signature,
  summary,
  parameters,
  returns,
  notes,
}: Readonly<{
  guide: ReturnType<typeof strategyGuideCopy>;
  signature: string;
  summary: string;
  parameters: ReactNode;
  returns: ReactNode;
  notes: string;
}>) {
  return (
    <section className="systematic-lab-strategy-docs__api-card">
      <code>{signature}</code>
      <p>{summary}</p>
      <dl>
        <div><dt>{guide.parametersLabel}</dt><dd>{parameters}</dd></div>
        <div><dt>{guide.returnsLabel}</dt><dd>{returns}</dd></div>
        <div><dt>{guide.notesLabel}</dt><dd>{notes}</dd></div>
      </dl>
    </section>
  );
}

function StrategyGuideFieldList({
  title,
  fields,
}: Readonly<{
  title: string;
  fields: readonly { name: string; description: string }[];
}>) {
  return (
    <section className="systematic-lab-strategy-docs__field-list">
      <strong>{title}</strong>
      <dl>
        {fields.map((field) => <div key={field.name}><dt><code>{field.name}</code></dt><dd>{field.description}</dd></div>)}
      </dl>
    </section>
  );
}

function StrategyGuideCodeExample({
  title,
  detail,
  code,
}: Readonly<{
  title: string;
  detail: string;
  code: string;
}>) {
  return (
    <section className="systematic-lab-strategy-docs__example">
      <strong>{title}</strong>
      <p>{detail}</p>
      <pre><code>{code}</code></pre>
    </section>
  );
}

function strategyGuideCopy(chinese: boolean) {
  if (chinese) {
    return {
      lifecycleTab: "生命周期",
      contextTab: "上下文与数据",
      actionsTab: "动作 API",
      examplesTab: "示例",
      parametersLabel: "入参",
      returnsLabel: "返回",
      notesLabel: "约束",
      lifecycleIntro: "策略是一个同步 Python 文件。宿主提供当前时点的不可变快照；每次回调只应返回一个动作对象，或明确地不交易。普通辅助函数可自由定义，但生命周期函数的签名必须完全一致。",
      onBarSummary: "必需的主入口。当前历史回测仅在每根 1 分钟 K 线确认收线后调用它。",
      onBarParameters: "：当前时点的 StrategyContext。",
      onBarReturns: "：直接 return ctx 的任一动作函数结果。",
      onBarNotes: "不要读取未来数据。动作会在下一根 1m K 线开盘按滑点、费用和虚拟保证金模型处理。",
      onStartSummary: "可选初始化入口。每次加载策略后只调用一次，用于初始化模块状态或检查参数。",
      onStartParameters: "：与 on_bar 相同的当前时点上下文。",
      onStartReturns: "：当前历史回测中只能初始化，不应发出交易动作。",
      onStartNotes: "不定义它也完全正常。不要把历史遍历或下单逻辑放在这里。",
      helperSignature: "def helper_name(...)",
      helperSummary: "用户自定义的普通辅助函数，例如 EMA、ATR、仓位规模或信号判断。",
      helperParameters: "由你定义；可以接收普通值、K 线序列或 ctx。",
      helperReturns: "由你定义；它不会被宿主自动调用。",
      helperNotes: "允许普通函数和模块级状态；不允许类、异步、生成器、文件、网络、子进程、动态执行或未允许的导入。也不要使用 getattr、globals、locals、vars、eval、exec 等动态 API。",
      timingTitle: "时间与成交顺序",
      timingDetail: "on_bar 在 t 时刻的 1m 收线后看到截至 t 的数据。市价动作在下一根 1m 开盘成交；限价动作在该开盘进入挂单状态，之后可能部分成交、撤销或到期。预加载历史只为首个决策提供上下文，不进入权益、回放或统计。",
      contextIntro: "所有对象都是只读的。字段使用驼峰命名，例如 bar.closeTimeMs；可按属性直接读取，如 bar.close、position.averageEntryPrice。字段名固定，不要用 getattr 等动态方式猜测字段，也不要向 ctx、bar、portfolio 或其中对象赋值。",
      marketBarsSummary: "读取当前时点可见的某个合约和周期 K 线序列。",
      marketBarsInstrument: "：通常使用 ctx.instrument_id；必须是当前策略可用的合约 ID。",
      marketBarsInterval: "：1m、3m、5m、15m、30m、1H、2H、4H、6H、12H 或 1D。",
      marketBarsLookback: "：可选正整数；省略时返回当前可见的完整缓存，传入时只取尾部 N 根。",
      marketBarsReturns: "：不可变序列，按时间升序。不存在的系列抛出 KeyError；非法 lookback 抛出 ValueError。",
      marketBarsNotes: "1m 全部已确认。高周期仅最后一根可能是 confirmed=False 的进行中 K 线；它的 OHLCV 只包含当前已知分钟，若使用确认信号请先检查 confirmed。",
      barFieldsTitle: "Bar 字段",
      barFields: [
        { name: "openTimeMs / closeTimeMs", description: "开盘/名义收盘 Unix 毫秒。未完成高周期 K 线的名义 closeTimeMs 可能晚于当前时点。" },
        { name: "open / high / low / close", description: "当前时点可见的 OHLC 数值。" },
        { name: "volume", description: "当前时点累计成交量数值。" },
        { name: "confirmed", description: "布尔值。1m 恒为 True；高周期最后一根可能为 False。" },
      ],
      paramsSummary: "读取保存策略版本时固定的 JSON 参数。",
      paramsKey: "：已有的字符串参数名。",
      paramsDefault: "：可选回退值。",
      paramsReturns: "原始 JSON 值；[] 缺失时抛 KeyError，.get 缺失时返回 default。",
      paramsNotes: "只读。源码不能新增参数、修改参数 JSON 或声明调优范围；只能使用编辑器右侧已保存的键。",
      contextFieldsTitle: "ctx 常用字段",
      contextFields: [
        { name: "as_of_ms", description: "本次回调的 Unix 毫秒时点；on_bar 时等于当前 1m K 线 closeTimeMs。" },
        { name: "snapshot_id", description: "本次不可变市场与账户快照的标识。" },
        { name: "kind", description: "start 或 bar。" },
        { name: "instrument_id / interval", description: "当前事件的合约与周期；当前 on_bar 周期为 1m。" },
        { name: "bar", description: "on_bar 中为当前已确认的 1m K 线；on_start 中为 None。" },
      ],
      positionSummary: "按合约和方向读取当前虚拟持仓。",
      positionInstrument: "：通常为 ctx.instrument_id。",
      positionSide: "：必须为 \"long\" 或 \"short\"。",
      positionReturns: "：不可变 Position；当前没有该方向仓位时为 None。",
      positionNotes: "ctx.position(instrument_id, side) 是完全相同的便捷别名。",
      positionsForSummary: "读取某合约当前所有方向的虚拟持仓。",
      positionsForReturns: "：不可变 Position 元组；无仓位时为空元组。",
      positionsForNotes: "单合约策略通常使用 position(..., \"long\") / position(..., \"short\") 更直接。",
      portfolioFieldsTitle: "ctx.portfolio 字段",
      portfolioFields: [
        { name: "cash_usdt / equity_usdt", description: "虚拟现金余额和当前账户权益。" },
        { name: "used_margin_usdt / available_margin_usdt", description: "虚拟已用/可用保证金。" },
        { name: "positions", description: "当前 Position 的不可变元组。" },
        { name: "open_orders", description: "当前未完成策略委托的不可变元组。每项有 id、action、quantity、filledQuantity、status、createdAtMs 与可选 price；只能以当前 id 调用 cancel_order。" },
        { name: "recent_fills", description: "当前时点之前的模拟成交 Fill 元组。" },
        { name: "trades", description: "当前时点之前已平仓 Trade 元组。" },
      ],
      positionFieldsTitle: "Position 字段",
      positionFields: [
        { name: "instrumentId / side / quantity", description: "合约、long/short 方向和合约张数。" },
        { name: "averageEntryPrice / markPrice", description: "平均开仓价和当前标记价。字段名固定：直接使用 position.averageEntryPrice，不要用 getattr 探测。" },
        { name: "contractValue / notionalUsdt", description: "每张面值和当前名义价值。" },
        { name: "usedMarginUsdt / leverage / marginSafetyMultiplier", description: "该仓位的保证金占用与回测假设。" },
        { name: "unrealizedPnlUsdt / entryFeeUsdt / fundingCashflowUsdt", description: "浮盈亏、入场手续费和资金费影响。" },
        { name: "stopLossPrice / takeProfitPrice", description: "当前保护价；未设置时为 None。" },
        { name: "openedAtMs / updatedAtMs", description: "开仓与最新估值的 Unix 毫秒。" },
      ],
      ledgerFieldsTitle: "Fill 与 Trade 字段",
      ledgerFields: [
        { name: "Fill", description: "id、orderId、instrumentId、action、quantity、price、notionalUsdt、filledAtMs、feeUsdt、marginDeltaUsdt、marginAfterUsdt。" },
        { name: "Trade", description: "id、instrumentId、side、quantity、entryPrice、exitPrice、entryNotionalUsdt、exitNotionalUsdt、usedMarginUsdt、leverage、openedAtMs、closedAtMs、realizedPnlUsdt、feesUsdt。" },
      ],
      actionsIntro: "所有动作函数都返回一个协议决定对象，应立刻 return。开仓由宿主按回测或 Profile 预算换算合约张数；平仓默认完整平掉同方向仓位。每次 on_bar 只能返回一个结果，不能同时开仓和平仓。",
      noActionSummary: "明确表示当前时点不交易。",
      noActionParameters: "：可选、简短的审计原因。",
      actionReturns: "：由宿主验证并记入当前回测时间线的协议对象；一般不需要在策略中读取其字段。",
      noActionNotes: "建议在暖机、条件不完整或持仓继续持有时返回它。",
      openLongSummary: "申请开多或增加当前多仓；默认市价，也可传入限价执行参数。",
      openShortSummary: "申请开空或增加当前空仓；默认市价，也可传入限价执行参数。",
      openParameters: <><code>reason</code>：必填、最多 1,000 字符的审计原因；不要传 quantity。<br /><code>protection</code>：可选 <code>{'{"stopLossPrice": ..., "takeProfitPrice": ...}'}</code>，价格必须为正的绝对价格。<br /><code>execution</code>：可选，省略为市价；传 <code>ctx.limit_order(价格)</code> 创建限价委托。<br /><code>metadata</code>：可选 JSON 可序列化诊断数据。</>,
      openNotes: "仅开仓时可附带 protection。市价在下一根开盘处理；限价会进入待成交状态。保证金不足时宿主会记录未成交，不会替策略扩大额度。",
      closeLongSummary: "完整平掉当前多仓。",
      closeShortSummary: "完整平掉当前空仓。",
      closeParameters: <><code>reason</code>：必填审计原因；平仓不接受 quantity。<br /><code>execution</code>：可选，省略为市价；传 <code>ctx.limit_order(价格)</code> 创建限价委托。<br /><code>metadata</code>：可选 JSON 可序列化诊断数据。</>,
      closeNotes: "该方向没有仓位时，输出合同会拒绝。完整平仓在完全成交后才自动撤销保护。",
      setProtectionSummary: "修改当前虚拟仓位的一侧或两侧保护价。",
      setProtectionParameters: <><code>reason</code>：必填审计原因。<br /><code>stop_loss_price</code> / <code>take_profit_price</code>：传正的绝对价格设置，传 <code>None</code> 清除该侧，不传则保持该侧不变。<br /><code>metadata</code>：可选 JSON 可序列化诊断数据。</>,
      setProtectionNotes: "必须已有虚拟仓位，且至少指定一个保护字段。修改同样在下一根 1m 开盘生效。",
      cancelProtectionSummary: "撤销当前虚拟仓位的止损和止盈两侧保护。",
      cancelProtectionParameters: <><code>reason</code>：必填审计原因。<br /><code>metadata</code>：可选 JSON 可序列化诊断数据。</>,
      cancelProtectionNotes: "必须已有虚拟仓位；没有仓位时输出合同会拒绝。",
      executionSummary: "构造开仓或平仓动作的成交方式。当前仅支持市价和限价。",
      executionParameters: <><code>market_order</code>：无入参，或直接省略 execution。<br /><code>limit_price</code>：正的绝对限价。</>,
      executionReturns: "：传给 open_* 或 close_* 的不可变执行说明。",
      executionNotes: "市价在下一根 1m 开盘模拟。限价在该时点挂出，回测只按后续 1m OHLCV 和成交量参与上限保守估计，不表示历史订单簿排队成交。限价必须传给标准动作，例如 ctx.open_long(原因, execution=ctx.limit_order(限价))。",
      cancelOrderSummary: "撤销一个当前仍未完全成交的策略普通委托。",
      cancelOrderParameters: <><code>order_id</code>：必须来自当前 <code>ctx.portfolio.open_orders</code> 的 id。<br /><code>reason</code>：必填审计原因。<br /><code>metadata</code>：可选 JSON 可序列化诊断数据。</>,
      cancelOrderNotes: "撤单动作在下一根 1m 开盘处理。不能取消任意交易所订单、手动订单或已完成订单。",
      protectionTitle: "保护价行为",
      protectionDetail: "开仓附带保护只是策略意图，不是交易所附带委托。保护价由回测宿主在成交后管理；策略先返回完整平仓信号时，完整平仓完全成交后才会自动撤销相应保护，不需要再额外调用 cancel_protection。",
      examplesIntro: "以下示例都只读取当前及过去的数据，并直接返回一个动作。请先在参数 JSON 中保存实际要使用的键，然后再通过 ctx.params 读取它们。",
      exampleCrossTitle: "示例 1：参数化均线交叉 + 入场保护",
      exampleCrossDetail: "使用当前策略已保存的 fastPeriod / slowPeriod；先暖机，再以两根已确认 1m 收盘价判断交叉。",
      exampleCrossCode: `# 均线交叉：只使用当前及过去的已确认 1m 收盘价。\ndef sma(values, period):\n    return sum(values[-period:]) / period\n\ndef on_bar(ctx):\n    fast_period = int(ctx.params.get("fastPeriod", 12))\n    slow_period = int(ctx.params.get("slowPeriod", 26))\n    lookback = slow_period + 2\n    bars = ctx.market.bars(ctx.instrument_id, "1m", lookback=lookback)\n\n    if len(bars) < lookback:\n        return ctx.no_action("warming up")\n\n    closes = [bar.close for bar in bars]\n    fast_now = sma(closes, fast_period)\n    slow_now = sma(closes, slow_period)\n    fast_prev = sma(closes[:-1], fast_period)\n    slow_prev = sma(closes[:-1], slow_period)\n\n    long_position = ctx.portfolio.position(ctx.instrument_id, "long")\n    if long_position is not None and fast_now < slow_now:\n        return ctx.close_long("bearish cross")\n\n    if long_position is None and fast_prev <= slow_prev and fast_now > slow_now:\n        return ctx.open_long(\n            "bullish cross",\n            protection={"stopLossPrice": bars[-1].close * 0.98},\n        )\n\n    return ctx.no_action("no cross")`,
      exampleMultiTimeframeTitle: "示例 2：用已确认 15m 趋势过滤 1m 入场",
      exampleMultiTimeframeDetail: "1m 事件照常每分钟到来；15m 最后一根若仍在形成，则取上一根已确认 15m K 线作为趋势依据。",
      exampleMultiTimeframeCode: `def on_bar(ctx):\n    bars_1m = ctx.market.bars(ctx.instrument_id, "1m", lookback=3)\n    bars_15m = ctx.market.bars(ctx.instrument_id, "15m", lookback=3)\n\n    if len(bars_1m) < 3 or len(bars_15m) < 2:\n        return ctx.no_action("warming up")\n\n    # 高周期末根未完成时，不把它当作确认趋势。\n    trend_bar = bars_15m[-1] if bars_15m[-1].confirmed else bars_15m[-2]\n    previous_trend_bar = bars_15m[-2]\n    trend_is_up = trend_bar.close > previous_trend_bar.close\n    momentum_is_up = bars_1m[-1].close > bars_1m[-2].high\n\n    long_position = ctx.portfolio.position(ctx.instrument_id, "long")\n    if long_position is None and trend_is_up and momentum_is_up:\n        return ctx.open_long("15m confirmed trend with 1m momentum")\n    return ctx.no_action("filter not satisfied")`,
      exampleProtectionTitle: "示例 3：移动保护价或以策略信号完整平仓",
      exampleProtectionDetail: "保护修改不会和完整平仓同时返回。若完整平仓，宿主会自动撤销该仓位的保护。",
      exampleProtectionCode: `def on_bar(ctx):\n    position = ctx.portfolio.position(ctx.instrument_id, "long")\n    if position is None:\n        return ctx.no_action("no long position")\n\n    bar = ctx.bar\n    # 策略退出信号优先：完整平仓会自动清除保护。\n    if bar.close < position.averageEntryPrice * 0.99:\n        return ctx.close_long("strategy exit")\n\n    # 价格有利运行后，将止损抬到开仓价，并保留现有止盈。\n    if bar.close >= position.averageEntryPrice * 1.01:\n        return ctx.set_protection(\n            "move stop to breakeven",\n            stop_loss_price=position.averageEntryPrice,\n        )\n\n    return ctx.no_action("hold position")`,
    };
  }
  return {
    lifecycleTab: "Lifecycle",
    contextTab: "Context & data",
    actionsTab: "Action API",
    examplesTab: "Examples",
    parametersLabel: "Arguments",
    returnsLabel: "Returns",
    notesLabel: "Rules",
    lifecycleIntro: "A strategy is one synchronous Python file. The host supplies an immutable point-in-time snapshot; each callback returns one decision object or explicitly does nothing. You may define normal helper functions, but lifecycle signatures must match exactly.",
    onBarSummary: "Required main entry point. The local historical backtest calls it only after every confirmed one-minute K-line close.",
    onBarParameters: ": the current StrategyContext.",
    onBarReturns: ": return the result of one ctx action helper directly.",
    onBarNotes: "Do not read future data. The host applies the action at the following 1m open using slippage, fees, and virtual-margin rules.",
    onStartSummary: "Optional initialization entry point. It runs once after a strategy loads, for module-state initialization or parameter checks.",
    onStartParameters: ": the same point-in-time context as on_bar.",
    onStartReturns: ": the current historical adapter allows initialization only, not a trade action.",
    onStartNotes: "Omitting it is normal. Do not put history traversal or trading logic here.",
    helperSignature: "def helper_name(...)",
    helperSummary: "A normal helper you write, such as EMA, ATR, sizing, or signal logic.",
    helperParameters: "You define them; values, bar sequences, or ctx are all valid.",
    helperReturns: "You define the return value; the host never calls it automatically.",
    helperNotes: "Normal functions and module state are allowed. Classes, async, generators, files, network access, subprocesses, dynamic evaluation, and unapproved imports are not. Do not use dynamic APIs such as getattr, globals, locals, vars, eval, or exec.",
    timingTitle: "Time and fills",
    timingDetail: "on_bar sees information through the 1m close at t. Market actions simulate at the next 1m open. Limit actions become pending there and can partially fill, cancel, or expire later. Preloaded history supplies first-decision context only; it never enters equity, replay, or statistics.",
    contextIntro: "Every object is read-only. Fields keep their protocol camelCase names, such as bar.closeTimeMs; access fields directly as attributes, for example bar.close and position.averageEntryPrice. Field names are fixed: do not probe them with getattr or another dynamic API, and do not assign to ctx, bar, portfolio, or their nested objects.",
    marketBarsSummary: "Read the K-line series visible for one instrument and timeframe at the current time.",
    marketBarsInstrument: ": normally ctx.instrument_id; an available instrument ID.",
    marketBarsInterval: ": 1m, 3m, 5m, 15m, 30m, 1H, 2H, 4H, 6H, 12H, or 1D.",
    marketBarsLookback: ": optional positive integer. Omit for the visible cache; pass it to get only the final N bars.",
    marketBarsReturns: ": immutable, time-ascending series. An unavailable series raises KeyError; an invalid lookback raises ValueError.",
    marketBarsNotes: "All 1m bars are confirmed. Only the final higher-timeframe bar can be in progress with confirmed=False; it contains only currently known minutes, so check confirmed before treating it as confirmation.",
    barFieldsTitle: "Bar fields",
    barFields: [
      { name: "openTimeMs / closeTimeMs", description: "Open and nominal close Unix milliseconds. A forming higher-timeframe bar may have a nominal close later than now." },
      { name: "open / high / low / close", description: "OHLC values visible at the current strategy time." },
      { name: "volume", description: "Accumulated volume visible at the current strategy time." },
      { name: "confirmed", description: "Boolean. Always True for 1m; the final higher-timeframe bar can be False." },
    ],
    paramsSummary: "Read the JSON parameters pinned with the saved strategy version.",
    paramsKey: ": an existing string parameter key.",
    paramsDefault: ": optional fallback value.",
    paramsReturns: "The raw JSON value. [] raises KeyError when absent; .get returns the default.",
    paramsNotes: "Read-only. Source cannot add parameters, change parameter JSON, or declare tuning ranges; use only the keys saved in the inspector.",
    contextFieldsTitle: "Common ctx fields",
    contextFields: [
      { name: "as_of_ms", description: "Unix milliseconds for this callback; for on_bar it equals the active 1m closeTimeMs." },
      { name: "snapshot_id", description: "Identifier for this immutable market and account snapshot." },
      { name: "kind", description: "start or bar." },
      { name: "instrument_id / interval", description: "Instrument and timeframe for the current event; current on_bar uses 1m." },
      { name: "bar", description: "The confirmed 1m bar in on_bar; None in on_start." },
    ],
    positionSummary: "Read the current simulated position for an instrument and side.",
    positionInstrument: ": normally ctx.instrument_id.",
    positionSide: ": must be \"long\" or \"short\".",
    positionReturns: ": an immutable Position, or None when that side is flat.",
    positionNotes: "ctx.position(instrument_id, side) is an identical convenience alias.",
    positionsForSummary: "Read all current simulated positions for one instrument.",
    positionsForReturns: ": immutable Position tuple, empty when flat.",
    positionsForNotes: "For a single-contract strategy, position(..., \"long\") / position(..., \"short\") is usually clearer.",
    portfolioFieldsTitle: "ctx.portfolio fields",
    portfolioFields: [
      { name: "cash_usdt / equity_usdt", description: "Virtual cash and current account equity." },
      { name: "used_margin_usdt / available_margin_usdt", description: "Virtual used and available margin." },
      { name: "positions", description: "Immutable tuple of current Position objects." },
      { name: "open_orders", description: "Immutable pending strategy orders. Each has id, action, quantity, filledQuantity, status, createdAtMs, and optional price; only a current id can be passed to cancel_order." },
      { name: "recent_fills", description: "Tuple of simulated Fill records up to the current time." },
      { name: "trades", description: "Tuple of closed Trade records up to the current time." },
    ],
    positionFieldsTitle: "Position fields",
    positionFields: [
      { name: "instrumentId / side / quantity", description: "Instrument, long/short side, and contract count." },
      { name: "averageEntryPrice / markPrice", description: "Average entry and current marked price. The field name is fixed: use position.averageEntryPrice directly rather than getattr." },
      { name: "contractValue / notionalUsdt", description: "Contract face value and current notional." },
      { name: "usedMarginUsdt / leverage / marginSafetyMultiplier", description: "Position margin use and pinned backtest assumptions." },
      { name: "unrealizedPnlUsdt / entryFeeUsdt / fundingCashflowUsdt", description: "Unrealized PnL, entry fee, and funding impact." },
      { name: "stopLossPrice / takeProfitPrice", description: "Current protection prices, or None when unset." },
      { name: "openedAtMs / updatedAtMs", description: "Open and latest valuation Unix milliseconds." },
    ],
    ledgerFieldsTitle: "Fill and Trade fields",
    ledgerFields: [
      { name: "Fill", description: "id, orderId, instrumentId, action, quantity, price, notionalUsdt, filledAtMs, feeUsdt, marginDeltaUsdt, marginAfterUsdt." },
      { name: "Trade", description: "id, instrumentId, side, quantity, entryPrice, exitPrice, entryNotionalUsdt, exitNotionalUsdt, usedMarginUsdt, leverage, openedAtMs, closedAtMs, realizedPnlUsdt, feesUsdt." },
    ],
    actionsIntro: "Every action helper returns a protocol decision object that you should return immediately. Opening size is derived by the host from the backtest or Profile budget; a close fully closes the current same-side position. One on_bar invocation returns one result, never an open and close together.",
    noActionSummary: "Explicitly do nothing at the current time.",
    noActionParameters: ": optional short audit reason.",
    actionReturns: ": protocol object validated and recorded by the host; strategy code normally does not inspect it.",
    noActionNotes: "Use it while warming up, when conditions are incomplete, or when maintaining a position.",
    openLongSummary: "Request a long entry or increase; market is the default and limit execution is optional.",
    openShortSummary: "Request a short entry or increase; market is the default and limit execution is optional.",
    openParameters: <><code>reason</code>: required audit reason, max 1,000 characters; do not pass quantity.<br /><code>protection</code>: optional <code>{'{"stopLossPrice": ..., "takeProfitPrice": ...}'}</code>; prices are positive absolute prices.<br /><code>execution</code>: optional; omit for market or pass <code>ctx.limit_order(price)</code> for a limit order.<br /><code>metadata</code>: optional JSON-serializable diagnostics.</>,
    openNotes: "Only opening actions can attach protection. Market fills at the next open; a limit becomes pending. If margin is insufficient, the host records an unfilled instruction; it never expands capacity for the strategy.",
    closeLongSummary: "Fully close the current long position.",
    closeShortSummary: "Fully close the current short position.",
    closeParameters: <><code>reason</code>: required audit reason; close actions do not accept quantity.<br /><code>execution</code>: optional; omit for market or pass <code>ctx.limit_order(price)</code> for a limit order.<br /><code>metadata</code>: optional JSON-serializable diagnostics.</>,
    closeNotes: "The output contract rejects a flat side. A full close clears protection only after fully filling.",
    setProtectionSummary: "Change one or both protection prices on the current virtual position.",
    setProtectionParameters: <><code>reason</code>: required audit reason.<br /><code>stop_loss_price</code> / <code>take_profit_price</code>: pass a positive absolute price to set it, <code>None</code> to clear it, or omit it to leave it unchanged.<br /><code>metadata</code>: optional JSON-serializable diagnostics.</>,
    setProtectionNotes: "Requires a virtual position and at least one specified protection field. The change also takes effect at the following 1m open.",
    cancelProtectionSummary: "Clear both stop-loss and take-profit protection from the current virtual position.",
    cancelProtectionParameters: <><code>reason</code>: required audit reason.<br /><code>metadata</code>: optional JSON-serializable diagnostics.</>,
    cancelProtectionNotes: "Requires a virtual position; the output contract rejects it while flat.",
    executionSummary: "Construct the execution mode for an opening or closing action. Only market and limit are supported.",
    executionParameters: <><code>market_order</code>: no arguments, or omit execution entirely.<br /><code>limit_price</code>: positive absolute limit price.</>,
    executionReturns: ": immutable execution data passed into open_* or close_*.",
    executionNotes: "Market simulates at the next 1m open. Limits become pending then; the backtest estimates them conservatively from later 1m OHLCV and a volume-participation cap, not an order-book queue. Pass a limit to a standard action, for example ctx.open_long(reason, execution=ctx.limit_order(limit_price)).",
    cancelOrderSummary: "Cancel one current, not-yet-complete normal strategy order.",
    cancelOrderParameters: <><code>order_id</code>: an id from current <code>ctx.portfolio.open_orders</code>.<br /><code>reason</code>: required audit reason.<br /><code>metadata</code>: optional JSON-serializable diagnostics.</>,
    cancelOrderNotes: "Cancellation applies at the next 1m open. It cannot cancel arbitrary exchange orders, manual orders, or completed orders.",
    protectionTitle: "Protection behavior",
    protectionDetail: "Protection attached to an entry is strategy intent, not an attached exchange order. The backtest host manages it after a fill. When strategy logic returns a full close first, protection clears only after that close fully fills; do not add a separate cancel_protection for that same decision.",
    examplesIntro: "Every example reads only current and past data, then returns one action. Save any real parameter key in the parameters JSON first, then read it through ctx.params.",
    exampleCrossTitle: "Example 1: parameterized moving-average cross with entry protection",
    exampleCrossDetail: "Uses saved fastPeriod / slowPeriod, warms up first, then compares two confirmed 1m closes.",
    exampleCrossCode: `# Moving-average cross: only current and past confirmed 1m closes.\ndef sma(values, period):\n    return sum(values[-period:]) / period\n\ndef on_bar(ctx):\n    fast_period = int(ctx.params.get("fastPeriod", 12))\n    slow_period = int(ctx.params.get("slowPeriod", 26))\n    lookback = slow_period + 2\n    bars = ctx.market.bars(ctx.instrument_id, "1m", lookback=lookback)\n\n    if len(bars) < lookback:\n        return ctx.no_action("warming up")\n\n    closes = [bar.close for bar in bars]\n    fast_now = sma(closes, fast_period)\n    slow_now = sma(closes, slow_period)\n    fast_prev = sma(closes[:-1], fast_period)\n    slow_prev = sma(closes[:-1], slow_period)\n\n    long_position = ctx.portfolio.position(ctx.instrument_id, "long")\n    if long_position is not None and fast_now < slow_now:\n        return ctx.close_long("bearish cross")\n\n    if long_position is None and fast_prev <= slow_prev and fast_now > slow_now:\n        return ctx.open_long(\n            "bullish cross",\n            protection={"stopLossPrice": bars[-1].close * 0.98},\n        )\n\n    return ctx.no_action("no cross")`,
    exampleMultiTimeframeTitle: "Example 2: confirmed 15m trend filters a 1m entry",
    exampleMultiTimeframeDetail: "The 1m event still arrives every minute. When the final 15m bar is forming, use the preceding confirmed 15m bar as the trend input.",
    exampleMultiTimeframeCode: `def on_bar(ctx):\n    bars_1m = ctx.market.bars(ctx.instrument_id, "1m", lookback=3)\n    bars_15m = ctx.market.bars(ctx.instrument_id, "15m", lookback=3)\n\n    if len(bars_1m) < 3 or len(bars_15m) < 2:\n        return ctx.no_action("warming up")\n\n    # Do not treat a forming higher-timeframe bar as confirmed trend.\n    trend_bar = bars_15m[-1] if bars_15m[-1].confirmed else bars_15m[-2]\n    previous_trend_bar = bars_15m[-2]\n    trend_is_up = trend_bar.close > previous_trend_bar.close\n    momentum_is_up = bars_1m[-1].close > bars_1m[-2].high\n\n    long_position = ctx.portfolio.position(ctx.instrument_id, "long")\n    if long_position is None and trend_is_up and momentum_is_up:\n        return ctx.open_long("15m confirmed trend with 1m momentum")\n    return ctx.no_action("filter not satisfied")`,
    exampleProtectionTitle: "Example 3: move protection or fully close from a strategy signal",
    exampleProtectionDetail: "A protection update and a full close are not returned together. A full close removes that position's protection automatically.",
    exampleProtectionCode: `def on_bar(ctx):\n    position = ctx.portfolio.position(ctx.instrument_id, "long")\n    if position is None:\n        return ctx.no_action("no long position")\n\n    bar = ctx.bar\n    # Exit takes precedence: a full close also clears protection.\n    if bar.close < position.averageEntryPrice * 0.99:\n        return ctx.close_long("strategy exit")\n\n    # After a favorable move, lift the stop to entry and keep an existing take profit.\n    if bar.close >= position.averageEntryPrice * 1.01:\n        return ctx.set_protection(\n            "move stop to breakeven",\n            stop_loss_price=position.averageEntryPrice,\n        )\n\n    return ctx.no_action("hold position")`,
  };
}

function StrategyAiPanel({
  text,
  draft,
  strategy,
  chinese,
  desktop,
  onDraftChange,
  onNotify,
  onBusyChange,
  onBindEditorUserEdit,
  onSourceTypingPreviewChange,
  onClose,
}: Readonly<{
  text: Copy;
  draft: PythonDraft;
  strategy: SystematicStrategyView;
  chinese: boolean;
  desktop: boolean;
  onDraftChange: (next: PythonDraft) => void;
  onNotify: Notify;
  onBusyChange: (busy: boolean) => void;
  onBindEditorUserEdit: (handler: (() => void) | null) => void;
  onSourceTypingPreviewChange: (source: string | null) => void;
  onClose: () => void;
}>) {
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<StrategyAiStatus>("idle");
  const [messages, setMessages] = useState<AiUiMessage[]>([]);
  const [clock, setClock] = useState(() => Date.now());
  const draftRef = useRef(draft);
  const previousDraftRef = useRef(draft);
  const sourceRevisionRef = useRef(0);
  const sessionIdRef = useRef("");
  const statusRef = useRef(status);
  const messagesRef = useRef(messages);
  const onDraftChangeRef = useRef(onDraftChange);
  const onNotifyRef = useRef(onNotify);
  const textRef = useRef(text);
  const typewriterFrameRef = useRef<number | null>(null);
  const typewriterFallbackRef = useRef<number | null>(null);
  const sourcePreviewRequestIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  draftRef.current = draft;
  statusRef.current = status;
  messagesRef.current = messages;
  onDraftChangeRef.current = onDraftChange;
  onNotifyRef.current = onNotify;
  textRef.current = text;
  const busy = ["connecting", "streaming", "tooling", "typing"].includes(status);

  useEffect(() => {
    const previous = previousDraftRef.current;
    if (previous.id !== draft.id) {
      sourceRevisionRef.current = 0;
    } else if (previous.source !== draft.source) {
      sourceRevisionRef.current += 1;
    }
    previousDraftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  useEffect(() => {
    const target = scrollRef.current;
    if (!target) return;
    target.scrollTop = target.scrollHeight;
  }, [messages, status]);

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [busy]);

  const replaceDraftSource = useCallback((source: string) => {
    const current = draftRef.current;
    if (!current.id || current.source === source) return;
    const next = { ...current, source };
    draftRef.current = next;
    previousDraftRef.current = next;
    sourceRevisionRef.current += 1;
    onDraftChangeRef.current(next);
  }, []);

  const clearSourceTypingPreview = useCallback(() => {
    if (typewriterFrameRef.current !== null) {
      window.cancelAnimationFrame(typewriterFrameRef.current);
      typewriterFrameRef.current = null;
    }
    if (typewriterFallbackRef.current !== null) {
      window.clearTimeout(typewriterFallbackRef.current);
      typewriterFallbackRef.current = null;
    }
    sourcePreviewRequestIdRef.current = null;
    onSourceTypingPreviewChange(null);
    if (statusRef.current === "typing") setStatus("tooling");
  }, [onSourceTypingPreviewChange]);

  const startSourceTypingPreview = useCallback((requestId: string, source: string) => {
    clearSourceTypingPreview();
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || source.length <= 48) return;
    sourcePreviewRequestIdRef.current = requestId;
    onSourceTypingPreviewChange("");
    setStatus("typing");
    const startedAt = performance.now();
    const durationMs = Math.min(
      AI_SOURCE_TYPEWRITER_MAX_DURATION_MS,
      Math.max(AI_SOURCE_TYPEWRITER_MIN_DURATION_MS, Math.ceil(source.length / 4.5)),
    );
    let lastRenderStep = -1;
    const complete = () => {
      if (sourcePreviewRequestIdRef.current !== requestId) return;
      clearSourceTypingPreview();
    };
    const write = (now: number) => {
      if (sourcePreviewRequestIdRef.current !== requestId) return;
      const progress = Math.min(1, Math.max(0, (now - startedAt) / durationMs));
      const renderStep = Math.min(AI_SOURCE_TYPEWRITER_MAX_RENDER_STEPS, Math.floor(progress * AI_SOURCE_TYPEWRITER_MAX_RENDER_STEPS));
      if (renderStep > lastRenderStep) {
        lastRenderStep = renderStep;
        const length = Math.min(source.length, Math.max(1, Math.ceil(source.length * progress)));
        onSourceTypingPreviewChange(source.slice(0, length));
      }
      if (progress >= 1) {
        complete();
        return;
      }
      typewriterFrameRef.current = window.requestAnimationFrame(write);
    };
    typewriterFallbackRef.current = window.setTimeout(complete, durationMs + AI_SOURCE_TYPEWRITER_FALLBACK_GRACE_MS);
    typewriterFrameRef.current = window.requestAnimationFrame(write);
  }, [clearSourceTypingPreview, onSourceTypingPreviewChange]);

  const applySourceWithTypewriter = useCallback((request: SystematicStrategyAiEditorToolRequest) => {
    const source = typeof request.input.source === "string" ? request.input.source : "";
    const expectedRevision = Number(request.input.expectedRevision);
    const current = draftRef.current;
    if (!source.trim()) throw new Error("AI did not provide a complete strategy source");
    if (!current.id || current.id !== request.strategyId || request.sessionId !== sessionIdRef.current) {
      throw new Error("The selected strategy changed before AI could write source");
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || sourceRevisionRef.current !== expectedRevision) {
      throw new Error("The editor source changed after AI read it; read the current source again before writing");
    }
    replaceDraftSource(source);
    startSourceTypingPreview(request.requestId, source);
    onNotifyRef.current({ kind: "success", title: textRef.current.aiSourceApplied, message: textRef.current.aiSourceAppliedDetail });
    return { strategyId: request.strategyId, revision: sourceRevisionRef.current };
  }, [replaceDraftSource, startSourceTypingPreview]);

  useEffect(() => {
    onBindEditorUserEdit(clearSourceTypingPreview);
    return () => onBindEditorUserEdit(null);
  }, [clearSourceTypingPreview, onBindEditorUserEdit]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenAiEvents((event: AiEvent) => {
      if (disposed || event.sessionId !== sessionIdRef.current) return;
      applyAiEvent(event, (next) => setStatus(next as StrategyAiStatus), setMessages);
    }).then((dispose) => {
      if (disposed) {
        dispose?.();
        return;
      }
      unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenOptional<SystematicStrategyAiEditorToolRequest>("systematic:strategy-ai-editor-tool", (request) => {
      void (async () => {
        const respond = async (ok: boolean, result?: Record<string, unknown>, error?: string) => {
          await respondToSystematicStrategyAiTool({
            requestId: request.requestId,
            sessionId: request.sessionId,
            ok,
            result,
            error,
          });
        };
        if (disposed) return;
        if (request.sessionId !== sessionIdRef.current) {
          await respond(false, undefined, "The current strategy editor AI session is no longer active");
          return;
        }
        if (draftRef.current.id !== request.strategyId) {
          await respond(false, undefined, "The current editor no longer matches this strategy AI session");
          return;
        }
        if (request.toolName === "strategy.readCurrentSource" || request.toolName === "strategy.testCurrentSource") {
          await respond(true, {
            strategyId: request.strategyId,
            revision: sourceRevisionRef.current,
            source: draftRef.current.source,
          });
          return;
        }
        if (request.toolName === "strategy.applySource") {
          try {
            const result = await applySourceWithTypewriter(request);
            await respond(true, result);
          } catch (error) {
            await respond(false, undefined, messageOf(error));
          }
          return;
        }
        await respond(false, undefined, "Unknown strategy editor tool");
      })().catch((error) => {
        onNotifyRef.current({ kind: "error", title: textRef.current.aiAssistantFailed, message: messageOf(error) });
      });
    }).then((dispose) => {
      if (disposed) {
        dispose?.();
        return;
      }
      unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applySourceWithTypewriter]);

  const stopConversation = useCallback(() => {
    // The complete source is already in the editor before the visual typing
    // preview starts. Stopping the assistant therefore only clears that
    // preview; it must never roll back a successfully applied source.
    clearSourceTypingPreview();
    const sessionId = sessionIdRef.current;
    if (sessionId) void stopAiMessage(sessionId).catch(() => undefined);
    if (statusRef.current !== "idle") setStatus("idle");
  }, [clearSourceTypingPreview]);

  useEffect(() => () => {
    clearSourceTypingPreview();
    const sessionId = sessionIdRef.current;
    if (sessionId) void stopAiMessage(sessionId).catch(() => undefined);
    onBusyChange(false);
  }, [clearSourceTypingPreview, onBusyChange]);

  const submit = useCallback(async () => {
    const content = prompt.trim();
    if (!content || busy || !desktop || !draftRef.current.id) return;
    if (!sessionIdRef.current) {
      sessionIdRef.current = `systematic-strategy-ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    const sessionId = sessionIdRef.current;
    const userMessage: AiUiMessage = { id: `u-${Date.now()}`, role: "user", text: content, tools: [], approvals: [] };
    const assistantMessage: AiUiMessage = { id: `a-${Date.now()}`, role: "assistant", text: "", reasoning: "", tools: [], approvals: [], status: textRef.current.aiChatConnecting };
    const nextMessages = [...messagesRef.current, userMessage, assistantMessage];
    messagesRef.current = nextMessages;
    setMessages(nextMessages);
    setPrompt("");
    setStatus("connecting");
    try {
      await sendSystematicStrategyAiMessage({
        sessionId,
        strategyId: strategy.id,
        prompt: content,
        commentLanguage: chinese ? "zh-CN" : "en-US",
      });
    } catch (error) {
      if (sessionIdRef.current !== sessionId) return;
      setStatus("failed");
      setMessages((items) => items.map((message) => message.id === assistantMessage.id
        ? { ...message, error: true, errorMessage: messageOf(error), status: undefined, completed: true }
        : message));
      onNotifyRef.current({ kind: "error", title: textRef.current.aiAssistantFailed, message: messageOf(error) });
    }
  }, [busy, chinese, desktop, prompt, strategy.id]);

  const close = useCallback(() => {
    stopConversation();
    onClose();
  }, [onClose, stopConversation]);

  const statusLabel = status === "typing" ? text.aiSourceWriting
    : status === "failed" ? text.aiAssistantFailed
      : busy ? text.aiChatWorking
        : text.aiChatReady;

  return (
    <aside className="systematic-lab-strategy-ai-panel" aria-label={text.aiAssistant}>
      <div className="systematic-lab-strategy-ai-panel__head">
        <div>
          <span className="systematic-lab__eyebrow">{text.aiAssistant}</span>
          <strong><Bot size={14} /> {strategy.name}</strong>
        </div>
        <button className="systematic-lab__icon-button" type="button" onClick={close} title={text.closeAiAssistant} aria-label={text.closeAiAssistant}><X size={14} /></button>
      </div>
      <div className="systematic-lab-strategy-ai-panel__messages" ref={scrollRef}>
        {messages.length === 0 ? <div className="systematic-lab-strategy-ai-panel__empty"><Bot size={18} /><p>{text.aiChatEmpty}</p></div> : null}
        {messages.map((message) => (
          <article className={clsx("systematic-lab-ai-message", message.role)} key={message.id}>
            <span className="systematic-lab-ai-message__role">{message.role === "user" ? text.you : text.ai}</span>
            {message.role === "assistant" ? <AiProcessTimeline message={message} now={clock} onApprove={() => undefined} /> : null}
            <AiMessageError message={message} />
            {message.text ? (
              <div className="systematic-lab-ai-message__text">
                {message.role === "assistant" ? <MarkdownMessage content={message.text} /> : <p>{message.text}</p>}
              </div>
            ) : null}
            {message.role === "assistant" && message.usage ? <AiTokenUsageLine usage={message.usage} /> : null}
            {message.role === "assistant" && message.status ? <small className="systematic-lab-ai-message__status" aria-live="polite">{message.status}</small> : null}
          </article>
        ))}
      </div>
      <form className={clsx("systematic-lab-strategy-ai-panel__composer", busy && "is-busy")} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <textarea
          value={prompt}
          disabled={!desktop || busy}
          maxLength={8_000}
          rows={3}
          placeholder={text.aiChatPlaceholder}
          aria-label={text.aiChatPrompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="systematic-lab-strategy-ai-panel__composer-footer">
          <small aria-live="polite">{statusLabel}</small>
          {busy ? (
            <button className="systematic-lab__icon-button" type="button" onClick={stopConversation} title={text.aiChatStop} aria-label={text.aiChatStop}>
              {status === "connecting" || status === "streaming" ? <LoaderCircle size={13} className="is-spinning" /> : <Square size={12} />}
            </button>
          ) : (
            <button className="systematic-lab__icon-button" type="submit" disabled={!desktop || !prompt.trim()} title={text.aiChatSend} aria-label={text.aiChatSend}><Send size={14} /></button>
          )}
        </div>
      </form>
    </aside>
  );
}

function BacktestView({
  text,
  strategies,
  selectedStrategy,
  strategyVersion,
  selectedSymbol,
  watchlist,
  pythonRuntime,
  preparingPython,
  initialEquity,
  preloadBars,
  entrySlippage,
  exitSlippage,
  entryFee,
  exitFee,
  leverage,
  marginSafetyMultiplier,
  positionSizingMode,
  perEntryBudget,
  sameSideTotalBudget,
  startAt,
  endAt,
  maximumEndAt,
  endPolicy,
  starting,
  optimizing,
  onChoose,
  onSymbolChange,
  onInitialEquity,
  onPreloadBars,
  onEntrySlippage,
  onExitSlippage,
  onEntryFee,
  onExitFee,
  onLeverage,
  onMarginSafetyMultiplier,
  onPositionSizingMode,
  onPerEntryBudget,
  onSameSideTotalBudget,
  onStartAt,
  onEndAt,
  onEndPolicy,
  onRun,
  onOptimize,
  onRetryPythonEnvironment,
  optimizations,
  onApplyOptimization
}: Readonly<{
  text: Copy;
  strategies: SystematicStrategyView[];
  selectedStrategy: SystematicStrategyView | null;
  strategyVersion: number | null;
  selectedSymbol: string;
  watchlist: string[];
  pythonRuntime?: SystematicPythonRuntimeView | null;
  preparingPython: boolean;
  initialEquity: string;
  preloadBars: string;
  entrySlippage: string;
  exitSlippage: string;
  entryFee: string;
  exitFee: string;
  leverage: string;
  marginSafetyMultiplier: string;
  positionSizingMode: "fixedUsdt" | "equityPercent";
  perEntryBudget: string;
  sameSideTotalBudget: string;
  startAt: string;
  endAt: string;
  maximumEndAt: string;
  endPolicy: "markToMarket" | "closeAtLastClose";
  starting: boolean;
  optimizing: boolean;
  onChoose: (id: string) => void;
  onSymbolChange: (value: string) => void;
  onInitialEquity: (value: string) => void;
  onPreloadBars: (value: string) => void;
  onEntrySlippage: (value: string) => void;
  onExitSlippage: (value: string) => void;
  onEntryFee: (value: string) => void;
  onExitFee: (value: string) => void;
  onLeverage: (value: string) => void;
  onMarginSafetyMultiplier: (value: string) => void;
  onPositionSizingMode: (value: "fixedUsdt" | "equityPercent") => void;
  onPerEntryBudget: (value: string) => void;
  onSameSideTotalBudget: (value: string) => void;
  onStartAt: (value: string) => void;
  onEndAt: (value: string) => void;
  onEndPolicy: (value: "markToMarket" | "closeAtLastClose") => void;
  onRun: () => void;
  onOptimize: () => void;
  onRetryPythonEnvironment: () => void;
  optimizations: SystematicOverview["optimizations"];
  onApplyOptimization: (parameters: Record<string, unknown>) => void;
}>) {
  const runtimeAvailable = Boolean(pythonRuntime?.available);
  const canRun = selectedStrategy?.kind === "python"
    && runtimeAvailable
    && !starting && !optimizing;
  return (
    <div className="systematic-lab-backtest-view">
      <section className="systematic-lab-backtest-config">
        <div className="systematic-lab-view-heading">
          <div>
            <span className="systematic-lab__eyebrow">{text.virtualAccount}</span>
            <h2>{text.backtest}</h2>
          </div>
        </div>
        <div className="systematic-lab-form-grid">
          <label className="systematic-lab-field wide">
            <span>{text.strategy}</span>
            <TerminalSelect
              ariaLabel={text.strategy}
              value={selectedStrategy?.id ?? ""}
              options={strategies.map((strategy) => ({ value: strategy.id, label: `${strategy.name} · ${text.python}` }))}
              onChange={onChoose}
            />
          </label>
          {strategyVersion ? <div className="systematic-lab-selected-version"><span>{text.strategyVersion}</span><strong>v{strategyVersion}</strong>{strategyVersion !== selectedStrategy?.version ? <small>{text.historicalVersion}</small> : null}</div> : null}
          <label className="systematic-lab-field">
            <span>{text.contract}</span>
            <TerminalSelect
              ariaLabel={text.contract}
              value={selectedSymbol}
              options={watchlist.map((symbol) => ({ value: symbol, label: symbol }))}
              onChange={onSymbolChange}
            />
          </label>
          <NumericField label={text.initialEquity} value={initialEquity} onChange={onInitialEquity} suffix="USDT" />
          <NumericField label={text.leverage} value={leverage} onChange={onLeverage} suffix="x" />
          <NumericField label={text.marginSafetyMultiplier} value={marginSafetyMultiplier} onChange={onMarginSafetyMultiplier} suffix="x" />
          <label className="systematic-lab-field">
            <span>{text.positionSizing}</span>
            <TerminalSelect
              ariaLabel={text.positionSizing}
              value={positionSizingMode}
              options={[{ value: "equityPercent", label: text.equityPercent }, { value: "fixedUsdt", label: text.fixedUsdt }]}
              onChange={(value) => onPositionSizingMode(value === "fixedUsdt" ? "fixedUsdt" : "equityPercent")}
            />
          </label>
          <NumericField label={text.perEntryBudget} value={perEntryBudget} onChange={onPerEntryBudget} suffix={positionSizingMode === "equityPercent" ? "%" : "USDT"} />
          <NumericField label={text.sameSideTotalBudget} value={sameSideTotalBudget} onChange={onSameSideTotalBudget} suffix={positionSizingMode === "equityPercent" ? "%" : "USDT"} />
          <label className="systematic-lab-field">
            <span>{text.start}</span>
            <input type="datetime-local" value={startAt} onChange={(event) => onStartAt(event.target.value)} />
          </label>
          <label className="systematic-lab-field">
            <span>{text.end}</span>
            <input type="datetime-local" value={endAt} max={maximumEndAt || undefined} onChange={(event) => onEndAt(event.target.value)} />
          </label>
          <NumericField label={text.preloadHistory} value={preloadBars} onChange={onPreloadBars} suffix="1m" wide />
        </div>
        <PreloadScope text={text} startAt={startAt} preloadBars={preloadBars} />
        <div className="systematic-lab-assumption-grid">
          <NumericField label={text.entrySlippage} value={entrySlippage} onChange={onEntrySlippage} suffix="bps" />
          <NumericField label={text.exitSlippage} value={exitSlippage} onChange={onExitSlippage} suffix="bps" />
          <NumericField label={text.entryFee} value={entryFee} onChange={onEntryFee} suffix="%" />
          <NumericField label={text.exitFee} value={exitFee} onChange={onExitFee} suffix="%" />
          <label className="systematic-lab-field wide">
            <span>{text.endOfRun}</span>
            <TerminalSelect
              ariaLabel={text.endOfRun}
              value={endPolicy}
              options={[
                { value: "markToMarket", label: text.markToMarket },
                { value: "closeAtLastClose", label: text.forceClose }
              ]}
              onChange={(value) => onEndPolicy(value as "markToMarket" | "closeAtLastClose")}
            />
          </label>
        </div>
        {selectedStrategy?.kind === "python" && !runtimeAvailable ? <PythonEnvironmentNotice runtime={pythonRuntime} preparing={preparingPython} text={text} onRetry={onRetryPythonEnvironment} /> : null}
        <div className="systematic-lab-backtest-config__footer">
          <span>{text.fillModel}</span>
          <div className="systematic-lab__head-actions">
            {selectedStrategy?.kind === "python" ? <button className="systematic-lab__command-button" type="button" disabled={!canRun} onClick={onOptimize}>{optimizing ? <LoaderCircle size={14} className="is-spinning" /> : <SlidersHorizontal size={14} />}{text.optimize}</button> : null}
            <button className="systematic-lab__command-button is-primary" type="button" disabled={!canRun} onClick={onRun}>{starting ? <LoaderCircle size={14} className="is-spinning" /> : <Play size={14} />}{starting ? text.queuing : text.runBacktest}</button>
          </div>
        </div>
      </section>
      {selectedStrategy?.kind === "python" ? <OptimizationPanel text={text} optimizations={optimizations.filter((item) => item.strategyId === selectedStrategy.id && item.instId === selectedSymbol)} onApply={onApplyOptimization} /> : null}
    </div>
  );
}

function OptimizationPanel({ text, optimizations, onApply }: Readonly<{
  text: Copy;
  optimizations: SystematicOverview["optimizations"];
  onApply: (parameters: Record<string, unknown>) => void;
}>) {
  if (!optimizations.length) return null;
  return (
    <section className="systematic-lab-optimization-panel" aria-label={text.optimizationResults}>
      <div className="systematic-lab-view-heading">
        <div><span className="systematic-lab__eyebrow">{text.optimization}</span><h2>{text.optimizationResults}</h2></div>
      </div>
      <div className="systematic-lab-optimization-list">
        {optimizations.map((optimization) => {
          const progress = optimization.candidateCount > 0 ? optimization.completedCount / optimization.candidateCount * 100 : 0;
          const completed = optimization.status === "completed";
          const failed = optimization.status === "failed";
          return <article key={optimization.id} className="systematic-lab-optimization-row">
            <div>
              <strong>{optimization.instId}</strong>
              <small>{formatBacktestDateRange(optimization.validationStartAt, optimization.validationEndAt)}</small>
            </div>
            <div className="systematic-lab-optimization-row__progress">
              <span><b style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} /></span>
              <small>{formatLocalizedNumber(optimization.completedCount)} / {formatLocalizedNumber(optimization.candidateCount)}</small>
            </div>
            <div className="systematic-lab-optimization-row__score">
              <span>{text.validationCalmar}</span>
              <strong className={clsx((optimization.bestValidationCalmar ?? 0) >= 0 ? "positive" : "negative")}>{formatRatio(optimization.bestValidationCalmar)}</strong>
            </div>
            {completed && optimization.bestParameters ? <button className="systematic-lab__command-button" type="button" onClick={() => onApply(optimization.bestParameters!)}><SlidersHorizontal size={13} />{text.applyToDraft}</button> : null}
            {failed ? <small className="systematic-lab__error-notice"><AlertTriangle size={12} />{optimization.error || text.optimizationFailed}</small> : null}
          </article>;
        })}
      </div>
      <small className="systematic-lab-optimization-panel__note">{text.optimizationNote}</small>
    </section>
  );
}

function ReviewView({ text, runs, selectedRun, detail, loading, replayIndex, replayAbsoluteIndex, replayPageLoading, replayBars, replayCursorBar, replayFills, replayFillLedger, replayFillCount, replaySnapshot, replayClosedTradeLedger, replayClosedTradeCount, replayFees, onChoose, onReplayIndex, onReplayRangeDragging, onDelete, deletingId }: Readonly<{
  text: Copy;
  runs: SystematicBacktestView[];
  selectedRun: SystematicBacktestView | null;
  detail: SystematicBacktestDetail | null;
  loading: boolean;
  replayIndex: number;
  replayAbsoluteIndex: number;
  replayPageLoading: boolean;
  replayBars: Candle[];
  replayCursorBar: Candle | null;
  replayFills: ChartFillMarker[];
  replayFillLedger: readonly SystematicBacktestFill[];
  replayFillCount: number;
  replaySnapshot: SystematicReplaySnapshot | null;
  replayClosedTradeLedger: readonly SystematicClosedTrade[];
  replayClosedTradeCount: number;
  replayFees: number;
  onChoose: (id: string) => void;
  onReplayIndex: (value: number, immediate?: boolean) => void;
  onReplayRangeDragging: (dragging: boolean) => void;
  onDelete: (run: SystematicBacktestView) => void;
  deletingId: string | null;
}>) {
  const [accountTab, setAccountTab] = useState<"ledger" | "position" | "history">("ledger");
  const report = detail?.report;
  const metrics = report?.metrics;
  const visibleBar = replayCursorBar;
  const replayNetPnl = replaySnapshot && metrics
    ? replaySnapshot.equityUsdt - metrics.initialEquityUsdt
    : undefined;
  const replayTimeMs = replaySnapshot?.timeMs ?? (visibleBar ? visibleBar.time * 1_000 : null);
  const replayTotalBarCount = detail?.totalBarCount ?? 0;
  const loadedReplayIndex = detail ? detail.barOffset + replayIndex : 0;
  const absoluteReplayIndex = replayTotalBarCount > 0
    ? Math.min(replayTotalBarCount, Math.max(1, replayAbsoluteIndex || loadedReplayIndex))
    : 0;
  const evaluationRange = formatBacktestDateRange(detail?.evaluationStartAt, detail?.evaluationEndAt);
  return (
    <div className="systematic-lab-review-view">
      <aside className="systematic-lab-run-list">
        <div className="systematic-lab__pane-head"><span>{text.backtestRuns}</span><span className="systematic-lab__count">{runs.length}</span></div>
        <div className="systematic-lab-run-list__scroll">
          {runs.map((run) => {
            const returnPct = run.metrics?.netReturnPct;
            const completed = run.status === "completed";
            return <div key={run.id} className={clsx("systematic-lab-run-row", selectedRun?.id === run.id && "is-selected")}>
              <button type="button" className="systematic-lab-run-row__select" onClick={() => onChoose(run.id)}>
                <span className={clsx("systematic-lab-run-row__state", `is-${run.status}`)} />
                <span>
                  <strong>{run.strategyName}</strong>
                  <small className="systematic-lab-run-row__instrument"><SymbolIcon base={symbolBase(run.instId)} /><span>{run.instId}</span><b>v{run.strategyVersion}</b><i>·</i>{formatRunTime(run.finishedAt ?? run.createdAt)}</small>
                </span>
                <em className={clsx(
                  "systematic-lab-run-row__return",
                  completed && typeof returnPct === "number" && returnPct > 0 && "is-positive",
                  completed && typeof returnPct === "number" && returnPct < 0 && "is-negative",
                )}>{completed ? formatPercent(returnPct) : `${Math.round(run.progressPct)}%`}</em>
              </button>
              <button type="button" className="systematic-lab__row-delete" title={text.deleteBacktest} aria-label={text.deleteBacktest} disabled={deletingId === run.id || ["queued", "running", "cancelling"].includes(run.status)} onClick={() => onDelete(run)}>{deletingId === run.id ? <LoaderCircle size={13} className="is-spinning" /> : <Trash2 size={13} />}</button>
            </div>;
          })}
          {runs.length === 0 ? <EmptyState icon={<History size={18} />} title={text.noRuns} detail={text.noRunsDetail} /> : null}
        </div>
      </aside>
      <main className="systematic-lab-review-main">
        {selectedRun ? (
          <>
            <div className="systematic-lab-review-main__head">
              <div><span className="systematic-lab__eyebrow">{selectedRun.instId} · 1m{detail?.preloadBarCount ? ` · ${formatLocalizedNumber(detail.preloadBarCount)} ${text.preloadHistory}` : ""}</span><h2>{selectedRun.strategyName}</h2></div>
              {detail ? <div className="systematic-lab-review-main__date-range" title={evaluationRange}><span>{text.evaluationRange}</span><strong>{evaluationRange}</strong></div> : null}
              <RunStatus run={selectedRun} text={text} />
            </div>
            {loading ? <div className="systematic-lab-loading"><LoaderCircle size={18} className="is-spinning" /> {text.loadingResult}</div> : null}
            {report && replayBars.length ? (
              <>
                <div className="systematic-lab-metrics-strip">
                  <Metric label={text.netPnl} value={formatUsdt(replayNetPnl)} tone={(replayNetPnl ?? 0) >= 0 ? "positive" : "negative"} />
                  <Metric label={text.cashBalance} value={formatUsdt(replaySnapshot?.cashUsdt)} />
                  <Metric label={text.accountEquity} value={formatUsdt(replaySnapshot?.equityUsdt)} />
                  <Metric label={text.unrealizedPnl} value={formatUsdt(replaySnapshot?.unrealizedPnlUsdt)} tone={(replaySnapshot?.unrealizedPnlUsdt ?? 0) >= 0 ? "positive" : "negative"} />
                  <Metric label={text.usedMargin} value={formatUsdt(replaySnapshot?.usedMarginUsdt)} />
                  <Metric label={text.availableMargin} value={formatUsdt(replaySnapshot?.availableMarginUsdt)} />
                  <Metric label={text.closedTrades} value={formatLocalizedNumber(replayClosedTradeCount)} />
                  <Metric label={text.fees} value={formatUsdt(replayFees)} />
                </div>
                <div className="systematic-lab-replay-stage">
                  <div className="systematic-lab-replay-stage__toolbar">
                    <span><i className="systematic-lab-replay-stage__legend systematic-lab-replay-stage__legend--fill" />{text.replayActionLegend}</span>
                    {report.limitOrderFillModel === "kline_conservative_estimate" ? <span className="systematic-lab-replay-stage__estimate" title={text.limitFillEstimateDetail}>{text.limitFillEstimate}</span> : null}
                    <strong>1m</strong>
                  </div>
                  <div className="systematic-lab-replay-stage__chart">
                    <KlineChart
                      candles={replayBars}
                      ticker={null}
                      symbol={selectedRun.instId}
                      timeframe="1m"
                      fills={replayFills}
                      variant="review"
                      workspaceId={`systematic-replay-${selectedRun.id}`}
                      persistWorkspace={false}
                      synchronizedCrosshairTime={visibleBar?.time ?? null}
                      followSynchronizedCrosshair
                    />
                  </div>
                </div>
                <div className="systematic-lab-replay-controls">
                  <span className="systematic-lab-replay-controls__label"><History size={12} />{text.replay}</span>
                  <button className="systematic-lab__icon-button" type="button" onClick={() => onReplayIndex(Math.max(1, absoluteReplayIndex - 1), true)} disabled={replayPageLoading || absoluteReplayIndex <= 1} title={text.previousBar} aria-label={text.previousBar}><ChevronLeft size={16} /></button>
                  <input
                    type="range"
                    min={1}
                    max={replayTotalBarCount}
                    value={absoluteReplayIndex}
                    disabled={replayPageLoading}
                    onPointerDown={() => onReplayRangeDragging(true)}
                    onChange={(event) => onReplayIndex(Number(event.target.value))}
                    onPointerUp={(event) => {
                      onReplayRangeDragging(false);
                      onReplayIndex(Number(event.currentTarget.value), true);
                    }}
                    onPointerCancel={(event) => {
                      onReplayRangeDragging(false);
                      onReplayIndex(Number(event.currentTarget.value), true);
                    }}
                    onKeyUp={(event) => {
                      if (["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
                        onReplayIndex(Number(event.currentTarget.value), true);
                      }
                    }}
                    aria-label={text.replay}
                  />
                  <button className="systematic-lab__icon-button" type="button" onClick={() => onReplayIndex(Math.min(replayTotalBarCount, absoluteReplayIndex + 1), true)} disabled={replayPageLoading || absoluteReplayIndex >= replayTotalBarCount} title={text.nextBar} aria-label={text.nextBar}><ChevronRight size={16} /></button>
                  <span>{formatLocalizedNumber(absoluteReplayIndex)} / {formatLocalizedNumber(replayTotalBarCount)}</span>
                  {replayPageLoading ? <span className="systematic-lab-replay-controls__loading" role="status" title={text.loadingReplayPage} aria-label={text.loadingReplayPage}><LoaderCircle size={13} className="is-spinning" /></span> : null}
                  <strong>{replayPageLoading ? text.loadingReplayPage : visibleBar ? formatRunTime(visibleBar.time * 1_000) : "--"}</strong>
                </div>
                <div className="systematic-lab-review-insights">
                  <div className="systematic-lab-equity-stage">
                    <div className="systematic-lab-equity-stage__head"><span>{text.equityCurve}</span><strong>{formatUsdt(replaySnapshot?.equityUsdt)}</strong></div>
                    <SystematicEquityChart points={report.equityCurve} negative={(metrics?.netPnlUsdt ?? 0) < 0} label={text.equityCurve} cursorTimeMs={replayTimeMs} />
                  </div>
                  <BacktestStatisticsPanel text={text} report={report} />
                </div>
              </>
            ) : selectedRun.status === "completed" && !loading ? <EmptyState icon={<BarChart3 size={20} />} title={text.resultUnavailable} detail={text.resultUnavailableDetail} /> : null}
            {selectedRun.error ? <div className="systematic-lab__error-notice"><AlertTriangle size={15} /> {selectedRun.error}</div> : null}
          </>
        ) : <EmptyState icon={<History size={20} />} title={text.noRuns} detail={text.noRunsDetail} />}
      </main>
      <aside className="systematic-lab-trade-ledger">
        <div className="systematic-lab__pane-head systematic-lab-account-tabs" role="tablist" aria-label={text.replayAccount}>
          <button type="button" role="tab" aria-selected={accountTab === "ledger"} className={accountTab === "ledger" ? "is-active" : ""} onClick={() => setAccountTab("ledger")} title={text.tradeLedger} aria-label={text.tradeLedger}><WalletCards size={12} /><span>{text.tradeLedger}</span></button>
          <button type="button" role="tab" aria-selected={accountTab === "position"} className={accountTab === "position" ? "is-active" : ""} onClick={() => setAccountTab("position")} title={text.position} aria-label={text.position}><Activity size={12} /><span>{text.position}</span></button>
          <button type="button" role="tab" aria-selected={accountTab === "history"} className={accountTab === "history" ? "is-active" : ""} onClick={() => setAccountTab("history")} title={text.positionHistory} aria-label={text.positionHistory}><History size={12} /><span>{text.positionHistory}</span></button>
          <span className="systematic-lab__count">{accountTab === "ledger" ? replayFillCount : accountTab === "history" ? replayClosedTradeCount : replaySnapshot?.position ? 1 : 0}</span>
        </div>
        {accountTab === "ledger" ? (
          <ReplayFillLedgerPanel text={text} fills={replayFillLedger} visibleCount={replayFillCount} />
        ) : accountTab === "history" ? (
          <ReplayPositionHistoryPanel text={text} trades={replayClosedTradeLedger} visibleCount={replayClosedTradeCount} />
        ) : <ReplayPositionPanel text={text} position={replaySnapshot?.position ?? null} atTimeMs={replaySnapshot?.timeMs ?? null} />}
      </aside>
    </div>
  );
}

const REPLAY_FILL_LEDGER_ROW_HEIGHT = 196;
const REPLAY_POSITION_HISTORY_ROW_HEIGHT = 220;
const REPLAY_LEDGER_OVERSCAN = 3;

function ReplayFillLedgerPanel({ text, fills, visibleCount }: Readonly<{
  text: Copy;
  fills: readonly SystematicBacktestFill[];
  visibleCount: number;
}>) {
  if (!visibleCount) {
    return <div className="systematic-lab-trade-ledger__scroll" role="tabpanel"><EmptyState icon={<WalletCards size={18} />} title={text.noReplayFills} detail={text.noReplayFillsDetail} /></div>;
  }
  return (
    <ReplayVirtualList
      rowCount={visibleCount}
      rowHeight={REPLAY_FILL_LEDGER_ROW_HEIGHT}
      renderRow={(visibleIndex) => {
        const fillIndex = visibleCount - visibleIndex - 1;
        const fill = fills[fillIndex];
        if (!fill) return null;
        return <ReplayFillLedgerRow key={`${fill.timeMs}-${fill.side}-${fillIndex}`} text={text} fill={fill} />;
      }}
    />
  );
}

function ReplayFillLedgerRow({ text, fill }: Readonly<{
  text: Copy;
  fill: SystematicBacktestFill;
}>) {
  return (
    <div className="systematic-lab-ledger-row is-virtual-fill">
      <div className="systematic-lab-ledger-row__head">
        <span className={fill.side === "buy" ? "positive" : "negative"}>{fill.side === "buy" ? text.buy : text.sell}</span>
        <strong>{formatLocalizedNumber(fill.quantity)} {text.contracts}</strong>
      </div>
      <div className="systematic-lab-ledger-row__details">
        <ContractRow label={text.fillPrice} value={formatPrice(fill.fillPrice)} />
        <ContractRow label={text.notional} value={formatUsdt(fill.notionalUsdt)} />
        <ContractRow label={text.fee} value={formatUsdt(fill.feeUsdt)} />
        <ContractRow label={text.marginChange} value={formatUsdt(fill.marginDeltaUsdt)} />
        <ContractRow label={text.usedMargin} value={formatUsdt(fill.marginAfterUsdt)} />
      </div>
      <small>{formatRunTime(fill.timeMs)} · {fill.reason}</small>
    </div>
  );
}

function ReplayPositionHistoryPanel({ text, trades, visibleCount }: Readonly<{
  text: Copy;
  trades: readonly SystematicClosedTrade[];
  visibleCount: number;
}>) {
  if (!visibleCount) {
    return <div className="systematic-lab-trade-ledger__scroll" role="tabpanel"><EmptyState icon={<History size={18} />} title={text.noReplayTrades} detail={text.noReplayTradesDetail} /></div>;
  }
  return (
    <ReplayVirtualList
      rowCount={visibleCount}
      rowHeight={REPLAY_POSITION_HISTORY_ROW_HEIGHT}
      renderRow={(visibleIndex) => {
        const tradeIndex = visibleCount - visibleIndex - 1;
        const trade = trades[tradeIndex];
        if (!trade) return null;
        return <ReplayPositionHistoryRow key={`${trade.entryTimeMs}-${trade.exitTimeMs}-${tradeIndex}`} text={text} trade={trade} />;
      }}
    />
  );
}

function ReplayPositionHistoryRow({ text, trade }: Readonly<{
  text: Copy;
  trade: SystematicClosedTrade;
}>) {
  return (
    <div className="systematic-lab-ledger-row is-virtual-trade">
      <div className="systematic-lab-ledger-row__head">
        <span className={trade.side === "long" ? "positive" : "negative"}>{trade.side === "long" ? text.long : text.short}</span>
        <strong className={trade.netPnlUsdt >= 0 ? "systematic-lab-pnl--gain" : "systematic-lab-pnl--loss"}>{formatUsdt(trade.netPnlUsdt)}</strong>
      </div>
      <div className="systematic-lab-ledger-row__details">
        <ContractRow label={text.entryPrice} value={formatPrice(trade.entryPrice)} />
        <ContractRow label={text.exitPrice} value={formatPrice(trade.exitPrice)} />
        <ContractRow label={text.entryNotional} value={formatUsdt(trade.entryNotionalUsdt)} />
        <ContractRow label={text.exitNotional} value={formatUsdt(trade.exitNotionalUsdt)} />
        <ContractRow label={text.usedMargin} value={formatUsdt(trade.usedMarginUsdt)} />
        <ContractRow label={text.fee} value={formatUsdt(trade.entryFeeUsdt + trade.exitFeeUsdt)} />
      </div>
      <small>{formatRunTime(trade.entryTimeMs)} - {formatRunTime(trade.exitTimeMs)} · {formatLocalizedNumber(trade.quantity)} {text.contracts} · {formatRatio(trade.leverage)}x</small>
    </div>
  );
}

function ReplayVirtualList({ rowCount, rowHeight, renderRow }: Readonly<{
  rowCount: number;
  rowHeight: number;
  renderRow: (index: number) => ReactNode;
}>) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  const updateViewport = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    setViewport((current) => (
      current.scrollTop === node.scrollTop && current.height === node.clientHeight
        ? current
        : { scrollTop: node.scrollTop, height: node.clientHeight }
    ));
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return undefined;
    updateViewport();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateViewport);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [rowCount, updateViewport]);

  const firstVisible = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - REPLAY_LEDGER_OVERSCAN);
  const lastVisible = Math.min(
    rowCount,
    Math.ceil((viewport.scrollTop + Math.max(viewport.height, rowHeight)) / rowHeight) + REPLAY_LEDGER_OVERSCAN,
  );
  const rows: ReactNode[] = [];
  for (let index = firstVisible; index < lastVisible; index += 1) {
    rows.push(
      <div className="systematic-lab-virtual-list__row" style={{ transform: `translateY(${index * rowHeight}px)` }} key={index}>
        {renderRow(index)}
      </div>,
    );
  }
  return (
    <div ref={scrollRef} className="systematic-lab-trade-ledger__scroll systematic-lab-virtual-list" role="tabpanel" onScroll={updateViewport}>
      <div className="systematic-lab-virtual-list__spacer" style={{ height: rowCount * rowHeight }}>{rows}</div>
    </div>
  );
}

function ReplayPositionPanel({ text, position, atTimeMs }: Readonly<{
  text: Copy;
  position: NonNullable<SystematicReplaySnapshot["position"]> | null;
  atTimeMs: number | null;
}>) {
  if (!position) {
    return <div className="systematic-lab-trade-ledger__scroll" role="tabpanel"><EmptyState icon={<Activity size={18} />} title={text.noPosition} detail={text.noPositionDetail} /></div>;
  }
  return (
    <div className="systematic-lab-trade-ledger__scroll systematic-lab-position-panel" role="tabpanel">
      <div className={clsx("systematic-lab-position-panel__side", position.side === "long" ? "positive" : "negative")}>
        <Activity size={14} />
        <strong>{position.side === "long" ? text.long : text.short}</strong>
        <span>{formatLocalizedNumber(position.quantity)} {text.contracts}</span>
      </div>
      <div className="systematic-lab-contract-list">
        <ContractRow label={text.contractValue} value={formatLocalizedNumber(position.contractValue, { maximumFractionDigits: 8 })} />
        <ContractRow label={text.notional} value={formatUsdt(position.notionalUsdt)} />
        <ContractRow label={text.usedMargin} value={formatUsdt(position.usedMarginUsdt)} />
        <ContractRow label={text.leverage} value={`${formatRatio(position.leverage)}x`} />
        <ContractRow label={text.marginSafetyMultiplier} value={`${formatRatio(position.marginSafetyMultiplier)}x`} />
        <ContractRow label={text.entryPrice} value={formatPrice(position.averageEntryPrice)} />
        <ContractRow label={text.markPrice} value={formatPrice(position.markedPrice)} />
        <ContractRow
          label={text.unrealizedPnl}
          value={formatUsdt(position.unrealizedPnlUsdt)}
          tone={position.unrealizedPnlUsdt >= 0 ? "gain" : "loss"}
        />
        <ContractRow label={text.entryFee} value={formatUsdt(position.entryFeeUsdt)} />
        <ContractRow label={text.funding} value={formatUsdt(position.fundingCashflowUsdt)} />
        <ContractRow label={text.stopLoss} value={formatPrice(position.stopLoss)} />
        <ContractRow label={text.takeProfit} value={formatPrice(position.takeProfit)} />
        <ContractRow label={text.holdingTime} value={atTimeMs ? formatDuration(atTimeMs - position.entryTimeMs) : "--"} />
      </div>
    </div>
  );
}

function BacktestStatisticsPanel({ text, report }: Readonly<{
  text: Copy;
  report: NonNullable<SystematicBacktestDetail["report"]>;
}>) {
  const { metrics } = report;
  const statistics = report.statistics ?? deriveLegacyBacktestStatistics(report);
  const totalReturn = metrics.initialEquityUsdt > 0
    ? metrics.netPnlUsdt / metrics.initialEquityUsdt * 100
    : null;
  return (
    <section className="systematic-lab-statistics-stage" aria-label={text.statistics}>
      <div className="systematic-lab-statistics-stage__head"><span>{text.statistics}</span><strong>{text.fullBacktest}</strong></div>
      <div className="systematic-lab-statistics-grid">
        <Statistic label={text.totalReturn} value={formatPercent(totalReturn)} tone={(totalReturn ?? 0) >= 0 ? "positive" : "negative"} />
        <Statistic label={text.maxDrawdown} value={formatPercent(metrics.maxDrawdownPct * 100, false)} tone="negative" />
        <Statistic label={text.winRate} value={formatPercent(metrics.winRate === undefined || metrics.winRate === null ? null : metrics.winRate * 100, false)} />
        <Statistic label={text.sharpe} value={formatRatio(statistics?.annualizedSharpe)} />
        <Statistic label={text.sortino} value={formatRatio(statistics?.annualizedSortino)} />
        <Statistic label={text.volatility} value={formatPercent(statistics?.annualizedVolatilityPct, false)} />
        <Statistic label={text.profitFactor} value={formatRatio(statistics?.profitFactor)} />
        <Statistic label={text.expectancy} value={formatUsdt(statistics?.expectancyUsdt)} tone={(statistics?.expectancyUsdt ?? 0) >= 0 ? "positive" : "negative"} />
        <Statistic label={text.averageHolding} value={formatDuration(statistics?.averageHoldingMs)} />
        <Statistic label={text.exposure} value={formatPercent(report.statistics?.exposurePct, false)} />
        <Statistic label={text.largestWinLoss} value={`${formatUsdt(statistics?.largestWinUsdt)} / ${formatUsdt(statistics?.largestLossUsdt)}`} />
        <Statistic label={text.maxStreak} value={`${formatLocalizedNumber(statistics?.maxConsecutiveWins ?? 0)} / ${formatLocalizedNumber(statistics?.maxConsecutiveLosses ?? 0)}`} />
      </div>
    </section>
  );
}

function deriveLegacyBacktestStatistics(report: NonNullable<SystematicBacktestDetail["report"]>): Omit<SystematicBacktestStatistics, "exposurePct"> {
  const returns: number[] = [];
  for (let index = 1; index < report.equityCurve.length; index += 1) {
    const previous = report.equityCurve[index - 1]?.equityUsdt;
    const current = report.equityCurve[index]?.equityUsdt;
    if (previous !== undefined && current !== undefined && Number.isFinite(previous) && previous > 0 && Number.isFinite(current)) {
      returns.push(current / previous - 1);
    }
  }
  const minutesPerYear = 365 * 24 * 60;
  const mean = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null;
  const sampleDeviation = mean !== null && returns.length >= 2
    ? Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1))
    : null;
  const downsideDeviation = mean !== null && returns.length >= 2
    ? Math.sqrt(returns.reduce((sum, value) => sum + Math.min(value, 0) ** 2, 0) / returns.length)
    : null;
  const annualizer = Math.sqrt(minutesPerYear);
  const annualizedSharpe = mean !== null && sampleDeviation !== null && sampleDeviation > Number.EPSILON
    ? mean / sampleDeviation * annualizer
    : undefined;
  const annualizedVolatilityPct = sampleDeviation === null
    ? undefined
    : sampleDeviation * annualizer * 100;
  const annualizedSortino = mean !== null && downsideDeviation !== null && downsideDeviation > Number.EPSILON
    ? mean / downsideDeviation * annualizer
    : undefined;
  const wins = report.closedTrades.filter((trade) => trade.netPnlUsdt > 0);
  const losses = report.closedTrades.filter((trade) => trade.netPnlUsdt < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.netPnlUsdt, 0);
  const grossLoss = losses.reduce((sum, trade) => sum + Math.abs(trade.netPnlUsdt), 0);
  const averageWinUsdt = wins.length ? grossProfit / wins.length : undefined;
  const averageLossUsdt = losses.length ? losses.reduce((sum, trade) => sum + trade.netPnlUsdt, 0) / losses.length : undefined;
  let currentWins = 0;
  let currentLosses = 0;
  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;
  for (const trade of report.closedTrades) {
    if (trade.netPnlUsdt > 0) {
      currentWins += 1;
      currentLosses = 0;
      maxConsecutiveWins = Math.max(maxConsecutiveWins, currentWins);
    } else if (trade.netPnlUsdt < 0) {
      currentLosses += 1;
      currentWins = 0;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentLosses);
    } else {
      currentWins = 0;
      currentLosses = 0;
    }
  }
  return {
    annualizedSharpe,
    annualizedSortino,
    annualizedVolatilityPct,
    profitFactor: grossLoss > Number.EPSILON ? grossProfit / grossLoss : undefined,
    expectancyUsdt: report.closedTrades.length
      ? report.closedTrades.reduce((sum, trade) => sum + trade.netPnlUsdt, 0) / report.closedTrades.length
      : undefined,
    averageWinUsdt,
    averageLossUsdt,
    payoffRatio: averageWinUsdt !== undefined && averageLossUsdt !== undefined && Math.abs(averageLossUsdt) > Number.EPSILON
      ? averageWinUsdt / Math.abs(averageLossUsdt)
      : undefined,
    averageHoldingMs: report.closedTrades.length
      ? Math.floor(report.closedTrades.reduce((sum, trade) => sum + Math.max(0, trade.exitTimeMs - trade.entryTimeMs), 0) / report.closedTrades.length)
      : undefined,
    largestWinUsdt: wins.length ? Math.max(...wins.map((trade) => trade.netPnlUsdt)) : undefined,
    largestLossUsdt: losses.length ? Math.min(...losses.map((trade) => trade.netPnlUsdt)) : undefined,
    maxConsecutiveWins,
    maxConsecutiveLosses,
  };
}

function Statistic({ label, value, tone }: Readonly<{ label: string; value: string; tone?: "positive" | "negative" }>) {
  return <div className={clsx("systematic-lab-statistic", tone && `is-${tone}`)}><span>{label}</span><strong>{value}</strong></div>;
}

function profileDraftFrom(profile: SystematicOverview["profiles"][number]): ProfileDraft {
  return {
    id: profile.id,
    name: profile.name,
    strategyId: profile.strategyId,
    strategyVersion: String(profile.strategyVersion),
    instId: profile.instId,
    accountId: profile.accountId,
    enabled: profile.enabled,
    leverage: String(profile.leverage),
    marginMode: profile.marginMode === "isolated" ? "isolated" : "cross",
    positionSizingMode: profile.positionSizing.mode === "fixedUsdt" ? "fixedUsdt" : "equityPercent",
    perEntryBudget: String(profile.positionSizing.perEntryBudget),
    sameSideTotalBudget: String(profile.positionSizing.sameSideTotalBudget),
    dailyLoss: String(profile.dailyLossLimitUsdt),
    cooldown: String(profile.cooldownSeconds),
    allowLong: profile.allowLong,
    allowShort: profile.allowShort,
    notifyOnSignal: profile.notifyOnSignal,
    takeProfitOrderType: profile.takeProfitOrderType === "postFillLimit" || profile.takeProfitOrderType === "post_fill_limit"
      ? "postFillLimit"
      : profile.takeProfitOrderType === "limit" ? "limit" : "market",
    stopLossOrderType: profile.stopLossOrderType === "limit" ? "limit" : "market",
  };
}

function profileDraftMatches(profile: SystematicOverview["profiles"][number], draft: ProfileDraft): boolean {
  return profile.id === draft.id
    && profile.name === draft.name
    && profile.strategyId === draft.strategyId
    && profile.strategyVersion === Number(draft.strategyVersion)
    && profile.instId === draft.instId
    && profile.accountId === draft.accountId
    && profile.leverage === Number(draft.leverage)
    && profile.marginMode === draft.marginMode
    && profile.positionSizing.mode === draft.positionSizingMode
    && profile.positionSizing.perEntryBudget === Number(draft.perEntryBudget)
    && profile.positionSizing.sameSideTotalBudget === Number(draft.sameSideTotalBudget)
    && profile.dailyLossLimitUsdt === Number(draft.dailyLoss)
    && profile.cooldownSeconds === Number(draft.cooldown)
    && profile.allowLong === draft.allowLong
    && profile.allowShort === draft.allowShort
    && profile.notifyOnSignal === draft.notifyOnSignal
    && (profile.takeProfitOrderType === "post_fill_limit" ? "postFillLimit" : profile.takeProfitOrderType) === draft.takeProfitOrderType
    && profile.stopLossOrderType === draft.stopLossOrderType;
}

function ProfilesView({ text, profiles, strategies, watchlist, instruments, accounts, desktop, refresh, onNotify, requestedProfileId, onRequestedProfileHandled }: Readonly<{
  text: Copy;
  profiles: SystematicOverview["profiles"];
  strategies: SystematicStrategyView[];
  watchlist: string[];
  instruments: OkxInstrumentSummary[];
  accounts: Array<{ id: string; name: string; environment: string }>;
  desktop: boolean;
  refresh: () => Promise<void>;
  onNotify: Notify;
  requestedProfileId: string;
  onRequestedProfileHandled: () => void;
}>) {
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [strategyVersions, setStrategyVersions] = useState<SystematicStrategyVersionsPageView | null>(null);
  const [strategyVersionDetail, setStrategyVersionDetail] = useState<SystematicStrategyVersionDetail | null>(null);
  const [loadingProtectionCapabilities, setLoadingProtectionCapabilities] = useState(false);
  const [confirmation, setConfirmation] = useState<"delete" | "force-enable" | "live-enable" | "live-enable-force" | null>(null);
  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId) ?? null;
  const profileTicker = useMarketHotStore((state) => draft?.instId ? state.watchTickers[draft.instId] ?? null : null);
  const profileInstrument = useMemo(
    () => instruments.find((instrument) => instrument.instId === draft?.instId) ?? null,
    [draft?.instId, instruments],
  );
  const positionEstimate = useMemo(
    () => profilePositionEstimate(draft, profileInstrument, profileTicker?.last),
    [draft, profileInstrument, profileTicker?.last],
  );
  const profileDraftDirty = Boolean(selectedProfile && draft && !profileDraftMatches(selectedProfile, draft));
  const makeNewDraft = useCallback((): ProfileDraft => {
    const strategy = strategies[0];
    const instId = watchlist[0] ?? "";
    return {
      name: `${strategy?.name ?? text.pythonStrategy} · ${instId}`.trim(),
      strategyId: strategy?.id ?? "",
      strategyVersion: strategy ? String(strategy.version) : "",
      instId,
      accountId: accounts[0]?.id ?? "",
      enabled: false,
      leverage: "10",
      marginMode: "cross",
      positionSizingMode: "equityPercent",
      perEntryBudget: "5",
      sameSideTotalBudget: "20",
      dailyLoss: "50",
      cooldown: "60",
      allowLong: true,
      allowShort: true,
      notifyOnSignal: true,
      takeProfitOrderType: "market",
      stopLossOrderType: "market",
    };
  }, [accounts, strategies, text.pythonStrategy, watchlist]);

  useEffect(() => {
    if (creating) return;
    const selected = profiles.find((profile) => profile.id === selectedProfileId) ?? profiles[0] ?? null;
    if (!selected) {
      setSelectedProfileId(null);
      setDraft(null);
      return;
    }
    if (selected.id !== selectedProfileId) setSelectedProfileId(selected.id);
    if (!draft || selected.id !== draft.id || (selected.enabled && !profileDraftMatches(selected, draft))) {
      setDraft(profileDraftFrom(selected));
    }
  }, [creating, draft, profiles, selectedProfileId]);
  useEffect(() => {
    if (!requestedProfileId) return;
    const requested = profiles.find((profile) => profile.id === requestedProfileId);
    if (requested) {
      setCreating(false);
      setSelectedProfileId(requested.id);
      setDraft(profileDraftFrom(requested));
    }
    onRequestedProfileHandled();
  }, [onRequestedProfileHandled, profiles, requestedProfileId]);
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    let unlisten: (() => void) | null = null;
    void listenSystematicEvents((event) => {
      if (!active || event.type !== "profileSignal" || (selectedProfileId && event.profileId !== selectedProfileId)) return;
      void refresh();
    }).then((next) => {
      if (!active) next?.();
      else unlisten = next;
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [desktop, refresh, selectedProfileId]);
  useEffect(() => {
    if (!desktop || !draft?.strategyId) {
      setStrategyVersions(null);
      return;
    }
    let active = true;
    void loadSystematicStrategyVersions(draft.strategyId, 1, 100).then((versions) => {
      if (active) setStrategyVersions(versions ?? null);
    }).catch(() => {
      if (active) setStrategyVersions(null);
    });
    return () => { active = false; };
  }, [desktop, draft?.strategyId]);
  useEffect(() => {
    if (!desktop || !draft?.strategyId || !Number.isInteger(Number(draft.strategyVersion)) || Number(draft.strategyVersion) <= 0) {
      setStrategyVersionDetail(null);
      setLoadingProtectionCapabilities(false);
      return;
    }
    let active = true;
    setStrategyVersionDetail(null);
    setLoadingProtectionCapabilities(true);
    void loadSystematicStrategyVersionDetail(draft.strategyId, Number(draft.strategyVersion)).then((detail) => {
      if (active) setStrategyVersionDetail(detail ?? null);
    }).catch(() => {
      if (active) setStrategyVersionDetail(null);
    }).finally(() => {
      if (active) setLoadingProtectionCapabilities(false);
    });
    return () => { active = false; };
  }, [desktop, draft?.strategyId, draft?.strategyVersion]);

  const selectProfile = (profile: SystematicOverview["profiles"][number]) => {
    setCreating(false);
    setSelectedProfileId(profile.id);
    setDraft(profileDraftFrom(profile));
  };
  const createNew = () => {
    setCreating(true);
    setSelectedProfileId(null);
    setDraft(makeNewDraft());
  };
  const updateDraft = (patch: Partial<ProfileDraft>) => setDraft((current) => current ? { ...current, ...patch } : current);
  const save = async () => {
    if (!draft) return;
    const selectedAccount = accounts.find((account) => account.id === draft.accountId);
    const values = [Number(draft.leverage), Number(draft.perEntryBudget), Number(draft.sameSideTotalBudget), Number(draft.dailyLoss), Number(draft.cooldown)];
    if (!draft.name.trim()
      || !draft.strategyId
      || !Number.isInteger(Number(draft.strategyVersion))
      || Number(draft.strategyVersion) <= 0
      || !draft.instId
      || !selectedAccount
      || (!draft.allowLong && !draft.allowShort)
      || !Number.isInteger(values[4])
      || values.some((value, index) => !Number.isFinite(value) || value < 0 || (index < 4 && value <= 0))
      || values[1] > values[2]
      || (draft.positionSizingMode === "equityPercent" && values[2] > 100)) {
      onNotify({ kind: "warning", title: text.invalidProfile, message: text.invalidProfileDetail }); return;
    }
    setSaving(true);
    try {
      const saved = await saveSystematicProfile({
        id: draft.id,
        name: draft.name,
        strategyId: draft.strategyId,
        strategyVersion: Number(draft.strategyVersion),
        instId: draft.instId,
        accountId: draft.accountId,
        environment: selectedAccount.environment === "live" ? "live" : "demo",
        enabled: false,
        leverage: values[0],
        marginMode: draft.marginMode,
        positionSizing: { mode: draft.positionSizingMode, perEntryBudget: values[1], sameSideTotalBudget: values[2] },
        dailyLossLimitUsdt: values[3],
        cooldownSeconds: values[4],
        allowLong: draft.allowLong,
        allowShort: draft.allowShort,
        notifyOnSignal: draft.notifyOnSignal,
        takeProfitOrderType: draft.takeProfitOrderType,
        stopLossOrderType: draft.stopLossOrderType,
      });
      if (!saved) throw new Error(text.profileSaveFailed);
      setCreating(false);
      setSelectedProfileId(saved.id);
      setDraft(profileDraftFrom(saved));
      await refresh();
      onNotify({ kind: "success", title: text.profileSaved, message: saved.name });
    } catch (error) { onNotify({ kind: "error", title: text.profileSaveFailed, message: profileErrorMessage(error, text) }); }
    finally { setSaving(false); }
  };
  const toggle = async (force = false, confirmedLive = false) => {
    if (!selectedProfile) return;
    if (profileDraftDirty) {
      onNotify({ kind: "warning", title: text.profileDraftUnsaved, message: text.profileDraftSaveFirst });
      return;
    }
    if (selectedProfile.aiConflict && !selectedProfile.enabled && !force) {
      setConfirmation("force-enable");
      return;
    }
    if (!selectedProfile.enabled && selectedProfile.environment === "live" && !confirmedLive) {
      setConfirmation(force ? "live-enable-force" : "live-enable");
      return;
    }
    try {
      const saved = await setSystematicProfileEnabled(selectedProfile.id, !selectedProfile.enabled, force, confirmedLive);
      if (!saved) throw new Error(text.profileStateFailed);
      setDraft(profileDraftFrom(saved));
      await refresh();
    } catch (error) {
      const message = profileErrorMessage(error, text);
      if (!message.includes("ACCOUNT_POSITION_MODE_SWITCH_FAILED:")) {
        onNotify({ kind: "error", title: text.profileStateFailed, message });
      }
    }
  };
  const remove = async () => {
    if (!selectedProfile) return;
    try {
      await deleteSystematicProfile(selectedProfile.id);
      setCreating(false);
      setSelectedProfileId(null);
      setDraft(null);
      await refresh();
    } catch (error) { onNotify({ kind: "error", title: text.profileDeleteFailed, message: messageOf(error) }); }
  };
  const canCreate = desktop && strategies.length > 0 && watchlist.length > 0 && accounts.length > 0;
  const profileEditable = desktop && !selectedProfile?.enabled;
  const profileCapabilities = selectedProfile
    && selectedProfile.strategyId === draft?.strategyId
    && selectedProfile.strategyVersion === Number(draft?.strategyVersion)
    ? selectedProfile.protectionCapabilities
    : null;
  const protectionCapabilities: SystematicProtectionCapabilities | null = strategyVersionDetail?.protectionCapabilities
    ?? profileCapabilities
    ?? null;
  const showTakeProfitExecution = Boolean(protectionCapabilities?.hasTakeProfit || protectionCapabilities?.unknown);
  const showStopLossExecution = Boolean(protectionCapabilities?.hasStopLoss || protectionCapabilities?.unknown);
  return (
    <div className="systematic-lab-profiles-workspace">
      <aside className="systematic-lab-profile-sidebar">
        <div className="systematic-lab__pane-head">
          <span>{text.profiles}</span>
          <button className="systematic-lab__icon-button" type="button" disabled={!canCreate} onClick={createNew} title={text.newProfile} aria-label={text.newProfile}><FilePlus2 size={14} /></button>
        </div>
        <div className="systematic-lab-profile-sidebar__list">
          {profiles.map((profile) => (
            <button key={profile.id} type="button" className={clsx("systematic-lab-profile-item", selectedProfileId === profile.id && !creating && "is-selected")} onClick={() => selectProfile(profile)}>
              <span className={clsx("systematic-lab-run-row__state", profile.enabled ? "is-completed" : "is-failed")} />
              <span>
                <strong>{profile.name}</strong>
                <small>{profile.instId} · {profile.environment} · v{profile.strategyVersion}</small>
                <em>{profile.enabled ? text.armed : text.stopped}</em>
              </span>
              <ChevronRight size={14} />
            </button>
          ))}
          {profiles.length === 0 ? <EmptyState icon={<Bot size={20} />} title={text.noProfiles} detail={text.noProfilesDetail} /> : null}
        </div>
      </aside>
      <main className="systematic-lab-profile-editor">
        {draft ? <section className="systematic-lab-profile-editor__content">
          <header className="systematic-lab-profile-editor__head">
            <div>
              <span className="systematic-lab__eyebrow">{text.profiles}</span>
              <strong>{draft.name || text.newProfile}</strong>
              <small>{text.profileDescription}</small>
            </div>
            <div className="systematic-lab-profile-editor__actions">
              {profileDraftDirty ? <span className="systematic-lab__status is-guarded"><AlertTriangle size={12} />{text.profileDraftUnsaved}</span> : null}
              {selectedProfile ? <div className="systematic-lab-profile-enable"><span>{text.profileEnabled}</span><button className={clsx("systematic-lab-profile-switch", selectedProfile.enabled && "is-on")} type="button" role="switch" aria-checked={selectedProfile.enabled} aria-label={`${text.profileEnabled}: ${selectedProfile.enabled ? text.armed : text.stopped}`} title={profileDraftDirty ? text.profileDraftSaveFirst : selectedProfile.enabled ? text.armed : text.stopped} disabled={saving || !desktop} onClick={() => void toggle()}><span /></button></div> : null}
              <button className="systematic-lab__command-button is-primary" type="button" disabled={saving || !canCreate || Boolean(selectedProfile?.enabled)} onClick={() => void save()}>{saving ? <LoaderCircle size={13} className="is-spinning" /> : <Save size={13} />}{text.saveProfile}</button>
              {selectedProfile ? <button className="systematic-lab__icon-button is-danger" type="button" disabled={saving || !desktop} title={text.deleteProfile} aria-label={text.deleteProfile} onClick={() => setConfirmation("delete")}><Trash2 size={14} /></button> : null}
            </div>
          </header>
          <span className="systematic-lab__status is-guarded"><ShieldCheck size={12} />{text.profileGuard}</span>
          <div className="systematic-lab-profile-editor__form">
            <label className="systematic-lab-field wide"><span>{text.name}</span><input value={draft.name} disabled={!profileEditable} onChange={(event) => updateDraft({ name: event.target.value })} /></label>
            <label className="systematic-lab-field"><span>{text.strategy}</span><TerminalSelect ariaLabel={text.strategy} value={draft.strategyId} options={strategies.map((strategy) => ({ value: strategy.id, label: `${strategy.name} · v${strategy.version}` }))} disabled={!profileEditable} onChange={(strategyId) => {
              const selected = strategies.find((strategy) => strategy.id === strategyId);
              updateDraft({ strategyId, strategyVersion: selected ? String(selected.version) : "", takeProfitOrderType: "market", stopLossOrderType: "market" });
            }} /></label>
            <label className="systematic-lab-field"><span>{text.strategyVersion}</span><TerminalSelect ariaLabel={text.strategyVersion} value={draft.strategyVersion} options={(strategyVersions?.items ?? []).map((version) => ({ value: String(version.version), label: `v${version.version}${version.version === strategies.find((strategy) => strategy.id === draft.strategyId)?.version ? ` · ${text.latestVersion}` : ""}` }))} disabled={!profileEditable || !strategyVersions} onChange={(strategyVersion) => updateDraft({ strategyVersion, takeProfitOrderType: "market", stopLossOrderType: "market" })} /></label>
            <label className="systematic-lab-field"><span>{text.contract}</span><ProfileInstrumentSelect value={draft.instId} options={watchlist} disabled={!profileEditable} text={text} onChange={(instId) => updateDraft({ instId })} /></label>
            <label className="systematic-lab-field"><span>{text.account}</span><TerminalSelect ariaLabel={text.account} value={draft.accountId} options={accounts.map((account) => ({ value: account.id, label: `${account.name} · ${account.environment}` }))} disabled={!profileEditable} onChange={(accountId) => updateDraft({ accountId })} /></label>
            <NumericField label={text.leverage} value={draft.leverage} onChange={(leverage) => updateDraft({ leverage })} suffix="x" disabled={!profileEditable} />
            <label className="systematic-lab-field"><span>{text.marginMode}</span><TerminalSelect ariaLabel={text.marginMode} value={draft.marginMode} options={[{ value: "cross", label: text.crossMargin }, { value: "isolated", label: text.isolatedMargin }]} disabled={!profileEditable} onChange={(marginMode) => updateDraft({ marginMode: marginMode === "isolated" ? "isolated" : "cross" })} /></label>
            <label className="systematic-lab-field"><span>{text.positionSizing}</span><TerminalSelect ariaLabel={text.positionSizing} value={draft.positionSizingMode} options={[{ value: "equityPercent", label: text.equityPercent }, { value: "fixedUsdt", label: text.fixedUsdt }]} disabled={!profileEditable} onChange={(value) => updateDraft({ positionSizingMode: value === "fixedUsdt" ? "fixedUsdt" : "equityPercent" })} /></label>
            <NumericField label={text.perEntryBudget} value={draft.perEntryBudget} onChange={(perEntryBudget) => updateDraft({ perEntryBudget })} suffix={draft.positionSizingMode === "equityPercent" ? "%" : "USDT"} disabled={!profileEditable} hint={<ProfilePositionEstimateHint estimate={positionEstimate} text={text} />} />
            <NumericField label={text.sameSideTotalBudget} value={draft.sameSideTotalBudget} onChange={(sameSideTotalBudget) => updateDraft({ sameSideTotalBudget })} suffix={draft.positionSizingMode === "equityPercent" ? "%" : "USDT"} disabled={!profileEditable} />
            {showTakeProfitExecution ? <label className="systematic-lab-field"><span>{text.takeProfitExecution}</span><TerminalSelect ariaLabel={text.takeProfitExecution} value={draft.takeProfitOrderType} options={[{ value: "market", label: text.marketProtection }, { value: "limit", label: text.limitProtection }, { value: "postFillLimit", label: text.postFillLimitProtection }]} disabled={!profileEditable} onChange={(value) => updateDraft({ takeProfitOrderType: value === "postFillLimit" ? "postFillLimit" : value === "limit" ? "limit" : "market" })} /></label> : null}
            {showStopLossExecution ? <label className="systematic-lab-field"><span>{text.stopLossExecution}</span><TerminalSelect ariaLabel={text.stopLossExecution} value={draft.stopLossOrderType} options={[{ value: "market", label: text.marketProtection }, { value: "limit", label: text.limitProtection }]} disabled={!profileEditable} onChange={(value) => updateDraft({ stopLossOrderType: value === "limit" ? "limit" : "market" })} /></label> : null}
            <NumericField label={text.dailyLossLimit} value={draft.dailyLoss} onChange={(dailyLoss) => updateDraft({ dailyLoss })} suffix="USDT" disabled={!profileEditable} />
            <NumericField label={text.cooldown} value={draft.cooldown} onChange={(cooldown) => updateDraft({ cooldown })} suffix="s" disabled={!profileEditable} />
            <fieldset className="systematic-lab-profile-editor__directions"><legend>{text.directions}</legend><label><input type="checkbox" checked={draft.allowLong} disabled={!profileEditable} onChange={(event) => updateDraft({ allowLong: event.target.checked })} />{text.allowLong}</label><label><input type="checkbox" checked={draft.allowShort} disabled={!profileEditable} onChange={(event) => updateDraft({ allowShort: event.target.checked })} />{text.allowShort}</label></fieldset>
            <label className="systematic-lab-profile-editor__notification"><input type="checkbox" checked={draft.notifyOnSignal} disabled={!profileEditable} onChange={(event) => updateDraft({ notifyOnSignal: event.target.checked })} /><span><strong>{text.profileSignalNotify}</strong><small>{text.profileSignalNotifyDetail}</small></span></label>
          </div>
          {protectionCapabilities?.dynamic ? <small className="systematic-lab__status is-guarded"><AlertTriangle size={12} />{text.dynamicProtectionHint}</small> : null}
          {loadingProtectionCapabilities ? <small className="systematic-lab__status is-muted"><LoaderCircle size={12} className="is-spinning" />{text.protectionInspectionPending}</small> : null}
          {strategyVersionDetail && !protectionCapabilities?.unknown && !showTakeProfitExecution && !showStopLossExecution ? <small className="systematic-lab__status is-muted">{text.noProtectionDeclared}</small> : null}
          {selectedProfile?.aiConflict ? <small className="systematic-lab__error-notice"><AlertTriangle size={12} />{text.aiProfileConflict}</small> : null}
          {selectedProfile?.lastError ? <small className="systematic-lab__error-notice"><AlertTriangle size={12} />{profileSignalErrorMessage(selectedProfile.lastError, text)}</small> : null}
        </section> : <EmptyState icon={<Bot size={22} />} title={text.noProfiles} detail={text.noProfilesDetail} />}
        {confirmation ? <SystematicConfirmDialog
          title={confirmation === "delete" ? text.deleteProfile : confirmation === "live-enable" || confirmation === "live-enable-force" ? text.liveProfileConfirmTitle : text.profileGuard}
          detail={confirmation === "delete" ? text.deleteProfileConfirm.replace("{name}", selectedProfile?.name ?? "") : confirmation === "live-enable" || confirmation === "live-enable-force" ? text.liveProfileConfirmDetail.replace("{name}", selectedProfile?.name ?? "") : text.forceAiConflict}
          cancelText={text.cancel}
          confirmText={confirmation === "delete" ? text.confirmDelete : confirmation === "live-enable" || confirmation === "live-enable-force" ? text.enableLiveProfile : text.armed}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            setConfirmation(null);
            if (confirmation === "delete") void remove();
            else if (confirmation === "live-enable" || confirmation === "live-enable-force") void toggle(confirmation === "live-enable-force", true);
            else void toggle(true);
          }}
        /> : null}
      </main>
    </div>
  );
}

function ProfileSignalsView({ text, profiles, desktop, refresh, chinese, onOpenProfile }: Readonly<{
  text: Copy;
  profiles: SystematicOverview["profiles"];
  desktop: boolean;
  refresh: () => Promise<void>;
  chinese: boolean;
  onOpenProfile: (profileId: string) => void;
}>) {
  const [profileId, setProfileId] = useState("");
  const [signalPage, setSignalPage] = useState<SystematicProfileSignalsPageView>(EMPTY_PROFILE_SIGNAL_PAGE);
  const [loading, setLoading] = useState(false);
  const profileOptions = useMemo(() => [
    { value: "", label: text.allProfiles },
    ...profiles.map((profile) => ({ value: profile.id, label: `${profile.name} · ${profile.instId}` })),
  ], [profiles, text.allProfiles]);
  const refreshSignals = useCallback(async (page = 1) => {
    if (!desktop) {
      setSignalPage(EMPTY_PROFILE_SIGNAL_PAGE);
      return;
    }
    setLoading(true);
    try {
      setSignalPage((await loadSystematicProfileSignals(profileId || undefined, page)) ?? EMPTY_PROFILE_SIGNAL_PAGE);
    } catch {
      setSignalPage(EMPTY_PROFILE_SIGNAL_PAGE);
    } finally {
      setLoading(false);
    }
  }, [desktop, profileId]);

  useEffect(() => {
    if (profileId && !profiles.some((profile) => profile.id === profileId)) setProfileId("");
  }, [profileId, profiles]);
  useEffect(() => {
    void refreshSignals();
  }, [refreshSignals]);
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    void listenSystematicEvents((event) => {
      if (!active || event.type !== "profileSignal" || (profileId && event.profileId !== profileId)) return;
      void refresh();
      void refreshSignals(signalPage.page);
    }).then((next) => {
      if (!active) next?.();
      else unlisten = next;
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [profileId, refresh, refreshSignals, signalPage.page]);

  return <section className="systematic-lab-profile-signals-view">
    <header className="systematic-lab-profile-signals-view__head">
      <div>
        <span className="systematic-lab__eyebrow">PROFILES</span>
        <h2>{text.profileSignals}</h2>
      </div>
      <label className="systematic-lab-field systematic-lab-profile-signals-view__filter">
        <span>{text.profileFilter}</span>
        <TerminalSelect ariaLabel={text.profileFilter} value={profileId} options={profileOptions} onChange={setProfileId} />
      </label>
    </header>
    <ProfileSignalHistory text={text} page={signalPage} loading={loading} chinese={chinese} onPageChange={(page) => void refreshSignals(page)} onOpenProfile={onOpenProfile} />
  </section>;
}

function RuntimeState({ runtime, preparing, text }: Readonly<{
  runtime?: SystematicPythonRuntimeView | null;
  preparing: boolean;
  text: Copy;
}>) {
  if (runtime?.available) {
    return null;
  }
  if (preparing || runtime?.state === "setupRequired") {
    return <span className="systematic-lab__status is-muted"><LoaderCircle size={12} className="is-spinning" />{text.runtimePreparing}</span>;
  }
  return <span className="systematic-lab__status is-guarded"><AlertTriangle size={12} />{runtime?.state === "missingPython" ? text.runtimeMissingPython : text.runtimeGuarded}</span>;
}

function PythonEnvironmentNotice({ runtime, preparing, text, onRetry }: Readonly<{
  runtime?: SystematicPythonRuntimeView | null;
  preparing: boolean;
  text: Copy;
  onRetry: () => void;
}>) {
  const missingPython = runtime?.state === "missingPython";
  const preparingEnvironment = preparing || runtime?.state === "setupRequired";
  const detail = preparingEnvironment
    ? text.runtimePreparingDetail
    : missingPython
      ? text.runtimeMissingPythonDetail
      : runtime?.reason || text.runtimeUnavailableDetail;
  return (
    <div className="systematic-lab__guard-notice" role="status">
      {preparingEnvironment ? <LoaderCircle size={15} className="is-spinning" /> : <AlertTriangle size={15} />}
      <span>{detail}</span>
      {!preparingEnvironment ? (
        <button className="systematic-lab__command-button" type="button" onClick={onRetry}>
          <RefreshCw size={13} />
          {text.retryPython}
        </button>
      ) : null}
    </div>
  );
}

function RunStatus({ run, text }: Readonly<{ run: SystematicBacktestView; text: Copy }>) {
  const label = run.status === "completed" ? text.completed : run.status === "running" ? text.running : run.status === "queued" ? text.queued : run.status === "cancelled" ? text.cancelled : text.failed;
  return <span className={clsx("systematic-lab__status", run.status === "completed" ? "is-ready" : run.status === "failed" ? "is-failed" : "is-muted")}><span className={clsx("systematic-lab-run-row__state", `is-${run.status}`)} />{label}</span>;
}

function TabButton({ active, icon, label, count, onClick }: Readonly<{ active: boolean; icon: ReactNode; label: string; count?: number; onClick: () => void }>) {
  return <button type="button" className={active ? "is-active" : ""} onClick={onClick}>{icon}<span>{label}</span>{count !== undefined ? <small>{count}</small> : null}</button>;
}

function EmptyState({ icon, title, detail }: Readonly<{ icon: ReactNode; title: string; detail: string }>) {
  return <div className="systematic-lab-empty-state"><span>{icon}</span><strong>{title}</strong><p>{detail}</p></div>;
}

function SystematicConfirmDialog({ title, detail, cancelText, confirmText, onCancel, onConfirm }: Readonly<{
  title: string;
  detail: string;
  cancelText: string;
  confirmText: string;
  onCancel: () => void;
  onConfirm: () => void;
}>) {
  return (
    <div className="systematic-lab-confirm" role="presentation" onMouseDown={onCancel}>
      <section className="systematic-lab-confirm__dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <AlertTriangle size={18} />
        <div><strong>{title}</strong><p>{detail}</p></div>
        <footer><button className="systematic-lab__command-button" type="button" onClick={onCancel}>{cancelText}</button><button className="systematic-lab__command-button is-danger" type="button" onClick={onConfirm}>{confirmText}</button></footer>
      </section>
    </div>
  );
}

function ContractRow({ label, value, tone }: Readonly<{
  label: string;
  value: string;
  tone?: "gain" | "loss";
}>) {
  return <div className="systematic-lab-contract-row"><span>{label}</span><strong className={tone ? `systematic-lab-pnl--${tone}` : undefined}>{value}</strong></div>;
}

function PolicyRow({ label, value }: Readonly<{ label: string; value: string }>) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function MetricField({ label, value, readOnly = false }: Readonly<{ label: string; value: string; readOnly?: boolean }>) {
  return <label className="systematic-lab-field"><span>{label}</span><input value={value} readOnly={readOnly} /></label>;
}

function ProfileInstrumentSelect({ value, options, disabled, text, onChange }: Readonly<{
  value: string;
  options: string[];
  disabled: boolean;
  text: Copy;
  onChange: (value: string) => void;
}>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const filtered = useMemo(() => {
    const normalized = query.trim().toUpperCase();
    return options.filter((option) => !normalized || option.includes(normalized));
  }, [options, query]);

  const updateMenuPosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const viewportGap = 8;
    const menuGap = 4;
    const maxHeight = Math.min(228, Math.max(76, window.innerHeight - rect.bottom - menuGap - viewportGap));
    const width = Math.min(rect.width, window.innerWidth - viewportGap * 2);
    const left = Math.min(Math.max(viewportGap, rect.left), window.innerWidth - width - viewportGap);
    setMenuPosition({ top: rect.bottom + menuGap, left, width, maxHeight });
  }, []);

  const openMenu = useCallback(() => {
    if (disabled || options.length === 0) return;
    updateMenuPosition();
    setOpen(true);
  }, [disabled, options.length, updateMenuPosition]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open, updateMenuPosition]);

  const select = (instId: string) => {
    onChange(instId);
    setQuery("");
    setOpen(false);
    setMenuPosition(null);
  };
  return (
    <div className="systematic-lab-profile-instrument" ref={rootRef}>
      <button ref={triggerRef} type="button" className="systematic-lab-profile-instrument__trigger" disabled={disabled || options.length === 0} aria-haspopup="listbox" aria-expanded={open} onClick={() => {
        if (open) {
          setOpen(false);
          setMenuPosition(null);
        } else openMenu();
      }}>
        <SymbolIcon base={symbolBase(value)} />
        <span>{value || "--"}</span>
        <ChevronDown size={13} />
      </button>
      {open && menuPosition && typeof document !== "undefined" ? createPortal(
        <div ref={menuRef} className="systematic-lab-profile-instrument__menu" role="listbox" aria-label={text.contract} style={menuPosition} onPointerDown={(event) => event.stopPropagation()}>
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            setOpen(false);
            setMenuPosition(null);
            triggerRef.current?.focus();
          }} placeholder={text.searchContract} />
          <div>
            {filtered.map((instId) => <button key={instId} type="button" role="option" aria-selected={instId === value} className={clsx(instId === value && "is-selected")} onClick={() => select(instId)}><SymbolIcon base={symbolBase(instId)} /><span>{instId}</span></button>)}
            {filtered.length === 0 ? <small>{text.noMatchingContract}</small> : null}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function ProfileSignalHistory({ text, page, loading, chinese, onPageChange, onOpenProfile }: Readonly<{
  text: Copy;
  page: SystematicProfileSignalsPageView;
  loading: boolean;
  chinese: boolean;
  onPageChange: (page: number) => void;
  onOpenProfile: (profileId: string) => void;
}>) {
  return <section className="systematic-lab-profile-signals" aria-busy={loading}>
    <header>
      <small>{loading ? text.loadingResult : text.profileSignalHistoryHint}</small>
      {page.cooldownBlockedCount > 0 ? <small>{formatCooldownBlockedSummary(page.cooldownBlockedCount, chinese)}</small> : null}
    </header>
    {page.items.length === 0 && !loading ? <p>{text.noProfileSignals}</p> : null}
    <div>
      {page.items.map((signal) => (
        <article key={signal.id} className={clsx("systematic-lab-profile-signal", signal.status === "submitted" ? "is-submitted" : signal.status === "error" ? "is-error" : "is-blocked")}>
          <span className="systematic-lab-run-row__state" />
          <div>
            <strong>{profileActionLabel(signal.actionKind, text)}{signal.contracts ? ` · ${formatLocalizedNumber(signal.contracts)} ${text.contracts}` : ""}</strong>
            <small className="systematic-lab-profile-signal__profile">
              {signal.instId ? <SymbolIcon base={symbolBase(signal.instId)} /> : null}
              <button type="button" title={text.openProfile} aria-label={`${text.openProfile}: ${signal.profileName}`} onClick={() => onOpenProfile(signal.profileId)}>{signal.profileName}</button>
              {signal.instId ? <span>· {signal.instId}</span> : null}
            </small>
            <small>{formatLocalizedDate(signal.cutoffAt, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })} · {signal.reason || "--"}</small>
            {signal.error ? <em title={signal.error}>{profileSignalErrorMessage(signal.error, text)}</em> : null}
          </div>
          <span>{signal.status === "submitted" ? text.submitted : signal.status === "error" ? text.profileExecutionError : text.blocked}</span>
        </article>
      ))}
    </div>
    {page.total > 0 ? <footer>
      <small>{text.signalPage.replace("{page}", String(page.page)).replace("{total}", String(page.totalPages))}</small>
      <span>
        <button className="systematic-lab__icon-button" type="button" disabled={loading || page.page <= 1} title={text.previousPage} aria-label={text.previousPage} onClick={() => onPageChange(page.page - 1)}><ChevronLeft size={14} /></button>
        <button className="systematic-lab__icon-button" type="button" disabled={loading || page.page >= page.totalPages} title={text.nextPage} aria-label={text.nextPage} onClick={() => onPageChange(page.page + 1)}><ChevronRight size={14} /></button>
      </span>
    </footer> : null}
  </section>;
}

function formatCooldownBlockedSummary(count: number, chinese: boolean) {
  const formattedCount = formatLocalizedNumber(count);
  return chinese ? `冷却期间拦截 ${formattedCount} 次` : `Cooldown blocked ${formattedCount} entries`;
}

function profileActionLabel(kind: string, text: Copy) {
  const labels: Record<string, string> = {
    no_action: text.profileExecutionError,
    open_long: text.openLong,
    open_short: text.openShort,
    close_long: text.closeLong,
    close_short: text.closeShort,
    set_protection: text.setProtection,
    cancel_protection: text.cancelProtection,
    cancel_order: text.cancelOrder,
  };
  return labels[kind] ?? kind;
}

type ProfilePositionEstimateValue = {
  contractNotionalUsdt: number;
  leverage: number;
  perEntryBudget: number;
  sameSideTotalBudget: number;
  mode: "fixedUsdt" | "equityPercent";
  estimatedContracts?: number;
};

function profilePositionEstimate(
  draft: ProfileDraft | null,
  instrument: OkxInstrumentSummary | null,
  tickerLast?: string | null,
): ProfilePositionEstimateValue | null {
  const contractValue = Number(instrument?.ctVal);
  const latestPrice = Number(tickerLast);
  const perEntryBudget = Number(draft?.perEntryBudget);
  const sameSideTotalBudget = Number(draft?.sameSideTotalBudget);
  const leverage = Number(draft?.leverage);
  if (![contractValue, latestPrice, perEntryBudget, sameSideTotalBudget, leverage].every((value) => Number.isFinite(value) && value > 0)) {
    return null;
  }
  const contractNotionalUsdt = contractValue * latestPrice;
  if (!Number.isFinite(contractNotionalUsdt)) return null;
  const mode = draft?.positionSizingMode === "fixedUsdt" ? "fixedUsdt" : "equityPercent";
  const estimatedContracts = mode === "fixedUsdt"
    ? Math.floor(perEntryBudget * leverage / contractNotionalUsdt)
    : undefined;
  return { contractNotionalUsdt, leverage, perEntryBudget, sameSideTotalBudget, mode, estimatedContracts };
}

function formatUsdtEstimate(value: number) {
  const maximumFractionDigits = value >= 100 ? 2 : value >= 1 ? 4 : value >= 0.01 ? 6 : 8;
  return `${formatLocalizedNumber(value, { maximumFractionDigits })} USDT`;
}

function ProfilePositionEstimateHint({ estimate, text }: Readonly<{ estimate: ProfilePositionEstimateValue | null; text: Copy }>) {
  if (!estimate) return <small className="systematic-lab-field__hint">{text.positionSizingEstimateUnavailable}</small>;
  return (
    <small className="systematic-lab-field__hint">
      <span>{text.oneContractEstimate} <strong>{formatUsdtEstimate(estimate.contractNotionalUsdt)}</strong></span>
      {estimate.mode === "fixedUsdt" && estimate.estimatedContracts !== undefined ? <span>{text.positionSizingEstimate} <strong>{formatLocalizedNumber(estimate.estimatedContracts)} {text.contracts} / {formatLocalizedNumber(estimate.leverage)}x</strong></span> : <span>{text.positionSizingPercentEstimate}</span>}
    </small>
  );
}

function NumericField({ label, value, onChange, suffix, hint, wide = false, disabled = false }: Readonly<{ label: string; value: string; onChange: (value: string) => void; suffix: string; hint?: ReactNode; wide?: boolean; disabled?: boolean }>) {
  return <label className={clsx("systematic-lab-field", wide && "wide")}><span>{label}</span><div><input type="number" step="any" inputMode="decimal" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} /><small>{suffix}</small></div>{hint}</label>;
}

function PreloadScope({ text, startAt, preloadBars }: Readonly<{ text: Copy; startAt: string; preloadBars: string }>) {
  const count = integerInput(preloadBars);
  const evaluationStart = dateTimeInput(startAt);
  const preloadStart = count && evaluationStart !== null
    ? evaluationStart - count * 60_000
    : null;
  const range = preloadStart !== null && evaluationStart !== null
    ? `${formatLocalizedDate(preloadStart, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })} - ${formatLocalizedDate(evaluationStart, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}`
    : count
      ? `${formatLocalizedNumber(count)} x 1m ${text.preloadBeforeStart}`
      : "--";
  return (
    <div className="systematic-lab-preload-scope">
      <History size={14} aria-hidden="true" />
      <div><span>{text.preloadScope}</span><strong>{range}</strong></div>
      <small>{text.preloadExcluded}</small>
    </div>
  );
}

function Metric({ label, value, tone }: Readonly<{ label: string; value: string; tone?: "positive" | "negative" }>) {
  return <div className={clsx("systematic-lab-metric", tone && `is-${tone}`)}><span>{label}</span><strong>{value}</strong></div>;
}

function pythonDefinition(strategy: SystematicStrategyView): SystematicPythonStrategyDefinition | null {
  return pythonDefinitionFromRecord(strategy.definition);
}

function pythonDefinitionFromRecord(source: Record<string, unknown>): SystematicPythonStrategyDefinition | null {
  if (!isRecord(source) || typeof source.source !== "string") return null;
  return {
    schemaVersion: typeof source.schemaVersion === "string" ? source.schemaVersion : "desic.systematic.strategy/v1",
    protocol: typeof source.protocol === "string" ? source.protocol : "desic.systematic.python/v1",
    entrypoint: typeof source.entrypoint === "string" ? source.entrypoint : "on_bar",
    source: source.source,
    parameters: isRecord(source.parameters) ? source.parameters : {},
    parameterTuning: isParameterTuningRecord(source.parameterTuning) ? source.parameterTuning : {}
  };
}

function pythonDraftFromVersion(version: SystematicStrategyVersionDetail, strategyId: string): PythonDraft {
  const definition = pythonDefinitionFromRecord(version.definition);
  return {
    id: strategyId,
    name: version.name,
    description: version.description,
    source: definition?.source ?? "",
    parameters: JSON.stringify(definition?.parameters ?? {}, null, 2),
    parameterTuning: JSON.stringify(definition?.parameterTuning ?? defaultParameterTuning(definition?.parameters ?? {}), null, 2),
  };
}

function versionComparisonSource(version: SystematicStrategyVersionDetail, label: string): StrategyComparisonSource {
  const definition = pythonDefinitionFromRecord(version.definition);
  return {
    label,
    source: definition?.source ?? "",
    parameters: JSON.stringify(definition?.parameters ?? {}, null, 2),
    parameterTuning: JSON.stringify(definition?.parameterTuning ?? {}, null, 2),
  };
}

function draftComparisonSource(draft: PythonDraft, label: string): StrategyComparisonSource {
  return {
    label,
    source: draft.source,
    parameters: normalizeJsonForComparison(draft.parameters),
    parameterTuning: normalizeJsonForComparison(draft.parameterTuning),
  };
}

function normalizeJsonForComparison(raw: string) {
  try {
    return JSON.stringify(JSON.parse(raw || "{}"), null, 2);
  } catch {
    return raw;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isParameterTuningRecord(value: unknown): value is Record<string, SystematicPythonParameterTuning> {
  return isRecord(value) && Object.values(value).every((candidate) => {
    return isRecord(candidate)
      && [candidate.min, candidate.max, candidate.step].every((number) => typeof number === "number" && Number.isFinite(number));
  });
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseParameterTuning(value: string): Record<string, SystematicPythonParameterTuning> | null {
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    return isParameterTuningRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function defaultTuningForNumber(value: number): SystematicPythonParameterTuning {
  const step = Number.isInteger(value) ? 1 : Math.max(Math.abs(value) * 0.1, 0.01);
  return {
    min: value - step * 5,
    max: value + step * 5,
    step,
  };
}

function defaultParameterTuning(parameters: Record<string, unknown>): Record<string, SystematicPythonParameterTuning> {
  return Object.fromEntries(
    Object.entries(parameters)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
      .map(([name, value]) => [name, defaultTuningForNumber(value)]),
  );
}

function numberInput(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function integerInput(value: string) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function dateTimeInput(value: string) {
  const parsed = Date.parse(value);
  return value && Number.isFinite(parsed) ? parsed : null;
}

function toDateTimeLocal(value: number) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(value - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function parseExecution(input: { entrySlippage: string; exitSlippage: string; entryFee: string; exitFee: string }): SystematicExecutionAssumptions | null {
  const entrySlippageBps = Number(input.entrySlippage);
  const exitSlippageBps = Number(input.exitSlippage);
  const entryFeeRate = Number(input.entryFee) / 100;
  const exitFeeRate = Number(input.exitFee) / 100;
  if (![entrySlippageBps, exitSlippageBps, entryFeeRate, exitFeeRate].every(Number.isFinite)) return null;
  if (entrySlippageBps < 0 || exitSlippageBps < 0 || entryFeeRate < 0 || exitFeeRate < 0) return null;
  return { entrySlippageBps, exitSlippageBps, entryFeeRate, exitFeeRate };
}

function toCandle(bar: SystematicClosedBar): Candle {
  return {
    time: Math.floor(bar.openTimeMs / 1_000),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    confirm: true
  };
}

function replayFillAction(fill: SystematicBacktestFill): "open-long" | "open-short" | "close-long" | "close-short" {
  const reason = fill.reason.toLowerCase();
  const isOpening = reason === "targetincrease"
    || reason === "targetflipentry"
    || reason === "limitentry";
  const isBuy = fill.side.toLowerCase() === "buy";
  if (isOpening) return isBuy ? "open-long" : "open-short";
  return isBuy ? "close-short" : "close-long";
}

function indexReplayPointsByTime<T extends { timeMs: number }>(points: readonly T[]): Map<number, T> {
  const index = new Map<number, T>();
  for (const point of points) {
    if (Number.isFinite(point.timeMs)) index.set(point.timeMs, point);
  }
  return index;
}

function replaySnapshotAt(
  detail: SystematicBacktestDetail | null,
  replayIndex: number,
  replaySnapshotsByTime: ReadonlyMap<number, SystematicReplaySnapshot>,
  replayEquityByTime: ReadonlyMap<number, SystematicEquityPoint>,
): SystematicReplaySnapshot | null {
  const report = detail?.report;
  const bar = detail?.bars[replayIndex - 1];
  if (!report || !bar || replayIndex <= 0) return null;
  const snapshot = replaySnapshotsByTime.get(bar.closeTimeMs);
  if (snapshot) return snapshot;
  // Reports created before replay snapshots retain their equity curve. Expose
  // the historical balance and completed ledger prefix, but never invent a
  // past position that was not recorded by that older engine version.
  const equity = replayEquityByTime.get(bar.closeTimeMs);
  if (!equity) return null;
  return {
    timeMs: equity.timeMs,
    equityUsdt: equity.equityUsdt,
    cashUsdt: equity.realizedCashUsdt,
    unrealizedPnlUsdt: equity.unrealizedPnlUsdt,
    usedMarginUsdt: 0,
    availableMarginUsdt: equity.equityUsdt,
    fillCount: report.fills.filter((fill) => isVisibleAtLegacyReplayBoundary(fill, equity.timeMs)).length,
    closedTradeCount: report.closedTrades.filter((trade) => isVisibleAtLegacyReplayBoundary(trade, equity.timeMs, trade.exitReason)).length,
    fundingPaymentCount: 0,
    position: null,
  };
}

function isVisibleAtLegacyReplayBoundary(
  event: { timeMs?: number; exitTimeMs?: number },
  boundaryTimeMs: number,
  reason?: string,
) {
  const timeMs = event.timeMs ?? event.exitTimeMs;
  if (typeof timeMs !== "number" || !Number.isFinite(timeMs) || !Number.isFinite(boundaryTimeMs) || boundaryTimeMs <= 0) return false;
  if (timeMs < boundaryTimeMs) return true;
  // A snapshot is captured before the strategy evaluates the just-closed bar.
  // A normal order at the same timestamp therefore belongs to the *next* bar's
  // open. Protective exits and an explicit last-bar close are the exceptions.
  return timeMs === boundaryTimeMs && isEndOfBarExecution(reason);
}

function isEndOfBarExecution(reason?: string) {
  return reason === "protectiveStop"
    || reason === "protectiveTakeProfit"
    || reason === "marginExhaustion"
    || reason === "endOfRunClose"
    || reason === "protective_stop"
    || reason === "protective_take_profit"
    || reason === "margin_exhaustion"
    || reason === "end_of_run_close";
}

function formatUsdt(value?: number | null) {
  const formatted = formatLocalizedNumber(Math.abs(value ?? 0), { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  if (value === undefined || value === null) return "--";
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatted} USDT`;
}

function formatPrice(value?: number | null) {
  if (value === undefined || value === null || !Number.isFinite(value)) return "--";
  return formatLocalizedNumber(value, { maximumFractionDigits: 4 });
}

function formatRatio(value?: number | null) {
  if (value === undefined || value === null || !Number.isFinite(value)) return "--";
  return formatLocalizedNumber(value, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

function formatDuration(value?: number | null) {
  if (value === undefined || value === null || !Number.isFinite(value) || value < 0) return "--";
  const totalMinutes = Math.floor(value / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor(totalMinutes % (24 * 60) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatPercent(value?: number | null, signed = true) {
  if (value === undefined || value === null || !Number.isFinite(value)) return "--";
  return `${signed && value > 0 ? "+" : ""}${formatLocalizedNumber(value, { maximumFractionDigits: 2 })}%`;
}

function formatRunTime(value?: number | null) {
  if (!value) return "--";
  return formatLocalizedDate(value, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatFullDateTime(value?: number | null) {
  if (!value) return "--";
  return formatLocalizedDate(value, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatBacktestDays(barCount?: number | null) {
  if (barCount === undefined || barCount === null || !Number.isFinite(barCount) || barCount <= 0) return "--";
  const days = barCount / (24 * 60);
  return formatLocalizedNumber(days, { maximumFractionDigits: days < 10 ? 1 : 0 });
}

function formatBacktestDateRange(startAt?: number | null, endAt?: number | null) {
  const start = Number(startAt);
  const end = Number(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "--";
  const format = (value: number) => formatLocalizedDate(value, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${format(start)} - ${format(end)}`;
}

function normalizedStrategyName(value: string) {
  return value.trim().toLocaleLowerCase();
}

function hasStrategyNameConflict(strategies: readonly SystematicStrategyView[], name: string, currentId?: string) {
  const normalized = normalizedStrategyName(name);
  return normalized.length > 0 && strategies.some((strategy) => strategy.id !== currentId && normalizedStrategyName(strategy.name) === normalized);
}

function nextAvailableStrategyName(strategies: readonly SystematicStrategyView[], baseName: string) {
  const existing = new Set(strategies.map((strategy) => normalizedStrategyName(strategy.name)));
  if (!existing.has(normalizedStrategyName(baseName))) return baseName;
  for (let suffix = 2; suffix <= 9_999; suffix += 1) {
    const candidate = `${baseName} ${suffix}`;
    if (!existing.has(normalizedStrategyName(candidate))) return candidate;
  }
  return `${baseName} ${Date.now()}`;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function profileErrorMessage(error: unknown, text: Copy) {
  const message = messageOf(error);
  if (message.includes("requires a completed backtest for this exact strategy version and contract")) {
    return text.profileExactBacktestRequired;
  }
  return message;
}

function profileSignalErrorMessage(message: string, text: Copy) {
  const minimumMargin = message.match(/at least ([0-9]+(?:\.[0-9]+)?) USDT initial margin is required/);
  if (minimumMargin) {
    return text.positionSizingBudgetTooSmall.replace("{margin}", minimumMargin[1]);
  }
  if (message.includes("same-side position budget is already fully used")) {
    return text.positionSizingBudgetExhausted;
  }
  if (
    message.includes("Confirmed local 1m K-line history is incomplete")
    || message.includes("Profile market data unavailable")
    || message.includes("Profile market data changed before execution")
  ) {
    return text.profileMarketDataUnavailable;
  }
  return message;
}

function backtestErrorMessage(error: unknown, text: Copy) {
  const message = messageOf(error);
  if (message.includes("must be at least 60 minutes before the current time")) {
    return text.backtestEndDelay;
  }
  return message;
}

type Copy = ReturnType<typeof copy>;

function copy(chinese: boolean) {
  if (chinese) {
    return {
      title: "策略研究", workflow: "策略研究工作流", confirmedBars: "仅使用已确认 K 线", refresh: "刷新",
      strategy: "策略", backtest: "回测", review: "结果与回放", forward: "前向模拟", profiles: "Profiles", allProfiles: "全部 Profiles", profileFilter: "Profile", openProfile: "打开 Profile",
      python: "Python", myStrategies: "我的策略", newStrategy: "新建 Python 策略", searchStrategies: "搜索策略", noStrategyMatches: "未找到匹配的策略", searchContract: "搜索合约", noMatchingContract: "没有匹配的合约",
      noStrategies: "还没有策略", noStrategiesDetail: "新建策略后，在每根已收线 K 线上定义动作。",
      pythonStrategy: "PYTHON 策略", runtimeReady: "本地 Python 已就绪", runtimeGuarded: "Python 环境未就绪", runtimePreparing: "正在准备 Python", runtimePreparingDetail: "正在创建 Desic 本地 Python 环境并安装策略允许使用的依赖。完成后即可运行 Python 回测。", runtimeMissingPython: "未检测到 Python", runtimeMissingPythonDetail: "请安装 Python 3.10 至 3.13，并将 Python 加入系统 PATH。完成后点击“重新检测”。", retryPython: "重新检测",
      save: "保存版本", name: "名称", description: "说明", source: "策略源码", strategyParameters: "策略参数", parameters: "参数", parameterTuning: "参数调优范围", parameterTuningHint: "平台固定支持顶层数值参数；仅调整范围与步长", parameterTuningUnavailable: "策略参数数据无效。", noNumericParameters: "当前参数中没有可调优的顶层数值。", noVisualParameters: "没有可视化的标量参数。", parameter: "参数", parameterDefault: "当前值", tuningMin: "最小", tuningMax: "最大", tuningStep: "步长", bestBacktest: "最佳回测", backtestDays: "回测 {days} 天", openBestBacktest: "查看最佳回测", deleteStrategy: "删除策略", deleteStrategyConfirm: "删除策略“{name}”及其所有本地回测、报告和调优记录？此操作不可撤销。", strategyDeleted: "策略已删除", strategyDeleteFailed: "无法删除策略", deleteBacktest: "删除回测", deleteBacktestConfirm: "删除“{name}”的该回测记录和本地回放数据？此操作不可撤销。", backtestDeleted: "回测已删除", backtestDeleteFailed: "无法删除回测", strategyUnchanged: "策略没有变更", strategyUnchangedDetail: "名称、说明、源码、参数和调优范围均未变化，未创建新版本。",
      versionHistory: "版本历史", closeVersionHistory: "关闭版本历史", versionHistoryHint: "历史快照不可修改；载入后只会写入当前未保存草稿。", versionLabel: "版本 {version}", latestVersion: "最新", versionUsage: "回测 {backtests} · Profiles {profiles}", noVersions: "没有可用版本", noVersionsDetail: "保存策略后会在此保留不可变版本。", loading: "正在加载", setCompareBaseline: "设为对比基线", compareBaseline: "对比基线：{version}", compareVersions: "比较版本", compareDraft: "与当前草稿比较", currentDraft: "当前草稿", loadVersionToDraft: "载入到草稿", versionLoadedToDraft: "版本已载入草稿", versionLoadedToDraftDetail: "{version} 已载入编辑器，尚未保存，也不会覆盖历史版本。", backtestThisVersion: "回测此版本", selectVersion: "选择一个版本以审阅、比较或载入草稿。", versionBacktests: "回测", versionProfiles: "Profiles", versionHash: "源码哈希", noDescription: "没有说明", closeComparison: "关闭比较", compareSections: "比较内容", historicalVersion: "历史版本",
      aiAssistant: "AI 策略助手", closeAiAssistant: "关闭 AI 策略助手", aiSourceApplied: "AI 已写入源码", aiSourceAppliedDetail: "只写入当前未保存草稿；请审阅后手动保存版本。", aiSourceWriteCancelled: "你已手动编辑源码，已停止 AI 写入。", aiAssistantFailed: "AI 策略助手不可用", aiChatConnecting: "正在连接策略助手", aiSourceWriting: "正在写入编辑器", aiChatWorking: "正在处理", aiChatReady: "可继续对话", aiChatEmpty: "说明要修改、解释或审阅的策略逻辑。AI 会先读取当前编辑器内容；只有使用写入工具时才会修改当前未保存源码。", you: "你", ai: "AI", aiChatPlaceholder: "例如：解释当前入场条件，并将止损改为以 ATR 为基础", aiChatPrompt: "向 AI 策略助手提问", aiChatStop: "停止生成", aiChatSend: "发送",
      developmentDocumentation: "开发文档", closeDocumentation: "关闭开发文档", documentationTitle: "Python 策略开发", documentationIntro: "宿主提供当前时点的行情与虚拟账户；策略只返回高层动作，所有成交、费用和账本由回测引擎处理。",
      documentationLifecycle: "1 分钟收线后决策", documentationLifecycleDetail: "必须实现 on_bar(ctx)。on_start(ctx) 可用于初始化；需要成交记录时，在 on_bar 中读取 ctx.portfolio.recent_fills。当前回测只在已确认的 1m K 线收线后调用。",
      documentationMarket: "读取当前时点市场数据", documentationMarketDetail: "使用 ctx.market.bars(合约, 周期, lookback=...) 读取 1m 至 1D 的窗口。高周期最后一根可能仍在形成，使用 bar.confirmed 判断后再作为确认信号。",
      documentationPortfolio: "读取虚拟账户与参数", documentationPortfolioDetail: "ctx.portfolio 提供现金、权益、保证金、成交、已平仓交易与保护价。用 ctx.portfolio.position(合约, \"long\" 或 \"short\") 读取当前仓位；ctx.params 读取保存的策略参数。",
      documentationActions: "返回一个明确动作", documentationActionsDetail: "可返回 no_action、open_long、open_short、close_long、close_short、set_protection 或 cancel_protection。动作在下一根 1m K 线开盘按回测成交模型执行。",
      documentationBoundary: "受控研究边界", documentationBoundaryDetail: "策略不能访问网络、文件、系统时钟、数据库、凭据或交易所下单。仅允许固定的科学计算依赖；代码只用于本地历史研究与回测。",
      documentationExample: "最小示例",
      strategyContract: "策略运行规则", event: "事件", confirmedBarEvent: "每根已确认 1 分钟 K 线收线",
      marketData: "市场数据", currentTimeOnly: "1m 已确认；高周期末根可为当前未收线 K 线", accountState: "账户状态", virtualState: "虚拟账户、持仓、成交、保证金与保护价",
      actionOutput: "输出动作", actions: "开多、开空、平多、平空、修改/撤销保护或不交易", execution: "执行", hostOwned: "宿主负责下一根成交、虚拟保证金与账本",
      runtimeUnavailable: "Python 运行时不可用", runtimeUnavailableDetail: "本地 Python 环境尚未准备完成。",
      desktopOnly: "仅桌面端", desktopOnlyDetail: "策略本地数据库、回测任务和本地 Python 环境只在桌面应用内运行。",
      defaultStrategyName: "收线 Python 策略", strategyCreated: "Python 策略已创建", strategyCreatedDetail: "源码已作为本地版本保存；先检查输入和动作，再运行回测。",
      strategyCreateFailed: "无法创建策略", strategySaved: "策略版本已保存", strategySavedDetail: "回测将固定这个版本、数据快照和成交假设。", cancel: "取消", confirmDelete: "删除",
      strategySaveFailed: "无法保存策略", strategyNameInUse: "策略名称已存在", strategyNameInUseDetail: "请为策略使用一个不同的名称。", invalidParameters: "参数 JSON 无效", parametersObject: "参数必须是 JSON 对象。", parameterTuningObject: "参数调优范围必须是对象，且每项包含有限的 min、max 和 step。",
      noStrategy: "没有可回测策略", noStrategyDetail: "先创建或选择一个策略。", backtestUnavailable: "当前策略无法回测", backtestUnavailableDetail: "当前策略不符合回测合同。",
      virtualAccount: "虚拟账户", workers: "并发回测槽位", contract: "合约", initialEquity: "初始权益", leverage: "杠杆", marginSafetyMultiplier: "保证金安全系数", preloadHistory: "预加载历史", preloadScope: "预加载区间", preloadBeforeStart: "回测开始前", preloadExcluded: "不计入权益、回放或统计", start: "正式评估开始", end: "评估结束",
      entrySlippage: "开仓滑点", exitSlippage: "平仓滑点", entryFee: "开仓费率", exitFee: "平仓费率", endOfRun: "期末处理",
      markToMarket: "按最后收盘价盯市", forceClose: "按最后收盘价平仓", fillModel: "预加载数据只用于策略上下文；正式评估中，已收线决策在下一根开盘成交。",
      pythonBacktestGuard: "Python 回测需要本地环境准备完成。",
      runBacktest: "运行回测", queuing: "正在排队", backtestQueued: "回测已排队", backtestFailed: "无法启动回测", optimize: "参数调优", optimizeUnavailable: "无法开始调优", optimizationQueued: "参数调优已排队", optimizationFailed: "无法启动参数调优", optimization: "参数调优", optimizationResults: "调优结果", validationCalmar: "验证 Calmar", applyToDraft: "应用到草稿", optimizationNote: "参数只写入当前未保存草稿；请审阅并保存为新版本后再运行独立回测。", optimizationApplied: "调优参数已应用", optimizationAppliedDetail: "最佳参数已写入当前策略草稿，尚未保存。", invalidBacktest: "回测参数无效", invalidBacktestDetail: "请输入正数的本金、预加载长度和成交假设；杠杆为 1-50x，安全系数为 1-20x，时间范围必须有效。", backtestEndDelay: "评估结束时间必须至少早于当前时间 1 小时，以等待本地 K 线同步完成。",
      timeline: "时间线", replayContract: "虚拟账户回放", preloadHistoryDetail: "只加载正式评估开始前的已确认 1 分钟 K 线，不进入权益、回放或统计。", barCloses: "K 线收线", barClosesDetail: "正式评估中，策略只能读取当前及过去数据；高周期末根会明确标记是否已收线。",
      strategyReads: "策略读取状态", strategyReadsDetail: "读取多周期市场、虚拟持仓、成交、保证金与保护价。", nextOpen: "下一根开盘成交", nextOpenDetail: "开平仓及保护变更会在下一根开盘按滑点和费用记账。",
      ledgerUpdates: "账本更新", ledgerUpdatesDetail: "权益、成交、保证金、资金费用与保护性/保证金退出进入报告。",
      backtestRuns: "回测记录", noRuns: "还没有回测", noRunsDetail: "从回测页运行一次历史回放后，完整结果会保存在本机。",
      result: "结果", resultLoadFailed: "无法读取回测结果", loadingResult: "正在读取回放数据", loadingReplayPage: "正在加载回放区间", evaluationRange: "评估区间", netPnl: "净盈亏", finalEquity: "期末权益", cashBalance: "现金余额", accountEquity: "账户权益", unrealizedPnl: "未实现盈亏", usedMargin: "占用保证金", availableMargin: "可用保证金", maxDrawdown: "最大回撤", closedTrades: "已平仓交易", fees: "费用", equityCurve: "权益曲线",
      previousBar: "上一根 K 线", nextBar: "下一根 K 线", replay: "回放进度", replayActionLegend: "成交动作", limitFillEstimate: "限价：K 线保守估计", limitFillEstimateDetail: "限价单只依据后续 1 分钟 K 线的价格穿越与成交量参与上限模拟，不能代表历史订单簿队列成交。", resultUnavailable: "回放数据不可用", resultUnavailableDetail: "该回测没有可读取的本地快照。",
      replayAccount: "回放账户", tradeLedger: "成交账本", position: "仓位", positionHistory: "历史仓位", noTrades: "没有已平仓交易", noTradesDetail: "动作、成交和权益仍会保留在回测报告中。", noReplayTrades: "当前时点没有已平仓交易", noReplayTradesDetail: "继续回放以查看后续记账结果。", noReplayFills: "当前时点没有成交", noReplayFillsDetail: "继续回放以查看下一根开盘成交和保护性退出。", noPosition: "当前时点没有持仓", noPositionDetail: "仓位将在下一根开盘成交后显示。", contracts: "张", contractValue: "每张面值", notional: "名义价值", entryPrice: "开仓均价", exitPrice: "平仓均价", markPrice: "标记价格", funding: "资金费用", stopLoss: "止损", takeProfit: "止盈", holdingTime: "持有时长", fillPrice: "成交价", marginChange: "保证金变动", entryNotional: "开仓名义价值", exitNotional: "平仓名义价值", fee: "手续费", buy: "买入", sell: "卖出", long: "多", short: "空",
      statistics: "策略统计", fullBacktest: "完整回测", totalReturn: "总收益", winRate: "胜率", sharpe: "夏普 (1m 年化)", sortino: "索提诺 (1m 年化)", volatility: "波动率 (1m 年化)", profitFactor: "盈亏因子", expectancy: "单笔期望", averageHolding: "平均持有", exposure: "持仓暴露", largestWinLoss: "最大盈 / 亏", maxStreak: "最长连胜 / 连亏",
      completed: "已完成", running: "运行中", queued: "排队中", cancelled: "已取消", failed: "失败",
      forwardSimulation: "前向模拟", paused: "已暂停", monitoring: "监控中", input: "输入", noExchangeOrders: "策略源码不能直接访问交易所；已启用的 Profile 由桌面执行层提交已验证的动作。", liveProfiles: "策略 Profiles", profileGuard: "启用后仅在已确认的 1m K 线收线运行固定策略版本。策略只表达开仓、平仓和原因；桌面按 Profile 预算、合约规则、权益和杠杆换算实际张数。", profileDescription: "Profile 固定策略版本、账户、合约、保证金模式和风险预算。启用后复用当前行情流与私有账户快照，在策略产生动作时走终端现有的审计订单链路。", newProfile: "新建 Profile", saveProfile: "保存 Profile", profileSaved: "Profile 已保存", profileSaveFailed: "无法保存 Profile", profileStateFailed: "无法更新 Profile", profileExactBacktestRequired: "该 Profile 必须先完成所选策略版本与合约的回测。请在“回测”中选择相同策略版本和合约并完成一次回测后，再保存 Profile。", invalidProfile: "Profile 参数无效", invalidProfileDetail: "请选择策略、合约和账户，并填写有效的仓位预算与风险限制。", noProfiles: "还没有 Profile", noProfilesDetail: "先为已经完成该版本与合约回测的 Python 策略保存一个 Profile，再显式启用它。", armed: "已启用", stopped: "未启用", profileEnabled: "启用 Profile", profileDraftUnsaved: "存在未保存的 Profile 修改", profileDraftSaveFirst: "请先保存当前 Profile 修改，再启用或停用。", account: "账户", strategyVersion: "策略版本", marginMode: "保证金模式", crossMargin: "全仓", isolatedMargin: "逐仓", positionSizing: "仓位预算", equityPercent: "权益百分比", fixedUsdt: "固定 USDT 保证金", perEntryBudget: "单次开仓预算", sameSideTotalBudget: "同方向总预算", takeProfitExecution: "止盈执行", stopLossExecution: "止损执行", marketProtection: "触发后市价", limitProtection: "触发后限价", protectionInspectionPending: "正在检查策略版本中的止盈止损声明。", noProtectionDeclared: "该策略版本没有声明止盈或止损，Profile 不会自动提交保护单。", dynamicProtectionHint: "该版本使用动态保护表达式，无法静态确认具体保护侧；两侧选项会保留，运行时仍以策略返回为准。", oneContractEstimate: "1 张约等于", positionSizingEstimate: "按当前价估算单次最多", positionSizingPercentEstimate: "实际张数在执行时按账户权益、合约最小张数和步长向下换算。", positionSizingEstimateUnavailable: "等待当前合约规格和最新价后估算。", positionSizingBudgetTooSmall: "单次开仓预算低于该合约最小下单保证金，至少需要 {margin} USDT 初始保证金。", positionSizingBudgetExhausted: "同方向仓位预算已用尽，本次开仓被拦截。", dailyLossLimit: "每日已实现亏损上限", cooldown: "开仓冷却", directions: "方向权限", allowLong: "允许做多", allowShort: "允许做空", profileSignalNotify: "交易信号通知", profileSignalNotifyDetail: "策略有交易动作或被风控拦截时，按已配置的飞书通知规则发送。", profileSignals: "信号记录", profileSignalHistoryHint: "审计历史：历史异常会保留；请结合 Profile 当前状态判断是否已恢复。", noProfileSignals: "还没有交易信号或运行异常记录。", signalPage: "第 {page} / {total} 页", previousPage: "上一页", nextPage: "下一页", submitted: "已提交", blocked: "已拦截", profileExecutionError: "运行异常", profileMarketDataUnavailable: "本地已确认的 1 分钟 K 线尚未准备完整，本轮策略未执行；Profile 会在后续收线自动重试。", openLong: "开多", openShort: "开空", closeLong: "平多", closeShort: "平空", setProtection: "修改保护", cancelProtection: "撤销保护", cancelOrder: "撤销委托", deleteProfile: "删除 Profile", deleteProfileConfirm: "删除 Profile “{name}”？", profileDeleteFailed: "无法删除 Profile", forceAiConflict: "同账户和环境有启用中的 AI 自动化。仍要强制启用策略 Profile 吗？", aiProfileConflict: "同一账户与环境存在启用中的 AI 自动化 Profile。", liveProfileConfirmTitle: "启用实盘策略 Profile", liveProfileConfirmDetail: "“{name}” 将在每根已确认 1 分钟 K 线收线后执行固定策略版本。策略返回开仓或平仓动作时，Desic Terminal 会以此 Profile 的账户、合约、保证金模式、杠杆和仓位预算提交真实订单。请确认你理解这不是回测或模拟。", enableLiveProfile: "确认启用实盘",
      postFillLimitProtection: "成交后挂限价",
      futureAutomation: "未来自动化边界", profileBoundary: "自动化 Profile 设计", profileScope: "唯一归属", profileScopeValue: "一个账户、环境和合约只能由一个自动 Profile 接管",
      handoff: "接管", handoffValue: "明确记录现有仓位与挂单，再让策略接管", shutdown: "应用退出", shutdownValue: "停止新动作；未来实现保留保护性订单处理", audit: "审计", auditValue: "版本、输入截点、动作、风控决定和成交始终关联",
      replayReady: "可回测并在图表回放"
    };
  }
  return {
    title: "Strategy Research", workflow: "Strategy research workflow", confirmedBars: "confirmed bars only", refresh: "Refresh",
    strategy: "Strategy", backtest: "Backtest", review: "Results & replay", forward: "Forward simulation", profiles: "Profiles", allProfiles: "All Profiles", profileFilter: "Profile", openProfile: "Open Profile",
    python: "Python", myStrategies: "My strategies", newStrategy: "New Python strategy", searchStrategies: "Search strategies", noStrategyMatches: "No matching strategy", searchContract: "Search contract", noMatchingContract: "No matching contract",
    noStrategies: "No strategy yet", noStrategiesDetail: "Create one to define an action on each confirmed bar.",
    pythonStrategy: "PYTHON STRATEGY", runtimeReady: "Local Python ready", runtimeGuarded: "Python environment pending", runtimePreparing: "Preparing Python", runtimePreparingDetail: "Creating the Desic local Python environment and installing the strategy allowlist dependencies. Python backtests enable when it finishes.", runtimeMissingPython: "Python not found", runtimeMissingPythonDetail: "Install Python 3.10 through 3.13, add it to your system PATH, then select Recheck.", retryPython: "Recheck",
    save: "Save version", name: "Name", description: "Description", source: "Strategy source", strategyParameters: "Strategy parameters", parameters: "Parameters", parameterTuning: "Parameter tuning ranges", parameterTuningHint: "The platform recognizes top-level numeric parameters; adjust only range and step", parameterTuningUnavailable: "Strategy parameters are invalid.", noNumericParameters: "This strategy has no top-level numeric parameters to tune.", noVisualParameters: "No scalar parameters can be edited visually.", parameter: "Parameter", parameterDefault: "Current", tuningMin: "Min", tuningMax: "Max", tuningStep: "Step", bestBacktest: "Best backtest", backtestDays: "{days}d backtest", openBestBacktest: "Open best backtest", deleteStrategy: "Delete strategy", deleteStrategyConfirm: "Delete strategy “{name}” with all of its local backtests, reports, and optimization records? This cannot be undone.", strategyDeleted: "Strategy deleted", strategyDeleteFailed: "Could not delete strategy", deleteBacktest: "Delete backtest", deleteBacktestConfirm: "Delete this backtest record and local replay data for “{name}”? This cannot be undone.", backtestDeleted: "Backtest deleted", backtestDeleteFailed: "Could not delete backtest", strategyUnchanged: "No strategy changes", strategyUnchangedDetail: "Name, description, source, parameters, and tuning ranges are unchanged, so no version was created.",
    versionHistory: "Version history", closeVersionHistory: "Close version history", versionHistoryHint: "Historical snapshots are immutable. Loading one writes only to the current unsaved draft.", versionLabel: "Version {version}", latestVersion: "Latest", versionUsage: "Backtests {backtests} · Profiles {profiles}", noVersions: "No saved version", noVersionsDetail: "Saved strategies keep immutable snapshots here.", loading: "Loading", setCompareBaseline: "Set comparison baseline", compareBaseline: "Baseline: {version}", compareVersions: "Compare versions", compareDraft: "Compare with draft", currentDraft: "Current draft", loadVersionToDraft: "Load into draft", versionLoadedToDraft: "Version loaded into draft", versionLoadedToDraftDetail: "{version} is now in the editor, unsaved, and did not replace historical snapshots.", backtestThisVersion: "Backtest this version", selectVersion: "Select a version to review, compare, or load into the draft.", versionBacktests: "Backtests", versionProfiles: "Profiles", versionHash: "Source hash", noDescription: "No description", closeComparison: "Close comparison", compareSections: "Comparison section", historicalVersion: "Historical version",
    aiAssistant: "AI strategy assistant", closeAiAssistant: "Close AI strategy assistant", aiSourceApplied: "AI source written", aiSourceAppliedDetail: "Only the current unsaved draft changed. Review it, then save a version manually.", aiSourceWriteCancelled: "You edited the source, so AI writing stopped.", aiAssistantFailed: "AI strategy assistant unavailable", aiChatConnecting: "Connecting strategy assistant", aiSourceWriting: "Writing into the editor", aiChatWorking: "Working", aiChatReady: "Ready for another message", aiChatEmpty: "Ask to change, explain, or review the strategy. AI reads the current editor first and can change only this unsaved source through its write tool.", you: "You", ai: "AI", aiChatPlaceholder: "For example: explain the current entry logic and use an ATR-based stop", aiChatPrompt: "Ask the AI strategy assistant", aiChatStop: "Stop generation", aiChatSend: "Send",
    developmentDocumentation: "Development guide", closeDocumentation: "Close development guide", documentationTitle: "Python strategy development", documentationIntro: "The host provides point-in-time market data and a virtual account. Your strategy returns high-level actions; the backtest engine owns fills, costs, and the ledger.",
    documentationLifecycle: "Decide after a one-minute close", documentationLifecycleDetail: "Implement on_bar(ctx). Use optional on_start(ctx) for initialization; read ctx.portfolio.recent_fills from on_bar when you need completed fills. The current backtest calls only after a confirmed 1m bar closes.",
    documentationMarket: "Read point-in-time market data", documentationMarketDetail: "Use ctx.market.bars(instrument, interval, lookback=...) for 1m through 1D windows. A final higher-timeframe bar can still be forming, so check bar.confirmed before treating it as a confirmed signal.",
    documentationPortfolio: "Read the virtual account and parameters", documentationPortfolioDetail: "ctx.portfolio exposes cash, equity, margin, fills, closed trades, and protection. Use ctx.portfolio.position(instrument, \"long\" or \"short\") for the active position and ctx.params for saved strategy parameters.",
    documentationActions: "Return one explicit action", documentationActionsDetail: "Return no_action, open_long, open_short, close_long, close_short, set_protection, or cancel_protection. The backtest applies the action at the following 1m open under its execution model.",
    documentationBoundary: "Controlled research boundary", documentationBoundaryDetail: "Strategy code cannot access the network, files, system clock, database, credentials, or exchange orders. Only pinned scientific dependencies are allowed, and code is for local historical research only.",
    documentationExample: "Minimal example",
    strategyContract: "Strategy runtime rules", event: "Event", confirmedBarEvent: "Every confirmed 1-minute bar close",
    marketData: "Market data", currentTimeOnly: "Confirmed 1m; the final higher-timeframe bar can still be active", accountState: "Account state", virtualState: "Virtual account, positions, fills, margin, and protection",
    actionOutput: "Action output", actions: "Open, close, set/cancel protection, or no action", execution: "Execution", hostOwned: "Host owns next-open fills, virtual margin, and ledger",
    runtimeUnavailable: "Python runtime unavailable", runtimeUnavailableDetail: "The local Python environment is not ready yet.",
    desktopOnly: "Desktop app only", desktopOnlyDetail: "Local strategy storage, backtest jobs, and the local Python environment run only in the desktop application.",
    defaultStrategyName: "Closed-bar Python strategy", strategyCreated: "Python strategy created", strategyCreatedDetail: "Source is saved locally as a version. Review its inputs and actions before backtesting.",
    strategyCreateFailed: "Could not create strategy", strategySaved: "Strategy version saved", strategySavedDetail: "A backtest pins this version, its data snapshot, and execution assumptions.", cancel: "Cancel", confirmDelete: "Delete",
    strategySaveFailed: "Could not save strategy", strategyNameInUse: "Strategy name already exists", strategyNameInUseDetail: "Choose a different name for this strategy.", invalidParameters: "Invalid parameters JSON", parametersObject: "Parameters must be a JSON object.", parameterTuningObject: "Parameter tuning must be an object whose entries contain finite min, max, and step values.",
    noStrategy: "No backtestable strategy", noStrategyDetail: "Create or select a strategy first.", backtestUnavailable: "Strategy cannot backtest", backtestUnavailableDetail: "This strategy does not meet the backtest contract.",
    virtualAccount: "VIRTUAL ACCOUNT", workers: "parallel backtest slots", contract: "Contract", initialEquity: "Initial equity", leverage: "Leverage", marginSafetyMultiplier: "Margin safety multiplier", preloadHistory: "Preloaded history", preloadScope: "Preload range", preloadBeforeStart: "before evaluation start", preloadExcluded: "Excluded from equity, replay, and statistics", start: "Evaluation start", end: "Evaluation end",
    entrySlippage: "Entry slippage", exitSlippage: "Exit slippage", entryFee: "Entry fee", exitFee: "Exit fee", endOfRun: "End-of-run treatment",
    markToMarket: "Mark to last close", forceClose: "Close at last close", fillModel: "Preloaded history supplies strategy context only; evaluation decisions fill at the following open.",
    pythonBacktestGuard: "Python backtests need the local environment to finish preparing.",
    runBacktest: "Run backtest", queuing: "Queuing", backtestQueued: "Backtest queued", backtestFailed: "Could not start backtest", optimize: "Optimize parameters", optimizeUnavailable: "Could not optimize", optimizationQueued: "Parameter optimization queued", optimizationFailed: "Could not start parameter optimization", optimization: "Parameter optimization", optimizationResults: "Optimization results", validationCalmar: "Validation Calmar", applyToDraft: "Apply to draft", optimizationNote: "Best parameters change only the current unsaved draft. Review, save a new version, then run an independent backtest.", optimizationApplied: "Optimization parameters applied", optimizationAppliedDetail: "Best parameters now exist in the current strategy draft and are not saved yet.", invalidBacktest: "Invalid backtest settings", invalidBacktestDetail: "Use positive capital, preload length, and execution assumptions; leverage is 1-50x, safety multiplier 1-20x, and time bounds must be valid.", backtestEndDelay: "The evaluation end must be at least one hour before the current time so local K-line synchronization can complete.",
    timeline: "TIMELINE", replayContract: "Virtual-account replay", preloadHistoryDetail: "Confirmed 1-minute history before evaluation start is context only, never equity, replay, or statistics.", barCloses: "Bar closes", barClosesDetail: "The host exposes only current and earlier data; the final higher-timeframe bar states whether it is confirmed.",
    strategyReads: "Strategy reads state", strategyReadsDetail: "Reads multi-timeframe market data, virtual positions, fills, margin, and protection.", nextOpen: "Next open fills", nextOpenDetail: "Open, close, and protection changes apply at the following open with costs recorded.",
    ledgerUpdates: "Ledger updates", ledgerUpdatesDetail: "Equity, fills, margin, funding, and protective or margin exits enter the report.",
    backtestRuns: "Backtest runs", noRuns: "No backtest yet", noRunsDetail: "Run a historical replay from Backtest; the complete result stays local.",
    result: "Result", resultLoadFailed: "Could not load result", loadingResult: "Loading replay data", loadingReplayPage: "Loading replay range", evaluationRange: "Evaluation range", netPnl: "Net PnL", finalEquity: "Final equity", cashBalance: "Cash balance", accountEquity: "Account equity", unrealizedPnl: "Unrealized PnL", usedMargin: "Used margin", availableMargin: "Available margin", maxDrawdown: "Max drawdown", closedTrades: "Closed trades", fees: "Fees", equityCurve: "Equity curve",
    previousBar: "Previous bar", nextBar: "Next bar", replay: "Replay progress", replayActionLegend: "Filled actions", limitFillEstimate: "Limit: conservative K-line estimate", limitFillEstimateDetail: "Limit fills use only later 1m price traversal and a volume-participation cap. They do not represent historical order-book queue fills.", resultUnavailable: "Replay data unavailable", resultUnavailableDetail: "This run has no readable local snapshot.",
    replayAccount: "Replay account", tradeLedger: "Fill ledger", position: "Position", positionHistory: "Position history", noTrades: "No closed trades", noTradesDetail: "Actions, fills, and equity remain in the full backtest report.", noReplayTrades: "No closed trade at this time", noReplayTradesDetail: "Continue the replay to view later ledger entries.", noReplayFills: "No fill at this time", noReplayFillsDetail: "Continue the replay to view next-open fills and protective exits.", noPosition: "No position at this time", noPositionDetail: "A position appears after its next-open fill.", contracts: "contracts", contractValue: "Contract value", notional: "Notional", entryPrice: "Average entry", exitPrice: "Exit price", markPrice: "Mark price", funding: "Funding", stopLoss: "Stop loss", takeProfit: "Take profit", holdingTime: "Holding time", fillPrice: "Fill price", marginChange: "Margin change", entryNotional: "Entry notional", exitNotional: "Exit notional", fee: "Fee", buy: "Buy", sell: "Sell", long: "Long", short: "Short",
    statistics: "Strategy statistics", fullBacktest: "Full backtest", totalReturn: "Total return", winRate: "Win rate", sharpe: "Sharpe (1m ann.)", sortino: "Sortino (1m ann.)", volatility: "Volatility (1m ann.)", profitFactor: "Profit factor", expectancy: "Expectancy", averageHolding: "Avg. holding", exposure: "Exposure", largestWinLoss: "Largest win / loss", maxStreak: "Max win / loss streak",
    completed: "Completed", running: "Running", queued: "Queued", cancelled: "Cancelled", failed: "Failed",
    forwardSimulation: "Forward simulation",
    paused: "Paused",
    monitoring: "Monitoring",
    input: "Input",
    noExchangeOrders: "Strategy source cannot access an exchange directly; an enabled Profile submits validated actions through the desktop execution layer.",
    liveProfiles: "Strategy Profiles",
    profileGuard: "When enabled, the pinned strategy version runs only after a confirmed 1m close. The strategy expresses an opening, close, and reason; the host converts the configured budget into legal contracts.",
    profileDescription: "A Profile pins a strategy version, account, contract, margin mode, and position budget. When enabled it reuses the existing market stream and private account snapshot, then sends actions through the terminal audited order flow.",
    newProfile: "New Profile",
    saveProfile: "Save Profile",
    profileSaved: "Profile saved",
    profileSaveFailed: "Could not save Profile",
    profileStateFailed: "Could not update Profile",
    profileExactBacktestRequired: "This Profile requires a completed backtest for the selected strategy version and contract. In Backtest, choose the same version and contract, complete a run, then save the Profile again.",
    invalidProfile: "Invalid Profile settings",
    invalidProfileDetail: "Choose a strategy, contract, and account, then enter valid position budgets and risk limits.",
    noProfiles: "No Profile yet",
    noProfilesDetail: "Save a Profile for a Python strategy that has completed an exact-version, exact-contract backtest, then explicitly enable it.",
    armed: "Enabled",
    stopped: "Not enabled",
    profileEnabled: "Enable Profile",
    profileDraftUnsaved: "Unsaved Profile changes",
    profileDraftSaveFirst: "Save the current Profile changes before enabling or stopping it.",
    account: "Account",
    strategyVersion: "Strategy version",
    marginMode: "Margin mode",
    crossMargin: "Cross",
    isolatedMargin: "Isolated",
    positionSizing: "Position sizing",
    equityPercent: "Equity percentage",
    fixedUsdt: "Fixed USDT margin",
    perEntryBudget: "Per-entry budget",
    sameSideTotalBudget: "Same-side total budget",
    takeProfitExecution: "Take-profit execution",
    stopLossExecution: "Stop-loss execution",
    marketProtection: "Market after trigger",
    limitProtection: "Limit after trigger",
    postFillLimitProtection: "Resting limit after entry fill",
    protectionInspectionPending: "Inspecting protection declarations in this strategy version.",
    noProtectionDeclared: "This strategy version declares no stop-loss or take-profit; the Profile will not create protection orders automatically.",
    dynamicProtectionHint: "This version uses a dynamic protection expression, so the exact side cannot be confirmed statically. Both options remain available; runtime strategy output still decides whether protection exists.",
    oneContractEstimate: "One contract is approximately",
    positionSizingEstimate: "Estimated per-entry maximum at current price",
    positionSizingPercentEstimate: "The host converts this to contracts at execution using current equity, the contract minimum, and its lot size.",
    positionSizingBudgetTooSmall: "The per-entry budget is below this contract's minimum order margin; at least {margin} USDT initial margin is required.",
    positionSizingBudgetExhausted: "The same-side position budget is fully used; this entry was blocked.",
    positionSizingEstimateUnavailable: "Waiting for current contract metadata and latest price to estimate.",
    dailyLossLimit: "Daily realized-loss limit",
    cooldown: "Entry cooldown",
    directions: "Direction permissions",
    allowLong: "Allow long",
    allowShort: "Allow short",
    profileSignalNotify: "Signal notifications",
    profileSignalNotifyDetail: "Send eligible Feishu notifications when the strategy produces a trade action or a risk control blocks one.",
    profileSignals: "Signal history",
    profileSignalHistoryHint: "Audit history. Earlier runtime errors remain after the Profile has recovered.",
    noProfileSignals: "No trade signal or runtime error has been recorded yet.",
    signalPage: "Page {page} / {total}",
    previousPage: "Previous page",
    nextPage: "Next page",
    submitted: "Submitted",
    blocked: "Blocked",
    profileExecutionError: "Runtime error",
    profileMarketDataUnavailable: "Confirmed local one-minute history was not ready, so this cycle did not execute. The Profile retries automatically on later closes.",
    openLong: "Open long",
    openShort: "Open short",
    closeLong: "Close long",
    closeShort: "Close short",
    setProtection: "Set protection",
    cancelProtection: "Cancel protection",
    cancelOrder: "Cancel order",
    deleteProfile: "Delete Profile",
    deleteProfileConfirm: "Delete Profile {name}?",
    profileDeleteFailed: "Could not delete Profile",
    forceAiConflict: "AI automation is enabled for this account and environment. Force-enable this strategy Profile?",
    aiProfileConflict: "An AI automation Profile is enabled for the same account and environment.",
    liveProfileConfirmTitle: "Enable live strategy Profile",
    liveProfileConfirmDetail: "{name} will run its pinned strategy version after each confirmed one-minute close. When the strategy returns an open or close action, Desic Terminal will submit a real order using this Profile account, contract, margin mode, and leverage. This is not a backtest or paper simulation.",
    enableLiveProfile: "Enable live Profile",
    futureAutomation: "FUTURE AUTOMATION BOUNDARY", profileBoundary: "Automation Profile design", profileScope: "Exclusive scope", profileScopeValue: "One automatic Profile owns one account, environment, and contract",
    handoff: "Takeover", handoffValue: "Existing positions and orders are recorded before strategy takeover", shutdown: "App exit", shutdownValue: "Stop new actions; a future adapter retains protective-order handling", audit: "Audit", auditValue: "Version, cutoff, action, risk decision, and fill remain linked",
    replayReady: "Backtest and chart replay ready"
  };
}
